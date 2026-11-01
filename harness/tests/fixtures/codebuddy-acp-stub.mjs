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
let cliNavigatorServer;
let sessionNavigatorServer;
let bootstrapStage = 'arguments';

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function useSessionMcpServers(value) {
  assert.ok(Array.isArray(value), 'ACP session setup must provide an MCP server array');
  assert.equal(value.length, 1, 'the session must expose only the Navigator MCP server');
  const server = value[0];
  assert.ok(server && typeof server === 'object' && !Array.isArray(server));
  assert.equal(Object.keys(server).sort().join(','), 'args,command,env,name',
    'the session must use only the standard ACP v1 stdio server fields');
  assert.equal(server.name, 'navigator');
  assert.equal(server.command, process.execPath);
  assert.ok(Array.isArray(server.args) && server.args.length === 1);
  assert.ok(isAbsolute(server.args[0]) && basename(server.args[0]) === 'acp-mcp-stdio.js');
  assert.ok(Array.isArray(server.env));
  const environmentNames = server.env.map(entry => entry?.name).sort();
  assert.deepEqual(environmentNames, ['NAVIGATOR_ACP_BRIDGE_TOKEN', 'NAVIGATOR_ACP_BRIDGE_URL']);
  const environment = Object.fromEntries(server.env.map(entry => [entry.name, entry.value]));
  assert.ok(typeof environment.NAVIGATOR_ACP_BRIDGE_URL === 'string'
    && environment.NAVIGATOR_ACP_BRIDGE_URL.startsWith('http://127.0.0.1:'));
  assert.ok(typeof environment.NAVIGATOR_ACP_BRIDGE_TOKEN === 'string'
    && environment.NAVIGATOR_ACP_BRIDGE_TOKEN.length >= 32);
  assert.ok(environment.NAVIGATOR_ACP_BRIDGE_TOKEN
    === cliNavigatorServer.env.NAVIGATOR_ACP_BRIDGE_TOKEN,
  'the ACP session and private CLI config must point at the same task-scoped bridge');
  assert.ok(environment.NAVIGATOR_ACP_BRIDGE_URL
    === cliNavigatorServer.env.NAVIGATOR_ACP_BRIDGE_URL,
  'the ACP session and private CLI config must point at the same task-scoped bridge');
  assert.equal(process.argv.join(' ').includes(environment.NAVIGATOR_ACP_BRIDGE_TOKEN), false,
    'the bridge token must not be copied into process arguments');
  sessionNavigatorServer = server;
}

try {
  assert.ok(configPath);
  assert.ok(process.argv.includes('--acp'));
  assert.ok(process.argv.includes('--acp-transport'));
  assert.equal(valueAfter('--acp-transport'), 'stdio');
  assert.ok(process.argv.includes('--agent'));
  assert.equal(valueAfter('--agent'), 'cli');
  assert.equal(valueAfter('--setting-sources'), 'project,local');
  const settings = JSON.parse(valueAfter('--settings'));
  assert.deepEqual(settings, { disableAllHooks: true, enabledPlugins: {}, deferToolLoading: false });
  assert.equal(settings.deferToolLoading, false);
  assert.equal(valueAfter('--permission-mode'), 'default');
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
  cliNavigatorServer = config.mcpServers.navigator;
  assert.equal(cliNavigatorServer.type, 'stdio');
  assert.equal(cliNavigatorServer.alwaysLoad, true);
  assert.equal(cliNavigatorServer.defer_loading, false);
  assert.equal(typeof cliNavigatorServer.env.NAVIGATOR_ACP_BRIDGE_TOKEN, 'string');
  assert.ok(!process.argv.join(' ').includes(cliNavigatorServer.env.NAVIGATOR_ACP_BRIDGE_TOKEN));
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
  assert.equal(process.env.CODEBUDDY_HOME, undefined);
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
      useSessionMcpServers(message.params.mcpServers);
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: nativeSessionId } });
      return;
    case 'session/load':
      useSessionMcpServers(message.params.mcpServers);
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
  const bridgeToken = sessionNavigatorServer.env.find(item => item.name === 'NAVIGATOR_ACP_BRIDGE_TOKEN')?.value;
  assert.equal(typeof bridgeToken, 'string');
  assert.equal(requestText.includes(bridgeToken), false, 'the bridge token must not enter the model prompt');
  if (turn === 'first') {
    assert.match(requestText, /No previous DSH conversation history was imported/u);
  } else {
    assert.equal(loadedSession, 'native-session-1');
    assert.doesNotMatch(requestText, /No previous DSH conversation history was imported/u);
  }
  assert.match(requestText, /Navigator evidence and retry policy \(behavior guidance, not a runtime guarantee\)/u);
  assert.match(requestText, /An error or is_error tool result proves only that the observation failed/u);
  assert.match(requestText, /A retryable:false result means stop/u);
  assert.match(requestText, /Do not infer commit ancestry, merge reachability, CI outcome/u);
  assert.match(requestText, /Keep connector binding or connection UUIDs distinct from provider resource IDs/u);
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
    const nativeMcpPermissions = [];
    for (const kind of [undefined, 'read', 'fetch', 'search', 'other', 'execute']) {
      const toolCall = {
        toolCallId: `native-mcp-${kind ?? 'missing-kind'}`,
        rawInput: { serverName: 'untrusted-argument', toolName: 'shell' },
        _meta: { 'codebuddy.ai/toolName': `mcp__navigator__${toolResult.toolName}` },
      };
      if (kind !== undefined) toolCall.kind = kind;
      const permission = await request('session/request_permission', {
        sessionId: message.params.sessionId,
        toolCall,
        options: [
          { kind: 'allow_once', optionId: 'allow-native-mcp' },
          { kind: 'reject_once', optionId: 'reject-native-mcp' },
        ],
      });
      assert.equal(permission.outcome.optionId, 'allow-native-mcp');
      nativeMcpPermissions.push(permission);
    }
    const nativeMcpWithoutAllowOnce = await request('session/request_permission', {
      sessionId: message.params.sessionId,
      toolCall: {
        toolCallId: 'native-mcp-without-allow-once',
        rawInput: {},
        _meta: { 'codebuddy.ai/toolName': `mcp__navigator__${toolResult.toolName}` },
      },
      options: [{ kind: 'reject_once', optionId: 'reject-native-mcp-without-allow-once' }],
    });
    assert.equal(nativeMcpWithoutAllowOnce.outcome.optionId, 'reject-native-mcp-without-allow-once');
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
    const spoofedNativePermission = await request('session/request_permission', {
      sessionId: message.params.sessionId,
      toolCall: {
        toolCallId: 'native-mcp-business-arguments-spoof',
        kind: 'other',
        rawInput: { serverName: 'navigator', toolName: toolResult.toolName },
      },
      options: [
        { kind: 'allow_once', optionId: 'allow-spoofed-native' },
        { kind: 'reject_once', optionId: 'reject-spoofed-native' },
      ],
    });
    assert.equal(spoofedNativePermission.outcome.optionId, 'reject-spoofed-native');
    const foreignServerPermission = await request('session/request_permission', {
      sessionId: message.params.sessionId,
      toolCall: {
        toolCallId: 'native-mcp-foreign-server',
        kind: 'mcp',
        rawInput: { serverName: 'navigator', toolName: toolResult.toolName },
        _meta: { 'codebuddy.ai/toolName': `mcp__personal__${toolResult.toolName}` },
      },
      options: [
        { kind: 'allow_once', optionId: 'allow-foreign-server' },
        { kind: 'reject_once', optionId: 'reject-foreign-server' },
      ],
    });
    assert.equal(foreignServerPermission.outcome.optionId, 'reject-foreign-server');
    const unknownNavigatorToolPermission = await request('session/request_permission', {
      sessionId: message.params.sessionId,
      toolCall: {
        toolCallId: 'native-mcp-unknown-tool',
        kind: 'read',
        rawInput: {},
        _meta: { 'codebuddy.ai/toolName': 'mcp__navigator__shell' },
      },
      options: [
        { kind: 'allow_once', optionId: 'allow-unknown-navigator-tool' },
        { kind: 'reject_once', optionId: 'reject-unknown-navigator-tool' },
      ],
    });
    assert.equal(unknownNavigatorToolPermission.outcome.optionId, 'reject-unknown-navigator-tool');
    const suffixCollisionPermission = await request('session/request_permission', {
      sessionId: message.params.sessionId,
      toolCall: {
        toolCallId: 'native-mcp-known-tool-suffix-collision',
        kind: 'search',
        rawInput: {},
        _meta: { 'codebuddy.ai/toolName': `mcp__navigator__${toolResult.toolName}__shell` },
      },
      options: [
        { kind: 'allow_once', optionId: 'allow-suffix-collision' },
        { kind: 'reject_once', optionId: 'reject-suffix-collision' },
      ],
    });
    assert.equal(suffixCollisionPermission.outcome.optionId, 'reject-suffix-collision');
    const malformedPrefixPermission = await request('session/request_permission', {
      sessionId: message.params.sessionId,
      toolCall: {
        toolCallId: 'native-mcp-malformed-prefix',
        kind: 'fetch',
        rawInput: {},
        _meta: { 'codebuddy.ai/toolName': `mcp__navigator_${toolResult.toolName}` },
      },
      options: [
        { kind: 'allow_once', optionId: 'allow-malformed-prefix' },
        { kind: 'reject_once', optionId: 'reject-malformed-prefix' },
      ],
    });
    assert.equal(malformedPrefixPermission.outcome.optionId, 'reject-malformed-prefix');
    const genericExecutePermission = await request('session/request_permission', {
      sessionId: message.params.sessionId,
      toolCall: {
        toolCallId: 'native-generic-execute-with-business-argument-spoof',
        kind: 'execute',
        rawInput: { serverName: 'navigator', toolName: toolResult.toolName },
      },
      options: [
        { kind: 'allow_once', optionId: 'allow-generic-execute' },
        { kind: 'reject_once', optionId: 'reject-generic-execute' },
      ],
    });
    assert.equal(genericExecutePermission.outcome.optionId, 'reject-generic-execute');
    const missingRejectPermission = await request('session/request_permission', {
      sessionId: message.params.sessionId,
      toolCall: {
        toolCallId: 'native-mcp-untrusted-no-reject-option',
        kind: 'execute',
        rawInput: {},
      },
      options: [{ kind: 'allow_once', optionId: 'allow-untrusted-native' }],
    });
    assert.equal(missingRejectPermission.outcome.outcome, 'cancelled');
    const responseText = `MCP result: ${toolResult.text}; ${toolResult.exchangeText}; unknown denied=${toolResult.unknownDenied}; permission denied=${toolResult.permissionDenied}; host MCP allow once=${hostPermission.outcome.optionId === 'allow-host'}; native MCP allow once=${nativeMcpPermissions.length === 6}; native MCP without allow once rejected=${nativeMcpWithoutAllowOnce.outcome.optionId === 'reject-native-mcp-without-allow-once'}; business argument spoof denied=${spoofedNativePermission.outcome.optionId === 'reject-spoofed-native'}; foreign server denied=${foreignServerPermission.outcome.optionId === 'reject-foreign-server'}; unknown Navigator tool denied=${unknownNavigatorToolPermission.outcome.optionId === 'reject-unknown-navigator-tool'}; suffix collision denied=${suffixCollisionPermission.outcome.optionId === 'reject-suffix-collision'}; malformed prefix denied=${malformedPrefixPermission.outcome.optionId === 'reject-malformed-prefix'}; generic execute denied=${genericExecutePermission.outcome.optionId === 'reject-generic-execute'}; missing reject cancelled=${missingRejectPermission.outcome.outcome === 'cancelled'}; unknown MCP denied=${unknownMcpPermission.outcome.optionId === 'reject-unknown'}; extra MCP denied=${extraMcpPermission.outcome.optionId === 'reject-extra'}`;
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: message.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: responseText } },
    } });
  } else {
    const toolResult = await exerciseMcpClient({ includeComputer: false, includeUnknown: false });
    assert.equal(toolResult.exchangeDenied, false);
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: message.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Restored ${loadedSession}; ${toolResult.exchangeText}` },
      },
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
  assert.ok(sessionNavigatorServer, 'tool access must come from the ACP session payload');
  const mcpEnvironment = Object.fromEntries(sessionNavigatorServer.env.map(({ name, value }) => [name, value]));
  const server = spawn(sessionNavigatorServer.command, sessionNavigatorServer.args, {
    cwd: process.cwd(),
    env: { ...process.env, ...mcpEnvironment },
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
  await assert.rejects(call(0, 'initialize', {
    protocolVersion: '2025-02-31', capabilities: {}, clientInfo: { name: 'fixture', version: '1' },
  }), /MCP request failed/u, 'malformed MCP date revisions must still fail closed');
  const initialize = await call(1, 'initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' },
  });
  assert.equal(initialize.protocolVersion, '2025-06-18',
    'the bridge must negotiate its latest supported revision for a newer valid client revision');
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
