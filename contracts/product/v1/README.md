# Navigator client aggregation contract v1

Status: `HEADLESS_MVP_READY`; real HTTP fan-out is implemented, while browser
and native-client adapters remain separate boundaries.

Navigator owns the bounded Product snapshot aggregation API, not the client
application presentation or Product resource state. `Cyrene-Client` consumes
this API and owns the primary user-facing presentation.
`WorkspaceSnapshot` is an observed view produced on demand; it is neither
durable authority nor an event-sourced projection.

## Boundary

- Configured Product base URLs are operator-owned directory data.
- Each `ProductView` preserves `product`, the fixed non-navigable
  `sourceOperation` provenance label, `observedAt`, and a closed
  `resourceSummary` with the canonical JSON digest and byte length. Raw owner
  JSON remains inside Navigator and is not returned by the snapshot API.
- Navigator never changes Product state labels, infers readiness, or converts a
  provider/package/binding into Product identity.
- A remote error becomes an `UNAVAILABLE` view with a typed observation problem;
  healthy Product views remain usable and the snapshot becomes `PARTIAL`.
- Mutations are not accepted. A future UI action must forward a typed command to
  the owning Product API.
- W3C `traceparent` and optional `tracestate` are propagated to each Product
  request when the incoming trace identity is valid.
- `ProductReadPort` is a Navigator-local application/test seam. It is not a
  global Product SPI and no other Product implements it.

## Notifications

Navigator emits no Product lifecycle events because `WorkspaceSnapshot` is an
ephemeral query result. It may emit OpenTelemetry spans/metrics, but those never
become Product notifications or durable state. UI actions must send commands to
the owning Product, whose notification catalog remains authoritative.

## Compatibility

The aggregation API is `/api/v1`, OpenAPI 3.1.2, and JSON Schema Draft 2020-12;
it consumes the Workspace `product-http-v1` compatibility profile.
The POST is a safe, non-mutating query chosen only because the read set is a
structured body; it does not use `Idempotency-Key` or create a resource.

Deprecation, migration window, and removal follow the common profile.
Reinterpreting owner state or changing partial-failure semantics requires v2.
---
<!-- Chinese Translation / 中文翻译 -->

# Navigator 客户端聚合契约 v1

状态为 `HEADLESS_MVP_READY`：已实现真实 HTTP fan-out；浏览器和原生客户端适配器仍是独立边界。

Navigator 拥有受限的 Product 快照聚合 API，不拥有客户端应用展示层或 Product 资源状态。`Cyrene-Client` 消费此 API 并拥有主要面向用户的展示层。`WorkspaceSnapshot` 是按需生成的观测视图，既不是持久化权威，也不是事件溯源投影。

## 边界

- 已配置的 Product base URL 是由操作员拥有的目录数据。
- 每个 `ProductView` 都保留 `product`、固定且不可导航的 `sourceOperation` 来源标签、`observedAt` 和封闭的
  `resourceSummary`（规范 JSON digest 与字节长度）。snapshot API 不会返回原始 owner JSON。
- Navigator 不会改变 Product 状态标签、推断就绪状态，也不会把 Provider/包/binding 转换为 Product 身份。
- 远端错误会成为带类型化观测问题的 `UNAVAILABLE` view；健康的 Product view 仍可使用，snapshot 状态则变为 `PARTIAL`。
- 不接受变更请求。未来 UI 操作必须把类型化命令转发给所属 Product API。
- 入站 trace identity 有效时，会将 W3C `traceparent` 和可选 `tracestate` 传递给每个 Product 请求。
- `ProductReadPort` 是 Navigator 本地的应用/测试接缝，不是全局 Product SPI，也没有其他 Product 实现它。

## 通知

由于 `WorkspaceSnapshot` 是临时查询结果，Navigator 不发布 Product 生命周期事件。它可以生成 OpenTelemetry span/metric，但这些不会成为 Product 通知或持久化状态。UI 操作必须向所属 Product 发送命令，通知目录仍由该 Product 负责。

## 兼容性

聚合 API 根路径为 `/api/v1`，使用 OpenAPI 3.1.2 和 JSON Schema Draft 2020-12，并遵循 Workspace 的 `product-http-v1` 兼容配置文件。POST 仅因读取集合是结构化请求体才被选用；它是安全的非变更查询，不使用 `Idempotency-Key`，也不创建资源。

弃用、迁移窗口和移除遵循通用配置文件。重新解释 owner 状态或改变部分失败语义需要升至 v2。

## Product operation catalog v2

This Product publishes its Workspace operation catalog at
[../v2/catalog.json](../v2/catalog.json). Each listed operation binds its exact
owner operationId to the corresponding OpenAPI source and schema pointers.
The release manifest pins the catalog and its complete OpenAPI reference closure
to the same repository commit. This catalog declares operation contracts only;
Workspace policy controls access independently.

本 Product 在 [../v2/catalog.json](../v2/catalog.json) 发布 Workspace 操作目录。每个目录项都将准确的 owner operationId 绑定到对应的 OpenAPI 文档和 schema pointer。发布清单会将目录及其完整 OpenAPI 引用闭包固定到同一仓库提交。目录只声明操作契约；访问权限由独立的 Workspace policy 控制。
