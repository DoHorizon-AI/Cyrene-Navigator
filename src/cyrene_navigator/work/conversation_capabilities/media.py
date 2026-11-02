"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 media.py                                                             │
│  Module: cyrene_navigator.work.conversation_capabilities.media            │
│  Role: Typed Work attachment and context contribution boundary.          │
│                                                                          │
│  模块职责：定义 Work 授权媒体、来源引用及 DSH 上下文贡献的窄契约。      │
│  · 授权、当前 turn、来源和读取均由宿主注入；模块不接受路径或 URL。       │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import re
import threading
from dataclasses import dataclass
from typing import Literal, Protocol

from fastapi import Request

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.models import ConversationMemorySourceRef

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_MAX_ATTACHMENT_BYTES = 10_000_000

MediaOperation = Literal["transcribe", "describe_image"]
MediaCollectionCategory = Literal["emoji", "sticker"]


@dataclass(frozen=True, slots=True)
class WorkMediaAttachment:
    """Metadata and bytes returned by an authenticated Work attachment GET."""

    artifact_id: str
    sha256: str
    mime_type: str
    size: int
    data: bytes

    def verify(self, *, expected: WorkMediaAttachmentRecord) -> None:
        """Verify the GET body against both its Work metadata and requested digest."""

        if (
            self.artifact_id != expected.artifact_id
            or self.sha256 != expected.sha256
            or self.mime_type != expected.mime_type
            or self.size != expected.size
            or not isinstance(self.data, bytes)
            or len(self.data) != self.size
            or not 1 <= self.size <= _MAX_ATTACHMENT_BYTES
            or _SHA256.fullmatch(self.artifact_id) is None
            or hashlib.sha256(self.data).hexdigest() != self.sha256
            or self.artifact_id != self.sha256
        ):
            raise _media_error("WORK_ATTACHMENT_READBACK_MISMATCH", 502)


@dataclass(frozen=True, slots=True)
class WorkMediaAttachmentRecord:
    """Allowlisted attachment metadata from the canonical user message."""

    artifact_id: str
    sha256: str
    name: str
    mime_type: str
    size: int

    def validate(self) -> None:
        """Reject malformed or unbounded Work metadata before any provider call."""

        if (
            not isinstance(self.artifact_id, str)
            or not isinstance(self.sha256, str)
            or _SHA256.fullmatch(self.artifact_id) is None
            or self.artifact_id != self.sha256
            or not isinstance(self.name, str)
            or len(self.name.encode("utf-8")) > 512
            or not isinstance(self.mime_type, str)
            or not 1 <= self.size <= _MAX_ATTACHMENT_BYTES
        ):
            raise _media_error("WORK_ATTACHMENT_METADATA_INVALID", 502)


@dataclass(frozen=True, slots=True)
class MediaTurnContext:
    """Current trusted user message resolved by the Harness/Work host callback."""

    principal: PersistencePrincipal
    workspace_id: str
    message_id: str
    conversation_id: str
    conversation_kind: Literal["direct", "group", "channel"]
    persona_id: str | None
    authorization_epoch: int
    source_refs: tuple[ConversationMemorySourceRef, ...]
    attachments: tuple[WorkMediaAttachmentRecord, ...]
    request_id: str
    cancel_event: threading.Event
    collection_permit: MediaCollectionPermit | None = None

    def validate(self, *, requested_message_id: str, workspace_id: str) -> None:
        """Require the injected turn to match this request and contain its own source."""

        if (
            self.message_id != requested_message_id
            or self.workspace_id != workspace_id
            or workspace_id not in self.principal.workspace_ids
            or not self.conversation_id
            or isinstance(self.authorization_epoch, bool)
            or not isinstance(self.authorization_epoch, int)
            or self.authorization_epoch < 0
            or not self.request_id
            or len(self.request_id.encode("utf-8")) > 200
            or not self.source_refs
            or not any(self.message_id in ref.source_message_ids for ref in self.source_refs)
        ):
            raise _media_error("MEDIA_CURRENT_TURN_INVALID", 403)


@dataclass(frozen=True, slots=True)
class MediaArtifactAuthorization:
    """Fresh server authorization for one artifact in the current message."""

    allowed: bool
    current_authorization_epoch: int
    artifact: WorkMediaAttachmentRecord | None


@dataclass(frozen=True, slots=True)
class MediaContextContribution:
    """Provider-produced text and canonical source refs; delivery remains separate."""

    feature: Literal["conversation-media.v1"]
    content: str
    source_refs: tuple[ConversationMemorySourceRef, ...]


@dataclass(frozen=True, slots=True)
class MediaCollectionPermit:
    """One host-issued permit after explicit user selection of a current attachment."""

    message_id: str
    artifact_id: str
    authorization_epoch: int
    category: MediaCollectionCategory
    consent_id: str

    def validate(self, turn: MediaTurnContext, record: WorkMediaAttachmentRecord) -> None:
        """Bind collection consent to the active canonical message and image digest."""

        if (
            self.message_id != turn.message_id
            or self.artifact_id != record.artifact_id
            or self.authorization_epoch != turn.authorization_epoch
            or self.category not in {"emoji", "sticker"}
            or not self.consent_id
            or len(self.consent_id.encode("utf-8")) > 256
            or not any(self.message_id in ref.source_message_ids for ref in turn.source_refs)
        ):
            raise _media_error("MEDIA_COLLECTION_CONSENT_REQUIRED", 403)


class WorkMediaAttachmentAccess(Protocol):
    """Injected WorkStore boundary for current source authorization and byte reads."""

    def authorize(self, turn: MediaTurnContext, artifact_id: str) -> MediaArtifactAuthorization:
        """Recheck current epoch, user message lineage, and attachment membership."""

    def read(self, turn: MediaTurnContext, artifact_id: str) -> WorkMediaAttachment:
        """Read bytes only through the principal-scoped Work attachment endpoint."""


class MediaTurnContextResolver(Protocol):
    """Resolve current user message and scope from the trusted Harness request."""

    def __call__(
        self,
        *,
        request: Request,
        workspace_id: str,
        message_id: str,
        cancel_event: threading.Event,
    ) -> MediaTurnContext:
        """Return canonical message metadata, never request-selected actor or sources."""


def _media_error(code: str, status: int, *, retryable: bool = False) -> PersistenceError:
    """Create a stable redacted Work media failure."""

    return PersistenceError(
        code,
        status,
        "The authorized media attachment could not be processed.",
        retryable,
    )


__all__ = [
    "MediaArtifactAuthorization",
    "MediaCollectionCategory",
    "MediaCollectionPermit",
    "MediaContextContribution",
    "MediaOperation",
    "MediaTurnContext",
    "MediaTurnContextResolver",
    "WorkMediaAttachment",
    "WorkMediaAttachmentAccess",
    "WorkMediaAttachmentRecord",
]
