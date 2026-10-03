// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Executor & Dynamic Plugin Integration Test        │
// │ Role: Verify autonomous cloud executor, SSE streaming, hot reload   │
// │ 模块职责：验证独立执行器、SSE 实时流式传输、任务取消与插件动态热重载   │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createExecutorApp } from '../dist/serve.js';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

class TestMockAdapter extends LlmAdapter {
  constructor(delayMs = 0) {
    super();
    this.delayMs = delayMs;
  }

  async *stream(options) {
    if (this.delayMs > 0) {
      await delay(this.delayMs);
    }
    if (options.signal?.aborted) {
      throw new Error('LLM call aborted');
    }
    const prompt = options.messages?.at(-1)?.content?.[0]?.text ?? '';
    const reasoning = `Thinking about "${prompt}"`;
    const reply = `Executed: "${prompt}" successfully.`;

    yield { type: 'block-start', index: 0, blockType: 'reasoning' };
    yield { type: 'reasoning-delta', index: 0, text: reasoning };
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } };

    yield { type: 'block-start', index: 1, blockType: 'text' };
    yield { type: 'text-delta', index: 1, text: reply };
    yield { type: 'block-end', index: 1, block: { type: 'text', text: reply } };

    yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 25, totalTokens: 40 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

test('NavigatorExecutor: executes one-shot task to completion', async () => {
  const customAdapter = new TestMockAdapter();
  const { executor, ctx } = await createExecutorApp({
    customLlmAdapter: { provider: 'test-mock', adapter: customAdapter },
    model: 'mock-v1',
  });

  try {
    const outcome = await executor.executeTask({
      prompt: 'Summarize system telemetry',
      stream: false,
    });

    assert.equal(outcome.status, 'completed');
    assert.ok(outcome.output.includes('Executed: "Summarize system telemetry" successfully.'));
    assert.ok(outcome.reasoning.includes('Thinking about "Summarize system telemetry"'));
    assert.ok(outcome.durationMs >= 0);

    const taskRecord = executor.getTask(outcome.taskId);
    assert.ok(taskRecord);
    assert.equal(taskRecord.status, 'completed');
    assert.equal(taskRecord.id, outcome.taskId);
  } finally {
    await executor.dispose();
    await ctx.fiber.dispose();
  }
});

test('NavigatorExecutor: streams real-time SSE events including reasoning and text deltas', async () => {
  const customAdapter = new TestMockAdapter();
  const { executor, ctx } = await createExecutorApp({
    customLlmAdapter: { provider: 'test-mock', adapter: customAdapter },
    model: 'mock-v1',
  });

  try {
    const events = [];
    const outcome = await executor.executeTask({
      prompt: 'Live stream analysis',
      stream: true,
    }, event => {
      events.push(event);
    });

    assert.equal(outcome.status, 'completed');
    assert.ok(events.length >= 3, `Expected at least 3 events, got ${events.length}`);

    const statusEvents = events.filter(e => e.type === 'status');
    assert.ok(statusEvents.some(e => e.status === 'running'));

    const reasoningDeltas = events.filter(e => e.type === 'reasoning-delta');
    assert.ok(reasoningDeltas.some(e => e.text.includes('Thinking about "Live stream analysis"')));

    const textDeltas = events.filter(e => e.type === 'text-delta');
    assert.ok(textDeltas.some(e => e.text.includes('Executed: "Live stream analysis"')));

    const finishEvent = events.find(e => e.type === 'finish');
    assert.ok(finishEvent);
    assert.equal(finishEvent.status, 'completed');
  } finally {
    await executor.dispose();
    await ctx.fiber.dispose();
  }
});

test('NavigatorExecutor: cancels long-running task and aborts cleanly', async () => {
  // Adapter with 2000ms delay to give us time to cancel
  const delayedAdapter = new TestMockAdapter(2000);
  const { executor, ctx } = await createExecutorApp({
    customLlmAdapter: { provider: 'test-mock', adapter: delayedAdapter },
    model: 'mock-v1',
  });

  try {
    const executionPromise = executor.executeTask({
      taskId: 'cancel-test-task',
      prompt: 'This task will be aborted',
    });

    // Wait 50ms so task enters 'running' state
    await delay(50);

    const cancelled = await executor.cancelTask('cancel-test-task');
    assert.equal(cancelled, true);

    const outcome = await executionPromise;
    assert.equal(outcome.status, 'aborted');
    assert.ok(outcome.error?.includes('cancelled by caller') || outcome.error?.includes('aborted'));

    const record = executor.getTask('cancel-test-task');
    assert.equal(record?.status, 'aborted');
  } finally {
    await executor.dispose();
    await ctx.fiber.dispose();
  }
});

test('DynamicPluginManager: hot-reloads plugin at runtime without interrupting live sessions', async () => {
  const customAdapter = new TestMockAdapter();
  const tempDir = await mkdtemp(join(tmpdir(), 'cyrene-plugin-test-'));

  const { executor, pluginManager, ctx } = await createExecutorApp({
    customLlmAdapter: { provider: 'test-mock', adapter: customAdapter },
    model: 'mock-v1',
    pluginsDir: tempDir,
    watchPlugins: false,
  });

  try {
    // 1. Create a live session and run an initial task
    const initialOutcome = await executor.executeTask({
      sessionId: 'hot-reload-test-session',
      prompt: 'Initial step before plugin reload',
    });
    assert.equal(initialOutcome.status, 'completed');

    // 2. Author a dynamic plugin v1
    const pluginFile = join(tempDir, 'sample-service.mjs');
    await writeFile(pluginFile, `
      export const name = 'sample-service';
      export function apply(ctx) {
        ctx.provide('sampleService', { getVersion: () => 1 });
      }
    `);

    // 3. Hot-load plugin v1
    const loadInfo = await pluginManager.loadPlugin('sample-service', pluginFile);
    assert.equal(loadInfo.status, 'loaded');
    assert.equal(ctx.get('sampleService')?.getVersion(), 1);

    // 4. Overwrite plugin file with v2 implementation
    await writeFile(pluginFile, `
      export const name = 'sample-service';
      export function apply(ctx) {
        ctx.provide('sampleService', { getVersion: () => 2 });
      }
    `);

    // 5. Hot-reload plugin
    const reloadInfo = await pluginManager.reloadPlugin('sample-service');
    assert.equal(reloadInfo.status, 'loaded');
    assert.equal(ctx.get('sampleService')?.getVersion(), 2, 'Plugin should have updated in-place');

    // 6. Verify existing live session still runs seamlessly without interruption
    const postReloadOutcome = await executor.executeTask({
      sessionId: 'hot-reload-test-session',
      prompt: 'Follow-up step after hot reload',
    });
    assert.equal(postReloadOutcome.status, 'completed');
    assert.equal(postReloadOutcome.sessionId, 'hot-reload-test-session');

    // 7. Unload plugin
    const unloaded = await pluginManager.unloadPlugin('sample-service');
    assert.equal(unloaded, true);
    assert.equal(pluginManager.listPlugins().length, 0);
  } finally {
    await executor.dispose();
    await pluginManager.dispose();
    await ctx.fiber.dispose();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Navigator Cloud Daemon: serves HTTP REST and SSE endpoints with full controls', async () => {
  const customAdapter = new TestMockAdapter();
  const { executor, ctx } = await createExecutorApp({
    customLlmAdapter: { provider: 'test-mock', adapter: customAdapter },
    model: 'mock-v1',
  });

  const { url, close } = await executor.startServer(0, '127.0.0.1');

  try {
    // 1. Health check
    const healthRes = await fetch(`${url}/api/v1/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.status, 'ok');
    assert.equal(health.service, 'cyrene-navigator-executor');

    // 2. Synchronous REST execution
    const execRes = await fetch(`${url}/api/v1/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Remote HTTP REST command', stream: false }),
    });
    assert.equal(execRes.status, 200);
    const execData = await execRes.json();
    assert.equal(execData.status, 'completed');
    assert.ok(execData.output.includes('Remote HTTP REST command'));

    // 3. Status inspection
    const statusRes = await fetch(`${url}/api/v1/tasks/${execData.taskId}/status`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.id, execData.taskId);
    assert.equal(statusData.status, 'completed');

    // 4. SSE streaming execution
    const sseRes = await fetch(`${url}/api/v1/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({ prompt: 'Remote SSE streaming command', stream: true }),
    });
    assert.equal(sseRes.status, 200);
    assert.ok(sseRes.headers.get('content-type')?.includes('text/event-stream'));

    const sseText = await sseRes.text();
    assert.ok(sseText.includes('event: status'));
    assert.ok(sseText.includes('event: text-delta'));
    assert.ok(sseText.includes('event: finish'));

    // 5. Plugin list endpoint
    const pluginsRes = await fetch(`${url}/api/v1/plugins`);
    assert.equal(pluginsRes.status, 200);
    const pluginsData = await pluginsRes.json();
    assert.ok(Array.isArray(pluginsData.plugins));
  } finally {
    await close();
    await executor.dispose();
    await ctx.fiber.dispose();
  }
});
