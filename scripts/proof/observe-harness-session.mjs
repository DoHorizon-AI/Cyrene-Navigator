// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Real Harness session observation proof                      │
// │ Role: Record one completed model turn over the WebSocket stream.    │
// │ 模块职责：通过真实 Remote mux 记录完整模型回合和可审计证据。          │
// └─────────────────────────────────────────────────────────────────────┘
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lockPath = join(repository, 'harness/upstream.lock.json');
const defaultUpstream = process.env.CYRENE_DSH_ROOT ?? join(repository, '.upstream/deepseek-harness');
const expectedWebSocketVersion = '8.21.0';
const defaultTimeoutMs = 300_000;
const socketCloseTimeoutMs = 2_000;

const usageText = `Usage:
  node scripts/proof/observe-harness-session.mjs \\
    --address-file <private-json> \\
    --session-id <id> \\
    --cwd <absolute-directory> \\
    --prompt <text> \\
    [--expected-artifact <artifact-id>] \\
    [--output <proof-json>] \\
    [--upstream <pinned-dsh-checkout>] \\
    [--timeout-ms <positive-integer>]

The address file must contain the private Web launchUrl printed by dsh web.
The script exchanges that URL for a cookie, then keeps the cookie in memory only.
It opens /api/remote.mux and records session/follow until a new completed turn/end.
`;

/** Parse CLI options without accepting positional or shell-interpreted input. */
function parseOptions() {
  const { values } = parseArgs({
    allowPositionals: false,
    strict: true,
    options: {
      'address-file': { type: 'string' },
      'session-id': { type: 'string' },
      cwd: { type: 'string' },
      prompt: { type: 'string' },
      'expected-artifact': { type: 'string' },
      output: { type: 'string' },
      upstream: { type: 'string' },
      'timeout-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return { help: true };
  const addressFile = requiredString(values['address-file'], '--address-file');
  const sessionId = requiredString(values['session-id'], '--session-id');
  const cwdInput = requiredString(values.cwd, '--cwd');
  const prompt = requiredString(values.prompt, '--prompt');
  const cwd = resolve(cwdInput);
  if (!isAbsolute(cwd)) throw new Error('--cwd must resolve to an absolute path');
  const expectedArtifact = values['expected-artifact'] === undefined
    ? undefined
    : requiredString(values['expected-artifact'], '--expected-artifact');
  const output = values.output === undefined ? undefined : resolve(requiredString(values.output, '--output'));
  const upstream = resolve(values.upstream ?? defaultUpstream);
  const timeoutMs = parseTimeout(values['timeout-ms']);
  return {
    help: false,
    addressFile: resolve(addressFile),
    sessionId,
    cwd,
    prompt,
    expectedArtifact,
    output,
    upstream,
    timeoutMs,
  };
}

function requiredString(value, option) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${option} is required`);
  return value;
}

function parseTimeout(value) {
  if (value === undefined) return defaultTimeoutMs;
  if (!/^\d+$/u.test(value)) throw new Error('--timeout-ms must be a positive integer');
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer');
  }
  return timeoutMs;
}

/** Keep failure diagnostics useful without ever exposing launch credentials. */
function redact(value) {
  return String(value)
    .replace(/([?&]token=)[^\s&]+/giu, '$1<redacted>')
    .replace(/(Bearer\s+)[^\s]+/giu, '$1<redacted>')
    .replace(/(set-cookie\s*:\s*)[^\r\n]+/giu, '$1<redacted>');
}

function record(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
  return value;
}

/** Load the exact source lock and the fixed upstream ws implementation. */
async function loadRuntime(upstream) {
  const lock = record(JSON.parse(await readFile(lockPath, 'utf8')));
  const packageJson = record(JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8')));
  if (packageJson.version !== lock.version || packageJson.packageManager !== lock.packageManager) {
    throw new Error('DeepSeek Harness version or package manager differs from harness/upstream.lock.json');
  }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim();
  if (commit !== lock.commit) throw new Error(`DeepSeek Harness commit differs from the pin: ${commit}`);

  let requireUpstream;
  let WebSocket;
  let wsPackage;
  for (const anchor of [join(upstream, 'apps/cli/package.json'), join(upstream, 'package.json')]) {
    try {
      requireUpstream = createRequire(anchor);
      WebSocket = requireUpstream('ws');
      wsPackage = requireUpstream('ws/package.json');
      break;
    } catch {
      // The official checkout exposes ws from the CLI workspace package.
    }
  }
  if (WebSocket === undefined || wsPackage === undefined) {
    throw new Error('The pinned upstream ws package could not be resolved');
  }
  if (wsPackage.version !== expectedWebSocketVersion) {
    throw new Error(`Unexpected upstream ws version ${String(wsPackage.version)}; expected ${expectedWebSocketVersion}`);
  }
  return {
    WebSocket,
    upstream: { version: packageJson.version, commit, tag: lock.tag },
    wsVersion: wsPackage.version,
  };
}

/** Read and validate the private dsh web launch address without retaining it in evidence. */
async function readAddress(addressFile) {
  const value = record(JSON.parse(await readFile(addressFile, 'utf8')));
  if (typeof value.launchUrl !== 'string' || value.launchUrl.length === 0) {
    throw new Error('address file must contain launchUrl');
  }
  const launch = new URL(value.launchUrl);
  if (!['http:', 'https:'].includes(launch.protocol)) throw new Error('launchUrl must use HTTP or HTTPS');
  const token = launch.searchParams.get('token');
  if (token === null || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error('launchUrl must contain the 43-character dsh launch token');
  }
  if (value.baseUrl !== undefined) {
    const base = new URL(String(value.baseUrl));
    if (base.origin !== launch.origin) throw new Error('address file baseUrl and launchUrl origins differ');
  }
  return { launchUrl: launch.href, origin: launch.origin };
}

/** Exchange one dsh launch token for the process-local browser cookie. */
async function authenticate(address, timeoutMs) {
  const response = await fetchWithTimeout(address.launchUrl, {
    redirect: 'manual',
    timeoutMs,
  });
  if (response.status !== 303 || response.headers.get('location') !== '/') {
    throw new Error(`dsh launch authentication returned HTTP ${String(response.status)}`);
  }
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null || setCookie.length === 0) throw new Error('dsh launch authentication returned no cookie');
  return { origin: address.origin, cookie: setCookie.split(';', 1)[0] };
}

/** Invoke one unary upstream Remote method over its authenticated HTTP carrier. */
async function remoteCall(authenticated, method, args, timeoutMs) {
  const response = await fetchWithTimeout(`${authenticated.origin}/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: authenticated.origin,
      cookie: authenticated.cookie,
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `cyrene-proof-${randomUUID()}`,
      method,
      payload: { args },
    }),
    timeoutMs,
  });
  const bodyText = await response.text();
  let body;
  try {
    body = record(JSON.parse(bodyText));
  } catch (error) {
    throw new Error(`${method} returned non-JSON HTTP ${String(response.status)}`, { cause: error });
  }
  if (response.status !== 200) throw new Error(`${method} returned HTTP ${String(response.status)}`);
  if (body.type !== 'server-response' || !record(body.result)) {
    throw new Error(`${method} returned an invalid Remote envelope`);
  }
  if (!body.result.ok) {
    const failure = record(body.result.error);
    throw new Error(`${method} failed: ${redact(`${String(failure.code)}: ${String(failure.message)}`)}`);
  }
  return body.result.value;
}

/** Keep all HTTP operations bounded; a timeout never leaves an in-flight fetch unowned. */
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref?.();
  const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`HTTP request timed out after ${String(options.timeoutMs)} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Create the bounded evidence accumulator used by both success and failure reports. */
function createEvidence(options, runtime) {
  return {
    schema: 'cyrene.harness.session-proof.v1',
    status: 'RUNNING',
    severity: 'info',
    sessionId: options.sessionId,
    cwd: options.cwd,
    upstream: { ...runtime.upstream, wsVersion: runtime.wsVersion },
    prompt: {
      requestId: undefined,
      accepted: false,
      length: options.prompt.length,
      sha256: createHash('sha256').update(options.prompt).digest('hex'),
    },
    expectedArtifact: options.expectedArtifact,
    baseline: undefined,
    events: [],
    assistantFrames: [],
    assistantMessages: [],
    toolCalls: [],
    toolResults: [],
    usage: [],
    providerRequestIds: [],
    terminalEvent: undefined,
    finalAnswer: undefined,
    cancellation: { attempted: false, accepted: false },
    _toolCallIds: new Map(),
    _toolResultIds: new Map(),
    _assistantToolCallIds: new Set(),
    _assistantToolResultIds: new Set(),
    _providerRequestIds: new Set(),
    _promptObserved: false,
    _followStarted: process.hrtime.bigint(),
  };
}

/** Consume one validated Remote mux item and retain only post-prompt evidence. */
function consumeItem(evidence, value) {
  const item = record(value);
  if (item.type === 'snapshot') {
    if (evidence.baseline !== undefined) throw new Error('session/follow emitted more than one snapshot');
    const cursor = item.cursor;
    if (!Number.isSafeInteger(cursor) || cursor < -1) throw new Error('session/follow snapshot cursor is invalid');
    evidence.baseline = {
      cursor,
      recordCount: Array.isArray(item.records) ? item.records.length : undefined,
      hasMore: item.hasMore,
    };
    return { kind: 'snapshot' };
  }
  if (item.type === 'assistant-stream') {
    const frame = record(item.frame);
    const arrivalMonotonicMs = Number(process.hrtime.bigint() - evidence._followStarted) / 1_000_000;
    const previous = evidence.assistantFrames.at(-1);
    if (previous !== undefined && arrivalMonotonicMs < previous.arrivalMonotonicMs) {
      throw new Error('assistant-stream frame arrival time moved backwards');
    }
    evidence.assistantFrames.push({
      arrivalIndex: evidence.assistantFrames.length,
      arrivalMonotonicMs,
      frame,
    });
    if (frame.type === 'chunk' && isRecord(frame.chunk) && frame.chunk.type === 'usage') {
      evidence.usage.push({ source: 'assistant-stream', frame: frame.index, usage: frame.chunk.usage });
    }
    return { kind: 'assistant-stream', frame };
  }
  if (item.type !== 'event') throw new Error(`session/follow emitted unknown item type ${String(item.type)}`);
  const event = record(item.event);
  if (typeof event.type !== 'string' || !Number.isSafeInteger(event.seq)) {
    throw new Error('session/follow emitted an invalid event envelope');
  }
  if (evidence.baseline === undefined) throw new Error('session/follow emitted an event before its snapshot');
  if (event.seq <= evidence.baseline.cursor) return { kind: 'old-event' };
  evidence.events.push(event);
  inspectEvent(evidence, event);
  if (event.type === 'turn/end' && evidence._promptObserved) {
    evidence.terminalEvent = event;
    const reason = record(event.data).reason;
    if (!record(reason) || reason.kind !== 'completed') {
      throw new Error(`turn ${String(record(event.data).turn)} ended without completed outcome`);
    }
    evidence.finalAnswer = evidence.assistantMessages.at(-1)?.text;
    return { kind: 'completed' };
  }
  return { kind: 'event', event };
}

/** Fold tool IDs, model usage, provider response IDs, and the prompt watermark. */
function inspectEvent(evidence, event) {
  const data = record(event.data);
  if (event.type === 'user/message') {
    const source = record(data.source);
    if (source.rpcId === evidence.prompt.requestId) evidence._promptObserved = true;
  }
  if (event.type === 'tool/call') {
    const callId = nonEmptyString(data.callId, 'tool/call.callId');
    if (evidence._toolCallIds.has(callId)) throw new Error(`duplicate tool call id ${callId}`);
    evidence._toolCallIds.set(callId, event.seq);
    evidence.toolCalls.push({ seq: event.seq, id: callId, name: data.name, arguments: data.arguments });
  }
  if (event.type === 'tool/result') {
    const message = record(data.message);
    const content = message.content;
    if (!Array.isArray(content)) throw new Error('tool/result.message.content must be an array');
    for (const blockValue of content) {
      const block = record(blockValue);
      if (block.type !== 'tool-result') continue;
      const callId = nonEmptyString(block.toolCallId, 'tool-result.toolCallId');
      if (evidence._toolResultIds.has(callId)) throw new Error(`duplicate tool result id ${callId}`);
      evidence._toolResultIds.set(callId, event.seq);
      evidence.toolResults.push({
        seq: event.seq,
        id: callId,
        isError: block.isError === true,
        content: block.content,
      });
    }
  }
  if (event.type !== 'assistant/message') return;
  const message = record(data.message);
  const content = message.content;
  if (!Array.isArray(content)) throw new Error('assistant/message.content must be an array');
  const text = [];
  for (const blockValue of content) {
    const block = record(blockValue);
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    if (block.type === 'tool-call') evidence._assistantToolCallIds.add(nonEmptyString(block.id, 'tool-call.id'));
    if (block.type === 'tool-result') evidence._assistantToolResultIds.add(nonEmptyString(block.toolCallId, 'tool-result.toolCallId'));
  }
  const source = record(message.source);
  const replay = source.replayState === undefined ? undefined : record(source.replayState);
  const response = replay?.response === undefined ? undefined : record(replay.response);
  const responseId = response?.responseId;
  if (typeof responseId === 'string' && responseId.length > 0) evidence._providerRequestIds.add(responseId);
  const requestId = source.requestId;
  if (typeof requestId === 'string' && requestId.length > 0) evidence._providerRequestIds.add(requestId);
  const usage = data.usage;
  if (usage !== undefined) evidence.usage.push({ seq: event.seq, usage });
  evidence.assistantMessages.push({
    seq: event.seq,
    turn: data.turn,
    step: data.step,
    text: text.join(''),
    usage,
    responseId,
    provider: source.provider,
    model: source.model,
  });
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Open the actual upstream WebSocket mux and expose snapshot/completion promises. */
async function openFollow(runtime, authenticated, evidence, timeoutMs) {
  const WebSocket = runtime.WebSocket;
  const socket = new WebSocket(`${authenticated.origin.replace(/^http/u, 'ws')}/api/remote.mux`, {
    headers: { cookie: authenticated.cookie },
  });
  try {
    await waitForSocketOpen(socket, timeoutMs);
  } catch (error) {
    socket.terminate();
    throw error;
  }
  const streamId = `cyrene-proof-session-follow-${randomUUID()}`;
  let resolveSnapshot;
  let rejectSnapshot;
  let resolveCompleted;
  let rejectCompleted;
  const snapshot = new Promise((resolve, reject) => {
    resolveSnapshot = resolve;
    rejectSnapshot = reject;
  });
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  let snapshotReady = false;
  let settled = false;
  const fail = error => {
    if (settled) return;
    settled = true;
    const failure = error instanceof Error ? error : new Error(String(error));
    rejectSnapshot(failure);
    rejectCompleted(failure);
  };
  const onMessage = data => {
    if (settled) return;
    try {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      const frame = record(JSON.parse(text));
      if (frame.streamId !== streamId) return;
      if (frame.type === 'error') {
        const error = record(frame.error);
        throw new Error(`session/follow failed: ${redact(`${String(error.code)}: ${String(error.message)}`)}`);
      }
      if (frame.type === 'end') throw new Error('session/follow ended before completed turn/end');
      if (frame.type !== 'item') throw new Error('session/follow emitted an invalid mux frame');
      const result = consumeItem(evidence, frame.value);
      if (result.kind === 'snapshot' && !snapshotReady) {
        snapshotReady = true;
        resolveSnapshot(evidence.baseline);
      }
      if (result.kind === 'completed') {
        settled = true;
        resolveCompleted(evidence.terminalEvent);
      }
    } catch (error) {
      fail(error);
    }
  };
  const onError = () => { fail(new Error('session/follow WebSocket error')); };
  const onClose = () => { fail(new Error('session/follow WebSocket closed before completed turn/end')); };
  socket.on('message', onMessage);
  socket.once('error', onError);
  socket.once('close', onClose);
  socket.send(JSON.stringify({
    type: 'open',
    streamId,
    endpoint: 'session/follow',
    payload: { args: { request: { address: { kind: 'session', sessionId: evidence.sessionId }, assistantStream: true } } },
  }));
  const timer = setTimeout(() => fail(new Error(`session/follow snapshot timed out after ${String(timeoutMs)} ms`)), timeoutMs);
  timer.unref?.();
  const ready = snapshot.finally(() => clearTimeout(timer));
  return {
    snapshot: ready,
    completed,
    async close() {
      socket.removeListener('message', onMessage);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'cancel', streamId })); } catch { /* Closing the carrier is sufficient. */ }
        socket.close();
        await waitForSocketClose(socket, socketCloseTimeoutMs);
      } else if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
    },
  };
}

async function waitForSocketOpen(socket, timeoutMs) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`WebSocket open timed out after ${String(timeoutMs)} ms`)), timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('open', opened);
      socket.removeListener('error', failed);
      socket.removeListener('close', closed);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const opened = () => finish();
    const failed = () => finish(new Error('WebSocket failed before open'));
    const closed = () => finish(new Error('WebSocket closed before open'));
    socket.once('open', opened);
    socket.once('error', failed);
    socket.once('close', closed);
  });
}

async function waitForSocketClose(socket, timeoutMs) {
  if (socket.readyState === socket.CLOSED) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (socket.readyState !== socket.CLOSED) socket.terminate();
}

/** Attempt to cancel the active Agent after any proof failure or timeout. */
async function cancelSession(authenticated, evidence, timeoutMs) {
  if (evidence.cancellation.attempted) return;
  evidence.cancellation.attempted = true;
  try {
    await remoteCall(authenticated, 'session/cancel', { request: { sessionId: evidence.sessionId } }, timeoutMs);
    evidence.cancellation.accepted = true;
  } catch (error) {
    evidence.cancellation.error = redact(error instanceof Error ? error.message : String(error));
  }
}

/** Live Remote events become durable evidence only after Cyrene confirms the prefix. */
async function confirmPersistence(authenticated, evidence, timeoutMs) {
  const deadline = performance.now() + Math.min(timeoutMs, 10_000);
  while (performance.now() < deadline) {
    const response = await fetchWithTimeout(`${authenticated.origin}/api/cyrene/session/observe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: authenticated.origin, cookie: authenticated.cookie },
      body: JSON.stringify({ sessionId: evidence.sessionId }),
      timeoutMs: Math.max(1, deadline - performance.now()),
    });
    if (!response.ok) throw new Error(`Cyrene persistence observation returned HTTP ${String(response.status)}`);
    const observation = record(await response.json());
    if (observation.sessionId !== evidence.sessionId || !Number.isSafeInteger(observation.eventCount)) {
      throw new Error('Cyrene persistence returned an invalid Session prefix');
    }
    if (observation.eventCount > evidence.terminalEvent.seq) {
      evidence.persistence = {
        workspaceId: observation.workspaceId, eventCount: observation.eventCount,
        epoch: observation.epoch, terminalSeq: evidence.terminalEvent.seq,
      };
      return;
    }
    await delay(25);
  }
  throw new Error('Cyrene did not durably acknowledge the completed Session prefix');
}

/** Verify completion, tool correlation, and optional artifact evidence. */
function finalizeEvidence(evidence) {
  if (evidence.baseline === undefined) throw new Error('session/follow did not publish a snapshot');
  if (!evidence.prompt.accepted) throw new Error('session/prompt was not accepted');
  if (!evidence._promptObserved) throw new Error('accepted prompt did not appear in the durable event stream');
  if (evidence.terminalEvent === undefined) throw new Error('no completed turn/end was observed');
  if (evidence.assistantMessages.length === 0) throw new Error('completed turn/end had no assistant/message');
  const unmatchedCalls = [...evidence._toolCallIds.keys()].filter(id => !evidence._toolResultIds.has(id));
  const orphanResults = [...evidence._toolResultIds.keys()].filter(id => !evidence._toolCallIds.has(id));
  if (unmatchedCalls.length > 0 || orphanResults.length > 0) {
    throw new Error(`ToolCall/ToolResult IDs do not match (unmatched=${unmatchedCalls.join(',')}; orphan=${orphanResults.join(',')})`);
  }
  const missingAssistantCalls = [...evidence._assistantToolCallIds].filter(id => !evidence._toolCallIds.has(id));
  const missingAssistantResults = [...evidence._assistantToolResultIds].filter(id => !evidence._toolResultIds.has(id));
  if (missingAssistantCalls.length > 0 || missingAssistantResults.length > 0) {
    throw new Error('assistant/message tool IDs disagree with canonical tool events');
  }
  evidence.providerRequestIds = [...evidence._providerRequestIds];
  evidence.finalAnswer = evidence.assistantMessages.at(-1)?.text ?? '';
  if (evidence.expectedArtifact !== undefined) {
    if (evidence.toolCalls.length === 0 || evidence.toolResults.length === 0) {
      throw new Error('expected-artifact proof requires at least one ToolCall and ToolResult');
    }
    if (evidence.toolResults.some(result => result.isError)) {
      throw new Error('expected-artifact proof contains a failed Tool execution');
    }
    const toolResultText = JSON.stringify(evidence.toolResults);
    if (!toolResultText.includes(evidence.expectedArtifact)) {
      throw new Error('no ToolResult contains the expected artifact ID');
    }
    if (!evidence.finalAnswer.includes(evidence.expectedArtifact)) {
      throw new Error('final answer does not contain the expected artifact ID');
    }
  }
  evidence.status = 'PASS';
  evidence.severity = 'info';
  evidence.toolCorrelation = {
    callCount: evidence.toolCalls.length,
    resultCount: evidence.toolResults.length,
    matched: true,
  };
  evidence.stream = {
    assistantFrameCount: evidence.assistantFrames.length,
    arrivalTimesMonotonic: true,
    completedTurnEnd: true,
  };
  stripInternalEvidence(evidence);
  return evidence;
}

function stripInternalEvidence(evidence) {
  delete evidence._toolCallIds;
  delete evidence._toolResultIds;
  delete evidence._assistantToolCallIds;
  delete evidence._assistantToolResultIds;
  delete evidence._providerRequestIds;
  delete evidence._promptObserved;
  delete evidence._followStarted;
}

function failureEvidence(evidence, error) {
  if (evidence === undefined) {
    return {
      schema: 'cyrene.harness.session-proof.v1',
      status: 'FAIL',
      severity: 'error',
      failure: { message: redact(error instanceof Error ? error.message : String(error)) },
    };
  }
  evidence.status = 'FAIL';
  evidence.severity = 'error';
  evidence.failure = { message: redact(error instanceof Error ? error.message : String(error)) };
  evidence.providerRequestIds = [...evidence._providerRequestIds];
  evidence.toolCorrelation = {
    callCount: evidence.toolCalls.length,
    resultCount: evidence.toolResults.length,
    matched: [...evidence._toolCallIds.keys()].every(id => evidence._toolResultIds.has(id))
      && [...evidence._toolResultIds.keys()].every(id => evidence._toolCallIds.has(id)),
  };
  evidence.stream = {
    assistantFrameCount: evidence.assistantFrames.length,
    arrivalTimesMonotonic: true,
    completedTurnEnd: evidence.terminalEvent?.data?.reason?.kind === 'completed',
  };
  stripInternalEvidence(evidence);
  return evidence;
}

async function writeEvidence(output, evidence) {
  const text = `${JSON.stringify(redactJson(evidence), null, 2)}\n`;
  if (output === undefined) {
    process.stdout.write(text);
    return;
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, text, { mode: 0o600 });
  await chmod(output, 0o600);
  process.stdout.write(`${evidence.status} proof written to ${output}\n`);
}

/** Redact credential-shaped strings even if a remote error or model record echoes one. */
function redactJson(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactJson(child)]));
}

async function run(options) {
  const runtime = await loadRuntime(options.upstream);
  const address = await readAddress(options.addressFile);
  const workspace = await stat(options.cwd);
  if (!workspace.isDirectory()) throw new Error('--cwd must identify a directory');
  const evidence = createEvidence(options, runtime);
  let authenticated;
  let follow;
  try {
    authenticated = await authenticate(address, options.timeoutMs);
    await remoteCall(authenticated, 'session/create', {
      request: { sessionId: options.sessionId, cwd: options.cwd },
    }, options.timeoutMs);
    follow = await openFollow(runtime, authenticated, evidence, options.timeoutMs);
    await follow.snapshot;
    evidence.prompt.requestId = randomUUID();
    const accepted = await remoteCall(authenticated, 'session/prompt', {
      request: {
        requestId: evidence.prompt.requestId,
        sessionId: options.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: options.prompt }],
      },
    }, options.timeoutMs);
    if (record(accepted).accepted !== true) throw new Error('session/prompt did not return accepted=true');
    evidence.prompt.accepted = true;
    await waitForCompletion(follow.completed, options.timeoutMs);
    await confirmPersistence(authenticated, evidence, options.timeoutMs);
    return finalizeEvidence(evidence);
  } catch (error) {
    if (authenticated !== undefined && evidence.prompt.requestId !== undefined) {
      await cancelSession(authenticated, evidence, Math.min(options.timeoutMs, 10_000));
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { evidence });
  } finally {
    if (follow !== undefined) await follow.close();
  }
}

/** Bound the model turn separately from the initial WebSocket handshake. */
async function waitForCompletion(completed, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`model turn timed out after ${String(timeoutMs)} ms`)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([completed, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function main() {
  let options;
  try {
    options = parseOptions();
  } catch (error) {
    process.stderr.write(`FAIL: ${redact(error instanceof Error ? error.message : String(error))}\n${usageText}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usageText);
    return;
  }
  try {
    const evidence = await run(options);
    await writeEvidence(options.output, evidence);
  } catch (error) {
    const evidence = failureEvidence(error?.evidence, error);
    await writeEvidence(options.output, evidence);
    process.exitCode = 1;
  }
}

await main();
