// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 codebuddy-acp-execution.integration.test.mjs                    │
// │  Module: harness/tests/codebuddy-acp-execution                     │
// │  Role: Verify the native ACP main backend and its local MCP boundary.│
// │                                                                      │
// │  模块职责：验证 ACP 主执行后端、本机 MCP、授权回执与终态边界。        │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { CodeBuddyAcpExecutionBackend } from '../dist/codebuddy-acp-execution.js';
import { AcpMcpHost } from '../dist/acp-mcp-host.js';
import { NavigatorExecutor } from '../dist/executor.js';
import { InMemoryWorkStateStore } from '../dist/work-state-client.js';
import { registerToolProviders } from '../dist/tool-providers.js';

const directory = dirname(fileURLToPath(import.meta.url));
const stubCommand = resolve(directory, 'fixtures/codebuddy-acp-stub.mjs');
const mcpEntrypoint = resolve(directory, '../dist/acp-mcp-stdio.js');
const sessionId = 'work-session-acp-fixture';
const taskActor = {
  issuer: 'https://login.microsoftonline.com/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/v2.0',
  subject: '11111111-1111-4111-8111-111111111111',
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

function acpConfigDirectories(configRoot) {
  try {
    return readdirSync(join(configRoot, 'navigator-acp-workspace'))
      .filter(name => name.startsWith('cyrene-navigator-codebuddy-acp-')).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function createHarness({
  teamsCaller = taskActor,
  exchangeQueryExecution,
  providerOperationExecution,
  turnTimeoutMs = 2_000,
  mcpCloseGraceMs,
} = {}) {
  const priorCodeBuddyConfigDir = process.env.CODEBUDDY_CONFIG_DIR;
  const priorCodeBuddyHome = process.env.CODEBUDDY_HOME;
  const codeBuddyConfigDir = mkdtempSync(join(tmpdir(), 'navigator-codebuddy-profile-'));
  process.env.CODEBUDDY_CONFIG_DIR = codeBuddyConfigDir;
  process.env.CODEBUDDY_HOME = join(codeBuddyConfigDir, 'untrusted-alternate-home');
  const ctx = new Context();
  await ctx.plugin(LocalSubprocessRuntime);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const workState = new InMemoryWorkStateStore();
  const bridgeCalls = [];
  const providerCalls = [];
  const bindingId = 'computer-owner-binding';
  const connectionRef = '22222222-2222-4222-8222-222222222222';
  const profileRef = 'computer-owner-profile';
  const toolId = 'computer.file.write';
  const trustedBinding = {
    bindingId,
    connectionRef,
    providerId: 'computer',
    profileRef,
    tools: [{
      toolId,
      operationId: 'computer.file.write',
      resourceProjection: 'computer_file',
      mutating: true,
    }],
  };
  const connectorToolCatalogSnapshot = {
    schemaVersion: 1,
    items: [{
      bindingId,
      capabilityId: 'tool.provider.v1',
      providerId: 'computer',
      connectionRef,
      profileRef,
      tools: [{
        id: toolId,
        name: 'Write an authorized workspace file',
        description: 'Write one file in the host-authorized computer workspace.',
        readOnly: false,
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      }],
    }],
  };
  let executor;
  let activeOperationId = 'operation-acp-1';
  const unregisterExchangeTool = ctx.tools.register({
    name: 'exchange_issue_query',
    description: 'Query an Exchange issue through the configured first-party integration.',
    parameters: {
      type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
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
      assert.equal(execution.agent?.session.id, sessionId);
      if (exchangeQueryExecution !== undefined) return exchangeQueryExecution(execution);
      return { content: [{ type: 'text', text: 'Exchange query accepted.' }] };
    },
  });
  const workBridge = {
    async request(path, method, body) {
      bridgeCalls.push({ kind: 'request', path, method, body });
      if (path.startsWith('/tasks/teams-')) {
        const metadata = teamsCaller === undefined ? {} : { teamsCaller };
        return {
          id: path.split('/').at(-1), sessionId, prompt: 'fixture', status: 'running',
          createdAt: Date.now(), output: '', reasoning: '', durationMs: 0,
          metadata,
        };
      }
      if (path.startsWith('/operations/unresolved?')) return { items: [] };
      if (path === `/operations/${activeOperationId}` && method === 'PATCH') {
        return { operation: { id: activeOperationId, status: body.status } };
      }
      throw new Error('Unexpected fixture Work request.');
    },
    async requestApproval() {
      throw new Error('The computer connector path owns its existing approval behavior.');
    },
    async mutate(execution, path, method, body) {
      bridgeCalls.push({ kind: 'mutate', path, method, body, sessionId: execution.agent?.session.id });
      if (path === '/operations' && method === 'POST') {
        activeOperationId = `operation-acp-${bridgeCalls.filter(call => call.path === '/operations').length}`;
        return { operation: { id: activeOperationId, status: 'started' }, duplicate: false };
      }
      if (path.endsWith('/events') && method === 'POST') {
        return { seq: 1, event: body.event, createdAt: Date.now(), duplicate: false };
      }
      throw new Error('Unexpected fixture Work mutation.');
    },
  };
  const authorizationClient = {
    async mintGrant(request) {
      bridgeCalls.push({ kind: 'grant', principalSubject: request.principalSubject, target: request.resourceRef });
      return { grant: 'fixture-grant' };
    },
    async callProviderOperation(request, grant, signal) {
      providerCalls.push(request);
      if (providerOperationExecution !== undefined) {
        return providerOperationExecution(request, grant, signal);
      }
      return {
        outcome: 'verified',
        result: {
          content: [{ type: 'text', text: 'Computer tool write completed through Exchange.' }],
          structuredContent: { state: 'COMPLETED' },
        },
      };
    },
  };
  const unregister = await registerToolProviders(ctx, {
    bridge: workBridge,
    taskIdForSession: actualSession => executor?.activeTaskId(actualSession),
    connectorAuthorization: {
      client: authorizationClient,
      workspaceId: 'fixture-workspace',
      bindings: new Map([[bindingId, trustedBinding]]),
    },
    connectorToolCatalogSnapshot,
  });
  const toolName = ctx.tools.schemas().find(schema => schema.description.includes('host-authorized computer workspace'))?.name;
  assert.ok(toolName);
  const createBackend = turn => new CodeBuddyAcpExecutionBackend({
    ctx,
    workState,
    command: process.execPath,
    commandArgsPrefix: [
      stubCommand,
      '--fixture-mode', turn === 'cancel' ? 'cancel' : turn,
      '--fixture-turn', turn === 'second' ? 'second' : 'first',
    ],
    mcpServerEntrypoint: mcpEntrypoint,
    startupTimeoutMs: 2_000,
    turnTimeoutMs,
    disposeGraceMs: 1_000,
    ...(mcpCloseGraceMs === undefined ? {} : { mcpCloseGraceMs }),
  });
  const createExecutor = backend => {
    executor = new NavigatorExecutor(ctx, {
      workspaceId: 'fixture-workspace',
      workState,
      defaultCwd: process.cwd(),
      maxConcurrentTasks: 2,
      conversationBackend: backend,
    });
    return executor;
  };
  return {
    ctx, workState, bridgeCalls, providerCalls, unregister, unregisterExchangeTool, toolName,
    codeBuddyConfigDir, priorCodeBuddyConfigDir, priorCodeBuddyHome, createBackend, createExecutor,
    get executor() { return executor; },
  };
}

async function disposeHarness(harness) {
  try {
    await harness.executor?.dispose();
    harness.unregister();
    harness.unregisterExchangeTool();
    await harness.ctx.fiber.dispose();
  } finally {
    rmSync(harness.codeBuddyConfigDir, { recursive: true, force: true });
    if (harness.priorCodeBuddyConfigDir === undefined) delete process.env.CODEBUDDY_CONFIG_DIR;
    else process.env.CODEBUDDY_CONFIG_DIR = harness.priorCodeBuddyConfigDir;
    if (harness.priorCodeBuddyHome === undefined) delete process.env.CODEBUDDY_HOME;
    else process.env.CODEBUDDY_HOME = harness.priorCodeBuddyHome;
  }
}

test('CodeBuddy ACP owns the top-level turn, resumes the durable native session, and routes receipts through Navigator tools', async () => {
  const environmentNames = [
    'CYRENE_SESSION_TOKEN', 'CYRENE_EXCHANGE_TOKEN', 'TEAMS_NAVIGATOR_HMAC_KEY',
    'DIRECTORY_DATABASE_PASSWORD', 'DOCKER_HOST', 'GLM_API_KEY', 'DEEPSEEK_API_KEY', 'CODEBUDDY_API_KEY',
  ];
  const previousEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]));
  process.env.CYRENE_SESSION_TOKEN = 'fixture-session-token';
  process.env.CYRENE_EXCHANGE_TOKEN = 'fixture-exchange-token';
  process.env.TEAMS_NAVIGATOR_HMAC_KEY = 'fixture-teams-hmac';
  process.env.DIRECTORY_DATABASE_PASSWORD = 'fixture-directory-password';
  process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
  process.env.GLM_API_KEY = 'fixture-glm-api-key';
  process.env.DEEPSEEK_API_KEY = 'fixture-deepseek-api-key';
  process.env.CODEBUDDY_API_KEY = 'fixture-codebuddy-api-key';
  const harness = await createHarness();
  const priorConfigDirectories = acpConfigDirectories(harness.codeBuddyConfigDir);
  try {
    const events = [];
    const executor = harness.createExecutor(harness.createBackend('tool'));
    const first = await executor.executeTask({
      taskId: 'teams-acp-task-1',
      sessionId,
      prompt: 'Write the requested file once.',
      cwd: '/tmp/untrusted-codebuddy-project',
      metadata: { teamsCaller: taskActor },
    }, event => events.push(event));
    assert.equal(first.status, 'completed');
    assert.match(first.output, /Computer tool write completed through Exchange/u);
    assert.match(first.output, /Exchange query accepted/u);
    assert.match(first.output, /unknown denied=true/u);
    assert.match(first.output, /permission denied=true/u);
    assert.match(first.output, /host MCP allow once=true/u);
    assert.match(first.output, /unknown MCP denied=true/u);
    assert.match(first.output, /extra MCP denied=true/u);
    assert.equal(harness.providerCalls.length, 1, 'the unknown native MCP tool must not reach Exchange');
    assert.equal(harness.providerCalls[0].arguments.path, '/workspace/result.txt');
    assert.equal(harness.bridgeCalls.filter(call => call.kind === 'grant').length, 1);
    assert.ok(harness.bridgeCalls.some(call => call.kind === 'mutate' && call.path === '/operations'));
    assert.ok(harness.bridgeCalls.some(call => call.kind === 'request' && call.path === '/operations/operation-acp-1' && call.method === 'PATCH'));
    assert.ok(events.some(event => event.type === 'tool-call' && event.tool === harness.toolName));
    assert.ok(events.some(event => event.type === 'tool-result' && event.isError === false));
    for (const name of environmentNames) {
      const value = previousEnvironment.get(name) ?? process.env[name];
      if (value !== undefined) assert.equal(JSON.stringify(events).includes(value), false);
    }
    const durableEvents = await harness.workState.getEvents(first.taskId);
    assert.ok(durableEvents.events.some(item => item.event.type === 'execution.backend_session'
      && item.event.legacyDshHistoryImported === false));
    assert.deepEqual(acpConfigDirectories(harness.codeBuddyConfigDir), priorConfigDirectories);

    await executor.dispose();
    const restarted = harness.createExecutor(harness.createBackend('second'));
    const second = await restarted.executeTask({
      taskId: 'teams-acp-task-2',
      sessionId,
      prompt: 'Continue in the same native conversation.',
      metadata: { teamsCaller: taskActor },
    });
    assert.equal(second.status, 'completed');
    assert.match(second.output, /Restored native-session-1/u);
    assert.equal(harness.providerCalls.length, 1, 'restoring context must not replay the previous write');
    assert.deepEqual(acpConfigDirectories(harness.codeBuddyConfigDir), priorConfigDirectories);
    const secondEvents = await harness.workState.getEvents(second.taskId);
    assert.ok(secondEvents.events.some(item => item.event.type === 'execution.backend_session'
      && item.event.resumed === true));
  } finally {
    await disposeHarness(harness);
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a pre-existing non-private CodeBuddy profile is rejected without changing its permissions', async () => {
  const harness = await createHarness();
  const originalMode = statSync(harness.codeBuddyConfigDir).mode & 0o777;
  chmodSync(harness.codeBuddyConfigDir, 0o755);
  try {
    const executor = harness.createExecutor(harness.createBackend('tool'));
    const outcome = await executor.executeTask({
      taskId: 'teams-acp-insecure-profile-task',
      sessionId,
      prompt: 'Do not start with a public CodeBuddy profile directory.',
      metadata: { teamsCaller: taskActor },
    });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /NATIVE_CODEBUDDY_PROFILE_NOT_PRIVATE/u);
    assert.equal(statSync(harness.codeBuddyConfigDir).mode & 0o777, 0o755,
      'Navigator must reject an unsafe profile without chmod or takeover');
    assert.deepEqual(acpConfigDirectories(harness.codeBuddyConfigDir), []);
  } finally {
    chmodSync(harness.codeBuddyConfigDir, originalMode);
    await disposeHarness(harness);
  }
});

test('CodeBuddy ACP cancellation, premature EOF, and nonzero process exits remain failures', async () => {
  const harness = await createHarness();
  const priorConfigDirectories = acpConfigDirectories(harness.codeBuddyConfigDir);
  try {
    async function runFailure(mode, controller = new AbortController(), onText = () => {}) {
      const taskId = `teams-${mode}-task`;
      const record = await harness.workState.createTask({ id: taskId, sessionId: `${mode}-session`, prompt: 'fixture' });
      await harness.workState.claimTask(taskId);
      return harness.createBackend(mode).execute({
        taskId,
        sessionId: record.sessionId,
        prompt: 'fixture failure mode',
        signal: controller.signal,
        authorizationPauseSignal: new AbortController().signal,
        readOnly: false,
        onText,
      });
    }
    await assert.rejects(runFailure('eof'), /ACP|Native|CodeBuddy/u);
    await assert.rejects(runFailure('nonzero'), /ACP|Native|CodeBuddy/u);
    await assert.rejects(runFailure('nonzero-after-response'), /ACP|Native|CodeBuddy/u);

    const controller = new AbortController();
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const cancelled = runFailure('cancel', controller, text => {
      if (text === 'READY_FOR_CANCEL') {
        resolveReady();
        controller.abort(new Error('fixture cancellation'));
      }
    });
    await ready;
    await assert.rejects(cancelled, /cancelled|aborted|stopped/u);
    assert.deepEqual(acpConfigDirectories(harness.codeBuddyConfigDir), priorConfigDirectories);
  } finally {
    await disposeHarness(harness);
  }
});

test('Exchange reauthorization pauses and cancels the ACP turn without aborting the Work Task', async () => {
  let executor;
  const harness = await createHarness({
    exchangeQueryExecution: async execution => {
      assert.equal(await executor.markTaskAwaitingUserAuthorization(execution.agent.session.id, {
        code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
        source: 'issue-action',
        callId: String(execution.callId),
        connectionId: '33333333-3333-4333-8333-333333333333',
      }), true);
      return {
        status: 'awaiting_user_authorization',
        code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
      };
    },
  });
  const priorConfigDirectories = acpConfigDirectories(harness.codeBuddyConfigDir);
  try {
    executor = harness.createExecutor(harness.createBackend('reauth'));
    const events = [];
    const outcome = await executor.executeTask({
      taskId: 'teams-acp-reauth-task',
      sessionId,
      prompt: 'Check the issue connection and wait if it needs authorization.',
    }, event => events.push(event));
    assert.equal(outcome.status, 'awaiting_user_authorization');
    assert.match(outcome.output, /AUTHORIZATION_PAUSE_CANCELLED/u);
    assert.doesNotMatch(outcome.output, /WAITING_FOR_AUTHORIZATION/u,
      'the native turn must stop before the agent can continue after the authorization pause');
    assert.ok(events.some(event => event.type === 'authorization-required'
      && event.code === 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED'));
    assert.ok(events.some(event => event.type === 'finish' && event.status === 'awaiting_user_authorization'));
    assert.equal(events.some(event => event.type === 'error' || event.type === 'status' && event.status === 'aborted'), false);
    const durable = await harness.workState.getTask(outcome.taskId);
    assert.equal(durable.status, 'awaiting_user_authorization');
    const durableEvents = await harness.workState.getEvents(outcome.taskId);
    assert.ok(durableEvents.events.some(row => row.event.type === 'finish'
      && row.event.status === 'awaiting_user_authorization'));
    assert.deepEqual(acpConfigDirectories(harness.codeBuddyConfigDir), priorConfigDirectories);
  } finally {
    await disposeHarness(harness);
  }
});

test('authorization pause stays resumable when another authorized provider ignores cancellation', async () => {
  let executor;
  let releaseProvider;
  let resolveProviderStarted;
  let resolvePaused;
  const providerStarted = new Promise(resolve => { resolveProviderStarted = resolve; });
  const paused = new Promise(resolve => { resolvePaused = resolve; });
  const harness = await createHarness({
    turnTimeoutMs: 1_000,
    mcpCloseGraceMs: 80,
    exchangeQueryExecution: async execution => {
      await providerStarted;
      assert.equal(await executor.markTaskAwaitingUserAuthorization(execution.agent.session.id, {
        code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
        source: 'issue-action',
        callId: String(execution.callId),
        connectionId: '33333333-3333-4333-8333-333333333333',
      }), true);
      return { content: [{ type: 'text', text: 'Authorization is required.' }] };
    },
    providerOperationExecution: async () => {
      resolveProviderStarted();
      return new Promise(resolve => { releaseProvider = () => resolve({
        outcome: 'verified',
        result: {
          content: [{ type: 'text', text: 'late provider result' }],
          structuredContent: { state: 'COMPLETED' },
        },
      }); });
    },
  });
  try {
    executor = harness.createExecutor(harness.createBackend('reauth-slow-tool'));
    const execution = executor.executeTask({
      taskId: 'teams-acp-reauth-slow-task',
      sessionId,
      prompt: 'Pause for authorization while a connector call is active.',
      metadata: { teamsCaller: taskActor },
    }, event => {
      if (event.type === 'authorization-required') resolvePaused();
    });
    await providerStarted;
    await paused;
    const outcome = await execution;
    assert.equal(outcome.status, 'awaiting_user_authorization');
    assert.match(outcome.error ?? '', /NATIVE_CLEANUP_INCOMPLETE/u);
    assert.ok(harness.bridgeCalls.some(call => call.path === '/operations/operation-acp-1'
      && call.method === 'PATCH' && call.body.status === 'uncertain'));
    assert.equal(harness.bridgeCalls.some(call => call.path === '/operations/operation-acp-1'
      && call.method === 'PATCH' && call.body.status === 'verified'), false);
    const durable = await harness.workState.getTask(outcome.taskId);
    assert.equal(durable.status, 'awaiting_user_authorization');
    const durableEvents = await harness.workState.getEvents(outcome.taskId);
    assert.ok(durableEvents.events.some(row => row.event.type === 'error'
      && row.event.code === 'NATIVE_CLEANUP_INCOMPLETE'));
    assert.ok(durableEvents.events.some(row => row.event.type === 'finish'
      && row.event.status === 'awaiting_user_authorization'));
    assert.equal(durableEvents.events.some(row => row.event.type === 'status'
      && row.event.status === 'aborted' || row.event.type === 'finish' && row.event.status === 'failed'), false);
    releaseProvider();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(harness.bridgeCalls.some(call => call.path === '/operations/operation-acp-1'
      && call.method === 'PATCH' && call.body.status === 'verified'), false);
  } finally {
    releaseProvider?.();
    await disposeHarness(harness);
  }
});

test('an ignored provider abort leaves an uncertain receipt and reports incomplete MCP cleanup', async () => {
  let releaseProvider;
  let resolveProviderStarted;
  const providerStarted = new Promise(resolve => { resolveProviderStarted = resolve; });
  const harness = await createHarness({
    turnTimeoutMs: 100,
    mcpCloseGraceMs: 80,
    providerOperationExecution: async () => {
      resolveProviderStarted();
      return new Promise(resolve => { releaseProvider = () => resolve({
        outcome: 'verified',
        result: {
          content: [{ type: 'text', text: 'late provider result' }],
          structuredContent: { state: 'COMPLETED' },
        },
      }); });
    },
  });
  try {
    const executor = harness.createExecutor(harness.createBackend('slow-tool'));
    const execution = executor.executeTask({
      taskId: 'teams-acp-slow-tool-task',
      sessionId,
      prompt: 'Run one authorized write that stalls in the provider.',
      metadata: { teamsCaller: taskActor },
    });
    await providerStarted;
    const outcome = await execution;
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /cleanup is incomplete|cleanup incomplete/u);
    assert.equal(harness.bridgeCalls.some(call => call.path === '/operations/operation-acp-1'
      && call.method === 'PATCH' && call.body.status === 'uncertain'), true);
    assert.equal(harness.bridgeCalls.some(call => call.path === '/operations/operation-acp-1'
      && call.method === 'PATCH' && call.body.status === 'verified'), false);
    assert.equal(harness.providerCalls.length, 1);
    releaseProvider();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(harness.bridgeCalls.some(call => call.path === '/operations/operation-acp-1'
      && call.method === 'PATCH' && call.body.status === 'verified'), false,
    'a late provider success must not overwrite the uncertain Work receipt');
  } finally {
    releaseProvider?.();
    await disposeHarness(harness);
  }
});

test('MCP catalog failures return a bounded response without escaping the request handler', async () => {
  const harness = await createHarness();
  const originalGet = harness.ctx.tools.get.bind(harness.ctx.tools);
  const controller = new AbortController();
  const host = new AcpMcpHost({
    ctx: harness.ctx,
    sessionId,
    signal: controller.signal,
    readOnly: false,
    closeGraceMs: 100,
  });
  try {
    const endpoint = await host.listen();
    harness.ctx.tools.get = () => { throw new Error('dynamic catalog was unloaded'); };
    const response = await fetch(new URL('/tools/list', endpoint), {
      headers: { authorization: `Bearer ${host.token}` },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'tool_catalog_unavailable' });
    harness.ctx.tools.get = originalGet;
  } finally {
    controller.abort();
    harness.ctx.tools.get = originalGet;
    await host.close();
    await disposeHarness(harness);
  }
});

test('an ACP connector call without a trusted Work actor never reaches connector authorization or provider bridges', async () => {
  const harness = await createHarness({ teamsCaller: null });
  const priorConfigDirectories = acpConfigDirectories(harness.codeBuddyConfigDir);
  try {
    const executor = harness.createExecutor(harness.createBackend('unauthorized'));
    const outcome = await executor.executeTask({
      taskId: 'teams-acp-unauthorized-task',
      sessionId,
      prompt: 'Try the authorized connector tool without a trusted caller.',
    });
    assert.equal(outcome.status, 'completed');
    assert.match(outcome.output, /connector denied=true/u);
    assert.equal(harness.providerCalls.length, 0);
    assert.equal(harness.bridgeCalls.some(call => call.kind === 'grant'), false);
    assert.equal(harness.bridgeCalls.some(call => call.kind === 'mutate'), false);
    assert.deepEqual(acpConfigDirectories(harness.codeBuddyConfigDir), priorConfigDirectories);
  } finally {
    await disposeHarness(harness);
  }
});

test('ACP calls traverse host ToolRuntime guards and publish the final tools/result observation', async () => {
  const harness = await createHarness();
  const priorConfigDirectories = acpConfigDirectories(harness.codeBuddyConfigDir);
  const toolResults = [];
  harness.ctx.on('tools/result', (execution, result) => {
    toolResults.push({ name: execution.name, sessionId: execution.agent?.session.id, isError: result.isError });
  });
  const disposeGuard = harness.ctx.tools.guard(execution =>
    execution.agent?.session.id === sessionId ? 'Host policy rejected this connector operation.' : undefined);
  try {
    const executor = harness.createExecutor(harness.createBackend('guarded'));
    const outcome = await executor.executeTask({
      taskId: 'teams-acp-guarded-task',
      sessionId,
      prompt: 'Call the configured connector despite the host policy fixture.',
    });
    assert.equal(outcome.status, 'completed');
    assert.match(outcome.output, /connector denied=true/u);
    assert.equal(harness.providerCalls.length, 0);
    assert.equal(harness.bridgeCalls.some(call => call.kind === 'grant'), false);
    assert.equal(harness.bridgeCalls.some(call => call.kind === 'mutate'), false);
    assert.ok(toolResults.some(result => result.name === harness.toolName
      && result.sessionId === sessionId && result.isError === true));
    assert.deepEqual(acpConfigDirectories(harness.codeBuddyConfigDir), priorConfigDirectories);
  } finally {
    disposeGuard();
    await disposeHarness(harness);
  }
});
