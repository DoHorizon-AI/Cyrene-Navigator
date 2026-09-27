# Navigator documentation / Navigator 文档

Navigator composes a pinned revision of the upstream DeepSeek Harness repository with Cyrene adapters and provides local session and Product-read APIs. The `Cyrene-Client` control service reaches Navigator's separate Web Host through a configured service URL. The upstream project owns the Agent Loop and Session event model. `Cyrene-Client` owns the application shell and primary presentation; Navigator also contains Harness UI adapters but no standalone client application.

Navigator 将固定版本的上游 DeepSeek Harness 仓库与 Cyrene 适配器组合，并提供本地会话与 Product 读取 API。`Cyrene-Client` control service 通过配置的服务 URL 访问 Navigator 的独立 Web Host。上游项目拥有 Agent Loop 与 Session 事件模型。`Cyrene-Client` 拥有应用 shell 和主要展示层；Navigator 也包含 Harness UI 适配器，但不提供独立的客户端应用。

| Document | Purpose / 用途 |
| --- | --- |
| [API](API.md) | Product, session & Harness API / Product、会话与 Harness 接口 |
| [Repository lifecycle](REPOSITORY-LIFECYCLE.md) | Repository delivery conventions / 仓库交付约定 |
| [Harness adoption](adoption/README.md) | DeepSeek Harness integration, compatibility & boundaries / DeepSeek Harness 接入、兼容性与边界 |
| [Codex import](import/README.md) | Archive and explicit Continue semantics / 归档及显式 Continue |
| [Logging & Error Standards](logging-and-errors.md) | Cross-repository logging, error codes, and diagnostics specification / 跨仓日志、错误码与诊断规范 |

Repository governance and public-source guidance live in the root
[`CONTRIBUTING.md`](../CONTRIBUTING.md), [`SECURITY.md`](../SECURITY.md),
[`LICENSE`](../LICENSE), and [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

仓库治理与公开源码说明位于根目录的 [`CONTRIBUTING.md`](../CONTRIBUTING.md)、
[`SECURITY.md`](../SECURITY.md)、[`LICENSE`](../LICENSE) 和
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。
