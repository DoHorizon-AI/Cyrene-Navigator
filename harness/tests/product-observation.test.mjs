// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Product observation source adapter tests                    │
// │ Role: Exercise scoped Product reads and bounded event pages.         │
// │                                                                      │
// │ 模块职责：通过进程内 Product HTTP 服务验证授权、分页与元数据。         │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createProductObservationSource } from '../dist/workflows/product-observation.js';

const actorId = 'pilot-owner-subject';
const targetId = 'yield-run-target';
const bindingId = '10cf334d-6f8a-4fea-83df-fef89f8eb523';
const runId = '1b6ce5fd-0b0f-4a6a-a661-c092bc091f2e';
const attemptId = 'a15180d0-e6b0-4d09-b105-97d54e378799';
const datasetId = '03f9d64f-89d4-4884-a1a6-df820f8c2719';
const organizationId = 'synthetic-organization';
const workspaceId = 'synthetic-workspace';
const start = '2026-10-27T12:00:00.000Z';
const end = '2026-10-27T12:10:00.000Z';
const updatedAt = '2026-10-27T12:04:00.000Z';
const digest = `sha256:${'a'.repeat(64)}`;
const checkpointDigest = `sha256:${'b'.repeat(64)}`;

function trainingRun(overrides = {}) {
  return {
    id: runId,
    state: 'COMPLETED',
    spec: {
      datasetVersion: { id: datasetId, resourceVersion: 3, artifact: { digest, sizeBytes: 240, kind: 'dataset' }, format: 'ALPACA_JSONL' },
      modelArtifact: { digest, sizeBytes: 900, kind: 'model' },
      method: 'SFT',
      finetuningType: 'LORA',
      parameters: { epochs: 1, perDeviceBatchSize: 1, gradientAccumulationSteps: 1, learningRate: 0.0002, maxSequenceLength: 512 },
    },
    attemptCount: 1,
    outputArtifacts: [{ kind: 'MODEL_CHECKPOINT', artifact: { digest: checkpointDigest, sizeBytes: 1200, kind: 'checkpoint' }, derivedFromDigests: [digest] }],
    createdAt: '2026-10-27T12:01:00.000Z',
    updatedAt,
    resourceVersion: 7,
    result: {
      id: '91524093-9307-43cf-aab8-5891ab9cf369',
      adapterArtifact: { digest, sizeBytes: 700, kind: 'model' },
      checkpointArtifacts: [{ digest: checkpointDigest, sizeBytes: 1200, kind: 'checkpoint' }],
      createdAt: updatedAt,
    },
    ...overrides,
  };
}

function attemptsProjection(overrides = {}) {
  return {
    organizationId,
    workspaceId,
    trainingRunId: runId,
    attempts: [{ id: attemptId, trainingRunId: runId, phase: 'training', state: 'SUCCEEDED' }],
    ...overrides,
  };
}

function eventsProjection(events, afterSequence, state = 'COMPLETED', overrides = {}) {
  return {
    organizationId,
    workspaceId,
    trainingRunId: runId,
    events,
    afterSequence,
    nextSequence: events.at(-1)?.sequence ?? afterSequence,
    terminal: true,
    state,
    ...overrides,
  };
}

function trainingEvent(sequence, overrides = {}) {
  return {
    sequence,
    trainingRunId: runId,
    attemptId,
    phase: 'training',
    kind: 'checkpoint',
    message: 'private executor path must not be copied into an observation',
    timestamp: updatedAt,
    step: sequence * 10,
    totalSteps: 100,
    checkpoint: { digest: checkpointDigest, step: sequence * 10, sizeBytes: 1200 },
    ...overrides,
  };
}

async function startProductServer(handler) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const captured = { method: request.method, url: request.url, headers: request.headers, body };
      requests.push(captured);
      try {
        const result = await handler(captured);
        response.writeHead(result.status ?? 200, { 'content-type': result.contentType ?? 'application/json' });
        response.end(result.body === undefined ? JSON.stringify(result.json ?? {}) : result.body);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function makeSource(baseUrl, overrides = {}) {
  const resolved = {
    actorId,
    targetId,
    targetKind: 'training_run',
    bindingId,
    product: 'yield',
    resourceKind: 'training-run',
    resourceId: runId,
    baseUrl,
    organizationId,
    workspaceId,
    ...overrides.profile,
  };
  const decisions = { resolve: [], authorize: [], token: [] };
  const source = createProductObservationSource({
    actorId,
    now: () => Date.parse(end),
    authority: {
      async resolveTarget(id, target, signal) {
        decisions.resolve.push({ id, target, aborted: signal.aborted });
        return overrides.resolved === false ? undefined : resolved;
      },
      async authorizeRead(id, target, profile, signal) {
        decisions.authorize.push({ id, target, profile, aborted: signal.aborted });
        return overrides.authorization ?? 'allowed';
      },
      async bearerFor(id, profile, signal) {
        decisions.token.push({ id, profile, aborted: signal.aborted });
        return overrides.token === undefined ? 'actor-bound-synthetic-token' : overrides.token;
      },
    },
  });
  return { source, decisions };
}

function request(overrides = {}) {
  return {
    source: 'training',
    ownerActorId: actorId,
    target: { id: targetId, kind: 'training_run', bindingId },
    pageSize: 10,
    pageCursor: null,
    windowStart: start,
    windowEnd: end,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('Yield reads the exact scoped Product run, attempts, and event query without copying private messages', async () => {
  const server = await startProductServer(async item => {
    assert.equal(item.headers.authorization, 'Bearer actor-bound-synthetic-token');
    if (item.url === `/internal/workspace/v1/training-runs/${runId}` && item.method === 'GET') return { json: trainingRun() };
    if (item.url === `/internal/workspace/v1/training-runs/${runId}/attempts` && item.method === 'GET') return { json: attemptsProjection() };
    if (item.url === `/internal/workspace/v1/training-runs/${runId}/events/query` && item.method === 'POST') {
      assert.deepEqual(JSON.parse(item.body), { afterSequence: 0, limit: 10 });
      return { json: eventsProjection([trainingEvent(1)], 0) };
    }
    assert.fail(`Unexpected Product read ${item.method} ${item.url}`);
  });
  try {
    const { source } = makeSource(server.baseUrl);
    const page = await source.read(request());
    assert.equal(page.source, 'training');
    assert.equal(page.pageCursor, null);
    assert.equal(page.nextCursor, '1');
    assert.equal(page.complete, true);
    assert.equal(page.truncated, false);
    assert.equal(page.observations.length, 2);
    const event = page.observations.find(item => item.eventType === 'yield.training_run.checkpoint');
    const state = page.observations.find(item => item.eventType === 'yield.training_run.state');
    assert.ok(event && state);
    assert.equal(state.summary, 'Product state COMPLETED; attempts 1.');
    assert.equal(state.sourceVersion, 7);
    assert.equal(event.sourceVersion, 1);
    assert.equal(event.stateClass, 'neutral');
    assert.match(event.semanticFingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(event.summary, 'training: checkpoint; step 10/100; checkpoint step 10');
    assert.equal(JSON.stringify(page).includes('private executor path'), false);
    assert.ok(state.metadataReferences?.some(item => item.resourceUri === `cyrene://catalyst/dataset-versions/${datasetId}`));
    assert.ok(state.metadataReferences?.some(item => item.resourceUri === `cyrene://yield/training-attempts/${attemptId}`));
    assert.ok(state.metadataReferences?.some(item => item.resourceUri === `artifact://sha256/${'b'.repeat(64)}`));
    assert.ok(event.metadataReferences?.some(item => item.kind === 'artifact.checkpoint'));
    assert.equal(server.requests.length, 3);
    assert.ok(server.requests.every(item => item.method === 'GET' || item.url === `/internal/workspace/v1/training-runs/${runId}/events/query`));
  } finally {
    await server.close();
  }
});

test('Yield event cursor resumes after full pages and emits the run state once room is available', async () => {
  const server = await startProductServer(async item => {
    if (item.url === `/internal/workspace/v1/training-runs/${runId}`) return { json: trainingRun() };
    if (item.url === `/internal/workspace/v1/training-runs/${runId}/attempts`) return { json: attemptsProjection() };
    if (item.url === `/internal/workspace/v1/training-runs/${runId}/events/query`) {
      const query = JSON.parse(item.body);
      if (query.afterSequence === 0) {
        assert.equal(query.limit, 2);
        return { json: eventsProjection([trainingEvent(1), trainingEvent(2)], 0, 'COMPLETED') };
      }
      assert.equal(query.afterSequence, 2);
      return { json: eventsProjection([], 2) };
    }
    assert.fail(`Unexpected Product read ${item.method} ${item.url}`);
  });
  try {
    const { source } = makeSource(server.baseUrl);
    const first = await source.read(request({ pageSize: 2 }));
    assert.equal(first.complete, false);
    assert.equal(first.nextCursor, '2');
    assert.equal(first.observations.length, 2);
    const second = await source.read(request({ pageSize: 2, pageCursor: first.nextCursor }));
    assert.equal(second.complete, true);
    assert.equal(second.pageCursor, '2');
    assert.equal(second.nextCursor, '2');
    assert.ok(second.observations.some(item => item.eventType === 'yield.training_run.state'));
  } finally {
    await server.close();
  }
});

test('Yield rejects a cross-workspace Product response as partial and does not advance its cursor', async () => {
  const server = await startProductServer(async item => {
    if (item.url === `/internal/workspace/v1/training-runs/${runId}`) return { json: trainingRun() };
    if (item.url === `/internal/workspace/v1/training-runs/${runId}/attempts`) {
      return { json: attemptsProjection({ workspaceId: 'another-workspace' }) };
    }
    if (item.url === `/internal/workspace/v1/training-runs/${runId}/events/query`) return { json: eventsProjection([], 0) };
    assert.fail(`Unexpected Product read ${item.method} ${item.url}`);
  });
  try {
    const { source } = makeSource(server.baseUrl);
    const page = await source.read(request());
    assert.equal(page.error?.code, 'partial');
    assert.equal(page.complete, false);
    assert.equal(page.nextCursor, null);
    assert.deepEqual(page.observations, []);
  } finally {
    await server.close();
  }
});

test('missing target, denied actor access, and absent credentials stay distinct and perform no Product request', async () => {
  const server = await startProductServer(async () => ({ json: trainingRun() }));
  try {
    const missing = makeSource(server.baseUrl, { resolved: false });
    assert.equal((await missing.source.read(request())).error?.code, 'not_configured');
    assert.equal(missing.decisions.token.length, 0);

    const denied = makeSource(server.baseUrl, { authorization: 'forbidden' });
    assert.equal((await denied.source.read(request())).error?.code, 'forbidden');
    assert.equal(denied.decisions.token.length, 0);

    const wrongOwner = makeSource(server.baseUrl);
    assert.equal((await wrongOwner.source.read(request({ ownerActorId: 'different-owner' }))).error?.code, 'forbidden');
    assert.equal(wrongOwner.decisions.resolve.length, 0);

    const noTokenSource = createProductObservationSource({
      actorId,
      authority: {
        resolveTarget: async () => ({
          actorId, targetId, targetKind: 'training_run', bindingId,
          product: 'yield', resourceKind: 'training-run', resourceId: runId,
          baseUrl: server.baseUrl, organizationId, workspaceId,
        }),
        authorizeRead: async () => 'allowed',
        bearerFor: async () => undefined,
      },
    });
    assert.equal((await noTokenSource.read(request())).error?.code, 'not_configured');
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('target URL fields are ignored and a mismatched trusted profile is rejected before HTTP', async () => {
  const server = await startProductServer(async () => ({ json: trainingRun() }));
  try {
    const mismatched = makeSource(server.baseUrl, { profile: { bindingId: '90cf334d-6f8a-4fea-83df-fef89f8eb523' } });
    const page = await mismatched.source.read(request({ target: {
      id: targetId,
      kind: 'training_run',
      bindingId,
      baseUrl: 'https://attacker.invalid',
    } }));
    assert.equal(page.error?.code, 'forbidden');
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('invalid Product schema, HTTP denial, and oversized bodies remain explicit failures', async t => {
  await t.test('invalid run schema', async () => {
    const server = await startProductServer(async item => {
      if (item.url.endsWith('/events/query')) return { json: eventsProjection([], 0) };
      if (item.url.endsWith('/attempts')) return { json: attemptsProjection() };
      return { json: { ...trainingRun(), resourceVersion: 0 } };
    });
    try {
      const { source } = makeSource(server.baseUrl);
      assert.equal((await source.read(request())).error?.code, 'invalid');
    } finally {
      await server.close();
    }
  });

  await t.test('HTTP 403', async () => {
    const server = await startProductServer(async item => item.url.endsWith('/attempts')
      ? { status: 403, json: { detail: 'private detail' } }
      : { json: trainingRun() });
    try {
      const { source } = makeSource(server.baseUrl);
      const page = await source.read(request());
      assert.equal(page.error?.code, 'forbidden');
      assert.equal(JSON.stringify(page).includes('private detail'), false);
    } finally {
      await server.close();
    }
  });

  await t.test('HTTP 404', async () => {
    const server = await startProductServer(async item => item.url.endsWith('/attempts')
      ? { status: 404, json: { detail: 'private resource detail' } }
      : { json: trainingRun() });
    try {
      const { source } = makeSource(server.baseUrl);
      const page = await source.read(request());
      assert.equal(page.error?.code, 'not_configured');
      assert.equal(JSON.stringify(page).includes('private resource detail'), false);
    } finally {
      await server.close();
    }
  });

  await t.test('oversized Product response', async () => {
    const server = await startProductServer(async item => item.url.endsWith('/attempts')
      ? { body: JSON.stringify({ ...attemptsProjection(), padding: 'x'.repeat(1_000_100) }) }
      : item.url.endsWith('/events/query') ? { json: eventsProjection([], 0) } : { json: trainingRun() });
    try {
      const { source } = makeSource(server.baseUrl);
      assert.equal((await source.read(request())).error?.code, 'invalid');
    } finally {
      await server.close();
    }
  });
});

test('Catalyst, Echo, and Reactor exact-resource reads emit only bounded status and reference lineage', async () => {
  const resourceIds = {
    catalyst: '637b9be7-573f-4d8c-b4a7-b85b10c0f4f1',
    echo: '97191f0f-34ed-4660-b357-cc925e2734b8',
    reactor: 'ebddb9c6-b6b6-4e3f-858f-460e4b5b7300',
  };
  const reactorRunUri = `cyrene://yield/training-runs/${runId}`;
  const reactorDatasetUri = `cyrene://catalyst/dataset-versions/${datasetId}`;
  const server = await startProductServer(async item => {
    if (item.url === `/api/v1/dataset-versions/${resourceIds.catalyst}`) return { json: {
      id: resourceIds.catalyst, datasetId, version: 4, state: 'PUBLISHED',
      source: { uri: `artifact://sha256/${'a'.repeat(64)}`, digest, size_bytes: 99, kind: 'dataset' },
      output: { uri: `artifact://sha256/${'b'.repeat(64)}`, digest: checkpointDigest, size_bytes: 100, kind: 'dataset' },
      lineage: [], createdAt: '2026-10-27T12:00:00.000Z', updatedAt, resourceVersion: 2,
    } };
    if (item.url === `/api/v1/evaluation-runs/${resourceIds.echo}`) return { json: {
      id: resourceIds.echo, suiteId: 'ac03cfb4-a2fd-4872-978f-d0928a3efb54', state: 'SUCCEEDED',
      inputArtifact: { uri: `artifact://sha256/${'a'.repeat(64)}`, digest, size_bytes: 80, kind: 'dataset' },
      resultId: '579aefb5-e793-4687-b813-65e0191c0282', gateId: '297204b1-3dcc-4f4d-8e1b-4092c883a908',
      engineBindingId: 'synthetic-echo-binding', createdAt: '2026-10-27T12:00:00.000Z', updatedAt, resourceVersion: 9,
    } };
    if (item.url === `/api/v1/deployments/${resourceIds.reactor}`) return { json: {
      id: resourceIds.reactor, name: 'synthetic-deployment', modelArtifact: { uri: `artifact://sha256/${'c'.repeat(64)}`, digest: `sha256:${'c'.repeat(64)}`, size_bytes: 500, kind: 'model' },
      composition: 'BASE_PLUS_LORA', desiredState: 'ACTIVE', observedState: 'READY',
      modelVersion: { schemaVersion: '1', id: `model-version://sha256/${'d'.repeat(64)}`, composition: 'BASE_PLUS_LORA',
        baseModel: { artifact: { uri: `artifact://sha256/${'c'.repeat(64)}`, digest: `sha256:${'c'.repeat(64)}`, size_bytes: 500, kind: 'model' }, source: { repository: 'owner/model', revision: 'e'.repeat(40) } },
        adapterArtifact: { uri: `artifact://sha256/${'f'.repeat(64)}`, digest: `sha256:${'f'.repeat(64)}`, size_bytes: 200, kind: 'model' },
        tokenizer: { mode: 'INHERIT' }, chatTemplate: { mode: 'INHERIT' }, lineage: { trainingRun: reactorRunUri, datasetVersion: reactorDatasetUri, inputArtifacts: [] } },
      servingBindingId: 'synthetic-serving-binding', servingCapabilityType: 'execution.engine.v1', endpointId: '0471b75a-d281-4504-9d8e-8eb89863e5b5',
      createdAt: '2026-10-27T12:00:00.000Z', updatedAt, resourceVersion: 12,
    } };
    assert.fail(`Unexpected Product read ${item.method} ${item.url}`);
  });
  try {
    const cases = [
      { product: 'catalyst', resourceKind: 'dataset-version', resourceId: resourceIds.catalyst, eventType: 'catalyst.dataset_version.state' },
      { product: 'echo', resourceKind: 'evaluation-run', resourceId: resourceIds.echo, eventType: 'echo.evaluation_run.state' },
      { product: 'reactor', resourceKind: 'deployment', resourceId: resourceIds.reactor, eventType: 'reactor.deployment.state' },
    ];
    for (const item of cases) {
      const source = createProductObservationSource({
          actorId,
          now: () => Date.parse(end),
          authority: {
          resolveTarget: async () => ({ actorId, targetId, targetKind: 'product_resource', bindingId, baseUrl: server.baseUrl, ...item }),
          authorizeRead: async () => 'allowed',
          bearerFor: async () => 'actor-bound-synthetic-token',
        },
      });
      const page = await source.read(request({
        source: 'product',
        target: { id: targetId, kind: 'product_resource', bindingId },
      }));
      assert.equal(page.complete, true, JSON.stringify(page));
      assert.equal(page.observations.length, 1);
      assert.equal(page.observations[0].eventType, item.eventType);
      assert.ok(page.observations[0].resourceUri.startsWith('cyrene://'));
      assert.ok(page.observations[0].metadataReferences.length > 0);
    }
    const deployment = server.requests.find(item => item.url === `/api/v1/deployments/${resourceIds.reactor}`);
    assert.equal(deployment.method, 'GET');
  } finally {
    await server.close();
  }
});
