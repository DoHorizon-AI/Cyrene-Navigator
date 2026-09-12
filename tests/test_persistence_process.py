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
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import httpx

BASE = "/api/v1/harness/workspaces/w1/sessions"
TOKEN = "process-alice-token"


def _start_service(db_path: Path, config_path: Path) -> tuple[subprocess.Popen[str], str]:
    """Start the configured service and return its advertised loopback URL. | 启动真实服务。"""

    repository = Path(__file__).parents[1]
    environment = os.environ.copy()
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
        base_url = f"http://{advertised['host']}:{advertised['port']}"
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
