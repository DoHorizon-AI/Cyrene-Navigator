"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 media_library.py                                                     │
│  Module: cyrene_navigator.work.conversation_capabilities.media_library    │
│  Role: Thin signed client for the official actor-scoped media library.   │
│                                                                          │
│  模块职责：复用 `cyrene.tools.media` 管理 emoji/sticker 图片资产与 PNG。 │
│  · 不复制目录/渲染；导入依赖 host permit，生成制品不触发消息发送。      │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from cyrene_integration_contracts import TOOL_OPERATIONS

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal

from .config import ToolCallerSettings
from .media import MediaCollectionPermit, MediaTurnContext, WorkMediaAttachmentRecord
from .peripheral import DirectToolProviderClient, HostTrustedCallerSigner

_MEDIA_TOOL_IDS = frozenset(
    {
        "media.asset.import",
        "media.asset.search",
        "media.asset.get",
        "media.asset.delete",
        "media.asset.restore",
        "media.card.render",
    }
)
_IMAGE_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
_ASSET_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_TAG = re.compile(r"[\w][\w.-]{0,47}\Z", re.UNICODE)
_SEARCH_PAGE_SIZE = 20
_MAX_SELECTION_PAGES = 5

MediaCategory = Literal["emoji", "sticker"]


@dataclass(frozen=True, slots=True)
class MediaAsset:
    """One actual actor-scoped catalog record returned by `cyrene.tools.media`."""

    asset_id: str
    digest: str
    mime_type: str
    byte_size: int
    title: str
    alt_text: str
    tags: tuple[str, ...]
    width: int
    height: int
    created_at: int


@dataclass(frozen=True, slots=True)
class MediaArtifactReceipt:
    """A generated or exported image artifact written by the official media library."""

    artifact_id: str
    sha256: str
    mime_type: str
    size: int


@dataclass(frozen=True, slots=True)
class MediaAssetPage:
    """One bounded category-filtered page from the persistent catalog."""

    items: tuple[MediaAsset, ...]
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class MediaAssetSelection:
    """A query result that identifies an actual catalog asset, never a generated ID."""

    asset: MediaAsset
    query: str
    score: int


@dataclass(frozen=True, slots=True)
class MediaAssetExport:
    """A stored asset plus its new Work artifact reference; sending is separate."""

    asset: MediaAsset
    artifact: MediaArtifactReceipt


class DirectMediaLibraryClient:
    """Call the official media tool provider with a fixed caller and binding profile."""

    def __init__(
        self,
        tool_client: DirectToolProviderClient,
        signer: HostTrustedCallerSigner,
        profile: ToolCallerSettings,
    ) -> None:
        allowed = frozenset(profile.tool_ids)
        if allowed != _MEDIA_TOOL_IDS:
            raise ValueError(
                "media library caller allowlist must contain the six fixed media tools"
            )
        self._tool_client = tool_client
        self._signer = signer
        self._profile = profile
        self._observed_successful_call = False

    def status(self) -> Mapping[str, object]:
        """Report configuration separately from an observed successful provider call."""

        return {
            "configured": True,
            "available": self._observed_successful_call,
            "reason_code": None if self._observed_successful_call else "NOT_VERIFIED",
        }

    def collect_attachment(
        self,
        *,
        turn: MediaTurnContext,
        attachment: WorkMediaAttachmentRecord,
        permit: MediaCollectionPermit,
        category: MediaCategory,
        title: str,
        alt_text: str = "",
        tags: Sequence[str] = (),
        cancel_event: Any = None,
    ) -> MediaAsset:
        """Import an explicitly authorized image and independently verify catalog readback.

        `permit` is issued only by the Harness after an explicit user collection action.
        The provider resolves bytes through its host-scoped Work artifact bridge; this
        method never accepts or persists caller-supplied media bytes.
        """

        attachment.validate()
        permit.validate(turn, attachment)
        if attachment.mime_type not in _IMAGE_MIME_TYPES:
            raise _media_error("MEDIA_COLLECTION_MIME_UNSUPPORTED", 415)
        clean_title = _bounded_text(title, "asset title", 160, required=True)
        clean_alt_text = _bounded_text(alt_text, "asset alt text", 1_000, required=False)
        normalized_tags = _normalize_tags(category, tags)
        arguments = {
            "artifact_id": attachment.artifact_id,
            "title": clean_title,
            "alt_text": clean_alt_text,
            "tags": list(normalized_tags),
        }
        returned = self._invoke(
            "media.asset.import",
            arguments,
            principal=turn.principal,
            workspace_id=turn.workspace_id,
            request_id=turn.request_id,
            cancel_event=cancel_event or turn.cancel_event,
            mutating=True,
        )
        imported = _parse_asset(returned)
        self._observed_successful_call = True
        if imported.digest != attachment.sha256 or category not in imported.tags:
            raise _media_error("MEDIA_ASSET_IMPORT_MISMATCH", 502)
        readback = self.search_assets(
            category=category,
            query="",
            limit=_SEARCH_PAGE_SIZE,
            principal=turn.principal,
            workspace_id=turn.workspace_id,
            request_id=_new_request_id(),
            cancel_event=cancel_event or turn.cancel_event,
        )
        if not any(
            asset.asset_id == imported.asset_id and asset.digest == imported.digest
            for asset in readback.items
        ):
            raise _media_error("MEDIA_ASSET_READBACK_MISMATCH", 502)
        return imported

    def search_assets(
        self,
        *,
        category: MediaCategory,
        query: str = "",
        limit: int = 20,
        cursor: str | None = None,
        principal: PersistencePrincipal,
        workspace_id: str,
        request_id: str | None = None,
        cancel_event: Any = None,
    ) -> MediaAssetPage:
        """List only catalog assets tagged with one supported emoji/sticker category."""

        _validate_category(category)
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= _SEARCH_PAGE_SIZE
        ):
            raise _media_error("MEDIA_SEARCH_LIMIT_INVALID", 422)
        clean_query = _bounded_text(query, "asset search query", 128, required=False)
        search_query = clean_query or category
        arguments: dict[str, object] = {"query": search_query, "limit": limit}
        if cursor is not None:
            if not isinstance(cursor, str) or len(cursor.encode("utf-8")) > 256:
                raise _media_error("MEDIA_SEARCH_CURSOR_INVALID", 422)
            arguments["cursor"] = cursor
        result = self._invoke(
            "media.asset.search",
            arguments,
            principal=principal,
            workspace_id=workspace_id,
            request_id=request_id or _new_request_id(),
            cancel_event=cancel_event,
            mutating=False,
        )
        raw_items = result.get("items")
        next_cursor = result.get("next_cursor")
        if (
            not isinstance(raw_items, list)
            or len(raw_items) > limit
            or (next_cursor is not None and not isinstance(next_cursor, str))
        ):
            raise _media_error("MEDIA_PROVIDER_RESPONSE_INVALID", 502)
        assets = tuple(
            asset for asset in (_parse_asset(item) for item in raw_items) if category in asset.tags
        )
        if len(assets) > limit:
            raise _media_error("MEDIA_PROVIDER_RESPONSE_INVALID", 502)
        self._observed_successful_call = True
        return MediaAssetPage(items=assets, next_cursor=next_cursor)

    def select_asset(
        self,
        *,
        category: MediaCategory,
        query: str,
        principal: PersistencePrincipal,
        workspace_id: str,
        request_id: str | None = None,
        cancel_event: Any = None,
    ) -> MediaAssetSelection:
        """Select one real category-tagged asset by bounded title/alt/tag query matching."""

        clean_query = _bounded_text(query, "asset selection query", 128, required=True)
        pages: list[MediaAsset] = []
        cursor: str | None = None
        for _ in range(_MAX_SELECTION_PAGES):
            page = self.search_assets(
                category=category,
                query="",
                limit=_SEARCH_PAGE_SIZE,
                cursor=cursor,
                principal=principal,
                workspace_id=workspace_id,
                request_id=request_id or _new_request_id(),
                cancel_event=cancel_event,
            )
            pages.extend(page.items)
            cursor = page.next_cursor
            if cursor is None:
                break
        if cursor is not None:
            raise _media_error("MEDIA_ASSET_SELECTION_INCOMPLETE", 503, retryable=True)
        scored = [(_score_asset(clean_query, asset), asset) for asset in pages]
        scored = [(score, asset) for score, asset in scored if score > 0]
        if not scored:
            raise _media_error("MEDIA_ASSET_NOT_FOUND", 404)
        scored.sort(key=lambda item: (-item[0], item[1].asset_id))
        if len(scored) > 1 and scored[0][0] == scored[1][0]:
            raise _media_error("MEDIA_ASSET_SELECTION_AMBIGUOUS", 409)
        score, asset = scored[0]
        return MediaAssetSelection(asset=asset, query=clean_query, score=score)

    def get_asset(
        self,
        *,
        asset_id: str,
        principal: PersistencePrincipal,
        workspace_id: str,
        name: str | None = None,
        request_id: str | None = None,
        cancel_event: Any = None,
    ) -> MediaAssetExport:
        """Export a verified library asset to a Work artifact without sending it."""

        _validate_asset_id(asset_id)
        arguments: dict[str, object] = {"asset_id": asset_id}
        if name is not None:
            arguments["name"] = _bounded_text(name, "artifact name", 512, required=True)
        result = self._invoke(
            "media.asset.get",
            arguments,
            principal=principal,
            workspace_id=workspace_id,
            request_id=request_id or _new_request_id(),
            cancel_event=cancel_event,
            mutating=True,
        )
        raw_asset = result.get("asset")
        raw_artifact = result.get("artifact")
        asset = _parse_asset(raw_asset)
        artifact = _parse_artifact(raw_artifact)
        if asset.asset_id != asset_id or asset.digest != artifact.sha256:
            raise _media_error("MEDIA_ASSET_EXPORT_MISMATCH", 502)
        self._observed_successful_call = True
        return MediaAssetExport(asset=asset, artifact=artifact)

    def render_card(
        self,
        *,
        title: str,
        body: str,
        principal: PersistencePrincipal,
        workspace_id: str,
        theme: Literal["light", "dark", "warm"] = "light",
        request_id: str | None = None,
        cancel_event: Any = None,
    ) -> MediaAssetExport:
        """Render a real PNG via the formal library and return a separate Work artifact."""

        clean_title = _bounded_text(title, "card title", 120, required=True)
        clean_body = _bounded_text(body, "card body", 800, required=True)
        if theme not in {"light", "dark", "warm"}:
            raise _media_error("MEDIA_CARD_THEME_INVALID", 422)
        result = self._invoke(
            "media.card.render",
            {"title": clean_title, "body": clean_body, "theme": theme},
            principal=principal,
            workspace_id=workspace_id,
            request_id=request_id or _new_request_id(),
            cancel_event=cancel_event,
            mutating=True,
        )
        asset = _parse_asset(result.get("asset"))
        artifact = _parse_artifact(result.get("artifact"))
        if asset.mime_type != "image/png" or artifact.mime_type != "image/png":
            raise _media_error("MEDIA_CARD_RENDER_MIME_INVALID", 502)
        if asset.digest != artifact.sha256 or asset.byte_size != artifact.size:
            raise _media_error("MEDIA_CARD_RENDER_READBACK_MISMATCH", 502)
        self._observed_successful_call = True
        return MediaAssetExport(asset=asset, artifact=artifact)

    def _invoke(
        self,
        tool_id: str,
        arguments: Mapping[str, object],
        *,
        principal: PersistencePrincipal,
        workspace_id: str,
        request_id: str,
        cancel_event: Any,
        mutating: bool,
    ) -> Mapping[str, Any]:
        """Sign and invoke one fixed media tool once; uncertain writes are never replayed."""

        if cancel_event is not None and cancel_event.is_set():
            raise _media_error("MEDIA_OPERATION_CANCELLED", 409)
        if tool_id not in _MEDIA_TOOL_IDS or tool_id not in self._profile.tool_ids:
            raise _media_error("MEDIA_TOOL_NOT_CONFIGURED", 503)
        operation_id = TOOL_OPERATIONS.get(tool_id)
        if operation_id != tool_id:
            raise _media_error("MEDIA_TOOL_CONTRACT_MISMATCH", 503)
        caller_context = self._signer.sign_context(
            method=tool_id,
            operation_id=operation_id,
            payload=arguments,
            principal=principal,
            workspace_id=workspace_id,
            binding_id=self._profile.binding_id,
            caller_workload=self._profile.caller_workload,
            audience=self._profile.audience,
            request_id=request_id,
        )
        try:
            result = self._tool_client.call_tool(
                tool_id,
                arguments,
                caller_context,
                cancel_event=cancel_event,
                request_id=request_id,
            )
        except Exception as error:
            if isinstance(error, PersistenceError):
                raise
            side_effect_possible = bool(getattr(error, "side_effect_possible", False))
            retryable = bool(getattr(error, "retryable", False))
            if cancel_event is not None and cancel_event.is_set():
                if mutating and side_effect_possible:
                    raise _media_error("MEDIA_OPERATION_UNCERTAIN", 503) from error
                raise _media_error("MEDIA_OPERATION_CANCELLED", 409) from error
            if mutating and side_effect_possible:
                raise _media_error("MEDIA_OPERATION_UNCERTAIN", 503) from error
            status = 503 if bool(getattr(error, "unavailable", retryable)) else 502
            raise _media_error(
                "MEDIA_PROVIDER_UNAVAILABLE" if status == 503 else "MEDIA_PROVIDER_FAILED",
                status,
                retryable=retryable,
            ) from error
        if not isinstance(result, Mapping):
            raise _media_error("MEDIA_PROVIDER_RESPONSE_INVALID", 502)
        return result


def _parse_asset(value: object) -> MediaAsset:
    """Validate one official media asset record without exposing provider internals."""

    if not isinstance(value, Mapping):
        raise _media_error("MEDIA_PROVIDER_RESPONSE_INVALID", 502)
    asset_id = value.get("asset_id")
    digest = value.get("digest")
    mime_type = value.get("mime_type")
    byte_size = value.get("byte_size")
    title = value.get("title")
    alt_text = value.get("alt_text")
    tags = value.get("tags")
    width = value.get("width")
    height = value.get("height")
    created_at = value.get("created_at")
    if (
        not isinstance(asset_id, str)
        or _ASSET_ID.fullmatch(asset_id) is None
        or not isinstance(digest, str)
        or _SHA256.fullmatch(digest) is None
        or not isinstance(mime_type, str)
        or mime_type not in _IMAGE_MIME_TYPES
        or isinstance(byte_size, bool)
        or not isinstance(byte_size, int)
        or not 1 <= byte_size <= 10_000_000
        or not isinstance(title, str)
        or not isinstance(alt_text, str)
        or not isinstance(tags, list)
        or len(tags) > 32
        or any(not isinstance(tag, str) or _TAG.fullmatch(tag) is None for tag in tags)
        or isinstance(width, bool)
        or not isinstance(width, int)
        or not 1 <= width <= 20_000
        or isinstance(height, bool)
        or not isinstance(height, int)
        or not 1 <= height <= 20_000
        or width * height > 20_000_000
        or isinstance(created_at, bool)
        or not isinstance(created_at, int)
        or created_at < 0
    ):
        raise _media_error("MEDIA_PROVIDER_RESPONSE_INVALID", 502)
    return MediaAsset(
        asset_id=asset_id,
        digest=digest,
        mime_type=str(mime_type),
        byte_size=byte_size,
        title=title,
        alt_text=alt_text,
        tags=tuple(tags),
        width=width,
        height=height,
        created_at=created_at,
    )


def _parse_artifact(value: object) -> MediaArtifactReceipt:
    """Validate the formal Work bridge receipt returned by export or render."""

    if not isinstance(value, Mapping):
        raise _media_error("MEDIA_PROVIDER_RESPONSE_INVALID", 502)
    artifact_id = value.get("artifact_id")
    digest = value.get("sha256")
    mime_type = value.get("mime_type")
    size = value.get("size")
    if (
        not isinstance(artifact_id, str)
        or _SHA256.fullmatch(artifact_id) is None
        or not isinstance(digest, str)
        or artifact_id != digest
        or not isinstance(mime_type, str)
        or mime_type not in _IMAGE_MIME_TYPES
        or isinstance(size, bool)
        or not isinstance(size, int)
        or not 1 <= size <= 10_000_000
    ):
        raise _media_error("MEDIA_PROVIDER_RESPONSE_INVALID", 502)
    return MediaArtifactReceipt(
        artifact_id=artifact_id,
        sha256=digest,
        mime_type=str(mime_type),
        size=size,
    )


def _normalize_tags(category: MediaCategory, tags: Sequence[str]) -> tuple[str, ...]:
    """Keep collection labels bounded and category-scoped to emoji or stickers."""

    _validate_category(category)
    if not isinstance(tags, Sequence) or isinstance(tags, (str, bytes)) or len(tags) > 31:
        raise _media_error("MEDIA_TAGS_INVALID", 422)
    normalized: list[str] = [category]
    for tag in tags:
        if not isinstance(tag, str):
            raise _media_error("MEDIA_TAGS_INVALID", 422)
        clean = tag.strip().casefold()
        if _TAG.fullmatch(clean) is None:
            raise _media_error("MEDIA_TAGS_INVALID", 422)
        if clean not in normalized:
            normalized.append(clean)
    return tuple(normalized)


def _score_asset(query: str, asset: MediaAsset) -> int:
    """Score query tokens against actual title, alt text, and tags."""

    def tokens(value: str) -> set[str]:
        return set(re.findall(r"[\w]+", value.casefold(), flags=re.UNICODE))

    query_tokens = tokens(query)
    title_tokens = tokens(asset.title)
    alt_tokens = tokens(asset.alt_text)
    tag_tokens = {token for tag in asset.tags for token in tokens(tag)}
    return sum(
        4
        if token in title_tokens
        else 2
        if token in alt_tokens
        else 1
        if token in tag_tokens
        else 0
        for token in query_tokens
    )


def _validate_category(category: str) -> None:
    if category not in {"emoji", "sticker"}:
        raise _media_error("MEDIA_CATEGORY_UNSUPPORTED", 422)


def _validate_asset_id(asset_id: str) -> None:
    if not isinstance(asset_id, str) or _ASSET_ID.fullmatch(asset_id) is None:
        raise _media_error("MEDIA_ASSET_ID_INVALID", 422)


def _bounded_text(value: str, label: str, maximum: int, *, required: bool) -> str:
    if not isinstance(value, str):
        raise _media_error("MEDIA_TEXT_INVALID", 422)
    normalized = " ".join(value.split())
    if (required and not normalized) or len(normalized.encode("utf-8")) > maximum:
        raise _media_error("MEDIA_TEXT_LIMIT", 422)
    if any(ord(character) < 0x20 for character in normalized):
        raise _media_error("MEDIA_TEXT_INVALID", 422)
    return normalized


def _new_request_id() -> str:
    return uuid.uuid4().hex


def _media_error(code: str, status: int, *, retryable: bool = False) -> PersistenceError:
    """Create a redacted media-catalog failure; never include asset contents."""

    return PersistenceError(
        code,
        status,
        "The actor-scoped media catalog could not complete this operation.",
        retryable,
    )


__all__ = [
    "DirectMediaLibraryClient",
    "MediaArtifactReceipt",
    "MediaAsset",
    "MediaAssetExport",
    "MediaAssetPage",
    "MediaAssetSelection",
]
