// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Bilibili delegation tests                         │
// │ Role: Verify scoped grants, receipts and scheduled subscription.    │
// │ 模块职责：验证账号委托、操作回执与定时订阅隔离。                      │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ConversationDomainApiError } from '../dist/features/conversation-domain-api.js';
import { createBiliDelegationFeature } from '../dist/features/bilibili-delegation.js';
import { conversationScheduleMarker, parseConversationScheduleMarkerV1 } from '../dist/features/conversation-schedule.js';

const now = 1_800_000_000_000;
const scope = {
  workspaceId: 'workspace-bili',
  actorId: 'actor-bili',
  conversationId: 'conversation-bili',
  conversationKind: 'direct',
  personaId: 'persona-bili',
  visibility: 'private',
  authorizationEpoch: 5,
};
const sourceRefs = [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['source-message-1'] }];
const connection = {
  workspaceId: scope.workspaceId,
  ownerActorId: scope.actorId,
  connectionRef: 'connection-bili-1',
  profileRef: 'profile-bili-1',
  provider: 'bilibili',
  enabled: true,
  externalSubject: '10086',
};

function context(overrides = {}) {
  return {
    ...scope,
    taskId: 'work-task-bili-1',
    sessionId: 'work-session-bili-1',
    origin: { kind: 'connector', sourceId: 'connector-bili', externalEventId: 'user-event-bili-1' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function makeWorld({
  policyEnabled = true,
  revokeAfterOperation = false,
  outcome = 'verified',
  failRecordCheckOnce = false,
  failNotificationTaskOnce = false,
  failReadTaskOnce = false,
  failBeforeReadTaskOnce = false,
  addUnexpectedRunPlanMetadata = false,
  advanceBeforeNotificationMs = 0,
  initialNotificationOutcome = 'delivered',
  omitDeliveryReceiptId = false,
} = {}) {
  const calls = { authorizations: [], operations: [], notifications: [], holds: [], schedules: [], tasks: [], sourceChecks: [], subscriptionReconciliations: [] };
  let revoked = false;
  let policy = {
    conversationId: scope.conversationId,
    enabled: policyEnabled,
    quietHours: { timeZone: 'UTC', start: '00:00', end: '00:00' },
    cooldownSeconds: 0,
    allowGroupInterjections: false,
    followupEnabled: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  let delegation;
  let subscription;
  let operationReceiptSequence = 0;
  let notificationSequence = 0;
  let notificationReadbackSequence = 0;
  let failRecordCheck = failRecordCheckOnce;
  let failNotificationTask = failNotificationTaskOnce;
  let failReadTask = failReadTaskOnce;
  let failBeforeReadTask = failBeforeReadTaskOnce;
  let clockNow = now;
  let notificationOutcome = initialNotificationOutcome;
  const receiptsByKey = new Map();
  const providerResultsByKey = new Map();
  const notificationsByKey = new Map();
  const completedTasks = new Map();
  const runPlansByKey = new Map();
  const argumentDigest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const makeRunPlan = value => {
    const runKey = value.scheduledRunKey;
    const previous = runPlansByKey.get(runKey);
    if (previous !== undefined) return previous;
    const operationIdempotencyKey = `bili-operation-${hash(`cyrene-bili-subscription-operation-v1\u0000${scope.workspaceId}\u0000${scope.actorId}\u0000${value.id}\u0000${runKey}`).slice(0, 32)}`;
    const taskId = `bili-watch-${hash(`cyrene-bili-subscription-check-v1\u0000${scope.workspaceId}\u0000${scope.actorId}\u0000${value.id}\u0000${runKey}`).slice(0, 32)}`;
    const sourceMetadata = {
      source: 'conversation-bili-subscription-read',
      organizationId: 'org-bili',
      workspaceId: scope.workspaceId,
      actorId: scope.actorId,
      subscriptionId: value.id,
      delegationId: value.delegationId,
      connectionRef: value.connectionRef,
      profileRef: value.profileRef,
      operationId: value.operationId,
      resourceRef: value.resourceRef,
      argumentsDigestSha256: value.argumentsDigestSha256,
      sourceRefsDigest: hash(canonicalJson(value.sourceRefs)),
      conversationId: value.conversationId,
      conversationKind: value.conversationKind,
      personaId: value.personaId,
      ownerTaskId: value.ownerTaskId,
      ownerSessionId: value.ownerSessionId,
      runKey,
      expectedVersion: value.scheduledExpectedVersion,
      operationIdempotencyKey,
      ...(addUnexpectedRunPlanMetadata ? { legacyOwnerId: scope.actorId } : {}),
    };
    const runtimePlanDigest = hash(canonicalJson({
      taskId, operationIdempotencyKey, sourceMetadata, arguments: value.arguments,
      cursor: value.cursor, sourceRefs: value.sourceRefs,
    }));
    const plan = { taskId, operationIdempotencyKey, sourceMetadata, runtimePlanDigest };
    runPlansByKey.set(runKey, plan);
    return plan;
  };

  const api = {
    apiVersion: 1,
    async authorizeSources(_ctx, request) {
      calls.sourceChecks.push(request);
      return { allowed: true, currentAuthorizationEpoch: scope.authorizationEpoch, deniedSourceIds: [] };
    },
    async getActiveBehaviorPolicy() { return policy; },
    async listMessages() {
      return {
        items: [{
          id: 'source-message-1', eventId: 'user-event-bili-1', role: 'user', content: 'Check this Bilibili item.',
          occurredAt: now - 1_000, status: 'active', sourceRefs: [],
          scope: { conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId, visibility: scope.visibility },
        }],
        nextCursor: null,
      };
    },
  };
  const connections = {
    async getOwnedConnectionByProfile(_ctx, profileRef) {
      return profileRef === connection.profileRef ? connection : undefined;
    },
    async getOwnedConnection(_ctx, connectionRef) {
      return connectionRef === connection.connectionRef ? connection : undefined;
    },
  };
  const delegations = {
    async create(_ctx, input) {
      delegation = {
        id: 'delegation-bili-1',
        workspaceId: scope.workspaceId,
        ownerActorId: scope.actorId,
        granteeActorId: input.granteeActorId,
        connectionRef: input.connectionRef,
        profileRef: input.profileRef,
        operationIds: input.operationIds,
        targetScopes: input.targetScopes,
        expiresAt: input.expiresAt,
        revokedAt: null,
        version: 1,
      };
      return { delegation, duplicate: false };
    },
    async get(_ctx, id) {
      assert.equal(id, delegation.id);
      return { delegation };
    },
    async list() { return { items: [], nextCursor: null }; },
    async authorize(_ctx, input) {
      calls.authorizations.push(input);
      if (revoked || delegation.revokedAt !== null || !delegation.operationIds.includes(input.operationId)
        || !delegation.targetScopes.some(scope => scope.operationId === input.operationId && scope.resourceRef === input.resourceRef
          && scope.argumentsDigestSha256 === input.argumentsDigestSha256)) {
        return { authorization: null, denialCode: 'BILI_DELEGATION_DENIED' };
      }
      return {
        authorization: {
          delegationId: delegation.id,
          workspaceId: scope.workspaceId,
          ownerActorId: scope.actorId,
          granteeActorId: scope.actorId,
          connectionRef: connection.connectionRef,
          profileRef: connection.profileRef,
          operationId: input.operationId,
          resourceRef: input.resourceRef,
          argumentsDigestSha256: input.argumentsDigestSha256,
          delegationVersion: delegation.version,
          directoryEpoch: 7,
          validUntil: delegation.expiresAt,
          proofRef: 'directory-proof-1',
          proofDigest: argumentDigest({ proof: input.resourceRef, argumentsDigestSha256: input.argumentsDigestSha256 }),
        },
      };
    },
    async revoke(_ctx, _id, expectedVersion) {
      assert.equal(delegation.version, expectedVersion);
      delegation = { ...delegation, revokedAt: now, version: delegation.version + 1 };
      revoked = true;
      return { delegation };
    },
  };
  const operations = {
    async findByIdempotencyKey(_ctx, key) { return receiptsByKey.get(key); },
    async invoke(ctx, input) {
      calls.operations.push(input);
      const prior = input.idempotencyKey === undefined ? undefined : receiptsByKey.get(input.idempotencyKey);
      if (prior !== undefined) return prior;
      operationReceiptSequence += 1;
      const data = { content: `verified result ${operationReceiptSequence}` };
      const receipt = {
        id: `work-operation-receipt-${operationReceiptSequence}`,
        trustedProducer: 'exchange-connector-dispatch',
        workspaceId: scope.workspaceId,
        actorId: scope.actorId,
        connectionRef: connection.connectionRef,
        profileRef: connection.profileRef,
        operationId: input.operationId,
        resourceRef: input.resourceRef,
        target: input.target,
        argumentsDigestSha256: input.argumentsDigestSha256,
        argumentsDigestSha256: argumentDigest(input.arguments),
        outcome: 'pending',
        taskStatus: 'running',
        taskId: ctx.taskId,
        taskOutputSha256: null,
        outputSha256: null,
        externalReadbackVerified: false && input.operationId.startsWith('bilibili.')
          && ['bilibili.comment.create', 'bilibili.dynamic.publish', 'bilibili.dm.send'].includes(input.operationId),
        workOperationId: `work-operation-${operationReceiptSequence}`,
        createdAt: now,
      };
      const result = { receipt };
      if (input.idempotencyKey !== undefined) {
        receiptsByKey.set(input.idempotencyKey, result);
        providerResultsByKey.set(input.idempotencyKey, data);
      }
      if (revokeAfterOperation) revoked = true;
      return result;
    },
  };
  const subscriptions = {
    async create(_ctx, input) {
      subscription = {
        id: 'bili-subscription-1',
        ...input,
        ownerTaskId: _ctx.taskId,
        ownerSessionId: _ctx.sessionId,
        workspaceId: scope.workspaceId,
        ownerActorId: scope.actorId,
        state: 'active',
        lastOutputSha256: null,
        lastOperationReceiptId: null,
        lastNotificationReceiptId: null,
        lastNotificationReadbackReceiptId: null,
        lastNotificationOutcome: null,
        lastDeliveryReceiptId: null,
        scheduledRunKey: `bili-run-${input.idempotencyKey}`,
        scheduledExpectedVersion: 1,
        scheduledRunState: 'scheduled',
        cursor: typeof input.arguments.cursor === 'string' ? input.arguments.cursor : null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      return { subscription, duplicate: false };
    },
    async get(_ctx, id) {
      assert.equal(id, subscription.id);
      return { subscription };
    },
    async claim(_ctx, id, expectedVersion) {
      assert.equal(id, subscription.id);
      if (subscription.scheduledRunState === 'claimed' && expectedVersion + 1 === subscription.version) {
        return { subscription, runPlan: makeRunPlan(subscription) };
      }
      assert.equal(subscription.version, expectedVersion);
      subscription = {
        ...subscription,
        version: subscription.version + 1,
        scheduledExpectedVersion: subscription.version + 1,
        scheduledRunState: 'claimed',
        scheduledRunKey: `bili-run-${subscription.id}-v${subscription.version + 1}`,
      };
      return { subscription, runPlan: makeRunPlan(subscription) };
    },
    async authorizeNotification(_ctx, id, input) {
      assert.equal(id, subscription.id);
      assert.equal(input.expectedVersion, subscription.version);
      assert.equal(input.runKey, subscription.scheduledRunKey);
      return {
        allowed: true,
        reason: null,
        subscriptionId: subscription.id,
        version: subscription.version,
        runKey: subscription.scheduledRunKey,
        notificationIdempotencyKey: `bili-notification-${hash(`${subscription.id}\u0000${input.sourceOutputSha256}`)}`,
      };
    },
    async recordNotificationReconciliation(_ctx, id, input) {
      assert.equal(id, subscription.id);
      assert.equal(input.expectedVersion, subscription.version);
      assert.equal(input.runKey, subscription.scheduledRunKey);
      assert.notEqual(subscription.scheduledRunState, 'claimed');
      calls.subscriptionReconciliations.push(input);
      subscription = {
        ...subscription,
        state: input.state,
        lastNotificationReceiptId: input.notificationReceiptId,
        lastNotificationReadbackReceiptId: input.notificationReadbackReceiptId ?? null,
        lastNotificationOutcome: input.notificationOutcome,
        lastDeliveryReceiptId: input.deliveryReceiptId ?? null,
        nextCheckAt: input.nextCheckAt,
        version: subscription.version + 1,
        updatedAt: now,
      };
      return { subscription };
    },
    async list(_ctx, { state, delegationId }) {
      const items = subscription && (state === undefined || subscription.state === state)
        && (delegationId === undefined || subscription.delegationId === delegationId) ? [subscription] : [];
      return { items, nextCursor: null };
    },
    async recordCheck(_ctx, _id, input) {
      assert.equal(subscription.version, input.expectedVersion);
      if (failRecordCheck) {
        failRecordCheck = false;
        throw new Error('simulated crash before subscription checkpoint');
      }
      subscription = {
        ...subscription,
        state: input.state,
        cursor: input.cursor ?? subscription.cursor,
        lastOutputSha256: input.outputSha256 ?? subscription.lastOutputSha256,
        lastOperationReceiptId: input.operationReceiptId ?? subscription.lastOperationReceiptId,
        lastNotificationReceiptId: input.notificationReceiptId ?? subscription.lastNotificationReceiptId,
        lastNotificationReadbackReceiptId: input.notificationReadbackReceiptId ?? subscription.lastNotificationReadbackReceiptId,
        lastNotificationOutcome: input.notificationOutcome ?? subscription.lastNotificationOutcome,
        lastDeliveryReceiptId: input.notificationOutcome === undefined
          ? subscription.lastDeliveryReceiptId
          : input.deliveryReceiptId ?? null,
        nextCheckAt: input.nextCheckAt,
        version: subscription.version + 1,
        scheduledExpectedVersion: subscription.version + 1,
        scheduledRunState: input.state === 'active' ? 'scheduled' : input.state,
        scheduledRunKey: `bili-check-${subscription.id}-v${subscription.version + 1}`,
        updatedAt: now,
      };
      return { subscription };
    },
    async transition(_ctx, _id, input) {
      assert.equal(subscription.version, input.expectedVersion);
      subscription = {
        ...subscription,
        state: input.state,
        ...(input.nextCheckAt === undefined ? {} : { nextCheckAt: input.nextCheckAt }),
        version: subscription.version + 1,
        updatedAt: now,
      };
      return { subscription };
    },
  };
  const tasks = {
    async runFeatureTask(_scope, request, operation, signal) {
      calls.tasks.push(request);
      const existing = completedTasks.get(request.taskId);
      if (existing !== undefined) return existing;
      if (failBeforeReadTask && request.metadata.source === 'conversation-bili-subscription-read') {
        failBeforeReadTask = false;
        throw new Error('simulated process loss after claim, before DSH Task creation');
      }
      if (request.metadata.source === 'conversation-bili-subscription-notification' && advanceBeforeNotificationMs > 0) {
        clockNow += advanceBeforeNotificationMs;
      }
      const output = await operation({}, signal);
      if (request.metadata.source === 'conversation-bili-operation'
        || request.metadata.source === 'conversation-bili-subscription-read') {
        const operationInput = calls.operations.at(-1);
        const key = operationInput?.idempotencyKey;
        const prior = key === undefined ? undefined : receiptsByKey.get(key);
        if (prior !== undefined) {
          const failed = failReadTask && request.metadata.source === 'conversation-bili-subscription-read';
          if (failed) failReadTask = false;
          const terminalOutcome = failed ? 'uncertain' : outcome;
          const resultData = providerResultsByKey.get(key);
          const taskReceipt = {
            ...prior.receipt,
            taskId: request.taskId,
            taskStatus: failed ? 'failed' : 'completed',
            taskOutputSha256: hash(output),
            outcome: terminalOutcome,
            outputSha256: terminalOutcome === 'verified' ? hash(canonicalJson(resultData)) : null,
            externalReadbackVerified: terminalOutcome === 'verified'
              && ['bilibili.comment.create', 'bilibili.dynamic.publish', 'bilibili.dm.send'].includes(prior.receipt.operationId),
          };
          receiptsByKey.set(key, {
            receipt: taskReceipt,
            ...(terminalOutcome === 'verified' ? { result: resultData } : {}),
          });
        }
      }
      if (request.metadata.source === 'conversation-bili-subscription-notification-readback') {
        const key = request.metadata.notificationIdempotencyKey;
        const prior = notificationsByKey.get(key);
        if (prior !== undefined) {
          const outputValue = JSON.parse(output);
          notificationsByKey.set(key, {
            ...prior,
            readbackTaskId: request.taskId,
            readbackTaskStatus: 'completed',
            readbackTaskOutputSha256: hash(output),
            readbackSha256: outputValue.readbackSha256,
          });
        }
      }
      const failAfterEffect = failNotificationTask && request.metadata.source === 'conversation-bili-subscription-notification';
      if (failAfterEffect) failNotificationTask = false;
      const result = {
        taskId: request.taskId,
        sessionId: request.sessionId,
        status: failAfterEffect ? 'failed' : request.metadata.source === 'conversation-bili-subscription-read'
          && receiptsByKey.get(calls.operations.at(-1)?.idempotencyKey)?.receipt.taskStatus === 'failed' ? 'failed' : 'completed',
        output,
        reasoning: '',
        durationMs: 1,
      };
      completedTasks.set(request.taskId, result);
      return result;
    },
    async cancelFeatureTask() { return true; },
  };
  const scheduler = {
    schedulerSessionId: 'schedule-session-bili',
    async ensureOneShot(marker, dueAt, settings) {
      calls.schedules.push({ kind: 'ensure', marker, dueAt, settings });
      return { record: { id: `schedule-${calls.schedules.length}` }, created: true, active: true };
    },
    async cancel(marker) {
      calls.schedules.push({ kind: 'cancel', marker });
      return 1;
    },
  };
  const notifications = {
    async findByIdempotencyKey(_context, key, _signal, expectedTaskId) {
      const prior = notificationsByKey.get(key);
      if (prior === undefined) return undefined;
      assert.ok(expectedTaskId === prior.taskId || expectedTaskId === prior.readbackTaskId);
      return prior;
    },
    async getById(_context, id, _signal, expectedTaskId) {
      const prior = [...notificationsByKey.values()].find(receipt => receipt.id === id);
      if (prior === undefined) return undefined;
      assert.ok(expectedTaskId === undefined || expectedTaskId === context().taskId
        || typeof expectedTaskId === 'string' && expectedTaskId.length > 0);
      return prior;
    },
    async runStatusReadback(input) {
      assert.equal(input.notification.outcome, 'delivered');
      assert.equal(input.notification.sourceOutputSha256, input.sourceOutputSha256);
      assert.equal(input.notification.targetDigestSha256, input.hostResolvedTargetDigest);
      const prior = notificationsByKey.get(input.idempotencyKey);
      assert.ok(prior);
      return { readbackSha256: hash('notification status readback'), deliveryReceiptId: prior.deliveryReceiptId };
    },
    async completeStatusReadback(input) {
      const prior = notificationsByKey.get(input.idempotencyKey);
      assert.ok(prior);
      assert.equal(input.taskId, prior.readbackTaskId);
      assert.equal(input.taskOutputSha256, prior.readbackTaskOutputSha256);
      assert.equal(input.observation.readbackSha256, prior.readbackSha256);
      const id = `notification-status-readback-${++notificationReadbackSequence}`;
      const completed = {
        ...prior,
        readbackReceiptId: id,
        readbackTrustedProducer: 'notification-outbox',
        deliveryReceiptId: input.observation.deliveryReceiptId,
      };
      notificationsByKey.set(input.idempotencyKey, completed);
      return {
        id,
        trustedProducer: 'notification-outbox',
        operationType: 'conversation.bilibili.subscription.notification.readback.v1',
        taskId: input.taskId,
        taskStatus: 'completed',
        taskOutputSha256: input.taskOutputSha256,
        readbackSha256: input.observation.readbackSha256,
        deliveryReceiptId: input.observation.deliveryReceiptId,
      };
    },
    async deliver(input) {
      calls.notifications.push(input);
      notificationSequence += 1;
      const receipt = {
        id: `notification-receipt-${notificationSequence}`,
        idempotencyKey: input.idempotencyKey,
        trustedProducer: 'notification-outbox',
        operationType: 'conversation.bilibili.subscription.notification',
        readbackOperationType: 'conversation.bilibili.subscription.notification.readback.v1',
        outcome: 'delivered',
        taskId: input.context.taskId,
        sourceOutputSha256: input.operationReceipt.outputSha256,
        targetDigestSha256: input.operationReceipt.resourceRef.replace(/^sha256:/u, ''),
        contentSha256: 'a'.repeat(64),
        readbackReceiptId: null,
        readbackTrustedProducer: null,
        readbackTaskId: null,
        readbackTaskStatus: null,
        readbackTaskOutputSha256: null,
        readbackSha256: null,
        updatedAt: now + notificationSequence,
        deliveryReceiptId: omitDeliveryReceiptId ? null : 'platform-delivery-1',
      };
      receipt.outcome = notificationOutcome;
      if (notificationOutcome !== 'delivered') receipt.deliveryReceiptId = null;
      notificationsByKey.set(input.idempotencyKey, receipt);
      return receipt;
    },
    async hold(input) {
      calls.holds.push(input);
      notificationSequence += 1;
      const receipt = {
        id: `notification-hold-${notificationSequence}`,
        idempotencyKey: input.idempotencyKey,
        trustedProducer: 'notification-outbox',
        operationType: 'conversation.bilibili.subscription.notification',
        readbackOperationType: 'conversation.bilibili.subscription.notification.readback.v1',
        outcome: 'held',
        taskId: input.context.taskId,
        sourceOutputSha256: input.operationReceipt.outputSha256,
        targetDigestSha256: input.operationReceipt.resourceRef.replace(/^sha256:/u, ''),
        contentSha256: null,
        readbackReceiptId: null,
        readbackTrustedProducer: null,
        readbackTaskId: null,
        readbackTaskStatus: null,
        readbackTaskOutputSha256: null,
        readbackSha256: null,
        updatedAt: now + notificationSequence,
        deliveryReceiptId: null,
      };
      notificationsByKey.set(input.idempotencyKey, receipt);
      return receipt;
    },
  };
  const feature = createBiliDelegationFeature({
    api,
    connections,
    delegations,
    operations,
    subscriptions,
    tasks,
    scheduler,
    notifications,
    now: () => clockNow,
  });
  return {
    feature,
    calls,
    api,
    subscriptions,
    setPolicy(value) { policy = { ...policy, ...value }; },
    setNotificationOutcome(value) {
      notificationOutcome = value;
      for (const [key, receipt] of notificationsByKey) {
        if (receipt.outcome === 'queued' || receipt.outcome === 'accepted') {
          notificationsByKey.set(key, {
            ...receipt,
            outcome: value,
            deliveryReceiptId: value === 'delivered' ? 'platform-delivery-1' : null,
          });
        }
      }
    },
    setRevoked() { revoked = true; },
    get currentNow() { return clockNow; },
    get delegation() { return delegation; },
    get subscription() { return subscription; },
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function resourceRef(operationId, target) {
  const payload = { providerId: 'bilibili', profileRef: connection.profileRef, operationId, target };
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

function targetScope(operationId, args) {
  let target;
  switch (operationId) {
    case 'bilibili.search': target = { operationId, searchType: 'video' }; break;
    case 'bilibili.user.find': target = { operationId, userId: '10086' }; break;
    case 'bilibili.video.read': target = { operationId, videoId: 'BV1Q541167Qg' }; break;
    case 'bilibili.comments.list': target = { operationId, videoId: 'BV1Q541167Qg', rootCommentId: '0' }; break;
    case 'bilibili.comment.create': target = { operationId, videoId: 'BV1Q541167Qg', rootCommentId: '0', parentCommentId: '0' }; break;
    case 'bilibili.dynamic.publish': target = { operationId, userId: '10086' }; break;
    case 'bilibili.dynamics.list': target = { operationId, userId: '10086' }; break;
    case 'bilibili.dynamic.read': target = { operationId, dynamicId: '12345' }; break;
    case 'bilibili.dm.list': target = { operationId, peerUserId: '9988' }; break;
    case 'bilibili.dm.read': target = { operationId, peerUserId: '9988', messageId: '12345' }; break;
    case 'bilibili.dm.send': target = { operationId, peerUserId: '9988' }; break;
    default: throw new Error(`Add an explicit target fixture for ${operationId}`);
  }
  return { ...target, argumentsDigestSha256: createHash('sha256').update(canonicalJson(args)).digest('hex') };
}

async function createDelegation(world, operationIds = ['bilibili.search', 'bilibili.comment.create', 'bilibili.dynamics.list']) {
  const scopes = operationIds.flatMap(value => {
    if (typeof value !== 'string') return [value];
    return defaultArguments(value).map(args => targetScope(value, args));
  });
  const result = await world.feature.createDelegation(context(), {
    granteeActorId: scope.actorId,
    profileRef: connection.profileRef,
    operationScopes: scopes,
    expiresAt: now + 10 * 24 * 60 * 60 * 1_000,
  });
  return result.delegation;
}

function defaultArguments(operationId) {
  switch (operationId) {
    case 'bilibili.search': return [{ keyword: 'cyrene', search_type: 'video', page: 3 }];
    case 'bilibili.user.find': return [{ user_id: '10086' }];
    case 'bilibili.video.read': return [{ video_id: 'BV1Q541167Qg' }];
    case 'bilibili.comments.list': return [{ video_id: 'BV1Q541167Qg', root_comment_id: '0', page: 2, limit: 10 }];
    case 'bilibili.comment.create': return [{ video_id: 'BV1Q541167Qg', root_comment_id: '0', parent_comment_id: '0', content: 'reviewed by owner' }];
    case 'bilibili.dynamic.publish': return [{ user_id: '10086', content: 'A new dynamic' }];
    case 'bilibili.dynamics.list': return [{ user_id: '10086', limit: 20 }];
    case 'bilibili.dynamic.read': return [{ dynamic_id: '12345' }];
    case 'bilibili.dm.list': return [{ peer_user_id: '9988', limit: 20 }];
    case 'bilibili.dm.read': return [{ peer_user_id: '9988', message_id: '12345' }];
    case 'bilibili.dm.send': return [{ peer_user_id: '9988', content: 'message' }];
    default: throw new Error(`Add default arguments for ${operationId}`);
  }
}

test('delegation pins one owner-scoped Exchange connection and exact operation scope', async () => {
  const world = makeWorld();
  const delegation = await createDelegation(world, ['bilibili.search']);
  assert.equal(delegation.connectionRef, connection.connectionRef);
  assert.equal(delegation.profileRef, connection.profileRef);
  assert.deepEqual(delegation.operationIds, ['bilibili.search']);
  await assert.rejects(world.feature.execute(context(), {
    delegationId: delegation.id,
    operation: { kind: 'create_comment', videoId: 'BV1Q541167Qg', rootCommentId: '0', parentCommentId: '0', content: 'looks good' },
    idempotencyKey: 'write-operation-key',
  }), error => error.code === 'BILI_OPERATION_OUTSIDE_DELEGATION');
  assert.equal(world.calls.operations.length, 0);
});

test('all eleven operation adapters emit the closed connector schema and exact resource target', async () => {
  const operationIds = [
    'bilibili.search', 'bilibili.user.find', 'bilibili.video.read', 'bilibili.comments.list',
    'bilibili.dynamics.list', 'bilibili.dynamic.read', 'bilibili.dm.list', 'bilibili.dm.read',
    'bilibili.comment.create', 'bilibili.dynamic.publish', 'bilibili.dm.send',
  ];
  const cases = [
    [{ kind: 'search', keyword: 'cyrene', searchType: 'video', page: 2 }, { keyword: 'cyrene', search_type: 'video', page: 2 }],
    [{ kind: 'find_user', userId: '10086' }, { user_id: '10086' }],
    [{ kind: 'read_video', videoId: 'BV1Q541167Qg' }, { video_id: 'BV1Q541167Qg' }],
    [{ kind: 'list_comments', videoId: 'BV1Q541167Qg', rootCommentId: '0', page: 2, limit: 10 }, { video_id: 'BV1Q541167Qg', root_comment_id: '0', page: 2, limit: 10 }],
    [{ kind: 'list_dynamics', userId: '10086', cursor: 'cursor-1', limit: 10 }, { user_id: '10086', cursor: 'cursor-1', limit: 10 }],
    [{ kind: 'read_dynamic', dynamicId: '12345' }, { dynamic_id: '12345' }],
    [{ kind: 'list_dm', peerUserId: '9988', cursor: 'cursor-dm', limit: 5 }, { peer_user_id: '9988', cursor: 'cursor-dm', limit: 5 }],
    [{ kind: 'read_dm', peerUserId: '9988', messageId: '12345' }, { peer_user_id: '9988', message_id: '12345' }],
    [{ kind: 'create_comment', videoId: 'BV1Q541167Qg', rootCommentId: '0', parentCommentId: '0', content: 'reply' }, { video_id: 'BV1Q541167Qg', root_comment_id: '0', parent_comment_id: '0', content: 'reply' }],
    [{ kind: 'publish_dynamic', userId: '10086', content: 'update' }, { user_id: '10086', content: 'update' }],
    [{ kind: 'send_dm', peerUserId: '9988', content: 'message' }, { peer_user_id: '9988', content: 'message' }],
  ];
  const world = makeWorld();
  const delegation = await createDelegation(world, cases.map(([, expectedArguments], index) => targetScope(operationIds[index], expectedArguments)));
  for (let index = 0; index < cases.length; index += 1) {
    const [operation, expectedArguments] = cases[index];
    await world.feature.execute(context({ taskId: `schema-task-${index}` }), {
      delegationId: delegation.id,
      ...(operationIds[index].startsWith('bilibili.comment.create')
        || operationIds[index].startsWith('bilibili.dynamic.publish')
        || operationIds[index].startsWith('bilibili.dm.send')
        ? { idempotencyKey: `schema-write-${index}` } : {}),
      operation,
    });
    assert.deepEqual(world.calls.operations[index].arguments, expectedArguments, operationIds[index]);
    assert.match(world.calls.operations[index].resourceRef, /^sha256:[a-f0-9]{64}$/u);
  }
});

test('delegated DM targets are exact and cannot be widened by a tool request', async () => {
  const world = makeWorld();
  const delegation = await createDelegation(world, ['bilibili.dm.send']);
  await assert.rejects(world.feature.execute(context(), {
    delegationId: delegation.id,
    idempotencyKey: 'dm-other-peer',
    operation: { kind: 'send_dm', peerUserId: '9999', content: 'not authorized' },
  }), error => error.code === 'BILI_OPERATION_OUTSIDE_DELEGATION');
  assert.equal(world.calls.operations.length, 0);
});

test('delegation binds exact operation arguments as well as resource target', async () => {
  const world = makeWorld();
  const delegation = await createDelegation(world, [targetScope('bilibili.dm.send', { peer_user_id: '9988', content: 'approved text' })]);
  await assert.rejects(world.feature.execute(context(), {
    delegationId: delegation.id,
    idempotencyKey: 'dm-changed-content',
    operation: { kind: 'send_dm', peerUserId: '9988', content: 'different text' },
  }), error => error.code === 'BILI_OPERATION_OUTSIDE_DELEGATION');
  assert.equal(world.calls.operations.length, 0, 'changed input digest must be denied before the Exchange operation port');
});

test('reads use a fresh Work/Directory grant and exact Work receipt; retries reconcile by idempotency key', async () => {
  const world = makeWorld();
  const delegation = await createDelegation(world, ['bilibili.search']);
  const request = { delegationId: delegation.id, idempotencyKey: 'search-key-1', operation: { kind: 'search', keyword: 'cyrene', searchType: 'video', page: 3 } };
  const first = await world.feature.execute(context(), request);
  const second = await world.feature.execute(context(), request);
  assert.equal(first.receipt.outcome, 'verified');
  assert.equal(first.receipt.resourceRef, resourceRef('bilibili.search', { search_type: 'video' }));
  assert.deepEqual(world.calls.operations[0].arguments, { keyword: 'cyrene', search_type: 'video', page: 3 });
  assert.equal(world.calls.operations.length, 1);
  assert.ok(world.calls.authorizations.length >= 3, 'delegation is rechecked before invocation and readback');
  assert.equal(second.receipt.id, first.receipt.id);
});

test('unknown writes keep their Work receipt and are never replayed automatically', async () => {
  const world = makeWorld({ outcome: 'uncertain' });
  const delegation = await createDelegation(world, ['bilibili.dynamic.publish']);
  const request = {
    delegationId: delegation.id,
    idempotencyKey: 'publish-key-1',
    operation: { kind: 'publish_dynamic', userId: '10086', content: 'A new dynamic' },
  };
  const first = await world.feature.execute(context(), request);
  const replay = await world.feature.execute(context(), request);
  assert.equal(first.receipt.outcome, 'uncertain');
  assert.equal(replay.receipt.id, first.receipt.id);
  assert.equal(world.calls.operations.length, 1);
  assert.equal(world.calls.authorizations.at(-1).operationId, 'bilibili.dynamic.publish');
});

test('verified write requires the Exchange independent readback proof', async () => {
  const world = makeWorld();
  const delegation = await createDelegation(world, ['bilibili.comment.create']);
  const result = await world.feature.execute(context(), {
    delegationId: delegation.id,
    idempotencyKey: 'comment-key-1',
    operation: { kind: 'create_comment', videoId: 'BV1Q541167Qg', rootCommentId: '0', parentCommentId: '0', content: 'reviewed by owner' },
  });
  assert.equal(result.receipt.outcome, 'verified');
  assert.equal(result.receipt.externalReadbackVerified, true);
  assert.equal(world.calls.operations[0].resourceRef, resourceRef('bilibili.comment.create', {
    video_id: 'BV1Q541167Qg', root_comment_id: '0', parent_comment_id: '0',
  }));
  assert.deepEqual(world.calls.operations[0].arguments, {
    video_id: 'BV1Q541167Qg', root_comment_id: '0', parent_comment_id: '0', content: 'reviewed by owner',
  });
});

test('scheduled subscription runs a real DSH Work Task, checks fresh delegation and notifies only after current policy', async () => {
  const world = makeWorld();
  const delegation = await createDelegation(world, ['bilibili.dynamics.list']);
  const created = await world.feature.createSubscription(context(), {
    idempotencyKey: 'subscription-key-1',
    delegationId: delegation.id,
    sourceRefs,
    operation: { kind: 'list_dynamics', userId: '10086' },
    expiresAt: now + 5 * 24 * 60 * 60 * 1_000,
    nextCheckAt: now + 10_000,
  });
  assert.equal(created.subscription.connectionRef, connection.connectionRef);
  assert.equal(world.calls.schedules[0].marker.kind, 'bili-subscription');
  const result = await world.feature.runScheduledSubscription(context(), created.subscription.id);
  assert.equal(result.outcome, 'checked');
  assert.equal(result.taskStatus, 'completed');
  assert.equal(world.calls.tasks.length, 3, 'read, notification and independent delivery readback use separate DSH Work Tasks');
  assert.equal(world.calls.tasks[0].metadata.source, 'conversation-bili-subscription-read');
  assert.equal(world.calls.tasks[1].metadata.source, 'conversation-bili-subscription-notification');
  assert.equal(world.calls.notifications.length, 1);
  assert.ok(world.calls.authorizations.length >= 4, 'account authority is checked at scheduling, read and delivery');
  assert.equal(world.subscription.lastOperationReceiptId, 'work-operation-receipt-1');
  assert.ok(world.subscription.nextCheckAt > now);
});

test('a claimed subscription reuses its server-issued run plan after process loss before DSH dispatch', async () => {
  const world = makeWorld({ failBeforeReadTaskOnce: true });
  const delegation = await createDelegation(world, ['bilibili.dynamics.list']);
  const { subscription } = await world.feature.createSubscription(context(), {
    idempotencyKey: 'subscription-claim-replay',
    delegationId: delegation.id,
    sourceRefs,
    operation: { kind: 'list_dynamics', userId: '10086' },
    expiresAt: now + 5 * 24 * 60 * 60 * 1_000,
    nextCheckAt: now + 10_000,
  });

  await assert.rejects(world.feature.runScheduledSubscription(context(), subscription.id), /process loss after claim/u);
  const claimedAfterCrash = world.subscription;
  assert.equal(claimedAfterCrash.scheduledRunState, 'claimed');
  assert.equal(claimedAfterCrash.version, 2);
  const firstTaskId = world.calls.tasks[0].taskId;
  const firstPlan = world.calls.tasks[0].metadata;

  const recovered = await world.feature.runScheduledSubscription(context(), subscription.id);
  assert.equal(recovered.taskStatus, 'completed');
  assert.equal(world.calls.tasks[1].taskId, firstTaskId, 'recovery reuses the plan returned by the persisted claim');
  assert.deepEqual(world.calls.tasks[1].metadata, firstPlan);
  assert.equal(world.calls.operations.length, 1);
});

test('scheduled subscription rejects run-plan metadata outside the frozen server contract', async () => {
  const world = makeWorld({ addUnexpectedRunPlanMetadata: true });
  const delegation = await createDelegation(world, ['bilibili.dynamics.list']);
  const { subscription } = await world.feature.createSubscription(context(), {
    idempotencyKey: 'subscription-extra-run-plan-field',
    delegationId: delegation.id,
    sourceRefs,
    operation: { kind: 'list_dynamics', userId: '10086' },
    expiresAt: now + 5 * 24 * 60 * 60 * 1_000,
    nextCheckAt: now + 10_000,
  });
  await assert.rejects(world.feature.runScheduledSubscription(context(), subscription.id), error => {
    assert.equal(error.code, 'BILI_SUBSCRIPTION_RUN_PLAN_INVALID');
    return true;
  });
  assert.equal(world.calls.tasks.length, 0, 'malformed metadata is rejected before DSH task dispatch');
  assert.equal(world.calls.operations.length, 0, 'malformed metadata never reaches Exchange');
});

test('queued outbox receipt is not reported delivered and is reconciled without a second send', async () => {
  const world = makeWorld({ initialNotificationOutcome: 'queued' });
  const delegation = await createDelegation(world, ['bilibili.dynamics.list']);
  const { subscription } = await world.feature.createSubscription(context(), {
    idempotencyKey: 'subscription-outbox-pending',
    delegationId: delegation.id,
    sourceRefs,
    operation: { kind: 'list_dynamics', userId: '10086' },
    expiresAt: now + 5 * 24 * 60 * 60 * 1_000,
    nextCheckAt: now + 10_000,
  });

  const queued = await world.feature.runScheduledSubscription(context(), subscription.id);
  assert.equal(queued.notificationOutcome, 'queued');
  assert.equal(queued.outcome, 'checked');
  assert.equal(world.subscription.lastNotificationOutcome, 'queued');
  assert.equal(world.subscription.lastDeliveryReceiptId, null);
  assert.equal(world.subscription.nextCheckAt, now + 30_000);
  assert.equal(world.calls.notifications.length, 1);

  world.setNotificationOutcome('delivered');
  const reconciled = await world.feature.runScheduledSubscription(context(), subscription.id);
  assert.equal(reconciled.notificationOutcome, 'delivered');
  assert.equal(reconciled.outcome, 'checked');
  assert.equal(world.subscription.lastNotificationOutcome, 'delivered');
  assert.equal(world.subscription.lastDeliveryReceiptId, 'platform-delivery-1');
  assert.equal(world.calls.notifications.length, 1, 'status reconciliation must never submit a second notification');
  assert.equal(world.calls.operations.length, 1, 'pending outbox status is reconciled before another provider read');
  assert.equal(world.calls.tasks.length, 3, 'status reconciliation adds one readback Task without resending');
});

test('an outbox acknowledgement without a platform delivery receipt becomes uncertain', async () => {
  const world = makeWorld({ omitDeliveryReceiptId: true });
  const delegation = await createDelegation(world, ['bilibili.dynamics.list']);
  const { subscription } = await world.feature.createSubscription(context(), {
    idempotencyKey: 'subscription-delivery-proof-required',
    delegationId: delegation.id,
    sourceRefs,
    operation: { kind: 'list_dynamics', userId: '10086' },
    expiresAt: now + 5 * 24 * 60 * 60 * 1_000,
    nextCheckAt: now + 10_000,
  });
  const result = await world.feature.runScheduledSubscription(context(), subscription.id);
  assert.equal(result.outcome, 'uncertain');
  assert.equal(world.subscription.state, 'uncertain');
  assert.equal(world.subscription.lastDeliveryReceiptId, null);
  assert.equal(world.calls.notifications.length, 1);
});

test('quiet or disabled delivery is durably held and pauses the subscription', async () => {
  const world = makeWorld({ policyEnabled: false });
  const delegation = await createDelegation(world, ['bilibili.dynamics.list']);
  const { subscription } = await world.feature.createSubscription(context(), {
    idempotencyKey: 'subscription-held',
    delegationId: delegation.id,
    sourceRefs,
    operation: { kind: 'list_dynamics', userId: '10086' },
    expiresAt: now + 5 * 24 * 60 * 60 * 1_000,
    nextCheckAt: now + 10_000,
  });
  const result = await world.feature.runScheduledSubscription(context(), subscription.id);
  assert.equal(result.outcome, 'held');
  assert.equal(world.calls.notifications.length, 0);
  assert.equal(world.calls.holds.length, 1);
  assert.equal(world.subscription.state, 'paused');
  world.setPolicy({ enabled: true });
  const resumed = await world.feature.resumeSubscription(context(), world.subscription.id, world.subscription.version, now + 30_000);
  assert.equal(resumed.subscription.state, 'active');
  assert.equal(resumed.subscription.nextCheckAt, now + 30_000);
  assert.equal(resumed.scheduleId, 'schedule-3');
});

test('cooldown scans past a full recent page before allowing a subscription notification', async () => {
  const world = makeWorld();
  world.setPolicy({ cooldownSeconds: 2 });
  let historyPages = 0;
  world.api.listMessages = async (_context, input) => {
    historyPages += 1;
    if (input.cursor === undefined) {
      return {
        items: Array.from({ length: 100 }, (_, index) => ({
          id: `recent-user-${index}`, eventId: index === 0 ? 'user-event-bili-1' : `event-${index}`, role: 'user', content: 'recent',
          occurredAt: now - 100, status: 'active',
          scope: { conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId, visibility: scope.visibility },
        })),
        nextCursor: 'older-page',
      };
    }
    return {
      items: [{
        id: 'recent-assistant', eventId: 'recent-assistant-event', role: 'assistant', content: 'recent reply',
        occurredAt: now - 500, status: 'active',
        scope: { conversationId: scope.conversationId, conversationKind: scope.conversationKind, personaId: scope.personaId, visibility: scope.visibility },
      }],
      nextCursor: null,
    };
  };
  const delegation = await createDelegation(world, ['bilibili.dynamics.list']);
  const { subscription } = await world.feature.createSubscription(context(), {
    idempotencyKey: 'subscription-cooldown',
    delegationId: delegation.id,
    sourceRefs,
    operation: { kind: 'list_dynamics', userId: '10086' },
    expiresAt: now + 5 * 24 * 60 * 60 * 1_000,
    nextCheckAt: now + 10_000,
  });
  const result = await world.feature.runScheduledSubscription(context(), subscription.id);
  assert.equal(result.outcome, 'held');
  assert.equal(historyPages, 3, 'current-request lineage lookup and the two-page cooldown scan all use the authenticated Work history API');
  assert.equal(world.calls.notifications.length, 0);
  assert.equal(world.calls.holds.length, 1);
});

test('queued notification rechecks TTL at task execution and does not send after expiry', async () => {
  const world = makeWorld({ advanceBeforeNotificationMs: 6 * 24 * 60 * 60 * 1_000 });
  const delegation = await createDelegation(world, ['bilibili.dynamics.list']);
  const { subscription } = await world.feature.createSubscription(context(), {
    idempotencyKey: 'subscription-expiry-while-queued',
    delegationId: delegation.id,
    sourceRefs,
    operation: { kind: 'list_dynamics', userId: '10086' },
    expiresAt: now + 5 * 24 * 60 * 60 * 1_000,
    nextCheckAt: now + 10_000,
  });
  const result = await world.feature.runScheduledSubscription(context(), subscription.id);
  assert.equal(world.currentNow, now + 6 * 24 * 60 * 60 * 1_000);
  assert.equal(result.outcome, 'held');
  assert.equal(world.calls.notifications.length, 0, 'TTL is checked after the DSH notification task leaves its queue');
  assert.equal(world.calls.holds.length, 1);
  assert.equal(world.subscription.state, 'paused');
});

test('revocation after a provider read blocks observation delivery', async () => {
  const world = makeWorld({ revokeAfterOperation: true });
  const delegation = await createDelegation(world, ['bilibili.dynamics.list']);
  const { subscription } = await world.feature.createSubscription(context(), {
    idempotencyKey: 'subscription-revoked',
    delegationId: delegation.id,
    sourceRefs,
    operation: { kind: 'list_dynamics', userId: '10086' },
    expiresAt: now + 5 * 24 * 60 * 60 * 1_000,
    nextCheckAt: now + 10_000,
  });
  await assert.rejects(world.feature.runScheduledSubscription(context(), subscription.id), error => {
    assert.equal(error.code, 'BILI_DELEGATION_DENIED');
    return true;
  });
  assert.equal(world.calls.notifications.length, 0);
  assert.equal(world.calls.holds.length, 0);
});

test('delegation revocation cancels durable subscriptions and their DSH Schedule entries', async () => {
  const world = makeWorld();
  const delegation = await createDelegation(world, ['bilibili.dynamics.list']);
  const { subscription } = await world.feature.createSubscription(context(), {
    idempotencyKey: 'subscription-revoke-cleanup',
    delegationId: delegation.id,
    sourceRefs,
    operation: { kind: 'list_dynamics', userId: '10086' },
    expiresAt: now + 5 * 24 * 60 * 60 * 1_000,
    nextCheckAt: now + 10_000,
  });
  const result = await world.feature.revokeDelegation(context(), delegation.id, delegation.version);
  assert.equal(result.delegation.revokedAt, now);
  assert.equal(result.subscriptionsCancelled, 1);
  assert.equal(result.scheduleEntriesRemoved, 1);
  assert.equal(world.subscription.state, 'revoked');
  assert.equal(world.calls.schedules.at(-1).kind, 'cancel');
  assert.equal(subscription.state, 'active');
});

test('completed read and notification Work Tasks recover after a crash before subscription CAS', async () => {
  const world = makeWorld({ failRecordCheckOnce: true });
  const delegation = await createDelegation(world, ['bilibili.dynamics.list']);
  const { subscription } = await world.feature.createSubscription(context(), {
    idempotencyKey: 'subscription-recover-checkpoint',
    delegationId: delegation.id,
    sourceRefs,
    operation: { kind: 'list_dynamics', userId: '10086' },
    expiresAt: now + 5 * 24 * 60 * 60 * 1_000,
    nextCheckAt: now + 10_000,
  });
  await assert.rejects(world.feature.runScheduledSubscription(context(), subscription.id), /simulated crash before subscription checkpoint/u);
  assert.equal(world.subscription.version, 2, 'claim persisted before the later Work checkpoint failed');
  assert.equal(world.subscription.scheduledRunState, 'claimed');

  const recovered = await world.feature.runScheduledSubscription(context(), subscription.id);
  assert.equal(recovered.outcome, 'checked');
  assert.equal(world.subscription.version, 3);
  assert.equal(world.subscription.lastOperationReceiptId, 'work-operation-receipt-1');
  assert.equal(world.subscription.lastNotificationReceiptId, 'notification-receipt-1');
  assert.equal(world.calls.operations.length, 1, 'completed read Work Task is reconciled by its persistent operation key');
  assert.equal(world.calls.notifications.length, 1, 'completed notification Work Task is reconciled by its durable receipt');
});

test('read receipt stays uncertain when its child DSH Task fails before a completed output receipt', async () => {
  const world = makeWorld({ failReadTaskOnce: true });
  const delegation = await createDelegation(world, ['bilibili.dynamics.list']);
  const { subscription } = await world.feature.createSubscription(context(), {
    idempotencyKey: 'subscription-read-terminal-recovery',
    delegationId: delegation.id,
    sourceRefs,
    operation: { kind: 'list_dynamics', userId: '10086' },
    expiresAt: now + 5 * 24 * 60 * 60 * 1_000,
    nextCheckAt: now + 10_000,
  });
  const result = await world.feature.runScheduledSubscription(context(), subscription.id);
  assert.equal(result.taskStatus, 'failed', 'the DSH Task failure remains visible');
  assert.equal(result.outcome, 'uncertain', 'a provider result without completed child Task binding is not released');
  assert.equal(world.calls.operations.length, 1);
  assert.equal(world.calls.notifications.length, 0);
  assert.equal(world.subscription.lastOperationReceiptId, 'work-operation-receipt-1');
  assert.equal(world.subscription.state, 'uncertain');
});

test('scheduled Bilibili identifiers parse only the explicit marker kind', () => {
  const marker = conversationScheduleMarker('bili-subscription', 'subscription-1');
  assert.deepEqual(parseConversationScheduleMarkerV1(`[CYRENE_CONVERSATION_SCHEDULE_V1]\n${JSON.stringify(marker)}`), marker);
  assert.equal(parseConversationScheduleMarkerV1('[CYRENE_CONVERSATION_SCHEDULE_V1]\n{"version":1,"kind":"bili-subscription","resourceId":""}'), undefined);
});

test('Bilibili account operations fail closed without owner-scoped production adapters', () => {
  assert.throws(() => createBiliDelegationFeature({ api: { apiVersion: 1 } }), error => {
    assert.equal(error.code, 'BILI_HOST_PORT_UNAVAILABLE');
    return true;
  });
  assert.equal(new ConversationDomainApiError('example', 400, false, 'example').status, 400);
});
