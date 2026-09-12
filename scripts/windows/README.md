# Windows native helpers / Windows 原生辅助脚本

These helpers build or verify the Rust native process host and its integration
fixtures. Browser and WinUI presentation moved to `cyrene.ui.navigator`; this
directory does not own or package those clients.

本目录只构建或验证 Rust native process host 及集成 fixture。浏览器与 WinUI 展示层已迁至
`cyrene.ui.navigator`；本目录不拥有或打包这些客户端。

`build-native-host.ps1` pins Rust `1.97.1-x86_64-pc-windows-msvc`, applies the
target-scoped static CRT flags, and emits a digest record. Optional clients
consume the published API/contract layer and do not embed this host's code.

`build-native-host.ps1` 固定 Rust `1.97.1-x86_64-pc-windows-msvc`，应用目标级静态 CRT
配置并输出 digest record。可选客户端消费公开 API/contract 层，不嵌入该 host 的代码。
