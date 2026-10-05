// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator durable workflow runtime integration              │
// │ Role: Exercise DSH Schedule delivery, restart dedup, and quiet runs.  │
// │ 模块职责：验证 DSH Schedule 派发、重启去重与静默工作流。                  │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import {
  InMemoryWorkflowStore,
  installWorkflowReadonlyGuard,
  registerWorkflowRuntime,
  WorkflowsClient,
} from '../dist/workflows/index.js';

const WORKFLOW_ID = 'workflow-proof';
const SCHEDULER_SESSION_ID = 'navigator-workflow-scheduler-v1';

class CountingAdapter extends LlmAdapter {
  constructor() {
    super();
    this.calls = 0;
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream() {
    this.calls += 1;
    const text = 'The scheduler should never ask the model to execute its timer inbox.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function createHost(directory, store, executeTask, adapter) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(SessionPersistenceJsonl, { root: join(directory, 'session-logs'), compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(['workflow-proof'], adapter);
  let modelRequests = 0;
  ctx.on('agent/request', async (_payload, next) => {
    modelRequests += 1;
    return { ...await next(), provider: 'workflow-proof', model: 'counted-model' };
  });
  const handle = await registerWorkflowRuntime(ctx, {
    store,
    executeTask,
    storageRoot: join(directory, 'dsh-storage'),
    schedulerSessionId: SCHEDULER_SESSION_ID,
    defaultWorkflows: [],
    reconcileEveryMs: 0,
  });
  return { ctx, handle, modelRequests: () => modelRequests };
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(message);
}

async function eventsFor(store) {
  return (await store.listScheduleEvents({ workflowId: WORKFLOW_ID, limit: 100 })).items;
}

test('workflow notification client awaits the durable outbox endpoint and replays by its stable key', { timeout: 15_000 }, async () => {
  const previousToken = process.env.CYRENE_TEST_WORK_TOKEN;
  process.env.CYRENE_TEST_WORK_TOKEN = 'fixture-token-value';
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(requests.length === 1 ? 201 : 200, { 'content-type': 'application/json' }).end(JSON.stringify({
        notification: { id: 'outbox-fixture', ...requests.at(-1).body, status: 'queued' },
        duplicate: requests.length > 1,
      }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const store = new WorkflowsClient({
      baseUrl: `http://127.0.0.1:${address.port}`, workspaceId: 'workspace-fixture', tokenEnv: 'CYRENE_TEST_WORK_TOKEN',
    });
    const request = {
      deduplicationKey: 'workflow:workflow-proof:occ-fixture:failure',
      type: 'workflow.failure',
      payload: { workflowId: 'workflow-proof', occurrenceId: 'occ-fixture', summary: 'Read failed.', taskId: 'workflow-task-fixture' },
    };
    const first = await store.enqueueNotification(request);
    const replay = await store.enqueueNotification(request);
    assert.equal(first.duplicate, false);
    assert.equal(replay.duplicate, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/api/v1/workspaces/workspace-fixture/work/notifications');
    assert.equal(requests[0].authorization, 'Bearer fixture-token-value');
    assert.equal('taskId' in requests[0].body, false, 'completed workflow task ids stay inside the payload');
    assert.deepEqual(requests[0].body, request);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previousToken === undefined) delete process.env.CYRENE_TEST_WORK_TOKEN;
    else process.env.CYRENE_TEST_WORK_TOKEN = previousToken;
  }
});

async function deliverDuplicate(agent, prompt, scheduledAt) {
  const framed = [
    '[SCHEDULE REMINDER BATCH]',
    'This is a scheduled message from the user',
    `reminders_json: ${JSON.stringify([{ schedule_id: 'schedule-replay', occurrence_at: scheduledAt, reminder_prompt: prompt }])}`,
  ].join('\n');
  agent.followup(createUserMessage({
    source: { kind: 'schedule' },
    content: [{ type: 'text', text: framed }],
  }));
  await agent.whenIdle();
}

test('workflow readonly guard blocks notify/provider/vendor writes for only the active occurrence Session', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navigator-workflow-policy-'));
  const store = new InMemoryWorkflowStore();
  const host = await createHost(directory, store, async request => ({
    taskId: request.taskId, sessionId: request.sessionId, status: 'completed',
    output: JSON.stringify({ changed: false, summary: 'read only' }),
  }), new CountingAdapter());
  let writeSideEffects = 0;
  let readCalls = 0;
  const output = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  };
  const register = (name, execute) => host.ctx.tools.register(defineTool({
    name, description: `test tool ${name}`, parameters: {}, output, execute,
  }));
  register('work_notify', async () => { writeSideEffects += 1; return 'queued'; });
  register('mcp__vendor__repository_write', async () => { writeSideEffects += 1; return 'changed'; });
  register('provider_write_tool', async () => { writeSideEffects += 1; return 'changed'; });
  register('work_sources', async () => { readCalls += 1; return 'sources'; });
  register('mcp__microsoft_learn__search', async () => { readCalls += 1; return 'docs'; });
  register('gcloud_readonly', async args => { readCalls += 1; return args.projectId; });
  host.ctx.provide('cloudConnections', {
    list: () => [], get: () => undefined,
    workflowReadonlyTools: id => id === 'microsoft-learn' ? ['mcp__microsoft_learn__search']
      : id === 'google-cloud-readonly' ? ['gcloud_readonly'] : [],
    workflowReadonlyProjectIds: id => id === 'google-cloud-readonly' ? ['alpha-project'] : [],
  });
  const activeHandle = await host.ctx.agents.create({ sessionId: SessionId('workflow-policy-active') });
  const unrelatedHandle = await host.ctx.agents.create({ sessionId: SessionId('workflow-policy-unrelated') });
  const dispose = installWorkflowReadonlyGuard(host.ctx, {
    id: 'workflow-policy', version: 1, title: 'Read only policy', description: 'test', instructions: 'inspect',
    targets: [
      { id: 'microsoft-learn', label: 'Microsoft Learn', kind: 'cloud-connection' },
      { id: 'alpha-project', label: 'Alpha project', kind: 'google-cloud-project' },
    ],
    notifications: { onChange: true, onFailure: true, onRecovery: true, quietWhenUnchanged: true },
    enabled: true, updatedAt: new Date().toISOString(),
  }, String(activeHandle.agent.session.id));
  const invoke = async (name, callId, agent, args = {}) => host.ctx.tools.execute({
    name, callId: ToolCallId(callId), arguments: args, signal: new AbortController().signal, agent,
  });

  try {
    for (const name of ['work_notify', 'mcp__vendor__repository_write', 'provider_write_tool']) {
      const result = await invoke(name, `blocked-${name}`, activeHandle.agent);
      assert.equal(result.isError, true, `${name} should be rejected by the workflow policy`);
    }
    assert.equal(writeSideEffects, 0, 'blocked model-requested tools must not reach their external side effect');
    assert.equal((await invoke('work_sources', 'allowed-sources', activeHandle.agent)).isError, false);
    assert.equal((await invoke('mcp__microsoft_learn__search', 'allowed-docs', activeHandle.agent)).isError, false);
    assert.equal((await invoke('gcloud_readonly', 'allowed-gcloud', activeHandle.agent, {
      operation: 'projects.describe', projectId: 'alpha-project',
    })).isError, false);
    assert.equal((await invoke('gcloud_readonly', 'blocked-gcloud-project', activeHandle.agent, {
      operation: 'projects.describe', projectId: 'beta-project',
    })).isError, true, 'gcloud access must match a workflow target and the profile allowlist');
    assert.equal(readCalls, 3);
    assert.equal((await invoke('work_notify', 'unrelated-notify', unrelatedHandle.agent)).isError, false,
      'the temporary guard must not change another Session');
    assert.equal(writeSideEffects, 1);
    dispose();
    assert.equal((await invoke('work_notify', 'after-policy', activeHandle.agent)).isError, false,
      'the temporary guard must be removed after the occurrence ends');
    assert.equal(writeSideEffects, 2);
  } finally {
    dispose();
    await host.handle.dispose().catch(() => undefined);
    await host.ctx.fiber.dispose().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('official DSH Schedule source is consumed once, remains durable, and dispatches idempotently after restart', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navigator-workflow-runtime-'));
  const store = new InMemoryWorkflowStore();
  const adapter = new CountingAdapter();
  const taskOutcomes = new Map();
  const plannedOutcomes = [
    { status: 'completed', output: JSON.stringify({ changed: false, summary: 'No configured resource changed.' }) },
    { status: 'failed', output: '', error: 'fixture failure' },
    { status: 'failed', output: '', error: 'fixture failure' },
    { status: 'completed', output: JSON.stringify({ changed: false, summary: 'The read completed after recovery.' }) },
    { status: 'completed', output: JSON.stringify({ changed: true, summary: 'The configured target changed.' }) },
  ];
  const executorRequests = [];
  const executionStarts = [];
  let workflowContext;
  let workflowWriteSideEffects = 0;
  const executeTask = async request => {
    executorRequests.push(request);
    const prior = taskOutcomes.get(request.taskId);
    if (prior !== undefined) return prior;
    executionStarts.push(request.taskId);
    const next = plannedOutcomes.shift();
    assert.ok(next, 'test supplied an outcome for every unique occurrence');
    if (workflowContext !== undefined && executionStarts.length === 1) {
      const executionAgent = await workflowContext.agents.create({ sessionId: SessionId(request.sessionId) });
      const blockedWrite = await workflowContext.tools.execute({
        name: 'work_notify',
        arguments: { deduplicationKey: 'malicious', type: 'external.write', payload: { text: 'send' } },
        callId: ToolCallId('workflow-malicious-write'),
        signal: new AbortController().signal,
        agent: executionAgent.agent,
      });
      assert.equal(blockedWrite.isError, true, 'the executing workflow model request must be denied before tool dispatch');
    }
    const outcome = { taskId: request.taskId, sessionId: request.sessionId, ...next };
    taskOutcomes.set(request.taskId, outcome);
    return outcome;
  };
  const workflow = {
    id: WORKFLOW_ID,
    version: 1,
    title: 'Configured cloud snapshot',
    description: 'Check one configured read-only fixture target.',
    instructions: 'Report the configured target state without changing it.',
    targets: [{ id: 'fixture-resource', label: 'Fixture resource', kind: 'cloud-resource' }],
    notifications: { onChange: true, onFailure: true, onRecovery: true, quietWhenUnchanged: true },
    enabled: true,
    schedule: { kind: 'cron', expression: '0 0 1 1 *', timeZone: 'UTC' },
  };
  const notifications = [];
  let first;
  let second;
  let oneShot;
  const runtimeErrors = [];

  try {
    await store.putWorkflow(workflow);
    first = await createHost(directory, store, executeTask, adapter);
    workflowContext = first.ctx;
    first.ctx.tools.register(defineTool({
      name: 'work_notify', description: 'Attempt a model-requested external notification.',
      parameters: {
        deduplicationKey: { type: 'string', required: true },
        type: { type: 'string', required: true },
        payload: { type: 'object', additionalProperties: true, required: true },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { workflowWriteSideEffects += 1; return 'queued'; },
    }));
    first.ctx.on('agent/error', ({ error }) => runtimeErrors.push(error instanceof Error ? error.message : String(error)));
    first.ctx.on('agent/status', ({ status }) => runtimeErrors.push(`status:${status}`));
    const observeNotification = notification => {
      assert.equal(store.listNotifications().length, notifications.length + 1,
        'notification observation must occur after a new durable outbox receipt');
      notifications.push(notification);
    };
    first.ctx.on('workflow/notification', observeNotification);
    const schedulerId = SessionId(SCHEDULER_SESSION_ID);
    const firstSchedule = (await first.ctx.schedule.catalog()).find(entry => entry.title === workflow.title);
    assert.ok(firstSchedule);
    assert.equal(firstSchedule.status, 'active');
    assert.match(firstSchedule.prompt, /^\[CYRENE_WORKFLOW_TIMER_V1\]\n/);
    assert.ok((await readFile(join(directory, 'dsh-storage', 'schedule.json'), 'utf8')).includes(firstSchedule.id));

    // A real one-shot from the official DSH Schedule service exercises its timer,
    // Session flush, schedule-source frame, and the production pre-step consumer.
    oneShot = await first.ctx.schedule.create(schedulerId, {
      title: 'Workflow runtime integration trigger',
      prompt: firstSchedule.prompt,
      after_seconds: 1,
    });
    assert.ok((await first.ctx.schedule.catalog()).some(entry => entry.id === firstSchedule.id), 'the configured cron row survives a second DSH Schedule task');
    await waitFor(async () => (await eventsFor(store)).some(event => event.scheduledAt === oneShot.scheduledAt && event.status === 'succeeded'),
      `the DSH Schedule occurrence was not dispatched: ${JSON.stringify(runtimeErrors)}`);
    assert.ok((await first.ctx.schedule.catalog()).some(entry => entry.id === firstSchedule.id), 'the configured cron row survives a delivery');
    const firstAgent = first.ctx.agents.get(schedulerId);
    assert.ok(firstAgent);
    await firstAgent.whenIdle();
    assert.equal(first.modelRequests(), 0);
    assert.equal(adapter.calls, 0);
    assert.deepEqual(notifications, [], 'unchanged success should remain quiet');
    assert.deepEqual(store.listNotifications(), [], 'quiet unchanged success must not enqueue an outbox item');
    assert.equal(workflowWriteSideEffects, 0, 'a malicious work_notify request from the real scheduled executor must not enqueue anything');
    assert.equal(executionStarts.length, 1);
    const firstEvents = (await eventsFor(store)).filter(event => event.scheduledAt === oneShot.scheduledAt);
    assert.deepEqual(firstEvents.map(event => event.status).sort(), ['queued', 'running', 'succeeded']);
    await waitFor(async () => (await first.ctx.schedule.catalog())
      .some(entry => entry.id === oneShot.id && entry.status === 'inactive'),
    'DSH Schedule did not persist its delivery receipt');

    await first.handle.dispose();
    assert.ok((await first.ctx.schedule.catalog()).some(entry => entry.id === firstSchedule.id), 'the configured cron row survives workflow teardown');
    await first.ctx.fiber.dispose();
    assert.ok((await readFile(join(directory, 'dsh-storage', 'schedule.json'), 'utf8')).includes(firstSchedule.id), 'the configured cron row remains on disk after host shutdown');
    assert.equal((await store.listWorkflows()).length, 1, 'the workspace workflow remains available during restart');
    first = undefined;

    // The official DSH JSON domain and scheduler Session are reopened from the same
    // persistent roots, while the Work API and executor remain their own authorities.
    second = await createHost(directory, store, executeTask, adapter);
    const [restartedWorkflow] = await store.listWorkflows();
    assert.ok(restartedWorkflow?.enabled && restartedWorkflow.targets.length > 0 && restartedWorkflow.schedule,
      `workflow definition survives host reinitialization: ${JSON.stringify(restartedWorkflow)}`);
    second.ctx.on('workflow/notification', observeNotification);
    const restartedAgent = second.ctx.agents.get(schedulerId);
    assert.ok(restartedAgent, 'the stable scheduler Session should resume from JSONL persistence');
    const restored = (await second.ctx.schedule.catalog()).find(entry => entry.title === workflow.title);
    assert.ok(restored, JSON.stringify(await second.ctx.schedule.catalog()));
    assert.equal(restored.id, firstSchedule.id);
    assert.equal(restored.status, 'active');

    // Simulate redelivery of the same official source frame after restart. The
    // stable executor id returns its durable outcome; no second run starts.
    await deliverDuplicate(restartedAgent, firstSchedule.prompt, oneShot.scheduledAt);
    assert.equal(executionStarts.length, 1);
    assert.equal(executorRequests.length, 2);
    assert.equal(executorRequests[0].taskId, executorRequests[1].taskId);
    assert.equal(second.modelRequests(), 0);
    assert.equal(adapter.calls, 0);
    const duplicateEvents = (await eventsFor(store)).filter(event => event.scheduledAt === oneShot.scheduledAt);
    assert.deepEqual(duplicateEvents.map(event => event.status).sort(), ['queued', 'running', 'succeeded']);

    const secondAt = new Date(Date.parse(oneShot.scheduledAt) + 60_000).toISOString();
    await deliverDuplicate(restartedAgent, firstSchedule.prompt, secondAt);
    assert.equal(notifications.at(-1)?.kind, 'failure');
    assert.equal(store.listNotifications().length, 1, 'a failure transition is durably queued before observation');
    await deliverDuplicate(restartedAgent, firstSchedule.prompt, secondAt);
    assert.equal(store.listNotifications().length, 1, 'a duplicate occurrence reuses its durable deduplication key');
    assert.equal(notifications.filter(item => item.kind === 'failure').length, 1,
      'a duplicate occurrence emits no second observation');
    const thirdAt = new Date(Date.parse(oneShot.scheduledAt) + 120_000).toISOString();
    await deliverDuplicate(restartedAgent, firstSchedule.prompt, thirdAt);
    assert.equal(store.listNotifications().length, 1, 'repeated unchanged failures stay quiet');
    assert.equal(notifications.filter(item => item.kind === 'failure').length, 1);
    const fourthAt = new Date(Date.parse(oneShot.scheduledAt) + 180_000).toISOString();
    await deliverDuplicate(restartedAgent, firstSchedule.prompt, fourthAt);
    assert.equal(notifications.at(-1)?.kind, 'recovery');
    assert.equal(store.listNotifications().length, 2, 'recovery is durably enqueued across the host restart');
    const fifthAt = new Date(Date.parse(oneShot.scheduledAt) + 240_000).toISOString();
    await deliverDuplicate(restartedAgent, firstSchedule.prompt, fifthAt);
    assert.equal(notifications.at(-1)?.kind, 'change');
    assert.equal(store.listNotifications().length, 3);
    assert.equal(second.modelRequests(), 0);
    assert.equal(adapter.calls, 0);

    await store.putWorkflow({ ...workflow, enabled: false, targets: [] });
    await second.handle.sync();
    const afterDisable = await second.ctx.schedule.catalog();
    assert.equal(afterDisable.some(entry => entry.id === restored.id && entry.status === 'active'), false,
      'disabling or clearing configured targets removes the durable DSH Schedule row');
  } finally {
    if (first !== undefined) {
      await first.handle.dispose().catch(() => undefined);
      await first.ctx.fiber.dispose().catch(() => undefined);
    }
    if (second !== undefined) {
      await second.handle.dispose().catch(() => undefined);
      await second.ctx.fiber.dispose().catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true });
  }
});
