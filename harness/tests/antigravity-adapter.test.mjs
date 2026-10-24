import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import {
  ANTIGRAVITY_MODEL_AGENT_NAME,
  ANTIGRAVITY_MODEL_AGENT_PROFILE,
  AntigravityLlmAdapter,
  DEFAULT_ANTIGRAVITY_MODEL,
} from '../dist/antigravity-adapter.js';
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

async function fixture(structuredOutput, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'navigator-antigravity-test-'));
  const profile = join(root, '.gemini', 'config', 'agents', `${ANTIGRAVITY_MODEL_AGENT_NAME}.md`);
  const script = join(root, 'fake-agy.mjs');
  const record = join(root, 'request.json');
  await mkdir(join(root, '.gemini', 'config', 'agents'), { recursive: true });
  await writeFile(profile, options.profile ?? ANTIGRAVITY_MODEL_AGENT_PROFILE, 'utf8');
  await chmod(profile, 0o600);

  const eventFrames = options.events ?? [
    {
      event: 'init',
      init: {
        model: DEFAULT_ANTIGRAVITY_MODEL,
        agent: ANTIGRAVITY_MODEL_AGENT_NAME,
        permission_mode: 'strict',
        // init.tools is the CLI registry inventory; effective custom-agent access is verified by actual steps.
        tools: ['run_command', 'write_to_file', 'finish'],
      },
    },
    { event: 'step_update', step_update: { step_type: 'user_input', state: 'DONE' } },
    { event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE' } },
    { event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'finish', step_index: 2 } },
    { event: 'step_update', step_update: { step_type: 'finish', state: 'DONE', step_index: 2 } },
    {
      event: 'result',
      result: {
        status: 'SUCCESS',
        structured_output: structuredOutput,
      },
    },
  ];
  const scriptBody = options.script ?? `
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const input = readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args,
  input,
  cwd: process.cwd(),
  cwdEntries: readdirSync(process.cwd()),
  forbiddenEnvironmentPresent: ['CYRENE_SESSION_TOKEN', 'CYRENE_EXCHANGE_TOKEN', 'GITHUB_TOKEN'].some(name => process.env[name] !== undefined),
}));
const frames = ${JSON.stringify(eventFrames)};
const stdout = Buffer.from(frames.map(frame => JSON.stringify(frame)).join('\\n') + '\\n');
if (${options.splitUtf8 === true ? 'true' : 'false'}) {
  const marker = stdout.indexOf(Buffer.from('检'));
  if (marker < 0) throw new Error('UTF-8 split fixture marker was not found');
  process.stdout.write(stdout.subarray(0, marker + 1));
  setTimeout(() => process.stdout.write(stdout.subarray(marker + 1)), 5);
} else {
  process.stdout.write(stdout);
}
${options.exitCode ? `process.exitCode = ${options.exitCode};` : ''}
${options.hang ? 'setInterval(() => undefined, 1000);' : ''}
`;
  await writeFile(script, scriptBody, 'utf8');
  await chmod(script, 0o700);
  return {
    root,
    record,
    cleanup: () => rm(root, { recursive: true, force: true }),
    adapter: new AntigravityLlmAdapter({
      command: process.execPath,
      commandArgs: [script],
      requestTimeoutMs: options.timeoutMs ?? 5_000,
      maxOutputBytes: options.maxOutputBytes,
    }),
  };
}

function modelRequest(overrides = {}) {
  return {
    provider: 'antigravity',
    model: DEFAULT_ANTIGRAVITY_MODEL,
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

function finalEnvelope(text = 'The repository is clean.') {
  return { kind: 'final', text, tool_name: '', args: {} };
}

function callEnvelope(toolName = 'echo', args = { text: 'hello' }) {
  return { kind: 'tool_call', text: '', tool_name: toolName, args };
}

async function withHome(t, home, callback) {
  const originalHome = process.env.HOME;
  const originalSessionToken = process.env.CYRENE_SESSION_TOKEN;
  const originalExchangeToken = process.env.CYRENE_EXCHANGE_TOKEN;
  const originalGitHubToken = process.env.GITHUB_TOKEN;
  process.env.HOME = home;
  process.env.CYRENE_SESSION_TOKEN = 'synthetic-session-token';
  process.env.CYRENE_EXCHANGE_TOKEN = 'synthetic-exchange-token';
  process.env.GITHUB_TOKEN = 'synthetic-github-token';
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSessionToken === undefined) delete process.env.CYRENE_SESSION_TOKEN;
    else process.env.CYRENE_SESSION_TOKEN = originalSessionToken;
    if (originalExchangeToken === undefined) delete process.env.CYRENE_EXCHANGE_TOKEN;
    else process.env.CYRENE_EXCHANGE_TOKEN = originalExchangeToken;
    if (originalGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalGitHubToken;
  });
  await callback();
}

test('Antigravity uses the pinned no-tools agent and preserves split UTF-8 output', async t => {
  const instance = await fixture(finalEnvelope('检查完成。'), { splitUtf8: true });
  t.after(instance.cleanup);
  await withHome(t, instance.root, async () => {
    const chunks = await collect(instance.adapter, modelRequest());
    const request = JSON.parse(await readFile(instance.record, 'utf8'));
    const args = request.args;
    const stdinFrame = JSON.parse(request.input);
    assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish']);
    assert.equal(chunks[1].text, '检查完成。');
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.equal(request.cwdEntries.length, 0);
    assert.equal(request.forbiddenEnvironmentPresent, false);
    assert.equal(stdinFrame.event, 'user');
    assert.equal(stdinFrame.message.content[0].type, 'text');
    assert.match(stdinFrame.message.content[0].text, /repository is clean/u);
    assert.match(stdinFrame.message.content[0].text, /calling the allowed finish tool once/u);
    assert.ok(!args.some(argument => argument.includes('Check the repository.')));
    assert.deepEqual(args.slice(args.indexOf('--input-format'), args.indexOf('--input-format') + 2), ['--input-format', 'stream-json']);
    assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2), ['--output-format', 'stream-json']);
    assert.ok(args.includes('--disable-slash-commands'));
    assert.deepEqual(args.slice(args.indexOf('--agent'), args.indexOf('--agent') + 2), ['--agent', ANTIGRAVITY_MODEL_AGENT_NAME]);
    assert.equal(args[args.indexOf('--model') + 1], DEFAULT_ANTIGRAVITY_MODEL);
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
    assert.equal(schema.properties.tool_name.type, 'string');
    assert.equal(Object.hasOwn(schema.properties.tool_name, 'enum'), false);
    assert.equal(schema.properties.args.type, 'object');
    assert.deepEqual(schema.properties.kind.enum, ['final', 'tool_call']);
    assert.equal(Object.values(schema.properties).some(value => Array.isArray(value.enum) && value.enum.length === 0), false);
  });
});

test('Antigravity converts a validated DSH request into one DSH-owned tool call', async t => {
  const instance = await fixture(callEnvelope());
  t.after(instance.cleanup);
  await withHome(t, instance.root, async () => {
    const chunks = await collect(instance.adapter, modelRequest());
    const end = chunks.find(chunk => chunk.type === 'block-end');
    assert.equal(end.block.type, 'tool-call');
    assert.equal(end.block.name, 'echo');
    assert.deepEqual(JSON.parse(end.block.arguments), { text: 'hello' });
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  });
});

test('Antigravity rejects non-finish native tools even when the CLI reports success', async t => {
  const events = [
    {
      event: 'init',
      init: { model: DEFAULT_ANTIGRAVITY_MODEL, agent: ANTIGRAVITY_MODEL_AGENT_NAME, permission_mode: 'strict', tools: ['run_command', 'finish'] },
    },
    { event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'run_command', step_index: 1 } },
    { event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'finish', step_index: 2 } },
    { event: 'result', result: { status: 'SUCCESS', structured_output: finalEnvelope() } },
  ];
  const instance = await fixture(finalEnvelope(), { events });
  t.after(instance.cleanup);
  await withHome(t, instance.root, async () => {
    await assert.rejects(collect(instance.adapter, modelRequest()), /native tool outside finish/u);
  });
});

test('Antigravity fails closed for a different profile, model, agent, or permission mode', async t => {
  const instance = await fixture(finalEnvelope());
  t.after(instance.cleanup);
  await withHome(t, instance.root, async () => {
    const profilePath = join(instance.root, '.gemini', 'config', 'agents', `${ANTIGRAVITY_MODEL_AGENT_NAME}.md`);
    await writeFile(profilePath, ANTIGRAVITY_MODEL_AGENT_PROFILE.replace('tools:\n  - finish', 'tools: []'), 'utf8');
    await assert.rejects(collect(instance.adapter, modelRequest()), /profile is unavailable or differs/u);
    await writeFile(profilePath, ANTIGRAVITY_MODEL_AGENT_PROFILE, 'utf8');
  });

  const wrongAgent = await fixture(finalEnvelope(), {
    events: [{ event: 'init', init: { model: DEFAULT_ANTIGRAVITY_MODEL, agent: 'other-agent', permission_mode: 'strict' } }],
  });
  t.after(wrongAgent.cleanup);
  await withHome(t, wrongAgent.root, async () => {
    await assert.rejects(collect(wrongAgent.adapter, modelRequest()), /unexpected model, agent, or permission mode/u);
  });

  const wrongPermission = await fixture(finalEnvelope(), {
    events: [{ event: 'init', init: { model: DEFAULT_ANTIGRAVITY_MODEL, agent: ANTIGRAVITY_MODEL_AGENT_NAME, permission_mode: 'always-proceed' } }],
  });
  t.after(wrongPermission.cleanup);
  await withHome(t, wrongPermission.root, async () => {
    await assert.rejects(collect(wrongPermission.adapter, modelRequest()), /unexpected model, agent, or permission mode/u);
  });
});

test('Antigravity requires a successful structured terminal result and successful process exit', async t => {
  const cases = [
    { events: [{ event: 'init', init: { model: DEFAULT_ANTIGRAVITY_MODEL, agent: ANTIGRAVITY_MODEL_AGENT_NAME, permission_mode: 'strict' } }], pattern: /successful terminal result/u },
    {
      events: [
        { event: 'init', init: { model: DEFAULT_ANTIGRAVITY_MODEL, agent: ANTIGRAVITY_MODEL_AGENT_NAME, permission_mode: 'strict' } },
        { event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'finish', step_index: 2 } },
        { event: 'result', result: { status: 'SUCCESS', response: 'must not be treated as structured output' } },
      ],
      pattern: /omitted structured output/u,
    },
  ];
  for (const item of cases) {
    const instance = await fixture(finalEnvelope(), { events: item.events });
    t.after(instance.cleanup);
    await withHome(t, instance.root, async () => {
      await assert.rejects(collect(instance.adapter, modelRequest()), item.pattern);
    });
  }

  const failed = await fixture(finalEnvelope(), { exitCode: 7 });
  t.after(failed.cleanup);
  await withHome(t, failed.root, async () => {
    await assert.rejects(collect(failed.adapter, modelRequest()), /exit code 7/u);
  });
});

test('Antigravity validates tool names, arguments, and the closed response shape locally', async t => {
  const cases = [
    { output: callEnvelope('shell', { command: 'id' }), pattern: /outside the active DSH catalog/u },
    { output: callEnvelope('echo', { text: 'hello', extra: true }), pattern: /do not match the active DSH schema/u },
    { output: { ...finalEnvelope(), unexpected: true }, pattern: /invalid shape/u },
  ];
  for (const item of cases) {
    const instance = await fixture(item.output);
    t.after(instance.cleanup);
    await withHome(t, instance.root, async () => {
      await assert.rejects(collect(instance.adapter, modelRequest()), item.pattern);
    });
  }
});

test('Antigravity enforces one finish step index and bounded process lifetime/output', async t => {
  const mismatchedFinish = await fixture(finalEnvelope(), {
    events: [
      { event: 'init', init: { model: DEFAULT_ANTIGRAVITY_MODEL, agent: ANTIGRAVITY_MODEL_AGENT_NAME, permission_mode: 'strict' } },
      { event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'finish', step_index: 2 } },
      { event: 'step_update', step_update: { step_type: 'finish', state: 'DONE', step_index: 3 } },
    ],
  });
  t.after(mismatchedFinish.cleanup);
  await withHome(t, mismatchedFinish.root, async () => {
    await assert.rejects(collect(mismatchedFinish.adapter, modelRequest()), /did not match its active schema step/u);
  });

  const timeout = await fixture(finalEnvelope(), { hang: true, timeoutMs: 100 });
  t.after(timeout.cleanup);
  await withHome(t, timeout.root, async () => {
    await assert.rejects(collect(timeout.adapter, modelRequest()), /timed out after 100 ms/u);
  });

  const limited = await fixture(finalEnvelope(), { maxOutputBytes: 64 });
  t.after(limited.cleanup);
  await withHome(t, limited.root, async () => {
    await assert.rejects(collect(limited.adapter, modelRequest()), /exceeded the configured limit/u);
  });

  const cancelled = await fixture(finalEnvelope(), { hang: true, timeoutMs: 5_000 });
  t.after(cancelled.cleanup);
  await withHome(t, cancelled.root, async () => {
    const controller = new AbortController();
    const pending = collect(cancelled.adapter, modelRequest({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50).unref();
    await assert.rejects(pending, /request was cancelled/u);
  });
});

test('Antigravity model catalog is narrow and keeps the 3.8 Flash medium default', async () => {
  const adapter = new AntigravityLlmAdapter();
  const models = await adapter.listModels('antigravity');
  assert.deepEqual(models.map(model => model.id), [
    'gemini-3.8-flash-low',
    DEFAULT_ANTIGRAVITY_MODEL,
    'gemini-3.8-flash-high',
  ]);
  await assert.rejects(adapter.resolveModel('antigravity', 'gemini-4-argon'), /not in the service model allowlist/u);
});

test('serve selects Antigravity for new agents and retains the prior CodeBuddy route', async t => {
  const root = await mkdtemp(join(tmpdir(), 'navigator-antigravity-source-'));
  const profilePath = join(root, '.gemini', 'config', 'agents', `${ANTIGRAVITY_MODEL_AGENT_NAME}.md`);
  const originalHome = process.env.HOME;
  const originalModel = process.env.CYRENE_HARNESS_MODEL;
  const app = await (async () => {
    await mkdir(join(root, '.gemini', 'config', 'agents'), { recursive: true });
    await writeFile(profilePath, ANTIGRAVITY_MODEL_AGENT_PROFILE, 'utf8');
    await chmod(profilePath, 0o600);
    process.env.HOME = root;
    delete process.env.CYRENE_HARNESS_MODEL;
    return createExecutorApp({
      testMode: true,
      modelSource: 'antigravity',
      enableWorkflows: false,
      watchPlugins: false,
      pluginsDir: join(root, 'plugins'),
      defaultCwd: root,
    });
  })();
  t.after(async () => {
    await disposeApp(app);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalModel === undefined) delete process.env.CYRENE_HARNESS_MODEL;
    else process.env.CYRENE_HARNESS_MODEL = originalModel;
    await rm(root, { recursive: true, force: true });
  });

  assert.deepEqual(app.ctx.get('agentDefaultModel').currentSelection(), {
    provider: 'antigravity',
    model: DEFAULT_ANTIGRAVITY_MODEL,
  });
  assert.ok((await app.ctx.llm.listModels('antigravity')).some(model => model.id === DEFAULT_ANTIGRAVITY_MODEL));
  assert.ok((await app.ctx.llm.listModels('codebuddy')).some(model => model.id === 'glm-5.3-flash'));
});
