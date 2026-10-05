"""
Module: cyrene_navigator.work.store
Role: Workspace-scoped durable Work resources in the Harness SQLite file.

模块职责：在 Harness SQLite 文件中持久化组织与 Workspace 隔离的工作域资源。
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import sqlite3
import time
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from uuid import uuid4

from cyrene_navigator.persistence.errors import PersistenceError

JsonObject = dict[str, Any]
_MAX_JSON_BYTES = 2_000_000
_TERMINAL_TASK_STATES = frozenset({"completed", "failed", "aborted"})
_TASK_TRANSITIONS: dict[str, frozenset[str]] = {
    "queued": frozenset({"running", "failed", "aborted", "waiting_approval", "waiting_input"}),
    "running": frozenset({"completed", "failed", "aborted", "waiting_approval", "waiting_input"}),
    "waiting_approval": frozenset({"running", "failed", "aborted"}),
    "waiting_input": frozenset({"running", "failed", "aborted"}),
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
        self, organization_id: str | None, workspace_id: str, body: Mapping[str, Any]
    ) -> tuple[JsonObject, bool]:
        """Create or safely replay one task admission. | 创建或安全重放任务接纳。"""

        org, workspace = _scope(organization_id, workspace_id)
        task_id = _identifier(body.get("id") or uuid4().hex, "task id")
        session_id = _identifier(body.get("sessionId"), "sessionId")
        prompt = _bounded_text(body.get("prompt"), "prompt", 100_000)
        title = _optional_text(body.get("title"), "title", 512)
        description = _optional_text(body.get("description"), "description", 20_000)
        metadata = _json_object(body.get("metadata", {}), "metadata")
        _task_notification_descriptor(metadata)
        create_digest = _digest(
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
                if str(row["creation_digest"]) != create_digest:
                    raise _conflict(
                        "WORK_TASK_ID_CONFLICT",
                        "The task id already names another task.",
                    )
                return self._task_view(row), True
            conn.execute(
                """INSERT INTO work_tasks (
                    organization_id,workspace_id,task_id,session_id,prompt,status,
                    created_at,started_at,ended_at,output,reasoning,error,duration_ms,
                    sequence,title,description,metadata_json,creation_digest
                ) VALUES (?,?,?,?,?,'queued',?,NULL,NULL,'','',NULL,0,0,?,?,?,?)""",
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
                ),
            )
            self._append_event(conn, org, workspace, task_id, {"type": "task.created"}, None, now)
            row = self._require_task(conn, org, workspace, task_id)
            return self._task_view(row), False

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
        request = _json_object(body.get("request", {}), "request")
        digest = _digest(
            {
                "operationType": operation_type,
                "taskId": task_id,
                "target": target,
                "request": request,
            }
        )
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
            operation_id = uuid4().hex
            conn.execute(
                """INSERT INTO work_operations(
                   organization_id,workspace_id,operation_id,idempotency_key,operation_type,
                   task_id,target,request_json,status,evidence_json,request_digest,created_at,updated_at
                   ) VALUES(?,?,?,?,?,?,?,?,'started','{}',?,?,?)""",
                (
                    org,
                    workspace,
                    operation_id,
                    key,
                    operation_type,
                    task_id,
                    target,
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
            text = str(task["error"] or "").strip() or "Task failed."
        else:
            text = "Task aborted."
        if len(text) > 20_000:
            text = text[:19_980] + " [truncated]"
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
    ) -> JsonObject:
        """Persist a delivery result; uncertain outcomes are terminal until reviewed. |
        记录投递结果。"""

        if outcome not in {"delivered", "failed", "uncertain"}:
            raise _invalid("WORK_NOTIFICATION_INVALID_OUTCOME", "outcome is not valid")
        return self._notification_transition(
            organization_id, workspace_id, notification_id, lease_token, outcome, result
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
        event_body = {
            "type": event_type,
            "occurredAt": supplied_occurred_at,
            "accountId": account_id,
            "conversationId": conversation_id,
            "senderId": sender_id,
            "payload": payload,
            "task": task_digest_body,
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
                    conn, org, workspace, task_digest_body, now
                )
                task_id = str(task_view["id"])
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

    def list_workflows(self, organization_id: str | None, workspace_id: str) -> list[JsonObject]:
        """List versioned Work instructions for one organization and Workspace. | 列工作流。"""

        org, workspace = _scope(organization_id, workspace_id)
        with self._read() as conn:
            rows = conn.execute(
                """SELECT workflow_json FROM work_workflows WHERE organization_id=? AND
                workspace_id=?
                   ORDER BY workflow_id""",
                (org, workspace),
            ).fetchall()
            return [_stored_object(row["workflow_json"], "workflow") for row in rows]

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

    def _notification_transition(
        self,
        organization_id: str | None,
        workspace_id: str,
        notification_id: str,
        lease_token: str,
        target_status: str,
        result: Mapping[str, Any],
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
                "work_notifications": {"connector_id": "TEXT", "task_id": "TEXT"},
                "work_operations": {"task_id": "TEXT"},
                "work_connector_states": {"configured": "INTEGER NOT NULL DEFAULT 0"},
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
    ) -> tuple[JsonObject, bool]:
        """Create or replay a task while connector intake owns its transaction. | 原子接纳任务。"""

        task_id = _identifier(body.get("id") or uuid4().hex, "task id")
        session_id = _identifier(body.get("sessionId"), "sessionId")
        prompt = _bounded_text(body.get("prompt"), "prompt", 100_000)
        title = _optional_text(body.get("title"), "title", 512)
        description = _optional_text(body.get("description"), "description", 20_000)
        metadata = _json_object(body.get("metadata", {}), "metadata")
        _task_notification_descriptor(metadata)
        digest = _digest(
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
            if str(prior["creation_digest"]) != digest:
                raise _conflict("WORK_TASK_ID_CONFLICT", "The task id already names another task.")
            return self._task_view(prior), True
        conn.execute(
            """INSERT INTO work_tasks(organization_id,workspace_id,task_id,session_id,prompt,status,
               created_at,started_at,ended_at,output,reasoning,error,duration_ms,sequence,title,
               description,metadata_json,creation_digest)
               VALUES(?,?,?,?,?,'queued',?,NULL,NULL,'','',NULL,0,0,?,?,?,?)""",
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
    if notification_type != "wecom.message":
        raise _invalid(
            "WORK_TASK_INVALID_NOTIFICATION",
            "Task result notifications currently support only wecom.message.",
        )
    connector_id = _identifier(value.get("connectorId"), "notification.connectorId")
    recipient = _bounded_text(value.get("recipient"), "notification.recipient", 2_000)
    payload = _json_object(value.get("payload"), "notification.payload")
    expected_fields = {"accountId", "conversationId", "chatType", "senderId"}
    if set(payload) != expected_fields:
        raise _invalid(
            "WORK_TASK_INVALID_NOTIFICATION",
            "The WeCom route needs accountId, conversationId, chatType, and senderId.",
        )
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
    ):
        if value.get(key) is not None:
            result[key] = _bounded_text(value[key], key, limit)
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
