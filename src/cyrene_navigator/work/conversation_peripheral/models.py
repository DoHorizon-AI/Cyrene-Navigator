"""
┌─────────────────────────────────────────────────────────────────────────┐
│ 📄 models.py                                                            │
│ Module: cyrene_navigator.work.conversation_peripheral.models            │
│ Role: Strict camelCase REST contracts for media, speech, Bilibili, and   │
│       backup attachment delivery.                                       │
│                                                                         │
│ 模块职责：定义媒体、语音、B站及备份附件 REST 契约。                      │
│ · 请求中不包含 actor、凭据、endpoint 或本地路径。                         │
└─────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal

from pydantic import Field, field_validator

from cyrene_navigator.work.models import AttachmentRecord, WorkModel


class PeripheralEmptyRequest(WorkModel):
    """An explicit empty body for operations with no caller-selected inputs."""


class MediaAssetImport(WorkModel):
    """Import one existing Work attachment into the current actor's media catalog."""

    attachment_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    title: str = Field(min_length=1, max_length=160)
    alt_text: str = Field(default="", max_length=1000)
    tags: list[str] = Field(default_factory=list, max_length=32)


class MediaAssetSearch(WorkModel):
    """Search the current caller's own media catalog with opaque pagination."""

    q: str = Field(default="", max_length=128)
    cursor: str | None = Field(default=None, max_length=256)
    limit: int = Field(default=20, ge=1, le=20)


class MediaAsset(WorkModel):
    """Provider media metadata with deletion and source digest evidence."""

    asset_id: str = Field(
        min_length=1,
        max_length=256,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )
    digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    mime_type: str
    byte_size: int = Field(ge=1, le=10_000_000)
    title: str
    alt_text: str = ""
    tags: list[str] = Field(default_factory=list)
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    created_at: int = Field(ge=0)
    deleted_at: int | None = Field(default=None, ge=0)


class MediaAssetPage(WorkModel):
    """Cursor-paginated actor-owned media catalog."""

    items: list[MediaAsset]
    next_cursor: str | None = None


class MediaAssetRead(WorkModel):
    """Asset metadata plus its same-scope Work attachment reference."""

    asset: MediaAsset
    attachment: AttachmentRecord
    download_path: str


class MediaAssetDeleteReceipt(WorkModel):
    """Soft-delete acknowledgement."""

    asset_id: str
    deleted: bool


class MediaCardRender(WorkModel):
    """Render an image card without sending it to a message connector."""

    title: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1, max_length=800)
    theme: Literal["light", "dark", "warm"] = "light"


class SpeechConfig(WorkModel):
    """Redacted speech configuration; secrets and provider endpoints are omitted."""

    enabled: bool
    default_language_hint: str | None = Field(default=None, max_length=32)
    max_upload_bytes: Literal[10_000_000] = 10_000_000
    allowed_media_types: list[str] = Field(default_factory=list)


class SpeechConfigUpdate(WorkModel):
    """Safe preference updates only; binding credentials are host-managed."""

    enabled: bool
    default_language_hint: str | None = Field(default=None, max_length=32)


class SpeechStatus(WorkModel):
    """Provider availability without exposing endpoint or credential details."""

    available: bool
    model: str | None = None
    reason_code: str | None = None


class SpeechTranscriptionRequest(WorkModel):
    """Transcribe an authorized existing Work attachment (at most 10 MB)."""

    attachment_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    language_hint: str | None = Field(default=None, max_length=32)


class TranscriptSegment(WorkModel):
    """One timestamped segment returned by the configured speech provider."""

    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    text: str


class SpeechTranscription(WorkModel):
    """Truthful transcription state and optional model evidence."""

    status: Literal["succeeded", "no_speech"]
    text: str
    detected_language: str | None = None
    duration_ms: int | None = Field(default=None, ge=0)
    model: str | None = None
    segments: list[TranscriptSegment] = Field(default_factory=list)


class BilibiliAccount(WorkModel):
    """Safe account metadata projected from the authorized Exchange profile API."""

    profile_ref: str
    provider: Literal["bilibili"] = "bilibili"
    identity_ref: str
    target_scope: dict[str, Any]
    auth_status: str
    external_subject: str | None = None
    auth_mode: str | None = None
    access_mode: str = "actor_owned"
    expires_at: int | None = Field(default=None, ge=0)
    credential_revision: int = Field(default=0, ge=0)


class BilibiliAccountList(WorkModel):
    """Owned Bilibili profiles visible to the authenticated caller."""

    items: list[BilibiliAccount]


class BilibiliConnection(WorkModel):
    """Safe selection for one actor-owned Exchange connection and profile."""

    connection_ref: str = Field(
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    )
    profile_ref: str = Field(
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    )
    provider: Literal["bilibili"] = "bilibili"
    display_name: str
    enabled: bool


class BilibiliConnectionList(WorkModel):
    """Bilibili connections available to the current delegated actor."""

    items: list[BilibiliConnection]


class BilibiliLinkStart(WorkModel):
    """QR display data; login flow IDs and PNG bytes are ephemeral."""

    login_flow_id: str
    qr_code_base64: str | None = None
    qr_code_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    expires_at: datetime
    status: Literal["pending", "expired"]


class BilibiliLinkedProfile(WorkModel):
    """Safe Exchange profile metadata returned after Account Center completion."""

    profile_ref: str
    provider: Literal["bilibili"] = "bilibili"
    identity_ref: str
    target_scope: dict[str, Any]
    auth_status: str
    external_subject: str | None = None
    auth_mode: str | None = None
    access_mode: str = "actor_owned"
    expires_at: int | None = Field(default=None, ge=0)
    credential_revision: int = Field(default=0, ge=0)


class BilibiliLinkStatusRequest(WorkModel):
    """Poll one server-created QR flow; no account credentials are accepted."""

    login_flow_id: str = Field(pattern=r"^[0-9a-f]{64}$")


class BilibiliLinkStatus(WorkModel):
    """Safe QR flow state and optional linked account metadata."""

    status: Literal[
        "pending", "scanned", "linked", "expired", "failed", "unknown_result", "not_found"
    ]
    login_flow_id: str
    profile: BilibiliLinkedProfile | None = None
    relogin_required: bool = False


class BilibiliOperationList(WorkModel):
    """Fixed allowlisted read and write operations exposed by the host."""

    read_operations: list[str]
    write_operations: list[str]


class BilibiliReadRequest(WorkModel):
    """Arguments for one fixed public-read Bilibili operation."""

    arguments: dict[str, Any] = Field(default_factory=dict)

    @field_validator("arguments")
    @classmethod
    def arguments_are_bounded_json(cls, value: dict[str, Any]) -> dict[str, Any]:
        """Bound model-provided connector arguments before provider dispatch."""

        if len(json.dumps(value, allow_nan=False, separators=(",", ":")).encode()) > 64_000:
            raise ValueError("arguments exceed the 64 KB limit")
        return value


class BilibiliWriteRequest(WorkModel):
    """Arguments for one fixed write operation; replay key is a required header."""

    arguments: dict[str, Any] = Field(default_factory=dict)

    @field_validator("arguments")
    @classmethod
    def arguments_are_bounded_json(cls, value: dict[str, Any]) -> dict[str, Any]:
        """Bound model-provided connector arguments before intent is recorded."""

        if len(json.dumps(value, allow_nan=False, separators=(",", ":")).encode()) > 64_000:
            raise ValueError("arguments exceed the 64 KB limit")
        return value


class BilibiliResultArtifact(WorkModel):
    """Actor-private JSON attachment containing one safe Bilibili read result."""

    artifact_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    mime_type: Literal["application/json"]
    size: int = Field(ge=1, le=1_500_000)


class BilibiliOperationReceipt(WorkModel):
    """Canonical Work operation receipt with an optional read-result artifact."""

    operation: dict[str, Any]
    result_artifact: BilibiliResultArtifact | None = None
    duplicate: bool


class BackupCreate(WorkModel):
    """Create a bounded backup attachment through the configured host port."""


class PeripheralError(WorkModel):
    """Stable error shape returned by configured optional capability ports."""

    code: str
    retryable: bool = False


__all__ = [
    "BackupCreate",
    "BilibiliAccount",
    "BilibiliAccountList",
    "BilibiliConnection",
    "BilibiliConnectionList",
    "BilibiliLinkStart",
    "BilibiliLinkStatus",
    "BilibiliLinkStatusRequest",
    "BilibiliLinkedProfile",
    "BilibiliOperationList",
    "BilibiliOperationReceipt",
    "BilibiliReadRequest",
    "BilibiliResultArtifact",
    "BilibiliWriteRequest",
    "MediaAsset",
    "MediaAssetDeleteReceipt",
    "MediaAssetImport",
    "MediaAssetPage",
    "MediaAssetRead",
    "MediaAssetSearch",
    "MediaCardRender",
    "PeripheralEmptyRequest",
    "PeripheralError",
    "SpeechConfig",
    "SpeechConfigUpdate",
    "SpeechStatus",
    "SpeechTranscription",
    "SpeechTranscriptionRequest",
    "TranscriptSegment",
    "WorkModel",
]
