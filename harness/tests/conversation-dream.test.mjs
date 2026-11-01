// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Dream consumer tests                              │
// │ Role: Verify bounded continuation, source recheck and DSH delegation.│
// │ 模块职责：验证有界续跑、来源复验及 DSH 任务委托。                      │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDreamMaintenanceFeature } from '../dist/features/dream-maintenance.js';
import { createKnowledgeGraphFeature } from '../dist/features/knowledge-graph.js';
import { maintenanceWorkTaskId } from '../dist/features/conversation-dsh-runtime.js';

const scope = {
  workspaceId: 'workspace-1',
  actorId: 'actor-1',
  conversationId: 'conversation-1',
  conversationKind: 'direct',
  personaId: 'persona-1',
  visibility: 'private',
  authorizationEpoch: 4,
};
const graphRefs = [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['message-2'] }];

function context(overrides = {}) {
  return {
    ...scope,
    taskId: 'task-turn-1',
    sessionId: 'session-conversation-1',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function message(index) {
  return {
    id: `message-${index}`,
    eventId: `event-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${index} with sourced context.`,
    occurredAt: 1_800_000_000_000 + index,
    status: 'active',
    scope: {
      conversationId: scope.conversationId,
      conversationKind: scope.conversationKind,
      personaId: scope.personaId,
      visibility: scope.visibility,
    },
  };
}

function job(overrides = {}) {
  const id = overrides.id ?? 'dream-job-1';
  return {
    id,
    taskId: maintenanceWorkTaskId(scope.workspaceId, scope.actorId, id),
    idempotencyKey: 'dream-request-1',
    kind: 'dream',
    conversationId: scope.conversationId,
    conversationKind: scope.conversationKind,
    personaId: scope.personaId,
    state: 'queued',
    cursor: null,
    processedCount: 0,
    checkpointDigest: null,
    queuedVersion: 1,
    details: {},
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const calls = {
    pages: [],
    memoryLookups: [],
    queryMemories: [],
    authorizations: [],
    createMemories: [],
    graphProposals: [],
    graphApplies: [],
    maintenanceCreates: [],
    checkpoints: [],
    schedules: [],
    cancels: [],
    retries: [],
    taskRequests: [],
  };
  let selectedJob = job();
  const messages = [message(1), message(2), message(3), message(4)];
  const api = {
    apiVersion: 1,
    async createMessage() { throw new Error('not used'); },
    async listMessages(_context, input) {
      calls.pages.push(input);
      const index = input.cursor === undefined ? 0 : Number(input.cursor.replace('cursor-', ''));
      return {
        items: [messages[index]],
        nextCursor: index + 1 < messages.length ? `cursor-${index + 1}` : null,
      };
    },
    async listMemories(_context, input) {
      calls.memoryLookups.push(input);
      return { items: [], authorizationEpoch: scope.authorizationEpoch };
    },
    async queryMemories(_context, input) {
      calls.queryMemories.push(input);
      return { items: [], authorizationEpoch: scope.authorizationEpoch };
    },
    async createMemory(_context, input) {
      calls.createMemories.push(input);
      return { memory: { memoryId: 'created-memory', version: 1 }, duplicate: false };
    },
    async updateMemory() { throw new Error('not used'); },
    async deleteMemory() { throw new Error('not used'); },
    async revokeSource() { throw new Error('not used'); },
    async authorizeSources(_context, input) {
      calls.authorizations.push(input);
      if (overrides.authorization !== undefined) return overrides.authorization(input);
      return { allowed: true, currentAuthorizationEpoch: scope.authorizationEpoch, deniedSourceIds: [] };
    },
    async listPersonas() { return { items: [] }; },
    async putPersona() { throw new Error('not used'); },
    async listProfiles() { return { items: [] }; },
    async createProfileCandidate() { throw new Error('not used'); },
    async listProfileCandidates() { return { items: [] }; },
    async activateProfileCandidate() { throw new Error('not used'); },
    async rollbackProfile() { throw new Error('not used'); },
    async createGraphProposal(_context, input) {
      calls.graphProposals.push(input);
      return { changeset: {
        id: 'graph-change-1', version: 1, digest: 'proposal-digest',
        conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId,
        sourceRefs: graphRefs, nodes: input.nodes, edges: input.edges,
      } };
    },
    async queryGraph() { throw new Error('not used'); },
    async listGraphChangesets() {
      return { items: [{
        id: 'graph-change-1', idempotencyKey: 'graph-key', conversationId: scope.conversationId,
        conversationKind: scope.conversationKind, personaId: scope.personaId, sourceRefs: graphRefs,
        nodes: [{ id: 'node-1', label: 'Acceptance', sourceMessageIds: ['message-2'], sourceRefs: graphRefs }], edges: [],
        digest: 'proposal-digest', state: 'proposed', version: 1, providerStatus: 'ready', providerApplied: false,
        createdAt: 1, updatedAt: 1,
      }] };
    },
    async applyGraphChangeset() {
      calls.graphApplies.push(true);
      return { changeset: {
        id: 'graph-change-1',
        version: 2,
        digest: 'proposal-digest',
        conversationId: scope.conversationId,
        conversationKind: scope.conversationKind,
        personaId: scope.personaId,
        sourceRefs: graphRefs,
        nodes: [{ id: 'node-1', sourceRefs: graphRefs }],
        edges: [],
        providerApplied: true,
        state: 'projected',
        providerReceipt: {
          requestDigest: 'proposal-digest',
          readbackDigest: 'proposal-digest',
          nodeCount: 1,
          edgeCount: 0,
          appliedAt: 1_800_000_000_000,
        },
      } };
    },
    async createMaintenanceJob(_context, input) {
      calls.maintenanceCreates.push(input);
      return { job: job({ id: 'dream-job-next', idempotencyKey: input.idempotencyKey, cursor: input.cursor }), duplicate: false };
    },
    async listMaintenanceJobs() { return { items: [], nextCursor: null }; },
    async getMaintenanceJob() { return { job: selectedJob }; },
    async retryMaintenanceJob(_context, id, expectedVersion) {
      if (selectedJob.id !== id || selectedJob.version !== expectedVersion || selectedJob.state !== 'failed') throw new Error('retry CAS mismatch');
      calls.retries.push({ id, expectedVersion, details: selectedJob.details });
      selectedJob = {
        ...selectedJob,
        id: `${id}-retry`,
        taskId: maintenanceWorkTaskId(scope.workspaceId, scope.actorId, `${id}-retry`),
        idempotencyKey: `retry:${id}:${expectedVersion}`,
        state: 'queued',
        queuedVersion: 1,
        version: 1,
      };
      return { job: selectedJob, duplicate: false };
    },
    async cancelMaintenanceJob(_context, id, expectedVersion) {
      calls.cancels.push({ id, expectedVersion });
      selectedJob = { ...selectedJob, state: 'cancelled' };
      return { job: selectedJob };
    },
    async createResearchNote() { throw new Error('not used'); },
    async listResearchNotes() { return { items: [] }; },
    async createVerifiedSkill() { throw new Error('not used'); },
    async listVerifiedSkills() { return { items: [] }; },
    async createWatch() { throw new Error('not used'); },
    async listWatches() { return { items: [] }; },
    async cancelWatch() { throw new Error('not used'); },
    async createFocusItem() { throw new Error('not used'); },
    async listFocusItems() { return { items: [] }; },
    async transitionFocusItem() { throw new Error('not used'); },
    async createHandoff() { throw new Error('not used'); },
    async listHandoffs() { return { items: [] }; },
    async getActiveBehaviorPolicy() { return null; },
    async putActiveBehaviorPolicy() { throw new Error('not used'); },
    ...overrides.api,
  };
  const scheduler = {
    async ensureOneShot(marker, dueAt, opts) {
      calls.schedules.push({ marker, dueAt, opts });
      return { record: { id: `schedule-${calls.schedules.length}` }, created: true, active: true };
    },
    async cancel(marker) {
      calls.cancels.push({ marker });
      return 1;
    },
  };
  const tasks = {
    async run(taskContext, request, operation, signal) {
      calls.taskRequests.push({ taskContext, request });
      selectedJob = { ...selectedJob, state: 'running', version: selectedJob.version + 1 };
      try {
        await operation({ id: request.sessionId }, signal, async value => {
          calls.checkpoints.push(value);
          selectedJob = { ...selectedJob, cursor: value.cursor, processedCount: value.processedCount,
            checkpointDigest: value.checkpointDigest, details: value.details, version: selectedJob.version + 1 };
        });
      } catch (error) {
        selectedJob = { ...selectedJob, state: 'failed', details: { ...selectedJob.details, state: 'failed', retryable: selectedJob.details.retryable === true,
          taskId: request.taskId, taskOutputSha256: 'a'.repeat(64) }, version: selectedJob.version + 1 };
        throw error;
      }
      selectedJob = { ...selectedJob, state: 'completed', details: { ...selectedJob.details, state: 'completed', retryable: true,
        taskId: request.taskId, taskOutputSha256: 'a'.repeat(64) }, version: selectedJob.version + 1 };
      return { taskId: request.taskId, sessionId: request.sessionId, status: 'completed', output: 'done', reasoning: '', durationMs: 5 };
    },
    async cancel(_context, taskId) {
      calls.cancels.push({ taskId });
      return true;
    },
  };
  const planner = {
    apiVersion: 1,
    calls: [],
    async plan(input) {
      this.calls.push(input);
      if (overrides.plan !== undefined) return overrides.plan(input);
      return {
        memoryWrites: [{ kind: 'fact', text: 'The user is preparing a local acceptance.', evidenceMessageIds: ['message-2'] }],
        graph: { nodes: [], edges: [] },
      };
    },
  };
  const graph = createKnowledgeGraphFeature({
    api,
    extractor: { apiVersion: 1, async extract() { return { nodes: [], edges: [] }; } },
  });
  const feature = createDreamMaintenanceFeature({
    api,
    tasks,
    scheduler,
    graph,
    planner,
    messagesPerJob: 2,
    now: () => 1_800_000_000_000,
  });
  return { feature, calls, api, planner, messages, getCurrentJob: () => selectedJob };
}

test('Dream runs bounded paged inputs in a DSH task and schedules an idempotent continuation', async () => {
  const { feature, calls, planner } = dependencies();
  const contextValue = context();
  const result = await feature.runScheduled(contextValue, 'dream-job-1');

  assert.equal(result.taskStatus, 'completed');
  assert.equal(calls.taskRequests.length, 1);
  assert.equal(calls.taskRequests[0].taskContext.actorId, scope.actorId);
  assert.equal(calls.taskRequests[0].request.metadata.source, 'conversation-maintenance');
  assert.equal(calls.taskRequests[0].request.sessionId, calls.taskRequests[0].request.taskId);
  assert.deepEqual(calls.taskRequests[0].request.metadata, {
    source: 'conversation-maintenance',
    maintenanceJobId: 'dream-job-1',
    kind: 'dream',
    workspaceId: scope.workspaceId,
    actorId: scope.actorId,
    idempotencyKey: 'dream-request-1',
    jobVersion: 1,
  });
  assert.equal(calls.pages.length, 2);
  assert.ok(calls.pages.every(page => page.limit === 1 && page.order === 'desc'));
  assert.equal(calls.checkpoints.length, 5, 'scan, immutable plan, idempotent write and batch commit checkpoints are persisted');
  assert.equal(planner.calls.length, 1);
  assert.deepEqual(planner.calls[0].messages.map(item => item.id), ['message-2', 'message-1']);
  assert.equal(calls.createMemories.length, 1);
  assert.deepEqual(calls.createMemories[0].sourceMessageIds, ['message-2']);
  assert.deepEqual(calls.createMemories[0].sourceRefs, [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['message-2'] }]);
  assert.equal(calls.maintenanceCreates.length, 1);
  assert.match(calls.maintenanceCreates[0].cursor, /^dream\.v1\./u);
  assert.equal(calls.schedules.at(-1).marker.kind, 'maintenance');
  assert.equal(calls.schedules.at(-1).marker.resourceId, 'dream-job-next');
});

test('Dream does not persist a plan after evidence authorization changes during inference', async () => {
  let authorizationCalls = 0;
  const { feature, calls } = dependencies({
    authorization: () => {
      authorizationCalls += 1;
      return {
        allowed: authorizationCalls < 3,
        currentAuthorizationEpoch: authorizationCalls < 3 ? scope.authorizationEpoch : scope.authorizationEpoch + 1,
        deniedSourceIds: authorizationCalls < 3 ? [] : ['message-2'],
      };
    },
  });
  await assert.rejects(feature.runScheduled(context(), 'dream-job-1'), /Dream evidence changed before apply/u);
  assert.equal(calls.createMemories.length, 0);
  assert.equal(calls.graphProposals.length, 0);
});

test('Dream graph plans require an exact provider apply and independent readback receipt', async () => {
  const { feature, calls } = dependencies({
    plan: async () => ({
      memoryWrites: [],
      graph: {
        nodes: [{ id: 'node-1', label: 'Acceptance', sourceMessageIds: ['message-2'] }],
        edges: [],
      },
    }),
    api: {
      async listGraphChangesets() {
        return { items: [{
          id: 'graph-change-1',
          idempotencyKey: 'graph-key',
          conversationId: scope.conversationId,
          conversationKind: scope.conversationKind,
          personaId: scope.personaId,
          sourceRefs: graphRefs,
          nodes: [{ id: 'node-1', label: 'Acceptance', sourceMessageIds: ['message-2'], sourceRefs: graphRefs }],
          edges: [],
          digest: 'proposal-digest',
          state: 'proposed',
          version: 1,
          providerStatus: 'ready',
          providerApplied: false,
          createdAt: 1,
          updatedAt: 1,
        }] };
      },
    },
  });
  await feature.runScheduled(context(), 'dream-job-1');
  assert.equal(calls.graphProposals.length, 1);
  assert.equal(calls.graphApplies.length, 1);
  assert.deepEqual(calls.graphProposals[0].nodes[0].sourceMessageIds, ['message-2']);
});

test('Dream refuses a graph projection if provider readback does not match the proposal digest', async () => {
  const { feature, calls, api } = dependencies({
    plan: async () => ({
      memoryWrites: [],
      graph: { nodes: [{ id: 'node-1', label: 'Acceptance', sourceMessageIds: ['message-2'] }], edges: [] },
    }),
    api: {
      async applyGraphChangeset() {
        return { changeset: {
          id: 'graph-change-1', version: 2, digest: 'proposal-digest',
          conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId,
          sourceRefs: graphRefs,
          nodes: [{ id: 'node-1', label: 'Acceptance', sourceMessageIds: ['message-2'], sourceRefs: graphRefs }], edges: [],
          providerApplied: true, state: 'projected',
          providerReceipt: { requestDigest: 'proposal-digest', readbackDigest: 'other-digest', nodeCount: 1, edgeCount: 0, appliedAt: 1 },
        } };
      },
    },
  });
  await assert.rejects(feature.runScheduled(context(), 'dream-job-1'), /Graph provider did not confirm/u);
  assert.equal(calls.createMemories.length, 0);
  assert.equal(typeof api.applyGraphChangeset, 'function');
});

test('Dream blocks retry after an unknown graph write until the exact provider receipt is reconciled', async () => {
  let providerApplied = false;
  let applyCalls = 0;
  const { feature, calls, api, getCurrentJob } = dependencies({
    plan: async () => ({
      memoryWrites: [{ kind: 'fact', text: 'The user is preparing acceptance.', evidenceMessageIds: ['message-2'] }],
      graph: { nodes: [{ id: 'node-1', label: 'Acceptance', sourceMessageIds: ['message-2'] }], edges: [] },
    }),
    api: {
      async createGraphProposal(_context, input) {
        calls.graphProposals.push(input);
        return { changeset: {
          id: 'graph-change-1', version: providerApplied ? 2 : 1,
          conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId,
          sourceRefs: graphRefs,
        } };
      },
      async listGraphChangesets() {
        return { items: [{
          id: 'graph-change-1', idempotencyKey: 'graph-key', conversationId: scope.conversationId,
          conversationKind: scope.conversationKind, personaId: scope.personaId, sourceRefs: graphRefs,
          nodes: [{ id: 'node-1', label: 'Acceptance', sourceMessageIds: ['message-2'], sourceRefs: graphRefs }], edges: [],
          digest: 'proposal-digest', state: providerApplied ? 'projected' : 'proposed', version: providerApplied ? 2 : 1,
          providerStatus: 'ready', providerApplied,
          ...(providerApplied ? { providerReceipt: {
            requestDigest: 'proposal-digest', readbackDigest: 'proposal-digest', nodeCount: 1, edgeCount: 0, appliedAt: 1_800_000_000_000,
          } } : {}),
          createdAt: 1, updatedAt: providerApplied ? 2 : 1,
        }] };
      },
      async applyGraphChangeset() {
        applyCalls += 1;
        providerApplied = true;
        throw new Error('provider applied but response was lost');
      },
    },
  });

  await assert.rejects(feature.runScheduled(context(), 'dream-job-1'), /response was lost/u);
  assert.equal(calls.createMemories.length, 0, 'the failed task stops before later derived writes');
  assert.ok(calls.checkpoints.every(value => value.cursor === null && value.processedCount === 0),
    'scan checkpoints retain the committed cursor until every side effect is reconciled');
  const failed = getCurrentJob();
  assert.equal(failed.details.retryable, false, 'unknown provider outcome is not blindly replayable');
  await assert.rejects(feature.retryFailed(context(), failed.id, failed.version), error => error.code === 'DREAM_JOB_NOT_RETRYABLE');

  const graph = createKnowledgeGraphFeature({
    api,
    extractor: { apiVersion: 1, async extract() { return { nodes: [], edges: [] }; } },
  });
  const reconciled = await graph.applyChangeset(context(), 'graph-change-1', 2);
  assert.equal(reconciled.receipt.readbackDigest, 'proposal-digest');
  assert.equal(applyCalls, 1, 'stored independent readback is reconciled without replaying the remote mutation');
  assert.equal(calls.graphProposals.length, 1);
  assert.equal(calls.createMemories.length, 0);
});

test('Dream retry reuses the exact persisted plan after a memory receipt is lost', async () => {
  let plannerCalls = 0;
  let memoryWrites = 0;
  const env = dependencies({
    plan: async () => {
      plannerCalls += 1;
      return plannerCalls === 1
        ? { memoryWrites: [{ kind: 'fact', text: 'The user is preparing the local acceptance.', evidenceMessageIds: ['message-2'], evidenceMemories: [{ memoryId: 'memory-501', version: 4 }] }], graph: { nodes: [], edges: [] } }
        : { memoryWrites: [], graph: { nodes: [], edges: [] } };
    },
    api: {
      async queryMemories(_context, input) {
        env.calls.queryMemories.push(input);
        return { items: [{
          memoryId: 'memory-501', version: 4, kind: 'fact', text: 'A current sourced fact.',
          sourceMessageIds: ['older-source'],
          sourceRefs: [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['older-source'] }],
          scope: { conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId, visibility: scope.visibility },
          authorizationEpoch: scope.authorizationEpoch, state: 'active', stale: false,
        }], authorizationEpoch: scope.authorizationEpoch };
      },
      async listMemories(_context, input) {
        env.calls.memoryLookups.push(input);
        return {
          items: input.memoryIds?.includes('memory-501') ? [{
            memoryId: 'memory-501', version: 4, kind: 'fact', text: 'A current sourced fact.',
            sourceMessageIds: ['older-source'],
            sourceRefs: [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['older-source'] }],
            scope: { conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId, visibility: scope.visibility },
            authorizationEpoch: scope.authorizationEpoch, state: 'active', stale: false,
          }] : [],
          authorizationEpoch: scope.authorizationEpoch,
        };
      },
      async createMemory(_context, input) {
        env.calls.createMemories.push(input);
        memoryWrites += 1;
        if (memoryWrites === 1) throw new Error('Work write response was lost after commit');
        return { memory: { memoryId: 'created-memory', version: 1, text: input.text }, duplicate: true };
      },
    },
  });

  await assert.rejects(env.feature.runScheduled(context(), 'dream-job-1'), /response was lost/u);
  const failed = env.getCurrentJob();
  assert.equal(failed.details.retryable, true);
  assert.ok(failed.details.dreamPlanV1, 'the exact validated plan survives the failed Task outcome');
  const retry = await env.feature.retryFailed(context(), failed.id, failed.version);
  const result = await env.feature.runScheduled(context(), retry.job.id);

  assert.equal(result.taskStatus, 'completed');
  assert.equal(plannerCalls, 1, 'recovery applies the stored plan without asking a non-deterministic model again');
  assert.equal(env.calls.createMemories.length, 2);
  assert.equal(env.calls.createMemories[0].idempotencyKey, env.calls.createMemories[1].idempotencyKey);
  assert.equal(env.calls.createMemories[1].text, 'The user is preparing the local acceptance.');
  assert.deepEqual(env.calls.memoryLookups[0].memoryIds, ['memory-501']);
  assert.equal(env.calls.retries.length, 1);
});

test('Dream resumes after graph projection and memory failure using the stored provider receipt and plan', async () => {
  let plannerCalls = 0;
  let graphProjected = false;
  let graphApplyCalls = 0;
  let memoryWrites = 0;
  const env = dependencies({
    plan: async () => {
      plannerCalls += 1;
      return plannerCalls === 1
        ? {
          memoryWrites: [{ kind: 'fact', text: 'The guide is part of release acceptance.', evidenceMessageIds: ['message-2'] }],
          graph: { nodes: [{ id: 'release-guide', label: 'Release guide', sourceMessageIds: ['message-2'] }], edges: [] },
        }
        : { memoryWrites: [], graph: { nodes: [], edges: [] } };
    },
    api: {
      async createGraphProposal(_context, input) {
        env.calls.graphProposals.push(input);
        return { changeset: {
          id: 'graph-change-1', version: graphProjected ? 2 : 1,
          conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId,
          nodes: input.nodes, edges: input.edges,
        } };
      },
      async listGraphChangesets() {
        const source = graphRefs;
        return { items: [{
          id: 'graph-change-1', idempotencyKey: env.calls.graphProposals[0]?.idempotencyKey ?? 'graph-key',
          conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId,
          nodes: [{ id: 'release-guide', label: 'Release guide', sourceMessageIds: ['message-2'], sourceRefs: source }],
          edges: [], sourceRefs: source, digest: 'proposal-digest',
          state: graphProjected ? 'projected' : 'proposed', version: graphProjected ? 2 : 1,
          providerStatus: graphProjected ? 'applied' : 'unavailable', providerApplied: graphProjected,
          ...(graphProjected ? { providerReceipt: {
          requestDigest: 'proposal-digest', readbackDigest: 'proposal-digest', nodeCount: 1, edgeCount: 0, appliedAt: 1_800_000_000_000,
          } } : {}),
          createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000,
        }] };
      },
      async applyGraphChangeset() {
        graphApplyCalls += 1;
        graphProjected = true;
        return { changeset: {
          id: 'graph-change-1', version: 2, digest: 'proposal-digest',
          conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId,
          sourceRefs: graphRefs,
          nodes: [{ id: 'release-guide', label: 'Release guide', sourceMessageIds: ['message-2'], sourceRefs: graphRefs }],
          edges: [], state: 'projected', providerStatus: 'applied', providerApplied: true,
          providerReceipt: { requestDigest: 'proposal-digest', readbackDigest: 'proposal-digest', nodeCount: 1, edgeCount: 0, appliedAt: 1_800_000_000_000 },
          createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000,
        } };
      },
      async createMemory(_context, input) {
        env.calls.createMemories.push(input);
        memoryWrites += 1;
        if (memoryWrites === 1) throw new Error('memory write response was lost after commit');
        return { memory: { memoryId: 'created-memory', version: 1, text: input.text }, duplicate: true };
      },
    },
  });

  await assert.rejects(env.feature.runScheduled(context(), 'dream-job-1'), /response was lost/u);
  const failed = env.getCurrentJob();
  assert.equal(failed.details.retryable, true);
  assert.ok(failed.details.dreamPlanV1);
  const retry = await env.feature.retryFailed(context(), failed.id, failed.version);
  const completed = await env.feature.runScheduled(context(), retry.job.id);

  assert.equal(completed.taskStatus, 'completed');
  assert.equal(plannerCalls, 1, 'recovery uses the persisted plan instead of recomputing it');
  assert.equal(graphApplyCalls, 1, 'the projected changeset readback receipt prevents a repeated provider write');
  assert.equal(env.calls.createMemories.length, 2);
  assert.equal(env.calls.createMemories[0].idempotencyKey, env.calls.createMemories[1].idempotencyKey);
  assert.equal(env.calls.retries.length, 1);
});

test('Dream recovery scans every queued keyset page instead of stopping at the first 500 jobs', async () => {
  const pages = [];
  const lateJob = job({ id: 'dream-job-after-page-500' });
  const env = dependencies({
    api: {
      async listMaintenanceJobs(_ctx, input) {
        pages.push(input);
        if (input.state === 'running') return { items: [], nextCursor: null };
        if (input.cursor === undefined) {
          return {
            items: Array.from({ length: 500 }, (_, index) => job({
              id: `other-job-${index}`,
              conversationId: 'another-conversation',
            })),
            nextCursor: 'queued-cursor-2',
          };
        }
        return { items: [lateJob], nextCursor: null };
      },
    },
  });
  const restored = await env.feature.recoverQueued(context());
  assert.equal(restored, 1);
  assert.equal(pages.length, 3, 'queued first page, queued second page, and running first page are read');
  assert.equal(pages[1].cursor, 'queued-cursor-2');
  assert.equal(env.calls.schedules.length, 1);
  assert.equal(env.calls.schedules[0].marker.resourceId, lateJob.id);
});

test('Dream disabled mode does not schedule or run background work', async () => {
  const { api, calls } = dependencies();
  const feature = createDreamMaintenanceFeature({
    api,
    tasks: { async run() { throw new Error('must not run'); }, async cancel() { return false; } },
    scheduler: { async ensureOneShot() { throw new Error('must not schedule'); }, async cancel() { return 0; } },
    graph: { apiVersion: 1 },
    enabled: false,
  });
  await assert.rejects(feature.runScheduled(context(), 'dream-job-1'), /disabled/u);
  assert.equal(calls.createMemories.length, 0);
});
