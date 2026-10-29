"""
Module: cyrene_navigator.work.store
Role: Workspace-scoped durable Work resources in the Harness SQLite file.

模块职责：在 Harness SQLite 文件中持久化组织与 Workspace 隔离的工作域资源。
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import sqlite3
import time
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from cyrene_navigator.persistence.errors import PersistenceError

JsonObject = dict[str, Any]


@dataclass(frozen=True, slots=True)
class PrivateConversationScope:
    """Current server-verified owner projection for private Teams route resolution."""

    workspace_id: str
    issuer: str
    tenant_id: str
    bot_app_id: str
    owner_subjects: frozenset[str]


_MAX_JSON_BYTES = 2_000_000
_TASK_RESULT_NOTIFICATION_MAX_CHARS = 20_000
_TASK_RESULT_NOTIFICATION_TRUNCATION = "\n...[middle task result truncated]...\n"
_PRIVATE_TEAMS_ACCEPTED_ACK_TEXT = "Request received. Work is underway."
_CREDENTIAL_HEALTH_NOTIFICATION_TYPE = "teams.credential-health"
_TEAMS_CONNECTOR_ID = "teams-v1"
_CREDENTIAL_HEALTH_CONNECTOR_ID = _TEAMS_CONNECTOR_ID
_CREDENTIAL_HEALTH_RECIPIENT = "teams:credential-health"
_CREDENTIAL_HEALTH_REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1_000
_PRIVATE_INSTALL_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000
_PRIVATE_INSTALL_EVENT_MAX_PER_WORKSPACE = 10_000
_CREDENTIAL_CAPABILITY_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")
_TERMINAL_TASK_STATES = frozenset({"completed", "failed", "aborted"})
_TASK_TRANSITIONS: dict[str, frozenset[str]] = {
    "queued": frozenset({"running", "failed", "aborted", "waiting_approval", "waiting_input"}),
    "running": frozenset(
        {
            "completed",
            "failed",
            "aborted",
            "waiting_approval",
            "waiting_input",
            "awaiting_user_authorization",
        }
    ),
    "waiting_approval": frozenset({"running", "failed", "aborted"}),
    "waiting_input": frozenset({"running", "failed", "aborted"}),
    "awaiting_user_authorization": frozenset({"aborted"}),
    "completed": frozenset(),
    "failed": frozenset(),
    "aborted": frozenset(),
}


class WorkStore:
    """Persist Work state beside Harness sessions with immediate SQLite transactions.

    Organization and Workspace form part of every resource key. Mutations use
    ``BEGIN IMMEDIATE`` so task/event, approval/task, and outbox lease changes
    commit as one unit. 工作域记录与 Harness 共用数据库,并保持租户键隔离。
    """

    def __init__(self, db_path: Path, attachment_root: Path | None = None) -> None:
        """Initialize additive Work tables without changing Harness tables. | 初始化工作表。"""

        if str(db_path) == ":memory:":
            raise ValueError("work persistence requires the Harness file-backed SQLite database")
        self.db_path = Path(db_path)
        self.attachment_root = (
            Path(attachment_root) if attachment_root else Path(f"{self.db_path}.work-attachments")
        )
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def create_task(
        self,
        organization_id: str | None,
        workspace_id: str,
        body: Mapping[str, Any],
        actor_id: str | None = None,
        *,
        actor_private_scope: bool = False,
    ) -> tuple[JsonObject, bool]:
        """Create or safely replay one task admission. | 创建或安全重放任务接纳。"""

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(body.get("id") or uuid4().hex, "task id")
        session_id = _identifier(body.get("sessionId"), "sessionId")
        prompt = _bounded_text(body.get("prompt"), "prompt", 100_000)
        execution_class = body.get("executionClass", "foreground")
        if execution_class not in {"foreground", "background"}:
            raise _invalid("WORK_TASK_INVALID_EXECUTION_CLASS", "executionClass is not supported")
        title = _optional_text(body.get("title"), "title", 512)
        description = _optional_text(body.get("description"), "description", 20_000)
        metadata = _json_object(body.get("metadata", {}), "metadata")
        _task_notification_descriptor(metadata)
        _validate_task_execution_metadata(execution_class, metadata)
        created_by_actor_id = _identifier(actor_id, "actorId") if actor_id else ""
        create_digest = _digest(
            {
                "sessionId": session_id,
                "prompt": prompt,
                "title": title,
                "description": description,
                "metadata": metadata,
                "executionClass": execution_class,
                "createdByActorId": created_by_actor_id,
            }
        )
        prior_actor_digest = _digest(
            {
                "sessionId": session_id,
                "prompt": prompt,
                "title": title,
                "description": description,
                "metadata": metadata,
                "createdByActorId": created_by_actor_id,
            }
        )
        legacy_create_digest = _digest(
            {
                "sessionId": session_id,
                "prompt": prompt,
                "title": title,
                "description": description,
                "metadata": metadata,
            }
        )
        now = _unix_ms()
        with self._mutation() as conn:
            row = conn.execute(
                """SELECT * FROM work_tasks
                   WHERE organization_id=? AND workspace_id=? AND task_id=?""",
                (org, workspace, task_id),
            ).fetchone()
            if row is not None:
                if str(row["creation_digest"]) != create_digest and not (
                    execution_class == "foreground"
                    and str(row["execution_class"] or "foreground") == "foreground"
                    and str(row["creation_digest"]) in {prior_actor_digest, legacy_create_digest}
                ):
                    raise _conflict(
                        "WORK_TASK_ID_CONFLICT",
                        "The task id already names another task.",
                    )
                if actor_private_scope:
                    self._record_private_task_owner(
                        conn, org, workspace, task_id, created_by_actor_id
                    )
                return self._task_view(conn, row), True
            conn.execute(
                """INSERT INTO work_tasks (
                    organization_id,workspace_id,task_id,session_id,prompt,status,
                    created_at,started_at,ended_at,output,reasoning,error,duration_ms,
                    sequence,title,description,metadata_json,creation_digest,created_by_actor_id,
                    execution_class
                ) VALUES (?,?,?,?,?,'queued',?,NULL,NULL,'','',NULL,0,0,?,?,?,?,?,?)""",
                (
                    org,
                    workspace,
                    task_id,
                    session_id,
                    prompt,
                    now,
                    title,
                    description,
                    _json_text(metadata),
                    create_digest,
                    created_by_actor_id,
                    execution_class,
                ),
            )
            self._append_event(conn, org, workspace, task_id, {"type": "task.created"}, None, now)
            if actor_private_scope:
                self._record_private_task_owner(conn, org, workspace, task_id, created_by_actor_id)
            row = self._require_task(conn, org, workspace, task_id)
            return self._task_view(conn, row), False

    def create_task_continuation(
        self,
        organization_id: str | None,
        workspace_id: str,
        source_task_id: str,
        actor_id: str,
        prompt: str,
        idempotency_key: str,
    ) -> tuple[JsonObject, bool]:
        """Atomically create a read-only child from the same actor's auth-wait task.

        Args:
            organization_id: Authenticated organization scope.
            workspace_id: Configured Workspace scope.
            source_task_id: The actor-owned task waiting for user authorization.
            actor_id: Authenticated persistence actor.
            prompt: Bounded new continuation prompt.
            idempotency_key: Stable key for this child task admission.
        Returns:
            The created TaskRecord projection and whether it was an idempotent replay.
        Raises:
            PersistenceError: If scope, owner, source state, or key is invalid.

        中文：在一个事务中验证任务所有权并持久化只读续接标记。
        """

        org, workspace = _scope(organization_id, workspace_id)
        source_task_id = _identifier(source_task_id, "source task id")
        actor = _identifier(actor_id, "actorId")
        continuation_prompt = _bounded_text(prompt, "prompt", 20_000)
        key = _bounded_text(idempotency_key, "Idempotency-Key", 200)
        digest = _digest({"sourceTaskId": source_task_id, "actorId": actor, "idempotencyKey": key})
        task_id = "continuation-" + digest
        now = _unix_ms()
        with self._mutation() as conn:
            source = self._require_task(conn, org, workspace, source_task_id)
            if str(source["created_by_actor_id"] or "") != actor:
                raise _not_found(
                    "WORK_TASK_NOT_FOUND", "The source task does not exist in this Workspace."
                )
            if str(source["status"]) != "awaiting_user_authorization":
                raise _conflict(
                    "WORK_TASK_NOT_AWAITING_AUTHORIZATION",
                    "Only authorization-waiting tasks can start an explicit continuation.",
                )
            session_id = str(source["session_id"])
            create_digest = _digest(
                {
                    "sessionId": session_id,
                    "prompt": continuation_prompt,
                    "sourceTaskId": source_task_id,
                    "continuationMode": "read_only",
                    "actorId": actor,
                    "idempotencyKey": key,
                }
            )
            existing = conn.execute(
                """SELECT * FROM work_tasks
                   WHERE organization_id=? AND workspace_id=? AND task_id=?""",
                (org, workspace, task_id),
            ).fetchone()
            if existing is not None:
                if str(existing["creation_digest"]) != create_digest:
                    raise _conflict(
                        "WORK_TASK_ID_CONFLICT", "The continuation key already names another task."
                    )
                return self._task_view(conn, existing), True
            conn.execute(
                """INSERT INTO work_tasks(
                    organization_id,workspace_id,task_id,session_id,prompt,status,
                    created_at,started_at,ended_at,output,reasoning,error,duration_ms,sequence,
                    title,description,metadata_json,creation_digest,created_by_actor_id,
                    continuation_of_task_id,continuation_mode,execution_class)
                   VALUES(?,?,?,?,?,'queued',?,NULL,NULL,'','',NULL,0,0,NULL,NULL,'{}',?,?,?,?,?)""",
                (
                    org,
                    workspace,
                    task_id,
                    session_id,
                    continuation_prompt,
                    now,
                    create_digest,
                    actor,
                    source_task_id,
                    "read_only",
                    str(source["execution_class"] or "foreground"),
                ),
            )
            self._record_private_task_owner(conn, org, workspace, task_id, actor)
            self._append_event(
                conn,
                org,
                workspace,
                task_id,
                {
                    "type": "task.created",
                    "continuationOfTaskId": source_task_id,
                    "continuationMode": "read_only",
                },
                None,
                now,
            )
            self._append_event(
                conn,
                org,
                workspace,
                task_id,
                {
                    "type": "task.continuation_started",
                    "sourceTaskId": source_task_id,
                    "mode": "read_only",
                },
                None,
                now,
            )
            self._append_event(
                conn,
                org,
                workspace,
                source_task_id,
                {
                    "type": "task.continuation_started",
                    "continuationTaskId": task_id,
                    "mode": "read_only",
                },
                None,
                now,
            )
            row = self._require_task(conn, org, workspace, task_id)
            return self._task_view(conn, row), False

    def verify_task_continuation_owner(
        self,
        organization_id: str | None,
        workspace_id: str,
        source_task_id: str,
        actor_id: str,
    ) -> None:
        """Confirm ownership before Navigator revalidates the source DSH identity.

        Args:
            organization_id: Authenticated organization scope.
            workspace_id: Configured Workspace scope.
            source_task_id: Paused source task to validate.
            actor_id: Authenticated persistence actor.
        Raises:
            PersistenceError: If the task is missing, unowned, or no longer waiting.

        中文：在 Navigator 将保存的 DSH Session 用于 Exchange 前校验当前调用者。
        """

        org, workspace = _scope(organization_id, workspace_id)
        source_task_id = _identifier(source_task_id, "source task id")
        actor = _identifier(actor_id, "actorId")
        with self._read() as conn:
            source = self._require_task(conn, org, workspace, source_task_id)
            if str(source["created_by_actor_id"] or "") != actor:
                raise _not_found(
                    "WORK_TASK_NOT_FOUND", "The source task does not exist in this Workspace."
                )
            if str(source["status"]) != "awaiting_user_authorization":
                raise _conflict(
                    "WORK_TASK_NOT_AWAITING_AUTHORIZATION",
                    "Only authorization-waiting tasks can start an explicit continuation.",
                )

    def get_task(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> JsonObject:
        """Read one task from the exact tenant scope. | 读取精确租户范围内的任务。"""

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(task_id, "task id")
        actor = _identifier(actor_id, "actorId") if actor_id is not None else None
        with self._read() as conn:
            row = self._require_task(conn, org, workspace, task_id)
            self._require_teams_task_actor(
                conn,
                org,
                workspace,
                task_id,
                actor,
                actor_private_scope=actor_private_scope,
            )
            return self._task_view(conn, row)

    def get_backend_session(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        backend: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> JsonObject | None:
        """Read a native session mapping through one currently running Work Task.

        The mapping is keyed by the canonical Work session in the same SQLite
        store. A legacy DSH Session id is never interpreted as an ACP id.
        中文：通过正在运行的 Work Task 读取同库中的原生 Session 映射。
        """

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(task_id, "task id")
        backend = _identifier(backend, "backend")
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        if backend != "codebuddy-acp":
            raise _invalid(
                "WORK_BACKEND_SESSION_INVALID", "The native execution backend is not supported."
            )
        with self._read() as conn:
            task = self._require_task(conn, org, workspace, task_id)
            is_teams_task = self._require_teams_task_actor(
                conn,
                org,
                workspace,
                task_id,
                actor,
                actor_private_scope=actor_private_scope,
            )
            if str(task["status"]) != "running":
                raise _conflict(
                    "WORK_BACKEND_SESSION_TASK_NOT_RUNNING",
                    "Native session mappings require the active running Work Task.",
                )
            if is_teams_task or actor_private_scope:
                row = conn.execute(
                    """SELECT backend,native_session_id FROM work_backend_actor_sessions
                       WHERE organization_id=? AND workspace_id=? AND actor_id=?
                         AND session_id=? AND backend=?""",
                    (org, workspace, actor or "", str(task["session_id"]), backend),
                ).fetchone()
                if row is None and actor_private_scope and not is_teams_task:
                    shared = conn.execute(
                        """SELECT backend,native_session_id FROM work_backend_sessions
                           WHERE organization_id=? AND workspace_id=? AND session_id=?
                             AND backend=?""",
                        (org, workspace, str(task["session_id"]), backend),
                    ).fetchone()
                    foreign_task = conn.execute(
                        """SELECT 1 FROM work_tasks WHERE organization_id=? AND workspace_id=?
                           AND session_id=? AND lower(created_by_actor_id)<>? LIMIT 1""",
                        (org, workspace, str(task["session_id"]), actor or ""),
                    ).fetchone()
                    foreign_teams_route = conn.execute(
                        """SELECT 1 FROM work_connector_actor_threads WHERE organization_id=?
                           AND workspace_id=? AND session_id=? AND actor_subject<>? LIMIT 1""",
                        (org, workspace, str(task["session_id"]), actor or ""),
                    ).fetchone()
                    if shared is not None and foreign_task is None and foreign_teams_route is None:
                        row = shared
            else:
                self._require_no_foreign_teams_session(
                    conn, org, workspace, str(task["session_id"]), actor
                )
                row = conn.execute(
                    """SELECT backend,native_session_id FROM work_backend_sessions
                       WHERE organization_id=? AND workspace_id=? AND session_id=? AND backend=?""",
                    (org, workspace, str(task["session_id"]), backend),
                ).fetchone()
            if row is None:
                return None
            return {
                "backend": str(row["backend"]),
                "sessionId": str(task["session_id"]),
                "nativeSessionId": str(row["native_session_id"]),
            }

    def bind_backend_session(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        backend: str,
        native_session_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> JsonObject:
        """Bind a new ACP identity once; never replace another session mapping.

        The task claim and unique workspace/session key make the first binding
        authoritative. Repeated identical writes are idempotent; conflicting
        native ids fail closed to prevent accidental context replacement.
        中文：同一 Workspace/Work Session 的 ACP ID 只允许首次绑定或原值重放。
        """

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(task_id, "task id")
        backend = _identifier(backend, "backend")
        native_session_id = _identifier(native_session_id, "native session id")
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        if backend != "codebuddy-acp":
            raise _invalid(
                "WORK_BACKEND_SESSION_INVALID", "The native execution backend is not supported."
            )
        now = _unix_ms()
        with self._mutation() as conn:
            task = self._require_task(conn, org, workspace, task_id)
            is_teams_task = self._require_teams_task_actor(
                conn,
                org,
                workspace,
                task_id,
                actor,
                actor_private_scope=actor_private_scope,
            )
            if str(task["status"]) != "running":
                raise _conflict(
                    "WORK_BACKEND_SESSION_TASK_NOT_RUNNING",
                    "Native session mappings require the active running Work Task.",
                )
            session_id = str(task["session_id"])
            if is_teams_task or actor_private_scope:
                row = conn.execute(
                    """SELECT native_session_id FROM work_backend_actor_sessions
                       WHERE organization_id=? AND workspace_id=? AND actor_id=?
                         AND session_id=? AND backend=?""",
                    (org, workspace, actor or "", session_id, backend),
                ).fetchone()
            else:
                self._require_no_foreign_teams_session(conn, org, workspace, session_id, actor)
                row = conn.execute(
                    """SELECT native_session_id FROM work_backend_sessions
                       WHERE organization_id=? AND workspace_id=? AND session_id=? AND backend=?""",
                    (org, workspace, session_id, backend),
                ).fetchone()
            if row is not None:
                if str(row["native_session_id"]) != native_session_id:
                    raise _conflict(
                        "WORK_BACKEND_SESSION_CONFLICT",
                        "The Work session is already bound to a different native session.",
                    )
                return {
                    "backend": backend,
                    "sessionId": session_id,
                    "nativeSessionId": native_session_id,
                }
            if is_teams_task or actor_private_scope:
                conn.execute(
                    """INSERT INTO work_backend_actor_sessions(
                           organization_id,workspace_id,actor_id,session_id,backend,
                           native_session_id,created_at
                       ) VALUES(?,?,?,?,?,?,?)""",
                    (org, workspace, actor or "", session_id, backend, native_session_id, now),
                )
            else:
                conn.execute(
                    """INSERT INTO work_backend_sessions(
                           organization_id,workspace_id,session_id,backend,native_session_id,created_at
                       ) VALUES(?,?,?,?,?,?)""",
                    (org, workspace, session_id, backend, native_session_id, now),
                )
            return {
                "backend": backend,
                "sessionId": session_id,
                "nativeSessionId": native_session_id,
            }

    def list_tasks(
        self,
        organization_id: str | None,
        workspace_id: str,
        *,
        limit: int = 50,
        cursor: str | None = None,
        created_by_actor_id: str | None = None,
        request_actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> tuple[list[JsonObject], str | None]:
        """List tasks using a stable created-time cursor. | 按稳定游标列出任务。"""

        org, workspace = _scope(organization_id, workspace_id)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise _invalid("WORK_TASK_INVALID_PAGE", "limit must be between 1 and 100")
        actor = (
            _identifier(created_by_actor_id, "createdByActorId")
            if created_by_actor_id is not None
            else None
        )
        requesting_actor = (
            _identifier(request_actor_id, "actorId").lower()
            if request_actor_id is not None
            else None
        )
        cursor_value = _decode_cursor(cursor) if cursor else None
        with self._read() as conn:
            filters = "organization_id=? AND workspace_id=?"
            scope_params: list[Any] = [org, workspace]
            if requesting_actor is not None:
                filters += " AND (NOT EXISTS (SELECT 1 FROM work_task_private_owners private_owner "
                filters += "WHERE private_owner.organization_id=work_tasks.organization_id "
                filters += "AND private_owner.workspace_id=work_tasks.workspace_id "
                filters += "AND private_owner.task_id=work_tasks.task_id) OR EXISTS ("
                filters += "SELECT 1 FROM work_task_private_owners private_owner WHERE "
                filters += "private_owner.organization_id=work_tasks.organization_id "
                filters += "AND private_owner.workspace_id=work_tasks.workspace_id "
                filters += "AND private_owner.task_id=work_tasks.task_id AND "
                filters += "lower(private_owner.actor_id)=?))"
                scope_params.append(requesting_actor)
                if actor_private_scope:
                    filters += " AND lower(created_by_actor_id)=?"
                    scope_params.append(requesting_actor)
                filters += " AND (NOT EXISTS (SELECT 1 FROM work_task_teams_origins teams_origin "
                filters += "WHERE teams_origin.organization_id=work_tasks.organization_id "
                filters += "AND teams_origin.workspace_id=work_tasks.workspace_id "
                filters += "AND teams_origin.task_id=work_tasks.task_id) OR EXISTS ("
                filters += "SELECT 1 FROM work_task_teams_origins teams_origin WHERE "
                filters += "teams_origin.organization_id=work_tasks.organization_id "
                filters += "AND teams_origin.workspace_id=work_tasks.workspace_id "
                filters += "AND teams_origin.task_id=work_tasks.task_id AND "
                filters += "teams_origin.actor_id=?))"
                scope_params.append(requesting_actor)
            if actor is not None:
                filters += " AND created_by_actor_id=?"
                scope_params.append(actor)
            if cursor_value is None:
                rows = conn.execute(
                    f"SELECT * FROM work_tasks WHERE {filters} "
                    "ORDER BY created_at DESC,task_id ASC LIMIT ?",
                    [*scope_params, limit + 1],
                ).fetchall()
            else:
                created_at, task_id = cursor_value
                rows = conn.execute(
                    f"SELECT * FROM work_tasks WHERE {filters} "
                    "AND (created_at<? OR (created_at=? AND task_id>?)) "
                    "ORDER BY created_at DESC,task_id ASC LIMIT ?",
                    [*scope_params, created_at, created_at, task_id, limit + 1],
                ).fetchall()
            has_more = len(rows) > limit
            items = [self._task_view(conn, row) for row in rows[:limit]]
            next_cursor = None
            if has_more and items:
                last = rows[limit - 1]
                next_cursor = _encode_cursor(int(last["created_at"]), str(last["task_id"]))
            return items, next_cursor

    def patch_task(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        patch: Mapping[str, Any],
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
        private_scope: PrivateConversationScope | None = None,
    ) -> JsonObject:
        """Update an executor projection and append status history atomically. | 原子更新任务。"""

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(task_id, "task id")
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        allowed = {
            "prompt",
            "title",
            "description",
            "status",
            "output",
            "reasoning",
            "error",
            "metadata",
        }
        if not patch or set(patch) - allowed:
            raise _invalid(
                "WORK_TASK_INVALID_PATCH",
                "The task patch contains no fields or unknown fields.",
            )
        now = _unix_ms()
        with self._mutation() as conn:
            row = self._require_task(conn, org, workspace, task_id)
            self._require_teams_task_actor(
                conn,
                org,
                workspace,
                task_id,
                actor,
                actor_private_scope=actor_private_scope,
            )
            old_status = str(row["status"])
            new_status = patch.get("status", old_status)
            if new_status != old_status:
                if old_status == "queued" and new_status == "running":
                    raise _conflict(
                        "WORK_TASK_CLAIM_REQUIRED",
                        "Queued tasks enter execution only through the single-winner claim route.",
                    )
                if new_status == "waiting_approval" or (
                    old_status == "waiting_approval" and new_status == "running"
                ):
                    raise _conflict(
                        "WORK_TASK_APPROVAL_REQUIRED",
                        "Approval-waiting transitions must use the correlated approval routes.",
                    )
                if new_status == "waiting_input" or (
                    old_status == "waiting_input" and new_status == "running"
                ):
                    raise _conflict(
                        "WORK_INPUT_REQUEST_REQUIRED",
                        "Input-waiting transitions must use the correlated input routes.",
                    )
                if new_status not in _TASK_TRANSITIONS[old_status]:
                    raise _conflict(
                        "WORK_TASK_INVALID_TRANSITION",
                        f"The task cannot transition from {old_status} to {new_status}.",
                    )
            values: dict[str, Any] = {}
            for field, maximum in (
                ("prompt", 100_000),
                ("title", 512),
                ("description", 20_000),
                ("output", 2_000_000),
                ("reasoning", 2_000_000),
                ("error", 200_000),
            ):
                if field in patch:
                    value = patch[field]
                    if value is not None:
                        value = _bounded_text(
                            value,
                            field,
                            maximum,
                            allow_empty=field in {"output", "reasoning"},
                        )
                    elif field == "prompt":
                        raise _invalid("WORK_TASK_INVALID_PATCH", "prompt cannot be cleared")
                    elif field in {"output", "reasoning"}:
                        value = ""
                    values[field] = value
            if "metadata" in patch:
                metadata = _json_object(patch["metadata"], "metadata")
                _task_notification_descriptor(metadata)
                values["metadata_json"] = _json_text(metadata)
            started_at = row["started_at"]
            ended_at = row["ended_at"]
            if new_status == "running" and started_at is None:
                started_at = now
                values["started_at"] = now
            if new_status in _TERMINAL_TASK_STATES and ended_at is None:
                ended_at = now
                values["ended_at"] = now
                if started_at is not None:
                    values["duration_ms"] = max(0, now - int(started_at))
            if new_status != old_status:
                values["status"] = new_status
            assignments = ",".join(f"{column}=?" for column in values)
            if assignments:
                update_sql = (
                    f"UPDATE work_tasks SET {assignments} "
                    "WHERE organization_id=? AND workspace_id=? AND task_id=?"
                )
                conn.execute(
                    update_sql,
                    (*values.values(), org, workspace, task_id),
                )
                if new_status != old_status:
                    self._append_event(
                        conn,
                        org,
                        workspace,
                        task_id,
                        {
                            "type": "task.status_changed",
                            "from": old_status,
                            "to": new_status,
                        },
                        None,
                        now,
                    )
                    if new_status in _TERMINAL_TASK_STATES:
                        terminal = self._require_task(conn, org, workspace, task_id)
                        self._queue_task_result_notification(
                            conn,
                            org,
                            workspace,
                            terminal,
                            now,
                            private_scope=private_scope,
                        )
            return self._task_view(conn, self._require_task(conn, org, workspace, task_id))

    def claim_task(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> tuple[bool, JsonObject]:
        """Atomically claim only queued work before any executor side effect. | 单赢家认领任务。"""

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(task_id, "task id")
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        now = _unix_ms()
        with self._mutation() as conn:
            task = self._require_task(conn, org, workspace, task_id)
            self._require_teams_task_actor(
                conn,
                org,
                workspace,
                task_id,
                actor,
                actor_private_scope=actor_private_scope,
            )
            if str(task["status"]) != "queued":
                return False, self._task_view(conn, task)
            conn.execute(
                """UPDATE work_tasks SET status='running',started_at=COALESCE(started_at,?)
                   WHERE organization_id=? AND workspace_id=? AND task_id=? AND status='queued'""",
                (now, org, workspace, task_id),
            )
            self._append_event(
                conn,
                org,
                workspace,
                task_id,
                {"type": "task.status_changed", "from": "queued", "to": "running"},
                None,
                now,
            )
            return True, self._task_view(conn, self._require_task(conn, org, workspace, task_id))

    def append_task_event(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        event: Mapping[str, Any],
        message_id: str | None,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> tuple[int, JsonObject, bool, JsonObject, int]:
        """Append an idempotent task event and return its committed task view. |
        幂等追加任务事件。"""

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(task_id, "task id")
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        normalized = _json_object(event, "event")
        event_type = normalized.get("type")
        if not isinstance(event_type, str) or not event_type.strip() or len(event_type) > 256:
            raise _invalid("WORK_TASK_INVALID_EVENT", "event.type must be non-empty text")
        if message_id is not None:
            message_id = _identifier(message_id, "messageId")
        now = _unix_ms()
        digest = _digest(normalized)
        with self._mutation() as conn:
            self._require_task(conn, org, workspace, task_id)
            self._require_teams_task_actor(
                conn,
                org,
                workspace,
                task_id,
                actor,
                actor_private_scope=actor_private_scope,
            )
            if message_id is not None:
                prior = conn.execute(
                    """SELECT seq,event_json,event_digest,created_at FROM work_task_events
                       WHERE organization_id=? AND workspace_id=? AND task_id=? AND message_id=?""",
                    (org, workspace, task_id, message_id),
                ).fetchone()
                if prior is not None:
                    if str(prior["event_digest"]) != digest:
                        raise _conflict(
                            "WORK_TASK_EVENT_ID_CONFLICT",
                            "messageId was already used for a different event.",
                        )
                    return (
                        int(prior["seq"]),
                        _stored_object(prior["event_json"], "task event"),
                        True,
                        self._task_view(conn, self._require_task(conn, org, workspace, task_id)),
                        int(prior["created_at"]),
                    )
            seq = self._append_event(conn, org, workspace, task_id, normalized, message_id, now)
            return (
                seq,
                normalized,
                False,
                self._task_view(conn, self._require_task(conn, org, workspace, task_id)),
                now,
            )

    def get_task_events(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        after: int = 0,
        limit: int = 1_000,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> tuple[list[JsonObject], int]:
        """Read a contiguous event page after an exclusive sequence cursor. | 读取任务事件。"""

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(task_id, "task id")
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        if (
            type(after) is not int
            or after < 0
            or type(limit) is not int
            or not 1 <= limit <= 10_000
        ):
            raise _invalid("WORK_TASK_INVALID_CURSOR", "after must be non-negative and limit valid")
        with self._read() as conn:
            task = self._require_task(conn, org, workspace, task_id)
            self._require_teams_task_actor(
                conn,
                org,
                workspace,
                task_id,
                actor,
                actor_private_scope=actor_private_scope,
            )
            rows = conn.execute(
                """SELECT seq,event_json,created_at,message_id FROM work_task_events
                   WHERE organization_id=? AND workspace_id=? AND task_id=? AND seq>?
                   ORDER BY seq LIMIT ?""",
                (org, workspace, task_id, after, limit),
            ).fetchall()
            events = [
                {
                    "seq": int(row["seq"]),
                    "event": _stored_object(row["event_json"], "task event"),
                    "createdAt": int(row["created_at"]),
                    **({"messageId": str(row["message_id"])} if row["message_id"] else {}),
                }
                for row in rows
            ]
            return events, int(task["sequence"]) + 1

    def create_approval(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        body: Mapping[str, Any],
        actor_id: str,
        *,
        actor_private_scope: bool = False,
    ) -> tuple[JsonObject, JsonObject, bool]:
        """Create one pending approval while moving its task to waiting_approval. | 建审批门。"""

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(task_id, "task id")
        kind = _bounded_text(body.get("kind"), "kind", 128)
        summary = _bounded_text(body.get("summary"), "summary", 2_000)
        details = _json_object(body.get("details", {}), "details")
        message_id = body.get("messageId")
        if message_id is not None:
            message_id = _identifier(message_id, "messageId")
        digest = _digest({"taskId": task_id, "kind": kind, "summary": summary, "details": details})
        now = _unix_ms()
        approval_id = uuid4().hex
        actor_id = _identifier(actor_id, "actor id")
        with self._mutation() as conn:
            task = self._require_task(conn, org, workspace, task_id)
            self._require_teams_task_actor(
                conn,
                org,
                workspace,
                task_id,
                actor_id.lower(),
                actor_private_scope=actor_private_scope,
            )
            if message_id:
                duplicate = conn.execute(
                    """SELECT * FROM work_approvals WHERE organization_id=? AND workspace_id=?
                       AND create_message_id=?""",
                    (org, workspace, message_id),
                ).fetchone()
                if duplicate:
                    if str(duplicate["create_digest"]) != digest:
                        raise _conflict(
                            "WORK_APPROVAL_ID_CONFLICT",
                            "messageId names another approval.",
                        )
                    return self._approval_view(duplicate), self._task_view(conn, task), True
            pending = conn.execute(
                """SELECT 1 FROM work_approvals WHERE organization_id=? AND workspace_id=?
                   AND task_id=? AND status='pending' LIMIT 1""",
                (org, workspace, task_id),
            ).fetchone()
            if pending:
                raise _conflict(
                    "WORK_APPROVAL_ALREADY_PENDING",
                    "The task already has a pending approval.",
                )
            current = str(task["status"])
            if current not in {"queued", "running"}:
                raise _conflict(
                    "WORK_APPROVAL_TASK_STATE_INVALID",
                    "Approvals can be created only for queued or running tasks.",
                )
            conn.execute(
                """INSERT INTO work_approvals(
                    organization_id,workspace_id,approval_id,task_id,kind,summary,details_json,
                    status,created_at,resolved_at,resolved_by,message_id,create_message_id,
                    create_digest,resolution_digest
                ) VALUES(?,?,?,?,?,?,?,'pending',?,NULL,NULL,NULL,?,?,NULL)""",
                (
                    org,
                    workspace,
                    approval_id,
                    task_id,
                    kind,
                    summary,
                    _json_text(details),
                    now,
                    message_id,
                    digest,
                ),
            )
            conn.execute(
                (
                    "UPDATE work_tasks SET status='waiting_approval' WHERE organization_id=? "
                    "AND workspace_id=? AND task_id=?"
                ),
                (org, workspace, task_id),
            )
            self._append_event(
                conn,
                org,
                workspace,
                task_id,
                {
                    "type": "task.status_changed",
                    "from": current,
                    "to": "waiting_approval",
                },
                None,
                now,
            )
            self._append_event(
                conn,
                org,
                workspace,
                task_id,
                {"type": "approval.created", "approvalId": approval_id, "kind": kind},
                None,
                now,
            )
            return (
                self._approval_view(
                    conn.execute(
                        (
                            "SELECT * FROM work_approvals WHERE organization_id=? AND "
                            "workspace_id=? AND approval_id=?"
                        ),
                        (org, workspace, approval_id),
                    ).fetchone()
                ),
                self._task_view(conn, self._require_task(conn, org, workspace, task_id)),
                False,
            )

    def get_approval(
        self,
        organization_id: str | None,
        workspace_id: str,
        approval_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> JsonObject:
        """Read an approval only within the current organization and Workspace. | 读取审批。"""

        org, workspace = _scope(organization_id, workspace_id)
        with self._read() as conn:
            row = self._require_approval(conn, org, workspace, approval_id)
            self._require_teams_task_actor(
                conn,
                org,
                workspace,
                str(row["task_id"]),
                _identifier(actor_id, "actorId").lower() if actor_id is not None else None,
                actor_private_scope=actor_private_scope,
            )
            return self._approval_view(row)

    def list_approvals(
        self,
        organization_id: str | None,
        workspace_id: str,
        status: str | None = None,
        limit: int = 100,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> list[JsonObject]:
        """List pending or historical decisions within one authorized Workspace. | 列审批。"""

        org, workspace = _scope(organization_id, workspace_id)
        if type(limit) is not int or not 1 <= limit <= 500:
            raise _invalid("WORK_APPROVAL_INVALID_PAGE", "limit must be between 1 and 500")
        if status not in {None, "pending", "approved", "rejected"}:
            raise _invalid("WORK_APPROVAL_INVALID_STATUS", "status is not a valid approval state")
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else ""
        visibility = """AND (
            (NOT EXISTS (SELECT 1 FROM work_task_teams_origins origin WHERE
                origin.organization_id=work_approvals.organization_id AND
                origin.workspace_id=work_approvals.workspace_id AND
                origin.task_id=work_approvals.task_id) AND
             (NOT EXISTS (SELECT 1 FROM work_task_private_owners private_owner WHERE
                private_owner.organization_id=work_approvals.organization_id AND
                private_owner.workspace_id=work_approvals.workspace_id AND
                private_owner.task_id=work_approvals.task_id) OR EXISTS (
                SELECT 1 FROM work_task_private_owners private_owner WHERE
                private_owner.organization_id=work_approvals.organization_id AND
                private_owner.workspace_id=work_approvals.workspace_id AND
                private_owner.task_id=work_approvals.task_id AND
                lower(private_owner.actor_id)=?)) AND
             (?=0 OR EXISTS (SELECT 1 FROM work_tasks task WHERE
                task.organization_id=work_approvals.organization_id AND
                task.workspace_id=work_approvals.workspace_id AND
                task.task_id=work_approvals.task_id
                AND lower(task.created_by_actor_id)=?))) OR
            EXISTS (SELECT 1 FROM work_task_teams_origins origin WHERE
                origin.organization_id=work_approvals.organization_id AND
                origin.workspace_id=work_approvals.workspace_id AND
                origin.task_id=work_approvals.task_id AND lower(origin.actor_id)=?)
        )"""
        with self._read() as conn:
            if status:
                rows = conn.execute(
                    """SELECT * FROM work_approvals WHERE organization_id=? AND
                    workspace_id=? AND status=? """
                    + visibility
                    + " ORDER BY created_at DESC LIMIT ?",
                    (org, workspace, actor, int(actor_private_scope), actor, actor, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT * FROM work_approvals WHERE organization_id=? AND workspace_id=? """
                    + visibility
                    + " ORDER BY created_at DESC LIMIT ?",
                    (org, workspace, actor, int(actor_private_scope), actor, actor, limit),
                ).fetchall()
            return [self._approval_view(row) for row in rows]

    def resolve_approval(
        self,
        organization_id: str | None,
        workspace_id: str,
        approval_id: str,
        decision: str,
        message_id: str | None,
        actor_id: str,
        *,
        actor_private_scope: bool = False,
        private_scope: PrivateConversationScope | None = None,
    ) -> tuple[JsonObject, JsonObject, bool]:
        """Resolve a pending approval once and transition the correlated task. | 一次性决策。"""

        org, workspace = _scope(organization_id, workspace_id)
        approval_id = _identifier(approval_id, "approval id")
        if decision not in {"approved", "rejected"}:
            raise _invalid(
                "WORK_APPROVAL_INVALID_DECISION",
                "decision must be approved or rejected",
            )
        if message_id is not None:
            message_id = _identifier(message_id, "messageId")
        actor_id = _identifier(actor_id, "actor id")
        digest = _digest({"decision": decision})
        now = _unix_ms()
        with self._mutation() as conn:
            approval = self._require_approval(conn, org, workspace, approval_id)
            task_id = str(approval["task_id"])
            task = self._require_task(conn, org, workspace, task_id)
            self._require_teams_task_actor(
                conn,
                org,
                workspace,
                task_id,
                actor_id.lower(),
                actor_private_scope=actor_private_scope,
            )
            old_status = str(approval["status"])
            if old_status != "pending":
                if (
                    str(approval["resolution_digest"] or "") == digest
                    and message_id is not None
                    and str(approval["message_id"] or "") == message_id
                ):
                    return self._approval_view(approval), self._task_view(conn, task), True
                raise _conflict(
                    "WORK_APPROVAL_ALREADY_RESOLVED",
                    (
                        "The approval has already been resolved and cannot be replayed with "
                        "a different decision."
                    ),
                )
            if str(task["status"]) != "waiting_approval":
                raise _conflict(
                    "WORK_APPROVAL_TASK_STATE_INVALID",
                    "The correlated task is no longer waiting for this approval.",
                )
            new_task_status = "running" if decision == "approved" else "aborted"
            ended_at = now if new_task_status in _TERMINAL_TASK_STATES else None
            started_at = task["started_at"]
            duration = (
                max(0, now - int(started_at)) if ended_at is not None and started_at else None
            )
            conn.execute(
                """UPDATE work_approvals SET status=?,resolved_at=?,resolved_by=?,message_id=?,
                   resolution_digest=? WHERE organization_id=? AND workspace_id=? AND approval_id=?
                   AND status='pending'""",
                (
                    decision,
                    now,
                    actor_id,
                    message_id,
                    digest,
                    org,
                    workspace,
                    approval_id,
                ),
            )
            conn.execute(
                """UPDATE work_tasks SET status=?,started_at=COALESCE(started_at,?),
                   ended_at=COALESCE(ended_at,?),duration_ms=COALESCE(duration_ms,?)
                   WHERE organization_id=? AND workspace_id=? AND task_id=?""",
                (
                    new_task_status,
                    now if new_task_status == "running" else None,
                    ended_at,
                    duration,
                    org,
                    workspace,
                    task_id,
                ),
            )
            self._append_event(
                conn,
                org,
                workspace,
                task_id,
                {"type": "approval." + decision, "approvalId": approval_id},
                None,
                now,
            )
            self._append_event(
                conn,
                org,
                workspace,
                task_id,
                {
                    "type": "task.status_changed",
                    "from": "waiting_approval",
                    "to": new_task_status,
                },
                None,
                now,
            )
            approval = self._require_approval(conn, org, workspace, approval_id)
            task = self._require_task(conn, org, workspace, task_id)
            if new_task_status in _TERMINAL_TASK_STATES:
                self._queue_task_result_notification(
                    conn,
                    org,
                    workspace,
                    task,
                    now,
                    private_scope=private_scope,
                )
            return self._approval_view(approval), self._task_view(conn, task), False

    def create_input_request(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        body: Mapping[str, Any],
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> tuple[JsonObject, JsonObject, bool]:
        """Pause a task on one durable human-input request. | 持久化输入请求并暂停任务。"""

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(task_id, "task id")
        summary = _bounded_text(body.get("summary"), "summary", 2_000)
        details = _human_input_object(body.get("details", {}), "details")
        message_id = body.get("messageId")
        if message_id is not None:
            message_id = _identifier(message_id, "messageId")
        digest = _digest({"taskId": task_id, "summary": summary, "details": details})
        now = _unix_ms()
        input_id = uuid4().hex
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        with self._mutation() as conn:
            task = self._require_task(conn, org, workspace, task_id)
            self._require_teams_task_actor(
                conn,
                org,
                workspace,
                task_id,
                actor,
                actor_private_scope=actor_private_scope,
            )
            if message_id is not None:
                prior = conn.execute(
                    """SELECT * FROM work_inputs WHERE organization_id=? AND workspace_id=?
                       AND create_message_id=?""",
                    (org, workspace, message_id),
                ).fetchone()
                if prior is not None:
                    if str(prior["create_digest"]) != digest:
                        raise _conflict(
                            "WORK_INPUT_ID_CONFLICT",
                            "messageId names another input request.",
                        )
                    return self._input_view(prior), self._task_view(conn, task), True
            if str(task["status"]) != "running":
                raise _conflict(
                    "WORK_TASK_NOT_ACTIVE",
                    "Input requests can be created only by a running task.",
                )
            pending = conn.execute(
                """SELECT 1 FROM work_inputs WHERE organization_id=? AND workspace_id=?
                   AND task_id=? AND status='pending' LIMIT 1""",
                (org, workspace, task_id),
            ).fetchone()
            if pending is not None:
                raise _conflict(
                    "WORK_INPUT_ALREADY_PENDING",
                    "The task already has a pending input request.",
                )
            conn.execute(
                """INSERT INTO work_inputs(
                   organization_id,workspace_id,input_id,task_id,summary,details_json,status,
                   created_at,answered_at,answered_by,answer_json,create_message_id,
                   answer_message_id,create_digest,answer_digest)
                   VALUES(?,?,?,?,?,?,'pending',?,NULL,NULL,NULL,?,NULL,?,NULL)""",
                (
                    org,
                    workspace,
                    input_id,
                    task_id,
                    summary,
                    _json_text(details),
                    now,
                    message_id,
                    digest,
                ),
            )
            conn.execute(
                """UPDATE work_tasks SET status='waiting_input'
                   WHERE organization_id=? AND workspace_id=? AND task_id=? AND status='running'""",
                (org, workspace, task_id),
            )
            self._append_event(
                conn,
                org,
                workspace,
                task_id,
                {"type": "input.requested", "inputId": input_id, "summary": summary},
                None,
                now,
            )
            self._append_event(
                conn,
                org,
                workspace,
                task_id,
                {"type": "task.status_changed", "from": "running", "to": "waiting_input"},
                None,
                now,
            )
            input_record = conn.execute(
                "SELECT * FROM work_inputs WHERE organization_id=? AND workspace_id=? "
                "AND input_id=?",
                (org, workspace, input_id),
            ).fetchone()
            return (
                self._input_view(input_record),
                self._task_view(conn, self._require_task(conn, org, workspace, task_id)),
                False,
            )

    def get_input_request(
        self,
        organization_id: str | None,
        workspace_id: str,
        input_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> JsonObject:
        """Read one pending or answered input request within the current scope. | 读取输入请求。"""

        org, workspace = _scope(organization_id, workspace_id)
        with self._read() as conn:
            row = self._require_input(conn, org, workspace, input_id)
            self._require_teams_task_actor(
                conn,
                org,
                workspace,
                str(row["task_id"]),
                _identifier(actor_id, "actorId").lower() if actor_id is not None else None,
                actor_private_scope=actor_private_scope,
            )
            return self._input_view(row)

    def list_input_requests(
        self,
        organization_id: str | None,
        workspace_id: str,
        status: str | None = None,
        limit: int = 100,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> list[JsonObject]:
        """List human input requests for a Workspace control surface. | 列出待处理输入。"""

        org, workspace = _scope(organization_id, workspace_id)
        if status not in {None, "pending", "answered"}:
            raise _invalid("WORK_INPUT_INVALID_STATUS", "status is not a valid input state")
        if type(limit) is not int or not 1 <= limit <= 500:
            raise _invalid("WORK_INPUT_INVALID_PAGE", "limit must be between 1 and 500")
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else ""
        visibility = """AND (
            (NOT EXISTS (SELECT 1 FROM work_task_teams_origins origin WHERE
                origin.organization_id=work_inputs.organization_id AND
                origin.workspace_id=work_inputs.workspace_id AND
                origin.task_id=work_inputs.task_id) AND
             (NOT EXISTS (SELECT 1 FROM work_task_private_owners private_owner WHERE
                private_owner.organization_id=work_inputs.organization_id AND
                private_owner.workspace_id=work_inputs.workspace_id AND
                private_owner.task_id=work_inputs.task_id) OR EXISTS (
                SELECT 1 FROM work_task_private_owners private_owner WHERE
                private_owner.organization_id=work_inputs.organization_id AND
                private_owner.workspace_id=work_inputs.workspace_id AND
                private_owner.task_id=work_inputs.task_id AND
                lower(private_owner.actor_id)=?)) AND
             (?=0 OR EXISTS (SELECT 1 FROM work_tasks task WHERE
                task.organization_id=work_inputs.organization_id AND
                task.workspace_id=work_inputs.workspace_id AND task.task_id=work_inputs.task_id
                AND lower(task.created_by_actor_id)=?))) OR
            EXISTS (SELECT 1 FROM work_task_teams_origins origin WHERE
                origin.organization_id=work_inputs.organization_id AND
                origin.workspace_id=work_inputs.workspace_id AND origin.task_id=work_inputs.task_id
                AND lower(origin.actor_id)=?)
        )"""
        with self._read() as conn:
            if status is None:
                rows = conn.execute(
                    """SELECT * FROM work_inputs WHERE organization_id=? AND workspace_id=? """
                    + visibility
                    + " ORDER BY created_at DESC,input_id LIMIT ?",
                    (org, workspace, actor, int(actor_private_scope), actor, actor, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT * FROM work_inputs WHERE organization_id=? AND workspace_id=?
                       AND status=? """
                    + visibility
                    + " ORDER BY created_at DESC,input_id LIMIT ?",
                    (org, workspace, status, actor, int(actor_private_scope), actor, actor, limit),
                ).fetchall()
            return [self._input_view(row) for row in rows]

    def resolve_input_request(
        self,
        organization_id: str | None,
        workspace_id: str,
        input_id: str,
        answer: Mapping[str, Any],
        message_id: str,
        actor_id: str,
        *,
        actor_private_scope: bool = False,
    ) -> tuple[JsonObject, JsonObject, bool]:
        """Store one answer and resume its task atomically. | 持久化回答并恢复任务。"""

        org, workspace = _scope(organization_id, workspace_id)
        input_id = _identifier(input_id, "input id")
        message_id = _identifier(message_id, "messageId")
        actor_id = _identifier(actor_id, "actor id")
        answer_obj = _human_input_object(answer, "answer")
        digest = _digest({"answer": answer_obj})
        now = _unix_ms()
        with self._mutation() as conn:
            input_record = self._require_input(conn, org, workspace, input_id)
            task_id = str(input_record["task_id"])
            task = self._require_task(conn, org, workspace, task_id)
            self._require_teams_task_actor(
                conn,
                org,
                workspace,
                task_id,
                actor_id.lower(),
                actor_private_scope=actor_private_scope,
            )
            if str(input_record["status"]) == "answered":
                if (
                    str(input_record["answer_digest"] or "") == digest
                    and str(input_record["answer_message_id"] or "") == message_id
                ):
                    return self._input_view(input_record), self._task_view(conn, task), True
                raise _conflict(
                    "WORK_INPUT_ALREADY_ANSWERED",
                    "The input request has already been answered and cannot be changed.",
                )
            if str(task["status"]) != "waiting_input":
                raise _conflict(
                    "WORK_INPUT_TASK_STATE_INVALID",
                    "The correlated task is no longer waiting for this input.",
                )
            conn.execute(
                """UPDATE work_inputs SET status='answered',answered_at=?,answered_by=?,
                   answer_json=?,answer_message_id=?,answer_digest=?
                   WHERE organization_id=? AND workspace_id=? AND input_id=?
                     AND status='pending'""",
                (
                    now,
                    actor_id,
                    _json_text(answer_obj),
                    message_id,
                    digest,
                    org,
                    workspace,
                    input_id,
                ),
            )
            conn.execute(
                """UPDATE work_tasks SET status='running'
                   WHERE organization_id=? AND workspace_id=? AND task_id=?
                     AND status='waiting_input'""",
                (org, workspace, task_id),
            )
            self._append_event(
                conn,
                org,
                workspace,
                task_id,
                {"type": "input.answered", "inputId": input_id},
                None,
                now,
            )
            self._append_event(
                conn,
                org,
                workspace,
                task_id,
                {"type": "task.status_changed", "from": "waiting_input", "to": "running"},
                None,
                now,
            )
            return (
                self._input_view(self._require_input(conn, org, workspace, input_id)),
                self._task_view(conn, self._require_task(conn, org, workspace, task_id)),
                False,
            )

    def create_operation(
        self,
        organization_id: str | None,
        workspace_id: str,
        body: Mapping[str, Any],
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> tuple[JsonObject, bool]:
        """Record intent before an external effect and never replay it here. | 只记录操作意图。"""

        org, workspace = _scope(organization_id, workspace_id)
        key = _identifier(body.get("idempotencyKey"), "idempotencyKey")
        operation_type = _bounded_text(body.get("operationType"), "operationType", 128)
        task_id = _optional_text(body.get("taskId"), "taskId", 512)
        target = _optional_text(body.get("target"), "target", 2_000)
        scope_lock = _optional_text(body.get("scopeLock"), "scopeLock", 100)
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        request = _json_object(body.get("request", {}), "request")
        digest_value = {
            "operationType": operation_type,
            "taskId": task_id,
            "target": target,
            "request": request,
        }
        if scope_lock is not None:
            if (
                not re.fullmatch(r"connector-branch:[a-f0-9]{64}", scope_lock)
                or not operation_type.startswith("tool.provider.v1:")
                or operation_type.rsplit(":", 1)[-1]
                not in {
                    "github.branch.create",
                    "github.branch.delete",
                    "github.file.commit",
                    "github.pull_request.draft.create",
                    "github.actions.rerun_failed",
                }
                or target is None
                or not target.startswith("connector-target:")
            ):
                raise _invalid(
                    "WORK_OPERATION_SCOPE_LOCK_INVALID",
                    "scopeLock is reserved for a host-bound GitHub branch operation.",
                )
            digest_value["scopeLock"] = scope_lock
        digest = _digest(digest_value)
        now = _unix_ms()
        with self._mutation() as conn:
            if task_id is not None:
                self._require_running_task(conn, org, workspace, task_id)
                self._require_teams_task_actor(
                    conn,
                    org,
                    workspace,
                    task_id,
                    actor,
                    actor_private_scope=actor_private_scope,
                )
            prior = conn.execute(
                """SELECT * FROM work_operations WHERE organization_id=? AND workspace_id=?
                   AND idempotency_key=?""",
                (org, workspace, key),
            ).fetchone()
            if prior is not None:
                if str(prior["request_digest"]) != digest:
                    raise _conflict(
                        "WORK_OPERATION_KEY_CONFLICT",
                        "idempotencyKey names another operation.",
                    )
                return self._operation_view(prior), True
            if (
                operation_type.startswith("tool.provider.v1:")
                and target is not None
                and target.startswith("connector-target:")
            ):
                unresolved = conn.execute(
                    """SELECT 1 FROM work_operations WHERE organization_id=? AND workspace_id=?
                       AND target=? AND status IN ('started','uncertain') LIMIT 1""",
                    (org, workspace, target),
                ).fetchone()
                if unresolved is not None:
                    raise _conflict(
                        "WORK_OPERATION_TARGET_UNRESOLVED",
                        "An operation on this exact provider target still needs reconciliation.",
                    )
            if scope_lock is not None:
                unresolved_scope = conn.execute(
                    """SELECT 1 FROM work_operations WHERE organization_id=? AND workspace_id=?
                       AND scope_lock=? AND status IN ('started','uncertain') LIMIT 1""",
                    (org, workspace, scope_lock),
                ).fetchone()
                if unresolved_scope is not None:
                    raise _conflict(
                        "WORK_OPERATION_SCOPE_LOCKED",
                        "Another operation on this provider branch still needs reconciliation.",
                    )
            operation_id = uuid4().hex
            conn.execute(
                """INSERT INTO work_operations(
                   organization_id,workspace_id,operation_id,idempotency_key,operation_type,
                   task_id,target,scope_lock,request_json,status,evidence_json,request_digest,created_at,updated_at
                   ) VALUES(?,?,?,?,?,?,?,?,?,'started','{}',?,?,?)""",
                (
                    org,
                    workspace,
                    operation_id,
                    key,
                    operation_type,
                    task_id,
                    target,
                    scope_lock,
                    _json_text(request),
                    digest,
                    now,
                    now,
                ),
            )
            return self._operation_view(
                conn.execute(
                    (
                        "SELECT * FROM work_operations WHERE organization_id=? AND "
                        "workspace_id=? AND operation_id=?"
                    ),
                    (org, workspace, operation_id),
                ).fetchone()
            ), False

    def update_operation(
        self,
        organization_id: str | None,
        workspace_id: str,
        operation_id: str,
        status: str,
        evidence: Mapping[str, Any],
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> tuple[JsonObject, bool]:
        """Move started or uncertain receipts forward without a replay path. | 单向更新回执。"""

        org, workspace = _scope(organization_id, workspace_id)
        operation_id = _identifier(operation_id, "operation id")
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        evidence_obj = _json_object(evidence, "evidence")
        with self._mutation() as conn:
            row = conn.execute(
                """SELECT * FROM work_operations WHERE organization_id=? AND workspace_id=? AND
                    operation_id=?""",
                (org, workspace, operation_id),
            ).fetchone()
            if row is None:
                raise _not_found(
                    "WORK_OPERATION_NOT_FOUND",
                    "The operation does not exist in this Workspace.",
                )
            if row["task_id"] is not None:
                self._require_teams_task_actor(
                    conn,
                    org,
                    workspace,
                    str(row["task_id"]),
                    actor,
                    actor_private_scope=actor_private_scope,
                )
            current = str(row["status"])
            if current == status:
                if _stored_object(row["evidence_json"], "operation evidence") == evidence_obj:
                    return self._operation_view(row), True
                raise _conflict(
                    "WORK_OPERATION_ALREADY_RECORDED",
                    "The operation outcome is immutable.",
                )
            allowed = {
                "started": {"uncertain", "verified"},
                "uncertain": {"verified"},
                "verified": set(),
            }
            if status not in allowed[current]:
                raise _conflict(
                    "WORK_OPERATION_INVALID_TRANSITION",
                    "The operation receipt cannot move backward.",
                )
            now = _unix_ms()
            conn.execute(
                """UPDATE work_operations SET status=?,evidence_json=?,updated_at=?
                   WHERE organization_id=? AND workspace_id=? AND operation_id=?""",
                (status, _json_text(evidence_obj), now, org, workspace, operation_id),
            )
            updated = conn.execute(
                (
                    "SELECT * FROM work_operations WHERE organization_id=? AND "
                    "workspace_id=? AND operation_id=?"
                ),
                (org, workspace, operation_id),
            ).fetchone()
            return self._operation_view(updated), False

    def get_operation(
        self,
        organization_id: str | None,
        workspace_id: str,
        operation_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> JsonObject:
        """Read one operation receipt inside its exact tenant scope. | 读取范围内操作回执。"""

        org, workspace = _scope(organization_id, workspace_id)
        operation_id = _identifier(operation_id, "operation id")
        with self._read() as conn:
            row: sqlite3.Row | None = conn.execute(
                """SELECT * FROM work_operations WHERE organization_id=? AND workspace_id=?
                   AND operation_id=?""",
                (org, workspace, operation_id),
            ).fetchone()
            if row is None:
                raise _not_found(
                    "WORK_OPERATION_NOT_FOUND",
                    "The operation does not exist in this Workspace.",
                )
            if row["task_id"] is not None:
                self._require_teams_task_actor(
                    conn,
                    org,
                    workspace,
                    str(row["task_id"]),
                    _identifier(actor_id, "actorId").lower() if actor_id is not None else None,
                    actor_private_scope=actor_private_scope,
                )
            return self._operation_view(row)

    def list_unresolved_operations(
        self,
        organization_id: str | None,
        workspace_id: str,
        *,
        target: str | None = None,
        operation_type: str | None = None,
        limit: int = 100,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> list[JsonObject]:
        """List minimal started/uncertain receipts for exact-target reconciliation.

        中文：只返回目标/操作精确匹配的未解决回执，不泄露完整参数正文。
        """

        org, workspace = _scope(organization_id, workspace_id)
        target_value = _optional_text(target, "target", 2_000)
        operation_value = _optional_text(operation_type, "operationType", 128)
        if type(limit) is not int or not 1 <= limit <= 500:
            raise _invalid("WORK_OPERATION_INVALID_PAGE", "limit must be between 1 and 500")
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else ""
        filters = [
            "organization_id=?",
            "workspace_id=?",
            "status IN ('started','uncertain')",
        ]
        params: list[Any] = [org, workspace]
        filters.append(
            "((task_id IS NULL AND ?=0) OR EXISTS (SELECT 1 FROM work_tasks task "
            "WHERE task.organization_id=work_operations.organization_id "
            "AND task.workspace_id=work_operations.workspace_id "
            "AND task.task_id=work_operations.task_id AND "
            "((?=1 AND lower(task.created_by_actor_id)=?) OR (?=0 AND "
            "(NOT EXISTS (SELECT 1 FROM work_task_private_owners private_owner "
            "WHERE private_owner.organization_id=task.organization_id AND "
            "private_owner.workspace_id=task.workspace_id AND private_owner.task_id=task.task_id) "
            "OR EXISTS (SELECT 1 FROM work_task_private_owners private_owner WHERE "
            "private_owner.organization_id=task.organization_id AND "
            "private_owner.workspace_id=task.workspace_id AND private_owner.task_id=task.task_id "
            "AND lower(private_owner.actor_id)=?)) AND "
            "(NOT EXISTS (SELECT 1 FROM work_task_teams_origins origin "
            "WHERE origin.organization_id=task.organization_id AND "
            "origin.workspace_id=task.workspace_id AND origin.task_id=task.task_id) "
            "OR EXISTS (SELECT 1 FROM work_task_teams_origins origin WHERE "
            "origin.organization_id=task.organization_id AND "
            "origin.workspace_id=task.workspace_id AND origin.task_id=task.task_id "
            "AND lower(origin.actor_id)=?))))))"
        )
        params.extend(
            [
                int(actor_private_scope),
                int(actor_private_scope),
                actor,
                int(actor_private_scope),
                actor,
                actor,
            ]
        )
        if target_value is not None:
            filters.append("target=?")
            params.append(target_value)
        if operation_value is not None:
            filters.append("operation_type=?")
            params.append(operation_value)
        params.append(limit)
        with self._read() as conn:
            rows = conn.execute(
                "SELECT * FROM work_operations WHERE "
                + " AND ".join(filters)
                + " ORDER BY created_at,operation_id LIMIT ?",
                params,
            ).fetchall()
            return [
                {
                    "id": str(row["operation_id"]),
                    "operationType": str(row["operation_type"]),
                    "taskId": row["task_id"],
                    "target": row["target"],
                    "status": str(row["status"]),
                    "evidence": _stored_object(row["evidence_json"], "operation evidence"),
                    "createdAt": int(row["created_at"]),
                    "updatedAt": int(row["updated_at"]),
                }
                for row in rows
            ]

    def upsert_memory_fact(
        self,
        organization_id: str | None,
        workspace_id: str,
        body: Mapping[str, Any],
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> JsonObject:
        """Upsert one explicitly sourced fact without implying source completeness. |
        更新工作事实。"""

        org, workspace = _scope(organization_id, workspace_id)
        namespace = _bounded_text(body.get("namespace"), "namespace", 128)
        key = _bounded_text(body.get("key"), "key", 512)
        value = _json_object(body.get("value"), "value")
        source_id = _optional_text(body.get("sourceId"), "sourceId", 512)
        observed_at = body.get("observedAt")
        if observed_at is None:
            observed_at = _unix_ms()
        else:
            _nonnegative_integer(observed_at, "observedAt")
        fresh_until = body.get("freshUntil")
        if fresh_until is not None:
            _nonnegative_integer(fresh_until, "freshUntil")
        now = _unix_ms()
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        if actor_private_scope and actor is None:
            raise _invalid("WORK_MEMORY_ACTOR_REQUIRED", "actor-private memory requires an actor")
        with self._mutation() as conn:
            if actor_private_scope:
                prior = conn.execute(
                    """SELECT * FROM work_private_memory_facts WHERE organization_id=?
                       AND workspace_id=? AND actor_id=? AND namespace=? AND fact_key=?""",
                    (org, workspace, actor, namespace, key),
                ).fetchone()
                fact_id = str(prior["fact_id"]) if prior else uuid4().hex
                conn.execute(
                    """INSERT INTO work_private_memory_facts(organization_id,workspace_id,
                       actor_id,fact_id,namespace,fact_key,value_json,source_id,observed_at,
                       fresh_until,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(organization_id,workspace_id,actor_id,namespace,fact_key)
                       DO UPDATE SET value_json=excluded.value_json,source_id=excluded.source_id,
                       observed_at=excluded.observed_at,fresh_until=excluded.fresh_until,
                       updated_at=excluded.updated_at""",
                    (
                        org,
                        workspace,
                        actor,
                        fact_id,
                        namespace,
                        key,
                        _json_text(value),
                        source_id,
                        observed_at,
                        fresh_until,
                        now,
                    ),
                )
                row = conn.execute(
                    """SELECT * FROM work_private_memory_facts WHERE organization_id=?
                       AND workspace_id=? AND actor_id=? AND namespace=? AND fact_key=?""",
                    (org, workspace, actor, namespace, key),
                ).fetchone()
                return self._memory_view(conn, row)
            prior = conn.execute(
                """SELECT * FROM work_memory_facts WHERE organization_id=? AND workspace_id=?
                   AND namespace=? AND fact_key=?""",
                (org, workspace, namespace, key),
            ).fetchone()
            fact_id = str(prior["fact_id"]) if prior else uuid4().hex
            conn.execute(
                """INSERT INTO work_memory_facts(
                   organization_id,workspace_id,fact_id,namespace,fact_key,value_json,source_id,
                   observed_at,fresh_until,updated_at
                   ) VALUES(?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(organization_id,workspace_id,namespace,fact_key) DO UPDATE SET
                     value_json=excluded.value_json,source_id=excluded.source_id,
                     observed_at=excluded.observed_at,fresh_until=excluded.fresh_until,
                     updated_at=excluded.updated_at""",
                (
                    org,
                    workspace,
                    fact_id,
                    namespace,
                    key,
                    _json_text(value),
                    source_id,
                    observed_at,
                    fresh_until,
                    now,
                ),
            )
            row = conn.execute(
                """SELECT * FROM work_memory_facts WHERE organization_id=? AND workspace_id=?
                   AND namespace=? AND fact_key=?""",
                (org, workspace, namespace, key),
            ).fetchone()
            return self._memory_view(conn, row)

    def list_memory_facts(
        self,
        organization_id: str | None,
        workspace_id: str,
        *,
        include_stale: bool = True,
        limit: int = 500,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> list[JsonObject]:
        """Read workspace memory facts with current freshness annotations. | 读取记忆事实。"""

        org, workspace = _scope(organization_id, workspace_id)
        if type(limit) is not int or not 1 <= limit <= 1_000:
            raise _invalid("WORK_MEMORY_INVALID_PAGE", "limit must be between 1 and 1000")
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        if actor_private_scope and actor is None:
            raise _invalid("WORK_MEMORY_ACTOR_REQUIRED", "actor-private memory requires an actor")
        with self._read() as conn:
            shared_rows = conn.execute(
                """SELECT * FROM work_memory_facts WHERE organization_id=? AND workspace_id=?
                   ORDER BY namespace,fact_key LIMIT ?""",
                (org, workspace, limit),
            ).fetchall()
            private_rows: list[sqlite3.Row] = []
            if actor_private_scope:
                private_rows = conn.execute(
                    """SELECT * FROM work_private_memory_facts WHERE organization_id=?
                       AND workspace_id=? AND actor_id=? ORDER BY namespace,fact_key LIMIT ?""",
                    (org, workspace, actor, limit),
                ).fetchall()
            rows = sorted(
                [*shared_rows, *private_rows],
                key=lambda row: (str(row["namespace"]), str(row["fact_key"])),
            )[:limit]
            values = [self._memory_view(conn, row) for row in rows]
            if not include_stale:
                values = [item for item in values if not item["stale"] and not item["missing"]]
            return values

    def query_memory(
        self,
        organization_id: str | None,
        workspace_id: str,
        query: str,
        *,
        limit: int = 20,
        include_stale: bool = False,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> list[JsonObject]:
        """Perform bounded lexical fact search and disclose freshness in each result. |
        查询工作记忆。"""

        query = _bounded_text(query, "query", 2_000).casefold()
        if type(limit) is not int or not 1 <= limit <= 100:
            raise _invalid("WORK_MEMORY_INVALID_PAGE", "limit must be between 1 and 100")
        facts = self.list_memory_facts(
            organization_id,
            workspace_id,
            include_stale=True,
            limit=1_000,
            actor_id=actor_id,
            actor_private_scope=actor_private_scope,
        )
        org, workspace = _scope(organization_id, workspace_id)
        now = _unix_ms()
        with self._read() as conn:
            source_rows = (
                []
                if actor_private_scope
                else conn.execute(
                    """SELECT f.*,s.status AS source_status,s.last_complete_at
                   FROM work_source_facts f JOIN work_sources s
                     ON s.organization_id=f.organization_id AND s.workspace_id=f.workspace_id
                    AND s.source_id=f.source_id
                   WHERE f.organization_id=? AND f.workspace_id=? LIMIT 5000""",
                    (org, workspace),
                ).fetchall()
            )
            for row in source_rows:
                source_id = str(row["source_id"])
                complete_at = row["last_complete_at"]
                missing = row["missing_at"] is not None
                stale = (
                    complete_at is None
                    or now - int(complete_at or 0) > 86_400_000
                    or str(row["source_status"]) in {"failed", "incomplete", "stale"}
                )
                facts.append(
                    {
                        "id": f"source:{source_id}:{row['fact_key']}",
                        "namespace": f"source:{source_id}",
                        "key": str(row["fact_key"]),
                        "value": _stored_object(row["value_json"], "source fact"),
                        "sourceId": source_id,
                        "observedAt": int(row["observed_at"]),
                        "freshUntil": None,
                        "missing": missing,
                        "stale": bool(stale),
                    }
                )
        scored: list[tuple[int, int, JsonObject]] = []
        for item in facts:
            haystack = f"{item['namespace']} {item['key']} {_json_text(item['value'])}".casefold()
            if query not in haystack:
                continue
            if not include_stale and (item["stale"] or item["missing"]):
                continue
            score = (
                3
                if query == str(item["key"]).casefold()
                else 2
                if query in str(item["key"]).casefold()
                else 1
            )
            scored.append((score, int(item["observedAt"]), item))
        scored.sort(key=lambda entry: (-entry[0], -entry[1], str(entry[2]["key"])))
        return [entry[2] for entry in scored[:limit]]

    def ingest_source_page(
        self,
        organization_id: str | None,
        workspace_id: str,
        source_id: str,
        body: Mapping[str, Any],
    ) -> JsonObject:
        """Stage a paginated inventory and replace presence only on final success. |
        分页导入来源。"""

        org, workspace = _scope(organization_id, workspace_id)
        source_id = _identifier(source_id, "source id")
        inventory_id = _identifier(body.get("inventoryId"), "inventoryId")
        page_token = body.get("pageToken")
        next_token = body.get("nextPageToken")
        if page_token is not None:
            page_token = _bounded_text(page_token, "pageToken", 2_000)
        if next_token is not None:
            next_token = _bounded_text(next_token, "nextPageToken", 2_000)
        complete = body.get("complete")
        successful = body.get("successful")
        if type(complete) is not bool or type(successful) is not bool:
            raise _invalid("WORK_SOURCE_INVALID_PAGE", "complete and successful must be booleans")
        items = body.get("items")
        if not isinstance(items, Sequence) or isinstance(items, (str, bytes)):
            raise _invalid("WORK_SOURCE_INVALID_PAGE", "items must be an array")
        normalized_items: list[tuple[str, JsonObject, int]] = []
        for item in items:
            if not isinstance(item, Mapping):
                raise _invalid("WORK_SOURCE_INVALID_PAGE", "each item must be an object")
            key = _bounded_text(item.get("key"), "fact key", 512)
            value = _json_object(item.get("value"), "value")
            observed_at = item.get("observedAt", _unix_ms())
            _nonnegative_integer(observed_at, "observedAt")
            normalized_items.append((key, value, observed_at))
        if complete and (not successful or next_token is not None):
            raise _invalid(
                "WORK_SOURCE_INVALID_COMPLETION",
                "complete requires a successful final page with no nextPageToken.",
            )
        if next_token is None and successful and not complete:
            raise _invalid(
                "WORK_SOURCE_INVALID_COMPLETION",
                "a successful final page must set complete=true.",
            )
        page_key = page_token or ""
        digest = _digest(
            {
                "pageToken": page_token,
                "nextPageToken": next_token,
                "complete": complete,
                "successful": successful,
                "items": [
                    {"key": key, "value": value, "observedAt": observed}
                    for key, value, observed in normalized_items
                ],
            }
        )
        now = _unix_ms()
        with self._mutation() as conn:
            source = conn.execute(
                """SELECT * FROM work_sources WHERE organization_id=? AND workspace_id=? AND
                    source_id=?""",
                (org, workspace, source_id),
            ).fetchone()
            if source is None:
                conn.execute(
                    """INSERT INTO work_sources(organization_id,workspace_id,source_id,status,
                       last_complete_at,updated_at) VALUES(?,?,?,'unknown',NULL,?)""",
                    (org, workspace, source_id, now),
                )
                source = conn.execute(
                    (
                        "SELECT * FROM work_sources WHERE organization_id=? AND "
                        "workspace_id=? AND source_id=?"
                    ),
                    (org, workspace, source_id),
                ).fetchone()
            run = conn.execute(
                """SELECT * FROM work_source_runs WHERE organization_id=? AND workspace_id=?
                   AND source_id=? AND inventory_id=?""",
                (org, workspace, source_id, inventory_id),
            ).fetchone()
            if run is None:
                if page_token is not None:
                    raise _conflict(
                        "WORK_SOURCE_PAGE_GAP",
                        "The first inventory page must have no pageToken.",
                    )
                active = conn.execute(
                    """SELECT inventory_id FROM work_source_runs WHERE organization_id=? AND
                    workspace_id=?
                       AND source_id=? AND status='in_progress' LIMIT 1""",
                    (org, workspace, source_id),
                ).fetchone()
                if active is not None:
                    raise _conflict(
                        "WORK_SOURCE_INVENTORY_ACTIVE",
                        "Another inventory is still in progress.",
                    )
                conn.execute(
                    """INSERT INTO work_source_runs(organization_id,workspace_id,
                       source_id,inventory_id,
                       status,expected_page_token,page_count,item_count,started_at,completed_at)
                       VALUES(?,?,?,?,'in_progress','',0,0,?,NULL)""",
                    (org, workspace, source_id, inventory_id, now),
                )
                run = conn.execute(
                    (
                        "SELECT * FROM work_source_runs WHERE organization_id=? AND "
                        "workspace_id=? AND source_id=? AND inventory_id=?"
                    ),
                    (org, workspace, source_id, inventory_id),
                ).fetchone()
            prior_page = conn.execute(
                """SELECT page_digest,next_page_token,complete,successful FROM work_source_pages
                   WHERE organization_id=? AND workspace_id=? AND source_id=? AND
                   inventory_id=? AND page_token=?""",
                (org, workspace, source_id, inventory_id, page_key),
            ).fetchone()
            if prior_page is not None:
                if str(prior_page["page_digest"]) != digest:
                    raise _conflict(
                        "WORK_SOURCE_PAGE_CONFLICT",
                        "pageToken was reused with different content.",
                    )
                return self._source_receipt(conn, org, workspace, source_id, inventory_id, True)
            if str(run["status"]) != "in_progress":
                raise _conflict("WORK_SOURCE_INVENTORY_CLOSED", "The inventory is already closed.")
            expected = str(run["expected_page_token"])
            if page_key != expected:
                raise _conflict(
                    "WORK_SOURCE_PAGE_GAP",
                    "The pageToken does not continue the accepted page chain.",
                )
            conn.execute(
                """INSERT INTO work_source_pages(organization_id,workspace_id,
                   source_id,inventory_id,
                   page_token,next_page_token,complete,successful,page_digest,accepted_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (
                    org,
                    workspace,
                    source_id,
                    inventory_id,
                    page_key,
                    next_token,
                    int(complete),
                    int(successful),
                    digest,
                    now,
                ),
            )
            if not successful:
                conn.execute(
                    """UPDATE work_source_runs SET status='failed',page_count=page_count+1,
                       item_count=item_count+?,completed_at=? WHERE organization_id=? AND
                       workspace_id=?
                       AND source_id=? AND inventory_id=?""",
                    (
                        len(normalized_items),
                        now,
                        org,
                        workspace,
                        source_id,
                        inventory_id,
                    ),
                )
                conn.execute(
                    """UPDATE work_sources SET status='failed',updated_at=? WHERE organization_id=?
                       AND workspace_id=? AND source_id=?""",
                    (now, org, workspace, source_id),
                )
                return self._source_receipt(conn, org, workspace, source_id, inventory_id, False)
            for key, value, observed_at in normalized_items:
                prior_fact = conn.execute(
                    """SELECT value_json FROM work_source_staging WHERE organization_id=? AND
                    workspace_id=?
                       AND source_id=? AND inventory_id=? AND fact_key=?""",
                    (org, workspace, source_id, inventory_id, key),
                ).fetchone()
                if (
                    prior_fact is not None
                    and _stored_object(prior_fact["value_json"], "source staging") != value
                ):
                    raise _conflict(
                        "WORK_SOURCE_DUPLICATE_FACT",
                        "The inventory repeated a fact key with different data.",
                    )
                conn.execute(
                    """INSERT OR IGNORE INTO work_source_staging(organization_id,workspace_id,
                       source_id,
                       inventory_id,fact_key,value_json,observed_at) VALUES(?,?,?,?,?,?,?)""",
                    (
                        org,
                        workspace,
                        source_id,
                        inventory_id,
                        key,
                        _json_text(value),
                        observed_at,
                    ),
                )
            conn.execute(
                """UPDATE work_source_runs SET expected_page_token=?,page_count=page_count+1,
                   item_count=item_count+? WHERE organization_id=? AND workspace_id=? AND
                   source_id=? AND inventory_id=?""",
                (
                    next_token or "",
                    len(normalized_items),
                    org,
                    workspace,
                    source_id,
                    inventory_id,
                ),
            )
            if complete:
                staged = conn.execute(
                    """SELECT * FROM work_source_staging WHERE organization_id=? AND workspace_id=?
                       AND source_id=? AND inventory_id=?""",
                    (org, workspace, source_id, inventory_id),
                ).fetchall()
                for fact in staged:
                    conn.execute(
                        """INSERT INTO work_source_facts(organization_id,workspace_id,
                           source_id,fact_key,
                           value_json,observed_at,last_inventory_id,missing_at)
                           VALUES(?,?,?,?,?,?,?,NULL)
                           ON CONFLICT(organization_id,workspace_id,source_id,fact_key) DO
                           UPDATE SET
                             value_json=excluded.value_json,observed_at=excluded.observed_at,
                             last_inventory_id=excluded.last_inventory_id,missing_at=NULL""",
                        (
                            org,
                            workspace,
                            source_id,
                            str(fact["fact_key"]),
                            str(fact["value_json"]),
                            int(fact["observed_at"]),
                            inventory_id,
                        ),
                    )
                conn.execute(
                    """UPDATE work_source_facts SET missing_at=? WHERE organization_id=? AND
                    workspace_id=?
                       AND source_id=? AND last_inventory_id<>? AND missing_at IS NULL""",
                    (now, org, workspace, source_id, inventory_id),
                )
                conn.execute(
                    """UPDATE work_source_runs SET status='completed',completed_at=? WHERE
                    organization_id=?
                       AND workspace_id=? AND source_id=? AND inventory_id=?""",
                    (now, org, workspace, source_id, inventory_id),
                )
                conn.execute(
                    """DELETE FROM work_source_staging WHERE organization_id=? AND workspace_id=?
                       AND source_id=? AND inventory_id=?""",
                    (org, workspace, source_id, inventory_id),
                )
                conn.execute(
                    """UPDATE work_sources SET status='fresh',last_complete_at=?,updated_at=?
                       WHERE organization_id=? AND workspace_id=? AND source_id=?""",
                    (now, now, org, workspace, source_id),
                )
            else:
                conn.execute(
                    """UPDATE work_sources SET status='incomplete',updated_at=? WHERE
                    organization_id=?
                       AND workspace_id=? AND source_id=?""",
                    (now, org, workspace, source_id),
                )
            return self._source_receipt(conn, org, workspace, source_id, inventory_id, False)

    def list_sources(self, organization_id: str | None, workspace_id: str) -> list[JsonObject]:
        """Read source status and inventory completeness without exposing staging rows. |
        列来源。"""

        org, workspace = _scope(organization_id, workspace_id)
        now = _unix_ms()
        with self._read() as conn:
            rows = conn.execute(
                (
                    "SELECT * FROM work_sources WHERE organization_id=? AND workspace_id=? "
                    "ORDER BY source_id"
                ),
                (org, workspace),
            ).fetchall()
            results: list[JsonObject] = []
            for row in rows:
                status = str(row["status"])
                completed = row["last_complete_at"]
                if (
                    completed is not None
                    and now - int(completed) > 86_400_000
                    and status == "fresh"
                ):
                    status = "stale"
                fact_count = conn.execute(
                    """SELECT count(*) FROM work_source_facts WHERE organization_id=? AND
                    workspace_id=?
                       AND source_id=? AND missing_at IS NULL""",
                    (org, workspace, str(row["source_id"])),
                ).fetchone()[0]
                results.append(
                    {
                        "sourceId": str(row["source_id"]),
                        "status": status,
                        "lastCompleteAt": completed,
                        "updatedAt": int(row["updated_at"]),
                        "factCount": int(fact_count),
                    }
                )
            return results

    def list_source_facts(
        self,
        organization_id: str | None,
        workspace_id: str,
        source_id: str,
        *,
        include_missing: bool = False,
        limit: int = 1_000,
        actor_private_scope: bool = False,
    ) -> list[JsonObject]:
        """Read the last complete source snapshot and retain explicit missing markers. |
        读取来源事实。"""

        org, workspace = _scope(organization_id, workspace_id)
        source_id = _identifier(source_id, "source id")
        if type(limit) is not int or not 1 <= limit <= 5_000:
            raise _invalid("WORK_SOURCE_INVALID_PAGE", "limit must be between 1 and 5000")
        if actor_private_scope:
            return []
        with self._read() as conn:
            self._require_source(conn, org, workspace, source_id)
            clause = "" if include_missing else "AND missing_at IS NULL"
            rows = conn.execute(
                f"""SELECT * FROM work_source_facts WHERE organization_id=? AND workspace_id=?
                    AND source_id=? {clause} ORDER BY fact_key LIMIT ?""",
                (org, workspace, source_id, limit),
            ).fetchall()
            return [self._source_fact_view(row) for row in rows]

    def create_notification(
        self,
        organization_id: str | None,
        workspace_id: str,
        body: Mapping[str, Any],
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> tuple[JsonObject, bool]:
        """Enqueue one deduplicated outbox item without performing delivery. | 通知入队。"""

        org, workspace = _scope(organization_id, workspace_id)
        dedup_key = _identifier(body.get("deduplicationKey"), "deduplicationKey")
        notification_type = _bounded_text(body.get("type"), "type", 128)
        if actor_private_scope and notification_type == "teams.message":
            raise PersistenceError(
                "WORK_NOTIFICATION_PRIVATE_ROUTE_REQUIRED",
                403,
                "Actor-private Teams results require the verified owner-private outbox route.",
            )
        payload = _json_object(body.get("payload"), "payload")
        connector_id = _optional_text(body.get("connectorId"), "connectorId", 512)
        task_id = _optional_text(body.get("taskId"), "taskId", 512)
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        recipient = _optional_text(body.get("recipient"), "recipient", 2_000)
        if notification_type == _CREDENTIAL_HEALTH_NOTIFICATION_TYPE:
            raise _invalid(
                "WORK_NOTIFICATION_RESERVED_TYPE",
                "Credential health notifications are created only from the trusted "
                "health snapshot route.",
            )
        available_at = body.get("availableAt", _unix_ms())
        _nonnegative_integer(available_at, "availableAt")
        now = _unix_ms()
        with self._mutation() as conn:
            if task_id is not None:
                self._require_teams_task_actor(
                    conn,
                    org,
                    workspace,
                    task_id,
                    actor,
                    actor_private_scope=actor_private_scope,
                )
            digest = _notification_request_digest(
                notification_type,
                payload,
                connector_id,
                recipient,
                task_id,
            )
            prior = conn.execute(
                """SELECT * FROM work_notifications WHERE organization_id=? AND workspace_id=?
                   AND deduplication_key=?""",
                (org, workspace, dedup_key),
            ).fetchone()
            if prior is not None:
                if str(prior["request_digest"]) != digest:
                    raise _conflict(
                        "WORK_NOTIFICATION_KEY_CONFLICT",
                        "deduplicationKey names different content.",
                    )
                return self._notification_view(prior), True
            if task_id is not None:
                self._require_running_task(conn, org, workspace, task_id)
            return self._enqueue_notification(
                conn,
                org,
                workspace,
                dedup_key,
                notification_type,
                payload,
                connector_id,
                recipient,
                task_id,
                available_at,
                now,
            )

    def _enqueue_notification(
        self,
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        dedup_key: str,
        notification_type: str,
        payload: Mapping[str, Any],
        connector_id: str | None,
        recipient: str | None,
        task_id: str | None,
        available_at: int,
        now: int,
        *,
        owner_actor_id: str | None = None,
        private_owner: Mapping[str, Any] | None = None,
    ) -> tuple[JsonObject, bool]:
        """Insert one outbox item or verify an identical deduplication replay. | 原子加入通知。"""

        base_digest = _notification_request_digest(
            notification_type,
            payload,
            connector_id,
            recipient,
            task_id,
        )
        private_fields: JsonObject = {}
        if private_owner is not None:
            required_private_fields = {
                "taskId",
                "tenantId",
                "actorAadObjectId",
            }
            if (
                owner_actor_id is None
                or not required_private_fields.issubset(private_owner)
                or set(private_owner) - required_private_fields - {"botAppId"}
            ):
                raise _invalid(
                    "WORK_NOTIFICATION_PRIVATE_OWNER_INVALID",
                    "private notification owner references are incomplete",
                )
            private_fields = {
                "owner_actor_id": _identifier(owner_actor_id, "private owner actorId"),
                "private_owner_task_id": _identifier(
                    private_owner.get("taskId"), "private ownerTaskId"
                ),
                "private_tenant_id": _canonical_uuid(
                    private_owner.get("tenantId"), "private tenantId"
                ),
                "private_owner_aad_object_id": _canonical_uuid(
                    private_owner.get("actorAadObjectId"), "private actorAadObjectId"
                ),
                "private_bot_app_id": (
                    _canonical_uuid(private_owner["botAppId"], "private botAppId")
                    if private_owner.get("botAppId") is not None
                    else None
                ),
            }
            digest = _digest({"notificationDigest": base_digest, "privateOwner": private_fields})
        else:
            if owner_actor_id is not None:
                raise _invalid(
                    "WORK_NOTIFICATION_PRIVATE_OWNER_INVALID",
                    "ownerActorId requires a private owner reference",
                )
            digest = base_digest
        prior = conn.execute(
            """SELECT * FROM work_notifications WHERE organization_id=? AND workspace_id=?
               AND deduplication_key=?""",
            (org, workspace, dedup_key),
        ).fetchone()
        if prior is not None:
            if str(prior["request_digest"]) != digest:
                raise _conflict(
                    "WORK_NOTIFICATION_KEY_CONFLICT",
                    "deduplicationKey names different content.",
                )
            return self._notification_view(prior), True
        notification_id = uuid4().hex
        conn.execute(
            """INSERT INTO work_notifications(organization_id,workspace_id,notification_id,
               deduplication_key,notification_type,payload_json,connector_id,recipient,status,
               task_id,available_at,created_at,updated_at,worker_id,lease_token_hash,lease_expires_at,
               started_at,result_json,request_digest,owner_actor_id,private_owner_task_id,
               private_tenant_id,private_owner_aad_object_id,private_bot_app_id)
               VALUES(?,?,?,?,?,?,?,?, 'queued',?,?,?,?,NULL,NULL,NULL,NULL,'{}',?,?,?,?,?,?)""",
            (
                org,
                workspace,
                notification_id,
                dedup_key,
                notification_type,
                _json_text(payload),
                connector_id,
                recipient,
                task_id,
                available_at,
                now,
                now,
                digest,
                private_fields.get("owner_actor_id"),
                private_fields.get("private_owner_task_id"),
                private_fields.get("private_tenant_id"),
                private_fields.get("private_owner_aad_object_id"),
                private_fields.get("private_bot_app_id"),
            ),
        )
        row = conn.execute(
            "SELECT * FROM work_notifications WHERE organization_id=? AND "
            "workspace_id=? AND notification_id=?",
            (org, workspace, notification_id),
        ).fetchone()
        return self._notification_view(row), False

    def _queue_task_result_notification(
        self,
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        task: sqlite3.Row,
        now: int,
        *,
        private_scope: PrivateConversationScope | None = None,
    ) -> None:
        """Queue a safe terminal reply, keeping actor-private Teams output private.

        A task's private-owner and Teams-origin rows are immutable. For those tasks,
        the verified actor and tenant determine a private owner outbox item; mutable
        notification metadata cannot redirect output to a shared channel.
        中文：私聊失败时保留私有待投递，不回退到群聊。
        """

        task_id = str(task["task_id"])
        metadata = _stored_object(task["metadata_json"], "task metadata")
        private_owner = conn.execute(
            """SELECT actor_id FROM work_task_private_owners WHERE organization_id=?
               AND workspace_id=? AND task_id=?""",
            (org, workspace, task_id),
        ).fetchone()
        origin = conn.execute(
            """SELECT actor_id,actor_issuer,actor_subject,tenant_id,connector_id,
                      conversation_kind,bot_app_id
               FROM work_task_teams_origins WHERE organization_id=? AND workspace_id=?
                 AND task_id=?""",
            (org, workspace, task_id),
        ).fetchone()

        if private_owner is not None:
            if origin is None:
                team_intake = conn.execute(
                    """SELECT 1 FROM work_connector_events WHERE organization_id=?
                       AND workspace_id=? AND task_id=? AND (
                         origin_actor_id IS NOT NULL OR
                         lower(json_extract(payload_json,'$.provider'))='teams' OR
                         event_type LIKE 'teams.%') LIMIT 1""",
                    (org, workspace, task_id),
                ).fetchone()
                if metadata.get("notification") is not None or team_intake is not None:
                    self._append_event(
                        conn,
                        org,
                        workspace,
                        task_id,
                        {
                            "type": "task.result_delivery_held.v1",
                            "reasonCode": "verified_teams_origin_not_configured",
                            "status": str(task["status"]),
                        },
                        f"task-result-delivery-hold:{task_id}:{task['status']}",
                        now,
                    )
                return

            actor = str(private_owner["actor_id"]).lower()
            if (
                str(task["created_by_actor_id"] or "").lower() != actor
                or str(origin["actor_id"]).lower() != actor
                or str(origin["actor_subject"]).lower() != actor
                or str(origin["connector_id"]) != _TEAMS_CONNECTOR_ID
            ):
                self._append_event(
                    conn,
                    org,
                    workspace,
                    task_id,
                    {
                        "type": "task.result_delivery_held.v1",
                        "reasonCode": "verified_teams_origin_mismatch",
                        "status": str(task["status"]),
                    },
                    f"task-result-delivery-hold:{task_id}:{task['status']}",
                    now,
                )
                return

            status = str(task["status"])
            text = _task_result_text(task)
            policy_matches = (
                private_scope is not None
                and private_scope.workspace_id == workspace
                and private_scope.issuer == str(origin["actor_issuer"])
                and private_scope.tenant_id.lower() == str(origin["tenant_id"]).lower()
                and actor in private_scope.owner_subjects
            )
            origin_bot_matches = str(origin["conversation_kind"]) != "private" or (
                private_scope is not None
                and origin["bot_app_id"] is not None
                and str(origin["bot_app_id"]).lower() == private_scope.bot_app_id.lower()
            )
            policy_matches = policy_matches and origin_bot_matches
            bot_app_id = (
                private_scope.bot_app_id if private_scope is not None and policy_matches else None
            )
            private_route = {
                "taskId": task_id,
                "tenantId": str(origin["tenant_id"]),
                "actorAadObjectId": str(origin["actor_subject"]),
            }
            if bot_app_id is not None:
                private_route["botAppId"] = bot_app_id
            notification, duplicate = self._enqueue_notification(
                conn,
                org,
                workspace,
                f"task-result-private:{task_id}:{status}",
                "teams.message",
                {"text": text, "taskId": task_id, "status": status},
                "teams-v1",
                "teams:owner-private",
                task_id,
                now,
                now,
                owner_actor_id=actor,
                private_owner=private_route,
            )
            hold_code: str | None = None
            if private_scope is None or (
                private_scope.workspace_id != workspace
                or private_scope.issuer != str(origin["actor_issuer"])
                or private_scope.tenant_id.lower() != str(origin["tenant_id"]).lower()
                or actor not in private_scope.owner_subjects
            ):
                hold_code = "WORK_TEAMS_PRIVATE_POLICY_NOT_CONFIGURED"
            elif not origin_bot_matches:
                hold_code = "WORK_TEAMS_PRIVATE_BOT_APP_MISMATCH"
            else:
                active_installation = conn.execute(
                    """SELECT active FROM work_private_installations WHERE organization_id=?
                       AND workspace_id=? AND tenant_id=? AND actor_aad_object_id=?
                         AND bot_app_id=?""",
                    (
                        org,
                        workspace,
                        str(origin["tenant_id"]).lower(),
                        actor,
                        private_scope.bot_app_id.lower(),
                    ),
                ).fetchone()
                if active_installation is None or not bool(active_installation["active"]):
                    hold_code = "WORK_TEAMS_PRIVATE_INSTALLATION_NOT_CONFIGURED"
            if hold_code is not None and not duplicate:
                conn.execute(
                    """UPDATE work_notifications SET result_json=?,updated_at=?
                       WHERE organization_id=? AND workspace_id=? AND notification_id=?
                         AND status='queued'""",
                    (
                        _json_text({"deliveryHoldCode": hold_code}),
                        now,
                        org,
                        workspace,
                        str(notification["id"]),
                    ),
                )
            return

        descriptor = _task_notification_descriptor(metadata)
        if descriptor is None:
            return
        status = str(task["status"])
        text = _task_result_text(task)
        payload = {
            **descriptor["payload"],
            "text": text,
            "taskId": task_id,
            "status": status,
        }
        self._enqueue_notification(
            conn,
            org,
            workspace,
            f"task-result:{task_id}:{status}",
            descriptor["type"],
            payload,
            descriptor["connectorId"],
            descriptor["recipient"],
            task_id,
            now,
            now,
        )

    def process_credential_health_snapshots(
        self,
        organization_id: str | None,
        workspace_id: str,
        snapshots: Sequence[Mapping[str, Any]],
    ) -> JsonObject:
        """Checkpoint Exchange health and enqueue only incident transitions atomically.

        Unknown or stale projections remain silent. Repeated action-required snapshots
        produce a reminder at most once per cooldown, while recovery is emitted once.
        中文：在同一事务中保存授权健康检查点并按状态转换加入持久 outbox。
        """

        org, workspace = _scope(organization_id, workspace_id)
        if not isinstance(snapshots, Sequence) or isinstance(snapshots, (str, bytes)):
            raise _invalid("WORK_CREDENTIAL_HEALTH_INVALID", "connections must be an array")
        if not 1 <= len(snapshots) <= 100:
            raise _invalid(
                "WORK_CREDENTIAL_HEALTH_INVALID", "connections must contain 1 to 100 items"
            )
        normalized = [_credential_health_snapshot(item) for item in snapshots]
        connection_ids = [item["connectionId"] for item in normalized]
        if len(set(connection_ids)) != len(connection_ids):
            raise _invalid("WORK_CREDENTIAL_HEALTH_INVALID", "connection ids must be unique")

        now = _unix_ms()
        processed = 0
        stale = 0
        queued = 0
        with self._mutation() as conn:
            for snapshot in normalized:
                connection_id = str(snapshot["connectionId"])
                prior = conn.execute(
                    """SELECT * FROM work_credential_authorization_health
                       WHERE organization_id=? AND workspace_id=? AND connection_id=?""",
                    (org, workspace, connection_id),
                ).fetchone()
                generation = int(snapshot["generation"])
                checked_at = snapshot["checkedAt"]
                prior_checked_at = (
                    str(prior["checked_at"]) if prior is not None and prior["checked_at"] else None
                )
                if prior is not None and (
                    (checked_at is None and prior_checked_at is not None)
                    or (
                        checked_at is not None
                        and prior_checked_at is not None
                        and _credential_timestamp_ms(checked_at)
                        < _credential_timestamp_ms(prior_checked_at)
                    )
                ):
                    stale += 1
                    continue

                status = _credential_health_decision(snapshot, now)
                fingerprint = _credential_health_fingerprint(snapshot)
                state_changed = prior is None or str(prior["fingerprint"]) != fingerprint
                incident_id = (
                    str(prior["incident_id"])
                    if prior is not None and prior["incident_id"]
                    else None
                )
                incident_started_at = (
                    int(prior["incident_started_at"])
                    if prior is not None and prior["incident_started_at"] is not None
                    else None
                )
                last_notified_at = (
                    int(prior["last_notified_at"])
                    if prior is not None and prior["last_notified_at"] is not None
                    else None
                )
                reminder_count = int(prior["reminder_count"]) if prior is not None else 0
                notification: JsonObject | None = None
                deduplication_key: str | None = None

                if status == "action_required":
                    if incident_id is None:
                        incident_id = uuid4().hex
                        incident_started_at = now
                        last_notified_at = now
                        reminder_count = 0
                        deduplication_key = (
                            f"credential-health:{connection_id}:{incident_id}:opened"
                        )
                        notification = _credential_health_notice(
                            snapshot, "action_required", incident_id
                        )
                    elif (
                        last_notified_at is None
                        or now - last_notified_at >= _CREDENTIAL_HEALTH_REMINDER_COOLDOWN_MS
                    ):
                        reminder_count += 1
                        last_notified_at = now
                        deduplication_key = (
                            f"credential-health:{connection_id}:{incident_id}:"
                            f"reminder:{reminder_count}"
                        )
                        notification = _credential_health_notice(snapshot, "reminder", incident_id)
                elif status == "healthy" and incident_id is not None and state_changed:
                    deduplication_key = f"credential-health:{connection_id}:{incident_id}:recovered"
                    notification = _credential_health_notice(snapshot, "recovered", incident_id)
                    incident_id = None
                    incident_started_at = None
                    last_notified_at = None
                    reminder_count = 0

                if notification is not None and deduplication_key is not None:
                    _, duplicate = self._enqueue_notification(
                        conn,
                        org,
                        workspace,
                        deduplication_key,
                        _CREDENTIAL_HEALTH_NOTIFICATION_TYPE,
                        notification,
                        _CREDENTIAL_HEALTH_CONNECTOR_ID,
                        _CREDENTIAL_HEALTH_RECIPIENT,
                        None,
                        now,
                        now,
                    )
                    if not duplicate:
                        queued += 1

                conn.execute(
                    """INSERT INTO work_credential_authorization_health(
                       organization_id,workspace_id,connection_id,provider,generation,fingerprint,
                       decision,checked_at,expires_at,reason_code,incident_id,incident_started_at,
                       last_notified_at,reminder_count,updated_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(organization_id,workspace_id,connection_id) DO UPDATE SET
                       provider=excluded.provider,
                       generation=excluded.generation,
                       fingerprint=excluded.fingerprint,decision=excluded.decision,
                       checked_at=excluded.checked_at,expires_at=excluded.expires_at,
                       reason_code=excluded.reason_code,incident_id=excluded.incident_id,
                       incident_started_at=excluded.incident_started_at,
                       last_notified_at=excluded.last_notified_at,
                       reminder_count=excluded.reminder_count,updated_at=excluded.updated_at""",
                    (
                        org,
                        workspace,
                        connection_id,
                        snapshot["provider"],
                        generation,
                        fingerprint,
                        status,
                        snapshot["checkedAt"],
                        snapshot["expiresAt"],
                        snapshot["reasonCode"],
                        incident_id,
                        incident_started_at,
                        last_notified_at,
                        reminder_count,
                        now,
                    ),
                )
                processed += 1
        return {"processed": processed, "stale": stale, "notificationsQueued": queued}

    def list_notifications(
        self,
        organization_id: str | None,
        workspace_id: str,
        *,
        status: str | None = None,
        limit: int = 100,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> list[JsonObject]:
        """List outbox state while preserving uncertain rows for operator review. | 列通知队列。"""

        org, workspace = _scope(organization_id, workspace_id)
        if type(limit) is not int or not 1 <= limit <= 500:
            raise _invalid("WORK_NOTIFICATION_INVALID_PAGE", "limit must be between 1 and 500")
        statuses = {
            None,
            "queued",
            "leased",
            "started",
            "uncertain",
            "delivered",
            "failed",
        }
        if status not in statuses:
            raise _invalid("WORK_NOTIFICATION_INVALID_STATUS", "status is not valid")
        actor = _identifier(actor_id, "actorId") if actor_id is not None else ""
        if actor_private_scope:
            visibility = (
                " AND (owner_actor_id=? OR (owner_actor_id IS NULL AND task_id IS NOT NULL "
            )
            visibility += "AND EXISTS (SELECT 1 FROM work_tasks task WHERE "
            visibility += "task.organization_id=work_notifications.organization_id AND "
            visibility += "task.workspace_id=work_notifications.workspace_id AND "
            visibility += "task.task_id=work_notifications.task_id AND "
            visibility += "lower(task.created_by_actor_id)=?)))"
            actor_params = [actor, actor]
        else:
            visibility = (
                " AND (owner_actor_id=? OR (owner_actor_id IS NULL AND (task_id IS NULL OR ("
            )
            visibility += "(NOT EXISTS (SELECT 1 FROM work_task_private_owners private_owner WHERE "
            visibility += "private_owner.organization_id=work_notifications.organization_id AND "
            visibility += "private_owner.workspace_id=work_notifications.workspace_id AND "
            visibility += (
                "private_owner.task_id=work_notifications.task_id) OR EXISTS (SELECT 1 FROM "
            )
            visibility += "work_task_private_owners private_owner WHERE "
            visibility += "private_owner.organization_id=work_notifications.organization_id AND "
            visibility += "private_owner.workspace_id=work_notifications.workspace_id AND "
            visibility += "private_owner.task_id=work_notifications.task_id AND "
            visibility += "lower(private_owner.actor_id)=?)) AND "
            visibility += "(NOT EXISTS (SELECT 1 FROM work_task_teams_origins origin WHERE "
            visibility += "origin.organization_id=work_notifications.organization_id AND "
            visibility += "origin.workspace_id=work_notifications.workspace_id AND "
            visibility += "origin.task_id=work_notifications.task_id) OR EXISTS (SELECT 1 FROM "
            visibility += "work_task_teams_origins origin WHERE "
            visibility += "origin.organization_id=work_notifications.organization_id AND "
            visibility += "origin.workspace_id=work_notifications.workspace_id AND "
            visibility += "origin.task_id=work_notifications.task_id AND "
            visibility += "lower(origin.actor_id)=?))))))"
            actor_params = [actor, actor, actor]
        params: list[Any] = [org, workspace]
        query = "SELECT * FROM work_notifications WHERE organization_id=? AND workspace_id=?"
        if status is not None:
            query += " AND status=?"
            params.append(status)
        query += visibility + " ORDER BY created_at DESC LIMIT ?"
        params.extend([*actor_params, limit])
        with self._read() as conn:
            rows = conn.execute(query, params).fetchall()
            return [self._notification_view(row) for row in rows]

    def claim_notifications(
        self,
        organization_id: str | None,
        workspace_id: str,
        worker_id: str,
        limit: int,
        lease_seconds: int,
        *,
        notification_type: str | None = None,
        connector_id: str | None = None,
        recipient: str | None = None,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> list[JsonObject]:
        """Lease queued rows; expired in-flight sends become uncertain, never resent. |
        租用通知。"""

        org, workspace = _scope(organization_id, workspace_id)
        worker_id = _bounded_text(worker_id, "workerId", 256)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise _invalid("WORK_NOTIFICATION_INVALID_PAGE", "limit must be between 1 and 100")
        if type(lease_seconds) is not int or not 5 <= lease_seconds <= 3_600:
            raise _invalid(
                "WORK_NOTIFICATION_INVALID_LEASE",
                "leaseSeconds must be between 5 and 3600",
            )
        type_filter = _optional_text(notification_type, "type", 128)
        connector_filter = _optional_text(connector_id, "connectorId", 512)
        recipient_filter = _optional_text(recipient, "recipient", 2_000)
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else ""
        if connector_filter is not None and type_filter is None:
            raise _invalid(
                "WORK_NOTIFICATION_INVALID_FILTER",
                "connectorId claims also require an exact type filter.",
            )
        now = _unix_ms()
        expires = now + lease_seconds * 1_000
        leases: list[JsonObject] = []
        with self._mutation() as conn:
            if actor_private_scope:
                visibility = " AND owner_actor_id IS NULL AND task_id IS NOT NULL AND EXISTS ("
                visibility += "SELECT 1 FROM work_tasks task WHERE "
                visibility += "task.organization_id=work_notifications.organization_id AND "
                visibility += "task.workspace_id=work_notifications.workspace_id AND "
                visibility += "task.task_id=work_notifications.task_id AND "
                visibility += "lower(task.created_by_actor_id)=?)"
            else:
                visibility = " AND owner_actor_id IS NULL AND (task_id IS NULL OR ("
                visibility += "(NOT EXISTS (SELECT 1 FROM work_task_private_owners private_owner "
                visibility += (
                    "WHERE private_owner.organization_id=work_notifications.organization_id "
                )
                visibility += "AND private_owner.workspace_id=work_notifications.workspace_id "
                visibility += "AND private_owner.task_id=work_notifications.task_id) OR EXISTS ("
                visibility += "SELECT 1 FROM work_task_private_owners private_owner WHERE "
                visibility += (
                    "private_owner.organization_id=work_notifications.organization_id AND "
                )
                visibility += "private_owner.workspace_id=work_notifications.workspace_id AND "
                visibility += "private_owner.task_id=work_notifications.task_id AND "
                visibility += "lower(private_owner.actor_id)=?)) AND "
                visibility += "(NOT EXISTS (SELECT 1 FROM work_task_teams_origins origin WHERE "
                visibility += "origin.organization_id=work_notifications.organization_id AND "
                visibility += "origin.workspace_id=work_notifications.workspace_id AND "
                visibility += "origin.task_id=work_notifications.task_id) OR EXISTS (SELECT 1 FROM "
                visibility += "work_task_teams_origins origin WHERE "
                visibility += "origin.organization_id=work_notifications.organization_id AND "
                visibility += "origin.workspace_id=work_notifications.workspace_id AND "
                visibility += "origin.task_id=work_notifications.task_id AND "
                visibility += "lower(origin.actor_id)=?))))"
            visibility += " AND NOT (notification_type='teams.message' AND task_id IS NOT NULL "
            visibility += "AND EXISTS (SELECT 1 FROM work_task_private_owners private_owner "
            visibility += "WHERE private_owner.organization_id=work_notifications.organization_id "
            visibility += "AND private_owner.workspace_id=work_notifications.workspace_id "
            visibility += "AND private_owner.task_id=work_notifications.task_id))"
            expired = conn.execute(
                """SELECT notification_id,status FROM work_notifications WHERE organization_id=?
                   AND workspace_id=? AND status IN ('leased','started') AND lease_expires_at<=?"""
                + visibility,
                (org, workspace, now, actor, *([] if actor_private_scope else [actor])),
            ).fetchall()
            for row in expired:
                if str(row["status"]) == "started":
                    conn.execute(
                        """UPDATE work_notifications SET
                        status='uncertain',updated_at=?,worker_id=NULL,
                           lease_token_hash=NULL,lease_expires_at=NULL WHERE
                           organization_id=? AND workspace_id=? AND notification_id=?""",
                        (now, org, workspace, str(row["notification_id"])),
                    )
                else:
                    conn.execute(
                        """UPDATE work_notifications SET
                        status='queued',updated_at=?,worker_id=NULL,
                           lease_token_hash=NULL,lease_expires_at=NULL WHERE
                           organization_id=? AND workspace_id=? AND notification_id=?""",
                        (now, org, workspace, str(row["notification_id"])),
                    )
            filters = [
                "organization_id=?",
                "workspace_id=?",
                "status='queued'",
                "available_at<=?",
            ]
            params: list[Any] = [org, workspace, now]
            if type_filter is not None:
                filters.append("notification_type=?")
                params.append(type_filter)
            if connector_filter is not None:
                filters.append("connector_id=?")
                params.append(connector_filter)
            if recipient_filter is not None:
                filters.append("recipient=?")
                params.append(recipient_filter)
            filters.append(visibility.strip().removeprefix("AND "))
            params.append(actor)
            if not actor_private_scope:
                params.append(actor)
            params.append(limit)
            rows = conn.execute(
                "SELECT * FROM work_notifications WHERE "
                + " AND ".join(filters)
                + " ORDER BY available_at,created_at LIMIT ?",
                params,
            ).fetchall()
            for row in rows:
                token = secrets.token_urlsafe(32)
                notification_id = str(row["notification_id"])
                conn.execute(
                    """UPDATE work_notifications SET status='leased',worker_id=?,lease_token_hash=?,
                       lease_expires_at=?,updated_at=? WHERE organization_id=? AND
                       workspace_id=? AND notification_id=?""",
                    (
                        worker_id,
                        _sha256(token),
                        expires,
                        now,
                        org,
                        workspace,
                        notification_id,
                    ),
                )
                leased = conn.execute(
                    (
                        "SELECT * FROM work_notifications WHERE organization_id=? AND "
                        "workspace_id=? AND notification_id=?"
                    ),
                    (org, workspace, notification_id),
                ).fetchone()
                leases.append(
                    {
                        "notification": self._notification_view(leased),
                        "leaseToken": token,
                        "leaseExpiresAt": expires,
                    }
                )
            return leases

    def claim_private_notifications(
        self,
        organization_id: str | None,
        workspace_id: str,
        worker_id: str,
        limit: int,
        lease_seconds: int,
        scope: PrivateConversationScope,
    ) -> list[JsonObject]:
        """Lease active owner-private Teams rows and resolve routes only for this bridge.

        SQL filters held rows against the current owner projection, origin, bot, and active
        installation before applying a bounded candidate limit. Route resolution below remains
        the final authorization check.

        中文：先按当前目录、任务来源、Bot 和活动安装筛除 held 项，再限制候选数量；
        逐条路由校验仍是最终授权检查。
        """

        org, workspace = _scope(organization_id, workspace_id)
        if scope.workspace_id != workspace:
            raise PersistenceError(
                "WORK_TEAMS_PRIVATE_INSTALLATION_FORBIDDEN",
                403,
                "The private Teams owner binding is unavailable or unauthorized.",
            )
        worker_id = _bounded_text(worker_id, "workerId", 256)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise _invalid("WORK_NOTIFICATION_INVALID_PAGE", "limit must be between 1 and 100")
        if type(lease_seconds) is not int or not 5 <= lease_seconds <= 3_600:
            raise _invalid(
                "WORK_NOTIFICATION_INVALID_LEASE", "leaseSeconds must be between 5 and 3600"
            )
        now = _unix_ms()
        expires = now + lease_seconds * 1_000
        leases: list[JsonObject] = []
        owner_subjects_json = json.dumps(sorted(scope.owner_subjects), separators=(",", ":"))
        candidate_limit = min(1_000, max(limit * 20, limit))
        with self._mutation() as conn:
            expired = conn.execute(
                """SELECT notification_id,status FROM work_notifications
                   WHERE organization_id=? AND workspace_id=? AND owner_actor_id IS NOT NULL
                     AND status IN ('leased','started') AND lease_expires_at<=?""",
                (org, workspace, now),
            ).fetchall()
            for row in expired:
                status = "uncertain" if str(row["status"]) == "started" else "queued"
                conn.execute(
                    """UPDATE work_notifications SET status=?,updated_at=?,worker_id=NULL,
                       lease_token_hash=NULL,lease_expires_at=NULL
                       WHERE organization_id=? AND workspace_id=? AND notification_id=?""",
                    (status, now, org, workspace, str(row["notification_id"])),
                )
            candidates = conn.execute(
                """SELECT notification.* FROM work_notifications notification
                   JOIN work_tasks task ON task.organization_id=notification.organization_id
                     AND task.workspace_id=notification.workspace_id
                     AND task.task_id=notification.private_owner_task_id
                     AND task.created_by_actor_id=notification.owner_actor_id
                   JOIN work_task_teams_origins origin
                     ON origin.organization_id=notification.organization_id
                     AND origin.workspace_id=notification.workspace_id
                     AND origin.task_id=notification.private_owner_task_id
                     AND origin.actor_id=notification.owner_actor_id
                     AND origin.actor_subject=notification.private_owner_aad_object_id
                     AND origin.actor_issuer=?
                     AND lower(origin.tenant_id)=?
                     AND (origin.conversation_kind!='private' OR
                          lower(origin.bot_app_id)=?)
                   JOIN work_private_installations installation
                     ON installation.organization_id=notification.organization_id
                     AND installation.workspace_id=notification.workspace_id
                     AND installation.tenant_id=?
                     AND installation.actor_aad_object_id=
                         notification.private_owner_aad_object_id
                     AND installation.bot_app_id=? AND installation.active=1
                   WHERE notification.organization_id=? AND notification.workspace_id=?
                     AND notification.owner_actor_id IS NOT NULL
                     AND notification.owner_actor_id=notification.private_owner_aad_object_id
                     AND notification.owner_actor_id IN
                         (SELECT value FROM json_each(?))
                     AND notification.private_tenant_id=?
                     AND (notification.private_bot_app_id IS NULL OR
                          lower(notification.private_bot_app_id)=?)
                     AND notification.notification_type='teams.message'
                     AND notification.connector_id='teams-v1'
                     AND notification.recipient='teams:owner-private'
                     AND notification.status='queued' AND notification.available_at<=?
                   ORDER BY notification.available_at,notification.created_at LIMIT ?""",
                (
                    scope.issuer,
                    scope.tenant_id.lower(),
                    scope.bot_app_id.lower(),
                    scope.tenant_id.lower(),
                    scope.bot_app_id.lower(),
                    org,
                    workspace,
                    owner_subjects_json,
                    scope.tenant_id.lower(),
                    scope.bot_app_id.lower(),
                    now,
                    candidate_limit,
                ),
            ).fetchall()
            for row in candidates:
                notification_id = str(row["notification_id"])
                route_error: str | None = None
                try:
                    if (
                        str(row["notification_type"]) != "teams.message"
                        or str(row["connector_id"] or "") != "teams-v1"
                        or str(row["recipient"] or "") != "teams:owner-private"
                        or str(row["private_tenant_id"] or "") != scope.tenant_id
                        or (
                            row["private_bot_app_id"] is not None
                            and str(row["private_bot_app_id"]).lower() != scope.bot_app_id.lower()
                        )
                        or str(row["private_owner_aad_object_id"] or "") not in scope.owner_subjects
                    ):
                        raise PersistenceError(
                            "WORK_TEAMS_PRIVATE_INSTALLATION_FORBIDDEN",
                            403,
                            "The private Teams owner binding is unavailable or unauthorized.",
                        )
                    route = _resolve_private_teams_route(
                        conn,
                        org,
                        workspace,
                        str(row["private_owner_task_id"] or ""),
                        str(row["owner_actor_id"] or ""),
                        scope,
                    )
                except PersistenceError as exc:
                    if exc.code not in {
                        "WORK_TEAMS_PRIVATE_INSTALLATION_FORBIDDEN",
                        "WORK_TEAMS_PRIVATE_INSTALLATION_NOT_FOUND",
                        "WORK_TASK_NOT_FOUND",
                    }:
                        raise
                    route_error = exc.code
                if route_error is not None:
                    conn.execute(
                        """UPDATE work_notifications SET updated_at=?,result_json=?,
                           worker_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL
                           WHERE organization_id=? AND workspace_id=? AND notification_id=?
                             AND status='queued'""",
                        (
                            now,
                            _json_text({"deliveryHoldCode": route_error}),
                            org,
                            workspace,
                            notification_id,
                        ),
                    )
                    continue
                token = secrets.token_urlsafe(32)
                conn.execute(
                    """UPDATE work_notifications SET status='leased',worker_id=?,lease_token_hash=?,
                       lease_expires_at=?,updated_at=? WHERE organization_id=? AND workspace_id=?
                         AND notification_id=? AND status='queued'""",
                    (worker_id, _sha256(token), expires, now, org, workspace, notification_id),
                )
                leased = conn.execute(
                    """SELECT * FROM work_notifications WHERE organization_id=? AND workspace_id=?
                       AND notification_id=?""",
                    (org, workspace, notification_id),
                ).fetchone()
                leases.append(
                    {
                        "notification": self._notification_view(leased),
                        "leaseToken": token,
                        "leaseExpiresAt": expires,
                        "teamsPersonalRoute": route,
                    }
                )
                if len(leases) >= limit:
                    break
            return leases

    def start_notification(
        self,
        organization_id: str | None,
        workspace_id: str,
        notification_id: str,
        lease_token: str,
        *,
        private_scope: PrivateConversationScope | None = None,
        allow_private: bool = False,
        private_only: bool = False,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> JsonObject:
        """Fence a worker before the remote send can begin. | 远程发送前记录开始。"""

        return self._notification_transition(
            organization_id,
            workspace_id,
            notification_id,
            lease_token,
            "started",
            {},
            private_scope=private_scope,
            allow_private=allow_private,
            private_only=private_only,
            actor_id=actor_id,
            actor_private_scope=actor_private_scope,
        )

    def finish_notification(
        self,
        organization_id: str | None,
        workspace_id: str,
        notification_id: str,
        lease_token: str,
        outcome: str,
        result: Mapping[str, Any],
        retry_after_seconds: int | None = None,
        *,
        private_scope: PrivateConversationScope | None = None,
        allow_private: bool = False,
        private_only: bool = False,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> JsonObject:
        """Persist a delivery result; uncertain outcomes are terminal until reviewed. |
        记录投递结果。"""

        if outcome not in {"delivered", "failed", "uncertain", "retry"}:
            raise _invalid("WORK_NOTIFICATION_INVALID_OUTCOME", "outcome is not valid")
        if outcome == "retry" and (
            type(retry_after_seconds) is not int or not 1 <= retry_after_seconds <= 300
        ):
            raise _invalid(
                "WORK_NOTIFICATION_INVALID_RETRY",
                "A retry outcome requires retryAfterSeconds between 1 and 300.",
            )
        if outcome != "retry" and retry_after_seconds is not None:
            raise _invalid(
                "WORK_NOTIFICATION_INVALID_RETRY",
                "retryAfterSeconds is supported only for the retry outcome.",
            )
        return self._notification_transition(
            organization_id,
            workspace_id,
            notification_id,
            lease_token,
            outcome,
            result,
            retry_after_seconds=retry_after_seconds,
            private_scope=private_scope,
            allow_private=allow_private,
            private_only=private_only,
            actor_id=actor_id,
            actor_private_scope=actor_private_scope,
        )

    def get_attachment(
        self,
        organization_id: str | None,
        workspace_id: str,
        digest: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> tuple[JsonObject, Path]:
        """Authorize a digest against metadata in the exact Workspace before reading bytes. |
        读取附件。"""

        org, workspace = _scope(organization_id, workspace_id)
        digest = _validate_digest(digest)
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        if actor_private_scope and actor is None:
            raise _invalid(
                "WORK_ATTACHMENT_ACTOR_REQUIRED", "actor-private attachment requires an actor"
            )
        with self._read() as conn:
            row = None
            if actor_private_scope:
                row = conn.execute(
                    """SELECT * FROM work_private_attachments WHERE organization_id=?
                       AND workspace_id=? AND actor_id=? AND sha256=?""",
                    (org, workspace, actor, digest),
                ).fetchone()
            if row is None:
                row = conn.execute(
                    """SELECT * FROM work_attachments WHERE organization_id=? AND workspace_id=? AND
                        sha256=?""",
                    (org, workspace, digest),
                ).fetchone()
            if row is None:
                raise _not_found(
                    "WORK_ATTACHMENT_NOT_FOUND",
                    "The attachment does not exist in this Workspace.",
                )
            metadata = self._attachment_view(row)
        path = self._attachment_path(digest)
        if not path.is_file():
            raise PersistenceError(
                "WORK_ATTACHMENT_CONTENT_MISSING",
                500,
                "The authorized attachment bytes are missing.",
            )
        return metadata, path

    def put_attachment(
        self,
        organization_id: str | None,
        workspace_id: str,
        name: str,
        media_type: str,
        raw: bytes,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> JsonObject:
        """Store a content-addressed attachment with workspace-specific metadata. |
        保存内容寻址附件。"""

        org, workspace = _scope(organization_id, workspace_id)
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        if actor_private_scope and actor is None:
            raise _invalid(
                "WORK_ATTACHMENT_ACTOR_REQUIRED", "actor-private attachment requires an actor"
            )
        name = _bounded_text(name, "name", 512)
        media_type = _bounded_text(media_type, "mediaType", 256)
        if not raw or len(raw) > 10_000_000:
            raise _invalid(
                "WORK_ATTACHMENT_INVALID_SIZE",
                "Attachment bytes must be between 1 and 10 MB.",
            )
        digest = hashlib.sha256(raw).hexdigest()
        path = self._attachment_path(digest)
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            temporary = path.with_name(f".{digest}.{uuid4().hex}.tmp")
            try:
                temporary.write_bytes(raw)
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
        now = _unix_ms()
        with self._mutation() as conn:
            if actor_private_scope:
                conn.execute(
                    """INSERT INTO work_private_attachments(organization_id,workspace_id,
                       actor_id,sha256,name,media_type,size,created_at)
                       VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,workspace_id,
                       actor_id,sha256) DO NOTHING""",
                    (org, workspace, actor, digest, name, media_type, len(raw), now),
                )
                row = conn.execute(
                    """SELECT * FROM work_private_attachments WHERE organization_id=?
                       AND workspace_id=? AND actor_id=? AND sha256=?""",
                    (org, workspace, actor, digest),
                ).fetchone()
            else:
                conn.execute(
                    """INSERT INTO work_attachments(organization_id,workspace_id,sha256,name,
                       media_type,size,created_at)
                       VALUES(?,?,?,?,?,?,?) ON CONFLICT(organization_id,workspace_id,sha256) DO
                       NOTHING""",
                    (org, workspace, digest, name, media_type, len(raw), now),
                )
                row = conn.execute(
                    """SELECT * FROM work_attachments WHERE organization_id=? AND
                       workspace_id=? AND sha256=?""",
                    (org, workspace, digest),
                ).fetchone()
            return self._attachment_view(row)

    def update_connector_status(
        self,
        organization_id: str | None,
        workspace_id: str,
        connector_id: str,
        body: Mapping[str, Any],
    ) -> JsonObject:
        """Persist typed connector health without retaining credentials or QR payloads. |
        更新连接器状态。"""

        org, workspace = _scope(organization_id, workspace_id)
        connector_id = _identifier(connector_id, "connector id")
        status = body.get("status")
        allowed = {
            "unknown",
            "disconnected",
            "authenticating",
            "login_required",
            "connected",
            "degraded",
            "error",
        }
        if status not in allowed:
            raise _invalid(
                "WORK_CONNECTOR_INVALID_STATUS",
                "status is not a supported connector state",
            )
        account_id = _optional_text(body.get("accountId"), "accountId", 512)
        detail = _optional_text(body.get("detail"), "detail", 2_000)
        now = _unix_ms()
        with self._mutation() as conn:
            conn.execute(
                """INSERT INTO work_connector_states(organization_id,workspace_id,
                   connector_id,status,
                   account_id,detail,updated_at,last_event_at) VALUES(?,?,?,?,?,?,?,NULL)
                   ON CONFLICT(organization_id,workspace_id,connector_id) DO UPDATE SET
                     status=excluded.status,account_id=excluded.account_id,detail=excluded.detail,
                     updated_at=excluded.updated_at""",
                (org, workspace, connector_id, status, account_id, detail, now),
            )
            row = conn.execute(
                (
                    "SELECT * FROM work_connector_states WHERE organization_id=? AND "
                    "workspace_id=? AND connector_id=?"
                ),
                (org, workspace, connector_id),
            ).fetchone()
            return self._connector_view(row)

    def list_connectors(self, organization_id: str | None, workspace_id: str) -> list[JsonObject]:
        """List only registered connector states in this Workspace. | 列出连接器状态。"""

        org, workspace = _scope(organization_id, workspace_id)
        with self._read() as conn:
            rows = conn.execute(
                (
                    "SELECT * FROM work_connector_states WHERE organization_id=? AND "
                    "workspace_id=? ORDER BY connector_id"
                ),
                (org, workspace),
            ).fetchall()
            return [self._connector_view(row) for row in rows]

    def register_connector_event(
        self,
        organization_id: str | None,
        workspace_id: str,
        connector_id: str,
        body: Mapping[str, Any],
        actor_id: str | None = None,
        *,
        actor_private_scope: bool = False,
        private_scope: PrivateConversationScope | None = None,
    ) -> tuple[JsonObject, JsonObject | None]:
        """Register a deduplicated connector event and optional task atomically. |
        原子接收连接事件。"""

        org, workspace = _scope(organization_id, workspace_id)
        connector_id = _identifier(connector_id, "connector id")
        message_id = _identifier(body.get("messageId"), "messageId")
        event_type = _bounded_text(body.get("type"), "type", 256)
        supplied_occurred_at = body.get("occurredAt")
        occurred_at = supplied_occurred_at if supplied_occurred_at is not None else _unix_ms()
        _nonnegative_integer(occurred_at, "occurredAt")
        account_id = _optional_text(body.get("accountId"), "accountId", 512)
        conversation_id = _optional_text(body.get("conversationId"), "conversationId", 512)
        sender_id = _optional_text(body.get("senderId"), "senderId", 512)
        payload = _json_object(body.get("payload", {}), "payload")
        teams_message = _teams_thread_message(body.get("teamsThreadMessage"))
        teams_private_message = _teams_private_message(body.get("teamsPrivateMessage"))
        trusted_actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        if teams_message is not None and teams_private_message is not None:
            raise _invalid(
                "WORK_CONNECTOR_INVALID_TEAMS_ORIGIN",
                "A connector event cannot be both channel and private Teams ingress.",
            )
        if teams_message is not None and (
            trusted_actor is None
            or str(teams_message["actorSubject"]).lower() != trusted_actor.lower()
        ):
            raise PersistenceError(
                "WORK_CONNECTOR_TEAMS_ACTOR_MISMATCH",
                403,
                "The Teams event actor must match the authenticated Work principal.",
            )
        if teams_private_message is not None:
            if (
                connector_id != "teams-v1"
                or event_type != "message.received"
                or trusted_actor is None
                or actor_private_scope is not True
                or private_scope is None
                or private_scope.workspace_id != workspace
                or private_scope.issuer
                != f"https://login.microsoftonline.com/{private_scope.tenant_id.lower()}/v2.0"
                or trusted_actor not in private_scope.owner_subjects
            ):
                raise PersistenceError(
                    "WORK_TEAMS_PRIVATE_MESSAGE_FORBIDDEN",
                    403,
                    "Private Teams message intake is unavailable or unauthorized.",
                )
            if body.get("messageId") != teams_private_message["messageId"]:
                raise _invalid(
                    "WORK_CONNECTOR_INVALID_TEAMS_PRIVATE_MESSAGE",
                    "teamsPrivateMessage.messageId must match messageId.",
                )
            if account_id is not None or conversation_id is not None or sender_id is not None:
                raise _invalid(
                    "WORK_CONNECTOR_INVALID_TEAMS_PRIVATE_MESSAGE",
                    "Private Teams ingress cannot supply route or sender fields.",
                )
            account_id = private_scope.bot_app_id.lower()
            sender_id = trusted_actor
            payload = {
                "provider": "teams",
                "messageId": teams_private_message["messageId"],
                "text": teams_private_message["text"],
            }
        if (
            teams_message is None
            and teams_private_message is None
            and (payload.get("provider") == "teams" or event_type.lower().startswith("teams."))
        ):
            raise PersistenceError(
                "WORK_CONNECTOR_TEAMS_EVENT_UNVERIFIED",
                403,
                "Teams event content requires the authenticated Teams ingress envelope.",
            )
        if teams_message is not None and payload.get("messageId") != teams_message["messageId"]:
            raise _invalid(
                "WORK_CONNECTOR_INVALID_TEAMS_THREAD",
                "teamsThreadMessage.messageId must match the canonical event payload.",
            )
        if event_type.endswith("login.qr") or any(
            key in payload for key in ("qrPayload", "qr_payload")
        ):
            raise _invalid(
                "WORK_CONNECTOR_QR_NOT_PERSISTED",
                "Use the configured connector login/qr bridge; raw QR payloads are not persisted.",
            )
        task_body = body.get("task")
        if teams_private_message is not None and not isinstance(task_body, Mapping):
            raise _invalid(
                "WORK_CONNECTOR_PRIVATE_TASK_REQUIRED",
                "Private Teams messages require a task before they can be accepted.",
            )
        task_digest_body: JsonObject | None = None
        if task_body is not None:
            if not isinstance(task_body, Mapping):
                raise _invalid("WORK_CONNECTOR_INVALID_EVENT", "task must be an object")
            task_digest_body = {
                "id": task_body.get("id"),
                "sessionId": task_body.get("sessionId"),
                "prompt": task_body.get("prompt"),
                "title": task_body.get("title"),
                "description": task_body.get("description"),
                "metadata": task_body.get("metadata", {}),
            }
            if teams_message is not None:
                metadata = _json_object(task_digest_body["metadata"], "task.metadata")
                route = {
                    key: teams_message[key]
                    for key in (
                        "tenantId",
                        "teamId",
                        "channelId",
                        "conversationId",
                        "rootThreadId",
                    )
                }
                if teams_message.get("serviceUrl"):
                    route["serviceUrl"] = teams_message["serviceUrl"]
                metadata["teamsCaller"] = {
                    "issuer": teams_message["actorIssuer"],
                    "subject": teams_message["actorSubject"],
                    "tenantId": teams_message["tenantId"],
                    "actorAadObjectId": teams_message["actorSubject"],
                }
                metadata["teamsThread"] = {
                    "threadId": teams_message["threadId"],
                    **route,
                }
                metadata["notification"] = {
                    "type": "teams.message",
                    "connectorId": connector_id,
                    "recipient": f"teams:{teams_message['threadId']}",
                    "payload": route,
                }
                task_digest_body["metadata"] = metadata
            elif teams_private_message is not None:
                metadata = _json_object(task_digest_body["metadata"], "task.metadata")
                for private_route_key in (
                    "notification",
                    "teamsCaller",
                    "teamsThread",
                    "teamsPrivate",
                ):
                    metadata.pop(private_route_key, None)
                task_digest_body["metadata"] = metadata
        teams_digest_message = (
            {key: item for key, item in teams_message.items() if key != "sessionId"}
            if teams_message is not None
            else None
        )
        private_digest_message = (
            {
                "messageId": teams_private_message["messageId"],
                "text": teams_private_message["text"],
            }
            if teams_private_message is not None
            else None
        )
        event_body = {
            "type": event_type,
            "occurredAt": supplied_occurred_at,
            "accountId": account_id,
            "conversationId": conversation_id,
            "senderId": sender_id,
            "payload": payload,
            "task": None if teams_message is not None else task_digest_body,
            "teamsThreadMessage": teams_digest_message,
            "teamsPrivateMessage": private_digest_message,
        }
        event_digest = _digest(event_body)
        event_actor_id = (
            trusted_actor
            if teams_message is not None or teams_private_message is not None
            else None
        )
        now = _unix_ms()
        with self._mutation() as conn:
            if event_actor_id is None:
                existing = conn.execute(
                    """SELECT * FROM work_connector_events WHERE organization_id=?
                       AND workspace_id=? AND connector_id=? AND message_id=?
                         AND origin_actor_id IS NULL""",
                    (org, workspace, connector_id, message_id),
                ).fetchone()
            else:
                existing = conn.execute(
                    """SELECT * FROM work_connector_events WHERE organization_id=?
                       AND workspace_id=? AND connector_id=? AND message_id=? AND (
                         origin_actor_id=? OR (origin_actor_id IS NULL AND
                           lower(sender_id)=? AND
                           lower(json_extract(payload_json,'$.provider'))='teams'))""",
                    (
                        org,
                        workspace,
                        connector_id,
                        message_id,
                        event_actor_id,
                        event_actor_id,
                    ),
                ).fetchone()
            if existing is not None:
                if str(existing["event_digest"]) != event_digest:
                    raise _conflict(
                        "WORK_CONNECTOR_EVENT_ID_CONFLICT",
                        "messageId names different event content.",
                    )
                if existing["origin_actor_id"] is not None and (
                    trusted_actor is None or str(existing["origin_actor_id"]) != trusted_actor
                ):
                    raise _not_found(
                        "WORK_CONNECTOR_EVENT_NOT_FOUND",
                        "The connector event does not exist for this actor.",
                    )
                stored_task = None
                if existing["task_id"]:
                    stored_task = self._task_view(
                        conn, self._require_task(conn, org, workspace, str(existing["task_id"]))
                    )
                return {
                    "eventId": str(existing["event_id"]),
                    "duplicate": True,
                    "receivedAt": int(existing["received_at"]),
                }, stored_task
            if teams_private_message is not None:
                assert private_scope is not None and trusted_actor is not None
                installation = conn.execute(
                    """SELECT active FROM work_private_installations
                       WHERE organization_id=? AND workspace_id=? AND tenant_id=?
                         AND actor_aad_object_id=? AND bot_app_id=?""",
                    (
                        org,
                        workspace,
                        private_scope.tenant_id.lower(),
                        trusted_actor,
                        private_scope.bot_app_id.lower(),
                    ),
                ).fetchone()
                if installation is None or not bool(installation["active"]):
                    raise PersistenceError(
                        "WORK_TEAMS_PRIVATE_INSTALLATION_NOT_FOUND",
                        403,
                        "An active private Teams installation is required for this message.",
                    )
            task_view: JsonObject | None = None
            task_id: str | None = None
            private_teams_origin: JsonObject | None = None
            if teams_private_message is not None:
                assert private_scope is not None and trusted_actor is not None
                private_teams_origin = {
                    "actorIssuer": private_scope.issuer,
                    "actorSubject": trusted_actor,
                    "tenantId": private_scope.tenant_id.lower(),
                    "botAppId": private_scope.bot_app_id.lower(),
                    "connectorId": connector_id,
                    "threadId": _teams_private_origin_thread_id(
                        private_scope.tenant_id,
                        trusted_actor,
                        private_scope.bot_app_id,
                    ),
                    "messageId": str(teams_private_message["messageId"]),
                    "conversationKind": "private",
                }
            if task_digest_body is not None:
                task_view, _duplicate = self._create_task_in_transaction(
                    conn,
                    org,
                    workspace,
                    task_digest_body,
                    now,
                    actor_id,
                    actor_private_scope=actor_private_scope,
                    teams_origin=(
                        {
                            "actorIssuer": str(teams_message["actorIssuer"]),
                            "actorSubject": str(teams_message["actorSubject"]),
                            "tenantId": str(teams_message["tenantId"]),
                            "connectorId": connector_id,
                            "threadId": str(teams_message["threadId"]),
                            "messageId": str(teams_message["messageId"]),
                            "conversationKind": "channel",
                        }
                        if teams_message is not None
                        else private_teams_origin
                    ),
                )
                task_id = str(task_view["id"])
            if teams_message is not None:
                if (
                    task_view is not None
                    and teams_message.get("sessionId") is not None
                    and str(task_view["sessionId"]) != str(teams_message["sessionId"])
                ):
                    raise _conflict(
                        "WORK_CONNECTOR_THREAD_SESSION_MISMATCH",
                        "The Teams task and thread mapping must use the same Session.",
                    )
                self._store_teams_thread_message(
                    conn, org, workspace, connector_id, teams_message, now
                )
            event_id = uuid4().hex
            sequence_row = conn.execute(
                """SELECT COALESCE(MAX(seq),0) AS seq FROM work_connector_events
                   WHERE organization_id=? AND workspace_id=? AND connector_id=?""",
                (org, workspace, connector_id),
            ).fetchone()
            seq = int(sequence_row["seq"]) + 1
            conn.execute(
                """INSERT INTO work_connector_events(organization_id,workspace_id,connector_id,seq,
                   event_id,message_id,event_type,occurred_at,received_at,account_id,conversation_id,
                   sender_id,payload_json,event_digest,task_id,expires_at,origin_actor_id)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    org,
                    workspace,
                    connector_id,
                    seq,
                    event_id,
                    message_id,
                    event_type,
                    occurred_at,
                    now,
                    account_id,
                    conversation_id,
                    sender_id,
                    _json_text(payload),
                    event_digest,
                    task_id,
                    _connector_event_expiry(event_type, payload),
                    event_actor_id,
                ),
            )
            if teams_private_message is not None and task_id is not None:
                assert private_scope is not None and trusted_actor is not None
                accepted_key = hashlib.sha256(f"{trusted_actor}\0{message_id}".encode()).hexdigest()
                self._enqueue_notification(
                    conn,
                    org,
                    workspace,
                    f"teams-private-accepted:{accepted_key}",
                    "teams.message",
                    {"text": _PRIVATE_TEAMS_ACCEPTED_ACK_TEXT},
                    "teams-v1",
                    "teams:owner-private",
                    task_id,
                    now,
                    now,
                    owner_actor_id=trusted_actor,
                    private_owner={
                        "taskId": task_id,
                        "tenantId": private_scope.tenant_id,
                        "actorAadObjectId": trusted_actor,
                        "botAppId": private_scope.bot_app_id,
                    },
                )
            mapped_status = _connector_status_for_event(event_type, payload)
            if mapped_status is not None:
                conn.execute(
                    """INSERT INTO work_connector_states(organization_id,workspace_id,
                       connector_id,status,
                       account_id,detail,updated_at,last_event_at) VALUES(?,?,?,?,?,?,?,?)
                       ON CONFLICT(organization_id,workspace_id,connector_id) DO UPDATE SET
                         status=excluded.status,
                         account_id=COALESCE(excluded.account_id,work_connector_states.account_id),
                         detail=excluded.detail,updated_at=excluded.updated_at,last_event_at=excluded.last_event_at""",
                    (
                        org,
                        workspace,
                        connector_id,
                        mapped_status,
                        account_id,
                        None,
                        now,
                        now,
                    ),
                )
            else:
                conn.execute(
                    """UPDATE work_connector_states SET updated_at=?,last_event_at=?
                       WHERE organization_id=? AND workspace_id=? AND connector_id=?""",
                    (now, now, org, workspace, connector_id),
                )
            return {
                "eventId": event_id,
                "duplicate": False,
                "receivedAt": now,
            }, task_view

    def get_connector_thread(
        self,
        organization_id: str | None,
        workspace_id: str,
        connector_id: str,
        thread_id: str,
        *,
        actor_id: str,
        message_limit: int = 20,
        exclude_message_id: str | None = None,
    ) -> JsonObject:
        """Read the exact Teams thread mapping and bounded participant context.

        Args:
            organization_id: Authenticated organization scope.
            workspace_id: Authenticated Workspace scope.
            connector_id: Configured connector binding.
            thread_id: Stable host-derived digest of tenant/team/channel/root thread IDs.
            message_limit: Maximum context messages, newest messages win.
        Returns:
            The mapped DSH Session and recent participant text in chronological order.
        Raises:
            PersistenceError: If no mapped thread exists or the page is invalid.

        中文：按精确线程摘要查询持久 Session 映射和最近讨论内容。
        """

        org, workspace = _scope(organization_id, workspace_id)
        connector_id = _identifier(connector_id, "connector id")
        thread_id = _identifier(thread_id, "thread id")
        actor = _identifier(actor_id, "actorId").lower()
        excluded = _optional_text(exclude_message_id, "excludeMessageId", 512)
        if type(message_limit) is not int or not 1 <= message_limit <= 100:
            raise _invalid("WORK_CONNECTOR_INVALID_THREAD_PAGE", "messageLimit must be 1 to 100")
        with self._read() as conn:
            row = conn.execute(
                """SELECT * FROM work_connector_actor_threads WHERE organization_id=?
                   AND workspace_id=? AND connector_id=? AND thread_id=? AND actor_subject=?""",
                (org, workspace, connector_id, thread_id, actor),
            ).fetchone()
            route_row = row
            if route_row is None:
                route_row = conn.execute(
                    """SELECT tenant_id,team_id,channel_id,conversation_id,root_thread_id,
                       service_url,NULL AS session_id FROM work_connector_thread_messages
                       WHERE organization_id=? AND workspace_id=? AND connector_id=?
                         AND thread_id=? AND actor_subject=?
                       ORDER BY created_at DESC,message_id DESC LIMIT 1""",
                    (org, workspace, connector_id, thread_id, actor),
                ).fetchone()
            if route_row is None:
                raise _not_found(
                    "WORK_CONNECTOR_THREAD_NOT_FOUND", "The Teams thread has no accepted messages."
                )
            exclusion = "" if excluded is None else "AND message_id<>?"
            message_params: tuple[Any, ...] = (org, workspace, connector_id, thread_id, actor)
            if excluded is not None:
                message_params += (excluded,)
            message_params += (message_limit,)
            message_rows = conn.execute(
                f"""SELECT * FROM work_connector_thread_messages WHERE organization_id=? AND
                   workspace_id=? AND connector_id=? AND thread_id=? AND actor_subject=? {exclusion}
                   ORDER BY created_at DESC,message_id DESC LIMIT ?""",
                message_params,
            ).fetchall()
            return {
                "threadId": thread_id,
                "tenantId": str(route_row["tenant_id"]),
                "teamId": str(route_row["team_id"]),
                "channelId": str(route_row["channel_id"]),
                "conversationId": str(route_row["conversation_id"]),
                "rootThreadId": str(route_row["root_thread_id"]),
                "serviceUrl": str(route_row["service_url"] or ""),
                "sessionId": (
                    str(row["session_id"])
                    if row is not None and row["session_id"] is not None
                    else None
                ),
                "messages": [
                    {
                        "messageId": str(item["message_id"]),
                        "actorIssuer": str(item["actor_issuer"]),
                        "actorSubject": str(item["actor_subject"]),
                        "text": str(item["message_text"]),
                        "createdAt": int(item["created_at"]),
                    }
                    for item in reversed(message_rows)
                ],
            }

    def _store_teams_thread_message(
        self,
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        connector_id: str,
        message: Mapping[str, Any],
        now: int,
    ) -> None:
        """Persist verified Teams context and atomically establish owner thread mappings."""

        thread_id = str(message["threadId"])
        message_id = str(message["messageId"])
        route_fields = (
            "tenantId",
            "teamId",
            "channelId",
            "conversationId",
            "rootThreadId",
        )
        route = {field: str(message[field]) for field in route_fields}
        service_url = str(message.get("serviceUrl", ""))
        actor_issuer = str(message["actorIssuer"])
        actor_subject = str(message["actorSubject"]).lower()
        session_id = message.get("sessionId")
        actor_row = conn.execute(
            """SELECT * FROM work_connector_actor_threads WHERE organization_id=?
               AND workspace_id=? AND connector_id=? AND thread_id=? AND actor_subject=?""",
            (org, workspace, connector_id, thread_id, actor_subject),
        ).fetchone()
        if actor_row is not None:
            if (
                any(
                    str(actor_row[column]) != route[field]
                    for field, column in zip(
                        route_fields,
                        ("tenant_id", "team_id", "channel_id", "conversation_id", "root_thread_id"),
                        strict=True,
                    )
                )
                or str(actor_row["actor_issuer"]) != actor_issuer
                or (
                    session_id is not None
                    and actor_row["session_id"] is not None
                    and str(actor_row["session_id"]) != str(session_id)
                )
            ):
                raise _conflict(
                    "WORK_CONNECTOR_THREAD_CONFLICT",
                    "The actor-specific Teams thread already has a different route or session.",
                )
            conn.execute(
                """UPDATE work_connector_actor_threads SET service_url=?,
                   session_id=COALESCE(session_id,?),updated_at=? WHERE organization_id=?
                   AND workspace_id=? AND connector_id=? AND thread_id=? AND actor_subject=?""",
                (
                    service_url,
                    session_id,
                    now,
                    org,
                    workspace,
                    connector_id,
                    thread_id,
                    actor_subject,
                ),
            )
        else:
            conn.execute(
                """INSERT INTO work_connector_actor_threads(organization_id,workspace_id,
                   connector_id,thread_id,actor_issuer,actor_subject,tenant_id,team_id,
                   channel_id,conversation_id,root_thread_id,service_url,session_id,
                   created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    org,
                    workspace,
                    connector_id,
                    thread_id,
                    actor_issuer,
                    actor_subject,
                    route["tenantId"],
                    route["teamId"],
                    route["channelId"],
                    route["conversationId"],
                    route["rootThreadId"],
                    service_url,
                    session_id,
                    now,
                    now,
                ),
            )
        if session_id is not None:
            session_id = str(session_id)
            existing = conn.execute(
                """SELECT * FROM work_connector_threads WHERE organization_id=? AND workspace_id=?
                   AND connector_id=? AND thread_id=?""",
                (org, workspace, connector_id, thread_id),
            ).fetchone()
            if existing is not None:
                if any(
                    str(existing[column]) != route[field]
                    for field, column in zip(
                        route_fields,
                        (
                            "tenant_id",
                            "team_id",
                            "channel_id",
                            "conversation_id",
                            "root_thread_id",
                        ),
                        strict=True,
                    )
                ):
                    raise _conflict(
                        "WORK_CONNECTOR_THREAD_CONFLICT",
                        "The Teams thread key is already mapped to another session or route.",
                    )
                conn.execute(
                    """UPDATE work_connector_threads SET service_url=?,updated_at=?
                       WHERE organization_id=?
                       AND workspace_id=? AND connector_id=? AND thread_id=?""",
                    (service_url, now, org, workspace, connector_id, thread_id),
                )
            else:
                conn.execute(
                    """INSERT INTO work_connector_threads(organization_id,workspace_id,
                       connector_id,thread_id,tenant_id,team_id,channel_id,conversation_id,
                       root_thread_id,service_url,session_id,created_at,updated_at,owner_actor_id)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        org,
                        workspace,
                        connector_id,
                        thread_id,
                        route["tenantId"],
                        route["teamId"],
                        route["channelId"],
                        route["conversationId"],
                        route["rootThreadId"],
                        service_url,
                        session_id,
                        now,
                        now,
                        actor_subject,
                    ),
                )
        conn.execute(
            """INSERT OR IGNORE INTO work_connector_thread_messages(
               organization_id,workspace_id,connector_id,thread_id,message_id,tenant_id,team_id,
               channel_id,conversation_id,root_thread_id,service_url,actor_issuer,actor_subject,
               message_text,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                org,
                workspace,
                connector_id,
                thread_id,
                message_id,
                route["tenantId"],
                route["teamId"],
                route["channelId"],
                route["conversationId"],
                route["rootThreadId"],
                service_url,
                str(message["actorIssuer"]),
                str(message["actorSubject"]),
                str(message["text"]),
                now,
            ),
        )

    def list_connector_events(
        self,
        organization_id: str | None,
        workspace_id: str,
        connector_id: str,
        after: int = 0,
        limit: int = 100,
        *,
        actor_id: str,
        actor_private_scope: bool = False,
    ) -> tuple[list[JsonObject], int]:
        """Read workspace connector events while redacting expired QR payloads. | 读取连接事件。"""

        org, workspace = _scope(organization_id, workspace_id)
        connector_id = _identifier(connector_id, "connector id")
        actor = _identifier(actor_id, "actorId").lower()
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 1_000:
            raise _invalid("WORK_CONNECTOR_INVALID_CURSOR", "after and limit are invalid")
        now = _unix_ms()
        with self._read() as conn:
            if actor_private_scope:
                visibility = "(origin_actor_id=? OR (origin_actor_id IS NULL AND "
                visibility += "json_extract(payload_json,'$.provider')='teams' "
                visibility += "AND lower(sender_id)=?))"
            else:
                visibility = "(origin_actor_id=? OR (origin_actor_id IS NULL AND "
                visibility += "(json_extract(payload_json,'$.provider') IS NOT 'teams' "
                visibility += "AND event_type NOT LIKE 'teams.%' OR lower(sender_id)=?)))"
            rows = conn.execute(
                f"""SELECT * FROM work_connector_events WHERE organization_id=? AND workspace_id=?
                   AND connector_id=? AND seq>? AND {visibility}
                   ORDER BY seq LIMIT ?""",
                (org, workspace, connector_id, after, actor, actor, limit),
            ).fetchall()
            max_row = conn.execute(
                """SELECT COALESCE(MAX(seq),0) AS seq FROM work_connector_events
                   WHERE organization_id=? AND workspace_id=? AND connector_id=?""",
                (org, workspace, connector_id),
            ).fetchone()
            result: list[JsonObject] = []
            for row in rows:
                payload = _stored_object(row["payload_json"], "connector event payload")
                expired = row["expires_at"] is not None and int(row["expires_at"]) <= now
                if expired and str(row["event_type"]).endswith("login.qr"):
                    payload = {"expired": True}
                result.append(
                    {
                        "seq": int(row["seq"]),
                        "eventId": str(row["event_id"]),
                        "messageId": str(row["message_id"]),
                        "type": str(row["event_type"]),
                        "occurredAt": int(row["occurred_at"]),
                        "receivedAt": int(row["received_at"]),
                        "accountId": row["account_id"],
                        "conversationId": row["conversation_id"],
                        "senderId": row["sender_id"],
                        "payload": payload,
                        "redacted": bool(expired),
                    }
                )
            return result, int(max_row["seq"])

    def append_automation_event(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        event: Mapping[str, Any],
    ) -> tuple[JsonObject, bool]:
        """Append an immutable actor-owned source observation with stable deduplication.

        Args:
            organization_id: Authenticated organization scope.
            workspace_id: Authenticated Workspace scope.
            actor_id: Actor from the configured persistence principal.
            event: Strict source observation fields; identity and visibility are not accepted.
        Returns:
            The stored event projection and whether this call replayed an exact retry.

        中文：只接受服务端 actor 的私有观察记录，并按来源事件标识原子去重。
        """

        org, workspace = _scope(organization_id, workspace_id)
        actor = _identifier(actor_id, "actorId")
        value = _validate_automation_event(event)
        digest = _digest(value)
        now = _unix_ms()
        event_id = str(uuid4())
        record: JsonObject = {
            **value,
            "id": event_id,
            "observedAt": now,
            "actorId": actor,
            "organizationId": org,
            "workspaceId": workspace,
            "revision": 1,
            "visibility": "owner",
        }
        with self._mutation() as conn:
            prior = conn.execute(
                """SELECT * FROM work_automation_events
                   WHERE organization_id=? AND workspace_id=? AND source=?
                     AND source_event_id=? AND actor_id=?""",
                (org, workspace, value["source"], value["sourceEventId"], actor),
            ).fetchone()
            if prior is not None:
                if str(prior["event_digest"]) != digest:
                    raise _conflict(
                        "WORK_AUTOMATION_EVENT_ID_CONFLICT",
                        "The source event id names different content.",
                    )
                return _stored_object(prior["event_json"], "automation event"), True
            conn.execute(
                """INSERT INTO work_automation_events(
                    organization_id,workspace_id,source,source_event_id,event_id,actor_id,
                    observed_at,event_json,event_digest,visibility
                ) VALUES(?,?,?,?,?,?,?,?,?,'owner')""",
                (
                    org,
                    workspace,
                    value["source"],
                    value["sourceEventId"],
                    event_id,
                    actor,
                    now,
                    _json_text(record),
                    digest,
                ),
            )
        return record, False

    def apply_private_installation(
        self,
        organization_id: str | None,
        workspace_id: str,
        action: str,
        trust: Mapping[str, Any],
    ) -> tuple[JsonObject, bool]:
        """Atomically bind or revoke one verified private Teams installation.

        The caller has already validated the current owner projection and pinned
        tenant/application policy. This transaction only persists those normalized
        facts and makes activity replay idempotent. 中文：移除事件立即停用私聊路由。
        """

        org, workspace = _scope(organization_id, workspace_id)
        if action not in {"add", "remove"} or trust.get("installationAction") != action:
            raise _invalid(
                "WORK_TEAMS_PRIVATE_INSTALLATION_INVALID", "installation action is invalid"
            )
        required = {
            "tenantId",
            "actorAadObjectId",
            "botAppId",
            "conversationId",
            "activityId",
            "activityOccurredAt",
            "serviceUrl",
            "installationAction",
        }
        if set(trust) != required:
            raise _invalid(
                "WORK_TEAMS_PRIVATE_INSTALLATION_INVALID", "verified trust fields are invalid"
            )
        tenant = _canonical_uuid(trust.get("tenantId"), "tenantId")
        actor = _canonical_uuid(trust.get("actorAadObjectId"), "actorAadObjectId")
        bot_app = _canonical_uuid(trust.get("botAppId"), "botAppId")
        conversation = _identifier(trust.get("conversationId"), "conversationId")
        activity_id = _identifier(trust.get("activityId"), "activityId")
        service_url = _teams_service_url(trust.get("serviceUrl"), tenant)
        now = _unix_ms()
        activity_occurred_at = _private_installation_activity_timestamp_ms(
            trust.get("activityOccurredAt"), now
        )
        normalized_trust = {
            "tenantId": tenant,
            "actorAadObjectId": actor,
            "botAppId": bot_app,
            "conversationId": conversation,
            "activityId": activity_id,
            "activityOccurredAt": activity_occurred_at,
            "serviceUrl": service_url,
            "installationAction": action,
        }
        digest = _digest({"action": action, "trust": normalized_trust})
        with self._mutation() as conn:
            prior_event = conn.execute(
                """SELECT event_digest,receipt_json FROM work_private_installation_events
                   WHERE organization_id=? AND workspace_id=? AND tenant_id=?
                     AND actor_aad_object_id=? AND bot_app_id=? AND activity_id=?""",
                (org, workspace, tenant, actor, bot_app, activity_id),
            ).fetchone()
            if prior_event is not None:
                if str(prior_event["event_digest"]) != digest:
                    raise _conflict(
                        "WORK_TEAMS_PRIVATE_INSTALLATION_EVENT_CONFLICT",
                        "The Teams activity id names a different installation change.",
                    )
                return _stored_object(
                    prior_event["receipt_json"], "private installation receipt"
                ), True

            current = conn.execute(
                """SELECT * FROM work_private_installations
                   WHERE organization_id=? AND workspace_id=? AND tenant_id=?
                     AND actor_aad_object_id=? AND bot_app_id=?""",
                (org, workspace, tenant, actor, bot_app),
            ).fetchone()

            def persist_event(receipt: JsonObject) -> None:
                conn.execute(
                    """INSERT INTO work_private_installation_events(
                        organization_id,workspace_id,tenant_id,actor_aad_object_id,bot_app_id,
                        activity_id,activity_occurred_at,action,event_digest,receipt_json,created_at
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        org,
                        workspace,
                        tenant,
                        actor,
                        bot_app,
                        activity_id,
                        activity_occurred_at,
                        action,
                        digest,
                        _json_text(receipt),
                        now,
                    ),
                )
                conn.execute(
                    """DELETE FROM work_private_installation_events
                       WHERE organization_id=? AND workspace_id=? AND created_at<?""",
                    (org, workspace, now - _PRIVATE_INSTALL_EVENT_RETENTION_MS),
                )
                conn.execute(
                    """DELETE FROM work_private_installation_events WHERE row_id IN (
                        SELECT row_id FROM work_private_installation_events
                        WHERE organization_id=? AND workspace_id=?
                        ORDER BY row_id DESC LIMIT -1 OFFSET ?
                    )""",
                    (org, workspace, _PRIVATE_INSTALL_EVENT_MAX_PER_WORKSPACE),
                )

            current_timestamp = (
                int(current["last_activity_occurred_at"])
                if current is not None and current["last_activity_occurred_at"] is not None
                else None
            )
            current_active = bool(current["active"]) if current is not None else False
            ignored = False
            if current is not None and current_timestamp is None and action == "add":
                # A migrated installation has no trustworthy event order. A signed
                # remove is safe because it only revokes; add must wait until that
                # removal establishes a timestamped baseline.
                ignored = True
            elif current_timestamp is not None and activity_occurred_at < current_timestamp:
                ignored = True
            elif (
                current_timestamp is not None
                and activity_occurred_at == current_timestamp
                and (action == "add" or not current_active)
            ):
                # Arrival order cannot break equal timestamps; revocation wins ties.
                ignored = True

            if ignored:
                assert current is not None
                ignored_receipt = {
                    "action": action,
                    "active": current_active,
                    "applied": False,
                    "revision": int(current["revision"]),
                    "updatedAt": int(current["updated_at"]),
                }
                persist_event(ignored_receipt)
                return ignored_receipt, False

            revision = int(current["revision"]) + 1 if current is not None else 1
            if revision > 2**53 - 1:
                raise _conflict(
                    "WORK_TEAMS_PRIVATE_INSTALLATION_REVISION_EXHAUSTED",
                    "The private installation revision cannot be incremented safely.",
                )
            active = action == "add"
            stored_conversation = (
                str(current["conversation_id"])
                if action == "remove" and current is not None
                else conversation
            )
            stored_service_url = (
                str(current["service_url"])
                if action == "remove" and current is not None
                else service_url
            )
            conn.execute(
                """INSERT INTO work_private_installations(
                    organization_id,workspace_id,tenant_id,actor_aad_object_id,bot_app_id,
                    conversation_id,service_url,active,revision,updated_at,last_activity_id,
                    last_activity_digest,last_activity_occurred_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(organization_id,workspace_id,tenant_id,actor_aad_object_id,bot_app_id)
                DO UPDATE SET conversation_id=excluded.conversation_id,
                    service_url=excluded.service_url,active=excluded.active,
                    revision=excluded.revision,updated_at=excluded.updated_at,
                    last_activity_id=excluded.last_activity_id,
                    last_activity_digest=excluded.last_activity_digest,
                    last_activity_occurred_at=excluded.last_activity_occurred_at""",
                (
                    org,
                    workspace,
                    tenant,
                    actor,
                    bot_app,
                    stored_conversation,
                    stored_service_url,
                    int(active),
                    revision,
                    now,
                    activity_id,
                    digest,
                    activity_occurred_at,
                ),
            )
            applied_receipt: JsonObject = {
                "action": action,
                "active": active,
                "applied": True,
                "revision": revision,
                "updatedAt": now,
            }
            persist_event(applied_receipt)
            return applied_receipt, False

    def list_automation_events(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        limit: int = 50,
        cursor: str | None = None,
    ) -> JsonObject:
        """List only the authenticated actor's immutable observations. | 按 actor 读取事件。"""

        org, workspace = _scope(organization_id, workspace_id)
        actor = _identifier(actor_id, "actorId")
        if type(limit) is not int or not 1 <= limit <= 100:
            raise _invalid("WORK_AUTOMATION_EVENT_INVALID_PAGE", "limit must be between 1 and 100")
        decoded = _decode_cursor(cursor) if cursor else None
        filters = "organization_id=? AND workspace_id=? AND actor_id=?"
        params: list[Any] = [org, workspace, actor]
        if decoded:
            row_id, _event_id = decoded
            filters += " AND row_id<?"
            params.append(row_id)
        params.append(limit + 1)
        with self._read() as conn:
            rows = conn.execute(
                f"SELECT row_id,event_id,event_json FROM work_automation_events WHERE {filters} "
                "ORDER BY row_id DESC LIMIT ?",
                params,
            ).fetchall()
            has_more = len(rows) > limit
            items = [_stored_object(row["event_json"], "automation event") for row in rows[:limit]]
            next_cursor = None
            if has_more:
                last = rows[limit - 1]
                next_cursor = _encode_cursor(int(last["row_id"]), str(last["event_id"]))
            return {"items": items, "nextCursor": next_cursor}

    def _validate_private_owner_workflow(
        self,
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        actor_id: str,
        workflow: Mapping[str, Any],
        private_scope: PrivateConversationScope | None,
    ) -> None:
        """Require current Directory membership and active binding for V3 notices."""

        authorization = workflow.get("authorization")
        if not isinstance(authorization, Mapping) or authorization.get("kind") != "owner_private":
            raise _invalid(
                "WORK_WORKFLOW_V3_AUTHORIZATION_INVALID",
                "source-poll notices require owner_private routing",
            )
        _resolve_private_teams_route(
            conn,
            org,
            workspace,
            str(authorization.get("ownerTaskId") or ""),
            actor_id,
            private_scope,
        )

    def enqueue_automation_event_notice(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        event_id: str,
        body: Mapping[str, Any],
        *,
        private_scope: PrivateConversationScope | None = None,
    ) -> tuple[JsonObject, bool]:
        """Atomically consume one verified source event and create its owner notice.

        The source event, workflow actor, running occurrence task, and durable page
        receipt are checked in one SQLite transaction. The event state transition,
        consumption decision, and private outbox item commit together. 中文：重放只返原决策。
        """

        org, workspace = _scope(organization_id, workspace_id)
        actor = _identifier(actor_id, "actorId")
        event_id = _identifier(event_id, "eventId")
        allowed_fields = {
            "workflowId",
            "triggerId",
            "occurrenceId",
            "scheduledAt",
            "taskId",
        }
        if set(body) != allowed_fields:
            raise _invalid(
                "WORK_AUTOMATION_EVENT_NOTICE_INVALID",
                "event notice intent contains unsupported or missing fields",
            )
        workflow_id = _identifier(body.get("workflowId"), "workflowId")
        trigger_id = _identifier(body.get("triggerId"), "triggerId")
        occurrence_id = _bounded_text(body.get("occurrenceId"), "occurrenceId", 44)
        if not re.fullmatch(r"occ-[0-9a-f]{40}", occurrence_id):
            raise _invalid("WORK_AUTOMATION_EVENT_NOTICE_INVALID", "occurrenceId is invalid")
        scheduled_at = _bounded_text(body.get("scheduledAt"), "scheduledAt", 128)
        task_id = _identifier(body.get("taskId"), "taskId")
        if task_id != "workflow-" + occurrence_id[4:]:
            raise _invalid(
                "WORK_AUTOMATION_EVENT_NOTICE_INVALID",
                "the task id must match the occurrence id",
            )
        request_digest = _digest(
            {
                "workflowId": workflow_id,
                "triggerId": trigger_id,
                "occurrenceId": occurrence_id,
                "scheduledAt": scheduled_at,
                "taskId": task_id,
            }
        )
        now = _unix_ms()
        with self._mutation() as conn:
            event_row = conn.execute(
                """SELECT event_json,event_digest,actor_id FROM work_automation_events
                   WHERE organization_id=? AND workspace_id=? AND event_id=?""",
                (org, workspace, event_id),
            ).fetchone()
            if event_row is None or str(event_row["actor_id"]) != actor:
                raise _not_found(
                    "WORK_AUTOMATION_EVENT_NOT_FOUND",
                    "The automation event does not exist for this actor in this Workspace.",
                )
            workflow_row = conn.execute(
                """SELECT workflow_json FROM work_workflows WHERE organization_id=?
                   AND workspace_id=? AND workflow_id=? AND version=3 AND owner_actor_id=?""",
                (org, workspace, workflow_id, actor),
            ).fetchone()
            if workflow_row is None:
                raise _not_found(
                    "WORK_WORKFLOW_NOT_FOUND", "The workflow does not exist for this actor."
                )
            prior = conn.execute(
                """SELECT request_digest,receipt_json FROM work_automation_event_intents
                   WHERE organization_id=? AND workspace_id=? AND actor_id=? AND event_id=?
                     AND workflow_id=? AND trigger_id=?""",
                (org, workspace, actor, event_id, workflow_id, trigger_id),
            ).fetchone()
            if prior is not None:
                return _stored_object(prior["receipt_json"], "automation event intent"), True

            workflow = _validate_workflow_v3(
                _stored_object(workflow_row["workflow_json"], "workflow")
            )
            if not workflow["enabled"]:
                raise _conflict(
                    "WORK_WORKFLOW_DISABLED", "Disabled workflows cannot consume source events."
                )
            if workflow["authorization"]["kind"] != "owner_private":
                raise _invalid(
                    "WORK_WORKFLOW_V3_AUTHORIZATION_INVALID",
                    "Source event notices require owner_private routing.",
                )
            trigger = next(
                (
                    item
                    for item in workflow["triggers"]
                    if item["id"] == trigger_id and item["kind"] == "source_poll"
                ),
                None,
            )
            if trigger is None:
                raise _not_found(
                    "WORK_WORKFLOW_TRIGGER_NOT_FOUND", "The source poll trigger does not exist."
                )
            event = _stored_object(event_row["event_json"], "automation event")
            if event.get("source") != trigger["source"]:
                raise _conflict(
                    "WORK_AUTOMATION_EVENT_SOURCE_MISMATCH",
                    "The automation event source does not match the configured trigger.",
                )
            if event.get("stateClass") not in {
                "healthy",
                "incident",
                "neutral",
            } or not re.fullmatch(r"[a-f0-9]{64}", str(event.get("semanticFingerprint") or "")):
                raise _invalid(
                    "WORK_AUTOMATION_EVENT_STATE_REQUIRED",
                    "source event notices require a semantic fingerprint and stateClass",
                )
            run_row = conn.execute(
                """SELECT event_json FROM work_schedule_events WHERE organization_id=?
                   AND workspace_id=? AND workflow_id=? AND trigger_id=? AND occurrence_id=?
                     AND scheduled_at=? AND task_id=? AND status='running'""",
                (
                    org,
                    workspace,
                    workflow_id,
                    trigger_id,
                    occurrence_id,
                    scheduled_at,
                    task_id,
                ),
            ).fetchone()
            if run_row is None:
                raise _conflict(
                    "WORK_AUTOMATION_EVENT_OCCURRENCE_NOT_RUNNING",
                    "A matching running source poll ScheduleEvent is required.",
                )
            run_event = _stored_object(run_row["event_json"], "running schedule event")
            task_row = conn.execute(
                """SELECT * FROM work_tasks WHERE organization_id=? AND workspace_id=?
                   AND task_id=?""",
                (org, workspace, task_id),
            ).fetchone()
            if (
                task_row is None
                or str(task_row["created_by_actor_id"] or "").lower() != actor.lower()
                or str(task_row["status"]) != "running"
            ):
                raise _not_found(
                    "WORK_TASK_NOT_FOUND",
                    "The running workflow task does not exist for this actor.",
                )
            expected_occurrence = _v3_occurrence_id(
                workflow_id,
                trigger_id,
                scheduled_at,
                str(task_row["created_by_actor_id"]),
            )
            if occurrence_id != expected_occurrence:
                raise _invalid(
                    "WORK_AUTOMATION_EVENT_NOTICE_INVALID",
                    "occurrenceId does not match the server-owned task actor and schedule identity",
                )
            task_metadata = _stored_object(task_row["metadata_json"], "workflow task metadata")
            if (
                task_metadata.get("source") != "workflow"
                or task_metadata.get("workflowId") != workflow_id
                or task_metadata.get("triggerId") != trigger_id
                or task_metadata.get("occurrenceId") != occurrence_id
            ):
                raise _conflict(
                    "WORK_AUTOMATION_EVENT_TASK_MISMATCH",
                    "The task does not match this workflow occurrence.",
                )
            source_event_id = str(event["sourceEventId"])
            page_rows = conn.execute(
                """SELECT event_json FROM work_task_events WHERE organization_id=?
                   AND workspace_id=? AND task_id=? ORDER BY seq""",
                (org, workspace, task_id),
            ).fetchall()
            page_receipts = [
                _stored_object(row["event_json"], "source page receipt") for row in page_rows
            ]
            target_ids = set(trigger["targetIds"])
            event_type = str(event["eventType"])
            is_source_failure = event_type == "source.poll.failure"
            is_source_recovery = event_type == "source.poll.recovery"
            source_failure_reason: str | None = None
            target_id: str
            if is_source_failure:
                matching_source_error = next(
                    (
                        item
                        for item in page_receipts
                        if item.get("type") == "workflow.source-error.v1"
                        and item.get("workflowId") == workflow_id
                        and item.get("triggerId") == trigger_id
                        and item.get("occurrenceId") == occurrence_id
                        and item.get("scheduledAt") == scheduled_at
                    ),
                    None,
                )
                required_error_fields = {
                    "type",
                    "workflowId",
                    "triggerId",
                    "occurrenceId",
                    "scheduledAt",
                    "source",
                    "targetId",
                    "windowStart",
                    "windowEnd",
                    "outcome",
                    "reasonCode",
                    "observedAt",
                }
                if not isinstance(matching_source_error, Mapping):
                    raise _conflict(
                        "WORK_AUTOMATION_EVENT_SOURCE_ERROR_RECEIPT_REQUIRED",
                        "A matching durable source-error receipt is required.",
                    )
                if set(matching_source_error) != required_error_fields:
                    raise _invalid(
                        "WORK_AUTOMATION_EVENT_SOURCE_ERROR_RECEIPT_INVALID",
                        "source-error receipt contains missing or unsupported fields",
                    )
                target_id = _identifier(matching_source_error.get("targetId"), "source targetId")
                reason_code = matching_source_error.get("reasonCode")
                if (
                    matching_source_error.get("source") != trigger["source"]
                    or target_id not in target_ids
                    or matching_source_error.get("outcome") != "failed"
                    or reason_code
                    not in {
                        "not_configured",
                        "forbidden",
                        "unavailable",
                        "timeout",
                        "invalid",
                        "partial",
                    }
                    or (
                        matching_source_error.get("windowStart") is not None
                        and not isinstance(matching_source_error.get("windowStart"), str)
                    )
                    or not isinstance(matching_source_error.get("windowEnd"), str)
                    or not isinstance(matching_source_error.get("observedAt"), str)
                    or event.get("resourceUri")
                    != _source_poll_resource_uri(str(trigger["source"]), target_id)
                    or event.get("stateClass") != "incident"
                    or event.get("semanticFingerprint")
                    != _source_poll_failure_fingerprint(str(reason_code))
                ):
                    raise _conflict(
                        "WORK_AUTOMATION_EVENT_SOURCE_ERROR_RECEIPT_MISMATCH",
                        "The source-error receipt does not prove this fixed host-observed failure.",
                    )
                source_failure_reason = str(reason_code)
            else:
                matching_page = next(
                    (
                        item
                        for item in page_receipts
                        if item.get("type") == "workflow.source-page.v1"
                        and event_id in item.get("automationEventIds", [])
                    ),
                    None,
                )
                if not isinstance(matching_page, Mapping):
                    raise _conflict(
                        "WORK_AUTOMATION_EVENT_PAGE_RECEIPT_REQUIRED",
                        "A matching durable source page receipt is required.",
                    )
                required_page_fields = {
                    "type",
                    "workflowId",
                    "triggerId",
                    "occurrenceId",
                    "scheduledAt",
                    "source",
                    "targetId",
                    "pageCursor",
                    "nextCursor",
                    "windowStart",
                    "windowEnd",
                    "complete",
                    "truncated",
                    "automationEventIds",
                    "sourceEventIds",
                    "observedAt",
                }
                if set(matching_page) != required_page_fields:
                    raise _invalid(
                        "WORK_AUTOMATION_EVENT_PAGE_RECEIPT_INVALID",
                        "source page receipt contains missing or unsupported fields",
                    )
                target_id = _identifier(matching_page.get("targetId"), "source page targetId")
                if (
                    matching_page.get("workflowId") != workflow_id
                    or matching_page.get("triggerId") != trigger_id
                    or matching_page.get("occurrenceId") != occurrence_id
                    or matching_page.get("scheduledAt") != scheduled_at
                    or matching_page.get("source") != trigger["source"]
                    or target_id not in target_ids
                    or matching_page.get("complete") is not True
                    or matching_page.get("truncated") is not False
                    or matching_page.get("automationEventIds") != [event_id]
                    or matching_page.get("sourceEventIds") != [source_event_id]
                ):
                    raise _conflict(
                        "WORK_AUTOMATION_EVENT_PAGE_RECEIPT_MISMATCH",
                        "The source page receipt does not prove this complete event observation.",
                    )
                if is_source_recovery and (
                    event.get("resourceUri")
                    != _source_poll_resource_uri(str(trigger["source"]), target_id)
                    or event.get("stateClass") != "healthy"
                    or event.get("semanticFingerprint") != _source_poll_recovery_fingerprint()
                ):
                    raise _conflict(
                        "WORK_AUTOMATION_EVENT_SOURCE_RECOVERY_RECEIPT_MISMATCH",
                        "Recovery requires a healthy fixed source state after a complete page.",
                    )
                if event_type.startswith("source.poll.") and not is_source_recovery:
                    raise _conflict(
                        "WORK_AUTOMATION_EVENT_SOURCE_RECEIPT_MISMATCH",
                        "Source failure events require source-error evidence.",
                    )
            self._validate_private_owner_workflow(
                conn, org, workspace, actor, workflow, private_scope
            )

            resource_key = hashlib.sha256(str(event["resourceUri"]).encode("utf-8")).hexdigest()
            state_row = conn.execute(
                """SELECT * FROM work_automation_event_states WHERE organization_id=?
                   AND workspace_id=? AND actor_id=? AND source=? AND resource_key=?""",
                (org, workspace, actor, event["source"], resource_key),
            ).fetchone()
            occurred_at = int(event["occurredAt"])
            source_state = str(event["stateClass"])
            fingerprint = str(event["semanticFingerprint"])
            baseline = run_event.get("baseline") is True
            stale = False
            decision = "initial_baseline"
            if state_row is not None:
                prior_order = (int(state_row["occurred_at"]), str(state_row["source_event_id"]))
                current_order = (occurred_at, source_event_id)
                stale = current_order <= prior_order
            if stale:
                decision = "stale"
            elif is_source_failure:
                if (
                    state_row is not None
                    and str(state_row["state_class"]) == "incident"
                    and str(state_row["semantic_fingerprint"]) == fingerprint
                ):
                    decision = "unchanged"
                else:
                    decision = "failure"
            elif is_source_recovery:
                if state_row is None or str(state_row["state_class"]) != "incident":
                    raise _conflict(
                        "WORK_AUTOMATION_EVENT_RECOVERY_WITHOUT_INCIDENT",
                        "A source recovery requires a previously recorded source incident.",
                    )
                decision = "recovery"
            elif baseline or state_row is None:
                decision = "initial_baseline"
            elif (
                str(state_row["state_class"]) == source_state
                and str(state_row["semantic_fingerprint"]) == fingerprint
            ):
                decision = "unchanged"
            else:
                attention_kind = _attention_kind_for_event_type(str(event["eventType"]))
                if (
                    attention_kind is not None
                    and attention_kind in workflow["notifications"]["immediateOn"]
                ):
                    decision = "blocker"
                elif str(state_row["state_class"]) == "incident" and source_state == "healthy":
                    decision = "recovery"
                elif str(state_row["state_class"]) != "incident" and source_state == "incident":
                    decision = "failure"
                else:
                    decision = "change"

            if not stale:
                conn.execute(
                    """INSERT INTO work_automation_event_states(
                        organization_id,workspace_id,actor_id,source,resource_key,state_class,
                        semantic_fingerprint,occurred_at,source_event_id,event_id
                    ) VALUES(?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(organization_id,workspace_id,actor_id,source,resource_key)
                    DO UPDATE SET state_class=excluded.state_class,
                        semantic_fingerprint=excluded.semantic_fingerprint,
                        occurred_at=excluded.occurred_at,source_event_id=excluded.source_event_id,
                        event_id=excluded.event_id""",
                    (
                        org,
                        workspace,
                        actor,
                        event["source"],
                        resource_key,
                        source_state,
                        fingerprint,
                        occurred_at,
                        source_event_id,
                        event_id,
                    ),
                )

            notification_id: str | None = None
            notifications = workflow["notifications"]
            should_notify = (
                (decision == "failure" and notifications["onFailure"])
                or (decision == "recovery" and notifications["onRecovery"])
                or decision == "blocker"
            )
            if should_notify:
                owner_task_id = str(workflow["authorization"]["ownerTaskId"])
                route = _resolve_private_teams_route(
                    conn, org, workspace, owner_task_id, actor, private_scope
                )
                raw_summary = event.get("summary") or event.get("title") or event["eventType"]
                private_text = _bounded_text(raw_summary, "event summary", 2_000)
                attention_kind = _attention_kind_for_event_type(event_type)
                if is_source_failure and source_failure_reason in {
                    "not_configured",
                    "forbidden",
                    "unavailable",
                    "timeout",
                }:
                    attention_kind = "service_or_auth_outage"
                immediate = decision == "blocker" or (
                    attention_kind is not None and attention_kind in notifications["immediateOn"]
                )
                quiet_release = _quiet_hours_release_ms(now, notifications["quietHours"])
                available_at = now if immediate or quiet_release is None else quiet_release
                notification, _notification_duplicate = self._enqueue_notification(
                    conn,
                    org,
                    workspace,
                    f"workflow:{workflow_id}:source:{event_id}:{decision}",
                    "teams.message",
                    {"text": private_text},
                    "teams-v1",
                    "teams:owner-private",
                    task_id,
                    available_at,
                    now,
                    owner_actor_id=actor,
                    private_owner={
                        "taskId": owner_task_id,
                        "tenantId": route["tenantId"],
                        "actorAadObjectId": route["actorAadObjectId"],
                        "botAppId": route["botAppId"],
                    },
                )
                notification_id = str(notification["id"])
            receipt: JsonObject = {
                "eventId": event_id,
                "workflowId": workflow_id,
                "triggerId": trigger_id,
                "occurrenceId": occurrence_id,
                "decision": decision,
                "notificationId": notification_id,
            }
            conn.execute(
                """INSERT INTO work_automation_event_intents(
                    organization_id,workspace_id,actor_id,event_id,workflow_id,trigger_id,
                    occurrence_id,decision,request_digest,notification_id,receipt_json,created_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    org,
                    workspace,
                    actor,
                    event_id,
                    workflow_id,
                    trigger_id,
                    occurrence_id,
                    decision,
                    request_digest,
                    notification_id,
                    _json_text(receipt),
                    now,
                ),
            )
            return receipt, False

    def put_experiment(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        experiment_id: str,
        body: Mapping[str, Any],
    ) -> tuple[JsonObject, bool, bool]:
        """Replace one actor-owned reference index with expected-revision fencing.

        Args:
            organization_id: Authenticated organization scope.
            workspace_id: Authenticated Workspace scope.
            actor_id: Actor from the configured persistence principal.
            experiment_id: UUID correlation key from the route.
            body: Reference-only index fields and expected revision.
        Returns:
            The stored index, creation status, and exact/no-op replay status.

        中文：只写入 Product 引用，不复制生命周期状态，并拒绝过期更新。
        """

        org, workspace = _scope(organization_id, workspace_id)
        actor = _identifier(actor_id, "actorId")
        experiment = _canonical_uuid(experiment_id, "experimentId")
        data, expected_revision = _validate_experiment_put(body)
        request_digest = _digest({"data": data, "expectedRevision": expected_revision})
        now = _unix_ms()
        with self._mutation() as conn:
            row = conn.execute(
                """SELECT * FROM work_experiment_indexes
                   WHERE organization_id=? AND workspace_id=? AND actor_id=? AND experiment_id=?""",
                (org, workspace, actor, experiment),
            ).fetchone()
            if row is None:
                if expected_revision != 0:
                    raise _conflict(
                        "WORK_EXPERIMENT_STALE_REVISION",
                        "A new experiment index must use expectedRevision 0.",
                    )
                revision = 1
                conn.execute(
                    """INSERT INTO work_experiment_indexes(
                        organization_id,workspace_id,actor_id,experiment_id,revision,updated_at,
                        references_json,last_request_digest,visibility
                    ) VALUES(?,?,?,?,?,?,?,?, 'owner')""",
                    (
                        org,
                        workspace,
                        actor,
                        experiment,
                        revision,
                        now,
                        _json_text(data),
                        request_digest,
                    ),
                )
                return (
                    _experiment_view(experiment, actor, org, workspace, revision, now, data),
                    True,
                    False,
                )

            current_revision = int(row["revision"])
            if str(row["last_request_digest"]) == request_digest:
                current_data = _stored_object(row["references_json"], "experiment references")
                return (
                    _experiment_view(
                        experiment,
                        actor,
                        org,
                        workspace,
                        current_revision,
                        int(row["updated_at"]),
                        current_data,
                    ),
                    False,
                    True,
                )
            if expected_revision != current_revision:
                raise _conflict(
                    "WORK_EXPERIMENT_STALE_REVISION",
                    "expectedRevision does not match the current experiment revision.",
                )
            current_data = _stored_object(row["references_json"], "experiment references")
            if current_data == data:
                return (
                    _experiment_view(
                        experiment,
                        actor,
                        org,
                        workspace,
                        current_revision,
                        int(row["updated_at"]),
                        current_data,
                    ),
                    False,
                    True,
                )
            revision = current_revision + 1
            if revision > 2**53 - 1:
                raise _conflict(
                    "WORK_EXPERIMENT_REVISION_EXHAUSTED",
                    "The experiment revision cannot be incremented safely.",
                )
            conn.execute(
                """UPDATE work_experiment_indexes SET revision=?,updated_at=?,references_json=?,
                   last_request_digest=? WHERE organization_id=? AND workspace_id=?
                     AND actor_id=? AND experiment_id=?""",
                (
                    revision,
                    now,
                    _json_text(data),
                    request_digest,
                    org,
                    workspace,
                    actor,
                    experiment,
                ),
            )
            return (
                _experiment_view(experiment, actor, org, workspace, revision, now, data),
                False,
                False,
            )

    def get_experiment(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        experiment_id: str,
    ) -> JsonObject:
        """Read an experiment index only for its authenticated actor. | 读取本人实验索引。"""

        org, workspace = _scope(organization_id, workspace_id)
        actor = _identifier(actor_id, "actorId")
        experiment = _canonical_uuid(experiment_id, "experimentId")
        with self._read() as conn:
            row = conn.execute(
                """SELECT * FROM work_experiment_indexes
                   WHERE organization_id=? AND workspace_id=? AND actor_id=? AND experiment_id=?""",
                (org, workspace, actor, experiment),
            ).fetchone()
            if row is None:
                raise _not_found(
                    "WORK_EXPERIMENT_NOT_FOUND",
                    "The experiment index does not exist for this actor in this Workspace.",
                )
            data = _stored_object(row["references_json"], "experiment references")
            return _experiment_view(
                experiment,
                actor,
                org,
                workspace,
                int(row["revision"]),
                int(row["updated_at"]),
                data,
            )

    def put_workflow(
        self,
        organization_id: str | None,
        workspace_id: str,
        workflow: Mapping[str, Any],
        *,
        actor_id: str | None = None,
        private_scope: PrivateConversationScope | None = None,
    ) -> JsonObject:
        """Persist versioned workflow instructions without taking timer authority. |
        保存工作流定义。"""

        org, workspace = _scope(organization_id, workspace_id)
        value = _validate_workflow(workflow)
        workflow_id = value["id"]
        actor = _identifier(actor_id, "actorId").lower() if actor_id is not None else None
        if value["version"] == 3 and actor is None:
            raise _invalid(
                "WORK_WORKFLOW_OWNER_REQUIRED",
                "Workflow v3 requires a server-derived actor identity.",
            )
        now = _unix_ms()
        value["updatedAt"] = _iso_utc(now)
        with self._mutation() as conn:
            prior = conn.execute(
                """SELECT version,owner_actor_id FROM work_workflows
                   WHERE organization_id=? AND workspace_id=? AND workflow_id=?""",
                (org, workspace, workflow_id),
            ).fetchone()
            if prior is not None and int(prior["version"]) == 3:
                if actor is None or str(prior["owner_actor_id"] or "") != actor:
                    raise _not_found(
                        "WORK_WORKFLOW_NOT_FOUND",
                        "The workflow does not exist for this actor in this Workspace.",
                    )
                if value["version"] != 3:
                    raise _conflict(
                        "WORK_WORKFLOW_VERSION_CONFLICT",
                        "A private v3 workflow cannot be rewritten as a shared v1 or v2 record.",
                    )
            elif prior is not None and value["version"] == 3:
                raise _conflict(
                    "WORK_WORKFLOW_VERSION_CONFLICT",
                    "A v1 or v2 workflow id cannot be reused for a private v3 record.",
                )
            if value["version"] == 3:
                authorization = value["authorization"]
                owner_task_id = str(authorization["ownerTaskId"])
                if authorization["kind"] == "owner_private":
                    _resolve_private_teams_route(
                        conn,
                        org,
                        workspace,
                        owner_task_id,
                        actor or "",
                        private_scope,
                    )
                else:
                    owner_task = conn.execute(
                        """SELECT created_by_actor_id,metadata_json FROM work_tasks
                           WHERE organization_id=? AND workspace_id=? AND task_id=?""",
                        (org, workspace, owner_task_id),
                    ).fetchone()
                    if owner_task is None or str(owner_task["created_by_actor_id"] or "") != actor:
                        raise _not_found(
                            "WORK_TASK_NOT_FOUND",
                            "The owner task does not exist for this actor in this Workspace.",
                        )
                    origin = conn.execute(
                        """SELECT actor_id,actor_subject,thread_id FROM work_task_teams_origins
                           WHERE organization_id=? AND workspace_id=? AND task_id=?""",
                        (org, workspace, owner_task_id),
                    ).fetchone()
                    if (
                        origin is None
                        or str(origin["actor_id"]).lower() != str(actor).lower()
                        or str(origin["actor_subject"]).lower() != str(actor).lower()
                        or str(origin["thread_id"]) != str(authorization["threadBindingId"])
                    ):
                        raise _conflict(
                            "WORK_WORKFLOW_V3_AUTHORIZATION_INVALID",
                            "The Teams authorization reference does not match verified "
                            "owner-task provenance.",
                        )
            conn.execute(
                """INSERT INTO work_workflows(organization_id,workspace_id,workflow_id,version,
                   workflow_json,updated_at,owner_actor_id) VALUES(?,?,?,?,?,?,?)
                   ON CONFLICT(organization_id,workspace_id,workflow_id) DO UPDATE SET
                     version=excluded.version,workflow_json=excluded.workflow_json,
                     updated_at=excluded.updated_at,owner_actor_id=excluded.owner_actor_id""",
                (
                    org,
                    workspace,
                    workflow_id,
                    value["version"],
                    _json_text(value),
                    now,
                    actor if value["version"] == 3 else "",
                ),
            )
            return value

    def list_workflows(
        self,
        organization_id: str | None,
        workspace_id: str,
        definition_version: int = 1,
        *,
        actor_id: str | None = None,
    ) -> list[JsonObject]:
        """List only the explicitly negotiated workflow schema version. | 按协商版本列工作流。"""

        org, workspace = _scope(organization_id, workspace_id)
        if definition_version not in {1, 2, 3}:
            raise _invalid(
                "WORK_WORKFLOW_VERSION_UNSUPPORTED", "definitionVersion must be 1, 2, or 3"
            )
        if definition_version == 3:
            if actor_id is None:
                raise PersistenceError(
                    "WORK_WORKFLOW_OWNER_REQUIRED",
                    403,
                    "Workflow v3 requires an authenticated owner actor.",
                )
            actor = _identifier(actor_id, "actorId")
        else:
            actor = None
        with self._read() as conn:
            if definition_version == 3:
                rows = conn.execute(
                    """SELECT workflow_json FROM work_workflows WHERE organization_id=? AND
                       workspace_id=? AND version=3 AND owner_actor_id=? ORDER BY workflow_id""",
                    (org, workspace, actor),
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT workflow_json FROM work_workflows WHERE organization_id=? AND
                       workspace_id=? AND version=? ORDER BY workflow_id""",
                    (org, workspace, definition_version),
                ).fetchall()
            return [_stored_object(row["workflow_json"], "workflow") for row in rows]

    def _enqueue_v3_digest_notice(
        self,
        org: str,
        workspace: str,
        workflow_id: str,
        body: Mapping[str, Any],
        *,
        actor_id: str | None,
        private_scope: PrivateConversationScope | None,
    ) -> tuple[JsonObject, bool]:
        """Derive one owner-private weekday digest from immutable V3 schedule receipts."""

        required = {"occurrenceId", "triggerId", "scheduledAt", "taskId"}
        if set(body) != required or body.get("triggerId") != "daily-digest":
            raise _invalid(
                "WORK_WORKFLOW_NOTICE_INVALID",
                "V3 digest notice accepts only occurrence, schedule, and task identity.",
            )
        actor = _identifier(actor_id, "actorId") if actor_id is not None else None
        if actor is None:
            raise _invalid("WORK_WORKFLOW_OWNER_REQUIRED", "V3 digest requires an actor principal.")
        occurrence_id = _bounded_text(body.get("occurrenceId"), "occurrenceId", 44)
        if not re.fullmatch(r"occ-[0-9a-f]{40}", occurrence_id):
            raise _invalid("WORK_WORKFLOW_NOTICE_INVALID", "occurrenceId is invalid")
        trigger_id = "daily-digest"
        scheduled_at = _bounded_text(body.get("scheduledAt"), "scheduledAt", 128)
        task_id = _identifier(body.get("taskId"), "taskId")
        if task_id != "workflow-" + occurrence_id[4:]:
            raise _invalid(
                "WORK_WORKFLOW_NOTICE_INVALID", "V3 digest taskId must match its occurrenceId"
            )
        current_time_ms = _timestamp_ms(scheduled_at)
        if current_time_ms is None or not _is_weekday_digest_time(scheduled_at):
            raise _invalid(
                "WORK_WORKFLOW_NOTICE_INVALID",
                "V3 digest occurrences must be weekday 09:00 America/New_York times.",
            )
        now = _unix_ms()
        with self._mutation() as conn:
            workflow_row = conn.execute(
                """SELECT version,owner_actor_id,workflow_json FROM work_workflows
                   WHERE organization_id=? AND workspace_id=? AND workflow_id=?""",
                (org, workspace, workflow_id),
            ).fetchone()
            if (
                workflow_row is None
                or int(workflow_row["version"]) != 3
                or str(workflow_row["owner_actor_id"] or "").lower() != actor.lower()
            ):
                raise _not_found(
                    "WORK_WORKFLOW_NOT_FOUND", "The V3 workflow does not exist for this actor."
                )
            workflow = _validate_workflow_v3(
                _stored_object(workflow_row["workflow_json"], "workflow")
            )
            if (
                not workflow["enabled"]
                or workflow["authorization"]["kind"] != "owner_private"
                or workflow["notifications"]["destination"]["kind"] != "owner_private"
                or workflow["notifications"]["digest"]["enabled"] is not True
            ):
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_DIGEST_DISABLED",
                    "An enabled owner-private V3 digest is required.",
                )
            task = conn.execute(
                """SELECT * FROM work_tasks WHERE organization_id=? AND workspace_id=?
                   AND task_id=?""",
                (org, workspace, task_id),
            ).fetchone()
            if (
                task is None
                or str(task["created_by_actor_id"] or "").lower() != actor.lower()
                or str(task["status"]) != "completed"
            ):
                raise _not_found(
                    "WORK_TASK_NOT_FOUND",
                    "The completed V3 digest task does not exist for this actor.",
                )
            expected_occurrence = _v3_occurrence_id(
                workflow_id, trigger_id, scheduled_at, str(task["created_by_actor_id"])
            )
            if occurrence_id != expected_occurrence:
                raise _invalid(
                    "WORK_WORKFLOW_NOTICE_INVALID",
                    "occurrenceId does not match the server-owned digest task actor.",
                )
            task_metadata = _stored_object(task["metadata_json"], "digest task metadata")
            if (
                task_metadata.get("source") != "workflow"
                or task_metadata.get("workflowId") != workflow_id
                or task_metadata.get("triggerId") != trigger_id
                or task_metadata.get("occurrenceId") != occurrence_id
                or task_metadata.get("authorizationRef") != workflow["authorization"]
            ):
                raise _conflict(
                    "WORK_SCHEDULE_TASK_MISMATCH",
                    "Digest task provenance does not match this workflow occurrence.",
                )
            terminal_row = conn.execute(
                """SELECT event_json FROM work_schedule_events WHERE organization_id=?
                   AND workspace_id=? AND workflow_id=? AND trigger_id=? AND occurrence_id=?
                     AND scheduled_at=? AND task_id=? AND status='succeeded'
                   ORDER BY created_at DESC LIMIT 1""",
                (org, workspace, workflow_id, trigger_id, occurrence_id, scheduled_at, task_id),
            ).fetchone()
            if terminal_row is None:
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_NOT_TERMINAL",
                    "A succeeded daily-digest ScheduleEvent is required.",
                )
            terminal = _stored_object(terminal_row["event_json"], "digest schedule event")
            _validate_v3_schedule_event(terminal, workflow, conn, org, workspace, actor)
            if terminal.get("status") != "succeeded" or terminal.get("changed") is not True:
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_KIND_MISMATCH",
                    "A daily digest requires material changes in its terminal receipt.",
                )

            digest_rows = conn.execute(
                """SELECT scheduled_at FROM work_schedule_events WHERE organization_id=?
                   AND workspace_id=? AND workflow_id=? AND trigger_id='daily-digest'
                     AND status='succeeded' ORDER BY created_at DESC LIMIT 5000""",
                (org, workspace, workflow_id),
            ).fetchall()
            previous_digest_ms = max(
                (
                    value
                    for row in digest_rows
                    if (value := _timestamp_ms(str(row["scheduled_at"]))) is not None
                    and value < current_time_ms
                ),
                default=None,
            )
            source_rows = conn.execute(
                """SELECT event_json FROM work_schedule_events WHERE organization_id=?
                   AND workspace_id=? AND workflow_id=? AND status='succeeded'
                   ORDER BY created_at DESC LIMIT 5000""",
                (org, workspace, workflow_id),
            ).fetchall()
            configured_triggers = {
                str(item["id"]): item
                for item in workflow["triggers"]
                if item.get("kind") == "source_poll"
            }
            changes: list[tuple[int, str]] = []
            for row in source_rows:
                receipt = _stored_object(row["event_json"], "source schedule receipt")
                receipt_time = _timestamp_ms(str(receipt.get("scheduledAt", "")))
                checkpoint = receipt.get("checkpoint")
                if (
                    receipt.get("triggerId") not in configured_triggers
                    or receipt.get("status") != "succeeded"
                    or receipt.get("changed") is not True
                    or receipt.get("baseline") is True
                    or not isinstance(checkpoint, Mapping)
                    or checkpoint.get("kind") != "source_poll"
                    or checkpoint.get("complete") is not True
                    or receipt_time is None
                    or receipt_time >= current_time_ms
                    or (previous_digest_ms is not None and receipt_time <= previous_digest_ms)
                ):
                    continue
                summary_value = receipt.get("summary")
                if isinstance(summary_value, str) and summary_value.strip():
                    source_trigger = configured_triggers[str(receipt["triggerId"])]
                    changes.append(
                        (
                            receipt_time,
                            f"{source_trigger['source']}: {summary_value.strip()}",
                        )
                    )
            changes.sort(key=lambda item: item[0])
            if not changes:
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_NO_CHANGES",
                    "No changed complete source receipts exist since the previous digest.",
                )
            lines = [f"{workflow['title']} — Daily digest ({len(changes)} changes)"]
            for _, summary_line in changes:
                line = "• " + summary_line
                remaining = 19_500 - sum(len(existing) + 1 for existing in lines)
                if remaining <= 0:
                    break
                lines.append(line[:remaining])
            rendered = "\n".join(lines)[:19_999]
            route = _resolve_private_teams_route(
                conn,
                org,
                workspace,
                str(workflow["authorization"]["ownerTaskId"]),
                actor,
                private_scope,
            )
            notification, duplicate = self._enqueue_notification(
                conn,
                org,
                workspace,
                f"workflow:{workflow_id}:{occurrence_id}:digest",
                "teams.message",
                {"text": rendered},
                "teams-v1",
                "teams:owner-private",
                task_id,
                now,
                now,
                owner_actor_id=actor,
                private_owner={
                    "taskId": str(workflow["authorization"]["ownerTaskId"]),
                    "tenantId": route["tenantId"],
                    "actorAadObjectId": route["actorAadObjectId"],
                    "botAppId": route["botAppId"],
                },
            )
            return {"notification": notification, "duplicate": duplicate}, duplicate

    def enqueue_workflow_notice(
        self,
        organization_id: str | None,
        workspace_id: str,
        workflow_id: str,
        body: Mapping[str, Any],
        *,
        actor_id: str | None = None,
        private_scope: PrivateConversationScope | None = None,
    ) -> tuple[JsonObject, bool]:
        """Project one verified v2 terminal receipt into its stored owner Teams thread.

        Args:
            organization_id: Authenticated organization scope.
            workspace_id: Authenticated Workspace scope.
            workflow_id: Canonical v2 responsibility whose owner thread is used.
            body: Notice identity and exact summary from a durable terminal event.
        Returns:
            A `teams.message` outbox receipt; route and source task come from Work state.
        Raises:
            PersistenceError: If the workflow, terminal event, owner task, or stored route disagree.

        中文：只允许服务端从 v2 工作流、完成回执和已验证 Teams owner 任务生成回复队列。
        """

        org, workspace = _scope(organization_id, workspace_id)
        workflow_id = _identifier(workflow_id, "workflowId")
        if "taskId" in body:
            return self._enqueue_v3_digest_notice(
                org,
                workspace,
                workflow_id,
                body,
                actor_id=actor_id,
                private_scope=private_scope,
            )
        if set(body) not in (
            {"occurrenceId", "triggerId", "scheduledAt", "kind", "summary"},
            {"occurrenceId", "triggerId", "scheduledAt", "kind", "summary", "attentionKind"},
        ):
            raise _invalid(
                "WORK_WORKFLOW_NOTICE_INVALID",
                "v2 notice request contains unsupported or missing fields",
            )
        occurrence_id = _identifier(body.get("occurrenceId"), "occurrenceId")
        trigger_id = _identifier(body.get("triggerId"), "triggerId")
        scheduled_at = _bounded_text(body.get("scheduledAt"), "scheduledAt", 128)
        kind = body.get("kind")
        summary = _bounded_text(body.get("summary"), "summary", 400)
        attention_kind = body.get("attentionKind")
        if kind not in {"change", "failure", "recovery", "digest", "blocker"}:
            raise _invalid("WORK_WORKFLOW_NOTICE_INVALID", "kind is not supported")
        if attention_kind is not None and attention_kind not in {
            "blocked_goal",
            "user_decision",
            "service_or_auth_outage",
        }:
            raise _invalid("WORK_WORKFLOW_NOTICE_INVALID", "attentionKind is not supported")
        expected_occurrence = (
            "occ-"
            + hashlib.sha256(f"{workflow_id}\0{trigger_id}\0{scheduled_at}".encode()).hexdigest()[
                :40
            ]
        )
        if occurrence_id != expected_occurrence:
            raise _invalid(
                "WORK_WORKFLOW_NOTICE_INVALID", "occurrenceId does not match its schedule identity"
            )

        with self._mutation() as conn:
            workflow_row = conn.execute(
                """SELECT workflow_json FROM work_workflows
                   WHERE organization_id=? AND workspace_id=? AND workflow_id=? AND version=2""",
                (org, workspace, workflow_id),
            ).fetchone()
            if workflow_row is None:
                raise _not_found(
                    "WORK_WORKFLOW_NOT_FOUND",
                    "The v2 responsibility does not exist in this Workspace.",
                )
            workflow = _stored_object(workflow_row["workflow_json"], "workflow")
            workflow = _validate_workflow_v2(workflow)
            authorization = workflow["authorization"]
            owner_task_id = str(authorization["ownerTaskId"])
            thread_binding_id = str(authorization["threadBindingId"])
            event_key = f"{workflow_id}\0{trigger_id}\0{scheduled_at}"
            matching_events: list[JsonObject] = []
            for status in ("succeeded", "failed"):
                event_id = (
                    "workflow-" + hashlib.sha256(f"{event_key}\0{status}".encode()).hexdigest()[:48]
                )
                event_row = conn.execute(
                    """SELECT event_json FROM work_schedule_events
                       WHERE organization_id=? AND workspace_id=?
                       AND event_id=? AND workflow_id=?""",
                    (org, workspace, event_id, workflow_id),
                ).fetchone()
                if event_row is not None:
                    matching_events.append(
                        _stored_object(event_row["event_json"], "workflow schedule event")
                    )
            terminal = next(
                (item for item in matching_events if item.get("triggerId") == trigger_id), None
            )
            if terminal is None:
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_NOT_TERMINAL",
                    "A matching terminal schedule receipt is required.",
                )
            if terminal.get("summary") != summary:
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_SUMMARY_MISMATCH",
                    "Notice summary must match the stored terminal receipt.",
                )
            if kind == "blocker" and terminal.get("attentionKind") != attention_kind:
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_ATTENTION_MISMATCH",
                    "Notice attention kind must match its stored receipt.",
                )
            terminal_checkpoint = terminal.get("checkpoint")
            incomplete = (
                isinstance(terminal_checkpoint, Mapping)
                and terminal_checkpoint.get("complete") is False
            )
            if kind == "change" and (
                terminal.get("status") != "succeeded"
                or terminal.get("changed") is not True
                or terminal.get("baseline") is True
                or incomplete
            ):
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_KIND_MISMATCH",
                    "Change notices require a complete changed observation.",
                )
            if kind == "failure" and terminal.get("status") != "failed":
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_KIND_MISMATCH",
                    "Failure notices require a failed terminal receipt.",
                )
            if kind == "digest" and trigger_id != "daily-digest":
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_KIND_MISMATCH",
                    "Daily digests require the dedicated DSH trigger.",
                )
            if kind == "digest" and (
                terminal.get("status") != "succeeded" or terminal.get("changed") is not True
            ):
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_KIND_MISMATCH",
                    "Daily digest notices require material changes.",
                )

            owner_task = self._require_task(conn, org, workspace, owner_task_id)
            metadata = _stored_object(owner_task["metadata_json"], "owner task metadata")
            caller = metadata.get("teamsCaller")
            thread = metadata.get("teamsThread")
            if not isinstance(caller, Mapping) or not isinstance(thread, Mapping):
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_OWNER_INVALID",
                    "The owner task is not an accepted Teams task.",
                )
            for field in ("issuer", "subject", "tenantId"):
                _identifier(caller.get(field), f"ownerTask.teamsCaller.{field}")
            if str(thread.get("threadId") or "") != thread_binding_id:
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_THREAD_MISMATCH",
                    "The owner task thread does not match the v2 authorization reference.",
                )
            thread_rows = conn.execute(
                """SELECT * FROM work_connector_threads WHERE organization_id=? AND workspace_id=?
                   AND thread_id=?""",
                (org, workspace, thread_binding_id),
            ).fetchall()
            if not thread_rows:
                raise _not_found(
                    "WORK_CONNECTOR_THREAD_NOT_FOUND",
                    "The authorized Teams thread mapping does not exist.",
                )
            if len(thread_rows) != 1:
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_THREAD_AMBIGUOUS",
                    "The Teams thread binding resolves to more than one connector.",
                )
            thread_row = thread_rows[0]
            connector_id = str(thread_row["connector_id"])
            route = {
                "tenantId": str(thread_row["tenant_id"]),
                "teamId": str(thread_row["team_id"]),
                "channelId": str(thread_row["channel_id"]),
                "conversationId": str(thread_row["conversation_id"]),
                "rootThreadId": str(thread_row["root_thread_id"]),
                **(
                    {"serviceUrl": str(thread_row["service_url"])}
                    if str(thread_row["service_url"] or "")
                    else {}
                ),
            }
            if str(caller.get("tenantId") or "").lower() != str(route["tenantId"] or "").lower():
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_TENANT_MISMATCH",
                    "The owner task tenant does not match the stored thread.",
                )
            for field in ("tenantId", "teamId", "channelId", "conversationId", "rootThreadId"):
                if str(thread.get(field) or "") != str(route.get(field) or ""):
                    raise _conflict(
                        "WORK_WORKFLOW_NOTICE_ROUTE_MISMATCH",
                        "The owner task route does not match the stored Teams thread.",
                    )
            if thread.get("serviceUrl") is not None and str(thread.get("serviceUrl") or "") != str(
                route.get("serviceUrl") or ""
            ):
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_ROUTE_MISMATCH",
                    "The owner task service URL does not match the stored Teams thread.",
                )
            if str(owner_task["session_id"]) != str(thread_row["session_id"]):
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_SESSION_MISMATCH",
                    "The owner task is not bound to the stored Teams session.",
                )
            descriptor = _task_notification_descriptor(metadata)
            if descriptor is not None and (
                descriptor["type"] != "teams.message"
                or descriptor["connectorId"] != connector_id
                or descriptor["payload"] != route
            ):
                raise _conflict(
                    "WORK_WORKFLOW_NOTICE_ROUTE_MISMATCH",
                    "The owner task reply descriptor differs from the stored Teams thread.",
                )

            prefix = f"{workflow['title']} — "
            rendered = _bounded_text(prefix + summary, "workflow notice text", 20_000)
            payload = {**route, "text": rendered}
            deduplication_key = f"workflow:{workflow_id}:{occurrence_id}:{kind}"
            notification, duplicate = self._enqueue_notification(
                conn,
                org,
                workspace,
                deduplication_key,
                "teams.message",
                payload,
                connector_id,
                f"teams:{thread_binding_id}",
                owner_task_id,
                _unix_ms(),
                _unix_ms(),
            )
            return {"notification": notification, "duplicate": duplicate}, duplicate

    def append_schedule_event(
        self,
        organization_id: str | None,
        workspace_id: str,
        event: Mapping[str, Any],
        *,
        actor_id: str | None = None,
    ) -> JsonObject:
        """Append an execution event emitted by DSH's durable scheduler. | 追加调度执行事件。"""

        org, workspace = _scope(organization_id, workspace_id)
        value = _validate_schedule_event(event)
        actor = _identifier(actor_id, "actorId") if actor_id is not None else None
        digest = _digest(value)
        now = _unix_ms()
        with self._mutation() as conn:
            workflow = conn.execute(
                """SELECT version,owner_actor_id,workflow_json FROM work_workflows
                   WHERE organization_id=? AND workspace_id=? AND
                    workflow_id=?""",
                (org, workspace, value["workflowId"]),
            ).fetchone()
            if workflow is None:
                raise _not_found(
                    "WORK_WORKFLOW_NOT_FOUND",
                    "The workflow does not exist in this Workspace.",
                )
            if int(workflow["version"]) == 3:
                if actor is None or str(workflow["owner_actor_id"] or "") != actor:
                    raise _not_found(
                        "WORK_WORKFLOW_NOT_FOUND",
                        "The workflow does not exist for this actor in this Workspace.",
                    )
                _validate_v3_schedule_event(
                    value,
                    _validate_workflow_v3(_stored_object(workflow["workflow_json"], "workflow")),
                    conn,
                    org,
                    workspace,
                    actor or "",
                )
            elif (
                isinstance(value.get("checkpoint"), Mapping)
                and value["checkpoint"].get("kind") == "source_poll"
            ):
                raise _invalid(
                    "WORK_SCHEDULE_INVALID_EVENT",
                    "source_poll checkpoints require a v3 workflow.",
                )
            prior = conn.execute(
                """SELECT * FROM work_schedule_events WHERE organization_id=? AND workspace_id=?
                    AND event_id=?""",
                (org, workspace, value["id"]),
            ).fetchone()
            if prior is not None:
                if str(prior["event_digest"]) != digest:
                    raise _conflict(
                        "WORK_SCHEDULE_EVENT_ID_CONFLICT",
                        "The event id names different content.",
                    )
                return _stored_object(prior["event_json"], "schedule event")
            occurrence_id = (
                _v3_occurrence_id(
                    str(value["workflowId"]),
                    str(value.get("triggerId", "")),
                    str(value["scheduledAt"]),
                    actor or "",
                )
                if int(workflow["version"]) == 3 and value.get("triggerId") is not None
                else None
            )
            conn.execute(
                """INSERT INTO work_schedule_events(organization_id,workspace_id,event_id,
                   workflow_id,created_at,event_json,event_digest,trigger_id,scheduled_at,status,
                   task_id,occurrence_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    org,
                    workspace,
                    value["id"],
                    value["workflowId"],
                    now,
                    _json_text(value),
                    digest,
                    value.get("triggerId"),
                    value["scheduledAt"],
                    value["status"],
                    value.get("taskId"),
                    occurrence_id,
                ),
            )
            return value

    def list_schedule_events(
        self,
        organization_id: str | None,
        workspace_id: str,
        workflow_id: str | None = None,
        limit: int = 100,
        cursor: str | None = None,
        *,
        actor_id: str | None = None,
    ) -> JsonObject:
        """List execution history with a stable time/id cursor. | 分页读取执行历史。"""

        org, workspace = _scope(organization_id, workspace_id)
        if type(limit) is not int or not 1 <= limit <= 500:
            raise _invalid("WORK_SCHEDULE_INVALID_PAGE", "limit must be between 1 and 500")
        workflow_id = _identifier(workflow_id, "workflowId") if workflow_id is not None else None
        actor = _identifier(actor_id, "actorId") if actor_id is not None else ""
        decoded = _decode_cursor(cursor) if cursor else None
        filters = "organization_id=? AND workspace_id=?"
        params: list[Any] = [org, workspace]
        filters += " AND EXISTS (SELECT 1 FROM work_workflows wf WHERE "
        filters += "wf.organization_id=work_schedule_events.organization_id "
        filters += "AND wf.workspace_id=work_schedule_events.workspace_id "
        filters += "AND wf.workflow_id=work_schedule_events.workflow_id "
        filters += "AND (wf.version<>3 OR wf.owner_actor_id=?))"
        params.append(actor)
        if workflow_id is not None:
            filters += " AND workflow_id=?"
            params.append(workflow_id)
        if decoded:
            created_at, event_id = decoded
            filters += " AND (created_at<? OR (created_at=? AND event_id>?))"
            params.extend([created_at, created_at, event_id])
        params.append(limit + 1)
        with self._read() as conn:
            rows = conn.execute(
                f"SELECT * FROM work_schedule_events WHERE {filters} "
                "ORDER BY created_at DESC,event_id ASC LIMIT ?",
                params,
            ).fetchall()
            has_more = len(rows) > limit
            items = [_stored_object(row["event_json"], "schedule event") for row in rows[:limit]]
            next_cursor = None
            if has_more:
                last = rows[limit - 1]
                next_cursor = _encode_cursor(int(last["created_at"]), str(last["event_id"]))
            return {"items": items, "nextCursor": next_cursor}

    def get_schedule_event(
        self,
        organization_id: str | None,
        workspace_id: str,
        event_id: str,
        *,
        actor_id: str | None = None,
    ) -> JsonObject:
        """Read one immutable schedule receipt by its stable event id. | 按稳定事件标识读取回执。"""

        org, workspace = _scope(organization_id, workspace_id)
        event_id = _identifier(event_id, "schedule event id")
        actor = _identifier(actor_id, "actorId") if actor_id is not None else ""
        with self._read() as conn:
            row = conn.execute(
                """SELECT event.event_json,workflow.version,workflow.owner_actor_id
                   FROM work_schedule_events AS event JOIN work_workflows AS workflow
                     ON workflow.organization_id=event.organization_id
                    AND workflow.workspace_id=event.workspace_id
                    AND workflow.workflow_id=event.workflow_id
                   WHERE event.organization_id=? AND event.workspace_id=? AND event.event_id=?""",
                (org, workspace, event_id),
            ).fetchone()
            if row is None or (
                int(row["version"]) == 3 and str(row["owner_actor_id"] or "") != actor
            ):
                raise _not_found(
                    "WORK_SCHEDULE_EVENT_NOT_FOUND",
                    "The schedule event does not exist in this Workspace.",
                )
            return _stored_object(row["event_json"], "schedule event")

    def _notification_transition(
        self,
        organization_id: str | None,
        workspace_id: str,
        notification_id: str,
        lease_token: str,
        target_status: str,
        result: Mapping[str, Any],
        *,
        retry_after_seconds: int | None = None,
        private_scope: PrivateConversationScope | None = None,
        allow_private: bool = False,
        private_only: bool = False,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> JsonObject:
        """Apply a token-fenced delivery transition. | 按租约令牌更新投递状态。"""

        org, workspace = _scope(organization_id, workspace_id)
        notification_id = _identifier(notification_id, "notification id")
        if not isinstance(lease_token, str) or not lease_token:
            raise _invalid("WORK_NOTIFICATION_INVALID_LEASE", "leaseToken is required")
        normalized_result = _json_object(result, "result")
        now = _unix_ms()
        with self._mutation() as conn:
            row = conn.execute(
                """SELECT * FROM work_notifications WHERE organization_id=? AND workspace_id=?
                   AND notification_id=?""",
                (org, workspace, notification_id),
            ).fetchone()
            if row is None:
                raise _not_found(
                    "WORK_NOTIFICATION_NOT_FOUND",
                    "The notification does not exist in this Workspace.",
                )
            is_private = row["owner_actor_id"] is not None
            if not is_private and row["notification_type"] == "teams.message" and row["task_id"]:
                private_task = conn.execute(
                    """SELECT 1 FROM work_task_private_owners WHERE organization_id=?
                       AND workspace_id=? AND task_id=?""",
                    (org, workspace, str(row["task_id"])),
                ).fetchone()
                if private_task is not None:
                    raise _not_found(
                        "WORK_NOTIFICATION_NOT_FOUND",
                        "The notification does not exist in this Workspace.",
                    )
            if is_private:
                if not allow_private or private_scope is None:
                    raise _not_found(
                        "WORK_NOTIFICATION_NOT_FOUND",
                        "The notification does not exist in this Workspace.",
                    )
                _resolve_private_teams_route(
                    conn,
                    org,
                    workspace,
                    str(row["private_owner_task_id"] or ""),
                    str(row["owner_actor_id"] or ""),
                    private_scope,
                )
            elif private_only:
                raise _not_found(
                    "WORK_NOTIFICATION_NOT_FOUND",
                    "The notification does not exist in this Workspace.",
                )
            elif row["task_id"] is not None:
                self._require_teams_task_actor(
                    conn,
                    org,
                    workspace,
                    str(row["task_id"]),
                    _identifier(actor_id, "actorId").lower() if actor_id is not None else None,
                    actor_private_scope=actor_private_scope,
                )
            elif actor_private_scope:
                raise _not_found(
                    "WORK_NOTIFICATION_NOT_FOUND",
                    "The notification does not exist for this actor in this Workspace.",
                )
            raw_hash = _sha256(lease_token)
            if not secrets.compare_digest(str(row["lease_token_hash"] or ""), raw_hash):
                raise _conflict(
                    "WORK_NOTIFICATION_LEASE_LOST",
                    "The notification lease is missing or fenced.",
                )
            current = str(row["status"])
            old_result = _stored_object(row["result_json"], "notification result")
            if target_status == "started" and current == "started":
                return self._notification_view(row)
            if current == target_status and old_result == normalized_result:
                return self._notification_view(row)
            if target_status == "started":
                if current != "leased" or int(row["lease_expires_at"] or 0) <= now:
                    raise _conflict(
                        "WORK_NOTIFICATION_LEASE_LOST",
                        "The notification lease has expired.",
                    )
                conn.execute(
                    """UPDATE work_notifications SET status='started',started_at=?,updated_at=?
                       WHERE organization_id=? AND workspace_id=? AND notification_id=?""",
                    (now, now, org, workspace, notification_id),
                )
            else:
                if current != "started" or int(row["lease_expires_at"] or 0) <= now:
                    raise _conflict(
                        "WORK_NOTIFICATION_DELIVERY_STATE_INVALID",
                        "Only the current started lease can record a delivery result.",
                    )
                if target_status == "retry":
                    retry_count = old_result.get("retryCount", 0)
                    if type(retry_count) is not int or retry_count < 0:
                        raise PersistenceError(
                            "WORK_STORAGE_CORRUPT",
                            500,
                            "Stored notification retry count is invalid.",
                        )
                    assert retry_after_seconds is not None
                    stored_result = {**normalized_result, "retryCount": retry_count + 1}
                    conn.execute(
                        """UPDATE work_notifications SET status='queued',available_at=?,
                           result_json=?,updated_at=?,worker_id=NULL,lease_token_hash=NULL,
                           lease_expires_at=NULL WHERE organization_id=? AND workspace_id=? AND
                           notification_id=?""",
                        (
                            now + retry_after_seconds * 1_000,
                            _json_text(stored_result),
                            now,
                            org,
                            workspace,
                            notification_id,
                        ),
                    )
                else:
                    conn.execute(
                        """UPDATE work_notifications SET
                        status=?,result_json=?,updated_at=?,worker_id=NULL,
                           lease_expires_at=NULL WHERE organization_id=? AND workspace_id=? AND
                           notification_id=?""",
                        (
                            target_status,
                            _json_text(normalized_result),
                            now,
                            org,
                            workspace,
                            notification_id,
                        ),
                    )
            updated = conn.execute(
                (
                    "SELECT * FROM work_notifications WHERE organization_id=? AND "
                    "workspace_id=? AND notification_id=?"
                ),
                (org, workspace, notification_id),
            ).fetchone()
            return self._notification_view(updated)

    def _initialize(self) -> None:
        """Create additive Work tables without rebuilding or editing Harness tables. |
        建工作域表。"""

        conn = self._connect()
        try:
            conn.executescript(_WORK_SCHEMA_SQL)
            self._migrate_automation_event_actor_dedupe(conn)
            migrations = {
                "work_tasks": {
                    "created_by_actor_id": "TEXT NOT NULL DEFAULT ''",
                    "continuation_of_task_id": "TEXT",
                    "continuation_mode": "TEXT",
                    "execution_class": "TEXT NOT NULL DEFAULT 'foreground'",
                },
                "work_notifications": {
                    "connector_id": "TEXT",
                    "task_id": "TEXT",
                    "owner_actor_id": "TEXT",
                    "private_owner_task_id": "TEXT",
                    "private_tenant_id": "TEXT",
                    "private_owner_aad_object_id": "TEXT",
                    "private_bot_app_id": "TEXT",
                },
                "work_private_installations": {"last_activity_occurred_at": "INTEGER"},
                "work_private_installation_events": {"activity_occurred_at": "INTEGER"},
                "work_operations": {"task_id": "TEXT", "scope_lock": "TEXT"},
                "work_connector_states": {"configured": "INTEGER NOT NULL DEFAULT 0"},
                "work_connector_threads": {
                    "service_url": "TEXT NOT NULL DEFAULT ''",
                    "owner_actor_id": "TEXT",
                },
                "work_connector_events": {"origin_actor_id": "TEXT"},
                "work_connector_thread_messages": {
                    "tenant_id": "TEXT NOT NULL DEFAULT ''",
                    "team_id": "TEXT NOT NULL DEFAULT ''",
                    "channel_id": "TEXT NOT NULL DEFAULT ''",
                    "conversation_id": "TEXT NOT NULL DEFAULT ''",
                    "root_thread_id": "TEXT NOT NULL DEFAULT ''",
                    "service_url": "TEXT NOT NULL DEFAULT ''",
                },
                "work_workflows": {"owner_actor_id": "TEXT NOT NULL DEFAULT ''"},
                "work_schedule_events": {
                    "trigger_id": "TEXT",
                    "scheduled_at": "TEXT",
                    "status": "TEXT",
                    "task_id": "TEXT",
                    "occurrence_id": "TEXT",
                },
                "work_task_teams_origins": {
                    "conversation_kind": "TEXT NOT NULL DEFAULT 'channel'",
                    "bot_app_id": "TEXT",
                },
            }
            for table, additions in migrations.items():
                columns = {
                    str(row["name"])
                    for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
                }
                for column, declaration in additions.items():
                    if column not in columns:
                        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")
            # Old route rows have no trusted Bot Framework event timestamp. Keep
            # their history but disable delivery until a new remove establishes an
            # ordered baseline and a later verified add creates a fresh route.
            conn.execute(
                """UPDATE work_private_installations SET active=0
                   WHERE last_activity_occurred_at IS NULL AND active<>0"""
            )
            self._migrate_connector_event_actor_dedupe(conn)
            self._migrate_teams_origin_actor_dedupe(conn)
            conn.execute(
                """CREATE INDEX IF NOT EXISTS work_notifications_connector_claim
                   ON work_notifications(organization_id,workspace_id,notification_type,
                       connector_id,recipient,status,available_at,created_at)"""
            )
            conn.execute(
                """CREATE INDEX IF NOT EXISTS work_operations_scope_lock
                   ON work_operations(organization_id,workspace_id,scope_lock,status)"""
            )
            conn.execute(
                """CREATE INDEX IF NOT EXISTS work_notifications_private_claim
                   ON work_notifications(organization_id,workspace_id,owner_actor_id,status,
                       available_at,created_at)"""
            )
            conn.execute(
                """CREATE INDEX IF NOT EXISTS work_workflows_owner_order
                   ON work_workflows(organization_id,workspace_id,version,owner_actor_id,
                       workflow_id)"""
            )
            conn.execute(
                """CREATE INDEX IF NOT EXISTS work_schedule_events_occurrence
                   ON work_schedule_events(organization_id,workspace_id,workflow_id,
                       trigger_id,occurrence_id,status,created_at DESC)"""
            )
            conn.execute(
                """CREATE INDEX IF NOT EXISTS work_schedule_events_occurrence
                   ON work_schedule_events(organization_id,workspace_id,workflow_id,
                       trigger_id,occurrence_id,status,created_at DESC)"""
            )
        finally:
            conn.close()

    @staticmethod
    def _migrate_automation_event_actor_dedupe(conn: sqlite3.Connection) -> None:
        """Replace the legacy workspace-global source ID key with an actor key.

        Existing event rows and public sourceEventId values are copied exactly;
        only SQLite uniqueness scope changes. 中文：保留旧事件，按 actor 扩展去重键。
        """

        legacy_key = ("organization_id", "workspace_id", "source", "source_event_id")
        actor_key = (
            "organization_id",
            "workspace_id",
            "source",
            "actor_id",
            "source_event_id",
        )

        def unique_keys() -> set[tuple[str, ...]]:
            result: set[tuple[str, ...]] = set()
            for index in conn.execute("PRAGMA index_list(work_automation_events)").fetchall():
                if int(index["unique"]) != 1:
                    continue
                index_name = str(index["name"]).replace('"', '""')
                columns = conn.execute(f'PRAGMA index_info("{index_name}")').fetchall()
                result.add(tuple(str(column["name"]) for column in columns))
            return result

        current_keys = unique_keys()
        if actor_key in current_keys:
            return
        if legacy_key not in current_keys:
            raise RuntimeError("work_automation_events has an unsupported deduplication schema")

        conn.execute("BEGIN IMMEDIATE")
        try:
            current_keys = unique_keys()
            if actor_key in current_keys:
                conn.execute("COMMIT")
                return
            conn.execute(
                """CREATE TABLE work_automation_events_actor_scoped (
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
                    UNIQUE(organization_id,workspace_id,source,actor_id,source_event_id)
                )"""
            )
            conn.execute(
                """INSERT INTO work_automation_events_actor_scoped(
                    row_id,organization_id,workspace_id,source,source_event_id,event_id,
                    actor_id,observed_at,event_json,event_digest,visibility
                ) SELECT row_id,organization_id,workspace_id,source,source_event_id,event_id,
                    actor_id,observed_at,event_json,event_digest,visibility
                    FROM work_automation_events"""
            )
            conn.execute("DROP TABLE work_automation_events")
            conn.execute(
                "ALTER TABLE work_automation_events_actor_scoped RENAME TO work_automation_events"
            )
            conn.execute(
                """CREATE INDEX work_automation_events_actor_order
                   ON work_automation_events(organization_id,workspace_id,actor_id,row_id DESC)"""
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.rollback()
            raise

    @staticmethod
    def _migrate_connector_event_actor_dedupe(conn: sqlite3.Connection) -> None:
        """Scope connector activity IDs by trusted actor while retaining shared keys.

        Legacy rows with no actor keep a single Workspace-wide key. Verified Teams
        events use the actor namespace so an activity ID cannot alias another user's
        receipt or task. 中文：保留旧共享事件键，Teams 活动按可信 actor 隔离。
        """

        target_index = "work_connector_events_actor_message"
        legacy_key = ("organization_id", "workspace_id", "connector_id", "message_id")

        def unique_keys() -> set[tuple[str | None, ...]]:
            result: set[tuple[str | None, ...]] = set()
            for index in conn.execute("PRAGMA index_list(work_connector_events)").fetchall():
                if int(index["unique"]) != 1:
                    continue
                index_name = str(index["name"]).replace('"', '""')
                columns = conn.execute(f'PRAGMA index_info("{index_name}")').fetchall()
                result.add(
                    tuple(
                        str(column["name"]) if column["name"] is not None else None
                        for column in columns
                    )
                )
            return result

        def has_target_index() -> bool:
            return any(
                str(row["name"]) == target_index
                for row in conn.execute("PRAGMA index_list(work_connector_events)").fetchall()
            )

        if has_target_index():
            return
        if legacy_key not in unique_keys():
            conn.execute(
                """CREATE UNIQUE INDEX IF NOT EXISTS work_connector_events_actor_message
                   ON work_connector_events(organization_id,workspace_id,connector_id,
                       COALESCE(origin_actor_id,''),message_id)"""
            )
            return

        conn.execute("BEGIN IMMEDIATE")
        try:
            if has_target_index():
                conn.execute("COMMIT")
                return
            conn.execute(
                """CREATE TABLE work_connector_events_actor_scoped (
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
                    origin_actor_id TEXT,
                    PRIMARY KEY(organization_id,workspace_id,connector_id,seq)
                )"""
            )
            conn.execute(
                """INSERT INTO work_connector_events_actor_scoped(
                    organization_id,workspace_id,connector_id,seq,event_id,message_id,event_type,
                    occurred_at,received_at,account_id,conversation_id,sender_id,payload_json,
                    event_digest,task_id,expires_at,origin_actor_id
                ) SELECT organization_id,workspace_id,connector_id,seq,event_id,message_id,
                    event_type,occurred_at,received_at,account_id,conversation_id,sender_id,
                    payload_json,event_digest,task_id,expires_at,origin_actor_id
                    FROM work_connector_events"""
            )
            conn.execute("DROP TABLE work_connector_events")
            conn.execute(
                "ALTER TABLE work_connector_events_actor_scoped RENAME TO work_connector_events"
            )
            conn.execute(
                """CREATE UNIQUE INDEX IF NOT EXISTS work_connector_events_actor_message
                   ON work_connector_events(organization_id,workspace_id,connector_id,
                       COALESCE(origin_actor_id,''),message_id)"""
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.rollback()
            raise

    @staticmethod
    def _migrate_teams_origin_actor_dedupe(conn: sqlite3.Connection) -> None:
        """Allow the same verified Teams activity ID in separate actor namespaces."""

        legacy_key = ("organization_id", "workspace_id", "connector_id", "message_id")
        actor_key = (
            "organization_id",
            "workspace_id",
            "connector_id",
            "actor_id",
            "message_id",
        )

        def unique_keys() -> set[tuple[str, ...]]:
            result: set[tuple[str, ...]] = set()
            for index in conn.execute("PRAGMA index_list(work_task_teams_origins)").fetchall():
                if int(index["unique"]) != 1:
                    continue
                index_name = str(index["name"]).replace('"', '""')
                columns = conn.execute(f'PRAGMA index_info("{index_name}")').fetchall()
                result.add(tuple(str(column["name"]) for column in columns))
            return result

        current_keys = unique_keys()
        if actor_key in current_keys:
            return
        if legacy_key not in current_keys:
            raise RuntimeError("work_task_teams_origins has an unsupported deduplication schema")

        conn.execute("BEGIN IMMEDIATE")
        try:
            current_keys = unique_keys()
            if actor_key in current_keys:
                conn.execute("COMMIT")
                return
            conn.execute(
                """CREATE TABLE work_task_teams_origins_actor_scoped (
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
                    conversation_kind TEXT NOT NULL DEFAULT 'channel',
                    bot_app_id TEXT,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(organization_id,workspace_id,task_id),
                    UNIQUE(organization_id,workspace_id,connector_id,actor_id,message_id),
                    FOREIGN KEY(organization_id,workspace_id,task_id)
                      REFERENCES work_tasks(organization_id,workspace_id,task_id)
                      ON DELETE CASCADE
                )"""
            )
            conn.execute(
                """INSERT INTO work_task_teams_origins_actor_scoped(
                    organization_id,workspace_id,task_id,actor_id,actor_issuer,actor_subject,
                    tenant_id,connector_id,thread_id,message_id,conversation_kind,bot_app_id,
                    created_at
                ) SELECT organization_id,workspace_id,task_id,actor_id,actor_issuer,actor_subject,
                    tenant_id,connector_id,thread_id,message_id,conversation_kind,bot_app_id,
                    created_at
                    FROM work_task_teams_origins"""
            )
            conn.execute("DROP TABLE work_task_teams_origins")
            conn.execute(
                "ALTER TABLE work_task_teams_origins_actor_scoped RENAME TO work_task_teams_origins"
            )
            conn.execute(
                """CREATE INDEX work_task_teams_origins_actor
                   ON work_task_teams_origins(organization_id,workspace_id,actor_id,task_id)"""
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.rollback()
            raise

    @contextmanager
    def _mutation(self) -> Iterator[sqlite3.Connection]:
        """Reserve the SQLite writer before changing Work state. | 开启即时写事务。"""

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
        """Read a stable view from the shared WAL database. | 开启一致性读事务。"""

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
        """Open a bounded connection with Harness durability settings. | 配置 WAL。"""

        conn = sqlite3.connect(
            self.db_path,
            timeout=30.0,
            isolation_level=None,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def _append_event(
        self,
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        task_id: str,
        event: Mapping[str, Any],
        message_id: str | None,
        created_at: int,
    ) -> int:
        """Append one event and advance the task cursor in the caller transaction. |
        推进任务序列。"""

        task = self._require_task(conn, org, workspace, task_id)
        seq = int(task["sequence"]) + 1
        normalized = _json_object(event, "event")
        conn.execute(
            """INSERT INTO work_task_events(organization_id,workspace_id,task_id,seq,event_json,
               event_digest,created_at,message_id) VALUES(?,?,?,?,?,?,?,?)""",
            (
                org,
                workspace,
                task_id,
                seq,
                _json_text(normalized),
                _digest(normalized),
                created_at,
                message_id,
            ),
        )
        conn.execute(
            (
                "UPDATE work_tasks SET sequence=? WHERE organization_id=? AND workspace_id=? "
                "AND task_id=?"
            ),
            (seq, org, workspace, task_id),
        )
        return seq

    def _create_task_in_transaction(
        self,
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        body: Mapping[str, Any],
        now: int,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
        teams_origin: Mapping[str, Any] | None = None,
    ) -> tuple[JsonObject, bool]:
        """Create or replay a task while connector intake owns its transaction. | 原子接纳任务。"""

        task_id = _identifier(body.get("id") or uuid4().hex, "task id")
        session_id = _identifier(body.get("sessionId"), "sessionId")
        prompt = _bounded_text(body.get("prompt"), "prompt", 100_000)
        title = _optional_text(body.get("title"), "title", 512)
        description = _optional_text(body.get("description"), "description", 20_000)
        metadata = _json_object(body.get("metadata", {}), "metadata")
        _task_notification_descriptor(metadata)
        created_by_actor_id = _identifier(actor_id, "actorId") if actor_id else ""
        if teams_origin is not None and not created_by_actor_id:
            raise PersistenceError(
                "WORK_CONNECTOR_TEAMS_ACTOR_MISMATCH",
                403,
                "Teams-origin tasks require an authenticated actor principal.",
            )
        digest = _digest(
            {
                "sessionId": session_id,
                "prompt": prompt,
                "title": title,
                "description": description,
                "metadata": metadata,
                "createdByActorId": created_by_actor_id,
            }
        )
        legacy_digest = _digest(
            {
                "sessionId": session_id,
                "prompt": prompt,
                "title": title,
                "description": description,
                "metadata": metadata,
            }
        )
        prior = conn.execute(
            "SELECT * FROM work_tasks WHERE organization_id=? AND workspace_id=? AND task_id=?",
            (org, workspace, task_id),
        ).fetchone()
        if prior is not None:
            if str(prior["creation_digest"]) != digest and not (
                not str(prior["created_by_actor_id"] or "")
                and str(prior["creation_digest"]) == legacy_digest
            ):
                raise _conflict("WORK_TASK_ID_CONFLICT", "The task id already names another task.")
            if actor_private_scope:
                self._record_private_task_owner(conn, org, workspace, task_id, created_by_actor_id)
            if teams_origin is not None:
                self._record_teams_task_origin(
                    conn, org, workspace, task_id, created_by_actor_id, teams_origin, now
                )
            return self._task_view(conn, prior), True
        conn.execute(
            """INSERT INTO work_tasks(organization_id,workspace_id,task_id,session_id,prompt,status,
               created_at,started_at,ended_at,output,reasoning,error,duration_ms,sequence,title,
               description,metadata_json,creation_digest,created_by_actor_id)
               VALUES(?,?,?,?,?,'queued',?,NULL,NULL,'','',NULL,0,0,?,?,?,?,?)""",
            (
                org,
                workspace,
                task_id,
                session_id,
                prompt,
                now,
                title,
                description,
                _json_text(metadata),
                digest,
                created_by_actor_id,
            ),
        )
        self._append_event(conn, org, workspace, task_id, {"type": "task.created"}, None, now)
        if actor_private_scope:
            self._record_private_task_owner(conn, org, workspace, task_id, created_by_actor_id)
        if teams_origin is not None:
            self._record_teams_task_origin(
                conn, org, workspace, task_id, created_by_actor_id, teams_origin, now
            )
        return self._task_view(conn, self._require_task(conn, org, workspace, task_id)), False

    @staticmethod
    def _record_private_task_owner(
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        task_id: str,
        actor_id: str,
    ) -> None:
        """Persist actor-private task provenance independently of mutable metadata."""

        actor = _identifier(actor_id, "actorId").lower()
        prior = conn.execute(
            """SELECT actor_id FROM work_task_private_owners WHERE organization_id=?
               AND workspace_id=? AND task_id=?""",
            (org, workspace, task_id),
        ).fetchone()
        if prior is not None:
            if str(prior["actor_id"]) != actor:
                raise _conflict(
                    "WORK_TASK_PRIVATE_OWNER_CONFLICT",
                    "The task already has a different immutable private owner.",
                )
            return
        conn.execute(
            """INSERT INTO work_task_private_owners(organization_id,workspace_id,task_id,
               actor_id,created_at) VALUES(?,?,?,?,?)""",
            (org, workspace, task_id, actor, _unix_ms()),
        )

    @staticmethod
    def _record_teams_task_origin(
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        task_id: str,
        actor_id: str,
        teams_origin: Mapping[str, Any],
        now: int,
    ) -> None:
        """Persist connector-verified task provenance independently of mutable metadata."""

        issuer = _bounded_text(teams_origin.get("actorIssuer"), "actorIssuer", 512)
        subject = _identifier(teams_origin.get("actorSubject"), "actorSubject").lower()
        tenant_id = _identifier(teams_origin.get("tenantId"), "tenantId").lower()
        connector_id = _identifier(teams_origin.get("connectorId"), "connectorId")
        thread_id = _identifier(teams_origin.get("threadId"), "threadId")
        message_id = _identifier(teams_origin.get("messageId"), "messageId")
        conversation_kind = teams_origin.get("conversationKind", "channel")
        if conversation_kind not in {"channel", "private"}:
            raise _invalid(
                "WORK_CONNECTOR_INVALID_TEAMS_ORIGIN",
                "conversationKind must be channel or private",
            )
        bot_app_id = (
            _canonical_uuid(teams_origin.get("botAppId"), "botAppId")
            if conversation_kind == "private"
            else None
        )
        if conversation_kind == "private" and bot_app_id is None:
            raise _invalid(
                "WORK_CONNECTOR_INVALID_TEAMS_ORIGIN",
                "private Teams origins require a verified botAppId",
            )
        if subject != actor_id.lower():
            raise PersistenceError(
                "WORK_CONNECTOR_TEAMS_ACTOR_MISMATCH",
                403,
                "The verified Teams subject does not match the authenticated Work actor.",
            )
        prior = conn.execute(
            """SELECT actor_id,actor_issuer,actor_subject,tenant_id,connector_id,thread_id,
                 message_id,conversation_kind,bot_app_id
               FROM work_task_teams_origins WHERE organization_id=? AND workspace_id=?
                 AND task_id=?""",
            (org, workspace, task_id),
        ).fetchone()
        values = (
            actor_id.lower(),
            issuer,
            subject,
            tenant_id,
            connector_id,
            thread_id,
            message_id,
            conversation_kind,
            bot_app_id,
        )
        if prior is not None:
            old = tuple(
                prior[field]
                for field in (
                    "actor_id",
                    "actor_issuer",
                    "actor_subject",
                    "tenant_id",
                    "connector_id",
                    "thread_id",
                    "message_id",
                    "conversation_kind",
                    "bot_app_id",
                )
            )
            if old != values:
                raise _conflict(
                    "WORK_CONNECTOR_TASK_ORIGIN_CONFLICT",
                    "The task already has different verified Teams provenance.",
                )
            return
        conn.execute(
            """INSERT INTO work_task_teams_origins(organization_id,workspace_id,task_id,
               actor_id,actor_issuer,actor_subject,tenant_id,connector_id,thread_id,message_id,
               conversation_kind,bot_app_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (org, workspace, task_id, *values, now),
        )

    @staticmethod
    def _task_view(conn: sqlite3.Connection, row: sqlite3.Row) -> JsonObject:
        """Convert one row into the stable camelCase TaskRecord. | 生成 TaskRecord。"""

        result: JsonObject = {
            "id": str(row["task_id"]),
            "workspaceId": str(row["workspace_id"]),
            "createdByActorId": str(row["created_by_actor_id"])
            if row["created_by_actor_id"]
            else None,
            "sessionId": str(row["session_id"]),
            "prompt": str(row["prompt"]),
            "status": str(row["status"]),
            "createdAt": int(row["created_at"]),
            "startedAt": int(row["started_at"]) if row["started_at"] is not None else None,
            "endedAt": int(row["ended_at"]) if row["ended_at"] is not None else None,
            "output": str(row["output"] or ""),
            "reasoning": str(row["reasoning"] or ""),
            "error": str(row["error"]) if row["error"] is not None else None,
            "durationMs": int(row["duration_ms"] or 0),
            "sequence": int(row["sequence"]),
            "title": row["title"],
            "description": row["description"],
            "metadata": _stored_object(row["metadata_json"], "task metadata"),
            "continuationOfTaskId": row["continuation_of_task_id"],
            "continuationMode": row["continuation_mode"],
            "executionClass": str(row["execution_class"] or "foreground"),
        }
        private_origin = conn.execute(
            """SELECT message_id,tenant_id,bot_app_id,actor_subject FROM work_task_teams_origins
               WHERE organization_id=? AND workspace_id=? AND task_id=?
                 AND conversation_kind='private'""",
            (
                str(row["organization_id"]),
                str(row["workspace_id"]),
                str(row["task_id"]),
            ),
        ).fetchone()
        if private_origin is not None and private_origin["bot_app_id"] is not None:
            result["origin"] = {
                "kind": "teams_private",
                "messageId": str(private_origin["message_id"]),
                "tenantId": str(private_origin["tenant_id"]),
                "botAppId": str(private_origin["bot_app_id"]),
                "actorAadObjectId": str(private_origin["actor_subject"]),
            }
        return result

    @staticmethod
    def _approval_view(row: sqlite3.Row) -> JsonObject:
        """Convert one approval row into its public decision record. | 生成审批视图。"""

        return {
            "id": str(row["approval_id"]),
            "taskId": str(row["task_id"]),
            "kind": str(row["kind"]),
            "summary": str(row["summary"]),
            "details": _stored_object(row["details_json"], "approval details"),
            "status": str(row["status"]),
            "createdAt": int(row["created_at"]),
            "resolvedAt": int(row["resolved_at"]) if row["resolved_at"] is not None else None,
            "resolvedBy": row["resolved_by"],
            "messageId": row["message_id"],
        }

    @staticmethod
    def _input_view(row: sqlite3.Row) -> JsonObject:
        """Convert a persisted human-input gate into its public record. | 生成输入请求视图。"""

        answered = str(row["status"]) == "answered"
        return {
            "id": str(row["input_id"]),
            "taskId": str(row["task_id"]),
            "summary": str(row["summary"]),
            "details": _stored_object(row["details_json"], "input details"),
            "status": str(row["status"]),
            "createdAt": int(row["created_at"]),
            "answeredAt": int(row["answered_at"]) if answered else None,
            "answeredBy": row["answered_by"] if answered else None,
            "answer": _stored_object(row["answer_json"], "input answer") if answered else None,
            "messageId": row["create_message_id"],
            "answerMessageId": row["answer_message_id"],
        }

    @staticmethod
    def _operation_view(row: sqlite3.Row) -> JsonObject:
        """Convert one operation receipt into the public record. | 生成操作回执视图。"""

        return {
            "id": str(row["operation_id"]),
            "idempotencyKey": str(row["idempotency_key"]),
            "operationType": str(row["operation_type"]),
            "taskId": row["task_id"],
            "target": row["target"],
            "scopeLock": row["scope_lock"],
            "request": _stored_object(row["request_json"], "operation request"),
            "status": str(row["status"]),
            "evidence": _stored_object(row["evidence_json"], "operation evidence"),
            "createdAt": int(row["created_at"]),
            "updatedAt": int(row["updated_at"]),
        }

    def _memory_view(self, conn: sqlite3.Connection, row: sqlite3.Row) -> JsonObject:
        """Compute freshness from explicit expiry and complete source snapshots. | 注记时效。"""

        now = _unix_ms()
        source_id = row["source_id"]
        source_stale = False
        if source_id:
            source = conn.execute(
                (
                    "SELECT status,last_complete_at FROM work_sources WHERE "
                    "organization_id=? AND workspace_id=? AND source_id=?"
                ),
                (str(row["organization_id"]), str(row["workspace_id"]), str(source_id)),
            ).fetchone()
            source_stale = source is None or source["last_complete_at"] is None
            if source is not None:
                source_stale = source_stale or (
                    now - int(source["last_complete_at"] or 0) > 86_400_000
                    or str(source["status"]) in {"failed", "incomplete", "stale"}
                )
            linked_source_fact = conn.execute(
                """SELECT missing_at FROM work_source_facts WHERE organization_id=? AND
                workspace_id=?
                   AND source_id=? AND fact_key=?""",
                (
                    str(row["organization_id"]),
                    str(row["workspace_id"]),
                    str(source_id),
                    str(row["fact_key"]),
                ),
            ).fetchone()
            missing = (
                linked_source_fact is not None and linked_source_fact["missing_at"] is not None
            )
        else:
            missing = False
        fresh_until = row["fresh_until"]
        return {
            "id": str(row["fact_id"]),
            "namespace": str(row["namespace"]),
            "key": str(row["fact_key"]),
            "value": _stored_object(row["value_json"], "memory value"),
            "sourceId": source_id,
            "observedAt": int(row["observed_at"]),
            "freshUntil": int(fresh_until) if fresh_until is not None else None,
            "missing": missing,
            "stale": bool(source_stale or (fresh_until is not None and int(fresh_until) < now)),
        }

    @staticmethod
    def _source_fact_view(row: sqlite3.Row) -> JsonObject:
        """Render stable source facts with explicit missing markers. | 生成来源事实视图。"""

        return {
            "sourceId": str(row["source_id"]),
            "key": str(row["fact_key"]),
            "value": _stored_object(row["value_json"], "source fact"),
            "observedAt": int(row["observed_at"]),
            "inventoryId": str(row["last_inventory_id"]),
            "missing": row["missing_at"] is not None,
            "missingAt": int(row["missing_at"]) if row["missing_at"] is not None else None,
        }

    def _source_receipt(
        self,
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        source_id: str,
        inventory_id: str,
        duplicate: bool,
    ) -> JsonObject:
        """Return progress without finalizing an incomplete inventory. | 返回来源清单进度。"""

        run = conn.execute(
            (
                "SELECT * FROM work_source_runs WHERE organization_id=? AND workspace_id=? "
                "AND source_id=? AND inventory_id=?"
            ),
            (org, workspace, source_id, inventory_id),
        ).fetchone()
        return {
            "sourceId": source_id,
            "inventoryId": inventory_id,
            "acceptedPageCount": int(run["page_count"]),
            "complete": str(run["status"]) == "completed",
            "successful": str(run["status"]) != "failed",
            "itemCount": int(run["item_count"]),
            "lastCompleteAt": int(run["completed_at"])
            if str(run["status"]) == "completed"
            else None,
            "duplicate": duplicate,
        }

    @staticmethod
    def _notification_view(row: sqlite3.Row) -> JsonObject:
        """Build an outbox view without disclosing the stored lease digest. | 生成通知视图。"""

        return {
            "id": str(row["notification_id"]),
            "deduplicationKey": str(row["deduplication_key"]),
            "type": str(row["notification_type"]),
            "payload": _stored_object(row["payload_json"], "notification payload"),
            "connectorId": row["connector_id"],
            "recipient": row["recipient"],
            "taskId": row["task_id"],
            "status": str(row["status"]),
            "availableAt": int(row["available_at"]),
            "createdAt": int(row["created_at"]),
            "updatedAt": int(row["updated_at"]),
            "workerId": row["worker_id"],
            "leaseExpiresAt": int(row["lease_expires_at"])
            if row["lease_expires_at"] is not None
            else None,
            "result": _stored_object(row["result_json"], "notification result"),
        }

    @staticmethod
    def _attachment_view(row: sqlite3.Row) -> JsonObject:
        """Build attachment metadata without revealing filesystem details. | 生成附件元数据。"""

        digest = str(row["sha256"])
        return {
            "id": digest,
            "workspaceId": str(row["workspace_id"]),
            "sha256": digest,
            "name": str(row["name"]),
            "mediaType": str(row["media_type"]),
            "size": int(row["size"]),
            "createdAt": int(row["created_at"]),
        }

    @staticmethod
    def _connector_view(row: sqlite3.Row) -> JsonObject:
        """Build the persisted connector health view. | 生成连接器状态视图。"""

        return {
            "connectorId": str(row["connector_id"]),
            "status": str(row["status"]),
            "accountId": row["account_id"],
            "detail": row["detail"],
            "configured": bool(row["configured"]),
            "updatedAt": int(row["updated_at"]),
            "lastEventAt": int(row["last_event_at"]) if row["last_event_at"] is not None else None,
        }

    @staticmethod
    def _require_task(
        conn: sqlite3.Connection, org: str, workspace: str, task_id: str
    ) -> sqlite3.Row:
        """Resolve a task or return a scope-hiding 404. | 越界隐藏为 404。"""

        row: sqlite3.Row | None = conn.execute(
            "SELECT * FROM work_tasks WHERE organization_id=? AND workspace_id=? AND task_id=?",
            (org, workspace, task_id),
        ).fetchone()
        if row is None:
            raise _not_found("WORK_TASK_NOT_FOUND", "The task does not exist in this Workspace.")
        return row

    @staticmethod
    def _require_teams_task_actor(
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        task_id: str,
        actor_id: str | None,
        *,
        actor_private_scope: bool = False,
    ) -> bool:
        """Hide verified Teams-origin tasks from every other Work actor.

        Non-Teams tasks retain the existing Workspace sharing behavior. Teams
        origin is recorded only by the atomic authenticated connector intake,
        never inferred from mutable task metadata.
        """

        private_owner = conn.execute(
            """SELECT actor_id FROM work_task_private_owners WHERE organization_id=?
               AND workspace_id=? AND task_id=?""",
            (org, workspace, task_id),
        ).fetchone()
        if private_owner is not None and (
            actor_id is None or str(private_owner["actor_id"]) != actor_id.lower()
        ):
            raise _not_found("WORK_TASK_NOT_FOUND", "The task does not exist in this Workspace.")
        if actor_private_scope:
            task = conn.execute(
                """SELECT created_by_actor_id FROM work_tasks WHERE organization_id=?
                   AND workspace_id=? AND task_id=?""",
                (org, workspace, task_id),
            ).fetchone()
            if (
                actor_id is None
                or task is None
                or str(task["created_by_actor_id"] or "").lower() != actor_id.lower()
            ):
                raise _not_found(
                    "WORK_TASK_NOT_FOUND",
                    "The task does not exist for this actor in this Workspace.",
                )
        origin = conn.execute(
            """SELECT actor_id,actor_subject FROM work_task_teams_origins WHERE organization_id=?
               AND workspace_id=? AND task_id=?""",
            (org, workspace, task_id),
        ).fetchone()
        if origin is None:
            legacy_team_event = conn.execute(
                """SELECT sender_id FROM work_connector_events WHERE organization_id=?
                   AND workspace_id=? AND task_id=? AND (
                     origin_actor_id IS NOT NULL OR
                     lower(json_extract(payload_json,'$.provider'))='teams' OR
                     event_type LIKE 'teams.%') LIMIT 1""",
                (org, workspace, task_id),
            ).fetchone()
            if legacy_team_event is None:
                return private_owner is not None
            if (
                actor_id is None
                or not legacy_team_event["sender_id"]
                or str(legacy_team_event["sender_id"]).lower() != actor_id.lower()
            ):
                raise _not_found(
                    "WORK_TASK_NOT_FOUND", "The task does not exist in this Workspace."
                )
            return True
        if (
            actor_id is None
            or str(origin["actor_id"]) != actor_id.lower()
            or str(origin["actor_subject"]) != actor_id.lower()
        ):
            raise _not_found("WORK_TASK_NOT_FOUND", "The task does not exist in this Workspace.")
        return True

    @staticmethod
    def _require_no_foreign_teams_session(
        conn: sqlite3.Connection,
        org: str,
        workspace: str,
        session_id: str,
        actor_id: str | None,
    ) -> None:
        """Prevent a generic task from aliasing another actor's verified Teams session."""

        if actor_id is None:
            return
        row = conn.execute(
            """SELECT 1 FROM work_connector_actor_threads WHERE organization_id=?
               AND workspace_id=? AND session_id=? AND actor_subject<>? LIMIT 1""",
            (org, workspace, session_id, actor_id.lower()),
        ).fetchone()
        if row is not None:
            raise _not_found(
                "WORK_BACKEND_SESSION_NOT_FOUND",
                "The native session mapping does not exist for this actor.",
            )
        private_row = conn.execute(
            """SELECT 1 FROM work_tasks task JOIN work_task_private_owners owner
               ON owner.organization_id=task.organization_id
               AND owner.workspace_id=task.workspace_id
               AND owner.task_id=task.task_id WHERE task.organization_id=? AND
               task.workspace_id=? AND task.session_id=? AND lower(owner.actor_id)<>? LIMIT 1""",
            (org, workspace, session_id, actor_id.lower()),
        ).fetchone()
        if private_row is not None:
            raise _not_found(
                "WORK_BACKEND_SESSION_NOT_FOUND",
                "The native session mapping does not exist for this actor.",
            )
        legacy_teams_row = conn.execute(
            """SELECT 1 FROM work_tasks task JOIN work_connector_events event
                 ON event.organization_id=task.organization_id
                AND event.workspace_id=task.workspace_id AND event.task_id=task.task_id
               WHERE task.organization_id=? AND task.workspace_id=? AND task.session_id=?
                 AND (event.origin_actor_id IS NOT NULL OR
                      lower(json_extract(event.payload_json,'$.provider'))='teams' OR
                      event.event_type LIKE 'teams.%')
                 AND lower(event.sender_id)<>? LIMIT 1""",
            (org, workspace, session_id, actor_id.lower()),
        ).fetchone()
        if legacy_teams_row is not None:
            raise _not_found(
                "WORK_BACKEND_SESSION_NOT_FOUND",
                "The native session mapping does not exist for this actor.",
            )

    def seed_connector_binding(
        self, organization_id: str | None, workspace_id: str, connector_id: str
    ) -> JsonObject:
        """Expose a configured binding without asserting live health. | 注册未探测连接器。"""

        org, workspace = _scope(organization_id, workspace_id)
        connector_id = _identifier(connector_id, "connector id")
        now = _unix_ms()
        with self._mutation() as conn:
            conn.execute(
                """INSERT INTO work_connector_states(
                   organization_id,workspace_id,connector_id,status,account_id,detail,
                   updated_at,last_event_at,configured)
                   VALUES(?,?,?,'unknown',NULL,?,?,NULL,1)
                   ON CONFLICT(organization_id,workspace_id,connector_id) DO UPDATE SET
                     status='unknown',account_id=NULL,
                     detail='Configured; live health has not been checked.',
                     updated_at=excluded.updated_at,configured=1""",
                (
                    org,
                    workspace,
                    connector_id,
                    "Configured; live health has not been checked.",
                    now,
                ),
            )
            row = conn.execute(
                """SELECT * FROM work_connector_states WHERE organization_id=?
                   AND workspace_id=? AND connector_id=?""",
                (org, workspace, connector_id),
            ).fetchone()
            return self._connector_view(row)

    @staticmethod
    def _require_running_task(
        conn: sqlite3.Connection, org: str, workspace: str, task_id: str
    ) -> sqlite3.Row:
        """Authorize a tool mutation for its live task. | 限制任务工具副作用。"""

        task_id = _identifier(task_id, "taskId")
        task = WorkStore._require_task(conn, org, workspace, task_id)
        if str(task["status"]) != "running":
            raise _conflict(
                "WORK_TASK_NOT_ACTIVE",
                "Task-scoped tool mutations require the correlated task to be running.",
            )
        return task

    @staticmethod
    def _require_approval(
        conn: sqlite3.Connection, org: str, workspace: str, approval_id: str
    ) -> sqlite3.Row:
        """Resolve a scoped approval or hide it as not found. | 按范围读取审批。"""

        approval_id = _identifier(approval_id, "approval id")
        row: sqlite3.Row | None = conn.execute(
            (
                "SELECT * FROM work_approvals WHERE organization_id=? AND workspace_id=? AND "
                "approval_id=?"
            ),
            (org, workspace, approval_id),
        ).fetchone()
        if row is None:
            raise _not_found(
                "WORK_APPROVAL_NOT_FOUND",
                "The approval does not exist in this Workspace.",
            )
        return row

    @staticmethod
    def _require_input(
        conn: sqlite3.Connection, org: str, workspace: str, input_id: str
    ) -> sqlite3.Row:
        """Resolve one input request or hide its existence outside scope. | 按范围读取输入。"""

        input_id = _identifier(input_id, "input id")
        row: sqlite3.Row | None = conn.execute(
            """SELECT * FROM work_inputs WHERE organization_id=? AND workspace_id=?
               AND input_id=?""",
            (org, workspace, input_id),
        ).fetchone()
        if row is None:
            raise _not_found(
                "WORK_INPUT_NOT_FOUND", "The input request does not exist in this Workspace."
            )
        return row

    @staticmethod
    def _require_source(
        conn: sqlite3.Connection, org: str, workspace: str, source_id: str
    ) -> sqlite3.Row:
        """Require a registered source in the current Workspace. | 要求同空间来源。"""

        row: sqlite3.Row | None = conn.execute(
            "SELECT * FROM work_sources WHERE organization_id=? AND workspace_id=? AND source_id=?",
            (org, workspace, source_id),
        ).fetchone()
        if row is None:
            raise _not_found(
                "WORK_SOURCE_NOT_FOUND", "The source does not exist in this Workspace."
            )
        return row

    def _attachment_path(self, digest: str) -> Path:
        """Derive a content path only from a validated SHA-256 identifier. | 安全生成内容路径。"""

        return self.attachment_root / digest[:2] / digest


_WORK_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS work_tasks (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL,
 session_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
 created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
 output TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '', error TEXT,
 duration_ms INTEGER NOT NULL DEFAULT 0, sequence INTEGER NOT NULL DEFAULT 0,
 title TEXT, description TEXT, metadata_json TEXT NOT NULL, creation_digest TEXT NOT NULL,
 created_by_actor_id TEXT NOT NULL DEFAULT '', continuation_of_task_id TEXT, continuation_mode TEXT,
 execution_class TEXT NOT NULL DEFAULT 'foreground',
 PRIMARY KEY(organization_id,workspace_id,task_id));
CREATE INDEX IF NOT EXISTS work_tasks_order
 ON work_tasks(organization_id,workspace_id,created_at DESC,task_id);
CREATE TABLE IF NOT EXISTS work_task_private_owners (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL,
 actor_id TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,task_id),
 FOREIGN KEY(organization_id,workspace_id,task_id)
 REFERENCES work_tasks(organization_id,workspace_id,task_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS work_task_private_owners_actor
 ON work_task_private_owners(organization_id,workspace_id,actor_id,task_id);
CREATE TABLE IF NOT EXISTS work_backend_sessions (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
 backend TEXT NOT NULL, native_session_id TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,session_id,backend));
CREATE TABLE IF NOT EXISTS work_backend_actor_sessions (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 session_id TEXT NOT NULL, backend TEXT NOT NULL, native_session_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,actor_id,session_id,backend));
CREATE TABLE IF NOT EXISTS work_task_events (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL,
 seq INTEGER NOT NULL, event_json TEXT NOT NULL, event_digest TEXT NOT NULL,
 created_at INTEGER NOT NULL, message_id TEXT,
 PRIMARY KEY(organization_id,workspace_id,task_id,seq),
 UNIQUE(organization_id,workspace_id,task_id,message_id),
 FOREIGN KEY(organization_id,workspace_id,task_id)
 REFERENCES work_tasks(organization_id,workspace_id,task_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS work_approvals (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, approval_id TEXT NOT NULL,
 task_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, details_json TEXT NOT NULL,
 status TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT,
 message_id TEXT, create_message_id TEXT, create_digest TEXT NOT NULL, resolution_digest TEXT,
 PRIMARY KEY(organization_id,workspace_id,approval_id),
 UNIQUE(organization_id,workspace_id,create_message_id),
 FOREIGN KEY(organization_id,workspace_id,task_id)
 REFERENCES work_tasks(organization_id,workspace_id,task_id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS work_approvals_one_pending
 ON work_approvals(organization_id,workspace_id,task_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS work_inputs (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, input_id TEXT NOT NULL,
 task_id TEXT NOT NULL, summary TEXT NOT NULL, details_json TEXT NOT NULL,
 status TEXT NOT NULL, created_at INTEGER NOT NULL, answered_at INTEGER, answered_by TEXT,
 answer_json TEXT, create_message_id TEXT, answer_message_id TEXT,
 create_digest TEXT NOT NULL, answer_digest TEXT,
 PRIMARY KEY(organization_id,workspace_id,input_id),
 UNIQUE(organization_id,workspace_id,create_message_id),
 FOREIGN KEY(organization_id,workspace_id,task_id)
 REFERENCES work_tasks(organization_id,workspace_id,task_id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS work_inputs_one_pending
 ON work_inputs(organization_id,workspace_id,task_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS work_operations (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, operation_type TEXT NOT NULL, task_id TEXT, target TEXT,
 scope_lock TEXT,
 request_json TEXT NOT NULL, status TEXT NOT NULL, evidence_json TEXT NOT NULL,
 request_digest TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,operation_id),
 UNIQUE(organization_id,workspace_id,idempotency_key));
CREATE TABLE IF NOT EXISTS work_memory_facts (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, fact_id TEXT NOT NULL,
 namespace TEXT NOT NULL, fact_key TEXT NOT NULL, value_json TEXT NOT NULL, source_id TEXT,
 observed_at INTEGER NOT NULL, fresh_until INTEGER, updated_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,fact_id),
 UNIQUE(organization_id,workspace_id,namespace,fact_key));
CREATE TABLE IF NOT EXISTS work_private_memory_facts (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 fact_id TEXT NOT NULL, namespace TEXT NOT NULL, fact_key TEXT NOT NULL,
 value_json TEXT NOT NULL, source_id TEXT, observed_at INTEGER NOT NULL,
 fresh_until INTEGER, updated_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,actor_id,fact_id),
 UNIQUE(organization_id,workspace_id,actor_id,namespace,fact_key));
CREATE INDEX IF NOT EXISTS work_private_memory_facts_owner
 ON work_private_memory_facts(organization_id,workspace_id,actor_id,namespace,fact_key);
CREATE TABLE IF NOT EXISTS work_sources (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, source_id TEXT NOT NULL,
 status TEXT NOT NULL, last_complete_at INTEGER, updated_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,source_id));
CREATE TABLE IF NOT EXISTS work_source_runs (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, source_id TEXT NOT NULL,
 inventory_id TEXT NOT NULL, status TEXT NOT NULL, expected_page_token TEXT NOT NULL,
 page_count INTEGER NOT NULL, item_count INTEGER NOT NULL, started_at INTEGER NOT NULL,
 completed_at INTEGER,
 PRIMARY KEY(organization_id,workspace_id,source_id,inventory_id),
 FOREIGN KEY(organization_id,workspace_id,source_id)
 REFERENCES work_sources(organization_id,workspace_id,source_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS work_source_pages (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, source_id TEXT NOT NULL,
 inventory_id TEXT NOT NULL, page_token TEXT NOT NULL, next_page_token TEXT,
 complete INTEGER NOT NULL, successful INTEGER NOT NULL, page_digest TEXT NOT NULL,
 accepted_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,source_id,inventory_id,page_token),
 FOREIGN KEY(organization_id,workspace_id,source_id,inventory_id)
 REFERENCES work_source_runs(organization_id,workspace_id,source_id,inventory_id) ON DELETE
 CASCADE);
CREATE TABLE IF NOT EXISTS work_source_staging (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, source_id TEXT NOT NULL,
 inventory_id TEXT NOT NULL, fact_key TEXT NOT NULL, value_json TEXT NOT NULL,
 observed_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,source_id,inventory_id,fact_key),
 FOREIGN KEY(organization_id,workspace_id,source_id,inventory_id)
 REFERENCES work_source_runs(organization_id,workspace_id,source_id,inventory_id) ON DELETE
 CASCADE);
CREATE TABLE IF NOT EXISTS work_source_facts (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, source_id TEXT NOT NULL,
 fact_key TEXT NOT NULL, value_json TEXT NOT NULL, observed_at INTEGER NOT NULL,
 last_inventory_id TEXT NOT NULL, missing_at INTEGER,
 PRIMARY KEY(organization_id,workspace_id,source_id,fact_key),
 FOREIGN KEY(organization_id,workspace_id,source_id)
 REFERENCES work_sources(organization_id,workspace_id,source_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS work_notifications (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, notification_id TEXT NOT NULL,
 deduplication_key TEXT NOT NULL, notification_type TEXT NOT NULL, payload_json TEXT NOT NULL,
 connector_id TEXT, recipient TEXT, status TEXT NOT NULL, task_id TEXT,
 available_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, worker_id TEXT,
 lease_token_hash TEXT, lease_expires_at INTEGER, started_at INTEGER,
 result_json TEXT NOT NULL, request_digest TEXT NOT NULL,
 owner_actor_id TEXT, private_owner_task_id TEXT, private_tenant_id TEXT,
 private_owner_aad_object_id TEXT, private_bot_app_id TEXT,
 PRIMARY KEY(organization_id,workspace_id,notification_id),
 UNIQUE(organization_id,workspace_id,deduplication_key));
CREATE TABLE IF NOT EXISTS work_credential_authorization_health (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, connection_id TEXT NOT NULL,
 provider TEXT NOT NULL, generation INTEGER NOT NULL, fingerprint TEXT NOT NULL,
 decision TEXT NOT NULL, checked_at TEXT, expires_at TEXT, reason_code TEXT,
 incident_id TEXT, incident_started_at INTEGER, last_notified_at INTEGER,
 reminder_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,connection_id));
CREATE INDEX IF NOT EXISTS work_notifications_claim
 ON work_notifications(organization_id,workspace_id,status,available_at,created_at);
CREATE TABLE IF NOT EXISTS work_private_installations (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
 actor_aad_object_id TEXT NOT NULL, bot_app_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 service_url TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL,
 last_activity_id TEXT NOT NULL, last_activity_digest TEXT NOT NULL,
 last_activity_occurred_at INTEGER,
 PRIMARY KEY(organization_id,workspace_id,tenant_id,actor_aad_object_id,bot_app_id));
CREATE INDEX IF NOT EXISTS work_private_installations_active
 ON work_private_installations(organization_id,workspace_id,active,tenant_id,
    actor_aad_object_id,bot_app_id);
CREATE TABLE IF NOT EXISTS work_private_installation_events (
 row_id INTEGER PRIMARY KEY AUTOINCREMENT,
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
 actor_aad_object_id TEXT NOT NULL, bot_app_id TEXT NOT NULL, activity_id TEXT NOT NULL,
 activity_occurred_at INTEGER,
 action TEXT NOT NULL CHECK(action IN ('add','remove')), event_digest TEXT NOT NULL,
 receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(organization_id,workspace_id,tenant_id,actor_aad_object_id,bot_app_id,activity_id));
CREATE INDEX IF NOT EXISTS work_private_installation_events_retention
 ON work_private_installation_events(organization_id,workspace_id,created_at DESC,row_id DESC);
CREATE TABLE IF NOT EXISTS work_attachments (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, sha256 TEXT NOT NULL,
 name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,sha256));
CREATE TABLE IF NOT EXISTS work_private_attachments (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 sha256 TEXT NOT NULL, name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,actor_id,sha256));
CREATE INDEX IF NOT EXISTS work_private_attachments_owner
 ON work_private_attachments(organization_id,workspace_id,actor_id,created_at DESC);
CREATE TABLE IF NOT EXISTS work_connector_states (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, connector_id TEXT NOT NULL,
 status TEXT NOT NULL, account_id TEXT, detail TEXT, updated_at INTEGER NOT NULL,
 last_event_at INTEGER, configured INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(organization_id,workspace_id,connector_id));
CREATE TABLE IF NOT EXISTS work_connector_events (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, connector_id TEXT NOT NULL,
 seq INTEGER NOT NULL, event_id TEXT NOT NULL, message_id TEXT NOT NULL,
 event_type TEXT NOT NULL, occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
 account_id TEXT, conversation_id TEXT, sender_id TEXT, payload_json TEXT NOT NULL,
 event_digest TEXT NOT NULL, task_id TEXT, expires_at INTEGER, origin_actor_id TEXT,
 PRIMARY KEY(organization_id,workspace_id,connector_id,seq));
CREATE TABLE IF NOT EXISTS work_connector_threads (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, connector_id TEXT NOT NULL,
 thread_id TEXT NOT NULL, tenant_id TEXT NOT NULL, team_id TEXT NOT NULL,
 channel_id TEXT NOT NULL, conversation_id TEXT NOT NULL, root_thread_id TEXT NOT NULL,
 service_url TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL, created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,connector_id,thread_id));
CREATE TABLE IF NOT EXISTS work_connector_thread_messages (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, connector_id TEXT NOT NULL,
 thread_id TEXT NOT NULL, message_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
 team_id TEXT NOT NULL, channel_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 root_thread_id TEXT NOT NULL, service_url TEXT NOT NULL DEFAULT '',
 actor_issuer TEXT NOT NULL, actor_subject TEXT NOT NULL,
 message_text TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,connector_id,thread_id,message_id));
CREATE TABLE IF NOT EXISTS work_connector_actor_threads (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, connector_id TEXT NOT NULL,
 thread_id TEXT NOT NULL, actor_issuer TEXT NOT NULL, actor_subject TEXT NOT NULL,
 tenant_id TEXT NOT NULL, team_id TEXT NOT NULL, channel_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL, root_thread_id TEXT NOT NULL, service_url TEXT NOT NULL DEFAULT '',
 session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,connector_id,thread_id,actor_subject));
CREATE INDEX IF NOT EXISTS work_connector_actor_threads_subject
 ON work_connector_actor_threads(organization_id,workspace_id,actor_subject,updated_at DESC);
CREATE TABLE IF NOT EXISTS work_task_teams_origins (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL,
 actor_id TEXT NOT NULL, actor_issuer TEXT NOT NULL, actor_subject TEXT NOT NULL,
 tenant_id TEXT NOT NULL, connector_id TEXT NOT NULL, thread_id TEXT NOT NULL,
 message_id TEXT NOT NULL, conversation_kind TEXT NOT NULL DEFAULT 'channel', bot_app_id TEXT,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,task_id),
 UNIQUE(organization_id,workspace_id,connector_id,actor_id,message_id),
 FOREIGN KEY(organization_id,workspace_id,task_id)
 REFERENCES work_tasks(organization_id,workspace_id,task_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS work_task_teams_origins_actor
 ON work_task_teams_origins(organization_id,workspace_id,actor_id,task_id);
CREATE INDEX IF NOT EXISTS work_connector_thread_messages_context
 ON work_connector_thread_messages(organization_id,workspace_id,connector_id,thread_id,created_at);
CREATE TABLE IF NOT EXISTS work_workflows (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
 version INTEGER NOT NULL, workflow_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
 owner_actor_id TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(organization_id,workspace_id,workflow_id));
CREATE TABLE IF NOT EXISTS work_schedule_events (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, event_id TEXT NOT NULL,
 workflow_id TEXT NOT NULL, created_at INTEGER NOT NULL, event_json TEXT NOT NULL,
 event_digest TEXT NOT NULL,
 trigger_id TEXT, scheduled_at TEXT, status TEXT, task_id TEXT, occurrence_id TEXT,
 PRIMARY KEY(organization_id,workspace_id,event_id));
CREATE INDEX IF NOT EXISTS work_schedule_events_order
 ON work_schedule_events(organization_id,workspace_id,created_at DESC,event_id);
CREATE TABLE IF NOT EXISTS work_automation_events (
 row_id INTEGER PRIMARY KEY AUTOINCREMENT,
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, source TEXT NOT NULL,
 source_event_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL,
 observed_at INTEGER NOT NULL, event_json TEXT NOT NULL, event_digest TEXT NOT NULL,
 visibility TEXT NOT NULL CHECK(visibility='owner'),
 UNIQUE(organization_id,workspace_id,source,actor_id,source_event_id));
CREATE INDEX IF NOT EXISTS work_automation_events_actor_order
 ON work_automation_events(organization_id,workspace_id,actor_id,row_id DESC);
CREATE TABLE IF NOT EXISTS work_automation_event_states (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 source TEXT NOT NULL, resource_key TEXT NOT NULL, state_class TEXT NOT NULL,
 semantic_fingerprint TEXT NOT NULL, occurred_at INTEGER NOT NULL,
 source_event_id TEXT NOT NULL, event_id TEXT NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,actor_id,source,resource_key));
CREATE TABLE IF NOT EXISTS work_automation_event_intents (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 event_id TEXT NOT NULL, workflow_id TEXT NOT NULL, trigger_id TEXT NOT NULL,
 occurrence_id TEXT NOT NULL, decision TEXT NOT NULL, request_digest TEXT NOT NULL,
 notification_id TEXT, receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,actor_id,event_id,workflow_id,trigger_id));
CREATE INDEX IF NOT EXISTS work_automation_event_intents_digest
 ON work_automation_event_intents(organization_id,workspace_id,actor_id,workflow_id,
    trigger_id,created_at);
CREATE TABLE IF NOT EXISTS work_experiment_indexes (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 experiment_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 updated_at INTEGER NOT NULL, references_json TEXT NOT NULL, last_request_digest TEXT NOT NULL,
 visibility TEXT NOT NULL CHECK(visibility='owner'),
 PRIMARY KEY(organization_id,workspace_id,actor_id,experiment_id));
"""


def _scope(organization_id: str | None, workspace_id: str) -> tuple[str, str]:
    """Normalize the exact tenant key while preserving legacy unscoped identity. | 规范范围键。"""

    org = "" if organization_id is None else _identifier(organization_id, "organizationId")
    return org, _identifier(workspace_id, "workspaceId")


def _identifier(value: object, field: str) -> str:
    """Require a bounded non-empty identifier without control characters. | 校验范围标识。"""

    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise _invalid("WORK_INVALID_IDENTIFIER", f"{field} must be non-empty bounded text")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise _invalid("WORK_INVALID_IDENTIFIER", f"{field} contains control characters")
    return value


def _teams_thread_message(value: object) -> JsonObject | None:
    """Validate trusted Teams identity and route fields before storing context.

    中文：只接受由 Navigator 适配器验证后传入的 tenant/OID 和稳定线程标识。
    """

    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise _invalid(
            "WORK_CONNECTOR_INVALID_TEAMS_THREAD", "teamsThreadMessage must be an object"
        )
    required = {
        "threadId",
        "messageId",
        "tenantId",
        "teamId",
        "channelId",
        "conversationId",
        "rootThreadId",
        "actorIssuer",
        "actorSubject",
        "text",
    }
    allowed = required | {"sessionId", "serviceUrl"}
    if not required.issubset(value) or set(value) - allowed:
        raise _invalid(
            "WORK_CONNECTOR_INVALID_TEAMS_THREAD", "teamsThreadMessage fields are invalid"
        )
    thread_id = _identifier(value.get("threadId"), "teamsThreadMessage.threadId")
    tenant_id = _identifier(value.get("tenantId"), "teamsThreadMessage.tenantId").lower()
    expected_issuer = f"https://login.microsoftonline.com/{tenant_id}/v2.0"
    issuer = _bounded_text(value.get("actorIssuer"), "teamsThreadMessage.actorIssuer", 512)
    subject = _identifier(value.get("actorSubject"), "teamsThreadMessage.actorSubject").lower()
    uuid_pattern = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    if not re.fullmatch(uuid_pattern, tenant_id) or not re.fullmatch(uuid_pattern, subject):
        raise _invalid(
            "WORK_CONNECTOR_INVALID_TEAMS_THREAD",
            "tenantId and actorSubject must be canonical lowercase UUIDs.",
        )
    if issuer != expected_issuer:
        raise _invalid(
            "WORK_CONNECTOR_INVALID_TEAMS_THREAD",
            "actorIssuer must match the verified tenant v2 issuer.",
        )
    service_url_value = value.get("serviceUrl", "")
    normalized: JsonObject = {
        "threadId": thread_id,
        "messageId": _identifier(value.get("messageId"), "teamsThreadMessage.messageId"),
        "serviceUrl": _teams_service_url(service_url_value, tenant_id),
        "tenantId": tenant_id,
        "teamId": _identifier(value.get("teamId"), "teamsThreadMessage.teamId"),
        "channelId": _identifier(value.get("channelId"), "teamsThreadMessage.channelId"),
        "conversationId": _identifier(
            value.get("conversationId"), "teamsThreadMessage.conversationId"
        ),
        "rootThreadId": _identifier(value.get("rootThreadId"), "teamsThreadMessage.rootThreadId"),
        "actorIssuer": issuer,
        "actorSubject": subject,
        "text": _bounded_text(value.get("text"), "teamsThreadMessage.text", 20_000),
    }
    if "sessionId" in value:
        normalized["sessionId"] = _identifier(
            value.get("sessionId"), "teamsThreadMessage.sessionId"
        )
    return normalized


def _teams_private_message(value: object) -> JsonObject | None:
    """Validate a route-free private message matched to a registered installation.

    Actor, tenant, bot app, and delivery route are deliberately absent; the API
    derives those from the authenticated actor principal and current private policy.
    中文：私聊正文不携带 actor 或收件路由身份。
    """

    if value is None:
        return None
    if not isinstance(value, Mapping) or set(value) != {
        "messageId",
        "text",
    }:
        raise _invalid(
            "WORK_CONNECTOR_INVALID_TEAMS_PRIVATE_MESSAGE",
            "teamsPrivateMessage must contain messageId and text",
        )
    return {
        "messageId": _identifier(value.get("messageId"), "teamsPrivateMessage.messageId"),
        "text": _bounded_text(value.get("text"), "teamsPrivateMessage.text", 20_000),
    }


def _teams_private_origin_thread_id(tenant_id: str, actor_id: str, bot_app_id: str) -> str:
    """Build a stable opaque origin key without persisting a conversation ID."""

    digest = hashlib.sha256(
        f"{tenant_id.lower()}\0{actor_id.lower()}\0{bot_app_id.lower()}".encode()
    ).hexdigest()
    return "teams-private-" + digest[:40]


def _teams_service_url(value: object, tenant_id: str) -> str:
    """Require a verified Bot Framework HTTPS host and exact allowed regional path.

    中文：只允许 Bot Framework 官方 HTTPS 主机及精确地域路径。
    """

    if value == "":
        return ""
    if not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        tenant_id,
    ):
        raise _invalid("WORK_CONNECTOR_INVALID_TEAMS_THREAD", "serviceUrl tenant scope is invalid")
    if (
        not isinstance(value, str)
        or len(value) > 512
        or value.strip() != value
        or re.search(r"[\s\x00-\x1f\x7f%\\]", value)
    ):
        raise _invalid("WORK_CONNECTOR_INVALID_TEAMS_THREAD", "serviceUrl is invalid")
    match = re.fullmatch(r"https://([^/?#]+)(/[^?#]*)", value)
    if match is None:
        raise _invalid("WORK_CONNECTOR_INVALID_TEAMS_THREAD", "serviceUrl is invalid")
    authority, path = match.groups()
    host = authority.lower().removesuffix(":443")
    if host not in {"smba.trafficmanager.net", "smba.infra.teams.microsoft.com"}:
        raise _invalid("WORK_CONNECTOR_INVALID_TEAMS_THREAD", "serviceUrl host is not allowed")
    channel_path = path in {"/teams", "/teams/"}
    if host == "smba.infra.teams.microsoft.com":
        if not channel_path:
            raise _invalid("WORK_CONNECTOR_INVALID_TEAMS_THREAD", "serviceUrl path is not allowed")
        return value
    if channel_path:
        return value
    segments = path.split("/")[1:]
    if segments and segments[-1] == "":
        segments.pop()
    if any(
        re.fullmatch(r"[A-Za-z0-9-]{1,128}", segment) is None or segment in {".", ".."}
        for segment in segments
    ):
        raise _invalid("WORK_CONNECTOR_INVALID_TEAMS_THREAD", "serviceUrl path is invalid")
    regions = {"amer", "in", "emea", "apac"}
    if len(segments) == 1 and segments[0] in regions:
        return value
    if (
        len(segments) == 2
        and segments[0] in regions
        and _teams_service_tenant_matches(segments[1], tenant_id)
    ):
        return value
    raise _invalid("WORK_CONNECTOR_INVALID_TEAMS_THREAD", "serviceUrl path is not allowed")


def _teams_service_tenant_matches(path_segment: str, tenant_id: str) -> bool:
    try:
        return str(UUID(path_segment)) == tenant_id
    except ValueError:
        return False


def _bounded_text(value: object, field: str, maximum: int, *, allow_empty: bool = False) -> str:
    """Validate a text payload against its field-specific bound. | 校验文本长度。"""

    if (
        not isinstance(value, str)
        or (not allow_empty and not value.strip())
        or len(value) > maximum
    ):
        raise _invalid(
            "WORK_INVALID_TEXT",
            f"{field} must be non-empty text of at most {maximum} characters",
        )
    if any(ord(character) == 0 for character in value):
        raise _invalid("WORK_INVALID_TEXT", f"{field} contains a null character")
    return value


def _optional_text(value: object, field: str, maximum: int) -> str | None:
    """Validate nullable text without treating an empty value as an identifier. | 校验可空文本。"""

    if value is None:
        return None
    if not isinstance(value, str) or len(value) > maximum or any(ord(ch) == 0 for ch in value):
        raise _invalid("WORK_INVALID_TEXT", f"{field} must be text of at most {maximum} characters")
    return value


def _credential_health_snapshot(value: object) -> JsonObject:
    """Normalize one strict, credential-free Exchange authorization snapshot."""

    allowed = {
        "connectionId",
        "provider",
        "loginState",
        "authorizationState",
        "checkedAt",
        "expiresAt",
        "generation",
        "capabilities",
        "reasonCode",
    }
    if not isinstance(value, Mapping) or set(value) != allowed:
        raise _invalid(
            "WORK_CREDENTIAL_HEALTH_INVALID",
            "A credential health snapshot has an unsupported shape.",
        )
    connection_id = _identifier(value.get("connectionId"), "connectionId")
    try:
        connection_id = str(UUID(connection_id))
    except ValueError as exc:
        raise _invalid(
            "WORK_CREDENTIAL_HEALTH_INVALID", "connectionId must be a canonical UUID"
        ) from exc
    provider = _bounded_text(value.get("provider"), "provider", 32)
    if provider not in {"hf", "runpod", "azure", "gcp"}:
        raise _invalid("WORK_CREDENTIAL_HEALTH_INVALID", "provider is not supported")
    login_state = _bounded_text(value.get("loginState"), "loginState", 32)
    if login_state not in {"PRESENT", "MISSING", "UNKNOWN", "UNAVAILABLE"}:
        raise _invalid("WORK_CREDENTIAL_HEALTH_INVALID", "loginState is not supported")
    authorization_state = _bounded_text(value.get("authorizationState"), "authorizationState", 64)
    if authorization_state not in {
        "VALID",
        "REAUTHORIZATION_REQUIRED",
        "PERMISSION_DENIED",
        "UNKNOWN",
        "UNAVAILABLE",
    }:
        raise _invalid("WORK_CREDENTIAL_HEALTH_INVALID", "authorizationState is not supported")
    checked_at = _credential_utc_timestamp(value.get("checkedAt"), "checkedAt")
    expires_at = _credential_utc_timestamp(value.get("expiresAt"), "expiresAt")
    generation = _nonnegative_integer(value.get("generation"), "generation")
    raw_capabilities = value.get("capabilities")
    if not isinstance(raw_capabilities, list) or len(raw_capabilities) > 100:
        raise _invalid("WORK_CREDENTIAL_HEALTH_INVALID", "capabilities must be a bounded array")
    capabilities: list[JsonObject] = []
    capability_ids: set[str] = set()
    for item in raw_capabilities:
        if not isinstance(item, Mapping) or set(item) != {
            "capabilityId",
            "state",
            "lastVerifiedAt",
            "expiresAt",
            "reasonCode",
        }:
            raise _invalid(
                "WORK_CREDENTIAL_HEALTH_INVALID",
                "A capability health snapshot has an unsupported shape.",
            )
        capability_id = _identifier(item.get("capabilityId"), "capabilityId")
        if _CREDENTIAL_CAPABILITY_ID_PATTERN.fullmatch(capability_id) is None:
            raise _invalid(
                "WORK_CREDENTIAL_HEALTH_INVALID",
                "capabilityId does not match the supported capability identifier contract.",
            )
        if capability_id in capability_ids:
            raise _invalid("WORK_CREDENTIAL_HEALTH_INVALID", "capability ids must be unique")
        capability_ids.add(capability_id)
        state = _bounded_text(item.get("state"), "capability.state", 64)
        if state not in {
            "VALID",
            "REAUTHORIZATION_REQUIRED",
            "PERMISSION_DENIED",
            "UNKNOWN",
            "UNAVAILABLE",
        }:
            raise _invalid("WORK_CREDENTIAL_HEALTH_INVALID", "capability state is not supported")
        capabilities.append(
            {
                "capabilityId": capability_id,
                "state": state,
                "lastVerifiedAt": _credential_utc_timestamp(
                    item.get("lastVerifiedAt"), "capability.lastVerifiedAt"
                ),
                "expiresAt": _credential_utc_timestamp(
                    item.get("expiresAt"), "capability.expiresAt"
                ),
                "reasonCode": _credential_reason_code(
                    item.get("reasonCode"), "capability.reasonCode"
                ),
            }
        )
    reason_code = _credential_reason_code(value.get("reasonCode"), "reasonCode")
    return {
        "connectionId": connection_id,
        "provider": provider,
        "loginState": login_state,
        "authorizationState": authorization_state,
        "checkedAt": checked_at,
        "expiresAt": expires_at,
        "generation": generation,
        "capabilities": sorted(capabilities, key=lambda item: str(item["capabilityId"])),
        "reasonCode": reason_code,
    }


def _credential_utc_timestamp(value: object, field: str) -> str | None:
    """Accept only parseable UTC RFC3339 timestamps from the Exchange projection."""

    if value is None:
        return None
    timestamp = _bounded_text(value, field, 64)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", timestamp):
        raise _invalid("WORK_CREDENTIAL_HEALTH_INVALID", f"{field} must be UTC RFC3339")
    from datetime import UTC, datetime

    try:
        datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError as exc:
        raise _invalid("WORK_CREDENTIAL_HEALTH_INVALID", f"{field} is invalid") from exc
    return timestamp


def _credential_timestamp_ms(value: str) -> int:
    """Convert a validated UTC projection timestamp to Unix milliseconds."""

    from datetime import UTC, datetime

    return int(
        datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC).timestamp() * 1_000
    )


def _private_installation_activity_timestamp_ms(value: object, now_ms: int) -> int:
    """Accept verified UTC Activity timestamps and reject implausible future values."""

    timestamp = _bounded_text(value, "activityOccurredAt", 64)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", timestamp):
        raise _invalid(
            "WORK_TEAMS_PRIVATE_INSTALLATION_INVALID",
            "activityOccurredAt must be an ISO-8601 UTC timestamp ending in Z.",
        )
    from datetime import UTC, datetime

    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(UTC)
        occurred_at_ms = int(parsed.timestamp() * 1_000)
    except (OverflowError, ValueError) as exc:
        raise _invalid(
            "WORK_TEAMS_PRIVATE_INSTALLATION_INVALID", "activityOccurredAt is invalid."
        ) from exc
    if occurred_at_ms < 0 or occurred_at_ms > now_ms + 5 * 60 * 1_000:
        raise _invalid(
            "WORK_TEAMS_PRIVATE_INSTALLATION_INVALID",
            "activityOccurredAt is outside the accepted UTC time range.",
        )
    return occurred_at_ms


def _credential_reason_code(value: object, field: str) -> str | None:
    """Allow bounded symbolic provider codes and reject free-form error text."""

    reason_code = _optional_text(value, field, 160)
    if reason_code is not None and not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._:-]{0,159}", reason_code
    ):
        raise _invalid("WORK_CREDENTIAL_HEALTH_INVALID", f"{field} must be a symbolic code")
    return reason_code


def _credential_health_decision(snapshot: Mapping[str, Any], now: int) -> str:
    """Treat only fresh explicit authorization failures as actionable. | 判定授权状态。"""

    checked_at = snapshot.get("checkedAt")
    if checked_at is None:
        return "unknown"
    checked_ms = _credential_timestamp_ms(str(checked_at))
    if checked_ms > now + 5 * 60 * 1_000 or now - checked_ms > 30 * 60 * 1_000:
        return "unknown"
    states = [str(snapshot["authorizationState"])] + [
        str(item["state"]) for item in snapshot["capabilities"]
    ]
    if snapshot["loginState"] in {"UNKNOWN", "UNAVAILABLE"} or any(
        state in {"UNKNOWN", "UNAVAILABLE"} for state in states
    ):
        return "unknown"
    if any(state in {"REAUTHORIZATION_REQUIRED", "PERMISSION_DENIED"} for state in states):
        return "action_required"
    if (
        snapshot["loginState"] == "PRESENT"
        and snapshot["authorizationState"] == "VALID"
        and all(item["state"] == "VALID" for item in snapshot["capabilities"])
    ):
        return "healthy"
    return "unknown"


def _credential_health_fingerprint(snapshot: Mapping[str, Any]) -> str:
    """Fingerprint meaningful state because Exchange generation tracks configuration, not probes."""

    return _digest(
        {
            "provider": snapshot["provider"],
            "loginState": snapshot["loginState"],
            "authorizationState": snapshot["authorizationState"],
            "expiresAt": snapshot["expiresAt"],
            "generation": snapshot["generation"],
            "capabilities": [
                {
                    "capabilityId": item["capabilityId"],
                    "state": item["state"],
                    "expiresAt": item["expiresAt"],
                    "reasonCode": item["reasonCode"],
                }
                for item in snapshot["capabilities"]
            ],
            "reasonCode": snapshot["reasonCode"],
        }
    )


def _credential_health_notice(
    snapshot: Mapping[str, Any], event: str, incident_id: str
) -> JsonObject:
    """Build a minimal notice payload without auth references or provider error text."""

    return {
        "schemaVersion": 1,
        "event": event,
        "incidentId": incident_id,
        "connectionId": snapshot["connectionId"],
        "provider": snapshot["provider"],
        "generation": snapshot["generation"],
        "loginState": snapshot["loginState"],
        "authorizationState": snapshot["authorizationState"],
        "capabilities": [
            {"capabilityId": item["capabilityId"], "state": item["state"]}
            for item in snapshot["capabilities"]
        ],
        "checkedAt": snapshot["checkedAt"],
        "expiresAt": snapshot["expiresAt"],
        "reasonCode": snapshot["reasonCode"],
    }


def _nonnegative_integer(value: object, field: str) -> int:
    """Require a JavaScript-safe non-negative timestamp or sequence. | 校验非负整数。"""

    if type(value) is not int or value < 0 or value > 2**53 - 1:
        raise _invalid("WORK_INVALID_INTEGER", f"{field} must be a non-negative safe integer")
    return value


def _json_object(value: object, field: str) -> JsonObject:
    """Copy and strictly encode one JSON object. | 校验 JSON 对象。"""

    if not isinstance(value, Mapping):
        raise _invalid("WORK_INVALID_JSON", f"{field} must be a JSON object")
    normalized = dict(value)
    text = _json_text(normalized)
    if len(text.encode("utf-8")) > _MAX_JSON_BYTES:
        raise _invalid("WORK_JSON_TOO_LARGE", f"{field} exceeds the 2 MB limit")
    return normalized


def _human_input_object(value: object, field: str) -> JsonObject:
    """Reject credential-shaped fields in human input and cap displayed text. | 拒绝敏感字段。"""

    normalized = _json_object(value, field)
    blocked = {
        "password",
        "passwd",
        "token",
        "secret",
        "credential",
        "credentials",
        "authorization",
        "cookie",
        "qr",
        "qrpayload",
        "apikey",
        "privatekey",
        "accesskey",
        "refreshkey",
        "qrcode",
        "qrdata",
        "qrimage",
    }
    sensitive_suffixes = (
        "password",
        "passwd",
        "token",
        "secret",
        "credential",
        "cookie",
        "apikey",
        "privatekey",
    )

    def validate(item: object, depth: int = 0) -> None:
        if depth > 16:
            raise _invalid("WORK_INPUT_TOO_DEEP", f"{field} is nested too deeply")
        if isinstance(item, Mapping):
            for key, child in item.items():
                if not isinstance(key, str):
                    raise _invalid("WORK_INVALID_JSON", f"{field} keys must be text")
                normalized_key = "".join(
                    character for character in key.lower() if character.isalnum()
                )
                is_sensitive = normalized_key in blocked or normalized_key.endswith(
                    sensitive_suffixes
                )
                if is_sensitive:
                    raise _invalid(
                        "WORK_INPUT_SENSITIVE_FIELD",
                        f"{field} cannot contain credential or login fields.",
                    )
                if field == "answer" and key == "text":
                    if not isinstance(child, str):
                        raise _invalid("WORK_INPUT_INVALID_TEXT", "answer.text must be text.")
                    if len(child) > 4_000:
                        raise _invalid(
                            "WORK_INPUT_TEXT_TOO_LARGE",
                            "answer.text must be at most 4,000 characters.",
                        )
                validate(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                validate(child, depth + 1)

    validate(normalized)
    return normalized


def _failed_task_result_notification_text(error: str, output: str) -> str:
    """Bound text while retaining both ends of the task output. | 限长并保留输出两端。"""

    if not output:
        if len(error) > _TASK_RESULT_NOTIFICATION_MAX_CHARS:
            return error[: _TASK_RESULT_NOTIFICATION_MAX_CHARS - 20] + " [truncated]"
        return error
    separator = "\n\n"
    if len(error) + len(separator) + len(output) <= _TASK_RESULT_NOTIFICATION_MAX_CHARS:
        return error + separator + output

    # Keep the output's start and end so both completed work and the trusted blocked-item
    # summary appended by the executor remain visible.
    error_prefix = error
    error_limit = _TASK_RESULT_NOTIFICATION_MAX_CHARS // 4
    if len(error_prefix) > error_limit:
        error_prefix = (
            error_prefix[: error_limit - len(" [error truncated]")] + " [error truncated]"
        )
    if len(error_prefix) + len(separator) + len(output) <= _TASK_RESULT_NOTIFICATION_MAX_CHARS:
        return error_prefix + separator + output
    output_budget = (
        _TASK_RESULT_NOTIFICATION_MAX_CHARS
        - len(error_prefix)
        - len(separator)
        - len(_TASK_RESULT_NOTIFICATION_TRUNCATION)
    )
    output_prefix_budget = output_budget // 2
    output_suffix_budget = output_budget - output_prefix_budget
    return (
        error_prefix
        + separator
        + output[:output_prefix_budget]
        + _TASK_RESULT_NOTIFICATION_TRUNCATION
        + output[-output_suffix_budget:]
    )


def _task_result_text(task: sqlite3.Row) -> str:
    """Build one bounded terminal result before its server-owned delivery route. | 生成结果正文。"""

    status = str(task["status"])
    if status == "completed":
        text = str(task["output"] or "").strip() or "Task completed."
    elif status == "failed":
        error = str(task["error"] or "").strip() or "Task failed."
        text = _failed_task_result_notification_text(error, str(task["output"] or "").strip())
    else:
        text = "Task aborted."
    if status != "failed" and len(text) > _TASK_RESULT_NOTIFICATION_MAX_CHARS:
        text = text[: _TASK_RESULT_NOTIFICATION_MAX_CHARS - 20] + " [truncated]"
    return text


def _task_notification_descriptor(metadata: Mapping[str, Any]) -> JsonObject | None:
    """Validate the trusted adapter route carried by an admitted task. | 校验任务回复路由。"""

    value = metadata.get("notification")
    if value is None:
        return None
    if not isinstance(value, Mapping) or set(value) != {
        "type",
        "connectorId",
        "recipient",
        "payload",
    }:
        raise _invalid(
            "WORK_TASK_INVALID_NOTIFICATION",
            "metadata.notification must contain type, connectorId, recipient, and payload.",
        )
    notification_type = _bounded_text(value.get("type"), "notification.type", 128)
    connector_id = _identifier(value.get("connectorId"), "notification.connectorId")
    recipient = _bounded_text(value.get("recipient"), "notification.recipient", 2_000)
    payload = _json_object(value.get("payload"), "notification.payload")
    if notification_type == "wecom.message":
        expected_fields = {"accountId", "conversationId", "chatType", "senderId"}
        route_error = "The WeCom route needs accountId, conversationId, chatType, and senderId."
    elif notification_type == "teams.message":
        expected_fields = {
            "tenantId",
            "teamId",
            "channelId",
            "conversationId",
            "rootThreadId",
        }
        if set(payload) == expected_fields | {"serviceUrl"}:
            service_url = _teams_service_url(
                payload.get("serviceUrl"), str(payload.get("tenantId", "")).lower()
            )
            expected_fields = expected_fields | {"serviceUrl"}
            payload = {**payload, "serviceUrl": service_url}
        route_error = (
            "The Teams route needs tenantId, teamId, channelId, conversationId, rootThreadId, "
            "and an optional validated serviceUrl."
        )
    else:
        raise _invalid(
            "WORK_TASK_INVALID_NOTIFICATION",
            "Task result notifications require a supported connector message type.",
        )
    if set(payload) != expected_fields:
        raise _invalid("WORK_TASK_INVALID_NOTIFICATION", route_error)
    route = {
        field: _bounded_text(payload[field], f"notification.payload.{field}", 512)
        for field in sorted(expected_fields)
    }
    return {
        "type": notification_type,
        "connectorId": connector_id,
        "recipient": recipient,
        "payload": route,
    }


def _validate_task_execution_metadata(execution_class: object, metadata: Mapping[str, Any]) -> None:
    """Keep background task authority host-generated and bound to a v2 responsibility.

    Args:
        execution_class: Persisted foreground/background admission class.
        metadata: Host-generated task metadata stored alongside the durable record.
    Raises:
        PersistenceError: If a background task has no verifiable workflow provenance.

    中文：后台任务必须携带责任、发生实例和 owner Teams 线程引用，不能由普通任务冒充。
    """

    if execution_class == "foreground":
        return
    if execution_class != "background":
        raise _invalid("WORK_TASK_INVALID_EXECUTION_CLASS", "executionClass is not supported")
    if metadata.get("source") != "workflow":
        raise _invalid(
            "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
            "Background tasks require workflow provenance",
        )
    for field in ("workflowId", "triggerId", "occurrenceId"):
        _identifier(metadata.get(field), f"metadata.{field}")
    authorization = metadata.get("authorizationRef")
    if not isinstance(authorization, Mapping):
        raise _invalid(
            "WORK_TASK_BACKGROUND_AUTHORIZATION_REQUIRED",
            "Background task authorization reference is invalid",
        )
    authorization_kind = authorization.get("kind")
    if authorization_kind == "teams_thread" and set(authorization) == {
        "kind",
        "threadBindingId",
        "ownerTaskId",
    }:
        _identifier(
            authorization.get("threadBindingId"), "metadata.authorizationRef.threadBindingId"
        )
    elif authorization_kind == "owner_private" and set(authorization) == {
        "kind",
        "ownerTaskId",
    }:
        pass
    else:
        raise _invalid(
            "WORK_TASK_BACKGROUND_AUTHORIZATION_REQUIRED",
            "Background task authorization source or fields are invalid",
        )
    _identifier(authorization.get("ownerTaskId"), "metadata.authorizationRef.ownerTaskId")
    action_id = metadata.get("actionId")
    if action_id is not None:
        _identifier(action_id, "metadata.actionId")
        _identifier(metadata.get("actionType"), "metadata.actionType")
        _identifier(metadata.get("parentTaskId"), "metadata.parentTaskId")
    elif metadata.get("parentTaskId") is not None or metadata.get("actionType") is not None:
        raise _invalid(
            "WORK_TASK_BACKGROUND_PARENT_INVALID", "Only action children may have a parent task"
        )


def _json_text(value: object) -> str:
    """Encode canonical JSON and reject NaN or infinity. | 编码规范 JSON。"""

    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as exc:
        raise _invalid(
            "WORK_INVALID_JSON", "The value must be losslessly JSON serializable."
        ) from exc


def _stored_object(value: object, field: str) -> JsonObject:
    """Decode a persisted object or fail closed on database corruption. | 安全读取持久 JSON。"""

    try:
        decoded = json.loads(str(value))
    except (TypeError, ValueError) as exc:
        raise PersistenceError(
            "WORK_STORAGE_CORRUPT", 500, f"Stored {field} is invalid JSON."
        ) from exc
    if not isinstance(decoded, dict):
        raise PersistenceError("WORK_STORAGE_CORRUPT", 500, f"Stored {field} is not an object.")
    return decoded


def _digest(value: object) -> str:
    """Hash canonical JSON for stable request/event deduplication. | 计算内容摘要。"""

    return hashlib.sha256(_json_text(value).encode("utf-8")).hexdigest()


def _notification_request_digest(
    notification_type: str,
    payload: Mapping[str, Any],
    connector_id: str | None,
    recipient: str | None,
    task_id: str | None,
) -> str:
    """Identify one notification request independent of delivery state. | 计算通知请求摘要。"""

    return _digest(
        {
            "type": notification_type,
            "payload": payload,
            "connectorId": connector_id,
            "recipient": recipient,
            "taskId": task_id,
        }
    )


def _sha256(value: str) -> str:
    """Hash a bearer-like capability before storing it. | 仅存能力哈希。"""

    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _validate_digest(value: str) -> str:
    """Accept exactly one lower-case content digest. | 校验内容摘要路径。"""

    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(ch not in "0123456789abcdef" for ch in value)
    ):
        raise _invalid("WORK_INVALID_IDENTIFIER", "sha256 must be a lowercase SHA-256 digest")
    return value


def _encode_cursor(created_at: int, identifier: str) -> str:
    """Encode an opaque stable pagination cursor. | 编码分页游标。"""

    raw = _json_text([created_at, identifier]).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str | None) -> tuple[int, str]:
    """Decode a bounded pagination cursor. | 解码分页游标。"""

    if not isinstance(cursor, str) or len(cursor) > 2_000:
        raise _invalid("WORK_INVALID_CURSOR", "cursor is invalid")
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        decoded = json.loads(raw)
        if not isinstance(decoded, list) or len(decoded) != 2:
            raise ValueError("wrong cursor shape")
        created_at = _nonnegative_integer(decoded[0], "cursor timestamp")
        identifier = _identifier(decoded[1], "cursor identifier")
        return created_at, identifier
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise _invalid("WORK_INVALID_CURSOR", "cursor is invalid") from exc


def _iso_utc(timestamp_ms: int) -> str:
    """Format a UTC timestamp without locale-dependent fields. | 格式化 UTC 时间。"""

    from datetime import UTC, datetime

    return (
        datetime.fromtimestamp(timestamp_ms / 1000, UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _validate_automation_event(event: Mapping[str, Any]) -> JsonObject:
    """Normalize one bounded, identity-free automation event. | 规范化自动化事件。"""

    value = _json_object(event, "automation event")
    allowed = {
        "source",
        "sourceEventId",
        "resourceUri",
        "sourceVersion",
        "eventType",
        "occurredAt",
        "title",
        "summary",
        "severity",
        "correlationId",
        "experimentId",
        "semanticFingerprint",
        "stateClass",
        "metadataReferences",
    }
    required = {
        "source",
        "sourceEventId",
        "resourceUri",
        "sourceVersion",
        "eventType",
        "occurredAt",
    }
    if not required.issubset(value) or set(value) - allowed:
        raise _invalid(
            "WORK_AUTOMATION_EVENT_INVALID",
            "automation event contains missing or unsupported fields",
        )
    source = _bounded_text(value.get("source"), "source", 128)
    event_type = _bounded_text(value.get("eventType"), "eventType", 256)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}", source) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}", event_type
    ):
        raise _invalid("WORK_AUTOMATION_EVENT_INVALID", "source and eventType must be identifiers")
    source_version = _validate_resource_version(value.get("sourceVersion"), "sourceVersion")
    occurred_at = _nonnegative_integer(value.get("occurredAt"), "occurredAt")
    severity = value.get("severity")
    if severity is not None and severity not in {"info", "warning", "critical"}:
        raise _invalid("WORK_AUTOMATION_EVENT_INVALID", "severity is not supported")
    experiment_value = value.get("experimentId")
    semantic_fingerprint = value.get("semanticFingerprint")
    if semantic_fingerprint is not None and (
        not isinstance(semantic_fingerprint, str)
        or not re.fullmatch(r"[a-f0-9]{64}", semantic_fingerprint)
    ):
        raise _invalid(
            "WORK_AUTOMATION_EVENT_INVALID", "semanticFingerprint must be a SHA-256 digest"
        )
    state_class = value.get("stateClass")
    if state_class is not None and state_class not in {"healthy", "incident", "neutral"}:
        raise _invalid("WORK_AUTOMATION_EVENT_INVALID", "stateClass is not supported")
    normalized: JsonObject = {
        "source": source,
        "sourceEventId": _bounded_text(value.get("sourceEventId"), "sourceEventId", 512),
        "resourceUri": _safe_resource_uri(value.get("resourceUri"), "resourceUri"),
        "sourceVersion": source_version,
        "eventType": event_type,
        "occurredAt": occurred_at,
        "title": _optional_text(value.get("title"), "title", 512),
        "summary": _optional_text(value.get("summary"), "summary", 2_000),
        "severity": severity,
        "correlationId": (
            _identifier(value.get("correlationId"), "correlationId")
            if value.get("correlationId") is not None
            else None
        ),
        "experimentId": (
            _canonical_uuid(experiment_value, "experimentId")
            if experiment_value is not None
            else None
        ),
        "semanticFingerprint": semantic_fingerprint,
        "stateClass": state_class,
    }
    references = value.get("metadataReferences", [])
    if not isinstance(references, list) or len(references) > 32:
        raise _invalid(
            "WORK_AUTOMATION_EVENT_INVALID", "metadataReferences must contain at most 32 entries"
        )
    normalized["metadataReferences"] = [
        _automation_resource_reference(item, f"metadataReferences[{index}]")
        for index, item in enumerate(references)
    ]
    return normalized


def _automation_resource_reference(value: object, field: str) -> JsonObject:
    """Validate a typed resource URI without resolving it or accepting free-form data.

    中文：校验资源引用。
    """

    if (
        not isinstance(value, Mapping)
        or set(value)
        - {
            "kind",
            "resourceUri",
            "resourceVersion",
        }
        or not {"kind", "resourceUri"}.issubset(value)
    ):
        raise _invalid("WORK_AUTOMATION_REFERENCE_INVALID", f"{field} has an unsupported shape")
    kind = _bounded_text(value.get("kind"), f"{field}.kind", 128)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", kind):
        raise _invalid("WORK_AUTOMATION_REFERENCE_INVALID", f"{field}.kind is invalid")
    result: JsonObject = {
        "kind": kind,
        "resourceUri": _safe_resource_uri(value.get("resourceUri"), f"{field}.resourceUri"),
        "resourceVersion": (
            _validate_resource_version(value.get("resourceVersion"), f"{field}.resourceVersion")
            if value.get("resourceVersion") is not None
            else None
        ),
    }
    return result


def _validate_experiment_put(value: Mapping[str, Any]) -> tuple[JsonObject, int]:
    """Normalize a strict reference-only experiment index update. | 校验实验引用更新。"""

    body = _json_object(value, "experiment")
    reference_fields = (
        "datasetVersion",
        "trainingRun",
        "trainingAttempt",
        "checkpointArtifactRef",
        "evaluationRun",
        "modelVersion",
        "deployment",
        "commit",
    )
    allowed = set(reference_fields) | {"expectedRevision"}
    if set(body) - allowed or "expectedRevision" not in body:
        raise _invalid(
            "WORK_EXPERIMENT_INVALID", "experiment contains unsupported or missing fields"
        )
    expected_revision = body.get("expectedRevision")
    if type(expected_revision) is not int or not 0 <= expected_revision <= 2**53 - 1:
        raise _invalid(
            "WORK_EXPERIMENT_INVALID", "expectedRevision must be a non-negative safe integer"
        )
    normalized: JsonObject = {}
    for field in reference_fields:
        item = body.get(field)
        if item is None:
            normalized[field] = None
        elif field == "checkpointArtifactRef":
            normalized[field] = _validate_artifact_reference(item)
        elif field == "commit":
            normalized[field] = _validate_commit_reference(item)
        else:
            normalized[field] = _automation_resource_reference(item, field)
    if len(_json_text(normalized).encode("utf-8")) > 100_000:
        raise _invalid("WORK_EXPERIMENT_INVALID", "experiment references exceed the size limit")
    return normalized, expected_revision


def _validate_artifact_reference(value: object) -> JsonObject:
    """Validate canonical Platform ArtifactRef metadata only. | 校验 ArtifactRef 元数据。"""

    required = {"uri", "digest", "size_bytes", "kind"}
    allowed = required | {"manifest_digest"}
    if not isinstance(value, Mapping) or not required.issubset(value) or set(value) - allowed:
        raise _invalid("WORK_EXPERIMENT_INVALID_REFERENCE", "checkpointArtifactRef is invalid")
    uri = _bounded_text(value.get("uri"), "checkpointArtifactRef.uri", 128)
    digest = _bounded_text(value.get("digest"), "checkpointArtifactRef.digest", 71)
    if (
        not re.fullmatch(r"artifact://sha256/[0-9a-f]{64}", uri)
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest)
        or uri.removeprefix("artifact://sha256/") != digest.removeprefix("sha256:")
    ):
        raise _invalid(
            "WORK_EXPERIMENT_INVALID_REFERENCE", "checkpointArtifactRef digest does not match"
        )
    size_bytes = value.get("size_bytes")
    if type(size_bytes) is not int or not 0 <= size_bytes <= 2**53 - 1:
        raise _invalid("WORK_EXPERIMENT_INVALID_REFERENCE", "checkpointArtifactRef size is invalid")
    kind = _bounded_text(value.get("kind"), "checkpointArtifactRef.kind", 128)
    result: JsonObject = {
        "uri": uri,
        "digest": digest,
        "size_bytes": size_bytes,
        "kind": kind,
    }
    manifest_digest = value.get("manifest_digest")
    if manifest_digest is not None:
        manifest = _bounded_text(manifest_digest, "checkpointArtifactRef.manifest_digest", 71)
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", manifest):
            raise _invalid(
                "WORK_EXPERIMENT_INVALID_REFERENCE",
                "checkpointArtifactRef manifest digest is invalid",
            )
        result["manifest_digest"] = manifest
    return result


def _validate_commit_reference(value: object) -> JsonObject:
    """Validate one repository URI and immutable Git object name. | 校验 Git 提交引用。"""

    if not isinstance(value, Mapping) or set(value) != {"repositoryUri", "sha"}:
        raise _invalid("WORK_EXPERIMENT_INVALID_REFERENCE", "commit reference is invalid")
    repository_uri = _safe_resource_uri(value.get("repositoryUri"), "commit.repositoryUri")
    sha = _bounded_text(value.get("sha"), "commit.sha", 64)
    if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", sha):
        raise _invalid(
            "WORK_EXPERIMENT_INVALID_REFERENCE", "commit sha must be a full Git object id"
        )
    return {"repositoryUri": repository_uri, "sha": sha}


def _safe_resource_uri(value: object, field: str) -> str:
    """Accept safe absolute references and reject credentials or query payloads. | 校验安全 URI。"""

    uri = _bounded_text(value, field, 2_000)
    if uri != uri.strip() or any(ch.isspace() or ord(ch) < 32 or ord(ch) == 127 for ch in uri):
        raise _invalid("WORK_AUTOMATION_REFERENCE_INVALID", f"{field} is not a safe URI")
    from urllib.parse import urlsplit

    try:
        parsed = urlsplit(uri)
        host = parsed.hostname
        _ = parsed.port
    except ValueError as exc:
        raise _invalid("WORK_AUTOMATION_REFERENCE_INVALID", f"{field} is not a safe URI") from exc
    scheme = parsed.scheme.lower()
    if (
        not re.fullmatch(r"[a-z][a-z0-9+.-]{0,31}", scheme)
        or scheme in {"data", "file", "javascript", "vbscript"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or (scheme in {"http", "https"} and not host)
        or (scheme not in {"http", "https"} and not (parsed.netloc or parsed.path))
    ):
        raise _invalid("WORK_AUTOMATION_REFERENCE_INVALID", f"{field} is not a safe URI")
    return uri


def _validate_resource_version(value: object, field: str) -> str | int:
    """Preserve a bounded integer or textual version without coercion. | 校验资源版本。"""

    if type(value) is int:
        if not 0 <= value <= 2**53 - 1:
            raise _invalid("WORK_AUTOMATION_REFERENCE_INVALID", f"{field} is out of range")
        return value
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise _invalid(
            "WORK_AUTOMATION_REFERENCE_INVALID", f"{field} must be bounded text or integer"
        )
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise _invalid("WORK_AUTOMATION_REFERENCE_INVALID", f"{field} contains control characters")
    return value


def _attention_kind_for_event_type(event_type: str) -> str | None:
    """Map a closed event-type vocabulary onto the immediate owner attention set."""

    normalized = event_type.lower().replace("-", "_").replace(".", "_")
    if "blocked" in normalized or "blocker" in normalized:
        return "blocked_goal"
    if "decision" in normalized or "approval" in normalized:
        return "user_decision"
    if "auth" in normalized or "outage" in normalized or "unavailable" in normalized:
        return "service_or_auth_outage"
    return None


def _is_weekday_digest_time(value: str) -> bool:
    """Require one exact 09:00 weekday occurrence in the persisted New York zone."""

    from datetime import datetime
    from zoneinfo import ZoneInfo

    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        local = timestamp.astimezone(ZoneInfo("America/New_York"))
    except (ValueError, OverflowError):
        return False
    return (
        timestamp.tzinfo is not None
        and local.weekday() < 5
        and local.hour == 9
        and local.minute == 0
        and local.second == 0
        and local.microsecond == 0
    )


def _timestamp_ms(value: str) -> int | None:
    """Convert one offset-aware ISO timestamp to milliseconds for digest windows."""

    from datetime import datetime

    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            return None
        return int(timestamp.timestamp() * 1_000)
    except (ValueError, OverflowError):
        return None


def _quiet_hours_release_ms(now_ms: int, quiet_hours: Mapping[str, Any]) -> int | None:
    """Defer non-immediate private notices until the stored quiet-hours end."""

    from datetime import datetime, timedelta
    from datetime import time as clock_time
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    def parse_clock(field: str) -> clock_time:
        value = quiet_hours.get(field)
        if not isinstance(value, str) or re.fullmatch(r"\d{2}:\d{2}", value) is None:
            raise PersistenceError(
                "WORK_STORAGE_CORRUPT", 500, "Stored V3 quiet-hours clock is invalid."
            )
        hour, minute = (int(part) for part in value.split(":"))
        if hour > 23 or minute > 59:
            raise PersistenceError(
                "WORK_STORAGE_CORRUPT", 500, "Stored V3 quiet-hours clock is invalid."
            )
        return clock_time(hour, minute)

    zone_name = quiet_hours.get("timeZone")
    if not isinstance(zone_name, str):
        raise PersistenceError(
            "WORK_STORAGE_CORRUPT", 500, "Stored V3 quiet-hours zone is invalid."
        )
    try:
        zone = ZoneInfo(zone_name)
    except ZoneInfoNotFoundError as exc:
        raise PersistenceError(
            "WORK_STORAGE_CORRUPT", 500, "Stored V3 quiet-hours zone is invalid."
        ) from exc
    start = parse_clock("start")
    end = parse_clock("end")
    local_now = datetime.fromtimestamp(now_ms / 1_000, tz=zone)
    current_clock = local_now.timetz().replace(tzinfo=None)
    if start == end:
        release_date = local_now.date() + timedelta(days=1)
    elif start < end:
        if not start <= current_clock < end:
            return None
        release_date = local_now.date()
    elif current_clock >= start:
        release_date = local_now.date() + timedelta(days=1)
    elif current_clock < end:
        release_date = local_now.date()
    else:
        return None
    release = datetime.combine(release_date, end, tzinfo=zone)
    return int(release.timestamp() * 1_000)


def _v3_occurrence_id(
    workflow_id: str, trigger_id: str, scheduled_at: str, created_by_actor_id: str
) -> str:
    """Salt V3 occurrence identity with the server-owned task actor. | actor 隔离调度实例。"""

    actor_ref = hashlib.sha256(created_by_actor_id.encode("utf-8")).hexdigest()[:16]
    return (
        "occ-"
        + hashlib.sha256(
            f"{workflow_id}\0{trigger_id}\0{scheduled_at}\0{actor_ref}".encode()
        ).hexdigest()[:40]
    )


def _source_poll_resource_uri(source: str, target_id: str) -> str:
    """Build the stable opaque resource identity used for source health state. | 固定来源标识。"""

    return f"cyrene://workflow-sources/{source}/{target_id}"


def _source_poll_failure_fingerprint(reason_code: str) -> str:
    """Fingerprint only the normalized fixed failure class, never provider text. | 失败类别指纹。"""

    return hashlib.sha256(f"cyrene.source-poll.failure.v1:{reason_code}".encode()).hexdigest()


def _source_poll_recovery_fingerprint() -> str:
    """Fingerprint the canonical healthy source state. | 恢复状态指纹。"""

    return hashlib.sha256(b"cyrene.source-poll.healthy.v1").hexdigest()


def _canonical_uuid(value: object, field: str) -> str:
    """Require a canonical UUID-shaped reference and normalize its case. | 规范 UUID。"""

    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        value,
    ):
        raise _invalid("WORK_INVALID_IDENTIFIER", f"{field} must be a UUID")
    return str(UUID(value))


def _is_uuid_text(value: str) -> bool:
    """Recognize a UUID-shaped immutable actor subject without raising. | UUID 格式检查。"""

    return (
        re.fullmatch(
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
            value,
        )
        is not None
    )


def _resolve_private_teams_route(
    conn: sqlite3.Connection,
    organization_id: str,
    workspace_id: str,
    owner_task_id: str,
    owner_actor_id: str,
    scope: PrivateConversationScope | None,
) -> JsonObject:
    """Resolve one current private route from an actor-owned verified Teams task."""

    if scope is None or scope.workspace_id != workspace_id:
        raise PersistenceError(
            "WORK_TEAMS_PRIVATE_INSTALLATION_FORBIDDEN",
            403,
            "The private Teams owner binding is unavailable or unauthorized.",
        )
    task_id = _identifier(owner_task_id, "ownerTaskId")
    actor = _identifier(owner_actor_id, "actorId")
    task = conn.execute(
        """SELECT created_by_actor_id FROM work_tasks
           WHERE organization_id=? AND workspace_id=? AND task_id=?""",
        (organization_id, workspace_id, task_id),
    ).fetchone()
    if task is None or str(task["created_by_actor_id"] or "").lower() != actor.lower():
        raise _not_found(
            "WORK_TASK_NOT_FOUND", "The owner task does not exist for this actor in this Workspace."
        )
    origin = conn.execute(
        """SELECT actor_id,actor_issuer,actor_subject,tenant_id,conversation_kind,bot_app_id
           FROM work_task_teams_origins
           WHERE organization_id=? AND workspace_id=? AND task_id=?""",
        (organization_id, workspace_id, task_id),
    ).fetchone()
    if origin is None:
        raise PersistenceError(
            "WORK_TEAMS_PRIVATE_INSTALLATION_FORBIDDEN",
            403,
            "The private Teams owner binding is unavailable or unauthorized.",
        )
    subject = str(origin["actor_subject"])
    tenant = str(origin["tenant_id"])
    if (
        str(origin["actor_id"]).lower() != actor.lower()
        or str(origin["actor_issuer"]) != scope.issuer
        or not _is_uuid_text(subject)
        or subject.lower() != actor.lower()
        or subject.lower() not in scope.owner_subjects
        or tenant.lower() != scope.tenant_id.lower()
        or (
            str(origin["conversation_kind"]) == "private"
            and (
                origin["bot_app_id"] is None
                or str(origin["bot_app_id"]).lower() != scope.bot_app_id.lower()
            )
        )
    ):
        raise PersistenceError(
            "WORK_TEAMS_PRIVATE_INSTALLATION_FORBIDDEN",
            403,
            "The private Teams owner binding is unavailable or unauthorized.",
        )
    row = conn.execute(
        """SELECT conversation_id,service_url,active FROM work_private_installations
           WHERE organization_id=? AND workspace_id=? AND tenant_id=?
             AND actor_aad_object_id=? AND bot_app_id=?""",
        (
            organization_id,
            workspace_id,
            scope.tenant_id.lower(),
            subject.lower(),
            scope.bot_app_id.lower(),
        ),
    ).fetchone()
    if row is None or not bool(row["active"]):
        raise _not_found(
            "WORK_TEAMS_PRIVATE_INSTALLATION_NOT_FOUND",
            "No active private Teams installation exists for this owner.",
        )
    return {
        "kind": "teams_personal",
        "tenantId": scope.tenant_id.lower(),
        "botAppId": scope.bot_app_id.lower(),
        "actorAadObjectId": subject.lower(),
        "conversationId": str(row["conversation_id"]),
        "serviceUrl": str(row["service_url"]),
    }


def _experiment_view(
    experiment_id: str,
    actor_id: str,
    organization_id: str,
    workspace_id: str,
    revision: int,
    updated_at: int,
    data: Mapping[str, Any],
) -> JsonObject:
    """Build the canonical owner-scoped experiment projection. | 构造实验公开视图。"""

    return {
        "experimentId": experiment_id,
        **dict(data),
        "actorId": actor_id,
        "organizationId": organization_id,
        "workspaceId": workspace_id,
        "revision": revision,
        "updatedAt": updated_at,
        "visibility": "owner",
    }


def _validate_workflow(workflow: Mapping[str, Any]) -> JsonObject:
    """Validate the intentionally generic DSH-owned workflow metadata. | 校验工作流定义。"""

    value = _json_object(workflow, "workflow")
    if value.get("version") == 2:
        return _validate_workflow_v2(value)
    if value.get("version") == 3:
        return _validate_workflow_v3(value)
    workflow_id = _identifier(value.get("id"), "workflow id")
    if value.get("version") != 1 or type(value.get("enabled")) is not bool:
        raise _invalid(
            "WORK_WORKFLOW_INVALID",
            "workflow version must be 1 and enabled must be boolean",
        )
    result: JsonObject = {
        "id": workflow_id,
        "version": 1,
        "title": _bounded_text(value.get("title"), "title", 512),
        "description": value.get("description", ""),
        "instructions": _bounded_text(value.get("instructions"), "instructions", 100_000),
        "targets": [],
        "notifications": {},
        "enabled": value["enabled"],
    }
    if not isinstance(result["description"], str) or len(result["description"]) > 20_000:
        raise _invalid("WORK_WORKFLOW_INVALID", "description must be bounded text")
    targets = value.get("targets")
    if not isinstance(targets, list) or len(targets) > 100:
        raise _invalid("WORK_WORKFLOW_INVALID", "targets must be an array with at most 100 entries")
    normalized_targets: list[JsonObject] = []
    for target in targets:
        if not isinstance(target, Mapping):
            raise _invalid("WORK_WORKFLOW_INVALID", "each target must be an object")
        normalized_targets.append(
            {
                "id": _identifier(target.get("id"), "target id"),
                "label": _bounded_text(target.get("label"), "target label", 512),
                "kind": _bounded_text(target.get("kind"), "target kind", 128),
                **(
                    {"bindingId": _identifier(target["bindingId"], "target bindingId")}
                    if target.get("bindingId")
                    else {}
                ),
                **(
                    {"uri": _bounded_text(target["uri"], "target uri", 2_000)}
                    if target.get("uri")
                    else {}
                ),
            }
        )
    notifications = value.get("notifications")
    if not isinstance(notifications, Mapping):
        raise _invalid("WORK_WORKFLOW_INVALID", "notifications is required")
    if any(
        type(notifications.get(key)) is not bool for key in ("onChange", "onFailure", "onRecovery")
    ):
        raise _invalid("WORK_WORKFLOW_INVALID", "notification preferences must be booleans")
    if notifications.get("quietWhenUnchanged") is not True:
        raise _invalid("WORK_WORKFLOW_INVALID", "quietWhenUnchanged must be true")
    result["targets"] = normalized_targets
    result["notifications"] = {
        "onChange": notifications["onChange"],
        "onFailure": notifications["onFailure"],
        "onRecovery": notifications["onRecovery"],
        "quietWhenUnchanged": True,
    }
    schedule = value.get("schedule")
    if schedule is not None:
        if not isinstance(schedule, Mapping) or schedule.get("kind") != "cron":
            raise _invalid("WORK_WORKFLOW_INVALID_SCHEDULE", "schedule.kind must be cron")
        expression = _bounded_text(schedule.get("expression"), "cron expression", 256)
        time_zone = _bounded_text(schedule.get("timeZone"), "timeZone", 128)
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        try:
            ZoneInfo(time_zone)
        except ZoneInfoNotFoundError as exc:
            raise _invalid(
                "WORK_WORKFLOW_INVALID_SCHEDULE", "timeZone must be a known IANA zone"
            ) from exc
        result["schedule"] = {
            "kind": "cron",
            "expression": expression,
            "timeZone": time_zone,
        }
    return result


def _validate_workflow_v3(value: Mapping[str, Any]) -> JsonObject:
    """Validate the negotiated typed source-poll workflow contract. | 校验 v3 轮询定义。"""

    allowed = {
        "id",
        "version",
        "title",
        "description",
        "targets",
        "triggers",
        "authorization",
        "notifications",
        "enabled",
        "updatedAt",
    }
    if set(value) - allowed or value.get("version") != 3 or type(value.get("enabled")) is not bool:
        raise _invalid(
            "WORK_WORKFLOW_V3_INVALID", "workflow v3 has an unsupported field or version"
        )
    description = value.get("description", "")
    if not isinstance(description, str) or len(description) > 20_000:
        raise _invalid("WORK_WORKFLOW_V3_INVALID", "description must be bounded text")
    result: JsonObject = {
        "id": _identifier(value.get("id"), "workflow id"),
        "version": 3,
        "title": _bounded_text(value.get("title"), "title", 512),
        "description": description,
        "enabled": value["enabled"],
    }

    targets = value.get("targets")
    if not isinstance(targets, list) or not 1 <= len(targets) <= 100:
        raise _invalid("WORK_WORKFLOW_V3_TARGET_INVALID", "v3 requires 1 to 100 host-bound targets")
    target_by_id: dict[str, JsonObject] = {}
    normalized_targets: list[JsonObject] = []
    allowed_target_kinds = {
        "github_repository",
        "pipeline_runs",
        "release_deployments",
        "planner_plan",
        "host_health",
        "training_run",
        "product_resource",
    }
    for target in targets:
        required_target = {"id", "label", "kind", "bindingId"}
        if (
            not isinstance(target, Mapping)
            or not required_target.issubset(target)
            or set(target) - (required_target | {"uri"})
        ):
            raise _invalid("WORK_WORKFLOW_V3_TARGET_INVALID", "target fields are invalid")
        target_id = _identifier(target.get("id"), "target id")
        label = _bounded_text(target.get("label"), "target label", 512)
        kind = target.get("kind")
        if kind not in allowed_target_kinds:
            raise _invalid("WORK_WORKFLOW_V3_TARGET_INVALID", "target kind is not supported")
        binding_id = _identifier(target.get("bindingId"), "target bindingId")
        normalized_target: JsonObject = {
            "id": target_id,
            "label": label,
            "kind": kind,
            "bindingId": binding_id,
        }
        uri_value = target.get("uri")
        if kind == "github_repository":
            if (
                not target_id.isdigit()
                or not re.fullmatch(r"[^/\s]+/[^/\s]+", label)
                or uri_value != f"https://github.com/{label}"
            ):
                raise _invalid(
                    "WORK_WORKFLOW_V3_TARGET_INVALID",
                    "GitHub target must match the configured owner/repository reference.",
                )
            normalized_target["uri"] = _safe_resource_uri(uri_value, "target.uri")
        elif uri_value is not None:
            raise _invalid(
                "WORK_WORKFLOW_V3_TARGET_INVALID",
                "Only the canonical GitHub repository target may contain a URI.",
            )
        if target_id in target_by_id:
            raise _invalid("WORK_WORKFLOW_V3_TARGET_INVALID", "target ids must be unique")
        target_by_id[target_id] = normalized_target
        normalized_targets.append(normalized_target)
    result["targets"] = normalized_targets

    triggers = value.get("triggers")
    if not isinstance(triggers, list) or not 1 <= len(triggers) <= 100:
        raise _invalid("WORK_WORKFLOW_V3_TRIGGER_INVALID", "v3 requires 1 to 100 source polls")
    supported_sources = {
        "github",
        "azure_devops",
        "office_graph",
        "vm_health",
        "training",
        "product",
    }
    target_kinds_by_source = {
        "github": {"github_repository"},
        "azure_devops": {"pipeline_runs", "release_deployments"},
        "office_graph": {"planner_plan"},
        "vm_health": {"host_health"},
        "training": {"training_run"},
        "product": {"product_resource"},
    }
    normalized_triggers: list[JsonObject] = []
    trigger_ids: set[str] = set()
    for trigger in triggers:
        required_trigger = {"id", "kind", "source", "targetIds", "schedule"}
        optional_trigger = {"initialBaseline", "pageSize", "maxPages"}
        if (
            not isinstance(trigger, Mapping)
            or not required_trigger.issubset(trigger)
            or set(trigger) - required_trigger - optional_trigger
        ):
            raise _invalid("WORK_WORKFLOW_V3_TRIGGER_INVALID", "source poll fields are invalid")
        trigger_id = _identifier(trigger.get("id"), "trigger id")
        source = trigger.get("source")
        if trigger.get("kind") != "source_poll" or source not in supported_sources:
            raise _invalid("WORK_WORKFLOW_V3_TRIGGER_INVALID", "source poll kind is unsupported")
        if trigger_id in trigger_ids:
            raise _invalid("WORK_WORKFLOW_V3_TRIGGER_INVALID", "trigger ids must be unique")
        trigger_ids.add(trigger_id)
        target_ids_value = trigger.get("targetIds")
        if not isinstance(target_ids_value, list) or not 1 <= len(target_ids_value) <= 20:
            raise _invalid(
                "WORK_WORKFLOW_V3_TRIGGER_INVALID", "targetIds must contain 1 to 20 targets"
            )
        target_ids = [_identifier(item, "trigger target id") for item in target_ids_value]
        if len(set(target_ids)) != len(target_ids) or any(
            item not in target_by_id for item in target_ids
        ):
            raise _invalid(
                "WORK_WORKFLOW_V3_TRIGGER_INVALID",
                "targetIds must reference unique configured targets",
            )
        if any(
            target_by_id[item]["kind"] not in target_kinds_by_source[source] for item in target_ids
        ):
            raise _invalid(
                "WORK_WORKFLOW_V3_TRIGGER_INVALID",
                "source poll target kinds do not match the selected source",
            )
        schedule = _validate_workflow_schedule(trigger.get("schedule"))
        interval = (
            "*/5 * * * *" if source in {"github", "azure_devops", "office_graph"} else "* * * * *"
        )
        if schedule != {"kind": "cron", "expression": interval, "timeZone": "UTC"}:
            raise _invalid(
                "WORK_WORKFLOW_V3_TRIGGER_INVALID",
                "the source schedule does not match its approved UTC polling interval",
            )
        baseline = trigger.get("initialBaseline", "record_without_notification")
        if baseline != "record_without_notification":
            raise _invalid(
                "WORK_WORKFLOW_V3_TRIGGER_INVALID", "initial source polls must be quiet baselines"
            )
        page_size = trigger.get("pageSize", 50)
        max_pages = trigger.get("maxPages", 20)
        if type(page_size) is not int or not 1 <= page_size <= 50:
            raise _invalid("WORK_WORKFLOW_V3_TRIGGER_INVALID", "pageSize must be 1 to 50")
        if type(max_pages) is not int or not 1 <= max_pages <= 20:
            raise _invalid("WORK_WORKFLOW_V3_TRIGGER_INVALID", "maxPages must be 1 to 20")
        if page_size * max_pages > 1_000:
            raise _invalid(
                "WORK_WORKFLOW_V3_TRIGGER_INVALID",
                "one source poll cannot exceed 1,000 bounded provider records",
            )
        normalized_triggers.append(
            {
                "id": trigger_id,
                "kind": "source_poll",
                "source": source,
                "targetIds": target_ids,
                "schedule": schedule,
                "initialBaseline": baseline,
                "pageSize": page_size,
                "maxPages": max_pages,
            }
        )
    result["triggers"] = normalized_triggers

    authorization = value.get("authorization")
    if not isinstance(authorization, Mapping):
        raise _invalid("WORK_WORKFLOW_V3_AUTHORIZATION_INVALID", "authorization is required")
    if authorization.get("kind") == "owner_private" and set(authorization) == {
        "kind",
        "ownerTaskId",
    }:
        normalized_authorization = {
            "kind": "owner_private",
            "ownerTaskId": _identifier(authorization.get("ownerTaskId"), "ownerTaskId"),
        }
    else:
        raise _invalid(
            "WORK_WORKFLOW_V3_AUTHORIZATION_INVALID",
            "source-poll workflow authorization must use the verified owner_private route",
        )
    notifications = _validate_workflow_notifications_v3(value.get("notifications"))
    if notifications["destination"]["kind"] != "owner_private":
        raise _invalid(
            "WORK_WORKFLOW_V3_NOTIFICATIONS_INVALID",
            "authorization and notification destination kinds must match",
        )
    result["authorization"] = normalized_authorization
    result["notifications"] = notifications
    if value["enabled"] and not normalized_targets:
        raise _invalid("WORK_WORKFLOW_V3_INVALID", "enabled source polls require targets")
    if value.get("updatedAt") is not None:
        result["updatedAt"] = _bounded_text(value["updatedAt"], "updatedAt", 128)
    return result


def _validate_workflow_notifications_v3(value: object) -> JsonObject:
    """Validate V3 notification policy and its weekday digest schedule. | 校验 v3 通知。"""

    if not isinstance(value, Mapping):
        raise _invalid("WORK_WORKFLOW_V3_NOTIFICATIONS_INVALID", "notifications are required")
    destination = value.get("destination")
    if (
        not isinstance(destination, Mapping)
        or set(destination) != {"kind"}
        or destination.get("kind") != "owner_private"
    ):
        raise _invalid("WORK_WORKFLOW_V3_NOTIFICATIONS_INVALID", "destination kind is unsupported")
    normalized_input = dict(value)
    normalized_input["destination"] = {"kind": "responsibility_thread"}
    result = _validate_workflow_notifications_v2(normalized_input)
    schedule = result["digest"]["schedule"]
    if schedule != {
        "kind": "cron",
        "expression": "0 9 * * 1-5",
        "timeZone": "America/New_York",
    }:
        raise _invalid(
            "WORK_WORKFLOW_V3_NOTIFICATIONS_INVALID",
            "V3 digest must run at 09:00 on weekdays in America/New_York",
        )
    result["destination"] = {"kind": destination["kind"]}
    return result


def _validate_workflow_v2(value: Mapping[str, Any]) -> JsonObject:
    """Validate a host-managed proactive responsibility and its exact action scopes.

    Args:
        value: V2 workflow document using the published camelCase contract.
    Returns:
        A normalized JSON-safe record with no unrecognized policy fields.
    Raises:
        PersistenceError: If a trigger, model route, notification rule, or action scope is invalid.

    中文：校验主动责任定义，并拒绝未识别字段和未绑定目标的操作授权。
    """

    allowed = {
        "id",
        "version",
        "title",
        "description",
        "goal",
        "instructions",
        "targets",
        "triggers",
        "actionPolicy",
        "modelPolicy",
        "authorization",
        "notifications",
        "enabled",
        "updatedAt",
    }
    if set(value) - allowed or value.get("version") != 2 or type(value.get("enabled")) is not bool:
        raise _invalid(
            "WORK_WORKFLOW_V2_INVALID", "workflow v2 has an unsupported field or version"
        )
    result: JsonObject = {
        "id": _identifier(value.get("id"), "workflow id"),
        "version": 2,
        "title": _bounded_text(value.get("title"), "title", 512),
        "description": value.get("description", ""),
        "goal": _bounded_text(value.get("goal"), "goal", 20_000),
        "instructions": _bounded_text(value.get("instructions"), "instructions", 100_000),
        "enabled": value["enabled"],
    }
    if not isinstance(result["description"], str) or len(result["description"]) > 20_000:
        raise _invalid("WORK_WORKFLOW_V2_INVALID", "description must be bounded text")

    targets = value.get("targets")
    if not isinstance(targets, list) or len(targets) > 100:
        raise _invalid(
            "WORK_WORKFLOW_V2_INVALID", "targets must be an array with at most 100 entries"
        )
    normalized_targets: list[JsonObject] = []
    target_by_id: dict[str, JsonObject] = {}
    for target in targets:
        if not isinstance(target, Mapping) or set(target) - {
            "id",
            "label",
            "kind",
            "uri",
            "bindingId",
        }:
            raise _invalid("WORK_WORKFLOW_V2_INVALID", "each target must use the supported fields")
        target_id = _identifier(target.get("id"), "target id")
        label = _bounded_text(target.get("label"), "target label", 512)
        kind = _bounded_text(target.get("kind"), "target kind", 128)
        normalized: JsonObject = {"id": target_id, "label": label, "kind": kind}
        if target.get("bindingId") is not None:
            normalized["bindingId"] = _identifier(target["bindingId"], "target bindingId")
        uri_value = target.get("uri")
        if uri_value is not None:
            uri = _bounded_text(uri_value, "target uri", 2_000)
            from urllib.parse import urlsplit

            parsed = urlsplit(uri)
            if parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise _invalid(
                    "WORK_WORKFLOW_V2_TARGET_INVALID",
                    "target URI cannot contain credentials or query data",
                )
            if parsed.scheme != "https" or not parsed.netloc:
                raise _invalid("WORK_WORKFLOW_V2_TARGET_INVALID", "target URI must use HTTPS")
            normalized["uri"] = uri
        if kind == "github_repository":
            if (
                not target_id.isdigit()
                or not re.fullmatch(r"[^/\s]+/[^/\s]+", label)
                or "bindingId" not in normalized
            ):
                raise _invalid(
                    "WORK_WORKFLOW_V2_TARGET_INVALID",
                    "GitHub target requires numeric id, owner/repo label, and connector binding",
                )
            if normalized.get("uri") != f"https://github.com/{label}":
                raise _invalid(
                    "WORK_WORKFLOW_V2_TARGET_INVALID",
                    "GitHub target URI must match owner/repo label",
                )
        if target_id in target_by_id:
            raise _invalid("WORK_WORKFLOW_V2_TARGET_INVALID", "target ids must be unique")
        normalized_targets.append(normalized)
        target_by_id[target_id] = normalized
    result["targets"] = normalized_targets

    triggers = value.get("triggers")
    if not isinstance(triggers, list) or not 1 <= len(triggers) <= 100:
        raise _invalid(
            "WORK_WORKFLOW_V2_TRIGGER_INVALID", "at least one supported trigger is required"
        )
    normalized_triggers: list[JsonObject] = []
    trigger_ids: set[str] = set()
    for trigger in triggers:
        if not isinstance(trigger, Mapping) or set(trigger) - {
            "id",
            "kind",
            "schedule",
            "targetIds",
            "initialBaseline",
            "search",
        }:
            raise _invalid("WORK_WORKFLOW_V2_TRIGGER_INVALID", "trigger uses unsupported fields")
        trigger_id = _identifier(trigger.get("id"), "trigger id")
        trigger_kind = trigger.get("kind")
        if (
            trigger_id in trigger_ids
            or trigger_id == "daily-digest"
            or trigger_kind not in {"github_incremental_poll", "review"}
        ):
            raise _invalid("WORK_WORKFLOW_V2_TRIGGER_INVALID", "trigger id or kind is invalid")
        trigger_ids.add(trigger_id)
        schedule = _validate_workflow_schedule(trigger.get("schedule"))
        trigger_targets = trigger.get("targetIds", [])
        if not isinstance(trigger_targets, list) or len(trigger_targets) > 100:
            raise _invalid(
                "WORK_WORKFLOW_V2_TRIGGER_INVALID", "trigger targetIds must be a bounded array"
            )
        target_ids = [_identifier(item, "trigger target id") for item in trigger_targets]
        if len(set(target_ids)) != len(target_ids) or any(
            item not in target_by_id for item in target_ids
        ):
            raise _invalid(
                "WORK_WORKFLOW_V2_TRIGGER_INVALID",
                "trigger targetIds must reference unique configured targets",
            )
        if trigger_kind == "github_incremental_poll" and (
            not target_ids
            or any(target_by_id[item]["kind"] != "github_repository" for item in target_ids)
        ):
            raise _invalid(
                "WORK_WORKFLOW_V2_TRIGGER_INVALID",
                "GitHub polling requires GitHub repository targets",
            )
        search = trigger.get("search")
        normalized_search: JsonObject | None = None
        if trigger_kind == "github_incremental_poll":
            if (
                not isinstance(search, Mapping)
                or set(search) - {"state", "query", "labels", "limit"}
                or not {"state", "labels", "limit"}.issubset(search)
            ):
                raise _invalid(
                    "WORK_WORKFLOW_V2_TRIGGER_INVALID",
                    "GitHub polling requires safe typed search filters",
                )
            state = search.get("state")
            if state not in {"open", "closed", "all"}:
                raise _invalid(
                    "WORK_WORKFLOW_V2_TRIGGER_INVALID", "GitHub search state is not supported"
                )
            query = search.get("query")
            if query is not None:
                query = _bounded_text(query, "GitHub search query", 256)
                if re.search(
                    r"(?:^|\s)(?:repo|is|label|state|updated|author|assignee|milestone):",
                    query,
                    re.I,
                ):
                    raise _invalid(
                        "WORK_WORKFLOW_V2_TRIGGER_INVALID",
                        "GitHub search query cannot contain qualifiers",
                    )
            labels = search.get("labels")
            if not isinstance(labels, list) or len(labels) > 10:
                raise _invalid(
                    "WORK_WORKFLOW_V2_TRIGGER_INVALID",
                    "GitHub search labels are bounded to ten entries",
                )
            normalized_labels = [
                _bounded_text(label, "GitHub search label", 128) for label in labels
            ]
            if len(set(normalized_labels)) != len(normalized_labels):
                raise _invalid(
                    "WORK_WORKFLOW_V2_TRIGGER_INVALID", "GitHub search labels must be unique"
                )
            limit = search.get("limit")
            if type(limit) is not int or not 1 <= limit <= 50:
                raise _invalid(
                    "WORK_WORKFLOW_V2_TRIGGER_INVALID", "GitHub search page size must be 1 to 50"
                )
            normalized_search = {"state": state, "labels": normalized_labels, "limit": limit}
            if query is not None:
                normalized_search["query"] = query
        elif search is not None:
            raise _invalid(
                "WORK_WORKFLOW_V2_TRIGGER_INVALID",
                "Only GitHub polling triggers can contain search filters",
            )
        baseline = trigger.get("initialBaseline", "record_without_notification")
        if baseline != "record_without_notification":
            raise _invalid(
                "WORK_WORKFLOW_V2_TRIGGER_INVALID", "initial scans must establish a quiet baseline"
            )
        normalized_trigger: JsonObject = {
            "id": trigger_id,
            "kind": trigger_kind,
            "schedule": schedule,
            "targetIds": target_ids,
            "initialBaseline": baseline,
        }
        if normalized_search is not None:
            normalized_trigger["search"] = normalized_search
        normalized_triggers.append(normalized_trigger)
    result["triggers"] = normalized_triggers

    action_policy = value.get("actionPolicy")
    if not isinstance(action_policy, Mapping) or set(action_policy) - {
        "allowedActions",
        "separateChildTask",
        "productionChanges",
        "requiresUserAuthorization",
    }:
        raise _invalid(
            "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID",
            "actionPolicy is required and must use supported fields",
        )
    grants = action_policy.get("allowedActions", [])
    if not isinstance(grants, list) or len(grants) > 100:
        raise _invalid(
            "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID", "allowedActions must be a bounded array"
        )
    normalized_grants: list[JsonObject] = []
    grant_ids: set[str] = set()
    permitted_by_action = {
        "draft_pull_request": {
            "github.branch.create",
            "github.branch.delete",
            "github.file.commit",
            "github.pull_request.draft.create",
        },
        "rerun_source_ci": {"github.actions.rerun_failed"},
        "update_issue_progress": {"github.issue.comment.create", "github.issue.state.update"},
    }
    known_operations = set().union(*permitted_by_action.values())
    for grant in grants:
        required = {"id", "action", "targetIds", "permittedOperations", "sourceWorkflowIds"}
        optional = {"baseBranches", "branchPrefixes", "pathPrefixes", "issueNumbers"}
        if (
            not isinstance(grant, Mapping)
            or not required.issubset(grant)
            or set(grant) - required - optional
        ):
            raise _invalid(
                "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID", "action grant fields are invalid"
            )
        grant_id = _identifier(grant.get("id"), "action grant id")
        action = grant.get("action")
        grant_target_ids = grant.get("targetIds")
        operations = grant.get("permittedOperations")
        if (
            grant_id in grant_ids
            or action not in permitted_by_action
            or not isinstance(grant_target_ids, list)
            or not grant_target_ids
        ):
            raise _invalid(
                "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID",
                "action grant id, action, or targetIds are invalid",
            )
        grant_ids.add(grant_id)
        normalized_target_ids = [_identifier(item, "action target id") for item in grant_target_ids]
        if len(set(normalized_target_ids)) != len(normalized_target_ids) or any(
            item not in target_by_id or target_by_id[item]["kind"] != "github_repository"
            for item in normalized_target_ids
        ):
            raise _invalid(
                "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID",
                "actions must bind unique configured GitHub repositories",
            )
        if not isinstance(operations, list) or not operations or len(operations) > 20:
            raise _invalid(
                "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID",
                "permittedOperations must be a non-empty array",
            )
        normalized_operations = [
            _bounded_text(item, "permitted operation", 128) for item in operations
        ]
        if len(set(normalized_operations)) != len(normalized_operations) or not set(
            normalized_operations
        ).issubset(permitted_by_action[action] & known_operations):
            raise _invalid(
                "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID",
                "operation id is not permitted for this action",
            )
        base_branches = _workflow_text_list(grant.get("baseBranches", []), "baseBranches", 256)
        branch_prefixes = _workflow_text_list(
            grant.get("branchPrefixes", []), "branchPrefixes", 256
        )
        path_prefixes = _workflow_text_list(grant.get("pathPrefixes", []), "pathPrefixes", 512)
        source_workflow_ids = _workflow_text_list(
            grant.get("sourceWorkflowIds"), "sourceWorkflowIds", 20
        )
        if len(set(source_workflow_ids)) != len(source_workflow_ids) or any(
            not re.fullmatch(r"[1-9][0-9]{0,19}", item) for item in source_workflow_ids
        ):
            raise _invalid(
                "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID",
                "sourceWorkflowIds must contain unique numeric workflow ids",
            )
        issue_numbers_raw = grant.get("issueNumbers", [])
        if not isinstance(issue_numbers_raw, list) or len(issue_numbers_raw) > 10_000:
            raise _invalid(
                "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID", "issueNumbers must be a bounded array"
            )
        if any(type(number) is not int or number < 1 for number in issue_numbers_raw):
            raise _invalid(
                "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID",
                "issueNumbers must contain positive integers",
            )
        issue_numbers = sorted(set(issue_numbers_raw))
        if action == "draft_pull_request":
            if (
                not {
                    "github.branch.create",
                    "github.file.commit",
                    "github.pull_request.draft.create",
                }.issubset(normalized_operations)
                or not base_branches
                or not branch_prefixes
                or not path_prefixes
                or issue_numbers
                or source_workflow_ids
                or any(not _valid_assistant_branch_prefix(item) for item in branch_prefixes)
            ):
                raise _invalid(
                    "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID",
                    "draft PR grants require exact branch, base, path, and operation scope",
                )
        elif action == "rerun_source_ci":
            if (
                normalized_operations != ["github.actions.rerun_failed"]
                or base_branches
                or path_prefixes
                or issue_numbers
                or not branch_prefixes
                or not source_workflow_ids
                or any(not _valid_assistant_branch_prefix(item) for item in branch_prefixes)
            ):
                raise _invalid(
                    "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID",
                    "CI rerun grants must bind source workflows and assistant branches",
                )
        elif action == "update_issue_progress" and (
            not issue_numbers
            or not set(normalized_operations).issubset(
                {"github.issue.comment.create", "github.issue.state.update"}
            )
            or any((base_branches, branch_prefixes, path_prefixes))
            or source_workflow_ids
        ):
            raise _invalid(
                "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID",
                "issue progress grants require exact issue numbers",
            )
        normalized_grants.append(
            {
                "id": grant_id,
                "action": action,
                "targetIds": normalized_target_ids,
                "baseBranches": base_branches,
                "branchPrefixes": branch_prefixes,
                "pathPrefixes": path_prefixes,
                "issueNumbers": issue_numbers,
                "sourceWorkflowIds": sorted(source_workflow_ids),
                "permittedOperations": normalized_operations,
            }
        )
    if (
        action_policy.get("separateChildTask", True) is not True
        or action_policy.get("productionChanges", "forbidden") != "forbidden"
    ):
        raise _invalid(
            "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID",
            "actions must use separate child tasks and forbid production changes",
        )
    authorization_required = action_policy.get(
        "requiresUserAuthorization", ["merge", "release", "production", "new_spend"]
    )
    if authorization_required != ["merge", "release", "production", "new_spend"]:
        raise _invalid(
            "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID",
            "merge, release, production, and new spend require user authorization",
        )
    result["actionPolicy"] = {
        "allowedActions": normalized_grants,
        "separateChildTask": True,
        "productionChanges": "forbidden",
        "requiresUserAuthorization": authorization_required,
    }

    model_policy = value.get("modelPolicy")
    if not isinstance(model_policy, Mapping) or set(model_policy) != {
        "preferredProvider",
        "preferredModel",
        "fallback",
    }:
        raise _invalid(
            "WORK_WORKFLOW_V2_MODEL_POLICY_INVALID",
            "modelPolicy must use the supported model route fields",
        )
    if model_policy.get("preferredProvider") not in {"antigravity", "codebuddy", "exchange"}:
        raise _invalid("WORK_WORKFLOW_V2_MODEL_POLICY_INVALID", "preferredProvider is unsupported")
    if model_policy.get("fallback") != "configured_no_additional_spend":
        raise _invalid(
            "WORK_WORKFLOW_V2_MODEL_POLICY_INVALID",
            "model fallback must stay within configured no-additional-spend routes",
        )
    result["modelPolicy"] = {
        "preferredProvider": model_policy["preferredProvider"],
        "preferredModel": _bounded_text(model_policy.get("preferredModel"), "preferredModel", 256),
        "fallback": "configured_no_additional_spend",
    }

    authorization = value.get("authorization")
    if (
        not isinstance(authorization, Mapping)
        or set(authorization) != {"kind", "threadBindingId", "ownerTaskId"}
        or authorization.get("kind") != "teams_thread"
    ):
        raise _invalid(
            "WORK_WORKFLOW_V2_AUTHORIZATION_INVALID",
            "authorization must bind an owner Teams thread",
        )
    result["authorization"] = {
        "kind": "teams_thread",
        "threadBindingId": _identifier(authorization.get("threadBindingId"), "threadBindingId"),
        "ownerTaskId": _identifier(authorization.get("ownerTaskId"), "ownerTaskId"),
    }

    result["notifications"] = _validate_workflow_notifications_v2(value.get("notifications"))
    if value["enabled"] and not normalized_targets:
        raise _invalid(
            "WORK_WORKFLOW_V2_INVALID", "enabled responsibilities require at least one target"
        )
    if value.get("updatedAt") is not None:
        result["updatedAt"] = _bounded_text(value["updatedAt"], "updatedAt", 128)
    return result


def _validate_workflow_schedule(value: object) -> JsonObject:
    """Validate one cron value stored for DSH Schedule. | 校验 DSH cron 配置。"""

    if (
        not isinstance(value, Mapping)
        or set(value) != {"kind", "expression", "timeZone"}
        or value.get("kind") != "cron"
    ):
        raise _invalid(
            "WORK_WORKFLOW_V2_TRIGGER_INVALID",
            "schedule must contain cron expression and IANA timezone",
        )
    expression = _bounded_text(value.get("expression"), "cron expression", 256)
    time_zone = _bounded_text(value.get("timeZone"), "timeZone", 128)
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        ZoneInfo(time_zone)
    except ZoneInfoNotFoundError as exc:
        raise _invalid(
            "WORK_WORKFLOW_V2_TRIGGER_INVALID", "timeZone must be a known IANA zone"
        ) from exc
    return {"kind": "cron", "expression": expression, "timeZone": time_zone}


def _workflow_text_list(value: object, field: str, maximum: int) -> list[str]:
    """Normalize one bounded unique text allowlist. | 规范去重后的文本范围列表。"""

    if not isinstance(value, list) or len(value) > 100:
        raise _invalid("WORK_WORKFLOW_V2_ACTION_POLICY_INVALID", f"{field} must be a bounded array")
    normalized = [_bounded_text(item, field, maximum) for item in value]
    if len(set(normalized)) != len(normalized):
        raise _invalid("WORK_WORKFLOW_V2_ACTION_POLICY_INVALID", f"{field} entries must be unique")
    if field == "pathPrefixes" and any(
        item != "**"
        and (item.startswith("/") or ".." in item.split("/") or "\\" in item or "*" in item)
        for item in normalized
    ):
        raise _invalid(
            "WORK_WORKFLOW_V2_ACTION_POLICY_INVALID",
            "pathPrefixes must be repository-relative literal prefixes or the exact ** sentinel",
        )
    return normalized


def _valid_assistant_branch_prefix(value: str) -> bool:
    """Keep autonomous grants under the assistant namespace. | 限定助手分支范围。"""

    return (
        value.startswith("cyrene/assistant/")
        and "\\" not in value
        and not any(character.isspace() for character in value)
        and ".." not in value.split("/")
    )


def _validate_workflow_notifications_v2(value: object) -> JsonObject:
    """Validate quiet hours and the once-per-day digest policy. | 校验静默时段与摘要策略。"""

    if not isinstance(value, Mapping) or set(value) != {
        "onChange",
        "onFailure",
        "onRecovery",
        "quietWhenUnchanged",
        "quietHours",
        "digest",
        "destination",
        "immediateOn",
    }:
        raise _invalid(
            "WORK_WORKFLOW_V2_NOTIFICATIONS_INVALID", "v2 notifications have an unsupported shape"
        )
    if (
        any(type(value.get(key)) is not bool for key in ("onChange", "onFailure", "onRecovery"))
        or value.get("quietWhenUnchanged") is not True
    ):
        raise _invalid(
            "WORK_WORKFLOW_V2_NOTIFICATIONS_INVALID",
            "notification transition preferences are invalid",
        )
    quiet_hours = value.get("quietHours")
    if not isinstance(quiet_hours, Mapping) or set(quiet_hours) != {"start", "end", "timeZone"}:
        raise _invalid("WORK_WORKFLOW_V2_NOTIFICATIONS_INVALID", "quietHours are invalid")
    for field in ("start", "end"):
        if not isinstance(quiet_hours.get(field), str) or not re.fullmatch(
            r"(?:[01]\d|2[0-3]):[0-5]\d", quiet_hours[field]
        ):
            raise _invalid("WORK_WORKFLOW_V2_NOTIFICATIONS_INVALID", "quiet hours must use HH:MM")
    quiet_zone = _bounded_text(quiet_hours.get("timeZone"), "quietHours.timeZone", 128)
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        ZoneInfo(quiet_zone)
    except ZoneInfoNotFoundError as exc:
        raise _invalid(
            "WORK_WORKFLOW_V2_NOTIFICATIONS_INVALID",
            "quietHours.timeZone must be a known IANA zone",
        ) from exc
    digest_policy = value.get("digest")
    if not isinstance(digest_policy, Mapping) or set(digest_policy) != {
        "enabled",
        "schedule",
        "maxPerDay",
    }:
        raise _invalid("WORK_WORKFLOW_V2_NOTIFICATIONS_INVALID", "digest policy is invalid")
    if type(digest_policy.get("enabled")) is not bool or digest_policy.get("maxPerDay") != 1:
        raise _invalid(
            "WORK_WORKFLOW_V2_NOTIFICATIONS_INVALID",
            "digest is limited to one notification per day",
        )
    destination = value.get("destination")
    if not isinstance(destination, Mapping) or dict(destination) != {
        "kind": "responsibility_thread"
    }:
        raise _invalid(
            "WORK_WORKFLOW_V2_NOTIFICATIONS_INVALID",
            "destination must be the responsibility root thread",
        )
    immediate_on = value.get("immediateOn")
    allowed_immediate = {"blocked_goal", "user_decision", "service_or_auth_outage"}
    if not isinstance(immediate_on, list) or not set(immediate_on).issubset(allowed_immediate):
        raise _invalid(
            "WORK_WORKFLOW_V2_NOTIFICATIONS_INVALID", "immediateOn contains an unsupported event"
        )
    if len(set(immediate_on)) != len(immediate_on):
        raise _invalid(
            "WORK_WORKFLOW_V2_NOTIFICATIONS_INVALID", "immediateOn entries must be unique"
        )
    return {
        "onChange": value["onChange"],
        "onFailure": value["onFailure"],
        "onRecovery": value["onRecovery"],
        "quietWhenUnchanged": True,
        "quietHours": {
            "start": quiet_hours["start"],
            "end": quiet_hours["end"],
            "timeZone": quiet_zone,
        },
        "digest": {
            "enabled": digest_policy["enabled"],
            "schedule": _validate_workflow_schedule(digest_policy["schedule"]),
            "maxPerDay": 1,
        },
        "destination": {"kind": "responsibility_thread"},
        "immediateOn": immediate_on,
    }


def _validate_schedule_event(event: Mapping[str, Any]) -> JsonObject:
    """Validate one output-only schedule execution history row. | 校验调度执行记录。"""

    value = _json_object(event, "schedule event")
    result: JsonObject = {
        "id": _identifier(value.get("id"), "event id"),
        "workflowId": _identifier(value.get("workflowId"), "workflowId"),
        "scheduledAt": _bounded_text(value.get("scheduledAt"), "scheduledAt", 128),
        "status": value.get("status"),
        "createdAt": _bounded_text(value.get("createdAt"), "createdAt", 128),
    }
    if result["status"] not in {"queued", "running", "succeeded", "failed"}:
        raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "status is not valid")
    for key in ("startedAt", "endedAt"):
        if value.get(key) is not None:
            result[key] = _bounded_text(value[key], key, 128)
    if value.get("changed") is not None:
        if type(value["changed"]) is not bool:
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "changed must be a boolean")
        result["changed"] = value["changed"]
    for key, limit in (
        ("summary", 2_000),
        ("errorCode", 256),
        ("taskId", 512),
        ("sessionId", 512),
        ("triggerId", 128),
    ):
        if value.get(key) is not None:
            result[key] = _bounded_text(value[key], key, limit)
    if value.get("baseline") is not None:
        if type(value["baseline"]) is not bool:
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "baseline must be a boolean")
        result["baseline"] = value["baseline"]
    evidence = value.get("evidence", [])
    if not isinstance(evidence, list) or len(evidence) > 1_000:
        raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "evidence must be a bounded array")
    normalized_evidence: list[JsonObject] = []
    for item in evidence:
        if not isinstance(item, Mapping) or set(item) != {
            "targetId",
            "tool",
            "observedAt",
            "resultDigest",
        }:
            raise _invalid(
                "WORK_SCHEDULE_INVALID_EVENT", "evidence pointers must use the metadata-only schema"
            )
        result_digest = _bounded_text(item.get("resultDigest"), "evidence.resultDigest", 64)
        if not re.fullmatch(r"[a-f0-9]{64}", result_digest):
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "evidence resultDigest must be SHA-256")
        normalized_evidence.append(
            {
                "targetId": _identifier(item.get("targetId"), "evidence.targetId"),
                "tool": _bounded_text(item.get("tool"), "evidence.tool", 256),
                "observedAt": _bounded_text(item.get("observedAt"), "evidence.observedAt", 128),
                "resultDigest": result_digest,
            }
        )
    result["evidence"] = normalized_evidence
    for field in ("operationIds", "actionTaskIds"):
        values = value.get(field, [])
        if not isinstance(values, list) or len(values) > 100:
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", f"{field} must be a bounded array")
        normalized_values = [_identifier(item, field) for item in values]
        if len(set(normalized_values)) != len(normalized_values):
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", f"{field} must not contain duplicates")
        result[field] = normalized_values
    checkpoint = value.get("checkpoint")
    if isinstance(checkpoint, Mapping) and checkpoint.get("kind") == "source_poll":
        result["checkpoint"] = _validate_source_poll_checkpoint(checkpoint)
        checkpoint = None
    if checkpoint is not None:
        if (
            not isinstance(checkpoint, Mapping)
            or set(checkpoint) - {"kind", "watermark", "windowEnd", "complete", "repositories"}
            or checkpoint.get("kind") != "github_issues_search"
            or type(checkpoint.get("complete")) is not bool
        ):
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "checkpoint uses an unsupported shape")
        watermark_value = checkpoint.get("watermark")
        watermark = (
            None
            if watermark_value is None
            else _bounded_text(watermark_value, "checkpoint.watermark", 128)
        )
        window_end = _bounded_text(checkpoint.get("windowEnd"), "checkpoint.windowEnd", 128)
        rfc3339_utc = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
        if (
            watermark is not None and not rfc3339_utc.fullmatch(watermark)
        ) or not rfc3339_utc.fullmatch(window_end):
            raise _invalid(
                "WORK_SCHEDULE_INVALID_EVENT", "checkpoint timestamps must be UTC RFC3339 seconds"
            )
        repositories = checkpoint.get("repositories")
        if not isinstance(repositories, list) or len(repositories) > 100:
            raise _invalid(
                "WORK_SCHEDULE_INVALID_EVENT", "checkpoint repositories must be a bounded array"
            )
        normalized_repositories: list[JsonObject] = []
        target_ids: set[str] = set()
        for cursor in repositories:
            if (
                not isinstance(cursor, Mapping)
                or set(cursor)
                - {
                    "targetId",
                    "pageCursor",
                    "queryDigest",
                    "complete",
                    "hasChanges",
                    "pagesCollected",
                    "totalCount",
                    "blockedReason",
                }
                or not {
                    "targetId",
                    "pageCursor",
                    "queryDigest",
                    "complete",
                    "hasChanges",
                    "pagesCollected",
                }.issubset(cursor)
            ):
                raise _invalid(
                    "WORK_SCHEDULE_INVALID_EVENT", "repository cursor has an unsupported shape"
                )
            target_id = _identifier(cursor.get("targetId"), "checkpoint.targetId")
            page_cursor = _bounded_text(cursor.get("pageCursor"), "checkpoint.pageCursor", 8)
            query_digest = _bounded_text(cursor.get("queryDigest"), "checkpoint.queryDigest", 64)
            complete_cursor = cursor.get("complete")
            pages_collected = cursor.get("pagesCollected")
            total_count = cursor.get("totalCount")
            blocked_reason = cursor.get("blockedReason")
            if (
                target_id in target_ids
                or not page_cursor.isdigit()
                or not 1 <= int(page_cursor) <= 1000
                or not re.fullmatch(r"[a-f0-9]{64}", query_digest)
                or type(complete_cursor) is not bool
                or type(cursor.get("hasChanges")) is not bool
                or type(pages_collected) is not int
                or not 0 <= pages_collected <= 1000
            ):
                raise _invalid(
                    "WORK_SCHEDULE_INVALID_EVENT", "repository cursor fields are invalid"
                )
            if total_count is not None and (
                type(total_count) is not int or not 0 <= total_count <= 10_000_000
            ):
                raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "repository totalCount is invalid")
            if blocked_reason not in {None, "result_limit", "incomplete_results", "missing_pages"}:
                raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "repository blockedReason is invalid")
            target_ids.add(target_id)
            normalized_repositories.append(
                {
                    "targetId": target_id,
                    "pageCursor": page_cursor,
                    "queryDigest": query_digest,
                    "complete": complete_cursor,
                    "hasChanges": cursor["hasChanges"],
                    "pagesCollected": pages_collected,
                    **({"totalCount": total_count} if total_count is not None else {}),
                    **({"blockedReason": blocked_reason} if blocked_reason is not None else {}),
                }
            )
        checkpoint_complete = checkpoint["complete"]
        if checkpoint_complete and (normalized_repositories or watermark != window_end):
            raise _invalid(
                "WORK_SCHEDULE_INVALID_EVENT",
                "a complete checkpoint must advance to its window end",
            )
        if not checkpoint_complete and (
            not normalized_repositories or all(item["complete"] for item in normalized_repositories)
        ):
            raise _invalid(
                "WORK_SCHEDULE_INVALID_EVENT",
                "an incomplete checkpoint must retain pending repository cursors",
            )
        normalized_checkpoint: JsonObject = {
            "kind": "github_issues_search",
            "watermark": watermark,
            "windowEnd": window_end,
            "complete": checkpoint_complete,
            "repositories": normalized_repositories,
        }
        result["checkpoint"] = normalized_checkpoint
    if value.get("attentionKind") is not None:
        attention_kind = value["attentionKind"]
        if attention_kind not in {"blocked_goal", "user_decision", "service_or_auth_outage"}:
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "attentionKind is not supported")
        result["attentionKind"] = attention_kind
    action_results = value.get("actionResults", [])
    if not isinstance(action_results, list) or len(action_results) > 100:
        raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "actionResults must be a bounded array")
    normalized_action_results: list[JsonObject] = []
    action_types = {"draft_pull_request", "rerun_source_ci", "update_issue_progress"}
    action_states = {"completed", "failed", "waiting", "unknown", "skipped"}
    for receipt in action_results:
        if not isinstance(receipt, Mapping) or set(receipt) != {
            "actionId",
            "actionType",
            "targetId",
            "taskId",
            "requestDigest",
            "status",
            "operationIds",
        }:
            raise _invalid(
                "WORK_SCHEDULE_INVALID_EVENT",
                "action result does not match the durable receipt schema",
            )
        request_digest = _bounded_text(
            receipt.get("requestDigest"), "actionResult.requestDigest", 64
        )
        if (
            receipt.get("actionType") not in action_types
            or receipt.get("status") not in action_states
        ):
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "action type or status is not supported")
        if not re.fullmatch(r"[a-f0-9]{64}", request_digest):
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "action requestDigest must be SHA-256")
        operation_ids = receipt.get("operationIds")
        if not isinstance(operation_ids, list) or len(operation_ids) > 100:
            raise _invalid(
                "WORK_SCHEDULE_INVALID_EVENT", "action operationIds must be a bounded array"
            )
        normalized_operation_ids = [
            _identifier(item, "action operationId") for item in operation_ids
        ]
        normalized_action_results.append(
            {
                "actionId": _identifier(receipt.get("actionId"), "actionResult.actionId"),
                "actionType": receipt["actionType"],
                "targetId": _identifier(receipt.get("targetId"), "actionResult.targetId"),
                "taskId": _identifier(receipt.get("taskId"), "actionResult.taskId"),
                "requestDigest": request_digest,
                "status": receipt["status"],
                "operationIds": normalized_operation_ids,
            }
        )
    result["actionResults"] = normalized_action_results
    forbidden = {"output", "reasoning", "toolArgs", "credentials"}.intersection(value)
    if forbidden:
        raise _invalid(
            "WORK_SCHEDULE_INVALID_EVENT",
            "schedule events cannot contain output, tool args, or credentials",
        )
    return result


def _validate_source_poll_checkpoint(value: Mapping[str, Any]) -> JsonObject:
    """Validate a bounded source cursor without accepting partial watermark advances.

    中文：校验分页检查点。
    """

    allowed = {"kind", "windowStart", "windowEnd", "complete", "sources"}
    required = {"kind", "windowEnd", "complete", "sources"}
    if set(value) - allowed or not required.issubset(value) or value.get("kind") != "source_poll":
        raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "source poll checkpoint fields are invalid")
    if type(value.get("complete")) is not bool:
        raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "source poll complete must be boolean")
    rfc3339_utc = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z")
    window_start_value = value.get("windowStart")
    window_start = (
        _bounded_text(window_start_value, "checkpoint.windowStart", 128)
        if window_start_value is not None
        else None
    )
    window_end = _bounded_text(value.get("windowEnd"), "checkpoint.windowEnd", 128)
    if (
        window_start is not None and not rfc3339_utc.fullmatch(window_start)
    ) or not rfc3339_utc.fullmatch(window_end):
        raise _invalid(
            "WORK_SCHEDULE_INVALID_EVENT", "source poll window must use UTC RFC3339 timestamps"
        )
    if window_start is not None and window_start > window_end:
        raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "source poll window start exceeds its end")
    sources = value.get("sources")
    if not isinstance(sources, list) or not 1 <= len(sources) <= 100:
        raise _invalid(
            "WORK_SCHEDULE_INVALID_EVENT", "source cursors must be a bounded non-empty array"
        )
    allowed_sources = {
        "github",
        "azure_devops",
        "office_graph",
        "vm_health",
        "training",
        "product",
    }
    normalized_sources: list[JsonObject] = []
    source_targets: set[tuple[str, str]] = set()
    has_incomplete = False
    total_seen_event_ids = 0
    total_states = 0
    for item in sources:
        required_cursor = {"source", "targetId", "complete", "pagesCollected"}
        optional_cursor = {
            "pageCursor",
            "resumeCursor",
            "watermark",
            "seenEventIds",
            "states",
        }
        if (
            not isinstance(item, Mapping)
            or not required_cursor.issubset(item)
            or set(item) - required_cursor - optional_cursor
        ):
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "source cursor fields are invalid")
        source = item.get("source")
        if source not in allowed_sources or type(item.get("complete")) is not bool:
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "source cursor kind or state is invalid")
        target_id = _identifier(item.get("targetId"), "checkpoint targetId")
        key = (str(source), target_id)
        if key in source_targets:
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "source cursor targets must be unique")
        source_targets.add(key)
        page_cursor_value = item.get("pageCursor")
        page_cursor = (
            _bounded_text(page_cursor_value, "checkpoint.pageCursor", 2_000)
            if page_cursor_value is not None
            else None
        )
        resume_cursor_value = item.get("resumeCursor")
        resume_cursor = (
            _bounded_text(resume_cursor_value, "checkpoint.resumeCursor", 2_000)
            if resume_cursor_value is not None
            else None
        )
        watermark_value = item.get("watermark")
        watermark = (
            _bounded_text(watermark_value, "checkpoint.watermark", 512)
            if watermark_value is not None
            else None
        )
        pages_collected = item.get("pagesCollected")
        if type(pages_collected) is not int or not 0 <= pages_collected <= 20:
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "pagesCollected must be between 0 and 20")
        seen_event_ids_value = item.get("seenEventIds", [])
        if not isinstance(seen_event_ids_value, list) or len(seen_event_ids_value) > 1_000:
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "seenEventIds must be a bounded array")
        seen_event_ids = [
            _bounded_text(event_id, "checkpoint.seenEventId", 512)
            for event_id in seen_event_ids_value
        ]
        if len(set(seen_event_ids)) != len(seen_event_ids):
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "seenEventIds entries must be unique")
        total_seen_event_ids += len(seen_event_ids)
        if total_seen_event_ids > 1_000:
            raise _invalid(
                "WORK_SCHEDULE_INVALID_EVENT", "one source checkpoint cannot exceed 1,000 event ids"
            )
        states_value = item.get("states", [])
        if not isinstance(states_value, list) or len(states_value) > 1_000:
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "source states must be a bounded array")
        normalized_states: list[JsonObject] = []
        resource_keys: set[str] = set()
        for state_item in states_value:
            if not isinstance(state_item, Mapping) or set(state_item) != {
                "resourceKey",
                "fingerprint",
                "state",
            }:
                raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "source state fingerprint is invalid")
            resource_key = _bounded_text(state_item.get("resourceKey"), "resourceKey", 64)
            fingerprint = _bounded_text(state_item.get("fingerprint"), "fingerprint", 64)
            state = state_item.get("state")
            if (
                not re.fullmatch(r"[a-f0-9]{64}", resource_key)
                or not re.fullmatch(r"[a-f0-9]{64}", fingerprint)
                or state not in {"healthy", "incident", "neutral"}
                or resource_key in resource_keys
            ):
                raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "source state fields are invalid")
            resource_keys.add(resource_key)
            normalized_states.append(
                {"resourceKey": resource_key, "fingerprint": fingerprint, "state": state}
            )
        total_states += len(normalized_states)
        if total_states > 1_000:
            raise _invalid(
                "WORK_SCHEDULE_INVALID_EVENT", "one source checkpoint cannot exceed 1,000 states"
            )
        if item["complete"]:
            if page_cursor is not None or watermark != window_end:
                raise _invalid(
                    "WORK_SCHEDULE_INVALID_EVENT",
                    "a completed source must clear its page cursor and advance to windowEnd",
                )
        else:
            has_incomplete = True
            if page_cursor is None or watermark == window_end or resume_cursor is not None:
                raise _invalid(
                    "WORK_SCHEDULE_INVALID_EVENT",
                    "incomplete sources must retain pageCursor and cannot advance watermark",
                )
        normalized_sources.append(
            {
                "source": source,
                "targetId": target_id,
                "pageCursor": page_cursor,
                "resumeCursor": resume_cursor,
                "watermark": watermark,
                "complete": item["complete"],
                "pagesCollected": pages_collected,
                "seenEventIds": seen_event_ids,
                "states": normalized_states,
            }
        )
    complete = value["complete"]
    if (
        complete != all(item["complete"] for item in normalized_sources)
        or complete == has_incomplete
    ):
        raise _invalid(
            "WORK_SCHEDULE_INVALID_EVENT",
            "checkpoint complete must match the completion state of all source cursors",
        )
    return {
        "kind": "source_poll",
        "windowStart": window_start,
        "windowEnd": window_end,
        "complete": complete,
        "sources": normalized_sources,
    }


def _validate_v3_schedule_event(
    event: Mapping[str, Any],
    workflow: Mapping[str, Any],
    conn: sqlite3.Connection,
    org: str,
    workspace: str,
    actor_id: str,
) -> None:
    """Bind each V3 checkpoint to one configured trigger and target set. | 绑定轮询检查点。"""

    trigger_id = event.get("triggerId")
    triggers = workflow.get("triggers")
    if not isinstance(trigger_id, str) or not isinstance(triggers, list):
        raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "v3 schedule event requires triggerId")
    scheduled_at = _bounded_text(event.get("scheduledAt"), "scheduledAt", 128)
    task_id = event.get("taskId")
    if not isinstance(task_id, str):
        raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "v3 schedule event requires taskId")
    task = conn.execute(
        """SELECT created_by_actor_id FROM work_tasks WHERE organization_id=?
           AND workspace_id=? AND task_id=?""",
        (org, workspace, task_id),
    ).fetchone()
    if task is None or str(task["created_by_actor_id"] or "").lower() != actor_id.lower():
        raise _not_found("WORK_TASK_NOT_FOUND", "The workflow task does not exist for this actor.")
    task_actor = str(task["created_by_actor_id"])
    occurrence_id = _v3_occurrence_id(str(workflow["id"]), trigger_id, scheduled_at, task_actor)
    expected_task_id = "workflow-" + occurrence_id[4:]
    if task_id != expected_task_id:
        raise _invalid(
            "WORK_SCHEDULE_INVALID_EVENT",
            "v3 schedule taskId must be deterministic for its workflow occurrence",
        )
    if trigger_id == "daily-digest":
        if workflow["notifications"]["digest"]["enabled"] is not True:
            raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "the workflow digest is disabled")
        if not _is_weekday_digest_time(scheduled_at):
            raise _invalid(
                "WORK_SCHEDULE_INVALID_EVENT",
                "daily-digest ScheduleEvents must be weekday 09:00 America/New_York occurrences",
            )
        if event.get("checkpoint") is not None:
            raise _invalid(
                "WORK_SCHEDULE_INVALID_EVENT",
                "daily digest ScheduleEvents cannot carry source cursors",
            )
        if event.get("status") == "succeeded" and event.get("changed") is not True:
            raise _invalid(
                "WORK_SCHEDULE_INVALID_EVENT", "unchanged daily digests must remain silent"
            )
        digest_task = conn.execute(
            """SELECT created_by_actor_id,metadata_json,status FROM work_tasks
               WHERE organization_id=? AND workspace_id=? AND task_id=?""",
            (org, workspace, expected_task_id),
        ).fetchone()
        if (
            digest_task is None
            or str(digest_task["created_by_actor_id"] or "").lower() != actor_id.lower()
        ):
            raise _not_found(
                "WORK_TASK_NOT_FOUND", "The digest task does not exist for this actor."
            )
        digest_metadata = _stored_object(digest_task["metadata_json"], "digest task metadata")
        if (
            digest_metadata.get("source") != "workflow"
            or digest_metadata.get("workflowId") != workflow["id"]
            or digest_metadata.get("triggerId") != "daily-digest"
            or digest_metadata.get("occurrenceId") != occurrence_id
            or digest_metadata.get("authorizationRef") != workflow.get("authorization")
        ):
            raise _conflict(
                "WORK_SCHEDULE_TASK_MISMATCH",
                "The digest task provenance does not match its workflow occurrence.",
            )
        if event.get("status") == "running" and str(digest_task["status"]) != "running":
            raise _conflict(
                "WORK_SCHEDULE_TASK_STATE_INVALID", "A running digest requires a running task."
            )
        return
    trigger = next(
        (item for item in triggers if isinstance(item, Mapping) and item.get("id") == trigger_id),
        None,
    )
    if not isinstance(trigger, Mapping):
        raise _not_found(
            "WORK_WORKFLOW_TRIGGER_NOT_FOUND",
            "The source poll trigger does not exist in this workflow.",
        )
    task = conn.execute(
        """SELECT created_by_actor_id,metadata_json,status FROM work_tasks
           WHERE organization_id=? AND workspace_id=? AND task_id=?""",
        (org, workspace, expected_task_id),
    ).fetchone()
    if task is None or str(task["created_by_actor_id"] or "").lower() != actor_id.lower():
        raise _not_found("WORK_TASK_NOT_FOUND", "The workflow task does not exist for this actor.")
    task_metadata = _stored_object(task["metadata_json"], "workflow task metadata")
    if (
        task_metadata.get("source") != "workflow"
        or task_metadata.get("workflowId") != workflow["id"]
        or task_metadata.get("triggerId") != trigger_id
        or task_metadata.get("occurrenceId") != occurrence_id
        or task_metadata.get("authorizationRef") != workflow.get("authorization")
    ):
        raise _conflict(
            "WORK_SCHEDULE_TASK_MISMATCH",
            "The schedule event task provenance does not match the workflow occurrence.",
        )
    if event.get("status") == "running" and str(task["status"]) != "running":
        raise _conflict(
            "WORK_SCHEDULE_TASK_STATE_INVALID",
            "A running source poll receipt requires a running Work task.",
        )
    checkpoint = event.get("checkpoint")
    if checkpoint is None:
        if event.get("status") == "succeeded":
            raise _invalid(
                "WORK_SCHEDULE_INVALID_EVENT",
                "a successful v3 source poll requires a complete source checkpoint",
            )
        return
    if not isinstance(checkpoint, Mapping) or checkpoint.get("kind") != "source_poll":
        raise _invalid(
            "WORK_SCHEDULE_INVALID_EVENT", "v3 schedule events require source_poll checkpoints"
        )
    target_ids = trigger.get("targetIds")
    source = trigger.get("source")
    checkpoint_sources = checkpoint.get("sources")
    if not isinstance(target_ids, list) or not isinstance(checkpoint_sources, list):
        raise _invalid("WORK_SCHEDULE_INVALID_EVENT", "source checkpoint target set is invalid")
    expected = {(str(source), str(target_id)) for target_id in target_ids}
    observed = {
        (str(item.get("source")), str(item.get("targetId")))
        for item in checkpoint_sources
        if isinstance(item, Mapping)
    }
    if observed != expected:
        raise _invalid(
            "WORK_SCHEDULE_INVALID_EVENT",
            "source checkpoint must include every configured target exactly once",
        )
    total_pages = sum(
        int(item["pagesCollected"]) for item in checkpoint_sources if isinstance(item, Mapping)
    )
    if total_pages > int(trigger.get("maxPages", 20)):
        raise _invalid(
            "WORK_SCHEDULE_INVALID_EVENT",
            "source checkpoint exceeds the per-occurrence page budget",
        )
    if any(
        isinstance(item, Mapping)
        and type(item.get("pagesCollected")) is int
        and item["pagesCollected"] > int(trigger.get("maxPages", 20))
        for item in checkpoint_sources
    ):
        raise _invalid(
            "WORK_SCHEDULE_INVALID_EVENT", "source checkpoint exceeds the configured page limit"
        )
    if event.get("status") == "succeeded" and checkpoint.get("complete") is not True:
        raise _invalid(
            "WORK_SCHEDULE_INVALID_EVENT", "incomplete provider pages cannot complete a source poll"
        )
    if event.get("baseline") is True and event.get("changed") is True:
        raise _invalid(
            "WORK_SCHEDULE_INVALID_EVENT", "an initial source baseline cannot report changes"
        )


def _connector_event_expiry(event_type: str, payload: Mapping[str, Any]) -> int | None:
    """Read a short QR expiry only for redaction; never infer login authority. |
    仅解析二维码过期时间。"""

    if not event_type.endswith("login.qr"):
        return None
    value = payload.get("expiresAt", payload.get("expires_at_utc"))
    if type(value) is int and value >= 0:
        return value
    if isinstance(value, str):
        from datetime import UTC, datetime

        try:
            return int(
                datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC).timestamp()
                * 1000
            )
        except ValueError:
            return _unix_ms()
    return _unix_ms()


def _connector_status_for_event(event_type: str, payload: Mapping[str, Any]) -> str | None:
    """Map known login lifecycle events to a narrow connector health state. | 映射登录状态。"""

    if event_type.endswith("login.state"):
        state = payload.get("state")
        return {
            "pending": "authenticating",
            "scanned": "authenticating",
            "authorized": "connected",
            "connected": "connected",
            "expired": "login_required",
            "failed": "error",
        }.get(str(state))
    if event_type.endswith("login.qr"):
        return "authenticating"
    return None


def _not_found(code: str, detail: str) -> PersistenceError:
    """Create a scope-hiding not-found response. | 返回隐藏范围信息的 404。"""

    return PersistenceError(code, 404, detail)


def _conflict(code: str, detail: str) -> PersistenceError:
    """Create a non-retryable state conflict. | 返回状态冲突。"""

    return PersistenceError(code, 409, detail)


def _invalid(code: str, detail: str) -> PersistenceError:
    """Create a request validation response for direct store callers. | 返回边界校验错误。"""

    return PersistenceError(code, 422, detail)


def _unix_ms() -> int:
    """Read current Unix time in milliseconds. | 读取 Unix 毫秒时间。"""

    return time.time_ns() // 1_000_000
