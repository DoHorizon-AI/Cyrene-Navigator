# Windows native helpers / Windows 原生辅助脚本

These helpers build or verify the Rust native host and its integration
fixtures. `Cyrene-Client` owns the application shell and primary presentation;
Navigator's Harness UI adapters are documented under `harness/src/client/`.

本目录只构建或验证 Rust native host 及集成 fixture。`Cyrene-Client` 拥有应用 shell 和主要展示层；
Navigator 的 Harness UI 适配器见 `harness/src/client/`。

`build-native-host.ps1` pins Rust `1.97.1-x86_64-pc-windows-msvc`, applies the
target-scoped static CRT flags, and emits a digest record. Optional clients
consume the published API/contract layer and do not embed this host's code.

`build-native-host.ps1` 固定 Rust `1.97.1-x86_64-pc-windows-msvc`，应用目标级静态 CRT
配置并输出 digest record。可选客户端消费公开 API/contract 层，不嵌入该 host 的代码。
