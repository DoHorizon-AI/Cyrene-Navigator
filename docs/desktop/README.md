# Historical UI extraction notice / 历史 UI 剥离说明

`Cyrene-Client` owns the application shell and primary user-facing presentation. Navigator retains Harness UI adapter code under `harness/src/client/`, but does not provide a standalone client application.

`Cyrene-Client` 拥有应用 shell 和主要面向用户的展示层。Navigator 在 `harness/src/client/` 中保留 Harness UI 适配代码，但不提供独立的客户端应用。

The browser application and native client presentation are maintained by `Cyrene-Client`. This note distinguishes those application surfaces from Navigator's Harness UI adapters.

浏览器应用与原生客户端展示由 `Cyrene-Client` 维护。此说明用于区分客户端应用展示与 Navigator 的 Harness UI 适配器。

Navigator retains Harness runtime adapters, local session and Product APIs, UI adapter code, and native process integration. It does not provide a standalone client shell.

Navigator 保留 Harness 运行时适配、本地会话和 Product API、UI 适配代码及原生进程集成；它不提供独立的客户端 shell。
