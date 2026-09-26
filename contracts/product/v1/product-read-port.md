# Navigator-local Product read port

`ProductReadPort` is a Navigator application port and test seam:

```text
read(configuredOwnerRequestUrl, traceparent) -> JSON object
```

It is not a Platform capability, cross-Product SPI, registration authority, or
contract that other Products implement. Its only consumers are Navigator
application code and tests. The HTTPX adapter enforces operator-configured base
URLs, forwards valid W3C trace context, applies finite timeouts, and returns the
owning Product's JSON without semantic rewriting. Transport and upstream RFC
9457 errors become Navigator observation problems only.

A future native-client adapter remains inside the same Navigator boundary. No
Product is required to depend on or implement this port.

## Workspace authentication and the read allowlist

The snapshot POST requires an incoming bearer mapped by the server to a
`PersistencePrincipal` with both an organization and the requested Workspace.
The same server-owned principal map is supplied to `create_app` and
`create_persistence_app`; the request body never selects its organization, and
the browser bearer is never forwarded to a Product.

Each outgoing credential is selected by the exact key
`(Product, organization_id, workspace_id)` from server-side secret
configuration. There is no Product-wide or cross-Workspace fallback. The
`HttpxProductReader` sends that value only as an `Authorization: Bearer` header.
Missing credentials produce an unavailable Product view without making an
upstream request.

Only these fixed GET operations are accepted. Query strings, arbitrary path
segments, public legacy routes, credential routes, and mutations are rejected:

| Product | Fixed read path |
| --- | --- |
| Catalyst | `/internal/workspace/v1/datasets` |
| Echo | `/internal/workspace/v1/evaluation-suites/{UUID}` |
| Exchange | `/api/v1/workspace/gateway-routes` |
| Reactor | `/internal/workspace/v1/model-imports` |
| Yield | `/internal/workspace/v1/training-drafts/{UUID}` |

Each identifier is one hyphenated UUID segment. The owner credential supplies
the organization and Workspace scope, so those values are not copied from a
`reads[].path` or a Product request body. Product base URLs are operator-owned,
must not embed credentials/query/fragment, and use HTTPS outside loopback
development. Redirects are not followed. Each upstream JSON response and the
aggregate snapshot are bounded to 4 MiB; oversized or invalid JSON becomes a
safe unavailable observation.

The response field `sourceUrl` is a stable logical provenance URI in the form
`cyrene://product/{owner}{privatePath}` (for example,
`cyrene://product/catalyst/internal/workspace/v1/datasets`). It does not expose
the configured service hostname and is not a navigation link.
---
<!-- Chinese Translation / 中文翻译 -->

# Navigator 本地 Product 读取端口

`ProductReadPort` 是 Navigator 的应用端口和测试接缝：

```text
read(configuredOwnerRequestUrl, traceparent) -> JSON object
```

它不是 Platform capability、跨 Product SPI、注册权威，也不是要求其他 Product 实现的契约。它只由 Navigator 应用代码和测试使用。HTTPX 适配器强制使用操作员配置的 base URL，转发有效的 W3C trace context，采用有限超时，并原样返回 owner Product 的 JSON，不做语义改写。传输错误和上游 RFC 9457 错误只会转换为 Navigator 的观测问题。

未来的原生客户端适配器仍属于同一 Navigator 边界；没有 Product 需要依赖或实现此端口。

## Workspace 认证与读取 allowlist

snapshot POST 要求入站 bearer 由服务端映射到同时具备 organization 和目标 Workspace 的
`PersistencePrincipal`。`create_app` 与 `create_persistence_app` 使用同一份服务端 principal
映射；请求体不能选择 organization，浏览器 bearer 也不会转发给 Product。

每个下游 credential 都按精确键
`(Product, organization_id, workspace_id)` 从服务端 secret 配置选择，不允许 Product
全局或跨 Workspace fallback。`HttpxProductReader` 仅将该值放入
`Authorization: Bearer` 标头。缺少凭据时对应 Product view 会标为 unavailable，且不会发出
上游请求。

只接受下表固定的 GET 操作。query、任意路径片段、公开 legacy 路由、凭据路由和变更请求都会被
拒绝：

| Product | 固定读取路径 |
| --- | --- |
| Catalyst | `/internal/workspace/v1/datasets` |
| Echo | `/internal/workspace/v1/evaluation-suites/{UUID}` |
| Exchange | `/api/v1/workspace/gateway-routes` |
| Reactor | `/internal/workspace/v1/model-imports` |
| Yield | `/internal/workspace/v1/training-drafts/{UUID}` |

每个 identifier 都是单个带连字符的 UUID 路径片段。owner credential 提供 organization
和 Workspace scope，因此这些值不会从 `reads[].path` 或 Product 请求体复制。Product base URL
由操作员配置，不得嵌入 credentials/query/fragment；除 loopback 开发外必须使用 HTTPS。不跟随
redirect。每个上游 JSON response 和聚合 snapshot 都限制为 4 MiB；超限或无效 JSON 会成为安全的
unavailable observation。

响应字段 `sourceUrl` 使用稳定的逻辑来源 URI：`cyrene://product/{owner}{privatePath}`（例如
`cyrene://product/catalyst/internal/workspace/v1/datasets`）。它不会暴露配置的 service hostname，
也不是导航链接。
