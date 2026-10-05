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
import { performance } from 'node:perf_hooks';
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
  resolveWorkflowReadonlyPolicy,
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
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(message);
}

async function eventsFor(store) {
  return eventsForId(store, WORKFLOW_ID);
}

async function eventsForId(store, workflowId) {
  return (await store.listScheduleEvents({ workflowId, limit: 100 })).items;
}

function createReadonlyFixtureRegistry(getLearnStatus) {
  const learnTools = [{
    name: 'mcp__microsoft_learn__search', description: 'Fixture documentation search.', parameters: {},
  }];
  return {
    list: () => [],
    get: id => id === 'microsoft-learn' ? {
      id, name: 'Microsoft Learn fixture', kind: 'mcp', status: getLearnStatus(),
      source: { publisher: 'Microsoft', endpoint: 'https://learn.microsoft.com/api/mcp', documentation: 'https://learn.microsoft.com/en-us/training/support/mcp' },
      description: 'Local readonly workflow fixture.', tools: learnTools,
    } : undefined,
    workflowReadonlyTools: id => id === 'microsoft-learn'
      ? getLearnStatus() === 'available' ? ['mcp__microsoft_learn__search'] : []
      : id === 'google-cloud-readonly' ? ['gcloud_readonly'] : [],
    workflowReadonlyProjectIds: id => id === 'google-cloud-readonly' ? ['alpha-project', 'beta-project'] : [],
  };
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
  const workflow = {
    id: 'workflow-policy', version: 1, title: 'Read only policy', description: 'test', instructions: 'inspect',
    targets: [
      { id: 'microsoft-learn', label: 'Microsoft Learn', kind: 'cloud-connection' },
      { id: 'alpha-project', label: 'Alpha project', kind: 'google-cloud-project' },
    ],
    notifications: { onChange: true, onFailure: true, onRecovery: true, quietWhenUnchanged: true },
    enabled: true, updatedAt: new Date().toISOString(),
  };
  const policy = resolveWorkflowReadonlyPolicy(host.ctx, workflow);
  assert.equal(policy.supported, true);
  const dispose = installWorkflowReadonlyGuard(host.ctx, policy, String(activeHandle.agent.session.id));
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

test('official DSH Schedule source requires receipts for every target and remains idempotent after restart', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navigator-workflow-runtime-'));
  const store = new InMemoryWorkflowStore();
  const adapter = new CountingAdapter();
  const taskOutcomes = new Map();
  let learnStatus = 'available';
  const plannedOutcomes = [
    { status: 'completed', observation: 'success', output: JSON.stringify({ changed: false, summary: 'No configured resource changed.' }) },
    { status: 'completed', observation: 'memory', output: JSON.stringify({ changed: false, summary: 'healthy' }) },
    { status: 'completed', observation: 'error', output: JSON.stringify({ changed: false, summary: 'healthy' }) },
    { status: 'completed', observation: 'none', output: JSON.stringify({ changed: false, summary: 'healthy' }) },
    { status: 'completed', observation: 'partial', output: JSON.stringify({ changed: false, summary: 'healthy' }) },
    { status: 'completed', observation: 'success', output: JSON.stringify({ changed: false, summary: 'The read completed after recovery.' }) },
    { status: 'completed', observation: 'success', output: JSON.stringify({ changed: true, summary: 'The configured target changed.' }) },
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
    if (workflowContext !== undefined) {
      const executionAgent = await workflowContext.agents.create({ sessionId: SessionId(request.sessionId) });
      if (executionStarts.length === 1) {
        const blockedWrite = await workflowContext.tools.execute({
          name: 'work_notify',
          arguments: { deduplicationKey: 'malicious', type: 'external.write', payload: { text: 'send' } },
          callId: ToolCallId('workflow-malicious-write'),
          signal: new AbortController().signal,
          agent: executionAgent.agent,
        });
        assert.equal(blockedWrite.isError, true, 'the executing workflow model request must be denied before tool dispatch');
      }
      const observe = async (name, args, suffix) => workflowContext.tools.execute({
        name, arguments: args, callId: ToolCallId(`${request.taskId}-${suffix}`),
        signal: new AbortController().signal, agent: executionAgent.agent,
      });
      if (next.observation === 'memory') {
        await observe('work_sources', {}, 'memory');
      } else if (['error', 'partial', 'success'].includes(next.observation)) {
        if (next.observation === 'error') learnStatus = 'degraded';
        const docs = await observe('mcp__microsoft_learn__search', { fail: next.observation === 'error' }, 'docs');
        assert.equal(docs.isError, next.observation === 'error', 'only a successful readonly receipt should count as observation');
        if (next.observation !== 'error') {
          learnStatus = 'available';
          await observe('gcloud_readonly', { operation: 'projects.describe', projectId: 'alpha-project' }, 'alpha');
          if (next.observation !== 'partial') {
            await observe('gcloud_readonly', { operation: 'projects.describe', projectId: 'beta-project' }, 'beta');
          }
        }
      }
    }
    const { observation: _observation, ...plannedOutcome } = next;
    const outcome = { taskId: request.taskId, sessionId: request.sessionId, ...plannedOutcome };
    taskOutcomes.set(request.taskId, outcome);
    return outcome;
  };
  const workflow = {
    id: WORKFLOW_ID,
    version: 1,
    title: 'Configured cloud snapshot',
    description: 'Check one documentation target and two explicitly configured Google projects.',
    instructions: 'Report the configured target state without changing it.',
    targets: [
      { id: 'microsoft-learn', label: 'Microsoft Learn', kind: 'cloud-connection' },
      { id: 'alpha-project', label: 'Alpha project', kind: 'google-cloud-project' },
      { id: 'beta-project', label: 'Beta project', kind: 'google-cloud-project' },
    ],
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
    first.ctx.provide('cloudConnections', createReadonlyFixtureRegistry(() => learnStatus));
    first.ctx.tools.register(defineTool({
      name: 'work_sources', description: 'Read source inventory health.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'all configured sources appear healthy',
    }));
    first.ctx.tools.register(defineTool({
      name: 'mcp__microsoft_learn__search', description: 'Search official documentation.',
      parameters: { fail: { type: 'boolean' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async args => {
        if (args.fail) throw new Error('fixture readonly transport failure');
        return 'Observed the configured official documentation target.';
      },
    }));
    first.ctx.tools.register(defineTool({
      name: 'gcloud_readonly', description: 'Inspect one fixed Google Cloud project operation.',
      parameters: { operation: { type: 'string' }, projectId: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async args => args.projectId,
    }));
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
    workflowContext = second.ctx;
    second.ctx.provide('cloudConnections', createReadonlyFixtureRegistry(() => learnStatus));
    second.ctx.tools.register(defineTool({
      name: 'work_sources', description: 'Read source inventory health.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'all configured sources appear healthy',
    }));
    second.ctx.tools.register(defineTool({
      name: 'mcp__microsoft_learn__search', description: 'Search official documentation.',
      parameters: { fail: { type: 'boolean' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async args => {
        if (args.fail) throw new Error('fixture readonly transport failure');
        return 'Observed the configured official documentation target.';
      },
    }));
    second.ctx.tools.register(defineTool({
      name: 'gcloud_readonly', description: 'Inspect one fixed Google Cloud project operation.',
      parameters: { operation: { type: 'string' }, projectId: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async args => args.projectId,
    }));
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
    // durable terminal occurrence receipt prevents a second run from starting.
    await deliverDuplicate(restartedAgent, firstSchedule.prompt, oneShot.scheduledAt);
    assert.equal(executionStarts.length, 1);
    assert.equal(executorRequests.length, 1);
    assert.equal(second.modelRequests(), 0);
    assert.equal(adapter.calls, 0);
    const duplicateEvents = (await eventsFor(store)).filter(event => event.scheduledAt === oneShot.scheduledAt);
    assert.deepEqual(duplicateEvents.map(event => event.status).sort(), ['queued', 'running', 'succeeded']);

    const secondAt = new Date(Date.parse(oneShot.scheduledAt) + 60_000).toISOString();
    await deliverDuplicate(restartedAgent, firstSchedule.prompt, secondAt);
    assert.equal(notifications.at(-1)?.kind, 'failure');
    assert.equal(store.listNotifications().length, 1, 'a failure transition is durably queued before observation');
    assert.equal((await eventsFor(store)).find(event => event.scheduledAt === secondAt && event.status === 'failed')?.errorCode, 'WORKFLOW_OBSERVATION_REQUIRED',
      'memory lookup alone cannot prove any configured cloud target');
    await deliverDuplicate(restartedAgent, firstSchedule.prompt, secondAt);
    assert.equal(store.listNotifications().length, 1, 'a duplicate occurrence reuses its durable deduplication key');
    assert.equal(notifications.filter(item => item.kind === 'failure').length, 1,
      'a duplicate occurrence emits no second observation');
    const thirdAt = new Date(Date.parse(oneShot.scheduledAt) + 120_000).toISOString();
    await deliverDuplicate(restartedAgent, firstSchedule.prompt, thirdAt);
    assert.equal(store.listNotifications().length, 1, 'failed observation tool calls do not count and repeated failure stays quiet');
    assert.equal(notifications.filter(item => item.kind === 'failure').length, 1);
    assert.equal((await eventsFor(store)).find(event => event.scheduledAt === thirdAt && event.status === 'failed')?.errorCode, 'WORKFLOW_OBSERVATION_REQUIRED');
    const fourthAt = new Date(Date.parse(oneShot.scheduledAt) + 180_000).toISOString();
    await deliverDuplicate(restartedAgent, firstSchedule.prompt, fourthAt);
    assert.equal(store.listNotifications().length, 1, 'healthy output without any target observation remains failed');
    assert.equal((await eventsFor(store)).find(event => event.scheduledAt === fourthAt && event.status === 'failed')?.errorCode, 'WORKFLOW_OBSERVATION_REQUIRED');
    const fifthAt = new Date(Date.parse(oneShot.scheduledAt) + 240_000).toISOString();
    await deliverDuplicate(restartedAgent, firstSchedule.prompt, fifthAt);
    assert.equal((await eventsFor(store)).find(event => event.scheduledAt === fifthAt && event.status === 'failed')?.errorCode, 'WORKFLOW_OBSERVATION_REQUIRED',
      'observing only one of two projects sharing gcloud_readonly must fail');
    assert.equal(store.listNotifications().length, 1, 'missing a target receipt stays within the quiet repeated-failure transition');
    const sixthAt = new Date(Date.parse(oneShot.scheduledAt) + 300_000).toISOString();
    await deliverDuplicate(restartedAgent, firstSchedule.prompt, sixthAt);
    assert.equal(notifications.at(-1)?.kind, 'recovery');
    assert.equal(store.listNotifications().length, 2, 'observed recovery is durably enqueued across the host restart');
    const seventhAt = new Date(Date.parse(oneShot.scheduledAt) + 360_000).toISOString();
    await deliverDuplicate(restartedAgent, firstSchedule.prompt, seventhAt);
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

test('unsupported, unknown, and credential-missing targets fail before executor dispatch', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navigator-workflow-preflight-'));
  const store = new InMemoryWorkflowStore();
  const adapter = new CountingAdapter();
  const executorRequests = [];
  const workflowTargets = [
    { workflowId: 'workflow-hf-preflight', title: 'HF preflight', target: { id: 'huggingface', label: 'Hugging Face', kind: 'cloud-connection' } },
    { workflowId: 'workflow-unknown-preflight', title: 'Unknown preflight', target: { id: 'unknown-vendor', label: 'Unknown vendor', kind: 'cloud-connection' } },
    { workflowId: 'workflow-auth-preflight', title: 'Auth preflight', target: { id: 'microsoft-learn', label: 'Microsoft Learn', kind: 'cloud-connection' } },
  ];
  const notifications = [];
  const enqueue = store.enqueueNotification.bind(store);
  let outboxInterrupted = false;
  store.enqueueNotification = async request => {
    if (!outboxInterrupted && request.payload.workflowId === 'workflow-hf-preflight') {
      outboxInterrupted = true;
      throw new Error('fixture outbox transport interrupted');
    }
    return enqueue(request);
  };
  let host;

  try {
    for (const item of workflowTargets) {
      await store.putWorkflow({
        id: item.workflowId, version: 1, title: item.title, description: 'Verify fail-closed workflow preflight.',
        instructions: 'Inspect the configured target without changing it.', targets: [item.target],
        notifications: { onChange: true, onFailure: true, onRecovery: true, quietWhenUnchanged: true },
        enabled: true, schedule: { kind: 'cron', expression: '0 0 1 1 *', timeZone: 'UTC' },
      });
    }
    host = await createHost(directory, store, async request => {
      executorRequests.push(request);
      return { taskId: request.taskId, sessionId: request.sessionId, status: 'completed',
        output: JSON.stringify({ changed: false, summary: 'healthy' }) };
    }, adapter);
    host.ctx.provide('cloudConnections', {
      list: () => [],
      get: id => id === 'microsoft-learn' ? {
        id, name: 'Microsoft Learn', kind: 'mcp', status: 'missing-credential',
        source: { publisher: 'Microsoft', endpoint: 'https://learn.microsoft.com/api/mcp', documentation: 'https://learn.microsoft.com/en-us/training/support/mcp' },
        description: 'Credential is not configured.', tools: [],
      } : id === 'huggingface' ? {
        id, name: 'Hugging Face', kind: 'mcp', status: 'available',
        source: { publisher: 'Hugging Face', endpoint: 'https://huggingface.co/mcp', documentation: 'https://huggingface.co/docs/hub/agents-mcp' },
        description: 'Interactive tools are available.', tools: [{ name: 'mcp__huggingface__model_search', description: 'Search models.', parameters: {} }],
      } : undefined,
      workflowReadonlyTools: id => id === 'huggingface' ? ['mcp__huggingface__model_search'] : [],
      workflowReadonlyProjectIds: () => [],
    });
    host.ctx.on('workflow/notification', notification => {
      assert.equal(store.listNotifications().length, notifications.length + 1,
        'preflight failure notification follows its durable outbox receipt');
      notifications.push(notification);
    });

    const recurring = await host.ctx.schedule.catalog();
    const oneShots = await Promise.all(workflowTargets.map(item => {
      const source = recurring.find(entry => entry.kind === 'cron' && entry.title === item.title);
      assert.ok(source, `DSH cron row exists for ${item.workflowId}`);
      return host.ctx.schedule.create(SessionId(SCHEDULER_SESSION_ID), {
        title: `Preflight trigger ${item.workflowId}`, prompt: source.prompt, after_seconds: 1,
      }).then(oneShot => ({ ...item, prompt: source.prompt, oneShot }));
    }));
    for (const item of oneShots) {
      await waitFor(async () => (await eventsForId(store, item.workflowId))
        .some(event => event.scheduledAt === item.oneShot.scheduledAt && event.status === 'failed'),
      `preflight did not reject ${item.workflowId}`);
    }

    const scheduler = host.ctx.agents.get(SessionId(SCHEDULER_SESSION_ID));
    assert.ok(scheduler);
    await scheduler.whenIdle();
    assert.equal(executorRequests.length, 0, 'the executor and model must not run for unclassified or unauthenticated targets');
    assert.equal(host.modelRequests(), 0);
    assert.equal(adapter.calls, 0);
    assert.equal(outboxInterrupted, true);
    assert.equal(store.listNotifications().length, 2, 'the failed outbox write is not falsely acknowledged');
    await host.handle.sync();
    assert.equal(store.listNotifications().length, 3);
    assert.equal(notifications.length, 3);
    await host.handle.sync();
    assert.equal(store.listNotifications().length, 3, 'durable terminal evidence retries one missing outbox item without replaying execution');
    assert.equal(notifications.length, 3);
    for (const item of oneShots) {
      const events = await eventsForId(store, item.workflowId);
      assert.deepEqual(events.map(event => event.status), ['failed'], 'failed target preflight never enters queued or running execution');
      assert.equal(events[0]?.errorCode, 'WORKFLOW_READONLY_TARGET_UNAVAILABLE');
      await deliverDuplicate(scheduler, item.prompt, item.oneShot.scheduledAt);
      assert.equal((await eventsForId(store, item.workflowId)).length, 1, 'duplicate preflight delivery reuses its terminal occurrence receipt');
    }

    const repeated = oneShots[2];
    const laterAt = new Date(Date.parse(repeated.oneShot.scheduledAt) + 60_000).toISOString();
    await deliverDuplicate(scheduler, repeated.prompt, laterAt);
    assert.equal((await eventsForId(store, repeated.workflowId)).length, 2);
    assert.equal(store.listNotifications().length, 3, 'an unchanged repeated preflight failure stays quiet');
    assert.equal(executorRequests.length, 0);
    assert.equal(host.modelRequests(), 0);
  } finally {
    if (host !== undefined) {
      await host.handle.dispose().catch(() => undefined);
      await host.ctx.fiber.dispose().catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true });
  }
});
