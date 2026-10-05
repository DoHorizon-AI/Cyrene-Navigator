// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Native subagent protocol fixtures                          │
// │ Role: Exercise Antigravity and CodeBuddy over managed child stdio.  │
// │ 模块职责：通过受监管子进程 stdio 验证两个原生子 Agent 协议。           │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { registerSubagents } from '../dist/subagents/index.js';
import { installNativeProfileFixture } from './fixtures/antigravity-profile-host.mjs';

const FIXTURE_MODE_ENV = 'CYRENE_TEST_SUBAGENT_MODE';
const FIXTURE_LOG_ENV = 'CYRENE_TEST_SUBAGENT_LOG';
const FIXTURE_NODE_ENV = 'CYRENE_TEST_NODE';
const FIXTURE_SCRIPT_ENV = 'CYRENE_TEST_SUBAGENT_SCRIPT';

/** Native-protocol peer launched through a POSIX shebang or the compiled Windows wrapper. */
const fixtureSource = String.raw`#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FIXTURE_MODE ?? '';
const logPath = process.env.FIXTURE_LOG;
const record = value => appendFileSync(logPath, JSON.stringify(value) + '\n');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const writeFrame = async value => {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  const split = Math.min(9, bytes.length);
  await new Promise((resolve, reject) => process.stdout.write(bytes.subarray(0, split), error => error ? reject(error) : resolve()));
  await wait(2);
  await new Promise((resolve, reject) => process.stdout.write(bytes.subarray(split), error => error ? reject(error) : resolve()));
};

const argv = process.argv.slice(2);
const codebuddy = argv.includes('--acp');
record({ kind: 'start', pid: process.pid, backend: codebuddy ? 'acp' : 'antigravity', argv });

if (!codebuddy) {
  const conversationId = 'agy-conversation-fixture';
  const readline = createInterface({ input: process.stdin });
  if (mode === 'ag-malformed-start') {
    await new Promise((resolve, reject) => process.stdout.write('not-json\n', error => error ? reject(error) : resolve()));
    process.exit(0);
  }
  await writeFrame({ event: 'init', conversation_id: conversationId,
    init: { permission_mode: mode === 'ag-unsafe-permission' ? 'always-proceed' : mode === 'ag-unknown-permission' ? 'strict' : mode === 'ag-review-permission' ? 'request-review' : 'proceed-in-sandbox', cwd: process.cwd(), tools: [] } });
  readline.on('line', async line => {
    let request;
    try { request = JSON.parse(line); } catch { process.exit(21); }
    record({ kind: 'input', event: request.event, message: request.message });
    if (request.event !== 'user') process.exit(22);
    if (mode === 'ag-cancel' || mode === 'ag-timeout') {
      record({ kind: 'active', pid: process.pid });
      return;
    }
    if (mode === 'ag-malformed') {
      process.stdout.write('not-json\n');
      return;
    }
    if (mode === 'ag-oversized') {
      process.stdout.write('x'.repeat(1_048_577) + '\n');
      return;
    }
    if (mode === 'ag-output-limit') {
      for (const prefix of ['a', 'b', 'c']) {
        await writeFrame({ event: 'step_update', step_update: {
          conversation_id: conversationId, step_type: 'agent_response', state: 'ACTIVE',
          text_delta: prefix.repeat(768 * 1024),
        } });
      }
      return;
    }
    const status = mode.startsWith('ag-error') ? 'ERROR' : 'SUCCESS';
    if (mode === 'ag-denied-then-allowed') {
      await writeFrame({ event: 'step_update', step_update: { step_type: 'tool', state: 'ERROR', tool_info: { name: 'command', error: { type: 'sandbox_denied', message: '/private token=secret' } } } });
      record({ kind: 'allowed-after-denial' });
    }
    const response = status === 'SUCCESS' ? 'hello' : '';
    void (async () => {
      if (response.length > 0) {
        await writeFrame({ event: 'step_update', step_update: {
          conversation_id: conversationId, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'hel',
        } });
        await writeFrame({ event: 'step_update', step_update: {
          conversation_id: conversationId, step_type: 'agent_response', state: 'DONE', text_delta: 'lo',
        } });
      }
      await writeFrame({ event: 'result', result: {
        conversation_id: conversationId, status, response,
        ...(status === 'ERROR' ? { error: mode === 'ag-error-auth' ? 'Authentication required at /private token=secret' : 'fixture native failure' } : {}),
      } });
      if (mode === 'ag-late-stderr-denial') {
        await wait(10);
        await new Promise(resolve => process.stderr.write('Tool command was soft-', resolve));
        await wait(2);
        await new Promise(resolve => process.stderr.write('denied by sandbox', resolve));
      }
      process.exit(0);
    })().catch(() => process.exit(23));
  });
} else {
  const readline = createInterface({ input: process.stdin });
  let promptRequestId;
  const respond = (id, result) => writeFrame({ jsonrpc: '2.0', id, result });
  readline.on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { process.exit(31); }
    if (typeof request.method !== 'string') {
      if (request.id === 'fixture-permission') {
        const outcome = request.result?.outcome;
        record({ kind: 'permission-result', outcome });
        if (promptRequestId !== undefined) {
          const completedRequestId = promptRequestId;
          promptRequestId = undefined;
          void (async () => {
            if (outcome?.outcome === 'selected' && outcome.optionId === 'reject') {
              record({ kind: 'continued-after-denial' });
              await writeFrame({ jsonrpc: '2.0', method: 'session/update', params: {
                sessionId: 'codebuddy-conversation-fixture',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'completed independent work' } },
              } });
            } else if (outcome?.outcome === 'selected' && outcome.optionId === 'once') {
              await writeFrame({ jsonrpc: '2.0', method: 'session/update', params: {
                sessionId: 'codebuddy-conversation-fixture',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'approved fixture work' } },
              } });
            }
            await respond(completedRequestId, { stopReason: outcome?.outcome === 'selected' ? 'end_turn' : 'cancelled' });
          })().catch(() => process.exit(33));
        }
      }
      return;
    }
    record({ kind: 'rpc', method: request.method, params: request.params ?? {} });
    if (request.method === 'session/cancel') {
      record({ kind: 'cancel-notification', sessionId: request.params?.sessionId });
    } else if (request.method === 'initialize') {
      const protocolVersion = mode === 'acp-version-mismatch' ? 2 : 1;
      const authMethods = mode === 'cb-auth-advertised' || mode === 'acp-generic'
        ? [{ id: 'native-login', name: 'Native CLI login' }]
        : [];
      record({ kind: 'initialize-response', protocolVersion, authMethods });
      void respond(request.id, { protocolVersion, agentCapabilities: { loadSession: true }, authMethods });
    } else if (request.method === 'session/new') {
      if (mode === 'cb-auth-required-session') {
        void writeFrame({ jsonrpc: '2.0', id: request.id, error: {
          code: -32000, message: 'auth_required at /private token=mocksecret', data: { token: 'mocksecret' },
        } });
      } else {
        void respond(request.id, { sessionId: 'codebuddy-conversation-fixture' });
      }
    } else if (request.method === 'session/load') {
      if (mode === 'cb-auth-required-load') {
        void writeFrame({ jsonrpc: '2.0', id: request.id, error: {
          code: -32000, message: 'auth_required at /private token=mocksecret', data: { token: 'mocksecret' },
        } });
      } else {
        void respond(request.id, {});
      }
    } else if (request.method === 'session/prompt' && (mode.startsWith('cb-permission') || mode === 'acp-generic')) {
      promptRequestId = request.id;
      void writeFrame({ jsonrpc: '2.0', id: 'fixture-permission', method: 'session/request_permission', params: {
        sessionId: 'codebuddy-conversation-fixture',
        toolCall: { kind: 'edit', title: 'Write a fixture file', rawInput: { path: 'out.txt' } },
        options: [
          { optionId: 'once', kind: 'allow_once' },
          { optionId: 'always', kind: 'allow_always' },
          ...(mode === 'cb-permission-no-reject' ? [] : [{ optionId: 'reject', kind: 'reject_once' }]),
        ],
      } });
    } else if (request.method === 'session/prompt' && mode === 'cb-cancel') {
      promptRequestId = request.id;
      record({
        kind: 'cancel-ready',
        pid: process.pid,
        sessionId: 'codebuddy-conversation-fixture',
        promptActive: true,
      });
    } else if (request.method === 'session/prompt' && mode === 'cb-malformed-prompt') {
      process.stdout.write('{"jsonrpc":"2.0","id":' + JSON.stringify(request.id) + ',"result":{"secret":"MALFORMED_JSON_FIXTURE_SECRET",}}}\n');
    } else if (request.method === 'session/prompt' && mode === 'cb-output-limit') {
      void (async () => {
        for (const prefix of ['a', 'b', 'c']) {
          await writeFrame({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'codebuddy-conversation-fixture',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: prefix.repeat(768 * 1024) } },
          } });
        }
      })().catch(() => process.exit(32));
    } else if (request.method === 'session/prompt' && mode === 'cb-auth-required-prompt') {
      void writeFrame({ jsonrpc: '2.0', id: request.id, error: {
        code: -32000, message: 'auth_required at /private token=mocksecret', data: { token: 'mocksecret' },
      } });
    } else if (request.method === 'session/prompt') {
      void (async () => {
        if (mode === 'cb-flat-tools' || mode === 'acp-flat-tools') {
          const toolUpdates = mode === 'acp-flat-tools'
            ? [
              ['tool_call', 'pending'],
              ['tool_call_update', undefined],
              ['tool_call_update', 'pending'],
              ['tool_call_update', 'in_progress'],
              ['tool_call_update', 'in_progress'],
              ['tool_call_update', 'completed'],
            ]
            : [['tool_call', 'pending'], ['tool_call_update', 'in_progress'], ['tool_call_update', 'completed']];
          for (const [sessionUpdate, status] of toolUpdates) {
            await writeFrame({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: 'codebuddy-conversation-fixture',
              update: { sessionUpdate, toolCallId: 'fixture-tool', kind: 'read', ...(status === undefined ? {} : { status }) },
            } });
          }
        }
        await writeFrame({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'codebuddy-conversation-fixture',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'buddy answer' } },
        } });
        await respond(request.id, { stopReason: 'end_turn' });
      })().catch(() => process.exit(32));
    } else {
      void writeFrame({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported fixture request' } });
    }
  });
  readline.on('close', () => process.exit(0));
}
`;

function priorEnvironment(name) {
  return Object.hasOwn(process.env, name) ? process.env[name] : undefined;
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function readLog(path) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForLog(path, predicate, timeoutMs = 3_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const entries = await readLog(path);
    if (predicate(entries)) return entries;
    await delay(10);
  }
  assert.fail(`fixture log did not reach expected state: ${path}`);
}

async function waitForProcessExit(pid, timeoutMs = 3_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (process.platform === 'linux') {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        if (/\) Z /u.test(stat)) return;
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
    } else {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === 'ESRCH') return;
        throw error;
      }
    }
    await delay(20);
  }
  assert.fail(`fixture process ${pid} was not reaped`);
}

async function settlesWithin(promise, timeoutMs, description) {
  const deadline = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(timeoutMs, undefined, { signal: deadline.signal }).then(() => {
        throw new Error(`${description} did not settle within ${timeoutMs} ms`);
      }),
    ]);
  } finally {
    deadline.abort();
  }
}

function startRequest(parentSessionId, cwd, signal) {
  return {
    parent: { session: { id: parentSessionId, header: { cwd } } },
    prompt: [{ type: 'text', text: 'Run the fixture task.' }],
    signal,
    descriptor: { mode: 'one-shot', provider: 'fixture' },
  };
}

async function fixtureHost(t, backend, mode, overrides = {}) {
  if (backend === 'antigravity') await installNativeProfileFixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'navigator-subagent-'));
  const executable = join(directory, process.platform === 'win32' ? 'fixture.mjs' : 'fixture');
  const logPath = join(directory, 'child.ndjson');
  await writeFile(executable, fixtureSource, { mode: 0o700 });
  await chmod(executable, 0o700);

  const oldMode = priorEnvironment(FIXTURE_MODE_ENV);
  const oldLog = priorEnvironment(FIXTURE_LOG_ENV);
  const oldNode = priorEnvironment(FIXTURE_NODE_ENV);
  const oldScript = priorEnvironment(FIXTURE_SCRIPT_ENV);
  const command = process.platform === 'win32' ? process.env.CYRENE_TEST_SUBAGENT_WRAPPER : executable;
  assert.ok(command, 'the native protocol fixture wrapper must be compiled on Windows');
  if (process.platform === 'win32') {
    process.env[FIXTURE_NODE_ENV] = process.execPath;
    process.env[FIXTURE_SCRIPT_ENV] = executable;
  }
  process.env[FIXTURE_MODE_ENV] = mode;
  process.env[FIXTURE_LOG_ENV] = logPath;

  const subprocessContext = new Context();
  const subprocessFiber = await subprocessContext.plugin(LocalSubprocessRuntime);
  const providers = new Map();
  const fakeHostContext = {
    subprocess: subprocessContext.subprocess,
    subagents: {
      registerProvider(provider) {
        assert.equal(providers.has(provider.name), false);
        providers.set(provider.name, provider);
        return () => providers.delete(provider.name);
      },
    },
  };
  const events = [];
  const permissionRequests = [];
  const providerName = overrides.providerName ?? backend;
  const disposeRegistration = registerSubagents(fakeHostContext, {
    deployments: [{
      backend,
      ...(overrides.providerName === undefined ? {} : { providerName: overrides.providerName }),
      command,
      ...(overrides.argv === undefined ? {} : { argv: overrides.argv }),
      cwd: directory,
      envRefs: {
        FIXTURE_MODE: FIXTURE_MODE_ENV,
        FIXTURE_LOG: FIXTURE_LOG_ENV,
        ...(process.platform === 'win32' ? { FIXTURE_NODE: FIXTURE_NODE_ENV, FIXTURE_SCRIPT: FIXTURE_SCRIPT_ENV } : {}),
      },
    }],
    timeoutMs: overrides.timeoutMs ?? 2_000,
    disposeGraceMs: 150,
    onEvent: event => events.push(event),
    ...(overrides.requestPermission === undefined ? {} : {
      requestPermission: async request => {
        permissionRequests.push(request);
        return overrides.requestPermission(request);
      },
    }),
  });

  t.after(async () => {
    await disposeRegistration();
    await subprocessFiber.dispose();
    restoreEnvironment(FIXTURE_MODE_ENV, oldMode);
    restoreEnvironment(FIXTURE_LOG_ENV, oldLog);
    restoreEnvironment(FIXTURE_NODE_ENV, oldNode);
    restoreEnvironment(FIXTURE_SCRIPT_ENV, oldScript);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    cwd: directory,
    events,
    logPath,
    permissionRequests,
    provider: providers.get(providerName),
  };
}

async function completeRun(provider, cwd, parentSessionId = 'fixture-parent') {
  const controller = new AbortController();
  const run = await provider.start(startRequest(parentSessionId, cwd, controller.signal));
  try {
    const result = await run.result;
    return { result, run };
  } finally {
    await run.dispose();
  }
}

function assertOutputLimitResult(result) {
  assert.equal(result.stopReason, 'error');
  assert.match(result.diagnostic, /NATIVE_OUTPUT_LIMIT/u);
  const output = result.output.filter(part => part.type === 'text').map(part => part.text).join('');
  assert.equal(output, 'a'.repeat(768 * 1024) + 'b'.repeat(768 * 1024));
  assert.ok(Buffer.byteLength(output, 'utf8') <= 2 * 1024 * 1024);
}

test('Antigravity stream-json emits bounded deltas and resumes the associated conversation', {
  timeout: 20_000,
}, async t => {
  const host = await fixtureHost(t, 'antigravity', 'ag-normal');
  assert.ok(host.provider);
  assert.deepEqual(host.provider.capabilities, {
    agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false,
  });

  const first = await completeRun(host.provider, host.cwd);
  assert.equal(first.result.stopReason, 'completed');
  assert.deepEqual(first.result.output, [{ type: 'text', text: 'hello' }]);
  const second = await completeRun(host.provider, host.cwd);
  assert.equal(second.result.stopReason, 'completed');

  const log = await readLog(host.logPath);
  assert.equal(log.filter(entry => entry.kind === 'input').length, 2);
  assert.match(log.find(entry => entry.kind === 'input').message.content, /^Run the fixture task\./u);
  assert.match(log.find(entry => entry.kind === 'input').message.content, /continue the other permitted tasks/u);
  const starts = log.filter(entry => entry.kind === 'start');
  assert.ok(starts[0].argv.includes('--sandbox'));
  assert.ok(starts[0].argv.includes('--mode'));
  assert.ok(starts[1].argv.includes('--conversation'));
  assert.ok(starts[1].argv.includes('agy-conversation-fixture'));
  assert.deepEqual(host.events.filter(event => event.type === 'assistant-delta').map(event => event.text), ['hel', 'lo', 'hel', 'lo']);
  assert.ok(host.events.every(event => event.parentSessionId === 'fixture-parent'));
  assert.equal(host.events.some(event => event.phase === 'cancelled'), false);
});

test('Antigravity output overflow retains only prior valid text chunks', { timeout: 20_000 }, async t => {
  const host = await fixtureHost(t, 'antigravity', 'ag-output-limit');
  const { result } = await completeRun(host.provider, host.cwd);
  assertOutputLimitResult(result);
});

test('Antigravity native error is surfaced and cancellation reaps its child', {
  timeout: 20_000,
}, async t => {
  const errorHost = await fixtureHost(t, 'antigravity', 'ag-error');
  const failure = await completeRun(errorHost.provider, errorHost.cwd);
  assert.equal(failure.result.stopReason, 'error');
  assert.match(failure.result.diagnostic, /terminal status ERROR/u);

  const cancelHost = await fixtureHost(t, 'antigravity', 'ag-cancel');
  const controller = new AbortController();
  const run = await cancelHost.provider.start(startRequest('cancel-parent', cancelHost.cwd, controller.signal));
  try {
    const active = await waitForLog(cancelHost.logPath, entries => entries.some(entry => entry.kind === 'active'));
    const pid = active.find(entry => entry.kind === 'active').pid;
    controller.abort(new Error('fixture cancellation'));
    assert.equal((await run.result).stopReason, 'aborted');
    await run.dispose();
    await waitForProcessExit(pid);
    assert.ok(cancelHost.events.some(event => event.phase === 'cancelled'));
  } finally {
    await run.dispose();
  }
});

for (const [mode, label] of [['ag-malformed', 'malformed'], ['ag-oversized', 'oversized']]) {
  test(`Antigravity rejects ${label} frames after publication`, {
    timeout: 20_000,
  }, async t => {
    const host = await fixtureHost(t, 'antigravity', mode);
    const run = await host.provider.start(startRequest('fault-parent', host.cwd, new AbortController().signal));
    try {
      const result = await run.result;
      assert.equal(result.stopReason, 'error');
      assert.match(result.diagnostic, /NATIVE_INVALID_JSON|NATIVE_FRAME_LIMIT/u);
    } finally {
      await run.dispose();
    }
  });
}

test('Antigravity rejects malformed startup and non-documented native permission modes', {
  timeout: 20_000,
}, async t => {
  const malformed = await fixtureHost(t, 'antigravity', 'ag-malformed-start');
  await assert.rejects(
    malformed.provider.start(startRequest('bad-start-parent', malformed.cwd, new AbortController().signal)),
    /startup|protocol|frame|stream/iu,
  );

  for (const [mode, label] of [['ag-unsafe-permission', 'unsafe'], ['ag-unknown-permission', 'unknown'], ['ag-review-permission', 'review']]) {
    const host = await fixtureHost(t, 'antigravity', mode);
    await assert.rejects(
      host.provider.start(startRequest(`${label}-parent`, host.cwd, new AbortController().signal)),
      /permission mode|startup|protocol/iu,
    );
  }
});

test('CodeBuddy ACP rejects one native operation and continues independent work', {
  timeout: 20_000,
}, async t => {
  const host = await fixtureHost(t, 'codebuddy', 'cb-permission', {
    requestPermission: async () => 'deny',
  });
  const run = await host.provider.start(startRequest('navigator-task-parent', host.cwd, new AbortController().signal));
  try {
    const result = await run.result;
    assert.equal(result.stopReason, 'completed');
    assert.deepEqual(result.output, [{ type: 'text', text: 'completed independent work' }]);
    assert.equal(host.permissionRequests.length, 1);
    assert.equal(host.permissionRequests[0].parentSessionId, 'navigator-task-parent');
    assert.equal(host.permissionRequests[0].tool, 'edit');
    assert.deepEqual(host.permissionRequests[0].rawInput, { path: 'out.txt' });
    assert.ok(host.events.some(event => event.type === 'permission' && event.decision === 'denied'));
    const log = await readLog(host.logPath);
    const answer = log.find(entry => entry.kind === 'permission-result');
    assert.deepEqual(answer.outcome, { outcome: 'selected', optionId: 'reject' });
    assert.ok(log.some(entry => entry.kind === 'continued-after-denial'));
  } finally {
    await run.dispose();
  }
});

test('CodeBuddy ACP reports standard flat tool execution statuses', { timeout: 20_000 }, async t => {
  const host = await fixtureHost(t, 'codebuddy', 'cb-flat-tools');
  const { result } = await completeRun(host.provider, host.cwd);
  assert.equal(result.stopReason, 'completed');
  assert.deepEqual(host.events.filter(event => event.phase === 'tool').map(event => event.status), ['pending', 'in_progress', 'completed']);
});

test('CodeBuddy ACP output overflow retains only prior valid text chunks', { timeout: 20_000 }, async t => {
  const host = await fixtureHost(t, 'codebuddy', 'cb-output-limit');
  const { result } = await completeRun(host.provider, host.cwd);
  assertOutputLimitResult(result);
});

test('CodeBuddy ACP fails closed without a native reject-once option', { timeout: 20_000 }, async t => {
  const host = await fixtureHost(t, 'codebuddy', 'cb-permission-no-reject');
  const { result } = await completeRun(host.provider, host.cwd);
  assert.equal(result.stopReason, 'aborted');
  const log = await readLog(host.logPath);
  assert.deepEqual(log.find(entry => entry.kind === 'permission-result').outcome, { outcome: 'cancelled' });
  assert.equal(log.some(entry => entry.kind === 'continued-after-denial'), false);
});

test('CodeBuddy ACP dispose cancels an active prompt and reaps its child', {
  timeout: 20_000,
}, async t => {
  const host = await fixtureHost(t, 'codebuddy', 'cb-cancel', { timeoutMs: 60_000 });
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const controller = new AbortController();
  let run;
  try {
    run = await host.provider.start(startRequest('dispose-parent', host.cwd, controller.signal));
    const ready = await waitForLog(host.logPath, entries => entries.some(entry => entry.kind === 'cancel-ready'));
    const active = ready.find(entry => entry.kind === 'cancel-ready');
    assert.equal(active.promptActive, true);
    assert.equal(active.sessionId, 'codebuddy-conversation-fixture');

    const resultPromise = run.result;
    const [result] = await settlesWithin(
      Promise.all([resultPromise, run.dispose()]),
      1_000,
      'CodeBuddy ACP dispose cancellation',
    );
    assert.equal(result.stopReason, 'aborted');
    assert.ok(host.events.some(event => event.phase === 'cancelled' && event.status === 'aborted'));
    await waitForProcessExit(active.pid);
    await delay(0);
    assert.deepEqual(unhandled, []);
  } finally {
    controller.abort(new Error('fixture cleanup cancellation'));
    if (run) await run.dispose();
    process.off('unhandledRejection', onUnhandled);
  }
});

test('CodeBuddy ACP observes an independent AbortController abort after prompt readiness', {
  timeout: 20_000,
}, async t => {
  const host = await fixtureHost(t, 'codebuddy', 'cb-cancel', { timeoutMs: 60_000 });
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const controller = new AbortController();
  let run;
  try {
    run = await host.provider.start(startRequest('abort-parent', host.cwd, controller.signal));
    const ready = await waitForLog(host.logPath, entries => entries.some(entry => entry.kind === 'cancel-ready'));
    const active = ready.find(entry => entry.kind === 'cancel-ready');
    assert.equal(active.promptActive, true);
    assert.equal(active.sessionId, 'codebuddy-conversation-fixture');

    const resultPromise = run.result;
    controller.abort(new Error('fixture cancellation'));
    const [result] = await settlesWithin(
      Promise.all([resultPromise, run.dispose()]),
      1_000,
      'CodeBuddy ACP AbortController cancellation',
    );
    assert.equal(result.stopReason, 'aborted');
    assert.ok(host.events.some(event => event.phase === 'cancelled' && event.status === 'aborted'));
    await waitForProcessExit(active.pid);
    await delay(0);
    assert.deepEqual(unhandled, []);
  } finally {
    controller.abort(new Error('fixture cleanup cancellation'));
    if (run) await run.dispose();
    process.off('unhandledRejection', onUnhandled);
  }
});

test('disposing generic ACP aborts a pending host approval independently of the caller signal', {
  timeout: 20_000,
}, async t => {
  let markApprovalStarted;
  const approvalStarted = new Promise(resolve => { markApprovalStarted = resolve; });
  let approvalSignal;
  let approvalSignalAborted = false;
  const host = await fixtureHost(t, 'acp', 'cb-permission', {
    providerName: 'fixture-acp-pending-approval',
    argv: ['--acp'],
    timeoutMs: 60_000,
    requestPermission: request => {
      approvalSignal = request.signal;
      markApprovalStarted();
      return new Promise(resolve => {
        const onAbort = () => {
          approvalSignalAborted = true;
          resolve('deny');
        };
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  });
  const caller = new AbortController();
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  let run;
  try {
    run = await host.provider.start(startRequest('pending-approval-parent', host.cwd, caller.signal));
    await settlesWithin(approvalStarted, 1_000, 'generic ACP host approval request');
    assert.ok(approvalSignal);
    assert.equal(caller.signal.aborted, false);

    const resultPromise = run.result;
    const [result] = await settlesWithin(
      Promise.all([resultPromise, run.dispose()]),
      1_000,
      'generic ACP pending approval disposal',
    );
    assert.equal(result.stopReason, 'aborted');
    assert.equal(approvalSignalAborted, true);
    assert.equal(approvalSignal.aborted, true);
    assert.equal(caller.signal.aborted, false);
    assert.ok(host.events.some(event => event.phase === 'cancelled' && event.status === 'aborted'));
    const start = (await readLog(host.logPath)).find(entry => entry.kind === 'start');
    await waitForProcessExit(start.pid);
    await delay(0);
    assert.deepEqual(unhandled, []);
  } finally {
    caller.abort(new Error('fixture cleanup cancellation'));
    if (run) await run.dispose();
    process.off('unhandledRejection', onUnhandled);
  }
});

test('CodeBuddy ACP resumes only when loadSession is advertised', {
  timeout: 20_000,
}, async t => {
  const host = await fixtureHost(t, 'codebuddy', 'cb-normal');
  await completeRun(host.provider, host.cwd, 'resume-parent');
  const completed = await completeRun(host.provider, host.cwd, 'resume-parent');
  assert.equal(completed.result.stopReason, 'completed');
  assert.deepEqual(completed.result.output, [{ type: 'text', text: 'buddy answer' }]);

  const log = await readLog(host.logPath);
  const loads = log.filter(entry => entry.kind === 'rpc' && entry.method === 'session/load');
  assert.equal(loads.length, 1);
  assert.equal(loads[0].params.sessionId, 'codebuddy-conversation-fixture');
  const prompts = log.filter(entry => entry.kind === 'rpc' && entry.method === 'session/prompt');
  assert.equal(prompts.length, 2);
  assert.ok(host.events.every(event => event.parentSessionId === 'resume-parent'));
});

test('CodeBuddy ACP uses native session success instead of rejecting advertised auth methods', {
  timeout: 20_000,
}, async t => {
  const host = await fixtureHost(t, 'codebuddy', 'cb-auth-advertised');
  const completed = await completeRun(host.provider, host.cwd, 'cached-native-auth-parent');
  assert.equal(completed.result.stopReason, 'completed');
  assert.deepEqual(completed.result.output, [{ type: 'text', text: 'buddy answer' }]);

  const methods = (await readLog(host.logPath))
    .filter(entry => entry.kind === 'rpc')
    .map(entry => entry.method);
  assert.deepEqual(methods, ['initialize', 'session/new', 'session/prompt']);
  assert.equal(methods.includes('authenticate'), false);
});

test('CodeBuddy ACP reports auth_required from session creation without prompting or exposing RPC data', {
  timeout: 20_000,
}, async t => {
  const host = await fixtureHost(t, 'codebuddy', 'cb-auth-required-session');
  await assert.rejects(
    host.provider.start(startRequest('auth-required-parent', host.cwd, new AbortController().signal)),
    error => {
      assert.match(error.diagnostic, /NATIVE_AUTH_UNAVAILABLE/u);
      assert.match(error.diagnostic, /native CLI sign-in/u);
      assert.doesNotMatch(error.message + error.diagnostic, /mocksecret|\/private/u);
      return true;
    },
  );

  const methods = (await readLog(host.logPath))
    .filter(entry => entry.kind === 'rpc')
    .map(entry => entry.method);
  assert.deepEqual(methods, ['initialize', 'session/new']);
  assert.equal(methods.includes('authenticate'), false);
});

test('CodeBuddy ACP reports auth_required from session load without prompting or authenticating', {
  timeout: 20_000,
}, async t => {
  const host = await fixtureHost(t, 'codebuddy', 'cb-auth-required-load');
  await completeRun(host.provider, host.cwd, 'load-auth-required-parent');
  await assert.rejects(
    host.provider.start(startRequest('load-auth-required-parent', host.cwd, new AbortController().signal)),
    error => {
      assert.match(error.diagnostic, /NATIVE_AUTH_UNAVAILABLE/u);
      assert.doesNotMatch(error.message + error.diagnostic, /mocksecret|\/private/u);
      return true;
    },
  );

  const methods = (await readLog(host.logPath))
    .filter(entry => entry.kind === 'rpc')
    .map(entry => entry.method);
  assert.deepEqual(methods, ['initialize', 'session/new', 'session/prompt', 'initialize', 'session/load']);
  assert.equal(methods.includes('authenticate'), false);
});

test('CodeBuddy ACP reports auth_required from prompt without exposing RPC data or authenticating', {
  timeout: 20_000,
}, async t => {
  const host = await fixtureHost(t, 'codebuddy', 'cb-auth-required-prompt');
  const run = await host.provider.start(startRequest('prompt-auth-required-parent', host.cwd, new AbortController().signal));
  try {
    const result = await run.result;
    assert.equal(result.stopReason, 'error');
    assert.match(result.diagnostic, /NATIVE_AUTH_UNAVAILABLE/u);
    assert.doesNotMatch(result.diagnostic, /mocksecret|\/private/u);
    const methods = (await readLog(host.logPath))
      .filter(entry => entry.kind === 'rpc')
      .map(entry => entry.method);
    assert.deepEqual(methods, ['initialize', 'session/new', 'session/prompt']);
    assert.equal(methods.includes('authenticate'), false);
  } finally {
    await run.dispose();
  }
});

test('generic ACP registers its explicit provider, accepts native auth, and approves one request', {
  timeout: 20_000,
}, async t => {
  const providerName = 'fixture-generic-acp';
  const host = await fixtureHost(t, 'acp', 'acp-generic', {
    providerName,
    argv: ['--acp', '--model', 'fixture-model', '--agent', 'fixture-agent'],
    requestPermission: async () => 'allow-once',
  });
  assert.ok(host.provider);
  assert.equal(host.provider.name, providerName);

  const run = await host.provider.start(startRequest('generic-acp-parent', host.cwd, new AbortController().signal));
  try {
    const result = await run.result;
    assert.equal(result.stopReason, 'completed');
    assert.deepEqual(result.output, [{ type: 'text', text: 'approved fixture work' }]);
    assert.equal(host.permissionRequests.length, 1);
    assert.equal(host.permissionRequests[0].backend, 'acp');
    assert.equal(host.permissionRequests[0].providerName, providerName);
    assert.equal(host.permissionRequests[0].parentSessionId, 'generic-acp-parent');
    assert.equal(host.permissionRequests[0].tool, 'edit');
    assert.deepEqual(host.permissionRequests[0].rawInput, { path: 'out.txt' });
    assert.ok(host.events.some(event => event.backend === 'acp'));
    assert.ok(host.events.every(event => event.providerName === providerName && event.backend === 'acp'));
    assert.ok(host.events.some(event => event.type === 'permission' && event.decision === 'approved'));

    const log = await readLog(host.logPath);
    const start = log.find(entry => entry.kind === 'start');
    assert.equal(start.backend, 'acp');
    assert.deepEqual(start.argv, ['--acp', '--model', 'fixture-model', '--agent', 'fixture-agent']);
    assert.equal(start.argv.includes('--permission-mode'), false);
    assert.equal(start.argv.includes('--acp-transport'), false);
    assert.deepEqual(log.find(entry => entry.kind === 'initialize-response').authMethods, [
      { id: 'native-login', name: 'Native CLI login' },
    ]);
    assert.deepEqual(log.filter(entry => entry.kind === 'rpc').map(entry => entry.method), [
      'initialize', 'session/new', 'session/prompt',
    ]);
    assert.deepEqual(log.find(entry => entry.kind === 'permission-result').outcome, {
      outcome: 'selected', optionId: 'once',
    });
  } finally {
    await run.dispose();
  }
});

test('generic ACP ignores tool updates without status and duplicate statuses', { timeout: 20_000 }, async t => {
  const host = await fixtureHost(t, 'acp', 'acp-flat-tools', {
    providerName: 'fixture-acp-flat-tools',
    argv: ['--acp'],
  });
  const { result } = await completeRun(host.provider, host.cwd);
  assert.equal(result.stopReason, 'completed');
  assert.deepEqual(host.events.filter(event => event.phase === 'tool').map(event => event.status), [
    'pending', 'in_progress', 'completed',
  ]);
});

test('generic ACP rejects an incompatible initialize protocol version', { timeout: 20_000 }, async t => {
  const host = await fixtureHost(t, 'acp', 'acp-version-mismatch', {
    providerName: 'fixture-acp-version-mismatch',
    argv: ['--acp'],
  });
  await assert.rejects(
    host.provider.start(startRequest('version-parent', host.cwd, new AbortController().signal)),
    /protocol|version/iu,
  );
  const methods = (await readLog(host.logPath))
    .filter(entry => entry.kind === 'rpc')
    .map(entry => entry.method);
  assert.deepEqual(methods, ['initialize']);
});

test('generic ACP reports a fixed malformed-frame code without exposing raw JSON', { timeout: 20_000 }, async t => {
  const host = await fixtureHost(t, 'acp', 'cb-malformed-prompt', {
    providerName: 'fixture-acp-malformed',
    argv: ['--acp'],
  });
  const run = await host.provider.start(startRequest('malformed-parent', host.cwd, new AbortController().signal));
  try {
    const result = await run.result;
    assert.equal(result.stopReason, 'error');
    assert.match(result.diagnostic, /NATIVE_INVALID_JSON/u);
    assert.doesNotMatch(result.diagnostic, /MALFORMED_JSON_FIXTURE_SECRET/u);
  } finally {
    await run.dispose();
  }
});

test('native deployment validation rejects shell-like or unsupported argv and credential forwarding', () => {
  const providers = new Map();
  const fakeContext = {
    subprocess: {},
    subagents: { registerProvider(provider) { providers.set(provider.name, provider); return () => providers.delete(provider.name); } },
  };
  assert.throws(() => registerSubagents(fakeContext, {
    deployments: [{ backend: 'antigravity', command: 'agy', argv: ['--dangerously-skip-permissions'] }],
  }), /not allowed/u);
  assert.throws(() => registerSubagents(fakeContext, {
    deployments: [{ backend: 'codebuddy', command: 'codebuddy', envRefs: { API_KEY: 'CYRENE_API_KEY' } }],
  }), /credential|secret|token|key/u);
  for (const argv of [
    ['--dangerously-skip-permissions'],
    ['--permission-mode', 'bypass'],
    ['--acp-transport', 'stdio'],
  ]) {
    assert.throws(() => registerSubagents(fakeContext, {
      deployments: [{ backend: 'acp', command: 'approved-wrapper', argv }],
    }), /not allowed/u);
  }
  assert.equal(providers.size, 0);
});


test('Antigravity retains allowed work after native denial and reports it without terminating early', { timeout: 20_000 }, async t => {
  const host = await fixtureHost(t, 'antigravity', 'ag-denied-then-allowed');
  const { result } = await completeRun(host.provider, host.cwd);
  assert.equal(result.stopReason, 'error');
  assert.deepEqual(result.output, [{ type: 'text', text: 'hello' }]);
  assert.match(result.diagnostic, /SANDBOX_BOUNDARY_DENIED.*无法执行/u);
  assert.ok((await readLog(host.logPath)).some(entry => entry.kind === 'allowed-after-denial'));
  const receipts = host.events.filter(event => event.type === 'blocked');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].reasonCode, 'SANDBOX_BOUNDARY_DENIED');
  assert.equal(receipts[0].toolCategory, 'command');
  assert.doesNotMatch(JSON.stringify(receipts), /private|token=secret/u);
});

test('Antigravity rejects an unsafe host profile before any child is spawned', { timeout: 20_000 }, async t => {
  const profile = await installNativeProfileFixture(t);
  const host = await fixtureHost(t, 'antigravity', 'ag-normal');
  await writeFile(profile.settingsPath, JSON.stringify({ toolPermission: 'always-proceed' }));
  await assert.rejects(completeRun(host.provider, host.cwd), error => error.code === 'SANDBOX_PROFILE_UNAVAILABLE');
  assert.equal((await readLog(host.logPath)).length, 0);
  assert.equal(host.events.find(event => event.type === 'blocked')?.reasonCode, 'SANDBOX_PROFILE_UNAVAILABLE');
});


test('Antigravity observes late unterminated stderr denials before accepting SUCCESS', { timeout: 20_000 }, async t => {
  const host = await fixtureHost(t, 'antigravity', 'ag-late-stderr-denial');
  const { result } = await completeRun(host.provider, host.cwd);
  assert.equal(result.stopReason, 'error');
  assert.deepEqual(result.output, [{ type: 'text', text: 'hello' }]);
  assert.match(result.diagnostic, /SANDBOX_BOUNDARY_DENIED/u);
  assert.equal(host.events.find(event => event.type === 'blocked')?.reasonCode, 'SANDBOX_BOUNDARY_DENIED');
});


test('Antigravity reports classified native authentication failure without raw diagnostics', { timeout: 20_000 }, async t => {
  const host = await fixtureHost(t, 'antigravity', 'ag-error-auth');
  const { result } = await completeRun(host.provider, host.cwd);
  assert.equal(result.stopReason, 'error');
  assert.match(result.diagnostic, /NATIVE_AUTH_UNAVAILABLE.*无法执行/u);
  assert.doesNotMatch(result.diagnostic, /private|token=secret/u);
});


test('Antigravity timeout produces an explicit cannot-execute receipt and reaps the child', { timeout: 20_000 }, async t => {
  const host = await fixtureHost(t, 'antigravity', 'ag-timeout', { timeoutMs: 100 });
  const { result } = await completeRun(host.provider, host.cwd);
  assert.equal(result.stopReason, 'error');
  assert.match(result.diagnostic, /SUBAGENT_TIMEOUT.*无法执行/u);
  assert.equal(host.events.find(event => event.type === 'blocked')?.reasonCode, 'SUBAGENT_TIMEOUT');
  const start = (await readLog(host.logPath)).find(entry => entry.kind === 'start');
  await waitForProcessExit(start.pid);
});
