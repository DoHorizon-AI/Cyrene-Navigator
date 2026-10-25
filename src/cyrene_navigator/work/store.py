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
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from cyrene_navigator.persistence.errors import PersistenceError

JsonObject = dict[str, Any]
_MAX_JSON_BYTES = 2_000_000
_TASK_RESULT_NOTIFICATION_MAX_CHARS = 20_000
_TASK_RESULT_NOTIFICATION_TRUNCATION = "\n...[middle task result truncated]...\n"
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
                return self._task_view(row), True
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
            row = self._require_task(conn, org, workspace, task_id)
            return self._task_view(row), False

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
                return self._task_view(existing), True
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
            return self._task_view(row), False

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

    def get_task(self, organization_id: str | None, workspace_id: str, task_id: str) -> JsonObject:
        """Read one task from the exact tenant scope. | 读取精确租户范围内的任务。"""

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(task_id, "task id")
        with self._read() as conn:
            return self._task_view(self._require_task(conn, org, workspace, task_id))

    def list_tasks(
        self,
        organization_id: str | None,
        workspace_id: str,
        *,
        limit: int = 50,
        cursor: str | None = None,
    ) -> tuple[list[JsonObject], str | None]:
        """List tasks using a stable created-time cursor. | 按稳定游标列出任务。"""

        org, workspace = _scope(organization_id, workspace_id)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise _invalid("WORK_TASK_INVALID_PAGE", "limit must be between 1 and 100")
        cursor_value = _decode_cursor(cursor) if cursor else None
        with self._read() as conn:
            if cursor_value is None:
                rows = conn.execute(
                    """SELECT * FROM work_tasks WHERE organization_id=? AND workspace_id=?
                       ORDER BY created_at DESC,task_id ASC LIMIT ?""",
                    (org, workspace, limit + 1),
                ).fetchall()
            else:
                created_at, task_id = cursor_value
                rows = conn.execute(
                    """SELECT * FROM work_tasks
                       WHERE organization_id=? AND workspace_id=?
                         AND (created_at<? OR (created_at=? AND task_id>?))
                       ORDER BY created_at DESC,task_id ASC LIMIT ?""",
                    (org, workspace, created_at, created_at, task_id, limit + 1),
                ).fetchall()
            has_more = len(rows) > limit
            items = [self._task_view(row) for row in rows[:limit]]
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
    ) -> JsonObject:
        """Update an executor projection and append status history atomically. | 原子更新任务。"""

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(task_id, "task id")
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
                        self._queue_task_result_notification(conn, org, workspace, terminal, now)
            return self._task_view(self._require_task(conn, org, workspace, task_id))

    def claim_task(
        self, organization_id: str | None, workspace_id: str, task_id: str
    ) -> tuple[bool, JsonObject]:
        """Atomically claim only queued work before any executor side effect. | 单赢家认领任务。"""

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(task_id, "task id")
        now = _unix_ms()
        with self._mutation() as conn:
            task = self._require_task(conn, org, workspace, task_id)
            if str(task["status"]) != "queued":
                return False, self._task_view(task)
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
            return True, self._task_view(self._require_task(conn, org, workspace, task_id))

    def append_task_event(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        event: Mapping[str, Any],
        message_id: str | None,
    ) -> tuple[int, JsonObject, bool, JsonObject, int]:
        """Append an idempotent task event and return its committed task view. |
        幂等追加任务事件。"""

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(task_id, "task id")
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
                        self._task_view(self._require_task(conn, org, workspace, task_id)),
                        int(prior["created_at"]),
                    )
            seq = self._append_event(conn, org, workspace, task_id, normalized, message_id, now)
            return (
                seq,
                normalized,
                False,
                self._task_view(self._require_task(conn, org, workspace, task_id)),
                now,
            )

    def get_task_events(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        after: int = 0,
        limit: int = 1_000,
    ) -> tuple[list[JsonObject], int]:
        """Read a contiguous event page after an exclusive sequence cursor. | 读取任务事件。"""

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(task_id, "task id")
        if (
            type(after) is not int
            or after < 0
            or type(limit) is not int
            or not 1 <= limit <= 10_000
        ):
            raise _invalid("WORK_TASK_INVALID_CURSOR", "after must be non-negative and limit valid")
        with self._read() as conn:
            task = self._require_task(conn, org, workspace, task_id)
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
                    return self._approval_view(duplicate), self._task_view(task), True
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
                self._task_view(self._require_task(conn, org, workspace, task_id)),
                False,
            )

    def get_approval(
        self, organization_id: str | None, workspace_id: str, approval_id: str
    ) -> JsonObject:
        """Read an approval only within the current organization and Workspace. | 读取审批。"""

        org, workspace = _scope(organization_id, workspace_id)
        with self._read() as conn:
            return self._approval_view(self._require_approval(conn, org, workspace, approval_id))

    def list_approvals(
        self,
        organization_id: str | None,
        workspace_id: str,
        status: str | None = None,
        limit: int = 100,
    ) -> list[JsonObject]:
        """List pending or historical decisions within one authorized Workspace. | 列审批。"""

        org, workspace = _scope(organization_id, workspace_id)
        if type(limit) is not int or not 1 <= limit <= 500:
            raise _invalid("WORK_APPROVAL_INVALID_PAGE", "limit must be between 1 and 500")
        if status not in {None, "pending", "approved", "rejected"}:
            raise _invalid("WORK_APPROVAL_INVALID_STATUS", "status is not a valid approval state")
        with self._read() as conn:
            if status:
                rows = conn.execute(
                    """SELECT * FROM work_approvals WHERE organization_id=? AND
                    workspace_id=? AND status=?
                       ORDER BY created_at DESC LIMIT ?""",
                    (org, workspace, status, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT * FROM work_approvals WHERE organization_id=? AND workspace_id=?
                       ORDER BY created_at DESC LIMIT ?""",
                    (org, workspace, limit),
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
            old_status = str(approval["status"])
            if old_status != "pending":
                if (
                    str(approval["resolution_digest"] or "") == digest
                    and message_id is not None
                    and str(approval["message_id"] or "") == message_id
                ):
                    return self._approval_view(approval), self._task_view(task), True
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
                self._queue_task_result_notification(conn, org, workspace, task, now)
            return self._approval_view(approval), self._task_view(task), False

    def create_input_request(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        body: Mapping[str, Any],
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
        with self._mutation() as conn:
            task = self._require_task(conn, org, workspace, task_id)
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
                    return self._input_view(prior), self._task_view(task), True
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
                self._task_view(self._require_task(conn, org, workspace, task_id)),
                False,
            )

    def get_input_request(
        self, organization_id: str | None, workspace_id: str, input_id: str
    ) -> JsonObject:
        """Read one pending or answered input request within the current scope. | 读取输入请求。"""

        org, workspace = _scope(organization_id, workspace_id)
        with self._read() as conn:
            return self._input_view(self._require_input(conn, org, workspace, input_id))

    def list_input_requests(
        self,
        organization_id: str | None,
        workspace_id: str,
        status: str | None = None,
        limit: int = 100,
    ) -> list[JsonObject]:
        """List human input requests for a Workspace control surface. | 列出待处理输入。"""

        org, workspace = _scope(organization_id, workspace_id)
        if status not in {None, "pending", "answered"}:
            raise _invalid("WORK_INPUT_INVALID_STATUS", "status is not a valid input state")
        if type(limit) is not int or not 1 <= limit <= 500:
            raise _invalid("WORK_INPUT_INVALID_PAGE", "limit must be between 1 and 500")
        with self._read() as conn:
            if status is None:
                rows = conn.execute(
                    """SELECT * FROM work_inputs WHERE organization_id=? AND workspace_id=?
                       ORDER BY created_at DESC,input_id LIMIT ?""",
                    (org, workspace, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT * FROM work_inputs WHERE organization_id=? AND workspace_id=?
                       AND status=? ORDER BY created_at DESC,input_id LIMIT ?""",
                    (org, workspace, status, limit),
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
            if str(input_record["status"]) == "answered":
                if (
                    str(input_record["answer_digest"] or "") == digest
                    and str(input_record["answer_message_id"] or "") == message_id
                ):
                    return self._input_view(input_record), self._task_view(task), True
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
                self._task_view(self._require_task(conn, org, workspace, task_id)),
                False,
            )

    def create_operation(
        self,
        organization_id: str | None,
        workspace_id: str,
        body: Mapping[str, Any],
    ) -> tuple[JsonObject, bool]:
        """Record intent before an external effect and never replay it here. | 只记录操作意图。"""

        org, workspace = _scope(organization_id, workspace_id)
        key = _identifier(body.get("idempotencyKey"), "idempotencyKey")
        operation_type = _bounded_text(body.get("operationType"), "operationType", 128)
        task_id = _optional_text(body.get("taskId"), "taskId", 512)
        target = _optional_text(body.get("target"), "target", 2_000)
        scope_lock = _optional_text(body.get("scopeLock"), "scopeLock", 100)
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
    ) -> tuple[JsonObject, bool]:
        """Move started or uncertain receipts forward without a replay path. | 单向更新回执。"""

        org, workspace = _scope(organization_id, workspace_id)
        operation_id = _identifier(operation_id, "operation id")
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
        self, organization_id: str | None, workspace_id: str, operation_id: str
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
            return self._operation_view(row)

    def list_unresolved_operations(
        self,
        organization_id: str | None,
        workspace_id: str,
        *,
        target: str | None = None,
        operation_type: str | None = None,
        limit: int = 100,
    ) -> list[JsonObject]:
        """List minimal started/uncertain receipts for exact-target reconciliation.

        中文：只返回目标/操作精确匹配的未解决回执，不泄露完整参数正文。
        """

        org, workspace = _scope(organization_id, workspace_id)
        target_value = _optional_text(target, "target", 2_000)
        operation_value = _optional_text(operation_type, "operationType", 128)
        if type(limit) is not int or not 1 <= limit <= 500:
            raise _invalid("WORK_OPERATION_INVALID_PAGE", "limit must be between 1 and 500")
        filters = [
            "organization_id=?",
            "workspace_id=?",
            "status IN ('started','uncertain')",
        ]
        params: list[Any] = [org, workspace]
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
        self, organization_id: str | None, workspace_id: str, body: Mapping[str, Any]
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
        with self._mutation() as conn:
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
    ) -> list[JsonObject]:
        """Read workspace memory facts with current freshness annotations. | 读取记忆事实。"""

        org, workspace = _scope(organization_id, workspace_id)
        if type(limit) is not int or not 1 <= limit <= 1_000:
            raise _invalid("WORK_MEMORY_INVALID_PAGE", "limit must be between 1 and 1000")
        with self._read() as conn:
            rows = conn.execute(
                """SELECT * FROM work_memory_facts WHERE organization_id=? AND workspace_id=?
                   ORDER BY namespace,fact_key LIMIT ?""",
                (org, workspace, limit),
            ).fetchall()
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
    ) -> list[JsonObject]:
        """Perform bounded lexical fact search and disclose freshness in each result. |
        查询工作记忆。"""

        query = _bounded_text(query, "query", 2_000).casefold()
        if type(limit) is not int or not 1 <= limit <= 100:
            raise _invalid("WORK_MEMORY_INVALID_PAGE", "limit must be between 1 and 100")
        facts = self.list_memory_facts(
            organization_id, workspace_id, include_stale=True, limit=1_000
        )
        org, workspace = _scope(organization_id, workspace_id)
        now = _unix_ms()
        with self._read() as conn:
            source_rows = conn.execute(
                """SELECT f.*,s.status AS source_status,s.last_complete_at
                   FROM work_source_facts f JOIN work_sources s
                     ON s.organization_id=f.organization_id AND s.workspace_id=f.workspace_id
                    AND s.source_id=f.source_id
                   WHERE f.organization_id=? AND f.workspace_id=? LIMIT 5000""",
                (org, workspace),
            ).fetchall()
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
    ) -> list[JsonObject]:
        """Read the last complete source snapshot and retain explicit missing markers. |
        读取来源事实。"""

        org, workspace = _scope(organization_id, workspace_id)
        source_id = _identifier(source_id, "source id")
        if type(limit) is not int or not 1 <= limit <= 5_000:
            raise _invalid("WORK_SOURCE_INVALID_PAGE", "limit must be between 1 and 5000")
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
    ) -> tuple[JsonObject, bool]:
        """Enqueue one deduplicated outbox item without performing delivery. | 通知入队。"""

        org, workspace = _scope(organization_id, workspace_id)
        dedup_key = _identifier(body.get("deduplicationKey"), "deduplicationKey")
        notification_type = _bounded_text(body.get("type"), "type", 128)
        payload = _json_object(body.get("payload"), "payload")
        connector_id = _optional_text(body.get("connectorId"), "connectorId", 512)
        task_id = _optional_text(body.get("taskId"), "taskId", 512)
        recipient = _optional_text(body.get("recipient"), "recipient", 2_000)
        available_at = body.get("availableAt", _unix_ms())
        _nonnegative_integer(available_at, "availableAt")
        now = _unix_ms()
        with self._mutation() as conn:
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
    ) -> tuple[JsonObject, bool]:
        """Insert one outbox item or verify an identical deduplication replay. | 原子加入通知。"""

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
        notification_id = uuid4().hex
        conn.execute(
            """INSERT INTO work_notifications(organization_id,workspace_id,notification_id,
               deduplication_key,notification_type,payload_json,connector_id,recipient,status,
               task_id,available_at,created_at,updated_at,worker_id,lease_token_hash,lease_expires_at,
               started_at,result_json,request_digest)
               VALUES(?,?,?,?,?,?,?,?, 'queued',?,?,?,?,NULL,NULL,NULL,NULL,'{}',?)""",
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
    ) -> None:
        """Enqueue the adapter reply with the terminal state. | 原子入队任务结果。"""

        descriptor = _task_notification_descriptor(
            _stored_object(task["metadata_json"], "task metadata")
        )
        if descriptor is None:
            return
        status = str(task["status"])
        if status == "completed":
            text = str(task["output"] or "").strip() or "Task completed."
        elif status == "failed":
            error = str(task["error"] or "").strip() or "Task failed."
            output = str(task["output"] or "").strip()
            text = _failed_task_result_notification_text(error, output)
        else:
            text = "Task aborted."
        if status != "failed" and len(text) > _TASK_RESULT_NOTIFICATION_MAX_CHARS:
            text = text[: _TASK_RESULT_NOTIFICATION_MAX_CHARS - 20] + " [truncated]"
        payload = {
            **descriptor["payload"],
            "text": text,
            "taskId": str(task["task_id"]),
            "status": status,
        }
        self._enqueue_notification(
            conn,
            org,
            workspace,
            f"task-result:{task['task_id']}:{status}",
            descriptor["type"],
            payload,
            descriptor["connectorId"],
            descriptor["recipient"],
            str(task["task_id"]),
            now,
            now,
        )

    def list_notifications(
        self,
        organization_id: str | None,
        workspace_id: str,
        *,
        status: str | None = None,
        limit: int = 100,
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
        with self._read() as conn:
            if status:
                rows = conn.execute(
                    """SELECT * FROM work_notifications WHERE organization_id=? AND
                    workspace_id=? AND status=?
                       ORDER BY created_at DESC LIMIT ?""",
                    (org, workspace, status, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT * FROM work_notifications WHERE organization_id=? AND workspace_id=?
                       ORDER BY created_at DESC LIMIT ?""",
                    (org, workspace, limit),
                ).fetchall()
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
        if connector_filter is not None and type_filter is None:
            raise _invalid(
                "WORK_NOTIFICATION_INVALID_FILTER",
                "connectorId claims also require an exact type filter.",
            )
        now = _unix_ms()
        expires = now + lease_seconds * 1_000
        leases: list[JsonObject] = []
        with self._mutation() as conn:
            expired = conn.execute(
                """SELECT notification_id,status FROM work_notifications WHERE organization_id=?
                   AND workspace_id=? AND status IN ('leased','started') AND lease_expires_at<=?""",
                (org, workspace, now),
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

    def start_notification(
        self,
        organization_id: str | None,
        workspace_id: str,
        notification_id: str,
        lease_token: str,
    ) -> JsonObject:
        """Fence a worker before the remote send can begin. | 远程发送前记录开始。"""

        return self._notification_transition(
            organization_id, workspace_id, notification_id, lease_token, "started", {}
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
        )

    def get_attachment(
        self, organization_id: str | None, workspace_id: str, digest: str
    ) -> tuple[JsonObject, Path]:
        """Authorize a digest against metadata in the exact Workspace before reading bytes. |
        读取附件。"""

        org, workspace = _scope(organization_id, workspace_id)
        digest = _validate_digest(digest)
        with self._read() as conn:
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
    ) -> JsonObject:
        """Store a content-addressed attachment with workspace-specific metadata. |
        保存内容寻址附件。"""

        org, workspace = _scope(organization_id, workspace_id)
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
            conn.execute(
                """INSERT INTO work_attachments(organization_id,workspace_id,sha256,name,
                   media_type,size,created_at)
                   VALUES(?,?,?,?,?,?,?) ON CONFLICT(organization_id,workspace_id,sha256) DO
                   NOTHING""",
                (org, workspace, digest, name, media_type, len(raw), now),
            )
            row = conn.execute(
                (
                    "SELECT * FROM work_attachments WHERE organization_id=? AND "
                    "workspace_id=? AND sha256=?"
                ),
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
        teams_digest_message = (
            {key: item for key, item in teams_message.items() if key != "sessionId"}
            if teams_message is not None
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
        }
        event_digest = _digest(event_body)
        now = _unix_ms()
        with self._mutation() as conn:
            existing = conn.execute(
                """SELECT * FROM work_connector_events WHERE organization_id=? AND workspace_id=?
                   AND connector_id=? AND message_id=?""",
                (org, workspace, connector_id, message_id),
            ).fetchone()
            if existing is not None:
                if str(existing["event_digest"]) != event_digest:
                    raise _conflict(
                        "WORK_CONNECTOR_EVENT_ID_CONFLICT",
                        "messageId names different event content.",
                    )
                stored_task = None
                if existing["task_id"]:
                    stored_task = self._task_view(
                        self._require_task(conn, org, workspace, str(existing["task_id"]))
                    )
                return {
                    "eventId": str(existing["event_id"]),
                    "duplicate": True,
                    "receivedAt": int(existing["received_at"]),
                }, stored_task
            task_view: JsonObject | None = None
            task_id: str | None = None
            if task_digest_body is not None:
                task_view, _duplicate = self._create_task_in_transaction(
                    conn, org, workspace, task_digest_body, now, actor_id
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
                   sender_id,payload_json,event_digest,task_id,expires_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
                ),
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
        excluded = _optional_text(exclude_message_id, "excludeMessageId", 512)
        if type(message_limit) is not int or not 1 <= message_limit <= 100:
            raise _invalid("WORK_CONNECTOR_INVALID_THREAD_PAGE", "messageLimit must be 1 to 100")
        with self._read() as conn:
            row = conn.execute(
                """SELECT * FROM work_connector_threads WHERE organization_id=? AND workspace_id=?
                   AND connector_id=? AND thread_id=?""",
                (org, workspace, connector_id, thread_id),
            ).fetchone()
            route_row = row
            if route_row is None:
                route_row = conn.execute(
                    """SELECT tenant_id,team_id,channel_id,conversation_id,root_thread_id,
                       service_url
                       FROM work_connector_thread_messages WHERE organization_id=? AND
                       workspace_id=? AND connector_id=? AND thread_id=?
                       ORDER BY created_at DESC,message_id DESC LIMIT 1""",
                    (org, workspace, connector_id, thread_id),
                ).fetchone()
            if route_row is None:
                raise _not_found(
                    "WORK_CONNECTOR_THREAD_NOT_FOUND", "The Teams thread has no accepted messages."
                )
            exclusion = "" if excluded is None else "AND message_id<>?"
            message_params: tuple[Any, ...] = (org, workspace, connector_id, thread_id)
            if excluded is not None:
                message_params += (excluded,)
            message_params += (message_limit,)
            message_rows = conn.execute(
                f"""SELECT * FROM work_connector_thread_messages WHERE organization_id=? AND
                   workspace_id=? AND connector_id=? AND thread_id=? {exclusion}
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
                "sessionId": str(row["session_id"]) if row is not None else None,
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
        session_id = message.get("sessionId")
        if session_id is not None:
            session_id = str(session_id)
            existing = conn.execute(
                """SELECT * FROM work_connector_threads WHERE organization_id=? AND workspace_id=?
                   AND connector_id=? AND thread_id=?""",
                (org, workspace, connector_id, thread_id),
            ).fetchone()
            if existing is not None:
                if (
                    any(
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
                    )
                    or str(existing["session_id"]) != session_id
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
                       root_thread_id,service_url,session_id,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
    ) -> tuple[list[JsonObject], int]:
        """Read workspace connector events while redacting expired QR payloads. | 读取连接事件。"""

        org, workspace = _scope(organization_id, workspace_id)
        connector_id = _identifier(connector_id, "connector id")
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 1_000:
            raise _invalid("WORK_CONNECTOR_INVALID_CURSOR", "after and limit are invalid")
        now = _unix_ms()
        with self._read() as conn:
            rows = conn.execute(
                """SELECT * FROM work_connector_events WHERE organization_id=? AND workspace_id=?
                   AND connector_id=? AND seq>? ORDER BY seq LIMIT ?""",
                (org, workspace, connector_id, after, limit),
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

    def put_workflow(
        self,
        organization_id: str | None,
        workspace_id: str,
        workflow: Mapping[str, Any],
    ) -> JsonObject:
        """Persist versioned workflow instructions without taking timer authority. |
        保存工作流定义。"""

        org, workspace = _scope(organization_id, workspace_id)
        value = _validate_workflow(workflow)
        workflow_id = value["id"]
        now = _unix_ms()
        value["updatedAt"] = _iso_utc(now)
        with self._mutation() as conn:
            conn.execute(
                """INSERT INTO work_workflows(organization_id,workspace_id,workflow_id,version,
                   workflow_json,updated_at) VALUES(?,?,?,?,?,?)
                   ON CONFLICT(organization_id,workspace_id,workflow_id) DO UPDATE SET
                     version=excluded.version,workflow_json=excluded.workflow_json,updated_at=excluded.updated_at""",
                (org, workspace, workflow_id, value["version"], _json_text(value), now),
            )
            return value

    def list_workflows(
        self, organization_id: str | None, workspace_id: str, definition_version: int = 1
    ) -> list[JsonObject]:
        """List only the explicitly negotiated workflow schema version. | 按协商版本列工作流。"""

        org, workspace = _scope(organization_id, workspace_id)
        if definition_version not in {1, 2}:
            raise _invalid("WORK_WORKFLOW_VERSION_UNSUPPORTED", "definitionVersion must be 1 or 2")
        with self._read() as conn:
            rows = conn.execute(
                """SELECT workflow_json FROM work_workflows WHERE organization_id=? AND
                workspace_id=? AND version=?
                   ORDER BY workflow_id""",
                (org, workspace, definition_version),
            ).fetchall()
            return [_stored_object(row["workflow_json"], "workflow") for row in rows]

    def enqueue_workflow_notice(
        self,
        organization_id: str | None,
        workspace_id: str,
        workflow_id: str,
        body: Mapping[str, Any],
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
    ) -> JsonObject:
        """Append an execution event emitted by DSH's durable scheduler. | 追加调度执行事件。"""

        org, workspace = _scope(organization_id, workspace_id)
        value = _validate_schedule_event(event)
        digest = _digest(value)
        now = _unix_ms()
        with self._mutation() as conn:
            workflow = conn.execute(
                """SELECT 1 FROM work_workflows WHERE organization_id=? AND workspace_id=? AND
                    workflow_id=?""",
                (org, workspace, value["workflowId"]),
            ).fetchone()
            if workflow is None:
                raise _not_found(
                    "WORK_WORKFLOW_NOT_FOUND",
                    "The workflow does not exist in this Workspace.",
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
            conn.execute(
                """INSERT INTO work_schedule_events(organization_id,workspace_id,event_id,
                   workflow_id,
                   created_at,event_json,event_digest) VALUES(?,?,?,?,?,?,?)""",
                (
                    org,
                    workspace,
                    value["id"],
                    value["workflowId"],
                    now,
                    _json_text(value),
                    digest,
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
    ) -> JsonObject:
        """List execution history with a stable time/id cursor. | 分页读取执行历史。"""

        org, workspace = _scope(organization_id, workspace_id)
        if type(limit) is not int or not 1 <= limit <= 500:
            raise _invalid("WORK_SCHEDULE_INVALID_PAGE", "limit must be between 1 and 500")
        workflow_id = _identifier(workflow_id, "workflowId") if workflow_id is not None else None
        decoded = _decode_cursor(cursor) if cursor else None
        filters = "organization_id=? AND workspace_id=?"
        params: list[Any] = [org, workspace]
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
        self, organization_id: str | None, workspace_id: str, event_id: str
    ) -> JsonObject:
        """Read one immutable schedule receipt by its stable event id. | 按稳定事件标识读取回执。"""

        org, workspace = _scope(organization_id, workspace_id)
        event_id = _identifier(event_id, "schedule event id")
        with self._read() as conn:
            row = conn.execute(
                """SELECT event_json FROM work_schedule_events
                   WHERE organization_id=? AND workspace_id=? AND event_id=?""",
                (org, workspace, event_id),
            ).fetchone()
            if row is None:
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
            migrations = {
                "work_tasks": {
                    "created_by_actor_id": "TEXT NOT NULL DEFAULT ''",
                    "continuation_of_task_id": "TEXT",
                    "continuation_mode": "TEXT",
                    "execution_class": "TEXT NOT NULL DEFAULT 'foreground'",
                },
                "work_notifications": {"connector_id": "TEXT", "task_id": "TEXT"},
                "work_operations": {"task_id": "TEXT", "scope_lock": "TEXT"},
                "work_connector_states": {"configured": "INTEGER NOT NULL DEFAULT 0"},
                "work_connector_threads": {
                    "service_url": "TEXT NOT NULL DEFAULT ''",
                },
                "work_connector_thread_messages": {
                    "tenant_id": "TEXT NOT NULL DEFAULT ''",
                    "team_id": "TEXT NOT NULL DEFAULT ''",
                    "channel_id": "TEXT NOT NULL DEFAULT ''",
                    "conversation_id": "TEXT NOT NULL DEFAULT ''",
                    "root_thread_id": "TEXT NOT NULL DEFAULT ''",
                    "service_url": "TEXT NOT NULL DEFAULT ''",
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
            conn.execute(
                """CREATE INDEX IF NOT EXISTS work_notifications_connector_claim
                   ON work_notifications(organization_id,workspace_id,notification_type,
                       connector_id,recipient,status,available_at,created_at)"""
            )
            conn.execute(
                """CREATE INDEX IF NOT EXISTS work_operations_scope_lock
                   ON work_operations(organization_id,workspace_id,scope_lock,status)"""
            )
        finally:
            conn.close()

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
            return self._task_view(prior), True
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
        return self._task_view(self._require_task(conn, org, workspace, task_id)), False

    @staticmethod
    def _task_view(row: sqlite3.Row) -> JsonObject:
        """Convert one row into the stable camelCase TaskRecord. | 生成 TaskRecord。"""

        return {
            "id": str(row["task_id"]),
            "workspaceId": str(row["workspace_id"]),
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
 PRIMARY KEY(organization_id,workspace_id,notification_id),
 UNIQUE(organization_id,workspace_id,deduplication_key));
CREATE INDEX IF NOT EXISTS work_notifications_claim
 ON work_notifications(organization_id,workspace_id,status,available_at,created_at);
CREATE TABLE IF NOT EXISTS work_attachments (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, sha256 TEXT NOT NULL,
 name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,sha256));
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
 event_digest TEXT NOT NULL, task_id TEXT, expires_at INTEGER,
 PRIMARY KEY(organization_id,workspace_id,connector_id,seq),
 UNIQUE(organization_id,workspace_id,connector_id,message_id));
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
CREATE INDEX IF NOT EXISTS work_connector_thread_messages_context
 ON work_connector_thread_messages(organization_id,workspace_id,connector_id,thread_id,created_at);
CREATE TABLE IF NOT EXISTS work_workflows (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
 version INTEGER NOT NULL, workflow_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,workflow_id));
CREATE TABLE IF NOT EXISTS work_schedule_events (
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, event_id TEXT NOT NULL,
 workflow_id TEXT NOT NULL, created_at INTEGER NOT NULL, event_json TEXT NOT NULL,
 event_digest TEXT NOT NULL,
 PRIMARY KEY(organization_id,workspace_id,event_id));
CREATE INDEX IF NOT EXISTS work_schedule_events_order
 ON work_schedule_events(organization_id,workspace_id,created_at DESC,event_id);
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
    if not isinstance(authorization, Mapping) or set(authorization) != {
        "kind",
        "threadBindingId",
        "ownerTaskId",
    }:
        raise _invalid(
            "WORK_TASK_BACKGROUND_AUTHORIZATION_REQUIRED",
            "Background task authorization reference is invalid",
        )
    if authorization.get("kind") != "teams_thread":
        raise _invalid(
            "WORK_TASK_BACKGROUND_AUTHORIZATION_REQUIRED",
            "Background task authorization source is invalid",
        )
    _identifier(authorization.get("threadBindingId"), "metadata.authorizationRef.threadBindingId")
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


def _validate_workflow(workflow: Mapping[str, Any]) -> JsonObject:
    """Validate the intentionally generic DSH-owned workflow metadata. | 校验工作流定义。"""

    value = _json_object(workflow, "workflow")
    if value.get("version") == 2:
        return _validate_workflow_v2(value)
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
