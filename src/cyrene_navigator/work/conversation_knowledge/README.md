# Conversation knowledge

Consumes one explicitly selected, published Catalyst knowledge package through
the formal `knowledge.search` ToolProvider and returns cited hits.

| File | Responsibility |
|---|---|
| `catalyst_client.py` | Fixed, read-only, Workspace-bound Catalyst Product API client. |
| `provider.py` | Signed `knowledge.search` call over the Direct plugin runtime. |
| `service.py` | Fresh DatasetVersion check, search, and per-block policy recheck. |
| `factory.py` | `POST .../work/knowledge/search` and `.../authorize` routes. |
| `ports.py`, `models.py` | Host ports and strict wire models. |

The request body carries only the query, page size and a provider cursor. The
package, library selector, principal references and purpose are server-selected.
A stale DatasetVersion, a changed selection, or a block whose current policy no
longer allows `knowledge_retrieval` for the mapped principal is held, not
filtered. `authorize` returns a denial as a receipt so a caller can hold a
context contribution or reply. The host must supply the selection resolver and
principal-ref resolver; this package does not mount itself.

中文：只消费用户显式选定且已发布的 Catalyst 知识包。请求体只有查询文本；包、主体和用途由服务端决定。
stale、选择变化或来源策略撤权时整体保留，不做部分过滤。选择与主体映射解析器由宿主注入，本包不自行挂载。
