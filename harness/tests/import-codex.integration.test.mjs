// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Codex import integration                                    │
// │ Role: Exercise Rust import, real persistence and Session restore.  │
// │ 模块职责：验证 Rust 导入、真实持久化和上游 Session 恢复。            │
// └─────────────────────────────────────────────────────────────────────┘
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import CyreneSessionPersistence from '../dist/persistence.js';
import {
  apply,
  CODEX_CONTINUE_PATH,
  CODEX_IMPORT_PATH,
  CODEX_PREVIEW_PATH,
  handleCodexImportRequest,
  handleCodexContinueRequest,
  handleCodexPreviewRequest,
  MAX_IMPORT_CONTENT_BYTES,
} from '../dist/import-codex.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.CYRENE_TEST_PYTHON ?? join(repository, '.venv/bin/python');
const nativeBinary = process.env.CYRENE_NATIVE_HOST ?? join(repository, 'native/target/debug/cyrene-native-host');

async function startService(directory, token) {
  const config = join(directory, 'principals.json');
  await writeFile(config, JSON.stringify({ principals: [{
    token_env: 'CYRENE_TEST_SESSION_TOKEN', actor_id: 'import-owner', workspace_ids: ['import-proof'],
  }] }));
  const child = spawn(python, [join(repository, 'scripts/serve-persistence.py'),
    '--database', join(directory, 'sessions.sqlite'), '--principal-config', config,
    '--port', '0', '--lease-seconds', '5'], {
    env: { ...process.env, CYRENE_TEST_SESSION_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', bytes => { logs = (logs + bytes).slice(-4096); });
  const address = await new Promise((resolveAddress, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`Service startup timed out: ${logs}`)), 10_000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Service exited ${code}: ${logs}`)); });
    child.stdout.on('data', bytes => {
      stdout += bytes;
      const end = stdout.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      try { resolveAddress(JSON.parse(stdout.slice(0, end))); } catch (error) { reject(error); }
    });
  });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/harness/workspaces/import-proof/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) return { child, baseUrl };
    } catch { /* The socket is bound before Uvicorn finishes activation. */ }
    await delay(20);
  }
  child.kill('SIGKILL');
  throw new Error(`Service never became ready: ${logs}`);
}

async function stopService(service) {
  if (service.child.exitCode !== null || service.child.signalCode !== null) return;
  const exited = once(service.child, 'exit');
  service.child.kill('SIGTERM');
  const timer = setTimeout(() => service.child.kill('SIGKILL'), 2_000);
  try { await exited; } finally { clearTimeout(timer); }
}

class EchoAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(options) {
    if (options.signal?.aborted) throw new Error('aborted');
    const text = 'Continued from the archive.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function client(baseUrl, { agentRuntime = false } = {}) {
  const ctx = new Context();
  const subprocess = await ctx.plugin(LocalSubprocessRuntime);
  if (agentRuntime) {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
  } else {
    await ctx.plugin(SessionStore);
  }
  await ctx.plugin(CyreneSessionPersistence, {
    baseUrl,
    workspaceId: 'import-proof',
    tokenEnv: 'CYRENE_TEST_SESSION_TOKEN',
    clientId: 'import-proof',
    requestTimeoutMs: 2_000,
    heartbeatMs: 250,
    batchDelayMs: 5,
    maxPendingEvents: 128,
    batchSize: 256,
  });
  if (agentRuntime) {
    await ctx.plugin(AgentLoop, { agents: [] });
    ctx.llm.registerAdapter(['mock'], new EchoAdapter());
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'mock', model: 'mock' }),
    });
  }
  return { ctx, subprocess };
}

test('Codex import persists real upstream messages and never replays historical tools', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-codex-import-test-'));
  const token = randomUUID();
  process.env.CYRENE_TEST_SESSION_TOKEN = token;
  let service;
  let mounted;
  try {
    service = await startService(directory, token);
    mounted = await client(service.baseUrl);
    const fixture = await readFile(join(repository, 'native/crates/cyrene-native-host/tests/fixtures/codex-rollout.jsonl'), 'utf8');
    assert.ok(new TextEncoder().encode(fixture).byteLength < MAX_IMPORT_CONTENT_BYTES);
    const config = {
      binary: nativeBinary,
      timeoutMs: 10_000,
      cancelGraceMs: 300,
      maxResponseBytes: 1_048_576,
    };
    const state = { inFlight: new Map(), continueInFlight: new Map() };
    const request = () => new Request('http://navigator.test/api/cyrene/import/codex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'codex-rollout.jsonl', content: fixture }),
    });

    const firstResponse = await handleCodexImportRequest(mounted.ctx, config, request(), state);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.duplicate, false);
    assert.match(first.sourceSha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first.importedMessageCount, 2);
    assert.ok(first.conversionReport.warnings.length > 0);

    const id = SessionId(first.sessionId);
    const session = mounted.ctx.get('sessions').get(id);
    assert.ok(session, 'imported Session is published in the upstream SessionStore');
    const projected = session.deriveMessages();
    assert.deepEqual(projected.map(message => [message.role, message.content[0].text]), [
      ['user', 'Inspect the manifest.'],
      ['assistant', 'The manifest is valid.'],
    ]);
    assert.equal(projected[1].source.provider, 'codex');
    assert.equal(projected[1].source.model, 'unknown');
    assert.equal(mounted.ctx.get('agents'), undefined, 'the import did not start an AgentRun');

    const reader = await mounted.ctx.get('sessionPersistence').open(id, 'read');
    const events = await reader.read();
    await reader.close();
    assert.ok(events.some(event => event.type === 'user/message' && event.surfaceOp === 'append'));
    assert.ok(events.some(event => event.type === 'assistant/message' && event.surfaceOp === 'append'));
    const history = events.filter(event => event.type === 'cyrene/import-history');
    assert.ok(history.some(event => event.data.kind === 'historical_tool_call' && event.data.executable === false));
    assert.ok(history.some(event => event.data.kind === 'historical_tool_result' && event.data.executable === false));
    const marker = events.find(event => event.type === 'cyrene/import');
    assert.ok(marker, 'source archive is in the same authoritative event log');
    assert.equal(marker.data.source.filename, 'codex-rollout.jsonl');
    assert.equal(marker.data.source.provider, 'codex');
    assert.equal(marker.data.raw.content, fixture);
    assert.equal(marker.data.raw.reference.kind, 'upload');
    assert.equal(marker.data.safety.historyReplayed, false);
    assert.equal(marker.data.safety.historicalToolCallsExecutable, false);
    assert.equal(events.at(-1).type, 'session/end-seed');

    // The source is a read-only archive after the import transaction. A fresh
    // writer claim must succeed; no importer-owned handle remains open.
    const archiveWriter = await mounted.ctx.get('sessionPersistence').open(id, 'write');
    await archiveWriter.close();

    const secondResponse = await handleCodexImportRequest(mounted.ctx, config, request(), state);
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.duplicate, true);
    const reread = await mounted.ctx.get('sessionPersistence').open(id, 'read');
    assert.equal((await reread.read()).length, events.length);
    await reread.close();

    // The desktop preview is a read-only projection over the same Cyrene log.
    // It must expose imported messages, historical records and the complete
    // conversion report without publishing an archive Agent.
    const previewResponse = await handleCodexPreviewRequest(
      mounted.ctx,
      new Request(`http://navigator.test${CODEX_PREVIEW_PATH}?sessionId=${encodeURIComponent(first.sessionId)}`),
    );
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.readOnly, true);
    assert.equal(preview.sessionId, first.sessionId);
    assert.equal(preview.sourceSha256, first.sourceSha256);
    assert.equal(preview.source.filename, 'codex-rollout.jsonl');
    assert.equal(preview.raw.reference.kind, 'upload');
    assert.equal(preview.raw.content, undefined, 'preview does not duplicate raw upload content');
    assert.deepEqual(preview.messages.map(message => [message.role, message.text]), [
      ['user', 'Inspect the manifest.'],
      ['assistant', 'The manifest is valid.'],
    ]);
    assert.ok(preview.history.some(event => event.kind === 'historical_tool_call'
      && event.executable === false));
    assert.ok(preview.history.some(event => event.kind === 'historical_tool_result'
      && event.executable === false));
    assert.deepEqual(preview.conversionReport, first.conversionReport);
    assert.equal(mounted.ctx.get('agents'), undefined, 'preview did not start an AgentRun');
    const missingPreview = await handleCodexPreviewRequest(
      mounted.ctx,
      new Request(`http://navigator.test${CODEX_PREVIEW_PATH}?sessionId=codex-missing`),
    );
    assert.equal(missingPreview.status, 404);
  } finally {
    const outcomes = [];
    if (mounted) outcomes.push(mounted.ctx.fiber.dispose());
    await Promise.allSettled(outcomes);
    if (service) await stopService(service);
    delete process.env.CYRENE_TEST_SESSION_TOKEN;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex import route rejects non-POST, malformed and oversized buffered requests', async () => {
  const ctx = new Context();
  const config = {
    binary: '/tmp/cyrene-native-host',
    timeoutMs: 1_000,
    cancelGraceMs: 100,
    maxResponseBytes: 1_048_576,
  };
  const get = await handleCodexImportRequest(ctx, config, new Request('http://navigator.test/api/cyrene/import/codex'));
  assert.equal(get.status, 405);
  const malformed = await handleCodexImportRequest(ctx, config, new Request('http://navigator.test/api/cyrene/import/codex', {
    method: 'POST', body: 'null', headers: { 'Content-Type': 'application/json' },
  }));
  assert.equal(malformed.status, 400);
  const oversized = await handleCodexImportRequest(ctx, config, new Request('http://navigator.test/api/cyrene/import/codex', {
    method: 'POST',
    body: JSON.stringify({ filename: 'large.jsonl', content: 'x'.repeat(MAX_IMPORT_CONTENT_BYTES + 1) }),
    headers: { 'Content-Type': 'application/json' },
  }));
  assert.equal(oversized.status, 413);
  const continueGet = await handleCodexContinueRequest(ctx, new Request(`http://navigator.test${CODEX_CONTINUE_PATH}`));
  assert.equal(continueGet.status, 405);
  const continueMalformed = await handleCodexContinueRequest(ctx, new Request(`http://navigator.test${CODEX_CONTINUE_PATH}`, {
    method: 'POST', body: JSON.stringify({ sourceSessionId: 'source', newSessionId: 'target' }),
    headers: { 'Content-Type': 'application/json' },
  }));
  assert.equal(continueMalformed.status, 400);
  const previewPost = await handleCodexPreviewRequest(ctx, new Request(`http://navigator.test${CODEX_PREVIEW_PATH}`, {
    method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
  }));
  assert.equal(previewPost.status, 405);
  const previewMissingId = await handleCodexPreviewRequest(ctx, new Request(`http://navigator.test${CODEX_PREVIEW_PATH}`));
  assert.equal(previewMissingId.status, 400);
  const previewDuplicateId = await handleCodexPreviewRequest(ctx, new Request(
    `http://navigator.test${CODEX_PREVIEW_PATH}?sessionId=one&sessionId=two`,
  ));
  assert.equal(previewDuplicateId.status, 400);
});

test('Codex archive Continue creates a real seeded Agent and never executes archive history', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-codex-continue-test-'));
  const token = randomUUID();
  process.env.CYRENE_TEST_SESSION_TOKEN = token;
  let service;
  let archive;
  let runtime;
  try {
    service = await startService(directory, token);
    archive = await client(service.baseUrl);
    const fixture = await readFile(join(repository, 'native/crates/cyrene-native-host/tests/fixtures/codex-rollout.jsonl'), 'utf8');
    const config = {
      binary: nativeBinary,
      timeoutMs: 10_000,
      cancelGraceMs: 300,
      maxResponseBytes: 1_048_576,
    };
    const importState = { inFlight: new Map(), continueInFlight: new Map() };
    const importedResponse = await handleCodexImportRequest(archive.ctx, config, new Request('http://navigator.test/api/cyrene/import/codex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'codex-rollout.jsonl', content: fixture }),
    }), importState);
    assert.equal(importedResponse.status, 200);
    const imported = await importedResponse.json();

    // A second Context simulates a restarted desktop process. It has the
    // actual upstream AgentRegistry/AgentLoop and reads the same Cyrene log.
    await archive.ctx.fiber.dispose();
    archive = undefined;
    runtime = await client(service.baseUrl, { agentRuntime: true });
    const sourceSessionId = SessionId(imported.sessionId);
    const targetSessionId = SessionId('codex-continue-proof');
    const continueState = { inFlight: new Map(), continueInFlight: new Map() };
    const continueRequest = () => new Request(`http://navigator.test${CODEX_CONTINUE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceSessionId,
        newSessionId: targetSessionId,
        cwd: directory,
      }),
    });

    const firstResponse = await handleCodexContinueRequest(runtime.ctx, continueRequest(), continueState);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.duplicate, false);
    assert.equal(first.sourceSessionId, sourceSessionId);
    assert.equal(first.sessionId, targetSessionId);
    assert.equal(first.cwd, directory);

    const agents = runtime.ctx.get('agents');
    const target = agents.get(targetSessionId);
    assert.ok(target, 'Continue publishes a real upstream Agent');
    assert.equal(target.session.header.cwd, directory);
    assert.equal(target.session.header.parentSession, sourceSessionId);
    assert.equal(target.session.header.isSeeded, true);
    assert.equal(runtime.ctx.get('agents').get(sourceSessionId), undefined, 'the source archive has no AgentRun');
    assert.equal(target.session.snapshotEvents().some(event => event.type === 'cyrene/import-history'), false);
    assert.equal(target.session.snapshotEvents().some(event => event.type === 'cyrene/import'), false);

    const idle = new Promise(resolveIdle => {
      const dispose = runtime.ctx.on('agent/status', ({ agent, status }) => {
        if (agent === target && status === 'idle') {
          dispose();
          resolveIdle();
        }
      });
    });
    target.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Continue the manifest review.' }],
    }));
    await idle;
    await runtime.ctx.sessions.flush(target.session);
    const continuedEvents = await (async () => {
      const reader = await runtime.ctx.get('sessionPersistence').open(targetSessionId, 'read');
      try { return await reader.read(); } finally { await reader.close(); }
    })();
    assert.ok(continuedEvents.some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === 'Continue the manifest review.')));
    assert.ok(continuedEvents.some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === 'Continued from the archive.')));
    assert.equal(continuedEvents.some(event => event.type === 'cyrene/import-history'), false);

    const countAfterContinue = continuedEvents.length;
    const duplicateResponse = await handleCodexContinueRequest(runtime.ctx, continueRequest(), continueState);
    assert.equal(duplicateResponse.status, 200);
    const duplicate = await duplicateResponse.json();
    assert.equal(duplicate.duplicate, true);
    const reread = await runtime.ctx.get('sessionPersistence').open(targetSessionId, 'read');
    assert.equal((await reread.read()).length, countAfterContinue);
    await reread.close();

    // A process restart must recover the target through the upstream resume
    // factory rather than returning a detached SessionStore projection.
    await runtime.ctx.fiber.dispose();
    runtime = await client(service.baseUrl, { agentRuntime: true });
    const restartedResponse = await handleCodexContinueRequest(runtime.ctx, continueRequest(), {
      inFlight: new Map(), continueInFlight: new Map(),
    });
    assert.equal(restartedResponse.status, 200);
    const restarted = await restartedResponse.json();
    assert.equal(restarted.duplicate, true);
    const resumed = runtime.ctx.get('agents').get(targetSessionId);
    assert.ok(resumed, 'a duplicate Continue reopens the target through AgentRegistry.resume');
    assert.equal(resumed.session.header.cwd, directory);
  } finally {
    const outcomes = [];
    if (runtime) outcomes.push(runtime.ctx.fiber.dispose());
    if (archive) outcomes.push(archive.ctx.fiber.dispose());
    await Promise.allSettled(outcomes);
    if (service) await stopService(service);
    delete process.env.CYRENE_TEST_SESSION_TOKEN;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex import plugin registers exact buffered Connection routes', async () => {
  const ctx = new Context();
  const registered = [];
  Object.defineProperty(ctx, 'connection', {
    value: { fetch: { register(route) { registered.push(route); return async () => {}; } } },
  });
  apply(ctx, {
    binary: '/tmp/cyrene-native-host',
    timeoutMs: 1_000,
    cancelGraceMs: 100,
    maxResponseBytes: 1_048_576,
  });
  await new Promise(resolveAddress => setImmediate(resolveAddress));
  assert.deepEqual(registered.map(route => route.path), [CODEX_IMPORT_PATH, CODEX_PREVIEW_PATH, CODEX_CONTINUE_PATH]);
  for (const route of registered) {
    assert.equal(route.requestBody, 'buffered');
  }
  assert.deepEqual(registered.map(route => route.methods), [['POST'], ['GET'], ['POST']]);
  await ctx.fiber.dispose();
});
