# Glossary / 术语表

| English | 中文 | Meaning / 含义 |
|---|---|---|
| Navigator | Navigator 内置 Harness | Built-in Harness component of Native Client, based on DeepSeek harness (no UI) / Native Client 内置 Harness 组件，基于 DeepSeek harness 二次开发（不含 UI） |
| WorkspaceState | 工作区状态 | Client-owned state for the active workspace / 当前工作区的客户端状态 |
| ConversationThread | 对话线程 | User-visible sequence of related interactions / 面向用户的一组相关交互 |
| Local host | 本地主机 | Client-side boundary hosting local capabilities / 承载本地能力的客户端边界 |
| Capability Resolver | 能力解析器 | Plugins-owned resolution of a compatible versioned provider; not embedded in Navigator V1 / 由 Plugins 拥有的兼容提供方解析组件；Navigator V1 未内嵌 |
| Capability provider | 能力提供方 | Component implementing one declared capability / 实现某项已声明能力的组件 |
| Tool provider | 工具提供方 | Provider exposing an approved callable tool / 暴露获批可调用工具的提供方 |
| Skill runtime | 技能运行时 | Runtime for reusable user or agent workflows / 执行可复用用户或智能体工作流的运行时 |
| MCP | Model Context Protocol | Protocol boundary for model-facing tools and context / 面向模型工具与上下文的协议边界 |
| Product connector | 产品连接器 | Client adapter for a Cyrene product API / 对接 Cyrene 产品 API 的客户端适配器 |
| Native client harness | 原生客户端内置 Harness | Built-in test and execution harness embedded in Cyrene-Client / 内嵌于 Cyrene-Client 的会话执行与测试适配 Harness |
| Harness profile | Harness Profile | Pinned DeepSeek Harness source composed with Navigator adapters / 固定上游 DeepSeek Harness 源码与 Navigator 适配器的组合 |
| Native host | 原生宿主 | Navigator-owned Rust NDJSON process host / Navigator 自有的 Rust NDJSON 进程宿主 |
