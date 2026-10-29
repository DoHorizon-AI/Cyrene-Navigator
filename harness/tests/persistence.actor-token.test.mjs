// ┌─────────────────────────────────────────────────────────────────────┐
// │ Test: Actor-specific Session persistence credentials                │
// │ Scope: Trusted per-session routing, missing-map denial and restart. │
// │ 测试职责：验证按可信 session 选择凭据、映射缺失拒绝与重启恢复。       │
// └─────────────────────────────────────────────────────────────────────┘
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import CyreneSessionPersistence from '../dist/persistence.js';
import { loadWorkActorTokenReferences } from '../dist/work-state-client.js';

const DEFAULT_ENV = 'CYRENE_SESSION_TOKEN';
const OWNER_ENV = 'CYRENE_TEST_OWNER_SESSION_TOKEN';
const ALICE_ENV = 'CYRENE_TEST_ALICE_SESSION_TOKEN';
const BOB_ENV = 'CYRENE_TEST_BOB_SESSION_TOKEN';
const CAROL_ENV = 'CYRENE_TEST_CAROL_SESSION_TOKEN';

function handle(row, access, nextSeq = 0) {
  return {
    id: row.id,
    header: row.header,
    inheritedEventCount: 0,
    access,
    nextSeq,
    epoch: 1,
    ...(access === 'write' ? { writerToken: `writer-${row.id}`, leaseExpiresAt: Date.now() + 60_000 } : {}),
  };
}

async function startPersistenceFixture() {
  const requests = [];
  const rows = new Map();
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const marker = '/sessions';
        const route = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
        const parts = route.split('/').filter(Boolean);
        const id = parts[0] === undefined ? undefined : decodeURIComponent(parts[0]);
        const operation = parts.slice(1).join('/');
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
        requests.push({ method: request.method, route, authorization: request.headers.authorization });

        if (request.method === 'GET' && route === '') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ items: [] }));
          return;
        }
        if (request.method === 'POST' && route === '') {
          const row = { id: body.header.id, header: body.header, events: [] };
          rows.set(row.id, row);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(handle(row, 'write')));
          return;
        }
        const row = id === undefined ? undefined : rows.get(id);
        if (row === undefined) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ code: 'SESSION_NOT_FOUND' }));
          return;
        }
        if (request.method === 'GET' && operation === '') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ meta: row.header, revision: 'revision-1', eventCount: row.events.length }));
          return;
        }
        if (request.method === 'GET' && operation === 'events') {
          const offset = Number(url.searchParams.get('offset') ?? 0);
          const length = Number(url.searchParams.get('length') ?? row.events.length);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ events: row.events.slice(offset, offset + length), nextSeq: row.events.length }));
          return;
        }
        if (request.method === 'POST' && operation === 'handles') {
          const access = body.takeoverExpectedEpoch === undefined ? body.access : 'write';
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(handle(row, access, row.events.length)));
          return;
        }
        if (request.method === 'POST' && operation === 'append') {
          row.events.push(...body.events);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ nextSeq: row.events.length }));
          return;
        }
        if (request.method === 'POST' && ['flush', 'heartbeat', 'release'].includes(operation)) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'NOT_FOUND' }));
      } catch {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'FIXTURE_ERROR' }));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function client(baseUrl, tokenForSession, privateForSession) {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(CyreneSessionPersistence, {
    baseUrl,
    workspaceId: 'proof',
    tokenEnv: DEFAULT_ENV,
    tokenEnvForSession: tokenForSession,
    actorPrivateScopeForSession: privateForSession,
    clientId: `actor-token-test-${randomUUID()}`,
    requestTimeoutMs: 2_000,
    heartbeatMs: 60_000,
    batchDelayMs: 0,
    maxPendingEvents: 16,
    batchSize: 8,
  });
  return ctx;
}

function saveEnvironment(names) {
  const saved = new Map(names.map(name => [name, process.env[name]]));
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test('private Session requests use explicit actor credentials and never fall back after a mapping is lost', { timeout: 10_000 }, async () => {
  const restoreEnvironment = saveEnvironment([DEFAULT_ENV, OWNER_ENV, ALICE_ENV, BOB_ENV, CAROL_ENV]);
  const tokens = {
    default: `default-${randomUUID()}`,
    owner: `owner-${randomUUID()}`,
    alice: `alice-${randomUUID()}`,
    bob: `bob-${randomUUID()}`,
    carol: `carol-${randomUUID()}`,
  };
  process.env[DEFAULT_ENV] = tokens.default;
  process.env[OWNER_ENV] = tokens.owner;
  process.env[ALICE_ENV] = tokens.alice;
  process.env[BOB_ENV] = tokens.bob;
  process.env[CAROL_ENV] = tokens.carol;

  const fixture = await startPersistenceFixture();
  const mapping = new Map([
    ['teams-owner', OWNER_ENV],
    ['teams-alice', ALICE_ENV],
    ['teams-bob', BOB_ENV],
    ['teams-carol', CAROL_ENV],
    // Legacy owner-only mode remains explicit; the pilot registry uses only dedicated entries.
    ['teams-legacy-owner', DEFAULT_ENV],
  ]);
  const tokenForSession = sessionId => mapping.get(sessionId);
  const privateForSession = sessionId => sessionId.startsWith('teams-');
  const first = await client(fixture.baseUrl, tokenForSession, privateForSession);
  let restarted;
  try {
    for (const sessionId of ['teams-owner', 'teams-alice', 'teams-bob', 'teams-carol', 'teams-legacy-owner']) {
      const session = first.sessions.create(SessionId(sessionId), { meta: { cwd: '/tmp' } });
      const writer = await first.sessionPersistence.create(session.header);
      await writer.append([{
        seq: 0,
        time: Date.now(),
        type: 'fixture/actor-token',
        data: { sessionId },
        ignorable: true,
      }]);
      assert.equal((await writer.read()).events.length, 1);
      await writer.flush();
      await writer.close();
      assert.equal((await first.sessionPersistence.stat(SessionId(sessionId))).eventCount, 1);
      const reader = await first.sessionPersistence.open(SessionId(sessionId), 'read');
      assert.equal((await reader.read()).events.length, 1);
      await reader.close();
      const takeover = await first.sessionPersistence.takeover(SessionId(sessionId), 1);
      await takeover.close();
    }

    const globalListStart = fixture.requests.length;
    await first.sessionPersistence.list();
    assert.deepEqual(
      fixture.requests.slice(globalListStart).map(request => request.authorization),
      [`Bearer ${tokens.default}`],
      'workspace listing stays on the server-filtered configured credential',
    );

    for (const [sessionId, token] of [
      ['teams-owner', tokens.owner],
      ['teams-alice', tokens.alice],
      ['teams-bob', tokens.bob],
      ['teams-carol', tokens.carol],
      ['teams-legacy-owner', tokens.default],
    ]) {
      const sessionRequests = fixture.requests.filter(request => request.route.startsWith(`/${sessionId}`));
      assert.ok(sessionRequests.length > 0);
      assert.ok(sessionRequests.every(request => request.authorization === `Bearer ${token}`), sessionId);
    }

    const requestCountBeforeMissingMapping = fixture.requests.length;
    mapping.delete('teams-alice');
    await assert.rejects(first.sessionPersistence.stat(SessionId('teams-alice')), /dedicated persistence credential/u);
    assert.equal(fixture.requests.length, requestCountBeforeMissingMapping, 'missing mapping fails before network access');

    restarted = await client(fixture.baseUrl, tokenForSession, privateForSession);
    const restartedListStart = fixture.requests.length;
    await restarted.sessionPersistence.list();
    assert.deepEqual(fixture.requests.slice(restartedListStart).map(request => request.authorization), [`Bearer ${tokens.default}`]);
    const restartedRequestCount = fixture.requests.length;
    await assert.rejects(restarted.sessionPersistence.stat(SessionId('teams-alice')), /dedicated persistence credential/u);
    assert.equal(fixture.requests.length, restartedRequestCount, 'restart without a rehydrated actor map does not use the owner token');

    mapping.set('teams-alice', ALICE_ENV);
    assert.equal((await restarted.sessionPersistence.stat(SessionId('teams-alice'))).eventCount, 1);
    assert.equal(fixture.requests.at(-1).authorization, `Bearer ${tokens.alice}`, 'rehydrated host mapping restores only Alice’s route');

    const reader = await restarted.sessionPersistence.open(SessionId('teams-alice'), 'read');
    mapping.delete('teams-alice');
    const beforeLostHandleRead = fixture.requests.length;
    await assert.rejects(reader.read(), /dedicated persistence credential/u);
    assert.equal(fixture.requests.length, beforeLostHandleRead, 'handle reads re-check the host mapping');
    await reader.close();

    mapping.set('teams-alice', ALICE_ENV);
    const writer = await restarted.sessionPersistence.takeover(SessionId('teams-alice'), 1);
    mapping.delete('teams-alice');
    const beforeLostHandleMutation = fixture.requests.length;
    await assert.rejects(writer.flush(), /dedicated persistence credential/u);
    assert.equal(fixture.requests.length, beforeLostHandleMutation, 'lease mutations re-check the host mapping');
    mapping.set('teams-alice', ALICE_ENV);
    await writer.close();

    const sharedRequestStart = fixture.requests.length;
    await restarted.sessionPersistence.requestForSession(SessionId('ordinary-shared-session'), '');
    assert.equal(fixture.requests[sharedRequestStart].authorization, `Bearer ${tokens.default}`);

    const missingRequestStart = fixture.requests.length;
    await assert.rejects(
      () => restarted.sessionPersistence.requestForSession(SessionId('teams-unmapped'), '/teams-unmapped'),
      /dedicated persistence credential/u,
    );
    assert.equal(fixture.requests.length, missingRequestStart);
  } finally {
    await Promise.all([first.fiber.dispose(), restarted?.fiber.dispose()].filter(Boolean));
    await fixture.close();
    restoreEnvironment();
  }
});

test('POSIX Work actor token map loader accepts the native absolute temp file', {
  skip: process.platform === 'win32'
    ? 'Private Work actor maps require POSIX UID/mode checks until Windows ACL verification is implemented.'
    : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navigator-work-actor-map-'));
  const mapPath = join(directory, 'actors.json');
  await writeFile(mapPath, JSON.stringify({
    schemaVersion: 1,
    workspaceId: 'proof',
    actors: [{
      actorAadObjectId: '11111111-1111-4111-8111-111111111111',
      tokenEnv: OWNER_ENV,
    }],
  }), { mode: 0o600 });
  try {
    assert.equal(isAbsolute(mapPath), true);
    assert.deepEqual(await loadWorkActorTokenReferences(mapPath, 'proof'), [{
      actorAadObjectId: '11111111-1111-4111-8111-111111111111',
      tokenEnv: OWNER_ENV,
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Work actor token map still rejects a relative path on every platform', async () => {
  await assert.rejects(
    loadWorkActorTokenReferences(join('relative', 'actors.json'), 'proof'),
    /absolute and bounded/u,
  );
});

test('Windows refuses a native absolute private actor-map path until ACL verification exists', {
  skip: process.platform === 'win32' ? false : 'Windows-only private-file guard test.',
}, async () => {
  const nativePath = join(tmpdir(), 'navigator-private-actor-map-not-read.json');
  assert.equal(isAbsolute(nativePath), true);
  await assert.rejects(
    loadWorkActorTokenReferences(nativePath, 'proof'),
    /unsupported on Windows until ACL verification is available/u,
  );
});
