"""
┌─────────────────────────────────────────────────────────────────────┐
│  Test: real Navigator persistence process                            │
│  Scope: ASGI process startup, HTTP writes, and process restart.      │
│                                                                     │
│  测试职责：通过真实 uvicorn 进程验证服务工厂与 SQLite 重启恢复。            │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

BASE = "/api/v1/harness/workspaces/w1/sessions"
WORK_BASE = "/api/v1/workspaces/w1/work"
TOKEN = "process-alice-token"


def _start_service(
    db_path: Path,
    config_path: Path,
    *,
    tls_cert_file: Path | None = None,
    tls_key_file: Path | None = None,
) -> tuple[subprocess.Popen[str], str]:
    """Start the configured service and return its advertised loopback URL. | 启动真实服务。"""

    repository = Path(__file__).parents[1]
    environment = os.environ.copy()
    environment.pop("CYRENE_PERSISTENCE_TLS_CERT_FILE", None)
    environment.pop("CYRENE_PERSISTENCE_TLS_KEY_FILE", None)
    if tls_cert_file is not None:
        environment["CYRENE_PERSISTENCE_TLS_CERT_FILE"] = str(tls_cert_file)
    if tls_key_file is not None:
        environment["CYRENE_PERSISTENCE_TLS_KEY_FILE"] = str(tls_key_file)
    environment["PERSISTENCE_TEST_TOKEN"] = TOKEN
    environment["PYTHONPATH"] = os.pathsep.join(
        [str(repository / "src"), environment.get("PYTHONPATH", "")]
    )
    process = subprocess.Popen(
        [
            sys.executable,
            str(repository / "scripts" / "serve-persistence.py"),
            "--database",
            str(db_path),
            "--principal-config",
            str(config_path),
            "--host",
            "127.0.0.1",
            "--port",
            "0",
        ],
        cwd=repository,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None
    banner_queue: queue.Queue[str] = queue.Queue()

    def read_banner() -> None:
        """Read the one startup banner without blocking the test thread. | 异步读取启动信息。"""

        assert process.stdout is not None
        banner_queue.put(process.stdout.readline())

    threading.Thread(target=read_banner, daemon=True).start()
    try:
        banner = banner_queue.get(timeout=10)
    except queue.Empty as exc:
        _stop_service(process)
        stderr = process.stderr.read() if process.stderr is not None else ""
        raise AssertionError(f"persistence service did not start: {stderr}") from exc
    if not banner:
        stderr = process.stderr.read() if process.stderr is not None else ""
        _stop_service(process)
        raise AssertionError(f"persistence service exited before startup: {stderr}")
    try:
        advertised = json.loads(banner)
        scheme = advertised.get("scheme", "http")
        base_url = f"{scheme}://{advertised['host']}:{advertised['port']}"
        _wait_until_ready(process, base_url)
    except BaseException:
        _stop_service(process)
        raise
    return process, base_url


def _wait_until_ready(process: subprocess.Popen[str], base_url: str) -> None:
    """Wait until the real listener accepts an HTTP request. | 等待真实监听器就绪。"""

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stderr = process.stderr.read() if process.stderr is not None else ""
            raise AssertionError(f"persistence service exited during startup: {stderr}")
        try:
            response = httpx.get(f"{base_url}{BASE}", timeout=0.5)
            if response.status_code == 401:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.05)
    raise AssertionError("persistence service did not accept HTTP traffic")


def _stop_service(process: subprocess.Popen[str]) -> None:
    """Stop a child service and retain bounded cleanup. | 有界清理子进程。"""

    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if process.stdout is not None:
        process.stdout.close()
    if process.stderr is not None:
        process.stderr.close()


def test_real_http_process_restart_recovers_committed_events(tmp_path: Path) -> None:
    """A real service process writes, stops, and recovers its committed log. | 进程重启恢复。"""

    db_path = tmp_path / "process.db"
    config_path = tmp_path / "principals.json"
    config_path.write_text(
        json.dumps(
            {
                "principals": [
                    {
                        "token_env": "PERSISTENCE_TEST_TOKEN",
                        "actor_id": "alice",
                        "workspace_ids": ["w1"],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    first_process, first_url = _start_service(db_path, config_path)
    headers = {"Authorization": f"Bearer {TOKEN}"}
    header: dict[str, Any] = {
        "version": 2,
        "id": "process-session",
        "createdAt": 1_783_000_000_000,
        "isSeeded": False,
    }
    try:
        with httpx.Client(base_url=first_url, headers=headers, timeout=5) as client:
            created = client.post(
                BASE,
                json={"header": header, "inheritedEventCount": 0, "clientId": "process-client"},
            )
            assert created.status_code == 200, created.text
            handle = created.json()
            event = {"seq": 0, "time": 1_783_000_000_001, "type": "fixture/event", "data": {}}
            appended = client.post(
                f"{BASE}/{handle['id']}/append",
                json={
                    "writerToken": handle["writerToken"],
                    "epoch": handle["epoch"],
                    "batchId": "process-batch",
                    "events": [event],
                },
            )
            assert appended.status_code == 200
            assert appended.json() == {"nextSeq": 1}
            flushed = client.post(
                f"{BASE}/{handle['id']}/flush",
                json={"writerToken": handle["writerToken"], "epoch": handle["epoch"]},
            )
            assert flushed.status_code == 200
    finally:
        _stop_service(first_process)

    second_process, second_url = _start_service(db_path, config_path)
    try:
        with httpx.Client(base_url=second_url, headers=headers, timeout=5) as client:
            recovered = client.get(f"{BASE}/process-session/events?offset=0&length=10")
            assert recovered.status_code == 200
            assert recovered.json() == {"events": [event], "nextSeq": 1}
            continued = {
                "seq": 1,
                "time": 1_783_000_000_002,
                "type": "fixture/event",
                "data": {"afterRestart": True},
            }
            appended_after_restart = client.post(
                f"{BASE}/process-session/append",
                json={
                    "writerToken": handle["writerToken"],
                    "epoch": handle["epoch"],
                    "batchId": "process-batch-after-restart",
                    "events": [continued],
                },
            )
            assert appended_after_restart.status_code == 200
            assert appended_after_restart.json() == {"nextSeq": 2}
    finally:
        _stop_service(second_process)


def test_service_principal_flag_authorizes_only_the_credential_health_route(tmp_path: Path) -> None:
    """The mounted principal config preserves the narrow health publisher grant."""

    config_path = tmp_path / "credential-health-principals.json"
    config_path.write_text(
        json.dumps(
            {
                "principals": [
                    {
                        "token_env": "PERSISTENCE_TEST_TOKEN",
                        "actor_id": "navigator-service",
                        "organization_id": "org-health",
                        "workspace_ids": ["w1"],
                        "can_publish_credential_health": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    process, url = _start_service(tmp_path / "credential-health.db", config_path)
    headers = {"Authorization": f"Bearer {TOKEN}"}
    checked_at = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    try:
        with httpx.Client(base_url=url, headers=headers, timeout=5) as client:
            response = client.post(
                WORK_BASE + "/credential-health/snapshots",
                json={
                    "organizationId": "org-health",
                    "connections": [
                        {
                            "connectionId": "22222222-2222-4222-8222-222222222222",
                            "provider": "hf",
                            "loginState": "PRESENT",
                            "authorizationState": "VALID",
                            "checkedAt": checked_at,
                            "expiresAt": None,
                            "generation": 1,
                            "capabilities": [],
                            "reasonCode": None,
                        }
                    ],
                },
            )
        assert response.status_code == 200, response.text
        assert response.json() == {"processed": 1, "stale": 0, "notificationsQueued": 0}
    finally:
        _stop_service(process)


def test_real_tls_process_accepts_httpx_and_node_clients(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Serve real HTTPS and verify both configured HTTPX and Node CA trust paths."""

    openssl = shutil.which("openssl")
    if openssl is None:
        pytest.skip("OpenSSL is required to generate an ephemeral TLS test certificate")
    certificate, private_key = _generate_tls_pair(tmp_path, openssl, "navigator")
    monkeypatch.setenv("SSL_CERT_FILE", str(certificate))

    config_path = tmp_path / "tls-principals.json"
    config_path.write_text(
        json.dumps(
            {
                "principals": [
                    {
                        "token_env": "PERSISTENCE_TEST_TOKEN",
                        "actor_id": "alice",
                        "workspace_ids": ["w1"],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    process, base_url = _start_service(
        tmp_path / "tls-process.db",
        config_path,
        tls_cert_file=certificate,
        tls_key_file=private_key,
    )
    assert base_url.startswith("https://")
    try:
        with httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bearer {TOKEN}"},
            timeout=5,
        ) as client:
            created = client.post(
                BASE,
                json={
                    "header": {
                        "version": 2,
                        "id": "tls-session",
                        "createdAt": 1_783_000_000_000,
                        "isSeeded": False,
                    },
                    "inheritedEventCount": 0,
                    "clientId": "tls-client",
                },
            )
            assert created.status_code == 200, created.text

        node = shutil.which("node")
        if node is not None:
            node_environment = os.environ.copy()
            node_environment["NODE_EXTRA_CA_CERTS"] = str(certificate)
            node_environment["NAVIGATOR_TEST_TLS_URL"] = f"{base_url}/readyz"
            result = subprocess.run(
                [
                    node,
                    "--input-type=module",
                    "--eval",
                    "const response = await fetch(process.env.NAVIGATOR_TEST_TLS_URL); "
                    "if (!response.ok) process.exitCode = 1;",
                ],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
                env=node_environment,
            )
            assert result.returncode == 0, result.stderr
    finally:
        _stop_service(process)


def test_persistence_tls_configuration_fails_closed_for_partial_or_invalid_pairs(
    tmp_path: Path,
) -> None:
    """Reject partial TLS configuration and paths before publishing a listener."""

    openssl = shutil.which("openssl")
    if openssl is None:
        pytest.skip("OpenSSL is required to generate an ephemeral TLS test certificate")
    certificate, private_key = _generate_tls_pair(tmp_path, openssl, "invalid-pair")
    _other_certificate, other_private_key = _generate_tls_pair(tmp_path, openssl, "mismatched-pair")
    config_path = tmp_path / "invalid-tls-principals.json"
    config_path.write_text(
        json.dumps(
            {
                "principals": [
                    {
                        "token_env": "PERSISTENCE_TEST_TOKEN",
                        "actor_id": "alice",
                        "workspace_ids": ["w1"],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(AssertionError, match="must be configured together"):
        _start_service(
            tmp_path / "partial-tls.db",
            config_path,
            tls_cert_file=certificate,
        )
    with pytest.raises(AssertionError, match="invalid or unreadable"):
        _start_service(
            tmp_path / "invalid-tls.db",
            config_path,
            tls_cert_file=tmp_path / "missing-cert.pem",
            tls_key_file=private_key,
        )
    with pytest.raises(AssertionError, match="invalid or unreadable"):
        _start_service(
            tmp_path / "mismatched-tls.db",
            config_path,
            tls_cert_file=certificate,
            tls_key_file=other_private_key,
        )


def _generate_tls_pair(directory: Path, openssl: str, prefix: str) -> tuple[Path, Path]:
    """Generate a short-lived test CA/server certificate for the loopback listener."""

    certificate = directory / f"{prefix}-cert.pem"
    private_key = directory / f"{prefix}-key.pem"
    subprocess.run(
        [
            openssl,
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(private_key),
            "-out",
            str(certificate),
            "-days",
            "1",
            "-subj",
            "/CN=127.0.0.1",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,digitalSignature,keyCertSign,keyEncipherment",
            "-addext",
            "extendedKeyUsage=serverAuth",
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=True,
    )
    return certificate, private_key
