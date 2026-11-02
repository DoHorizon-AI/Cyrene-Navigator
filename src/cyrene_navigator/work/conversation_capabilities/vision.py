"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 vision.py                                                            │
│  Module: cyrene_navigator.work.conversation_capabilities.vision           │
│  Role: Invoke the pinned model.provider.v1 multimodal chat v3 method.     │
│                                                                          │
│  模块职责：仅将经 Work 授权并校验摘要的图片交给固定 vision provider。    │
│  · 返回模型实际描述；不发送消息，也不接收 URL、路径或不透明附件 ID。     │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass

from cyrene_model_provider_contracts.chat import (
    CAPABILITY_ID,
    CHAT_COMPLETION_V3_INTERFACE_VERSION,
    CHAT_COMPLETION_V3_METHOD,
    CHAT_COMPLETION_V3_REQUEST_TYPE_URL,
    CHAT_COMPLETION_V3_RESPONSE_TYPE_URL,
    ChatCodecError,
    ChatCompletionRequestV3,
    ChatMessageV3,
    ChatRole,
    ImageContentPart,
    TextContentPart,
    decode_chat_completion_response_v3,
    encode_chat_completion_request_v3,
)
from cyrene_plugin_runtime import DirectPluginClient

from cyrene_navigator.persistence.errors import PersistenceError

from .config import PluginBindingSettings
from .runtime import DirectCapabilityError, invoke_typed

_ALLOWED_IMAGE_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
_MAX_IMAGE_BYTES = 10_000_000
_MAX_PROMPT_BYTES = 4_096
_MAX_DESCRIPTION_BYTES = 32_000


@dataclass(frozen=True, slots=True)
class VisionProfile:
    """Server-bound model identity and bounded V3 image inference settings."""

    model_id: str
    max_image_bytes: int = _MAX_IMAGE_BYTES
    max_output_tokens: int = 512

    def __post_init__(self) -> None:
        """Reject an absent model identity or any raised media/token bound."""

        if (
            not isinstance(self.model_id, str)
            or not self.model_id.strip()
            or len(self.model_id.encode("utf-8")) > 256
        ):
            raise ValueError("vision model id must be bounded non-empty text")
        if (
            isinstance(self.max_image_bytes, bool)
            or not isinstance(self.max_image_bytes, int)
            or not 1 <= self.max_image_bytes <= _MAX_IMAGE_BYTES
        ):
            raise ValueError("vision image byte limit must be between 1 and 10000000")
        if (
            isinstance(self.max_output_tokens, bool)
            or not isinstance(self.max_output_tokens, int)
            or not 1 <= self.max_output_tokens <= 2_048
        ):
            raise ValueError("vision output token limit must be between 1 and 2048")


@dataclass(frozen=True, slots=True)
class VisionResult:
    """Actual model text bound to the exact image digest and server model id."""

    description: str
    model: str
    image_sha256: str
    prompt_tokens: int | None = None
    completion_tokens: int | None = None


class DirectVisionProvider:
    """Call a fixed `chat_completion_v3` endpoint with verified inline image bytes."""

    def __init__(
        self,
        client: DirectPluginClient,
        binding: PluginBindingSettings,
        profile: VisionProfile,
    ) -> None:
        self._client = client
        self._binding = binding
        self._profile = profile

    def describe_image(
        self,
        *,
        artifact_id: str,
        sha256: str,
        mime_type: str,
        data: bytes,
        prompt: str = "Describe the image accurately and concisely.",
        request_id: str | None = None,
        cancel_event: threading.Event | None = None,
    ) -> VisionResult:
        """Return only provider-produced image analysis; never deliver it externally.

        Callers must obtain `data` through an authorized Work attachment resolver.
        Digest, MIME, and byte count are checked again at this boundary.
        """

        digest = _validate_image(
            artifact_id=artifact_id,
            sha256=sha256,
            mime_type=mime_type,
            data=data,
            maximum_bytes=self._profile.max_image_bytes,
        )
        instruction = _validate_prompt(prompt)
        if request_id is not None and (
            not isinstance(request_id, str)
            or not request_id.strip()
            or len(request_id.encode("utf-8")) > 200
        ):
            raise _vision_error("MEDIA_REQUEST_ID_INVALID", 422)
        _raise_if_cancelled(cancel_event)

        request = ChatCompletionRequestV3(
            messages=(
                ChatMessageV3(
                    role=ChatRole.ROLE_USER,
                    content=(
                        TextContentPart(text=instruction),
                        ImageContentPart(mime_type=mime_type, data=data),
                    ),
                ),
            ),
            model=self._profile.model_id,
            stream=False,
            temperature=0.0,
            max_tokens=self._profile.max_output_tokens,
            include_usage=True,
        )
        try:
            result = invoke_typed(
                self._client,
                capability=CAPABILITY_ID,
                interface_version=CHAT_COMPLETION_V3_INTERFACE_VERSION,
                method=CHAT_COMPLETION_V3_METHOD,
                request_type_url=CHAT_COMPLETION_V3_REQUEST_TYPE_URL,
                request_bytes=encode_chat_completion_request_v3(request),
                response_type_url=CHAT_COMPLETION_V3_RESPONSE_TYPE_URL,
                deadline_seconds=self._binding.deadline_seconds,
                cancel_event=cancel_event,
                request_id=request_id,
            )
            response = decode_chat_completion_response_v3(result.value)
        except DirectCapabilityError as error:
            if error.code == "DIRECT_PLUGIN_CANCELLED" or _cancelled(cancel_event):
                raise _vision_error("MEDIA_OPERATION_CANCELLED", 409) from error
            raise PersistenceError(
                error.code,
                503 if error.unavailable else 502,
                "The configured image understanding provider is unavailable or failed.",
                error.retryable,
            ) from error
        except (ChatCodecError, ValueError) as error:
            raise _vision_error("MEDIA_VISION_PROTOCOL_INVALID", 502) from error

        _raise_if_cancelled(cancel_event)
        description, prompt_tokens, completion_tokens = _read_description(response.chunks)
        _raise_if_cancelled(cancel_event)
        return VisionResult(
            description=description,
            model=self._profile.model_id,
            image_sha256=digest,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )


def _validate_image(
    *,
    artifact_id: str,
    sha256: str,
    mime_type: str,
    data: bytes,
    maximum_bytes: int,
) -> str:
    """Bind Work attachment metadata to inline bytes and a small image allowlist."""

    if not isinstance(mime_type, str) or mime_type not in _ALLOWED_IMAGE_MIME_TYPES:
        raise _vision_error("MEDIA_IMAGE_MIME_UNSUPPORTED", 415)
    if (
        not isinstance(data, bytes)
        or not data
        or len(data) > maximum_bytes
        or len(data) > _MAX_IMAGE_BYTES
    ):
        raise _vision_error("MEDIA_IMAGE_SIZE_INVALID", 413)
    digest = hashlib.sha256(data).hexdigest()
    if (
        not isinstance(artifact_id, str)
        or not isinstance(sha256, str)
        or artifact_id != digest
        or sha256 != digest
    ):
        raise _vision_error("WORK_ATTACHMENT_DIGEST_MISMATCH", 502)
    if not _image_signature_matches(mime_type, data):
        raise _vision_error("MEDIA_IMAGE_CONTENT_TYPE_MISMATCH", 415)
    return digest


def _image_signature_matches(mime_type: str, data: bytes) -> bool:
    """Check the MIME claim against the file signature before provider upload."""

    if mime_type == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if mime_type == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if mime_type == "image/webp":
        return len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP"
    return False


def _validate_prompt(prompt: str) -> str:
    """Bound the untrusted question while keeping model/system settings server-owned."""

    if not isinstance(prompt, str) or not prompt.strip():
        raise _vision_error("MEDIA_PROMPT_INVALID", 422)
    normalized = prompt.strip()
    if len(normalized.encode("utf-8")) > _MAX_PROMPT_BYTES:
        raise _vision_error("MEDIA_PROMPT_LIMIT", 413)
    return normalized


def _read_description(chunks: tuple[object, ...]) -> tuple[str, int | None, int | None]:
    """Assemble a bounded non-streamed assistant response without accepting tool calls."""

    if not chunks or len(chunks) > 128:
        raise _vision_error("MEDIA_VISION_RESULT_INVALID", 502)
    text_parts: list[str] = []
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    for chunk in chunks:
        role = getattr(chunk, "role", None)
        if role is not None and role != "assistant":
            raise _vision_error("MEDIA_VISION_RESULT_INVALID", 502)
        if getattr(chunk, "tool_calls", ()):
            raise _vision_error("MEDIA_VISION_TOOL_CALL_UNEXPECTED", 502)
        finish_reason = getattr(chunk, "finish_reason", None)
        if finish_reason == "content_filter":
            raise _vision_error("MEDIA_VISION_PROVIDER_FILTERED", 422)
        if finish_reason not in {None, "stop", "length"}:
            raise _vision_error("MEDIA_VISION_RESULT_INVALID", 502)
        delta = getattr(chunk, "delta", None)
        if not isinstance(delta, str):
            raise _vision_error("MEDIA_VISION_RESULT_INVALID", 502)
        text_parts.append(delta)
        if sum(len(part.encode("utf-8")) for part in text_parts) > _MAX_DESCRIPTION_BYTES:
            raise _vision_error("MEDIA_VISION_RESULT_LIMIT", 502)
        prompt_tokens = _consistent_usage(prompt_tokens, getattr(chunk, "prompt_tokens", None))
        completion_tokens = _consistent_usage(
            completion_tokens, getattr(chunk, "completion_tokens", None)
        )
    description = "".join(text_parts).strip()
    if not description:
        raise _vision_error("MEDIA_VISION_RESULT_EMPTY", 502)
    return description, prompt_tokens, completion_tokens


def _consistent_usage(current: int | None, candidate: object) -> int | None:
    """Reject malformed or conflicting usage metadata while allowing absent usage."""

    if candidate is None:
        return current
    if isinstance(candidate, bool) or not isinstance(candidate, int) or candidate < 0:
        raise _vision_error("MEDIA_VISION_RESULT_INVALID", 502)
    if current is not None and current != candidate:
        raise _vision_error("MEDIA_VISION_RESULT_INVALID", 502)
    return candidate


def _cancelled(cancel_event: threading.Event | None) -> bool:
    return cancel_event is not None and cancel_event.is_set()


def _raise_if_cancelled(cancel_event: threading.Event | None) -> None:
    if _cancelled(cancel_event):
        raise _vision_error("MEDIA_OPERATION_CANCELLED", 409)


def _vision_error(code: str, status: int) -> PersistenceError:
    """Create a stable redacted multimodal error without provider or image data."""

    return PersistenceError(
        code,
        status,
        "The image could not be processed by the configured provider.",
        retryable=status == 503,
    )


__all__ = ["DirectVisionProvider", "VisionProfile", "VisionResult"]
