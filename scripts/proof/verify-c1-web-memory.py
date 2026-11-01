#!/usr/bin/env python3
"""
┌────────────────────────────────────────────────────────────────────────────┐
│  📄 verify-c1-web-memory.py                                                │
│  Module: scripts.proof.verify-c1-web-memory                                │
│  Role: Deterministic automated proof for Task Card C1:                      │
│        - Real model turn delivery (Qwen2.5-0.5B via Exchange)              │
│        - Concurrency=2 and same-key idempotency                            │
│        - Auto model summary (>=8 unarchived messages and >=3200 chars)     │
│        - Vector recall and context injection in assistant sourceRefs       │
│        - Memory deletion and source revocation cascading exclusion         │
│        - Turn cancellation discarding late results                         │
│        - Actor / persona boundary isolation                                │
│                                                                            │
│  All inputs are synthetic. Credentials are read from runtime files/env.    │
└────────────────────────────────────────────────────────────────────────────┘
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
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, cast


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify C1 Web conversation memory lifecycle")
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=Path("/home/baijin/.local/state/cyrene-aether-wsl-acceptance/c1-run-1"),
        help="Path to navigator state directory",
    )
    parser.add_argument(
        "--evidence-file",
        type=Path,
        default=Path(
            "/home/baijin/.local/state/cyrene-aether-wsl-acceptance/evidence/"
            "c1-web-memory-real-acceptance.json"
        ),
        help="Target path for machine-readable JSON evidence",
    )
    args = parser.parse_args()

    state_dir = args.state_dir.resolve()
    navigator_db = state_dir / "navigator.sqlite3"
    memory_db = state_dir / "navigator.sqlite3.conversation-memory.sqlite3"
    pairing_file = state_dir / "pairing-code"
    log_file = state_dir / "logs" / "serve-local.log"

    if not log_file.is_file():
        print(f"Error: supervisor log not found at {log_file}", file=sys.stderr)
        return 1

    urls_info = json.loads(log_file.read_text(encoding="utf-8"))["urls"]
    web_url = "http://127.0.0.1:18690"
    persistence_url = urls_info["persistence"]
    executor_url = urls_info["executor"]

    print(f"Targeting Web: {web_url}, Persistence: {persistence_url}, Executor: {executor_url}")

    exec_port = int(urllib.parse.urlsplit(executor_url).port or 0)
    ss_out = subprocess.check_output(["ss", "-tulpn"]).decode()
    exec_pid = None
    for line in ss_out.splitlines():
        if f":{exec_port} " in line:
            match = re.search(r"pid=(\d+)", line)
            if match:
                exec_pid = int(match.group(1))
                break

    if not exec_pid:
        print(f"Error: could not find PID for executor port {exec_port}", file=sys.stderr)
        return 1

    with open(f"/proc/{exec_pid}/environ", "rb") as f:
        exec_env = dict(item.split(b"=", 1) for item in f.read().split(b"\0") if b"=" in item)

    executor_token = exec_env[b"CYRENE_EXECUTOR_TOKEN"].decode("utf-8")
    session_token = exec_env[b"CYRENE_SESSION_TOKEN"].decode("utf-8")
    model_source = exec_env.get(b"CYRENE_HARNESS_MODEL_SOURCE", b"").decode("utf-8")
    model_id = exec_env.get(b"CYRENE_HARNESS_MODEL", b"").decode("utf-8")

    repo_root = Path(__file__).resolve().parents[2]
    git_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo_root).decode().strip()
    git_status = (
        subprocess.check_output(["git", "status", "--short"], cwd=repo_root).decode().strip()
    )

    evidence: dict[str, object] = {
        "schema_version": "cyrene.aether.c1-acceptance.v1",
        "classification": "REAL_SERVICE_API",
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "core_sha": git_head,
        "git_status_clean": len(git_status) == 0,
        "model_id": model_id,
        "model_source": model_source,
        "web_url": web_url,
        "persistence_url": persistence_url,
        "executor_url": executor_url,
        "gates": {},
    }

    gates: dict[str, dict[str, object]] = {}

    def record_gate(name: str, passed: bool, details: dict[str, Any]) -> None:
        gates[name] = {"status": "PASS" if passed else "FAIL", **details}
        print(f"GATE [{name}]: {'PASS' if passed else 'FAIL'}")

    # --- Gate 1: Overview & Capability Diagnostics ---
    req = urllib.request.Request(
        f"{persistence_url}/api/v1/workspaces/local/work/conversation-memory/overview",
        headers={"Authorization": f"Bearer {session_token}"},
    )
    with urllib.request.urlopen(req) as resp:
        overview_status = resp.status
        overview_body = json.loads(resp.read().decode())

    caps = overview_body.get("capabilities", {})
    gate1_pass = (
        overview_status == 200
        and caps.get("memoryProvider") == "ready"
        and caps.get("summarizer") == "ready"
    )
    record_gate(
        "overview_capabilities",
        gate1_pass,
        {
            "http_status": overview_status,
            "memory_provider": caps.get("memoryProvider"),
            "summarizer": caps.get("summarizer"),
            "authorization_epoch": overview_body.get("authorizationEpoch"),
        },
    )

    # --- Gate 2: API Pairing & Session Auth ---
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    pairing_code = pairing_file.read_text(encoding="utf-8").strip()
    pair_req = urllib.request.Request(
        f"{web_url}/api/v1/auth/pair",
        data=json.dumps({"pairingCode": pairing_code}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with opener.open(pair_req) as resp:
        pair_status = resp.status
        pair_body = json.loads(resp.read().decode())
        csrf_token = pair_body.get("csrfToken")

    gate2_pass = pair_status == 200 and pair_body.get("authenticated") is True and bool(csrf_token)
    record_gate(
        "api_pairing_auth",
        gate2_pass,
        {
            "http_status": pair_status,
            "authenticated": pair_body.get("authenticated"),
            "has_session_id": bool(pair_body.get("sessionId")),
            "has_csrf_token": bool(csrf_token),
        },
    )

    def submit_turn(conv_id: str, text: str, idempotency_key: str) -> tuple[int, dict[str, Any]]:
        turn_data = json.dumps({"conversationId": conv_id, "text": text}).encode()
        turn_req = urllib.request.Request(
            f"{web_url}/api/v1/conversation-assistant/turns",
            data=turn_data,
            headers={
                "Content-Type": "application/json",
                "X-CSRF-Token": csrf_token,
                "Idempotency-Key": idempotency_key,
            },
        )
        with opener.open(turn_req) as resp:
            return resp.status, json.loads(resp.read().decode())

    def poll_task(task_id: str, timeout_seconds: float = 300.0) -> dict[str, Any]:
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            time.sleep(1)
            status_req = urllib.request.Request(
                f"{executor_url}/api/v1/tasks/{task_id}",
                headers={"Authorization": f"Bearer {executor_token}"},
            )
            with urllib.request.urlopen(status_req) as resp:
                task = json.loads(resp.read().decode())
                if task.get("status") in ("completed", "failed", "aborted"):
                    return cast(dict[str, Any], task)
        raise TimeoutError(f"Task {task_id} timed out after {timeout_seconds}s")

    model_retries: list[dict[str, str]] = []

    def submit_and_wait(
        conv_id: str, text: str, key_prefix: str, attempts: int = 3
    ) -> dict[str, Any]:
        """Submit one turn and tolerate a bounded number of provider-side stream failures.

        The local model connector enforces a 30s provider deadline, and a small local model can
        exceed it while rambling. A deadline failure is a transient provider condition, not a
        conversation-memory defect, so retry with a fresh idempotency key and record every retry
        in the evidence instead of hiding it.
        """

        last: dict[str, Any] = {}
        for attempt in range(1, attempts + 1):
            key = f"{key_prefix}-a{attempt}-{int(time.time())}"
            status, receipt = submit_turn(conv_id, text, key)
            if status != 202:
                raise RuntimeError(f"turn admission returned HTTP {status}")
            last = poll_task(receipt["taskId"])
            if last.get("status") == "completed":
                return last
            message = str(last.get("error") or last.get("message") or "")
            is_transient = (
                "timeout" in message.lower()
                or "deadline" in message.lower()
                or "before terminal completion" in message.lower()
                or "conversation_assistant_not_delivered" in message.lower()
            )
            if not is_transient:
                return last
            model_retries.append({"task_id": str(receipt["taskId"]), "error": message[:120]})
        return last

    # --- Gate 3: Real Model Conversation Turn & Output ---
    test_conv_id = f"c1-proof-{int(time.time())}"
    turn1_text = "What is the primary role of Cyrene Navigator?"
    turn1_key = f"key-t1-{int(time.time())}"
    turn1_status, turn1_res = submit_turn(test_conv_id, turn1_text, turn1_key)
    task1 = poll_task(turn1_res["taskId"])

    with sqlite3.connect(f"file:{navigator_db}?mode=ro", uri=True) as con:
        cur = con.cursor()
        cur.execute(
            "SELECT status, length(output), duration_ms FROM work_tasks WHERE task_id=?",
            (turn1_res["taskId"],),
        )
        task_row = cur.fetchone()
        cur.execute("SELECT count(*) FROM work_task_events WHERE task_id=?", (turn1_res["taskId"],))
        event_count = cur.fetchone()[0]

    gate3_pass = (
        turn1_status == 202
        and task1["status"] == "completed"
        and len(task1.get("output", "")) > 10
        and task_row is not None
        and task_row[0] == "completed"
        and event_count > 5
    )
    record_gate(
        "real_model_turn_delivery",
        gate3_pass,
        {
            "turn_post_http": turn1_status,
            "task_id": turn1_res["taskId"],
            "task_status": task1["status"],
            "output_length": len(task1.get("output", "")),
            "output_hash": hashlib.sha256(task1.get("output", "").encode()).hexdigest(),
            "db_task_status": task_row[0] if task_row else None,
            "event_count": event_count,
        },
    )

    # --- Gate 4: Same-Key Idempotency Replay ---
    replay_status, replay_res = submit_turn(test_conv_id, turn1_text, turn1_key)
    with sqlite3.connect(f"file:{memory_db}?mode=ro", uri=True) as con:
        cur = con.cursor()
        cur.execute(
            "SELECT count(*) FROM conversation_memory_messages WHERE conversation_id=?",
            (test_conv_id,),
        )
        messages_after_replay = cur.fetchone()[0]

    gate4_pass = (
        replay_status == 202
        and replay_res["taskId"] == turn1_res["taskId"]
        and messages_after_replay == 2
    )
    record_gate(
        "same_key_idempotency_no_duplicates",
        gate4_pass,
        {
            "replay_http_status": replay_status,
            "same_task_id": (replay_res["taskId"] == turn1_res["taskId"]),
            "message_count_in_db": messages_after_replay,
        },
    )

    # --- Gate 5: Concurrent Turns (Concurrency=2) ---
    concurrent_results: dict[int, dict[str, Any]] = {}

    def send_concurrent(idx: int, c_id: str, prompt: str, k: str) -> None:
        _st, res = submit_turn(c_id, prompt, k)
        t = poll_task(res["taskId"])
        concurrent_results[idx] = t

    th1 = threading.Thread(
        target=send_concurrent,
        args=(
            1,
            f"conc-conv-1-{int(time.time())}",
            "Concurrent test line 1 for thread A",
            f"conc-k1-{int(time.time())}",
        ),
    )
    th2 = threading.Thread(
        target=send_concurrent,
        args=(
            2,
            f"conc-conv-2-{int(time.time())}",
            "Concurrent test line 2 for thread B",
            f"conc-k2-{int(time.time())}",
        ),
    )
    th1.start()
    th2.start()
    th1.join()
    th2.join()

    gate5_pass = (
        concurrent_results.get(1, {}).get("status") == "completed"
        and concurrent_results.get(2, {}).get("status") == "completed"
    )
    record_gate(
        "concurrent_turns_concurrency_2",
        gate5_pass,
        {
            "thread1_status": concurrent_results.get(1, {}).get("status"),
            "thread2_status": concurrent_results.get(2, {}).get("status"),
        },
    )

    # --- Gate 6: Auto Model Summary Cross-Threshold Trigger ---
    summary_prompts = [
        "Requirement Alpha: System preference is concise replies. Cite memory references.",
        "Requirement Beta: Memory provider utilizes 384-dimensional vector embeddings.",
        "Requirement Gamma: Data isolation must be enforced across organization boundaries.",
    ]
    for i, text in enumerate(summary_prompts, start=2):
        full_prompt = (text + " ") * 6 + " Reply with exactly: noted."
        submit_and_wait(test_conv_id, full_prompt, f"key-t{i}")

    with sqlite3.connect(f"file:{memory_db}?mode=ro", uri=True) as con:
        cur = con.cursor()
        cur.execute(
            """SELECT count(*), sum(length(content))
               FROM conversation_memory_messages WHERE conversation_id=?""",
            (test_conv_id,),
        )
        cnt, total_chars = cur.fetchone()
        total_chars = total_chars or 0

    if total_chars < 3200 or cnt < 8:
        needed = max(0, 3250 - total_chars)
        repeat_count = needed // 35 + 2
        extra_text = (
            "Detailed context: "
            + ("Verification preference parameters. " * repeat_count)
            + " Reply with exactly: noted."
        )
        submit_and_wait(test_conv_id, extra_text, "key-trigger")

    submit_and_wait(
        test_conv_id,
        "In one short sentence, summarize the confirmed preferences above.",
        "key-summary-trigger",
    )

    with sqlite3.connect(f"file:{memory_db}?mode=ro", uri=True) as con:
        cur = con.cursor()
        cur.execute(
            """SELECT memory_id, memory_kind, state, length(text), text
               FROM conversation_memory_items WHERE conversation_id=?""",
            (test_conv_id,),
        )
        memory_rows = cur.fetchall()

    gate6_pass = (
        len(memory_rows) >= 1 and memory_rows[0][1] == "episode" and memory_rows[0][2] == "active"
    )
    saved_memory_id = memory_rows[0][0] if memory_rows else None
    saved_memory_text = memory_rows[0][4] if memory_rows else None

    record_gate(
        "auto_model_summary_threshold_trigger",
        gate6_pass,
        {
            "episode_memories_created": len(memory_rows),
            "memory_id": saved_memory_id,
            "memory_kind": memory_rows[0][1] if memory_rows else None,
            "memory_state": memory_rows[0][2] if memory_rows else None,
            "summary_text_length": len(saved_memory_text) if saved_memory_text else 0,
            "summary_text_hash": (
                hashlib.sha256(saved_memory_text.encode()).hexdigest()
                if saved_memory_text
                else None
            ),
        },
    )

    # --- Gate 7: Memory Recall & Context Injection ---
    t_recall = submit_and_wait(
        test_conv_id,
        "In one short sentence, what reply style did I ask you to remember?",
        "key-recall",
    )

    with sqlite3.connect(f"file:{memory_db}?mode=ro", uri=True) as con:
        cur = con.cursor()
        cur.execute(
            """SELECT source_refs_json FROM conversation_memory_messages
               WHERE conversation_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1""",
            (test_conv_id,),
        )
        row = cur.fetchone()
        latest_refs = json.loads(row[0]) if row and row[0] else []
        cites_memory = any(r.get("memoryId") == saved_memory_id for r in latest_refs)

    gate7_pass = t_recall["status"] == "completed" and cites_memory is True
    record_gate(
        "memory_recall_and_context_injection",
        gate7_pass,
        {
            "recall_task_status": t_recall["status"],
            "cites_episode_memory": cites_memory,
            "cited_memory_id": saved_memory_id,
            "source_refs_count": len(latest_refs),
        },
    )

    # --- Gate 8: Memory Deletion Exclusion ---
    del_res: dict[str, Any] = {}
    if saved_memory_id:
        del_path = f"/api/v1/workspaces/local/work/conversation-memory/memories/{saved_memory_id}"
        del_url = f"{persistence_url}{del_path}?expectedVersion=1"
        del_req = urllib.request.Request(
            del_url, method="DELETE", headers={"Authorization": f"Bearer {session_token}"}
        )
        try:
            with urllib.request.urlopen(del_req) as resp:
                del_res = json.loads(resp.read().decode())
        except Exception as e:
            del_res = {"deleted": False, "error": str(e)}

    t_post_del = submit_and_wait(
        test_conv_id,
        "Say only 'none' if no saved memory remains active.",
        "key-postdel",
    )

    with sqlite3.connect(f"file:{memory_db}?mode=ro", uri=True) as con:
        cur = con.cursor()
        cur.execute(
            """SELECT source_refs_json FROM conversation_memory_messages
               WHERE conversation_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1""",
            (test_conv_id,),
        )
        row = cur.fetchone()
        post_del_refs = json.loads(row[0]) if row and row[0] else []
        cites_deleted_memory = any(r.get("memoryId") == saved_memory_id for r in post_del_refs)

    gate8_pass = (
        del_res.get("deleted") is True
        and t_post_del["status"] == "completed"
        and cites_deleted_memory is False
    )
    record_gate(
        "memory_deletion_exclusion_next_turn",
        gate8_pass,
        {
            "deleted": del_res.get("deleted"),
            "authorization_epoch": del_res.get("authorizationEpoch"),
            "cites_deleted_memory_in_next_turn": cites_deleted_memory,
        },
    )

    # --- Gate 9: Source Revocation & Cascading Exclusion ---
    with sqlite3.connect(f"file:{memory_db}?mode=ro", uri=True) as con:
        cur = con.cursor()
        cur.execute(
            """SELECT message_id FROM conversation_memory_messages
               WHERE conversation_id=? AND role='user' AND status='active' LIMIT 1""",
            (test_conv_id,),
        )
        target_source_id = cur.fetchone()[0]

    base_src_path = "/api/v1/workspaces/local/work/conversation-memory/sources"
    rev_url = f"{persistence_url}{base_src_path}/{target_source_id}/revoke"
    rev_req = urllib.request.Request(
        rev_url,
        data=b"{}",
        headers={"Authorization": f"Bearer {session_token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(rev_req) as resp:
        rev_res = json.loads(resp.read().decode())

    t_post_rev = submit_and_wait(
        test_conv_id,
        "Reply 'ok' only, without describing any source.",
        "key-postrev",
    )

    with sqlite3.connect(f"file:{memory_db}?mode=ro", uri=True) as con:
        cur = con.cursor()
        cur.execute(
            """SELECT source_refs_json FROM conversation_memory_messages
               WHERE conversation_id=? AND role='assistant' AND status='active'
               ORDER BY rowid DESC LIMIT 1""",
            (test_conv_id,),
        )
        row = cur.fetchone()
        post_rev_refs = json.loads(row[0]) if row and row[0] else []
        cites_revoked = any(
            target_source_id in r.get("sourceMessageIds", []) for r in post_rev_refs
        )

    gate9_pass = (
        rev_res.get("sourceId") == target_source_id
        and t_post_rev["status"] == "completed"
        and cites_revoked is False
    )
    record_gate(
        "source_revocation_cascading_exclusion",
        gate9_pass,
        {
            "revoked_source_id": target_source_id,
            "invalidated_count": rev_res.get("invalidatedCount"),
            "cites_revoked_source_in_next_turn": cites_revoked,
        },
    )

    # --- Gate 10: Turn Cancellation (Late Results Not Published) ---
    cancel_conv_id = f"cancel-conv-{int(time.time())}"
    cancel_turn_data = json.dumps(
        {"conversationId": cancel_conv_id, "text": "This turn will be cancelled immediately."}
    ).encode()
    cancel_turn_req = urllib.request.Request(
        f"{web_url}/api/v1/conversation-assistant/turns",
        data=cancel_turn_data,
        headers={
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf_token,
            "Idempotency-Key": f"cancel-key-{int(time.time())}",
        },
    )
    with opener.open(cancel_turn_req) as resp:
        cancel_admitted = json.loads(resp.read().decode())
        cancel_task_id = cancel_admitted["taskId"]

    # Cancel immediately
    cancel_post_req = urllib.request.Request(
        f"{executor_url}/api/v1/tasks/{cancel_task_id}/cancel",
        method="POST",
        headers={"Authorization": f"Bearer {executor_token}"},
    )
    with urllib.request.urlopen(cancel_post_req) as resp:
        cancel_post_res = json.loads(resp.read().decode())

    # Wait 3s and check status
    time.sleep(3)
    with urllib.request.urlopen(
        urllib.request.Request(
            f"{executor_url}/api/v1/tasks/{cancel_task_id}",
            headers={"Authorization": f"Bearer {executor_token}"},
        )
    ) as resp:
        cancelled_task = json.loads(resp.read().decode())

    with sqlite3.connect(f"file:{memory_db}?mode=ro", uri=True) as con:
        cur = con.cursor()
        cur.execute(
            """SELECT count(*) FROM conversation_memory_messages
               WHERE conversation_id=? AND role='assistant'""",
            (cancel_conv_id,),
        )
        assistant_count_cancelled = cur.fetchone()[0]

    gate10_pass = (
        cancel_post_res.get("cancelled") is True
        and cancelled_task.get("status") in ("aborted", "failed")
        and assistant_count_cancelled == 0
    )
    record_gate(
        "turn_cancellation_late_results_not_published",
        gate10_pass,
        {
            "cancelled_acknowledged": cancel_post_res.get("cancelled"),
            "task_terminal_status": cancelled_task.get("status"),
            "assistant_messages_published": assistant_count_cancelled,
        },
    )

    # --- Gate 11: Actor and Persona Scope Isolation ---
    iso_params = urllib.parse.urlencode(
        {
            "conversationId": test_conv_id,
            "conversationKind": "direct",
            "personaId": "unrelated-persona",
            "limit": "10",
        }
    )
    iso_base = f"{persistence_url}/api/v1/workspaces/local/work/conversation-memory/messages"
    iso_url = f"{iso_base}?{iso_params}"
    with urllib.request.urlopen(
        urllib.request.Request(iso_url, headers={"Authorization": f"Bearer {session_token}"})
    ) as resp:
        iso_messages = json.loads(resp.read().decode())["items"]

    gate11_pass = len(iso_messages) == 0
    record_gate(
        "actor_persona_scope_isolation",
        gate11_pass,
        {
            "unrelated_persona_visible_count": len(iso_messages),
        },
    )

    # Write evidence
    evidence["gates"] = gates
    evidence["model_provider_retries"] = model_retries
    all_passed = all(g["status"] == "PASS" for g in gates.values())
    evidence["overall_status"] = "PASS" if all_passed else "FAIL"

    args.evidence_file.parent.mkdir(parents=True, exist_ok=True)
    args.evidence_file.write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    print(f"\nWritten evidence to: {args.evidence_file}")
    print(f"Overall status: {evidence['overall_status']}")
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
