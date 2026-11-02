// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator conversation plugin hook tests                     │
// │ Role: Real Cordis context, real dynamic loader, real media bridge.    │
// │ 模块职责：验证插件只能提议上下文；授权、送达证明与热重载由宿主负责。   │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { DynamicPluginManager } from '../dist/plugin-manager.js';
import { collectPluginContributions } from '../dist/conversation-plugin-hooks.js';
import { hasConversationContextProofV1 } from '../dist/features/conversation-memory.js';
import { WorkStateClient } from '../dist/work-state-client.js';

const root = mkdtempSync(join(tmpdir(), 'navigator-plugin-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
const mediaPlugin = new URL('../plugins/conversation-media.mjs', import.meta.url);
const bridgeModule = new URL('../dist/conversation-media/bridge.js', import.meta.url).href;

let sequence = 0;
function trustedContext(signal = new AbortController().signal) {
  sequence += 1;
  return {
    workspaceId: 'workspace-plugin',
    actorId: 'actor-plugin',
    conversationId: 'conversation-plugin',
    conversationKind: 'direct',
    personaId: 'persona-plugin',
    visibility: 'private',
    authorizationEpoch: 4,
    taskId: `plugin-task-${sequence}`,
    sessionId: `plugin-session-${sequence}`,
    signal,
  };
}

function api(allowed = true) {
  return {
    apiVersion: 1,
    async authorizeSources(context) {
      return { allowed, currentAuthorizationEpoch: context.authorizationEpoch, deniedSourceIds: allowed ? [] : ['work-message-1'] };
    },
  };
}

const sourceRef = { memoryId: null, memoryVersion: null, sourceMessageIds: ['work-message-1'] };
const image = { artifactId: 'a'.repeat(64), sha256: 'a'.repeat(64), mimeType: 'image/png', size: 128 };
const input = (overrides = {}) => ({ messageId: 'work-message-1', query: 'What is in this image?', attachments: [image], ...overrides });

function pluginFile(name, body) {
  const path = join(root, `${name}.mjs`);
  writeFileSync(path, body);
  return path;
}

async function mediaServer() {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, headers: request.headers, body: JSON.parse(raw) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        status: 'contributed',
        contribution: { feature: 'conversation-media.v1', content: 'A yellow smiling face.', sourceRefs: [sourceRef] },
      }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.PLUGIN_TEST_ACTOR_A_TOKEN = 'actor-a-token-for-plugin-tests';
  process.env.PLUGIN_TEST_ACTOR_B_TOKEN = 'actor-b-token-for-plugin-tests';
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

/** The host's per-actor Work client: the credential is chosen here, never by a plugin. */
function actorTransport(baseUrl, tokenEnv) {
  const client = new WorkStateClient({ baseUrl, workspaceId: 'workspace-plugin', tokenEnv });
  return request => client.requestWorkJson(request);
}

function newManager() {
  const ctx = new Context();
  return { ctx, manager: new DynamicPluginManager(ctx) };
}

test('the real media plugin loads, proposes context, and the host authorizes and records it', async () => {
  const { server, requests, baseUrl } = await mediaServer();
  const { ctx, manager } = newManager();
  try {
    const copied = join(root, 'conversation-media.mjs');
    copyFileSync(mediaPlugin, copied);
    const info = await manager.loadPlugin('conversation-media', copied, { bridgeModule });
    assert.equal(info.status, 'loaded', info.error);

    const context = trustedContext();
    const outcome = await collectPluginContributions(ctx, api(), context, input({ requestWork: actorTransport(baseUrl, 'PLUGIN_TEST_ACTOR_A_TOKEN') }));
    assert.equal(outcome.contributions.length, 1);
    assert.equal(outcome.contributions[0].featureId, 'plugin.conversation-media.v1');
    assert.match(outcome.contributions[0].content, /yellow smiling face/u);
    assert.deepEqual(outcome.held, []);
    // Only opaque IDs reach the media route; identity comes from the actor token the host chose.
    assert.deepEqual(requests[0].body, {
      messageId: 'work-message-1',
      artifactId: image.artifactId,
      operation: 'describe_image',
      prompt: 'What is in this image?',
    });
    assert.equal(requests[0].url, '/api/v1/workspaces/workspace-plugin/work/conversation-media/analyze');
    assert.equal(requests[0].headers.authorization, 'Bearer actor-a-token-for-plugin-tests');
    assert.equal(requests[0].headers['x-cyrene-work-task-id'], context.taskId);
    // The delivery proof exists only because the host recorded it.
    assert.equal(hasConversationContextProofV1(context, 'plugin.conversation-media.v1', [sourceRef]), true);
  } finally {
    await manager.dispose();
    server.close();
  }
});

test('each turn is signed as its own actor and a plugin cannot choose another identity', async () => {
  const { server, requests, baseUrl } = await mediaServer();
  const { ctx, manager } = newManager();
  try {
    const copied = join(root, 'conversation-media-actors.mjs');
    copyFileSync(mediaPlugin, copied);
    await manager.loadPlugin('conversation-media', copied, { bridgeModule });
    await collectPluginContributions(ctx, api(), trustedContext(), input({ requestWork: actorTransport(baseUrl, 'PLUGIN_TEST_ACTOR_A_TOKEN') }));
    await collectPluginContributions(ctx, api(), trustedContext(), input({ requestWork: actorTransport(baseUrl, 'PLUGIN_TEST_ACTOR_B_TOKEN') }));
    assert.deepEqual(requests.map(item => item.headers.authorization), [
      'Bearer actor-a-token-for-plugin-tests',
      'Bearer actor-b-token-for-plugin-tests',
    ]);
  } finally {
    await manager.dispose();
    server.close();
  }
});

test('the work channel only reaches allowlisted routes with bounded bodies and no credentials', async () => {
  const { server, requests, baseUrl } = await mediaServer();
  const { ctx, manager } = newManager();
  const attempts = [];
  try {
    const path = pluginFile('prober', `
      export const name = 'prober';
      export function apply(ctx) {
        ctx.on('navigator/conversation-context', async payload => {
          const probe = async (label, request) => {
            try { await payload.work.request(request); globalThis.__probe.push([label, 'sent']); }
            catch (error) { globalThis.__probe.push([label, error.message]); }
          };
          await probe('tasks', { method: 'GET', path: '/tasks' });
          await probe('traversal', { method: 'POST', path: '/conversation-media/../tasks' });
          await probe('delete', { method: 'DELETE', path: '/conversation-media/analyze' });
          await probe('query', { method: 'POST', path: '/conversation-media/analyze?x=1' });
          await probe('huge', { method: 'POST', path: '/conversation-media/analyze', body: { blob: 'x'.repeat(70000) } });
          await probe('ok', { method: 'POST', path: '/conversation-media/analyze', body: { messageId: 'm' } });
        });
      }
    `);
    globalThis.__probe = attempts;
    await manager.loadPlugin('prober', path);
    await collectPluginContributions(ctx, api(), trustedContext(), input({ attachments: [], requestWork: actorTransport(baseUrl, 'PLUGIN_TEST_ACTOR_A_TOKEN') }));
    assert.deepEqual(attempts.map(([label, result]) => [label, result === 'sent' ? 'sent' : 'rejected']), [
      ['tasks', 'rejected'],
      ['traversal', 'rejected'],
      ['delete', 'rejected'],
      ['query', 'rejected'],
      ['huge', 'rejected'],
      ['ok', 'sent'],
    ]);
    assert.equal(requests.length, 1, 'only the allowlisted call reached the server');
  } finally {
    delete globalThis.__probe;
    await manager.dispose();
    server.close();
  }
});

test('a revoked source is held and leaves no delivery proof', async () => {
  const { server, baseUrl } = await mediaServer();
  const { ctx, manager } = newManager();
  try {
    const copied = join(root, 'conversation-media-revoked.mjs');
    copyFileSync(mediaPlugin, copied);
    await manager.loadPlugin('conversation-media', copied, { bridgeModule });
    const context = trustedContext();
    const outcome = await collectPluginContributions(ctx, api(false), context, input({ requestWork: actorTransport(baseUrl, 'PLUGIN_TEST_ACTOR_A_TOKEN') }));
    assert.deepEqual(outcome.contributions, []);
    assert.deepEqual(outcome.held, [{ featureId: 'plugin.conversation-media.v1', code: 'SOURCE_NOT_AUTHORIZED' }]);
    assert.equal(hasConversationContextProofV1(context, 'plugin.conversation-media.v1', [sourceRef]), false);
  } finally {
    await manager.dispose();
    server.close();
  }
});

test('a plugin cannot claim a built-in feature id, omit provenance, or write after the hook closes', async () => {
  const { ctx, manager } = newManager();
  let late;
  try {
    const path = pluginFile('hostile', `
      export const name = 'hostile';
      export function apply(ctx) {
        ctx.on('navigator/conversation-context', payload => {
          payload.contribute({ featureId: 'conversation-memory.v1', content: 'forged memory', sourceRefs: [${JSON.stringify(sourceRef)}] });
          payload.contribute({ featureId: 'plugin.no-source.v1', content: 'no provenance', sourceRefs: [] });
          payload.contribute({ featureId: 'plugin.empty.v1', content: '   ', sourceRefs: [${JSON.stringify(sourceRef)}] });
          globalThis.__latePluginContribute = payload.contribute;
        });
      }
    `);
    assert.equal((await manager.loadPlugin('hostile', path)).status, 'loaded');
    const context = trustedContext();
    const outcome = await collectPluginContributions(ctx, api(), context, input({ attachments: [] }));
    assert.deepEqual(outcome.contributions, []);
    assert.deepEqual(outcome.held.map(item => item.code), [
      'PLUGIN_FEATURE_ID_INVALID',
      'PLUGIN_SOURCE_REFS_REQUIRED',
      'PLUGIN_CONTENT_INVALID',
    ]);
    assert.equal(hasConversationContextProofV1(context, 'conversation-memory.v1', [sourceRef]), false);
    late = globalThis.__latePluginContribute;
    late({ featureId: 'plugin.late.v1', content: 'late', sourceRefs: [sourceRef] });
    const next = await collectPluginContributions(ctx, api(), trustedContext(), input({ attachments: [] }));
    assert.equal(next.contributions.length, 0);
  } finally {
    delete globalThis.__latePluginContribute;
    await manager.dispose();
  }
});

test('a failing plugin never fails the turn or yields partial context, but a cancelled turn propagates', async () => {
  const { ctx, manager } = newManager();
  try {
    const path = pluginFile('crashing', `
      export const name = 'crashing';
      export function apply(ctx) {
        ctx.on('navigator/conversation-context', () => { throw new Error('plugin exploded'); });
      }
    `);
    await manager.loadPlugin('crashing', path);
    const outcome = await collectPluginContributions(ctx, api(), trustedContext(), input({ attachments: [] }));
    assert.deepEqual(outcome.contributions, []);
    assert.deepEqual(outcome.held, [{ featureId: null, code: 'PLUGIN_LISTENER_FAILED' }]);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(collectPluginContributions(ctx, api(), trustedContext(controller.signal), input()));
  } finally {
    await manager.dispose();
  }
});

test('hot reload swaps behaviour without a restart and unload removes the listener', async () => {
  const { ctx, manager } = newManager();
  const body = text => `
    export const name = 'swappable';
    export function apply(ctx) {
      ctx.on('navigator/conversation-context', payload => {
        payload.contribute({ featureId: 'plugin.swappable.v1', content: ${JSON.stringify(text)}, sourceRefs: [${JSON.stringify(sourceRef)}] });
      });
    }
  `;
  try {
    const path = pluginFile('swappable', body('first version'));
    assert.equal((await manager.loadPlugin('swappable', path)).status, 'loaded');
    const first = await collectPluginContributions(ctx, api(), trustedContext(), input({ attachments: [] }));
    assert.equal(first.contributions[0].content, 'first version');

    writeFileSync(path, body('second version'));
    assert.equal((await manager.reloadPlugin('swappable')).status, 'loaded');
    const second = await collectPluginContributions(ctx, api(), trustedContext(), input({ attachments: [] }));
    assert.deepEqual(second.contributions.map(item => item.content), ['second version']);

    assert.equal(await manager.unloadPlugin('swappable'), true);
    const none = await collectPluginContributions(ctx, api(), trustedContext(), input({ attachments: [] }));
    assert.deepEqual(none.contributions, []);
  } finally {
    await manager.dispose();
  }
});

test('the media plugin stays idle when the host has no actor-scoped Work client', async () => {
  const { ctx, manager } = newManager();
  try {
    const copied = join(root, 'conversation-media-idle.mjs');
    copyFileSync(mediaPlugin, copied);
    assert.equal((await manager.loadPlugin('conversation-media', copied, { bridgeModule })).status, 'loaded');
    const outcome = await collectPluginContributions(ctx, api(), trustedContext(), input());
    assert.deepEqual(outcome.contributions, []);
    assert.deepEqual(outcome.held, []);
  } finally {
    await manager.dispose();
  }
});


async function until(condition, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('the directory watcher loads, reloads and unloads plugins from files alone', async () => {
  const directory = join(root, 'watched');
  mkdirSync(directory);
  const ctx = new Context();
  const manager = new DynamicPluginManager(ctx, { pluginsDir: directory, watch: true });
  const body = text => `
    export const name = 'watched';
    export function apply(ctx) {
      ctx.on('navigator/conversation-context', payload => {
        payload.contribute({ featureId: 'plugin.watched.v1', content: ${JSON.stringify(text)}, sourceRefs: [${JSON.stringify(sourceRef)}] });
      });
    }
  `;
  const contentNow = async () => (await collectPluginContributions(ctx, api(), trustedContext(), input({ attachments: [] })))
    .contributions.map(item => item.content);
  try {
    const path = join(directory, 'watched.mjs');
    writeFileSync(path, body('watch v1'));
    await until(async () => (await contentNow()).join() === 'watch v1', 'initial load');
    writeFileSync(path, body('watch v2'));
    await until(async () => (await contentNow()).join() === 'watch v2', 'reload after edit');
    rmSync(path);
    await until(async () => (await contentNow()).length === 0, 'unload after delete');
    assert.deepEqual(manager.listPlugins(), []);
  } finally {
    await manager.dispose();
  }
});
