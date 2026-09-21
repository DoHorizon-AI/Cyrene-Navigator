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
from urllib.parse import unquote, urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator
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


class ViewStatus(StrEnum):
    """Transport observation status, not Product state. | 传输观测状态。"""

    AVAILABLE = "AVAILABLE"
    UNAVAILABLE = "UNAVAILABLE"


class SnapshotStatus(StrEnum):
    """Aggregate availability only. | 仅表示聚合可用性。"""

    COMPLETE = "COMPLETE"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"


class ProductRead(ContractModel):
    """One Product resource read requested by the client. | 单个产品资源读取。"""

    product: Product
    path: str = Field(pattern=r"^/api/v1/", max_length=1000)

    @field_validator("path")
    @classmethod
    def safe_relative_path(cls, value: str) -> str:
        """Reject traversal and embedded authority changes. | 拒绝路径穿越与权威切换。"""

        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("path cannot contain control characters")
        parsed = urlsplit(value)
        if parsed.scheme or parsed.netloc or parsed.fragment or "://" in value:
            raise ValueError("path must remain under the configured Product API")
        decoded_path = parsed.path
        for _ in range(len(decoded_path)):
            next_path = unquote(decoded_path)
            if next_path == decoded_path:
                break
            decoded_path = next_path
        if (
            "\\" in decoded_path
            or any(ord(character) < 32 or ord(character) == 127 for character in decoded_path)
            or any(segment in {".", ".."} for segment in decoded_path.split("/"))
        ):
            raise ValueError("path cannot traverse outside the Product API")
        return value


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
    source_url: str
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

