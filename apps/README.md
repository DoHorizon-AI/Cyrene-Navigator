# Application surfaces / 应用界面

This directory contains the product-facing application surfaces maintained by
this repository. Browser and native presentation are separate from Navigator's
service, Harness, and native-worker authorities.

本目录存放本仓库维护的面向产品的应用界面。浏览器和原生展示与 Navigator 的 service、
Harness、native worker authority 分离。

| Directory | Responsibility / 职责 |
| --- | --- |
| [`desktop/`](desktop/README.md) | Standalone browser WebUI / 独立浏览器 WebUI |
| [`windows/`](windows/README.md) | Native WinUI client surface / 原生 WinUI 客户端界面 |

Read the application-specific README before changing an application surface.
Generated directories such as `node_modules`, `dist`, and `target` are build
outputs.

修改应用界面前先阅读对应目录的 README。`node_modules`、`dist`、`target` 等生成目录
属于构建产物。
