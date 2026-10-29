// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: automation source binding configuration tests              │
// │ Role: Verify strict private mappings and current ACL callbacks.      │
// │                                                                      │
// │ 模块职责：验证私有来源绑定映射及每轮 ACL 检查。                       │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  authorizePlannerPlanRead,
  createHostObservationAuthority,
  createProductObservationAuthority,
  decodeAutomationSourceBindings,
  loadAutomationSourceBindings,
  resolvePlannerPlanBinding,
} from '../dist/workflows/source-config.js';

const actorId = 'synthetic-owner';
const bindingId = '10cf334d-6f8a-4fea-83df-fef89f8eb523';
const resourceId = '1b6ce5fd-0b0f-4a6a-a661-c092bc091f2e';
const organizationId = 'synthetic-organization';
const workspaceId = 'synthetic-workspace';

function config(overrides = {}) {
  return {
    schemaVersion: 1,
    targets: [
      {
        actorId, targetId: 'yield-run-lookup', kind: 'training_run', bindingId,
        product: 'yield', resourceKind: 'training-run', resourceId, organizationId, workspaceId,
      },
      {
        actorId, targetId: 'dataset-lookup', kind: 'product_resource', bindingId: '20cf334d-6f8a-4fea-83df-fef89f8eb523',
        product: 'catalyst', resourceKind: 'dataset-version', resourceId: '637b9be7-573f-4d8c-b4a7-b85b10c0f4f1',
        organizationId, workspaceId,
      },
      {
        actorId, targetId: 'vm-health-lookup', kind: 'host_health', bindingId: '30cf334d-6f8a-4fea-83df-fef89f8eb523',
        hostRef: 'synthetic-host', mountDirectory: '/run/synthetic-health', mountGid: 2000,
        maxAgeSeconds: 90, maxClockSkewSeconds: 15,
      },
      {
        actorId, targetId: 'planner-plan-lookup', kind: 'planner_plan', bindingId: '40cf334d-6f8a-4fea-83df-fef89f8eb523',
        connectionRef: 'connection-server-ref', profileRef: 'profile-server-ref',
        tenantId: '9b9d289f-56a6-4615-88a0-fa2161fd14cf', planId: 'plan-server-selected-id',
      },
    ],
    ...overrides,
  };
}

async function writeConfig(directory, document, { mode = 0o600, name = 'automation-sources.json' } = {}) {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(document), { mode });
  await chmod(path, mode);
  return path;
}

test('decodes Product, host, and Planner lookup bindings without access booleans or URLs', () => {
  const bindings = decodeAutomationSourceBindings(config());
  assert.equal(bindings.targets.length, 4);
  assert.equal(bindings.targets[0].kind, 'training_run');
  assert.equal(bindings.targets[2].kind, 'host_health');
  assert.equal(bindings.targets[3].planId, 'plan-server-selected-id');
  assert.throws(() => decodeAutomationSourceBindings(config({ targets: [
    { ...config().targets[1], baseUrl: 'https://attacker.invalid' },
  ] })), /unsupported fields/u);
  assert.throws(() => decodeAutomationSourceBindings(config({ targets: [
    { ...config().targets[0], sourceAccessVerified: true },
  ] })), /unsupported fields/u);
  assert.throws(() => decodeAutomationSourceBindings(config({ targets: [
    { ...config().targets[3], planId: undefined },
  ] })), /planId/u);
});

test('an empty optional source registry boots without authorizing a Planner target', () => {
  const bindings = decodeAutomationSourceBindings({ schemaVersion: 1, targets: [] });
  assert.deepEqual(bindings.targets, []);
  assert.equal(resolvePlannerPlanBinding(bindings, actorId, {
    id: 'not-enabled', kind: 'planner_plan', bindingId,
  }), undefined);
});

test('POSIX private loader accepts owner-only config and rejects symlinks and permissive files', {
  skip: process.platform === 'win32'
    ? 'Private automation source bindings require POSIX UID/mode checks until Windows ACL verification is implemented.'
    : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-config-'));
  try {
    const privatePath = await writeConfig(directory, config());
    const loaded = await loadAutomationSourceBindings(privatePath);
    assert.equal(loaded.targets.length, 4);

    const permissive = await writeConfig(directory, config(), { mode: 0o644, name: 'permissive.json' });
    await assert.rejects(loadAutomationSourceBindings(permissive), /private file/u);

    const link = join(directory, 'source-link.json');
    await symlink(privatePath, link);
    await assert.rejects(loadAutomationSourceBindings(link), /symlinks/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Windows refuses a native absolute private source-binding path until ACL verification exists', {
  skip: process.platform === 'win32' ? false : 'Windows-only private-file guard test.',
}, async () => {
  const nativePath = join(tmpdir(), 'navigator-private-source-bindings-not-read.json');
  assert.equal(isAbsolute(nativePath), true);
  await assert.rejects(
    loadAutomationSourceBindings(nativePath),
    /unsupported on Windows until ACL verification is available/u,
  );
});

test('Product authority derives URLs and credentials through Directory ports and asks ACL each poll', async () => {
  const bindings = decodeAutomationSourceBindings(config());
  const calls = { baseUrl: [], acl: [], bearer: [] };
  const authority = createProductObservationAuthority(bindings, {
    async baseUrlFor(binding, owner, signal) {
      calls.baseUrl.push({ binding, owner, aborted: signal.aborted });
      return 'https://yield.product.invalid';
    },
    async authorizeRead(owner, target, binding, profile, signal) {
      calls.acl.push({ owner, target, binding, profile, aborted: signal.aborted });
      return 'allowed';
    },
  }, {
    async bearerFor(owner, binding, signal) {
      calls.bearer.push({ owner, binding, aborted: signal.aborted });
      return 'opaque-server-bearer';
    },
  });
  const signal = new AbortController().signal;
  const target = { id: 'yield-run-lookup', kind: 'training_run', bindingId };
  const profile = await authority.resolveTarget(actorId, target, signal);
  assert.equal(profile?.baseUrl, 'https://yield.product.invalid');
  assert.equal(profile?.resourceId, resourceId);
  assert.equal(await authority.authorizeRead(actorId, target, profile, signal), 'allowed');
  assert.equal(await authority.bearerFor(actorId, profile, signal), 'opaque-server-bearer');
  assert.equal(calls.baseUrl.length, 1);
  assert.equal(calls.acl.length, 1);
  assert.equal(calls.bearer.length, 1);

  const otherActor = await authority.resolveTarget('different-owner', target, signal);
  assert.equal(otherActor, undefined);
});

test('host authority maps a fixed mount and requires per-actor ACL proof', async () => {
  const bindings = decodeAutomationSourceBindings(config());
  const calls = [];
  const authority = createHostObservationAuthority(bindings, {
    async authorizeRead(owner, target, binding, signal) {
      calls.push({ owner, target, binding, aborted: signal.aborted });
      return 'forbidden';
    },
  });
  const target = { id: 'vm-health-lookup', kind: 'host_health', bindingId: '30cf334d-6f8a-4fea-83df-fef89f8eb523' };
  const signal = new AbortController().signal;
  const profile = await authority.resolveTarget(actorId, target, signal);
  assert.equal(profile?.mountDirectory, '/run/synthetic-health');
  assert.equal(profile?.hostRef, 'synthetic-host');
  assert.equal(await authority.authorizeRead(actorId, target, profile, signal), 'forbidden');
  assert.equal(calls.length, 1);
  assert.equal(await authority.resolveTarget('other-owner', target, signal), undefined);
});

test('Planner target ID is an opaque lookup key, and current ACL callback remains mandatory', async () => {
  const bindings = decodeAutomationSourceBindings(config());
  const target = {
    id: 'planner-plan-lookup', kind: 'planner_plan', bindingId: '40cf334d-6f8a-4fea-83df-fef89f8eb523',
  };
  const resolved = resolvePlannerPlanBinding(bindings, actorId, target);
  assert.equal(resolved?.planId, 'plan-server-selected-id');
  assert.equal(resolvePlannerPlanBinding(bindings, actorId, { ...target, id: 'plan-server-selected-id' }), undefined);

  let calls = 0;
  const decision = await authorizePlannerPlanRead({
    async authorizeRead(owner, requested, binding, signal) {
      calls += 1;
      assert.equal(owner, actorId);
      assert.equal(requested.id, target.id);
      assert.equal(binding.planId, 'plan-server-selected-id');
      assert.equal(signal.aborted, false);
      return 'not_configured';
    },
  }, actorId, target, resolved, new AbortController().signal);
  assert.equal(decision, 'not_configured');
  assert.equal(calls, 1);
  assert.equal(await authorizePlannerPlanRead({
    async authorizeRead() { calls += 1; return 'allowed'; },
  }, actorId, target, undefined, new AbortController().signal), 'forbidden');
  assert.equal(calls, 1);
});
