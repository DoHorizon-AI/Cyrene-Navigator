"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 peripheral.py                                                        │
│  Module: cyrene_navigator.work.conversation_capabilities.peripheral       │
│  Role: Fixed tool/speech RPC facades and host-side caller signing.        │
│                                                                          │
│  模块职责：调用 tool/speech 插件，并从服务端身份配置生成可信签名。       │
│  · 工具参数由契约签名；不接受调用方自选身份、binding、endpoint 或密钥。  │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import base64
import binascii
import importlib
import json
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Protocol, cast

from cyrene_integration_contracts import (
    TOOL_OPERATIONS,
    ToolEnvelope,
    canonical_json,
    parse_trusted_caller_context,
    serialize_tool_envelope,
    serialize_trusted_caller_context,
    sign_context,
)
from cyrene_plugin_runtime import DirectPluginClient
from cyrene_speech_provider_contracts import (
    INTERFACE_VERSION as SPEECH_INTERFACE_VERSION,
)
from cyrene_speech_provider_contracts import (
    METHOD_TRANSCRIBE,
    SpeechCodecError,
    speech_provider_pb2,
)
from cyrene_speech_provider_contracts import (
    REQUEST_TYPE_URLS as SPEECH_REQUEST_TYPE_URLS,
)
from cyrene_speech_provider_contracts import (
    RESPONSE_TYPE_URLS as SPEECH_RESPONSE_TYPE_URLS,
)
from cyrene_speech_provider_contracts import (
    decode_response as decode_speech_response,
)
from cyrene_speech_provider_contracts import (
    encode_request as encode_speech_request,
)
from cyrene_tool_provider_contracts import (
    CAPABILITY_ID as TOOL_CAPABILITY_ID,
)
from cyrene_tool_provider_contracts import (
    INTERFACE_VERSION as TOOL_INTERFACE_VERSION,
)
from cyrene_tool_provider_contracts import (
    METHOD_CALL_TOOL,
    METHOD_LIST_TOOLS,
    ToolProviderCodecError,
    tool_provider_pb2,
)
from cyrene_tool_provider_contracts import (
    decode_response as decode_tool_response,
)
from cyrene_tool_provider_contracts import (
    encode_request as encode_tool_request,
)
from cyrene_tool_provider_contracts.payload import TypedPayload

from cyrene_navigator.persistence.store import PersistencePrincipal

from .config import PluginBindingSettings, SpeechProfile, ToolCallerSettings
from .runtime import DirectCapabilityError, invoke_typed

_speech_wire: Any = speech_provider_pb2
_tool_wire: Any = tool_provider_pb2
_SAFE_ERROR_CODE = re.compile(r"[A-Z][A-Z0-9_]{0,95}\Z")
_MAX_SPEECH_BYTES = 10_000_000
_MAX_TOOL_RESPONSE_BYTES = 2_000_000


class ConversationCapabilityPortError(Exception):
    """Redacted fallback port error used before the peripheral package is integrated."""

    def __init__(
        self,
        code: str,
        *,
        unavailable: bool = False,
        retryable: bool = False,
        side_effect_possible: bool = False,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.unavailable = unavailable
        self.retryable = retryable
        self.side_effect_possible = side_effect_possible


class SpeechPreferenceStore(Protocol):
    """Host-owned persistent safe preferences; never stores provider secrets."""

    def get(self, *, principal: PersistencePrincipal, workspace_id: str) -> Mapping[str, object]:
        """Return the caller's current allowlisted speech preferences."""

    def update(
        self,
        values: Mapping[str, object],
        *,
        principal: PersistencePrincipal,
        workspace_id: str,
    ) -> Mapping[str, object]:
        """Persist only the allowlisted enabled and language preferences."""


class HostTrustedCallerSigner:
    """Create exact tool.provider.v1 HMAC contexts from authenticated host identity."""

    __slots__ = ("_key", "_profile")

    def __init__(self, profile: ToolCallerSettings, key: bytes) -> None:
        if not isinstance(key, bytes) or len(key) != 32:
            raise ValueError("tool caller signing key must be exactly 32 bytes")
        self._profile = profile
        self._key = key

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
        """Sign one exact fixed tool pair and authenticated organization/workspace/actor."""

        expected_operation = TOOL_OPERATIONS.get(method)
        if (
            method not in self._profile.tool_ids
            or expected_operation is None
            or operation_id != expected_operation
            or binding_id != self._profile.binding_id
            or caller_workload != self._profile.caller_workload
            or audience != self._profile.audience
            or not isinstance(payload, Mapping)
        ):
            raise _port_error("TOOL_CALLER_PROFILE_MISMATCH", unavailable=True)
        if (
            not isinstance(workspace_id, str)
            or workspace_id not in principal.workspace_ids
            or not isinstance(principal.organization_id, str)
            or not principal.organization_id
            or not isinstance(principal.actor_id, str)
            or not principal.actor_id
        ):
            raise _port_error("TOOL_CALLER_SCOPE_INVALID", unavailable=True)
        if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 200:
            raise _port_error("TOOL_REQUEST_ID_INVALID")
        try:
            signed = sign_context(
                method=method,
                operation_id=operation_id,
                payload=dict(payload),
                caller_workload=self._profile.caller_workload,
                audience=self._profile.audience,
                issuer=self._profile.issuer,
                subject=principal.actor_id,
                organization_id=principal.organization_id,
                workspace_id=workspace_id,
                binding_id=self._profile.binding_id,
                request_id=request_id,
                key=self._key,
                issued_at=datetime.now(UTC),
            )
            return serialize_trusted_caller_context(signed)
        except (TypeError, ValueError) as error:
            raise _port_error("TOOL_CALLER_CONTEXT_INVALID", unavailable=True) from error


class DirectToolProviderClient:
    """Invoke one server-bound tool.provider.v1 instance with signed JSON envelopes."""

    def __init__(
        self,
        client: DirectPluginClient,
        binding: PluginBindingSettings,
        profile: ToolCallerSettings,
    ) -> None:
        self._client = client
        self._binding = binding
        self._profile = profile
        self._allowed_tools = frozenset(profile.tool_ids)

    def call_tool(
        self,
        provider_tool_id: str,
        arguments: Mapping[str, Any],
        caller_context: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        """Check the current catalog and invoke one allowlisted signed tool exactly once."""

        if provider_tool_id not in self._allowed_tools or not isinstance(arguments, Mapping):
            raise _port_error("TOOL_OPERATION_UNAVAILABLE", unavailable=True)
        catalog = self._catalog()
        descriptors = {item.provider_tool_id: item for item in catalog.tools}
        descriptor = descriptors.get(provider_tool_id)
        if descriptor is None:
            raise _port_error("TOOL_OPERATION_UNAVAILABLE", unavailable=True)
        try:
            _validate_tool_schema(descriptor.input_schema_json, arguments)
            parsed_context = parse_trusted_caller_context(caller_context)
            envelope = serialize_tool_envelope(
                ToolEnvelope(caller_context=parsed_context, arguments=dict(arguments))
            )
            encoded_json = canonical_json(envelope)
            if len(encoded_json) > _MAX_TOOL_RESPONSE_BYTES:
                raise _port_error("TOOL_REQUEST_LIMIT", unavailable=False)
            request = _tool_wire.CallToolRequest(
                binding_id=self._profile.binding_id,
                provider_tool_id=provider_tool_id,
                arguments_json=encoded_json.decode("utf-8"),
                catalog_version=catalog.catalog_version,
            )
            encoded_request = encode_tool_request(METHOD_CALL_TOOL, request)
            result = invoke_typed(
                self._client,
                capability=TOOL_CAPABILITY_ID,
                interface_version=TOOL_INTERFACE_VERSION,
                method=METHOD_CALL_TOOL,
                request_type_url=encoded_request.type_url,
                request_bytes=encoded_request.value,
                response_type_url=_tool_response_type_url(METHOD_CALL_TOOL),
                deadline_seconds=self._binding.deadline_seconds,
            )
            response = decode_tool_response(
                METHOD_CALL_TOOL, TypedPayload(type_url=result.type_url, value=result.value)
            )
        except DirectCapabilityError as error:
            raise _port_error(
                error.code,
                unavailable=error.unavailable,
                retryable=error.retryable,
                side_effect_possible=True,
            ) from error
        except (
            ToolProviderCodecError,
            json.JSONDecodeError,
            UnicodeDecodeError,
            ValueError,
        ) as error:
            if hasattr(error, "code"):
                raise
            raise _port_error("TOOL_PROVIDER_PROTOCOL_INVALID") from error
        if response.WhichOneof("result") == "error":
            retryable = response.error.retryable
            error_code = int(response.error.code)
            raise _port_error(
                f"TOOL_PROVIDER_ERROR_{error_code}",
                unavailable=retryable,
                retryable=retryable,
                side_effect_possible=True,
            )
        return _tool_result_mapping(response.outcome)

    def _catalog(self) -> Any:
        """Read the current tool catalog before each call to bind its version."""

        try:
            request = _tool_wire.ListToolsRequest(binding_id=self._profile.binding_id)
            encoded_request = encode_tool_request(METHOD_LIST_TOOLS, request)
            result = invoke_typed(
                self._client,
                capability=TOOL_CAPABILITY_ID,
                interface_version=TOOL_INTERFACE_VERSION,
                method=METHOD_LIST_TOOLS,
                request_type_url=encoded_request.type_url,
                request_bytes=encoded_request.value,
                response_type_url=_tool_response_type_url(METHOD_LIST_TOOLS),
                deadline_seconds=self._binding.deadline_seconds,
            )
            response = decode_tool_response(
                METHOD_LIST_TOOLS, TypedPayload(type_url=result.type_url, value=result.value)
            )
        except DirectCapabilityError as error:
            raise _port_error(
                error.code, unavailable=error.unavailable, retryable=error.retryable
            ) from error
        except (ToolProviderCodecError, ValueError) as error:
            raise _port_error("TOOL_PROVIDER_CATALOG_INVALID") from error
        if response.WhichOneof("result") == "error" or not response.HasField("catalog"):
            raise _port_error("TOOL_PROVIDER_CATALOG_UNAVAILABLE", unavailable=True)
        if not response.catalog.catalog_version or len(response.catalog.tools) > 1_000:
            raise _port_error("TOOL_PROVIDER_CATALOG_INVALID")
        return response.catalog


class DirectSpeechProvider:
    """Call the fixed speech.provider.v1 transcribe RPC with authorized attachment bytes."""

    def __init__(
        self,
        client: DirectPluginClient,
        binding: PluginBindingSettings,
        profile: SpeechProfile,
        *,
        preferences: SpeechPreferenceStore | None = None,
    ) -> None:
        self._client = client
        self._binding = binding
        self._profile = profile
        self._preferences = preferences
        self._last_successful_model: str | None = None
        self._observed_successful_rpc = False

    def get_config(
        self, *, principal: PersistencePrincipal, workspace_id: str
    ) -> Mapping[str, Any]:
        """Return safe feature settings from the configured profile or host preference store."""

        values = (
            self._preferences.get(principal=principal, workspace_id=workspace_id)
            if self._preferences is not None
            else {}
        )
        enabled = values.get("enabled", self._profile.enabled)
        language = values.get("default_language_hint", self._profile.default_language_hint)
        if not isinstance(enabled, bool) or (
            language is not None and not isinstance(language, str)
        ):
            raise _port_error("SPEECH_PREFERENCES_INVALID")
        return {
            "enabled": enabled,
            "default_language_hint": language,
            "max_upload_bytes": self._profile.max_upload_bytes,
            "allowed_media_types": list(self._profile.allowed_media_types),
        }

    def update_config(
        self,
        config: Mapping[str, Any],
        *,
        principal: PersistencePrincipal,
        workspace_id: str,
    ) -> Mapping[str, Any]:
        """Persist only safe preferences through the host-owned preference adapter."""

        if self._preferences is None:
            raise _port_error("SPEECH_PREFERENCES_UNAVAILABLE", unavailable=True)
        if set(config) - {"enabled", "default_language_hint"}:
            raise _port_error("SPEECH_PREFERENCES_INVALID")
        enabled = config.get("enabled")
        language = config.get("default_language_hint")
        if not isinstance(enabled, bool) or (
            language is not None
            and (not isinstance(language, str) or len(language.encode("utf-8")) > 32)
        ):
            raise _port_error("SPEECH_PREFERENCES_INVALID")
        result = self._preferences.update(
            {"enabled": enabled, "default_language_hint": language},
            principal=principal,
            workspace_id=workspace_id,
        )
        return {
            "enabled": result.get("enabled", enabled),
            "default_language_hint": result.get("default_language_hint", language),
            "max_upload_bytes": self._profile.max_upload_bytes,
            "allowed_media_types": list(self._profile.allowed_media_types),
        }

    def status(self, *, principal: PersistencePrincipal, workspace_id: str) -> Mapping[str, Any]:
        """Report configured state without claiming liveness before a real successful RPC."""

        del principal, workspace_id
        if not self._profile.enabled:
            return {"available": False, "model": None, "reason_code": "DISABLED"}
        if not self._observed_successful_rpc:
            return {"available": False, "model": None, "reason_code": "NOT_VERIFIED"}
        return {"available": True, "model": self._last_successful_model, "reason_code": None}

    def transcribe(
        self,
        *,
        data: bytes,
        mime_type: str,
        language_hint: str | None,
        principal: PersistencePrincipal,
        workspace_id: str,
        request_id: str,
    ) -> Mapping[str, Any]:
        """Return only the transcript and segments actually received from speech.provider.v1."""

        del principal, workspace_id
        if not self._profile.enabled:
            raise _port_error("SPEECH_PROVIDER_DISABLED", unavailable=True)
        if (
            not isinstance(data, bytes)
            or not data
            or len(data) > min(self._profile.max_upload_bytes, _MAX_SPEECH_BYTES)
            or mime_type not in self._profile.allowed_media_types
        ):
            raise _port_error("SPEECH_INPUT_INVALID")
        if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 200:
            raise _port_error("SPEECH_REQUEST_ID_INVALID")
        selected_language = language_hint or self._profile.default_language_hint
        if selected_language is not None and len(selected_language.encode("utf-8")) > 32:
            raise _port_error("SPEECH_LANGUAGE_HINT_INVALID")
        request = _speech_wire.TranscribeRequest(
            input=_speech_wire.SpeechInput(mime_type=mime_type, data=data),
            request_id=request_id,
        )
        if selected_language is not None:
            request.language_hint = selected_language
        try:
            encoded_request = encode_speech_request(METHOD_TRANSCRIBE, request)
            result = invoke_typed(
                self._client,
                capability="speech.provider.v1",
                interface_version=SPEECH_INTERFACE_VERSION,
                method=METHOD_TRANSCRIBE,
                request_type_url=encoded_request_type_url(METHOD_TRANSCRIBE),
                request_bytes=encoded_request,
                response_type_url=_speech_response_type_url(METHOD_TRANSCRIBE),
                deadline_seconds=self._binding.deadline_seconds,
            )
            response = decode_speech_response(METHOD_TRANSCRIBE, result.value)
        except DirectCapabilityError as error:
            raise _port_error(
                error.code,
                unavailable=error.unavailable,
                retryable=error.retryable,
            ) from error
        except (SpeechCodecError, ValueError) as error:
            raise _port_error("SPEECH_PROVIDER_PROTOCOL_INVALID") from error
        if response.WhichOneof("result") == "error":
            code = int(response.error.code)
            retryable = (
                response.error.retryable or code == _speech_wire.SPEECH_ERROR_CODE_MODEL_UNAVAILABLE
            )
            raise _port_error(
                f"SPEECH_PROVIDER_ERROR_{code}", unavailable=retryable, retryable=retryable
            )
        transcript = response.transcription
        if transcript.status == _speech_wire.TRANSCRIPTION_STATUS_SUCCEEDED:
            status = "succeeded"
        elif transcript.status == _speech_wire.TRANSCRIPTION_STATUS_NO_SPEECH:
            status = "no_speech"
        else:
            raise _port_error("SPEECH_PROVIDER_RESULT_INVALID")
        if len(transcript.text.encode("utf-8")) > 1_000_000:
            raise _port_error("SPEECH_PROVIDER_RESULT_INVALID")
        segments: list[dict[str, object]] = []
        for segment in transcript.segments:
            if segment.end_ms < segment.start_ms or len(segment.text.encode("utf-8")) > 32_000:
                raise _port_error("SPEECH_PROVIDER_RESULT_INVALID")
            segments.append(
                {"start_ms": segment.start_ms, "end_ms": segment.end_ms, "text": segment.text}
            )
        model = transcript.model if transcript.HasField("model") else None
        self._last_successful_model = model
        self._observed_successful_rpc = True
        return {
            "status": status,
            "text": transcript.text,
            "detected_language": (
                transcript.detected_language if transcript.HasField("detected_language") else None
            ),
            "duration_ms": transcript.duration_ms if transcript.HasField("duration_ms") else None,
            "model": model,
            "segments": segments,
        }


def build_host_trusted_caller_signer(
    profile: ToolCallerSettings,
    environment: Mapping[str, str],
) -> HostTrustedCallerSigner:
    """Resolve one 32-byte signing key from a server-only environment reference."""

    value = environment.get(profile.key_environment_name)
    if not isinstance(value, str) or not value:
        raise ValueError("tool caller signing key is unavailable")
    return HostTrustedCallerSigner(profile, _decode_signing_key(value))


def _decode_signing_key(value: str) -> bytes:
    """Decode a 32-byte hex, base64, or fixed-length raw secret without exposing it."""

    try:
        if re.fullmatch(r"[0-9a-fA-F]{64}", value):
            decoded = bytes.fromhex(value)
        elif len(value) == 32:
            decoded = value.encode("utf-8")
        else:
            decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error, UnicodeError) as error:
        raise ValueError("tool caller signing key is malformed") from error
    if len(decoded) != 32:
        raise ValueError("tool caller signing key must be exactly 32 bytes")
    return decoded


def _tool_result_mapping(outcome: Any) -> Mapping[str, Any]:
    """Decode one JSON result object; never coerce missing/error output into success."""

    if getattr(outcome, "is_error", False):
        raise _port_error("TOOL_PROVIDER_REPORTED_ERROR", side_effect_possible=True)
    contents = getattr(outcome, "content", None)
    if not contents or len(contents) > 64:
        raise _port_error("TOOL_PROVIDER_RESPONSE_INVALID")
    decoded: list[Any] = []
    for part in contents:
        kind = part.WhichOneof("content")
        if kind == "json":
            raw = part.json.json
            if not isinstance(raw, str) or len(raw.encode("utf-8")) > _MAX_TOOL_RESPONSE_BYTES:
                raise _port_error("TOOL_PROVIDER_RESPONSE_INVALID")
            try:
                decoded.append(json.loads(raw))
            except json.JSONDecodeError as error:
                raise _port_error("TOOL_PROVIDER_RESPONSE_INVALID") from error
        elif kind == "text":
            decoded.append({"text": part.text.text})
        else:
            raise _port_error("TOOL_PROVIDER_RESPONSE_INVALID")
    if len(decoded) == 1 and isinstance(decoded[0], Mapping):
        return dict(decoded[0])
    if len(decoded) == 1 and isinstance(decoded[0], list):
        return {"items": decoded[0]}
    return {"content": decoded}


def _validate_tool_schema(schema_json: str, arguments: Mapping[str, Any]) -> None:
    """Reject invalid current-catalog arguments before sending a signed invocation."""

    try:
        schema = json.loads(schema_json)
    except (TypeError, json.JSONDecodeError) as error:
        raise _port_error("TOOL_PROVIDER_CATALOG_INVALID") from error
    try:
        import jsonschema  # type: ignore[import-untyped]

        jsonschema.Draft202012Validator(schema).validate(dict(arguments))
    except (jsonschema.SchemaError, jsonschema.ValidationError) as error:
        raise _port_error("TOOL_ARGUMENTS_INVALID") from error


def _tool_response_type_url(method: str) -> str:
    """Read the canonical response type URL from the versioned SDK registry."""

    from cyrene_tool_provider_contracts.contracts import RESPONSE_TYPE_URLS

    return RESPONSE_TYPE_URLS[method]


def _speech_response_type_url(method: str) -> str:
    """Read the canonical speech response URL from its frozen SDK method registry."""

    return SPEECH_RESPONSE_TYPE_URLS[method]


def encoded_request_type_url(method: str) -> str:
    """Read the canonical speech request URL from its frozen SDK method registry."""

    return SPEECH_REQUEST_TYPE_URLS[method]


def _port_error(
    code: str,
    *,
    unavailable: bool = False,
    retryable: bool = False,
    side_effect_possible: bool = False,
) -> Exception:
    """Create the peripheral port's typed error when that owning surface is installed."""

    normalized = code if _SAFE_ERROR_CODE.fullmatch(code) else "CAPABILITY_PROVIDER_FAILED"
    try:
        ports_module = importlib.import_module(
            "cyrene_navigator.work.conversation_peripheral.ports"
        )
    except ImportError:
        return ConversationCapabilityPortError(
            normalized,
            unavailable=unavailable,
            retryable=retryable,
            side_effect_possible=side_effect_possible,
        )
    port_error = ports_module.PeripheralPortError
    return cast(
        Exception,
        port_error(
            normalized,
            unavailable=unavailable,
            side_effect_possible=side_effect_possible,
        ),
    )


__all__ = [
    "DirectSpeechProvider",
    "DirectToolProviderClient",
    "HostTrustedCallerSigner",
    "SpeechPreferenceStore",
    "build_host_trusted_caller_signer",
]
