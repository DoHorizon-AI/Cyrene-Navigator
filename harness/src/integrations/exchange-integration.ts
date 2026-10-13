// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Exchange issue integration                         │
// │ Role: Register fixed, typed Exchange issue tools on the DSH runtime. │
// │                                                                      │
// │ 模块职责：通过固定 REST 契约注册 Exchange issue 工具。                 │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { WorkAssistantBridge } from '../work-tools.js';

const REQUEST_TIMEOUT_MS = 15_000;
const QUERY_POLL_WINDOW_MS = 3_000;
const QUERY_POLL_INTERVAL_MS = 500;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_COMMENT_LENGTH = 4_000;
const API_PREFIX = '/api/v1/integrations';
const ISSUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const EXCHANGE_ISSUE_STATES = Object.freeze(['OPEN', 'CLOSED'] as const);
export const EXCHANGE_ISSUE_SNAPSHOT_FRESHNESS = Object.freeze(['FRESH', 'STALE', 'UNKNOWN'] as const);
export const EXCHANGE_ISSUE_OPERATION_STATES = Object.freeze([
  'QUEUED', 'AWAITING_AUTHORITY', 'RUNNING', 'ACCEPTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN',
] as const);
/** Owner operation IDs and paths consumed by Navigator's fixed issue tools. */
export const EXCHANGE_ISSUE_CONSUMER_OPERATIONS = Object.freeze({
  query: {
    operationId: 'integrationQueryIssue',
    method: 'POST',
    path: `${API_PREFIX}/sync-bindings/{binding_id}/issues/actions/query`,
  },
  snapshot: {
    operationId: 'integrationGetIssue',
    method: 'POST',
    path: `${API_PREFIX}/sync-bindings/{binding_id}/issues/actions/snapshot`,
  },
  operationRead: {
    operationId: 'integrationGetOperation',
    method: 'GET',
    path: `${API_PREFIX}/operations/{operation_id}`,
  },
  comment: {
    operationId: 'integrationCreateIssueComment',
    method: 'POST',
    path: `${API_PREFIX}/sync-bindings/{binding_id}/issues/actions/comment`,
  },
  state: {
    operationId: 'integrationUpdateIssueState',
    method: 'POST',
    path: `${API_PREFIX}/sync-bindings/{binding_id}/issues/actions/state`,
  },
});
const OPERATION_OUTPUT_PROPERTIES = {
  operationId: { type: 'string', required: true },
  action: { type: 'string', required: true },
  state: {
    type: 'string', required: true,
    enum: EXCHANGE_ISSUE_OPERATION_STATES,
  },
  issueNumber: { type: 'integer', required: true },
  createdAt: { type: 'string', required: true },
  updatedAt: { type: 'string', required: true },
  result: {
    oneOf: [
      { type: 'object', additionalProperties: true },
      { type: 'null' },
    ],
    required: true,
  },
} as const;
const OPERATION_STATES: ReadonlySet<string> = new Set(EXCHANGE_ISSUE_OPERATION_STATES);

/** Current first-party user Bearer obtained for one active Navigator session. */
export type TrustedUserBearerProvider = (
  sessionId: string,
  workspaceId: string,
  signal: AbortSignal,
) => string | undefined | Promise<string | undefined>;

/** Bind the internal CLI Bearer to exactly one preconfigured runtime session. */
export function environmentExchangeUserBearerProvider(
  trustedSessionId: string | undefined,
  trustedWorkspaceId: string | undefined,
): TrustedUserBearerProvider | undefined {
  if (!trustedSessionId || !safeText(trustedSessionId, 200)
    || !trustedWorkspaceId || !safeText(trustedWorkspaceId, 200)) return undefined;
  return (sessionId, workspaceId, signal) => {
    signal.throwIfAborted();
    if (sessionId !== trustedSessionId || workspaceId !== trustedWorkspaceId) return undefined;
    return process.env.CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN;
  };
}

/** Resolve a host provider first; env credentials require explicit CLI binding mode. */
export function resolveExchangeUserBearerProvider(
  hostProvider: TrustedUserBearerProvider | undefined,
  allowSingleSessionCliEnvironmentBearer: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): TrustedUserBearerProvider {
  if (hostProvider) return hostProvider;
  const unavailable: TrustedUserBearerProvider = () => undefined;
  if (!allowSingleSessionCliEnvironmentBearer) return unavailable;
  return environmentExchangeUserBearerProvider(
    environment.CYRENE_EXCHANGE_INTEGRATION_SESSION_ID,
    environment.CYRENE_EXCHANGE_INTEGRATION_WORKSPACE_ID,
  ) ?? unavailable;
}

/** Host-owned Exchange configuration and existing human approval bridge. */
export interface ExchangeIssueToolOptions {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly trustedUserBearerProvider: TrustedUserBearerProvider;
  readonly approvalBridge: Pick<WorkAssistantBridge, 'requestApproval'>;
  readonly taskIdForSession: (sessionId: string) => string | undefined;
}

/** Read-only issue projection returned by the Exchange REST contract. */
export interface ExchangeIssueProjection {
  readonly issueNumber: number;
  readonly state: ExchangeIssueState;
  readonly title: string;
  readonly version: string;
  readonly freshness: ExchangeIssueSnapshotFreshness;
  readonly observedAt: string;
}

/** Result of a bounded asynchronous issue read. */
export interface ExchangeIssueQueryResult {
  readonly status: 'completed' | 'pending' | 'failed' | 'unknown' | 'snapshot-unavailable';
  readonly operation: QueuedOperation;
  readonly issue?: ExchangeIssueProjection;
}

/** Sanitized state projection returned by Exchange after a write is queued. */
export interface ExchangeOperationProjection {
  readonly operationId: string;
  readonly action: string;
  readonly state: ExchangeOperationState;
  readonly issueNumber: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result: Readonly<Record<string, JsonValue>> | null;
}

/** Durable operation states exposed by Exchange's issue workflow. */
export type ExchangeIssueState = typeof EXCHANGE_ISSUE_STATES[number];
export type ExchangeIssueSnapshotFreshness = typeof EXCHANGE_ISSUE_SNAPSHOT_FRESHNESS[number];
export type ExchangeOperationState = typeof EXCHANGE_ISSUE_OPERATION_STATES[number];

interface RequestIdentity {
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

interface QueuedOperation extends ExchangeOperationProjection {
  readonly location: string;
}

/**
 * Call only the fixed issue and operation routes owned by Exchange.
 * The current user token is fetched for every request and held only in its
 * Authorization header; Navigator does not store or accept identity claims.
 */
export class ExchangeIntegrationClient {
  private readonly origin: string;

  constructor(
    private readonly options: Pick<ExchangeIssueToolOptions, 'baseUrl' | 'workspaceId' | 'trustedUserBearerProvider'>,
  ) {
    const endpoint = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash) {
      throw new TypeError('Invalid Exchange integration base URL');
    }
    if (endpoint.protocol !== 'https:' && !isLoopbackHost(endpoint.hostname)) {
      throw new TypeError('Exchange integration requires HTTPS outside loopback');
    }
    if (endpoint.pathname !== '/') throw new TypeError('Exchange integration base URL must be the Exchange API origin');
    if (!safeText(options.workspaceId, 200) || options.workspaceId.trim() !== options.workspaceId) {
      throw new TypeError('Invalid Exchange integration Workspace');
    }
    this.origin = endpoint.origin;
  }

  /** Enqueue a delegated issue read, poll briefly, and return a cached snapshot only on success. */
  async queryIssue(
    bindingId: string,
    issueNumber: number,
    idempotencyKey: string,
    identity: RequestIdentity,
  ): Promise<ExchangeIssueQueryResult> {
    assertUuid(bindingId, 'sync binding id');
    assertIssueNumber(issueNumber);
    assertIdempotencyKey(idempotencyKey);
    const queued = await this.queueWrite(
      routePath(EXCHANGE_ISSUE_CONSUMER_OPERATIONS.query.path, 'binding_id', bindingId),
      { issueNumber }, idempotencyKey, identity,
    );
    let current: QueuedOperation = queued;
    const deadline = Date.now() + QUERY_POLL_WINDOW_MS;
    while (Date.now() < deadline && !identity.signal.aborted) {
      if (current.state === 'AWAITING_AUTHORITY' || current.state === 'FAILED' || current.state === 'UNKNOWN') {
        return { status: queryStatus(current.state), operation: current };
      }
      if (current.state === 'SUCCEEDED') return this.queryResultWithSnapshot(bindingId, issueNumber, current, identity);
      try {
        await delay(Math.min(QUERY_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), undefined, {
          signal: identity.signal,
        });
        current = { ...await this.getOperation(queued.operationId, identity), location: queued.location };
      } catch {
        if (identity.signal.aborted) break;
        return { status: 'pending', operation: current };
      }
    }
    if (current.state === 'SUCCEEDED') return this.queryResultWithSnapshot(bindingId, issueNumber, current, identity);
    return { status: queryStatus(current.state), operation: current };
  }

  /** Read an Exchange-owned safe issue snapshot after a query operation succeeds. */
  async getIssueSnapshot(
    bindingId: string,
    issueNumber: number,
    identity: RequestIdentity,
  ): Promise<ExchangeIssueProjection> {
    assertUuid(bindingId, 'sync binding id');
    assertIssueNumber(issueNumber);
    const { payload } = await this.request(
      routePath(EXCHANGE_ISSUE_CONSUMER_OPERATIONS.snapshot.path, 'binding_id', bindingId),
      identity,
      { method: 'POST', body: JSON.stringify({ issueNumber }), headers: { 'content-type': 'application/json' } },
    );
    return parseIssueProjection(payload, issueNumber);
  }

  /** Queue one comment with a stable, call-scoped idempotency key. */
  async createIssueComment(
    bindingId: string,
    issueNumber: number,
    body: string,
    idempotencyKey: string,
    identity: RequestIdentity,
  ): Promise<QueuedOperation> {
    assertUuid(bindingId, 'sync binding id');
    assertIssueNumber(issueNumber);
    assertComment(body);
    assertIdempotencyKey(idempotencyKey);
    return this.queueWrite(
      routePath(EXCHANGE_ISSUE_CONSUMER_OPERATIONS.comment.path, 'binding_id', bindingId),
      { issueNumber, body }, idempotencyKey, identity,
    );
  }

  /** Queue one OPEN/CLOSED transition with a stable, call-scoped idempotency key. */
  async updateIssueState(
    bindingId: string,
    issueNumber: number,
    state: ExchangeIssueState,
    idempotencyKey: string,
    identity: RequestIdentity,
  ): Promise<QueuedOperation> {
    assertUuid(bindingId, 'sync binding id');
    assertIssueNumber(issueNumber);
    if (!EXCHANGE_ISSUE_STATES.includes(state)) throw new TypeError('Issue state is invalid');
    assertIdempotencyKey(idempotencyKey);
    return this.queueWrite(
      routePath(EXCHANGE_ISSUE_CONSUMER_OPERATIONS.state.path, 'binding_id', bindingId),
      { issueNumber, state }, idempotencyKey, identity,
    );
  }

  /** Read only the sanitized operation state owned by Exchange. */
  async getOperation(operationId: string, identity: RequestIdentity): Promise<ExchangeOperationProjection> {
    assertUuid(operationId, 'operation id');
    const { payload } = await this.request(
      routePath(EXCHANGE_ISSUE_CONSUMER_OPERATIONS.operationRead.path, 'operation_id', operationId),
      identity,
    );
    const operation = parseOperationProjection(payload);
    if (operation.operationId !== operationId) throw new TypeError('Exchange operation response does not match the requested operation');
    return operation;
  }

  /** Submit one fixed write route and validate its Product-owned 202 Location. */
  private async queueWrite(
    path: string,
    body: Record<string, unknown> | undefined,
    idempotencyKey: string,
    identity: RequestIdentity,
  ): Promise<QueuedOperation> {
    const { payload, response } = await this.request(path, identity, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'idempotency-key': idempotencyKey,
      },
    });
    if (response.status !== 202) throw new Error(`Exchange returned an unexpected write status (${response.status})`);
    const operation = parseOperationProjection(payload);
    const location = response.headers.get('location');
    if (!location || !isOperationLocation(location, this.url(`${API_PREFIX}/operations/${operation.operationId}`))) {
      throw new TypeError('Exchange returned an invalid operation Location');
    }
    return { ...operation, location };
  }

  /** Add the Exchange snapshot only after the async read operation reports success. */
  private async queryResultWithSnapshot(
    bindingId: string,
    issueNumber: number,
    operation: QueuedOperation,
    identity: RequestIdentity,
  ): Promise<ExchangeIssueQueryResult> {
    try {
      const issue = await this.getIssueSnapshot(bindingId, issueNumber, identity);
      return { status: 'completed', operation, issue };
    } catch {
      return { status: 'snapshot-unavailable', operation };
    }
  }

  /** Send one authenticated call to the configured Exchange origin and route prefix. */
  private async request(
    path: string,
    identity: RequestIdentity,
    init?: { readonly method?: string; readonly body?: string; readonly headers?: Record<string, string> },
  ): Promise<{ readonly payload: unknown; readonly response: Response }> {
    let bearer: string | undefined;
    try {
      bearer = await this.options.trustedUserBearerProvider(
        identity.sessionId, this.options.workspaceId, identity.signal,
      );
    } catch {
      if (identity.signal.aborted) throw abortError(identity.signal);
      throw new Error('The current first-party Exchange identity is unavailable for this session');
    }
    if (!bearer || !/^[\x21-\x7e]{1,16384}$/u.test(bearer)) {
      throw new Error('The current first-party Exchange identity is unavailable for this session');
    }

    let response: Response;
    try {
      response = await fetch(this.url(path), {
        method: init?.method ?? 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${bearer}`,
          'x-cyrene-workspace-id': this.options.workspaceId,
          ...init?.headers,
        },
        ...(init?.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.any([identity.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        redirect: 'error',
      });
    } catch {
      if (identity.signal.aborted) throw abortError(identity.signal);
      throw new Error('Exchange integration request could not be completed');
    }

    const payload = await readResponse(response);
    if (!response.ok && response.status !== 202) {
      throw new Error(`Exchange integration request failed (${response.status})`);
    }
    return { payload, response };
  }

  /** Construct a fixed API path under the host-configured Exchange origin. */
  private url(path: string): string {
    return `${this.origin}${path}`;
  }
}

/** Register fixed issue query, approval-gated writes, and operation read tools. */
export function registerExchangeIssueTools(
  ctx: Context,
  options: ExchangeIssueToolOptions,
): () => void {
  const client = new ExchangeIntegrationClient(options);
  const registrations = [
    ctx.tools.register(defineTool({
      name: 'exchange_issue_query',
      description: 'Read one issue from a configured Exchange sync binding using the current verified user identity.',
      parameters: {
        bindingId: { type: 'string', required: true, description: 'Exchange sync binding UUID.' },
        issueNumber: { type: 'integer', required: true, description: 'Positive issue number.' },
      },
      output: issueQueryOutput,
      execute: async (args, execution) => {
        const identity = requestIdentity(execution);
        return client.queryIssue(
          stringArg(args.bindingId, 'binding id'),
          integerArg(args.issueNumber, 'issue number'),
          idempotencyKey('query', identity.sessionId, String(execution.callId)),
          identity,
        );
      },
    })),
    ctx.tools.register(defineTool({
      name: 'exchange_issue_comment',
      description: 'After human approval, queue one GitHub issue comment in Exchange. A queued response is not a completed delivery.',
      parameters: {
        bindingId: { type: 'string', required: true, description: 'Exchange sync binding UUID.' },
        issueNumber: { type: 'integer', required: true, description: 'Positive issue number.' },
        body: { type: 'string', required: true, description: 'Non-empty comment, up to 4,000 Unicode characters.' },
      },
      output: queuedOperationOutput,
      execute: async (args, execution) => {
        const identity = requestIdentity(execution);
        requireActiveTask(options, identity.sessionId);
        const bindingId = stringArg(args.bindingId, 'binding id');
        const issueNumber = integerArg(args.issueNumber, 'issue number');
        const body = stringArg(args.body, 'comment body');
        assertUuid(bindingId, 'sync binding id');
        assertIssueNumber(issueNumber);
        assertComment(body);
        await options.approvalBridge.requestApproval(
          identity.sessionId,
          'exchange.integration.issue.comment',
          `Queue a GitHub issue comment through Exchange`,
          { bindingId, issueNumber, body },
          execution.signal,
          String(execution.callId),
        );
        return client.createIssueComment(
          bindingId, issueNumber, body, idempotencyKey('comment', identity.sessionId, String(execution.callId)), identity,
        );
      },
    })),
    ctx.tools.register(defineTool({
      name: 'exchange_issue_state_update',
      description: 'After human approval, queue an OPEN or CLOSED issue state change in Exchange. A queued response is not a completed update.',
      parameters: {
        bindingId: { type: 'string', required: true, description: 'Exchange sync binding UUID.' },
        issueNumber: { type: 'integer', required: true, description: 'Positive issue number.' },
        state: { type: 'string', required: true, enum: EXCHANGE_ISSUE_STATES },
      },
      output: queuedOperationOutput,
      execute: async (args, execution) => {
        const identity = requestIdentity(execution);
        requireActiveTask(options, identity.sessionId);
        const bindingId = stringArg(args.bindingId, 'binding id');
        const issueNumber = integerArg(args.issueNumber, 'issue number');
        const state = stringArg(args.state, 'issue state');
        assertUuid(bindingId, 'sync binding id');
        assertIssueNumber(issueNumber);
        if (!EXCHANGE_ISSUE_STATES.includes(state as ExchangeIssueState)) {
          throw new TypeError('Issue state is invalid');
        }
        await options.approvalBridge.requestApproval(
          identity.sessionId,
          'exchange.integration.issue.state',
          `Queue a GitHub issue state change through Exchange`,
          { bindingId, issueNumber, state },
          execution.signal,
          String(execution.callId),
        );
        return client.updateIssueState(
          bindingId, issueNumber, state as ExchangeIssueState,
          idempotencyKey('state', identity.sessionId, String(execution.callId)), identity,
        );
      },
    })),
    ctx.tools.register(defineTool({
      name: 'exchange_operation_read',
      description: 'Read the Exchange status of a previously queued integration operation.',
      parameters: { operationId: { type: 'string', required: true, description: 'Exchange operation UUID.' } },
      output: jsonOutput,
      execute: (args, execution) => client.getOperation(
        stringArg(args.operationId, 'operation id'), requestIdentity(execution),
      ),
    })),
  ];

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const unregister of registrations.reverse()) unregister();
  };
  ctx.effect(() => dispose, 'navigator.exchangeIssueTools');
  return dispose;
}

const jsonOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: OPERATION_OUTPUT_PROPERTIES,
  } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

const queuedOperationOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { ...OPERATION_OUTPUT_PROPERTIES, location: { type: 'string', required: true } },
  } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

const issueQueryOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', required: true, enum: ['completed', 'pending', 'failed', 'unknown', 'snapshot-unavailable'] },
      operation: {
        type: 'object',
        additionalProperties: false,
        properties: { ...OPERATION_OUTPUT_PROPERTIES, location: { type: 'string', required: true } },
        required: true,
      },
      issue: {
        type: 'object',
        additionalProperties: false,
        properties: {
          issueNumber: { type: 'integer', required: true },
          state: { type: 'string', required: true, enum: EXCHANGE_ISSUE_STATES },
          title: { type: 'string', required: true },
          version: { type: 'string', required: true },
          freshness: { type: 'string', required: true, enum: EXCHANGE_ISSUE_SNAPSHOT_FRESHNESS },
          observedAt: { type: 'string', required: true },
        },
      },
    },
  } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

/** Construct the per-call identity context from the actual DSH execution. */
function requestIdentity(execution: ToolRunContext): RequestIdentity {
  const sessionId = execution.agent?.session.id;
  if (sessionId === undefined || sessionId === null || String(sessionId).length === 0) {
    throw new Error('Exchange integration tools require the active Navigator session');
  }
  return { sessionId: String(sessionId), signal: execution.signal };
}

/** Require a durable task before requesting human approval for a write. */
function requireActiveTask(options: ExchangeIssueToolOptions, sessionId: string): void {
  if (!options.taskIdForSession(sessionId)) throw new Error('Exchange issue writes require an active durable Navigator task');
}

/** Derive a repeatable key for one DSH call without persisting action data. */
function idempotencyKey(action: string, sessionId: string, callId: string): string {
  const digest = createHash('sha256').update(sessionId).update('\0').update(action).update('\0').update(callId).digest('hex');
  return `navigator-exchange-v1:${digest}`;
}

/** Validate and project the GitHub issue fields Exchange permits to escape. */
function parseIssueProjection(value: unknown, expectedIssueNumber: number): ExchangeIssueProjection {
  const row = objectValue(value, 'Exchange issue response');
  const issueNumber = integerArg(row.issueNumber, 'issue number');
  assertIssueNumber(issueNumber);
  if (issueNumber !== expectedIssueNumber) throw new TypeError('Exchange issue response does not match the requested issue');
  const state = textField(row.state, 'issue state', 16);
  if (!EXCHANGE_ISSUE_STATES.includes(state as ExchangeIssueState)) {
    throw new TypeError('Exchange issue response has an invalid state');
  }
  const title = textField(row.title, 'issue title', 1_000);
  const version = textField(row.version, 'issue version', 128);
  const freshness = textField(row.freshness, 'issue freshness', 16);
  if (!EXCHANGE_ISSUE_SNAPSHOT_FRESHNESS.includes(freshness as ExchangeIssueSnapshotFreshness)) {
    throw new TypeError('Exchange issue response has an invalid freshness');
  }
  const observedAt = dateField(row.observedAt, 'issue observedAt');
  return {
    issueNumber,
    state: state as ExchangeIssueState,
    title,
    version,
    freshness: freshness as ExchangeIssueSnapshotFreshness,
    observedAt,
  };
}

/** Accept only the stable, content-free operation status projection. */
function parseOperationProjection(value: unknown): ExchangeOperationProjection {
  const row = objectValue(value, 'Exchange operation response');
  const operationId = textField(row.operationId, 'operation id', 64);
  assertUuid(operationId, 'operation id');
  const state = textField(row.state, 'operation state', 32);
  if (!OPERATION_STATES.has(state)) throw new TypeError('Exchange operation response has an invalid state');
  const issueNumber = integerArg(row.issueNumber, 'issue number');
  assertIssueNumber(issueNumber);
  const createdAt = dateField(row.createdAt, 'operation createdAt');
  const updatedAt = dateField(row.updatedAt, 'operation updatedAt');
  if (!Object.hasOwn(row, 'result')) throw new TypeError('Exchange operation response omitted its result projection');
  const result = parseOperationResult(row.result);
  const action = textField(row.action, 'operation action', 128);
  return {
    operationId,
    action,
    state: state as ExchangeOperationState,
    issueNumber,
    createdAt,
    updatedAt,
    result,
  };
}

/** Restrict terminal result data to the Exchange allowlisted summary fields. */
function parseOperationResult(value: unknown): Readonly<Record<string, JsonValue>> | null {
  if (value === null) return null;
  const row = objectValue(value, 'Exchange operation result');
  const allowed = new Set([
    'accepted', 'observedAt', 'observedState', 'reasonCode', 'reconciledReadOnly', 'state', 'status', 'succeeded', 'version',
  ]);
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(row)) {
    if (!allowed.has(key)) continue;
    if (typeof item === 'string') result[key] = textField(item, `operation result ${key}`, 512);
    else if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) result[key] = item;
    else throw new TypeError('Exchange operation response contains an invalid result value');
  }
  return Object.freeze(result);
}

/** Translate only terminal operation states into a user-facing query status. */
function queryStatus(state: ExchangeOperationState): ExchangeIssueQueryResult['status'] {
  if (state === 'SUCCEEDED') return 'completed';
  if (state === 'FAILED') return 'failed';
  if (state === 'UNKNOWN') return 'unknown';
  return 'pending';
}

/** Read a bounded JSON response without exposing remote error detail. */
async function readResponse(response: Response): Promise<unknown> {
  const advertisedLength = response.headers.get('content-length');
  if (advertisedLength && Number(advertisedLength) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new TypeError('Exchange integration response exceeds its configured limit');
  }
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TypeError('Exchange integration response exceeds its configured limit');
      }
      chunks.push(value);
    }
  } catch (error: unknown) {
    if (error instanceof TypeError && error.message === 'Exchange integration response exceeds its configured limit') {
      throw error;
    }
    await reader.cancel().catch(() => undefined);
    throw new Error('Exchange integration response could not be read');
  } finally {
    reader.releaseLock();
  }
  if (byteLength === 0) return {};
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new TypeError('Exchange integration returned invalid JSON');
  }
}

/** Confirm the 202 Location points to the same configured Exchange operation. */
function isOperationLocation(location: string, expected: string): boolean {
  try {
    const actualUrl = new URL(location, expected);
    const expectedUrl = new URL(expected);
    return !actualUrl.username && !actualUrl.password
      && actualUrl.origin === expectedUrl.origin
      && actualUrl.pathname === expectedUrl.pathname
      && actualUrl.search === ''
      && actualUrl.hash === '';
  } catch {
    return false;
  }
}

/** Fill one owner-declared route parameter after the caller validates its ID. */
function routePath(
  template: string,
  parameter: 'binding_id' | 'operation_id',
  value: string,
): string {
  const marker = `{${parameter}}`;
  if (!template.includes(marker)) throw new TypeError('Exchange consumer route is invalid');
  return template.replace(marker, encodeURIComponent(value));
}

/** Validate a UUID before it can select one Exchange-owned resource. */
function assertUuid(value: string, label: string): void {
  if (!ISSUE_ID.test(value)) throw new TypeError(`${label} must be a UUID`);
}

/** Require a positive JSON/API issue number. */
function assertIssueNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Issue number must be a positive integer');
}

/** Bound comments to the Exchange contract's request schema. */
function assertComment(value: string): void {
  if (!value.trim() || Array.from(value).length > MAX_COMMENT_LENGTH) {
    throw new TypeError('Issue comment must be non-empty and within the Exchange size limit');
  }
}

/** Validate the required idempotency header value. */
function assertIdempotencyKey(value: string): void {
  if (!safeText(value, 200) || !value.trim()) throw new TypeError('Idempotency key is invalid');
}

/** Read one typed string argument without coercing model-supplied values. */
function stringArg(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`);
  return value;
}

/** Read one typed positive integer argument. */
function integerArg(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`${label} must be an integer`);
  return value;
}

/** Require a bounded string field from an Exchange response. */
function textField(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || !safeText(value, maxBytes)) throw new TypeError(`Exchange ${label} is invalid`);
  return value;
}

/** Check UTF-8 size and reject control characters at identity/text boundaries. */
function safeText(value: string, maxBytes: number): boolean {
  return value.length > 0 && new TextEncoder().encode(value).byteLength <= maxBytes && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Require an ISO timestamp while preserving the owner's original value. */
function dateField(value: unknown, label: string): string {
  const text = textField(value, label, 64);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`Exchange ${label} is invalid`);
  return text;
}

/** Require a plain object at an untrusted API boundary. */
function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Use only loopback HTTP for local fixtures; remote Exchange endpoints require TLS. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Preserve cancellation errors without including request credentials. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
}
