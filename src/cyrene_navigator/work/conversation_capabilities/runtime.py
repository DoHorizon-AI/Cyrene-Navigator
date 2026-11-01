"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 runtime.py                                                           │
│  Module: cyrene_navigator.work.conversation_capabilities.runtime          │
│  Role: Pool local DirectPluginRuntime channels and check typed envelopes. │
│                                                                          │
│  模块职责：复用本机插件 channel，并校验每次 DirectPlugin 调用的类型。    │
│  · 错误消息会脱敏；保留稳定错误码、重试性和 deadline/cancel 分类。        │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import re
import threading
from collections.abc import Callable
from dataclasses import dataclass

from cyrene_plugin_runtime import (
    DirectPayload,
    DirectPluginClient,
    DirectPluginDeadlineExceeded,
    DirectPluginFailure,
    DirectPluginInvocationCancelled,
    DirectPluginProtocolError,
    DirectPluginTransportError,
)

_SAFE_DOMAIN_CODE = re.compile(r"[A-Z][A-Z0-9_]{0,95}\Z")


class DirectCapabilityError(RuntimeError):
    """A typed, redacted failure while invoking one configured capability."""

    def __init__(self, code: str, *, unavailable: bool = False, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.unavailable = unavailable
        self.retryable = retryable


class DirectPluginPool:
    """Share one local gRPC client per immutable connection reference."""

    def __init__(
        self,
        client_factory: Callable[
            [str], DirectPluginClient
        ] = DirectPluginClient.for_local_connection_ref,
    ) -> None:
        self._client_factory = client_factory
        self._clients: dict[str, DirectPluginClient] = {}
        self._lock = threading.Lock()

    def client(self, connection_ref: str) -> DirectPluginClient:
        """Return a cached loopback/Unix client for a server-owned endpoint."""

        with self._lock:
            client = self._clients.get(connection_ref)
            if client is None:
                client = self._client_factory(connection_ref)
                self._clients[connection_ref] = client
            return client

    def close(self) -> None:
        """Close every owned gRPC channel exactly once."""

        with self._lock:
            clients = tuple(self._clients.values())
            self._clients.clear()
        for client in clients:
            client.close()


@dataclass(frozen=True, slots=True)
class TypedInvocation:
    """One checked response payload from a canonical DirectPluginRuntime call."""

    type_url: str
    value: bytes


def invoke_typed(
    client: DirectPluginClient,
    *,
    capability: str,
    interface_version: str,
    method: str,
    request_type_url: str,
    request_bytes: bytes,
    response_type_url: str,
    deadline_seconds: float,
) -> TypedInvocation:
    """Invoke a fixed method and verify the server's response type URL."""

    try:
        response = client.invoke(
            capability=capability,
            interface_version=interface_version,
            method=method,
            request=DirectPayload(type_url=request_type_url, value=request_bytes),
            deadline_seconds=deadline_seconds,
        )
    except DirectPluginInvocationCancelled as error:
        raise DirectCapabilityError("DIRECT_PLUGIN_CANCELLED", retryable=True) from error
    except DirectPluginDeadlineExceeded as error:
        raise DirectCapabilityError("DIRECT_PLUGIN_DEADLINE_EXCEEDED", retryable=True) from error
    except DirectPluginFailure as error:
        code = (
            error.domain_code
            if _SAFE_DOMAIN_CODE.fullmatch(error.domain_code)
            else "PLUGIN_FAILURE"
        )
        raise DirectCapabilityError(
            f"DIRECT_PLUGIN_{code}", unavailable=error.retryable, retryable=error.retryable
        ) from error
    except DirectPluginTransportError as error:
        retryable = error.status.name in {"UNAVAILABLE", "RESOURCE_EXHAUSTED"}
        raise DirectCapabilityError(
            "DIRECT_PLUGIN_TRANSPORT_FAILED", unavailable=retryable, retryable=retryable
        ) from error
    except DirectPluginProtocolError as error:
        raise DirectCapabilityError("DIRECT_PLUGIN_PROTOCOL_INVALID") from error
    if response.type_url != response_type_url:
        raise DirectCapabilityError("DIRECT_PLUGIN_RESPONSE_TYPE_MISMATCH")
    if not isinstance(response.value, bytes):
        raise DirectCapabilityError("DIRECT_PLUGIN_RESPONSE_INVALID")
    return TypedInvocation(type_url=response.type_url, value=response.value)


__all__ = ["DirectCapabilityError", "DirectPluginPool", "TypedInvocation", "invoke_typed"]
