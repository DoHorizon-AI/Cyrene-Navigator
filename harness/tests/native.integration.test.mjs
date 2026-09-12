// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator native boundary integration checks              │
// │ Role: Exercise the real Rust host and supervised stdio failures.   │
// │ 模块职责：验证真实 Rust 宿主和受监督 stdio 故障路径。                │
// └─────────────────────────────────────────────────────────────────────┘
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { runNativeRequest } from '../dist/native-ipc.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = {
  binary: process.env.CYRENE_NATIVE_HOST ?? join(
    repository, 'native/target/debug',
    process.platform === 'win32' ? 'cyrene-native-host.exe' : 'cyrene-native-host',
  ),
  timeoutMs: 10_000,
  cancelGraceMs: 300,
  maxResponseBytes: 1_048_576,
};
const fixtureBinary = process.env.CYRENE_NATIVE_MATRIX_BINARY
  ?? join(repository, 'harness/tests/fixtures',
    process.platform === 'win32' ? 'native-matrix-host.exe' : 'native-matrix-host.mjs');

function requireFixtureBinary() {
  if (!existsSync(fixtureBinary)) {
    throw new Error(`Native matrix fixture is missing: ${fixtureBinary}`);
  }
}

function fixtureConfig(overrides = {}) {
  requireFixtureBinary();
  return {
    binary: fixtureBinary,
    timeoutMs: 2_000,
    cancelGraceMs: 100,
    maxResponseBytes: 1_048_576,
    ...overrides,
  };
}

async function fixtureDirectory(prefix, mode) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const statePath = join(directory, 'state.json');
  await writeFile(join(directory, '.cyrene-native-fixture.json'), JSON.stringify({ mode, statePath }));
  return { directory, statePath };
}

async function readState(statePath) {
  return JSON.parse(await readFile(statePath, 'utf8'));
}

async function waitForState(statePath, expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await readState(statePath);
      if (typeof expected === 'function' ? expected(value) : value.status === expected) return value;
    } catch {
      // The fixture has not published its first durable state yet.
    }
    await new Promise(resolveNext => setTimeout(resolveNext, 10));
  }
  throw new Error(`fixture state ${JSON.stringify(expected)} was not observed`);
}

async function waitForReaped(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let present = false;
    if (process.platform === 'linux') {
      try {
        readFileSync(`/proc/${pid}/stat`, 'utf8');
        present = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    } else {
      try {
        process.kill(pid, 0);
        present = true;
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    if (!present) return;
    await new Promise(resolveNext => setTimeout(resolveNext, 20));
  }
  throw new Error(`fixture pid ${pid} was not reaped`);
}

async function captureRejection(promise, label) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail(`${label} must reject`);
}

async function assertFixtureRejected(ctx, mode, expected, overrides = {}) {
  const fixture = await fixtureDirectory('cyrene-native-matrix-', mode);
  try {
    const error = await captureRejection(runNativeRequest(
      ctx, fixtureConfig(overrides), fixture.directory, 'fixture_operation', {},
      new AbortController().signal,
    ), `${mode} pending request`);
    if (expected !== undefined) assert.match(String(error?.message ?? error), expected);
    const state = await waitForState(
      fixture.statePath,
      value => Number.isInteger(value.pid) && value.pid > 0,
    );
    await waitForReaped(state.pid);
    return { error, state };
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

test('Windows supervisor evidence uses the pinned Node runtime', () => {
  if (process.platform === 'win32') assert.equal(process.versions.node, '24.13.0');
});

test('real Rust host rejects invalid arguments and a missing executable', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(LocalSubprocessRuntime);
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-native-cli-'));
  try {
    const executable = await ctx.subprocess.resolveExecutable(config.binary);
    const invalid = ctx.subprocess.spawn({
      argv: [executable, '--cyrene-native-invalid-argument'],
      cwd: directory,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1_024 }, stderr: { maxBytes: 4_096 } },
      graceMs: 100,
    });
    const invalidOutcome = await invalid.done;
    assert.equal(invalidOutcome.exitCode, 2);
    assert.equal(await invalid.waitForExit(), true);
    assert.equal(invalid.collected.stdout?.readFrom(0)?.text, '');
    assert.match(invalid.collected.stderr?.readFrom(0)?.text ?? '', /unknown argument/);

    const missing = ctx.subprocess.spawn({
      argv: [join(directory, process.platform === 'win32' ? 'missing.exe' : 'missing')],
      cwd: directory,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1_024 }, stderr: { maxBytes: 1_024 } },
      graceMs: 100,
    });
    await assert.rejects(missing.done, /ENOENT|not found|spawn/u);
    assert.equal(missing.pid, -1);
    assert.equal(await missing.waitForExit(), true);
  } finally {
    await fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancelled calls do not launch a native host', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(LocalSubprocessRuntime);
  const controller = new AbortController();
  controller.abort(new Error('cancelled before dispatch'));
  try {
    await assert.rejects(
      runNativeRequest(ctx, config, repository, 'hello', {}, controller.signal),
      /cancelled before dispatch/,
    );
  } finally {
    await fiber.dispose();
  }
});

test('Codex history stays non-executable through the actual stdio boundary', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(LocalSubprocessRuntime);
  try {
    const result = await runNativeRequest(ctx, config, repository, 'import_codex_rollout', {
      path: join(repository, 'native/crates/cyrene-native-host/tests/fixtures/codex-rollout.jsonl'),
      include_raw: true,
    }, new AbortController().signal);
    assert.equal(result.safety.history_replayed, false);
    assert.ok(result.conversion_report);
    assert.ok(result.source_sha256);
  } finally {
    await fiber.dispose();
  }
});

test('active cancellation reaches the child and rejects the pending request', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(LocalSubprocessRuntime);
  const fixture = await fixtureDirectory('cyrene-native-cancel-', 'active-cancel');
  const controller = new AbortController();
  try {
    const pending = runNativeRequest(
      ctx, fixtureConfig(), fixture.directory, 'fixture_operation', {}, controller.signal,
    );
    const active = await waitForState(fixture.statePath, 'active');
    controller.abort(new Error('user cancelled native operation'));
    await assert.rejects(pending, /fixture observed cancel/);
    await waitForState(fixture.statePath, 'exited');
    await waitForReaped(active.pid);
  } finally {
    await fiber.dispose();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('deadline cancellation terminates an unresponsive child and reaps it', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(LocalSubprocessRuntime);
  const fixture = await fixtureDirectory('cyrene-native-timeout-', 'active-timeout');
  try {
    const startedAt = performance.now();
    const pending = runNativeRequest(
      ctx,
      fixtureConfig({ timeoutMs: 1_000, cancelGraceMs: 100 }),
      fixture.directory,
      'fixture_operation',
      {},
      new AbortController().signal,
    );
    await waitForState(fixture.statePath, 'active');
    await assert.rejects(pending, /Native host exited before a result/);
    assert.ok(performance.now() - startedAt < 4_000);
    const stopped = await waitForState(
      fixture.statePath,
      value => value.status === 'exited' || value.status === 'cancel-received',
    );
    await waitForReaped(stopped.pid);
  } finally {
    await fiber.dispose();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('crash and clean EOF reject pending requests and leave no child behind', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(LocalSubprocessRuntime);
  try {
    for (const mode of ['crash', 'eof']) {
      await assertFixtureRejected(ctx, mode, /Native host exited before a result/);
    }
  } finally {
    await fiber.dispose();
  }
});

test('multiple pending requests reject independently when their hosts exit', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(LocalSubprocessRuntime);
  const fixtures = await Promise.all(
    ['crash', 'eof'].map(mode => fixtureDirectory('cyrene-native-pending-', mode)),
  );
  try {
    const pending = fixtures.map(fixture => runNativeRequest(
      ctx,
      fixtureConfig(),
      fixture.directory,
      'fixture_operation',
      {},
      new AbortController().signal,
    ));
    const errors = await Promise.all(
      pending.map(request => captureRejection(request, 'pending native request')),
    );
    errors.forEach(error => assert.match(
      String(error?.message ?? error),
      /Native host exited before a result|EPIPE/,
    ));
    for (const fixture of fixtures) {
      const stopped = await waitForState(fixture.statePath, 'exited');
      await waitForReaped(stopped.pid);
    }
  } finally {
    await fiber.dispose();
    await Promise.all(
      fixtures.map(fixture => rm(fixture.directory, { recursive: true, force: true })),
    );
  }
});

test('protocol version mismatch is fail-closed', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(LocalSubprocessRuntime);
  try {
    await assertFixtureRejected(ctx, 'version-mismatch', /Native protocol version mismatch/);
    await assertFixtureRejected(ctx, 'handshake-mismatch', /Native handshake version mismatch/);
  } finally {
    await fiber.dispose();
  }
});

test('oversized stdout is rejected before parsing an unbounded response', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(LocalSubprocessRuntime);
  try {
    await assertFixtureRejected(ctx, 'oversized-stdout', /Native response exceeded its byte limit/, {
      maxResponseBytes: 4_096,
    });
  } finally {
    await fiber.dispose();
  }
});

test('stdout diagnostics fail closed without echoing a credential-shaped value', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(LocalSubprocessRuntime);
  try {
    const result = await assertFixtureRejected(ctx, 'stdout-log');
    assert.doesNotMatch(String(result.error?.message ?? result.error), /native-matrix-test-secret/);
  } finally {
    await fiber.dispose();
  }
});

test('stderr remains bounded and credentials never enter the child', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(LocalSubprocessRuntime);
  const fixture = await fixtureDirectory('cyrene-native-stderr-', 'stderr-cap');
  const previousSecret = process.env.CYRENE_NATIVE_TEST_SECRET;
  process.env.CYRENE_NATIVE_TEST_SECRET = 'credential-that-must-not-be-forwarded';
  try {
    const result = await runNativeRequest(
      ctx, fixtureConfig(), fixture.directory, 'fixture_operation', {},
      new AbortController().signal,
    );
    assert.equal(result.secret_env_present, false);
    assert.equal(result.stderr_bytes_written, 64 * 1024 + 'native-matrix-test-secret'.length);
    const stopped = await waitForState(fixture.statePath, 'exited');
    await waitForReaped(stopped.pid);

    const directFixture = await fixtureDirectory('cyrene-native-stderr-direct-', 'stderr-cap');
    try {
      const direct = ctx.subprocess.spawn({
        argv: [fixtureBinary],
        cwd: directFixture.directory,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1_024 }, stderr: { maxBytes: 16_384 } },
        graceMs: 100,
      });
      const outcome = await direct.done;
      await direct.waitForExit();
      const stderr = direct.collected.stderr?.readFrom(0);
      assert.equal(outcome.exitCode, 0);
      assert.ok(stderr?.lossy);
      assert.ok(Buffer.byteLength(stderr?.text ?? '') <= 16_384);
      assert.doesNotMatch(stderr?.text ?? '', /native-matrix-test-secret/);
    } finally {
      await rm(directFixture.directory, { recursive: true, force: true });
    }
  } finally {
    if (previousSecret === undefined) delete process.env.CYRENE_NATIVE_TEST_SECRET;
    else process.env.CYRENE_NATIVE_TEST_SECRET = previousSecret;
    await fiber.dispose();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
