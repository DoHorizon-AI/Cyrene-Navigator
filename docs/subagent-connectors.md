# Native subagent connectors / 原生子 Agent 连接器

Navigator registers Antigravity and CodeBuddy as out-of-process providers on
the pinned DSH `ctx.subagents` seam. DSH's delegation tool is registered once
per provider as `subagent_antigravity` or `subagent_codebuddy`. These adapters do not create another agent loop,
an Exchange `LlmAdapter`, or a second session-history store.

Navigator 将 Antigravity 与 CodeBuddy 注册为固定 DSH `ctx.subagents` seam 上的进程外提供方。
模型侧使用按提供方注册的 DSH 委派工具 `subagent_antigravity` 或 `subagent_codebuddy`。
适配器不会创建另一套 Agent loop、Exchange `LlmAdapter`
或会话历史存储。

## Registration / 注册

The public entry point is `registerSubagents(ctx, config)` from
`harness/src/subagents/index.ts`. It returns an async disposer that unregisters
the providers and reaps any active child processes.

公开入口是 `harness/src/subagents/index.ts` 中的 `registerSubagents(ctx, config)`。它返回一个
异步 disposer，用于取消注册并回收仍在运行的子进程。

```ts
registerSubagents(ctx, {
  deployments: [
    { backend: 'antigravity', command: 'agy', cwd: '/srv/workspaces/project' },
    { backend: 'codebuddy', command: 'codebuddy', cwd: '/srv/workspaces/project' },
  ],
  onEvent: event => forwardSubagentEvent(event),
  requestPermission: request => navigatorApprovals.requestOnce(request),
})
```

Provider names default to `antigravity` and `codebuddy`; `providerName` can
select a different registry name. Navigator configures DSH's
`@deepseek-ai/dsh-tool-subagent` with that provider and a unique
`subagent_<providerName>` tool name. This preserves routing when both are enabled.

提供方注册名默认为 `antigravity` 与 `codebuddy`；`providerName` 可指定其他注册名。将 DSH
`@deepseek-ai/dsh-tool-subagent` 配置为使用对应 provider 名称，以及独立的
`subagent_<providerName>` 工具名，使两个提供方同时启用时仍能正确路由。

`command` and `argv` stay separate and are passed through DSH's subprocess
service without a shell. Only native model/agent selectors are accepted in
`argv`; connector transport, sandbox, and permission flags are owned by the
adapter. `cwd` must resolve to an accessible directory. If omitted, each child
uses the delegating DSH session's workspace. `envRefs` selects non-credential
host environment values by variable name; values never enter logs or a model
prompt. Credential-like environment references are rejected. Native CLI
authentication remains in its own host profile/keychain; Navigator does not
extract, proxy, or persist native credentials.

`command` 与 `argv` 分开传递，并经由 DSH subprocess 服务启动，不经过 shell。`argv` 只接受原生
model/agent 选择参数；传输、sandbox 与权限参数由适配器控制。`cwd` 必须是可访问目录；省略时使用
委派方 DSH Session 的 workspace。`envRefs` 只按变量名选取非凭据类宿主环境值，值不会写入日志或模型
提示。类凭据环境引用会被拒绝。原生 CLI 认证保留在其宿主配置或密钥链中；Navigator 不提取、代理或
保存原生凭据。

Both providers advertise all five DSH start capabilities as unsupported:
`agentOptions`, `outputSchema`, `depthLimit`, `toolFilter`, and `persona`.
Requests for those options fail at the DSH service boundary rather than being
silently ignored. Provider progress, assistant deltas, and permission events
include `parentSessionId` so the host can associate them with the active
Navigator task.

两个提供方都将 DSH 的五种启动能力标为不支持：`agentOptions`、`outputSchema`、`depthLimit`、
`toolFilter` 与 `persona`。DSH service 会在边界拒绝这些请求，不会静默忽略。进度、助手增量与权限事件
包含 `parentSessionId`，宿主可据此关联活动 Navigator task。

## Native protocol and safety / 原生协议与安全

Antigravity uses the documented stream-json stdin/stdout session. The adapter
starts `agy` with `--input-format stream-json --output-format stream-json
--sandbox --mode default`, sends one text-only `user` event, and consumes the
`init`, `step_update`, and terminal `result` events. It rejects startup unless
the CLI reports a conversation id and the documented `request-review`
permission mode. It rejects other or unknown modes and never sends
`--dangerously-skip-permissions`. The CLI's headless policy handles Ask actions
it cannot present interactively; the adapter has no native permission callback
for Antigravity. Conversation IDs are associated with the parent DSH session
and passed back with the documented `--conversation` flag on the next turn.

Antigravity 使用文档化的 stream-json stdin/stdout 会话。适配器以
`--input-format stream-json --output-format stream-json --sandbox --mode default` 启动 `agy`，
发送一个纯文本 `user` 事件，并消费 `init`、`step_update` 与终结 `result` 事件。除非 CLI 返回
conversation id 和文档化的 `request-review` 权限模式，否则拒绝启动其他或未知模式。不会发送
`--dangerously-skip-permissions`。CLI 会按 headless
策略处理无法交互展示的 Ask 操作；Antigravity 当前协议没有可桥接的宿主权限回调。Conversation ID 与父级
DSH Session 关联，并在后续任务中通过文档化的 `--conversation` 参数恢复。

CodeBuddy uses the documented ACP-over-stdio transport with the native
`default` permission mode. The adapter performs `initialize`, creates an ACP
session, and runs one `session/prompt`. It only calls `session/load` when the
server advertises `agentCapabilities.loadSession`. ACP permission requests are
sent to `requestPermission`; absent, timed-out, failed, or explicit-deny
callbacks return ACP's cancelled outcome. The only approval the adapter can
send is the native `allow_once` option, and only after the host callback
returns `allow-once`; it never selects persistent approval. Without a host
approval service, write requests are denied.

CodeBuddy 使用文档化的 ACP-over-stdio 传输与原生 `default` 权限模式。适配器执行
`initialize`、创建 ACP session，并发送一次 `session/prompt`。只有服务端声明
`agentCapabilities.loadSession` 时才调用 `session/load`。ACP 权限请求交给 `requestPermission`；
回调缺失、超时、失败或明确拒绝时，均返回 ACP cancelled 结果。适配器只可能在宿主回调返回
`allow-once` 后选择原生 `allow_once` 选项，不会选择永久授权。没有宿主审批服务时，写入请求会被拒绝。

Every child uses DSH's managed subprocess lifetime and cancellation path.
Frames are strict UTF-8 NDJSON objects with a 1 MiB per-frame limit, a 16 MiB
per-turn stream limit, and a 100,000-frame limit. Retained assistant output is
limited to 2 MiB. Teardown closes stdin, waits for the configured grace, then
terminates and waits for the managed process range.

每个子进程都使用 DSH 管理的 subprocess 生命周期与取消路径。协议帧必须是严格 UTF-8 的 NDJSON 对象；
单帧上限为 1 MiB、单轮流上限为 16 MiB、最多 100,000 帧。保留的助手输出上限为 2 MiB。销毁时先关闭
stdin 并等待配置的宽限期，再终止并等待受管进程范围退出。

## Validation / 验证

`harness/tests/subagents.test.mjs` uses an executable local fixture that speaks
the two official protocol shapes. It covers normal completion, native error,
cancellation and child reaping, malformed and oversized streams, ACP approval
rejection, event/task association, and native conversation resumption. The
fixtures do not authenticate to either service. Live Antigravity and CodeBuddy
authentication was not run.

`harness/tests/subagents.test.mjs` 使用本地可执行 fixture 模拟两种官方协议，覆盖正常完成、原生错误、
取消与子进程回收、畸形和超限数据流、ACP 审批拒绝、事件与 task 关联，以及原生会话恢复。Fixture 不会
对任一服务进行认证；本次未运行真实 Antigravity 或 CodeBuddy 认证。

Protocol references / 协议资料：

- [Antigravity CLI headless and stream-json](https://antigravity.google/docs/cli/headless)
- [Antigravity CLI execution modes](https://antigravity.google/docs/cli/modes/)
- [Antigravity permissions](https://antigravity.google/docs/permissions?tab=cli)
- [CodeBuddy ACP](https://www.codebuddy.ai/docs/cli/acp)
- [CodeBuddy CLI reference](https://www.codebuddy.ai/docs/cli/cli-reference)
