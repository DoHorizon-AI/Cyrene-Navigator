// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator durable input receipt integration                  │
// │ Role: Verify receipts use only the committed Cyrene event prefix.    │
// │ 模块职责：验证 receipt 只读取已提交的 Cyrene 事件前缀。                   │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import CyreneSessionPersistence from '../dist/persistence.js';
import { inputReceiptsRequest, MAX_INPUT_RECEIPT_EVENTS } from '../dist/session-control.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.CYRENE_TEST_PYTHON ?? join(repository, '.venv/bin/python');
const tokenEnv = 'CYRENE_RECEIPT_SESSION_TOKEN';
const workspaceId = 'proof';

/** Start the actual SQLite-backed persistence authority used by this suite. */
async function startService(directory, token) {
  const config = join(directory, 'principals.json');
  await writeFile(config, JSON.stringify({ principals: [{
    token_env: tokenEnv, actor_id: 'receipt-owner', workspace_ids: [workspaceId],
  }] }));
  const child = spawn(python, [join(repository, 'scripts/serve-persistence.py'),
    '--database', join(directory, 'sessions.sqlite'), '--principal-config', config,
    '--port', '0', '--lease-seconds', '30'], {
    env: { ...process.env, [tokenEnv]: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = `${stderr}${bytes.toString()}`.slice(-4096); });
  const address = await new Promise((resolveAddress, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`persistence startup timed out: ${stderr}`)), 10_000);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`persistence exited ${String(code)}: ${stderr}`)));
    child.stdout.on('data', bytes => {
      stdout += bytes.toString();
      const end = stdout.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      try { resolveAddress(JSON.parse(stdout.slice(0, end))); }
      catch (error) { reject(error); }
    });
  });
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/harness/workspaces/${workspaceId}/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) return { child, baseUrl };
    } catch {
      // The listener binds before Uvicorn finishes activating the app.
    }
    await delay(20);
  }
  child.kill('SIGKILL');
  throw new Error(`persistence service never became ready: ${stderr}`);
}

/** Stop one service child without leaving a test process behind. */
async function stopService(service) {
  if (service === undefined || service.child.exitCode !== null || service.child.signalCode !== null) return;
  const exited = once(service.child, 'exit');
  service.child.kill('SIGTERM');
  await Promise.race([exited, delay(5_000)]);
  if (service.child.exitCode === null && service.child.signalCode === null) service.child.kill('SIGKILL');
}

/** Mount the real SessionStore and Cyrene persistence client. */
async function client(baseUrl, token, device, selectedWorkspace = workspaceId, selectedTokenEnv = tokenEnv, batchDelayMs = 1_000) {
  process.env[selectedTokenEnv] = token;
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(CyreneSessionPersistence, {
    baseUrl,
    workspaceId: selectedWorkspace,
    tokenEnv: selectedTokenEnv,
    clientId: device,
    requestTimeoutMs: 2_000,
    heartbeatMs: 250,
    batchDelayMs,
    maxPendingEvents: 8_192,
    batchSize: 256,
  });
  return ctx;
}

/** Build the authenticated product request without exposing its content. */
function receiptRequest(body, signal) {
  return new Request('http://navigator.test/api/cyrene/session/input-receipts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

async function receipt(persistence, body, signal) {
  const response = await inputReceiptsRequest(persistence, receiptRequest(body, signal));
  return { status: response.status, body: await response.json() };
}

/** Append one DSH turn whose user source carries the client RPC id. */
function appendTurn(session, turn, requestId, reason = 'completed', sourceKind = 'user') {
  session.append('turn/start', { turn });
  const source = sourceKind === 'user'
    ? { kind: 'user', rpcId: requestId }
    : { kind: sourceKind, plugin: 'receipt-fixture', rpcId: requestId };
  session.append('user/message', createUserMessage({
    source,
    content: [{ type: 'text', text: `receipt fixture ${requestId}` }],
  }), { surfaceOp: 'append' });
  session.append('turn/end', { turn, reason: { kind: reason } });
}

/** Read a JSON response without retaining any raw event or prompt payload. */
async function responseBody(response) {
  return { status: response.status, body: await response.json() };
}

test('receipt confirms only durable completed turns and remains read-only', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-input-receipt-'));
  const token = randomUUID();
  let service;
  let ctx;
  try {
    service = await startService(directory, token);
    ctx = await client(service.baseUrl, token, 'receipt-writer');
    const id = SessionId(`receipt-${randomUUID()}`);
    const session = ctx.sessions.create(id, { meta: { cwd: directory } });
    const writer = await ctx.sessionPersistence.create(session.header);

    // Session events are live before the configured batch timer / flush. The
    // receipt must not observe this in-memory completed turn.
    appendTurn(session, 1, 'rpc-live-unflushed');
    const beforeFlush = await receipt(ctx.sessionPersistence, {
      sessionId: id, requestIds: ['rpc-live-unflushed'],
    });
    assert.equal(beforeFlush.status, 200);
    assert.deepEqual(beforeFlush.body.completedRequestIds, []);
    assert.equal(beforeFlush.body.eventCount, 0);

    await ctx.sessions.flush(session);
    const afterFlush = await receipt(ctx.sessionPersistence, {
      sessionId: id, requestIds: ['rpc-live-unflushed'],
    });
    assert.deepEqual(afterFlush.body.completedRequestIds, ['rpc-live-unflushed']);
    assert.equal(afterFlush.body.eventCount, 3);

    appendTurn(session, 2, 'rpc-failed', 'error');
    appendTurn(session, 3, 'rpc-cancelled', 'canceled');
    appendTurn(session, 4, 'rpc-completed');
    await ctx.sessions.flush(session);
    const persistedBefore = await ctx.sessionPersistence.stat(id);
    assert.ok(persistedBefore);
    const mixed = await receipt(ctx.sessionPersistence, {
      sessionId: id,
      requestIds: ['rpc-failed', 'rpc-completed', 'rpc-cancelled', 'rpc-unseen', 'rpc-completed'],
    });
    assert.equal(mixed.status, 200);
    assert.deepEqual(mixed.body.completedRequestIds, ['rpc-completed']);
    assert.equal(mixed.body.eventCount, persistedBefore.eventCount);
    const persistedAfter = await ctx.sessionPersistence.stat(id);
    assert.deepEqual(
      { eventCount: persistedAfter?.eventCount, revision: persistedAfter?.revision },
      { eventCount: persistedBefore.eventCount, revision: persistedBefore.revision },
    );

    // The upstream validator permits plugin-authored user-role messages. They
    // must not be mistaken for browser prompt receipts even if a plugin adds a
    // colliding rpcId-shaped field. | 插件消息即使带 rpcId 也不能冒充用户提交。
    appendTurn(session, 5, 'rpc-plugin-spoof', 'completed', 'plugin');
    await ctx.sessions.flush(session);
    const pluginResult = await receipt(ctx.sessionPersistence, {
      sessionId: id, requestIds: ['rpc-plugin-spoof'],
    });
    assert.equal(pluginResult.status, 200);
    assert.deepEqual(pluginResult.body.completedRequestIds, []);
    await writer.close();
  } finally {
    await ctx?.fiber.dispose().catch(() => {});
    await stopService(service);
    delete process.env[tokenEnv];
    await rm(directory, { recursive: true, force: true });
  }
});

test('receipt tail is bounded and cannot confirm a request outside the retained prefix', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-input-receipt-tail-'));
  const token = randomUUID();
  let service;
  let ctx;
  try {
    service = await startService(directory, token);
    ctx = await client(service.baseUrl, token, 'receipt-tail-writer');
    const id = SessionId(`receipt-tail-${randomUUID()}`);
    const session = ctx.sessions.create(id, { meta: { cwd: directory } });
    const writer = await ctx.sessionPersistence.create(session.header);
    const events = [
      { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
      {
        seq: 1,
        time: 2,
        type: 'user/message',
        surfaceOp: 'append',
        data: createUserMessage({
          source: { kind: 'user', rpcId: 'rpc-before-tail' },
          content: [{ type: 'text', text: 'tail boundary fixture' }],
        }),
      },
      { seq: 2, time: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    const prefixLength = events.length;
    for (let seq = prefixLength; seq < MAX_INPUT_RECEIPT_EVENTS + prefixLength; seq++) {
      events.push({ seq, time: seq + 1, type: 'fixture/receipt-tail', data: {}, ignorable: true });
    }
    await writer.append(events);
    await writer.close();
    const before = await ctx.sessionPersistence.stat(id);
    const result = await receipt(ctx.sessionPersistence, {
      sessionId: id, requestIds: ['rpc-before-tail'],
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.completedRequestIds, []);
    assert.equal(result.body.eventCount, events.length);
    const after = await ctx.sessionPersistence.stat(id);
    assert.deepEqual(
      { eventCount: after?.eventCount, revision: after?.revision },
      { eventCount: before?.eventCount, revision: before?.revision },
    );
  } finally {
    await ctx?.fiber.dispose().catch(() => {});
    await stopService(service);
    delete process.env[tokenEnv];
    await rm(directory, { recursive: true, force: true });
  }
});

test('receipt clamps the read to the stat prefix when an append races the read', async () => {
  const sessionId = SessionId('receipt-stat-prefix');
  const readCalls = [];
  let closed = false;
  const prefix = [
    { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
    {
      seq: 1,
      time: 2,
      type: 'user/message',
      data: createUserMessage({
        source: { kind: 'user', rpcId: 'rpc-failed-before-stat' },
        content: [{ type: 'text', text: 'prefix fixture' }],
      }),
    },
    { seq: 2, time: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } },
  ];
  const appendedAfterStat = [
    { seq: 3, time: 4, type: 'turn/start', data: { turn: 2 } },
    {
      seq: 4,
      time: 5,
      type: 'user/message',
      data: createUserMessage({
        source: { kind: 'user', rpcId: 'rpc-appended-after-stat' },
        content: [{ type: 'text', text: 'race fixture' }],
      }),
    },
    { seq: 5, time: 6, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ];
  const persistence = {
    async stat(id) {
      assert.equal(id, sessionId);
      return {
        header: { id: sessionId, cwd: '/workspace' },
        revision: '3:prefix',
        eventCount: prefix.length,
      };
    },
    async open(id, access) {
      assert.equal(id, sessionId);
      assert.equal(access, 'read');
      return {
        async read(offset, length) {
          readCalls.push({ offset, length });
          // The backend has grown after stat. A bounded read must still return
          // only the prefix witnessed by stat, even if the backend would now
          // satisfy a larger request with the appended completed turn.
          return [...prefix, ...appendedAfterStat].slice(offset, offset + length);
        },
        async close() { closed = true; },
      };
    },
  };

  const result = await receipt(persistence, {
    sessionId,
    requestIds: ['rpc-failed-before-stat', 'rpc-appended-after-stat'],
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.eventCount, prefix.length);
  assert.deepEqual(result.body.completedRequestIds, []);
  assert.deepEqual(readCalls, [{ offset: 0, length: prefix.length }]);
  assert.equal(closed, true);
});

test('receipt rejects an oversized streaming body before opening persistence', async () => {
  let pulls = 0;
  let cancelled = false;
  let statCalls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) controller.enqueue(new Uint8Array(8 * 1024));
      else if (pulls === 2) controller.enqueue(new Uint8Array(1));
      else controller.close();
    },
    cancel() { cancelled = true; },
  });
  const response = await inputReceiptsRequest({
    async stat() { statCalls += 1; throw new Error('persistence must not open'); },
    async open() { throw new Error('persistence must not open'); },
  }, new Request('http://navigator.test/api/cyrene/session/input-receipts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    duplex: 'half',
  }));

  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'REQUEST_TOO_LARGE');
  assert.equal(statCalls, 0);
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
});

test('receipt rejects malformed, cross-workspace, and unauthenticated backend reads', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-input-receipt-boundary-'));
  const token = randomUUID();
  const badToken = randomUUID();
  let service;
  let ctx;
  let outside;
  let unauthorized;
  try {
    service = await startService(directory, token);
    ctx = await client(service.baseUrl, token, 'receipt-boundary');
    const id = SessionId(`receipt-boundary-${randomUUID()}`);
    const invalidMethod = await inputReceiptsRequest(
      ctx.sessionPersistence,
      new Request('http://navigator.test/api/cyrene/session/input-receipts', { method: 'GET' }),
    );
    assert.equal(invalidMethod.status, 405);
    const invalidIds = await receipt(ctx.sessionPersistence, { sessionId: id, requestIds: [] });
    assert.equal(invalidIds.status, 400);
    assert.equal(invalidIds.body.code, 'INVALID_REQUEST_IDS');
    const tooManyIds = await receipt(ctx.sessionPersistence, {
      sessionId: id, requestIds: Array.from({ length: 9 }, (_, index) => `rpc-${index}`),
    });
    assert.equal(tooManyIds.status, 400);
    assert.equal(tooManyIds.body.code, 'INVALID_REQUEST_IDS');
    const oversized = await responseBody(await inputReceiptsRequest(
      ctx.sessionPersistence,
      receiptRequest({ sessionId: id, requestIds: ['rpc-size'], padding: 'x'.repeat(9_000) }),
    ));
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.code, 'REQUEST_TOO_LARGE');
    assert.equal(JSON.stringify(oversized.body).includes(id), false);

    outside = await client(service.baseUrl, token, 'receipt-outside', 'outside');
    const crossWorkspace = await receipt(outside.sessionPersistence, {
      sessionId: id, requestIds: ['rpc-hidden'],
    });
    assert.equal(crossWorkspace.status, 503);
    assert.equal(crossWorkspace.body.code, 'INPUT_RECEIPT_READ_FAILED');
    assert.equal(JSON.stringify(crossWorkspace.body).includes(id), false);

    unauthorized = await client(service.baseUrl, badToken, 'receipt-unauthorized', workspaceId, 'CYRENE_RECEIPT_BAD_TOKEN');
    const denied = await receipt(unauthorized.sessionPersistence, {
      sessionId: id, requestIds: ['rpc-hidden'],
    });
    assert.equal(denied.status, 503);
    assert.equal(denied.body.code, 'INPUT_RECEIPT_READ_FAILED');
    assert.equal(JSON.stringify(denied.body).includes(badToken), false);
  } finally {
    await Promise.allSettled([ctx, outside, unauthorized].filter(Boolean).map(value => value.fiber.dispose()));
    await stopService(service);
    delete process.env[tokenEnv];
    delete process.env.CYRENE_RECEIPT_BAD_TOKEN;
    await rm(directory, { recursive: true, force: true });
  }
});

test('receipt propagates an already-aborted request without opening persistence', async () => {
  const controller = new AbortController();
  controller.abort();
  const fakePersistence = {
    stat: async () => { throw new Error('read must not start'); },
    open: async () => { throw new Error('read must not start'); },
  };
  await assert.rejects(
    inputReceiptsRequest(fakePersistence, receiptRequest({ sessionId: 'aborted', requestIds: ['rpc-aborted'] }, controller.signal)),
    error => error?.name === 'AbortError',
  );
});

test('receipt aborts a delayed read, closes the handle, and returns no partial result', async () => {
  const controller = new AbortController();
  const sessionId = SessionId('receipt-delayed-abort');
  let readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  let closed = false;
  let statSignal;
  let openSignal;
  let readSignal;
  const persistence = {
    async stat(id, options) {
      assert.equal(id, sessionId);
      statSignal = options?.signal;
      return {
        header: { id: sessionId, cwd: '/workspace' },
        revision: '3:delayed-abort',
        eventCount: 3,
      };
    },
    async open(id, access, options) {
      assert.equal(id, sessionId);
      assert.equal(access, 'read');
      openSignal = options?.signal;
      return {
        async read(_offset, _length, options) {
          readStarted();
          await new Promise((_resolve, reject) => {
            const signal = options?.signal;
            readSignal = signal;
            assert.ok(signal);
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return [{ seq: 0, time: 1, type: 'fixture/partial', data: {} }];
        },
        async close() { closed = true; },
      };
    },
  };
  const request = receiptRequest(
    { sessionId, requestIds: ['rpc-delayed-abort'] }, controller.signal,
  );
  const result = inputReceiptsRequest(persistence, request);
  await Promise.race([
    started,
    delay(2_000).then(() => { throw new Error('receipt read did not start'); }),
  ]);
  assert.equal(statSignal, request.signal);
  assert.equal(openSignal, request.signal);
  assert.equal(readSignal, request.signal);
  controller.abort();
  await assert.rejects(result, error => error?.name === 'AbortError');
  assert.equal(closed, true);
});
