"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 factory.py                                                           │
│  Module: cyrene_navigator.work.conversation_capabilities.factory          │
│  Role: Compose optional server-configured capability adapters.           │
│                                                                          │
│  模块职责：按环境中固定的 local endpoint/profile 构建真实插件适配器。    │
│  · 缺少一项绑定只使该能力 typed-unavailable，不影响其他能力启动。         │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from cyrene_plugin_runtime import DirectPluginClient

from cyrene_navigator.work.conversation_memory.providers import (
    EmbeddingClient,
    KnowledgeGraphProvider,
    MemoryProvider,
)

from .config import CapabilitySettings
from .embeddings import DirectEmbeddingClient
from .knowledge_graph import DirectKnowledgeGraphProvider
from .memory import DirectMemoryProvider
from .peripheral import (
    DirectSpeechProvider,
    DirectToolProviderClient,
    HostTrustedCallerSigner,
    SpeechPreferenceStore,
    build_host_trusted_caller_signer,
)
from .runtime import DirectPluginPool


@dataclass(slots=True)
class ConversationCapabilities:
    """One process-local set of optional RPC adapters and their safe status facts."""

    pool: DirectPluginPool
    embedding_client: EmbeddingClient | None = None
    memory_provider: MemoryProvider | None = None
    knowledge_graph_provider: KnowledgeGraphProvider | None = None
    tool_provider_client: DirectToolProviderClient | None = None
    tool_signer: HostTrustedCallerSigner | None = None
    speech_provider: DirectSpeechProvider | None = None
    unavailable: dict[str, str] = field(default_factory=dict)

    def close(self) -> None:
        """Close only channels created by this composition instance."""

        self.pool.close()


def build_conversation_capabilities(
    *,
    environment: Mapping[str, str] | None = None,
    client_factory: Callable[
        [str], DirectPluginClient
    ] = DirectPluginClient.for_local_connection_ref,
    speech_preferences: SpeechPreferenceStore | None = None,
) -> ConversationCapabilities:
    """Build real optional adapters from server config; never infer targets from requests.

    Args:
        environment: Server environment override for tests or explicit host composition.
        client_factory: Local DirectPluginRuntime client constructor; production uses the
            Plugins-owned loopback/Unix-only SDK factory.
        speech_preferences: Optional host-owned persistence for safe speech preferences.
    Returns:
        A closeable bundle whose missing members correspond to safe unavailable states.
    """

    selected_environment = os.environ if environment is None else environment
    settings = CapabilitySettings.from_environment(selected_environment)
    pool = DirectPluginPool(client_factory)
    result = ConversationCapabilities(pool=pool, unavailable=dict(settings.unavailable))

    if settings.model is not None and settings.embedding is not None:
        try:
            result.embedding_client = DirectEmbeddingClient(
                pool.client(settings.model.connection_ref),
                settings.model,
                settings.embedding,
            )
        except (ValueError, OSError):
            result.unavailable["model.provider.v1 embeddings"] = "ENDPOINT_UNAVAILABLE"

    if settings.memory is not None and settings.embedding is not None:
        try:
            result.memory_provider = DirectMemoryProvider(
                pool.client(settings.memory.connection_ref),
                settings.memory,
                settings.embedding,
                maintenance_tenants=settings.memory_maintenance_tenants,
            )
            result.unavailable.pop("memory.provider.v1", None)
        except (ValueError, OSError):
            result.unavailable["memory.provider.v1"] = "ENDPOINT_UNAVAILABLE"

    if settings.graph is not None:
        try:
            result.knowledge_graph_provider = DirectKnowledgeGraphProvider(
                pool.client(settings.graph.connection_ref), settings.graph
            )
            result.unavailable.pop("knowledge.graph.v1", None)
        except (ValueError, OSError):
            result.unavailable["knowledge.graph.v1"] = "ENDPOINT_UNAVAILABLE"

    if settings.tool is not None and settings.tool_caller is not None:
        try:
            result.tool_signer = build_host_trusted_caller_signer(
                settings.tool_caller, selected_environment
            )
            result.tool_provider_client = DirectToolProviderClient(
                pool.client(settings.tool.connection_ref),
                settings.tool,
                settings.tool_caller,
            )
            result.unavailable.pop("tool.provider.v1", None)
        except (ValueError, OSError):
            result.tool_signer = None
            result.tool_provider_client = None
            result.unavailable["tool.provider.v1"] = "CALLER_SIGNING_PROFILE_UNAVAILABLE"

    if settings.speech is not None:
        try:
            result.speech_provider = DirectSpeechProvider(
                pool.client(settings.speech.connection_ref),
                settings.speech,
                settings.speech_profile,
                preferences=speech_preferences,
            )
            result.unavailable.pop("speech.provider.v1", None)
        except (ValueError, OSError):
            result.unavailable["speech.provider.v1"] = "ENDPOINT_UNAVAILABLE"

    return result


__all__ = ["ConversationCapabilities", "build_conversation_capabilities"]
