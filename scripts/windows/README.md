# Windows native helpers / Windows 原生辅助脚本

The Windows path now has two independent UI modes: the browser WebUI under
`apps/desktop` and the native WinUI client under `apps/windows`. These helpers
only build or verify the Rust native process host and its integration fixtures;
they do not package a WebView shell.

Windows 路径现在有两种独立 UI 模式：`apps/desktop` 下的浏览器 WebUI，以及
`apps/windows` 下的原生 WinUI 客户端。本目录只构建或验证 Rust native process host
及集成 fixture，不再打包 WebView 壳。

`build-native-host.ps1` pins Rust `1.97.1-x86_64-pc-windows-msvc`, applies the
target-scoped static CRT flags, and emits a digest record. The native client
and browser UI consume the same API/contract layer; neither embeds this host's
presentation code.

`build-native-host.ps1` 固定 Rust `1.97.1-x86_64-pc-windows-msvc`，应用目标级静态 CRT
配置并输出 digest record。原生客户端和浏览器 UI 共享 API/contract 层，但不嵌入 host
的展示代码。
