// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator persona and profile feature tests                  │
// │ Role: Verify sourced candidates, scope filtering and explicit review. │
// │ 模块职责：验证画像证据、人格/会话隔离与显式审核流程。                  │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationFeatureError } from '../dist/features/conversation-memory.js';
import { createPersonaProfileFeature } from '../dist/features/persona-profile.js';

const baseScope = {
  workspaceId: 'workspace-profile',
  actorId: 'actor-profile',
  conversationId: 'direct-profile',
  conversationKind: 'direct',
  personaId: 'persona-work',
  visibility: 'private',
  authorizationEpoch: 7,
};

let sequence = 0;
function trusted(overrides = {}) {
  sequence += 1;
  return {
    ...baseScope,
    taskId: `task-profile-${sequence}`,
    sessionId: `session-profile-${sequence}`,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function resourceScope(overrides = {}) {
  return {
    conversationId: baseScope.conversationId,
    conversationKind: baseScope.conversationKind,
    personaId: baseScope.personaId,
    visibility: baseScope.visibility,
    ...overrides,
  };
}

function message(overrides = {}) {
  return {
    id: 'user-message-1',
    eventId: 'user-event-1',
    role: 'user',
    content: 'Please keep the progress report concise and include risks.',
    occurredAt: 1_798_000_000_000,
    status: 'active',
    sourceRefs: [],
    scope: resourceScope(),
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    id: 'candidate-1',
    candidateId: 'candidate-source-1',
    idempotencyKey: 'candidate-key-1',
    conversationId: 'another-direct-chat',
    conversationKind: 'direct',
    subjectKind: 'user',
    personaId: 'persona-work',
    category: 'preference',
    text: 'Keep progress updates concise and include risks.',
    sourceMessageIds: ['source-direct-1'],
    sourceRefs: [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['source-direct-1'] }],
    confidence: 0.91,
    validUntil: null,
    state: 'active',
    version: 2,
    previousProfileId: null,
    evidence: { sourceMessageIds: ['source-direct-1'], confidence: 0.91 },
    createdAt: 1_798_000_000_000,
    updatedAt: 1_798_000_000_000,
    ...overrides,
  };
}

function createApi(overrides = {}) {
  const calls = {
    authorize: [],
    candidates: [],
    candidateReads: [],
    profileReads: [],
    personas: [],
    messages: [],
    activations: [],
    rollbacks: [],
  };
  const api = {
    apiVersion: 1,
    async createMessage() { return { message: message({ role: 'assistant' }), duplicate: false }; },
    async listMessages(context, input) {
      calls.messages.push({ context, input });
      return { items: [message()], nextCursor: null };
    },
    async listMemories(context) { return { items: [], authorizationEpoch: context.authorizationEpoch }; },
    async queryMemories(context) { return { items: [], authorizationEpoch: context.authorizationEpoch }; },
    async createMemory() { throw new Error('profile tests must not create memory records'); },
    async authorizeSources(context, input) {
      calls.authorize.push({ context, input });
      return { allowed: true, currentAuthorizationEpoch: context.authorizationEpoch, deniedSourceIds: [] };
    },
    async listPersonas(context, input) {
      calls.personas.push({ context, input });
      return { items: [{
        id: 'persona-work', name: 'Work', description: 'Work persona', prompt: 'Use precise work language.',
        enabled: true, conversationIds: [], version: 1, createdAt: 1, updatedAt: 1,
      }] };
    },
    async putPersona(_context, input) { return { persona: { id: input.id, ...input, description: input.description ?? '', conversationIds: input.conversationIds ?? [], version: 1, createdAt: 1, updatedAt: 1 } }; },
    async createProfileCandidate(context, input) {
      calls.candidates.push({ context, input });
      return { candidate: candidate({ ...input, id: `candidate-${calls.candidates.length}`, state: 'candidate', version: 1 }), duplicate: false };
    },
    async listProfileCandidates(context, input) {
      calls.candidateReads.push({ context, input });
      return { items: [] };
    },
    async listProfiles(context, input) {
      calls.profileReads.push({ context, input });
      return { items: [] };
    },
    async activateProfileCandidate(context, candidateId, expectedVersion) {
      calls.activations.push({ context, candidateId, expectedVersion });
      return { profile: { id: 'profile-1', candidateId, conversationId: context.conversationId, subjectKind: 'user', personaId: context.personaId, category: 'preference', text: 'Concise', sourceMessageIds: ['source-direct-1'], evidence: {}, validUntil: null, state: 'active', version: 1, previousProfileId: null, createdAt: 1, updatedAt: 1 } };
    },
    async rollbackProfile(context, profileId, expectedVersion) {
      calls.rollbacks.push({ context, profileId, expectedVersion });
      return { profile: { id: profileId, candidateId: 'candidate-1', conversationId: context.conversationId, subjectKind: 'user', personaId: context.personaId, category: 'preference', text: 'Concise', sourceMessageIds: ['source-direct-1'], evidence: {}, validUntil: null, state: 'rolled_back', version: expectedVersion + 1, previousProfileId: null, createdAt: 1, updatedAt: 2 } };
    },
    async createGraphProposal() { throw new Error('graph test method not expected'); },
    async queryGraph() { throw new Error('graph test method not expected'); },
    async listGraphChangesets() { return { items: [] }; },
    async applyGraphChangeset() { throw new Error('graph test method not expected'); },
    async createMaintenanceJob() { throw new Error('maintenance test method not expected'); },
    async listMaintenanceJobs() { return { items: [] }; },
    async getMaintenanceJob() { throw new Error('maintenance test method not expected'); },
    async checkpointMaintenanceJob() { throw new Error('maintenance test method not expected'); },
    async createResearchNote() { throw new Error('research test method not expected'); },
    async listResearchNotes() { return { items: [] }; },
    async createVerifiedSkill() { throw new Error('skill test method not expected'); },
    async listVerifiedSkills() { return { items: [] }; },
    async createWatch() { throw new Error('watch test method not expected'); },
    async listWatches() { return { items: [] }; },
    async cancelWatch() { throw new Error('watch test method not expected'); },
    async createFocusItem() { throw new Error('focus test method not expected'); },
    async listFocusItems() { return { items: [] }; },
    async transitionFocusItem() { throw new Error('focus test method not expected'); },
    async createHandoff() { throw new Error('handoff test method not expected'); },
    async listHandoffs() { return { items: [] }; },
    async getActiveBehaviorPolicy() { return null; },
    async putActiveBehaviorPolicy() { throw new Error('policy test method not expected'); },
    ...overrides,
  };
  return { api, calls };
}

function extractor(overrides = {}) {
  const calls = [];
  return {
    apiVersion: 1,
    calls,
    async extract(input) {
      calls.push(input);
      return [
        { category: 'preference', text: 'Keep reports concise and include risks.', confidence: 0.93 },
        { category: 'temporary_state', text: 'Preparing a release this week.', confidence: 0.8, validUntil: 1_798_100_000_000 },
      ];
    },
    ...overrides,
  };
}

test('profile extraction creates sourced candidates only and never activates them automatically', async () => {
  const { api, calls } = createApi();
  const model = extractor();
  const feature = createPersonaProfileFeature({ api, extractor: model, now: () => 1_798_000_000_001 });
  const context = trusted();
  const input = { userEventId: 'user-event-1', assistantText: 'Acknowledged.', status: 'completed', sourceRefs: [] };

  const first = await feature.afterTurn(context, input);
  const second = await feature.afterTurn(context, input);
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.equal(model.calls[0].message.content, 'Please keep the progress report concise and include risks.');
  assert.deepEqual(calls.candidates[0].input.sourceMessageIds, ['user-message-1']);
  assert.equal(calls.candidates[0].input.subjectKind, 'user');
  assert.equal(calls.candidates[0].input.personaId, 'persona-work');
  assert.equal(calls.candidates[0].input.idempotencyKey, calls.candidates[2].input.idempotencyKey);
  assert.equal(calls.activations.length, 0, 'all model results remain candidates pending review');
  assert.equal(calls.authorize.length, 4, 'the user message is authorized before extraction and again before candidate writes');
});

test('context includes only active profiles matching actor kind, conversation and persona, after source recheck', async () => {
  const ownProfile = candidate();
  const { api, calls } = createApi({
    async listProfiles(context, input) {
      calls.profileReads.push({ context, input });
      return { items: [
        ownProfile,
        candidate({ id: 'wrong-persona', personaId: 'persona-other' }),
        candidate({ id: 'group-only', subjectKind: 'group', conversationId: context.conversationId }),
        candidate({ id: 'expired', validUntil: 1_797_000_000_000 }),
      ] };
    },
  });
  const feature = createPersonaProfileFeature({ api, extractor: extractor(), now: () => 1_798_000_000_000 });
  const context = trusted();

  const result = await feature.beforeContext(context, { query: 'response style' });
  assert.equal(result.persona?.id, 'persona-work');
  assert.equal(result.persona?.prompt, 'Use precise work language.');
  assert.equal(result.contributions.length, 1);
  assert.match(result.contributions[0].content, /Keep progress updates concise/u);
  assert.equal(calls.authorize.length, 1);
  assert.deepEqual(calls.authorize[0].input.sourceRefs, [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['source-direct-1'] }]);

  const missing = await feature.beforeDelivery(context, { text: 'Concise.', sourceRefs: [] });
  assert.equal(missing.decision, 'hold');
  const allowed = await feature.beforeDelivery(context, {
    text: 'Concise.',
    sourceRefs: [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['source-direct-1'] }],
  });
  assert.deepEqual(allowed, { decision: 'allow', authorizationEpoch: context.authorizationEpoch });
});

test('group contexts never include user-private profile candidates from direct chats', async () => {
  const { api } = createApi({
    async listProfiles(context) {
      return { items: [
        candidate({ id: 'private-user', subjectKind: 'user', conversationId: 'direct-profile' }),
        candidate({ id: 'other-group', subjectKind: 'group', conversationId: 'different-group' }),
        candidate({ id: 'current-group', subjectKind: 'group', conversationId: context.conversationId }),
      ] };
    },
  });
  const feature = createPersonaProfileFeature({ api, extractor: extractor() });
  const context = trusted({
    conversationId: 'group-current',
    conversationKind: 'group',
    visibility: 'conversation',
  });
  const result = await feature.beforeContext(context, { query: 'profile' });
  assert.equal(result.contributions.length, 1);
  assert.match(result.contributions[0].content, /Keep progress updates concise/u);
});

test('temporary profile candidates require a future expiration and explicit approval APIs keep versions', async () => {
  const { api, calls } = createApi();
  const feature = createPersonaProfileFeature({
    api,
    extractor: extractor({ async extract() {
      return [{ category: 'temporary_state', text: 'Temporary state.', confidence: 0.7 }];
    } }),
  });
  await assert.rejects(
    feature.afterTurn(trusted(), {
      userEventId: 'user-event-1', assistantText: 'Done.', status: 'completed', sourceRefs: [],
    }),
    error => error instanceof ConversationFeatureError && error.code === 'MODEL_UNAVAILABLE',
  );

  const context = trusted();
  await feature.activateCandidate(context, 'candidate-review', 4);
  await feature.rollbackProfile(context, 'profile-live', 5);
  assert.deepEqual(calls.activations.map(call => [call.candidateId, call.expectedVersion]), [['candidate-review', 4]]);
  assert.deepEqual(calls.rollbacks.map(call => [call.profileId, call.expectedVersion]), [['profile-live', 5]]);
});

test('revoked user evidence is rejected before profile extraction sees its content', async () => {
  const { api, calls } = createApi({
    async authorizeSources(context, input) {
      calls.authorize.push({ context, input });
      return { allowed: false, currentAuthorizationEpoch: context.authorizationEpoch + 1, deniedSourceIds: ['user-message-1'] };
    },
  });
  const model = extractor();
  const feature = createPersonaProfileFeature({ api, extractor: model });
  const candidates = await feature.afterTurn(trusted(), {
    userEventId: 'user-event-1', assistantText: 'Done.', status: 'completed', sourceRefs: [],
  });
  assert.deepEqual(candidates, []);
  assert.equal(model.calls.length, 0);
  assert.equal(calls.candidates.length, 0);
  assert.equal(calls.authorize.length, 1);
});

test('disabled profile feature preserves data and writes nothing while final source checks remain active', async () => {
  const { api, calls } = createApi();
  const feature = createPersonaProfileFeature({ api, enabled: false });
  const context = trusted();
  assert.deepEqual(await feature.beforeContext(context, { query: 'ignored' }), { persona: null, contributions: [] });
  assert.deepEqual(await feature.afterTurn(context, {
    userEventId: 'user-event-1', assistantText: 'Done.', status: 'completed', sourceRefs: [],
  }), []);
  const decision = await feature.beforeDelivery(context, { text: 'Done.', sourceRefs: [] });
  assert.deepEqual(decision, { decision: 'allow', authorizationEpoch: context.authorizationEpoch });
  assert.equal(calls.personas.length, 0);
  assert.equal(calls.candidateReads.length, 0);
  assert.equal(calls.profileReads.length, 0);
  assert.equal(calls.candidates.length, 0);
  assert.equal(calls.authorize.length, 1);
});
