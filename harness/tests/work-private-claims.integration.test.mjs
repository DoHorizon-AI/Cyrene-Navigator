// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Work private Teams outbox contract integration             │
// │ Role: Verify the Harness client against the real local Work API.    │
// │ 模块职责：通过真实本地 Work API 验证私聊回执和路由契约。              │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WorkStateClient } from '../dist/work-state-client.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.CYRENE_TEST_PYTHON ?? join(repository, '.venv/bin/python');

async function startPrivateWorkService(directory, environment) {
  const configPath = join(directory, 'principals.json');
  const databasePath = join(directory, 'private-work.sqlite3');
  await writeFile(configPath, JSON.stringify({
    principals: [
      {
        token_env: 'PRIVATE_WORK_BRIDGE_TOKEN',
        actor_id: 'teams-v1',
        workspace_ids: ['private-workspace'],
        organization_id: 'private-org',
        can_bind_teams_private_conversations: true,
      },
      {
        token_env: 'PRIVATE_WORK_OWNER_TOKEN',
        actor_id: '11111111-1111-4111-8111-111111111111',
        workspace_ids: ['private-workspace'],
        organization_id: 'private-org',
        can_takeover: true,
        can_write_harness: true,
        actor_private_scope: true,
      },
    ],
    teams_private_conversations: {
      actor_subjects_file_env: 'TEAMS_TASK_ACTOR_SUBJECTS_FILE',
      workspace_id: 'private-workspace',
      issuer: 'https://login.microsoftonline.com/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/v2.0',
      tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      bot_app_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    },
  }), { mode: 0o600 });
  const child = spawn(python, [
    join(repository, 'scripts/serve-persistence.py'),
    '--database', databasePath,
    '--principal-config', configPath,
    '--host', '127.0.0.1',
    '--port', '0',
  ], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stderr.on('data', bytes => { logs = (logs + bytes).slice(-8_000); });
  const address = await new Promise((resolveAddress, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`Work service startup timed out: ${logs}`)), 15_000);
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Work service exited before readiness (${code}): ${logs}`));
    });
    child.stdout.on('data', bytes => {
      stdout += bytes;
      const end = stdout.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      try { resolveAddress(JSON.parse(stdout.slice(0, end))); }
      catch (error) { reject(error); }
    });
  });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/readyz`, { redirect: 'error' });
      if (response.ok) return { child, baseUrl };
    } catch { /* Uvicorn announces its socket before the readiness route is mounted. */ }
    await delay(20);
  }
  child.kill('SIGKILL');
  throw new Error(`Work service did not become ready: ${logs}`);
}

async function stopPrivateWorkService(service) {
  if (service.child.exitCode !== null || service.child.signalCode !== null) return;
  const exited = once(service.child, 'exit');
  service.child.kill('SIGTERM');
  const timer = setTimeout(() => service.child.kill('SIGKILL'), 2_000);
  try { await exited; } finally { clearTimeout(timer); }
}

test('real Work API private admission and terminal result return the host route on the claim envelope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navigator-private-work-service-'));
  const actorId = '11111111-1111-4111-8111-111111111111';
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const botAppId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const bridgeToken = 'private-work-bridge-token-0123456789abcdef';
  const actorToken = 'private-work-actor-token-0123456789abcdef';
  const previousCredentials = new Map([
    ['PRIVATE_WORK_BRIDGE_TOKEN', process.env.PRIVATE_WORK_BRIDGE_TOKEN],
    ['PRIVATE_WORK_OWNER_TOKEN', process.env.PRIVATE_WORK_OWNER_TOKEN],
  ]);
  const actorSubjectsPath = join(directory, 'subjects.json');
  await writeFile(actorSubjectsPath, JSON.stringify({
    schemaVersion: 1, workspaceId: 'private-workspace', issuer, subjects: [actorId],
  }), { mode: 0o600 });
  const service = await startPrivateWorkService(directory, {
    ...process.env,
    PRIVATE_WORK_BRIDGE_TOKEN: bridgeToken,
    PRIVATE_WORK_OWNER_TOKEN: actorToken,
    TEAMS_TASK_ACTOR_SUBJECTS_FILE: actorSubjectsPath,
  });
  try {
    process.env.PRIVATE_WORK_BRIDGE_TOKEN = bridgeToken;
    process.env.PRIVATE_WORK_OWNER_TOKEN = actorToken;
    const bridge = new WorkStateClient({
      baseUrl: service.baseUrl,
      workspaceId: 'private-workspace',
      tokenEnv: 'PRIVATE_WORK_BRIDGE_TOKEN',
      privateBridgeTokenEnv: 'PRIVATE_WORK_BRIDGE_TOKEN',
    });
    const owner = new WorkStateClient({
      baseUrl: service.baseUrl,
      workspaceId: 'private-workspace',
      tokenEnv: 'PRIVATE_WORK_OWNER_TOKEN',
      privateBridgeTokenEnv: 'PRIVATE_WORK_BRIDGE_TOKEN',
    });
    const installEvent = {
      eventType: 'personal_installation',
      payload: { action: 'add' },
      trust: {
        version: 1,
        provider: 'teams',
        conversationKind: 'private',
        installationAction: 'add',
        tenantId,
        actorAadObjectId: actorId,
        botAppId,
        conversationId: '19:private-route-integration',
        activityId: 'install-activity-1',
        // Microsoft Activity timestamps commonly have millisecond precision.
        activityOccurredAt: '2026-10-27T12:00:00.123Z',
        serviceUrl: 'https://smba.trafficmanager.net/emea/',
      },
    };
    const installation = await bridge.registerTeamsPrivateInstallation(installEvent);
    assert.deepEqual({
      action: installation.action, active: installation.active,
      applied: installation.applied, duplicate: installation.duplicate,
    }, {
      action: 'add', active: true, applied: true, duplicate: false,
    });
    const replayedInstallation = await bridge.registerTeamsPrivateInstallation(installEvent);
    assert.deepEqual({
      action: replayedInstallation.action, active: replayedInstallation.active,
      applied: replayedInstallation.applied, duplicate: replayedInstallation.duplicate,
    }, {
      action: 'add', active: true, applied: true, duplicate: true,
    });
    const staleRemoval = await bridge.registerTeamsPrivateInstallation({
      ...installEvent,
      payload: { action: 'remove' },
      trust: {
        ...installEvent.trust,
        installationAction: 'remove',
        activityId: 'install-activity-stale-remove',
        activityOccurredAt: '2026-10-27T11:00:00.123Z',
      },
    });
    assert.deepEqual({ active: staleRemoval.active, applied: staleRemoval.applied, duplicate: staleRemoval.duplicate }, {
      active: true, applied: false, duplicate: false,
    });

    const text = 'Inspect the deployment and return the private result.';
    const admission = await owner.registerConnectorEvent({
      connectorId: 'teams-v1',
      messageId: 'private-message-1',
      type: 'message.received',
      payload: { provider: 'teams', messageId: 'private-message-1', text },
      teamsPrivateMessage: { messageId: 'private-message-1', text },
      task: {
        id: 'teams-private-integration-task',
        sessionId: 'teams-private-integration-session',
        prompt: text,
        metadata: {
          teamsCaller: { subject: 'forged-subject' },
          notification: { recipient: 'teams:forged-channel' },
        },
      },
    });
    assert.ok(admission.task);
    assert.equal(admission.task.createdByActorId, actorId);
    assert.deepEqual(admission.task.metadata, {});
    assert.deepEqual(admission.task.origin, {
      kind: 'teams_private', messageId: 'private-message-1', tenantId, botAppId, actorAadObjectId: actorId,
    });

    const acknowledge = await bridge.claimPrivateNotifications({
      workerId: 'navigator-private-integration', limit: 10, leaseSeconds: 60,
      type: 'teams.message', connectorId: 'teams-v1',
    });
    assert.equal(acknowledge.length, 1);
    assert.match(acknowledge[0].notification.payload.text, /^Request received\./u);
    assert.deepEqual(acknowledge[0].teamsPersonalRoute, {
      kind: 'teams_personal', tenantId, botAppId, actorAadObjectId: actorId,
      conversationId: '19:private-route-integration', serviceUrl: 'https://smba.trafficmanager.net/emea/',
    });
    assert.equal(acknowledge[0].notification.teamsPersonalRoute, undefined);
    await bridge.startPrivateNotification(acknowledge[0].notification.id, acknowledge[0].leaseToken);
    await bridge.finishPrivateNotification(
      acknowledge[0].notification.id, acknowledge[0].leaseToken, 'delivered', { outcome: 'accepted' },
    );

    const claimedTask = await owner.claimTask(admission.task.id);
    assert.equal(claimedTask.claimed, true);
    const completed = await owner.patchTask(admission.task.id, {
      status: 'completed', output: 'Private result from the real Work Task.',
    });
    assert.equal(completed.status, 'completed');

    const terminal = await bridge.claimPrivateNotifications({
      workerId: 'navigator-private-integration', limit: 10, leaseSeconds: 60,
      type: 'teams.message', connectorId: 'teams-v1',
    });
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].notification.payload.text, 'Private result from the real Work Task.');
    assert.deepEqual(terminal[0].teamsPersonalRoute, acknowledge[0].teamsPersonalRoute);
    assert.equal(terminal[0].notification.teamsPersonalRoute, undefined);
  } finally {
    await stopPrivateWorkService(service);
    await rm(directory, { recursive: true, force: true });
    for (const [name, value] of previousCredentials) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
