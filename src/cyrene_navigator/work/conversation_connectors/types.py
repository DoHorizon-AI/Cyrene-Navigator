"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 types.py                                                         │
│  Module: cyrene_navigator.work.conversation_connectors               │
│  Role: Define the narrow host-owned DSH/Work integration port.        │
│                                                                      │
│  模块职责：定义面向宿主 DSH/Work 的最小集成端口。                     │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from cyrene_message_connector_contracts import message_connector_pb2

message_wire: Any = message_connector_pb2


@dataclass(frozen=True, slots=True)
class VerifiedInboundContext:
    """Server-resolved actor and route scope; never derived from model arguments.

    中文：由服务端解析的 actor 和路由范围，不能由模型参数构造。
    """

    organization_id: str | None
    workspace_id: str
    actor_id: str
    session_id: str
    binding_id: str
    connector_id: str
    account_id: str
    conversation_id: str
    conversation_kind: int
    sender_id: str
    subscription_id: str
    persona_id: str | None = None


@dataclass(frozen=True, slots=True)
class AdmissionReceipt:
    """WorkStore/DSH admission result for one deduplicated connector event.

    中文：WorkStore/DSH 对单个去重连接器事件的接受回执。
    """

    event_id: str
    duplicate: bool
    task_id: str


@dataclass(frozen=True, slots=True)
class AuthorizedReplyRoute:
    """Current host-authorized route derived from the durable task origin.

    中文：当前宿主授权路由，必须从持久任务来源重新派生。
    """

    binding_id: str
    authorization_revision: str
    conversation: message_wire.ConversationScope
    reply_to_message_id: str


@dataclass(frozen=True, slots=True)
class OperationLease:
    """Persisted Work Operation lease created before a vendor side effect.

    中文：发送副作用前写入 Work Operation 后返回的租约。
    """

    operation_id: str
    status: Literal["started", "uncertain", "verified"]
    created: bool
    receipt: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class SendOutcome:
    """One terminal view; uncertain outcomes are never retried automatically.

    中文：发送结果状态；不确定结果不会自动重试。
    """

    status: Literal[
        "accepted",
        "rejected",
        "rate_limited",
        "authorization_denied",
        "uncertain",
        "already_recorded",
    ]
    operation_id: str | None = None
    vendor_message_id: str | None = None
    reason: str | None = None


class ConversationConnectorHostPortV1(Protocol):
    """Navigator-owned callbacks that bridge QQ to WorkStore and DSH.

    Host implementations must use the existing DSH task/executor path. They
    must not create another agent loop or accept actor, task, or destination
    authority from the model-facing request.

    中文：由 Navigator 提供的 QQ 到 WorkStore/DSH 回调。必须复用现有
    DSH task/executor，不得另建 Agent Loop，也不得接受模型提供的身份或收件目标。
    """

    async def resolve_inbound_scope(
        self,
        binding_id: str,
        event: message_wire.InboundMessagePayload,
    ) -> VerifiedInboundContext | None:
        """Resolve configured account/sender/conversation to an allowed actor."""

        ...

    async def admit_inbound(
        self,
        context: VerifiedInboundContext,
        event: message_wire.InboundMessagePayload,
        event_key: str,
    ) -> AdmissionReceipt:
        """Persist/deduplicate and enqueue one DSH task, then return promptly.

        Implementations must not await full model execution here. The completion
        hook calls :meth:`authorize_reply` and :meth:`begin_send_operation` later.
        """

        ...

    async def authorize_reply(
        self,
        task_id: str,
        binding_id: str,
    ) -> AuthorizedReplyRoute | None:
        """Recheck task origin, current subscription, persona, and source ACL."""

        ...

    async def begin_send_operation(
        self,
        task_id: str,
        binding_id: str,
        reply_key: str,
        route: AuthorizedReplyRoute,
        request: message_wire.SendMessageRequest,
    ) -> OperationLease:
        """Write an idempotent Work Operation before calling the connector."""

        ...

    async def finish_send_operation(
        self,
        lease: OperationLease,
        status: Literal["uncertain", "verified"],
        receipt: dict[str, object],
    ) -> None:
        """Persist the direct invocation result or ambiguous outcome."""

        ...
