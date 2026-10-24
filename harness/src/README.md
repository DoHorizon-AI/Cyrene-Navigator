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
| `codebuddy-adapter.ts` | Restricted CodeBuddy structured-output provider; DSH remains the sole tool executor / 受限 CodeBuddy 结构化输出 provider；DSH 保持唯一工具执行者 |
| `antigravity-adapter.ts` | Pinned Antigravity model-only structured-output provider; native tools are rejected and DSH remains the sole executor / 固定 Antigravity 纯模型结构化输出 provider；拒绝原生工具并保持 DSH 唯一执行权 |
| `exchange-adapter.ts` | OpenAI-compatible streaming adapter for Exchange / Exchange 的 OpenAI 兼容流式 adapter |
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
and defaults to `exchange` for existing deployments. The production Docker
executor enters through `node scripts/serve-executor.mjs`; setting the source
there selects the model adapter. The separate `scripts/serve-local.py` launcher
is not wired for Antigravity yet. CodeBuddy defaults to
`glm-5.3-flash` and also advertises `deepseek-v4.1-flash`. Antigravity defaults
to `gemini-3.8-flash-medium` and advertises only the verified 3.8 Flash low,
medium, and high model slugs. It requires the service HOME's exact
`~/.gemini/config/agents/cyrene-dsh-model.md` profile and an operator-installed,
authenticated `agy` executable on PATH. Each request is one stdin JSON event in
a temporary empty working directory; the user prompt is never a command-line
argument. The adapter validates the pinned profile before startup and each
request, requires Antigravity to report the selected model and agent with strict
permission mode, and accepts only one `finish` tool step plus a successful
schema-constrained terminal result. Its `init.tools` registry list is not used
as the effective allowlist. The CLI receives only the HOME, PATH, temporary
directory, locale settings, and optional CA paths; Cyrene, Exchange, and provider
credentials are not forwarded. Only DSH catalog tool requests are returned to the existing
AgentLoop, which remains the sole business-tool executor. CodeBuddy remains
registered in Antigravity mode so already-live CodeBuddy Agents can finish.

The adapter rejects missing, changed, or unsuccessful terminal results and
locally validates requested tool names and arguments against the active DSH
catalog. Existing in-memory Agent sessions keep their captured model; new
sessions use the configured source. After a service restart, a persisted session
is resumed with the currently configured model selection and its prior history.

`CYRENE_HARNESS_MODEL_SOURCE` 用于选择 `exchange`、`codebuddy` 或
`antigravity`，未设置时仍默认 `exchange`，以兼容既有部署。CodeBuddy provider 在未设置
`CYRENE_HARNESS_MODEL` 时默认使用 `glm-5.3-flash`，同时公布
`deepseek-v4.1-flash`。Antigravity 默认使用 `gemini-3.8-flash-medium`，只公布已验证的
3.8 Flash low、medium、high 模型 slug。它要求服务 HOME 下存在精确的
`~/.gemini/config/agents/cyrene-dsh-model.md` profile，并且 `agy` 已由 operator 安装和授权。
每次请求通过 stdin 发送单条 JSON event，工作目录是新建的空临时目录；用户 prompt 不会进入命令行参数。
适配器在启动和每次请求前校验固定 profile，要求 Antigravity 回报匹配的 model、agent 和 strict
permission mode，且只接受一个 `finish` tool step 和成功的 schema 结构化终态。`init.tools` 中的工具
注册表清单不代表当前 agent 的有效 allowlist。CLI 子进程只继承 HOME、PATH、临时目录、locale 设置和
可选 CA 路径；不会接收 Cyrene、Exchange 或 Provider 凭据。生产 Docker executor 通过
`node scripts/serve-executor.mjs` 读取该模型 source；独立的 `scripts/serve-local.py` 当前尚未接入
Antigravity。模型只能返回 DSH catalog 中的工具请求，业务工具仍由
现有 DSH AgentLoop 唯一执行。Antigravity 模式也会保留 CodeBuddy adapter，以便已运行的 CodeBuddy
Agent 完成当前 Session。

适配器拒绝缺失、变更或失败的终态，并根据当前 DSH 工具目录在本地校验工具名和参数。已经驻留内存的
Agent Session 保持原模型；新 Session 使用当前配置。服务重启后，持久化 Session 会在恢复原历史的同时
使用当前配置的模型选择。

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
