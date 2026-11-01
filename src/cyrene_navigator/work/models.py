"""
Module: cyrene_navigator.work.models
Role: Strict typed HTTP contracts for persistent work resources.

模块职责：定义工作域持久资源的严格 camelCase HTTP 契约。
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel


class WorkModel(BaseModel):
    """Use strict camelCase JSON and reject unknown fields. | 严格 camelCase 线格式。"""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
        strict=True,
    )


TaskStatus = Literal[
    "queued",
    "running",
    "completed",
    "failed",
    "aborted",
    "waiting_approval",
    "waiting_input",
    "awaiting_user_authorization",
]
TaskExecutionClass = Literal["foreground", "background"]
NativeExecutionBackend = Literal["codebuddy-acp", "antigravity-acp"]


class TaskCreate(WorkModel):
    """Create one durable executor task. | 创建一个持久执行任务。"""

    id: str | None = Field(default=None, min_length=1, max_length=512)
    session_id: str = Field(min_length=1, max_length=512)
    prompt: str = Field(min_length=1, max_length=100_000)
    title: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=20_000)
    metadata: dict[str, Any] = Field(default_factory=dict)
    execution_class: TaskExecutionClass = "foreground"


class TaskContinuationCreate(WorkModel):
    """Create one explicit read-only continuation from an owned paused task.

    中文：请求体只有新的提示词，来源、Session 与权限由服务端派生。
    """

    prompt: str = Field(min_length=1, max_length=20_000)


class TaskPatch(WorkModel):
    """Update mutable executor results and a validated task state. | 更新执行结果与状态。"""

    prompt: str | None = Field(default=None, min_length=1, max_length=100_000)
    title: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=20_000)
    status: TaskStatus | None = None
    output: str | None = Field(default=None, max_length=2_000_000)
    reasoning: str | None = Field(default=None, max_length=2_000_000)
    error: str | None = Field(default=None, max_length=200_000)
    metadata: dict[str, Any] | None = None


class TeamsPrivateTaskOrigin(WorkModel):
    """Server-derived proof that a task came from verified private Teams ingress."""

    kind: Literal["teams_private"]
    message_id: str
    tenant_id: str
    bot_app_id: str
    actor_aad_object_id: str


class TaskRecord(WorkModel):
    """Public execution record with server-owned timestamps. | 执行任务公开记录。"""

    id: str
    workspace_id: str
    created_by_actor_id: str | None = None
    session_id: str
    prompt: str
    status: TaskStatus
    created_at: int
    started_at: int | None = None
    ended_at: int | None = None
    output: str
    reasoning: str
    error: str | None = None
    duration_ms: int
    sequence: int
    title: str | None = None
    description: str | None = None
    metadata: dict[str, Any]
    origin: TeamsPrivateTaskOrigin | None = None
    continuation_of_task_id: str | None = None
    continuation_mode: Literal["read_only"] | None = None
    execution_class: TaskExecutionClass = "foreground"


class BackendSessionBind(WorkModel):
    """Bind one Work Task's session to a native execution session. | 绑定原生执行会话。"""

    backend: NativeExecutionBackend
    native_session_id: str = Field(min_length=1, max_length=512)


class BackendSessionRecord(WorkModel):
    """Workspace-scoped native session identity owned by Navigator.

    中文：由 Navigator 拥有并按 Workspace 隔离的原生会话标识。
    """

    backend: NativeExecutionBackend
    session_id: str
    native_session_id: str


class TaskContinuationReceipt(WorkModel):
    """Atomic child-task receipt with its server-derived source and mode.

    中文：回执包含原子创建的新任务与是否为幂等重放。
    """

    task: TaskRecord
    duplicate: bool


class TaskList(WorkModel):
    """Cursor-paginated task view. | 游标分页任务视图。"""

    items: list[TaskRecord]
    next_cursor: str | None


class TaskEventAppend(WorkModel):
    """Append an opaque typed event with an optional retry key. | 追加幂等事件。"""

    event: dict[str, Any]
    message_id: str | None = Field(default=None, min_length=1, max_length=512)


class TaskEvent(WorkModel):
    """Durable event envelope. | 持久事件信封。"""

    seq: int
    event: dict[str, Any]
    created_at: int
    message_id: str | None = None


class TaskEvents(WorkModel):
    """Events after an exclusive sequence cursor. | 指定序列之后的事件。"""

    events: list[TaskEvent]
    next_seq: int


class TaskEventReceipt(WorkModel):
    """Append acknowledgement and current task projection. | 事件追加回执。"""

    seq: int
    event: dict[str, Any]
    created_at: int
    duplicate: bool
    task: TaskRecord


class TaskClaimResult(WorkModel):
    """Single-winner task admission claim. | 单赢家任务认领回执。"""

    claimed: bool
    task: TaskRecord


class ApprovalCreate(WorkModel):
    """Create one human decision gate for a running task. | 为运行任务创建审批门。"""

    kind: str = Field(min_length=1, max_length=128)
    summary: str = Field(min_length=1, max_length=2_000)
    details: dict[str, Any] = Field(default_factory=dict)
    message_id: str | None = Field(default=None, min_length=1, max_length=512)


class ApprovalResolve(WorkModel):
    """Resolve a pending decision once. | 一次性解析待审批决策。"""

    decision: Literal["approved", "rejected"]
    message_id: str | None = Field(default=None, min_length=1, max_length=512)


class ApprovalRecord(WorkModel):
    """Approval and its correlated task state. | 审批与关联任务状态。"""

    id: str
    task_id: str
    kind: str
    summary: str
    details: dict[str, Any]
    status: Literal["pending", "approved", "rejected"]
    created_at: int
    resolved_at: int | None = None
    resolved_by: str | None = None
    message_id: str | None = None


class ApprovalReceipt(WorkModel):
    """Decision receipt with its atomically changed task. | 审批决策回执。"""

    approval: ApprovalRecord
    task: TaskRecord
    duplicate: bool


class InputRequestCreate(WorkModel):
    """Ask for one human-provided value while pausing its task. | 请求人工补充信息。"""

    summary: str = Field(min_length=1, max_length=2_000)
    details: dict[str, Any] = Field(default_factory=dict)
    message_id: str | None = Field(default=None, min_length=1, max_length=512)


class InputResolve(WorkModel):
    """Resolve one pending input request with a safe structured answer. | 回答待处理输入。"""

    answer: dict[str, Any]
    message_id: str = Field(min_length=1, max_length=512)


class InputRecord(WorkModel):
    """Persisted user input request and its one-time answer. | 持久输入请求与回答。"""

    id: str
    task_id: str
    summary: str
    details: dict[str, Any]
    status: Literal["pending", "answered"]
    created_at: int
    answered_at: int | None = None
    answered_by: str | None = None
    answer: dict[str, Any] | None = None
    message_id: str | None = None
    answer_message_id: str | None = None


class InputReceipt(WorkModel):
    """Input creation or answer with the atomically changed task. | 输入回执。"""

    input: InputRecord
    task: TaskRecord
    duplicate: bool


class InputList(WorkModel):
    """Workspace-scoped input requests for the human control surface. | 工作区输入列表。"""

    items: list[InputRecord]


class AutomationResourceReference(WorkModel):
    """Typed opaque reference to a Product resource. | 产品资源的有类型引用。"""

    kind: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    resource_uri: str = Field(min_length=1, max_length=2_000)
    resource_version: str | int | None = None

    @field_validator("resource_version")
    @classmethod
    def validate_resource_version(cls, value: str | int | None) -> str | int | None:
        """Bound version values without coercing integer Product versions. | 限制版本值。"""

        if value is None:
            return None
        if type(value) is int:
            if value < 0 or value > 2**53 - 1:
                raise ValueError("resourceVersion must be a non-negative safe integer")
            return value
        if not isinstance(value, str):
            raise ValueError("resourceVersion must be bounded text or integer")
        if not value.strip() or len(value) > 512 or any(ord(ch) < 32 for ch in value):
            raise ValueError("resourceVersion must be bounded non-empty text")
        return value


class AutomationCommitReference(WorkModel):
    """Reference one immutable repository commit. | 引用一个不可变仓库提交。"""

    repository_uri: str = Field(min_length=1, max_length=2_000)
    sha: str = Field(pattern=r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")


class AutomationArtifactRef(WorkModel):
    """Canonical Platform ArtifactRef metadata without artifact bytes.

    中文：标准 ArtifactRef 元数据。
    """

    uri: str = Field(pattern=r"^artifact://sha256/[0-9a-f]{64}$")
    digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    size_bytes: int = Field(alias="size_bytes", ge=0, le=2**53 - 1)
    kind: str = Field(min_length=1, max_length=128)
    manifest_digest: str | None = Field(
        default=None,
        alias="manifest_digest",
        pattern=r"^sha256:[0-9a-f]{64}$",
    )

    @model_validator(mode="after")
    def digest_matches_uri(self) -> AutomationArtifactRef:
        """Bind the artifact URI to its declared content digest. | 校验 URI 与摘要一致。"""

        if self.uri.removeprefix("artifact://sha256/") != self.digest.removeprefix("sha256:"):
            raise ValueError("ArtifactRef uri and digest must identify the same bytes")
        return self


class AutomationEventCreate(WorkModel):
    """Submit one bounded source observation without client-owned identity. | 提交有界来源观察。"""

    source: str = Field(
        min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$"
    )
    source_event_id: str = Field(min_length=1, max_length=512)
    resource_uri: str = Field(min_length=1, max_length=2_000)
    source_version: str | int
    event_type: str = Field(
        min_length=1, max_length=256, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$"
    )
    occurred_at: int = Field(ge=0, le=2**53 - 1)
    title: str | None = Field(default=None, max_length=512)
    summary: str | None = Field(default=None, max_length=2_000)
    severity: Literal["info", "warning", "critical"] | None = None
    correlation_id: str | None = Field(default=None, min_length=1, max_length=128)
    experiment_id: str | None = Field(
        default=None,
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    )
    semantic_fingerprint: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    state_class: Literal["healthy", "incident", "neutral"] | None = None
    metadata_references: list[AutomationResourceReference] = Field(
        default_factory=list, max_length=32
    )

    @field_validator("source_version")
    @classmethod
    def validate_source_version(cls, value: str | int) -> str | int:
        """Bound the upstream version while preserving its original JSON type. | 限制来源版本。"""

        if type(value) is int:
            if value < 0 or value > 2**53 - 1:
                raise ValueError("sourceVersion must be a non-negative safe integer")
            return value
        if not isinstance(value, str):
            raise ValueError("sourceVersion must be bounded text or integer")
        if not value.strip() or len(value) > 512 or any(ord(ch) < 32 for ch in value):
            raise ValueError("sourceVersion must be bounded non-empty text")
        return value


class AutomationEvent(AutomationEventCreate):
    """Immutable stored observation with server-derived provenance. | 含服务端来源的事件。"""

    id: str
    observed_at: int = Field(ge=0, le=2**53 - 1)
    actor_id: str
    organization_id: str
    workspace_id: str
    revision: Literal[1]
    visibility: Literal["owner"]


class AutomationEventReceipt(AutomationEvent):
    """POST acknowledgement indicating whether the receipt was replayed. | 事件写入回执。"""

    duplicate: bool


class AutomationEventList(WorkModel):
    """Actor-owned observations with an opaque stable cursor. | 按 actor 分页读取事件。"""

    items: list[AutomationEvent]
    next_cursor: str | None


class AutomationEventNoticeIntentCreate(WorkModel):
    """Link one immutable event to its exact running workflow occurrence. | 事件通知意图。"""

    workflow_id: str = Field(min_length=1, max_length=512)
    trigger_id: str = Field(min_length=1, max_length=128)
    occurrence_id: str = Field(pattern=r"^occ-[0-9a-f]{40}$")
    scheduled_at: str = Field(min_length=1, max_length=128)
    task_id: str = Field(min_length=1, max_length=512)


class AutomationEventNoticeIntentReceipt(WorkModel):
    """Server-derived event decision and its stable retry result. | 事件通知决策回执。"""

    event_id: str
    workflow_id: str
    trigger_id: str
    occurrence_id: str
    decision: Literal[
        "initial_baseline",
        "unchanged",
        "stale",
        "change",
        "failure",
        "recovery",
        "blocker",
        "quiet",
    ]
    notification_id: str | None = None
    duplicate: bool


class ExperimentPut(WorkModel):
    """Replace reference-only experiment lineage at an expected revision. | 更新实验引用索引。"""

    dataset_version: AutomationResourceReference | None = None
    training_run: AutomationResourceReference | None = None
    training_attempt: AutomationResourceReference | None = None
    checkpoint_artifact_ref: AutomationArtifactRef | None = None
    evaluation_run: AutomationResourceReference | None = None
    model_version: AutomationResourceReference | None = None
    deployment: AutomationResourceReference | None = None
    commit: AutomationCommitReference | None = None
    expected_revision: int = Field(ge=0, le=2**53 - 1)


class ExperimentRecord(WorkModel):
    """Actor-owned index of Product references, never Product lifecycle state. | 实验引用索引。"""

    experiment_id: str = Field(
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    )
    dataset_version: AutomationResourceReference | None = None
    training_run: AutomationResourceReference | None = None
    training_attempt: AutomationResourceReference | None = None
    checkpoint_artifact_ref: AutomationArtifactRef | None = None
    evaluation_run: AutomationResourceReference | None = None
    model_version: AutomationResourceReference | None = None
    deployment: AutomationResourceReference | None = None
    commit: AutomationCommitReference | None = None
    actor_id: str
    organization_id: str
    workspace_id: str
    revision: int = Field(ge=1, le=2**53 - 1)
    updated_at: int = Field(ge=0, le=2**53 - 1)
    visibility: Literal["owner"]


class PrivateInstallationPayload(WorkModel):
    """Minimal add/remove intent from the authenticated Teams bridge. | 安装操作意图。"""

    action: Literal["add", "remove"]


class PrivateInstallationTrust(WorkModel):
    """Host-verified Teams private-install identity, never client/model supplied.

    中文：可信安装身份。
    """

    version: Literal[1]
    provider: Literal["teams"]
    conversation_kind: Literal["private"]
    installation_action: Literal["add", "remove"]
    tenant_id: str = Field(min_length=36, max_length=36)
    actor_aad_object_id: str = Field(min_length=36, max_length=36)
    bot_app_id: str = Field(min_length=36, max_length=36)
    conversation_id: str = Field(min_length=1, max_length=512)
    activity_id: str = Field(min_length=1, max_length=512)
    activity_occurred_at: str = Field(min_length=20, max_length=64)
    service_url: str = Field(min_length=1, max_length=512)


class PrivateInstallationEvent(WorkModel):
    """Trusted package event relayed after DSH verifies its HMAC envelope. | 可信安装事件。"""

    event_type: Literal["personal_installation"]
    payload: PrivateInstallationPayload
    trust: PrivateInstallationTrust

    @model_validator(mode="after")
    def action_matches_trust(self) -> PrivateInstallationEvent:
        """Prevent a body from changing the package-verified add/remove intent."""

        if self.payload.action != self.trust.installation_action:
            raise ValueError("payload action must match the verified installation action")
        return self


class PrivateInstallationReceipt(WorkModel):
    """Route-free acknowledgement of one private installation update. | 私有安装回执。"""

    action: Literal["add", "remove"]
    active: bool
    applied: bool
    revision: int = Field(ge=0, le=2**53 - 1)
    updated_at: int = Field(ge=0, le=2**53 - 1)
    duplicate: bool


class TeamsPersonalRoute(WorkModel):
    """Private host-only delivery route materialized only on a trusted lease. | 私有投递路由。"""

    kind: Literal["teams_personal"]
    tenant_id: str
    bot_app_id: str
    actor_aad_object_id: str
    conversation_id: str
    service_url: str


class OperationCreate(WorkModel):
    """Begin a durable external-operation receipt. | 建立外部操作回执。"""

    idempotency_key: str = Field(min_length=1, max_length=512)
    operation_type: str = Field(min_length=1, max_length=128)
    task_id: str | None = Field(default=None, min_length=1, max_length=512)
    target: str | None = Field(default=None, max_length=2_000)
    scope_lock: str | None = Field(default=None, max_length=100)
    request: dict[str, Any] = Field(default_factory=dict)


class OperationVerify(WorkModel):
    """Record an operation outcome without replaying the side effect. | 记录操作结果。"""

    status: Literal["uncertain", "verified"]
    evidence: dict[str, Any] = Field(default_factory=dict)


class OperationRecord(WorkModel):
    """Started, uncertain, or verified operation receipt. | 操作回执状态。"""

    id: str
    idempotency_key: str
    operation_type: str
    task_id: str | None = None
    target: str | None = None
    scope_lock: str | None = None
    request: dict[str, Any]
    status: Literal["started", "uncertain", "verified"]
    evidence: dict[str, Any]
    created_at: int
    updated_at: int


class OperationSummary(WorkModel):
    """Minimal unresolved provider receipt for status reconciliation. | 未解决操作摘要。"""

    id: str
    operation_type: str
    task_id: str | None = None
    target: str | None = None
    status: Literal["started", "uncertain"]
    evidence: dict[str, Any]
    created_at: int
    updated_at: int


class OperationSummaryList(WorkModel):
    """Workspace-scoped unresolved operation receipts. | 工作区未解决操作摘要。"""

    items: list[OperationSummary]


class OperationReceipt(WorkModel):
    """Creation or transition acknowledgement. | 创建与状态转换回执。"""

    operation: OperationRecord
    duplicate: bool = False


class MemoryFactUpsert(WorkModel):
    """Store one structured workspace fact. | 保存结构化工作事实。"""

    namespace: str = Field(min_length=1, max_length=128)
    key: str = Field(min_length=1, max_length=512)
    value: dict[str, Any]
    source_id: str | None = Field(default=None, max_length=512)
    observed_at: int | None = Field(default=None, ge=0)
    fresh_until: int | None = Field(default=None, ge=0)


class MemoryFact(WorkModel):
    """Structured fact with explicit freshness and provenance. | 带时效与来源的事实。"""

    id: str
    namespace: str
    key: str
    value: dict[str, Any]
    source_id: str | None = None
    observed_at: int
    fresh_until: int | None = None
    missing: bool
    stale: bool


class MemoryFacts(WorkModel):
    """Workspace facts returned by read or query endpoints. | 工作事实列表。"""

    items: list[MemoryFact]


class MemoryQuery(WorkModel):
    """Search workspace facts by plain text. | 按普通文本查询工作事实。"""

    query: str = Field(min_length=1, max_length=2_000)
    limit: int = Field(default=20, ge=1, le=100)
    include_stale: bool = False


ConversationKind = Literal["direct", "group", "channel"]
ConversationVisibility = Literal["private", "conversation", "workspace"]
ConversationMemoryKind = Literal["fact", "preference", "commitment", "episode"]


class ConversationMemoryScope(WorkModel):
    """Conversation and visibility boundary attached to every memory projection."""

    conversation_id: str = Field(min_length=1, max_length=512)
    conversation_kind: ConversationKind
    persona_id: str | None = None
    visibility: ConversationVisibility


class ConversationMemorySourceRef(WorkModel):
    """Original messages and exact memory revisions supporting derived content."""

    memory_id: str | None = None
    memory_version: int | None = Field(default=None, ge=1)
    source_message_ids: list[str] = Field(default_factory=list, max_length=128)

    @model_validator(mode="after")
    def validate_memory_revision(self) -> ConversationMemorySourceRef:
        """Require a version whenever a parent memory is referenced."""

        if (self.memory_id is None) != (self.memory_version is None):
            raise ValueError("memoryId and memoryVersion must be supplied together")
        if self.memory_id is None and not self.source_message_ids:
            raise ValueError("a source reference must contain a memory or message id")
        return self


class ConversationMemoryAttachmentRef(WorkModel):
    """Opaque Work attachment metadata attached to a trusted message source."""

    artifact_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    mime_type: Literal["image/png", "image/jpeg", "image/webp", "image/gif"]
    size: int = Field(ge=1, le=10_000_000)

    @model_validator(mode="after")
    def digest_matches_id(self) -> ConversationMemoryAttachmentRef:
        """Bind the artifact id to the content digest returned by Work."""

        if self.artifact_id != self.sha256:
            raise ValueError("artifactId and sha256 must match")
        return self


class ConversationMemoryMessageCreate(WorkModel):
    """Append one host-recorded conversation message without caller-owned identity."""

    event_id: str = Field(min_length=1, max_length=512)
    conversation_id: str = Field(min_length=1, max_length=512)
    conversation_kind: ConversationKind
    persona_id: str | None = Field(default=None, max_length=512)
    visibility: ConversationVisibility = "private"
    role: Literal["user", "assistant", "tool"]
    content: str = Field(min_length=1, max_length=100_000)
    occurred_at: int | None = Field(default=None, ge=0)
    related_event_ids: list[str] = Field(default_factory=list, max_length=16)
    source_refs: list[ConversationMemorySourceRef] = Field(default_factory=list, max_length=256)
    attachments: list[ConversationMemoryAttachmentRef] = Field(default_factory=list, max_length=32)

    @model_validator(mode="after")
    def validate_message_lineage(self) -> ConversationMemoryMessageCreate:
        """Prevent user-origin events from asserting model-derived provenance."""

        if self.role == "user" and (self.source_refs or self.related_event_ids):
            raise ValueError("user messages cannot assert derived source references")
        if self.role != "assistant" and self.related_event_ids:
            raise ValueError("only assistant messages may reference a related turn event")
        return self


class ConversationMemoryMessage(WorkModel):
    """Persisted message projection with privacy-safe scope and provenance."""

    id: str
    event_id: str
    role: Literal["user", "assistant", "tool"]
    content: str
    occurred_at: int
    status: Literal["active", "revoked"]
    revoked_at: int | None = None
    source_refs: list[ConversationMemorySourceRef]
    attachments: list[ConversationMemoryAttachmentRef]
    scope: ConversationMemoryScope


class ConversationMemoryMessages(WorkModel):
    """One bounded page of conversation events."""

    items: list[ConversationMemoryMessage]
    next_cursor: str | None = None


class ConversationMemoryCreate(WorkModel):
    """Create an evidence-backed memory candidate or active projection."""

    idempotency_key: str = Field(min_length=1, max_length=512)
    conversation_id: str = Field(min_length=1, max_length=512)
    conversation_kind: ConversationKind
    persona_id: str | None = Field(default=None, max_length=512)
    kind: ConversationMemoryKind
    text: str = Field(min_length=1, max_length=20_000)
    source_message_ids: list[str] = Field(min_length=1, max_length=32_768)
    source_refs: list[ConversationMemorySourceRef] = Field(default_factory=list, max_length=256)
    visibility: ConversationVisibility = "private"
    valid_until: int | None = Field(default=None, ge=0)


class ConversationMemoryPatch(WorkModel):
    """Correct memory text or freshness while preserving the original evidence."""

    expected_version: int = Field(ge=1)
    text: str | None = Field(default=None, min_length=1, max_length=20_000)
    valid_until: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def require_change(self) -> ConversationMemoryPatch:
        """Reject empty edits instead of recording no-op revisions."""

        if self.text is None and self.valid_until is None:
            raise ValueError("at least one mutable memory field is required")
        return self


class ConversationMemoryRecord(WorkModel):
    """Current memory record and its honest semantic-index state."""

    id: str
    kind: ConversationMemoryKind
    text: str
    source_message_ids: list[str]
    source_refs: list[ConversationMemorySourceRef]
    version: int
    state: Literal["active", "invalidated", "deleted"]
    index_state: Literal["pending", "indexed", "unavailable", "failed"]
    authorization_epoch: int
    created_at: int
    updated_at: int
    valid_until: int | None = None
    scope: ConversationMemoryScope


class ConversationMemoryReceipt(WorkModel):
    """Memory write receipt that distinguishes duplicate idempotent requests."""

    memory: ConversationMemoryRecord
    duplicate: bool = False


class ConversationMemoryDeleteReceipt(WorkModel):
    """Deletion receipt with workspace authorization epoch and replay state."""

    deleted: bool
    authorization_epoch: int
    duplicate: bool = False


class ConversationMemoryList(WorkModel):
    """Bounded memory records for the authorized actor and conversation."""

    items: list[ConversationMemoryRecord]
    authorization_epoch: int


class ConversationMemoryQuery(WorkModel):
    """Semantic search request; model and vector provider are server selected."""

    conversation_id: str = Field(min_length=1, max_length=512)
    conversation_kind: ConversationKind
    persona_id: str | None = Field(default=None, max_length=512)
    query: str = Field(min_length=1, max_length=2_000)
    limit: int = Field(default=20, ge=1, le=100)


class ConversationMemoryHit(WorkModel):
    """Authorized semantic hit with the exact revision that was retrieved."""

    memory_id: str
    kind: ConversationMemoryKind
    text: str
    source_message_ids: list[str]
    source_refs: list[ConversationMemorySourceRef]
    version: int
    score: float
    stale: bool
    scope: ConversationMemoryScope


class ConversationMemoryQueryResult(WorkModel):
    """Provider hits filtered by current Navigator provenance and freshness."""

    items: list[ConversationMemoryHit]
    authorization_epoch: int


class ConversationMemorySources(WorkModel):
    """Source audit records limited to the authorized actor and conversation."""

    items: list[ConversationMemorySource]


class ConversationMemorySourceGrantCreate(WorkModel):
    """Explicitly share one source with a conversation or Workspace."""

    visibility: Literal["conversation", "workspace"]
    target_conversation_id: str | None = Field(default=None, max_length=512)
    expires_at: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_target(self) -> ConversationMemorySourceGrantCreate:
        """Require an exact conversation target and forbid ambiguous workspace targets."""

        if self.visibility == "conversation" and not self.target_conversation_id:
            raise ValueError("conversation grants require targetConversationId")
        if self.visibility == "workspace" and self.target_conversation_id is not None:
            raise ValueError("workspace grants cannot include targetConversationId")
        return self


class ConversationMemorySourceGrant(WorkModel):
    """Current explicit grant for one message source."""

    id: str
    source_id: str
    visibility: Literal["conversation", "workspace"]
    target_conversation_id: str | None = None
    expires_at: int | None = None
    created_at: int
    status: Literal["active", "revoked", "expired"]


class ConversationMemorySource(WorkModel):
    """Source audit record and owner-managed grants without actor identifiers."""

    id: str
    event_id: str
    kind: Literal["conversation_message"]
    role: Literal["user", "assistant", "tool"]
    status: Literal["active", "revoked"]
    revoked_at: int | None = None
    authorization_epoch: int
    created_at: int
    can_manage_grants: bool
    scope: ConversationMemoryScope
    grants: list[ConversationMemorySourceGrant]


class ConversationMemorySourceGrantReceipt(WorkModel):
    """Acknowledgement for one explicit source grant."""

    grant: ConversationMemorySourceGrant
    authorization_epoch: int
    duplicate: bool = False


class ConversationMemorySourceGrantRevocation(WorkModel):
    """Acknowledgement for an idempotent grant revocation."""

    revoked: bool
    authorization_epoch: int


class ConversationMemorySourceAuthorization(WorkModel):
    """Request an authoritative source and revision check before context or delivery."""

    conversation_id: str = Field(min_length=1, max_length=512)
    conversation_kind: ConversationKind
    persona_id: str | None = Field(default=None, max_length=512)
    authorization_epoch: int = Field(ge=0)
    source_refs: list[ConversationMemorySourceRef] = Field(max_length=256)


class ConversationMemorySourceAuthorizationReceipt(WorkModel):
    """Fail-closed result of a current-epoch source check."""

    allowed: bool
    current_authorization_epoch: int
    denied_source_ids: list[str]


class ConversationMemoryArtifactAuthorization(WorkModel):
    """Authorize one opaque attachment against current source lineage."""

    artifact_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    conversation_id: str = Field(min_length=1, max_length=512)
    conversation_kind: ConversationKind
    persona_id: str | None = Field(default=None, max_length=512)
    authorization_epoch: int = Field(ge=0)
    source_refs: list[ConversationMemorySourceRef] = Field(max_length=256)


class ConversationMemoryArtifactAuthorizationReceipt(WorkModel):
    """Current authorization decision and safe metadata for an opaque artifact."""

    allowed: bool
    current_authorization_epoch: int
    artifact: ConversationMemoryAttachmentRef | None = None


class ConversationMemorySourceRevocationReceipt(WorkModel):
    """Audit receipt for one source revocation and its recursive descendants."""

    source_id: str
    authorization_epoch: int
    invalidated_count: int
    invalidated_message_ids: list[str]
    invalidated_memory_ids: list[str]


class ConversationMemoryOverview(WorkModel):
    """Product status without synthetic provider health claims."""

    authorization_epoch: int
    counts: dict[str, int]
    capabilities: dict[str, Literal["ready", "unavailable"]]


class SourceFactInput(WorkModel):
    """One fact from a paginated source inventory. | 分页来源清单中的一项事实。"""

    key: str = Field(min_length=1, max_length=512)
    value: dict[str, Any]
    observed_at: int | None = Field(default=None, ge=0)


class SourceInventoryPage(WorkModel):
    """Submit one contiguous page of a source inventory. | 提交来源清单的一页。"""

    inventory_id: str = Field(min_length=1, max_length=512)
    page_token: str | None = Field(default=None, max_length=2_000)
    next_page_token: str | None = Field(default=None, max_length=2_000)
    complete: bool
    successful: bool
    items: list[SourceFactInput] = Field(max_length=10_000)


class SourceInventoryReceipt(WorkModel):
    """Inventory progress; missing facts change only at full success. | 清单进度回执。"""

    source_id: str
    inventory_id: str
    accepted_page_count: int
    complete: bool
    successful: bool
    item_count: int
    last_complete_at: int | None = None
    duplicate: bool = False


class SourceRecord(WorkModel):
    """Latest successful source inventory state. | 最近成功清单状态。"""

    source_id: str
    status: Literal["unknown", "fresh", "stale", "incomplete", "failed"]
    last_complete_at: int | None = None
    updated_at: int
    fact_count: int


class SourceList(WorkModel):
    """Workspace source inventory summaries. | 工作来源列表。"""

    items: list[SourceRecord]


class NotificationCreate(WorkModel):
    """Enqueue a deduplicated outbound notification. | 加入幂等通知队列。"""

    deduplication_key: str = Field(min_length=1, max_length=512)
    type: str = Field(min_length=1, max_length=128)
    payload: dict[str, Any]
    task_id: str | None = Field(default=None, min_length=1, max_length=512)
    connector_id: str | None = Field(default=None, min_length=1, max_length=512)
    recipient: str | None = Field(default=None, max_length=2_000)
    available_at: int | None = Field(default=None, ge=0)


class NotificationClaim(WorkModel):
    """Claim notification rows for an adapter worker. | 由适配器租用通知项。"""

    worker_id: str = Field(min_length=1, max_length=256)
    limit: int = Field(default=10, ge=1, le=100)
    lease_seconds: int = Field(default=60, ge=5, le=3_600)
    type: str | None = Field(default=None, min_length=1, max_length=128)
    connector_id: str | None = Field(default=None, min_length=1, max_length=512)
    recipient: str | None = Field(default=None, min_length=1, max_length=2_000)


class NotificationStart(WorkModel):
    """Mark that the remote send may begin. | 标记可能开始远端发送。"""

    lease_token: str = Field(min_length=1, max_length=512)


class NotificationFinish(WorkModel):
    """Record known delivery, known failure, or unknown delivery. | 记录投递结果。"""

    lease_token: str = Field(min_length=1, max_length=512)
    outcome: Literal["delivered", "failed", "uncertain", "retry"]
    retry_after_seconds: int | None = Field(default=None, ge=1, le=300)
    result: dict[str, Any] = Field(default_factory=dict)


class NotificationRecord(WorkModel):
    """Outbox status that distinguishes unknown delivery from queued work. | 通知状态。"""

    id: str
    deduplication_key: str
    type: str
    payload: dict[str, Any]
    task_id: str | None = None
    connector_id: str | None = None
    recipient: str | None = None
    status: Literal["queued", "leased", "started", "uncertain", "delivered", "failed"]
    available_at: int
    created_at: int
    updated_at: int
    worker_id: str | None = None
    lease_expires_at: int | None = None
    result: dict[str, Any]


class NotificationQueued(WorkModel):
    """Queue acknowledgement. | 通知入队回执。"""

    notification: NotificationRecord
    duplicate: bool


class NotificationList(WorkModel):
    """Workspace outbox records, including uncertain delivery. | 工作通知列表。"""

    items: list[NotificationRecord]


class NotificationLease(WorkModel):
    """Leased row with one-time raw lease capability. | 含一次性租约能力。"""

    notification: NotificationRecord
    lease_token: str
    lease_expires_at: int


class NotificationClaimResult(WorkModel):
    """Claim response with no automatic external delivery. | 仅租用，不自动发送。"""

    items: list[NotificationLease]


class PrivateNotificationLease(WorkModel):
    """Private route materialized only for the dedicated trusted delivery lease. | 私有租约。"""

    notification: NotificationRecord
    lease_token: str
    lease_expires_at: int
    teams_personal_route: TeamsPersonalRoute


class PrivateNotificationClaimResult(WorkModel):
    """Lease response containing private routing only for the Teams bridge. | Teams 私聊租约。"""

    items: list[PrivateNotificationLease]


CredentialHealthProvider = Literal["hf", "runpod", "azure", "gcp", "microsoft_graph"]
CredentialHealthState = Literal[
    "VALID", "REAUTHORIZATION_REQUIRED", "PERMISSION_DENIED", "UNKNOWN", "UNAVAILABLE"
]
CredentialLoginState = Literal["PRESENT", "MISSING", "UNKNOWN", "UNAVAILABLE"]


class CredentialCapabilityHealth(WorkModel):
    """Credential-free state for one provider capability. | 单个能力的无凭据健康状态。"""

    capability_id: str = Field(
        min_length=1,
        max_length=256,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$",
    )
    state: CredentialHealthState
    last_verified_at: str | None = Field(
        default=None,
        max_length=64,
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$",
    )
    expires_at: str | None = Field(
        default=None,
        max_length=64,
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$",
    )
    reason_code: str | None = Field(
        default=None,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$",
    )


class CredentialHealthPrivateOwner(WorkModel):
    """Host-derived private recipient for Microsoft Graph notices. | Graph 私聊收件人。"""

    actor_aad_object_id: str = Field(
        min_length=36,
        max_length=36,
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    )
    tenant_id: str = Field(
        min_length=36,
        max_length=36,
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    )
    bot_app_id: str = Field(
        min_length=36,
        max_length=36,
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    )


class CredentialHealthSnapshot(WorkModel):
    """Secret-free Exchange authorization projection consumed by the host worker.

    中文：由可信 Navigator worker 提交的 Exchange 授权状态快照，不包含凭据或授权材料。
    """

    connection_id: str = Field(
        min_length=36,
        max_length=36,
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    )
    provider: CredentialHealthProvider
    login_state: CredentialLoginState
    authorization_state: CredentialHealthState
    checked_at: str | None = Field(
        default=None,
        max_length=64,
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$",
    )
    expires_at: str | None = Field(
        default=None,
        max_length=64,
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$",
    )
    generation: int = Field(ge=0, le=2**53 - 1)
    capabilities: list[CredentialCapabilityHealth] = Field(default_factory=list, max_length=100)
    private_owner: CredentialHealthPrivateOwner | None = None
    reason_code: str | None = Field(
        default=None,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$",
    )

    @model_validator(mode="after")
    def validate_private_owner(self) -> CredentialHealthSnapshot:
        if self.provider == "microsoft_graph":
            if self.private_owner is None:
                raise ValueError(
                    "Microsoft Graph health snapshots require a host-derived private owner"
                )
        elif self.private_owner is not None:
            raise ValueError("Only Microsoft Graph health snapshots may route to a private owner")
        return self


class CredentialHealthSnapshotBatch(WorkModel):
    """Bounded batch from the fixed Exchange snapshot projection. | 有界健康快照批次。"""

    organization_id: str = Field(min_length=1, max_length=512)
    connections: list[CredentialHealthSnapshot] = Field(min_length=1, max_length=100)


class CredentialHealthSnapshotReceipt(WorkModel):
    """Atomic checkpoint and outbox accounting for one snapshot batch. | 快照处理回执。"""

    processed: int = Field(ge=0)
    stale: int = Field(ge=0)
    notifications_queued: int = Field(ge=0)


class AttachmentCreate(WorkModel):
    """Upload a bounded base64 attachment. | 上传有大小上限的 base64 附件。"""

    name: str = Field(min_length=1, max_length=512)
    media_type: str = Field(min_length=1, max_length=256)
    content_base64: str = Field(min_length=1, max_length=14_000_000)


class AttachmentRecord(WorkModel):
    """Content-addressed attachment metadata. | 内容寻址附件元数据。"""

    id: str
    workspace_id: str
    sha256: str
    name: str
    media_type: str
    size: int
    created_at: int


class ConnectorStatusUpdate(WorkModel):
    """Update typed connector health and login state. | 更新连接器健康与登录状态。"""

    status: Literal[
        "unknown",
        "disconnected",
        "authenticating",
        "login_required",
        "connected",
        "degraded",
        "error",
    ]
    account_id: str | None = Field(default=None, max_length=512)
    detail: str | None = Field(default=None, max_length=2_000)


class TeamsThreadMessageCreate(WorkModel):
    """Persist one verified Teams participant message and optional thread mapping.

    中文：保存经验证的 Teams 参与者消息；只有受信维护者接纳任务时才创建线程映射。
    """

    thread_id: str = Field(min_length=1, max_length=128)
    message_id: str = Field(min_length=1, max_length=512)
    service_url: str = Field(default="", max_length=512)
    tenant_id: str = Field(min_length=1, max_length=128)
    team_id: str = Field(min_length=1, max_length=512)
    channel_id: str = Field(min_length=1, max_length=512)
    conversation_id: str = Field(min_length=1, max_length=512)
    root_thread_id: str = Field(min_length=1, max_length=512)
    actor_issuer: str = Field(min_length=1, max_length=512)
    actor_subject: str = Field(min_length=1, max_length=256)
    text: str = Field(min_length=1, max_length=20_000)
    session_id: str | None = Field(default=None, min_length=1, max_length=512)


class TeamsPrivateMessageCreate(WorkModel):
    """Private ingress identity without recipient or model-controlled route fields.

    The actor, tenant, bot app, and active installation are resolved from the
    authenticated principal and server-pinned Teams policy. 中文：私聊入口只传消息正文。
    中文：私聊入口只传消息与安装匹配值，不接受收件路由身份。
    """

    message_id: str = Field(min_length=1, max_length=512)
    text: str = Field(min_length=1, max_length=20_000)


class ConnectorEventCreate(WorkModel):
    """Register one connector event and optional atomic task admission. | 连接事件。"""

    message_id: str = Field(min_length=1, max_length=512)
    type: str = Field(min_length=1, max_length=256)
    occurred_at: int | None = Field(default=None, ge=0)
    account_id: str | None = Field(default=None, max_length=512)
    conversation_id: str | None = Field(default=None, max_length=512)
    sender_id: str | None = Field(default=None, max_length=512)
    payload: dict[str, Any] = Field(default_factory=dict)
    task: TaskCreate | None = None
    teams_thread_message: TeamsThreadMessageCreate | None = None
    teams_private_message: TeamsPrivateMessageCreate | None = None


class TeamsThreadMessage(WorkModel):
    """Durable message text used as context for a later owner request. | 线程上下文消息。"""

    message_id: str
    actor_issuer: str
    actor_subject: str
    text: str
    created_at: int


class TeamsThreadRecord(WorkModel):
    """Stable Teams thread to DSH Session mapping and recent context. | Teams 线程映射。"""

    thread_id: str
    tenant_id: str
    team_id: str
    channel_id: str
    conversation_id: str
    root_thread_id: str
    service_url: str = ""
    session_id: str | None = None
    messages: list[TeamsThreadMessage]


class ConnectorEventReceipt(WorkModel):
    """Connector event acknowledgement with optional admitted task. | 连接事件回执。"""

    event_id: str
    duplicate: bool
    received_at: int
    task: TaskRecord | None = None


class ConnectorRecord(WorkModel):
    """Workspace connector health view. | Workspace 连接器健康视图。"""

    connector_id: str
    status: Literal[
        "unknown",
        "disconnected",
        "authenticating",
        "login_required",
        "connected",
        "degraded",
        "error",
    ]
    account_id: str | None = None
    detail: str | None = None
    configured: bool = False
    updated_at: int
    last_event_at: int | None = None


class ConnectorList(WorkModel):
    """Known connector states in one authorized workspace. | 授权空间中的连接器状态。"""

    items: list[ConnectorRecord]


class ConnectorEvents(WorkModel):
    """Connector events after an exclusive event cursor. | 指定游标之后的连接事件。"""

    events: list[dict[str, Any]]
    next_seq: int


class WorkflowSchedule(WorkModel):
    """Desired DSH cron cadence; DSH remains the scheduling authority. | DSH 定时意图。"""

    kind: Literal["cron"]
    expression: str = Field(min_length=1, max_length=256)
    time_zone: str = Field(min_length=1, max_length=128)


class WorkflowTarget(WorkModel):
    """Generic resource scope for a versioned workflow. | 通用工作流目标。"""

    id: str = Field(min_length=1, max_length=512)
    label: str = Field(min_length=1, max_length=512)
    kind: str = Field(min_length=1, max_length=128)
    uri: str | None = Field(default=None, max_length=2_000)
    binding_id: str | None = Field(default=None, min_length=1, max_length=512)


class WorkflowNotifications(WorkModel):
    """Quiet-by-default workflow notification preferences. | 安静通知偏好。"""

    on_change: bool
    on_failure: bool
    on_recovery: bool
    quiet_when_unchanged: Literal[True]


class WorkflowGitHubSearch(WorkModel):
    """Safe typed GitHub search filters. | 有限安全搜索过滤器。"""

    state: Literal["open", "closed", "all"] = "open"
    query: str | None = Field(default=None, max_length=256)
    labels: list[str] = Field(default_factory=list, max_length=10)
    limit: int = Field(default=50, ge=1, le=50)


class WorkflowV2Trigger(WorkModel):
    """One DSH Schedule-backed proactive trigger. | 一个由 DSH Schedule 驱动的主动触发器。"""

    id: str = Field(min_length=1, max_length=128)
    kind: Literal["github_incremental_poll", "review"]
    schedule: WorkflowSchedule
    target_ids: list[str] = Field(default_factory=list, max_length=100)
    initial_baseline: Literal["record_without_notification"] = "record_without_notification"
    search: WorkflowGitHubSearch | None = None


WorkflowAction = Literal["draft_pull_request", "rerun_source_ci", "update_issue_progress"]
WorkflowAttentionKind = Literal["blocked_goal", "user_decision", "service_or_auth_outage"]
WorkflowOperation = Literal[
    "github.branch.create",
    "github.branch.delete",
    "github.file.commit",
    "github.pull_request.draft.create",
    "github.actions.rerun_failed",
    "github.issue.comment.create",
    "github.issue.state.update",
]


class WorkflowActionGrant(WorkModel):
    """Owner-configured action with exact target scopes. | 有范围限制的操作授权。"""

    id: str = Field(min_length=1, max_length=128)
    action: WorkflowAction
    target_ids: list[str] = Field(min_length=1, max_length=100)
    base_branches: list[str] = Field(default_factory=list, max_length=100)
    branch_prefixes: list[str] = Field(default_factory=list, max_length=100)
    path_prefixes: list[str] = Field(default_factory=list, max_length=100)
    issue_numbers: list[Annotated[int, Field(gt=0)]] = Field(
        default_factory=list, max_length=10_000
    )
    source_workflow_ids: list[str] = Field(default_factory=list, max_length=100)
    permitted_operations: list[WorkflowOperation] = Field(min_length=1, max_length=20)


class WorkflowActionPolicy(WorkModel):
    """Typed source permissions run in separate child tasks. | 分离执行的源代码操作授权。"""

    allowed_actions: list[WorkflowActionGrant] = Field(default_factory=list, max_length=100)
    separate_child_task: Literal[True] = True
    production_changes: Literal["forbidden"] = "forbidden"
    requires_user_authorization: list[Literal["merge", "release", "production", "new_spend"]] = (
        Field(
            default_factory=lambda: cast(
                list[Literal["merge", "release", "production", "new_spend"]],
                ["merge", "release", "production", "new_spend"],
            )
        )
    )


class WorkflowModelPolicy(WorkModel):
    """Preferred installed model route and bounded fallback policy. | 模型首选项与备用策略。"""

    preferred_provider: Literal["antigravity", "codebuddy", "exchange"] = "antigravity"
    preferred_model: str = Field(default="gemini-3.8-flash-medium", min_length=1, max_length=256)
    fallback: Literal["configured_no_additional_spend"] = "configured_no_additional_spend"


class WorkflowAuthorizationReference(WorkModel):
    """Owner-authenticated Teams thread reference resolved by the host. | 授权线程引用。"""

    kind: Literal["teams_thread"]
    thread_binding_id: str = Field(min_length=1, max_length=512)
    owner_task_id: str = Field(min_length=1, max_length=512)


class WorkflowNotificationDestination(WorkModel):
    """Host-resolved thread; the model supplies no route. | 主机解析的通知目标。"""

    kind: Literal["responsibility_thread"]


class WorkflowQuietHours(WorkModel):
    """Quiet period for proactive notices; direct chat is unaffected. | 主动通知安静时段。"""

    start: str = Field(default="22:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end: str = Field(default="08:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    time_zone: str = Field(default="America/New_York", min_length=1, max_length=128)


class WorkflowDigestPolicy(WorkModel):
    """At most one meaningful-change digest per configured day. | 每日最多一条有意义变化摘要。"""

    enabled: bool = True
    schedule: WorkflowSchedule = Field(
        default_factory=lambda: WorkflowSchedule(
            kind="cron", expression="0 9 * * *", time_zone="America/New_York"
        )
    )
    max_per_day: Literal[1] = 1


class WorkflowNotificationsV2(WorkModel):
    """V2 notification policy with responsibility-local routing. | v2 通知策略与责任线程路由。"""

    on_change: bool = True
    on_failure: bool = True
    on_recovery: bool = True
    quiet_when_unchanged: Literal[True] = True
    quiet_hours: WorkflowQuietHours = Field(default_factory=WorkflowQuietHours)
    digest: WorkflowDigestPolicy = Field(default_factory=WorkflowDigestPolicy)
    destination: WorkflowNotificationDestination = Field(
        default_factory=lambda: WorkflowNotificationDestination(kind="responsibility_thread")
    )
    immediate_on: list[Literal["blocked_goal", "user_decision", "service_or_auth_outage"]] = Field(
        default_factory=lambda: cast(
            list[Literal["blocked_goal", "user_decision", "service_or_auth_outage"]],
            ["blocked_goal", "user_decision", "service_or_auth_outage"],
        )
    )


class WorkflowRecord(WorkModel):
    """Versioned instructions and desired cadence for DSH. | 版本化工作流定义。"""

    id: str = Field(min_length=1, max_length=512)
    version: Literal[1]
    title: str = Field(min_length=1, max_length=512)
    description: str = Field(max_length=20_000)
    instructions: str = Field(min_length=1, max_length=100_000)
    targets: list[WorkflowTarget] = Field(max_length=100)
    notifications: WorkflowNotifications
    enabled: bool
    schedule: WorkflowSchedule | None = None
    updated_at: str | None = None


class WorkflowV2Record(WorkModel):
    """Proactive responsibility negotiated with definitionVersion=2. | 主动责任定义。"""

    id: str = Field(min_length=1, max_length=512)
    version: Literal[2]
    title: str = Field(min_length=1, max_length=512)
    description: str = Field(max_length=20_000)
    goal: str = Field(min_length=1, max_length=20_000)
    instructions: str = Field(min_length=1, max_length=100_000)
    targets: list[WorkflowTarget] = Field(max_length=100)
    triggers: list[WorkflowV2Trigger] = Field(min_length=1, max_length=100)
    action_policy: WorkflowActionPolicy = Field(default_factory=WorkflowActionPolicy)
    model_policy: WorkflowModelPolicy = Field(default_factory=WorkflowModelPolicy)
    authorization: WorkflowAuthorizationReference
    notifications: WorkflowNotificationsV2 = Field(default_factory=WorkflowNotificationsV2)
    enabled: bool = False
    updated_at: str | None = None


WorkflowSource = Literal[
    "github", "azure_devops", "office_graph", "vm_health", "training", "product"
]
WorkflowV3TargetKind = Literal[
    "github_repository",
    "github_actions_workflow",
    "pipeline_runs",
    "release_deployments",
    "planner_plan",
    "host_health",
    "training_run",
    "product_resource",
]


class WorkflowV3Target(WorkModel):
    """Host-bound target selector with no arbitrary network destination. | 宿主绑定目标。"""

    id: str = Field(min_length=1, max_length=512)
    label: str = Field(min_length=1, max_length=512)
    kind: WorkflowV3TargetKind
    binding_id: str = Field(min_length=1, max_length=512)
    uri: str | None = Field(default=None, max_length=2_000)


class WorkflowV3Trigger(WorkModel):
    """Typed source polling trigger with bounded page work. | 有界来源轮询触发器。"""

    id: str = Field(min_length=1, max_length=128)
    kind: Literal["source_poll"]
    source: WorkflowSource
    target_ids: list[str] = Field(min_length=1, max_length=20)
    schedule: WorkflowSchedule
    initial_baseline: Literal["record_without_notification"] = "record_without_notification"
    page_size: int = Field(default=50, ge=1, le=50)
    max_pages: int = Field(default=20, ge=1, le=20)


class WorkflowV3OwnerPrivateAuthorization(WorkModel):
    """Resolve a private Teams route from the original verified owner task. | 私聊授权引用。"""

    kind: Literal["owner_private"]
    owner_task_id: str = Field(min_length=1, max_length=512)


WorkflowV3Authorization = Annotated[
    WorkflowAuthorizationReference | WorkflowV3OwnerPrivateAuthorization,
    Field(discriminator="kind"),
]


class WorkflowV3Destination(WorkModel):
    """No model-selected route; Work resolves the configured owner destination. | 宿主解析路由。"""

    kind: Literal["responsibility_thread", "owner_private"]


class WorkflowV3DigestPolicy(WorkModel):
    """At most one weekday digest using the approved owner timezone. | 工作日摘要策略。"""

    enabled: bool = True
    schedule: WorkflowSchedule = Field(
        default_factory=lambda: WorkflowSchedule(
            kind="cron", expression="0 9 * * 1-5", time_zone="America/New_York"
        )
    )
    max_per_day: Literal[1] = 1


class WorkflowNotificationsV3(WorkModel):
    """Quiet-by-default V3 notices with a server-resolved destination. | v3 通知策略。"""

    on_change: bool = True
    on_failure: bool = True
    on_recovery: bool = True
    quiet_when_unchanged: Literal[True] = True
    quiet_hours: WorkflowQuietHours = Field(default_factory=WorkflowQuietHours)
    digest: WorkflowV3DigestPolicy = Field(default_factory=WorkflowV3DigestPolicy)
    destination: WorkflowV3Destination = Field(
        default_factory=lambda: WorkflowV3Destination(kind="owner_private")
    )
    immediate_on: list[WorkflowAttentionKind] = Field(
        default_factory=lambda: cast(
            list[WorkflowAttentionKind],
            ["blocked_goal", "user_decision", "service_or_auth_outage"],
        )
    )


class WorkflowV3Record(WorkModel):
    """Actor-owned source-poll definition using DSH Schedule only. | actor 私有轮询定义。"""

    id: str = Field(min_length=1, max_length=512)
    version: Literal[3]
    title: str = Field(min_length=1, max_length=512)
    description: str = Field(max_length=20_000)
    targets: list[WorkflowV3Target] = Field(min_length=1, max_length=100)
    triggers: list[WorkflowV3Trigger] = Field(min_length=1, max_length=100)
    authorization: WorkflowV3Authorization
    notifications: WorkflowNotificationsV3 = Field(default_factory=WorkflowNotificationsV3)
    enabled: bool = False
    updated_at: str | None = None


WorkflowDefinition = Annotated[
    WorkflowRecord | WorkflowV2Record | WorkflowV3Record, Field(discriminator="version")
]


class WorkflowList(WorkModel):
    """Versioned workflow catalog for one Workspace. | 工作流目录。"""

    items: list[WorkflowDefinition]


class WorkflowNoticeCreate(WorkModel):
    """Submit either a v2 notice or route-free V3 digest identity. | 工作流通知请求。"""

    occurrence_id: str = Field(min_length=1, max_length=128)
    trigger_id: str = Field(min_length=1, max_length=128)
    scheduled_at: str = Field(min_length=1, max_length=128)
    kind: Literal["change", "failure", "recovery", "digest", "blocker"] | None = None
    summary: str | None = Field(default=None, min_length=1, max_length=400)
    attention_kind: WorkflowAttentionKind | None = None
    task_id: str | None = Field(default=None, min_length=1, max_length=512)


class WorkflowEvidence(WorkModel):
    """Metadata-only pointer for one scoped connector observation. | 观察证据指针。"""

    target_id: str = Field(min_length=1, max_length=512)
    tool: str = Field(min_length=1, max_length=256)
    observed_at: str = Field(min_length=1, max_length=128)
    result_digest: str = Field(min_length=1, max_length=64)


class WorkflowRepositoryCursor(WorkModel):
    """One repository's stable page chain within a fixed search window. | 仓库分页链状态。"""

    target_id: str = Field(min_length=1, max_length=512)
    page_cursor: str = Field(min_length=1, max_length=8)
    query_digest: str = Field(min_length=64, max_length=64)
    complete: bool
    has_changes: bool = False
    pages_collected: int = Field(default=0, ge=0, le=1000)
    total_count: int | None = Field(default=None, ge=0, le=10_000_000)
    blocked_reason: Literal["result_limit", "incomplete_results", "missing_pages"] | None = None


class WorkflowCheckpoint(WorkModel):
    """Durable GitHub search watermark and page cursor. | 持久化水位与分页游标。"""

    kind: Literal["github_issues_search"]
    watermark: str | None = Field(default=None, max_length=128)
    window_end: str = Field(min_length=1, max_length=128)
    complete: bool
    repositories: list[WorkflowRepositoryCursor] = Field(default_factory=list, max_length=100)


class WorkflowSourceStateFingerprint(WorkModel):
    """Compact semantic state used to detect changes and recovery. | 语义状态指纹。"""

    resource_key: str = Field(pattern=r"^[0-9a-f]{64}$")
    fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    state: Literal["healthy", "incident", "neutral"]


class WorkflowSourcePollCursor(WorkModel):
    """One target's resumable page cursor and last complete source watermark. | 来源分页状态。"""

    source: WorkflowSource
    target_id: str = Field(min_length=1, max_length=512)
    page_cursor: str | None = Field(default=None, max_length=2_000)
    resume_cursor: str | None = Field(default=None, max_length=2_000)
    watermark: str | None = Field(default=None, max_length=512)
    complete: bool
    pages_collected: int = Field(ge=0, le=20)
    seen_event_ids: list[str] = Field(default_factory=list, max_length=1_000)
    states: list[WorkflowSourceStateFingerprint] = Field(default_factory=list, max_length=1_000)


class WorkflowSourcePollCheckpoint(WorkModel):
    """Typed DSH source-poll checkpoint for restart and partial-page recovery. | 轮询检查点。"""

    kind: Literal["source_poll"]
    window_start: str | None = Field(default=None, max_length=128)
    window_end: str = Field(min_length=1, max_length=128)
    complete: bool
    sources: list[WorkflowSourcePollCursor] = Field(min_length=1, max_length=100)


WorkflowScheduleCheckpoint = Annotated[
    WorkflowCheckpoint | WorkflowSourcePollCheckpoint,
    Field(discriminator="kind"),
]


class WorkflowActionReceipt(WorkModel):
    """Durable child action status and provider operation references. | 动作子任务及操作回执。"""

    action_id: str = Field(min_length=1, max_length=128)
    action_type: WorkflowAction
    target_id: str = Field(min_length=1, max_length=512)
    task_id: str = Field(min_length=1, max_length=512)
    request_digest: str = Field(min_length=64, max_length=64)
    status: Literal["completed", "failed", "waiting", "unknown", "skipped"]
    operation_ids: list[str] = Field(default_factory=list, max_length=100)


class WorkflowScheduleEvent(WorkModel):
    """Safe durable schedule execution history, without tool output or arguments. | 调度历史。"""

    id: str = Field(min_length=1, max_length=512)
    workflow_id: str = Field(min_length=1, max_length=512)
    scheduled_at: str = Field(min_length=1, max_length=128)
    started_at: str | None = Field(default=None, max_length=128)
    ended_at: str | None = Field(default=None, max_length=128)
    status: Literal["queued", "running", "succeeded", "failed"]
    changed: bool | None = None
    summary: str | None = Field(default=None, max_length=2_000)
    error_code: str | None = Field(default=None, max_length=256)
    task_id: str | None = Field(default=None, max_length=512)
    session_id: str | None = Field(default=None, max_length=512)
    trigger_id: str | None = Field(default=None, max_length=128)
    baseline: bool | None = None
    evidence: list[WorkflowEvidence] = Field(default_factory=list, max_length=1_000)
    operation_ids: list[str] = Field(default_factory=list, max_length=100)
    action_task_ids: list[str] = Field(default_factory=list, max_length=100)
    checkpoint: WorkflowScheduleCheckpoint | None = None
    attention_kind: WorkflowAttentionKind | None = None
    action_results: list[WorkflowActionReceipt] = Field(default_factory=list, max_length=100)
    created_at: str = Field(min_length=1, max_length=128)


class WorkflowScheduleEventList(WorkModel):
    """Cursor-paginated schedule execution history. | 分页调度执行历史。"""

    items: list[WorkflowScheduleEvent]
    next_cursor: str | None
