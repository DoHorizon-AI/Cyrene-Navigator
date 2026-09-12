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

/** Authenticated Host route for cold title reads. */
export const SESSION_TITLES_PATH = '/api/cyrene/session/titles';

/** Bound the request before the upstream query service opens any log. */
export const MAX_SESSION_TITLE_IDS = 128;
export const MAX_SESSION_TITLE_REQUEST_BYTES = 32 * 1024;
const MAX_SESSION_ID_BYTES = 512;

/** Client request accepted by the product route. */
export interface SessionTitlesRequest {
  readonly sessionIds: readonly string[];
}

/** One title projection read directly from a durable Session log. */
export interface SessionTitleItem {
  readonly sessionId: string;
  readonly title?: string;
  readonly seq?: number;
  readonly updatedAt?: number;
}

/** A visible Session whose title could not be read in this batch. */
export interface SessionTitleError {
  readonly sessionId: string;
  readonly code: 'SESSION_TITLE_READ_FAILED';
  readonly detail: 'The Session title could not be read.';
}

/** Stable response shape consumed by desktop recovery and other clients. */
export interface SessionTitlesResponse {
  readonly items: readonly SessionTitleItem[];
  readonly errors: readonly SessionTitleError[];
}

/** Register the read-only route after Connection authentication is mounted. */
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

/** Decode and bound the product request before any persistence query. */
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

/** List the exact logical corpus owned by the injected Workspace persistence. */
async function visibleSessionIds(query: SessionQueryEngine, signal: AbortSignal): Promise<Set<string>> {
  const records = await query.listSessions(signal);
  return new Set(records
    // Match the upstream Session Controller's visible-list rule. Workspace
    // persistence already scopes this corpus; a child Session with a recorded
    // cwd remains visible to the same authorized recovery client.
    .filter(record => record.header.cwd !== undefined)
    .map(record => record.header.id));
}

/** Convert upstream fulfilled/rejected observations without exposing failures. */
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

/** Preserve only the stable title projection fields needed by clients. */
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
