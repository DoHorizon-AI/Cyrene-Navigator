// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator official cloud connection integration              │
// │ Role: Verify MCP discovery/calls and bounded readonly gcloud argv.    │
// │ 模块职责：验证 MCP 发现与调用，以及受限只读 gcloud 参数。                │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import {
  buildGcloudReadonlyArgs,
  registerCloudConnections,
  runGcloudReadonly,
} from '../dist/integrations/index.js';

const mcpRequire = createRequire(new URL('../node_modules/@deepseek-ai/dsh-mcp-client/package.json', import.meta.url));
const { McpServer, createMcpHandler } = mcpRequire('@modelcontextprotocol/server');
const { toNodeHandler } = mcpRequire('@modelcontextprotocol/node');
const { z } = mcpRequire('zod');
const stdioPackageJson = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-mcp-client/package.json', import.meta.url));
const stdioFixture = fileURLToPath(new URL('./fixtures/official-cloud-mcp-stdio.mjs', import.meta.url));

async function startHttpMcp() {
  const calls = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'navigator-http-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.registerTool('ping', {
      description: 'Replies with the official HTTP fixture result.',
      inputSchema: z.object({}),
    }, async () => {
      calls.push('ping');
      return { content: [{ type: 'text', text: 'http:pong' }] };
    });
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  const server = createServer((request, response) => {
    Promise.resolve(nodeHandler(request, response)).catch(error => response.writeHead(500).end(String(error)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(message);
}

test('official profile hook discovers/calls local HTTP and stdio MCP servers without cloud credentials', { timeout: 30_000 }, async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const http = await startHttpMcp();
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    const registry = await registerCloudConnections(ctx, {
      schemaVersion: 1,
      profiles: [
        {
          kind: 'mcp', id: 'microsoft-learn', name: 'Microsoft Learn fixture',
          description: 'Local protocol fixture for the official Microsoft Learn profile.', enabled: true,
          serverName: 'microsoft_learn',
          source: {
            publisher: 'Microsoft', endpoint: 'https://learn.microsoft.com/api/mcp',
            documentation: 'https://learn.microsoft.com/en-us/training/support/mcp',
          },
          connection: { transport: 'streamable-http', url: http.url },
        },
        {
          kind: 'mcp', id: 'fixture-stdio', name: 'Local stdio fixture',
          description: 'Local stdio protocol fixture.', enabled: true,
          serverName: 'fixture_stdio',
          source: {
            publisher: 'Cyrene test fixture', endpoint: 'http://127.0.0.1:43123/stdio',
            documentation: 'http://127.0.0.1:43123/docs',
          },
          connection: { transport: 'stdio', command: process.execPath, args: [stdioFixture, stdioPackageJson] },
        },
        {
          kind: 'mcp', id: 'google-developer-knowledge', name: 'Google Developer Knowledge fixture',
          description: 'Credential reference resolution fixture.', enabled: true,
          serverName: 'google_dev_knowledge',
          source: {
            publisher: 'Google', endpoint: 'https://developerknowledge.googleapis.com/mcp',
            documentation: 'https://developers.google.com/knowledge/reference/mcp',
          },
          connection: {
            transport: 'streamable-http', url: 'https://developerknowledge.googleapis.com/mcp',
            headerEnvRefs: { 'X-Goog-Api-Key': 'CYRENE_FIXTURE_DK_KEY_MISSING' },
          },
        },
      ],
    });

    await waitFor(() => registry.get('microsoft-learn')?.tools.some(tool => tool.name === 'mcp__microsoft_learn__ping')
      && registry.get('fixture-stdio')?.tools.some(tool => tool.name === 'mcp__fixture_stdio__echo'),
    'MCP tools were not discovered from the local fixtures');
    assert.equal(registry.get('microsoft-learn')?.status, 'available');
    assert.equal(registry.get('fixture-stdio')?.status, 'available');
    assert.equal(registry.get('google-developer-knowledge')?.status, 'missing-credential');
    assert.equal(registry.get('microsoft-learn')?.tools[0]?.description, 'Replies with the official HTTP fixture result.');
    assert.deepEqual(registry.workflowReadonlyTools('microsoft-learn'), ['mcp__microsoft_learn__ping']);
    assert.deepEqual(registry.workflowReadonlyTools('google-developer-knowledge'), [],
      'a missing credential must not grant workflow access to an undiscovered server');
    assert.deepEqual(registry.workflowReadonlyTools('huggingface'), [],
      'Hugging Face tools remain excluded from scheduled workflows without a source-backed readonly classification');

    const httpResult = await ctx.tools.execute({
      name: 'mcp__microsoft_learn__ping', arguments: {},
      callId: ToolCallId('cloud-http-tool-call'), signal: new AbortController().signal,
    });
    assert.equal(httpResult.isError, false);
    assert.deepEqual(httpResult.value?.content, [{ type: 'text', text: 'http:pong' }]);

    const stdioResult = await ctx.tools.execute({
      name: 'mcp__fixture_stdio__echo', arguments: { value: 'safe' },
      callId: ToolCallId('cloud-stdio-tool-call'), signal: new AbortController().signal,
    });
    assert.equal(stdioResult.isError, false);
    assert.deepEqual(stdioResult.value?.content, [{ type: 'text', text: 'stdio:safe' }]);
    assert.deepEqual(http.calls, ['ping']);
    assert.equal(JSON.stringify(registry.list()).includes('CYRENE_FIXTURE_DK_KEY_MISSING'), false,
      'health snapshots must never reveal env-reference names or credential values');
  } finally {
    await ctx.fiber.dispose().catch(() => undefined);
    await http.close();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('gcloud readonly adapter builds finite argv and rejects unlisted targets or operations', async () => {
  const config = { allowedProjectIds: ['alpha-project'], timeoutMs: 3_000, maxOutputBytes: 4096 };
  assert.deepEqual(buildGcloudReadonlyArgs('compute.instances.list', 'alpha-project', config), [
    'compute', 'instances', 'list', '--project=alpha-project', '--format=json(name,zone,status,machineType)',
  ]);
  const calls = [];
  const output = await runGcloudReadonly('projects.describe', 'alpha-project', config, new AbortController().signal,
    async (command, args, options) => {
      calls.push({ command, args, options });
      return '{"projectId":"alpha-project"}';
    });
  assert.equal(output, '{"projectId":"alpha-project"}');
  assert.equal(calls[0]?.command, 'gcloud');
  assert.deepEqual(calls[0]?.args, ['projects', 'describe', 'alpha-project', '--format=json(projectId,name,lifecycleState)']);
  assert.equal(calls[0]?.options.timeoutMs, 3_000);
  await assert.rejects(runGcloudReadonly('projects.delete', 'alpha-project', config, new AbortController().signal,
    async () => '{}'), /not in the readonly allowlist/);
  await assert.rejects(runGcloudReadonly('projects.describe', 'other-project', config, new AbortController().signal,
    async () => '{}'), /not in the configured allowlist/);
});
