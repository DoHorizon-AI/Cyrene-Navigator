// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Durable Workflow Store                             │
// │ Role: Read/write workflow definitions and immutable run receipts.    │
// │ 模块职责：读写工作流定义及不可变执行回执。                               │
// └─────────────────────────────────────────────────────────────────────┘

import { readFile } from 'node:fs/promises';

/** A configurable resource inspected by one workflow. */
export interface WorkflowTarget {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly uri?: string;
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
  readonly createdAt: string;
}

/** Cursor page returned by the Work API. */
export interface WorkflowScheduleEventPage {
  readonly items: readonly WorkflowScheduleEvent[];
  readonly nextCursor: string | null;
}

/** Notification category stored in the workspace-scoped durable outbox. */
export type WorkflowOutboxType = 'workflow.change' | 'workflow.failure' | 'workflow.recovery';

/** Minimal safe payload retained by the workflow notification outbox. */
export interface WorkflowOutboxPayload {
  readonly workflowId: string;
  readonly occurrenceId: string;
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
  putWorkflow(workflow: WorkflowWrite): Promise<WorkflowRecord>;
  appendScheduleEvent(event: WorkflowScheduleEvent): Promise<WorkflowScheduleEvent>;
  enqueueNotification(request: WorkflowOutboxRequest): Promise<WorkflowOutboxReceipt>;
  listScheduleEvents(options: {
    readonly workflowId: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<WorkflowScheduleEventPage>;
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
    this.workflowsUrl = `${prefix}/workflows`;
    this.eventsUrl = `${prefix}/schedule-events`;
    this.notificationsUrl = `${prefix}/notifications`;
    this.tokenEnv = connection.tokenEnv ?? 'CYRENE_SESSION_TOKEN';
    this.requestTimeoutMs = connection.requestTimeoutMs ?? 10_000;
  }

  /** List workflow definitions bound to the configured workspace. */
  async listWorkflows(): Promise<readonly WorkflowRecord[]> {
    const row = object(await this.request(this.workflowsUrl, 'GET'), 'Workflow page');
    if (!Array.isArray(row.items)) throw new TypeError('Workflow page is missing items');
    return row.items.map(decodeWorkflow);
  }

  /** Create or replace one version-1 workflow definition. */
  async putWorkflow(workflow: WorkflowWrite): Promise<WorkflowRecord> {
    validateWorkflowWrite(workflow);
    return decodeWorkflow(await this.request(`${this.workflowsUrl}/${encodeURIComponent(workflow.id)}`, 'PUT', workflow));
  }

  /** Append one immutable run state. Exact duplicate ids are idempotent on the server. */
  async appendScheduleEvent(event: WorkflowScheduleEvent): Promise<WorkflowScheduleEvent> {
    validateScheduleEvent(event);
    return decodeScheduleEvent(await this.request(this.eventsUrl, 'POST', event));
  }

  /** Persist one safe transition notice; exact replays return the original outbox item. */
  async enqueueNotification(request: WorkflowOutboxRequest): Promise<WorkflowOutboxReceipt> {
    validateWorkflowOutboxRequest(request);
    const row = object(await this.request(this.notificationsUrl, 'POST', request), 'Workflow notification receipt');
    const notification = object(row.notification, 'Workflow notification');
    if (typeof row.duplicate !== 'boolean') throw new TypeError('Workflow notification receipt is missing duplicate');
    return { notification, duplicate: row.duplicate };
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
  private readonly events = new Map<string, WorkflowScheduleEvent>();
  private readonly notifications = new Map<string, WorkflowOutboxRequest>();

  async listWorkflows(): Promise<readonly WorkflowRecord[]> {
    return [...this.workflows.values()].map(value => structuredClone(value));
  }

  async putWorkflow(workflow: WorkflowWrite): Promise<WorkflowRecord> {
    validateWorkflowWrite(workflow);
    const row = { ...structuredClone(workflow), updatedAt: new Date().toISOString() };
    this.workflows.set(row.id, row);
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

  /** Inspect test outbox state while preserving it across simulated host restarts. */
  listNotifications(): readonly WorkflowOutboxRequest[] {
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
export function validateWorkflowWrite(value: WorkflowWrite): void {
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

/** Validate one event before persisting it as an immutable receipt. */
export function validateScheduleEvent(event: WorkflowScheduleEvent): void {
  if (!event.id.trim() || !event.workflowId.trim()) throw new TypeError('Schedule event id and workflow id are required');
  for (const value of [event.createdAt, event.scheduledAt, event.startedAt, event.endedAt]) {
    if (value !== undefined && !Number.isFinite(Date.parse(value))) throw new TypeError('Invalid schedule event timestamp');
  }
  if (!['queued', 'running', 'succeeded', 'failed'].includes(event.status)) throw new TypeError('Invalid schedule event status');
  if (event.summary !== undefined && event.summary.length > 512) throw new TypeError('Schedule event summary is too long');
}

/** Validate the deliberately small safe workflow outbox contract. */
export function validateWorkflowOutboxRequest(request: WorkflowOutboxRequest): void {
  if (Object.keys(request as unknown as Record<string, unknown>).some(key => !['deduplicationKey', 'type', 'payload'].includes(key))) {
    throw new TypeError('Workflow notifications cannot include routing or task authority fields');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(request.deduplicationKey)) throw new TypeError('Invalid workflow notification deduplication key');
  if (!['workflow.change', 'workflow.failure', 'workflow.recovery'].includes(request.type)) throw new TypeError('Invalid workflow notification type');
  const payload = request.payload;
  if (Object.keys(payload as unknown as Record<string, unknown>).some(key => !['workflowId', 'occurrenceId', 'summary', 'taskId'].includes(key))) {
    throw new TypeError('Workflow notification payload contains unsupported fields');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(payload.workflowId)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(payload.occurrenceId)
    || !payload.summary.trim() || payload.summary.length > 400
    || (payload.taskId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(payload.taskId))) {
    throw new TypeError('Invalid workflow notification payload');
  }
}

function decodeWorkflow(value: unknown): WorkflowRecord {
  const row = object(value, 'Workflow record');
  if (row.version !== 1) throw new TypeError('Unsupported workflow record version');
  if (!Array.isArray(row.targets)) throw new TypeError('Workflow targets are missing');
  const targets = row.targets.map((item) => {
    const target = object(item, 'Workflow target');
    return {
      id: text(target.id, 'target.id'), label: text(target.label, 'target.label'), kind: text(target.kind, 'target.kind'),
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
  };
  validateScheduleEvent(event);
  return event;
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
