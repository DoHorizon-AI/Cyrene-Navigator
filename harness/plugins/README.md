# Navigator dynamic plugins (first-party)

Source for plugins that the executor loads from its plugins directory
(`--plugins-dir`, default `<repo>/plugins`). Copy or symlink a file there; the
`DynamicPluginManager` loads it, reloads it on edit and unloads it on delete.

| File | Responsibility |
|---|---|
| `conversation-media.mjs` | Sends a message's image/audio attachments to the Navigator media route and proposes the result as conversation context. |
| `conversation-knowledge.mjs` | Searches the operator-selected Catalyst knowledge package for the user's message and proposes the cited result as context. |

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

## External-source proofs

A proposal whose provenance is not a Work message (a Catalyst knowledge page) carries
`externalProof: { kind, evidence }` instead of `sourceRefs`. The host owns the verifier
for each `kind` (`ConversationExternalProofVerifier`, registered in `serve.ts`):

- it runs when the proposal is accepted, using the turn's actor-scoped Work client, and again immediately before delivery, so a source revoked or made stale while the model was answering holds the reply with a typed code;
- an unregistered kind, malformed evidence, a verifier that throws, or a missing Work client is a hold, never an allow.

The knowledge verifier asks the Work server to recheck the selected DatasetVersion and
every cited block for the same actor. That proves the cited sources are currently
authorized, not that a plugin's text equals those blocks; plugins stay reviewed
first-party code, and the server already rechecks sources after ranking.

## Trust model

Dynamic plugins run in the executor process and can read its environment. Load only
reviewed first-party files from a directory the executor owner controls.

The hook gives plugins no token, no base URL and no Work API object. When the host
has an actor-scoped Work client it adds `payload.work.request({ method, path, body })`:

- the request is signed with the **turn's own actor token**, so two users' turns never share an identity;
- only `GET`/`POST` to `/conversation-media/<action>` and `/knowledge/<action>` are accepted, with no query string, no `..`, a 64 KB request cap, a 1 MB response cap and 32 calls per turn;
- the host adds the task header itself, and a plugin cannot set headers or choose another credential;
- `payload.work` is absent when there is no such client (for example test mode), and a plugin must then stay idle.

## Configuration

Neither plugin needs connection settings. `conversation-knowledge.mjs` also takes an
optional `limit` (1 to 20, default 5) and only does anything when the persistence
process has `CYRENE_NAVIGATOR_KNOWLEDGE_CONFIG` set. `conversation-media.mjs` They import the compiled
strict response decoders through `bridgeModule` (a file URL in the plugin config) or
`CYRENE_NAVIGATOR_HARNESS_DIST` (the harness `dist` folder).

中文：插件只能"提议"上下文；宿主负责来源授权、送达证明和最终发送前复核。插件与执行器同进程，只加载经审核的第一方文件。
