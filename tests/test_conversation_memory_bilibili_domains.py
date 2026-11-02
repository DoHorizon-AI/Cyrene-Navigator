"""SQLite tests for owner-scoped Bilibili delegations and durable subscriptions."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import pytest

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.work.conversation_memory.bilibili_domains import (
    BilibiliDomainStore,
    bilibili_notification_readback_task_id,
    bilibili_notification_task_id,
    bilibili_subscription_task_id,
)


@pytest.fixture
def store(tmp_path: Path) -> BilibiliDomainStore:
    return BilibiliDomainStore(tmp_path / "bilibili-domains.sqlite3")


def _sha(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def _source_refs() -> list[dict[str, object]]:
    return [{"memoryId": None, "memoryVersion": None, "sourceMessageIds": ["message-1"]}]


def test_notification_child_task_ids_follow_shared_watch_resource_formula() -> None:
    workspace = "workspace-a"
    actor = "actor-a"
    subscription = "subscription-a"
    notification_key = "bili-notification-result"
    notification_id = "notification-a"
    updated_at = 1_793_499_575_680
    send_resource = f"{workspace}:{actor}:bili:{subscription}:notify:{notification_key}"
    send_expected = (
        "conversation-watch-" + hashlib.sha256(f"watch\0{send_resource}".encode()).hexdigest()[:40]
    )
    readback_resource = (
        f"{workspace}:{actor}:bili:{subscription}:notification-readback:"
        f"{notification_key}:{notification_id}:{updated_at}"
    )
    readback_expected = (
        "conversation-watch-"
        + hashlib.sha256(f"watch\0{readback_resource}".encode()).hexdigest()[:40]
    )

    assert (
        bilibili_notification_task_id(workspace, actor, subscription, notification_key)
        == send_expected
    )
    assert (
        bilibili_notification_readback_task_id(
            workspace, actor, subscription, notification_key, notification_id, updated_at
        )
        == readback_expected
    )


def _delegation_body(*, now: int, args: dict[str, object]) -> dict[str, object]:
    return {
        "idempotencyKey": "delegate-one",
        "connectionRef": "connection-a",
        "profileRef": "profile-a",
        "conversationId": "conversation-a",
        "conversationKind": "direct",
        "expiresAt": now + 60_000,
        "grants": [
            {
                "operationId": "bilibili.dm.send",
                "target": {"peer_user_id": "peer-a"},
                "argumentsDigestSha256": _sha(args),
            }
        ],
        "sourceRefs": _source_refs(),
    }


def test_delegation_is_actor_scoped_exact_and_revocable(
    store: BilibiliDomainStore,
) -> None:
    now = time.time_ns() // 1_000_000
    args = {"peer_user_id": "peer-a", "message": "Hello"}
    body = _delegation_body(now=now, args=args)
    created, duplicate = store.create_delegation(
        "org-a", "workspace-a", "actor-a", body, external_subject="self-a"
    )
    assert duplicate is False
    assert created["state"] == "active"
    assert created["version"] == 1
    grant = created["grants"][0]
    assert grant["resourceRef"].startswith("sha256:")

    replay, duplicate = store.create_delegation(
        "org-a", "workspace-a", "actor-a", body, external_subject="self-a"
    )
    assert duplicate is True
    assert replay["id"] == created["id"]
    allowed = store.authorize_delegation(
        "org-a",
        "workspace-a",
        "actor-a",
        str(created["id"]),
        "bilibili.dm.send",
        {"peer_user_id": "peer-a"},
        _sha(args),
    )
    assert allowed["allowed"] is True
    wrong_target = store.authorize_delegation(
        "org-a",
        "workspace-a",
        "actor-a",
        str(created["id"]),
        "bilibili.dm.send",
        {"peer_user_id": "peer-b"},
        _sha(args),
    )
    assert wrong_target["allowed"] is False
    wrong_args = store.authorize_delegation(
        "org-a",
        "workspace-a",
        "actor-a",
        str(created["id"]),
        "bilibili.dm.send",
        {"peer_user_id": "peer-a"},
        _sha({"peer_user_id": "peer-a", "message": "Different"}),
    )
    assert wrong_args["allowed"] is False

    with pytest.raises(PersistenceError) as isolated:
        store.get_delegation("org-a", "workspace-a", "actor-b", str(created["id"]))
    assert isolated.value.status == 404
    revoked = store.revoke_delegation("org-a", "workspace-a", "actor-a", str(created["id"]), 1)
    assert revoked["state"] == "revoked"
    assert revoked["version"] == 2
    replayed_revoke = store.revoke_delegation(
        "org-a", "workspace-a", "actor-a", str(created["id"]), 1
    )
    assert replayed_revoke["version"] == 2
    assert (
        store.authorize_delegation(
            "org-a",
            "workspace-a",
            "actor-a",
            str(created["id"]),
            "bilibili.dm.send",
            {"peer_user_id": "peer-a"},
            _sha(args),
        )["allowed"]
        is False
    )


def test_subscription_binds_delegation_and_records_restartable_cas_checkpoint(
    store: BilibiliDomainStore,
) -> None:
    now = time.time_ns() // 1_000_000
    arguments = {"video_id": "BV1abc", "root_comment_id": 9001}
    target = {"video_id": "BV1abc", "root_comment_id": 9001}
    grant_args = {**arguments, "page_size": 20}
    delegation, _ = store.create_delegation(
        "org-a",
        "workspace-a",
        "actor-a",
        {
            "idempotencyKey": "comments-delegation",
            "connectionRef": "connection-a",
            "profileRef": "profile-a",
            "conversationId": "conversation-a",
            "conversationKind": "direct",
            "expiresAt": now + 60_000,
            "grants": [
                {
                    "operationId": "bilibili.comments.list",
                    "target": target,
                    "argumentsDigestSha256": _sha(grant_args),
                }
            ],
            "sourceRefs": _source_refs(),
        },
        external_subject="self-a",
    )
    resource_ref = delegation["grants"][0]["resourceRef"]
    subscription, duplicate = store.create_subscription(
        "org-a",
        "workspace-a",
        "actor-a",
        {
            "idempotencyKey": "watch-comments",
            "delegationId": delegation["id"],
            "connectionRef": "connection-a",
            "profileRef": "profile-a",
            "ownerTaskId": "owner-task-a",
            "ownerSessionId": "owner-session-a",
            "operationId": "bilibili.comments.list",
            "resourceRef": resource_ref,
            "arguments": grant_args,
            "sourceRefs": _source_refs(),
            "conversationId": "conversation-a",
            "conversationKind": "direct",
            "expiresAt": now + 50_000,
            "nextCheckAt": now - 1,
        },
    )
    assert duplicate is False
    assert subscription["state"] == "active"
    assert subscription["ownerTaskId"] == "owner-task-a"
    assert subscription["ownerSessionId"] == "owner-session-a"
    assert subscription["scheduledRunState"] == "scheduled"
    with pytest.raises(PersistenceError):
        store.create_subscription(
            "org-a",
            "workspace-a",
            "actor-a",
            {
                "idempotencyKey": "wrong-arguments",
                "delegationId": delegation["id"],
                "connectionRef": "connection-a",
                "profileRef": "profile-a",
                "ownerTaskId": "owner-task-a",
                "ownerSessionId": "owner-session-a",
                "operationId": "bilibili.comments.list",
                "resourceRef": resource_ref,
                "arguments": {**grant_args, "root_comment_id": 9002},
                "sourceRefs": _source_refs(),
                "conversationId": "conversation-a",
                "conversationKind": "direct",
                "expiresAt": now + 50_000,
                "nextCheckAt": now - 1,
            },
        )

    claimed = store.claim_subscription_check(
        "org-a", "workspace-a", "actor-a", str(subscription["id"]), 1, now_ms=now
    )
    assert claimed["version"] == 2
    assert claimed["scheduledRunState"] == "claimed"
    assert bilibili_subscription_task_id(
        "workspace-a",
        "actor-a",
        str(subscription["id"]),
        str(claimed["scheduledRunKey"]),
    ) == bilibili_subscription_task_id(
        "workspace-a",
        "actor-a",
        str(subscription["id"]),
        str(claimed["scheduledRunKey"]),
    )
    claim_replay = store.claim_subscription_check(
        "org-a", "workspace-a", "actor-a", str(subscription["id"]), 1, now_ms=now
    )
    assert claim_replay["scheduledRunKey"] == claimed["scheduledRunKey"]
    can_notify = store.authorize_subscription_notification(
        "org-a",
        "workspace-a",
        "actor-a",
        str(subscription["id"]),
        2,
        str(claimed["scheduledRunKey"]),
        hashlib.sha256(b"result-one").hexdigest(),
    )
    assert can_notify["allowed"] is True

    checkpoint = {
        "runKey": claimed["scheduledRunKey"],
        "cursor": "page-2",
        "lastOutputSha256": hashlib.sha256(b"result-one").hexdigest(),
        "lastOperationReceiptId": "operation-read-1",
        "lastNotificationReceiptId": "notification-1",
        "lastNotificationOutcome": "queued",
        "lastDeliveryReceiptId": None,
        "state": "active",
        "nextCheckAt": now + 10_000,
    }
    updated = store.record_subscription_check(
        "org-a", "workspace-a", "actor-a", str(subscription["id"]), 2, checkpoint
    )
    assert updated["version"] == 3
    assert updated["cursor"] == "page-2"
    assert updated["lastNotificationOutcome"] == "queued"
    assert updated["scheduledRunState"] == "scheduled"
    assert (
        store.record_subscription_check(
            "org-a", "workspace-a", "actor-a", str(subscription["id"]), 2, checkpoint
        )["version"]
        == 3
    )
    next_claim = store.claim_subscription_check(
        "org-a", "workspace-a", "actor-a", str(subscription["id"]), 3, now_ms=now + 10_000
    )
    held = store.authorize_subscription_notification(
        "org-a",
        "workspace-a",
        "actor-a",
        str(subscription["id"]),
        4,
        str(next_claim["scheduledRunKey"]),
        hashlib.sha256(b"result-two").hexdigest(),
    )
    assert held["allowed"] is False
    assert held["reason"] == "outbox_reconciliation_required"

    revoked = store.revoke_delegation("org-a", "workspace-a", "actor-a", str(delegation["id"]), 1)
    assert revoked["state"] == "revoked"
    assert (
        store.get_subscription("org-a", "workspace-a", "actor-a", str(subscription["id"]))["state"]
        == "revoked"
    )


def test_subscription_does_not_accept_delivered_without_readback_receipt(
    store: BilibiliDomainStore,
) -> None:
    now = time.time_ns() // 1_000_000
    args = {"video_id": "BV1abc"}
    delegation, _ = store.create_delegation(
        "org-a",
        "workspace-a",
        "actor-a",
        {
            "idempotencyKey": "video-delegation",
            "connectionRef": "connection-a",
            "profileRef": "profile-a",
            "conversationId": "conversation-a",
            "conversationKind": "direct",
            "expiresAt": now + 60_000,
            "grants": [
                {
                    "operationId": "bilibili.video.read",
                    "target": args,
                    "argumentsDigestSha256": _sha(args),
                }
            ],
            "sourceRefs": _source_refs(),
        },
        external_subject="self-a",
    )
    subscription_body = {
        "idempotencyKey": "video-subscription",
        "delegationId": delegation["id"],
        "connectionRef": "connection-a",
        "profileRef": "profile-a",
        "ownerTaskId": "owner-task-a",
        "ownerSessionId": "owner-session-a",
        "operationId": "bilibili.video.read",
        "resourceRef": delegation["grants"][0]["resourceRef"],
        "arguments": args,
        "sourceRefs": _source_refs(),
        "conversationId": "conversation-a",
        "conversationKind": "direct",
        "expiresAt": now + 50_000,
    }
    subscription, duplicate = store.create_subscription(
        "org-a", "workspace-a", "actor-a", subscription_body
    )
    assert duplicate is False
    replay, duplicate = store.create_subscription(
        "org-a", "workspace-a", "actor-a", subscription_body
    )
    assert duplicate is True
    assert replay["id"] == subscription["id"]
    claimed = store.claim_subscription_check(
        "org-a",
        "workspace-a",
        "actor-a",
        str(subscription["id"]),
        1,
        now_ms=int(subscription["nextCheckAt"]),
    )
    with pytest.raises(PersistenceError) as error:
        store.record_subscription_check(
            "org-a",
            "workspace-a",
            "actor-a",
            str(subscription["id"]),
            2,
            {
                "runKey": claimed["scheduledRunKey"],
                "cursor": None,
                "lastOutputSha256": hashlib.sha256(b"video result").hexdigest(),
                "lastOperationReceiptId": "operation-read-2",
                "lastNotificationReceiptId": "notification-2",
                "lastNotificationOutcome": "delivered",
                "lastDeliveryReceiptId": "delivery-1",
                "state": "active",
                "nextCheckAt": now + 5_000,
            },
        )
    assert error.value.status == 422
