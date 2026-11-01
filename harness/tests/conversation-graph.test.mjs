// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator graph feature tests                               │
// │ Role: Verify pre-model source authorization and provider readback.   │
// │ 模块职责：验证模型调用前授权及图谱提供方回读证明。                    │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeGraphFeature } from '../dist/features/knowledge-graph.js';

const scope = {
  workspaceId: 'workspace-1', actorId: 'actor-1', conversationId: 'conversation-1',
  conversationKind: 'direct', personaId: 'persona-1', visibility: 'private', authorizationEpoch: 5,
};

function context() {
  return { ...scope, taskId: 'task-1', sessionId: 'session-1', signal: new AbortController().signal };
}

function sourceMessage() {
  return {
    id: 'message-1', eventId: 'event-1', role: 'user', content: 'Aether graph source text.',
    occurredAt: 1_800_000_000_000, status: 'active',
    scope: { conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId, visibility: scope.visibility },
  };
}

function api(overrides = {}) {
  const calls = { authorizations: [], proposals: [], applies: [] };
  return {
    calls,
    value: {
      apiVersion: 1,
      async listMessages() { return { items: [sourceMessage()], nextCursor: null }; },
      async authorizeSources(turn, input) {
        calls.authorizations.push(input);
        return { allowed: true, currentAuthorizationEpoch: turn.authorizationEpoch, deniedSourceIds: [] };
      },
      async createGraphProposal(_context, input) {
        calls.proposals.push(input);
        return { changeset: { id: 'changeset-1', version: 1 } };
      },
      async listGraphChangesets() {
        return { items: [{
          id: 'changeset-1', idempotencyKey: 'graph-key', conversationId: scope.conversationId,
          conversationKind: scope.conversationKind, personaId: scope.personaId,
          sourceRefs: [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['message-1'] }],
          nodes: [{ id: 'node-1', label: 'Aether', sourceMessageIds: ['message-1'], sourceRefs: [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['message-1'] }] }], edges: [],
          digest: 'digest-1', state: 'proposed', version: 1, providerStatus: 'ready', providerApplied: false,
          createdAt: 1, updatedAt: 1,
        }] };
      },
      async applyGraphChangeset() {
        calls.applies.push(true);
        return { changeset: {
          id: 'changeset-1', version: 2, digest: 'digest-1',
          conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId,
          sourceRefs: [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['message-1'] }],
          nodes: [{ id: 'node-1', label: 'Aether', sourceMessageIds: ['message-1'], sourceRefs: [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['message-1'] }] }], edges: [],
          state: 'projected', providerStatus: 'ready', providerApplied: true,
          providerReceipt: { requestDigest: 'digest-1', readbackDigest: 'digest-1', nodeCount: 1, edgeCount: 0, appliedAt: 1_800_000_000_000 },
          createdAt: 1, updatedAt: 2,
        } };
      },
      ...overrides,
    },
  };
}

function extractor(overrides = {}) {
  const calls = [];
  return {
    calls,
    value: {
      apiVersion: 1,
      async extract(input) {
        calls.push(input);
        return { nodes: [{ id: 'node-1', label: 'Aether' }], edges: [] };
      },
      ...overrides,
    },
  };
}

test('revoked source text never reaches the graph model', async () => {
  const base = api({
    async authorizeSources(turn, input) {
      base.calls.authorizations.push(input);
      return { allowed: false, currentAuthorizationEpoch: turn.authorizationEpoch + 1, deniedSourceIds: ['message-1'] };
    },
  });
  const model = extractor();
  const feature = createKnowledgeGraphFeature({ api: base.value, extractor: model.value });
  assert.equal(await feature.afterTurn(context(), {
    userEventId: 'event-1', assistantText: 'Answer.', status: 'completed', sourceRefs: [],
  }), undefined);
  assert.equal(model.calls.length, 0);
  assert.equal(base.calls.proposals.length, 0);
});

test('graph extractor proposals receive host-owned source ids and are reauthorized before write', async () => {
  const base = api();
  const model = extractor();
  const feature = createKnowledgeGraphFeature({ api: base.value, extractor: model.value });
  const changeset = await feature.afterTurn(context(), {
    userEventId: 'event-1', assistantText: 'Answer.', status: 'completed', sourceRefs: [],
  });
  assert.equal(changeset.id, 'changeset-1');
  assert.equal(model.calls.length, 1);
  assert.deepEqual(base.calls.authorizations.map(input => input.sourceRefs[0].sourceMessageIds), [['message-1'], ['message-1']]);
  assert.deepEqual(base.calls.proposals[0].nodes[0].sourceMessageIds, ['message-1']);
});

test('graph apply accepts only the exact independent provider readback receipt', async () => {
  const base = api();
  const feature = createKnowledgeGraphFeature({
    api: base.value,
    extractor: { apiVersion: 1, async extract() { return { nodes: [], edges: [] }; } },
  });
  const applied = await feature.applyChangeset(context(), 'changeset-1', 1);
  assert.equal(applied.receipt.requestDigest, 'digest-1');
  assert.equal(applied.receipt.readbackDigest, 'digest-1');
  assert.equal(base.calls.applies.length, 1);

  const mismatch = api({
    async applyGraphChangeset() {
      return { changeset: {
        id: 'changeset-1', version: 2, digest: 'digest-1',
        conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId,
        sourceRefs: [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['message-1'] }],
        nodes: [{ id: 'node-1', label: 'Aether', sourceMessageIds: ['message-1'], sourceRefs: [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['message-1'] }] }], edges: [],
        state: 'projected', providerStatus: 'ready', providerApplied: true,
        providerReceipt: { requestDigest: 'digest-1', readbackDigest: 'other', nodeCount: 1, edgeCount: 0, appliedAt: 1_800_000_000_000 },
        createdAt: 1, updatedAt: 2,
      } };
    },
  });
  const unsafe = createKnowledgeGraphFeature({
    api: mismatch.value,
    extractor: { apiVersion: 1, async extract() { return { nodes: [], edges: [] }; } },
  });
  await assert.rejects(unsafe.applyChangeset(context(), 'changeset-1', 1), error => error.code === 'GRAPH_PROVIDER_READBACK_MISMATCH');
});
