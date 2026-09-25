// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator cold Session title adapter                       │
// │ Role: Read log-backed titles through the upstream SessionQuery API. │
// │ 模块职责：通过上游 SessionQuery 只读读取冷会话标题。                    │
// └─────────────────────────────────────────────────────────────────────┘
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {
  SessionTitleObservationResult,
  SessionQueryEngine,
} from '@deepseek-ai/dsh-session-query';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title';
import { record } from './persistence-wire.js';

/** Authenticated Host route for cold title reads.  中文：经过认证的 Host 路由，用于冷读取标题。 */
export const SESSION_TITLES_PATH = '/api/cyrene/session/titles';

/** Bound the request before the upstream query service opens any log.  中文：在上游查询服务打开任何日志前限制请求大小。 */
export const MAX_SESSION_TITLE_IDS = 128;
export const MAX_SESSION_TITLE_REQUEST_BYTES = 32 * 1024;
const MAX_SESSION_ID_BYTES = 512;

/** Client request accepted by the product route.  中文：Product 路由接受的客户端请求。 */
export interface SessionTitlesRequest {
  readonly sessionIds: readonly string[];
}

/** One title projection read directly from a durable Session log.  中文：直接从持久化 Session log 读取的一条标题投影。 */
export interface SessionTitleItem {
  readonly sessionId: string;
  readonly title?: string;
  readonly seq?: number;
  readonly updatedAt?: number;
}

/** A visible Session whose title could not be read in this batch.  中文：可见 Session 的标题读取失败记录。 */
export interface SessionTitleError {
  readonly sessionId: string;
  readonly code: 'SESSION_TITLE_READ_FAILED';
  readonly detail: 'The Session title could not be read.';
}

/** Stable response shape consumed by desktop recovery and other clients.  中文：桌面恢复及其他客户端消费的稳定响应形状。 */
export interface SessionTitlesResponse {
  readonly items: readonly SessionTitleItem[];
  readonly errors: readonly SessionTitleError[];
}

/** Register the read-only route after Connection authentication is mounted.  中文：在挂载 Connection 认证后注册只读路由。 */
export const name = 'cyrene-session-titles';
export const inject = ['connection', 'sessionQuery'];

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: SESSION_TITLES_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => sessionTitlesRequest(ctx.sessionQuery, request),
  }), 'cyrene-session-titles: read');
}

/**
 * Authorize requested ids against the current Workspace, then fold titles from
 * the upstream cold-read service. No Agent, Tool, or writable history is used.
 * 中文：先根据当前 Workspace 授权请求中的 ID，再从上游冷读取服务汇总标题。不使用 Agent、Tool 或可写历史。
 */
export async function sessionTitlesRequest(
  query: SessionQueryEngine,
  request: Request,
): Promise<Response> {
  try {
    if (request.method !== 'POST') return problem(405, 'METHOD_NOT_ALLOWED', 'Use POST for Session title reads.');
    request.signal.throwIfAborted();
    const body = await decodeRequest(request);
    const visible = await visibleSessionIds(query, request.signal);
    for (const id of body.sessionIds) {
      if (!visible.has(id)) {
        // Keep the response aggregate so an unknown id cannot be distinguished
        // from a Session outside the authorized Workspace.
        // 中文：聚合响应，避免外部调用方区分未知 ID 与不属于授权 Workspace 的 Session。
        return problem(404, 'SESSION_NOT_VISIBLE', 'The requested Session is not visible in this Workspace.');
      }
    }

    const results = await query.readTitleSnapshots(
      body.sessionIds.map(id => SessionId(id)),
      request.signal,
    );
    return Response.json(toResponse(results));
  } catch (error) {
    if (isAbort(request.signal, error)) throw error;
    if (isHttpError(error)) return problem(error.status, error.code, error.message);
    return problem(503, 'SESSION_TITLE_READ_FAILED', 'Session titles are temporarily unavailable.');
  }
}

/** Decode and bound the product request before any persistence query.  中文：执行任何持久化查询前解码并限制 Product 请求。 */
async function decodeRequest(request: Request): Promise<SessionTitlesRequest> {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_SESSION_TITLE_REQUEST_BYTES) {
    throw httpError(413, 'REQUEST_TOO_LARGE', 'The Session title request exceeds 32 KiB.');
  }
  let body: Record<string, unknown>;
  try {
    body = record(JSON.parse(text));
  } catch {
    throw httpError(400, 'INVALID_REQUEST', 'Expected a JSON object.');
  }
  if (!Array.isArray(body.sessionIds)
    || body.sessionIds.length === 0
    || body.sessionIds.length > MAX_SESSION_TITLE_IDS) {
    throw httpError(400, 'INVALID_SESSION_IDS', 'Supply between 1 and 128 Session IDs.');
  }

  const sessionIds: string[] = [];
  const seen = new Set<string>();
  for (const value of body.sessionIds) {
    if (typeof value !== 'string' || value.length === 0
      || Buffer.byteLength(value, 'utf8') > MAX_SESSION_ID_BYTES) {
      throw httpError(400, 'INVALID_SESSION_ID', 'Each Session ID must be a non-empty string of at most 512 bytes.');
    }
    if (!seen.has(value)) {
      seen.add(value);
      sessionIds.push(value);
    }
  }
  return { sessionIds };
}

/** List the exact logical corpus owned by the injected Workspace persistence.  中文：列出注入的 Workspace 持久化所拥有的精确逻辑 corpus。 */
async function visibleSessionIds(query: SessionQueryEngine, signal: AbortSignal): Promise<Set<string>> {
  const records = await query.listSessions(signal);
  return new Set(records
    // Match the upstream Session Controller's visible-list rule. Workspace
    // persistence already scopes this corpus; a child Session with a recorded
    // cwd remains visible to the same authorized recovery client.
    // 中文：遵循上游 Session Controller 的可见列表规则。Workspace persistence 已限定 corpus；有记录 cwd 的子 Session 对同一授权恢复客户端仍可见。
    .filter(record => record.header.cwd !== undefined)
    .map(record => record.header.id));
}

/** Convert upstream fulfilled/rejected observations without exposing failures.  中文：转换上游成功/失败观测，同时不暴露内部失败。 */
function toResponse(results: readonly SessionTitleObservationResult[]): SessionTitlesResponse {
  const items: SessionTitleItem[] = [];
  const errors: SessionTitleError[] = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      errors.push({
        sessionId: result.sessionId,
        code: 'SESSION_TITLE_READ_FAILED',
        detail: 'The Session title could not be read.',
      });
      continue;
    }
    items.push(itemFrom(result.sessionId, result.value.title));
  }
  return { items, errors };
}

/** Preserve only the stable title projection fields needed by clients.  中文：只保留客户端需要的稳定标题投影字段。 */
function itemFrom(sessionId: string, snapshot: SessionTitleSnapshot | undefined): SessionTitleItem {
  if (snapshot === undefined) return { sessionId };
  return {
    sessionId,
    title: snapshot.title,
    seq: snapshot.eventSeq,
    updatedAt: snapshot.updatedAt,
  };
}

interface HttpError extends Error {
  readonly status: number;
  readonly code: string;
}

function isHttpError(error: unknown): error is HttpError {
  return error instanceof Error
    && typeof (error as Partial<HttpError>).status === 'number'
    && typeof (error as Partial<HttpError>).code === 'string';
}

function httpError(status: number, code: string, message: string): HttpError {
  return Object.assign(new Error(message), { status, code });
}

function problem(status: number, code: string, detail: string): Response {
  return Response.json({
    type: `urn:cyrene:navigator:${code.toLowerCase()}`,
    title: code,
    status,
    code,
    detail,
  }, { status, headers: { 'Content-Type': 'application/problem+json' } });
}

function isAbort(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}
