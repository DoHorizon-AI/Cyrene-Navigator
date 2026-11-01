"""
Navigator conversation-memory product domain persistence.

This module owns a separate SQLite database for profile, maintenance, research,
watch, focus, handoff, review, and import projections. It does not execute graph
provider operations or infer source authorization.

模块职责：持久化 Navigator 对话记忆产品域状态；来源授权由 API facade 校验。
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import time
import uuid
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from cyrene_navigator.persistence.errors import PersistenceError

WireView = dict[str, object]

_MAX_BODY_BYTES = 256 * 1024
_MAX_IMPORT_BYTES = 5 * 1024 * 1024
_MAX_BACKUP_BYTES = 10 * 1024 * 1024
_MAX_TEXT = 16_000
_MAX_SOURCE_REFS = 100
_MAX_IMPORT_RECORDS = 1_000
_MAX_LIST_LIMIT = 500
_JOB_STATES = {"queued", "running", "completed", "failed", "cancelled"}
_MAINTENANCE_CHECKPOINT_STATES = {"running", "completed", "failed", "cancelled"}
_FOCUS_STATES = {"open", "waiting", "done", "cancelled"}
_SENSITIVE_KEYS = {
    "actor",
    "actorid",
    "owneractor",
    "verifiedby",
    "clientsecret",
    "secretkey",
    "apitoken",
    "oauthtoken",
    "password",
    "passwd",
    "secret",
    "accesstoken",
    "refreshtoken",
    "authtoken",
    "authorization",
    "cookie",
    "setcookie",
    "credentials",
    "credential",
    "apikey",
    "privatekey",
    "loginstate",
    "authenticationstate",
    "loggedin",
    "runningtask",
    "runningtasks",
    "taskstate",
    "processid",
    "commandline",
}
_SENSITIVE_TEXT_PATTERNS = (
    re.compile(r"\bbearer\s+[a-z0-9._~+/=-]{12,}", re.IGNORECASE),
    re.compile(
        r"\b(password|passwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|"
        r"refresh[_-]?token|signature|sig)\s*[:=]\s*[^\s,;]{6,}",
        re.IGNORECASE,
    ),
    re.compile(r"\bsk-[a-z0-9_-]{16,}\b", re.IGNORECASE),
)


class ConversationDomainStore:
    """Persist isolated, actor-scoped conversation product domain records.

    Args:
        db_path: Absolute path to this domain store's independent SQLite database.

    The store enforces scope, bounded input, source presence, CAS versions, and
    idempotency. The API facade remains responsible for proving source ownership.
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
            raise PersistenceError(
                "CONVERSATION_DOMAIN_STORAGE_ERROR", 500, "Domain storage read failed"
            ) from exc
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
            raise PersistenceError(
                "CONVERSATION_DOMAIN_STORAGE_ERROR",
                503 if isinstance(exc, sqlite3.OperationalError) else 500,
                "Domain storage write failed",
                retryable=isinstance(exc, sqlite3.OperationalError),
            ) from exc
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
            if version > 4:
                raise PersistenceError(
                    "CONVERSATION_DOMAIN_SCHEMA_UNSUPPORTED",
                    500,
                    "Domain database schema is newer than this application",
                )
            statements = (
                """CREATE TABLE IF NOT EXISTS personas (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    persona_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
                    prompt TEXT NOT NULL, enabled INTEGER NOT NULL,
                    conversation_ids_json TEXT NOT NULL, version INTEGER NOT NULL,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY (org, workspace, actor, persona_id)
                )""",
                """CREATE TABLE IF NOT EXISTS active_behavior_policies (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    conversation_id TEXT NOT NULL, enabled INTEGER NOT NULL,
                    quiet_hours_json TEXT NOT NULL, cooldown_seconds INTEGER NOT NULL,
                    allow_group_interjections INTEGER NOT NULL,
                    followup_enabled INTEGER NOT NULL, version INTEGER NOT NULL,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY (org, workspace, actor, conversation_id)
                )""",
                """CREATE TABLE IF NOT EXISTS profile_candidates (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    candidate_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
                    conversation_id TEXT NOT NULL, conversation_kind TEXT,
                    subject_kind TEXT NOT NULL,
                    persona_id TEXT, category TEXT NOT NULL, text TEXT NOT NULL,
                    source_message_ids_json TEXT NOT NULL,
                    source_refs_json TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL,
                    valid_until INTEGER, state TEXT NOT NULL, version INTEGER NOT NULL,
                    evidence_json TEXT NOT NULL, profile_id TEXT,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY (org, workspace, actor, candidate_id),
                    UNIQUE (org, workspace, actor, idempotency_key)
                )""",
                """CREATE TABLE IF NOT EXISTS profiles (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    profile_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL, conversation_kind TEXT,
                    subject_kind TEXT NOT NULL,
                    persona_id TEXT, category TEXT NOT NULL, text TEXT NOT NULL,
                    source_message_ids_json TEXT NOT NULL,
                    source_refs_json TEXT NOT NULL DEFAULT '[]', evidence_json TEXT NOT NULL,
                    valid_until INTEGER, state TEXT NOT NULL, version INTEGER NOT NULL,
                    previous_profile_id TEXT, created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (org, workspace, actor, profile_id),
                    UNIQUE (org, workspace, actor, candidate_id)
                )""",
                """CREATE INDEX IF NOT EXISTS profiles_active_scope
                    ON profiles (
                        org, workspace, actor, conversation_id, subject_kind, category,
                        persona_id, state
                    )""",
                """CREATE TABLE IF NOT EXISTS graph_changesets (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    changeset_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
                    conversation_id TEXT NOT NULL, conversation_kind TEXT, persona_id TEXT,
                    payload_json TEXT NOT NULL,
                    digest TEXT NOT NULL, node_count INTEGER NOT NULL, edge_count INTEGER NOT NULL,
                    state TEXT NOT NULL, provider_receipt_json TEXT, version INTEGER NOT NULL,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY (org, workspace, actor, changeset_id),
                    UNIQUE (org, workspace, actor, idempotency_key)
                )""",
                """CREATE TABLE IF NOT EXISTS maintenance_jobs (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    job_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, kind TEXT NOT NULL,
                    request_digest TEXT NOT NULL, conversation_id TEXT,
                    conversation_kind TEXT, persona_id TEXT,
                    state TEXT NOT NULL, cursor TEXT,
                    processed_count INTEGER NOT NULL, checkpoint_digest TEXT,
                    details_json TEXT NOT NULL, checkpoint_json TEXT,
                    version INTEGER NOT NULL, created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (org, workspace, actor, job_id),
                    UNIQUE (org, workspace, actor, idempotency_key)
                )""",
                """CREATE TABLE IF NOT EXISTS research_notes (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    note_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
                    conversation_id TEXT NOT NULL, conversation_kind TEXT, persona_id TEXT,
                    title TEXT NOT NULL, content TEXT NOT NULL,
                    source_refs_json TEXT NOT NULL, revision INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (org, workspace, actor, note_id),
                    UNIQUE (org, workspace, actor, idempotency_key)
                )""",
                """CREATE INDEX IF NOT EXISTS research_notes_list
                    ON research_notes (org, workspace, actor, conversation_id, created_at DESC)""",
                """CREATE TABLE IF NOT EXISTS verified_skills (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    skill_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, name TEXT NOT NULL,
                    conversation_id TEXT, conversation_kind TEXT, persona_id TEXT,
                    content TEXT NOT NULL, source_refs_json TEXT NOT NULL,
                    verified_by TEXT NOT NULL, verified_at INTEGER NOT NULL,
                    operation_receipt_id TEXT, independent_read_receipt_id TEXT,
                    revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
                    PRIMARY KEY (org, workspace, actor, skill_id),
                    UNIQUE (org, workspace, actor, idempotency_key)
                )""",
                """CREATE INDEX IF NOT EXISTS verified_skills_list
                    ON verified_skills (org, workspace, actor, name, revision DESC)""",
                """CREATE TABLE IF NOT EXISTS watches (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    watch_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
                    conversation_id TEXT NOT NULL, conversation_kind TEXT, persona_id TEXT,
                    title TEXT NOT NULL,
                    condition TEXT NOT NULL, source_refs_json TEXT NOT NULL,
                    next_check_at INTEGER, state TEXT NOT NULL, version INTEGER NOT NULL,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY (org, workspace, actor, watch_id),
                    UNIQUE (org, workspace, actor, idempotency_key)
                )""",
                """CREATE TABLE IF NOT EXISTS focus_items (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    focus_item_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
                    conversation_id TEXT NOT NULL, conversation_kind TEXT, persona_id TEXT,
                    kind TEXT NOT NULL,
                    summary TEXT NOT NULL, source_refs_json TEXT NOT NULL,
                    due_at INTEGER, condition TEXT, state TEXT NOT NULL,
                    version INTEGER NOT NULL, created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (org, workspace, actor, focus_item_id),
                    UNIQUE (org, workspace, actor, idempotency_key)
                )""",
                """CREATE TABLE IF NOT EXISTS handoffs (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    handoff_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
                    conversation_id TEXT, conversation_kind TEXT, persona_id TEXT,
                    task_id TEXT NOT NULL, session_id TEXT NOT NULL, summary TEXT NOT NULL,
                    unresolved_items_json TEXT NOT NULL,
                    unknown_operation_refs_json TEXT NOT NULL, source_refs_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (org, workspace, actor, handoff_id),
                    UNIQUE (org, workspace, actor, idempotency_key)
                )""",
                """CREATE TABLE IF NOT EXISTS review_events (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    event_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
                    conversation_id TEXT, conversation_kind TEXT, persona_id TEXT,
                    event_type TEXT NOT NULL, summary TEXT NOT NULL,
                    decision TEXT, source_refs_json TEXT NOT NULL, created_at INTEGER NOT NULL,
                    PRIMARY KEY (org, workspace, actor, event_id),
                    UNIQUE (org, workspace, actor, idempotency_key)
                )""",
                """CREATE TABLE IF NOT EXISTS import_batches (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    batch_id TEXT NOT NULL, source_kind TEXT NOT NULL,
                    state TEXT NOT NULL, record_count INTEGER NOT NULL,
                    accepted_count INTEGER NOT NULL, quarantined_count INTEGER NOT NULL,
                    digest TEXT NOT NULL, version INTEGER NOT NULL,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY (org, workspace, actor, batch_id)
                )""",
                """CREATE TABLE IF NOT EXISTS import_records (
                    org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                    batch_id TEXT NOT NULL, record_id TEXT NOT NULL, kind TEXT NOT NULL,
                    conversation_id TEXT, conversation_kind TEXT, persona_id TEXT,
                    text TEXT NOT NULL, source_refs_json TEXT NOT NULL,
                    visibility TEXT NOT NULL, valid_until INTEGER, state TEXT NOT NULL,
                    PRIMARY KEY (org, workspace, actor, batch_id, record_id),
                    FOREIGN KEY (org, workspace, actor, batch_id)
                        REFERENCES import_batches (org, workspace, actor, batch_id)
                )""",
            )
            for statement in statements:
                connection.execute(statement)
            if version < 2:
                context_columns = {
                    "profile_candidates": ("conversation_kind",),
                    "profiles": ("conversation_kind",),
                    "graph_changesets": ("conversation_kind", "persona_id"),
                    "maintenance_jobs": ("conversation_kind", "persona_id"),
                    "research_notes": ("conversation_kind", "persona_id"),
                    "verified_skills": (
                        "conversation_id",
                        "conversation_kind",
                        "persona_id",
                    ),
                    "watches": ("conversation_kind", "persona_id"),
                    "focus_items": ("conversation_kind", "persona_id"),
                    "handoffs": ("conversation_id", "conversation_kind", "persona_id"),
                    "review_events": ("conversation_kind", "persona_id"),
                    "import_records": ("conversation_kind", "persona_id"),
                }
                for table, columns in context_columns.items():
                    existing = {
                        str(row["name"])
                        for row in connection.execute(f"PRAGMA table_info({table})")
                    }
                    for column in columns:
                        if column not in existing:
                            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} TEXT")
            if version < 3:
                graph_columns = {
                    str(row["name"])
                    for row in connection.execute("PRAGMA table_info(graph_changesets)")
                }
                if "provider_receipt_json" not in graph_columns:
                    connection.execute(
                        "ALTER TABLE graph_changesets ADD COLUMN provider_receipt_json TEXT"
                    )
                # Revoke legacy local projections without provider readback proof.
                connection.execute(
                    "UPDATE graph_changesets SET state='proposed' "
                    "WHERE state='projected' AND provider_receipt_json IS NULL"
                )
            if version < 4:
                migrations = {
                    "profile_candidates": ("source_refs_json", "TEXT NOT NULL DEFAULT '[]'"),
                    "profiles": ("source_refs_json", "TEXT NOT NULL DEFAULT '[]'"),
                    "verified_skills": ("operation_receipt_id", "TEXT"),
                }
                for table, (column, definition) in migrations.items():
                    existing = {
                        str(row["name"])
                        for row in connection.execute(f"PRAGMA table_info({table})")
                    }
                    if column not in existing:
                        connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
                skill_columns = {
                    str(row["name"])
                    for row in connection.execute("PRAGMA table_info(verified_skills)")
                }
                if "independent_read_receipt_id" not in skill_columns:
                    connection.execute(
                        "ALTER TABLE verified_skills ADD COLUMN independent_read_receipt_id TEXT"
                    )
            connection.execute("PRAGMA user_version=4")
            connection.commit()
        except PersistenceError:
            connection.rollback()
            raise
        except sqlite3.Error as exc:
            connection.rollback()
            raise PersistenceError(
                "CONVERSATION_DOMAIN_STORAGE_ERROR", 500, "Domain schema initialization failed"
            ) from exc
        finally:
            connection.close()

    @staticmethod
    def _scope(org: str, workspace: str, actor: str) -> tuple[str, str, str]:
        """Validate and return the mandatory domain isolation keys."""

        return (
            _identifier(org, "org"),
            _identifier(workspace, "workspace"),
            _identifier(actor, "actor"),
        )

    @staticmethod
    def _row_json(row: sqlite3.Row, field: str) -> object:
        """Decode a persisted JSON field and fail closed on corruption."""

        try:
            return json.loads(str(row[field]))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_STORAGE_CORRUPT", 500, "Stored domain JSON is invalid"
            ) from exc

    def list_personas(
        self,
        org: str,
        workspace: str,
        actor: str,
        conversation_id: str | None = None,
    ) -> list[WireView]:
        """List only personas owned by the requested actor and optional conversation."""

        scope = self._scope(org, workspace, actor)
        conversation = _optional_identifier(conversation_id, "conversationId")
        with self._read() as connection:
            rows = connection.execute(
                """SELECT * FROM personas
                   WHERE org=? AND workspace=? AND actor=?
                   ORDER BY name COLLATE NOCASE, persona_id""",
                scope,
            ).fetchall()
        views = [_persona_view(row, self._row_json(row, "conversation_ids_json")) for row in rows]
        if conversation is not None:
            views = [
                view
                for view in views
                if not view["conversationIds"]
                or conversation in cast(list[str], view["conversationIds"])
            ]
        return views

    def put_persona(
        self, org: str, workspace: str, actor: str, body: Mapping[str, object]
    ) -> WireView:
        """Create or update an explicitly configured persona with monotonic versioning."""

        scope = self._scope(org, workspace, actor)
        payload = _body(
            body,
            required={"id", "name", "prompt", "enabled"},
            optional={"description", "conversationIds"},
        )
        persona_id = _identifier(payload["id"], "id")
        name = _text(payload["name"], "name", maximum=160)
        description = _text(
            payload.get("description", ""), "description", maximum=2_000, allow_empty=True
        )
        prompt = _text(payload["prompt"], "prompt", maximum=12_000)
        enabled = _boolean(payload["enabled"], "enabled")
        conversation_ids = _string_list(
            payload.get("conversationIds", []), "conversationIds", maximum=100, identifiers=True
        )
        encoded_conversations = _json_dumps(conversation_ids, "conversationIds")
        now = _now_ms()
        with self._write() as connection:
            previous = connection.execute(
                """SELECT * FROM personas
                   WHERE org=? AND workspace=? AND actor=? AND persona_id=?""",
                (*scope, persona_id),
            ).fetchone()
            if previous is not None:
                old = (
                    str(previous["name"]),
                    str(previous["description"]),
                    str(previous["prompt"]),
                    bool(previous["enabled"]),
                    str(previous["conversation_ids_json"]),
                )
                new = (name, description, prompt, enabled, encoded_conversations)
                if old == new:
                    return _persona_view(
                        previous, self._row_json(previous, "conversation_ids_json")
                    )
                connection.execute(
                    """UPDATE personas SET name=?, description=?, prompt=?, enabled=?,
                           conversation_ids_json=?, version=version+1, updated_at=?
                       WHERE org=? AND workspace=? AND actor=? AND persona_id=?""",
                    (
                        name,
                        description,
                        prompt,
                        int(enabled),
                        encoded_conversations,
                        now,
                        *scope,
                        persona_id,
                    ),
                )
            else:
                connection.execute(
                    """INSERT INTO personas (
                           org, workspace, actor, persona_id, name, description, prompt,
                           enabled, conversation_ids_json, version, created_at, updated_at
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                    (
                        *scope,
                        persona_id,
                        name,
                        description,
                        prompt,
                        int(enabled),
                        encoded_conversations,
                        now,
                        now,
                    ),
                )
            row = connection.execute(
                """SELECT * FROM personas
                   WHERE org=? AND workspace=? AND actor=? AND persona_id=?""",
                (*scope, persona_id),
            ).fetchone()
        assert row is not None
        return _persona_view(row, self._row_json(row, "conversation_ids_json"))

    def get_active_behavior_policy(
        self, org: str, workspace: str, actor: str, conversation_id: str
    ) -> WireView | None:
        """Read an explicitly stored behavior policy, returning None for API defaults."""

        scope = self._scope(org, workspace, actor)
        conversation = _identifier(conversation_id, "conversationId")
        with self._read() as connection:
            row = connection.execute(
                """SELECT * FROM active_behavior_policies
                   WHERE org=? AND workspace=? AND actor=? AND conversation_id=?""",
                (*scope, conversation),
            ).fetchone()
        if row is None:
            return None
        return _behavior_policy_view(row, self._row_json(row, "quiet_hours_json"))

    def put_active_behavior_policy(
        self, org: str, workspace: str, actor: str, body: Mapping[str, object]
    ) -> WireView:
        """Persist explicit policy settings with version CAS and idempotent retries."""

        scope = self._scope(org, workspace, actor)
        payload = _body(
            body,
            required={
                "conversationId",
                "enabled",
                "quietHours",
                "cooldownSeconds",
                "allowGroupInterjections",
                "followupEnabled",
            },
            optional={"expectedVersion"},
        )
        conversation = _identifier(payload["conversationId"], "conversationId")
        enabled = _boolean(payload["enabled"], "enabled")
        quiet_hours = _quiet_hours(payload["quietHours"])
        cooldown = _nonnegative_integer(payload["cooldownSeconds"], "cooldownSeconds")
        if cooldown > 86_400:
            raise _invalid("cooldownSeconds must not exceed 86400")
        allow_group_interjections = _boolean(
            payload["allowGroupInterjections"], "allowGroupInterjections"
        )
        followup_enabled = _boolean(payload["followupEnabled"], "followupEnabled")
        requested_version = (
            None
            if payload.get("expectedVersion") is None
            else _nonnegative_integer(payload["expectedVersion"], "expectedVersion")
        )
        quiet_json = _json_dumps(quiet_hours, "quietHours", maximum=4_096)
        values = (
            int(enabled),
            quiet_json,
            cooldown,
            int(allow_group_interjections),
            int(followup_enabled),
        )
        now = _now_ms()
        with self._write() as connection:
            current = connection.execute(
                """SELECT * FROM active_behavior_policies
                   WHERE org=? AND workspace=? AND actor=? AND conversation_id=?""",
                (*scope, conversation),
            ).fetchone()
            if current is None:
                if requested_version not in {None, 0}:
                    raise _conflict("Behavior policy version changed")
                connection.execute(
                    """INSERT INTO active_behavior_policies (
                           org, workspace, actor, conversation_id, enabled,
                           quiet_hours_json, cooldown_seconds, allow_group_interjections,
                           followup_enabled, version, created_at, updated_at
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                    (*scope, conversation, *values, now, now),
                )
            else:
                stored_values = (
                    int(current["enabled"]),
                    str(current["quiet_hours_json"]),
                    int(current["cooldown_seconds"]),
                    int(current["allow_group_interjections"]),
                    int(current["followup_enabled"]),
                )
                current_version = int(current["version"])
                if stored_values == values:
                    return _behavior_policy_view(
                        current, self._row_json(current, "quiet_hours_json")
                    )
                if requested_version is None or requested_version != current_version:
                    raise _conflict("Behavior policy version changed")
                connection.execute(
                    """UPDATE active_behavior_policies SET enabled=?, quiet_hours_json=?,
                           cooldown_seconds=?, allow_group_interjections=?, followup_enabled=?,
                           version=version+1, updated_at=?
                       WHERE org=? AND workspace=? AND actor=? AND conversation_id=?
                         AND version=?""",
                    (*values, now, *scope, conversation, current_version),
                )
            row = connection.execute(
                """SELECT * FROM active_behavior_policies
                   WHERE org=? AND workspace=? AND actor=? AND conversation_id=?""",
                (*scope, conversation),
            ).fetchone()
        assert row is not None
        return _behavior_policy_view(row, self._row_json(row, "quiet_hours_json"))

    def create_profile_candidate(
        self, org: str, workspace: str, actor: str, body: Mapping[str, object]
    ) -> WireView:
        """Persist a sourced profile proposal without treating it as active memory."""

        scope = self._scope(org, workspace, actor)
        payload = _body(
            body,
            required={
                "idempotencyKey",
                "conversationId",
                "conversationKind",
                "subjectKind",
                "category",
                "text",
                "confidence",
            },
            optional={"personaId", "validUntil", "sourceMessageIds", "sourceRefs"},
        )
        key = _idempotency_key(payload["idempotencyKey"])
        conversation_id = _identifier(payload["conversationId"], "conversationId")
        conversation_kind = _choice(
            payload["conversationKind"], "conversationKind", {"direct", "group", "channel"}
        )
        subject_kind = _choice(payload["subjectKind"], "subjectKind", {"user", "group"})
        category = _choice(
            payload["category"],
            "category",
            {"preference", "style", "constraint", "temporary_state"},
        )
        text = _text(payload["text"], "text", maximum=8_000)
        source_ids = _source_message_ids(payload.get("sourceMessageIds", []), allow_empty=True)
        refs = _source_refs(payload.get("sourceRefs", []), allow_empty=True)
        refs = _merge_source_refs(refs, source_ids)
        if not refs:
            raise _invalid("A profile candidate requires sourceRefs or sourceMessageIds")
        sources = _source_ids_from_refs(refs)
        confidence = _confidence(payload["confidence"])
        persona_id = _optional_identifier(payload.get("personaId"), "personaId")
        valid_until = _optional_timestamp(payload.get("validUntil"), "validUntil")
        evidence = {
            "sourceMessageIds": sources,
            "sourceRefs": refs,
            "confidence": confidence,
        }
        evidence_json = _json_dumps(evidence, "evidence")
        digest = _digest(
            {
                "conversationId": conversation_id,
                "conversationKind": conversation_kind,
                "subjectKind": subject_kind,
                "personaId": persona_id,
                "category": category,
                "text": text,
                "sourceMessageIds": sources,
                "sourceRefs": refs,
                "confidence": confidence,
                "validUntil": valid_until,
            }
        )
        now = _now_ms()
        with self._write() as connection:
            existing = connection.execute(
                """SELECT * FROM profile_candidates
                   WHERE org=? AND workspace=? AND actor=? AND idempotency_key=?""",
                (*scope, key),
            ).fetchone()
            if existing is not None:
                if (
                    str(existing["evidence_json"]) != evidence_json
                    or _candidate_digest(existing) != digest
                ):
                    raise _conflict(
                        "Profile candidate idempotency key was reused with different data"
                    )
                return _candidate_view(existing, self._row_json(existing, "evidence_json"))
            candidate_id = _new_id()
            connection.execute(
                """INSERT INTO profile_candidates (
                       org, workspace, actor, candidate_id, idempotency_key, conversation_id,
                       conversation_kind, subject_kind, persona_id, category, text,
                       source_message_ids_json, source_refs_json,
                       confidence, valid_until, state, version, evidence_json, profile_id,
                       created_at, updated_at
                   ) VALUES (
                       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 1, ?, NULL, ?, ?
                   )""",
                (
                    *scope,
                    candidate_id,
                    key,
                    conversation_id,
                    conversation_kind,
                    subject_kind,
                    persona_id,
                    category,
                    text,
                    _json_dumps(sources, "sourceMessageIds"),
                    _json_dumps(refs, "sourceRefs"),
                    confidence,
                    valid_until,
                    evidence_json,
                    now,
                    now,
                ),
            )
            row = connection.execute(
                """SELECT * FROM profile_candidates
                   WHERE org=? AND workspace=? AND actor=? AND candidate_id=?""",
                (*scope, candidate_id),
            ).fetchone()
        assert row is not None
        return _candidate_view(row, self._row_json(row, "evidence_json"))

    def list_profile_candidates(
        self,
        org: str,
        workspace: str,
        actor: str,
        state: str | None = None,
        limit: int = 100,
    ) -> list[WireView]:
        """List bounded profile candidate pages within the caller's scope."""

        scope = self._scope(org, workspace, actor)
        selected_state = _optional_choice(
            state, "state", {"candidate", "active", "rolled_back", "expired"}
        )
        page_limit = _list_limit(limit)
        sql = "SELECT * FROM profile_candidates WHERE org=? AND workspace=? AND actor=?"
        params: tuple[object, ...] = scope
        if selected_state is not None:
            sql += " AND state=?"
            params += (selected_state,)
        sql += " ORDER BY created_at DESC, candidate_id LIMIT ?"
        params += (page_limit,)
        with self._read() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [_candidate_view(row, self._row_json(row, "evidence_json")) for row in rows]

    def get_profile_candidate(
        self, org: str, workspace: str, actor: str, candidate_id: str
    ) -> WireView:
        """Read one candidate in actor scope for source reauthorization before activation."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(candidate_id, "candidateId")
        with self._read() as connection:
            row = connection.execute(
                """SELECT * FROM profile_candidates
                   WHERE org=? AND workspace=? AND actor=? AND candidate_id=?""",
                (*scope, identifier),
            ).fetchone()
        if row is None:
            raise _not_found("Profile candidate was not found")
        return _candidate_view(row, self._row_json(row, "evidence_json"))

    def activate_profile_candidate(
        self,
        org: str,
        workspace: str,
        actor: str,
        candidate_id: str,
        expected_version: int,
    ) -> WireView:
        """Activate a candidate once, superseding the previous matching profile."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(candidate_id, "candidateId")
        expected = _version(expected_version, "expectedVersion")
        now = _now_ms()
        with self._write() as connection:
            candidate = connection.execute(
                """SELECT * FROM profile_candidates
                   WHERE org=? AND workspace=? AND actor=? AND candidate_id=?""",
                (*scope, identifier),
            ).fetchone()
            if candidate is None:
                raise _not_found("Profile candidate was not found")
            if candidate["state"] == "active" and int(candidate["version"]) == expected + 1:
                profile = connection.execute(
                    """SELECT * FROM profiles
                       WHERE org=? AND workspace=? AND actor=? AND profile_id=?""",
                    (*scope, candidate["profile_id"]),
                ).fetchone()
                if profile is not None:
                    return _profile_view(profile, self._row_json(profile, "evidence_json"))
            if candidate["state"] != "candidate" or int(candidate["version"]) != expected:
                raise _conflict("Profile candidate state or version changed")
            valid_until = candidate["valid_until"]
            if valid_until is not None and int(valid_until) <= now:
                raise _conflict("Expired profile candidates cannot be activated")
            previous = connection.execute(
                """SELECT * FROM profiles
                   WHERE org=? AND workspace=? AND actor=? AND conversation_id=?
                     AND conversation_kind=? AND subject_kind=? AND category=?
                     AND persona_id IS ? AND state='active'
                   ORDER BY created_at DESC LIMIT 1""",
                (
                    *scope,
                    candidate["conversation_id"],
                    candidate["conversation_kind"],
                    candidate["subject_kind"],
                    candidate["category"],
                    candidate["persona_id"],
                ),
            ).fetchone()
            previous_id = str(previous["profile_id"]) if previous is not None else None
            if previous is not None:
                connection.execute(
                    """UPDATE profiles SET state='superseded', version=version+1, updated_at=?
                       WHERE org=? AND workspace=? AND actor=? AND profile_id=?
                         AND state='active'""",
                    (now, *scope, previous_id),
                )
            profile_id = _new_id()
            connection.execute(
                """INSERT INTO profiles (
                       org, workspace, actor, profile_id, candidate_id, conversation_id,
                       conversation_kind, subject_kind, persona_id, category, text,
                       source_message_ids_json, source_refs_json,
                       evidence_json, valid_until, state, version, previous_profile_id,
                       created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)""",
                (
                    *scope,
                    profile_id,
                    candidate["candidate_id"],
                    candidate["conversation_id"],
                    candidate["conversation_kind"],
                    candidate["subject_kind"],
                    candidate["persona_id"],
                    candidate["category"],
                    candidate["text"],
                    candidate["source_message_ids_json"],
                    candidate["source_refs_json"],
                    candidate["evidence_json"],
                    valid_until,
                    previous_id,
                    now,
                    now,
                ),
            )
            connection.execute(
                """UPDATE profile_candidates SET state='active', profile_id=?,
                       version=version+1, updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND candidate_id=? AND version=?""",
                (profile_id, now, *scope, identifier, expected),
            )
            row = connection.execute(
                """SELECT * FROM profiles
                   WHERE org=? AND workspace=? AND actor=? AND profile_id=?""",
                (*scope, profile_id),
            ).fetchone()
        assert row is not None
        return _profile_view(row, self._row_json(row, "evidence_json"))

    def rollback_profile(
        self,
        org: str,
        workspace: str,
        actor: str,
        profile_id: str,
        expected_version: int,
    ) -> WireView:
        """Roll back one active profile and restore its prior superseded version."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(profile_id, "profileId")
        expected = _version(expected_version, "expectedVersion")
        now = _now_ms()
        with self._write() as connection:
            profile = connection.execute(
                """SELECT * FROM profiles
                   WHERE org=? AND workspace=? AND actor=? AND profile_id=?""",
                (*scope, identifier),
            ).fetchone()
            if profile is None:
                raise _not_found("Profile was not found")
            if profile["state"] == "rolled_back" and int(profile["version"]) == expected + 1:
                return _profile_view(profile, self._row_json(profile, "evidence_json"))
            if profile["state"] != "active" or int(profile["version"]) != expected:
                raise _conflict("Profile state or version changed")
            connection.execute(
                """UPDATE profiles SET state='rolled_back', version=version+1, updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND profile_id=? AND version=?""",
                (now, *scope, identifier, expected),
            )
            previous_id = profile["previous_profile_id"]
            if previous_id is not None:
                previous = connection.execute(
                    """SELECT valid_until FROM profiles
                       WHERE org=? AND workspace=? AND actor=? AND profile_id=?
                         AND state='superseded'""",
                    (*scope, previous_id),
                ).fetchone()
                if previous is not None:
                    restored_state = (
                        "expired"
                        if previous["valid_until"] is not None
                        and int(previous["valid_until"]) <= now
                        else "active"
                    )
                    connection.execute(
                        """UPDATE profiles SET state=?, version=version+1, updated_at=?
                           WHERE org=? AND workspace=? AND actor=? AND profile_id=?
                             AND state='superseded'""",
                        (restored_state, now, *scope, previous_id),
                    )
            connection.execute(
                """UPDATE profile_candidates
                   SET state='rolled_back', version=version+1, updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND candidate_id=?
                     AND state='active'""",
                (now, *scope, profile["candidate_id"]),
            )
            updated = connection.execute(
                """SELECT * FROM profiles
                   WHERE org=? AND workspace=? AND actor=? AND profile_id=?""",
                (*scope, identifier),
            ).fetchone()
        assert updated is not None
        return _profile_view(updated, self._row_json(updated, "evidence_json"))

    def list_profiles(
        self,
        org: str,
        workspace: str,
        actor: str,
        conversation_id: str | None = None,
        state: str = "active",
        limit: int = 100,
    ) -> list[WireView]:
        """List a bounded page of actor-owned profile projections by lifecycle state."""

        scope = self._scope(org, workspace, actor)
        conversation = _optional_identifier(conversation_id, "conversationId")
        selected_state = _choice(state, "state", {"active", "superseded", "rolled_back"})
        page_limit = _list_limit(limit)
        sql = "SELECT * FROM profiles WHERE org=? AND workspace=? AND actor=? AND state=?"
        params: tuple[object, ...] = (*scope, selected_state)
        if conversation is not None:
            sql += " AND conversation_id=?"
            params += (conversation,)
        sql += " ORDER BY created_at DESC, profile_id LIMIT ?"
        params += (page_limit,)
        with self._read() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [_profile_view(row, self._row_json(row, "evidence_json")) for row in rows]

    def get_profile(self, org: str, workspace: str, actor: str, profile_id: str) -> WireView:
        """Read one profile revision in actor scope for source reauthorization."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(profile_id, "profileId")
        with self._read() as connection:
            row = connection.execute(
                """SELECT * FROM profiles
                   WHERE org=? AND workspace=? AND actor=? AND profile_id=?""",
                (*scope, identifier),
            ).fetchone()
        if row is None:
            raise _not_found("Profile was not found")
        return _profile_view(row, self._row_json(row, "evidence_json"))

    def upsert_graph_entities(
        self, org: str, workspace: str, actor: str, body: Mapping[str, object]
    ) -> WireView:
        """Persist sourced graph proposals without invoking an external graph provider."""

        scope = self._scope(org, workspace, actor)
        payload = _body(
            body,
            required={"idempotencyKey", "conversationId", "conversationKind", "nodes", "edges"},
            optional={"personaId"},
        )
        key = _idempotency_key(payload["idempotencyKey"])
        conversation_id = _identifier(payload["conversationId"], "conversationId")
        conversation_kind = _choice(
            payload["conversationKind"], "conversationKind", {"direct", "group", "channel"}
        )
        persona_id = _optional_identifier(payload.get("personaId"), "personaId")
        nodes = _graph_nodes(payload["nodes"])
        edges = _graph_edges(payload["edges"])
        if not nodes and not edges:
            raise _invalid("A graph changeset must contain at least one node or edge")
        normalized = {"nodes": nodes, "edges": edges}
        encoded = _json_dumps(normalized, "graphChangeset", maximum=128 * 1024)
        digest = _digest(
            {
                "conversationId": conversation_id,
                "conversationKind": conversation_kind,
                "personaId": persona_id,
                **normalized,
            }
        )
        now = _now_ms()
        with self._write() as connection:
            existing = connection.execute(
                """SELECT * FROM graph_changesets
                   WHERE org=? AND workspace=? AND actor=? AND idempotency_key=?""",
                (*scope, key),
            ).fetchone()
            if existing is not None:
                if (
                    str(existing["digest"]) != digest
                    or str(existing["conversation_id"]) != conversation_id
                ):
                    raise _conflict(
                        "Graph changeset idempotency key was reused with different data"
                    )
                return _graph_view(existing)
            changeset_id = _new_id()
            connection.execute(
                """INSERT INTO graph_changesets (
                       org, workspace, actor, changeset_id, idempotency_key,
                       conversation_id, conversation_kind, persona_id, payload_json,
                       digest, node_count, edge_count,
                       state, version, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 1, ?, ?)""",
                (
                    *scope,
                    changeset_id,
                    key,
                    conversation_id,
                    conversation_kind,
                    persona_id,
                    encoded,
                    digest,
                    len(nodes),
                    len(edges),
                    now,
                    now,
                ),
            )
            row = connection.execute(
                """SELECT * FROM graph_changesets
                   WHERE org=? AND workspace=? AND actor=? AND changeset_id=?""",
                (*scope, changeset_id),
            ).fetchone()
        assert row is not None
        return _graph_view(row)

    def query_graph(
        self, org: str, workspace: str, actor: str, body: Mapping[str, object]
    ) -> WireView:
        """Fail with a typed provider error while no graph query provider is configured."""

        self._scope(org, workspace, actor)
        if not isinstance(body, Mapping):
            raise _invalid("query body must be an object")
        _ensure_safe_tree(body, "query")
        if _serialized_size(body, "query") > _MAX_BODY_BYTES:
            raise _invalid("query body exceeds the supported size")
        raise PersistenceError(
            "GRAPH_PROVIDER_UNAVAILABLE", 503, "Graph query provider is unavailable", retryable=True
        )

    def list_graph_changesets(
        self,
        org: str,
        workspace: str,
        actor: str,
        state: str | None = None,
        limit: int = 100,
    ) -> list[WireView]:
        """List durable graph proposals and local projections in a bounded page."""

        scope = self._scope(org, workspace, actor)
        selected_state = _optional_choice(state, "state", {"proposed", "projected"})
        page_limit = _list_limit(limit)
        sql = "SELECT * FROM graph_changesets WHERE org=? AND workspace=? AND actor=?"
        params: tuple[object, ...] = scope
        if selected_state is not None:
            sql += " AND state=?"
            params += (selected_state,)
        sql += " ORDER BY created_at DESC, changeset_id LIMIT ?"
        params += (page_limit,)
        with self._read() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [_graph_view(row) for row in rows]

    def get_graph_changeset(
        self, org: str, workspace: str, actor: str, changeset_id: str
    ) -> WireView:
        """Read one graph changeset in actor scope before local projection."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(changeset_id, "changesetId")
        with self._read() as connection:
            row = connection.execute(
                """SELECT * FROM graph_changesets
                   WHERE org=? AND workspace=? AND actor=? AND changeset_id=?""",
                (*scope, identifier),
            ).fetchone()
        if row is None:
            raise _not_found("Graph changeset was not found")
        return _graph_view(row)

    def apply_graph_changeset(
        self,
        org: str,
        workspace: str,
        actor: str,
        changeset_id: str,
        expected_version: int,
        provider_receipt: Mapping[str, object] | None = None,
    ) -> WireView:
        """Persist an independently verified provider receipt with a version CAS."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(changeset_id, "changesetId")
        expected = _version(expected_version, "expectedVersion")
        if provider_receipt is None:
            raise PersistenceError(
                "GRAPH_PROVIDER_UNAVAILABLE",
                503,
                "Graph apply requires a provider readback receipt.",
                retryable=True,
            )
        receipt = _body(
            provider_receipt,
            required={"requestDigest", "readbackDigest", "nodeCount", "edgeCount", "appliedAt"},
            optional=set(),
        )
        request_digest = _digest_text(receipt["requestDigest"], "providerReceipt.requestDigest")
        readback_digest = _digest_text(receipt["readbackDigest"], "providerReceipt.readbackDigest")
        node_count = _nonnegative_integer(receipt["nodeCount"], "providerReceipt.nodeCount")
        edge_count = _nonnegative_integer(receipt["edgeCount"], "providerReceipt.edgeCount")
        applied_at = _nonnegative_integer(receipt["appliedAt"], "providerReceipt.appliedAt")
        with self._write() as connection:
            row = connection.execute(
                """SELECT * FROM graph_changesets
                   WHERE org=? AND workspace=? AND actor=? AND changeset_id=?""",
                (*scope, identifier),
            ).fetchone()
            if row is None:
                raise _not_found("Graph changeset was not found")
            if (
                request_digest != str(row["digest"])
                or readback_digest != str(row["digest"])
                or node_count != int(row["node_count"])
                or edge_count != int(row["edge_count"])
            ):
                raise _conflict("Graph provider receipt does not match the proposed changeset")
            normalized_receipt = {
                "requestDigest": request_digest,
                "readbackDigest": readback_digest,
                "nodeCount": node_count,
                "edgeCount": edge_count,
                "appliedAt": applied_at,
            }
            receipt_json = _json_dumps(normalized_receipt, "providerReceipt", maximum=4_096)
            if (
                row["state"] == "projected"
                and int(row["version"]) == expected + 1
                and str(row["provider_receipt_json"] or "") == receipt_json
            ):
                return _graph_view(row)
            if row["state"] != "proposed" or int(row["version"]) != expected:
                raise _conflict("Graph changeset state or version changed")
            now = _now_ms()
            connection.execute(
                """UPDATE graph_changesets SET state='projected', provider_receipt_json=?,
                       version=version+1, updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND changeset_id=? AND version=?""",
                (receipt_json, now, *scope, identifier, expected),
            )
            updated = connection.execute(
                """SELECT * FROM graph_changesets
                   WHERE org=? AND workspace=? AND actor=? AND changeset_id=?""",
                (*scope, identifier),
            ).fetchone()
        assert updated is not None
        return _graph_view(updated)

    def create_maintenance_job(
        self, org: str, workspace: str, actor: str, body: Mapping[str, object]
    ) -> WireView:
        """Create an idempotent bounded maintenance job record."""

        scope = self._scope(org, workspace, actor)
        payload = _body(
            body,
            required={"idempotencyKey", "kind"},
            optional={"conversationId", "conversationKind", "personaId", "cursor"},
        )
        key = _idempotency_key(payload["idempotencyKey"])
        kind = _choice(
            payload["kind"], "kind", {"dream", "forget", "daily_review", "backup", "import"}
        )
        conversation_id, conversation_kind, persona_id = _source_context(payload)
        cursor = _optional_text(payload.get("cursor"), "cursor", maximum=1_024)
        request_digest = _digest(
            {
                "kind": kind,
                "conversationId": conversation_id,
                "conversationKind": conversation_kind,
                "personaId": persona_id,
                "cursor": cursor,
            }
        )
        now = _now_ms()
        with self._write() as connection:
            existing = connection.execute(
                """SELECT * FROM maintenance_jobs
                   WHERE org=? AND workspace=? AND actor=? AND idempotency_key=?""",
                (*scope, key),
            ).fetchone()
            if existing is not None:
                if _job_creation_digest(existing) != request_digest:
                    raise _conflict(
                        "Maintenance job idempotency key was reused with different data"
                    )
                return _maintenance_view(existing, self._row_json(existing, "details_json"))
            job_id = _new_id()
            connection.execute(
                """INSERT INTO maintenance_jobs (
                   org, workspace, actor, job_id, idempotency_key, kind, request_digest,
                       conversation_id, conversation_kind, persona_id, state, cursor,
                       processed_count, checkpoint_digest,
                       details_json, checkpoint_json, version, created_at, updated_at
                   ) VALUES (
                       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, NULL, '{}', NULL, 1, ?, ?
                   )""",
                (
                    *scope,
                    job_id,
                    key,
                    kind,
                    request_digest,
                    conversation_id,
                    conversation_kind,
                    persona_id,
                    cursor,
                    now,
                    now,
                ),
            )
            row = connection.execute(
                """SELECT * FROM maintenance_jobs
                   WHERE org=? AND workspace=? AND actor=? AND job_id=?""",
                (*scope, job_id),
            ).fetchone()
        assert row is not None
        return _maintenance_view(row, self._row_json(row, "details_json"))

    def get_maintenance_job(self, org: str, workspace: str, actor: str, job_id: str) -> WireView:
        """Read one maintenance job by full actor scope and identifier."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(job_id, "jobId")
        with self._read() as connection:
            row = connection.execute(
                """SELECT * FROM maintenance_jobs
                   WHERE org=? AND workspace=? AND actor=? AND job_id=?""",
                (*scope, identifier),
            ).fetchone()
        if row is None:
            raise _not_found("Maintenance job was not found")
        return _maintenance_view(row, self._row_json(row, "details_json"))

    def cancel_maintenance_job(
        self,
        org: str,
        workspace: str,
        actor: str,
        job_id: str,
        expected_version: int,
        *,
        task_cancellation_verified: bool = False,
    ) -> WireView:
        """Cancel a queued or running job after any existing Task was aborted."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(job_id, "jobId")
        expected = _version(expected_version, "expectedVersion")
        if not isinstance(task_cancellation_verified, bool):
            raise _invalid("task_cancellation_verified must be a boolean")
        with self._write() as connection:
            row = connection.execute(
                """SELECT * FROM maintenance_jobs
                   WHERE org=? AND workspace=? AND actor=? AND job_id=?""",
                (*scope, identifier),
            ).fetchone()
            if row is None:
                raise _not_found("Maintenance job was not found")
            if row["state"] == "cancelled" and int(row["version"]) == expected + 1:
                return _maintenance_view(row, self._row_json(row, "details_json"))
            if row["state"] not in {"queued", "running"} or int(row["version"]) != expected:
                raise _conflict("Maintenance job state or version changed")
            if row["state"] == "running" and not task_cancellation_verified:
                raise _conflict("Running jobs require a verified aborted Work Task")
            now = _now_ms()
            connection.execute(
                """UPDATE maintenance_jobs SET state='cancelled', version=version+1,
                       updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND job_id=? AND version=?""",
                (now, *scope, identifier, expected),
            )
            updated = connection.execute(
                """SELECT * FROM maintenance_jobs
                   WHERE org=? AND workspace=? AND actor=? AND job_id=?""",
                (*scope, identifier),
            ).fetchone()
        assert updated is not None
        return _maintenance_view(updated, self._row_json(updated, "details_json"))

    def checkpoint_maintenance_job(
        self,
        org: str,
        workspace: str,
        actor: str,
        job_id: str,
        expected_version: int,
        checkpoint: Mapping[str, object],
        *,
        terminal_receipt_validated: bool = False,
    ) -> WireView:
        """Persist one page checkpoint and enforce job state/version transitions.

        Terminal checkpoints require the API facade to pass a validated Work Task
        receipt after reading the actor-private TaskStore. The flag is an internal
        call contract and cannot be supplied through the HTTP request body.
        """

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(job_id, "jobId")
        expected = _version(expected_version, "expectedVersion")
        payload = _body(
            checkpoint,
            required={"cursor", "processedCount", "checkpointDigest"},
            optional={"details"},
        )
        cursor = _optional_text(payload["cursor"], "cursor", maximum=1_024)
        processed = _nonnegative_integer(payload["processedCount"], "processedCount")
        checkpoint_digest = _digest_text(payload["checkpointDigest"], "checkpointDigest")
        details = payload.get("details", {})
        if not isinstance(details, Mapping):
            raise _invalid("details must be an object")
        _ensure_safe_tree(details, "details")
        details_json = _json_dumps(dict(details), "details", maximum=8_192)
        requested_state = (
            _optional_choice(details.get("state"), "details.state", _MAINTENANCE_CHECKPOINT_STATES)
            or "running"
        )
        if not isinstance(terminal_receipt_validated, bool):
            raise _invalid("terminal_receipt_validated must be a boolean")
        if requested_state == "running":
            if "taskId" in details or "taskOutputSha256" in details:
                raise _invalid("running checkpoints cannot include terminal task receipts")
        else:
            if not terminal_receipt_validated:
                raise _conflict("Terminal checkpoints require a verified Work Task receipt")
            _identifier(details.get("taskId"), "details.taskId")
            _digest_text(details.get("taskOutputSha256"), "details.taskOutputSha256")
        checkpoint_value = {
            "cursor": cursor,
            "processedCount": processed,
            "checkpointDigest": checkpoint_digest,
            "details": dict(details),
            "state": requested_state,
        }
        checkpoint_json = _json_dumps(checkpoint_value, "checkpoint", maximum=16_384)
        now = _now_ms()
        with self._write() as connection:
            row = connection.execute(
                """SELECT * FROM maintenance_jobs
                   WHERE org=? AND workspace=? AND actor=? AND job_id=?""",
                (*scope, identifier),
            ).fetchone()
            if row is None:
                raise _not_found("Maintenance job was not found")
            current_version = int(row["version"])
            if str(row["checkpoint_json"] or "") == checkpoint_json and current_version in {
                expected,
                expected + 1,
            }:
                return _maintenance_view(row, self._row_json(row, "details_json"))
            if current_version != expected:
                raise _conflict("Maintenance job version changed")
            current_state = str(row["state"])
            if current_state in {"completed", "failed", "cancelled"}:
                raise _conflict("Terminal maintenance jobs cannot accept another checkpoint")
            if requested_state == "queued":
                raise _invalid("Maintenance checkpoints cannot return a job to queued")
            if processed < int(row["processed_count"]):
                raise _invalid("processedCount cannot move backwards")
            connection.execute(
                """UPDATE maintenance_jobs SET state=?, cursor=?, processed_count=?,
                       checkpoint_digest=?, details_json=?, checkpoint_json=?,
                       version=version+1, updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND job_id=? AND version=?""",
                (
                    requested_state,
                    cursor,
                    processed,
                    checkpoint_digest,
                    details_json,
                    checkpoint_json,
                    now,
                    *scope,
                    identifier,
                    expected,
                ),
            )
            updated = connection.execute(
                """SELECT * FROM maintenance_jobs
                   WHERE org=? AND workspace=? AND actor=? AND job_id=?""",
                (*scope, identifier),
            ).fetchone()
        assert updated is not None
        return _maintenance_view(updated, self._row_json(updated, "details_json"))

    def create_research_note(
        self, org: str, workspace: str, actor: str, body: Mapping[str, object]
    ) -> WireView:
        """Persist a sourced research note and allocate a revision per conversation/title."""

        scope = self._scope(org, workspace, actor)
        payload = _body(
            body,
            required={
                "idempotencyKey",
                "conversationId",
                "conversationKind",
                "title",
                "content",
                "sourceRefs",
            },
            optional={"personaId"},
        )
        key = _idempotency_key(payload["idempotencyKey"])
        conversation_id, conversation_kind, persona_id = _source_context(payload)
        title = _text(payload["title"], "title", maximum=240)
        content = _text(payload["content"], "content", maximum=_MAX_TEXT)
        sources = _source_refs(payload["sourceRefs"])
        digest = _digest(
            {
                "conversationId": conversation_id,
                "conversationKind": conversation_kind,
                "personaId": persona_id,
                "title": title,
                "content": content,
                "sourceRefs": sources,
            }
        )
        now = _now_ms()
        with self._write() as connection:
            existing = connection.execute(
                """SELECT * FROM research_notes
                   WHERE org=? AND workspace=? AND actor=? AND idempotency_key=?""",
                (*scope, key),
            ).fetchone()
            if existing is not None:
                if _research_note_digest(existing) != digest:
                    raise _conflict("Research note idempotency key was reused with different data")
                return _research_note_view(existing, self._row_json(existing, "source_refs_json"))
            revision_row = connection.execute(
                """SELECT MAX(revision) AS revision FROM research_notes
                   WHERE org=? AND workspace=? AND actor=? AND conversation_id=? AND title=?""",
                (*scope, conversation_id, title),
            ).fetchone()
            revision = int(revision_row["revision"] or 0) + 1
            note_id = _new_id()
            connection.execute(
                """INSERT INTO research_notes (
                   org, workspace, actor, note_id, idempotency_key, conversation_id,
                       conversation_kind, persona_id, title, content, source_refs_json,
                       revision, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    *scope,
                    note_id,
                    key,
                    conversation_id,
                    conversation_kind,
                    persona_id,
                    title,
                    content,
                    _json_dumps(sources, "sourceRefs"),
                    revision,
                    now,
                ),
            )
            row = connection.execute(
                """SELECT * FROM research_notes
                   WHERE org=? AND workspace=? AND actor=? AND note_id=?""",
                (*scope, note_id),
            ).fetchone()
        assert row is not None
        return _research_note_view(row, self._row_json(row, "source_refs_json"))

    def list_research_notes(
        self,
        org: str,
        workspace: str,
        actor: str,
        conversation_id: str | None = None,
        limit: int = 100,
    ) -> list[WireView]:
        """Return a bounded page of actor-owned research notes."""

        scope = self._scope(org, workspace, actor)
        conversation = _optional_identifier(conversation_id, "conversationId")
        page_limit = _list_limit(limit)
        sql = "SELECT * FROM research_notes WHERE org=? AND workspace=? AND actor=?"
        params: tuple[object, ...] = scope
        if conversation is not None:
            sql += " AND conversation_id=?"
            params += (conversation,)
        sql += " ORDER BY created_at DESC, note_id LIMIT ?"
        params += (page_limit,)
        with self._read() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [_research_note_view(row, self._row_json(row, "source_refs_json")) for row in rows]

    def create_verified_skill(
        self, org: str, workspace: str, actor: str, body: Mapping[str, object]
    ) -> WireView:
        """Create a verified skill with verifier identity and time supplied by the server."""

        scope = self._scope(org, workspace, actor)
        payload = _body(
            body,
            required={
                "idempotencyKey",
                "name",
                "content",
                "sourceRefs",
                "operationReceiptId",
                "independentReadReceiptId",
            },
            optional={"conversationId", "conversationKind", "personaId"},
        )
        key = _idempotency_key(payload["idempotencyKey"])
        conversation_id, conversation_kind, persona_id = _source_context(payload)
        name = _text(payload["name"], "name", maximum=200)
        content = _text(payload["content"], "content", maximum=_MAX_TEXT)
        sources = _source_refs(payload["sourceRefs"])
        operation_receipt_id = _identifier(payload["operationReceiptId"], "operationReceiptId")
        read_receipt_id = _identifier(
            payload["independentReadReceiptId"], "independentReadReceiptId"
        )
        digest = _digest(
            {
                "conversationId": conversation_id,
                "conversationKind": conversation_kind,
                "personaId": persona_id,
                "name": name,
                "content": content,
                "sourceRefs": sources,
                "operationReceiptId": operation_receipt_id,
                "independentReadReceiptId": read_receipt_id,
            }
        )
        now = _now_ms()
        with self._write() as connection:
            existing = connection.execute(
                """SELECT * FROM verified_skills
                   WHERE org=? AND workspace=? AND actor=? AND idempotency_key=?""",
                (*scope, key),
            ).fetchone()
            if existing is not None:
                if _skill_digest(existing) != digest:
                    raise _conflict("Skill idempotency key was reused with different data")
                return _skill_view(existing, self._row_json(existing, "source_refs_json"))
            revision_row = connection.execute(
                """SELECT MAX(revision) AS revision FROM verified_skills
                   WHERE org=? AND workspace=? AND actor=? AND name=?""",
                (*scope, name),
            ).fetchone()
            revision = int(revision_row["revision"] or 0) + 1
            skill_id = _new_id()
            connection.execute(
                """INSERT INTO verified_skills (
                       org, workspace, actor, skill_id, idempotency_key, name,
                       conversation_id, conversation_kind, persona_id, content,
                       source_refs_json, verified_by, verified_at, operation_receipt_id,
                       independent_read_receipt_id, revision, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    *scope,
                    skill_id,
                    key,
                    name,
                    conversation_id,
                    conversation_kind,
                    persona_id,
                    content,
                    _json_dumps(sources, "sourceRefs"),
                    actor,
                    now,
                    operation_receipt_id,
                    read_receipt_id,
                    revision,
                    now,
                ),
            )
            row = connection.execute(
                """SELECT * FROM verified_skills
                   WHERE org=? AND workspace=? AND actor=? AND skill_id=?""",
                (*scope, skill_id),
            ).fetchone()
        assert row is not None
        return _skill_view(row, self._row_json(row, "source_refs_json"))

    def list_verified_skills(
        self, org: str, workspace: str, actor: str, limit: int = 100
    ) -> list[WireView]:
        """List verified skills, newest revision first, within the actor's scope."""

        scope = self._scope(org, workspace, actor)
        page_limit = _list_limit(limit)
        with self._read() as connection:
            rows = connection.execute(
                """SELECT * FROM verified_skills
                   WHERE org=? AND workspace=? AND actor=?
                     AND operation_receipt_id IS NOT NULL
                     AND independent_read_receipt_id IS NOT NULL
                   ORDER BY created_at DESC, skill_id LIMIT ?""",
                (*scope, page_limit),
            ).fetchall()
        return [_skill_view(row, self._row_json(row, "source_refs_json")) for row in rows]

    def create_watch(
        self, org: str, workspace: str, actor: str, body: Mapping[str, object]
    ) -> WireView:
        """Create an actor-owned watch with source references and an explicit active state."""

        scope = self._scope(org, workspace, actor)
        payload = _body(
            body,
            required={
                "idempotencyKey",
                "conversationId",
                "conversationKind",
                "title",
                "condition",
                "sourceRefs",
            },
            optional={"nextCheckAt", "personaId"},
        )
        key = _idempotency_key(payload["idempotencyKey"])
        conversation_id, conversation_kind, persona_id = _source_context(payload)
        title = _text(payload["title"], "title", maximum=240)
        condition = _text(payload["condition"], "condition", maximum=2_000)
        sources = _source_refs(payload["sourceRefs"])
        next_check = _optional_timestamp(payload.get("nextCheckAt"), "nextCheckAt")
        digest = _digest(
            {
                "conversationId": conversation_id,
                "conversationKind": conversation_kind,
                "personaId": persona_id,
                "title": title,
                "condition": condition,
                "sourceRefs": sources,
                "nextCheckAt": next_check,
            }
        )
        now = _now_ms()
        with self._write() as connection:
            existing = connection.execute(
                """SELECT * FROM watches
                   WHERE org=? AND workspace=? AND actor=? AND idempotency_key=?""",
                (*scope, key),
            ).fetchone()
            if existing is not None:
                if _watch_digest(existing) != digest:
                    raise _conflict("Watch idempotency key was reused with different data")
                return _watch_view(existing, self._row_json(existing, "source_refs_json"))
            watch_id = _new_id()
            connection.execute(
                """INSERT INTO watches (
                       org, workspace, actor, watch_id, idempotency_key, conversation_id,
                       conversation_kind, persona_id, title, condition, source_refs_json,
                       next_check_at, state, version,
                       created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)""",
                (
                    *scope,
                    watch_id,
                    key,
                    conversation_id,
                    conversation_kind,
                    persona_id,
                    title,
                    condition,
                    _json_dumps(sources, "sourceRefs"),
                    next_check,
                    now,
                    now,
                ),
            )
            row = connection.execute(
                """SELECT * FROM watches
                   WHERE org=? AND workspace=? AND actor=? AND watch_id=?""",
                (*scope, watch_id),
            ).fetchone()
        assert row is not None
        return _watch_view(row, self._row_json(row, "source_refs_json"))

    def list_watches(
        self,
        org: str,
        workspace: str,
        actor: str,
        state: str | None = None,
        conversation_id: str | None = None,
        limit: int = 100,
    ) -> list[WireView]:
        """List a bounded page of watches owned by the calling actor."""

        scope = self._scope(org, workspace, actor)
        selected_state = _optional_choice(state, "state", {"active", "cancelled"})
        conversation = _optional_identifier(conversation_id, "conversationId")
        page_limit = _list_limit(limit)
        sql = "SELECT * FROM watches WHERE org=? AND workspace=? AND actor=?"
        params: tuple[object, ...] = scope
        if selected_state is not None:
            sql += " AND state=?"
            params += (selected_state,)
        if conversation is not None:
            sql += " AND conversation_id=?"
            params += (conversation,)
        sql += " ORDER BY created_at DESC, watch_id LIMIT ?"
        params += (page_limit,)
        with self._read() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [_watch_view(row, self._row_json(row, "source_refs_json")) for row in rows]

    def get_watch(self, org: str, workspace: str, actor: str, watch_id: str) -> WireView:
        """Read one watch in actor scope before a state transition."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(watch_id, "watchId")
        with self._read() as connection:
            row = connection.execute(
                """SELECT * FROM watches
                   WHERE org=? AND workspace=? AND actor=? AND watch_id=?""",
                (*scope, identifier),
            ).fetchone()
        if row is None:
            raise _not_found("Watch was not found")
        return _watch_view(row, self._row_json(row, "source_refs_json"))

    def cancel_watch(
        self,
        org: str,
        workspace: str,
        actor: str,
        watch_id: str,
        expected_version: int,
    ) -> WireView:
        """Cancel a watch with a version check and stable retry result."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(watch_id, "watchId")
        expected = _version(expected_version, "expectedVersion")
        with self._write() as connection:
            row = connection.execute(
                """SELECT * FROM watches
                   WHERE org=? AND workspace=? AND actor=? AND watch_id=?""",
                (*scope, identifier),
            ).fetchone()
            if row is None:
                raise _not_found("Watch was not found")
            if row["state"] == "cancelled" and int(row["version"]) == expected + 1:
                return _watch_view(row, self._row_json(row, "source_refs_json"))
            if row["state"] != "active" or int(row["version"]) != expected:
                raise _conflict("Watch state or version changed")
            now = _now_ms()
            connection.execute(
                """UPDATE watches SET state='cancelled', version=version+1, updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND watch_id=? AND version=?""",
                (now, *scope, identifier, expected),
            )
            updated = connection.execute(
                """SELECT * FROM watches
                   WHERE org=? AND workspace=? AND actor=? AND watch_id=?""",
                (*scope, identifier),
            ).fetchone()
        assert updated is not None
        return _watch_view(updated, self._row_json(updated, "source_refs_json"))

    def schedule_watch(
        self,
        org: str,
        workspace: str,
        actor: str,
        watch_id: str,
        expected_version: int,
        next_check_at: int | None,
    ) -> WireView:
        """Reschedule one active owner watch with CAS and an idempotent replay."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(watch_id, "watchId")
        expected = _version(expected_version, "expectedVersion")
        next_check = _optional_timestamp(next_check_at, "nextCheckAt")
        with self._write() as connection:
            row = connection.execute(
                """SELECT * FROM watches
                   WHERE org=? AND workspace=? AND actor=? AND watch_id=?""",
                (*scope, identifier),
            ).fetchone()
            if row is None:
                raise _not_found("Watch was not found")
            if (
                row["state"] == "active"
                and int(row["version"]) == expected + 1
                and row["next_check_at"] == next_check
            ):
                return _watch_view(row, self._row_json(row, "source_refs_json"))
            if row["state"] != "active" or int(row["version"]) != expected:
                raise _conflict("Only the current version of an active watch can be scheduled")
            now = _now_ms()
            connection.execute(
                """UPDATE watches SET next_check_at=?, version=version+1, updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND watch_id=? AND version=?
                     AND state='active'""",
                (next_check, now, *scope, identifier, expected),
            )
            updated = connection.execute(
                """SELECT * FROM watches
                   WHERE org=? AND workspace=? AND actor=? AND watch_id=?""",
                (*scope, identifier),
            ).fetchone()
        assert updated is not None
        return _watch_view(updated, self._row_json(updated, "source_refs_json"))

    def create_focus_item(
        self, org: str, workspace: str, actor: str, body: Mapping[str, object]
    ) -> WireView:
        """Create a sourced commitment, wait, or attention item."""

        scope = self._scope(org, workspace, actor)
        payload = _body(
            body,
            required={
                "idempotencyKey",
                "conversationId",
                "conversationKind",
                "kind",
                "summary",
                "sourceRefs",
            },
            optional={"dueAt", "condition", "personaId"},
        )
        key = _idempotency_key(payload["idempotencyKey"])
        conversation_id, conversation_kind, persona_id = _source_context(payload)
        kind = _choice(payload["kind"], "kind", {"commitment", "wait", "attention"})
        summary = _text(payload["summary"], "summary", maximum=2_000)
        sources = _source_refs(payload["sourceRefs"])
        due_at = _optional_timestamp(payload.get("dueAt"), "dueAt")
        condition = _optional_text(payload.get("condition"), "condition", maximum=2_000)
        initial_state = "waiting" if kind == "wait" else "open"
        digest = _digest(
            {
                "conversationId": conversation_id,
                "conversationKind": conversation_kind,
                "personaId": persona_id,
                "kind": kind,
                "summary": summary,
                "sourceRefs": sources,
                "dueAt": due_at,
                "condition": condition,
            }
        )
        now = _now_ms()
        with self._write() as connection:
            existing = connection.execute(
                """SELECT * FROM focus_items
                   WHERE org=? AND workspace=? AND actor=? AND idempotency_key=?""",
                (*scope, key),
            ).fetchone()
            if existing is not None:
                if _focus_digest(existing) != digest:
                    raise _conflict("Focus item idempotency key was reused with different data")
                return _focus_view(existing, self._row_json(existing, "source_refs_json"))
            focus_id = _new_id()
            connection.execute(
                """INSERT INTO focus_items (
                       org, workspace, actor, focus_item_id, idempotency_key,
                       conversation_id, conversation_kind, persona_id,
                       kind, summary, source_refs_json, due_at,
                       condition, state, version, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                (
                    *scope,
                    focus_id,
                    key,
                    conversation_id,
                    conversation_kind,
                    persona_id,
                    kind,
                    summary,
                    _json_dumps(sources, "sourceRefs"),
                    due_at,
                    condition,
                    initial_state,
                    now,
                    now,
                ),
            )
            row = connection.execute(
                """SELECT * FROM focus_items
                   WHERE org=? AND workspace=? AND actor=? AND focus_item_id=?""",
                (*scope, focus_id),
            ).fetchone()
        assert row is not None
        return _focus_view(row, self._row_json(row, "source_refs_json"))

    def list_focus_items(
        self,
        org: str,
        workspace: str,
        actor: str,
        state: str | None = None,
        conversation_id: str | None = None,
        limit: int = 100,
    ) -> list[WireView]:
        """List actor-owned focus items with an optional lifecycle/conversation filter."""

        scope = self._scope(org, workspace, actor)
        selected_state = _optional_choice(state, "state", _FOCUS_STATES)
        conversation = _optional_identifier(conversation_id, "conversationId")
        page_limit = _list_limit(limit)
        sql = "SELECT * FROM focus_items WHERE org=? AND workspace=? AND actor=?"
        params: tuple[object, ...] = scope
        if selected_state is not None:
            sql += " AND state=?"
            params += (selected_state,)
        if conversation is not None:
            sql += " AND conversation_id=?"
            params += (conversation,)
        sql += " ORDER BY created_at DESC, focus_item_id LIMIT ?"
        params += (page_limit,)
        with self._read() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [_focus_view(row, self._row_json(row, "source_refs_json")) for row in rows]

    def get_focus_item(self, org: str, workspace: str, actor: str, focus_item_id: str) -> WireView:
        """Read one focus item in actor scope before a transition."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(focus_item_id, "focusItemId")
        with self._read() as connection:
            row = connection.execute(
                """SELECT * FROM focus_items
                   WHERE org=? AND workspace=? AND actor=? AND focus_item_id=?""",
                (*scope, identifier),
            ).fetchone()
        if row is None:
            raise _not_found("Focus item was not found")
        return _focus_view(row, self._row_json(row, "source_refs_json"))

    def transition_focus_item(
        self,
        org: str,
        workspace: str,
        actor: str,
        focus_item_id: str,
        body: Mapping[str, object],
    ) -> WireView:
        """Transition a focus item's lifecycle state with an idempotent version check."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(focus_item_id, "focusItemId")
        payload = _body(body, required={"state", "expectedVersion"}, optional=set())
        target = _choice(payload["state"], "state", _FOCUS_STATES)
        expected = _version(payload["expectedVersion"], "expectedVersion")
        with self._write() as connection:
            row = connection.execute(
                """SELECT * FROM focus_items
                   WHERE org=? AND workspace=? AND actor=? AND focus_item_id=?""",
                (*scope, identifier),
            ).fetchone()
            if row is None:
                raise _not_found("Focus item was not found")
            current_state = str(row["state"])
            current_version = int(row["version"])
            if current_state == target and current_version == expected + 1:
                return _focus_view(row, self._row_json(row, "source_refs_json"))
            if current_state == target and current_version == expected:
                return _focus_view(row, self._row_json(row, "source_refs_json"))
            if current_version != expected:
                raise _conflict("Focus item version changed")
            allowed = {
                "open": {"waiting", "done", "cancelled"},
                "waiting": {"open", "done", "cancelled"},
                "done": set(),
                "cancelled": set(),
            }
            if target not in allowed[current_state]:
                raise _conflict("Focus item lifecycle transition is not allowed")
            now = _now_ms()
            connection.execute(
                """UPDATE focus_items SET state=?, version=version+1, updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND focus_item_id=? AND version=?""",
                (target, now, *scope, identifier, expected),
            )
            updated = connection.execute(
                """SELECT * FROM focus_items
                   WHERE org=? AND workspace=? AND actor=? AND focus_item_id=?""",
                (*scope, identifier),
            ).fetchone()
        assert updated is not None
        return _focus_view(updated, self._row_json(updated, "source_refs_json"))

    def create_handoff(
        self, org: str, workspace: str, actor: str, body: Mapping[str, object]
    ) -> WireView:
        """Store only a sourced summary, unresolved items, and unknown operation references."""

        scope = self._scope(org, workspace, actor)
        payload = _body(
            body,
            required={
                "idempotencyKey",
                "taskId",
                "sessionId",
                "summary",
                "unresolvedItems",
                "unknownOperationRefs",
                "sourceRefs",
            },
            optional={"conversationId", "conversationKind", "personaId"},
        )
        key = _idempotency_key(payload["idempotencyKey"])
        conversation_id, conversation_kind, persona_id = _source_context(payload)
        task_id = _identifier(payload["taskId"], "taskId")
        session_id = _identifier(payload["sessionId"], "sessionId")
        summary = _text(payload["summary"], "summary", maximum=3_000)
        unresolved = _string_list(
            payload["unresolvedItems"], "unresolvedItems", maximum=30, item_maximum=1_000
        )
        unknown_refs = _string_list(
            payload["unknownOperationRefs"], "unknownOperationRefs", maximum=50, source_refs=True
        )
        sources = _source_refs(payload["sourceRefs"])
        digest = _digest(
            {
                "conversationId": conversation_id,
                "conversationKind": conversation_kind,
                "personaId": persona_id,
                "taskId": task_id,
                "sessionId": session_id,
                "summary": summary,
                "unresolvedItems": unresolved,
                "unknownOperationRefs": unknown_refs,
                "sourceRefs": sources,
            }
        )
        now = _now_ms()
        with self._write() as connection:
            existing = connection.execute(
                """SELECT * FROM handoffs
                   WHERE org=? AND workspace=? AND actor=? AND idempotency_key=?""",
                (*scope, key),
            ).fetchone()
            if existing is not None:
                if _handoff_digest(existing) != digest:
                    raise _conflict("Handoff idempotency key was reused with different data")
                return _handoff_view(
                    existing,
                    self._row_json(existing, "unresolved_items_json"),
                    self._row_json(existing, "unknown_operation_refs_json"),
                    self._row_json(existing, "source_refs_json"),
                )
            handoff_id = _new_id()
            connection.execute(
                """INSERT INTO handoffs (
                       org, workspace, actor, handoff_id, idempotency_key, task_id,
                       conversation_id, conversation_kind, persona_id,
                       session_id, summary, unresolved_items_json,
                       unknown_operation_refs_json, source_refs_json, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    *scope,
                    handoff_id,
                    key,
                    task_id,
                    conversation_id,
                    conversation_kind,
                    persona_id,
                    session_id,
                    summary,
                    _json_dumps(unresolved, "unresolvedItems"),
                    _json_dumps(unknown_refs, "unknownOperationRefs"),
                    _json_dumps(sources, "sourceRefs"),
                    now,
                ),
            )
            row = connection.execute(
                """SELECT * FROM handoffs
                   WHERE org=? AND workspace=? AND actor=? AND handoff_id=?""",
                (*scope, handoff_id),
            ).fetchone()
        assert row is not None
        return _handoff_view(
            row,
            self._row_json(row, "unresolved_items_json"),
            self._row_json(row, "unknown_operation_refs_json"),
            self._row_json(row, "source_refs_json"),
        )

    def read_handoff(self, org: str, workspace: str, actor: str, handoff_id: str) -> WireView:
        """Read one handoff by full actor scope."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(handoff_id, "handoffId")
        with self._read() as connection:
            row = connection.execute(
                """SELECT * FROM handoffs
                   WHERE org=? AND workspace=? AND actor=? AND handoff_id=?""",
                (*scope, identifier),
            ).fetchone()
        if row is None:
            raise _not_found("Handoff was not found")
        return _handoff_view(
            row,
            self._row_json(row, "unresolved_items_json"),
            self._row_json(row, "unknown_operation_refs_json"),
            self._row_json(row, "source_refs_json"),
        )

    def append_review_event(
        self, org: str, workspace: str, actor: str, body: Mapping[str, object]
    ) -> WireView:
        """Append an idempotent sourced review/audit event."""

        scope = self._scope(org, workspace, actor)
        payload = _body(
            body,
            required={"idempotencyKey", "eventType", "summary", "sourceRefs"},
            optional={"conversationId", "conversationKind", "personaId", "decision"},
        )
        key = _idempotency_key(payload["idempotencyKey"])
        event_type = _choice(
            payload["eventType"],
            "eventType",
            {"approved", "rejected", "edited", "imported", "rolled_back", "reviewed"},
        )
        summary = _text(payload["summary"], "summary", maximum=2_000)
        conversation_id, conversation_kind, persona_id = _source_context(payload)
        decision = _optional_text(payload.get("decision"), "decision", maximum=240)
        sources = _source_refs(payload["sourceRefs"])
        digest = _digest(
            {
                "conversationId": conversation_id,
                "conversationKind": conversation_kind,
                "personaId": persona_id,
                "eventType": event_type,
                "summary": summary,
                "decision": decision,
                "sourceRefs": sources,
            }
        )
        now = _now_ms()
        with self._write() as connection:
            existing = connection.execute(
                """SELECT * FROM review_events
                   WHERE org=? AND workspace=? AND actor=? AND idempotency_key=?""",
                (*scope, key),
            ).fetchone()
            if existing is not None:
                if _review_digest(existing) != digest:
                    raise _conflict("Review event idempotency key was reused with different data")
                return _review_view(existing, self._row_json(existing, "source_refs_json"))
            event_id = _new_id()
            connection.execute(
                """INSERT INTO review_events (
                   org, workspace, actor, event_id, idempotency_key, conversation_id,
                       conversation_kind, persona_id, event_type, summary, decision,
                       source_refs_json, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    *scope,
                    event_id,
                    key,
                    conversation_id,
                    conversation_kind,
                    persona_id,
                    event_type,
                    summary,
                    decision,
                    _json_dumps(sources, "sourceRefs"),
                    now,
                ),
            )
            row = connection.execute(
                """SELECT * FROM review_events
                   WHERE org=? AND workspace=? AND actor=? AND event_id=?""",
                (*scope, event_id),
            ).fetchone()
        assert row is not None
        return _review_view(row, self._row_json(row, "source_refs_json"))

    def list_review_events(
        self,
        org: str,
        workspace: str,
        actor: str,
        conversation_id: str | None = None,
        limit: int = 100,
    ) -> list[WireView]:
        """List a bounded page of actor-owned review events."""

        scope = self._scope(org, workspace, actor)
        conversation = _optional_identifier(conversation_id, "conversationId")
        page_limit = _list_limit(limit)
        sql = "SELECT * FROM review_events WHERE org=? AND workspace=? AND actor=?"
        params: tuple[object, ...] = scope
        if conversation is not None:
            sql += " AND conversation_id=?"
            params += (conversation,)
        sql += " ORDER BY created_at DESC, event_id LIMIT ?"
        params += (page_limit,)
        with self._read() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [_review_view(row, self._row_json(row, "source_refs_json")) for row in rows]

    def preview_import_batch(
        self, org: str, workspace: str, actor: str, body: Mapping[str, object]
    ) -> WireView:
        """Return only import counts and a digest; this method never persists input text."""

        self._scope(org, workspace, actor)
        prepared = _prepare_import(body)
        return {
            "recordCount": prepared.record_count,
            "acceptedCount": len(prepared.accepted),
            "quarantinedCount": prepared.quarantined_count,
            "digest": prepared.digest,
        }

    def apply_import_batch(
        self, org: str, workspace: str, actor: str, body: Mapping[str, object]
    ) -> WireView:
        """Apply one safe, source-traceable import batch idempotently."""

        scope = self._scope(org, workspace, actor)
        prepared = _prepare_import(body)
        now = _now_ms()
        with self._write() as connection:
            existing = connection.execute(
                """SELECT * FROM import_batches
                   WHERE org=? AND workspace=? AND actor=? AND batch_id=?""",
                (*scope, prepared.batch_id),
            ).fetchone()
            if existing is not None:
                if (
                    str(existing["digest"]) != prepared.digest
                    or str(existing["source_kind"]) != prepared.source_kind
                ):
                    raise _conflict("Import batch id was reused with different data")
                return _import_batch_view(existing)
            connection.execute(
                """INSERT INTO import_batches (
                       org, workspace, actor, batch_id, source_kind, state,
                       record_count, accepted_count, quarantined_count, digest,
                       version, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, 1, ?, ?)""",
                (
                    *scope,
                    prepared.batch_id,
                    prepared.source_kind,
                    prepared.record_count,
                    len(prepared.accepted),
                    prepared.quarantined_count,
                    prepared.digest,
                    now,
                    now,
                ),
            )
            for record in prepared.accepted:
                connection.execute(
                    """INSERT INTO import_records (
                       org, workspace, actor, batch_id, record_id, kind,
                           conversation_id, conversation_kind, persona_id,
                           text, source_refs_json, visibility,
                           valid_until, state
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')""",
                    (
                        *scope,
                        prepared.batch_id,
                        record["recordId"],
                        record["kind"],
                        record["conversationId"],
                        record["conversationKind"],
                        record["personaId"],
                        record["text"],
                        _json_dumps(record["sourceRefs"], "sourceRefs"),
                        record["visibility"],
                        record["validUntil"],
                    ),
                )
            row = connection.execute(
                """SELECT * FROM import_batches
                   WHERE org=? AND workspace=? AND actor=? AND batch_id=?""",
                (*scope, prepared.batch_id),
            ).fetchone()
        assert row is not None
        return _import_batch_view(row)

    def rollback_import_batch(
        self, org: str, workspace: str, actor: str, batch_id: str
    ) -> WireView:
        """Deactivate all accepted records in a batch and make repeated rollback safe."""

        scope = self._scope(org, workspace, actor)
        identifier = _identifier(batch_id, "batchId")
        with self._write() as connection:
            row = connection.execute(
                """SELECT * FROM import_batches
                   WHERE org=? AND workspace=? AND actor=? AND batch_id=?""",
                (*scope, identifier),
            ).fetchone()
            if row is None:
                raise _not_found("Import batch was not found")
            if row["state"] == "rolledBack":
                return _import_batch_view(row)
            now = _now_ms()
            connection.execute(
                """UPDATE import_records SET state='rolledBack'
                   WHERE org=? AND workspace=? AND actor=? AND batch_id=? AND state='active'""",
                (*scope, identifier),
            )
            connection.execute(
                """UPDATE import_batches SET state='rolledBack', version=version+1, updated_at=?
                   WHERE org=? AND workspace=? AND actor=? AND batch_id=?""",
                (now, *scope, identifier),
            )
            updated = connection.execute(
                """SELECT * FROM import_batches
                   WHERE org=? AND workspace=? AND actor=? AND batch_id=?""",
                (*scope, identifier),
            ).fetchone()
        assert updated is not None
        return _import_batch_view(updated)

    def export_actor_backup(self, org: str, workspace: str, actor: str) -> bytes:
        """Export only this actor's domain records as a bounded, filtered JSON document."""

        scope = self._scope(org, workspace, actor)
        scope_json = json.dumps(
            {"org": scope[0], "workspace": scope[1], "actor": scope[2]},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        scope_digest = hashlib.sha256(scope_json.encode("utf-8")).hexdigest()
        created_at = _now_ms()
        plans: tuple[tuple[str, str, Callable[[sqlite3.Row], WireView]], ...] = (
            (
                "personas",
                """SELECT * FROM personas WHERE org=? AND workspace=? AND actor=?
                   ORDER BY persona_id""",
                lambda row: _persona_view(row, _decode_json(row, "conversation_ids_json")),
            ),
            (
                "activeBehaviorPolicies",
                """SELECT * FROM active_behavior_policies
                   WHERE org=? AND workspace=? AND actor=? ORDER BY conversation_id""",
                lambda row: _behavior_policy_view(row, _decode_json(row, "quiet_hours_json")),
            ),
            (
                "profileCandidates",
                """SELECT * FROM profile_candidates WHERE org=? AND workspace=? AND actor=?
                   ORDER BY candidate_id""",
                lambda row: _candidate_view(row, _decode_json(row, "evidence_json")),
            ),
            (
                "profiles",
                """SELECT * FROM profiles WHERE org=? AND workspace=? AND actor=?
                   ORDER BY profile_id""",
                lambda row: _profile_view(row, _decode_json(row, "evidence_json")),
            ),
            (
                "graphChangesets",
                """SELECT * FROM graph_changesets WHERE org=? AND workspace=? AND actor=?
                   ORDER BY changeset_id""",
                _graph_view,
            ),
            (
                "maintenanceJobs",
                """SELECT * FROM maintenance_jobs WHERE org=? AND workspace=? AND actor=?
                   ORDER BY job_id""",
                lambda row: _maintenance_view(row, _decode_json(row, "details_json")),
            ),
            (
                "researchNotes",
                """SELECT * FROM research_notes WHERE org=? AND workspace=? AND actor=?
                   ORDER BY note_id""",
                lambda row: _research_note_view(row, _decode_json(row, "source_refs_json")),
            ),
            (
                "verifiedSkills",
                """SELECT * FROM verified_skills WHERE org=? AND workspace=? AND actor=?
                   AND operation_receipt_id IS NOT NULL
                   AND independent_read_receipt_id IS NOT NULL
                   ORDER BY skill_id""",
                lambda row: _skill_view(row, _decode_json(row, "source_refs_json")),
            ),
            (
                "watches",
                """SELECT * FROM watches WHERE org=? AND workspace=? AND actor=?
                   ORDER BY watch_id""",
                lambda row: _watch_view(row, _decode_json(row, "source_refs_json")),
            ),
            (
                "focusItems",
                """SELECT * FROM focus_items WHERE org=? AND workspace=? AND actor=?
                   ORDER BY focus_item_id""",
                lambda row: _focus_view(row, _decode_json(row, "source_refs_json")),
            ),
            (
                "handoffs",
                """SELECT * FROM handoffs WHERE org=? AND workspace=? AND actor=?
                   ORDER BY handoff_id""",
                lambda row: _handoff_view(
                    row,
                    _decode_json(row, "unresolved_items_json"),
                    _decode_json(row, "unknown_operation_refs_json"),
                    _decode_json(row, "source_refs_json"),
                ),
            ),
            (
                "reviewEvents",
                """SELECT * FROM review_events WHERE org=? AND workspace=? AND actor=?
                   ORDER BY event_id""",
                lambda row: _review_view(row, _decode_json(row, "source_refs_json")),
            ),
            (
                "importBatches",
                """SELECT * FROM import_batches WHERE org=? AND workspace=? AND actor=?
                   ORDER BY batch_id""",
                _import_batch_view,
            ),
            (
                "importRecords",
                """SELECT * FROM import_records WHERE org=? AND workspace=? AND actor=?
                   ORDER BY batch_id, record_id""",
                lambda row: _import_record_view(row, _decode_json(row, "source_refs_json")),
            ),
        )
        header = {
            "schemaVersion": 1,
            "createdAt": created_at,
            "scopeDigest": scope_digest,
        }
        encoded_header = json.dumps(
            header, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        output = bytearray(encoded_header[:-1])
        output.extend(b',"records":{')
        _check_backup_size(len(output))
        with self._read() as connection:
            connection.execute("BEGIN")
            for table_index, (table_name, statement, to_view) in enumerate(plans):
                if table_index:
                    _append_backup(output, b",")
                _append_backup(
                    output,
                    json.dumps(table_name, ensure_ascii=False).encode("utf-8") + b":[",
                )
                first_record = True
                cursor = connection.execute(statement, scope)
                while rows := cursor.fetchmany(100):
                    for row in rows:
                        if not first_record:
                            _append_backup(output, b",")
                        record = _filter_backup_value(to_view(row))
                        _append_backup(output, _backup_record_bytes(record))
                        first_record = False
                _append_backup(output, b"]")
        _append_backup(output, b"}}")
        return bytes(output)


@dataclass(frozen=True)
class _PreparedImport:
    """Validated import plan that contains only records eligible for persistence."""

    batch_id: str
    source_kind: str
    record_count: int
    accepted: list[dict[str, object]]
    quarantined_count: int
    digest: str


def _prepare_import(body: Mapping[str, object]) -> _PreparedImport:
    """Validate import metadata and isolate unsafe, unsupported, or unsourced records."""

    if not isinstance(body, Mapping):
        raise _invalid("import body must be an object")
    if set(body) != {"batchId", "sourceKind", "records"}:
        raise _invalid("import body contains missing or unsupported fields")
    batch_id = _identifier(body["batchId"], "batchId")
    source_kind = _text(body["sourceKind"], "sourceKind", maximum=120)
    raw_records = body["records"]
    if not isinstance(raw_records, list) or len(raw_records) > _MAX_IMPORT_RECORDS:
        raise _invalid("records must be a bounded array")
    if _serialized_size(body, "import", maximum=_MAX_IMPORT_BYTES) > _MAX_IMPORT_BYTES:
        raise _invalid("import body exceeds the supported size")

    accepted: list[dict[str, object]] = []
    quarantined: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    for index, raw_record in enumerate(raw_records):
        fallback_id = f"item-{index + 1}"
        if not isinstance(raw_record, Mapping):
            quarantined.append(
                {"recordId": fallback_id, "kind": "unknown", "reason": "invalid_shape"}
            )
            continue
        candidate_id = raw_record.get("recordId")
        record_id = _safe_quarantine_label(candidate_id, fallback_id)
        candidate_kind = raw_record.get("kind")
        kind_label = _safe_quarantine_label(candidate_kind, "unknown", maximum=120)
        try:
            _ensure_safe_tree(raw_record, f"records[{index}]")
        except PersistenceError:
            quarantined.append(
                {"recordId": record_id, "kind": kind_label, "reason": "unsafe_content"}
            )
            continue
        allowed = {
            "recordId",
            "kind",
            "conversationId",
            "conversationKind",
            "personaId",
            "text",
            "sourceRefs",
            "visibility",
            "validUntil",
        }
        if set(raw_record) - allowed:
            quarantined.append(
                {"recordId": record_id, "kind": kind_label, "reason": "unsupported_fields"}
            )
            continue
        if not allowed.intersection(raw_record):
            quarantined.append(
                {"recordId": record_id, "kind": kind_label, "reason": "invalid_shape"}
            )
            continue
        try:
            record = _body(
                raw_record,
                required={"recordId", "kind", "text", "sourceRefs", "visibility"},
                optional={
                    "conversationId",
                    "conversationKind",
                    "personaId",
                    "validUntil",
                },
                maximum=_MAX_TEXT + 16_384,
            )
            normalized_id = _identifier(record["recordId"], "recordId")
            normalized_kind = _text(record["kind"], "kind", maximum=120)
            kind_key = re.sub(r"[^a-z0-9]", "", normalized_kind.casefold())
            if any(token in kind_key for token in ("credential", "loginstate", "runningtask")):
                raise _invalid("protected import kind")
            text = _text(record["text"], "text", maximum=8_000)
            if "task" in kind_key and re.search(
                r"\b(running|queued|in[_ -]?progress)\b", text, re.IGNORECASE
            ):
                raise _invalid("running task data is not importable")
            sources = _source_refs(record["sourceRefs"])
            visibility = _choice(
                record["visibility"], "visibility", {"private", "conversation", "workspace"}
            )
            conversation_id, conversation_kind, persona_id = _source_context(record)
            valid_until = _optional_timestamp(record.get("validUntil"), "validUntil")
            normalized: dict[str, object] = {
                "recordId": normalized_id,
                "kind": normalized_kind,
                "conversationId": conversation_id,
                "conversationKind": conversation_kind,
                "personaId": persona_id,
                "text": text,
                "sourceRefs": sources,
                "visibility": visibility,
                "validUntil": valid_until,
            }
        except PersistenceError:
            quarantined.append(
                {"recordId": record_id, "kind": kind_label, "reason": "invalid_or_unprovenanced"}
            )
            continue
        if normalized_id in seen_ids:
            quarantined.append(
                {
                    "recordId": normalized_id,
                    "kind": normalized_kind,
                    "reason": "duplicate_record_id",
                }
            )
            continue
        seen_ids.add(normalized_id)
        accepted.append(normalized)

    digest_value = {
        "batchId": batch_id,
        "sourceKind": source_kind,
        "recordCount": len(raw_records),
        "accepted": accepted,
        "quarantined": quarantined,
    }
    digest = _digest(digest_value)
    return _PreparedImport(
        batch_id, source_kind, len(raw_records), accepted, len(quarantined), digest
    )


def _body(
    value: Mapping[str, object],
    *,
    required: set[str],
    optional: set[str],
    maximum: int = _MAX_BODY_BYTES,
) -> dict[str, object]:
    """Validate a strict camelCase request object and reject unsafe extra fields."""

    if not isinstance(value, Mapping):
        raise _invalid("body must be an object")
    keys = set(value)
    if any(not isinstance(key, str) for key in keys):
        raise _invalid("body keys must be strings")
    if not required.issubset(keys) or keys - required - optional:
        raise _invalid("body contains missing or unsupported fields")
    _ensure_safe_tree(value, "body")
    if _serialized_size(value, "body", maximum=maximum) > maximum:
        raise _invalid("body exceeds the supported size")
    return dict(value)


def _ensure_safe_tree(value: object, field: str, depth: int = 0) -> None:
    """Bound JSON-compatible values and reject credential, owner, or runtime state fields."""

    if depth > 12:
        raise _invalid(f"{field} is nested too deeply")
    if value is None or type(value) in {bool, int}:
        return
    if type(value) is float:
        if not math.isfinite(value):
            raise _invalid(f"{field} must contain finite numbers")
        return
    if isinstance(value, str):
        if len(value) > _MAX_TEXT or _has_sensitive_text(value):
            raise _invalid(f"{field} contains unsafe or overlong text")
        if any(
            (ord(character) < 32 and character not in "\n\r\t") or 127 <= ord(character) <= 159
            for character in value
        ):
            raise _invalid(f"{field} contains control characters")
        return
    if isinstance(value, Mapping):
        if len(value) > 1_000:
            raise _invalid(f"{field} contains too many fields")
        for key, nested in value.items():
            if not isinstance(key, str):
                raise _invalid(f"{field} keys must be strings")
            normalized = re.sub(r"[^a-z0-9]", "", key.casefold())
            if normalized in _SENSITIVE_KEYS:
                raise _invalid(f"{field} contains a prohibited field")
            _ensure_safe_tree(nested, f"{field}.{key}", depth + 1)
        return
    if isinstance(value, list):
        if len(value) > _MAX_IMPORT_RECORDS:
            raise _invalid(f"{field} contains too many items")
        for index, nested in enumerate(value):
            _ensure_safe_tree(nested, f"{field}[{index}]", depth + 1)
        return
    raise _invalid(f"{field} must contain JSON-compatible values")


def _serialized_size(value: object, field: str, maximum: int = _MAX_BODY_BYTES) -> int:
    """Measure canonical JSON input size without retaining a second representation."""

    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise _invalid(f"{field} must contain JSON-compatible values") from exc
    size = len(encoded.encode("utf-8"))
    if size > maximum:
        raise _invalid(f"{field} exceeds the supported size")
    return size


def _json_dumps(value: object, field: str, maximum: int = _MAX_BODY_BYTES) -> str:
    """Return stable bounded JSON for SQLite storage."""

    _ensure_safe_tree(value, field)
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise _invalid(f"{field} must contain JSON-compatible values") from exc
    if len(encoded.encode("utf-8")) > maximum:
        raise _invalid(f"{field} exceeds the supported size")
    return encoded


def _identifier(value: object, field: str) -> str:
    """Validate an opaque identifier without accepting paths or control characters."""

    text = _text(value, field, maximum=200)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}", text) or ".." in text:
        raise _invalid(f"{field} is not a safe identifier")
    return text


def _optional_identifier(value: object, field: str) -> str | None:
    return None if value is None else _identifier(value, field)


def _source_context(
    payload: Mapping[str, object],
) -> tuple[str | None, str, str | None]:
    """Normalize persisted source scope without guessing context for old records."""

    conversation_id = _optional_identifier(payload.get("conversationId"), "conversationId")
    raw_kind = payload.get("conversationKind")
    persona_id = _optional_identifier(payload.get("personaId"), "personaId")
    if conversation_id is not None:
        if raw_kind is None:
            raise _invalid("conversationKind is required for conversation-scoped sources")
        conversation_kind = _choice(raw_kind, "conversationKind", {"direct", "group", "channel"})
        return conversation_id, conversation_kind, persona_id
    conversation_kind = (
        "direct"
        if raw_kind is None
        else _choice(raw_kind, "conversationKind", {"direct", "group", "channel"})
    )
    if conversation_kind != "direct" or persona_id is not None:
        raise _invalid("Sources without a conversation must use the direct neutral context")
    return None, conversation_kind, None


def _idempotency_key(value: object) -> str:
    return _identifier(value, "idempotencyKey")


def _text(value: object, field: str, *, maximum: int, allow_empty: bool = False) -> str:
    """Validate bounded text and reject embedded credentials and control characters."""

    if not isinstance(value, str):
        raise _invalid(f"{field} must be text")
    text = value.strip()
    if (not text and not allow_empty) or len(text) > maximum or _has_sensitive_text(text):
        raise _invalid(f"{field} is empty, unsafe, or overlong")
    if any(
        (ord(character) < 32 and character not in "\n\r\t") or 127 <= ord(character) <= 159
        for character in text
    ):
        raise _invalid(f"{field} contains control characters")
    return text


def _optional_text(value: object, field: str, *, maximum: int) -> str | None:
    return None if value is None else _text(value, field, maximum=maximum)


def _has_sensitive_text(value: str) -> bool:
    return any(pattern.search(value) is not None for pattern in _SENSITIVE_TEXT_PATTERNS)


def _source_ref(value: object, field: str = "sourceRef") -> str:
    """Validate one provenance reference and block URL user-info credentials."""

    text = _text(value, field, maximum=1_024)
    if any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in text):
        raise _invalid(f"{field} contains control characters")
    if re.search(r"^[a-z][a-z0-9+.-]*://[^/\s@]+@", text, re.IGNORECASE):
        raise _invalid(f"{field} must not contain URL credentials")
    return text


def _source_refs(value: object, *, allow_empty: bool = False) -> list[dict[str, object]]:
    """Validate and normalize P2 exact-version lineage references."""

    if not isinstance(value, list) or len(value) > 256 or (not value and not allow_empty):
        raise _invalid("sourceRefs must be a bounded array of P2 source references")
    result: list[dict[str, object]] = []
    seen: set[tuple[str | None, int | None, tuple[str, ...]]] = set()
    for item in value:
        if isinstance(item, str):
            source_id = _source_ref(item, "sourceRefs")
            ref: dict[str, object] = {
                "memoryId": None,
                "memoryVersion": None,
                "sourceMessageIds": [source_id],
            }
        elif isinstance(item, Mapping):
            if set(item) - {"memoryId", "memoryVersion", "sourceMessageIds"}:
                raise _invalid("sourceRefs contains unsupported fields")
            memory_id_raw = item.get("memoryId")
            memory_version_raw = item.get("memoryVersion")
            if (memory_id_raw is None) != (memory_version_raw is None):
                raise _invalid("memoryId and memoryVersion must be supplied together")
            memory_id = (
                None if memory_id_raw is None else _identifier(memory_id_raw, "sourceRefs.memoryId")
            )
            memory_version = (
                None
                if memory_version_raw is None
                else _version(memory_version_raw, "sourceRefs.memoryVersion")
            )
            raw_ids = item.get("sourceMessageIds", [])
            source_ids = _source_message_ids(raw_ids, allow_empty=True)
            if memory_id is None and not source_ids:
                raise _invalid("sourceRefs item must include memory or message lineage")
            ref = {
                "memoryId": memory_id,
                "memoryVersion": memory_version,
                "sourceMessageIds": source_ids,
            }
        else:
            raise _invalid("sourceRefs items must be strings or P2 reference objects")
        source_ids_raw = ref["sourceMessageIds"]
        assert isinstance(source_ids_raw, list)
        key = (
            ref["memoryId"] if isinstance(ref["memoryId"], str) else None,
            ref["memoryVersion"] if isinstance(ref["memoryVersion"], int) else None,
            tuple(source_ids_raw),
        )
        if key not in seen:
            seen.add(key)
            result.append(ref)
    return result


def _source_message_ids(value: object, *, allow_empty: bool = False) -> list[str]:
    if not isinstance(value, list) or len(value) > 128 or (not value and not allow_empty):
        raise _invalid("sourceMessageIds must be a bounded array")
    return list(dict.fromkeys(_identifier(item, "sourceMessageIds") for item in value))


def _source_ids_from_refs(source_refs: Sequence[Mapping[str, object]]) -> list[str]:
    return list(
        dict.fromkeys(
            source_id
            for source_ref in source_refs
            for source_id in cast(list[str], source_ref["sourceMessageIds"])
        )
    )


def _merge_source_refs(
    source_refs: Sequence[Mapping[str, object]], source_ids: Sequence[str]
) -> list[dict[str, object]]:
    merged = [dict(ref) for ref in source_refs]
    if source_ids:
        merged.extend(
            {
                "memoryId": None,
                "memoryVersion": None,
                "sourceMessageIds": list(source_ids[index : index + 128]),
            }
            for index in range(0, len(source_ids), 128)
        )
    return _source_refs(merged)


def _string_list(
    value: object,
    field: str,
    *,
    maximum: int,
    item_maximum: int = 240,
    identifiers: bool = False,
    source_refs: bool = False,
) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise _invalid(f"{field} must be a bounded array")
    result: list[str] = []
    for item in value:
        if source_refs:
            result.append(_source_ref(item, field))
        elif identifiers:
            result.append(_identifier(item, field))
        else:
            result.append(_text(item, field, maximum=item_maximum))
    return list(dict.fromkeys(result))


def _boolean(value: object, field: str) -> bool:
    if type(value) is not bool:
        raise _invalid(f"{field} must be a boolean")
    return value


def _nonnegative_integer(value: object, field: str) -> int:
    if type(value) is not int or value < 0 or value > 2**63 - 1:
        raise _invalid(f"{field} must be a non-negative safe integer")
    return value


def _version(value: object, field: str) -> int:
    if type(value) is not int or value < 1 or value > 2**63 - 1:
        raise _invalid(f"{field} must be a positive safe integer")
    return value


def _list_limit(value: object) -> int:
    if type(value) is not int or not 1 <= value <= _MAX_LIST_LIMIT:
        raise _invalid(f"limit must be between 1 and {_MAX_LIST_LIMIT}")
    return value


def _timestamp(value: object, field: str) -> int:
    if type(value) is not int or not 0 <= value <= 253_402_300_799_999:
        raise _invalid(f"{field} must be a Unix epoch millisecond timestamp")
    return value


def _optional_timestamp(value: object, field: str) -> int | None:
    return None if value is None else _timestamp(value, field)


def _confidence(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _invalid("confidence must be a finite number between 0 and 1")
    confidence = float(value)
    if not math.isfinite(confidence) or not 0 <= confidence <= 1:
        raise _invalid("confidence must be a finite number between 0 and 1")
    return confidence


def _choice(value: object, field: str, choices: set[str]) -> str:
    if not isinstance(value, str) or value not in choices:
        raise _invalid(f"{field} has an unsupported value")
    return value


def _optional_choice(value: object, field: str, choices: set[str]) -> str | None:
    return None if value is None else _choice(value, field, choices)


def _digest(value: object) -> str:
    encoded = _json_dumps(value, "digestInput", maximum=_MAX_IMPORT_BYTES)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _digest_text(value: object, field: str) -> str:
    text = _text(value, field, maximum=80)
    if not re.fullmatch(r"(?:sha256:)?[a-fA-F0-9]{64}", text):
        raise _invalid(f"{field} must be a SHA-256 digest")
    return text.lower()


def _new_id() -> str:
    return str(uuid.uuid4())


def maintenance_task_id(workspace_id: str, actor_id: str, job_id: str) -> str:
    """Derive a stable private Work Task id from its owning domain job."""

    workspace = _identifier(workspace_id, "workspaceId")
    actor = _identifier(actor_id, "actorId")
    job = _identifier(job_id, "jobId")
    digest = hashlib.sha256(
        f"cyrene-maintenance-v1\0{workspace}\0{actor}\0{job}".encode()
    ).hexdigest()[:32]
    return f"maintenance-{digest}"


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


def _invalid(detail: str) -> PersistenceError:
    return PersistenceError("CONVERSATION_DOMAIN_INVALID", 422, detail)


def _not_found(detail: str) -> PersistenceError:
    return PersistenceError("CONVERSATION_DOMAIN_NOT_FOUND", 404, detail)


def _conflict(detail: str) -> PersistenceError:
    return PersistenceError("CONVERSATION_DOMAIN_CONFLICT", 409, detail)


def _safe_quarantine_label(value: object, fallback: str, maximum: int = 200) -> str:
    if not isinstance(value, str):
        return fallback
    text = value.strip()
    if not text or len(text) > maximum or _has_sensitive_text(text):
        return fallback
    if any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in text):
        return fallback
    return text


def _quiet_hours(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping):
        raise _invalid("quietHours must be an object")
    payload = _body(
        value,
        required={"timeZone", "start", "end"},
        optional=set(),
        maximum=4_096,
    )
    time_zone = _text(payload["timeZone"], "quietHours.timeZone", maximum=128)
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+)*", time_zone):
        raise _invalid("quietHours.timeZone must be a safe IANA-style name")
    return {
        "timeZone": time_zone,
        "start": _clock_time(payload["start"], "quietHours.start"),
        "end": _clock_time(payload["end"], "quietHours.end"),
    }


def _clock_time(value: object, field: str) -> str:
    text = _text(value, field, maximum=5)
    if not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", text):
        raise _invalid(f"{field} must use 24-hour HH:MM format")
    return text


def _filter_backup_value(value: object) -> object:
    """Remove denied fields recursively and redact credential-shaped text."""

    if isinstance(value, Mapping):
        filtered: dict[str, object] = {}
        for key, nested in value.items():
            normalized = re.sub(r"[^a-z0-9]", "", key.casefold())
            if normalized in _SENSITIVE_KEYS:
                continue
            filtered[key] = _filter_backup_value(nested)
        return filtered
    if isinstance(value, list):
        return [_filter_backup_value(item) for item in value]
    if isinstance(value, str) and _has_sensitive_text(value):
        return "[REDACTED]"
    return value


def _backup_record_bytes(record: object) -> bytes:
    filtered = _filter_backup_value(record)
    if not isinstance(filtered, dict):
        raise PersistenceError(
            "CONVERSATION_DOMAIN_BACKUP_INVALID", 500, "A domain record could not be filtered"
        )
    try:
        return json.dumps(
            filtered,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise PersistenceError(
            "CONVERSATION_DOMAIN_BACKUP_INVALID", 500, "A domain record is not JSON serializable"
        ) from exc


def _append_backup(output: bytearray, value: bytes) -> None:
    _check_backup_size(len(output) + len(value))
    output.extend(value)


def _check_backup_size(size: int) -> None:
    if size > _MAX_BACKUP_BYTES:
        raise PersistenceError(
            "CONVERSATION_DOMAIN_BACKUP_TOO_LARGE",
            413,
            "Actor domain backup exceeds the supported size limit",
        )


def _graph_nodes(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list) or len(value) > 500:
        raise _invalid("nodes must be a bounded array")
    nodes: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in value:
        node = _body(
            item,
            required={"id", "label"},
            optional={"properties", "sourceMessageIds", "sourceRefs"},
            maximum=32 * 1024,
        )
        identifier = _identifier(node["id"], "nodes.id")
        if identifier in seen:
            raise _invalid("node ids must be unique in a changeset")
        seen.add(identifier)
        label = _text(node["label"], "nodes.label", maximum=240)
        properties = node.get("properties", {})
        if not isinstance(properties, Mapping):
            raise _invalid("nodes.properties must be an object")
        _ensure_safe_tree(properties, "nodes.properties")
        source_ids = _source_message_ids(node.get("sourceMessageIds", []), allow_empty=True)
        source_refs = _merge_source_refs(
            _source_refs(node.get("sourceRefs", []), allow_empty=True), source_ids
        )
        if not source_refs:
            raise _invalid("graph nodes require sourceRefs or sourceMessageIds")
        nodes.append(
            {
                "id": identifier,
                "label": label,
                "properties": dict(properties),
                "sourceMessageIds": _source_ids_from_refs(source_refs),
                "sourceRefs": source_refs,
            }
        )
    return nodes


def _graph_edges(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list) or len(value) > 500:
        raise _invalid("edges must be a bounded array")
    edges: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in value:
        edge = _body(
            item,
            required={"id", "fromId", "toId", "label"},
            optional={"properties", "sourceMessageIds", "sourceRefs"},
            maximum=32 * 1024,
        )
        identifier = _identifier(edge["id"], "edges.id")
        if identifier in seen:
            raise _invalid("edge ids must be unique in a changeset")
        seen.add(identifier)
        properties = edge.get("properties", {})
        if not isinstance(properties, Mapping):
            raise _invalid("edges.properties must be an object")
        _ensure_safe_tree(properties, "edges.properties")
        source_ids = _source_message_ids(edge.get("sourceMessageIds", []), allow_empty=True)
        source_refs = _merge_source_refs(
            _source_refs(edge.get("sourceRefs", []), allow_empty=True), source_ids
        )
        if not source_refs:
            raise _invalid("graph edges require sourceRefs or sourceMessageIds")
        edges.append(
            {
                "id": identifier,
                "fromId": _identifier(edge["fromId"], "edges.fromId"),
                "toId": _identifier(edge["toId"], "edges.toId"),
                "label": _text(edge["label"], "edges.label", maximum=240),
                "properties": dict(properties),
                "sourceMessageIds": _source_ids_from_refs(source_refs),
                "sourceRefs": source_refs,
            }
        )
    return edges


def _json_array(value: object, field: str) -> list[object]:
    if not isinstance(value, list):
        raise PersistenceError(
            "CONVERSATION_DOMAIN_STORAGE_CORRUPT", 500, f"Stored {field} is not an array"
        )
    return value


def _json_object(value: object, field: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise PersistenceError(
            "CONVERSATION_DOMAIN_STORAGE_CORRUPT", 500, f"Stored {field} is not an object"
        )
    return value


def _persona_view(row: sqlite3.Row, conversation_ids: object) -> WireView:
    conversations = _json_array(conversation_ids, "conversationIds")
    if any(not isinstance(item, str) for item in conversations):
        raise PersistenceError(
            "CONVERSATION_DOMAIN_STORAGE_CORRUPT",
            500,
            "Stored conversationIds contains invalid data",
        )
    return {
        "id": str(row["persona_id"]),
        "name": str(row["name"]),
        "description": str(row["description"]),
        "prompt": str(row["prompt"]),
        "enabled": bool(row["enabled"]),
        "conversationIds": conversations,
        "version": int(row["version"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


def _candidate_view(row: sqlite3.Row, evidence: object) -> WireView:
    sources = _json_array(_decode_json(row, "source_message_ids_json"), "sourceMessageIds")
    return {
        "id": str(row["candidate_id"]),
        "idempotencyKey": str(row["idempotency_key"]),
        "conversationId": str(row["conversation_id"]),
        "conversationKind": row["conversation_kind"],
        "subjectKind": str(row["subject_kind"]),
        "personaId": row["persona_id"],
        "category": str(row["category"]),
        "text": str(row["text"]),
        "sourceMessageIds": sources,
        "sourceRefs": _json_array(_decode_json(row, "source_refs_json"), "sourceRefs"),
        "confidence": float(row["confidence"]),
        "validUntil": row["valid_until"],
        "state": str(row["state"]),
        "version": int(row["version"]),
        "evidence": _json_object(evidence, "evidence"),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


def _profile_view(row: sqlite3.Row, evidence: object) -> WireView:
    sources = _json_array(_decode_json(row, "source_message_ids_json"), "sourceMessageIds")
    return {
        "id": str(row["profile_id"]),
        "candidateId": str(row["candidate_id"]),
        "conversationId": str(row["conversation_id"]),
        "conversationKind": row["conversation_kind"],
        "subjectKind": str(row["subject_kind"]),
        "personaId": row["persona_id"],
        "category": str(row["category"]),
        "text": str(row["text"]),
        "sourceMessageIds": sources,
        "sourceRefs": _json_array(_decode_json(row, "source_refs_json"), "sourceRefs"),
        "evidence": _json_object(evidence, "evidence"),
        "validUntil": row["valid_until"],
        "state": str(row["state"]),
        "version": int(row["version"]),
        "previousProfileId": row["previous_profile_id"],
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


def _graph_view(row: sqlite3.Row) -> WireView:
    try:
        payload = json.loads(str(row["payload_json"]))
        receipt_raw = row["provider_receipt_json"]
        receipt_value = None if receipt_raw is None else json.loads(str(receipt_raw))
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise PersistenceError(
            "CONVERSATION_DOMAIN_STORAGE_CORRUPT", 500, "Stored graph changeset is invalid"
        ) from exc
    projection = _json_object(payload, "graphChangeset")
    receipt = None if receipt_value is None else _json_object(receipt_value, "providerReceipt")
    state = str(row["state"])
    if (state == "projected") != (receipt is not None):
        raise PersistenceError(
            "CONVERSATION_DOMAIN_STORAGE_CORRUPT",
            500,
            "Graph changeset state and provider receipt disagree",
        )
    return {
        "id": str(row["changeset_id"]),
        "idempotencyKey": str(row["idempotency_key"]),
        "conversationId": str(row["conversation_id"]),
        "conversationKind": row["conversation_kind"],
        "personaId": row["persona_id"],
        "nodes": _json_array(projection.get("nodes"), "graph nodes"),
        "edges": _json_array(projection.get("edges"), "graph edges"),
        "digest": str(row["digest"]),
        "state": state,
        "version": int(row["version"]),
        "providerReceipt": receipt,
        "providerStatus": "applied" if receipt is not None else "unavailable",
        "providerApplied": receipt is not None,
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


def _maintenance_view(row: sqlite3.Row, details: object) -> WireView:
    return {
        "id": str(row["job_id"]),
        "taskId": maintenance_task_id(str(row["workspace"]), str(row["actor"]), str(row["job_id"])),
        "idempotencyKey": str(row["idempotency_key"]),
        "kind": str(row["kind"]),
        "conversationId": row["conversation_id"],
        "conversationKind": row["conversation_kind"],
        "personaId": row["persona_id"],
        "state": str(row["state"]),
        "cursor": row["cursor"],
        "processedCount": int(row["processed_count"]),
        "checkpointDigest": row["checkpoint_digest"],
        "details": _json_object(details, "details"),
        "version": int(row["version"]),
        "queuedVersion": 1,
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


def _research_note_view(row: sqlite3.Row, sources: object) -> WireView:
    return {
        "id": str(row["note_id"]),
        "idempotencyKey": str(row["idempotency_key"]),
        "conversationId": str(row["conversation_id"]),
        "conversationKind": row["conversation_kind"],
        "personaId": row["persona_id"],
        "title": str(row["title"]),
        "content": str(row["content"]),
        "sourceRefs": _json_array(sources, "sourceRefs"),
        "revision": int(row["revision"]),
        "createdAt": int(row["created_at"]),
    }


def _skill_view(row: sqlite3.Row, sources: object) -> WireView:
    return {
        "id": str(row["skill_id"]),
        "idempotencyKey": str(row["idempotency_key"]),
        "conversationId": row["conversation_id"],
        "conversationKind": row["conversation_kind"],
        "personaId": row["persona_id"],
        "name": str(row["name"]),
        "content": str(row["content"]),
        "sourceRefs": _json_array(sources, "sourceRefs"),
        "operationReceiptId": row["operation_receipt_id"],
        "independentReadReceiptId": row["independent_read_receipt_id"],
        "verified": True,
        "verifiedBy": str(row["verified_by"]),
        "verifiedAt": int(row["verified_at"]),
        "revision": int(row["revision"]),
        "createdAt": int(row["created_at"]),
    }


def _watch_view(row: sqlite3.Row, sources: object) -> WireView:
    return {
        "id": str(row["watch_id"]),
        "idempotencyKey": str(row["idempotency_key"]),
        "conversationId": str(row["conversation_id"]),
        "conversationKind": row["conversation_kind"],
        "personaId": row["persona_id"],
        "title": str(row["title"]),
        "condition": str(row["condition"]),
        "sourceRefs": _json_array(sources, "sourceRefs"),
        "nextCheckAt": row["next_check_at"],
        "state": str(row["state"]),
        "version": int(row["version"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


def _focus_view(row: sqlite3.Row, sources: object) -> WireView:
    return {
        "id": str(row["focus_item_id"]),
        "idempotencyKey": str(row["idempotency_key"]),
        "conversationId": str(row["conversation_id"]),
        "conversationKind": row["conversation_kind"],
        "personaId": row["persona_id"],
        "kind": str(row["kind"]),
        "summary": str(row["summary"]),
        "sourceRefs": _json_array(sources, "sourceRefs"),
        "dueAt": row["due_at"],
        "condition": row["condition"],
        "state": str(row["state"]),
        "version": int(row["version"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


def _handoff_view(
    row: sqlite3.Row, unresolved: object, unknown_refs: object, sources: object
) -> WireView:
    return {
        "id": str(row["handoff_id"]),
        "idempotencyKey": str(row["idempotency_key"]),
        "conversationId": row["conversation_id"],
        "conversationKind": row["conversation_kind"],
        "personaId": row["persona_id"],
        "taskId": str(row["task_id"]),
        "sessionId": str(row["session_id"]),
        "summary": str(row["summary"]),
        "unresolvedItems": _json_array(unresolved, "unresolvedItems"),
        "unknownOperationRefs": _json_array(unknown_refs, "unknownOperationRefs"),
        "sourceRefs": _json_array(sources, "sourceRefs"),
        "createdAt": int(row["created_at"]),
    }


def _review_view(row: sqlite3.Row, sources: object) -> WireView:
    return {
        "id": str(row["event_id"]),
        "idempotencyKey": str(row["idempotency_key"]),
        "conversationId": row["conversation_id"],
        "conversationKind": row["conversation_kind"],
        "personaId": row["persona_id"],
        "eventType": str(row["event_type"]),
        "summary": str(row["summary"]),
        "decision": row["decision"],
        "sourceRefs": _json_array(sources, "sourceRefs"),
        "createdAt": int(row["created_at"]),
    }


def _import_batch_view(row: sqlite3.Row) -> WireView:
    return {
        "batchId": str(row["batch_id"]),
        "sourceKind": str(row["source_kind"]),
        "state": str(row["state"]),
        "recordCount": int(row["record_count"]),
        "acceptedCount": int(row["accepted_count"]),
        "quarantinedCount": int(row["quarantined_count"]),
        "digest": str(row["digest"]),
        "version": int(row["version"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


def _import_record_view(row: sqlite3.Row, sources: object) -> WireView:
    return {
        "batchId": str(row["batch_id"]),
        "recordId": str(row["record_id"]),
        "kind": str(row["kind"]),
        "conversationId": row["conversation_id"],
        "conversationKind": row["conversation_kind"],
        "personaId": row["persona_id"],
        "text": str(row["text"]),
        "sourceRefs": _json_array(sources, "sourceRefs"),
        "visibility": str(row["visibility"]),
        "validUntil": row["valid_until"],
        "state": str(row["state"]),
    }


def _behavior_policy_view(row: sqlite3.Row, quiet_hours: object) -> WireView:
    return {
        "conversationId": str(row["conversation_id"]),
        "enabled": bool(row["enabled"]),
        "quietHours": _json_object(quiet_hours, "quietHours"),
        "cooldownSeconds": int(row["cooldown_seconds"]),
        "allowGroupInterjections": bool(row["allow_group_interjections"]),
        "followupEnabled": bool(row["followup_enabled"]),
        "version": int(row["version"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


def _decode_json(row: sqlite3.Row, field: str) -> object:
    try:
        return json.loads(str(row[field]))
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise PersistenceError(
            "CONVERSATION_DOMAIN_STORAGE_CORRUPT", 500, f"Stored {field} is invalid"
        ) from exc


def _candidate_digest(row: sqlite3.Row) -> str:
    return _digest(
        {
            "conversationId": str(row["conversation_id"]),
            "conversationKind": row["conversation_kind"],
            "subjectKind": str(row["subject_kind"]),
            "personaId": row["persona_id"],
            "category": str(row["category"]),
            "text": str(row["text"]),
            "sourceMessageIds": _decode_json(row, "source_message_ids_json"),
            "sourceRefs": _decode_json(row, "source_refs_json"),
            "confidence": float(row["confidence"]),
            "validUntil": row["valid_until"],
        }
    )


def _job_creation_digest(row: sqlite3.Row) -> str:
    return str(row["request_digest"])


def _research_note_digest(row: sqlite3.Row) -> str:
    return _digest(
        {
            "conversationId": str(row["conversation_id"]),
            "conversationKind": row["conversation_kind"],
            "personaId": row["persona_id"],
            "title": str(row["title"]),
            "content": str(row["content"]),
            "sourceRefs": _decode_json(row, "source_refs_json"),
            "operationReceiptId": row["operation_receipt_id"],
            "independentReadReceiptId": row["independent_read_receipt_id"],
        }
    )


def _skill_digest(row: sqlite3.Row) -> str:
    return _digest(
        {
            "name": str(row["name"]),
            "conversationId": row["conversation_id"],
            "conversationKind": row["conversation_kind"],
            "personaId": row["persona_id"],
            "content": str(row["content"]),
            "sourceRefs": _decode_json(row, "source_refs_json"),
        }
    )


def _watch_digest(row: sqlite3.Row) -> str:
    return _digest(
        {
            "conversationId": str(row["conversation_id"]),
            "conversationKind": row["conversation_kind"],
            "personaId": row["persona_id"],
            "title": str(row["title"]),
            "condition": str(row["condition"]),
            "sourceRefs": _decode_json(row, "source_refs_json"),
            "nextCheckAt": row["next_check_at"],
        }
    )


def _focus_digest(row: sqlite3.Row) -> str:
    return _digest(
        {
            "conversationId": str(row["conversation_id"]),
            "conversationKind": row["conversation_kind"],
            "personaId": row["persona_id"],
            "kind": str(row["kind"]),
            "summary": str(row["summary"]),
            "sourceRefs": _decode_json(row, "source_refs_json"),
            "dueAt": row["due_at"],
            "condition": row["condition"],
        }
    )


def _handoff_digest(row: sqlite3.Row) -> str:
    return _digest(
        {
            "conversationId": row["conversation_id"],
            "conversationKind": row["conversation_kind"],
            "personaId": row["persona_id"],
            "taskId": str(row["task_id"]),
            "sessionId": str(row["session_id"]),
            "summary": str(row["summary"]),
            "unresolvedItems": _decode_json(row, "unresolved_items_json"),
            "unknownOperationRefs": _decode_json(row, "unknown_operation_refs_json"),
            "sourceRefs": _decode_json(row, "source_refs_json"),
        }
    )


def _review_digest(row: sqlite3.Row) -> str:
    return _digest(
        {
            "conversationId": row["conversation_id"],
            "conversationKind": row["conversation_kind"],
            "personaId": row["persona_id"],
            "eventType": str(row["event_type"]),
            "summary": str(row["summary"]),
            "decision": row["decision"],
            "sourceRefs": _decode_json(row, "source_refs_json"),
        }
    )
