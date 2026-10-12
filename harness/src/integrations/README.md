# Host integrations / 宿主集成

The cloud profile module loads bundled official MCP profiles, registers
discovered MCP tools with DSH, and exposes credential-free health through
`ctx.cloudConnections`. Google Cloud CLI access is a separate fixed readonly
argv adapter. Exchange issue tools use a separate typed Product REST client,
not MCP discovery or a generic HTTP tool. Read the linked docs before enabling
either integration.

云 profile 模块加载 Navigator 内置的官方 MCP 配置，将发现的 MCP 工具注册到 DSH，并通过
`ctx.cloudConnections` 暴露不含凭据的健康状态。Google Cloud CLI 使用独立的固定只读 argv
适配器。Exchange issue 工具使用独立的类型化 Product REST 客户端，不做 MCP 发现，也不暴露
通用 HTTP 工具。启用任一集成前请阅读对应文档。

| File | Responsibility / 职责 |
| --- | --- |
| `cloud-connections.ts` | Profile validation, MCP startup, health, and source-classified readonly workflow tools / 配置校验、MCP 启动、健康状态和按来源分类的只读工作流工具 |
| `exchange-integration.ts` | Typed Exchange issue client and four fixed DSH tools / 类型化 Exchange issue 客户端与四个固定 DSH 工具 |
| `index.ts` | Public package exports for cloud and Exchange integration / 云与 Exchange 集成的公开导出 |
| `../../contracts/exchange-integration-v1.lock.json` | Owner OpenAPI/catalog source digests and consumer-fixture pin / Owner OpenAPI/catalog 源摘要与 consumer fixture pin |
| `../../tests/exchange-integration-contract.tck.test.mjs` | Compare consumed routes, DTOs, state domains, and 202 Location against the owner fixture / 对照 owner fixture 校验路由、DTO、状态域与 202 Location |

Load profiles, then call `registerCloudConnections(ctx, config)` after DSH
ToolRuntime is mounted. MCP connection instances are owned by the Cordis
context and dispose with it.

先加载配置，再在 DSH ToolRuntime 挂载后调用
`registerCloudConnections(ctx, config)`。MCP 连接由 Cordis Context 管理并随其释放。

Configure Exchange tools with `CYRENE_EXCHANGE_INTEGRATION_URL` and the
host-owned `CYRENE_WORKSPACE_ID`. The host supplies a
`trustedUserBearerProvider(sessionId, workspaceId, signal)` that resolves the
current user's first-party Bearer for every request. General cloud runtimes
have no environment-token fallback and must inject that provider. The local
single-user CLI can opt in only when
`CYRENE_EXCHANGE_INTEGRATION_SESSION_ID` names the exact active DSH session;
the launcher binds it to the selected Workspace. The separate
`CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN` is read per request and never
persisted. `CYRENE_EXCHANGE_TOKEN` remains the model gateway credential and is
never used as a user identity. No first-party session Control Bridge is
implemented or proven yet (`NOT_RUN`).

The model sees only issue query, comment, state update, and operation read
tools. Query creates a read-only Exchange operation, polls briefly, and returns
cached issue fields only after Exchange reports `SUCCEEDED`; a pending result
contains only the operation reference. Comment and state calls use the existing
Navigator approval flow and report Exchange's 202 operation reference. Exchange
rechecks the Platform identity, operation grant, account binding, and delegation
before provider execution. Actor binding setup belongs to the non-AI management
surface. Navigator stores no Exchange sync rows or issue snapshots.

Exchange 工具通过 `CYRENE_EXCHANGE_INTEGRATION_URL` 与宿主管理的
`CYRENE_WORKSPACE_ID` 配置。宿主必须提供
`trustedUserBearerProvider(sessionId, workspaceId, signal)`，为每次请求解析当前用户的
first-party Bearer。通用云运行环境没有环境令牌回退，必须注入该 provider。本地单用户 CLI
只有在 `CYRENE_EXCHANGE_INTEGRATION_SESSION_ID` 指向当前精确的 DSH Session 时才可选择启用；
launcher 会将它绑定到已选 Workspace。独立变量
`CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN` 在每次请求时读取且不会持久化。
`CYRENE_EXCHANGE_TOKEN` 仍是模型网关凭据，不会被用于声明用户身份。当前尚无已实现或验证的
first-party session Control Bridge（`NOT_RUN`）。

模型仅能看到 issue 查询、评论、状态更新和 operation 查询工具。查询会在 Exchange 创建只读
operation、短暂轮询，并且只在 Exchange 返回 `SUCCEEDED` 后读取缓存 issue 字段；仍在等待的
结果只包含 operation 引用。评论和状态变更使用现有 Navigator 审批流程，并返回 Exchange 的
202 operation 引用。Exchange 在 Provider 执行前会重新验证 Platform 身份、操作授权、账号绑定
和 delegation。Actor binding 配置归非 AI 管理界面。Navigator 不保存 Exchange 同步行或 issue 快照。
