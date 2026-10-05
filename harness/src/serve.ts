// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Headless Cloud Executor Application Factory       │
// │ Role: Bootstrap and export executor app runtime within Harness.     │
// │ 模块职责：在 Harness 作用域内装配并导出 Cloud Executor 运行时。         │
// └─────────────────────────────────────────────────────────────────────┘

import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import CyreneSessionPersistence from './persistence.js';
import { DynamicPluginManager, apply as applyPluginManager } from './plugin-manager.js';
import { NavigatorExecutor, apply as applyExecutor } from './executor.js';
import { ExchangeLlmAdapter } from './exchange-adapter.js';
import { InMemoryWorkStateStore, WorkStateClient } from './work-state-client.js';
import type { WorkStateStore } from './work-state-client.js';
import { registerWorkTools } from './work-tools.js';
import { registerToolProviders } from './tool-providers.js';
import type { WorkAssistantBridge } from './work-tools.js';
import { registerSubagents } from './subagents/index.js';
import type { SubagentAdapterConfig, SubagentAdapterEvent } from './subagents/types.js';
import { WorkflowsClient } from './workflows/store.js';
import { registerWorkflowRuntime } from './workflows/runtime.js';
import { registerCloudConnections, validateCloudConnectionConfig } from './integrations/cloud-connections.js';

export interface CreateExecutorAppOptions {
  readonly persistenceUrl?: string;
  readonly workspaceId?: string;
  readonly exchangeUrl?: string;
  readonly model?: string;
  readonly pluginsDir?: string;
  readonly watchPlugins?: boolean;
  readonly defaultCwd?: string;
  readonly customLlmAdapter?: { provider: string; adapter: LlmAdapter };
  readonly testMode?: boolean;
  readonly enableTestEchoAdapter?: boolean;
  readonly authTokenEnv?: string;
  readonly allowedOrigins?: readonly string[];
  readonly workStateStore?: WorkStateStore;
  readonly enableWorkflows?: boolean;
  readonly dshHome?: string;
  readonly cloudConnectionConfigPath?: string;
  readonly subagentConfigPath?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repository = resolve(__dirname, '../..');

export async function createExecutorApp(options: CreateExecutorAppOptions = {}) {
  const testMode = options.testMode === true;
  const production = process.env.NODE_ENV === 'production';
  if (production && testMode) throw new Error('Executor test mode is disabled in production');
  if (options.customLlmAdapter && !testMode) throw new Error('Custom LLM adapters require explicit testMode');
  if (options.enableTestEchoAdapter && !testMode) throw new Error('The echo adapter is test-only');

  const persistenceUrl = options.persistenceUrl ?? process.env.CYRENE_PERSISTENCE_URL;
  const workspaceId = options.workspaceId ?? process.env.CYRENE_WORKSPACE_ID;
  const dshHome = options.dshHome ?? process.env.DSH_HOME;
  const workflowsEnabled = options.enableWorkflows ?? (
    process.env.CYRENE_WORKFLOWS_ENABLED === 'true'
    || (!testMode && Boolean(dshHome) && process.env.CYRENE_WORKFLOWS_ENABLED !== 'false')
  );
  const sessionToken = process.env.CYRENE_SESSION_TOKEN;
  const publicTokenEnv = options.authTokenEnv ?? (process.env.CYRENE_EXECUTOR_TOKEN ? 'CYRENE_EXECUTOR_TOKEN' : 'CYRENE_SESSION_TOKEN');
  const publicToken = process.env[publicTokenEnv] ?? sessionToken;
  if (!testMode && !persistenceUrl) throw new Error('CYRENE_PERSISTENCE_URL is required outside explicit testMode');
  if (!testMode && !workspaceId) throw new Error('CYRENE_WORKSPACE_ID is required outside explicit testMode');
  if (!testMode && !sessionToken) throw new Error('CYRENE_SESSION_TOKEN is required outside explicit testMode');
  if (!testMode && !publicToken) throw new Error(`${publicTokenEnv} or CYRENE_SESSION_TOKEN is required for executor API authentication`);
  if (workflowsEnabled && (!persistenceUrl || !workspaceId)) {
    throw new Error('Durable workflows require CYRENE_PERSISTENCE_URL and CYRENE_WORKSPACE_ID');
  }
  if (workflowsEnabled && !dshHome) throw new Error('DSH_HOME is required when durable workflows are enabled');

  const workState: WorkStateStore = options.workStateStore
    ?? (persistenceUrl && workspaceId
      ? new WorkStateClient({ baseUrl: persistenceUrl, workspaceId, tokenEnv: 'CYRENE_SESSION_TOKEN', requestTimeoutMs: 10_000 })
      : testMode ? new InMemoryWorkStateStore() : (() => { throw new Error('Durable work-state configuration is required'); })());
  if (production && (workState instanceof InMemoryWorkStateStore || options.workStateStore === undefined && !persistenceUrl)) {
    throw new Error('Production executor requires the SQLite-backed WorkStateClient');
  }

  const ctx = new Context();

  // Core Cordis runtime and Agent loop
  await ctx.plugin(LocalSubprocessRuntime);
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);

  // Persistence (if configured)
  if (persistenceUrl) {
    if (!workspaceId) throw new Error('CYRENE_WORKSPACE_ID is required when persistence is configured');
    await ctx.plugin(CyreneSessionPersistence, {
      baseUrl: persistenceUrl,
      workspaceId,
      tokenEnv: 'CYRENE_SESSION_TOKEN',
      clientId: process.env.CYRENE_DEVICE_ID ?? 'navigator-cloud-daemon',
      requestTimeoutMs: 10_000,
      heartbeatMs: 1_000,
      batchDelayMs: 10,
      maxPendingEvents: 128,
      batchSize: 256,
    });
  }

  await ctx.plugin(AgentLoop, { agents: [] });

  // LLM Model Adapter setup
  const exchangeUrl = options.exchangeUrl ?? process.env.CYRENE_EXCHANGE_URL;
  const modelId = options.model ?? process.env.CYRENE_HARNESS_MODEL ?? (testMode ? 'test-model' : undefined);

  if (exchangeUrl) {
    const exchangeToken = process.env.CYRENE_EXCHANGE_TOKEN;
    if (!exchangeToken) throw new Error('CYRENE_EXCHANGE_TOKEN is required when Exchange is configured');
    if (!modelId) throw new Error('CYRENE_HARNESS_MODEL is required when Exchange is configured');
    ctx.llm.registerAdapter(['cyrene-exchange'], new ExchangeLlmAdapter({
      baseUrl: exchangeUrl,
      tokenEnv: 'CYRENE_EXCHANGE_TOKEN',
      requestTimeoutMs: 120_000,
    }));
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'cyrene-exchange', model: modelId }),
    });
  } else if (options.customLlmAdapter) {
    const custom = options.customLlmAdapter;
    ctx.llm.registerAdapter([custom.provider], custom.adapter);
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: custom.provider, model: modelId! }),
    });
  } else if (testMode && options.enableTestEchoAdapter === true) {
    // Explicit test-only deterministic adapter; it is never the production default.
    class CloudDefaultAdapter extends LlmAdapter {
      async *stream(genOptions: GenerateOptions): AsyncGenerator<StreamChunk> {
        const prompt = genOptions.messages?.at(-1)?.content?.[0]?.type === 'text'
          ? (genOptions.messages.at(-1)?.content?.[0] as { type: 'text'; text: string }).text
          : 'acknowledged';
        const reply = `[Cloud Executor] Task processed: "${prompt}"`;
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: reply };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } };
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: reply.length, totalTokens: 20 + reply.length } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['cloud-default'], new CloudDefaultAdapter());
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'cloud-default', model: modelId }),
    });
  } else if (!testMode) {
    throw new Error('CYRENE_EXCHANGE_URL and CYRENE_HARNESS_MODEL are required outside explicit testMode');
  }

  const pluginsDir = options.pluginsDir ?? process.env.NAVIGATOR_PLUGINS_DIR ?? join(repository, 'plugins');
  if (!existsSync(pluginsDir)) {
    mkdirSync(pluginsDir, { recursive: true });
  }

  // Dynamic Plugin Hot-Reload supervisor
  applyPluginManager(ctx, {
    pluginsDir,
    watch: options.watchPlugins ?? true,
  });

  // Autonomous Cloud Executor Daemon service
  applyExecutor(ctx, {
    defaultCwd: options.defaultCwd ?? process.cwd(),
    workspaceId: workspaceId ?? 'test-workspace',
    workState,
    authTokenEnv: publicTokenEnv,
    allowedOrigins: options.allowedOrigins,
  });

  const executor = ctx.get('executor');
  if (!executor) throw new Error('Navigator executor service was not registered');
  const pluginManager = ctx.get('pluginManager');

  let workAssistantBridge: WorkAssistantBridge | undefined;
  if (persistenceUrl && workspaceId) {
    workAssistantBridge = registerWorkTools(ctx, {
      baseUrl: persistenceUrl,
      workspaceId,
      tokenEnv: 'CYRENE_SESSION_TOKEN',
      taskIdForSession: sessionId => executor.activeTaskId(sessionId),
      onTaskDenied: sessionId => ctx.agents.get(SessionId(sessionId))?.cancel({ kind: 'hook', reason: 'work_approval_denied' }),
    });
    await registerToolProviders(ctx, {
      bridge: workAssistantBridge,
      taskIdForSession: sessionId => executor.activeTaskId(sessionId),
    });
  }

  const cloudConfigPath = options.cloudConnectionConfigPath ?? process.env.CYRENE_CLOUD_PROFILE_CONFIG;
  if (cloudConfigPath) {
    const source = await readFile(resolve(cloudConfigPath), 'utf8');
    const cloudConfig = validateCloudConnectionConfig(JSON.parse(source) as unknown);
    await registerCloudConnections(ctx, cloudConfig);
  }

  const subagentConfigPath = options.subagentConfigPath ?? process.env.CYRENE_SUBAGENT_CONFIG;
  if (subagentConfigPath) {
    const source = await readFile(resolve(subagentConfigPath), 'utf8');
    const subagentConfig = parseHostSubagentConfig(JSON.parse(source) as unknown);
    if (subagentConfig.deployments.length > 0) {
      await registerNativeSubagents(ctx, executor, workAssistantBridge, subagentConfig);
    }
  }

  if (workflowsEnabled) {
    const workflowStore = new WorkflowsClient({
      baseUrl: persistenceUrl!, workspaceId: workspaceId!, tokenEnv: 'CYRENE_SESSION_TOKEN', requestTimeoutMs: 10_000,
    });
    await registerWorkflowRuntime(ctx, {
      store: workflowStore,
      storageRoot: join(resolve(dshHome!), 'storages'),
      schedulerSessionId: 'navigator-workflow-scheduler-v1',
      executeTask: params => executor.executeTask(params),
    });
  }

  return { ctx, executor, pluginManager, pluginsDir };
}

/** Parse the host-only CLI deployment file without accepting inline secret values. | 解析仅由宿主管理且不含内联凭据的部署文件。 */
function parseHostSubagentConfig(value: unknown): SubagentAdapterConfig {
  const root = asObject(value, 'subagent config');
  assertKeys(root, ['deployments', 'timeoutMs', 'disposeGraceMs'], 'subagent config');
  if (!Array.isArray(root.deployments)) throw new TypeError('subagent config deployments must be an array');
  const deployments = root.deployments.map((entry, index) => {
    const row = asObject(entry, `subagent deployment ${index}`);
    assertKeys(row, ['backend', 'providerName', 'command', 'argv', 'cwd', 'envRefs'], `subagent deployment ${index}`);
    if (row.backend !== 'antigravity' && row.backend !== 'codebuddy') {
      throw new TypeError(`subagent deployment ${index} has an unsupported backend`);
    }
    const backend = row.backend as SubagentAdapterConfig['deployments'][number]['backend'];
    if (typeof row.command !== 'string' || row.command.trim().length === 0) {
      throw new TypeError(`subagent deployment ${index} requires a command`);
    }
    if (row.providerName !== undefined && typeof row.providerName !== 'string') {
      throw new TypeError(`subagent deployment ${index} providerName must be text`);
    }
    if (row.cwd !== undefined && typeof row.cwd !== 'string') {
      throw new TypeError(`subagent deployment ${index} cwd must be text`);
    }
    if (row.argv !== undefined && (!Array.isArray(row.argv) || row.argv.some(item => typeof item !== 'string'))) {
      throw new TypeError(`subagent deployment ${index} argv must be a string array`);
    }
    let envRefs: Record<string, string> | undefined;
    if (row.envRefs !== undefined) {
      const refs = asObject(row.envRefs, `subagent deployment ${index} envRefs`);
      envRefs = {};
      for (const [childName, hostName] of Object.entries(refs)) {
        if (typeof hostName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(childName)
          || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(hostName)) {
          throw new TypeError(`subagent deployment ${index} envRefs must map environment names to environment names`);
        }
        envRefs[childName] = hostName;
      }
    }
    return {
      backend,
      command: row.command,
      ...(row.providerName === undefined ? {} : { providerName: row.providerName }),
      ...(row.argv === undefined ? {} : { argv: row.argv as string[] }),
      ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
      ...(envRefs === undefined ? {} : { envRefs }),
    };
  });
  for (const key of ['timeoutMs', 'disposeGraceMs'] as const) {
    const number = root[key];
    if (number !== undefined && (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1)) {
      throw new TypeError(`subagent config ${key} must be a positive integer`);
    }
  }
  return {
    deployments,
    ...(root.timeoutMs === undefined ? {} : { timeoutMs: root.timeoutMs as number }),
    ...(root.disposeGraceMs === undefined ? {} : { disposeGraceMs: root.disposeGraceMs as number }),
  };
}

/** Bind native child tools, lifecycle events, and ACP permission to durable parent Work Tasks. | 将原生子 Agent 工具与 ACP 权限绑定到持久父任务。 */
async function registerNativeSubagents(
  ctx: Context,
  executor: NavigatorExecutor,
  workBridge: WorkAssistantBridge | undefined,
  config: SubagentAdapterConfig,
): Promise<void> {
  const runtime = await import('@deepseek-ai/dsh-subagent');
  await ctx.plugin(runtime.SubagentRuntime, { maxActiveSubagents: 4, maxDepth: 2 });
  const providerDisposer = registerSubagents(ctx, {
    ...config,
    onEvent: event => publishSubagentEvent(executor, event),
    requestPermission: async request => {
      if (!workBridge || request.signal.aborted) return 'deny';
      const taskId = executor.activeTaskId(String(request.parentSessionId));
      if (!taskId) return 'deny';
      try {
        await workBridge.requestApproval(
          String(request.parentSessionId),
          'native_subagent_permission',
          request.title ?? `${request.backend} requested ${request.tool}`,
          {
            providerName: request.providerName,
            backend: request.backend,
            runId: request.runId,
            conversationId: request.conversationId,
            requestId: request.requestId,
            tool: request.tool,
            ...(request.rawInput === undefined ? {} : { rawInput: request.rawInput }),
          },
          request.signal,
          `subagent:${request.runId}:${String(request.requestId)}`,
        );
        return 'allow-once';
      } catch {
        return 'deny';
      }
    },
  });
  ctx.effect(() => providerDisposer, 'navigator.nativeSubagents');

  const toolPlugin = await import('@deepseek-ai/dsh-tool-subagent');
  const names = new Set<string>();
  for (const deployment of config.deployments) {
    const providerName = deployment.providerName ?? deployment.backend;
    const toolName = `subagent_${providerName.replace(/[^A-Za-z0-9_]/gu, '_')}`;
    if (names.has(toolName)) throw new TypeError('subagent provider names collide after tool-name normalization');
    names.add(toolName);
    await ctx.plugin(toolPlugin, {
      provider: providerName,
      toolName,
      maxDepth: 'provider-managed',
      enableRunInBackground: false,
    });
  }
}

function publishSubagentEvent(executor: NavigatorExecutor, event: SubagentAdapterEvent): void {
  const taskId = executor.activeTaskId(String(event.parentSessionId));
  if (!taskId) return;
  const timestamp = Date.now();
  if (event.type === 'progress') {
    void executor.recordSubagentEvent(taskId, {
      type: 'subagent-progress', taskId, provider: event.providerName,
      phase: event.phase, message: event.status, timestamp,
    });
  } else if (event.type === 'assistant-delta') {
    void executor.recordSubagentEvent(taskId, {
      type: 'subagent-assistant-delta', taskId, provider: event.providerName,
      text: event.text, timestamp,
    });
  } else {
    void executor.recordSubagentEvent(taskId, {
      type: 'permission', taskId, provider: event.providerName,
      tool: event.tool, decision: event.decision, timestamp,
    });
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).find(key => !allow.has(key));
  if (unknown !== undefined) throw new TypeError(`${label} contains unsupported field ${unknown}`);
}
