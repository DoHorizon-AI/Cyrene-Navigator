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
record({ kind: 'start', pid: process.pid, backend: codebuddy ? 'codebuddy' : 'antigravity', argv });

if (!codebuddy) {
  const conversationId = 'agy-conversation-fixture';
  const readline = createInterface({ input: process.stdin });
  if (mode === 'ag-malformed-start') {
    await new Promise((resolve, reject) => process.stdout.write('not-json\n', error => error ? reject(error) : resolve()));
    process.exit(0);
  }
  await writeFrame({ event: 'init', conversation_id: conversationId,
    init: { permission_mode: mode === 'ag-unsafe-permission' ? 'always-proceed' : mode === 'ag-unknown-permission' ? 'strict' : 'request-review', cwd: process.cwd(), tools: [] } });
  readline.on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { process.exit(21); }
    record({ kind: 'input', event: request.event, message: request.message });
    if (request.event !== 'user') process.exit(22);
    if (mode === 'ag-cancel') {
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
    const status = mode === 'ag-error' ? 'ERROR' : 'SUCCESS';
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
        ...(status === 'ERROR' ? { error: 'fixture native failure' } : {}),
      } });
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
          void respond(promptRequestId, { stopReason: outcome?.outcome === 'selected' ? 'end_turn' : 'cancelled' });
          promptRequestId = undefined;
        }
      }
      return;
    }
    record({ kind: 'rpc', method: request.method, params: request.params ?? {} });
    if (request.method === 'initialize') {
      void respond(request.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
    } else if (request.method === 'session/new') {
      void respond(request.id, { sessionId: 'codebuddy-conversation-fixture' });
    } else if (request.method === 'session/load') {
      void respond(request.id, {});
    } else if (request.method === 'session/prompt' && mode === 'cb-permission') {
      promptRequestId = request.id;
      void writeFrame({ jsonrpc: '2.0', id: 'fixture-permission', method: 'session/request_permission', params: {
        sessionId: 'codebuddy-conversation-fixture',
        toolCall: { kind: 'edit', title: 'Write a fixture file', rawInput: { path: 'out.txt' } },
        options: [
          { optionId: 'once', kind: 'allow_once' },
          { optionId: 'always', kind: 'allow_always' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      } });
    } else if (request.method === 'session/prompt') {
      void (async () => {
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

function startRequest(parentSessionId, cwd, signal) {
  return {
    parent: { session: { id: parentSessionId, header: { cwd } } },
    prompt: [{ type: 'text', text: 'Run the fixture task.' }],
    signal,
    descriptor: { mode: 'one-shot', provider: 'fixture' },
  };
}

async function fixtureHost(t, backend, mode, overrides = {}) {
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
  const disposeRegistration = registerSubagents(fakeHostContext, {
    deployments: [{
      backend,
      command,
      cwd: directory,
      envRefs: {
        FIXTURE_MODE: FIXTURE_MODE_ENV,
        FIXTURE_LOG: FIXTURE_LOG_ENV,
        ...(process.platform === 'win32' ? { FIXTURE_NODE: FIXTURE_NODE_ENV, FIXTURE_SCRIPT: FIXTURE_SCRIPT_ENV } : {}),
      },
    }],
    timeoutMs: 2_000,
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
    provider: providers.get(backend),
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
  assert.deepEqual(log.find(entry => entry.kind === 'input').message, { content: 'Run the fixture task.' });
  const starts = log.filter(entry => entry.kind === 'start');
  assert.ok(starts[0].argv.includes('--sandbox'));
  assert.ok(starts[0].argv.includes('--mode'));
  assert.ok(starts[1].argv.includes('--conversation'));
  assert.ok(starts[1].argv.includes('agy-conversation-fixture'));
  assert.deepEqual(host.events.filter(event => event.type === 'assistant-delta').map(event => event.text), ['hel', 'lo', 'hel', 'lo']);
  assert.ok(host.events.every(event => event.parentSessionId === 'fixture-parent'));
  assert.equal(host.events.some(event => event.phase === 'cancelled'), false);
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
      assert.match(result.diagnostic, /byte limit|malformed|incomplete/iu);
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

  for (const [mode, label] of [['ag-unsafe-permission', 'unsafe'], ['ag-unknown-permission', 'unknown']]) {
    const host = await fixtureHost(t, 'antigravity', mode);
    await assert.rejects(
      host.provider.start(startRequest(`${label}-parent`, host.cwd, new AbortController().signal)),
      /permission mode|startup|protocol/iu,
    );
  }
});

test('CodeBuddy ACP rejects a native write approval and associates approved requests with the parent task', {
  timeout: 20_000,
}, async t => {
  const host = await fixtureHost(t, 'codebuddy', 'cb-permission', {
    requestPermission: async () => 'deny',
  });
  const run = await host.provider.start(startRequest('navigator-task-parent', host.cwd, new AbortController().signal));
  try {
    const result = await run.result;
    assert.equal(result.stopReason, 'aborted');
    assert.equal(host.permissionRequests.length, 1);
    assert.equal(host.permissionRequests[0].parentSessionId, 'navigator-task-parent');
    assert.equal(host.permissionRequests[0].tool, 'edit');
    assert.deepEqual(host.permissionRequests[0].rawInput, { path: 'out.txt' });
    assert.ok(host.events.some(event => event.type === 'permission' && event.decision === 'denied'));
    const log = await readLog(host.logPath);
    const answer = log.find(entry => entry.kind === 'permission-result');
    assert.deepEqual(answer.outcome, { outcome: 'cancelled' });
  } finally {
    await run.dispose();
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
  assert.equal(providers.size, 0);
});
