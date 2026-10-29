"""Tests for the durable workspace-scoped Work API. | 工作域 API 测试。"""

from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from cyrene_navigator.persistence import PersistencePrincipal, create_persistence_app
from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.work.api import TeamsPrivateConversationPolicy
from cyrene_navigator.work.store import (
    WorkStore,
    _digest,
    _failed_task_result_notification_text,
    _quiet_hours_release_ms,
    _validate_automation_event,
    _validate_source_poll_checkpoint,
)

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
    "credential-monitor": PersistencePrincipal(
        "credential-monitor",
        frozenset({"w1"}),
        organization_id="org-a",
        can_publish_credential_health=True,
    ),
    "teams-bridge": PersistencePrincipal(
        "teams-v1",
        frozenset({"w1"}),
        organization_id="org-a",
        can_bind_teams_private_conversations=True,
    ),
    "teams-owner": PersistencePrincipal(
        "11111111-1111-4111-8111-111111111111",
        frozenset({"w1"}),
        can_takeover=True,
        organization_id="org-a",
    ),
    "teams-v2-owner": PersistencePrincipal(
        "22222222-2222-4222-8222-222222222222",
        frozenset({"w1"}),
        can_takeover=True,
        organization_id="org-a",
    ),
    "teams-member": PersistencePrincipal(
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        frozenset({"w1"}),
        can_takeover=True,
        organization_id="org-a",
    ),
    "teams-legacy-actor": PersistencePrincipal(
        "aad-object-1",
        frozenset({"w1"}),
        can_takeover=True,
        organization_id="org-a",
    ),
    "actor-private-owner": PersistencePrincipal(
        "22222222-2222-4222-8222-222222222222",
        frozenset({"w1"}),
        can_takeover=True,
        organization_id="org-a",
        actor_private_scope=True,
    ),
    "actor-private-member": PersistencePrincipal(
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        frozenset({"w1"}),
        can_takeover=True,
        organization_id="org-a",
        actor_private_scope=True,
    ),
}
BASE = "/api/v1/workspaces/{workspace}/work"
_PRIVATE_INSTALL_TEST_BASE = datetime.now(UTC).replace(microsecond=0) - timedelta(days=1)


def _private_activity_time(seconds_after_base: int = 0) -> str:
    """Return a stable, recent synthetic UTC Activity timestamp."""

    return (
        (_PRIVATE_INSTALL_TEST_BASE + timedelta(seconds=seconds_after_base))
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def _client(db_path: Path) -> TestClient:
    """Build the same app factory used by the persistence service. | 创建持久化服务。"""

    return TestClient(create_persistence_app(db_path, TOKENS))


def _headers(token: str = "writer") -> dict[str, str]:
    """Build one configured bearer header. | 构造 bearer 请求头。"""

    return {"Authorization": f"Bearer {token}"}


def _task_body(task_id: str = "task-1") -> dict[str, Any]:
    """Return a minimal stable executor task fixture. | 返回最小任务 fixture。"""

    return {"id": task_id, "sessionId": "session-1", "prompt": "do the work"}


def _automation_event_body(source_event_id: str) -> dict[str, Any]:
    """Return one bounded source observation with synthetic resource identity."""

    return {
        "source": "github",
        "sourceEventId": source_event_id,
        "resourceUri": "urn:cyrene:github:repository:123:issue:7",
        "sourceVersion": 2,
        "eventType": "issue.updated",
        "occurredAt": 1_791_050_400_000,
        "title": "Synthetic issue title",
        "summary": "Synthetic status changed.",
        "severity": "info",
        "semanticFingerprint": "a" * 64,
        "stateClass": "healthy",
        "metadataReferences": [
            {
                "kind": "commit",
                "resourceUri": "https://github.com/DoHorizon-AI/Cyrene-Workspace/commit/"
                + "b" * 40,
                "resourceVersion": "b" * 40,
            }
        ],
    }


def _private_policy(
    path: Path,
    *,
    subjects: list[str] | None = None,
    bot_app_id: str = "33333333-3333-4333-8333-333333333333",
) -> TeamsPrivateConversationPolicy:
    """Write and load a synthetic current owner projection for private Teams tests."""

    tenant_id = "11111111-1111-4111-8111-111111111111"
    issuer = f"https://login.microsoftonline.com/{tenant_id}/v2.0"
    actor_id = "22222222-2222-4222-8222-222222222222"
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "workspaceId": "w1",
                "issuer": issuer,
                "subjects": subjects if subjects is not None else [actor_id],
            }
        ),
        encoding="utf-8",
    )
    return TeamsPrivateConversationPolicy(
        actor_subjects_path=path,
        workspace_id="w1",
        issuer=issuer,
        tenant_id=tenant_id,
        bot_app_id=bot_app_id,
    )


def _teams_channel_task_event(
    actor_id: str,
    message_id: str,
    task_id: str,
    session_id: str,
    text: str,
) -> dict[str, Any]:
    """Build one verified Teams channel intake on the same shared route."""

    tenant_id = "11111111-1111-4111-8111-111111111111"
    return {
        "messageId": message_id,
        "type": "message.received",
        "accountId": "33333333-3333-4333-8333-333333333333",
        "conversationId": "shared-channel-conversation",
        "senderId": actor_id,
        "payload": {"provider": "teams", "messageId": message_id, "text": text},
        "teamsThreadMessage": {
            "threadId": "shared-channel-thread",
            "messageId": message_id,
            "tenantId": tenant_id,
            "teamId": "shared-team",
            "channelId": "shared-channel",
            "conversationId": "shared-channel-conversation",
            "rootThreadId": "shared-root-thread",
            "actorIssuer": f"https://login.microsoftonline.com/{tenant_id}/v2.0",
            "actorSubject": actor_id,
            "text": text,
            "sessionId": session_id,
        },
        "task": {
            "id": task_id,
            "sessionId": session_id,
            "prompt": text,
            "metadata": {},
        },
    }


def _teams_private_task_event(
    message_id: str,
    task_id: str,
    session_id: str,
    text: str,
) -> dict[str, Any]:
    """Build the actor-free private ingress shape accepted by Work."""

    return {
        "messageId": message_id,
        "type": "message.received",
        "payload": {"text": "caller payload is ignored"},
        "teamsPrivateMessage": {"messageId": message_id, "text": text},
        "task": {
            "id": task_id,
            "sessionId": session_id,
            "prompt": text,
            "metadata": {
                "teamsCaller": {"subject": "forged-subject"},
                "teamsThread": {"conversationId": "forged-shared-channel"},
                "notification": {
                    "type": "teams.message",
                    "connectorId": "teams-v1",
                    "recipient": "teams:forged-shared-channel",
                    "payload": {"conversationId": "forged-shared-channel"},
                },
            },
        },
    }


def _private_install_event(
    actor_id: str,
    action: str,
    activity_id: str,
    conversation_id: str,
    *,
    bot_app_id: str = "33333333-3333-4333-8333-333333333333",
    activity_occurred_at: str | None = None,
    service_url: str = "https://smba.trafficmanager.net/amer/",
) -> dict[str, Any]:
    """Build one synthetic, host-verified private installation change."""

    tenant_id = "11111111-1111-4111-8111-111111111111"
    return {
        "eventType": "personal_installation",
        "payload": {"action": action},
        "trust": {
            "version": 1,
            "provider": "teams",
            "conversationKind": "private",
            "installationAction": action,
            "tenantId": tenant_id,
            "actorAadObjectId": actor_id,
            "botAppId": bot_app_id,
            "conversationId": conversation_id,
            "activityId": activity_id,
            "activityOccurredAt": activity_occurred_at or _private_activity_time(),
            "serviceUrl": service_url,
        },
    }


def _client_with_policy(db_path: Path, policy: TeamsPrivateConversationPolicy | None) -> TestClient:
    """Build a persistence client with an optional host-owned private Teams policy."""

    return TestClient(create_persistence_app(db_path, TOKENS, private_conversation_policy=policy))


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
            "availableAt": 0,
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


def test_credential_health_incident_outbox_is_atomic_deduplicated_and_owner_scoped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fresh actionable snapshots notify once, remind after cooldown, and recover once."""

    from datetime import UTC, datetime

    import cyrene_navigator.work.store as work_store_module

    clock = [1_800_000_000_000]
    monkeypatch.setattr(work_store_module, "_unix_ms", lambda: clock[0])
    base = BASE.format(workspace="w1")
    url = base + "/credential-health/snapshots"
    db_path = tmp_path / "credential-health.sqlite3"

    def snapshot(authorization_state: str, generation: int = 4) -> dict[str, Any]:
        checked_at = datetime.fromtimestamp(clock[0] / 1000, UTC).isoformat().replace("+00:00", "Z")
        return {
            "connectionId": "22222222-2222-4222-8222-222222222222",
            "provider": "hf",
            "loginState": "PRESENT",
            "authorizationState": authorization_state,
            "checkedAt": checked_at,
            "expiresAt": "2026-10-26T16:00:00Z",
            "generation": generation,
            "capabilities": [
                {
                    "capabilityId": "model.read",
                    "state": authorization_state,
                    "lastVerifiedAt": checked_at,
                    "expiresAt": None,
                    "reasonCode": "TOKEN_REVOKED" if authorization_state != "VALID" else None,
                }
            ],
            "reasonCode": "TOKEN_REVOKED" if authorization_state != "VALID" else None,
        }

    with _client(db_path) as client:
        denied_owner = client.post(
            url,
            json={
                "organizationId": "org-a",
                "connections": [snapshot("REAUTHORIZATION_REQUIRED")],
            },
            headers=_headers(),
        )
        assert denied_owner.status_code == 403
        wrong_organization = client.post(
            url,
            json={
                "organizationId": "org-b",
                "connections": [snapshot("REAUTHORIZATION_REQUIRED")],
            },
            headers=_headers("credential-monitor"),
        )
        assert wrong_organization.status_code == 403

        def post_snapshots(connections: list[dict[str, Any]]) -> Any:
            return client.post(
                url,
                json={"organizationId": "org-a", "connections": connections},
                headers=_headers("credential-monitor"),
            )

        monitor_cannot_create_tasks = client.post(
            base + "/tasks",
            json=_task_body("monitor-only-task"),
            headers=_headers("credential-monitor"),
        )
        assert monitor_cannot_create_tasks.status_code == 403

        action = [snapshot("REAUTHORIZATION_REQUIRED")]
        first = post_snapshots(action)
        assert first.status_code == 200, first.text
        assert first.json() == {"processed": 1, "stale": 0, "notificationsQueued": 1}
        replay = post_snapshots(action)
        assert replay.status_code == 200
        assert replay.json()["notificationsQueued"] == 0

        unsupported = client.post(
            url,
            json={
                "organizationId": "org-a",
                "connections": [
                    {**snapshot("REAUTHORIZATION_REQUIRED"), "authorizationRef": "secret"}
                ],
            },
            headers=_headers("credential-monitor"),
        )
        assert unsupported.status_code == 422

        generic = client.post(
            base + "/notifications",
            json={
                "deduplicationKey": "model-cannot-forge-system-notice",
                "type": "teams.credential-health",
                "connectorId": "teams-v1",
                "recipient": "teams:credential-health",
                "payload": {"schemaVersion": 1},
            },
            headers=_headers(),
        )
        assert generic.status_code == 422
        assert generic.json()["code"] == "WORK_NOTIFICATION_RESERVED_TYPE"

        unknown = [snapshot("UNKNOWN")]
        assert post_snapshots(unknown).json()["notificationsQueued"] == 0
        unavailable = [snapshot("UNAVAILABLE")]
        assert post_snapshots(unavailable).json()["notificationsQueued"] == 0
        stale_snapshot = snapshot("REAUTHORIZATION_REQUIRED")
        stale_snapshot["checkedAt"] = "2000-01-01T00:00:00Z"
        stale_snapshot["capabilities"][0]["lastVerifiedAt"] = "2000-01-01T00:00:00Z"
        assert post_snapshots([stale_snapshot]).json()["notificationsQueued"] == 0
        clock[0] += 24 * 60 * 60 * 1_000 + 1
        reminder = post_snapshots([snapshot("REAUTHORIZATION_REQUIRED", generation=3)])
        assert reminder.json()["notificationsQueued"] == 1
        assert (
            post_snapshots([snapshot("REAUTHORIZATION_REQUIRED")]).json()["notificationsQueued"]
            == 0
        )

        recovered = post_snapshots([snapshot("VALID", generation=3)])
        assert recovered.json()["notificationsQueued"] == 1
        assert post_snapshots([snapshot("VALID", generation=3)]).json()["notificationsQueued"] == 0

        notices = list(
            reversed(client.get(base + "/notifications", headers=_headers()).json()["items"])
        )
        assert [item["payload"]["event"] for item in notices] == [
            "action_required",
            "reminder",
            "recovered",
        ]
        assert all(item["taskId"] is None for item in notices)
        for item in notices:
            payload = item["payload"]
            assert payload["provider"] == "hf"
            assert "authorizationRef" not in payload
            assert "token" not in payload
            assert "route" not in payload

    reopened = WorkStore(db_path)
    assert reopened.process_credential_health_snapshots(
        "org-a", "w1", [snapshot("VALID", generation=3)]
    ) == {"processed": 1, "stale": 0, "notificationsQueued": 0}


def test_credential_health_accepts_scoped_capability_ids_and_keeps_contract_bounds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Opaque provider scopes pass HTTP/store validation without widening IDs. | 验证范围 ID。"""

    from datetime import UTC, datetime

    import cyrene_navigator.work.store as work_store_module

    clock = [1_800_000_000_000]
    monkeypatch.setattr(work_store_module, "_unix_ms", lambda: clock[0])
    checked_at = datetime.fromtimestamp(clock[0] / 1000, UTC).isoformat().replace("+00:00", "Z")

    def snapshot(connection_id: str, provider: str, capability_id: str) -> dict[str, Any]:
        return {
            "connectionId": connection_id,
            "provider": provider,
            "loginState": "PRESENT",
            "authorizationState": "VALID",
            "checkedAt": checked_at,
            "expiresAt": None,
            "generation": 1,
            "capabilities": [
                {
                    "capabilityId": capability_id,
                    "state": "VALID",
                    "lastVerifiedAt": checked_at,
                    "expiresAt": None,
                    "reasonCode": None,
                }
            ],
            "reasonCode": None,
        }

    snapshots = [
        snapshot("22222222-2222-4222-8222-222222222222", "hf", "model.read"),
        snapshot(
            "33333333-3333-4333-8333-333333333333",
            "azure",
            "azure:subscription-123/rg-production",
        ),
        snapshot(
            "44444444-4444-4444-8444-444444444444",
            "gcp",
            "gcp:project-123/asia-east2-c",
        ),
    ]
    api_db_path = tmp_path / "credential-health-scoped-api.sqlite3"
    api_base = BASE.format(workspace="w1") + "/credential-health/snapshots"

    with _client(api_db_path) as client:
        accepted = client.post(
            api_base,
            json={"organizationId": "org-a", "connections": snapshots},
            headers=_headers("credential-monitor"),
        )
        assert accepted.status_code == 200, accepted.text
        assert accepted.json() == {"processed": 3, "stale": 0, "notificationsQueued": 0}

        boundary_id = "a" + ("b" * 254) + "/"
        assert len(boundary_id) == 256
        boundary = snapshot("55555555-5555-4555-8555-555555555555", "hf", boundary_id)
        boundary_response = client.post(
            api_base,
            json={"organizationId": "org-a", "connections": [boundary]},
            headers=_headers("credential-monitor"),
        )
        assert boundary_response.status_code == 200, boundary_response.text
        assert boundary_response.json() == {
            "processed": 1,
            "stale": 0,
            "notificationsQueued": 0,
        }

        bad_character = snapshot(
            "66666666-6666-4666-8666-666666666666",
            "gcp",
            "gcp:project-123/asia-east2-c?token",
        )
        invalid = client.post(
            api_base,
            json={"organizationId": "org-a", "connections": [bad_character]},
            headers=_headers("credential-monitor"),
        )
        assert invalid.status_code == 422
        assert invalid.json()["code"] == "PERSISTENCE_REQUEST_INVALID"

        too_long = snapshot("77777777-7777-4777-8777-777777777777", "hf", boundary_id + "c")
        oversized = client.post(
            api_base,
            json={"organizationId": "org-a", "connections": [too_long]},
            headers=_headers("credential-monitor"),
        )
        assert oversized.status_code == 422
        assert oversized.json()["code"] == "PERSISTENCE_REQUEST_INVALID"

    with sqlite3.connect(api_db_path) as connection:
        rows = connection.execute(
            """
            SELECT provider, decision
            FROM work_credential_authorization_health
            WHERE organization_id = ? AND workspace_id = ?
            ORDER BY provider, connection_id
            """,
            ("org-a", "w1"),
        ).fetchall()
    assert rows == [
        ("azure", "healthy"),
        ("gcp", "healthy"),
        ("hf", "healthy"),
        ("hf", "healthy"),
    ]

    direct_store = WorkStore(tmp_path / "credential-health-scoped-store.sqlite3")
    assert direct_store.process_credential_health_snapshots("org-a", "w1", snapshots) == {
        "processed": 3,
        "stale": 0,
        "notificationsQueued": 0,
    }
    with pytest.raises(PersistenceError) as error:
        direct_store.process_credential_health_snapshots("org-a", "w1", [bad_character])
    assert error.value.code == "WORK_CREDENTIAL_HEALTH_INVALID"
    assert direct_store.process_credential_health_snapshots("org-a", "w1", [boundary]) == {
        "processed": 1,
        "stale": 0,
        "notificationsQueued": 0,
    }
    with pytest.raises(PersistenceError) as error:
        direct_store.process_credential_health_snapshots("org-a", "w1", [too_long])
    assert error.value.code == "WORK_CREDENTIAL_HEALTH_INVALID"


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


def test_actor_private_same_channel_results_never_enter_shared_claims_and_wait_for_route(
    tmp_path: Path,
) -> None:
    """Actor-private Teams tasks use only the owner's active personal route."""

    db_path = tmp_path / "actor-private-channel-results.sqlite3"
    projection_path = tmp_path / "teams-owner-subjects.json"
    actor_a = "22222222-2222-4222-8222-222222222222"
    actor_b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    policy = _private_policy(projection_path, subjects=[actor_a, actor_b])
    base = BASE.format(workspace="w1")
    owner_headers = _headers("actor-private-owner")
    member_headers = _headers("actor-private-member")
    actors = (
        (actor_a, owner_headers, "private-channel-task-a", "channel-message-a"),
        (actor_b, member_headers, "private-channel-task-b", "channel-message-b"),
    )

    with _client_with_policy(db_path, policy) as client:
        for actor, _headers_value, _task_id, suffix in actors:
            installed = client.post(
                base + "/private-installations/events",
                json=_private_install_event(
                    actor,
                    "add",
                    f"install-{suffix}",
                    f"private-conversation-{suffix}",
                    activity_occurred_at=_private_activity_time(0),
                ),
                headers=_headers("teams-bridge"),
            )
            assert installed.status_code == 200, installed.text

        for actor, actor_headers, task_id, suffix in actors:
            admitted = client.post(
                base + "/connectors/teams-v1/events",
                json=_teams_channel_task_event(
                    actor,
                    suffix,
                    task_id,
                    f"session-{suffix}",
                    f"Private source question from {actor}.",
                ),
                headers=actor_headers,
            )
            assert admitted.status_code == 200, admitted.text
            assert admitted.json()["task"]["createdByActorId"] == actor
            assert client.post(base + f"/tasks/{task_id}/claim", headers=actor_headers).json()[
                "claimed"
            ]
            direct_group_notice = client.post(
                base + "/notifications",
                json={
                    "deduplicationKey": f"private-task-direct-group-{task_id}",
                    "type": "teams.message",
                    "connectorId": "teams-v1",
                    "recipient": "teams:shared-channel-thread",
                    "taskId": task_id,
                    "payload": {"text": "Model-selected shared notice."},
                },
                headers=actor_headers,
            )
            assert direct_group_notice.status_code == 403
            assert direct_group_notice.json()["code"] == "WORK_NOTIFICATION_PRIVATE_ROUTE_REQUIRED"

        revoked_b = client.post(
            base + "/private-installations/events",
            json=_private_install_event(
                actor_b,
                "remove",
                "remove-channel-message-b",
                "private-conversation-channel-message-b",
                activity_occurred_at=_private_activity_time(1),
            ),
            headers=_headers("teams-bridge"),
        )
        assert revoked_b.status_code == 200, revoked_b.text

        outputs = {
            "private-channel-task-a": (owner_headers, "Private answer for actor A."),
            "private-channel-task-b": (member_headers, "Private answer for actor B."),
        }
        for task_id, (actor_headers, output) in outputs.items():
            completed = client.patch(
                base + f"/tasks/{task_id}",
                json={"status": "completed", "output": output},
                headers=actor_headers,
            )
            assert completed.status_code == 200, completed.text

        for actor_headers in (owner_headers, member_headers, _headers("writer")):
            ordinary = client.post(
                base + "/notifications/claim",
                json={
                    "workerId": "shared-channel-worker",
                    "limit": 10,
                    "leaseSeconds": 60,
                    "type": "teams.message",
                    "connectorId": "teams-v1",
                },
                headers=actor_headers,
            )
            assert ordinary.status_code == 200, ordinary.text
            assert ordinary.json()["items"] == []

        owner_notices = client.get(base + "/notifications", headers=owner_headers).json()["items"]
        member_notices = client.get(base + "/notifications", headers=member_headers).json()["items"]
        assert len(owner_notices) == len(member_notices) == 1
        assert (
            owner_notices[0]["recipient"] == member_notices[0]["recipient"] == "teams:owner-private"
        )
        assert owner_notices[0]["payload"]["text"] == "Private answer for actor A."
        assert member_notices[0]["payload"]["text"] == "Private answer for actor B."

        first_private_claim = client.post(
            base + "/private-notifications/claim",
            json={"workerId": "teams-private-worker", "limit": 10, "leaseSeconds": 60},
            headers=_headers("teams-bridge"),
        )
        assert first_private_claim.status_code == 200, first_private_claim.text
        first_items = first_private_claim.json()["items"]
        assert len(first_items) == 1
        assert first_items[0]["teamsPersonalRoute"]["actorAadObjectId"] == actor_a
        assert first_items[0]["teamsPersonalRoute"]["conversationId"] == (
            "private-conversation-channel-message-a"
        )
        assert first_items[0]["notification"]["payload"]["text"] == "Private answer for actor A."

        held_b = next(item for item in member_notices if item["taskId"] == "private-channel-task-b")
        assert held_b["status"] == "queued"
        assert (
            held_b["result"]["deliveryHoldCode"] == "WORK_TEAMS_PRIVATE_INSTALLATION_NOT_CONFIGURED"
        )

        rebound_b = client.post(
            base + "/private-installations/events",
            json=_private_install_event(
                actor_b,
                "add",
                "reinstall-channel-message-b",
                "private-conversation-b-reinstalled",
                activity_occurred_at=_private_activity_time(2),
            ),
            headers=_headers("teams-bridge"),
        )
        assert rebound_b.status_code == 200, rebound_b.text
        second_private_claim = client.post(
            base + "/private-notifications/claim",
            json={"workerId": "teams-private-worker", "limit": 10, "leaseSeconds": 60},
            headers=_headers("teams-bridge"),
        )
        assert second_private_claim.status_code == 200, second_private_claim.text
        second_items = second_private_claim.json()["items"]
        assert len(second_items) == 1
        assert second_items[0]["teamsPersonalRoute"]["actorAadObjectId"] == actor_b
        assert second_items[0]["teamsPersonalRoute"]["conversationId"] == (
            "private-conversation-b-reinstalled"
        )
        assert second_items[0]["notification"]["payload"]["text"] == "Private answer for actor B."


def test_private_claim_skips_revoked_owner_backlog_before_eligible_ack(tmp_path: Path) -> None:
    """A large held backlog cannot starve an eligible current owner acknowledgement."""

    db_path = tmp_path / "private-claim-revoked-backlog.sqlite3"
    projection_path = tmp_path / "teams-owner-subjects.json"
    actor_a = "22222222-2222-4222-8222-222222222222"
    actor_b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    policy = _private_policy(projection_path, subjects=[actor_a, actor_b])
    base = BASE.format(workspace="w1")

    with _client_with_policy(db_path, policy) as client:
        for actor, suffix in ((actor_a, "a"), (actor_b, "b")):
            installed = client.post(
                base + "/private-installations/events",
                json=_private_install_event(
                    actor,
                    "add",
                    f"backlog-install-{suffix}",
                    f"backlog-private-conversation-{suffix}",
                ),
                headers=_headers("teams-bridge"),
            )
            assert installed.status_code == 200, installed.text

        held_ack = client.post(
            base + "/connectors/teams-v1/events",
            json=_teams_private_task_event(
                "revoked-owner-seed-message",
                "revoked-owner-seed-task",
                "revoked-owner-seed-session",
                "A notice held for the former owner.",
            ),
            headers=_headers("actor-private-owner"),
        )
        assert held_ack.status_code == 200, held_ack.text
        held_notice = client.get(
            base + "/notifications", headers=_headers("actor-private-owner")
        ).json()["items"][0]
        held_notice_id = held_notice["id"]

        # Build a realistic old outbox backlog from one accepted private notice. These rows
        # retain its immutable owner/task/origin fields but precede the new owner's request.
        hold_result = json.dumps(
            {"deliveryHoldCode": "WORK_TEAMS_PRIVATE_INSTALLATION_NOT_CONFIGURED"},
            separators=(",", ":"),
        )
        with sqlite3.connect(db_path) as connection:
            connection.row_factory = sqlite3.Row
            seed = connection.execute(
                """SELECT * FROM work_notifications WHERE organization_id='org-a'
                   AND workspace_id='w1' AND notification_id=?""",
                (held_notice_id,),
            ).fetchone()
            assert seed is not None
            columns = tuple(seed.keys())
            seed_values = dict(seed)
            seed_values.update(
                status="queued",
                available_at=0,
                created_at=1,
                updated_at=1,
                worker_id=None,
                lease_token_hash=None,
                lease_expires_at=None,
                started_at=None,
                result_json=hold_result,
            )
            connection.execute(
                "UPDATE work_notifications SET status='queued',available_at=0,created_at=1,"
                "updated_at=1,worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,"
                "started_at=NULL,result_json=? WHERE notification_id=?",
                (hold_result, held_notice_id),
            )
            insert_sql = (
                f"INSERT INTO work_notifications ({','.join(columns)}) VALUES "
                f"({','.join('?' for _ in columns)})"
            )
            for index in range(205):
                duplicate = dict(seed_values)
                duplicate["notification_id"] = f"revoked-owner-held-{index:03}"
                duplicate["deduplication_key"] = f"revoked-owner-held-key-{index:03}"
                duplicate["created_at"] = index + 2
                connection.execute(insert_sql, [duplicate[column] for column in columns])

        removed = client.post(
            base + "/private-installations/events",
            json=_private_install_event(
                actor_a,
                "remove",
                "backlog-remove-a",
                "backlog-private-conversation-a",
                activity_occurred_at=_private_activity_time(1),
            ),
            headers=_headers("teams-bridge"),
        )
        assert removed.status_code == 200, removed.text

        # The policy reads this file on every claim; removing A models a live Directory revoke.
        _private_policy(projection_path, subjects=[actor_b])
        eligible_ack = client.post(
            base + "/connectors/teams-v1/events",
            json=_teams_private_task_event(
                "current-owner-message",
                "current-owner-task",
                "current-owner-session",
                "A request from the still-authorized owner.",
            ),
            headers=_headers("actor-private-member"),
        )
        assert eligible_ack.status_code == 200, eligible_ack.text
        eligible_notice_id = client.get(
            base + "/notifications", headers=_headers("actor-private-member")
        ).json()["items"][0]["id"]

        claimed = client.post(
            base + "/private-notifications/claim",
            json={"workerId": "teams-private-worker", "limit": 1, "leaseSeconds": 60},
            headers=_headers("teams-bridge"),
        )
        assert claimed.status_code == 200, claimed.text
        items = claimed.json()["items"]
        assert len(items) == 1
        assert items[0]["notification"]["id"] == eligible_notice_id
        assert items[0]["teamsPersonalRoute"]["actorAadObjectId"] == actor_b
        assert actor_a not in claimed.text

        with sqlite3.connect(db_path) as connection:
            held_count, held_statuses, held_results = connection.execute(
                """SELECT COUNT(*),COUNT(DISTINCT status),COUNT(DISTINCT result_json)
                   FROM work_notifications WHERE organization_id='org-a' AND workspace_id='w1'
                     AND owner_actor_id=?""",
                (actor_a,),
            ).fetchone()
            eligible_status = connection.execute(
                """SELECT status FROM work_notifications WHERE organization_id='org-a'
                   AND workspace_id='w1' AND notification_id=?""",
                (eligible_notice_id,),
            ).fetchone()[0]
        assert held_count == 206
        assert held_statuses == held_results == 1
        assert eligible_status == "leased"


def test_private_teams_ingress_is_actor_scoped_and_queues_private_final_results(
    tmp_path: Path,
) -> None:
    """Same vendor activity IDs never alias actors or become channel replies."""

    db_path = tmp_path / "private-teams-ingress.sqlite3"
    projection_path = tmp_path / "teams-owner-subjects.json"
    actor_a = "22222222-2222-4222-8222-222222222222"
    actor_b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    policy = _private_policy(projection_path, subjects=[actor_a, actor_b])
    base = BASE.format(workspace="w1")
    owner_headers = _headers("actor-private-owner")
    member_headers = _headers("actor-private-member")
    private_activity_id = "same-vendor-private-activity"

    with _client_with_policy(db_path, policy) as client:
        for actor, suffix in ((actor_a, "a"), (actor_b, "b")):
            installed = client.post(
                base + "/private-installations/events",
                json=_private_install_event(
                    actor,
                    "add",
                    f"private-install-{suffix}",
                    f"private-inbox-{suffix}",
                ),
                headers=_headers("teams-bridge"),
            )
            assert installed.status_code == 200, installed.text

        event_a = _teams_private_task_event(
            private_activity_id,
            "private-inbox-task-a",
            "private-inbox-session-a",
            "Private request text for actor A.",
        )
        event_b = _teams_private_task_event(
            private_activity_id,
            "private-inbox-task-b",
            "private-inbox-session-b",
            "Private request text for actor B.",
        )
        missing_task = {key: value for key, value in event_a.items() if key != "task"}
        rejected_missing_task = client.post(
            base + "/connectors/teams-v1/events",
            json=missing_task,
            headers=owner_headers,
        )
        assert rejected_missing_task.status_code == 422, rejected_missing_task.text
        assert rejected_missing_task.json()["code"] == "WORK_CONNECTOR_PRIVATE_TASK_REQUIRED"
        assert (
            client.get(base + "/connectors/teams-v1/events", headers=owner_headers).json()["events"]
            == []
        )
        assert client.get(base + "/notifications", headers=owner_headers).json()["items"] == []

        receipt_a = client.post(
            base + "/connectors/teams-v1/events", json=event_a, headers=owner_headers
        )
        receipt_b = client.post(
            base + "/connectors/teams-v1/events", json=event_b, headers=member_headers
        )
        assert receipt_a.status_code == receipt_b.status_code == 200
        assert receipt_a.json()["duplicate"] is False
        assert receipt_b.json()["duplicate"] is False
        assert receipt_a.json()["eventId"] != receipt_b.json()["eventId"]
        assert receipt_a.json()["task"]["id"] == "private-inbox-task-a"
        assert receipt_b.json()["task"]["id"] == "private-inbox-task-b"
        assert receipt_a.json()["task"]["createdByActorId"] == actor_a
        assert receipt_b.json()["task"]["createdByActorId"] == actor_b
        assert receipt_a.json()["task"]["metadata"] == {}
        assert receipt_b.json()["task"]["metadata"] == {}
        assert receipt_a.json()["task"]["origin"] == {
            "kind": "teams_private",
            "messageId": private_activity_id,
            "tenantId": "11111111-1111-4111-8111-111111111111",
            "botAppId": "33333333-3333-4333-8333-333333333333",
            "actorAadObjectId": actor_a,
        }
        assert receipt_b.json()["task"]["origin"]["actorAadObjectId"] == actor_b
        assert "conversationId" not in receipt_a.json()["task"]["origin"]
        assert "serviceUrl" not in receipt_a.json()["task"]["origin"]
        assert (
            client.get(base + "/tasks/private-inbox-task-a", headers=member_headers).status_code
            == 404
        )
        assert (
            client.get(base + "/tasks/private-inbox-task-b", headers=owner_headers).status_code
            == 404
        )
        for actor_headers in (owner_headers, member_headers):
            acknowledgement = client.get(base + "/notifications", headers=actor_headers).json()[
                "items"
            ]
            assert len(acknowledgement) == 1
            assert acknowledgement[0]["payload"] == {"text": "Request received. Work is underway."}
        with sqlite3.connect(db_path) as connection:
            origins = connection.execute(
                """SELECT actor_id,thread_id,conversation_kind FROM work_task_teams_origins
                   WHERE organization_id='org-a' AND workspace_id='w1'
                     AND task_id IN ('private-inbox-task-a','private-inbox-task-b')
                   ORDER BY task_id"""
            ).fetchall()
            private_events = connection.execute(
                """SELECT origin_actor_id,conversation_id,payload_json FROM work_connector_events
                   WHERE organization_id='org-a' AND workspace_id='w1'
                     AND message_id=? ORDER BY origin_actor_id""",
                (private_activity_id,),
            ).fetchall()
        assert [row[0] for row in origins] == [actor_a, actor_b]
        assert [row[2] for row in origins] == ["private", "private"]
        assert all(str(row[1]).startswith("teams-private-") for row in origins)
        assert len(private_events) == 2
        assert [(row[0], row[1]) for row in private_events] == [
            (actor_a, None),
            (actor_b, None),
        ]
        assert all("conversationId" not in row[2] for row in private_events)

        replay_a = client.post(
            base + "/connectors/teams-v1/events", json=event_a, headers=owner_headers
        )
        assert replay_a.status_code == 200
        assert replay_a.json()["duplicate"] is True
        assert replay_a.json()["eventId"] == receipt_a.json()["eventId"]
        assert len(client.get(base + "/notifications", headers=owner_headers).json()["items"]) == 1
        conflict_b = client.post(
            base + "/connectors/teams-v1/events",
            json={
                **event_b,
                "teamsPrivateMessage": {
                    "messageId": private_activity_id,
                    "text": "Different private content.",
                },
            },
            headers=member_headers,
        )
        assert conflict_b.status_code == 409
        assert receipt_a.json()["eventId"] not in conflict_b.text
        assert len(client.get(base + "/notifications", headers=member_headers).json()["items"]) == 1

        listed_a = client.get(base + "/connectors/teams-v1/events", headers=owner_headers).json()[
            "events"
        ]
        listed_b = client.get(base + "/connectors/teams-v1/events", headers=member_headers).json()[
            "events"
        ]
        assert [event["payload"]["text"] for event in listed_a] == [
            "Private request text for actor A."
        ]
        assert [event["payload"]["text"] for event in listed_b] == [
            "Private request text for actor B."
        ]
        assert (
            client.get(base + "/connectors/teams-v1/events", headers=_headers("writer")).json()[
                "events"
            ]
            == []
        )

        for task_id, actor_headers, output in (
            ("private-inbox-task-a", owner_headers, "Private answer A."),
            ("private-inbox-task-b", member_headers, "Private answer B."),
        ):
            assert client.post(base + f"/tasks/{task_id}/claim", headers=actor_headers).json()[
                "claimed"
            ]
            completed = client.patch(
                base + f"/tasks/{task_id}",
                json={"status": "completed", "output": output},
                headers=actor_headers,
            )
            assert completed.status_code == 200, completed.text

        for actor_headers in (owner_headers, member_headers, _headers("writer")):
            ordinary = client.post(
                base + "/notifications/claim",
                json={
                    "workerId": "shared-channel-worker",
                    "limit": 10,
                    "leaseSeconds": 60,
                    "type": "teams.message",
                    "connectorId": "teams-v1",
                },
                headers=actor_headers,
            )
            assert ordinary.status_code == 200, ordinary.text
            assert ordinary.json()["items"] == []

        private_claim = client.post(
            base + "/private-notifications/claim",
            json={"workerId": "teams-private-worker", "limit": 10, "leaseSeconds": 60},
            headers=_headers("teams-bridge"),
        )
        assert private_claim.status_code == 200, private_claim.text
        notifications = private_claim.json()["items"]
        assert len(notifications) == 4
        notices_by_actor = {
            actor: [
                item
                for item in notifications
                if item["teamsPersonalRoute"]["actorAadObjectId"] == actor
            ]
            for actor in (actor_a, actor_b)
        }
        assert {item["notification"]["payload"]["text"] for item in notices_by_actor[actor_a]} == {
            "Request received. Work is underway.",
            "Private answer A.",
        }
        assert {item["notification"]["payload"]["text"] for item in notices_by_actor[actor_b]} == {
            "Request received. Work is underway.",
            "Private answer B.",
        }
        assert all(
            item["teamsPersonalRoute"]["conversationId"] == "private-inbox-a"
            for item in notices_by_actor[actor_a]
        )
        assert all(
            item["teamsPersonalRoute"]["conversationId"] == "private-inbox-b"
            for item in notices_by_actor[actor_b]
        )


def test_private_result_is_held_when_origin_bot_app_rotates(tmp_path: Path) -> None:
    """A private task stays bound to its original Teams bot after host rotation."""

    db_path = tmp_path / "private-result-bot-rotation.sqlite3"
    projection_path = tmp_path / "teams-owner-subjects.json"
    actor_id = "22222222-2222-4222-8222-222222222222"
    old_bot = "33333333-3333-4333-8333-333333333333"
    new_bot = "44444444-4444-4444-8444-444444444444"
    old_policy = _private_policy(projection_path)
    base = BASE.format(workspace="w1")
    actor_headers = _headers("actor-private-owner")

    with _client_with_policy(db_path, old_policy) as original_bot:
        installed = original_bot.post(
            base + "/private-installations/events",
            json=_private_install_event(
                actor_id, "add", "old-bot-install", "old-bot-conversation", bot_app_id=old_bot
            ),
            headers=_headers("teams-bridge"),
        )
        assert installed.status_code == 200, installed.text
        admitted = original_bot.post(
            base + "/connectors/teams-v1/events",
            json=_teams_private_task_event(
                "old-bot-private-message",
                "old-bot-private-task",
                "old-bot-private-session",
                "Private task created under the old bot app.",
            ),
            headers=actor_headers,
        )
        assert admitted.status_code == 200, admitted.text
        assert admitted.json()["task"]["origin"]["botAppId"] == old_bot
        claimed = original_bot.post(
            base + "/tasks/old-bot-private-task/claim", headers=actor_headers
        )
        assert claimed.status_code == 200 and claimed.json()["claimed"]

    new_policy = _private_policy(projection_path, bot_app_id=new_bot)
    with _client_with_policy(db_path, new_policy) as rotated_bot:
        installed = rotated_bot.post(
            base + "/private-installations/events",
            json=_private_install_event(
                actor_id,
                "add",
                "new-bot-install",
                "new-bot-conversation",
                bot_app_id=new_bot,
            ),
            headers=_headers("teams-bridge"),
        )
        assert installed.status_code == 200, installed.text
        completed = rotated_bot.patch(
            base + "/tasks/old-bot-private-task",
            json={"status": "completed", "output": "Do not deliver through the new bot."},
            headers=actor_headers,
        )
        assert completed.status_code == 200, completed.text
        notices = rotated_bot.get(base + "/notifications", headers=actor_headers).json()["items"]
        result_notice = next(
            item
            for item in notices
            if item["deduplicationKey"] == "task-result-private:old-bot-private-task:completed"
        )
        assert result_notice["status"] == "queued"
        assert result_notice["result"]["deliveryHoldCode"] == "WORK_TEAMS_PRIVATE_BOT_APP_MISMATCH"

        private_claim = rotated_bot.post(
            base + "/private-notifications/claim",
            json={"workerId": "teams-private-worker", "limit": 10, "leaseSeconds": 60},
            headers=_headers("teams-bridge"),
        )
        assert private_claim.status_code == 200, private_claim.text
        assert private_claim.json()["items"] == []
        refreshed = rotated_bot.get(base + "/notifications", headers=actor_headers).json()["items"]
        result_notice = next(
            item
            for item in refreshed
            if item["deduplicationKey"] == "task-result-private:old-bot-private-task:completed"
        )
        assert result_notice["status"] == "queued"


def test_teams_activity_dedupe_migrates_legacy_global_keys_to_actor_keys(
    tmp_path: Path,
) -> None:
    """Existing connector/origin tables are rebuilt without a Workspace-global Teams key."""

    db_path = tmp_path / "legacy-teams-activity-keys.sqlite3"
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """CREATE TABLE work_tasks (
                organization_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                prompt TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                started_at INTEGER,
                ended_at INTEGER,
                output TEXT NOT NULL DEFAULT '',
                reasoning TEXT NOT NULL DEFAULT '',
                error TEXT,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                sequence INTEGER NOT NULL DEFAULT 0,
                title TEXT,
                description TEXT,
                metadata_json TEXT NOT NULL,
                creation_digest TEXT NOT NULL,
                PRIMARY KEY(organization_id,workspace_id,task_id)
            )"""
        )
        connection.execute(
            """CREATE TABLE work_connector_events (
                organization_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                connector_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                event_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                occurred_at INTEGER NOT NULL,
                received_at INTEGER NOT NULL,
                account_id TEXT,
                conversation_id TEXT,
                sender_id TEXT,
                payload_json TEXT NOT NULL,
                event_digest TEXT NOT NULL,
                task_id TEXT,
                expires_at INTEGER,
                PRIMARY KEY(organization_id,workspace_id,connector_id,seq),
                UNIQUE(organization_id,workspace_id,connector_id,message_id)
            )"""
        )
        connection.execute(
            """CREATE TABLE work_task_teams_origins (
                organization_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                actor_issuer TEXT NOT NULL,
                actor_subject TEXT NOT NULL,
                tenant_id TEXT NOT NULL,
                connector_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY(organization_id,workspace_id,task_id),
                UNIQUE(organization_id,workspace_id,connector_id,message_id),
                FOREIGN KEY(organization_id,workspace_id,task_id)
                  REFERENCES work_tasks(organization_id,workspace_id,task_id) ON DELETE CASCADE
            )"""
        )
        connection.execute(
            """INSERT INTO work_tasks(
                organization_id,workspace_id,task_id,session_id,prompt,status,created_at,
                started_at,ended_at,output,reasoning,error,duration_ms,sequence,title,
                description,metadata_json,creation_digest
            ) VALUES('org-a','w1','legacy-team-task','legacy-team-session','legacy prompt',
                'queued',1,NULL,NULL,'','','legacy error',0,1,NULL,NULL,'{}','legacy-digest')"""
        )
        connection.execute(
            """INSERT INTO work_connector_events(
                organization_id,workspace_id,connector_id,seq,event_id,message_id,event_type,
                occurred_at,received_at,account_id,conversation_id,sender_id,payload_json,
                event_digest,task_id,expires_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                "org-a",
                "w1",
                "teams-v1",
                1,
                "legacy-event",
                "legacy-vendor-message",
                "message.received",
                1,
                1,
                "33333333-3333-4333-8333-333333333333",
                "legacy-channel",
                "22222222-2222-4222-8222-222222222222",
                '{"provider":"teams","text":"legacy body"}',
                "legacy-digest",
                "legacy-team-task",
                None,
            ),
        )
        connection.execute(
            """INSERT INTO work_task_teams_origins(
                organization_id,workspace_id,task_id,actor_id,actor_issuer,actor_subject,
                tenant_id,connector_id,thread_id,message_id,created_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (
                "org-a",
                "w1",
                "legacy-team-task",
                "22222222-2222-4222-8222-222222222222",
                "https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0",
                "22222222-2222-4222-8222-222222222222",
                "11111111-1111-4111-8111-111111111111",
                "teams-v1",
                "legacy-thread-key",
                "legacy-vendor-message",
                1,
            ),
        )

    projection_path = tmp_path / "legacy-teams-owner-subjects.json"
    actor_a = "22222222-2222-4222-8222-222222222222"
    actor_b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    policy = _private_policy(projection_path, subjects=[actor_a, actor_b])
    base = BASE.format(workspace="w1")
    with _client_with_policy(db_path, policy) as client:
        for actor, suffix in ((actor_a, "a"), (actor_b, "b")):
            installed = client.post(
                base + "/private-installations/events",
                json=_private_install_event(
                    actor, "add", f"legacy-install-{suffix}", f"legacy-private-{suffix}"
                ),
                headers=_headers("teams-bridge"),
            )
            assert installed.status_code == 200, installed.text
        for actor, token, suffix in (
            (actor_a, "actor-private-owner", "a"),
            (actor_b, "actor-private-member", "b"),
        ):
            event = _teams_private_task_event(
                "same-legacy-vendor-activity",
                f"legacy-private-task-{suffix}",
                f"legacy-private-session-{suffix}",
                f"Legacy private request {suffix}.",
            )
            admitted = client.post(
                base + "/connectors/teams-v1/events", json=event, headers=_headers(token)
            )
            assert admitted.status_code == 200, admitted.text
            assert admitted.json()["task"]["createdByActorId"] == actor

    with sqlite3.connect(db_path) as connection:
        event_indexes = {
            row[1] for row in connection.execute("PRAGMA index_list(work_connector_events)")
        }
        origin_unique_keys = []
        for index in connection.execute("PRAGMA index_list(work_task_teams_origins)"):
            if index[2] == 1:
                origin_unique_keys.append(
                    tuple(
                        column[2]
                        for column in connection.execute(f'PRAGMA index_info("{index[1]}")')
                    )
                )
        event_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(work_connector_events)")
        }
        origin_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(work_task_teams_origins)")
        }
        legacy_event = connection.execute(
            """SELECT event_id,message_id,task_id,origin_actor_id FROM work_connector_events
               WHERE message_id='legacy-vendor-message'"""
        ).fetchone()
        legacy_origin = connection.execute(
            """SELECT actor_id,actor_subject,message_id,conversation_kind,bot_app_id
               FROM work_task_teams_origins WHERE task_id='legacy-team-task'"""
        ).fetchone()
    assert "work_connector_events_actor_message" in event_indexes
    assert "origin_actor_id" in event_columns
    assert "conversation_kind" in origin_columns
    assert "bot_app_id" in origin_columns
    assert legacy_event == (
        "legacy-event",
        "legacy-vendor-message",
        "legacy-team-task",
        None,
    )
    assert legacy_origin == (
        actor_a,
        actor_a,
        "legacy-vendor-message",
        "channel",
        None,
    )
    assert (
        "organization_id",
        "workspace_id",
        "connector_id",
        "actor_id",
        "message_id",
    ) in origin_unique_keys


def test_private_result_missing_policy_or_origin_is_held_without_public_fallback(
    tmp_path: Path,
) -> None:
    """Private delivery setup failures never roll back a terminal task or use its channel route."""

    actor_id = "22222222-2222-4222-8222-222222222222"
    headers = _headers("actor-private-owner")
    base = BASE.format(workspace="w1")

    policy_db = tmp_path / "private-result-policy-held.sqlite3"
    policy_file = tmp_path / "private-result-policy.json"
    policy = _private_policy(policy_file)
    with _client_with_policy(policy_db, policy) as client:
        admitted = client.post(
            base + "/connectors/teams-v1/events",
            json=_teams_channel_task_event(
                actor_id,
                "policy-held-source-message",
                "policy-held-private-task",
                "policy-held-session",
                "Private work whose delivery policy is unavailable.",
            ),
            headers=headers,
        )
        assert admitted.status_code == 200, admitted.text
        assert client.post(base + "/tasks/policy-held-private-task/claim", headers=headers).json()[
            "claimed"
        ]

    with _client(policy_db) as unconfigured:
        completed = unconfigured.patch(
            base + "/tasks/policy-held-private-task",
            json={"status": "completed", "output": "Must stay owner-private."},
            headers=headers,
        )
        assert completed.status_code == 200, completed.text
        notices = unconfigured.get(base + "/notifications", headers=headers).json()["items"]
        assert len(notices) == 1
        assert notices[0]["status"] == "queued"
        assert (
            notices[0]["result"]["deliveryHoldCode"] == "WORK_TEAMS_PRIVATE_POLICY_NOT_CONFIGURED"
        )
        assert notices[0]["recipient"] == "teams:owner-private"
        ordinary = unconfigured.post(
            base + "/notifications/claim",
            json={"workerId": "shared-channel-worker", "limit": 10, "leaseSeconds": 60},
            headers=headers,
        )
        assert ordinary.status_code == 200 and ordinary.json()["items"] == []

    with _client_with_policy(policy_db, policy) as restored_policy:
        installed = restored_policy.post(
            base + "/private-installations/events",
            json=_private_install_event(
                actor_id,
                "add",
                "install-after-policy-restore",
                "private-after-policy-restore",
            ),
            headers=_headers("teams-bridge"),
        )
        assert installed.status_code == 200, installed.text
        resumed_private_delivery = restored_policy.post(
            base + "/private-notifications/claim",
            json={"workerId": "teams-private-worker", "limit": 10, "leaseSeconds": 60},
            headers=_headers("teams-bridge"),
        )
        assert resumed_private_delivery.status_code == 200, resumed_private_delivery.text
        assert len(resumed_private_delivery.json()["items"]) == 1
        assert (
            resumed_private_delivery.json()["items"][0]["teamsPersonalRoute"]["actorAadObjectId"]
            == actor_id
        )

    missing_origin_db = tmp_path / "private-result-origin-held.sqlite3"
    with _client(missing_origin_db) as client:
        route = {
            "tenantId": "tenant-1",
            "teamId": "team-1",
            "channelId": "channel-1",
            "conversationId": "forged-channel",
            "rootThreadId": "root-1",
        }
        created = client.post(
            base + "/tasks",
            json={
                "id": "missing-private-origin-task",
                "sessionId": "missing-private-origin-session",
                "prompt": "Private owner task without verified Teams ingress.",
                "metadata": {
                    "notification": {
                        "type": "teams.message",
                        "connectorId": "teams-v1",
                        "recipient": "teams:forged-channel",
                        "payload": route,
                    }
                },
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        assert client.post(
            base + "/tasks/missing-private-origin-task/claim", headers=headers
        ).json()["claimed"]
        completed = client.patch(
            base + "/tasks/missing-private-origin-task",
            json={"status": "completed", "output": "Do not send to forged-channel."},
            headers=headers,
        )
        assert completed.status_code == 200, completed.text
        assert client.get(base + "/notifications", headers=headers).json()["items"] == []
        task_events = client.get(
            base + "/tasks/missing-private-origin-task/events", headers=headers
        ).json()["events"]
        assert any(
            event["event"].get("type") == "task.result_delivery_held.v1"
            and event["event"].get("reasonCode") == "verified_teams_origin_not_configured"
            for event in task_events
        )
        ordinary = client.post(
            base + "/notifications/claim",
            json={"workerId": "shared-channel-worker", "limit": 10, "leaseSeconds": 60},
            headers=headers,
        )
        assert ordinary.status_code == 200 and ordinary.json()["items"] == []


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
    actor_id = "11111111-1111-4111-8111-111111111111"
    tenant_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    issuer = f"https://login.microsoftonline.com/{tenant_id}/v2.0"
    event = {
        "messageId": "teams:activity-hash",
        "type": "message.received",
        "accountId": "bot-app-1",
        "conversationId": "conversation-1",
        "senderId": actor_id,
        "payload": {
            "messageId": "activity-hash",
            "provider": "teams",
            "text": "Inspect the repository status.",
        },
        "teamsThreadMessage": {
            "threadId": "thread-activity-hash",
            "messageId": "activity-hash",
            "tenantId": tenant_id,
            "teamId": "team-1",
            "channelId": "channel-1",
            "conversationId": "conversation-1",
            "rootThreadId": "1698765432100",
            "actorIssuer": issuer,
            "actorSubject": actor_id,
            "text": "Inspect the repository status.",
            "sessionId": "teams-session-hash",
        },
        "task": {
            "id": "teams-task-hash",
            "sessionId": "teams-session-hash",
            "prompt": "Inspect the repository status.",
            "metadata": {"teamsCaller": {"issuer": issuer, "subject": actor_id}},
        },
    }
    actor_headers = _headers("teams-owner")
    with _client(db_path) as client:
        first = client.post(base + "/connectors/teams-v1/events", json=event, headers=actor_headers)
        assert first.status_code == 200, first.text
        receipt = first.json()
        assert receipt["duplicate"] is False
        assert receipt["task"]["id"] == "teams-task-hash"
        replay = client.post(
            base + "/connectors/teams-v1/events", json=event, headers=actor_headers
        )
        assert replay.status_code == 200, replay.text
        assert replay.json()["duplicate"] is True
        assert replay.json()["task"]["id"] == receipt["task"]["id"]

    with _client(db_path) as reopened:
        replay = reopened.post(
            base + "/connectors/teams-v1/events", json=event, headers=actor_headers
        )
        assert replay.status_code == 200, replay.text
        assert replay.json()["duplicate"] is True
        assert (
            reopened.get(base + "/tasks/teams-task-hash", headers=actor_headers).json()[
                "createdByActorId"
            ]
            == actor_id
        )
        changed = {**event, "payload": {**event["payload"], "text": "Changed replay"}}
        conflict = reopened.post(
            base + "/connectors/teams-v1/events", json=changed, headers=actor_headers
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
    owner_headers = _headers("teams-owner")
    member_headers = _headers("teams-member")
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
            base + "/connectors/teams-v1/events", json=member_event, headers=member_headers
        )
        assert member_receipt.status_code == 200, member_receipt.text
        assert member_receipt.json()["task"] is None
        context_before_owner = client.get(
            base + f"/connectors/teams-v1/threads/{thread['threadId']}", headers=member_headers
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
            headers=member_headers,
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
            base + "/connectors/teams-v1/events", json=owner_event, headers=owner_headers
        )
        assert admitted.status_code == 200, admitted.text
        assert admitted.json()["task"]["sessionId"] == "teams-session-1"
        context = client.get(
            base + f"/connectors/teams-v1/threads/{thread['threadId']}", headers=owner_headers
        )
        assert context.status_code == 200
        record = context.json()
        assert record["sessionId"] == "teams-session-1"
        assert [item["actorSubject"] for item in record["messages"]] == [owner_id]
        member_context = client.get(
            base + f"/connectors/teams-v1/threads/{thread['threadId']}", headers=member_headers
        )
        assert [item["actorSubject"] for item in member_context.json()["messages"]] == [member_id]
        excluded = client.get(
            base
            + f"/connectors/teams-v1/threads/{thread['threadId']}"
            + "?exclude_message_id=owner-message-1",
            headers=owner_headers,
        )
        assert excluded.json()["messages"] == []

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
            base + "/connectors/teams-v1/events", json=mismatched_session, headers=owner_headers
        )
        assert rejected.status_code == 409
        assert (
            client.get(base + "/tasks/teams-owner-task-2", headers=owner_headers).status_code == 404
        )


def test_verified_teams_task_and_thread_reads_are_actor_scoped_even_for_workspace_owner(
    tmp_path: Path,
) -> None:
    """Teams provenance hides task output, thread text, events, and ACP mappings cross-actor."""

    db_path = tmp_path / "teams-actor-isolation.sqlite3"
    base = BASE.format(workspace="w1")
    tenant_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    issuer = f"https://login.microsoftonline.com/{tenant_id}/v2.0"
    owner_id = "11111111-1111-4111-8111-111111111111"
    member_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    owner_headers = _headers("teams-owner")
    member_headers = _headers("teams-member")
    thread_id = "c" * 64
    thread = {
        "threadId": thread_id,
        "tenantId": tenant_id,
        "teamId": "team-1",
        "channelId": "channel-1",
        "conversationId": "conversation-1",
        "rootThreadId": "root-1",
        "serviceUrl": "https://smba.trafficmanager.net/emea/",
    }

    def event(actor_id: str, message_id: str, text: str, *, task: bool = False) -> dict[str, Any]:
        record: dict[str, Any] = {
            "messageId": f"event-{message_id}",
            "type": "message.received",
            "accountId": "bot-app-1",
            "conversationId": "conversation-1",
            "senderId": actor_id,
            "payload": {"messageId": message_id, "provider": "teams", "text": text},
            "teamsThreadMessage": {
                **thread,
                "messageId": message_id,
                "actorIssuer": issuer,
                "actorSubject": actor_id,
                "text": text,
                **({"sessionId": "owner-session-1"} if task else {}),
            },
        }
        if task:
            record["task"] = {
                "id": "teams-owner-private-task",
                "sessionId": "owner-session-1",
                "prompt": text,
                "metadata": {
                    "teamsCaller": {"issuer": "forged", "subject": member_id},
                    "output": "owner-only output",
                },
            }
        return record

    with _client(db_path) as client:
        admitted = client.post(
            base + "/connectors/teams-v1/events",
            json=event(owner_id, "owner-message", "OWNER PRIVATE TEXT", task=True),
            headers=owner_headers,
        )
        assert admitted.status_code == 200, admitted.text
        assert admitted.json()["task"]["createdByActorId"] == owner_id
        assert admitted.json()["task"]["metadata"]["teamsCaller"]["subject"] == owner_id
        forged = client.post(
            base + "/connectors/teams-v1/events",
            json=event(owner_id, "forged-by-member", "FORGED TEXT", task=True),
            headers=member_headers,
        )
        assert forged.status_code == 403
        assert forged.json()["code"] == "WORK_CONNECTOR_TEAMS_ACTOR_MISMATCH"

        member_message = client.post(
            base + "/connectors/teams-v1/events",
            json=event(member_id, "member-message", "MEMBER PRIVATE TEXT"),
            headers=member_headers,
        )
        assert member_message.status_code == 200, member_message.text

        assert client.get(base + "/tasks", headers=member_headers).status_code == 200
        assert all(
            item["id"] != "teams-owner-private-task"
            for item in client.get(base + "/tasks", headers=member_headers).json()["items"]
        )
        assert (
            client.get(base + "/tasks/teams-owner-private-task", headers=member_headers).status_code
            == 404
        )
        assert (
            client.get(
                base + "/tasks/teams-owner-private-task/events", headers=member_headers
            ).status_code
            == 404
        )
        assert (
            client.get(base + "/tasks/teams-owner-private-task", headers=_headers()).status_code
            == 404
        )
        assert all(
            item["id"] != "teams-owner-private-task"
            for item in client.get(base + "/tasks", headers=_headers()).json()["items"]
        )
        assert (
            client.get(
                base + "/tasks/teams-owner-private-task/events", headers=_headers()
            ).status_code
            == 404
        )

        owner_thread = client.get(
            base + f"/connectors/teams-v1/threads/{thread_id}", headers=owner_headers
        )
        member_thread = client.get(
            base + f"/connectors/teams-v1/threads/{thread_id}", headers=member_headers
        )
        assert owner_thread.status_code == member_thread.status_code == 200
        assert [item["text"] for item in owner_thread.json()["messages"]] == ["OWNER PRIVATE TEXT"]
        assert [item["text"] for item in member_thread.json()["messages"]] == [
            "MEMBER PRIVATE TEXT"
        ]
        assert (
            client.get(
                base + f"/connectors/teams-v1/threads/{thread_id}", headers=_headers()
            ).status_code
            == 404
        )

        owner_events = client.get(
            base + "/connectors/teams-v1/events", headers=owner_headers
        ).json()["events"]
        member_events = client.get(
            base + "/connectors/teams-v1/events", headers=member_headers
        ).json()["events"]
        shared_reader_events = client.get(
            base + "/connectors/teams-v1/events", headers=_headers()
        ).json()["events"]
        assert [item["senderId"] for item in owner_events] == [owner_id]
        assert [item["senderId"] for item in member_events] == [member_id]
        assert shared_reader_events == []

        assert client.post(
            base + "/tasks/teams-owner-private-task/claim", headers=owner_headers
        ).json()["claimed"]
        mapping_url = base + "/tasks/teams-owner-private-task/backend-session?backend=codebuddy-acp"
        bound = client.put(
            base + "/tasks/teams-owner-private-task/backend-session",
            json={"backend": "codebuddy-acp", "nativeSessionId": "owner-native-session"},
            headers=owner_headers,
        )
        assert bound.status_code == 200
        assert client.get(mapping_url, headers=owner_headers).json()["nativeSessionId"] == (
            "owner-native-session"
        )
        assert client.get(mapping_url, headers=member_headers).status_code == 404

        other_task = client.post(
            base + "/tasks",
            json={
                "id": "member-same-session-task",
                "sessionId": "owner-session-1",
                "prompt": "A separate generic task.",
            },
            headers=member_headers,
        )
        assert other_task.status_code == 201
        assert client.post(
            base + "/tasks/member-same-session-task/claim", headers=member_headers
        ).json()["claimed"]
        assert (
            client.get(
                base + "/tasks/member-same-session-task/backend-session?backend=codebuddy-acp",
                headers=member_headers,
            ).status_code
            == 404
        )
        assert (
            client.put(
                base + "/tasks/member-same-session-task/backend-session",
                json={"backend": "codebuddy-acp", "nativeSessionId": "attacker-rebind"},
                headers=member_headers,
            ).status_code
            == 404
        )


def test_actor_private_principals_get_private_task_memory_and_attachment_rows(
    tmp_path: Path,
) -> None:
    """New actor-private host principals cannot read another actor's new Work rows."""

    db_path = tmp_path / "actor-private-work-rows.sqlite3"
    base = BASE.format(workspace="w1")
    owner_headers = _headers("actor-private-owner")
    member_headers = _headers("actor-private-member")
    shared_headers = _headers()

    with _client(db_path) as client:
        shared = client.post(
            base + "/memory/facts",
            json={"namespace": "project", "key": "shared", "value": {"text": "shared fact"}},
            headers=shared_headers,
        )
        assert shared.status_code == 200, shared.text
        private = client.post(
            base + "/memory/facts",
            json={
                "namespace": "project",
                "key": "private",
                "value": {"text": "owner private fact"},
            },
            headers=owner_headers,
        )
        assert private.status_code == 200, private.text
        owner_facts = client.get(base + "/memory/facts", headers=owner_headers).json()["items"]
        member_facts = client.get(base + "/memory/facts", headers=member_headers).json()["items"]
        shared_facts = client.get(base + "/memory/facts", headers=shared_headers).json()["items"]
        assert {item["key"] for item in owner_facts} == {"shared", "private"}
        assert {item["key"] for item in member_facts} == {"shared"}
        assert {item["key"] for item in shared_facts} == {"shared"}
        assert (
            client.post(
                base + "/memory/query",
                json={"query": "owner private fact", "limit": 10},
                headers=member_headers,
            ).json()["items"]
            == []
        )

        owner_task = client.post(
            base + "/tasks", json=_task_body("private-owner-task"), headers=owner_headers
        )
        member_task = client.post(
            base + "/tasks", json=_task_body("private-member-task"), headers=member_headers
        )
        assert owner_task.status_code == member_task.status_code == 201
        assert client.get(base + "/tasks", headers=owner_headers).json()["items"] == [
            owner_task.json()
        ]
        assert client.get(base + "/tasks", headers=member_headers).json()["items"] == [
            member_task.json()
        ]
        assert (
            client.get(base + "/tasks/private-owner-task", headers=member_headers).status_code
            == 404
        )
        assert (
            client.get(base + "/tasks/private-owner-task", headers=shared_headers).status_code
            == 404
        )

        private_bytes = b"actor-private attachment"
        private_upload = client.post(
            base + "/attachments",
            json={
                "name": "owner.txt",
                "mediaType": "text/plain",
                "contentBase64": base64.b64encode(private_bytes).decode("ascii"),
            },
            headers=owner_headers,
        )
        assert private_upload.status_code == 201, private_upload.text
        private_digest = private_upload.json()["sha256"]
        assert (
            client.get(base + f"/attachments/{private_digest}", headers=owner_headers).content
            == private_bytes
        )
        assert (
            client.get(base + f"/attachments/{private_digest}", headers=member_headers).status_code
            == 404
        )
        assert (
            client.get(base + f"/attachments/{private_digest}", headers=shared_headers).status_code
            == 404
        )

        shared_bytes = b"workspace shared attachment"
        shared_upload = client.post(
            base + "/attachments",
            json={
                "name": "shared.txt",
                "mediaType": "text/plain",
                "contentBase64": base64.b64encode(shared_bytes).decode("ascii"),
            },
            headers=shared_headers,
        )
        assert shared_upload.status_code == 201, shared_upload.text
        shared_digest = shared_upload.json()["sha256"]
        assert (
            client.get(base + f"/attachments/{shared_digest}", headers=owner_headers).content
            == shared_bytes
        )


def test_v3_quiet_hours_defer_non_immediate_notice_until_local_end() -> None:
    """Private non-immediate notices respect the stored timezone across midnight."""

    from datetime import datetime
    from zoneinfo import ZoneInfo

    quiet_hours = {"start": "22:00", "end": "08:00", "timeZone": "America/New_York"}
    zone = ZoneInfo("America/New_York")
    quiet_now = int(datetime(2026, 10, 27, 22, 15, tzinfo=zone).timestamp() * 1_000)
    expected_release = int(datetime(2026, 10, 28, 8, 0, tzinfo=zone).timestamp() * 1_000)
    assert _quiet_hours_release_ms(quiet_now, quiet_hours) == expected_release
    daytime = int(datetime(2026, 10, 27, 10, 0, tzinfo=zone).timestamp() * 1_000)
    assert _quiet_hours_release_ms(daytime, quiet_hours) is None


def test_v3_event_intents_are_actor_salted_durable_and_source_errors_need_host_receipts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """V3 source decisions use actor-salted occurrence identity and honest error evidence."""

    import cyrene_navigator.work.store as work_store_module

    # This multi-request test claims immediate notices; a monotonic fixture prevents a host
    # wall-clock correction from making a just-created notice appear scheduled in the future.
    clock = [int(datetime.now(UTC).timestamp() * 1_000)]

    def monotonic_work_clock() -> int:
        clock[0] += 1
        return clock[0]

    monkeypatch.setattr(work_store_module, "_unix_ms", monotonic_work_clock)

    db_path = tmp_path / "v3-event-intents.sqlite3"
    actor_file = tmp_path / "teams-owner-subjects.json"
    member_actor_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    policy = _private_policy(
        actor_file,
        subjects=["22222222-2222-4222-8222-222222222222", member_actor_id],
    )
    base = BASE.format(workspace="w1")
    actor_id = "22222222-2222-4222-8222-222222222222"
    tenant_id = "11111111-1111-4111-8111-111111111111"
    owner_headers = _headers("actor-private-owner")
    trigger_id = "github-five-minute"
    workflow_id = "owner-repo-watch"
    source_target_id = "123456"
    source = "github"
    resource_uri = f"cyrene://workflow-sources/{source}/{source_target_id}"
    workflow = {
        "id": workflow_id,
        "version": 3,
        "title": "Repository watch",
        "description": "Observe one host-bound repository.",
        "targets": [
            {
                "id": source_target_id,
                "label": "DoHorizon-AI/Cyrene-Workspace",
                "kind": "github_repository",
                "bindingId": "github-binding-1",
                "uri": "https://github.com/DoHorizon-AI/Cyrene-Workspace",
            }
        ],
        "triggers": [
            {
                "id": trigger_id,
                "kind": "source_poll",
                "source": source,
                "targetIds": [source_target_id],
                "schedule": {"kind": "cron", "expression": "*/5 * * * *", "timeZone": "UTC"},
                "pageSize": 10,
                "maxPages": 4,
            }
        ],
        "authorization": {"kind": "owner_private", "ownerTaskId": "teams-owner-origin-task"},
        "notifications": {"destination": {"kind": "owner_private"}},
        "enabled": True,
    }

    def event_body(
        source_event_id: str, event_type: str, state: str, fingerprint: str, at: int
    ) -> dict[str, Any]:
        return {
            "source": source,
            "sourceEventId": source_event_id,
            "resourceUri": resource_uri,
            "sourceVersion": source_event_id,
            "eventType": event_type,
            "occurredAt": at,
            "summary": f"{event_type} for configured repository.",
            "semanticFingerprint": fingerprint,
            "stateClass": state,
        }

    def occurrence(scheduled_at: str) -> str:
        actor_ref = hashlib.sha256(actor_id.encode("utf-8")).hexdigest()[:16]
        suffix = hashlib.sha256(
            f"{workflow_id}\0{trigger_id}\0{scheduled_at}\0{actor_ref}".encode()
        ).hexdigest()[:40]
        return "occ-" + suffix

    def create_running_occurrence(
        client: TestClient, scheduled_at: str, baseline: bool
    ) -> tuple[str, str]:
        occurrence_id = occurrence(scheduled_at)
        task_id = "workflow-" + occurrence_id[4:]
        metadata = {
            "source": "workflow",
            "workflowId": workflow_id,
            "triggerId": trigger_id,
            "occurrenceId": occurrence_id,
            "authorizationRef": workflow["authorization"],
        }
        created = client.post(
            base + "/tasks",
            json={
                "id": task_id,
                "sessionId": task_id,
                "prompt": "Run a bounded poll.",
                "metadata": metadata,
            },
            headers=owner_headers,
        )
        assert created.status_code == 201, created.text
        claimed = client.post(base + f"/tasks/{task_id}/claim", headers=owner_headers)
        assert claimed.status_code == 200 and claimed.json()["claimed"]
        running = {
            "id": f"schedule-{occurrence_id}-running",
            "workflowId": workflow_id,
            "triggerId": trigger_id,
            "scheduledAt": scheduled_at,
            "createdAt": scheduled_at,
            "status": "running",
            "taskId": task_id,
            "baseline": baseline,
            "evidence": [],
            "operationIds": [],
            "actionTaskIds": [],
        }
        schedule_receipt = client.post(
            base + "/schedule-events", json=running, headers=owner_headers
        )
        assert schedule_receipt.status_code == 200, schedule_receipt.text
        return occurrence_id, task_id

    def append_page_receipt(
        client: TestClient,
        task_id: str,
        occurrence_id: str,
        scheduled_at: str,
        event_id: str,
        source_event_id: str,
    ) -> None:
        page = {
            "type": "workflow.source-page.v1",
            "workflowId": workflow_id,
            "triggerId": trigger_id,
            "occurrenceId": occurrence_id,
            "scheduledAt": scheduled_at,
            "source": source,
            "targetId": source_target_id,
            "pageCursor": None,
            "nextCursor": None,
            "windowStart": None,
            "windowEnd": scheduled_at,
            "complete": True,
            "truncated": False,
            "automationEventIds": [event_id],
            "sourceEventIds": [source_event_id],
            "observedAt": scheduled_at,
        }
        receipt = client.post(
            base + f"/tasks/{task_id}/events",
            json={"messageId": f"page-{event_id}", "event": page},
            headers=owner_headers,
        )
        assert receipt.status_code == 200, receipt.text

    def decide(
        client: TestClient, event_id: str, occurrence_id: str, task_id: str, scheduled_at: str
    ) -> Any:
        return client.post(
            base + f"/automation-events/{event_id}/notices",
            json={
                "workflowId": workflow_id,
                "triggerId": trigger_id,
                "occurrenceId": occurrence_id,
                "scheduledAt": scheduled_at,
                "taskId": task_id,
            },
            headers=owner_headers,
        )

    with _client_with_policy(db_path, policy) as client:
        private_installation = {
            "eventType": "personal_installation",
            "payload": {"action": "add"},
            "trust": {
                "version": 1,
                "provider": "teams",
                "conversationKind": "private",
                "installationAction": "add",
                "tenantId": tenant_id,
                "actorAadObjectId": actor_id,
                "botAppId": "33333333-3333-4333-8333-333333333333",
                "conversationId": "private-conversation-1",
                "activityId": "private-install-1",
                "activityOccurredAt": _private_activity_time(),
                "serviceUrl": "https://smba.trafficmanager.net/amer/",
            },
        }
        bound = client.post(
            base + "/private-installations/events",
            json=private_installation,
            headers=_headers("teams-bridge"),
        )
        assert bound.status_code == 200, bound.text

        owner_message = {
            "messageId": "owner-message-v3",
            "type": "message.received",
            "accountId": "33333333-3333-4333-8333-333333333333",
            "conversationId": "team-conversation-1",
            "senderId": actor_id,
            "payload": {
                "messageId": "owner-message-v3",
                "provider": "teams",
                "text": "Create my private source watch.",
            },
            "teamsThreadMessage": {
                "threadId": "v3-owner-thread",
                "messageId": "owner-message-v3",
                "tenantId": tenant_id,
                "teamId": "team-1",
                "channelId": "channel-1",
                "conversationId": "team-conversation-1",
                "rootThreadId": "root-v3",
                "actorIssuer": f"https://login.microsoftonline.com/{tenant_id}/v2.0",
                "actorSubject": actor_id,
                "text": "Create my private source watch.",
                "sessionId": "owner-v3-session",
            },
            "task": {
                "id": "teams-owner-origin-task",
                "sessionId": "owner-v3-session",
                "prompt": "Create my private source watch.",
                "metadata": {},
            },
        }
        admitted = client.post(
            base + "/connectors/teams-v1/events", json=owner_message, headers=owner_headers
        )
        assert admitted.status_code == 200, admitted.text
        stored = client.put(
            base + f"/workflows/{workflow_id}?definitionVersion=3",
            json=workflow,
            headers=owner_headers,
        )
        assert stored.status_code == 200, stored.text

        member_headers = _headers("actor-private-member")
        member_installation = {
            **private_installation,
            "trust": {
                **private_installation["trust"],
                "actorAadObjectId": member_actor_id,
                "conversationId": "private-conversation-member",
                "activityId": "private-install-v3-member",
            },
        }
        member_bound = client.post(
            base + "/private-installations/events",
            json=member_installation,
            headers=_headers("teams-bridge"),
        )
        assert member_bound.status_code == 200, member_bound.text
        member_message = {
            "messageId": "member-message-v3",
            "type": "message.received",
            "accountId": "33333333-3333-4333-8333-333333333333",
            "conversationId": "team-conversation-member",
            "senderId": member_actor_id,
            "payload": {
                "messageId": "member-message-v3",
                "provider": "teams",
                "text": "Create my separate private source watch.",
            },
            "teamsThreadMessage": {
                **owner_message["teamsThreadMessage"],
                "threadId": "v3-member-thread",
                "messageId": "member-message-v3",
                "conversationId": "team-conversation-member",
                "rootThreadId": "root-member-v3",
                "actorSubject": member_actor_id,
                "text": "Create my separate private source watch.",
                "sessionId": "member-v3-session",
            },
            "task": {
                "id": "teams-member-origin-task",
                "sessionId": "member-v3-session",
                "prompt": "Create my separate private source watch.",
                "metadata": {},
            },
        }
        member_admitted = client.post(
            base + "/connectors/teams-v1/events",
            json=member_message,
            headers=member_headers,
        )
        assert member_admitted.status_code == 200, member_admitted.text
        member_workflow = json.loads(json.dumps(workflow))
        member_workflow["id"] = "member-repo-watch"
        member_workflow["authorization"] = {
            "kind": "owner_private",
            "ownerTaskId": "teams-member-origin-task",
        }
        member_stored = client.put(
            base + f"/workflows/{member_workflow['id']}?definitionVersion=3",
            json=member_workflow,
            headers=member_headers,
        )
        assert member_stored.status_code == 200, member_stored.text

        baseline_at = "2026-10-27T12:00:00Z"
        baseline_occurrence, baseline_task = create_running_occurrence(
            client, baseline_at, baseline=True
        )
        baseline_event = event_body(
            "baseline-event", "pull_request.opened", "healthy", "a" * 64, 1_798_097_600_000
        )
        baseline_receipt = client.post(
            base + "/automation-events", json=baseline_event, headers=owner_headers
        )
        assert baseline_receipt.status_code == 201, baseline_receipt.text
        baseline_event_id = baseline_receipt.json()["id"]
        append_page_receipt(
            client,
            baseline_task,
            baseline_occurrence,
            baseline_at,
            baseline_event_id,
            "baseline-event",
        )
        baseline_decision = decide(
            client, baseline_event_id, baseline_occurrence, baseline_task, baseline_at
        )
        assert baseline_decision.status_code == 201, baseline_decision.text
        assert baseline_decision.json()["decision"] == "initial_baseline"
        assert client.get(base + "/notifications", headers=owner_headers).json()["items"] == []

        failure_at = "2026-10-27T12:05:00Z"
        failure_occurrence, failure_task = create_running_occurrence(
            client, failure_at, baseline=True
        )
        reason_code = "timeout"
        failure_fingerprint = hashlib.sha256(
            f"cyrene.source-poll.failure.v1:{reason_code}".encode()
        ).hexdigest()
        failure_event = event_body(
            "source-failure-timeout",
            "source.poll.failure",
            "incident",
            failure_fingerprint,
            1_798_097_900_000,
        )
        failure_event["resourceUri"] = resource_uri
        failure_receipt = client.post(
            base + "/automation-events", json=failure_event, headers=owner_headers
        )
        assert failure_receipt.status_code == 201, failure_receipt.text
        failure_event_id = failure_receipt.json()["id"]
        source_error = {
            "type": "workflow.source-error.v1",
            "workflowId": workflow_id,
            "triggerId": trigger_id,
            "occurrenceId": failure_occurrence,
            "scheduledAt": failure_at,
            "source": source,
            "targetId": source_target_id,
            "windowStart": None,
            "windowEnd": failure_at,
            "outcome": "failed",
            "reasonCode": reason_code,
            "observedAt": failure_at,
        }
        source_error_receipt = client.post(
            base + f"/tasks/{failure_task}/events",
            json={"messageId": "source-error-failure-1", "event": source_error},
            headers=owner_headers,
        )
        assert source_error_receipt.status_code == 200, source_error_receipt.text
        failure_decision = decide(
            client, failure_event_id, failure_occurrence, failure_task, failure_at
        )
        assert failure_decision.status_code == 201, failure_decision.text
        assert failure_decision.json()["decision"] == "failure"
        pending_owner_notices = client.get(base + "/notifications", headers=owner_headers).json()[
            "items"
        ]
        assert len(pending_owner_notices) == 1
        assert "configured repository" in pending_owner_notices[0]["payload"]["text"]

        # A replay in a new occurrence reuses the durable event decision instead of dropping it.
        replay_at = "2026-10-27T12:10:00Z"
        replay_occurrence, replay_task = create_running_occurrence(
            client, replay_at, baseline=False
        )
        replay_source_event = client.post(
            base + "/automation-events", json=failure_event, headers=owner_headers
        )
        assert replay_source_event.status_code == 200
        replayed_decision = decide(
            client, failure_event_id, replay_occurrence, replay_task, replay_at
        )
        assert replayed_decision.status_code == 200, replayed_decision.text
        assert replayed_decision.json()["decision"] == "failure"
        assert replayed_decision.json()["duplicate"] is True
        assert len(client.get(base + "/notifications", headers=owner_headers).json()["items"]) == 1

        # A recovery needs a real complete page and the fixed healthy fingerprint.
        recovery_at = "2026-10-27T12:15:00Z"
        recovery_occurrence, recovery_task = create_running_occurrence(
            client, recovery_at, baseline=False
        )
        recovery_fingerprint = hashlib.sha256(b"cyrene.source-poll.healthy.v1").hexdigest()
        recovery_body = event_body(
            "source-recovery-1",
            "source.poll.recovery",
            "healthy",
            recovery_fingerprint,
            1_798_098_500_000,
        )
        recovery_receipt = client.post(
            base + "/automation-events", json=recovery_body, headers=owner_headers
        )
        assert recovery_receipt.status_code == 201, recovery_receipt.text
        recovery_event_id = recovery_receipt.json()["id"]
        append_page_receipt(
            client,
            recovery_task,
            recovery_occurrence,
            recovery_at,
            recovery_event_id,
            "source-recovery-1",
        )
        recovered = decide(
            client, recovery_event_id, recovery_occurrence, recovery_task, recovery_at
        )
        assert recovered.status_code == 201, recovered.text
        assert recovered.json()["decision"] == "recovery"

        changed_at = "2026-10-27T12:20:00Z"
        changed_occurrence, changed_task = create_running_occurrence(
            client, changed_at, baseline=False
        )
        changed_event_body = event_body(
            "material-change-1", "pull_request.updated", "healthy", "c" * 64, 1_798_098_800_000
        )
        changed_event = client.post(
            base + "/automation-events", json=changed_event_body, headers=owner_headers
        )
        assert changed_event.status_code == 201, changed_event.text
        changed_event_id = changed_event.json()["id"]
        append_page_receipt(
            client,
            changed_task,
            changed_occurrence,
            changed_at,
            changed_event_id,
            "material-change-1",
        )
        changed_decision = decide(
            client, changed_event_id, changed_occurrence, changed_task, changed_at
        )
        assert changed_decision.status_code == 201, changed_decision.text
        assert changed_decision.json()["decision"] == "change"
        assert len(client.get(base + "/notifications", headers=owner_headers).json()["items"]) == 2
        assert (
            client.patch(
                base + f"/tasks/{changed_task}",
                json={"status": "completed", "output": "One material update."},
                headers=owner_headers,
            ).status_code
            == 200
        )
        terminal_source_receipt = {
            "id": f"schedule-{changed_occurrence}-succeeded",
            "workflowId": workflow_id,
            "triggerId": trigger_id,
            "scheduledAt": changed_at,
            "createdAt": changed_at,
            "status": "succeeded",
            "changed": True,
            "summary": "Material source update from immutable schedule receipt.",
            "baseline": False,
            "taskId": changed_task,
            "checkpoint": {
                "kind": "source_poll",
                "windowStart": None,
                "windowEnd": changed_at,
                "complete": True,
                "sources": [
                    {
                        "source": source,
                        "targetId": source_target_id,
                        "pageCursor": None,
                        "resumeCursor": "training-sequence:opaque-next-window-token",
                        "watermark": changed_at,
                        "complete": True,
                        "pagesCollected": 1,
                        "seenEventIds": [],
                        "states": [],
                    }
                ],
            },
        }
        source_terminal = client.post(
            base + "/schedule-events", json=terminal_source_receipt, headers=owner_headers
        )
        assert source_terminal.status_code == 200, source_terminal.text

        # The same provider sourceEventId can be observed in two actor-private
        # workflows without sharing either stored body or private notice route.
        member_scheduled_at = "2026-10-27T12:20:00Z"
        member_actor_ref = hashlib.sha256(member_actor_id.encode("utf-8")).hexdigest()[:16]
        member_occurrence_id = (
            "occ-"
            + hashlib.sha256(
                f"{member_workflow['id']}\0{trigger_id}\0{member_scheduled_at}\0"
                f"{member_actor_ref}".encode()
            ).hexdigest()[:40]
        )
        member_task_id = "workflow-" + member_occurrence_id[4:]
        member_task_metadata = {
            "source": "workflow",
            "workflowId": member_workflow["id"],
            "triggerId": trigger_id,
            "occurrenceId": member_occurrence_id,
            "authorizationRef": member_workflow["authorization"],
        }
        member_run_task = client.post(
            base + "/tasks",
            json={
                "id": member_task_id,
                "sessionId": member_task_id,
                "prompt": "Run the member's private source poll.",
                "metadata": member_task_metadata,
            },
            headers=member_headers,
        )
        assert member_run_task.status_code == 201, member_run_task.text
        member_claim = client.post(base + f"/tasks/{member_task_id}/claim", headers=member_headers)
        assert member_claim.status_code == 200 and member_claim.json()["claimed"]
        member_running_receipt = {
            "id": f"schedule-{member_occurrence_id}-running",
            "workflowId": member_workflow["id"],
            "triggerId": trigger_id,
            "scheduledAt": member_scheduled_at,
            "createdAt": member_scheduled_at,
            "status": "running",
            "taskId": member_task_id,
            "baseline": False,
            "evidence": [],
            "operationIds": [],
            "actionTaskIds": [],
        }
        member_running = client.post(
            base + "/schedule-events",
            json=member_running_receipt,
            headers=member_headers,
        )
        assert member_running.status_code == 200, member_running.text

        member_event_body = event_body(
            "source-failure-timeout",
            "source.poll.failure",
            "incident",
            failure_fingerprint,
            1_798_097_900_000,
        )
        member_event_body["summary"] = "Member-private source diagnostic."
        member_event = client.post(
            base + "/automation-events", json=member_event_body, headers=member_headers
        )
        assert member_event.status_code == 201, member_event.text
        member_event_id = member_event.json()["id"]
        assert member_event.json()["sourceEventId"] == failure_receipt.json()["sourceEventId"]
        member_source_error = {
            "type": "workflow.source-error.v1",
            "workflowId": member_workflow["id"],
            "triggerId": trigger_id,
            "occurrenceId": member_occurrence_id,
            "scheduledAt": member_scheduled_at,
            "source": source,
            "targetId": source_target_id,
            "windowStart": None,
            "windowEnd": member_scheduled_at,
            "outcome": "failed",
            "reasonCode": reason_code,
            "observedAt": member_scheduled_at,
        }
        member_error_receipt = client.post(
            base + f"/tasks/{member_task_id}/events",
            json={"messageId": "member-source-error-v3", "event": member_source_error},
            headers=member_headers,
        )
        assert member_error_receipt.status_code == 200, member_error_receipt.text
        member_notice = client.post(
            base + f"/automation-events/{member_event_id}/notices",
            json={
                "workflowId": member_workflow["id"],
                "triggerId": trigger_id,
                "occurrenceId": member_occurrence_id,
                "scheduledAt": member_scheduled_at,
                "taskId": member_task_id,
            },
            headers=member_headers,
        )
        assert member_notice.status_code == 201, member_notice.text
        assert member_notice.json()["decision"] == "failure"

        owner_events = client.get(base + "/automation-events", headers=owner_headers).json()[
            "items"
        ]
        member_events = client.get(base + "/automation-events", headers=member_headers).json()[
            "items"
        ]
        owner_same_id = next(
            item for item in owner_events if item["sourceEventId"] == "source-failure-timeout"
        )
        member_same_id = next(
            item for item in member_events if item["sourceEventId"] == "source-failure-timeout"
        )
        assert owner_same_id["id"] != member_same_id["id"]
        assert owner_same_id["summary"] == failure_event["summary"]
        assert member_same_id["summary"] == "Member-private source diagnostic."
        assert all(item["actorId"] == actor_id for item in owner_events)
        assert all(item["actorId"] == member_actor_id for item in member_events)

        owner_notices = client.get(base + "/notifications", headers=owner_headers).json()["items"]
        member_notices = client.get(base + "/notifications", headers=member_headers).json()["items"]
        assert any(
            item["id"] == failure_decision.json()["notificationId"]
            and item["payload"]["text"] == failure_event["summary"]
            for item in owner_notices
        )
        assert any(
            item["id"] == member_notice.json()["notificationId"]
            and item["payload"]["text"] == "Member-private source diagnostic."
            for item in member_notices
        )
        assert all(
            item["payload"]["text"] != "Member-private source diagnostic." for item in owner_notices
        )
        assert all(item["payload"]["text"] != failure_event["summary"] for item in member_notices)

        cross_owner_notice = client.post(
            base + f"/automation-events/{member_event_id}/notices",
            json={
                "workflowId": workflow_id,
                "triggerId": trigger_id,
                "occurrenceId": failure_occurrence,
                "scheduledAt": failure_at,
                "taskId": failure_task,
            },
            headers=owner_headers,
        )
        assert cross_owner_notice.status_code == 404
        assert "Member-private source diagnostic." not in cross_owner_notice.text

        digest_at = "2026-10-27T13:00:00Z"
        digest_actor_ref = hashlib.sha256(actor_id.encode("utf-8")).hexdigest()[:16]
        digest_occurrence = (
            "occ-"
            + hashlib.sha256(
                f"{workflow_id}\0daily-digest\0{digest_at}\0{digest_actor_ref}".encode()
            ).hexdigest()[:40]
        )
        digest_task = "workflow-" + digest_occurrence[4:]
        digest_metadata = {
            "source": "workflow",
            "workflowId": workflow_id,
            "triggerId": "daily-digest",
            "occurrenceId": digest_occurrence,
            "authorizationRef": workflow["authorization"],
        }
        digest_created = client.post(
            base + "/tasks",
            json={
                "id": digest_task,
                "sessionId": digest_task,
                "prompt": "Create the daily digest.",
                "metadata": digest_metadata,
            },
            headers=owner_headers,
        )
        assert digest_created.status_code == 201, digest_created.text
        assert client.post(base + f"/tasks/{digest_task}/claim", headers=owner_headers).json()[
            "claimed"
        ]
        assert (
            client.patch(
                base + f"/tasks/{digest_task}",
                json={"status": "completed", "output": "identity-only receipt"},
                headers=owner_headers,
            ).status_code
            == 200
        )
        digest_terminal_receipt = {
            "id": f"schedule-{digest_occurrence}-succeeded",
            "workflowId": workflow_id,
            "triggerId": "daily-digest",
            "scheduledAt": digest_at,
            "createdAt": digest_at,
            "status": "succeeded",
            "changed": True,
            "summary": "Client summary is not authoritative.",
            "taskId": digest_task,
        }
        digest_terminal = client.post(
            base + "/schedule-events", json=digest_terminal_receipt, headers=owner_headers
        )
        assert digest_terminal.status_code == 200, digest_terminal.text
        digest_notice_body = {
            "occurrenceId": digest_occurrence,
            "triggerId": "daily-digest",
            "scheduledAt": digest_at,
            "taskId": digest_task,
        }
        digest_notice = client.post(
            base + f"/workflows/{workflow_id}/notices",
            json=digest_notice_body,
            headers=owner_headers,
        )
        assert digest_notice.status_code == 201, digest_notice.text
        digest_text = digest_notice.json()["notification"]["payload"]["text"]
        assert "Material source update from immutable schedule receipt." in digest_text
        assert "Client summary is not authoritative." not in digest_text
        digest_replay = client.post(
            base + f"/workflows/{workflow_id}/notices",
            json=digest_notice_body,
            headers=owner_headers,
        )
        assert digest_replay.status_code == 200, digest_replay.text
        assert digest_replay.json()["duplicate"] is True

        lease = client.post(
            base + "/private-notifications/claim",
            json={"workerId": "teams-host", "limit": 10, "leaseSeconds": 60},
            headers=_headers("teams-bridge"),
        )
        assert lease.status_code == 200, lease.text
        private_leases = lease.json()["items"]
        assert {item["teamsPersonalRoute"]["actorAadObjectId"] for item in private_leases} == {
            actor_id,
            member_actor_id,
        }
        assert any(
            item["teamsPersonalRoute"]["actorAadObjectId"] == actor_id
            and item["notification"]["payload"]["text"] == failure_event["summary"]
            for item in private_leases
        )
        assert any(
            item["teamsPersonalRoute"]["actorAadObjectId"] == member_actor_id
            and item["notification"]["payload"]["text"] == "Member-private source diagnostic."
            for item in private_leases
        )


def test_v2_workflow_notice_projects_from_completed_owner_task_without_generic_notification_bypass(
    tmp_path: Path,
) -> None:
    """Only the typed v2 route can reply through a completed owner Teams task."""

    db_path = tmp_path / "workflow-teams-notice.sqlite3"
    base = BASE.format(workspace="w1")
    owner_headers = _headers("teams-v2-owner")
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
            base + "/connectors/teams-v1/events", json=teams_event, headers=owner_headers
        )
        assert admitted.status_code == 200, admitted.text
        assert admitted.json()["task"]["id"] == owner_task_id
        assert (
            client.post(base + f"/tasks/{owner_task_id}/claim", headers=owner_headers).json()[
                "claimed"
            ]
            is True
        )
        completed = client.patch(
            base + f"/tasks/{owner_task_id}",
            json={"status": "completed", "output": "Responsibility created."},
            headers=owner_headers,
        )
        assert completed.status_code == 200, completed.text

        stored = client.put(
            base + f"/workflows/{workflow_id}?definitionVersion=2",
            json=workflow,
            headers=owner_headers,
        )
        assert stored.status_code == 200, stored.text
        assert client.get(base + "/workflows", headers=owner_headers).json()["items"] == []
        assert (
            len(
                client.get(base + "/workflows?definitionVersion=2", headers=owner_headers).json()[
                    "items"
                ]
            )
            == 1
        )
        canonical_workflow = client.get(
            base + "/workflows?definitionVersion=2", headers=owner_headers
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
            headers=owner_headers,
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
        appended = client.post(base + "/schedule-events", json=event, headers=owner_headers)
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
            headers=owner_headers,
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
            base + f"/workflows/{workflow_id}/notices", json=notice_body, headers=owner_headers
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
            base + f"/workflows/{workflow_id}/notices", json=notice_body, headers=owner_headers
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


def test_unresolved_operation_query_is_actor_scoped_for_private_work_tokens(tmp_path: Path) -> None:
    """Actor-private task operations are visible only to their authenticated actor."""

    base = BASE.format(workspace="w1")
    with _client(tmp_path / "private-operation-reconciliation.sqlite3") as client:
        owner_headers = _headers("actor-private-owner")
        created = client.post(
            base + "/tasks",
            json=_task_body("private-operation-task"),
            headers=owner_headers,
        )
        assert created.status_code == 201, created.text
        claimed = client.post(base + "/tasks/private-operation-task/claim", headers=owner_headers)
        assert claimed.status_code == 200 and claimed.json()["claimed"]
        receipt = client.post(
            base + "/operations",
            json={
                "idempotencyKey": "private-operation-1",
                "operationType": "tool.provider.v1:github.actions.rerun_failed",
                "taskId": "private-operation-task",
                "target": "connector-target:sha256:private-repository",
                "request": {"providerId": "github", "arguments": {"run_id": 17}},
            },
            headers=owner_headers,
        )
        assert receipt.status_code == 201, receipt.text
        operation_id = receipt.json()["operation"]["id"]
        uncertain = client.patch(
            base + f"/operations/{operation_id}",
            json={"status": "uncertain", "evidence": {"outcome": "pending"}},
            headers=owner_headers,
        )
        assert uncertain.status_code == 200, uncertain.text

        owner_items = client.get(base + "/operations/unresolved", headers=owner_headers)
        other_items = client.get(
            base + "/operations/unresolved", headers=_headers("actor-private-member")
        )
        assert (
            owner_items.status_code == 200 and owner_items.json()["items"][0]["id"] == operation_id
        )
        assert other_items.status_code == 200 and other_items.json()["items"] == []


def test_source_poll_resume_cursor_is_separate_from_incomplete_page_cursor() -> None:
    """A provider sequence can resume a later window after page completion."""

    checkpoint = {
        "kind": "source_poll",
        "windowStart": None,
        "windowEnd": "2026-10-27T13:00:00Z",
        "complete": True,
        "sources": [
            {
                "source": "training",
                "targetId": "yield-training",
                "pageCursor": None,
                "resumeCursor": "opaque-sequence:125",
                "watermark": "2026-10-27T13:00:00Z",
                "complete": True,
                "pagesCollected": 1,
                "seenEventIds": [],
                "states": [],
            }
        ],
    }
    normalized = _validate_source_poll_checkpoint(checkpoint)
    assert normalized["sources"][0]["resumeCursor"] == "opaque-sequence:125"

    partial = {
        **checkpoint,
        "complete": False,
        "sources": [
            {
                **checkpoint["sources"][0],
                "pageCursor": "opaque-page:next",
                "resumeCursor": "opaque-sequence:125",
                "watermark": None,
                "complete": False,
            }
        ],
    }
    with pytest.raises(PersistenceError):
        _validate_source_poll_checkpoint(partial)


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


def test_automation_events_are_immutable_actor_scoped_and_restart_safe(tmp_path: Path) -> None:
    """Retries, cursor pages, and SQLite restart preserve private event identity."""

    db_path = tmp_path / "automation-events.sqlite3"
    path = BASE.format(workspace="w1") + "/automation-events"
    with _client(db_path) as client:
        first_body = _automation_event_body("provider-event-1")
        created = client.post(path, json=first_body, headers=_headers())
        assert created.status_code == 201, created.text
        first = created.json()
        assert first["duplicate"] is False
        assert first["actorId"] == "owner"
        assert first["organizationId"] == "org-a"
        assert first["workspaceId"] == "w1"
        assert first["visibility"] == "owner"
        assert first["semanticFingerprint"] == "a" * 64
        assert "ownerId" not in first and "grant" not in first

        replay = client.post(path, json=first_body, headers=_headers())
        assert replay.status_code == 200
        assert replay.json()["duplicate"] is True
        assert replay.json()["id"] == first["id"]
        assert replay.json()["observedAt"] == first["observedAt"]

        changed_retry = {**first_body, "summary": "Changed content."}
        conflict = client.post(path, json=changed_retry, headers=_headers())
        assert conflict.status_code == 409
        assert conflict.json()["code"] == "WORK_AUTOMATION_EVENT_ID_CONFLICT"

        cross_actor = client.post(path, json=first_body, headers=_headers("other-writer"))
        assert cross_actor.status_code == 201, cross_actor.text
        second = cross_actor.json()
        assert second["duplicate"] is False
        assert second["id"] != first["id"]
        assert second["actorId"] == "another-owner"
        cross_actor_replay = client.post(path, json=first_body, headers=_headers("other-writer"))
        assert cross_actor_replay.status_code == 200
        assert cross_actor_replay.json()["duplicate"] is True
        assert cross_actor_replay.json()["id"] == second["id"]
        cross_actor_conflict = client.post(
            path,
            json={**first_body, "summary": "A different private projection."},
            headers=_headers("other-writer"),
        )
        assert cross_actor_conflict.status_code == 409
        assert first["id"] not in cross_actor_conflict.text

        for index in (2, 3):
            response = client.post(
                path,
                json=_automation_event_body(f"provider-event-{index}"),
                headers=_headers(),
            )
            assert response.status_code == 201, response.text

        page = client.get(path + "?limit=2", headers=_headers())
        assert page.status_code == 200
        first_page = page.json()
        assert len(first_page["items"]) == 2
        assert first_page["nextCursor"] is not None
        assert {item["actorId"] for item in first_page["items"]} == {"owner"}
        outsider_page = client.get(path, headers=_headers("other-writer"))
        assert outsider_page.status_code == 200
        assert outsider_page.json()["nextCursor"] is None
        assert len(outsider_page.json()["items"]) == 1
        assert outsider_page.json()["items"][0]["id"] == second["id"]
        assert outsider_page.json()["items"][0]["actorId"] == "another-owner"
        other_org_page = client.get(path, headers=_headers("other-org"))
        assert other_org_page.json() == {"items": [], "nextCursor": None}
        ordinary_reader = client.get(path, headers=_headers("reader"))
        assert ordinary_reader.status_code == 403

        spoofed_actor = client.post(
            path,
            json={**_automation_event_body("spoofed"), "actorId": "owner"},
            headers=_headers(),
        )
        assert spoofed_actor.status_code == 422
        unsafe_uri = client.post(
            path,
            json={
                **_automation_event_body("unsafe-uri"),
                "resourceUri": "https://example.test/?token=x",
            },
            headers=_headers(),
        )
        assert unsafe_uri.status_code == 422

    with _client(db_path) as restarted:
        next_page = restarted.get(
            path + "?limit=2&cursor=" + first_page["nextCursor"],
            headers=_headers(),
        )
        assert next_page.status_code == 200
        assert len(next_page.json()["items"]) == 1
        listed = restarted.get(path + "?limit=100", headers=_headers())
        assert len(listed.json()["items"]) == 3
        assert {item["sourceEventId"] for item in listed.json()["items"]} == {
            "provider-event-1",
            "provider-event-2",
            "provider-event-3",
        }


def test_automation_event_actor_key_migrates_legacy_rows_without_losing_retries(
    tmp_path: Path,
) -> None:
    """The legacy global key is rebuilt without changing stored event identity."""

    db_path = tmp_path / "legacy-automation-events.sqlite3"
    source_event = _validate_automation_event(_automation_event_body("shared-provider-event"))
    legacy_event = {
        **source_event,
        "id": "legacy-event-id",
        "observedAt": 1_790_000_000_000,
        "actorId": "owner",
        "organizationId": "org-a",
        "workspaceId": "w1",
        "revision": 1,
        "visibility": "owner",
    }
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """CREATE TABLE work_automation_events (
                row_id INTEGER PRIMARY KEY AUTOINCREMENT,
                organization_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                source TEXT NOT NULL,
                source_event_id TEXT NOT NULL,
                event_id TEXT NOT NULL UNIQUE,
                actor_id TEXT NOT NULL,
                observed_at INTEGER NOT NULL,
                event_json TEXT NOT NULL,
                event_digest TEXT NOT NULL,
                visibility TEXT NOT NULL CHECK(visibility='owner'),
                UNIQUE(organization_id,workspace_id,source,source_event_id)
            )"""
        )
        connection.execute(
            """INSERT INTO work_automation_events(
                organization_id,workspace_id,source,source_event_id,event_id,actor_id,
                observed_at,event_json,event_digest,visibility
            ) VALUES(?,?,?,?,?,?,?,?,?,'owner')""",
            (
                "org-a",
                "w1",
                source_event["source"],
                source_event["sourceEventId"],
                legacy_event["id"],
                "owner",
                legacy_event["observedAt"],
                json.dumps(legacy_event, sort_keys=True, separators=(",", ":")),
                _digest(source_event),
            ),
        )

    path = BASE.format(workspace="w1") + "/automation-events"
    with _client(db_path) as client:
        legacy_retry = client.post(path, json=source_event, headers=_headers("writer"))
        assert legacy_retry.status_code == 200, legacy_retry.text
        assert legacy_retry.json()["duplicate"] is True
        assert legacy_retry.json()["id"] == "legacy-event-id"

        actor_b_body = {**source_event, "summary": "Actor B private projection."}
        actor_b_event = client.post(path, json=actor_b_body, headers=_headers("other-writer"))
        assert actor_b_event.status_code == 201, actor_b_event.text
        assert actor_b_event.json()["actorId"] == "another-owner"
        assert actor_b_event.json()["sourceEventId"] == "shared-provider-event"
        assert actor_b_event.json()["id"] != "legacy-event-id"

        actor_a_list = client.get(path, headers=_headers("writer")).json()["items"]
        actor_b_list = client.get(path, headers=_headers("other-writer")).json()["items"]
        assert [item["id"] for item in actor_a_list] == ["legacy-event-id"]
        assert [item["summary"] for item in actor_a_list] == [source_event["summary"]]
        assert [item["id"] for item in actor_b_list] == [actor_b_event.json()["id"]]
        assert [item["summary"] for item in actor_b_list] == ["Actor B private projection."]


def test_experiment_index_is_reference_only_actor_owned_and_revision_fenced(
    tmp_path: Path,
) -> None:
    """The index stores Product references and rejects stale or foreign access."""

    db_path = tmp_path / "experiments.sqlite3"
    experiment_id = "11111111-aaaa-4aaa-8aaa-111111111111"
    base = BASE.format(workspace="w1") + f"/experiments/{experiment_id}"
    digest_hex = "a" * 64
    body: dict[str, Any] = {
        "expectedRevision": 0,
        "datasetVersion": {
            "kind": "dataset_version",
            "resourceUri": "urn:cyrene:catalyst:dataset-version:dataset-v1",
            "resourceVersion": 1,
        },
        "trainingRun": {
            "kind": "training_run",
            "resourceUri": "urn:cyrene:yield:training-run:run-1",
            "resourceVersion": "run-1",
        },
        "trainingAttempt": {
            "kind": "training_attempt",
            "resourceUri": "urn:cyrene:yield:training-attempt:attempt-1",
            "resourceVersion": 1,
        },
        "checkpointArtifactRef": {
            "uri": f"artifact://sha256/{digest_hex}",
            "digest": f"sha256:{digest_hex}",
            "size_bytes": 32,
            "kind": "checkpoint",
        },
        "evaluationRun": {
            "kind": "evaluation_run",
            "resourceUri": "urn:cyrene:echo:evaluation-run:eval-1",
            "resourceVersion": "eval-1",
        },
        "modelVersion": {
            "kind": "model_version",
            "resourceUri": "urn:cyrene:catalyst:model-version:model-v1",
            "resourceVersion": 1,
        },
        "deployment": {
            "kind": "deployment",
            "resourceUri": "urn:cyrene:reactor:deployment:deploy-1",
            "resourceVersion": 3,
        },
        "commit": {
            "repositoryUri": "https://github.com/DoHorizon-AI/Cyrene-Workspace",
            "sha": "b" * 40,
        },
    }
    with _client(db_path) as client:
        created = client.put(base, json=body, headers=_headers())
        assert created.status_code == 201, created.text
        record = created.json()
        assert record["experimentId"] == experiment_id
        assert record["actorId"] == "owner"
        assert record["visibility"] == "owner"
        assert record["revision"] == 1
        assert "state" not in record and "status" not in record
        assert record["checkpointArtifactRef"]["size_bytes"] == 32

        replay = client.put(base, json=body, headers=_headers())
        assert replay.status_code == 200
        assert replay.json()["revision"] == 1
        assert replay.json()["updatedAt"] == record["updatedAt"]

        updated_body = {
            **body,
            "expectedRevision": 1,
            "modelVersion": {
                "kind": "model_version",
                "resourceUri": "urn:cyrene:catalyst:model-version:model-v2",
                "resourceVersion": 2,
            },
        }
        updated = client.put(base, json=updated_body, headers=_headers())
        assert updated.status_code == 200, updated.text
        assert updated.json()["revision"] == 2
        assert updated.json()["modelVersion"]["resourceVersion"] == 2

        stale = client.put(
            base,
            json={**updated_body, "expectedRevision": 1, "deployment": None},
            headers=_headers(),
        )
        assert stale.status_code == 409
        assert stale.json()["code"] == "WORK_EXPERIMENT_STALE_REVISION"

        own_read = client.get(base, headers=_headers())
        assert own_read.status_code == 200
        assert own_read.json()["revision"] == 2
        foreign_read = client.get(base, headers=_headers("other-writer"))
        assert foreign_read.status_code == 404
        ordinary_read = client.get(base, headers=_headers("reader"))
        assert ordinary_read.status_code == 403

        spoofed_lifecycle = client.put(
            base,
            json={**updated_body, "expectedRevision": 2, "state": "ACTIVE"},
            headers=_headers(),
        )
        assert spoofed_lifecycle.status_code == 422
        mismatched_artifact = {
            **body,
            "checkpointArtifactRef": {
                "uri": f"artifact://sha256/{digest_hex}",
                "digest": "sha256:" + "c" * 64,
                "size_bytes": 32,
                "kind": "checkpoint",
            },
        }
        invalid = client.put(base, json=mismatched_artifact, headers=_headers())
        assert invalid.status_code == 422

    with _client(db_path) as restarted:
        persisted = restarted.get(base, headers=_headers())
        assert persisted.status_code == 200
        assert persisted.json()["revision"] == 2


def test_private_installation_binding_requires_bridge_and_revokes_immediately(
    tmp_path: Path,
) -> None:
    """Only the dedicated bridge can bind; revocation and activity replay persist."""

    db_path = tmp_path / "private-installations.sqlite3"
    projection_path = tmp_path / "teams-actor-subjects.json"
    policy = _private_policy(projection_path)
    path = BASE.format(workspace="w1") + "/private-installations/events"
    tenant_id = "11111111-1111-4111-8111-111111111111"
    actor_id = "22222222-2222-4222-8222-222222222222"
    bot_app_id = "33333333-3333-4333-8333-333333333333"
    service_url = "https://smba.trafficmanager.net/amer/"

    def body(
        action: str,
        activity_id: str,
        conversation_id: str = "private-conversation-1",
        *,
        activity_occurred_at: str | None = None,
        service_url: str = "https://smba.trafficmanager.net/amer/",
    ) -> dict[str, Any]:
        return {
            "eventType": "personal_installation",
            "payload": {"action": action},
            "trust": {
                "version": 1,
                "provider": "teams",
                "conversationKind": "private",
                "installationAction": action,
                "tenantId": tenant_id,
                "actorAadObjectId": actor_id,
                "botAppId": bot_app_id,
                "conversationId": conversation_id,
                "activityId": activity_id,
                "activityOccurredAt": activity_occurred_at or _private_activity_time(),
                "serviceUrl": service_url,
            },
        }

    with _client_with_policy(db_path, policy) as client:
        denied_owner = client.post(path, json=body("add", "activity-1"), headers=_headers())
        assert denied_owner.status_code == 403
        created = client.post(
            path,
            json=body("add", "activity-1"),
            headers=_headers("teams-bridge"),
        )
        assert created.status_code == 200, created.text
        assert created.json() == {
            "action": "add",
            "active": True,
            "applied": True,
            "revision": 1,
            "updatedAt": created.json()["updatedAt"],
            "duplicate": False,
        }
        assert "conversationId" not in created.json()

        replay = client.post(
            path,
            json=body("add", "activity-1"),
            headers=_headers("teams-bridge"),
        )
        assert replay.status_code == 200
        assert replay.json()["duplicate"] is True
        assert replay.json()["revision"] == 1

        changed_replay = client.post(
            path,
            json=body("add", "activity-1", "spoofed-conversation"),
            headers=_headers("teams-bridge"),
        )
        assert changed_replay.status_code == 409
        mismatched_remove = client.post(
            path,
            json=body(
                "remove",
                "activity-2",
                "spoofed-conversation",
                activity_occurred_at=_private_activity_time(1),
                service_url="https://smba.trafficmanager.net/emea/",
            ),
            headers=_headers("teams-bridge"),
        )
        assert mismatched_remove.status_code == 200, mismatched_remove.text
        assert mismatched_remove.json()["active"] is False
        assert mismatched_remove.json()["applied"] is True
        assert mismatched_remove.json()["revision"] == 2

        private_claim = client.post(
            BASE.format(workspace="w1") + "/private-notifications/claim",
            json={"workerId": "teams-host", "limit": 10, "leaseSeconds": 60},
            headers=_headers("teams-bridge"),
        )
        assert private_claim.status_code == 200
        assert private_claim.json() == {"items": []}

    with sqlite3.connect(db_path) as connection:
        row = connection.execute(
            """SELECT active,revision,conversation_id,service_url
               FROM work_private_installations
               WHERE organization_id='org-a' AND workspace_id='w1'
                 AND tenant_id=? AND actor_aad_object_id=? AND bot_app_id=?""",
            (tenant_id, actor_id, bot_app_id),
        ).fetchone()
        assert row == (0, 2, "private-conversation-1", service_url)
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM work_private_installation_events "
                "WHERE organization_id='org-a' AND workspace_id='w1'"
            ).fetchone()[0]
            == 2
        )

    with _client_with_policy(db_path, policy) as restarted:
        remove_replay = restarted.post(
            path,
            json=body(
                "remove",
                "activity-2",
                "spoofed-conversation",
                activity_occurred_at=_private_activity_time(1),
                service_url="https://smba.trafficmanager.net/emea/",
            ),
            headers=_headers("teams-bridge"),
        )
        assert remove_replay.status_code == 200
        assert remove_replay.json()["duplicate"] is True
        assert remove_replay.json()["active"] is False

        _private_policy(projection_path, subjects=[])
        revoked_directory = restarted.post(
            path,
            json=body("add", "activity-3"),
            headers=_headers("teams-bridge"),
        )
        assert revoked_directory.status_code == 403
        assert revoked_directory.json()["code"] == "WORK_TEAMS_PRIVATE_INSTALLATION_FORBIDDEN"

    disabled = _client_with_policy(tmp_path / "private-disabled.sqlite3", None)
    with disabled as client:
        no_projection = client.post(
            path,
            json=body("add", "activity-4"),
            headers=_headers("teams-bridge"),
        )
        assert no_projection.status_code == 403


def test_private_installation_activity_time_orders_add_remove_and_reinstall(
    tmp_path: Path,
) -> None:
    """Provider event time, not arrival order, controls private installation state."""

    db_path = tmp_path / "private-installation-activity-order.sqlite3"
    projection_path = tmp_path / "teams-actor-subjects.json"
    policy = _private_policy(projection_path)
    actor_id = "22222222-2222-4222-8222-222222222222"
    bot_app_id = "33333333-3333-4333-8333-333333333333"
    path = BASE.format(workspace="w1") + "/private-installations/events"

    def send(
        action: str,
        activity_id: str,
        seconds_after_base: int,
        conversation_id: str,
        service_url: str = "https://smba.trafficmanager.net/amer/",
    ) -> Any:
        with _client_with_policy(db_path, policy) as client:
            return client.post(
                path,
                json=_private_install_event(
                    actor_id,
                    action,
                    activity_id,
                    conversation_id,
                    activity_occurred_at=_private_activity_time(seconds_after_base),
                    service_url=service_url,
                ),
                headers=_headers("teams-bridge"),
            )

    missing_time = _private_install_event(
        actor_id, "add", "initial-activity", "initial-conversation"
    )
    del missing_time["trust"]["activityOccurredAt"]
    with _client_with_policy(db_path, policy) as client:
        missing = client.post(path, json=missing_time, headers=_headers("teams-bridge"))
        assert missing.status_code == 422

        future_time = (
            (datetime.now(UTC) + timedelta(minutes=10))
            .isoformat(timespec="microseconds")
            .replace("+00:00", "Z")
        )
        future = client.post(
            path,
            json=_private_install_event(
                actor_id,
                "add",
                "future-activity",
                "future-conversation",
                activity_occurred_at=future_time,
            ),
            headers=_headers("teams-bridge"),
        )
        assert future.status_code == 422
        assert future.json()["code"] == "WORK_TEAMS_PRIVATE_INSTALLATION_INVALID"

        initial = client.post(
            path,
            json=_private_install_event(
                actor_id,
                "add",
                "initial-activity",
                "initial-conversation",
                activity_occurred_at=_private_activity_time(0),
            ),
            headers=_headers("teams-bridge"),
        )
        assert initial.status_code == 200, initial.text
        assert initial.json()["active"] is True and initial.json()["applied"] is True

    remove = send(
        "remove",
        "remove-with-updated-route",
        2,
        "changed-conversation",
        "https://smba.trafficmanager.net/emea/",
    )
    assert remove.status_code == 200, remove.text
    assert remove.json()["active"] is False and remove.json()["applied"] is True
    with sqlite3.connect(db_path) as connection:
        row = connection.execute(
            """SELECT active,conversation_id,service_url,last_activity_occurred_at
               FROM work_private_installations WHERE organization_id='org-a'
                 AND workspace_id='w1' AND tenant_id=? AND actor_aad_object_id=?
                 AND bot_app_id=?""",
            ("11111111-1111-4111-8111-111111111111", actor_id, bot_app_id),
        ).fetchone()
    assert row == (
        0,
        "initial-conversation",
        "https://smba.trafficmanager.net/amer/",
        int(
            datetime.fromisoformat(_private_activity_time(2).replace("Z", "+00:00")).timestamp()
            * 1000
        ),
    )

    stale_add = send("add", "delayed-add", 1, "stale-conversation")
    assert stale_add.status_code == 200
    assert stale_add.json()["active"] is False and stale_add.json()["applied"] is False
    equal_add = send("add", "equal-time-add", 2, "equal-time-conversation")
    assert equal_add.status_code == 200
    assert equal_add.json()["active"] is False and equal_add.json()["applied"] is False

    reinstalled = send("add", "fresh-add", 3, "fresh-conversation")
    assert reinstalled.status_code == 200
    assert reinstalled.json()["active"] is True and reinstalled.json()["applied"] is True
    stale_remove = send(
        "remove",
        "delayed-remove",
        2,
        "old-conversation",
        "https://smba.trafficmanager.net/emea/",
    )
    assert stale_remove.status_code == 200
    assert stale_remove.json()["active"] is True and stale_remove.json()["applied"] is False

    equal_remove = send("remove", "equal-time-remove", 3, "old-route")
    assert equal_remove.status_code == 200
    assert equal_remove.json()["active"] is False and equal_remove.json()["applied"] is True
    equal_reactivation = send("add", "equal-time-reactivation", 3, "must-stay-closed")
    assert equal_reactivation.status_code == 200
    assert equal_reactivation.json()["active"] is False
    assert equal_reactivation.json()["applied"] is False

    latest_add = send("add", "later-add", 4, "latest-conversation")
    assert latest_add.status_code == 200
    assert latest_add.json()["active"] is True and latest_add.json()["applied"] is True
    with sqlite3.connect(db_path) as connection:
        row = connection.execute(
            """SELECT active,revision,conversation_id,last_activity_occurred_at
               FROM work_private_installations WHERE organization_id='org-a'
                 AND workspace_id='w1' AND tenant_id=? AND actor_aad_object_id=?
                 AND bot_app_id=?""",
            ("11111111-1111-4111-8111-111111111111", actor_id, bot_app_id),
        ).fetchone()
    assert row == (
        1,
        5,
        "latest-conversation",
        int(
            datetime.fromisoformat(_private_activity_time(4).replace("Z", "+00:00")).timestamp()
            * 1000
        ),
    )


def test_private_installation_migration_fails_closed_for_unordered_legacy_rows(
    tmp_path: Path,
) -> None:
    """Legacy active routes need a timestamped remove before reinstallation."""

    db_path = tmp_path / "legacy-private-installation-order.sqlite3"
    tenant_id = "11111111-1111-4111-8111-111111111111"
    actor_id = "22222222-2222-4222-8222-222222222222"
    bot_app_id = "33333333-3333-4333-8333-333333333333"
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """CREATE TABLE work_private_installations (
                organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,tenant_id TEXT NOT NULL,
                actor_aad_object_id TEXT NOT NULL,bot_app_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,service_url TEXT NOT NULL,
                active INTEGER NOT NULL CHECK(active IN (0,1)),revision INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,last_activity_id TEXT NOT NULL,
                last_activity_digest TEXT NOT NULL,
                PRIMARY KEY(organization_id,workspace_id,tenant_id,actor_aad_object_id,bot_app_id)
            )"""
        )
        connection.execute(
            """CREATE TABLE work_private_installation_events (
                row_id INTEGER PRIMARY KEY AUTOINCREMENT,organization_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,tenant_id TEXT NOT NULL,
                actor_aad_object_id TEXT NOT NULL,
                bot_app_id TEXT NOT NULL,activity_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('add','remove')),event_digest TEXT NOT NULL,
                receipt_json TEXT NOT NULL,created_at INTEGER NOT NULL,
                UNIQUE(organization_id,workspace_id,tenant_id,actor_aad_object_id,bot_app_id,
                    activity_id)
            )"""
        )
        connection.execute(
            """INSERT INTO work_private_installations(
                organization_id,workspace_id,tenant_id,actor_aad_object_id,bot_app_id,
                conversation_id,service_url,active,revision,updated_at,last_activity_id,
                last_activity_digest
            ) VALUES('org-a','w1',?,?,?,'legacy-route',?,1,4,?,'legacy-add','legacy-digest')""",
            (
                tenant_id,
                actor_id,
                bot_app_id,
                "https://smba.trafficmanager.net/amer/",
                int(datetime.now(UTC).timestamp() * 1_000),
            ),
        )

    projection_path = tmp_path / "legacy-install-owner-subjects.json"
    policy = _private_policy(projection_path)
    path = BASE.format(workspace="w1") + "/private-installations/events"
    with _client_with_policy(db_path, policy) as client:
        with sqlite3.connect(db_path) as connection:
            columns = {
                str(row[1])
                for row in connection.execute("PRAGMA table_info(work_private_installations)")
            }
            event_columns = {
                str(row[1])
                for row in connection.execute("PRAGMA table_info(work_private_installation_events)")
            }
            migrated = connection.execute(
                """SELECT active,last_activity_occurred_at FROM work_private_installations
                   WHERE organization_id='org-a' AND workspace_id='w1' AND tenant_id=?
                     AND actor_aad_object_id=? AND bot_app_id=?""",
                (tenant_id, actor_id, bot_app_id),
            ).fetchone()
        assert "last_activity_occurred_at" in columns
        assert "activity_occurred_at" in event_columns
        assert migrated == (0, None)

        untrusted_add = client.post(
            path,
            json=_private_install_event(
                actor_id,
                "add",
                "pre-baseline-add",
                "must-not-reactivate",
                activity_occurred_at=_private_activity_time(1),
            ),
            headers=_headers("teams-bridge"),
        )
        assert untrusted_add.status_code == 200
        assert untrusted_add.json()["active"] is False
        assert untrusted_add.json()["applied"] is False

        baseline_remove = client.post(
            path,
            json=_private_install_event(
                actor_id,
                "remove",
                "ordered-baseline-remove",
                "route-from-remove-activity",
                activity_occurred_at=_private_activity_time(2),
                service_url="https://smba.trafficmanager.net/emea/",
            ),
            headers=_headers("teams-bridge"),
        )
        assert baseline_remove.status_code == 200, baseline_remove.text
        assert baseline_remove.json()["active"] is False
        assert baseline_remove.json()["applied"] is True

        reinstalled = client.post(
            path,
            json=_private_install_event(
                actor_id,
                "add",
                "post-baseline-add",
                "reinstalled-route",
                activity_occurred_at=_private_activity_time(3),
            ),
            headers=_headers("teams-bridge"),
        )
        assert reinstalled.status_code == 200, reinstalled.text
        assert reinstalled.json()["active"] is True and reinstalled.json()["applied"] is True

    with sqlite3.connect(db_path) as connection:
        row = connection.execute(
            """SELECT active,revision,conversation_id,last_activity_occurred_at
               FROM work_private_installations WHERE organization_id='org-a'
                 AND workspace_id='w1' AND tenant_id=? AND actor_aad_object_id=?
                 AND bot_app_id=?""",
            (tenant_id, actor_id, bot_app_id),
        ).fetchone()
    assert row == (
        1,
        6,
        "reinstalled-route",
        int(
            datetime.fromisoformat(_private_activity_time(3).replace("Z", "+00:00")).timestamp()
            * 1_000
        ),
    )


def test_private_bridge_principal_cannot_carry_workspace_owner_grants() -> None:
    """The private bridge token cannot also write Harness or general Work state."""

    with pytest.raises(ValueError, match="cannot carry other persistence grants"):
        PersistencePrincipal(
            "teams-v1",
            frozenset({"w1"}),
            can_takeover=True,
            organization_id="org-a",
            can_bind_teams_private_conversations=True,
        )
