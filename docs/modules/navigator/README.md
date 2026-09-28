# Navigator module / Navigator 模块

## Purpose / 目录用途

This module describes Navigator's role as a built-in Harness component of the Native Client (`Cyrene-Client`), developed based on DeepSeek harness. It encompasses the Harness runtime adapters, Rust native host, and authoritative Python session persistence service.

本模块说明 Navigator 作为 Native Client（`Cyrene-Client`）内置 Harness 组件的角色（基于 DeepSeek harness 二次开发）。它包含 Harness 运行时适配器、Rust 原生宿主，以及权威 Python 会话持久化服务。

Navigator carries NO user interface and does not own remote product state. All presentation is exclusively owned and rendered by `Cyrene-Client`.

Navigator 本身不带任何 UI，也不拥有远程产品状态。所有的用户界面均由 `Cyrene-Client` 独占拥有与呈现。

## Files and responsibilities / 文件与职责

| Path | Responsibility / 职责 |
|---|---|
| [`../../API.md`](../../API.md) | Session & Harness API contract / 会话与 Harness API 契约 |
| [`../../REPOSITORY-LIFECYCLE.md`](../../REPOSITORY-LIFECYCLE.md) | Repository ownership, trust boundary, and branch model / 仓库归属、信任边界与分支模型 |
| [`../../../README.md`](../../../README.md) | Repository entry point and Harness boundary / 仓库入口与 Harness 边界 |
| [`../../../repository-policy.yaml`](../../../repository-policy.yaml) | Repository lifecycle and governance metadata / 仓库生命周期与治理元数据 |
| [`../../../contracts/product/v1/`](../../../contracts/product/v1/) | Session API contract / 会话 API 契约 |
| [`../../../src/cyrene_navigator/`](../../../src/cyrene_navigator/) | Session persistence and local Artifact adapter / 会话持久化与本地制品适配器 |
| [`../../../harness/`](../../../harness/) | Pinned DeepSeek Harness adapters and Profile integration / 固定 DeepSeek Harness 适配器与 Profile 集成 |
| [`../../../native/`](../../../native/) | Rust `cyrene-native-host` with Codex import / Rust `cyrene-native-host` 与 Codex 导入 |
| [`../../desktop/README.md`](../../desktop/README.md) | UI extraction notice / 历史 UI 剥离说明 |

## Suggested reading / 推荐阅读

1. `docs/architecture/overview.md` — understand Navigator's role as Native Client's built-in Harness component.
2. `docs/API.md` — inspect session persistence and Harness endpoints.
3. `docs/desktop/README.md` — read the UI extraction and ownership notice.
4. `docs/REPOSITORY-LIFECYCLE.md` — understand release and trust boundaries.

1. `docs/architecture/overview.md` —— 理解 Navigator 作为 Native Client 内置 Harness 组件的角色。
2. `docs/API.md` —— 查看会话持久化与 Harness 端点。
3. `docs/desktop/README.md` —— 阅读历史 UI 剥离与归属说明。
4. `docs/REPOSITORY-LIFECYCLE.md` —— 理解发布与信任边界。
