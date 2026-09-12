# Navigator UI extraction / Navigator UI 迁移记录

The browser WebUI and native WinUI client were extracted from this repository
at `a8091ca8e8a01ca8d103aa10ef706891c75c4fb3` into
`Cyrene-Plugins-Official/plugins/ui/navigator`.

浏览器 WebUI 与原生 WinUI 客户端从本仓库
`a8091ca8e8a01ca8d103aa10ef706891c75c4fb3` 迁移到
`Cyrene-Plugins-Official/plugins/ui/navigator`。

The destination owns presentation code, Product-client HTTP adapters, Debug
preview fixtures, and UI-specific build and license evidence. Navigator retains
the published Product API, durable session persistence, Harness adapters, and
Rust native process host. The historical source remains available in Git; it is
not copied back into the active Navigator tree.

目标包拥有展示代码、Product 客户端 HTTP 适配器、Debug 预览 fixture，以及 UI 专属构建与
许可证证据。Navigator 保留公开 Product API、持久会话状态、Harness 适配器与 Rust 原生进程
宿主。历史源码仍可从 Git 恢复，但不会复制回 Navigator 活跃目录。

UI source/build, Windows GUI, packaging, and signing evidence must be checked in
the Plugins repository. Navigator CI covers only the API, persistence, Harness,
and native-host side of the boundary.

UI 源码/构建、Windows GUI、打包与签名证据必须在 Plugins 仓库验证；Navigator CI 只覆盖
API、持久化、Harness 与 native host 一侧。
