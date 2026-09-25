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
