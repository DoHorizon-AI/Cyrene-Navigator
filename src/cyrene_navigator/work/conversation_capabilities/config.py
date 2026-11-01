"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 config.py                                                            │
│  Module: cyrene_navigator.work.conversation_capabilities.config           │
│  Role: Typed, server-only DirectPluginRuntime and model-profile settings.│
│                                                                          │
│  模块职责：解析服务端本地插件端点、模型档案和签名密钥环境引用。           │
│  · 不接受请求体提供的 endpoint、模型、actor 或密钥。                       │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field

from cyrene_integration_contracts import TOOL_OPERATIONS

_LOCAL_GRPC = re.compile(r"(?:grpc://)?(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\Z")
_ENV_NAME = re.compile(r"[A-Z_][A-Z0-9_]{0,127}\Z")
_TOOL_ID = re.compile(r"[a-z][a-z0-9_.-]{0,127}\Z")
_MAX_CONNECTION_REF_BYTES = 1_024
_DEFAULT_AUDIO_TYPES = (
    "audio/mpeg",
    "audio/mp4",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/x-wav",
)


class CapabilityConfigurationError(ValueError):
    """A present server setting is malformed and cannot be used safely."""


@dataclass(frozen=True, slots=True)
class PluginBindingSettings:
    """One fixed local DirectPluginRuntime connection and bounded deadline."""

    connection_ref: str
    deadline_seconds: float = 30.0

    def __post_init__(self) -> None:
        """Reject non-loopback, malformed, or unbounded endpoint settings."""

        if not isinstance(self.connection_ref, str):
            raise CapabilityConfigurationError("plugin connection reference must be text")
        if len(self.connection_ref.encode("utf-8")) > _MAX_CONNECTION_REF_BYTES:
            raise CapabilityConfigurationError("plugin connection reference exceeds its limit")
        if not _valid_local_connection_ref(self.connection_ref):
            raise CapabilityConfigurationError(
                "DirectPluginRuntime connection must be loopback or an absolute Unix socket"
            )
        if (
            isinstance(self.deadline_seconds, bool)
            or not isinstance(self.deadline_seconds, (int, float))
            or not math.isfinite(float(self.deadline_seconds))
            or not 0.1 <= float(self.deadline_seconds) <= 300.0
        ):
            raise CapabilityConfigurationError(
                "plugin deadline must be between 0.1 and 300 seconds"
            )


@dataclass(frozen=True, slots=True)
class EmbeddingProfile:
    """Immutable model identity, vector size, and operation-specific prefixes."""

    model_id: str
    dimensions: int
    profile_id: str
    document_prefix: str = ""
    query_prefix: str = ""

    def __post_init__(self) -> None:
        """Validate a stable model/profile pair and protect the E5 input contract."""

        for value, field_name in (
            (self.model_id, "model id"),
            (self.profile_id, "embedding profile id"),
        ):
            if not isinstance(value, str) or not value.strip() or len(value.encode("utf-8")) > 256:
                raise CapabilityConfigurationError(f"{field_name} must be bounded non-empty text")
        if (
            isinstance(self.dimensions, bool)
            or not isinstance(self.dimensions, int)
            or not 1 <= self.dimensions <= 4_096
        ):
            raise CapabilityConfigurationError("embedding dimensions must be from 1 through 4096")
        for value, field_name in (
            (self.document_prefix, "document prefix"),
            (self.query_prefix, "query prefix"),
        ):
            if not isinstance(value, str) or len(value.encode("utf-8")) > 512:
                raise CapabilityConfigurationError(f"{field_name} exceeds its limit")
        if self.model_id.casefold().startswith("intfloat/multilingual-e5") and (
            self.document_prefix != "passage: " or self.query_prefix != "query: "
        ):
            raise CapabilityConfigurationError(
                "multilingual E5 requires distinct passage and query prefixes"
            )


@dataclass(frozen=True, slots=True)
class ToolCallerSettings:
    """Server references for one tool signer; key material is loaded later."""

    binding_id: str
    caller_workload: str
    audience: str
    issuer: str
    key_environment_name: str
    tool_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        """Require complete identity pins and a closed provider tool allowlist."""

        for value, field_name in (
            (self.binding_id, "tool binding id"),
            (self.caller_workload, "tool caller workload"),
            (self.audience, "tool audience"),
            (self.issuer, "tool issuer"),
        ):
            if not isinstance(value, str) or not value.strip() or len(value.encode("utf-8")) > 256:
                raise CapabilityConfigurationError(f"{field_name} must be bounded non-empty text")
        if _ENV_NAME.fullmatch(self.key_environment_name) is None:
            raise CapabilityConfigurationError("tool signing key must use an environment reference")
        if not self.tool_ids or len(set(self.tool_ids)) != len(self.tool_ids):
            raise CapabilityConfigurationError("tool IDs must be a non-empty unique allowlist")
        if any(_TOOL_ID.fullmatch(tool_id) is None for tool_id in self.tool_ids):
            raise CapabilityConfigurationError("tool allowlist contains an invalid ID")
        if any(tool_id not in TOOL_OPERATIONS for tool_id in self.tool_ids):
            raise CapabilityConfigurationError("tool allowlist contains an uncontracted tool ID")


@dataclass(frozen=True, slots=True)
class SpeechProfile:
    """Safe feature preferences and upload bounds; contains no provider secret."""

    enabled: bool = True
    default_language_hint: str | None = None
    allowed_media_types: tuple[str, ...] = _DEFAULT_AUDIO_TYPES
    max_upload_bytes: int = 10_000_000

    def __post_init__(self) -> None:
        """Keep speech preferences within the Work API's fixed attachment bounds."""

        if not isinstance(self.enabled, bool):
            raise CapabilityConfigurationError("speech enabled must be a boolean")
        if self.default_language_hint is not None and (
            not isinstance(self.default_language_hint, str)
            or len(self.default_language_hint.encode("utf-8")) > 32
        ):
            raise CapabilityConfigurationError("speech language hint exceeds its limit")
        if self.max_upload_bytes != 10_000_000:
            raise CapabilityConfigurationError("speech upload limit is fixed at 10000000 bytes")
        if not self.allowed_media_types or any(
            media_type not in _DEFAULT_AUDIO_TYPES for media_type in self.allowed_media_types
        ):
            raise CapabilityConfigurationError("speech media types are outside the audio allowlist")


@dataclass(frozen=True, slots=True)
class CapabilitySettings:
    """Optional configured endpoints and safe unavailable reasons for each capability."""

    model: PluginBindingSettings | None = None
    memory: PluginBindingSettings | None = None
    graph: PluginBindingSettings | None = None
    tool: PluginBindingSettings | None = None
    speech: PluginBindingSettings | None = None
    embedding: EmbeddingProfile | None = None
    tool_caller: ToolCallerSettings | None = None
    speech_profile: SpeechProfile = field(default_factory=SpeechProfile)
    memory_maintenance_tenants: frozenset[str] = frozenset()
    unavailable: Mapping[str, str] = field(default_factory=dict)

    @classmethod
    def from_environment(cls, environment: Mapping[str, str]) -> CapabilitySettings:
        """Read only fixed server variables and referenced secret names.

        中文：缺少可选绑定时保留清晰的 unavailable 状态；不从用户请求推导目标。
        """

        unavailable: dict[str, str] = {}

        def binding(variable: str, capability: str) -> PluginBindingSettings | None:
            value = environment.get(variable, "").strip()
            if not value:
                unavailable[capability] = "NOT_CONFIGURED"
                return None
            return PluginBindingSettings(value)

        model = binding("CYRENE_NAVIGATOR_MODEL_PROVIDER_CONNECTION_REF", "model.provider.v1")
        memory = binding("CYRENE_NAVIGATOR_MEMORY_PROVIDER_CONNECTION_REF", "memory.provider.v1")
        graph = binding("CYRENE_NAVIGATOR_KNOWLEDGE_GRAPH_CONNECTION_REF", "knowledge.graph.v1")
        tool = binding("CYRENE_NAVIGATOR_TOOL_PROVIDER_CONNECTION_REF", "tool.provider.v1")
        speech = binding("CYRENE_NAVIGATOR_SPEECH_PROVIDER_CONNECTION_REF", "speech.provider.v1")

        embedding: EmbeddingProfile | None = None
        model_id = environment.get("CYRENE_NAVIGATOR_EMBEDDING_MODEL_ID", "").strip()
        raw_dimensions = environment.get("CYRENE_NAVIGATOR_EMBEDDING_DIMENSIONS", "").strip()
        if model_id or raw_dimensions:
            if not model_id or not raw_dimensions:
                unavailable["model.provider.v1 embeddings"] = "PROFILE_INCOMPLETE"
            else:
                try:
                    dimensions = int(raw_dimensions)
                except ValueError as error:
                    raise CapabilityConfigurationError(
                        "embedding dimensions must be an integer"
                    ) from error
                embedding = EmbeddingProfile(
                    model_id=model_id,
                    dimensions=dimensions,
                    profile_id=(
                        environment.get("CYRENE_NAVIGATOR_EMBEDDING_PROFILE_ID", "").strip()
                        or model_id
                    ),
                    document_prefix=environment.get(
                        "CYRENE_NAVIGATOR_EMBEDDING_DOCUMENT_PREFIX", ""
                    ),
                    query_prefix=environment.get("CYRENE_NAVIGATOR_EMBEDDING_QUERY_PREFIX", ""),
                )
        if model is not None and embedding is None:
            unavailable["model.provider.v1 embeddings"] = "PROFILE_UNAVAILABLE"
        elif model is None:
            unavailable["model.provider.v1 embeddings"] = "MODEL_BINDING_UNAVAILABLE"
        if memory is not None and embedding is None:
            unavailable["memory.provider.v1"] = "EMBEDDING_PROFILE_UNAVAILABLE"

        tool_caller = _tool_caller_settings(environment) if tool is not None else None
        if tool is not None and tool_caller is None:
            unavailable["tool.provider.v1"] = "CALLER_SIGNING_PROFILE_UNAVAILABLE"

        language = environment.get("CYRENE_NAVIGATOR_SPEECH_DEFAULT_LANGUAGE", "").strip() or None
        speech_enabled = _environment_bool(
            environment.get("CYRENE_NAVIGATOR_SPEECH_ENABLED", "true"),
            "CYRENE_NAVIGATOR_SPEECH_ENABLED",
        )
        maintenance_tenants = tuple(
            item.strip()
            for item in environment.get("CYRENE_NAVIGATOR_MEMORY_MAINTENANCE_TENANTS", "").split(
                ","
            )
            if item.strip()
        )
        if any(len(item.encode("utf-8")) > 256 for item in maintenance_tenants):
            raise CapabilityConfigurationError("memory maintenance tenant exceeds its limit")
        return cls(
            model=model,
            memory=memory,
            graph=graph,
            tool=tool,
            speech=speech,
            embedding=embedding,
            tool_caller=tool_caller,
            speech_profile=SpeechProfile(
                enabled=speech_enabled,
                default_language_hint=language,
            ),
            memory_maintenance_tenants=frozenset(maintenance_tenants),
            unavailable=unavailable,
        )


def _tool_caller_settings(environment: Mapping[str, str]) -> ToolCallerSettings | None:
    """Build a tool signer profile only when every server-side pin is present."""

    binding_id = environment.get("CYRENE_NAVIGATOR_TOOL_BINDING_ID", "").strip()
    workload = environment.get("CYRENE_NAVIGATOR_TOOL_CALLER_WORKLOAD", "").strip()
    audience = environment.get("CYRENE_NAVIGATOR_TOOL_AUDIENCE", "").strip()
    issuer = environment.get("CYRENE_NAVIGATOR_TOOL_ISSUER", "").strip()
    key_ref = environment.get("CYRENE_NAVIGATOR_TOOL_SIGNING_KEY_ENV", "").strip()
    ids = environment.get("CYRENE_NAVIGATOR_TOOL_IDS", "").split(",")
    tool_ids = tuple(dict.fromkeys(item.strip() for item in ids if item.strip()))
    if not all((binding_id, workload, audience, issuer, key_ref, tool_ids)):
        return None
    if _ENV_NAME.fullmatch(key_ref) is None:
        raise CapabilityConfigurationError("tool signing key must use an environment reference")
    return ToolCallerSettings(
        binding_id=binding_id,
        caller_workload=workload,
        audience=audience,
        issuer=issuer,
        key_environment_name=key_ref,
        tool_ids=tool_ids,
    )


def _valid_local_connection_ref(value: str) -> bool:
    """Return whether a reference can target only a local DirectPluginRuntime."""

    match = _LOCAL_GRPC.fullmatch(value)
    if match is not None:
        return 1 <= int(match.group(1)) <= 65_535
    if value.startswith("unix:"):
        path = value.removeprefix("unix:")
        return path.startswith("/") and "\x00" not in path and ".." not in path.split("/")
    return False


def _environment_bool(value: str, name: str) -> bool:
    """Parse one closed environment boolean without Python truthiness surprises."""

    normalized = value.strip().casefold()
    if normalized in {"1", "true", "yes"}:
        return True
    if normalized in {"0", "false", "no"}:
        return False
    raise CapabilityConfigurationError(f"{name} must be a boolean")


__all__ = [
    "CapabilityConfigurationError",
    "CapabilitySettings",
    "EmbeddingProfile",
    "PluginBindingSettings",
    "SpeechProfile",
    "ToolCallerSettings",
]
