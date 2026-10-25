// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator durable executor work-state client                │
// │ Role: Read and mutate execution TaskRecords through the SQLite API. │
// │ 模块职责：通过 SQLite Work API 读写执行器 TaskRecord 与事件。          │
// └─────────────────────────────────────────────────────────────────────┘

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

export type ExecutionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'waiting_approval'
  | 'waiting_input'
  | 'awaiting_user_authorization';

export type ExecutionClass = 'foreground' | 'background';

/** Durable executor record; the Work service is the production authority.  中文：持久化执行器记录；生产环境以 Work service 为准。 */
export interface TaskRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly status: ExecutionStatus;
  readonly executionClass: ExecutionClass;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly output: string;
  readonly reasoning: string;
  readonly error?: string;
  readonly durationMs: number;
  readonly workspaceId?: string;
  readonly sequence?: number;
  readonly continuationOfTaskId?: string | null;
  readonly continuationMode?: 'read_only' | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** One canonical inbound connector event with optional atomic task admission. */
export interface ConnectorEventInput {
  readonly connectorId: string;
  readonly messageId: string;
  readonly type: string;
  readonly occurredAt?: number;
  readonly accountId?: string;
  readonly conversationId?: string;
  readonly senderId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly teamsThreadMessage?: {
    readonly threadId: string;
    readonly messageId: string;
    readonly serviceUrl: string;
    readonly tenantId: string;
    readonly teamId: string;
    readonly channelId: string;
    readonly conversationId: string;
    readonly rootThreadId: string;
    readonly actorIssuer: string;
    readonly actorSubject: string;
    readonly text: string;
    readonly sessionId?: string;
  };
  readonly task?: {
    readonly id: string;
    readonly sessionId: string;
    readonly prompt: string;
    readonly title?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}

/** Durable connector acknowledgement; replay returns the original task row. */
export interface ConnectorEventReceipt {
  readonly eventId: string;
  readonly duplicate: boolean;
  readonly receivedAt: number;
  readonly task?: TaskRecord;
}

/** Stable thread route plus its bound DSH session and recent participant context. */
export interface ConnectorThreadRecord {
  readonly threadId: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly conversationId: string;
  readonly rootThreadId: string;
  readonly serviceUrl: string;
  readonly sessionId?: string;
  readonly messages: readonly {
    readonly messageId: string;
    readonly actorIssuer: string;
    readonly actorSubject: string;
    readonly text: string;
    readonly createdAt: number;
  }[];
}

/** One immutable outbox payload claimed by a single adapter worker. */
export interface NotificationLease {
  readonly notification: {
    readonly id: string;
    readonly deduplicationKey: string;
    readonly type: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly taskId?: string;
    readonly connectorId?: string;
    readonly recipient?: string;
    readonly status: 'queued' | 'leased' | 'started' | 'uncertain' | 'delivered' | 'failed';
    readonly result: Readonly<Record<string, unknown>>;
  };
  readonly leaseToken: string;
}

/** One ordered durable event attached to a task.  中文：与任务关联的一条有序持久化事件。 */
export interface DurableTaskEvent {
  readonly seq: number;
  readonly event: Record<string, unknown>;
  readonly createdAt: number;
  readonly messageId?: string;
}

export interface TaskPage {
  readonly items: readonly TaskRecord[];
  readonly nextCursor: string | null;
}

export interface TaskEventPage {
  readonly events: readonly DurableTaskEvent[];
  readonly nextSeq: number;
}

/** Minimal started/uncertain connector receipts used to block replay and reconcile status. */
export interface UnresolvedOperationSummary {
  readonly id: string;
  readonly operationType: string;
  readonly taskId?: string | null;
  readonly target?: string | null;
  readonly status: 'started' | 'uncertain';
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** Narrow storage contract shared by the HTTP service and explicit test store.  中文：HTTP 服务和显式测试存储共用的最小存储契约。 */
export interface WorkStateStore {
  createTask(input: {
    id?: string;
    sessionId: string;
    prompt: string;
    executionClass?: ExecutionClass;
    metadata?: Readonly<Record<string, unknown>>;
  }): Promise<TaskRecord>;
  createContinuationTask(
    sourceTaskId: string,
    input: { prompt: string; idempotencyKey: string },
  ): Promise<TaskRecord>;
  verifyContinuationOwnership(sourceTaskId: string): Promise<void>;
  getTask(taskId: string): Promise<TaskRecord | undefined>;
  listTasks(options?: { cursor?: string; limit?: number }): Promise<TaskPage>;
  claimTask(taskId: string): Promise<{ claimed: boolean; task: TaskRecord }>;
  patchTask(taskId: string, patch: Partial<Omit<TaskRecord, 'id' | 'workspaceId' | 'sequence'>>): Promise<TaskRecord>;
  appendEvent(taskId: string, event: Record<string, unknown>): Promise<DurableTaskEvent>;
  getEvents(taskId: string, after?: number): Promise<TaskEventPage>;
  listUnresolvedOperations(options?: { target?: string; limit?: number }): Promise<readonly UnresolvedOperationSummary[]>;
  registerConnectorEvent(input: ConnectorEventInput): Promise<ConnectorEventReceipt>;
  getConnectorThread(connectorId: string, threadId: string, messageLimit?: number, excludeMessageId?: string): Promise<ConnectorThreadRecord>;
  claimNotifications(input: { workerId: string; limit: number; leaseSeconds: number; type: string; connectorId: string }): Promise<readonly NotificationLease[]>;
  startNotification(notificationId: string, leaseToken: string): Promise<void>;
  finishNotification(
    notificationId: string,
    leaseToken: string,
    outcome: 'delivered' | 'failed' | 'uncertain' | 'retry',
    result?: Readonly<Record<string, unknown>>,
    retryAfterSeconds?: number,
  ): Promise<void>;
}

export interface WorkStateConnection {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly tokenEnv?: string;
  readonly requestTimeoutMs?: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, key: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`Invalid Work Task ${key}`);
  }
  return value;
}

function timeField(value: unknown, key: string, optional = false): number | undefined {
  if (optional && (value === undefined || value === null)) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid Work Task ${key}`);
  }
  return value;
}

function decodeTask(value: unknown): TaskRecord {
  const row = object(value, 'Work Task');
  const statuses: ExecutionStatus[] = [
    'queued', 'running', 'completed', 'failed', 'aborted', 'waiting_approval', 'waiting_input',
    'awaiting_user_authorization',
  ];
  if (!statuses.includes(row.status as ExecutionStatus)) throw new TypeError('Invalid Work Task status');
  const executionClass = row.executionClass === undefined ? 'foreground' : row.executionClass;
  if (executionClass !== 'foreground' && executionClass !== 'background') {
    throw new TypeError('Invalid Work Task executionClass');
  }
  const task: TaskRecord = {
    id: stringField(row.id, 'id'),
    sessionId: stringField(row.sessionId, 'sessionId'),
    prompt: stringField(row.prompt, 'prompt', true),
    status: row.status as ExecutionStatus,
    executionClass,
    createdAt: timeField(row.createdAt, 'createdAt')!,
    output: stringField(row.output, 'output', true),
    reasoning: stringField(row.reasoning, 'reasoning', true),
    durationMs: timeField(row.durationMs, 'durationMs')!,
  };
  const startedAt = timeField(row.startedAt, 'startedAt', true);
  const endedAt = timeField(row.endedAt, 'endedAt', true);
  const error = row.error === undefined || row.error === null ? undefined : stringField(row.error, 'error', true);
  const workspaceId = row.workspaceId === undefined ? undefined : stringField(row.workspaceId, 'workspaceId');
  const sequence = row.sequence === undefined ? undefined : timeField(row.sequence, 'sequence');
  const continuationOfTaskId = row.continuationOfTaskId === undefined
    ? undefined
    : row.continuationOfTaskId === null ? null : stringField(row.continuationOfTaskId, 'continuationOfTaskId');
  const continuationMode = row.continuationMode === undefined
    ? undefined
    : row.continuationMode === null ? null
      : row.continuationMode === 'read_only' ? 'read_only'
        : (() => { throw new TypeError('Invalid Work Task continuationMode'); })();
  const metadata = row.metadata === undefined ? undefined : object(row.metadata, 'Work Task metadata');
  return {
    ...task,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(error === undefined ? {} : { error }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(sequence === undefined ? {} : { sequence }),
    ...(continuationOfTaskId === undefined ? {} : { continuationOfTaskId }),
    ...(continuationMode === undefined ? {} : { continuationMode }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function decodeEventPage(value: unknown): TaskEventPage {
  const row = object(value, 'Work Task event page');
  if (!Array.isArray(row.events)) throw new TypeError('Invalid Work Task events');
  const events = row.events.map(item => {
    const eventRow = object(item, 'Work Task event');
    const event = object(eventRow.event, 'Work Task event payload');
    const messageId = eventRow.messageId === undefined || eventRow.messageId === null ? undefined : stringField(eventRow.messageId, 'messageId');
    return {
      seq: timeField(eventRow.seq, 'event sequence')!,
      event,
      createdAt: timeField(eventRow.createdAt, 'event createdAt')!,
      ...(messageId === undefined ? {} : { messageId }),
    };
  });
  return { events, nextSeq: timeField(row.nextSeq, 'nextSeq')! };
}

function decodeUnresolvedOperation(value: unknown): UnresolvedOperationSummary {
  const row = object(value, 'Work unresolved operation');
  if (row.status !== 'started' && row.status !== 'uncertain') {
    throw new TypeError('Invalid Work unresolved operation status');
  }
  const taskId = row.taskId === undefined || row.taskId === null
    ? row.taskId as null | undefined
    : stringField(row.taskId, 'operation taskId');
  const target = row.target === undefined || row.target === null
    ? row.target as null | undefined
    : stringField(row.target, 'operation target');
  return {
    id: stringField(row.id, 'operation id'),
    operationType: stringField(row.operationType, 'operation type'),
    ...(taskId === undefined ? {} : { taskId }),
    ...(target === undefined ? {} : { target }),
    status: row.status,
    evidence: object(row.evidence, 'operation evidence'),
  };
}

/** Authenticated client for one configured workspace; callers cannot select another tenant.  中文：绑定单个配置 Workspace 的认证客户端；调用方无法选择其他租户。 */
export class WorkStateClient implements WorkStateStore {
  readonly tasksUrl: string;
  readonly workUrl: string;

  constructor(private readonly connection: WorkStateConnection) {
    const base = new URL(connection.baseUrl);
    if (base.username || base.password || base.search || base.hash) throw new Error('Invalid persistence base URL');
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
      throw new Error('Remote work-state persistence requires HTTPS; HTTP is limited to loopback');
    }
    if (!connection.workspaceId.trim()) throw new Error('A configured workspace is required');
    this.workUrl = `${base.href.replace(/\/$/, '')}/api/v1/workspaces/${encodeURIComponent(connection.workspaceId)}/work`;
    this.tasksUrl = `${this.workUrl}/tasks`;
  }

  /** Create one durable task. The server binds organization and workspace from the bearer principal.  中文：创建持久任务；服务端从 bearer principal 绑定组织和 Workspace。 */
  async createTask(input: {
    id?: string;
    sessionId: string;
    prompt: string;
    executionClass?: ExecutionClass;
    metadata?: Readonly<Record<string, unknown>>;
  }): Promise<TaskRecord> {
    return decodeTask(await this.request('', 'POST', input));
  }

  /** Ask Work to create a server-linked read-only task from one owned authorization wait. */
  async createContinuationTask(
    sourceTaskId: string,
    input: { prompt: string; idempotencyKey: string },
  ): Promise<TaskRecord> {
    if (!input.idempotencyKey || input.idempotencyKey.length > 200
      || /[\u0000-\u001f\u007f]/u.test(input.idempotencyKey)) {
      throw new TypeError('Invalid continuation Idempotency-Key');
    }
    const receipt = object(await this.request(
      '/' + encodeURIComponent(sourceTaskId) + '/resume',
      'POST',
      { prompt: input.prompt },
      undefined,
      { 'idempotency-key': input.idempotencyKey },
    ), 'Work Task continuation receipt');
    const task = decodeTask(receipt.task);
    if (task.continuationOfTaskId !== sourceTaskId || task.continuationMode !== 'read_only') {
      throw new TypeError('Work service does not support atomic read-only task continuation');
    }
    return task;
  }

  /** Confirm that this persistence principal owns the paused source before Exchange revalidation. */
  async verifyContinuationOwnership(sourceTaskId: string): Promise<void> {
    await this.request('/' + encodeURIComponent(sourceTaskId) + '/resume/check', 'POST');
  }

  /** Read one task; cross-workspace identities are intentionally indistinguishable from missing IDs.  中文：读取任务；跨 Workspace 的标识按不存在处理。 */
  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    try {
      return decodeTask(await this.request(`/${encodeURIComponent(taskId)}`, 'GET'));
    } catch (error) {
      if (error instanceof WorkStateHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** List the configured Workspace's durable tasks.  中文：列出配置 Workspace 的持久任务。 */
  async listTasks(options: { cursor?: string; limit?: number } = {}): Promise<TaskPage> {
    const query = new URLSearchParams();
    if (options.cursor) query.set('cursor', options.cursor);
    if (options.limit !== undefined) query.set('limit', String(Math.min(options.limit, 100)));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const row = object(await this.request(suffix, 'GET'), 'Work Task page');
    if (!Array.isArray(row.items)) throw new TypeError('Invalid Work Task page items');
    if (row.nextCursor !== null && row.nextCursor !== undefined && typeof row.nextCursor !== 'string') {
      throw new TypeError('Invalid Work Task page cursor');
    }
    return { items: row.items.map(decodeTask), nextCursor: (row.nextCursor as string | null | undefined) ?? null };
  }

  /** Atomically claim a queued task so only one executor process can run it.  中文：原子认领排队任务，确保只有一个执行器进程启动它。 */
  async claimTask(taskId: string): Promise<{ claimed: boolean; task: TaskRecord }> {
    const row = object(await this.request(`/${encodeURIComponent(taskId)}/claim`, 'POST', {}), 'Work Task claim');
    if (typeof row.claimed !== 'boolean') throw new TypeError('Invalid Work Task claim result');
    return { claimed: row.claimed, task: decodeTask(row.task) };
  }

  /** Update a task atomically through the Work service transition validator.  中文：由 Work service 原子校验并更新任务状态。 */
  async patchTask(
    taskId: string,
    patch: Partial<Omit<TaskRecord, 'id' | 'workspaceId' | 'sequence'>>,
  ): Promise<TaskRecord> {
    return decodeTask(await this.request(`/${encodeURIComponent(taskId)}`, 'PATCH', patch));
  }

  /** Append one idempotent event to the durable task timeline.  中文：向持久任务时间线追加一条幂等事件。 */
  async appendEvent(taskId: string, event: Record<string, unknown>): Promise<DurableTaskEvent> {
    const messageId = randomUUID();
    const payload = { event, messageId };
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const row = object(await this.request(`/${encodeURIComponent(taskId)}/events`, 'POST', payload), 'Work Task event');
        const eventValue = object(row.event, 'Work Task event payload');
        return {
          seq: timeField(row.seq, 'event sequence')!,
          event: eventValue,
          createdAt: timeField(row.createdAt, 'event createdAt')!,
          messageId,
        };
      } catch (error) {
        lastError = error;
        if (error instanceof WorkStateHttpError && error.status < 500) throw error;
      }
    }
    throw lastError;
  }

  /** Replay the durable event suffix after an exclusive sequence cursor.  中文：按排他序号游标重放持久事件后缀。 */
  async getEvents(taskId: string, after = 0): Promise<TaskEventPage> {
    const query = new URLSearchParams({ after: String(after) });
    return decodeEventPage(await this.request(`/${encodeURIComponent(taskId)}/events?${query}`, 'GET'));
  }

  /** Read scoped unresolved operation receipts without exposing their original arguments. */
  async listUnresolvedOperations(
    options: { target?: string; limit?: number } = {},
  ): Promise<readonly UnresolvedOperationSummary[]> {
    const query = new URLSearchParams({ limit: String(Math.min(Math.max(options.limit ?? 100, 1), 500)) });
    if (options.target !== undefined) query.set('target', boundedString(options.target, 'operation target', 2_000));
    const row = object(await this.request(`/operations/unresolved?${query}`, 'GET'), 'Work unresolved operations');
    if (!Array.isArray(row.items)) throw new TypeError('Invalid Work unresolved operations');
    return row.items.map(decodeUnresolvedOperation);
  }

  /** Deduplicate an inbound event and persist its task admission atomically. */
  async registerConnectorEvent(input: ConnectorEventInput): Promise<ConnectorEventReceipt> {
    const row = object(await this.requestAt(
      `${this.workUrl}/connectors/${encodeURIComponent(safeIdentifier(input.connectorId, 'connectorId'))}/events`,
      'POST',
      {
        messageId: boundedString(input.messageId, 'messageId', 512),
        type: boundedString(input.type, 'type', 256),
        ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.senderId === undefined ? {} : { senderId: input.senderId }),
        payload: input.payload,
        ...(input.teamsThreadMessage === undefined ? {} : { teamsThreadMessage: input.teamsThreadMessage }),
        ...(input.task === undefined ? {} : { task: input.task }),
      },
    ), 'Work connector event receipt');
    if (typeof row.eventId !== 'string' || typeof row.duplicate !== 'boolean'
      || typeof row.receivedAt !== 'number' || !Number.isSafeInteger(row.receivedAt)) {
      throw new TypeError('Invalid Work connector event receipt');
    }
    return {
      eventId: row.eventId,
      duplicate: row.duplicate,
      receivedAt: row.receivedAt,
      ...(row.task === undefined || row.task === null ? {} : { task: decodeTask(row.task) }),
    };
  }

  /** Read the exact durable Teams thread mapping and bounded participant context. */
  async getConnectorThread(
    connectorId: string,
    threadId: string,
    messageLimit = 20,
    excludeMessageId?: string,
  ): Promise<ConnectorThreadRecord> {
    const query = new URLSearchParams({ message_limit: String(Math.min(Math.max(messageLimit, 1), 100)) });
    if (excludeMessageId !== undefined) query.set('exclude_message_id', boundedString(excludeMessageId, 'excludeMessageId', 512));
    const row = object(await this.requestAt(
      `${this.workUrl}/connectors/${encodeURIComponent(safeIdentifier(connectorId, 'connectorId'))}/threads/${encodeURIComponent(boundedString(threadId, 'threadId', 128))}?${query}`,
      'GET',
    ), 'Work connector thread');
    if (!Array.isArray(row.messages)) throw new TypeError('Invalid Work connector thread messages');
    const messages = row.messages.map(item => {
      const message = object(item, 'Work connector thread message');
      return {
        messageId: boundedString(message.messageId, 'thread message id', 512),
        actorIssuer: boundedString(message.actorIssuer, 'thread actor issuer', 512),
        actorSubject: boundedString(message.actorSubject, 'thread actor subject', 256),
        text: boundedThreadMessageText(message.text, 'thread message text', 20_000),
        createdAt: timeField(message.createdAt, 'thread message createdAt')!,
      };
    });
    const serviceUrl = row.serviceUrl ?? '';
    if (typeof serviceUrl !== 'string' || serviceUrl.length > 512) {
      throw new TypeError('Invalid Work connector thread serviceUrl');
    }
    return {
      threadId: boundedString(row.threadId, 'threadId', 128),
      tenantId: boundedString(row.tenantId, 'tenantId', 128),
      teamId: boundedString(row.teamId, 'teamId', 512),
      channelId: boundedString(row.channelId, 'channelId', 512),
      conversationId: boundedString(row.conversationId, 'conversationId', 512),
      rootThreadId: boundedString(row.rootThreadId, 'rootThreadId', 512),
      serviceUrl,
      ...(typeof row.sessionId === 'string' ? { sessionId: boundedString(row.sessionId, 'sessionId', 512) } : {}),
      messages,
    };
  }

  /** Lease one connector's durable messages; expired started sends are never replayed. */
  async claimNotifications(input: {
    workerId: string; limit: number; leaseSeconds: number; type: string; connectorId: string;
  }): Promise<readonly NotificationLease[]> {
    const row = object(await this.requestAt(`${this.workUrl}/notifications/claim`, 'POST', input), 'Work notification claim');
    if (!Array.isArray(row.items)) throw new TypeError('Invalid Work notification claim response');
    return row.items.map(item => {
      const lease = object(item, 'Work notification lease');
      const notice = object(lease.notification, 'Work notification');
      const payload = object(notice.payload, 'Work notification payload');
      const status = notice.status;
      if (!['queued', 'leased', 'started', 'uncertain', 'delivered', 'failed'].includes(String(status))) {
        throw new TypeError('Invalid Work notification state');
      }
      if (notice.type !== input.type || notice.connectorId !== input.connectorId) {
        throw new TypeError('Work returned a notification outside the requested connector scope');
      }
      return {
        notification: {
          id: boundedString(notice.id, 'notification id', 512),
          deduplicationKey: boundedString(notice.deduplicationKey, 'deduplication key', 512),
          type: String(notice.type), payload,
          ...(typeof notice.taskId === 'string' ? { taskId: notice.taskId } : {}),
          ...(typeof notice.connectorId === 'string' ? { connectorId: notice.connectorId } : {}),
          ...(typeof notice.recipient === 'string' ? { recipient: notice.recipient } : {}),
          status: status as NotificationLease['notification']['status'],
          result: notice.result === undefined ? {} : object(notice.result, 'Work notification result'),
        },
        leaseToken: boundedString(lease.leaseToken, 'notification lease token', 512),
      };
    });
  }

  async startNotification(notificationId: string, leaseToken: string): Promise<void> {
    await this.requestAt(`${this.workUrl}/notifications/${encodeURIComponent(notificationId)}/start`, 'POST', { leaseToken });
  }

  async finishNotification(
    notificationId: string,
    leaseToken: string,
    outcome: 'delivered' | 'failed' | 'uncertain' | 'retry',
    result: Readonly<Record<string, unknown>> = {},
    retryAfterSeconds?: number,
  ): Promise<void> {
    await this.requestAt(`${this.workUrl}/notifications/${encodeURIComponent(notificationId)}/finish`, 'POST', {
      leaseToken,
      outcome,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      result,
    });
  }

  private async request(
    path: string,
    method: string,
    body?: unknown,
    timeoutMs?: number,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    return this.requestAt(this.tasksUrl + path, method, body, timeoutMs, extraHeaders);
  }

  private async requestAt(
    url: string,
    method: string,
    body?: unknown,
    timeoutMs?: number,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    const tokenEnv = this.connection.tokenEnv ?? 'CYRENE_SESSION_TOKEN';
    const token = process.env[tokenEnv];
    if (!token) throw new Error(`Missing persistence credential in ${tokenEnv}`);
    const requestTimeoutMs = timeoutMs ?? this.connection.requestTimeoutMs ?? 10_000;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(requestTimeoutMs),
      redirect: 'error',
    });
    const text = await response.text();
    let value: unknown;
    try {
      value = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      throw new WorkStateHttpError(response.status, 'Work service returned invalid JSON');
    }
    if (!response.ok) throw new WorkStateHttpError(response.status, errorCode(value));
    return value;
  }
}

function errorCode(value: unknown): string {
  try {
    const row = object(value, 'Work API error');
    return typeof row.code === 'string' ? row.code : `HTTP_ERROR`;
  } catch {
    return 'HTTP_ERROR';
  }
}

function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

/** Validate stored message bodies using the Work store's NUL/length rule. | 按 Work store 的 NUL/长度规则校验正文。 */
function boundedThreadMessageText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.includes('\u0000')) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

/** Sanitized HTTP failure with no response body or credential details.  中文：不携带响应正文或凭据细节的安全 HTTP 错误。 */
export class WorkStateHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Work state request failed (${status}, ${code})`);
    this.name = 'WorkStateHttpError';
  }
}

/** Explicitly ephemeral store for tests only; production construction must use WorkStateClient.  中文：仅供显式测试使用的临时存储；生产构造必须使用 WorkStateClient。 */
export class InMemoryWorkStateStore implements WorkStateStore {
  private readonly records = new Map<string, TaskRecord>();
  private readonly events = new Map<string, DurableTaskEvent[]>();
  private readonly connectorEvents = new Map<string, { digest: string; receipt: ConnectorEventReceipt }>();
  private readonly connectorThreads = new Map<string, ConnectorThreadRecord>();
  private readonly connectorThreadRoutes = new Map<string, Omit<ConnectorThreadRecord, 'sessionId' | 'messages'>>();
  private readonly connectorThreadMessages = new Map<string, ConnectorThreadRecord['messages'][number][]>();

  async createTask(input: {
    id?: string;
    sessionId: string;
    prompt: string;
    executionClass?: ExecutionClass;
    metadata?: Readonly<Record<string, unknown>>;
  }): Promise<TaskRecord> {
    const id = input.id ?? `task-${randomUUID()}`;
    if (this.records.has(id)) throw new WorkStateHttpError(409, 'TASK_ALREADY_EXISTS');
    const now = Date.now();
    const row: TaskRecord = {
      id, sessionId: input.sessionId, prompt: input.prompt, status: 'queued',
      executionClass: input.executionClass ?? 'foreground',
      createdAt: now, output: '', reasoning: '', durationMs: 0,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    this.records.set(id, row);
    this.events.set(id, []);
    return row;
  }

  async createContinuationTask(
    sourceTaskId: string,
    input: { prompt: string; idempotencyKey: string },
  ): Promise<TaskRecord> {
    const source = this.records.get(sourceTaskId);
    if (!source) throw new WorkStateHttpError(404, 'TASK_NOT_FOUND');
    if (source.status !== 'awaiting_user_authorization') {
      throw new WorkStateHttpError(409, 'TASK_NOT_AWAITING_AUTHORIZATION');
    }
    const digest = createHash('sha256')
      .update(sourceTaskId).update('\0').update(input.idempotencyKey).digest('hex');
    const id = 'continuation-' + digest;
    const prior = this.records.get(id);
    if (prior) {
      if (prior.prompt !== input.prompt || prior.sessionId !== source.sessionId
        || prior.continuationOfTaskId !== sourceTaskId || prior.continuationMode !== 'read_only') {
        throw new WorkStateHttpError(409, 'TASK_ID_CONFLICT');
      }
      return prior;
    }
    const now = Date.now();
    const task: TaskRecord = {
      id,
      sessionId: source.sessionId,
      prompt: input.prompt,
      status: 'queued',
      executionClass: source.executionClass,
      createdAt: now,
      output: '',
      reasoning: '',
      durationMs: 0,
      continuationOfTaskId: sourceTaskId,
      continuationMode: 'read_only',
    };
    this.records.set(id, task);
    this.events.set(id, [
      { seq: 1, event: { type: 'task.created', continuationOfTaskId: sourceTaskId, continuationMode: 'read_only' }, createdAt: now },
      { seq: 2, event: { type: 'task.continuation_started', sourceTaskId, mode: 'read_only' }, createdAt: now },
    ]);
    const sourceEvents = this.events.get(sourceTaskId)!;
    sourceEvents.push({
      seq: sourceEvents.length + 1,
      event: { type: 'task.continuation_started', continuationTaskId: id, mode: 'read_only' },
      createdAt: now,
    });
    return task;
  }

  async verifyContinuationOwnership(sourceTaskId: string): Promise<void> {
    const source = this.records.get(sourceTaskId);
    if (!source) throw new WorkStateHttpError(404, 'TASK_NOT_FOUND');
    if (source.status !== 'awaiting_user_authorization') {
      throw new WorkStateHttpError(409, 'TASK_NOT_AWAITING_AUTHORIZATION');
    }
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> { return this.records.get(taskId); }

  async listTasks(options: { cursor?: string; limit?: number } = {}): Promise<TaskPage> {
    const all = [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const start = options.cursor ? Math.max(0, all.findIndex(row => row.id === options.cursor) + 1) : 0;
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
    const items = all.slice(start, start + limit);
    return { items, nextCursor: start + items.length < all.length ? items.at(-1)?.id ?? null : null };
  }

  async claimTask(taskId: string): Promise<{ claimed: boolean; task: TaskRecord }> {
    const old = this.records.get(taskId);
    if (!old) throw new WorkStateHttpError(404, 'TASK_NOT_FOUND');
    if (old.status !== 'queued') return { claimed: false, task: old };
    const now = Date.now();
    const task = await this.patchTask(taskId, { status: 'running' });
    return { claimed: true, task };
  }

  async patchTask(taskId: string, patch: Partial<Omit<TaskRecord, 'id' | 'workspaceId' | 'sequence'>>): Promise<TaskRecord> {
    const old = this.records.get(taskId);
    if (!old) throw new WorkStateHttpError(404, 'TASK_NOT_FOUND');
    const now = Date.now();
    const next = { ...old, ...patch };
    if (next.status === 'running' && next.startedAt === undefined) Object.assign(next, { startedAt: now });
    if (TERMINAL_STATUSES.has(next.status) && next.endedAt === undefined) {
      Object.assign(next, {
        endedAt: now,
        durationMs: Math.max(0, now - (next.startedAt ?? next.createdAt)),
      });
    }
    this.records.set(taskId, next);
    if (old.status !== next.status) await this.appendEvent(taskId, { type: 'task.status_changed', from: old.status, to: next.status });
    return next;
  }

  async appendEvent(taskId: string, event: Record<string, unknown>): Promise<DurableTaskEvent> {
    if (!this.records.has(taskId)) throw new WorkStateHttpError(404, 'TASK_NOT_FOUND');
    const events = this.events.get(taskId)!;
    const row = { seq: events.length + 1, event, createdAt: Date.now() };
    events.push(row);
    return row;
  }

  async getEvents(taskId: string, after = 0): Promise<TaskEventPage> {
    if (!this.records.has(taskId)) throw new WorkStateHttpError(404, 'TASK_NOT_FOUND');
    const events = this.events.get(taskId)!.filter(row => row.seq > after);
    return { events, nextSeq: this.events.get(taskId)!.length + 1 };
  }

  async listUnresolvedOperations(): Promise<readonly UnresolvedOperationSummary[]> { return []; }

  async registerConnectorEvent(input: ConnectorEventInput): Promise<ConnectorEventReceipt> {
    const key = `${input.connectorId}\0${input.messageId}`;
    const teamsThreadMessage = input.teamsThreadMessage;
    if (teamsThreadMessage !== undefined && input.payload.messageId !== teamsThreadMessage.messageId) {
      throw new TypeError('Teams thread message ID does not match its canonical event payload');
    }
    const digestInput = teamsThreadMessage === undefined ? input : {
      ...input,
      teamsThreadMessage: Object.fromEntries(Object.entries(teamsThreadMessage).filter(([field]) => field !== 'sessionId')),
    };
    const digest = createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
    const prior = this.connectorEvents.get(key);
    if (prior) {
      if (prior.digest !== digest) throw new WorkStateHttpError(409, 'CONNECTOR_EVENT_ID_CONFLICT');
      return { ...prior.receipt, duplicate: true };
    }
    if (teamsThreadMessage) {
      const threadKey = `${input.connectorId}\0${teamsThreadMessage.threadId}`;
      const route = this.connectorThreadRoutes.get(threadKey);
      if (route && (route.tenantId !== teamsThreadMessage.tenantId || route.teamId !== teamsThreadMessage.teamId
        || route.channelId !== teamsThreadMessage.channelId || route.conversationId !== teamsThreadMessage.conversationId
        || route.rootThreadId !== teamsThreadMessage.rootThreadId)) {
        throw new WorkStateHttpError(409, 'CONNECTOR_THREAD_CONFLICT');
      }
    }
    if (teamsThreadMessage?.sessionId) {
      const threadKey = `${input.connectorId}\0${teamsThreadMessage.threadId}`;
      const mapped = this.connectorThreads.get(threadKey);
      if (mapped && (mapped.sessionId !== teamsThreadMessage.sessionId
        || mapped.tenantId !== teamsThreadMessage.tenantId || mapped.teamId !== teamsThreadMessage.teamId
        || mapped.channelId !== teamsThreadMessage.channelId || mapped.conversationId !== teamsThreadMessage.conversationId
        || mapped.rootThreadId !== teamsThreadMessage.rootThreadId)) {
        throw new WorkStateHttpError(409, 'CONNECTOR_THREAD_CONFLICT');
      }
    }
    const task = input.task ? await this.createTask(input.task) : undefined;
    if (teamsThreadMessage) {
      const threadKey = `${input.connectorId}\0${teamsThreadMessage.threadId}`;
      this.connectorThreadRoutes.set(threadKey, {
        threadId: teamsThreadMessage.threadId,
        tenantId: teamsThreadMessage.tenantId,
        teamId: teamsThreadMessage.teamId,
        channelId: teamsThreadMessage.channelId,
        conversationId: teamsThreadMessage.conversationId,
        rootThreadId: teamsThreadMessage.rootThreadId,
        serviceUrl: teamsThreadMessage.serviceUrl,
      });
      if (teamsThreadMessage.sessionId) {
        this.connectorThreads.set(threadKey, {
          threadId: teamsThreadMessage.threadId,
          tenantId: teamsThreadMessage.tenantId,
          teamId: teamsThreadMessage.teamId,
          channelId: teamsThreadMessage.channelId,
          conversationId: teamsThreadMessage.conversationId,
          rootThreadId: teamsThreadMessage.rootThreadId,
          serviceUrl: teamsThreadMessage.serviceUrl,
          sessionId: teamsThreadMessage.sessionId,
          messages: [],
        });
      }
      const messages = this.connectorThreadMessages.get(threadKey) ?? [];
      messages.push({
        messageId: teamsThreadMessage.messageId,
        actorIssuer: teamsThreadMessage.actorIssuer,
        actorSubject: teamsThreadMessage.actorSubject,
        text: teamsThreadMessage.text,
        createdAt: Date.now(),
      });
      this.connectorThreadMessages.set(threadKey, messages);
    }
    const receipt: ConnectorEventReceipt = {
      eventId: randomUUID(), duplicate: false, receivedAt: Date.now(),
      ...(task === undefined ? {} : { task }),
    };
    this.connectorEvents.set(key, { digest, receipt });
    return receipt;
  }

  async getConnectorThread(
    connectorId: string,
    threadId: string,
    messageLimit = 20,
    excludeMessageId?: string,
  ): Promise<ConnectorThreadRecord> {
    const key = `${connectorId}\0${threadId}`;
    const route = this.connectorThreadRoutes.get(key);
    if (!route) throw new WorkStateHttpError(404, 'WORK_CONNECTOR_THREAD_NOT_FOUND');
    const record = this.connectorThreads.get(key);
    return {
      ...route,
      ...(record === undefined ? {} : { sessionId: record.sessionId }),
      messages: (this.connectorThreadMessages.get(key) ?? [])
        .filter(message => message.messageId !== excludeMessageId)
        .slice(-messageLimit),
    };
  }

  async claimNotifications(): Promise<readonly NotificationLease[]> { return []; }
  async startNotification(): Promise<void> { throw new WorkStateHttpError(404, 'NOTIFICATION_NOT_FOUND'); }
  async finishNotification(): Promise<void> { throw new WorkStateHttpError(404, 'NOTIFICATION_NOT_FOUND'); }
}

const TERMINAL_STATUSES = new Set<ExecutionStatus>(['completed', 'failed', 'aborted']);
