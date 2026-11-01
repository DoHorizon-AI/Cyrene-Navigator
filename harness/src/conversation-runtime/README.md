# Conversation Runtime Adapters / 对话运行时适配器

This module connects DSH research features to the authenticated Work API. It
uses a host-fixed Work origin and actor credential resolver, paginates the
current conversation history, rechecks source and attachment authorization,
then calls the server research route for a configured Public Web binding. It
does not accept endpoints, credentials, task identities, source identities, or
provider selection from model arguments.

本模块将 DSH 研究功能连接到经过认证的 Work API。它使用宿主固定的 Work 地址和 actor 凭据解析器，
分页读取当前会话历史、重新校验来源及附件授权，再调用服务端研究路由执行已配置的公网工具绑定。
模型参数不能指定 endpoint、凭据、Task 身份、来源身份或 provider。

| File | Responsibility / 职责 |
| --- | --- |
| `work-client.ts` | Fixed-origin, actor-scoped Work HTTP client with bounded JSON and pagination. / 固定地址、actor隔离的Work HTTP客户端及有界分页。 |
| `research-provider.ts` | Concrete ResearchRead provider with current lineage and authorized attachment discovery. / 具备当前来源lineage和附件授权读取的ResearchRead provider。 |
| `bilibili-adapters.ts` | Exact owned-account resolution and typed Work delegation/subscription clients. / 精确账户绑定解析及类型化Work委托、订阅客户端。 |
| `index.ts` | Public exports for host composition. / 宿主装配使用的公开导出。 |

Tests use local HTTP/Work fixtures and are labeled `SIMULATED`. They verify
host-side adapter behavior; only the WSL acceptance harness can establish a
real Work server and DirectPluginRuntime end-to-end result.

测试使用本地HTTP/Work fixture并标记为 `SIMULATED`，仅验证宿主适配器行为；真实Work服务与
DirectPluginRuntime的端到端结果由WSL验收harness记录。
