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
workspace-scoped; mutations require the current persistence writer authority
(`can_takeover`). QQ login routes also require the configured owner authority.
An object from a different organization or Workspace is returned as not found.

所有路由都需要已配置的 bearer 凭据。现有 persistence authenticator 必须授权路径中的
`{workspaceId}`。读取受 Workspace 限制；写入沿用当前 persistence writer 权限
（`can_takeover`）。QQ 登录路由还需要已配置的 owner 权限。其他组织或 Workspace
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
| `GET /tasks/{taskId}/events?after=0&limit=1000` | Read events after the exclusive sequence cursor. |
| `POST /tasks/{taskId}/events` | Append an event, optionally deduplicated by `messageId`. |

The executor record preserves these camelCase fields:

```json
{
  "id": "task-123",
  "workspaceId": "workspace-1",
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
`waiting_approval`, and `waiting_input`. A full TaskRecord also contains
`workspaceId`, `sequence`, `title`, `description`, and `metadata`. `output` and
`reasoning` are always strings. `startedAt`, `endedAt`, and `durationMs` are set
by the backend; callers cannot supply them. A queued task must use `/claim` to
enter `running`. Approval routes own entry to and release from
`waiting_approval`.

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
`waiting_approval` 和 `waiting_input`。完整 TaskRecord 还包含 `workspaceId`、
`sequence`、`title`、`description`、`metadata`。`output` 和 `reasoning` 始终是字符串；
时间戳和耗时由后端设置。queued 任务必须通过 `/claim` 开始执行；审批路由管理
`waiting_approval` 状态。事件消息 id 可用于安全重试；相同 id 但内容不同会返回 `409`。

## Approvals and operation receipts / 审批与操作回执

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /tasks/{taskId}/approvals` | `{ "kind":"external_write", "summary":"Publish the draft", "details":{}, "messageId":"approval-1" }` | `{ "approval":{...}, "task":{...}, "duplicate":false }` |
| `GET /approvals` or `GET /approvals/{approvalId}` | Optional list filters: `status`, `limit`. | Approval record(s). |
| `POST /approvals/{approvalId}/resolve` | `{ "decision":"approved", "messageId":"decision-1" }` | `{ "approval":{...}, "task":{...}, "duplicate":false }` |
| `POST /operations` | `{ "idempotencyKey":"publish-1", "operationType":"publish", "taskId":"task-123", "target":"draft/7", "request":{} }` | `{ "operation":{"status":"started",...}, "duplicate":false }` |
| `GET /operations/{operationId}` | — | `{ "operation":{...} }` |
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
| `GET /notifications?status=uncertain&limit=100` | Inspect outbox state, including unknown delivery. |
| `POST /notifications/claim` | Lease with `{ "workerId":"wecom-1", "limit":10, "leaseSeconds":60, "type":"wecom.message", "connectorId":"binding-1", "recipient":"bot:7/group/room-1" }`. Type/connector/recipient filters apply before leasing. |
| `POST /notifications/{notificationId}/start` | `{ "leaseToken":"..." }` immediately before attempting the remote send. |
| `POST /notifications/{notificationId}/finish` | `{ "leaseToken":"...", "outcome":"delivered", "result":{} }`; outcome is `delivered`, `failed`, or `uncertain`. |
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

## Connectors, QQ login, and workflows / 连接器、QQ 登录与工作流

| Method and path | Behavior |
| --- | --- |
| `GET /connectors` | Read persisted connector state. Configured bindings are seeded with `configured:true,status:"unknown"`; live health must be probed separately. |
| `POST /connectors/{connectorId}/status` | Update typed local connection status. |
| `POST /connectors/{connectorId}/events` | Idempotently record an inbound event and, optionally, a nested `task` in the same transaction. |
| `GET /connectors/{connectorId}/events?after=0` | Read connector event history. |
| `GET /connectors/{bindingId}/health` | Probe the launcher-configured QQ bridge; no bridge returns `503 QQ_HOST_NOT_CONFIGURED`. |
| `POST /connectors/{bindingId}/login/qr` | Request a QR from that trusted bridge; request body is empty. |
| `POST /connectors/{bindingId}/login/poll` | Poll `{ "loginId":"..." }`; account and host are taken from trusted launcher configuration. |
| `GET /tool-providers` | Discover configured `tool.provider.v1` bindings in this organization and Workspace. |
| `GET /tool-providers/{bindingId}/tools` | Read the installed provider's canonical tool catalog. |
| `POST /tool-providers/{bindingId}/tools/{toolId}/call` | Call with `{ "arguments":{} }`; host and credentials remain launcher-configured, and write calls require writer authority. |
| `GET /workflows` / `PUT /workflows/{workflowId}` | Read or replace versioned workflow memory, including optional UTC/IANA cron metadata. |
| `POST /schedule-events` / `GET /schedule-events` | Append/read safe workflow execution history. DSH owns all timer scheduling. |

Connector intake uses `{ "messageId":"msg-1", "type":"message.received", "accountId":"acct-1", "conversationId":"room-1", "senderId":"user-1", "payload":{}, "task":{"id":"stable-task-id","sessionId":"session-1","prompt":"...","metadata":{}} }`.
The response is `{ "eventId":"<uuid>", "duplicate":false, "receivedAt":1791050400000, "task":<TaskRecord> }`.
The `(organization, workspace, connector, messageId)` key deduplicates retries;
the event and nested task admission are atomic. A duplicate with changed content
returns `409`.

QQ bridge health/login calls use only the launcher-installed bridge keyed by
organization, Workspace, and binding. Browser inputs cannot select a host or account. QR payloads
are returned directly and are not stored in public memory.

连接器接纳请求可包含一个嵌套任务；事件与任务在同一事务写入。键
`(organization, workspace, connector, messageId)` 用于重试去重；相同 id 内容改变会返回
`409`。QQ 健康状态与登录只调用启动器按 Workspace 和 binding 安装的桥接器，浏览器不能
指定 host 或 account。QR 内容直接返回且不写入公共记忆。
