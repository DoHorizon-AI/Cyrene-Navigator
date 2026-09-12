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
