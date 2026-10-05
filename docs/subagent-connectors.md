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

Antigravity uses documented stream-json stdin/stdout, with adapter-owned
`--sandbox --mode accept-edits` flags. Its default policy is full permitted
execution inside the native terminal sandbox. Before each child starts,
Navigator reads the official host profile and requires sandbox enabled,
`toolPermission: "proceed-in-sandbox"`, workspace-only file access, automatic
workspace edits, empty remembered allow/ask lists, and deny rules for
`unsandboxed(*)` and `mcp(*)`. The workspace cannot contain that profile.
The init handshake must also advertise `proceed-in-sandbox`; other values are
refused before sending a model prompt. No dangerous permission flag or host
fallback is used. Conversation IDs remain scoped to the parent DSH session.

The native terminal sandbox also mounts temporary directories and common build
caches as writable. An outside-workspace path inside those mounts is not an
outside-sandbox path. Boundary smoke tests must use private canaries outside
both the workspace and those default writable mounts.

Antigravity 使用文档化的 stream-json stdin/stdout，并由适配器控制
`--sandbox --mode accept-edits` 参数。默认策略是在原生终端沙箱允许范围内自动执行。
每次启动前，Navigator 都校验官方宿主配置：启用沙箱、
`toolPermission: "proceed-in-sandbox"`、仅访问 workspace、自动处理 workspace 编辑、
清空旧的 allow/ask 授权，并拒绝 `unsandboxed(*)` 与 `mcp(*)`。
Workspace 不得包含该配置文件。握手还必须声明 `proceed-in-sandbox`，否则在发送模型提示前拒绝。
不会传入跳过权限参数或改到宿主执行。Conversation ID 仍按父级 DSH Session 隔离。

原生终端沙箱还允许写入临时目录和常用构建缓存；这些目录中的 workspace 外路径仍可能位于沙箱
允许范围内。边界烟测必须使用同时位于 workspace 与这些默认可写挂载之外的私有测试文件。

The CLI currently documents its global settings file and does not document a
per-invocation settings override. Prepare the profile explicitly on each
execution host (this affects other CLI uses under the same OS account):

CLI 目前文档化的入口是全局配置文件，没有文档化的单次调用 settings 覆盖参数。
请在各实际执行宿主上显式初始化；这会影响同一系统账号下的其他 CLI 使用：

```sh
# Preview changed field names; no existing values or credentials are printed.
node scripts/configure-antigravity-sandbox.mjs
# Apply documented defaults, retaining unrelated settings and a private backup.
node scripts/configure-antigravity-sandbox.mjs --apply
```

The setup command updates only security settings in
`~/.gemini/antigravity-cli/settings.json`, clears remembered permission grants,
and retains a private backup. It does not read credential files. Navigator
startup never rewrites the native profile. Cloud executions use that cloud
host's profile; local executions use the local host's profile.

初始化命令只更新 `~/.gemini/antigravity-cli/settings.json` 中的安全设置，清空旧的记忆授权，
并保留私有备份；不会读取认证文件。Navigator 启动不会重写原生配置。
云端执行使用云端宿主配置，本地执行使用本地宿主配置。

A native headless soft denial may still finish with `SUCCESS` and exit code 0.
The adapter classifies bounded structured error fields and stderr denial
notices, retains successful partial output, and lets the child finish its
remaining allowed work. The parent receives a failed subagent result with a
continue-and-summarize instruction. Navigator persists `subagent-blocked`
events, continues parent execution, and appends a trusted cannot-execute
summary to the final output. Only after remaining work finishes does an
incomplete batch become `failed`; a denial never automatically cancels it.
Explicit user cancellation and process/turn time limits still apply.

For admitted tasks with an existing notification route, terminal failure
notifications include the error and retained task output. Long notifications
retain both ends of that output so completed work and the final cannot-execute
summary remain visible. The existing recipient rules and deduplication apply.

原生 headless 软拒绝后仍可能返回 `SUCCESS` 与退出码 0。适配器检查有界结构化错误字段和 stderr
拒绝通知，保留已成功的部分输出，让子进程继续其余允许工作。父代理收到失败子任务结果，以及继续执行
并汇总的指引。Navigator 持久化 `subagent-blocked` 事件，继续父任务，最后在输出中追加可信的
“无法执行项”。有未完成项的整批任务只在其余工作结束后标为 `failed`，单项拒绝不会自动取消整批。
用户明确取消及进程/单轮超时仍然有效。

对于已有通知路由的任务，终态失败通知包含错误与保留的任务输出。超长通知保留输出首尾，
使已完成工作与最终“无法执行项”都能展示；沿用现有收件人规则及去重机制。

Receipts contain provider/run correlation, stable reason code, allowlisted tool
category, and observation count. Counts describe native notices, which may
repeat for one operation; they do not count distinct failed tasks. Raw stderr,
paths, prompts, or tokens are not copied into receipts. Semantic task names
and completed results are supplied by the agent's summary; run IDs allow
correlation with the task event history.

记录包含提供方/运行关联、固定原因码、允许的工具分类和观察次数。一次操作可能产生重复通知，
次数不等于不同失败任务数。记录不复制原始 stderr、路径、提示或 token。
具体任务名称和完成结果由代理总结提供；运行 ID 可关联任务事件历史。

CodeBuddy uses the documented ACP-over-stdio transport with the native
`default` permission mode. The adapter performs `initialize`, creates an ACP
session, and runs one `session/prompt`. It only calls `session/load` when the
server advertises `agentCapabilities.loadSession`. ACP permission requests are
sent to `requestPermission`; absent, timed-out, failed, or explicit-deny
callbacks select native `reject_once` when available, allowing independent
work to continue. Actual cancellation or a missing reject-once option returns
ACP's cancelled outcome. Tool execution progress reads ACP's flat update fields.
The only approval the adapter can
send is the native `allow_once` option, and only after the host callback
returns `allow-once`; it never selects persistent approval. Without a host
approval service, write requests are denied.

ACP `authMethods` advertises available login methods rather than the current
login state. Navigator attempts ordinary session creation or loading with the
native host's cached login. It never calls `authenticate` or copies credentials.
If the native server actually returns `auth_required`, the adapter reports an
explicit native-login failure and does not bypass it.

CodeBuddy 使用文档化的 ACP-over-stdio 传输与原生 `default` 权限模式。适配器执行
`initialize`、创建 ACP session，并发送一次 `session/prompt`。只有服务端声明
`agentCapabilities.loadSession` 时才调用 `session/load`。ACP 权限请求交给 `requestPermission`；
回调缺失、超时、失败或明确拒绝时，优先选择原生 `reject_once`，让其他独立工作继续。
实际取消或缺少本次拒绝选项时才返回 ACP cancelled。工具进度读取标准 ACP 的平铺更新字段。
适配器只可能在宿主回调返回
`allow-once` 后选择原生 `allow_once` 选项，不会选择永久授权。没有宿主审批服务时，写入请求会被拒绝。

ACP `authMethods` 声明可用登录方式，不代表当前未登录。Navigator 使用原生宿主的缓存登录，
尝试普通会话创建或加载；不会调用 `authenticate` 或复制凭据。原生服务真正返回
`auth_required` 时，适配器会明确报告原生登录不可用，不会绕过该错误。

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
fixtures do not authenticate to either service. The mixed-work vertical fixture also verifies denial followed by allowed
SQLite memory mutation, partial output reaching the parent, final blocked
summary, and durable event/task read-back after restart. Profile and boundary
fixtures run in the Linux x64, Linux ARM64, and Windows x64 CI suites.

On Linux x64 / WSL2, real `agy 1.2.17` and `CodeBuddy 2.158.0` native print
and Navigator provider calls returned the exact requested text without approval
requests. The CodeBuddy native ACP session succeeded with cached login despite
advertising authentication methods; no `authenticate` request was sent. These
checks exercised the real native programs and DSH managed subprocess, not the
HTTP, Client, or Exchange route. Antigravity workspace command execution also
ran successfully, but complete OS-boundary enforcement and denial-continuation
acceptance remain separate from the marker-only checks. Windows/ARM64
native-account execution remains **NOT_RUN**. Native profile preflight accepts
documented safe omitted defaults, and a different init mode is refused.

Opt-in real CLI validation uses the native subscription and only private test
files; it is never part of automatic CI:

```sh
node harness/tests/antigravity-live-smoke.mjs --run /path/to/agy
```

`harness/tests/subagents.test.mjs` 使用本地可执行 fixture 模拟两种官方协议，覆盖正常完成、原生错误、
取消与子进程回收、畸形和超限数据流、ACP 审批拒绝、事件与 task 关联，以及原生会话恢复。Fixture 不会
对任一服务进行认证；混合任务链路还验证拒绝后继续写入 SQLite 记忆、父代理收到部分输出、最终无法执行项以及重启后状态/事件
读回。Profile 与拒绝测试接入 Linux x64、Linux ARM64、Windows x64 CI。在 Linux x64 / WSL2 上，
`agy 1.2.17` 和 `CodeBuddy 2.158.0` 的原生 print 与 Navigator provider 真实调用均返回指定文本，
未触发审批请求。CodeBuddy 原生 ACP 即使声明认证方式，也能使用缓存登录完成会话，无需发送
`authenticate`。这些检查覆盖真实 CLI 和 DSH 受管子进程，不代表 HTTP、Client 或 Exchange 整条链路。
Antigravity 工作区命令也已真实执行；完整 OS 边界及拒绝后继续的验收与简短回复测试分开记录。
Windows/ARM64 原生账号执行仍为 **NOT_RUN**。预检接受文档化的安全缺省字段，并拒绝不同 init 模式。
上面的显式烟测命令使用原生订阅，只操作私有测试文件；不会加入自动 CI。后续 CLI 如声明不同 init 模式，
会明确拒绝。

Protocol references / 协议资料：

- [Antigravity CLI headless and stream-json](https://antigravity.google/docs/cli/headless)
- [Antigravity native terminal sandbox](https://antigravity.google/docs/sandbox?tab=cli)
- [Antigravity CLI execution modes](https://antigravity.google/docs/cli/modes/)
- [Antigravity permissions](https://antigravity.google/docs/permissions?tab=cli)
- [CodeBuddy ACP](https://www.codebuddy.ai/docs/cli/acp)
- [CodeBuddy CLI reference](https://www.codebuddy.ai/docs/cli/cli-reference)
