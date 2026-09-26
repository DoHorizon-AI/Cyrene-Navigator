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

import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any

from fastapi.testclient import TestClient
from jsonschema import FormatChecker, validate
from openapi_spec_validator.readers import read_from_filename

from cyrene_navigator import Product, create_app
from cyrene_navigator.domain import ProductRead
from cyrene_navigator.persistence import PersistencePrincipal

_TEST_WORKSPACE = "workspace-1"
_TEST_ORGANIZATION = "organization-1"
_TEST_UUID = "00000000-0000-0000-0000-000000000001"
_SNAPSHOT_PRINCIPALS = {
    "frontend-token": PersistencePrincipal(
        "frontend",
        frozenset({_TEST_WORKSPACE, "workspace-2", "workspace-3"}),
        organization_id=_TEST_ORGANIZATION,
    ),
    "other-workspace-token": PersistencePrincipal(
        "other-frontend", frozenset({"workspace-other"}), organization_id=_TEST_ORGANIZATION
    ),
    "legacy-token": PersistencePrincipal("legacy-frontend", frozenset({_TEST_WORKSPACE})),
}


def test_runtime_paths_match_frozen_openapi() -> None:
    app = create_app(directory={})
    runtime = app.openapi()
    contract, _ = read_from_filename(
        str(Path(__file__).parents[1] / "contracts/product/v1/openapi.yaml")
    )
    assert set(runtime["paths"]) == set(contract["paths"])
    assert runtime["paths"]["/api/v1/workspace-snapshots"]["post"]["security"] == [
        {"NavigatorProductBearer": []}
    ]
    assert set(runtime["paths"]["/api/v1/workspace-snapshots"]["post"]["responses"]) >= {
        "401",
        "403",
    }


def _handler(status: int, payload: dict[str, Any]) -> type[BaseHTTPRequestHandler]:
    class ProductHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.server.traceparents.append(self.headers.get("traceparent"))  # type: ignore[attr-defined]
            self.server.tracestates.append(self.headers.get("tracestate"))  # type: ignore[attr-defined]
            self.server.authorization_headers.append(  # type: ignore[attr-defined]
                self.headers.get("Authorization")
            )
            self.server.paths.append(self.path)  # type: ignore[attr-defined]
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
    server.authorization_headers = []  # type: ignore[attr-defined]
    server.paths = []  # type: ignore[attr-defined]
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def test_real_http_partial_snapshot_returns_only_owner_resource_digest(tmp_path: Path) -> None:
    catalyst_resource = {
        "id": "dataset-version-1",
        "state": "PUBLISHED",
        "resourceVersion": 2,
        "sourceUrl": "https://product.internal.example/private/datasets/one",
    }
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
        },
        principals=_SNAPSHOT_PRINCIPALS,
        service_credentials={
            (Product.CATALYST, _TEST_ORGANIZATION, _TEST_WORKSPACE): "catalyst-service-token",
            (Product.ECHO, _TEST_ORGANIZATION, _TEST_WORKSPACE): "echo-service-token",
        },
    )
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/workspace-snapshots",
                headers={
                    "Authorization": "Bearer frontend-token",
                    "traceparent": traceparent,
                    "tracestate": tracestate,
                },
                json={
                    "workspaceId": _TEST_WORKSPACE,
                    "reads": [
                        {"product": "CATALYST", "path": "/internal/workspace/v1/datasets"},
                        {
                            "product": "ECHO",
                            "path": ("/internal/workspace/v1/evaluation-suites/" + _TEST_UUID),
                        },
                    ],
                },
            )
        assert response.status_code == 200
        snapshot = response.json()
        assert snapshot["status"] == "PARTIAL"
        encoded_resource = json.dumps(
            catalyst_resource,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        assert snapshot["views"][0]["resourceSummary"] == {
            "jsonSha256": f"sha256:{hashlib.sha256(encoded_resource).hexdigest()}",
            "canonicalJsonBytes": len(encoded_resource),
        }
        assert "resource" not in snapshot["views"][0]
        assert "dataset-version-1" not in response.text
        assert "product.internal.example" not in response.text
        assert snapshot["views"][0]["status"] == "AVAILABLE"
        assert snapshot["views"][0]["sourceOperation"] == "workspaceListDatasets"
        assert snapshot["views"][1]["status"] == "UNAVAILABLE"
        assert snapshot["views"][1]["sourceOperation"] == "workspaceGetEvaluationSuite"
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
        assert catalyst.authorization_headers == ["Bearer catalyst-service-token"]  # type: ignore[attr-defined]
        assert echo.authorization_headers == ["Bearer echo-service-token"]  # type: ignore[attr-defined]
        assert catalyst.paths == ["/internal/workspace/v1/datasets"]  # type: ignore[attr-defined]
        assert echo.paths == [  # type: ignore[attr-defined]
            f"/internal/workspace/v1/evaluation-suites/{_TEST_UUID}"
        ]
        assert "catalyst-service-token" not in response.text
        assert "echo-service-token" not in response.text
        assert f"http://127.0.0.1:{catalyst.server_port}" not in response.text
        assert f"http://127.0.0.1:{echo.server_port}" not in response.text
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
    app = create_app(directory={}, principals=_SNAPSHOT_PRINCIPALS)
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/workspace-snapshots",
            headers={"Authorization": "Bearer frontend-token"},
            json={
                "workspaceId": "workspace-2",
                "reads": [
                    {
                        "product": "YIELD",
                        "path": f"/internal/workspace/v1/training-drafts/{_TEST_UUID}",
                    }
                ],
            },
        )
    assert response.status_code == 200
    snapshot = response.json()
    assert snapshot["status"] == "FAILED"
    assert snapshot["views"][0]["problem"]["code"] == "NAVIGATOR_PRODUCT_UNCONFIGURED"
    assert "resource" not in snapshot["views"][0]


def test_traversal_path_is_rfc9457_validation_problem() -> None:
    app = create_app(directory={}, principals=_SNAPSHOT_PRINCIPALS)
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


def test_snapshot_requires_scoped_principal_and_binds_body_workspace() -> None:
    app = create_app(directory={}, principals=_SNAPSHOT_PRINCIPALS)
    body = {
        "workspaceId": _TEST_WORKSPACE,
        "reads": [{"product": "EXCHANGE", "path": "/api/v1/workspace/gateway-routes"}],
    }
    with TestClient(app) as client:
        missing = client.post("/api/v1/workspace-snapshots", json=body)
        unknown = client.post(
            "/api/v1/workspace-snapshots",
            json=body,
            headers={"Authorization": "Bearer unknown-token"},
        )
        unscoped = client.post(
            "/api/v1/workspace-snapshots",
            json=body,
            headers={"Authorization": "Bearer legacy-token"},
        )
        forged_workspace = client.post(
            "/api/v1/workspace-snapshots",
            json={**body, "workspaceId": "workspace-other"},
            headers={"Authorization": "Bearer frontend-token"},
        )

    assert missing.status_code == unknown.status_code == 401
    assert missing.headers["www-authenticate"] == "Bearer"
    assert "frontend-token" not in missing.text + unknown.text
    assert unscoped.status_code == forged_workspace.status_code == 403
    assert (
        unscoped.json()["code"]
        == forged_workspace.json()["code"]
        == ("NAVIGATOR_WORKSPACE_FORBIDDEN")
    )


def test_missing_scoped_service_credential_does_not_call_product(tmp_path: Path) -> None:
    server, server_thread = _server(200, {"id": "must-not-be-read"})
    app = create_app(
        directory={Product.CATALYST: f"http://127.0.0.1:{server.server_port}"},
        principals=_SNAPSHOT_PRINCIPALS,
    )
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/workspace-snapshots",
                headers={"Authorization": "Bearer frontend-token"},
                json={
                    "workspaceId": _TEST_WORKSPACE,
                    "reads": [{"product": "CATALYST", "path": "/internal/workspace/v1/datasets"}],
                },
            )
        assert response.status_code == 200
        snapshot = response.json()
        assert snapshot["status"] == "FAILED"
        assert snapshot["views"][0]["problem"]["code"] == (
            "NAVIGATOR_PRODUCT_CREDENTIAL_UNCONFIGURED"
        )
        assert server.paths == []  # type: ignore[attr-defined]
        assert server.authorization_headers == []  # type: ignore[attr-defined]
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=3)


def test_service_credential_from_another_workspace_does_not_fallback() -> None:
    server, server_thread = _server(200, {"id": "must-not-be-read"})
    app = create_app(
        directory={Product.CATALYST: f"http://127.0.0.1:{server.server_port}"},
        principals=_SNAPSHOT_PRINCIPALS,
        service_credentials={
            (Product.CATALYST, _TEST_ORGANIZATION, "workspace-2"): "workspace-2-token"
        },
    )
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/workspace-snapshots",
                headers={"Authorization": "Bearer frontend-token"},
                json={
                    "workspaceId": _TEST_WORKSPACE,
                    "reads": [{"product": "CATALYST", "path": "/internal/workspace/v1/datasets"}],
                },
            )
        assert response.status_code == 200
        assert response.json()["views"][0]["problem"]["code"] == (
            "NAVIGATOR_PRODUCT_CREDENTIAL_UNCONFIGURED"
        )
        assert server.paths == []  # type: ignore[attr-defined]
        assert server.authorization_headers == []  # type: ignore[attr-defined]
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=3)


def test_nonstandard_product_json_becomes_safe_observation() -> None:
    server, server_thread = _server(200, {"score": float("nan")})
    app = create_app(
        directory={Product.CATALYST: f"http://127.0.0.1:{server.server_port}"},
        principals=_SNAPSHOT_PRINCIPALS,
        service_credentials={
            (Product.CATALYST, _TEST_ORGANIZATION, _TEST_WORKSPACE): "catalyst-service-token"
        },
    )
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/workspace-snapshots",
                headers={"Authorization": "Bearer frontend-token"},
                json={
                    "workspaceId": _TEST_WORKSPACE,
                    "reads": [{"product": "CATALYST", "path": "/internal/workspace/v1/datasets"}],
                },
            )
        assert response.status_code == 200
        snapshot = response.json()
        assert snapshot["status"] == "FAILED"
        assert snapshot["views"][0]["problem"]["code"] == ("NAVIGATOR_PRODUCT_RESPONSE_INVALID")
        assert "NaN" not in response.text
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=3)


def test_only_fixed_owner_scoped_read_paths_and_uuid_parameters_are_accepted() -> None:
    approved = (
        (Product.CATALYST, "/internal/workspace/v1/datasets"),
        (
            Product.ECHO,
            f"/internal/workspace/v1/evaluation-suites/{_TEST_UUID}",
        ),
        (Product.EXCHANGE, "/api/v1/workspace/gateway-routes"),
        (Product.REACTOR, "/internal/workspace/v1/model-imports"),
        (
            Product.YIELD,
            f"/internal/workspace/v1/training-drafts/{_TEST_UUID}",
        ),
    )
    for product, path in approved:
        assert ProductRead(product=product, path=path).path == path

    rejected = (
        (Product.CATALYST, "/api/v1/dataset-versions/00000000-0000-0000-0000-000000000001"),
        (Product.CATALYST, "/internal/workspace/v1/credentials"),
        (Product.ECHO, "/internal/workspace/v1/evaluation-suites/not-a-uuid"),
        (
            Product.ECHO,
            f"/internal/workspace/v1/evaluation-suites/{_TEST_UUID}?include=private",
        ),
        (Product.EXCHANGE, "/api/v1/gateway-routes"),
        (Product.EXCHANGE, "/api/v1/workspace/gateway-routes?limit=1"),
        (Product.REACTOR, "/api/v1/model-imports"),
        (
            Product.YIELD,
            f"/internal/workspace/v1/training-drafts/{_TEST_UUID}/actions/start",
        ),
        (Product.YIELD, f"/api/v1/training-runs/{_TEST_UUID}"),
    )
    for product, path in rejected:
        try:
            ProductRead(product=product, path=path)
        except ValueError:
            continue
        raise AssertionError(f"unexpectedly approved nested read: {product} {path}")
