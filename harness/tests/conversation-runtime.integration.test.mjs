// SIMULATED local HTTP Work fixture; this is not a real Navigator/DirectPlugin acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

import {
  ConversationResearchReadProviderV1,
  ConversationRuntimeWorkClient,
  WorkRuntimeHttpError,
} from '../dist/conversation-runtime/index.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const sourceMessageId = 'message-1';
const artifactId = 'a'.repeat(64);
const sourceRefs = [{ memoryId: null, memoryVersion: null, sourceMessageIds: [sourceMessageId] }];
const requests = [];
let server;
let baseUrl;
let authorizeSource = true;

before(async () => {
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: request.method, path: url.pathname, query: url.searchParams, body, authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');

    if (url.pathname.endsWith('/conversation-memory/sources/authorize')) {
      send(response, 200, { allowed: authorizeSource, currentAuthorizationEpoch: 7, deniedSourceIds: [] });
      return;
    }
    if (url.pathname.endsWith('/conversation-memory/messages')) {
      if (url.searchParams.get('cursor') === null) {
        send(response, 200, { items: [], nextCursor: 'page-2' });
      } else {
        send(response, 200, {
          items: [{
            id: sourceMessageId,
            eventId: 'event-1',
            role: 'user',
            status: 'active',
            scope: { conversationId: 'conversation-1', conversationKind: 'direct', personaId: null, visibility: 'private' },
            attachments: [{ artifactId, sha256: artifactId, mimeType: 'application/pdf', size: 128 }],
          }],
          nextCursor: null,
        });
      }
      return;
    }
    if (url.pathname.endsWith('/conversation-memory/artifacts/authorize')) {
      send(response, 200, {
        allowed: true,
        currentAuthorizationEpoch: 7,
        artifact: { artifactId, sha256: artifactId, name: 'report.pdf', mimeType: 'application/pdf', size: 128 },
      });
      return;
    }
    if (url.pathname.endsWith('/conversation-runtime/research/read')) {
      assert.deepEqual(body.attachmentIds, [artifactId]);
      assert.deepEqual(body.sourceRefs, sourceRefs);
      const content = 'A bounded fixture result.';
      send(response, 200, {
        operationId: 'operation-1',
        title: 'Fixture result',
        content,
        resultSha256: 'b'.repeat(64),
        contentSha256: digest(content),
        artifactId: 'b'.repeat(64),
        sourceEvidence: [{
          sourceRef: 'sha256:' + 'c'.repeat(64),
          kind: 'document',
          title: 'report.pdf',
          artifactId,
          sourceSha256: 'd'.repeat(64),
          retrievedAt: '2026-10-31T12:00:00Z',
        }],
      });
      return;
    }
    if (url.pathname.endsWith('/conversation-runtime/operations/operation-1/receipt')) {
      send(response, 200, {
        id: 'operation-1',
        workspaceId: 'w1',
        actorId: 'actor-1',
        taskId: 'child-task',
        taskStatus: 'completed',
        taskOutputSha256: 'e'.repeat(64),
        status: 'verified',
        operationType: 'conversation.research.read.v1',
        effect: 'read',
        resultSha256: 'b'.repeat(64),
        contentSha256: digest('A bounded fixture result.'),
        targetDigestSha256: 'f'.repeat(64),
        sourceRefs,
        sourceEvidence: [{
          sourceRef: 'sha256:' + 'c'.repeat(64),
          kind: 'document',
          title: 'report.pdf',
          artifactId,
          sourceSha256: 'd'.repeat(64),
          retrievedAt: '2026-10-31T12:00:00Z',
        }],
        verifiedAt: 1_798_000_000_000,
      });
      return;
    }
    send(response, 404, { code: 'NOT_FOUND' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('ResearchRead pages source history, rechecks attachments, then calls the fixed Work research route', async () => {
  requests.length = 0;
  authorizeSource = true;
  const context = {
    workspaceId: 'w1',
    actorId: 'actor-1',
    conversationId: 'conversation-1',
    conversationKind: 'direct',
    personaId: null,
    authorizationEpoch: 7,
    taskId: 'parent-task',
    sessionId: 'session-1',
    signal: new AbortController().signal,
  };
  const work = new ConversationRuntimeWorkClient(baseUrl, 'w1', {
    tokenFor: scope => {
      assert.deepEqual(scope, { workspaceId: 'w1', actorId: 'actor-1' });
      return 'actor-private-work-token';
    },
  });
  const provider = new ConversationResearchReadProviderV1(work);
  const result = await provider.read({
    context,
    childTask: { taskId: 'child-task', sessionId: 'session-1' },
    scope: {
      workspaceId: 'w1', actorId: 'actor-1', conversationId: 'conversation-1',
      conversationKind: 'direct', personaId: null,
    },
    query: 'Find the report result',
    sourceRefs,
    signal: context.signal,
  });

  assert.equal(result.operationId, 'operation-1');
  assert.equal(result.contentSha256, digest(result.content));
  assert.equal(result.sourceEvidence[0].sourceSha256, 'd'.repeat(64));
  assert.deepEqual(requests.map(row => row.path.split('/').at(-1)), [
    'authorize', 'messages', 'messages', 'authorize', 'read',
  ]);
  assert.ok(requests.every(row => row.authorization === 'Bearer actor-private-work-token'));
  const readBody = requests.at(-1).body;
  assert.equal(readBody.taskId, 'child-task');
  assert.equal(readBody.parentTaskId, 'parent-task');
  assert.equal(readBody.parentSessionId, 'session-1');
  assert.equal('actorId' in readBody, false);
  assert.equal('providerUrl' in readBody, false);

  const receipt = await work.readResearchOperationReceipt(context, result.operationId);
  assert.equal(receipt.taskStatus, 'completed');
  assert.equal(receipt.taskOutputSha256, 'e'.repeat(64));
  assert.deepEqual(receipt.sourceRefs, sourceRefs);
});

test('ResearchRead stops before tool dispatch when current source authorization is revoked', async () => {
  requests.length = 0;
  authorizeSource = false;
  const context = {
    workspaceId: 'w1', actorId: 'actor-1', conversationId: 'conversation-1',
    conversationKind: 'direct', personaId: null, authorizationEpoch: 7,
    taskId: 'parent-task', sessionId: 'session-1', signal: new AbortController().signal,
  };
  const provider = new ConversationResearchReadProviderV1(new ConversationRuntimeWorkClient(baseUrl, 'w1', {
    tokenFor: () => 'actor-private-work-token',
  }));

  await assert.rejects(provider.read({
    context,
    childTask: { taskId: 'child-task', sessionId: 'session-1' },
    scope: {
      workspaceId: 'w1', actorId: 'actor-1', conversationId: 'conversation-1',
      conversationKind: 'direct', personaId: null,
    },
    query: 'Find the report result',
    sourceRefs,
    signal: context.signal,
  }), error => error instanceof WorkRuntimeHttpError && error.code === 'CONVERSATION_SOURCE_REVOKED');
  assert.equal(requests.length, 1);
});

function send(response, status, value) {
  response.statusCode = status;
  response.end(JSON.stringify(value));
}
