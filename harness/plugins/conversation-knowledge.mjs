// ┌─────────────────────────────────────────────────────────────────────┐
// │ Plugin: conversation-knowledge (Navigator dynamic Cordis plugin)     │
// │ Role: Put the operator-selected Catalyst knowledge package in context.│
// │                                                                      │
// │ 模块职责：用当前用户的已选知识包检索，并把带引用的结果"提议"为上下文。 │
// │ · 请求以当前回合用户的身份发出；插件不接触凭据。                      │
// │ · 来源是否仍被授权由宿主复核：接受提议时一次，发送前再一次。          │
// └─────────────────────────────────────────────────────────────────────┘
//
// Copy or symlink this file into the executor's plugins directory. The Navigator
// persistence process must have CYRENE_NAVIGATOR_KNOWLEDGE_CONFIG set, otherwise the
// knowledge routes do not exist and this plugin simply adds nothing. It needs the
// compiled harness only for strict decoders; override their location with `bridgeModule`
// (a file URL) in the plugin config or CYRENE_NAVIGATOR_HARNESS_DIST (the harness `dist`).

import { pathToFileURL } from 'node:url';

export const name = 'conversation-knowledge';

const FEATURE_ID = 'plugin.conversation-knowledge.v1';
const PROOF_KIND = 'catalyst-knowledge.v1';
const MAX_CONTENT_BYTES = 24_000;

async function loadBridgeModule(config) {
  const override = config?.bridgeModule
    ?? (process.env.CYRENE_NAVIGATOR_HARNESS_DIST
      ? pathToFileURL(`${process.env.CYRENE_NAVIGATOR_HARNESS_DIST}/conversation-knowledge/bridge.js`).href
      : undefined);
  return import(override ?? new URL('../dist/conversation-knowledge/bridge.js', import.meta.url).href);
}

function render(page) {
  const lines = [`Knowledge from "${page.datasetName}" (version ${page.datasetVersion}):`];
  let bytes = new TextEncoder().encode(lines[0]).byteLength;
  let included = 0;
  page.hits.forEach((hit, index) => {
    const where = hit.citation.hierarchyPath.length > 0 ? ` (${hit.citation.hierarchyPath.join(' > ')})` : '';
    const line = `[${index + 1}]${where} ${hit.text}`;
    bytes += new TextEncoder().encode(line).byteLength + 1;
    if (bytes > MAX_CONTENT_BYTES) return;
    lines.push(line);
    included += 1;
  });
  return included === 0 ? undefined : lines.join('\n');
}

export async function apply(ctx, config) {
  const { decodeSearch, authorizationBodyFromPage } = await loadBridgeModule(config);
  const limit = Math.min(20, Math.max(1, Number.isSafeInteger(config?.limit) ? config.limit : 5));

  ctx.on('navigator/conversation-context', async payload => {
    // Without an actor-scoped Work client (for example test mode) there is nothing to call.
    if (payload.work === undefined || payload.query.trim().length === 0) return;
    let page;
    try {
      page = decodeSearch(await payload.work.request({
        method: 'POST',
        path: '/knowledge/search',
        body: { query: payload.query, limit },
      }), payload.query, limit, undefined);
    } catch (error) {
      if (payload.signal.aborted) throw error;
      // Not selected, stale, revoked, or unavailable: this turn simply gets no knowledge.
      ctx.logger('conversation-knowledge').warn(`knowledge skipped: ${error instanceof Error ? error.name : 'error'}`);
      return;
    }
    const content = render(page);
    if (content === undefined) return;
    payload.contribute({
      featureId: FEATURE_ID,
      content,
      sourceRefs: [],
      externalProof: { kind: PROOF_KIND, evidence: authorizationBodyFromPage(page) },
    });
  });
}

export default { name, apply };
