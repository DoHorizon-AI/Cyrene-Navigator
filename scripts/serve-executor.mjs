// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Autonomous Cloud Executor Daemon                  │
// │ Role: Standalone background daemon for cloud & local execution.     │
// │ 模块职责：Navigator 独立云端/本地执行器服务守护进程。                     │
// └─────────────────────────────────────────────────────────────────────┘

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createExecutorApp } from '../harness/dist/serve.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.PORT ?? '8080' },
    host: { type: 'string', default: process.env.HOST ?? '127.0.0.1' },
    'plugins-dir': { type: 'string' },
    'watch-plugins': { type: 'boolean', default: true },
    'workspace-id': { type: 'string', default: process.env.CYRENE_WORKSPACE_ID },
    'single-session-exchange-cli-auth': { type: 'boolean', default: false },
    'test-mode': { type: 'boolean', default: false },
    'test-echo-adapter': { type: 'boolean', default: false },
    'drain-timeout-ms': { type: 'string', default: process.env.CYRENE_EXECUTOR_DRAIN_TIMEOUT_MS ?? '30000' },
    'abort-cleanup-timeout-ms': { type: 'string', default: process.env.CYRENE_EXECUTOR_ABORT_CLEANUP_TIMEOUT_MS ?? '5000' },
  },
});

const port = Number(values.port);
const host = values.host;
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid executor port');
if (values['single-session-exchange-cli-auth'] && !['127.0.0.1', 'localhost'].includes(host)) {
  throw new TypeError('Single-session Exchange CLI auth is limited to a loopback executor');
}
const drainTimeoutMs = Number(values['drain-timeout-ms']);
const abortCleanupTimeoutMs = Number(values['abort-cleanup-timeout-ms']);
if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 0 || drainTimeoutMs > 900_000) {
  throw new TypeError('drain-timeout-ms must be between 0 and 900000');
}
if (!Number.isSafeInteger(abortCleanupTimeoutMs) || abortCleanupTimeoutMs < 0 || abortCleanupTimeoutMs > 30_000) {
  throw new TypeError('abort-cleanup-timeout-ms must be between 0 and 30000');
}

/** Bound post-drain cancellation cleanup so SIGTERM always has a terminal outcome. */
async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Bound executor and Cordis teardown together, including the fiber disposal deadline. */
export function disposeWithin(executor, fiber, timeoutMs) {
  return settleWithin((async () => {
    await executor.dispose();
    await fiber.dispose();
  })(), timeoutMs);
}

// Run as standalone process if invoked directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createExecutorApp({
    pluginsDir: values['plugins-dir'],
    watchPlugins: values['watch-plugins'],
    workspaceId: values['workspace-id'],
    allowSingleSessionExchangeCliEnvironmentBearer: values['single-session-exchange-cli-auth'],
    testMode: values['test-mode'],
    enableTestEchoAdapter: values['test-echo-adapter'],
  }).then(async ({ executor, ctx, pluginsDir }) => {
    const { url } = await executor.startServer(port, host);
    const info = {
      service: 'cyrene-navigator-executor',
      status: 'ready',
      url,
      port: Number(new URL(url).port),
      host,
      pid: process.pid,
      pluginsDir,
    };
    console.log(JSON.stringify(info));

    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      const drain = executor.startShutdownDrain();
      console.log(JSON.stringify({
        service: 'cyrene-navigator-executor',
        status: 'draining',
        instanceId: drain.instanceId,
        generation: drain.generation,
        startedAt: drain.startedAt,
        timeoutMs: drainTimeoutMs,
      }));
      let status;
      try {
        status = await executor.waitForIdle(drainTimeoutMs);
      } catch (error) {
        console.error(JSON.stringify({
          service: 'cyrene-navigator-executor',
          status: 'drain_status_failed',
          generation: drain.generation,
          error: error instanceof Error ? error.message : 'Drain status failed',
        }));
      }
      if (status?.activeWorkDrained === true) {
        const cleanupComplete = await disposeWithin(executor, ctx.fiber, abortCleanupTimeoutMs);
        if (cleanupComplete) {
          process.exit(0);
          return;
        }
        console.error(JSON.stringify({
          service: 'cyrene-navigator-executor',
          status: 'executor_or_context_disposal_incomplete',
          generation: drain.generation,
          cleanupTimeoutMs: abortCleanupTimeoutMs,
        }));
        process.exit(1);
        return;
      }

      console.error(JSON.stringify({
        service: 'cyrene-navigator-executor',
        status: 'drain_deadline_exceeded',
        generation: drain.generation,
        countsComplete: status?.countsComplete ?? false,
        activeTasks: status?.activeTasks ?? null,
        queuedTasks: status?.queuedTasks ?? null,
        dispatches: status?.dispatches ?? null,
        notifications: status?.notifications ?? null,
      }));
      const cleanupComplete = await disposeWithin(executor, ctx.fiber, abortCleanupTimeoutMs);
      if (cleanupComplete) {
        console.error(JSON.stringify({
          service: 'cyrene-navigator-executor',
          status: 'drain_deadline_exceeded_cleanup_completed',
          generation: drain.generation,
        }));
      } else {
        console.error(JSON.stringify({
          service: 'cyrene-navigator-executor',
          status: 'executor_or_context_disposal_incomplete',
          generation: drain.generation,
          cleanupTimeoutMs: abortCleanupTimeoutMs,
          recovery: 'Running task rows are not replayed; started notification leases become uncertain on expiry.',
        }));
      }
      process.exit(1);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch(err => {
    console.error('Failed to start Navigator Cloud Executor:', err);
    process.exit(1);
  });
}
