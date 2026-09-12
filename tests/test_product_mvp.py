"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 test_product_mvp.py                                             │
│  Module: tests.test_product_mvp                                     │
│  Role: Real HTTP aggregation, partial failure, and trace acceptance. │
│                                                                     │
│  模块职责：验证真实 HTTP 聚合、部分失败与追踪传播。                          │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any

from fastapi.testclient import TestClient
from jsonschema import FormatChecker, validate
from openapi_spec_validator.readers import read_from_filename

from cyrene_navigator import Product, create_app


def test_runtime_paths_match_frozen_openapi() -> None:
    app = create_app(directory={})
    contract, _ = read_from_filename(
        str(Path(__file__).parents[1] / "contracts/product/v1/openapi.yaml")
    )
    assert set(app.openapi()["paths"]) == set(contract["paths"])


def _handler(status: int, payload: dict[str, Any]) -> type[BaseHTTPRequestHandler]:
    class ProductHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.server.traceparents.append(self.headers.get("traceparent"))  # type: ignore[attr-defined]
            self.server.tracestates.append(self.headers.get("tracestate"))  # type: ignore[attr-defined]
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    return ProductHandler


def _server(status: int, payload: dict[str, Any]) -> tuple[ThreadingHTTPServer, Thread]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(status, payload))
    server.traceparents = []  # type: ignore[attr-defined]
    server.tracestates = []  # type: ignore[attr-defined]
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def test_real_http_partial_snapshot_preserves_owner_resource(tmp_path: Path) -> None:
    catalyst_resource = {"id": "dataset-version-1", "state": "PUBLISHED", "resourceVersion": 2}
    catalyst, catalyst_thread = _server(200, catalyst_resource)
    echo, echo_thread = _server(
        503,
        {
            "type": "https://errors.cyrene.dev/echo/unavailable",
            "code": "ECHO_UNAVAILABLE",
            "detail": "maintenance",
        },
    )
    traceparent = "00-11111111111111111111111111111111-2222222222222222-01"
    tracestate = "vendor=value"
    app = create_app(
        directory={
            Product.CATALYST: f"http://127.0.0.1:{catalyst.server_port}",
            Product.ECHO: f"http://127.0.0.1:{echo.server_port}",
        }
    )
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/workspace-snapshots",
                headers={"traceparent": traceparent, "tracestate": tracestate},
                json={
                    "workspaceId": "workspace-1",
                    "reads": [
                        {"product": "CATALYST", "path": "/api/v1/dataset-versions/1"},
                        {"product": "ECHO", "path": "/api/v1/evaluation-runs/1"},
                    ],
                },
            )
        assert response.status_code == 200
        snapshot = response.json()
        assert snapshot["status"] == "PARTIAL"
        assert snapshot["views"][0]["resource"] == catalyst_resource
        assert snapshot["views"][0]["status"] == "AVAILABLE"
        assert snapshot["views"][1]["status"] == "UNAVAILABLE"
        assert snapshot["views"][1]["problem"] == {
            "code": "ECHO_UNAVAILABLE",
            "detail": "The Product API returned an error response.",
            "retryable": True,
            "upstreamStatus": 503,
        }
        assert catalyst.traceparents == [traceparent]  # type: ignore[attr-defined]
        assert echo.traceparents == [traceparent]  # type: ignore[attr-defined]
        assert catalyst.tracestates == [tracestate]  # type: ignore[attr-defined]
        assert echo.tracestates == [tracestate]  # type: ignore[attr-defined]
        assert response.headers["traceparent"] == traceparent
        assert response.headers["tracestate"] == tracestate

        schema = json.loads(
            (
                Path(__file__).parents[1] / "contracts/product/v1/workspace-snapshot.schema.json"
            ).read_text()
        )
        validate(instance=snapshot, schema=schema, format_checker=FormatChecker())
    finally:
        catalyst.shutdown()
        catalyst.server_close()
        catalyst_thread.join(timeout=3)
        echo.shutdown()
        echo.server_close()
        echo_thread.join(timeout=3)


def test_unconfigured_product_is_failed_view_not_invented_state() -> None:
    app = create_app(directory={})
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/workspace-snapshots",
            json={
                "workspaceId": "workspace-2",
                "reads": [{"product": "YIELD", "path": "/api/v1/training-runs/1"}],
            },
        )
    assert response.status_code == 200
    snapshot = response.json()
    assert snapshot["status"] == "FAILED"
    assert snapshot["views"][0]["problem"]["code"] == "NAVIGATOR_PRODUCT_UNCONFIGURED"
    assert "resource" not in snapshot["views"][0]


def test_traversal_path_is_rfc9457_validation_problem() -> None:
    app = create_app(directory={})
    with TestClient(app) as client:
        for path in (
            "/api/v1/../../secrets",
            "/api/v1/%2e%2e/%2e%2e/secrets",
            "/api/v1/%252e%252e/%252e%252e/secrets",
        ):
            response = client.post(
                "/api/v1/workspace-snapshots",
                json={
                    "workspaceId": "workspace-3",
                    "reads": [{"product": "CATALYST", "path": path}],
                },
            )
            assert response.status_code == 422
            assert response.headers["content-type"].startswith("application/problem+json")
            assert response.json()["code"] == "NAVIGATOR_REQUEST_INVALID"
