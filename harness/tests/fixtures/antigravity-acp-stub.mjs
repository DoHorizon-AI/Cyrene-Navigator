// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 antigravity-acp-stub.mjs                                        │
// │  Module: harness/tests/fixtures/antigravity-acp-stub                 │
// │  Role: Simulate official ACP v1 setup, permissions, and MCP calls.    │
// │                                                                      │
// │  模块职责：用确定性 fake 覆盖官方 ACP v1 会话、权限和 MCP 协议边界。│
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
function option(name, fallback) {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
}

const mode = option('--fixture-mode', 'authorized');
const selectedModelForResume = option('--fixture-selected-model', 'gemini-test-native');
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const inputIterator = input[Symbol.asyncIterator]();
let nextRequestId = 0;
let activeSessionId;
let mcpServer;
let selectedModel = 'gemini-3.8-flash';

function writeFrame(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readFrame() {
  const next = await inputIterator.next();
  if (next.done) throw new Error('ACP client closed stdio');
  return JSON.parse(next.value);
}

async function receiveClientResponse(id) {
  for (;;) {
    const frame = await readFrame();
    if (frame.id === id && (Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error'))) return frame;
    if (frame.method === 'session/cancel') return { jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } };
  }
}

async function requestPermission(toolCall) {
  const id = `permission-${++nextRequestId}`;
  writeFrame({
    jsonrpc: '2.0', id, method: 'session/request_permission',
    params: {
      sessionId: activeSessionId,
      options: [
        { optionId: 'allow-always', name: 'Allow Always', kind: 'allow_always' },
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
      toolCall,
    },
  });
  const response = await receiveClientResponse(id);
  if (response.error !== undefined) throw new Error('Navigator rejected the ACP permission request');
  return response.result?.outcome;
}

function modelOptions(value = selectedModel) {
  return [{
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: value,
    options: [
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { value: 'gemini-test-native', name: 'Native fixture model' },
    ],
  }];
}

function validateSessionRequest(params) {
  assert.equal(params._meta?.antigravity?.enabledTools?.length, 0,
    'Navigator must disable all native built-in tools through the official filter');
  assert.equal(params.mcpServers?.length, 1, 'only the task-local Navigator MCP server is supplied');
  mcpServer = params.mcpServers[0];
  assert.equal(mcpServer.name, 'navigator');
  assert.equal(typeof mcpServer.command, 'string');
  assert.ok(Array.isArray(mcpServer.args));
  assert.ok(Array.isArray(mcpServer.env));
  assert.equal(mcpServer.type, undefined, 'ACP v1 stdio uses the baseline untagged shape');
}

async function withNavigatorMcp(action) {
  const env = { ...process.env };
  for (const entry of mcpServer.env) env[entry.name] = entry.value;
  const server = spawn(mcpServer.command, [...mcpServer.args], {
    cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const output = createInterface({ input: server.stdout, crlfDelay: Infinity });
  const outputIterator = output[Symbol.asyncIterator]();
  let requestId = 0;
  const request = async (method, params) => {
    const id = ++requestId;
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (;;) {
      const next = await outputIterator.next();
      if (next.done) throw new Error('Navigator MCP sidecar closed stdout');
      const frame = JSON.parse(next.value);
      if (frame.id !== id) continue;
      if (frame.error !== undefined) throw new Error(`MCP request failed with ${frame.error.code}`);
      return frame.result;
    }
  };
  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'antigravity-fixture', version: '1.4.5' },
    });
    assert.equal(initialized.protocolVersion, '2025-06-18');
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await request('tools/list', {});
    return await action({
      tools: listed.tools,
      call: (name, args) => request('tools/call', { name, arguments: args }),
    });
  } finally {
    output.close();
    const exited = server.exitCode !== null || server.signalCode !== null
      ? Promise.resolve()
      : once(server, 'exit');
    server.stdin.end();
    const timer = setTimeout(() => server.kill('SIGTERM'), 1_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
}

async function handlePrompt(params) {
  const envIsolated = process.env.GEMINI_API_KEY === undefined
    && process.env.GOOGLE_API_KEY === undefined
    && process.env.CODEBUDDY_API_KEY === undefined
    && process.env.CYRENE_SESSION_TOKEN === undefined
    && process.env.NAVIGATOR_ACP_BRIDGE_TOKEN === undefined;
  if (!envIsolated) throw new Error('Native ACP child received a provider or host credential environment variable');

  if (mode === 'resume') {
    writeFrame({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: activeSessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'RESTORED_NATIVE_SESSION' } } },
    });
    return { stopReason: 'end_turn' };
  }
  if (mode === 'partial') {
    writeFrame({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: activeSessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PARTIAL_NATIVE_OUTPUT' } } },
    });
    return { stopReason: 'max_tokens' };
  }
  if (mode === 'cancel') {
    writeFrame({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: activeSessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'READY_FOR_CANCEL' } } },
    });
    for (;;) {
      const frame = await readFrame();
      if (frame.method === 'session/cancel' && frame.params?.sessionId === activeSessionId) {
        return { stopReason: 'cancelled' };
      }
    }
  }
  if (mode === 'model-drift') {
    writeFrame({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: { sessionUpdate: 'config_option_update', configOptions: modelOptions('gemini-3.8-flash') },
      },
    });
    return { stopReason: 'end_turn' };
  }

  const forged = await requestPermission({
    toolCallId: 'forged-native-tool',
    kind: 'execute',
    title: 'navigator_exchange_issue_query',
    rawInput: { serverName: 'navigator', toolName: 'exchange_issue_query' },
  });
  assert.equal(forged?.optionId, 'reject-once', 'title and rawInput never establish native MCP identity');

  const missingMarker = await requestPermission({
    toolCallId: 'missing-native-marker',
    kind: 'other',
    _meta: { mcp: { server: 'navigator', tool: 'exchange_issue_query' } },
  });
  assert.equal(missingMarker?.optionId, 'reject-once', 'provider MCP fields without the native marker are denied');

  const foreign = await requestPermission({
    toolCallId: 'foreign-native-server',
    kind: 'other',
    _meta: { mcp: { server: 'other', tool: 'exchange_issue_query' }, is_mcp_tool_call: true },
  });
  assert.equal(foreign?.optionId, 'reject-once', 'a foreign MCP server is denied');

  const unknown = await requestPermission({
    toolCallId: 'unknown-native-tool',
    kind: 'other',
    _meta: { mcp: { server: 'navigator', tool: 'not_in_catalog' }, is_mcp_tool_call: true },
  });
  assert.equal(unknown?.optionId, 'reject-once', 'a tool outside the live catalog is denied');

  const allowed = await requestPermission({
    toolCallId: 'catalog-native-tool',
    kind: 'other',
    _meta: { mcp: { server: 'navigator', tool: 'exchange_issue_query' }, is_mcp_tool_call: true },
  });
  assert.equal(allowed?.optionId, 'allow-once', 'the catalog-matched Navigator MCP tool is allowed once');

  const toolResult = await withNavigatorMcp(async client => {
    assert.ok(client.tools.some(tool => tool.name === 'exchange_issue_query'));
    return client.call('exchange_issue_query', { query: 'fixture' });
  });
  const resultText = toolResult.content?.find(block => block.type === 'text')?.text ?? 'missing MCP result';
  writeFrame({
    jsonrpc: '2.0', method: 'session/update',
    params: {
      sessionId: activeSessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `NATIVE_MCP_RESULT:${resultText};ISOLATED:${envIsolated}` },
      },
    },
  });
  return { stopReason: 'end_turn' };
}

for (;;) {
  let frame;
  try { frame = await readFrame(); } catch { break; }
  if (frame.jsonrpc !== '2.0' || typeof frame.method !== 'string') continue;
  const params = frame.params ?? {};
  switch (frame.method) {
    case 'initialize':
      writeFrame({
        jsonrpc: '2.0', id: frame.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'antigravity-acp', title: 'Google Antigravity', version: '1.4.5' },
          agentCapabilities: {
            loadSession: true,
            mcpCapabilities: { http: false, sse: false },
            sessionCapabilities: { list: {}, resume: {} },
            _meta: { antigravity: { systemPrompt: { append: true } } },
          },
          authMethods: [],
        },
      });
      break;
    case 'session/new':
      try {
        validateSessionRequest(params);
        activeSessionId = 'native-antigravity-session-1';
        selectedModel = 'gemini-3.8-flash';
        writeFrame({ jsonrpc: '2.0', id: frame.id, result: { sessionId: activeSessionId, configOptions: modelOptions() } });
      } catch {
        writeFrame({ jsonrpc: '2.0', id: frame.id, error: { code: -32602, message: 'Session fixture rejected setup.' } });
      }
      break;
    case 'session/load':
      try {
        validateSessionRequest(params);
        assert.equal(params.sessionId, 'native-antigravity-session-1');
        activeSessionId = params.sessionId;
        selectedModel = selectedModelForResume;
        writeFrame({ jsonrpc: '2.0', id: frame.id, result: { configOptions: modelOptions() } });
      } catch {
        writeFrame({ jsonrpc: '2.0', id: frame.id, error: { code: -32602, message: 'Session fixture rejected restore.' } });
      }
      break;
    case 'session/set_config_option':
      assert.equal(params.configId, 'model');
      assert.equal(params.value, 'gemini-test-native');
      assert.equal(params.type, undefined, 'ACP v1 config-option requests carry value without a v2 type tag');
      selectedModel = params.value;
      writeFrame({ jsonrpc: '2.0', id: frame.id, result: { configOptions: modelOptions() } });
      break;
    case 'session/prompt':
      try {
        const result = await handlePrompt(params);
        writeFrame({ jsonrpc: '2.0', id: frame.id, result });
      } catch {
        writeFrame({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: 'Prompt fixture failed.' } });
      }
      break;
    case 'session/cancel':
      writeFrame({ jsonrpc: '2.0', id: frame.id, result: {} });
      break;
    default:
      writeFrame({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found.' } });
  }
}
