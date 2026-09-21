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
from cyrene_navigator.errors import map_navigator_error
from cyrene_navigator.logging import (
    emit_diagnostic_error,
    parse_w3c_traceparent,
    sanitize_request_id,
)
from cyrene_navigator.reader import HttpxProductReader, ProductReadPort
from cyrene_navigator.service import NavigatorService


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
        parsed_trace = parse_w3c_traceparent(request.headers.get("traceparent"))
        trace_id = parsed_trace[0] if parsed_trace else uuid4().hex
        parent_span_id = parsed_trace[1] if parsed_trace else "0000000000000001"
        traceparent = f"00-{trace_id}-{parent_span_id}-01"
        request_id = sanitize_request_id(request.headers.get("x-request-id")) or uuid4().hex

        tracestate = request.headers.get("tracestate")
        request.state.trace_id = trace_id
        request.state.span_id = parent_span_id
        request.state.traceparent = traceparent
        request.state.tracestate = tracestate
        request.state.request_id = request_id

        response = await call_next(request)
        response.headers["traceparent"] = traceparent
        response.headers["x-request-id"] = request_id
        if tracestate:
            response.headers["tracestate"] = tracestate
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, _exc: RequestValidationError) -> JSONResponse:
        mapped = map_navigator_error("NAVIGATOR_REQUEST_INVALID")
        canonical_code = mapped["code"]
        recovery_action = mapped.get("recovery_action")

        trace_id = getattr(request.state, "trace_id", None) or uuid4().hex
        span_id = getattr(request.state, "span_id", None)
        request_id = getattr(request.state, "request_id", None)

        emit_diagnostic_error(
            "product.navigator.validation_error",
            canonical_code,
            "The request does not conform to the Navigator API v1 contract.",
            trace_id=trace_id,
            span_id=span_id,
            attributes={
                "request_id": request_id,
                "cause_kind": mapped.get("cause_kind"),
                "status": 422,
                "path": request.url.path,
            },
        )

        problem = ProblemDetails(
            type=f"https://errors.cyrene.dev/navigator/{canonical_code.lower()}",
            title="Request validation failed",
            status=422,
            detail="The request does not conform to the Navigator API v1 contract.",
            instance=request.url.path,
            code="NAVIGATOR_REQUEST_INVALID",
            retryable=False,
            trace_id=trace_id,
            request_id=request_id,
            recovery_action=recovery_action,
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
