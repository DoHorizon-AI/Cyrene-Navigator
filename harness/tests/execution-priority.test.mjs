// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator foreground/background execution tests              │
// │ Role: Verify lane priority, safe failover, usage, and unlimited chat. │
// │ 模块职责：验证前后台优先级、受控切换、用量记录和不限次数聊天。          │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createExecutorApp } from '../dist/serve.js';
import { InMemoryWorkStateStore } from '../dist/work-state-client.js';
import { PrioritizedModelGate } from '../dist/model-gate.js';
import { readCodeBuddyFallbackConfig } from '../dist/model-policy.js';
import { LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';

const TEST_BEARER = 'priority-fixture-token';
process.env.CYRENE_PRIORITY_TEST_TOKEN = TEST_BEARER;

class FixtureReplyAdapter extends LlmAdapter {
  constructor(text = 'Fixture reply') {
    super();
    this.text = text;
    this.calls = 0;
  }

  async *stream() {
    this.calls += 1;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: this.text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.text } };
    yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

class UnavailableAdapter extends LlmAdapter {
  constructor() {
    super();
    this.calls = 0;
  }

  async *stream() {
    this.calls += 1;
    throw new LlmError('Fixture provider unavailable', 'PROVIDER_UNAVAILABLE');
  }
}

class BackgroundWaitAdapter extends LlmAdapter {
  constructor() {
    super();
    this.calls = 0;
  }

  async *stream(options) {
    this.calls += 1;
    const text = options.messages
      .flatMap(message => message.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
    const isBackground = text.includes('BACKGROUND-WAIT');
    const hasToolResult = options.messages.some(message => message.role === 'tool');
    if (isBackground && !hasToolResult) {
      const callId = ToolCallId(`background-wait-${this.calls}`);
      const argumentsJson = '{}';
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: callId, name: 'fixture_background_wait', argumentsDelta: argumentsJson };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: callId, name: 'fixture_background_wait', arguments: argumentsJson },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    const reply = isBackground ? 'Background completed' : 'Foreground answer';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: reply };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } };
    yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function createApp(adapter, options = {}) {
  return createExecutorApp({
    testMode: true,
    authTokenEnv: 'CYRENE_PRIORITY_TEST_TOKEN',
    customLlmAdapter: { provider: 'fixture-primary', adapter },
    model: 'fixture-primary-v1',
    workStateStore: options.workStateStore,
    maxConcurrentTasks: options.maxConcurrentTasks,
    customTestModelAdapters: options.customTestModelAdapters,
    modelFallbacks: options.modelFallbacks,
  });
}

async function disposeApp(app) {
  await app.executor.dispose();
  await app.pluginManager?.dispose();
  await app.ctx.fiber.dispose();
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('foreground chat completes while one background responsibility waits at a tool boundary', async () => {
  const store = new InMemoryWorkStateStore();
  const adapter = new BackgroundWaitAdapter();
  const app = await createApp(adapter, { workStateStore: store, maxConcurrentTasks: 2 });
  const toolStarted = deferred();
  const releaseTool = deferred();
  let disposeTool = () => {};
  try {
    disposeTool = app.ctx.tools.register(defineTool({
      name: 'fixture_background_wait',
      description: 'Pause a fixture background task at an external-operation boundary.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => {
        toolStarted.resolve();
        await releaseTool.promise;
        return { ready: true };
      },
    }));
    const background = app.executor.executeTask({
      taskId: 'duty-waiting-task',
      sessionId: 'duty-session',
      executionClass: 'background',
      metadata: { source: 'workflow', workflowId: 'daily-review' },
      prompt: 'BACKGROUND-WAIT: continue the authorized review.',
    });
    await Promise.race([
      toolStarted.promise,
      delay(2_000).then(() => { throw new Error('The background responsibility did not reach its awaited tool boundary'); }),
    ]);

    const foreground = await Promise.race([
      app.executor.executeTask({
        taskId: 'foreground-chat-task',
        sessionId: 'teams-thread-session',
        prompt: 'Answer this direct chat while the review waits.',
      }),
      delay(2_000).then(() => { throw new Error('Foreground chat waited behind the background responsibility'); }),
    ]);
    assert.equal(foreground.status, 'completed');
    assert.equal(foreground.output, 'Foreground answer');

    releaseTool.resolve();
    const completedBackground = await background;
    assert.equal(completedBackground.status, 'completed');
    assert.equal(completedBackground.output, 'Background completed');
    assert.equal(adapter.calls, 3);
    assert.equal((await store.getTask('duty-waiting-task')).executionClass, 'background');
    assert.equal((await store.getTask('foreground-chat-task')).executionClass, 'foreground');
  } finally {
    releaseTool.resolve();
    disposeTool();
    await disposeApp(app);
  }
});

test('provider availability failure retries the same DSH step on the configured real backup route and records actual usage', async () => {
  const store = new InMemoryWorkStateStore();
  const primary = new UnavailableAdapter();
  const backup = new FixtureReplyAdapter('Backup route reply');
  const app = await createApp(primary, {
    workStateStore: store,
    customTestModelAdapters: [{ provider: 'fixture-backup', adapter: backup }],
    modelFallbacks: [{ provider: 'fixture-backup', model: 'fixture-backup-v1' }],
  });
  try {
    const outcome = await app.executor.executeTask({
      taskId: 'model-fallback-task',
      sessionId: 'model-fallback-session',
      prompt: 'Use the configured fallback when the first provider is unavailable.',
    });
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.output, 'Backup route reply');
    assert.equal(primary.calls, 1);
    assert.equal(backup.calls, 1);

    const events = (await store.getEvents('model-fallback-task')).events.map(row => row.event);
    const routes = events.filter(event => event.type === 'model-route');
    assert.deepEqual(routes.map(event => `${event.provider}/${event.model}`), [
      'fixture-primary/fixture-primary-v1',
      'fixture-backup/fixture-backup-v1',
    ]);
    const usage = events.find(event => event.type === 'model-usage');
    assert.equal(usage.provider, 'fixture-backup');
    assert.equal(usage.model, 'fixture-backup-v1');
    assert.deepEqual(usage.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    assert.deepEqual(await app.executor.readTaskModelUsage('model-fallback-task'), {
      taskId: 'model-fallback-task',
      routes: [{
        provider: 'fixture-backup',
        model: 'fixture-backup-v1',
        reportedCalls: 1,
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      }],
    });
  } finally {
    await disposeApp(app);
  }
});

test('model protocol or profile errors do not become a synthetic successful fallback', async () => {
  const store = new InMemoryWorkStateStore();
  const primary = new class extends LlmAdapter {
    async *stream() {
      throw new LlmError('Fixture model profile is invalid', 'MODEL_PROFILE_INVALID');
    }
  }();
  const backup = new FixtureReplyAdapter('Should not be used');
  const app = await createApp(primary, {
    workStateStore: store,
    customTestModelAdapters: [{ provider: 'fixture-backup', adapter: backup }],
    modelFallbacks: [{ provider: 'fixture-backup', model: 'fixture-backup-v1' }],
  });
  try {
    const outcome = await app.executor.executeTask({
      taskId: 'model-invalid-profile-task',
      sessionId: 'model-invalid-profile-session',
      prompt: 'The invalid provider profile must be reported truthfully.',
    });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error, /model profile is invalid/u);
    assert.equal(backup.calls, 0);
  } finally {
    await disposeApp(app);
  }
});

test('one hundred five continued chat turns have no application turn-count gate', async () => {
  const store = new InMemoryWorkStateStore();
  const adapter = new FixtureReplyAdapter();
  const app = await createApp(adapter, { workStateStore: store, maxConcurrentTasks: 2 });
  try {
    for (let index = 0; index < 105; index += 1) {
      const outcome = await app.executor.executeTask({
        taskId: `continued-chat-${index}`,
        sessionId: 'unlimited-continued-chat',
        prompt: `Continue the same conversation, turn ${index + 1}.`,
      });
      assert.equal(outcome.status, 'completed', `turn ${index + 1}`);
    }
    assert.equal(adapter.calls, 105);
  } finally {
    await disposeApp(app);
  }
});

test('foreground model requests do not wait behind a background provider call', async () => {
  const gate = new PrioritizedModelGate();
  const releaseFirst = await gate.acquire('background', new AbortController().signal);
  const order = [];
  const background = gate.acquire('background', new AbortController().signal).then(release => {
    order.push('background');
    release();
  });
  const foreground = gate.acquire('foreground', new AbortController().signal).then(release => {
    order.push('foreground');
    release();
  });
  releaseFirst();
  await Promise.all([foreground, background]);
  assert.deepEqual(order, ['foreground', 'background']);
});

test('the active task bound cannot remove the reserved foreground and background lanes', async () => {
  const adapter = new FixtureReplyAdapter();
  await assert.rejects(
    createApp(adapter, { maxConcurrentTasks: 1 }),
    /maxConcurrentTasks must be between 2 and 32/u,
  );
});

test('CodeBuddy fallback is disabled unless the no-paid-top-up policy is explicit', () => {
  assert.deepEqual(readCodeBuddyFallbackConfig({}), { enabled: false, noPaidTopUp: false });
  assert.throws(() => readCodeBuddyFallbackConfig({
    CYRENE_HARNESS_CODEBUDDY_FALLBACK_ENABLED: 'true',
  }), /NO_PAID_TOPUP=true/u);
  assert.deepEqual(readCodeBuddyFallbackConfig({
    CYRENE_HARNESS_CODEBUDDY_FALLBACK_ENABLED: 'true',
    CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP: 'true',
  }), { enabled: true, noPaidTopUp: true, model: 'glm-5.3-flash' });
});
