"""Typed adapters from Navigator work ports to Plugins DirectPluginRuntime.

This package owns only server-side capability composition. User and conversation
policy remain in the Navigator Work APIs and canonical stores.
"""

from .config import (
    CapabilitySettings,
    EmbeddingProfile,
    PluginBindingSettings,
    SpeechProfile,
    ToolCallerSettings,
)
from .factory import ConversationCapabilities, build_conversation_capabilities

__all__ = [
    "CapabilitySettings",
    "ConversationCapabilities",
    "EmbeddingProfile",
    "PluginBindingSettings",
    "SpeechProfile",
    "ToolCallerSettings",
    "build_conversation_capabilities",
]
