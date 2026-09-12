"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 api.py                                                          │
│  Module: cyrene_navigator.api                                       │
│  Role: Versioned non-mutating aggregation HTTP adapter.              │
│                                                                     │
│  模块职责：版本化非变更聚合 HTTP 适配器。                                 │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Mapping
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from cyrene_navigator.domain import (
    ProblemDetails,
    Product,
    SnapshotRequest,
    WorkspaceSnapshot,
)
from cyrene_navigator.reader import HttpxProductReader, ProductReadPort
from cyrene_navigator.service import NavigatorService

_TRACEPARENT = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$")


def _incoming_trace_id(value: str) -> str | None:
    match = _TRACEPARENT.fullmatch(value)
    if match is None or match.group(1) == "0" * 32 or match.group(2) == "0" * 16:
        return None
    return match.group(1)


def create_app(
    *, directory: Mapping[Product, str], reader: ProductReadPort | None = None
) -> FastAPI:
    """Build Navigator with an explicit Product directory. | 使用显式产品目录创建应用。"""

    service = NavigatorService(directory, reader or HttpxProductReader())
    app = FastAPI(title="Cyrene Navigator Aggregation API", version="1.0.0")
    app.state.navigator_service = service

    @app.middleware("http")
    async def propagate_trace(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        incoming = request.headers.get("traceparent", "")
        trace_id = _incoming_trace_id(incoming)
        if trace_id is None:
            trace_id = uuid4().hex
            traceparent = f"00-{trace_id}-0000000000000001-01"
        else:
            traceparent = incoming
        tracestate = request.headers.get("tracestate") if incoming == traceparent else None
        request.state.trace_id = trace_id
        request.state.traceparent = traceparent
        request.state.tracestate = tracestate
        response = await call_next(request)
        response.headers["traceparent"] = traceparent
        if tracestate:
            response.headers["tracestate"] = tracestate
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, _exc: RequestValidationError) -> JSONResponse:
        problem = ProblemDetails(
            type="https://errors.cyrene.dev/navigator/request-invalid",
            title="Request validation failed",
            status=422,
            detail="The request does not conform to the Navigator API v1 contract.",
            instance=request.url.path,
            code="NAVIGATOR_REQUEST_INVALID",
            retryable=False,
            trace_id=request.state.trace_id,
        )
        return JSONResponse(
            status_code=422,
            content=problem.model_dump(by_alias=True, mode="json"),
            media_type="application/problem+json",
        )

    @app.post(
        "/api/v1/workspace-snapshots",
        response_model=WorkspaceSnapshot,
        response_model_exclude_none=True,
    )
    def observe_snapshot(command: SnapshotRequest, request: Request) -> WorkspaceSnapshot:
        return service.observe(
            command,
            request.state.traceparent,
            request.state.tracestate,
        )

    return app
