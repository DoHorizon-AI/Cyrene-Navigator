// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator responsibility authorization tests                 │
// │ Role: Verify background connector scope and Teams outbox projection. │
// │                                                                      │
// │ 模块职责：验证后台连接器授权范围与 Teams 通知路由。                    │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { canonicalJson } from '../dist/connector-authorization.js';
import {
  createResponsibilityAuthorizationResolver,
  verifyActiveTeamsOwnerContext,
  verifyWorkflowOwnerAccess,
} from '../dist/responsibility-authority.js';
import {
  enqueueWorkflowNoticeToTeams,
  projectWorkflowNoticeToTeamsMessage,
} from '../dist/workflow-teams-delivery.js';
import { isBackgroundActionWriteBlocked, registerToolProviders } from '../dist/tool-providers.js';

const WORKSPACE_ID = 'workspace-1';
const CONNECTOR_ID = 'teams-v1';
const BINDING_ID = 'exchange-github-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTION_REF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROFILE_REF = 'github-owner-profile';
const TENANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OWNER_ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const REPOSITORY_ID = '12345';
const REPOSITORY = 'DoHorizon-AI/Cyrene-Workspace';
const WORKFLOW_ID = 'github-duty';
const TRIGGER_ID = 'poll-github';
const ACTION_ID = 'draft-docs';
const SCHEDULED_AT = '2026-10-24T13:00:00.000Z';
const THREAD_ID = 'd'.repeat(64);
const SESSION_ID = 'teams-session-owner';
const OWNER_TASK_ID = 'teams-root-task';

const ROUTE = Object.freeze({
  tenantId: TENANT_ID,
  teamId: 'team-1',
  channelId: 'channel-ai',
  conversationId: 'conversation-1',
  rootThreadId: '1761310800000',
  serviceUrl: 'https://smba.trafficmanager.net/emea/',
});

const DRAFT_OPERATIONS = Object.freeze([
  'github.branch.create',
  'github.file.commit',
  'github.pull_request.draft.create',
]);

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function baseTask(id, metadata, overrides = {}) {
  return {
    id,
    sessionId: SESSION_ID,
    prompt: 'trusted test task',
    status: 'running',
    executionClass: 'foreground',
    createdAt: 1_792_840_000_000,
    output: '',
    reasoning: '',
    durationMs: 0,
    workspaceId: WORKSPACE_ID,
    metadata,
    ...overrides,
  };
}

function createFixture({
  directoryAuthorized = true,
  eventStatus = 'running',
  taskKind = 'observation',
  actionId = ACTION_ID,
} = {}) {
  const authorizationRef = { kind: 'teams_thread', threadBindingId: THREAD_ID, ownerTaskId: OWNER_TASK_ID };
  const workflow = {
    id: WORKFLOW_ID,
    version: 2,
    title: 'GitHub duty',
    description: 'Observe the configured repository.',
    goal: 'Keep the owner informed.',
    instructions: 'Read allowed repository state and report changes.',
    targets: [{
      id: REPOSITORY_ID,
      label: REPOSITORY,
      kind: 'github_repository',
      uri: `https://github.com/${REPOSITORY}`,
      bindingId: BINDING_ID,
    }],
    triggers: [{
      id: TRIGGER_ID,
      kind: 'github_incremental_poll',
      schedule: { kind: 'cron', expression: '*/5 * * * *', timeZone: 'UTC' },
      targetIds: [REPOSITORY_ID],
      initialBaseline: 'record_without_notification',
    }],
    actionPolicy: {
      allowedActions: [
        {
          id: ACTION_ID,
          action: 'draft_pull_request',
          targetIds: [REPOSITORY_ID],
          baseBranches: ['develop'],
          branchPrefixes: ['cyrene/workflow/'],
          pathPrefixes: ['docs/'],
          issueNumbers: [],
          sourceWorkflowIds: [],
          permittedOperations: [...DRAFT_OPERATIONS],
        },
        {
          id: 'rerun-source-ci',
          action: 'rerun_source_ci',
          targetIds: [REPOSITORY_ID],
          baseBranches: [],
          branchPrefixes: ['cyrene/assistant/'],
          pathPrefixes: [],
          issueNumbers: [],
          sourceWorkflowIds: ['98765'],
          permittedOperations: ['github.actions.rerun_failed'],
        },
      ],
      separateChildTask: true,
      productionChanges: 'forbidden',
      requiresUserAuthorization: ['merge', 'release', 'production', 'new_spend'],
    },
    modelPolicy: {
      preferredProvider: 'antigravity',
      preferredModel: 'gemini-3.8-flash-medium',
      fallback: 'configured_no_additional_spend',
    },
    authorization: authorizationRef,
    notifications: {
      onChange: true,
      onFailure: true,
      onRecovery: true,
      quietWhenUnchanged: true,
      quietHours: { start: '22:00', end: '08:00', timeZone: 'America/New_York' },
      digest: {
        enabled: true,
        schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'America/New_York' },
        maxPerDay: 1,
      },
      destination: { kind: 'responsibility_thread' },
      immediateOn: ['blocked_goal', 'user_decision', 'service_or_auth_outage'],
    },
    enabled: true,
  };

  const digest = hash(`${WORKFLOW_ID}\0${TRIGGER_ID}\0${SCHEDULED_AT}`).slice(0, 40);
  const occurrenceId = `occ-${digest}`;
  const observationTaskId = `workflow-${digest}`;
  const observationMetadata = {
    source: 'workflow',
    workflowId: WORKFLOW_ID,
    triggerId: TRIGGER_ID,
    occurrenceId,
    scheduledAt: SCHEDULED_AT,
    authorizationRef,
  };
  const ownerTask = baseTask(OWNER_TASK_ID, {
    teamsCaller: {
      issuer: OWNER_ISSUER,
      subject: OWNER_ID,
      tenantId: TENANT_ID,
      actorAadObjectId: OWNER_ID,
    },
    teamsThread: { threadId: THREAD_ID, ...ROUTE },
    notification: { type: 'teams.message', connectorId: CONNECTOR_ID, recipient: `teams:${THREAD_ID}`, payload: ROUTE },
  });
  const observationTask = baseTask(observationTaskId, observationMetadata, {
    executionClass: 'background',
    status: 'running',
  });
  const actionGrant = workflow.actionPolicy.allowedActions.find(grant => grant.id === actionId);
  assert.ok(actionGrant);
  const actionRequestDigest = 'e'.repeat(64);
  const childTaskId = `workflow-action-${hash(`${occurrenceId}\0${actionId}\0${REPOSITORY_ID}`).slice(0, 40)}`;
  const childMetadata = {
    ...observationMetadata,
    parentTaskId: observationTaskId,
    actionId,
    actionType: actionGrant.action,
    actionRequestDigest,
    targetId: REPOSITORY_ID,
    permittedOperations: [...actionGrant.permittedOperations],
  };
  const childTask = baseTask(childTaskId, childMetadata, {
    executionClass: 'background',
    parentTaskId: observationTaskId,
  });
  const activeTask = taskKind === 'observation' ? observationTask : childTask;
  const baseStatus = taskKind === 'observation' ? eventStatus : 'running';
  const event = {
    id: `workflow-${hash(`${WORKFLOW_ID}\0${TRIGGER_ID}\0${SCHEDULED_AT}\0${baseStatus}`).slice(0, 48)}`,
    workflowId: WORKFLOW_ID,
    triggerId: TRIGGER_ID,
    scheduledAt: SCHEDULED_AT,
    status: baseStatus,
    taskId: observationTaskId,
    sessionId: observationTask.sessionId,
    summary: 'Repository state changed.',
    createdAt: SCHEDULED_AT,
  };
  const actionAuthorizationEvent = taskKind === 'observation' ? undefined : {
      id: `workflow-auth-${hash(`${occurrenceId}\0${actionId}\0${REPOSITORY_ID}`).slice(0, 40)}`,
      workflowId: WORKFLOW_ID,
      triggerId: TRIGGER_ID,
      scheduledAt: SCHEDULED_AT,
      status: 'running',
      taskId: observationTaskId,
      sessionId: observationTask.sessionId,
      actionResults: [{
        actionId,
        actionType: actionGrant.action,
        targetId: REPOSITORY_ID,
        taskId: childTaskId,
        requestDigest: actionRequestDigest,
        status: 'waiting',
        operationIds: [],
      }],
      createdAt: SCHEDULED_AT,
    };
  const thread = {
    threadId: THREAD_ID,
    ...ROUTE,
    sessionId: SESSION_ID,
    messages: [{
      messageId: 'root-message',
      actorIssuer: OWNER_ISSUER,
      actorSubject: OWNER_ID,
      text: '@Cyrene monitor GitHub.',
      createdAt: 1_792_840_000_000,
    }],
  };
  const tasks = new Map([
    [OWNER_TASK_ID, ownerTask],
    [observationTaskId, observationTask],
    [childTaskId, childTask],
  ]);
  const workState = {
    async getTask(taskId) { return tasks.get(taskId); },
    async getConnectorThread(connectorId, threadId) {
      assert.equal(connectorId, CONNECTOR_ID);
      if (threadId !== THREAD_ID) throw new Error('thread not found');
      return thread;
    },
  };
  const workflows = {
    listWorkflows(version) {
      assert.equal(version, 2);
      return [workflow];
    },
    async getScheduleEvent(eventId) {
      return [event, ...(actionAuthorizationEvent === undefined ? [] : [actionAuthorizationEvent])]
        .find(item => item.id === eventId);
    },
  };
  const config = {
    workspaceId: WORKSPACE_ID,
    teamsConnectorId: CONNECTOR_ID,
    allowedTenantId: TENANT_ID,
    allowedTeamIds: [ROUTE.teamId],
    allowedChannelIds: [ROUTE.channelId],
    workState,
    workflows,
    async isDirectoryAuthorized(principal) {
      return directoryAuthorized && principal.issuer === OWNER_ISSUER && principal.subject === OWNER_ID;
    },
  };
  const binding = {
    bindingId: BINDING_ID,
    connectionRef: CONNECTION_REF,
    providerId: 'github',
    profileRef: PROFILE_REF,
    tools: [],
  };
  return {
    config,
    workflow,
    event,
    thread,
    tasks,
    binding,
    ownerTask,
    observationTask,
    childTask,
    activeTask,
    occurrenceId,
    observationTaskId,
    async setDirectoryAuthorized(value) { config.isDirectoryAuthorized = async () => value; },
  };
}

function connectorCall(fixture, {
  task = fixture.activeTask,
  toolId = 'github.file.commit',
  operationId = 'github.file.commit',
  resourceProjection = 'github_file',
  mutating = true,
  arguments: args = {
    repository_id: Number(REPOSITORY_ID),
    repository: REPOSITORY,
    branch: 'cyrene/workflow/occ-1',
    path: 'docs/STATUS.md',
    content: 'updated',
  },
  bindingId = BINDING_ID,
} = {}) {
  const tool = { toolId, operationId, resourceProjection, mutating };
  const binding = {
    ...fixture.binding,
    bindingId,
    tools: [tool],
  };
  return {
    taskId: task.id,
    task,
    binding,
    tool,
    arguments: args,
    signal: new AbortController().signal,
  };
}

test('background reads require verified Work provenance, current owner, exact repository, and connector binding', async () => {
  const fixture = createFixture({ taskKind: 'observation' });
  const resolver = createResponsibilityAuthorizationResolver(fixture.config);
  const allowed = await resolver(connectorCall(fixture, {
    toolId: 'github.issues.search',
    operationId: 'github.issues.search',
    resourceProjection: 'github_repository',
    mutating: false,
    arguments: { repository_id: 12345, repository: REPOSITORY, query: 'is:open' },
  }));
  assert.deepEqual(allowed, { issuer: OWNER_ISSUER, subject: OWNER_ID, tenantId: TENANT_ID });

  const wrongRepo = await resolver(connectorCall(fixture, {
    toolId: 'github.issues.search',
    operationId: 'github.issues.search',
    resourceProjection: 'github_repository',
    mutating: false,
    arguments: { repository_id: 54321, repository: 'other/repo', query: 'is:open' },
  }));
  const wrongBinding = await resolver(connectorCall(fixture, {
    toolId: 'github.issues.search',
    operationId: 'github.issues.search',
    resourceProjection: 'github_repository',
    mutating: false,
    bindingId: 'exchange-github-other',
    arguments: { repository_id: 12345, repository: REPOSITORY, query: 'is:open' },
  }));
  assert.equal(wrongRepo, undefined);
  assert.equal(wrongBinding, undefined);

  const computerRequest = connectorCall(fixture, {
    toolId: 'computer.file.read',
    operationId: 'computer.file.read',
    resourceProjection: 'computer_file',
    mutating: false,
    arguments: { path: 'README.md', length: 4096 },
  });
  computerRequest.binding.providerId = 'computer';
  assert.equal(await resolver(computerRequest), undefined);
});

test('owner tools use a fresh Teams caller while duties remain bound to the same authorized principal', async () => {
  const fixture = createFixture();
  fixture.ownerTask.status = 'completed';
  const activeTaskId = 'teams-current-owner-task';
  const activeTask = baseTask(activeTaskId, {
    teamsCaller: {
      issuer: OWNER_ISSUER,
      subject: OWNER_ID,
      tenantId: TENANT_ID,
      actorAadObjectId: OWNER_ID,
    },
    teamsThread: { threadId: THREAD_ID, ...ROUTE },
    notification: { type: 'teams.message', connectorId: CONNECTOR_ID, recipient: `teams:${THREAD_ID}`, payload: ROUTE },
  });
  fixture.tasks.set(activeTaskId, activeTask);

  const active = await verifyActiveTeamsOwnerContext(
    fixture.config, activeTaskId, new AbortController().signal,
  );
  assert.equal(active?.principal.subject, OWNER_ID);

  const managed = await verifyWorkflowOwnerAccess(
    fixture.config,
    WORKFLOW_ID,
    { issuer: OWNER_ISSUER, subject: OWNER_ID, tenantId: TENANT_ID },
    new AbortController().signal,
  );
  assert.equal(managed?.workflow.id, WORKFLOW_ID);
  assert.equal(managed?.ownerTask.id, OWNER_TASK_ID);

  const otherPrincipal = await verifyWorkflowOwnerAccess(
    fixture.config,
    WORKFLOW_ID,
    {
      issuer: OWNER_ISSUER,
      subject: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      tenantId: TENANT_ID,
    },
    new AbortController().signal,
  );
  assert.equal(otherPrincipal, undefined);
});

test('write access requires a matching child, copied canonical action grant, and exact branch/path scope', async () => {
  const fixture = createFixture({ taskKind: 'child' });
  const resolver = createResponsibilityAuthorizationResolver(fixture.config);
  const valid = await resolver(connectorCall(fixture));
  assert.equal(valid?.subject, OWNER_ID);

  const wrongPath = await resolver(connectorCall(fixture, {
    arguments: {
      repository_id: 12345,
      repository: REPOSITORY,
      branch: 'cyrene/workflow/occ-1',
      path: 'src/secret.py',
      content: 'updated',
    },
  }));
  const wrongBranch = await resolver(connectorCall(fixture, {
    arguments: {
      repository_id: 12345,
      repository: REPOSITORY,
      branch: 'main',
      path: 'docs/STATUS.md',
      content: 'updated',
    },
  }));
  const unauthorizedOperation = await resolver(connectorCall(fixture, {
    toolId: 'github.vendor.cli.execute',
    operationId: 'github.vendor.cli.execute',
    resourceProjection: 'profile',
    arguments: { argv: ['api', 'repos/DoHorizon-AI/Cyrene-Workspace'] },
  }));
  assert.equal(wrongPath, undefined);
  assert.equal(wrongBranch, undefined);
  assert.equal(unauthorizedOperation, undefined);

  fixture.workflow.actionPolicy.allowedActions[0].pathPrefixes = ['**'];
  const repositoryWidePath = await resolver(connectorCall(fixture, {
    arguments: {
      repository_id: 12345,
      repository: REPOSITORY,
      branch: 'cyrene/workflow/occ-1',
      path: 'src/engine.ts',
      content: 'updated',
    },
  }));
  const traversalPath = await resolver(connectorCall(fixture, {
    arguments: {
      repository_id: 12345,
      repository: REPOSITORY,
      branch: 'cyrene/workflow/occ-1',
      path: '../outside.md',
      content: 'updated',
    },
  }));
  assert.equal(repositoryWidePath?.subject, OWNER_ID);
  assert.equal(traversalPath, undefined);
});

test('CI reruns require a granted workflow id and an assistant-owned source branch', async () => {
  const fixture = createFixture({ taskKind: 'rerun', actionId: 'rerun-source-ci' });
  const resolver = createResponsibilityAuthorizationResolver(fixture.config);
  const argumentsValue = {
    repository_id: 12345,
    repository: REPOSITORY,
    run_id: '778899',
    expected_workflow_id: '98765',
    expected_head_branch: 'cyrene/assistant/fix-api-test',
    expected_head_sha: 'a'.repeat(40),
    expected_attempt: 1,
  };

  const allowed = await resolver(connectorCall(fixture, {
    toolId: 'github.actions.rerun_failed',
    operationId: 'github.actions.rerun_failed',
    resourceProjection: 'github_actions_run',
    mutating: true,
    arguments: argumentsValue,
  }));
  const wrongWorkflow = await resolver(connectorCall(fixture, {
    toolId: 'github.actions.rerun_failed',
    operationId: 'github.actions.rerun_failed',
    resourceProjection: 'github_actions_run',
    mutating: true,
    arguments: { ...argumentsValue, expected_workflow_id: '98766' },
  }));
  const wrongBranch = await resolver(connectorCall(fixture, {
    toolId: 'github.actions.rerun_failed',
    operationId: 'github.actions.rerun_failed',
    resourceProjection: 'github_actions_run',
    mutating: true,
    arguments: { ...argumentsValue, expected_head_branch: 'main' },
  }));

  assert.equal(allowed?.subject, OWNER_ID);
  assert.equal(wrongWorkflow, undefined);
  assert.equal(wrongBranch, undefined);
});

test('unknown connector writes block replay from a later responsibility task on the same exact target', () => {
  const receiptTarget = 'connector-target:sha256:stable-file-target';
  const unknown = {
    id: 'prior-operation',
    taskId: 'workflow-action-prior-occurrence',
    target: receiptTarget,
    status: 'uncertain',
    evidence: { effect: 'write', providerId: 'github', profileRef: PROFILE_REF },
  };
  assert.equal(isBackgroundActionWriteBlocked(
    unknown, 'workflow-action-new-occurrence', 'github', PROFILE_REF, receiptTarget,
  ), true);
  assert.equal(isBackgroundActionWriteBlocked(
    { ...unknown, target: 'connector-target:sha256:other-file' },
    'workflow-action-new-occurrence', 'github', PROFILE_REF, receiptTarget,
  ), false);
  assert.equal(isBackgroundActionWriteBlocked(
    { ...unknown, target: 'connector-target:sha256:other-file' },
    'workflow-action-prior-occurrence', 'github', PROFILE_REF, receiptTarget,
  ), true);
});

test('background write operation id is durably linked before Exchange, and a missing link prevents invocation', async () => {
  async function execute({ failReceiptLink = false } = {}) {
    const fixture = createFixture({ taskKind: 'child' });
    const order = [];
    let providerCalls = 0;
    const operationId = 'a'.repeat(32);
    const bindingCatalog = {
      items: [{
        bindingId: BINDING_ID,
        capabilityId: 'tool.provider.v1',
        providerId: 'github',
        connectionRef: CONNECTION_REF,
        profileRef: PROFILE_REF,
      }],
    };
    const toolCatalog = {
      tools: [{
        id: 'github.file.commit',
        name: 'Commit GitHub file',
        description: 'Commit one file in the configured repository.',
        readOnly: false,
        inputSchema: {
          type: 'object',
          properties: {
            repository_id: { type: 'integer' },
            repository: { type: 'string' },
            branch: { type: 'string' },
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['repository_id', 'repository', 'branch', 'path', 'content'],
          additionalProperties: false,
        },
      }],
    };
    const bridge = {
      async request(path, method) {
        order.push(`request:${method}:${path}`);
        if (path === '/tool-providers' && method === 'GET') return bindingCatalog;
        if (path === `/tool-providers/${BINDING_ID}/tools` && method === 'GET') return toolCatalog;
        if (path === `/tasks/${fixture.childTask.id}` && method === 'GET') return fixture.childTask;
        if (path.startsWith('/operations/unresolved?') && method === 'GET') return { items: [] };
        if (path === `/operations/${operationId}` && method === 'PATCH') return { operation: { id: operationId } };
        throw new Error(`Unexpected bridge request ${method} ${path}`);
      },
      async requestApproval() { throw new Error('Approved workflow actions do not prompt per action'); },
      async mutate(execution, path, method, body, taskLinked = false) {
        order.push(`mutate:${method}:${path}`);
        if (path === '/operations' && method === 'POST') {
          assert.equal(taskLinked, true);
          assert.equal(body.scopeLock, `connector-branch:${hash(canonicalJson({
            providerId: 'github',
            profileRef: PROFILE_REF,
            repository_id: REPOSITORY_ID,
            repository: REPOSITORY.toLowerCase(),
            branch: 'cyrene/workflow/occ-1',
          }))}`);
          return { operation: { id: operationId, status: 'started' }, duplicate: false };
        }
        if (path === `/tasks/${fixture.childTask.id}/events` && method === 'POST') {
          assert.equal(taskLinked, false);
          assert.equal(body.messageId, `connector-operation-${operationId}`);
          assert.match(body.event.targetDigestSha256, /^[a-f0-9]{64}$/u);
          assert.deepEqual(body.event, {
            type: 'connector.operation.receipt.v1',
            operationId,
            callId: 'write-call-1',
            bindingId: BINDING_ID,
            providerId: 'github',
            profileRef: PROFILE_REF,
            targetDigestSha256: body.event.targetDigestSha256,
            effect: 'write',
            outcome: 'started',
          });
          if (failReceiptLink) throw new Error('Work event append failed');
          return { seq: 1, event: body.event, duplicate: false };
        }
        throw new Error(`Unexpected bridge mutation ${method} ${path}`);
      },
    };
    const exchange = {
      async mintGrant(request) { return { request }; },
      async callProviderOperation(request) {
        providerCalls += 1;
        order.push('exchange:provider-call');
        return {
          requestId: request.requestId,
          outcome: 'verified',
          result: { content: [{ type: 'text', text: 'Committed file.' }] },
        };
      },
    };
    const context = new Context();
    await context.plugin(SystemPrompt);
    await context.plugin(ToolRuntime);
    const dispose = await registerToolProviders(context, {
      bridge,
      taskIdForSession: sessionId => sessionId === fixture.childTask.sessionId ? fixture.childTask.id : undefined,
      connectorAuthorization: {
        client: exchange,
        workspaceId: WORKSPACE_ID,
        bindings: new Map([[BINDING_ID, {
          bindingId: BINDING_ID,
          connectionRef: CONNECTION_REF,
          providerId: 'github',
          profileRef: PROFILE_REF,
          tools: [{ toolId: 'github.file.commit', operationId: 'github.file.commit', resourceProjection: 'github_file', mutating: true }],
        }]]),
      },
      backgroundTaskAuthority: async () => ({ issuer: OWNER_ISSUER, subject: OWNER_ID, tenantId: TENANT_ID }),
    });
    try {
      const schema = context.tools.schemas().find(item => item.description.startsWith(`Commit GitHub file (configured provider ${BINDING_ID})`));
      assert.ok(schema);
      const result = await context.tools.execute({
        name: schema.name,
        callId: ToolCallId('write-call-1'),
        arguments: {
          repository_id: 12345,
          repository: REPOSITORY,
          branch: 'cyrene/workflow/occ-1',
          path: 'docs/STATUS.md',
          content: 'updated',
        },
        signal: new AbortController().signal,
        agent: { id: 'navigator-agent', session: { id: fixture.childTask.sessionId } },
      });
      return { result, order, providerCalls };
    } finally {
      dispose();
      await context.fiber.dispose();
    }
  }

  const completed = await execute();
  assert.equal(completed.result.isError, false);
  const receiptEventIndex = completed.order.findIndex(item => item.startsWith('mutate:POST:/tasks/') && item.endsWith('/events'));
  assert.ok(receiptEventIndex >= 0 && receiptEventIndex < completed.order.indexOf('exchange:provider-call'));
  assert.equal(completed.providerCalls, 1);

  const denied = await execute({ failReceiptLink: true });
  assert.equal(denied.result.isError, true);
  assert.equal(denied.providerCalls, 0);
  assert.equal(denied.order.includes('exchange:provider-call'), false);
});

test('authorization fails closed when Directory access is revoked or the persisted Teams route goes stale', async () => {
  const revoked = createFixture({ taskKind: 'observation', directoryAuthorized: false });
  const revokedResult = await createResponsibilityAuthorizationResolver(revoked.config)(
    connectorCall(revoked, {
      toolId: 'github.issues.search',
      operationId: 'github.issues.search',
      resourceProjection: 'github_repository',
      mutating: false,
      arguments: { repository_id: 12345, repository: REPOSITORY, query: 'is:open' },
    }),
  );
  assert.equal(revokedResult, undefined);

  const stale = createFixture({ taskKind: 'observation' });
  stale.thread.rootThreadId = '1761310800999';
  const staleResult = await createResponsibilityAuthorizationResolver(stale.config)(
    connectorCall(stale, {
      toolId: 'github.issues.search',
      operationId: 'github.issues.search',
      resourceProjection: 'github_repository',
      mutating: false,
      arguments: { repository_id: 12345, repository: REPOSITORY, query: 'is:open' },
    }),
  );
  assert.equal(staleResult, undefined);
});

test('notice projection uses the original authorized root and replays with one durable deduplication key', async () => {
  const fixture = createFixture({ taskKind: 'observation', eventStatus: 'succeeded' });
  const notice = {
    deduplicationKey: `workflow:${WORKFLOW_ID}:${fixture.occurrenceId}:change`,
    workflowId: WORKFLOW_ID,
    occurrenceId: fixture.occurrenceId,
    triggerId: TRIGGER_ID,
    kind: 'change',
    scheduledAt: SCHEDULED_AT,
    title: 'GitHub duty',
    summary: '@maintainer: a check changed.',
    taskId: fixture.observationTaskId,
  };
  const projected = await projectWorkflowNoticeToTeamsMessage(
    notice, fixture.config, new AbortController().signal,
  );
  assert.deepEqual(projected, {
    occurrenceId: fixture.occurrenceId,
    triggerId: TRIGGER_ID,
    scheduledAt: SCHEDULED_AT,
    kind: 'change',
    summary: '＠maintainer: a check changed.',
  });

  const durable = new Map();
  const enqueuer = {
    async enqueueTeamsNotification(workflowId, request) {
      const deduplicationKey = `workflow:${workflowId}:${request.occurrenceId}:${request.kind}`;
      const existing = durable.get(deduplicationKey);
      if (existing) {
        assert.deepEqual(existing, request);
        return { notification: { workflowId, ...request }, duplicate: true };
      }
      durable.set(deduplicationKey, structuredClone(request));
      return { notification: { workflowId, ...request }, duplicate: false };
    },
  };
  const first = await enqueueWorkflowNoticeToTeams(notice, fixture.config, enqueuer, new AbortController().signal);
  const replayAfterRestart = await enqueueWorkflowNoticeToTeams(
    notice, fixture.config, enqueuer, new AbortController().signal,
  );
  assert.equal(first?.duplicate, false);
  assert.equal(replayAfterRestart?.duplicate, true);
  assert.equal(durable.size, 1);
});

test('notice projector rejects model-controlled route fields and revoked or stale destination bindings', async () => {
  const fixture = createFixture({ taskKind: 'observation', eventStatus: 'succeeded' });
  const notice = {
    deduplicationKey: `workflow:${WORKFLOW_ID}:${fixture.occurrenceId}:blocker`,
    workflowId: WORKFLOW_ID,
    occurrenceId: fixture.occurrenceId,
    triggerId: TRIGGER_ID,
    kind: 'blocker',
    scheduledAt: SCHEDULED_AT,
    attentionKind: 'user_decision',
    title: 'GitHub duty',
    summary: 'Please choose whether to continue.',
    taskId: fixture.observationTaskId,
  };
  await assert.rejects(projectWorkflowNoticeToTeamsMessage({ ...notice, route: ROUTE }, fixture.config, new AbortController().signal),
    /routing or identity/u);

  fixture.thread.teamId = 'unexpected-team';
  const stale = await projectWorkflowNoticeToTeamsMessage(notice, fixture.config, new AbortController().signal);
  assert.equal(stale, undefined);

  const revoked = createFixture({ taskKind: 'observation', eventStatus: 'succeeded', directoryAuthorized: false });
  const revokedNotice = {
    ...notice,
    occurrenceId: revoked.occurrenceId,
    deduplicationKey: `workflow:${WORKFLOW_ID}:${revoked.occurrenceId}:blocker`,
    taskId: revoked.observationTaskId,
  };
  const revokedResult = await projectWorkflowNoticeToTeamsMessage(
    revokedNotice, revoked.config, new AbortController().signal,
  );
  assert.equal(revokedResult, undefined);
});

test('daily digest notices use the synthetic digest trigger and remain route free', async () => {
  const fixture = createFixture({ taskKind: 'observation', eventStatus: 'succeeded' });
  const triggerId = 'daily-digest';
  const occurrenceId = `occ-${hash(`${WORKFLOW_ID}\0${triggerId}\0${SCHEDULED_AT}`).slice(0, 40)}`;
  fixture.event.triggerId = triggerId;
  fixture.event.id = `workflow-${hash(`${WORKFLOW_ID}\0${triggerId}\0${SCHEDULED_AT}\0succeeded`).slice(0, 48)}`;
  fixture.event.taskId = OWNER_TASK_ID;
  const notice = {
    deduplicationKey: `workflow:${WORKFLOW_ID}:${occurrenceId}:digest`,
    workflowId: WORKFLOW_ID,
    occurrenceId,
    triggerId,
    kind: 'digest',
    scheduledAt: SCHEDULED_AT,
    title: 'GitHub duty',
    summary: 'Two material changes were found.',
    taskId: OWNER_TASK_ID,
  };
  const projected = await projectWorkflowNoticeToTeamsMessage(
    notice, fixture.config, new AbortController().signal,
  );
  assert.deepEqual(projected, {
    occurrenceId,
    triggerId,
    scheduledAt: SCHEDULED_AT,
    kind: 'digest',
    summary: 'Two material changes were found.',
  });
  assert.equal(Object.hasOwn(projected, 'teamId'), false);
  assert.equal(Object.hasOwn(projected, 'taskId'), false);
});
