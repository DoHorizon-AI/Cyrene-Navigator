"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 ports.py                                                         │
│  Module: cyrene_navigator.work.conversation_migration.ports           │
│  Role: Injection contracts for host auth, canonical stores, and jobs.│
│                                                                      │
│  模块职责：定义宿主授权、规范存储、图谱 provider 与 Work 检查点端口。  │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from .models import ActorScope, AuthorizedConversationContext, MigrationRecord


@dataclass(frozen=True, slots=True)
class SourceLine:
    """One source row with its byte or sequence cursor after consumption."""

    value: object | None
    cursor_after: str
    error_code: str | None = None


@dataclass(frozen=True, slots=True)
class SourcePage:
    """One bounded source page and its opaque next cursor."""

    items: tuple[SourceLine, ...]
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class AuthorizationDecision:
    """Host decision for an exact source lineage and current authorization epoch."""

    allowed: bool
    authorization_epoch: int
    reason_code: str | None = None

    def __post_init__(self) -> None:
        """Reject invalid host authorization epochs before a decision is consumed."""

        if type(self.allowed) is not bool:
            raise ValueError("authorization allowed must be boolean")
        if type(self.authorization_epoch) is not int or self.authorization_epoch < 0:
            raise ValueError("authorization epoch must be a non-negative integer")
        if self.reason_code is not None and (
            not isinstance(self.reason_code, str) or len(self.reason_code) > 128
        ):
            raise ValueError("authorization reason code must be bounded text")


@dataclass(frozen=True, slots=True)
class OperationHandle:
    """Existing Work Operation receipt returned before a canonical write."""

    operation_id: str
    status: str
    evidence: Mapping[str, object]
    duplicate: bool


class MigrationSource(Protocol):
    """Host-resolved staged artifact with bounded pages and immutable digest."""

    @property
    def artifact_id(self) -> str:
        """Return the opaque host artifact identity, not a filesystem path."""
        ...

    @property
    def expected_sha256(self) -> str:
        """Return the host-verified SHA-256 digest of the complete artifact."""
        ...

    @property
    def header(self) -> Mapping[str, object]:
        """Return the validated source-kind and declared record count."""
        ...

    def verify(self) -> None:
        """Re-read and verify the exact complete artifact digest and byte bound."""
        ...

    def read_page(self, cursor: str | None, limit: int) -> SourcePage:
        """Read one ordered page without materializing the complete import file."""
        ...


class CurrentAuthorizationPort(Protocol):
    """Host-backed identity and live source authorization; no archive can implement it."""

    def authorize_artifact(self, scope: ActorScope, artifact_id: str, sha256: str) -> bool:
        """Require the exact staged artifact to be available to this authenticated actor."""
        ...

    def resolve_conversation_context(
        self,
        scope: ActorScope,
        *,
        artifact_id: str,
        source_conversation_id: str,
        source_conversation_kind: str,
        source_persona_id: str | None,
    ) -> AuthorizedConversationContext | None:
        """Map archive context to an authorized target; never trust archived IDs directly."""
        ...

    def authorize_staged_record(
        self,
        scope: ActorScope,
        *,
        artifact_id: str,
        artifact_sha256: str,
        record: MigrationRecord,
    ) -> AuthorizationDecision:
        """Authorize this staged lineage for import without trusting archived identity."""
        ...

    def authorize_source_refs(
        self,
        scope: ActorScope,
        *,
        conversation_id: str,
        conversation_kind: str,
        persona_id: str | None,
        source_refs: Sequence[Mapping[str, object]],
    ) -> AuthorizationDecision:
        """Check current source grants and versions before canonical projection."""
        ...

    def approve_profile_activation(
        self, scope: ActorScope, approval_ref: str | None, record_digest: str
    ) -> bool:
        """Return a host-verified approval; never read approval state from the archive."""
        ...

    def approve_graph_projection(
        self, scope: ActorScope, approval_ref: str | None, record_digest: str
    ) -> bool:
        """Authorize a graph mutation independently from archive-supplied state."""
        ...

    def approve_rollback(self, scope: ActorScope, batch_id: str, plan_sha256: str) -> bool:
        """Authorize rollback against current actor scope and the exact imported batch."""
        ...

    def approve_import(self, scope: ActorScope, approval_ref: str | None, plan_sha256: str) -> bool:
        """Require explicit current host approval for this exact dry-run plan."""
        ...


class RollbackCapabilityPort(Protocol):
    """Host adapter that proves every accepted projection has a real compensation path."""

    def missing_capabilities(self, scope: ActorScope, *, required: Sequence[str]) -> Sequence[str]:
        """Return unavailable canonical rollback capabilities without mutating state."""
        ...


class MemoryProjectionPort(Protocol):
    """Public canonical P2 message and memory operations with independent readback."""

    def create_message(self, scope: ActorScope, body: Mapping[str, object]) -> Mapping[str, object]:
        """Idempotently write one message using the host-derived actor scope."""
        ...

    def get_message(self, scope: ActorScope, message_id: str) -> Mapping[str, object] | None:
        """Read back one message by canonical ID in the same actor scope."""
        ...

    def create_memory(self, scope: ActorScope, body: Mapping[str, object]) -> Mapping[str, object]:
        """Idempotently write one evidence-backed canonical memory."""
        ...

    def get_memory(
        self, scope: ActorScope, memory_id: str, *, include_deleted: bool = False
    ) -> Mapping[str, object] | None:
        """Read back one memory, optionally including its same-actor tombstone."""
        ...

    def delete_memory(
        self, scope: ActorScope, memory_id: str, expected_version: int
    ) -> Mapping[str, object]:
        """Compensate one imported memory with a version-checked canonical delete."""
        ...

    def revoke_message(self, scope: ActorScope, message_id: str) -> Mapping[str, object]:
        """Revoke one imported source message and cascade lineage invalidation."""
        ...


class ProfileProjectionPort(Protocol):
    """Canonical profile candidate lifecycle; activation requires host approval."""

    def create_candidate(
        self, scope: ActorScope, body: Mapping[str, object]
    ) -> Mapping[str, object]:
        """Persist a sourced candidate without activating it."""
        ...

    def get_candidate(self, scope: ActorScope, candidate_id: str) -> Mapping[str, object] | None:
        """Read back one candidate with exact evidence and version."""
        ...

    def activate_candidate(
        self, scope: ActorScope, candidate_id: str, expected_version: int
    ) -> Mapping[str, object]:
        """Reauthorize source lineage and activate only after independent host approval."""
        ...

    def get_profile(self, scope: ActorScope, profile_id: str) -> Mapping[str, object] | None:
        """Read back one active profile revision in actor scope."""
        ...

    def rollback_profile(
        self, scope: ActorScope, profile_id: str, expected_version: int
    ) -> Mapping[str, object]:
        """Roll back an activated profile through its canonical CAS lifecycle."""
        ...

    def rollback_candidate(
        self, scope: ActorScope, candidate_id: str, expected_version: int
    ) -> Mapping[str, object]:
        """Retire an unactivated candidate idempotently for batch rollback."""
        ...


class GraphProjectionPort(Protocol):
    """Provider-backed graph projection and compensating rollback operations."""

    def project_changeset(
        self, scope: ActorScope, body: Mapping[str, object], *, operation_id: str
    ) -> Mapping[str, object]:
        """Reauthorize, reconcile by operation ID, provider-write/read back, then apply receipt."""
        ...

    def get_changeset(self, scope: ActorScope, changeset_id: str) -> Mapping[str, object] | None:
        """Read back the changeset and re-read provider state when it is projected."""
        ...

    def rollback_changeset(
        self, scope: ActorScope, changeset_id: str, expected_version: int
    ) -> Mapping[str, object]:
        """Compensate provider nodes and edges, verify readback, and CAS the domain state."""
        ...


class WorkOperationPort(Protocol):
    """Adapter over the existing durable Work Operation store, not a new journal."""

    def begin(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        idempotency_key: str,
        operation_type: str,
        request: Mapping[str, object],
    ) -> OperationHandle:
        """Persist the exact intent before any canonical or provider write."""
        ...

    def complete(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        operation_id: str,
        evidence: Mapping[str, object],
    ) -> OperationHandle:
        """Record independent readback evidence as the terminal verified receipt."""
        ...

    def get(self, scope: ActorScope, *, task_id: str, operation_id: str) -> OperationHandle:
        """Reconcile an existing operation without blindly repeating an unknown effect."""
        ...


class WorkTaskProgressPort(Protocol):
    """Adapter over existing Work Task events/cursors for bounded recovery checkpoints."""

    def append_checkpoint(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        event_id: str,
        event: Mapping[str, object],
    ) -> None:
        """Append one idempotent bounded checkpoint event to the existing task."""
        ...

    def list_checkpoints(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        batch_id: str,
        after_sequence: int,
        limit: int,
    ) -> tuple[Sequence[Mapping[str, Any]], int]:
        """Read a bounded checkpoint page and return its last task event sequence."""
        ...
