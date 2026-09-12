"""
┌─────────────────────────────────────────────────────────────────────┐
│  Module: cyrene_navigator.persistence.models                        │
│  Role: Strict HTTP models for Harness and Product metadata.          │
│                                                                     │
│  模块职责：定义 Harness 持久化 HTTP 边界；header/event 内容保持原样。    │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class PersistenceModel(BaseModel):
    """Use camelCase on the wire and reject unknown request envelope fields. | 线格式严格。"""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
        strict=True,
    )


class SessionCreateRequest(PersistenceModel):
    """Request a new v2 session and its initial write handle. | 创建 v2 会话。"""

    header: dict[str, Any]
    inherited_event_count: int = Field(ge=0)
    client_id: str = Field(min_length=1, max_length=200)


class HandleOpenRequest(PersistenceModel):
    """Request a read or write handle for an existing session. | 打开读写句柄。"""

    access: Literal["read", "write"]
    client_id: str = Field(min_length=1, max_length=200)
    takeover_expected_epoch: int | None = Field(default=None, ge=0)


class AppendRequest(PersistenceModel):
    """Request one idempotent append batch. | 请求一个幂等追加批次。"""

    writer_token: str = Field(min_length=1, max_length=512)
    epoch: int = Field(ge=0)
    batch_id: str = Field(min_length=1, max_length=512)
    events: list[dict[str, Any]] = Field(min_length=1, max_length=10000)


class MutationRequest(PersistenceModel):
    """Authenticate a writer mutation. | 认证写入变更。"""

    writer_token: str = Field(min_length=1, max_length=512)
    epoch: int = Field(ge=0)


class HandleView(PersistenceModel):
    """Wire representation of a server-authorized persistence handle. | 服务端句柄。"""

    id: str
    header: dict[str, Any]
    inherited_event_count: int = Field(ge=0)
    access: Literal["read", "write"]
    next_seq: int = Field(ge=0)
    epoch: int = Field(ge=0)
    writer_token: str | None = None
    lease_expires_at: int | None = Field(default=None, ge=0)


class ProductMetadata(PersistenceModel):
    """Read-only Navigator metadata separate from the Harness event log.

    The creator and owner are Product identities, while the persistence writer
    lease remains an independent mutable capability. Legacy rows deliberately
    expose an unknown owner instead of inferring one from an old writer.

    Navigator 产品元数据与 Harness 事件日志分离；旧记录无法可靠判断 owner 时明确标记
    unknown/legacy，不从可变的 writer lease 倒推身份。
    """

    workspace_id: str = Field(min_length=1, max_length=512)
    session_id: str = Field(min_length=1, max_length=512)
    creator_actor_id: str | None = None
    owner_actor_id: str | None = None
    owner_state: Literal["known", "unknown"]
    metadata_version: int = Field(ge=1)
    source: Literal["cyrene", "legacy"]
    created_at: int | None = Field(default=None, ge=0)


class Snapshot(PersistenceModel):
    """Durable Harness and Product metadata observation. | 持久 Harness 与产品元数据快照。"""

    meta: dict[str, Any]
    product_metadata: ProductMetadata
    revision: str = Field(min_length=1)
    event_count: int = Field(ge=0)
    last_activity_at: int | None = Field(default=None, ge=0)


class SnapshotList(PersistenceModel):
    """Workspace-scoped session listing. | Workspace 会话列表。"""

    items: list[Snapshot]


class EventsView(PersistenceModel):
    """Contiguous event slice and its committed end cursor. | 连续事件片段。"""

    events: list[dict[str, Any]]
    next_seq: int = Field(ge=0)


class MutationView(PersistenceModel):
    """Mutation acknowledgement with an optional renewed lease. | 变更确认。"""

    next_seq: int = Field(ge=0)
    lease_expires_at: int | None = Field(default=None, ge=0)
