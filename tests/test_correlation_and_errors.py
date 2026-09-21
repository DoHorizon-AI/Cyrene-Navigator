"""
Unit tests for Cyrene Navigator correlation propagation, error mapping, and logging.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from cyrene_navigator.api import create_app
from cyrene_navigator.errors import map_navigator_error
from cyrene_navigator.logging import (
    format_cyrene_log,
    is_sensitive_key,
    parse_w3c_traceparent,
    redact_attributes,
    sanitize_correlation_id,
    sanitize_request_id,
)


def test_w3c_traceparent_parsing():
    valid = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    parsed = parse_w3c_traceparent(valid)
    assert parsed is not None
    trace_id, span_id = parsed
    assert trace_id == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert span_id == "00f067aa0ba902b7"

    assert parse_w3c_traceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01") is None
    assert parse_w3c_traceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01") is None
    assert parse_w3c_traceparent("invalid-traceparent") is None


def test_correlation_sanitization():
    dirty = "req-123\r\ninjection: attempt\x00"
    sanitized = sanitize_request_id(dirty)
    assert sanitized == "req-123injection:attempt"
    assert "\r" not in sanitized
    assert "\n" not in sanitized

    long_id = "X" * 300
    assert len(sanitize_request_id(long_id)) == 128


def test_redaction_preserves_token_usage_counters():
    attrs = {
        "pairing_code": "secret-pairing-code",
        "api_key": "secret-key",
        "tokens": 4096,
        "prompt_tokens": 2048,
        "completion_tokens": 2048,
        "token_count": 4096,
        "safe_attr": "nav-view-1",
    }
    redacted = redact_attributes(attrs)
    assert redacted["pairing_code"] == "[REDACTED]"
    assert redacted["api_key"] == "[REDACTED]"
    assert redacted["tokens"] == 4096
    assert redacted["prompt_tokens"] == 2048
    assert redacted["completion_tokens"] == 2048
    assert redacted["token_count"] == 4096
    assert redacted["safe_attr"] == "nav-view-1"


def test_navigator_error_mapping():
    mapped = map_navigator_error("NAVIGATOR_REQUEST_INVALID")
    assert mapped["code"] == "PRODUCT.NAVIGATOR.REQUEST_INVALID"
    assert mapped["recovery_action"] == "fix_configuration"

    mapped_pairing = map_navigator_error("NAVIGATOR_PAIRING_CODE_EXPIRED")
    assert mapped_pairing["code"] == "PRODUCT.NAVIGATOR.PAIRING_EXPIRED"
    assert mapped_pairing["recovery_action"] == "user_action_required"

    mapped_unknown = map_navigator_error("CUSTOM_FOO")
    assert mapped_unknown["code"] == "PRODUCT.NAVIGATOR.CUSTOM_FOO"
    assert mapped_unknown["recovery_action"] == "query_state_first"


def test_structured_log_formatting():
    log_line = format_cyrene_log(
        "INFO",
        "product.navigator.test_event",
        "Test navigator message",
        trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
        span_id="00f067aa0ba902b7",
        attributes={"pairing_code": "secret-123"},
    )
    record = json.loads(log_line)
    assert record["schema_version"] == 1
    assert record["level"] == "INFO"
    assert record["service.name"] == "cyrene-navigator"
    assert record["event.name"] == "product.navigator.test_event"
    assert record["trace_id"] == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert record["span_id"] == "00f067aa0ba902b7"
    assert record["attributes"]["pairing_code"] == "[REDACTED]"


def test_api_traceparent_and_validation_error():
    app = create_app(directory={})
    client = TestClient(app)

    traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    req_id = "req-nav-test-123"

    # Send invalid JSON body to trigger RequestValidationError (422)
    res = client.post(
        "/api/v1/workspace-snapshots",
        json={"invalid": "payload"},
        headers={"traceparent": traceparent, "x-request-id": req_id},
    )

    assert res.status_code == 422
    assert "traceparent" in res.headers
    assert "4bf92f3577b34da6a3ce929d0e0e4736" in res.headers["traceparent"]
    assert res.headers["x-request-id"] == req_id

    problem = res.json()
    assert problem["code"] == "NAVIGATOR_REQUEST_INVALID"
    assert problem.get("requestId") == req_id or problem.get("request_id") == req_id
    assert problem.get("traceId") == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert problem.get("recoveryAction") == "fix_configuration"
