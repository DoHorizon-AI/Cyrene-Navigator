# Work Assistant API / 工作助手接口

This document defines the durable Work API mounted by the Navigator persistence
service. Work records use the same SQLite file as Harness persistence, but all
keys include the authenticated organization and Workspace. The service does not
send notifications itself; it records an outbox item for a configured adapter.

本文定义 Navigator 持久化服务提供的工作助手 API。工作记录与 Harness 持久化共用
SQLite 文件，但所有键都包含认证后的组织和 Workspace。服务自身不发送通知，只将通知
写入供适配器消费的 outbox。

The machine-readable contract is `contracts/product/v1/work.openapi.json`.
Regenerate it with `uv run python scripts/export-work-openapi.py` after an
intentional wire change; CI checks its paths and schemas against the service.

机器可读契约为 `contracts/product/v1/work.openapi.json`。有意修改线格式后，运行
`uv run python scripts/export-work-openapi.py` 更新；CI 会核对实际路径与 schema。

## Authentication and scope / 认证与范围

All routes require the configured bearer credential. The existing persistence
authenticator must grant access to the `{workspaceId}` in the path. Reads are
workspace-scoped; ordinary mutations require the current persistence writer
authority (`can_takeover`). The credential-health snapshot route instead
requires its explicit `can_publish_credential_health` service grant. QQ login
routes also require the configured owner authority.
An object from a different organization or Workspace is returned as not found.

Host-managed per-actor principals may set `actor_private_scope:true`. This
capability requires exactly one organization-scoped Workspace. New tasks,
memory facts, and attachments written by that principal receive immutable
server-side actor ownership; reads are filtered by the authenticated principal,
and unknown legacy owners are hidden. Existing shared tasks, curated memory
facts, and attachments remain visible to ordinary principals with the default
`actor_private_scope:false`. Verified Teams connector events and task records
are actor-filtered for every Work principal, including workspace owners.

所有路由都需要已配置的 bearer 凭据。现有 persistence authenticator 必须授权路径中的
`{workspaceId}`。读取受 Workspace 限制；普通写入沿用当前 persistence writer 权限
（`can_takeover`），凭据健康快照路由单独要求 `can_publish_credential_health` service grant。QQ 登录路由还需要已配置的 owner 权限。其他组织或 Workspace
中的对象按未找到处理。

The trusted executor principal also needs `can_write_harness:true` to persist
Harness sessions under its organization and Workspace. This grant is explicit:
Product read credentials remain read-only even when they have Work writer
authority. The local launcher grants it only to its generated owner principal.

可信执行器身份还需要显式配置 `can_write_harness:true`，才能在所属组织和 Workspace
内持久化 Harness 会话。Product 读取凭据即使具有 Work 写入权限，也不会自动获得
此授权。本地启动器只为自身生成的 owner 身份设置该权限。

## Executor tasks / 执行任务

Base path: `/api/v1/workspaces/{workspaceId}/work`.

| Method and path | Behavior |
| --- | --- |
| `POST /tasks` | Create or idempotently replay a task. `id` is optional and may be caller-selected. A repeated id with different content returns `409`. |
| `GET /tasks?limit=50&cursor=...` | List tasks with a stable cursor. |
| `GET /tasks/{taskId}` | Read one task. |
| `PATCH /tasks/{taskId}` | Update prompt/results and perform a valid state transition. Timestamps are server-owned. |
| `POST /tasks/{taskId}/claim` | Atomically claim only a `queued` task; exactly one caller receives `claimed:true`. |
| `POST /tasks/{taskId}/resume/check` | Verify that the current writer owns a paused source before Navigator uses its stored DSH session identity with Exchange; returns `204`. |
| `POST /tasks/{taskId}/resume` | Create an idempotent, read-only child from an owned task in `awaiting_user_authorization`; body contains only a new prompt. |
| `GET /tasks/{taskId}/events?after=0&limit=1000` | Read events after the exclusive sequence cursor. |
| `POST /tasks/{taskId}/events` | Append an event, optionally deduplicated by `messageId`. |

The executor record preserves these camelCase fields, including the
server-derived `createdByActorId` used by host actor clients to recover their
own tasks after restart:

```json
{
  "id": "task-123",
  "workspaceId": "workspace-1",
  "createdByActorId": "<authenticated-principal-actor>",
  "sessionId": "session-123",
  "prompt": "Summarize the report",
  "status": "queued",
  "createdAt": 1791050400000,
  "startedAt": null,
  "endedAt": null,
  "output": "",
  "reasoning": "",
  "error": null,
  "durationMs": 0,
  "sequence": 1,
  "title": null,
  "description": null,
  "metadata": {}
}
```

The supported statuses are `queued`, `running`, `completed`, `failed`, `aborted`,
`waiting_approval`, `waiting_input`, and `awaiting_user_authorization`. A TaskRecord also contains
`workspaceId`, `sequence`, `title`, `description`, `metadata`, `continuationOfTaskId`, and
`continuationMode`. The continuation fields are `null` for ordinary tasks. `output` and `reasoning`
are always strings. `startedAt`, `endedAt`, and `durationMs` are set
by the backend; callers cannot supply them. A queued task must use `/claim` to
enter `running`. Approval routes own entry to and release from
`waiting_approval`.

A continuation request requires `Idempotency-Key` and accepts only a prompt. The Work service
inherits the source session and derives the child link and `read_only` mode inside the same
SQLite transaction that creates the queued TaskRecord. The source task remains paused, and its
approvals are never copied. Navigator verifies the current Exchange principal and authorization
generation before calling this route; old persistence servers without the route fail closed.
Before contacting Exchange, Navigator calls `resume/check` with the configured persistence
principal so a task lookup cannot be used to probe Exchange under a foreign stored session.

事件追加请求和回执：

```json
{ "event": { "type": "executor.output", "text": "ready" }, "messageId": "output-1" }
```

```json
{
  "seq": 2,
  "event": { "type": "executor.output", "text": "ready" },
  "createdAt": 1791050400000,
  "duplicate": false,
  "task": {
    "id": "task-123", "workspaceId": "workspace-1", "sessionId": "session-123",
    "prompt": "Summarize the report", "status": "queued", "createdAt": 1791050400000,
    "startedAt": null, "endedAt": null, "output": "", "reasoning": "", "error": null,
    "durationMs": 0, "sequence": 2, "title": null, "description": null, "metadata": {}
  }
}
```

POST receipts include the persisted event timestamp as `createdAt`; a deduplicated
retry returns the original timestamp. GET returns
`{ "events": [{"seq":2,"event":{...},"createdAt":1791050400000,"messageId":"output-1"}], "nextSeq":3 }`.
Reusing a message id with different event content returns `409`.

状态只能使用 `queued`、`running`、`completed`、`failed`、`aborted`、
`waiting_approval`、`waiting_input` 和 `awaiting_user_authorization`。TaskRecord 还包含 `workspaceId`、
`sequence`、`title`、`description`、`metadata`、`continuationOfTaskId` 和 `continuationMode`。
普通任务的两个续接字段为 `null`；`output` 和 `reasoning` 始终是字符串；
时间戳和耗时由后端设置。queued 任务必须通过 `/claim` 开始执行；审批路由管理
`waiting_approval` 状态。事件消息 id 可用于安全重试；相同 id 但内容不同会返回 `409`。

续接请求必须带 `Idempotency-Key`，请求体只包含新提示词。Work 服务会在同一个 SQLite 事务中
从源任务继承 Session 并设置子任务关系与 `read_only` 模式，然后才让 queued TaskRecord 可见。
源任务保持暂停，原审批不会复制。Navigator 会先通过 Exchange 校验当前 principal 和授权世代；
不支持此路由的旧 persistence 服务会失败关闭。
在访问 Exchange 前，Navigator 先用当前 persistence principal 调用 `resume/check`，确认其拥有
暂停任务，避免用其他用户保存的 Session 身份查询 Exchange。

## Approvals and operation receipts / 审批与操作回执

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /tasks/{taskId}/approvals` | `{ "kind":"external_write", "summary":"Publish the draft", "details":{}, "messageId":"approval-1" }` | `{ "approval":{...}, "task":{...}, "duplicate":false }` |
| `GET /approvals` or `GET /approvals/{approvalId}` | Optional list filters: `status`, `limit`. | Approval record(s). |
| `POST /approvals/{approvalId}/resolve` | `{ "decision":"approved", "messageId":"decision-1" }` | `{ "approval":{...}, "task":{...}, "duplicate":false }` |
| `POST /operations` | `{ "idempotencyKey":"publish-1", "operationType":"publish", "taskId":"task-123", "target":"draft/7", "request":{} }` | `{ "operation":{"status":"started",...}, "duplicate":false }` |
| `GET /operations/{operationId}` | — | `{ "operation":{...} }` |
| `GET /operations/unresolved?target=<hash>&limit=100` | Read minimal `started`/`uncertain` receipts for an exact target; original provider arguments are not returned. |
| `PATCH /operations/{operationId}` | `{ "status":"verified", "evidence":{"remoteId":"r-7"} }` | `{ "operation":{...}, "duplicate":false }` |

When a model-callable operation includes `taskId`, the server requires that task
to be `running` in the same organization and Workspace within the operation
transaction. A terminal or approval-waiting task cannot begin another tool-side
operation. Human writer operations may omit `taskId`. An approval is correlated
with one task and can be resolved once. Repeating the
same `messageId` and decision is safe; a replay with another decision is
rejected. An operation receipt moves from `started` to `uncertain` or
`verified`; the API never retries the external side effect.

审批与一个任务关联且只能解析一次。相同 `messageId` 和决策可安全重放，不同决策会被
拒绝。操作回执从 `started` 变为 `uncertain` 或 `verified`；API 不会重试外部副作用。

## Human input / 人工输入

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /tasks/{taskId}/inputs` | `{ "summary":"Choose a release", "details":{"choices":["stable","preview"]}, "messageId":"input-request-1" }` | `{ "input":{...}, "task":{...}, "duplicate":false }`; atomically changes `running` to `waiting_input`. |
| `GET /inputs?status=pending&limit=100` | Optional `status=pending\|answered` and `limit=1..500`. | `{ "items":[...] }`. |
| `GET /inputs/{inputId}` | — | One input record. |
| `POST /inputs/{inputId}/resolve` | `{ "answer":{"text":"stable"}, "messageId":"input-answer-1" }` | `{ "input":{...}, "task":{...}, "duplicate":false }`; atomically changes `waiting_input` to `running`. |

Input records contain `id`, `taskId`, `summary`, `details`, `status`,
`createdAt`, `answeredAt`, `answeredBy`, `answer`, `messageId`, and
`answerMessageId`. Timestamps are epoch milliseconds. The human answer is stored
once with the authenticated actor and an event in task history. Replaying the
same message id and content returns the original receipt; an altered or second
answer is rejected. `answer.text` is limited to 4,000 characters, and nested
fields named for passwords, tokens, secrets, credentials, cookies, API/private
keys, authorization, or QR payloads are rejected.

输入记录包含以上字段；时间使用 epoch 毫秒。回答与认证用户和任务事件一并持久化。
相同消息 id 与内容可以安全重放，修改内容或再次回答会被拒绝。`answer.text` 最多
4,000 个字符；密码、令牌、密钥、凭据、Cookie、授权信息和 QR 内容字段会被拒绝。

## Memory and source snapshots / 记忆与来源快照

| Method and path | Request or query |
| --- | --- |
| `POST /memory/facts` | `{ "namespace":"project", "key":"release", "value":{"version":"1.2"}, "sourceId":"repo", "observedAt":1791050400000, "freshUntil":1791054000000 }` |
| `GET /memory/facts?includeStale=true&limit=500` | Read structured facts and freshness flags. |
| `POST /memory/query` | `{ "query":"release", "limit":20, "includeStale":false }` |
| `GET /sources` | Read source inventory status. |
| `GET /sources/{sourceId}/facts?includeMissing=false` | Read the last complete source facts. |
| `POST /sources/{sourceId}/inventory` | Submit one page: `{ "inventoryId":"scan-1", "pageToken":null, "nextPageToken":"next", "complete":false, "successful":true, "items":[{"key":"file/a","value":{"sha":"abc"}}] }`. |

Each inventory uses a contiguous page-token chain. Facts are staged until a
successful final page has `complete:true` and no next token. Failed or partial
inventories retain the previous snapshot and never mark omitted facts missing.

每次来源清单使用连续的 page token 链。事实先暂存，只有成功最终页满足
`complete:true` 且没有下一个 token 时才替换快照。失败或不完整的清单保留上个快照，
不会把未出现的事实标记为缺失。

## Notifications and attachments / 通知与附件

| Method and path | Behavior |
| --- | --- |
| `POST /notifications` | Enqueue `{ "deduplicationKey":"key-1", "type":"wecom.message", "connectorId":"binding-1", "recipient":"bot:7/group/room-1", "taskId":"task-123", "payload":{"text":"Hello"} }`; returns `{ "notification":{...}, "duplicate":false }`. |
| `POST /credential-health/snapshots` | Host-only endpoint accepting a bounded, secret-free Exchange health projection; atomically checkpoints incident state and writes credential notices to the same outbox. |
| `GET /notifications?status=uncertain&limit=100` | Inspect outbox state, including unknown delivery. |
| `POST /notifications/claim` | Lease with `{ "workerId":"wecom-1", "limit":10, "leaseSeconds":60, "type":"wecom.message", "connectorId":"binding-1", "recipient":"bot:7/group/room-1" }`. Type/connector/recipient filters apply before leasing. |
| `POST /private-notifications/claim` | The dedicated Teams installation bridge leases owner-private task messages or host-authored Microsoft Graph credential notices; the route comes from the verified personal installation. |
| `POST /notifications/{notificationId}/start` | `{ "leaseToken":"..." }` immediately before attempting the remote send. |
| `POST /notifications/{notificationId}/finish` | `{ "leaseToken":"...", "outcome":"delivered", "result":{} }`; outcome is `delivered`, `failed`, `uncertain`, or bounded `retry` with `retryAfterSeconds`. |
| `POST /attachments` | Upload `{ "name":"report.pdf", "mediaType":"application/pdf", "contentBase64":"..." }`; returns a content digest. |
| `GET /attachments/{sha256}` | Download only if the digest is registered in the authorized Workspace. |

When a model-callable notification includes `taskId`, the server requires that
task to be `running` in the same organization and Workspace before a new enqueue.
The transaction first checks an existing deduplication key: an exact replay of
type, payload, task, connector, and recipient returns the existing receipt even
after the task becomes terminal; any changed content conflicts. An unstarted
expired lease returns to `queued`. An expired `started` lease becomes `uncertain`
and is never resent automatically. WeCom task admission may
include this trusted route descriptor in `metadata.notification`:

```json
{
  "type": "wecom.message",
  "connectorId": "binding-1",
  "recipient": "bot:7/group/room-1",
  "payload": {
    "accountId": "account-7",
    "conversationId": "room-1",
    "chatType": "group",
    "senderId": "user-4"
  }
}
```

When that task reaches `completed`, `failed`, or `aborted`, the task transition
and a `task-result:{taskId}:{status}` notification are committed atomically. The
payload retains the route fields and adds bounded `text`, `taskId`, and `status`.
Only a configured adapter sends it; the store has no external-send callback.

带 `taskId` 的新通知仅可由运行中的同范围任务创建；同一去重键的精确请求重放即使任务
结束后也只返回现有回执，修改字段会冲突。未开始的过期租约会回到 `queued`。已开始
发送的过期租约会变成 `uncertain`，不会自动重发。WeCom 接纳任务可将可信路由写入
`metadata.notification`。任务进入
`completed`、`failed` 或 `aborted` 时，任务状态和 `task-result:{taskId}:{status}` 通知
在同一事务提交。路由字段保留，并增加有长度上限的 `text`、`taskId` 和 `status`。只有
已配置适配器会实际发送，Store 不执行外部发送。

The reserved `teams.credential-health` type cannot be enqueued through the
generic notification route or task metadata. `POST /credential-health/snapshots`
requires a configured principal with `can_publish_credential_health:true` and
organization scope. It accepts only Exchange authorization-health fields;
unknown fields, free-form errors, authorization references, tokens, and launch
URLs are rejected. The request's `organizationId` must exactly match the
authenticated principal. Checkpoint changes and outbox inserts share one transaction.
Fresh explicit `REAUTHORIZATION_REQUIRED` or `PERMISSION_DENIED` states open one
incident, repeat reminders are limited to once every 24 hours, and a valid state
closes the incident with one recovery notice. Unknown, unavailable, and stale
snapshots remain silent.

Microsoft Graph snapshots additionally require the host-derived `privateOwner`
projection (`actorAadObjectId`, `tenantId`, and `botAppId`). Navigator verifies
Exchange's `externalSubject` against the current Directory owner before
publishing it. Work queues Graph notices as `teams:owner-private`; the private
bridge resolves the active installation at lease time. A missing installation
keeps the notice queued with `WORK_TEAMS_PRIVATE_INSTALLATION_NOT_FOUND`. It is
never sent through the shared channel destination.

Credential notices reuse `work_notifications` but do not have a task, workflow
occurrence, or model-facing tool. Navigator reads Exchange's cached provider
snapshots on the existing Teams notification worker tick and uses the
host-mounted `TEAMS_CREDENTIAL_NOTIFICATIONS_CONFIG_FILE` to pin the connection
selectors, owner, dedicated Exchange notification profile, and Teams
destination. Existing non-Graph notices use that configured destination; Graph
notices use the owner-private installation route. Exchange remains the only
provider health poller and owns automatic refresh. Navigator does not call the
model or initiate credential renewal for this deterministic job.

系统保留类型 `teams.credential-health` 不能通过通用通知路由或任务 metadata 入队。
`POST /credential-health/snapshots` 只允许显式配置
`can_publish_credential_health:true` 且有组织范围的 principal。请求只接受 Exchange 授权健康字段；未知字段、自由文本错误、授权引用、令牌和授权启动 URL 都会被拒绝。请求中的 `organizationId` 必须与认证 principal 完全一致。健康检查点与 outbox 记录在同一事务中提交。最新的
`REAUTHORIZATION_REQUIRED` 或 `PERMISSION_DENIED` 会打开一个事件；重复提醒最多每 24 小时一次；授权恢复后关闭事件并发送一次恢复通知。未知、不可用和过期快照保持静默。

Microsoft Graph 快照还必须携带宿主推导的 `privateOwner` 投影
（`actorAadObjectId`、`tenantId`、`botAppId`）。Navigator 会在发布前验证 Exchange 的
`externalSubject` 与当前 Directory owner 一致。Work 将 Graph 告警排入
`teams:owner-private`；私聊 bridge 在租用时通过已验证的个人安装记录解析路由。安装缺失时保留
通知并记录 `WORK_TEAMS_PRIVATE_INSTALLATION_NOT_FOUND`，绝不回退到共享频道。

凭据通知复用 `work_notifications`，不关联任务、工作流发生记录或模型工具。Navigator 在现有 Teams 通知 worker tick 中读取 Exchange 已缓存快照，并使用宿主挂载的
`TEAMS_CREDENTIAL_NOTIFICATIONS_CONFIG_FILE` 固定连接选择器、owner、专用 Exchange 通知 profile 和 Teams 目标。现有非 Graph 告警使用该配置目标；Graph 告警使用 owner 私聊安装路由。Exchange 仍是唯一 provider 健康轮询器并负责自动刷新。Navigator 的这项确定性工作不会调用模型或发起凭据续期。

## Connectors, QQ login, and workflows / 连接器、QQ 登录与工作流

| Method and path | Behavior |
| --- | --- |
| `GET /connectors` | Read persisted connector state. Configured bindings are seeded with `configured:true,status:"unknown"`; live health must be probed separately. |
| `POST /connectors/{connectorId}/status` | Update typed local connection status. |
| `POST /connectors/{connectorId}/events` | Idempotently record an inbound event and, optionally, a nested `task` in the same transaction. |
| `GET /connectors/{connectorId}/events?after=0` | Read connector event history; Teams-origin events are filtered by verified actor. |
| `GET /connectors/{connectorId}/threads/{threadId}?exclude_message_id=...` | Read the caller's actor-specific Teams route/session and only that actor's messages, excluding the original current activity ID; an unmapped actor/thread pair returns `sessionId:null`. |
| `GET /connectors/{bindingId}/health` | Probe the launcher-configured QQ bridge; no bridge returns `503 QQ_HOST_NOT_CONFIGURED`. |
| `POST /connectors/{bindingId}/login/qr` | Request a QR from that trusted bridge; request body is empty. |
| `POST /connectors/{bindingId}/login/poll` | Poll `{ "loginId":"..." }`; account and host are taken from trusted launcher configuration. |
| `GET /tool-providers` | Discover configured `tool.provider.v1` bindings in this organization and Workspace. |
| `GET /tool-providers/{bindingId}/tools` | Read the installed provider's canonical tool catalog. |
| `POST /tool-providers/{bindingId}/tools/{toolId}/call` | Call with `{ "arguments":{} }`; host and credentials remain launcher-configured, and write calls require writer authority. |
| `GET /workflows` / `PUT /workflows/{workflowId}` | Read or replace versioned workflow memory, including optional UTC/IANA cron metadata. |
| `POST /schedule-events` / `GET /schedule-events` | Append/read safe workflow execution history. DSH owns all timer scheduling. |

Channel connector intake uses `{ "messageId":"msg-1", "type":"message.received", "accountId":"acct-1", "conversationId":"room-1", "senderId":"user-1", "payload":{}, "teamsThreadMessage":{"threadId":"<sha256>","messageId":"original-activity-id","serviceUrl":"https://smba.trafficmanager.net/emea/","tenantId":"...","teamId":"...","channelId":"...","conversationId":"...","rootThreadId":"...","actorIssuer":"...","actorSubject":"...","text":"...","sessionId":"session-1"}, "task":{"id":"stable-task-id","sessionId":"session-1","prompt":"...","metadata":{}} }`. Actor-private personal ingress uses the same event route with only `teamsPrivateMessage:{"messageId":"...","text":"..."}` plus an optional task. Work derives actor, tenant, and bot app from the actor-scoped bearer and fixed Teams policy, and requires a current owner-directory entry and active private installation. The private message body does not carry a recipient or route; Work stores an opaque origin key and excludes conversation ID and service URL from Task metadata. When a private Task is admitted, Work atomically queues a fixed generic owner-private acknowledgement; it contains no source text or client-selected recipient.
The response is `{ "eventId":"<uuid>", "duplicate":false, "receivedAt":1791050400000, "task":<TaskRecord> }`.
Verified Teams event retries use `(organization, workspace, connector, actor,
messageId)`; unscoped connector events retain one Workspace-wide key. The event
and nested task admission are atomic. An exact same-actor retry returns its
original receipt; changed content returns `409`. Two actors may receive the same
vendor activity ID without sharing a receipt or Task.

Teams activity text and stable route identifiers are committed with the event. A verified participant message can be stored without a task; a later authorized request may establish the DSH Session mapping in the same transaction as its task. The mapping key is a host-derived SHA-256 over tenant, team, channel, and root-thread IDs. Context lookup is Workspace-scoped, returns no display names, and accepts an `exclude_message_id` query so retries reproduce the original task prompt.

Teams intake uses a dedicated per-actor Work writer: the verified
`teamsThreadMessage.actorSubject` must equal the authenticated principal actor.
Work replaces `teamsCaller`, `teamsThread`, and notification route metadata from
the accepted envelope and records immutable origin provenance separately from
mutable task metadata. Task list/get/event and native session routes hide another
actor's Teams-origin records, including from `can_takeover` principals.

Legacy shared Tasks retain their Teams channel reply route. Tasks created with an immutable actor-private owner marker and verified Teams origin always enqueue terminal output through the owner-private outbox, ignoring mutable channel notification metadata. Ordinary channel claims cannot lease those rows. A missing private policy or active installation leaves the result queued with a durable `deliveryHoldCode`; the Task remains completed and Work never falls back to the source channel. `POST /notifications` cannot create a shared Teams message from an actor-private principal. Private claims resolve the actor's current installation immediately before delivery, so revocation stops a queued send. The same Navigator runtime dispatches the fixed `teams.credential-health` type through its separately configured owner identity and dedicated single-thread Exchange profile; neither its route nor its health status is model-selectable. It claims and starts the durable lease, obtains an exact Exchange connector grant, invokes Exchange, and records `delivered`, `failed`, or `uncertain`. Only a known HTTP 429 rate-limit outcome is retried; an uncertain Bot Framework send is never automatically replayed.

QQ bridge health/login calls use only the launcher-installed bridge keyed by
organization, Workspace, and binding. Browser inputs cannot select a host or account. QR payloads
are returned directly and are not stored in public memory.

连接器接纳请求可包含一个嵌套任务；事件与任务在同一事务写入。Teams channel 上的参与者消息继续作为线程上下文。actor-private 私聊只提交 `teamsPrivateMessage:{messageId,text}`；Work 从 actor token、当前 Directory 投影和 active installation 派生身份，不保存 conversation ID 或 service URL 到 Task metadata。Task 接纳后会原子加入固定的 owner-private 通用确认消息，不包含私聊正文或客户端收件人。
已验证的 Teams 事件按 `(organization, workspace, connector, actor, messageId)` 去重；无 actor 的通用连接事件仍使用 Workspace 范围键。相同 actor 的精确重试返回原回执；不同 actor 即使 vendor activity ID 相同也会分开保存。内容改变返回 `409`。
带不可变 actor-private owner 和 Teams origin 的任务结果只进入 owner-private outbox；channel notification metadata 不能改变目标。缺少 policy 或 active installation 时，投递保持 queued 并留下 `deliveryHoldCode`，不回退到来源 channel，也不撤销已完成的 Task。actor-private principal 的通用通知 API 不能创建 Teams channel 消息。旧的共享 Task 仍按原配置回复 channel。系统凭据通知使用独立固定 owner identity 与单线程 Exchange profile，模型不能选择状态或目标。发送结果未知时进入 `uncertain` 并禁止自动重放。QQ 健康状态与登录只调用启动器按 Workspace 和 binding 安装的桥接器，浏览器不能
指定 host 或 account。QR 内容直接返回且不写入公共记忆。

## Automation events, experiments, and source-poll V3 / 自动化事件、实验索引与 V3

`POST /automation-events` accepts a strict bounded event projection; actor,
organization, Workspace, visibility, event ID, observation time, and revision
are server-owned. `source`, `sourceEventId`, `resourceUri`, `sourceVersion`,
`eventType`, and integer `occurredAt` are required. Optional fields are bounded
title/summary/severity/correlation/experiment identifiers, semantic state, and
typed metadata references. Payloads contain references only; Work does not
resolve them or claim Product lifecycle authority. An identical
`(organization, workspace, actor, source, sourceEventId)` retry returns the
stored event with `duplicate:true`; changed content for that actor returns
`409`. Different actors may store the same provider `sourceEventId` in their
separate private streams. `GET
/automation-events?limit=50&cursor=...` lists only the authenticated actor's
events.

`POST /automation-events/{eventId}/notices` accepts only
`{workflowId,triggerId,occurrenceId,scheduledAt,taskId}`. Work verifies the
actor-owned event, V3 workflow, running ScheduleEvent, and immutable Task page
or source-error receipt before recording one durable event intent. It derives
the decision and text from stored event/state data. Failure, recovery, and
blocker notifications use the active private Teams installation; baselines and
unchanged events stay silent. Replaying an already-consumed event in a later
occurrence returns the original decision without creating another outbox item.

`GET /experiments/{experimentId}` and
`PUT /experiments/{experimentId}` expose an actor-owned Product lineage index,
not a lifecycle API. The body contains only typed references to dataset
versions, training runs/attempts, checkpoint artifacts, evaluation runs, model
versions, deployments, and Git commits, plus `expectedRevision`. Revision zero
creates; a changed write must match the current revision; stale writes return
`409`. Work never activates, deploys, promotes, or otherwise changes Product
lifecycle state.

`definitionVersion=3` negotiates typed, bounded `source_poll` workflows while
V1/V2 behavior remains unchanged. Sources are `github`, `azure_devops`,
`office_graph`, `vm_health`, `training`, and `product`; GitHub, Azure DevOps,
and Office Graph poll at five-minute UTC intervals, while VM health, training,
and Product poll at one-minute UTC intervals. The VM-health source uses the
host-bound `host_health` target kind. Targets are host-bound, page and
cursor-state sets have explicit limits. Incomplete pages retain `pageCursor`
and cannot advance watermarks or produce successful poll receipts; completed
windows clear `pageCursor` and may retain an opaque `resumeCursor` for the next
provider window. V3 source data requires
`authorization.kind="owner_private"` and
`notifications.destination.kind="owner_private"` because no per-source share
grant is configured.

The DSH scheduler owns polling and the weekday digest timer. The digest notice
route `POST /workflows/{workflowId}/notices` accepts only
`{occurrenceId,triggerId:"daily-digest",scheduledAt,taskId}`. Work verifies the
actor-salted occurrence and terminal Task/ScheduleEvent, then derives digest
text from complete changed V3 schedule receipts since the previous digest;
client-supplied summary text is not authoritative.

### Teams personal route binding / Teams 私聊路由绑定

Private installation events are accepted only on
`POST /private-installations/events` from a separate principal configured with
`can_bind_teams_private_conversations:true`. This principal cannot carry the
other persistence grants. Its token is referenced by
`CYRENE_PRIVATE_TEAMS_BRIDGE_TOKEN`. Work re-reads the host-configured owner
projection (`TEAMS_TASK_ACTOR_SUBJECTS_FILE`) on each bind, revoke, and route
resolution and pins Workspace, issuer, tenant, and bot application ID. Missing
or changed owner membership fails closed. The conversation ID and service URL
stay in private Work state; workflow JSON and event metadata cannot set a
private recipient. A dedicated private-notification claim returns the active
owner route only to that bridge. Each event must include the verified
Bot Framework `Activity.timestamp` as `trust.activityOccurredAt` in UTC; Work
stores its normalized millisecond value and rejects missing, malformed, or more
than five minutes future timestamps. Older add/remove events are recorded as
no-ops, and remove wins equal-timestamp ties. A verified remove is scoped by
actor, tenant, and bot app rather than conversation or service URL, so route
changes cannot prevent revocation. Existing installations without trusted event
time are disabled during migration; a timestamped remove followed by a newer
timestamped add establishes a fresh ordered binding. This registration route
does not enable personal message ingestion.

`actor_private_scope:true` is configured on per-actor host principals and
requires `can_takeover:true`, one organization, and one Workspace to use the
actor-owned automation and experiment routes. If the same principal writes
actor-private Harness sessions, it also requires the separate
`can_write_harness:true` grant. The private Teams bridge uses its own stable
non-human actor identity and separate token; it never receives `can_takeover`,
`can_write_harness`, or `actor_private_scope`.

私聊 installation 事件只接受 `/private-installations/events` 上由独立 principal 提交的事实。
该身份单独配置 `can_bind_teams_private_conversations:true`，不能同时拥有其他持久化 grant；其令牌来自
`CYRENE_PRIVATE_TEAMS_BRIDGE_TOKEN`。Work 每次绑定、撤销和路由解析都会重新读取
`TEAMS_TASK_ACTOR_SUBJECTS_FILE`，并固定 Workspace、issuer、tenant 和 bot app。缺少 owner 投影或成员变更时失败关闭。
conversation ID 与 service URL 只保存在私有 Work 状态；工作流和事件 metadata 不能指定私聊收件人。
专用 private-notification claim 只向该 bridge 返回 active owner 路由。每个事件都必须携带经验证的 Bot Framework
`Activity.timestamp`，对应 `trust.activityOccurredAt` UTC 字段；Work 以毫秒保存，缺失、无效或超前超过五分钟的时间戳都会被拒绝。
较早的 add/remove 会被记录为 no-op；时间相同时 remove 优先。remove 按 actor、tenant 和 bot app 撤销，不依赖 conversation 或 service URL
与旧值相同，因此路由变化不会阻止撤销。迁移时会停用缺少可信事件时间的旧安装；收到带时间戳的 remove 后，再收到更新的 add，才能建立新的有序绑定。
此注册路由本身不启用私聊消息接收。
