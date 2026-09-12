# Real Harness session proof / 真实 Harness 会话证明

`observe-harness-session.mjs` is a repeatable evidence collector for one real
Navigator Web Profile model turn. It uses the pinned DeepSeek Harness CLI and
its `ws@8.21.0` dependency, exchanges the private `dsh web` launch URL for a
cookie, creates and prompts one Session, then observes the upstream
`/api/remote.mux` WebSocket until a new `turn/end` with
`reason.kind = completed` arrives.

`observe-harness-session.mjs` 用于重复采集一次真实 Navigator Web Profile
模型回合的证据。它使用固定版本的 DeepSeek Harness CLI 及其 `ws@8.21.0` 依赖，
将私有 `dsh web` 启动 URL 换成内存中的 Cookie，创建并 prompt 一个 Session，
然后通过上游 `/api/remote.mux` WebSocket 监听，直到本次新回合真正收到
`reason.kind = completed` 的 `turn/end`。

## Run / 运行

Prepare the exact Harness checkout and build the Navigator adapters first:

先准备固定的 Harness checkout 并构建 Navigator adapter：

```text
node scripts/prepare-harness.mjs --root /path/to/deepseek-harness --install --build --link
node "$CYRENE_DSH_ROOT/node_modules/typescript/bin/tsc" -p harness/tsconfig.json
```

The private address file must contain the launcher's `launchUrl`, for example:

地址文件必须包含 launcher 输出的 `launchUrl`，例如：

```json
{"baseUrl":"http://127.0.0.1:44819","launchUrl":"http://127.0.0.1:44819/?token=<private>"}
```

Do not commit or print that file. Run the proof with a unique Session ID and a
real workspace directory:

不要提交或打印该文件。使用唯一 Session ID 和真实 workspace 目录运行：

```text
node scripts/proof/observe-harness-session.mjs \
  --address-file .navigator/proof/web-address.json \
  --session-id cyrene-model-proof-<unique> \
  --cwd /absolute/path/to/workspace \
  --prompt "Use the approved tool, then report the resulting artifact ID." \
  --expected-artifact sha256:<expected-id> \
  --output .navigator/proof/model-session-proof.json \
  --upstream /path/to/deepseek-harness
```

The script exits zero only after it sees the completed turn, a durable final
`assistant/message`, and matching canonical ToolCall/ToolResult IDs. When
`--expected-artifact` is supplied, a ToolResult and the final answer must both
contain that exact value. The JSON report records every received
`assistant-stream` frame with a relative monotonic arrival time, durable events,
usage samples, provider response IDs, cancellation state, and the final answer.
Before PASS, the authenticated Cyrene Session observation must acknowledge a
persisted event count beyond the terminal sequence; live WebSocket delivery
alone is insufficient evidence of durability.

脚本只有在收到 completed turn、持久化的最终 `assistant/message`，并且 canonical
ToolCall/ToolResult ID 完整匹配后才返回零。提供 `--expected-artifact` 时，ToolResult
和最终回答都必须包含该精确值。JSON 报告会记录每一条收到的
`assistant-stream` 帧及相对单调到达时间、持久化事件、usage、Provider response ID、
取消状态和最终回答。
PASS 前还须由经过认证的 Cyrene Session observation 确认持久化前缀已包含终止事件；
不能把实时 WebSocket 事件送达直接当作 durable write。

The script opens the follow stream before sending the prompt so transient
assistant frames cannot be missed. It never uses SSE, treats prompt acceptance
as success, or auto-approves tools. A timeout or failure attempts the upstream
`session/cancel` Remote method, closes the mux stream, writes `status: "FAIL"`
with `severity: "error"`, and exits non-zero. Launch tokens, cookies, bearer
credentials, and the launch URL are kept out of reports and diagnostics.

脚本会在发送 prompt 前先打开 follow stream，避免漏掉 transient assistant 帧。它不使用
SSE，不把 prompt accepted 当作成功，也不会自动批准工具。超时或失败时会尝试调用上游
`session/cancel`，关闭 mux stream，写入 `status: "FAIL"` 与 `severity: "error"`，并以非零
状态退出。启动 token、Cookie、Bearer 凭据和启动 URL 都不会进入报告或诊断输出。

This is a real model-session proof. It still depends on the running Exchange
route/provider and the model's configured tool policy; no GPU, deployment, or
Windows acceptance is implied by this script alone.

这是实际模型会话证明，但仍依赖正在运行的 Exchange route/provider 以及模型的工具策略；
单独通过该脚本不代表 GPU、部署或 Windows 验收已经完成。
