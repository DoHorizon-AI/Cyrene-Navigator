// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Executor & Work-State Integration Tests          │
// │ Role: Verify truthful execution, auth, Exchange, replay, and abort. │
// │ 模块职责：验证真实执行状态、认证、Exchange、重放与取消。              │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createExecutorApp } from '../dist/serve.js';
import { parseCredentialNotificationsConfig } from '../dist/executor.js';
import { InMemoryWorkStateStore, WorkStateClient, WorkStateHttpError } from '../dist/work-state-client.js';
import { ExchangeConnectorAuthorizationClient, ExchangeConnectorRequestError, canonicalJson } from '../dist/connector-authorization.js';
import { disposeWithin } from '../../scripts/serve-executor.mjs';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';

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

async function waitForActiveTask(executor, sessionId, expectedTaskId, timeoutMs = 3_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (executor.activeTaskId(sessionId) === expectedTaskId) return;
    await delay(10);
  }
  throw new Error('Task ' + expectedTaskId + ' did not acquire the active DSH session');
}

test('credential notification configuration pins the owner and only one allowed Teams destination', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const config = {
    schemaVersion: 1,
    organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workspaceId: 'workspace-credential-health',
    owner: {
      actorAadObjectId: '11111111-1111-4111-8111-111111111111',
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      subject: '11111111-1111-4111-8111-111111111111',
      tenantId,
    },
    connections: [{ connectionId: '22222222-2222-4222-8222-222222222222', provider: 'hf' }],
    destination: {
      tenantId,
      teamId: 'team-1',
      channelId: '19:notice-channel@thread.tacv2',
      conversationId: '19:notice-channel@thread.tacv2;messageid=1793027795187',
      rootThreadId: '1793027795187',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
    },
    exchange: {
      profileRef: 'teams-credential-notifications-20261026',
    },
    pollIntervalMs: 900_000,
  };
  const parsed = parseCredentialNotificationsConfig(config, config.workspaceId, tenantId, ['team-1']);
  assert.equal(parsed.owner.subject, config.owner.subject);
  assert.deepEqual(parsed.connections, config.connections);
  assert.deepEqual(parsed.destination, config.destination);
  assert.equal(parsed.pollIntervalMs, 900_000);
  assert.throws(() => parseCredentialNotificationsConfig({ ...config, accessToken: 'forbidden' }, config.workspaceId, tenantId, ['team-1']), /invalid scope or schema/u);
  assert.throws(() => parseCredentialNotificationsConfig(config, config.workspaceId, tenantId, ['other-team']), /outside the configured Teams scope/u);
  assert.throws(() => parseCredentialNotificationsConfig({ ...config, owner: { ...config.owner, subject: '44444444-4444-4444-8444-444444444444' } }, config.workspaceId, tenantId, ['team-1']), /owner does not match/u);
});

async function createPausedAuthorizationTask(store, taskId, sessionId) {
  const record = await store.createTask({ id: taskId, sessionId, prompt: 'Original task prompt must not replay.' });
  await store.claimTask(record.id);
  await store.patchTask(record.id, {
    status: 'awaiting_user_authorization',
    output: 'Completed safe checks before the provider reauthorization wait.',
  });
  await store.appendEvent(record.id, {
    type: 'authorization-required',
    taskId: record.id,
    callId: 'authorization-call-' + taskId,
    code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
    source: 'connection-resources',
    connectionId: '7e1c50d2-b4f3-4d61-9302-9a0bd48d1991',
    authorizationRef: 'native-authorization-ref',
    generation: 4,
    timestamp: Date.now(),
  });
  await store.appendEvent(record.id, {
    type: 'finish',
    taskId: record.id,
    status: 'awaiting_user_authorization',
    output: 'Completed safe checks before the provider reauthorization wait.',
    durationMs: 10,
    timestamp: Date.now(),
  });
  return record;
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
    const resumePreflight = await fetch(`${url}/api/v1/tasks/source/resume`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://trusted.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key',
      },
    });
    assert.equal(resumePreflight.status, 204);
    assert.match(resumePreflight.headers.get('access-control-allow-headers') ?? '', /Idempotency-Key/iu);
  } finally {
    await close();
    await disposeApp(app);
  }
});

test('NavigatorExecutor: drain control is bearer-protected and resumes only the exact generation token', async () => {
  const adapter = new TestMockAdapter();
  const app = await createTestApp(adapter);
  const { executor } = app;
  const { url, close } = await executor.startServer(0, '127.0.0.1');
  const auth = { Authorization: `Bearer ${TEST_BEARER}`, 'Content-Type': 'application/json' };
  try {
    const unauthorized = await fetch(`${url}/internal/v1/executor/drain`);
    assert.equal(unauthorized.status, 401);

    const initial = await fetch(`${url}/internal/v1/executor/drain`, { headers: auth });
    assert.equal(initial.status, 200);
    const initialStatus = await initial.json();
    assert.equal(initialStatus.mode, 'accepting');
    assert.equal(initialStatus.generation, 0);
    assert.equal(initialStatus.token, null);
    assert.match(initialStatus.instanceId, /^[0-9a-f-]{36}$/u);

    const invalidDrain = await fetch(`${url}/internal/v1/executor/drain`, {
      method: 'POST', headers: auth, body: JSON.stringify({ force: true }),
    });
    assert.equal(invalidDrain.status, 400);

    const started = await fetch(`${url}/internal/v1/executor/drain`, {
      method: 'POST', headers: auth, body: JSON.stringify({}),
    });
    assert.equal(started.status, 200);
    const draining = await started.json();
    assert.equal(draining.mode, 'draining');
    assert.equal(draining.generation, 1);
    assert.match(draining.token, /^[0-9a-f-]{36}$/u);
    assert.equal(draining.activeWorkDrained, true);

    const admitted = await fetch(`${url}/api/v1/execute`, {
      method: 'POST', headers: auth, body: JSON.stringify({ prompt: 'Persist while draining' }),
    });
    assert.equal(admitted.status, 202);
    const queued = await admitted.json();
    assert.equal(queued.status, 'queued');
    const statusWhileQueued = await fetch(`${url}/internal/v1/executor/drain`, { headers: auth });
    const queuedStatus = await statusWhileQueued.json();
    assert.equal(queuedStatus.queuedTasks, 1);
    assert.equal(queuedStatus.activeWorkDrained, true, 'durable queued work does not block an idle drain');

    const manualTaskDispatch = await fetch(`${url}/api/v1/tasks/${queued.taskId}/dispatch`, {
      method: 'POST', headers: auth,
    });
    assert.equal(manualTaskDispatch.status, 202);
    assert.equal((await manualTaskDispatch.json()).status, 'queued');
    const manualQueueDrain = await fetch(`${url}/api/v1/tasks/dispatch`, {
      method: 'POST', headers: auth,
    });
    assert.equal(manualQueueDrain.status, 200);
    assert.equal((await manualQueueDrain.json()).started, 0);
    assert.equal(adapter.calls, 0);

    const staleResume = await fetch(`${url}/internal/v1/executor/drain/resume`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ generation: draining.generation, token: '00000000-0000-4000-8000-000000000000' }),
    });
    assert.equal(staleResume.status, 409);
    const stillDraining = await fetch(`${url}/internal/v1/executor/drain`, { headers: auth });
    assert.equal((await stillDraining.json()).mode, 'draining');

    const resumed = await fetch(`${url}/internal/v1/executor/drain/resume`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ generation: draining.generation, token: draining.token }),
    });
    assert.equal(resumed.status, 200);
    const resumedStatus = await resumed.json();
    assert.equal(resumedStatus.mode, 'accepting');
    assert.equal(resumedStatus.generation, draining.generation);
    assert.equal(resumedStatus.token, null);
    await waitForTask(executor, queued.taskId, task => task.status === 'completed');
    assert.equal(adapter.calls, 1);

    const nextDrainResponse = await fetch(`${url}/internal/v1/executor/drain`, {
      method: 'POST', headers: auth, body: JSON.stringify({}),
    });
    const nextDrain = await nextDrainResponse.json();
    assert.equal(nextDrain.generation, draining.generation + 1);
    const oldGenerationResume = await fetch(`${url}/internal/v1/executor/drain/resume`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ generation: draining.generation, token: draining.token }),
    });
    assert.equal(oldGenerationResume.status, 409);
    const currentGenerationStatus = await fetch(`${url}/internal/v1/executor/drain`, { headers: auth });
    assert.equal((await currentGenerationStatus.json()).generation, nextDrain.generation);
  } finally {
    await close();
    await disposeApp(app);
  }
});

test('NavigatorExecutor: drain rejects old limiter waiters, keeps admissions queued, then resumes them once', async () => {
  const adapter = new TestMockAdapter({ delayMs: 120 });
  const app = await createTestApp(adapter);
  const { executor } = app;
  try {
    const firstExecution = executor.executeTask({
      taskId: 'drain-running-task', sessionId: 'drain-running-session', prompt: 'Finish current work',
    });
    await waitForTask(executor, 'drain-running-task', task => task.status === 'running');

    const waitingExecution = executor.executeTask({
      taskId: 'drain-limiter-waiter', sessionId: 'drain-waiter-session', prompt: 'Keep queued during drain',
    });
    const sessionTailExecution = executor.executeTask({
      taskId: 'drain-session-tail', sessionId: 'drain-running-session', prompt: 'Keep session successor queued',
    });
    const waitDeadline = performance.now() + 1_000;
    while (executor.taskLimiter.snapshot().waiting !== 1 && performance.now() < waitDeadline) await delay(5);
    assert.equal(executor.taskLimiter.snapshot().waiting, 1, 'the second foreground dispatch must be waiting for the existing limiter slot');

    const entered = executor.startDrain();
    const initial = await executor.getDrainStatus();
    const drainToken = entered.token;
    const drainGeneration = entered.generation;
    assert.equal(initial.activeTasks, 1);
    assert.equal(initial.dispatches.active, 1);
    assert.equal(initial.dispatches.waiting, 0, 'entering drain must release the unclaimed limiter waiter');
    assert.equal(initial.activeWorkDrained, false);
    const boundedWait = await executor.waitForIdle(0);
    assert.equal(boundedWait.activeWorkDrained, false);
    assert.equal(boundedWait.activeTasks, 1);

    const queuedTask = await executor.startTask({ prompt: 'Stay durable while draining' });
    assert.equal(queuedTask.status, 'queued');

    const manualDispatch = await executor.dispatchTask(queuedTask.id);
    assert.equal(manualDispatch.status, 'queued');
    assert.equal(await executor.drainQueuedTasks(), 0);

    const [runningOutcome, waiterOutcome, sessionTailOutcome] = await Promise.all([
      firstExecution, waitingExecution, sessionTailExecution,
    ]);
    assert.equal(runningOutcome.status, 'completed');
    assert.equal(waiterOutcome.status, 'queued');
    assert.equal(sessionTailOutcome.status, 'queued');
    assert.equal(adapter.calls, 1, 'no previously waiting task may claim after drain begins');

    const drained = await executor.waitForIdle(1_000);
    assert.equal(drained.activeWorkDrained, true);
    assert.equal(drained.activeTasks, 0);
    assert.equal(drained.queuedTasks, 3, 'queued work remains durable while active work is drained');
    assert.equal(drained.notifications.pollingPaused, true);

    executor.resumeFromDrain(drainGeneration, drainToken);
    await waitForTask(executor, 'drain-limiter-waiter', task => task.status === 'completed');
    await waitForTask(executor, 'drain-session-tail', task => task.status === 'completed');
    await waitForTask(executor, queuedTask.id, task => task.status === 'completed');
    assert.equal(adapter.calls, 4, 'each durable queued task must be claimed once after resume');
  } finally {
    await disposeApp(app);
  }
});

test('NavigatorExecutor: drain waits for an existing notification claim and pauses later polling', async () => {
  const app = await createTestApp();
  const { executor } = app;
  executor.config.teams = { connectorId: 'notification-drain-fixture' };
  let claimCount = 0;
  let releaseClaim;
  const claimGate = new Promise(resolve => { releaseClaim = resolve; });
  executor.config.workState.claimNotifications = async () => {
    claimCount += 1;
    if (claimCount === 1) await claimGate;
    return [];
  };
  try {
    const claim = executor.drainTeamsNotifications();
    assert.equal(claimCount, 1);
    executor.startDrain();

    const duringClaim = await executor.getDrainStatus();
    assert.equal(duringClaim.notifications.configured, true);
    assert.equal(duringClaim.notifications.pollingPaused, true);
    assert.equal(duringClaim.notifications.inFlight, true);
    assert.equal(duringClaim.activeWorkDrained, false);

    const deadline = await executor.waitForIdle(0);
    assert.equal(deadline.activeWorkDrained, false);
    assert.equal(deadline.notifications.inFlight, true);

    releaseClaim();
    await claim;
    const drained = await executor.waitForIdle(1_000);
    assert.equal(drained.activeWorkDrained, true);
    assert.equal(drained.notifications.inFlight, false);
    await executor.drainTeamsNotifications();
    assert.equal(claimCount, 1, 'drain must prevent a later outbox claim');
  } finally {
    releaseClaim();
    await disposeApp(app);
  }
});

test('NavigatorExecutor: drain lets an active credential snapshot finish but starts no later outbox claim', async () => {
  const store = new InMemoryWorkStateStore();
  const app = await createTestApp(new TestMockAdapter(), { workStateStore: store });
  const { executor } = app;
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  let releaseSnapshot;
  const snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
  let claimCount = 0;
  executor.config.workState.claimNotifications = async () => {
    claimCount += 1;
    return [];
  };
  executor.config.teams = {
    connectorId: 'teams-v1',
    tenantId,
    allowedTeamIds: ['team-1'],
    botAppId: 'fixture-bot-app',
    taskActorSubjects: [],
    ingressSecretEnv: 'TEAMS_NAVIGATOR_HMAC_KEY',
    exchangeConnectionRef: 'chat-connection',
    exchangeProfileRef: 'chat-profile',
    credentialNotifications: {
      organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workspaceId: 'drain-health-workspace',
      owner: {
        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        subject: '11111111-1111-4111-8111-111111111111',
        tenantId,
      },
      connections: [{ connectionId: '22222222-2222-4222-8222-222222222222', provider: 'hf' }],
      destination: {
        tenantId,
        teamId: 'team-1',
        channelId: '19:notice-channel@thread.tacv2',
        conversationId: '19:notice-channel@thread.tacv2;messageid=1793027795187',
        rootThreadId: '1793027795187',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
      },
      exchangeConnectionRef: 'notice-connection',
      exchangeProfileRef: 'notice-profile',
      pollIntervalMs: 900_000,
    },
    exchangeAuthorization: {
      async getAuthorizationHealthSnapshots() {
        signalStarted();
        return snapshotGate;
      },
    },
  };
  try {
    const poll = executor['drainTeamsNotifications']();
    await started;
    executor.startDrain();
    const duringPoll = await executor.getDrainStatus();
    assert.equal(duringPoll.notifications.inFlight, true);
    assert.equal(duringPoll.notifications.pollingPaused, true);
    releaseSnapshot([]);
    await poll;
    const drained = await executor.waitForIdle(1_000);
    assert.equal(drained.activeWorkDrained, true);
    assert.equal(claimCount, 0, 'a drain that starts during a poll must not begin an outbox claim afterward');
  } finally {
    releaseSnapshot([]);
    await disposeApp(app);
  }
});

test('NavigatorExecutor: Teams outbox delivers completed multiline answers byte-for-byte and rejects NUL before send', async () => {
  const store = new InMemoryWorkStateStore();
  const app = await createTestApp(new TestMockAdapter(), {
    workStateStore: store,
    workspaceId: 'fixture-workspace',
  });
  const { executor } = app;
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const subject = '11111111-1111-4111-8111-111111111111';
  const caller = {
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`, subject, tenantId,
  };
  const taskId = 'teams-outbox-multiline-answer';
  const queuedLeases = [];
  const started = [];
  const finished = [];
  const sentMessages = [];
  const grantedTexts = [];
  const makeLease = (id, text) => ({
    notification: {
      id,
      deduplicationKey: `dedupe-${id}`,
      type: 'teams.message',
      payload: {
        tenantId,
        teamId: 'team-1',
        channelId: 'channel-1',
        conversationId: '19:channel-conversation',
        rootThreadId: '1698765432100',
        serviceUrl: 'https://smba.trafficmanager.net/emea/',
        text,
      },
      taskId,
      connectorId: 'teams-v1',
      status: 'leased',
      result: { retryCount: 0 },
    },
    leaseToken: `lease-${id}`,
  });
  const originalPatchTask = store.patchTask.bind(store);
  store.patchTask = async (id, patchValue) => {
    const record = await originalPatchTask(id, patchValue);
    if (id === taskId && patchValue.status === 'completed') {
      queuedLeases.push(makeLease('multiline-delivery', record.output));
      queuedLeases.push(makeLease('nul-delivery', `${record.output}\u0000must-not-send`));
    }
    return record;
  };
  store.claimNotifications = async input => {
    assert.equal(input.type, 'teams.message');
    assert.equal(input.connectorId, 'teams-v1');
    return queuedLeases.splice(0);
  };
  store.startNotification = async (notificationId, leaseToken) => {
    started.push({ notificationId, leaseToken });
  };
  store.finishNotification = async (notificationId, leaseToken, outcomeValue, result) => {
    finished.push({ notificationId, leaseToken, outcome: outcomeValue, result });
  };
  executor.config.teams = {
    connectorId: 'teams-v1',
    tenantId,
    allowedTeamIds: ['team-1'],
    botAppId: 'fixture-bot-app',
    taskActorSubjects: [subject],
    ingressSecretEnv: 'TEAMS_NAVIGATOR_HMAC_KEY',
    exchangeConnectionRef: 'teams-connection-ref',
    exchangeProfileRef: 'teams-profile-ref',
    exchangeAuthorization: {
      async mintGrant(request) {
        grantedTexts.push(request.arguments.text);
        return { token: 'fixture-grant' };
      },
      async sendTeamsMessage(message) {
        sentMessages.push(message);
        return { outcome: 'accepted', vendorMessageId: 'teams-message-1' };
      },
    },
  };

  try {
    const answer = await executor.executeTask({
      taskId,
      sessionId: 'teams-outbox-session',
      prompt: 'First paragraph.\n\nSecond paragraph.\tTabbed.\r\nFourth line.',
      metadata: { teamsCaller: caller },
    });
    assert.equal(answer.status, 'completed');
    assert.ok(answer.output.includes('\n\n'));
    assert.ok(answer.output.includes('\t'));
    assert.ok(answer.output.includes('\r\n'));
    assert.equal((await store.getTask(taskId)).status, 'completed');
    assert.equal(queuedLeases.length, 2, 'terminal completion should feed the durable outbox fixture');

    await executor.drainTeamsNotifications();

    assert.equal(sentMessages.length, 1, 'the NUL-containing notification must fail before provider invocation');
    assert.deepEqual(Buffer.from(sentMessages[0].text, 'utf8'), Buffer.from(answer.output, 'utf8'));
    assert.deepEqual(grantedTexts, [answer.output]);
    assert.deepEqual(started.map(item => item.notificationId), ['multiline-delivery', 'nul-delivery']);
    assert.deepEqual(finished.map(item => [item.notificationId, item.outcome]), [
      ['multiline-delivery', 'delivered'],
      ['nul-delivery', 'failed'],
    ]);
  } finally {
    await disposeApp(app);
  }
});

test('NavigatorExecutor: actor Work clients claim and deliver only their channel replies after a live Directory check', async () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const directoryPath = join(await mkdtemp(join(tmpdir(), 'navigator-teams-directory-')), 'actors.json');
  await writeFile(directoryPath, JSON.stringify({
    schemaVersion: 1, workspaceId: 'actor-outbox-workspace', issuer, subjects: [ownerId, otherId],
  }));
  const globalStore = new InMemoryWorkStateStore();
  const ownerStore = new InMemoryWorkStateStore(ownerId);
  const otherStore = new InMemoryWorkStateStore(otherId);
  const actorStores = new Map([[ownerId, ownerStore], [otherId, otherStore]]);
  const ownerTask = {
    id: 'actor-outbox-task',
    sessionId: 'teams-owner-thread-session',
    prompt: 'send the completed answer',
    status: 'completed',
    executionClass: 'foreground',
    createdAt: Date.now(),
    output: 'completed answer',
    reasoning: '',
    durationMs: 1,
    createdByActorId: ownerId,
    metadata: { teamsCaller: { issuer, subject: ownerId, actorAadObjectId: ownerId, tenantId } },
  };
  const route = {
    tenantId, teamId: 'team-1', channelId: 'channel-1', conversationId: '19:channel-conversation',
    rootThreadId: '1698765432100', serviceUrl: 'https://smba.trafficmanager.net/emea/',
  };
  const makeLease = id => ({
    notification: {
      id, deduplicationKey: `actor-dedupe-${id}`, type: 'teams.message', payload: { ...route, text: 'owner result' },
      taskId: ownerTask.id, connectorId: 'teams-v1', recipient: 'teams:owner-thread',
      status: 'leased', result: { retryCount: 0 },
    },
    leaseToken: `lease-${id}`,
  });
  const claims = [];
  const started = [];
  const finished = [];
  const pending = [makeLease('allowed'), makeLease('revoked')];
  ownerStore.claimNotifications = async input => {
    claims.push({ actor: ownerId, ...input });
    return pending.splice(0, 1);
  };
  ownerStore.getTask = async taskId => taskId === ownerTask.id ? ownerTask : undefined;
  ownerStore.startNotification = async (notificationId, leaseToken) => started.push({ actor: ownerId, notificationId, leaseToken });
  ownerStore.finishNotification = async (notificationId, leaseToken, outcome, result) => {
    finished.push({ actor: ownerId, notificationId, leaseToken, outcome, result });
  };
  otherStore.claimNotifications = async input => {
    claims.push({ actor: otherId, ...input });
    return [];
  };
  otherStore.getTask = async () => undefined;
  let globalClaims = 0;
  globalStore.claimNotifications = async () => { globalClaims += 1; return []; };
  const grants = [];
  const sends = [];
  const teams = {
    connectorId: 'teams-v1', tenantId, allowedTeamIds: ['team-1'], botAppId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    taskActorSubjects: [ownerId, otherId], taskActorSubjectsFile: directoryPath,
    ingressSecretEnv: 'TEAMS_NAVIGATOR_HMAC_KEY', exchangeConnectionRef: 'teams-connection',
    exchangeProfileRef: 'teams-profile',
    exchangeAuthorization: {
      async mintGrant(request) { grants.push(request); return { token: 'actor-grant' }; },
      async sendTeamsMessage(message) { sends.push(message); return { outcome: 'accepted' }; },
    },
  };
  const app = await createTestApp(new TestMockAdapter(), {
    workStateStore: globalStore, workspaceId: 'actor-outbox-workspace', teams,
  });
  app.executor.config.workActorClients = {
    actorIds: () => [ownerId, otherId],
    forActor: actorId => actorStores.get(actorId),
  };
  try {
    await app.executor['drainTeamsNotifications']();
    await writeFile(directoryPath, JSON.stringify({
      schemaVersion: 1, workspaceId: 'actor-outbox-workspace', issuer, subjects: [otherId],
    }));
    await app.executor['drainTeamsNotifications']();

    assert.equal(globalClaims, 0, 'actor-owned channel outbox rows never use the global Work client');
    assert.deepEqual(claims.map(row => row.actor), [ownerId, otherId, ownerId, otherId]);
    assert.equal(sends.length, 1, 'revoked Directory membership blocks the second send');
    assert.equal(grants.length, 1);
    assert.equal(grants[0].principalIssuer, issuer);
    assert.equal(grants[0].principalSubject, ownerId, 'the egress grant remains bound to the original Work task actor');
    assert.equal(grants[0].operationId, 'msteams.message.reply');
    assert.deepEqual(started.map(row => [row.actor, row.notificationId]), [
      [ownerId, 'allowed'], [ownerId, 'revoked'],
    ]);
    assert.deepEqual(finished.map(row => [row.actor, row.notificationId, row.outcome]), [
      [ownerId, 'allowed', 'delivered'], [ownerId, 'revoked', 'failed'],
    ]);

    const forgedMetadataTask = await app.executor.executeTask({
      taskId: 'forged-teams-metadata-task',
      sessionId: `teams-${otherId}`,
      prompt: 'A public task cannot select an actor Work principal.',
      metadata: { teamsCaller: { issuer, subject: otherId, actorAadObjectId: otherId, tenantId } },
    });
    assert.equal(forgedMetadataTask.status, 'completed');
    assert.equal(app.executor.actorForTask(forgedMetadataTask.taskId), undefined);
    assert.equal(app.executor.workTokenEnvForTask(forgedMetadataTask.taskId), undefined);
    assert.equal(app.executor.workTokenEnvForSession(`teams-${otherId}`), undefined,
      'a caller-supplied teamsCaller object cannot select private DSH persistence credentials');
  } finally {
    await disposeApp(app);
    await rm(directoryPath.slice(0, directoryPath.lastIndexOf('/')), { recursive: true, force: true });
  }
});

test('NavigatorExecutor boot wires the fixed owner-private Exchange sender and preserves actor/route certainty', {
  skip: process.platform === 'win32'
    ? 'Private actor Work credentials require POSIX UID/mode verification until Windows ACL verification is implemented.'
    : false,
}, async () => {
  const workspaceId = 'private-boot-workspace';
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const actorIds = [
    ownerId,
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
  ];
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const directory = await mkdtemp(join(tmpdir(), 'navigator-private-teams-boot-'));
  const actorMapPath = join(directory, 'actor-map.json');
  const directoryPath = join(directory, 'actor-subjects.json');
  const exchangeKeyPath = join(directory, 'exchange.key');
  const actorTokenEnvs = actorIds.map((_, index) => `PRIVATE_BOOT_ACTOR_${index}_TOKEN`);
  const ingressSecret = 'private-boot-ingress-hmac-key-0123456789abcdef';
  const environmentNames = [
    'CYRENE_WORK_ACTOR_TOKEN_MAP_FILE', 'CYRENE_SESSION_TOKEN', 'TEAMS_NAVIGATOR_HMAC_KEY', ...actorTokenEnvs,
  ];
  const priorEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]));
  const tokens = actorTokenEnvs.map((name, index) => `private-boot-work-token-${index}-0123456789abcdef`);
  const workRequests = [];
  let privateTaskId = 'private-owner-task';
  let privateTaskRecord = {
    id: privateTaskId,
    workspaceId,
    createdByActorId: ownerId,
    sessionId: 'private-owner-session',
    prompt: 'A previously completed private workflow task.',
    status: 'completed',
    executionClass: 'foreground',
    createdAt: Date.now(),
    startedAt: Date.now(),
    endedAt: Date.now(),
    output: 'Private workflow result for the installing owner.',
    reasoning: '',
    error: null,
    durationMs: 1,
    sequence: 1,
    metadata: {},
    origin: {
      kind: 'teams_private',
      messageId: 'previous-private-owner-message',
      tenantId,
      botAppId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      actorAadObjectId: ownerId,
    },
  };
  const workServer = createServer(async (req, res) => {
    const respond = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    workRequests.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body });
    if (req.method === 'GET' && req.url?.endsWith('/work/tool-providers')) {
      respond(200, { items: [] });
      return;
    }
    if (req.method === 'GET' && req.url?.includes('/work/tasks/owned')) {
      respond(200, { items: [], nextCursor: null });
      return;
    }
    if (req.method === 'GET' && privateTaskId !== undefined
      && req.url?.endsWith(`/work/tasks/${privateTaskId}`)) {
      respond(200, privateTaskRecord);
      return;
    }
    if (req.method === 'POST' && req.url?.endsWith('/work/connectors/teams-v1/events')) {
      const taskInput = body?.task;
      const privateMessage = body?.teamsPrivateMessage;
      if (taskInput === undefined || privateMessage === undefined) {
        respond(400, { code: 'WORK_CONNECTOR_INVALID_TEAMS_PRIVATE_MESSAGE' });
        return;
      }
      privateTaskId = taskInput.id;
      privateTaskRecord = {
        id: taskInput.id,
        workspaceId,
        createdByActorId: ownerId,
        sessionId: taskInput.sessionId,
        prompt: taskInput.prompt,
        status: 'completed',
        executionClass: 'foreground',
        createdAt: Date.now(),
        startedAt: Date.now(),
        endedAt: Date.now(),
        output: 'Private workflow result for the installing owner.',
        reasoning: '',
        error: null,
        durationMs: 1,
        sequence: 1,
        metadata: {},
        origin: {
          kind: 'teams_private',
          messageId: privateMessage.messageId,
          tenantId,
          botAppId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          actorAadObjectId: ownerId,
        },
      };
      respond(200, {
        eventId: 'private-event-fixture', duplicate: false, receivedAt: Date.now(), task: privateTaskRecord,
      });
      return;
    }
    if (req.method === 'POST' && req.url?.endsWith('/work/notifications/claim')) {
      respond(200, { items: [] });
      return;
    }
    respond(404, { code: 'WORK_TASK_NOT_FOUND' });
  });
  await new Promise(resolve => workServer.listen(0, '127.0.0.1', resolve));

  await writeFile(exchangeKeyPath, Buffer.alloc(32, 0x4a), { mode: 0o600 });
  await writeFile(actorMapPath, JSON.stringify({
    schemaVersion: 1,
    workspaceId,
    actors: actorIds.map((actorAadObjectId, index) => ({ actorAadObjectId, tokenEnv: actorTokenEnvs[index] })),
  }), { mode: 0o600 });
  await writeFile(directoryPath, JSON.stringify({ schemaVersion: 1, workspaceId, issuer, subjects: actorIds }), { mode: 0o600 });
  process.env.CYRENE_WORK_ACTOR_TOKEN_MAP_FILE = actorMapPath;
  process.env.CYRENE_SESSION_TOKEN = 'private-boot-global-session-token';
  process.env.TEAMS_NAVIGATOR_HMAC_KEY = ingressSecret;
  actorTokenEnvs.forEach((name, index) => { process.env[name] = tokens[index]; });

  const grantRequests = [];
  const privateBodies = [];
  const outcomes = ['accepted', 'uncertain'];
  const exchangeServer = createServer(async (req, res) => {
    const respond = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.url === '/internal/v1/connector-operation-grants') {
      grantRequests.push(body);
      const { arguments: _arguments, ...claimsWithoutArguments } = body;
      const now = Math.floor(Date.now() / 1_000);
      respond(200, {
        connectorGrantBin: 'AQ==', grantRef: `private-grant-${grantRequests.length}`, audience: 'exchange',
        issuedAt: now, expiresAt: now + 10, claims: { ...claimsWithoutArguments, organizationId: 'private-org' },
      });
      return;
    }
    if (req.url === '/internal/v1/teams/messages') {
      privateBodies.push({ body, grant: req.headers['x-cyrene-connector-grant-bin'] });
      const status = outcomes.shift() ?? 'accepted';
      respond(200, {
        requestId: body.requestId,
        status,
        ...(status === 'accepted' ? { vendorMessageId: 'private-delivery-1' } : { reasonCode: 'teams_delivery_outcome_unknown' }),
      });
      return;
    }
    respond(404, { code: 'EXCHANGE_ROUTE_NOT_FOUND' });
  });
  await new Promise(resolve => exchangeServer.listen(0, '127.0.0.1', resolve));

  const leaseFor = (id, actorAadObjectId = ownerId) => ({
    notification: {
      id, deduplicationKey: `private-dedupe-${id}`, type: 'teams.message',
      payload: { text: 'Private workflow update.' }, taskId: 'private-owner-task',
      connectorId: 'teams-v1', recipient: 'teams:owner-private', status: 'leased', result: { retryCount: 0 },
    },
    leaseToken: `private-lease-${id}`,
    teamsPersonalRoute: {
        kind: 'teams_personal', tenantId, botAppId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        actorAadObjectId, conversationId: '19:private-owner-conversation',
        serviceUrl: 'https://smba.trafficmanager.net/emea/',
    },
  });
  const privateLeases = [
    leaseFor('accepted'), leaseFor('revoked'), leaseFor('uncertain'), leaseFor('actor-mismatch', actorIds[1]),
  ];
  const privateFinished = [];
  const workStateStore = new InMemoryWorkStateStore();
  let privateClaimCalls = 0;
  workStateStore.claimPrivateNotifications = async () => {
    privateClaimCalls += 1;
    return privateLeases.splice(0, 1);
  };
  workStateStore.startPrivateNotification = async () => {};
  workStateStore.finishPrivateNotification = async (id, _token, outcome, result) => {
    privateFinished.push({ id, outcome, result });
  };

  const exchangeAuthorization = new ExchangeConnectorAuthorizationClient({
    baseUrl: `http://127.0.0.1:${exchangeServer.address().port}`,
    hmacKeyFile: exchangeKeyPath,
    hmacKeyId: 'private-boot-test',
    audience: 'exchange',
  });
  const teams = {
    connectorId: 'teams-v1', tenantId, allowedTeamIds: ['team-1'],
    botAppId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    taskActorSubjects: [], taskActorSubjectsFile: directoryPath, personalChatEnabled: true,
    ingressSecretEnv: 'TEAMS_NAVIGATOR_HMAC_KEY', exchangeConnectionRef: '66666666-6666-4666-8666-666666666666',
    exchangeProfileRef: 'teams-private-boot-profile', exchangeAuthorization,
  };
  let app;
  try {
    app = await createTestApp(new TestMockAdapter(), {
      workStateStore,
      workspaceId,
      persistenceUrl: `http://127.0.0.1:${workServer.address().port}`,
      teams,
    });
    assert.equal(typeof app.executor.config.teams.sendPrivateMessage, 'function',
      'stock app boot constructs the private sender when personal mode and Exchange client are configured');
    await app.executor['drainTeamsNotifications']();

    await writeFile(directoryPath, JSON.stringify({ schemaVersion: 1, workspaceId, issuer, subjects: actorIds.slice(1) }));
    await app.executor['drainTeamsNotifications']();

    await writeFile(directoryPath, JSON.stringify({ schemaVersion: 1, workspaceId, issuer, subjects: actorIds }));
    await app.executor['drainTeamsNotifications']();
    await app.executor['drainTeamsNotifications']();

    assert.equal(grantRequests.length, 2, 'revoked and task-owner-mismatched routes fail before grant creation');
    assert.equal(privateBodies.length, 2);
    const grant = grantRequests[0];
    const route = {
      tenantId,
      botAppId: teams.botAppId,
      actorAadObjectId: ownerId,
      conversationId: '19:private-owner-conversation',
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
    };
    const argumentsValue = { targetKind: 'owner_private', conversation: route, text: 'Private workflow update.' };
    assert.equal(grant.principalSubject, ownerId, 'fresh Exchange grant uses the original Work Task actor');
    assert.equal(grant.principalIssuer, issuer);
    assert.equal(grant.connectionRef, teams.exchangeConnectionRef);
    assert.equal(grant.profileRef, teams.exchangeProfileRef);
    assert.equal(grant.providerId, 'msteams');
    assert.equal(grant.operationId, 'msteams.message.reply');
    assert.equal(grant.resourceRef, `msteams-personal:${createHash('sha256').update(canonicalJson(route)).digest('hex')}`);
    assert.deepEqual(grant.arguments, argumentsValue);
    assert.deepEqual(privateBodies[0].body, {
      requestId: 'accepted:attempt:1',
      providerId: 'msteams',
      targetKind: 'owner_private',
      conversation: route,
      text: 'Private workflow update.',
    });
    assert.ok(privateBodies.every(item => item.grant === 'AQ=='));
    assert.deepEqual(privateFinished.map(item => [item.id, item.outcome]), [
      ['accepted', 'delivered'],
      ['revoked', 'failed'],
      ['uncertain', 'uncertain'],
      ['actor-mismatch', 'failed'],
    ]);
    assert.ok(workRequests.some(item => item.url?.endsWith('/work/tasks/private-owner-task')
      && item.authorization === `Bearer ${tokens[0]}`));
    assert.ok(workRequests.some(item => item.url?.endsWith('/work/tasks/private-owner-task')
      && item.authorization === `Bearer ${tokens[1]}`), 'mismatched route is checked through the claimed actor client');

    app.executor.config.teams.sendPrivateMessage = undefined;
    await app.executor['drainTeamsNotifications']();
    assert.equal(privateClaimCalls, 4, 'private notices are not claimed if the fixed Exchange sender becomes unavailable');
  } finally {
    if (app !== undefined) await disposeApp(app);
    exchangeServer.closeAllConnections();
    await new Promise(resolve => exchangeServer.close(resolve));
    workServer.closeAllConnections();
    await new Promise(resolve => workServer.close(resolve));
    await rm(directory, { recursive: true, force: true });
    for (const [name, value] of priorEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('NavigatorExecutor: a slow channel claim cannot delay a queued private acknowledgement', async () => {
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const actorStore = new InMemoryWorkStateStore(ownerId);
  const ownerTask = await actorStore.createTask({
    id: 'teams-private-priority-task', sessionId: 'teams-private-priority-session', prompt: 'Private task.',
  });
  let releaseChannelClaim;
  const channelClaimGate = new Promise(resolve => { releaseChannelClaim = resolve; });
  let signalChannelClaimStarted;
  const channelClaimStartedPromise = new Promise(resolve => { signalChannelClaimStarted = resolve; });
  let channelClaimStarted = false;
  actorStore.claimNotifications = async () => {
    channelClaimStarted = true;
    signalChannelClaimStarted();
    await channelClaimGate;
    return [];
  };
  const workState = new InMemoryWorkStateStore();
  const privateLease = {
    notification: {
      id: 'private-priority-ack', deduplicationKey: 'private-priority-ack', type: 'teams.message',
      payload: { text: 'Request received. I’m working on it.' }, taskId: ownerTask.id,
      connectorId: 'teams-v1', recipient: 'teams:owner-private', status: 'leased', result: { retryCount: 0 },
    },
    leaseToken: 'private-priority-lease',
    teamsPersonalRoute: {
      kind: 'teams_personal', tenantId, botAppId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      actorAadObjectId: ownerId, conversationId: '19:private-priority-route',
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
    },
  };
  workState.claimPrivateNotifications = async () => [privateLease];
  const workActorClients = {
    actorIds: () => [ownerId],
    forActor: actorId => actorId === ownerId ? actorStore : undefined,
  };
  const app = await createTestApp(new TestMockAdapter(), {
    workStateStore: workState,
    workspaceId: 'private-priority-workspace',
    teams: {
      connectorId: 'teams-v1', tenantId, allowedTeamIds: ['team-1'],
      botAppId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', taskActorSubjects: [ownerId],
      ingressSecretEnv: 'TEAMS_NAVIGATOR_HMAC_KEY', exchangeConnectionRef: '66666666-6666-4666-8666-666666666666',
      exchangeProfileRef: 'teams-priority-profile', exchangeAuthorization: {},
    },
  });
  const sent = [];
  let privateSendResolve;
  const privateSendCompleted = new Promise(resolve => { privateSendResolve = resolve; });
  app.executor.config.workActorClients = workActorClients;
  app.executor.config.teams.personalChatEnabled = true;
  app.executor.config.teams.sendPrivateMessage = async request => {
    sent.push(request);
    privateSendResolve();
    return { outcome: 'accepted' };
  };
  try {
    const draining = app.executor['drainTeamsNotifications']();
    const sentBeforeChannelGate = await Promise.race([
      privateSendCompleted.then(() => true),
      delay(1_000).then(() => false),
    ]);
    assert.equal(sentBeforeChannelGate, true, 'owner-private acknowledgement sends before a blocked channel lease');
    const channelClaimStartedBeforeTimeout = await Promise.race([
      channelClaimStartedPromise.then(() => true),
      delay(1_000).then(() => false),
    ]);
    assert.equal(channelClaimStartedBeforeTimeout && channelClaimStarted, true,
      'channel polling may proceed after private delivery starts');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].target_kind, 'owner_private');
    assert.equal(sent[0].actor_aad_object_id, ownerId);
    releaseChannelClaim();
    await draining;
  } finally {
    releaseChannelClaim();
    await disposeApp(app);
  }
});

test('NavigatorExecutor: only a known-safe private 429 is retried with a bounded delay', async () => {
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const botAppId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const actorStore = new InMemoryWorkStateStore(ownerId);
  await actorStore.createTask({
    id: 'private-rate-limit-task', sessionId: 'private-rate-limit-session', prompt: 'Private notice source.',
  });
  const workState = new InMemoryWorkStateStore();
  const route = {
    kind: 'teams_personal', tenantId, botAppId, actorAadObjectId: ownerId,
    conversationId: '19:private-rate-limit-route', serviceUrl: 'https://smba.trafficmanager.net/emea/',
  };
  const leases = ['safe-429', 'unknown-429'].map(id => ({
    notification: {
      id, deduplicationKey: `private-rate-limit-${id}`, type: 'teams.message',
      payload: { text: 'Private retry test.' }, taskId: 'private-rate-limit-task',
      connectorId: 'teams-v1', recipient: 'teams:owner-private', status: 'leased', result: { retryCount: 0 },
    },
    leaseToken: `lease-${id}`,
    teamsPersonalRoute: route,
  }));
  const finished = [];
  workState.claimPrivateNotifications = async () => leases.splice(0, leases.length);
  workState.startPrivateNotification = async () => {};
  workState.finishPrivateNotification = async (id, leaseToken, outcome, result, retryAfterSeconds) => {
    finished.push({ id, leaseToken, outcome, result, retryAfterSeconds });
  };
  const app = await createTestApp(new TestMockAdapter(), {
    workStateStore: workState,
    workspaceId: 'private-rate-limit-workspace',
    teams: {
      connectorId: 'teams-v1', tenantId, allowedTeamIds: ['team-1'], botAppId,
      taskActorSubjects: [ownerId], ingressSecretEnv: 'TEAMS_NAVIGATOR_HMAC_KEY',
      exchangeConnectionRef: 'private-rate-limit-connection',
      exchangeProfileRef: 'private-rate-limit-profile', exchangeAuthorization: {},
    },
  });
  app.executor.config.workActorClients = {
    actorIds: () => [ownerId],
    forActor: actorId => actorId === ownerId ? actorStore : undefined,
  };
  app.executor.config.teams.personalChatEnabled = true;
  const failures = [
    new ExchangeConnectorRequestError('Confirmed not sent.', 429, false, undefined, 900),
    new ExchangeConnectorRequestError('Send outcome unknown.', 429, true, undefined, 42),
  ];
  app.executor.config.teams.sendPrivateMessage = async () => {
    const failure = failures.shift();
    if (failure === undefined) throw new Error('Unexpected private sender call');
    throw failure;
  };
  try {
    await app.executor['drainTeamsNotifications']();
    assert.deepEqual(finished.map(item => [item.id, item.outcome, item.retryAfterSeconds]), [
      ['safe-429', 'retry', 300],
      ['unknown-429', 'uncertain', undefined],
    ]);
    assert.deepEqual(finished.map(item => item.result.code), ['EXCHANGE_HTTP_429', 'EXCHANGE_HTTP_429']);
  } finally {
    await disposeApp(app);
  }
});

test('NavigatorExecutor: credential notices use cached Exchange health and the fixed taskless Teams route', async () => {
  const store = new InMemoryWorkStateStore();
  const adapter = new TestMockAdapter();
  const app = await createTestApp(adapter, { workStateStore: store, workspaceId: 'health-workspace' });
  const { executor } = app;
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerSubject = '11111111-1111-4111-8111-111111111111';
  const destination = {
    tenantId,
    teamId: 'team-1',
    channelId: '19:notice-channel@thread.tacv2',
    conversationId: '19:notice-channel@thread.tacv2;messageid=1793027795187',
    rootThreadId: '1793027795187',
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
  };
  const snapshot = {
    connectionId: '22222222-2222-4222-8222-222222222222',
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
  };
  const owner = {
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    subject: ownerSubject,
    tenantId,
  };
  const credentialConfig = {
    organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workspaceId: 'health-workspace',
    owner,
    connections: [{ connectionId: snapshot.connectionId, provider: 'hf' }],
    destination,
    exchangeProfileRef: 'teams-credential-notifications-20261026',
    pollIntervalMs: 900_000,
  };
  const noticeLease = {
    notification: {
      id: 'credential-notice-1',
      deduplicationKey: 'credential-health:incident:opened',
      type: 'teams.credential-health',
      payload: {
        schemaVersion: 1,
        event: 'action_required',
        incidentId: '0123456789abcdef0123456789abcdef',
        connectionId: snapshot.connectionId,
        provider: 'hf',
        generation: snapshot.generation,
        loginState: snapshot.loginState,
        authorizationState: snapshot.authorizationState,
        capabilities: [{ capabilityId: 'model.read', state: 'REAUTHORIZATION_REQUIRED' }],
        checkedAt: snapshot.checkedAt,
        expiresAt: snapshot.expiresAt,
        reasonCode: snapshot.reasonCode,
      },
      connectorId: 'teams-v1',
      recipient: 'teams:credential-health',
      status: 'leased',
      result: { retryCount: 0 },
    },
    leaseToken: 'credential-lease-1',
  };
  const claims = [];
  const started = [];
  const finished = [];
  const snapshotRequests = [];
  const grantRequests = [];
  const sentMessages = [];
  let noticePending = true;
  store.claimNotifications = async input => {
    claims.push(input);
    if (input.type === 'teams.credential-health' && noticePending) {
      noticePending = false;
      return [noticeLease];
    }
    return [];
  };
  store.processCredentialHealthSnapshots = async (organizationId, snapshots) => {
    assert.equal(organizationId, credentialConfig.organizationId);
    return { processed: snapshots.length, stale: 0, notificationsQueued: 0 };
  };
  store.startNotification = async (notificationId, leaseToken) => started.push({ notificationId, leaseToken });
  store.finishNotification = async (notificationId, leaseToken, outcome, result) => {
    finished.push({ notificationId, leaseToken, outcome, result });
  };
  executor.config.teams = {
    connectorId: 'teams-v1',
    tenantId,
    allowedTeamIds: ['team-1'],
    botAppId: 'fixture-bot-app',
    taskActorSubjects: [ownerSubject],
    ingressSecretEnv: 'TEAMS_NAVIGATOR_HMAC_KEY',
    exchangeConnectionRef: 'teams-chat-connection',
    exchangeProfileRef: 'teams-chat-profile',
    credentialNotifications: credentialConfig,
    exchangeAuthorization: {
      async getAuthorizationHealthSnapshots(input) {
        snapshotRequests.push(input);
        return [snapshot];
      },
      async mintGrant(request) {
        grantRequests.push(request);
        return { connectorGrantBin: 'fixture-grant', organizationId: credentialConfig.organizationId };
      },
      async sendTeamsMessage(message) {
        sentMessages.push(message);
        return { outcome: 'accepted', vendorMessageId: 'credential-notice-sent' };
      },
    },
  };

  try {
    await executor['drainTeamsNotifications']();
    await executor['drainTeamsNotifications']();
    assert.equal(adapter.calls, 0, 'credential monitoring must not create a model task');
    assert.equal(snapshotRequests.length, 1, 'cached Exchange state is read on a bounded interval');
    assert.deepEqual(snapshotRequests[0], {
      requestId: snapshotRequests[0].requestId,
      organizationId: credentialConfig.organizationId,
      workspaceId: credentialConfig.workspaceId,
      connectionIds: [snapshot.connectionId],
    });
    assert.deepEqual(claims.map(item => [item.type, item.recipient ?? null]), [
      ['teams.message', null],
      ['teams.credential-health', 'teams:credential-health'],
      ['teams.message', null],
      ['teams.credential-health', 'teams:credential-health'],
    ]);
    assert.deepEqual(started, [{ notificationId: 'credential-notice-1', leaseToken: 'credential-lease-1' }]);
    assert.equal(grantRequests.length, 1);
    assert.equal(grantRequests[0].principalIssuer, owner.issuer);
    assert.equal(grantRequests[0].principalSubject, owner.subject);
    assert.equal(grantRequests[0].connectionRef, 'teams-chat-connection');
    assert.equal(grantRequests[0].profileRef, credentialConfig.exchangeProfileRef);
    assert.equal(grantRequests[0].operationId, 'msteams.message.reply');
    assert.deepEqual(grantRequests[0].arguments.conversation, destination);
    assert.equal(sentMessages[0].conversation, destination);
    assert.match(sentMessages[0].text, /Hugging Face/u);
    assert.match(sentMessages[0].text, /TOKEN_EXPIRED/u);
    assert.doesNotMatch(sentMessages[0].text, /bearer|token value|authorizationRef/iu);
    assert.deepEqual(finished.map(item => [item.notificationId, item.outcome]), [
      ['credential-notice-1', 'delivered'],
    ]);
  } finally {
    await disposeApp(app);
  }
});

test('NavigatorExecutor: credential grant rate limits retry before any Teams provider send', async () => {
  const store = new InMemoryWorkStateStore();
  const app = await createTestApp(new TestMockAdapter(), { workStateStore: store, workspaceId: 'health-workspace' });
  const { executor } = app;
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const lease = {
    notification: {
      id: 'credential-grant-rate-limit',
      deduplicationKey: 'credential-health:incident:opened',
      type: 'teams.credential-health',
      payload: {
        schemaVersion: 1,
        event: 'action_required',
        incidentId: '0123456789abcdef0123456789abcdef',
        connectionId: '22222222-2222-4222-8222-222222222222',
        provider: 'hf',
        generation: 1,
        loginState: 'PRESENT',
        authorizationState: 'REAUTHORIZATION_REQUIRED',
        capabilities: [],
        checkedAt: '2026-10-26T15:00:00Z',
        expiresAt: null,
        reasonCode: 'TOKEN_EXPIRED',
      },
      connectorId: 'teams-v1',
      recipient: 'teams:credential-health',
      status: 'leased',
      result: { retryCount: 0 },
    },
    leaseToken: 'credential-grant-rate-limit-lease',
  };
  const route = {
    tenantId,
    teamId: 'team-1',
    channelId: '19:notice-channel@thread.tacv2',
    conversationId: '19:notice-channel@thread.tacv2;messageid=1793027795187',
    rootThreadId: '1793027795187',
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
  };
  const finishReceipts = [];
  let providerCalls = 0;
  let noticePending = true;
  store.claimNotifications = async input => {
    if (input.type === 'teams.credential-health' && noticePending) {
      noticePending = false;
      return [lease];
    }
    return [];
  };
  store.startNotification = async () => undefined;
  store.finishNotification = async (notificationId, leaseToken, outcome, result, retryAfterSeconds) => {
    finishReceipts.push({ notificationId, leaseToken, outcome, result, retryAfterSeconds });
  };
  executor.config.teams = {
    connectorId: 'teams-v1',
    tenantId,
    allowedTeamIds: ['team-1'],
    botAppId: 'fixture-bot-app',
    taskActorSubjects: [ownerId],
    ingressSecretEnv: 'TEAMS_NAVIGATOR_HMAC_KEY',
    exchangeConnectionRef: 'teams-chat-connection',
    exchangeProfileRef: 'teams-chat-profile',
    credentialNotifications: {
      organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workspaceId: 'health-workspace',
      owner: {
        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        subject: ownerId,
        tenantId,
      },
      connections: [{ connectionId: '22222222-2222-4222-8222-222222222222', provider: 'hf' }],
      destination: route,
      exchangeProfileRef: 'teams-credential-notifications-20261026',
      pollIntervalMs: 900_000,
    },
    exchangeAuthorization: {
      async getAuthorizationHealthSnapshots() { return []; },
      async mintGrant() {
        throw new ExchangeConnectorRequestError('Exchange grant rate limited', 429, false, undefined, 42);
      },
      async sendTeamsMessage() {
        providerCalls += 1;
        return { outcome: 'accepted' };
      },
    },
  };
  try {
    await executor['drainTeamsNotifications']();
    assert.equal(providerCalls, 0);
    assert.deepEqual(finishReceipts.map(receipt => [receipt.outcome, receipt.retryAfterSeconds]), [
      ['retry', 42],
    ]);
  } finally {
    await disposeApp(app);
  }
});

test('NavigatorExecutor: streamed duplicate requests report the existing task status during drain', async () => {
  const store = new InMemoryWorkStateStore();
  const adapter = new TestMockAdapter();
  const app = await createTestApp(adapter, { workStateStore: store });
  const { executor } = app;
  const { url, close } = await executor.startServer(0, '127.0.0.1');
  const headers = { Authorization: `Bearer ${TEST_BEARER}`, 'Content-Type': 'application/json' };
  try {
    const running = await store.createTask({
      id: 'stream-drain-existing-running', sessionId: 'stream-drain-running-session', prompt: 'Existing running work',
    });
    await store.claimTask(running.id);
    executor.startDrain();

    const runningResponse = await fetch(`${url}/api/v1/execute`, {
      method: 'POST', headers,
      body: JSON.stringify({
        taskId: running.id, sessionId: running.sessionId, prompt: running.prompt, stream: true,
      }),
    });
    assert.equal(runningResponse.status, 200);
    const runningStreamPromise = runningResponse.text();
    const returnedEarly = await Promise.race([
      runningStreamPromise.then(() => true),
      delay(30).then(() => false),
    ]);
    assert.equal(returnedEarly, false, 'an existing running task stream must remain open until the task settles');
    await store.patchTask(running.id, { status: 'completed', output: 'The existing task completed.' });
    await store.appendEvent(running.id, {
      type: 'finish', taskId: running.id, status: 'completed',
      output: 'The existing task completed.', durationMs: 10, timestamp: Date.now(),
    });
    const runningStream = await runningStreamPromise;
    assert.match(runningStream, /"status":"completed"/u);
    assert.doesNotMatch(runningStream, /"status":"queued"/u);

    const completed = await store.createTask({
      id: 'stream-drain-existing-completed', sessionId: 'stream-drain-completed-session', prompt: 'Existing completed work',
    });
    await store.claimTask(completed.id);
    await store.patchTask(completed.id, { status: 'completed', output: 'Previously completed.' });
    await store.appendEvent(completed.id, {
      type: 'finish', taskId: completed.id, status: 'completed',
      output: 'Previously completed.', durationMs: 5, timestamp: Date.now(),
    });
    const completedResponse = await fetch(`${url}/api/v1/execute`, {
      method: 'POST', headers,
      body: JSON.stringify({
        taskId: completed.id, sessionId: completed.sessionId, prompt: completed.prompt, stream: true,
      }),
    });
    assert.equal(completedResponse.status, 200);
    const completedStream = await completedResponse.text();
    assert.match(completedStream, /"status":"completed"/u);
    assert.doesNotMatch(completedStream, /"status":"queued"/u);
    assert.equal(adapter.calls, 0, 'drain must not restart or replay an existing task');
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
  await store.patchTask(running.id, { output: 'Completed allowed inspection before restart.' });
  await store.appendEvent(running.id, { type: 'subagent-blocked', taskId: running.id, provider: 'antigravity', runId: 'fixture-blocked-run', reasonCode: 'SANDBOX_BOUNDARY_DENIED', toolCategory: 'command', count: 1, timestamp: Date.now() });
  const approval = await store.createTask({ id: 'recover-approval', sessionId: 'session-approval', prompt: 'Review first' });
  await store.claimTask(approval.id);
  await store.patchTask(approval.id, { status: 'waiting_approval' });

  const adapter = new TestMockAdapter();
  const { executor, ctx } = await createTestApp(adapter, { workStateStore: store });
  try {
    assert.equal(await executor.drainQueuedTasks(), 1);
    await waitForTask(executor, queued.id, task => task.status === 'completed');
    assert.equal((await executor.getTask(running.id)).status, 'failed');
    assert.match((await executor.getTask(running.id)).output, /Completed allowed inspection.*无法执行项/su);
    assert.match((await executor.getTask(running.id)).output, /SANDBOX_BOUNDARY_DENIED/u);
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

test('NavigatorExecutor: a new instance starts accepting, reclaims queued work once, and rejects the old drain token', async () => {
  const store = new InMemoryWorkStateStore();
  const queued = await store.createTask({ id: 'drain-restart-queued', sessionId: 'drain-restart-session', prompt: 'Run once after restart' });
  const first = await createTestApp(new TestMockAdapter(), { workStateStore: store });
  const firstDrain = first.executor.startDrain();
  await disposeApp(first);

  const adapter = new TestMockAdapter();
  const second = await createTestApp(adapter, { workStateStore: store });
  try {
    const status = await second.executor.getDrainStatus();
    assert.equal(status.mode, 'accepting');
    assert.equal(status.generation, 0);
    assert.notEqual(status.instanceId, firstDrain.instanceId);
    assert.equal(status.queuedTasks, 1);
    assert.throws(
      () => second.executor.resumeFromDrain(firstDrain.generation, firstDrain.token),
      error => error.code === 'DRAIN_GENERATION_MISMATCH',
    );

    assert.equal(await second.executor.drainQueuedTasks(), 1);
    await waitForTask(second.executor, queued.id, task => task.status === 'completed');
    assert.equal(adapter.calls, 1);
    assert.equal((await store.getTask(queued.id)).status, 'completed');
  } finally {
    await disposeApp(second);
  }
});

test('NavigatorExecutor: a shutdown drain cannot be resumed while SIGTERM cleanup is in progress', async () => {
  const app = await createTestApp();
  try {
    const shutdownDrain = app.executor.startShutdownDrain();
    assert.throws(
      () => app.executor.resumeFromDrain(shutdownDrain.generation, shutdownDrain.token),
      error => error.code === 'EXECUTOR_STOPPED',
    );
    const status = await app.executor.getDrainStatus();
    assert.equal(status.mode, 'draining');
    assert.equal(status.generation, shutdownDrain.generation);
    assert.equal(status.activeWorkDrained, true);
  } finally {
    await disposeApp(app);
  }
});

test('serve-executor teardown deadline includes context-fiber disposal', async () => {
  let fiberDisposalStarted = false;
  const result = await disposeWithin(
    { dispose: async () => undefined },
    { dispose: () => { fiberDisposalStarted = true; return new Promise(() => undefined); } },
    30,
  );
  assert.equal(fiberDisposalStarted, true);
  assert.equal(result, false, 'a hung Context fiber must not extend the SIGTERM cleanup deadline');
});

test('serve-executor SIGTERM drain timeout exits nonzero within its cleanup bound', {
  skip: process.platform === 'win32' ? 'Windows terminates a child on SIGTERM instead of running the POSIX handler.' : false,
}, async () => {
  const child = spawn(process.execPath, [
    'scripts/serve-executor.mjs', '--port=0', '--host=127.0.0.1', '--test-mode', '--test-echo-adapter',
    '--drain-timeout-ms=0', '--abort-cleanup-timeout-ms=500',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, CYRENE_EXECUTOR_TOKEN: TEST_BEARER },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  try {
    const readyDeadline = Date.now() + 10_000;
    while (!stdout.includes('"status":"ready"') && Date.now() < readyDeadline) {
      if (child.exitCode !== null) break;
      await delay(20);
    }
    assert.ok(stdout.includes('"status":"ready"'), `executor process did not become ready: ${stderr}`);
    const exitPromise = once(child, 'exit');
    const startedAt = performance.now();
    child.kill('SIGTERM');
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('SIGTERM cleanup exceeded its bounded deadline')), 4_000);
    });
    let exit;
    try {
      exit = await Promise.race([exitPromise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    assert.equal(exit[0], 1, stderr);
    assert.ok(performance.now() - startedAt < 4_000, 'drain deadline expiry must remain bounded');
    assert.match(stderr, /drain_deadline_exceeded_cleanup_completed/u);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('WorkStateClient: requests use the configured workspace bearer and decode nullable timestamps', async () => {
  const previousToken = process.env.CYRENE_SESSION_TOKEN;
  process.env.CYRENE_SESSION_TOKEN = 'work-test-token';
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      url: req.url, authorization: req.headers.authorization, method: req.method,
      idempotencyKey: req.headers['idempotency-key'],
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/workspaces/acme/work/tasks/source/resume/check') {
      res.writeHead(204).end();
      return;
    }
    if (req.url === '/api/v1/workspaces/acme/work/tasks/source/resume') {
      res.end(JSON.stringify({
        duplicate: false,
        task: {
          id: 'continuation-1', workspaceId: 'acme', sessionId: 'session-source',
          prompt: 'Continue safely.', status: 'queued', createdAt: 20,
          startedAt: null, endedAt: null, output: '', reasoning: '', error: null,
          durationMs: 0, sequence: 2, continuationOfTaskId: 'source', continuationMode: 'read_only',
        },
      }));
      return;
    }
    if (req.url === '/api/v1/workspaces/acme/work/tasks/other') {
      res.writeHead(404).end(JSON.stringify({ code: 'WORK_TASK_NOT_FOUND' }));
      return;
    }
    if (req.url === '/api/v1/workspaces/acme/work/tasks/item/events?after=0') {
      res.end(JSON.stringify({ events: [{ seq: 1, event: { type: 'task.created' }, createdAt: 10, messageId: null }], nextSeq: 1 }));
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
    assert.equal((await client.getEvents('item')).events[0].messageId, undefined);
    await client.verifyContinuationOwnership('source');
    const continuation = await client.createContinuationTask('source', {
      prompt: 'Continue safely.',
      idempotencyKey: 'resume-1',
    });
    assert.equal(continuation.continuationOfTaskId, 'source');
    assert.equal(continuation.continuationMode, 'read_only');
    assert.equal(seen.length, 5);
    const ownershipCheck = seen.find(row => row.url.endsWith('/tasks/source/resume/check'));
    assert.equal(ownershipCheck.method, 'POST');
    assert.equal(ownershipCheck.body, '');
    const resume = seen.find(row => row.url.endsWith('/tasks/source/resume'));
    assert.equal(resume.idempotencyKey, 'resume-1');
    assert.deepEqual(JSON.parse(resume.body), { prompt: 'Continue safely.' });
    assert.ok(seen.every(row => row.url.startsWith('/api/v1/workspaces/acme/work/tasks/')));
    assert.ok(seen.every(row => row.authorization === 'Bearer work-test-token'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousToken === undefined) delete process.env.CYRENE_SESSION_TOKEN;
    else process.env.CYRENE_SESSION_TOKEN = previousToken;
  }
});

test('WorkStateClient: private Teams connector admission sends only message text and decodes immutable route-free origin', async () => {
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const botAppId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const tokenEnv = 'PRIVATE_TEAMS_EVENT_TEST_TOKEN';
  const priorToken = process.env[tokenEnv];
  process.env[tokenEnv] = 'private-teams-event-work-token';
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      eventId: 'private-event-receipt',
      duplicate: false,
      receivedAt: 1_798_000_000_000,
      task: {
        id: 'teams-private-task-owner-hash', workspaceId: 'acme', createdByActorId: ownerId,
        sessionId: 'teams-private-session-owner-hash', prompt: 'Private request.', status: 'queued',
        createdAt: 1_798_000_000_000, startedAt: null, endedAt: null, output: '', reasoning: '',
        error: null, durationMs: 0, sequence: 1, metadata: {},
        origin: {
          kind: 'teams_private', messageId: 'private-activity-1', tenantId, botAppId,
          actorAadObjectId: ownerId,
        },
      },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new WorkStateClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      workspaceId: 'acme',
      tokenEnv,
    });
    await assert.rejects(client.registerConnectorEvent({
      connectorId: 'teams-v1',
      messageId: 'private-activity-without-task',
      type: 'message.received',
      payload: { provider: 'teams', messageId: 'private-activity-without-task', text: 'Private request.' },
      teamsPrivateMessage: { messageId: 'private-activity-without-task', text: 'Private request.' },
    }), /require an actor-owned Task/u);
    assert.equal(seen.length, 0, 'taskless private events never reach Work');
    const receipt = await client.registerConnectorEvent({
      connectorId: 'teams-v1',
      messageId: 'private-activity-1',
      type: 'message.received',
      payload: { provider: 'teams', messageId: 'private-activity-1', text: 'Private request.' },
      teamsPrivateMessage: { messageId: 'private-activity-1', text: 'Private request.' },
      task: {
        id: 'teams-private-task-owner-hash',
        sessionId: 'teams-private-session-owner-hash',
        prompt: 'Private request.',
        metadata: {},
      },
    });
    assert.equal(receipt.task.createdByActorId, ownerId);
    assert.deepEqual(receipt.task.origin, {
      kind: 'teams_private',
      messageId: 'private-activity-1',
      tenantId,
      botAppId,
      actorAadObjectId: ownerId,
    });
    assert.deepEqual(seen[0], {
      url: '/api/v1/workspaces/acme/work/connectors/teams-v1/events',
      method: 'POST',
      authorization: 'Bearer private-teams-event-work-token',
      body: {
        messageId: 'private-activity-1',
        type: 'message.received',
        payload: { provider: 'teams', messageId: 'private-activity-1', text: 'Private request.' },
        teamsPrivateMessage: { messageId: 'private-activity-1', text: 'Private request.' },
        task: {
          id: 'teams-private-task-owner-hash',
          sessionId: 'teams-private-session-owner-hash',
          prompt: 'Private request.',
          metadata: {},
        },
      },
    });
    assert.equal(JSON.stringify(seen[0].body).includes('conversationId'), false);
    assert.equal(JSON.stringify(seen[0].body).includes('serviceUrl'), false);
    assert.equal(JSON.stringify(seen[0].body).includes('actorAadObjectId'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (priorToken === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = priorToken;
  }
});

test('WorkStateClient: private claim decodes the Work route from the lease envelope', async () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const botAppId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const actorTokenEnv = 'PRIVATE_ROUTE_ACTOR_TOKEN';
  const bridgeTokenEnv = 'PRIVATE_ROUTE_BRIDGE_TOKEN';
  const previousValues = new Map([[actorTokenEnv, process.env[actorTokenEnv]], [bridgeTokenEnv, process.env[bridgeTokenEnv]]]);
  process.env[actorTokenEnv] = 'private-route-actor-work-token';
  process.env[bridgeTokenEnv] = 'private-route-bridge-token';
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, method: req.method, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [{
      notification: {
        id: 'private-notice-1', deduplicationKey: 'private-dedupe-1', type: 'teams.message',
        payload: { text: 'Private result.' }, taskId: 'teams-private-task', connectorId: 'teams-v1',
        recipient: 'teams:owner-private', status: 'leased', result: { retryCount: 0 },
      },
      leaseToken: 'private-lease-1', leaseExpiresAt: Date.now() + 30_000,
      teamsPersonalRoute: {
        kind: 'teams_personal', tenantId, botAppId, actorAadObjectId: ownerId,
        conversationId: '19:private-owner-route', serviceUrl: 'https://smba.trafficmanager.net/emea/',
      },
    }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new WorkStateClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      workspaceId: 'acme',
      tokenEnv: actorTokenEnv,
      privateBridgeTokenEnv: bridgeTokenEnv,
    });
    const leases = await client.claimPrivateNotifications({
      workerId: 'navigator-private-test', limit: 1, leaseSeconds: 60, type: 'teams.message', connectorId: 'teams-v1',
    });
    assert.equal(leases.length, 1);
    assert.deepEqual(leases[0].teamsPersonalRoute, {
      kind: 'teams_personal', tenantId, botAppId, actorAadObjectId: ownerId,
      conversationId: '19:private-owner-route', serviceUrl: 'https://smba.trafficmanager.net/emea/',
    });
    assert.equal(leases[0].notification.teamsPersonalRoute, undefined);
    assert.deepEqual(seen, [{
      url: '/api/v1/workspaces/acme/work/private-notifications/claim',
      method: 'POST',
      authorization: `Bearer ${process.env[bridgeTokenEnv]}`,
    }]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const [name, value] of previousValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('WorkStateClient: credential health checkpoints use the dedicated taskless route', async () => {
  const tokenEnv = 'CREDENTIAL_HEALTH_WORK_TOKEN';
  const previousToken = process.env[tokenEnv];
  process.env[tokenEnv] = 'credential-health-work-token';
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url?.endsWith('/notifications/claim')
      ? JSON.stringify({ items: [] })
      : JSON.stringify({ processed: 1, stale: 0, notificationsQueued: 1 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new WorkStateClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      workspaceId: 'acme',
      tokenEnv,
    });
    const snapshot = {
      connectionId: '22222222-2222-4222-8222-222222222222',
      provider: 'hf',
      loginState: 'PRESENT',
      authorizationState: 'REAUTHORIZATION_REQUIRED',
      checkedAt: '2026-10-26T15:00:00Z',
      expiresAt: '2026-10-26T16:00:00Z',
      generation: 3,
      capabilities: [],
      reasonCode: 'TOKEN_EXPIRED',
    };
    assert.deepEqual(await client.processCredentialHealthSnapshots('org-1', [snapshot]), {
      processed: 1, stale: 0, notificationsQueued: 1,
    });
    assert.deepEqual(await client.claimNotifications({
      workerId: 'credential-health-worker',
      limit: 10,
      leaseSeconds: 60,
      type: 'teams.credential-health',
      connectorId: 'teams-v1',
      recipient: 'teams:credential-health',
    }), []);
    assert.deepEqual(seen, [{
      url: '/api/v1/workspaces/acme/work/credential-health/snapshots',
      method: 'POST',
      authorization: 'Bearer credential-health-work-token',
      body: JSON.stringify({ organizationId: 'org-1', connections: [snapshot] }),
    }, {
      url: '/api/v1/workspaces/acme/work/notifications/claim',
      method: 'POST',
      authorization: 'Bearer credential-health-work-token',
      body: JSON.stringify({
        workerId: 'credential-health-worker', limit: 10, leaseSeconds: 60,
        type: 'teams.credential-health', connectorId: 'teams-v1', recipient: 'teams:credential-health',
      }),
    }]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousToken === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = previousToken;
  }
});

test('WorkStateClient reads and binds the native session through the active Work Task', async () => {
  const previousToken = process.env.CYRENE_SESSION_TOKEN;
  process.env.CYRENE_SESSION_TOKEN = 'work-test-token';
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/v1/workspaces/acme/work/tasks/task-1/backend-session?backend=codebuddy-acp') {
      res.end('null');
      return;
    }
    if (req.method === 'PUT' && req.url === '/api/v1/workspaces/acme/work/tasks/task-1/backend-session') {
      res.end(JSON.stringify({
        backend: 'codebuddy-acp', sessionId: 'work-session', nativeSessionId: 'native-session',
      }));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ code: 'WORK_TASK_NOT_FOUND' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new WorkStateClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, workspaceId: 'acme' });
    assert.equal(await client.getBackendSession('task-1'), undefined);
    assert.deepEqual(await client.bindBackendSession('task-1', 'native-session'), {
      backend: 'codebuddy-acp', sessionId: 'work-session', nativeSessionId: 'native-session',
    });
    assert.deepEqual(seen.map(row => [row.method, row.url]), [
      ['GET', '/api/v1/workspaces/acme/work/tasks/task-1/backend-session?backend=codebuddy-acp'],
      ['PUT', '/api/v1/workspaces/acme/work/tasks/task-1/backend-session'],
    ]);
    assert.deepEqual(JSON.parse(seen[1].body), { backend: 'codebuddy-acp', nativeSessionId: 'native-session' });
    assert.ok(seen.every(row => row.authorization === 'Bearer work-test-token'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousToken === undefined) delete process.env.CYRENE_SESSION_TOKEN;
    else process.env.CYRENE_SESSION_TOKEN = previousToken;
  }
});

test('WorkStateClient reads consecutive persisted Teams messages with line breaks', async () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const serviceUrl = 'https://smba.trafficmanager.net/emea/';
  const tokenEnv = 'TEAMS_WORK_STATE_TEST_TOKEN';
  const previousToken = process.env[tokenEnv];
  process.env[tokenEnv] = 'work-state-test-token';
  const q1 = 'Question one, line one.\nQuestion one, line two\twith a tab.\r\nQuestion one, line three.';
  const q2 = 'Question two, first line.\nQuestion two, second line.';
  let messages = [
    {
      messageId: 'teams-q1',
      actorIssuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      actorSubject: ownerId,
      text: q1,
      createdAt: 10,
    },
    {
      messageId: 'teams-q2',
      actorIssuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      actorSubject: ownerId,
      text: q2,
      createdAt: 20,
    },
  ];
  let authorizationHeader;
  const server = createServer((req, res) => {
    if (req.method === 'GET'
      && req.url?.startsWith('/api/v1/workspaces/acme/work/connectors/teams-v1/threads/thread-1?')) {
      authorizationHeader = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        threadId: 'thread-1',
        tenantId,
        teamId: 'team-1',
        channelId: 'channel-1',
        conversationId: '19:channel-conversation',
        rootThreadId: '1698765432100',
        serviceUrl,
        sessionId: 'teams-thread-1',
        messages,
      }));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ code: 'WORK_CONNECTOR_THREAD_NOT_FOUND' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = new WorkStateClient({
      baseUrl: `http://127.0.0.1:${port}`,
      workspaceId: 'acme',
      tokenEnv,
    });
    const thread = await client.getConnectorThread('teams-v1', 'thread-1', 20);
    assert.deepEqual(thread.messages.map(message => message.text), [q1, q2]);
    assert.equal(thread.sessionId, 'teams-thread-1');
    assert.equal(authorizationHeader, 'Bearer work-state-test-token');

    messages = [{ ...messages[0], text: 'Before\u0000After' }];
    await assert.rejects(client.getConnectorThread('teams-v1', 'thread-1', 20), /Invalid thread message text/u);

    messages = [{ ...messages[0], text: 'x'.repeat(20_001) }];
    await assert.rejects(client.getConnectorThread('teams-v1', 'thread-1', 20), /Invalid thread message text/u);

    messages = [{ ...messages[0], messageId: 'bad\nmessage-id' }];
    await assert.rejects(client.getConnectorThread('teams-v1', 'thread-1', 20), /Invalid thread message id/u);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousToken === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = previousToken;
  }
});

test('continuation verifies Work ownership before using a stored session with Exchange', async () => {
  const store = new InMemoryWorkStateStore();
  const source = await createPausedAuthorizationTask(store, 'foreign-source', 'foreign-session');
  store.verifyContinuationOwnership = async () => {
    throw new WorkStateHttpError(404, 'WORK_TASK_NOT_FOUND');
  };
  let exchangeReads = 0;
  const app = await createTestApp(new TestMockAdapter(), {
    workStateStore: store,
    revalidateExchangeAuthorization: async () => {
      exchangeReads += 1;
      throw new Error('must not call Exchange before ownership is verified');
    },
  });
  try {
    await assert.rejects(
      app.executor.resumeTask(source.id, 'Read only continuation.', 'foreign-owner-check'),
      error => error.status === 404 && error.code === 'TASK_NOT_FOUND',
    );
    assert.equal(exchangeReads, 0);

    store.verifyContinuationOwnership = async () => {
      throw new WorkStateHttpError(404, 'HTTP_ERROR');
    };
    await assert.rejects(
      app.executor.resumeTask(source.id, 'Do not use an older Work API.', 'old-work-api-check'),
      error => error.status === 503 && error.code === 'SAFE_CONTINUATION_UNAVAILABLE',
    );
    assert.equal(exchangeReads, 0, 'an older Work API must fail closed before Exchange is called');
  } finally {
    await disposeApp(app);
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
    modelSource: 'exchange',
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

test('Exchange reauthorization wait stops its DSH turn, preserves progress through restart, streams, and cancels', async () => {
  const store = new InMemoryWorkStateStore();
  const adapter = new TestMockAdapter({ delayMs: 200 });
  const app = await createTestApp(adapter, { workStateStore: store });
  try {
    const pausedExecution = app.executor.executeTask({
      taskId: 'auth-wait-live',
      sessionId: 'auth-wait-session',
      prompt: 'Inspect the configured resource and continue independent work.',
    });
    await waitForTask(app.executor, 'auth-wait-live', task => task.status === 'running');
    await store.patchTask('auth-wait-live', { output: 'Completed safe inspection before authorization.' });
    const marked = await app.executor.markTaskAwaitingUserAuthorization('auth-wait-session', {
      callId: 'cloud-query-call',
      connectionId: '7e1c50d2-b4f3-4d61-9302-9a0bd48d1991',
      authorizationRef: 'native-authorization-ref',
      generation: 4,
      source: 'connection-resources',
      code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
    });
    assert.equal(marked, true);

    const independent = app.executor.executeTask({
      taskId: 'auth-independent-task',
      sessionId: 'independent-session',
      prompt: 'Finish an unrelated safe task.',
    });
    const [paused, unrelated] = await Promise.all([pausedExecution, independent]);
    assert.equal(paused.status, 'awaiting_user_authorization');
    assert.match(paused.output, /Completed safe inspection/u);
    assert.equal(unrelated.status, 'completed');
    assert.equal((await app.executor.getTask('auth-wait-live')).status, 'awaiting_user_authorization');
    const events = await store.getEvents('auth-wait-live');
    assert.ok(events.events.some(row => row.event.type === 'authorization-required'
      && row.event.code === 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED'
      && row.event.callId === 'cloud-query-call'));
    assert.ok(events.events.some(row => row.event.type === 'finish'
      && row.event.status === 'awaiting_user_authorization'));
    assert.ok(!events.events.some(row => row.event.type === 'finish' && row.event.status === 'completed'));
  } finally {
    await disposeApp(app);
  }

  const restarted = await createTestApp(new TestMockAdapter(), { workStateStore: store });
  const { url, close } = await restarted.executor.startServer(0, '127.0.0.1');
  try {
    assert.equal((await restarted.executor.getTask('auth-wait-live')).status, 'awaiting_user_authorization');
    const replay = await fetch(url + '/api/v1/tasks/auth-wait-live/events?after=0', {
      headers: { Authorization: 'Bearer ' + TEST_BEARER },
    });
    assert.equal(replay.status, 200);
    const stream = await replay.text();
    assert.match(stream, /event: authorization-required/u);
    assert.match(stream, /"status":"awaiting_user_authorization"/u);
    assert.equal(await restarted.executor.cancelTask('auth-wait-live'), true);
    assert.equal((await restarted.executor.getTask('auth-wait-live')).status, 'aborted');
    const cancelled = await store.getEvents('auth-wait-live');
    assert.ok(cancelled.events.some(row => row.event.type === 'finish' && row.event.status === 'aborted'));
  } finally {
    await close();
    await disposeApp(restarted);
  }
});

test('safe authorization continuation revalidates exact generations and blocks unknown Exchange writes', async () => {
  const store = new InMemoryWorkStateStore();
  const revalidated = [];
  let operationState = 'SUCCEEDED';
  let authorizationGeneration = 5;
  const adapter = new TestMockAdapter({ delayMs: 800 });
  const app = await createTestApp(adapter, {
    workStateStore: store,
    revalidateExchangeAuthorization: async (sessionId, connectionId) => {
      revalidated.push({ sessionId, connectionId });
      return {
        connectionId,
        authorizationRef: 'native-authorization-ref',
        loginState: 'PRESENT',
        authorizationState: 'VALID',
        generation: authorizationGeneration,
      };
    },
    readExchangeOperationState: async (_sessionId, _operationId) => operationState,
  });
  const disposeUnsafeTools = [];
  let closeServer;
  try {
    const source = await createPausedAuthorizationTask(store, 'safe-resume-source', 'safe-resume-session');
    const server = await app.executor.startServer(0, '127.0.0.1');
    closeServer = server.close;
    const response = await fetch(server.url + '/api/v1/tasks/' + source.id + '/resume', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + TEST_BEARER,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'safe-resume-idempotency',
      },
      body: JSON.stringify({ prompt: 'Continue with read-only resource verification.' }),
    });
    assert.equal(response.status, 202);
    const continuation = await response.json();
    await closeServer();
    closeServer = undefined;
    assert.equal(continuation.continuationOfTaskId, source.id);
    assert.equal(continuation.continuationMode, 'read_only');
    assert.equal(continuation.sessionId, source.sessionId);
    assert.notEqual(continuation.prompt, source.prompt);
    assert.deepEqual(revalidated, [{
      sessionId: source.sessionId,
      connectionId: '7e1c50d2-b4f3-4d61-9302-9a0bd48d1991',
    }]);
    const childEvents = await store.getEvents(continuation.id);
    assert.ok(childEvents.events.some(row => row.event.type === 'task.authorization_revalidated'
      && row.event.connections[0].generation === 5));

    let writes = 0;
    for (const name of ['work_memory_remember', 'shell_execute', 'subagent']) {
      disposeUnsafeTools.push(app.ctx.tools.register(defineTool({
        name,
        description: 'Test-only tool that must be denied in a read-only continuation.',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: () => {
          writes += 1;
          return { executed: true };
        },
      })));
    }
    assert.equal(await app.executor.drainQueuedTasks(), 1);
    await waitForTask(app.executor, continuation.id, task => task.status === 'running');
    await waitForActiveTask(app.executor, continuation.sessionId, continuation.id);
    await delay(30);
    const continuationAgent = app.ctx.get('agents').get(continuation.sessionId);
    assert.ok(continuationAgent, 'continuation agent should own the scoped read-only guard');
    for (const name of ['work_memory_remember', 'shell_execute', 'subagent']) {
      const deniedWrite = await app.ctx.tools.execute({
        name,
        callId: ToolCallId('read-only-write-attempt-' + name),
        arguments: {},
        signal: new AbortController().signal,
        agent: continuationAgent,
      });
      assert.equal(deniedWrite.isError, true, name + ' must be denied');
    }
    assert.equal(writes, 0);
    await waitForTask(app.executor, continuation.id, task => task.status === 'completed');

    const unknown = await store.createTask({
      id: 'unknown-write-source', sessionId: 'unknown-write-session', prompt: 'Do not repeat the prior write.',
    });
    await store.claimTask(unknown.id);
    await store.patchTask(unknown.id, { status: 'awaiting_user_authorization' });
    await store.appendEvent(unknown.id, {
      type: 'authorization-required', taskId: unknown.id,
      callId: 'unknown-auth-call',
      code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
      source: 'issue-action',
      connectionId: '7e1c50d2-b4f3-4d61-9302-9a0bd48d1991',
      authorizationRef: 'native-authorization-ref',
      generation: 4,
    });
    await store.appendEvent(unknown.id, {
      type: 'tool-call', taskId: unknown.id, callId: 'unknown-write-call',
      tool: 'exchange_issue_comment', args: '{"body":"private comment"}',
    });
    await store.appendEvent(unknown.id, {
      type: 'tool-result', taskId: unknown.id, callId: 'unknown-write-call',
      result: JSON.stringify({ operationId: 'exchange-op-unknown', action: 'integration.issue.comment', state: 'UNKNOWN' }),
    });
    await store.appendEvent(unknown.id, {
      type: 'finish', taskId: unknown.id, status: 'awaiting_user_authorization',
      output: '', durationMs: 1, timestamp: Date.now(),
    });
    operationState = 'UNKNOWN';
    await assert.rejects(
      app.executor.resumeTask(unknown.id, 'Read only after reauthorization.', 'unknown-write-resume'),
      error => error.code === 'EXCHANGE_WRITE_UNKNOWN',
    );
    const tasks = await store.listTasks();
    assert.ok(!tasks.items.some(task => task.continuationOfTaskId === unknown.id));

    const stale = await createPausedAuthorizationTask(store, 'stale-generation-source', 'stale-generation-session');
    authorizationGeneration = 4;
    await assert.rejects(
      app.executor.resumeTask(stale.id, 'Do not continue on the old generation.', 'stale-generation-resume'),
      error => error.code === 'AUTHORIZATION_NOT_READY',
    );
  } finally {
    await closeServer?.();
    for (const dispose of disposeUnsafeTools.reverse()) dispose();
    await disposeApp(app);
  }
});
