# Glossary / 术语表

| English | 中文 | Meaning / 含义 |
|---|---|---|
| Navigator | Navigator Harness 与本地 API | Cyrene adapters over a pinned DeepSeek Harness revision, with local session and Product-read APIs / 基于固定版本 DeepSeek Harness 的 Cyrene 适配器，以及本地会话和 Product 读取 API |
| WorkspaceState | 工作区状态 | Client-owned state for the active workspace / 当前工作区的客户端状态 |
| ConversationThread | 对话线程 | User-visible sequence of related interactions / 面向用户的一组相关交互 |
| Local host | 本地主机 | Client-side boundary hosting local capabilities / 承载本地能力的客户端边界 |
| Capability Resolver | 能力解析器 | Plugins-owned resolution of a compatible versioned provider; not embedded in Navigator V1 / 由 Plugins 拥有的兼容提供方解析组件；Navigator V1 未内嵌 |
| Capability provider | 能力提供方 | Component implementing one declared capability / 实现某项已声明能力的组件 |
| Tool provider | 工具提供方 | Provider exposing an approved callable tool / 暴露获批可调用工具的提供方 |
| Skill runtime | 技能运行时 | Runtime for reusable user or agent workflows / 执行可复用用户或智能体工作流的运行时 |
| MCP | Model Context Protocol | Protocol boundary for model-facing tools and context / 面向模型工具与上下文的协议边界 |
| Product connector | 产品连接器 | Client adapter for a Cyrene product API / 对接 Cyrene 产品 API 的客户端适配器 |
| Native Client integration | Native Client 集成 | `Cyrene-Client` reaches Navigator service APIs through its control service; the native-host protocol is a separate Harness integration boundary / `Cyrene-Client` 通过其 control service 访问 Navigator 服务 API；原生宿主协议属于独立的 Harness 集成边界 |
| Harness profile | Harness Profile | Pinned DeepSeek Harness source revision composed with Navigator adapters / 固定版本上游 DeepSeek Harness 源码与 Navigator 适配器的组合 |
| ProductReadPort | Product 读取端口 | Navigator-local bounded read adapter for Workspace snapshots / Navigator 本地用于 Workspace 快照的受限读取适配器 |
| Native host | 原生宿主 | Navigator-owned Rust host for versioned NDJSON and Codex import / Navigator 自有的 Rust 宿主，支持版本化 NDJSON 与 Codex 导入 |
