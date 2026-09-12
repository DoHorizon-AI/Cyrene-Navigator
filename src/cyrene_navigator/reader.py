"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 reader.py                                                       │
│  Module: cyrene_navigator.reader                                    │
│  Role: Navigator-local real-HTTP Product read port.                  │
│                                                                     │
│  模块职责：可替换的真实 HTTP 产品读取 SPI。                               │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

from typing import Any, Protocol

import httpx


class ProductReadFailure(RuntimeError):
    """Typed transport/owner response observation failure. | 类型化读取失败。"""

    def __init__(
        self, *, code: str, detail: str, retryable: bool, upstream_status: int | None = None
    ) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.retryable = retryable
        self.upstream_status = upstream_status


class ProductReadPort(Protocol):
    """Navigator-local seam without global authority. | 无全局权威的本地读取端口。"""

    def read(self, url: str, traceparent: str, tracestate: str | None = None) -> dict[str, Any]:
        """Return an owner JSON object. | 返回权威产品 JSON 对象。"""


class HttpxProductReader:
    """Finite-timeout HTTPX reader. | 有限超时 HTTPX 读取器。"""

    def __init__(self, timeout_seconds: float = 3.0) -> None:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        self._timeout = timeout_seconds

    def read(self, url: str, traceparent: str, tracestate: str | None = None) -> dict[str, Any]:
        """Fetch and validate a Product JSON object over real HTTP. | 通过 HTTP 读取产品。"""

        try:
            headers = {"Accept": "application/json", "traceparent": traceparent}
            if tracestate:
                headers["tracestate"] = tracestate
            response = httpx.get(
                url,
                headers=headers,
                timeout=self._timeout,
                follow_redirects=False,
            )
        except httpx.RequestError as exc:
            raise ProductReadFailure(
                code="NAVIGATOR_PRODUCT_UNREACHABLE",
                detail="The configured Product API is unreachable.",
                retryable=True,
            ) from exc
        try:
            payload = response.json()
        except ValueError as exc:
            raise ProductReadFailure(
                code="NAVIGATOR_PRODUCT_RESPONSE_INVALID",
                detail="The Product API did not return valid JSON.",
                retryable=False,
                upstream_status=response.status_code if response.status_code >= 400 else None,
            ) from exc
        if response.status_code >= 400:
            code = payload.get("code") if isinstance(payload, dict) else None
            raise ProductReadFailure(
                code=str(code or "NAVIGATOR_PRODUCT_ERROR"),
                detail="The Product API returned an error response.",
                retryable=response.status_code >= 500,
                upstream_status=response.status_code,
            )
        if not isinstance(payload, dict):
            raise ProductReadFailure(
                code="NAVIGATOR_PRODUCT_RESPONSE_INVALID",
                detail="The Product API response must be a JSON object.",
                retryable=False,
            )
        return payload
