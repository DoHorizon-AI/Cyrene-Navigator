// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator conversation media bridge tests                    │
// │ Role: Verify opaque-ID HTTP calls, provenance and cancellation.       │
// │ 模块职责：验证媒体 bridge 不发原始字节并阻止迟到上下文贡献。           │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  ConversationMediaBridgeError,
  NavigatorConversationMediaHttpBridge,
  createConversationMediaFeature,
} from '../dist/conversation-media/index.js';
import { hasConversationContextProofV1 } from '../dist/features/conversation-memory.js';

const scope = {
  workspaceId: 'workspace-media-test',
  actorId: 'actor-media-test',
  conversationId: 'conversation-media-test',
  conversationKind: 'direct',
  personaId: 'persona-media-test',
  visibility: 'private',
  authorizationEpoch: 7,
};

let contextSequence = 0;

function trustedContext(signal = new AbortController().signal) {
  contextSequence += 1;
  return {
    ...scope,
    taskId: `media-task-${contextSequence}`,
    sessionId: `media-session-${contextSequence}`,
    signal,
  };
}

function attachment(mimeType = 'image/png') {
  const sha256 = 'a'.repeat(64);
  return { artifactId: sha256, sha256, name: 'test-media', mimeType, size: 128 };
}

function sourceRef(messageId = 'work-message-1') {
  return { memoryId: null, memoryVersion: null, sourceMessageIds: [messageId] };
}

function api(overrides = {}) {
  return {
    apiVersion: 1,
    async authorizeSources(context, input) {
      return {
        allowed: true,
        currentAuthorizationEpoch: context.authorizationEpoch,
        deniedSourceIds: [],
        ...overrides.authorization,
        input,
      };
    },
  };
}

function mediaInput(overrides = {}) {
  return {
    messageId: 'work-message-1',
    query: 'What is in this image?',
    attachments: [attachment()],
    ...overrides,
  };
}

test('media context feature authorizes exact refs and records delivery proof', async () => {
  const context = trustedContext();
  const calls = [];
  const feature = createConversationMediaFeature({
    api: api(),
    bridge: {
      async analyze(input) {
        calls.push(input);
        return {
          status: 'contributed',
          contribution: {
            feature: 'conversation-media.v1',
            content: '[Image analysis]\nA red square.',
            sourceRefs: [sourceRef(input.messageId)],
          },
        };
      },
    },
  });

  const result = await feature.beforeContext(context, mediaInput());
  assert.equal(result.availability, 'ready');
  assert.equal(result.contributions.length, 1);
  assert.equal(calls[0].artifact.artifactId, 'a'.repeat(64));
  assert.equal(calls[0].operation, 'describe_image');
  assert.equal(calls[0].messageId, 'work-message-1');
  assert.equal(hasConversationContextProofV1(context, 'conversation-media.v1', [sourceRef()]), true);
  const delivery = await feature.beforeDelivery(context, {
    text: 'An answer using the image description.',
    sourceRefs: [sourceRef()],
    assistantEventId: 'assistant-event-1',
  });
  assert.equal(delivery.decision, 'allow');

  let sourceAllowed = true;
  const revocationContext = trustedContext();
  const revocationFeature = createConversationMediaFeature({
    api: {
      apiVersion: 1,
      async authorizeSources(turn) {
        return {
          allowed: sourceAllowed,
          currentAuthorizationEpoch: turn.authorizationEpoch,
          deniedSourceIds: sourceAllowed ? [] : ['work-message-1'],
        };
      },
    },
    bridge: {
      async analyze(input) {
        return {
          status: 'contributed',
          contribution: {
            feature: 'conversation-media.v1',
            content: 'Authorized image description.',
            sourceRefs: [sourceRef(input.messageId)],
          },
        };
      },
    },
  });
  await revocationFeature.beforeContext(revocationContext, mediaInput());
  sourceAllowed = false;
  const held = await revocationFeature.beforeDelivery(revocationContext, {
    text: 'An answer using the image description.',
    sourceRefs: [sourceRef()],
  });
  assert.equal(held.decision, 'hold');
  assert.equal(held.code, 'SOURCE_AUTHORIZATION_REVOKED');
});

test('cancelled DSH turn discards a late provider result before contribution', async () => {
  const controller = new AbortController();
  const context = trustedContext(controller.signal);
  let resolveAnalysis;
  const feature = createConversationMediaFeature({
    api: api(),
    bridge: {
      analyze: () => new Promise(resolve => { resolveAnalysis = resolve; }),
    },
  });
  const pending = feature.beforeContext(context, mediaInput());
  controller.abort();
  resolveAnalysis({
    status: 'contributed',
    contribution: {
      feature: 'conversation-media.v1',
      content: '[Image analysis]\nLate text must not enter context.',
      sourceRefs: [sourceRef()],
    },
  });
  await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError');
});

test('HTTP bridge sends only opaque IDs and a task-bound context request', async () => {
  const image = attachment();
  let received;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received = {
        authorization: request.headers.authorization,
        taskId: request.headers['x-cyrene-work-task-id'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        status: 'contributed',
        contribution: {
          feature: 'conversation-media.v1',
          content: '[Image analysis]\nA green circle.',
          sourceRefs: [sourceRef()],
        },
      }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const previousToken = process.env.CYRENE_MEDIA_TEST_TOKEN;
  process.env.CYRENE_MEDIA_TEST_TOKEN = 'test-only-token';
  try {
    const bridge = new NavigatorConversationMediaHttpBridge({
      baseUrl: `http://127.0.0.1:${address.port}`,
      workspaceId: scope.workspaceId,
      tokenEnv: 'CYRENE_MEDIA_TEST_TOKEN',
    });
    const result = await bridge.analyze({
      messageId: 'work-message-1',
      artifact: image,
      operation: 'describe_image',
      prompt: 'What is shown?',
    }, trustedContext());
    assert.equal(result.status, 'contributed');
    assert.equal(received.authorization, 'Bearer test-only-token');
    assert.match(received.taskId, /^media-task-/u);
    assert.deepEqual(Object.keys(received.body).sort(), [
      'artifactId', 'messageId', 'operation', 'prompt',
    ]);
    assert.equal(received.body.artifactId, image.artifactId);
    assert.equal(received.body.data, undefined);
    assert.equal(received.body.path, undefined);
  } finally {
    if (previousToken === undefined) delete process.env.CYRENE_MEDIA_TEST_TOKEN;
    else process.env.CYRENE_MEDIA_TEST_TOKEN = previousToken;
    server.close();
    await once(server, 'close');
  }
});

test('HTTP bridge aborts with the DSH signal and returns a typed cancellation', async () => {
  let requestReceived;
  const server = createServer((request, response) => {
    requestReceived = true;
    request.on('close', () => response.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const previousToken = process.env.CYRENE_MEDIA_TEST_TOKEN;
  process.env.CYRENE_MEDIA_TEST_TOKEN = 'test-only-token';
  const controller = new AbortController();
  try {
    const bridge = new NavigatorConversationMediaHttpBridge({
      baseUrl: `http://127.0.0.1:${address.port}`,
      workspaceId: scope.workspaceId,
      tokenEnv: 'CYRENE_MEDIA_TEST_TOKEN',
      requestTimeoutMs: 5_000,
    });
    const pending = bridge.analyze({
      messageId: 'work-message-1',
      artifact: attachment(),
      operation: 'describe_image',
    }, trustedContext(controller.signal));
    while (requestReceived !== true) await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort();
    await assert.rejects(pending, error => (
      error instanceof ConversationMediaBridgeError && error.code === 'MEDIA_OPERATION_CANCELLED'
    ));
  } finally {
    if (previousToken === undefined) delete process.env.CYRENE_MEDIA_TEST_TOKEN;
    else process.env.CYRENE_MEDIA_TEST_TOKEN = previousToken;
    server.close();
    await once(server, 'close');
  }
});
