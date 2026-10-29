// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 codebuddy-acp-config.test.mjs                                   │
// │  Module: harness/tests/codebuddy-acp-config                         │
// │  Role: Verify explicit ACP selection without the DSH model loop.     │
// │                                                                      │
// │  模块职责：验证 ACP 显式选择与 DSH 模型/AgentLoop 解耦。              │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createExecutorApp, currentResponsibilityModelPolicy, resolveExecutionBackend } from '../dist/serve.js';
import { InMemoryWorkStateStore } from '../dist/work-state-client.js';

const PILOT_OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PILOT_MEMBER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PILOT_TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PILOT_BOT_APP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PILOT_WORKSPACE_ID = 'navigator-pilot-workspace';
const PILOT_INGRESS_SECRET = 'pilot-teams-ingress-hmac-key-0123456789abcdef';

const PILOT_ENVIRONMENT_NAMES = [
  'CYRENE_WORK_ACTOR_TOKEN_MAP_FILE', 'CYRENE_SESSION_TOKEN', 'CYRENE_EXECUTOR_TOKEN',
  'CYRENE_PERSISTENCE_URL', 'CYRENE_WORKSPACE_ID', 'CYRENE_TEAMS_MODEL_ACTOR_SUBJECT',
  'TEAMS_ENABLED', 'TEAMS_NAVIGATOR_HMAC_KEY', 'TEAMS_TENANT_ID', 'TEAMS_BOT_APP_ID',
  'TEAMS_ALLOWED_TEAM_IDS', 'TEAMS_TASK_ACTOR_SUBJECTS_FILE', 'CYRENE_TEAMS_PERSONAL_CHAT_ENABLED',
  'CYRENE_EXCHANGE_CONNECTOR_INTERNAL_URL', 'NAVIGATOR_EXCHANGE_HMAC_KEY_FILE',
  'NAVIGATOR_EXCHANGE_HMAC_KEY_ID', 'TEAMS_EXCHANGE_CONNECTION_REF', 'TEAMS_EXCHANGE_PROFILE_REF',
  'CYRENE_HARNESS_EXECUTION_BACKEND', 'CYRENE_HARNESS_MODEL_SOURCE', 'CYRENE_HARNESS_MODEL',
  'CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP', 'CYRENE_HARNESS_CODEBUDDY_FALLBACK_ENABLED',
  'CYRENE_HARNESS_CODEBUDDY_ACP_COMMAND', 'CYRENE_HARNESS_CODEBUDDY_ACP_MODEL',
  'CYRENE_WORKFLOWS_ENABLED', 'NAVIGATOR_PLUGINS_DIR', 'DSH_HOME',
  'PILOT_OWNER_WORK_TOKEN', 'PILOT_MEMBER_WORK_TOKEN',
];

async function withPilotEnvironment(overrides, action) {
  const previous = new Map(PILOT_ENVIRONMENT_NAMES.map(name => [name, process.env[name]]));
  for (const name of PILOT_ENVIRONMENT_NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function privatePilotActivity(actorId, messageId) {
  return {
    event_type: 'inbound_message',
    payload: {
      message_id: messageId,
      conversation: {
        vendor: 'msteams', account_id: PILOT_BOT_APP_ID,
        conversation_id: `19:private-${actorId}`, kind: 'private',
      },
      sender_id: actorId,
      content: [{ text: { text: 'Please check the current development status.' } }],
      vendor_extension: { vendor: 'msteams', facts: [{ name: 'tenant_id', value: PILOT_TENANT_ID }] },
    },
    trust: {
      version: 1,
      provider: 'teams',
      tenant_id: PILOT_TENANT_ID,
      actor_aad_object_id: actorId,
      message_id: messageId,
      bot_app_id: PILOT_BOT_APP_ID,
      service_url: 'https://smba.trafficmanager.net/emea/',
      conversation_kind: 'private',
      conversation_id: `19:private-${actorId}`,
    },
  };
}

async function postSignedPilotActivity(baseUrl, activity) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const body = JSON.stringify(activity);
  const signature = createHmac('sha256', PILOT_INGRESS_SECRET)
    .update(`${timestamp}.`, 'utf8').update(body).digest('hex');
  return fetch(`${baseUrl}/internal/v1/connectors/teams/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cyrene-source-key-id': 'teams-v1',
      'x-cyrene-source-timestamp': timestamp,
      'x-cyrene-source-signature': `v1=${signature}`,
    },
    body,
  });
}

test('ACP backend is explicit, ignores empty legacy model selectors, and does not install the DSH loop', async () => {
  assert.equal(resolveExecutionBackend(undefined, false, undefined), 'dsh');
  assert.equal(resolveExecutionBackend(undefined, false, 'codebuddy-acp'), 'codebuddy-acp');
  assert.equal(resolveExecutionBackend(undefined, false, ''), 'dsh');
  assert.throws(() => resolveExecutionBackend(undefined, false, 'unexpected'), /must be dsh or codebuddy-acp/u);
  assert.deepEqual(currentResponsibilityModelPolicy(new Context(), 'deepseek-v4.1-flash'), {
    preferredProvider: 'codebuddy',
    preferredModel: 'deepseek-v4.1-flash',
    fallback: 'configured_no_additional_spend',
  });

  const names = [
    'CYRENE_HARNESS_EXECUTION_BACKEND', 'CYRENE_HARNESS_MODEL_SOURCE', 'CYRENE_HARNESS_MODEL',
    'CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP', 'CYRENE_HARNESS_CODEBUDDY_FALLBACK_ENABLED',
    'CYRENE_HARNESS_CODEBUDDY_FALLBACK_MODEL', 'CYRENE_HARNESS_CODEBUDDY_ACP_COMMAND',
    'CYRENE_HARNESS_CODEBUDDY_ACP_MODEL', 'CYRENE_PERSISTENCE_URL', 'CYRENE_WORKSPACE_ID',
    'CYRENE_SESSION_TOKEN', 'CYRENE_EXECUTOR_TOKEN', 'TEAMS_ENABLED', 'TEAMS_CHAT_ONLY',
    'CYRENE_TEAMS_CHAT_ONLY', 'CYRENE_SUBAGENT_CONFIG', 'CYRENE_CLOUD_PROFILE_CONFIG',
    'CYRENE_CONNECTOR_BINDINGS_FILE', 'CYRENE_CONNECTOR_TOOL_CATALOG_FILE',
    'CYRENE_EXCHANGE_INTEGRATION_URL', 'CYRENE_WORKFLOWS_ENABLED',
  ];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  const pluginsDir = await mkdtemp(join(tmpdir(), 'navigator-acp-config-test-'));
  for (const name of names) {
    if (!['CYRENE_HARNESS_EXECUTION_BACKEND', 'CYRENE_HARNESS_MODEL_SOURCE', 'CYRENE_HARNESS_MODEL',
      'CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP', 'CYRENE_HARNESS_CODEBUDDY_FALLBACK_ENABLED',
      'CYRENE_HARNESS_CODEBUDDY_ACP_MODEL'].includes(name)) delete process.env[name];
  }
  process.env.CYRENE_HARNESS_EXECUTION_BACKEND = 'codebuddy-acp';
  process.env.CYRENE_HARNESS_MODEL_SOURCE = '';
  process.env.CYRENE_HARNESS_MODEL = '';
  process.env.CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP = 'true';
  process.env.CYRENE_HARNESS_CODEBUDDY_FALLBACK_ENABLED = 'false';
  process.env.CYRENE_HARNESS_CODEBUDDY_ACP_MODEL = 'deepseek-v4.1-flash';

  let app;
  try {
    app = await createExecutorApp({
      testMode: true,
      authTokenEnv: 'CYRENE_EXECUTOR_TOKEN',
      workStateStore: new InMemoryWorkStateStore(),
      pluginsDir,
      watchPlugins: false,
      enableWorkflows: false,
    });
    assert.equal(app.ctx.get('llm'), undefined);
    assert.equal(app.ctx.get('agentLoop'), undefined);
    assert.equal(app.ctx.get('agentDefaultModel'), undefined);
    assert.equal(app.executor.config.conversationBackend.name, 'codebuddy-acp');
  } finally {
    if (app) {
      await app.executor.dispose();
      await app.pluginManager?.dispose();
      await app.ctx.fiber.dispose();
    }
    await rm(pluginsDir, { recursive: true, force: true });
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('pilot restart omits a revoked actor credential while the explicit owner model selector stays fail-closed', {
  skip: process.platform === 'win32'
    ? 'Private actor Work credentials require POSIX UID/mode verification until Windows ACL verification is implemented.'
    : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navigator-pilot-revocation-'));
  const actorMapPath = join(directory, 'work-actors.json');
  const actorSubjectsPath = join(directory, 'teams-actors.json');
  const exchangeKeyPath = join(directory, 'exchange.key');
  const issuer = `https://login.microsoftonline.com/${PILOT_TENANT_ID}/v2.0`;
  const ownerToken = 'pilot-owner-work-token-0123456789abcdef';
  const memberToken = 'pilot-member-work-token-0123456789abcdef';
  const workRequests = [];
  const workServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const entry = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      ...(bodyText ? { body: JSON.parse(bodyText) } : {}),
    };
    workRequests.push(entry);
    if (request.method === 'GET' && request.url?.endsWith('/work/tool-providers')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: [] }));
      return;
    }
    if (request.method === 'GET' && request.url?.includes('/work/tasks/owned')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: [], nextCursor: null }));
      return;
    }
    if (request.method === 'POST' && request.url?.endsWith('/work/connectors/teams-v1/events')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ eventId: 'deduped-pilot-event', duplicate: true, receivedAt: Date.now() }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'PILOT_TEST_ROUTE_NOT_FOUND' }));
  });
  await new Promise(resolve => workServer.listen(0, '127.0.0.1', resolve));
  const address = workServer.address();
  assert.ok(address && typeof address === 'object');
  const persistenceUrl = `http://127.0.0.1:${address.port}`;
  let app;
  let listener;
  const closeApp = async () => {
    if (app !== undefined) {
      await app.executor.dispose();
      await app.pluginManager?.dispose();
      await app.ctx.fiber.dispose();
      app = undefined;
    }
    listener = undefined;
  };

  try {
    await writeFile(actorMapPath, JSON.stringify({
      schemaVersion: 1,
      workspaceId: PILOT_WORKSPACE_ID,
      actors: [
        { actorAadObjectId: PILOT_OWNER_ID, tokenEnv: 'PILOT_OWNER_WORK_TOKEN' },
        { actorAadObjectId: PILOT_MEMBER_ID, tokenEnv: 'PILOT_MEMBER_WORK_TOKEN' },
      ],
    }), { mode: 0o600 });
    await writeFile(actorSubjectsPath, JSON.stringify({
      schemaVersion: 1, workspaceId: PILOT_WORKSPACE_ID, issuer, subjects: [PILOT_OWNER_ID, PILOT_MEMBER_ID],
    }), { mode: 0o600 });
    await writeFile(exchangeKeyPath, Buffer.alloc(32, 0x5a), { mode: 0o600 });

    await withPilotEnvironment({
      CYRENE_WORK_ACTOR_TOKEN_MAP_FILE: actorMapPath,
      CYRENE_SESSION_TOKEN: 'pilot-global-session-token-0123456789',
      CYRENE_PERSISTENCE_URL: persistenceUrl,
      CYRENE_WORKSPACE_ID: PILOT_WORKSPACE_ID,
      CYRENE_TEAMS_MODEL_ACTOR_SUBJECT: PILOT_OWNER_ID,
      TEAMS_ENABLED: 'true',
      TEAMS_NAVIGATOR_HMAC_KEY: PILOT_INGRESS_SECRET,
      TEAMS_TENANT_ID: PILOT_TENANT_ID,
      TEAMS_BOT_APP_ID: PILOT_BOT_APP_ID,
      TEAMS_ALLOWED_TEAM_IDS: 'pilot-team',
      TEAMS_TASK_ACTOR_SUBJECTS_FILE: actorSubjectsPath,
      CYRENE_TEAMS_PERSONAL_CHAT_ENABLED: 'true',
      CYRENE_EXCHANGE_CONNECTOR_INTERNAL_URL: 'http://127.0.0.1:9',
      NAVIGATOR_EXCHANGE_HMAC_KEY_FILE: exchangeKeyPath,
      NAVIGATOR_EXCHANGE_HMAC_KEY_ID: 'pilot-auth-test',
      TEAMS_EXCHANGE_CONNECTION_REF: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      TEAMS_EXCHANGE_PROFILE_REF: 'pilot-teams-profile',
      CYRENE_HARNESS_MODEL_SOURCE: '',
      CYRENE_HARNESS_MODEL: '',
      CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP: 'true',
      CYRENE_HARNESS_CODEBUDDY_FALLBACK_ENABLED: 'false',
      CYRENE_HARNESS_CODEBUDDY_ACP_MODEL: 'deepseek-v4.1-flash',
      PILOT_OWNER_WORK_TOKEN: ownerToken,
      PILOT_MEMBER_WORK_TOKEN: memberToken,
    }, async () => {
      const startApp = async () => {
        app = await createExecutorApp({
          testMode: true,
          authTokenEnv: 'CYRENE_EXECUTOR_TOKEN',
          executionBackend: 'codebuddy-acp',
          persistenceUrl,
          workspaceId: PILOT_WORKSPACE_ID,
          pluginsDir: directory,
          watchPlugins: false,
        });
        listener = await app.executor.startServer(0, '127.0.0.1');
        return listener.url;
      };

      const firstUrl = await startApp();
      assert.deepEqual(app.executor.config.workActorClients.actorIds(), [PILOT_OWNER_ID, PILOT_MEMBER_ID]);
      assert.equal(app.executor.config.teams.modelActorSubject, PILOT_OWNER_ID,
        'the configured owner selector is the only source of free-form ACP entitlement');

      await writeFile(actorSubjectsPath, JSON.stringify({
        schemaVersion: 1, workspaceId: PILOT_WORKSPACE_ID, issuer, subjects: [PILOT_OWNER_ID],
      }), { mode: 0o600 });
      const requestCountBeforeRevokedActor = workRequests.length;
      const liveRevoked = await postSignedPilotActivity(firstUrl, privatePilotActivity(PILOT_MEMBER_ID, 'pilot-revoked-live'));
      assert.equal(liveRevoked.status, 403, await liveRevoked.text());
      assert.equal(workRequests.slice(requestCountBeforeRevokedActor).some(item =>
        item.method === 'POST' && item.url?.endsWith('/work/connectors/teams-v1/events')),
      false, 'live Directory revocation is checked before a private task reaches Work');

      await closeApp();
      delete process.env.PILOT_MEMBER_WORK_TOKEN;
      workRequests.length = 0;
      const restartedUrl = await startApp();
      assert.deepEqual(app.executor.config.workActorClients.actorIds(), [PILOT_OWNER_ID],
        'restart keeps the remaining Directory-authorized actor and excludes the revoked token slot');
      assert.deepEqual(workRequests.filter(item => item.method === 'GET'
        && item.url?.includes('/work/tasks/owned')).map(item => item.authorization), [
        `Bearer ${ownerToken}`,
      ], 'recovery queries only the remaining actor credential');

      const restartRevoked = await postSignedPilotActivity(
        restartedUrl, privatePilotActivity(PILOT_MEMBER_ID, 'pilot-revoked-after-restart'),
      );
      assert.equal(restartRevoked.status, 403, await restartRevoked.text());
      const beforeOwnerAdmission = workRequests.length;
      const ownerAdmission = await postSignedPilotActivity(
        restartedUrl, privatePilotActivity(PILOT_OWNER_ID, 'pilot-owner-after-restart'),
      );
      assert.equal(ownerAdmission.status, 200, await ownerAdmission.text());
      const ownerWorkRequest = workRequests.slice(beforeOwnerAdmission).find(item =>
        item.method === 'POST' && item.url?.endsWith('/work/connectors/teams-v1/events'));
      assert.equal(ownerWorkRequest?.authorization, `Bearer ${ownerToken}`,
        'the remaining authorized owner still reaches Work through the owner-scoped credential');

      await closeApp();
      delete process.env.CYRENE_TEAMS_MODEL_ACTOR_SUBJECT;
      workRequests.length = 0;
      const noSelectorUrl = await startApp();
      const ownerWithoutSelector = await postSignedPilotActivity(
        noSelectorUrl, privatePilotActivity(PILOT_OWNER_ID, 'pilot-no-model-selector'),
      );
      assert.equal(ownerWithoutSelector.status, 403, await ownerWithoutSelector.text());
      assert.equal(workRequests.some(item => item.method === 'POST'
        && item.url?.endsWith('/work/connectors/teams-v1/events')), false,
      'a sole remaining actor does not gain model entitlement when the explicit selector is absent');
    });
  } finally {
    await closeApp();
    await new Promise(resolve => workServer.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
