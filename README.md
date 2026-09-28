# Navigator

Navigator is a **built-in Harness component** of the Native Client (`Cyrene-Client`), developed as a secondary development of **DeepSeek harness** (`@deepseek-ai/deepseek-harness`).

It provides the test and execution Harness runtime, Agent loop coordination, and authoritative local session persistence.

**Key Clarifications & Boundaries**:
- **Navigator carries NO UI**: Navigator contains no presentation layer or user interface. All graphical user interfaces, interactive controls, and visual consoles are exclusively owned and rendered by the Native Client (`Cyrene-Client`).
- **Navigator carries NO unrelated service features**: Navigator is strictly a client-internal Harness component. It does not provide server-side model training (owned by Yield), serving deployment (owned by Reactor), dataset preparation (owned by Catalyst), evaluation (owned by Echo), gateway governance (owned by Exchange), or kernel process supervision (owned by Platform).

## Architecture & Responsibilities

- **Harness Runtime**: Secondary development on top of pinned DeepSeek harness packages (`@deepseek-ai/dsh-*`), managing out-of-tree Cordis plugins, Agent loop execution, and tool execution boundaries.
- **Authoritative Session Persistence**: Stores canonical session headers and append-only event logs in local SQLite storage, providing deterministic session recovery and replay isolation.
- **Native Host & IPC**: The Rust `native/` workspace provides native process isolation, NDJSON supervisor primitives, and local tool execution hooks for the Harness.
- **Integration with Products**: Connects directly to Exchange for LLM inference and Echo for post-session evaluations and feedback; it does not proxy or intermediate other product services.

## Documentation

- [Harness Adoption & Architecture](docs/adoption/README.md)
- [Product & Session API Contract](docs/API.md)
- [Repository Lifecycle](docs/REPOSITORY-LIFECYCLE.md)
- [Native Host](native/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Third-party Notices](THIRD_PARTY_NOTICES.md)
- [License](LICENSE)

---
<!-- Chinese Translation / 中文翻译 -->

# Navigator

Navigator 是 Native Client（`Cyrene-Client`）的**内置 Harness 组件**，基于 **DeepSeek harness**（`@deepseek-ai/deepseek-harness`）进行二次开发。

它为 Native Client 提供会话执行与测试适配 Harness 运行时、Agent 执行循环协调以及权威的本地会话持久化支持。

**核心澄清与职责边界**：
- **Navigator 本身不带 UI**：Navigator 不包含任何展示层或图形界面。所有的工作台 UI、用户交互界面与可视化面板均完全由 Native Client（`Cyrene-Client`）拥有与渲染。
- **Navigator 不带其他无关功能**：Navigator 是一个纯粹的客户端内置 Harness 组件，不包含任何与 Harness 无关的服务功能。服务端模型训练（归 Yield 所有）、模型推理部署（归 Reactor 所有）、数据集清洗处理（归 Catalyst 所有）、评测与反馈分析（归 Echo 所有）、API 网关治理（归 Exchange 所有）及平台内核调度（归 Platform 所有）均由各对应专业仓库负责。

## 架构与核心职责

- **Harness 运行时适配**：基于固定版本的 DeepSeek harness（`@deepseek-ai/dsh-*`）进行二次开发，提供 Cordis 插件组合、Agent 循环驱动及工具调用边界控制。
- **权威会话持久化**：在本地 SQLite 中权威保存规范会话头（SessionHeader）及只追加原始事件日志（Append-only event envelope），提供可恢复的会话状态保障。
- **原生宿主与 IPC**：Rust `native/` 工作区提供轻量原生进程宿主、NDJSON 监管原语及本地工具沙箱钩子。
- **与其它服务交互**：仅作为客户端内置组件，按需直连 Exchange 进行模型推理，以及直连 Echo 提交会话评测和反馈。

## 文档索引

- [Harness 接入与架构说明](docs/adoption/README.md)
- [API 与会话契约](docs/API.md)
- [仓库生命周期](docs/REPOSITORY-LIFECYCLE.md)
- [原生宿主说明](native/README.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
- [许可证](LICENSE)
