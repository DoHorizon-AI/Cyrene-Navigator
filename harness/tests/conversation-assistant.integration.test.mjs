// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Static conversation-assistant host integration test         │
// │ Role: Verify actor-scoped memory hooks gate Web/Teams task delivery. │
// │ 模块职责：验证静态对话助手的来源授权与输出发送门。                      │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import { createExecutorApp } from '../dist/serve.js';
import CyreneSessionPersistence, { VOLATILE_CONVERSATION_SESSION_PREFIX } from '../dist/persistence.js';
import { InMemoryWorkStateStore } from '../dist/work-state-client.js';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const EXECUTOR_TOKEN = 'conversation-executor-test-token';
process.env.CYRENE_CONVERSATION_TEST_TOKEN = EXECUTOR_TOKEN;

class ConversationAdapter extends LlmAdapter {
  constructor() {
    super();
    this.summaryCalls = 0;
    this.prompts = [];
  }

  async *stream(options) {
    const isSummary = options.system?.startsWith('Summarize only durable facts') === true;
    if (isSummary) this.summaryCalls += 1;
    const content = options.messages?.at(-1)?.content?.[0]?.text ?? '';
    this.prompts.push(content);
    const currentMessage = content.split('Current user message:\n').at(-1) ?? content;
    const reply = isSummary ? `Durable summary: ${currentMessage.slice(0, 500)}` : `Answer for ${currentMessage}`;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: reply };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

function installConversationApi(store, { denyDelivery = false } = {}) {
  const calls = [];
  const messages = [];
  const memories = [];
  const deniedSources = new Set();
  let authorizationCalls = 0;
  store.getConversationMemoryOverview = async () => ({
    authorizationEpoch: 7,
    counts: { messages: 0, memories: 0, sources: 0 },
  });
  store.conversationMemoryApiV1 = actorId => {
    assert.equal(actorId, ACTOR_ID);
    return {
      apiVersion: 1,
      async createMessage(context, input) {
        calls.push(`message:${input.role}`);
        const message = {
          id: `message-${messages.length + 1}`,
          eventId: input.eventId,
          role: input.role,
          content: input.content,
          occurredAt: input.occurredAt ?? Date.now(),
          status: 'active',
          sourceRefs: input.sourceRefs ?? [],
          scope: {
            conversationId: input.conversationId,
            conversationKind: input.conversationKind,
            personaId: input.personaId,
            visibility: input.visibility,
          },
        };
        messages.push(message);
        return {
          duplicate: false,
          message,
        };
      },
      async listMessages() {
        calls.push('list-messages');
        return { items: [...messages].filter(message => message.status === 'active').reverse(), nextCursor: null };
      },
      async listMemories() {
        calls.push('list-memories');
        return { items: [...memories], authorizationEpoch: contextEpoch() };
      },
      async queryMemories() {
        calls.push('query-memories');
        return { items: [], authorizationEpoch: contextEpoch() };
      },
      async createMemory(context, input) {
        calls.push('create-memory');
        const memory = {
          id: `memory-${memories.length + 1}`,
          version: 1,
          kind: input.kind,
          text: input.text,
          sourceMessageIds: input.sourceMessageIds,
          sourceRefs: input.sourceRefs,
          state: 'active',
          scope: {
            conversationId: input.conversationId,
            conversationKind: input.conversationKind,
            personaId: input.personaId,
            visibility: input.visibility,
          },
        };
        memories.push(memory);
        return { memory, duplicate: false };
      },
      async updateMemory() { throw new Error('Unexpected memory update'); },
      async deleteMemory() { throw new Error('Unexpected memory deletion'); },
      async revokeSource(context, sourceId) {
        calls.push(`revoke:${sourceId}`);
        deniedSources.add(sourceId);
        for (const message of messages) {
          if (message.id === sourceId || message.sourceRefs.some(ref => ref.sourceMessageIds.includes(sourceId))) {
            message.status = 'revoked';
          }
        }
        return {
          sourceId,
          authorizationEpoch: context.authorizationEpoch + 1,
          invalidatedCount: 1,
          invalidatedMessageIds: [],
          invalidatedMemoryIds: [],
        };
      },
      async authorizeSources(context, input) {
        authorizationCalls += 1;
        calls.push(`authorize:${authorizationCalls}`);
        const deniedSourceIds = input.sourceRefs.flatMap(ref => ref.sourceMessageIds).filter(sourceId => deniedSources.has(sourceId));
        const allowed = deniedSourceIds.length === 0 && (!denyDelivery || authorizationCalls === 1);
        return {
          allowed,
          currentAuthorizationEpoch: context.authorizationEpoch,
          deniedSourceIds: denyDelivery && authorizationCalls > 1 && deniedSourceIds.length === 0
            ? ['revoked-source']
            : deniedSourceIds,
        };
      },
    };
  };
  return { calls, messages, memories, deniedSources };
}

function contextEpoch() { return 7; }

function webTurn(taskId, sessionId, prompt) {
  return {
    taskId,
    sessionId,
    prompt,
    conversationOrigin: { kind: 'web', conversationKind: 'direct' },
  };
}

async function makeApp(denyDelivery) {
  const store = new InMemoryWorkStateStore(ACTOR_ID);
  const { calls, messages, memories, deniedSources } = installConversationApi(store, { denyDelivery });
  const adapter = new ConversationAdapter();
  const app = await createExecutorApp({
    testMode: true,
    workStateStore: store,
    authTokenEnv: 'CYRENE_CONVERSATION_TEST_TOKEN',
    enableConversationAssistant: true,
    customLlmAdapter: { provider: 'conversation-test', adapter },
    model: 'conversation-test-v1',
  });
  return {
    app,
    store,
    calls,
    messages,
    memories,
    adapter,
    revokeSource: sourceId => {
      deniedSources.add(sourceId);
      for (const message of messages) {
        if (message.id === sourceId || message.sourceRefs.some(ref => ref.sourceMessageIds.includes(sourceId))) {
          message.status = 'revoked';
        }
      }
    },
  };
}

test('conversation assistant persists the user turn and emits text only after the final source check', async () => {
  const { app, store, calls } = await makeApp(false);
  const emitted = [];
  try {
    const outcome = await app.executor.executeTask(
      webTurn('conversation-approved', 'web-conversation-1', 'Remember the meeting is Friday.'),
      event => emitted.push(event),
    );
    assert.equal(outcome.status, 'completed');
    assert.ok(outcome.output.includes('Remember the meeting is Friday.'));
    assert.equal(outcome.reasoning, '');
    assert.deepEqual(calls, [
      'message:user',
      'list-messages',
      'query-memories',
      'authorize:1',
      'authorize:2',
      'message:assistant',
      'list-memories',
      'list-messages',
      'list-messages',
      'authorize:3',
    ]);
    const textEvents = emitted.filter(event => event.type === 'text-delta');
    assert.equal(textEvents.length, 1);
    assert.equal(textEvents[0].text, outcome.output);
    const task = await store.getTask(outcome.taskId);
    assert.equal(task.status, 'completed');
    assert.equal(task.output, outcome.output);
  } finally {
    await app.executor.dispose();
    await app.pluginManager?.dispose();
    await app.ctx.fiber.dispose();
  }
});

test('same-origin Web ingress creates an idempotent trusted chat task and exposes standard SSE URLs', async () => {
  const { app, messages } = await makeApp(false);
  const server = await app.executor.startServer(0, '127.0.0.1');
  try {
    const request = () => fetch(`${server.url}/api/v1/conversation-assistant/turns`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${EXECUTOR_TOKEN}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'web-turn-1',
      },
      body: JSON.stringify({ conversationId: 'browser-chat-1', text: 'The schedule is private.' }),
    });
    const accepted = await request();
    assert.equal(accepted.status, 202);
    const receipt = await accepted.json();
    assert.equal(receipt.conversationId, 'browser-chat-1');
    assert.match(receipt.taskId, /^conversation-[0-9a-f]{40}$/u);
    assert.match(receipt.sessionId, /^conversation-[0-9a-f]{40}$/u);
    assert.equal(receipt.eventsUrl, `/api/v1/tasks/${receipt.taskId}/events?after=0`);
    assert.equal(receipt.statusUrl, `/api/v1/tasks/${receipt.taskId}/status`);

    const duplicate = await request();
    assert.equal(duplicate.status, 202);
    assert.equal((await duplicate.json()).taskId, receipt.taskId);

    const invalid = await fetch(`${server.url}/api/v1/conversation-assistant/turns`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${EXECUTOR_TOKEN}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'web-turn-invalid',
      },
      body: JSON.stringify({ conversationId: 'browser-chat-1', personaId: 'spoofed', text: 'No.' }),
    });
    assert.equal(invalid.status, 400);

    let status;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${server.url}${receipt.statusUrl}`, {
        headers: { Authorization: `Bearer ${EXECUTOR_TOKEN}` },
      });
      status = await response.json();
      if (status.status === 'completed' || status.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(status.status, 'completed', status.error);
    assert.equal(messages[0].scope.conversationId, 'browser-chat-1');
    assert.equal(messages[0].scope.personaId, 'conversation-assistant');
  } finally {
    await server.close();
    await app.executor.dispose();
    await app.pluginManager?.dispose();
    await app.ctx.fiber.dispose();
  }
});

test('per-turn DSH sessions use a volatile persistence handle and never call the remote Session API', async () => {
  const context = new Context();
  await context.plugin(SessionStore);
  await context.plugin(CyreneSessionPersistence, {
    baseUrl: 'http://127.0.0.1:9',
    workspaceId: 'w1',
    tokenEnv: 'CYRENE_VOLATILE_SESSION_TOKEN',
    clientId: 'conversation-volatile-test',
    requestTimeoutMs: 500,
    heartbeatMs: 100,
    batchDelayMs: 0,
    maxPendingEvents: 16,
    batchSize: 16,
  });
  const session = context.sessions.create(SessionId(`${VOLATILE_CONVERSATION_SESSION_PREFIX}${randomUUID()}`));
  const handle = await context.sessionPersistence.create(session.header);
  await handle.flush();
  assert.equal(await context.sessionPersistence.stat(session.id), undefined);
  await handle.close();
  await context.fiber.dispose();
});

test('conversation assistant holds the generated reply when source authorization changes before delivery', async () => {
  const { app, store, messages } = await makeApp(true);
  const emitted = [];
  try {
    const outcome = await app.executor.executeTask(
      webTurn('conversation-held', 'web-conversation-2', 'Private source question.'),
      event => emitted.push(event),
    );
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.output, '');
    assert.equal(outcome.error, 'SOURCE_AUTHORIZATION_REVOKED');
    assert.equal(emitted.some(event => event.type === 'text-delta'), false);
    assert.equal(messages.filter(message => message.role === 'assistant').length, 0);
    const task = await store.getTask(outcome.taskId);
    assert.equal(task.status, 'failed');
    assert.equal(task.output, '');
  } finally {
    await app.executor.dispose();
    await app.pluginManager?.dispose();
    await app.ctx.fiber.dispose();
  }
});

test('a revoked prior conversation source is absent from the next temporary DSH session prompt', async () => {
  const { app, messages, adapter, revokeSource } = await makeApp(false);
  try {
    const first = await app.executor.executeTask(webTurn(
      'conversation-history-first',
      'web-revocation-session',
      'The launch phrase is CERULEAN-PINE-47.',
    ));
    assert.equal(first.status, 'completed');
    const originalUserMessageId = messages.find(message => message.role === 'user').id;
    revokeSource(originalUserMessageId);

    const second = await app.executor.executeTask(webTurn(
      'conversation-history-second',
      'web-revocation-session',
      'What did I mention earlier?',
    ));
    assert.equal(second.status, 'completed');
    assert.doesNotMatch(adapter.prompts.at(-1), /CERULEAN-PINE-47/u);
  } finally {
    await app.executor.dispose();
    await app.pluginManager?.dispose();
    await app.ctx.fiber.dispose();
  }
});

test('conversation assistant summaries use the active DSH model route and persist sourced episode memories', async () => {
  const { app, calls, memories, adapter } = await makeApp(false);
  try {
    const prompt = `Meeting details: ${'Friday with the design team. '.repeat(24)}`;
    for (let index = 0; index < 4; index += 1) {
      const outcome = await app.executor.executeTask(webTurn(
        `conversation-summary-${index}`,
        'web-summary-session',
        `${prompt} turn=${index}`,
      ));
      assert.equal(outcome.status, 'completed', outcome.error);
    }
    assert.equal(adapter.summaryCalls, 1);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].kind, 'episode');
    assert.ok(memories[0].sourceMessageIds.length >= 8);
    assert.ok(calls.includes('create-memory'));
  } finally {
    await app.executor.dispose();
    await app.pluginManager?.dispose();
    await app.ctx.fiber.dispose();
  }
});
