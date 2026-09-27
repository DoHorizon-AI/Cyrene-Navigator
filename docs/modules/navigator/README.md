# Navigator module / Navigator 模块

## Purpose / 目录用途

This module describes Navigator's Harness integration, local session and Product APIs used by the Native Client (`Cyrene-Client`) through its configured service URL, and the separate native-host protocol for Codex rollout import. Navigator composes a pinned upstream DeepSeek Harness revision with Cyrene adapters; the upstream project owns the Agent Loop and Session event model.

本模块说明 Native Client（`Cyrene-Client`）通过配置的服务 URL 访问的 Navigator Harness 集成、本地会话和 Product API，以及用于导入 Codex rollout 的独立原生宿主协议。Navigator 将固定版本的上游 DeepSeek Harness 与 Cyrene 适配器组合；上游项目拥有 Agent Loop 与 Session 事件模型。

`Cyrene-Client` owns the application shell and primary user-facing presentation. Navigator has no standalone client application, but retains Harness UI adapter code; each Product remains authoritative for its own remote state.

`Cyrene-Client` 拥有应用 shell 和主要面向用户的展示层。Navigator 不提供独立客户端应用，但保留 Harness UI 适配代码；各 Product 仍是自身远程状态的权威。

## Files and responsibilities / 文件与职责

| Path | Responsibility / 职责 |
|---|---|
| [`../../API.md`](../../API.md) | Product, session & Harness API contract / Product、会话与 Harness API 契约 |
| [`../../REPOSITORY-LIFECYCLE.md`](../../REPOSITORY-LIFECYCLE.md) | Repository ownership, trust boundary, and branch model / 仓库归属、信任边界与分支模型 |
| [`../../../README.md`](../../../README.md) | Repository entry point and Harness boundary / 仓库入口与 Harness 边界 |
| [`../../../repository-policy.yaml`](../../../repository-policy.yaml) | Repository lifecycle and governance metadata / 仓库生命周期与治理元数据 |
| [`../../../contracts/product/v1/`](../../../contracts/product/v1/) | Session APIs and workspace-read snapshot contract / 会话 API 与 Workspace 读取快照契约 |
| [`../../../src/cyrene_navigator/`](../../../src/cyrene_navigator/) | Session persistence, Product reader, and local Artifact adapter / 会话持久化、Product 读取与本地 Artifact 适配器 |
| [`../../../harness/`](../../../harness/) | Pinned DeepSeek Harness profile, Cyrene adapters, and client UI adapter / 固定 DeepSeek Harness profile、Cyrene 适配器与客户端 UI 适配器 |
| [`../../../native/`](../../../native/) | Rust `cyrene-native-host` with versioned NDJSON and Codex import / 支持版本化 NDJSON 与 Codex 导入的 Rust `cyrene-native-host` |
| [`../../desktop/README.md`](../../desktop/README.md) | UI extraction notice / 历史 UI 剥离说明 |

## Suggested reading / 推荐阅读

1. `docs/architecture/overview.md` — understand Navigator's Harness, API, and client boundaries.
2. `docs/API.md` — inspect Product reads, session persistence, and Harness endpoints.
3. `docs/desktop/README.md` — read the UI extraction and ownership notice.
4. `docs/REPOSITORY-LIFECYCLE.md` — understand release and trust boundaries.

1. `docs/architecture/overview.md` —— 理解 Navigator 的 Harness、API 与客户端边界。
2. `docs/API.md` —— 查看 Product 读取、会话持久化与 Harness 端点。
3. `docs/desktop/README.md` —— 阅读历史 UI 剥离与归属说明。
4. `docs/REPOSITORY-LIFECYCLE.md` —— 理解发布与信任边界。
