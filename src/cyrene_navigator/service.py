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

from collections.abc import Mapping

from cyrene_navigator.domain import (
    ObservationProblem,
    Product,
    ProductView,
    SnapshotRequest,
    SnapshotStatus,
    ViewStatus,
    WorkspaceSnapshot,
    utc_now,
)
from cyrene_navigator.reader import ProductReadFailure, ProductReadPort


class NavigatorService:
    """Aggregate owner views without storing or interpreting them. | 聚合但不存储或解释。"""

    def __init__(self, directory: Mapping[Product, str], reader: ProductReadPort) -> None:
        self._directory = {product: url.rstrip("/") for product, url in directory.items()}
        self._reader = reader

    def observe(
        self,
        command: SnapshotRequest,
        traceparent: str,
        tracestate: str | None = None,
    ) -> WorkspaceSnapshot:
        """Observe all requested Product resources. | 观测所有请求产品资源。"""

        views = [
            self._observe_one(item.product, item.path, traceparent, tracestate)
            for item in command.reads
        ]
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
        traceparent: str,
        tracestate: str | None,
    ) -> ProductView:
        base_url = self._directory.get(product)
        source_url = f"{base_url or 'unconfigured://product'}{path}"
        observed_at = utc_now()
        if base_url is None:
            return ProductView(
                product=product,
                source_url=source_url,
                observed_at=observed_at,
                status=ViewStatus.UNAVAILABLE,
                problem=ObservationProblem(
                    code="NAVIGATOR_PRODUCT_UNCONFIGURED",
                    detail="No Product base URL is configured.",
                    retryable=False,
                ),
            )
        try:
            resource = self._reader.read(source_url, traceparent, tracestate)
        except ProductReadFailure as exc:
            return ProductView(
                product=product,
                source_url=source_url,
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
            source_url=source_url,
            observed_at=observed_at,
            status=ViewStatus.AVAILABLE,
            resource=resource,
        )
