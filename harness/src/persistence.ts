// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Cyrene Session persistence                       │
// │ Role: Implement upstream handles over one authoritative backend.   │
// │ 模块职责：通过单一服务端真源实现上游 Session 持久化接口。                │
// └─────────────────────────────────────────────────────────────────────┘
import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { SessionLogOffset } from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import SessionPersistence, {
  assertContiguous,
  assertVersion,
  materializeAppendBatch,
  materializeCreateHeader,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  validateStoredEvents,
} from '@deepseek-ai/dsh-session-persistence';
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionPersistenceCreateOptions,
  SessionPersistenceListOptions,
  SessionPersistenceOpenOptions,
  SessionPersistenceSnapshot,
  SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence';
import { decodeHandle, decodeSnapshot, integer, PersistenceHttp, record } from './persistence-wire.ts';
import type { PersistenceConnection, RemoteHandle } from './persistence-wire.ts';

/** Deployment controls for remote persistence, batching and writer renewal.  中文：远端持久化、批处理和 writer 续租的部署控制参数。 */
export interface Config extends PersistenceConnection {
  clientId: string;
  heartbeatMs: number;
  batchDelayMs: number;
  maxPendingEvents: number;
  batchSize: number;
}

/** One provider implements the actual upstream service; it never opens a local database.  中文：一个 Provider 实现实际的上游服务；不会打开本地数据库。 */
export default class CyreneSessionPersistence extends SessionPersistence {
  static Config: z<Config> = z.object({
    baseUrl: z.string().required(),
    workspaceId: z.string().required(),
    tokenEnv: z.string().default('CYRENE_SESSION_TOKEN'),
    clientId: z.string().default('navigator'),
    requestTimeoutMs: z.number().min(100).max(120000).default(15000),
    heartbeatMs: z.number().min(100).max(60000).default(15000),
    batchDelayMs: z.number().min(0).max(1000).default(50),
    maxPendingEvents: z.number().min(1).max(100000).default(8192),
    batchSize: z.number().min(1).max(512).default(256),
  });

  override readonly name = 'cyrene-session-persistence';
  readonly http: PersistenceHttp;
  readonly clientId: string;
  private readonly handles = new Set<CyreneSessionHandle>();
  private readonly writers = new Map<SessionId, CyreneSessionHandle>();
  private readonly takeovers = new Map<SessionId, CyreneSessionHandle>();
  private readonly takeoverRequests = new Set<SessionId>();

  constructor(ctx: Context, readonly config: Config) {
    super(ctx);
    this.http = new PersistenceHttp(config);
    this.clientId = `${config.clientId}:${randomUUID()}`;
    ctx.on('session/event', (session, event) => { this.writers.get(session.id)?.enqueue(event); });
    ctx.on('session/flush', (session) => this.writers.get(session.id)?.flush());
    ctx.on('session/disposed', (session) => {
      this.writers.get(session.id)?.close().catch(() => {
        ctx.logger.error(`Cyrene session close failed: ${session.id}`);
      });
    });
    ctx.on('tools/execute', async (execution, next) => {
      if (execution.agent) {
        const writer = this.writers.get(execution.agent.id);
        if (!writer) throw new SessionOwnershipLostError(execution.agent.id);
        // A tool must not start while its owning call exists only in volatile memory.
        // 中文：当所属调用仅存在于易失内存中时，不得启动工具。
        await writer.flush({ signal: execution.signal });
      }
      return next();
    });
    ctx.effect(() => async () => {
      const results = await Promise.allSettled([...this.handles].map(handle => handle.close()));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown);
      if (failures.length) throw new AggregateError(failures, 'Cyrene persistence teardown failed');
    }, 'cyrene persistence handles');
  }

  override async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    const snapshot = materializeCreateHeader(header);
    assertVersion(snapshot);
    const inheritedEventCount = SessionLogOffset(options?.inheritedEventCount ?? 0);
    if ((snapshot.isSeeded && options?.inheritedEventCount === undefined) || (!snapshot.isSeeded && inheritedEventCount !== 0)) {
      throw new TypeError('Session inherited prefix does not match its header');
    }
    return this.adopt(decodeHandle(await this.http.request('', {
      header: snapshot, inheritedEventCount, clientId: this.clientId,
    }, options?.signal), snapshot.id));
  }

  override async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const reserved = access === 'write' ? this.takeovers.get(id) : undefined;
    if (reserved) {
      this.takeovers.delete(id);
      return reserved;
    }
    const value = await this.http.request(`/${encodeURIComponent(id)}/handles`, { access, clientId: this.clientId }, options?.signal);
    return this.adopt(decodeHandle(value, id));
  }

  /** Explicit product action; the server checks actor, observed epoch and fencing.  中文：显式 Product 操作；服务端会校验 actor、观测到的 epoch 和 fencing。 */
  async takeover(id: SessionId, expectedEpoch: number, signal?: AbortSignal): Promise<CyreneSessionHandle> {
    const value = await this.http.request(`/${encodeURIComponent(id)}/handles`, {
      access: 'write', clientId: this.clientId,
      takeoverExpectedEpoch: integer(expectedEpoch, 'expectedEpoch'),
    }, signal);
    return this.adopt(decodeHandle(value, id));
  }

  /** Reserve the fenced handle for the upstream resume path's next write open.  中文：为上游 resume 路径的下一次写入 open 预留 fenced handle。 */
  async resumeWithTakeover<T>(id: SessionId, expectedEpoch: number, resume: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.writers.has(id) || this.takeoverRequests.has(id)) {
      throw new Error('This Navigator runtime already owns or is acquiring the Session');
    }
    this.takeoverRequests.add(id);
    let reserved: CyreneSessionHandle | undefined;
    try {
      reserved = await this.takeover(id, expectedEpoch, signal);
      this.takeovers.set(id, reserved);
      const result = await resume();
      if (this.takeovers.has(id)) throw new Error('Upstream resume did not acquire the reserved Session writer');
      return result;
    } catch (error) {
      if (reserved) await reserved.close().catch(() => this.report(id));
      throw error;
    } finally {
      this.takeovers.delete(id);
      this.takeoverRequests.delete(id);
    }
  }

  /** Local ownership is a UI observation; the backend remains the authority.  中文：本地所有权只是 UI 观测；后端仍是权威。 */
  owns(id: SessionId, observedEpoch?: number): boolean { return this.writers.get(id)?.ownsEpoch(observedEpoch) ?? false; }

  override async flush(): Promise<void> {
    const results = await Promise.allSettled([...this.writers.values()].map(handle => handle.flush()));
    const failures = results.filter(result => result.status === 'rejected' && !(result.reason instanceof SessionHandleClosedError));
    if (failures.length) throw new AggregateError(failures.map(result => result.status === 'rejected' ? result.reason as unknown : undefined), 'Cyrene persistence flush failed');
  }

  override async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    try {
      return decodeSnapshot(await this.http.request(`/${encodeURIComponent(id)}`, undefined, options?.signal));
    } catch (error) {
      if (error instanceof SessionPersistenceNotFoundError) return undefined;
      throw error;
    }
  }

  override async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    const value = record(await this.http.request('', undefined, options?.signal));
    if (!Array.isArray(value.items)) throw new TypeError('Persistence session list is missing');
    return value.items.map(decodeSnapshot);
  }

  /** Release only this exact handle; an older handle cannot remove its successor.  中文：只释放这个精确 handle；旧 handle 不能移除它的后继者。 */
  release(handle: CyreneSessionHandle): void {
    this.handles.delete(handle);
    if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id);
    if (this.takeovers.get(handle.id) === handle) this.takeovers.delete(handle.id);
  }

  /** Report lifecycle failure without placing credentials or session content in logs.  中文：报告生命周期失败时，不得把凭据或 Session 内容写入日志。 */
  report(id: SessionId): void {
    this.ctx.logger.error(`Cyrene persistence failed for session ${id}; no local fallback was used`);
  }

  /** Stop live work through the upstream Agent API after the backend fences it.  中文：后端完成 fencing 后，通过上游 Agent API 停止在线工作。 */
  ownershipLost(id: SessionId): void {
    this.ctx.get('agents')?.get(id)?.cancel({ kind: 'hook', reason: 'Cyrene Session writer ownership was lost' });
  }

  private adopt(remote: RemoteHandle): CyreneSessionHandle {
    const handle = new CyreneSessionHandle(this, remote);
    this.handles.add(handle);
    if (remote.access === 'write') this.writers.set(remote.id, handle);
    return handle;
  }
}

/** Ordered handle with a bounded volatile batch and backend-enforced write fencing.  中文：有序 handle，带有有界易失批次和由后端强制执行的写入 fencing。 */
export class CyreneSessionHandle implements SessionHandle {
  readonly id: SessionId;
  readonly header: SessionHeader;
  readonly inheritedEventCount: SessionLogOffset;
  readonly access: SessionAccess;
  private chain: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private pending: SessionEvent[] = [];
  private nextSeq: number;
  private observedLength = 0;
  private lost = false;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeat: Promise<void> | undefined;

  constructor(private readonly owner: CyreneSessionPersistence, private readonly remote: RemoteHandle) {
    this.id = remote.id;
    this.header = remote.header;
    this.inheritedEventCount = remote.inheritedEventCount;
    this.access = remote.access;
    this.nextSeq = remote.nextSeq;
    if (this.access === 'write') {
      const interval = Math.max(100, Math.min(owner.config.heartbeatMs, Math.floor(((remote.leaseExpiresAt ?? Date.now()) - Date.now()) / 3)));
      this.heartbeatTimer = setInterval(() => {
        if (this.heartbeat || this.closing || this.lost) return;
        this.heartbeat = this.mutate('heartbeat').then(() => {}).catch(() => {
          this.owner.report(this.id);
        }).finally(() => { this.heartbeat = undefined; });
      }, interval);
      this.heartbeatTimer.unref();
    }
  }

  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<readonly SessionEvent[]> {
    this.assertOpen('read');
    integer(offset, 'read offset');
    integer(length, 'read length');
    const events: SessionEvent[] = [];
    let remaining = length;
    let cursor = offset;
    do {
      const count = Math.min(remaining, this.owner.config.batchSize);
      const response = record(await this.owner.http.request(`${this.path}/events?offset=${cursor}&length=${count}`, undefined, options?.signal));
      const end = integer(response.nextSeq, 'nextSeq');
      if (end < this.observedLength) throw new Error('Stored Session log shrank');
      this.observedLength = end;
      if (!Array.isArray(response.events)) throw new TypeError('Missing Session events');
      // The upstream validator owns event vocabulary, payload validation and freezing.
      // 中文：上游校验器拥有事件词汇、负载校验和冻结处理。
      const batch = validateStoredEvents(this.header, response.events as SessionEvent[]);
      assertContiguous(this.id, batch, cursor);
      events.push(...batch);
      cursor += batch.length;
      remaining -= batch.length;
      if (cursor >= end || batch.length === 0 || remaining === 0) break;
    } while (remaining > 0);
    return Object.freeze(events);
  }

  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen('append');
    this.assertWriter('append');
    const batch = validateStoredEvents(this.header, [...materializeAppendBatch(events)]);
    return this.queue(async () => {
      options?.signal?.throwIfAborted();
      await this.drain(options?.signal);
      await this.persist(batch, options?.signal);
    });
  }

  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen('flush');
    this.assertWriter('flush');
    return this.queue(async () => {
      options?.signal?.throwIfAborted();
      await this.drain(options?.signal);
      await this.mutate('flush', {}, options?.signal);
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    clearInterval(this.heartbeatTimer);
    this.closing = this.queue(async () => {
      try {
        // Join renewal before release so a late heartbeat cannot fence a closed handle.
        // 中文：先等待续租结束再释放，避免迟到的 heartbeat fence 已关闭的 handle。
        await this.heartbeat;
        if (this.access === 'write') {
          await this.drain();
          await this.mutate('flush');
          await this.mutate('release');
        }
      } finally {
        clearTimeout(this.batchTimer);
        clearInterval(this.heartbeatTimer);
        this.owner.release(this);
      }
    });
    return this.closing;
  }

  [Symbol.asyncDispose](): Promise<void> { return this.close(); }

  /** Compare a UI observation with this handle without granting new authority.  中文：将 UI 观测与此 handle 比较，但不授予新权威。 */
  ownsEpoch(epoch?: number): boolean {
    return this.access === 'write' && !this.lost && !this.closing
      && (epoch === undefined || epoch === this.remote.epoch);
  }

  /** Route a committed live event into the same ordered backend channel.  中文：将已提交的在线事件路由到同一个有序后端通道。 */
  enqueue(event: SessionEvent): void {
    this.assertOpen('append');
    this.assertWriter('append');
    if (this.pending.length >= this.owner.config.maxPendingEvents) throw new Error('Session persistence backlog exceeded');
    this.pending.push(...materializeAppendBatch([event]));
    if (this.batchTimer || this.closing) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      this.flush().catch(() => this.owner.report(this.id));
    }, this.owner.config.batchDelayMs);
  }

  private get path(): string { return `/${encodeURIComponent(this.id)}`; }

  private assertOpen(operation: string): void {
    if (this.closing) throw new SessionHandleClosedError(this.id, operation);
  }

  private assertWriter(operation: string): void {
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, operation);
    if (this.lost) throw new SessionOwnershipLostError(this.id);
  }

  private queue(operation: () => Promise<void>): Promise<void> {
    const result = this.chain.then(operation);
    // Each caller observes its own rejection; later flushes can retry retained events.
    // 中文：每个调用方分别观察自身的拒绝；后续 flush 可重试保留的事件。
    this.chain = result.catch(() => {});
    return result;
  }

  private async drain(signal?: AbortSignal): Promise<void> {
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    while (this.pending.length) {
      const batch = this.pending.slice(0, this.owner.config.batchSize);
      await this.persist(batch, signal);
      this.pending.splice(0, batch.length);
    }
  }

  private async persist(events: readonly SessionEvent[], signal?: AbortSignal): Promise<void> {
    this.assertWriter('append');
    assertContiguous(this.id, events, this.nextSeq);
    if (!events.length) return;
    const batchId = createHash('sha256').update(JSON.stringify(events)).digest('hex');
    const response = record(await this.mutate('append', { batchId, events }, signal));
    const nextSeq = integer(response.nextSeq, 'nextSeq');
    if (nextSeq !== this.nextSeq + events.length) throw new Error('Unexpected acknowledged Session prefix');
    this.nextSeq = nextSeq;
  }

  private async mutate(operation: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    this.assertWriter(operation);
    try {
      return await this.owner.http.request(`${this.path}/${operation}`, {
        writerToken: this.remote.writerToken, epoch: this.remote.epoch, ...body,
      }, signal);
    } catch (error) {
      if (error instanceof SessionOwnershipLostError && !this.lost) {
        this.lost = true;
        this.owner.ownershipLost(this.id);
      }
      throw error;
    }
  }
}
