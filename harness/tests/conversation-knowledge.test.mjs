// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator conversation knowledge bridge tests                │
// │ Role: Verify server-fixed package selection and hold-on-revocation.   │
// │ 模块职责：验证知识 bridge 只发查询文本，并在撤权后整体保留。          │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  ConversationKnowledgeBridgeError,
  NavigatorConversationKnowledgeHttpBridge,
  knowledgeContextContribution,
} from '../dist/conversation-knowledge/index.js';

const citation = {
  librarySelector: 'handbook',
  datasetId: '11111111-1111-4111-8111-111111111111',
  datasetVersionId: '22222222-2222-4222-8222-222222222222',
  contentRevisionId: '33333333-3333-4333-8333-333333333333',
  sourceRevisionId: '44444444-4444-4444-8444-444444444444',
  sourceId: '55555555-5555-4555-8555-555555555555',
  blockId: 'block-1',
  blockOrdinal: 0,
  chunkId: `sha256:${'c'.repeat(64)}`,
  locator: { page: 2 },
  hierarchyPath: ['Operations'],
  assetRefs: [],
};
const searchBody = {
  package: {
    librarySelector: 'handbook',
    datasetId: citation.datasetId,
    datasetName: 'Handbook',
    datasetVersionId: citation.datasetVersionId,
    version: 3,
  },
  query: 'restart gateway',
  usePurpose: 'knowledge_retrieval',
  packageDigest: `sha256:${'a'.repeat(64)}`,
  resultDigest: 'd'.repeat(64),
  hits: [{ text: 'Reset the gateway before restarting.', score: 1.5, citation }],
};

function trustedContext(signal = new AbortController().signal) {
  return { workspaceId: 'workspace-a', actorId: 'actor-a', taskId: 'task-1', sessionId: 'session-1', signal };
}

async function withServer(handler, run) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, headers: request.headers, body: JSON.parse(raw) });
      const [status, body] = handler(request.url, requests.length);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.KNOWLEDGE_TEST_TOKEN = 'work-token-for-tests';
  const bridge = new NavigatorConversationKnowledgeHttpBridge({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    workspaceId: 'workspace-a',
    tokenEnv: 'KNOWLEDGE_TEST_TOKEN',
  });
  try {
    await run(bridge, requests);
  } finally {
    server.close();
  }
}

const allowed = {
  allowed: true,
  datasetVersionId: citation.datasetVersionId,
  contentRevisionId: citation.contentRevisionId,
  packageDigest: searchBody.packageDigest,
  resultDigest: searchBody.resultDigest,
  checkedAt: 1_800_000_000_000,
};

test('search sends only query text and decodes a cited page', async () => {
  await withServer(() => [200, searchBody], async (bridge, requests) => {
    const page = await bridge.search({ query: 'restart gateway', limit: 3 }, trustedContext());
    assert.deepEqual(requests[0].body, { query: 'restart gateway', limit: 3 });
    assert.equal(requests[0].headers.authorization, 'Bearer work-token-for-tests');
    assert.equal(requests[0].headers['x-cyrene-work-task-id'], 'task-1');
    assert.equal(page.hits[0].citation.blockOrdinal, 0);
    assert.equal(page.datasetName, 'Handbook');
  });
});

test('authorize rechecks the exact page and context is produced only from an allowed receipt', async () => {
  await withServer(url => [200, url.endsWith('/search') ? searchBody : allowed], async (bridge, requests) => {
    const page = await bridge.search({ query: 'restart gateway', limit: 3 }, trustedContext());
    const receipt = await bridge.authorize(page, trustedContext());
    assert.equal(requests[1].body.resultDigest, searchBody.resultDigest);
    assert.equal(requests[1].body.citations.length, 1);
    const contribution = knowledgeContextContribution(page, receipt);
    assert.match(contribution.content, /Reset the gateway/u);
    assert.equal(contribution.citations[0].blockId, 'block-1');
  });
});

test('a denied receipt holds the whole contribution', async () => {
  await withServer(url => [200, url.endsWith('/search')
    ? searchBody
    : { ...allowed, allowed: false, reasonCode: 'KNOWLEDGE_SOURCE_NOT_AUTHORIZED' }], async bridge => {
    const page = await bridge.search({ query: 'restart gateway', limit: 3 }, trustedContext());
    const receipt = await bridge.authorize(page, trustedContext());
    assert.throws(
      () => knowledgeContextContribution(page, receipt),
      error => error instanceof ConversationKnowledgeBridgeError && error.code === 'KNOWLEDGE_SOURCE_NOT_AUTHORIZED',
    );
  });
});

test('a receipt for a different page and server problem codes are rejected', async () => {
  await withServer(url => url.endsWith('/search')
    ? [200, searchBody]
    : [200, { ...allowed, resultDigest: 'e'.repeat(64) }], async bridge => {
    const page = await bridge.search({ query: 'restart gateway', limit: 3 }, trustedContext());
    await assert.rejects(bridge.authorize(page, trustedContext()), { code: 'KNOWLEDGE_RECEIPT_MISMATCH' });
  });
  await withServer(() => [409, { code: 'KNOWLEDGE_PACKAGE_STALE', retryable: false }], async bridge => {
    await assert.rejects(
      bridge.search({ query: 'restart gateway' }, trustedContext()),
      { code: 'KNOWLEDGE_PACKAGE_STALE', status: 409, retryable: false },
    );
  });
});

test('an aborted turn does not send and invalid queries fail locally', async () => {
  await withServer(() => [200, searchBody], async (bridge, requests) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(bridge.search({ query: 'restart gateway' }, trustedContext(controller.signal)));
    await assert.rejects(bridge.search({ query: '   ' }, trustedContext()), { code: 'KNOWLEDGE_QUERY_INVALID' });
    assert.equal(requests.length, 0);
  });
});
