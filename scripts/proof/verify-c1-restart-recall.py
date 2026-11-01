#!/usr/bin/env python3
"""Check that a conversation episode memory is recalled after a full stack restart.

Phase "pre" records the newest active episode memory; phase "post" runs after the
Navigator stack has been restarted and must observe that memory cited by the next
assistant turn. Inputs are synthetic, credentials come from runtime files.
"""

from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import json
import re
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=("pre", "post"), required=True)
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=Path("/home/baijin/.local/state/cyrene-aether-wsl-acceptance/c1-run-1"),
    )
    parser.add_argument("--target-file", type=Path, default=Path("/tmp/c1-restart-target.json"))
    parser.add_argument(
        "--evidence-file",
        type=Path,
        default=Path(
            "/home/baijin/.local/state/cyrene-aether-wsl-acceptance/evidence/c1-restart-recall.json"
        ),
    )
    args = parser.parse_args()

    state_dir = args.state_dir.resolve()
    memory_db = state_dir / "navigator.sqlite3.conversation-memory.sqlite3"
    navigator_db = state_dir / "navigator.sqlite3"
    web_url = "http://127.0.0.1:18690"

    if args.phase == "pre":
        with sqlite3.connect(f"file:{memory_db}?mode=ro", uri=True) as con:
            row = con.execute(
                """SELECT conversation_id, memory_id, length(text), text
                   FROM conversation_memory_items
                   WHERE memory_kind='episode' AND state='active'
                   ORDER BY rowid DESC LIMIT 1"""
            ).fetchone()
        if row is None:
            print("no active episode memory found", file=sys.stderr)
            return 1
        target: dict[str, Any] = {
            "conversation_id": row[0],
            "memory_id": row[1],
            "memory_length": row[2],
            "memory_sha256": hashlib.sha256(row[3].encode()).hexdigest(),
            "memory_excerpt": row[3][:80],
            "recorded_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        args.target_file.write_text(json.dumps(target, indent=2), encoding="utf-8")
        print(json.dumps(target, indent=2))
        return 0

    target = json.loads(args.target_file.read_text(encoding="utf-8"))
    conversation_id = target["conversation_id"]
    memory_id = target["memory_id"]

    pairing_code = (state_dir / "pairing-code").read_text(encoding="utf-8").strip()
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    pair = urllib.request.Request(
        f"{web_url}/api/v1/auth/pair",
        data=json.dumps({"pairingCode": pairing_code}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with opener.open(pair) as resp:
        csrf = json.loads(resp.read().decode())["csrfToken"]

    prompt = "Using only saved conversation memory, recall this note: " + target["memory_excerpt"]
    turn = urllib.request.Request(
        f"{web_url}/api/v1/conversation-assistant/turns",
        data=json.dumps({"conversationId": conversation_id, "text": prompt}).encode(),
        headers={
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
            "Idempotency-Key": f"restart-recall-{int(time.time())}",
        },
    )
    with opener.open(turn) as resp:
        admitted = json.loads(resp.read().decode())
        task_id = admitted["taskId"]

    executor_url = json.loads((state_dir / "logs" / "serve-local.log").read_text(encoding="utf-8"))[
        "urls"
    ]["executor"]
    exec_port = urllib.parse.urlsplit(executor_url).port
    exec_pid = None
    for line in subprocess.check_output(["ss", "-tulpn"]).decode().splitlines():
        if f":{exec_port} " in line:
            match = re.search(r"pid=(\d+)", line)
            if match:
                exec_pid = int(match.group(1))
                break
    if exec_pid is None:
        print("executor pid not found", file=sys.stderr)
        return 1
    with open(f"/proc/{exec_pid}/environ", "rb") as handle:
        exec_env = dict(item.split(b"=", 1) for item in handle.read().split(b"\0") if b"=" in item)
    executor_token = exec_env[b"CYRENE_EXECUTOR_TOKEN"].decode()

    status = "queued"
    deadline = time.time() + 120
    while time.time() < deadline:
        time.sleep(1)
        with urllib.request.urlopen(
            urllib.request.Request(
                f"{executor_url}/api/v1/tasks/{task_id}",
                headers={"Authorization": f"Bearer {executor_token}"},
            )
        ) as resp:
            status = json.loads(resp.read().decode()).get("status", "")
        if status in ("completed", "failed", "aborted"):
            break

    with sqlite3.connect(f"file:{memory_db}?mode=ro", uri=True) as con:
        refs_json, message_id = con.execute(
            """SELECT source_refs_json, message_id FROM conversation_memory_messages
               WHERE conversation_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1""",
            (conversation_id,),
        ).fetchone()
    refs = json.loads(refs_json)
    cited = any(ref.get("memoryId") == memory_id for ref in refs)

    with sqlite3.connect(f"file:{navigator_db}?mode=ro", uri=True) as con:
        error = con.execute(
            "SELECT coalesce(error,'') FROM work_tasks WHERE task_id=?", (task_id,)
        ).fetchone()
    core_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT).decode().strip()
    git_status = (
        subprocess.check_output(["git", "status", "--short"], cwd=REPO_ROOT).decode().strip()
    )

    evidence = {
        "schema_version": "cyrene.aether.c1-restart-recall.v1",
        "classification": "REAL_SERVICE_API_AFTER_RESTART",
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "core_sha": core_sha,
        "git_status_clean": len(git_status) == 0,
        "conversation_id": conversation_id,
        "target_memory_id": memory_id,
        "target_memory_sha256": target["memory_sha256"],
        "task_id": task_id,
        "task_status": status,
        "task_error": (error or [""])[0][:120],
        "cited_memory_ids": [ref.get("memoryId") for ref in refs if ref.get("memoryId")],
        "cites_target_memory": cited,
        "assistant_message_id": message_id,
    }
    passed = status == "completed" and cited
    evidence["overall_status"] = "PASS" if passed else "FAIL"
    args.evidence_file.parent.mkdir(parents=True, exist_ok=True)
    args.evidence_file.write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    print(json.dumps(evidence, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
