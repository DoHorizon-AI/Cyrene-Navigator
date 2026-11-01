"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 store.py                                                          │
│  Module: cyrene_navigator.work.conversation_memory.store              │
│  Role: Persist scoped messages, memories, provenance, and revocations. │
│                                                                      │
│  模块职责：保存对话记忆产品状态，并在授权变化时级联失效派生内容。       │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import sqlite3
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any
from uuid import uuid4

from cyrene_navigator.persistence.errors import PersistenceError

JsonObject = dict[str, Any]
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$")
_MAX_SOURCE_REFS = 256
_MAX_SOURCE_IDS_PER_REF = 128
_MAX_RELATED_EVENTS = 16
_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversation_memory_messages (
 organization_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 message_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 conversation_kind TEXT NOT NULL,
 persona_id TEXT,
 visibility TEXT NOT NULL,
 role TEXT NOT NULL,
 content TEXT NOT NULL,
 source_refs_json TEXT NOT NULL,
 attachments_json TEXT NOT NULL,
 payload_digest TEXT NOT NULL,
 status TEXT NOT NULL,
 occurred_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 revoked_at INTEGER,
 PRIMARY KEY(organization_id, workspace_id, actor_id, message_id),
 UNIQUE(organization_id, workspace_id, actor_id, event_id)
);
CREATE INDEX IF NOT EXISTS conversation_memory_messages_scope
 ON conversation_memory_messages(
   organization_id,workspace_id,actor_id,conversation_id,status,created_at);
CREATE TABLE IF NOT EXISTS conversation_memory_message_sources (
 organization_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 message_id TEXT NOT NULL,
 source_message_id TEXT NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,actor_id,message_id,source_message_id)
);
CREATE INDEX IF NOT EXISTS conversation_memory_message_sources_source
 ON conversation_memory_message_sources(organization_id,workspace_id,source_message_id);
CREATE TABLE IF NOT EXISTS conversation_memory_message_memory_sources (
 organization_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 message_id TEXT NOT NULL,
 source_memory_id TEXT NOT NULL,
 source_memory_version INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,actor_id,message_id,source_memory_id)
);
CREATE INDEX IF NOT EXISTS conversation_memory_message_memory_sources_parent
 ON conversation_memory_message_memory_sources(
   organization_id,workspace_id,source_memory_id,source_memory_version);
CREATE TABLE IF NOT EXISTS conversation_memory_items (
 organization_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 memory_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 conversation_kind TEXT NOT NULL,
 persona_id TEXT,
 visibility TEXT NOT NULL,
 memory_kind TEXT NOT NULL,
 text TEXT NOT NULL,
 source_message_ids_json TEXT NOT NULL,
 source_refs_json TEXT NOT NULL,
 payload_digest TEXT NOT NULL,
 version INTEGER NOT NULL,
 state TEXT NOT NULL,
 index_state TEXT NOT NULL,
 authorization_epoch INTEGER NOT NULL,
 valid_until INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,actor_id,memory_id),
 UNIQUE(organization_id,workspace_id,actor_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS conversation_memory_items_scope
 ON conversation_memory_items(
   organization_id,workspace_id,actor_id,conversation_id,state,updated_at);
CREATE TABLE IF NOT EXISTS conversation_memory_item_sources (
 organization_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 memory_id TEXT NOT NULL,
 source_message_id TEXT NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,actor_id,memory_id,source_message_id)
);
CREATE INDEX IF NOT EXISTS conversation_memory_item_sources_source
 ON conversation_memory_item_sources(organization_id,workspace_id,source_message_id);
CREATE TABLE IF NOT EXISTS conversation_memory_item_memory_sources (
 organization_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 memory_id TEXT NOT NULL,
 source_memory_id TEXT NOT NULL,
 source_memory_version INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,actor_id,memory_id,source_memory_id)
);
CREATE INDEX IF NOT EXISTS conversation_memory_item_memory_sources_parent
 ON conversation_memory_item_memory_sources(
   organization_id,workspace_id,source_memory_id,source_memory_version);
CREATE TABLE IF NOT EXISTS conversation_memory_epochs (
 organization_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 authorization_epoch INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id)
);
CREATE TABLE IF NOT EXISTS conversation_memory_source_grants (
 organization_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 owner_actor_id TEXT NOT NULL,
 grant_id TEXT NOT NULL,
 source_message_id TEXT NOT NULL,
 visibility TEXT NOT NULL,
 target_conversation_id TEXT NOT NULL,
 expires_at INTEGER,
 status TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 revoked_at INTEGER,
 PRIMARY KEY(organization_id,workspace_id,owner_actor_id,grant_id)
);
CREATE INDEX IF NOT EXISTS conversation_memory_source_grants_target
 ON conversation_memory_source_grants(
   organization_id,workspace_id,target_conversation_id,visibility,status,expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_memory_source_grants_active_unique
 ON conversation_memory_source_grants(organization_id,workspace_id,owner_actor_id,
   source_message_id,visibility,target_conversation_id) WHERE status='active';
"""


class ConversationMemoryStore:
    """Navigator-owned SQLite authority for private conversation memory state."""

    def __init__(self, db_path: Path) -> None:
        """Initialize the isolated domain database without changing Work's legacy tables."""

        if not isinstance(db_path, Path) or not db_path.is_absolute():
            raise ValueError("conversation memory database path must be absolute")
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA)

    def overview(self, organization_id: str | None, workspace_id: str, actor_id: str) -> JsonObject:
        """Return bounded counts and the current workspace authorization epoch."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        with self._connect() as conn:
            epoch = _authorization_epoch(conn, org, workspace)
            counts = conn.execute(
                """SELECT
                   (SELECT count(*) FROM conversation_memory_messages
                     WHERE organization_id=? AND workspace_id=? AND actor_id=? AND status='active'),
                   (SELECT count(*) FROM conversation_memory_items
                     WHERE organization_id=? AND workspace_id=? AND actor_id=? AND state='active'),
                   (SELECT count(*) FROM conversation_memory_messages
                     WHERE organization_id=? AND workspace_id=? AND actor_id=?)""",
                (org, workspace, actor, org, workspace, actor, org, workspace, actor),
            ).fetchone()
        return {
            "authorizationEpoch": epoch,
            "counts": {
                "messages": int(counts[0]),
                "memories": int(counts[1]),
                "sources": int(counts[2]),
            },
        }

    def create_message(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        body: Mapping[str, Any],
    ) -> JsonObject:
        """Persist one host-recorded turn event with idempotent source lineage."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        event_id = _identifier(body.get("eventId"), "eventId")
        conversation_id = _identifier(body.get("conversationId"), "conversationId")
        conversation_kind = _choice(
            body.get("conversationKind"), "conversationKind", {"direct", "group", "channel"}
        )
        role = _choice(body.get("role"), "role", {"user", "assistant", "tool"})
        visibility = _choice(
            body.get("visibility", "private"),
            "visibility",
            {"private", "conversation", "workspace"},
        )
        content = _bounded_text(body.get("content"), "content", 100_000)
        persona_id = _optional_identifier(body.get("personaId"), "personaId")
        requested_occurred_at = _optional_time(body.get("occurredAt"))
        occurred_at = _unix_ms() if requested_occurred_at is None else requested_occurred_at
        source_refs = _normalize_source_refs(body.get("sourceRefs", []))
        attachments = _normalize_attachments(body.get("attachments", []))
        related_events = _string_list(
            body.get("relatedEventIds", []), "relatedEventIds", _MAX_RELATED_EVENTS
        )
        if role == "user" and source_refs:
            raise _invalid(
                "CONVERSATION_MEMORY_SOURCE_INVALID",
                "User messages cannot claim derived source references.",
            )
        if role != "assistant" and related_events:
            raise _invalid(
                "CONVERSATION_MEMORY_SOURCE_INVALID",
                "Only assistant messages can cite related turn events.",
            )
        now = _unix_ms()
        canonical = {
            "eventId": event_id,
            "conversationId": conversation_id,
            "conversationKind": conversation_kind,
            "personaId": persona_id,
            "visibility": visibility,
            "role": role,
            "content": content,
            "occurredAt": requested_occurred_at,
            "sourceRefs": source_refs,
            "attachments": attachments,
            "relatedEventIds": related_events,
        }
        digest = _digest(canonical)
        message_id = uuid4().hex
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            prior = conn.execute(
                """SELECT * FROM conversation_memory_messages WHERE organization_id=?
                   AND workspace_id=? AND actor_id=? AND event_id=?""",
                (org, workspace, actor, event_id),
            ).fetchone()
            if prior is not None:
                if str(prior["payload_digest"]) != digest:
                    raise _conflict(
                        "CONVERSATION_MEMORY_EVENT_CONFLICT",
                        "eventId already identifies different content.",
                    )
                return {"message": self._message_view(prior), "duplicate": True}
            source_ids = {source_id for ref in source_refs for source_id in ref["sourceMessageIds"]}
            memory_refs = [ref for ref in source_refs if ref["memoryId"] is not None]
            stored_source_refs = list(source_refs)
            for related_event in related_events:
                row = conn.execute(
                    """SELECT message_id,status FROM conversation_memory_messages
                       WHERE organization_id=? AND workspace_id=? AND actor_id=? AND event_id=?""",
                    (org, workspace, actor, related_event),
                ).fetchone()
                if row is None or str(row["status"]) != "active":
                    raise _invalid(
                        "CONVERSATION_MEMORY_SOURCE_INVALID",
                        "A related event is unavailable in this actor scope.",
                    )
                source_ids.add(str(row["message_id"]))
                related_id = str(row["message_id"])
                if not any(related_id in ref["sourceMessageIds"] for ref in stored_source_refs):
                    stored_source_refs.append(
                        {"memoryId": None, "memoryVersion": None, "sourceMessageIds": [related_id]}
                    )
            if (
                len(stored_source_refs) > _MAX_SOURCE_REFS
                or len(source_ids) > _MAX_SOURCE_REFS * _MAX_SOURCE_IDS_PER_REF
            ):
                raise _invalid(
                    "CONVERSATION_MEMORY_SOURCE_LIMIT",
                    "Derived source lineage exceeds its complete validation bound.",
                )
            self._validate_source_ids(
                conn,
                org,
                workspace,
                actor,
                conversation_id,
                conversation_kind,
                persona_id,
                source_ids,
            )
            for ref in memory_refs:
                self._validate_memory_reference(
                    conn,
                    org,
                    workspace,
                    actor,
                    conversation_id,
                    conversation_kind,
                    persona_id,
                    str(ref["memoryId"]),
                    int(ref["memoryVersion"]),
                )
            conn.execute(
                """INSERT INTO conversation_memory_messages(organization_id,workspace_id,actor_id,
                message_id,event_id,conversation_id,conversation_kind,persona_id,visibility,role,
                   content,source_refs_json,attachments_json,payload_digest,status,occurred_at,created_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)""",
                (
                    org,
                    workspace,
                    actor,
                    message_id,
                    event_id,
                    conversation_id,
                    conversation_kind,
                    persona_id,
                    visibility,
                    role,
                    content,
                    _json_text(stored_source_refs),
                    _json_text(attachments),
                    digest,
                    occurred_at,
                    now,
                ),
            )
            for source_id in sorted(source_ids):
                conn.execute(
                    """INSERT INTO conversation_memory_message_sources(organization_id,workspace_id,
                       actor_id,message_id,source_message_id) VALUES(?,?,?,?,?)""",
                    (org, workspace, actor, message_id, source_id),
                )
            for ref in memory_refs:
                conn.execute(
                    """INSERT INTO conversation_memory_message_memory_sources(organization_id,
                       workspace_id,actor_id,message_id,source_memory_id,source_memory_version)
                       VALUES(?,?,?,?,?,?)""",
                    (org, workspace, actor, message_id, ref["memoryId"], ref["memoryVersion"]),
                )
            row = conn.execute(
                """SELECT * FROM conversation_memory_messages WHERE organization_id=?
                   AND workspace_id=? AND actor_id=? AND message_id=?""",
                (org, workspace, actor, message_id),
            ).fetchone()
            return {"message": self._message_view(row), "duplicate": False}

    def list_messages(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str,
        *,
        conversation_kind: str,
        persona_id: str | None = None,
        order: str = "desc",
        limit: int = 50,
        cursor: str | None = None,
        include_revoked: bool = False,
    ) -> JsonObject:
        """Read one actor's bounded chronological conversation page."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        conversation = _identifier(conversation_id, "conversationId")
        kind = _choice(conversation_kind, "conversationKind", {"direct", "group", "channel"})
        persona = _optional_identifier(persona_id, "personaId")
        selected_order = _choice(order, "order", {"asc", "desc"})
        if type(limit) is not int or not 1 <= limit <= 100:
            raise _invalid("CONVERSATION_MEMORY_INVALID_PAGE", "limit must be between 1 and 100.")
        cursor_time, cursor_id = _decode_cursor(cursor)
        status_filter = "" if include_revoked else " AND status='active'"
        cursor_operator = "<" if selected_order == "desc" else ">"
        cursor_filter = (
            f" AND (created_at{cursor_operator}? OR "
            f"(created_at=? AND message_id{cursor_operator}?))"
            if cursor_time is not None
            else ""
        )
        params: list[Any] = [org, workspace, actor, conversation]
        persona_filter = ""
        if persona is not None:
            persona_filter = " AND (persona_id IS NULL OR persona_id=?)"
            params.append(persona)
        if cursor_time is not None:
            params.extend([cursor_time, cursor_time, cursor_id])
        params.append(limit + 1)
        with self._connect() as conn:
            rows = conn.execute(
                f"""SELECT * FROM conversation_memory_messages WHERE organization_id=?
                    AND workspace_id=? AND actor_id=? AND conversation_id=?{status_filter}
                    {persona_filter}{cursor_filter}
                    ORDER BY created_at {selected_order.upper()},
                    message_id {selected_order.upper()} LIMIT ?""",
                params,
            ).fetchall()
        has_more = len(rows) > limit
        visible = rows[:limit]
        next_cursor = (
            _encode_cursor(int(visible[-1]["created_at"]), str(visible[-1]["message_id"]))
            if has_more and visible
            else None
        )
        with self._connect() as conn:
            visible = [
                row
                for row in visible
                if include_revoked
                or self._message_lineage_accessible(
                    conn, org, workspace, actor, conversation, kind, persona, row
                )
            ]
        return {"items": [self._message_view(row) for row in visible], "nextCursor": next_cursor}

    def get_message(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str,
        message_id: str,
        *,
        conversation_kind: str,
        persona_id: str | None = None,
    ) -> JsonObject:
        """Read one exact current message only when its full source lineage is authorized."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        conversation = _identifier(conversation_id, "conversationId")
        message = _identifier(message_id, "messageId")
        kind = _choice(conversation_kind, "conversationKind", {"direct", "group", "channel"})
        persona = _optional_identifier(persona_id, "personaId")
        with self._connect() as conn:
            row = conn.execute(
                """SELECT * FROM conversation_memory_messages WHERE organization_id=?
                   AND workspace_id=? AND actor_id=? AND conversation_id=? AND message_id=?
                   AND status='active'""",
                (org, workspace, actor, conversation, message),
            ).fetchone()
            if row is None or not self._message_lineage_accessible(
                conn, org, workspace, actor, conversation, kind, persona, row
            ):
                raise _not_found(
                    "CONVERSATION_MEMORY_MESSAGE_NOT_FOUND",
                    "Message was not found in this authorized conversation scope.",
                )
            return {"message": self._message_view(row)}

    def create_memory(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        body: Mapping[str, Any],
    ) -> JsonObject:
        """Persist one evidence-backed memory and report pending external indexing honestly."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        idempotency_key = _identifier(body.get("idempotencyKey"), "idempotencyKey")
        conversation_id = _identifier(body.get("conversationId"), "conversationId")
        conversation_kind = _choice(
            body.get("conversationKind"),
            "conversationKind",
            {"direct", "group", "channel"},
        )
        persona_id = _optional_identifier(body.get("personaId"), "personaId")
        kind = _choice(body.get("kind"), "kind", {"fact", "preference", "commitment", "episode"})
        text = _bounded_text(body.get("text"), "text", 20_000)
        source_ids = set(
            _string_list(
                body.get("sourceMessageIds"),
                "sourceMessageIds",
                _MAX_SOURCE_REFS * _MAX_SOURCE_IDS_PER_REF,
                minimum=1,
            )
        )
        source_refs = _normalize_source_refs(body.get("sourceRefs", []))
        source_ids.update(source_id for ref in source_refs for source_id in ref["sourceMessageIds"])
        memory_refs = [ref for ref in source_refs if ref["memoryId"] is not None]
        if len(source_ids) > _MAX_SOURCE_REFS * _MAX_SOURCE_IDS_PER_REF:
            raise _invalid(
                "CONVERSATION_MEMORY_SOURCE_LIMIT",
                "Too many source message references were supplied.",
            )
        visibility = _choice(
            body.get("visibility", "private"),
            "visibility",
            {"private", "conversation", "workspace"},
        )
        valid_until = _optional_time(body.get("validUntil"))
        now = _unix_ms()
        canonical = {
            "idempotencyKey": idempotency_key,
            "conversationId": conversation_id,
            "conversationKind": conversation_kind,
            "personaId": persona_id,
            "kind": kind,
            "text": text,
            "sourceMessageIds": sorted(source_ids),
            "sourceRefs": source_refs,
            "visibility": visibility,
            "validUntil": valid_until,
        }
        digest = _digest(canonical)
        memory_id = uuid4().hex
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            prior = conn.execute(
                """SELECT * FROM conversation_memory_items WHERE organization_id=?
                   AND workspace_id=? AND actor_id=? AND idempotency_key=?""",
                (org, workspace, actor, idempotency_key),
            ).fetchone()
            if prior is not None:
                if str(prior["payload_digest"]) != digest:
                    raise _conflict(
                        "CONVERSATION_MEMORY_IDEMPOTENCY_CONFLICT",
                        "idempotencyKey already identifies different memory content.",
                    )
                return {"memory": self._memory_view(prior), "duplicate": True}
            self._validate_source_ids(
                conn,
                org,
                workspace,
                actor,
                conversation_id,
                conversation_kind,
                persona_id,
                source_ids,
            )
            for ref in memory_refs:
                self._validate_memory_reference(
                    conn,
                    org,
                    workspace,
                    actor,
                    conversation_id,
                    conversation_kind,
                    persona_id,
                    str(ref["memoryId"]),
                    int(ref["memoryVersion"]),
                )
            epoch = _authorization_epoch(conn, org, workspace)
            conn.execute(
                """INSERT INTO conversation_memory_items(organization_id,workspace_id,actor_id,
                   memory_id,idempotency_key,conversation_id,conversation_kind,persona_id,visibility,
                   memory_kind,text,source_message_ids_json,source_refs_json,payload_digest,version,
                   state,index_state,authorization_epoch,valid_until,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'active','pending',?,?,?,?)""",
                (
                    org,
                    workspace,
                    actor,
                    memory_id,
                    idempotency_key,
                    conversation_id,
                    conversation_kind,
                    persona_id,
                    visibility,
                    kind,
                    text,
                    _json_text(sorted(source_ids)),
                    _json_text(source_refs),
                    digest,
                    epoch,
                    valid_until,
                    now,
                    now,
                ),
            )
            for source_id in sorted(source_ids):
                conn.execute(
                    """INSERT INTO conversation_memory_item_sources(organization_id,workspace_id,
                       actor_id,memory_id,source_message_id) VALUES(?,?,?,?,?)""",
                    (org, workspace, actor, memory_id, source_id),
                )
            for ref in memory_refs:
                conn.execute(
                    """INSERT INTO conversation_memory_item_memory_sources(organization_id,
                       workspace_id,actor_id,memory_id,source_memory_id,source_memory_version)
                       VALUES(?,?,?,?,?,?)""",
                    (org, workspace, actor, memory_id, ref["memoryId"], ref["memoryVersion"]),
                )
            row = conn.execute(
                """SELECT * FROM conversation_memory_items WHERE organization_id=?
                   AND workspace_id=? AND actor_id=? AND memory_id=?""",
                (org, workspace, actor, memory_id),
            ).fetchone()
            return {"memory": self._memory_view(row), "duplicate": False}

    def list_memories(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str,
        *,
        conversation_kind: str,
        persona_id: str | None = None,
        state: str = "active",
        limit: int = 100,
    ) -> JsonObject:
        """List only the current actor's scoped, live memory records."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        conversation = _identifier(conversation_id, "conversationId")
        kind = _choice(conversation_kind, "conversationKind", {"direct", "group", "channel"})
        persona = _optional_identifier(persona_id, "personaId")
        state_value = _choice(state, "state", {"active", "invalidated", "deleted"})
        if type(limit) is not int or not 1 <= limit <= 500:
            raise _invalid("CONVERSATION_MEMORY_INVALID_PAGE", "limit must be between 1 and 500.")
        with self._connect() as conn:
            owner_ids = self._query_owner_ids(conn, org, workspace, actor, conversation)
            placeholders = ",".join("?" for _ in owner_ids)
            params: list[Any] = [org, workspace, *owner_ids, state_value]
            actor_filter = f"actor_id IN ({placeholders})"
            scope_filter = " AND (visibility!='conversation' OR conversation_id=?)"
            params.append(conversation)
        persona_filter = ""
        if persona is not None:
            persona_filter = " AND persona_id=?"
            params.append(persona)
        params.extend([_unix_ms(), min(5_000, max(limit * 10, limit))])
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT * FROM conversation_memory_items WHERE organization_id=?
                   AND workspace_id=?
                   AND """
                + actor_filter
                + " AND state=?"
                + scope_filter
                + persona_filter
                + " AND (valid_until IS NULL OR valid_until>?)"
                + " ORDER BY updated_at DESC,memory_id LIMIT ?",
                params,
            ).fetchall()
            visible = [
                self._memory_view(row)
                for row in rows
                if self._can_access_memory(
                    conn, org, workspace, actor, conversation, kind, persona, row
                )
            ]
        return {"items": visible[:limit]}

    def query_owners(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str,
    ) -> list[str]:
        """Return current actor and owners with source grants for this conversation."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        conversation = _identifier(conversation_id, "conversationId")
        with self._connect() as conn:
            return self._query_owner_ids(conn, org, workspace, actor, conversation)

    def query_provider_scopes(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str,
        *,
        conversation_kind: str,
        persona_id: str | None = None,
        limit: int = 100,
    ) -> list[tuple[str, str, str]]:
        """Return bounded source scopes that are currently authorized in one target chat."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        conversation = _identifier(conversation_id, "conversationId")
        kind = _choice(conversation_kind, "conversationKind", {"group", "channel"})
        persona = _optional_identifier(persona_id, "personaId")
        if type(limit) is not int or not 1 <= limit <= 100:
            raise _invalid(
                "CONVERSATION_MEMORY_INVALID_PAGE",
                "Provider scope limit must be between 1 and 100.",
            )
        with self._connect() as conn:
            owner_ids = self._query_owner_ids(conn, org, workspace, actor, conversation)
            owner_placeholders = ",".join("?" for _ in owner_ids)
            persona_filter = ""
            scope_params: list[Any] = [org, workspace, *owner_ids, _unix_ms()]
            if persona is not None:
                persona_filter = " AND (persona_id IS NULL OR persona_id=?)"
                scope_params.append(persona)
            scope_params.extend(
                [
                    conversation,
                    kind,
                    persona,
                    actor,
                    conversation,
                    kind,
                    org,
                    workspace,
                    _unix_ms(),
                    conversation,
                    limit + 1,
                ]
            )
            scope_rows = conn.execute(
                """SELECT DISTINCT memory.actor_id,memory.conversation_id,memory.conversation_kind
                   FROM conversation_memory_items AS memory WHERE memory.organization_id=?
                     AND memory.workspace_id=?
                     AND memory.actor_id IN ("""
                + owner_placeholders
                + ") AND memory.state='active' AND (memory.valid_until IS NULL "
                + "OR memory.valid_until>?)"
                + persona_filter
                + " AND ((memory.visibility='conversation' AND memory.conversation_id=? "
                + "AND memory.conversation_kind=?) OR (memory.visibility='workspace' AND EXISTS ("
                + "SELECT 1 FROM conversation_memory_item_sources AS lineage "
                + "JOIN conversation_memory_messages AS source ON "
                + "source.organization_id=lineage.organization_id AND "
                + "source.workspace_id=lineage.workspace_id AND "
                + "source.message_id=lineage.source_message_id "
                + "WHERE lineage.organization_id=memory.organization_id AND "
                + "lineage.workspace_id=memory.workspace_id AND lineage.actor_id=memory.actor_id "
                + "AND lineage.memory_id=memory.memory_id AND source.status='active' "
                + "AND (source.persona_id IS NULL OR source.persona_id=?) AND (("
                + "source.actor_id=? AND (source.visibility NOT IN ('private','conversation') OR "
                + "(source.visibility='conversation' AND source.conversation_id=? AND "
                + "source.conversation_kind=?))) OR EXISTS (SELECT 1 FROM "
                + "conversation_memory_source_grants AS grant_row WHERE "
                + "grant_row.organization_id=? AND grant_row.workspace_id=? AND "
                + "grant_row.owner_actor_id=source.actor_id AND "
                + "grant_row.source_message_id=source.message_id AND grant_row.status='active' "
                + "AND (grant_row.expires_at IS NULL OR grant_row.expires_at>?) AND "
                + "((grant_row.visibility='conversation' AND "
                + "grant_row.target_conversation_id=?) OR (grant_row.visibility='workspace' "
                + "AND grant_row.target_conversation_id='')))))))"
                + " ORDER BY memory.actor_id,memory.conversation_id,memory.conversation_kind "
                + "LIMIT ?",
                scope_params,
            ).fetchall()
            if len(scope_rows) > limit:
                raise PersistenceError(
                    "CONVERSATION_MEMORY_SCOPE_TOO_BROAD",
                    503,
                    "Too many source conversation scopes are authorized for this query.",
                    retryable=True,
                )
            result: list[tuple[str, str, str]] = []
            for scope_row in scope_rows:
                owner = str(scope_row["actor_id"])
                source_conversation = str(scope_row["conversation_id"])
                source_kind = str(scope_row["conversation_kind"])
                memory_cursor = conn.execute(
                    """SELECT * FROM conversation_memory_items WHERE organization_id=?
                       AND workspace_id=? AND actor_id=? AND conversation_id=?
                       AND conversation_kind=? AND state='active'
                       AND (valid_until IS NULL OR valid_until>?)""",
                    (org, workspace, owner, source_conversation, source_kind, _unix_ms()),
                )
                accessible = False
                while rows := memory_cursor.fetchmany(64):
                    if any(
                        self._can_access_memory(
                            conn, org, workspace, actor, conversation, kind, persona, memory
                        )
                        for memory in rows
                    ):
                        accessible = True
                        break
                if accessible:
                    result.append((owner, source_conversation, source_kind))
            return result

    def validate_source_message_ids(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str | None,
        conversation_kind: str | None,
        persona_id: str | None,
        source_message_ids: Sequence[str],
    ) -> None:
        """Fail closed unless every cited source matches the authenticated current scope."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        conversation = (
            "" if conversation_id is None else _identifier(conversation_id, "conversationId")
        )
        kind = (
            "direct"
            if conversation_kind is None
            else _choice(conversation_kind, "conversationKind", {"direct", "group", "channel"})
        )
        persona = _optional_identifier(persona_id, "personaId")
        ids = _string_list(
            list(source_message_ids),
            "sourceMessageIds",
            _MAX_SOURCE_REFS * _MAX_SOURCE_IDS_PER_REF,
        )
        with self._connect() as conn:
            if not all(
                self._can_access_source(
                    conn, org, workspace, actor, conversation, kind, persona, source_id
                )
                for source_id in ids
            ):
                raise PersistenceError(
                    "CONVERSATION_MEMORY_SOURCE_UNAUTHORIZED",
                    403,
                    "One or more cited sources are unavailable in the current actor scope.",
                )

    def query_candidates(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str,
        *,
        conversation_kind: str,
        persona_id: str | None = None,
        memory_ids: Sequence[str] = (),
    ) -> list[JsonObject]:
        """Resolve provider candidate IDs to active, provenance-checked records."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        conversation = _identifier(conversation_id, "conversationId")
        kind = _choice(conversation_kind, "conversationKind", {"direct", "group", "channel"})
        persona = _optional_identifier(persona_id, "personaId")
        ids = [_identifier(item, "memoryId") for item in memory_ids]
        if len(ids) > 100:
            raise _invalid(
                "CONVERSATION_MEMORY_INVALID_PAGE",
                "At most 100 provider candidates can be checked.",
            )
        if not ids:
            return []
        placeholders = ",".join("?" for _ in ids)
        params: list[Any] = [org, workspace]
        persona_filter = ""
        if persona is not None:
            persona_filter = " AND persona_id=?"
            params.append(persona)
        params.extend([*ids, _unix_ms()])
        with self._connect() as conn:
            rows = conn.execute(
                f"""SELECT * FROM conversation_memory_items WHERE organization_id=?
                    AND workspace_id=?
                    AND state='active'{persona_filter}
                    AND memory_id IN ({placeholders}) AND (valid_until IS NULL OR valid_until>?)""",
                params,
            ).fetchall()
            current_epoch = _authorization_epoch(conn, org, workspace)
            result: list[JsonObject] = []
            for row in rows:
                view = self._memory_view(row)
                if not self._can_access_memory(
                    conn, org, workspace, actor, conversation, kind, persona, row
                ):
                    continue
                if int(row["authorization_epoch"]) > current_epoch:
                    continue
                result.append(view)
            return result

    def update_memory(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        memory_id: str,
        body: Mapping[str, Any],
    ) -> JsonObject:
        """Correct memory text or expiry while invalidating old-version derivatives."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        identifier = _identifier(memory_id, "memoryId")
        changes: dict[str, Any] = {}
        if "text" in body:
            changes["text"] = _bounded_text(body.get("text"), "text", 20_000)
        if "validUntil" in body:
            changes["valid_until"] = _optional_time(body.get("validUntil"))
        if not changes:
            raise _invalid(
                "CONVERSATION_MEMORY_EMPTY_UPDATE",
                "At least one supported memory field is required.",
            )
        now = _unix_ms()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            prior = conn.execute(
                """SELECT * FROM conversation_memory_items WHERE organization_id=?
                   AND workspace_id=?
                   AND actor_id=? AND memory_id=? AND state='active'""",
                (org, workspace, actor, identifier),
            ).fetchone()
            if prior is None:
                raise _not_found(
                    "CONVERSATION_MEMORY_NOT_FOUND", "Memory was not found in this actor scope."
                )
            prior_version = int(prior["version"])
            expected_version = body.get("expectedVersion")
            if type(expected_version) is not int or expected_version < 1:
                raise _invalid(
                    "CONVERSATION_MEMORY_INVALID_VERSION",
                    "expectedVersion must be a positive integer.",
                )
            if expected_version != prior_version:
                raise _conflict(
                    "CONVERSATION_MEMORY_VERSION_CONFLICT",
                    "Memory changed since the supplied version was read.",
                )
            changed_messages, changed_memories = self._invalidate_version_dependents(
                conn, org, workspace, identifier, prior_version, now
            )
            version = prior_version + 1
            text = changes.get("text", str(prior["text"]))
            valid_until = changes.get("valid_until", prior["valid_until"])
            digest = _digest(
                {
                    "memoryId": identifier,
                    "version": version,
                    "text": text,
                    "validUntil": valid_until,
                }
            )
            epoch = self._bump_epoch(conn, org, workspace, now)
            conn.execute(
                """UPDATE conversation_memory_items SET text=?,valid_until=?,version=?,
                   payload_digest=?,
                   index_state='pending',authorization_epoch=?,updated_at=? WHERE organization_id=?
                   AND workspace_id=? AND actor_id=? AND memory_id=?""",
                (text, valid_until, version, digest, epoch, now, org, workspace, actor, identifier),
            )
            row = conn.execute(
                """SELECT * FROM conversation_memory_items WHERE organization_id=?
                   AND workspace_id=?
                   AND actor_id=? AND memory_id=?""",
                (org, workspace, actor, identifier),
            ).fetchone()
            return {
                "memory": self._memory_view(row),
                "invalidatedMessageIds": changed_messages,
                "invalidatedMemoryIds": changed_memories,
            }

    def set_index_state(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        memory_id: str,
        version: int,
        state: str,
    ) -> JsonObject:
        """Record the actual external index outcome for one exact memory version."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        identifier = _identifier(memory_id, "memoryId")
        index_state = _choice(state, "indexState", {"pending", "indexed", "unavailable", "failed"})
        if type(version) is not int or version < 1:
            raise _invalid(
                "CONVERSATION_MEMORY_INVALID_VERSION", "version must be a positive integer."
            )
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                """UPDATE conversation_memory_items SET index_state=?,updated_at=?
                   WHERE organization_id=? AND workspace_id=? AND actor_id=? AND memory_id=?
                   AND version=? AND state='active'""",
                (index_state, _unix_ms(), org, workspace, actor, identifier, version),
            )
            row = conn.execute(
                """SELECT * FROM conversation_memory_items WHERE organization_id=?
                   AND workspace_id=?
                   AND actor_id=? AND memory_id=?""",
                (org, workspace, actor, identifier),
            ).fetchone()
            if row is None:
                raise _not_found(
                    "CONVERSATION_MEMORY_NOT_FOUND", "Memory was not found in this actor scope."
                )
            if int(row["version"]) != version:
                raise _conflict(
                    "CONVERSATION_MEMORY_VERSION_CONFLICT",
                    "Memory changed while its provider index was updated.",
                )
            return self._memory_view(row)

    def delete_memory(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        memory_id: str,
        expected_version: int,
    ) -> JsonObject:
        """Tombstone one memory and cascade invalidation to all version-bound descendants."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        identifier = _identifier(memory_id, "memoryId")
        now = _unix_ms()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """SELECT version,state FROM conversation_memory_items WHERE organization_id=?
                   AND workspace_id=? AND actor_id=? AND memory_id=?""",
                (org, workspace, actor, identifier),
            ).fetchone()
            if row is None:
                raise _not_found(
                    "CONVERSATION_MEMORY_NOT_FOUND", "Memory was not found in this actor scope."
                )
            version = int(row["version"])
            if type(expected_version) is not int or expected_version < 1:
                raise _invalid(
                    "CONVERSATION_MEMORY_INVALID_VERSION",
                    "expectedVersion must be a positive integer.",
                )
            if expected_version != version:
                raise _conflict(
                    "CONVERSATION_MEMORY_VERSION_CONFLICT",
                    "Memory changed since the supplied version was read.",
                )
            if str(row["state"]) == "deleted":
                return {
                    "deleted": True,
                    "authorizationEpoch": _authorization_epoch(conn, org, workspace),
                    "invalidatedMessageIds": [],
                    "invalidatedMemoryIds": [],
                    "duplicate": True,
                }
            if str(row["state"]) != "active":
                raise _conflict(
                    "CONVERSATION_MEMORY_VERSION_CONFLICT",
                    "Invalidated memory cannot be deleted as the current active revision.",
                )
            changed_messages, changed_memories = self._invalidate_version_dependents(
                conn, org, workspace, identifier, version, now
            )
            epoch = self._bump_epoch(conn, org, workspace, now)
            conn.execute(
                """UPDATE conversation_memory_items SET state='deleted',index_state='pending',
                   authorization_epoch=?,updated_at=? WHERE organization_id=? AND workspace_id=?
                   AND actor_id=? AND memory_id=?""",
                (epoch, now, org, workspace, actor, identifier),
            )
            return {
                "deleted": True,
                "authorizationEpoch": epoch,
                "invalidatedMessageIds": changed_messages,
                "invalidatedMemoryIds": changed_memories,
                "duplicate": False,
            }

    def list_sources(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str,
        *,
        limit: int = 200,
    ) -> JsonObject:
        """List message source audit rows owned by this actor and conversation."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        conversation = _identifier(conversation_id, "conversationId")
        if type(limit) is not int or not 1 <= limit <= 500:
            raise _invalid("CONVERSATION_MEMORY_INVALID_PAGE", "limit must be between 1 and 500.")
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT * FROM conversation_memory_messages WHERE organization_id=?
                   AND workspace_id=? AND actor_id=? AND conversation_id=?
                   ORDER BY created_at DESC,message_id LIMIT ?""",
                (org, workspace, actor, conversation, limit),
            ).fetchall()
            epoch = _authorization_epoch(conn, org, workspace)
            grants_by_source: dict[str, list[JsonObject]] = {}
            for row in rows:
                grants = conn.execute(
                    """SELECT * FROM conversation_memory_source_grants WHERE organization_id=?
                       AND workspace_id=? AND owner_actor_id=? AND source_message_id=?
                       ORDER BY created_at,grant_id""",
                    (org, workspace, actor, str(row["message_id"])),
                ).fetchall()
                grants_by_source[str(row["message_id"])] = [
                    self._grant_view(item) for item in grants
                ]
        return {
            "items": [
                self._source_view(row, epoch, grants_by_source[str(row["message_id"])])
                for row in rows
            ]
        }

    def grant_source(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        source_id: str,
        body: Mapping[str, Any],
    ) -> JsonObject:
        """Create one explicit owner-approved source grant."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        source = _identifier(source_id, "sourceId")
        visibility = _choice(body.get("visibility"), "visibility", {"conversation", "workspace"})
        target = body.get("targetConversationId")
        if visibility == "conversation":
            target_conversation = _identifier(target, "targetConversationId")
        else:
            if target is not None:
                raise _invalid(
                    "CONVERSATION_MEMORY_GRANT_INVALID",
                    "Workspace grants cannot include targetConversationId.",
                )
            target_conversation = ""
        expires_at = _optional_time(body.get("expiresAt"))
        now = _unix_ms()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            source_row = conn.execute(
                """SELECT status FROM conversation_memory_messages WHERE organization_id=?
                   AND workspace_id=? AND actor_id=? AND message_id=?""",
                (org, workspace, actor, source),
            ).fetchone()
            if source_row is None or str(source_row["status"]) != "active":
                raise _not_found(
                    "CONVERSATION_MEMORY_SOURCE_NOT_FOUND",
                    "Source was not found in this actor scope.",
                )
            existing = conn.execute(
                """SELECT * FROM conversation_memory_source_grants WHERE organization_id=?
                   AND workspace_id=? AND owner_actor_id=? AND source_message_id=?
                   AND visibility=? AND target_conversation_id=? AND status='active'""",
                (org, workspace, actor, source, visibility, target_conversation),
            ).fetchone()
            if existing is not None:
                existing_expiry = existing["expires_at"]
                if existing_expiry is not None and int(existing_expiry) <= now:
                    conn.execute(
                        """UPDATE conversation_memory_source_grants SET status='revoked',
                           revoked_at=? WHERE organization_id=? AND workspace_id=?
                           AND owner_actor_id=? AND grant_id=?""",
                        (now, org, workspace, actor, str(existing["grant_id"])),
                    )
                    existing = None
            if existing is not None:
                if existing["expires_at"] != expires_at:
                    raise _conflict(
                        "CONVERSATION_MEMORY_GRANT_CONFLICT",
                        "An active grant already exists with a different expiry.",
                    )
                epoch = _authorization_epoch(conn, org, workspace)
                return {
                    "grant": self._grant_view(existing),
                    "authorizationEpoch": epoch,
                    "duplicate": True,
                }
            grant_id = uuid4().hex
            conn.execute(
                """INSERT INTO conversation_memory_source_grants(organization_id,workspace_id,
                   owner_actor_id,grant_id,source_message_id,visibility,target_conversation_id,
                   expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,?, 'active',?)""",
                (
                    org,
                    workspace,
                    actor,
                    grant_id,
                    source,
                    visibility,
                    target_conversation,
                    expires_at,
                    now,
                ),
            )
            epoch = self._bump_epoch(conn, org, workspace, now)
            row = conn.execute(
                """SELECT * FROM conversation_memory_source_grants WHERE organization_id=?
                   AND workspace_id=? AND owner_actor_id=? AND grant_id=?""",
                (org, workspace, actor, grant_id),
            ).fetchone()
            return {"grant": self._grant_view(row), "authorizationEpoch": epoch, "duplicate": False}

    def revoke_source_grant(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        source_id: str,
        grant_id: str,
    ) -> JsonObject:
        """Revoke an owner-managed grant idempotently and advance the authorization epoch."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        source = _identifier(source_id, "sourceId")
        grant = _identifier(grant_id, "grantId")
        now = _unix_ms()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """SELECT status FROM conversation_memory_source_grants
                   WHERE organization_id=? AND workspace_id=? AND owner_actor_id=?
                   AND source_message_id=? AND grant_id=?""",
                (org, workspace, actor, source, grant),
            ).fetchone()
            if row is None:
                raise _not_found(
                    "CONVERSATION_MEMORY_GRANT_NOT_FOUND",
                    "Grant was not found in this actor scope.",
                )
            if str(row["status"]) == "revoked":
                return {
                    "revoked": True,
                    "authorizationEpoch": _authorization_epoch(conn, org, workspace),
                }
            conn.execute(
                """UPDATE conversation_memory_source_grants SET status='revoked',revoked_at=?
                   WHERE organization_id=? AND workspace_id=? AND owner_actor_id=?
                   AND source_message_id=? AND grant_id=?""",
                (now, org, workspace, actor, source, grant),
            )
            epoch = self._bump_epoch(conn, org, workspace, now)
            return {"revoked": True, "authorizationEpoch": epoch}

    def revoke_source(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        source_id: str,
    ) -> JsonObject:
        """Revoke one owned source and recursively invalidate its derived content."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        identifier = _identifier(source_id, "sourceId")
        now = _unix_ms()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """SELECT status FROM conversation_memory_messages WHERE organization_id=?
                   AND workspace_id=? AND actor_id=? AND message_id=?""",
                (org, workspace, actor, identifier),
            ).fetchone()
            if row is None:
                raise _not_found(
                    "CONVERSATION_MEMORY_SOURCE_NOT_FOUND",
                    "Source was not found in this actor scope.",
                )
            if str(row["status"]) == "revoked":
                epoch = _authorization_epoch(conn, org, workspace)
                return {
                    "sourceId": identifier,
                    "authorizationEpoch": epoch,
                    "invalidatedCount": 0,
                    "invalidatedMessageIds": [],
                    "invalidatedMemoryIds": [],
                }
            message_ids, memory_ids = self._invalidate_source_dependents(
                conn, org, workspace, identifier, now
            )
            epoch = self._bump_epoch(conn, org, workspace, now)
            conn.execute(
                """UPDATE conversation_memory_source_grants SET status='revoked',revoked_at=?
                   WHERE organization_id=? AND workspace_id=? AND source_message_id=?
                     AND status='active'""",
                (now, org, workspace, identifier),
            )
            conn.execute(
                """UPDATE conversation_memory_messages SET status='revoked',revoked_at=?
                   WHERE organization_id=? AND workspace_id=? AND message_id=?""",
                (now, org, workspace, identifier),
            )
            conn.execute(
                """UPDATE conversation_memory_messages SET status='revoked',revoked_at=?
                   WHERE organization_id=? AND workspace_id=? AND message_id IN
                    (SELECT message_id FROM conversation_memory_message_sources
                     WHERE organization_id=?
                    AND workspace_id=? AND source_message_id=?)""",
                (now, org, workspace, org, workspace, identifier),
            )
            conn.execute(
                """UPDATE conversation_memory_items SET state='invalidated',index_state='pending',
                   authorization_epoch=?,updated_at=? WHERE organization_id=? AND workspace_id=?
                   AND memory_id IN (SELECT memory_id FROM conversation_memory_item_sources
                   WHERE organization_id=? AND workspace_id=? AND source_message_id=?)""",
                (epoch, now, org, workspace, org, workspace, identifier),
            )
            return {
                "sourceId": identifier,
                "authorizationEpoch": epoch,
                "invalidatedCount": len(message_ids) + len(memory_ids),
                "invalidatedMessageIds": message_ids,
                "invalidatedMemoryIds": memory_ids,
            }

    def authorize_sources(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str,
        authorization_epoch: int,
        source_refs: Sequence[Mapping[str, Any]],
        *,
        conversation_kind: str,
        persona_id: str | None,
    ) -> JsonObject:
        """Recheck every source and memory version immediately before use or delivery."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        conversation = _identifier(conversation_id, "conversationId")
        kind = _choice(conversation_kind, "conversationKind", {"direct", "group", "channel"})
        persona = _optional_identifier(persona_id, "personaId")
        if type(authorization_epoch) is not int or authorization_epoch < 0:
            raise _invalid(
                "CONVERSATION_MEMORY_INVALID_EPOCH",
                "authorizationEpoch must be a non-negative integer.",
            )
        normalized = _normalize_source_refs(source_refs)
        if len(normalized) > _MAX_SOURCE_REFS:
            raise _invalid(
                "CONVERSATION_MEMORY_SOURCE_LIMIT", "Too many source references were supplied."
            )
        denied: set[str] = set()
        with self._connect() as conn:
            current_epoch = _authorization_epoch(conn, org, workspace)
            if current_epoch != authorization_epoch:
                denied.update(
                    source_id for ref in normalized for source_id in ref["sourceMessageIds"]
                )
                denied.update(
                    str(ref["memoryId"]) for ref in normalized if ref["memoryId"] is not None
                )
                return {
                    "allowed": False,
                    "currentAuthorizationEpoch": current_epoch,
                    "deniedSourceIds": sorted(denied),
                }
            for ref in normalized:
                for source_id in ref["sourceMessageIds"]:
                    if not self._can_access_source(
                        conn, org, workspace, actor, conversation, kind, persona, source_id
                    ):
                        denied.add(source_id)
                memory_id = ref["memoryId"]
                if memory_id is not None:
                    memory = conn.execute(
                        """SELECT * FROM conversation_memory_items WHERE organization_id=?
                           AND workspace_id=? AND memory_id=?""",
                        (org, workspace, memory_id),
                    ).fetchone()
                    if (
                        memory is None
                        or str(memory["state"]) != "active"
                        or int(memory["version"]) != int(ref["memoryVersion"])
                        or not self._can_access_memory(
                            conn, org, workspace, actor, conversation, kind, persona, memory
                        )
                    ):
                        denied.add(memory_id)
                    else:
                        memory_sources = set(json.loads(str(memory["source_message_ids_json"])))
                        if any(
                            source_id not in memory_sources for source_id in ref["sourceMessageIds"]
                        ):
                            denied.add(memory_id)
            return {
                "allowed": not denied,
                "currentAuthorizationEpoch": current_epoch,
                "deniedSourceIds": sorted(denied),
            }

    def authorize_artifact(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        artifact_id: str,
        conversation_id: str,
        conversation_kind: str,
        persona_id: str | None,
        authorization_epoch: int,
        source_refs: Sequence[Mapping[str, Any]],
    ) -> JsonObject:
        """Authorize an opaque attachment only through currently usable message sources."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        artifact = _identifier(artifact_id, "artifactId")
        if not re.fullmatch(r"[0-9a-f]{64}", artifact):
            raise _invalid(
                "CONVERSATION_MEMORY_ARTIFACT_INVALID", "artifactId must be a SHA-256 id."
            )
        conversation = _identifier(conversation_id, "conversationId")
        kind = _choice(conversation_kind, "conversationKind", {"direct", "group", "channel"})
        persona = _optional_identifier(persona_id, "personaId")
        if type(authorization_epoch) is not int or authorization_epoch < 0:
            raise _invalid(
                "CONVERSATION_MEMORY_INVALID_EPOCH", "authorizationEpoch must be non-negative."
            )
        refs = _normalize_source_refs(source_refs)
        with self._connect() as conn:
            current_epoch = _authorization_epoch(conn, org, workspace)
            if current_epoch != authorization_epoch:
                return {
                    "allowed": False,
                    "currentAuthorizationEpoch": current_epoch,
                    "artifact": None,
                }
            authorized_sources: set[str] = set()
            for ref in refs:
                for source_id in ref["sourceMessageIds"]:
                    if self._can_access_source(
                        conn, org, workspace, actor, conversation, kind, persona, source_id
                    ):
                        authorized_sources.add(source_id)
                    else:
                        return {
                            "allowed": False,
                            "currentAuthorizationEpoch": current_epoch,
                            "artifact": None,
                        }
                memory_id = ref["memoryId"]
                if memory_id is not None:
                    memory = conn.execute(
                        """SELECT * FROM conversation_memory_items WHERE organization_id=?
                           AND workspace_id=? AND memory_id=?""",
                        (org, workspace, memory_id),
                    ).fetchone()
                    if (
                        memory is None
                        or int(memory["version"]) != int(ref["memoryVersion"])
                        or not self._can_access_memory(
                            conn, org, workspace, actor, conversation, kind, persona, memory
                        )
                    ):
                        return {
                            "allowed": False,
                            "currentAuthorizationEpoch": current_epoch,
                            "artifact": None,
                        }
                    authorized_sources.update(
                        str(item) for item in json.loads(str(memory["source_message_ids_json"]))
                    )
            if not authorized_sources:
                return {
                    "allowed": False,
                    "currentAuthorizationEpoch": current_epoch,
                    "artifact": None,
                }
            placeholders = ",".join("?" for _ in authorized_sources)
            rows = conn.execute(
                f"""SELECT attachments_json FROM conversation_memory_messages
                    WHERE organization_id=? AND workspace_id=?
                      AND message_id IN ({placeholders})""",
                (org, workspace, *sorted(authorized_sources)),
            ).fetchall()
            for row in rows:
                attachments = json.loads(str(row["attachments_json"]))
                for metadata in attachments:
                    if metadata["artifactId"] == artifact:
                        return {
                            "allowed": True,
                            "currentAuthorizationEpoch": current_epoch,
                            "artifact": metadata,
                        }
            return {"allowed": False, "currentAuthorizationEpoch": current_epoch, "artifact": None}

    def export_actor_backup(
        self, organization_id: str | None, workspace_id: str, actor_id: str
    ) -> bytes:
        """Export one actor's P2 records as bounded JSON without raw scope identities."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        table_scopes = (
            ("conversation_memory_messages", "actor_id"),
            ("conversation_memory_message_sources", "actor_id"),
            ("conversation_memory_message_memory_sources", "actor_id"),
            ("conversation_memory_items", "actor_id"),
            ("conversation_memory_item_sources", "actor_id"),
            ("conversation_memory_item_memory_sources", "actor_id"),
            ("conversation_memory_source_grants", "owner_actor_id"),
        )
        output = io.BytesIO()
        scope_digest = hashlib.sha256(
            _json_text({"organizationId": org, "workspaceId": workspace, "actorId": actor}).encode()
        ).hexdigest()
        header = _json_text(
            {"schemaVersion": 1, "createdAt": _unix_ms(), "scopeDigest": scope_digest}
        )
        output.write((header[:-1] + ',"records":{').encode("utf-8"))
        with self._connect() as conn:
            conn.execute("BEGIN")
            for index, (table, actor_column) in enumerate(table_scopes):
                columns = [
                    str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
                ]
                query = (
                    f"SELECT * FROM {table} WHERE organization_id=? AND workspace_id=? "
                    f"AND {actor_column}=? ORDER BY rowid"
                )
                cursor = conn.execute(query, (org, workspace, actor))
                output.write(
                    ("," if index else "").encode("utf-8") + _json_text(table).encode("utf-8")
                )
                output.write(b":[")
                first = True
                while rows := cursor.fetchmany(100):
                    for row in rows:
                        record = {
                            column: row[column]
                            for column in columns
                            if column
                            not in {"organization_id", "workspace_id", "actor_id", "owner_actor_id"}
                        }
                        if not first:
                            output.write(b",")
                        output.write(_json_text(record).encode("utf-8"))
                        first = False
                        if output.tell() > 10_000_000:
                            raise PersistenceError(
                                "CONVERSATION_MEMORY_BACKUP_TOO_LARGE",
                                413,
                                "Actor conversation memory backup exceeds 10 MB.",
                            )
                output.write(b"]")
            output.write(b"}}")
        payload = output.getvalue()
        if len(payload) > 10_000_000:
            raise PersistenceError(
                "CONVERSATION_MEMORY_BACKUP_TOO_LARGE",
                413,
                "Actor conversation memory backup exceeds 10 MB.",
            )
        return payload

    def get_memory_for_index(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        memory_id: str,
    ) -> JsonObject:
        """Read the current active memory required by the injected provider adapter."""

        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        identifier = _identifier(memory_id, "memoryId")
        with self._connect() as conn:
            row = conn.execute(
                """SELECT * FROM conversation_memory_items WHERE organization_id=?
                   AND workspace_id=?
                   AND actor_id=? AND memory_id=? AND state='active'""",
                (org, workspace, actor, identifier),
            ).fetchone()
            if row is None:
                raise _not_found(
                    "CONVERSATION_MEMORY_NOT_FOUND", "Memory was not found in this actor scope."
                )
            return self._memory_view(row)

    def get_memory(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        memory_id: str,
        *,
        include_deleted: bool = False,
    ) -> JsonObject | None:
        """Read one actor-scoped memory, optionally including its tombstone state.

        Migration recovery may verify a rollback using the same canonical store
        view. Tombstones remain hidden by default and are never read across actor
        scope. 迁移恢复通过权威存储读取 tombstone；默认视图仍只返回 active。
        """

        if type(include_deleted) is not bool:
            raise _invalid(
                "CONVERSATION_MEMORY_INVALID_TOMBSTONE_READ",
                "include_deleted must be a boolean.",
            )
        org, workspace, actor = _scope(organization_id, workspace_id, actor_id)
        identifier = _identifier(memory_id, "memoryId")
        with self._connect() as conn:
            if include_deleted:
                row = conn.execute(
                    """SELECT * FROM conversation_memory_items WHERE organization_id=?
                       AND workspace_id=? AND actor_id=? AND memory_id=?""",
                    (org, workspace, actor, identifier),
                ).fetchone()
            else:
                row = conn.execute(
                    """SELECT * FROM conversation_memory_items WHERE organization_id=?
                       AND workspace_id=? AND actor_id=? AND memory_id=? AND state='active'""",
                    (org, workspace, actor, identifier),
                ).fetchone()
        return None if row is None else self._memory_view(row)

    def _validate_source_ids(
        self,
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        actor: str,
        conversation: str,
        conversation_kind: str,
        persona_id: str | None,
        source_ids: set[str],
    ) -> None:
        for source_id in source_ids:
            if not self._can_access_source(
                conn,
                org,
                workspace,
                actor,
                conversation,
                conversation_kind,
                persona_id,
                source_id,
            ):
                raise _invalid(
                    "CONVERSATION_MEMORY_SOURCE_INVALID",
                    "A source message is unavailable in this actor and conversation scope.",
                )

    def _validate_memory_reference(
        self,
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        actor: str,
        conversation: str,
        conversation_kind: str,
        persona_id: str | None,
        memory_id: str,
        version: int,
    ) -> None:
        row = conn.execute(
            """SELECT * FROM conversation_memory_items WHERE organization_id=?
               AND workspace_id=? AND memory_id=?""",
            (org, workspace, memory_id),
        ).fetchone()
        if (
            row is None
            or str(row["state"]) != "active"
            or int(row["version"]) != version
            or not self._can_access_memory(
                conn, org, workspace, actor, conversation, conversation_kind, persona_id, row
            )
        ):
            raise _invalid(
                "CONVERSATION_MEMORY_SOURCE_INVALID",
                "A cited memory is unavailable or has changed version.",
            )

    def _all_sources_active(
        self,
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        actor: str,
        conversation: str,
        source_ids: Sequence[str],
    ) -> bool:
        return all(
            self._can_access_source(
                conn, org, workspace, actor, conversation, "direct", None, source_id
            )
            for source_id in source_ids
        )

    def _can_access_source(
        self,
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        actor: str,
        conversation: str,
        conversation_kind: str,
        persona_id: str | None,
        source_id: str,
    ) -> bool:
        """Apply source owner, conversation scope, grant, expiry, and revocation checks."""

        row = conn.execute(
            """SELECT actor_id,conversation_id,conversation_kind,persona_id,visibility,status
               FROM conversation_memory_messages
               WHERE organization_id=? AND workspace_id=? AND message_id=?""",
            (org, workspace, source_id),
        ).fetchone()
        if row is None or str(row["status"]) != "active":
            return False
        source_persona = row["persona_id"]
        # An explicit persona read stays inside that persona. An owner read without a persona
        # is the host-bound conversation scope, which must still return its own messages.
        if persona_id is not None and source_persona is not None and source_persona != persona_id:
            return False
        owner = str(row["actor_id"])
        if owner == actor:
            visibility = str(row["visibility"])
            if (visibility == "private" and conversation_kind != "direct") or (
                visibility == "conversation"
                and (
                    str(row["conversation_id"]) != conversation
                    or str(row["conversation_kind"]) != conversation_kind
                )
            ):
                grant_required = True
            else:
                return True
        else:
            grant_required = True
        if grant_required:
            grant = conn.execute(
                """SELECT grant_id FROM conversation_memory_source_grants WHERE organization_id=?
                   AND workspace_id=? AND owner_actor_id=? AND source_message_id=?
                   AND status='active'
                   AND (expires_at IS NULL OR expires_at>?) AND
                   ((visibility='conversation' AND target_conversation_id=?) OR
                    (visibility='workspace' AND target_conversation_id='')) LIMIT 1""",
                (org, workspace, owner, source_id, _unix_ms(), conversation),
            ).fetchone()
            return grant is not None
        return False

    def _can_access_memory(
        self,
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        requester_actor: str,
        conversation: str,
        conversation_kind: str,
        persona_id: str | None,
        row: sqlite3.Row | None,
        visited: set[str] | None = None,
    ) -> bool:
        """Verify memory visibility, freshness, source grants, and parent revisions."""

        if row is None or str(row["state"]) != "active":
            return False
        valid_until = row["valid_until"]
        if valid_until is not None and int(valid_until) <= _unix_ms():
            return False
        memory_id = str(row["memory_id"])
        seen = set() if visited is None else visited
        if memory_id in seen or len(seen) >= 32:
            return False
        seen.add(memory_id)
        owner = str(row["actor_id"])
        visibility = str(row["visibility"])
        if visibility == "conversation" and (
            str(row["conversation_id"]) != conversation
            or str(row["conversation_kind"]) != conversation_kind
        ):
            return False
        if visibility == "private" and owner == requester_actor and conversation_kind != "direct":
            return False
        if owner != requester_actor and visibility == "private":
            return False
        memory_persona = row["persona_id"]
        # Same rule as message lineage: only an explicit persona narrows the read scope.
        if persona_id is not None and memory_persona is not None and memory_persona != persona_id:
            return False
        source_ids = json.loads(str(row["source_message_ids_json"]))
        if not all(
            self._can_access_source(
                conn,
                org,
                workspace,
                requester_actor,
                conversation,
                conversation_kind,
                persona_id,
                str(source_id),
            )
            for source_id in source_ids
        ):
            return False
        parents = conn.execute(
            """SELECT source_memory_id,source_memory_version
               FROM conversation_memory_item_memory_sources
               WHERE organization_id=? AND workspace_id=? AND memory_id=?""",
            (org, workspace, memory_id),
        ).fetchall()
        for parent in parents:
            parent_row = conn.execute(
                """SELECT * FROM conversation_memory_items WHERE organization_id=?
                   AND workspace_id=?
                   AND memory_id=? AND version=?""",
                (
                    org,
                    workspace,
                    str(parent["source_memory_id"]),
                    int(parent["source_memory_version"]),
                ),
            ).fetchone()
            if not self._can_access_memory(
                conn,
                org,
                workspace,
                requester_actor,
                conversation,
                conversation_kind,
                persona_id,
                parent_row,
                seen.copy(),
            ):
                return False
        return True

    def _message_lineage_accessible(
        self,
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        actor: str,
        conversation: str,
        conversation_kind: str,
        persona_id: str | None,
        row: sqlite3.Row,
    ) -> bool:
        """Hide messages whose source or parent memory is no longer authorized."""

        if not self._can_access_source(
            conn,
            org,
            workspace,
            actor,
            conversation,
            conversation_kind,
            persona_id,
            str(row["message_id"]),
        ):
            return False
        references = json.loads(str(row["source_refs_json"]))
        for reference in references:
            for source_id in reference["sourceMessageIds"]:
                if not self._can_access_source(
                    conn,
                    org,
                    workspace,
                    actor,
                    conversation,
                    conversation_kind,
                    persona_id,
                    str(source_id),
                ):
                    return False
            memory_id = reference["memoryId"]
            if memory_id is None:
                continue
            memory = conn.execute(
                """SELECT * FROM conversation_memory_items WHERE organization_id=?
                   AND workspace_id=? AND memory_id=? AND version=?""",
                (org, workspace, str(memory_id), int(reference["memoryVersion"])),
            ).fetchone()
            if not self._can_access_memory(
                conn, org, workspace, actor, conversation, conversation_kind, persona_id, memory
            ):
                return False
        return True

    @staticmethod
    def _query_owner_ids(
        conn: sqlite3.Connection, org: str, workspace: str, actor: str, conversation: str
    ) -> list[str]:
        """Bound provider fan-out to current actor and explicitly granted source owners."""

        rows = conn.execute(
            """SELECT DISTINCT owner_actor_id FROM conversation_memory_source_grants
               WHERE organization_id=? AND workspace_id=? AND status='active'
               AND (expires_at IS NULL OR expires_at>?)
               AND ((visibility='conversation' AND target_conversation_id=?)
                    OR (visibility='workspace' AND target_conversation_id=''))
               ORDER BY owner_actor_id LIMIT 101""",
            (org, workspace, _unix_ms(), conversation),
        ).fetchall()
        owners = {actor, *(str(row[0]) for row in rows)}
        if len(owners) > 100:
            raise PersistenceError(
                "CONVERSATION_MEMORY_SCOPE_TOO_BROAD",
                503,
                "Too many source owners are authorized for this conversation.",
                retryable=True,
            )
        return sorted(owners)

    def _invalidate_source_dependents(
        self, conn: sqlite3.Connection, org: str, workspace: str, source_id: str, now: int
    ) -> tuple[list[str], list[str]]:
        visited_sources: set[str] = set()
        pending_sources: set[str] = {source_id}
        message_ids: set[str] = set()
        memory_ids: set[str] = set()
        while pending_sources:
            current_sources = pending_sources - visited_sources
            if not current_sources:
                break
            visited_sources.update(current_sources)
            placeholders = ",".join("?" for _ in current_sources)
            found_messages = conn.execute(
                f"""SELECT DISTINCT message_id FROM conversation_memory_message_sources
                    WHERE organization_id=? AND workspace_id=?
                      AND source_message_id IN ({placeholders})""",
                (org, workspace, *sorted(current_sources)),
            ).fetchall()
            new_messages = {str(row[0]) for row in found_messages} - message_ids - visited_sources
            found_memories = conn.execute(
                f"""SELECT DISTINCT memory_id FROM conversation_memory_item_sources
                    WHERE organization_id=? AND workspace_id=?
                      AND source_message_id IN ({placeholders})""",
                (org, workspace, *sorted(current_sources)),
            ).fetchall()
            new_memories = {str(row[0]) for row in found_memories} - memory_ids
            if new_memories:
                mem_placeholders = ",".join("?" for _ in new_memories)
                memory_refs = conn.execute(
                    f"""SELECT DISTINCT message_id
                        FROM conversation_memory_message_memory_sources
                        WHERE organization_id=? AND workspace_id=?
                          AND source_memory_id IN ({mem_placeholders})""",
                    (org, workspace, *sorted(new_memories)),
                ).fetchall()
                unseen_refs = {str(row[0]) for row in memory_refs} - message_ids - visited_sources
                new_messages.update(unseen_refs)
                memory_dependents = conn.execute(
                    f"""SELECT DISTINCT i.memory_id
                        FROM conversation_memory_item_memory_sources s
                        JOIN conversation_memory_items i ON i.organization_id=s.organization_id
                         AND i.workspace_id=s.workspace_id AND i.actor_id=s.actor_id
                         AND i.memory_id=s.memory_id
                        WHERE s.organization_id=? AND s.workspace_id=?
                          AND s.source_memory_id IN ({mem_placeholders})""",
                    (org, workspace, *sorted(new_memories)),
                ).fetchall()
                new_memories.update({str(row[0]) for row in memory_dependents} - memory_ids)

            message_ids.update(new_messages)
            memory_ids.update(new_memories)
            pending_sources = new_messages
        if message_ids:
            placeholders = ",".join("?" for _ in message_ids)
            conn.execute(
                f"""UPDATE conversation_memory_messages SET status='revoked',revoked_at=?
                    WHERE organization_id=? AND workspace_id=?
                      AND message_id IN ({placeholders})""",
                (now, org, workspace, *sorted(message_ids)),
            )
        if memory_ids:
            placeholders = ",".join("?" for _ in memory_ids)
            conn.execute(
                f"""UPDATE conversation_memory_items SET state='invalidated',index_state='pending',
                    updated_at=? WHERE organization_id=? AND workspace_id=?
                      AND memory_id IN ({placeholders})""",
                (now, org, workspace, *sorted(memory_ids)),
            )
        return sorted(message_ids), sorted(memory_ids)

    def _invalidate_version_dependents(
        self,
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        memory_id: str,
        version: int,
        now: int,
    ) -> tuple[list[str], list[str]]:
        affected = {(memory_id, version)}
        message_ids: set[str] = set()
        memory_ids: set[str] = set()
        while affected:
            current_ids = {item[0] for item in affected}
            placeholders = ",".join("?" for _ in current_ids)
            dependent_messages = conn.execute(
                f"""SELECT DISTINCT message_id FROM conversation_memory_message_memory_sources
                    WHERE organization_id=? AND workspace_id=?
                      AND source_memory_id IN ({placeholders})""",
                (org, workspace, *sorted(current_ids)),
            ).fetchall()
            new_messages = {str(row[0]) for row in dependent_messages} - message_ids
            dependent_memories = conn.execute(
                f"""SELECT DISTINCT memory_id,source_memory_version
                    FROM conversation_memory_item_memory_sources
                    WHERE organization_id=? AND workspace_id=?
                      AND source_memory_id IN ({placeholders})""",
                (org, workspace, *sorted(current_ids)),
            ).fetchall()
            new_memories = {str(row[0]) for row in dependent_memories} - memory_ids
            message_ids.update(new_messages)
            memory_ids.update(new_memories)
            affected = {
                (str(row[0]), int(row[1]))
                for row in dependent_memories
                if str(row[0]) in new_memories
            }
        if message_ids:
            placeholders = ",".join("?" for _ in message_ids)
            conn.execute(
                f"""UPDATE conversation_memory_messages SET status='revoked',revoked_at=?
                    WHERE organization_id=? AND workspace_id=?
                      AND message_id IN ({placeholders})""",
                (now, org, workspace, *sorted(message_ids)),
            )
        if memory_ids:
            placeholders = ",".join("?" for _ in memory_ids)
            conn.execute(
                f"""UPDATE conversation_memory_items SET state='invalidated',index_state='pending',
                    updated_at=? WHERE organization_id=? AND workspace_id=?
                      AND memory_id IN ({placeholders})""",
                (now, org, workspace, *sorted(memory_ids)),
            )
        return sorted(message_ids), sorted(memory_ids)

    def _bump_epoch(self, conn: sqlite3.Connection, org: str, workspace: str, now: int) -> int:
        current = _authorization_epoch(conn, org, workspace)
        next_epoch = current + 1
        conn.execute(
            """INSERT INTO conversation_memory_epochs(
                   organization_id,workspace_id,authorization_epoch,updated_at)
               VALUES(?,?,?,?) ON CONFLICT(organization_id,workspace_id) DO UPDATE SET
               authorization_epoch=excluded.authorization_epoch,updated_at=excluded.updated_at""",
            (org, workspace, next_epoch, now),
        )
        return next_epoch

    @staticmethod
    def _message_view(row: sqlite3.Row) -> JsonObject:
        """Render the public message DTO without exposing principal identity."""

        return {
            "id": str(row["message_id"]),
            "eventId": str(row["event_id"]),
            "role": str(row["role"]),
            "content": str(row["content"]),
            "occurredAt": int(row["occurred_at"]),
            "status": str(row["status"]),
            "revokedAt": int(row["revoked_at"]) if row["revoked_at"] is not None else None,
            "sourceRefs": json.loads(str(row["source_refs_json"])),
            "attachments": json.loads(str(row["attachments_json"])),
            "scope": {
                "conversationId": str(row["conversation_id"]),
                "conversationKind": str(row["conversation_kind"]),
                "personaId": str(row["persona_id"]) if row["persona_id"] is not None else None,
                "visibility": str(row["visibility"]),
            },
        }

    @staticmethod
    def _memory_view(row: sqlite3.Row) -> JsonObject:
        """Render one active or historical memory record with its provider state."""

        return {
            "id": str(row["memory_id"]),
            "kind": str(row["memory_kind"]),
            "text": str(row["text"]),
            "sourceMessageIds": json.loads(str(row["source_message_ids_json"])),
            "sourceRefs": json.loads(str(row["source_refs_json"])),
            "version": int(row["version"]),
            "state": str(row["state"]),
            "indexState": str(row["index_state"]),
            "authorizationEpoch": int(row["authorization_epoch"]),
            "createdAt": int(row["created_at"]),
            "updatedAt": int(row["updated_at"]),
            "validUntil": int(row["valid_until"]) if row["valid_until"] is not None else None,
            "scope": {
                "conversationId": str(row["conversation_id"]),
                "conversationKind": str(row["conversation_kind"]),
                "personaId": str(row["persona_id"]) if row["persona_id"] is not None else None,
                "visibility": str(row["visibility"]),
            },
        }

    @staticmethod
    def _source_view(
        row: sqlite3.Row, epoch: int, grants: Sequence[Mapping[str, Any]]
    ) -> JsonObject:
        """Render one source and its current authorization state."""

        return {
            "id": str(row["message_id"]),
            "eventId": str(row["event_id"]),
            "kind": "conversation_message",
            "role": str(row["role"]),
            "status": str(row["status"]),
            "revokedAt": int(row["revoked_at"]) if row["revoked_at"] is not None else None,
            "authorizationEpoch": epoch,
            "createdAt": int(row["created_at"]),
            "canManageGrants": True,
            "grants": [dict(grant) for grant in grants],
            "scope": {
                "conversationId": str(row["conversation_id"]),
                "conversationKind": str(row["conversation_kind"]),
                "personaId": str(row["persona_id"]) if row["persona_id"] is not None else None,
                "visibility": str(row["visibility"]),
            },
        }

    @staticmethod
    def _grant_view(row: sqlite3.Row) -> JsonObject:
        """Render an explicit source grant without revealing its owner actor."""

        return {
            "id": str(row["grant_id"]),
            "sourceId": str(row["source_message_id"]),
            "visibility": str(row["visibility"]),
            "targetConversationId": str(row["target_conversation_id"])
            if row["target_conversation_id"]
            else None,
            "expiresAt": int(row["expires_at"]) if row["expires_at"] is not None else None,
            "createdAt": int(row["created_at"]),
            "status": str(row["status"]),
        }

    def _connect(self) -> sqlite3.Connection:
        """Open a short-lived SQLite connection with strict timeout and foreign-key policy."""

        conn = sqlite3.connect(self._db_path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=10000")
        return conn


def _scope(organization_id: str | None, workspace_id: str, actor_id: str) -> tuple[str, str, str]:
    """Validate the server-derived organization, Workspace, and actor scope."""

    org = "" if organization_id is None else _identifier(organization_id, "organizationId")
    return org, _identifier(workspace_id, "workspaceId"), _identifier(actor_id, "actorId")


def _authorization_epoch(conn: sqlite3.Connection, org: str, workspace: str) -> int:
    """Read a Workspace-wide epoch that invalidates stale context contributions."""

    row = conn.execute(
        "SELECT authorization_epoch FROM conversation_memory_epochs "
        "WHERE organization_id=? AND workspace_id=?",
        (org, workspace),
    ).fetchone()
    return int(row[0]) if row is not None else 0


def _normalize_source_refs(value: object) -> list[JsonObject]:
    """Validate source lineage without truncating or accepting model-owned identity."""

    if not isinstance(value, list) or len(value) > _MAX_SOURCE_REFS:
        raise _invalid(
            "CONVERSATION_MEMORY_SOURCE_LIMIT", "sourceRefs must contain at most 256 references."
        )
    result: list[JsonObject] = []
    seen: set[tuple[str | None, int | None, tuple[str, ...]]] = set()
    for item in value:
        if not isinstance(item, Mapping):
            raise _invalid(
                "CONVERSATION_MEMORY_SOURCE_INVALID", "Each source reference must be an object."
            )
        if set(item) - {"memoryId", "memoryVersion", "sourceMessageIds"}:
            raise _invalid(
                "CONVERSATION_MEMORY_SOURCE_INVALID", "A source reference has unsupported fields."
            )
        memory_id = _optional_identifier(item.get("memoryId"), "memoryId")
        raw_version = item.get("memoryVersion")
        if memory_id is None:
            if raw_version is not None:
                raise _invalid(
                    "CONVERSATION_MEMORY_SOURCE_INVALID", "memoryVersion requires memoryId."
                )
            memory_version = None
        elif type(raw_version) is not int or raw_version < 1:
            raise _invalid(
                "CONVERSATION_MEMORY_SOURCE_INVALID", "memoryVersion must be a positive integer."
            )
        else:
            memory_version = raw_version
        ids = tuple(
            _string_list(
                item.get("sourceMessageIds", []), "sourceMessageIds", _MAX_SOURCE_IDS_PER_REF
            )
        )
        if memory_id is None and not ids:
            raise _invalid(
                "CONVERSATION_MEMORY_SOURCE_INVALID",
                "A source reference must name a memory or message.",
            )
        normalized_key = (memory_id, memory_version, ids)
        if normalized_key not in seen:
            seen.add(normalized_key)
            result.append(
                {
                    "memoryId": memory_id,
                    "memoryVersion": memory_version,
                    "sourceMessageIds": list(ids),
                }
            )
    return result


def _normalize_attachments(value: object) -> list[JsonObject]:
    """Validate bounded opaque image references without accepting paths or URLs."""

    if not isinstance(value, list) or len(value) > 32:
        raise _invalid(
            "CONVERSATION_MEMORY_ATTACHMENT_LIMIT", "attachments must contain at most 32 items."
        )
    normalized: list[JsonObject] = []
    seen: set[str] = set()
    allowed_mime = {"image/gif", "image/jpeg", "image/png", "image/webp"}
    for item in value:
        if not isinstance(item, Mapping) or set(item) != {
            "artifactId",
            "sha256",
            "mimeType",
            "size",
        }:
            raise _invalid(
                "CONVERSATION_MEMORY_ATTACHMENT_INVALID",
                "Attachment reference has an invalid shape.",
            )
        artifact_id = item.get("artifactId")
        digest = item.get("sha256")
        mime_type = item.get("mimeType")
        size = item.get("size")
        if (
            not isinstance(artifact_id, str)
            or not re.fullmatch(r"[0-9a-f]{64}", artifact_id)
            or digest != artifact_id
            or mime_type not in allowed_mime
            or type(size) is not int
            or not 1 <= size <= 10_000_000
        ):
            raise _invalid(
                "CONVERSATION_MEMORY_ATTACHMENT_INVALID", "Attachment metadata failed validation."
            )
        if artifact_id in seen:
            raise _invalid(
                "CONVERSATION_MEMORY_ATTACHMENT_INVALID", "Attachment references must be unique."
            )
        seen.add(artifact_id)
        normalized.append(
            {"artifactId": artifact_id, "sha256": digest, "mimeType": mime_type, "size": size}
        )
    return normalized


def _string_list(value: object, label: str, maximum: int, *, minimum: int = 0) -> list[str]:
    """Validate a bounded unique list of opaque identifiers."""

    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise _invalid(
            "CONVERSATION_MEMORY_INVALID_LIST", f"{label} has an invalid number of items."
        )
    items = [_identifier(item, label) for item in value]
    if len(items) != len(set(items)):
        raise _invalid("CONVERSATION_MEMORY_INVALID_LIST", f"{label} must not contain duplicates.")
    return items


def _identifier(value: object, label: str) -> str:
    """Validate opaque identifiers without normalizing trusted actor identity."""

    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise _invalid("CONVERSATION_MEMORY_INVALID_IDENTIFIER", f"{label} is invalid.")
    return value


def _optional_identifier(value: object, label: str) -> str | None:
    """Validate an optional opaque identifier."""

    return None if value is None else _identifier(value, label)


def _bounded_text(value: object, label: str, maximum: int) -> str:
    """Validate normalized non-empty text with a hard storage bound."""

    if not isinstance(value, str):
        raise _invalid("CONVERSATION_MEMORY_INVALID_TEXT", f"{label} must be text.")
    normalized = value.strip()
    if not normalized or len(normalized) > maximum:
        raise _invalid("CONVERSATION_MEMORY_INVALID_TEXT", f"{label} has an invalid length.")
    return normalized


def _choice(value: object, label: str, allowed: set[str]) -> str:
    """Validate one fixed protocol value."""

    if not isinstance(value, str) or value not in allowed:
        raise _invalid("CONVERSATION_MEMORY_INVALID_VALUE", f"{label} is invalid.")
    return value


def _optional_time(value: object) -> int | None:
    """Validate an optional Unix epoch millisecond value."""

    if value is None:
        return None
    if type(value) is not int or value < 0:
        raise _invalid(
            "CONVERSATION_MEMORY_INVALID_TIME",
            "Time values must be non-negative epoch milliseconds.",
        )
    return value


def _json_text(value: object) -> str:
    """Encode deterministic bounded domain JSON."""

    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _digest(value: object) -> str:
    """Hash a stable payload representation for idempotency checks."""

    return hashlib.sha256(_json_text(value).encode("utf-8")).hexdigest()


def _unix_ms() -> int:
    """Return the current Unix timestamp in milliseconds."""

    return time.time_ns() // 1_000_000


def _invalid(code: str, detail: str) -> PersistenceError:
    """Build a stable validation failure for HTTP serialization."""

    return PersistenceError(code, 422, detail)


def _not_found(code: str, detail: str) -> PersistenceError:
    """Hide cross-scope existence through a uniform not-found response."""

    return PersistenceError(code, 404, detail)


def _conflict(code: str, detail: str) -> PersistenceError:
    """Report a version or idempotency conflict without changing stored state."""

    return PersistenceError(code, 409, detail)


def _encode_cursor(created_at: int, message_id: str) -> str:
    """Create a deterministic cursor that resumes after the last returned row."""

    return f"{created_at}:{message_id}"


def _decode_cursor(value: str | None) -> tuple[int | None, str | None]:
    """Parse an opaque-looking pagination cursor and reject malformed positions."""

    if value is None:
        return None, None
    try:
        raw_time, raw_id = value.split(":", 1)
        cursor_time = int(raw_time)
        cursor_id = _identifier(raw_id, "cursor")
    except (ValueError, PersistenceError):
        raise _invalid("CONVERSATION_MEMORY_INVALID_CURSOR", "cursor is invalid.") from None
    if cursor_time < 0:
        raise _invalid("CONVERSATION_MEMORY_INVALID_CURSOR", "cursor is invalid.")
    return cursor_time, cursor_id
