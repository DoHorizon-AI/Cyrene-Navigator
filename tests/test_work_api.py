"""Tests for the durable workspace-scoped Work API. | 工作域 API 测试。"""

from __future__ import annotations

import base64
import sqlite3
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from cyrene_navigator.persistence import PersistencePrincipal, create_persistence_app

TOKENS = {
    "writer": PersistencePrincipal(
        "owner", frozenset({"w1", "w2"}), can_takeover=True, organization_id="org-a"
    ),
    "reader": PersistencePrincipal("reader", frozenset({"w1"}), organization_id="org-a"),
    "other-org": PersistencePrincipal(
        "other-owner", frozenset({"w1"}), can_takeover=True, organization_id="org-b"
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
