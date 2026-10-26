// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Exchange connector authorization client fixtures            │
// │ Role: Verify exact Teams egress and terminal/429 outcome parsing.    │
// │ 模块职责：验证 Teams 出站请求和终态/限流结果解析。                    │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ExchangeConnectorAuthorizationClient,
  ExchangeConnectorRequestError,
  canonicalJson,
  sha256,
  teamsThreadResourceRef,
  validateTeamsServiceUrl,
} from '../dist/connector-authorization.js';

const connectionRef = '11111111-1111-4111-8111-111111111111';
const profileRef = 'teams-profile-1';
const route = {
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  teamId: 'team-1',
  channelId: 'channel-1',
  conversationId: '19:channel-conversation',
  rootThreadId: '1698765432101',
  serviceUrl: 'https://smba.trafficmanager.net/emea/',
};

function grantFor(input) {
  const argumentsValue = { conversation: route, text: 'The task completed.' };
  const request = {
    requestId: input.requestId,
    workspaceId: 'workspace-1',
    principalIssuer: `https://login.microsoftonline.com/${route.tenantId}/v2.0`,
    principalSubject: '11111111-1111-4111-8111-111111111111',
    connectionRef,
    providerId: 'msteams',
    profileRef,
    operationId: 'msteams.message.reply',
    resourceRef: teamsThreadResourceRef(route),
    argumentsDigestSha256: sha256(canonicalJson(argumentsValue)),
    arguments: argumentsValue,
  };
  const now = Math.floor(Date.now() / 1000);
  return {
    connectorGrantBin: 'AQ==', grantRef: 'sha256:fixture', audience: 'exchange',
    organizationId: 'org-1', issuedAt: now, expiresAt: now + 15, request,
  };
}

async function withHttpResponse(status, headers, responseBody, run) {
  const received = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        grant: request.headers['x-cyrene-connector-grant-bin'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(responseBody));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const client = new ExchangeConnectorAuthorizationClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      hmacKeyFile: '/unused-for-provider-grant-fixture',
      hmacKeyId: 'test-key',
      audience: 'exchange',
    });
    await run(client, received);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('accepts Exchange UNKNOWN tombstones as terminal uncertain delivery', async () => {
  const input = { requestId: 'notification-1:attempt:1', conversation: route, text: 'The task completed.' };
  await withHttpResponse(200, {}, {
    requestId: input.requestId, status: 'uncertain', reasonCode: 'teams_delivery_outcome_unknown',
  }, async (client, received) => {
    const result = await client.sendTeamsMessage(
      input, grantFor(input), connectionRef, profileRef, new AbortController().signal,
    );
    assert.equal(result.outcome, 'uncertain');
    assert.equal(result.reasonCode, 'teams_delivery_outcome_unknown');
    assert.deepEqual(received[0], {
      method: 'POST',
      url: '/internal/v1/teams/messages',
      authorization: undefined,
      grant: 'AQ==',
      body: {
        requestId: input.requestId,
        providerId: 'msteams',
        conversation: route,
        text: input.text,
      },
    });
  });
});

test('retries only an explicit HTTP 429 rate-limit response with bounded Retry-After', async () => {
  const input = { requestId: 'notification-1:attempt:2', conversation: route, text: 'The task completed.' };
  await withHttpResponse(429, { 'retry-after': '45' }, {
    requestId: input.requestId, status: 'rate_limited', reasonCode: 'teams_rate_limited', retryAfterSeconds: 45,
  }, async (client, received) => {
    const result = await client.sendTeamsMessage(
      input, grantFor(input), connectionRef, profileRef, new AbortController().signal,
    );
    assert.deepEqual(result, {
      outcome: 'rate_limited', reasonCode: 'teams_rate_limited', retryAfterSeconds: 45,
    });
    assert.equal(received[0].body.requestId, input.requestId);
  });
});

test('does not classify other 429 responses as safely retryable', async () => {
  const input = { requestId: 'notification-1:attempt:3', conversation: route, text: 'The task completed.' };
  await withHttpResponse(429, { 'retry-after': '45' }, {
    requestId: input.requestId, status: 'uncertain', reasonCode: 'teams_delivery_outcome_unknown',
  }, async client => {
    await assert.rejects(
      client.sendTeamsMessage(input, grantFor(input), connectionRef, profileRef, new AbortController().signal),
      error => error instanceof ExchangeConnectorRequestError
        && error.status === 429 && error.retryAfterSeconds === undefined,
    );
  });
});

test('reads only the fixed signed Exchange authorization snapshot projection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navigator-auth-health-'));
  const keyFile = join(directory, 'hmac.key');
  const key = Buffer.alloc(32, 0x5a);
  await writeFile(keyFile, key, { mode: 0o600 });
  const connectionId = '22222222-2222-4222-8222-222222222222';
  const responseBody = {
    connections: [{
      connectionId,
      provider: 'hf',
      loginState: 'PRESENT',
      authorizationState: 'REAUTHORIZATION_REQUIRED',
      checkedAt: '2026-10-26T15:00:00Z',
      expiresAt: '2026-10-26T16:00:00Z',
      generation: 3,
      capabilities: [{
        capabilityId: 'model.read', state: 'REAUTHORIZATION_REQUIRED',
        lastVerifiedAt: '2026-10-26T15:00:00Z', expiresAt: null, reasonCode: 'TOKEN_EXPIRED',
      }],
      reasonCode: 'TOKEN_EXPIRED',
    }],
  };
  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      bodyText: Buffer.concat(chunks).toString('utf8'),
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(responseBody));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new ExchangeConnectorAuthorizationClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      hmacKeyFile: keyFile,
      hmacKeyId: 'health-key-1',
      audience: 'exchange',
    });
    const snapshots = await client.getAuthorizationHealthSnapshots({
      requestId: 'health-request-1',
      organizationId: 'org-1',
      workspaceId: 'workspace-1',
      connectionIds: [connectionId],
    }, new AbortController().signal);
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/internal/v1/authorization-health/snapshots');
    assert.equal(received.headers.authorization, undefined);
    assert.deepEqual(JSON.parse(received.bodyText), {
      requestId: 'health-request-1', organizationId: 'org-1', workspaceId: 'workspace-1',
      connectionIds: [connectionId],
    });
    const timestamp = received.headers['x-cyrene-navigator-timestamp'];
    const expectedSignature = createHmac('sha256', key)
      .update(`POST\n/internal/v1/authorization-health/snapshots\n${timestamp}\n`, 'utf8')
      .update(received.bodyText, 'utf8')
      .digest('hex');
    assert.equal(received.headers['x-cyrene-navigator-key-id'], 'health-key-1');
    assert.equal(received.headers['x-cyrene-navigator-signature'], expectedSignature);
    assert.deepEqual(snapshots, responseBody.connections);
    assert.equal('authorizationRef' in snapshots[0], false);
    responseBody.connections[0].authorizationRef = 'must-not-be-projected';
    await assert.rejects(
      client.getAuthorizationHealthSnapshots({
        requestId: 'health-request-2',
        organizationId: 'org-1',
        workspaceId: 'workspace-1',
        connectionIds: [connectionId],
      }, new AbortController().signal),
      /unsupported authorization health snapshot/u,
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('canonical JSON matches RFC 8785 number and UTF-16 property ordering', () => {
  const value = {
    '\uE000': 'bmp',
    '𐀀': 'supplementary',
    small: 1e-7,
    decimal: 1e-6,
  };
  assert.equal(
    canonicalJson(value),
    '{"decimal":0.000001,"small":1e-7,"𐀀":"supplementary","":"bmp"}',
  );
});

test('accepts approved regional service URLs and rejects untrusted endpoints', () => {
  assert.equal(validateTeamsServiceUrl('https://smba.trafficmanager.net/emea/', route.tenantId), 'https://smba.trafficmanager.net/emea/');
  assert.equal(validateTeamsServiceUrl('https://smba.trafficmanager.net/amer/22222222-2222-4222-8222-222222222222/', '22222222-2222-4222-8222-222222222222'), 'https://smba.trafficmanager.net/amer/22222222-2222-4222-8222-222222222222/');
  assert.equal(validateTeamsServiceUrl('https://smba.infra.teams.microsoft.com/teams/', route.tenantId), 'https://smba.infra.teams.microsoft.com/teams/');
  for (const value of [
    'https://smba.infra.teams.microsoft.com/emea/',
    'https://smba.trafficmanager.net/emea/other-tenant/',
    'https://smba.trafficmanager.net/emea/?target=other',
    'https://user@smba.trafficmanager.net/emea/',
    'https://smba.trafficmanager.net/%2e%2e/evil',
    'http://smba.trafficmanager.net/emea/',
  ]) {
    assert.throws(() => validateTeamsServiceUrl(value, route.tenantId), /Teams service URL/u);
  }
});
