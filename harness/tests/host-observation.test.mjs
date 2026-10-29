// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: VM health observation source tests                          │
// │ Role: Verify actor scope, private file checks, and fresh state facts.│
// │                                                                      │
// │ 模块职责：验证 actor 范围、私有文件权限与新鲜健康状态。               │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHostHealthObservationSource } from '../dist/workflows/host-observation.js';

const actorId = 'pilot-owner-subject';
const targetId = 'vm-health-target';
const bindingId = '10cf334d-6f8a-4fea-83df-fef89f8eb523';
const hostRef = 'synthetic-host-ref';
const observedAt = '2026-10-27T12:09:30.000Z';
const windowEnd = '2026-10-27T12:10:00.000Z';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    observedAt,
    hostRef,
    state: 'healthy',
    services: [
      { serviceAlias: 'backend', state: 'healthy', restartCount: 2 },
      { serviceAlias: 'ingress', state: 'healthy', restartCount: 0 },
    ],
    ...overrides,
  };
}

async function mountStatus(directory, value = snapshot()) {
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o750);
  const path = join(directory, 'latest-status.json');
  await writeFile(path, `${canonical(value)}\n`, { mode: 0o640 });
  await chmod(path, 0o640);
  return path;
}

function createSource(directory, overrides = {}) {
  const decisions = { resolved: [], authorized: [] };
  const profile = {
    actorId,
    targetId,
    targetKind: 'host_health',
    bindingId,
    hostRef,
    mountDirectory: directory,
    mountGid: process.getgid(),
    maxAgeSeconds: 120,
    maxClockSkewSeconds: 30,
    ...overrides.profile,
  };
  const source = createHostHealthObservationSource({
    actorId,
    now: () => Date.parse(windowEnd),
    expectedOwnerUid: process.getuid(),
    authority: {
      async resolveTarget(id, target, signal) {
        decisions.resolved.push({ id, target, aborted: signal.aborted });
        return overrides.missingTarget === true ? undefined : profile;
      },
      async authorizeRead(id, target, resolved, signal) {
        decisions.authorized.push({ id, target, resolved, aborted: signal.aborted });
        return overrides.permission ?? 'allowed';
      },
    },
  });
  return { source, decisions };
}

function request(overrides = {}) {
  return {
    source: 'vm_health',
    ownerActorId: actorId,
    target: { id: targetId, kind: 'host_health', bindingId },
    pageSize: 10,
    pageCursor: null,
    windowStart: '2026-10-27T12:00:00.000Z',
    windowEnd,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('reads one fixed private status file and emits opaque host/service state facts', async t => {
  const directory = t.mock?.tmpdir?.();
  const root = await import('node:os');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const temp = await fs.mkdtemp(path.join(root.tmpdir(), 'host-observation-'));
  const statusDirectory = path.join(temp, 'mount');
  try {
    await mountStatus(statusDirectory);
    const { source } = createSource(statusDirectory);
    const page = await source.read(request({ target: {
      id: targetId,
      kind: 'host_health',
      bindingId,
      mountDirectory: '/attacker/path',
    } }));
    assert.equal(page.source, 'vm_health');
    assert.equal(page.pageCursor, null);
    assert.equal(page.nextCursor, null);
    assert.equal(page.complete, true);
    assert.equal(page.truncated, false);
    assert.equal(page.observations.length, 1);
    const observation = page.observations[0];
    assert.equal(observation.eventType, 'vm.health.snapshot');
    assert.equal(observation.resourceUri, `cyrene://vm-health/${hostRef}`);
    assert.equal(observation.stateClass, 'healthy');
    assert.match(observation.semanticFingerprint, /^[0-9a-f]{64}$/u);
    assert.match(observation.sourceVersion, /^[0-9a-f]{64}$/u);
    assert.equal(observation.summary, 'Host health healthy; monitored services 2.');
    assert.ok(observation.metadataReferences?.some(item => item.resourceUri.endsWith('/services/backend')));
    const text = JSON.stringify(page);
    assert.equal(text.includes(statusDirectory), false);
    assert.equal(text.includes('latest-status.json'), false);
    assert.equal(text.includes('container'), false);
    assert.equal(text.includes('network'), false);
    assert.equal(text.includes('private'), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('same health facts retain their fingerprint across samples but file versions change', async t => {
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'host-observation-'));
  try {
    const statusDirectory = path.join(temp, 'mount');
    const statusPath = await mountStatus(statusDirectory, snapshot());
    const { source } = createSource(statusDirectory);
    const first = await source.read(request());
    const later = await source.read(request());
    assert.equal(first.observations[0].semanticFingerprint, later.observations[0].semanticFingerprint);
    assert.equal(first.observations[0].sourceEventId, later.observations[0].sourceEventId);

    await mountStatus(statusDirectory, snapshot({ observedAt: '2026-10-27T12:09:40.000Z' }));
    const updated = await source.read(request());
    assert.equal(updated.observations[0].semanticFingerprint, first.observations[0].semanticFingerprint);
    assert.notEqual(updated.observations[0].sourceEventId, first.observations[0].sourceEventId);
    assert.notEqual(updated.observations[0].sourceVersion, first.observations[0].sourceVersion);
    assert.equal(await readFile(statusPath, 'utf8').then(value => value.includes('12:09:40')), true);

    await mountStatus(statusDirectory, snapshot({
      observedAt: '2026-10-27T12:09:45.000Z',
      state: 'degraded',
      services: [
        { serviceAlias: 'backend', state: 'degraded', restartCount: 3 },
        { serviceAlias: 'ingress', state: 'healthy', restartCount: 0 },
      ],
    }));
    const incident = await source.read(request());
    await mountStatus(statusDirectory, snapshot({ observedAt: '2026-10-27T12:09:50.000Z' }));
    const recovered = await source.read(request());
    assert.equal(recovered.observations[0].semanticFingerprint, first.observations[0].semanticFingerprint);
    assert.notEqual(recovered.observations[0].sourceEventId, first.observations[0].sourceEventId);
    assert.notEqual(recovered.observations[0].sourceEventId, incident.observations[0].sourceEventId);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('degraded and unknown samples stay explicit incidents and neutral uncertainty', async t => {
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'host-observation-'));
  try {
    const statusDirectory = path.join(temp, 'mount');
    await mountStatus(statusDirectory, snapshot({
      state: 'degraded',
      services: [
        { serviceAlias: 'backend', state: 'degraded', restartCount: 4 },
        { serviceAlias: 'ingress', state: 'healthy', restartCount: 0 },
      ],
    }));
    const { source } = createSource(statusDirectory);
    const degraded = await source.read(request());
    assert.equal(degraded.observations[0].stateClass, 'incident');
    assert.equal(degraded.observations[0].severity, 'warning');

    await mountStatus(statusDirectory, snapshot({ state: 'unknown', services: [
      { serviceAlias: 'backend', state: 'unknown', restartCount: null },
      { serviceAlias: 'ingress', state: 'unknown', restartCount: null },
    ] }));
    const unknown = await source.read(request());
    assert.equal(unknown.observations[0].stateClass, 'neutral');
    assert.equal(unknown.observations[0].severity, 'warning');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('missing resources, denied actors, revoked reads, and stale status never return an empty pass', async t => {
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'host-observation-'));
  try {
    const missing = createSource(path.join(temp, 'missing'), { missingTarget: true });
    assert.equal((await missing.source.read(request())).error?.code, 'not_configured');
    assert.equal(missing.decisions.authorized.length, 0);

    const denied = createSource(path.join(temp, 'missing'), { permission: 'forbidden' });
    assert.equal((await denied.source.read(request())).error?.code, 'forbidden');

    const noRead = createSource(path.join(temp, 'missing'), { permission: 'not_configured' });
    assert.equal((await noRead.source.read(request())).error?.code, 'not_configured');

    const wrongOwner = createSource(path.join(temp, 'missing'));
    assert.equal((await wrongOwner.source.read(request({ ownerActorId: 'different-owner' }))).error?.code, 'forbidden');
    assert.equal(wrongOwner.decisions.resolved.length, 0);

    const staleDirectory = path.join(temp, 'stale');
    await mountStatus(staleDirectory, snapshot({ observedAt: '2026-10-27T12:00:00.000Z' }));
    const stale = createSource(staleDirectory);
    assert.equal((await stale.source.read(request())).error?.code, 'unavailable');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('scope, permissions, canonical schema, and freshness checks fail closed', async t => {
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'host-observation-'));
  try {
    const statusDirectory = path.join(temp, 'mount');
    await mountStatus(statusDirectory, snapshot({ hostRef: 'different-host' }));
    const wrongHost = createSource(statusDirectory);
    assert.equal((await wrongHost.source.read(request())).error?.code, 'forbidden');

    await mountStatus(statusDirectory, snapshot());
    await fs.chmod(path.join(statusDirectory, 'latest-status.json'), 0o644);
    const permissive = createSource(statusDirectory);
    assert.equal((await permissive.source.read(request())).error?.code, 'forbidden');

    await mountStatus(statusDirectory, snapshot());
    const file = path.join(statusDirectory, 'latest-status.json');
    const content = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, `${content.trim()}\nextra`, { mode: 0o640 });
    await fs.chmod(file, 0o640);
    const malformed = createSource(statusDirectory);
    assert.equal((await malformed.source.read(request())).error?.code, 'invalid');

    await mountStatus(statusDirectory, snapshot());
    const source = createSource(statusDirectory);
    assert.equal((await source.source.read(request({ pageCursor: '1' }))).error?.code, 'invalid');
    assert.equal((await source.source.read(request({ target: { id: targetId, kind: 'host_health', bindingId: '90cf334d-6f8a-4fea-83df-fef89f8eb523' } }))).error?.code, 'forbidden');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('a symlinked status file is rejected', async t => {
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'host-observation-'));
  try {
    const statusDirectory = path.join(temp, 'mount');
    await fs.mkdir(statusDirectory, { mode: 0o750 });
    await fs.chmod(statusDirectory, 0o750);
    const outside = path.join(temp, 'private.json');
    await fs.writeFile(outside, `${canonical(snapshot())}\n`, { mode: 0o640 });
    await fs.symlink(outside, path.join(statusDirectory, 'latest-status.json'));
    const { source } = createSource(statusDirectory);
    assert.equal((await source.read(request())).error?.code, 'forbidden');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
