# Harness boundary tests / Harness 边界验证

These tests exercise Navigator adapters against the exact DeepSeek Harness
checkout, the real Navigator Rust host, and the real local persistence service.
They require no Platform source checkout or Platform executable.

测试使用精确 DeepSeek Harness checkout、真实 Navigator Rust host 和本地持久化
服务，不需要 Platform 源码或 Platform 可执行文件。

Prepare the pinned upstream, build the adapters and native host, then run the
integration files listed by `.github/workflows/ci.yml`. The tests prove adapter,
IPC, persistence, import, and Profile behavior. They do not claim a real model,
installed GUI, or multi-device end-to-end result.

`native.integration.test.mjs` keeps the subprocess cancellation, reaping,
protocol-version, output-bound, and credential-isolation matrix while exercising
only Navigator-owned methods. Windows compiles the equivalent Rust fixture so
the same supervisor behavior is checked across the real process boundary.

`codebuddy-adapter.test.mjs` uses a local fake executable to verify restricted
CLI flags, serialized DSH history, canonical tool-call chunks, active-schema
validation, terminal-result handling, timeout, and cancellation. It does not
make a credentialed model request or claim real-model inference.

`antigravity-adapter.test.mjs` uses a local fake CLI to verify the exact
operator-provisioned model-only profile, strict permission mode, finish-only
steps, split UTF-8 stream decoding, bounded process execution, and DSH catalog
validation. It does not use Antigravity credentials or claim live model
inference; the ARM64 live adapter probe is tracked separately.

`teams-bridge.integration.test.mjs` signs canonical adapter callbacks and
verifies durable thread admission, owner-only task dispatch, context isolation,
retry deduplication, rejection of invalid HMACs, and the trusted Teams system
policy for direct execution without a second approval. It does not contact Teams.

`connector-provider-outcomes.test.mjs` verifies that an unknown GitHub CLI write
exposes its Work receipt ID, stays fenced until an independent same-task read
receipt is explicitly reconciled, and never replays automatically. It also keeps
the terminal provider-status reconciliation case. It uses local Work/Exchange
fixtures and does not claim a real Exchange endpoint test.

`persistence.integration.test.mjs` also exercises operation readback and
reconciliation through the real Python persistence ASGI service and SQLite. Its
provider replies and catalog file are synthetic fixtures; it makes no GitHub
request and does not claim an Exchange ListTools export test.

`connector-authorization.test.mjs` verifies the exact Teams egress request,
Exchange's terminal `uncertain` tombstone, and bounded retries only for explicit
HTTP 429 responses.

`workflows-v2.test.mjs` exercises the real DSH Schedule hook and a launcher-authorized GitHub tool catalog for two repositories. A truncated first page cannot advance the watermark; a later occurrence resumes the stored cursor and accepts the window only after the contiguous page chain is complete. The fixture is local and makes no external GitHub or Teams request.

`product-observation.test.mjs`, `host-observation.test.mjs`,
`source-config.test.mjs`, and `office-observation.test.mjs` cover fixed resource
paths, current actor/source authorization, bounded pages, safe metadata, freshness
and status transitions. `persistence.actor-token.test.mjs` covers dedicated
per-session persistence identities and missing restart mappings. Their transports
and identities are synthetic; real provider authorization and personal Teams
installation/delivery remain separate acceptance gates.

这些来源测试验证固定资源路径、当前 actor 和来源权限、有界分页、安全元数据、时效及
状态转换；actor-token 测试验证独立会话持久身份和重启后缺失映射的拒绝行为。传输和身份
均为本地 fixture，真实供应商授权及 Teams 个人安装、消息送达须单独验收。

`delivery-feedback.test.mjs` is a browser state regression over freshly built
`harness/dist/client.js`. `windows-native-imports.test.mjs` checks the packaged
host's PE imports on Windows. Both remain narrower than installed desktop smoke
and interactive GUI evidence.
---
<!-- Chinese Translation / 中文翻译 -->

## 测试范围补充

准备好固定版本的上游源码后，构建适配器和原生宿主，再运行 `.github/workflows/ci.yml` 中列出的集成测试。这些测试验证适配器、IPC、持久化、导入和 Profile 行为，不代表真实模型、已安装 GUI 或多设备端到端结果。

`native.integration.test.mjs` 在只调用 Navigator 自有方法的前提下，保留子进程取消、回收、协议版本、输出边界和凭据隔离矩阵。Windows 会编译等价的 Rust fixture，以在真实进程边界验证相同的 supervisor 行为。

`codebuddy-adapter.test.mjs` 使用本地 fake executable 验证受限 CLI 参数、DSH 历史序列化、标准 tool-call block、当前 schema 校验、终态结果处理、超时和取消。它不会发出带凭据的模型请求，也不代表真实模型推理。

`antigravity-adapter.test.mjs` 使用本地 fake CLI 验证 operator 配置的精确纯模型 profile、strict permission mode、仅允许 `finish` 的步骤、分块 UTF-8 解码、有界进程执行和 DSH catalog 校验。它不使用 Antigravity 凭据，也不代表真实模型推理；ARM64 实时 adapter probe 单独记录。

`teams-bridge.integration.test.mjs` 为标准化适配器回调签名，并验证持久线程接纳、仅维护者触发任务、上下文隔离、重试去重、无效 HMAC 拒绝，以及 Teams system prompt 要求完整授权请求直接执行且不额外审批；测试不连接 Teams。

`connector-provider-outcomes.test.mjs` 验证 GitHub CLI 写结果未知时返回 Work 回执 ID；只有同一任务的独立只读回执经显式对账后才能解除写入栅栏，系统不会自动重放写操作。测试还保留 provider 终态状态查询对账场景。该测试使用本地 Work/Exchange fixture，不代表真实 Exchange 端点验收。

`persistence.integration.test.mjs` 还通过真实 Python persistence ASGI 服务和 SQLite 验证操作回执读取与对账。provider 响应和 catalog 文件是合成 fixture；测试不会请求 GitHub，也不代表已验证 Exchange ListTools 导出。

`connector-authorization.test.mjs` 验证 Teams 出站请求字段、Exchange 终态 `uncertain` 墓碑，以及仅在明确 HTTP 429 时进行有界重排。

`workflows-v2.test.mjs` 使用真实 DSH Schedule hook 和两个仓库的启动器授权 GitHub 工具目录。首次分页被截断时水位不会推进；后续 occurrence 续接已存游标，只有分页链连续完整后才接受该窗口。测试使用本地 fixture，不访问外部 GitHub 或 Teams。

`delivery-feedback.test.mjs` 针对刚构建的 `harness/dist/client.js` 验证浏览器状态回归。`windows-native-imports.test.mjs` 在 Windows 上检查打包宿主的 PE 导入。两者的证据范围都小于已安装桌面冒烟和交互式 GUI 验证。
