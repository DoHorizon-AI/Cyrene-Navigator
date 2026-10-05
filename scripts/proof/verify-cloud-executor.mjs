// ┌─────────────────────────────────────────────────────────────────────┐
// │ Proof: Verify authenticated Navigator executor with test adapter    │
// │ Scope: REST, durable SSE replay, task state, and graceful shutdown. │
// │ 范围：认证 REST、SSE 重放、任务状态和正常关闭。                       │
// └─────────────────────────────────────────────────────────────────────┘

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const bearer = 'navigator-proof-only-token';

async function main() {
  const port = 54399;
  const proc = spawn(process.execPath, [
    'scripts/serve-executor.mjs',
    `--port=${port}`,
    '--host=127.0.0.1',
    '--test-mode',
    '--test-echo-adapter',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, CYRENE_EXECUTOR_TOKEN: bearer },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(proc, 'exit');
  let serverUrl = '';
  let buffer = '';
  proc.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const parsed = JSON.parse(line);
        if (parsed.status === 'ready') serverUrl = parsed.url;
      } catch {}
      newline = buffer.indexOf('\n');
    }
  });

  const headers = { Authorization: `Bearer ${bearer}` };
  try {
    for (let i = 0; i < 50 && !serverUrl; i += 1) await delay(100);
    assert.ok(serverUrl, 'Server failed to start in time');

    const healthRes = await fetch(`${serverUrl}/api/v1/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.service, 'cyrene-navigator-executor');
    assert.equal(health.version, '0.2.0-rc.2');

    const denied = await fetch(`${serverUrl}/api/v1/tasks`);
    assert.equal(denied.status, 401);

    const createRes = await fetch(`${serverUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Test isolated executor proof' }),
    });
    assert.equal(createRes.status, 202);
    const admitted = await createRes.json();
    assert.equal(admitted.status, 'queued');

    let task = admitted;
    for (let i = 0; i < 100 && !['completed', 'failed', 'aborted'].includes(task.status); i += 1) {
      await delay(50);
      const statusRes = await fetch(`${serverUrl}/api/v1/tasks/${admitted.id}`, { headers });
      assert.equal(statusRes.status, 200);
      task = await statusRes.json();
    }
    assert.equal(task.status, 'completed');
    assert.match(task.output, /Test isolated executor proof/u);

    const streamRes = await fetch(`${serverUrl}/api/v1/tasks/${admitted.id}/events?after=0`, { headers });
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get('content-type'), /text\/event-stream/u);
    const stream = await streamRes.text();
    assert.match(stream, /id: \d+\nevent: finish/u);
    assert.match(stream, /"status":"completed"/u);

    const pluginsRes = await fetch(`${serverUrl}/api/v1/plugins`, { headers });
    assert.equal(pluginsRes.status, 200);
    assert.ok(Array.isArray((await pluginsRes.json()).plugins));
    const reloadRes = await fetch(`${serverUrl}/api/v1/plugins/reload`, {
      method: 'POST', headers,
    });
    assert.equal(reloadRes.status, 200);
    assert.equal((await reloadRes.json()).reloaded, true);

    console.log('[proof] SIMULATED: authenticated REST, queue dispatch, ordered SSE replay, plugin access, and explicit test echo passed.');
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(code, 0, `Daemon exit code=${code}, signal=${signal}`);
  }
}

main().catch(err => {
  console.error('[proof] Verification failed:', err);
  process.exit(1);
});
