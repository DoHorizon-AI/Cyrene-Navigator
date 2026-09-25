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
---
<!-- Chinese Translation / 中文翻译 -->

## 持久化边界与部署

本包是 Cyrene 自有的持久化后端，供固定版本的 DeepSeek Harness Session service 使用。它在 SQLite 中保存上游 v2 `SessionHeader` 和只追加的原始 event envelope；不会创建第二套消息历史、重放词汇表或 Agent Loop。

HTTP app 由 `create_persistence_app(db_path, principals, lease_seconds=120)` 创建。`principals` 映射是 Phase 0 Bearer token 配置：token 只对配置的 Workspace ID 生效，writer capability 通过 epoch 和服务端 lease 进行 fencing。SSO 和 RBAC 集成留待后续 Workspace/Identity 阶段。

服务使用 SQLite WAL 和 `synchronous=FULL`。每次变更使用 `BEGIN IMMEDIATE` 预留 writer，校验完整且连续的 batch，并只在事务提交后确认。数据库只保存每个 writer token 的 SHA-256 哈希。同 epoch、同 batch 的重试是幂等的；batch ID 相同但 body 不同则会被拒绝。

Product metadata 是同一数据库中的独立读取投影，通过 Session snapshot 的 `productMetadata` 和经过认证的 metadata GET 路由公开。新 Session 会将可信 principal 同时记录为 `creatorActorId` 与初始 `ownerActorId`，并记录 `metadataVersion`、`source: "cyrene"` 和服务端时间戳。`sessions.owner_actor_id` 列仍表示可变 writer lease owner；接管与释放不会更新 Product 投影。这让 Harness 只有一份可写事件日志，同时避免把 writer fencing 声称为 Conversation 所有权。

Metadata 表在现有 SQLite 初始化事务中幂等创建并回填。缺失的历史身份会保持显式状态，必须由未来经过认证的 Product 操作解决。本 Phase 0 接口不会增加标题、共享、标签、RBAC 或 metadata 变更路由。

不会将 `uvicorn` 加为包依赖。部署 runner 应通过 factory 创建 app，并交给现有 ASGI server。TypeScript Harness 适配器仍负责校验上游 event 词汇，并将 service snapshot 的 `meta` 字段投影到上游 `header` 字段。
