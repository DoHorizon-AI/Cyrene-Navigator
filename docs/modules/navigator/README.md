# Navigator module / Navigator 模块

## Purpose / 目录用途

This module page describes Navigator's active client implementation: the
browser WebUI, the native Windows client prototype, the pinned Harness
adapters, the Rust native host, and the Python session persistence and Product
read service.

本模块页说明 Navigator 的活跃客户端实现：浏览器 WebUI、原生 Windows 客户端原型、
固定版本 Harness 适配器、Rust 原生宿主，以及 Python 会话持久化与产品读取服务。

Navigator presents user-facing workflows and calls Product APIs directly; it
does not own remote Product state, and local Plugin capability integration is
not connected in V1.

Navigator 承载面向用户的工作流并直连产品 API；它不拥有远程产品状态，V1 尚未接入
本地 Plugin 能力。

## Files and responsibilities / 文件与职责

| Path | Responsibility / 职责 |
|---|---|
| [`../../API.md`](../../API.md) | Product objects, request paths, and implementation status / 产品对象、请求路径与实现状态 |
| [`../../REPOSITORY-LIFECYCLE.md`](../../REPOSITORY-LIFECYCLE.md) | Repository ownership, trust boundary, release topology, and branch model / 仓库归属、信任边界、发布拓扑与分支模型 |
| [`../../../README.md`](../../../README.md) | Repository entry point and current service boundary / 仓库入口与当前服务边界 |
| [`../../../repository-policy.yaml`](../../../repository-policy.yaml) | Repository lifecycle and governance metadata / 仓库生命周期与治理元数据 |
| [`../../../contracts/product/v1/`](../../../contracts/product/v1/) | Navigator-owned Product API contract and client aggregation schema / Navigator 自有的产品 API 契约与客户端聚合 schema |
| [`../../../src/cyrene_navigator/`](../../../src/cyrene_navigator/) | Session persistence, Product read service, and local Artifact adapter / 会话持久化、产品读取服务与本地制品适配器 |
| [`../../../harness/`](../../../harness/) | Pinned DeepSeek Harness adapters and Profile integration / 固定 DeepSeek Harness 适配器与 Profile 集成 |
| [`../../../native/`](../../../native/) | Rust `cyrene-native-host` with Codex import / Rust `cyrene-native-host` 与 Codex 导入 |
| [`../../../apps/desktop/`](../../../apps/desktop/) | Standalone browser WebUI / 独立浏览器 WebUI |
| [`../../../apps/windows/`](../../../apps/windows/) | WinUI client surface (`API_CONNECTED_PROTOTYPE`; reads via `Core/Ports`, Debug-only preview fixtures) / WinUI 客户端界面（`API_CONNECTED_PROTOTYPE`；经 `Core/Ports` 读取，fixture 仅 Debug） |

## Suggested reading / 推荐阅读

1. `docs/architecture/overview.md` — understand Navigator's horizontal workspace role.
2. `docs/API.md` — inspect client-owned surfaces and Product connections.
3. `docs/desktop/README.md` — see how the browser WebUI and native client relate.
4. `docs/REPOSITORY-LIFECYCLE.md` — understand release and trust boundaries.

1. `docs/architecture/overview.md` —— 理解 Navigator 作为横向工作区的角色。
2. `docs/API.md` —— 查看客户端归属范围与产品连接。
3. `docs/desktop/README.md` —— 了解浏览器 WebUI 与原生客户端的关系。
4. `docs/REPOSITORY-LIFECYCLE.md` —— 理解发布与信任边界。
