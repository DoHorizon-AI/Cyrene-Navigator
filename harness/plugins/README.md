# Navigator dynamic plugins (first-party)

Source for plugins that the executor loads from its plugins directory
(`--plugins-dir`, default `<repo>/plugins`). Copy or symlink a file there; the
`DynamicPluginManager` loads it, reloads it on edit and unloads it on delete.

| File | Responsibility |
|---|---|
| `conversation-media.mjs` | Sends a message's image/audio attachments to the Navigator media route and proposes the result as conversation context. |

## Conversation context hook

The executor emits `navigator/conversation-context` once per conversation turn
(`harness/src/conversation-plugin-hooks.ts`). A listener receives read-only turn
facts (scope, `signal`, `messageId`, `query`, `attachments`) and may call
`payload.contribute({ featureId, content, sourceRefs })`.

A plugin only proposes. The host:

- rejects feature IDs outside `plugin.<name>.v<N>`, so a plugin cannot claim or overwrite a built-in feature's delivery proof;
- requires non-empty `sourceRefs`, bounded content, and at most 8 proposals per turn;
- authorizes every proposal's sources against the current Work authorization epoch, and drops it when denied;
- records the delivery proof itself, and the final delivery check covers the plugin's sources like any other;
- treats a throwing listener as "no contribution", never as a failed turn; only a cancelled turn propagates.

## Trust model

Dynamic plugins run in the executor process and can read its environment. Load only
reviewed first-party files from a directory the executor owner controls. The hook
hands plugins no token and no Work API object; a plugin that needs the Work API
builds its own connection from configuration, as `conversation-media.mjs` does.

## Configuration

`conversation-media.mjs` takes `connection` (`baseUrl`, `workspaceId`, `tokenEnv`)
from the plugin config, or `CYRENE_PLUGIN_MEDIA_WORK_BASE_URL` and
`CYRENE_PLUGIN_MEDIA_WORKSPACE_ID` from the environment when the directory loader
(which passes no config) loads it. It finds the compiled bridge through
`bridgeModule` or `CYRENE_NAVIGATOR_HARNESS_DIST`. Without a connection it stays idle.

中文：插件只能"提议"上下文；宿主负责来源授权、送达证明和最终发送前复核。插件与执行器同进程，只加载经审核的第一方文件。
