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
import { canonicalJson, sha256, ExchangeConnectorAuthorizationClient } from '../dist/connector-authorization.js';
import CyreneSessionPersistence from '../dist/persistence.js';
import { createExecutorApp } from '../dist/serve.js';
import { registerToolProviders } from '../dist/tool-providers.js';
import { registerWorkTools } from '../dist/work-tools.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.CYRENE_TEST_PYTHON ?? join(repository, '.venv/bin/python');

async function startService(directory, token, port = 0, { leaseSeconds = 30, canTakeover = false } = {}) {
  const config = join(directory, 'principals.json');
  await writeFile(config, JSON.stringify({ principals: [{
    token_env: 'CYRENE_TEST_SESSION_TOKEN', actor_id: 'test-owner', workspace_ids: ['proof'], can_takeover: canTakeover,
  }] }));
  const child = spawn(python, [join(repository, 'scripts/serve-persistence.py'),
    '--database', join(directory, 'sessions.sqlite'), '--principal-config', config,
    '--port', String(port), '--lease-seconds', String(leaseSeconds)], {
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

async function client(baseUrl, device, { heartbeatMs = 250 } = {}) {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(CyreneSessionPersistence, {
    baseUrl, workspaceId: 'proof', tokenEnv: 'CYRENE_TEST_SESSION_TOKEN', clientId: device,
    requestTimeoutMs: 2000, heartbeatMs, batchDelayMs: 5,
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
    assert.deepEqual((await writer.read()).events, expected);

    second = await client(service.baseUrl, 'device-two');
    const reader = await second.sessionPersistence.open(id, 'read');
    assert.deepEqual((await reader.read()).events, expected);
    await assert.rejects(reader.append(expected), SessionReadOnlyError);
    await assert.rejects(second.sessionPersistence.open(id, 'write'), SessionAlreadyOwnedError);
    await reader.close();
    await second.fiber.dispose();
    second = undefined;

    const port = service.port;
    await stopService(service, 'SIGKILL');
    service = await startService(directory, token, port);
    assert.deepEqual((await writer.read()).events, expected);
    second = await client(service.baseUrl, 'device-two-restarted');
    const cold = await second.sessionPersistence.open(id, 'read');
    const restored = second.sessions.prepare(id, {
      seed: structuredClone((await cold.read()).events), meta: structuredClone(cold.header),
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
    assert.equal((await resumedWriter.read()).events.length, expected.length + 1);
    await resumedWriter.close();
    assert.equal((await last.sessionPersistence.stat(id)).eventCount, expected.length + 1);

    const released = await last.sessionPersistence.http.request(`/${id}/handles`, { access: 'read', clientId: 'observer' });
    await assert.rejects(last.sessionPersistence.resumeWithTakeover(id, released.epoch, async () => {
      throw new Error('The upstream resume failed during setup');
    }), /upstream resume failed/);
    // A failed activation releases its reserved writer instead of stranding the Session.
    const afterFailure = await second.sessionPersistence.open(id, 'write');
    assert.equal((await afterFailure.read()).events.length, expected.length + 1);
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
  // This test verifies idempotent append recovery, not lease expiry. Keep its writer lease and
  // heartbeat interval outside the test window so event-loop scheduling cannot race a renewal.
  const leaseSeconds = 300;
  let service = await startService(directory, token, 0, { leaseSeconds });
  let proxy;
  const contexts = [];
  try {
    proxy = await startAppendAckDropProxy(service.baseUrl);
    const first = await client(proxy.baseUrl, 'ack-loss-writer', { heartbeatMs: 60_000 });
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
    service = await startService(directory, token, port, { leaseSeconds });
    const reconnected = await client(service.baseUrl, 'reconnected-reader');
    contexts.push(reconnected);
    const reader = await reconnected.sessionPersistence.open(id, 'read');
    assert.deepEqual((await reader.read()).events, firstBatch);
    const successor = await reconnected.sessionPersistence.open(id, 'write');
    const secondBatch = [
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } },
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
    ];
    await successor.append(secondBatch);
    await successor.flush();
    await successor.close();
    assert.deepEqual((await reader.read(firstBatch.length)).events, secondBatch);
    await reader.close();

    const observer = await client(service.baseUrl, 'fresh-observer');
    contexts.push(observer);
    const observed = await observer.sessionPersistence.open(id, 'read');
    assert.deepEqual((await observed.read()).events, [...firstBatch, ...secondBatch]);
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
    const events = (await reader.read()).events;
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

test('production projection uses real Python Work SQL with synthetic provider replies and permits cleanup after exact branch readback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-work-provider-roundtrip-'));
  const token = `provider-roundtrip-${randomUUID()}`;
  const previousSessionToken = process.env.CYRENE_SESSION_TOKEN;
  process.env.CYRENE_SESSION_TOKEN = token;
  let service;
  let ctx;
  let disposeProviders;
  try {
    service = await startService(directory, token, 0, { canTakeover: true });
    const taskId = `teams-task-${randomUUID()}`;
    const sessionId = `teams-session-${randomUUID()}`;
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const apiRoot = `${service.baseUrl}/api/v1/workspaces/proof/work`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const workApi = async (path, method = 'GET', body) => {
      const response = await fetch(`${apiRoot}${path}`, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, value: response.status === 204 ? undefined : await response.json() };
    };
    const created = await workApi('/tasks', 'POST', {
      id: taskId,
      sessionId,
      prompt: 'Create one branch, verify it, then clean it up.',
      metadata: { teamsCaller: { issuer, subject: ownerId, tenantId, actorAadObjectId: ownerId } },
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.value));
    const claimed = await workApi(`/tasks/${encodeURIComponent(taskId)}/claim`, 'POST');
    assert.equal(claimed.response.status, 200, JSON.stringify(claimed.value));

    const bindingId = 'exchange-github-cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const connectionRef = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const profileRef = 'github-profile-provider-roundtrip';
    const catalogSnapshot = {
      schemaVersion: 1,
      items: [{
        bindingId,
        capabilityId: 'tool.provider.v1',
        providerId: 'github',
        connectionRef,
        profileRef,
        tools: [
          {
            id: 'github_vendor_cli',
            name: 'Run GitHub CLI Command',
            description: 'Run one profile-bound argv vector.',
            readOnly: false,
            inputSchema: {
              type: 'object',
              properties: { argv: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string', maxLength: 4096 } } },
              required: ['argv'],
              additionalProperties: false,
            },
          },
          {
            id: 'github.branches.list',
            name: 'List GitHub Branches',
            description: 'Read branches for one exact repository.',
            readOnly: true,
            inputSchema: {
              type: 'object',
              properties: {
                repository_id: { type: 'string', pattern: '^[0-9]+$' },
                repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
              },
              required: ['repository_id', 'repository'],
              additionalProperties: false,
            },
          },
        ],
      }],
    };
    const providerResponses = [
      {
        outcome: 'uncertain', operationRef: 'synthetic-gh-unknown-1',
        result: {
          content: [{ type: 'text', text: JSON.stringify({ state: 'UNKNOWN_RESULT', operation_ref: 'synthetic-gh-unknown-1' }) }],
          structuredContent: { state: 'UNKNOWN_RESULT', operation_ref: 'synthetic-gh-unknown-1' },
          isError: false,
        },
      },
      {
        outcome: 'verified',
        result: {
          content: [{ type: 'text', text: JSON.stringify({ branches: [{ name: 'test-branch', commit_sha: '0123456789abcdef' }] }) }],
          structuredContent: { branches: [{ name: 'test-branch', commit_sha: '0123456789abcdef' }] },
          isError: false,
        },
      },
      { outcome: 'verified', result: { content: [{ type: 'text', text: '{"command_state":"COMMAND_COMPLETED"}' }], isError: false } },
      {
        outcome: 'uncertain', operationRef: 'synthetic-gh-unknown-2',
        result: {
          content: [{ type: 'text', text: JSON.stringify({ state: 'UNKNOWN_RESULT', operation_ref: 'synthetic-gh-unknown-2' }) }],
          structuredContent: { state: 'UNKNOWN_RESULT', operation_ref: 'synthetic-gh-unknown-2' },
          isError: false,
        },
      },
    ];
    const connectorClient = {
      mintInputs: [],
      providerInputs: [],
      async mintGrant(input) {
        this.mintInputs.push(input);
        return {
          connectorGrantBin: 'AQ==', grantRef: `synthetic-grant-${this.mintInputs.length}`, audience: 'exchange',
          organizationId: 'synthetic-org', issuedAt: Math.floor(Date.now() / 1_000),
          expiresAt: Math.floor(Date.now() / 1_000) + 15, request: input,
        };
      },
      async callProviderOperation(input) {
        this.providerInputs.push(input);
        const next = providerResponses.shift();
        if (!next) throw new Error('Unexpected synthetic provider operation');
        return { ...next, requestId: input.requestId };
      },
    };

    ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    const bridge = registerWorkTools(ctx, {
      baseUrl: service.baseUrl,
      workspaceId: 'proof',
      tokenEnv: 'CYRENE_SESSION_TOKEN',
      taskIdForSession: value => value === sessionId ? taskId : undefined,
    });
    disposeProviders = await registerToolProviders(ctx, {
      bridge,
      taskIdForSession: value => value === sessionId ? taskId : undefined,
      connectorAuthorization: {
        client: connectorClient,
        workspaceId: 'proof',
        bindings: new Map([[bindingId, {
          bindingId,
          connectionRef,
          providerId: 'github',
          profileRef,
          tools: [
            { toolId: 'github_vendor_cli', operationId: 'github.vendor.cli.execute', resourceProjection: 'profile', mutating: true },
            { toolId: 'github.branches.list', operationId: 'github.branches.list', resourceProjection: 'github_repository', mutating: false },
          ],
        }]]),
      },
      connectorToolCatalogSnapshot: catalogSnapshot,
    });
    const call = (name, args, id) => ctx.tools.execute({
      name, callId: ToolCallId(id), arguments: args, signal: new AbortController().signal,
      agent: { id: 'navigator-agent', session: { id: sessionId } },
    });
    const cliName = ctx.tools.schemas().find(schema => schema.description.startsWith(`Run GitHub CLI Command (configured provider ${bindingId})`))?.name;
    const branchesName = ctx.tools.schemas().find(schema => schema.description.startsWith(`List GitHub Branches (configured provider ${bindingId})`))?.name;
    assert.ok(cliName);
    assert.ok(branchesName);

    const unknown = await call(cliName, {
      argv: ['api', 'repos/owner/project/git/refs', '-X', 'POST', '-f', 'ref=refs/heads/test-branch'],
    }, 'real-work-cli-unknown');
    assert.equal(unknown.isError, true);
    const receiptId = /Work operation ID: ([a-f0-9]{32})/u.exec(unknown.error.message)?.[1];
    assert.ok(receiptId);

    const branchRead = await call(branchesName, { repository_id: '12345', repository: 'owner/project' }, 'real-work-independent-read');
    assert.equal(branchRead.isError, false);
    const readReceiptId = branchRead.value.structuredContent.workOperationId;
    assert.equal(typeof readReceiptId, 'string');
    const receiptRead = await call('work_operation_read', { operationId: receiptId }, 'read-real-work-operation');
    assert.equal(receiptRead.isError, false);
    assert.equal(receiptRead.value.status, 'uncertain');
    assert.equal(Object.hasOwn(receiptRead.value, 'request'), false);
    const readReceipt = await call('work_operation_read', { operationId: readReceiptId }, 'read-real-branch-operation');
    assert.equal(readReceipt.value.evidence.effect, 'read');

    const verified = await call('work_operation_verify', {
      operationId: receiptId,
      status: 'verified',
      evidence: { independentRead: {
        operationId: readReceiptId,
        confirmed: true,
        observation: 'The exact owner/project branch listing contains test-branch.',
      } },
    }, 'verify-real-work-write');
    assert.equal(verified.isError, false);
    assert.equal(verified.value.operation.evidence.independentRead.match, 'github_cli_api_repo_to_branches_list');

    const cleanup = await call(cliName, {
      argv: ['api', 'repos/owner/project/git/refs/heads/test-branch', '-X', 'DELETE'],
    }, 'real-work-cleanup');
    assert.equal(cleanup.isError, false);
    assert.equal(connectorClient.providerInputs.length, 3);
    const secondUnknown = await call(cliName, {
      argv: ['api', 'repos/owner/project/git/refs/heads/another-branch', '-X', 'DELETE'],
    }, 'real-work-second-unknown');
    assert.equal(secondUnknown.isError, true);
    const providerCount = connectorClient.providerInputs.length;
    const blocked = await call(cliName, {
      argv: ['api', 'repos/owner/project/git/refs/heads/another-branch', '-X', 'DELETE'],
    }, 'real-work-second-blocked');
    assert.equal(blocked.isError, true);
    assert.match(blocked.error.message, /Work operation ID/u);
    assert.equal(connectorClient.providerInputs.length, providerCount);
    assert.equal(connectorClient.mintInputs.length, 4);
    assert.equal(providerResponses.length, 0);
    const stored = await workApi(`/operations/${encodeURIComponent(receiptId)}`);
    assert.equal(stored.value.operation.status, 'verified');
  } finally {
    disposeProviders?.();
    if (ctx) await ctx.fiber.dispose();
    if (service) await stopService(service);
    if (previousSessionToken === undefined) delete process.env.CYRENE_SESSION_TOKEN;
    else process.env.CYRENE_SESSION_TOKEN = previousSessionToken;
    await rm(directory, { recursive: true, force: true });
  }
});

test('resume restores a historical tool result without replaying the tool', { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-persistence-resume-tool-'));
  const token = randomUUID();
  const previousTestToken = process.env.CYRENE_TEST_SESSION_TOKEN;
  process.env.CYRENE_TEST_SESSION_TOKEN = token;
  let service;
  let seeder;
  let restarted;
  let resumed;
  try {
    // This test covers historical resume, not lease expiry; keep the lease clear of host clock corrections.
    service = await startService(directory, token, 0, { leaseSeconds: 120 });
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
    // Prove the prior writer release has committed before AgentLoop resumes the same id.
    const releasedProbe = await restarted.sessionPersistence.open(id, 'write');
    await releasedProbe.read();
    await releasedProbe.close();
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
    const persisted = (await reader.read()).events;
    await reader.close();
    assert.equal(persisted.filter(event => event.type === 'tool/call').length, 1);
    assert.equal(persisted.filter(event => event.type === 'tool/result').length, 1);
    assert.deepEqual(persisted.map(event => event.seq), persisted.map((_, index) => index));
  } finally {
    await resumed?.dispose().catch(() => {});
    await seeder?.fiber.dispose().catch(() => {});
    await restarted?.fiber.dispose().catch(() => {});
    if (service) await stopService(service);
    if (previousTestToken === undefined) delete process.env.CYRENE_TEST_SESSION_TOKEN;
    else process.env.CYRENE_TEST_SESSION_TOKEN = previousTestToken;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Work operation tools reconcile only canonical GitHub targets over real Python Work and SQLite routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-work-receipt-tools-'));
  const token = `work-receipt-${randomUUID()}`;
  const previousToken = process.env.CYRENE_TEST_SESSION_TOKEN;
  process.env.CYRENE_TEST_SESSION_TOKEN = token;
  let service;
  let ctx;
  try {
    service = await startService(directory, token, 0, { canTakeover: true });
    const taskId = `teams-task-${randomUUID()}`;
    const sessionId = `teams-session-${randomUUID()}`;
    const root = `${service.baseUrl}/api/v1/workspaces/proof/work`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${root}${path}`, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, value: response.status === 204 ? undefined : await response.json() };
    };
    const task = await api('/tasks', 'POST', { id: taskId, sessionId, prompt: 'Reconcile a synthetic GitHub branch write.' });
    assert.equal(task.response.status, 201, JSON.stringify(task.value));
    const claimed = await api(`/tasks/${encodeURIComponent(taskId)}/claim`, 'POST');
    assert.equal(claimed.response.status, 200, JSON.stringify(claimed.value));
    assert.equal(claimed.value.claimed, true);

    const bindingId = 'exchange-github-real-work-connection';
    const profileRef = 'github-profile-real-work-test';
    const repository = 'owner/project';
    const repositoryId = '12345';
    const providerId = 'github';
    const cliTarget = { profile_ref: profileRef };
    const cliDigest = sha256(canonicalJson({ providerId, profileRef, target: cliTarget }));
    const branchTarget = { repository_id: repositoryId, repository };
    const branchDigest = sha256(canonicalJson({ providerId, profileRef, target: branchTarget }));
    const wrongTarget = { repository_id: '54321', repository: 'owner/another-project' };
    const wrongDigest = sha256(canonicalJson({ providerId, profileRef, target: wrongTarget }));
    const listDigest = sha256(canonicalJson({ providerId, profileRef, target: { profile_ref: profileRef } }));
    const createReceipt = async ({ key, operationId, toolId, args, target, targetDigest, effect, status }) => {
      const created = await api('/operations', 'POST', {
        idempotencyKey: key,
        operationType: `tool.provider.v1:${operationId}`,
        taskId,
        target,
        request: { bindingId, toolId, operationId, arguments: args },
      });
      assert.ok([200, 201].includes(created.response.status), JSON.stringify(created.value));
      const operation = created.value.operation;
      const updated = await api(`/operations/${encodeURIComponent(operation.id)}`, 'PATCH', {
        status,
        evidence: {
          outcome: status === 'uncertain' ? 'uncertain' : 'verified',
          effect, bindingId, providerId, profileRef, operationId,
          targetDigestSha256: targetDigest,
          ...(effect === 'read' ? { resultSha256: sha256(canonicalJson({ branches: ['test-branch'] })) } : {}),
        },
      });
      assert.equal(updated.response.status, 200, JSON.stringify(updated.value));
      return updated.value.operation;
    };

    const write = await createReceipt({
      key: `cli-write-${randomUUID()}`,
      operationId: 'github.vendor.cli.execute',
      toolId: 'github_vendor_cli',
      args: { argv: ['api', 'repos/owner/project/git/refs', '-X', 'POST', '-f', 'ref=refs/heads/test-branch'] },
      target: `connector-target:${cliDigest}`, targetDigest: cliDigest,
      effect: 'write', status: 'uncertain',
    });
    const wrongRead = await createReceipt({
      key: `wrong-branch-read-${randomUUID()}`,
      operationId: 'github.branches.list', toolId: 'github.branches.list', args: wrongTarget,
      target: `connector-readback:${wrongDigest}`, targetDigest: wrongDigest,
      effect: 'read', status: 'verified',
    });
    const profileListRead = await createReceipt({
      key: `profile-list-read-${randomUUID()}`,
      operationId: 'github.repository.list', toolId: 'github.repository.list', args: {},
      target: `connector-readback:${listDigest}`, targetDigest: listDigest,
      effect: 'read', status: 'verified',
    });
    const branchesRead = await createReceipt({
      key: `branch-read-${randomUUID()}`,
      operationId: 'github.branches.list', toolId: 'github.branches.list', args: branchTarget,
      target: `connector-readback:${branchDigest}`, targetDigest: branchDigest,
      effect: 'read', status: 'verified',
    });

    ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    registerWorkTools(ctx, {
      baseUrl: service.baseUrl,
      workspaceId: 'proof',
      tokenEnv: 'CYRENE_TEST_SESSION_TOKEN',
      taskIdForSession: value => value === sessionId ? taskId : undefined,
    });
    const call = (name, args, id) => ctx.tools.execute({
      name, callId: ToolCallId(id), arguments: args, signal: new AbortController().signal,
      agent: { id: 'navigator-agent', session: { id: sessionId } },
    });

    const readWrite = await call('work_operation_read', { operationId: write.id }, 'read-real-work-write');
    assert.equal(readWrite.isError, false);
    assert.equal(readWrite.value.id, write.id);
    assert.equal(readWrite.value.status, 'uncertain');
    assert.equal(Object.hasOwn(readWrite.value, 'request'), false);

    for (const readReceipt of [wrongRead, profileListRead]) {
      const rejected = await call('work_operation_verify', {
        operationId: write.id,
        status: 'verified',
        evidence: { independentRead: {
          operationId: readReceipt.id,
          confirmed: true,
          observation: 'This read does not prove the exact requested GitHub branch target.',
        } },
      }, `reject-read-${readReceipt.id}`);
      assert.equal(rejected.isError, true);
    }
    const before = await api(`/operations/${encodeURIComponent(write.id)}`);
    assert.equal(before.value.operation.status, 'uncertain');

    const reconciled = await call('work_operation_verify', {
      operationId: write.id,
      status: 'verified',
      evidence: { independentRead: {
        operationId: branchesRead.id,
        confirmed: true,
        observation: 'The owner/project branches response contains test-branch.',
      } },
    }, 'verify-real-branch-target');
    assert.equal(reconciled.isError, false);
    assert.equal(reconciled.value.operation.evidence.independentRead.match, 'github_cli_api_repo_to_branches_list');
    assert.equal(reconciled.value.operation.evidence.independentRead.repository, repository);
    const persisted = await api(`/operations/${encodeURIComponent(write.id)}`);
    assert.equal(persisted.value.operation.status, 'verified');
    assert.equal(persisted.value.operation.evidence.independentRead.targetDigestSha256, branchDigest);
    const noFence = await api(`/operations/unresolved?target=${encodeURIComponent(`connector-target:${cliDigest}`)}`);
    assert.deepEqual(noFence.value.items, []);

    const cleanup = await createReceipt({
      key: `cli-cleanup-${randomUUID()}`,
      operationId: 'github.vendor.cli.execute', toolId: 'github_vendor_cli',
      args: { argv: ['api', 'repos/owner/project/git/refs/heads/test-branch', '-X', 'DELETE'] },
      target: `connector-target:${cliDigest}`, targetDigest: cliDigest,
      effect: 'write', status: 'verified',
    });
    assert.equal(cleanup.status, 'verified');
    const unresolvedWrite = await createReceipt({
      key: `cli-unknown-delete-${randomUUID()}`,
      operationId: 'github.vendor.cli.execute', toolId: 'github_vendor_cli',
      args: { argv: ['api', 'repos/owner/project/git/refs/heads/another-branch', '-X', 'DELETE'] },
      target: `connector-target:${cliDigest}`, targetDigest: cliDigest,
      effect: 'write', status: 'uncertain',
    });
    const blocked = await api('/operations', 'POST', {
      idempotencyKey: `blocked-${randomUUID()}`,
      operationType: 'tool.provider.v1:github.vendor.cli.execute',
      taskId,
      target: `connector-target:${cliDigest}`,
      request: { bindingId, toolId: 'github_vendor_cli', operationId: 'github.vendor.cli.execute', arguments: { argv: ['api', 'repos/owner/project/git/refs', '-X', 'DELETE'] } },
    });
    assert.equal(unresolvedWrite.status, 'uncertain');
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.value.code, 'WORK_OPERATION_TARGET_UNRESOLVED');
  } finally {
    if (ctx) await ctx.fiber.dispose();
    if (service) await stopService(service);
    if (previousToken === undefined) delete process.env.CYRENE_TEST_SESSION_TOKEN;
    else process.env.CYRENE_TEST_SESSION_TOKEN = previousToken;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Navigator cold boots launcher-authorized tools from a private catalog file fixture when Work has none', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-connector-catalog-'));
  const token = `connector-catalog-${randomUUID()}`;
  const previousSessionToken = process.env.CYRENE_SESSION_TOKEN;
  process.env.CYRENE_SESSION_TOKEN = token;
  let service;
  let app;
  try {
    service = await startService(directory, token, 0, { canTakeover: true });
    const bindingId = 'exchange-github-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const connectionRef = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const profileRef = 'github-profile-coldboot';
    const bindingsPath = join(directory, 'connector-bindings.json');
    const catalogPath = join(directory, 'connector-tool-catalog.json');
    await writeFile(bindingsPath, JSON.stringify({
      schemaVersion: 1,
      bindings: [{
        bindingId, connectionRef, providerId: 'github', profileRef,
        tools: [{
          toolId: 'github_vendor_cli',
          operationId: 'github.vendor.cli.execute',
          resourceProjection: 'profile',
          mutating: true,
        }],
      }],
    }), { mode: 0o600 });
    await writeFile(catalogPath, JSON.stringify({
      schemaVersion: 1,
      items: [{
        bindingId,
        capabilityId: 'tool.provider.v1',
        providerId: 'github',
        connectionRef,
        profileRef,
        tools: [
          {
            id: 'github_vendor_cli',
            name: 'Run GitHub CLI Command',
            description: 'Run a fixed authorized GitHub CLI argv vector.',
            readOnly: false,
            inputSchema: {
              type: 'object',
              properties: { argv: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string', maxLength: 4096 } } },
              required: ['argv'],
              additionalProperties: false,
            },
          },
          {
            id: 'github.repository.list',
            name: 'List GitHub Repositories',
            description: 'List repositories for this profile.',
            readOnly: true,
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      }],
    }), { mode: 0o600 });

    app = await createExecutorApp({
      testMode: true,
      modelSource: 'codebuddy',
      model: 'glm-5.3-flash',
      persistenceUrl: service.baseUrl,
      workspaceId: 'proof',
      authTokenEnv: 'CYRENE_SESSION_TOKEN',
      pluginsDir: join(directory, 'plugins'),
      watchPlugins: false,
      enableWorkflows: false,
      connectorBindingsPath: bindingsPath,
      connectorToolCatalogPath: catalogPath,
      teams: {
        connectorId: 'teams-coldboot',
        tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        allowedTeamIds: ['team-1'],
        botAppId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        taskActorSubjects: ['11111111-1111-4111-8111-111111111111'],
        ingressSecretEnv: 'TEAMS_COLD_BOOT_HMAC_KEY',
        exchangeConnectionRef: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        exchangeProfileRef: 'teams-profile-coldboot',
        exchangeAuthorization: new ExchangeConnectorAuthorizationClient({
          baseUrl: 'http://127.0.0.1:1',
          hmacKeyFile: join(directory, 'unused-exchange-key'),
          hmacKeyId: 'coldboot-test',
          audience: 'exchange',
        }),
      },
    });
    const schemas = app.ctx.tools.schemas();
    assert.equal(schemas.some(schema => schema.description.startsWith(`Run GitHub CLI Command (configured provider ${bindingId})`)), true);
    assert.equal(schemas.some(schema => schema.description.includes('List GitHub Repositories')), false);
    assert.equal(schemas.some(schema => schema.name === 'work_operation_read'), true);
  } finally {
    if (app) {
      await app.executor.dispose();
      await app.pluginManager?.dispose();
      await app.ctx.fiber.dispose();
    }
    if (service) await stopService(service);
    if (previousSessionToken === undefined) delete process.env.CYRENE_SESSION_TOKEN;
    else process.env.CYRENE_SESSION_TOKEN = previousSessionToken;
    await rm(directory, { recursive: true, force: true });
  }
});
