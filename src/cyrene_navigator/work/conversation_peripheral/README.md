# Conversation Peripheral Routes

This package adapts the existing Work host to fixed media, speech, Bilibili,
and backup ports. It owns no provider credentials or parallel task state.

| File | Responsibility |
|---|---|
| `models.py` | Strict camelCase request and response DTOs. |
| `ports.py` | Host-injected bindings, signer, Product profile, backup, and artifact interfaces. |
| `routes.py` | Authenticated Work routes and the loopback Work artifact bridge. |

`mount_peripheral_routes` is mounted by the Work API owner. Principal identity
and workspace scope come from `principal_for`; provider bindings, issuer,
audience, HMAC keys, and Exchange Product authorization are server configured.
The media bridge accepts only loopback requests with a fixed bearer token and a
valid signed caller context. Work attachments are resolved by digest inside the
exact organization, Workspace, and actor scope.

Bilibili account/profile, QR, connection-list, and connector-operation calls use
`ExchangeBilibiliHttpClient`. It sends only fixed internal POST routes with the
Navigator raw-body HMAC signer; the browser never supplies an Exchange bearer,
connection metadata is filtered before reaching the Client, and connector
operations use Exchange's one-use Directory grant and Account Center lease.
Write receipts persist only provider receipt IDs, outcome codes, and verified
readback digests.

本 package 将现有 Work 宿主接到固定媒体、语音、B站和备份端口；不拥有供应商凭据，也不建立并行任务状态。

`mount_peripheral_routes` 由 Work API owner 挂载。Principal 和 Workspace 范围来自 `principal_for`；
provider binding、issuer、audience、HMAC 密钥及 Exchange Product 授权均由服务端配置。媒体桥只接受
loopback、固定 bearer token 及有效签名调用方上下文，并在组织、Workspace、actor 的精确范围内按摘要读取附件。

B站账号/档案、二维码、连接列表与连接器操作统一经 `ExchangeBilibiliHttpClient` 调用固定的内部 POST 路由，
使用 Navigator 原始请求体 HMAC；浏览器不提交 Exchange bearer。连接元数据先经过筛选，Connector operation
由 Exchange 生成一次性 Directory grant 并创建 Account Center credential lease。写入回执只保存供应商回执 ID、
结果码及已验证回读摘要。
