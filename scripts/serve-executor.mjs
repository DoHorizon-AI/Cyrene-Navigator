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
    'test-mode': { type: 'boolean', default: false },
    'test-echo-adapter': { type: 'boolean', default: false },
  },
});

const port = Number(values.port);
const host = values.host;
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid executor port');

// Run as standalone process if invoked directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createExecutorApp({
    pluginsDir: values['plugins-dir'],
    watchPlugins: values['watch-plugins'],
    workspaceId: values['workspace-id'],
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
      console.log(JSON.stringify({ service: 'cyrene-navigator-executor', status: 'shutting_down' }));
      await executor.dispose();
      await ctx.fiber.dispose();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch(err => {
    console.error('Failed to start Navigator Cloud Executor:', err);
    process.exit(1);
  });
}
