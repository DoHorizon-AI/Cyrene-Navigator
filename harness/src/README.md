# Harness adapters / Harness 适配层

These plugins implement Cyrene integration against the pinned upstream's real
interfaces. The upstream owns the Agent Loop, Session event model, and Tool
lifecycle; these adapters provide persistence, native capabilities, and
product handoff routes. They do not define a second Agent Loop or message
history.

这些插件直接实现已固定上游的接口。上游拥有 Agent Loop、Session event model 和
Tool 生命周期；本目录适配持久化、原生能力和产品资源交接，不维护另一套 Agent
Loop 或可写消息历史。

| File | Responsibility / 职责 |
| --- | --- |
| `persistence.ts` | Remote Cyrene `SessionPersistence` and ordered live writer / 远程 Cyrene 会话持久化与有序 writer |
| `persistence-wire.ts` | Authenticated HTTP, handle decoding, and upstream event validation / 认证 HTTP、handle 解码和上游事件校验 |
| `acp-conversation-execution.ts` | Shared ACP Work task, session, cancellation, and cleanup lifecycle / 共享 ACP Work Task、会话、取消和清理生命周期 |
| `acp-mcp-host.ts` | Task-local authorized MCP bridge for native ACP tools / 原生 ACP 工具使用的任务级授权 MCP bridge |
| `codebuddy-acp-execution.ts` | Explicit native CodeBuddy ACP profile / 显式原生 CodeBuddy ACP profile |
| `antigravity-acp-execution.ts` | Explicit official Antigravity ACP profile and native model readback / 显式官方 Antigravity ACP profile 与原生模型回读 |
| `codebuddy-adapter.ts` | Restricted CodeBuddy structured-output provider; DSH remains the sole tool executor / 受限 CodeBuddy 结构化输出 provider；DSH 保持唯一工具执行者 |
| `antigravity-adapter.ts` | Pinned Antigravity model-only structured-output provider; native tools are rejected and DSH remains the sole executor / 固定 Antigravity 纯模型结构化输出 provider；拒绝原生工具并保持 DSH 唯一执行权 |
| `exchange-adapter.ts` | OpenAI-compatible streaming adapter for Exchange / Exchange 的 OpenAI 兼容流式 adapter |
| `model-policy.ts` | Explicit provider fallback policy and provider-reported token usage decoding / 显式备用路由策略和供应商 token 用量解码 |
| `model-gate.ts` | Separate bounded foreground and background model-call lanes / 分开的前台与后台有界模型调用槽 |
| `responsibility-authority.ts` | V2 workflow provenance, connector scope, and Teams notice validation / V2 工作流来源、连接器范围和 Teams 通知校验 |
| `responsibility-tools.ts` | Owner-scoped Teams commands for durable duty management and provider usage / 按所有者隔离的 Teams 职责管理及供应商用量命令 |
| `workflow-teams-delivery.ts` | Project verified workflow transitions into the durable Teams outbox / 将已校验的工作流状态投影到持久 Teams outbox |
| `executor.ts` | Durable task admission, foreground/background scheduling, and task receipts / 持久任务接纳、前后台调度和执行回执 |
| `serve.ts` | Compose the pinned Harness adapters, policy providers, and executor / 装配固定 Harness 适配器、权限与执行器 |
| `native-ipc.ts` | Supervised inherited-stdio request, cancellation, and protocol framing / 受监管 inherited-stdio 请求、取消和协议封装 |
| `native.ts` | Cordis Tool registration over the Rust host / 通过 Rust host 注册 Cordis Tool |
| `import-codex.ts` | Codex read-only archive and explicit AgentLoop Continue / Codex 只读 archive 与显式 AgentLoop Continue |
| `session-control.ts` | Session ownership and durable input receipt routes / Session ownership 与 durable input receipt 路由 |
| `session-titles.ts` | Workspace-authorized cold title read route / Workspace 授权的冷会话标题读取路由 |
| `compaction.ts` | Profile-only text summary policy over upstream compaction / 基于上游 compaction 的 Profile 文本摘要策略 |
| `README.md` | This directory map and authority boundary / 本目录导航与 authority 边界 |

The title route is `POST /api/cyrene/session/titles` with
`{"sessionIds":["..."]}`. A successful response contains
`items[{sessionId,title?,seq?,updatedAt?}]` and `errors[]`; `seq` is the
durable `session/title` event sequence. The route deduplicates and bounds
requests, rejects ids outside the current Workspace before any title read, and
never starts an Agent or appends Session history.

标题路由为 `POST /api/cyrene/session/titles`，请求体是
`{"sessionIds":["..."]}`。成功响应包含
`items[{sessionId,title?,seq?,updatedAt?}]` 与 `errors[]`；`seq` 是持久化的
`session/title` 事件序号。路由会去重并限制请求数量，在读取标题前拒绝当前
Workspace 之外的 ID，也不会启动 Agent 或追加会话历史。

The input receipt route is `POST /api/cyrene/session/input-receipts` with
`{"sessionId":"...","requestIds":["..."]}` (one to eight IDs). A successful
response is `{"sessionId":"...","eventCount":N,"completedRequestIds":[...]}`.
The Connection route is streaming and rejects a body over 8 KiB while it is
being consumed. It opens a Cyrene read handle after a durable stat, scans only
the last 4096 events in the stat-observed prefix, and confirms an ID only for a matching
`turn/start → user/message(source.rpcId) → turn/end(reason.kind=completed)`.
Live in-memory events, failed/cancelled turns, unseen IDs, and turns outside
the bounded tail remain unconfirmed. The route is read-only and returns no
message content or tool arguments.

输入 receipt 路由为 `POST /api/cyrene/session/input-receipts`，请求体为
`{"sessionId":"...","requestIds":["..."]}`（一至八个 ID）。成功响应为
`{"sessionId":"...","eventCount":N,"completedRequestIds":[...]}`。
Connection 路由使用 streaming body，在读取过程中拒绝超过 8 KiB 的请求体。
路由先读取 durable stat，再打开 Cyrene read handle，只扫描 stat 观察到的前缀中最近
4096 个事件；
只有匹配的
`turn/start → user/message(source.rpcId) → turn/end(reason.kind=completed)`
才会确认 request ID。内存中的 live event、失败或取消的 turn、未出现的 ID，以及
超出有界尾部的 turn 都不会确认。路由只读，也不会返回消息正文或工具参数。

Suggested reading and verification order:

1. Read `persistence-wire.ts` for the HTTP boundary and upstream validation.
2. Read `persistence.ts` for handle ownership, batching, heartbeat, and flush.
3. Read `native-ipc.ts` and `native.ts` for the thin Cordis-to-Rust bridge.
4. Read `import-codex.ts` for archive/Continue semantics and the real upstream
   `AgentRegistry` integration.
5. Read `session-titles.ts` for the read-only cold projection route.
6. Run the repository CI commands and the integration tests under `../tests/`.

推荐阅读和验证顺序：

1. 先读 `persistence-wire.ts`，理解 HTTP 边界与上游校验。
2. 再读 `persistence.ts`，理解 handle ownership、批处理、heartbeat 和 flush。
3. 再读 `native-ipc.ts` 与 `native.ts`，理解 Cordis 到 Rust 的薄桥接。
4. 最后读 `import-codex.ts`，理解 archive/Continue 语义及真实上游
   `AgentRegistry` 集成。
5. 再读 `session-control.ts` 与 `session-titles.ts`，理解 receipt 和只读冷 projection 路由。
6. 运行仓库 CI 命令和 `../tests/` 下的 integration tests。

The Rust protocol and executable authority are documented in `../../native/`.
The parent `harness/README.md` and `upstream.lock.json` define the Bundle and
exact upstream pin.

`CYRENE_HARNESS_MODEL_SOURCE` selects `exchange`, `codebuddy`, or `antigravity`
and defaults to `antigravity` with `gemini-3.8-flash-medium`. Set it explicitly
to `exchange` or `codebuddy` to retain another primary route. The production Docker
executor enters through `node scripts/serve-executor.mjs`; setting the source
there selects the model adapter. The separate `scripts/serve-local.py` launcher
is not wired for Antigravity yet. CodeBuddy defaults to
`glm-5.3-flash` and also advertises `deepseek-v4.1-flash`. Antigravity defaults
to `gemini-3.8-flash-medium` and advertises only the verified 3.8 Flash low,
medium, and high model slugs. If `CYRENE_HARNESS_MODEL` is set, it must use one
of those Antigravity slugs; remove a stale model from another provider or set
the desired Antigravity model explicitly. An optional CodeBuddy fallback is
disabled by default and requires `CYRENE_HARNESS_CODEBUDDY_FALLBACK_ENABLED=true`,
`CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP=true`, and an allowlisted
`CYRENE_HARNESS_CODEBUDDY_FALLBACK_MODEL`. It requires the service HOME's exact
`~/.gemini/config/agents/cyrene-dsh-model.md` profile and an operator-installed,
authenticated `agy` executable on PATH. Each request is one stdin JSON event in
a temporary empty working directory; the user prompt is never a command-line
argument. The adapter validates the pinned profile before each request, requires
Antigravity to report the selected model and agent with strict
permission mode, and accepts only one `finish` tool step plus a successful
schema-constrained terminal result. Its `init.tools` registry list is not used
as the effective allowlist. The CLI receives only the HOME, PATH, temporary
directory, locale settings, and optional CA paths; Cyrene, Exchange, and provider
credentials are not forwarded. Only DSH catalog tool requests are returned to the existing
AgentLoop, which remains the sole business-tool executor. CodeBuddy remains
registered in Antigravity mode so already-live CodeBuddy Agents can finish.

This section describes the DSH model adapter only. The independent, opt-in
`antigravity-acp` Work Task backend is documented below and does not install or
route through that DSH model adapter.

The adapter rejects missing, changed, or unsuccessful terminal results and
locally validates requested tool names and arguments against the active DSH
catalog. A recognized provider availability failure can retry the same DSH
model step through the explicitly configured backup route; the persisted
request and usage events identify the provider and model that actually ran.
Usage records contain only token counts reported by that provider. Existing
in-memory Agent sessions keep their captured selection; new sessions use the
configured source. After a service restart, a persisted session is resumed with
the currently configured model selection and its prior history.

## Native CodeBuddy ACP execution

`CYRENE_HARNESS_EXECUTION_BACKEND` selects the top-level Work Task executor and
defaults to `dsh`. Set it to `codebuddy-acp` to run one native CodeBuddy ACP
process per Work Task. This is independent of `CYRENE_HARNESS_MODEL_SOURCE`; the
ACP mode does not install the DSH `AgentLoop` or DSH LLM adapters. Leave
`CYRENE_HARNESS_MODEL_SOURCE` and `CYRENE_HARNESS_MODEL` unset or empty, set
`CYRENE_HARNESS_CODEBUDDY_FALLBACK_ENABLED=false`, and declare
`CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP=true`. The last setting is a deployment
declaration only: CodeBuddy CLI does not provide a switch that technically
blocks consumption of purchased credits. Optional
`CYRENE_HARNESS_CODEBUDDY_ACP_MODEL` accepts only `glm-5.3-flash` or
`deepseek-v4.1-flash` and defaults to `glm-5.3-flash`. The command selector
`CYRENE_HARNESS_CODEBUDDY_ACP_COMMAND` accepts only `codebuddy`.

Navigator starts CodeBuddy with `--acp --acp-transport stdio --agent cli`,
`--permission-mode default`, `--tools ""`, `--strict-mcp-config`, fixed
`--setting-sources project,local`, fixed `--settings` that disable hooks and add
no enabled plugins, a host-created `--mcp-config` file, and the allowlisted
model. The CLI uses one stable private workspace under its configured profile;
caller-selected project paths do not reach ACP. Each task's configuration sits
below that workspace in a private `0700` directory as a `0600` file, contains
one Navigator-owned loopback MCP bridge, and is removed after process cleanup.
Its MCP token stays out of argv,
prompt content, and Work events; only the dedicated MCP stdio child receives the
bridge endpoint and token. The CodeBuddy process receives only its HOME/profile
path, PATH, locale, proxy, and certificate settings. Work, Exchange, Directory,
authority, and Docker credentials are removed. Built-in shell, file, and
terminal tools are disabled, and strict MCP configuration discards user and
project MCP servers.

The bridge exposes the registered Exchange tools and the connector tools in the
host-authorized Exchange catalog, including configured computer bindings. Each
call follows the existing Navigator schema, actor and target checks, approvals,
Exchange grant, and Work operation receipt path. Native ACP session IDs live in
the existing Workspace-scoped Work SQLite database, keyed by Navigator Work
Session. Restarts require `session/load`; Navigator never substitutes a Work or
legacy DSH Session ID. Legacy DSH history is not imported or replayed. A new ACP
session receives an explicit fresh-context instruction, and its native ID is
stored before the user prompt. Local protocol-stub tests verify this adapter
boundary; they do not prove a credentialed CodeBuddy login or model call.

## Official Antigravity ACP execution

`CYRENE_HARNESS_EXECUTION_BACKEND` still defaults to `dsh`; set it explicitly
to `antigravity-acp` to select Google's official ACP server. This is separate
from `CYRENE_HARNESS_MODEL_SOURCE`, and the backend rejects DSH model routes,
fallbacks, adapters, and subagents. Production requires an absolute
`CYRENE_HARNESS_ANTIGRAVITY_ACP_COMMAND` and a persistent, owner-only
`CYRENE_HARNESS_ANTIGRAVITY_ACP_PROFILE`. The Linux image uses
`/usr/local/bin/agy_acp_server.par` with its adjacent executable
`localharness_external`; the official Linux registry argument `--uid=` is
passed as a fixed argv item. A missing companion fails startup.

The profile root must be owned by the Navigator process and mode `0700`.
Nested XDG directories must stay inside that root, be owned by the same process,
and contain no symlinks; their existing mode bits are preserved because the
private root blocks access by other operating-system users.

The child HOME is the Antigravity profile, with XDG config/cache/data/state
directories below it. Native sign-in remains in that profile; Navigator does
not import CodeBuddy or `agy` CLI tokens, forward provider credentials in the
child environment, or start a login flow. The profile's global
`~/.gemini/config/mcp_config.json` is rejected so the task's single Navigator
MCP server is the only custom server available. `_meta.antigravity.enabledTools`
is set to `[]`, using the official built-in allowlist filter; native file,
terminal, and browser tools stay disabled. A permission is allowed once only
when official ACP metadata marks it as an MCP call, names the `navigator`
server and an exact current-catalog tool, and reports the native MCP kind.
Other requests are rejected, even if a title or raw input resembles a catalog
tool.

Optional `CYRENE_HARNESS_ANTIGRAVITY_ACP_MODEL` must exactly match a model ID
advertised in the native session's `configOptions`; Navigator sets it and
checks the returned current value. If unset, the session's advertised native
default is used; that does not claim a user-preferred model. Missing configured
IDs and later model changes fail the turn. Navigator has no DSH, CodeBuddy, or
model fallback route for this backend; provider entitlement and billing remain
Google-owned. Local fake-ACP tests verify the adapter boundary, not a real
Antigravity prompt or tool call.

Foreground chat and background responsibilities use separate durable DSH
Sessions. Foreground work has its own bounded task and model-call lane, while at
most one background task runs at a time. `CYRENE_EXECUTOR_MAX_CONCURRENT_TASKS`
sets the total active task bound and defaults to `2`; queued foreground tasks are
admitted before queued background work. The bound must be at least `2` so one
foreground task slot remains available while the single background slot is busy.
Tasks have no default total-run timeout
or turn-count gate. Provider, connector, and explicitly requested task timeouts
remain in force.

`CYRENE_HARNESS_MODEL_SOURCE` 用于选择 `exchange`、`codebuddy` 或
`antigravity`，当前默认 `antigravity` 和 `gemini-3.8-flash-medium`。需要保留其他主路由时请显式设置为
`exchange` 或 `codebuddy`。CodeBuddy provider 在未设置
`CYRENE_HARNESS_MODEL` 时默认使用 `glm-5.3-flash`，同时公布
`deepseek-v4.1-flash`。Antigravity 默认使用 `gemini-3.8-flash-medium`，只公布已验证的
3.8 Flash low、medium、high 模型 slug。若设置了 `CYRENE_HARNESS_MODEL`，其值必须属于这三个 slug；
切换 provider 时应移除旧模型值或显式设置目标 Antigravity 模型。CodeBuddy 备用路由默认关闭；启用时必须同时设置
`CYRENE_HARNESS_CODEBUDDY_FALLBACK_ENABLED=true`、
`CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP=true`，并将
`CYRENE_HARNESS_CODEBUDDY_FALLBACK_MODEL` 设为允许的模型。它要求服务 HOME 下存在精确的
`~/.gemini/config/agents/cyrene-dsh-model.md` profile，并且 `agy` 已由 operator 安装和授权。
每次请求通过 stdin 发送单条 JSON event，工作目录是新建的空临时目录；用户 prompt 不会进入命令行参数。
适配器在每次请求前校验固定 profile，要求 Antigravity 回报匹配的 model、agent 和 strict
permission mode，且只接受一个 `finish` tool step 和成功的 schema 结构化终态。`init.tools` 中的工具
注册表清单不代表当前 agent 的有效 allowlist。CLI 子进程只继承 HOME、PATH、临时目录、locale 设置和
可选 CA 路径；不会接收 Cyrene、Exchange 或 Provider 凭据。生产 Docker executor 通过
`node scripts/serve-executor.mjs` 读取该模型 source；独立的 `scripts/serve-local.py` 当前尚未接入
Antigravity。模型只能返回 DSH catalog 中的工具请求，业务工具仍由
现有 DSH AgentLoop 唯一执行。Antigravity 模式也会保留 CodeBuddy adapter，以便已运行的 CodeBuddy
Agent 完成当前 Session。

本节只描述 DSH model adapter。独立且默认关闭的 `antigravity-acp` Work Task backend
见下文；它不会安装或经过该 DSH model adapter。

适配器拒绝缺失、变更或失败的终态，并根据当前 DSH 工具目录在本地校验工具名和参数。已识别的 provider
可用性故障可让同一 DSH 模型步骤使用显式配置的备用路由重试；持久化请求和用量事件会记录实际调用的 provider
与 model。用量记录只保留供应商返回的 token 数。已经驻留内存的 Agent Session 保持当前选择；新 Session
使用已配置的主路由。服务重启后，持久化 Session 会在恢复原历史的同时使用当前配置的模型选择。

## CodeBuddy 原生 ACP 主执行

`CYRENE_HARNESS_EXECUTION_BACKEND` 选择 Work Task 的顶层执行器，默认 `dsh`。
设为 `codebuddy-acp` 后，每个 Work Task 由 CodeBuddy 原生 ACP 子进程执行；它与
`CYRENE_HARNESS_MODEL_SOURCE` 分离，该模式不会安装 DSH `AgentLoop` 或 LLM adapter。
`CYRENE_HARNESS_MODEL_SOURCE` 和 `CYRENE_HARNESS_MODEL` 应未设置或为空，
`CYRENE_HARNESS_CODEBUDDY_FALLBACK_ENABLED=false`，并声明
`CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP=true`。最后一项只是部署声明；CodeBuddy CLI
没有能从技术上阻止使用已购 credits 的配置。可选的
`CYRENE_HARNESS_CODEBUDDY_ACP_MODEL` 仅接受 `glm-5.3-flash` 或
`deepseek-v4.1-flash`，默认 `glm-5.3-flash`；
`CYRENE_HARNESS_CODEBUDDY_ACP_COMMAND` 仅接受 `codebuddy`。

Navigator 固定以 `--acp --acp-transport stdio --agent cli`、`--permission-mode default`、
`--tools ""`、`--strict-mcp-config`、`--setting-sources project,local`、禁用 hooks 且不添加已启用插件的固定
`--settings`、宿主生成的 `--mcp-config` 文件和 allowlist 模型启动 CodeBuddy。CLI 使用其配置 profile 下稳定的私有 workspace；
调用方指定的项目路径不会传给 ACP。每任务配置保存在 workspace 下权限为 `0700` 的私有目录和权限为
`0600` 的文件中，只包含一个 Navigator 所有的 loopback MCP bridge，进程清理后移除。MCP token
不进入 argv、prompt 或 Work event；只有专用 MCP stdio 子进程会收到 bridge endpoint 和 token。
CodeBuddy 子进程只接收 HOME/profile 路径、PATH、locale、代理和证书设置。Work、Exchange、Directory、
Authority 与 Docker 凭据都会清除。原生 shell、file 与 terminal 工具被禁用；strict MCP 配置会丢弃用户和项目级 MCP。

Bridge 仅公开已注册的 Exchange 工具以及宿主 Exchange 授权目录内的连接器工具，包括已配置的
computer binding。每次调用仍执行现有 Navigator schema、actor/target 校验、审批、Exchange grant
与 Work operation receipt 路径。原生 ACP Session ID 保存在现有 Workspace-scoped Work SQLite
数据库中，并以 Navigator Work Session 为键。进程重启必须使用 `session/load`；Navigator 不会拿
Work 或旧 DSH Session ID 代替。旧 DSH 历史不导入、不重放。新 ACP Session 会收到明确的新上下文
提示，并在发送用户 prompt 前写入原生 ID。本地协议 stub 测试只验证适配器边界，不代表已完成
CodeBuddy 登录或模型调用。

## 官方 Antigravity ACP 执行

`CYRENE_HARNESS_EXECUTION_BACKEND` 仍默认 `dsh`；只有显式设为
`antigravity-acp` 才会启动 Google 官方 ACP server。它与
`CYRENE_HARNESS_MODEL_SOURCE` 分离，并拒绝 DSH 模型路由、fallback、adapter 和 subagent。
生产环境要求绝对路径 `CYRENE_HARNESS_ANTIGRAVITY_ACP_COMMAND`，以及持久、仅 owner 可读写的
`CYRENE_HARNESS_ANTIGRAVITY_ACP_PROFILE`。Linux 镜像使用
`/usr/local/bin/agy_acp_server.par` 和同目录可执行文件 `localharness_external`；按官方
Linux registry 参数固定传入 `--uid=`。缺少 companion 时启动失败。

profile 根目录必须由 Navigator 进程拥有且权限为 `0700`。嵌套 XDG 目录必须位于
根目录内、由同一进程拥有且不包含符号链接；由于私有根目录已阻止其他操作系统用户
访问，运行时保留这些目录现有的权限位。

子进程 HOME 指向 Antigravity profile，XDG config/cache/data/state 目录均放在该 profile 下。
原生登录状态保存在此处；Navigator 不导入 CodeBuddy 或 `agy` CLI token，不向子进程环境传递
provider 凭据，也不启动登录流程。若 profile 中存在全局
`~/.gemini/config/mcp_config.json`，运行会拒绝启动，确保唯一自定义 server 是当前任务的
Navigator MCP。通过官方 built-in allowlist `_meta.antigravity.enabledTools: []` 禁用原生
文件、终端和浏览器工具。只有 ACP 官方元数据标记为 MCP call、指定 `navigator` server 和当前
目录中的精确工具名，且 MCP kind 正确时才会一次性允许；标题或 raw input 看起来像目录工具也不够。

可选的 `CYRENE_HARNESS_ANTIGRAVITY_ACP_MODEL` 必须与原生 session `configOptions` 中公布的
模型 ID 完全相同；Navigator 设置后校验服务回传的 current value。未设置时采用原生 session
公布的默认模型，这不表示该模型是用户偏好。配置模型不存在或 session 后续变更模型都会让当前
turn 失败。此 backend 没有 DSH、CodeBuddy 或模型 fallback；账号 entitlement 与计费由 Google
管理。本地 fake ACP 测试只验证适配器边界，不代表完成真实 Antigravity prompt 或工具调用。

前台聊天和后台责任任务使用不同的持久 DSH Session。前台任务和模型调用有独立的有界槽位，后台同时最多运行一个任务。
`CYRENE_EXECUTOR_MAX_CONCURRENT_TASKS` 限制活动任务总数，默认值为 `2`，并且必须至少为 `2`，以便后台槽位繁忙时仍保留一个前台槽位；排队的前台任务优先于排队的后台任务。
任务默认没有整体运行时长或轮数上限；供应商、连接器和调用方明确设置的超时仍然有效。

Rust 协议和可执行文件 authority 见 `../../native/`；父目录的 `harness/README.md`
与 `upstream.lock.json` 定义 Bundle 和精确上游 pin。
---
<!-- Chinese Translation / 中文翻译 -->

## 推荐阅读与验证顺序

1. 阅读 `persistence-wire.ts`，了解 HTTP 边界和上游校验。
2. 阅读 `persistence.ts`，了解 handle 所有权、批处理、heartbeat 和 flush。
3. 阅读 `native-ipc.ts` 与 `native.ts`，了解 Cordis 到 Rust 的薄桥接。
4. 阅读 `import-codex.ts`，了解 archive/Continue 语义及真实上游 `AgentRegistry` 集成。
5. 阅读 `session-titles.ts`，了解只读的冷标题投影路由。
6. 运行仓库 CI 命令和 `../tests/` 中的集成测试。
