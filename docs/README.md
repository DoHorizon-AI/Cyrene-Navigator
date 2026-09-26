# Navigator documentation / Navigator 文档

Navigator is a built-in Harness component of the Native Client (`Cyrene-Client`), developed as a secondary development of DeepSeek harness. It owns the Harness runtime adaptation, Agent loop coordination, and authoritative local session persistence. It carries no user interface (UI) and no unrelated product features.

Navigator 是 Native Client（`Cyrene-Client`）的内置 Harness 组件，基于 DeepSeek harness 进行二次开发。它负责 Harness 运行时适配、Agent 执行循环协调及权威本地会话持久化。Navigator 本身不带任何 UI，也不承担其他无关产品服务功能。

| Document | Purpose / 用途 |
| --- | --- |
| [API](API.md) | Session & Harness API / 会话与 Harness 接口 |
| [Repository lifecycle](REPOSITORY-LIFECYCLE.md) | Repository delivery conventions / 仓库交付约定 |
| [Harness adoption](adoption/README.md) | DeepSeek Harness integration, compatibility & boundaries / DeepSeek Harness 接入、兼容性与边界 |
| [Codex import](import/README.md) | Archive and explicit Continue semantics / 归档及显式 Continue |
| [Operations](operations/README.md) | Review-only service packaging and deployment gates / 仅供审查的服务打包与部署门槛 |
| [Logging & Error Standards](logging-and-errors.md) | Cross-repository logging, error codes, and diagnostics specification / 跨仓日志、错误码与诊断规范 |

Repository governance and public-source guidance live in the root
[`CONTRIBUTING.md`](../CONTRIBUTING.md), [`SECURITY.md`](../SECURITY.md),
[`LICENSE`](../LICENSE), and [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

仓库治理与公开源码说明位于根目录的 [`CONTRIBUTING.md`](../CONTRIBUTING.md)、
[`SECURITY.md`](../SECURITY.md)、[`LICENSE`](../LICENSE) 和
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。
