// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator durable executor work-state client                │
// │ Role: Read and mutate execution TaskRecords through the SQLite API. │
// │ 模块职责：通过 SQLite Work API 读写执行器 TaskRecord 与事件。          │
// └─────────────────────────────────────────────────────────────────────┘

import { randomUUID } from 'node:crypto';

export type ExecutionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'waiting_approval'
  | 'waiting_input';

/** Durable executor record; the Work service is the production authority.  中文：持久化执行器记录；生产环境以 Work service 为准。 */
export interface TaskRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly status: ExecutionStatus;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly output: string;
  readonly reasoning: string;
  readonly error?: string;
  readonly durationMs: number;
  readonly workspaceId?: string;
  readonly sequence?: number;
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

/** Narrow storage contract shared by the HTTP service and explicit test store.  中文：HTTP 服务和显式测试存储共用的最小存储契约。 */
export interface WorkStateStore {
  createTask(input: { id?: string; sessionId: string; prompt: string }): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord | undefined>;
  listTasks(options?: { cursor?: string; limit?: number }): Promise<TaskPage>;
  claimTask(taskId: string): Promise<{ claimed: boolean; task: TaskRecord }>;
  patchTask(taskId: string, patch: Partial<Omit<TaskRecord, 'id' | 'workspaceId' | 'sequence'>>): Promise<TaskRecord>;
  appendEvent(taskId: string, event: Record<string, unknown>): Promise<DurableTaskEvent>;
  getEvents(taskId: string, after?: number): Promise<TaskEventPage>;
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
  ];
  if (!statuses.includes(row.status as ExecutionStatus)) throw new TypeError('Invalid Work Task status');
  const task: TaskRecord = {
    id: stringField(row.id, 'id'),
    sessionId: stringField(row.sessionId, 'sessionId'),
    prompt: stringField(row.prompt, 'prompt', true),
    status: row.status as ExecutionStatus,
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
  return {
    ...task,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(error === undefined ? {} : { error }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(sequence === undefined ? {} : { sequence }),
  };
}

function decodeEventPage(value: unknown): TaskEventPage {
  const row = object(value, 'Work Task event page');
  if (!Array.isArray(row.events)) throw new TypeError('Invalid Work Task events');
  const events = row.events.map(item => {
    const eventRow = object(item, 'Work Task event');
    const event = object(eventRow.event, 'Work Task event payload');
    const messageId = eventRow.messageId === undefined ? undefined : stringField(eventRow.messageId, 'messageId');
    return {
      seq: timeField(eventRow.seq, 'event sequence')!,
      event,
      createdAt: timeField(eventRow.createdAt, 'event createdAt')!,
      ...(messageId === undefined ? {} : { messageId }),
    };
  });
  return { events, nextSeq: timeField(row.nextSeq, 'nextSeq')! };
}

/** Authenticated client for one configured workspace; callers cannot select another tenant.  中文：绑定单个配置 Workspace 的认证客户端；调用方无法选择其他租户。 */
export class WorkStateClient implements WorkStateStore {
  readonly tasksUrl: string;

  constructor(private readonly connection: WorkStateConnection) {
    const base = new URL(connection.baseUrl);
    if (base.username || base.password || base.search || base.hash) throw new Error('Invalid persistence base URL');
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
      throw new Error('Remote work-state persistence requires HTTPS; HTTP is limited to loopback');
    }
    if (!connection.workspaceId.trim()) throw new Error('A configured workspace is required');
    this.tasksUrl = `${base.href.replace(/\/$/, '')}/api/v1/workspaces/${encodeURIComponent(connection.workspaceId)}/work/tasks`;
  }

  /** Create one durable task. The server binds organization and workspace from the bearer principal.  中文：创建持久任务；服务端从 bearer principal 绑定组织和 Workspace。 */
  async createTask(input: { id?: string; sessionId: string; prompt: string }): Promise<TaskRecord> {
    return decodeTask(await this.request('', 'POST', input));
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

  private async request(path: string, method: string, body?: unknown): Promise<unknown> {
    const tokenEnv = this.connection.tokenEnv ?? 'CYRENE_SESSION_TOKEN';
    const token = process.env[tokenEnv];
    if (!token) throw new Error(`Missing persistence credential in ${tokenEnv}`);
    const timeoutMs = this.connection.requestTimeoutMs ?? 10_000;
    const response = await fetch(this.tasksUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
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

/** Sanitized HTTP failure with no response body or credential details.  中文：不携带响应正文或凭据细节的安全 HTTP 错误。 */
export class WorkStateHttpError extends Error {
  constructor(readonly status: number, code: string) {
    super(`Work state request failed (${status}, ${code})`);
    this.name = 'WorkStateHttpError';
  }
}

/** Explicitly ephemeral store for tests only; production construction must use WorkStateClient.  中文：仅供显式测试使用的临时存储；生产构造必须使用 WorkStateClient。 */
export class InMemoryWorkStateStore implements WorkStateStore {
  private readonly records = new Map<string, TaskRecord>();
  private readonly events = new Map<string, DurableTaskEvent[]>();

  async createTask(input: { id?: string; sessionId: string; prompt: string }): Promise<TaskRecord> {
    const id = input.id ?? `task-${randomUUID()}`;
    if (this.records.has(id)) throw new WorkStateHttpError(409, 'TASK_ALREADY_EXISTS');
    const now = Date.now();
    const row: TaskRecord = {
      id, sessionId: input.sessionId, prompt: input.prompt, status: 'queued',
      createdAt: now, output: '', reasoning: '', durationMs: 0,
    };
    this.records.set(id, row);
    this.events.set(id, []);
    return row;
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
}

const TERMINAL_STATUSES = new Set<ExecutionStatus>(['completed', 'failed', 'aborted']);
