"""Authenticated consumption of Catalyst-published knowledge packages."""

from .factory import build_conversation_knowledge_router
from .models import (
    KnowledgeAuthorizationReceipt,
    KnowledgeAuthorizationRequest,
    KnowledgeCitation,
    KnowledgeSearchRequest,
    KnowledgeSearchResult,
)

__all__ = [
    "KnowledgeAuthorizationReceipt",
    "KnowledgeAuthorizationRequest",
    "KnowledgeCitation",
    "KnowledgeSearchRequest",
    "KnowledgeSearchResult",
    "build_conversation_knowledge_router",
]
