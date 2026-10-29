// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Durable Workflow Store                             │
// │ Role: Read/write workflow definitions and immutable run receipts.    │
// │ 模块职责：读写工作流定义及不可变执行回执。                               │
// └─────────────────────────────────────────────────────────────────────┘

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** A configurable resource inspected by one workflow. */
export interface WorkflowTarget {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly uri?: string;
  readonly bindingId?: string;
}

/** Only notification transitions intended for visible status updates. */
export interface WorkflowNotifications {
  readonly onChange: boolean;
  readonly onFailure: boolean;
  readonly onRecovery: boolean;
  readonly quietWhenUnchanged: true;
}

/** DSH-supported cron cadence stored with a versioned workflow definition. */
export interface WorkflowSchedule {
  readonly kind: 'cron';
  readonly expression: string;
  readonly timeZone: string;
}

/** Versioned definition persisted by the shared Work API. */
export interface WorkflowRecord {
  readonly id: string;
  readonly version: 1;
  readonly title: string;
  readonly description: string;
  readonly instructions: string;
  readonly targets: readonly WorkflowTarget[];
  readonly notifications: WorkflowNotifications;
  readonly enabled: boolean;
  readonly schedule?: WorkflowSchedule;
  readonly updatedAt: string;
}

/** Versioned definition accepted by the Work API; `updatedAt` is server-owned. */
export type WorkflowWrite = Omit<WorkflowRecord, 'updatedAt'>;

/** A DSH Schedule-backed v2 trigger; event polling is represented as a five-minute cron. */
export interface WorkflowV2Trigger {
  readonly id: string;
  readonly kind: 'github_incremental_poll' | 'review';
  readonly schedule: WorkflowSchedule;
  readonly targetIds: readonly string[];
  readonly initialBaseline: 'record_without_notification';
  readonly search?: {
    readonly state: 'open' | 'closed' | 'all';
    readonly query?: string;
    readonly labels: readonly string[];
    readonly limit: number;
  };
}

export type WorkflowAction = 'draft_pull_request' | 'rerun_source_ci' | 'update_issue_progress';
export type WorkflowOperation =
  | 'github.branch.create'
  | 'github.branch.delete'
  | 'github.file.commit'
  | 'github.pull_request.draft.create'
  | 'github.actions.rerun_failed'
  | 'github.issue.comment.create'
  | 'github.issue.state.update';

/** Owner-configured action grant for specific repositories and exact write sub-scopes. */
export interface WorkflowActionGrant {
  readonly id: string;
  readonly action: WorkflowAction;
  /** References WorkflowTarget.id; GitHub targets use the decimal REST repository id. */
  readonly targetIds: readonly string[];
  readonly baseBranches: readonly string[];
  readonly branchPrefixes: readonly string[];
  readonly pathPrefixes: readonly string[];
  readonly issueNumbers: readonly number[];
  readonly sourceWorkflowIds: readonly string[];
  readonly permittedOperations: readonly WorkflowOperation[];
}

export interface WorkflowAuthorizationReference {
  readonly kind: 'teams_thread';
  readonly threadBindingId: string;
  readonly ownerTaskId: string;
}

export interface WorkflowNotificationDestination {
  readonly kind: 'responsibility_thread';
}

export interface WorkflowV2Notifications {
  readonly onChange: boolean;
  readonly onFailure: boolean;
  readonly onRecovery: boolean;
  readonly quietWhenUnchanged: true;
  readonly quietHours: {
    readonly start: string;
    readonly end: string;
    readonly timeZone: string;
  };
  readonly digest: {
    readonly enabled: boolean;
    readonly schedule: WorkflowSchedule;
    readonly maxPerDay: 1;
  };
  readonly destination: WorkflowNotificationDestination;
  readonly immediateOn: readonly ('blocked_goal' | 'user_decision' | 'service_or_auth_outage')[];
}

/** Preferred installed model route and bounded fallback policy. */
export interface WorkflowModelPolicy {
  readonly preferredProvider: 'antigravity' | 'codebuddy' | 'exchange';
  readonly preferredModel: string;
  readonly fallback: 'configured_no_additional_spend';
}

/** Backward-compatible exported name for the v2 notification contract. */
export type WorkflowNotificationsV2 = WorkflowV2Notifications;

/** Proactive responsibility definition negotiated only with definitionVersion=2. */
export interface WorkflowV2Record {
  readonly id: string;
  readonly version: 2;
  readonly title: string;
  readonly description: string;
  readonly goal: string;
  readonly instructions: string;
  readonly targets: readonly WorkflowTarget[];
  readonly triggers: readonly WorkflowV2Trigger[];
  readonly actionPolicy: {
    readonly allowedActions: readonly WorkflowActionGrant[];
    readonly separateChildTask: true;
    readonly productionChanges: 'forbidden';
    readonly requiresUserAuthorization: readonly ['merge', 'release', 'production', 'new_spend'];
  };
  readonly modelPolicy: WorkflowModelPolicy;
  readonly authorization: WorkflowAuthorizationReference;
  readonly notifications: WorkflowV2Notifications;
  readonly enabled: boolean;
  readonly updatedAt?: string;
}

export type WorkflowV2Write = Omit<WorkflowV2Record, 'updatedAt'>;

/** Canonical provider classes supported by deterministic source polling. */
export type WorkflowObservationSource = 'github' | 'azure_devops' | 'vm_health' | 'training' | 'product' | 'office_graph';

/** One source poll scheduled by the sole DSH Schedule domain. */
export interface WorkflowV3Trigger {
  readonly id: string;
  readonly kind: 'source_poll';
  readonly source: WorkflowObservationSource;
  readonly schedule: WorkflowSchedule;
  readonly targetIds: readonly string[];
  readonly initialBaseline: 'record_without_notification';
  readonly pageSize: number;
  readonly maxPages: number;
}

/** Host-verified notification destination. Private conversation data is resolved by Work. */
export type WorkflowV3Destination =
  | { readonly kind: 'responsibility_thread' }
  | { readonly kind: 'owner_private' };

/** Owner-task proof used to resolve channel or personal notification routes. */
export type WorkflowV3Authorization =
  | { readonly kind: 'teams_thread'; readonly threadBindingId: string; readonly ownerTaskId: string }
  | { readonly kind: 'owner_private'; readonly ownerTaskId: string };

/** Notification policy for deterministic source events, negotiated only as definitionVersion=3. */
export interface WorkflowV3Notifications extends Omit<WorkflowV2Notifications, 'destination'> {
  readonly destination: WorkflowV3Destination;
}

/** Opt-in deterministic event workflow. It contains no model or action policy. */
export interface WorkflowV3Record {
  readonly id: string;
  readonly version: 3;
  readonly title: string;
  readonly description: string;
  readonly targets: readonly WorkflowTarget[];
  readonly triggers: readonly WorkflowV3Trigger[];
  readonly authorization: WorkflowV3Authorization;
  readonly notifications: WorkflowV3Notifications;
  readonly enabled: boolean;
  readonly updatedAt?: string;
}

export type WorkflowV3Write = Omit<WorkflowV3Record, 'updatedAt'>;
export type WorkflowDefinition = WorkflowRecord | WorkflowV2Record | WorkflowV3Record;

/** One immutable state fact for a single DSH timer occurrence. */
export interface WorkflowScheduleEvent {
  readonly id: string;
  readonly workflowId: string;
  readonly scheduledAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed';
  readonly changed?: boolean;
  readonly summary?: string;
  readonly errorCode?: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly triggerId?: string;
  readonly baseline?: boolean;
  readonly evidence?: readonly WorkflowEvidence[];
  readonly operationIds?: readonly string[];
  readonly actionTaskIds?: readonly string[];
  readonly actionResults?: readonly WorkflowActionReceipt[];
  readonly checkpoint?: WorkflowEventCheckpoint;
  readonly attentionKind?: WorkflowAttentionKind;
  readonly createdAt: string;
}

export interface WorkflowActionReceipt {
  readonly actionId: string;
  readonly actionType: WorkflowAction;
  readonly targetId: string;
  readonly taskId: string;
  readonly requestDigest: string;
  readonly status: 'completed' | 'failed' | 'waiting' | 'unknown' | 'skipped';
  readonly operationIds: readonly string[];
}

/** Metadata-only pointer proving a successful target-bound read. */
export interface WorkflowEvidence {
  readonly targetId: string;
  readonly tool: string;
  readonly observedAt: string;
  readonly resultDigest: string;
}

/** Opaque incremental-poll cursor; incomplete observations never advance the watermark. */
export interface WorkflowCheckpoint {
  readonly kind: 'github_issues_search';
  readonly watermark: string | null;
  readonly windowEnd: string;
  readonly complete: boolean;
  readonly repositories: readonly WorkflowRepositoryCursor[];
}

/** Source-neutral bounded poll cursor. Watermarks advance only after complete page chains. */
export interface WorkflowSourceCheckpoint {
  readonly kind: 'source_poll';
  readonly windowStart: string | null;
  readonly windowEnd: string;
  readonly complete: boolean;
  readonly sources: readonly WorkflowSourceCursor[];
}

export interface WorkflowSourceCursor {
  readonly source: WorkflowObservationSource;
  readonly targetId: string;
  readonly pageCursor: string | null;
  /** Opaque cursor after a completed window, used to start the next window (for example Yield sequence). */
  readonly resumeCursor?: string | null;
  readonly watermark: string | null;
  readonly complete: boolean;
  readonly pagesCollected: number;
  readonly seenEventIds?: readonly string[];
  readonly states?: readonly WorkflowSourceState[];
}

export interface WorkflowSourceState {
  readonly resourceKey: string;
  readonly fingerprint: string;
  readonly state: 'healthy' | 'incident' | 'neutral';
}

export type WorkflowEventCheckpoint = WorkflowCheckpoint | WorkflowSourceCheckpoint;

/** Reference-only metadata pointer carried by an immutable source observation. */
export interface WorkflowMetadataReference {
  readonly kind: string;
  readonly resourceUri: string;
  readonly resourceVersion?: number | string;
}

/** Identity-free event write accepted from a fixed source adapter. */
export interface WorkflowAutomationEventWrite {
  readonly source: WorkflowObservationSource;
  readonly sourceEventId: string;
  readonly resourceUri: string;
  readonly sourceVersion: number | string;
  readonly eventType: string;
  readonly occurredAt: number;
  readonly title?: string;
  readonly summary?: string;
  readonly severity?: 'info' | 'warning' | 'critical';
  readonly correlationId?: string;
  readonly experimentId?: string;
  readonly metadataReferences?: readonly WorkflowMetadataReference[];
  readonly semanticFingerprint?: string;
  readonly stateClass?: 'healthy' | 'incident' | 'neutral';
}

/** Normalized poll item; semantic fields drive transitions but remain source event data, not routing. */
export type WorkflowSourceObservation = WorkflowAutomationEventWrite & {
  readonly semanticFingerprint: string;
  readonly stateClass: 'healthy' | 'incident' | 'neutral';
};

/** Server-owned event projection. Actor and visibility always come from Work auth. */
export interface WorkflowAutomationEvent extends WorkflowAutomationEventWrite {
  readonly id: string;
  readonly observedAt: number;
  readonly actorId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly visibility: 'owner';
}

export interface WorkflowAutomationEventReceipt {
  readonly event: WorkflowAutomationEvent;
  readonly duplicate: boolean;
}

export interface WorkflowAutomationEventPage {
  readonly items: readonly WorkflowAutomationEvent[];
  readonly nextCursor: string | null;
}

/** Route-free request to durably classify one source event for one owner workflow trigger. */
export interface WorkflowAutomationEventNoticeRequest {
  readonly eventId: string;
  readonly workflowId: string;
  readonly triggerId: string;
  readonly occurrenceId: string;
  readonly scheduledAt: string;
  readonly taskId: string;
}

export interface WorkflowAutomationEventNoticeReceipt {
  readonly eventId: string;
  readonly workflowId: string;
  readonly triggerId: string;
  readonly occurrenceId: string;
  readonly decision: 'initial_baseline' | 'unchanged' | 'stale' | 'change' | 'failure' | 'recovery' | 'blocker' | 'quiet';
  readonly notificationId: string | null;
  readonly duplicate: boolean;
}

/** Route-free v3 weekday digest request; Work derives changed events and the private destination. */
export interface WorkflowV3DigestNoticeRequest {
  readonly occurrenceId: string;
  readonly triggerId: 'daily-digest';
  readonly scheduledAt: string;
  readonly taskId: string;
}

/** Task-bound evidence for one completed source page; contains IDs/cursors but no event body or route. */
export interface WorkflowSourcePageReceipt {
  readonly workflowId: string;
  readonly triggerId: string;
  readonly occurrenceId: string;
  readonly scheduledAt: string;
  readonly source: WorkflowObservationSource;
  readonly targetId: string;
  readonly pageCursor: string | null;
  readonly nextCursor: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string;
  readonly automationEventIds: readonly string[];
  readonly sourceEventIds: readonly string[];
  readonly observedAt: number;
}

/** A bounded adapter failure receipt; it proves failure state without claiming page completion. */
export interface WorkflowSourceErrorReceipt {
  readonly workflowId: string;
  readonly triggerId: string;
  readonly occurrenceId: string;
  readonly scheduledAt: string;
  readonly source: WorkflowObservationSource;
  readonly targetId: string;
  readonly windowStart: string | null;
  readonly windowEnd: string;
  readonly outcome: 'failed';
  readonly reasonCode: WorkflowObservationErrorCode;
  readonly observedAt: string;
}

export type WorkflowSourceTaskReceipt = WorkflowSourcePageReceipt | WorkflowSourceErrorReceipt;

export type WorkflowObservationErrorCode =
  | 'not_configured' | 'forbidden' | 'unavailable' | 'timeout' | 'invalid' | 'partial';

export interface WorkflowRepositoryCursor {
  readonly targetId: string;
  readonly pageCursor: string;
  readonly queryDigest: string;
  readonly complete: boolean;
  readonly hasChanges: boolean;
  readonly pagesCollected: number;
  readonly totalCount?: number;
  readonly blockedReason?: 'result_limit' | 'incomplete_results' | 'missing_pages';
}

/** Cursor page returned by the Work API. */
export interface WorkflowScheduleEventPage {
  readonly items: readonly WorkflowScheduleEvent[];
  readonly nextCursor: string | null;
}

/** Notification category stored in the workspace-scoped durable outbox. */
export type WorkflowAttentionKind = 'blocked_goal' | 'user_decision' | 'service_or_auth_outage';
export type WorkflowOutboxType = 'workflow.change' | 'workflow.failure' | 'workflow.recovery' | 'workflow.digest' | 'workflow.blocker';

/** Minimal safe payload retained by the workflow notification outbox. */
export interface WorkflowOutboxPayload {
  readonly workflowId: string;
  readonly occurrenceId: string;
  readonly triggerId?: string;
  readonly summary: string;
  readonly taskId?: string;
}

/** Idempotent outbox request; taskId intentionally stays inside payload after task completion. */
export interface WorkflowOutboxRequest {
  readonly deduplicationKey: string;
  readonly type: WorkflowOutboxType;
  readonly payload: WorkflowOutboxPayload;
}

/** Durable Work API response for one outbox enqueue or exact replay. */
export interface WorkflowOutboxReceipt {
  readonly notification: Readonly<Record<string, unknown>>;
  readonly duplicate: boolean;
}

/** Minimal durable workflow-store contract used by the runtime. */
export interface WorkflowStore {
  listWorkflows(): Promise<readonly WorkflowRecord[]>;
  listWorkflows(definitionVersion: 1): Promise<readonly WorkflowRecord[]>;
  listWorkflows(definitionVersion: 2): Promise<readonly WorkflowV2Record[]>;
  listWorkflows(definitionVersion: 3): Promise<readonly WorkflowV3Record[]>;
  putWorkflow(workflow: WorkflowWrite): Promise<WorkflowRecord>;
  putWorkflow(workflow: WorkflowV2Write): Promise<WorkflowV2Record>;
  putWorkflow(workflow: WorkflowV3Write): Promise<WorkflowV3Record>;
  appendScheduleEvent(event: WorkflowScheduleEvent): Promise<WorkflowScheduleEvent>;
  appendAutomationEvent(event: WorkflowAutomationEventWrite): Promise<WorkflowAutomationEventReceipt>;
  listAutomationEvents(options?: { readonly limit?: number; readonly cursor?: string }): Promise<WorkflowAutomationEventPage>;
  enqueueAutomationEventNotice(request: WorkflowAutomationEventNoticeRequest): Promise<WorkflowAutomationEventNoticeReceipt>;
  enqueueV3DigestNotice(workflowId: string, request: WorkflowV3DigestNoticeRequest): Promise<WorkflowOutboxReceipt>;
  enqueueNotification(request: WorkflowOutboxRequest): Promise<WorkflowOutboxReceipt>;
  enqueueTeamsNotification(workflowId: string, request: WorkflowTeamsNoticeRequest): Promise<WorkflowOutboxReceipt>;
  getOperation?(operationId: string): Promise<WorkflowOperationState>;
  getScheduleEvent?(eventId: string): Promise<WorkflowScheduleEvent | undefined>;
  listScheduleEvents(options: {
    readonly workflowId: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<WorkflowScheduleEventPage>;
}

/** Verified Teams message projected by the host resolver and stored in the common Work outbox. */
export interface WorkflowTeamsNoticeRequest {
  readonly occurrenceId: string;
  readonly triggerId: string;
  readonly scheduledAt: string;
  readonly kind: 'change' | 'failure' | 'recovery' | 'digest' | 'blocker';
  readonly summary: string;
  readonly attentionKind?: WorkflowAttentionKind;
}

export interface WorkflowOperationState {
  readonly id: string;
  readonly taskId?: string | null;
  readonly status: 'started' | 'uncertain' | 'verified';
  readonly operationType: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** Authenticated Work API client configuration for one workspace. */
export interface WorkflowStoreConnection {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly tokenEnv?: string;
  readonly requestTimeoutMs?: number;
}

/** Safe HTTP failure with a code and status but no response body or credential data. */
export class WorkflowStoreHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Workflow store request failed (${status}, ${code})`);
    this.name = 'WorkflowStoreHttpError';
  }
}

/**
 * Authenticated client for the workspace-scoped Workflow and Schedule Event routes.
 * Tokens are resolved for each request and never copied into persistent state.
 */
export class WorkflowsClient implements WorkflowStore {
  private readonly workflowsUrl: string;
  private readonly workUrl: string;
  private readonly eventsUrl: string;
  private readonly automationEventsUrl: string;
  private readonly notificationsUrl: string;
  private readonly tokenEnv: string;
  private readonly requestTimeoutMs: number;

  constructor(private readonly connection: WorkflowStoreConnection) {
    const base = new URL(connection.baseUrl);
    if (base.username || base.password || base.search || base.hash) throw new Error('Invalid workflow persistence base URL');
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
      throw new Error('Remote workflow persistence requires HTTPS; HTTP is limited to loopback');
    }
    if (!connection.workspaceId.trim()) throw new Error('A configured workspace is required for durable workflows');
    const prefix = `${base.href.replace(/\/$/, '')}/api/v1/workspaces/${encodeURIComponent(connection.workspaceId)}/work`;
    this.workUrl = prefix;
    this.workflowsUrl = `${prefix}/workflows`;
    this.eventsUrl = `${prefix}/schedule-events`;
    this.automationEventsUrl = `${prefix}/automation-events`;
    this.notificationsUrl = `${prefix}/notifications`;
    this.tokenEnv = connection.tokenEnv ?? 'CYRENE_SESSION_TOKEN';
    this.requestTimeoutMs = connection.requestTimeoutMs ?? 10_000;
  }

  /** List only the explicitly negotiated definition version; legacy callers remain v1. */
  listWorkflows(): Promise<readonly WorkflowRecord[]>;
  listWorkflows(definitionVersion: 1): Promise<readonly WorkflowRecord[]>;
  listWorkflows(definitionVersion: 2): Promise<readonly WorkflowV2Record[]>;
  listWorkflows(definitionVersion: 3): Promise<readonly WorkflowV3Record[]>;
  async listWorkflows(definitionVersion: 1 | 2 | 3 = 1): Promise<readonly WorkflowDefinition[]> {
    const url = `${this.workflowsUrl}?definitionVersion=${definitionVersion}`;
    const row = object(await this.request(url, 'GET'), 'Workflow page');
    if (!Array.isArray(row.items)) throw new TypeError('Workflow page is missing items');
    return row.items.map(value => decodeWorkflowDefinition(value, definitionVersion));
  }

  /** Create or replace one negotiated workflow definition. */
  putWorkflow(workflow: WorkflowWrite): Promise<WorkflowRecord>;
  putWorkflow(workflow: WorkflowV2Write): Promise<WorkflowV2Record>;
  putWorkflow(workflow: WorkflowV3Write): Promise<WorkflowV3Record>;
  async putWorkflow(workflow: WorkflowWrite | WorkflowV2Write | WorkflowV3Write): Promise<WorkflowDefinition> {
    validateWorkflowWrite(workflow);
    return decodeWorkflowDefinition(
      await this.request(
        `${this.workflowsUrl}/${encodeURIComponent(workflow.id)}?definitionVersion=${workflow.version}`,
        'PUT',
        workflow,
      ),
      workflow.version,
    );
  }

  /** Append one immutable run state. Exact duplicate ids are idempotent on the server. */
  async appendScheduleEvent(event: WorkflowScheduleEvent): Promise<WorkflowScheduleEvent> {
    validateScheduleEvent(event);
    return decodeScheduleEvent(await this.request(this.eventsUrl, 'POST', event));
  }

  /** Append one identity-free source observation through the actor-scoped Work API route. */
  async appendAutomationEvent(event: WorkflowAutomationEventWrite): Promise<WorkflowAutomationEventReceipt> {
    validateWorkflowAutomationEvent(event);
    const row = object(await this.request(this.automationEventsUrl, 'POST', event), 'Automation event receipt');
    if (typeof row.duplicate !== 'boolean') throw new TypeError('Automation event receipt is missing duplicate');
    return { event: decodeWorkflowAutomationEvent(row), duplicate: row.duplicate };
  }

  /** Read bounded actor-scoped automation events without widening existing Work read permissions. */
  async listAutomationEvents(options: { readonly limit?: number; readonly cursor?: string } = {}): Promise<WorkflowAutomationEventPage> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const row = object(await this.request(`${this.automationEventsUrl}${suffix}`, 'GET'), 'Automation event page');
    if (!Array.isArray(row.items)) throw new TypeError('Automation event page is missing items');
    if (row.nextCursor !== null && row.nextCursor !== undefined && typeof row.nextCursor !== 'string') {
      throw new TypeError('Invalid automation event cursor');
    }
    return {
      items: row.items.map(decodeWorkflowAutomationEvent),
      nextCursor: typeof row.nextCursor === 'string' ? row.nextCursor : null,
    };
  }

  /** Atomically record/replay one owner-scoped event transition intent through the Work outbox. */
  async enqueueAutomationEventNotice(
    request: WorkflowAutomationEventNoticeRequest,
  ): Promise<WorkflowAutomationEventNoticeReceipt> {
    validateWorkflowAutomationEventNoticeRequest(request);
    const row = object(await this.request(
      `${this.automationEventsUrl}/${encodeURIComponent(request.eventId)}/notices`, 'POST', request,
    ), 'Automation event notice receipt');
    const decisions: WorkflowAutomationEventNoticeReceipt['decision'][] = [
      'initial_baseline', 'unchanged', 'stale', 'change', 'failure', 'recovery', 'blocker', 'quiet',
    ];
    if (!decisions.includes(row.decision as WorkflowAutomationEventNoticeReceipt['decision'])
      || typeof row.duplicate !== 'boolean'
      || row.notificationId !== null && typeof row.notificationId !== 'string') {
      throw new TypeError('Invalid automation event notice receipt');
    }
    return {
      eventId: text(row.eventId, 'notice.eventId'),
      workflowId: text(row.workflowId, 'notice.workflowId'),
      triggerId: text(row.triggerId, 'notice.triggerId'),
      occurrenceId: text(row.occurrenceId, 'notice.occurrenceId'),
      decision: row.decision as WorkflowAutomationEventNoticeReceipt['decision'],
      notificationId: row.notificationId as string | null,
      duplicate: row.duplicate,
    };
  }

  async enqueueV3DigestNotice(
    workflowId: string,
    request: WorkflowV3DigestNoticeRequest,
  ): Promise<WorkflowOutboxReceipt> {
    validateWorkflowV3DigestNoticeRequest(workflowId, request);
    const row = object(await this.request(
      `${this.workflowsUrl}/${encodeURIComponent(workflowId)}/notices`, 'POST', request,
    ), 'V3 digest notice receipt');
    const notification = object(row.notification, 'V3 digest notification');
    if (typeof row.duplicate !== 'boolean') throw new TypeError('V3 digest receipt is missing duplicate');
    return { notification, duplicate: row.duplicate };
  }

  /** Read one immutable schedule receipt without scanning a responsibility's full event history. */
  async getScheduleEvent(eventId: string): Promise<WorkflowScheduleEvent | undefined> {
    try {
      return decodeScheduleEvent(await this.request(`${this.eventsUrl}/${encodeURIComponent(eventId)}`, 'GET'));
    } catch (error: unknown) {
      if (error instanceof WorkflowStoreHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Persist one safe transition notice; exact replays return the original outbox item. */
  async enqueueNotification(request: WorkflowOutboxRequest): Promise<WorkflowOutboxReceipt> {
    validateWorkflowOutboxRequest(request);
    const row = object(await this.request(this.notificationsUrl, 'POST', request), 'Workflow notification receipt');
    const notification = object(row.notification, 'Workflow notification');
    if (typeof row.duplicate !== 'boolean') throw new TypeError('Workflow notification receipt is missing duplicate');
    return { notification, duplicate: row.duplicate };
  }

  /** Ask the Work service to project a verified v2 notice using its canonical owner thread. */
  async enqueueTeamsNotification(workflowId: string, request: WorkflowTeamsNoticeRequest): Promise<WorkflowOutboxReceipt> {
    validateWorkflowTeamsNoticeRequest(workflowId, request);
    const url = `${this.workflowsUrl}/${encodeURIComponent(workflowId)}/notices`;
    const row = object(await this.request(url, 'POST', request), 'Teams notification receipt');
    const notification = object(row.notification, 'Teams notification');
    if (typeof row.duplicate !== 'boolean') throw new TypeError('Teams notification receipt is missing duplicate');
    return { notification, duplicate: row.duplicate };
  }

  /** Read one operation state before any repeated action can be admitted. */
  async getOperation(operationId: string): Promise<WorkflowOperationState> {
    const row = object(await this.request(`${this.workUrl}/operations/${encodeURIComponent(operationId)}`, 'GET'), 'Workflow operation receipt');
    const operation = object(row.operation, 'Workflow operation');
    if (operation.status !== 'started' && operation.status !== 'uncertain' && operation.status !== 'verified') {
      throw new TypeError('Invalid workflow operation status');
    }
    return {
      id: text(operation.id, 'operation.id'),
      status: operation.status,
      operationType: text(operation.operationType, 'operation.operationType'),
      evidence: object(operation.evidence, 'operation.evidence'),
      ...(operation.taskId === undefined || operation.taskId === null ? {} : { taskId: text(operation.taskId, 'operation.taskId') }),
    };
  }

  /** List one workflow's immutable schedule event history. */
  async listScheduleEvents(options: {
    readonly workflowId: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<WorkflowScheduleEventPage> {
    const query = new URLSearchParams({ workflowId: options.workflowId });
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    const row = object(await this.request(`${this.eventsUrl}?${query.toString()}`, 'GET'), 'Schedule event page');
    if (!Array.isArray(row.items)) throw new TypeError('Schedule event page is missing items');
    if (row.nextCursor !== null && row.nextCursor !== undefined && typeof row.nextCursor !== 'string') {
      throw new TypeError('Invalid schedule event cursor');
    }
    return {
      items: row.items.map(decodeScheduleEvent),
      nextCursor: typeof row.nextCursor === 'string' ? row.nextCursor : null,
    };
  }

  private async request(url: string, method: 'GET' | 'PUT' | 'POST', body?: unknown): Promise<unknown> {
    const token = process.env[this.tokenEnv];
    if (!token) throw new Error(`Missing required environment reference ${this.tokenEnv}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.ok) throw new WorkflowStoreHttpError(response.status, 'WORKFLOW_STORE_REJECTED');
      return await response.json() as unknown;
    } catch (error: unknown) {
      if (error instanceof WorkflowStoreHttpError) throw error;
      if (controller.signal.aborted) throw new Error('Workflow store request timed out');
      throw new Error('Workflow store request failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Load the seven generic workflow-memory templates shipped with the preset.
 * @returns Definitions with empty configurable targets and disabled execution.
 */
export async function loadDefaultWorkflowTemplates(): Promise<readonly WorkflowWrite[]> {
  const file = new URL('../../presets/cyrene-navigator/workflows.json', import.meta.url);
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  const root = object(parsed, 'workflow templates');
  if (root.version !== 1 || !Array.isArray(root.workflows)) throw new TypeError('Invalid workflow template bundle');
  return root.workflows.map((workflow) => {
    const row = object(workflow, 'workflow template');
    const decoded = decodeWorkflow({ ...row, updatedAt: '1970-01-01T00:00:00.000Z' });
    return {
      id: decoded.id, version: decoded.version, title: decoded.title, description: decoded.description,
      instructions: decoded.instructions, targets: decoded.targets, notifications: decoded.notifications,
      enabled: decoded.enabled, ...(decoded.schedule === undefined ? {} : { schedule: decoded.schedule }),
    };
  });
}

/** Test store preserving the Work API's idempotent and immutable event semantics. */
export class InMemoryWorkflowStore implements WorkflowStore {
  private readonly workflows = new Map<string, WorkflowRecord>();
  private readonly workflowsV2 = new Map<string, WorkflowV2Record>();
  private readonly workflowsV3 = new Map<string, WorkflowV3Record>();
  private readonly events = new Map<string, WorkflowScheduleEvent>();
  private readonly automationEvents = new Map<string, WorkflowAutomationEvent>();
  private readonly automationEventKeys = new Map<string, string>();
  private readonly automationEventNotices = new Map<string, WorkflowAutomationEventNoticeReceipt>();
  private readonly automationEventStates = new Map<string, { readonly fingerprint: string; readonly state: WorkflowSourceState['state'] }>();
  private readonly notifications = new Map<string, WorkflowOutboxRequest | { readonly workflowId: string; readonly notice: WorkflowTeamsNoticeRequest }>();

  listWorkflows(): Promise<readonly WorkflowRecord[]>;
  listWorkflows(definitionVersion: 1): Promise<readonly WorkflowRecord[]>;
  listWorkflows(definitionVersion: 2): Promise<readonly WorkflowV2Record[]>;
  listWorkflows(definitionVersion: 3): Promise<readonly WorkflowV3Record[]>;
  async listWorkflows(definitionVersion: 1 | 2 | 3 = 1): Promise<readonly WorkflowDefinition[]> {
    const rows = definitionVersion === 1 ? this.workflows.values()
      : definitionVersion === 2 ? this.workflowsV2.values() : this.workflowsV3.values();
    return [...rows].map(value => structuredClone(value));
  }

  putWorkflow(workflow: WorkflowWrite): Promise<WorkflowRecord>;
  putWorkflow(workflow: WorkflowV2Write): Promise<WorkflowV2Record>;
  putWorkflow(workflow: WorkflowV3Write): Promise<WorkflowV3Record>;
  async putWorkflow(workflow: WorkflowWrite | WorkflowV2Write | WorkflowV3Write): Promise<WorkflowDefinition> {
    validateWorkflowWrite(workflow);
    const row = { ...structuredClone(workflow), updatedAt: new Date().toISOString() };
    if (row.version === 1) {
      this.workflows.set(row.id, row);
      return structuredClone(row);
    }
    if (row.version === 2) {
      this.workflowsV2.set(row.id, row);
      return structuredClone(row);
    }
    this.workflowsV3.set(row.id, row);
    return structuredClone(row);
  }

  async appendScheduleEvent(event: WorkflowScheduleEvent): Promise<WorkflowScheduleEvent> {
    validateScheduleEvent(event);
    const existing = this.events.get(event.id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) throw new WorkflowStoreHttpError(409, 'SCHEDULE_EVENT_CONFLICT');
      return structuredClone(existing);
    }
    this.events.set(event.id, structuredClone(event));
    return structuredClone(event);
  }

  async getScheduleEvent(eventId: string): Promise<WorkflowScheduleEvent | undefined> {
    const event = this.events.get(eventId);
    if (event === undefined) return undefined;
    return structuredClone(event);
  }

  async appendAutomationEvent(event: WorkflowAutomationEventWrite): Promise<WorkflowAutomationEventReceipt> {
    validateWorkflowAutomationEvent(event);
    const key = `fixture-org\0fixture-workspace\0${event.source}\0${event.sourceEventId}`;
    const existingId = this.automationEventKeys.get(key);
    if (existingId !== undefined) {
      const existing = this.automationEvents.get(existingId)!;
      const { id: _id, observedAt: _observedAt, actorId: _actorId, organizationId: _organizationId,
        workspaceId: _workspaceId, revision: _revision, visibility: _visibility, ...storedInput } = existing;
      if (canonicalEventJson(storedInput) !== canonicalEventJson(event)) {
        throw new WorkflowStoreHttpError(409, 'WORK_AUTOMATION_EVENT_CONFLICT');
      }
      return { event: structuredClone(existing), duplicate: true };
    }
    const id = `event-${digestAutomationEventKey(key).slice(0, 40)}`;
    const stored: WorkflowAutomationEvent = {
      ...structuredClone(event), id, observedAt: Date.now(), actorId: 'fixture-owner',
      organizationId: 'fixture-org', workspaceId: 'fixture-workspace', revision: 1, visibility: 'owner',
    };
    this.automationEvents.set(id, stored);
    this.automationEventKeys.set(key, id);
    return { event: structuredClone(stored), duplicate: false };
  }

  async listAutomationEvents(options: { readonly limit?: number; readonly cursor?: string } = {}): Promise<WorkflowAutomationEventPage> {
    const all = [...this.automationEvents.values()];
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isSafeInteger(start) || start < 0) throw new WorkflowStoreHttpError(400, 'INVALID_CURSOR');
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
    return {
      items: structuredClone(all.slice(start, start + limit)),
      nextCursor: start + limit < all.length ? String(start + limit) : null,
    };
  }

  async enqueueAutomationEventNotice(
    request: WorkflowAutomationEventNoticeRequest,
  ): Promise<WorkflowAutomationEventNoticeReceipt> {
    validateWorkflowAutomationEventNoticeRequest(request);
    const event = this.automationEvents.get(request.eventId);
    const workflow = this.workflowsV3.get(request.workflowId);
    if (event === undefined || workflow === undefined || !workflow.enabled) {
      throw new WorkflowStoreHttpError(404, 'WORK_AUTOMATION_EVENT_OR_WORKFLOW_NOT_FOUND');
    }
    const trigger = workflow.triggers.find(item => item.id === request.triggerId && item.source === event.source);
    const running = [...this.events.values()].find(item => item.workflowId === request.workflowId
      && item.triggerId === request.triggerId && item.scheduledAt === request.scheduledAt
      && item.taskId === request.taskId && item.status === 'running');
    if (trigger === undefined || running?.status !== 'running' || running.taskId !== request.taskId) {
      throw new WorkflowStoreHttpError(409, 'WORK_AUTOMATION_EVENT_NOTICE_NOT_ACTIVE');
    }
    const noticeKey = `${request.workflowId}\0${request.triggerId}\0${request.eventId}`;
    const previousNotice = this.automationEventNotices.get(noticeKey);
    if (previousNotice !== undefined) return { ...structuredClone(previousNotice), duplicate: true };

    const stateKey = `${request.workflowId}\0${request.triggerId}\0${event.resourceUri}`;
    const previous = this.automationEventStates.get(stateKey);
    const fingerprint = event.semanticFingerprint ?? digestAutomationEventKey(canonicalEventJson({
      eventType: event.eventType, sourceVersion: event.sourceVersion, severity: event.severity ?? null,
      title: event.title ?? null, summary: event.summary ?? null,
    }));
    const state = event.stateClass ?? inferWorkflowEventState(event);
    let decision: WorkflowAutomationEventNoticeReceipt['decision'];
    if (event.eventType === 'source.poll.failure') {
      decision = previous?.state === 'incident' && previous.fingerprint === fingerprint ? 'unchanged' : 'failure';
    } else if (event.eventType === 'source.poll.recovery') {
      if (previous?.state !== 'incident') {
        throw new WorkflowStoreHttpError(409, 'WORK_AUTOMATION_EVENT_RECOVERY_WITHOUT_INCIDENT');
      }
      decision = 'recovery';
    } else if (running.baseline === true) decision = 'initial_baseline';
    else if (previous?.fingerprint === fingerprint) decision = 'unchanged';
    else if (state === 'incident') decision = 'failure';
    else if (previous?.state === 'incident' && state === 'healthy') decision = 'recovery';
    else decision = 'change';

    const scheduledAt = request.scheduledAt;
    const occurrenceId = request.occurrenceId;
    const shouldQueue = decision === 'failure' ? workflow.notifications.onFailure
      : decision === 'recovery' ? workflow.notifications.onRecovery
        : decision === 'change' ? workflow.notifications.onChange && !isWorkflowQuietTime(scheduledAt, workflow.notifications.quietHours)
          : false;
    let notificationId: string | null = null;
    if (shouldQueue) {
      const type: WorkflowOutboxType = decision === 'change' ? 'workflow.change'
        : decision === 'failure' ? 'workflow.failure' : 'workflow.recovery';
      const deduplicationKey = `workflow:${request.workflowId}:source:${request.eventId}:${decision}`;
      await this.enqueueNotification({
        deduplicationKey,
        type,
        payload: {
          workflowId: request.workflowId,
          occurrenceId,
          triggerId: request.triggerId,
          summary: redactAutomationSummary(event.summary ?? event.title ?? `${event.source} ${event.eventType}`),
          taskId: request.taskId,
        },
      });
      notificationId = deduplicationKey;
    } else if (decision === 'failure' && workflow.notifications.immediateOn.includes('service_or_auth_outage')) {
      const deduplicationKey = `workflow:${request.workflowId}:source:${request.eventId}:blocker`;
      await this.enqueueNotification({
        deduplicationKey,
        type: 'workflow.blocker',
        payload: {
          workflowId: request.workflowId,
          occurrenceId,
          triggerId: request.triggerId,
          summary: redactAutomationSummary(event.summary ?? event.title ?? `${event.source} ${event.eventType}`),
          taskId: request.taskId,
        },
      });
      notificationId = deduplicationKey;
      decision = 'blocker';
    } else if (decision === 'change' && workflow.notifications.onChange && isWorkflowQuietTime(scheduledAt, workflow.notifications.quietHours)) {
      decision = 'quiet';
    }
    this.automationEventStates.set(stateKey, { fingerprint, state });
    const receipt: WorkflowAutomationEventNoticeReceipt = {
      eventId: request.eventId,
      workflowId: request.workflowId,
      triggerId: request.triggerId,
      occurrenceId,
      decision,
      notificationId,
      duplicate: false,
    };
    this.automationEventNotices.set(noticeKey, receipt);
    return structuredClone(receipt);
  }

  async enqueueV3DigestNotice(
    workflowId: string,
    request: WorkflowV3DigestNoticeRequest,
  ): Promise<WorkflowOutboxReceipt> {
    validateWorkflowV3DigestNoticeRequest(workflowId, request);
    const workflow = this.workflowsV3.get(workflowId);
    if (workflow === undefined || !workflow.enabled) throw new WorkflowStoreHttpError(404, 'WORK_WORKFLOW_NOT_FOUND');
    const event = [...this.events.values()].find(item => item.workflowId === workflowId
      && item.triggerId === 'daily-digest' && item.scheduledAt === request.scheduledAt
      && item.taskId === request.taskId && item.status === 'succeeded');
    if (event === undefined) throw new WorkflowStoreHttpError(409, 'WORK_WORKFLOW_DIGEST_NOT_ACTIVE');
    const changed = [...this.automationEventNotices.values()].some(receipt => receipt.workflowId === workflowId
      && ['change', 'failure', 'recovery', 'blocker'].includes(receipt.decision));
    return this.enqueueNotification({
      deduplicationKey: `workflow:${workflowId}:digest:${request.occurrenceId}`,
      type: 'workflow.digest',
      payload: {
        workflowId,
        occurrenceId: request.occurrenceId,
        triggerId: request.triggerId,
        summary: changed ? 'Daily review includes changed source events.' : 'No material source changes since the previous digest.',
        taskId: request.taskId,
      },
    });
  }

  async enqueueNotification(request: WorkflowOutboxRequest): Promise<WorkflowOutboxReceipt> {
    validateWorkflowOutboxRequest(request);
    const existing = this.notifications.get(request.deduplicationKey);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(request)) throw new WorkflowStoreHttpError(409, 'WORKFLOW_NOTIFICATION_KEY_CONFLICT');
      return { notification: { ...structuredClone(existing), status: 'queued' }, duplicate: true };
    }
    this.notifications.set(request.deduplicationKey, structuredClone(request));
    return { notification: { ...structuredClone(request), status: 'queued' }, duplicate: false };
  }

  async enqueueTeamsNotification(workflowId: string, request: WorkflowTeamsNoticeRequest): Promise<WorkflowOutboxReceipt> {
    validateWorkflowTeamsNoticeRequest(workflowId, request);
    if (!this.workflowsV2.has(workflowId) && !this.workflowsV3.has(workflowId)) {
      throw new WorkflowStoreHttpError(404, 'WORK_WORKFLOW_NOT_FOUND');
    }
    const terminal = [...this.events.values()].find(event => event.workflowId === workflowId
      && event.triggerId === request.triggerId && event.scheduledAt === request.scheduledAt
      && (event.status === 'succeeded' || event.status === 'failed'));
    if (terminal === undefined || terminal.summary !== request.summary) throw new WorkflowStoreHttpError(409, 'WORK_WORKFLOW_NOTICE_NOT_TERMINAL');
    const deduplicationKey = workflowTeamsNoticeKey(workflowId, request.occurrenceId, request.kind);
    const projection = { workflowId, notice: structuredClone(request) };
    const existing = this.notifications.get(deduplicationKey);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(projection)) throw new WorkflowStoreHttpError(409, 'WORKFLOW_NOTIFICATION_KEY_CONFLICT');
      return { notification: { deduplicationKey, ...structuredClone(projection), status: 'queued' }, duplicate: true };
    }
    this.notifications.set(deduplicationKey, projection);
    return { notification: { deduplicationKey, ...structuredClone(projection), status: 'queued' }, duplicate: false };
  }

  /** Inspect test outbox state while preserving it across simulated host restarts. */
  listNotifications(): readonly (WorkflowOutboxRequest | { readonly workflowId: string; readonly notice: WorkflowTeamsNoticeRequest })[] {
    return [...this.notifications.values()].map(value => structuredClone(value));
  }

  async listScheduleEvents(options: { readonly workflowId: string; readonly limit?: number; readonly cursor?: string }): Promise<WorkflowScheduleEventPage> {
    const limit = options.limit ?? 100;
    const items = [...this.events.values()].filter(event => event.workflowId === options.workflowId)
      .sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt) || right.id.localeCompare(left.id));
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isSafeInteger(start) || start < 0) throw new WorkflowStoreHttpError(400, 'INVALID_CURSOR');
    return {
      items: structuredClone(items.slice(start, start + limit)),
      nextCursor: start + limit < items.length ? String(start + limit) : null,
    };
  }
}

/** Validate one write before crossing the authenticated API boundary. */
export function validateWorkflowWrite(value: WorkflowWrite | WorkflowV2Write | WorkflowV3Write): void {
  if (value.version === 3) {
    validateWorkflowV3Write(value);
    return;
  }
  if (value.version === 2) {
    validateWorkflowV2Write(value);
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value.id)) throw new TypeError('Invalid workflow id');
  if (value.version !== 1 || !value.title.trim() || !value.description.trim() || !value.instructions.trim()) {
    throw new TypeError('Workflow version, title, description, and instructions are required');
  }
  if (typeof value.enabled !== 'boolean' || value.notifications.quietWhenUnchanged !== true) throw new TypeError('Invalid workflow policy');
  if (value.targets.some(target => !target.id.trim() || !target.label.trim() || !target.kind.trim())) throw new TypeError('Invalid workflow target');
  for (const target of value.targets) {
    if (target.uri !== undefined) {
      const uri = new URL(target.uri);
      if (uri.username || uri.password || uri.search || uri.hash) throw new TypeError('Workflow target URI cannot contain credentials or query values');
      if (uri.protocol !== 'https:' && !(uri.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname))) {
        throw new TypeError('Workflow target URI must use HTTPS; HTTP is limited to loopback');
      }
    }
  }
  if (value.schedule !== undefined) {
    if (value.schedule.kind !== 'cron' || !value.schedule.expression.trim() || !value.schedule.timeZone.trim()) {
      throw new TypeError('Invalid workflow cron schedule');
    }
    new Intl.DateTimeFormat('en-US', { timeZone: value.schedule.timeZone });
  }
}

/** Validate a complete proactive responsibility before it crosses the authenticated Work API. */
function validateWorkflowV2Write(value: WorkflowV2Write): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value.id) || value.version !== 2
    || !value.title.trim() || !value.goal.trim() || !value.instructions.trim()
    || typeof value.enabled !== 'boolean') throw new TypeError('Invalid workflow v2 identity or goal');
  const targetIds = new Set<string>();
  const targets = new Map(value.targets.map(target => [target.id, target]));
  if (value.targets.length > 100) throw new TypeError('Too many workflow v2 targets');
  for (const target of value.targets) {
    if (targetIds.has(target.id) || !target.id.trim() || !target.label.trim() || !target.kind.trim()) {
      throw new TypeError('Workflow v2 target ids must be unique and complete');
    }
    targetIds.add(target.id);
    if (target.kind === 'github_repository') {
      if (!/^\d+$/.test(target.id) || !/^[^/\s]+\/[^/\s]+$/.test(target.label)
        || !target.bindingId?.trim()
        || target.uri !== `https://github.com/${target.label}`) {
        throw new TypeError('GitHub workflow targets need repository id, owner/repo label, connector binding, and matching HTTPS URL');
      }
    }
    if (target.uri !== undefined) {
      const uri = new URL(target.uri);
      if (uri.username || uri.password || uri.search || uri.hash || uri.protocol !== 'https:') {
        throw new TypeError('Workflow v2 target URLs must use HTTPS without credentials or query values');
      }
    }
  }

  const triggerIds = new Set<string>();
  if (value.triggers.length < 1 || value.triggers.length > 100) throw new TypeError('Workflow v2 requires a bounded trigger list');
  for (const trigger of value.triggers) {
    if (triggerIds.has(trigger.id) || !trigger.id.trim() || trigger.initialBaseline !== 'record_without_notification') {
      throw new TypeError('Workflow v2 trigger id or initial baseline policy is invalid');
    }
    triggerIds.add(trigger.id);
    validateSchedule(trigger.schedule);
    if (trigger.targetIds.some(id => !targetIds.has(id)) || new Set(trigger.targetIds).size !== trigger.targetIds.length) {
      throw new TypeError('Workflow v2 trigger targets must reference configured targets');
    }
    if (trigger.kind === 'github_incremental_poll'
      && (trigger.targetIds.length === 0 || trigger.targetIds.some(id => targets.get(id)?.kind !== 'github_repository'))) {
      throw new TypeError('GitHub incremental polls require configured GitHub repository targets');
    }
    if (trigger.kind === 'github_incremental_poll') {
      const search = trigger.search;
      if (search === undefined || !['open', 'closed', 'all'].includes(search.state)
        || !Number.isSafeInteger(search.limit) || search.limit < 1 || search.limit > 50
        || search.labels.length > 10 || new Set(search.labels).size !== search.labels.length
        || search.labels.some(label => !label.trim())
        || (search.query !== undefined && (search.query.length > 256
          || /(?:^|\s)(?:repo|is|label|state|updated|author|assignee|milestone):/iu.test(search.query)))) {
        throw new TypeError('GitHub incremental search filters are invalid or contain unsupported qualifiers');
      }
    } else if (trigger.search !== undefined) {
      throw new TypeError('Only GitHub poll triggers can define issue search filters');
    }
  }

  const grantIds = new Set<string>();
  const actionOperations: Readonly<Record<WorkflowAction, ReadonlySet<WorkflowOperation>>> = {
    draft_pull_request: new Set([
      'github.branch.create', 'github.branch.delete', 'github.file.commit', 'github.pull_request.draft.create',
    ]),
    rerun_source_ci: new Set(['github.actions.rerun_failed']),
    update_issue_progress: new Set(['github.issue.comment.create', 'github.issue.state.update']),
  };
  for (const grant of value.actionPolicy.allowedActions) {
    if (grantIds.has(grant.id) || !grant.id.trim() || grant.targetIds.length === 0
      || new Set(grant.targetIds).size !== grant.targetIds.length
      || grant.targetIds.some(id => targets.get(id)?.kind !== 'github_repository')) {
      throw new TypeError('Workflow action grant must have unique ids and bind configured GitHub targets');
    }
    grantIds.add(grant.id);
    if (grant.permittedOperations.length === 0 || new Set(grant.permittedOperations).size !== grant.permittedOperations.length
      || grant.permittedOperations.some(operation => !actionOperations[grant.action].has(operation))) {
      throw new TypeError('Workflow action grant contains an operation outside its typed action');
    }
    if (grant.action === 'draft_pull_request') {
      if (!grant.permittedOperations.includes('github.branch.create')
        || !grant.permittedOperations.includes('github.file.commit')
        || !grant.permittedOperations.includes('github.pull_request.draft.create')
        || grant.baseBranches.length === 0 || grant.branchPrefixes.length === 0 || grant.pathPrefixes.length === 0
        || grant.branchPrefixes.some(prefix => !isAssistantBranchPrefix(prefix))
        || grant.issueNumbers.length > 0 || grant.sourceWorkflowIds.length > 0) {
        throw new TypeError('Draft PR grant requires exact branch, base, path, and operation scopes');
      }
    } else if (grant.action === 'rerun_source_ci') {
      if (grant.permittedOperations.length !== 1 || grant.baseBranches.length > 0 || grant.pathPrefixes.length > 0
        || grant.issueNumbers.length > 0 || grant.branchPrefixes.length === 0 || grant.sourceWorkflowIds.length === 0
        || grant.branchPrefixes.some(prefix => !isAssistantBranchPrefix(prefix))
        || grant.sourceWorkflowIds.some(id => !/^[1-9][0-9]{0,19}$/.test(id))) {
        throw new TypeError('CI rerun grant must bind allowed source workflows and assistant branches');
      }
    } else if (grant.issueNumbers.length === 0 || grant.issueNumbers.some(number => !Number.isSafeInteger(number) || number < 1)
      || grant.baseBranches.length > 0 || grant.branchPrefixes.length > 0 || grant.pathPrefixes.length > 0
      || grant.sourceWorkflowIds.length > 0) {
      throw new TypeError('Issue progress grant requires explicit issue numbers');
    }
    for (const field of [grant.baseBranches, grant.branchPrefixes, grant.pathPrefixes]) {
      if (new Set(field).size !== field.length || field.some(item => !item.trim())) throw new TypeError('Workflow scope lists must be unique and non-empty');
    }
    if (grant.pathPrefixes.some(path => path !== '**'
      && (path.startsWith('/') || path.includes('\\') || path.includes('*') || path.split('/').includes('..')))) {
      throw new TypeError('Workflow path prefixes must be literal repository-relative prefixes or the exact ** sentinel');
    }
    if (new Set(grant.sourceWorkflowIds).size !== grant.sourceWorkflowIds.length) {
      throw new TypeError('Workflow source workflow ids must be unique');
    }
  }
  if (!value.actionPolicy.separateChildTask || value.actionPolicy.productionChanges !== 'forbidden'
    || value.actionPolicy.requiresUserAuthorization.join(',') !== 'merge,release,production,new_spend') {
    throw new TypeError('Workflow action policy must use separate child tasks and protect production actions');
  }
  if (!['antigravity', 'codebuddy', 'exchange'].includes(value.modelPolicy.preferredProvider)
    || !value.modelPolicy.preferredModel.trim()
    || value.modelPolicy.fallback !== 'configured_no_additional_spend') {
    throw new TypeError('Workflow model policy is invalid');
  }
  if (value.authorization.kind !== 'teams_thread' || !value.authorization.threadBindingId.trim()
    || !value.authorization.ownerTaskId.trim()) throw new TypeError('Workflow authorization must bind an owner Teams thread and source task');
  if (value.notifications.quietWhenUnchanged !== true || value.notifications.digest.maxPerDay !== 1
    || value.notifications.destination.kind !== 'responsibility_thread') {
    throw new TypeError('Workflow notification policy is invalid');
  }
  for (const time of [value.notifications.quietHours.start, value.notifications.quietHours.end]) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new TypeError('Quiet hours must use HH:MM');
  }
  validateTimeZone(value.notifications.quietHours.timeZone);
  if (value.notifications.quietHours.start !== '22:00' || value.notifications.quietHours.end !== '08:00'
    || value.notifications.quietHours.timeZone !== 'America/New_York') {
    throw new TypeError('Workflow v3 quiet hours are fixed to 22:00–08:00 America/New_York');
  }
  validateSchedule(value.notifications.digest.schedule);
  const allowedImmediate = new Set(['blocked_goal', 'user_decision', 'service_or_auth_outage']);
  if (new Set(value.notifications.immediateOn).size !== value.notifications.immediateOn.length
    || value.notifications.immediateOn.some(item => !allowedImmediate.has(item))) {
    throw new TypeError('Workflow immediate notification policy is invalid');
  }
}

/** Validate the deterministic source-poll contract without reinterpreting v1/v2 fields. */
function validateWorkflowV3Write(value: WorkflowV3Write): void {
  const allowedFields = new Set([
    'id', 'version', 'title', 'description', 'targets', 'triggers', 'authorization', 'notifications', 'enabled',
  ]);
  if (Object.keys(value as unknown as Record<string, unknown>).some(key => !allowedFields.has(key))) {
    throw new TypeError('Workflow v3 contains unsupported fields');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(value.id) || value.version !== 3
    || !value.title.trim() || !value.description.trim() || typeof value.enabled !== 'boolean') {
    throw new TypeError('Invalid workflow v3 identity or description');
  }
  if (value.targets.length < 1 || value.targets.length > 100) throw new TypeError('Workflow v3 requires bounded targets');
  const targets = new Map<string, WorkflowTarget>();
  for (const target of value.targets) {
    if (!target.id.trim() || !target.label.trim() || !target.kind.trim() || targets.has(target.id)) {
      throw new TypeError('Workflow v3 target ids must be unique and complete');
    }
    if (!target.bindingId?.trim()) throw new TypeError('Workflow v3 targets must be bound to an activated source');
    if (target.kind === 'github_repository') {
      if (!/^[1-9]\d{0,18}$/u.test(target.id) || !/^[^/\s]+\/[^/\s]+$/u.test(target.label)
        || target.uri !== `https://github.com/${target.label}`) {
        throw new TypeError('GitHub source targets require a canonical repository identity');
      }
    } else if (target.uri !== undefined) {
      throw new TypeError('Non-GitHub source targets cannot configure a URL');
    }
    if (target.uri !== undefined) {
      const uri = new URL(target.uri);
      if (uri.protocol !== 'https:' || uri.username || uri.password || uri.search || uri.hash) {
        throw new TypeError('Workflow v3 target URLs must be canonical HTTPS without credentials or query values');
      }
    }
    targets.set(target.id, target);
  }

  if (value.triggers.length < 1 || value.triggers.length > 100) throw new TypeError('Workflow v3 requires a bounded trigger list');
  const triggerIds = new Set<string>();
  for (const trigger of value.triggers) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(trigger.id) || triggerIds.has(trigger.id)
      || trigger.kind !== 'source_poll' || trigger.initialBaseline !== 'record_without_notification') {
      throw new TypeError('Invalid workflow v3 source trigger identity or baseline policy');
    }
    triggerIds.add(trigger.id);
    validateSchedule(trigger.schedule);
    const expectedExpression = trigger.source === 'github' || trigger.source === 'azure_devops' || trigger.source === 'office_graph'
      ? '*/5 * * * *' : '* * * * *';
    if (trigger.schedule.expression !== expectedExpression || trigger.schedule.timeZone !== 'UTC') {
      throw new TypeError('Workflow v3 source cadence is fixed by source type');
    }
    if (!Number.isSafeInteger(trigger.pageSize) || trigger.pageSize < 1 || trigger.pageSize > 50
      || !Number.isSafeInteger(trigger.maxPages) || trigger.maxPages < 1 || trigger.maxPages > 20) {
      throw new TypeError('Workflow v3 source bounds exceed the supported page budget');
    }
    if (trigger.pageSize * trigger.maxPages > 1_000) throw new TypeError('Workflow v3 page budget exceeds 1,000 records');
    if (trigger.targetIds.length < 1 || trigger.targetIds.length > 20
      || new Set(trigger.targetIds).size !== trigger.targetIds.length
      || trigger.targetIds.some(targetId => {
        const target = targets.get(targetId);
        return target === undefined || !isTargetKindForSource(trigger.source, target.kind);
      })) throw new TypeError('Workflow v3 trigger targets must match its source kind');
  }

  if (value.authorization.ownerTaskId.trim().length === 0) throw new TypeError('Workflow v3 requires a verified owner task');
  if (value.authorization.kind === 'teams_thread') {
    if (!/^[a-f0-9]{64}$/u.test(value.authorization.threadBindingId)) {
      throw new TypeError('Workflow v3 channel authorization requires an opaque thread binding');
    }
    if (value.notifications.destination.kind !== 'responsibility_thread') {
      throw new TypeError('Workflow v3 channel authorization requires a channel destination');
    }
  } else if (value.authorization.kind === 'owner_private') {
    if (value.notifications.destination.kind !== 'owner_private') {
      throw new TypeError('Workflow v3 private authorization requires a private destination');
    }
  } else {
    throw new TypeError('Invalid workflow v3 authorization kind');
  }
  if (value.notifications.quietWhenUnchanged !== true || value.notifications.digest.maxPerDay !== 1
    || value.notifications.destination.kind !== 'responsibility_thread'
      && value.notifications.destination.kind !== 'owner_private') {
    throw new TypeError('Workflow v3 notification policy is invalid');
  }
  for (const time of [value.notifications.quietHours.start, value.notifications.quietHours.end]) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)) throw new TypeError('Quiet hours must use HH:MM');
  }
  validateTimeZone(value.notifications.quietHours.timeZone);
  validateSchedule(value.notifications.digest.schedule);
  if (value.notifications.digest.schedule.expression !== '0 9 * * 1-5'
    || value.notifications.digest.schedule.timeZone !== 'America/New_York') {
    throw new TypeError('Workflow v3 digest cadence is fixed to weekday 09:00 America/New_York');
  }
  const allowedImmediate = new Set(['blocked_goal', 'user_decision', 'service_or_auth_outage']);
  if (new Set(value.notifications.immediateOn).size !== value.notifications.immediateOn.length
    || value.notifications.immediateOn.some(item => !allowedImmediate.has(item))) {
    throw new TypeError('Workflow v3 immediate notification policy is invalid');
  }
}

function isTargetKindForSource(source: WorkflowObservationSource, kind: string): boolean {
  switch (source) {
    case 'github': return kind === 'github_repository';
    case 'azure_devops': return kind === 'pipeline_runs' || kind === 'release_deployments';
    case 'vm_health': return kind === 'host_health';
    case 'training': return kind === 'training_run';
    case 'product': return kind === 'product_resource';
    case 'office_graph': return kind === 'planner_plan';
  }
}

function validateSchedule(schedule: WorkflowSchedule): void {
  if (schedule.kind !== 'cron' || !schedule.expression.trim() || !schedule.timeZone.trim()) {
    throw new TypeError('Invalid workflow cron schedule');
  }
  validateTimeZone(schedule.timeZone);
}

function validateTimeZone(timeZone: string): void {
  new Intl.DateTimeFormat('en-US', { timeZone });
}

function isAssistantBranchPrefix(prefix: string): boolean {
  return prefix.startsWith('cyrene/assistant/')
    && !prefix.includes('\\')
    && !/\s/u.test(prefix)
    && !prefix.split('/').includes('..');
}

/** Validate one event before persisting it as an immutable receipt. */
export function validateScheduleEvent(event: WorkflowScheduleEvent): void {
  if (!event.id.trim() || !event.workflowId.trim()) throw new TypeError('Schedule event id and workflow id are required');
  for (const value of [event.createdAt, event.scheduledAt, event.startedAt, event.endedAt]) {
    if (value !== undefined && !Number.isFinite(Date.parse(value))) throw new TypeError('Invalid schedule event timestamp');
  }
  if (!['queued', 'running', 'succeeded', 'failed'].includes(event.status)) throw new TypeError('Invalid schedule event status');
  if (event.summary !== undefined && event.summary.length > 512) throw new TypeError('Schedule event summary is too long');
  if (event.triggerId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(event.triggerId)) {
    throw new TypeError('Invalid workflow trigger id');
  }
  if (event.evidence !== undefined) decodeWorkflowEvidence(event.evidence);
  if (event.operationIds !== undefined) decodeTextArray(event.operationIds, 'event.operationIds');
  if (event.actionTaskIds !== undefined) decodeTextArray(event.actionTaskIds, 'event.actionTaskIds');
  if (event.actionResults !== undefined) decodeActionReceipts(event.actionResults);
  if (event.checkpoint !== undefined) decodeWorkflowCheckpoint(event.checkpoint);
  if (event.attentionKind !== undefined) decodeAttentionKind(event.attentionKind);
}

/** Validate one fixed-adapter event before storing it through the actor-scoped Work API. */
export function validateWorkflowAutomationEvent(event: WorkflowAutomationEventWrite): void {
  const allowed = new Set([
    'source', 'sourceEventId', 'resourceUri', 'sourceVersion', 'eventType', 'occurredAt', 'title', 'summary',
    'severity', 'correlationId', 'experimentId', 'metadataReferences', 'semanticFingerprint', 'stateClass',
  ]);
  if (Object.keys(event as unknown as Record<string, unknown>).some(key => !allowed.has(key))) {
    throw new TypeError('Automation event contains server-owned or unsupported fields');
  }
  if (!isWorkflowObservationSource(event.source)) throw new TypeError('Unsupported automation event source');
  boundedEventText(event.sourceEventId, 'sourceEventId', 512);
  boundedEventText(event.eventType, 'eventType', 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(event.eventType)) throw new TypeError('Invalid automation event type');
  validateSafeResourceUri(event.resourceUri, 'resourceUri');
  if (typeof event.sourceVersion === 'number') {
    if (!Number.isSafeInteger(event.sourceVersion) || event.sourceVersion < 0) throw new TypeError('Invalid automation sourceVersion');
  } else boundedEventText(event.sourceVersion, 'sourceVersion', 512);
  if (!Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0) throw new TypeError('Invalid automation occurredAt');
  if (event.title !== undefined) boundedEventText(event.title, 'title', 512, true);
  if (event.summary !== undefined) boundedEventText(event.summary, 'summary', 2_000, true);
  if (event.severity !== undefined && !['info', 'warning', 'critical'].includes(event.severity)) {
    throw new TypeError('Invalid automation event severity');
  }
  if (event.correlationId !== undefined) boundedEventText(event.correlationId, 'correlationId', 128);
  if (event.experimentId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(event.experimentId)) {
    throw new TypeError('Invalid automation experimentId');
  }
  if (event.metadataReferences !== undefined) decodeWorkflowMetadataReferences(event.metadataReferences);
  if (event.semanticFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(event.semanticFingerprint)) {
    throw new TypeError('Invalid automation semanticFingerprint');
  }
  if (event.stateClass !== undefined && !['healthy', 'incident', 'neutral'].includes(event.stateClass)) {
    throw new TypeError('Invalid automation stateClass');
  }
}

export function validateWorkflowAutomationEventNoticeRequest(
  request: WorkflowAutomationEventNoticeRequest,
): void {
  const allowed = new Set(['eventId', 'workflowId', 'triggerId', 'occurrenceId', 'scheduledAt', 'taskId']);
  if (Object.keys(request as unknown as Record<string, unknown>).some(key => !allowed.has(key))) {
    throw new TypeError('Automation event notice cannot contain routing or summary fields');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(request.eventId)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(request.workflowId)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.triggerId)
    || !/^occ-[a-f0-9]{40}$/u.test(request.occurrenceId)
    || !Number.isFinite(Date.parse(request.scheduledAt))
    || request.taskId !== `workflow-${request.occurrenceId.slice(4)}`) {
    throw new TypeError('Invalid automation event notice identity');
  }
}

export function validateWorkflowV3DigestNoticeRequest(
  workflowId: string,
  request: WorkflowV3DigestNoticeRequest,
): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(workflowId)
    || request.triggerId !== 'daily-digest'
    || !/^occ-[a-f0-9]{40}$/u.test(request.occurrenceId)
    || !Number.isFinite(Date.parse(request.scheduledAt))
    || request.taskId !== `workflow-${request.occurrenceId.slice(4)}`) {
    throw new TypeError('Invalid v3 digest notice identity');
  }
}

function decodeWorkflowAutomationEvent(value: unknown): WorkflowAutomationEvent {
  const row = object(value, 'Automation event');
  if (!isWorkflowObservationSource(row.source)) throw new TypeError('Invalid automation event source');
  if (row.visibility !== 'owner') throw new TypeError('Automation event visibility must be owner-only');
  const event: WorkflowAutomationEvent = {
    source: row.source,
    sourceEventId: boundedEventText(row.sourceEventId, 'sourceEventId', 512),
    resourceUri: validateSafeResourceUri(row.resourceUri, 'resourceUri'),
    sourceVersion: decodeSourceVersion(row.sourceVersion),
    eventType: boundedEventText(row.eventType, 'eventType', 256),
    occurredAt: eventTimestamp(row.occurredAt, 'occurredAt'),
    ...(row.title === undefined ? {} : { title: boundedEventText(row.title, 'title', 512, true) }),
    ...(row.summary === undefined ? {} : { summary: boundedEventText(row.summary, 'summary', 2_000, true) }),
    ...(row.severity === undefined ? {} : { severity: decodeEventSeverity(row.severity) }),
    ...(row.correlationId === undefined ? {} : { correlationId: boundedEventText(row.correlationId, 'correlationId', 128) }),
    ...(row.experimentId === undefined ? {} : { experimentId: boundedEventText(row.experimentId, 'experimentId', 36) }),
    ...(row.metadataReferences === undefined ? {} : { metadataReferences: decodeWorkflowMetadataReferences(row.metadataReferences) }),
    ...(row.semanticFingerprint === undefined ? {} : { semanticFingerprint: boundedEventText(row.semanticFingerprint, 'semanticFingerprint', 64) }),
    ...(row.stateClass === undefined ? {} : { stateClass: decodeWorkflowStateClass(row.stateClass) }),
    id: boundedEventText(row.id, 'event.id', 512),
    observedAt: eventTimestamp(row.observedAt, 'observedAt'),
    actorId: boundedEventText(row.actorId, 'actorId', 256),
    organizationId: boundedEventText(row.organizationId, 'organizationId', 256),
    workspaceId: boundedEventText(row.workspaceId, 'workspaceId', 256),
    revision: eventCount(row.revision, 'revision'),
    visibility: 'owner',
  };
  validateWorkflowAutomationEvent({
    source: event.source,
    sourceEventId: event.sourceEventId,
    resourceUri: event.resourceUri,
    sourceVersion: event.sourceVersion,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    ...(event.title === undefined ? {} : { title: event.title }),
    ...(event.summary === undefined ? {} : { summary: event.summary }),
    ...(event.severity === undefined ? {} : { severity: event.severity }),
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    ...(event.experimentId === undefined ? {} : { experimentId: event.experimentId }),
    ...(event.metadataReferences === undefined ? {} : { metadataReferences: event.metadataReferences }),
    ...(event.semanticFingerprint === undefined ? {} : { semanticFingerprint: event.semanticFingerprint }),
    ...(event.stateClass === undefined ? {} : { stateClass: event.stateClass }),
  });
  return event;
}

function decodeWorkflowMetadataReferences(value: unknown): readonly WorkflowMetadataReference[] {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError('Invalid automation metadata references');
  return value.map(item => {
    const row = object(item, 'Automation metadata reference');
    const reference: WorkflowMetadataReference = {
      kind: boundedEventText(row.kind, 'metadataReference.kind', 128),
      resourceUri: validateSafeResourceUri(row.resourceUri, 'metadataReference.resourceUri'),
      ...(row.resourceVersion === undefined ? {} : { resourceVersion: decodeSourceVersion(row.resourceVersion) }),
    };
    return reference;
  });
}

function decodeSourceVersion(value: unknown): number | string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid automation resource version');
    return value;
  }
  return boundedEventText(value, 'resourceVersion', 512);
}

function decodeEventSeverity(value: unknown): NonNullable<WorkflowAutomationEvent['severity']> {
  if (value !== 'info' && value !== 'warning' && value !== 'critical') throw new TypeError('Invalid automation event severity');
  return value;
}

function decodeWorkflowStateClass(value: unknown): NonNullable<WorkflowAutomationEvent['stateClass']> {
  if (value !== 'healthy' && value !== 'incident' && value !== 'neutral') throw new TypeError('Invalid automation stateClass');
  return value;
}

function eventTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid automation ${label}`);
  return value;
}

function eventCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid automation ${label}`);
  return value;
}

function boundedEventText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.trim().length === 0)
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`Invalid automation ${label}`);
  return value;
}

function validateSafeResourceUri(value: unknown, label: string): string {
  const textValue = boundedEventText(value, label, 2_000);
  let uri: URL;
  try { uri = new URL(textValue); } catch { throw new TypeError(`Invalid automation ${label}`); }
  const scheme = uri.protocol.slice(0, -1).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]{0,31}$/u.test(scheme)
    || ['data', 'file', 'javascript', 'vbscript'].includes(scheme)
    || uri.username || uri.password || uri.search || uri.hash
    || (scheme === 'http' || scheme === 'https') && !uri.hostname
    || scheme !== 'http' && scheme !== 'https' && !uri.host && !uri.pathname) {
    throw new TypeError(`Automation ${label} must be an absolute safe URI without credentials, query, or fragment`);
  }
  return textValue;
}

function canonicalEventJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function digestAutomationEventKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function inferWorkflowEventState(event: WorkflowAutomationEvent): WorkflowSourceState['state'] {
  const type = event.eventType.toLowerCase();
  if (event.severity === 'critical' || event.severity === 'warning'
    || /(?:fail|error|unhealthy|incident|blocked|denied|outage)/u.test(type)) return 'incident';
  if (/(?:healthy|success|succeed|complete|ready|recovered)/u.test(type)) return 'healthy';
  return 'neutral';
}

function isWorkflowQuietTime(timestamp: string, quietHours: WorkflowV3Notifications['quietHours']): boolean {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: quietHours.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  const minute = Number(parts.find(part => part.type === 'minute')?.value);
  const [startHour, startMinute] = quietHours.start.split(':').map(Number);
  const [endHour, endMinute] = quietHours.end.split(':').map(Number);
  const current = hour * 60 + minute;
  const start = startHour! * 60 + startMinute!;
  const end = endHour! * 60 + endMinute!;
  return start > end ? current >= start || current < end : current >= start && current < end;
}

function redactAutomationSummary(value: string): string {
  return value.replace(/\b(authorization|api[_ -]?key|password|secret|token)\b\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .replace(/\s+/gu, ' ').trim().slice(0, 400);
}

/** Validate the deliberately small safe workflow outbox contract. */
export function validateWorkflowOutboxRequest(request: WorkflowOutboxRequest): void {
  if (Object.keys(request as unknown as Record<string, unknown>).some(key => !['deduplicationKey', 'type', 'payload'].includes(key))) {
    throw new TypeError('Workflow notifications cannot include routing or task authority fields');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(request.deduplicationKey)) throw new TypeError('Invalid workflow notification deduplication key');
  if (!['workflow.change', 'workflow.failure', 'workflow.recovery', 'workflow.digest', 'workflow.blocker'].includes(request.type)) throw new TypeError('Invalid workflow notification type');
  const payload = request.payload;
  if (Object.keys(payload as unknown as Record<string, unknown>).some(key => !['workflowId', 'occurrenceId', 'triggerId', 'summary', 'taskId'].includes(key))) {
    throw new TypeError('Workflow notification payload contains unsupported fields');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(payload.workflowId)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(payload.occurrenceId)
    || !payload.summary.trim() || payload.summary.length > 400
    || (payload.triggerId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(payload.triggerId))
    || (payload.taskId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(payload.taskId))) {
    throw new TypeError('Invalid workflow notification payload');
  }
}

/** Validate the route-free v2 notice request accepted by the dedicated projection endpoint. */
export function validateWorkflowTeamsNoticeRequest(
  workflowId: string,
  request: WorkflowTeamsNoticeRequest,
): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(workflowId)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(request.occurrenceId)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.triggerId)
    || !Number.isFinite(Date.parse(request.scheduledAt))) throw new TypeError('Invalid workflow notice identity');
  if (!['change', 'failure', 'recovery', 'digest', 'blocker'].includes(request.kind)
    || !request.summary.trim() || request.summary.length > 400 || request.summary.includes('\u0000')) {
    throw new TypeError('Invalid workflow notice content');
  }
  const expected = workflowOccurrenceId(workflowId, request.triggerId, request.scheduledAt);
  if (request.occurrenceId !== expected) throw new TypeError('Workflow notice occurrence id does not match its schedule identity');
  if (request.kind === 'blocker') {
    if (request.attentionKind === undefined) throw new TypeError('Blocker notices require an attentionKind');
    decodeAttentionKind(request.attentionKind);
  } else if (request.attentionKind !== undefined) {
    throw new TypeError('attentionKind is only valid for blocker notices');
  }
}

export function workflowTeamsNoticeKey(workflowId: string, occurrenceId: string, kind: WorkflowTeamsNoticeRequest['kind']): string {
  return `workflow:${workflowId}:${occurrenceId}:${kind}`;
}

function workflowOccurrenceId(workflowId: string, triggerId: string, scheduledAt: string): string {
  return `occ-${createHash('sha256').update(`${workflowId}\0${triggerId}\0${scheduledAt}`).digest('hex').slice(0, 40)}`;
}

function decodeWorkflowDefinition(value: unknown, definitionVersion: 1 | 2 | 3): WorkflowDefinition {
  const row = object(value, 'Workflow record');
  if (row.version !== definitionVersion) throw new TypeError('Workflow record version does not match definitionVersion negotiation');
  return definitionVersion === 1 ? decodeWorkflow(value)
    : definitionVersion === 2 ? decodeWorkflowV2(value) : decodeWorkflowV3(value);
}

function decodeWorkflow(value: unknown): WorkflowRecord {
  const row = object(value, 'Workflow record');
  if (row.version !== 1) throw new TypeError('Unsupported workflow record version');
  if (!Array.isArray(row.targets)) throw new TypeError('Workflow targets are missing');
  const targets = row.targets.map((item) => {
    const target = object(item, 'Workflow target');
    return {
      id: text(target.id, 'target.id'), label: text(target.label, 'target.label'), kind: text(target.kind, 'target.kind'),
      ...(target.bindingId === undefined ? {} : { bindingId: text(target.bindingId, 'target.bindingId') }),
      ...(target.uri === undefined ? {} : { uri: text(target.uri, 'target.uri') }),
    };
  });
  const notifications = object(row.notifications, 'Workflow notifications');
  if (notifications.quietWhenUnchanged !== true || typeof notifications.onChange !== 'boolean'
    || typeof notifications.onFailure !== 'boolean' || typeof notifications.onRecovery !== 'boolean') {
    throw new TypeError('Invalid workflow notification policy');
  }
  const schedule = row.schedule === undefined ? undefined : decodeSchedule(row.schedule);
  const result: WorkflowRecord = {
    id: text(row.id, 'workflow.id'), version: 1, title: text(row.title, 'workflow.title'),
    description: text(row.description, 'workflow.description'), instructions: text(row.instructions, 'workflow.instructions'),
    targets, notifications: {
      onChange: notifications.onChange, onFailure: notifications.onFailure,
      onRecovery: notifications.onRecovery, quietWhenUnchanged: true,
    },
    enabled: bool(row.enabled, 'workflow.enabled'),
    ...(schedule === undefined ? {} : { schedule }),
    updatedAt: text(row.updatedAt, 'workflow.updatedAt'),
  };
  validateWorkflowWrite({
    id: result.id, version: result.version, title: result.title, description: result.description,
    instructions: result.instructions, targets: result.targets, notifications: result.notifications,
    enabled: result.enabled, ...(result.schedule === undefined ? {} : { schedule: result.schedule }),
  });
  return result;
}

function decodeWorkflowV2(value: unknown): WorkflowV2Record {
  const row = object(value, 'Workflow v2 record');
  if (row.version !== 2 || !Array.isArray(row.targets) || !Array.isArray(row.triggers)) {
    throw new TypeError('Invalid workflow v2 record');
  }
  const result = {
    id: text(row.id, 'workflow.id'),
    version: 2 as const,
    title: text(row.title, 'workflow.title'),
    description: text(row.description, 'workflow.description', true),
    goal: text(row.goal, 'workflow.goal'),
    instructions: text(row.instructions, 'workflow.instructions'),
    targets: row.targets.map(item => {
      const target = object(item, 'Workflow target');
      return {
        id: text(target.id, 'target.id'),
        label: text(target.label, 'target.label'),
        kind: text(target.kind, 'target.kind'),
        ...(target.bindingId === undefined ? {} : { bindingId: text(target.bindingId, 'target.bindingId') }),
        ...(target.uri === undefined ? {} : { uri: text(target.uri, 'target.uri') }),
      };
    }),
    triggers: row.triggers.map(item => {
      const trigger = object(item, 'Workflow trigger');
      if (trigger.kind !== 'github_incremental_poll' && trigger.kind !== 'review') {
        throw new TypeError('Invalid workflow trigger kind');
      }
      if (trigger.initialBaseline !== 'record_without_notification') throw new TypeError('Invalid workflow initial baseline policy');
      if (!Array.isArray(trigger.targetIds)) throw new TypeError('Invalid workflow trigger targets');
      let search: WorkflowV2Trigger['search'];
      if (trigger.search !== undefined) {
        const row = object(trigger.search, 'Workflow GitHub search filters');
        if (!Array.isArray(row.labels) || (row.state !== 'open' && row.state !== 'closed' && row.state !== 'all')
          || typeof row.limit !== 'number' || !Number.isSafeInteger(row.limit)) throw new TypeError('Invalid workflow GitHub search filters');
        search = {
          state: row.state,
          ...(row.query === undefined ? {} : { query: text(row.query, 'search.query') }),
          labels: row.labels.map(item => text(item, 'search.label')),
          limit: row.limit,
        };
      }
      return {
        id: text(trigger.id, 'trigger.id'),
        kind: trigger.kind,
        schedule: decodeSchedule(trigger.schedule),
        targetIds: trigger.targetIds.map(item => text(item, 'trigger.targetId')),
        initialBaseline: trigger.initialBaseline,
        ...(search === undefined ? {} : { search }),
      };
    }),
    actionPolicy: decodeActionPolicy(row.actionPolicy),
    modelPolicy: decodeModelPolicy(row.modelPolicy),
    authorization: decodeAuthorizationReference(row.authorization),
    notifications: decodeNotificationsV2(row.notifications),
    enabled: bool(row.enabled, 'workflow.enabled'),
    ...(row.updatedAt === undefined ? {} : { updatedAt: text(row.updatedAt, 'workflow.updatedAt') }),
  } satisfies WorkflowV2Record;
  validateWorkflowWrite({
    id: result.id,
    version: result.version,
    title: result.title,
    description: result.description,
    goal: result.goal,
    instructions: result.instructions,
    targets: result.targets,
    triggers: result.triggers,
    actionPolicy: result.actionPolicy,
    modelPolicy: result.modelPolicy,
    authorization: result.authorization,
    notifications: result.notifications,
    enabled: result.enabled,
  });
  return result;
}

function decodeWorkflowV3(value: unknown): WorkflowV3Record {
  const row = object(value, 'Workflow v3 record');
  if (row.version !== 3 || !Array.isArray(row.targets) || !Array.isArray(row.triggers)) {
    throw new TypeError('Invalid workflow v3 record');
  }
  const targets = row.targets.map(item => {
    const target = object(item, 'Workflow v3 target');
    return {
      id: text(target.id, 'target.id'),
      label: text(target.label, 'target.label'),
      kind: text(target.kind, 'target.kind'),
      ...(target.bindingId === undefined ? {} : { bindingId: text(target.bindingId, 'target.bindingId') }),
      ...(target.uri === undefined ? {} : { uri: text(target.uri, 'target.uri') }),
    };
  });
  const triggers = row.triggers.map(item => {
    const trigger = object(item, 'Workflow v3 trigger');
    if (trigger.kind !== 'source_poll' || !isWorkflowObservationSource(trigger.source)
      || trigger.initialBaseline !== 'record_without_notification' || !Array.isArray(trigger.targetIds)) {
      throw new TypeError('Invalid workflow v3 source trigger');
    }
    if (typeof trigger.pageSize !== 'number' || typeof trigger.maxPages !== 'number'
      || !Number.isSafeInteger(trigger.pageSize) || !Number.isSafeInteger(trigger.maxPages)) {
      throw new TypeError('Invalid workflow v3 page bounds');
    }
    return {
      id: text(trigger.id, 'trigger.id'),
      kind: 'source_poll' as const,
      source: trigger.source,
      schedule: decodeSchedule(trigger.schedule),
      targetIds: trigger.targetIds.map(targetId => text(targetId, 'trigger.targetId')),
      initialBaseline: 'record_without_notification' as const,
      pageSize: trigger.pageSize,
      maxPages: trigger.maxPages,
    };
  });
  const authorizationRow = object(row.authorization, 'Workflow v3 authorization');
  let authorization: WorkflowV3Authorization;
  if (authorizationRow.kind === 'teams_thread') {
    authorization = {
      kind: 'teams_thread',
      threadBindingId: text(authorizationRow.threadBindingId, 'authorization.threadBindingId'),
      ownerTaskId: text(authorizationRow.ownerTaskId, 'authorization.ownerTaskId'),
    };
  } else if (authorizationRow.kind === 'owner_private') {
    authorization = { kind: 'owner_private', ownerTaskId: text(authorizationRow.ownerTaskId, 'authorization.ownerTaskId') };
  } else {
    throw new TypeError('Invalid workflow v3 authorization kind');
  }
  const result: WorkflowV3Record = {
    id: text(row.id, 'workflow.id'),
    version: 3,
    title: text(row.title, 'workflow.title'),
    description: text(row.description, 'workflow.description'),
    targets,
    triggers,
    authorization,
    notifications: decodeNotificationsV3(row.notifications),
    enabled: bool(row.enabled, 'workflow.enabled'),
    ...(row.updatedAt === undefined ? {} : { updatedAt: text(row.updatedAt, 'workflow.updatedAt') }),
  };
  validateWorkflowWrite({
    id: result.id, version: result.version, title: result.title, description: result.description,
    targets: result.targets, triggers: result.triggers, authorization: result.authorization,
    notifications: result.notifications, enabled: result.enabled,
  });
  return result;
}

function decodeNotificationsV3(value: unknown): WorkflowV3Notifications {
  const row = object(value, 'Workflow v3 notification policy');
  if (row.quietWhenUnchanged !== true || !Array.isArray(row.immediateOn)) {
    throw new TypeError('Invalid workflow v3 notification policy');
  }
  const quietHours = object(row.quietHours, 'Workflow v3 quiet hours');
  const digest = object(row.digest, 'Workflow v3 digest policy');
  const destination = object(row.destination, 'Workflow v3 destination');
  if (destination.kind !== 'responsibility_thread' && destination.kind !== 'owner_private') {
    throw new TypeError('Invalid workflow v3 notification destination');
  }
  if (digest.maxPerDay !== 1 || typeof digest.enabled !== 'boolean') throw new TypeError('Invalid workflow v3 digest policy');
  return {
    onChange: bool(row.onChange, 'notifications.onChange'),
    onFailure: bool(row.onFailure, 'notifications.onFailure'),
    onRecovery: bool(row.onRecovery, 'notifications.onRecovery'),
    quietWhenUnchanged: true,
    quietHours: {
      start: text(quietHours.start, 'quietHours.start'),
      end: text(quietHours.end, 'quietHours.end'),
      timeZone: text(quietHours.timeZone, 'quietHours.timeZone'),
    },
    digest: { enabled: digest.enabled, schedule: decodeSchedule(digest.schedule), maxPerDay: 1 },
    destination: { kind: destination.kind },
    immediateOn: row.immediateOn.map(item => text(item, 'notifications.immediateOn') as WorkflowV3Notifications['immediateOn'][number]),
  };
}

function isWorkflowObservationSource(value: unknown): value is WorkflowObservationSource {
  return value === 'github' || value === 'azure_devops' || value === 'vm_health'
    || value === 'training' || value === 'product' || value === 'office_graph';
}

function decodeActionPolicy(value: unknown): WorkflowV2Record['actionPolicy'] {
  const row = object(value, 'Workflow action policy');
  if (!Array.isArray(row.allowedActions)) throw new TypeError('Workflow action grants are missing');
  const grants: WorkflowActionGrant[] = row.allowedActions.map(item => {
    const grant = object(item, 'Workflow action grant');
    const actions: WorkflowAction[] = ['draft_pull_request', 'rerun_source_ci', 'update_issue_progress'];
    if (!actions.includes(grant.action as WorkflowAction) || !Array.isArray(grant.targetIds)
      || !Array.isArray(grant.baseBranches) || !Array.isArray(grant.branchPrefixes)
      || !Array.isArray(grant.pathPrefixes) || !Array.isArray(grant.issueNumbers)
      || !Array.isArray(grant.sourceWorkflowIds)
      || !Array.isArray(grant.permittedOperations)) throw new TypeError('Invalid workflow action grant');
    const operations: WorkflowOperation[] = [
      'github.branch.create', 'github.branch.delete', 'github.file.commit',
      'github.pull_request.draft.create', 'github.actions.rerun_failed',
      'github.issue.comment.create', 'github.issue.state.update',
    ];
    const permittedOperations = grant.permittedOperations.map(item => {
      const operation = text(item, 'grant.permittedOperation');
      if (!operations.includes(operation as WorkflowOperation)) throw new TypeError('Invalid workflow operation id');
      return operation as WorkflowOperation;
    });
    return {
      id: text(grant.id, 'grant.id'),
      action: grant.action as WorkflowAction,
      targetIds: grant.targetIds.map(item => text(item, 'grant.targetId')),
      baseBranches: grant.baseBranches.map(item => text(item, 'grant.baseBranch')),
      branchPrefixes: grant.branchPrefixes.map(item => text(item, 'grant.branchPrefix')),
      pathPrefixes: grant.pathPrefixes.map(item => text(item, 'grant.pathPrefix')),
      issueNumbers: grant.issueNumbers.map(item => {
        if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1) throw new TypeError('Invalid workflow issue number');
        return item;
      }),
      sourceWorkflowIds: grant.sourceWorkflowIds.map(item => text(item, 'grant.sourceWorkflowId')),
      permittedOperations,
    };
  });
  const authorization = row.requiresUserAuthorization;
  if (!Array.isArray(authorization) || authorization.join(',') !== 'merge,release,production,new_spend') {
    throw new TypeError('Invalid workflow action authorization policy');
  }
  if (row.separateChildTask !== true || row.productionChanges !== 'forbidden') throw new TypeError('Invalid workflow action boundaries');
  return {
    allowedActions: grants,
    separateChildTask: true,
    productionChanges: 'forbidden',
    requiresUserAuthorization: ['merge', 'release', 'production', 'new_spend'],
  };
}

function decodeModelPolicy(value: unknown): WorkflowV2Record['modelPolicy'] {
  const row = object(value, 'Workflow model policy');
  if (row.preferredProvider !== 'antigravity' && row.preferredProvider !== 'codebuddy' && row.preferredProvider !== 'exchange') {
    throw new TypeError('Invalid workflow preferred provider');
  }
  if (row.fallback !== 'configured_no_additional_spend') throw new TypeError('Invalid workflow fallback policy');
  return {
    preferredProvider: row.preferredProvider,
    preferredModel: text(row.preferredModel, 'modelPolicy.preferredModel'),
    fallback: row.fallback,
  };
}

function decodeAuthorizationReference(value: unknown): WorkflowAuthorizationReference {
  const row = object(value, 'Workflow authorization');
  if (row.kind !== 'teams_thread') throw new TypeError('Invalid workflow authorization kind');
  return {
    kind: 'teams_thread',
    threadBindingId: text(row.threadBindingId, 'authorization.threadBindingId'),
    ownerTaskId: text(row.ownerTaskId, 'authorization.ownerTaskId'),
  };
}

function decodeNotificationsV2(value: unknown): WorkflowV2Notifications {
  const row = object(value, 'Workflow notifications');
  if (row.quietWhenUnchanged !== true || !Array.isArray(row.immediateOn)) throw new TypeError('Invalid workflow notification policy');
  const quietHours = object(row.quietHours, 'Workflow quiet hours');
  const digest = object(row.digest, 'Workflow digest policy');
  const destination = object(row.destination, 'Workflow notification destination');
  if (destination.kind !== 'responsibility_thread' || digest.maxPerDay !== 1 || typeof digest.enabled !== 'boolean') {
    throw new TypeError('Invalid workflow notification destination or digest');
  }
  return {
    onChange: bool(row.onChange, 'notifications.onChange'),
    onFailure: bool(row.onFailure, 'notifications.onFailure'),
    onRecovery: bool(row.onRecovery, 'notifications.onRecovery'),
    quietWhenUnchanged: true,
    quietHours: {
      start: text(quietHours.start, 'quietHours.start'),
      end: text(quietHours.end, 'quietHours.end'),
      timeZone: text(quietHours.timeZone, 'quietHours.timeZone'),
    },
    digest: { enabled: digest.enabled, schedule: decodeSchedule(digest.schedule), maxPerDay: 1 },
    destination: { kind: 'responsibility_thread' },
    immediateOn: row.immediateOn.map(item => text(item, 'notifications.immediateOn') as WorkflowV2Notifications['immediateOn'][number]),
  };
}

function decodeSchedule(value: unknown): WorkflowSchedule {
  const row = object(value, 'Workflow schedule');
  if (row.kind !== 'cron') throw new TypeError('Invalid workflow schedule kind');
  const schedule: WorkflowSchedule = {
    kind: 'cron', expression: text(row.expression, 'schedule.expression'), timeZone: text(row.timeZone, 'schedule.timeZone'),
  };
  new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone });
  return schedule;
}

function decodeScheduleEvent(value: unknown): WorkflowScheduleEvent {
  const row = object(value, 'Schedule event');
  const statuses: WorkflowScheduleEvent['status'][] = ['queued', 'running', 'succeeded', 'failed'];
  if (!statuses.includes(row.status as WorkflowScheduleEvent['status'])) throw new TypeError('Invalid schedule event status');
  const event: WorkflowScheduleEvent = {
    id: text(row.id, 'event.id'), workflowId: text(row.workflowId, 'event.workflowId'),
    scheduledAt: text(row.scheduledAt, 'event.scheduledAt'), status: row.status as WorkflowScheduleEvent['status'],
    createdAt: text(row.createdAt, 'event.createdAt'),
    ...(row.startedAt === undefined ? {} : { startedAt: text(row.startedAt, 'event.startedAt') }),
    ...(row.endedAt === undefined ? {} : { endedAt: text(row.endedAt, 'event.endedAt') }),
    ...(row.changed === undefined ? {} : { changed: bool(row.changed, 'event.changed') }),
    ...(row.summary === undefined ? {} : { summary: text(row.summary, 'event.summary', true) }),
    ...(row.errorCode === undefined ? {} : { errorCode: text(row.errorCode, 'event.errorCode') }),
    ...(row.taskId === undefined ? {} : { taskId: text(row.taskId, 'event.taskId') }),
    ...(row.sessionId === undefined ? {} : { sessionId: text(row.sessionId, 'event.sessionId') }),
    ...(row.triggerId === undefined ? {} : { triggerId: text(row.triggerId, 'event.triggerId') }),
    ...(row.baseline === undefined ? {} : { baseline: bool(row.baseline, 'event.baseline') }),
    evidence: decodeWorkflowEvidence(row.evidence ?? []),
    operationIds: decodeTextArray(row.operationIds ?? [], 'event.operationIds'),
    actionTaskIds: decodeTextArray(row.actionTaskIds ?? [], 'event.actionTaskIds'),
    actionResults: decodeActionReceipts(row.actionResults ?? []),
    ...(row.checkpoint === undefined ? {} : { checkpoint: decodeWorkflowCheckpoint(row.checkpoint) }),
    ...(row.attentionKind === undefined ? {} : { attentionKind: decodeAttentionKind(row.attentionKind) }),
  };
  validateScheduleEvent(event);
  return event;
}

function decodeActionReceipts(value: unknown): readonly WorkflowActionReceipt[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError('Invalid workflow action results');
  return value.map(item => {
    const row = object(item, 'Workflow action result');
    const actionType = row.actionType;
    if (actionType !== 'draft_pull_request' && actionType !== 'rerun_source_ci' && actionType !== 'update_issue_progress') {
      throw new TypeError('Invalid workflow action type');
    }
    const status = row.status;
    if (status !== 'completed' && status !== 'failed' && status !== 'waiting' && status !== 'unknown' && status !== 'skipped') {
      throw new TypeError('Invalid workflow action result status');
    }
    const requestDigest = text(row.requestDigest, 'actionResult.requestDigest');
    if (!/^[a-f0-9]{64}$/.test(requestDigest)) throw new TypeError('Invalid workflow action request digest');
    return {
      actionId: text(row.actionId, 'actionResult.actionId'),
      actionType,
      targetId: text(row.targetId, 'actionResult.targetId'),
      taskId: text(row.taskId, 'actionResult.taskId'),
      requestDigest,
      status,
      operationIds: decodeTextArray(row.operationIds, 'actionResult.operationIds'),
    };
  });
}

function decodeWorkflowEvidence(value: unknown): readonly WorkflowEvidence[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new TypeError('Invalid workflow evidence list');
  return value.map(item => {
    const row = object(item, 'Workflow evidence');
    const resultDigest = text(row.resultDigest, 'evidence.resultDigest');
    if (!/^[a-f0-9]{64}$/.test(resultDigest)) throw new TypeError('Invalid workflow evidence digest');
    return {
      targetId: text(row.targetId, 'evidence.targetId'),
      tool: text(row.tool, 'evidence.tool'),
      observedAt: text(row.observedAt, 'evidence.observedAt'),
      resultDigest,
    };
  });
}

function decodeTextArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError(`Invalid ${label}`);
  return value.map(item => text(item, label));
}

function decodeWorkflowCheckpoint(value: unknown): WorkflowEventCheckpoint {
  const row = object(value, 'Workflow checkpoint');
  if (row.kind === 'source_poll') return decodeWorkflowSourceCheckpoint(row);
  return decodeWorkflowGitHubCheckpoint(row);
}

function decodeWorkflowGitHubCheckpoint(value: unknown): WorkflowCheckpoint {
  const row = object(value, 'Workflow checkpoint');
  if (row.kind !== 'github_issues_search' || typeof row.complete !== 'boolean' || !Array.isArray(row.repositories)) {
    throw new TypeError('Invalid workflow checkpoint');
  }
  const windowEnd = text(row.windowEnd, 'checkpoint.windowEnd');
  if (!Number.isFinite(Date.parse(windowEnd))) throw new TypeError('Invalid workflow checkpoint windowEnd');
  const watermark = row.watermark === null ? null : text(row.watermark, 'checkpoint.watermark');
  if (watermark !== null && !Number.isFinite(Date.parse(watermark))) throw new TypeError('Invalid workflow checkpoint watermark');
  const repositories: WorkflowRepositoryCursor[] = row.repositories.map(item => {
    const cursor = object(item, 'Workflow repository cursor');
    const pageCursor = text(cursor.pageCursor, 'repositoryCursor.pageCursor');
    if (!/^\d+$/.test(pageCursor) || Number(pageCursor) < 1 || Number(pageCursor) > 1000) {
      throw new TypeError('Invalid workflow repository page cursor');
    }
    const queryDigest = text(cursor.queryDigest, 'repositoryCursor.queryDigest');
    if (!/^[a-f0-9]{64}$/.test(queryDigest)) throw new TypeError('Invalid workflow repository query digest');
    if (!Number.isSafeInteger(cursor.pagesCollected) || Number(cursor.pagesCollected) < 0 || Number(cursor.pagesCollected) > 1000) {
      throw new TypeError('Invalid workflow repository page count');
    }
    const totalCount = cursor.totalCount === undefined || cursor.totalCount === null ? undefined : cursor.totalCount;
    if (totalCount !== undefined && (!Number.isSafeInteger(totalCount) || Number(totalCount) < 0 || Number(totalCount) > 10_000_000)) {
      throw new TypeError('Invalid workflow repository total count');
    }
    const blockedReason = cursor.blockedReason;
    if (blockedReason !== undefined && blockedReason !== 'result_limit' && blockedReason !== 'incomplete_results' && blockedReason !== 'missing_pages') {
      throw new TypeError('Invalid workflow repository blocked reason');
    }
    return {
      targetId: text(cursor.targetId, 'repositoryCursor.targetId'),
      pageCursor,
      queryDigest,
      complete: bool(cursor.complete, 'repositoryCursor.complete'),
      hasChanges: bool(cursor.hasChanges, 'repositoryCursor.hasChanges'),
      pagesCollected: Number(cursor.pagesCollected),
      ...(totalCount === undefined ? {} : { totalCount: Number(totalCount) }),
      ...(blockedReason === undefined ? {} : { blockedReason }),
    };
  });
  if (row.complete && (repositories.length > 0 || watermark !== windowEnd)) throw new TypeError('A complete checkpoint must advance to its window end with no pending repositories');
  if (!row.complete && (repositories.length === 0 || repositories.every(cursor => cursor.complete))) {
    throw new TypeError('An incomplete checkpoint must retain pending repository cursors');
  }
  return {
    kind: 'github_issues_search',
    watermark,
    windowEnd,
    complete: row.complete,
    repositories,
  };
}

function decodeWorkflowSourceCheckpoint(value: Record<string, unknown>): WorkflowSourceCheckpoint {
  if (value.kind !== 'source_poll' || typeof value.complete !== 'boolean' || !Array.isArray(value.sources)
    || value.sources.length < 1 || value.sources.length > 100) {
    throw new TypeError('Invalid workflow source checkpoint');
  }
  const windowStart = value.windowStart === null ? null : text(value.windowStart, 'checkpoint.windowStart');
  if (windowStart !== null && !Number.isFinite(Date.parse(windowStart))) throw new TypeError('Invalid source checkpoint windowStart');
  const windowEnd = text(value.windowEnd, 'checkpoint.windowEnd');
  if (!Number.isFinite(Date.parse(windowEnd)) || windowStart !== null && Date.parse(windowStart) > Date.parse(windowEnd)) {
    throw new TypeError('Invalid source checkpoint time window');
  }
  const sources: WorkflowSourceCursor[] = value.sources.map(item => {
    const cursor = object(item, 'Workflow source cursor');
    if (!isWorkflowObservationSource(cursor.source) || typeof cursor.complete !== 'boolean'
      || !Number.isSafeInteger(cursor.pagesCollected) || Number(cursor.pagesCollected) < 0 || Number(cursor.pagesCollected) > 20) {
      throw new TypeError('Invalid workflow source cursor');
    }
    const pageCursor = cursor.pageCursor === null ? null : text(cursor.pageCursor, 'sourceCursor.pageCursor');
    const resumeCursor = cursor.resumeCursor === undefined ? undefined
      : cursor.resumeCursor === null ? null : text(cursor.resumeCursor, 'sourceCursor.resumeCursor');
    const watermark = cursor.watermark === null ? null : text(cursor.watermark, 'sourceCursor.watermark');
    if (pageCursor !== null && pageCursor.length > 2_000 || resumeCursor !== undefined && resumeCursor !== null && resumeCursor.length > 2_000
      || watermark !== null && watermark.length > 512) {
      throw new TypeError('Invalid source cursor size');
    }
    if (cursor.complete && pageCursor !== null
      || !cursor.complete && (pageCursor === null || resumeCursor !== undefined && resumeCursor !== null)) {
      throw new TypeError('Source page and resume cursors are invalid for the completion state');
    }
    const seenEventIds = cursor.seenEventIds === undefined ? undefined : decodeTextArrayBounded(cursor.seenEventIds, 'sourceCursor.seenEventIds', 1_000, 512);
    if (seenEventIds !== undefined && new Set(seenEventIds).size !== seenEventIds.length) {
      throw new TypeError('Source cursor event IDs must be unique');
    }
    const states = cursor.states === undefined ? undefined : decodeWorkflowSourceStates(cursor.states);
    return {
      source: cursor.source,
      targetId: text(cursor.targetId, 'sourceCursor.targetId'),
      pageCursor,
      ...(resumeCursor === undefined ? {} : { resumeCursor }),
      watermark,
      complete: cursor.complete,
      pagesCollected: Number(cursor.pagesCollected),
      ...(seenEventIds === undefined ? {} : { seenEventIds }),
      ...(states === undefined ? {} : { states }),
    };
  });
  if (new Set(sources.map(item => `${item.source}\0${item.targetId}`)).size !== sources.length) {
    throw new TypeError('Workflow source checkpoint contains duplicate targets');
  }
  if (sources.reduce((total, item) => total + item.pagesCollected, 0) > 20) {
    throw new TypeError('Workflow source checkpoint exceeds its occurrence-wide page budget');
  }
  if (value.complete && sources.some(item => !item.complete || item.watermark !== windowEnd)
    || !value.complete && sources.every(item => item.complete)) {
    throw new TypeError('Workflow source checkpoint completeness does not match its cursors');
  }
  return { kind: 'source_poll', windowStart, windowEnd, complete: value.complete, sources };
}

function decodeWorkflowSourceStates(value: unknown): readonly WorkflowSourceState[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new TypeError('Invalid workflow source states');
  const states = value.map(item => {
    const row = object(item, 'Workflow source state');
    if (row.state !== 'healthy' && row.state !== 'incident' && row.state !== 'neutral') {
      throw new TypeError('Invalid workflow source state class');
    }
    const resourceKey = text(row.resourceKey, 'sourceState.resourceKey');
    const fingerprint = text(row.fingerprint, 'sourceState.fingerprint');
    if (!/^[a-f0-9]{64}$/u.test(resourceKey) || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
      throw new TypeError('Workflow source state hashes are invalid');
    }
    const state = row.state as WorkflowSourceState['state'];
    return { resourceKey, fingerprint, state };
  });
  if (new Set(states.map(item => item.resourceKey)).size !== states.length) {
    throw new TypeError('Workflow source state resources must be unique');
  }
  return states;
}

function decodeTextArrayBounded(value: unknown, label: string, maximumItems: number, maximumLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new TypeError(`Invalid ${label}`);
  return value.map(item => boundedEventText(item, label, maximumLength));
}

function decodeAttentionKind(value: unknown): WorkflowAttentionKind {
  if (value !== 'blocked_goal' && value !== 'user_decision' && value !== 'service_or_auth_outage') {
    throw new TypeError('Invalid workflow attention kind');
  }
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new TypeError(`${label} must be a string`);
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`);
  return value;
}
