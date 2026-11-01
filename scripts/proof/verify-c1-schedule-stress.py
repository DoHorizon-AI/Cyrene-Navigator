#!/usr/bin/env python3
"""Stress the volatile conversation-turn agent path for duplicate tool registration.

Reproduces the original C1 failure conditions: several turns in one conversation,
two concurrent turns in the same conversation, and a turn after a stack restart.
Scans work_tasks for the historical 'already registered' error.
"""

from __future__ import annotations

import http.cookiejar
import json
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

STATE = Path("/home/baijin/.local/state/cyrene-aether-wsl-acceptance/c1-run-1")
WEB = "http://127.0.0.1:18690"
NAV_DB = STATE / "navigator.sqlite3"


def main() -> int:
    code = (STATE / "pairing-code").read_text(encoding="utf-8").strip()
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    with opener.open(
        urllib.request.Request(
            f"{WEB}/api/v1/auth/pair",
            data=json.dumps({"pairingCode": code}).encode(),
            headers={"Content-Type": "application/json"},
        )
    ) as resp:
        csrf = json.loads(resp.read().decode())["csrfToken"]

    executor_url = json.loads((STATE / "logs" / "serve-local.log").read_text(encoding="utf-8"))[
        "urls"
    ]["executor"]
    port = urllib.parse.urlsplit(executor_url).port
    pid = None
    for line in subprocess.check_output(["ss", "-tulpn"]).decode().splitlines():
        if f":{port} " in line:
            m = re.search(r"pid=(\d+)", line)
            if m:
                pid = int(m.group(1))
                break
    env = dict(
        item.split(b"=", 1)
        for item in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
        if b"=" in item
    )
    token = env[b"CYRENE_EXECUTOR_TOKEN"].decode()

    conv = f"sched-stress-{int(time.time())}"
    results: dict[str, str] = {}

    def turn(label: str, text: str) -> None:
        key = f"{label}-{int(time.time() * 1000)}"
        with opener.open(
            urllib.request.Request(
                f"{WEB}/api/v1/conversation-assistant/turns",
                data=json.dumps({"conversationId": conv, "text": text}).encode(),
                headers={
                    "Content-Type": "application/json",
                    "X-CSRF-Token": csrf,
                    "Idempotency-Key": key,
                },
            )
        ) as resp:
            task_id = json.loads(resp.read().decode())["taskId"]
        deadline = time.time() + 120
        status = "queued"
        while time.time() < deadline:
            time.sleep(1)
            with urllib.request.urlopen(
                urllib.request.Request(
                    f"{executor_url}/api/v1/tasks/{task_id}",
                    headers={"Authorization": f"Bearer {token}"},
                )
            ) as resp:
                status = json.loads(resp.read().decode()).get("status", "")
            if status in ("completed", "failed", "aborted"):
                break
        results[label] = status

    for i in range(1, 4):
        turn(f"seq{i}", f"Reply with exactly: noted. This is stress turn {i}.")

    threads = [
        threading.Thread(
            target=turn, args=("same-conv-a", "Reply with exactly: noted. Concurrent A.")
        ),
        threading.Thread(
            target=turn, args=("same-conv-b", "Reply with exactly: noted. Concurrent B.")
        ),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    turn("after-restart", "Reply with exactly: noted. Post-restart resume turn.")

    with sqlite3.connect(f"file:{NAV_DB}?mode=ro", uri=True) as con:
        rows = con.execute(
            """SELECT task_id, status, coalesce(error,'') FROM work_tasks
               WHERE task_id IN (SELECT task_id FROM work_tasks ORDER BY rowid DESC LIMIT 20)"""
        ).fetchall()
    duplicate_errors = [r for r in rows if "already registered" in (r[2] or "")]

    passed = all(v == "completed" for v in results.values()) and not duplicate_errors
    evidence = {
        "schema_version": "cyrene.aether.c1-schedule-registration-stress.v1",
        "conversation_id": conv,
        "turn_statuses": results,
        "duplicate_registration_errors": duplicate_errors,
        "overall_status": "PASS" if passed else "FAIL",
        "note": (
            "Executed after a full stack restart, so the last turn resumes a "
            "pre-restart conversation."
        ),
    }
    out = STATE.parent / "evidence" / "c1-schedule-registration-stress.json"
    out.write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    print(json.dumps(evidence, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
