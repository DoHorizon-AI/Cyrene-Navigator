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
valid signed caller context. Its ActiveCallRegistry binds the exact arguments
and request ID to a running Work Task or started Work Operation, then rechecks
task state, source authorization epoch, attachment MIME, and digest on every
read/write. Work attachments remain in the existing actor/workspace store.

Bilibili account/profile, QR, connection-list, and connector-operation calls use
`ExchangeBilibiliHttpClient`. It sends only fixed internal POST routes with the
Navigator raw-body HMAC signer; the browser never supplies an Exchange bearer,
connection metadata exposes only the actor-owned `connectionRef` and its exact
`profileRef`, with no automatic account selection. The read-only
`GET /bilibili/operations/by-idempotency-key` route returns an existing Work
receipt without dispatch; Bilibili writes reuse a caller-stable logical key
scoped to the authenticated actor and persist WorkOperation before Exchange
dispatch. Connector
operations use Exchange's one-use Directory grant and Account Center lease.
Write receipts persist only provider receipt IDs, outcome codes, and verified
readback digests.

本 package 将现有 Work 宿主接到固定媒体、语音、B站和备份端口；不拥有供应商凭据，也不建立并行任务状态。

`mount_peripheral_routes` 由 Work API owner 挂载。Principal 和 Workspace 范围来自 `principal_for`；
provider binding、issuer、audience、HMAC 密钥及 Exchange Product 授权均由服务端配置。媒体桥只接受
loopback、固定 bearer token 及有效签名调用方上下文。ActiveCallRegistry 会将精确参数和 request ID 绑定到
运行中的 Work Task 或 started Work Operation，并在每次读写时复验任务状态、来源授权版本、附件 MIME 与摘要；
附件仍保存在原有 actor/Workspace 存储中。

B站账号/档案、二维码、连接列表与连接器操作统一经 `ExchangeBilibiliHttpClient` 调用固定的内部 POST 路由，
使用 Navigator 原始请求体 HMAC；浏览器不提交 Exchange bearer。连接 DTO 只暴露 actor 自有的 `connectionRef` 与
对应精确 `profileRef`，不会自动选择账号。只读 `GET /bilibili/operations/by-idempotency-key` 仅返回已有 Work
回执，不会派发；B站写操作复用由当前 actor 范围化的稳定逻辑幂等键，并在 Exchange 派发前保存 WorkOperation。
Connector operation 由 Exchange 生成一次性 Directory grant 并创建 Account Center credential lease。写入回执只保存
供应商回执 ID、结果码及已验证回读摘要。
