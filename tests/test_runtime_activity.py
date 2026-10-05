"""Exercise Navigator Web Host activity-source admission and cleanup.

验证 Navigator Web Host 活动源的请求准入和清理。
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from cyrene_navigator.runtime_activity import (
    RuntimeActivityConfigurationError,
    start_activity_source,
)
from cyrene_navigator.web_host import create_web_host_app

PAIRING_CODE = "activity-pairing-code-123456"


class FakeLifecycle:
    """Record broker calls while preserving the SDK lifecycle contract."""

    def __init__(self, _client: object) -> None:
        self.calls: list[tuple[str, str | None, str | None]] = []
        self.tasks: list[dict[str, str]] = []
        self.last_error: Exception | None = None
        self.fail_admission = False

    def start(self, load_active_tasks: Any) -> None:
        self.calls.append(("start", None, None))
        self.tasks = list(load_active_tasks())

    def admit_and_persist(self, task_id: str, persist: Any, *, state: str) -> Any:
        self.calls.append(("admit", task_id, state))
        if self.fail_admission:
            error = RuntimeError("broker unavailable")
            error.code = "BROKER_UNAVAILABLE"  # type: ignore[attr-defined]
            raise error
        self.tasks.append({"task_id": task_id, "state": state})
        return persist()

    def transition_and_persist(self, task_id: str, state: str, persist: Any) -> Any:
        self.calls.append(("transition", task_id, state))
        for task in self.tasks:
            if task["task_id"] == task_id:
                task["state"] = state
        return persist()

    def complete_after_persist(self, task_id: str, persist: Any) -> Any:
        self.calls.append(("complete", task_id, None))
        result = persist()
        self.tasks = [task for task in self.tasks if task["task_id"] != task_id]
        return result

    def close(self) -> None:
        self.calls.append(("close", None, None))


def _managed_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    token_file = tmp_path / "source-token"
    token_file.write_text("test-token", encoding="utf-8")
    monkeypatch.setenv("CYRENE_RUNTIME_ACTIVITY_SOURCE_ID", "cyrene-navigator")
    monkeypatch.setenv("CYRENE_RUNTIME_ACTIVITY_SOURCE_TOKEN_FILE", str(token_file))
    monkeypatch.setenv("CYRENE_RUNTIME_ACTIVITY_CATALOG_GENERATION", "7")
    monkeypatch.setenv("CYRENE_RUNTIME_MAINTENANCE_SOCKET", str(tmp_path / "broker.sock"))


def _install_fake_sdk(monkeypatch: pytest.MonkeyPatch, lifecycle: FakeLifecycle) -> None:
    sdk = SimpleNamespace(
        RuntimeMaintenanceClient=SimpleNamespace(
            from_source_secret=lambda *_args, **_kwargs: object()
        ),
        ActivitySourceLifecycle=lambda client: lifecycle,
    )
    monkeypatch.setattr(
        "cyrene_navigator.runtime_activity.import_module",
        lambda _name: sdk,
    )


def test_activity_configuration_fails_closed_for_invalid_generation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    _managed_environment(monkeypatch, tmp_path)
    monkeypatch.setenv("CYRENE_RUNTIME_ACTIVITY_CATALOG_GENERATION", "invalid")

    with pytest.raises(RuntimeActivityConfigurationError, match="CATALOG_GENERATION"):
        start_activity_source("cyrene-navigator", lambda: [])


def test_web_host_proxy_admits_inflight_work_and_cleans_up(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    _managed_environment(monkeypatch, tmp_path)
    lifecycle = FakeLifecycle(object())
    _install_fake_sdk(monkeypatch, lifecycle)

    def upstream(request: httpx.Request) -> httpx.Response:
        assert request.url == "http://backend.test/models"
        assert lifecycle.tasks
        assert lifecycle.tasks[0]["state"] == "INFLIGHT"
        return httpx.Response(200, json={"models": []})

    client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    app = create_web_host_app(
        pairing_code=PAIRING_CODE,
        proxy_targets={"/api/v1/exchange": "http://backend.test"},
        http_client=client,
    )
    try:
        with TestClient(app) as web:
            login = web.post("/api/v1/auth/pair", json={"pairingCode": PAIRING_CODE})
            assert login.status_code == 200
            response = web.get("/api/v1/exchange/models")
            assert response.status_code == 200
            assert lifecycle.calls[0][0] == "start"
            assert [call[0] for call in lifecycle.calls] == [
                "start",
                "admit",
                "transition",
                "complete",
            ]
            assert lifecycle.tasks == []
            status = web.get("/api/v1/system/status").json()
            assert status["activitySource"] == {"configured": True, "status": "ready"}
        assert lifecycle.calls[-1][0] == "close"
    finally:
        import asyncio

        asyncio.run(client.aclose())


def test_web_host_rejects_proxy_when_managed_activity_admission_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    _managed_environment(monkeypatch, tmp_path)
    lifecycle = FakeLifecycle(object())
    lifecycle.fail_admission = True
    _install_fake_sdk(monkeypatch, lifecycle)
    upstream_calls = 0

    def upstream(_request: httpx.Request) -> httpx.Response:
        nonlocal upstream_calls
        upstream_calls += 1
        return httpx.Response(200)

    client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    app = create_web_host_app(
        pairing_code=PAIRING_CODE,
        proxy_targets={"/api/v1/exchange": "http://backend.test"},
        http_client=client,
    )
    try:
        with TestClient(app) as web:
            web.post("/api/v1/auth/pair", json={"pairingCode": PAIRING_CODE})
            response = web.get("/api/v1/exchange/models")
            assert response.status_code == 503
            assert response.json()["code"] == "NAVIGATOR_ACTIVITY_SOURCE_UNAVAILABLE"
            assert upstream_calls == 0
            status = web.get("/api/v1/system/status").json()
            assert status["status"] == "degraded"
            assert status["activitySource"]["errorCode"] == "BROKER_UNAVAILABLE"
        assert lifecycle.calls[-1][0] == "close"
    finally:
        import asyncio

        asyncio.run(client.aclose())


def test_web_host_keeps_sse_activity_until_stream_consumption_finishes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    _managed_environment(monkeypatch, tmp_path)
    lifecycle = FakeLifecycle(object())
    _install_fake_sdk(monkeypatch, lifecycle)

    class ObservedStream(httpx.AsyncByteStream):
        async def __aiter__(self) -> Any:
            assert lifecycle.tasks
            assert lifecycle.tasks[0]["state"] == "INFLIGHT"
            yield b"data: done\n\n"

    def upstream(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            stream=ObservedStream(),
            headers={"content-type": "text/event-stream"},
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    app = create_web_host_app(
        pairing_code=PAIRING_CODE,
        proxy_targets={"/api/v1/exchange": "http://backend.test"},
        http_client=client,
    )
    try:
        with TestClient(app) as web:
            web.post("/api/v1/auth/pair", json={"pairingCode": PAIRING_CODE})
            response = web.get(
                "/api/v1/exchange/events",
                headers={"Accept": "text/event-stream"},
            )
            assert response.status_code == 200
            assert response.text == "data: done\n\n"
            assert lifecycle.calls[-1][0] == "complete"
            assert lifecycle.tasks == []
        assert lifecycle.calls[-1][0] == "close"
    finally:
        import asyncio

        asyncio.run(client.aclose())
