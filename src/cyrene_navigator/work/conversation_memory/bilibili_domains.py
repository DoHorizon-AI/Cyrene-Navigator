"""
┌─────────────────────────────────────────────────────────────────────┐
│  Module: cyrene_navigator.work.conversation_memory.bilibili_domains  │
│  Role: Durable owner-scoped Bilibili intent and subscriptions.       │
│                                                                     │
│  模块职责：保存 Bilibili 委托意图与可恢复订阅检查点。                 │
└─────────────────────────────────────────────────────────────────────┘

This module never creates Work Tasks, stores credentials, or replaces a fresh
Directory proof. Provider execution and verified status readback remain owned by
their trusted Work and Exchange adapters.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
import uuid
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import cast

from cyrene_navigator.persistence.errors import PersistenceError

BILIBILI_OPERATION_IDS = frozenset(
    {
        "bilibili.search",
        "bilibili.user.find",
        "bilibili.video.read",
        "bilibili.comments.list",
        "bilibili.dynamics.list",
        "bilibili.dynamic.read",
        "bilibili.dm.list",
        "bilibili.dm.read",
        "bilibili.comment.create",
        "bilibili.dynamic.publish",
        "bilibili.dm.send",
    }
)
_TARGET_KEYS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "bilibili.search": (("search_type",), ()),
    "bilibili.user.find": (("user_id",), ()),
    "bilibili.video.read": (("video_id",), ()),
    "bilibili.comments.list": (("video_id",), ("root_comment_id",)),
    "bilibili.dynamics.list": (("user_id",), ()),
    "bilibili.dynamic.read": (("dynamic_id",), ()),
    "bilibili.dm.list": (("peer_user_id",), ()),
    "bilibili.dm.read": (("peer_user_id", "message_id"), ()),
    "bilibili.comment.create": (
        ("video_id",),
        ("root_comment_id", "parent_comment_id"),
    ),
    "bilibili.dynamic.publish": (("user_id",), ()),
    "bilibili.dm.send": (("peer_user_id",), ()),
}
_DELEGATION_STATES = {"active", "revoked", "expired"}
_SUBSCRIPTION_STATES = {
    "active",
    "paused",
    "cancelled",
    "expired",
    "revoked",
    "uncertain",
}
_NOTIFICATION_OUTCOMES = {"queued", "accepted", "delivered", "held", "uncertain"}
_MAX_SOURCE_REFS = 256
_MAX_BODY_BYTES = 256 * 1024
_MAX_LIST_LIMIT = 500
_MAX_DELEGATION_TTL_MS = 30 * 24 * 60 * 60 * 1_000

WireView = dict[str, object]


class BilibiliDomainStore:
    """Persist Bilibili user intent and bounded, restartable subscriptions.

    Args:
        db_path: Absolute path to a dedicated SQLite database owned by this store.
    """

    def __init__(self, db_path: Path) -> None:
        if not isinstance(db_path, Path) or not db_path.is_absolute():
            raise ValueError("db_path must be an absolute Path")
        self.db_path = db_path.resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(self.db_path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(descriptor)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA secure_delete=ON")
        return connection

    @contextmanager
    def _read(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            yield connection
        except sqlite3.Error as exc:
            raise _storage_error("Bilibili read failed", exc) from exc
        finally:
            connection.close()

    @contextmanager
    def _write(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except PersistenceError:
            connection.rollback()
            raise
        except sqlite3.Error as exc:
            connection.rollback()
            raise _storage_error("Bilibili write failed", exc) from exc
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        connection = self._connect()
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            connection.execute("BEGIN IMMEDIATE")
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if version > 2:
                raise PersistenceError(
                    "BILIBILI_SCHEMA_UNSUPPORTED", 500, "Bilibili schema is newer than this app."
                )
            connection.execute(
                """CREATE TABLE IF NOT EXISTS bilibili_delegations (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    delegation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
                    connection_ref TEXT NOT NULL, profile_ref TEXT NOT NULL,
                    conversation_id TEXT NOT NULL, conversation_kind TEXT NOT NULL,
                    persona_id TEXT, grants_json TEXT NOT NULL, source_refs_json TEXT NOT NULL,
                    expires_at INTEGER NOT NULL, request_digest TEXT NOT NULL,
                    state TEXT NOT NULL, version INTEGER NOT NULL,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY(org,workspace,actor,delegation_id),
                    UNIQUE(org,workspace,actor,idempotency_key)
                )"""
            )
            connection.execute(
                """CREATE INDEX IF NOT EXISTS bilibili_delegation_page
                   ON bilibili_delegations(org,workspace,actor,created_at,delegation_id)"""
            )
            connection.execute(
                """CREATE TABLE IF NOT EXISTS bilibili_subscriptions (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    subscription_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
                    delegation_id TEXT NOT NULL, connection_ref TEXT NOT NULL,
                    profile_ref TEXT NOT NULL, owner_task_id TEXT NOT NULL,
                    owner_session_id TEXT NOT NULL, operation_id TEXT NOT NULL,
                    resource_ref TEXT NOT NULL, arguments_json TEXT NOT NULL,
                    source_refs_json TEXT NOT NULL, conversation_id TEXT NOT NULL,
                    conversation_kind TEXT NOT NULL, persona_id TEXT,
                    expires_at INTEGER NOT NULL, next_check_at INTEGER,
                    scheduled_run_key TEXT, scheduled_expected_version INTEGER NOT NULL,
                    scheduled_run_state TEXT NOT NULL,
                    cursor TEXT, last_output_sha256 TEXT, last_operation_receipt_id TEXT,
                    last_notification_receipt_id TEXT,
                    last_notification_readback_receipt_id TEXT,
                    last_notification_outcome TEXT,
                    last_delivery_receipt_id TEXT, state TEXT NOT NULL, version INTEGER NOT NULL,
                    checkpoint_json TEXT, notification_reconciliation_json TEXT,
                    request_digest TEXT NOT NULL,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY(org,workspace,actor,subscription_id),
                    UNIQUE(org,workspace,actor,idempotency_key),
                    FOREIGN KEY(org,workspace,actor,delegation_id)
                        REFERENCES bilibili_delegations(org,workspace,actor,delegation_id)
                )"""
            )
            connection.execute(
                """CREATE INDEX IF NOT EXISTS bilibili_subscription_page
                   ON bilibili_subscriptions(org,workspace,actor,created_at,subscription_id)"""
            )
            if version < 2:
                columns = {
                    str(row["name"])
                    for row in connection.execute("PRAGMA table_info(bilibili_subscriptions)")
                }
                if "notification_reconciliation_json" not in columns:
                    connection.execute(
                        "ALTER TABLE bilibili_subscriptions "
                        "ADD COLUMN notification_reconciliation_json TEXT"
                    )
            connection.execute("PRAGMA user_version=2")
            connection.commit()
        except PersistenceError:
            connection.rollback()
            raise
        except sqlite3.Error as exc:
            connection.rollback()
            raise _storage_error("Bilibili schema initialization failed", exc) from exc
        finally:
            connection.close()

    def create_delegation(
        self,
        org: str,
        workspace: str,
        actor: str,
        body: Mapping[str, object],
        *,
        external_subject: str,
    ) -> tuple[WireView, bool]:
        """Create exact per-operation intent, scoped to an authorized profile."""

        scope = _scope(org, workspace, actor)
        payload = _body(
            body,
            required={
                "idempotencyKey",
                "connectionRef",
                "profileRef",
                "conversationId",
                "conversationKind",
                "expiresAt",
                "grants",
                "sourceRefs",
            },
            optional={"personaId"},
        )
        key = _idempotency_key(payload["idempotencyKey"])
        connection_ref = _identifier(payload["connectionRef"], "connectionRef")
        profile_ref = _identifier(payload["profileRef"], "profileRef")
        conversation_id, conversation_kind, persona_id = _conversation_context(payload)
        expires_at = _future_expiry(payload["expiresAt"])
        refs = _source_refs(payload["sourceRefs"])
        grants = _delegation_grants(payload["grants"], profile_ref, external_subject)
        request_digest = _digest(
            {
                "connectionRef": connection_ref,
                "profileRef": profile_ref,
                "conversationId": conversation_id,
                "conversationKind": conversation_kind,
                "personaId": persona_id,
                "expiresAt": expires_at,
                "grants": grants,
                "sourceRefs": refs,
            }
        )
        now = _now_ms()
        with self._write() as connection:
            existing = connection.execute(
                """SELECT * FROM bilibili_delegations
                   WHERE org=? AND workspace=? AND actor=? AND idempotency_key=?""",
                (*scope, key),
            ).fetchone()
            if existing is not None:
                if str(existing["request_digest"]) != request_digest:
                    raise _conflict("Bilibili delegation idempotency key was reused")
                return _delegation_view(existing), True
            delegation_id = _new_id()
            connection.execute(
                """INSERT INTO bilibili_delegations (
                       org,workspace,actor,delegation_id,idempotency_key,connection_ref,
                       profile_ref,conversation_id,conversation_kind,persona_id,grants_json,
                       source_refs_json,expires_at,request_digest,state,version,created_at,updated_at
                   ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',1,?,?)""",
                (
                    *scope,
                    delegation_id,
                    key,
                    connection_ref,
                    profile_ref,
                    conversation_id,
                    conversation_kind,
                    persona_id,
                    _json_dumps(grants),
                    _json_dumps(refs),
                    expires_at,
                    request_digest,
                    now,
                    now,
                ),
            )
            row = connection.execute(
                """SELECT * FROM bilibili_delegations
                   WHERE org=? AND workspace=? AND actor=? AND delegation_id=?""",
                (*scope, delegation_id),
            ).fetchone()
        assert row is not None
        return _delegation_view(row), False

    def get_delegation(self, org: str, workspace: str, actor: str, delegation_id: str) -> WireView:
        scope = _scope(org, workspace, actor)
        identifier = _identifier(delegation_id, "delegationId")
        with self._read() as connection:
            row = connection.execute(
                """SELECT * FROM bilibili_delegations
                   WHERE org=? AND workspace=? AND actor=? AND delegation_id=?""",
                (*scope, identifier),
            ).fetchone()
        if row is None:
            raise _not_found("Bilibili delegation was not found")
        return _delegation_view(row)

    def list_delegations(
        self,
        org: str,
        workspace: str,
        actor: str,
        *,
        state: str | None = None,
        cursor: str | None = None,
        limit: int = 100,
    ) -> WireView:
        scope = _scope(org, workspace, actor)
        selected_state = _optional_choice(state, "state", _DELEGATION_STATES)
        page_limit = _list_limit(limit)
        where = "org=? AND workspace=? AND actor=?"
        params: tuple[object, ...] = scope
        if selected_state == "expired":
            where += " AND state='active' AND expires_at<=?"
            params += (_now_ms(),)
        elif selected_state == "active":
            where += " AND state='active' AND expires_at>?"
            params += (_now_ms(),)
        elif selected_state is not None:
            where += " AND state=?"
            params += (selected_state,)
        if cursor is not None:
            cursor_row = self._get_page_cursor(
                "bilibili_delegations", "delegation_id", scope, cursor
            )
            where += " AND (created_at>? OR (created_at=? AND delegation_id>?))"
            params += (cursor_row["created_at"], cursor_row["created_at"], cursor)
        with self._read() as connection:
            rows = connection.execute(
                f"""SELECT * FROM bilibili_delegations WHERE {where}
                    ORDER BY created_at,delegation_id LIMIT ?""",
                (*params, page_limit + 1),
            ).fetchall()
        has_more = len(rows) > page_limit
        page = rows[:page_limit]
        return {
            "items": [_delegation_view(row) for row in page],
            "nextCursor": str(page[-1]["delegation_id"]) if has_more and page else None,
        }

    def authorize_delegation(
        self,
        org: str,
        workspace: str,
        actor: str,
        delegation_id: str,
        operation_id: str,
        target: Mapping[str, object],
        arguments_digest_sha256: str,
    ) -> WireView:
        """Check current user intent only; caller still needs fresh provider proof."""

        row_view = self.get_delegation(org, workspace, actor, delegation_id)
        operation = _choice(operation_id, "operationId", set(BILIBILI_OPERATION_IDS))
        normalized_target = _target(operation, target)
        resource_ref = _resource_ref(str(row_view["profileRef"]), operation, normalized_target)
        argument_digest = _sha256(arguments_digest_sha256, "argumentsDigestSha256")
        expires_at = row_view.get("expiresAt")
        if (
            row_view.get("state") != "active"
            or not isinstance(expires_at, int)
            or expires_at <= _now_ms()
        ):
            return {"allowed": False, "reason": "delegation_inactive", "resourceRef": resource_ref}
        raw_grants = row_view.get("grants")
        grants = raw_grants if isinstance(raw_grants, list) else []
        allowed = any(
            grant["operationId"] == operation
            and grant["resourceRef"] == resource_ref
            and grant["argumentsDigestSha256"] == argument_digest
            for grant in grants
            if isinstance(grant, Mapping)
        )
        return {
            "allowed": allowed,
            "reason": None if allowed else "scope_not_granted",
            "delegationId": delegation_id,
            "resourceRef": resource_ref,
            "version": row_view["version"],
            "expiresAt": row_view["expiresAt"],
        }

    def revoke_delegation(
        self,
        org: str,
        workspace: str,
        actor: str,
        delegation_id: str,
        expected_version: int,
    ) -> WireView:
        scope = _scope(org, workspace, actor)
        identifier = _identifier(delegation_id, "delegationId")
        expected = _version(expected_version, "expectedVersion")
        with self._write() as connection:
            row = connection.execute(
                """SELECT * FROM bilibili_delegations
                   WHERE org=? AND workspace=? AND actor=? AND delegation_id=?""",
                (*scope, identifier),
            ).fetchone()
            if row is None:
                raise _not_found("Bilibili delegation was not found")
            if row["state"] == "revoked" and int(row["version"]) == expected + 1:
                return _delegation_view(row)
            if row["state"] != "active" or int(row["version"]) != expected:
                raise _conflict("Bilibili delegation state or version changed")
            now = _now_ms()
            connection.execute(
                """UPDATE bilibili_delegations SET state='revoked',version=version+1,updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND delegation_id=? AND version=?""",
                (now, *scope, identifier, expected),
            )
            connection.execute(
                """UPDATE bilibili_subscriptions SET state='revoked',version=version+1,
                       next_check_at=NULL,scheduled_run_key=NULL,
                       scheduled_expected_version=version+1,scheduled_run_state='completed',
                       updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND delegation_id=?
                     AND state IN ('active','paused','uncertain')""",
                (now, *scope, identifier),
            )
            updated = connection.execute(
                """SELECT * FROM bilibili_delegations
                   WHERE org=? AND workspace=? AND actor=? AND delegation_id=?""",
                (*scope, identifier),
            ).fetchone()
        assert updated is not None
        return _delegation_view(updated)

    def create_subscription(
        self,
        org: str,
        workspace: str,
        actor: str,
        body: Mapping[str, object],
    ) -> tuple[WireView, bool]:
        """Create a restartable subscription bound to one active delegation grant."""

        scope = _scope(org, workspace, actor)
        payload = _body(
            body,
            required={
                "idempotencyKey",
                "delegationId",
                "connectionRef",
                "profileRef",
                "ownerTaskId",
                "ownerSessionId",
                "operationId",
                "resourceRef",
                "arguments",
                "sourceRefs",
                "conversationId",
                "conversationKind",
                "expiresAt",
            },
            optional={"personaId", "nextCheckAt"},
        )
        key = _idempotency_key(payload["idempotencyKey"])
        delegation_id = _identifier(payload["delegationId"], "delegationId")
        connection_ref = _identifier(payload["connectionRef"], "connectionRef")
        profile_ref = _identifier(payload["profileRef"], "profileRef")
        owner_task_id = _identifier(payload["ownerTaskId"], "ownerTaskId")
        owner_session_id = _identifier(payload["ownerSessionId"], "ownerSessionId")
        operation_id = _choice(payload["operationId"], "operationId", set(BILIBILI_OPERATION_IDS))
        arguments = _json_object(payload["arguments"], "arguments")
        _safe_tree(arguments, "arguments")
        argument_digest = _digest(arguments)
        target = _operation_target(operation_id, arguments)
        resource_ref = _resource_ref(profile_ref, operation_id, target)
        if payload["resourceRef"] != resource_ref:
            raise _conflict("subscription resourceRef does not match its exact arguments")
        conversation_id, conversation_kind, persona_id = _conversation_context(payload)
        refs = _source_refs(payload["sourceRefs"])
        expires_at = _future_expiry(payload["expiresAt"])
        next_check_at = _optional_timestamp(payload.get("nextCheckAt"), "nextCheckAt")
        scheduled_at = _now_ms() if next_check_at is None else next_check_at
        if scheduled_at >= expires_at:
            raise _invalid("nextCheckAt must precede expiresAt")
        now = _now_ms()
        with self._write() as connection:
            delegation = connection.execute(
                """SELECT * FROM bilibili_delegations
                   WHERE org=? AND workspace=? AND actor=? AND delegation_id=?""",
                (*scope, delegation_id),
            ).fetchone()
            if delegation is None:
                raise _not_found("Bilibili delegation was not found")
            if (
                delegation["state"] != "active"
                or int(delegation["expires_at"]) <= now
                or str(delegation["connection_ref"]) != connection_ref
                or str(delegation["profile_ref"]) != profile_ref
                or str(delegation["conversation_id"]) != conversation_id
                or str(delegation["conversation_kind"]) != conversation_kind
                or delegation["persona_id"] != persona_id
                or expires_at > int(delegation["expires_at"])
            ):
                raise _conflict("Bilibili subscription exceeds its active delegation scope")
            delegated_sources = _json_array(_decode(delegation, "source_refs_json"), "sourceRefs")
            if _digest(refs) != _digest(delegated_sources):
                raise _conflict("Subscription source refs must match its delegation lineage")
            grants = _json_array(_decode(delegation, "grants_json"), "grants")
            if not any(
                isinstance(grant, Mapping)
                and grant.get("operationId") == operation_id
                and grant.get("resourceRef") == resource_ref
                and grant.get("argumentsDigestSha256") == argument_digest
                for grant in grants
            ):
                raise _conflict("Bilibili subscription target is not in its delegation")
            request_digest = _digest(
                {
                    "delegationId": delegation_id,
                    "connectionRef": connection_ref,
                    "profileRef": profile_ref,
                    "operationId": operation_id,
                    "resourceRef": resource_ref,
                    "arguments": arguments,
                    "sourceRefs": refs,
                    "conversationId": conversation_id,
                    "conversationKind": conversation_kind,
                    "personaId": persona_id,
                    "expiresAt": expires_at,
                    "nextCheckAt": next_check_at,
                }
            )
            existing = connection.execute(
                """SELECT * FROM bilibili_subscriptions
                   WHERE org=? AND workspace=? AND actor=? AND idempotency_key=?""",
                (*scope, key),
            ).fetchone()
            if existing is not None:
                if str(existing["request_digest"]) != request_digest:
                    raise _conflict("Bilibili subscription idempotency key was reused")
                return _subscription_view(existing), True
            subscription_id = _new_id()
            initial_version = 1
            run_key = bilibili_subscription_run_key(
                *scope, subscription_id, scheduled_at, initial_version
            )
            connection.execute(
                """INSERT INTO bilibili_subscriptions (
                       org,workspace,actor,subscription_id,idempotency_key,delegation_id,
                       connection_ref,profile_ref,owner_task_id,owner_session_id,
                       operation_id,resource_ref,arguments_json,
                       source_refs_json,conversation_id,conversation_kind,persona_id,expires_at,
                       next_check_at,scheduled_run_key,scheduled_expected_version,
                       scheduled_run_state,cursor,last_output_sha256,last_operation_receipt_id,
                       last_notification_receipt_id,last_notification_readback_receipt_id,
                       last_notification_outcome,
                       last_delivery_receipt_id,state,version,checkpoint_json,request_digest,
                       created_at,updated_at
                   ) VALUES (
                       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                       'scheduled', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                       'active', 1, NULL, ?, ?, ?
                   )""",
                (
                    *scope,
                    subscription_id,
                    key,
                    delegation_id,
                    connection_ref,
                    profile_ref,
                    owner_task_id,
                    owner_session_id,
                    operation_id,
                    resource_ref,
                    _json_dumps(arguments),
                    _json_dumps(refs),
                    conversation_id,
                    conversation_kind,
                    persona_id,
                    expires_at,
                    scheduled_at,
                    run_key,
                    initial_version,
                    request_digest,
                    now,
                    now,
                ),
            )
            row = connection.execute(
                """SELECT * FROM bilibili_subscriptions
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=?""",
                (*scope, subscription_id),
            ).fetchone()
        assert row is not None
        return _subscription_view(row), False

    def claim_subscription_check(
        self,
        org: str,
        workspace: str,
        actor: str,
        subscription_id: str,
        expected_version: int,
        *,
        now_ms: int | None = None,
    ) -> WireView:
        """CAS-claim the due run key so restart reuses the same scheduled Task."""

        scope = _scope(org, workspace, actor)
        identifier = _identifier(subscription_id, "subscriptionId")
        expected = _version(expected_version, "expectedVersion")
        now = _now_ms() if now_ms is None else _timestamp(now_ms, "nowMs")
        with self._write() as connection:
            row = connection.execute(
                """SELECT * FROM bilibili_subscriptions
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=?""",
                (*scope, identifier),
            ).fetchone()
            if row is None:
                raise _not_found("Bilibili subscription was not found")
            if (
                row["scheduled_run_state"] == "claimed"
                and int(row["scheduled_expected_version"]) == expected + 1
                and int(row["version"]) == expected + 1
            ):
                return _subscription_view(row)
            if (
                row["scheduled_run_state"] == "claimed"
                and int(row["scheduled_expected_version"]) == expected
                and int(row["version"]) == expected
            ):
                return _subscription_view(row)
            if int(row["version"]) != expected or row["state"] != "active":
                raise _conflict("Only the current active subscription can be claimed")
            if row["scheduled_run_state"] != "scheduled":
                raise _conflict("Subscription has no scheduled check to claim")
            if int(row["expires_at"]) <= now:
                raise _conflict("Expired subscriptions cannot be claimed")
            due_at = int(row["next_check_at"])
            if due_at > now:
                raise _conflict("Subscription check is not due yet")
            claimed_version = expected + 1
            run_key = bilibili_subscription_run_key(*scope, identifier, due_at, claimed_version)
            connection.execute(
                """UPDATE bilibili_subscriptions SET scheduled_run_key=?,
                       scheduled_expected_version=?,scheduled_run_state='claimed',
                       version=version+1,updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=? AND version=?""",
                (run_key, claimed_version, now, *scope, identifier, expected),
            )
            updated = connection.execute(
                """SELECT * FROM bilibili_subscriptions
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=?""",
                (*scope, identifier),
            ).fetchone()
        assert updated is not None
        return _subscription_view(updated)

    def authorize_subscription_notification(
        self,
        org: str,
        workspace: str,
        actor: str,
        subscription_id: str,
        expected_version: int,
        run_key: str,
        source_output_sha256: str,
    ) -> WireView:
        """Prevent duplicate sends while a prior outbox result is pending or unknown."""

        scope = _scope(org, workspace, actor)
        identifier = _identifier(subscription_id, "subscriptionId")
        expected = _version(expected_version, "expectedVersion")
        scheduled_run_key = _identifier(run_key, "runKey")
        output_digest = _sha256(source_output_sha256, "sourceOutputSha256")
        with self._read() as connection:
            row = connection.execute(
                """SELECT * FROM bilibili_subscriptions
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=?""",
                (*scope, identifier),
            ).fetchone()
        if row is None:
            raise _not_found("Bilibili subscription was not found")
        if (
            int(row["version"]) != expected
            or str(row["scheduled_run_key"] or "") != scheduled_run_key
            or int(row["scheduled_expected_version"]) != expected
            or row["scheduled_run_state"] != "claimed"
        ):
            raise _conflict("Notification intent does not match the active scheduled run")
        if row["state"] != "active" or int(row["expires_at"]) <= _now_ms():
            return {
                "allowed": False,
                "reason": "subscription_inactive",
                "subscriptionId": identifier,
                "version": int(row["version"]),
            }
        prior_outcome = row["last_notification_outcome"]
        if prior_outcome in {"queued", "accepted", "uncertain"}:
            return {
                "allowed": False,
                "reason": "outbox_reconciliation_required",
                "notificationId": row["last_notification_receipt_id"],
                "subscriptionId": identifier,
                "version": int(row["version"]),
            }
        if prior_outcome == "delivered" and str(row["last_output_sha256"] or "") == output_digest:
            return {
                "allowed": False,
                "reason": "unchanged_result",
                "notificationId": row["last_notification_receipt_id"],
                "subscriptionId": identifier,
                "version": int(row["version"]),
            }
        notification_key = (
            "bili-notification-"
            + hashlib.sha256(f"{identifier}\0{output_digest}".encode()).hexdigest()
        )
        return {
            "allowed": True,
            "reason": None,
            "subscriptionId": identifier,
            "version": int(row["version"]),
            "runKey": scheduled_run_key,
            "notificationIdempotencyKey": notification_key,
        }

    def get_subscription(
        self, org: str, workspace: str, actor: str, subscription_id: str
    ) -> WireView:
        scope = _scope(org, workspace, actor)
        identifier = _identifier(subscription_id, "subscriptionId")
        with self._read() as connection:
            row = connection.execute(
                """SELECT * FROM bilibili_subscriptions
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=?""",
                (*scope, identifier),
            ).fetchone()
        if row is None:
            raise _not_found("Bilibili subscription was not found")
        return _subscription_view(row)

    def get_subscription_checkpoint_snapshot(
        self, org: str, workspace: str, actor: str, subscription_id: str
    ) -> WireView | None:
        """Read server-verified run metadata retained with the last result checkpoint."""

        scope = _scope(org, workspace, actor)
        identifier = _identifier(subscription_id, "subscriptionId")
        with self._read() as connection:
            row = connection.execute(
                """SELECT checkpoint_json FROM bilibili_subscriptions
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=?""",
                (*scope, identifier),
            ).fetchone()
        if row is None:
            raise _not_found("Bilibili subscription was not found")
        checkpoint = row["checkpoint_json"]
        if checkpoint is None:
            return None
        decoded = _decode(row, "checkpoint_json")
        if not isinstance(decoded, Mapping):
            raise PersistenceError(
                "BILIBILI_STORAGE_CORRUPT", 500, "Stored subscription checkpoint is invalid."
            )
        return dict(decoded)

    def get_notification_reconciliation_snapshot(
        self, org: str, workspace: str, actor: str, subscription_id: str
    ) -> WireView | None:
        """Read the last notification CAS receipt for idempotent HTTP replay."""

        scope = _scope(org, workspace, actor)
        identifier = _identifier(subscription_id, "subscriptionId")
        with self._read() as connection:
            row = connection.execute(
                """SELECT notification_reconciliation_json FROM bilibili_subscriptions
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=?""",
                (*scope, identifier),
            ).fetchone()
        if row is None:
            raise _not_found("Bilibili subscription was not found")
        reconciliation = row["notification_reconciliation_json"]
        if reconciliation is None:
            return None
        decoded = _decode(row, "notification_reconciliation_json")
        if not isinstance(decoded, Mapping):
            raise PersistenceError(
                "BILIBILI_STORAGE_CORRUPT",
                500,
                "Stored notification reconciliation is invalid.",
            )
        return dict(decoded)

    def list_subscriptions(
        self,
        org: str,
        workspace: str,
        actor: str,
        *,
        state: str | None = None,
        delegation_id: str | None = None,
        cursor: str | None = None,
        limit: int = 100,
    ) -> WireView:
        scope = _scope(org, workspace, actor)
        selected_state = _optional_choice(state, "state", _SUBSCRIPTION_STATES)
        selected_delegation = (
            None if delegation_id is None else _identifier(delegation_id, "delegationId")
        )
        page_limit = _list_limit(limit)
        where = "org=? AND workspace=? AND actor=?"
        params: tuple[object, ...] = scope
        if selected_state == "expired":
            where += " AND state!='cancelled' AND expires_at<=?"
            params += (_now_ms(),)
        elif selected_state == "active":
            where += " AND state='active' AND expires_at>?"
            params += (_now_ms(),)
        elif selected_state is not None:
            where += " AND state=?"
            params += (selected_state,)
        if selected_delegation is not None:
            where += " AND delegation_id=?"
            params += (selected_delegation,)
        if cursor is not None:
            cursor_row = self._get_page_cursor(
                "bilibili_subscriptions", "subscription_id", scope, cursor
            )
            where += " AND (created_at>? OR (created_at=? AND subscription_id>?))"
            params += (cursor_row["created_at"], cursor_row["created_at"], cursor)
        with self._read() as connection:
            rows = connection.execute(
                f"""SELECT * FROM bilibili_subscriptions WHERE {where}
                    ORDER BY created_at,subscription_id LIMIT ?""",
                (*params, page_limit + 1),
            ).fetchall()
        has_more = len(rows) > page_limit
        page = rows[:page_limit]
        return {
            "items": [_subscription_view(row) for row in page],
            "nextCursor": str(page[-1]["subscription_id"]) if has_more and page else None,
        }

    def record_subscription_check(
        self,
        org: str,
        workspace: str,
        actor: str,
        subscription_id: str,
        expected_version: int,
        checkpoint: Mapping[str, object],
    ) -> WireView:
        """Persist one worker-produced result and outbox reference with a CAS."""

        scope = _scope(org, workspace, actor)
        identifier = _identifier(subscription_id, "subscriptionId")
        expected = _version(expected_version, "expectedVersion")
        payload = _body(
            checkpoint,
            required={
                "runKey",
                "cursor",
                "lastOutputSha256",
                "lastOperationReceiptId",
                "lastNotificationOutcome",
                "state",
                "nextCheckAt",
            },
            optional={
                "lastNotificationReceiptId",
                "lastNotificationReadbackReceiptId",
                "lastDeliveryReceiptId",
                "verifiedRunPlan",
            },
        )
        run_key = _identifier(payload["runKey"], "runKey")
        cursor = _optional_text(payload["cursor"], "cursor", maximum=2_048)
        output_digest = _sha256(payload["lastOutputSha256"], "lastOutputSha256")
        operation_id = _identifier(payload["lastOperationReceiptId"], "lastOperationReceiptId")
        notification_outcome = (
            None
            if payload["lastNotificationOutcome"] is None
            else _choice(
                payload["lastNotificationOutcome"],
                "lastNotificationOutcome",
                _NOTIFICATION_OUTCOMES,
            )
        )
        notification_id = _optional_identifier(
            payload.get("lastNotificationReceiptId"), "lastNotificationReceiptId"
        )
        notification_readback_id = _optional_identifier(
            payload.get("lastNotificationReadbackReceiptId"),
            "lastNotificationReadbackReceiptId",
        )
        delivery_id = _optional_identifier(
            payload.get("lastDeliveryReceiptId"), "lastDeliveryReceiptId"
        )
        next_check = _optional_timestamp(payload["nextCheckAt"], "nextCheckAt")
        next_state = _choice(payload["state"], "state", _SUBSCRIPTION_STATES)
        run_plan_snapshot = payload.get("verifiedRunPlan")
        if run_plan_snapshot is not None:
            if not isinstance(run_plan_snapshot, Mapping):
                raise _invalid("verifiedRunPlan must be a server-generated object")
            _safe_tree(run_plan_snapshot, "verifiedRunPlan")
        if notification_outcome in {"queued", "accepted", "delivered"} and notification_id is None:
            raise _invalid("queued, accepted, or delivered notifications require their receipt id")
        if notification_outcome == "delivered" and (
            notification_id is None or notification_readback_id is None or delivery_id is None
        ):
            raise _invalid("delivered notifications require outbox and readback receipts")
        if notification_outcome != "delivered" and (
            delivery_id is not None or notification_readback_id is not None
        ):
            raise _invalid("delivery receipt is only valid for a delivered notification")
        if notification_outcome is None and notification_id is not None:
            raise _invalid("an absent notification outcome cannot carry an outbox receipt")
        if next_state == "active" and next_check is None:
            raise _invalid("active subscriptions require nextCheckAt")
        checkpoint_view = {
            "cursor": cursor,
            "lastOutputSha256": output_digest,
            "lastOperationReceiptId": operation_id,
            "lastNotificationReceiptId": notification_id,
            "lastNotificationReadbackReceiptId": notification_readback_id,
            "lastNotificationOutcome": notification_outcome,
            "lastDeliveryReceiptId": delivery_id,
            "state": next_state,
            "nextCheckAt": next_check,
            "runKey": run_key,
            "expectedVersion": expected,
            "verifiedRunPlan": (
                None if run_plan_snapshot is None else dict(run_plan_snapshot)
            ),
        }
        checkpoint_json = _json_dumps(checkpoint_view)
        now = _now_ms()
        with self._write() as connection:
            row = connection.execute(
                """SELECT * FROM bilibili_subscriptions
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=?""",
                (*scope, identifier),
            ).fetchone()
            if row is None:
                raise _not_found("Bilibili subscription was not found")
            if (
                str(row["checkpoint_json"] or "") == checkpoint_json
                and int(row["version"]) == expected + 1
            ):
                return _subscription_view(row)
            if (
                int(row["version"]) != expected
                or row["state"] not in {"active", "uncertain"}
                or row["scheduled_run_state"] != "claimed"
                or row["scheduled_run_key"] != run_key
                or int(row["scheduled_expected_version"]) != expected
            ):
                raise _conflict("Bilibili subscription state or version changed")
            prior_notification = row["last_notification_outcome"]
            prior_notification_id = row["last_notification_receipt_id"]
            if prior_notification in {"queued", "accepted", "uncertain"} and (
                notification_id != prior_notification_id
            ):
                raise _conflict(
                    "Pending or uncertain notification must be reconciled before a new send"
                )
            if (
                prior_notification == "delivered"
                and output_digest == row["last_output_sha256"]
                and notification_id != prior_notification_id
            ):
                raise _conflict("An unchanged result cannot enqueue another notification")
            updated_version = expected + 1
            next_due = next_check if next_state == "active" else None
            next_run_key = (
                bilibili_subscription_run_key(*scope, identifier, next_due, updated_version)
                if next_due is not None
                else None
            )
            next_run_state = "scheduled" if next_due is not None else "completed"
            connection.execute(
                """UPDATE bilibili_subscriptions SET cursor=?,last_output_sha256=?,
                       last_operation_receipt_id=?,last_notification_receipt_id=?,
                       last_notification_readback_receipt_id=?,last_notification_outcome=?,
                       last_delivery_receipt_id=?,state=?,next_check_at=?,
                       scheduled_run_key=?,scheduled_expected_version=?,scheduled_run_state=?,
                       checkpoint_json=?,version=version+1,updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=? AND version=?""",
                (
                    cursor,
                    output_digest,
                    operation_id,
                    notification_id,
                    notification_readback_id,
                    notification_outcome,
                    delivery_id,
                    next_state,
                    next_check,
                    next_run_key,
                    updated_version,
                    next_run_state,
                    checkpoint_json,
                    now,
                    *scope,
                    identifier,
                    expected,
                ),
            )
            updated = connection.execute(
                """SELECT * FROM bilibili_subscriptions
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=?""",
                (*scope, identifier),
            ).fetchone()
        assert updated is not None
        return _subscription_view(updated)

    def reconcile_subscription_notification(
        self,
        org: str,
        workspace: str,
        actor: str,
        subscription_id: str,
        expected_version: int,
        reconciliation: Mapping[str, object],
    ) -> WireView:
        """CAS a prior outbox status without claiming or replacing a read run."""

        scope = _scope(org, workspace, actor)
        identifier = _identifier(subscription_id, "subscriptionId")
        expected = _version(expected_version, "expectedVersion")
        payload = _body(
            reconciliation,
            required={
                "runKey",
                "notificationReceiptId",
                "notificationOutcome",
                "state",
                "nextCheckAt",
            },
            optional={"notificationReadbackReceiptId", "deliveryReceiptId"},
        )
        run_key = _identifier(payload["runKey"], "runKey")
        notification_id = _identifier(payload["notificationReceiptId"], "notificationReceiptId")
        outcome = _choice(payload["notificationOutcome"], "notificationOutcome", _NOTIFICATION_OUTCOMES)
        readback_id = _optional_identifier(
            payload.get("notificationReadbackReceiptId"), "notificationReadbackReceiptId"
        )
        delivery_id = _optional_identifier(payload.get("deliveryReceiptId"), "deliveryReceiptId")
        state = _choice(payload["state"], "state", {"active", "paused", "cancelled", "uncertain"})
        next_check = _optional_timestamp(payload["nextCheckAt"], "nextCheckAt")
        if state == "active" and next_check is None:
            raise _invalid("active subscriptions require nextCheckAt")
        if outcome == "delivered":
            if readback_id is None or delivery_id is None:
                raise _invalid("delivered notification requires readback and delivery receipts")
        elif readback_id is not None or delivery_id is not None:
            raise _invalid("non-delivered notification cannot carry delivery receipts")
        checkpoint = {
            "expectedVersion": expected,
            "runKey": run_key,
            "notificationReceiptId": notification_id,
            "notificationReadbackReceiptId": readback_id,
            "notificationOutcome": outcome,
            "deliveryReceiptId": delivery_id,
            "state": state,
            "nextCheckAt": next_check,
        }
        encoded = _json_dumps(checkpoint)
        now = _now_ms()
        with self._write() as connection:
            row = connection.execute(
                """SELECT * FROM bilibili_subscriptions
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=?""",
                (*scope, identifier),
            ).fetchone()
            if row is None:
                raise _not_found("Bilibili subscription was not found")
            if (
                str(row["notification_reconciliation_json"] or "") == encoded
                and int(row["version"]) == expected + 1
            ):
                return _subscription_view(row)
            if (
                int(row["version"]) != expected
                or row["state"] not in {"active", "uncertain"}
                or row["scheduled_run_state"] != "scheduled"
                or str(row["scheduled_run_key"] or "") != run_key
                or int(row["scheduled_expected_version"]) != expected
                or str(row["last_notification_receipt_id"] or "") != notification_id
            ):
                raise _conflict("Notification reconciliation no longer matches the subscription")
            prior_outcome = row["last_notification_outcome"]
            allowed_transitions = {
                "queued": {"queued", "accepted", "delivered", "held", "uncertain"},
                "accepted": {"accepted", "delivered", "held", "uncertain"},
                "uncertain": {"uncertain", "accepted", "delivered", "held"},
            }
            if prior_outcome not in allowed_transitions or outcome not in allowed_transitions[
                str(prior_outcome)
            ]:
                raise _conflict("Notification outcome cannot be reopened or downgraded")
            if state == "active" and next_check is not None:
                if next_check >= int(row["expires_at"]):
                    raise _invalid("nextCheckAt must precede expiresAt")
            updated_version = expected + 1
            next_run_key = (
                bilibili_subscription_run_key(*scope, identifier, next_check, updated_version)
                if state == "active" and next_check is not None
                else None
            )
            next_run_state = "scheduled" if next_run_key is not None else "completed"
            connection.execute(
                """UPDATE bilibili_subscriptions SET
                       last_notification_readback_receipt_id=?,last_notification_outcome=?,
                       last_delivery_receipt_id=?,state=?,next_check_at=?,
                       scheduled_run_key=?,scheduled_expected_version=?,scheduled_run_state=?,
                       notification_reconciliation_json=?,version=version+1,updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=? AND version=?""",
                (
                    readback_id,
                    outcome,
                    delivery_id,
                    state,
                    next_check,
                    next_run_key,
                    updated_version,
                    next_run_state,
                    encoded,
                    now,
                    *scope,
                    identifier,
                    expected,
                ),
            )
            updated = connection.execute(
                """SELECT * FROM bilibili_subscriptions
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=?""",
                (*scope, identifier),
            ).fetchone()
        assert updated is not None
        return _subscription_view(updated)

    def transition_subscription(
        self,
        org: str,
        workspace: str,
        actor: str,
        subscription_id: str,
        expected_version: int,
        state: str,
        next_check_at: int | None,
    ) -> WireView:
        """Pause, resume, or cancel an owner subscription with optimistic CAS."""

        scope = _scope(org, workspace, actor)
        identifier = _identifier(subscription_id, "subscriptionId")
        expected = _version(expected_version, "expectedVersion")
        selected_state = _choice(state, "state", {"active", "paused", "cancelled"})
        next_check = _optional_timestamp(next_check_at, "nextCheckAt")
        if selected_state == "active" and next_check is None:
            raise _invalid("active subscriptions require nextCheckAt")
        with self._write() as connection:
            row = connection.execute(
                """SELECT * FROM bilibili_subscriptions
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=?""",
                (*scope, identifier),
            ).fetchone()
            if row is None:
                raise _not_found("Bilibili subscription was not found")
            if (
                row["state"] == selected_state
                and int(row["version"]) == expected + 1
                and row["next_check_at"] == next_check
            ):
                return _subscription_view(row)
            current_state = str(row["state"])
            if int(row["version"]) != expected or current_state not in {
                "active",
                "paused",
                "uncertain",
            }:
                raise _conflict("Bilibili subscription state or version changed")
            if current_state == "uncertain" and selected_state != "cancelled":
                raise _conflict("An uncertain subscription can only be cancelled")
            if selected_state == "active":
                delegation = connection.execute(
                    """SELECT state,expires_at FROM bilibili_delegations
                       WHERE org=? AND workspace=? AND actor=? AND delegation_id=?""",
                    (*scope, row["delegation_id"]),
                ).fetchone()
                if (
                    delegation is None
                    or delegation["state"] != "active"
                    or int(delegation["expires_at"]) <= _now_ms()
                    or int(row["expires_at"]) <= _now_ms()
                ):
                    raise _conflict("An expired or revoked delegation cannot be resumed")
            if selected_state == "active" and next_check is not None:
                if next_check >= int(row["expires_at"]):
                    raise _invalid("nextCheckAt must precede expiresAt")
                new_version = expected + 1
                run_key = bilibili_subscription_run_key(*scope, identifier, next_check, new_version)
                run_state = "scheduled"
            else:
                new_version = expected + 1
                run_key = None
                run_state = "completed"
            now = _now_ms()
            connection.execute(
                """UPDATE bilibili_subscriptions SET state=?,next_check_at=?,
                       scheduled_run_key=?,scheduled_expected_version=?,scheduled_run_state=?,
                       version=version+1,updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=? AND version=?""",
                (
                    selected_state,
                    next_check,
                    run_key,
                    new_version,
                    run_state,
                    now,
                    *scope,
                    identifier,
                    expected,
                ),
            )
            updated = connection.execute(
                """SELECT * FROM bilibili_subscriptions
                   WHERE org=? AND workspace=? AND actor=? AND subscription_id=?""",
                (*scope, identifier),
            ).fetchone()
        assert updated is not None
        return _subscription_view(updated)

    def _get_page_cursor(
        self, table: str, id_column: str, scope: tuple[str, str, str], cursor: str
    ) -> sqlite3.Row:
        identifier = _identifier(cursor, "cursor")
        # Table and column are selected only by these internal call sites.
        with self._read() as connection:
            row = connection.execute(
                f"SELECT created_at FROM {table} WHERE org=? AND workspace=? AND actor=? "
                f"AND {id_column}=?",
                (*scope, identifier),
            ).fetchone()
        if row is None:
            raise _invalid("cursor is not in this actor scope")
        return cast(sqlite3.Row, row)


def _delegation_grants(
    value: object, profile_ref: str, external_subject: str
) -> list[dict[str, object]]:
    if not isinstance(value, list) or not 1 <= len(value) <= 256:
        raise _invalid("grants must contain 1..256 exact operation scopes")
    result: list[dict[str, object]] = []
    seen: set[tuple[str, str]] = set()
    for item in value:
        grant = _body(
            item,
            required={"operationId", "target", "argumentsDigestSha256"},
            optional=set(),
        )
        operation = _choice(grant["operationId"], "operationId", set(BILIBILI_OPERATION_IDS))
        target_raw = grant["target"]
        if not isinstance(target_raw, Mapping):
            raise _invalid("grant.target must be an object")
        target = _target(operation, target_raw)
        args_digest = _sha256(grant["argumentsDigestSha256"], "argumentsDigestSha256")
        if operation == "bilibili.dynamic.publish" and target.get("user_id") != external_subject:
            raise _invalid("dynamic.publish is limited to the connected profile owner")
        resource_ref = _resource_ref(profile_ref, operation, target)
        unique_key = (operation, resource_ref)
        if unique_key in seen:
            raise _invalid("delegation grants must be unique")
        seen.add(unique_key)
        result.append(
            {
                "operationId": operation,
                "target": target,
                "resourceRef": resource_ref,
                "argumentsDigestSha256": args_digest,
            }
        )
    return result


def _target(operation_id: str, value: Mapping[str, object]) -> dict[str, object]:
    required, optional = _TARGET_KEYS[operation_id]
    keys = set(value)
    if not set(required).issubset(keys) or keys - set(required) - set(optional):
        raise _invalid(f"target fields are not exact for {operation_id}")
    if operation_id == "bilibili.comment.create" and (
        "parent_comment_id" in keys and "root_comment_id" not in keys
    ):
        raise _invalid("parent_comment_id requires root_comment_id")
    result: dict[str, object] = {}
    for key in required + optional:
        if key not in value:
            continue
        item = value[key]
        if isinstance(item, bool) or not isinstance(item, (str, int)):
            raise _invalid(f"target.{key} must be bounded text or an integer id")
        if isinstance(item, str):
            item = _text(item, f"target.{key}", maximum=512)
            if item.casefold() in {"*", "all", "any"} or "*" in item or "?" in item:
                raise _invalid(f"target.{key} must be an exact, non-wildcard selector")
        elif item < 0 or item > 2**63 - 1:
            raise _invalid(f"target.{key} is outside the supported range")
        result[key] = item
    return result


def _operation_target(operation_id: str, arguments: Mapping[str, object]) -> dict[str, object]:
    required, optional = _TARGET_KEYS[operation_id]
    if not set(required).issubset(arguments):
        raise _invalid(f"arguments are missing target fields for {operation_id}")
    return _target(
        operation_id, {key: arguments[key] for key in required + optional if key in arguments}
    )


def normalize_bilibili_arguments(
    operation_id: str, arguments: Mapping[str, object]
) -> dict[str, object]:
    """Validate one bounded provider argument object before preflight.

    Args:
        operation_id: One supported Bilibili operation identifier.
        arguments: Host-normalized arguments that will be sent to Exchange.
    Returns:
        A JSON-safe copy whose target selector can be checked against a grant.
    Raises:
        PersistenceError: If the operation or arguments are unsafe or malformed.
    """

    _choice(operation_id, "operationId", set(BILIBILI_OPERATION_IDS))
    return _json_object(arguments, "arguments")


def bilibili_target_from_arguments(
    operation_id: str, arguments: Mapping[str, object]
) -> dict[str, object]:
    """Extract the exact Exchange selector fields from normalized arguments."""

    operation = _choice(operation_id, "operationId", set(BILIBILI_OPERATION_IDS))
    return _operation_target(operation, normalize_bilibili_arguments(operation, arguments))


def bilibili_resource_ref(profile_ref: str, operation_id: str, target: Mapping[str, object]) -> str:
    """Return the canonical provider, profile, operation, and target digest."""

    profile = _identifier(profile_ref, "profileRef")
    operation = _choice(operation_id, "operationId", set(BILIBILI_OPERATION_IDS))
    return _resource_ref(profile, operation, _target(operation, target))


def _resource_ref(profile_ref: str, operation_id: str, target: Mapping[str, object]) -> str:
    digest = hashlib.sha256(
        _canonical(
            {
                "providerId": "bilibili",
                "profileRef": profile_ref,
                "operationId": operation_id,
                "target": target,
            }
        ).encode()
    ).hexdigest()
    return f"sha256:{digest}"


def _source_refs(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list) or not 1 <= len(value) <= _MAX_SOURCE_REFS:
        raise _invalid("sourceRefs must contain 1..256 P2 references")
    refs: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, Mapping) or set(item) - {
            "memoryId",
            "memoryVersion",
            "sourceMessageIds",
        }:
            raise _invalid("sourceRefs entries must use the exact P2 lineage shape")
        memory_id = item.get("memoryId")
        memory_version = item.get("memoryVersion")
        ids = item.get("sourceMessageIds", [])
        if (memory_id is None) != (memory_version is None):
            raise _invalid("memoryId and memoryVersion must be supplied together")
        if memory_id is not None:
            memory_id = _identifier(memory_id, "sourceRefs.memoryId")
            memory_version = _positive_integer(memory_version, "sourceRefs.memoryVersion")
        if not isinstance(ids, list) or len(ids) > 128:
            raise _invalid("sourceMessageIds must contain at most 128 ids")
        message_ids = list(dict.fromkeys(_identifier(item, "sourceMessageIds") for item in ids))
        if memory_id is None and not message_ids:
            raise _invalid("source reference must include a memory or message id")
        normalized = {
            "memoryId": memory_id,
            "memoryVersion": memory_version,
            "sourceMessageIds": message_ids,
        }
        digest = _digest(normalized)
        if digest not in seen:
            seen.add(digest)
            refs.append(normalized)
    return refs


def _conversation_context(payload: Mapping[str, object]) -> tuple[str, str, str | None]:
    conversation_id = _identifier(payload["conversationId"], "conversationId")
    conversation_kind = _choice(
        payload["conversationKind"], "conversationKind", {"direct", "group", "channel"}
    )
    persona_id = _optional_identifier(payload.get("personaId"), "personaId")
    return conversation_id, conversation_kind, persona_id


def _delegation_view(row: sqlite3.Row) -> WireView:
    expires_at = int(row["expires_at"])
    stored_state = str(row["state"])
    state = "expired" if stored_state == "active" and expires_at <= _now_ms() else stored_state
    return {
        "id": str(row["delegation_id"]),
        "idempotencyKey": str(row["idempotency_key"]),
        "workspaceId": str(row["workspace"]),
        "ownerActorId": str(row["actor"]),
        "connectionRef": str(row["connection_ref"]),
        "profileRef": str(row["profile_ref"]),
        "conversationId": str(row["conversation_id"]),
        "conversationKind": str(row["conversation_kind"]),
        "personaId": row["persona_id"],
        "grants": _json_array(_decode(row, "grants_json"), "grants"),
        "sourceRefs": _json_array(_decode(row, "source_refs_json"), "sourceRefs"),
        "expiresAt": expires_at,
        "state": state,
        "version": int(row["version"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


def _subscription_view(row: sqlite3.Row) -> WireView:
    expires_at = int(row["expires_at"])
    stored_state = str(row["state"])
    state = "expired" if stored_state == "active" and expires_at <= _now_ms() else stored_state
    return {
        "id": str(row["subscription_id"]),
        "idempotencyKey": str(row["idempotency_key"]),
        "workspaceId": str(row["workspace"]),
        "ownerActorId": str(row["actor"]),
        "conversationId": str(row["conversation_id"]),
        "conversationKind": str(row["conversation_kind"]),
        "personaId": row["persona_id"],
        "delegationId": str(row["delegation_id"]),
        "connectionRef": str(row["connection_ref"]),
        "profileRef": str(row["profile_ref"]),
        "ownerTaskId": str(row["owner_task_id"]),
        "ownerSessionId": str(row["owner_session_id"]),
        "operationId": str(row["operation_id"]),
        "resourceRef": str(row["resource_ref"]),
        "arguments": _json_object(_decode(row, "arguments_json"), "arguments"),
        "sourceRefs": _json_array(_decode(row, "source_refs_json"), "sourceRefs"),
        "expiresAt": expires_at,
        "nextCheckAt": row["next_check_at"],
        "scheduledRunKey": row["scheduled_run_key"],
        "scheduledExpectedVersion": int(row["scheduled_expected_version"]),
        "scheduledRunState": str(row["scheduled_run_state"]),
        "cursor": row["cursor"],
        "lastOutputSha256": row["last_output_sha256"],
        "lastOperationReceiptId": row["last_operation_receipt_id"],
        "lastNotificationReceiptId": row["last_notification_receipt_id"],
        "lastNotificationReadbackReceiptId": row["last_notification_readback_receipt_id"],
        "lastNotificationOutcome": row["last_notification_outcome"],
        "lastDeliveryReceiptId": row["last_delivery_receipt_id"],
        "notificationSendAllowed": (
            state == "active"
            and row["last_notification_outcome"] not in {"queued", "accepted", "uncertain"}
        ),
        "state": state,
        "version": int(row["version"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


def _scope(org: str, workspace: str, actor: str) -> tuple[str, str, str]:
    return (
        _identifier(org, "org"),
        _identifier(workspace, "workspace"),
        _identifier(actor, "actor"),
    )


def _body(
    value: Mapping[str, object], *, required: set[str], optional: set[str]
) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise _invalid("body must be an object")
    keys = set(value)
    if any(not isinstance(key, str) for key in keys):
        raise _invalid("body keys must be strings")
    if not required.issubset(keys) or keys - required - optional:
        raise _invalid("body contains missing or unsupported fields")
    _safe_tree(value, "body")
    if len(_canonical(value).encode()) > _MAX_BODY_BYTES:
        raise _invalid("body exceeds the supported size")
    return dict(value)


def _safe_tree(value: object, field: str, depth: int = 0) -> None:
    if depth > 12:
        raise _invalid(f"{field} is nested too deeply")
    if value is None or type(value) in {bool, int}:
        return
    if isinstance(value, str):
        if len(value) > 16_000 or any(ord(ch) < 32 and ch not in "\n\r\t" for ch in value):
            raise _invalid(f"{field} contains unsafe text")
        if re.search(
            r"\b(password|access[_-]?token|refresh[_-]?token|cookie|authorization)\s*[:=]",
            value,
            re.I,
        ):
            raise _invalid(f"{field} contains credential-like text")
        return
    if isinstance(value, Mapping):
        for key, nested in value.items():
            if not isinstance(key, str):
                raise _invalid(f"{field} keys must be text")
            normalized = re.sub(r"[^a-z0-9]", "", key.casefold())
            if normalized in {
                "password",
                "accesstoken",
                "refreshtoken",
                "cookie",
                "authorization",
                "clientsecret",
                "credential",
                "credentials",
                "actorid",
                "owneractorid",
            }:
                raise _invalid(f"{field} contains an unsupported sensitive field")
            _safe_tree(nested, f"{field}.{key}", depth + 1)
        return
    if isinstance(value, (list, tuple)):
        if len(value) > 1_000:
            raise _invalid(f"{field} contains too many items")
        for index, item in enumerate(value):
            _safe_tree(item, f"{field}[{index}]", depth + 1)
        return
    raise _invalid(f"{field} must contain JSON-compatible data")


def _json_object(value: object, field: str) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise _invalid(f"{field} must be an object")
    _safe_tree(value, field)
    return dict(value)


def _json_array(value: object, field: str) -> list[object]:
    if not isinstance(value, list):
        raise PersistenceError("BILIBILI_STORAGE_CORRUPT", 500, f"Stored {field} is invalid")
    return value


def _decode(row: sqlite3.Row, field: str) -> object:
    try:
        return json.loads(str(row[field]))
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise PersistenceError(
            "BILIBILI_STORAGE_CORRUPT", 500, f"Stored {field} is invalid"
        ) from exc


def _json_dumps(value: object) -> str:
    return _canonical(value)


def _canonical(value: object) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise _invalid("value must be JSON-compatible") from exc


def _digest(value: object) -> str:
    return hashlib.sha256(_canonical(value).encode()).hexdigest()


def _identifier(value: object, field: str) -> str:
    text = _text(value, field, maximum=512)
    if any(ord(ch) < 33 or ord(ch) == 127 for ch in text):
        raise _invalid(f"{field} contains control characters")
    return text


def _optional_identifier(value: object, field: str) -> str | None:
    return None if value is None else _identifier(value, field)


def _optional_text(value: object, field: str, *, maximum: int) -> str | None:
    return None if value is None else _text(value, field, maximum=maximum)


def _idempotency_key(value: object) -> str:
    return _text(value, "idempotencyKey", maximum=200)


def _text(value: object, field: str, *, maximum: int = 2_000) -> str:
    if not isinstance(value, str):
        raise _invalid(f"{field} must be text")
    result = value.strip()
    if not result or len(result) > maximum:
        raise _invalid(f"{field} is empty or too long")
    return result


def _choice(value: object, field: str, choices: set[str]) -> str:
    if not isinstance(value, str) or value not in choices:
        raise _invalid(f"{field} has an unsupported value")
    return value


def _optional_choice(value: object, field: str, choices: set[str]) -> str | None:
    return None if value is None else _choice(value, field, choices)


def _positive_integer(value: object, field: str) -> int:
    if type(value) is not int or value < 1 or value > 2**63 - 1:
        raise _invalid(f"{field} must be a positive integer")
    return value


def _version(value: object, field: str) -> int:
    return _positive_integer(value, field)


def _list_limit(value: int) -> int:
    if type(value) is not int or not 1 <= value <= _MAX_LIST_LIMIT:
        raise _invalid("limit must be between 1 and 500")
    return value


def _timestamp(value: object, field: str) -> int:
    if type(value) is not int or value < 0 or value > 253_402_300_799_999:
        raise _invalid(f"{field} must be an epoch millisecond timestamp")
    return value


def _optional_timestamp(value: object, field: str) -> int | None:
    return None if value is None else _timestamp(value, field)


def _future_expiry(value: object) -> int:
    expires_at = _timestamp(value, "expiresAt")
    now = _now_ms()
    if expires_at <= now or expires_at > now + _MAX_DELEGATION_TTL_MS:
        raise _invalid("expiresAt must be within the next 30 days")
    return expires_at


def _sha256(value: object, field: str) -> str:
    text = _text(value, field, maximum=64)
    if re.fullmatch(r"[a-fA-F0-9]{64}", text) is None:
        raise _invalid(f"{field} must be a SHA-256 digest")
    return text.lower()


def _new_id() -> str:
    return str(uuid.uuid4())


def bilibili_subscription_run_key(
    org_id: str,
    workspace_id: str,
    actor_id: str,
    subscription_id: str,
    due_at: int,
    expected_version: int,
) -> str:
    """Derive a durable scheduler run key from the claimed source snapshot."""

    org = _identifier(org_id, "organizationId")
    workspace = _identifier(workspace_id, "workspaceId")
    actor = _identifier(actor_id, "actorId")
    subscription = _identifier(subscription_id, "subscriptionId")
    due = _timestamp(due_at, "dueAt")
    version = _version(expected_version, "expectedVersion")
    digest = hashlib.sha256(
        f"cyrene-bili-subscription-run-v1\0{org}\0{workspace}\0{actor}\0{subscription}\0{due}\0{version}".encode()
    ).hexdigest()[:32]
    return f"bili-run-{digest}"


def bilibili_subscription_task_id(
    workspace_id: str,
    actor_id: str,
    subscription_id: str,
    run_key: str,
) -> str:
    """Derive the child Task id from a persisted run key, not a result receipt."""

    workspace = _identifier(workspace_id, "workspaceId")
    actor = _identifier(actor_id, "actorId")
    subscription = _identifier(subscription_id, "subscriptionId")
    run_identifier = _identifier(run_key, "runKey")
    digest = hashlib.sha256(
        f"cyrene-bili-subscription-check-v1\0{workspace}\0{actor}\0{subscription}\0{run_identifier}".encode()
    ).hexdigest()[:32]
    return f"bili-watch-{digest}"


def bilibili_subscription_operation_idempotency_key(
    workspace_id: str,
    actor_id: str,
    subscription_id: str,
    run_key: str,
) -> str:
    """Derive the stable Work Operation key for one persisted scheduled run."""

    workspace = _identifier(workspace_id, "workspaceId")
    actor = _identifier(actor_id, "actorId")
    subscription = _identifier(subscription_id, "subscriptionId")
    run_identifier = _identifier(run_key, "runKey")
    digest = hashlib.sha256(
        f"cyrene-bili-subscription-operation-v1\0{workspace}\0{actor}\0{subscription}\0{run_identifier}".encode()
    ).hexdigest()[:32]
    return f"bili-operation-{digest}"


def bilibili_notification_task_id(
    workspace_id: str,
    actor_id: str,
    subscription_id: str,
    notification_idempotency_key: str,
) -> str:
    """Derive the stable child Task id for one persisted notification intent."""

    workspace = _identifier(workspace_id, "workspaceId")
    actor = _identifier(actor_id, "actorId")
    subscription = _identifier(subscription_id, "subscriptionId")
    notification_key = _idempotency_key(notification_idempotency_key)
    resource = f"{workspace}:{actor}:bili:{subscription}:notify:{notification_key}"
    digest = hashlib.sha256(f"watch\0{resource}".encode()).hexdigest()[:40]
    return f"conversation-watch-{digest}"


def bilibili_notification_readback_task_id(
    workspace_id: str,
    actor_id: str,
    subscription_id: str,
    notification_idempotency_key: str,
    notification_id: str,
    notification_updated_at: int,
) -> str:
    """Derive the stable readback Task id from the immutable delivered outbox row."""

    workspace = _identifier(workspace_id, "workspaceId")
    actor = _identifier(actor_id, "actorId")
    subscription = _identifier(subscription_id, "subscriptionId")
    notification_key = _idempotency_key(notification_idempotency_key)
    identifier = _identifier(notification_id, "notificationId")
    updated_at = _timestamp(notification_updated_at, "notification.updatedAt")
    resource = (
        f"{workspace}:{actor}:bili:{subscription}:notification-readback:"
        f"{notification_key}:{identifier}:{updated_at}"
    )
    digest = hashlib.sha256(f"watch\0{resource}".encode()).hexdigest()[:40]
    return f"conversation-watch-{digest}"


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


def _invalid(detail: str) -> PersistenceError:
    return PersistenceError("BILIBILI_DOMAIN_INVALID", 422, detail)


def _not_found(detail: str) -> PersistenceError:
    return PersistenceError("BILIBILI_DOMAIN_NOT_FOUND", 404, detail)


def _conflict(detail: str) -> PersistenceError:
    return PersistenceError("BILIBILI_DOMAIN_CONFLICT", 409, detail)


def _storage_error(detail: str, exc: sqlite3.Error) -> PersistenceError:
    return PersistenceError(
        "BILIBILI_STORAGE_ERROR",
        503 if isinstance(exc, sqlite3.OperationalError) else 500,
        detail,
        retryable=isinstance(exc, sqlite3.OperationalError),
    )
