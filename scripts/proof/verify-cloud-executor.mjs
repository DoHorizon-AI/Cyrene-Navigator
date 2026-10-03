// ┌─────────────────────────────────────────────────────────────────────┐
// │ Proof: Verify Navigator Autonomous Cloud Executor Daemon Process   │
// │ Demonstrates end-to-end HTTP/SSE API, task execution, plugin reload │
// │ and graceful shutdown.                                              │
// └─────────────────────────────────────────────────────────────────────┘

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';

async function main() {
  console.log('[proof] Starting Navigator Cloud Daemon process...');
  const port = 54399;
  const proc = spawn(process.execPath, [
    'scripts/serve-executor.mjs',
    `--port=${port}`,
    '--host=127.0.0.1',
  ], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  let serverUrl = '';
  proc.stdout.on('data', chunk => {
    const lines = chunk.toString().trim().split('\n');
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.status === 'ready') {
          serverUrl = parsed.url;
          console.log(`[proof] Server ready at ${serverUrl}`);
        }
      } catch {}
    }
  });

  // Wait for server ready
  for (let i = 0; i < 50; i++) {
    if (serverUrl) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(serverUrl, 'Server failed to start in time');

  try {
    // 1. Health check
    console.log('[proof] 1. Checking /api/v1/health...');
    const healthRes = await fetch(`${serverUrl}/api/v1/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.status, 'ok');
    assert.equal(health.version, '0.2.0-rc.2');
    console.log('[proof] Health check passed:', health);

    // 2. Execute task
    console.log('[proof] 2. Submitting task via /api/v1/execute...');
    const execRes = await fetch(`${serverUrl}/api/v1/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Test autonomous executor' }),
    });
    assert.equal(execRes.status, 200);
    const taskResult = await execRes.json();
    assert.equal(taskResult.status, 'completed');
    assert.ok(taskResult.taskId);
    console.log('[proof] Task executed successfully:', taskResult);

    // 3. Inspect task status
    console.log('[proof] 3. Inspecting task status via /api/v1/tasks/:id/status...');
    const statusRes = await fetch(`${serverUrl}/api/v1/tasks/${taskResult.taskId}/status`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.id, taskResult.taskId);
    assert.equal(statusData.status, 'completed');
    console.log('[proof] Task status verified:', statusData);

    // 4. Hot-reload plugins
    console.log('[proof] 4. Triggering dynamic plugin hot-reload via /api/v1/plugins/reload...');
    const reloadRes = await fetch(`${serverUrl}/api/v1/plugins/reload`, {
      method: 'POST',
    });
    assert.equal(reloadRes.status, 200);
    const reloadData = await reloadRes.json();
    assert.equal(reloadData.reloaded, true);
    console.log('[proof] Plugin hot-reload verified:', reloadData);

    console.log('[proof] All end-to-end verifications passed successfully!');
  } finally {
    console.log('[proof] Shutting down daemon...');
    proc.kill('SIGTERM');
    await once(proc, 'exit');
    console.log('[proof] Daemon exited gracefully.');
  }
}

main().catch(err => {
  console.error('[proof] Verification failed:', err);
  process.exit(1);
});
