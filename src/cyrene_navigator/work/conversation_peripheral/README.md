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
receipt without dispatch. P9 Harness calls include the server-issued
`X-Cyrene-Work-Task-Id` and `Idempotency-Key`; the host accepts them only for an
actor-private Harness writer and an exact owned Task that is running. Direct
operation Tasks use `conversation-bili-operation`; scheduled reads use the
`conversation-bili-subscription-read` run plan. The server checks the persisted
Task owner, status, exact operation/account/target/argument digest, and the
server-issued key before attaching a WorkOperation. Its immutable
`trustedProducer` is set to `exchange-connector-dispatch` by the dedicated host
path, never by request JSON. Ordinary UI writes may remain taskless, but their
`taskId` stays null and they cannot prove a completed DSH Task.

Task-bound reads persist the safe projected result as an actor-private
`application/json` Work attachment and return only its `resultArtifact`
reference. The runtime fetches that attachment with the actor's Work credential,
checks the content type, canonical JSON bytes, and digest, then exposes the
result to the feature. The final `taskOutputSha256` is derived from the real
terminal Task by the Work receipt reader. Writes preserve only provider receipt
IDs, outcome codes, and verified platform readback digests; message bodies are
not stored. Grant preflight calls Exchange's existing HMAC grant endpoint and
does not consume or dispatch the grant; the actual operation obtains a fresh
grant immediately before dispatch.

本 package 将现有 Work 宿主接到固定媒体、语音、B站和备份端口；不拥有供应商凭据，也不建立并行任务状态。

`mount_peripheral_routes` 由 Work API owner 挂载。Principal 和 Workspace 范围来自 `principal_for`；
provider binding、issuer、audience、HMAC 密钥及 Exchange Product 授权均由服务端配置。媒体桥只接受
loopback、固定 bearer token 及有效签名调用方上下文。ActiveCallRegistry 会将精确参数和 request ID 绑定到
运行中的 Work Task 或 started Work Operation，并在每次读写时复验任务状态、来源授权版本、附件 MIME 与摘要；
附件仍保存在原有 actor/Workspace 存储中。

B站账号/档案、二维码、连接列表与连接器操作统一经 `ExchangeBilibiliHttpClient` 调用固定的内部 POST 路由，
使用 Navigator 原始请求体 HMAC；浏览器不提交 Exchange bearer。连接 DTO 只暴露 actor 自有的 `connectionRef` 与
对应精确 `profileRef`，不会自动选择账号。只读 `GET /bilibili/operations/by-idempotency-key` 仅返回已有 Work
回执，不会派发。P9 Harness 调用携带服务端签发的 `X-Cyrene-Work-Task-Id` 与 `Idempotency-Key`；宿主只接受
actor-private Harness writer，以及属于当前 actor、仍在运行且操作/账号/target/参数摘要/幂等键完全匹配的真实 Task。
直接操作 Task 来源为 `conversation-bili-operation`，订阅读取必须使用 domain 返回的
`conversation-bili-subscription-read` run plan。服务端专用路径设置不可伪造的
`trustedProducer=exchange-connector-dispatch`；请求 JSON 不能设置它。普通 UI 写操作仍可不绑定 Task，回执中的
`taskId` 会保持 null，不能作为 DSH 子任务完成证明。

Task-bound read 将安全投影写入 actor-private `application/json` Work 附件，响应只返回 `resultArtifact` 引用。
Runtime 使用 actor Work credential GET 附件，校验 content type、canonical JSON bytes 与 SHA-256 后才把结果交给 feature。
最终 `taskOutputSha256` 由 Work 回执读取器根据真实终态 Task 计算。写操作只保留供应商回执 ID、结果码及已验证的
平台回读摘要，不保存消息正文。Grant preflight 调用 Exchange 现有 HMAC grant endpoint，但不会消费 grant 或派发；
实际操作在派发前重新申请 fresh grant。
