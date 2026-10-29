// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Exchange connector authorization                  │
// │ Role: Mint exact short-lived connector grants and invoke Exchange.  │
// │ 模块职责：通过 Exchange 授权门申请短期 grant 并调用连接器能力。       │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isJsonValue } from '@deepseek-ai/dsh-util-values';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { CredentialHealthSnapshot } from './work-state-client.js';

const GRANT_TTL_MAX_SECONDS = 15;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface ConnectorGrantRequest {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly principalIssuer: string;
  readonly principalSubject: string;
  readonly connectionRef: string;
  readonly providerId: string;
  readonly profileRef: string;
  readonly operationId: string;
  readonly resourceRef: string;
  readonly argumentsDigestSha256: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
}

/** The Platform-signed proof is opaque to Navigator and verified by Exchange. */
export interface ConnectorGrant {
  readonly connectorGrantBin: string;
  readonly grantRef: string;
  readonly audience: string;
  readonly organizationId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly request: ConnectorGrantRequest;
}

export interface TeamsMessageRoute {
  readonly tenantId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly conversationId: string;
  readonly rootThreadId: string;
  readonly serviceUrl: string;
}

export interface TeamsMessageSend {
  readonly requestId: string;
  readonly conversation: TeamsMessageRoute;
  readonly text: string;
}

/** Work-resolved Teams owner-private route; every field is server supplied. */
export interface TeamsPrivateConversationRoute {
  readonly tenantId: string;
  readonly botAppId: string;
  readonly actorAadObjectId: string;
  readonly conversationId: string;
  readonly serviceUrl: string;
}

export interface TeamsPrivateMessageSend {
  readonly requestId: string;
  readonly targetKind: 'owner_private';
  readonly conversation: TeamsPrivateConversationRoute;
  readonly text: string;
}

export interface TeamsMessageDeliveryOutcome {
  readonly outcome: 'accepted' | 'rejected' | 'rate_limited' | 'uncertain';
  readonly vendorMessageId?: string;
  readonly reasonCode?: string;
  readonly retryAfterSeconds?: number;
}

export interface ProviderOperationCall {
  readonly requestId: string;
  readonly connectionRef: string;
  readonly providerId: string;
  readonly profileRef: string;
  readonly operationId: string;
  readonly resourceRef: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
}

export interface ProviderOperationResult {
  readonly requestId: string;
  readonly outcome: 'verified' | 'pending' | 'uncertain' | 'failed';
  readonly operationRef?: string;
  readonly result: Record<string, JsonValue>;
}

export interface ExchangeConnectorAuthorizationConfig {
  readonly baseUrl: string;
  readonly hmacKeyFile: string;
  readonly hmacKeyId: string;
  readonly audience: string;
  readonly requestTimeoutMs?: number;
}

/** Narrow, fail-closed client for Navigator's private Exchange integration facade. */
export class ExchangeConnectorAuthorizationClient {
  private readonly origin: string;
  private readonly timeoutMs: number;
  private keyPromise?: Promise<Buffer>;

  constructor(private readonly config: ExchangeConnectorAuthorizationConfig) {
    const origin = new URL(config.baseUrl);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
      throw new TypeError('Invalid Exchange internal origin');
    }
    if (origin.protocol !== 'https:'
      && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
      throw new TypeError('Exchange connector calls require HTTPS outside loopback');
    }
    this.origin = origin.origin;
    this.timeoutMs = config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    safeText(config.hmacKeyId, 'Exchange HMAC key id', 128);
    safeText(config.hmacKeyFile, 'Exchange HMAC key file', 2_000);
    safeText(config.audience, 'Exchange Authority audience', 256);
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new TypeError('Invalid Exchange connector request timeout');
    }
  }

  /** Obtain a fresh Platform grant for one exact actor, target, operation and argument set. */
  async mintGrant(input: ConnectorGrantRequest, signal: AbortSignal): Promise<ConnectorGrant> {
    const normalized = normalizeGrantRequest(input);
    const digest = sha256(canonicalJson(normalized.arguments));
    if (digest !== normalized.argumentsDigestSha256) {
      throw new TypeError('Connector grant arguments do not match their canonical digest');
    }
    const body = JSON.stringify(normalized);
    const response = await this.postSigned('/internal/v1/connector-operation-grants', body, signal);
    const row = object(await readJson(response), 'Exchange connector grant');
    const connectorGrantBin = base64Field(row.connectorGrantBin, 'connectorGrantBin');
    const grantRef = safeText(row.grantRef, 'grantRef', 256);
    const audience = safeText(row.audience, 'audience', 256);
    const issuedAt = unixSeconds(row.issuedAt, 'issuedAt');
    const expiresAt = unixSeconds(row.expiresAt, 'expiresAt');
    const claims = object(row.claims, 'Exchange grant claims echo');
    const organizationId = assertGrantClaims(claims, normalized);
    if (audience !== this.config.audience) throw new TypeError('Exchange returned a grant for a different Authority audience');
    const now = Math.floor(Date.now() / 1_000);
    if (issuedAt > now + 5 || issuedAt < now - 30 || expiresAt <= now
      || expiresAt <= issuedAt || expiresAt - issuedAt > GRANT_TTL_MAX_SECONDS) {
      throw new TypeError('Exchange returned an invalid or expired connector grant');
    }
    return { connectorGrantBin, grantRef, audience, organizationId, issuedAt, expiresAt, request: normalized };
  }

  /** Invoke one fixed Exchange provider operation using its exact short-lived grant. */
  async callProviderOperation(
    input: ProviderOperationCall,
    grant: ConnectorGrant,
    signal: AbortSignal,
  ): Promise<ProviderOperationResult> {
    assertGrantFresh(grant);
    assertGrantBinding(grant, {
      requestId: input.requestId,
      providerId: input.providerId,
      connectionRef: input.connectionRef,
      profileRef: input.profileRef,
      operationId: input.operationId,
      resourceRef: input.resourceRef,
      arguments: input.arguments,
    });
    const body = JSON.stringify({
      requestId: input.requestId,
      providerId: input.providerId,
      profileRef: input.profileRef,
      operationId: input.operationId,
      resourceRef: input.resourceRef,
      arguments: input.arguments,
    });
    const path = `/internal/v1/connector-operations/${encodeURIComponent(input.connectionRef)}`;
    const response = await this.postGranted(path, body, grant, signal);
    if (response.requestId !== input.requestId
      || !['verified', 'pending', 'uncertain', 'failed'].includes(String(response.outcome))) {
      throw new TypeError('Exchange returned an invalid provider operation envelope');
    }
    const operationRef = response.operationRef === undefined
      ? undefined
      : safeText(response.operationRef, 'operationRef', 512);
    if (response.outcome === 'pending' && operationRef === undefined) {
      throw new TypeError('Exchange pending result omitted operationRef');
    }
    if (!isJsonValue(response.result)) throw new TypeError('Exchange provider business result is not JSON');
    const result = object(response.result, 'Exchange provider business result') as Record<string, JsonValue>;
    return {
      requestId: input.requestId,
      outcome: response.outcome as ProviderOperationResult['outcome'],
      ...(operationRef === undefined ? {} : { operationRef }),
      result,
    };
  }

  /** Deliver one Teams reply through Exchange's configured Bot Framework binding. */
  async sendTeamsMessage(
    input: TeamsMessageSend,
    grant: ConnectorGrant,
    connectionRef: string,
    profileRef: string,
    signal: AbortSignal,
  ): Promise<{
    readonly outcome: 'accepted' | 'rejected' | 'rate_limited' | 'uncertain';
    readonly vendorMessageId?: string;
    readonly reasonCode?: string;
    readonly retryAfterSeconds?: number;
  }> {
    assertGrantFresh(grant);
    validateTeamsServiceUrl(input.conversation.serviceUrl, input.conversation.tenantId);
    const args = teamsMessageArguments(input);
    const resourceRef = teamsThreadResourceRef(input.conversation);
    assertGrantBinding(grant, {
      requestId: input.requestId,
      connectionRef,
      profileRef,
      operationId: 'msteams.message.reply',
      resourceRef,
      arguments: args,
      providerId: 'msteams',
    });
    const body = JSON.stringify({
      requestId: input.requestId,
      providerId: 'msteams',
      conversation: input.conversation,
      text: input.text,
    });
    const response = await this.postGrantedResponse('/internal/v1/teams/messages', body, grant, signal, true);
    const row = object(await readJson(response), 'Exchange Teams message result');
    if (row.requestId !== input.requestId) throw new TypeError('Exchange returned a Teams result for a different notification');
    const outcome = row.status;
    if (outcome !== 'accepted' && outcome !== 'rejected'
      && outcome !== 'rate_limited' && outcome !== 'uncertain') {
      throw new TypeError('Exchange returned an unknown Teams message result');
    }
    if (response.status === 429) {
      const retryAfterSeconds = boundedRetryAfter(response.headers.get('retry-after'));
      if (outcome !== 'rate_limited' || retryAfterSeconds === undefined) {
        throw new ExchangeConnectorRequestError(
          'Exchange returned a 429 without a confirmed Teams rate-limit outcome',
          429,
          false,
        );
      }
      return {
        outcome,
        ...(typeof row.reasonCode === 'string' ? { reasonCode: row.reasonCode } : {}),
        retryAfterSeconds,
      };
    }
    if (outcome === 'rate_limited') {
      throw new TypeError('Exchange returned rate_limited without an HTTP 429 response');
    }
    if (outcome === 'uncertain') {
      return {
        outcome,
        ...(typeof row.reasonCode === 'string' ? { reasonCode: row.reasonCode } : {}),
      };
    }
    return {
      outcome,
      ...(typeof row.vendorMessageId === 'string' ? { vendorMessageId: row.vendorMessageId } : {}),
      ...(typeof row.reasonCode === 'string' ? { reasonCode: row.reasonCode } : {}),
      ...(boundedRetryAfter(row.retryAfterSeconds) === undefined
        ? {} : { retryAfterSeconds: boundedRetryAfter(row.retryAfterSeconds) }),
    };
  }

  /** Deliver one Work-resolved owner-private Teams message through the same fixed bot binding. */
  async sendPrivateTeamsMessage(
    input: TeamsPrivateMessageSend,
    grant: ConnectorGrant,
    connectionRef: string,
    profileRef: string,
    signal: AbortSignal,
  ): Promise<TeamsMessageDeliveryOutcome> {
    const conversation = validateTeamsPrivateConversation(input.conversation);
    const requestId = safeText(input.requestId, 'private Teams request id', 200);
    if (input.targetKind !== 'owner_private') throw new TypeError('Invalid private Teams target kind');
    const text = safeText(input.text, 'private Teams message text', 24_000);
    if (grant.request.principalSubject.toLowerCase() !== conversation.actorAadObjectId
      || grant.request.principalIssuer !== `https://login.microsoftonline.com/${conversation.tenantId}/v2.0`) {
      throw new TypeError('Private Teams grant actor does not match the Work-resolved route');
    }
    const argumentsValue: Readonly<Record<string, JsonValue>> = {
      targetKind: 'owner_private',
      conversation: {
        tenantId: conversation.tenantId,
        botAppId: conversation.botAppId,
        actorAadObjectId: conversation.actorAadObjectId,
        conversationId: conversation.conversationId,
        serviceUrl: conversation.serviceUrl,
      },
      text,
    };
    const resourceRef = teamsPrivateResourceRef(conversation);
    assertGrantBinding(grant, {
      requestId,
      connectionRef,
      profileRef,
      providerId: 'msteams',
      operationId: 'msteams.message.reply',
      resourceRef,
      arguments: argumentsValue,
    });
    assertGrantFresh(grant);
    const body = JSON.stringify({
      requestId,
      providerId: 'msteams',
      targetKind: 'owner_private',
      conversation,
      text,
    });
    const response = await this.postGrantedResponse('/internal/v1/teams/messages', body, grant, signal, true);
    const row = object(await readJson(response), 'Exchange private Teams message result');
    if (row.requestId !== requestId) {
      throw new TypeError('Exchange returned a private Teams result for a different notification');
    }
    const outcome = row.status;
    if (outcome !== 'accepted' && outcome !== 'rejected'
      && outcome !== 'rate_limited' && outcome !== 'uncertain') {
      throw new TypeError('Exchange returned an unknown private Teams message result');
    }
    if (response.status === 429) {
      const retryAfterSeconds = boundedRetryAfter(response.headers.get('retry-after'));
      if (outcome !== 'rate_limited' || retryAfterSeconds === undefined) {
        throw new ExchangeConnectorRequestError(
          'Exchange returned a 429 without a confirmed private Teams rate-limit outcome',
          429,
          false,
        );
      }
      return {
        outcome,
        ...(typeof row.reasonCode === 'string' ? { reasonCode: row.reasonCode } : {}),
        retryAfterSeconds,
      };
    }
    if (outcome === 'rate_limited') {
      throw new TypeError('Exchange returned rate_limited without an HTTP 429 response');
    }
    if (outcome === 'uncertain') {
      return {
        outcome,
        ...(typeof row.reasonCode === 'string' ? { reasonCode: row.reasonCode } : {}),
      };
    }
    return {
      outcome,
      ...(typeof row.vendorMessageId === 'string' ? { vendorMessageId: row.vendorMessageId } : {}),
      ...(typeof row.reasonCode === 'string' ? { reasonCode: row.reasonCode } : {}),
      ...(boundedRetryAfter(row.retryAfterSeconds) === undefined
        ? {} : { retryAfterSeconds: boundedRetryAfter(row.retryAfterSeconds) }),
    };
  }

  /** Read only the selected Exchange-owned authorization snapshots for one fixed Workspace. */
  async getAuthorizationHealthSnapshots(input: {
    readonly requestId: string;
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly connectionIds: readonly string[];
  }, signal: AbortSignal): Promise<readonly CredentialHealthSnapshot[]> {
    if (input.connectionIds.length < 1 || input.connectionIds.length > 100
      || new Set(input.connectionIds).size !== input.connectionIds.length) {
      throw new TypeError('Credential health snapshot selectors are invalid');
    }
    const request = {
      requestId: safeText(input.requestId, 'authorization health request id', 200),
      organizationId: safeText(input.organizationId, 'authorization health organization id', 512),
      workspaceId: safeText(input.workspaceId, 'authorization health workspace id', 512),
      connectionIds: input.connectionIds.map((value, index) => safeText(
        value, `authorization health connection id ${index}`, 512,
      )),
    };
    const body = JSON.stringify(request);
    const response = await this.postSigned(
      '/internal/v1/authorization-health/snapshots', body, signal,
    );
    const envelope = object(await readJson(response), 'Exchange authorization health snapshots');
    if (!exactObjectKeys(envelope, ['connections']) || !Array.isArray(envelope.connections)
      || envelope.connections.length > request.connectionIds.length) {
      throw new TypeError('Exchange returned an invalid authorization health snapshot envelope');
    }
    const requested = new Set(request.connectionIds);
    const received = new Set<string>();
    return envelope.connections.map((value, index) => {
      const row = object(value, `Exchange authorization health connection ${index}`);
      if (!exactObjectKeys(row, [
        'connectionId', 'provider', 'loginState', 'authorizationState', 'checkedAt',
        'expiresAt', 'generation', 'capabilities', 'reasonCode',
      ])) {
        throw new TypeError('Exchange returned an unsupported authorization health snapshot');
      }
      const connectionId = safeText(row.connectionId, 'authorization health connection id', 512);
      if (!requested.has(connectionId) || received.has(connectionId)) {
        throw new TypeError('Exchange returned a duplicate or unrequested authorization health connection');
      }
      received.add(connectionId);
      const provider = enumText(row.provider, ['hf', 'runpod', 'azure', 'gcp'], 'authorization health provider');
      const loginState = enumText(row.loginState, ['PRESENT', 'MISSING', 'UNKNOWN', 'UNAVAILABLE'], 'authorization login state');
      const authorizationState = enumText(
        row.authorizationState,
        ['VALID', 'REAUTHORIZATION_REQUIRED', 'PERMISSION_DENIED', 'UNKNOWN', 'UNAVAILABLE'],
        'authorization state',
      );
      if (typeof row.generation !== 'number' || !Number.isSafeInteger(row.generation) || row.generation < 0) {
        throw new TypeError('Exchange returned an invalid authorization generation');
      }
      if (!Array.isArray(row.capabilities) || row.capabilities.length > 100) {
        throw new TypeError('Exchange returned an invalid authorization capability list');
      }
      const capabilities = row.capabilities.map((item, capabilityIndex) => {
        const capability = object(item, `Exchange authorization capability ${capabilityIndex}`);
        if (!exactObjectKeys(capability, ['capabilityId', 'state', 'lastVerifiedAt', 'expiresAt', 'reasonCode'])) {
          throw new TypeError('Exchange returned an unsupported authorization capability');
        }
        return {
          capabilityId: safeText(capability.capabilityId, 'authorization capability id', 256),
          state: enumText(
            capability.state,
            ['VALID', 'REAUTHORIZATION_REQUIRED', 'PERMISSION_DENIED', 'UNKNOWN', 'UNAVAILABLE'],
            'authorization capability state',
          ),
          lastVerifiedAt: nullableUtcTimestamp(capability.lastVerifiedAt, 'authorization capability verifiedAt'),
          expiresAt: nullableUtcTimestamp(capability.expiresAt, 'authorization capability expiresAt'),
          reasonCode: nullableSymbolicCode(capability.reasonCode, 'authorization capability reason code'),
        };
      });
      if (new Set(capabilities.map(item => item.capabilityId)).size !== capabilities.length) {
        throw new TypeError('Exchange returned duplicate authorization capability ids');
      }
      return {
        connectionId,
        provider,
        loginState,
        authorizationState,
        checkedAt: nullableUtcTimestamp(row.checkedAt, 'authorization health checkedAt'),
        expiresAt: nullableUtcTimestamp(row.expiresAt, 'authorization health expiresAt'),
        generation: row.generation,
        capabilities,
        reasonCode: nullableSymbolicCode(row.reasonCode, 'authorization health reason code'),
      };
    });
  }

  private async postSigned(path: string, body: string, signal: AbortSignal): Promise<Response> {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const key = await this.hmacKey();
    const signature = createHmac('sha256', key)
      .update(`POST\n${path}\n${timestamp}\n`, 'utf8')
      .update(body, 'utf8')
      .digest('hex');
    return this.post(path, body, signal, {
      'X-Cyrene-Navigator-Key-Id': this.config.hmacKeyId,
      'X-Cyrene-Navigator-Timestamp': timestamp,
      'X-Cyrene-Navigator-Signature': signature,
    });
  }

  private async postGranted(
    path: string,
    body: string,
    grant: ConnectorGrant,
    signal: AbortSignal,
  ): Promise<Record<string, JsonValue>> {
    const response = await this.postGrantedResponse(path, body, grant, signal);
    return object(await readJson(response), 'Exchange connector result') as Record<string, JsonValue>;
  }

  private async postGrantedResponse(
    path: string,
    body: string,
    grant: ConnectorGrant,
    signal: AbortSignal,
    acceptRateLimited = false,
  ): Promise<Response> {
    return this.post(path, body, signal, {
      'X-Cyrene-Connector-Grant-Bin': grant.connectorGrantBin,
    }, true, acceptRateLimited);
  }

  private async post(
    path: string,
    body: string,
    signal: AbortSignal,
    headers: Readonly<Record<string, string>>,
    uncertainOnServerError = false,
    acceptRateLimited = false,
  ): Promise<Response> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(this.origin + path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        redirect: 'error',
      });
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason;
      throw new ExchangeConnectorRequestError('Exchange connector call did not return a response', undefined, true, error);
    }
    if (!response.ok && !(acceptRateLimited && response.status === 429)) {
      const errorBody = await readJson(response).catch(() => ({}));
      const code = errorBody && typeof errorBody === 'object' && !Array.isArray(errorBody)
        && typeof (errorBody as Record<string, unknown>).code === 'string'
        ? String((errorBody as Record<string, unknown>).code)
        : 'EXCHANGE_CONNECTOR_REJECTED';
      throw new ExchangeConnectorRequestError(
        `Exchange connector call was rejected (${response.status}, ${code})`,
        response.status,
        uncertainOnServerError && response.status >= 500,
        undefined,
        response.status === 429 ? boundedRetryAfter(response.headers.get('retry-after')) : undefined,
      );
    }
    return response;
  }

  private async hmacKey(): Promise<Buffer> {
    this.keyPromise ??= readFile(this.config.hmacKeyFile).then(key => {
      if (key.byteLength < 32) throw new Error('Exchange HMAC key file is not configured');
      return key;
    }).catch(() => { throw new Error('Exchange HMAC key is unavailable'); });
    return this.keyPromise;
  }
}

/** Sanitized Exchange failure with delivery certainty for durable outbox accounting. */
export class ExchangeConnectorRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly outcomeUnknown = false,
    cause?: unknown,
    readonly retryAfterSeconds?: number,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExchangeConnectorRequestError';
  }
}

/** Canonical object JSON used for argument digests and exact operation binding. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function teamsThreadResourceRef(route: TeamsMessageRoute): string {
  return `sha256:${sha256(canonicalJson(route))}`;
}

/** Work's owner-private bot route uses the existing reply operation with a disjoint resource identity. */
export function teamsPrivateResourceRef(route: TeamsPrivateConversationRoute): string {
  return `msteams-personal:${sha256(canonicalJson(validateTeamsPrivateConversation(route)))}`;
}

function validateTeamsPrivateConversation(value: unknown): TeamsPrivateConversationRoute {
  const row = object(value, 'private Teams conversation');
  if (!exactObjectKeys(row, ['tenantId', 'botAppId', 'actorAadObjectId', 'conversationId', 'serviceUrl'])) {
    throw new TypeError('Private Teams conversation contains unsupported or missing fields');
  }
  const tenantId = safeUuid(row.tenantId, 'private Teams tenant id');
  const botAppId = safeUuid(row.botAppId, 'private Teams bot app id');
  const actorAadObjectId = safeUuid(row.actorAadObjectId, 'private Teams actor id');
  const conversationId = safeText(row.conversationId, 'private Teams conversation id', 512);
  const serviceUrl = validateTeamsServiceUrl(row.serviceUrl, tenantId);
  return { tenantId, botAppId, actorAadObjectId, conversationId, serviceUrl };
}

function safeUuid(value: unknown, label: string): string {
  const normalized = safeText(value, label, 36).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new TypeError(`Invalid ${label}`);
  return normalized;
}

/** Validate the host-only Bot Framework endpoint copied from the signed activity envelope. */
export function validateTeamsServiceUrl(value: unknown, tenantId: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
    || value.trim() !== value || /[\s\u0000-\u001f\u007f%\\]/u.test(value)) {
    throw new TypeError('Teams service URL is invalid');
  }
  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)$/u.exec(value);
  if (!match) throw new TypeError('Teams service URL is invalid');
  const authority = match[1]!;
  const path = match[2]!;
  const hostMatch = /^(smba\.trafficmanager\.net|smba\.infra\.teams\.microsoft\.com)(?::443)?$/u.exec(authority.toLowerCase());
  if (!hostMatch) throw new TypeError('Teams service URL host is not allowed');
  const host = hostMatch[1]!;
  const segments = path.split('/').slice(1);
  const pathSegments = segments.at(-1) === '' ? segments.slice(0, -1) : segments;
  if (pathSegments.length === 0 || pathSegments.some(segment =>
    !/^[A-Za-z0-9-]{1,128}$/u.test(segment) || segment === '.' || segment === '..')) {
    throw new TypeError('Teams service URL path is invalid');
  }
  const channelPath = path === '/teams' || path === '/teams/';
  if (host === 'smba.infra.teams.microsoft.com') {
    if (!channelPath) throw new TypeError('Teams service URL path is not allowed for this host');
    return value;
  }
  if (channelPath) return value;
  const region = /^(?:amer|in|emea|apac)$/u;
  if (pathSegments.length === 1 && region.test(pathSegments[0]!)) return value;
  if (pathSegments.length === 2 && region.test(pathSegments[0]!)) {
    const pathTenantId = normalizeTenantUuid(pathSegments[1]!);
    const expectedTenantId = normalizeTenantUuid(tenantId);
    if (pathTenantId !== undefined && pathTenantId === expectedTenantId) return value;
  }
  throw new TypeError('Teams service URL path is not allowed');
}

function normalizeTenantUuid(value: string): string | undefined {
  const compact = value.replace(/-/gu, '');
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}[0-9a-f]{4}[0-9a-f]{4}[0-9a-f]{4}[0-9a-f]{12})$/iu.test(compact)) {
    return undefined;
  }
  return compact.toLowerCase();
}

function teamsMessageArguments(input: TeamsMessageSend): Readonly<Record<string, JsonValue>> {
  return {
    conversation: {
      tenantId: input.conversation.tenantId,
      teamId: input.conversation.teamId,
      channelId: input.conversation.channelId,
      conversationId: input.conversation.conversationId,
      rootThreadId: input.conversation.rootThreadId,
      serviceUrl: input.conversation.serviceUrl,
    },
    text: input.text,
  };
}

function normalizeGrantRequest(value: ConnectorGrantRequest): ConnectorGrantRequest {
  const request: ConnectorGrantRequest = {
    requestId: safeText(value.requestId, 'requestId', 512),
    workspaceId: safeText(value.workspaceId, 'workspaceId', 512),
    principalIssuer: safeText(value.principalIssuer, 'principalIssuer', 512),
    principalSubject: safeText(value.principalSubject, 'principalSubject', 256),
    connectionRef: safeText(value.connectionRef, 'connectionRef', 512),
    providerId: safeText(value.providerId, 'providerId', 128),
    profileRef: safeText(value.profileRef, 'profileRef', 512),
    operationId: safeText(value.operationId, 'operationId', 256),
    resourceRef: safeText(value.resourceRef, 'resourceRef', 2_000),
    argumentsDigestSha256: safeDigest(value.argumentsDigestSha256, 'argumentsDigestSha256'),
    arguments: object(value.arguments, 'connector arguments') as Record<string, JsonValue>,
  };
  return request;
}

function assertGrantClaims(value: Record<string, unknown>, expected: ConnectorGrantRequest): string {
  const claimKeys = [
    'requestId', 'organizationId', 'workspaceId', 'principalIssuer', 'principalSubject',
    'connectionRef', 'providerId', 'profileRef', 'operationId', 'resourceRef',
    'argumentsDigestSha256',
  ];
  if (Object.keys(value).length !== claimKeys.length || !claimKeys.every(key => Object.hasOwn(value, key))) {
    throw new TypeError('Exchange returned an incomplete connector grant claim set');
  }
  const organizationId = safeText(value.organizationId, 'grant organization id', 512);
  if (value.requestId !== expected.requestId
    || value.workspaceId !== expected.workspaceId
    || value.principalIssuer !== expected.principalIssuer
    || value.principalSubject !== expected.principalSubject
    || value.connectionRef !== expected.connectionRef
    || value.providerId !== expected.providerId
    || value.profileRef !== expected.profileRef
    || value.operationId !== expected.operationId
    || value.resourceRef !== expected.resourceRef
    || value.argumentsDigestSha256 !== expected.argumentsDigestSha256) {
    throw new TypeError('Exchange returned a grant for a different connector operation');
  }
  return organizationId;
}

function assertGrantBinding(
  grant: ConnectorGrant,
  expected: Pick<ConnectorGrantRequest, 'requestId' | 'connectionRef' | 'profileRef' | 'operationId' | 'resourceRef' | 'arguments'>
    & Partial<Pick<ConnectorGrantRequest, 'providerId'>>,
): void {
  const request = grant.request;
  const argumentsDigestSha256 = sha256(canonicalJson(expected.arguments));
  if (request.requestId !== expected.requestId || request.connectionRef !== expected.connectionRef
    || request.profileRef !== expected.profileRef || request.operationId !== expected.operationId
    || request.resourceRef !== expected.resourceRef || request.argumentsDigestSha256 !== argumentsDigestSha256
    || (expected.providerId !== undefined && request.providerId !== expected.providerId)
    || canonicalJson(request.arguments) !== canonicalJson(expected.arguments)) {
    throw new TypeError('Connector grant does not match the exact provider call');
  }
}

function assertGrantFresh(grant: ConnectorGrant): void {
  const now = Math.floor(Date.now() / 1_000);
  if (grant.expiresAt <= now || grant.expiresAt - grant.issuedAt > GRANT_TTL_MAX_SECONDS) {
    throw new TypeError('Connector grant expired before invocation');
  }
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Connector arguments must be finite JSON');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(row).sort().map(key => [key, canonicalValue(row[key])]));
  }
  throw new TypeError('Connector arguments must be lossless JSON');
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactObjectKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function enumText<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new TypeError(`Invalid ${label}`);
  return value as T[number];
}

function nullableUtcTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function nullableSymbolicCode(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function safeText(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > limit
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}

function safeDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}

function unixSeconds(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${label}`);
  return value;
}

function boundedRetryAfter(value: unknown): number | undefined {
  let seconds: number | undefined;
  if (typeof value === 'number') seconds = value;
  else if (typeof value === 'string' && /^\d{1,5}$/u.test(value)) seconds = Number(value);
  else if (typeof value === 'string') {
    const at = Date.parse(value);
    if (Number.isFinite(at)) seconds = Math.ceil((at - Date.now()) / 1_000);
  }
  return Number.isSafeInteger(seconds) && seconds! >= 1 && seconds! <= 300 ? seconds : undefined;
}

function base64Field(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength === 0 || decoded.toString('base64') !== value) throw new TypeError(`Invalid ${label}`);
  return value;
}

async function readJson(response: Response): Promise<unknown> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new TypeError('Exchange response exceeds its configured size limit');
  const text = bytes.toString('utf8');
  try { return text ? JSON.parse(text) as unknown : {}; }
  catch { throw new TypeError('Exchange returned invalid JSON'); }
}
