# Navigator Codex conversation import

Navigator V1 的 Codex 导入把外部 rollout 当作历史资料接入上游 DeepSeek Harness Session。导入路由只负责资源交接和投影，Session event log 仍由 Cyrene persistence 保存；没有第二份可写的 message history。

The importer accepts one authenticated `POST` request at `/api/cyrene/import/codex`:

```json
{"filename":"rollout.jsonl","content":"<UTF-8 Codex rollout JSONL>"}
```

请求由上游 Connection Host 在 Host、Origin 和 cookie 信任检查之后交给路由。路由使用明确的 buffered body 上限（4 MiB），上传内容上限为 512 KiB；内容先写入临时文件，再通过现有 `runNativeRequest` 的 inherited stdio IPC 调用固定 Rust host 的 `import_codex_rollout`，无固定监听端口。Rust 完成后临时目录在 `finally` 中删除。

## Event projection

- `user` 和 `assistant` 记录按原 role 写入真正的 `user/message` 与 `assistant/message` 事件，并带 `surfaceOp: "append"`。
- assistant provenance 固定记录 `provider: "codex"`；缺失的模型写成 `model: "unknown"`，不会套用当前 Exchange 模型。
- Rust `events` 中的 tool call、tool result、审批、system、未知和 metadata 记录写成 `cyrene/import-history`，强制 `executable: false` 和 `ignorable: true`。它们可以读取和导出，不会进入待执行队列。
- `cyrene/import` 事件保存 source filename、digest、原始 UTF-8 content、原始 Session metadata、conversion report 和安全标记；所有内容与消息事件位于同一个 authoritative event log。
- 导入完成后 writer 会 flush 并 release，source Session 只作为 read-only archive 留在 event log；不会启动 AgentRun，也不会继承 source 的 cwd 或权限。
- 历史 archive 的 `user`/`assistant` 消息仍可在 Session 投影中阅读和导出；历史 tool call、tool result、审批和 system record 只保留为不可执行 history。

## Explicit Continue

继续使用 archive 必须是一个明确的用户动作，调用：

```text
POST /api/cyrene/import/codex/continue
```

请求至少包含新的目标身份和执行目录：

```json
{
  "sourceSessionId": "codex-<source-sha256>",
  "newSessionId": "codex-continue-<client-id>",
  "cwd": "/workspace/project",
  "agentPreset": "standard"
}
```

`agentPreset` 可省略；profile 有 `agentPresets` 服务时使用其 default，否则创建无额外 preset 的 Agent。请求的 `cwd` 必须是绝对路径，且不会从 archive 推断。若指定 preset 但 profile 未安装该服务，路由会拒绝请求。

Continue 读取 source event log 中最后一个完整 `turn/end` 之前的连续前缀，交给上游 `AgentRegistry.create({ seed, inheritedEventCount, meta })`，由真实 `AgentLoop` 持有新的可写 Session。`cyrene/import`、`cyrene/import-history`、`session/end-seed` 以及未完成边界不会进入 seed，因此历史工具不会被重新调用；用户的新 prompt 才会开始新的 AgentRun。

`newSessionId` 是幂等键。重复请求会校验 source、cwd、seed 前缀和 preset metadata；相同请求返回已有 live Agent 或从 Cyrene persistence 恢复它，冲突请求返回 `IMPORT_CONTINUE_CONFLICT`，不会另建第二份会话。

Continue 的失败响应使用 RFC 9457 风格的 `application/problem+json`。稳定 code 包括 `IMPORT_CONTINUE_SOURCE_NOT_FOUND`、`IMPORT_CONTINUE_SOURCE_NOT_ARCHIVE`、`IMPORT_CONTINUE_UNAVAILABLE`、`IMPORT_CONTINUE_AGENT_UNAVAILABLE`、`IMPORT_CONTINUE_PRESET_UNAVAILABLE`、`IMPORT_CONTINUE_SESSION_BUSY` 和 `IMPORT_CONTINUE_CONFLICT`；客户端应根据 code 显示导入、工作目录、preset 或权限交接问题，而不是重放历史工具。

Archive 不伪造 source `cwd`。因此上游只按 cwd 筛选冷 Session 的列表实现可能在 Navigator 重启后隐藏这类 archive；产品 UI 应从 Cyrene persistence 的 archive/eventlog 视图读取它们，并在打开时要求用户选择目标 cwd 和 preset，再调用 Continue。

The archive and Continue paths have separate product semantics: import is a durable, read-only handoff, while Continue creates a new upstream Agent on an explicit workspace path. Both use the same Cyrene event log and persistence authority. Continue requires the upstream AgentRegistry/AgentLoop; it never falls back to a fake SessionStore or starts a parallel Agent loop.

## Idempotency and recovery

Session ID 是 `codex-<source SHA-256>`，按 Workspace 隔离。因此同一内容的重复导入只返回已有 Session，不重复写历史。创建、消息投影、历史记录、原始归档和 `session/end-seed` 在一个 persistence append batch 中提交，并在返回前经过 flush；丢失 append 响应时重试使用同一 batch digest，由 persistence backend 幂等处理。

如果进程在创建空 Session 后退出，下一次导入会返回 `IMPORT_SESSION_INCOMPLETE`，等待拥有者或管理员完成恢复；不会猜测地追加第二份消息。这个状态会保留在 Cyrene persistence，便于审计。

The implementation is intentionally an adapter around the pinned upstream Session API and the existing Rust IPC bridge. It does not implement a second Agent loop, a local conversation database, source permission activation, or an external-provider restriction. External providers remain available through the upstream profile; the adoption proof route uses Exchange separately.
---
<!-- Chinese Translation / 中文翻译 -->

## 产品语义

archive 导入和 Continue 具有不同的 Product 语义：导入是持久化、只读的交接；Continue 则在显式指定的工作区路径上创建新的上游 Agent。两者使用同一份 Cyrene event log 和持久化权威。Continue 依赖上游 `AgentRegistry`/`AgentLoop`，绝不会回退到伪造的 SessionStore 或启动并行 Agent loop。

## 幂等与恢复补充

如果进程在创建空 Session 后退出，后续导入会返回 `IMPORT_SESSION_INCOMPLETE`，等待 owner 或管理员完成恢复；系统不会猜测性地追加第二份消息。该状态会保留在 Cyrene 持久化层，以便审计。

此实现刻意作为固定版本上游 Session API 和现有 Rust IPC bridge 的适配器。它不会实现第二套 Agent loop、本地对话数据库、来源权限激活或外部 Provider 限制。外部 Provider 仍由上游 Profile 提供；adoption 验证路径会单独使用 Exchange。
