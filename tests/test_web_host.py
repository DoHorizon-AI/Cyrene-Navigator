"""Focused Web Host authentication, credential, proxy, and launcher tests."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from cyrene_navigator.web_host import create_web_host_app

PAIRING_CODE = "pairing-code-for-tests"
SECRET = "hf_test_secret_value"


def _login(client: TestClient) -> dict[str, str]:
    """Pair one test client and return the browser CSRF header."""

    response = client.post("/api/v1/auth/pair", json={"pairingCode": PAIRING_CODE})
    assert response.status_code == 200, response.text
    return {"X-CSRF-Token": response.json()["csrfToken"]}


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


def test_web_launcher_banner_never_carries_the_pairing_secret() -> None:
    """The launcher's output is redirected into a log file, so it must not leak."""

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
    """A launcher that generates the code itself must not print it."""

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
    """Fail closed instead of emitting a secret with nowhere to keep it."""

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
        pair_resp = client.post("/api/v1/auth/pair", json={"pairingCode": "env-pair-code-123456"})
        assert pair_resp.status_code == 200

        # System status contains gpu, disk, and services
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
        assert client.get("/api/v1/navigator/active-route").status_code == 404

        # Set active route
        payload = {
            "gatewayEndpointId": "ge-123",
            "modelId": "qwen2.5-7b",
            "baseUrl": "http://127.0.0.1:8003/v1",
            "apiKeyHint": "cyk_...9abc",
        }
        set_resp = client.post("/api/v1/navigator/active-route", json=payload, headers=csrf)
        assert set_resp.status_code == 200

        # Read back
        get_resp = client.get("/api/v1/navigator/active-route")
        assert get_resp.status_code == 200
        assert get_resp.json()["modelId"] == "qwen2.5-7b"
        assert get_resp.json()["baseUrl"] == "http://127.0.0.1:8003/v1"


def test_system_status_publishes_bootstrap_runtime_and_degradation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A console needs to know the pinned runtime state without guessing."""

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
