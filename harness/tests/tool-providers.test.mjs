// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Canonical tool-provider adapter fixtures                   │
// │ Role: Verify DSH registration, approval, receipts, and call scope. │
// │ 模块职责：验证 DSH 工具注册、人工审批、操作回执与调用范围。            │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { registerToolProviders } from '../dist/tool-providers.js';

const bindingId = 'wecom-primary';
const readToolId = 'contacts_search';
const writeToolId = 'send_message';
const sessionId = 'navigator-session-42';
const taskId = 'work-task-42';

const catalog = {
  items: [{ bindingId, capabilityId: 'tool.provider.v1' }],
};

const tools = {
  tools: [
    {
      id: readToolId,
      name: 'Search contacts',
      description: 'Search the configured WeCom directory.',
      inputSchema: {
        type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
      },
      readOnly: true,
    },
    {
      id: writeToolId,
      name: 'Send message',
      description: 'Send a message to one approved conversation.',
      inputSchema: {
        type: 'object', properties: { conversationId: { type: 'string' }, text: { type: 'string' } },
        required: ['conversationId', 'text'], additionalProperties: false,
      },
      readOnly: false,
    },
  ],
};

/** Small authenticated-bridge fixture with explicit task, approval, and receipt seams. */
function createBridgeFixture(options = {}) {
  const events = [];
  let beginCount = 0;
  let callCount = 0;
  const bridge = {
    async request(path, method, body, signal) {
      events.push({ type: 'request', path, method, body, signal });
      if (path === '/tool-providers' && method === 'GET') return catalog;
      if (path === `/tool-providers/${bindingId}/tools` && method === 'GET') return tools;
      if (path.endsWith(`/tools/${readToolId}/call`) && method === 'POST') {
        callCount += 1;
        return { content: [{ type: 'text', text: 'Found Ada Lovelace.' }], structuredContent: { count: 1 } };
      }
      if (path === `/operations/operation-${beginCount}` && method === 'PATCH') return { operation: { id: `operation-${beginCount}` } };
      throw new Error(`Unexpected bridge request ${method} ${path}`);
    },
    async requestApproval(actualSessionId, kind, summary, details, signal, messageId) {
      events.push({ type: 'approval', actualSessionId, kind, summary, details, signal, messageId });
      if (options.approvalError) throw options.approvalError;
      return { id: 'approval-42', status: 'approved' };
    },
    async mutate(execution, path, method, body, taskLinked = false) {
      events.push({ type: 'mutate', path, method, body, taskLinked, sessionId: execution.agent?.session.id });
      if (path === '/operations' && method === 'POST') {
        beginCount += 1;
        if (options.receipt) return options.receipt;
        return { operation: { id: `operation-${beginCount}`, status: 'started' }, duplicate: false };
      }
      if (path.endsWith(`/tools/${writeToolId}/call`) && method === 'POST') {
        callCount += 1;
        if (options.callError) throw options.callError;
        return { content: [{ type: 'text', text: 'Message delivered.' }], structuredContent: { messageId: 'message-42' } };
      }
      throw new Error(`Unexpected bridge mutation ${method} ${path}`);
    },
  };
  return { bridge, events, callCount: () => callCount };
}

async function createToolContext(bridgeFixture) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const dispose = await registerToolProviders(ctx, {
    bridge: bridgeFixture.bridge,
    taskIdForSession: id => id === sessionId ? taskId : undefined,
  });
  return { ctx, dispose };
}

function schemaFor(ctx, id) {
  const label = id === readToolId ? 'Search contacts' : 'Send message';
  return ctx.tools.schemas().find(item => item.description.startsWith(`${label} (configured provider ${bindingId})`));
}

function agent() {
  return { id: 'navigator-agent-42', session: { id: sessionId } };
}

async function execute(ctx, name, args, callId, withAgent = true) {
  return ctx.tools.execute({
    name,
    callId: ToolCallId(callId),
    arguments: args,
    signal: new AbortController().signal,
    ...(withAgent ? { agent: agent() } : {}),
  });
}

test('registers canonical read tools and routes calls through the configured binding', async () => {
  const fixture = createBridgeFixture();
  const { ctx, dispose } = await createToolContext(fixture);
  try {
    const schemas = ctx.tools.schemas();
    const schema = schemas.find(item => item.description.startsWith(`Search contacts (configured provider ${bindingId})`));
    assert.ok(schema);
    assert.equal(schema.parameters.properties.query.type, 'string');
    const name = schema.name;
    const result = await execute(ctx, name, { query: 'Ada' }, 'read-call-1', false);

    assert.equal(result.isError, false);
    assert.deepEqual(result.value, {
      content: [{ type: 'text', text: 'Found Ada Lovelace.' }],
      structuredContent: { count: 1 },
    });
    assert.equal(fixture.callCount(), 1);
    assert.equal(fixture.events.some(event => event.type === 'approval' || event.path === '/operations'), false);
    assert.ok(fixture.events.some(event => event.path === `/tool-providers/${bindingId}/tools/${readToolId}/call`));
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('write tools await approval, create a task-linked receipt, then call and verify', async () => {
  const fixture = createBridgeFixture();
  const { ctx, dispose } = await createToolContext(fixture);
  try {
    const schema = schemaFor(ctx, writeToolId);
    assert.ok(schema);
    const args = { conversationId: 'team-chat-9', text: 'Deployment completed.' };
    const result = await execute(ctx, schema.name, args, 'write-call-7');

    assert.equal(result.isError, false);
    assert.deepEqual(result.value, {
      content: [{ type: 'text', text: 'Message delivered.' }],
      structuredContent: { messageId: 'message-42' },
    });
    const approval = fixture.events.find(event => event.type === 'approval');
    const receipt = fixture.events.find(event => event.type === 'mutate' && event.path === '/operations');
    const call = fixture.events.find(event => event.type === 'mutate' && event.path.endsWith(`/tools/${writeToolId}/call`));
    const verification = fixture.events.find(event => event.type === 'request' && event.path.startsWith('/operations/'));
    assert.equal(approval.actualSessionId, sessionId);
    assert.equal(approval.kind, 'tool.provider.v1');
    assert.deepEqual(approval.details, { bindingId, toolId: writeToolId, arguments: args });
    assert.ok(fixture.events.indexOf(approval) < fixture.events.indexOf(receipt));
    assert.ok(fixture.events.indexOf(receipt) < fixture.events.indexOf(call));
    assert.equal(receipt.body.taskId, taskId);
    assert.equal(receipt.taskLinked, true);
    assert.equal(call.taskLinked, false);
    assert.equal(call.sessionId, sessionId);
    assert.equal(JSON.parse(JSON.stringify(verification.body)).status, 'verified');
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('approval rejection prevents operation receipt creation and provider call', async () => {
  const fixture = createBridgeFixture({ approvalError: new Error('The human rejected this operation') });
  const { ctx, dispose } = await createToolContext(fixture);
  try {
    const schema = schemaFor(ctx, writeToolId);
    assert.ok(schema);
    const result = await execute(ctx, schema.name, { conversationId: 'team-chat-9', text: 'No send.' }, 'rejected-call');

    assert.equal(result.isError, true);
    assert.equal(fixture.events.some(event => event.type === 'mutate' || event.path?.includes('/operations/')), false);
    assert.equal(fixture.callCount(), 0);
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('uncertain receipts stop retries after a provider call failure', async () => {
  const fixture = createBridgeFixture({ callError: new Error('unavailable') });
  const { ctx, dispose } = await createToolContext(fixture);
  try {
    const schema = schemaFor(ctx, writeToolId);
    assert.ok(schema);
    const args = { conversationId: 'team-chat-9', text: 'May have been sent.' };
    const first = await execute(ctx, schema.name, args, 'same-write-call');
    assert.equal(first.isError, true);
    assert.match(first.error.message, /uncertain/u);
    const uncertain = fixture.events.find(event => event.type === 'request' && event.method === 'PATCH');
    assert.deepEqual(uncertain.body, {
      status: 'uncertain', evidence: { outcome: 'unknown_after_provider_call' },
    });

    fixture.bridge.mutate = async (execution, path, method, body, taskLinked = false) => {
      fixture.events.push({ type: 'mutate', path, method, body, taskLinked, sessionId: execution.agent?.session.id });
      if (path === '/operations' && method === 'POST') {
        return { operation: { id: 'operation-existing', status: 'uncertain' }, duplicate: true };
      }
      throw new Error(`Unexpected replay ${method} ${path}`);
    };
    const retry = await execute(ctx, schema.name, args, 'same-write-call');
    assert.equal(retry.isError, true);
    assert.match(retry.error.message, /reconcile/u);
    assert.equal(fixture.callCount(), 1);
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});
