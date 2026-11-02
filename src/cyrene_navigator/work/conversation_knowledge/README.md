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

## Enabling the routes

Set `CYRENE_NAVIGATOR_KNOWLEDGE_CONFIG` to a JSON file owned by the operator
(`serve-persistence.py` reads it at startup and stops if it is unusable). The
routes do not exist when it is unset. Secrets are referenced by environment
variable name, never written in the file.

```json
{
  "catalyst": {
    "baseUrl": "https://catalyst.internal.example",
    "bearerEnv": "CYRENE_KNOWLEDGE_CATALYST_BEARER",
    "organizationId": "org-a",
    "workspaceId": "workspace-a"
  },
  "tool": {
    "connectionRef": "grpc://127.0.0.1:51030",
    "bindingId": "knowledge-binding",
    "callerWorkload": "navigator-knowledge",
    "audience": "cyrene.plugins.knowledge-retrieval",
    "issuer": "cyrene://navigator",
    "signingKeyEnv": "CYRENE_KNOWLEDGE_SIGNING_KEY"
  },
  "selections": [
    {
      "actorId": "<actor id>",
      "librarySelector": "handbook",
      "datasetId": "<Catalyst Dataset UUID>",
      "datasetVersionId": "<published DatasetVersion UUID>"
    }
  ],
  "principalRefs": { "<actor id>": ["<principal ref the plugin maps this actor to>"] }
}
```

`selections` and `principalRefs` are static: one package per actor, and the refs must
be the same identity mapping the `knowledge-retrieval` plugin binding uses. A
self-service package picker is a separate change.

中文：设置 `CYRENE_NAVIGATOR_KNOWLEDGE_CONFIG` 指向运维编写的 JSON 后才会挂载路由；文件不可用时启动失败。
密钥只按环境变量名引用。`selections` 与 `principalRefs` 是静态配置，主体映射必须与检索插件绑定一致。
