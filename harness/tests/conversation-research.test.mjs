// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator research/work feature tests                       │
// │ Role: Verify actual Work receipt gating for notes, skills and watches.│
// │ 模块职责：验证笔记、技能和观察任务必须由 Work 回执支持。               │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createResearchWorkFeature } from '../dist/features/research-work.js';

const scope = {
  workspaceId: 'workspace-1', actorId: 'actor-1', conversationId: 'conversation-1',
  conversationKind: 'direct', personaId: 'persona-1', visibility: 'private', authorizationEpoch: 11,
};
const now = Date.UTC(2026, 9, 31, 12);
const sourceRefs = [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['source-message-1'] }];
const sourceEvidence = [{
  sourceRef: `sha256:${sha('source-reference-1')}`,
  kind: 'web',
  title: 'Release guide',
  url: 'https://example.test/release-guide',
  sourceSha256: sha('source bytes'),
  retrievedAt: now,
}];

function context(overrides = {}) {
  return { ...scope, taskId: 'task-1', sessionId: 'session-1', signal: new AbortController().signal, ...overrides };
}

function sha(value) { return createHash('sha256').update(value).digest('hex'); }

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function userMessage() {
  return {
    id: 'user-message-1', eventId: 'user-event-1', role: 'user', content: 'Read the release guide and make a sourced note.',
    occurredAt: now - 1_000, status: 'active', sourceRefs: [],
    scope: { conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId, visibility: scope.visibility },
  };
}

function receipt(id, overrides = {}) {
  return {
    id, trustedProducer: 'conversation-research-runtime', workspaceId: scope.workspaceId, actorId: scope.actorId,
    taskId: 'task-with-verified-work-result',
    taskStatus: 'completed', taskOutputSha256: sha(`task-output:${id}`),
    status: 'verified', operationType: 'conversation.research.read.v1', effect: 'read',
    resultSha256: sha(`result:${id}`), contentSha256: sha(`content:${id}`), targetDigestSha256: sha('target'),
    sourceRefs, sourceEvidence, verifiedAt: now, ...overrides,
  };
}

function makeDependencies(overrides = {}) {
  const calls = { notes: [], skills: [], watches: [], scheduleUpdates: [], authorizations: [], taskRuns: [], finalizations: [], watchObservations: [], schedules: [], cancellations: [] };
  let watches = [];
  let nextReceiptById = new Map();
  const completedTasks = new Map();
  let messages = [userMessage()];
  const api = {
    apiVersion: 1,
    async createMessage() { throw new Error('not used'); },
    async listMessages() { return { items: messages, nextCursor: null }; },
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
    async createResearchNote(_ctx, input) {
      calls.notes.push(input);
      return { note: { id: `note-${calls.notes.length}`, revision: 1, ...input, createdAt: now }, duplicate: false };
    },
    async listResearchNotes() { return { items: [] }; },
    async createVerifiedSkill(_ctx, input) {
      calls.skills.push(input);
      const write = nextReceiptById.get(input.operationReceiptId);
      const readback = nextReceiptById.get(input.independentReadReceiptId);
      const writeEvidence = write.skillWriteEvidence;
      const readbackEvidence = readback.skillReadbackEvidence;
      return {
        skill: {
          id: 'skill-1', revision: 1, verified: true, verifiedBy: 'server-actor', verifiedAt: now, createdAt: now,
          evidence: {
            actionId: writeEvidence.actionId,
            targetDigestSha256: writeEvidence.targetDigestSha256,
            inputSha256: writeEvidence.inputSha256,
            guideVersion: writeEvidence.guideVersion,
            guideSha256: writeEvidence.guideSha256,
            actionEffectOperationId: writeEvidence.actionEffectOperationId,
            readbackEffectOperationId: readbackEvidence.readbackEffectOperationId,
            effectOutcome: writeEvidence.effectOutcome,
            effectResultSha256: writeEvidence.effectResultSha256,
            effectReadbackOutcome: readbackEvidence.effectReadbackOutcome,
            effectReadbackSha256: readbackEvidence.effectReadbackSha256,
            readbackVerified: readbackEvidence.readbackVerified,
            sourceRef: writeEvidence.sourceRef,
            canonicalUrl: writeEvidence.canonicalUrl,
            sourceSha256: writeEvidence.sourceSha256,
            workArtifactSha256: writeEvidence.workArtifactSha256,
          },
          ...input,
        },
        duplicate: false,
      };
    },
    async listVerifiedSkills() { return { items: [] }; },
    async createWatch(_ctx, input) {
      calls.watches.push(input);
      const watch = {
        id: 'watch-1', version: 1, state: 'active', nextCheckAt: input.nextCheckAt,
        lastResultSha256: null, lastOperationReceiptId: null,
        ownerTaskId: _ctx.taskId, ownerSessionId: _ctx.sessionId,
        createdAt: now, updatedAt: now, ...input,
      };
      watches = [watch];
      return { watch, duplicate: false };
    },
    async listWatches(_ctx, input) {
      return { items: watches.filter(watch => (input.state === undefined || watch.state === input.state)
        && (input.conversationId === undefined || watch.conversationId === input.conversationId)), nextCursor: null };
    },
    async cancelWatch(_ctx, id, expectedVersion) {
      const current = watches.find(watch => watch.id === id);
      if (!current || current.version !== expectedVersion) throw new Error('watch CAS mismatch');
      const updated = { ...current, state: 'cancelled', version: current.version + 1 };
      watches = [updated];
      return { watch: updated };
    },
    async scheduleWatch(_ctx, id, input) {
      calls.scheduleUpdates.push({ id, input });
      const current = watches.find(watch => watch.id === id);
      if (!current || current.version !== input.expectedVersion) throw new Error('watch CAS mismatch');
      const updated = { ...current, nextCheckAt: input.nextCheckAt, version: current.version + 1 };
      watches = [updated];
      return { watch: updated };
    },
    async recordWatchObservation(_ctx, id, input) {
      calls.scheduleUpdates.push({ id, input });
      const current = watches.find(watch => watch.id === id);
      if (!current || current.version !== input.expectedVersion) throw new Error('watch CAS mismatch');
      const updated = {
        ...current,
        nextCheckAt: input.nextCheckAt,
        lastResultSha256: input.resultSha256,
        lastOperationReceiptId: input.operationReceiptId,
        version: current.version + 1,
      };
      watches = [updated];
      return { watch: updated };
    },
    async createFocusItem() { throw new Error('not used'); },
    async listFocusItems() { return { items: [] }; },
    async transitionFocusItem() { throw new Error('not used'); },
    async createHandoff() { throw new Error('not used'); },
    async listHandoffs() { return { items: [] }; },
    async getActiveBehaviorPolicy() { return null; },
    async putActiveBehaviorPolicy() { throw new Error('not used'); },
    ...overrides.api,
  };
  const reader = {
    apiVersion: 1,
    async read(_ctx, id) {
      const value = nextReceiptById.get(id);
      if (!value) throw new Error(`missing receipt ${id}`);
      return value;
    },
    async finalize(_ctx, childTask, input) {
      calls.finalizations.push({ childTask, input });
      const completed = completedTasks.get(childTask.taskId);
      if (!completed) throw new Error('finalizer requires a completed Task');
      assert.equal(completed.outcome.status, 'completed');
      assert.deepEqual(input.sourceRefs, completed.request.metadata.sourceRefs);
      const envelope = JSON.parse(completed.outcome.output);
      const operationId = completed.request.metadata.source === 'conversation-watch'
        ? 'operation-watch-1' : 'operation-read-1';
      const prior = nextReceiptById.get(operationId);
      nextReceiptById.set(operationId, {
        ...prior,
        taskId: childTask.taskId,
        taskStatus: 'completed',
        taskOutputSha256: sha(completed.outcome.output),
        resultSha256: envelope.resultSha256,
        contentSha256: overrides.finalizedReceiptContentSha256 ?? envelope.contentSha256,
        sourceRefs: input.sourceRefs,
        sourceEvidence: envelope.sourceEvidence,
      });
      return { operationId };
    },
  };
  const tasks = {
    async runFeatureTask(_ctx, request, operation, signal) {
      calls.taskRuns.push(request);
      const output = await operation({ id: request.sessionId }, signal);
      const outcome = { taskId: request.taskId, sessionId: request.sessionId, status: 'completed', output, reasoning: '', durationMs: 1 };
      completedTasks.set(request.taskId, { request, outcome });
      return outcome;
    },
    async cancelFeatureTask(_ctx, taskId) { calls.cancellations.push(taskId); return true; },
  };
  const scheduler = {
    async ensureOneShot(marker, dueAt, options) {
      calls.schedules.push({ marker, dueAt, options });
      return { record: { id: `schedule-${calls.schedules.length}` }, created: true, active: true };
    },
    async cancel(marker) { calls.cancellations.push(marker); return 1; },
  };
  const readResult = {
    artifactId: 'research-artifact-1', title: 'Release guide', content: 'A sourced release guide result.',
    resultSha256: sha('result:operation-read-1'), contentSha256: sha('A sourced release guide result.'),
    sourceEvidence,
  };
  nextReceiptById.set('operation-read-1', receipt('operation-read-1', { contentSha256: readResult.contentSha256 }));
  const readerProvider = { apiVersion: 1, async read() { return readResult; } };
  const watcher = {
    apiVersion: 1,
    async observe(input) {
      calls.watchObservations.push(input);
      const result = {
        artifactId: 'watch-artifact-1', title: 'Release changed', content: 'The release guide changed.',
        resultSha256: sha('result:operation-watch-1'), contentSha256: sha('The release guide changed.'),
        sourceEvidence,
      };
      nextReceiptById.set('operation-watch-1', receipt('operation-watch-1', {
        contentSha256: result.contentSha256,
        sourceRefs: input.sourceRefs,
      }));
      return result;
    },
  };
  const skillEvidenceProducer = {
    apiVersion: 1,
    async execute(_ctx, input) {
      const targetDigestSha256 = sha(canonicalJson(input.target));
      const inputSha256 = sha(canonicalJson(input.actionInput));
      const guideSha256 = sha(input.guideText);
      const effectResultSha256 = sourceEvidence[0].sourceSha256;
      const workArtifactSha256 = sha('verified guide artifact bytes');
      const writeId = 'operation-write-1';
      const readbackId = 'operation-readback-1';
      nextReceiptById.set(writeId, receipt(writeId, {
        taskId: 'skill-write-task',
        operationType: 'conversation.skill.verify',
        effect: 'write',
        independentReadOperationId: readbackId,
        targetDigestSha256,
        sourceRefs: input.sourceRefs,
        skillWriteEvidence: {
          actionId: input.actionId,
          targetDigestSha256,
          inputSha256,
          guideVersion: input.guideVersion,
          guideSha256,
          actionEffectOperationId: 'effect-action-A',
          effectOutcome: 'verified',
          effectResultSha256,
          readbackReceiptId: readbackId,
          sourceRef: sourceEvidence[0].sourceRef,
          canonicalUrl: sourceEvidence[0].url,
          sourceSha256: sourceEvidence[0].sourceSha256,
          workArtifactSha256,
        },
      }));
      nextReceiptById.set(readbackId, receipt(readbackId, {
        taskId: 'skill-readback-task',
        operationType: 'conversation.skill.readback',
        effect: 'read',
        targetDigestSha256,
        sourceRefs: input.sourceRefs,
        skillReadbackEvidence: {
          actionId: input.actionId,
          targetDigestSha256,
          inputSha256,
          guideVersion: input.guideVersion,
          guideSha256,
          actionEffectOperationId: 'effect-action-A',
          readbackEffectOperationId: 'effect-readback-B',
          sourceRef: sourceEvidence[0].sourceRef,
          canonicalUrl: sourceEvidence[0].url,
          sourceSha256: sourceEvidence[0].sourceSha256,
          workArtifactSha256,
          effectReadbackOutcome: 'verified',
          effectReadbackSha256: effectResultSha256,
          readbackVerified: true,
        },
      }));
      return { writeOperationId: writeId, readbackOperationId: readbackId };
    },
  };
  const feature = createResearchWorkFeature({
    api, receipts: reader, reader: readerProvider, watcher, skillEvidenceProducer, tasks, scheduler, now: () => now,
  });
  return { feature, calls, api, reader, readerProvider, watcher, skillEvidenceProducer, tasks, scheduler, setReceipt(id, value) { nextReceiptById.set(id, value); } };
}

test('research notes require a completed DSH read task and exact verified Work receipt source', async () => {
  const env = makeDependencies();
  const note = await env.feature.research(context(), { query: 'Read the release guide.', idempotencyKey: 'research-1', sourceRefs });
  assert.equal(note.id, 'note-1');
  assert.equal(env.calls.taskRuns.length, 1);
  assert.equal(env.calls.taskRuns[0].metadata.parentTaskId, context().taskId);
  assert.equal(env.calls.taskRuns[0].metadata.parentSessionId, context().sessionId);
  assert.equal(env.calls.taskRuns[0].metadata.conversationKind, 'direct');
  assert.deepEqual(env.calls.taskRuns[0].metadata.sourceRefs, sourceRefs);
  assert.equal(env.calls.finalizations[0].childTask.taskId, env.calls.taskRuns[0].taskId);
  assert.deepEqual(env.calls.notes[0].sourceRefs, sourceRefs);
  assert.equal(env.calls.notes[0].researchOperationReceiptId, 'operation-read-1');
  assert.equal(env.calls.notes[0].conversationKind, 'direct');
  assert.equal(env.calls.authorizations.at(-1).sourceRefs[0].sourceMessageIds[0], 'source-message-1');
});

test('research does not save text that differs from its completed Work receipt', async () => {
  const env = makeDependencies({
    finalizedReceiptContentSha256: sha('different content'),
    api: {
      async createResearchNote() { throw new Error('must not store unverified text'); },
    },
  });
  await assert.rejects(env.feature.research(context(), { query: 'Read it.', idempotencyKey: 'research-2', sourceRefs }), /does not match its Work operation receipt/u);
  assert.equal(env.calls.notes.length, 0);
});

test('verified skill requires a host-produced action and independent effect readback', async () => {
  const env = makeDependencies();
  const content = 'Use the approved release procedure.';
  const target = { documentId: 'release-plan-1' };
  const actionInput = { approvedText: 'new release checklist' };
  const skill = await env.feature.createVerifiedSkill(context(), {
    actionId: 'public-web.lookup', target, actionInput, guideVersion: 4,
    sourceRefs, name: 'Release procedure', content,
  });
  assert.equal(skill.verified, true);
  assert.equal(env.calls.skills[0].operationReceiptId, 'operation-write-1');
  assert.equal(env.calls.skills[0].independentReadReceiptId, 'operation-readback-1');
  assert.equal(env.calls.skills[0].actionId, 'public-web.lookup');
  assert.equal(env.calls.skills[0].guideVersion, '4');
  assert.equal(skill.evidence.effectOutcome, 'verified');
  assert.equal(skill.evidence.effectReadbackSha256, skill.evidence.effectResultSha256);
  assert.deepEqual(env.calls.skills[0].sourceRefs, sourceRefs);
});

test('verified skill fails closed without a real action and readback producer', async () => {
  const env = makeDependencies();
  const feature = createResearchWorkFeature({
    api: env.api, receipts: env.reader, reader: env.readerProvider, watcher: env.watcher,
    tasks: env.tasks, scheduler: env.scheduler, now: () => now,
  });
  await assert.rejects(feature.createVerifiedSkill(context(), {
    actionId: 'public-web.lookup', target: { documentId: 'release-plan-1' },
    actionInput: { approvedText: 'new release checklist' }, guideVersion: 4,
    sourceRefs, name: 'Release procedure', content: 'Use the approved release procedure.',
  }), error => error.code === 'SKILL_EVIDENCE_PRODUCER_UNAVAILABLE');
  assert.equal(env.calls.skills.length, 0);
});

test('scheduled watch verifies its read receipt before saving a sourced note and reschedules by CAS', async () => {
  const env = makeDependencies();
  const watch = await env.feature.createWatch(context(), {
    userEventId: 'user-event-1', title: 'Release guide', condition: 'Check whether the guide changed.',
  });
  assert.equal(watch.id, 'watch-1');
  assert.deepEqual(env.calls.watches[0].sourceRefs, [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['user-message-1'] }]);
  const result = await env.feature.runScheduledWatch(context(), 'watch-1');
  assert.equal(result.taskStatus, 'completed');
  assert.equal(result.note.content, 'The release guide changed.');
  assert.equal(env.calls.notes.length, 1);
  assert.equal(env.calls.scheduleUpdates.length, 1);
  assert.equal(env.calls.schedules.length, 2);
  assert.equal(env.calls.scheduleUpdates[0].input.expectedVersion, 1);
  assert.equal(env.calls.taskRuns.at(-1).metadata.parentTaskId, context().taskId);
  assert.equal(env.calls.taskRuns.at(-1).metadata.parentSessionId, watch.ownerSessionId);
  assert.deepEqual(env.calls.taskRuns.at(-1).metadata.sourceRefs, watch.sourceRefs);
  assert.equal(env.calls.finalizations.at(-1).childTask.taskId, env.calls.taskRuns.at(-1).taskId);
  assert.equal(env.calls.taskRuns.at(-1).metadata.sourceRefsDigest, sha(canonicalJson(watch.sourceRefs)));
  const priorResultSha256 = sha('result:operation-watch-1');
  const repeated = await env.feature.runScheduledWatch(context(), watch.id);
  assert.equal(repeated.note, undefined, 'a repeated result digest does not create a second note');
  assert.equal(env.calls.notes.length, 1);
  assert.equal(env.calls.watchObservations[1].previousResultSha256, priorResultSha256);
  assert.equal(env.calls.notes[0].sourceRefs.length, 1);
  assert.equal(env.calls.notes[0].researchOperationReceiptId, 'operation-watch-1');
  assert.deepEqual(env.calls.notes[0].sourceRefs[0].sourceMessageIds, ['user-message-1'],
    'read receipt lineage comes from the exact source refs attached to the watch Task');
});

test('watch recovery pages through more than 500 actor-owned records', async () => {
  const lateWatch = {
    id: 'watch-after-page-500', idempotencyKey: 'watch-key', conversationId: scope.conversationId,
    conversationKind: scope.conversationKind, personaId: scope.personaId,
    title: 'Release guide', condition: 'Check for updates.', sourceRefs,
    nextCheckAt: now + 60 * 60_000, state: 'active', version: 1, createdAt: now, updatedAt: now,
  };
  const env = makeDependencies({
    api: {
      async listWatches(_ctx, input) {
        if (input.cursor === undefined) {
          return {
            items: Array.from({ length: 500 }, (_, index) => ({ ...lateWatch, id: `other-${index}`, conversationId: 'other-conversation' })),
            nextCursor: 'watch-cursor-2',
          };
        }
        return { items: [lateWatch], nextCursor: null };
      },
    },
  });
  const restored = await env.feature.recoverWatches(context());
  assert.equal(restored, 1);
  assert.equal(env.calls.schedules.length, 1);
  assert.equal(env.calls.schedules[0].marker.resourceId, lateWatch.id);
});

test('disabled research modules retain data and refuse new reads or watches', async () => {
  const env = makeDependencies();
  const disabled = createResearchWorkFeature({
    api: env.api,
    receipts: env.reader,
    reader: env.readerProvider,
    watcher: env.watcher,
    tasks: env.tasks,
    scheduler: env.scheduler,
    enabled: false,
    now: () => now,
  });
  await assert.rejects(disabled.research(context(), { query: 'read', idempotencyKey: 'disabled', sourceRefs }), /disabled/u);
  await assert.rejects(disabled.createWatch(context(), { userEventId: 'user-event-1', title: 'x', condition: 'y' }), /disabled/u);
  assert.equal(env.calls.notes.length, 0);
  assert.equal(env.calls.watches.length, 0);
});
