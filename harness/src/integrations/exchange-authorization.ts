// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Exchange authorization integration                │
// │ Role: Consume fixed, actor-scoped authorization and cloud-read APIs. │
// │                                                                      │
// │ 模块职责：消费固定且按调用者隔离的授权与云资源读取 API。                 │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { WorkAssistantBridge } from '../work-tools.js';
import type { TrustedUserBearerProvider } from './exchange-integration.js';

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_CLOUD_RESOURCES = 500;
const MAX_ATTRIBUTE_COUNT = 64;
const MAX_ATTRIBUTE_TEXT_BYTES = 512;
const AUTHORIZATION_REFERENCE_TTL_MS = 5 * 60_000;
const REAUTHORIZATION_REQUIRED_CODE = 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED';
const EXCHANGE_OPERATION_STATES = Object.freeze([
  'QUEUED', 'AWAITING_AUTHORITY', 'RUNNING', 'ACCEPTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN',
] as const);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const EXCHANGE_PROVIDERS = Object.freeze(['github', 'wecom', 'azure', 'gcp', 'hf', 'runpod', 'tailscale'] as const);
export const EXCHANGE_SNAPSHOT_FRESHNESS = Object.freeze(['FRESH', 'STALE', 'UNKNOWN'] as const);

export const EXCHANGE_AUTHORIZATION_OPERATIONS = Object.freeze({
  connectionList: {
    operationId: 'integrationListConnections',
    method: 'GET',
    path: '/api/v1/integrations/connections',
  },
  authorizationHealth: {
    operationId: 'integrationGetAuthorizationHealth',
    method: 'GET',
    path: '/api/v1/integrations/connections/{connection_id}/authorization-health',
  },
  renewalStart: {
    operationId: 'accountBeginRenewalSession',
    method: 'POST',
    path: '/api/v1/accounts/authorizations/{authorization_id}/renewal-sessions',
  },
  renewalStatus: {
    operationId: 'accountGetRenewalSession',
    method: 'GET',
    path: '/api/v1/accounts/renewal-sessions/{session_id}',
  },
  connectionResources: {
    operationId: 'integrationListConnectionResources',
    method: 'GET',
    path: '/api/v1/integrations/connections/{connection_id}/resources',
  },
  operationRead: {
    operationId: 'integrationGetOperation',
    method: 'GET',
    path: '/api/v1/integrations/operations/{operation_id}',
  },
});

export const EXCHANGE_LOGIN_STATES = Object.freeze(['PRESENT', 'MISSING', 'UNKNOWN', 'UNAVAILABLE'] as const);
export const EXCHANGE_AUTHORIZATION_STATES = Object.freeze([
  'VALID', 'REAUTHORIZATION_REQUIRED', 'PERMISSION_DENIED', 'UNKNOWN', 'UNAVAILABLE',
] as const);
export const EXCHANGE_RENEWAL_SESSION_STATES = Object.freeze([
  'WAITING_USER', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED',
] as const);
export const EXCHANGE_CLOUD_RESOURCE_STATES = Object.freeze([
  'RUNNING', 'STOPPED', 'AVAILABLE', 'UNAVAILABLE', 'DEGRADED', 'UNKNOWN',
] as const);

export type ExchangeLoginState = typeof EXCHANGE_LOGIN_STATES[number];
export type ExchangeAuthorizationState = typeof EXCHANGE_AUTHORIZATION_STATES[number];
export type ExchangeRenewalSessionState = typeof EXCHANGE_RENEWAL_SESSION_STATES[number];
export type ExchangeCloudResourceState = typeof EXCHANGE_CLOUD_RESOURCE_STATES[number];
export type ExchangeProvider = typeof EXCHANGE_PROVIDERS[number];
export type ExchangeSnapshotFreshness = typeof EXCHANGE_SNAPSHOT_FRESHNESS[number];

/** Actor-scoped Product connection projection without binding or tenant references. */
export interface ExchangeConnectionSummary {
  readonly id: string;
  readonly provider: ExchangeProvider;
  readonly displayName: string;
  readonly repositoryId: string | null;
  readonly repositoryName: string | null;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CapabilityAuthorizationHealth {
  readonly capabilityId: string;
  readonly state: ExchangeAuthorizationState;
  readonly lastVerifiedAt: string | null;
  readonly expiresAt: string | null;
  readonly reasonCode: string | null;
}

/** Narrow current authorization projection owned by Exchange. */
export interface ExchangeAuthorizationHealth {
  readonly connectionId: string;
  readonly provider: ExchangeProvider;
  readonly authorizationRef: string | null;
  readonly loginState: ExchangeLoginState;
  readonly authorizationState: ExchangeAuthorizationState;
  readonly checkedAt: string | null;
  readonly expiresAt: string | null;
  readonly generation: number;
  readonly capabilities: readonly CapabilityAuthorizationHealth[];
  readonly reasonCode: string | null;
}

/** Renewal-session data consumed by Navigator after removing UI-only launch material. */
export interface ExchangeRenewalSession {
  readonly sessionRef: string;
  readonly authorizationRef: string;
  readonly state: ExchangeRenewalSessionState;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly authorizationUrl: string | null;
  readonly qrAttachmentRef: string | null;
  readonly generation: number;
  readonly reasonCode: string | null;
}

export interface ExchangeCloudObservation {
  readonly externalRef: string;
  readonly kind: string;
  readonly displayName: string;
  readonly status: ExchangeCloudResourceState;
  readonly providerStatus: string | null;
  readonly collectedAt: string;
  readonly observedAt: string | null;
  readonly attributes: Readonly<Record<string, JsonValue>>;
  readonly platformResourceRef: string | null;
  readonly platformGeneration: number | null;
  readonly source: string;
  readonly freshness: ExchangeSnapshotFreshness;
}

export interface ExchangeCloudQueryResult {
  readonly connectionId: string;
  readonly provider: ExchangeProvider;
  readonly checkedAt: string | null;
  readonly resources: readonly ExchangeCloudObservation[];
}

export interface ExchangeAuthorizationWaitReceipt {
  readonly callId?: string;
  readonly connectionId?: string;
  readonly code: typeof REAUTHORIZATION_REQUIRED_CODE;
  readonly source: 'authorization-health' | 'connection-resources' | 'issue-action';
  readonly authorizationRef?: string;
  readonly generation?: number;
}

export type ExchangeAuthorizationWaitReporter = (
  sessionId: string,
  receipt: ExchangeAuthorizationWaitReceipt,
) => void | Promise<void>;

export interface ExchangeAuthorizationToolOptions {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly trustedUserBearerProvider: TrustedUserBearerProvider;
  readonly approvalBridge: Pick<WorkAssistantBridge, 'requestApproval'>;
  readonly taskIdForSession: (sessionId: string) => string | undefined;
  readonly onAuthorizationRequired: ExchangeAuthorizationWaitReporter;
}

export interface ExchangeAuthorizationRequestIdentity {
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

interface ApiResponse {
  readonly payload: unknown;
  readonly response: Response;
}

/** Sanitized error for the single confirmed provider reauthorization response. */
export class ExchangeConnectionReauthorizationRequiredError extends Error {
  readonly status = 409;
  readonly code: typeof REAUTHORIZATION_REQUIRED_CODE = REAUTHORIZATION_REQUIRED_CODE;

  constructor(
    readonly connectionId?: string,
    readonly authorizationRef?: string,
  ) {
    super('The Exchange connection requires user reauthorization');
    this.name = 'ExchangeConnectionReauthorizationRequiredError';
  }
}

/** Classify only Exchange's confirmed provider-reauthorization ProblemDetails response. */
export function exchangeReauthorizationFromProblem(
  status: number,
  value: unknown,
): ExchangeConnectionReauthorizationRequiredError | undefined {
  if (status !== 409 || problemCode(value) !== REAUTHORIZATION_REQUIRED_CODE) return undefined;
  const refs = problemContext(value);
  return new ExchangeConnectionReauthorizationRequiredError(refs.connectionId, refs.authorizationRef);
}

/** Call only fixed Exchange authorization and connection-resource routes. */
export class ExchangeAuthorizationClient {
  private readonly origin: string;

  constructor(
    private readonly options: Pick<ExchangeAuthorizationToolOptions, 'baseUrl' | 'workspaceId' | 'trustedUserBearerProvider'>,
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

  /** List only Product connection summaries scoped by Exchange to the current user and Workspace. */
  async listConnections(identity: ExchangeAuthorizationRequestIdentity): Promise<readonly ExchangeConnectionSummary[]> {
    const { payload } = await this.request(EXCHANGE_AUTHORIZATION_OPERATIONS.connectionList.path, identity);
    return arrayField(payload, 'Exchange connections', 500).map(parseConnectionSummary);
  }

  /** Read only the current actor's authorization state for one configured connection. */
  async getAuthorizationHealth(
    connectionId: string,
    identity: ExchangeAuthorizationRequestIdentity,
  ): Promise<ExchangeAuthorizationHealth> {
    assertUuid(connectionId, 'connection id');
    const { payload } = await this.request(
      pathWithId(EXCHANGE_AUTHORIZATION_OPERATIONS.authorizationHealth.path, 'connection_id', connectionId),
      identity,
    );
    const health = parseAuthorizationHealth(payload);
    if (health.connectionId !== connectionId) {
      throw new TypeError('Exchange authorization response does not match the requested connection');
    }
    return health;
  }

  /** Start one user-approved renewal session with a stable call-scoped idempotency key. */
  async startRenewalSession(
    authorizationRef: string,
    idempotencyKey: string,
    identity: ExchangeAuthorizationRequestIdentity,
  ): Promise<ExchangeRenewalSession> {
    assertIdentifier(authorizationRef, 'authorization reference');
    assertIdempotencyKey(idempotencyKey);
    const { payload, response } = await this.request(
      pathWithId(EXCHANGE_AUTHORIZATION_OPERATIONS.renewalStart.path, 'authorization_id', authorizationRef),
      identity,
      { method: 'POST', headers: { 'idempotency-key': idempotencyKey } },
    );
    if (response.status !== 202) throw new TypeError('Exchange renewal session was not accepted');
    const session = parseRenewalSession(payload);
    if (session.authorizationRef !== authorizationRef) {
      throw new TypeError('Exchange renewal session does not match the requested authorization');
    }
    const expected = this.url(renewalStatusPath(session.sessionRef));
    const location = response.headers.get('location');
    if (!location || !isSameResourceLocation(location, expected)) {
      throw new TypeError('Exchange returned an invalid renewal-session Location');
    }
    return session;
  }

  /** Read a Product-owned renewal session without exposing its browser launch material to DSH. */
  async getRenewalSession(
    sessionRef: string,
    identity: ExchangeAuthorizationRequestIdentity,
  ): Promise<ExchangeRenewalSession> {
    assertUuid(sessionRef, 'renewal session reference');
    const { payload } = await this.request(renewalStatusPath(sessionRef), identity);
    const session = parseRenewalSession(payload);
    if (session.sessionRef !== sessionRef) {
      throw new TypeError('Exchange renewal response does not match the requested session');
    }
    return session;
  }

  /** Read Exchange's latest normalized cloud observations; polling remains Exchange-owned. */
  async listConnectionResources(
    connectionId: string,
    identity: ExchangeAuthorizationRequestIdentity,
  ): Promise<ExchangeCloudQueryResult> {
    assertUuid(connectionId, 'connection id');
    const { payload } = await this.request(
      pathWithId(EXCHANGE_AUTHORIZATION_OPERATIONS.connectionResources.path, 'connection_id', connectionId),
      identity,
    );
    const result = parseCloudQueryResult(payload);
    if (result.connectionId !== connectionId) {
      throw new TypeError('Exchange resource response does not match the requested connection');
    }
    return result;
  }

  /** Reconcile one Product operation without replaying the original write. */
  async getOperationState(
    operationId: string,
    identity: ExchangeAuthorizationRequestIdentity,
  ): Promise<typeof EXCHANGE_OPERATION_STATES[number]> {
    assertIdentifier(operationId, 'operation id');
    const path = EXCHANGE_AUTHORIZATION_OPERATIONS.operationRead.path
      .replace('{operation_id}', encodeURIComponent(operationId));
    const { payload } = await this.request(path, identity);
    const row = objectValue(payload, 'Exchange operation response');
    const returnedId = identifierField(row.operationId, 'operation id');
    if (returnedId !== operationId) throw new TypeError('Exchange operation response does not match the requested operation');
    return enumField(row.state, 'operation state', EXCHANGE_OPERATION_STATES);
  }

  /** Send one authenticated call under the configured origin and Workspace. */
  private async request(
    path: string,
    identity: ExchangeAuthorizationRequestIdentity,
    init?: { readonly method?: string; readonly headers?: Record<string, string> },
  ): Promise<ApiResponse> {
    let bearer: string | undefined;
    try {
      bearer = await this.options.trustedUserBearerProvider(identity.sessionId, this.options.workspaceId, identity.signal);
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
          authorization: 'Bearer ' + bearer,
          'x-cyrene-workspace-id': this.options.workspaceId,
          ...init?.headers,
        },
        signal: AbortSignal.any([identity.signal, AbortSignal.timeout(15_000)]),
        redirect: 'error',
      });
    } catch {
      if (identity.signal.aborted) throw abortError(identity.signal);
      throw new Error('Exchange authorization request could not be completed');
    }

    const payload = await readResponse(response);
    if (!response.ok && response.status !== 202) {
      const reauthorization = exchangeReauthorizationFromProblem(response.status, payload);
      if (reauthorization) throw reauthorization;
      throw new Error('Exchange authorization request failed (' + response.status + ')');
    }
    return { payload, response };
  }

  private url(path: string): string {
    return this.origin + path;
  }
}

/** Register fixed auth health, renewal-session, and read-only resource tools. */
export function registerExchangeAuthorizationTools(
  ctx: Context,
  options: ExchangeAuthorizationToolOptions,
): () => void {
  const client = new ExchangeAuthorizationClient(options);
  const healthReferences = new Map<string, Map<string, {
    readonly connectionId: string;
    readonly authorizationState: ExchangeAuthorizationState;
    readonly generation: number;
    readonly checkedAt: number;
  }>>();
  const registrations = [
    ctx.tools.register(defineTool({
      name: 'exchange_connections_list',
      description: 'List safe Exchange connections available to the current verified user in the configured Workspace.',
      parameters: {},
      output: connectionListOutput,
      execute: async (_args, execution) => {
        const identity = requestIdentity(execution);
        return [...await client.listConnections(identity)];
      },
    })),
    ctx.tools.register(defineTool({
      name: 'exchange_authorization_health',
      description: 'Read authorization health for one Exchange connection using the current verified user identity.',
      parameters: { connectionId: { type: 'string', required: true, description: 'Configured Exchange connection reference.' } },
      output: authorizationHealthOutput,
      execute: async (args, execution) => {
        const identity = requestIdentity(execution);
        const connectionId = stringArg(args.connectionId, 'connection id');
        const health = await client.getAuthorizationHealth(connectionId, identity);
        let byAuthorization = healthReferences.get(identity.sessionId);
        if (!byAuthorization) {
          byAuthorization = new Map();
          healthReferences.set(identity.sessionId, byAuthorization);
        }
        if (health.authorizationRef !== null) {
          byAuthorization.set(health.authorizationRef, {
            connectionId,
            authorizationState: health.authorizationState,
            generation: health.generation,
            checkedAt: Date.now(),
          });
        }
        if (health.authorizationState === 'REAUTHORIZATION_REQUIRED') {
          await options.onAuthorizationRequired(identity.sessionId, {
            callId: String(execution.callId),
            connectionId,
            ...(health.authorizationRef === null ? {} : { authorizationRef: health.authorizationRef }),
            generation: health.generation,
            source: 'authorization-health',
            code: REAUTHORIZATION_REQUIRED_CODE,
          });
        }
        return { ...health, capabilities: health.capabilities.map(capability => ({ ...capability })) };
      },
    })),
    ctx.tools.register(defineTool({
      name: 'exchange_reauthorization_start',
      description: 'After Navigator human approval, start one Exchange-owned account renewal session.',
      parameters: {
        authorizationRef: { type: 'string', required: true, description: 'Authorization reference returned by Exchange.' },
      },
      output: renewalSessionOutput,
      execute: async (args, execution) => {
        const identity = requestIdentity(execution);
        requireActiveTask(options, identity.sessionId);
        const authorizationRef = stringArg(args.authorizationRef, 'authorization reference');
        assertIdentifier(authorizationRef, 'authorization reference');
        const knownHealth = healthReferences.get(identity.sessionId)?.get(authorizationRef);
        if (!knownHealth || knownHealth.authorizationState !== 'REAUTHORIZATION_REQUIRED'
          || Date.now() - knownHealth.checkedAt > AUTHORIZATION_REFERENCE_TTL_MS) {
          throw new Error('Renewal requires a recent authenticated health result for this Navigator session');
        }
        await options.approvalBridge.requestApproval(
          identity.sessionId,
          'exchange.account.authorization.renewal',
          'Start a user-authorized Exchange account renewal session',
          { authorizationRef },
          execution.signal,
          String(execution.callId),
        );
        const session = await client.startRenewalSession(
          authorizationRef,
          idempotencyKey(identity.sessionId, String(execution.callId)),
          identity,
        );
        healthReferences.get(identity.sessionId)?.delete(authorizationRef);
        return renewalSessionProjection(session);
      },
    })),
    ctx.tools.register(defineTool({
      name: 'exchange_reauthorization_status',
      description: 'Read the status of one Exchange-owned renewal session.',
      parameters: {
        sessionRef: { type: 'string', required: true, description: 'Product renewal session UUID returned by Exchange.' },
      },
      output: renewalSessionOutput,
      execute: async (args, execution) => {
        const identity = requestIdentity(execution);
        const sessionRef = stringArg(args.sessionRef, 'renewal session reference');
        const session = await client.getRenewalSession(sessionRef, identity);
        return renewalSessionProjection(session);
      },
    })),
    ctx.tools.register(defineTool({
      name: 'exchange_cloud_resources_query',
      description: 'Read Exchange-owned latest cloud observations for one configured connection; Exchange owns polling and comparison.',
      parameters: { connectionId: { type: 'string', required: true, description: 'Configured Exchange connection reference.' } },
      output: cloudQueryOutput,
      execute: async (args, execution) => {
        const identity = requestIdentity(execution);
        const connectionId = stringArg(args.connectionId, 'connection id');
        try {
          const result = await client.listConnectionResources(connectionId, identity);
          return {
            ...result,
            resources: result.resources.map(resource => ({
              ...resource,
              attributes: { ...resource.attributes },
            })),
          };
        } catch (error: unknown) {
          if (!(error instanceof ExchangeConnectionReauthorizationRequiredError)) throw error;
          if (error.connectionId !== undefined && error.connectionId !== connectionId) {
            throw new TypeError('Exchange reauthorization response does not match the requested connection');
          }
          await options.onAuthorizationRequired(identity.sessionId, {
            callId: String(execution.callId),
            connectionId,
            ...(error.authorizationRef === undefined ? {} : { authorizationRef: error.authorizationRef }),
            source: 'connection-resources',
            code: error.code,
          });
          return {
            status: 'awaiting_user_authorization' as const,
            connectionId,
            code: error.code,
          };
        }
      },
    })),
  ];

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    healthReferences.clear();
    for (const unregister of registrations.reverse()) unregister();
  };
  ctx.effect(() => dispose, 'navigator.exchangeAuthorizationTools');
  return dispose;
}

export const authorizationHealthOutput = {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      connectionId: { type: 'string', required: true },
      provider: { type: 'string', required: true, enum: EXCHANGE_PROVIDERS },
      authorizationRef: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      loginState: { type: 'string', required: true, enum: EXCHANGE_LOGIN_STATES },
      authorizationState: { type: 'string', required: true, enum: EXCHANGE_AUTHORIZATION_STATES },
      checkedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      expiresAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      generation: { type: 'integer', required: true },
      reasonCode: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      capabilities: {
        type: 'array', required: true, items: {
          type: 'object', additionalProperties: false,
          properties: {
            capabilityId: { type: 'string', required: true },
            state: { type: 'string', required: true, enum: EXCHANGE_AUTHORIZATION_STATES },
            lastVerifiedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
            expiresAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
            reasonCode: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          },
        },
      },
    },
  } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

const connectionListOutput = {
  schema: {
    type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        provider: { type: 'string', required: true, enum: EXCHANGE_PROVIDERS },
        displayName: { type: 'string', required: true },
        repositoryId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        repositoryName: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        enabled: { type: 'boolean', required: true },
        createdAt: { type: 'string', required: true },
        updatedAt: { type: 'string', required: true },
      },
    },
  } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

const renewalSessionOutput = {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      sessionRef: { type: 'string', required: true },
      authorizationRef: { type: 'string', required: true },
      state: { type: 'string', required: true, enum: EXCHANGE_RENEWAL_SESSION_STATES },
      createdAt: { type: 'string', required: true },
      expiresAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      generation: { type: 'integer', required: true },
      reasonCode: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    },
  } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

const cloudQueryOutput = {
  schema: {
    oneOf: [
      {
        type: 'object', additionalProperties: false,
        properties: {
          connectionId: { type: 'string', required: true },
          provider: { type: 'string', required: true, enum: EXCHANGE_PROVIDERS },
          checkedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          resources: {
            type: 'array', required: true, items: {
              type: 'object', additionalProperties: false,
              properties: {
                externalRef: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                displayName: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: EXCHANGE_CLOUD_RESOURCE_STATES },
                providerStatus: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                collectedAt: { type: 'string', required: true },
                observedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                attributes: { type: 'object', required: true, additionalProperties: true },
                platformResourceRef: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                platformGeneration: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
                source: { type: 'string', required: true },
                freshness: { type: 'string', required: true, enum: EXCHANGE_SNAPSHOT_FRESHNESS },
              },
            },
          },
        },
      },
      {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['awaiting_user_authorization'] },
          code: { type: 'string', required: true, enum: [REAUTHORIZATION_REQUIRED_CODE] },
          connectionId: { type: 'string', required: true },
        },
      },
    ],
  } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

/** Build the identity context from the actual DSH execution, never tool arguments. */
function requestIdentity(execution: ToolRunContext): ExchangeAuthorizationRequestIdentity {
  const sessionId = execution.agent?.session.id;
  if (sessionId === undefined || sessionId === null || String(sessionId).length === 0) {
    throw new Error('Exchange authorization tools require the active Navigator session');
  }
  return { sessionId: String(sessionId), signal: execution.signal };
}

/** Require an active durable task before requesting a human renewal approval. */
function requireActiveTask(options: ExchangeAuthorizationToolOptions, sessionId: string): void {
  if (!options.taskIdForSession(sessionId)) {
    throw new Error('Exchange authorization renewal requires an active durable Navigator task');
  }
}

/** Exclude browser launch material from every model-facing renewal result. */
function renewalSessionProjection(session: ExchangeRenewalSession): Omit<ExchangeRenewalSession, 'authorizationUrl' | 'qrAttachmentRef'> {
  return {
    sessionRef: session.sessionRef,
    authorizationRef: session.authorizationRef,
    state: session.state,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    generation: session.generation,
    reasonCode: session.reasonCode,
  };
}

/** Derive a stable idempotency value for one DSH call without persisting action data. */
function idempotencyKey(sessionId: string, callId: string): string {
  const digest = createHash('sha256').update(sessionId).update('\0').update('renewal').update('\0').update(callId).digest('hex');
  return 'navigator-exchange-auth-v1:' + digest;
}

/** Validate one actor-scoped Product connection row and omit unknown response fields. */
function parseConnectionSummary(value: unknown): ExchangeConnectionSummary {
  const row = objectValue(value, 'Exchange connection summary');
  if (typeof row.enabled !== 'boolean') throw new TypeError('Invalid Exchange connection enabled state');
  return {
    id: uuidField(row.id, 'connection id'),
    provider: enumField(row.provider, 'provider', EXCHANGE_PROVIDERS),
    displayName: textField(row.displayName, 'connection display name', 300),
    repositoryId: nullableTextField(row.repositoryId, 'repository id', 200),
    repositoryName: nullableTextField(row.repositoryName, 'repository name', 300),
    enabled: row.enabled,
    createdAt: utcDateField(row.createdAt, 'connection createdAt'),
    updatedAt: utcDateField(row.updatedAt, 'connection updatedAt'),
  };
}

/** Parse only the documented health fields and discard unknown provider payloads. */
function parseAuthorizationHealth(value: unknown): ExchangeAuthorizationHealth {
  const row = objectValue(value, 'Exchange authorization-health response');
  const capabilities = arrayField(row.capabilities, 'authorization capabilities', 128)
    .map(parseCapabilityHealth);
  return {
    connectionId: uuidField(row.connectionId, 'connection id'),
    provider: enumField(row.provider, 'provider', EXCHANGE_PROVIDERS),
    authorizationRef: nullableIdentifierField(row.authorizationRef, 'authorization reference'),
    loginState: enumField(row.loginState, 'login state', EXCHANGE_LOGIN_STATES),
    authorizationState: enumField(row.authorizationState, 'authorization state', EXCHANGE_AUTHORIZATION_STATES),
    checkedAt: nullableUtcDateField(row.checkedAt, 'checkedAt'),
    expiresAt: nullableUtcDateField(row.expiresAt, 'expiresAt'),
    generation: nonNegativeInteger(row.generation, 'generation'),
    capabilities,
    reasonCode: nullableTextField(row.reasonCode, 'authorization reasonCode', 200),
  };
}

/** Validate and project one capability authorization row. */
function parseCapabilityHealth(value: unknown): CapabilityAuthorizationHealth {
  const row = objectValue(value, 'Exchange capability health');
  return {
    capabilityId: textField(row.capabilityId, 'capability id', 200),
    state: enumField(row.state, 'capability state', EXCHANGE_AUTHORIZATION_STATES),
    lastVerifiedAt: nullableUtcDateField(row.lastVerifiedAt, 'lastVerifiedAt'),
    expiresAt: nullableUtcDateField(row.expiresAt, 'capability expiresAt'),
    reasonCode: nullableTextField(row.reasonCode, 'capability reasonCode', 200),
  };
}

/** Validate the Product renewal DTO while retaining UI-only fields only in host memory. */
function parseRenewalSession(value: unknown): ExchangeRenewalSession {
  const row = objectValue(value, 'Exchange renewal-session response');
  const authorizationUrl = nullableTextField(row.authorizationUrl, 'authorizationUrl', 2_000);
  if (authorizationUrl !== null) {
    let url: URL;
    try { url = new URL(authorizationUrl); } catch { throw new TypeError('Exchange authorization URL is invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new TypeError('Exchange authorization URL is invalid');
    }
  }
  return {
    sessionRef: uuidField(row.sessionRef, 'renewal session reference'),
    authorizationRef: identifierField(row.authorizationRef, 'authorization reference'),
    state: enumField(row.state, 'renewal session state', EXCHANGE_RENEWAL_SESSION_STATES),
    createdAt: utcDateField(row.createdAt, 'renewal createdAt'),
    expiresAt: nullableUtcDateField(row.expiresAt, 'renewal expiresAt'),
    authorizationUrl,
    qrAttachmentRef: nullableTextField(row.qrAttachmentRef, 'QR attachment reference', 300),
    generation: nonNegativeInteger(row.generation, 'renewal generation'),
    reasonCode: nullableTextField(row.reasonCode, 'renewal reasonCode', 200),
  };
}

/** Restrict cloud observations to bounded scalar metadata and documented fields. */
function parseCloudQueryResult(value: unknown): ExchangeCloudQueryResult {
  const row = objectValue(value, 'Exchange cloud-resource response');
  const resources = arrayField(row.resources, 'cloud resources', MAX_CLOUD_RESOURCES).map(parseCloudObservation);
  return {
    connectionId: uuidField(row.connectionId, 'connection id'),
    provider: enumField(row.provider, 'provider', EXCHANGE_PROVIDERS),
    checkedAt: nullableUtcDateField(row.checkedAt, 'checkedAt'),
    resources,
  };
}

/** Validate one normalized observation; raw vendor objects are never forwarded. */
function parseCloudObservation(value: unknown): ExchangeCloudObservation {
  const row = objectValue(value, 'Exchange cloud observation');
  return {
    externalRef: textField(row.externalRef, 'external resource reference', 500),
    kind: textField(row.kind, 'resource kind', 120),
    displayName: textField(row.displayName, 'resource display name', 300),
    status: enumField(row.status, 'cloud resource state', EXCHANGE_CLOUD_RESOURCE_STATES),
    providerStatus: nullableTextField(row.providerStatus, 'provider status', 300),
    collectedAt: utcDateField(row.collectedAt, 'resource collectedAt'),
    observedAt: nullableUtcDateField(row.observedAt, 'resource observedAt'),
    attributes: parseSafeAttributes(row.attributes),
    platformResourceRef: nullableTextField(row.platformResourceRef, 'Platform resource reference', 300),
    platformGeneration: nullableNonNegativeInteger(row.platformGeneration, 'Platform generation'),
    source: textField(row.source, 'observation source', 120),
    freshness: enumField(row.freshness, 'observation freshness', EXCHANGE_SNAPSHOT_FRESHNESS),
  };
}

/** Accept only bounded scalar metadata at the product boundary. */
function parseSafeAttributes(value: unknown): Readonly<Record<string, JsonValue>> {
  const row = objectValue(value, 'Exchange cloud attributes');
  const entries = Object.entries(row);
  if (entries.length > MAX_ATTRIBUTE_COUNT) throw new TypeError('Exchange cloud attributes exceed their configured limit');
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key)) throw new TypeError('Exchange cloud attribute key is invalid');
    if (typeof item === 'string') {
      if (!safeText(item, MAX_ATTRIBUTE_TEXT_BYTES)) throw new TypeError('Exchange cloud attribute text is invalid');
      result[key] = item;
    } else if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      result[key] = item;
    } else {
      throw new TypeError('Exchange cloud attributes must be bounded scalar values');
    }
  }
  return Object.freeze(result);
}

/** Read a bounded JSON response without exposing remote error detail. */
async function readResponse(response: Response): Promise<unknown> {
  const advertisedLength = response.headers.get('content-length');
  if (advertisedLength && Number(advertisedLength) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new TypeError('Exchange authorization response exceeds its configured limit');
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
        throw new TypeError('Exchange authorization response exceeds its configured limit');
      }
      chunks.push(value);
    }
  } catch (error: unknown) {
    if (error instanceof TypeError && error.message === 'Exchange authorization response exceeds its configured limit') throw error;
    await reader.cancel().catch(() => undefined);
    throw new Error('Exchange authorization response could not be read');
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
    throw new TypeError('Exchange authorization response is invalid JSON');
  }
}

/** Extract only a stable Product problem code, never detail or other fields. */
function problemCode(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const code = (value as Record<string, unknown>).code;
  return typeof code === 'string' && safeText(code, 128) ? code : undefined;
}

/** Read only the server-derived reauthorization target from Product ProblemDetails. */
function problemContext(value: unknown): { connectionId?: string; authorizationRef?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const context = (value as Record<string, unknown>).context;
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return {};
  const row = context as Record<string, unknown>;
  const connectionId = typeof row.connectionId === 'string' && UUID_PATTERN.test(row.connectionId)
    ? row.connectionId : undefined;
  const authorizationRef = typeof row.authorizationRef === 'string' && IDENTIFIER.test(row.authorizationRef)
    ? row.authorizationRef : undefined;
  return {
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(authorizationRef === undefined ? {} : { authorizationRef }),
  };
}

/** Ensure a 202 Location identifies the exact same Product renewal resource. */
function isSameResourceLocation(location: string, expected: string): boolean {
  try {
    const actual = new URL(location, expected);
    const target = new URL(expected);
    return !actual.username && !actual.password
      && actual.origin === target.origin
      && actual.pathname === target.pathname
      && actual.search === ''
      && actual.hash === '';
  } catch {
    return false;
  }
}

/** Fill only a documented opaque path identifier using URL encoding. */
function pathWithId(template: string, parameter: string, id: string): string {
  const token = '{' + parameter + '}';
  if (!template.includes(token)) throw new TypeError('Exchange authorization route is invalid');
  return template.replace(token, encodeURIComponent(id));
}

function renewalStatusPath(sessionRef: string): string {
  return EXCHANGE_AUTHORIZATION_OPERATIONS.renewalStatus.path
    .replace('{session_id}', encodeURIComponent(sessionRef));
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new TypeError(label + ' is invalid');
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(label + ' must be a UUID');
  }
}

function assertIdempotencyKey(value: string): void {
  if (!safeText(value, 200) || !value.trim()) throw new TypeError('Idempotency key is invalid');
}

function stringArg(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(label + ' must be text');
  return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(label + ' must be an object');
  return value as Record<string, unknown>;
}

function arrayField(value: unknown, label: string, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new TypeError('Exchange ' + label + ' are invalid');
  return value;
}

function textField(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || !safeText(value, maxBytes)) throw new TypeError('Exchange ' + label + ' is invalid');
  return value;
}

function identifierField(value: unknown, label: string): string {
  const identifier = textField(value, label, 300);
  assertIdentifier(identifier, label);
  return identifier;
}

function uuidField(value: unknown, label: string): string {
  const identifier = textField(value, label, 36);
  assertUuid(identifier, label);
  return identifier;
}

function nullableIdentifierField(value: unknown, label: string): string | null {
  return value === null ? null : identifierField(value, label);
}

function nullableTextField(value: unknown, label: string, maxBytes: number): string | null {
  return value === null ? null : textField(value, label, maxBytes);
}

function enumField<const T extends readonly string[]>(value: unknown, label: string, values: T): T[number] {
  const text = textField(value, label, 64);
  if (!values.includes(text)) throw new TypeError('Exchange ' + label + ' is invalid');
  return text as T[number];
}

function utcDateField(value: unknown, label: string): string {
  const date = textField(value, label, 64);
  if (!RFC3339_UTC.test(date) || !Number.isFinite(Date.parse(date))) {
    throw new TypeError('Exchange ' + label + ' is invalid');
  }
  return date;
}

function nullableUtcDateField(value: unknown, label: string): string | null {
  return value === null ? null : utcDateField(value, label);
}

function nullableNonNegativeInteger(value: unknown, label: string): number | null {
  return value === null ? null : nonNegativeInteger(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Exchange ' + label + ' is invalid');
  }
  return value;
}

function safeText(value: string, maxBytes: number): boolean {
  return value.length > 0 && new TextEncoder().encode(value).byteLength <= maxBytes
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
}
