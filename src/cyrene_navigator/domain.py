"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 domain.py                                                       │
│  Module: cyrene_navigator.domain                                    │
│  Role: Non-authoritative Product aggregation boundary models.       │
│                                                                     │
│  模块职责：定义非权威产品聚合视图的稳定契约。                              │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel


def utc_now() -> datetime:
    """Return a timezone-aware timestamp. | 返回带时区时间。"""

    return datetime.now(UTC)


class ContractModel(BaseModel):
    """Stable camelCase wire model. | 稳定 camelCase 线格式模型。"""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
    )


class Product(StrEnum):
    """Product owners visible to Navigator. | Navigator 可见产品权威。"""

    CATALYST = "CATALYST"
    ECHO = "ECHO"
    REACTOR = "REACTOR"
    EXCHANGE = "EXCHANGE"
    YIELD = "YIELD"


class ProductReadOperation(StrEnum):
    """Fixed owner READ operation labels used only as non-navigable provenance."""

    CATALYST_LIST_DATASETS = "workspaceListDatasets"
    ECHO_GET_EVALUATION_SUITE = "workspaceGetEvaluationSuite"
    EXCHANGE_LIST_GATEWAY_ROUTES = "listWorkspaceGatewayRoutes"
    REACTOR_LIST_MODEL_IMPORTS = "workspaceListModelImports"
    YIELD_GET_DRAFT = "workspaceGetDraft"


class ViewStatus(StrEnum):
    """Transport observation status, not Product state. | 传输观测状态。"""

    AVAILABLE = "AVAILABLE"
    UNAVAILABLE = "UNAVAILABLE"


def _is_hyphenated_uuid(value: str) -> bool:
    """Accept one canonical-length UUID path segment without extra components."""

    return len(value) == 36 and all(
        character == "-" if index in {8, 13, 18, 23} else character in "0123456789abcdefABCDEF"
        for index, character in enumerate(value)
    )


def _is_approved_workspace_read(product: Product, path: str) -> bool:
    """Allow only fixed Product workspace-read operations and UUID parameters."""

    fixed_paths = {
        Product.CATALYST: "/internal/workspace/v1/datasets",
        Product.EXCHANGE: "/api/v1/workspace/gateway-routes",
        Product.REACTOR: "/internal/workspace/v1/model-imports",
    }
    if path == fixed_paths.get(product):
        return True

    uuid_paths = {
        Product.ECHO: "/internal/workspace/v1/evaluation-suites/",
        Product.YIELD: "/internal/workspace/v1/training-drafts/",
    }
    prefix = uuid_paths.get(product)
    return (
        prefix is not None
        and path.startswith(prefix)
        and _is_hyphenated_uuid(path.removeprefix(prefix))
    )


class SnapshotStatus(StrEnum):
    """Aggregate availability only. | 仅表示聚合可用性。"""

    COMPLETE = "COMPLETE"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"


class ProductRead(ContractModel):
    """One Product resource read requested by the client. | 单个产品资源读取。"""

    product: Product
    path: str = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def approved_read_operation(self) -> ProductRead:
        """Reject every path outside the fixed Product READ operation map."""

        if not _is_approved_workspace_read(self.product, self.path):
            raise ValueError("path is not an approved workspace READ operation for this Product")
        return self


class SnapshotRequest(ContractModel):
    """Structured non-mutating aggregation query. | 结构化非变更聚合查询。"""

    workspace_id: str = Field(min_length=1, max_length=200)
    reads: list[ProductRead] = Field(min_length=1, max_length=50)


class ObservationProblem(ContractModel):
    """Upstream observation failure, not owner Product state. | 上游观测失败。"""

    code: str
    detail: str
    retryable: bool
    upstream_status: int | None = Field(default=None, ge=400, le=599)


class ProductView(ContractModel):
    """Source-labelled owner resource or observation problem. | 带来源标签的产品视图。"""

    product: Product
    source_operation: ProductReadOperation
    observed_at: datetime
    status: ViewStatus
    resource: dict[str, Any] | None = None
    problem: ObservationProblem | None = None


class WorkspaceSnapshot(ContractModel):
    """Ephemeral aggregate view. | 临时聚合视图。"""

    workspace_id: str
    status: SnapshotStatus
    views: list[ProductView]
    observed_at: datetime


class ProblemDetails(ContractModel):
    """RFC 9457 validation response. | RFC 9457 校验错误。"""

    type: str
    title: str
    status: int = Field(ge=400, le=599)
    detail: str
    instance: str
    code: str
    retryable: bool
    trace_id: str
    request_id: str | None = None
    recovery_action: str | None = None
