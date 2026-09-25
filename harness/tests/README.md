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

`delivery-feedback.test.mjs` is a browser state regression over freshly built
`harness/dist/client.js`. `windows-native-imports.test.mjs` checks the packaged
host's PE imports on Windows. Both remain narrower than installed desktop smoke
and interactive GUI evidence.
---
<!-- Chinese Translation / 中文翻译 -->

## 测试范围补充

准备好固定版本的上游源码后，构建适配器和原生宿主，再运行 `.github/workflows/ci.yml` 中列出的集成测试。这些测试验证适配器、IPC、持久化、导入和 Profile 行为，不代表真实模型、已安装 GUI 或多设备端到端结果。

`native.integration.test.mjs` 在只调用 Navigator 自有方法的前提下，保留子进程取消、回收、协议版本、输出边界和凭据隔离矩阵。Windows 会编译等价的 Rust fixture，以在真实进程边界验证相同的 supervisor 行为。

`delivery-feedback.test.mjs` 针对刚构建的 `harness/dist/client.js` 验证浏览器状态回归。`windows-native-imports.test.mjs` 在 Windows 上检查打包宿主的 PE 导入。两者的证据范围都小于已安装桌面冒烟和交互式 GUI 验证。
