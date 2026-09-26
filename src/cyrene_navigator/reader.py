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

import json
import re
from typing import Any, Protocol

import httpx

_MAX_PRODUCT_RESPONSE_BYTES = 4 * 1024 * 1024
_SAFE_ERROR_CODE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")


def _reject_nonstandard_json_constant(value: str) -> None:
    """Reject JavaScript NaN and Infinity extensions in Product JSON. | 拒绝非标准 JSON 数值。"""

    raise ValueError(f"non-standard JSON constant: {value}")


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

    def read(
        self,
        url: str,
        traceparent: str,
        tracestate: str | None = None,
        *,
        bearer_token: str,
        max_json_bytes: int,
    ) -> dict[str, Any]:
        """Return an owner JSON object. | 返回权威产品 JSON 对象。"""


class HttpxProductReader:
    """Finite-timeout HTTPX reader. | 有限超时 HTTPX 读取器。"""

    def __init__(self, timeout_seconds: float = 3.0) -> None:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        self._timeout = timeout_seconds

    def read(
        self,
        url: str,
        traceparent: str,
        tracestate: str | None = None,
        *,
        bearer_token: str,
        max_json_bytes: int,
    ) -> dict[str, Any]:
        """Fetch and validate a Product JSON object over real HTTP. | 通过 HTTP 读取产品。"""

        if max_json_bytes <= 0:
            raise ProductReadFailure(
                code="NAVIGATOR_SNAPSHOT_RESPONSE_TOO_LARGE",
                detail="The Workspace snapshot exceeded its JSON size limit.",
                retryable=False,
            )
        response_limit = min(_MAX_PRODUCT_RESPONSE_BYTES, max_json_bytes)
        try:
            headers = {
                "Accept": "application/json",
                "Authorization": f"Bearer {bearer_token}",
                "traceparent": traceparent,
            }
            if tracestate:
                headers["tracestate"] = tracestate
            with httpx.stream(
                "GET",
                url,
                headers=headers,
                timeout=self._timeout,
                follow_redirects=False,
            ) as response:
                content_length = response.headers.get("content-length")
                if content_length is not None:
                    try:
                        if int(content_length) > response_limit:
                            raise ProductReadFailure(
                                code="NAVIGATOR_PRODUCT_RESPONSE_TOO_LARGE",
                                detail="The Product API response exceeded the JSON size limit.",
                                retryable=False,
                                upstream_status=response.status_code,
                            )
                    except ValueError:
                        pass
                body = bytearray()
                for chunk in response.iter_bytes():
                    if len(body) + len(chunk) > response_limit:
                        raise ProductReadFailure(
                            code="NAVIGATOR_PRODUCT_RESPONSE_TOO_LARGE",
                            detail="The Product API response exceeded the JSON size limit.",
                            retryable=False,
                            upstream_status=response.status_code,
                        )
                    body.extend(chunk)
                status_code = response.status_code
                content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
        except httpx.RequestError as exc:
            raise ProductReadFailure(
                code="NAVIGATOR_PRODUCT_UNREACHABLE",
                detail="The configured Product API is unreachable.",
                retryable=True,
            ) from exc
        if content_type != "application/json" and not content_type.endswith("+json"):
            raise ProductReadFailure(
                code="NAVIGATOR_PRODUCT_RESPONSE_INVALID",
                detail="The Product API did not return a JSON content type.",
                retryable=False,
                upstream_status=status_code if status_code >= 400 else None,
            )
        try:
            payload = json.loads(body, parse_constant=_reject_nonstandard_json_constant)
        except ValueError as exc:
            raise ProductReadFailure(
                code="NAVIGATOR_PRODUCT_RESPONSE_INVALID",
                detail="The Product API did not return valid JSON.",
                retryable=False,
                upstream_status=status_code if status_code >= 400 else None,
            ) from exc
        if isinstance(payload, dict):
            try:
                encoded_payload = json.dumps(
                    payload,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                ).encode("utf-8")
            except (TypeError, ValueError, UnicodeError) as exc:
                raise ProductReadFailure(
                    code="NAVIGATOR_PRODUCT_RESPONSE_INVALID",
                    detail="The Product API did not return valid JSON.",
                    retryable=False,
                    upstream_status=status_code if status_code >= 400 else None,
                ) from exc
            if len(encoded_payload) > max_json_bytes:
                raise ProductReadFailure(
                    code="NAVIGATOR_SNAPSHOT_RESPONSE_TOO_LARGE",
                    detail="The Workspace snapshot exceeded its JSON size limit.",
                    retryable=False,
                    upstream_status=status_code if status_code >= 400 else None,
                )
        if status_code >= 400:
            raw_code = payload.get("code") if isinstance(payload, dict) else None
            code = (
                raw_code
                if isinstance(raw_code, str) and _SAFE_ERROR_CODE.fullmatch(raw_code)
                else None
            )
            raise ProductReadFailure(
                code=str(code or "NAVIGATOR_PRODUCT_ERROR"),
                detail="The Product API returned an error response.",
                retryable=status_code >= 500,
                upstream_status=status_code,
            )
        if not isinstance(payload, dict):
            raise ProductReadFailure(
                code="NAVIGATOR_PRODUCT_RESPONSE_INVALID",
                detail="The Product API response must be a JSON object.",
                retryable=False,
            )
        return payload
