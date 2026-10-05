// Round-one vertical fixture: connector intake, durable Work state, DSH tools,
// human approval, and a fake outbound connector. No external account is used.
// 第一轮端到端 fixture：连接器入站、持久 Work 状态、DSH 工具、人工审批和模拟出站。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { createExecutorApp } from '../dist/serve.js';
import { installNativeProfileFixture } from './fixtures/antigravity-profile-host.mjs';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKSPACE_ID = 'round1-workspace';
const CONNECTOR_ID = 'wecom-fixture';
const OWNER_TOKEN = 'round1-owner-token-fixture';
const READER_TOKEN = 'round1-reader-token-fixture';
const EXECUTOR_TOKEN = 'round1-executor-token-fixture';
const EXCHANGE_TOKEN = 'round1-exchange-token-fixture';
const TEST_NODE_ENV = 'CYRENE_TEST_NODE';
const TEST_SUBAGENT_SCRIPT_ENV = 'CYRENE_TEST_SUBAGENT_SCRIPT';

function priorEnvironment(name) {
  return Object.hasOwn(process.env, name) ? process.env[name] : undefined;
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise(resolveClose => server.close(resolveClose));
}

async function readRequest(request) {
  let source = '';
  for await (const chunk of request) source += chunk;
  return source ? JSON.parse(source) : {};
}

function completionStream(response, payload) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  response.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
}

function toolCompletion(name, id, args) {
  return {
    id: `fixture-${id}`,
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: 'tool_calls',
    }],
  };
}

function textCompletion(text) {
  return {
    id: 'fixture-final',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
  };
}

function createExchangeFixture() {
  const calls = { approved: 0, denied: 0, blocked: 0 };
  const toolCalls = { approved: [], denied: [], blocked: [] };
  const toolResults = { approved: [], denied: [], blocked: [] };
  const authHeaders = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const body = await readRequest(request);
    authHeaders.push(request.headers.authorization);
    const history = JSON.stringify(body.messages ?? []);
    const scenario = history.includes('ROUND1-BLOCKED') ? 'blocked' : history.includes('ROUND1-APPROVED') ? 'approved' : 'denied';
    toolResults[scenario] = (body.messages ?? [])
      .filter(message => message.role === 'tool')
      .map(message => ({
        toolCallId: message.tool_call_id,
        content: JSON.stringify(message.content ?? null).slice(0, 2_000),
      }));
    const index = calls[scenario]++;
    const availableTools = (body.tools ?? []).map(tool => tool.function?.name);
    let frame;
    let toolName;

    if (scenario === 'blocked') {
      if (index === 0) {
        toolName = 'subagent_antigravity';
        frame = toolCompletion(toolName, 'blocked-subagent', { description: 'mixed sandbox work', prompt: 'ROUND1-BLOCKED: attempt a denied command, then complete the allowed fixture check.' });
      } else if (index === 1) {
        toolName = 'work_memory_remember';
        frame = toolCompletion(toolName, 'blocked-remaining-memory', { namespace: 'sandbox-fixture', key: 'remaining-work', value: { completed: true } });
      } else frame = textCompletion('The allowed fixture check and remaining memory task completed.');
    } else if (scenario === 'approved' && index === 0) {
      toolName = 'subagent_antigravity';
      frame = toolCompletion(toolName, 'approved-subagent', {
        description: 'inspect fixture',
        prompt: 'Report the fixture status in one sentence.',
      });
    } else if ((scenario === 'approved' && index === 1) || (scenario === 'denied' && index === 0)) {
      toolName = 'work_request_approval';
      frame = toolCompletion(toolName, `${scenario}-approval`, {
        kind: 'fixture_notification',
        summary: `Send the ${scenario} fixture notification`,
        details: { target: 'fixture-conversation', scenario },
      });
    } else if ((scenario === 'approved' && index === 2) || (scenario === 'denied' && index === 1)) {
      toolName = 'work_notify';
      frame = toolCompletion(toolName, `${scenario}-notification`, {
        deduplicationKey: `round1:${scenario}:notification`,
        type: 'wecom.message',
        payload: { text: `${scenario} fixture notification` },
        recipient: 'fixture-conversation',
      });
    } else {
      frame = textCompletion(scenario === 'approved'
        ? 'Approved fixture work completed.'
        : 'The fixture approval was rejected.');
    }

    if (toolName) {
      toolCalls[scenario].push(toolName);
      if (!availableTools.includes(toolName)) {
        response.writeHead(500).end();
        return;
      }
    }
    completionStream(response, frame);
  });
  return { server, calls, toolCalls, toolResults, authHeaders };
}

async function startPersistence(database, principalConfig, env) {
  // Launch the already-synced interpreter directly so Windows cleanup owns
  // the actual server, rather than leaving a child behind its uv launcher.
  const python = join(REPOSITORY, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python');
  const child = spawn(python, [
    '-u', 'scripts/serve-persistence.py',
    '--database', database,
    '--principal-config', principalConfig,
    '--artifact-root', join(dirname(database), 'artifacts'),
    '--port', '0',
  ], { cwd: REPOSITORY, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  const address = await new Promise((resolveAddress, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Persistence fixture startup timed out')), 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line);
          if (value.service === 'cyrene-persistence' && Number.isSafeInteger(value.port)) {
            clearTimeout(timer);
            resolveAddress(`http://127.0.0.1:${value.port}`);
            return;
          }
        } catch { /* Ignore non-JSON uv startup output. */ }
      }
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Persistence fixture exited before readiness (${code ?? signal}): ${stderr}`));
    });
  });
  return { child, address };
}

async function stopPersistence(service) {
  if (service.child.exitCode !== null) return;
  service.child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolveExit => service.child.once('exit', resolveExit)),
    delay(5_000),
  ]);
  if (service.child.exitCode === null) service.child.kill('SIGKILL');
}

async function requestWork(baseUrl, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}/api/v1/workspaces/${WORKSPACE_ID}/work${path}`, {
    method,
    headers: {
      authorization: `Bearer ${OWNER_TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function resolveApproval(baseUrl, taskId, decision, messageId) {
  const page = await requestWork(baseUrl, '/approvals?status=pending&limit=100');
  const approval = page.body.find(row => row.taskId === taskId);
  if (!approval) return undefined;
  const resolved = await requestWork(baseUrl, `/approvals/${encodeURIComponent(approval.id)}/resolve`, {
    method: 'POST', body: { decision, messageId },
  });
  assert.equal(resolved.status, 200);
  return { approval, resolved: resolved.body.approval };
}

const nativeSubagentPeer = String.raw`#!/usr/bin/env node
import { createInterface } from 'node:readline';
const conversationId = 'round1-native-fixture';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const input = createInterface({ input: process.stdin });
emit({ event: 'init', conversation_id: conversationId,
  init: { permission_mode: 'proceed-in-sandbox', cwd: process.cwd(), tools: [] } });
input.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { process.exit(21); }
  if (request.event !== 'user') process.exit(22);
  if (request.message.content.includes('ROUND1-BLOCKED')) {
    emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'ERROR', tool_info: { name: 'command', error: { type: 'sandbox_denied', message: 'fixture boundary denied' } } } });
  }
  emit({ event: 'step_update', step_update: {
    conversation_id: conversationId, step_type: 'agent_response', state: 'ACTIVE',
    text_delta: 'Fixture child answer',
  } });
  emit({ event: 'result', result: {
    conversation_id: conversationId, status: 'SUCCESS', response: 'Fixture child answer',
  } });
  process.exit(0);
});`;

test('round1 simulated connector-to-DSH approval and notification flow uses durable Work state', { timeout: 60_000 }, async t => {
  await installNativeProfileFixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'navigator-round1-'));
  const environment = {
    CYRENE_SESSION_TOKEN: priorEnvironment('CYRENE_SESSION_TOKEN'),
    CYRENE_EXECUTOR_TOKEN: priorEnvironment('CYRENE_EXECUTOR_TOKEN'),
    CYRENE_EXCHANGE_TOKEN: priorEnvironment('CYRENE_EXCHANGE_TOKEN'),
    CYRENE_READER_TOKEN: priorEnvironment('CYRENE_READER_TOKEN'),
    [TEST_NODE_ENV]: priorEnvironment(TEST_NODE_ENV),
    [TEST_SUBAGENT_SCRIPT_ENV]: priorEnvironment(TEST_SUBAGENT_SCRIPT_ENV),
  };
  let persistence;
  let app;
  let exchange;
  const fakeConnectorSends = [];
  t.after(async () => {
    if (app) {
      await app.executor.dispose();
      await app.pluginManager?.dispose();
      await app.ctx.fiber.dispose();
    }
    if (persistence?.child.exitCode === null) {
      persistence.child.kill('SIGTERM');
      await Promise.race([
        new Promise(resolveExit => persistence.child.once('exit', resolveExit)),
        delay(5_000),
      ]);
      if (persistence.child.exitCode === null) persistence.child.kill('SIGKILL');
    }
    if (exchange) await closeServer(exchange.server);
    for (const [name, value] of Object.entries(environment)) restoreEnvironment(name, value);
    await rm(directory, { recursive: true, force: true });
  });

  process.env.CYRENE_SESSION_TOKEN = OWNER_TOKEN;
  process.env.CYRENE_EXECUTOR_TOKEN = EXECUTOR_TOKEN;
  process.env.CYRENE_EXCHANGE_TOKEN = EXCHANGE_TOKEN;
  process.env.CYRENE_READER_TOKEN = READER_TOKEN;

  const principalConfigPath = join(directory, 'principal.json');
  const principalConfig = {
    principals: [{
      token_env: 'CYRENE_SESSION_TOKEN', actor_id: 'round1-owner',
      workspace_ids: [WORKSPACE_ID], organization_id: 'round1-organization',
      can_takeover: true, can_write_harness: true,
    }, {
      token_env: 'CYRENE_READER_TOKEN', actor_id: 'round1-reader',
      workspace_ids: [WORKSPACE_ID], organization_id: 'round1-organization',
      can_takeover: false, can_write_harness: false,
    }],
  };
  await writeFile(principalConfigPath, `${JSON.stringify(principalConfig)}\n`, { mode: 0o600 });
  await chmod(principalConfigPath, 0o600);
  const databasePath = join(directory, 'navigator.sqlite3');
  persistence = await startPersistence(databasePath, principalConfigPath, process.env);

  const readOnlySessionCreate = await fetch(
    `${persistence.address}/api/v1/harness/workspaces/${WORKSPACE_ID}/sessions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${READER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        header: {
          version: 2, id: 'round1-read-only-session', createdAt: Date.now(),
          isSeeded: false, origin: 'round1-fixture',
        },
        inheritedEventCount: 0,
        clientId: 'round1-read-only-fixture',
      }),
    },
  );
  assert.equal(readOnlySessionCreate.status, 403, 'the non-writer principal cannot create a DSH Session');

  exchange = createExchangeFixture();
  const exchangeUrl = await listen(exchange.server);
  const peerPath = join(directory, 'native-subagent.mjs');
  const subagentConfigPath = join(directory, 'subagents.json');
  await writeFile(peerPath, nativeSubagentPeer, { mode: 0o700 });
  await chmod(peerPath, 0o700);
  const subagentDeployment = process.platform === 'win32'
    ? {
      command: process.env.CYRENE_TEST_SUBAGENT_WRAPPER,
      envRefs: { FIXTURE_NODE: TEST_NODE_ENV, FIXTURE_SCRIPT: TEST_SUBAGENT_SCRIPT_ENV },
    }
    : { command: peerPath };
  assert.ok(subagentDeployment.command, 'the native test wrapper must be compiled on Windows');
  if (process.platform === 'win32') {
    process.env[TEST_NODE_ENV] = process.execPath;
    process.env[TEST_SUBAGENT_SCRIPT_ENV] = peerPath;
  }
  await writeFile(subagentConfigPath, `${JSON.stringify({
    deployments: [{ backend: 'antigravity', ...subagentDeployment, cwd: directory }],
    timeoutMs: 5_000,
  })}\n`, { mode: 0o600 });

  app = await createExecutorApp({
    testMode: true,
    persistenceUrl: persistence.address,
    workspaceId: WORKSPACE_ID,
    exchangeUrl,
    model: 'round1-fixture-model',
    defaultCwd: directory,
    watchPlugins: false,
    subagentConfigPath,
    enableWorkflows: true,
    dshHome: join(directory, 'dsh-home'),
  });

  const workflowPage = await requestWork(persistence.address, '/workflows');
  assert.equal(workflowPage.status, 200);
  assert.equal(workflowPage.body.items.length, 7, 'the default scheduler composition seeds all seven templates');
  assert.ok(workflowPage.body.items.every(workflow => workflow.enabled === false && workflow.targets.length === 0));
  assert.equal(String(app.ctx.get('workflowRuntime').schedulerSessionId), 'navigator-workflow-scheduler-v1');
  assert.ok(app.ctx.agents.get('navigator-workflow-scheduler-v1'), 'the DSH scheduler Session is mounted');

  const approvedEvent = {
    messageId: 'wecom-fixture-approved-message',
    type: 'message.received',
    occurredAt: Date.now(),
    accountId: 'fixture-account',
    conversationId: 'fixture-conversation',
    senderId: 'fixture-owner',
    payload: { text: 'normalized approved request', media: [] },
    task: {
      id: 'round1-approved-task', sessionId: 'round1-approved-session',
      prompt: 'ROUND1-APPROVED: delegate a fixture check, request approval, then notify once.',
      metadata: { source: 'simulated-wecom-fixture' },
    },
  };
  const admitted = await requestWork(persistence.address, `/connectors/${CONNECTOR_ID}/events`, {
    method: 'POST', body: approvedEvent,
  });
  assert.ok(admitted.status === 200 || admitted.status === 201);
  assert.equal(admitted.body.duplicate, false);
  assert.equal(admitted.body.task.id, 'round1-approved-task');
  assert.equal(admitted.body.task.status, 'queued');
  const repeated = await requestWork(persistence.address, `/connectors/${CONNECTOR_ID}/events`, {
    method: 'POST', body: approvedEvent,
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.duplicate, true);
  assert.equal(repeated.body.task.id, admitted.body.task.id);

  const approvedExecution = app.executor.executeTask({
    taskId: admitted.body.task.id,
    sessionId: admitted.body.task.sessionId,
    prompt: admitted.body.task.prompt,
  });
  const approvalAttempt = await waitFor(async () => {
    const approval = await resolveApproval(
      persistence.address,
      admitted.body.task.id,
      'approved',
      'round1-human-approved',
    );
    if (approval) return { approval };
    const task = await requestWork(persistence.address, `/tasks/${admitted.body.task.id}`);
    if (['completed', 'failed', 'aborted'].includes(task.body.status)) {
      return { terminalTask: task.body, toolCalls: exchange.toolCalls.approved };
    }
    return undefined;
  }, 'approved human decision or task terminal state');
  const approvalDiagnostic = approvalAttempt.terminalTask
    ? {
      ...approvalAttempt,
      toolResults: exchange.toolResults.approved,
      events: (await requestWork(persistence.address, `/tasks/${admitted.body.task.id}/events`)).body.events,
    }
    : approvalAttempt;
  assert.ok(!approvalAttempt.terminalTask, JSON.stringify(approvalDiagnostic));
  const approvalResult = approvalAttempt.approval;
  assert.equal(approvalResult.approval.status, 'pending');
  assert.equal(approvalResult.resolved.status, 'approved');
  const replayedDecision = await requestWork(persistence.address, `/approvals/${approvalResult.approval.id}/resolve`, {
    method: 'POST', body: { decision: 'approved', messageId: 'round1-human-approved' },
  });
  assert.equal(replayedDecision.body.duplicate, true, 'the same human decision replays one durable receipt');

  const approvedOutcome = await approvedExecution;
  assert.equal(approvedOutcome.status, 'completed', JSON.stringify({
    outcome: approvedOutcome,
    calls: exchange.toolCalls.approved,
  }));
  assert.ok(exchange.toolCalls.approved.includes('subagent_antigravity'));
  assert.ok(exchange.toolCalls.approved.includes('work_request_approval'));
  assert.ok(exchange.toolCalls.approved.includes('work_notify'));
  assert.ok(exchange.authHeaders.every(value => value === `Bearer ${EXCHANGE_TOKEN}`));

  const approvedEvents = await requestWork(persistence.address, `/tasks/${admitted.body.task.id}/events`);
  assert.ok(approvedEvents.body.events.some(row => row.event.type === 'subagent-progress'));
  assert.ok(approvedEvents.body.events.some(row => row.event.type === 'approval.created'));
  assert.ok(approvedEvents.body.events.some(row => row.event.type === 'approval.approved'));
  assert.ok(approvedEvents.body.events.some(row => row.event.type === 'finish' && row.event.status === 'completed'));

  const notificationBody = {
    deduplicationKey: 'round1:approved:notification',
    type: 'wecom.message',
    payload: { text: 'approved fixture notification' },
    recipient: 'fixture-conversation',
    taskId: admitted.body.task.id,
  };
  const notifications = await requestWork(persistence.address, '/notifications');
  assert.equal(notifications.body.items.length, 1);
  const notificationId = notifications.body.items[0].id;
  const replayedNotification = await requestWork(persistence.address, '/notifications', {
    method: 'POST', body: notificationBody,
  });
  assert.equal(replayedNotification.status, 200);
  assert.equal(replayedNotification.body.duplicate, true);
  assert.equal(replayedNotification.body.notification.id, notificationId);

  const claimed = await waitFor(async () => {
    const response = await requestWork(persistence.address, '/notifications/claim', {
      method: 'POST', body: {
        workerId: 'fixture-connector-worker', limit: 10, leaseSeconds: 60,
        type: 'wecom.message', recipient: 'fixture-conversation',
      },
    });
    assert.equal(response.status, 200);
    return response.body.items.length > 0 ? response : undefined;
  }, 'the queued notification to become available for its connector lease');
  assert.equal(claimed.body.items.length, 1);
  const lease = claimed.body.items[0];
  await requestWork(persistence.address, `/notifications/${lease.notification.id}/start`, {
    method: 'POST', body: { leaseToken: lease.leaseToken },
  });
  fakeConnectorSends.push(lease.notification.payload.text);
  const delivered = await requestWork(persistence.address, `/notifications/${lease.notification.id}/finish`, {
    method: 'POST', body: {
      leaseToken: lease.leaseToken,
      outcome: 'delivered',
      result: { fakeConnectorReceiptId: 'fixture-send-1' },
    },
  });
  assert.equal(delivered.body.status, 'delivered');
  const secondClaim = await requestWork(persistence.address, '/notifications/claim', {
    method: 'POST', body: {
      workerId: 'fixture-connector-worker', limit: 10, leaseSeconds: 60,
      type: 'wecom.message', recipient: 'fixture-conversation',
    },
  });
  assert.equal(secondClaim.body.items.length, 0, 'a delivered outbox receipt is never sent a second time');
  assert.deepEqual(fakeConnectorSends, ['approved fixture notification']);

  const deniedEvent = {
    messageId: 'wecom-fixture-denied-message',
    type: 'message.received',
    occurredAt: Date.now(),
    accountId: 'fixture-account',
    conversationId: 'fixture-conversation',
    senderId: 'fixture-owner',
    payload: { text: 'normalized denied request', media: [] },
    task: {
      id: 'round1-denied-task', sessionId: 'round1-denied-session',
      prompt: 'ROUND1-DENIED: request human approval before notifying.',
      metadata: { source: 'simulated-wecom-fixture' },
    },
  };
  const deniedAdmission = await requestWork(persistence.address, `/connectors/${CONNECTOR_ID}/events`, {
    method: 'POST', body: deniedEvent,
  });
  assert.ok(deniedAdmission.status === 200 || deniedAdmission.status === 201);
  const deniedExecution = app.executor.executeTask({
    taskId: deniedAdmission.body.task.id,
    sessionId: deniedAdmission.body.task.sessionId,
    prompt: deniedAdmission.body.task.prompt,
  });
  const deniedApproval = await waitFor(async () => {
    const page = await requestWork(persistence.address, '/approvals?status=pending&limit=100');
    return page.body.find(row => row.taskId === deniedAdmission.body.task.id);
  }, 'rejected human decision');
  const rejected = await requestWork(persistence.address, `/approvals/${deniedApproval.id}/resolve`, {
    method: 'POST', body: { decision: 'rejected', messageId: 'round1-human-rejected' },
  });
  assert.equal(rejected.body.approval.status, 'rejected');
  const deniedOutcome = await deniedExecution;
  assert.equal(deniedOutcome.status, 'aborted');

  const deniedSideEffect = await requestWork(persistence.address, '/notifications', {
    method: 'POST', body: {
      deduplicationKey: 'round1:denied:notification',
      type: 'wecom.message', payload: { text: 'denied fixture notification' },
      recipient: 'fixture-conversation', taskId: deniedAdmission.body.task.id,
    },
  });
  assert.ok(deniedSideEffect.status >= 400, 'the Work API rejects side effects attached to an aborted task');
  const finalNotifications = await requestWork(persistence.address, '/notifications');
  assert.equal(finalNotifications.body.items.length, 1);
  assert.deepEqual(fakeConnectorSends, ['approved fixture notification']);
  assert.ok(exchange.toolCalls.denied.includes('work_request_approval'));
  assert.ok(!exchange.toolCalls.denied.includes('work_notify'), 'the DSH agent stops after the rejected approval');

  const blockedOutcome = await app.executor.executeTask({
    taskId: 'round1-blocked-task', sessionId: 'round1-blocked-session',
    prompt: 'ROUND1-BLOCKED: delegate mixed sandbox work, then finish the allowed memory task.',
  });
  assert.equal(blockedOutcome.status, 'failed', 'incomplete batch is reported only after allowed work finishes');
  assert.match(blockedOutcome.output, /remaining memory task completed/u);
  assert.match(blockedOutcome.output, /无法执行项/u);
  assert.match(blockedOutcome.output, /SANDBOX_BOUNDARY_DENIED/u);
  assert.deepEqual(exchange.toolCalls.blocked, ['subagent_antigravity', 'work_memory_remember']);
  assert.ok(exchange.toolResults.blocked.some(result => result.content.includes('Fixture child answer')), 'the parent keeps partial native output');
  const memory = await requestWork(persistence.address, '/memory/query', { method: 'POST', body: { query: 'remaining-work', includeStale: true } });
  assert.ok(JSON.stringify(memory.body).includes('remaining-work'), 'allowed work after the refused subagent committed to SQLite');
  const blockedEvents = await requestWork(persistence.address, '/tasks/round1-blocked-task/events');
  const blockedRows = blockedEvents.body.events.filter(row => row.event.type === 'subagent-blocked');
  assert.equal(blockedRows.length, 1);
  assert.equal(blockedRows[0].event.reasonCode, 'SANDBOX_BOUNDARY_DENIED');

  const crossWorkspace = await fetch(
    `${persistence.address}/api/v1/workspaces/round1-other/work/tasks/${admitted.body.task.id}`,
    { headers: { authorization: `Bearer ${OWNER_TOKEN}` } },
  );
  assert.equal(crossWorkspace.status, 403, 'the same principal cannot read a task from another Workspace');

  await app.executor.dispose();
  await app.pluginManager?.dispose();
  await app.ctx.fiber.dispose();
  app = undefined;
  await stopPersistence(persistence);
  persistence = await startPersistence(databasePath, principalConfigPath, process.env);

  const reopenedBlocked = await requestWork(persistence.address, '/tasks/round1-blocked-task');
  assert.equal(reopenedBlocked.body.status, 'failed');
  assert.match(reopenedBlocked.body.output, /无法执行项/u);
  const restoredEvents = await requestWork(persistence.address, `/tasks/round1-blocked-task/events?after=${blockedRows[0].seq - 1}`);
  assert.ok(restoredEvents.body.events.some(row => row.event.type === 'subagent-blocked'));
  const reopenedTask = await requestWork(persistence.address, `/tasks/${admitted.body.task.id}`);
  assert.equal(reopenedTask.status, 200);
  assert.equal(reopenedTask.body.status, 'completed');
  const reopenedConnectorEvents = await requestWork(
    persistence.address,
    `/connectors/${CONNECTOR_ID}/events?limit=100`,
  );
  assert.ok(reopenedConnectorEvents.body.events.some(
    event => event.messageId === approvedEvent.messageId,
  ));
  assert.ok(reopenedConnectorEvents.body.events.some(
    event => event.messageId === deniedEvent.messageId,
  ));
});
