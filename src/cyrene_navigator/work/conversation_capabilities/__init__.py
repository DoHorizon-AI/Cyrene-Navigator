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
from .media import (
    MediaArtifactAuthorization,
    MediaCollectionPermit,
    MediaContextContribution,
    MediaTurnContext,
    WorkMediaAttachment,
    WorkMediaAttachmentRecord,
)
from .media_api import create_conversation_media_router
from .media_library import (
    DirectMediaLibraryClient,
    MediaArtifactReceipt,
    MediaAsset,
    MediaAssetExport,
    MediaAssetPage,
    MediaAssetSelection,
)
from .vision import DirectVisionProvider, VisionProfile, VisionResult

__all__ = [
    "CapabilitySettings",
    "ConversationCapabilities",
    "DirectMediaLibraryClient",
    "DirectVisionProvider",
    "EmbeddingProfile",
    "MediaArtifactAuthorization",
    "MediaArtifactReceipt",
    "MediaAsset",
    "MediaAssetExport",
    "MediaAssetPage",
    "MediaAssetSelection",
    "MediaCollectionPermit",
    "MediaContextContribution",
    "MediaTurnContext",
    "PluginBindingSettings",
    "SpeechProfile",
    "ToolCallerSettings",
    "VisionProfile",
    "VisionResult",
    "WorkMediaAttachment",
    "WorkMediaAttachmentRecord",
    "build_conversation_capabilities",
    "create_conversation_media_router",
]
