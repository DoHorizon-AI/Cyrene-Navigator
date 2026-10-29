// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Planner office observation adapter tests                    │
// │ Role: Verify actor-bound plans, bounded pages and semantic events.   │
// │                                                                      │
// │ 模块职责：验证按 actor 绑定计划、有界分页与语义状态事件。             │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { decodeAutomationSourceBindings } from '../dist/workflows/source-config.js';
import { createOfficeObservationSource } from '../dist/workflows/office-observation.js';
import { validateWorkflowAutomationEvent } from '../dist/workflows/store.js';

const ownerActorId = 'synthetic-owner-actor';
const viewerActorId = 'synthetic-viewer-actor';
const lookupTargetId = 'office-source-owner';
const bindingId = '22222222-2222-4222-8222-222222222222';
const tenantId = '11111111-1111-4111-8111-111111111111';
const providerPlanId = 'Plan_Selected-owner_7';
const start = '2026-10-27T12:00:00.000Z';
const end = '2026-10-27T12:10:00.000Z';

function plannerBindings(rows = []) {
  return decodeAutomationSourceBindings({
    schemaVersion: 1,
    targets: [
      {
        actorId: ownerActorId,
        targetId: lookupTargetId,
        kind: 'planner_plan',
        bindingId,
        connectionRef: 'exchange:graph:owner',
        profileRef: 'graph-profile-owner',
        tenantId,
        planId: providerPlanId,
      },
      ...rows,
    ],
  });
}

function task(overrides = {}) {
  return {
    task_id: 'task_A-1',
    plan_id: providerPlanId,
    bucket_id: 'bucket_1',
    title: 'Review the deployment handoff',
    percent_complete: 20,
    priority: 5,
    due_date_time: '2026-10-27T12:30:00.000Z',
    start_date_time: null,
    created_date_time: '2026-10-26T11:00:00.000Z',
    last_modified_date_time: '2026-10-27T12:01:00.000Z',
    etag: 'etag-task-1',
    ...overrides,
  };
}

function providerPage(tasks, { pageCursor = null, nextCursor = null, complete = true } = {}) {
  return {
    tasks,
    page_cursor: pageCursor,
    next_cursor: nextCursor,
    complete,
    truncated: false,
  };
}

function request(overrides = {}) {
  return {
    source: 'office_graph',
    ownerActorId,
    target: { id: lookupTargetId, kind: 'planner_plan', bindingId },
    pageSize: 2,
    pageCursor: null,
    windowStart: null,
    windowEnd: end,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function createSource({ rows, authorize = 'allowed', now = () => Date.parse(end) } = {}) {
  const authorizationCalls = [];
  const source = createOfficeObservationSource({
    sourceBindings: plannerBindings(rows),
    authorization: {
      async authorizeRead(actorId, target, binding, signal) {
        authorizationCalls.push({ actorId, target, binding, aborted: signal.aborted });
        return authorize;
      },
    },
    now,
  });
  return { source, authorizationCalls };
}

function fixedToolContext(results, calls = []) {
  const remaining = [...results];
  return {
    calls,
    async invokeConnectorTool(invocation) {
      calls.push(invocation);
      if (invocation.toolId === 'microsoft_graph.planner.plan.get') {
        return { structuredContent: { id: invocation.arguments.plan_id } };
      }
      const result = remaining.shift();
      if (typeof result === 'function') return result(invocation);
      if (result instanceof Error) throw result;
      return { structuredContent: result };
    },
  };
}

function byTaskId(page, id = 'task_A-1') {
  return page.observations.find(item => item.resourceUri.endsWith(`/tasks/${id}`));
}

test('reads only the host-selected plan through the fixed registered provider tool and resumes all pages', async () => {
  const { source, authorizationCalls } = createSource();
  const calls = [];
  const context = fixedToolContext([
    providerPage([task()], { nextCursor: 'provider-page-two', complete: false }),
    providerPage([task({ task_id: 'task_B-2', title: 'Prepare the handoff' })], {
      pageCursor: 'provider-page-two',
      complete: true,
    }),
  ], calls);

  const first = await source.pollPage(request(), context);
  assert.equal(first.source, 'office_graph');
  assert.equal(first.pageCursor, null);
  assert.equal(first.complete, false);
  assert.equal(first.truncated, false);
  assert.match(first.nextCursor, /^office-v1\./u);
  assert.notEqual(first.nextCursor, 'provider-page-two');
  assert.equal(first.observations.length, 1);

  const second = await source.pollPage(request({ pageCursor: first.nextCursor }), context);
  assert.equal(second.pageCursor, first.nextCursor);
  assert.equal(second.nextCursor, null);
  assert.equal(second.complete, true);
  assert.equal(second.observations.length, 1);
  assert.equal(calls.length, 4);
  assert.equal(authorizationCalls.length, 2, 'current plan authorization is checked for each page');
  assert.ok(calls.every(call => call.providerId === 'microsoft_graph'));
  assert.deepEqual(calls.map(call => call.toolId), [
    'microsoft_graph.planner.plan.get', 'microsoft_graph.planner.tasks.list',
    'microsoft_graph.planner.plan.get', 'microsoft_graph.planner.tasks.list',
  ]);
  const listCalls = calls.filter(call => call.toolId === 'microsoft_graph.planner.tasks.list');
  assert.ok(listCalls.every(call => call.operationId === 'microsoft_graph.planner.tasks.list'));
  assert.ok(calls.every(call => call.resourceProjection === 'microsoft_graph_plan'));
  assert.ok(calls.every(call => call.bindingId === bindingId));
  assert.ok(calls.every(call => call.arguments.plan_id === providerPlanId));
  assert.notEqual(listCalls[0].arguments.plan_id, lookupTargetId);
  assert.equal(listCalls[0].arguments.page_size, 2);
  assert.equal(listCalls[1].arguments.page_cursor, 'provider-page-two');
  assert.equal(authorizationCalls[0].actorId, ownerActorId);
  assert.equal(authorizationCalls[1].actorId, ownerActorId);
  assert.equal(authorizationCalls[0].binding.planId, providerPlanId);
  assert.equal('actorId' in listCalls[0].arguments, false);
  assert.equal('profile_ref' in listCalls[0].arguments, false);
  assert.equal('access_token' in listCalls[0].arguments, false);
  assert.equal('body' in listCalls[0].arguments, false);

  const item = byTaskId(first);
  assert.ok(item);
  validateWorkflowAutomationEvent(item);
  assert.equal(item.sourceVersion, 'etag-task-1');
  assert.equal(item.eventType, 'office_graph.planner.task.snapshot');
  assert.match(item.resourceUri, /^https:\/\/graph\.microsoft\.com\/v1\.0\/planner\/tasks\//u);
  assert.match(item.semanticFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify([first, second]).includes('assignments'), false);
  assert.equal(JSON.stringify([first, second]).includes('description'), false);
  assert.equal(JSON.stringify([first, second]).includes('attachments'), false);
});

test('a request target id is only an owner-scoped lookup key and cannot choose a Graph plan', async () => {
  const { source } = createSource();
  const context = fixedToolContext([providerPage([task()])]);

  const page = await source.pollPage(request({ target: { id: providerPlanId, kind: 'planner_plan', bindingId } }), context);

  assert.equal(page.error?.code, 'not_configured');
  assert.equal(context.calls.length, 0);
});

test('a different owner cannot reuse another actor plan binding', async () => {
  const { source } = createSource();
  const context = fixedToolContext([providerPage([task()])]);

  const page = await source.pollPage(request({ ownerActorId: viewerActorId }), context);

  assert.equal(page.error?.code, 'not_configured');
  assert.equal(context.calls.length, 0);
});

test('revoked per-poll source authorization fails closed before the Graph tool call', async () => {
  const { source, authorizationCalls } = createSource({ authorize: 'forbidden' });
  const context = fixedToolContext([providerPage([task()])]);

  const page = await source.pollPage(request(), context);

  assert.equal(page.error?.code, 'forbidden');
  assert.equal(page.observations.length, 0);
  assert.equal(authorizationCalls.length, 1);
  assert.equal(context.calls.length, 0);
});

test('revoked authorization on a resumed page stops pagination without reusing a prior grant', async () => {
  let reads = 0;
  const source = createOfficeObservationSource({
    sourceBindings: plannerBindings(),
    authorization: {
      async authorizeRead() {
        reads += 1;
        return reads === 1 ? 'allowed' : 'forbidden';
      },
    },
    now: () => Date.parse(end),
  });
  const context = fixedToolContext([
    providerPage([task()], { nextCursor: 'provider-page-two', complete: false }),
  ]);

  const first = await source.pollPage(request(), context);
  const second = await source.pollPage(request({ pageCursor: first.nextCursor }), context);

  assert.equal(first.complete, false);
  assert.equal(second.error?.code, 'forbidden');
  assert.equal(second.nextCursor, null);
  assert.equal(context.calls.length, 2, 'the first page includes a plan access probe and a task-list call');
  assert.equal(reads, 2);
});

test('same-token Graph authentication and access denial surface as an explicit forbidden page', async () => {
  const { source } = createSource();
  const context = fixedToolContext([
    { error: { code: 'GRAPH_ACCESS_DENIED', retryable: false } },
  ]);

  const page = await source.pollPage(request(), context);

  assert.equal(page.error?.code, 'forbidden');
  assert.equal(page.complete, false);
  assert.equal(page.nextCursor, null);
  assert.equal(page.observations.length, 0);
});

test('Graph plan access probe preserves bounded authentication, denial, and availability classifications', async t => {
  for (const [label, code, expected] of [
    ['authentication required', 'GRAPH_AUTHENTICATION_FAILED', 'forbidden'],
    ['access denied', 'GRAPH_ACCESS_DENIED', 'forbidden'],
    ['rate limited', 'GRAPH_RATE_LIMITED', 'unavailable'],
    ['upstream unavailable', 'GRAPH_UPSTREAM_UNAVAILABLE', 'unavailable'],
  ]) {
    await t.test(label, async () => {
      const { source } = createSource();
      const calls = [];
      const context = {
        calls,
        async invokeConnectorTool(invocation) {
          calls.push(invocation);
          return { isError: true, structuredContent: { error: { code, message: 'private provider detail' } } };
        },
      };
      const page = await source.pollPage(request(), context);
      assert.equal(page.error?.code, expected);
      assert.equal(page.complete, false);
      assert.equal(page.nextCursor, null);
      assert.equal(page.observations.length, 0);
      assert.equal(JSON.stringify(page).includes('private provider detail'), false);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].toolId, 'microsoft_graph.planner.plan.get');
    });
  }
});

test('rate limiting is an explicit unavailable page and never returns provider text', async () => {
  const { source } = createSource();
  const context = fixedToolContext([
    { error: { code: 'GRAPH_RATE_LIMITED', message: 'vendor response body must not escape' } },
  ]);

  const page = await source.pollPage(request(), context);

  assert.equal(page.error?.code, 'unavailable');
  assert.equal(JSON.stringify(page).includes('vendor response body'), false);
});

test('cursor echo and completeness inconsistencies keep the page partial with no next cursor', async () => {
  const { source } = createSource();
  const context = fixedToolContext([
    providerPage([task()], { pageCursor: 'unexpected-page', nextCursor: null, complete: true }),
  ]);

  const page = await source.pollPage(request(), context);

  assert.equal(page.error?.code, 'invalid');
  assert.equal(page.pageCursor, null);
  assert.equal(page.nextCursor, null);
  assert.equal(page.complete, false);
  assert.equal(page.observations.length, 0);
});

test('truncated or incomplete Graph list metadata cannot advance the source cursor', async () => {
  for (const malformedPage of [
    providerPage([task()], { complete: false, nextCursor: null }),
    { ...providerPage([task()], { complete: false, nextCursor: 'page-2' }), truncated: true },
    providerPage([task(), task({ task_id: 'task_B-2' }), task({ task_id: 'task_C-3' })]),
  ]) {
    const { source } = createSource();
    const page = await source.pollPage(request(), fixedToolContext([malformedPage]));
    assert.equal(page.error?.code, 'invalid');
    assert.equal(page.nextCursor, null);
    assert.equal(page.complete, false);
    assert.equal(page.observations.length, 0);
  }
});

test('request page-size cap rejects invalid work before authorization or provider use', async () => {
  const { source, authorizationCalls } = createSource();
  const context = fixedToolContext([providerPage([task()])]);

  const page = await source.pollPage(request({ pageSize: 51 }), context);

  assert.equal(page.error?.code, 'invalid');
  assert.equal(authorizationCalls.length, 0);
  assert.equal(context.calls.length, 0);
});

test('malformed target selectors fail validation before authorization or provider use', async () => {
  const { source, authorizationCalls } = createSource();
  const context = fixedToolContext([providerPage([task()])]);

  const page = await source.pollPage(request({ target: { id: '', kind: 'planner_plan', bindingId } }), context);

  assert.equal(page.error?.code, 'invalid');
  assert.equal(authorizationCalls.length, 0);
  assert.equal(context.calls.length, 0);
});

test('provider pages with bodies or attachment fields are rejected before projection', async () => {
  const { source } = createSource();
  const unsafeTask = { ...task(), description: 'body must not enter Work events', attachments: [{ id: 'file' }] };
  const context = fixedToolContext([providerPage([unsafeTask])]);

  const page = await source.pollPage(request(), context);

  assert.equal(page.error?.code, 'invalid');
  assert.equal(page.observations.length, 0);
  assert.equal(JSON.stringify(page).includes('body must not enter Work events'), false);
});

test('provider maximum ETag length is retained through a bounded source-version digest', async () => {
  const { source } = createSource();
  const etag = `"${'e'.repeat(1_022)}"`;
  const page = await source.pollPage(request(), fixedToolContext([providerPage([task({ etag })])]));

  assert.equal(page.error, undefined);
  assert.equal(page.observations[0].sourceVersion, `sha256:${createHash('sha256').update(etag).digest('hex')}`);
  assert.ok(page.observations[0].sourceVersion.length <= 512);
  validateWorkflowAutomationEvent(page.observations[0]);
});

test('full snapshot pages retain stable semantics so runtime can suppress unchanged tasks', async () => {
  const { source } = createSource();
  const firstContext = fixedToolContext([providerPage([task()])]);
  const nextContext = fixedToolContext([providerPage([task()])]);

  const baseline = await source.pollPage(request(), firstContext);
  const page = await source.pollPage(request({ windowStart: start }), nextContext);

  assert.equal(page.complete, true);
  assert.equal(page.observations.length, 1);
  assert.equal(page.observations[0].sourceEventId, baseline.observations[0].sourceEventId);
  assert.equal(page.observations[0].semanticFingerprint, baseline.observations[0].semanticFingerprint);
});

test('due-date crossing emits a metadata-only overdue transition at the due time', async () => {
  const { source } = createSource();
  const context = fixedToolContext([providerPage([task({
    percent_complete: 40,
    due_date_time: '2026-10-27T12:05:00.000Z',
    last_modified_date_time: '2026-10-27T12:01:00.000Z',
  })])]);

  const page = await source.pollPage(request({ windowStart: '2026-10-27T12:04:00.000Z' }), context);

  assert.equal(page.observations.length, 1);
  assert.equal(page.observations[0].occurredAt, Date.parse('2026-10-27T12:05:00.000Z'));
  assert.equal(page.observations[0].stateClass, 'incident');
  assert.equal(page.observations[0].severity, 'warning');
  assert.match(page.observations[0].summary, /overdue/u);
});

test('a post-deadline task edit does not move the overdue transition past the due time', async () => {
  const { source } = createSource();
  const context = fixedToolContext([providerPage([task({
    percent_complete: 40,
    due_date_time: '2026-10-27T12:05:00.000Z',
    last_modified_date_time: '2026-10-27T12:07:00.000Z',
  })])]);

  const page = await source.pollPage(request({ windowStart: '2026-10-27T12:04:00.000Z' }), context);

  assert.equal(page.observations[0].occurredAt, Date.parse('2026-10-27T12:05:00.000Z'));
});

test('future Graph task timestamps are rejected as a stale or invalid snapshot', async () => {
  const { source } = createSource();
  const context = fixedToolContext([providerPage([task({
    last_modified_date_time: '2026-10-27T12:20:00.000Z',
  })])]);

  const page = await source.pollPage(request(), context);

  assert.equal(page.error?.code, 'invalid');
  assert.equal(page.observations.length, 0);
});

test('a due-state change alters semantic fingerprint even when Graph ETag did not change', async () => {
  const { source } = createSource();
  const beforeContext = fixedToolContext([providerPage([task({
    due_date_time: '2026-10-27T12:05:00.000Z',
    last_modified_date_time: '2026-10-27T12:01:00.000Z',
  })])]);
  const afterContext = fixedToolContext([providerPage([task({
    due_date_time: '2026-10-27T12:05:00.000Z',
    last_modified_date_time: '2026-10-27T12:01:00.000Z',
  })])]);

  const before = await source.pollPage(request({ windowStart: null, windowEnd: '2026-10-27T12:04:59.000Z' }), beforeContext);
  const after = await source.pollPage(request({ windowStart: '2026-10-27T12:04:59.000Z' }), afterContext);

  assert.equal(before.observations[0].sourceVersion, after.observations[0].sourceVersion);
  assert.notEqual(before.observations[0].semanticFingerprint, after.observations[0].semanticFingerprint);
  assert.equal(after.observations[0].stateClass, 'incident');
});

test('semantic fingerprint ignores a timestamp-only Graph update', async () => {
  const { source } = createSource();
  const first = await source.pollPage(request(), fixedToolContext([providerPage([task()])]));
  const second = await source.pollPage(request({ windowStart: start }), fixedToolContext([providerPage([task({
    etag: 'etag-task-2',
    last_modified_date_time: '2026-10-27T12:07:00.000Z',
  })])]));

  assert.equal(first.observations.length, 1);
  assert.equal(second.observations.length, 1);
  assert.equal(first.observations[0].semanticFingerprint, second.observations[0].semanticFingerprint);
  assert.notEqual(first.observations[0].sourceVersion, second.observations[0].sourceVersion);
});

test('task completion is a healthy recovery and body fields never enter the summary', async () => {
  const { source } = createSource();
  const before = await source.pollPage(request(), fixedToolContext([providerPage([task({
    percent_complete: 20,
    due_date_time: '2026-10-27T12:05:00.000Z',
  })])]));
  const after = await source.pollPage(request({ windowStart: start }), fixedToolContext([providerPage([task({
    percent_complete: 100,
    due_date_time: '2026-10-27T12:05:00.000Z',
    last_modified_date_time: '2026-10-27T12:07:00.000Z',
    etag: 'etag-completed',
  })])]));

  assert.equal(before.observations[0].stateClass, 'incident');
  assert.equal(after.observations[0].stateClass, 'healthy');
  assert.notEqual(before.observations[0].semanticFingerprint, after.observations[0].semanticFingerprint);
  assert.equal(after.observations[0].severity, undefined);
  assert.equal(JSON.stringify(after).includes('description'), false);
  assert.equal(JSON.stringify(after).includes('attachments'), false);
});

test('tampered cursor for a different poll window is rejected before a provider call', async () => {
  const { source } = createSource();
  const firstContext = fixedToolContext([providerPage([task()], {
    nextCursor: 'provider-page-two',
    complete: false,
  })]);
  const first = await source.pollPage(request({ windowStart: start }), firstContext);
  const context = fixedToolContext([providerPage([task()])]);

  const resumed = await source.pollPage(request({
    pageCursor: first.nextCursor,
    windowStart: '2026-10-27T12:01:00.000Z',
  }), context);

  assert.equal(resumed.error?.code, 'partial');
  assert.equal(context.calls.length, 0);
});

test('a provider page cursor cannot cross actor-owned plan bindings', async () => {
  const viewerBindingId = '44444444-4444-4444-8444-444444444444';
  const rows = [{
    actorId: viewerActorId,
    targetId: lookupTargetId,
    kind: 'planner_plan',
    bindingId: viewerBindingId,
    connectionRef: 'exchange:graph:viewer',
    profileRef: 'graph-profile-viewer',
    tenantId,
    planId: 'Plan_Viewer_9',
  }];
  const { source } = createSource({ rows });
  const first = await source.pollPage(request(), fixedToolContext([providerPage([task()], {
    nextCursor: 'owner-page-two',
    complete: false,
  })]));
  const context = fixedToolContext([providerPage([task()])]);

  const resumed = await source.pollPage(request({
    ownerActorId: viewerActorId,
    target: { id: lookupTargetId, kind: 'planner_plan', bindingId: viewerBindingId },
    pageCursor: first.nextCursor,
  }), context);

  assert.equal(resumed.error?.code, 'partial');
  assert.equal(context.calls.length, 0);
});

test('pre-aborted source calls return timeout without resolving or invoking a binding', async () => {
  const { source, authorizationCalls } = createSource();
  const context = fixedToolContext([providerPage([task()])]);
  const controller = new AbortController();
  controller.abort();

  const page = await source.pollPage(request({ signal: controller.signal }), context);

  assert.equal(page.error?.code, 'timeout');
  assert.equal(authorizationCalls.length, 0);
  assert.equal(context.calls.length, 0);
});

test('an unresponsive authorization client is bounded by the adapter deadline', async () => {
  const source = createOfficeObservationSource({
    sourceBindings: plannerBindings(),
    authorization: { async authorizeRead() { return new Promise(() => {}); } },
    now: () => Date.parse(end),
    timeoutMs: 10,
  });
  const context = fixedToolContext([providerPage([task()])]);

  const page = await source.pollPage(request(), context);

  assert.equal(page.error?.code, 'timeout');
  assert.equal(context.calls.length, 0);
});

test('an unresponsive fixed provider call is bounded and receives the abort signal', async () => {
  const controller = new AbortController();
  const source = createOfficeObservationSource({
    sourceBindings: plannerBindings(),
    authorization: { async authorizeRead() { return 'allowed'; } },
    now: () => Date.parse(end),
    timeoutMs: 10,
  });
  let seenSignal;
  const context = {
    async invokeConnectorTool(invocation) {
      seenSignal = invocation.signal;
      return new Promise(() => {});
    },
  };

  const page = await source.pollPage(request({ signal: controller.signal }), context);

  assert.equal(page.error?.code, 'timeout');
  assert.ok(seenSignal instanceof AbortSignal);
  assert.equal(seenSignal.aborted, true);
});
