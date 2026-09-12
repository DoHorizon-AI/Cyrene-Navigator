"""
┌─────────────────────────────────────────────────────────────────────┐
│  Module: cyrene_navigator.persistence.api                          │
│  Role: Authenticated Harness persistence and Product metadata API.   │
│                                                                     │
│  模块职责：提供 Workspace 隔离、RFC 9457 错误和持久化服务工厂。             │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from cyrene_navigator.persistence.echo_handoff import EchoHandoff, EchoReceipt, SendToEcho
from cyrene_navigator.persistence.errors import (
    WORKSPACE_FORBIDDEN,
    WORKSPACE_UNAUTHORIZED,
    PersistenceError,
)
from cyrene_navigator.persistence.models import (
    AppendRequest,
    EventsView,
    HandleOpenRequest,
    HandleView,
    MutationRequest,
    MutationView,
    ProductMetadata,
    SessionCreateRequest,
    Snapshot,
    SnapshotList,
)
from cyrene_navigator.persistence.store import PersistencePrincipal, PersistenceStore

_SESSIONS_PATH = "/api/v1/harness/workspaces/{workspace_id}/sessions"


def create_persistence_app(
    db_path: Path,
    principals: Mapping[str, PersistencePrincipal],
    lease_seconds: float = 120,
    *,
    artifact_root: Path | None = None,
    echo_url: str | None = None,
) -> FastAPI:
    """Build the authoritative Harness persistence HTTP service. | 创建持久化 HTTP 服务。"""

    configured_principals = dict(principals)
    if any(not isinstance(token, str) or not token for token in configured_principals):
        raise ValueError("principal bearer tokens must be non-empty strings")
    if any(
        not isinstance(principal, PersistencePrincipal)
        for principal in configured_principals.values()
    ):
        raise TypeError("principals must contain PersistencePrincipal values")

    store = PersistenceStore(Path(db_path), lease_seconds=lease_seconds)
    app = FastAPI(title="Cyrene Navigator Harness Persistence API", version="1.0.0")
    app.state.persistence_store = store
    app.state.persistence_principals = configured_principals
    handoff = EchoHandoff(store, artifact_root, echo_url)
    app.state.echo_handoff = handoff

    @app.post(
        _SESSIONS_PATH + "/{session_id}/actions/send-to-echo",
        response_model=EchoReceipt,
        status_code=201,
    )
    def send_to_echo(
        workspace_id: str, session_id: str, body: SendToEcho, request: Request
    ) -> EchoReceipt:
        authenticate(request, workspace_id)
        return handoff.send(workspace_id, session_id, body)

    @app.exception_handler(PersistenceError)
    async def persistence_error(request: Request, exc: PersistenceError) -> JSONResponse:
        """Render stable RFC 9457 persistence failures. | 返回稳定 RFC 9457 错误。"""

        trace_id = uuid4().hex
        content = {
            "type": f"https://errors.cyrene.dev/navigator/persistence/{exc.code.lower()}",
            "title": exc.code.replace("_", " ").title(),
            "status": exc.status,
            "detail": exc.detail,
            "instance": request.url.path,
            "code": exc.code,
            "retryable": exc.retryable,
            "traceId": trace_id,
        }
        headers = {"WWW-Authenticate": "Bearer"} if exc.status == 401 else None
        return JSONResponse(
            status_code=exc.status,
            content=content,
            headers=headers,
            media_type="application/problem+json",
        )

    @app.exception_handler(RequestValidationError)
    async def request_validation_error(
        request: Request, _exc: RequestValidationError
    ) -> JSONResponse:
        """Render a stable boundary-validation problem. | 返回稳定边界校验错误。"""

        trace_id = uuid4().hex
        return JSONResponse(
            status_code=422,
            content={
                "type": "https://errors.cyrene.dev/navigator/persistence/request-invalid",
                "title": "Persistence Request Invalid",
                "status": 422,
                "detail": "The request does not conform to the Harness persistence contract.",
                "instance": request.url.path,
                "code": "PERSISTENCE_REQUEST_INVALID",
                "retryable": False,
                "traceId": trace_id,
            },
            media_type="application/problem+json",
        )

    def authenticate(request: Request, workspace_id: str) -> PersistencePrincipal:
        """Resolve a configured bearer identity and enforce Workspace scope. | 验证身份与租户。"""

        authorization = request.headers.get("authorization", "")
        if not authorization.startswith("Bearer ") or not authorization[7:].strip():
            raise PersistenceError(
                WORKSPACE_UNAUTHORIZED,
                401,
                "A bearer credential is required for Harness persistence.",
            )
        token = authorization[7:]
        principal = configured_principals.get(token)
        if principal is None:
            raise PersistenceError(
                WORKSPACE_UNAUTHORIZED,
                401,
                "The bearer credential is not recognized.",
            )
        if workspace_id not in principal.workspace_ids:
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "The authenticated principal is not a member of this Workspace.",
            )
        return principal

    @app.post(
        _SESSIONS_PATH,
        response_model=HandleView,
        response_model_exclude_none=True,
    )
    def create_session(
        workspace_id: str, body: SessionCreateRequest, request: Request
    ) -> dict[str, object]:
        """Create and own one session. | 创建并持有一个会话。"""

        principal = authenticate(request, workspace_id)
        record = store.create_session(
            workspace_id,
            body.header["id"] if isinstance(body.header.get("id"), str) else "",
            body.header,
            body.inherited_event_count,
            principal,
            body.client_id,
        )
        return record.as_dict()

    @app.get(
        _SESSIONS_PATH,
        response_model=SnapshotList,
        response_model_exclude_none=True,
    )
    def list_sessions(workspace_id: str, request: Request) -> dict[str, object]:
        """List Workspace sessions without write capabilities. | 列出 Workspace 会话。"""

        authenticate(request, workspace_id)
        return {"items": store.list_snapshots(workspace_id)}

    @app.get(
        _SESSIONS_PATH + "/{session_id}",
        response_model=Snapshot,
        response_model_exclude_none=True,
    )
    def get_session(workspace_id: str, session_id: str, request: Request) -> dict[str, object]:
        """Read one Workspace session snapshot. | 读取一个会话快照。"""

        authenticate(request, workspace_id)
        return store.get_snapshot(workspace_id, session_id)

    @app.get(
        _SESSIONS_PATH + "/{session_id}/metadata",
        response_model=ProductMetadata,
        response_model_exclude_none=False,
    )
    def get_product_metadata(
        workspace_id: str, session_id: str, request: Request
    ) -> dict[str, object]:
        """Read Product metadata independently of the Harness header and writer lease.

        独立读取产品元数据；不把 Harness header 或可变 writer lease 当作产品身份。
        """

        authenticate(request, workspace_id)
        return store.get_product_metadata(workspace_id, session_id)

    @app.post(
        _SESSIONS_PATH + "/{session_id}/handles",
        response_model=HandleView,
        response_model_exclude_none=True,
    )
    def open_handle(
        workspace_id: str,
        session_id: str,
        body: HandleOpenRequest,
        request: Request,
    ) -> dict[str, object]:
        """Open a read handle or an explicitly fenced write handle. | 打开读写句柄。"""

        principal = authenticate(request, workspace_id)
        record = store.open_handle(
            workspace_id,
            session_id,
            body.access,
            principal,
            body.client_id,
            body.takeover_expected_epoch,
        )
        return record.as_dict()

    @app.get(
        _SESSIONS_PATH + "/{session_id}/events",
        response_model=EventsView,
        response_model_exclude_none=True,
    )
    def read_events(
        workspace_id: str,
        session_id: str,
        request: Request,
        offset: int = Query(default=0, ge=0),
        length: int = Query(default=10_000, ge=0, le=10_000),
    ) -> dict[str, object]:
        """Read a committed event slice. | 读取已提交事件片段。"""

        authenticate(request, workspace_id)
        events, next_seq = store.read_events(workspace_id, session_id, offset, length)
        return {"events": events, "nextSeq": next_seq}

    @app.post(
        _SESSIONS_PATH + "/{session_id}/append",
        response_model=MutationView,
        response_model_exclude_none=True,
    )
    def append_events(
        workspace_id: str,
        session_id: str,
        body: AppendRequest,
        request: Request,
    ) -> dict[str, object]:
        """Append an atomically committed event batch. | 原子提交事件批次。"""

        principal = authenticate(request, workspace_id)
        next_seq = store.append_events(
            workspace_id,
            session_id,
            principal,
            body.writer_token,
            body.epoch,
            body.batch_id,
            body.events,
        )
        return {"nextSeq": next_seq}

    @app.post(
        _SESSIONS_PATH + "/{session_id}/flush",
        response_model=MutationView,
        response_model_exclude_none=True,
    )
    def flush(
        workspace_id: str,
        session_id: str,
        body: MutationRequest,
        request: Request,
    ) -> dict[str, object]:
        """Confirm the durable event prefix. | 确认已持久化事件前缀。"""

        principal = authenticate(request, workspace_id)
        next_seq, lease_expires_at = store.flush(
            workspace_id, session_id, principal, body.writer_token, body.epoch
        )
        return {"nextSeq": next_seq, "leaseExpiresAt": lease_expires_at}

    @app.post(
        _SESSIONS_PATH + "/{session_id}/heartbeat",
        response_model=MutationView,
        response_model_exclude_none=True,
    )
    def heartbeat(
        workspace_id: str,
        session_id: str,
        body: MutationRequest,
        request: Request,
    ) -> dict[str, object]:
        """Renew a current write lease. | 续期当前写租约。"""

        principal = authenticate(request, workspace_id)
        next_seq, lease_expires_at = store.heartbeat(
            workspace_id, session_id, principal, body.writer_token, body.epoch
        )
        return {"nextSeq": next_seq, "leaseExpiresAt": lease_expires_at}

    @app.post(
        _SESSIONS_PATH + "/{session_id}/release",
        response_model=MutationView,
        response_model_exclude_none=True,
    )
    def release(
        workspace_id: str,
        session_id: str,
        body: MutationRequest,
        request: Request,
    ) -> dict[str, object]:
        """Release the current write lease after fencing. | 释放当前写租约。"""

        principal = authenticate(request, workspace_id)
        next_seq = store.release(workspace_id, session_id, principal, body.writer_token, body.epoch)
        return {"nextSeq": next_seq}

    return app
