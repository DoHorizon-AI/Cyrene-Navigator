// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator daily review tests                                │
// │ Role: Verify sourced review, recovery and authorization boundaries. │
// │ 模块职责：验证复盘来源、故障恢复与授权边界。                           │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ConversationDomainApiError } from '../dist/features/conversation-domain-api.js';
import { createConversationDailyReviewFeature } from '../dist/features/conversation-daily-review.js';
import { maintenanceWorkTaskId } from '../dist/features/conversation-dsh-runtime.js';

const now = 1_800_000_000_000;
const window = { startAt: now - 86_400_000, endAt: now };
const baseScope = {
  workspaceId: 'workspace-review',
  actorId: 'actor-review',
  conversationId: 'conversation-review',
  conversationKind: 'direct',
  personaId: 'persona-review',
  visibility: 'private',
  authorizationEpoch: 9,
};

function trustedContext(overrides = {}) {
  return {
    ...baseScope,
    taskId: 'turn-task',
    sessionId: 'turn-session',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function message(id, occurredAt, role = 'user') {
  return {
    id,
    eventId: `event-${id}`,
    role,
    content: `Conversation text for ${id}`,
    occurredAt,
    status: 'active',
    sourceRefs: [{ memoryId: null, memoryVersion: null, sourceMessageIds: [id] }],
    scope: {
      conversationId: baseScope.conversationId,
      conversationKind: baseScope.conversationKind,
      personaId: baseScope.personaId,
      visibility: baseScope.visibility,
    },
  };
}

function makeHarness({
  messages = [message('message-2', now - 5_000, 'assistant'), message('message-1', now - 10_000)],
  denyAfterModel = false,
  failCheckpointOnce = false,
  failContinuationCreateOnce = false,
} = {}) {
  const calls = {
    authorizations: [],
    listMessages: [],
    model: [],
    artifactWrites: [],
    artifactReads: [],
    events: [],
    checkpoints: [],
    schedules: [],
  };
  let deny = false;
  let failNextCheckpoint = failCheckpointOnce;
  let job = undefined;
  let jobSequence = 0;
  let retrySequence = 0;
  let failContinuationCreate = failContinuationCreateOnce;
  const jobs = new Map();
  const jobsByKey = new Map();
  const artifactByKey = new Map();
  const artifactById = new Map();
  const eventByKey = new Map();
  let artifactSequence = 0;

  const api = {
    apiVersion: 1,
    async createMaintenanceJob(_context, input) {
      if (failContinuationCreate && input.idempotencyKey.startsWith('daily-review-continuation-')) {
        failContinuationCreate = false;
        throw new Error('simulated continuation response loss before commit');
      }
      const prior = jobsByKey.get(input.idempotencyKey);
      if (prior !== undefined) {
        job = prior;
        return { job, duplicate: true };
      }
      jobSequence += 1;
      job = makeJob(`daily-review-job-${jobSequence}`, input.cursor, input);
      jobs.set(job.id, job);
      jobsByKey.set(input.idempotencyKey, job);
      return { job, duplicate: false };
    },
    async listMaintenanceJobs(_context, { state }) {
      return { items: [...jobs.values()].filter(item => item.state === state), nextCursor: null };
    },
    async getMaintenanceJob(_context, jobId) {
      job = jobs.get(jobId);
      return { job };
    },
    async retryMaintenanceJob(_context, _jobId, expectedVersion) {
      assert.equal(job.version, expectedVersion);
      retrySequence += 1;
      const copied = job;
      job = {
        ...copied,
        id: `daily-review-job-retry-${retrySequence}`,
        taskId: maintenanceWorkTaskId(baseScope.workspaceId, baseScope.actorId, `daily-review-job-retry-${retrySequence}`),
        state: 'queued',
        version: 1,
      };
      jobs.set(job.id, job);
      return { job, duplicate: false };
    },
    async cancelMaintenanceJob(_context, _jobId, expectedVersion) {
      assert.equal(job.version, expectedVersion);
      job = { ...job, state: 'cancelled', version: job.version + 1 };
      jobs.set(job.id, job);
      return { job };
    },
    async listMessages(_context, input) {
      calls.listMessages.push(input);
      const offset = input.cursor === undefined ? 0 : Number(input.cursor.slice('history-'.length));
      const items = messages.slice(offset, offset + input.limit);
      const nextOffset = offset + items.length;
      return { items, nextCursor: nextOffset < messages.length ? `history-${nextOffset}` : null };
    },
    async authorizeSources(_context, input) {
      calls.authorizations.push(input);
      return {
        allowed: !deny,
        currentAuthorizationEpoch: baseScope.authorizationEpoch,
        deniedSourceIds: deny ? input.sourceRefs.flatMap(ref => ref.sourceMessageIds) : [],
      };
    },
  };

  const artifacts = {
    async findByIdempotencyKey({ idempotencyKey }) {
      return artifactByKey.get(idempotencyKey);
    },
    async write(input) {
      calls.artifactWrites.push(input);
      const bytes = Buffer.from(input.bytes);
      const prior = artifactByKey.get(input.idempotencyKey);
      if (prior !== undefined) {
        const oldBytes = artifactById.get(prior.id).bytes;
        if (!oldBytes.equals(bytes)) throw new Error('idempotency payload mismatch');
        return prior;
      }
      artifactSequence += 1;
      const receipt = {
        id: `artifact-${artifactSequence}`,
        idempotencyKey: input.idempotencyKey,
        mimeType: input.mimeType,
        name: input.name,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.byteLength,
        scopeDigest: createHash('sha256').update(canonicalJson(input.scope)).digest('hex'),
        sourceRefsDigest: createHash('sha256').update(canonicalJson(input.sourceRefs)).digest('hex'),
      };
      artifactByKey.set(input.idempotencyKey, receipt);
      artifactById.set(receipt.id, { ...receipt, bytes });
      return receipt;
    },
    async read({ artifactId }) {
      calls.artifactReads.push(artifactId);
      const artifact = artifactById.get(artifactId);
      if (artifact === undefined) throw new Error('missing artifact');
      return { ...artifact, bytes: Buffer.from(artifact.bytes) };
    },
  };

  const ledger = {
    async create(input) {
      calls.events.push(input);
      const prior = eventByKey.get(input.idempotencyKey);
      if (prior !== undefined) return { event: prior, duplicate: true };
      const event = { id: `review-event-${eventByKey.size + 1}`, eventType: input.eventType, summary: input.summary };
      eventByKey.set(input.idempotencyKey, event);
      return { event, duplicate: false };
    },
  };

  const tasks = {
    async run(_scope, request, operation, signal) {
      assert.equal(request.taskId, job.taskId);
      assert.equal(request.metadata.source, 'conversation-maintenance');
      const result = await operation({}, signal, async update => {
        calls.checkpoints.push(update);
        if (failNextCheckpoint && calls.checkpoints.length === 2) {
          failNextCheckpoint = false;
          throw new Error('simulated checkpoint response loss');
        }
        job = {
          ...job,
          cursor: update.cursor,
          processedCount: update.processedCount,
          checkpointDigest: update.checkpointDigest,
          details: { ...update.details },
          state: 'running',
          version: job.version + 1,
        };
        jobs.set(job.id, job);
      });
      job = { ...job, state: 'completed', version: job.version + 1 };
      jobs.set(job.id, job);
      return { taskId: request.taskId, sessionId: request.sessionId, status: 'completed', output: result, reasoning: '', durationMs: 1 };
    },
    async cancel() { return true; },
  };

  const scheduler = {
    schedulerSessionId: 'scheduler-session',
    async ensureOneShot(marker, dueAt, options) {
      calls.schedules.push({ marker, dueAt, options });
      return { record: { id: `schedule-${calls.schedules.length}` }, created: true, active: true };
    },
    async cancel() { return 1; },
  };

  const model = {
    apiVersion: 1,
    async reviewPage(input) {
      calls.model.push(input);
      if (denyAfterModel) deny = true;
      return {
        summary: `Reviewed ${input.messages.length} messages.`,
        findings: [{ title: 'Follow-up', detail: 'A useful next step remains open.', priority: 'normal' }],
        unresolved: ['Confirm the next owner.'],
        modelGaps: [],
      };
    },
  };

  const feature = createConversationDailyReviewFeature({
    api,
    tasks,
    scheduler,
    model,
    artifacts,
    ledger,
    now: () => now,
  });
  return {
    feature, api, artifacts, ledger, calls,
    get job() { return job; },
    set job(value) { job = value; if (value) jobs.set(value.id, value); },
  };
}

function makeJob(id, cursor, input) {
  return {
    id,
    taskId: maintenanceWorkTaskId(baseScope.workspaceId, baseScope.actorId, id),
    idempotencyKey: input.idempotencyKey,
    kind: 'daily_review',
    conversationId: baseScope.conversationId,
    conversationKind: baseScope.conversationKind,
    personaId: baseScope.personaId,
    state: 'queued',
    cursor,
    processedCount: 0,
    checkpointDigest: null,
    queuedVersion: 1,
    details: {},
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

test('daily review reads, authorizes, models and independently reads back its actor-private report', async () => {
  const harness = makeHarness();
  const context = trustedContext();
  const queued = await harness.feature.schedule(context, { idempotencyKey: 'daily-review-request-1', window });
  assert.equal(queued.job.kind, 'daily_review');
  assert.equal(harness.calls.schedules.length, 1);

  const outcome = await harness.feature.runScheduled(context, queued.job.id);
  assert.equal(outcome.taskStatus, 'completed');
  assert.equal(harness.calls.model.length, 2);
  assert.ok(harness.calls.authorizations.length >= 4, 'sources are checked before model use and before report publication');
  assert.equal(harness.calls.artifactWrites.length, 3, 'each page and the final report are separately stored');
  assert.ok(harness.calls.artifactReads.length >= 4, 'every artifact receives independent readback');
  assert.equal(harness.calls.events.length, 1);
  assert.equal(harness.calls.events[0].eventType, 'daily_review');
  assert.deepEqual(harness.calls.events[0].sourceRefs, [
    { memoryId: null, memoryVersion: null, sourceMessageIds: ['message-2'] },
    { memoryId: null, memoryVersion: null, sourceMessageIds: ['message-1'] },
  ]);
  assert.equal(harness.job.details.dailyReviewV1.completed, true);
  assert.equal(harness.job.processedCount, 2);
});

test('daily review rechecks every source after model use and publishes nothing after revocation', async () => {
  const harness = makeHarness({ denyAfterModel: true });
  const context = trustedContext();
  const { job } = await harness.feature.schedule(context, { idempotencyKey: 'daily-review-revoked', window });
  await assert.rejects(harness.feature.runScheduled(context, job.id), error => {
    assert.ok(error instanceof ConversationDomainApiError);
    assert.equal(error.code, 'DAILY_REVIEW_SOURCE_REVOKED');
    return true;
  });
  assert.equal(harness.calls.model.length, 1);
  assert.equal(harness.calls.artifactWrites.length, 0);
  assert.equal(harness.calls.events.length, 0);
});

test('daily review reconciles an artifact committed before a lost checkpoint and retry does not rerun the model', async () => {
  const harness = makeHarness({ failCheckpointOnce: true });
  const context = trustedContext();
  const { job } = await harness.feature.schedule(context, { idempotencyKey: 'daily-review-recover', window });
  await assert.rejects(harness.feature.runScheduled(context, job.id), /simulated checkpoint response loss/u);
  harness.job = { ...harness.job, state: 'failed', details: { retryable: true }, version: harness.job.version + 1 };
  const retried = await harness.feature.retryFailed(context, harness.job.id, harness.job.version);
  const result = await harness.feature.runScheduled(context, retried.job.id);
  assert.equal(result.taskStatus, 'completed');
  assert.equal(harness.calls.model.length, 2, 'retry reuses its committed page and continues from the same cursor');
  assert.equal(harness.calls.events.length, 1);
  assert.equal(harness.job.details.dailyReviewV1.completed, true);
});

test('daily review recovers continuation creation and pages the full window across bounded DSH jobs', async () => {
  const messages = Array.from({ length: 30 }, (_, index) => message(`message-${30 - index}`, now - (30 - index) * 1_000));
  const harness = makeHarness({ messages, failContinuationCreateOnce: true });
  const context = trustedContext();
  const scheduled = await harness.feature.schedule(context, { idempotencyKey: 'daily-review-many-pages', window });
  await assert.rejects(harness.feature.runScheduled(context, scheduled.job.id), /simulated continuation response loss before commit/u);
  const firstJob = (await harness.api.getMaintenanceJob(context, scheduled.job.id)).job;
  assert.equal(firstJob.state, 'completed', 'the bounded report and continuation cursor survive the lost response');
  assert.ok(firstJob.details.dailyReviewV1.continuationCursor);
  assert.equal(firstJob.processedCount, 16);
  assert.equal(await harness.feature.recoverQueued(context), 1, 'startup recovery recreates the missing continuation idempotently');
  const queued = await harness.api.listMaintenanceJobs(context, { state: 'queued', limit: 100 });
  const continuationId = queued.items.find(item => item.id !== scheduled.job.id)?.id;
  assert.ok(continuationId);

  const last = await harness.feature.runScheduled(context, continuationId);
  assert.equal(last.taskStatus, 'completed');
  assert.equal(last.continuationJobId, undefined, 'the last batch reaches the start of the window');
  assert.equal(last.job.processedCount, 14);
  assert.equal(harness.calls.model.length, 30);
  assert.equal(harness.calls.events.length, 2, 'each bounded report segment has its own source-authorized ledger entry');

  const firstEvent = JSON.parse(harness.calls.events[0].summary);
  const lastEvent = JSON.parse(harness.calls.events[1].summary);
  const firstReport = JSON.parse(Buffer.from((await harness.artifacts.read({
    context: { workspaceId: baseScope.workspaceId, actorId: baseScope.actorId },
    artifactId: firstEvent.report.artifactId,
    signal: context.signal,
  })).bytes).toString('utf8'));
  const finalReport = JSON.parse(Buffer.from((await harness.artifacts.read({
    context: { workspaceId: baseScope.workspaceId, actorId: baseScope.actorId },
    artifactId: lastEvent.report.artifactId,
    signal: context.signal,
  })).bytes).toString('utf8'));
  assert.equal(firstReport.coverage.complete, false);
  assert.equal(firstReport.coverage.chunkIndex, 1);
  assert.equal(firstReport.coverage.totalProcessedMessageCount, 16);
  assert.equal(finalReport.coverage.complete, true);
  assert.equal(finalReport.coverage.chunkIndex, 2);
  assert.equal(finalReport.coverage.processedMessageCount, 14);
  assert.equal(finalReport.coverage.totalProcessedMessageCount, 30);
  assert.equal(finalReport.coverage.totalPageCount, 30);
  assert.deepEqual(finalReport.previousReport, {
    artifactId: firstEvent.report.artifactId,
    sha256: firstEvent.report.sha256,
  });
});

test('daily review refuses to construct without real model and actor-private storage adapters', () => {
  const options = makeHarness();
  assert.throws(() => createConversationDailyReviewFeature({
    api: options.api,
    tasks: { run: async () => { throw new Error('not reached'); }, cancel: async () => false },
    scheduler: options.feature,
  }), error => error.code === 'MODEL_UNAVAILABLE');
});

test('daily review scope mismatch and task cancellation are explicit and version checked', async () => {
  const harness = makeHarness();
  const owner = trustedContext();
  const { job } = await harness.feature.schedule(owner, { idempotencyKey: 'daily-review-cancel', window });
  await assert.rejects(harness.feature.runScheduled(trustedContext({ conversationId: 'other-conversation' }), job.id), error => {
    assert.equal(error.code, 'DAILY_REVIEW_SCOPE_MISMATCH');
    return true;
  });
  const cancelled = await harness.feature.cancel(owner, job.id, job.version);
  assert.equal(cancelled.job.state, 'cancelled');
  assert.equal(cancelled.taskCancellationRequested, true);
  assert.equal(cancelled.scheduleEntriesRemoved, 1);
  await assert.rejects(harness.feature.cancel(owner, job.id, job.version), error => error.code === 'DAILY_REVIEW_JOB_CONFLICT');
});
