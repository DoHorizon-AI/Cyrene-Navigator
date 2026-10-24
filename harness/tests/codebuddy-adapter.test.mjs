import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { CodeBuddyLlmAdapter } from '../dist/codebuddy-adapter.js';
import { createExecutorApp } from '../dist/serve.js';

const tool = {
  name: 'echo',
  description: 'Return the supplied text.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
};

async function fixture(output, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'navigator-codebuddy-test-'));
  const script = join(root, 'fake-codebuddy.mjs');
  const record = join(root, 'request.json');
  const body = options.script ?? `
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const input = readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()) }));
${options.stdout === undefined ? output === undefined ? '' : `process.stdout.write(${JSON.stringify(JSON.stringify(output))});` : `process.stdout.write(${JSON.stringify(options.stdout)});`}
${options.exitCode ? `process.exitCode = ${options.exitCode};` : ''}
${options.hang ? 'setInterval(() => undefined, 1000);' : ''}
`;
  await writeFile(script, body, 'utf8');
  await chmod(script, 0o700);
  return {
    record,
    cleanup: () => rm(root, { recursive: true, force: true }),
    adapter: new CodeBuddyLlmAdapter({
      command: process.execPath,
      commandArgs: [script],
      requestTimeoutMs: options.timeoutMs ?? 5_000,
    }),
  };
}

function modelRequest(overrides = {}) {
  return {
    provider: 'codebuddy',
    model: 'glm-5.3-flash',
    system: 'Use the authorized workspace tools.',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Follow the Navigator safety policy.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Check the repository.' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId('prior-call'), name: 'echo', arguments: '{"text":"before"}' }],
      },
      {
        role: 'tool',
        toolCallId: ToolCallId('prior-call'),
        isError: false,
        content: [{ type: 'text', text: 'repository is clean' }],
      },
    ],
    tools: [tool],
    ...overrides,
  };
}

async function collect(adapter, options) {
  const chunks = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}

async function disposeApp(app) {
  await app.executor.dispose();
  await app.pluginManager?.dispose();
  await app.ctx.fiber.dispose();
}

function terminal(structured_output) {
  return [{ type: 'result', subtype: 'success', is_error: false, structured_output }];
}

test('CodeBuddy runs as a restricted structured-output planner and preserves DSH history', async t => {
  const instance = await fixture(terminal({ kind: 'final', text: 'The repository is clean.', tool_name: '', args: {} }));
  t.after(instance.cleanup);

  const chunks = await collect(instance.adapter, modelRequest());
  const request = JSON.parse(await readFile(instance.record, 'utf8'));
  const args = request.args;
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish']);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(request.cwdEntries.length, 0);
  assert.match(request.input, /repository is clean/u);
  assert.match(request.input, /Use the authorized workspace tools\./u);
  assert.match(request.input, /Follow the Navigator safety policy\./u);
  assert.match(request.input, /must call the allowed CodeBuddy CLI StructuredOutput tool exactly once/u);
  assert.match(request.input, /Never call or simulate a business tool, connector tool, or MCP tool/u);
  assert.match(request.input, /Return exactly one flat structured envelope/u);
  assert.match(request.input, /"tool_name":"","args":\{\}/u);
  assert.ok(args.includes('--print'));
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', 'StructuredOutput']);
  assert.deepEqual(args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 2), ['--allowedTools', 'StructuredOutput']);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(args.slice(args.indexOf('--max-turns'), args.indexOf('--max-turns') + 2), ['--max-turns', '2']);
  assert.deepEqual(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2), ['--mcp-config', '{"mcpServers":{}}']);
  assert.deepEqual(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2), ['--setting-sources', '']);
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--model') + 1], 'glm-5.3-flash');
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  assert.equal(schema.type, 'object');
  assert.equal(Object.hasOwn(schema, 'oneOf'), false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['args', 'kind', 'text', 'tool_name']);
  assert.deepEqual(schema.properties.kind.enum, ['final', 'tool_call']);
  assert.deepEqual(schema.properties.tool_name.enum, ['', 'echo']);
  assert.deepEqual(schema.properties.args, { type: 'object' });
  assert.deepEqual(schema.required, ['kind', 'text', 'tool_name', 'args']);
  assert.equal(schema.additionalProperties, false);
});

test('CodeBuddy tool calls become canonical DSH tool-call blocks after local schema validation', async t => {
  const instance = await fixture(terminal({ kind: 'tool_call', text: '', tool_name: 'echo', args: { text: 'hello' } }));
  t.after(instance.cleanup);

  const chunks = await collect(instance.adapter, modelRequest());
  const start = chunks.find(chunk => chunk.type === 'block-start');
  const end = chunks.find(chunk => chunk.type === 'block-end');
  assert.deepEqual(start, { type: 'block-start', index: 0, blockType: 'tool-call' });
  assert.equal(end.block.type, 'tool-call');
  assert.equal(end.block.name, 'echo');
  assert.deepEqual(JSON.parse(end.block.arguments), { text: 'hello' });
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
});

test('CodeBuddy rejects tool names outside the active catalog and schema-invalid arguments', async t => {
  const outside = await fixture(terminal({ kind: 'tool_call', text: '', tool_name: 'shell', args: { command: 'id' } }));
  t.after(outside.cleanup);
  await assert.rejects(collect(outside.adapter, modelRequest()), /outside the active DSH catalog/u);

  const invalid = await fixture(terminal({ kind: 'tool_call', text: '', tool_name: 'echo', args: { text: 'hello', extra: true } }));
  t.after(invalid.cleanup);
  await assert.rejects(collect(invalid.adapter, modelRequest()), /do not match the active DSH schema/u);
});

test('CodeBuddy enforces mutually exclusive flat-envelope semantics locally', async t => {
  const cases = [
    { kind: 'final', text: 'Done.', tool_name: 'echo', args: {} },
    { kind: 'final', text: 'Done.', tool_name: '', args: {}, unexpected: true },
    { kind: 'tool_call', text: 'not empty', tool_name: 'echo', args: { text: 'hello' } },
  ];
  for (const value of cases) {
    const instance = await fixture(terminal(value));
    t.after(instance.cleanup);
    await assert.rejects(collect(instance.adapter, modelRequest()), /invalid shape/u);
  }
});

test('CodeBuddy fails closed for nonzero exits, missing terminal results, and CLI errors', async t => {
  const malformed = await fixture(undefined, { stdout: 'not JSON' });
  t.after(malformed.cleanup);
  await assert.rejects(collect(malformed.adapter, modelRequest()), /malformed JSON output/u);

  const noTerminal = await fixture([{ type: 'assistant', message: 'not a terminal result' }]);
  t.after(noTerminal.cleanup);
  await assert.rejects(collect(noTerminal.adapter, modelRequest()), /did not end with a terminal result/u);

  const noStructuredOutput = await fixture([{ type: 'result', subtype: 'success', result: 'looks like a final answer' }]);
  t.after(noStructuredOutput.cleanup);
  await assert.rejects(collect(noStructuredOutput.adapter, modelRequest()), /omitted structured output/u);

  const terminalError = await fixture([{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'do not trust this text' }]);
  t.after(terminalError.cleanup);
  await assert.rejects(collect(terminalError.adapter, modelRequest()), /reported a failed model turn/u);

  const badExit = await fixture(terminal({ kind: 'final', text: 'looks successful', tool_name: '', args: {} }), { exitCode: 7 });
  t.after(badExit.cleanup);
  await assert.rejects(collect(badExit.adapter, modelRequest()), /exit code 7/u);
});

test('CodeBuddy enforces timeout and caller cancellation', async t => {
  const timed = await fixture(undefined, { hang: true, timeoutMs: 30 });
  t.after(timed.cleanup);
  await assert.rejects(collect(timed.adapter, modelRequest()), /timed out/u);

  const cancelled = await fixture(undefined, { hang: true });
  t.after(cancelled.cleanup);
  const controller = new AbortController();
  const pending = collect(cancelled.adapter, modelRequest({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 25).unref();
  await assert.rejects(pending, /cancelled/u);
});

test('CodeBuddy rejects schemas it cannot enforce instead of issuing a tool request', async t => {
  const instance = await fixture(terminal({ kind: 'tool_call', text: '', tool_name: 'echo', args: { text: 'hello' } }));
  t.after(instance.cleanup);
  const unsupported = { ...tool, parameters: { ...tool.parameters, properties: { text: { type: 'string', pattern: '^safe$' } } } };
  await assert.rejects(collect(instance.adapter, modelRequest({ tools: [unsupported] })), /DSH runtime cannot enforce/u);
});

test('serve selects CodeBuddy only when configured and retains Exchange as the default source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'navigator-codebuddy-source-'));
  const originalModel = process.env.CYRENE_HARNESS_MODEL;
  const originalExchangeToken = process.env.CYRENE_EXCHANGE_TOKEN;
  const apps = [];
  delete process.env.CYRENE_HARNESS_MODEL;
  process.env.CYRENE_EXCHANGE_TOKEN = 'test-only-exchange-token';
  t.after(async () => {
    for (const app of apps.reverse()) await disposeApp(app);
    if (originalModel === undefined) delete process.env.CYRENE_HARNESS_MODEL;
    else process.env.CYRENE_HARNESS_MODEL = originalModel;
    if (originalExchangeToken === undefined) delete process.env.CYRENE_EXCHANGE_TOKEN;
    else process.env.CYRENE_EXCHANGE_TOKEN = originalExchangeToken;
    await rm(root, { recursive: true, force: true });
  });

  const codebuddy = await createExecutorApp({
    testMode: true,
    modelSource: 'codebuddy',
    enableWorkflows: false,
    watchPlugins: false,
    pluginsDir: join(root, 'codebuddy-plugins'),
    defaultCwd: root,
  });
  apps.push(codebuddy);
  assert.deepEqual(codebuddy.ctx.get('agentDefaultModel').currentSelection(), {
    provider: 'codebuddy',
    model: 'glm-5.3-flash',
  });

  const exchange = await createExecutorApp({
    testMode: true,
    exchangeUrl: 'http://127.0.0.1:7777',
    model: 'compatibility-model',
    enableWorkflows: false,
    watchPlugins: false,
    pluginsDir: join(root, 'exchange-plugins'),
    defaultCwd: root,
  });
  apps.push(exchange);
  assert.deepEqual(exchange.ctx.get('agentDefaultModel').currentSelection(), {
    provider: 'cyrene-exchange',
    model: 'compatibility-model',
  });
});
