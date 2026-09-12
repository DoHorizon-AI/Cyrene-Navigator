// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator compaction profile regression                      │
// │ Role: Verify only compaction loses tools while Agent calls retain them.│
// │ 模块职责：验证仅 compaction 移除工具声明，普通 Agent 请求继续保留。     │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import NavigatorCompactionEngine from '../dist/compaction.js';

const TOOL_SCHEMA = {
  name: 'fixture_tool',
  description: 'Read a manifest identifier.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

/** Deterministic adapter that records the public GenerateOptions boundary. */
class RecordingAdapter extends LlmAdapter {
  constructor(mode = 'text') {
    super();
    this.mode = mode;
    this.calls = [];
    this.observations = [];
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 8192 } });
  }

  async *stream(options) {
    this.calls.push(options);
    const observation = {
      blockTypeCounts: {},
      finishKinds: [],
      reasoningLengths: [],
      textLengths: [],
      toolCallCount: 0,
      usage: [],
    };
    this.observations.push(observation);
    const emit = chunk => {
      if (chunk.type === 'block-end') {
        const blockType = chunk.block.type;
        observation.blockTypeCounts[blockType] = (observation.blockTypeCounts[blockType] ?? 0) + 1;
        if (blockType === 'tool-call') observation.toolCallCount += 1;
      } else if (chunk.type === 'text-delta') {
        observation.textLengths.push(chunk.text.length);
      } else if (chunk.type === 'reasoning-delta') {
        observation.reasoningLengths.push(chunk.text.length);
      } else if (chunk.type === 'usage') {
        observation.usage.push({ ...chunk.usage });
      } else if (chunk.type === 'finish') {
        observation.finishKinds.push(chunk.reason.kind);
      }
      return chunk;
    };

    const toolOnly = this.mode === 'tool-only'
      || (this.mode === 'tool-when-tools' && options.tools !== undefined);
    if (toolOnly) {
      yield emit({ type: 'block-start', index: 0, blockType: 'tool-call' });
      yield emit({
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: ToolCallId('fixture-call'), name: 'fixture_tool', arguments: '{}' },
      });
      yield emit({ type: 'usage', usage: { inputTokens: 41, outputTokens: 3, totalTokens: 44 } });
      yield emit({ type: 'finish', reason: { kind: 'tool-calls' } });
      return;
    }
    if (this.mode === 'reasoning-only') {
      yield emit({ type: 'block-start', index: 0, blockType: 'reasoning' });
      yield emit({ type: 'reasoning-delta', index: 0, text: 'fixture reasoning' });
      yield emit({
        type: 'block-end',
        index: 0,
        block: { type: 'reasoning', text: 'fixture reasoning' },
      });
      yield emit({ type: 'usage', usage: { inputTokens: 43, outputTokens: 5, totalTokens: 48 } });
      yield emit({ type: 'finish', reason: { kind: 'stop' } });
      return;
    }
    yield emit({ type: 'block-start', index: 0, blockType: 'text' });
    yield emit({ type: 'text-delta', index: 0, text: 'fixture checkpoint' });
    yield emit({ type: 'block-end', index: 0, block: { type: 'text', text: 'fixture checkpoint' } });
    yield emit({ type: 'usage', usage: { inputTokens: 47, outputTokens: 7, totalTokens: 54 } });
    yield emit({ type: 'finish', reason: { kind: 'stop' } });
  }
}

/** Mount the same upstream service boundary that the Profile loader uses. */
async function harness(mode = 'text', Engine = NavigatorCompactionEngine) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(TokenMeter);
  const adapter = new RecordingAdapter(mode);
  ctx.llm.registerAdapter(['cyrene-exchange'], adapter);
  const fiber = await ctx.plugin(Engine, { auto: false });
  return { ctx, adapter, engine: ctx.get('compaction'), fiber };
}

const SUMMARY_INPUT = {
  system: 'profile system',
  tools: [TOOL_SCHEMA],
  messages: [createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'historical context' }],
  })],
};

const SUMMARY_AGENT = {
  options: { provider: 'cyrene-exchange', model: 'cyrene-proof-text' },
};

/** Run one isolated summarizer and retain only non-content stream metadata. */
async function summarizeWith(Engine, mode, input = SUMMARY_INPUT) {
  const { ctx, adapter, engine } = await harness(mode, Engine);
  try {
    const session = ctx.sessions.create(SessionId(`compaction-proof-${mode}-${Engine.name}`));
    try {
      const result = await engine.summarize(input, { ...SUMMARY_AGENT, session });
      const call = adapter.calls[0];
      return {
        result,
        observations: adapter.observations,
        purpose: call?.purpose,
        toolCount: call?.tools?.length ?? 0,
      };
    } catch (error) {
      const call = adapter.calls[0];
      return {
        error,
        observations: adapter.observations,
        purpose: call?.purpose,
        toolCount: call?.tools?.length ?? 0,
      };
    }
  } finally {
    await ctx.fiber.dispose();
  }
}

test('Profile compaction removes only auxiliary tools and preserves purpose/stream metadata', async () => {
  const { ctx, adapter, engine } = await harness();
  try {
    assert.ok(engine instanceof NavigatorCompactionEngine);
    assert.ok(engine instanceof BasicCompactionEngine);
    const session = ctx.sessions.create(SessionId('compaction-profile-tools'));
    const input = {
      system: 'profile system',
      tools: [TOOL_SCHEMA],
      messages: [createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'historical context' }],
      })],
    };
    const signal = new AbortController().signal;

    // Protected in TypeScript, intentionally callable here as a black-box
    // fixture against the emitted class and the upstream public LLM seam.
    const result = await engine.summarize(input, {
      session,
      options: { provider: 'cyrene-exchange', model: 'cyrene-proof-text' },
    }, signal);
    assert.deepEqual(result.summary, [{ type: 'text', text: 'fixture checkpoint' }]);
    assert.equal(adapter.calls.length, 1);
    const compactionCall = adapter.calls[0];
    assert.ok(compactionCall);
    assert.equal(compactionCall.purpose, 'compaction');
    assert.equal(compactionCall.provider, 'cyrene-exchange');
    assert.equal(compactionCall.model, 'cyrene-proof-text');
    assert.equal(compactionCall.signal, signal);
    assert.equal(compactionCall.system, 'profile system');
    assert.equal(compactionCall.tools, undefined);

    // A separate ordinary model request still receives the same tool schema.
    for await (const _chunk of ctx.llm.stream({
      provider: 'cyrene-exchange',
      model: 'cyrene-proof-text',
      messages: input.messages,
      tools: input.tools,
    })) {
      // Consume the full upstream stream so the adapter boundary is complete.
    }
    assert.equal(adapter.calls.length, 2);
    assert.deepEqual(adapter.calls[1]?.tools, [TOOL_SCHEMA]);
    assert.equal(adapter.calls[1]?.purpose, undefined);
  } finally {
    await ctx.fiber.dispose();
  }
});

for (const mode of ['tool-only', 'reasoning-only']) {
  test(`Profile keeps upstream fail-closed behavior for a ${mode} summary response`, async () => {
    const { ctx, adapter, engine } = await harness(mode);
    try {
      const session = ctx.sessions.create(SessionId(`compaction-profile-${mode}`));
      await assert.rejects(
        engine.summarize({
          tools: [TOOL_SCHEMA],
          messages: [createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'history' }],
          })],
        }, {
          session,
          options: { provider: 'cyrene-exchange', model: 'cyrene-proof-text' },
        }),
        error => error instanceof Error && error.message === 'summarization produced no text summary content',
      );
      assert.equal(adapter.calls.length, 1);
      assert.equal(adapter.calls[0]?.tools, undefined);
      assert.deepEqual(adapter.observations, [mode === 'tool-only'
        ? {
          blockTypeCounts: { 'tool-call': 1 },
          finishKinds: ['tool-calls'],
          reasoningLengths: [],
          textLengths: [],
          toolCallCount: 1,
          usage: [{ inputTokens: 41, outputTokens: 3, totalTokens: 44 }],
        }
        : {
          blockTypeCounts: { reasoning: 1 },
          finishKinds: ['stop'],
          reasoningLengths: [17],
          textLengths: [],
          toolCallCount: 0,
          usage: [{ inputTokens: 43, outputTokens: 5, totalTokens: 48 }],
        }]);
    } finally {
      await ctx.fiber.dispose();
    }
  });
}

test('Profile fixes a tool-triggered upstream summary failure without changing the input', async () => {
  const baseline = await summarizeWith(BasicCompactionEngine, 'tool-when-tools');
  const patched = await summarizeWith(NavigatorCompactionEngine, 'tool-when-tools');

  assert.equal(baseline.purpose, 'compaction');
  assert.equal(patched.purpose, 'compaction');
  assert.equal(baseline.toolCount, 1);
  assert.equal(patched.toolCount, 0);
  assert.equal(baseline.error?.message, 'summarization produced no text summary content');
  assert.equal(patched.error, undefined);
  assert.deepEqual(patched.result?.summary, [{ type: 'text', text: 'fixture checkpoint' }]);

  // These are the only response facts retained for the comparison: no text,
  // tool arguments, prompt, or complete request body enters the evidence.
  assert.deepEqual(baseline.observations, [{
    blockTypeCounts: { 'tool-call': 1 },
    finishKinds: ['tool-calls'],
    reasoningLengths: [],
    textLengths: [],
    toolCallCount: 1,
    usage: [{ inputTokens: 41, outputTokens: 3, totalTokens: 44 }],
  }]);
  assert.deepEqual(patched.observations, [{
    blockTypeCounts: { text: 1 },
    finishKinds: ['stop'],
    reasoningLengths: [],
    textLengths: [18],
    toolCallCount: 0,
    usage: [{ inputTokens: 47, outputTokens: 7, totalTokens: 54 }],
  }]);
  assert.deepEqual(patched.result?.usage, { inputTokens: 47, outputTokens: 7, totalTokens: 54 });
});
