// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator proactive workflow v2 fixture                     │
// │ Role: Prove trusted GitHub receipts gate multi-repository checkpoints.│
// │ 模块职责：验证多仓库轮询只使用可信 GitHub 回执推进检查点。             │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { SessionId } from '@deepseek-ai/dsh-session';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import {
  InMemoryWorkflowStore,
  registerWorkflowRuntime,
  resolveWorkflowReadonlyPolicy,
} from '../dist/workflows/index.js';
import { getConnectorToolCatalog, registerToolProviders } from '../dist/tool-providers.js';

const WORKFLOW_ID = 'multi-repo-patrol';
const TRIGGER_ID = 'github-poll';
const BINDING_ID = 'github-binding-fixture';
const CONNECTION_REF = 'github-connection-fixture';
const PROFILE_REF = 'github-profile-fixture';
const TOOL_ID = 'github.issues.search';
const REPOSITORIES = [
  { id: '111111111', label: 'DoHorizon-AI/Cyrene-Workspace' },
  { id: '222222222', label: 'DoHorizon-AI/Cyrene-Navigator' },
];
const OWNER = {
  issuer: 'https://login.microsoftonline.com/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/v2.0',
  subject: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    repository_id: { type: 'integer', minimum: 1 },
    repository: { type: 'string', minLength: 1 },
    state: { type: 'string', enum: ['open', 'closed', 'all'] },
    query: { type: 'string' },
    labels: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    updated_since: { type: 'string' },
    updated_until: { type: 'string' },
    page_cursor: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
  },
  required: ['repository_id', 'repository', 'state', 'labels', 'limit', 'updated_until', 'page_cursor'],
  additionalProperties: false,
};

class NoModelAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream() {
    throw new Error('The scheduler inbox must not reach model inference.');
  }
}

function workflow() {
  const pollCron = cronAtLeastTenMinutesAhead('UTC');
  const digestCron = cronAtLeastTenMinutesAhead('America/New_York');
  return {
    id: WORKFLOW_ID,
    version: 2,
    title: 'Repository patrol',
    description: 'Inspect configured GitHub repositories.',
    goal: 'Find meaningful new GitHub issue activity.',
    instructions: 'Observe source state and report only changes supported by provider data.',
    targets: REPOSITORIES.map(repository => ({
      ...repository,
      kind: 'github_repository',
      bindingId: BINDING_ID,
      uri: `https://github.com/${repository.label}`,
    })),
    triggers: [{
      id: TRIGGER_ID,
      kind: 'github_incremental_poll',
      schedule: { kind: 'cron', expression: pollCron, timeZone: 'UTC' },
      targetIds: REPOSITORIES.map(repository => repository.id),
      initialBaseline: 'record_without_notification',
      search: { state: 'open', labels: [], limit: 50 },
    }],
    actionPolicy: {
      allowedActions: [],
      separateChildTask: true,
      productionChanges: 'forbidden',
      requiresUserAuthorization: ['merge', 'release', 'production', 'new_spend'],
    },
    modelPolicy: {
      preferredProvider: 'antigravity',
      preferredModel: 'gemini-3.8-flash-medium',
      fallback: 'configured_no_additional_spend',
    },
    authorization: { kind: 'teams_thread', threadBindingId: 'teams-root-thread', ownerTaskId: 'teams-owner-task' },
    notifications: {
      onChange: true,
      onFailure: true,
      onRecovery: true,
      quietWhenUnchanged: true,
      quietHours: { start: '22:00', end: '08:00', timeZone: 'America/New_York' },
      digest: {
        enabled: true,
        schedule: { kind: 'cron', expression: digestCron, timeZone: 'America/New_York' },
        maxPerDay: 1,
      },
      destination: { kind: 'responsibility_thread' },
      immediateOn: ['blocked_goal', 'user_decision', 'service_or_auth_outage'],
    },
    enabled: true,
  };
}

function cronAtLeastTenMinutesAhead(timeZone) {
  const target = new Date(Date.now() + 10 * 60_000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    minute: 'numeric',
    hour: 'numeric',
    day: 'numeric',
    month: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(target);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.minute} ${fields.hour} ${fields.day} ${fields.month} *`;
}

function connectorSnapshot() {
  return {
    schemaVersion: 1,
    items: [{
      bindingId: BINDING_ID,
      capabilityId: 'tool.provider.v1',
      providerId: 'github',
      connectionRef: CONNECTION_REF,
      profileRef: PROFILE_REF,
      tools: [{
        id: TOOL_ID,
        name: 'Search GitHub issues',
        description: 'Search a bounded GitHub issue window.',
        readOnly: true,
        inputSchema: SEARCH_SCHEMA,
      }],
    }],
  };
}

function connectorAuthorization(providerRequests) {
  return {
    workspaceId: 'workspace-fixture',
    client: {
      async mintGrant(request) { return { request }; },
      async callProviderOperation(request) {
        providerRequests.push(request.arguments);
        const repoId = String(request.arguments.repository_id);
        const firstRepository = repoId === REPOSITORIES[0].id;
        const pageCursor = String(request.arguments.page_cursor);
        const issues = firstRepository
          ? [{ number: 19, updated_at: '2026-10-24T12:00:00Z' }]
          : Array.from({ length: pageCursor === '1' ? 50 : 10 }, (_, index) => ({
            number: 100 + index,
            updated_at: '2026-10-24T12:00:00Z',
          }));
        const result = firstRepository
          ? {
            issues,
            total_count: 1,
            page_cursor: pageCursor,
            truncated: false,
            complete: true,
            incomplete_results: false,
            result_limit_reached: false,
            next_cursor: null,
          }
          : pageCursor === '1'
          ? {
            issues,
            total_count: 60,
            page_cursor: pageCursor,
            truncated: true,
            complete: false,
            incomplete_results: false,
            result_limit_reached: false,
            next_cursor: '2',
          }
          : {
            issues,
            total_count: 60,
            page_cursor: pageCursor,
            truncated: true,
            complete: false,
            incomplete_results: false,
            result_limit_reached: false,
            next_cursor: null,
          };
        return {
          requestId: request.requestId,
          outcome: 'verified',
          result: { content: [{ type: 'text', text: 'GitHub issue search fixture.' }], structuredContent: result },
        };
      },
    },
    bindings: new Map([[BINDING_ID, {
      bindingId: BINDING_ID,
      connectionRef: CONNECTION_REF,
      providerId: 'github',
      profileRef: PROFILE_REF,
      tools: [{
        toolId: TOOL_ID,
        operationId: TOOL_ID,
        resourceProjection: 'github_repository',
        mutating: false,
      }],
    }]]),
  };
}

async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(message);
}

async function deliverOccurrence(agent, prompt, scheduledAt) {
  const framed = [
    '[SCHEDULE REMINDER BATCH]',
    'This is a scheduled message from the user',
    `reminders_json: ${JSON.stringify([{ schedule_id: 'resume-fixture', occurrence_at: scheduledAt, reminder_prompt: prompt }])}`,
  ].join('\n');
  agent.followup(createUserMessage({
    source: { kind: 'schedule' },
    content: [{ type: 'text', text: framed }],
  }));
  await agent.whenIdle();
}

test('v2 poll matches every repository and never advances from an incomplete provider page', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navigator-workflow-v2-'));
  const store = new InMemoryWorkflowStore();
  const requests = [];
  let context;
  let activeTask;
  let providers;
  let runtime;
  let pollWindowEnd;
  let executionAgent;
  const providerResults = [];
  const providerRequests = [];
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
    context.llm.registerAdapter(['workflow-v2-proof'], new NoModelAdapter());

    const bridge = {
      async request(path) {
        if (path.startsWith('/tasks/')) {
          assert.ok(activeTask);
          return {
            id: activeTask.taskId,
            sessionId: activeTask.sessionId,
            prompt: activeTask.prompt,
            status: 'running',
            createdAt: 1,
            output: '',
            reasoning: '',
            durationMs: 0,
            executionClass: 'background',
            metadata: activeTask.metadata,
          };
        }
        if (path.startsWith('/operations/unresolved?')) return { items: [] };
        throw new Error(`Unexpected fixture Work request: ${path}`);
      },
      async requestApproval() { throw new Error('Read-only poll must not request approval.'); },
      async mutate() { throw new Error('Read-only poll must not mutate Work state.'); },
    };
    providers = await registerToolProviders(context, {
      bridge,
      taskIdForSession: sessionId => activeTask?.sessionId === sessionId ? activeTask.taskId : undefined,
      connectorAuthorization: connectorAuthorization(providerRequests),
      connectorToolCatalogSnapshot: connectorSnapshot(),
      backgroundTaskAuthority: async () => OWNER,
    });
    const registeredCatalog = getConnectorToolCatalog(context);
    assert.equal(registeredCatalog.length, 1);
    assert.equal(registeredCatalog[0].operationId, TOOL_ID);
    assert.equal(registeredCatalog[0].mutating, false);
    const searchTool = context.tools.schemas().find(schema => schema.description.includes(`configured provider ${BINDING_ID}`));
    assert.ok(searchTool, 'the real provider registration path should expose the GitHub search schema');
    context.on('tools/result', (execution, result) => {
      if (execution.name === searchTool.name) providerResults.push(result);
    });

    runtime = await registerWorkflowRuntime(context, {
      store,
      storageRoot: join(directory, 'dsh-storage'),
      defaultWorkflows: [],
      reconcileEveryMs: 0,
      executeTask: async request => {
        requests.push(request);
        activeTask = request;
        executionAgent ??= (await context.agents.create({ sessionId: SessionId(request.sessionId) })).agent;
        pollWindowEnd ??= new Date(request.metadata.scheduledAt).toISOString().slice(0, 19) + 'Z';
        const resumeAttempt = requests.length > 1;
        for (const [index, repository] of REPOSITORIES.entries()) {
          const pageCursor = resumeAttempt && index === 1 ? '2' : '1';
          const result = await context.tools.execute({
            name: searchTool.name,
            callId: ToolCallId(`${repository.id}-${requests.length}`),
            arguments: {
              repository_id: Number(repository.id),
              repository: repository.label,
              state: 'open',
              labels: [],
              limit: 50,
              updated_until: pollWindowEnd,
              page_cursor: pageCursor,
            },
            signal: new AbortController().signal,
            agent: executionAgent,
          });
          assert.equal(result.isError, false, `repository ${repository.label} should pass the active readonly guard`);
        }
        return {
          taskId: request.taskId,
          sessionId: request.sessionId,
          status: 'completed',
          output: JSON.stringify({
            changed: true,
            summary: 'The model claims every repository changed, despite one truncated provider page.',
            actionRequests: [],
          }),
        };
      },
    });

    const policy = resolveWorkflowReadonlyPolicy(context, await store.listWorkflows(2).then(items => items[0]));
    assert.equal(policy.supported, true);
    assert.equal(policy.observationTargets.length, 2);
    const schedule = (await context.schedule.catalog()).find(entry => entry.title === 'Repository patrol · github-poll');
    assert.ok(schedule, 'the v2 trigger should be persisted by the DSH Schedule service');
    const oneShot = await context.schedule.create(SessionId(runtime.schedulerSessionId), {
      title: 'Exercise v2 multi-repository poll',
      prompt: schedule.prompt,
      after_seconds: 1,
    });
    await waitFor(async () => (await store.listScheduleEvents({ workflowId: WORKFLOW_ID, limit: 100 })).items
      .some(event => event.scheduledAt === oneShot.scheduledAt && ['succeeded', 'failed'].includes(event.status)),
    'v2 DSH timer did not finish the fixture observation');

    assert.equal(requests.length, 1);
    assert.equal(requests[0].executionClass, 'background');
    assert.equal(requests[0].metadata.source, 'workflow');
    const events = (await store.listScheduleEvents({ workflowId: WORKFLOW_ID, limit: 100 })).items;
    const terminal = events.find(event => event.scheduledAt === oneShot.scheduledAt
      && ['succeeded', 'failed'].includes(event.status));
    assert.ok(terminal, JSON.stringify(events));
    assert.equal(terminal.status, 'succeeded', JSON.stringify(terminal));
    assert.equal(terminal.baseline, true);
    assert.equal(terminal.changed, false, 'model-authored changed=true must not override incomplete source evidence');
    assert.equal(terminal.checkpoint.complete, false);
    assert.equal(terminal.checkpoint.watermark, null, 'a partial repository chain cannot advance the host watermark');
    assert.deepEqual(terminal.checkpoint.repositories.map(cursor => cursor.targetId).sort(), REPOSITORIES.map(repo => repo.id).sort());
    assert.equal(
      terminal.checkpoint.repositories.find(cursor => cursor.targetId === REPOSITORIES[0].id).complete,
      true,
      JSON.stringify({ checkpoint: terminal.checkpoint, providerResults }),
    );
    const truncated = terminal.checkpoint.repositories.find(cursor => cursor.targetId === REPOSITORIES[1].id);
    assert.equal(truncated.complete, false);
    assert.equal(truncated.pageCursor, '2');
    assert.equal(truncated.pagesCollected, 1);
    assert.equal(truncated.totalCount, 60);
    assert.equal(requests.length, 1, 'the same responsibility occurrence executes once');

    const resumedAt = new Date(Date.parse(oneShot.scheduledAt) + 60_000).toISOString();
    const scheduler = context.agents.get(SessionId(runtime.schedulerSessionId));
    assert.ok(scheduler);
    await deliverOccurrence(scheduler, schedule.prompt, resumedAt);
    const resumedEvents = (await store.listScheduleEvents({ workflowId: WORKFLOW_ID, limit: 100 })).items;
    const resumed = resumedEvents.find(event => event.scheduledAt === resumedAt
      && ['succeeded', 'failed'].includes(event.status));
    assert.ok(resumed, JSON.stringify(resumedEvents));
    assert.equal(resumed.status, 'succeeded', JSON.stringify(resumed));
    assert.equal(resumed.checkpoint.complete, true);
    assert.equal(resumed.checkpoint.watermark, terminal.checkpoint.windowEnd);
    assert.deepEqual(resumed.checkpoint.repositories, []);
    assert.equal(resumed.baseline, true, 'the first complete window establishes the quiet baseline');
    assert.equal(resumed.changed, false, 'initial historical changes remain quiet');
    assert.equal(requests.length, 2);
    assert.equal(providerRequests.length, 4, 'both targets must be observed and the pending page resumes');
    assert.equal(String(providerRequests[3].repository_id), REPOSITORIES[1].id);
    assert.equal(providerRequests[3].page_cursor, '2');
    assert.equal(providerRequests[3].updated_until, terminal.checkpoint.windowEnd);
  } finally {
    if (runtime !== undefined) await runtime.dispose().catch(() => undefined);
    providers?.();
    if (context !== undefined) await context.fiber.dispose().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
