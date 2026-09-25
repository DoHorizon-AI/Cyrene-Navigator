// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator persistence HTTP adapter                         │
// │ Role: Authenticate requests and validate upstream session records.  │
// │ 模块职责：认证远端请求，使用上游校验器读取会话记录。                     │
// └─────────────────────────────────────────────────────────────────────┘
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionOwnershipLostError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  assertVersion,
  materializeCreateHeader,
} from '@deepseek-ai/dsh-session-persistence';
import type { SessionAccess, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';

/** Connection settings are deployment input; credentials never enter Session events.  中文：连接设置属于部署输入；凭据绝不进入 Session 事件。 */
export interface PersistenceConnection {
  baseUrl: string;
  workspaceId: string;
  tokenEnv: string;
  requestTimeoutMs: number;
}

/** Validated backend handle; its token is a scoped write capability.  中文：经过校验的后端 handle；其中 token 是受限写入能力。 */
export interface RemoteHandle {
  id: SessionId;
  header: SessionHeader;
  inheritedEventCount: SessionLogOffset;
  access: SessionAccess;
  nextSeq: number;
  epoch: number;
  writerToken?: string;
  leaseExpiresAt?: number;
}

/** Require an object at the HTTP JSON boundary.  中文：在 HTTP JSON 边界要求输入为 object。 */
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Persistence response must be an object');
  }
  return value as Record<string, unknown>;
}

/** Require a lossless non-negative integer from remote storage.  中文：要求远端存储使用无损的非负整数。 */
export function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid persistence ${field}`);
  }
  return value;
}

/** Validate the wire header's JSON fields; the upstream loop validates replay semantics.  中文：校验线协议 header 中的 JSON 字段；重放语义由上游 loop 校验。 */
function decodeHeader(value: unknown, expectedId: SessionId): SessionHeader {
  const row = record(value);
  if (row.id !== expectedId || typeof row.isSeeded !== 'boolean') throw new TypeError('Invalid Session header identity');
  assertVersion({ id: expectedId, version: integer(row.version, 'format version') });
  integer(row.createdAt, 'createdAt');
  for (const key of ['cwd', 'parentSession', 'agentPreset']) {
    if (row[key] !== undefined && typeof row[key] !== 'string') throw new TypeError(`Invalid Session header ${key}`);
  }
  if (row.origin !== undefined && row.origin !== 'subagent') throw new TypeError('Invalid Session origin');
  if (row.delegationDepth !== undefined) integer(row.delegationDepth, 'delegationDepth');
  const header = materializeCreateHeader({
    ...row, id: expectedId, version: SESSION_FORMAT_VERSION,
    createdAt: integer(row.createdAt, 'createdAt'), isSeeded: row.isSeeded,
  });
  return Object.freeze(header);
}

/** Decode the handle without creating an alternate SessionHeader vocabulary.  中文：解码 handle，不创建另一套 SessionHeader 词汇。 */
export function decodeHandle(value: unknown, expectedId: SessionId): RemoteHandle {
  const row = record(value);
  if (row.id !== expectedId || (row.access !== 'read' && row.access !== 'write')) {
    throw new TypeError('Persistence returned a mismatched handle');
  }
  const header = decodeHeader(row.header, expectedId);
  const inheritedEventCount = SessionLogOffset(integer(row.inheritedEventCount, 'inheritedEventCount'));
  if (!header.isSeeded && inheritedEventCount !== 0) throw new TypeError('Unexpected inherited prefix');
  const result: RemoteHandle = {
    id: expectedId, header, inheritedEventCount, access: row.access,
    nextSeq: integer(row.nextSeq, 'nextSeq'), epoch: integer(row.epoch, 'epoch'),
  };
  if (row.access === 'write') {
    if (typeof row.writerToken !== 'string' || !row.writerToken) throw new TypeError('Missing writer token');
    result.writerToken = row.writerToken;
    result.leaseExpiresAt = integer(row.leaseExpiresAt, 'leaseExpiresAt');
  }
  return result;
}

/** Convert a storage observation to the upstream's read-model cache contract.  中文：将存储观测转换为上游的 read-model cache 契约。 */
export function decodeSnapshot(value: unknown): SessionPersistenceSnapshot {
  const row = record(value);
  const meta = record(row.meta);
  if (typeof meta.id !== 'string' || !meta.id || typeof row.revision !== 'string') {
    throw new TypeError('Invalid persistence snapshot');
  }
  return {
    header: decodeHeader(meta, SessionId(meta.id)),
    revision: SessionPersistenceRevision(row.revision),
    eventCount: integer(row.eventCount, 'eventCount'),
  };
}

/** HTTP transport for one authorized Workspace. No local durable fallback exists.  中文：面向一个已授权 Workspace 的 HTTP 传输；不存在本地持久化回退。 */
export class PersistenceHttp {
  readonly sessionsUrl: string;

  constructor(private readonly config: PersistenceConnection) {
    const url = new URL(config.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Invalid persistence base URL');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('Remote persistence requires HTTPS; HTTP is limited to loopback');
    }
    this.sessionsUrl = `${url.href.replace(/\/$/, '')}/api/v1/harness/workspaces/${encodeURIComponent(config.workspaceId)}/sessions`;
  }

  /** Send one bounded request; the backend owns authorization and write fencing.  中文：发送一个有界请求；后端负责授权和写入 fencing。 */
  async request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const token = process.env[this.config.tokenEnv];
    if (!token) throw new Error(`Missing persistence credential in ${this.config.tokenEnv}`);
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const response = await fetch(this.sessionsUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      redirect: 'error',
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const error = record(value);
      const id = SessionId(decodeURIComponent(path.split('/')[1] ?? 'unknown'));
      switch (error.code) {
        case 'SESSION_NOT_FOUND': throw new SessionPersistenceNotFoundError(id);
        case 'SESSION_ALREADY_EXISTS': throw new SessionAlreadyExistsError(id);
        case 'SESSION_ALREADY_OWNED': throw new SessionAlreadyOwnedError(id);
        case 'SESSION_OWNERSHIP_LOST': throw new SessionOwnershipLostError(id);
        default: throw new Error(`Cyrene persistence rejected request (${response.status}, ${String(error.code ?? 'UNKNOWN')})`);
      }
    }
    return value;
  }
}
