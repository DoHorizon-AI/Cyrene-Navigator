"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 __init__.py                                                       │
│  Module: cyrene_navigator.work.conversation_memory                    │
│  Role: Product-owned conversation memory contracts and persistence.   │
│                                                                      │
│  模块职责：对话记忆产品数据、来源授权与插件能力边界。                    │
└─────────────────────────────────────────────────────────────────────┘
"""

from cyrene_navigator.work.conversation_memory.store import ConversationMemoryStore

__all__ = ["ConversationMemoryStore"]
