"""
┌─────────────────────────────────────────────────────────────────────────┐
│ 📄 __init__.py                                                          │
│ Module: cyrene_navigator.work.conversation_artifact_bridge               │
│ Role: Public host API for live-call artifact permissions.                │
│                                                                         │
│ 模块职责：导出单次调用附件授权的宿主接口。                               │
└─────────────────────────────────────────────────────────────────────────┘
"""

from .models import ArtifactReadGrant, ConversationArtifactScope
from .registry import (
    ActiveCallLease,
    ActiveCallRegistry,
    ArtifactSourceAuthorizer,
    actor_scope_sha256,
    canonical_arguments_sha256,
    create_conversation_artifact_registry,
)

__all__ = [
    "ActiveCallLease",
    "ActiveCallRegistry",
    "ArtifactReadGrant",
    "ArtifactSourceAuthorizer",
    "ConversationArtifactScope",
    "actor_scope_sha256",
    "canonical_arguments_sha256",
    "create_conversation_artifact_registry",
]
