// SIMULATED local Work HTTP fixture; no real Account Center or Bilibili account is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

import {
  ConversationBilibiliConnectionDirectoryV1,
  ConversationBilibiliDomainWorkPortV1,
  ConversationBilibiliOperationWorkPortV1,
  ConversationRuntimeWorkClient,
} from '../dist/conversation-runtime/index.js';
import { canonicalJson, sha256 } from '../dist/connector-authorization.js';

const connectionA = '11111111-1111-4111-8111-111111111111';
const connectionB = '22222222-2222-4222-8222-222222222222';
const profileA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const profileB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const resourceRef = `sha256:${sha256(canonicalJson({
  providerId: 'bilibili',
  profileRef: profileA,
  operationId: 'bilibili.video.read',
  target: { video_id: 'BV1xx411c7mD' },
}))}`;
const argsDigest = sha256(canonicalJson({ video_id: 'BV1xx411c7mD' }));
const proofDigest = '3'.repeat(64);
const requestLog = [];
let tamperRunPlan = false;
let biliTaskStatus = 'running';
let server;
let baseUrl;

before(async () => {
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requestLog.push({ method: request.method, path: url.pathname, query: url.searchParams, body, auth: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/bilibili/accounts')) {
      send(response, 200, { items: [
        { profileRef: profileA, provider: 'bilibili', externalSubject: '12345' },
        { profileRef: profileB, provider: 'bilibili', externalSubject: '67890' },
      ] });
      return;
    }
    if (url.pathname.endsWith('/bilibili/connections')) {
      send(response, 200, { items: [
        { connectionRef: connectionA, profileRef: profileA, provider: 'bilibili', displayName: 'Account A', enabled: true },
        { connectionRef: connectionB, profileRef: profileB, provider: 'bilibili', displayName: 'Account B', enabled: true },
      ] });
      return;
    }
    if (url.pathname.endsWith('/conversation-memory/sources/authorize')) {
      send(response, 200, { allowed: true, currentAuthorizationEpoch: 7, deniedSourceIds: [] });
      return;
    }
    if (url.pathname.endsWith('/conversation-memory/bilibili/subscriptions/sub-1/notification-authorization')) {
      assert.deepEqual(body, {
        expectedVersion: 3,
        runKey: 'run-3',
        sourceOutputSha256: '4'.repeat(64),
      });
      send(response, 200, {
        allowed: true,
        reason: null,
        subscriptionId: 'sub-1',
        version: 3,
        runKey: 'run-3',
        notificationIdempotencyKey: `bili-notification-${sha256(`sub-1\0${'4'.repeat(64)}`)}`,
      });
      return;
    }
    if (url.pathname.endsWith('/conversation-memory/bilibili/subscriptions/sub-1/claim')) {
      assert.deepEqual(body, { expectedVersion: 3 });
      const sub = claimedSubscription();
      const operationIdempotencyKey = 'server-issued-operation-key';
      const sourceMetadata = {
        source: 'conversation-bili-subscription-read',
        organizationId: 'org-1',
        workspaceId: 'w1',
        actorId: 'actor-1',
        subscriptionId: sub.id,
        delegationId: sub.delegationId,
        connectionRef: sub.connectionRef,
        profileRef: sub.profileRef,
        operationId: sub.operationId,
        resourceRef: sub.resourceRef,
        argumentsDigestSha256: sha256(canonicalJson(sub.arguments)),
        sourceRefsDigest: sha256(canonicalJson(sub.sourceRefs)),
        conversationId: sub.conversationId,
        conversationKind: sub.conversationKind,
        personaId: sub.personaId,
        ownerTaskId: sub.ownerTaskId,
        ownerSessionId: sub.ownerSessionId,
        runKey: sub.scheduledRunKey,
        expectedVersion: sub.scheduledExpectedVersion,
        operationIdempotencyKey,
      };
      const taskId = 'server-issued-check-task';
      const planPayload = {
        taskId,
        operationIdempotencyKey: sourceMetadata.operationIdempotencyKey,
        sourceMetadata,
        arguments: sub.arguments,
        cursor: sub.cursor,
        sourceRefs: sub.sourceRefs,
      };
      send(response, 200, {
        subscription: sub,
        runPlan: {
          taskId,
          operationIdempotencyKey: sourceMetadata.operationIdempotencyKey,
          sourceMetadata,
          runtimePlanDigest: tamperRunPlan ? '0'.repeat(64) : sha256(canonicalJson(planPayload)),
        },
      });
      return;
    }
    if (url.pathname.endsWith(`/bilibili/connections/${connectionA}/reads/bilibili.video.read`)) {
      assert.equal(request.headers['x-cyrene-work-task-id'], 'bili-child-task');
      assert.equal(request.headers['idempotency-key'], 'bili-read-key');
      send(response, 202, { accepted: true });
      return;
    }
    if (url.pathname.endsWith('/bilibili/operations/by-idempotency-key')) {
      assert.equal(request.headers['x-cyrene-work-task-id'], 'bili-child-task');
      assert.equal(request.headers['idempotency-key'], 'bili-read-key');
      send(response, 200, biliOperationEnvelope());
      return;
    }
    if (url.pathname.endsWith('/tasks/bili-child-task')) {
      send(response, 200, { task: biliTaskRecord(biliTaskStatus) });
      return;
    }
    if (url.pathname.endsWith(`/attachments/${biliResultDigest()}`)) {
      response.setHeader('content-type', 'application/json');
      response.end(Buffer.from(canonicalJson({ title: 'Fixture video' }), 'utf8'));
      return;
    }
    if (url.pathname.endsWith('/notifications/by-deduplication-key')) {
      assert.equal(url.searchParams.get('deduplicationKey'), 'followup-key');
      send(response, 200, notificationRecord('followup-key'));
      return;
    }
    if (url.pathname.endsWith('/notifications/notification-1') && request.method === 'GET') {
      send(response, 200, notificationRecord('followup-key'));
      return;
    }
    if (url.pathname.endsWith('/notifications') && request.method === 'POST') {
      assert.equal(body.taskId, 'task-1');
      send(response, 201, { notification: notificationRecord(body.deduplicationKey, body), duplicate: false });
      return;
    }
    if (url.pathname.endsWith('/conversation-memory/messages')) {
      send(response, 200, { items: [{
        id: 'message-1', eventId: 'event-1', role: 'user', status: 'active',
        scope: { conversationId: 'conversation-1', conversationKind: 'direct', personaId: null, visibility: 'private' },
        attachments: [],
      }], nextCursor: null });
      return;
    }
    if (url.pathname.endsWith('/conversation-memory/bilibili/delegations') && request.method === 'POST') {
      assert.ok(body.idempotencyKey.startsWith('bili-delegation-'));
      assert.equal(body.conversationId, 'conversation-1');
      assert.deepEqual(body.grants, [{
        operationId: 'bilibili.video.read',
        target: { video_id: 'BV1xx411c7mD' },
        argumentsDigestSha256: argsDigest,
      }]);
      assert.deepEqual(body.sourceRefs, [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['message-1'] }]);
      send(response, 201, { delegation: delegation(body), duplicate: false });
      return;
    }
    if (url.pathname === `/api/v1/workspaces/w1/work/conversation-memory/bilibili/delegations/${delegationId}/authorize`) {
      assert.equal(body.target.video_id, 'BV1xx411c7mD');
      assert.equal(body.resourceRef, undefined, 'Work derives resource identity from the exact account and arguments');
      assert.equal(body.argumentsDigestSha256, argsDigest);
      assert.deepEqual(body.arguments, { video_id: 'BV1xx411c7mD' });
      send(response, 200, {
        allowed: true,
        delegationId,
        resourceRef,
        version: 1,
        expiresAt: 1_798_000_000_000,
        freshGrantRef: 'grant-ref-from-server',
        freshProofDigest: proofDigest,
        proofExpiresAt: 1_798_000_015_000,
        requiresFreshProviderProof: true,
      });
      return;
    }
    send(response, 404, { code: 'NOT_FOUND' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

const delegationId = 'delegation-1';

test('Bilibili connection resolution uses the exact selected profile and never auto-selects', async () => {
  requestLog.length = 0;
  const context = runtimeContext();
  const work = client();
  const directory = new ConversationBilibiliConnectionDirectoryV1(work);
  const selected = await directory.getOwnedConnectionByProfile(context, profileB);
  assert.deepEqual(selected, {
    workspaceId: 'w1',
    ownerActorId: 'actor-1',
    connectionRef: connectionB,
    profileRef: profileB,
    provider: 'bilibili',
    enabled: true,
    externalSubject: '67890',
  });
  assert.equal(await directory.getOwnedConnectionByProfile(context, 'unknown-profile'), undefined);
  const exact = await directory.getOwnedConnection(context, connectionA);
  assert.equal(exact?.profileRef, profileA);
  assert.ok(requestLog.every(item => item.auth === 'Bearer actor-private-token'));
});

test('Bilibili delegation Work adapter binds exact scope and consumes only server-issued proof', async () => {
  requestLog.length = 0;
  const context = runtimeContext();
  const domain = new ConversationBilibiliDomainWorkPortV1(client());
  const delegationInput = {
    granteeActorId: context.actorId,
    connectionRef: connectionA,
    profileRef: profileA,
    operationIds: ['bilibili.video.read'],
    targetScopes: [{
      operationId: 'bilibili.video.read',
      target: { video_id: 'BV1xx411c7mD' },
      resourceRef,
      argumentsDigestSha256: argsDigest,
    }],
    expiresAt: 1_798_000_000_000,
  };
  const created = await domain.createDelegation(context, delegationInput);
  assert.equal(created.delegation.connectionRef, connectionA);
  assert.equal(created.delegation.targetScopes[0].resourceRef, resourceRef);
  assert.equal(created.duplicate, false);
  const authorize = domain.delegationPort().authorize;
  const proof = await authorize(context, {
    delegationId,
    granteeActorId: context.actorId,
    connectionRef: connectionA,
    profileRef: profileA,
    operationId: 'bilibili.video.read',
    target: { video_id: 'BV1xx411c7mD' },
    resourceRef,
    arguments: { video_id: 'BV1xx411c7mD' },
    argumentsDigestSha256: argsDigest,
    now: 1_798_000_000_000,
  });
  assert.equal(proof.authorization?.proofRef, 'grant-ref-from-server');
  assert.equal(proof.authorization?.proofDigest, proofDigest);
  assert.equal(proof.authorization?.directoryEpoch, undefined);
  const authorizeRequest = requestLog.find(item => item.path.includes('/bilibili/delegations/') && item.path.endsWith('/authorize'));
  assert.equal(authorizeRequest.body.argumentsDigestSha256, argsDigest);
  assert.equal(authorizeRequest.body.profileRef, undefined, 'Work resolves the profile from the owner-scoped delegation');
});

test('Bilibili notification authorization is exact-version and source-digest bound', async () => {
  requestLog.length = 0;
  const domain = new ConversationBilibiliDomainWorkPortV1(client());
  const authorize = domain.subscriptionPort().authorizeNotification;
  const result = await authorize(runtimeContext(), 'sub-1', {
    expectedVersion: 3,
    runKey: 'run-3',
    sourceOutputSha256: '4'.repeat(64),
  });
  assert.deepEqual(result, {
    allowed: true,
    reason: null,
    subscriptionId: 'sub-1',
    version: 3,
    runKey: 'run-3',
    notificationIdempotencyKey: `bili-notification-${sha256(`sub-1\0${'4'.repeat(64)}`)}`,
  });
  const call = requestLog.find(item => item.path.endsWith('/notification-authorization'));
  assert.equal(call.method, 'POST');
  assert.equal(call.auth, 'Bearer actor-private-token');
  assert.deepEqual(call.body, {
    expectedVersion: 3,
    runKey: 'run-3',
    sourceOutputSha256: '4'.repeat(64),
  });
});

test('Bilibili subscription claim accepts only the exact server-issued DSH run plan', async () => {
  requestLog.length = 0;
  tamperRunPlan = false;
  const domain = new ConversationBilibiliDomainWorkPortV1(client());
  const claim = await domain.subscriptionPort().claim(runtimeContext(), 'sub-1', 3);
  assert.equal(claim.subscription.version, 4);
  assert.equal(claim.runPlan.taskId, 'server-issued-check-task');
  assert.equal(claim.runPlan.operationIdempotencyKey, 'server-issued-operation-key');
  assert.equal(claim.runPlan.sourceMetadata.source, 'conversation-bili-subscription-read');
  assert.equal(claim.runPlan.sourceMetadata.expectedVersion, 4);
  assert.ok(/^[a-f0-9]{64}$/u.test(claim.runPlan.runtimePlanDigest));
  const call = requestLog.find(item => item.path.endsWith('/subscriptions/sub-1/claim'));
  assert.equal(call.auth, 'Bearer actor-private-token');
  tamperRunPlan = true;
  await assert.rejects(domain.subscriptionPort().claim(runtimeContext(), 'sub-1', 3), /RUN_PLAN_DIGEST_MISMATCH/u);
  tamperRunPlan = false;
});

test('Bilibili operation adapter withholds result until Task completion and verifies artifact bytes', async () => {
  requestLog.length = 0;
  biliTaskStatus = 'running';
  const context = { ...runtimeContext(), taskId: 'bili-child-task' };
  const sourceRefs = [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['message-1'] }];
  const argumentsValue = { video_id: 'BV1xx411c7mD' };
  const operation = new ConversationBilibiliOperationWorkPortV1(client()).operationPort();
  const input = {
    delegation: {
      delegationId,
      workspaceId: context.workspaceId,
      ownerActorId: context.actorId,
      granteeActorId: context.actorId,
      connectionRef: connectionA,
      profileRef: profileA,
      operationId: 'bilibili.video.read',
      resourceRef,
      argumentsDigestSha256: argsDigest,
      delegationVersion: 1,
      validUntil: Number.MAX_SAFE_INTEGER,
      proofRef: 'fresh-grant-ref',
      proofDigest,
    },
    connection: {
      workspaceId: context.workspaceId,
      ownerActorId: context.actorId,
      connectionRef: connectionA,
      profileRef: profileA,
      provider: 'bilibili',
      enabled: true,
      externalSubject: '12345',
    },
    operationId: 'bilibili.video.read',
    target: { video_id: 'BV1xx411c7mD' },
    resourceRef,
    arguments: argumentsValue,
    argumentsDigestSha256: argsDigest,
    sourceRefs,
    idempotencyKey: 'bili-read-key',
    signal: context.signal,
  };
  const pending = await operation.invoke(context, input);
  assert.equal(pending.receipt.outcome, 'pending');
  assert.equal(pending.result, undefined, 'a running Task cannot publish a verified result');
  biliTaskStatus = 'completed';
  const completed = await operation.findByIdempotencyKey(runtimeContext(), 'bili-read-key', runtimeContext().signal, 'bili-child-task');
  assert.equal(completed.receipt.outcome, 'verified');
  assert.deepEqual(completed.result, { title: 'Fixture video' });
  assert.equal(completed.receipt.taskOutputSha256, sha256(biliTaskRecord('completed').output));
  assert.equal(completed.receipt.externalReadbackVerified, false);
  assert.equal(requestLog.filter(item => item.path.endsWith('/reads/bilibili.video.read')).length, 1);
});

test('Work outbox adapter uses exact actor-private notification reads and never lists the workspace queue', async () => {
  requestLog.length = 0;
  const context = runtimeContext();
  const work = client();
  const payload = {
    subscriptionId: 'sub-1',
    sourceOutputSha256: '6'.repeat(64),
    resourceRef,
    targetDigestSha256: resourceRef.slice('sha256:'.length),
    contentSha256: '7'.repeat(64),
    text: 'A verified observation',
  };
  const queued = await work.enqueueWorkNotification(context, {
    deduplicationKey: 'followup-key',
    type: 'teams.message',
    connectorId: 'teams-v1',
    recipient: 'teams:host-resolved-thread',
    payload,
  }, context.signal);
  assert.equal(queued.notification.id, 'notification-1');
  assert.equal(queued.duplicate, false);
  assert.equal((await work.getWorkNotificationByDeduplicationKey(context, 'followup-key', context.signal))?.id, 'notification-1');
  assert.equal((await work.getWorkNotification(context, 'notification-1', context.signal)).status, 'queued');
  assert.ok(requestLog.every(item => item.auth === 'Bearer actor-private-token'));
  assert.equal(requestLog.some(item => item.path.endsWith('/notifications?limit=500')), false);
});

function runtimeContext() {
  return {
    workspaceId: 'w1',
    actorId: 'actor-1',
    conversationId: 'conversation-1',
    conversationKind: 'direct',
    personaId: null,
    authorizationEpoch: 7,
    taskId: 'task-1',
    sessionId: 'session-1',
    origin: { kind: 'web', sourceId: 'message-1', externalEventId: 'event-1' },
    signal: new AbortController().signal,
  };
}

function client() {
  return new ConversationRuntimeWorkClient(baseUrl, 'w1', { tokenFor: () => 'actor-private-token' });
}

function delegation(body) {
  const grants = body.grants.map(value => ({
    ...value,
    resourceRef,
  }));
  return {
    id: delegationId,
    workspaceId: 'w1',
    ownerActorId: 'actor-1',
    granteeActorId: 'actor-1',
    connectionRef: body.connectionRef,
    profileRef: body.profileRef,
    conversationId: body.conversationId,
    conversationKind: body.conversationKind,
    personaId: body.personaId,
    grants,
    sourceRefs: body.sourceRefs,
    expiresAt: body.expiresAt,
    state: 'active',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function claimedSubscription() {
  const sourceRefs = [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['message-1'] }];
  const args = { video_id: 'BV1xx411c7mD', page: 1, limit: 20 };
  return {
    id: 'sub-1', idempotencyKey: 'subscription-key', workspaceId: 'w1', ownerActorId: 'actor-1',
    conversationId: 'conversation-1', conversationKind: 'direct', personaId: null,
    delegationId, connectionRef: connectionA, profileRef: profileA,
    ownerTaskId: 'task-1', ownerSessionId: 'session-1', operationId: 'bilibili.comments.list',
    argumentsDigestSha256: sha256(canonicalJson(args)),
    resourceRef: `sha256:${sha256(canonicalJson({
      providerId: 'bilibili', profileRef: profileA, operationId: 'bilibili.comments.list',
      target: { video_id: 'BV1xx411c7mD' },
    }))}`,
    arguments: args, sourceRefs, expiresAt: 1_799_000_000_000, nextCheckAt: 1_798_000_000_000,
    scheduledRunKey: 'bili-run-4', scheduledExpectedVersion: 4, scheduledRunState: 'claimed',
    cursor: null, lastOutputSha256: null, lastOperationReceiptId: null,
    lastNotificationReceiptId: null, lastNotificationReadbackReceiptId: null,
    lastNotificationOutcome: null, lastDeliveryReceiptId: null, notificationSendAllowed: true,
    state: 'active', version: 4, createdAt: 1, updatedAt: 2,
  };
}

function biliOperationEnvelope() {
  const sourceRefs = [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['message-1'] }];
  const output = 'Bilibili result artifact  ' + biliResultDigest();
  const task = biliTaskRecord(biliTaskStatus);
  const evidence = {
    effect: 'read',
    outcome: 'verified',
    providerId: 'bilibili',
    connectionRef: connectionA,
    profileRef: profileA,
    operationId: 'bilibili.video.read',
    resourceRef,
    argumentsSha256: argsDigest,
    resultArtifactId: biliResultDigest(),
    resultSha256: biliResultDigest(),
    readbackVerified: true,
    externalReadbackVerified: false,
    ...(biliTaskStatus === 'completed' ? { taskOutputSha256: sha256(output) } : {}),
  };
  return {
    operation: {
      id: 'bili-operation-receipt',
      idempotencyKey: 'bili-read-key',
      operationType: 'tool.provider.v1:bilibili.video.read',
      taskId: 'bili-child-task',
      target: resourceRef,
      request: {
        source: 'conversation-bili-operation',
        actorScopeSha256: '5'.repeat(64),
        connectionRefDigest: sha256(connectionA),
        profileRefDigest: sha256(profileA),
        operationId: 'bilibili.video.read',
        resourceRef,
        argumentsSha256: argsDigest,
        taskId: 'bili-child-task',
        parentTaskId: 'task-1',
        parentSessionId: 'session-1',
        delegationId,
        delegationVersion: 1,
        sourceRefsSha256: sha256(canonicalJson(sourceRefs)),
      },
      status: 'verified',
      evidence,
      trustedProducer: 'exchange-connector-dispatch',
      createdAt: 10,
      updatedAt: 11,
    },
    resultArtifact: {
      artifactId: biliResultDigest(),
      sha256: biliResultDigest(),
      mimeType: 'application/json',
      size: Buffer.byteLength(canonicalJson({ title: 'Fixture video' }), 'utf8'),
    },
  };
}

function biliTaskRecord(status) {
  return {
    id: 'bili-child-task',
    workspaceId: 'w1',
    sessionId: 'session-1',
    createdByActorId: 'actor-1',
    status,
    output: 'Bilibili result artifact  ' + biliResultDigest(),
    metadata: {
      source: 'conversation-bili-operation',
      workspaceId: 'w1',
      actorId: 'actor-1',
      conversationId: 'conversation-1',
      parentTaskId: 'task-1',
      parentSessionId: 'session-1',
      sourceRefs: [{ memoryId: null, memoryVersion: null, sourceMessageIds: ['message-1'] }],
      connectionRef: connectionA,
      profileRef: profileA,
      operationId: 'bilibili.video.read',
      target: { video_id: 'BV1xx411c7mD' },
      resourceRef,
      arguments: { video_id: 'BV1xx411c7mD' },
      argumentsDigestSha256: argsDigest,
      delegationId,
      delegationVersion: 1,
      idempotencyKey: 'bili-read-key',
    },
  };
}

function biliResultDigest() {
  return sha256(canonicalJson({ title: 'Fixture video' }));
}

function notificationRecord(deduplicationKey, override = {}) {
  const payload = override.payload ?? {
    subscriptionId: 'sub-1', sourceOutputSha256: '6'.repeat(64), resourceRef,
    targetDigestSha256: resourceRef.slice('sha256:'.length), contentSha256: '7'.repeat(64),
    text: 'A verified observation',
  };
  return {
    id: 'notification-1',
    deduplicationKey,
    type: override.type ?? 'teams.message',
    payload,
    taskId: override.taskId ?? 'task-1',
    connectorId: override.connectorId ?? 'teams-v1',
    recipient: override.recipient ?? 'teams:host-resolved-thread',
    status: 'queued',
    availableAt: 1,
    createdAt: 1,
    updatedAt: 1,
    result: {},
  };
}

function send(response, status, value) {
  response.statusCode = status;
  response.end(JSON.stringify(value));
}
