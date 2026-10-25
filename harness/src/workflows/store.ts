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
export type WorkflowDefinition = WorkflowRecord | WorkflowV2Record;

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
  readonly checkpoint?: WorkflowCheckpoint;
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
  putWorkflow(workflow: WorkflowWrite): Promise<WorkflowRecord>;
  putWorkflow(workflow: WorkflowV2Write): Promise<WorkflowV2Record>;
  appendScheduleEvent(event: WorkflowScheduleEvent): Promise<WorkflowScheduleEvent>;
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
    this.notificationsUrl = `${prefix}/notifications`;
    this.tokenEnv = connection.tokenEnv ?? 'CYRENE_SESSION_TOKEN';
    this.requestTimeoutMs = connection.requestTimeoutMs ?? 10_000;
  }

  /** List only the explicitly negotiated definition version; legacy callers remain v1. */
  listWorkflows(): Promise<readonly WorkflowRecord[]>;
  listWorkflows(definitionVersion: 1): Promise<readonly WorkflowRecord[]>;
  listWorkflows(definitionVersion: 2): Promise<readonly WorkflowV2Record[]>;
  async listWorkflows(definitionVersion: 1 | 2 = 1): Promise<readonly WorkflowDefinition[]> {
    const url = `${this.workflowsUrl}?definitionVersion=${definitionVersion}`;
    const row = object(await this.request(url, 'GET'), 'Workflow page');
    if (!Array.isArray(row.items)) throw new TypeError('Workflow page is missing items');
    return row.items.map(value => decodeWorkflowDefinition(value, definitionVersion));
  }

  /** Create or replace one negotiated workflow definition. */
  putWorkflow(workflow: WorkflowWrite): Promise<WorkflowRecord>;
  putWorkflow(workflow: WorkflowV2Write): Promise<WorkflowV2Record>;
  async putWorkflow(workflow: WorkflowWrite | WorkflowV2Write): Promise<WorkflowDefinition> {
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
  private readonly events = new Map<string, WorkflowScheduleEvent>();
  private readonly notifications = new Map<string, WorkflowOutboxRequest | { readonly workflowId: string; readonly notice: WorkflowTeamsNoticeRequest }>();

  listWorkflows(): Promise<readonly WorkflowRecord[]>;
  listWorkflows(definitionVersion: 1): Promise<readonly WorkflowRecord[]>;
  listWorkflows(definitionVersion: 2): Promise<readonly WorkflowV2Record[]>;
  async listWorkflows(definitionVersion: 1 | 2 = 1): Promise<readonly WorkflowDefinition[]> {
    const rows = definitionVersion === 1 ? this.workflows.values() : this.workflowsV2.values();
    return [...rows].map(value => structuredClone(value));
  }

  putWorkflow(workflow: WorkflowWrite): Promise<WorkflowRecord>;
  putWorkflow(workflow: WorkflowV2Write): Promise<WorkflowV2Record>;
  async putWorkflow(workflow: WorkflowWrite | WorkflowV2Write): Promise<WorkflowDefinition> {
    validateWorkflowWrite(workflow);
    const row = { ...structuredClone(workflow), updatedAt: new Date().toISOString() };
    if (row.version === 1) {
      this.workflows.set(row.id, row);
      return structuredClone(row);
    }
    this.workflowsV2.set(row.id, row);
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
    if (!this.workflowsV2.has(workflowId)) throw new WorkflowStoreHttpError(404, 'WORK_WORKFLOW_NOT_FOUND');
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
export function validateWorkflowWrite(value: WorkflowWrite | WorkflowV2Write): void {
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
  validateSchedule(value.notifications.digest.schedule);
  const allowedImmediate = new Set(['blocked_goal', 'user_decision', 'service_or_auth_outage']);
  if (new Set(value.notifications.immediateOn).size !== value.notifications.immediateOn.length
    || value.notifications.immediateOn.some(item => !allowedImmediate.has(item))) {
    throw new TypeError('Workflow immediate notification policy is invalid');
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

function decodeWorkflowDefinition(value: unknown, definitionVersion: 1 | 2): WorkflowDefinition {
  const row = object(value, 'Workflow record');
  if (row.version !== definitionVersion) throw new TypeError('Workflow record version does not match definitionVersion negotiation');
  return definitionVersion === 1 ? decodeWorkflow(value) : decodeWorkflowV2(value);
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

function decodeWorkflowCheckpoint(value: unknown): WorkflowCheckpoint {
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
