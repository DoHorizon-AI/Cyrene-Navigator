"""
Module: cyrene_navigator.work.api
Role: Authenticated HTTP routes for durable Work resources and connector bridges.

模块职责：挂载有授权边界的工作域资源路由与可信连接器桥接路由。
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import logging
from collections.abc import Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Protocol

from fastapi import FastAPI, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse

from cyrene_navigator.persistence.errors import WORKSPACE_FORBIDDEN, PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.models import (
    ApprovalCreate,
    ApprovalReceipt,
    ApprovalRecord,
    ApprovalResolve,
    AttachmentCreate,
    AttachmentRecord,
    ConnectorEventCreate,
    ConnectorEventReceipt,
    ConnectorEvents,
    ConnectorList,
    ConnectorRecord,
    ConnectorStatusUpdate,
    InputList,
    InputReceipt,
    InputRecord,
    InputRequestCreate,
    InputResolve,
    MemoryFact,
    MemoryFacts,
    MemoryFactUpsert,
    MemoryQuery,
    NotificationClaim,
    NotificationClaimResult,
    NotificationCreate,
    NotificationFinish,
    NotificationList,
    NotificationQueued,
    NotificationRecord,
    NotificationStart,
    OperationCreate,
    OperationReceipt,
    OperationVerify,
    SourceInventoryPage,
    SourceInventoryReceipt,
    SourceList,
    TaskClaimResult,
    TaskCreate,
    TaskEventAppend,
    TaskEventReceipt,
    TaskEvents,
    TaskList,
    TaskPatch,
    TaskRecord,
    WorkflowList,
    WorkflowRecord,
    WorkflowScheduleEvent,
    WorkflowScheduleEventList,
    WorkModel,
)
from cyrene_navigator.work.store import WorkStore
from cyrene_navigator.work.tool_routes import mount_work_tool_routes

WorkAuthenticator = Callable[[Request, str], PersistencePrincipal]
_LOGGER = logging.getLogger(__name__)


class ConnectorBridge(Protocol):
    """Trusted, administrator-configured bridge for one local connector binding."""

    def health(self) -> Any | Awaitable[Any]:
        """Probe the configured connector host without accepting browser host details."""

    def request_qr(self, params: Mapping[str, Any]) -> Any | Awaitable[Any]:
        """Request a login QR from the trusted configured host."""

    def poll_login(self, params: Mapping[str, Any]) -> Any | Awaitable[Any]:
        """Poll a login id for the configured account and host."""


def mount_work_routes(
    app: FastAPI,
    db_path: Path,
    authenticate: WorkAuthenticator,
    *,
    attachment_root: Path | None = None,
    connector_bridges: Mapping[tuple[str | None, str, str], ConnectorBridge] | None = None,
) -> WorkStore:
    """Mount authenticated Work routes on an existing persistence app.

    Mutations use the existing PersistencePrincipal and require the trusted writer
    context. Reads remain limited to the authenticated Workspace. 连接器登录路由
    只访问启动器配置的本地桥接器,不会接受浏览器传入的主机或账号。
    """

    store = WorkStore(db_path, attachment_root)
    bridges = dict(connector_bridges or {})
    for organization_id, workspace_id, binding_id in bridges:
        store.seed_connector_binding(organization_id, workspace_id, binding_id)
    app.state.work_store = store
    app.state.work_connector_bridges = bridges
    base = "/api/v1/workspaces/{workspace_id}/work"
    mount_work_tool_routes(app, authenticate, bridges)

    def principal_for(
        request: Request, workspace_id: str, *, write: bool = False
    ) -> PersistencePrincipal:
        """Authenticate Workspace scope and require write authority for mutations."""

        principal = authenticate(request, workspace_id)
        if write and principal.organization_id is not None and not principal.can_takeover:
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "A trusted Workspace writer principal is required for Work mutations.",
            )
        return principal

    def require_bridge_owner(request: Request, workspace_id: str) -> PersistencePrincipal:
        """Restrict connector QR and login polling to trusted owners. | 限制二维码与登录操作。"""

        principal = authenticate(request, workspace_id)
        if not principal.can_takeover:
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "A trusted Workspace owner principal is required for connector login operations.",
            )
        return principal

    def require_bridge(
        principal: PersistencePrincipal, workspace_id: str, binding_id: str
    ) -> ConnectorBridge:
        """Resolve only a bridge installed by the trusted host configuration."""

        bridge = bridges.get((principal.organization_id, workspace_id, binding_id))
        if bridge is None:
            raise PersistenceError(
                "QQ_HOST_NOT_CONFIGURED",
                503,
                "No trusted connector bridge is configured for this binding.",
                retryable=True,
            )
        return bridge

    @app.post(base + "/tasks", response_model=TaskRecord, status_code=201)
    def create_task(
        workspace_id: str, body: TaskCreate, request: Request, response: Response
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        record, duplicate = store.create_task(
            principal.organization_id,
            workspace_id,
            body.model_dump(by_alias=True, exclude_none=True),
        )
        if duplicate:
            response.status_code = 200
        return record

    @app.get(base + "/tasks", response_model=TaskList)
    def list_tasks(
        workspace_id: str,
        request: Request,
        limit: int = Query(default=50, ge=1, le=100),
        cursor: str | None = Query(default=None, max_length=2_000),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        items, next_cursor = store.list_tasks(
            principal.organization_id, workspace_id, limit=limit, cursor=cursor
        )
        return {"items": items, "nextCursor": next_cursor}

    @app.get(base + "/tasks/{task_id}", response_model=TaskRecord)
    def get_task(workspace_id: str, task_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return store.get_task(principal.organization_id, workspace_id, task_id)

    @app.patch(base + "/tasks/{task_id}", response_model=TaskRecord)
    def patch_task(
        workspace_id: str, task_id: str, body: TaskPatch, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        patch = body.model_dump(by_alias=True, exclude_unset=True)
        return store.patch_task(principal.organization_id, workspace_id, task_id, patch)

    @app.post(base + "/tasks/{task_id}/claim", response_model=TaskClaimResult)
    def claim_task(workspace_id: str, task_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        claimed, task = store.claim_task(principal.organization_id, workspace_id, task_id)
        return {"claimed": claimed, "task": task}

    @app.get(base + "/tasks/{task_id}/events", response_model=TaskEvents)
    def get_task_events(
        workspace_id: str,
        task_id: str,
        request: Request,
        after: int = Query(default=0, ge=0),
        limit: int = Query(default=1_000, ge=1, le=10_000),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        events, next_seq = store.get_task_events(
            principal.organization_id, workspace_id, task_id, after, limit
        )
        return {"events": events, "nextSeq": next_seq}

    @app.post(base + "/tasks/{task_id}/events", response_model=TaskEventReceipt)
    def append_task_event(
        workspace_id: str, task_id: str, body: TaskEventAppend, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        seq, event, duplicate, task, created_at = store.append_task_event(
            principal.organization_id,
            workspace_id,
            task_id,
            body.event,
            body.message_id,
        )
        return {
            "seq": seq,
            "event": event,
            "createdAt": created_at,
            "duplicate": duplicate,
            "task": task,
        }

    @app.post(
        base + "/tasks/{task_id}/approvals",
        response_model=ApprovalReceipt,
        status_code=201,
    )
    def create_approval(
        workspace_id: str,
        task_id: str,
        body: ApprovalCreate,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        approval, task, duplicate = store.create_approval(
            principal.organization_id,
            workspace_id,
            task_id,
            body.model_dump(by_alias=True, exclude_none=True),
            principal.actor_id,
        )
        if duplicate:
            response.status_code = 200
        return {"approval": approval, "task": task, "duplicate": duplicate}

    @app.get(base + "/approvals", response_model=list[ApprovalRecord])
    def list_approvals(
        workspace_id: str,
        request: Request,
        status: str | None = Query(default=None),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> list[dict[str, Any]]:
        principal = principal_for(request, workspace_id)
        return store.list_approvals(principal.organization_id, workspace_id, status, limit)

    @app.get(base + "/approvals/{approval_id}", response_model=ApprovalRecord)
    def get_approval(workspace_id: str, approval_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return store.get_approval(principal.organization_id, workspace_id, approval_id)

    @app.post(base + "/approvals/{approval_id}/resolve", response_model=ApprovalReceipt)
    def resolve_approval(
        workspace_id: str,
        approval_id: str,
        body: ApprovalResolve,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        approval, task, duplicate = store.resolve_approval(
            principal.organization_id,
            workspace_id,
            approval_id,
            body.decision,
            body.message_id,
            principal.actor_id,
        )
        return {"approval": approval, "task": task, "duplicate": duplicate}

    @app.post(
        base + "/tasks/{task_id}/inputs",
        response_model=InputReceipt,
        status_code=201,
    )
    def create_input_request(
        workspace_id: str,
        task_id: str,
        body: InputRequestCreate,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        input_record, task, duplicate = store.create_input_request(
            principal.organization_id,
            workspace_id,
            task_id,
            body.model_dump(by_alias=True, exclude_none=True),
        )
        if duplicate:
            response.status_code = 200
        return {"input": input_record, "task": task, "duplicate": duplicate}

    @app.get(base + "/inputs", response_model=InputList)
    def list_input_requests(
        workspace_id: str,
        request: Request,
        status: str | None = Query(default=None),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {
            "items": store.list_input_requests(
                principal.organization_id, workspace_id, status, limit
            )
        }

    @app.get(base + "/inputs/{input_id}", response_model=InputRecord)
    def get_input_request(workspace_id: str, input_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return store.get_input_request(principal.organization_id, workspace_id, input_id)

    @app.post(base + "/inputs/{input_id}/resolve", response_model=InputReceipt)
    def resolve_input_request(
        workspace_id: str,
        input_id: str,
        body: InputResolve,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        input_record, task, duplicate = store.resolve_input_request(
            principal.organization_id,
            workspace_id,
            input_id,
            body.answer,
            body.message_id,
            principal.actor_id,
        )
        return {"input": input_record, "task": task, "duplicate": duplicate}

    @app.post(base + "/operations", response_model=OperationReceipt, status_code=201)
    def create_operation(
        workspace_id: str, body: OperationCreate, request: Request, response: Response
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        operation, duplicate = store.create_operation(
            principal.organization_id,
            workspace_id,
            body.model_dump(by_alias=True, exclude_none=True),
        )
        if duplicate:
            response.status_code = 200
        return {"operation": operation, "duplicate": duplicate}

    @app.get(base + "/operations/{operation_id}", response_model=OperationReceipt)
    def get_operation(workspace_id: str, operation_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {
            "operation": store.get_operation(principal.organization_id, workspace_id, operation_id)
        }

    @app.patch(base + "/operations/{operation_id}", response_model=OperationReceipt)
    def update_operation(
        workspace_id: str,
        operation_id: str,
        body: OperationVerify,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        operation, duplicate = store.update_operation(
            principal.organization_id,
            workspace_id,
            operation_id,
            body.status,
            body.evidence,
        )
        return {"operation": operation, "duplicate": duplicate}

    @app.post(base + "/memory/facts", response_model=MemoryFact)
    def upsert_memory_fact(
        workspace_id: str, body: MemoryFactUpsert, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        return store.upsert_memory_fact(
            principal.organization_id,
            workspace_id,
            body.model_dump(by_alias=True, exclude_none=True),
        )

    @app.get(base + "/memory/facts", response_model=MemoryFacts)
    def list_memory_facts(
        workspace_id: str,
        request: Request,
        include_stale: bool = Query(default=True),
        limit: int = Query(default=500, ge=1, le=1_000),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {
            "items": store.list_memory_facts(
                principal.organization_id,
                workspace_id,
                include_stale=include_stale,
                limit=limit,
            )
        }

    @app.post(base + "/memory/query", response_model=MemoryFacts)
    def query_memory(workspace_id: str, body: MemoryQuery, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {
            "items": store.query_memory(
                principal.organization_id,
                workspace_id,
                body.query,
                limit=body.limit,
                include_stale=body.include_stale,
            )
        }

    @app.get(base + "/sources", response_model=SourceList)
    def list_sources(workspace_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {"items": store.list_sources(principal.organization_id, workspace_id)}

    @app.get(base + "/sources/{source_id}/facts")
    def list_source_facts(
        workspace_id: str,
        source_id: str,
        request: Request,
        include_missing: bool = Query(default=False),
        limit: int = Query(default=1_000, ge=1, le=5_000),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {
            "items": store.list_source_facts(
                principal.organization_id,
                workspace_id,
                source_id,
                include_missing=include_missing,
                limit=limit,
            )
        }

    @app.post(base + "/sources/{source_id}/inventory", response_model=SourceInventoryReceipt)
    def ingest_source_page(
        workspace_id: str,
        source_id: str,
        body: SourceInventoryPage,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        return store.ingest_source_page(
            principal.organization_id,
            workspace_id,
            source_id,
            body.model_dump(by_alias=True, exclude_none=True),
        )

    @app.post(base + "/notifications", response_model=NotificationQueued, status_code=201)
    def queue_notification(
        workspace_id: str,
        body: NotificationCreate,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        notification, duplicate = store.create_notification(
            principal.organization_id,
            workspace_id,
            body.model_dump(by_alias=True, exclude_none=True),
        )
        if duplicate:
            response.status_code = 200
        return {"notification": notification, "duplicate": duplicate}

    @app.get(base + "/notifications", response_model=NotificationList)
    def list_notifications(
        workspace_id: str,
        request: Request,
        status: str | None = Query(default=None),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {
            "items": store.list_notifications(
                principal.organization_id, workspace_id, status=status, limit=limit
            )
        }

    @app.post(base + "/notifications/claim", response_model=NotificationClaimResult)
    def claim_notifications(
        workspace_id: str, body: NotificationClaim, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        return {
            "items": store.claim_notifications(
                principal.organization_id,
                workspace_id,
                body.worker_id,
                body.limit,
                body.lease_seconds,
                notification_type=body.type,
                connector_id=body.connector_id,
                recipient=body.recipient,
            )
        }

    @app.post(
        base + "/notifications/{notification_id}/start",
        response_model=NotificationRecord,
    )
    def start_notification(
        workspace_id: str,
        notification_id: str,
        body: NotificationStart,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        return store.start_notification(
            principal.organization_id, workspace_id, notification_id, body.lease_token
        )

    @app.post(
        base + "/notifications/{notification_id}/finish",
        response_model=NotificationRecord,
    )
    def finish_notification(
        workspace_id: str,
        notification_id: str,
        body: NotificationFinish,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        return store.finish_notification(
            principal.organization_id,
            workspace_id,
            notification_id,
            body.lease_token,
            body.outcome,
            body.result,
        )

    @app.post(base + "/attachments", response_model=AttachmentRecord, status_code=201)
    def upload_attachment(
        workspace_id: str, body: AttachmentCreate, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        try:
            raw = base64.b64decode(body.content_base64, validate=True)
        except ValueError as exc:
            raise PersistenceError(
                "WORK_ATTACHMENT_INVALID_ENCODING",
                422,
                "contentBase64 must use standard base64 encoding.",
            ) from exc
        return store.put_attachment(
            principal.organization_id, workspace_id, body.name, body.media_type, raw
        )

    @app.get(base + "/attachments/{digest}", response_model=None)
    def download_attachment(workspace_id: str, digest: str, request: Request) -> FileResponse:
        principal = principal_for(request, workspace_id)
        metadata, path = store.get_attachment(principal.organization_id, workspace_id, digest)
        return FileResponse(path, media_type=metadata["mediaType"], filename=metadata["name"])

    @app.get(base + "/connectors", response_model=ConnectorList)
    def list_connectors(workspace_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {"items": store.list_connectors(principal.organization_id, workspace_id)}

    @app.post(base + "/connectors/{connector_id}/status", response_model=ConnectorRecord)
    def update_connector_status(
        workspace_id: str,
        connector_id: str,
        body: ConnectorStatusUpdate,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        return store.update_connector_status(
            principal.organization_id,
            workspace_id,
            connector_id,
            body.model_dump(by_alias=True, exclude_none=True),
        )

    @app.post(base + "/connectors/{connector_id}/events", response_model=ConnectorEventReceipt)
    def register_connector_event(
        workspace_id: str,
        connector_id: str,
        body: ConnectorEventCreate,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        receipt, task = store.register_connector_event(
            principal.organization_id,
            workspace_id,
            connector_id,
            body.model_dump(by_alias=True, exclude_none=True),
        )
        if receipt["duplicate"]:
            response.status_code = 200
        return {**receipt, "task": task}

    @app.get(base + "/connectors/{connector_id}/events", response_model=ConnectorEvents)
    def list_connector_events(
        workspace_id: str,
        connector_id: str,
        request: Request,
        after: int = Query(default=0, ge=0),
        limit: int = Query(default=100, ge=1, le=1_000),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        events, next_seq = store.list_connector_events(
            principal.organization_id, workspace_id, connector_id, after, limit
        )
        return {"events": events, "nextSeq": next_seq}

    @app.get(base + "/workflows", response_model=WorkflowList)
    def list_workflows(workspace_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {"items": store.list_workflows(principal.organization_id, workspace_id)}

    @app.put(base + "/workflows/{workflow_id}", response_model=WorkflowRecord)
    def put_workflow(
        workspace_id: str,
        workflow_id: str,
        body: WorkflowRecord,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        value = body.model_dump(by_alias=True, exclude_none=True)
        if value["id"] != workflow_id:
            raise PersistenceError(
                "WORK_WORKFLOW_ID_MISMATCH",
                422,
                "The route workflowId must match body id.",
            )
        return store.put_workflow(principal.organization_id, workspace_id, value)

    @app.post(base + "/schedule-events", response_model=WorkflowScheduleEvent)
    def append_schedule_event(
        workspace_id: str,
        body: WorkflowScheduleEvent,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        return store.append_schedule_event(
            principal.organization_id,
            workspace_id,
            body.model_dump(by_alias=True, exclude_none=True),
        )

    @app.get(base + "/schedule-events", response_model=WorkflowScheduleEventList)
    def list_schedule_events(
        workspace_id: str,
        request: Request,
        workflow_id: str | None = Query(default=None, max_length=512),
        limit: int = Query(default=100, ge=1, le=500),
        cursor: str | None = Query(default=None, max_length=2_000),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return store.list_schedule_events(
            principal.organization_id,
            workspace_id,
            workflow_id,
            limit,
            cursor,
        )

    @app.get(base + "/connectors/{binding_id}/health")
    async def connector_health(workspace_id: str, binding_id: str, request: Request) -> Any:
        principal = require_bridge_owner(request, workspace_id)
        bridge = require_bridge(principal, workspace_id, binding_id)
        health = getattr(bridge, "health", None) or getattr(bridge, "tohealth", None)
        if health is None:
            raise PersistenceError(
                "QQ_HOST_NOT_CONFIGURED",
                503,
                "The connector bridge has no health probe.",
            )
        return jsonable_encoder(await _call_bridge(health))

    @app.post(base + "/connectors/{binding_id}/login/qr")
    async def connector_login_qr(workspace_id: str, binding_id: str, request: Request) -> Any:
        principal = require_bridge_owner(request, workspace_id)
        bridge = require_bridge(principal, workspace_id, binding_id)
        return jsonable_encoder(await _call_bridge(bridge.request_qr, {}))

    @app.post(base + "/connectors/{binding_id}/login/poll")
    async def connector_login_poll(
        workspace_id: str, binding_id: str, body: LoginPollRequest, request: Request
    ) -> Any:
        principal = require_bridge_owner(request, workspace_id)
        bridge = require_bridge(principal, workspace_id, binding_id)
        return jsonable_encoder(await _call_bridge(bridge.poll_login, {"login_id": body.login_id}))

    async def close_connector_bridges() -> None:
        """Close configured local bridges during application shutdown. | 关闭连接器子进程。"""

        closed: set[int] = set()
        for bridge in bridges.values():
            if id(bridge) in closed:
                continue
            closed.add(id(bridge))
            close = getattr(bridge, "close", None)
            if close is not None:
                await _call_bridge(close)

    if bridges:
        previous_lifespan = app.router.lifespan_context

        @asynccontextmanager
        async def work_lifespan(application: FastAPI) -> Any:
            """Start configured adapter workers in background and reap them on shutdown. |
            管理适配器生命周期。
            """

            async with previous_lifespan(application):
                start_tasks: list[asyncio.Task[Any]] = []
                started: set[int] = set()
                for bridge in bridges.values():
                    if id(bridge) in started:
                        continue
                    started.add(id(bridge))
                    start = getattr(bridge, "start", None)
                    if callable(start):
                        task = asyncio.create_task(_call_bridge(start))
                        task.add_done_callback(_report_background_failure)
                        start_tasks.append(task)
                try:
                    yield
                finally:
                    await close_connector_bridges()
                    for task in start_tasks:
                        if not task.done():
                            task.cancel()
                    if start_tasks:
                        await asyncio.gather(*start_tasks, return_exceptions=True)

        app.router.lifespan_context = work_lifespan
    return store


class LoginPollRequest(WorkModel):
    """Accept a login identifier only; host, path and account come from trusted config."""

    login_id: str


async def _call_bridge(function: Callable[..., Any], *args: Any) -> Any:
    """Call either synchronous or asynchronous trusted bridge implementations. | 调用本地桥。"""

    try:
        if inspect.iscoroutinefunction(function):
            return await function(*args)
        result = await asyncio.to_thread(function, *args)
        if inspect.isawaitable(result):
            return await result
        return result
    except PersistenceError:
        raise
    except Exception as exc:
        error_code = getattr(exc, "code", None)
        if error_code in {
            "UNSUPPORTED",
            "UNSUPPORTED_OPERATION",
            "UNAVAILABLE",
            "NOT_AVAILABLE",
            "NOT_CONFIGURED",
            "NOT_RUN",
            "HOST_NOT_CONFIGURED",
        }:
            raise PersistenceError(
                "CONNECTOR_OPERATION_UNAVAILABLE",
                503,
                "The configured connector does not provide this operation.",
                retryable=True,
            ) from None
        raise PersistenceError(
            "CONNECTOR_BRIDGE_FAILED",
            502,
            "The configured connector request failed.",
            retryable=True,
        ) from None


def _report_background_failure(task: asyncio.Task[Any]) -> None:
    """Retrieve a failed task without logging potentially sensitive text. | 仅记录后台错误类型。"""

    if task.cancelled():
        return
    error = task.exception()
    if error is not None:
        _LOGGER.error("configured connector background task stopped: %s", type(error).__name__)
