// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Teams chat-only deployment tests                  │
// │ Role: Verify empty-tool production startup and preserved Teams auth. │
// │ 模块职责：验证无工具生产启动与 Teams 身份校验路径。                   │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { createExecutorApp } from '../dist/serve.js';
import { ExchangeConnectorAuthorizationClient } from '../dist/connector-authorization.js';
import { InMemoryWorkStateStore } from '../dist/work-state-client.js';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOT_APP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECRET = 'teams-chat-only-test-secret-0123456789';
const ENVIRONMENT_KEYS = [
  'NODE_ENV', 'TEAMS_ENABLED', 'TEAMS_CHAT_ONLY', 'CYRENE_TEAMS_CHAT_ONLY', 'TEAMS_NAVIGATOR_HMAC_KEY', 'TEAMS_TENANT_ID',
  'TEAMS_BOT_APP_ID', 'TEAMS_ALLOWED_TEAM_IDS', 'TEAMS_TASK_ACTOR_SUBJECTS',
  'CYRENE_EXCHANGE_CONNECTOR_INTERNAL_URL', 'NAVIGATOR_EXCHANGE_HMAC_KEY_FILE',
  'NAVIGATOR_EXCHANGE_HMAC_KEY_ID', 'TEAMS_EXCHANGE_CONNECTION_REF', 'TEAMS_EXCHANGE_PROFILE_REF',
  'CYRENE_WORKSPACE_ID', 'CYRENE_PERSISTENCE_URL', 'CYRENE_SESSION_TOKEN', 'CYRENE_EXECUTOR_TOKEN',
  'CYRENE_HARNESS_MODEL_SOURCE', 'CYRENE_HARNESS_MODEL', 'CYRENE_WORKFLOWS_ENABLED',
  'CYRENE_CONNECTOR_BINDINGS_FILE', 'CYRENE_CONNECTOR_TOOL_CATALOG_FILE',
  'CYRENE_EXCHANGE_INTEGRATION_URL', 'CYRENE_CLOUD_PROFILE_CONFIG', 'CYRENE_SUBAGENT_CONFIG',
  'NAVIGATOR_PLUGINS_DIR', 'DSH_HOME', 'CYRENE_EXECUTOR_MAX_CONCURRENT_TASKS',
  'CYRENE_EXCHANGE_URL', 'CYRENE_EXCHANGE_TOKEN', 'CYRENE_AUTHORITY_EXCHANGE_WORKLOAD_AUDIENCE',
  'TEAMS_TEST_HMAC_KEY', 'TEAMS_EXECUTOR_TOKEN',
];

class FixtureAdapter extends LlmAdapter {
  async *stream() {
    const text = 'Teams chat-only reply';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function withEnvironment(overrides, action) {
  const previous = new Map(ENVIRONMENT_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENVIRONMENT_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function makeProductionFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-teams-chat-only-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hmacKeyFile = join(directory, 'exchange-hmac.key');
  const connectorBindingsPath = join(directory, 'connector-bindings.json');
  const connectorToolCatalogPath = join(directory, 'connector-tool-catalog.json');
  await writeFile(hmacKeyFile, 'test-only-exchange-hmac-key');
  await writeFile(connectorBindingsPath, JSON.stringify({ schemaVersion: 1, bindings: [] }));
  await writeFile(connectorToolCatalogPath, JSON.stringify({ schemaVersion: 1, items: [] }));
  return { directory, hmacKeyFile, connectorBindingsPath, connectorToolCatalogPath };
}

function productionEnvironment(fixture, overrides = {}) {
  return {
    NODE_ENV: 'production',
    TEAMS_ENABLED: 'true',
    CYRENE_TEAMS_CHAT_ONLY: 'true',
    TEAMS_NAVIGATOR_HMAC_KEY: SECRET,
    TEAMS_TENANT_ID: TENANT_ID,
    TEAMS_BOT_APP_ID: BOT_APP_ID,
    TEAMS_ALLOWED_TEAM_IDS: 'team-1',
    TEAMS_TASK_ACTOR_SUBJECTS: OWNER_ID,
    CYRENE_EXCHANGE_CONNECTOR_INTERNAL_URL: 'http://127.0.0.1:9',
    NAVIGATOR_EXCHANGE_HMAC_KEY_FILE: fixture.hmacKeyFile,
    NAVIGATOR_EXCHANGE_HMAC_KEY_ID: 'teams-chat-only-test',
    TEAMS_EXCHANGE_CONNECTION_REF: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    TEAMS_EXCHANGE_PROFILE_REF: 'teams-chat-only-profile',
    CYRENE_WORKSPACE_ID: 'teams-chat-only-test',
    CYRENE_PERSISTENCE_URL: 'http://127.0.0.1:9',
    CYRENE_SESSION_TOKEN: 'teams-chat-only-session-token',
    CYRENE_HARNESS_MODEL_SOURCE: 'codebuddy',
    CYRENE_HARNESS_MODEL: 'glm-5.3-flash',
    CYRENE_WORKFLOWS_ENABLED: 'false',
    CYRENE_CONNECTOR_BINDINGS_FILE: fixture.connectorBindingsPath,
    CYRENE_CONNECTOR_TOOL_CATALOG_FILE: fixture.connectorToolCatalogPath,
    ...overrides,
  };
}

test('normal production Teams mode still requires a non-empty connector binding map', async t => {
  const fixture = await makeProductionFixture(t);
  const environment = productionEnvironment(fixture, { CYRENE_TEAMS_CHAT_ONLY: 'false' });
  await withEnvironment(environment, async () => {
    await assert.rejects(
      createExecutorApp(),
      /CYRENE_CONNECTOR_BINDINGS_FILE is required when Teams connector execution is enabled/u,
    );
  });
});

test('production chat-only mode starts with the real CodeBuddy adapter and exposes no tools', async t => {
  const fixture = await makeProductionFixture(t);
  let workStateReads = 0;
  const workStateServer = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/api/v1/workspaces/teams-chat-only-test/work/tasks')) {
      workStateReads += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: [], nextCursor: null }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'not_found' }));
  });
  await new Promise(resolve => workStateServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => workStateServer.close(resolve)));
  const address = workStateServer.address();
  assert.ok(address && typeof address === 'object');
  await withEnvironment(productionEnvironment(fixture, {
    CYRENE_PERSISTENCE_URL: `http://127.0.0.1:${address.port}`,
  }), async () => {
    const app = await createExecutorApp();
    try {
      await app.executor.startServer(0, '127.0.0.1');
      assert.deepEqual(app.ctx.tools.schemas(), []);
      assert.equal(workStateReads, 1);
      assert.deepEqual(app.ctx.get('agentDefaultModel').currentSelection(), {
        provider: 'codebuddy', model: 'glm-5.3-flash',
      });
      const prompt = renderPrompt(await app.ctx.systemPrompt.assemble());
      assert.match(prompt, /No external search, query, or action tools are available/u);
      assert.match(prompt, /Do not claim to have checked GitHub/u);
    } finally {
      await app.executor.dispose();
      await app.pluginManager.dispose();
      await app.ctx.fiber.dispose();
    }
  });
});

test('chat-only mode rejects any non-empty provider catalog or tool-enabling configuration', async t => {
  const fixture = await makeProductionFixture(t);
  const nonEmptyBindings = join(fixture.directory, 'non-empty-bindings.json');
  const nonEmptyCatalog = join(fixture.directory, 'non-empty-catalog.json');
  await writeFile(nonEmptyBindings, JSON.stringify({ schemaVersion: 1, bindings: [{
    bindingId: 'github-primary',
    connectionRef: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    providerId: 'github',
    profileRef: 'do-horizon',
    tools: [{
      toolId: 'github.repository.list',
      operationId: 'github.repository.list',
      resourceProjection: 'profile',
      mutating: false,
    }],
  }] }));
  await writeFile(nonEmptyCatalog, JSON.stringify({ schemaVersion: 1, items: [{}] }));

  const cases = [
    { name: 'connector bindings', environment: { CYRENE_CONNECTOR_BINDINGS_FILE: nonEmptyBindings }, options: {}, message: /empty connector binding map/u },
    { name: 'connector tool catalog', environment: { CYRENE_CONNECTOR_TOOL_CATALOG_FILE: nonEmptyCatalog }, options: {}, message: /empty connector tool catalog/u },
    { name: 'Exchange business tools', environment: {}, options: { exchangeIntegrationUrl: 'http://127.0.0.1:9' }, message: /disallows Exchange business tools/u },
    { name: 'cloud tools', environment: {}, options: { cloudConnectionConfigPath: '/not-read-in-chat-only-mode' }, message: /disallows cloud connection tools/u },
    { name: 'subagent tools', environment: {}, options: { subagentConfigPath: '/not-read-in-chat-only-mode' }, message: /disallows subagent tools/u },
    { name: 'dynamic plugins', environment: {}, options: { pluginsDir: '/not-loaded-in-chat-only-mode' }, message: /disallows configured dynamic plugins/u },
    { name: 'workflow tools', environment: {}, options: { enableWorkflows: true }, message: /disallows workflow tools/u },
  ];

  for (const item of cases) {
    await withEnvironment(productionEnvironment(fixture, item.environment), async () => {
      await assert.rejects(createExecutorApp(item.options), item.message, item.name);
    });
  }
});

test('chat-only mode keeps the authenticated Teams owner admission path', async () => {
  const store = new InMemoryWorkStateStore();
  const exchangeAuthorization = new ExchangeConnectorAuthorizationClient({
    baseUrl: 'http://127.0.0.1:1',
    hmacKeyFile: '/not-used-without-connector-tools',
    hmacKeyId: 'teams-chat-only-test',
    audience: 'exchange',
  });
  await withEnvironment({
    NODE_ENV: 'test',
    TEAMS_TEST_HMAC_KEY: SECRET,
    TEAMS_EXECUTOR_TOKEN: 'teams-chat-only-test-token',
    CYRENE_TEAMS_CHAT_ONLY: 'true',
  }, async () => {
    const app = await createExecutorApp({
      testMode: true,
      teamsChatOnly: true,
      authTokenEnv: 'TEAMS_EXECUTOR_TOKEN',
      customLlmAdapter: { provider: 'teams-chat-only-fixture', adapter: new FixtureAdapter() },
      model: 'fixture-v1',
      workStateStore: store,
      teams: {
        connectorId: 'teams-v1', tenantId: TENANT_ID,
        allowedTeamIds: ['team-1'], botAppId: BOT_APP_ID,
        taskActorSubjects: [OWNER_ID], ingressSecretEnv: 'TEAMS_TEST_HMAC_KEY',
        exchangeConnectionRef: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        exchangeProfileRef: 'teams-chat-only-profile', exchangeAuthorization,
      },
    });
    const server = await app.executor.startServer(0, '127.0.0.1');
    try {
      assert.deepEqual(app.ctx.tools.schemas(), []);

      const sendActivity = async (messageId, senderId) => {
        const activity = {
          event_type: 'inbound_message',
          payload: {
            message_id: messageId,
            conversation: { vendor: 'msteams', account_id: BOT_APP_ID, conversation_id: '19:chat-only', kind: 'channel' },
            sender_id: senderId,
            content: [
              { mention: { target: 'user', target_id: BOT_APP_ID, display_name: 'Cyrene' } },
              { text: { text: 'Please say hello.' } },
            ],
            vendor_extension: { vendor: 'msteams', facts: [
              { name: 'tenant_id', value: TENANT_ID },
              { name: 'team_id', value: 'team-1' },
              { name: 'channel_id', value: 'channel-1' },
            ] },
          },
          trust: {
            version: 1, provider: 'teams', tenant_id: TENANT_ID,
            actor_aad_object_id: senderId, team_id: 'team-1', channel_id: 'channel-1',
            root_thread_id: '1698765432100', message_id: messageId, bot_app_id: BOT_APP_ID,
            service_url: 'https://smba.trafficmanager.net/emea/',
          },
        };
        const body = JSON.stringify(activity);
        const timestamp = String(Math.floor(Date.now() / 1_000));
        const signature = createHmac('sha256', SECRET).update(`${timestamp}.`).update(body).digest('hex');
        return fetch(`${server.url}/internal/v1/connectors/teams/events`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-cyrene-source-key-id': 'teams-v1',
            'x-cyrene-source-timestamp': timestamp,
            'x-cyrene-source-signature': `v1=${signature}`,
          },
          body,
        });
      };

      const member = await sendActivity('member-message', MEMBER_ID);
      assert.equal(member.status, 202, await member.text());
      assert.equal((await store.listTasks()).items.length, 0);

      const owner = await sendActivity('owner-message', OWNER_ID);
      assert.equal(owner.status, 202, await owner.text());
      assert.equal((await store.listTasks()).items.length, 1);
    } finally {
      await app.executor.dispose();
      await app.pluginManager.dispose();
      await app.ctx.fiber.dispose();
    }
  });
});
