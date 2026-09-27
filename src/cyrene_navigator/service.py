"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 service.py                                                      │
│  Module: cyrene_navigator.service                                   │
│  Role: Non-authoritative Product view aggregation.                   │
│                                                                     │
│  模块职责：非权威产品视图聚合。                                         │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from ipaddress import ip_address
from urllib.parse import urlsplit

from cyrene_navigator.domain import (
    ObservationProblem,
    Product,
    ProductReadOperation,
    ProductResourceSummary,
    ProductView,
    SnapshotRequest,
    SnapshotStatus,
    ViewStatus,
    WorkspaceSnapshot,
    utc_now,
)
from cyrene_navigator.reader import ProductReadFailure, ProductReadPort

ProductCredentialKey = tuple[Product, str, str]
_MAX_SNAPSHOT_JSON_BYTES = 4 * 1024 * 1024
_MAX_SNAPSHOT_ENVELOPE_BYTES = 8192
_MAX_VIEW_ENVELOPE_BYTES = 4096
_MAX_PRODUCT_BASE_URL_CHARS = 2048

_WORKSPACE_READ_OPERATIONS = {
    Product.CATALYST: (
        "/internal/workspace/v1/datasets",
        ProductReadOperation.CATALYST_LIST_DATASETS,
    ),
    Product.EXCHANGE: (
        "/api/v1/workspace/gateway-routes",
        ProductReadOperation.EXCHANGE_LIST_GATEWAY_ROUTES,
    ),
    Product.REACTOR: (
        "/internal/workspace/v1/model-imports",
        ProductReadOperation.REACTOR_LIST_MODEL_IMPORTS,
    ),
}


class NavigatorService:
    """Aggregate owner views without storing or interpreting them. | 聚合但不存储或解释。"""

    def __init__(
        self,
        directory: Mapping[Product, str],
        reader: ProductReadPort,
        service_credentials: Mapping[ProductCredentialKey, str] | None = None,
    ) -> None:
        self._directory = {
            product: _validate_product_base_url(url) for product, url in directory.items()
        }
        self._reader = reader
        self._service_credentials = dict(service_credentials or {})

    def observe(
        self,
        command: SnapshotRequest,
        organization_id: str,
        traceparent: str,
        tracestate: str | None = None,
    ) -> WorkspaceSnapshot:
        """Observe all requested Product resources. | 观测所有请求产品资源。"""

        resource_budget = max(
            0,
            _MAX_SNAPSHOT_JSON_BYTES
            - _MAX_SNAPSHOT_ENVELOPE_BYTES
            - _MAX_VIEW_ENVELOPE_BYTES * len(command.reads),
        )
        resource_bytes = 0
        views: list[ProductView] = []
        for item in command.reads:
            view = self._observe_one(
                item.product,
                item.path,
                organization_id,
                command.workspace_id,
                traceparent,
                tracestate,
                resource_budget - resource_bytes,
            )
            if view.resource_summary is not None:
                resource_bytes += view.resource_summary.canonical_json_bytes
            views.append(view)
        available = sum(view.status == ViewStatus.AVAILABLE for view in views)
        if available == len(views):
            status = SnapshotStatus.COMPLETE
        elif available == 0:
            status = SnapshotStatus.FAILED
        else:
            status = SnapshotStatus.PARTIAL
        return WorkspaceSnapshot(
            workspace_id=command.workspace_id,
            status=status,
            views=views,
            observed_at=utc_now(),
        )

    def _observe_one(
        self,
        product: Product,
        path: str,
        organization_id: str,
        workspace_id: str,
        traceparent: str,
        tracestate: str | None,
        max_json_bytes: int,
    ) -> ProductView:
        base_url = self._directory.get(product)
        source_operation = _workspace_read_operation(product, path)
        observed_at = utc_now()
        if base_url is None:
            return ProductView(
                product=product,
                source_operation=source_operation,
                observed_at=observed_at,
                status=ViewStatus.UNAVAILABLE,
                problem=ObservationProblem(
                    code="NAVIGATOR_PRODUCT_UNCONFIGURED",
                    detail="No Product base URL is configured.",
                    retryable=False,
                ),
            )
        request_url = f"{base_url}{path}"
        service_token = self._service_credentials.get((product, organization_id, workspace_id))
        try:
            if service_token is None:
                raise ProductReadFailure(
                    code="NAVIGATOR_PRODUCT_CREDENTIAL_UNCONFIGURED",
                    detail="No scoped server credential is configured for this Product Workspace.",
                    retryable=False,
                )
            resource = self._reader.read(
                request_url,
                traceparent,
                tracestate,
                bearer_token=service_token,
                max_json_bytes=max_json_bytes,
            )
            try:
                encoded_resource = json.dumps(
                    resource,
                    ensure_ascii=False,
                    allow_nan=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            except (TypeError, ValueError, UnicodeError) as exc:
                raise ProductReadFailure(
                    code="NAVIGATOR_PRODUCT_RESPONSE_INVALID",
                    detail="The Product API response was not valid bounded JSON.",
                    retryable=False,
                ) from exc
            if len(encoded_resource) > max_json_bytes:
                raise ProductReadFailure(
                    code="NAVIGATOR_SNAPSHOT_RESPONSE_TOO_LARGE",
                    detail="The Workspace snapshot exceeded its JSON size limit.",
                    retryable=False,
                )
        except ProductReadFailure as exc:
            return ProductView(
                product=product,
                source_operation=source_operation,
                observed_at=observed_at,
                status=ViewStatus.UNAVAILABLE,
                problem=ObservationProblem(
                    code=exc.code,
                    detail=exc.detail,
                    retryable=exc.retryable,
                    upstream_status=exc.upstream_status,
                ),
            )
        return ProductView(
            product=product,
            source_operation=source_operation,
            observed_at=observed_at,
            status=ViewStatus.AVAILABLE,
            resource_summary=ProductResourceSummary(
                json_sha256=f"sha256:{hashlib.sha256(encoded_resource).hexdigest()}",
                canonical_json_bytes=len(encoded_resource),
            ),
        )


def _workspace_read_operation(product: Product, path: str) -> ProductReadOperation:
    """Return fixed non-navigable provenance metadata for an approved owner READ."""

    fixed = _WORKSPACE_READ_OPERATIONS.get(product)
    if fixed is not None and path == fixed[0]:
        return fixed[1]
    parameterized = {
        Product.ECHO: (
            "/internal/workspace/v1/evaluation-suites/",
            ProductReadOperation.ECHO_GET_EVALUATION_SUITE,
        ),
        Product.YIELD: (
            "/internal/workspace/v1/training-drafts/",
            ProductReadOperation.YIELD_GET_DRAFT,
        ),
    }.get(product)
    if parameterized is not None and path.startswith(parameterized[0]):
        return parameterized[1]
    raise ValueError("path is not an approved Workspace READ operation")


def _validate_product_base_url(value: str) -> str:
    """Require a credential-safe operator URL with HTTPS outside loopback."""

    if (
        not isinstance(value, str)
        or not value
        or len(value) > _MAX_PRODUCT_BASE_URL_CHARS
        or value.strip() != value
    ):
        raise ValueError("Product base URLs must be non-empty configured URLs")
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Product base URLs must be valid configured URLs") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or "?" in value
        or "#" in value
    ):
        raise ValueError("Product base URLs must not contain credentials, query, or fragment")
    if port == 0:
        raise ValueError("Product base URLs must use a non-zero port")
    if parsed.scheme != "https":
        try:
            loopback = ip_address(hostname).is_loopback
        except ValueError:
            loopback = hostname.lower() == "localhost"
        if not loopback:
            raise ValueError("Product base URLs must use HTTPS outside loopback")
    return value.rstrip("/")
