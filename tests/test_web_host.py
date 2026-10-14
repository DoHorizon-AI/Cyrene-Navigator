"""Focused Web Host authentication, credential, proxy, and launcher tests.

中文:验证 Web Host 的认证、凭据、代理与启动器行为。
"""
# 中文:针对 Web Host 认证、凭据、代理和启动器的重点测试。

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from cyrene_navigator.web_host import ProxyTarget, create_web_host_app

PAIRING_CODE = "pairing-code-for-tests"
SECRET = "hf_test_secret_value"


def _login(client: TestClient) -> dict[str, str]:
    """Pair one test client and return the browser CSRF header.

    中文:配对一个测试 client 并返回浏览器 CSRF header。
    """
    # 中文:创建一对测试客户端,并返回浏览器 CSRF header。

    response = client.post("/api/v1/auth/pair", json={"pairingCode": PAIRING_CODE})
    assert response.status_code == 200, response.text
    return {"X-CSRF-Token": response.json()["csrfToken"]}


def _start_http_fixture(
    handler: type[BaseHTTPRequestHandler],
) -> tuple[ThreadingHTTPServer, threading.Thread, str]:
    """Serve a fixture on loopback so Web Host proxy tests cross a real socket."""

    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, f"http://127.0.0.1:{server.server_port}"


def test_pairing_is_one_time_and_session_cookies_are_scoped() -> None:
    app = create_web_host_app(pairing_code=PAIRING_CODE, secure_cookies=True)
    with TestClient(app, base_url="https://testserver") as client:
        first = client.post("/api/v1/auth/pair", json={"pairingCode": PAIRING_CODE})
        assert first.status_code == 200
        assert "Secure" in first.headers["set-cookie"]
        assert "HttpOnly" in first.headers["set-cookie"]
        assert "SameSite=lax" in first.headers["set-cookie"]
        assert client.get("/api/v1/auth/session").json()["authenticated"] is True

        second = client.post("/api/v1/auth/pair", json={"pairingCode": PAIRING_CODE})
        assert second.status_code == 401
        assert PAIRING_CODE not in second.text


def test_refresh_rotates_session_state_and_csrf_token() -> None:
    app = create_web_host_app(pairing_code=PAIRING_CODE)
    with TestClient(app) as client:
        csrf = _login(client)
        before = client.get("/api/v1/auth/session").json()
        refreshed = client.post("/api/v1/auth/session/refresh", headers=csrf)
        assert refreshed.status_code == 200
        after = refreshed.json()
        assert after["refreshed"] is True
        assert after["sessionId"] == before["sessionId"]
        assert after["csrfToken"] != before["csrfToken"]
        assert client.get("/api/v1/auth/session").json()["authenticated"] is True


def test_expired_access_cookie_can_refresh_until_refresh_deadline() -> None:
    now = [1_800_000_000.0]
    app = create_web_host_app(
        pairing_code=PAIRING_CODE,
        session_ttl_seconds=10,
        refresh_ttl_seconds=100,
        clock=lambda: now[0],
    )
    with TestClient(app) as client:
        csrf = _login(client)
        now[0] += 11
        state = client.get("/api/v1/auth/session")
        assert state.status_code == 200
        assert state.json()["authenticated"] is False
        assert state.json()["refreshable"] is True

        refreshed = client.post("/api/v1/auth/session/refresh", headers=csrf)
        assert refreshed.status_code == 200
        assert refreshed.json()["authenticated"] is True


def test_credentials_never_echo_secret_and_mutations_require_csrf() -> None:
    app = create_web_host_app(pairing_code=PAIRING_CODE)
    with TestClient(app) as client:
        csrf = _login(client)
        body = {"name": "Hugging Face", "provider": "huggingface", "secret": SECRET}
        denied = client.post("/api/v1/credentials", json=body)
        assert denied.status_code == 403
        assert denied.json()["code"] == "NAVIGATOR_CSRF_INVALID"

        created = client.post("/api/v1/credentials", json=body, headers=csrf)
        assert created.status_code == 201, created.text
        metadata = created.json()
        assert SECRET not in created.text
        assert "secret" not in metadata
        assert metadata["state"] == "ACTIVE"

        listed = client.get("/api/v1/credentials")
        assert listed.status_code == 200
        assert listed.json() == [metadata]
        fetched = client.get(f"/api/v1/credentials/{metadata['id']}")
        assert fetched.json() == metadata

        updated = client.patch(
            f"/api/v1/credentials/{metadata['id']}",
            json={"name": "Updated", "secret": "rotated_secret"},
            headers=csrf,
        )
        assert updated.status_code == 200
        assert "rotated_secret" not in updated.text
        assert updated.json()["name"] == "Updated"

        revoked = client.delete(f"/api/v1/credentials/{metadata['id']}", headers=csrf)
        assert revoked.status_code == 200
        assert revoked.json()["state"] == "REVOKED"
        assert app.state.web_host_credentials.resolve(metadata["credentialRef"]) is None


def test_system_status_is_safe_and_proxy_is_fixed_allowlist_with_csrf() -> None:
    captured: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"forwarded": True})

    async_client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    app = create_web_host_app(
        pairing_code=PAIRING_CODE,
        proxy_targets={"/api/v1/exchange": "http://backend.test/root"},
        http_client=async_client,
    )
    try:
        with TestClient(app) as client:
            status = client.get("/api/v1/system/status")
            assert status.status_code == 200
            assert status.json()["status"] == "ok"
            assert SECRET not in status.text

            csrf = _login(client)
            get_response = client.get("/api/v1/exchange/models?scope=local")
            assert get_response.status_code == 200
            assert captured[-1].url == "http://backend.test/root/models?scope=local"
            assert "authorization" not in captured[-1].headers
            assert captured[-1].headers["traceparent"].startswith("00-")

            denied = client.post("/api/v1/exchange/models", json={"x": 1})
            assert denied.status_code == 403
            assert len(captured) == 1

            forwarded = client.post(
                "/api/v1/exchange/models",
                json={"x": 1},
                headers={**csrf, "Idempotency-Key": "proxy-write-1"},
            )
            assert forwarded.status_code == 200
            assert captured[-1].headers["idempotency-key"] == "proxy-write-1"
            assert len(captured) == 2

            unknown = client.get("/api/v1/not-allowlisted")
            assert unknown.status_code == 404
            assert unknown.json()["code"] == "NAVIGATOR_PROXY_NOT_ALLOWED"
    finally:
        import asyncio

        asyncio.run(async_client.aclose())


def test_product_auth_proxy_is_opt_in_and_cannot_fall_back_to_static_credentials() -> None:
    assert ProxyTarget("http://127.0.0.1:8000/api/v1").forward_product_authorization is False
    for credential in (
        {"bearer_token": "static-product-token"},
        {"credential_ref": "credential://product-user"},
    ):
        with pytest.raises(ValueError, match="cannot use a configured proxy credential"):
            ProxyTarget(
                "http://127.0.0.1:8000/api/v1",
                forward_product_authorization=True,
                **credential,
            )
    with pytest.raises(ValueError, match="HTTPS or loopback HTTP"):
        ProxyTarget(
            "http://exchange.example.invalid",
            forward_product_authorization=True,
        )
    with pytest.raises(ValueError, match="origin-only proxy URL"):
        ProxyTarget(
            "http://127.0.0.1:8000/api/v1",
            forward_product_authorization=True,
        )
    with pytest.raises(ValueError, match="restricted to /api/v1/exchange"):
        create_web_host_app(
            proxy_targets={
                "/api/v1/other": ProxyTarget(
                    "http://127.0.0.1:8000",
                    forward_product_authorization=True,
                )
            }
        )


@pytest.mark.parametrize(
    "credential",
    (
        {"bearer_token": "static-product-token"},
        {"credential_ref": "credential://product-user"},
    ),
)
def test_static_exchange_credentials_cannot_authorize_product_routes(
    credential: dict[str, str],
) -> None:
    captured: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"unexpected": True})

    import asyncio

    async_client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    app = create_web_host_app(
        pairing_code=PAIRING_CODE,
        proxy_targets={"/api/v1/exchange": ProxyTarget("http://backend.test", **credential)},
        http_client=async_client,
    )
    try:
        with TestClient(app) as client:
            _login(client)
            response = client.get("/api/v1/exchange/api/v1/integrations/connections")
            assert response.status_code == 401
            assert response.json()["code"] == "NAVIGATOR_PRODUCT_AUTH_REQUIRED"
            assert captured == []
    finally:
        asyncio.run(async_client.aclose())


@pytest.mark.parametrize(
    "client_options",
    (
        {"auth": ("default-user", "default-password")},
        {"headers": {"Authorization": "Bearer default-token"}},
        {"headers": {"Cookie": "session=default-cookie"}},
        {"headers": {"X-Cyrene-Workspace-Id": "default-workspace"}},
    ),
)
def test_product_auth_proxy_rejects_clients_with_default_identity_headers(
    client_options: dict[str, object],
) -> None:
    import asyncio

    async_client = httpx.AsyncClient(**client_options)
    try:
        with pytest.raises(ValueError, match="default-auth HTTP client"):
            create_web_host_app(
                pairing_code=PAIRING_CODE,
                proxy_targets={
                    "/api/v1/exchange": ProxyTarget(
                        "http://127.0.0.1:8000",
                        forward_product_authorization=True,
                    )
                },
                http_client=async_client,
            )
    finally:
        asyncio.run(async_client.aclose())


def test_web_launcher_requires_a_registered_exact_exchange_product_auth_target() -> None:
    repository = Path(__file__).parents[1]
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        [str(repository / "src"), environment.get("PYTHONPATH", "")]
    )
    base_command = [
        sys.executable,
        str(repository / "scripts" / "serve-web.py"),
        "--pairing-code",
        PAIRING_CODE,
        "--insecure-http",
    ]
    cases = (
        ([], "/api/v1/exchange", "requires a matching --proxy"),
        (
            ["--proxy", "/api/v1/other=http://127.0.0.1:8000"],
            "/api/v1/other",
            "only supports /api/v1/exchange",
        ),
        (
            ["--proxy", "/api/v1/exchange=http://exchange.example.invalid"],
            "/api/v1/exchange",
            "HTTPS or loopback HTTP",
        ),
    )
    for proxy_arguments, prefix, expected_error in cases:
        result = subprocess.run(
            [*base_command, *proxy_arguments, "--proxy-product-auth", prefix],
            cwd=repository,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
        assert result.returncode != 0
        assert expected_error in result.stderr
        assert PAIRING_CODE not in result.stderr


def test_product_auth_bridge_forwards_only_to_exchange_over_real_loopback() -> None:
    captured: list[dict[str, str | None]] = []
    attacker_requests: list[str] = []
    product_token = "first-party-user-token-not-control"
    product_workspace = "workspace-bridge-test"

    class AttackerHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            attacker_requests.append(self.path)
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, _format: str, *_args: object) -> None:
            return

    attacker_server, attacker_thread, attacker_origin = _start_http_fixture(AttackerHandler)

    class ExchangeHandler(BaseHTTPRequestHandler):
        def _dispatch(self) -> None:
            body_size = int(self.headers.get("Content-Length", "0"))
            if body_size:
                self.rfile.read(body_size)
            authorization = self.headers.get("Authorization")
            captured.append(
                {
                    "path": self.path,
                    "authorization": authorization,
                    "workspace": self.headers.get("X-Cyrene-Workspace-Id"),
                    "productAuthorization": self.headers.get("X-Cyrene-Product-Authorization"),
                    "cookie": self.headers.get("Cookie"),
                    "accept": self.headers.get("Accept"),
                    "lastEventId": self.headers.get("Last-Event-ID"),
                }
            )
            if self.path == "/v1/models" and authorization is None:
                payload = b'{"legacyModelRoute":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if self.path in {"/v1/embeddings", "/v1/responses"} and authorization is None:
                payload = json.dumps({"legacyModelRoute": self.path}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if (
                self.path == "/v1/chat/completions"
                and authorization == "Bearer exchange-gateway-key"
                and self.headers.get("Accept") == "text/event-stream"
            ):
                payload = b'data: {"choices":[]}\n\ndata: [DONE]\n\n'
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if (
                self.path == "/v1/chat/completions"
                and authorization is None
                and self.headers.get("Accept") == "text/event-stream"
            ):
                payload = b'data: {"choices":[]}\n\ndata: [DONE]\n\n'
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if authorization != f"Bearer {product_token}":
                payload = b'{"code":"EXCHANGE_PRINCIPAL_UNAUTHENTICATED"}'
                self.send_response(401)
                self.send_header("Content-Type", "application/problem+json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if self.path == (
                "/api/v1/integrations/connections/7e1c50d2-b4f3-4d61-9302-9a0bd48d1991/authorization-health"
            ):
                self.send_response(302)
                self.send_header("Location", f"{attacker_origin}/capture")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if self.path == "/api/v1/integrations/notifications/events":
                payload = b'id: 8\ndata: {"kind":"authorization.required"}\n\n'
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            payload = json.dumps({"ok": True, "path": self.path}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:
            self._dispatch()

        def do_POST(self) -> None:
            self._dispatch()

        def log_message(self, _format: str, *_args: object) -> None:
            return

    exchange_server, exchange_thread, exchange_origin = _start_http_fixture(ExchangeHandler)
    repository = Path(__file__).parents[1]
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        [str(repository / "src"), environment.get("PYTHONPATH", "")]
    )
    process = subprocess.Popen(
        [
            sys.executable,
            str(repository / "scripts" / "serve-web.py"),
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--pairing-code",
            PAIRING_CODE,
            "--insecure-http",
            "--proxy",
            f"/api/v1/exchange={exchange_origin}",
            "--proxy-product-auth",
            "/api/v1/exchange",
            "--proxy",
            f"/api/v1/other={exchange_origin}",
            "--proxy",
            f"/api/proxy/exchange-gateway={exchange_origin}",
        ],
        cwd=repository,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    try:
        assert process.stdout is not None
        startup_line = process.stdout.readline()
        if not startup_line:
            _, stderr = process.communicate(timeout=5)
            pytest.fail(f"Web Host did not start: {stderr}")
        startup = json.loads(startup_line)
        web_origin = f"http://127.0.0.1:{startup['port']}"

        with httpx.Client(base_url=web_origin, timeout=5.0) as client:
            paired = client.post("/api/v1/auth/pair", json={"pairingCode": PAIRING_CODE})
            assert paired.status_code == 200, paired.text
            csrf = {"X-CSRF-Token": paired.json()["csrfToken"]}
            product_headers = {
                "X-Cyrene-Product-Authorization": f"Bearer {product_token}",
                "X-Cyrene-Workspace-Id": product_workspace,
            }

            unauthenticated = httpx.get(
                f"{web_origin}/api/v1/exchange/api/v1/integrations/connections",
                headers=product_headers,
                timeout=5.0,
            )
            assert unauthenticated.status_code == 401
            assert unauthenticated.json()["code"] == "NAVIGATOR_AUTH_REQUIRED"
            assert captured == []

            missing_bearer = client.get(
                "/api/v1/exchange/api/v1/integrations/connections",
                headers={
                    "Authorization": "Bearer control-session-token",
                    "X-Cyrene-Workspace-Id": product_workspace,
                },
            )
            assert missing_bearer.status_code == 401
            assert missing_bearer.json()["code"] == "NAVIGATOR_PRODUCT_AUTH_REQUIRED"
            assert captured == []

            missing_workspace = client.get(
                "/api/v1/exchange/api/v1/integrations/connections",
                headers={"X-Cyrene-Product-Authorization": f"Bearer {product_token}"},
            )
            assert missing_workspace.status_code == 400
            assert missing_workspace.json()["code"] == "NAVIGATOR_PRODUCT_WORKSPACE_REQUIRED"
            assert captured == []

            invalid_bearer = client.get(
                "/api/v1/exchange/api/v1/integrations/connections",
                headers={
                    "X-Cyrene-Product-Authorization": "Basic not-a-product-bearer",
                    "X-Cyrene-Workspace-Id": product_workspace,
                },
            )
            assert invalid_bearer.status_code == 401
            assert captured == []

            unapproved_path = client.get(
                "/api/v1/exchange/api/v1/accounts/authorizations/native-authref/unapproved",
                headers=product_headers,
            )
            assert unapproved_path.status_code == 404
            assert unapproved_path.json()["code"] == "NAVIGATOR_PRODUCT_AUTH_ROUTE_NOT_ALLOWED"
            assert captured == []

            unsupported_without_identity = client.get(
                "/api/v1/exchange/api/v1/integrations/arbitrary"
            )
            assert unsupported_without_identity.status_code == 404
            assert (
                unsupported_without_identity.json()["code"]
                == "NAVIGATOR_PRODUCT_AUTH_ROUTE_NOT_ALLOWED"
            )
            assert captured == []

            unsupported_account_route = client.get(
                "/api/v1/exchange/api/v1/accounts/authorizations/native-authref/unapproved"
            )
            assert unsupported_account_route.status_code == 404
            assert (
                unsupported_account_route.json()["code"]
                == "NAVIGATOR_PRODUCT_AUTH_ROUTE_NOT_ALLOWED"
            )
            assert captured == []

            unauthenticated_renewal_status = client.get(
                "/api/v1/exchange/api/v1/accounts/renewal-sessions/7e1c50d2-b4f3-4d61-9302-9a0bd48d1991"
            )
            assert unauthenticated_renewal_status.status_code == 401
            assert (
                unauthenticated_renewal_status.json()["code"] == "NAVIGATOR_PRODUCT_AUTH_REQUIRED"
            )
            assert captured == []

            wrong_token = "wrong-product-token"
            rejected = client.get(
                "/api/v1/exchange/api/v1/integrations/connections",
                headers={
                    "X-Cyrene-Product-Authorization": f"Bearer {wrong_token}",
                    "X-Cyrene-Workspace-Id": product_workspace,
                },
            )
            assert rejected.status_code == 401
            assert captured[-1]["authorization"] == f"Bearer {wrong_token}"
            assert wrong_token not in rejected.text

            control_authorization = "Bearer control-session-token"
            connections = client.get(
                "/api/v1/exchange/api/v1/integrations/connections",
                headers={**product_headers, "Authorization": control_authorization},
            )
            assert connections.status_code == 200
            connection_request = captured[-1]
            assert connection_request["path"] == "/api/v1/integrations/connections"
            assert connection_request["authorization"] == f"Bearer {product_token}"
            assert connection_request["workspace"] == product_workspace
            assert connection_request["productAuthorization"] is None
            assert connection_request["cookie"] is None
            assert control_authorization not in connections.text

            legacy_chat = client.post(
                "/api/v1/exchange/v1/chat/completions",
                headers={
                    **csrf,
                    "Accept": "text/event-stream",
                    "Content-Type": "application/json",
                },
                json={"stream": True},
            )
            assert legacy_chat.status_code == 200
            assert legacy_chat.text == 'data: {"choices":[]}\n\ndata: [DONE]\n\n'
            legacy_chat_request = captured[-1]
            assert legacy_chat_request["path"] == "/v1/chat/completions"
            assert legacy_chat_request["authorization"] is None
            assert legacy_chat_request["workspace"] is None
            assert legacy_chat_request["productAuthorization"] is None

            before_csrf = len(captured)
            csrf_rejected = client.post(
                "/api/v1/exchange/api/v1/integrations/notifications/n1/ack",
                headers=product_headers,
                json={},
            )
            assert csrf_rejected.status_code == 403
            assert csrf_rejected.json()["code"] == "NAVIGATOR_CSRF_INVALID"
            assert len(captured) == before_csrf

            acknowledged = client.post(
                "/api/v1/exchange/api/v1/integrations/notifications/n1/ack",
                headers={**product_headers, **csrf},
                json={},
            )
            assert acknowledged.status_code == 200
            assert captured[-1]["path"] == "/api/v1/integrations/notifications/n1/ack"
            assert captured[-1]["authorization"] == f"Bearer {product_token}"
            assert captured[-1]["workspace"] == product_workspace

            renewal_started = client.post(
                "/api/v1/exchange/api/v1/accounts/authorizations/native-authref/renewal-sessions",
                headers={**product_headers, **csrf},
                json={},
            )
            assert renewal_started.status_code == 200
            assert captured[-1]["path"] == (
                "/api/v1/accounts/authorizations/native-authref/renewal-sessions"
            )

            renewal_status = client.get(
                "/api/v1/exchange/api/v1/accounts/renewal-sessions/7e1c50d2-b4f3-4d61-9302-9a0bd48d1991",
                headers=product_headers,
            )
            assert renewal_status.status_code == 200
            assert captured[-1]["path"] == (
                "/api/v1/accounts/renewal-sessions/7e1c50d2-b4f3-4d61-9302-9a0bd48d1991"
            )

            events = client.get(
                "/api/v1/exchange/api/v1/integrations/notifications/events",
                headers={
                    **product_headers,
                    "Accept": "text/event-stream",
                    "Last-Event-ID": "7",
                },
            )
            assert events.status_code == 200
            assert events.text == 'id: 8\ndata: {"kind":"authorization.required"}\n\n'
            assert captured[-1]["accept"] == "text/event-stream"
            assert captured[-1]["lastEventId"] == "7"
            assert captured[-1]["authorization"] == f"Bearer {product_token}"

            before_legacy_model = len(captured)
            legacy_model = client.get(
                "/api/v1/exchange/v1/models",
                headers={"Authorization": control_authorization},
            )
            assert legacy_model.status_code == 200
            assert captured[-1]["path"] == "/v1/models"
            assert captured[-1]["authorization"] is None
            assert captured[-1]["productAuthorization"] is None
            assert len(captured) == before_legacy_model + 1

            for legacy_path in ("/v1/embeddings", "/v1/responses"):
                legacy_response = client.post(
                    f"/api/v1/exchange{legacy_path}",
                    headers={**csrf, "Content-Type": "application/json"},
                    json={"model": "test"},
                )
                assert legacy_response.status_code == 200
                assert captured[-1]["path"] == legacy_path
                assert captured[-1]["authorization"] is None
                assert captured[-1]["workspace"] is None
                assert captured[-1]["productAuthorization"] is None

            before_product_to_model = len(captured)
            product_to_model = client.get(
                "/api/v1/exchange/v1/models",
                headers=product_headers,
            )
            assert product_to_model.status_code == 404
            assert product_to_model.json()["code"] == "NAVIGATOR_PRODUCT_AUTH_ROUTE_NOT_ALLOWED"
            assert len(captured) == before_product_to_model

            before_other_target = len(captured)
            other_target = client.get(
                "/api/v1/other/integrations/connections",
                headers={
                    **product_headers,
                    "Authorization": control_authorization,
                },
            )
            assert other_target.status_code == 404
            assert other_target.json()["code"] == "NAVIGATOR_PRODUCT_AUTH_ROUTE_NOT_ALLOWED"
            assert len(captured) == before_other_target

            before_gateway = len(captured)
            gateway_product = client.get(
                "/api/proxy/exchange-gateway/v1/models",
                headers=product_headers,
            )
            assert gateway_product.status_code == 404
            assert gateway_product.json()["code"] == "NAVIGATOR_PRODUCT_AUTH_ROUTE_NOT_ALLOWED"
            assert len(captured) == before_gateway

            gateway = client.post(
                "/api/proxy/exchange-gateway/v1/chat/completions",
                headers={
                    **csrf,
                    "Authorization": "Bearer exchange-gateway-key",
                    "Accept": "text/event-stream",
                    "Content-Type": "application/json",
                },
                json={"stream": True},
            )
            assert gateway.status_code == 200
            assert gateway.text == 'data: {"choices":[]}\n\ndata: [DONE]\n\n'
            gateway_request = captured[-1]
            assert len(captured) == before_gateway + 1
            assert gateway_request["path"] == "/v1/chat/completions"
            assert gateway_request["authorization"] == "Bearer exchange-gateway-key"
            assert gateway_request["workspace"] is None
            assert gateway_request["productAuthorization"] is None

            redirected = client.get(
                "/api/v1/exchange/api/v1/integrations/connections/7e1c50d2-b4f3-4d61-9302-9a0bd48d1991/authorization-health",
                headers=product_headers,
            )
            assert redirected.status_code == 502
            assert redirected.json()["code"] == "NAVIGATOR_PRODUCT_PROXY_REDIRECT_BLOCKED"
            assert "location" not in redirected.headers
            assert attacker_requests == []
    finally:
        if process.poll() is None:
            process.terminate()
        _stdout, stderr = process.communicate(timeout=5)
        assert product_token not in stderr
        exchange_server.shutdown()
        exchange_server.server_close()
        exchange_thread.join(timeout=5)
        attacker_server.shutdown()
        attacker_server.server_close()
        attacker_thread.join(timeout=5)


def test_web_launcher_banner_never_carries_the_pairing_secret() -> None:
    """The launcher's output is redirected into a log file, so it must not leak.

    中文:启动器的输出已重定向到日志文件,因此不得泄露密钥。
    """
    # 中文:启动器输出会重定向到日志文件,因此不得泄漏 pairing secret。

    repository = Path(__file__).parents[1]
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        [str(repository / "src"), environment.get("PYTHONPATH", "")]
    )
    process = subprocess.Popen(
        [
            sys.executable,
            str(repository / "scripts" / "serve-web.py"),
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--pairing-code",
            "stdout-pairing-code",
            "--insecure-http",
        ],
        cwd=repository,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None
    try:
        line = process.stdout.readline()
        assert line
        banner = json.loads(line)
        assert banner["service"] == "cyrene-web-host"
        assert banner["port"] > 0
        assert "pairingCode" not in banner
        assert "pairingCodeFile" in banner
        assert "stdout-pairing-code" not in line
    finally:
        process.terminate()
        stdout, stderr = process.communicate(timeout=5)
    assert stdout == ""
    assert "stdout-pairing-code" not in stderr


def test_web_launcher_stores_a_self_generated_code_owner_only(tmp_path: Path) -> None:
    """A launcher that generates the code itself must not print it.

    中文:启动器自行生成 pairing code 时,绝不能将其打印出来。
    """
    # 中文:启动器自行生成 code 时不得打印它。

    repository = Path(__file__).parents[1]
    code_file = tmp_path / "nested" / "pair_code.txt"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        [str(repository / "src"), environment.get("PYTHONPATH", "")]
    )
    process = subprocess.Popen(
        [
            sys.executable,
            str(repository / "scripts" / "serve-web.py"),
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--pairing-code-file",
            str(code_file),
            "--insecure-http",
        ],
        cwd=repository,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None
    try:
        line = process.stdout.readline()
        assert line
        banner = json.loads(line)
        assert banner["pairingCodeFile"] == str(code_file)
    finally:
        process.terminate()
        process.communicate(timeout=5)

    assert code_file.stat().st_mode & 0o777 == 0o600
    stored = code_file.read_text(encoding="utf-8").strip()
    assert len(stored) >= 16
    assert stored not in line


def test_web_launcher_refuses_to_generate_a_code_it_cannot_store(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fail closed instead of emitting a secret with nowhere to keep it.

    中文:无法安全存储密钥时应 fail closed,不能输出密钥。
    """
    # 中文:没有安全存放位置时必须 fail-closed,不能输出秘密。

    repository = Path(__file__).parents[1]
    environment = os.environ.copy()
    environment.pop("CYRENE_PAIR_CODE_FILE", None)
    environment["PYTHONPATH"] = os.pathsep.join(
        [str(repository / "src"), environment.get("PYTHONPATH", "")]
    )
    result = subprocess.run(
        [
            sys.executable,
            str(repository / "scripts" / "serve-web.py"),
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--insecure-http",
        ],
        cwd=repository,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert result.returncode != 0
    assert "--pairing-code-file" in result.stderr


def test_web_host_system_status_and_env_pairing_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CYRENE_WEB_HOST_PAIR_CODE", "env-pair-code-123456")
    app = create_web_host_app(proxy_targets={"/api/v1/test": "http://127.0.0.1:9999"})
    with TestClient(app) as client:
        # Pairing code read from env
        # 中文:从环境变量读取 pairing code。
        pair_resp = client.post("/api/v1/auth/pair", json={"pairingCode": "env-pair-code-123456"})
        assert pair_resp.status_code == 200

        # System status contains gpu, disk, and services
        # 中文:System status 包含 GPU、磁盘和服务信息。
        status_resp = client.get("/api/v1/system/status")
        assert status_resp.status_code == 200
        data = status_resp.json()
        assert data["status"] == "ok"
        assert "gpu" in data
        assert "disk" in data
        assert "services" in data
        assert len(data["services"]) == 1
        assert data["services"][0]["name"] == "test"
        assert data["services"][0]["status"] == "DOWN"


def test_expired_pairing_code_is_rejected() -> None:
    """配对码超过 15 分钟时返回 410，错误消息不区分过期 vs 已消费。"""
    issued_16min_ago = time.time() - 960
    app = create_web_host_app(pairing_code="123456", pairing_code_issued_at=issued_16min_ago)
    with TestClient(app) as client:
        resp = client.post("/api/v1/auth/pair", json={"pairingCode": "123456"})
        assert resp.status_code == 410
        assert resp.json()["code"] == "NAVIGATOR_PAIR_CODE_EXPIRED"
        assert resp.json()["detail"] == "The pairing code is invalid or has already been used."


def test_pairing_code_consumed_after_first_use() -> None:
    """配对码首次消费后再次使用返回 410 (当配置 issued_at) 或 401。"""
    app = create_web_host_app(pairing_code="test-consumed-code", pairing_code_issued_at=time.time())
    with TestClient(app) as client:
        first = client.post("/api/v1/auth/pair", json={"pairingCode": "test-consumed-code"})
        assert first.status_code == 200
        second = client.post("/api/v1/auth/pair", json={"pairingCode": "test-consumed-code"})
        assert second.status_code == 410
        assert second.json()["code"] == "NAVIGATOR_PAIR_CODE_CONSUMED"
        assert second.json()["detail"] == "The pairing code is invalid or has already been used."


def test_csrf_mutation_blocked_without_header() -> None:
    """确认已有 CSRF 防护在缺少 X-CSRF-Token 时拒绝写操作。"""
    app = create_web_host_app(pairing_code=PAIRING_CODE)
    with TestClient(app) as client:
        _login(client)
        resp = client.post(
            "/api/v1/credentials", json={"name": "test", "provider": "generic", "secret": "sec"}
        )
        assert resp.status_code == 403
        assert resp.json()["code"] == "NAVIGATOR_CSRF_INVALID"


def test_proxy_rejects_path_traversal() -> None:
    """proxy 拒绝包含 .. 或 //authority 的路径。"""
    app = create_web_host_app(
        pairing_code=PAIRING_CODE,
        proxy_targets={"/api/proxy/yield": "http://127.0.0.1:8001"},
    )
    with TestClient(app) as client:
        _login(client)
        resp1 = client.get("/api/proxy/yield/../../../etc/passwd")
        assert resp1.status_code in (400, 404)
        resp2 = client.get("/api/proxy/yield//evil.com/test")
        assert resp2.status_code in (400, 404)


def test_credential_secret_never_returned() -> None:
    """create + get + list 全部不返回 secret 字段。"""
    app = create_web_host_app(pairing_code=PAIRING_CODE)
    with TestClient(app) as client:
        csrf = _login(client)
        created = client.post(
            "/api/v1/credentials",
            json={"name": "API Token", "provider": "openai", "secret": "super_secret_token_12345"},
            headers=csrf,
        )
        assert created.status_code == 201
        data = created.json()
        assert "secret" not in data
        assert "super_secret_token_12345" not in created.text

        fetched = client.get(f"/api/v1/credentials/{data['id']}")
        assert fetched.status_code == 200
        assert "secret" not in fetched.json()
        assert "super_secret_token_12345" not in fetched.text

        listed = client.get("/api/v1/credentials")
        assert listed.status_code == 200
        assert all("secret" not in item for item in listed.json())
        assert "super_secret_token_12345" not in listed.text


def test_hf_token_not_echoed_in_any_response() -> None:
    """创建含 secret 的 credential，所有相关接口均不返回 secret 明文。"""
    token_val = "hf_PnbVXZQkRlwE9m8473sdu"
    app = create_web_host_app(pairing_code=PAIRING_CODE)
    with TestClient(app) as client:
        csrf = _login(client)
        created = client.post(
            "/api/v1/credentials",
            json={"name": "HF Token", "provider": "huggingface", "secret": token_val},
            headers=csrf,
        )
        assert created.status_code == 201
        assert token_val not in created.text
        cred_id = created.json()["id"]

        list_resp = client.get("/api/v1/credentials")
        assert token_val not in list_resp.text

        get_resp = client.get(f"/api/v1/credentials/{cred_id}")
        assert token_val not in get_resp.text


def test_active_route_session_lifecycle() -> None:
    """会话级 active route 存取与 404 测试。"""
    app = create_web_host_app(pairing_code=PAIRING_CODE)
    with TestClient(app) as client:
        csrf = _login(client)
        # Not configured yet -> 404
        # 中文:尚未配置 -> 404。
        assert client.get("/api/v1/navigator/active-route").status_code == 404

        # Set active route
        # 中文:设置活动路由。
        payload = {
            "gatewayEndpointId": "ge-123",
            "modelId": "qwen2.5-7b",
            "baseUrl": "http://127.0.0.1:8003/v1",
            "apiKeyHint": "cyk_...9abc",
        }
        set_resp = client.post("/api/v1/navigator/active-route", json=payload, headers=csrf)
        assert set_resp.status_code == 200

        # Read back
        # 中文:读回验证。
        get_resp = client.get("/api/v1/navigator/active-route")
        assert get_resp.status_code == 200
        assert get_resp.json()["modelId"] == "qwen2.5-7b"
        assert get_resp.json()["baseUrl"] == "http://127.0.0.1:8003/v1"


def test_system_status_publishes_bootstrap_runtime_and_degradation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A console needs to know the pinned runtime state without guessing.

    中文:控制台需要读取固定版本的运行时状态,不能靠猜测。
    """
    # 中文:控制台需要获知固定 runtime 的状态,不能靠猜测。

    install_root = tmp_path / "cyrene-install"
    install_root.mkdir()
    (install_root / "release-lock.json").write_text(
        json.dumps(
            {
                "engines": {
                    "training.llama-factory.v1": {
                        "package": "llamafactory",
                        "acceptedVersion": "0.9.5",
                    },
                    "execution.engine.v1": {"package": "vllm", "acceptedVersion": "0.25.1"},
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("CYRENE_INSTALL_ROOT", str(install_root))
    monkeypatch.setenv("CYRENE_CUDA_PROFILE", "cu130")
    monkeypatch.delenv("CYRENE_BOOTSTRAP_STATE", raising=False)

    app = create_web_host_app(pairing_code=PAIRING_CODE)
    with TestClient(app) as client:
        first = client.get("/api/v1/system/status").json()
        # Pins are known but no bootstrap marker exists yet.
        # 中文:已知上游 pin,但尚无 bootstrap 标记。
        assert first["bootstrapState"]["state"] == "PENDING"
        assert first["runtime"]["engines"] == {"llamafactory": "0.9.5", "vllm": "0.25.1"}
        assert first["runtime"]["cudaProfile"] == "cu130"
        assert first["diagnosticsDegraded"] is False

        (install_root / "bootstrap-state.json").write_text(
            json.dumps(
                {
                    "state": "READY",
                    "completedAt": "2026-09-22T00:00:00Z",
                    "digest": "sha256:abc",
                }
            ),
            encoding="utf-8",
        )
        second = client.get("/api/v1/system/status").json()
        assert second["bootstrapState"]["state"] == "READY"
        assert second["bootstrapState"]["completedAt"] == "2026-09-22T00:00:00Z"
        # No secrets from the install root are echoed back.
        # 中文:不会回显安装根目录中的任何秘密。
        assert "digest" not in second["bootstrapState"]


def test_unreachable_product_marks_diagnostics_degraded() -> None:
    app = create_web_host_app(
        pairing_code=PAIRING_CODE,
        proxy_targets={"/api/v1/yield": "http://127.0.0.1:59999"},
    )
    with TestClient(app) as client:
        body = client.get("/api/v1/system/status").json()
    assert [entry["status"] for entry in body["services"]] == ["DOWN"]
    assert body["diagnosticsDegraded"] is True
