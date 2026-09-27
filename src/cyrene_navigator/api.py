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

import hashlib
from collections.abc import Awaitable, Callable, Mapping
from typing import Annotated
from uuid import uuid4

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

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
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.reader import HttpxProductReader, ProductReadPort
from cyrene_navigator.service import NavigatorService, ProductCredentialKey

_PRODUCT_BEARER = HTTPBearer(auto_error=False, scheme_name="NavigatorProductBearer")


class SnapshotAuthorizationError(Exception):
    """A safe, non-sensitive Workspace snapshot authorization failure."""

    def __init__(self, status: int, code: str, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail


class SnapshotServiceUnavailable(Exception):
    """The internal snapshot service lacks required server configuration."""


def create_app(
    *,
    directory: Mapping[Product, str],
    reader: ProductReadPort | None = None,
    principals: Mapping[str, PersistencePrincipal] | None = None,
    service_credentials: Mapping[ProductCredentialKey, str] | None = None,
    require_service_configuration: bool = False,
) -> FastAPI:
    """Build Navigator with server-owned Product and Workspace identity maps.

    中文:使用服务端管理的 Product 目录、身份映射和下游 service credential 创建 Navigator。
    """

    configured_principals = dict(principals or {})
    if any(
        not isinstance(token, str)
        or not token
        or len(token) > 8192
        or any(ord(character) < 33 or ord(character) > 126 for character in token)
        for token in configured_principals
    ):
        raise ValueError("principal credentials must be bounded visible-ASCII bearer tokens")
    if any(
        not isinstance(principal, PersistencePrincipal)
        for principal in configured_principals.values()
    ):
        raise TypeError("principals must contain PersistencePrincipal values")
    principal_digests = {
        hashlib.sha256(token.encode("utf-8")).hexdigest(): principal
        for token, principal in configured_principals.items()
    }
    configured_service_credentials = _validate_service_credentials(service_credentials or {})
    if set(configured_principals).intersection(configured_service_credentials.values()):
        raise ValueError("frontend and Product service bearer credentials must be distinct")
    service = NavigatorService(
        directory,
        reader or HttpxProductReader(),
        configured_service_credentials,
    )
    app = FastAPI(title="Cyrene Navigator Aggregation API", version="1.0.0")
    app.state.navigator_service = service
    app.state.workspace_principal_digests = principal_digests

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

    @app.exception_handler(SnapshotAuthorizationError)
    async def snapshot_authorization_error(
        request: Request, exc: SnapshotAuthorizationError
    ) -> JSONResponse:
        """Return a stable authorization problem without exposing bearer details."""

        trace_id = getattr(request.state, "trace_id", None) or uuid4().hex
        request_id = getattr(request.state, "request_id", None)
        problem = ProblemDetails(
            type=f"https://errors.cyrene.dev/navigator/{exc.code.lower()}",
            title="Workspace authorization failed",
            status=exc.status,
            detail=exc.detail,
            instance=request.url.path,
            code=exc.code,
            retryable=False,
            trace_id=trace_id,
            request_id=request_id,
            recovery_action="fix_configuration",
        )
        headers = {"WWW-Authenticate": "Bearer"} if exc.status == 401 else None
        return JSONResponse(
            status_code=exc.status,
            content=problem.model_dump(by_alias=True, mode="json", exclude_none=True),
            headers=headers,
            media_type="application/problem+json",
        )

    @app.exception_handler(SnapshotServiceUnavailable)
    async def snapshot_service_unavailable(
        request: Request, _exc: SnapshotServiceUnavailable
    ) -> JSONResponse:
        """Hide incomplete operator config behind an RFC 9457 503 response."""

        trace_id = getattr(request.state, "trace_id", None) or uuid4().hex
        request_id = getattr(request.state, "request_id", None)
        problem = ProblemDetails(
            type="https://errors.cyrene.dev/navigator/navigator_workspace_service_unavailable",
            title="Workspace service unavailable",
            status=503,
            detail="The internal Workspace snapshot service is not configured for this request.",
            instance=request.url.path,
            code="NAVIGATOR_WORKSPACE_SERVICE_UNAVAILABLE",
            retryable=True,
            trace_id=trace_id,
            request_id=request_id,
            recovery_action="fix_configuration",
        )
        return JSONResponse(
            status_code=503,
            content=problem.model_dump(by_alias=True, mode="json", exclude_none=True),
            headers={"Retry-After": "30"},
            media_type="application/problem+json",
        )

    @app.post(
        "/api/v1/workspace-snapshots",
        response_model=WorkspaceSnapshot,
        response_model_exclude_none=True,
        responses={
            401: {"model": ProblemDetails},
            403: {"model": ProblemDetails},
            503: {"model": ProblemDetails},
        },
    )
    def observe_snapshot(
        command: SnapshotRequest,
        request: Request,
        credentials: Annotated[
            HTTPAuthorizationCredentials | None,
            Depends(_PRODUCT_BEARER),
        ],
    ) -> WorkspaceSnapshot:
        if require_service_configuration and (
            not principal_digests or not directory or not configured_service_credentials
        ):
            raise SnapshotServiceUnavailable
        principal = _authenticate_snapshot_principal(
            credentials, command.workspace_id, principal_digests
        )
        assert principal.organization_id is not None
        if require_service_configuration and any(
            read.product not in directory
            or (read.product, principal.organization_id, command.workspace_id)
            not in configured_service_credentials
            for read in command.reads
        ):
            raise SnapshotServiceUnavailable
        return service.observe(
            command,
            principal.organization_id,
            request.state.traceparent,
            request.state.tracestate,
        )

    return app


def _authenticate_snapshot_principal(
    credentials: HTTPAuthorizationCredentials | None,
    workspace_id: str,
    principal_digests: Mapping[str, PersistencePrincipal],
) -> PersistencePrincipal:
    """Bind a verified server principal to both organization and body Workspace."""

    if credentials is None or not credentials.credentials.strip():
        raise SnapshotAuthorizationError(
            401,
            "NAVIGATOR_WORKSPACE_UNAUTHORIZED",
            "A bearer credential is required for Workspace snapshots.",
        )
    digest = hashlib.sha256(credentials.credentials.strip().encode("utf-8")).hexdigest()
    principal = principal_digests.get(digest)
    if principal is None:
        raise SnapshotAuthorizationError(
            401,
            "NAVIGATOR_WORKSPACE_UNAUTHORIZED",
            "The bearer credential is not recognized.",
        )
    if principal.organization_id is None:
        raise SnapshotAuthorizationError(
            403,
            "NAVIGATOR_WORKSPACE_FORBIDDEN",
            "Workspace snapshots require an organization-scoped server principal.",
        )
    if workspace_id not in principal.workspace_ids:
        raise SnapshotAuthorizationError(
            403,
            "NAVIGATOR_WORKSPACE_FORBIDDEN",
            "The authenticated principal is not assigned to this Workspace.",
        )
    return principal


def _validate_service_credentials(
    configured: Mapping[ProductCredentialKey, str],
) -> dict[ProductCredentialKey, str]:
    """Copy and validate owner-scoped secrets without logging or normalizing them."""

    credentials: dict[ProductCredentialKey, str] = {}
    seen_tokens: set[str] = set()
    for key, token in configured.items():
        if not isinstance(key, tuple) or len(key) != 3:
            raise ValueError("service credential keys must be (Product, organization, workspace)")
        product, organization_id, workspace_id = key
        if (
            not isinstance(product, Product)
            or not isinstance(organization_id, str)
            or not organization_id.strip()
            or len(organization_id) > 200
            or not isinstance(workspace_id, str)
            or not workspace_id.strip()
            or len(workspace_id) > 200
        ):
            raise ValueError("service credential scopes must identify one Product and Workspace")
        if (
            not isinstance(token, str)
            or not token
            or len(token) > 8192
            or any(ord(character) < 33 or ord(character) > 126 for character in token)
        ):
            raise ValueError("service credentials must be bounded visible-ASCII bearer tokens")
        if token in seen_tokens:
            raise ValueError("Product service bearers must be unique to one owner and Workspace")
        seen_tokens.add(token)
        credentials[key] = token
    return credentials
