# Official cloud integrations / 官方云集成

This module loads the bundled official MCP profiles, registers discovered MCP
tools with DSH, and exposes tool descriptions and credential-free health
through `ctx.cloudConnections`. Google Cloud CLI access is a separate fixed
readonly argv adapter. Read [cloud-connections.md](../../../docs/cloud-connections.md)
before enabling a profile.

本目录加载随 Navigator 提供的官方 MCP 配置，将已发现工具注册到 DSH，并通过
`ctx.cloudConnections` 暴露工具说明和不含凭据的健康状态。Google Cloud CLI 使用独立的
固定只读 argv 适配器。启用连接前请先阅读
[cloud-connections.md](../../../docs/cloud-connections.md)。

| File | Responsibility / 职责 |
| --- | --- |
| `cloud-connections.ts` | Profile validation, MCP startup, health, and source-classified readonly workflow tools / 配置校验、MCP 启动、健康状态和按来源分类的只读工作流工具 |
| `index.ts` | Public package exports / 包公开导出 |

Load profiles, then call `registerCloudConnections(ctx, config)` after DSH
ToolRuntime is mounted. MCP connection instances are owned by the Cordis
context and dispose with it.

先加载配置，再在 DSH ToolRuntime 挂载后调用
`registerCloudConnections(ctx, config)`。MCP 连接由 Cordis Context 管理并随其释放。
