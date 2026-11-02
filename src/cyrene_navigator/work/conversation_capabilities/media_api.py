"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 media_api.py                                                         │
│  Module: cyrene_navigator.work.conversation_capabilities.media_api        │
│  Role: Expose the Harness-controlled media analysis bridge.              │
│                                                                          │
│  模块职责：从 canonical Work 消息解析授权附件并返回来源绑定上下文。     │
│  · Work身份、Task来源、附件授权与读取由 core 注入，不接受客户端来源声明。│
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.work.conversation_capabilities.media import (
    MediaArtifactAuthorization,
    MediaContextContribution,
    MediaOperation,
    MediaTurnContext,
    MediaTurnContextResolver,
    WorkMediaAttachment,
    WorkMediaAttachmentAccess,
    WorkMediaAttachmentRecord,
)
from cyrene_navigator.work.conversation_capabilities.media_library import (
    DirectMediaLibraryClient,
    MediaArtifactReceipt,
    MediaAsset,
    MediaAssetExport,
    MediaAssetPage,
)
from cyrene_navigator.work.conversation_capabilities.peripheral import DirectSpeechProvider
from cyrene_navigator.work.conversation_capabilities.vision import DirectVisionProvider
from cyrene_navigator.work.models import ConversationMemorySourceRef

_AUDIO_MIME_TYPES = frozenset(
    {"audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm"}
)
_IMAGE_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
_MAX_PROMPT_CHARS = 4_096


class MediaAnalysisRequest(BaseModel):
    """Narrow browser-free request; identity and source refs come from the host."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    message_id: str = Field(alias="messageId", min_length=1, max_length=512)
    artifact_id: str = Field(alias="artifactId", pattern=r"^[0-9a-f]{64}$")
    operation: MediaOperation
    prompt: str | None = Field(default=None, max_length=_MAX_PROMPT_CHARS)


class MediaContextContributionResponse(BaseModel):
    """Text plus the canonical user-message lineage retained by the Harness."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    feature: Literal["conversation-media.v1"]
    content: str = Field(min_length=1, max_length=32_000)
    source_refs: list[ConversationMemorySourceRef] = Field(
        alias="sourceRefs", min_length=1, max_length=256
    )


class MediaAnalysisResponse(BaseModel):
    """A real contribution or an explicit no-speech result; never a placeholder."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    status: Literal["contributed", "no_speech"]
    contribution: MediaContextContributionResponse | None = None


class MediaCollectionRequest(BaseModel):
    """Collect one current Work image only with a host-issued explicit consent permit."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    message_id: str = Field(alias="messageId", min_length=1, max_length=512)
    artifact_id: str = Field(alias="artifactId", pattern=r"^[0-9a-f]{64}$")
    category: Literal["emoji", "sticker"]
    title: str = Field(min_length=1, max_length=160)
    alt_text: str = Field(default="", alias="altText", max_length=1_000)
    tags: list[str] = Field(default_factory=list, max_length=31)


class MediaSearchRequest(BaseModel):
    """Actor-scoped search over the official emoji/sticker media catalog."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    message_id: str = Field(alias="messageId", min_length=1, max_length=512)
    category: Literal["emoji", "sticker"]
    query: str = Field(default="", max_length=128)
    limit: int = Field(default=20, ge=1, le=20)
    cursor: str | None = Field(default=None, max_length=256)


class MediaSelectionRequest(BaseModel):
    """Select only a catalog candidate that actually matches a bounded query."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    message_id: str = Field(alias="messageId", min_length=1, max_length=512)
    category: Literal["emoji", "sticker"]
    query: str = Field(min_length=1, max_length=128)


class MediaAssetGetRequest(BaseModel):
    """Export one exact actual catalog asset to a Work attachment."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    message_id: str = Field(alias="messageId", min_length=1, max_length=512)
    asset_id: str = Field(alias="assetId", pattern=r"^[0-9a-f-]{36}$")
    name: str | None = Field(default=None, max_length=512)


class MediaCardRenderRequest(BaseModel):
    """Render one bounded PNG artifact; no connector send is performed."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    message_id: str = Field(alias="messageId", min_length=1, max_length=512)
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=800)
    theme: Literal["light", "dark", "warm"] = "light"


class MediaAssetResponse(BaseModel):
    """Bounded public media metadata without local paths or image bytes."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    asset_id: str = Field(alias="assetId")
    digest: str
    mime_type: str = Field(alias="mimeType")
    byte_size: int = Field(alias="byteSize")
    title: str
    alt_text: str = Field(alias="altText")
    tags: list[str]
    width: int
    height: int
    created_at: int = Field(alias="createdAt")


class MediaArtifactResponse(BaseModel):
    """Work attachment receipt returned independently from any send action."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    artifact_id: str = Field(alias="artifactId")
    sha256: str
    mime_type: str = Field(alias="mimeType")
    size: int


class MediaAssetPageResponse(BaseModel):
    """One bounded actor-scoped catalog page."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    items: list[MediaAssetResponse]
    next_cursor: str | None = Field(alias="nextCursor")


class MediaAssetExportResponse(BaseModel):
    """Actual media asset plus an actor-private Work attachment reference."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    asset: MediaAssetResponse
    artifact: MediaArtifactResponse


class MediaAssetSelectionResponse(BaseModel):
    """Actual selected catalog record, with no generated identifier fallback."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    asset: MediaAssetResponse
    score: int


def create_conversation_media_router(
    *,
    resolve_turn_context: MediaTurnContextResolver,
    attachment_access: WorkMediaAttachmentAccess,
    speech_provider: DirectSpeechProvider | None,
    vision_provider: DirectVisionProvider | None,
    media_library_client: DirectMediaLibraryClient | None = None,
) -> APIRouter:
    """Create the server-side media bridge over injected Work authorization callbacks.

    The core host supplies a resolver that authenticates the Harness principal, validates
    `X-Cyrene-Work-Task-ID`, binds the requested message to the active running task, and
    reads the message scope/source refs/attachment list from Work. The injected attachment
    access reuses `ConversationMemoryStore.authorize_artifact` and the actor-scoped Work
    attachment GET. This router never accepts caller-supplied identity or source refs.
    """

    router = APIRouter(
        prefix="/api/v1/workspaces/{workspace_id}/work/conversation-media",
        tags=["conversation-media"],
    )

    @router.post("/analyze", response_model=MediaAnalysisResponse)
    async def analyze_media(
        workspace_id: str,
        body: MediaAnalysisRequest,
        request: Request,
    ) -> MediaAnalysisResponse:
        async with _current_media_turn(
            resolve_turn_context, request, workspace_id, body.message_id
        ) as turn:
            cancel_event = turn.cancel_event
            _raise_if_cancelled(cancel_event)
            record = _current_message_attachment(turn, body.artifact_id)
            _validate_operation_mime(body.operation, record)

            before = await asyncio.to_thread(attachment_access.authorize, turn, body.artifact_id)
            _require_authorized(before, turn, record)
            attachment = await asyncio.to_thread(attachment_access.read, turn, body.artifact_id)
            _verify_attachment_bytes(attachment, record)
            _raise_if_cancelled(cancel_event)

            if body.operation == "transcribe":
                if speech_provider is None:
                    raise _media_failure("MEDIA_SPEECH_PROVIDER_UNAVAILABLE", 503, retryable=True)
                try:
                    transcription_result = await asyncio.to_thread(
                        speech_provider.transcribe,
                        data=attachment.data,
                        mime_type=attachment.mime_type,
                        language_hint=None,
                        principal=turn.principal,
                        workspace_id=turn.workspace_id,
                        request_id=turn.request_id,
                        cancel_event=cancel_event,
                    )
                except PersistenceError:
                    raise
                except Exception as error:
                    if cancel_event.is_set():
                        raise _media_failure("MEDIA_OPERATION_CANCELLED", 409) from error
                    safe_code = getattr(error, "code", None)
                    if isinstance(safe_code, str) and safe_code.startswith(
                        ("DIRECT_PLUGIN_", "SPEECH_PROVIDER_")
                    ):
                        unavailable = bool(getattr(error, "unavailable", False))
                        raise _media_failure(
                            "MEDIA_SPEECH_PROVIDER_FAILED",
                            503 if unavailable else 502,
                            retryable=bool(getattr(error, "retryable", unavailable)),
                        ) from error
                    raise
                contribution = _transcript_contribution(turn, transcription_result)
                if contribution is None:
                    status: Literal["contributed", "no_speech"] = "no_speech"
                    response_contribution = None
                else:
                    status = "contributed"
                    response_contribution = _encode_contribution(contribution)
            else:
                if vision_provider is None:
                    raise _media_failure("MEDIA_VISION_PROVIDER_UNAVAILABLE", 503, retryable=True)
                vision_result = await asyncio.to_thread(
                    vision_provider.describe_image,
                    artifact_id=attachment.artifact_id,
                    sha256=attachment.sha256,
                    mime_type=attachment.mime_type,
                    data=attachment.data,
                    prompt=body.prompt or "Describe the image accurately and concisely.",
                    request_id=turn.request_id,
                    cancel_event=cancel_event,
                )
                _raise_if_cancelled(cancel_event)
                contribution = MediaContextContribution(
                    feature="conversation-media.v1",
                    content=f"[Image analysis]\n{vision_result.description}",
                    source_refs=turn.source_refs,
                )
                status = "contributed"
                response_contribution = _encode_contribution(contribution)

            _raise_if_cancelled(cancel_event)
            _recheck_current_turn(resolve_turn_context, request, workspace_id, turn)
            after = await asyncio.to_thread(attachment_access.authorize, turn, body.artifact_id)
            _require_authorized(after, turn, record)
            _raise_if_cancelled(cancel_event)
            return MediaAnalysisResponse(status=status, contribution=response_contribution)

    @router.post("/catalog/collect", response_model=MediaAssetResponse)
    async def collect_current_attachment(
        workspace_id: str,
        body: MediaCollectionRequest,
        request: Request,
    ) -> MediaAssetResponse:
        """Collect only after the core resolver issues an explicit user-intent permit."""

        async with _current_media_turn(
            resolve_turn_context, request, workspace_id, body.message_id
        ) as turn:
            if media_library_client is None:
                raise _media_failure("MEDIA_LIBRARY_UNAVAILABLE", 503, retryable=True)
            if turn.collection_permit is None:
                raise _media_failure("MEDIA_COLLECTION_CONSENT_REQUIRED", 403)
            record = _current_message_attachment(turn, body.artifact_id)
            before = await asyncio.to_thread(attachment_access.authorize, turn, body.artifact_id)
            _require_authorized(before, turn, record)
            _raise_if_cancelled(turn.cancel_event)
            asset = await asyncio.to_thread(
                media_library_client.collect_attachment,
                turn=turn,
                attachment=record,
                permit=turn.collection_permit,
                category=body.category,
                title=body.title,
                alt_text=body.alt_text,
                tags=body.tags,
                cancel_event=turn.cancel_event,
            )
            _raise_if_cancelled(turn.cancel_event)
            _recheck_current_turn(resolve_turn_context, request, workspace_id, turn)
            after = await asyncio.to_thread(attachment_access.authorize, turn, body.artifact_id)
            _require_authorized(after, turn, record)
            return _asset_response(asset)

    @router.post("/catalog/search", response_model=MediaAssetPageResponse)
    async def search_media_catalog(
        workspace_id: str,
        body: MediaSearchRequest,
        request: Request,
    ) -> MediaAssetPageResponse:
        """Search the current principal's category-filtered media catalog."""

        async with _current_media_turn(
            resolve_turn_context, request, workspace_id, body.message_id
        ) as turn:
            if media_library_client is None:
                raise _media_failure("MEDIA_LIBRARY_UNAVAILABLE", 503, retryable=True)
            page = await asyncio.to_thread(
                media_library_client.search_assets,
                category=body.category,
                query=body.query,
                limit=body.limit,
                cursor=body.cursor,
                principal=turn.principal,
                workspace_id=turn.workspace_id,
                request_id=turn.request_id,
                cancel_event=turn.cancel_event,
            )
            _raise_if_cancelled(turn.cancel_event)
            _recheck_current_turn(resolve_turn_context, request, workspace_id, turn)
            return _asset_page_response(page)

    @router.post("/catalog/select", response_model=MediaAssetSelectionResponse)
    async def select_media_asset(
        workspace_id: str,
        body: MediaSelectionRequest,
        request: Request,
    ) -> MediaAssetSelectionResponse:
        """Select one matching actual emoji/sticker asset ID from the actor's catalog."""

        async with _current_media_turn(
            resolve_turn_context, request, workspace_id, body.message_id
        ) as turn:
            if media_library_client is None:
                raise _media_failure("MEDIA_LIBRARY_UNAVAILABLE", 503, retryable=True)
            selection = await asyncio.to_thread(
                media_library_client.select_asset,
                category=body.category,
                query=body.query,
                principal=turn.principal,
                workspace_id=turn.workspace_id,
                request_id=turn.request_id,
                cancel_event=turn.cancel_event,
            )
            _raise_if_cancelled(turn.cancel_event)
            _recheck_current_turn(resolve_turn_context, request, workspace_id, turn)
            return MediaAssetSelectionResponse(
                asset=_asset_response(selection.asset), score=selection.score
            )

    @router.post("/catalog/get", response_model=MediaAssetExportResponse)
    async def export_media_asset(
        workspace_id: str,
        body: MediaAssetGetRequest,
        request: Request,
    ) -> MediaAssetExportResponse:
        """Create a Work attachment receipt without invoking a connector send."""

        async with _current_media_turn(
            resolve_turn_context, request, workspace_id, body.message_id
        ) as turn:
            if media_library_client is None:
                raise _media_failure("MEDIA_LIBRARY_UNAVAILABLE", 503, retryable=True)
            exported = await asyncio.to_thread(
                media_library_client.get_asset,
                asset_id=body.asset_id,
                principal=turn.principal,
                workspace_id=turn.workspace_id,
                name=body.name,
                request_id=turn.request_id,
                cancel_event=turn.cancel_event,
            )
            _raise_if_cancelled(turn.cancel_event)
            _recheck_current_turn(resolve_turn_context, request, workspace_id, turn)
            return _asset_export_response(exported)

    @router.post("/catalog/render", response_model=MediaAssetExportResponse)
    async def render_media_card(
        workspace_id: str,
        body: MediaCardRenderRequest,
        request: Request,
    ) -> MediaAssetExportResponse:
        """Render one actual PNG card and return its Work artifact separately from send."""

        async with _current_media_turn(
            resolve_turn_context, request, workspace_id, body.message_id
        ) as turn:
            if media_library_client is None:
                raise _media_failure("MEDIA_LIBRARY_UNAVAILABLE", 503, retryable=True)
            rendered = await asyncio.to_thread(
                media_library_client.render_card,
                title=body.title,
                body=body.body,
                theme=body.theme,
                principal=turn.principal,
                workspace_id=turn.workspace_id,
                request_id=turn.request_id,
                cancel_event=turn.cancel_event,
            )
            _raise_if_cancelled(turn.cancel_event)
            _recheck_current_turn(resolve_turn_context, request, workspace_id, turn)
            return _asset_export_response(rendered)

    return router


def _current_message_attachment(
    turn: MediaTurnContext, artifact_id: str
) -> WorkMediaAttachmentRecord:
    """Require the opaque ID to be attached to this canonical active user message."""

    matches = [item for item in turn.attachments if item.artifact_id == artifact_id]
    if len(matches) != 1:
        raise _media_failure("MEDIA_ARTIFACT_NOT_IN_CURRENT_MESSAGE", 403)
    record = matches[0]
    record.validate()
    return record


def _validate_operation_mime(operation: MediaOperation, record: WorkMediaAttachmentRecord) -> None:
    """Route only allowlisted audio to ASR and supported image bytes to V3 vision."""

    allowed = _AUDIO_MIME_TYPES if operation == "transcribe" else _IMAGE_MIME_TYPES
    if record.mime_type not in allowed:
        code = (
            "MEDIA_AUDIO_MIME_UNSUPPORTED"
            if operation == "transcribe"
            else "MEDIA_IMAGE_MIME_UNSUPPORTED"
        )
        raise _media_failure(code, 415)


def _require_authorized(
    receipt: MediaArtifactAuthorization,
    turn: MediaTurnContext,
    record: WorkMediaAttachmentRecord,
) -> None:
    """Reject stale source grants or metadata changes before and after inference."""

    if not receipt.allowed or receipt.artifact is None:
        raise _media_failure("MEDIA_ARTIFACT_NOT_AUTHORIZED", 403)
    if receipt.current_authorization_epoch != turn.authorization_epoch:
        raise _media_failure("MEDIA_AUTHORIZATION_EPOCH_CHANGED", 409)
    if receipt.artifact != record:
        raise _media_failure("MEDIA_ATTACHMENT_METADATA_CHANGED", 409)


def _verify_attachment_bytes(
    attachment: WorkMediaAttachment,
    record: WorkMediaAttachmentRecord,
) -> None:
    """Check byte digest, MIME, and size after the authenticated Work GET."""

    attachment.verify(expected=record)
    if not _media_signature_matches(record.mime_type, attachment.data):
        raise _media_failure("WORK_ATTACHMENT_CONTENT_TYPE_MISMATCH", 415)


def _media_signature_matches(mime_type: str, data: bytes) -> bool:
    """Match supported image/audio MIME declarations to their file signatures."""

    if mime_type == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if mime_type == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if mime_type == "image/webp":
        return len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP"
    if mime_type in {"audio/wav", "audio/x-wav"}:
        return len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WAVE"
    if mime_type == "audio/mpeg":
        return data.startswith(b"ID3") or (
            len(data) >= 2 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0
        )
    if mime_type == "audio/ogg":
        return data.startswith(b"OggS")
    if mime_type == "audio/webm":
        return data.startswith(b"\x1a\x45\xdf\xa3")
    if mime_type == "audio/mp4":
        return len(data) >= 12 and data[4:8] == b"ftyp"
    return False


def _transcript_contribution(
    turn: MediaTurnContext, result: Any
) -> MediaContextContribution | None:
    """Create context only from the exact successful transcript returned by ASR."""

    if not isinstance(result, dict):
        raise _media_failure("MEDIA_SPEECH_RESULT_INVALID", 502)
    status = result.get("status")
    if status == "no_speech":
        return None
    transcript = result.get("text")
    if status != "succeeded" or not isinstance(transcript, str) or not transcript.strip():
        raise _media_failure("MEDIA_SPEECH_RESULT_INVALID", 502)
    if len(transcript.encode("utf-8")) > 32_000:
        raise _media_failure("MEDIA_SPEECH_RESULT_LIMIT", 502)
    return MediaContextContribution(
        feature="conversation-media.v1",
        content=f"[Audio transcript]\n{transcript.strip()}",
        source_refs=turn.source_refs,
    )


def _encode_contribution(
    contribution: MediaContextContribution,
) -> MediaContextContributionResponse:
    """Copy canonical source refs into the typed response consumed by the Harness."""

    return MediaContextContributionResponse(
        feature=contribution.feature,
        content=contribution.content,
        sourceRefs=list(contribution.source_refs),
    )


def _asset_response(asset: MediaAsset) -> MediaAssetResponse:
    """Project the bounded catalog metadata onto the public route DTO."""

    return MediaAssetResponse(
        assetId=asset.asset_id,
        digest=asset.digest,
        mimeType=asset.mime_type,
        byteSize=asset.byte_size,
        title=asset.title,
        altText=asset.alt_text,
        tags=list(asset.tags),
        width=asset.width,
        height=asset.height,
        createdAt=asset.created_at,
    )


def _asset_page_response(page: MediaAssetPage) -> MediaAssetPageResponse:
    return MediaAssetPageResponse(
        items=[_asset_response(asset) for asset in page.items],
        nextCursor=page.next_cursor,
    )


def _asset_export_response(exported: MediaAssetExport) -> MediaAssetExportResponse:
    artifact: MediaArtifactReceipt = exported.artifact
    return MediaAssetExportResponse(
        asset=_asset_response(exported.asset),
        artifact=MediaArtifactResponse(
            artifactId=artifact.artifact_id,
            sha256=artifact.sha256,
            mimeType=artifact.mime_type,
            size=artifact.size,
        ),
    )


@asynccontextmanager
async def _current_media_turn(
    resolver: MediaTurnContextResolver,
    request: Request,
    workspace_id: str,
    message_id: str,
) -> AsyncIterator[MediaTurnContext]:
    """Bind provider cancellation and disconnect handling to one trusted Work turn."""

    cancel_event = threading.Event()
    disconnect_task = asyncio.create_task(_watch_disconnect(request, cancel_event))
    try:
        turn = resolver(
            request=request,
            workspace_id=workspace_id,
            message_id=message_id,
            cancel_event=cancel_event,
        )
        if turn.cancel_event is not cancel_event:
            raise _media_failure("MEDIA_CANCEL_SIGNAL_MISMATCH", 500)
        turn.validate(requested_message_id=message_id, workspace_id=workspace_id)
        _raise_if_cancelled(cancel_event)
        yield turn
    except asyncio.CancelledError:
        cancel_event.set()
        raise
    finally:
        disconnect_task.cancel()
        await asyncio.gather(disconnect_task, return_exceptions=True)


def _recheck_current_turn(
    resolver: MediaTurnContextResolver,
    request: Request,
    workspace_id: str,
    original: MediaTurnContext,
) -> None:
    """Require the active Task/message context to remain identical after provider work."""

    current = resolver(
        request=request,
        workspace_id=workspace_id,
        message_id=original.message_id,
        cancel_event=original.cancel_event,
    )
    current.validate(requested_message_id=original.message_id, workspace_id=workspace_id)
    if (
        current.cancel_event is not original.cancel_event
        or current.principal.actor_id != original.principal.actor_id
        or current.principal.organization_id != original.principal.organization_id
        or current.workspace_id != original.workspace_id
        or current.message_id != original.message_id
        or current.conversation_id != original.conversation_id
        or current.conversation_kind != original.conversation_kind
        or current.persona_id != original.persona_id
        or current.authorization_epoch != original.authorization_epoch
        or current.source_refs != original.source_refs
        or current.attachments != original.attachments
        or current.collection_permit != original.collection_permit
    ):
        raise _media_failure("MEDIA_CURRENT_TURN_CHANGED", 409)


async def _watch_disconnect(request: Request, cancel_event: threading.Event) -> None:
    """Propagate client disconnect to the running DirectPluginRuntime RPC."""

    while not cancel_event.is_set():
        if await request.is_disconnected():
            cancel_event.set()
            return
        await asyncio.sleep(0.05)


def _raise_if_cancelled(cancel_event: threading.Event) -> None:
    if cancel_event.is_set():
        raise _media_failure("MEDIA_OPERATION_CANCELLED", 409)


def _media_failure(code: str, status: int, *, retryable: bool = False) -> PersistenceError:
    """Create a stable redacted API failure without request bytes or provider detail."""

    return PersistenceError(
        code,
        status,
        "The current conversation media could not be processed.",
        retryable,
    )


__all__ = [
    "MediaAnalysisRequest",
    "MediaAnalysisResponse",
    "MediaContextContributionResponse",
    "create_conversation_media_router",
]
