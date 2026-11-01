"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 __init__.py                                                      │
│  Module: cyrene_navigator.work.conversation_connectors               │
│  Role: Expose the host-owned QQ conversation connector adapter.      │
│                                                                      │
│  模块职责：公开由 Navigator 宿主拥有的 QQ 对话连接器适配器。          │
└─────────────────────────────────────────────────────────────────────┘
"""

from .api import mount_conversation_connector_routes
from .qq import QQConnectorBinding, QQConversationConnector
from .types import (
    AdmissionReceipt,
    AuthorizedReplyRoute,
    ConversationConnectorHostPortV1,
    OperationLease,
    SendOutcome,
    VerifiedInboundContext,
)

__all__ = [
    "AdmissionReceipt",
    "AuthorizedReplyRoute",
    "ConversationConnectorHostPortV1",
    "OperationLease",
    "QQConnectorBinding",
    "QQConversationConnector",
    "SendOutcome",
    "VerifiedInboundContext",
    "mount_conversation_connector_routes",
]
