"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 logging.py                                                      │
│  Module: cyrene_navigator.logging                                   │
│  Role: Structured NDJSON logging and correlation sanitization.      │
│                                                                     │
│  模块职责：Navigator 聚合服务结构化日志、上下文关联与不可信输入清洗。       │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import json
import re
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

_TRACEPARENT_RE = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$")

MAX_REQUEST_ID_LEN = 128
MAX_OPERATION_ID_LEN = 128
MAX_RESOURCE_ID_LEN = 256
MAX_RECORD_BYTES = 32 * 1024
MAX_MESSAGE_BYTES = 4 * 1024

_SENSITIVE_KEY_SUBSTRINGS = (
    "authorization",
    "auth",
    "token",
    "api_key",
    "apikey",
    "secret",
    "password",
    "cookie",
    "client_secret",
    "private_key",
    "pairing_code",
)

_INSTANCE_ID = str(uuid4())


def is_sensitive_key(key: str) -> bool:
    """Check whether a field name matches secret key patterns."""
    lower = key.lower().replace("-", "_")
    if lower == "tokens" or lower.endswith("_tokens") or lower == "token_count":
        return False
    return any(sub in lower for sub in _SENSITIVE_KEY_SUBSTRINGS)


def sanitize_correlation_id(raw: str | None, max_len: int = 128) -> str | None:
    """Sanitize and bound an untrusted client correlation header."""
    if not raw:
        return None
    trimmed = raw.strip()
    if not trimmed:
        return None
    filtered = "".join(c for c in trimmed if c.isalnum() or c in ("-", "_", ".", "/", ":"))
    if not filtered:
        return None
    return filtered[:max_len]


def sanitize_request_id(raw: str | None) -> str | None:
    return sanitize_correlation_id(raw, MAX_REQUEST_ID_LEN)


def sanitize_operation_id(raw: str | None) -> str | None:
    return sanitize_correlation_id(raw, MAX_OPERATION_ID_LEN)


def sanitize_resource_id(raw: str | None) -> str | None:
    return sanitize_correlation_id(raw, MAX_RESOURCE_ID_LEN)


def parse_w3c_traceparent(raw: str | None) -> tuple[str, str] | None:
    """Validate and parse a W3C traceparent header into (trace_id, span_id)."""
    if not raw:
        return None
    trimmed = raw.strip()
    match = _TRACEPARENT_RE.fullmatch(trimmed)
    if match is None:
        return None
    trace_id, span_id = match.group(1), match.group(2)
    if trace_id == "0" * 32 or span_id == "0" * 16:
        return None
    return trace_id, span_id


def redact_attributes(attrs: Mapping[str, Any]) -> dict[str, Any]:
    """Recursively redact sensitive key-values in attributes."""
    result: dict[str, Any] = {}
    for k, v in attrs.items():
        if is_sensitive_key(k):
            result[k] = "[REDACTED]"
        elif isinstance(v, Mapping):
            result[k] = redact_attributes(v)
        elif isinstance(v, (list, tuple)):
            result[k] = [
                redact_attributes(item) if isinstance(item, Mapping) else item for item in v
            ]
        else:
            result[k] = v
    return result


def format_cyrene_log(
    level: str,
    event_name: str,
    message: str,
    *,
    service_name: str = "cyrene-navigator",
    trace_id: str | None = None,
    span_id: str | None = None,
    attributes: Mapping[str, Any] | None = None,
) -> str:
    """Format a single UTF-8 NDJSON log record conforming to Cyrene specification."""
    now_utc = datetime.now(UTC).isoformat().replace("+00:00", "Z")

    truncated_msg = message[:MAX_MESSAGE_BYTES] if len(message) > MAX_MESSAGE_BYTES else message

    record: dict[str, Any] = {
        "schema_version": 1,
        "timestamp": now_utc,
        "level": level.upper(),
        "event.name": event_name,
        "service.name": service_name,
        "service.instance.id": _INSTANCE_ID,
        "message": truncated_msg,
    }

    if trace_id:
        record["trace_id"] = trace_id
    if span_id:
        record["span_id"] = span_id

    if attributes:
        redacted = redact_attributes(attributes)
        if redacted:
            record["attributes"] = redacted

    serialized = json.dumps(record, separators=(",", ":"), ensure_ascii=False)

    if len(serialized.encode("utf-8")) > MAX_RECORD_BYTES:
        record["attributes"] = {"truncated": True}
        serialized = json.dumps(record, separators=(",", ":"), ensure_ascii=False)

    return serialized


def emit_diagnostic_error(
    event_name: str,
    error_code: str,
    message: str,
    *,
    trace_id: str | None = None,
    span_id: str | None = None,
    attributes: Mapping[str, Any] | None = None,
) -> None:
    """Emit a structured diagnostic error record directly to sys.stderr."""
    attrs = dict(attributes or {})
    attrs["error.code"] = error_code
    line = format_cyrene_log(
        "ERROR",
        event_name,
        message,
        service_name="cyrene-navigator",
        trace_id=trace_id,
        span_id=span_id,
        attributes=attrs,
    )
    sys.stderr.write(line + "\n")
    sys.stderr.flush()
