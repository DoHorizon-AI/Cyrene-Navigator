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
| exchange-authorization.ts | Actor-scoped Exchange authorization health, approved renewal sessions, and cached cloud reads / 调用者隔离的授权健康、审批续期和云资源缓存读取 |
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

Authorization integration adds five fixed tools: exchange_connections_list,
exchange_authorization_health, exchange_reauthorization_start,
exchange_reauthorization_status, and exchange_cloud_resources_query. Connection,
health, and resource reads use the actual DSH
session's current user Bearer and configured Workspace. Renewal start accepts
only a recent authorization reference returned by that same session's scoped
health read. HF device-code renewal starts a fixed-scope challenge after an
explicit user request; its official verification URL and bounded user code are
returned to that session, while HF still requires the user to enter the code and
consent on its official page. Other providers still wait for Navigator's
existing human approval before sending an empty typed Product request with
Idempotency-Key. Other browser authorization URLs and QR attachment references
stay out of model results. The resource tool reads
Exchange's latest projection. Exchange owns provider polling, comparison, and
automatic refresh; when host credential notifications are opted in, Navigator
reads those cached snapshots on its existing Teams notification tick and
records incident/recovery notices in the durable Work outbox. The monitor does
not initiate renewal or create model tasks.
The connection-list tool returns Product-generated connection IDs with only
provider, display, repository, enabled, and timestamp fields. Binding, target,
account, actor, and tenant references do not enter the model surface.

Only HTTP 409 with Product code
EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED enters durable
awaiting_user_authorization. Structured connection and native authorization
references are verified against a fresh health read before continuation. A
first-party 401, generic 403, network failure, unknown health, and Platform
AWAITING_AUTHORITY remain separate outcomes.

After health returns PRESENT and VALID at a newer generation, Client can make
POST /api/v1/tasks/{taskId}/resume with only a new bounded prompt and
Idempotency-Key. Navigator creates a new task linked to the paused task and
original DSH session. The old prompt and approvals are not replayed. The new
task is atomically marked continuationMode=read_only before queue visibility;
the executor allows only its fixed read-only tools. Unknown, in-flight, or
unrecorded Exchange writes prevent continuation until an operator reconciles
them. Navigator does not claim a DSH checkpoint or automatically replay a
claimed turn.

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

授权集成额外提供五个固定工具：exchange_connections_list、
exchange_authorization_health、exchange_reauthorization_start、
exchange_reauthorization_status 和 exchange_cloud_resources_query。连接列表、健康与资源读取使用当前 DSH Session 的 user Bearer 及宿主配置的
Workspace。续期启动只接受同一 Session 最近一次受范围保护的健康查询返回的授权引用。HF device-code
续期在用户明确要求后启动固定 scope 的 challenge，将官方验证地址和有界一次性 code 返回该 Session；HF 仍要求
用户在其官方页面输入 code 并同意。其他 Provider 在发送无请求体、带 Idempotency-Key 的 Product 请求前
继续等待 Navigator 现有人工审批。其他浏览器授权 URL 与二维码附件引用不会进入模型结果。资源工具只读取
Exchange 最新投影。Exchange 负责 provider
轮询、比较和自动刷新；启用宿主凭据通知后，Navigator 在现有 Teams 通知 tick 中读取缓存快照，并把
事件／恢复通知写入持久 Work outbox。该监控不会发起续期或创建模型任务。
连接列表只返回 Product 生成的连接 ID 及 Provider、显示名、仓库、启用状态和时间戳；模型看不到
binding、target、account、actor 或 tenant 引用。

只有 HTTP 409 且 Product code 为
EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED 才会进入持久状态
awaiting_user_authorization。结构化连接及原生授权引用会先通过新的健康查询再次校验，才能用于续接。
first-party 401、一般 403、网络错误、未知健康状态和 Platform AWAITING_AUTHORITY 是不同结果。

健康状态在更新世代返回 PRESENT 与 VALID 后，Client 可以显式调用
POST /api/v1/tasks/{taskId}/resume，请求只包含有界的新提示词和 Idempotency-Key。Navigator
会创建链接到暂停任务及原 DSH Session 的新任务，不会重放原提示词或旧审批。新任务在进入队列前
原子标记 continuationMode=read_only；执行器只开放固定只读工具。Exchange 写操作未知、仍在运行或
没有回执时，必须由操作员核对后再续接。Navigator 不声称 DSH 提供了检查点，也不会自动重放已认领的回合。
