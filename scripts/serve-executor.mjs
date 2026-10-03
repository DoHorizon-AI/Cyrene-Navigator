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
    host: { type: 'string', default: process.env.HOST ?? '0.0.0.0' },
    'plugins-dir': { type: 'string' },
    'watch-plugins': { type: 'boolean', default: true },
    'workspace-id': { type: 'string', default: process.env.CYRENE_WORKSPACE_ID ?? 'default' },
  },
});

const port = Number(values.port);
const host = values.host;

// Run as standalone process if invoked directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createExecutorApp({
    pluginsDir: values['plugins-dir'],
    watchPlugins: values['watch-plugins'],
    workspaceId: values['workspace-id'],
  }).then(async ({ executor, ctx, pluginsDir }) => {
    const { url, close } = await executor.startServer(port, host);
    const info = {
      service: 'cyrene-navigator-executor',
      status: 'ready',
      url,
      port,
      host,
      pid: process.pid,
      pluginsDir,
    };
    console.log(JSON.stringify(info));

    const shutdown = async () => {
      console.log(JSON.stringify({ service: 'cyrene-navigator-executor', status: 'shutting_down' }));
      await close();
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
