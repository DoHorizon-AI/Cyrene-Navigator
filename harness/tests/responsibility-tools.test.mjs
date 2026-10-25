// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator responsibility command tests                       │
// │ Role: Verify owner-scoped duty lifecycle and provider usage reports. │
// │                                                                      │
// │ 模块职责：验证职责管理命令的所有者范围及真实用量回读。                 │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { registerResponsibilityTools } from '../dist/responsibility-tools.js';
import { InMemoryWorkflowStore } from '../dist/workflows/store.js';

const SESSION_ID = 'teams-session-derek';
const OWNER_TASK_ID = 'teams-owner-task';
const OWNER_THREAD_ID = 'a'.repeat(64);
const OWNER_PRINCIPAL = Object.freeze({
  issuer: 'https://login.microsoftonline.com/tenant-derek/v2.0',
  subject: 'derek-object-id',
  tenantId: 'tenant-derek',
});
const OTHER_PRINCIPAL = Object.freeze({
  issuer: 'https://login.microsoftonline.com/tenant-other/v2.0',
  subject: 'other-object-id',
  tenantId: 'tenant-other',
});
let invocationSequence = 0;

const TARGETS = [
  {
    id: '12345',
    label: 'DoHorizon-AI/Cyrene-Workspace',
    bindingId: 'github-binding-workspace',
    uri: 'https://github.com/DoHorizon-AI/Cyrene-Workspace',
    actionGrants: [
      {
        id: 'workspace-docs-draft',
        action: 'draft_pull_request',
        baseBranches: ['develop'],
        branchPrefixes: ['cyrene/assistant/'],
        pathPrefixes: ['docs/'],
        issueNumbers: [],
        sourceWorkflowIds: [],
        permittedOperations: [
          'github.branch.create',
          'github.file.commit',
          'github.pull_request.draft.create',
        ],
      },
      {
        id: 'workspace-source-ci',
        action: 'rerun_source_ci',
        baseBranches: [],
        branchPrefixes: ['cyrene/assistant/'],
        pathPrefixes: [],
        issueNumbers: [],
        sourceWorkflowIds: ['42'],
        permittedOperations: ['github.actions.rerun_failed'],
      },
    ],
  },
  {
    id: '67890',
    label: 'DoHorizon-AI/Cyrene-Navigator',
    bindingId: 'github-binding-navigator',
    uri: 'https://github.com/DoHorizon-AI/Cyrene-Navigator',
    actionGrants: [],
  },
];

function makeTask(id, principal, threadId, overrides = {}) {
  const thread = makeThread(threadId, principal);
  return {
    id,
    sessionId: SESSION_ID,
    prompt: 'Owner started this conversation.',
    status: 'running',
    executionClass: 'foreground',
    createdAt: 1_798_000_000_000,
    output: '',
    reasoning: '',
    durationMs: 0,
    workspaceId: 'cyrene-workspace',
    metadata: {
      teamsCaller: principal,
      teamsThread: {
        threadId,
        tenantId: thread.tenantId,
        teamId: thread.teamId,
        channelId: thread.channelId,
        conversationId: thread.conversationId,
        rootThreadId: thread.rootThreadId,
      },
    },
    ...overrides,
  };
}

function makeThread(threadId, principal) {
  return {
    threadId,
    tenantId: principal.tenantId,
    teamId: 'team-cyrene',
    channelId: 'channel-ai-notification',
    conversationId: `conversation-${threadId.slice(0, 8)}`,
    rootThreadId: 'root-message-1',
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    sessionId: SESSION_ID,
    messages: [],
  };
}

async function createTools({ directoryAuthorized = true, scheduleSyncWorks = true } = {}) {
  const store = new InMemoryWorkflowStore();
  let active = {
    task: makeTask(OWNER_TASK_ID, OWNER_PRINCIPAL, OWNER_THREAD_ID),
    principal: OWNER_PRINCIPAL,
    thread: makeThread(OWNER_THREAD_ID, OWNER_PRINCIPAL),
  };
  let isDirectoryAuthorized = directoryAuthorized;
  let canSyncSchedules = scheduleSyncWorks;
  const principalsByTask = new Map([
    [OWNER_TASK_ID, OWNER_PRINCIPAL],
    ['teams-other-owner', OTHER_PRINCIPAL],
  ]);
  const threadsById = new Map([
    [OWNER_THREAD_ID, makeThread(OWNER_THREAD_ID, OWNER_PRINCIPAL)],
    ['b'.repeat(64), makeThread('b'.repeat(64), OTHER_PRINCIPAL)],
  ]);
  const context = new Context();
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime);
  const usageReads = [];
  const dispose = registerResponsibilityTools(context, {
    workflows: store,
    resolveActiveOwner: async (sessionId, signal) => {
      signal.throwIfAborted();
      if (!isDirectoryAuthorized || active.task.sessionId !== sessionId) return undefined;
      return active;
    },
    authorizeWorkflowOwner: async (workflowId, principal, signal) => {
      signal.throwIfAborted();
      if (!isDirectoryAuthorized) return undefined;
      const workflow = (await store.listWorkflows(2)).find(row => row.id === workflowId);
      if (!workflow) return undefined;
      const ownerPrincipal = principalsByTask.get(workflow.authorization.ownerTaskId);
      const thread = threadsById.get(workflow.authorization.threadBindingId);
      if (!ownerPrincipal || !thread
        || ownerPrincipal.issuer !== principal.issuer
        || ownerPrincipal.subject !== principal.subject
        || ownerPrincipal.tenantId !== principal.tenantId) return undefined;
      return {
        workflow,
        ownerTask: makeTask(workflow.authorization.ownerTaskId, ownerPrincipal, thread.threadId, { status: 'completed' }),
        principal: ownerPrincipal,
        thread,
      };
    },
    readModelUsage: async taskId => {
      usageReads.push(taskId);
      return {
        taskId,
        routes: [{
          provider: 'antigravity',
          model: 'gemini-3.8-flash-medium',
          reportedCalls: 2,
          inputTokens: 40,
          outputTokens: 16,
          totalTokens: 56,
      }],
      };
    },
    syncWorkflows: async () => {
      if (!canSyncSchedules) throw new Error('fixture scheduler failure');
    },
    allowedTargets: TARGETS,
    modelPolicy: {
      preferredProvider: 'antigravity',
      preferredModel: 'gemini-3.8-flash-medium',
      fallback: 'configured_no_additional_spend',
    },
  });
  return {
    store,
    context,
    usageReads,
    setActive(value) { active = value; },
    setDirectoryAuthorized(value) { isDirectoryAuthorized = value; },
    setScheduleSyncWorks(value) { canSyncSchedules = value; },
    close() { dispose(); },
  };
}

async function invoke(context, name, args = {}, sessionId = SESSION_ID) {
  const result = await context.tools.execute({
    name,
    callId: ToolCallId(`responsibility-test-${++invocationSequence}`),
    arguments: args,
    signal: new AbortController().signal,
    agent: { id: 'responsibility-test-agent', session: { id: sessionId } },
  });
  if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join('\n'));
  return result.value;
}

test('owner can create, list, pause, resume, revise, inspect evidence, and read real usage', async () => {
  const fixture = await createTools();
  try {
    const available = await invoke(fixture.context, 'responsibility_repositories');
    assert.deepEqual(available.repositories, [
      { id: '12345', label: 'DoHorizon-AI/Cyrene-Workspace' },
      { id: '67890', label: 'DoHorizon-AI/Cyrene-Navigator' },
    ]);

    const created = await invoke(fixture.context, 'responsibility_create', {
      title: 'Keep Navigator delivery moving',
      goal: 'Track meaningful changes and prepare safe draft work.',
      repositoryIds: ['12345', '67890'],
    });
    assert.equal(created.created, true);
    assert.equal(created.schedule, 'synchronized');
    assert.equal(created.duty.enabled, true);
    assert.deepEqual(created.duty.repositories, [
      'DoHorizon-AI/Cyrene-Workspace',
      'DoHorizon-AI/Cyrene-Navigator',
    ]);
    const [workflow] = await fixture.store.listWorkflows(2);
    assert.equal(workflow.authorization.ownerTaskId, OWNER_TASK_ID);
    assert.equal(workflow.authorization.threadBindingId, OWNER_THREAD_ID);
    assert.deepEqual(workflow.actionPolicy.allowedActions.map(grant => grant.targetIds), [['12345'], ['12345']]);
    assert.deepEqual(workflow.actionPolicy.allowedActions[1].sourceWorkflowIds, ['42']);
    assert.equal(workflow.triggers[0].schedule.expression, '*/5 * * * *');
    assert.equal(workflow.modelPolicy.preferredModel, 'gemini-3.8-flash-medium');

    const listed = await invoke(fixture.context, 'responsibility_list');
    assert.equal(listed.duties.length, 1);
    const dutyId = listed.duties[0].id;

    const paused = await invoke(fixture.context, 'responsibility_pause', { dutyId });
    assert.equal(paused.duty.enabled, false);
    const resumed = await invoke(fixture.context, 'responsibility_resume', { dutyId });
    assert.equal(resumed.duty.enabled, true);
    const revised = await invoke(fixture.context, 'responsibility_update_goal', {
      dutyId,
      goal: 'Focus on current source CI and draft documentation changes.',
    });
    assert.equal(revised.duty.goal, 'Focus on current source CI and draft documentation changes.');
    assert.deepEqual(revised.duty.allowedActions, ['draft_pull_request', 'rerun_source_ci']);

    const occurrenceTaskId = `workflow-${'c'.repeat(40)}`;
    await fixture.store.appendScheduleEvent({
      id: 'workflow-event-fixture',
      workflowId: dutyId,
      scheduledAt: '2026-10-24T13:00:00.000Z',
      createdAt: '2026-10-24T13:00:00.000Z',
      status: 'succeeded',
      changed: true,
      summary: 'A source check changed; a draft was prepared.',
      taskId: occurrenceTaskId,
      triggerId: 'github-poll',
      evidence: [{
        targetId: '12345',
        tool: 'github.ci.status',
        observedAt: '2026-10-24T13:00:00.000Z',
        resultDigest: 'd'.repeat(64),
      }],
    });
    const status = await invoke(fixture.context, 'responsibility_status', { dutyId });
    assert.equal(status.events[0].status, 'succeeded');
    assert.equal(status.events[0].evidence[0].repository, 'DoHorizon-AI/Cyrene-Workspace');
    assert.equal(status.events[0].evidence[0].source, 'github.ci.status');

    const usage = await invoke(fixture.context, 'responsibility_usage', { dutyId });
    assert.equal(usage.source, 'durable_provider_reported_usage');
    assert.deepEqual(usage.routes, [{
      provider: 'antigravity',
      model: 'gemini-3.8-flash-medium',
      reportedCalls: 2,
      inputTokens: 40,
      outputTokens: 16,
      totalTokens: 56,
    }]);
    assert.deepEqual(fixture.usageReads, [occurrenceTaskId]);
  } finally {
    fixture.close();
  }
});

test('a scheduler sync failure reports that the duty persisted and reconciliation is pending', async () => {
  const fixture = await createTools({ scheduleSyncWorks: false });
  try {
    const result = await invoke(fixture.context, 'responsibility_create', {
      title: 'Persist before schedule sync',
      goal: 'Keep a durable duty even while the scheduler is temporarily unavailable.',
      repositoryIds: ['12345'],
    });
    assert.equal(result.created, true);
    assert.equal(result.schedule, 'pending_retry');
    assert.equal((await fixture.store.listWorkflows(2)).length, 1);
    fixture.setScheduleSyncWorks(true);
    const replay = await invoke(fixture.context, 'responsibility_create', {
      title: 'Persist before schedule sync',
      goal: 'Keep a durable duty even while the scheduler is temporarily unavailable.',
      repositoryIds: ['12345'],
    });
    assert.equal(replay.created, false);
    assert.equal(replay.schedule, 'synchronized');
    assert.equal((await fixture.store.listWorkflows(2)).length, 1);
  } finally {
    fixture.close();
  }
});

test('commands reject revoked owners, background tasks, foreign duties, and repositories outside host scope', async () => {
  const fixture = await createTools();
  try {
    await assert.rejects(invoke(fixture.context, 'responsibility_create', {
      title: 'Out of scope',
      goal: 'Try to reach an unconfigured repository.',
      repositoryIds: ['999999'],
    }), /host-configured allowlist/u);
    assert.equal((await fixture.store.listWorkflows(2)).length, 0);

    const created = await invoke(fixture.context, 'responsibility_create', {
      title: 'Owner only',
      goal: 'Track one configured repository.',
      repositoryIds: ['12345'],
    });
    const ownDutyId = created.duty.id;
    const foreignId = 'duty-foreign-owner';
    await fixture.store.putWorkflow({
      ...(await fixture.store.listWorkflows(2))[0],
      id: foreignId,
      authorization: { kind: 'teams_thread', threadBindingId: 'b'.repeat(64), ownerTaskId: 'teams-other-owner' },
    });
    await assert.rejects(invoke(fixture.context, 'responsibility_pause', { dutyId: foreignId }), /not authorized/u);

    const currentOwner = {
      task: makeTask(OWNER_TASK_ID, OWNER_PRINCIPAL, OWNER_THREAD_ID, { executionClass: 'background' }),
      principal: OWNER_PRINCIPAL,
      thread: makeThread(OWNER_THREAD_ID, OWNER_PRINCIPAL),
    };
    fixture.setActive(currentOwner);
    await assert.rejects(invoke(fixture.context, 'responsibility_pause', { dutyId: ownDutyId }), /authorized owner Teams conversation/u);

    fixture.setActive({
      task: makeTask(OWNER_TASK_ID, OWNER_PRINCIPAL, OWNER_THREAD_ID),
      principal: OWNER_PRINCIPAL,
      thread: makeThread(OWNER_THREAD_ID, OWNER_PRINCIPAL),
    });
    fixture.setDirectoryAuthorized(false);
    await assert.rejects(invoke(fixture.context, 'responsibility_list'), /authorized owner Teams conversation/u);
    assert.equal((await fixture.store.listWorkflows(2)).find(row => row.id === ownDutyId).enabled, true);
  } finally {
    fixture.close();
  }
});
