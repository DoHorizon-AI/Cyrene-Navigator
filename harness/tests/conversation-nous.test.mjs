// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Nous active feature tests                         │
// │ Role: Verify policy, quiet hours, retraction and DSH turn dispatch.  │
// │ 模块职责：验证策略、静默时段、撤回和 DSH 对话任务分发。                │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNousActiveFeature } from '../dist/features/nous-active.js';

const scope = {
  workspaceId: 'workspace-1', actorId: 'actor-1', conversationId: 'conversation-1',
  conversationKind: 'direct', personaId: 'persona-1', visibility: 'private', authorizationEpoch: 9,
};
const fixedNow = Date.UTC(2026, 9, 31, 12, 0, 0);
const sourceRefs = [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['user-message-1'] }];

function context(overrides = {}) {
  return {
    ...scope,
    taskId: 'task-user-turn',
    sessionId: 'session-conversation',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function userMessage() {
  return {
    id: 'user-message-1', eventId: 'user-event-1', role: 'user', content: 'Please remind me to send the review.',
    occurredAt: fixedNow - 60_000, status: 'active', sourceRefs: [],
    scope: { conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId, visibility: scope.visibility },
  };
}

function focus(overrides = {}) {
  return {
    id: 'focus-1', idempotencyKey: 'focus-key', conversationId: scope.conversationId,
    conversationKind: scope.conversationKind, personaId: scope.personaId,
    kind: 'commitment', summary: 'Send the project review.', sourceRefs,
    dueAt: fixedNow + 60_000, condition: null, state: 'open', version: 1, createdAt: fixedNow, updatedAt: fixedNow,
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    conversationId: scope.conversationId, enabled: true,
    quietHours: { timeZone: 'UTC', start: '23:00', end: '07:00' },
    cooldownSeconds: 0, allowGroupInterjections: true, followupEnabled: true,
    version: 1, createdAt: fixedNow, updatedAt: fixedNow, ...overrides,
  };
}

function dependencies(overrides = {}) {
  const calls = { focusCreates: [], focusTransitions: [], handoffs: [], authorizations: [], schedules: [], cancels: [], dispatches: [], taskCancels: [], retractions: [], policies: [] };
  let currentFocus = focus();
  let currentPolicy = policy();
  let messages = [userMessage()];
  const api = {
    apiVersion: 1,
    async createMessage() { throw new Error('not used'); },
    async listMessages(_ctx, input) { return { items: messages, nextCursor: null }; },
    async listMemories() { return { items: [], authorizationEpoch: scope.authorizationEpoch }; },
    async queryMemories() { return { items: [], authorizationEpoch: scope.authorizationEpoch }; },
    async createMemory() { throw new Error('not used'); },
    async updateMemory() { throw new Error('not used'); },
    async deleteMemory() { throw new Error('not used'); },
    async revokeSource() { throw new Error('not used'); },
    async authorizeSources(ctx, input) {
      calls.authorizations.push(input);
      return { allowed: true, currentAuthorizationEpoch: ctx.authorizationEpoch, deniedSourceIds: [] };
    },
    async listPersonas() { return { items: [] }; },
    async putPersona() { throw new Error('not used'); },
    async listProfiles() { return { items: [] }; },
    async createProfileCandidate() { throw new Error('not used'); },
    async listProfileCandidates() { return { items: [] }; },
    async activateProfileCandidate() { throw new Error('not used'); },
    async rollbackProfile() { throw new Error('not used'); },
    async createGraphProposal() { throw new Error('not used'); },
    async queryGraph() { throw new Error('not used'); },
    async listGraphChangesets() { return { items: [] }; },
    async applyGraphChangeset() { throw new Error('not used'); },
    async createMaintenanceJob() { throw new Error('not used'); },
    async listMaintenanceJobs() { return { items: [] }; },
    async getMaintenanceJob() { throw new Error('not used'); },
    async retryMaintenanceJob() { throw new Error('not used'); },
    async cancelMaintenanceJob() { throw new Error('not used'); },
    async createResearchNote() { throw new Error('not used'); },
    async listResearchNotes() { return { items: [] }; },
    async createVerifiedSkill() { throw new Error('not used'); },
    async listVerifiedSkills() { return { items: [] }; },
    async createWatch() { throw new Error('not used'); },
    async listWatches() { return { items: [] }; },
    async cancelWatch() { throw new Error('not used'); },
    async scheduleWatch() { throw new Error('not used'); },
    async createFocusItem(_ctx, input) {
      calls.focusCreates.push(input);
      currentFocus = focus({ ...input, id: 'focus-created', state: 'open', version: 1 });
      return { item: currentFocus, duplicate: false };
    },
    async listFocusItems(_ctx, input) {
      if (input.state !== undefined && currentFocus.state !== input.state) return { items: [] };
      return { items: currentFocus.conversationId === input.conversationId ? [currentFocus] : [] };
    },
    async transitionFocusItem(_ctx, id, input) {
      calls.focusTransitions.push({ id, input });
      if (currentFocus.version !== input.expectedVersion) throw new Error('CAS mismatch');
      currentFocus = { ...currentFocus, state: input.state, version: currentFocus.version + 1, updatedAt: fixedNow + 1 };
      return { item: currentFocus };
    },
    async createHandoff(_ctx, input) {
      calls.handoffs.push(input);
      return { handoff: { id: 'handoff-1', ...input, createdAt: fixedNow }, duplicate: false };
    },
    async listHandoffs() { return { items: [] }; },
    async getActiveBehaviorPolicy() { calls.policies.push(currentPolicy); return currentPolicy; },
    async putActiveBehaviorPolicy(_ctx, input) {
      currentPolicy = { ...input, conversationId: scope.conversationId, version: currentPolicy.version + 1, createdAt: fixedNow, updatedAt: fixedNow };
      return currentPolicy;
    },
    ...overrides.api,
  };
  const scheduler = {
    async ensureOneShot(marker, dueAt, options) {
      calls.schedules.push({ marker, dueAt, options });
      return { record: { id: `schedule-${calls.schedules.length}` }, created: true, active: true };
    },
    async cancel(marker) { calls.cancels.push(marker); return 1; },
  };
  const tasks = {
    async dispatch(ctx, input) {
      calls.dispatches.push({ ctx, input });
      return overrides.dispatchResult ?? {
        taskId: input.taskId, status: 'completed', deliveryStatus: 'delivered', deliveryReceiptId: 'delivery-1',
      };
    },
    async cancel(_ctx, taskId) { calls.taskCancels.push(taskId); return overrides.cancelResult ?? true; },
    async retract(_ctx, taskId) {
      calls.retractions.push(taskId);
      return overrides.retractResult ?? { status: 'retracted', receiptId: 'delivery-1' };
    },
  };
  const feature = createNousActiveFeature({ api, scheduler, tasks, now: overrides.now ?? (() => fixedNow) });
  return {
    feature, calls, api,
    setPolicy(value) { currentPolicy = value; },
    setFocus(value) { currentFocus = value; },
    setMessages(value) { messages = value; },
  };
}

test('focus commitments bind to the source user message and queue one DSH Schedule reminder', async () => {
  const { feature, calls } = dependencies();
  const item = await feature.createFocusItem(context(), {
    userEventId: 'user-event-1', kind: 'commitment', summary: 'Send the project review.', dueAt: fixedNow + 60_000,
  });
  assert.equal(item.id, 'focus-created');
  assert.deepEqual(calls.focusCreates[0].sourceRefs, sourceRefs);
  assert.equal(calls.focusCreates[0].conversationKind, 'direct');
  assert.equal(calls.schedules.length, 1);
  assert.equal(calls.schedules[0].marker.kind, 'followup');
  assert.equal(calls.schedules[0].marker.resourceId, item.id);
});

test('quiet hours defer proactive work and group policy can hold it', async () => {
  const quietNow = Date.UTC(2026, 9, 31, 2, 0, 0);
  const quiet = dependencies({ now: () => quietNow });
  const decision = await quiet.feature.scheduleFollowup(context(), 'focus-1', quietNow + 5 * 60_000);
  assert.equal(decision.status, 'deferred');
  assert.ok(decision.dueAt > quietNow + 5 * 60_000);

  const group = dependencies();
  group.setPolicy(policy({ allowGroupInterjections: false }));
  group.setFocus(focus({ conversationId: 'group-1', conversationKind: 'group', visibility: 'conversation' }));
  const groupContext = context({ conversationId: 'group-1', conversationKind: 'group', visibility: 'conversation' });
  const held = await group.feature.scheduleFollowup(groupContext, 'focus-1', fixedNow + 60_000);
  assert.equal(held.status, 'held');
  assert.equal(group.calls.schedules.length, 0);
});

test('cooldown is checked against prior assistant messages before scheduling and dispatch', async () => {
  const env = dependencies();
  env.setPolicy(policy({ cooldownSeconds: 60 }));
  env.setMessages([
    { ...userMessage(), id: 'assistant-prior', eventId: 'assistant-prior-event', role: 'assistant', occurredAt: fixedNow - 20_000 },
  ]);
  const scheduled = await env.feature.scheduleFollowup(context(), 'focus-1', fixedNow + 10_000);
  assert.equal(scheduled.status, 'deferred');
  assert.equal(scheduled.dueAt, fixedNow + 40_000);

  const run = await env.feature.runScheduledFollowup(context(), 'focus-1');
  assert.equal(run.status, 'deferred');
  assert.equal(env.calls.dispatches.length, 0);
});

test('scheduled follow-up uses the existing DSH conversation task, marks origin and transitions to waiting after delivery', async () => {
  const env = dependencies();
  const turnContext = context();
  await env.feature.beforeContext(turnContext, { query: '' });
  const result = await env.feature.runScheduledFollowup(turnContext, 'focus-1');
  assert.equal(result.status, 'dispatched');
  assert.equal(env.calls.dispatches.length, 1);
  assert.equal(env.calls.dispatches[0].input.origin.kind, 'conversation-followup');
  assert.equal(env.calls.dispatches[0].input.executionClass, 'background');
  assert.deepEqual(env.calls.dispatches[0].input.sourceRefs, sourceRefs);
  assert.deepEqual(env.calls.focusTransitions[0].input, { state: 'waiting', expectedVersion: 1 });
});

test('a follow-up turn cannot create another focus trigger or send when policy is disabled at delivery', async () => {
  const loopContext = context({ origin: { kind: 'conversation-followup', sourceId: 'focus-1', externalEventId: 'event-followup' } });
  const env = dependencies();
  await assert.rejects(env.feature.createFocusItem(loopContext, {
    userEventId: 'user-event-1', kind: 'attention', summary: 'Repeat this.',
  }), error => error.code === 'FOLLOWUP_LOOP_BLOCKED');

  const deliveryContext = context({ origin: loopContext.origin });
  await env.feature.beforeContext(deliveryContext, { query: '' });
  env.setPolicy(policy({ enabled: false }));
  const decision = await env.feature.beforeDelivery(deliveryContext, { text: 'Follow-up.', sourceRefs, assistantEventId: 'assistant-pending' });
  assert.equal(decision.decision, 'hold');
  assert.equal(decision.code, 'PROACTIVE_POLICY_BLOCKED');
});

test('beforeDelivery rechecks current quiet hours and cooldown against the prior response', async () => {
  const quietNow = Date.UTC(2026, 9, 31, 2, 0, 0);
  const quiet = dependencies({ now: () => quietNow });
  const quietContext = context({ origin: { kind: 'conversation-followup', sourceId: 'focus-1', externalEventId: 'followup-event' } });
  await quiet.feature.beforeContext(quietContext, { query: '' });
  const quietDecision = await quiet.feature.beforeDelivery(quietContext, { text: 'Follow-up.', sourceRefs, assistantEventId: 'assistant-current' });
  assert.equal(quietDecision.decision, 'hold');
  assert.equal(quietDecision.code, 'PROACTIVE_QUIET_HOURS');

  const cooldown = dependencies();
  cooldown.setPolicy(policy({ cooldownSeconds: 60 }));
  cooldown.setMessages([
    { ...userMessage(), id: 'assistant-current', eventId: 'assistant-current', role: 'assistant', occurredAt: fixedNow },
    { ...userMessage(), id: 'assistant-prior', eventId: 'assistant-prior', role: 'assistant', occurredAt: fixedNow - 20_000 },
  ]);
  const cooldownContext = context({ origin: { kind: 'conversation-followup', sourceId: 'focus-1', externalEventId: 'followup-event' } });
  await cooldown.feature.beforeContext(cooldownContext, { query: '' });
  const cooldownDecision = await cooldown.feature.beforeDelivery(cooldownContext, {
    text: 'Follow-up.', sourceRefs, assistantEventId: 'assistant-current',
  });
  assert.equal(cooldownDecision.decision, 'hold');
  assert.equal(cooldownDecision.code, 'PROACTIVE_COOLDOWN');
});

test('retraction requires an independent task receipt and does not confuse a cancel request with not-sent proof', async () => {
  const env = dependencies({ retractResult: { status: 'unknown', receiptId: 'delivery-unknown' } });
  const unknown = await env.feature.retractFollowup(context(), 'focus-1', 1);
  assert.equal(unknown.taskCancellationRequested, true);
  assert.equal(unknown.retraction, 'unknown');
  assert.equal(env.calls.focusTransitions.length, 0);

  const confirmed = dependencies({ retractResult: { status: 'retracted', receiptId: 'delivery-1' } });
  const result = await confirmed.feature.retractFollowup(context(), 'focus-1', 1);
  assert.equal(result.retraction, 'retracted');
  assert.equal(confirmed.calls.focusTransitions[0].input.state, 'cancelled');
});

test('handoff preserves unresolved and unknown Work operation references with source lineage', async () => {
  const env = dependencies();
  const handoff = await env.feature.createHandoff(context(), {
    summary: 'Continue reviewing the local release.',
    unresolvedItems: ['Check callback behavior.'],
    unknownOperationRefs: ['work-op-uncertain-1'],
    sourceRefs,
  });
  assert.equal(handoff.id, 'handoff-1');
  assert.deepEqual(env.calls.handoffs[0].unknownOperationRefs, ['work-op-uncertain-1']);
  assert.deepEqual(env.calls.handoffs[0].sourceRefs, sourceRefs);
});
