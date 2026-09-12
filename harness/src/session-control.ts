// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Session ownership actions                        │
// │ Role: Expose explicit takeover through the upstream resume API.     │
// │ 模块职责：显式接管会话写权限，恢复仍交给上游 Session Controller。    │
// └─────────────────────────────────────────────────────────────────────┘
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { SessionAlreadyOwnedError, SessionOwnershipLostError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import CyreneSessionPersistence from './persistence.ts';
import { decodeHandle, integer, record } from './persistence-wire.ts';

export const name = 'cyrene-session-control';
export const inject = ['connection', 'sessionController', 'sessionPersistence', 'agents'];

/** Read-only product route for confirming that a submitted input is durable. */
export const INPUT_RECEIPTS_PATH = '/api/cyrene/session/input-receipts';
export const MAX_INPUT_RECEIPT_IDS = 8;
export const MAX_INPUT_RECEIPT_EVENTS = 4096;
const MAX_INPUT_RECEIPT_REQUEST_BYTES = 8 * 1024;
const MAX_INPUT_RECEIPT_IDENTIFIER_BYTES = 512;

/** Bounded receipt query accepted by the authenticated Connection route. */
export interface InputReceiptRequest {
  readonly sessionId: string;
  readonly requestIds: readonly string[];
}

/** Durable completion facts returned to the mounted client. */
export interface InputReceiptResponse {
  readonly sessionId: SessionId;
  readonly eventCount: number;
  readonly completedRequestIds: readonly string[];
}

/** Host Connection supplies cookie/origin authentication for both actions. */
export function apply(ctx: Context): void {
  for (const action of ['observe', 'takeover'] as const) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/cyrene/session/${action}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => ownershipAction(ctx, action, request),
      }), `cyrene-session-control: ${action}`);
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: INPUT_RECEIPTS_PATH,
    methods: ['POST'],
    // Let the bounded handler consume the carrier incrementally. A buffered
    // Connection route would first retain the bridge's much larger generic
    // body cap before this product-specific 8 KiB limit could run.
    requestBody: 'streaming',
    fetch: request => inputReceiptsRequest(ctx.sessionPersistence, request),
  }), 'cyrene-session-control: input receipts');
}

/**
 * Confirm only completed user inputs present in the durable Cyrene event log.
 *
 * The live DSH Session and SessionQuery services are intentionally excluded:
 * an in-memory event can arrive before the persistence flush acknowledgement.
 * The read handle is opened after stat and closed on every path; this route
 * never claims ownership, appends events, resumes an Agent, or returns raw
 * history.
 */
export async function inputReceiptsRequest(
  persistence: SessionPersistence,
  request: Request,
): Promise<Response> {
  try {
    if (request.method !== 'POST') {
      return problem(405, 'METHOD_NOT_ALLOWED', 'Use POST for durable input receipts.');
    }
    request.signal.throwIfAborted();
    const input = await decodeInputReceiptRequest(request);
    const id = SessionId(input.sessionId);
    const snapshot = await persistence.stat(id, { signal: request.signal });
    if (snapshot === undefined) return problem(404, 'SESSION_NOT_FOUND', 'Session not found in this Workspace.');
    const eventCount = snapshot.eventCount;
    if (eventCount === undefined || !Number.isSafeInteger(eventCount) || eventCount < 0) {
      return problem(503, 'INPUT_RECEIPT_READ_FAILED', 'Durable input receipts are temporarily unavailable.');
    }

    const reader = await persistence.open(id, 'read', { signal: request.signal });
    try {
      const offset = Math.max(0, eventCount - MAX_INPUT_RECEIPT_EVENTS);
      // `stat` is the snapshot boundary. A concurrent append may grow the
      // backend before this read starts; never classify events beyond the
      // observed prefix as if they belonged to the same receipt observation.
      const length = Math.min(MAX_INPUT_RECEIPT_EVENTS, eventCount - offset);
      const events = await reader.read(offset, length, { signal: request.signal });
      request.signal.throwIfAborted();
      return Response.json({
        sessionId: id,
        eventCount,
        completedRequestIds: completedRequestIds(events, new Set(input.requestIds)),
      } satisfies InputReceiptResponse);
    } finally {
      await reader.close();
    }
  } catch (error) {
    if (request.signal.aborted || isAbortError(error)) throw error;
    if (error instanceof SessionPersistenceNotFoundError) {
      return problem(404, 'SESSION_NOT_FOUND', 'Session not found in this Workspace.');
    }
    if (isHttpError(error)) return problem(error.status, error.code, error.message);
    return problem(503, 'INPUT_RECEIPT_READ_FAILED', 'Durable input receipts are temporarily unavailable.');
  }
}

/** Decode and bound receipt input before opening a backend handle. */
async function decodeInputReceiptRequest(request: Request): Promise<InputReceiptRequest> {
  const text = await readBoundedBody(request);
  let body: Record<string, unknown>;
  try {
    body = record(JSON.parse(text));
  } catch {
    throw httpError(400, 'INVALID_REQUEST', 'Expected a JSON object.');
  }
  if (typeof body.sessionId !== 'string' || !validIdentifier(body.sessionId)) {
    throw httpError(400, 'INVALID_SESSION_ID', 'A Session ID is required.');
  }
  if (!Array.isArray(body.requestIds)
    || body.requestIds.length === 0
    || body.requestIds.length > MAX_INPUT_RECEIPT_IDS) {
    throw httpError(400, 'INVALID_REQUEST_IDS', 'Supply between 1 and 8 request IDs.');
  }
  const requestIds: string[] = [];
  const seen = new Set<string>();
  for (const value of body.requestIds) {
    if (typeof value !== 'string' || !validIdentifier(value)) {
      throw httpError(400, 'INVALID_REQUEST_ID', 'Each request ID must be a non-empty string of at most 512 bytes.');
    }
    if (!seen.has(value)) {
      seen.add(value);
      requestIds.push(value);
    }
  }
  return { sessionId: body.sessionId, requestIds };
}

/**
 * Consume a streaming request body while retaining at most the product cap.
 * The Connection bridge must register this route as `streaming`; otherwise a
 * generic bridge buffer would run before this guard and defeat the bound.
 */
async function readBoundedBody(request: Request): Promise<string> {
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      received += chunk.byteLength;
      if (received > MAX_INPUT_RECEIPT_REQUEST_BYTES) {
        // Do not let a misbehaving body source delay the bounded 413 response;
        // the HTTP bridge closes the unread carrier after the handler returns.
        void reader.cancel().catch(() => {});
        throw httpError(413, 'REQUEST_TOO_LARGE', 'The input receipt request exceeds 8 KiB.');
      }
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, received).toString('utf8');
}

/** Match only a durable turn/start, user/message, and completed turn/end. */
function completedRequestIds(events: readonly SessionEvent[], requested: ReadonlySet<string>): string[] {
  const completed = new Set<string>();
  let active: { turn: number; requestIds: Set<string> } | undefined;
  for (const event of events) {
    if (event.type === 'turn/start') {
      const data = object(event.data);
      const turn = nonNegativeInteger(data?.turn);
      active = turn === undefined ? undefined : { turn, requestIds: new Set() };
      continue;
    }
    if (event.type === 'user/message') {
      if (active === undefined) continue;
      const data = object(event.data);
      const source = object(data?.source);
      const requestId = source?.rpcId;
      const messageTurn = data?.turn;
      if (source?.kind === 'user' && typeof requestId === 'string' && requested.has(requestId)
        && (messageTurn === undefined || messageTurn === active.turn)) {
        active.requestIds.add(requestId);
      }
      continue;
    }
    if (event.type !== 'turn/end' || active === undefined) continue;
    const data = object(event.data);
    const turn = nonNegativeInteger(data?.turn);
    const reason = object(data?.reason);
    if (turn === active.turn && reason?.kind === 'completed') {
      for (const requestId of active.requestIds) completed.add(requestId);
    }
    // Any terminal event closes the currently tracked turn. A failed,
    // cancelled, or mismatched terminal cannot carry a receipt forward.
    active = undefined;
  }
  return [...requested].filter(requestId => completed.has(requestId));
}

/** Keep malformed opaque event payloads fail-closed during classification. */
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_INPUT_RECEIPT_IDENTIFIER_BYTES;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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

/** Read ownership or explicitly resume with one backend-fenced writer. */
export async function ownershipAction(ctx: Context, action: 'observe' | 'takeover', request: Request): Promise<Response> {
  try {
    if (request.method !== 'POST') return problem(405, 'METHOD_NOT_ALLOWED', 'Use POST for Session ownership actions.');
    const text = await request.text();
    if (Buffer.byteLength(text) > 8192) return problem(413, 'REQUEST_TOO_LARGE', 'The ownership request exceeds 8 KiB.');
    let body: Record<string, unknown>;
    try { body = record(JSON.parse(text)); }
    catch { return problem(400, 'INVALID_REQUEST', 'Expected a JSON object.'); }
    if (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 512) {
      return problem(400, 'INVALID_SESSION_ID', 'A Session ID is required.');
    }
    const id = SessionId(body.sessionId);
    const persistence = ctx.sessionPersistence;
    if (!(persistence instanceof CyreneSessionPersistence)) throw new Error('Cyrene persistence is required');
    const observation = decodeHandle(await persistence.http.request(`/${encodeURIComponent(id)}/handles`, {
      access: 'read', clientId: persistence.clientId,
    }, request.signal), id);
    if (action === 'observe') {
      return Response.json({
        sessionId: id, workspaceId: persistence.config.workspaceId,
        epoch: observation.epoch, localWriter: persistence.owns(id, observation.epoch),
        eventCount: observation.nextSeq, cwd: observation.header.cwd,
        agentPreset: observation.header.agentPreset,
      });
    }
    let expectedEpoch: number;
    try { expectedEpoch = integer(body.expectedEpoch, 'expectedEpoch'); }
    catch { return problem(400, 'EXPECTED_EPOCH_REQUIRED', 'Supply the ownership epoch shown by observe.'); }
    if (expectedEpoch !== observation.epoch) {
      return problem(409, 'SESSION_OWNERSHIP_CHANGED', 'Session ownership changed; observe it again before taking over.');
    }
    if (persistence.owns(id) || ctx.agents.get(id)) {
      return problem(409, 'SESSION_ALREADY_LOCAL', 'This runtime already has the Session open. Reopen the desktop runtime if its writer was fenced.');
    }
    const cwd = observation.header.cwd;
    if (!cwd || !isAbsolute(cwd) || !(await stat(cwd).catch(() => undefined))?.isDirectory()) {
      return problem(409, 'SESSION_WORKSPACE_UNAVAILABLE', 'The recorded working directory is unavailable on this device. Import or continue in a selected local workspace.');
    }
    const result = await persistence.resumeWithTakeover(id, expectedEpoch, () => ctx.sessionController.create({
      sessionId: id, cwd,
      ...(observation.header.agentPreset === undefined ? {} : { agentPreset: observation.header.agentPreset }),
    }), request.signal);
    return Response.json({ ...result, ownership: 'writer', previousEpoch: expectedEpoch });
  } catch (error) {
    if (error instanceof SessionPersistenceNotFoundError) return problem(404, 'SESSION_NOT_FOUND', 'Session not found in this workspace.');
    if (error instanceof SessionAlreadyOwnedError || error instanceof SessionOwnershipLostError) {
      return problem(409, 'SESSION_OWNERSHIP_CHANGED', 'Another client changed Session ownership. Observe again before retrying.');
    }
    let diagnostic = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
    for (const [key, value] of Object.entries(process.env)) {
      if (value && /TOKEN|SECRET|PASSWORD|KEY/.test(key)) diagnostic = diagnostic.replaceAll(value, '[redacted]');
    }
    diagnostic = diagnostic.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 384);
    ctx.logger.error(`Cyrene Session ownership action failed: ${diagnostic}`);
    return problem(503, 'SESSION_ACTION_FAILED', `Session resume failed: ${diagnostic}. Read the current Session state before retrying.`);
  }
}

function problem(status: number, code: string, detail: string): Response {
  return Response.json({ type: `urn:cyrene:navigator:${code.toLowerCase()}`, title: code, status, code, detail },
    { status, headers: { 'Content-Type': 'application/problem+json' } });
}
