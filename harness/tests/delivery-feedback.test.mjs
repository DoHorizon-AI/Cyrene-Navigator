// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 delivery-feedback.test.mjs                                      │
// │  Module: Navigator browser adapter acceptance                        │
// │  Role: Check request correlation, retained input and Loader loading.  │
// │                                                                     │
// │  模块职责：验证 requestId/终态关联和输入保留，不代替真实 Windows 验收。 │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const script = readFileSync(fileURLToPath(new URL('../dist/client.js', import.meta.url)), 'utf8');
let exported;
runInNewContext(script, {
  window: { __ModuleLoader__: { load({ id, factory }) {
    assert.equal(id, '@cyrene/navigator-harness');
    exported = factory(name => {
      assert.equal(name, 'react', 'the browser adapter must use only the shared React runtime');
      return {};
    });
  } } },
});
assert.equal(typeof exported?.DeliveryTracker, 'function');

class Source {
  listeners = new Set();
  constructor(value) { this.value = value; }
  getSnapshot = () => this.value;
  subscribe = listener => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(value) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}

function fixture(implementation = exported, sessionId) {
  const state = new Source({ pendingSubmissions: [], promptError: null, lastAgentError: null });
  const events = new Source({ entries: [], revision: 0, hasMore: false });
  const connection = new Source('connected');
  const tracker = new implementation.DeliveryTracker(state, events, connection, sessionId);
  const release = tracker.subscribe(() => {});
  const input = (id, text = id) => ({
    requestId: id, text, placement: 'transcript', attachments: [], time: 0,
  });
  const set = patch => state.set({ ...state.getSnapshot(), ...patch });
  const append = (...items) => {
    const current = events.getSnapshot();
    const entries = items.map(([type, data], index) => ({
      type: 'event', event: { seq: current.entries.length + index, type, data, time: 0 },
    }));
    events.set({ ...current, entries: [...current.entries, ...entries], revision: current.revision + 1 });
  };
  const view = () => JSON.parse(JSON.stringify(tracker.getSnapshot()));
  return { tracker, state, events, connection, input, set, append, view, release };
}

const message = id => ({ source: { kind: 'user', rpcId: id }, content: [] });
const start = turn => ['turn/start', { turn }];
const end = (turn, kind = 'completed', error) => ['turn/end', { turn, reason: { kind, error } }];
const user = id => ['user/message', message(id)];
const inbox = (inserted, removedCount = 0, extra = {}) => [
  'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted, removedCount, ...extra },
];

test('the browser Loader registers only the public Session feedback slot', () => {
  let registered;
  const session = new Source({});
  const events = new Source({});
  const connection = new Source('connected');
  const ctx = {
    slots: {
      inject(name, factory) { assert.equal(name, 'conversation.input.dock'); factory(); },
      register(options) { registered = options; },
    },
    sessions: { binding(id) { assert.equal(id, 'selected'); return { session, eventSource: events }; } },
    connection: { state: connection },
  };
  exported.apply(ctx);
  const injected = registered.inject('selected');
  assert.equal(injected.sessionSnapshot, session);
  assert.equal(injected.events, events);
  assert.equal(injected.connection, connection);
});

test('short-lived pending echo retains its input on a correlated admission failure', () => {
  const f = fixture();
  f.set({ pendingSubmissions: [f.input('rpc-a', 'important draft')] });
  // Both source updates can precede React's next committed render.
  f.set({ pendingSubmissions: [], promptError: { op: 'send', error: { code: 'SESSION_OWNERSHIP_LOST' } } });
  assert.deepEqual(f.view(), {
    retained: [{ requestId: 'rpc-a', text: 'important draft', kind: 'ownership' }], generic: null,
  });
  f.release();
  assert.equal(f.state.listeners.size + f.events.listeners.size + f.connection.listeners.size, 0);
});

test('a completed input is forgotten even while its pending echo is still present', () => {
  const f = fixture();
  f.set({ pendingSubmissions: [f.input('rpc-a')] });
  f.append(start(1), user('rpc-a'), end(1));
  f.connection.set('disconnected');
  assert.deepEqual(f.view(), { retained: [], generic: null });
  f.set({ pendingSubmissions: [] });
  f.connection.set('connected');
  f.connection.set('disconnected');
  assert.deepEqual(f.view(), { retained: [], generic: null });
  f.release();
});

test('queue echo retirement and an unrelated completed turn cannot settle the queued input', () => {
  const f = fixture();
  f.set({ pendingSubmissions: [f.input('rpc-queued')] });
  f.append(inbox([message('rpc-queued')]));
  f.set({ pendingSubmissions: [] });
  f.append(start(1), user('someone-else'), end(1));
  f.connection.set('disconnected');
  assert.equal(f.view().retained[0].requestId, 'rpc-queued');
  f.connection.set('connected');
  f.append(start(2), inbox([], 1), user('rpc-queued'), end(2));
  assert.deepEqual(f.view(), { retained: [], generic: null });
  f.release();
});

test('a failed consumed inbox turn retains input even before any user/message is written', () => {
  const f = fixture();
  f.set({ pendingSubmissions: [f.input('rpc-offline', 'offline input')] });
  f.append(inbox([message('rpc-offline')]), start(8), inbox([], 1),
    end(8, 'error', { code: 'UNKNOWN', message: 'fetch failed: read ECONNRESET' }));
  f.set({ pendingSubmissions: [] });
  assert.deepEqual(f.view(), {
    retained: [{ requestId: 'rpc-offline', text: 'offline input', kind: 'transport' }], generic: null,
  });
  // Restoring a connection never invokes a Session verb or clears the copy.
  f.connection.set('disconnected');
  f.connection.set('connected');
  assert.equal(f.view().retained[0].text, 'offline input');
  f.release();
});

test('an explicit retry gets a new identity and its completion does not resurrect the failed copy', () => {
  const f = fixture();
  f.set({ pendingSubmissions: [f.input('rpc-old', 'retry me')] });
  f.set({ pendingSubmissions: [], promptError: { op: 'send', error: { code: 'NETWORK_FAILURE' } } });
  assert.equal(f.view().retained.length, 1);
  f.set({ promptError: null, pendingSubmissions: [f.input('rpc-new', 'retry me')] });
  f.append(start(1), user('rpc-new'), end(1));
  f.set({ pendingSubmissions: [] });
  f.connection.set('disconnected');
  assert.deepEqual(f.view(), { retained: [], generic: null });
  f.release();
});

test('two pending attempts are independently associated with their own turns', () => {
  const f = fixture();
  f.set({ pendingSubmissions: [f.input('rpc-first'), f.input('rpc-second')] });
  f.append(start(1), user('rpc-first'), end(1));
  f.set({ pendingSubmissions: [] });
  f.connection.set('disconnected');
  assert.deepEqual(f.view().retained.map(item => item.requestId), ['rpc-second']);
  f.connection.set('connected');
  f.append(start(2), user('rpc-second'), end(2, 'error', { code: 'UNKNOWN' }));
  assert.deepEqual(f.view().retained.map(item => item.requestId), ['rpc-second']);
  f.release();
});

test('an old sticky error has no input to restore and cannot retain a subsequent successful attempt', () => {
  const f = fixture();
  f.set({ lastAgentError: 'unrelated historical failure' });
  assert.deepEqual(f.view(), { retained: [], generic: 'unknown' });
  f.set({ pendingSubmissions: [f.input('rpc-success')] });
  f.append(start(1), user('rpc-success'), end(1));
  f.set({ pendingSubmissions: [] });
  f.connection.set('disconnected');
  assert.deepEqual(f.view(), { retained: [], generic: null });
  f.release();
});

test('explicitly canceled queue input is settled without being associated with another turn', () => {
  const f = fixture();
  f.set({ pendingSubmissions: [f.input('rpc-canceled')] });
  f.append(inbox([message('rpc-canceled')]));
  f.set({ pendingSubmissions: [] });
  f.append(inbox([], 1, { outcome: 'canceled' }), start(1),
    end(1, 'error', { code: 'UNKNOWN' }));
  f.connection.set('disconnected');
  assert.deepEqual(f.view(), { retained: [], generic: null });
  f.release();
});

test('repeated same-code failures retain distinct attempt identities and permit explicit dismissal', () => {
  const f = fixture();
  for (const id of ['rpc-a', 'rpc-b']) {
    f.set({ promptError: null, pendingSubmissions: [f.input(id)] });
    f.set({ pendingSubmissions: [], promptError: { op: 'send', error: { code: 'SESSION_OWNERSHIP_LOST' } } });
  }
  assert.deepEqual(f.view().retained.map(item => item.requestId), ['rpc-a', 'rpc-b']);
  f.tracker.dismiss('rpc-a');
  assert.deepEqual(f.view().retained.map(item => item.requestId), ['rpc-b']);
  f.tracker.dismiss('rpc-b');
  assert.deepEqual(f.view(), { retained: [], generic: null });
  f.release();
});

function desktopClient(native) {
  let face;
  runInNewContext(script, {
    window: {
      __cyreneNavigatorRetainedInputs: native,
      __ModuleLoader__: { load({ factory }) { face = factory(() => ({})); } },
    },
  });
  return face;
}

function localInputs() {
  const records = new Map();
  const operations = [];
  const key = (sessionId, requestId) => `${sessionId}\0${requestId}`;
  const native = {
    async completed(sessionId, requestIds) {
      operations.push(['completed', sessionId, [...requestIds]]);
      return [...requestIds];
    },
    async list(sessionId) {
      operations.push(['list', sessionId]);
      return [...records.entries()].filter(([id]) => id.startsWith(`${sessionId}\0`))
        .map(([, value]) => ({ ...value }));
    },
    async put(sessionId, requestId, text) {
      operations.push(['put', sessionId, requestId]);
      const prior = records.get(key(sessionId, requestId));
      if (prior && prior.text !== text) throw new Error('immutable input conflict');
      records.set(key(sessionId, requestId), { requestId, text });
    },
    async remove(sessionId, requestId) {
      operations.push(['remove', sessionId, requestId]);
      records.delete(key(sessionId, requestId));
    },
  };
  return { records, operations, native };
}

async function recovery(f, state = 'saved') {
  const deadline = Date.now() + 2000;
  while (f.view().localRecovery !== state) {
    if (Date.now() >= deadline) assert.fail(`Local recovery did not reach ${state}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

test('a new browser origin recovers failed local input without sending it or rewriting history', async () => {
  const local = localInputs();
  const first = fixture(desktopClient(local.native), 'session-a');
  await recovery(first);
  first.set({ pendingSubmissions: [first.input('failed-rpc', 'preserve this input')] });
  first.set({ pendingSubmissions: [], promptError: { op: 'send', error: 'ECONNRESET' } });
  await recovery(first);
  assert.equal(local.records.size, 1);
  first.release();

  const reopened = fixture(desktopClient(local.native), 'session-a');
  await recovery(reopened);
  assert.deepEqual(reopened.view().retained, [{ requestId: 'failed-rpc', text: 'preserve this input', kind: 'recovered' }]);
  assert.deepEqual(reopened.state.getSnapshot().pendingSubmissions, []);
  assert.deepEqual(reopened.events.getSnapshot().entries, []);
  reopened.tracker.dismiss('failed-rpc');
  await recovery(reopened);
  assert.equal(local.records.size, 0);
  reopened.release();
});

test('durable terminal history removes an old recovery copy after restart without replay', async () => {
  const local = localInputs();
  await local.native.put('session-a', 'completed-rpc', 'already completed');
  const f = fixture(desktopClient(local.native), 'session-a');
  f.append(start(7), user('completed-rpc'), end(7));
  const eventsBefore = structuredClone(f.events.getSnapshot());
  await recovery(f);
  assert.deepEqual(f.view().retained, []);
  assert.equal(local.records.size, 0);
  assert.deepEqual(f.events.getSnapshot(), eventsBefore);
  assert.deepEqual(f.state.getSnapshot().pendingSubmissions, []);
  f.release();
});

test('an explicit retry keeps the old disk copy until its new request is durably retained', async () => {
  const local = localInputs();
  const f = fixture(desktopClient(local.native), 'session-a');
  await recovery(f);
  f.set({ pendingSubmissions: [f.input('old-rpc', 'retry text')] });
  f.set({ pendingSubmissions: [], promptError: { op: 'send', error: 'ECONNRESET' } });
  await recovery(f);
  const originalPut = local.native.put;
  let releasePut;
  const held = new Promise(resolve => { releasePut = resolve; });
  local.native.put = async (...args) => {
    if (args[1] === 'new-rpc') await held;
    return originalPut(...args);
  };
  f.set({ promptError: null, pendingSubmissions: [f.input('new-rpc', 'retry text')] });
  await new Promise(resolve => setImmediate(resolve));
  assert(local.records.has('session-a\0old-rpc'));
  releasePut();
  await recovery(f);
  assert.deepEqual([...local.records.keys()], ['session-a\0new-rpc']);
  f.append(start(1), user('new-rpc'), end(1));
  f.set({ pendingSubmissions: [] });
  await recovery(f);
  assert.equal(local.records.size, 0);
  f.release();
});

test('local storage failure preserves visible input and retries storage only on an explicit action', async () => {
  const local = localInputs();
  const originalPut = local.native.put;
  let calls = 0;
  local.native.put = async () => { calls += 1; throw new Error('disk unavailable'); };
  const f = fixture(desktopClient(local.native), 'session-a');
  await recovery(f);
  f.set({ pendingSubmissions: [f.input('failed-rpc', 'keep locally')] });
  f.set({ pendingSubmissions: [], promptError: { op: 'send', error: 'ECONNRESET' } });
  await recovery(f, 'failed');
  f.connection.set('disconnected');
  f.connection.set('connected');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(f.view().retained[0].text, 'keep locally');
  local.native.put = originalPut;
  const before = structuredClone(f.state.getSnapshot());
  f.tracker.retrySaving();
  await recovery(f);
  assert.equal(local.records.size, 1);
  assert.deepEqual(f.state.getSnapshot(), before);
  f.release();
});

test('a failed explicit dismissal stays visible until removal is explicitly retried', async () => {
  const local = localInputs();
  const f = fixture(desktopClient(local.native), 'session-a');
  await recovery(f);
  f.set({ pendingSubmissions: [f.input('dismiss-rpc', 'keep until delete')] });
  f.set({ pendingSubmissions: [], promptError: { op: 'send', error: 'ECONNRESET' } });
  await recovery(f);
  assert.equal(local.records.size, 1);

  const originalRemove = local.native.remove;
  local.native.remove = async () => { throw new Error('disk unavailable'); };
  f.tracker.dismiss('dismiss-rpc');
  await recovery(f, 'failed');
  assert.deepEqual(f.view().retained, [
    { requestId: 'dismiss-rpc', text: 'keep until delete', kind: 'transport' },
  ]);

  local.native.remove = originalRemove;
  f.tracker.retrySaving();
  await recovery(f);
  assert.equal(local.records.size, 0);
  assert.deepEqual(f.view().retained, []);
  f.release();
});

test('an acknowledged local write with a lost response is removed by explicit dismissal', async () => {
  const local = localInputs();
  const originalPut = local.native.put;
  local.native.put = async (...args) => {
    await originalPut(...args);
    throw new Error('local response lost after publication');
  };
  const f = fixture(desktopClient(local.native), 'session-a');
  await recovery(f);
  f.set({ pendingSubmissions: [f.input('ambiguous-rpc', 'remove after ambiguous write')] });
  f.set({ pendingSubmissions: [], promptError: { op: 'send', error: 'ECONNRESET' } });
  await recovery(f, 'failed');
  assert.equal(local.records.size, 1);

  f.tracker.dismiss('ambiguous-rpc');
  f.tracker.retrySaving();
  await recovery(f);
  assert.equal(local.operations.filter(row => row[0] === 'remove' && row[2] === 'ambiguous-rpc').length, 1);
  assert.equal(local.records.size, 0);
  f.release();

  const reopened = fixture(desktopClient(local.native), 'session-a');
  await recovery(reopened);
  assert.deepEqual(reopened.view().retained, []);
  reopened.release();
});

test('a failed local save survives queue cancellation and terminal events until explicit retry', async () => {
  const cases = [
    ['queue cancellation', [inbox([message('terminal-rpc')]), inbox([], 1, { outcome: 'canceled' })]],
    ['aborted turn', [start(1), user('terminal-rpc'), end(1, 'aborted')]],
    ['failed turn', [start(1), user('terminal-rpc'), end(1, 'error', { code: 'UNKNOWN' })]],
    ['completed turn', [start(1), user('terminal-rpc'), end(1, 'completed')]],
  ];
  for (const [label, observed] of cases) {
    const local = localInputs();
    local.native.completed = async () => [];
    const originalPut = local.native.put;
    local.native.put = async () => { throw new Error('disk unavailable'); };
    const f = fixture(desktopClient(local.native), 'session-a');
    await recovery(f);
    f.set({ pendingSubmissions: [f.input('terminal-rpc', `${label} input`)] });
    await recovery(f, 'failed');
    f.set({ pendingSubmissions: [] });
    f.append(...observed);
    assert.equal(f.view().retained[0]?.requestId, 'terminal-rpc', label);
    assert.equal(local.records.size, 0, label);

    local.native.put = originalPut;
    f.tracker.retrySaving();
    await recovery(f);
    assert.equal(local.records.size, 1, label);
    assert.equal(f.view().retained[0]?.text, `${label} input`, label);
    f.release();
  }
});

test('an explicit dismissal cannot be undone by a delayed local recovery read', async () => {
  const local = localInputs();
  await local.native.put('session-a', 'rpc-a', 'late input');
  const rows = await local.native.list('session-a');
  let releaseRead;
  local.native.list = () => new Promise(resolve => { releaseRead = () => resolve(rows); });
  const f = fixture(desktopClient(local.native), 'session-a');
  f.set({ pendingSubmissions: [f.input('rpc-a', 'late input')] });
  f.set({ pendingSubmissions: [], promptError: { op: 'send', error: 'ECONNRESET' } });
  f.tracker.dismiss('rpc-a');
  await new Promise(resolve => setImmediate(resolve));
  releaseRead();
  await recovery(f);
  assert.deepEqual(f.view().retained, []);
  assert.equal(local.records.size, 0);
  f.release();
});

test('a malformed local record fails closed and does not modify the Session', async () => {
  const local = localInputs();
  local.native.list = async () => [{ requestId: 'rpc-a', text: { message: 'not plain text' } }];
  const f = fixture(desktopClient(local.native), 'session-a');
  await recovery(f, 'failed');
  assert.deepEqual(f.view().retained, []);
  assert.deepEqual(f.events.getSnapshot().entries, []);
  assert.deepEqual(local.operations, []);
  f.release();
});

test('a delayed local read cannot revive the earlier copy of an explicit retry', async () => {
  const local = localInputs();
  local.native.completed = async () => [];
  await local.native.put('session-a', 'old-rpc', 'explicit retry text');
  const rows = await local.native.list('session-a');
  let releaseRead;
  local.native.list = () => new Promise(resolve => { releaseRead = () => resolve(rows); });
  const f = fixture(desktopClient(local.native), 'session-a');
  f.set({ pendingSubmissions: [f.input('new-rpc', 'explicit retry text')] });
  await new Promise(resolve => setImmediate(resolve));
  releaseRead();
  await recovery(f);
  assert.deepEqual([...local.records.keys()], ['session-a\0new-rpc']);
  assert.deepEqual(f.view().retained, []);
  assert(local.operations.findIndex(row => row[0] === 'put' && row[2] === 'new-rpc')
    < local.operations.findIndex(row => row[0] === 'remove' && row[2] === 'old-rpc'));
  assert.deepEqual(f.events.getSnapshot().entries, []);
  f.release();
});

test('a live completion cannot delete local text before the backend confirms its durable receipt', async () => {
  const local = localInputs();
  local.native.completed = async () => [];
  const f = fixture(desktopClient(local.native), 'session-a');
  await recovery(f);
  f.set({ pendingSubmissions: [f.input('unflushed-rpc', 'keep until durable')] });
  await recovery(f);
  f.append(start(3), user('unflushed-rpc'), end(3));
  f.set({ pendingSubmissions: [] });
  await recovery(f);
  assert.equal(local.records.size, 1);
  assert.equal(f.view().retained[0].text, 'keep until durable');
  assert.equal(f.view().unconfirmed, true);
  const eventsBefore = structuredClone(f.events.getSnapshot());
  local.native.completed = async (_sessionId, ids) => ids;
  f.tracker.checkDelivery();
  await recovery(f);
  assert.equal(local.records.size, 0);
  assert.deepEqual(f.view().retained, []);
  assert.deepEqual(f.events.getSnapshot(), eventsBefore);
  f.release();
});

test('a canceled turn remains recoverable when the backend has no completed receipt', async () => {
  const local = localInputs();
  local.native.completed = async () => [];
  const f = fixture(desktopClient(local.native), 'session-a');
  await recovery(f);
  f.set({ pendingSubmissions: [f.input('canceled-rpc')] });
  await recovery(f);
  f.append(start(4), user('canceled-rpc'), end(4, 'aborted'));
  f.set({ pendingSubmissions: [] });
  await recovery(f);
  assert.equal(local.records.size, 1);
  assert.equal(f.view().retained[0].requestId, 'canceled-rpc');
  f.tracker.dismiss('canceled-rpc');
  await recovery(f);
  assert.equal(local.records.size, 0);
  f.release();
});

test('a receipt outage preserves confirmed local saves and requires an explicit delivery check', async () => {
  const local = localInputs();
  let receiptCalls = 0;
  local.native.completed = async () => { receiptCalls += 1; throw new Error('persistence unavailable'); };
  const f = fixture(desktopClient(local.native), 'session-a');
  await recovery(f);
  f.set({ pendingSubmissions: [f.input('offline-rpc', 'saved while offline')] });
  await recovery(f);
  f.append(start(5), user('offline-rpc'), end(5));
  f.set({ pendingSubmissions: [] });
  await recovery(f);
  assert.equal(local.records.size, 1);
  assert.equal(f.view().localRecovery, 'saved');
  assert.equal(f.view().unconfirmed, true);
  assert.equal(f.view().retained[0].text, 'saved while offline');
  const callsBeforeReconnect = receiptCalls;
  const eventsBefore = structuredClone(f.events.getSnapshot());
  f.connection.set('disconnected');
  f.connection.set('connected');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(receiptCalls, callsBeforeReconnect);
  assert.deepEqual(f.state.getSnapshot().pendingSubmissions, []);

  local.native.completed = async (_sessionId, requestIds) => requestIds;
  f.tracker.checkDelivery();
  await recovery(f);
  assert.equal(local.records.size, 0);
  assert.deepEqual(f.view().retained, []);
  assert.deepEqual(f.events.getSnapshot(), eventsBefore);
  f.release();
});
