"""
┌─────────────────────────────────────────────────────────────────────┐
│  Module: cyrene_navigator.persistence.store                        │
│  Role: Authoritative Harness event storage and Product projection.    │
│                                                                     │
│  模块职责：以 SQLite WAL 持久化上游事件，并在服务端执行单写者租约。        │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
import time
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from cyrene_navigator.persistence.errors import (
    SESSION_ALREADY_EXISTS,
    SESSION_ALREADY_OWNED,
    SESSION_INVALID_EVENT,
    SESSION_INVALID_HEADER,
    SESSION_NOT_FOUND,
    SESSION_OWNERSHIP_LOST,
    SESSION_SEQUENCE_CONFLICT,
    SESSION_STORAGE_CORRUPT,
    PersistenceError,
)

JsonObject = dict[str, Any]
_MAX_SAFE_INTEGER = 2**53 - 1
_MAX_PAGE_LENGTH = 10_000


@dataclass(frozen=True, slots=True)
class PersistencePrincipal:
    """Configured bearer identity and Workspace access. | 配置的 bearer 身份。"""

    actor_id: str
    workspace_ids: frozenset[str]
    can_takeover: bool = False


# The shorter name is convenient for callers while keeping the API contract explicit.
# 较短名称便于调用方使用,同时保留明确的 API 契约。
Principal = PersistencePrincipal


@dataclass(frozen=True, slots=True)
class SessionHandleRecord:
    """Server-issued handle state; raw writer tokens are never stored. | 服务端句柄。"""

    session_id: str
    header: JsonObject
    inherited_event_count: int
    access: str
    next_seq: int
    epoch: int
    writer_token: str | None
    lease_expires_at: int | None

    def as_dict(self) -> JsonObject:
        """Return the camelCase wire view. | 返回 camelCase 线格式。"""

        result: JsonObject = {
            "id": self.session_id,
            "header": self.header,
            "inheritedEventCount": self.inherited_event_count,
            "access": self.access,
            "nextSeq": self.next_seq,
            "epoch": self.epoch,
        }
        if self.writer_token is not None:
            result["writerToken"] = self.writer_token
        if self.lease_expires_at is not None:
            result["leaseExpiresAt"] = self.lease_expires_at
        return result


class PersistenceStore:
    """SQLite implementation of the Cyrene Harness persistence authority.

    The store carries the upstream Session header, append-only events, and a
    small read-only Product metadata projection. It deliberately has no message
    projection or AgentLoop state of its own. Every mutation starts with
    ``BEGIN IMMEDIATE`` so ownership, sequence checks, and event insertion commit
    as one durable unit.

    Cyrene Harness 持久化权威的 SQLite 实现。该存储包含上游 Session header、只追加事件,
    以及小型只读 Product 元数据投影。它不包含自己的消息投影或 AgentLoop 状态。每次变更都以
    ``BEGIN IMMEDIATE`` 开始,使所有权检查、序列号检查和事件插入作为一个持久化单元一起提交。
    """

    def __init__(self, db_path: Path, lease_seconds: float = 120) -> None:
        """Open or initialize a durable store. | 打开或初始化持久化存储。"""

        if lease_seconds <= 0:
            raise ValueError("lease_seconds must be positive")
        if str(db_path) == ":memory:":
            raise ValueError("persistence requires a file-backed SQLite database")
        self.db_path = Path(db_path)
        self.lease_seconds = float(lease_seconds)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def create_session(
        self,
        workspace_id: str,
        session_id: str,
        header: Mapping[str, Any],
        inherited_event_count: int,
        principal: PersistencePrincipal,
        client_id: str,
    ) -> SessionHandleRecord:
        """Create a session and take its first write lease. | 创建会话并取得首个写租约。"""

        workspace_id = _validate_identifier(workspace_id, "workspace_id")
        session_id = _validate_identifier(session_id, "session_id")
        client_id = _validate_identifier(client_id, "client_id")
        inherited_event_count = _validate_non_negative_int(
            inherited_event_count, "inherited_event_count"
        )
        normalized_header = _validate_header(header, session_id, inherited_event_count)
        creator_actor_id = _validate_identifier(principal.actor_id, "actor_id")
        now = _unix_ms()
        token = _new_token()
        epoch = 1
        lease_expires_at = self._lease_expiry(now)
        try:
            with self._mutation() as conn:
                if self._fetch_session(conn, workspace_id, session_id) is not None:
                    raise PersistenceError(
                        SESSION_ALREADY_EXISTS,
                        409,
                        "The session already exists in this Workspace.",
                    )
                conn.execute(
                    """
                    INSERT INTO sessions (
                        workspace_id, session_id, header_json, inherited_event_count,
                        event_count, revision, last_activity_at, owner_actor_id,
                        owner_client_id, writer_token_hash, epoch, lease_expires_at
                    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        workspace_id,
                        session_id,
                        _json_text(normalized_header),
                        inherited_event_count,
                        "0",
                        now,
                        creator_actor_id,
                        client_id,
                        _token_hash(token),
                        epoch,
                        lease_expires_at,
                    ),
                )
                conn.execute(
                    """
                    INSERT INTO session_product_metadata (
                        workspace_id, session_id, creator_actor_id, owner_actor_id,
                        owner_state, metadata_version, source, created_at
                    ) VALUES (?, ?, ?, ?, 'known', 1, 'cyrene', ?)
                    """,
                    (
                        workspace_id,
                        session_id,
                        creator_actor_id,
                        creator_actor_id,
                        now,
                    ),
                )
                row = self._require_session(conn, workspace_id, session_id)
                return self._handle_from_row(row, "write", token_override=token)
        except sqlite3.IntegrityError as exc:
            raise PersistenceError(
                SESSION_ALREADY_EXISTS,
                409,
                "The session already exists in this Workspace.",
            ) from exc

    def list_snapshots(self, workspace_id: str) -> list[JsonObject]:
        """List Harness and Product metadata without writer lease state. | 列出会话与产品元数据。"""

        workspace_id = _validate_identifier(workspace_id, "workspace_id")
        with self._read() as conn:
            rows = conn.execute(
                "SELECT * FROM sessions WHERE workspace_id = ? ORDER BY session_id",
                (workspace_id,),
            ).fetchall()
            return [self._snapshot_from_row(conn, row) for row in rows]

    def get_snapshot(self, workspace_id: str, session_id: str) -> JsonObject:
        """Read one Harness and Product metadata snapshot. | 读取会话与产品元数据快照。"""

        workspace_id = _validate_identifier(workspace_id, "workspace_id")
        session_id = _validate_identifier(session_id, "session_id")
        with self._read() as conn:
            return self._snapshot_from_row(
                conn, self._require_session(conn, workspace_id, session_id)
            )

    def get_product_metadata(self, workspace_id: str, session_id: str) -> JsonObject:
        """Read stable Product metadata without opening a writer handle. | 读取稳定产品元数据。"""

        workspace_id = _validate_identifier(workspace_id, "workspace_id")
        session_id = _validate_identifier(session_id, "session_id")
        with self._read() as conn:
            self._require_session(conn, workspace_id, session_id)
            return self._product_metadata_from_row(
                self._require_product_metadata(conn, workspace_id, session_id)
            )

    def open_handle(
        self,
        workspace_id: str,
        session_id: str,
        access: str,
        principal: PersistencePrincipal,
        client_id: str,
        takeover_expected_epoch: int | None = None,
    ) -> SessionHandleRecord:
        """Open a read handle or explicitly fence a write owner. | 打开读句柄或接管写者。"""

        workspace_id = _validate_identifier(workspace_id, "workspace_id")
        session_id = _validate_identifier(session_id, "session_id")
        client_id = _validate_identifier(client_id, "client_id")
        if access not in {"read", "write"}:
            raise PersistenceError(
                "PERSISTENCE_INVALID_ACCESS", 422, "access must be read or write"
            )
        if takeover_expected_epoch is not None:
            takeover_expected_epoch = _validate_non_negative_int(
                takeover_expected_epoch, "takeover_expected_epoch"
            )

        if access == "read":
            with self._read() as conn:
                row = self._require_session(conn, workspace_id, session_id)
                return self._handle_from_row(row, "read")

        with self._mutation() as conn:
            row = self._require_session(conn, workspace_id, session_id)

            current_epoch = _column_int(row, "epoch")
            owner_actor = _column_optional_string(row, "owner_actor_id")
            owner_hash = _column_optional_string(row, "writer_token_hash")
            has_owner = owner_actor is not None or owner_hash is not None
            if has_owner:
                if takeover_expected_epoch is None:
                    raise PersistenceError(
                        SESSION_ALREADY_OWNED,
                        409,
                        "The session has an active or recoverable write owner; "
                        "an expected epoch is required.",
                    )
                if takeover_expected_epoch != current_epoch:
                    raise PersistenceError(
                        SESSION_OWNERSHIP_LOST,
                        409,
                        "The expected ownership epoch is no longer current.",
                        retryable=True,
                    )
                if owner_actor != principal.actor_id and not principal.can_takeover:
                    raise PersistenceError(
                        "SESSION_TAKEOVER_FORBIDDEN",
                        403,
                        "Only the original session owner or an administrator may "
                        "take over the writer.",
                    )
            elif takeover_expected_epoch is not None and takeover_expected_epoch != current_epoch:
                raise PersistenceError(
                    SESSION_OWNERSHIP_LOST,
                    409,
                    "The expected ownership epoch is no longer current.",
                    retryable=True,
                )

            token = _new_token()
            epoch = current_epoch + 1
            lease_expires_at = self._lease_expiry(_unix_ms())
            conn.execute(
                """
                UPDATE sessions
                SET owner_actor_id = ?, owner_client_id = ?, writer_token_hash = ?,
                    epoch = ?, lease_expires_at = ?, last_activity_at = ?
                WHERE workspace_id = ? AND session_id = ?
                """,
                (
                    _validate_identifier(principal.actor_id, "actor_id"),
                    client_id,
                    _token_hash(token),
                    epoch,
                    lease_expires_at,
                    _unix_ms(),
                    workspace_id,
                    session_id,
                ),
            )
            current = self._require_session(conn, workspace_id, session_id)
            return self._handle_from_row(current, "write", token_override=token)

    def read_events(
        self, workspace_id: str, session_id: str, offset: int = 0, length: int = 10_000
    ) -> tuple[list[JsonObject], int]:
        """Read a committed contiguous slice without mutating the log. | 读取已提交事件。"""

        workspace_id = _validate_identifier(workspace_id, "workspace_id")
        session_id = _validate_identifier(session_id, "session_id")
        offset = _validate_non_negative_int(offset, "offset")
        length = _validate_non_negative_int(length, "length")
        if length > _MAX_PAGE_LENGTH:
            raise PersistenceError(
                "PERSISTENCE_PAGE_TOO_LARGE", 422, f"length must be <= {_MAX_PAGE_LENGTH}"
            )
        with self._read() as conn:
            session = self._require_session(conn, workspace_id, session_id)
            next_seq = _column_int(session, "event_count")
            if length == 0 or offset >= next_seq:
                return [], next_seq
            rows = conn.execute(
                """
                SELECT seq, event_json FROM session_events
                WHERE workspace_id = ? AND session_id = ? AND seq >= ?
                ORDER BY seq LIMIT ?
                """,
                (workspace_id, session_id, offset, length),
            ).fetchall()
            expected_count = min(length, next_seq - offset)
            if len(rows) != expected_count:
                raise PersistenceError(
                    SESSION_STORAGE_CORRUPT,
                    500,
                    "The persisted event log is shorter than its committed prefix.",
                )
            events: list[JsonObject] = []
            for index, row in enumerate(rows):
                sequence = _column_int(row, "seq")
                if sequence != offset + index:
                    raise PersistenceError(
                        SESSION_STORAGE_CORRUPT,
                        500,
                        "The persisted event log is not contiguous.",
                    )
                event = _stored_json_object(row["event_json"], "event")
                _validate_stored_event(event, sequence)
                events.append(event)
            return events, next_seq

    def append_events(
        self,
        workspace_id: str,
        session_id: str,
        principal: PersistencePrincipal,
        writer_token: str,
        epoch: int,
        batch_id: str,
        events: Sequence[Mapping[str, Any]],
    ) -> int:
        """Atomically append one fenced, contiguous, idempotent batch. | 原子追加事件批次。"""

        workspace_id = _validate_identifier(workspace_id, "workspace_id")
        session_id = _validate_identifier(session_id, "session_id")
        writer_token = _validate_identifier(writer_token, "writer_token")
        batch_id = _validate_identifier(batch_id, "batch_id")
        epoch = _validate_non_negative_int(epoch, "epoch")
        normalized_events = _validate_event_shapes(events)
        digest = _digest(normalized_events)

        with self._mutation() as conn:
            row = self._require_session(conn, workspace_id, session_id)
            self._assert_writer(row, principal, writer_token, epoch)
            existing = conn.execute(
                """
                SELECT digest, next_seq FROM session_batches
                WHERE workspace_id = ? AND session_id = ? AND epoch = ? AND batch_id = ?
                """,
                (workspace_id, session_id, epoch, batch_id),
            ).fetchone()
            if existing is not None:
                existing_digest = _column_string(existing, "digest")
                if hmac.compare_digest(existing_digest, digest):
                    return _column_int(existing, "next_seq")
                raise PersistenceError(
                    SESSION_SEQUENCE_CONFLICT,
                    409,
                    "The batch id was already used with a different event body.",
                )

            next_seq = _column_int(row, "event_count")
            _validate_event_sequence(normalized_events, next_seq)
            try:
                conn.executemany(
                    """
                    INSERT INTO session_events (workspace_id, session_id, seq, event_json)
                    VALUES (?, ?, ?, ?)
                    """,
                    [
                        (workspace_id, session_id, event["seq"], _json_text(event))
                        for event in normalized_events
                    ],
                )
                committed_next_seq = next_seq + len(normalized_events)
                now = _unix_ms()
                conn.execute(
                    """
                    UPDATE sessions
                    SET event_count = ?, revision = ?, last_activity_at = ?
                    WHERE workspace_id = ? AND session_id = ?
                    """,
                    (
                        committed_next_seq,
                        _revision(committed_next_seq, digest),
                        now,
                        workspace_id,
                        session_id,
                    ),
                )
                conn.execute(
                    """
                    INSERT INTO session_batches (
                        workspace_id, session_id, epoch, batch_id, digest, event_count, next_seq
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        workspace_id,
                        session_id,
                        epoch,
                        batch_id,
                        digest,
                        len(normalized_events),
                        committed_next_seq,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise PersistenceError(
                    SESSION_SEQUENCE_CONFLICT,
                    409,
                    "The event batch conflicts with the committed sequence.",
                ) from exc
            return committed_next_seq

    def heartbeat(
        self,
        workspace_id: str,
        session_id: str,
        principal: PersistencePrincipal,
        writer_token: str,
        epoch: int,
    ) -> tuple[int, int]:
        """Renew a write lease after fencing. | 在校验围栏后续租。"""

        return self._renew_or_confirm(
            workspace_id, session_id, principal, writer_token, epoch, renew=True
        )

    def flush(
        self,
        workspace_id: str,
        session_id: str,
        principal: PersistencePrincipal,
        writer_token: str,
        epoch: int,
    ) -> tuple[int, int]:
        """Confirm the committed prefix and current lease. | 确认已提交前缀和租约。"""

        return self._renew_or_confirm(
            workspace_id, session_id, principal, writer_token, epoch, renew=False
        )

    def release(
        self,
        workspace_id: str,
        session_id: str,
        principal: PersistencePrincipal,
        writer_token: str,
        epoch: int,
    ) -> int:
        """Release exactly one current write owner and advance the epoch. | 释放当前写者。"""

        workspace_id = _validate_identifier(workspace_id, "workspace_id")
        session_id = _validate_identifier(session_id, "session_id")
        writer_token = _validate_identifier(writer_token, "writer_token")
        epoch = _validate_non_negative_int(epoch, "epoch")
        with self._mutation() as conn:
            row = self._require_session(conn, workspace_id, session_id)
            self._assert_writer(row, principal, writer_token, epoch)
            next_epoch = _column_int(row, "epoch") + 1
            conn.execute(
                """
                UPDATE sessions
                SET owner_actor_id = NULL, owner_client_id = NULL,
                    writer_token_hash = NULL, lease_expires_at = NULL, epoch = ?
                WHERE workspace_id = ? AND session_id = ?
                """,
                (next_epoch, workspace_id, session_id),
            )
            return _column_int(row, "event_count")

    def _renew_or_confirm(
        self,
        workspace_id: str,
        session_id: str,
        principal: PersistencePrincipal,
        writer_token: str,
        epoch: int,
        *,
        renew: bool,
    ) -> tuple[int, int]:
        """Implement heartbeat and flush under one transaction. | 实现续租与 flush。"""

        workspace_id = _validate_identifier(workspace_id, "workspace_id")
        session_id = _validate_identifier(session_id, "session_id")
        writer_token = _validate_identifier(writer_token, "writer_token")
        epoch = _validate_non_negative_int(epoch, "epoch")
        with self._mutation() as conn:
            row = self._require_session(conn, workspace_id, session_id)
            self._assert_writer(row, principal, writer_token, epoch)
            lease_expires_at = _column_int(row, "lease_expires_at")
            if renew:
                lease_expires_at = self._lease_expiry(_unix_ms())
                conn.execute(
                    """
                    UPDATE sessions
                    SET lease_expires_at = ?, last_activity_at = ?
                    WHERE workspace_id = ? AND session_id = ?
                    """,
                    (lease_expires_at, _unix_ms(), workspace_id, session_id),
                )
            return _column_int(row, "event_count"), lease_expires_at

    def _assert_writer(
        self,
        row: sqlite3.Row,
        principal: PersistencePrincipal,
        writer_token: str,
        epoch: int,
    ) -> None:
        """Reject stale, foreign, or expired write capabilities. | 拒绝失效写能力。"""

        expected_epoch = _column_int(row, "epoch")
        owner_actor = _column_optional_string(row, "owner_actor_id")
        stored_hash = _column_optional_string(row, "writer_token_hash")
        lease_expires_at = _column_optional_int(row, "lease_expires_at")
        if (
            epoch != expected_epoch
            or owner_actor != principal.actor_id
            or stored_hash is None
            or not hmac.compare_digest(stored_hash, _token_hash(writer_token))
            or lease_expires_at is None
            or lease_expires_at <= _unix_ms()
        ):
            raise PersistenceError(
                SESSION_OWNERSHIP_LOST,
                409,
                "The write handle is no longer the current unexpired session owner.",
                retryable=True,
            )

    def _handle_from_row(
        self, row: sqlite3.Row, access: str, *, token_override: str | None = None
    ) -> SessionHandleRecord:
        """Convert a durable row to a read or write handle. | 生成句柄视图。"""

        token = token_override if access == "write" else None
        lease = _column_optional_int(row, "lease_expires_at") if access == "write" else None
        return SessionHandleRecord(
            session_id=_column_string(row, "session_id"),
            header=_stored_json_object(row["header_json"], "header"),
            inherited_event_count=_column_int(row, "inherited_event_count"),
            access=access,
            next_seq=_column_int(row, "event_count"),
            epoch=_column_int(row, "epoch"),
            writer_token=token,
            lease_expires_at=lease,
        )

    def _snapshot_from_row(self, conn: sqlite3.Connection, row: sqlite3.Row) -> JsonObject:
        """Convert a row to the Harness/Product metadata snapshot. | 生成会话与产品快照。"""

        last_activity = _column_optional_int(row, "last_activity_at")
        return {
            "meta": _stored_json_object(row["header_json"], "header"),
            "productMetadata": self._product_metadata_from_row(
                self._require_product_metadata(
                    conn,
                    _column_string(row, "workspace_id"),
                    _column_string(row, "session_id"),
                )
            ),
            "revision": _column_string(row, "revision"),
            "eventCount": _column_int(row, "event_count"),
            "lastActivityAt": last_activity,
        }

    @staticmethod
    def _fetch_session(
        conn: sqlite3.Connection, workspace_id: str, session_id: str
    ) -> sqlite3.Row | None:
        """Fetch one keyed session row. | 读取 workspace/session 复合键。"""

        return cast(
            sqlite3.Row | None,
            conn.execute(
                "SELECT * FROM sessions WHERE workspace_id = ? AND session_id = ?",
                (workspace_id, session_id),
            ).fetchone(),
        )

    @classmethod
    def _require_session(
        cls, conn: sqlite3.Connection, workspace_id: str, session_id: str
    ) -> sqlite3.Row:
        """Require a session row or return the stable not-found error. | 要求会话存在。"""

        row = cls._fetch_session(conn, workspace_id, session_id)
        if row is None:
            raise PersistenceError(
                SESSION_NOT_FOUND,
                404,
                "The session does not exist in this Workspace.",
            )
        return row

    @staticmethod
    def _require_product_metadata(
        conn: sqlite3.Connection, workspace_id: str, session_id: str
    ) -> sqlite3.Row:
        """Require the separately stored Product projection. | 要求独立产品投影。"""

        row = cast(
            sqlite3.Row | None,
            conn.execute(
                """
                SELECT * FROM session_product_metadata
                WHERE workspace_id = ? AND session_id = ?
                """,
                (workspace_id, session_id),
            ).fetchone(),
        )
        if row is None:
            raise PersistenceError(
                SESSION_STORAGE_CORRUPT,
                500,
                "The session is missing its Product metadata projection.",
            )
        return row

    @staticmethod
    def _product_metadata_from_row(row: sqlite3.Row) -> JsonObject:
        """Validate and project stable Product metadata. | 校验并返回稳定产品元数据。"""

        source = _column_string(row, "source")
        owner_state = _column_string(row, "owner_state")
        creator_actor_id = _column_optional_string(row, "creator_actor_id")
        owner_actor_id = _column_optional_string(row, "owner_actor_id")
        metadata_version = _column_int(row, "metadata_version")
        created_at = _column_optional_int(row, "created_at")
        if source not in {"cyrene", "legacy"}:
            raise PersistenceError(
                SESSION_STORAGE_CORRUPT,
                500,
                "The Product metadata source is invalid.",
            )
        if owner_state not in {"known", "unknown"}:
            raise PersistenceError(
                SESSION_STORAGE_CORRUPT,
                500,
                "The Product metadata owner state is invalid.",
            )
        if metadata_version < 1:
            raise PersistenceError(
                SESSION_STORAGE_CORRUPT,
                500,
                "The Product metadata version is invalid.",
            )
        if source == "cyrene" and (
            creator_actor_id is None
            or owner_actor_id is None
            or owner_state != "known"
            or created_at is None
        ):
            raise PersistenceError(
                SESSION_STORAGE_CORRUPT,
                500,
                "Known Cyrene Product metadata is incomplete.",
            )
        if source == "legacy" and (
            creator_actor_id is not None or owner_actor_id is not None or owner_state != "unknown"
        ):
            raise PersistenceError(
                SESSION_STORAGE_CORRUPT,
                500,
                "Legacy Product metadata must retain unknown ownership.",
            )
        return {
            "workspaceId": _column_string(row, "workspace_id"),
            "sessionId": _column_string(row, "session_id"),
            "creatorActorId": creator_actor_id,
            "ownerActorId": owner_actor_id,
            "ownerState": owner_state,
            "metadataVersion": metadata_version,
            "source": source,
            "createdAt": created_at,
        }

    def _initialize(self) -> None:
        """Create the durable schema under a write transaction. | 在写事务中建表。"""

        with self._mutation() as conn:
            for statement in (
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    workspace_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    header_json TEXT NOT NULL,
                    inherited_event_count INTEGER NOT NULL CHECK (inherited_event_count >= 0),
                    event_count INTEGER NOT NULL CHECK (event_count >= 0),
                    revision TEXT NOT NULL,
                    last_activity_at INTEGER NOT NULL,
                    owner_actor_id TEXT,
                    owner_client_id TEXT,
                    writer_token_hash TEXT,
                    epoch INTEGER NOT NULL CHECK (epoch >= 0),
                    lease_expires_at INTEGER,
                    PRIMARY KEY (workspace_id, session_id),
                    CHECK (
                        (owner_actor_id IS NULL AND owner_client_id IS NULL
                         AND writer_token_hash IS NULL AND lease_expires_at IS NULL)
                        OR
                        (owner_actor_id IS NOT NULL AND owner_client_id IS NOT NULL
                         AND writer_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
                    )
                );
                """,
                """
                CREATE TABLE IF NOT EXISTS session_events (
                    workspace_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    seq INTEGER NOT NULL CHECK (seq >= 0),
                    event_json TEXT NOT NULL,
                    PRIMARY KEY (workspace_id, session_id, seq),
                    FOREIGN KEY (workspace_id, session_id)
                        REFERENCES sessions (workspace_id, session_id) ON DELETE CASCADE
                );
                """,
                """
                CREATE TABLE IF NOT EXISTS session_batches (
                    workspace_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    epoch INTEGER NOT NULL CHECK (epoch >= 0),
                    batch_id TEXT NOT NULL,
                    digest TEXT NOT NULL,
                    event_count INTEGER NOT NULL CHECK (event_count > 0),
                    next_seq INTEGER NOT NULL CHECK (next_seq >= 0),
                    PRIMARY KEY (workspace_id, session_id, epoch, batch_id),
                    FOREIGN KEY (workspace_id, session_id)
                        REFERENCES sessions (workspace_id, session_id) ON DELETE CASCADE
                );
                """,
                """
                CREATE TABLE IF NOT EXISTS session_product_metadata (
                    workspace_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    creator_actor_id TEXT,
                    owner_actor_id TEXT,
                    owner_state TEXT NOT NULL CHECK (owner_state IN ('known', 'unknown')),
                    metadata_version INTEGER NOT NULL CHECK (metadata_version >= 1),
                    source TEXT NOT NULL CHECK (source IN ('cyrene', 'legacy')),
                    created_at INTEGER,
                    PRIMARY KEY (workspace_id, session_id),
                    FOREIGN KEY (workspace_id, session_id)
                        REFERENCES sessions (workspace_id, session_id) ON DELETE CASCADE
                );
                """,
            ):
                conn.execute(statement)
            # This additive bootstrap is the migration for databases created before
            # Product metadata existed. The old mutable writer is intentionally not
            # copied into the stable Product owner fields.
            # 此增量初始化用于迁移 Product 元数据引入前创建的数据库。旧的可变写入方不会被复制到稳定的 Product 所有者字段。
            conn.execute(
                """
                INSERT OR IGNORE INTO session_product_metadata (
                    workspace_id, session_id, creator_actor_id, owner_actor_id,
                    owner_state, metadata_version, source, created_at
                )
                SELECT workspace_id, session_id, NULL, NULL, 'unknown', 1, 'legacy', NULL
                FROM sessions
                """
            )

    def _lease_expiry(self, now: int) -> int:
        """Return a millisecond lease deadline. | 返回毫秒租约截止时间。"""

        return now + max(1, int(self.lease_seconds * 1000))

    @contextmanager
    def _mutation(self) -> Iterator[sqlite3.Connection]:
        """Run one mutation with SQLite's immediate writer reservation. | 原子写事务。"""

        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.execute("COMMIT")
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    @contextmanager
    def _read(self) -> Iterator[sqlite3.Connection]:
        """Run a consistent read transaction. | 运行一致性读事务。"""

        conn = self._connect()
        try:
            conn.execute("BEGIN")
            yield conn
            conn.execute("COMMIT")
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _connect(self) -> sqlite3.Connection:
        """Open a configured WAL/FULL SQLite connection. | 打开 WAL/FULL 连接。"""

        conn = sqlite3.connect(
            self.db_path,
            timeout=30.0,
            isolation_level=None,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = FULL")
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA busy_timeout = 30000")
        except BaseException:
            conn.close()
            raise
        return conn


def _validate_header(
    header: Mapping[str, Any], session_id: str, inherited_event_count: int
) -> JsonObject:
    """Validate the stable v2 header floor while preserving upstream fields. | 校验 v2 头。"""

    if not isinstance(header, Mapping) or isinstance(header, (str, bytes)):
        raise PersistenceError(SESSION_INVALID_HEADER, 422, "header must be a JSON object")
    normalized = dict(header)
    if normalized.get("id") != session_id:
        raise PersistenceError(SESSION_INVALID_HEADER, 422, "header.id must match sessionId")
    if normalized.get("version") != 2:
        raise PersistenceError(SESSION_INVALID_HEADER, 422, "header.version must be 2")
    created_at = normalized.get("createdAt")
    if type(created_at) is not int or created_at < 0 or created_at > _MAX_SAFE_INTEGER:
        raise PersistenceError(
            SESSION_INVALID_HEADER,
            422,
            "header.createdAt must be a non-negative Unix millisecond integer",
        )
    if type(normalized.get("isSeeded")) is not bool:
        raise PersistenceError(SESSION_INVALID_HEADER, 422, "header.isSeeded must be boolean")
    if not normalized["isSeeded"] and inherited_event_count != 0:
        raise PersistenceError(
            SESSION_INVALID_HEADER,
            422,
            "an unseeded header must have inheritedEventCount 0",
        )
    try:
        _json_text(normalized)
    except (TypeError, ValueError) as exc:
        raise PersistenceError(
            SESSION_INVALID_HEADER, 422, "header must be losslessly JSON serializable"
        ) from exc
    return normalized


def _validate_event_shapes(events: Sequence[Mapping[str, Any]]) -> list[JsonObject]:
    """Check only the wire envelope, leaving event vocabulary to DeepSeek Harness. | 仅验信封。"""

    if not isinstance(events, Sequence) or isinstance(events, (str, bytes)) or not events:
        raise PersistenceError(SESSION_INVALID_EVENT, 422, "events must be a non-empty JSON array")
    normalized: list[JsonObject] = []
    for event in events:
        if not isinstance(event, Mapping) or isinstance(event, (str, bytes)):
            raise PersistenceError(SESSION_INVALID_EVENT, 422, "each event must be a JSON object")
        value = dict(event)
        if not all(key in value for key in ("seq", "time", "type", "data")):
            raise PersistenceError(
                SESSION_INVALID_EVENT, 422, "each event requires seq, time, type, and data"
            )
        if not _is_safe_int(value["seq"]) or value["seq"] < 0:
            raise PersistenceError(SESSION_INVALID_EVENT, 422, "event.seq must be non-negative")
        if not _is_safe_int(value["time"]) or value["time"] < 0:
            raise PersistenceError(SESSION_INVALID_EVENT, 422, "event.time must be non-negative")
        if not isinstance(value["type"], str) or not value["type"] or len(value["type"]) > 512:
            raise PersistenceError(
                SESSION_INVALID_EVENT, 422, "event.type must be a non-empty string"
            )
        try:
            _json_text(value)
        except (TypeError, ValueError) as exc:
            raise PersistenceError(
                SESSION_INVALID_EVENT, 422, "event must be losslessly JSON serializable"
            ) from exc
        normalized.append(value)
    return normalized


def _validate_event_sequence(events: Sequence[Mapping[str, Any]], expected: int) -> None:
    """Require a contiguous batch beginning at the committed next sequence. | 校验连续序号。"""

    for index, event in enumerate(events):
        sequence = event["seq"]
        if sequence != expected + index:
            raise PersistenceError(
                SESSION_SEQUENCE_CONFLICT,
                409,
                f"event sequence must continue at {expected}; received {sequence}",
            )


def _validate_stored_event(event: Mapping[str, Any], expected_seq: int) -> None:
    """Check a stored envelope without interpreting its upstream vocabulary. | 校验存储信封。"""

    try:
        _validate_event_shapes([event])
    except PersistenceError as exc:
        raise PersistenceError(
            SESSION_STORAGE_CORRUPT, 500, "The persisted event envelope is invalid."
        ) from exc
    if event.get("seq") != expected_seq:
        raise PersistenceError(
            SESSION_STORAGE_CORRUPT,
            500,
            "The persisted event sequence does not match its storage cursor.",
        )


def _validate_identifier(value: str, field: str) -> str:
    """Constrain path and capability identifiers to safe scalar strings. | 校验标识符。"""

    if not isinstance(value, str) or not value or len(value) > 512:
        raise PersistenceError(
            "PERSISTENCE_INVALID_IDENTIFIER", 422, f"{field} must be a non-empty string"
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise PersistenceError(
            "PERSISTENCE_INVALID_IDENTIFIER", 422, f"{field} contains control characters"
        )
    return value


def _validate_non_negative_int(value: int, field: str) -> int:
    """Require a JSON-safe non-negative integer. | 要求 JSON 安全的非负整数。"""

    if not _is_safe_int(value) or value < 0:
        raise PersistenceError(
            "PERSISTENCE_INVALID_INTEGER", 422, f"{field} must be a non-negative integer"
        )
    return value


def _is_safe_int(value: object) -> bool:
    """Return whether a value is an exact JSON/JavaScript-safe integer. | 判断安全整数。"""

    return type(value) is int and 0 <= value <= _MAX_SAFE_INTEGER


def _json_text(value: object) -> str:
    """Encode canonical JSON without accepting NaN or Infinity. | 编码严格 JSON。"""

    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _stored_json_object(value: object, field: str) -> JsonObject:
    """Decode and validate a stored object, failing closed on corruption. | 读取存储对象。"""

    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError) as exc:
        raise PersistenceError(
            SESSION_STORAGE_CORRUPT, 500, f"stored {field} is invalid JSON"
        ) from exc
    if not isinstance(parsed, dict):
        raise PersistenceError(SESSION_STORAGE_CORRUPT, 500, f"stored {field} is not a JSON object")
    return parsed


def _digest(events: Sequence[Mapping[str, Any]]) -> str:
    """Hash the complete normalized batch body for idempotency. | 对完整批次做摘要。"""

    return hashlib.sha256(_json_text(list(events)).encode("utf-8")).hexdigest()


def _revision(next_seq: int, digest: str) -> str:
    """Create an opaque, monotonic-enough revision token. | 创建不透明版本标记。"""

    return f"{next_seq}:{digest[:16]}"


def _new_token() -> str:
    """Generate a high-entropy bearer capability. | 生成高熵 bearer 能力。"""

    return secrets.token_urlsafe(32)


def _token_hash(token: str) -> str:
    """Hash a writer capability before database storage. | 仅存写能力哈希。"""

    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _unix_ms() -> int:
    """Return the current Unix timestamp in milliseconds. | 返回 Unix 毫秒时间。"""

    return time.time_ns() // 1_000_000


def _column_string(row: sqlite3.Row, name: str) -> str:
    """Read a required SQLite text column. | 读取必需文本列。"""

    value = row[name]
    if not isinstance(value, str):
        raise PersistenceError(SESSION_STORAGE_CORRUPT, 500, f"stored {name} is not text")
    return value


def _column_optional_string(row: sqlite3.Row, name: str) -> str | None:
    """Read an optional SQLite text column. | 读取可选文本列。"""

    value = row[name]
    if value is not None and not isinstance(value, str):
        raise PersistenceError(SESSION_STORAGE_CORRUPT, 500, f"stored {name} is not text")
    return value


def _column_int(row: sqlite3.Row, name: str) -> int:
    """Read a required SQLite integer column. | 读取必需整数列。"""

    value = row[name]
    if not _is_safe_int(value):
        raise PersistenceError(SESSION_STORAGE_CORRUPT, 500, f"stored {name} is not a safe integer")
    return cast(int, value)


def _column_optional_int(row: sqlite3.Row, name: str) -> int | None:
    """Read an optional SQLite integer column. | 读取可选整数列。"""

    value = row[name]
    if value is not None and not _is_safe_int(value):
        raise PersistenceError(SESSION_STORAGE_CORRUPT, 500, f"stored {name} is not a safe integer")
    return cast(int, value) if value is not None else None
