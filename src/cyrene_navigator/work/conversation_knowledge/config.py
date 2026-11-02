"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 config.py                                                           │
│  Module: cyrene_navigator.work.conversation_knowledge.config             │
│  Role: Server-owned knowledge wiring from one operator-written JSON file. │
│                                                                          │
│  模块职责：从运维编写的 JSON 文件构建 Catalyst 客户端、检索提供方与解析器。│
│  · 选择与主体映射都是静态服务端配置，请求体与模型无法影响。              │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import Request

from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_capabilities.config import (
    PluginBindingSettings,
    ToolCallerSettings,
)
from cyrene_navigator.work.conversation_capabilities.peripheral import (
    DirectToolProviderClient,
    build_host_trusted_caller_signer,
)
from cyrene_navigator.work.conversation_capabilities.runtime import DirectPluginPool

from .catalyst_client import CatalystKnowledgeHttpClient
from .ports import KnowledgePackageSelection
from .provider import DirectKnowledgeSearchProvider
from .service import ConversationKnowledgeService

KNOWLEDGE_CONFIG_ENV = "CYRENE_NAVIGATOR_KNOWLEDGE_CONFIG"
_MAX_CONFIG_BYTES = 262_144
_ENV_NAME = re.compile(r"[A-Z][A-Z0-9_]{0,127}\Z")


class KnowledgeConfigurationError(ValueError):
    """The operator-written knowledge configuration is unusable; startup must stop."""


@dataclass(frozen=True, slots=True)
class ConversationKnowledgeWiring:
    """Everything the Work host needs to mount the knowledge routes."""

    service: ConversationKnowledgeService
    selection_resolver: StaticKnowledgeSelectionResolver


class StaticKnowledgeSelectionResolver:
    """Select the package an operator configured for the authenticated actor."""

    def __init__(self, selections: Mapping[str, KnowledgePackageSelection]) -> None:
        self._selections = dict(selections)

    def resolve(
        self,
        request: Request,
        *,
        principal: PersistencePrincipal,
        workspace_id: str,
    ) -> KnowledgePackageSelection | None:
        """Return only the actor's configured package; nothing comes from the request."""

        del request, workspace_id
        return self._selections.get(principal.actor_id)


class StaticPrincipalRefResolver:
    """Map an authenticated actor to the plugin's principal references."""

    def __init__(self, refs: Mapping[str, tuple[str, ...]]) -> None:
        self._refs = dict(refs)

    def resolve(self, *, principal: PersistencePrincipal, workspace_id: str) -> tuple[str, ...]:
        """Return the configured refs for this actor, or none when unmapped."""

        del workspace_id
        return self._refs.get(principal.actor_id, ())


def load_conversation_knowledge(
    path: Path,
    *,
    pool: DirectPluginPool,
    environment: Mapping[str, str] | None = None,
) -> ConversationKnowledgeWiring:
    """Read the operator file and build the Catalyst client, provider, and resolvers."""

    env = os.environ if environment is None else environment
    try:
        raw = Path(path).read_bytes()
    except OSError as error:
        raise KnowledgeConfigurationError("knowledge configuration cannot be read") from error
    if len(raw) > _MAX_CONFIG_BYTES:
        raise KnowledgeConfigurationError("knowledge configuration is too large")
    try:
        document = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise KnowledgeConfigurationError("knowledge configuration is not valid JSON") from error
    config = _object(document, "configuration")
    catalyst = _object(config.get("catalyst"), "catalyst")
    tool = _object(config.get("tool"), "tool")

    bearer_env = _env_name(catalyst.get("bearerEnv"), "catalyst.bearerEnv")
    bearer = env.get(bearer_env, "")
    if not bearer:
        raise KnowledgeConfigurationError("the Catalyst service bearer is not set")
    try:
        catalyst_client = CatalystKnowledgeHttpClient(
            _text(catalyst.get("baseUrl"), "catalyst.baseUrl"),
            bearer,
            organization_id=_text(catalyst.get("organizationId"), "catalyst.organizationId"),
            workspace_id=_text(catalyst.get("workspaceId"), "catalyst.workspaceId"),
        )
        profile = ToolCallerSettings(
            binding_id=_text(tool.get("bindingId"), "tool.bindingId"),
            caller_workload=_text(tool.get("callerWorkload"), "tool.callerWorkload"),
            audience=_text(tool.get("audience"), "tool.audience"),
            issuer=_text(tool.get("issuer"), "tool.issuer"),
            key_environment_name=_env_name(tool.get("signingKeyEnv"), "tool.signingKeyEnv"),
            tool_ids=("knowledge.search",),
        )
        binding = PluginBindingSettings(_text(tool.get("connectionRef"), "tool.connectionRef"))
        signer = build_host_trusted_caller_signer(profile, env)
        provider = DirectKnowledgeSearchProvider(
            DirectToolProviderClient(pool.client(binding.connection_ref), binding, profile),
            signer,
            profile,
        )
    except KnowledgeConfigurationError:
        raise
    except ValueError as error:
        raise KnowledgeConfigurationError(f"knowledge configuration is invalid: {error}") from None

    selections: dict[str, KnowledgePackageSelection] = {}
    for index, item in enumerate(_list(config.get("selections"), "selections")):
        row = _object(item, f"selections[{index}]")
        actor_id = _text(row.get("actorId"), f"selections[{index}].actorId")
        if actor_id in selections:
            raise KnowledgeConfigurationError("an actor has more than one knowledge selection")
        try:
            selections[actor_id] = KnowledgePackageSelection(
                library_selector=_text(row.get("librarySelector"), "librarySelector"),
                dataset_id=_text(row.get("datasetId"), "datasetId"),
                dataset_version_id=_text(row.get("datasetVersionId"), "datasetVersionId"),
                actor_id=actor_id,
            )
        except ValueError as error:
            raise KnowledgeConfigurationError(f"selections[{index}] is invalid: {error}") from None
    refs_document = _object(config.get("principalRefs"), "principalRefs")
    refs = {
        actor_id: tuple(_text(ref, "principalRefs entry") for ref in _list(value, "principalRefs"))
        for actor_id, value in refs_document.items()
    }
    if not selections:
        raise KnowledgeConfigurationError("at least one knowledge selection is required")
    if any(actor_id not in refs or not refs[actor_id] for actor_id in selections):
        raise KnowledgeConfigurationError("every selected actor needs at least one principal ref")

    service = ConversationKnowledgeService(
        catalyst_client, provider, StaticPrincipalRefResolver(refs)
    )
    return ConversationKnowledgeWiring(service, StaticKnowledgeSelectionResolver(selections))


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise KnowledgeConfigurationError(f"{label} must be an object")
    return value


def _list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list) or len(value) > 10_000:
        raise KnowledgeConfigurationError(f"{label} must be a bounded list")
    return value


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 2_048:
        raise KnowledgeConfigurationError(f"{label} must be non-empty text")
    return value


def _env_name(value: Any, label: str) -> str:
    text = _text(value, label)
    if _ENV_NAME.fullmatch(text) is None:
        raise KnowledgeConfigurationError(f"{label} must be an environment variable name")
    return text


__all__ = [
    "KNOWLEDGE_CONFIG_ENV",
    "ConversationKnowledgeWiring",
    "KnowledgeConfigurationError",
    "StaticKnowledgeSelectionResolver",
    "StaticPrincipalRefResolver",
    "load_conversation_knowledge",
]
