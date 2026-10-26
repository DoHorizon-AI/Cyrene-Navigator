// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Exchange authorization tool tests                           │
// │ Role: Verify scoped auth health, approved renewal, and safe reads.   │
// │                                                                      │
// │ 模块职责：验证调用者隔离的授权状态、审批续期与安全读取。                 │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import {
  ExchangeAuthorizationClient,
  registerExchangeAuthorizationTools,
} from '../dist/integrations/exchange-authorization.js';

const workspaceId = 'workspace-authorization-test';
const sessionId = 'navigator-session-owner';
const connectionId = '7e1c50d2-b4f3-4d61-9302-9a0bd48d1991';
const authorizationRef = 'authorization-refs-7a91';
const operationId = 'cc49c3f4-08a7-4cae-bf89-90448cfbcb8f';
const renewalSessionRef = '647fe9f4-8f28-441f-9a23-bb34f9d8c9c2';
const privateLaunchUrl = 'https://identity.example/authorize?state=private-oauth-state';

function authorizationHealth(overrides = {}) {
  return {
    connectionId,
    provider: 'azure',
    authorizationRef,
    loginState: 'PRESENT',
    authorizationState: 'REAUTHORIZATION_REQUIRED',
    checkedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: null,
    generation: 7,
    reasonCode: 'provider_token_expired',
    capabilities: [{
      capabilityId: 'cloud.resources.query',
      state: 'REAUTHORIZATION_REQUIRED',
      lastVerifiedAt: null,
      expiresAt: null,
      reasonCode: 'provider_token_expired',
    }],
    ...overrides,
  };
}

function connectionSummary(overrides = {}) {
  return {
    id: connectionId,
    provider: 'azure',
    displayName: 'Build subscription',
    repositoryId: null,
    repositoryName: null,
    enabled: true,
    createdAt: '2026-10-14T13:00:00Z',
    updatedAt: '2026-10-14T13:04:00Z',
    ...overrides,
  };
}

function renewalSession(overrides = {}) {
  return {
    sessionRef: renewalSessionRef,
    authorizationRef,
    state: 'WAITING_USER',
    createdAt: '2026-10-14T13:06:00Z',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    authorizationUrl: privateLaunchUrl,
    qrAttachmentRef: 'private-attachment-ref',
    generation: 7,
    reasonCode: null,
    ...overrides,
  };
}

function cloudResources() {
  return {
    connectionId,
    provider: 'azure',
    checkedAt: '2026-10-14T13:07:00Z',
    resources: [{
      externalRef: 'vm-7',
      kind: 'azure.vm',
      displayName: 'build-host',
      status: 'RUNNING',
      providerStatus: 'running',
      collectedAt: '2026-10-14T13:06:55Z',
      observedAt: '2026-10-14T13:06:55Z',
      attributes: { region: 'eastus', cores: 4, protected: true },
      platformResourceRef: null,
      platformGeneration: null,
      source: 'exchange-provider',
      freshness: 'FRESH',
      vendorBlob: { credential: 'must-not-escape' },
    }],
  };
}

async function startExchangeFixture(options = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.headers.authorization !== 'Bearer owner-user-token'
        || request.headers['x-cyrene-workspace-id'] !== workspaceId) {
        response.writeHead(401, { 'content-type': 'application/problem+json' });
        response.end(JSON.stringify({
          code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
          detail: 'A private expired principal error must not be exposed.',
        }));
        return;
      }

      if (request.method === 'GET' && request.url === '/api/v1/integrations/connections') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify([
          connectionSummary({ tenantId: 'must-not-escape', accountLinkRef: 'private-binding-ref' }),
        ]));
        return;
      }

      if (request.method === 'GET'
        && request.url === '/api/v1/integrations/connections/' + connectionId + '/authorization-health') {
        if (options.expiredPrincipal === true) {
          response.writeHead(401, { 'content-type': 'application/problem+json' });
          response.end(JSON.stringify({
            code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
            detail: 'Private 401 detail must not trigger provider reauthorization.',
          }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(authorizationHealth(options.healthOverrides ?? {})));
        return;
      }

      if (request.method === 'POST'
        && request.url === '/api/v1/accounts/authorizations/' + authorizationRef + '/renewal-sessions') {
        assert.equal(body, '');
        assert.match(request.headers['idempotency-key'], /^navigator-exchange-auth-v1:[0-9a-f]{64}$/u);
        response.writeHead(202, {
          'content-type': 'application/json',
          location: '/api/v1/accounts/renewal-sessions/' + renewalSessionRef,
        });
        response.end(JSON.stringify(renewalSession(options.renewalOverrides ?? {})));
        return;
      }

      if (request.method === 'GET'
        && request.url === '/api/v1/accounts/renewal-sessions/' + renewalSessionRef) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(renewalSession(options.renewalOverrides ?? {})));
        return;
      }

      if (request.method === 'GET'
        && request.url === '/api/v1/integrations/connections/' + connectionId + '/resources') {
        if (options.reauthorizationRequired === true) {
          response.writeHead(409, { 'content-type': 'application/problem+json' });
          response.end(JSON.stringify({
            code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
            context: { connectionId, authorizationRef },
            detail: 'Provider credentials are private and must not be forwarded.',
          }));
          return;
        }
        if (options.genericForbidden === true) {
          response.writeHead(403, { 'content-type': 'application/problem+json' });
          response.end(JSON.stringify({ code: 'EXCHANGE_PERMISSION_DENIED' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(cloudResources()));
        return;
      }

      if (request.method === 'GET'
        && request.url === '/api/v1/integrations/operations/' + operationId) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ operationId, state: 'SUCCEEDED' }));
        return;
      }

      response.writeHead(404, { 'content-type': 'application/problem+json' });
      response.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: 'http://127.0.0.1:' + address.port,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function createToolContext(exchange, options = {}) {
  const events = [];
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const dispose = registerExchangeAuthorizationTools(ctx, {
    baseUrl: exchange.url,
    workspaceId,
    trustedUserBearerProvider: async (actualSessionId, actualWorkspaceId) => {
      events.push({ type: 'identity', sessionId: actualSessionId, workspaceId: actualWorkspaceId });
      return actualSessionId === sessionId && actualWorkspaceId === workspaceId
        ? 'owner-user-token'
        : undefined;
    },
    approvalBridge: {
      async requestApproval(actualSessionId, kind, summary, details) {
        events.push({ type: 'approval', sessionId: actualSessionId, kind, summary, details });
        return { id: 'approval-renewal-1', status: 'approved' };
      },
    },
    taskIdForSession: id => id === sessionId ? 'task-authorization-1' : undefined,
    onAuthorizationRequired: async (actualSessionId, receipt) => {
      events.push({ type: 'authorization-required', sessionId: actualSessionId, receipt });
    },
    ...options,
  });
  return { ctx, dispose, events };
}

function execute(ctx, name, args, callId, actualSessionId = sessionId) {
  return ctx.tools.execute({
    name,
    callId: ToolCallId(callId),
    arguments: args,
    signal: new AbortController().signal,
    agent: { id: 'agent-auth-test', session: { id: actualSessionId } },
  });
}

test('registers fixed authorization tools, requires approval, and hides renewal launch material', async () => {
  const exchange = await startExchangeFixture();
  const { ctx, dispose, events } = await createToolContext(exchange);
  try {
    assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), [
      'exchange_authorization_health',
      'exchange_cloud_resources_query',
      'exchange_connections_list',
      'exchange_reauthorization_start',
      'exchange_reauthorization_status',
    ]);

    const guessedRef = await execute(ctx, 'exchange_reauthorization_start', { authorizationRef }, 'renewal-guessed-1');
    assert.equal(guessedRef.isError, true);
    assert.equal(exchange.requests.length, 0);
    assert.equal(events.some(event => event.type === 'approval'), false);

    const health = await execute(ctx, 'exchange_authorization_health', { connectionId }, 'health-1');
    assert.equal(health.isError, false);
    assert.equal(health.value.authorizationState, 'REAUTHORIZATION_REQUIRED');
    assert.equal(events.at(-1).receipt.generation, 7);

    const connections = await execute(ctx, 'exchange_connections_list', {}, 'connections-1');
    assert.equal(connections.isError, false);
    assert.deepEqual(connections.value, [connectionSummary()]);
    assert.equal(JSON.stringify(connections.value).includes('tenantId'), false);
    assert.equal(JSON.stringify(connections.value).includes('private-binding-ref'), false);

    const start = await execute(ctx, 'exchange_reauthorization_start', { authorizationRef }, 'renewal-1');
    assert.equal(start.isError, false);
    assert.equal(start.value.state, 'WAITING_USER');
    assert.equal(start.value.verificationUrl, null);
    assert.equal(start.value.userCode, null);
    assert.equal(JSON.stringify(start.value).includes('authorizationUrl'), false);
    assert.equal(JSON.stringify(start.value).includes('qrAttachmentRef'), false);
    assert.equal(JSON.stringify(start.value).includes('private-oauth-state'), false);
    const approvalIndex = events.findIndex(event => event.type === 'approval');
    const renewalRequestIndex = exchange.requests.findIndex(request => request.method === 'POST');
    assert.ok(approvalIndex >= 0 && renewalRequestIndex >= 0);
    assert.equal(events[approvalIndex].kind, 'exchange.account.authorization.renewal');
    assert.deepEqual(JSON.parse(JSON.stringify(events[approvalIndex].details)), { authorizationRef });
    assert.equal(exchange.requests[renewalRequestIndex].body, '');

    const status = await execute(ctx, 'exchange_reauthorization_status', {
      sessionRef: renewalSessionRef,
    }, 'renewal-status-1');
    assert.equal(status.isError, false);
    assert.equal(status.value.sessionRef, renewalSessionRef);
    assert.equal(JSON.stringify(status.value).includes('private-attachment-ref'), false);

    const resources = await execute(ctx, 'exchange_cloud_resources_query', { connectionId }, 'resources-1');
    assert.equal(resources.isError, false);
    assert.equal(resources.value.resources[0].status, 'RUNNING');
    assert.equal(resources.value.resources[0].attributes.region, 'eastus');
    assert.equal(JSON.stringify(resources.value).includes('must-not-escape'), false);
    assert.ok(exchange.requests.every(request => request.headers.authorization === 'Bearer owner-user-token'));
  } finally {
    dispose();
    await ctx.fiber.dispose();
    await exchange.close();
  }
});

test('returns only HF device verification instructions and skips the duplicate Navigator approval', async () => {
  for (const [index, verificationUrl] of [
    'https://hf.co/oauth/device',
    'https://huggingface.co/oauth/device',
  ].entries()) {
    const exchange = await startExchangeFixture({
      healthOverrides: { provider: 'hf' },
      renewalOverrides: {
        authorizationUrl: verificationUrl,
        userCode: 'L94P-HPL8',
        deviceCode: 'device-code-must-not-escape',
        accessToken: 'access-token-must-not-escape',
        refreshToken: 'refresh-token-must-not-escape',
      },
    });
    const { ctx, dispose, events } = await createToolContext(exchange);
    try {
      const health = await execute(ctx, 'exchange_authorization_health', { connectionId }, `hf-health-${index}`);
      assert.equal(health.isError, false);
      assert.equal(health.value.provider, 'hf');

      const start = await execute(ctx, 'exchange_reauthorization_start', { authorizationRef }, `hf-renewal-${index}`);
      assert.equal(start.isError, false);
      assert.equal(start.value.sessionRef, renewalSessionRef);
      assert.equal(start.value.verificationUrl, verificationUrl);
      assert.equal(start.value.userCode, 'L94P-HPL8');
      assert.equal(JSON.stringify(start.value).includes('authorizationUrl'), false);
      assert.equal(JSON.stringify(start.value).includes('device-code-must-not-escape'), false);
      assert.equal(JSON.stringify(start.value).includes('access-token-must-not-escape'), false);
      assert.equal(JSON.stringify(start.value).includes('refresh-token-must-not-escape'), false);
      assert.equal(events.some(event => event.type === 'approval'), false);
      assert.equal(events.some(event => event.type === 'authorization-required'), false);

      const status = await execute(ctx, 'exchange_reauthorization_status', {
        sessionRef: renewalSessionRef,
      }, `hf-renewal-status-${index}`);
      assert.equal(status.isError, false);
      assert.equal(status.value.verificationUrl, verificationUrl);
      assert.equal(status.value.userCode, 'L94P-HPL8');
    } finally {
      dispose();
      await ctx.fiber.dispose();
      await exchange.close();
    }
  }
});

test('keeps HF session status readable but hides device code after provider proof is lost', async () => {
  const exchange = await startExchangeFixture({
    healthOverrides: { provider: 'hf' },
    renewalOverrides: {
      authorizationUrl: 'https://hf.co/oauth/device',
      userCode: 'L94P-HPL8',
    },
  });
  const first = await createToolContext(exchange);
  try {
    await execute(first.ctx, 'exchange_authorization_health', { connectionId }, 'hf-restart-health-1');
    const start = await execute(first.ctx, 'exchange_reauthorization_start', { authorizationRef }, 'hf-restart-start-1');
    assert.equal(start.isError, false);
    assert.equal(start.value.userCode, 'L94P-HPL8');
  } finally {
    first.dispose();
    await first.ctx.fiber.dispose();
  }

  const restarted = await createToolContext(exchange);
  try {
    const status = await execute(restarted.ctx, 'exchange_reauthorization_status', {
      sessionRef: renewalSessionRef,
    }, 'hf-restart-status-1');
    assert.equal(status.isError, false);
    assert.equal(status.value.sessionRef, renewalSessionRef);
    assert.equal(status.value.verificationUrl, null);
    assert.equal(status.value.userCode, null);
  } finally {
    restarted.dispose();
    await restarted.ctx.fiber.dispose();
    await exchange.close();
  }
});

test('rejects HF user codes unless bounded and bound to an exact device verification URL', async () => {
  for (const [index, renewalOverrides] of [
    { authorizationUrl: 'https://hf.co/oauth/authorize', userCode: 'L94P-HPL8' },
    { authorizationUrl: 'https://hf.co.evil/oauth/device', userCode: 'L94P-HPL8' },
    { authorizationUrl: 'https://user@hf.co/oauth/device', userCode: 'L94P-HPL8' },
    { authorizationUrl: 'https://hf.co/oauth/device?client_id=unexpected', userCode: 'L94P-HPL8' },
    { authorizationUrl: 'https://hf.co/oauth/device#unexpected', userCode: 'L94P-HPL8' },
    { authorizationUrl: 'https://hf.co/oauth/device', userCode: 'access-token' },
    { authorizationUrl: 'https://hf.co/oauth/device' },
  ].entries()) {
    const exchange = await startExchangeFixture({
      healthOverrides: { provider: 'hf' },
      renewalOverrides,
    });
    const { ctx, dispose } = await createToolContext(exchange);
    try {
      await execute(ctx, 'exchange_authorization_health', { connectionId }, `hf-invalid-health-${index}`);
      const start = await execute(ctx, 'exchange_reauthorization_start', { authorizationRef }, `hf-invalid-${index}`);
      assert.equal(start.isError, true);
      assert.equal(JSON.stringify(start).includes('L94P-HPL8'), false);
      assert.equal(JSON.stringify(start).includes('access-token'), false);
    } finally {
      dispose();
      await ctx.fiber.dispose();
      await exchange.close();
    }
  }
});

test('does not expose HF device instructions for a non-HF renewal session', async () => {
  const exchange = await startExchangeFixture({
    healthOverrides: { provider: 'azure' },
    renewalOverrides: {
      authorizationUrl: 'https://hf.co/oauth/device',
      userCode: 'L94P-HPL8',
    },
  });
  const { ctx, dispose, events } = await createToolContext(exchange);
  try {
    await execute(ctx, 'exchange_authorization_health', { connectionId }, 'non-hf-health-1');
    const start = await execute(ctx, 'exchange_reauthorization_start', { authorizationRef }, 'non-hf-renewal-1');
    assert.equal(start.isError, false);
    assert.equal(start.value.verificationUrl, null);
    assert.equal(start.value.userCode, null);
    assert.equal(events.some(event => event.type === 'approval'), true);

    const status = await execute(ctx, 'exchange_reauthorization_status', {
      sessionRef: renewalSessionRef,
    }, 'non-hf-renewal-status-1');
    assert.equal(status.isError, false);
    assert.equal(status.value.verificationUrl, null);
    assert.equal(status.value.userCode, null);
  } finally {
    dispose();
    await ctx.fiber.dispose();
    await exchange.close();
  }
});

test('requires a recent non-future Exchange probe before starting an HF renewal', async () => {
  const checkedAtValues = [
    null,
    new Date(Date.now() - 21 * 60_000).toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
  ];
  for (const [index, checkedAt] of checkedAtValues.entries()) {
    const exchange = await startExchangeFixture({
      healthOverrides: { provider: 'hf', checkedAt },
      renewalOverrides: {
        authorizationUrl: 'https://hf.co/oauth/device',
        userCode: 'L94P-HPL8',
      },
    });
    const { ctx, dispose, events } = await createToolContext(exchange);
    try {
      const health = await execute(ctx, 'exchange_authorization_health', { connectionId }, `stale-hf-health-${index}`);
      assert.equal(health.isError, false);
      const start = await execute(ctx, 'exchange_reauthorization_start', { authorizationRef }, `stale-hf-start-${index}`);
      assert.equal(start.isError, true);
      assert.equal(JSON.stringify(start).includes('existing health refresh'), true);
      assert.equal(exchange.requests.filter(request => request.method === 'POST').length, 0);
      assert.equal(events.some(event => event.type === 'approval'), false);
    } finally {
      dispose();
      await ctx.fiber.dispose();
      await exchange.close();
    }
  }
});

test('only the exact Exchange 409 provider-reauthorization problem enters the wait path', async () => {
  const exchange = await startExchangeFixture({ reauthorizationRequired: true });
  const { ctx, dispose, events } = await createToolContext(exchange);
  try {
    const result = await execute(ctx, 'exchange_cloud_resources_query', { connectionId }, 'reauth-cloud-1');
    assert.equal(result.isError, false);
    assert.deepEqual(result.value, {
      status: 'awaiting_user_authorization',
      connectionId,
      code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
    });
    const wait = events.find(event => event.type === 'authorization-required');
    assert.equal(wait.sessionId, sessionId);
    assert.deepEqual(wait.receipt, {
      callId: 'reauth-cloud-1',
      connectionId,
      authorizationRef,
      source: 'connection-resources',
      code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
    });
    assert.equal(JSON.stringify(result.value).includes('private credentials'), false);
  } finally {
    dispose();
    await ctx.fiber.dispose();
    await exchange.close();
  }

  const expired = await startExchangeFixture({ expiredPrincipal: true });
  const { ctx: expiredCtx, dispose: disposeExpired, events: expiredEvents } = await createToolContext(expired);
  try {
    const result = await execute(expiredCtx, 'exchange_authorization_health', { connectionId }, 'expired-user-1');
    assert.equal(result.isError, true);
    assert.equal(expiredEvents.some(event => event.type === 'authorization-required'), false);
    assert.equal(JSON.stringify(result).includes('Private 401 detail'), false);
  } finally {
    disposeExpired();
    await expiredCtx.fiber.dispose();
    await expired.close();
  }
});

test('first-party bearer scope is bound to the actual DSH session and generic 403 is not reauthorization', async () => {
  const exchange = await startExchangeFixture({ genericForbidden: true });
  const { ctx, dispose, events } = await createToolContext(exchange);
  try {
    const crossActor = await execute(ctx, 'exchange_authorization_health', { connectionId }, 'cross-actor-1', 'other-session');
    assert.equal(crossActor.isError, true);
    assert.equal(exchange.requests.length, 0);

    const forbidden = await execute(ctx, 'exchange_cloud_resources_query', { connectionId }, 'forbidden-1');
    assert.equal(forbidden.isError, true);
    assert.equal(events.some(event => event.type === 'authorization-required'), false);
    assert.ok(exchange.requests.every(request =>
      request.url === '/api/v1/integrations/connections/' + connectionId + '/resources'));
  } finally {
    dispose();
    await ctx.fiber.dispose();
    await exchange.close();
  }
});

test('safe recovery reads only the fixed authenticated Exchange operation status route', async () => {
  const exchange = await startExchangeFixture();
  const client = new ExchangeAuthorizationClient({
    baseUrl: exchange.url,
    workspaceId,
    trustedUserBearerProvider: async (actualSessionId, actualWorkspaceId) =>
      actualSessionId === sessionId && actualWorkspaceId === workspaceId ? 'owner-user-token' : undefined,
  });
  try {
    const state = await client.getOperationState(operationId, {
      sessionId,
      signal: new AbortController().signal,
    });
    assert.equal(state, 'SUCCEEDED');
    assert.equal(exchange.requests.at(-1).url, '/api/v1/integrations/operations/' + operationId);
    assert.equal(exchange.requests.at(-1).headers.authorization, 'Bearer owner-user-token');
  } finally {
    await exchange.close();
  }
});
