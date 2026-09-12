// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Session title route contract tests                │
// │ Role: Check authorization, bounded reads, cancellation, and errors. │
// │ 模块职责：验证标题路由的授权、限制、取消和错误边界。                    │
// └─────────────────────────────────────────────────────────────────────┘
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionTitlesRequest } from '../dist/session-titles.js';

function responseRequest(body, signal) {
  return new Request('http://navigator.test/api/cyrene/session/titles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

function queryFixture({ records = ['visible'], results, onRead } = {}) {
  const visibleRecords = records.map(id => ({
    header: { id, cwd: '/workspace' },
    live: false,
    persisted: true,
  }));
  return {
    async listSessions(signal) {
      return visibleRecords.map(record => {
        onRead?.('list', signal);
        return record;
      });
    },
    async readTitleSnapshots(ids, signal) {
      onRead?.('titles', signal);
      if (results !== undefined) return results(ids, signal);
      return ids.map(sessionId => ({
        sessionId,
        status: 'fulfilled',
        value: {
          session: { id: sessionId, cwd: '/workspace' },
          title: { title: 'Cold title', eventSeq: 3, updatedAt: 1730000000000 },
        },
      }));
    },
  };
}

async function readResponse(response) {
  return { status: response.status, body: await response.json() };
}

test('cold title route forwards one signal and returns durable projection fields', async () => {
  const seen = [];
  const query = queryFixture({ onRead: (operation, signal) => seen.push({ operation, signal }) });
  const request = responseRequest({ sessionIds: ['visible', 'visible'] });
  const result = await readResponse(await sessionTitlesRequest(query, request));

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    items: [{ sessionId: 'visible', title: 'Cold title', seq: 3, updatedAt: 1730000000000 }],
    errors: [],
  });
  assert.deepEqual(seen.map(item => item.operation), ['list', 'titles']);
  assert.equal(seen[0].signal, request.signal);
  assert.equal(seen[1].signal, request.signal);
});

test('cold title route isolates a per-session query failure without exposing its reason', async () => {
  const query = queryFixture({
    records: ['visible', 'also-visible'],
    results: ids => ids.map(sessionId => sessionId === 'visible'
      ? {
        sessionId,
        status: 'rejected',
        reason: new Error('Bearer secret-token-must-not-cross-boundary'),
      }
      : {
        sessionId,
        status: 'fulfilled',
        value: { session: { id: sessionId, cwd: '/workspace' } },
      }),
  });
  const result = await readResponse(await sessionTitlesRequest(
    query,
    responseRequest({ sessionIds: ['visible', 'also-visible'] }),
  ));

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.items, [{ sessionId: 'also-visible' }]);
  assert.deepEqual(result.body.errors, [{
    sessionId: 'visible',
    code: 'SESSION_TITLE_READ_FAILED',
    detail: 'The Session title could not be read.',
  }]);
  assert.equal(JSON.stringify(result.body).includes('secret-token'), false);
});

test('cold title route rejects an invisible Session before reading its log', async () => {
  let readCalled = false;
  const query = queryFixture({
    onRead: operation => { if (operation === 'titles') readCalled = true; },
  });
  const result = await readResponse(await sessionTitlesRequest(
    query,
    responseRequest({ sessionIds: ['outside-workspace'] }),
  ));

  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'SESSION_NOT_VISIBLE');
  assert.equal(JSON.stringify(result.body).includes('outside-workspace'), false);
  assert.equal(readCalled, false);
});

test('cold title route bounds malformed requests before querying', async () => {
  let queried = false;
  const query = queryFixture({ onRead: () => { queried = true; } });
  const result = await readResponse(await sessionTitlesRequest(
    query,
    new Request('http://navigator.test/api/cyrene/session/titles', {
      method: 'POST',
      body: JSON.stringify({ sessionIds: [] }),
    }),
  ));

  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'INVALID_SESSION_IDS');
  assert.equal(queried, false);
});

test('cold title route propagates caller cancellation instead of returning a partial projection', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    sessionTitlesRequest(queryFixture(), responseRequest({ sessionIds: ['visible'] }, controller.signal)),
    error => error?.name === 'AbortError',
  );
});
