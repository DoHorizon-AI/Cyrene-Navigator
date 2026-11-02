// ┌─────────────────────────────────────────────────────────────────────┐
// │ Plugin: conversation-media (Navigator dynamic Cordis plugin)         │
// │ Role: Turn message attachments into proposed conversation context.   │
// │                                                                      │
// │ 模块职责：把消息附件交给 Navigator 媒体路由，并"提议"上下文贡献。      │
// │ · 插件不持有授权：来源授权与送达证明由宿主在接受提议时完成。          │
// └─────────────────────────────────────────────────────────────────────┘
//
// Copy or symlink this file into the executor's plugins directory. It needs the
// compiled harness bridge; override its location with `bridgeModule` (a file URL)
// in the plugin config or CYRENE_NAVIGATOR_HARNESS_DIST (the harness `dist` folder).
// Work connection: plugin config `connection`, else
// CYRENE_PLUGIN_MEDIA_WORK_BASE_URL / CYRENE_PLUGIN_MEDIA_WORKSPACE_ID (token comes
// from the environment variable named by `tokenEnv`, default CYRENE_SESSION_TOKEN).

import { pathToFileURL } from 'node:url';

export const name = 'conversation-media';

const FEATURE_ID = 'plugin.conversation-media.v1';
const MAX_ATTACHMENTS = 8;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm']);

async function loadBridgeModule(config) {
  const override = config?.bridgeModule
    ?? (process.env.CYRENE_NAVIGATOR_HARNESS_DIST
      ? pathToFileURL(`${process.env.CYRENE_NAVIGATOR_HARNESS_DIST}/conversation-media/bridge.js`).href
      : undefined);
  return import(override ?? new URL('../dist/conversation-media/bridge.js', import.meta.url).href);
}

function connectionFrom(config) {
  if (config?.connection) return config.connection;
  const baseUrl = process.env.CYRENE_PLUGIN_MEDIA_WORK_BASE_URL;
  const workspaceId = process.env.CYRENE_PLUGIN_MEDIA_WORKSPACE_ID;
  if (!baseUrl || !workspaceId) return undefined;
  return { baseUrl, workspaceId, ...(config?.tokenEnv ? { tokenEnv: config.tokenEnv } : {}) };
}

export async function apply(ctx, config) {
  const connection = connectionFrom(config);
  if (connection === undefined) {
    ctx.logger('conversation-media').warn('no Work connection configured; the plugin stays idle');
    return;
  }
  const bridgeModule = config?.bridge ? undefined : await loadBridgeModule(config);
  const bridge = config?.bridge ?? new bridgeModule.NavigatorConversationMediaHttpBridge(connection);

  ctx.on('navigator/conversation-context', async payload => {
    const supported = payload.attachments
      .filter(item => IMAGE_MIMES.has(item.mimeType) || AUDIO_MIMES.has(item.mimeType))
      .slice(0, MAX_ATTACHMENTS);
    if (supported.length === 0) return;

    const parts = [];
    const refs = new Map();
    for (const attachment of supported) {
      payload.signal.throwIfAborted();
      const operation = AUDIO_MIMES.has(attachment.mimeType) ? 'transcribe' : 'describe_image';
      const response = await bridge.analyze({
        messageId: payload.messageId,
        artifact: { ...attachment, name: 'attachment' },
        operation,
        ...(operation === 'describe_image' && payload.query.trim() ? { prompt: payload.query.trim().slice(0, 1_024) } : {}),
      }, { taskId: payload.scope.taskId, signal: payload.signal });
      if (response.status !== 'contributed') continue;
      parts.push(response.contribution.content);
      for (const ref of response.contribution.sourceRefs) refs.set(JSON.stringify(ref), ref);
    }
    if (parts.length === 0) return;
    payload.contribute({ featureId: FEATURE_ID, content: parts.join('\n'), sourceRefs: [...refs.values()] });
  });
}

export default { name, apply };
