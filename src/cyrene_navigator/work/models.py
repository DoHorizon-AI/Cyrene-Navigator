"""
Module: cyrene_navigator.work.models
Role: Strict typed HTTP contracts for persistent work resources.

模块职责：定义工作域持久资源的严格 camelCase HTTP 契约。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
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
]


class TaskCreate(WorkModel):
    """Create one durable executor task. | 创建一个持久执行任务。"""

    id: str | None = Field(default=None, min_length=1, max_length=512)
    session_id: str = Field(min_length=1, max_length=512)
    prompt: str = Field(min_length=1, max_length=100_000)
    title: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=20_000)
    metadata: dict[str, Any] = Field(default_factory=dict)


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


class TaskRecord(WorkModel):
    """Public execution record with server-owned timestamps. | 执行任务公开记录。"""

    id: str
    workspace_id: str
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


class OperationCreate(WorkModel):
    """Begin a durable external-operation receipt. | 建立外部操作回执。"""

    idempotency_key: str = Field(min_length=1, max_length=512)
    operation_type: str = Field(min_length=1, max_length=128)
    task_id: str | None = Field(default=None, min_length=1, max_length=512)
    target: str | None = Field(default=None, max_length=2_000)
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
    request: dict[str, Any]
    status: Literal["started", "uncertain", "verified"]
    evidence: dict[str, Any]
    created_at: int
    updated_at: int


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
    outcome: Literal["delivered", "failed", "uncertain"]
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


class WorkflowNotifications(WorkModel):
    """Quiet-by-default workflow notification preferences. | 安静通知偏好。"""

    on_change: bool
    on_failure: bool
    on_recovery: bool
    quiet_when_unchanged: Literal[True]


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


class WorkflowList(WorkModel):
    """Versioned workflow catalog for one Workspace. | 工作流目录。"""

    items: list[WorkflowRecord]


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
    created_at: str = Field(min_length=1, max_length=128)


class WorkflowScheduleEventList(WorkModel):
    """Cursor-paginated schedule execution history. | 分页调度执行历史。"""

    items: list[WorkflowScheduleEvent]
    next_cursor: str | None
