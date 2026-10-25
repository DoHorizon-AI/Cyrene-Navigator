"""Tests for the durable workspace-scoped Work API. | 工作域 API 测试。"""

from __future__ import annotations

import base64
import hashlib
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from cyrene_navigator.persistence import PersistencePrincipal, create_persistence_app
from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.work.store import WorkStore, _digest, _failed_task_result_notification_text

TOKENS = {
    "writer": PersistencePrincipal(
        "owner", frozenset({"w1", "w2"}), can_takeover=True, organization_id="org-a"
    ),
    "reader": PersistencePrincipal("reader", frozenset({"w1"}), organization_id="org-a"),
    "other-org": PersistencePrincipal(
        "other-owner", frozenset({"w1"}), can_takeover=True, organization_id="org-b"
    ),
    "other-writer": PersistencePrincipal(
        "another-owner", frozenset({"w1"}), can_takeover=True, organization_id="org-a"
    ),
}
BASE = "/api/v1/workspaces/{workspace}/work"


def _client(db_path: Path) -> TestClient:
    """Build the same app factory used by the persistence service. | 创建持久化服务。"""

    return TestClient(create_persistence_app(db_path, TOKENS))


def _headers(token: str = "writer") -> dict[str, str]:
    """Build one configured bearer header. | 构造 bearer 请求头。"""

    return {"Authorization": f"Bearer {token}"}


def _task_body(task_id: str = "task-1") -> dict[str, Any]:
    """Return a minimal stable executor task fixture. | 返回最小任务 fixture。"""

    return {"id": task_id, "sessionId": "session-1", "prompt": "do the work"}


def test_task_scope_approval_replay_and_conflict(tmp_path: Path) -> None:
    """Approval decisions stay correlated, scoped, and one-time. | 审批范围与一次性。"""

    db_path = tmp_path / "work.sqlite3"
    with _client(db_path) as client:
        task_response = client.post(
            BASE.format(workspace="w1") + "/tasks",
            json=_task_body(),
            headers=_headers(),
        )
        assert task_response.status_code == 201
        assert task_response.json()["durationMs"] == 0
        assert task_response.json()["output"] == ""

        outsider = client.get(
            BASE.format(workspace="w1") + "/tasks/task-1", headers=_headers("other-org")
        )
        assert outsider.status_code == 404
        other_workspace = client.get(
            BASE.format(workspace="w2") + "/tasks/task-1", headers=_headers()
        )
        assert other_workspace.status_code == 404
        write_denied = client.post(
            BASE.format(workspace="w1") + "/tasks",
            json=_task_body("denied"),
            headers=_headers("reader"),
        )
        assert write_denied.status_code == 403

        approval_url = BASE.format(workspace="w1") + "/tasks/task-1/approvals"
        approval_body = {
            "kind": "external_write",
            "summary": "Publish the result",
            "messageId": "approval-create-1",
        }
        created = client.post(approval_url, json=approval_body, headers=_headers())
        assert created.status_code == 201
        approval = created.json()["approval"]
        assert created.json()["task"]["status"] == "waiting_approval"

        replay = client.post(approval_url, json=approval_body, headers=_headers())
        assert replay.status_code == 200
        assert replay.json()["duplicate"] is True
        assert replay.json()["approval"]["id"] == approval["id"]

        resolve_url = BASE.format(workspace="w1") + f"/approvals/{approval['id']}/resolve"
        decision = {"decision": "approved", "messageId": "decision-1"}
        resolved = client.post(resolve_url, json=decision, headers=_headers())
        assert resolved.status_code == 200
        assert resolved.json()["task"]["status"] == "running"
        assert resolved.json()["task"]["startedAt"] is not None
        assert (
            client.post(resolve_url, json=decision, headers=_headers()).json()["duplicate"] is True
        )

        conflicting_replay = client.post(
            resolve_url,
            json={"decision": "rejected", "messageId": "decision-1"},
            headers=_headers(),
        )
        assert conflicting_replay.status_code == 409
        cross_scope = client.get(
            BASE.format(workspace="w1") + f"/approvals/{approval['id']}",
            headers=_headers("other-org"),
        )
        assert cross_scope.status_code == 404


def test_authorization_wait_and_read_only_continuation_are_atomic_and_actor_scoped(
    tmp_path: Path,
) -> None:
    """A continuation inherits only its owned session and read-only mode.

    续接只继承本人会话并强制只读。
    """

    db_path = tmp_path / "authorization-continuation.sqlite3"
    task_url = BASE.format(workspace="w1") + "/tasks/task-auth"
    with _client(db_path) as client:
        created = client.post(
            BASE.format(workspace="w1") + "/tasks",
            json={"id": "task-auth", "sessionId": "session-auth", "prompt": "Original request"},
            headers=_headers(),
        )
        assert created.status_code == 201
        claim = client.post(task_url + "/claim", headers=_headers())
        assert claim.status_code == 200 and claim.json()["claimed"] is True
        approval = client.post(
            task_url + "/approvals",
            json={"kind": "external_write", "summary": "Previously approved action."},
            headers=_headers(),
        )
        assert approval.status_code == 201
        approval_id = approval.json()["approval"]["id"]
        resolved = client.post(
            BASE.format(workspace="w1") + f"/approvals/{approval_id}/resolve",
            json={"decision": "approved", "messageId": "previous-task-approval"},
            headers=_headers(),
        )
        assert resolved.status_code == 200
        assert resolved.json()["task"]["status"] == "running"
        paused = client.patch(
            task_url,
            json={
                "status": "awaiting_user_authorization",
                "output": "Read-only progress is preserved.",
            },
            headers=_headers(),
        )
        assert paused.status_code == 200, paused.text
        assert paused.json()["status"] == "awaiting_user_authorization"
        assert paused.json()["output"] == "Read-only progress is preserved."
        cannot_replay_source = client.patch(
            task_url,
            json={"status": "running"},
            headers=_headers(),
        )
        assert cannot_replay_source.status_code == 409

        owner_check = client.post(task_url + "/resume/check", headers=_headers())
        assert owner_check.status_code == 204
        other_owner_check = client.post(
            task_url + "/resume/check", headers=_headers("other-writer")
        )
        assert other_owner_check.status_code == 404

        resume_url = task_url + "/resume"
        resume_headers = {**_headers(), "Idempotency-Key": "client-resume-1"}
        resumed = client.post(
            resume_url, json={"prompt": "Continue with read-only checks."}, headers=resume_headers
        )
        assert resumed.status_code == 201, resumed.text
        receipt = resumed.json()
        continuation = receipt["task"]
        assert receipt["duplicate"] is False
        assert continuation["sessionId"] == "session-auth"
        assert continuation["prompt"] == "Continue with read-only checks."
        assert continuation["status"] == "queued"
        assert continuation["continuationOfTaskId"] == "task-auth"
        assert continuation["continuationMode"] == "read_only"

        marker = client.get(
            BASE.format(workspace="w1") + f"/tasks/{continuation['id']}/events",
            headers=_headers(),
        ).json()["events"]
        assert any(
            row["event"].get("type") == "task.continuation_started"
            and row["event"].get("sourceTaskId") == "task-auth"
            for row in marker
        )
        with sqlite3.connect(db_path) as connection:
            inherited_approvals = connection.execute(
                "SELECT COUNT(*) FROM work_approvals "
                "WHERE organization_id='org-a' AND workspace_id='w1' AND task_id=?",
                (continuation["id"],),
            ).fetchone()[0]
        assert inherited_approvals == 0

        replay = client.post(
            resume_url,
            json={"prompt": "Continue with read-only checks."},
            headers=resume_headers,
        )
        assert replay.status_code == 200
        assert replay.json()["duplicate"] is True
        assert replay.json()["task"]["id"] == continuation["id"]
        conflicting = client.post(
            resume_url,
            json={"prompt": "A different continuation."},
            headers=resume_headers,
        )
        assert conflicting.status_code == 409
        spoofed = client.post(
            resume_url,
            json={"prompt": "Continue.", "sessionId": "another-session"},
            headers={**_headers(), "Idempotency-Key": "client-resume-spoof"},
        )
        assert spoofed.status_code == 422
        other_owner = client.post(
            resume_url,
            json={"prompt": "Continue."},
            headers={**_headers("other-writer"), "Idempotency-Key": "other-owner-resume"},
        )
        assert other_owner.status_code == 404

    # A second Work API instance can claim the queued row and sees the guard in its first read.
    with _client(db_path) as replica:
        claim = replica.post(
            BASE.format(workspace="w1") + f"/tasks/{continuation['id']}/claim",
            headers=_headers(),
        )
        assert claim.status_code == 200, claim.text
        assert claim.json()["claimed"] is True
        assert claim.json()["task"]["continuationOfTaskId"] == "task-auth"
        assert claim.json()["task"]["continuationMode"] == "read_only"


def test_legacy_task_retry_remains_idempotent_but_ownerless_rows_cannot_continue(
    tmp_path: Path,
) -> None:
    """Migration preserves legacy retries without inventing a continuation owner.

    保留旧重试，但不猜测旧任务所有者。
    """

    db_path = tmp_path / "legacy-task.sqlite3"
    body = _task_body("legacy-task")
    with _client(db_path) as client:
        created = client.post(BASE.format(workspace="w1") + "/tasks", json=body, headers=_headers())
        assert created.status_code == 201
        legacy_digest = _digest(
            {
                "sessionId": body["sessionId"],
                "prompt": body["prompt"],
                "title": None,
                "description": None,
                "metadata": {},
            }
        )
        with sqlite3.connect(db_path) as connection:
            connection.execute(
                """UPDATE work_tasks SET created_by_actor_id='',creation_digest=?
                   WHERE organization_id='org-a' AND workspace_id='w1' AND task_id='legacy-task'""",
                (legacy_digest,),
            )
            connection.commit()
        replay = client.post(BASE.format(workspace="w1") + "/tasks", json=body, headers=_headers())
        assert replay.status_code == 200
        assert replay.json()["id"] == "legacy-task"

        client.post(
            BASE.format(workspace="w1") + "/tasks/legacy-task/claim",
            headers=_headers(),
        ).raise_for_status()
        paused = client.patch(
            BASE.format(workspace="w1") + "/tasks/legacy-task",
            json={"status": "awaiting_user_authorization"},
            headers=_headers(),
        )
        assert paused.status_code == 200
        no_owner = client.post(
            BASE.format(workspace="w1") + "/tasks/legacy-task/resume",
            json={"prompt": "Continue safely."},
            headers={**_headers(), "Idempotency-Key": "legacy-resume"},
        )
        assert no_owner.status_code == 404


def test_task_events_survive_reopen_and_deduplicate(tmp_path: Path) -> None:
    """Event sequence and message-id receipt survive process restart. | 事件重启后持久。"""

    db_path = tmp_path / "events.sqlite3"
    with _client(db_path) as first:
        first.post(
            BASE.format(workspace="w1") + "/tasks",
            json=_task_body(),
            headers=_headers(),
        ).raise_for_status()
        event_url = BASE.format(workspace="w1") + "/tasks/task-1/events"
        request = {
            "event": {"type": "executor.output", "text": "ready"},
            "messageId": "output-1",
        }
        appended = first.post(event_url, json=request, headers=_headers())
        assert appended.status_code == 200
        assert appended.json()["seq"] == 2
        receipt_time = appended.json()["createdAt"]
        assert isinstance(receipt_time, int)
        replayed = first.post(event_url, json=request, headers=_headers())
        assert replayed.json()["duplicate"] is True
        assert replayed.json()["createdAt"] == receipt_time

    with _client(db_path) as reopened:
        event_url = BASE.format(workspace="w1") + "/tasks/task-1/events"
        history = reopened.get(event_url + "?after=1", headers=_headers())
        assert history.status_code == 200
        assert history.json()["events"] == [
            {
                "seq": 2,
                "event": {"type": "executor.output", "text": "ready"},
                "createdAt": receipt_time,
                "messageId": "output-1",
            }
        ]
        assert history.json()["nextSeq"] == 3
        replay_after_restart = reopened.post(event_url, json=request, headers=_headers())
        assert replay_after_restart.status_code == 200
        assert replay_after_restart.json()["duplicate"] is True
        assert replay_after_restart.json()["createdAt"] == history.json()["events"][0]["createdAt"]
        conflict = reopened.post(
            event_url,
            json={"event": {"type": "executor.output", "text": "changed"}, "messageId": "output-1"},
            headers=_headers(),
        )
        assert conflict.status_code == 409


def test_terminal_task_accepts_empty_reasoning_and_persists_server_timing(tmp_path: Path) -> None:
    """Empty result text is valid and terminal timing stays server-owned. | 空结果合法。"""

    base = BASE.format(workspace="w1")
    with _client(tmp_path / "terminal-empty-reasoning.sqlite3") as client:
        created = client.post(
            base + "/tasks",
            json=_task_body("terminal-1"),
            headers=_headers(),
        )
        assert created.status_code == 201, created.text
        claim = client.post(base + "/tasks/terminal-1/claim", headers=_headers())
        assert claim.status_code == 200
        assert claim.json()["claimed"] is True

        completed = client.patch(
            base + "/tasks/terminal-1",
            json={
                "status": "completed",
                "output": "Approved fixture work completed.",
                "reasoning": "",
            },
            headers=_headers(),
        )
        assert completed.status_code == 200, completed.text
        record = completed.json()
        assert record["status"] == "completed"
        assert record["output"] == "Approved fixture work completed."
        assert record["reasoning"] == ""
        assert isinstance(record["startedAt"], int)
        assert isinstance(record["endedAt"], int)
        assert isinstance(record["durationMs"], int)
        assert record["durationMs"] >= 0

        persisted = client.get(base + "/tasks/terminal-1", headers=_headers())
        assert persisted.status_code == 200
        assert persisted.json() == record


def test_partial_source_inventory_preserves_last_complete_snapshot(tmp_path: Path) -> None:
    """Incomplete paginated scans never replace facts or mark them missing. | 部分页保留旧快照。"""

    with _client(tmp_path / "sources.sqlite3") as client:
        inventory_url = BASE.format(workspace="w1") + "/sources/repo/inventory"
        complete = client.post(
            inventory_url,
            json={
                "inventoryId": "full-1",
                "complete": True,
                "successful": True,
                "items": [
                    {"key": "keep", "value": {"version": 1}},
                    {"key": "also-keep", "value": {"version": 2}},
                ],
            },
            headers=_headers(),
        )
        assert complete.status_code == 200, complete.text
        assert complete.json()["complete"] is True

        partial = client.post(
            inventory_url,
            json={
                "inventoryId": "partial-1",
                "nextPageToken": "page-2",
                "complete": False,
                "successful": True,
                "items": [{"key": "keep", "value": {"version": 9}}],
            },
            headers=_headers(),
        )
        assert partial.status_code == 200, partial.text
        assert partial.json()["complete"] is False

        facts = client.get(
            BASE.format(workspace="w1") + "/sources/repo/facts?include_missing=true",
            headers=_headers(),
        )
        assert facts.status_code == 200
        items = {item["key"]: item for item in facts.json()["items"]}
        assert items["keep"]["value"] == {"version": 1}
        assert items["also-keep"]["value"] == {"version": 2}
        assert not items["keep"]["missing"]
        assert not items["also-keep"]["missing"]


def test_outbox_deduplicates_filters_claims_and_never_resends_unknown(tmp_path: Path) -> None:
    """Filtered leases and uncertain delivery prevent replay. | 防止未知投递重发。"""

    db_path = tmp_path / "outbox.sqlite3"
    base = BASE.format(workspace="w1")
    with _client(db_path) as client:
        create_url = base + "/notifications"
        body = {
            "deduplicationKey": "notice-1",
            "type": "wecom.message",
            "connectorId": "binding-1",
            "recipient": "bot:7/group/room-1",
            "payload": {"text": "hello"},
        }
        created = client.post(create_url, json=body, headers=_headers())
        assert created.status_code == 201, created.text
        duplicate = client.post(create_url, json=body, headers=_headers())
        assert duplicate.status_code == 200
        assert duplicate.json()["duplicate"] is True

        unrelated = client.post(
            create_url,
            json={
                "deduplicationKey": "notice-2",
                "type": "wecom.message",
                "connectorId": "binding-2",
                "recipient": "bot:8/group/room-2",
                "payload": {"text": "elsewhere"},
            },
            headers=_headers(),
        )
        assert unrelated.status_code == 201

        claim_url = base + "/notifications/claim"
        claim_body = {
            "workerId": "wecom-binding-1",
            "limit": 10,
            "leaseSeconds": 60,
            "type": "wecom.message",
            "connectorId": "binding-1",
            "recipient": "bot:7/group/room-1",
        }
        claimed = client.post(claim_url, json=claim_body, headers=_headers())
        assert claimed.status_code == 200, claimed.text
        items = claimed.json()["items"]
        assert len(items) == 1
        leased = items[0]
        assert leased["notification"]["connectorId"] == "binding-1"

        notification_id = leased["notification"]["id"]
        start_url = base + f"/notifications/{notification_id}/start"
        start = client.post(
            start_url,
            json={"leaseToken": leased["leaseToken"]},
            headers=_headers(),
        )
        assert start.status_code == 200, start.text
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                "UPDATE work_notifications SET lease_expires_at=0 WHERE notification_id=?",
                (notification_id,),
            )
        retried = client.post(claim_url, json=claim_body, headers=_headers())
        assert retried.status_code == 200
        assert retried.json()["items"] == []
        uncertain = client.get(base + "/notifications?status=uncertain", headers=_headers())
        assert [item["id"] for item in uncertain.json()["items"]] == [notification_id]
        queued = client.get(base + "/notifications?status=queued", headers=_headers())
        assert [item["connectorId"] for item in queued.json()["items"]] == ["binding-2"]


def test_terminal_task_enqueues_wecom_reply_atomically(tmp_path: Path) -> None:
    """A terminal transition enqueues one adapter reply atomically. | 完成任务原子入通知。"""

    with _client(tmp_path / "task-reply.sqlite3") as client:
        body = _task_body("reply-1")
        body["metadata"] = {
            "notification": {
                "type": "wecom.message",
                "connectorId": "binding-1",
                "recipient": "bot:7/group/room-1",
                "payload": {
                    "accountId": "account-7",
                    "conversationId": "room-1",
                    "chatType": "group",
                    "senderId": "user-4",
                },
            }
        }
        task_url = BASE.format(workspace="w1") + "/tasks"
        created = client.post(task_url, json=body, headers=_headers())
        assert created.status_code == 201, created.text
        claimed = client.post(
            BASE.format(workspace="w1") + "/tasks/reply-1/claim", headers=_headers()
        )
        assert claimed.json()["claimed"] is True
        completed = client.patch(
            BASE.format(workspace="w1") + "/tasks/reply-1",
            json={"status": "completed", "output": "Visible answer"},
            headers=_headers(),
        )
        assert completed.status_code == 200, completed.text

        notifications = client.get(
            BASE.format(workspace="w1") + "/notifications", headers=_headers()
        )
        assert notifications.status_code == 200
        assert len(notifications.json()["items"]) == 1
        notification = notifications.json()["items"][0]
        assert notification["deduplicationKey"] == "task-result:reply-1:completed"
        assert notification["payload"] == {
            "accountId": "account-7",
            "conversationId": "room-1",
            "chatType": "group",
            "senderId": "user-4",
            "text": "Visible answer",
            "taskId": "reply-1",
            "status": "completed",
        }
        assert notification["taskId"] == "reply-1"


def test_terminal_teams_reply_uses_root_thread_route_and_unknown_delivery_is_not_replayed(
    tmp_path: Path,
) -> None:
    """Persist Teams routing and prevent unknown Bot-send replay.

    中文：持久化 Teams 回帖，并阻止未知投递结果被重放。
    """

    db_path = tmp_path / "teams-task-reply.sqlite3"
    base = BASE.format(workspace="w1")
    route = {
        "tenantId": "tenant-1",
        "teamId": "team-1",
        "channelId": "channel-1",
        "conversationId": "conversation-1",
        "rootThreadId": "1698765432100",
    }
    with _client(db_path) as client:
        created = client.post(
            base + "/tasks",
            json={
                "id": "teams-task-1",
                "sessionId": "teams-session-1",
                "prompt": "Inspect the repository status.",
                "metadata": {
                    "notification": {
                        "type": "teams.message",
                        "connectorId": "teams-v1",
                        "recipient": "teams:thread-digest",
                        "payload": route,
                    }
                },
            },
            headers=_headers(),
        )
        assert created.status_code == 201, created.text
        assert client.post(base + "/tasks/teams-task-1/claim", headers=_headers()).json()["claimed"]
        completed = client.patch(
            base + "/tasks/teams-task-1",
            json={"status": "completed", "output": "Repository is clean."},
            headers=_headers(),
        )
        assert completed.status_code == 200, completed.text
        with sqlite3.connect(db_path) as conn:
            conn.execute("UPDATE work_notifications SET available_at=0")
        claimed = client.post(
            base + "/notifications/claim",
            json={
                "workerId": "navigator-teams-dispatcher",
                "limit": 10,
                "leaseSeconds": 60,
                "type": "teams.message",
                "connectorId": "teams-v1",
            },
            headers=_headers(),
        )
        assert claimed.status_code == 200, claimed.text
        lease = claimed.json()["items"][0]
        notice_id = lease["notification"]["id"]
        assert lease["notification"]["payload"] == {
            **route,
            "text": "Repository is clean.",
            "taskId": "teams-task-1",
            "status": "completed",
        }
        assert (
            client.post(
                base + f"/notifications/{notice_id}/start",
                json={"leaseToken": lease["leaseToken"]},
                headers=_headers(),
            ).status_code
            == 200
        )
        assert (
            client.post(
                base + f"/notifications/{notice_id}/finish",
                json={
                    "leaseToken": lease["leaseToken"],
                    "outcome": "uncertain",
                    "result": {"code": "timeout"},
                },
                headers=_headers(),
            ).status_code
            == 200
        )
        assert (
            client.post(
                base + "/notifications/claim",
                json={
                    "workerId": "navigator-teams-dispatcher",
                    "limit": 10,
                    "leaseSeconds": 60,
                    "type": "teams.message",
                    "connectorId": "teams-v1",
                },
                headers=_headers(),
            ).json()["items"]
            == []
        )


def test_outbox_rate_limit_retries_without_an_attempt_cap(tmp_path: Path) -> None:
    """Known rate limits retain delayed retries without a fixed attempt ceiling."""

    db_path = tmp_path / "outbox-rate-limit.sqlite3"
    base = BASE.format(workspace="w1")
    body = {
        "deduplicationKey": "teams-rate-limit-1",
        "type": "teams.message",
        "connectorId": "teams-v1",
        "recipient": "teams:route-hash",
        "payload": {"text": "reply"},
    }
    claim_body = {
        "workerId": "navigator-teams-dispatcher",
        "limit": 1,
        "leaseSeconds": 60,
        "type": "teams.message",
        "connectorId": "teams-v1",
    }
    with _client(db_path) as client:
        created = client.post(base + "/notifications", json=body, headers=_headers())
        assert created.status_code == 201
        notice_id = created.json()["notification"]["id"]
        for retry_number in range(1, 7):
            lease = client.post(
                base + "/notifications/claim", json=claim_body, headers=_headers()
            ).json()["items"][0]
            token = lease["leaseToken"]
            assert (
                client.post(
                    base + f"/notifications/{notice_id}/start",
                    json={"leaseToken": token},
                    headers=_headers(),
                ).status_code
                == 200
            )
            finish = client.post(
                base + f"/notifications/{notice_id}/finish",
                json={
                    "leaseToken": token,
                    "outcome": "retry",
                    "retryAfterSeconds": 30,
                    "result": {"code": "rate_limited"},
                },
                headers=_headers(),
            )
            assert finish.status_code == 200, finish.text
            assert finish.json()["status"] == "queued"
            assert finish.json()["result"]["retryCount"] == retry_number
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    "UPDATE work_notifications SET available_at=0 WHERE notification_id=?",
                    (notice_id,),
                )

        final_lease = client.post(
            base + "/notifications/claim", json=claim_body, headers=_headers()
        ).json()["items"][0]
        token = final_lease["leaseToken"]
        assert (
            client.post(
                base + f"/notifications/{notice_id}/start",
                json={"leaseToken": token},
                headers=_headers(),
            ).status_code
            == 200
        )
        another_retry = client.post(
            base + f"/notifications/{notice_id}/finish",
            json={
                "leaseToken": token,
                "outcome": "retry",
                "retryAfterSeconds": 30,
                "result": {"code": "rate_limited"},
            },
            headers=_headers(),
        )
        assert another_retry.status_code == 200
        assert another_retry.json()["status"] == "queued"
        assert another_retry.json()["result"]["retryCount"] == 7


def test_connector_event_admission_deduplicates_task_across_reopen_and_rejects_changed_replay(
    tmp_path: Path,
) -> None:
    """Persist a Teams activity and task atomically across restart. | Teams 活动任务原子持久。"""

    db_path = tmp_path / "teams-ingress.sqlite3"
    base = BASE.format(workspace="w1")
    event = {
        "messageId": "teams:activity-hash",
        "type": "message.received",
        "accountId": "bot-app-1",
        "conversationId": "conversation-1",
        "senderId": "aad-object-1",
        "payload": {
            "provider": "teams",
            "tenantId": "tenant-1",
            "teamId": "team-1",
            "channelId": "channel-1",
            "rootThreadId": "1698765432100",
            "text": "Inspect the repository status.",
        },
        "task": {
            "id": "teams-task-hash",
            "sessionId": "teams-session-hash",
            "prompt": "Inspect the repository status.",
            "metadata": {"teamsCaller": {"issuer": "issuer-1", "subject": "aad-object-1"}},
        },
    }
    with _client(db_path) as client:
        first = client.post(base + "/connectors/teams-v1/events", json=event, headers=_headers())
        assert first.status_code == 200, first.text
        receipt = first.json()
        assert receipt["duplicate"] is False
        assert receipt["task"]["id"] == "teams-task-hash"
        replay = client.post(base + "/connectors/teams-v1/events", json=event, headers=_headers())
        assert replay.status_code == 200, replay.text
        assert replay.json()["duplicate"] is True
        assert replay.json()["task"]["id"] == receipt["task"]["id"]

    with _client(db_path) as reopened:
        replay = reopened.post(base + "/connectors/teams-v1/events", json=event, headers=_headers())
        assert replay.status_code == 200, replay.text
        assert replay.json()["duplicate"] is True
        assert (
            reopened.get(base + "/tasks/teams-task-hash", headers=_headers()).json()["metadata"]
            == event["task"]["metadata"]
        )
        changed = {**event, "payload": {**event["payload"], "text": "Changed replay"}}
        conflict = reopened.post(
            base + "/connectors/teams-v1/events", json=changed, headers=_headers()
        )
        assert conflict.status_code == 409


def test_teams_thread_mapping_keeps_member_messages_as_context_without_admitting_tasks(
    tmp_path: Path,
) -> None:
    """Participant context is durable, while only the owner admission creates a Session task.

    其他参与者的文本只作为后续上下文保存；只有维护者接纳消息才建立 DSH Session 任务。
    """

    db_path = tmp_path / "teams-thread-context.sqlite3"
    base = BASE.format(workspace="w1")
    tenant_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    owner_id = "11111111-1111-4111-8111-111111111111"
    member_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    thread = {
        "threadId": "a" * 64,
        "tenantId": tenant_id,
        "teamId": "team-1",
        "channelId": "channel-1",
        "conversationId": "conversation-1",
        "rootThreadId": "1698765432100",
        "serviceUrl": "https://smba.trafficmanager.net/emea/",
    }
    member_event = {
        "messageId": "member-message-1",
        "type": "message.received",
        "accountId": "bot-app-1",
        "conversationId": "conversation-1",
        "senderId": member_id,
        "payload": {
            "messageId": "member-message-1",
            "text": "The deployment failed after the last update.",
        },
        "teamsThreadMessage": {
            **thread,
            "messageId": "member-message-1",
            "actorIssuer": f"https://login.microsoftonline.com/{tenant_id}/v2.0",
            "actorSubject": member_id,
            "text": "The deployment failed after the last update.",
        },
    }
    with _client(db_path) as client:
        member_receipt = client.post(
            base + "/connectors/teams-v1/events", json=member_event, headers=_headers()
        )
        assert member_receipt.status_code == 200, member_receipt.text
        assert member_receipt.json()["task"] is None
        context_before_owner = client.get(
            base + f"/connectors/teams-v1/threads/{thread['threadId']}", headers=_headers()
        )
        assert context_before_owner.status_code == 200
        assert context_before_owner.json()["sessionId"] is None
        assert context_before_owner.json()["serviceUrl"] == thread["serviceUrl"]
        assert [item["actorSubject"] for item in context_before_owner.json()["messages"]] == [
            member_id
        ]

        untrusted_service = {
            **member_event,
            "messageId": "member-message-untrusted-service",
            "payload": {
                "messageId": "member-message-untrusted-service",
                "text": "This URL must not be stored.",
            },
            "teamsThreadMessage": {
                **member_event["teamsThreadMessage"],
                "messageId": "member-message-untrusted-service",
                "serviceUrl": "https://127.0.0.1/teams/",
                "text": "This URL must not be stored.",
            },
        }
        rejected_service = client.post(
            base + "/connectors/teams-v1/events",
            json=untrusted_service,
            headers=_headers(),
        )
        assert rejected_service.status_code == 422

        owner_event = {
            "messageId": "owner-message-1",
            "type": "message.received",
            "accountId": "bot-app-1",
            "conversationId": "conversation-1",
            "senderId": owner_id,
            "payload": {
                "messageId": "owner-message-1",
                "text": "Please inspect the deployment status.",
            },
            "teamsThreadMessage": {
                **thread,
                "messageId": "owner-message-1",
                "actorIssuer": f"https://login.microsoftonline.com/{tenant_id}/v2.0",
                "actorSubject": owner_id,
                "text": "Please inspect the deployment status.",
                "sessionId": "teams-session-1",
            },
            "task": {
                "id": "teams-owner-task-1",
                "sessionId": "teams-session-1",
                "prompt": "Please inspect the deployment status.",
                "metadata": {
                    "teamsCaller": {
                        "issuer": f"https://login.microsoftonline.com/{tenant_id}/v2.0",
                        "subject": owner_id,
                    }
                },
            },
        }
        admitted = client.post(
            base + "/connectors/teams-v1/events", json=owner_event, headers=_headers()
        )
        assert admitted.status_code == 200, admitted.text
        assert admitted.json()["task"]["sessionId"] == "teams-session-1"
        context = client.get(
            base + f"/connectors/teams-v1/threads/{thread['threadId']}", headers=_headers()
        )
        assert context.status_code == 200
        record = context.json()
        assert record["sessionId"] == "teams-session-1"
        assert [item["actorSubject"] for item in record["messages"]] == [member_id, owner_id]
        excluded = client.get(
            base
            + f"/connectors/teams-v1/threads/{thread['threadId']}"
            + "?exclude_message_id=owner-message-1",
            headers=_headers(),
        )
        assert [item["messageId"] for item in excluded.json()["messages"]] == ["member-message-1"]

        mismatched_session = {
            **owner_event,
            "messageId": "owner-message-2",
            "payload": {
                "messageId": "owner-message-2",
                "text": "Please inspect the deployment status.",
            },
            "task": {
                **owner_event["task"],
                "id": "teams-owner-task-2",
                "sessionId": "another-session",
            },
            "teamsThreadMessage": {
                **owner_event["teamsThreadMessage"],
                "messageId": "owner-message-2",
                "sessionId": "another-session",
            },
        }
        rejected = client.post(
            base + "/connectors/teams-v1/events", json=mismatched_session, headers=_headers()
        )
        assert rejected.status_code == 409
        assert client.get(base + "/tasks/teams-owner-task-2", headers=_headers()).status_code == 404


def test_v2_workflow_notice_projects_from_completed_owner_task_without_generic_notification_bypass(
    tmp_path: Path,
) -> None:
    """Only the typed v2 route can reply through a completed owner Teams task."""

    db_path = tmp_path / "workflow-teams-notice.sqlite3"
    base = BASE.format(workspace="w1")
    workflow_id = "repo-patrol"
    trigger_id = "github-poll"
    owner_task_id = "owner-teams-task"
    thread_id = "teams-thread-binding-001"
    tenant_id = "11111111-1111-4111-8111-111111111111"
    owner_id = "22222222-2222-4222-8222-222222222222"
    issuer = f"https://login.microsoftonline.com/{tenant_id}/v2.0"
    service_url = "https://smba.trafficmanager.net/emea/"
    route = {
        "tenantId": tenant_id,
        "teamId": "team-1",
        "channelId": "channel-1",
        "conversationId": "conversation-1",
        "rootThreadId": "1698765432100",
        "serviceUrl": service_url,
    }
    owner_message = "Create a repository patrol responsibility."
    teams_event = {
        "messageId": "owner-message-1",
        "type": "message.received",
        "accountId": "bot-app-1",
        "conversationId": route["conversationId"],
        "senderId": owner_id,
        "payload": {"messageId": "owner-message-1", "text": owner_message},
        "teamsThreadMessage": {
            **route,
            "threadId": thread_id,
            "messageId": "owner-message-1",
            "actorIssuer": issuer,
            "actorSubject": owner_id,
            "text": owner_message,
            "sessionId": "owner-session-1",
        },
        "task": {
            "id": owner_task_id,
            "sessionId": "owner-session-1",
            "prompt": owner_message,
            "metadata": {
                "teamsCaller": {"issuer": issuer, "subject": owner_id, "tenantId": tenant_id},
                "teamsThread": {"threadId": thread_id, **route},
                "notification": {
                    "type": "teams.message",
                    "connectorId": "teams-v1",
                    "recipient": f"teams:{thread_id}",
                    "payload": route,
                },
            },
        },
    }
    scheduled_at = "2026-10-24T12:00:00Z"
    occurrence_id = (
        "occ-"
        + hashlib.sha256(f"{workflow_id}\0{trigger_id}\0{scheduled_at}".encode()).hexdigest()[:40]
    )
    event_id = (
        "workflow-"
        + hashlib.sha256(
            f"{workflow_id}\0{trigger_id}\0{scheduled_at}\0succeeded".encode()
        ).hexdigest()[:48]
    )
    workflow = {
        "id": workflow_id,
        "version": 2,
        "title": "Repository patrol",
        "description": "Observe configured repositories.",
        "goal": "Find material new repository changes.",
        "instructions": "Observe only; do not merge or deploy.",
        "targets": [
            {
                "id": "123456",
                "label": "DoHorizon-AI/Cyrene-Workspace",
                "kind": "github_repository",
                "bindingId": "github-binding-1",
                "uri": "https://github.com/DoHorizon-AI/Cyrene-Workspace",
            }
        ],
        "triggers": [
            {
                "id": trigger_id,
                "kind": "github_incremental_poll",
                "schedule": {"kind": "cron", "expression": "*/5 * * * *", "timeZone": "UTC"},
                "targetIds": ["123456"],
                "initialBaseline": "record_without_notification",
                "search": {"state": "open", "labels": [], "limit": 50},
            }
        ],
        "actionPolicy": {
            "allowedActions": [
                {
                    "id": "safe-source-ci",
                    "action": "rerun_source_ci",
                    "targetIds": ["123456"],
                    "baseBranches": [],
                    "branchPrefixes": ["cyrene/assistant/"],
                    "pathPrefixes": [],
                    "issueNumbers": [],
                    "sourceWorkflowIds": ["987654321"],
                    "permittedOperations": ["github.actions.rerun_failed"],
                }
            ],
            "separateChildTask": True,
            "productionChanges": "forbidden",
            "requiresUserAuthorization": ["merge", "release", "production", "new_spend"],
        },
        "modelPolicy": {
            "preferredProvider": "antigravity",
            "preferredModel": "gemini-3.8-flash-medium",
            "fallback": "configured_no_additional_spend",
        },
        "authorization": {
            "kind": "teams_thread",
            "threadBindingId": thread_id,
            "ownerTaskId": owner_task_id,
        },
        "notifications": {
            "onChange": True,
            "onFailure": True,
            "onRecovery": True,
            "quietWhenUnchanged": True,
            "quietHours": {"start": "22:00", "end": "08:00", "timeZone": "America/New_York"},
            "digest": {
                "enabled": True,
                "schedule": {
                    "kind": "cron",
                    "expression": "0 9 * * *",
                    "timeZone": "America/New_York",
                },
                "maxPerDay": 1,
            },
            "destination": {"kind": "responsibility_thread"},
            "immediateOn": ["blocked_goal", "user_decision", "service_or_auth_outage"],
        },
        "enabled": True,
    }
    with _client(db_path) as client:
        admitted = client.post(
            base + "/connectors/teams-v1/events", json=teams_event, headers=_headers()
        )
        assert admitted.status_code == 200, admitted.text
        assert admitted.json()["task"]["id"] == owner_task_id
        assert (
            client.post(base + f"/tasks/{owner_task_id}/claim", headers=_headers()).json()[
                "claimed"
            ]
            is True
        )
        completed = client.patch(
            base + f"/tasks/{owner_task_id}",
            json={"status": "completed", "output": "Responsibility created."},
            headers=_headers(),
        )
        assert completed.status_code == 200, completed.text

        stored = client.put(
            base + f"/workflows/{workflow_id}?definitionVersion=2",
            json=workflow,
            headers=_headers(),
        )
        assert stored.status_code == 200, stored.text
        assert client.get(base + "/workflows", headers=_headers()).json()["items"] == []
        assert (
            len(
                client.get(base + "/workflows?definitionVersion=2", headers=_headers()).json()[
                    "items"
                ]
            )
            == 1
        )
        canonical_workflow = client.get(
            base + "/workflows?definitionVersion=2", headers=_headers()
        ).json()["items"][0]
        assert canonical_workflow["actionPolicy"]["allowedActions"][0]["sourceWorkflowIds"] == [
            "987654321"
        ]

        invalid_rerun = {
            **workflow,
            "id": "invalid-source-ci",
            "actionPolicy": {
                **workflow["actionPolicy"],
                "allowedActions": [
                    {
                        **workflow["actionPolicy"]["allowedActions"][0],
                        "sourceWorkflowIds": [],
                    }
                ],
            },
        }
        rejected_rerun = client.put(
            base + "/workflows/invalid-source-ci?definitionVersion=2",
            json=invalid_rerun,
            headers=_headers(),
        )
        assert rejected_rerun.status_code == 422
        assert rejected_rerun.json()["code"] == "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID"

        event = {
            "id": event_id,
            "workflowId": workflow_id,
            "triggerId": trigger_id,
            "scheduledAt": scheduled_at,
            "createdAt": scheduled_at,
            "status": "succeeded",
            "changed": True,
            "summary": "A new issue update was found.",
            "baseline": False,
            "checkpoint": {
                "kind": "github_issues_search",
                "watermark": scheduled_at,
                "windowEnd": scheduled_at,
                "complete": True,
                "repositories": [],
            },
        }
        appended = client.post(base + "/schedule-events", json=event, headers=_headers())
        assert appended.status_code == 200, appended.text

        generic = client.post(
            base + "/notifications",
            json={
                "deduplicationKey": "generic-completed-owner-task",
                "type": "teams.message",
                "taskId": owner_task_id,
                "connectorId": "teams-v1",
                "recipient": f"teams:{thread_id}",
                "payload": {**route, "text": "must be denied"},
            },
            headers=_headers(),
        )
        assert generic.status_code == 409
        assert generic.json()["code"] == "WORK_TASK_NOT_ACTIVE"

        notice_body = {
            "occurrenceId": occurrence_id,
            "triggerId": trigger_id,
            "scheduledAt": scheduled_at,
            "kind": "change",
            "summary": "A new issue update was found.",
        }
        notice = client.post(
            base + f"/workflows/{workflow_id}/notices", json=notice_body, headers=_headers()
        )
        assert notice.status_code == 201, notice.text
        payload = notice.json()["notification"]
        assert payload["type"] == "teams.message"
        assert payload["taskId"] == owner_task_id
        assert payload["connectorId"] == "teams-v1"
        assert payload["recipient"] == f"teams:{thread_id}"
        assert payload["payload"]["tenantId"] == tenant_id
        assert payload["payload"]["text"] == "Repository patrol — A new issue update was found."
        assert "teamId" not in notice_body and "recipient" not in notice_body

        replay = client.post(
            base + f"/workflows/{workflow_id}/notices", json=notice_body, headers=_headers()
        )
        assert replay.status_code == 200
        assert replay.json()["duplicate"] is True


def test_teams_service_url_columns_migrate_additively(tmp_path: Path) -> None:
    """Existing thread mappings survive the serviceUrl column migration."""

    db_path = tmp_path / "teams-service-url-migration.sqlite3"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE work_connector_threads (
              organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, connector_id TEXT NOT NULL,
              thread_id TEXT NOT NULL, tenant_id TEXT NOT NULL, team_id TEXT NOT NULL,
              channel_id TEXT NOT NULL, conversation_id TEXT NOT NULL, root_thread_id TEXT NOT NULL,
              session_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              PRIMARY KEY(organization_id,workspace_id,connector_id,thread_id));
            CREATE TABLE work_connector_thread_messages (
              organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, connector_id TEXT NOT NULL,
              thread_id TEXT NOT NULL, message_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
              team_id TEXT NOT NULL, channel_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
              root_thread_id TEXT NOT NULL, actor_issuer TEXT NOT NULL, actor_subject TEXT NOT NULL,
              message_text TEXT NOT NULL, created_at INTEGER NOT NULL,
              PRIMARY KEY(organization_id,workspace_id,connector_id,thread_id,message_id));
            INSERT INTO work_connector_threads VALUES (
              'org-a','w1','teams-v1','thread-1','tenant-1','team-1','channel-1',
              'conversation-1','123456789','teams-session-1',1,1);
            INSERT INTO work_connector_thread_messages VALUES (
              'org-a','w1','teams-v1','thread-1','123456789','tenant-1','team-1','channel-1',
              'conversation-1','123456789','issuer','actor','context',1);
            """
        )

    with _client(db_path), sqlite3.connect(db_path) as conn:
        thread_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(work_connector_threads)")
        }
        message_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(work_connector_thread_messages)")
        }
        assert "service_url" in thread_columns
        assert "service_url" in message_columns
        assert conn.execute(
            "SELECT thread_id,service_url FROM work_connector_threads"
        ).fetchone() == ("thread-1", "")
        assert conn.execute(
            "SELECT message_id,service_url FROM work_connector_thread_messages"
        ).fetchone() == ("123456789", "")


def test_operation_scope_lock_migrates_without_rewriting_existing_receipts(tmp_path: Path) -> None:
    """Branch-lock storage is additive and leaves earlier provider receipts intact."""

    db_path = tmp_path / "operation-scope-lock-migration.sqlite3"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """CREATE TABLE work_operations (
              organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL,
              idempotency_key TEXT NOT NULL, operation_type TEXT NOT NULL,
              task_id TEXT, target TEXT,
              request_json TEXT NOT NULL, status TEXT NOT NULL, evidence_json TEXT NOT NULL,
              request_digest TEXT NOT NULL, created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY(organization_id,workspace_id,operation_id),
              UNIQUE(organization_id,workspace_id,idempotency_key))"""
        )
        conn.execute(
            """INSERT INTO work_operations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                "org-a",
                "w1",
                "legacy-operation",
                "legacy-key",
                "tool.provider.v1:github.branch.delete",
                None,
                "connector-target:legacy",
                "{}",
                "uncertain",
                '{"outcome":"unknown_after_provider_call"}',
                "a" * 64,
                1,
                1,
            ),
        )

    with _client(db_path), sqlite3.connect(db_path) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(work_operations)")}
        assert "scope_lock" in columns
        assert conn.execute(
            "SELECT operation_id,status,scope_lock FROM work_operations"
        ).fetchone() == ("legacy-operation", "uncertain", None)
        indexes = {row[1] for row in conn.execute("PRAGMA index_list(work_operations)")}
        assert "work_operations_scope_lock" in indexes


def test_failed_task_result_notification_keeps_partial_output_and_deduplicates(
    tmp_path: Path,
) -> None:
    """A partial failure reply carries output once. | 部分失败回复保留摘要并仅入队一次。"""

    with _client(tmp_path / "task-partial-failure.sqlite3") as client:
        base = BASE.format(workspace="w1")
        body = _task_body("partial-failure")
        body["metadata"] = {
            "notification": {
                "type": "wecom.message",
                "connectorId": "binding-1",
                "recipient": "bot:7/group/room-1",
                "payload": {
                    "accountId": "account-7",
                    "conversationId": "room-1",
                    "chatType": "group",
                    "senderId": "user-4",
                },
            }
        }
        created = client.post(base + "/tasks", json=body, headers=_headers())
        assert created.status_code == 201, created.text
        claimed = client.post(base + "/tasks/partial-failure/claim", headers=_headers())
        assert claimed.json()["claimed"] is True

        error = "部分子任务无法执行；已继续完成其余可执行工作，详见结果中的无法执行项。"  # noqa: RUF001
        output = (
            "已完成项：已生成目录清单。\n\n无法执行项：network / SANDBOX_BOUNDARY_DENIED count=1。"  # noqa: RUF001
        )
        failed = client.patch(
            base + "/tasks/partial-failure",
            json={"status": "failed", "error": error, "output": output},
            headers=_headers(),
        )
        assert failed.status_code == 200, failed.text

        notifications = client.get(base + "/notifications", headers=_headers())
        items = notifications.json()["items"]
        assert len(items) == 1
        notification = items[0]
        assert notification["deduplicationKey"] == "task-result:partial-failure:failed"
        assert notification["payload"]["text"] == f"{error}\n\n{output}"
        assert notification["payload"]["status"] == "failed"

        replayed = client.patch(
            base + "/tasks/partial-failure",
            json={"status": "failed", "error": error, "output": output},
            headers=_headers(),
        )
        assert replayed.status_code == 200, replayed.text
        assert len(client.get(base + "/notifications", headers=_headers()).json()["items"]) == 1


def test_failed_task_result_notification_truncation_preserves_output_tail(
    tmp_path: Path,
) -> None:
    """The bounded reply retains the blocked-item summary. | 截断后保留无法执行摘要。"""

    with _client(tmp_path / "task-partial-failure-truncated.sqlite3") as client:
        base = BASE.format(workspace="w1")
        body = _task_body("partial-failure-truncated")
        body["metadata"] = {
            "notification": {
                "type": "wecom.message",
                "connectorId": "binding-1",
                "recipient": "bot:7/group/room-1",
                "payload": {
                    "accountId": "account-7",
                    "conversationId": "room-1",
                    "chatType": "group",
                    "senderId": "user-4",
                },
            }
        }
        created = client.post(base + "/tasks", json=body, headers=_headers())
        assert created.status_code == 201, created.text
        claimed = client.post(base + "/tasks/partial-failure-truncated/claim", headers=_headers())
        assert claimed.json()["claimed"] is True

        error = "Partial execution failed; see blocked items in the result."
        blocked_summary = "\n\n无法执行项：network / SANDBOX_BOUNDARY_DENIED count=1。"  # noqa: RUF001
        output = (
            "已完成项：已生成目录清单。\n"  # noqa: RUF001
            + ("前序输出内容。" * 3_000)
            + blocked_summary
        )
        failed = client.patch(
            base + "/tasks/partial-failure-truncated",
            json={"status": "failed", "error": error, "output": output},
            headers=_headers(),
        )
        assert failed.status_code == 200, failed.text

        notifications = client.get(base + "/notifications", headers=_headers())
        text = notifications.json()["items"][0]["payload"]["text"]
        assert len(text) <= 20_000
        assert text.startswith(error + "\n\n已完成项：已生成目录清单。")  # noqa: RUF001
        assert "...[middle task result truncated]..." in text
        assert text.endswith(blocked_summary)


def test_failed_task_result_notification_bounds_error_without_output_or_duplicate_text() -> None:
    """Bound long errors and avoid duplicating short outputs. | 长错误限长且短输出不重复。"""

    error = "e" * 25_000
    without_output = _failed_task_result_notification_text(error, "")
    assert len(without_output) == 19_992
    assert without_output.endswith(" [truncated]")

    with_short_output = _failed_task_result_notification_text(error, "short output")
    assert len(with_short_output) < 20_000
    assert with_short_output.endswith("\n\nshort output")
    assert with_short_output.count("short output") == 1


def test_notification_exact_replay_after_task_completion_is_read_only(tmp_path: Path) -> None:
    """A completed task can replay an exact receipt only. | 完成后仅可重放。"""

    db_path = tmp_path / "notification-replay-after-complete.sqlite3"
    base = BASE.format(workspace="w1")
    task_body = _task_body("notify-replay")
    task_body["metadata"] = {
        "notification": {
            "type": "wecom.message",
            "connectorId": "binding-1",
            "recipient": "bot:7/group/room-1",
            "payload": {
                "accountId": "account-7",
                "conversationId": "room-1",
                "chatType": "group",
                "senderId": "user-4",
            },
        }
    }
    notification_body = {
        "deduplicationKey": "tool-notification-1",
        "type": "wecom.message",
        "connectorId": "binding-1",
        "recipient": "bot:7/group/room-1",
        "taskId": "notify-replay",
        "payload": {"text": "An approved update"},
    }

    with _client(db_path) as client:
        created_task = client.post(base + "/tasks", json=task_body, headers=_headers())
        assert created_task.status_code == 201, created_task.text
        claimed = client.post(base + "/tasks/notify-replay/claim", headers=_headers())
        assert claimed.status_code == 200 and claimed.json()["claimed"] is True
        created_notice = client.post(
            base + "/notifications", json=notification_body, headers=_headers()
        )
        assert created_notice.status_code == 201, created_notice.text
        notification_id = created_notice.json()["notification"]["id"]

        completed = client.patch(
            base + "/tasks/notify-replay",
            json={"status": "completed", "output": "Done", "reasoning": ""},
            headers=_headers(),
        )
        assert completed.status_code == 200, completed.text

    with _client(db_path) as reopened:
        retry = reopened.post(base + "/notifications", json=notification_body, headers=_headers())
        assert retry.status_code == 200, retry.text
        assert retry.json()["duplicate"] is True
        assert retry.json()["notification"]["id"] == notification_id

        modified = {
            **notification_body,
            "payload": {"text": "Different content"},
        }
        conflict = reopened.post(base + "/notifications", json=modified, headers=_headers())
        assert conflict.status_code == 409
        assert conflict.json()["code"] == "WORK_NOTIFICATION_KEY_CONFLICT"

        new_notice = {
            **notification_body,
            "deduplicationKey": "tool-notification-2",
        }
        denied = reopened.post(base + "/notifications", json=new_notice, headers=_headers())
        assert denied.status_code == 409
        assert denied.json()["code"] == "WORK_TASK_NOT_ACTIVE"

        notifications = reopened.get(base + "/notifications", headers=_headers())
        assert notifications.status_code == 200
        items = notifications.json()["items"]
        assert len(items) == 2
        assert {item["deduplicationKey"] for item in items} == {
            "tool-notification-1",
            "task-result:notify-replay:completed",
        }


def test_rejected_task_cannot_begin_operations_or_enqueue_notifications(tmp_path: Path) -> None:
    """Task-scoped tool mutations require a live running task. | 拒绝后禁止工具副作用。"""

    with _client(tmp_path / "task-guard.sqlite3") as client:
        base = BASE.format(workspace="w1")
        created = client.post(base + "/tasks", json=_task_body("guarded"), headers=_headers())
        assert created.status_code == 201
        approval = client.post(
            base + "/tasks/guarded/approvals",
            json={"kind": "send", "summary": "Send message", "messageId": "ask-1"},
            headers=_headers(),
        )
        assert approval.status_code == 201
        approval_id = approval.json()["approval"]["id"]
        rejected = client.post(
            base + f"/approvals/{approval_id}/resolve",
            json={"decision": "rejected", "messageId": "reject-1"},
            headers=_headers(),
        )
        assert rejected.status_code == 200
        assert rejected.json()["task"]["status"] == "aborted"

        notification = client.post(
            base + "/notifications",
            json={
                "deduplicationKey": "after-rejection",
                "type": "test.message",
                "payload": {"text": "should not queue"},
                "taskId": "guarded",
            },
            headers=_headers(),
        )
        operation = client.post(
            base + "/operations",
            json={
                "idempotencyKey": "after-rejection",
                "operationType": "send",
                "request": {},
                "taskId": "guarded",
            },
            headers=_headers(),
        )
        assert notification.status_code == 409
        assert operation.status_code == 409
        assert client.get(base + "/notifications", headers=_headers()).json()["items"] == []


def test_unresolved_operation_query_supports_exact_target_reconciliation(tmp_path: Path) -> None:
    """Expose minimal pending receipts for target fences and operation-ref reconciliation."""

    base = BASE.format(workspace="w1")
    with _client(tmp_path / "operation-reconciliation.sqlite3") as client:
        created = client.post(
            base + "/tasks", json=_task_body("operation-task"), headers=_headers()
        )
        assert created.status_code == 201
        claimed = client.post(base + "/tasks/operation-task/claim", headers=_headers())
        assert claimed.json()["claimed"]
        receipt = client.post(
            base + "/operations",
            json={
                "idempotencyKey": "cloud-stop-1",
                "operationType": "tool.provider.v1:cloud.resource.stop",
                "taskId": "operation-task",
                "target": "connector-target:sha256:exact-vm",
                "request": {"providerId": "azure", "arguments": {"resource_id": "vm-1"}},
            },
            headers=_headers(),
        )
        assert receipt.status_code == 201, receipt.text
        operation_id = receipt.json()["operation"]["id"]
        pending = client.patch(
            base + f"/operations/{operation_id}",
            json={
                "status": "uncertain",
                "evidence": {
                    "providerId": "azure",
                    "profileRef": "azure-profile-1",
                    "operationRef": "operation-remote-1",
                    "outcome": "pending",
                },
            },
            headers=_headers(),
        )
        assert pending.status_code == 200, pending.text

        exact = client.get(
            base + "/operations/unresolved?target=connector-target%3Asha256%3Aexact-vm",
            headers=_headers(),
        )
        assert exact.status_code == 200, exact.text
        assert len(exact.json()["items"]) == 1
        summary = exact.json()["items"][0]
        assert summary["id"] == operation_id
        assert summary["evidence"]["operationRef"] == "operation-remote-1"
        assert "request" not in summary

        duplicate_target = client.post(
            base + "/operations",
            json={
                "idempotencyKey": "cloud-restart-while-stop-pending",
                "operationType": "tool.provider.v1:cloud.resource.restart",
                "taskId": "operation-task",
                "target": "connector-target:sha256:exact-vm",
                "request": {"providerId": "azure", "arguments": {"resource_id": "vm-1"}},
            },
            headers=_headers(),
        )
        assert duplicate_target.status_code == 409
        assert duplicate_target.json()["code"] == "WORK_OPERATION_TARGET_UNRESOLVED"

        verified = client.patch(
            base + f"/operations/{operation_id}",
            json={
                "status": "verified",
                "evidence": {
                    **summary["evidence"],
                    "reconciledByOperationRef": "operation-remote-1",
                    "reconciliationState": "SUCCEEDED",
                },
            },
            headers=_headers(),
        )
        assert verified.status_code == 200, verified.text
        assert client.get(base + "/operations/unresolved", headers=_headers()).json()["items"] == []

        branch_lock = (
            "connector-branch:" + hashlib.sha256(b"profile/repo/cyrene/assistant/test").hexdigest()
        )
        branch_operation = client.post(
            base + "/operations",
            json={
                "idempotencyKey": "branch-delete-locked",
                "operationType": "tool.provider.v1:github.branch.delete",
                "taskId": "operation-task",
                "target": "connector-target:sha256:branch-delete",
                "scopeLock": branch_lock,
                "request": {
                    "operationId": "github.branch.delete",
                    "branch": "cyrene/assistant/test",
                },
            },
            headers=_headers(),
        )
        assert branch_operation.status_code == 201, branch_operation.text
        assert branch_operation.json()["operation"]["scopeLock"] == branch_lock


def test_branch_scope_lock_serializes_provider_writes_across_tasks_and_restart(
    tmp_path: Path,
) -> None:
    """GitHub writes on one branch serialize atomically until their receipt is verified."""

    db_path = tmp_path / "operation-branch-lock.sqlite3"
    scope_lock = "connector-branch:" + hashlib.sha256(b"github-profile/repo/develop").hexdigest()
    store = WorkStore(db_path)

    def start_running_task(task_id: str) -> None:
        task, duplicate = store.create_task("org-a", "w1", _task_body(task_id), actor_id="owner")
        assert not duplicate
        assert task["id"] == task_id
        claimed, running = store.claim_task("org-a", "w1", task_id)
        assert claimed and running["status"] == "running"

    def begin(
        task_id: str,
        idempotency_key: str,
        operation_id: str,
        target: str,
        branch: str,
        lock: str | None,
    ) -> tuple[str, str]:
        try:
            operation, duplicate = store.create_operation(
                "org-a",
                "w1",
                {
                    "idempotencyKey": idempotency_key,
                    "operationType": f"tool.provider.v1:{operation_id}",
                    "taskId": task_id,
                    "target": target,
                    **({"scopeLock": lock} if lock is not None else {}),
                    "request": {
                        "bindingId": "github-binding",
                        "operationId": operation_id,
                        "arguments": {"repository": "owner/repo", "branch": branch},
                    },
                },
            )
            return ("duplicate" if duplicate else "started", str(operation["id"]))
        except PersistenceError as error:
            return (str(error.status), error.code)

    for task_id in (
        "delete-task",
        "commit-task",
        "other-branch-task",
        "readback-task",
        "retry-task",
    ):
        start_running_task(task_id)

    contenders = [
        (
            "delete-task",
            "branch-delete-key",
            "github.branch.delete",
            "connector-target:branch-delete",
            "cyrene/assistant/branch-1",
        ),
        (
            "commit-task",
            "file-commit-key",
            "github.file.commit",
            "connector-target:file-commit",
            "cyrene/assistant/branch-1",
        ),
    ]
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(
                lambda item: begin(*item, scope_lock),
                contenders,
            )
        )
    winners = [result for result in results if result[0] == "started"]
    blocked = [result for result in results if result[0] == "409"]
    assert len(winners) == 1
    assert len(blocked) == 1
    assert blocked[0][1] == "WORK_OPERATION_SCOPE_LOCKED"
    active_operation_id = winners[0][1]

    other_branch_lock = (
        "connector-branch:"
        + hashlib.sha256(b"github-profile/repo/cyrene/assistant/branch-2").hexdigest()
    )
    other_branch, duplicate = store.create_operation(
        "org-a",
        "w1",
        {
            "idempotencyKey": "other-branch-key",
            "operationType": "tool.provider.v1:github.file.commit",
            "taskId": "other-branch-task",
            "target": "connector-target:file-commit-branch-2",
            "scopeLock": other_branch_lock,
            "request": {"operationId": "github.file.commit", "branch": "cyrene/assistant/branch-2"},
        },
    )
    assert not duplicate
    assert other_branch["scopeLock"] == other_branch_lock

    readback, duplicate = store.create_operation(
        "org-a",
        "w1",
        {
            "idempotencyKey": "branch-readback-key",
            "operationType": "tool.provider.v1:github.branch.get",
            "taskId": "readback-task",
            "target": "connector-readback:branch-1",
            "request": {"operationId": "github.branch.get", "branch": "cyrene/assistant/branch-1"},
        },
    )
    assert not duplicate, "a readback has no branch write lock and must remain available"
    assert readback["scopeLock"] is None

    store.update_operation(
        "org-a", "w1", active_operation_id, "uncertain", {"outcome": "unknown_after_provider_call"}
    )
    restarted_store = WorkStore(db_path)
    restarted_task, duplicate = restarted_store.create_task(
        "org-a", "w1", _task_body("restart-retry-task"), actor_id="owner"
    )
    assert not duplicate
    assert restarted_task["id"] == "restart-retry-task"
    claimed, _ = restarted_store.claim_task("org-a", "w1", "restart-retry-task")
    assert claimed
    with pytest.raises(PersistenceError) as error:
        restarted_store.create_operation(
            "org-a",
            "w1",
            {
                "idempotencyKey": "restart-same-branch-key",
                "operationType": "tool.provider.v1:github.file.commit",
                "taskId": "restart-retry-task",
                "target": "connector-target:another-file-on-branch-1",
                "scopeLock": scope_lock,
                "request": {
                    "operationId": "github.file.commit",
                    "branch": "cyrene/assistant/branch-1",
                },
            },
        )
    assert error.value.code == "WORK_OPERATION_SCOPE_LOCKED"

    restarted_store.update_operation(
        "org-a", "w1", active_operation_id, "verified", {"outcome": "verified", "effect": "write"}
    )
    retry_operation, duplicate = restarted_store.create_operation(
        "org-a",
        "w1",
        {
            "idempotencyKey": "verified-branch-retry-key",
            "operationType": "tool.provider.v1:github.file.commit",
            "taskId": "restart-retry-task",
            "target": "connector-target:another-file-on-branch-1",
            "scopeLock": scope_lock,
            "request": {"operationId": "github.file.commit", "branch": "cyrene/assistant/branch-1"},
        },
    )
    assert not duplicate, "verified write receipts release branch serialization"
    assert retry_operation["status"] == "started"


def test_human_input_pauses_resumes_once_and_survives_scope_checks(tmp_path: Path) -> None:
    """Input answers are durable, correlated and one-time. | 输入回答持久且一次性。"""

    db_path = tmp_path / "human-input.sqlite3"
    base = BASE.format(workspace="w1")
    with _client(db_path) as client:
        created_task = client.post(base + "/tasks", json=_task_body("input-1"), headers=_headers())
        assert created_task.status_code == 201
        claimed = client.post(base + "/tasks/input-1/claim", headers=_headers())
        assert claimed.status_code == 200
        assert claimed.json()["task"]["status"] == "running"

        create_url = base + "/tasks/input-1/inputs"
        request = {
            "summary": "Which release should I use?",
            "details": {"choices": ["stable", "preview"]},
            "messageId": "input-request-1",
        }
        created = client.post(create_url, json=request, headers=_headers())
        assert created.status_code == 201, created.text
        receipt = created.json()
        input_record = receipt["input"]
        assert receipt["task"]["status"] == "waiting_input"
        assert input_record["status"] == "pending"
        assert isinstance(input_record["createdAt"], int)
        assert input_record["answeredAt"] is None

        replay = client.post(create_url, json=request, headers=_headers())
        assert replay.status_code == 200
        assert replay.json()["duplicate"] is True
        assert replay.json()["input"]["id"] == input_record["id"]

        pending = client.get(base + "/inputs?status=pending", headers=_headers())
        assert [item["id"] for item in pending.json()["items"]] == [input_record["id"]]
        direct_transition = client.patch(
            base + "/tasks/input-1", json={"status": "running"}, headers=_headers()
        )
        assert direct_transition.status_code == 409

        resolve_url = base + f"/inputs/{input_record['id']}/resolve"
        answer = {"answer": {"text": "stable"}, "messageId": "input-answer-1"}
        resolved = client.post(resolve_url, json=answer, headers=_headers())
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()["task"]["status"] == "running"
        assert resolved.json()["input"]["status"] == "answered"
        assert resolved.json()["input"]["answer"] == {"text": "stable"}
        assert resolved.json()["input"]["answeredBy"] == "owner"
        assert isinstance(resolved.json()["input"]["answeredAt"], int)

        duplicate = client.post(resolve_url, json=answer, headers=_headers())
        assert duplicate.status_code == 200
        assert duplicate.json()["duplicate"] is True
        conflict = client.post(
            resolve_url,
            json={"answer": {"text": "preview"}, "messageId": "input-answer-2"},
            headers=_headers(),
        )
        assert conflict.status_code == 409
        hidden = client.get(base + f"/inputs/{input_record['id']}", headers=_headers("other-org"))
        assert hidden.status_code == 404

    with _client(db_path) as reopened:
        stored = reopened.get(base + f"/inputs/{input_record['id']}", headers=_headers())
        assert stored.status_code == 200
        assert stored.json()["answer"] == {"text": "stable"}


def test_human_input_rejects_credentials_and_oversized_answer_text(tmp_path: Path) -> None:
    """The human-input route rejects secret-shaped fields and long text. | 输入拒绝凭据。"""

    base = BASE.format(workspace="w1")
    with _client(tmp_path / "human-input-validation.sqlite3") as client:
        client.post(base + "/tasks", json=_task_body("input-2"), headers=_headers())
        client.post(base + "/tasks/input-2/claim", headers=_headers())
        create_url = base + "/tasks/input-2/inputs"
        sensitive = client.post(
            create_url,
            json={"summary": "Choose", "details": {"api_key": "do-not-save"}},
            headers=_headers(),
        )
        assert sensitive.status_code == 422
        created = client.post(
            create_url,
            json={"summary": "Choose", "messageId": "safe-request"},
            headers=_headers(),
        )
        input_id = created.json()["input"]["id"]
        resolved = client.post(
            base + f"/inputs/{input_id}/resolve",
            json={"answer": {"text": "a" * 4_001}, "messageId": "long-answer"},
            headers=_headers(),
        )
        assert resolved.status_code == 422
        assert (
            client.get(base + "/inputs?status=pending", headers=_headers()).json()["items"][0]["id"]
            == input_id
        )


def test_attachment_digest_is_authorized_per_workspace(tmp_path: Path) -> None:
    """Content bytes need exact-scope registration. | 附件按空间授权。"""

    with _client(tmp_path / "attachments.sqlite3") as client:
        content = b"small local attachment"
        uploaded = client.post(
            BASE.format(workspace="w1") + "/attachments",
            json={
                "name": "note.txt",
                "mediaType": "text/plain",
                "contentBase64": base64.b64encode(content).decode("ascii"),
            },
            headers=_headers(),
        )
        assert uploaded.status_code == 201, uploaded.text
        attachment = uploaded.json()
        assert attachment["sha256"] == __import__("hashlib").sha256(content).hexdigest()

        downloaded = client.get(
            BASE.format(workspace="w1") + f"/attachments/{attachment['sha256']}",
            headers=_headers(),
        )
        assert downloaded.status_code == 200
        assert downloaded.content == content
        other_workspace = client.get(
            BASE.format(workspace="w2") + f"/attachments/{attachment['sha256']}",
            headers=_headers(),
        )
        assert other_workspace.status_code == 404
        other_org = client.get(
            BASE.format(workspace="w1") + f"/attachments/{attachment['sha256']}",
            headers=_headers("other-org"),
        )
        assert other_org.status_code == 404


def test_qq_bridge_registry_isolated_by_organization_and_workspace(tmp_path: Path) -> None:
    """A shared workspace id cannot select another organization's bridge. | 桥接按组织隔离。"""

    class FakeBridge:
        def __init__(self, identity: str) -> None:
            self.identity = identity
            self.starts = 0
            self.closes = 0

        def start(self) -> None:
            self.starts += 1

        def health(self) -> dict[str, str]:
            return {"identity": self.identity}

        def request_qr(self, params: dict[str, Any]) -> dict[str, Any]:
            assert params == {}
            return {"identity": self.identity, "operation": "qq.login.qr"}

        def poll_login(self, params: dict[str, Any]) -> dict[str, Any]:
            return {"identity": self.identity, "loginId": params["login_id"]}

        def close(self) -> None:
            self.closes += 1

    bridges = {
        ("org-a", "w1", "same-binding"): FakeBridge("org-a"),
        ("org-b", "w1", "same-binding"): FakeBridge("org-b"),
    }
    app = create_persistence_app(
        tmp_path / "bridges.sqlite3", TOKENS, work_connector_bridges=bridges
    )
    with TestClient(app) as client:
        health_url = BASE.format(workspace="w1") + "/connectors/same-binding/health"
        org_a = client.get(health_url, headers=_headers("writer"))
        org_b = client.get(health_url, headers=_headers("other-org"))
        assert org_a.status_code == 200 and org_a.json() == {"identity": "org-a"}
        assert org_b.status_code == 200 and org_b.json() == {"identity": "org-b"}

        connectors = client.get(
            BASE.format(workspace="w1") + "/connectors", headers=_headers("writer")
        )
        seeded = connectors.json()["items"]
        assert len(seeded) == 1
        assert seeded[0]["connectorId"] == "same-binding"
        assert seeded[0]["configured"] is True
        assert seeded[0]["status"] == "unknown"

        other_connectors = client.get(
            BASE.format(workspace="w1") + "/connectors", headers=_headers("other-org")
        )
        assert len(other_connectors.json()["items"]) == 1
        assert other_connectors.json()["items"][0]["configured"] is True
        assert other_connectors.json()["items"][0]["status"] == "unknown"

        login_url = BASE.format(workspace="w1") + "/connectors/same-binding/login/poll"
        polled = client.post(login_url, json={"loginId": "login-1"}, headers=_headers())
        assert polled.status_code == 200
        assert polled.json() == {"identity": "org-a", "loginId": "login-1"}
        connected = client.post(
            BASE.format(workspace="w1") + "/connectors/same-binding/status",
            json={"status": "connected", "accountId": "stale-account"},
            headers=_headers(),
        )
        assert connected.status_code == 200

    restarted = create_persistence_app(
        tmp_path / "bridges.sqlite3", TOKENS, work_connector_bridges=bridges
    )
    with TestClient(restarted) as client:
        reset = client.get(BASE.format(workspace="w1") + "/connectors", headers=_headers("writer"))
        assert reset.status_code == 200
        assert reset.json()["items"][0]["status"] == "unknown"
        assert reset.json()["items"][0]["accountId"] is None
        assert reset.json()["items"][0]["configured"] is True
    assert all(bridge.starts == 2 and bridge.closes == 2 for bridge in bridges.values())


def test_connector_unsupported_errors_are_bounded(tmp_path: Path) -> None:
    """Vendor exception text is never returned from the connector bridge. | 隐藏供应商异常。"""

    class UnsupportedError(RuntimeError):
        code = "UNSUPPORTED"

    class FakeBridge:
        def health(self) -> dict[str, str]:
            raise UnsupportedError("vendor secret and host details")

        def request_qr(self, params: dict[str, Any]) -> dict[str, Any]:
            raise UnsupportedError("vendor secret and host details")

        def poll_login(self, params: dict[str, Any]) -> dict[str, Any]:
            raise UnsupportedError("vendor secret and host details")

        def close(self) -> None:
            return None

    app = create_persistence_app(
        tmp_path / "unsupported.sqlite3",
        TOKENS,
        work_connector_bridges={("org-a", "w1", "qq-binding"): FakeBridge()},
    )
    with TestClient(app) as client:
        response = client.get(
            BASE.format(workspace="w1") + "/connectors/qq-binding/health",
            headers=_headers(),
        )
        assert response.status_code == 503
        assert response.json()["code"] == "CONNECTOR_OPERATION_UNAVAILABLE"
        assert "vendor secret" not in response.text
