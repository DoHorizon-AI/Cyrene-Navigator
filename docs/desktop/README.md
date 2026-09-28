# Historical UI extraction notice / 历史 UI 剥离说明

> [!IMPORTANT]
> **Navigator carries NO UI**: Navigator is strictly a built-in Harness component of the Native Client (`Cyrene-Client`), developed based on DeepSeek harness. All graphical user interfaces, presentations, and visual consoles are exclusively owned and rendered by `Cyrene-Client`.
> 
> **Navigator 本身不带 UI**：Navigator 纯粹作为 Native Client（`Cyrene-Client`）的内置 Harness 组件（基于 DeepSeek harness 二次开发）。所有图形界面与可视化交互完全归属于 `Cyrene-Client`。

The browser WebUI and historical native client prototypes were completely extracted from this repository into `Cyrene-Client` (with provenance archived in `Cyrene-Plugins-Official/plugins/ui/navigator`).

历史上的 WebUI 与客户端原型已从本仓库完全移除并收敛迁移至 `Cyrene-Client`。

Navigator retains strictly the Harness runtime adapters, durable session persistence, and native process host. Historical presentation prototypes are not part of Navigator and must not be reintroduced.

Navigator 仅保留 Harness 运行时适配、权威本地会话持久化与原生进程宿主能力。历史原型界面不再属于 Navigator，严禁重新引入。
