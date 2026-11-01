"""
┌─────────────────────────────────────────────────────────────────────┐
│  Module: cyrene_navigator.work.conversation_memory.domain_models    │
│  Role: Strict HTTP DTOs for conversation product domain routes.     │
│                                                                     │
│  模块职责：定义产品域 API 的严格 camelCase 请求与响应模型。           │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel


class DomainModel(BaseModel):
    """Enforce camelCase JSON, strict types, and rejection of unknown fields."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
        strict=True,
    )


class EmptyRequest(DomainModel):
    """A request body that accepts no caller-supplied fields."""


class PersonaPut(DomainModel):
    """Create or replace an actor-owned conversation persona."""

    id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2_000)
    prompt: str = Field(min_length=1, max_length=12_000)
    enabled: bool
    conversation_ids: list[str] = Field(default_factory=list, max_length=100)


class PersonaView(DomainModel):
    """Persona projection and its server-managed version timestamps."""

    id: str
    name: str
    description: str
    prompt: str
    enabled: bool
    conversation_ids: list[str]
    version: int = Field(ge=1)
    created_at: int = Field(ge=0)
    updated_at: int = Field(ge=0)


class PersonasView(DomainModel):
    """Actor-owned persona list response."""

    items: list[PersonaView]


class PersonaReceipt(DomainModel):
    """Persona write response."""

    persona: PersonaView


ProfileSubjectKind = Literal["user", "group"]
ProfileCategory = Literal["preference", "style", "constraint", "temporary_state"]
ConversationKind = Literal["direct", "group", "channel"]


class DomainSourceRef(DomainModel):
    """Exact P2 memory revision and message lineage for derived domain data."""

    memory_id: str | None = Field(default=None, min_length=1, max_length=512)
    memory_version: int | None = Field(default=None, ge=1)
    source_message_ids: list[str] = Field(default_factory=list, max_length=128)

    @model_validator(mode="after")
    def validate_memory_revision(self) -> DomainSourceRef:
        if (self.memory_id is None) != (self.memory_version is None):
            raise ValueError("memoryId and memoryVersion must be supplied together")
        if self.memory_id is None and not self.source_message_ids:
            raise ValueError("a source reference must contain a memory or message id")
        return self


DomainSourceRefInput = DomainSourceRef | str


class ProfileCandidateCreate(DomainModel):
    """Sourced candidate data; actor identity is always derived from principal."""

    idempotency_key: str = Field(min_length=1, max_length=200)
    conversation_id: str = Field(min_length=1, max_length=200)
    conversation_kind: ConversationKind
    subject_kind: ProfileSubjectKind
    persona_id: str | None = Field(default=None, max_length=200)
    category: ProfileCategory
    text: str = Field(min_length=1, max_length=8_000)
    source_message_ids: list[str] = Field(default_factory=list, max_length=128)
    source_refs: list[DomainSourceRefInput] = Field(default_factory=list, max_length=256)
    confidence: float = Field(ge=0, le=1)
    valid_until: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def require_provenance(self) -> ProfileCandidateCreate:
        if not self.source_message_ids and not self.source_refs:
            raise ValueError("sourceMessageIds or sourceRefs are required")
        return self


class ProfileEvidence(DomainModel):
    """Evidence attached to an immutable candidate or active profile revision."""

    source_message_ids: list[str]
    source_refs: list[DomainSourceRef]
    confidence: float = Field(ge=0, le=1)


class ProfileCandidateView(DomainModel):
    """Sourced proposal that remains distinct from activated profile text."""

    id: str
    idempotency_key: str
    conversation_id: str
    conversation_kind: ConversationKind | None
    subject_kind: ProfileSubjectKind
    persona_id: str | None = None
    category: ProfileCategory
    text: str
    source_message_ids: list[str]
    source_refs: list[DomainSourceRef]
    confidence: float
    valid_until: int | None = None
    state: Literal["candidate", "active", "rolled_back", "expired"]
    version: int = Field(ge=1)
    evidence: ProfileEvidence
    created_at: int = Field(ge=0)
    updated_at: int = Field(ge=0)


class ProfileView(DomainModel):
    """Activated profile projection and prior revision link."""

    id: str
    candidate_id: str
    conversation_id: str
    conversation_kind: ConversationKind | None
    subject_kind: ProfileSubjectKind
    persona_id: str | None = None
    category: ProfileCategory
    text: str
    source_message_ids: list[str]
    source_refs: list[DomainSourceRef]
    evidence: ProfileEvidence
    valid_until: int | None = None
    state: Literal["active", "superseded", "rolled_back", "expired"]
    version: int = Field(ge=1)
    previous_profile_id: str | None = None
    created_at: int = Field(ge=0)
    updated_at: int = Field(ge=0)


class ExpectedVersion(DomainModel):
    """Version precondition for one state transition."""

    expected_version: int = Field(ge=1)


class ProfileCandidateReceipt(DomainModel):
    """Candidate creation receipt."""

    candidate: ProfileCandidateView


class ProfileReceipt(DomainModel):
    """Profile activation or rollback receipt."""

    profile: ProfileView


class ProfilesView(DomainModel):
    """Bounded actor-owned profile projection list."""

    items: list[ProfileView]


class ProfileCandidatesView(DomainModel):
    """Bounded actor-owned candidate list."""

    items: list[ProfileCandidateView]


class ProfileGraphNode(DomainModel):
    """Sourced graph entity proposal; properties remain JSON data only."""

    id: str = Field(min_length=1, max_length=200)
    label: str = Field(min_length=1, max_length=240)
    properties: dict[str, Any] = Field(default_factory=dict)
    source_message_ids: list[str] = Field(default_factory=list, max_length=128)
    source_refs: list[DomainSourceRefInput] = Field(default_factory=list, max_length=256)

    @model_validator(mode="after")
    def require_provenance(self) -> ProfileGraphNode:
        if not self.source_message_ids and not self.source_refs:
            raise ValueError("sourceMessageIds or sourceRefs are required")
        return self


class ProfileGraphEdge(DomainModel):
    """Sourced graph relation proposal."""

    id: str = Field(min_length=1, max_length=200)
    from_id: str = Field(min_length=1, max_length=200)
    to_id: str = Field(min_length=1, max_length=200)
    label: str = Field(min_length=1, max_length=240)
    properties: dict[str, Any] = Field(default_factory=dict)
    source_message_ids: list[str] = Field(default_factory=list, max_length=128)
    source_refs: list[DomainSourceRefInput] = Field(default_factory=list, max_length=256)

    @model_validator(mode="after")
    def require_provenance(self) -> ProfileGraphEdge:
        if not self.source_message_ids and not self.source_refs:
            raise ValueError("sourceMessageIds or sourceRefs are required")
        return self


class GraphProposalCreate(DomainModel):
    """Store a durable proposal without asserting an external provider write."""

    idempotency_key: str = Field(min_length=1, max_length=200)
    conversation_id: str = Field(min_length=1, max_length=200)
    conversation_kind: ConversationKind
    persona_id: str | None = Field(default=None, max_length=200)
    nodes: list[ProfileGraphNode] = Field(max_length=500)
    edges: list[ProfileGraphEdge] = Field(max_length=500)


class GraphProviderReceipt(DomainModel):
    """Independent provider readback evidence persisted with an applied changeset."""

    request_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    readback_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    node_count: int = Field(ge=0)
    edge_count: int = Field(ge=0)
    applied_at: int = Field(ge=0)


class GraphChangesetView(DomainModel):
    """Sourced graph changeset with explicit independent provider evidence."""

    id: str
    idempotency_key: str
    conversation_id: str
    conversation_kind: ConversationKind | None
    persona_id: str | None = None
    nodes: list[ProfileGraphNode]
    edges: list[ProfileGraphEdge]
    digest: str
    state: Literal["proposed", "projected"]
    version: int = Field(ge=1)
    provider_receipt: GraphProviderReceipt | None = None
    provider_status: Literal["unavailable", "applied"]
    provider_applied: bool
    created_at: int = Field(ge=0)
    updated_at: int = Field(ge=0)


class GraphProposalReceipt(DomainModel):
    """Graph proposal write response."""

    changeset: GraphChangesetView


class GraphChangesetsView(DomainModel):
    """Bounded graph changeset list."""

    items: list[GraphChangesetView]


class GraphQuery(DomainModel):
    """Provider-backed graph query request and source authorization context."""

    conversation_id: str = Field(min_length=1, max_length=200)
    conversation_kind: ConversationKind
    persona_id: str | None = Field(default=None, max_length=200)
    query: str = Field(min_length=1, max_length=2_000)
    limit: int = Field(default=20, ge=1, le=100)


class GraphQueryView(DomainModel):
    """Source-filtered provider query results."""

    items: list[dict[str, Any]]


MaintenanceKind = Literal["dream", "forget", "daily_review", "backup", "import"]
MaintenanceState = Literal["queued", "running", "completed", "failed", "cancelled"]


class MaintenanceJobCreate(DomainModel):
    """Create an idempotent job record; this does not execute maintenance work."""

    idempotency_key: str = Field(min_length=1, max_length=200)
    kind: MaintenanceKind
    conversation_id: str | None = Field(default=None, max_length=200)
    conversation_kind: ConversationKind | None = None
    persona_id: str | None = Field(default=None, max_length=200)
    cursor: str | None = Field(default=None, max_length=1_024)

    @model_validator(mode="after")
    def validate_source_context(self) -> MaintenanceJobCreate:
        if self.conversation_id is not None and self.conversation_kind is None:
            raise ValueError("conversationKind is required with conversationId")
        if self.conversation_id is None:
            if self.conversation_kind not in {None, "direct"}:
                raise ValueError("workspace maintenance jobs use the direct neutral context")
            if self.persona_id is not None:
                raise ValueError("workspace maintenance jobs cannot bind a conversation persona")
        return self


class MaintenanceCheckpoint(DomainModel):
    """One bounded page checkpoint and optional safe execution metadata."""

    cursor: str | None = Field(max_length=1_024)
    processed_count: int = Field(ge=0)
    checkpoint_digest: str = Field(min_length=64, max_length=71)
    details: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_checkpoint_state(self) -> MaintenanceCheckpoint:
        state = self.details.get("state", "running")
        if state not in {"running", "completed", "failed", "cancelled"}:
            raise ValueError("checkpoint details.state is unsupported")
        receipt_fields = {"taskId", "taskOutputSha256"}
        if state == "running":
            if receipt_fields.intersection(self.details):
                raise ValueError("running checkpoints cannot include terminal task receipts")
        else:
            task_id = self.details.get("taskId")
            output_digest = self.details.get("taskOutputSha256")
            if not isinstance(task_id, str) or not task_id.strip() or len(task_id) > 200:
                raise ValueError("terminal checkpoints require taskId")
            if (
                not isinstance(output_digest, str)
                or re.fullmatch(r"[a-f0-9]{64}", output_digest) is None
            ):
                raise ValueError("terminal checkpoints require a SHA-256 taskOutputSha256")
        return self


class MaintenanceCheckpointRequest(DomainModel):
    """Optimistic checkpoint update."""

    expected_version: int = Field(ge=1)
    checkpoint: MaintenanceCheckpoint


class MaintenanceJobView(DomainModel):
    """Persistent job state and latest checkpoint only."""

    id: str
    task_id: str
    idempotency_key: str
    kind: MaintenanceKind
    conversation_id: str | None = None
    conversation_kind: ConversationKind | None = None
    persona_id: str | None = None
    state: MaintenanceState
    cursor: str | None = None
    processed_count: int = Field(ge=0)
    checkpoint_digest: str | None = None
    details: dict[str, Any]
    version: int = Field(ge=1)
    queued_version: int = Field(ge=1)
    created_at: int = Field(ge=0)
    updated_at: int = Field(ge=0)


class MaintenanceJobReceipt(DomainModel):
    """Job create/update response and idempotency status."""

    job: MaintenanceJobView
    duplicate: bool = False


class MaintenanceJobCancelReceipt(DomainModel):
    """User cancellation response."""

    job: MaintenanceJobView


class MaintenanceJobUpdateReceipt(DomainModel):
    """Checkpoint update response without a create-time duplicate flag."""

    job: MaintenanceJobView


class MaintenanceJobsView(DomainModel):
    """Bounded maintenance job list."""

    items: list[MaintenanceJobView]


class ResearchNoteCreate(DomainModel):
    """Create a source-backed research note revision."""

    idempotency_key: str = Field(min_length=1, max_length=200)
    conversation_id: str = Field(min_length=1, max_length=200)
    conversation_kind: ConversationKind
    persona_id: str | None = Field(default=None, max_length=200)
    title: str = Field(min_length=1, max_length=240)
    content: str = Field(min_length=1, max_length=16_000)
    source_refs: list[DomainSourceRefInput] = Field(min_length=1, max_length=256)


class ResearchNoteView(DomainModel):
    """Sourced research note revision."""

    id: str
    idempotency_key: str
    conversation_id: str
    conversation_kind: ConversationKind | None
    persona_id: str | None = None
    title: str
    content: str
    source_refs: list[DomainSourceRef]
    revision: int = Field(ge=1)
    created_at: int = Field(ge=0)


class ResearchNoteReceipt(DomainModel):
    """Research note creation receipt."""

    note: ResearchNoteView
    duplicate: bool = False


class ResearchNotesView(DomainModel):
    """Bounded research note list."""

    items: list[ResearchNoteView]


class VerifiedSkillCreate(DomainModel):
    """Submit sourced skill content for authenticated actor verification."""

    idempotency_key: str = Field(min_length=1, max_length=200)
    conversation_id: str | None = Field(default=None, max_length=200)
    name: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=16_000)
    source_refs: list[DomainSourceRefInput] = Field(min_length=1, max_length=256)
    operation_receipt_id: str = Field(min_length=1, max_length=512)
    independent_read_receipt_id: str = Field(min_length=1, max_length=512)
    conversation_kind: ConversationKind | None = None
    persona_id: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def validate_source_context(self) -> VerifiedSkillCreate:
        if self.conversation_id is not None and self.conversation_kind is None:
            raise ValueError("conversationKind is required with conversationId")
        if self.conversation_id is None:
            if self.conversation_kind not in {None, "direct"}:
                raise ValueError("workspace skills use the direct neutral context")
            if self.persona_id is not None:
                raise ValueError("workspace skills cannot be bound to a conversation persona")
        return self


class VerifiedSkillView(DomainModel):
    """Skill revision with server-derived verifier identity and time."""

    id: str
    idempotency_key: str
    conversation_id: str | None = None
    conversation_kind: ConversationKind | None
    persona_id: str | None = None
    name: str
    content: str
    source_refs: list[DomainSourceRef]
    operation_receipt_id: str
    independent_read_receipt_id: str
    verified: Literal[True]
    verified_by: str
    verified_at: int = Field(ge=0)
    revision: int = Field(ge=1)
    created_at: int = Field(ge=0)


class VerifiedSkillReceipt(DomainModel):
    """Verified skill creation receipt."""

    skill: VerifiedSkillView
    duplicate: bool = False


class VerifiedSkillsView(DomainModel):
    """Bounded verified skill list."""

    items: list[VerifiedSkillView]


class WatchCreate(DomainModel):
    """Create a sourced, owner-cancellable watch."""

    idempotency_key: str = Field(min_length=1, max_length=200)
    conversation_id: str = Field(min_length=1, max_length=200)
    conversation_kind: ConversationKind
    persona_id: str | None = Field(default=None, max_length=200)
    title: str = Field(min_length=1, max_length=240)
    condition: str = Field(min_length=1, max_length=2_000)
    source_refs: list[DomainSourceRefInput] = Field(min_length=1, max_length=256)
    next_check_at: int | None = Field(default=None, ge=0)


class WatchSchedule(DomainModel):
    """Replace the next check time for an active watch with CAS."""

    expected_version: int = Field(ge=1)
    next_check_at: int | None = Field(..., ge=0)


class WatchView(DomainModel):
    """Watch state with its CAS version."""

    id: str
    idempotency_key: str
    conversation_id: str
    conversation_kind: ConversationKind | None
    persona_id: str | None = None
    title: str
    condition: str
    source_refs: list[DomainSourceRef]
    next_check_at: int | None = None
    state: Literal["active", "cancelled"]
    version: int = Field(ge=1)
    created_at: int = Field(ge=0)
    updated_at: int = Field(ge=0)


class WatchReceipt(DomainModel):
    """Watch create/cancel response."""

    watch: WatchView
    duplicate: bool = False


class WatchUpdateReceipt(DomainModel):
    """Watch cancellation response."""

    watch: WatchView


class WatchesView(DomainModel):
    """Bounded watch list."""

    items: list[WatchView]


FocusKind = Literal["commitment", "wait", "attention"]
FocusState = Literal["open", "waiting", "done", "cancelled"]


class FocusItemCreate(DomainModel):
    """Create a sourced commitment, wait, or attention item."""

    idempotency_key: str = Field(min_length=1, max_length=200)
    conversation_id: str = Field(min_length=1, max_length=200)
    conversation_kind: ConversationKind
    persona_id: str | None = Field(default=None, max_length=200)
    kind: FocusKind
    summary: str = Field(min_length=1, max_length=2_000)
    source_refs: list[DomainSourceRefInput] = Field(min_length=1, max_length=256)
    due_at: int | None = Field(default=None, ge=0)
    condition: str | None = Field(default=None, max_length=2_000)


class FocusTransition(DomainModel):
    """Optimistic focus lifecycle transition."""

    state: FocusState
    expected_version: int = Field(ge=1)


class FocusItemView(DomainModel):
    """Focus item and current lifecycle version."""

    id: str
    idempotency_key: str
    conversation_id: str
    conversation_kind: ConversationKind | None
    persona_id: str | None = None
    kind: FocusKind
    summary: str
    source_refs: list[DomainSourceRef]
    due_at: int | None = None
    condition: str | None = None
    state: FocusState
    version: int = Field(ge=1)
    created_at: int = Field(ge=0)
    updated_at: int = Field(ge=0)


class FocusItemReceipt(DomainModel):
    """Focus create/transition response."""

    item: FocusItemView
    duplicate: bool = False


class FocusItemTransitionReceipt(DomainModel):
    """Focus transition response."""

    item: FocusItemView


class FocusItemsView(DomainModel):
    """Bounded actor-owned focus item list."""

    items: list[FocusItemView]


class HandoffCreate(DomainModel):
    """Create a minimal sourced handoff without copying complete task history."""

    idempotency_key: str = Field(min_length=1, max_length=200)
    conversation_id: str | None = Field(default=None, max_length=200)
    conversation_kind: ConversationKind | None = None
    persona_id: str | None = Field(default=None, max_length=200)
    task_id: str = Field(min_length=1, max_length=200)
    session_id: str = Field(min_length=1, max_length=200)
    summary: str = Field(min_length=1, max_length=3_000)
    unresolved_items: list[str] = Field(max_length=30)
    unknown_operation_refs: list[str] = Field(max_length=50)
    source_refs: list[DomainSourceRefInput] = Field(min_length=1, max_length=256)

    @model_validator(mode="after")
    def validate_source_context(self) -> HandoffCreate:
        if self.conversation_id is not None and self.conversation_kind is None:
            raise ValueError("conversationKind is required with conversationId")
        if self.conversation_id is None:
            if self.conversation_kind not in {None, "direct"}:
                raise ValueError("handoffs without a conversation use the direct neutral context")
            if self.persona_id is not None:
                raise ValueError("handoffs without a conversation cannot bind a persona")
        return self


class HandoffView(DomainModel):
    """Minimal handoff summary, unresolved items, and unknown operation references."""

    id: str
    idempotency_key: str
    conversation_id: str | None = None
    conversation_kind: ConversationKind | None
    persona_id: str | None = None
    task_id: str
    session_id: str
    summary: str
    unresolved_items: list[str]
    unknown_operation_refs: list[str]
    source_refs: list[DomainSourceRef]
    created_at: int = Field(ge=0)


class HandoffReceipt(DomainModel):
    """Handoff create response."""

    handoff: HandoffView
    duplicate: bool = False


class ReviewEventCreate(DomainModel):
    """Append one idempotent sourced review event."""

    idempotency_key: str = Field(min_length=1, max_length=200)
    event_type: Literal["approved", "rejected", "edited", "imported", "rolled_back", "reviewed"]
    summary: str = Field(min_length=1, max_length=2_000)
    source_refs: list[DomainSourceRefInput] = Field(min_length=1, max_length=256)
    conversation_id: str | None = Field(default=None, max_length=200)
    conversation_kind: ConversationKind | None = None
    persona_id: str | None = Field(default=None, max_length=200)
    decision: str | None = Field(default=None, max_length=240)

    @model_validator(mode="after")
    def validate_source_context(self) -> ReviewEventCreate:
        if self.conversation_id is not None and self.conversation_kind is None:
            raise ValueError("conversationKind is required with conversationId")
        if self.conversation_id is None:
            if self.conversation_kind not in {None, "direct"}:
                raise ValueError("workspace review events use the direct neutral context")
            if self.persona_id is not None:
                raise ValueError("workspace review events cannot bind a conversation persona")
        return self


class ReviewEventView(DomainModel):
    """Immutable review audit event."""

    id: str
    idempotency_key: str
    conversation_id: str | None = None
    event_type: Literal["approved", "rejected", "edited", "imported", "rolled_back", "reviewed"]
    conversation_kind: ConversationKind | None = None
    persona_id: str | None = None
    summary: str
    decision: str | None = None
    source_refs: list[DomainSourceRef]
    created_at: int = Field(ge=0)


class ReviewEventReceipt(DomainModel):
    """Review event append response."""

    event: ReviewEventView
    duplicate: bool = False


class ReviewEventsView(DomainModel):
    """Bounded review event list."""

    items: list[ReviewEventView]


class ImportRecordCreate(DomainModel):
    """One candidate import record; empty sourceRefs are quarantined by the domain store."""

    record_id: str = Field(min_length=1, max_length=200)
    kind: str = Field(min_length=1, max_length=120)
    conversation_id: str | None = Field(default=None, max_length=200)
    conversation_kind: ConversationKind | None = None
    persona_id: str | None = Field(default=None, max_length=200)
    text: str = Field(min_length=1, max_length=8_000)
    source_refs: list[DomainSourceRefInput] = Field(max_length=256)
    visibility: Literal["private", "conversation", "workspace"]
    valid_until: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_source_context(self) -> ImportRecordCreate:
        if self.conversation_id is not None and self.conversation_kind is None:
            raise ValueError("conversationKind is required with conversationId")
        if self.conversation_id is None:
            if self.conversation_kind not in {None, "direct"}:
                raise ValueError("workspace import records use the direct neutral context")
            if self.persona_id is not None:
                raise ValueError("workspace import records cannot bind a conversation persona")
        return self


class ImportBatchCreate(DomainModel):
    """Import batch request shared by preview and apply."""

    batch_id: str = Field(min_length=1, max_length=200)
    source_kind: str = Field(min_length=1, max_length=120)
    records: list[ImportRecordCreate] = Field(max_length=1_000)


class ImportPreviewView(DomainModel):
    """Privacy-safe import counts and canonical content digest."""

    record_count: int = Field(ge=0)
    accepted_count: int = Field(ge=0)
    quarantined_count: int = Field(ge=0)
    digest: str


class ImportApplyReceipt(DomainModel):
    """Import apply receipt without returning imported source text."""

    batch_id: str
    imported_count: int = Field(ge=0)
    quarantined_count: int = Field(ge=0)
    digest: str


class ImportRollbackReceipt(DomainModel):
    """Idempotent import rollback response."""

    batch_id: str
    rolled_back: bool
    quarantined_count: int = Field(ge=0)


class QuietHours(DomainModel):
    """Local civil-time interval for a conversation behavior policy."""

    time_zone: str = Field(min_length=1, max_length=128)
    start: str = Field(pattern=r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")
    end: str = Field(pattern=r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")


class ActiveBehaviorPolicyPut(DomainModel):
    """Explicit behavior policy write with optional initial version precondition."""

    conversation_id: str = Field(min_length=1, max_length=200)
    enabled: bool
    quiet_hours: QuietHours
    cooldown_seconds: int = Field(ge=0, le=86_400)
    allow_group_interjections: bool
    followup_enabled: bool
    expected_version: int | None = Field(default=None, ge=0)


class ActiveBehaviorPolicyView(DomainModel):
    """Stored policy or API default; timestamps are absent for an unpersisted default."""

    conversation_id: str
    enabled: bool
    quiet_hours: QuietHours
    cooldown_seconds: int
    allow_group_interjections: bool
    followup_enabled: bool
    version: int = Field(ge=0)
    created_at: int | None = Field(default=None, ge=0)
    updated_at: int | None = Field(default=None, ge=0)


class ActiveBehaviorPolicyReceipt(DomainModel):
    """Explicit behavior policy write response."""

    policy: ActiveBehaviorPolicyView


class ActorBackupReceipt(DomainModel):
    """Actor-private Work attachment receipt; raw backup bytes stay server-side."""

    artifact_id: str
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    size: int = Field(ge=0, le=10 * 1024 * 1024)
    mime_type: Literal["application/json"]
