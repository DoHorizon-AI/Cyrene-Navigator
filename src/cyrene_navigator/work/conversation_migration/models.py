"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 models.py                                                        │
│  Module: cyrene_navigator.work.conversation_migration.models          │
│  Role: Typed scope, record, limit, preview, and import receipts.     │
│                                                                      │
│  模块职责：定义迁移数据模型与有界校验错误，不保存独立状态。             │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

RecordKind = Literal["message", "memory", "profile", "graph"]
ConversationKind = Literal["direct", "group", "channel"]
Visibility = Literal["private", "conversation", "workspace"]


class MigrationError(ValueError):
    """A fail-closed input, authorization, projection, or recovery failure."""

    def __init__(self, code: str, detail: str) -> None:
        """Create a safe error without embedding imported content or identity."""

        super().__init__(detail)
        self.code = code


@dataclass(frozen=True, slots=True)
class ActorScope:
    """Authenticated target scope supplied by the host, never by an archive."""

    organization_id: str | None
    workspace_id: str
    actor_id: str

    def __post_init__(self) -> None:
        """Reject incomplete host scope before any artifact or store operation."""

        if self.organization_id is not None and (
            not isinstance(self.organization_id, str)
            or not self.organization_id.strip()
            or len(self.organization_id) > 256
        ):
            raise ValueError("organization_id must be bounded non-empty text or None")
        for name, value, maximum in (
            ("workspace_id", self.workspace_id, 256),
            ("actor_id", self.actor_id, 512),
        ):
            if not isinstance(value, str) or not value.strip() or len(value) > maximum:
                raise ValueError(f"{name} must be bounded non-empty text")


@dataclass(frozen=True, slots=True)
class AuthorizedConversationContext:
    """Host-resolved conversation and persona IDs after checking current access."""

    conversation_id: str
    conversation_kind: ConversationKind
    persona_id: str | None

    def __post_init__(self) -> None:
        """Require a complete target context from the host resolver."""

        if (
            not isinstance(self.conversation_id, str)
            or not self.conversation_id.strip()
            or len(self.conversation_id) > 512
        ):
            raise ValueError("conversation_id must be bounded host-resolved text")
        if self.conversation_kind not in {"direct", "group", "channel"}:
            raise ValueError("conversation_kind is unsupported")
        if self.persona_id is not None and (
            not isinstance(self.persona_id, str)
            or not self.persona_id.strip()
            or len(self.persona_id) > 512
        ):
            raise ValueError("persona_id must be bounded host-resolved text or None")


@dataclass(frozen=True, slots=True)
class MigrationSettings:
    """Hard limits applied before parsing, staging, projection, and recovery."""

    max_artifact_bytes: int = 10_000_000
    max_line_bytes: int = 256_000
    max_records: int = 100_000
    max_page_records: int = 100
    max_source_refs: int = 256
    max_text_chars: int = 100_000

    def __post_init__(self) -> None:
        """Keep all runtime bounds within the supported acceptance envelope."""

        bounds = {
            "max_artifact_bytes": (1, 10_000_000),
            "max_line_bytes": (1, 1_000_000),
            "max_records": (1, 1_000_000),
            "max_page_records": (1, 500),
            "max_source_refs": (1, 1_024),
            "max_text_chars": (1, 100_000),
        }
        for name, (minimum, maximum) in bounds.items():
            value = getattr(self, name)
            if type(value) is not int or not minimum <= value <= maximum:
                raise ValueError(f"{name} must be an integer from {minimum} to {maximum}")


@dataclass(frozen=True, slots=True)
class MigrationRecord:
    """One allowlisted, source-linked record with no imported principal fields."""

    record_id: str
    kind: RecordKind
    conversation_id: str
    conversation_kind: ConversationKind
    persona_id: str | None
    visibility: Visibility
    source_record_ids: tuple[str, ...]
    valid_until: int | None
    data: Mapping[str, object] = field(repr=False)
    digest: str


@dataclass(frozen=True, slots=True)
class QuarantinedRecord:
    """Privacy-safe rejection marker; it never retains the rejected payload."""

    ordinal: int
    reason: str


@dataclass(frozen=True, slots=True)
class ImportPreview:
    """Dry-run counts and digest tied to the exact staged artifact and target scope."""

    artifact_id: str
    artifact_sha256: str
    plan_sha256: str
    record_count: int
    accepted_count: int
    quarantined_count: int
    accepted_by_kind: Mapping[str, int]
    quarantine_reasons: Mapping[str, int]


@dataclass(frozen=True, slots=True)
class MigrationReceipt:
    """Count-reconciled operation result without raw imported content."""

    batch_id: str
    artifact_sha256: str
    status: Literal["previewed", "applied", "rolled_back"]
    read_count: int
    projected_count: int
    candidate_count: int
    replayed_count: int
    quarantined_count: int
    rolled_back_count: int
    projection_sha256: str
    completed_cursor: str | None
