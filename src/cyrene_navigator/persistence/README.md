# Navigator persistence backend

This package is the Cyrene-owned persistence backend for the pinned DeepSeek
Harness Session service. It stores the upstream v2 `SessionHeader` and raw
append-only event envelopes in SQLite; it does not create a second message
history, replay vocabulary, or Agent Loop.

The HTTP factory is `create_persistence_app(db_path, principals,
lease_seconds=120)`. The `principals` mapping is a Phase 0 bearer-token
configuration: tokens are accepted only for the configured Workspace IDs and
writer capabilities are fenced by an epoch and a server-side lease. SSO and
RBAC integration remain Workspace/Identity work for a later phase.

The service uses SQLite WAL with `synchronous=FULL`. Each mutation reserves the
writer with `BEGIN IMMEDIATE`, validates a complete contiguous batch, and only
acknowledges it after the transaction commits. The database stores only a
SHA-256 hash of each writer token. A same-epoch, same-batch retry is idempotent;
the same batch ID with a different body is rejected.

Product metadata is a separate read projection in the same database, exposed in
`productMetadata` on a session snapshot and through the authenticated
`GET /api/v1/harness/workspaces/{workspace_id}/sessions/{session_id}/metadata`
route. New sessions record the trusted principal as both `creatorActorId` and
the initial `ownerActorId`, together with `metadataVersion`, `source: "cyrene"`
and a server timestamp. The `sessions.owner_actor_id` column remains the
mutable writer lease owner; takeover and release never update the Product
projection. This keeps one writable Harness event log without making writer
fencing a Conversation ownership claim.

产品元数据与事件日志位于同一个数据库，但使用独立的只读投影：会话快照中的
`productMetadata` 和经过认证的 metadata GET 接口都读取这份投影。新会话使用受信
principal 写入稳定的 creator/owner。旧数据库启动时只补充
`source: "legacy"`、`ownerState: "unknown"` 的记录，不从旧的可变 writer 推断产品
owner。`sessions.owner_actor_id` 仍然只表示 writer lease，接管和释放不会改变产品
元数据，因此没有第二份可写消息历史。

The metadata table is created and backfilled idempotently during the existing
SQLite initialization transaction. Missing legacy identity stays explicit and
must be resolved by a future authenticated Product operation; this Phase 0
surface does not add titles, sharing, tags, RBAC, or metadata mutation routes.

元数据表在现有 SQLite 初始化事务中以幂等方式创建和回填。历史身份缺失会一直显式保留
为 unknown，等待未来经过认证的产品操作；本阶段不增加标题、共享、标签、RBAC 或元数据
变更接口。

`uvicorn` is intentionally not added as a package dependency. A deployment
runner should construct the app through the factory and pass it to an existing
ASGI server. The TypeScript Harness adapter remains the owner of upstream event
vocabulary validation and projects the service's `meta` snapshot field to the
upstream `header` field.
