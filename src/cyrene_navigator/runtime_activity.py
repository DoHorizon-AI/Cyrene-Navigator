"""Track Navigator Web Host proxy requests with the local maintenance broker.

Navigator Web Host 通过本地 maintenance broker 跟踪代理请求活动。
"""

from __future__ import annotations

import atexit
import os
from collections.abc import Callable, Iterable, Mapping
from contextlib import suppress
from importlib import import_module
from pathlib import Path
from threading import RLock
from typing import Protocol, TypeVar, cast
from uuid import uuid4

_TOKEN_FILE = "/run/secrets/cyrene-runtime-activity-token"
_SOCKET_PATH = "/run/cyrene/runtime-maintenance.sock"
_SOCKET_ENV = "CYRENE_RUNTIME_MAINTENANCE_SOCKET"
_PersistResult = TypeVar("_PersistResult")


class ActivitySourceLifecycleProtocol(Protocol):
    """Describe the lifecycle methods needed by the Web Host. | 定义 Web Host 所需生命周期。"""

    def start(
        self,
        load_active_tasks: Callable[[], Iterable[Mapping[str, str]]],
    ) -> None: ...

    def admit_and_persist(
        self,
        task_id: str,
        persist: Callable[[], _PersistResult],
        *,
        state: str = "ACCEPTED",
    ) -> _PersistResult: ...

    def transition_and_persist(
        self,
        task_id: str,
        state: str,
        persist: Callable[[], _PersistResult],
    ) -> _PersistResult: ...

    def complete_after_persist(
        self,
        task_id: str,
        persist: Callable[[], _PersistResult],
    ) -> _PersistResult: ...

    def close(self) -> None: ...


class RuntimeMaintenanceClientFactoryProtocol(Protocol):
    """Type the installed SDK client factory. | 描述已安装 SDK 客户端工厂。"""

    @staticmethod
    def from_source_secret(
        source_id: str,
        token_path: str,
        *,
        catalog_generation: int,
        socket_path: str,
    ) -> object: ...


class RuntimeMaintenanceSdkProtocol(Protocol):
    RuntimeMaintenanceClient: RuntimeMaintenanceClientFactoryProtocol
    ActivitySourceLifecycle: Callable[[object], ActivitySourceLifecycleProtocol]


class RuntimeActivityConfigurationError(RuntimeError):
    """Raised when managed activity configuration is invalid. | 托管活动配置无效时抛出。"""


class RuntimeActivityUnavailable(RuntimeError):
    """Raised when managed activity cannot admit a proxy request. | 活动源无法准入请求时抛出。"""


class RuntimeActivityTracker:
    """Track live proxy calls owned by one Navigator Web Host process.

    Calls remain active while a normal upstream request runs or an SSE response
    is consumed. They are intentionally process-local because the Python bundle
    owns no durable Product task records.

    跟踪 Navigator Web Host 进程拥有的在途代理调用。普通请求执行期间以及 SSE 消费期间均保持活动。
    """

    def __init__(self) -> None:
        self._lock = RLock()
        self._active: dict[str, str] = {}
        self._lifecycle: ActivitySourceLifecycleProtocol | None = None
        self._last_error_code: str | None = None

    def start(self) -> None:
        """Start tracking if the installer configured a trusted activity source."""

        lifecycle = start_activity_source("cyrene-navigator", self.list_active_tasks)
        with self._lock:
            self._lifecycle = lifecycle
            self._last_error_code = None

    def begin(self) -> str | None:
        """Admit one in-flight proxy call before contacting its upstream."""

        with self._lock:
            lifecycle = self._lifecycle
        if lifecycle is None:
            return None
        task_id = uuid4().hex
        admitted = False
        try:
            lifecycle.admit_and_persist(
                task_id,
                lambda: self._record(task_id),
                state="ACCEPTED",
            )
            admitted = True
            lifecycle.transition_and_persist(
                task_id,
                "INFLIGHT",
                lambda: self._record(task_id),
            )
        except Exception as error:
            code = getattr(error, "code", "ACTIVITY_SOURCE_UNAVAILABLE")
            if admitted:
                with suppress(Exception):
                    lifecycle.complete_after_persist(task_id, lambda: self._forget(task_id))
            with self._lock:
                self._last_error_code = str(code)
            raise RuntimeActivityUnavailable(
                "managed activity source rejected proxy work"
            ) from error
        with self._lock:
            self._last_error_code = None
        return task_id

    def finish(self, task_id: str | None) -> None:
        """Remove a completed or disconnected proxy call from the mirror."""

        if task_id is None:
            return
        with self._lock:
            lifecycle = self._lifecycle
        if lifecycle is None:
            return
        try:
            lifecycle.complete_after_persist(task_id, lambda: self._forget(task_id))
        except Exception as error:
            code = getattr(error, "code", "ACTIVITY_SOURCE_UNAVAILABLE")
            with self._lock:
                self._last_error_code = str(code)
        else:
            with self._lock:
                self._last_error_code = None

    def list_active_tasks(self) -> list[dict[str, str]]:
        """Return a stable snapshot for startup and periodic broker reconciliation."""

        with self._lock:
            return [
                {"task_id": task_id, "state": state}
                for task_id, state in sorted(self._active.items())
            ]

    def health(self) -> dict[str, str | bool]:
        """Return safe broker health without exposing credential or socket data."""

        with self._lock:
            lifecycle = self._lifecycle
            error_code = self._last_error_code
        lifecycle_error = getattr(lifecycle, "last_error", None)
        if error_code is None and lifecycle_error is not None:
            error_code = str(getattr(lifecycle_error, "code", "ACTIVITY_SOURCE_UNAVAILABLE"))
        if lifecycle is None:
            return {"configured": False, "status": "not_configured"}
        if error_code is not None:
            return {"configured": True, "status": "degraded", "errorCode": error_code}
        return {"configured": True, "status": "ready"}

    def close(self) -> None:
        """Stop the heartbeat during Web Host shutdown. | Web Host 关闭时停止心跳。"""

        with self._lock:
            lifecycle = self._lifecycle
        if lifecycle is not None:
            lifecycle.close()

    def _record(self, task_id: str) -> None:
        with self._lock:
            self._active[task_id] = "INFLIGHT"

    def _forget(self, task_id: str) -> None:
        with self._lock:
            self._active.pop(task_id, None)


def start_activity_source(
    expected_source_id: str,
    load_active_tasks: Callable[[], Iterable[Mapping[str, str]]],
) -> ActivitySourceLifecycleProtocol | None:
    """Start managed tracking only when installer broker settings are present.

    Unmanaged developer launches remain independent. Explicitly managed startup
    fails closed when credentials, identity, generation, SDK, or broker setup is
    invalid.

    中文:仅在安装器配置 broker 时启用；显式托管启动配置错误时拒绝启动。
    """

    token_path = os.environ.get("CYRENE_RUNTIME_ACTIVITY_SOURCE_TOKEN_FILE", _TOKEN_FILE)
    socket_path = os.environ.get(_SOCKET_ENV, _SOCKET_PATH)
    managed = (
        any(
            name in os.environ
            for name in (
                "CYRENE_RUNTIME_ACTIVITY_SOURCE_ID",
                "CYRENE_RUNTIME_ACTIVITY_SOURCE_TOKEN_FILE",
                "CYRENE_RUNTIME_ACTIVITY_CATALOG_GENERATION",
                _SOCKET_ENV,
            )
        )
        or Path(token_path).is_file()
        or Path(socket_path).exists()
    )
    if not managed:
        return None

    configured_source_id = os.environ.get("CYRENE_RUNTIME_ACTIVITY_SOURCE_ID", expected_source_id)
    if configured_source_id != expected_source_id:
        raise RuntimeActivityConfigurationError(
            f"activity source ID must be {expected_source_id!r}"
        )
    generation_text = os.environ.get("CYRENE_RUNTIME_ACTIVITY_CATALOG_GENERATION", "").strip()
    if not generation_text.isdecimal():
        raise RuntimeActivityConfigurationError(
            "CYRENE_RUNTIME_ACTIVITY_CATALOG_GENERATION must be a non-negative integer"
        )

    try:
        sdk = cast(RuntimeMaintenanceSdkProtocol, import_module("cyrene_runtime_maintenance"))
    except ImportError as error:
        raise RuntimeActivityConfigurationError(
            "managed activity requires the installed cyrene_runtime_maintenance SDK"
        ) from error

    client = sdk.RuntimeMaintenanceClient.from_source_secret(
        expected_source_id,
        token_path,
        catalog_generation=int(generation_text),
        socket_path=socket_path,
    )
    lifecycle = sdk.ActivitySourceLifecycle(client)
    lifecycle.start(load_active_tasks)
    atexit.register(lifecycle.close)
    return lifecycle
