# Navigator

Navigator provides Harness integration, local APIs, and a Rust native host for
Codex rollout import over versioned NDJSON. `Cyrene-Client` owns the application
shell and reaches the separate Navigator Web Host through its control service's
configured URL. Navigator's profile composes a pinned revision of the upstream
[DeepSeek Harness repository](harness/upstream.lock.json) with Cyrene adapters;
it does not replace the upstream Agent Loop or Session event model.

## Responsibilities and boundaries

- **Harness integration**: The `harness/` bundle composes the pinned upstream runtime with Cyrene
  session, persistence, and client adapters.
- **Local session service**: The Python service owns durable local session persistence and exposes the session API.
- **Product reads and handoffs**: Navigator's `ProductReadPort` provides bounded Workspace read
  snapshots across Catalyst, Yield, Echo, Reactor, and Exchange. Harness inference uses Exchange;
  an explicit evaluation handoff publishes a local Artifact and sends the session to Echo. Each
  Product remains authoritative for its own domain state.
- **Native host**: The Rust `native/` workspace imports Codex rollouts over a versioned NDJSON protocol.
- **Client UI boundary**: `Cyrene-Client` owns the application shell and primary user-facing
  presentation. Navigator includes Harness UI adapters under `harness/src/client/`, but does not
  provide a standalone client application.
- **Product boundaries**: Navigator does not own dataset processing, training, serving deployment, evaluation services, gateway governance, or Platform kernel supervision.

## Documentation

- [Harness Adoption & Architecture](docs/adoption/README.md)
- [Product, Session & Harness API Contract](docs/API.md)
- [Repository Lifecycle](docs/REPOSITORY-LIFECYCLE.md)
- [Native Host](native/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Third-party Notices](THIRD_PARTY_NOTICES.md)
- [License](LICENSE)

---
<!-- Chinese Translation / 中文翻译 -->

# Navigator

Navigator 提供 Harness 集成、本地 API 和通过版本化 NDJSON 协议导入 Codex rollout 的 Rust 原生宿主。
`Cyrene-Client` 拥有应用 shell，并由其 control service 通过配置的 URL 访问独立的 Navigator Web Host。
Navigator profile 将固定版本的上游 [DeepSeek Harness 仓库](harness/upstream.lock.json) 与 Cyrene 适配器组合；上游仍拥有 Agent Loop 和 Session 事件模型。

## 职责与边界

- **Harness 接入**：`harness/` bundle 将固定版本的上游运行时与 Cyrene 会话、持久化及客户端
  适配器组合起来。
- **本地会话服务**：Python 服务负责权威的本地会话持久化并提供会话 API。
- **Product 读取与交接**：Navigator 的 `ProductReadPort` 为 Catalyst、Yield、Echo、Reactor 和
  Exchange 提供受限的 Workspace 读取快照；Harness 推理通过 Exchange，显式评估交接会先发布本地
  Artifact，再将会话发送到 Echo。各 Product 仍是自身领域状态的权威。
- **原生宿主**：Rust `native/` 工作区通过版本化 NDJSON 协议导入 Codex rollout。
- **客户端 UI 边界**：`Cyrene-Client` 拥有应用 shell 和主要面向用户的展示层。Navigator 在 `harness/src/client/` 中保留 Harness UI 适配器，但不提供独立的客户端应用。
- **Product 边界**：Navigator 不拥有数据集处理、训练、服务部署、评估服务、网关治理或 Platform 内核监管。

## 文档索引

- [Harness 接入与架构说明](docs/adoption/README.md)
- [Product、会话与 Harness API 契约](docs/API.md)
- [仓库生命周期](docs/REPOSITORY-LIFECYCLE.md)
- [原生宿主说明](native/README.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
- [许可证](LICENSE)
