// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator conversation memory feature tests                  │
// │ Role: Verify scope, archival idempotency, cancellation and ACL recheck.│
// │ 模块职责：验证范围隔离、归档幂等、取消和发送前权限复验。                │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConversationFeatureError,
  createConversationMemoryFeature,
} from '../dist/features/conversation-memory.js';

const scope = {
  workspaceId: 'workspace-1',
  actorId: 'actor-1',
  conversationId: 'conversation-1',
  conversationKind: 'direct',
  personaId: 'persona-1',
  visibility: 'private',
  authorizationEpoch: 3,
};

let contextSequence = 0;

function trustedContext(overrides = {}) {
  contextSequence += 1;
  return {
    ...scope,
    taskId: `task-${contextSequence}`,
    sessionId: `session-${contextSequence}`,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function resourceScope(overrides = {}) {
  return {
    conversationId: scope.conversationId,
    conversationKind: scope.conversationKind,
    personaId: scope.personaId,
    visibility: scope.visibility,
    ...overrides,
  };
}

function memory(overrides = {}) {
  return {
    memoryId: 'memory-1',
    version: 1,
    kind: 'fact',
    text: 'The user prefers concise status updates.',
    sourceMessageIds: ['message-1'],
    scope: resourceScope(),
    authorizationEpoch: scope.authorizationEpoch,
    state: 'active',
    stale: false,
    ...overrides,
  };
}

function message(id, role = 'user', overrides = {}) {
  return {
    id,
    eventId: `event-${id}`,
    role,
    content: `Conversation content ${id} with enough detail to summarize.`,
    occurredAt: Date.UTC(2026, 9, 31, 12, Number(id.replace(/\D/gu, '') || 0)),
    status: 'active',
    scope: resourceScope(),
    ...overrides,
  };
}

function baseApi(overrides = {}) {
  const calls = { createMessages: [], listMessages: [], listMemories: [], queries: [], createMemories: [], authorizations: [] };
  const api = {
    apiVersion: 1,
    async createMessage(context, input) {
      calls.createMessages.push({ context, input });
      return { message: message('assistant-new', 'assistant'), duplicate: false };
    },
    async listMessages(context, input) {
      calls.listMessages.push({ context, input });
      return { items: [], nextCursor: null };
    },
    async listMemories(context, input) {
      calls.listMemories.push({ context, input });
      return { items: [], authorizationEpoch: context.authorizationEpoch };
    },
    async queryMemories(context, input) {
      calls.queries.push({ context, input });
      return { items: [], authorizationEpoch: context.authorizationEpoch };
    },
    async createMemory(context, input) {
      calls.createMemories.push({ context, input });
      return { memory: memory({ memoryId: 'memory-summary', text: input.text }), duplicate: false };
    },
    async authorizeSources(context, input) {
      calls.authorizations.push({ context, input });
      return { allowed: true, currentAuthorizationEpoch: context.authorizationEpoch, deniedSourceIds: [] };
    },
    ...overrides,
  };
  return { api, calls };
}

function summaryProvider(overrides = {}) {
  return {
    apiVersion: 1,
    calls: [],
    async summarize(input) {
      this.calls.push(input);
      return 'Summary: the user prefers concise updates and is preparing a local release.';
    },
    ...overrides,
  };
}

test('retrieval contributes only same-actor API results with matching persona and visibility', async () => {
  const { api, calls } = baseApi({
    async queryMemories(context, input) {
      calls.queries.push({ context, input });
      return { items: [
        memory(),
        memory({ memoryId: 'wrong-persona', scope: resourceScope({ personaId: 'persona-2' }) }),
        memory({ memoryId: 'wrong-thread', scope: resourceScope({ visibility: 'conversation', conversationKind: 'group' }) }),
        memory({ memoryId: 'invalidated', state: 'invalidated' }),
        memory({ memoryId: 'stale', stale: true }),
        memory({ memoryId: 'empty-source', sourceMessageIds: [] }),
      ], authorizationEpoch: context.authorizationEpoch };
    },
  });
  const feature = createConversationMemoryFeature({
    api,
    summaryProvider: summaryProvider(),
    contributionCharacterLimit: 1_000,
  });

  const result = await feature.beforeContext(trustedContext(), { query: 'What response style does the user prefer?' });
  assert.equal(calls.queries[0].context.actorId, 'actor-1', 'the authenticated actor stays in the host context');
  assert.equal(calls.authorizations.length, 1, 'retrieved sources are rechecked before entering model context');
  assert.equal(calls.authorizations[0].input.sourceRefs[0].memoryId, 'memory-1');
  assert.equal(calls.authorizations[0].input.sourceRefs[0].memoryVersion, 1);
  assert.deepEqual(result.contributions.map(item => item.sourceRefs[0].memoryId), ['memory-1']);
  assert.match(result.contributions[0].content, /prefers concise status updates/u);
});

test('beforeDelivery rechecks source authorization and fails closed on revocation, epoch change, or outage', async () => {
  let nextProof = { allowed: true, currentAuthorizationEpoch: 3, deniedSourceIds: [] };
  const { api, calls } = baseApi({
    async authorizeSources(context, input) {
      calls.authorizations.push({ context, input });
      if (nextProof instanceof Error) throw nextProof;
      return nextProof;
    },
  });
  const feature = createConversationMemoryFeature({ api, summaryProvider: summaryProvider() });
  const context = trustedContext();
  await feature.beforeContext(context, { query: '' });
  const delivery = {
    text: 'The user prefers concise updates.',
    sourceRefs: [{ memoryId: 'memory-1', memoryVersion: 1, sourceMessageIds: ['message-1'] }],
  };

  assert.deepEqual(await feature.beforeDelivery(context, delivery), { decision: 'allow', authorizationEpoch: 3 });
  assert.equal(calls.authorizations[0].input.authorizationEpoch, 3);
  assert.deepEqual(calls.authorizations[0].input.sourceRefs, delivery.sourceRefs);

  nextProof = { allowed: false, currentAuthorizationEpoch: 4, deniedSourceIds: ['memory-1'] };
  assert.deepEqual(await feature.beforeDelivery(context, delivery), {
    decision: 'hold', code: 'SOURCE_AUTHORIZATION_REVOKED', authorizationEpoch: 4,
  });

  nextProof = { allowed: true, currentAuthorizationEpoch: 4, deniedSourceIds: [] };
  assert.deepEqual(await feature.beforeDelivery(context, delivery), {
    decision: 'hold', code: 'SOURCE_AUTHORIZATION_EPOCH_CHANGED', authorizationEpoch: 4,
  });

  nextProof = new Error('private transport detail must not escape');
  assert.deepEqual(await feature.beforeDelivery(context, delivery), {
    decision: 'hold', code: 'SOURCE_AUTHORIZATION_UNAVAILABLE', authorizationEpoch: 3,
  });
});

test('revoked or corrected memory versions never enter context or pass a later delivery proof', async () => {
  const { api, calls } = baseApi({
    async queryMemories(context, input) {
      calls.queries.push({ context, input });
      return { items: [memory({ version: 2 })], authorizationEpoch: context.authorizationEpoch };
    },
    async authorizeSources(context, input) {
      calls.authorizations.push({ context, input });
      const referencesVersionTwo = input.sourceRefs.every(ref => ref.memoryVersion === 2);
      return {
        allowed: referencesVersionTwo && input.sourceRefs.length > 0,
        currentAuthorizationEpoch: context.authorizationEpoch,
        deniedSourceIds: referencesVersionTwo ? [] : ['message-1'],
      };
    },
  });
  const feature = createConversationMemoryFeature({ api, summaryProvider: summaryProvider() });
  const context = trustedContext();
  const result = await feature.beforeContext(context, { query: 'preference' });
  assert.equal(result.contributions[0].sourceRefs[0].memoryVersion, 2);

  const oldVersion = await feature.beforeDelivery(context, {
    text: 'answer',
    sourceRefs: [{ memoryId: 'memory-1', memoryVersion: 1, sourceMessageIds: ['message-1'] }],
  });
  assert.equal(oldVersion.decision, 'hold');
  assert.equal(oldVersion.code, 'SOURCE_PROOF_MISSING');

  const currentVersion = await feature.beforeDelivery(context, {
    text: 'answer',
    sourceRefs: [{ memoryId: 'memory-1', memoryVersion: 2, sourceMessageIds: ['message-1'] }],
  });
  assert.equal(currentVersion.decision, 'allow');
});

test('delivery holds when the host omits a memory source that this turn contributed to context', async () => {
  const { api, calls } = baseApi({
    async queryMemories(context) { return { items: [memory()], authorizationEpoch: context.authorizationEpoch }; },
  });
  const feature = createConversationMemoryFeature({ api, summaryProvider: summaryProvider() });
  const context = trustedContext();
  await feature.beforeContext(context, { query: 'preference' });

  const missing = await feature.beforeDelivery(context, { text: 'Concise response.', sourceRefs: [] });
  assert.deepEqual(missing, { decision: 'hold', code: 'SOURCE_PROOF_MISSING', authorizationEpoch: 3 });
  assert.equal(calls.authorizations.length, 1, 'a missing proof is rejected before delivery revalidation');

  const complete = await feature.beforeDelivery(context, {
    text: 'Concise response.',
    sourceRefs: [{ memoryId: 'memory-1', memoryVersion: 1, sourceMessageIds: ['message-1'] }],
  });
  assert.deepEqual(complete, { decision: 'allow', authorizationEpoch: 3 });
  assert.equal(calls.authorizations.length, 2);
});

test('delivery authorization receives every source reference beyond the old 64-reference boundary', async () => {
  const allReferences = Array.from({ length: 65 }, (_, index) => ({
    memoryId: `memory-${index}`,
    memoryVersion: 1,
    sourceMessageIds: [`source-${index}`],
  }));
  const { api, calls } = baseApi({
    async authorizeSources(context, input) {
      calls.authorizations.push({ context, input });
      return {
        allowed: !input.sourceRefs.some(item => item.memoryId === 'memory-64'),
        currentAuthorizationEpoch: context.authorizationEpoch,
        deniedSourceIds: ['source-64'],
      };
    },
  });
  const feature = createConversationMemoryFeature({ api, summaryProvider: summaryProvider() });
  const context = trustedContext();
  await feature.beforeContext(context, { query: '' });

  const decision = await feature.beforeDelivery(context, { text: 'answer', sourceRefs: allReferences });
  assert.equal(calls.authorizations[0].input.sourceRefs.length, 65);
  assert.deepEqual(decision, { decision: 'hold', code: 'SOURCE_AUTHORIZATION_REVOKED', authorizationEpoch: 3 });
});

test('delivery without a context-hook proof fails closed even when sourceRefs is empty', async () => {
  const { api, calls } = baseApi();
  const feature = createConversationMemoryFeature({ api, summaryProvider: summaryProvider() });
  const decision = await feature.beforeDelivery(trustedContext(), { text: 'answer', sourceRefs: [] });
  assert.deepEqual(decision, { decision: 'hold', code: 'SOURCE_PROOF_MISSING', authorizationEpoch: 3 });
  assert.equal(calls.authorizations.length, 0);
});

test('evicted turn proofs fail closed instead of becoming an empty source set', async () => {
  const { api } = baseApi({
    async queryMemories(context) { return { items: [memory()], authorizationEpoch: context.authorizationEpoch }; },
  });
  const feature = createConversationMemoryFeature({ api, summaryProvider: summaryProvider() });
  const original = trustedContext();
  await feature.beforeContext(original, { query: 'preference' });
  for (let index = 0; index < 2_049; index += 1) {
    await feature.beforeContext(trustedContext(), { query: '' });
  }
  const decision = await feature.beforeDelivery(original, { text: 'answer', sourceRefs: [] });
  assert.deepEqual(decision, { decision: 'hold', code: 'SOURCE_PROOF_MISSING', authorizationEpoch: 3 });
});

test('completed turns use the configured summarizer and archive only unarchived scoped messages idempotently', async () => {
  const existingMessages = Array.from({ length: 8 }, (_, index) => message(`message-${String(index).padStart(2, '0')}`, index % 2 === 0 ? 'user' : 'assistant'));
  const messagesByEvent = new Map();
  const { api, calls } = baseApi({
    async createMessage(context, input) {
      calls.createMessages.push({ context, input });
      if (!messagesByEvent.has(input.eventId)) {
        messagesByEvent.set(input.eventId, message('message-new-assistant', 'assistant', {
          eventId: input.eventId,
          content: input.content,
          sourceRefs: input.sourceRefs,
        }));
      }
      return { message: messagesByEvent.get(input.eventId), duplicate: calls.createMessages.length > 1 };
    },
    async listMessages(context, input) {
      calls.listMessages.push({ context, input });
      return { items: [...existingMessages, ...messagesByEvent.values()], nextCursor: null };
    },
    async listMemories(context, input) {
      calls.listMemories.push({ context, input });
      return {
        items: [
          memory({ memoryId: 'prior-summary', kind: 'episode', sourceMessageIds: ['message-00'] }),
          memory({ memoryId: 'user-fact', kind: 'fact', sourceMessageIds: ['message-01'] }),
        ],
        authorizationEpoch: context.authorizationEpoch,
      };
    },
  });
  const model = summaryProvider();
  const feature = createConversationMemoryFeature({
    api,
    summaryProvider: model,
    minimumMessages: 8,
    minimumCharacters: 200,
  });
  const context = trustedContext();
  const turn = {
    userEventId: 'user-event-9',
    assistantText: 'Here is the concise response.',
    status: 'completed',
    sourceRefs: [{ memoryId: 'memory-used', memoryVersion: 2, sourceMessageIds: ['source-original'] }],
  };

  await feature.beforeContext(context, { query: '' });
  await feature.afterTurn(context, turn);
  await feature.beforeContext(context, { query: '' });
  await feature.afterTurn(context, turn);

  assert.equal(calls.createMessages.length, 2);
  assert.equal(calls.createMessages[0].input.eventId, calls.createMessages[1].input.eventId);
  assert.deepEqual(calls.createMessages[0].input.sourceRefs, turn.sourceRefs);
  assert.deepEqual(calls.createMessages[0].input.relatedEventIds, [turn.userEventId]);
  assert.equal(model.calls.length, 2, 'the provider runs for each retry; Work API idempotency absorbs duplicate writes');
  assert.ok(model.calls[0].messages.every(item => item.id !== 'message-00'), 'previously archived source is excluded');
  assert.ok(model.calls[0].messages.some(item => item.id === 'message-01'), 'ordinary facts do not suppress episode archival');
  assert.equal(calls.createMemories.length, 2);
  assert.equal(calls.createMemories[0].input.idempotencyKey, calls.createMemories[1].input.idempotencyKey);
  assert.equal(calls.createMemories[0].input.kind, 'episode');
  assert.ok(calls.createMemories[0].input.sourceRefs.some(ref => ref.memoryId === 'memory-used' && ref.memoryVersion === 2));
  assert.ok(calls.createMemories[0].input.sourceRefs.some(ref => ref.memoryId === null && ref.sourceMessageIds.length >= 8));
  assert.equal(calls.createMemories[0].input.visibility, 'private');
  assert.ok(calls.createMemories[0].input.sourceMessageIds.length >= 8);
  assert.ok(calls.createMemories[0].input.sourceMessageIds.includes('source-original'), 'derived summaries retain transitive source dependencies');
  assert.equal('actorId' in calls.createMemories[0].input, false, 'actor identity is carried only by the authenticated context');
});

test('failed and aborted turns do not create assistant messages or summaries', async () => {
  const { api, calls } = baseApi();
  const model = summaryProvider();
  const feature = createConversationMemoryFeature({ api, summaryProvider: model });
  await feature.afterTurn(trustedContext(), { userEventId: 'event-1', assistantText: 'partial', status: 'failed' });
  await feature.afterTurn(trustedContext(), { userEventId: 'event-2', assistantText: 'partial', status: 'aborted' });
  assert.equal(calls.createMessages.length, 0);
  assert.equal(model.calls.length, 0);
});

test('summary archival refuses lineage overflow instead of persisting a truncated dependency set', async () => {
  const inherited = Array.from({ length: 127 }, (_, index) => `source-${index}`);
  const { api, calls } = baseApi({
    async listMessages(context, input) {
      calls.listMessages.push({ context, input });
      return {
        items: [
          message('message-1', 'user', {
            content: 'x'.repeat(150),
            sourceRefs: [{ memoryId: 'memory-parent', memoryVersion: 1, sourceMessageIds: inherited }],
          }),
          message('message-2', 'assistant', { content: 'y'.repeat(150) }),
        ],
        nextCursor: null,
      };
    },
  });
  const feature = createConversationMemoryFeature({
    api,
    summaryProvider: summaryProvider(),
    minimumMessages: 2,
    minimumCharacters: 200,
  });

  const context = trustedContext();
  await feature.beforeContext(context, { query: '' });
  await assert.rejects(
    feature.afterTurn(context, {
      userEventId: 'user-event-2', assistantText: 'Completed response.', status: 'completed', sourceRefs: [],
    }),
    error => error.code === 'INVALID_SOURCE_PROOF',
  );
  assert.equal(calls.createMemories.length, 0);
});

test('feature setup rejects a missing real summary provider and aborted retrieval does no I/O', async () => {
  const { api, calls } = baseApi();
  assert.throws(() => createConversationMemoryFeature({ api }), error => {
    assert.ok(error instanceof ConversationFeatureError);
    assert.equal(error.code, 'MODEL_UNAVAILABLE');
    return true;
  });

  const feature = createConversationMemoryFeature({ api, summaryProvider: summaryProvider() });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    feature.beforeContext(trustedContext({ signal: controller.signal }), { query: 'query' }),
    error => error.name === 'AbortError',
  );
  assert.equal(calls.queries.length, 0);
});

test('disabled memory preserves stored data, skips retrieval and writes, and still checks outgoing sources', async () => {
  const { api, calls } = baseApi();
  const feature = createConversationMemoryFeature({ api, enabled: false });
  const context = trustedContext();
  assert.deepEqual(await feature.beforeContext(context, { query: 'remembered fact' }), { contributions: [] });
  const delivery = await feature.beforeDelivery(context, {
    text: 'reply',
    sourceRefs: [{ memoryId: 'memory-old', memoryVersion: 1, sourceMessageIds: ['source-old'] }],
  });
  assert.deepEqual(delivery, { decision: 'allow', authorizationEpoch: 3 });
  await feature.afterTurn(context, {
    userEventId: 'event-disabled', assistantText: 'reply', status: 'completed', sourceRefs: [],
  });
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.createMessages.length, 0);
  assert.equal(calls.createMemories.length, 0);
  assert.equal(calls.authorizations.length, 1);
});
