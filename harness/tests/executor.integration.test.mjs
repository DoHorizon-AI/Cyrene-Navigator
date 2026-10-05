// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Executor & Work-State Integration Tests          │
// │ Role: Verify truthful execution, auth, Exchange, replay, and abort. │
// │ 模块职责：验证真实执行状态、认证、Exchange、重放与取消。              │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createExecutorApp } from '../dist/serve.js';
import { InMemoryWorkStateStore, WorkStateClient } from '../dist/work-state-client.js';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

const TEST_BEARER = 'executor-test-token';
process.env.CYRENE_EXECUTOR_TOKEN = TEST_BEARER;

class TestMockAdapter extends LlmAdapter {
  constructor({ delayMs = 0, failure } = {}) {
    super();
    this.delayMs = delayMs;
    this.failure = failure;
    this.calls = 0;
  }

  async *stream(options) {
    this.calls += 1;
    if (this.delayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(done, this.delayMs);
        function done() {
          options.signal?.removeEventListener('abort', aborted);
          resolve();
        }
        function aborted() {
          clearTimeout(timer);
          reject(new Error('LLM call aborted'));
        }
        if (options.signal?.aborted) aborted();
        else options.signal?.addEventListener('abort', aborted, { once: true });
      });
    }
    if (options.signal?.aborted) throw new Error('LLM call aborted');
    if (this.failure) throw new Error(this.failure);
    const prompt = options.messages?.at(-1)?.content?.[0]?.text ?? '';
    const reasoning = `Thinking about "${prompt}"`;
    const reply = `Executed: "${prompt}" successfully.`;

    yield { type: 'block-start', index: 0, blockType: 'reasoning' };
    yield { type: 'reasoning-delta', index: 0, text: reasoning };
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } };
    yield { type: 'block-start', index: 1, blockType: 'text' };
    yield { type: 'text-delta', index: 1, text: reply };
    yield { type: 'block-end', index: 1, block: { type: 'text', text: reply } };
    yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 25, totalTokens: 40 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function createTestApp(adapter = new TestMockAdapter(), options = {}) {
  return createExecutorApp({
    testMode: true,
    authTokenEnv: 'CYRENE_EXECUTOR_TOKEN',
    customLlmAdapter: { provider: 'test-mock', adapter },
    model: 'mock-v1',
    ...options,
  });
}

async function disposeApp(app) {
  await app.executor.dispose();
  await app.pluginManager?.dispose();
  await app.ctx.fiber.dispose();
}

async function waitForTask(executor, taskId, predicate, timeoutMs = 3_000) {
  const deadline = performance.now() + timeoutMs;
  let last;
  while (performance.now() < deadline) {
    const task = await executor.getTask(taskId);
    last = task;
    if (task && predicate(task)) return task;
    await delay(10);
  }
  throw new Error(`Task ${taskId} did not reach the expected state (last status: ${last?.status ?? 'missing'})`);
}

test('NavigatorExecutor: executes one-shot work and persists truthful output and events', async () => {
  const { executor, ctx } = await createTestApp();
  try {
    const outcome = await executor.executeTask({ prompt: 'Summarize system telemetry' });
    assert.equal(outcome.status, 'completed');
    assert.ok(outcome.output.includes('Executed: "Summarize system telemetry" successfully.'));
    assert.ok(outcome.reasoning.includes('Thinking about "Summarize system telemetry"'));
    assert.ok(outcome.durationMs >= 0);

    const taskRecord = await executor.getTask(outcome.taskId);
    assert.equal(taskRecord.status, 'completed');
    assert.equal(taskRecord.id, outcome.taskId);
    assert.ok(taskRecord.endedAt >= taskRecord.startedAt);
    const events = await executor['config'].workState.getEvents(outcome.taskId, 0);
    assert.ok(events.events.some(row => row.event.type === 'text-delta'));
    assert.ok(events.events.some(row => row.event.type === 'finish' && row.event.status === 'completed'));
    assert.ok(events.events.every((row, index) => row.seq === index + 1));
  } finally {
    await disposeApp({ executor, ctx });
  }
});

test('NavigatorExecutor: a thrown model stream becomes failed with an error event', async () => {
  const { executor, ctx } = await createTestApp(new TestMockAdapter({ failure: 'provider stream exploded' }));
  try {
    const outcome = await executor.executeTask({ taskId: 'stream-failure', prompt: 'Fail deliberately' });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error, /provider stream exploded/u);
    const record = await executor.getTask('stream-failure');
    assert.equal(record.status, 'failed');
    assert.match(record.error, /provider stream exploded/u);
    const events = await executor['config'].workState.getEvents('stream-failure', 0);
    assert.ok(events.events.some(row => row.event.type === 'error' && row.event.message.includes('provider stream exploded')));
    assert.ok(events.events.some(row => row.event.type === 'finish' && row.event.status === 'failed'));
  } finally {
    await disposeApp({ executor, ctx });
  }
});

test('NavigatorExecutor: a rejected terminal persistence write cannot publish successful completion', async () => {
  const store = new InMemoryWorkStateStore();
  const patchTask = store.patchTask.bind(store);
  store.patchTask = async (taskId, patch) => {
    if (patch.status === 'completed') throw new Error('terminal write rejected');
    return patchTask(taskId, patch);
  };
  const app = await createTestApp(new TestMockAdapter(), { workStateStore: store });
  try {
    const result = await app.executor.executeTask({ taskId: 'terminal-write-failure', prompt: 'Produce an answer' });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /terminal write rejected/u);
    assert.equal((await store.getTask(result.taskId)).status, 'failed');
    const { events } = await store.getEvents(result.taskId);
    assert.ok(events.some(row => row.event.type === 'finish' && row.event.status === 'failed'));
    assert.ok(!events.some(row => row.event.type === 'finish' && row.event.status === 'completed'));
  } finally {
    await disposeApp(app);
  }
});

test('NavigatorExecutor: cancellation aborts the model and records an aborted terminal result', async () => {
  const adapter = new TestMockAdapter({ delayMs: 5_000 });
  const { executor, ctx } = await createTestApp(adapter);
  try {
    const execution = executor.executeTask({ taskId: 'cancel-test-task', prompt: 'This task will be aborted' });
    await waitForTask(executor, 'cancel-test-task', task => task.status === 'running');
    assert.equal(await executor.cancelTask('cancel-test-task'), true);
    const outcome = await execution;
    assert.equal(outcome.status, 'aborted');
    assert.match(outcome.error, /cancelled by caller|aborted/u);
    assert.equal((await executor.getTask('cancel-test-task')).status, 'aborted');
    assert.ok(adapter.calls > 0);
  } finally {
    await disposeApp({ executor, ctx });
  }
});

test('NavigatorExecutor: simultaneous tasks in one session keep output and tool ownership separate', async () => {
  const adapter = new TestMockAdapter({ delayMs: 40 });
  const app = await createTestApp(adapter);
  const { executor } = app;
  try {
    const first = executor.executeTask({ taskId: 'fifo-first', sessionId: 'fifo-session', prompt: 'FIRST-ONLY' });
    await waitForTask(executor, 'fifo-first', task => task.status === 'running');
    const second = executor.executeTask({ taskId: 'fifo-second', sessionId: 'fifo-session', prompt: 'SECOND-ONLY' });
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.status, 'completed');
    assert.equal(two.status, 'completed');
    assert.match(one.output, /FIRST-ONLY/u);
    assert.doesNotMatch(one.output, /SECOND-ONLY/u);
    assert.match(two.output, /SECOND-ONLY/u);
    assert.doesNotMatch(two.output, /FIRST-ONLY/u);
    assert.equal(adapter.calls, 2);
    const a = await executor.getTask('fifo-first');
    const b = await executor.getTask('fifo-second');
    assert.ok(b.startedAt >= a.endedAt, 'the second task must not claim the session while the first owns it');
    for (const [id, own, other] of [['fifo-first', 'FIRST-ONLY', 'SECOND-ONLY'], ['fifo-second', 'SECOND-ONLY', 'FIRST-ONLY']]) {
      const replay = await executor['config'].workState.getEvents(id, 0);
      const text = replay.events.filter(row => row.event.type === 'text-delta').map(row => row.event.text).join('');
      assert.match(text, new RegExp(own));
      assert.doesNotMatch(text, new RegExp(other));
    }
  } finally {
    await disposeApp(app);
  }
});

test('NavigatorExecutor: queued API admissions stay queued until dispatch and all task routes authenticate', async () => {
  const app = await createTestApp(new TestMockAdapter(), { allowedOrigins: ['https://trusted.example'] });
  const { executor, ctx } = app;
  const { url, close } = await executor.startServer(0, '127.0.0.1');
  const auth = { Authorization: `Bearer ${TEST_BEARER}` };
  try {
    const unauthorized = await fetch(`${url}/api/v1/tasks`);
    assert.equal(unauthorized.status, 401);
    const deniedSse = await fetch(`${url}/api/v1/tasks/missing/events`);
    assert.equal(deniedSse.status, 401);

    const admitted = await fetch(`${url}/api/v1/tasks`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Queued HTTP task' }),
    });
    assert.equal(admitted.status, 202);
    const record = await admitted.json();
    assert.equal(record.status, 'queued');
    assert.match(record.sessionId, /^session-/u);
    const completed = await waitForTask(executor, record.id, task => ['completed', 'failed', 'aborted'].includes(task.status));
    assert.equal(completed.status, 'completed', completed.error);
    assert.ok(completed.output.includes('Queued HTTP task'));

    const getTask = await fetch(`${url}/api/v1/tasks/${record.id}`, { headers: auth });
    assert.equal(getTask.status, 200);
    assert.equal((await getTask.json()).status, 'completed');
    const replay = await fetch(`${url}/api/v1/tasks/${record.id}/events?after=0`, { headers: auth });
    assert.equal(replay.status, 200);
    const replayText = await replay.text();
    assert.match(replayText, /id: \d+\nevent: finish/u);
    assert.match(replayText, /"status":"completed"/u);

    const pluginsDenied = await fetch(`${url}/api/v1/plugins`);
    assert.equal(pluginsDenied.status, 401);
    const evilOrigin = await fetch(`${url}/api/v1/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(evilOrigin.headers.get('access-control-allow-origin'), null);
    const allowedOrigin = await fetch(`${url}/api/v1/health`, { headers: { Origin: 'https://trusted.example' } });
    assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), 'https://trusted.example');
  } finally {
    await close();
    await disposeApp(app);
  }
});

test('NavigatorExecutor: an admitted task can be cancelled before the dispatcher claims it', async () => {
  const { executor, ctx } = await createTestApp();
  try {
    const admitted = await executor.startTask({ taskId: 'cancel-queued', prompt: 'Do not execute' });
    assert.equal(admitted.status, 'queued');
    assert.equal(executor.activeTaskId(admitted.sessionId), undefined);
    assert.equal(await executor.cancelTask(admitted.id), true);
    assert.equal((await executor.getTask(admitted.id)).status, 'aborted');
    assert.equal(await executor.drainQueuedTasks(), 0);
  } finally {
    await disposeApp({ executor, ctx });
  }
});

test('NavigatorExecutor: recovery adopts safe queued rows and fails uncertain or human-gated rows', async () => {
  const store = new InMemoryWorkStateStore();
  const queued = await store.createTask({ id: 'recover-queued', sessionId: 'session-queued', prompt: 'Safe to start' });
  const running = await store.createTask({ id: 'recover-running', sessionId: 'session-running', prompt: 'Do not replay' });
  await store.claimTask(running.id);
  const approval = await store.createTask({ id: 'recover-approval', sessionId: 'session-approval', prompt: 'Review first' });
  await store.claimTask(approval.id);
  await store.patchTask(approval.id, { status: 'waiting_approval' });

  const adapter = new TestMockAdapter();
  const { executor, ctx } = await createTestApp(adapter, { workStateStore: store });
  try {
    assert.equal(await executor.drainQueuedTasks(), 1);
    await waitForTask(executor, queued.id, task => task.status === 'completed');
    assert.equal((await executor.getTask(running.id)).status, 'failed');
    assert.equal((await executor.getTask(approval.id)).status, 'failed');
    assert.equal(adapter.calls, 1, 'only a never-claimed queued row may run after restart');
    const interrupted = await store.getEvents(running.id, 0);
    assert.ok(interrupted.events.some(row => row.event.code === 'EXECUTOR_RESTARTED'));
    const gated = await store.getEvents(approval.id, 0);
    assert.ok(gated.events.some(row => row.event.code === 'EXECUTOR_RESTARTED'));
  } finally {
    await disposeApp({ executor, ctx });
  }
});

test('WorkStateClient: requests use the configured workspace bearer and decode nullable timestamps', async () => {
  const previousToken = process.env.CYRENE_SESSION_TOKEN;
  process.env.CYRENE_SESSION_TOKEN = 'work-test-token';
  const seen = [];
  const server = createServer(async (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization, method: req.method });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/workspaces/acme/work/tasks/other') {
      res.writeHead(404).end(JSON.stringify({ code: 'WORK_TASK_NOT_FOUND' }));
      return;
    }
    if (req.url === '/api/v1/workspaces/acme/work/tasks/item') {
      res.end(JSON.stringify({
        id: 'item', workspaceId: 'acme', sessionId: 'session-1', prompt: 'hi', status: 'queued',
        createdAt: 10, startedAt: null, endedAt: null, output: '', reasoning: '', error: null,
        durationMs: 0, sequence: 1,
      }));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ code: 'WORK_TASK_NOT_FOUND' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = new WorkStateClient({ baseUrl: `http://127.0.0.1:${port}`, workspaceId: 'acme' });
    assert.equal((await client.getTask('item')).startedAt, undefined);
    assert.equal(await client.getTask('other'), undefined);
    assert.equal(seen.length, 2);
    assert.ok(seen.every(row => row.url.startsWith('/api/v1/workspaces/acme/work/tasks/')));
    assert.ok(seen.every(row => row.authorization === 'Bearer work-test-token'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousToken === undefined) delete process.env.CYRENE_SESSION_TOKEN;
    else process.env.CYRENE_SESSION_TOKEN = previousToken;
  }
});

test('Exchange adapter: configured Exchange receives authenticated request and streams a real completion', async () => {
  const previousToken = process.env.CYRENE_EXCHANGE_TOKEN;
  process.env.CYRENE_EXCHANGE_TOKEN = 'exchange-test-token';
  let captured;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = {
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Exchange replied."},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      'data: [DONE]',
      '',
    ].join('\n'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const app = await createExecutorApp({
    testMode: true,
    authTokenEnv: 'CYRENE_EXECUTOR_TOKEN',
    exchangeUrl: `http://127.0.0.1:${port}`,
    model: 'exchange-test-model',
  });
  try {
    const result = await app.executor.executeTask({ prompt: 'Use configured Exchange' });
    assert.equal(result.status, 'completed');
    assert.match(result.output, /Exchange replied/u);
    assert.equal(captured.url, '/v1/chat/completions');
    assert.equal(captured.authorization, 'Bearer exchange-test-token');
    assert.equal(captured.body.model, 'exchange-test-model');
    assert.equal(captured.body.stream, true);
    assert.equal(captured.body.messages.at(-1).content, 'Use configured Exchange');
  } finally {
    await disposeApp(app);
    await new Promise(resolve => server.close(resolve));
    if (previousToken === undefined) delete process.env.CYRENE_EXCHANGE_TOKEN;
    else process.env.CYRENE_EXCHANGE_TOKEN = previousToken;
  }
});

test('DynamicPluginManager: hot-reloads a plugin while a durable session remains usable', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cyrene-plugin-test-'));
  const app = await createTestApp(new TestMockAdapter(), { pluginsDir: tempDir, watchPlugins: false });
  try {
    const initialOutcome = await app.executor.executeTask({ sessionId: 'hot-reload-session', prompt: 'Initial step' });
    assert.equal(initialOutcome.status, 'completed');
    const pluginFile = join(tempDir, 'sample-service.mjs');
    await writeFile(pluginFile, "export const name = 'sample-service'; export function apply(ctx) { ctx.provide('sampleService', { getVersion: () => 1 }); }");
    assert.equal((await app.pluginManager.loadPlugin('sample-service', pluginFile)).status, 'loaded');
    assert.equal(app.ctx.get('sampleService')?.getVersion(), 1);
    await writeFile(pluginFile, "export const name = 'sample-service'; export function apply(ctx) { ctx.provide('sampleService', { getVersion: () => 2 }); }");
    assert.equal((await app.pluginManager.reloadPlugin('sample-service')).status, 'loaded');
    assert.equal(app.ctx.get('sampleService')?.getVersion(), 2);
    const next = await app.executor.executeTask({ sessionId: 'hot-reload-session', prompt: 'Follow-up step' });
    assert.equal(next.status, 'completed');
    assert.equal(next.sessionId, 'hot-reload-session');
    assert.equal(await app.pluginManager.unloadPlugin('sample-service'), true);
  } finally {
    await disposeApp(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});
