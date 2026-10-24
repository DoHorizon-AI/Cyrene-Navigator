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

`teams-bridge.integration.test.mjs` signs canonical adapter callbacks and
verifies durable thread admission, owner-only task dispatch, context isolation,
retry deduplication, and rejection of invalid HMACs without contacting Teams.

`connector-provider-outcomes.test.mjs` verifies that an accepted asynchronous
provider mutation leaves a durable target fence, and that only a terminal status
response with the matching operation reference clears it. It uses an in-process
Work and Exchange fixture and does not claim a real Exchange endpoint test.

`connector-authorization.test.mjs` verifies the exact Teams egress request,
Exchange's terminal `uncertain` tombstone, and bounded retries only for explicit
HTTP 429 responses.

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

`teams-bridge.integration.test.mjs` 为标准化适配器回调签名，并验证持久线程接纳、仅维护者触发任务、上下文隔离、重试去重和无效 HMAC 拒绝；测试不连接 Teams。

`connector-provider-outcomes.test.mjs` 验证异步 provider 操作保留持久目标写入栅栏，并且只有携带匹配操作引用的终态查询才会解除栅栏。该测试使用进程内 Work/Exchange fixture，不代表真实 Exchange 端点验收。

`connector-authorization.test.mjs` 验证 Teams 出站请求字段、Exchange 终态 `uncertain` 墓碑，以及仅在明确 HTTP 429 时进行有界重排。

`delivery-feedback.test.mjs` 针对刚构建的 `harness/dist/client.js` 验证浏览器状态回归。`windows-native-imports.test.mjs` 在 Windows 上检查打包宿主的 PE 导入。两者的证据范围都小于已安装桌面冒烟和交互式 GUI 验证。
