// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 codebuddy-acp-config.test.mjs                                   │
// │  Module: harness/tests/codebuddy-acp-config                         │
// │  Role: Verify explicit ACP selection without the DSH model loop.     │
// │                                                                      │
// │  模块职责：验证 ACP 显式选择与 DSH 模型/AgentLoop 解耦。              │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createExecutorApp, currentResponsibilityModelPolicy, resolveExecutionBackend } from '../dist/serve.js';
import { InMemoryWorkStateStore } from '../dist/work-state-client.js';

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
