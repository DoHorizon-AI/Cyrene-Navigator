// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator deterministic workflow v3 hook tests               │
// │ Role: Prove bounded source events use DSH Schedule and Work receipts.│
// │ 模块职责：验证 v3 来源轮询由 DSH Schedule 驱动并写入 Work 回执。        │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { InMemoryWorkflowStore, registerWorkflowRuntime } from '../dist/workflows/index.js';

const OWNER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORKFLOW_ID = 'host-health-watch';
const TRIGGER_ID = 'health-poll';

class NoModelAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream() {
    if (this.emitImpossibleFinish === true) yield { type: 'finish', reason: { kind: 'stop' } };
    throw new Error('A deterministic source poll must never invoke model inference.');
  }
}

function workflow() {
  return {
    id: WORKFLOW_ID,
    version: 3,
    title: 'Host health watch',
    description: 'Observe one fixed host status binding.',
    targets: [{ id: 'host-main', label: 'Primary host', kind: 'host_health', bindingId: 'host-binding' }],
    triggers: [{
      id: TRIGGER_ID,
      kind: 'source_poll',
      source: 'vm_health',
      schedule: { kind: 'cron', expression: '* * * * *', timeZone: 'UTC' },
      targetIds: ['host-main'],
      initialBaseline: 'record_without_notification',
      pageSize: 10,
      maxPages: 2,
    }],
    authorization: { kind: 'owner_private', ownerTaskId: 'teams-owner-task' },
    notifications: {
      onChange: true,
      onFailure: true,
      onRecovery: true,
      quietWhenUnchanged: true,
      quietHours: { start: '22:00', end: '08:00', timeZone: 'America/New_York' },
      digest: {
        enabled: true,
        schedule: { kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'America/New_York' },
        maxPerDay: 1,
      },
      destination: { kind: 'owner_private' },
      immediateOn: ['blocked_goal', 'user_decision', 'service_or_auth_outage'],
    },
    enabled: true,
  };
}

function semanticFingerprint(value) {
  return value === 'healthy' ? 'a'.repeat(64) : 'b'.repeat(64);
}

function observation(request, state, occurredAt = Date.parse(request.windowEnd)) {
  return {
    source: 'vm_health',
    sourceEventId: `vm-health:host-main:${occurredAt}:${state}`,
    resourceUri: 'cyrene://vm-health/host-main',
    sourceVersion: `snapshot-${occurredAt}`,
    eventType: 'vm.health.snapshot',
    occurredAt,
    title: 'VM health snapshot',
    summary: `Host health ${state}.`,
    semanticFingerprint: semanticFingerprint(state),
    stateClass: state === 'healthy' ? 'healthy' : 'incident',
  };
}

async function deliverDshScheduleBatch(context, runtime, prompt, scheduledAts) {
  const agent = context.agents.get(SessionId(runtime.schedulerSessionId));
  assert.ok(agent, 'the existing DSH scheduler Session must own the reminder hook');
  await agent.whenIdle();
  const reminders = scheduledAts.map((occurrenceAt, index) => ({
    schedule_id: `workflow-runtime-fixture-${index}`,
    occurrence_at: occurrenceAt,
    reminder_prompt: prompt,
  }));
  const framed = [
    '[SCHEDULE REMINDER BATCH]',
    'This is a scheduled message from the user',
    `reminders_json: ${JSON.stringify(reminders)}`,
  ].join('\n');
  agent.followup(createUserMessage({
    source: { kind: 'schedule' },
    content: [{ type: 'text', text: framed }],
  }));
  await agent.whenIdle();
}

function addSeconds(timestamp, seconds) {
  return new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
}

test('v3 DSH hook records a silent baseline and emits one failure plus recovery around unchanged source state', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navigator-workflow-v3-'));
  const store = new InMemoryWorkflowStore();
  let context;
  let runtime;
  let pollCount = 0;
  let modelCalls = 0;
  const pageReceipts = [];
  const fixedTasks = [];
  const fixedErrors = [];
  const pollRequests = [];
  await store.putWorkflow(workflow());

  try {
    context = new Context();
    await context.plugin(LlmRuntime);
    await context.plugin(SessionStore);
    await context.plugin(SessionProjectionRegistry);
    await context.plugin(SystemPrompt);
    await context.plugin(ToolRuntime);
    await context.plugin(AgentRegistry);
    await context.plugin(SessionPersistenceJsonl, { root: join(directory, 'session-logs'), compression: 'none' });
    await context.plugin(AgentLoop, { agents: [] });
    context.llm.registerAdapter(['v3-no-model-proof'], new NoModelAdapter());

    runtime = await registerWorkflowRuntime(context, {
      store,
      storageRoot: join(directory, 'dsh-storage'),
      defaultWorkflows: [],
      reconcileEveryMs: 0,
      actorStores: [{ actorAadObjectId: OWNER_ID, store }],
      authorizeWorkflowActor: async (actorId, ownerTaskId) => actorId === OWNER_ID && ownerTaskId === 'teams-owner-task',
      executeTask: async () => {
        modelCalls += 1;
        throw new Error('V3 must not use executeTask/model execution.');
      },
      executeFixedToolTask: async (request, execute, actorAadObjectId) => {
        assert.equal(actorAadObjectId, OWNER_ID);
        assert.equal(request.metadata.source, 'workflow');
        assert.equal(request.metadata.workflowId, WORKFLOW_ID);
        fixedTasks.push(request);
        let output;
        try { output = await execute({}, new AbortController().signal); }
        catch (error) { fixedErrors.push(error instanceof Error ? error.stack : String(error)); throw error; }
        return {
          taskId: request.taskId,
          sessionId: request.sessionId,
          status: 'completed',
          output,
        };
      },
      sourceDrivers: [{
        source: 'vm_health',
        async pollPage(request) {
          pollRequests.push({ windowStart: request.windowStart, windowEnd: request.windowEnd, pageCursor: request.pageCursor });
          const observations = pollCount++ === 0
            ? [observation(request, 'healthy')]
            : [
              observation(request, 'healthy', Date.parse(request.windowStart) + 100),
              observation(request, 'incident', Date.parse(request.windowStart) + 200),
              observation(request, 'healthy', Date.parse(request.windowStart) + 300),
            ];
          return {
            source: 'vm_health',
            observedAt: Date.now(),
            pageCursor: request.pageCursor,
            nextCursor: null,
            complete: true,
            truncated: false,
            observations,
          };
        },
      }],
      recordSourcePageReceipt: async (_taskId, receipt) => { pageReceipts.push(receipt); },
    });

    const cron = (await context.schedule.catalog()).find(entry => entry.kind === 'cron' && entry.prompt.includes(WORKFLOW_ID));
    assert.ok(cron, 'v3 trigger should be installed in the existing DSH Schedule domain');

    const baselineAt = new Date(Date.now() + 5_000).toISOString();
    await deliverDshScheduleBatch(context, runtime, cron.prompt, [baselineAt]);
    assert.deepEqual(fixedErrors, [], JSON.stringify({ fixedErrors, pollRequests }));
    let events = (await store.listScheduleEvents({ workflowId: WORKFLOW_ID, limit: 100 })).items;
    const baseline = events.find(event => event.scheduledAt === baselineAt && event.status === 'succeeded');
    assert.ok(baseline, JSON.stringify(events));
    assert.equal(baseline.baseline, true);
    assert.equal(baseline.checkpoint.kind, 'source_poll');
    assert.equal(baseline.checkpoint.complete, true);
    assert.equal(store.listNotifications().length, 0, 'the initial source baseline must be silent');

    const transitionAt = addSeconds(baselineAt, 2);
    await deliverDshScheduleBatch(context, runtime, cron.prompt, [transitionAt]);
    events = (await store.listScheduleEvents({ workflowId: WORKFLOW_ID, limit: 100 })).items;
    const transition = events.find(event => event.scheduledAt === transitionAt && event.status === 'succeeded');
    assert.ok(transition, JSON.stringify(events));
    assert.equal(transition.baseline, false);
    const notifications = store.listNotifications();
    assert.equal(notifications.filter(item => item.type === 'workflow.failure').length, 1);
    assert.equal(notifications.filter(item => item.type === 'workflow.recovery').length, 1,
      'a return to the previously seen healthy fingerprint must recover after an intervening incident');
    assert.ok(pageReceipts.every(receipt => receipt.windowEnd && receipt.automationEventIds.length === 1));
    assert.equal(fixedTasks.length, 2);
    assert.equal(pollRequests.length, 2);
    assert.equal(modelCalls, 0);
  } finally {
    await runtime?.dispose();
    if (context !== undefined) await context.fiber.dispose().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('v3 DSH hook replays event POST and atomic intent after response-loss crash points', { timeout: 60_000 }, async () => {
  const workflowId = 'host-health-crash-watch';
  const directory = await mkdtemp(join(tmpdir(), 'navigator-workflow-v3-crash-'));
  const store = new InMemoryWorkflowStore();
  let context;
  let runtime;
  let failPageReceiptOnce = true;
  let loseIntentResponseOnce = true;
  let lastSourceEventId;
  const sourcePosts = [];
  const sourceIntentCalls = [];
  const taskReceipts = [];
  const fixedTasks = [];
  const fixedErrors = [];
  const schedulerPreSteps = [];
  const workflowDefinition = {
    ...workflow(),
    id: workflowId,
    title: 'Host health crash replay',
  };
  await store.putWorkflow(workflowDefinition);

  const appendAutomationEvent = store.appendAutomationEvent.bind(store);
  store.appendAutomationEvent = async event => {
    const receipt = await appendAutomationEvent(event);
    if (event.eventType === 'host.health.snapshot') {
      lastSourceEventId = receipt.event.id;
      sourcePosts.push({ sourceEventId: event.sourceEventId, duplicate: receipt.duplicate });
    }
    return receipt;
  };
  const enqueueAutomationEventNotice = store.enqueueAutomationEventNotice.bind(store);
  store.enqueueAutomationEventNotice = async request => {
    const receipt = await enqueueAutomationEventNotice(request);
    if (request.eventId === lastSourceEventId) {
      sourceIntentCalls.push({ eventId: request.eventId, duplicate: receipt.duplicate });
      if (loseIntentResponseOnce) {
        loseIntentResponseOnce = false;
        throw new Error('simulated lost Work event-intent response after commit');
      }
    }
    return receipt;
  };

  try {
    context = new Context();
    await context.plugin(LlmRuntime);
    await context.plugin(SessionStore);
    await context.plugin(SessionProjectionRegistry);
    await context.plugin(SystemPrompt);
    await context.plugin(ToolRuntime);
    await context.plugin(AgentRegistry);
    await context.plugin(SessionPersistenceJsonl, { root: join(directory, 'session-logs'), compression: 'none' });
    await context.plugin(AgentLoop, { agents: [] });
    context.llm.registerAdapter(['v3-crash-no-model'], new NoModelAdapter());
    context.on('agent/pre-step', async ({ agent, messages }, next) => {
      if (String(agent.id) === 'navigator-workflow-scheduler-v1') {
        schedulerPreSteps.push(messages.flatMap(message => message.content
          .flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n'));
      }
      return next();
    });

    runtime = await registerWorkflowRuntime(context, {
      store,
      storageRoot: join(directory, 'dsh-storage'),
      defaultWorkflows: [],
      reconcileEveryMs: 0,
      actorStores: [{ actorAadObjectId: OWNER_ID, store }],
      authorizeWorkflowActor: async (actorId, ownerTaskId) => actorId === OWNER_ID && ownerTaskId === 'teams-owner-task',
      executeTask: async () => { throw new Error('V3 must not enter the model path.'); },
      executeFixedToolTask: async (request, execute, actorAadObjectId) => {
        assert.equal(actorAadObjectId, OWNER_ID);
        fixedTasks.push(request);
        try {
          const output = await execute({}, new AbortController().signal);
          return { taskId: request.taskId, sessionId: request.sessionId, status: 'completed', output };
        } catch (error) {
          fixedErrors.push(error instanceof Error ? error.stack : String(error));
          return { taskId: request.taskId, sessionId: request.sessionId, status: 'failed', output: '' };
        }
      },
      sourceDrivers: [{
        source: 'vm_health',
        async pollPage(request) {
          const occurredAt = Date.parse(request.windowEnd);
          return {
            source: 'vm_health', observedAt: Date.now(), pageCursor: request.pageCursor,
            nextCursor: null, complete: true, truncated: false,
            observations: [{
              source: 'vm_health', sourceEventId: `vm-health:crash-host:${occurredAt}:stable-file`,
              resourceUri: 'cyrene://vm-health/crash-host', sourceVersion: 'same-file-version',
              eventType: 'host.health.snapshot', occurredAt, title: 'Host status', summary: 'Host is healthy.',
              semanticFingerprint: 'a'.repeat(64), stateClass: 'healthy',
            }],
          };
        },
      }],
      recordSourcePageReceipt: async (_taskId, receipt) => {
        taskReceipts.push(receipt);
        if (!('outcome' in receipt) && failPageReceiptOnce) {
          failPageReceiptOnce = false;
          throw new Error('simulated lost Work page-receipt response after event POST');
        }
      },
    });
    const cron = (await context.schedule.catalog()).find(entry => entry.kind === 'cron' && entry.prompt.includes(workflowId));
    assert.ok(cron);

    const batchStart = Date.now() + 1_000;
    const occurrenceTimes = [0, 1, 2].map(offset => new Date(batchStart + offset * 1_000).toISOString());
    await deliverDshScheduleBatch(context, runtime, cron.prompt, occurrenceTimes);

    const events = (await store.listScheduleEvents({ workflowId, limit: 100 })).items;
    const terminal = events.filter(event => occurrenceTimes.includes(event.scheduledAt)
      && (event.status === 'failed' || event.status === 'succeeded'));
    assert.equal(terminal.length, 3, JSON.stringify({ events, fixedTasks, fixedErrors, sourcePosts, sourceIntentCalls, taskReceipts, schedulerPreSteps }));
    assert.equal(terminal.filter(event => event.status === 'failed').length, 2,
      'the two injected response-loss points fail their occurrence without losing Work receipts');
    assert.ok(terminal.filter(event => event.status === 'failed').every(event =>
      event.checkpoint?.complete === false
      && event.checkpoint.sources[0].pageCursor === 'navigator-source-start-v1'
      && event.checkpoint.sources[0].watermark === null),
    'a failed in-flight page retains its original start cursor and does not advance the watermark');
    assert.equal(terminal.filter(event => event.status === 'succeeded').length, 1,
      'the next occurrence reconciles both committed receipts and writes its checkpoint');
    assert.equal(sourcePosts.length, 3);
    assert.deepEqual(sourcePosts.map(item => item.duplicate), [false, true, true],
      'event POST replay after a crash returns the same immutable event');
    assert.equal(new Set(sourcePosts.map(item => item.sourceEventId)).size, 1);
    assert.equal(sourceIntentCalls.length, 2);
    assert.deepEqual(sourceIntentCalls.map(item => item.duplicate), [false, true],
      'the atomic event intent commits once and is replayed after its response is lost');
    const failureReceipts = taskReceipts.filter(receipt => 'outcome' in receipt);
    assert.equal(failureReceipts.length, 2);
    assert.ok(failureReceipts.every(receipt => receipt.reasonCode === 'unavailable'));
    assert.equal(JSON.stringify(taskReceipts).includes('simulated lost'), false,
      'only a fixed failure code crosses the durable Work receipt boundary');
    const notifications = store.listNotifications();
    assert.equal(notifications.filter(item => item.type === 'workflow.failure').length, 1);
    assert.equal(notifications.filter(item => item.type === 'workflow.recovery').length, 1);
    assert.equal(JSON.stringify(notifications).includes('simulated lost'), false);
    assert.equal(fixedTasks.length, 3);
  } finally {
    await runtime?.dispose();
    if (context !== undefined) await context.fiber.dispose().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
