// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Headless Cloud Executor Application Factory       │
// │ Role: Bootstrap and export executor app runtime within Harness.     │
// │ 模块职责：在 Harness 作用域内装配并导出 Cloud Executor 运行时。         │
// └─────────────────────────────────────────────────────────────────────┘

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import SessionStore from '@deepseek-ai/dsh-session';
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

export interface CreateExecutorAppOptions {
  readonly persistenceUrl?: string;
  readonly workspaceId?: string;
  readonly exchangeUrl?: string;
  readonly model?: string;
  readonly pluginsDir?: string;
  readonly watchPlugins?: boolean;
  readonly defaultCwd?: string;
  readonly customLlmAdapter?: { provider: string; adapter: LlmAdapter };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repository = resolve(__dirname, '../..');

export async function createExecutorApp(options: CreateExecutorAppOptions = {}) {
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
  const persistenceUrl = options.persistenceUrl ?? process.env.CYRENE_PERSISTENCE_URL;
  if (persistenceUrl) {
    await ctx.plugin(CyreneSessionPersistence, {
      baseUrl: persistenceUrl,
      workspaceId: options.workspaceId ?? process.env.CYRENE_WORKSPACE_ID ?? 'default',
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
  const modelId = options.model ?? process.env.CYRENE_HARNESS_MODEL ?? 'default-model';

  if (!exchangeUrl && !options.customLlmAdapter) {
    // Provide a fallback local echo LLM adapter if no external provider was configured
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
  } else if (options.customLlmAdapter) {
    const custom = options.customLlmAdapter;
    ctx.llm.registerAdapter([custom.provider], custom.adapter);
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: custom.provider, model: modelId }),
    });
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
  });

  const executor = ctx.get('executor');
  const pluginManager = ctx.get('pluginManager');

  return { ctx, executor, pluginManager, pluginsDir };
}
