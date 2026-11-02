# Conversation knowledge bridge

Connects a trusted DSH turn to the Navigator knowledge routes that consume one
explicitly selected, published Catalyst knowledge package through the formal
`knowledge.search` ToolProvider.

| File | Responsibility |
|---|---|
| `bridge.ts` | Authenticated HTTP client, strict response decoding, and the context contribution that is only produced from a fresh allowed receipt. |
| `index.ts` | Stable entrypoint for the Harness host. |

The model supplies only `query`, `limit`, and a provider-issued `cursor`. The
package, library selector, principal references and purpose are fixed on the
server. Navigator rereads Catalyst before and after each signed search; call
`authorize` again immediately before injecting a page into context or sending a
reply, and hold the contribution when the receipt is denied. A stale package or
a revoked source returns a denied receipt, not a partial page.

BM25 ranking comes from the plugin and is not claimed to match the original
Aether retrieval ordering.

中文：本目录连接可信 DSH 回合与 Navigator 知识路由。模型只提供查询、条数和插件签发的游标；
知识包、library selector、主体与用途均由服务端固定。注入上下文或发送回复前再次调用
`authorize`，拒绝或 stale 时整体保留，不输出部分结果。BM25 排序与原项目检索不保证等价。
