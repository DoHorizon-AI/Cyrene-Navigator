// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 antigravity-acp-execution.integration.test.mjs                  │
// │  Module: harness/tests/antigravity-acp-execution                    │
// │  Role: Verify isolated official-ACP task/session/tool boundaries.   │
// │                                                                      │
// │  模块职责：验证 Antigravity ACP profile、模型回读、MCP 权限和续接。  │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import {
  chmodSync,
  chownSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import CyreneSessionPersistence from '../dist/persistence.js';
import { AntigravityAcpExecutionBackend } from '../dist/antigravity-acp-execution.js';
import { InMemoryWorkStateStore } from '../dist/work-state-client.js';

const directory = dirname(fileURLToPath(import.meta.url));
const stubCommand = resolve(directory, 'fixtures/antigravity-acp-stub.mjs');
const nativeSessionId = 'work-session-antigravity-acp-fixture';
const selectedModel = 'gemini-test-native';
const environmentNames = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'CODEBUDDY_API_KEY', 'CYRENE_SESSION_TOKEN',
  'CYRENE_HARNESS_ANTIGRAVITY_ACP_COMMAND', 'CYRENE_HARNESS_ANTIGRAVITY_ACP_MODEL',
  'CYRENE_HARNESS_ANTIGRAVITY_ACP_PROFILE',
];

function backendOptions(ctx, workState, profileRoot, mode = 'authorized', model = selectedModel) {
  return {
    ctx,
    workState,
    command: process.execPath,
    profileRoot,
    ...(model === null ? {} : { model }),
    commandArgsPrefix: [
      stubCommand,
      '--fixture-mode', mode,
      '--fixture-selected-model', selectedModel,
    ],
    startupTimeoutMs: 2_000,
    turnTimeoutMs: 2_000,
    disposeGraceMs: 1_000,
    mcpCloseGraceMs: 1_000,
  };
}

async function createHarness() {
  const profileRoot = mkdtempSync(join(tmpdir(), 'navigator-antigravity-acp-profile-'));
  chmodSync(profileRoot, 0o700);
  const ctx = new Context();
  await ctx.plugin(LocalSubprocessRuntime);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(CyreneSessionPersistence, {
    baseUrl: 'http://127.0.0.1:1',
    workspaceId: 'antigravity-acp-fixture',
    tokenEnv: 'NAVIGATOR_TEST_SESSION_TOKEN_MISSING',
    clientId: 'antigravity-acp-fixture',
    heartbeatMs: 15_000,
    batchDelayMs: 0,
    maxPendingEvents: 8,
    batchSize: 4,
  });

  let toolExecutions = 0;
  const unregisterTool = ctx.tools.register({
    name: 'exchange_issue_query',
    description: 'Query one authorized Exchange issue.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: { type: 'object', additionalProperties: true } },
          structuredContent: {},
        },
        required: ['content'],
        additionalProperties: false,
      },
      render: (_arguments, value) => [{ type: 'text', text: value.content[0].text }],
    },
    async execute(_arguments, execution) {
      assert.equal(execution.agent?.navigatorExecutionBackend, 'antigravity-acp',
        'native Antigravity tools must cross the persistence hook as their own backend');
      toolExecutions += 1;
      return { content: [{ type: 'text', text: 'Authorized Exchange result.' }] };
    },
  });
  const workState = new InMemoryWorkStateStore();
  return {
    ctx, workState, profileRoot, unregisterTool,
    get toolExecutions() { return toolExecutions; },
  };
}

async function startTask(workState, taskId, sessionId = nativeSessionId) {
  await workState.createTask({ id: taskId, sessionId, prompt: 'Use the native ACP session.' });
  await workState.claimTask(taskId);
}

async function execute(backend, workState, taskId, controller = new AbortController(), onText = () => {}) {
  await startTask(workState, taskId);
  return backend.execute({
    taskId,
    sessionId: nativeSessionId,
    prompt: 'Query the requested issue through the available Navigator tool.',
    signal: controller.signal,
    authorizationPauseSignal: new AbortController().signal,
    readOnly: false,
    onText,
  });
}

async function disposeHarness(harness) {
  try {
    harness.unregisterTool();
    await harness.ctx.fiber.dispose();
  } finally {
    rmSync(harness.profileRoot, { recursive: true, force: true });
  }
}

test('Antigravity ACP resumes the Work-bound native session and authorizes only provider-identified catalog MCP once', async () => {
  const previous = new Map(environmentNames.map(name => [name, process.env[name]]));
  process.env.GEMINI_API_KEY = 'must-not-reach-antigravity-child';
  process.env.GOOGLE_API_KEY = 'must-not-reach-antigravity-child';
  process.env.CODEBUDDY_API_KEY = 'must-not-reach-antigravity-child';
  process.env.CYRENE_SESSION_TOKEN = 'must-not-reach-antigravity-child';
  const harness = await createHarness();
  const xdgLocalRoot = join(harness.profileRoot, '.local');
  if (process.platform !== 'win32') {
    mkdirSync(xdgLocalRoot, { mode: 0o775 });
    chmodSync(xdgLocalRoot, 0o775);
  }
  try {
    const firstBackend = new AntigravityAcpExecutionBackend(
      backendOptions(harness.ctx, harness.workState, harness.profileRoot),
    );
    const firstEvents = [];
    const first = await execute(firstBackend, harness.workState, 'teams-antigravity-acp-task-1', undefined, text => {
      firstEvents.push(text);
    });
    assert.equal(first.stopReason, 'end_turn');
    assert.equal(first.nativeSessionId, 'native-antigravity-session-1');
    assert.match(first.output, /NATIVE_MCP_RESULT:Authorized Exchange result\./u);
    assert.match(first.output, /ISOLATED:true/u);
    if (process.platform !== 'win32') {
      assert.equal(statSync(xdgLocalRoot).mode & 0o777, 0o775,
        'an owner-owned XDG directory under the 0700 profile root is accepted without chmod');
    }
    assert.equal(harness.toolExecutions, 1, 'only the exact approved MCP call reaches the registered tool');

    const firstEventsPage = await harness.workState.getEvents('teams-antigravity-acp-task-1');
    const permissionEvents = firstEventsPage.events.map(row => row.event)
      .filter(event => event.type === 'execution.acp_permission_request');
    assert.equal(permissionEvents.length, 1, 'only one safe permission summary is retained per Work task');
    assert.deepEqual(permissionEvents[0], {
      type: 'execution.acp_permission_request',
      diagnosticVersion: 1,
      backend: 'antigravity-acp',
      method: 'session/request_permission',
      kind: 'other',
      serverName: 'navigator',
      toolName: 'catalog_match',
      identitySource: 'none',
      catalogAvailable: true,
      optionKinds: { allow_once: true, reject_once: true, otherCount: 1 },
      decision: 'reject_once',
    });
    for (const untrusted of ['exchange_issue_query', 'not_in_catalog', 'NAVIGATOR_ACP_BRIDGE_TOKEN', 'must-not-reach-antigravity-child']) {
      assert.equal(JSON.stringify(permissionEvents).includes(untrusted), false,
        'permission diagnostics must omit tool names, arguments, and credential material');
    }
    assert.ok(firstEvents.some(text => text.includes('NATIVE_MCP_RESULT')));

    const antigravityMapping = await harness.workState.getBackendSession('teams-antigravity-acp-task-1', 'antigravity-acp');
    assert.deepEqual(antigravityMapping, {
      backend: 'antigravity-acp', sessionId: nativeSessionId, nativeSessionId: first.nativeSessionId,
    });
    await harness.workState.bindBackendSession('teams-antigravity-acp-task-1', 'native-codebuddy-session', 'codebuddy-acp');
    assert.equal((await harness.workState.getBackendSession('teams-antigravity-acp-task-1', 'codebuddy-acp'))?.nativeSessionId,
      'native-codebuddy-session');
    assert.equal((await harness.workState.getBackendSession('teams-antigravity-acp-task-1', 'antigravity-acp'))?.nativeSessionId,
      first.nativeSessionId, 'the backends keep separate session identities for one Work session');

    const restartedBackend = new AntigravityAcpExecutionBackend(
      backendOptions(harness.ctx, harness.workState, harness.profileRoot, 'resume'),
    );
    const second = await execute(restartedBackend, harness.workState, 'teams-antigravity-acp-task-2');
    assert.equal(second.nativeSessionId, first.nativeSessionId);
    assert.match(second.output, /RESTORED_NATIVE_SESSION/u,
      'a fresh backend instance loads the exact Work-bound native Antigravity session');
    assert.equal(harness.toolExecutions, 1, 'session restore does not replay the completed MCP call');
  } finally {
    await disposeHarness(harness);
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('Antigravity ACP rejects unavailable model IDs before sending a prompt', async () => {
  const harness = await createHarness();
  let output = '';
  try {
    const backend = new AntigravityAcpExecutionBackend(
      backendOptions(harness.ctx, harness.workState, harness.profileRoot, 'authorized', 'not-advertised'),
    );
    await assert.rejects(execute(backend, harness.workState, 'teams-antigravity-unavailable-model'),
      /NATIVE_MODEL_UNAVAILABLE/u);
    assert.equal(output, '', 'an unadvertised model fails before prompt execution');
    assert.equal(harness.toolExecutions, 0);
  } finally {
    await disposeHarness(harness);
  }
});

test('Antigravity ACP fails when the native session silently changes its selected model', async () => {
  const harness = await createHarness();
  try {
    const backend = new AntigravityAcpExecutionBackend(
      backendOptions(harness.ctx, harness.workState, harness.profileRoot, 'model-drift'),
    );
    await assert.rejects(execute(backend, harness.workState, 'teams-antigravity-model-drift'),
      /NATIVE_MODEL_CHANGED/u);
    assert.equal(harness.toolExecutions, 0);
  } finally {
    await disposeHarness(harness);
  }
});

test('Antigravity ACP retains partial output and reports token-limit termination as failure', async () => {
  const harness = await createHarness();
  let output = '';
  try {
    const backend = new AntigravityAcpExecutionBackend(
      backendOptions(harness.ctx, harness.workState, harness.profileRoot, 'partial'),
    );
    await assert.rejects(execute(backend, harness.workState, 'teams-antigravity-partial', undefined, text => { output += text; }),
      /NATIVE_STOP_MAX_TOKENS/u);
    assert.equal(output, 'PARTIAL_NATIVE_OUTPUT');
    assert.equal(harness.toolExecutions, 0);
  } finally {
    await disposeHarness(harness);
  }
});

test('Antigravity ACP forwards cancellation to the native turn and reaps its task resources', async () => {
  const harness = await createHarness();
  const controller = new AbortController();
  let output = '';
  try {
    const backend = new AntigravityAcpExecutionBackend(
      backendOptions(harness.ctx, harness.workState, harness.profileRoot, 'cancel'),
    );
    await assert.rejects(execute(backend, harness.workState, 'teams-antigravity-cancel', controller, text => {
      output += text;
      if (text === 'READY_FOR_CANCEL') controller.abort(new Error('fixture cancellation'));
    }), /TASK_ABORTED|cancelled/iu);
    assert.equal(output, 'READY_FOR_CANCEL');
    assert.equal(harness.toolExecutions, 0);
  } finally {
    await disposeHarness(harness);
  }
});

test('Antigravity ACP rejects a private profile with global MCP servers without reading or changing it', async () => {
  const harness = await createHarness();
  const configDirectory = join(harness.profileRoot, '.gemini', 'config');
  const configPath = join(configDirectory, 'mcp_config.json');
  const configBytes = Buffer.from('{"mcpServers":{"untrusted":{"command":"not-run"}}}');
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(configPath, configBytes, { mode: 0o600 });
  try {
    const backend = new AntigravityAcpExecutionBackend(
      backendOptions(harness.ctx, harness.workState, harness.profileRoot),
    );
    await assert.rejects(execute(backend, harness.workState, 'teams-antigravity-global-mcp'),
      /NATIVE_ANTIGRAVITY_PROFILE_MCP_CONFIG_PRESENT/u);
    assert.deepEqual(readFileSync(configPath), configBytes,
      'the runtime must reject the global MCP source without changing its contents');
    assert.equal(harness.toolExecutions, 0);
  } finally {
    await disposeHarness(harness);
  }
});

test('Antigravity ACP rejects permissive and symlinked profile roots before starting the native process', {
  skip: process.platform === 'win32',
}, async () => {
  const harness = await createHarness();
  const alias = `${harness.profileRoot}-alias`;
  try {
    chmodSync(harness.profileRoot, 0o755);
    const permissiveBackend = new AntigravityAcpExecutionBackend(
      backendOptions(harness.ctx, harness.workState, harness.profileRoot),
    );
    await assert.rejects(
      execute(permissiveBackend, harness.workState, 'teams-antigravity-permissive-root'),
      /NATIVE_ANTIGRAVITY_PROFILE_NOT_PRIVATE/u,
    );

    chmodSync(harness.profileRoot, 0o700);
    symlinkSync(harness.profileRoot, alias, 'dir');
    const symlinkBackend = new AntigravityAcpExecutionBackend({
      ...backendOptions(harness.ctx, harness.workState, alias),
      profileRoot: alias,
    });
    await assert.rejects(
      execute(symlinkBackend, harness.workState, 'teams-antigravity-symlink-root'),
      /NATIVE_ANTIGRAVITY_PROFILE_NOT_PRIVATE/u,
    );
  } finally {
    try { unlinkSync(alias); } catch { /* The symlink is absent when an earlier check fails. */ }
    await disposeHarness(harness);
  }
});

test('Antigravity ACP rejects a profile root owned by another uid', {
  skip: process.platform === 'win32' || process.getuid?.() !== 0,
}, async () => {
  const harness = await createHarness();
  const original = statSync(harness.profileRoot);
  try {
    chownSync(harness.profileRoot, process.getuid() + 1, process.getgid());
    const backend = new AntigravityAcpExecutionBackend(
      backendOptions(harness.ctx, harness.workState, harness.profileRoot),
    );
    await assert.rejects(
      execute(backend, harness.workState, 'teams-antigravity-wrong-owner-root'),
      /NATIVE_ANTIGRAVITY_PROFILE_NOT_PRIVATE/u,
    );
  } finally {
    chownSync(harness.profileRoot, original.uid, original.gid);
    await disposeHarness(harness);
  }
});
