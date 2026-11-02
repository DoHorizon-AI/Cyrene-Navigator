"""Server-side conversation research adapters over existing Work services.

中文：基于现有 Work 服务的会话研究服务端适配器。
"""

from .models import ConversationResearchRequest, ConversationResearchScope
from .routes import mount_conversation_runtime_routes
from .service import (
    ConversationResearchRuntime,
    ConversationRuntimeError,
    ConversationRuntimeResult,
    PublicWebBindingUnavailable,
)

__all__ = [
    "ConversationResearchRequest",
    "ConversationResearchRuntime",
    "ConversationResearchScope",
    "ConversationRuntimeError",
    "ConversationRuntimeResult",
    "PublicWebBindingUnavailable",
    "mount_conversation_runtime_routes",
]
