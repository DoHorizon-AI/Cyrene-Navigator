// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Exchange issue tool integration fixtures                    │
// │ Role: Verify identity scope, approval, fixed routes, and receipts.   │
// │                                                                      │
// │ 模块职责：验证 Exchange 工具的身份范围、审批、固定路由与回执。         │
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
  ExchangeIntegrationClient,
  environmentExchangeUserBearerProvider,
  registerExchangeIssueTools,
  resolveExchangeUserBearerProvider,
} from '../dist/integrations/exchange-integration.js';

const workspaceId = 'workspace-42';
const bindingId = '0c55f617-199f-4e36-8a2d-45a0d2f4b1ae';
const operationId = '7c9f4339-f824-4d99-b436-e6ca9020984e';
const connectionId = '7e1c50d2-b4f3-4d61-9302-9a0bd48d1991';
const authorizationRef = 'native-authorization-ref';
const sessionId = 'navigator-session-42';
const issueNumber = 17;

function operationProjection(overrides = {}) {
  return {
    operationId,
    action: 'integration.issue.query',
    state: 'QUEUED',
    issueNumber,
    createdAt: '2026-10-12T12:00:00Z',
    updatedAt: '2026-10-12T12:00:00Z',
    result: null,
    body: 'private intent body must be ignored',
    accountRef: 'private-account-ref-must-be-ignored',
    ...overrides,
  };
}

async function startExchangeFixture(options = {}) {
  const requests = [];
  let markQueryAccepted;
  const queryAccepted = new Promise(resolve => { markQueryAccepted = resolve; });
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.headers.authorization !== 'Bearer current-user-token'
        || request.headers['x-cyrene-workspace-id'] !== workspaceId) {
        response.writeHead(401, { 'content-type': 'application/problem+json' });
        response.end(JSON.stringify({ title: 'Identity rejected', detail: 'Sensitive server detail is hidden.' }));
        return;
      }

      if (request.method === 'POST'
        && request.url === `/api/v1/integrations/sync-bindings/${bindingId}/issues/actions/snapshot`) {
        assert.deepEqual(JSON.parse(body), { issueNumber });
        assert.equal(request.headers['idempotency-key'], undefined);
        if (options.oversizedSnapshot === true) {
          response.writeHead(200, {
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
          });
          response.end(Buffer.alloc(1_000_001, 0x20));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          issueNumber, state: 'OPEN', title: 'Improve ingestion', version: 'sha256:issue-v3',
          freshness: 'FRESH', observedAt: '2026-10-12T12:00:01Z',
          body: 'provider-private issue body is omitted by Navigator',
          credential: 'must-not-escape',
        }));
        return;
      }

      if (request.method === 'POST'
        && request.url?.startsWith(`/api/v1/integrations/sync-bindings/${bindingId}/issues/actions/`)) {
        if (!request.headers['idempotency-key']) {
          response.writeHead(400, { 'content-type': 'application/problem+json' });
          response.end('{}');
          return;
        }
        if (options.reauthorizationRequired === true) {
          response.writeHead(409, { 'content-type': 'application/problem+json' });
          response.end(JSON.stringify({
            code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
            context: { connectionId, authorizationRef },
            detail: 'Provider credentials and private diagnostic details are omitted.',
          }));
          return;
        }
        if (options.invalidLocation === true) {
          response.writeHead(202, { location: 'https://attacker.example/steal' });
          response.end(JSON.stringify(operationProjection()));
          return;
        }
        response.writeHead(202, {
          'content-type': 'application/json',
          location: `/api/v1/integrations/operations/${operationId}`,
        });
        response.end(JSON.stringify(operationProjection()));
        if (request.url.endsWith('/actions/query')) markQueryAccepted();
        return;
      }

      if (request.method === 'GET' && request.url === `/api/v1/integrations/operations/${operationId}`) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(operationProjection({ state: 'SUCCEEDED', result: { succeeded: true } })));
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
    url: `http://127.0.0.1:${address.port}`,
    requests,
    queryAccepted,
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
  const dispose = registerExchangeIssueTools(ctx, {
    baseUrl: exchange.url,
    workspaceId,
    trustedUserBearerProvider: async (actualSessionId, actualWorkspaceId) => {
      events.push({ type: 'identity', sessionId: actualSessionId, workspaceId: actualWorkspaceId });
      return options.noIdentity ? undefined : 'current-user-token';
    },
    approvalBridge: {
      async requestApproval(actualSessionId, kind, summary, details) {
        events.push({ type: 'approval', sessionId: actualSessionId, kind, summary, details });
        if (options.rejectApproval) throw new Error('The human rejected this operation');
        return { id: 'approval-42', status: 'approved' };
      },
    },
    taskIdForSession: id => id === sessionId ? 'task-42' : undefined,
    onAuthorizationRequired: async (actualSessionId, receipt) => {
      events.push({ type: 'authorization-required', sessionId: actualSessionId, receipt });
    },
  });
  return { ctx, dispose, events };
}

function execute(ctx, name, args, callId, withAgent = true) {
  return ctx.tools.execute({
    name,
    callId: ToolCallId(callId),
    arguments: args,
    signal: new AbortController().signal,
    ...(withAgent ? { agent: { id: 'agent-42', session: { id: sessionId } } } : {}),
  });
}

function toolName(ctx, name) {
  const schema = ctx.tools.schemas().find(item => item.name === name);
  assert.ok(schema, `expected registered tool ${name}`);
  return schema.name;
}

test('registers only typed issue and operation tools and keeps Exchange as the state authority', async () => {
  const exchange = await startExchangeFixture();
  const { ctx, dispose, events } = await createToolContext(exchange);
  try {
    assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), [
      'exchange_issue_comment', 'exchange_issue_query', 'exchange_issue_state_update', 'exchange_operation_read',
    ]);
    const query = await execute(ctx, toolName(ctx, 'exchange_issue_query'), { bindingId, issueNumber }, 'query-1');
    assert.equal(query.isError, false);
    assert.deepEqual(query.value, {
      status: 'completed',
      operation: {
        operationId, action: 'integration.issue.query', state: 'SUCCEEDED', issueNumber,
        createdAt: '2026-10-12T12:00:00Z', updatedAt: '2026-10-12T12:00:00Z',
        result: { succeeded: true }, location: `/api/v1/integrations/operations/${operationId}`,
      },
      issue: {
        issueNumber, state: 'OPEN', title: 'Improve ingestion', version: 'sha256:issue-v3',
        freshness: 'FRESH', observedAt: '2026-10-12T12:00:01Z',
      },
    });
    assert.equal(JSON.stringify(query.value).includes('must-not-escape'), false);
    const queryRequest = exchange.requests.find(request => request.method === 'POST');
    assert.equal(queryRequest.headers.authorization, 'Bearer current-user-token');
    assert.equal(queryRequest.url, `/api/v1/integrations/sync-bindings/${bindingId}/issues/actions/query`);
    assert.deepEqual(JSON.parse(queryRequest.body), { issueNumber });
    assert.match(queryRequest.headers['idempotency-key'], /^navigator-exchange-v1:[0-9a-f]{64}$/u);
    const snapshotRequest = exchange.requests.find(request => request.url.endsWith('/actions/snapshot'));
    assert.equal(snapshotRequest.method, 'POST');
    assert.equal(snapshotRequest.headers['idempotency-key'], undefined);
    assert.equal(events[0].sessionId, sessionId);
    assert.equal(events[0].workspaceId, workspaceId);
    assert.equal(events.some(event => event.type === 'approval'), false, 'readonly queries do not use the write approval prompt');

    const queued = await execute(ctx, toolName(ctx, 'exchange_issue_comment'), {
      bindingId, issueNumber, body: 'The fix is ready.',
    }, 'comment-1');
    assert.equal(queued.isError, false);
    assert.equal(queued.value.state, 'QUEUED');
    assert.equal(queued.value.location, `/api/v1/integrations/operations/${operationId}`);
    const post = exchange.requests.filter(request => request.method === 'POST')[2];
    assert.deepEqual(JSON.parse(post.body), { issueNumber, body: 'The fix is ready.' });
    assert.match(post.headers['idempotency-key'], /^navigator-exchange-v1:[0-9a-f]{64}$/u);
    assert.deepEqual(events.find(event => event.type === 'approval').details, {
      bindingId, issueNumber, body: 'The fix is ready.',
    });
    const commentApprovalIndex = events.findIndex(event => event.type === 'approval');
    const commentIdentityIndex = events.findIndex((event, index) => index > commentApprovalIndex
      && event.type === 'identity' && event.sessionId === sessionId);
    assert.ok(commentApprovalIndex < commentIdentityIndex);

    const state = await execute(ctx, toolName(ctx, 'exchange_issue_state_update'), {
      bindingId, issueNumber, state: 'CLOSED',
    }, 'state-1');
    assert.equal(state.isError, false);
    const stateRequest = exchange.requests.filter(request => request.method === 'POST')[3];
    assert.deepEqual(JSON.parse(stateRequest.body), { issueNumber, state: 'CLOSED' });
    assert.notEqual(stateRequest.headers['idempotency-key'], post.headers['idempotency-key']);

    const status = await execute(ctx, toolName(ctx, 'exchange_operation_read'), { operationId }, 'operation-1');
    assert.equal(status.isError, false);
    assert.deepEqual(status.value, {
      operationId, action: 'integration.issue.query', state: 'SUCCEEDED', issueNumber,
      createdAt: '2026-10-12T12:00:00Z', updatedAt: '2026-10-12T12:00:00Z', result: { succeeded: true },
    });
    assert.equal(JSON.stringify(status.value).includes('private intent'), false);
    assert.equal(JSON.stringify(status.value).includes('private-account'), false);
  } finally {
    dispose();
    await ctx.fiber.dispose();
    await exchange.close();
  }
});

test('rejects writes before Exchange when approval is denied', async () => {
  const exchange = await startExchangeFixture();
  const { ctx, dispose } = await createToolContext(exchange, { rejectApproval: true });
  try {
    const result = await execute(ctx, toolName(ctx, 'exchange_issue_comment'), {
      bindingId, issueNumber, body: 'Do not send this.',
    }, 'rejected-comment');
    assert.equal(result.isError, true);
    assert.equal(exchange.requests.length, 0);
  } finally {
    dispose();
    await ctx.fiber.dispose();
    await exchange.close();
  }
});

test('confirmed provider reauthorization returns a durable wait receipt for an approved Exchange write', async () => {
  const exchange = await startExchangeFixture({ reauthorizationRequired: true });
  const { ctx, dispose, events } = await createToolContext(exchange);
  try {
    const result = await execute(ctx, toolName(ctx, 'exchange_issue_comment'), {
      bindingId, issueNumber, body: 'Approved comment awaiting provider reauthorization.',
    }, 'reauthorization-comment');
    assert.equal(result.isError, false);
    assert.deepEqual(result.value, {
      status: 'awaiting_user_authorization',
      code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
      connectionId,
      authorizationRef,
    });
    const wait = events.find(event => event.type === 'authorization-required');
    assert.equal(wait.sessionId, sessionId);
    assert.deepEqual(wait.receipt, {
      callId: 'reauthorization-comment',
      connectionId,
      authorizationRef,
      source: 'issue-action',
      code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
    });
    assert.equal(exchange.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(JSON.stringify(result.value).includes('Provider credentials'), false);
  } finally {
    dispose();
    await ctx.fiber.dispose();
    await exchange.close();
  }
});

test('fails closed without a current first-party user identity', async () => {
  const exchange = await startExchangeFixture();
  const { ctx, dispose } = await createToolContext(exchange, { noIdentity: true });
  try {
    const result = await execute(ctx, toolName(ctx, 'exchange_issue_query'), { bindingId, issueNumber }, 'no-identity');
    assert.equal(result.isError, true);
    assert.match(result.error.message, /current first-party Exchange identity/u);
    assert.equal(exchange.requests.length, 0);
  } finally {
    dispose();
    await ctx.fiber.dispose();
    await exchange.close();
  }
});

test('single-session CLI identity is bound to one configured session and Workspace', () => {
  const previousModelToken = process.env.CYRENE_EXCHANGE_TOKEN;
  const previousUserToken = process.env.CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN;
  try {
    process.env.CYRENE_EXCHANGE_TOKEN = 'model-gateway-token';
    delete process.env.CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN;
    const provider = environmentExchangeUserBearerProvider(sessionId, workspaceId);
    assert.ok(provider);
    assert.equal(
      provider(sessionId, workspaceId, new AbortController().signal),
      undefined,
      'the model gateway credential is not a user identity',
    );
    assert.equal(provider('another-session', workspaceId, new AbortController().signal), undefined);
    assert.equal(provider(sessionId, 'another-workspace', new AbortController().signal), undefined);

    const hostToken = resolveExchangeUserBearerProvider(undefined, false, {
      CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN: 'current-first-party-user-token',
    });
    assert.equal(hostToken(sessionId, workspaceId, new AbortController().signal), undefined,
      'a process token is not lifted into a server identity without explicit single-session mode');

    process.env.CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN = 'current-first-party-user-token';
    const cliToken = resolveExchangeUserBearerProvider(undefined, true, {
      CYRENE_EXCHANGE_INTEGRATION_SESSION_ID: sessionId,
      CYRENE_EXCHANGE_INTEGRATION_WORKSPACE_ID: workspaceId,
    });
    assert.equal(cliToken(sessionId, workspaceId, new AbortController().signal), 'current-first-party-user-token');
    assert.equal(cliToken('another-session', workspaceId, new AbortController().signal), undefined);
  } finally {
    if (previousModelToken === undefined) delete process.env.CYRENE_EXCHANGE_TOKEN;
    else process.env.CYRENE_EXCHANGE_TOKEN = previousModelToken;
    if (previousUserToken === undefined) delete process.env.CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN;
    else process.env.CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN = previousUserToken;
  }
});

test('rejects a 202 Location outside the configured Exchange origin', async () => {
  const exchange = await startExchangeFixture({ invalidLocation: true });
  const { ctx, dispose } = await createToolContext(exchange);
  try {
    const result = await execute(ctx, toolName(ctx, 'exchange_issue_comment'), {
      bindingId, issueNumber, body: 'One queued comment.',
    }, 'bad-location');
    assert.equal(result.isError, true);
    assert.match(result.error.message, /invalid operation Location/u);
  } finally {
    dispose();
    await ctx.fiber.dispose();
    await exchange.close();
  }
});

test('cancels bounded operation polling and returns the queued reference without issue data', async () => {
  const exchange = await startExchangeFixture({ keepQueryQueued: true });
  const client = new ExchangeIntegrationClient({
    baseUrl: exchange.url,
    workspaceId,
    trustedUserBearerProvider: () => 'current-user-token',
  });
  const controller = new AbortController();
  const request = client.queryIssue(bindingId, issueNumber, 'navigator-exchange-v1:cancel-test', {
    sessionId,
    signal: controller.signal,
  });
  try {
    await exchange.queryAccepted;
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort(new DOMException('cancelled', 'AbortError'));
    const result = await request;
    assert.equal(result.status, 'pending');
    assert.equal(result.operation.operationId, operationId);
    assert.equal('issue' in result, false);
    assert.equal(exchange.requests.filter(row => row.method === 'GET' && row.url.startsWith('/api/v1/integrations/operations/')).length, 0);
  } finally {
    await exchange.close();
  }
});

test('rejects an oversized chunked snapshot without a Content-Length header', async () => {
  const exchange = await startExchangeFixture({ oversizedSnapshot: true });
  const { ctx, dispose } = await createToolContext(exchange);
  try {
    const result = await execute(ctx, toolName(ctx, 'exchange_issue_query'), { bindingId, issueNumber }, 'oversized-query');
    assert.equal(result.isError, false);
    assert.equal(result.value.status, 'snapshot-unavailable');
    assert.equal('issue' in result.value, false);
  } finally {
    dispose();
    await ctx.fiber.dispose();
    await exchange.close();
  }
});
