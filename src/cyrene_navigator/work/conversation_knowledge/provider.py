"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 provider.py                                                        │
│  Module: cyrene_navigator.work.conversation_knowledge.provider           │
│  Role: Signed call adapter for the fixed knowledge.search ToolProvider.  │
│                                                                          │
│  模块职责：复用 Navigator DirectPluginRuntime 与正式 ToolProvider SDK。  │
│  · ToolProvider 身份和 librarySelector 均为服务端固定值。                │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Mapping
from typing import Any, Protocol
from uuid import uuid4

from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_capabilities.config import ToolCallerSettings
from cyrene_navigator.work.conversation_capabilities.peripheral import (
    ConversationCapabilityPortError,
    DirectToolProviderClient,
    HostTrustedCallerSigner,
)

from .ports import KnowledgePortError, KnowledgeToolProviderPort

KNOWLEDGE_TOOL_ID = "knowledge.search"
KNOWLEDGE_OPERATION_ID = "knowledge.search"


class _ToolClient(Protocol):
    """Minimum actual DirectToolProviderClient method used by this adapter."""

    def call_tool(
        self,
        provider_tool_id: str,
        arguments: Mapping[str, Any],
        caller_context: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        """Invoke one ToolProvider through the installed DirectPluginRuntime client."""


class _CallerSigner(Protocol):
    """Minimum host signer contract for a fixed signed tool call."""

    def sign_context(
        self,
        *,
        method: str,
        operation_id: str,
        payload: Mapping[str, Any],
        principal: PersistencePrincipal,
        workspace_id: str,
        binding_id: str,
        caller_workload: str,
        audience: str,
        request_id: str,
    ) -> Mapping[str, Any]:
        """Derive caller claims from the authenticated server principal."""


class DirectKnowledgeSearchProvider(KnowledgeToolProviderPort):
    """Call the formal `tool.provider.v1` knowledge.search method exactly once."""

    def __init__(
        self,
        client: _ToolClient | DirectToolProviderClient,
        signer: _CallerSigner | HostTrustedCallerSigner,
        profile: ToolCallerSettings,
    ) -> None:
        if KNOWLEDGE_TOOL_ID not in profile.tool_ids:
            raise ValueError("knowledge.search is not in the server tool allowlist")
        self._client = client
        self._signer = signer
        self._profile = profile

    async def search(
        self,
        *,
        principal: PersistencePrincipal,
        workspace_id: str,
        arguments: dict[str, Any],
        request_id: str,
    ) -> dict[str, Any]:
        """Sign exact arguments with authenticated identity and invoke the real provider."""

        if not isinstance(arguments, dict) or set(arguments) - {
            "librarySelector",
            "query",
            "limit",
            "chunkCursor",
        }:
            raise KnowledgePortError("KNOWLEDGE_TOOL_ARGUMENTS_INVALID", status_code=422)
        if not request_id or len(request_id) > 200:
            raise KnowledgePortError("KNOWLEDGE_TOOL_REQUEST_ID_INVALID", status_code=422)
        try:
            context = self._signer.sign_context(
                method=KNOWLEDGE_TOOL_ID,
                operation_id=KNOWLEDGE_OPERATION_ID,
                payload=arguments,
                principal=principal,
                workspace_id=workspace_id,
                binding_id=self._profile.binding_id,
                caller_workload=self._profile.caller_workload,
                audience=self._profile.audience,
                request_id=request_id,
            )
            function = self._client.call_tool
            if inspect.iscoroutinefunction(function):
                raw = await function(KNOWLEDGE_TOOL_ID, arguments, context)
            else:
                raw = await asyncio.to_thread(
                    function,
                    KNOWLEDGE_TOOL_ID,
                    arguments,
                    context,
                )
            if inspect.isawaitable(raw):
                raw = await raw
        except ConversationCapabilityPortError as error:
            raise KnowledgePortError(
                error.code,
                status_code=503 if error.unavailable else 502,
                retryable=error.retryable,
            ) from None
        except KnowledgePortError:
            raise
        except (TypeError, ValueError, OSError):
            raise KnowledgePortError(
                "KNOWLEDGE_PROVIDER_UNAVAILABLE", status_code=503, retryable=True
            ) from None
        if not isinstance(raw, Mapping) or any(not isinstance(key, str) for key in raw):
            raise KnowledgePortError("KNOWLEDGE_PROVIDER_RESPONSE_INVALID", status_code=502)
        return dict(raw)


def new_knowledge_request_id() -> str:
    """Create a local correlation identifier; it contains no actor or source identity."""

    return uuid4().hex


__all__ = [
    "DirectKnowledgeSearchProvider",
    "KNOWLEDGE_OPERATION_ID",
    "KNOWLEDGE_TOOL_ID",
    "new_knowledge_request_id",
]
