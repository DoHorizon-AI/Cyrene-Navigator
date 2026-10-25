// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 codebuddy-acp-stub.mjs                                           │
// │  Module: harness/tests/fixtures/codebuddy-acp-stub                   │
// │  Role: Exercise ACP, MCP, session, and process boundaries locally.   │
// │                                                                      │
// │  模块职责：在本机 stub 中验证 ACP/MCP、会话恢复与进程边界。            │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { createInterface } from 'node:readline';

const fixtureMode = valueAfter('--fixture-mode') ?? 'tool';
const turn = valueAfter('--fixture-turn') ?? 'first';
const configPath = valueAfter('--mcp-config');
const configIndex = process.argv.indexOf('--mcp-config');
const toolFlagIndex = process.argv.indexOf('--tools');
let navigatorServer;
let bootstrapStage = 'arguments';

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  assert.ok(configPath);
  assert.ok(process.argv.includes('--acp'));
  assert.ok(process.argv.includes('--acp-transport'));
  assert.equal(valueAfter('--acp-transport'), 'stdio');
  assert.ok(process.argv.includes('--agent'));
  assert.equal(valueAfter('--agent'), 'cli');
  assert.equal(valueAfter('--setting-sources'), 'project,local');
  assert.equal(valueAfter('--settings'), JSON.stringify({ disableAllHooks: true, enabledPlugins: {} }));
  assert.ok(process.argv.includes('--strict-mcp-config'));
  assert.equal(basename(process.cwd()), 'navigator-acp-workspace');
  assert.equal(dirname(dirname(configPath)), process.cwd());
  const configRelativePath = relative(process.cwd(), configPath);
  assert.equal(isAbsolute(configRelativePath), false);
  assert.equal(configRelativePath.startsWith('..'), false);
  bootstrapStage = 'tool flags';
  assert.ok(toolFlagIndex >= 0 && process.argv[toolFlagIndex + 1] === '');
  assert.ok(configIndex >= 0 && process.argv[configIndex + 1] === configPath);

  bootstrapStage = 'private config path';
  const configInfo = lstatSync(configPath);
  const directoryInfo = lstatSync(dirname(configPath));
  const childHome = join(dirname(process.cwd()), 'navigator-cli-home');
  const homeInfo = lstatSync(childHome);
  assert.equal(configInfo.isSymbolicLink(), false);
  assert.equal(directoryInfo.isSymbolicLink(), false);
  assert.equal(homeInfo.isSymbolicLink(), false);
  assert.equal(configInfo.isFile(), true);
  assert.equal(directoryInfo.isDirectory(), true);
  assert.equal(homeInfo.isDirectory(), true);
  assert.equal(configInfo.mode & 0o077, 0);
  assert.equal(directoryInfo.mode & 0o077, 0);
  assert.equal(homeInfo.mode & 0o077, 0);
  bootstrapStage = 'MCP config';
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(Object.keys(config.mcpServers ?? {}), ['navigator']);
  navigatorServer = config.mcpServers.navigator;
  assert.equal(navigatorServer.type, 'stdio');
  assert.equal(navigatorServer.alwaysLoad, true);
  assert.equal(typeof navigatorServer.env.NAVIGATOR_ACP_BRIDGE_TOKEN, 'string');
  assert.ok(!process.argv.join(' ').includes(navigatorServer.env.NAVIGATOR_ACP_BRIDGE_TOKEN));
  bootstrapStage = 'environment';
  assert.equal(process.env.CYRENE_SESSION_TOKEN, undefined);
  assert.equal(process.env.CYRENE_EXCHANGE_TOKEN, undefined);
  assert.equal(process.env.TEAMS_NAVIGATOR_HMAC_KEY, undefined);
  assert.equal(process.env.DIRECTORY_DATABASE_PASSWORD, undefined);
  assert.equal(process.env.DOCKER_HOST, undefined);
  assert.equal(process.env.GLM_API_KEY, undefined);
  assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(process.env.CODEBUDDY_API_KEY, undefined);
  assert.equal(process.env.HOME, childHome);
  assert.equal(process.env.USERPROFILE, childHome);
  assert.equal(process.env.CODEBUDDY_CONFIG_DIR, dirname(process.cwd()));
  assert.equal(process.env.XDG_CONFIG_HOME, join(childHome, '.config'));
  assert.equal(process.env.XDG_CACHE_HOME, join(childHome, '.cache'));
  assert.equal(process.env.XDG_DATA_HOME, join(childHome, '.local', 'share'));
  assert.equal(process.env.XDG_STATE_HOME, join(childHome, '.local', 'state'));
} catch {
  process.stderr.write(`ACP fixture bootstrap failed at ${bootstrapStage}\n`);
  process.exit(41);
}

const peerRequests = new Map();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let nextId = 1;
let promptRequest;
let nativeSessionId = 'native-session-1';
let loadedSession;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function request(method, params) {
  const id = `stub-${nextId++}`;
  return new Promise((resolve, reject) => {
    peerRequests.set(String(id), { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { process.exit(42); return; }
  if (message.method === undefined) {
    const pending = peerRequests.get(String(message.id));
    if (!pending) return;
    peerRequests.delete(String(message.id));
    if (message.error) pending.reject(new Error('ACP request rejected'));
    else pending.resolve(message.result);
    return;
  }
  void handleAgentRequest(message);
});

async function handleAgentRequest(message) {
  switch (message.method) {
    case 'initialize':
      assert.deepEqual(message.params.clientCapabilities, {});
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      } });
      return;
    case 'session/new':
      assert.deepEqual(message.params.mcpServers, []);
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: nativeSessionId } });
      return;
    case 'session/load':
      loadedSession = message.params.sessionId;
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    case 'session/prompt':
      await handlePrompt(message);
      return;
    case 'session/cancel':
      if (promptRequest !== undefined) {
        if (fixtureMode === 'reauth') {
          send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: message.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'AUTHORIZATION_PAUSE_CANCELLED' } },
          } });
        }
        send({ jsonrpc: '2.0', id: promptRequest, result: { stopReason: 'cancelled' } });
        promptRequest = undefined;
      }
      return;
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported fixture request' } });
  }
}

async function handlePrompt(message) {
  promptRequest = message.id;
  if (fixtureMode === 'eof') process.exit(0);
  if (fixtureMode === 'nonzero') process.exit(17);
  if (fixtureMode === 'cancel') {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: message.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'READY_FOR_CANCEL' } },
    } });
    return;
  }
  if (fixtureMode === 'nonzero-after-response') {
    send({ jsonrpc: '2.0', id: promptRequest, result: { stopReason: 'end_turn' } });
    promptRequest = undefined;
    setTimeout(() => process.exit(17), 25);
    return;
  }
  const requestText = message.params.prompt?.[0]?.text ?? '';
  assert.equal(requestText.includes(navigatorServer.env.NAVIGATOR_ACP_BRIDGE_TOKEN), false);
  if (turn === 'first') {
    assert.match(requestText, /No previous DSH conversation history was imported/u);
  } else {
    assert.equal(loadedSession, 'native-session-1');
    assert.doesNotMatch(requestText, /No previous DSH conversation history was imported/u);
  }
  const permission = await request('session/request_permission', {
    sessionId: message.params.sessionId,
    toolCall: { kind: 'terminal', title: 'Bash', rawInput: { command: 'printf denied' } },
    options: [
      { kind: 'allow_once', optionId: 'allow' },
      { kind: 'reject_once', optionId: 'reject' },
    ],
  });
  assert.equal(permission.outcome.optionId, 'reject');

  if (fixtureMode === 'unauthorized' || fixtureMode === 'guarded') {
    const denied = await exerciseMcpClient({ includeExchange: false, expectComputerError: true });
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: message.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `connector denied=${denied.knownDenied}` } },
    } });
    send({ jsonrpc: '2.0', id: promptRequest, result: { stopReason: 'end_turn' } });
    promptRequest = undefined;
    return;
  }

  if (fixtureMode === 'reauth') {
    const result = await exerciseMcpClient({ includeComputer: false, includeUnknown: false });
    assert.equal(result.exchangeDenied, false);
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: message.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAITING_FOR_AUTHORIZATION' } },
    } });
    return;
  }

  if (fixtureMode === 'reauth-slow-tool') {
    await exerciseMcpClient({ parallelAuthorizedTools: true, includeUnknown: false });
    return;
  }

  if (fixtureMode === 'slow-tool') {
    await exerciseMcpClient({ includeExchange: false, includeUnknown: false });
    send({ jsonrpc: '2.0', id: promptRequest, result: { stopReason: 'end_turn' } });
    promptRequest = undefined;
    return;
  }

  if (turn === 'first') {
    const toolResult = await exerciseMcpClient();
    const hostPermission = await request('session/request_permission', {
      sessionId: message.params.sessionId,
      toolCall: { kind: 'mcp', rawInput: { serverName: 'navigator', toolName: toolResult.toolName } },
      options: [
        { kind: 'allow_once', optionId: 'allow-host' },
        { kind: 'reject_once', optionId: 'reject-host' },
      ],
    });
    assert.equal(hostPermission.outcome.optionId, 'allow-host');
    const unknownMcpPermission = await request('session/request_permission', {
      sessionId: message.params.sessionId,
      toolCall: { kind: 'mcp', rawInput: { serverName: 'navigator', toolName: 'shell' } },
      options: [
        { kind: 'allow_once', optionId: 'allow-unknown' },
        { kind: 'reject_once', optionId: 'reject-unknown' },
      ],
    });
    assert.equal(unknownMcpPermission.outcome.optionId, 'reject-unknown');
    const extraMcpPermission = await request('session/request_permission', {
      sessionId: message.params.sessionId,
      toolCall: { kind: 'mcp', rawInput: { serverName: 'personal', toolName: toolResult.toolName } },
      options: [
        { kind: 'allow_once', optionId: 'allow-extra' },
        { kind: 'reject_once', optionId: 'reject-extra' },
      ],
    });
    assert.equal(extraMcpPermission.outcome.optionId, 'reject-extra');
    const responseText = `MCP result: ${toolResult.text}; ${toolResult.exchangeText}; unknown denied=${toolResult.unknownDenied}; permission denied=${toolResult.permissionDenied}; host MCP allow once=${hostPermission.outcome.optionId === 'allow-host'}; unknown MCP denied=${unknownMcpPermission.outcome.optionId === 'reject-unknown'}; extra MCP denied=${extraMcpPermission.outcome.optionId === 'reject-extra'}`;
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: message.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: responseText } },
    } });
  } else {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: message.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Restored ${loadedSession}` } },
    } });
  }
  send({ jsonrpc: '2.0', id: promptRequest, result: { stopReason: 'end_turn' } });
  promptRequest = undefined;
}

async function exerciseMcpClient({
  includeExchange = true,
  includeComputer = true,
  expectComputerError = false,
  includeUnknown = true,
  parallelAuthorizedTools = false,
} = {}) {
  const server = spawn(navigatorServer.command, navigatorServer.args, {
    cwd: process.cwd(),
    env: { ...process.env, ...navigatorServer.env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: server.stdout, crlfDelay: Infinity });
  const pending = new Map();
  lines.on('line', line => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const entry = pending.get(String(response.id));
    if (!entry) return;
    pending.delete(String(response.id));
    if (response.error) entry.reject(new Error('MCP request failed'));
    else entry.resolve(response.result);
  });
  const call = (id, method, params = {}) => new Promise((resolve, reject) => {
    pending.set(String(id), { resolve, reject });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const initialize = await call(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' },
  });
  assert.equal(initialize.serverInfo.name, 'navigator-authorized-tools');
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const catalog = await call(2, 'tools/list');
  assert.equal(catalog.tools.length, 2);
  const computerTool = catalog.tools.find(tool => tool.description.includes('host-authorized computer workspace'));
  assert.ok(computerTool);
  const computerCall = () => call(3, 'tools/call', {
    name: computerTool.name,
    arguments: { path: '/workspace/result.txt', content: 'from CodeBuddy ACP' },
  });
  const exchangeCall = () => call(4, 'tools/call', {
    name: 'exchange_issue_query', arguments: { query: 'owner/repo#1' },
  });
  let known;
  let exchange;
  if (parallelAuthorizedTools && includeComputer && includeExchange) {
    [known, exchange] = await Promise.all([computerCall(), exchangeCall()]);
  } else {
    known = includeComputer ? await computerCall() : undefined;
    exchange = includeExchange ? await exchangeCall() : undefined;
  }
  if (known !== undefined) assert.equal(known.isError, expectComputerError);
  if (exchange !== undefined) assert.equal(exchange.isError, false);
  const unknown = includeUnknown ? await call(5, 'tools/call', {
    name: 'shell', arguments: { command: 'touch /tmp/forbidden' },
  }) : undefined;
  if (unknown !== undefined) assert.equal(unknown.isError, true);
  server.stdin.end();
  await new Promise(resolve => server.once('exit', resolve));
  return {
    text: known?.content[0].text ?? '',
    toolName: computerTool.name,
    exchangeText: exchange?.content[0].text ?? '',
    knownDenied: known?.isError === true,
    exchangeDenied: exchange?.isError === true,
    unknownDenied: unknown?.isError === true,
    permissionDenied: true,
  };
}
