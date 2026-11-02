// ┌─────────────────────────────────────────────────────────────────────┐
// │ Plugin: conversation-media (Navigator dynamic Cordis plugin)         │
// │ Role: Turn message attachments into proposed conversation context.   │
// │                                                                      │
// │ 模块职责：把消息附件交给 Navigator 媒体路由，并"提议"上下文贡献。      │
// │ · 请求通过宿主提供的通道，以当前回合用户的身份发出；插件不接触凭据。   │
// │ · 来源授权与送达证明由宿主在接受提议时完成。                          │
// └─────────────────────────────────────────────────────────────────────┘
//
// Copy or symlink this file into the executor's plugins directory. It needs the
// compiled harness only for the strict response decoder; override its location with
// `bridgeModule` (a file URL) in the plugin config or CYRENE_NAVIGATOR_HARNESS_DIST
// (the harness `dist` folder). No credential or URL is configured here: the host
// signs every request with the turn's own actor token.

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

export async function apply(ctx, config) {
  const { decodeAnalysisResponse } = await loadBridgeModule(config);

  ctx.on('navigator/conversation-context', async payload => {
    // Without an actor-scoped Work client (for example test mode) there is nothing to call.
    if (payload.work === undefined) return;
    const supported = payload.attachments
      .filter(item => IMAGE_MIMES.has(item.mimeType) || AUDIO_MIMES.has(item.mimeType))
      .slice(0, MAX_ATTACHMENTS);
    if (supported.length === 0) return;

    const parts = [];
    const refs = new Map();
    for (const attachment of supported) {
      payload.signal.throwIfAborted();
      const operation = AUDIO_MIMES.has(attachment.mimeType) ? 'transcribe' : 'describe_image';
      let response;
      try {
        response = decodeAnalysisResponse(await payload.work.request({
          method: 'POST',
          path: '/conversation-media/analyze',
          body: {
            messageId: payload.messageId,
            artifactId: attachment.artifactId,
            operation,
            ...(operation === 'describe_image' && payload.query.trim() ? { prompt: payload.query.trim().slice(0, 1_024) } : {}),
          },
        }));
      } catch (error) {
        if (payload.signal.aborted) throw error;
        ctx.logger('conversation-media').warn(`attachment skipped: ${error instanceof Error ? error.name : 'error'}`);
        continue;
      }
      if (response.status !== 'contributed') continue;
      parts.push(response.contribution.content);
      for (const ref of response.contribution.sourceRefs) refs.set(JSON.stringify(ref), ref);
    }
    if (parts.length === 0) return;
    payload.contribute({ featureId: FEATURE_ID, content: parts.join('\n'), sourceRefs: [...refs.values()] });
  });
}

export default { name, apply };
