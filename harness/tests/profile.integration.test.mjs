// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Cyrene Navigator Web Profile integration                    │
// │ Role: Exercise the official CLI, Bundle, persistence, and takeover. │
// │ 模块职责：通过真实 CLI 验证 Profile、Cookie、会话和接管链路。          │
// └─────────────────────────────────────────────────────────────────────┘
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.CYRENE_TEST_PYTHON ?? join(repository, '.venv/bin/python');
const nativeBinary = process.env.CYRENE_NATIVE_HOST
  ?? join(repository, 'native/target/debug/cyrene-native-host');
const upstream = process.env.CYRENE_DSH_ROOT ?? join(repository, '.upstream/deepseek-harness');
const workspaceId = 'profile-proof';

/** Keep process diagnostics useful without ever printing launch credentials. */
function redact(value) {
  return value.replace(/([?&]token=)[^\s)]+/gu, '$1<redacted>')
    .replace(/(Bearer\s+)[^\s]+/giu, '$1<redacted>');
}

/** Verify that CI supplied real executable artifacts rather than placeholders. */
async function requireExecutable(path, label) {
  const metadata = await stat(path);
  assert.equal(metadata.isFile(), true, `${label} is not a file: ${path}`);
  if (process.platform !== 'win32') assert.notEqual(metadata.mode & 0o111, 0, `${label} is not executable: ${path}`);
}

/** Start the real Python persistence authority and wait for its HTTP socket. */
async function startPersistence(directory, token) {
  const configPath = join(directory, 'principals.json');
  await writeFile(configPath, JSON.stringify({ principals: [{
    token_env: 'CYRENE_PROFILE_SESSION_TOKEN',
    actor_id: 'profile-owner',
    workspace_ids: [workspaceId],
  }] }));
  const child = spawn(python, [join(repository, 'scripts/serve-persistence.py'),
    '--database', join(directory, 'sessions.sqlite'), '--principal-config', configPath,
    '--port', '0', '--lease-seconds', '120'], {
    env: { ...process.env, CYRENE_PROFILE_SESSION_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', bytes => { logs = (logs + bytes.toString()).slice(-8192); });
  const address = await new Promise((resolveAddress, reject) => {
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error(`persistence service startup timed out: ${redact(logs)}`));
    }, 15_000);
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`persistence service exited ${String(code)}: ${redact(logs)}`)));
    child.stdout.on('data', bytes => {
      if (settled) return;
      stdout += bytes.toString();
      const end = stdout.indexOf('\n');
      if (end < 0) return;
      try {
        const parsed = JSON.parse(stdout.slice(0, end));
        settled = true;
        clearTimeout(timer);
        resolveAddress(parsed);
      } catch (error) {
        fail(error);
      }
    });
  });
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/harness/workspaces/${workspaceId}/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) return { child, baseUrl };
    } catch {
      // The listener binds before Uvicorn finishes serving the application.
    }
    await delay(20);
  }
  await stopProcess(child, 'SIGKILL');
  throw new Error(`persistence service never became ready: ${redact(logs)}`);
}

/** Stop one child and escalate without leaking a launcher process. */
async function stopProcess(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (signal === 'SIGKILL' && process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    child.kill(signal);
  }
  await Promise.race([exited, delay(10_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

/** Start the pinned official CLI through the repository's Profile launcher. */
async function startWeb(directory, home, deviceId, token, persistenceUrl, providerUrl) {
  const child = spawn(process.execPath, [join(repository, 'scripts/launch-harness.mjs'),
    '--upstream', upstream, '--home', home, '--mode', 'web'], {
    cwd: directory,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      CI: 'true',
      DSH_AGENTS_HOME: join(home, 'agents'),
      DSH_TELEMETRY_DISABLED: '1',
      CYRENE_EXCHANGE_URL: providerUrl,
      CYRENE_EXCHANGE_TOKEN: 'profile-proof-unused-token',
      CYRENE_HARNESS_MODEL: 'profile-proof-model',
      CYRENE_PERSISTENCE_URL: persistenceUrl,
      CYRENE_SESSION_TOKEN: token,
      CYRENE_WORKSPACE_ID: workspaceId,
      CYRENE_DEVICE_ID: deviceId,
      CYRENE_NATIVE_HOST: nativeBinary,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const append = bytes => { output = `${output}${bytes.toString()}`.slice(-100_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const launchUrl = await new Promise((resolveUrl, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error(`Navigator Profile did not become ready:\n${redact(output)}`));
    }, 90_000);
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const check = () => {
      if (settled) return;
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output);
      if (match?.[1] === undefined) return;
      settled = true;
      clearTimeout(timer);
      resolveUrl(match[1]);
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`Navigator Profile exited ${String(code)}:\n${redact(output)}`)));
  });
  return { child, launchUrl, output: () => output };
}

/** Exchange one process launch token for the authenticated browser cookie. */
async function authenticate(launchUrl, runtime) {
  const parsed = new URL(launchUrl);
  assert.match(parsed.searchParams.get('token') ?? '', /^[A-Za-z0-9_-]{43}$/u);
  const response = await fetch(launchUrl, { redirect: 'manual' });
  assert.equal(response.status, 303, 'the official CLI must accept its launch token');
  assert.equal(response.headers.get('location'), '/');
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie, 'the launch-token exchange must return a browser cookie');
  const authenticated = { origin: parsed.origin, cookie: setCookie.split(';', 1)[0], runtime };
  const index = await fetch(`${authenticated.origin}/`, {
    redirect: 'manual',
    headers: { cookie: authenticated.cookie },
  });
  const indexBody = await index.text();
  assert.equal(index.status, 200,
    `authenticated index probe failed: HTTP ${String(index.status)}; `
    + `transport=${JSON.stringify(safeTransportDiagnostics(authenticated, index))}; `
    + `bodyLength=${String(indexBody.length)}`);
  if (process.env.CYRENE_PROFILE_SAFE_AUTH_DIAGNOSTICS === '1') {
    console.error(`[profile-proof auth] ${JSON.stringify(safeCookieDiagnostics(authenticated))}`);
  }
  return authenticated;
}

/**
 * Describe the signed-cookie shape without exposing its value or launch token.
 * The payload is intentionally limited to the authority and timestamps that
 * decide BrowserAuth acceptance; the HMAC is never decoded or logged.
 */
function safeCookieDiagnostics(authenticated) {
  const first = authenticated.cookie.split(';', 1)[0] ?? '';
  const separator = first.indexOf('=');
  const name = separator < 0 ? first : first.slice(0, separator);
  const value = separator < 0 ? '' : first.slice(separator + 1);
  const parts = value.split('.');
  let payload;
  const encodedBody = parts[1];
  if (parts.length === 3 && encodedBody !== undefined) {
    try {
      const decoded = JSON.parse(Buffer.from(encodedBody, 'base64url').toString('utf8'));
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) payload = decoded;
    } catch {
      // The diagnostic must stay best-effort and must not become a cookie parser.
    }
  }
  const originAuthority = new URL(authenticated.origin).host;
  const now = Date.now();
  return {
    originAuthority,
    cookieNamePrefix: name.slice(0, 8),
    cookieNameLength: name.length,
    cookieValueLength: value.length,
    cookieParts: parts.length,
    cookieVersion: parts[0] ?? '',
    cookieAuthority: typeof payload?.authority === 'string' ? payload.authority : undefined,
    authorityMatches: payload?.authority === originAuthority,
    issuedAgeMs: Number.isSafeInteger(payload?.issuedAt) ? now - payload.issuedAt : undefined,
    expiresInMs: Number.isSafeInteger(payload?.expiresAt) ? payload.expiresAt - now : undefined,
  };
}

/** Keep HTTP failure evidence bounded to non-secret transport metadata. */
function safeTransportDiagnostics(authenticated, response) {
  return {
    requestAuthority: new URL(authenticated.origin).host,
    cookie: safeCookieDiagnostics(authenticated),
    runtime: authenticated.runtime === undefined ? undefined : {
      pid: authenticated.runtime.child.pid,
      exitCode: authenticated.runtime.child.exitCode,
      signalCode: authenticated.runtime.child.signalCode,
    },
    responseStatus: response.status,
    responseHeaders: Object.fromEntries(['content-type', 'date', 'location', 'server', 'www-authenticate']
      .map(name => [name, response.headers.get(name)])),
  };
}

/** Invoke one real upstream Remote method over its authenticated HTTP carrier. */
async function remote(authenticated, method, args) {
  const response = await fetch(`${authenticated.origin}/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: authenticated.origin,
      cookie: authenticated.cookie,
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `profile-proof-${randomUUID()}`,
      method,
      payload: { args },
    }),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`${method} returned non-JSON HTTP ${String(response.status)}: ${redact(text)}; `
      + `transport=${JSON.stringify(safeTransportDiagnostics(authenticated, response))}`, { cause: error });
  }
  assert.equal(response.status, 200,
    `${method} HTTP failure: ${redact(text)}; `
    + `transport=${JSON.stringify(safeTransportDiagnostics(authenticated, response))}`);
  assert.equal(body.type, 'server-response', `${method} returned an unexpected envelope`);
  assert.equal(body.rpcId.startsWith('profile-proof-'), true);
  if (!body.result?.ok) throw new Error(`${method} failed: ${JSON.stringify(body.result?.error)}`);
  return body.result.value;
}

/** Invoke one Cyrene product route registered on the authenticated Connection. */
async function productRoute(authenticated, action, body) {
  const response = await fetch(`${authenticated.origin}/api/cyrene/session/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: authenticated.origin,
      cookie: authenticated.cookie,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`session/${action} returned non-JSON HTTP ${String(response.status)}: ${redact(text)}; `
      + `transport=${JSON.stringify(safeTransportDiagnostics(authenticated, response))}`, { cause: error });
  }
  assert.equal(response.status, 200, `session/${action} failed: ${redact(text)}`);
  return value;
}

/** Read cold title projections through the Cyrene product route. */
async function sessionTitlesRoute(authenticated, body) {
  const response = await fetch(`${authenticated.origin}/api/cyrene/session/titles`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: authenticated.origin,
      cookie: authenticated.cookie,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`session/titles returned non-JSON HTTP ${String(response.status)}: ${redact(text)}`, { cause: error });
  }
  return { status: response.status, value };
}

/** Read durable input receipts through the real authenticated Connection route. */
async function inputReceiptsRoute(authenticated, body, options) {
  const cookie = options === undefined || !Object.hasOwn(options, 'cookie')
    ? authenticated.cookie : options.cookie;
  const origin = options?.origin ?? authenticated.origin;
  const response = await fetch(`${authenticated.origin}/api/cyrene/session/input-receipts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

/** Wait until a rename event is durably acknowledged by the backend. */
async function waitForDurableEvent(authenticated, sessionId, minimumEventCount) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const observation = await productRoute(authenticated, 'observe', { sessionId });
    if (observation.eventCount >= minimumEventCount) return observation;
    await delay(20);
  }
  throw new Error(`Session ${sessionId} did not flush its title event`);
}

/** Make unexpected model traffic observable while keeping this lane model-free. */
async function startProviderTripwire() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('The profile proof must not call an LLM.');
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    async close() {
      if (!server.listening) return;
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    },
  };
}

test('real cyrene-navigator Web Profile survives restart and resumes through takeover', { timeout: 180_000 }, async () => {
  await requireExecutable(nativeBinary, 'cyrene-native-host');
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-profile-proof-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });
  const token = randomUUID();
  const firstHome = join(directory, 'profile-one');
  const secondHome = join(directory, 'profile-two');
  let persistence;
  let provider;
  let first;
  let restarted;
  let second;
  try {
    provider = await startProviderTripwire();
    persistence = await startPersistence(directory, token);
    first = await startWeb(directory, firstHome, 'profile-device-one', token, persistence.baseUrl, provider.url);
    const firstAuth = await authenticate(first.launchUrl, first);
    const sessionId = `profile-${randomUUID()}`;

    const created = await remote(firstAuth, 'session/create', {
      request: { sessionId, cwd: workspace },
    });
    assert.deepEqual(created, { sessionId, agentPreset: 'cyrene-navigator' });

    const listed = await remote(firstAuth, 'session/list', { _request: {} });
    const listedSession = listed.items.find(item => item.sessionId === sessionId);
    assert.ok(listedSession, 'the created Session must be visible through the Web list Remote');
    assert.equal(listedSession.cwd, workspace);
    assert.equal(listedSession.running, false);

    const firstObservation = await productRoute(firstAuth, 'observe', { sessionId });
    assert.equal(firstObservation.workspaceId, workspaceId);
    assert.equal(firstObservation.localWriter, true);
    assert.equal(firstObservation.agentPreset, 'cyrene-navigator');
    assert.equal(Number.isSafeInteger(firstObservation.eventCount), true);

    const renamed = await remote(firstAuth, 'session/rename', {
      request: { sessionId, title: 'Cold profile title' },
    });
    assert.equal(renamed.title, 'Cold profile title');
    assert.equal(Number.isSafeInteger(renamed.seq), true);
    // The first observation can precede unrelated creation events that are
    // still draining through the persistence writer. Waiting for
    // `firstObservation.eventCount + 1` could therefore acknowledge an older
    // prefix, kill the writer, and leave the rename itself absent from the
    // durable log. The rename's own event sequence is the authoritative
    // barrier for the cold-title proof.
    const durableAfterRename = await waitForDurableEvent(firstAuth, sessionId, renamed.seq + 1);
    assert.ok(durableAfterRename.eventCount > renamed.seq,
      'the explicit title event must be durable before the writer is stopped');

    const beforeReceiptRead = await productRoute(firstAuth, 'observe', { sessionId });
    const receipt = await inputReceiptsRoute(firstAuth, {
      sessionId, requestIds: ['profile-no-user-request'],
    });
    assert.equal(receipt.status, 200);
    assert.deepEqual(JSON.parse(receipt.text).completedRequestIds, []);
    const afterReceiptRead = await productRoute(firstAuth, 'observe', { sessionId });
    assert.equal(afterReceiptRead.eventCount, beforeReceiptRead.eventCount,
      'an authenticated receipt read must not append Session events');
    assert.equal(afterReceiptRead.epoch, beforeReceiptRead.epoch,
      'an authenticated receipt read must not claim Session ownership');

    const noCookieReceipt = await inputReceiptsRoute(firstAuth, {
      sessionId, requestIds: ['profile-no-user-request'],
    }, { cookie: undefined });
    assert.equal(noCookieReceipt.status, 401);
    assert.equal(noCookieReceipt.text, 'unauthorized');

    const wrongOriginReceipt = await inputReceiptsRoute(firstAuth, {
      sessionId, requestIds: ['profile-no-user-request'],
    }, { origin: 'http://untrusted.invalid' });
    assert.equal(wrongOriginReceipt.status, 403);
    assert.equal(wrongOriginReceipt.text, 'forbidden');

    // Kill the first Web runtime to leave its backend lease recoverable. The
    // next Profile reads the same event authority before a second device takes over.
    await stopProcess(first.child, 'SIGKILL');
    first = undefined;

    restarted = await startWeb(directory, firstHome, 'profile-device-one-restarted', token, persistence.baseUrl, provider.url);
    const restartedAuth = await authenticate(restarted.launchUrl, restarted);
    const afterRestart = await remote(restartedAuth, 'session/list', { _request: {} });
    const restoredSession = afterRestart.items.find(item => item.sessionId === sessionId);
    assert.ok(restoredSession, 'the restarted Profile must list the durable Session');
    assert.equal(restoredSession.cwd, workspace);
    const restartedObservation = await productRoute(restartedAuth, 'observe', { sessionId });
    assert.equal(restartedObservation.localWriter, false);

    second = await startWeb(directory, secondHome, 'profile-device-two', token, persistence.baseUrl, provider.url);
    const secondAuth = await authenticate(second.launchUrl, second);
    const observed = await productRoute(secondAuth, 'observe', { sessionId });
    assert.equal(observed.localWriter, false);
    assert.equal(observed.epoch, restartedObservation.epoch);
    assert.equal(observed.cwd, workspace);
    assert.equal(observed.agentPreset, 'cyrene-navigator');

    const coldListed = await remote(secondAuth, 'session/list', { _request: {} });
    const coldListedSession = coldListed.items.find(item => item.sessionId === sessionId);
    assert.ok(coldListedSession, 'the independent Profile must list the cold Session');
    assert.equal(coldListedSession.projections?.values?.title, undefined,
      'an independent Profile must not depend on another Profile local projection cache');
    const beforeTitleRead = await productRoute(secondAuth, 'observe', { sessionId });
    const titleRead = await sessionTitlesRoute(secondAuth, { sessionIds: [sessionId, sessionId] });
    assert.equal(titleRead.status, 200);
    assert.deepEqual(titleRead.value.errors, []);
    assert.equal(titleRead.value.items.length, 1);
    const titleItem = titleRead.value.items[0];
    assert.ok(titleItem);
    assert.deepEqual(titleRead.value.items, [{
      sessionId,
      title: 'Cold profile title',
      seq: renamed.seq,
      updatedAt: titleItem.updatedAt,
    }]);
    assert.equal(Number.isSafeInteger(titleItem.updatedAt), true);
    const afterTitleRead = await productRoute(secondAuth, 'observe', { sessionId });
    assert.equal(afterTitleRead.epoch, beforeTitleRead.epoch,
      'a cold title read must not claim or advance Session ownership');
    assert.equal(afterTitleRead.eventCount, beforeTitleRead.eventCount,
      'a cold title read must not append Session events');
    const invisibleTitle = await sessionTitlesRoute(secondAuth, { sessionIds: [`missing-${randomUUID()}`] });
    assert.equal(invisibleTitle.status, 404);
    assert.equal(invisibleTitle.value.code, 'SESSION_NOT_VISIBLE');
    assert.equal(provider.requests.length, 0,
      'cold title reads must not activate an Agent or call the model provider');

    const takeover = await productRoute(secondAuth, 'takeover', {
      sessionId,
      expectedEpoch: observed.epoch,
    });
    assert.equal(takeover.sessionId, sessionId);
    assert.equal(takeover.agentPreset, 'cyrene-navigator');
    assert.equal(takeover.ownership, 'writer');
    assert.equal(takeover.previousEpoch, observed.epoch);

    const resumed = await remote(secondAuth, 'session/list', { _request: {} });
    const resumedSession = resumed.items.find(item => item.sessionId === sessionId);
    assert.ok(resumedSession, 'the takeover Profile must list the resumed Session');
    assert.equal(resumedSession.cwd, workspace);
    const afterTakeover = await productRoute(secondAuth, 'observe', { sessionId });
    assert.equal(afterTakeover.localWriter, true);
    assert.equal(afterTakeover.epoch, observed.epoch + 1);
    assert.equal(provider.requests.length, 0,
      `Session lifecycle operations must not call the LLM provider: ${JSON.stringify(provider.requests)}`);
  } catch (error) {
    const logs = [first, restarted, second].filter(Boolean).map(runtime => runtime.output()).join('\n');
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${redact(logs)}`, { cause: error });
  } finally {
    await Promise.allSettled([
      first === undefined ? undefined : stopProcess(first.child),
      restarted === undefined ? undefined : stopProcess(restarted.child),
      second === undefined ? undefined : stopProcess(second.child),
      persistence === undefined ? undefined : stopProcess(persistence.child),
      provider === undefined ? undefined : provider.close(),
    ].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});
