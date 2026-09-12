// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Cyrene persistence boundary integration                    │
// │ Role: Test real upstream Sessions across a real service restart.   │
// │ 模块职责：通过真实 HTTP 服务验证上游会话、恢复和单写者 fencing。     │
// └─────────────────────────────────────────────────────────────────────┘
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import LlmRuntime, { createMessage, createToolResultMessage, createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { SessionAlreadyOwnedError, SessionOwnershipLostError, SessionReadOnlyError } from '@deepseek-ai/dsh-session-persistence';
import CyreneSessionPersistence from '../dist/persistence.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.CYRENE_TEST_PYTHON ?? join(repository, '.venv/bin/python');

async function startService(directory, token, port = 0) {
  const config = join(directory, 'principals.json');
  await writeFile(config, JSON.stringify({ principals: [{
    token_env: 'CYRENE_TEST_SESSION_TOKEN', actor_id: 'test-owner', workspace_ids: ['proof'],
  }] }));
  const child = spawn(python, [join(repository, 'scripts/serve-persistence.py'),
    '--database', join(directory, 'sessions.sqlite'), '--principal-config', config,
    '--port', String(port), '--lease-seconds', '30'], {
    env: { ...process.env, CYRENE_TEST_SESSION_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', bytes => { logs = (logs + bytes).slice(-4096); });
  const address = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`Service startup timed out: ${logs}`)), 10_000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Service exited ${code}: ${logs}`)); });
    child.stdout.on('data', bytes => {
      stdout += bytes;
      const end = stdout.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(stdout.slice(0, end))); } catch (error) { reject(error); }
    });
  });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/harness/workspaces/proof/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) return { child, baseUrl, port: address.port };
    } catch { /* The socket is bound before Uvicorn finishes activation. */ }
    await delay(20);
  }
  child.kill('SIGKILL');
  throw new Error(`Service never became ready: ${logs}`);
}

async function stopService(service, signal = 'SIGTERM') {
  if (service.child.exitCode !== null || service.child.signalCode !== null) return;
  const exited = once(service.child, 'exit');
  service.child.kill(signal);
  const timer = setTimeout(() => service.child.kill('SIGKILL'), 2000);
  try { await exited; } finally { clearTimeout(timer); }
}

/**
 * Forward real persistence HTTP traffic while dropping exactly one append ack.
 * The upstream response is fully consumed before the client socket is reset, so
 * the database commit is complete while the adapter observes an ambiguous send.
 */
async function startAppendAckDropProxy(targetBaseUrl) {
  let dropNextAppendAck = true;
  let appendRequests = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('error', error => response.destroy(error));
    request.on('end', async () => {
      try {
        const target = new URL(request.url ?? '/', targetBaseUrl);
        const headers = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (value !== undefined && !['connection', 'content-length', 'host'].includes(name)) {
            headers[name] = Array.isArray(value) ? value.join(', ') : value;
          }
        }
        const isAppend = target.pathname.endsWith('/append');
        if (isAppend) appendRequests += 1;
        const upstream = await fetch(target, {
          method: request.method,
          headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.concat(chunks),
          redirect: 'error',
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        if (isAppend && dropNextAppendAck) {
          dropNextAppendAck = false;
          response.destroy();
          return;
        }
        response.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
        });
        response.end(body);
      } catch (error) {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    get appendRequests() { return appendRequests; },
    async close() {
      if (!server.listening) return;
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    },
  };
}

/** Wait for one real upstream Agent to finish a follow-up turn. */
function waitForIdle(ctx, agent) {
  return new Promise(resolveIdle => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose();
        resolveIdle();
      }
    });
  });
}

/** Minimal deterministic adapter used only after a persisted historical-tool resume. */
class RecoveryTextAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(options) {
    options.signal?.throwIfAborted();
    const text = 'Recovered without replaying the historical tool.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

/** Mount the actual upstream AgentLoop over the Cyrene persistence backend. */
async function agentClient(baseUrl, device) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(CyreneSessionPersistence, {
    baseUrl, workspaceId: 'proof', tokenEnv: 'CYRENE_TEST_SESSION_TOKEN', clientId: device,
    requestTimeoutMs: 2_000, heartbeatMs: 250, batchDelayMs: 5,
    maxPendingEvents: 128, batchSize: 2,
  });
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(['mock'], new RecoveryTextAdapter());
  return ctx;
}

async function client(baseUrl, device) {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(CyreneSessionPersistence, {
    baseUrl, workspaceId: 'proof', tokenEnv: 'CYRENE_TEST_SESSION_TOKEN', clientId: device,
    requestTimeoutMs: 2000, heartbeatMs: 250, batchDelayMs: 5,
    maxPendingEvents: 128, batchSize: 2,
  });
  return ctx;
}

test('actual Session events survive service crash, reader restart and writer takeover', { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-persistence-test-'));
  const token = randomUUID();
  process.env.CYRENE_TEST_SESSION_TOKEN = token;
  let service = await startService(directory, token);
  const first = await client(service.baseUrl, 'device-one');
  let second;
  let last;
  try {
    const id = SessionId(`restart-${randomUUID()}`);
    const session = first.sessions.create(id, { meta: { cwd: directory } });
    const writer = await first.sessionPersistence.create(session.header);
    session.append('turn/start', { turn: 1 });
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Persist this exact turn.' }] }), { surfaceOp: 'append' });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    assert.equal(await first.sessions.flush(session), true);
    const expected = structuredClone(session.snapshotEvents());
    assert.deepEqual(await writer.read(), expected);

    second = await client(service.baseUrl, 'device-two');
    const reader = await second.sessionPersistence.open(id, 'read');
    assert.deepEqual(await reader.read(), expected);
    await assert.rejects(reader.append(expected), SessionReadOnlyError);
    await assert.rejects(second.sessionPersistence.open(id, 'write'), SessionAlreadyOwnedError);
    await reader.close();
    await second.fiber.dispose();
    second = undefined;

    const port = service.port;
    await stopService(service, 'SIGKILL');
    service = await startService(directory, token, port);
    assert.deepEqual(await writer.read(), expected);
    second = await client(service.baseUrl, 'device-two-restarted');
    const cold = await second.sessionPersistence.open(id, 'read');
    const restored = second.sessions.prepare(id, {
      seed: structuredClone(await cold.read()), meta: structuredClone(cold.header),
      inheritedEventCount: cold.inheritedEventCount, seedSource: 'persistence',
    });
    assert.deepEqual(restored.snapshotEvents().slice(0, expected.length), expected);
    assert.equal(restored.snapshotEvents().at(-1).type, 'session/end-seed');
    await cold.close();
    const observation = await second.sessionPersistence.http.request(`/${id}/handles`, { access: 'read', clientId: 'observer' });
    const successor = await second.sessionPersistence.resumeWithTakeover(id, observation.epoch,
      () => second.sessionPersistence.open(id, 'write'));
    await assert.rejects(writer.flush(), SessionOwnershipLostError);
    await assert.rejects(writer.append([]), SessionOwnershipLostError);
    await successor.append([{ seq: expected.length, time: Date.now(), type: 'fixture/takeover', data: {}, ignorable: true }]);
    await successor.flush();
    await successor.close();
    await assert.rejects(writer.close(), SessionOwnershipLostError);

    last = await client(service.baseUrl, 'device-three');
    const resumedWriter = await last.sessionPersistence.open(id, 'write');
    assert.equal((await resumedWriter.read()).length, expected.length + 1);
    await resumedWriter.close();
    assert.equal((await last.sessionPersistence.stat(id)).eventCount, expected.length + 1);

    const released = await last.sessionPersistence.http.request(`/${id}/handles`, { access: 'read', clientId: 'observer' });
    await assert.rejects(last.sessionPersistence.resumeWithTakeover(id, released.epoch, async () => {
      throw new Error('The upstream resume failed during setup');
    }), /upstream resume failed/);
    // A failed activation releases its reserved writer instead of stranding the Session.
    const afterFailure = await second.sessionPersistence.open(id, 'write');
    assert.equal((await afterFailure.read()).length, expected.length + 1);
    await afterFailure.close();
  } finally {
    const outcomes = await Promise.allSettled([first, second, last].filter(Boolean).map(ctx => ctx.fiber.dispose()));
    await stopService(service);
    delete process.env.CYRENE_TEST_SESSION_TOKEN;
    await rm(directory, { recursive: true, force: true });
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }
});

test('a committed append remains one batch after an ambiguous lost ack and reconnect', { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-persistence-ack-loss-'));
  const token = randomUUID();
  process.env.CYRENE_TEST_SESSION_TOKEN = token;
  let service = await startService(directory, token);
  let proxy;
  const contexts = [];
  try {
    proxy = await startAppendAckDropProxy(service.baseUrl);
    const first = await client(proxy.baseUrl, 'ack-loss-writer');
    contexts.push(first);
    const id = SessionId(`ack-loss-${randomUUID()}`);
    const session = first.sessions.create(id, {
      meta: { cwd: directory, agentPreset: 'cyrene-navigator' },
    });
    const writer = await first.sessionPersistence.create(session.header);
    const firstBatch = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ];

    // The proxy drops only the response, after the Python service has committed
    // the batch. The client therefore cannot distinguish commit from transport
    // failure and must safely retry the same digest.
    await assert.rejects(writer.append(firstBatch));
    assert.equal(proxy.appendRequests, 1);
    const committedResponse = await fetch(`${service.baseUrl}/api/v1/harness/workspaces/proof/sessions/${encodeURIComponent(id)}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(committedResponse.ok, true);
    const committed = await committedResponse.json();
    assert.deepEqual(committed.events, firstBatch);
    assert.equal(committed.nextSeq, firstBatch.length);

    await writer.append(firstBatch);
    await writer.flush();
    assert.equal(proxy.appendRequests, 2);
    const snapshot = await first.sessionPersistence.stat(id);
    assert.equal(snapshot?.header.id, id);
    assert.equal(snapshot?.header.cwd, directory);
    assert.equal(snapshot?.header.agentPreset, 'cyrene-navigator');
    assert.equal(snapshot?.eventCount, firstBatch.length);
    await writer.close();
    await proxy.close();
    proxy = undefined;

    // Reconnect a fresh runtime after a real service restart, then append a
    // newer prefix through a new writer. The already-open reader must observe
    // exactly the suffix and a new reader must see one contiguous log.
    const port = service.port;
    await stopService(service, 'SIGKILL');
    service = await startService(directory, token, port);
    const reconnected = await client(service.baseUrl, 'reconnected-reader');
    contexts.push(reconnected);
    const reader = await reconnected.sessionPersistence.open(id, 'read');
    assert.deepEqual(await reader.read(), firstBatch);
    const successor = await reconnected.sessionPersistence.open(id, 'write');
    const secondBatch = [
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } },
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
    ];
    await successor.append(secondBatch);
    await successor.flush();
    await successor.close();
    assert.deepEqual(await reader.read(firstBatch.length), secondBatch);
    await reader.close();

    const observer = await client(service.baseUrl, 'fresh-observer');
    contexts.push(observer);
    const observed = await observer.sessionPersistence.open(id, 'read');
    assert.deepEqual(await observed.read(), [...firstBatch, ...secondBatch]);
    await observed.close();
    assert.deepEqual((await observer.sessionPersistence.stat(id))?.eventCount, 4);
  } finally {
    const outcomes = await Promise.allSettled(contexts.map(ctx => ctx.fiber.dispose()));
    await proxy?.close();
    await stopService(service);
    delete process.env.CYRENE_TEST_SESSION_TOKEN;
    await rm(directory, { recursive: true, force: true });
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }
});

test('a persistence outage before append prevents the owning tool from executing', { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-persistence-preflight-'));
  const token = randomUUID();
  process.env.CYRENE_TEST_SESSION_TOKEN = token;
  let service = await startService(directory, token);
  let ctx;
  try {
    ctx = await client(service.baseUrl, 'preflight-writer');
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    const id = SessionId(`preflight-${randomUUID()}`);
    const session = ctx.sessions.create(id, { meta: { cwd: directory } });
    const writer = await ctx.sessionPersistence.create(session.header);
    let executed = 0;
    ctx.tools.register(defineContentToolFixture({
      name: 'must-not-run',
      description: 'increments a test counter when dispatched',
      parameters: {},
      async execute() {
        executed += 1;
        return [{ type: 'text', text: 'unexpected execution' }];
      },
    }));

    const port = service.port;
    await stopService(service, 'SIGKILL');
    session.append('turn/start', { turn: 1 });
    const agent = { id, session };
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('preflight-call'),
      name: 'must-not-run',
      arguments: {},
      agent,
    });
    assert.equal(result.isError, true);
    assert.equal(executed, 0);

    // The event was retained in the handle's volatile queue. Once the real
    // service returns, an explicit flush commits it through the same writer.
    service = await startService(directory, token, port);
    await writer.flush();
    const reader = await ctx.sessionPersistence.open(id, 'read');
    const events = await reader.read();
    await reader.close();
    assert.deepEqual(events.map(event => event.type), ['turn/start']);
    await writer.close();
  } finally {
    await ctx?.fiber.dispose();
    await stopService(service);
    delete process.env.CYRENE_TEST_SESSION_TOKEN;
    await rm(directory, { recursive: true, force: true });
  }
});

test('resume restores a historical tool result without replaying the tool', { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-persistence-resume-tool-'));
  const token = randomUUID();
  process.env.CYRENE_TEST_SESSION_TOKEN = token;
  let service = await startService(directory, token);
  let seeder;
  let restarted;
  let resumed;
  try {
    seeder = await client(service.baseUrl, 'history-seeder');
    const id = SessionId(`historical-tool-${randomUUID()}`);
    const prepared = seeder.sessions.prepare(id, { meta: { cwd: directory, agentPreset: 'cyrene-navigator' } });
    const writer = await seeder.sessionPersistence.create(prepared.header);
    const callId = ToolCallId('historical-call');
    const assistantMessage = createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'historical-sentinel', arguments: '{}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    });
    const toolResultMessage = createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'historical result' }],
      isError: false,
    });
    const historical = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message', seq: 2, time: 3, surfaceOp: 'append',
        data: { turn: 1, step: 1, stream: [], message: assistantMessage },
      },
      {
        type: 'tool/call', seq: 3, time: 4,
        data: { turn: 1, step: 1, callId, name: 'historical-sentinel', arguments: '{}' },
      },
      {
        type: 'tool/result', seq: 4, time: 5, surfaceOp: 'append', sourceEventSeqs: [3],
        data: { turn: 1, step: 1, message: toolResultMessage },
      },
      { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    await writer.append(historical);
    await writer.close();
    await seeder.fiber.dispose();
    seeder = undefined;

    restarted = await agentClient(service.baseUrl, 'history-restarted');
    let executed = 0;
    restarted.tools.register(defineContentToolFixture({
      name: 'historical-sentinel',
      description: 'would be unsafe to replay during resume',
      parameters: {},
      async execute() {
        executed += 1;
        return [{ type: 'text', text: 'unexpected replay' }];
      },
    }));
    resumed = await restarted.agents.resume({
      resumeSessionId: id,
      agentOptions: { provider: 'mock', model: 'mock' },
    });
    assert.equal(executed, 0);
    const restoredEvents = resumed.agent.session.snapshotEvents();
    assert.equal(restoredEvents.filter(event => event.type === 'tool/call').length, 1);
    assert.equal(restoredEvents.filter(event => event.type === 'tool/result').length, 1);

    const idle = waitForIdle(restarted, resumed.agent);
    resumed.agent.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Continue after the recorded result.' }],
    }));
    await idle;
    await restarted.sessions.flush(resumed.agent.session);
    assert.equal(executed, 0);

    const reader = await restarted.sessionPersistence.open(id, 'read');
    const persisted = await reader.read();
    await reader.close();
    assert.equal(persisted.filter(event => event.type === 'tool/call').length, 1);
    assert.equal(persisted.filter(event => event.type === 'tool/result').length, 1);
    assert.deepEqual(persisted.map(event => event.seq), persisted.map((_, index) => index));
  } finally {
    await resumed?.dispose().catch(() => {});
    await seeder?.fiber.dispose().catch(() => {});
    await restarted?.fiber.dispose().catch(() => {});
    await stopService(service);
    delete process.env.CYRENE_TEST_SESSION_TOKEN;
    await rm(directory, { recursive: true, force: true });
  }
});
