# Offline Conversation Import and Restore / 离线对话导入与恢复

## Scope / 范围

The service accepts only host-resolved artifacts and an `ActorScope` built from the authenticated `PersistencePrincipal`. Archive identity, workspace, actor, approval state, principal grants, and task state are never used to choose the destination scope. The host resolves every source conversation/persona to an authorized target and rechecks current source lineage before each projection. This package never reads an arbitrary filesystem path.

服务只接受宿主解析后的制品，以及由已认证 `PersistencePrincipal` 构造的 `ActorScope`。归档中的身份、workspace、actor、审批状态、principal grants 与任务状态不能决定目标 scope。宿主必须把每个来源会话/人格解析到当前获准的目标，并在每次投影前重新检查来源链。本包不读取任意文件路径。

The service has no route of its own. The Navigator core owner adapts Work attachment reads, Work Task checkpoint events, and Work Operations to the ports in `ports.py`. Use the same Work Task for progress and recovery; do not add a migration-specific SQL table. A successful `preview` is read-only. `apply` requires host approval bound to its exact plan digest.

本服务不自行挂载路由。Navigator core owner 负责把 Work 附件读取、Work Task 检查点事件和 Work Operation 适配到 `ports.py`。进度与恢复复用同一个 Work Task，不增加迁移专用 SQL 表。`preview` 只读；`apply` 必须有绑定精确 plan digest 的宿主审批。

## Portable source formats / 便携来源格式

Historical input is UTF-8 JSONL. Its first line has exactly `recordType`, `schemaVersion: 1`, `sourceKind`, and `recordCount`. Data rows use one of four closed record types: `message`, `memory`, `profile`, or `graph`. Every non-message record names earlier `sourceRecordIds`; a row cannot introduce an actor, identity, credential, login state, authorization grant, approval, or running task. Graph edges must terminate at nodes in the same changeset. Unknown fields, duplicate JSON keys, non-finite numbers, oversized lines, cycles, and missing lineage become count-only quarantines or fail the archive header closed.

历史导入文件使用 UTF-8 JSONL。首行字段严格限定为 `recordType`、`schemaVersion: 1`、`sourceKind` 和 `recordCount`。数据行使用四种封闭类型：`message`、`memory`、`profile`、`graph`。除 message 外，每行都必须引用此前出现的 `sourceRecordIds`。归档不能定义 actor、身份、凭据、登录态、授权 grant、审批或执行中任务。图谱边必须连接同一 changeset 中的节点。未知字段、重复 JSON key、非有限数字、超大行、循环或缺失来源会被仅计数隔离，或使归档头 fail closed。

The backup format is `cyrene.navigator.conversation-backup.v1`. It contains only active conversation messages and memories, profile candidates, active profiles converted back into candidates, and graph changesets. It omits source grants and derived SQL join rows, attachment references, maintenance jobs, import staging, and unrelated domain records. Restore does not trust an archived profile's active state or a graph provider receipt. Profiles remain candidates unless the host supplies a separate current approval. A graph becomes projected only after the real graph provider writes and independently reads back the exact digest and node/edge counts.

备份格式为 `cyrene.navigator.conversation-backup.v1`。它仅包含 active 对话消息和记忆、画像候选、转换回候选的 active 画像，以及图谱 changeset。它排除来源授权 grant、派生 join rows、附件引用、维护任务、导入 staging 与其他域记录。恢复不信任归档画像的 active 状态或图谱 provider 回执。除非宿主另行提供当前审批，画像保持候选；图谱只有在真实 provider 写入并独立回读完全匹配的摘要和节点/边数量后才能标记 projected。

## Bounds and recovery / 边界与恢复

Default limits are 10 MB per artifact, 256 KB per JSONL row, 100,000 records, 100 records per page, 256 source references per record, and 100,000 characters per text field. Work Task events contain only cursors, counts, IDs, record digests, current authorization epochs, canonical readback digests, and operation IDs; source text is not copied into task progress. Deterministic idempotency keys allow a restart to reconcile a write that completed before its terminal task checkpoint. Each applied record has a Work Operation intent and a verified readback receipt. Rollback walks applied records in reverse order and uses version-checked canonical compensation. If a port cannot independently read back or compensate, the batch fails closed and remains available for host reconciliation.

默认限制为每个制品 10 MB、每行 JSONL 256 KB、100,000 条记录、每页 100 条、每条 256 个来源引用、每个文本字段 100,000 字符。Work Task 事件仅保存游标、数量、ID、记录摘要、当前授权 epoch、规范回读摘要和 operation ID，不复制来源正文。稳定幂等键允许在写入完成但终态任务检查点未落盘时安全恢复。每条记录先建立 Work Operation 意图，再以独立回读回执确认。回滚按相反顺序调用带版本校验的规范补偿端口。端口无法独立回读或补偿时，批次 fail closed，等待宿主处理。

Before `apply` or `rollback` starts a batch mutation, the host rollback-capability adapter checks every accepted record kind. A plan containing memory, profile, or graph rows is rejected before the first canonical write if the corresponding tombstone readback, candidate/profile CAS rollback, or provider-backed graph compensation is unavailable. This preflight proves only that the host adapter reports the required path; it is not itself a successful rollback or product acceptance test.

`apply` 或 `rollback` 开始批次变更前，宿主补偿能力适配器会检查所有已接受记录类型。若记忆墓碑回读、画像候选/生效状态 CAS 回滚或 provider 图谱补偿接口缺失，包含对应记录的计划会在首个规范写入前拒绝。该预检只表示宿主适配器报告所需路径可用，不等同于已成功回滚或产品验收通过。

## Validation evidence / 验收证据

`tests/test_conversation_migration.py` covers strict fixture parsing, pagination, read-only previews, portable backup filtering, and required compensation-capability mapping. `tests/test_conversation_migration_sqlite.py` uses temporary real `ConversationMemoryStore`, `ConversationDomainStore`, and `WorkStore` SQLite databases to exercise a message-only fresh restore, restart recovery, source-message rollback, and fail-closed memory preflight when tombstone readback is absent. Its host authorization/capability adapter is explicitly a test fixture; it does not prove the authenticated Work route or external graph provider. Profile and graph rollback remain unverified until their canonical host APIs are installed and mounted.

`tests/test_conversation_migration.py` 覆盖 fixture 严格解析、分页、只读预演、便携备份过滤及所需补偿能力映射。`tests/test_conversation_migration_sqlite.py` 使用临时真实 `ConversationMemoryStore`、`ConversationDomainStore` 和 `WorkStore` SQLite 数据库，验证仅消息记录的全新恢复、重启续跑、消息来源撤销，以及缺少墓碑回读时记忆预检 fail closed。测试授权/能力适配器明确属于 fixture，不能证明已认证 Work 路由或外部图谱 provider。画像和图谱回滚仍需等待规范宿主 API 安装并挂载后验收。

The host integration also needs a scope-bound memory tombstone readback for `delete_memory`, a version-checked rollback for unactivated profile candidates, and provider-backed graph compensation with independent deletion readback. Until the core/domain owners expose these APIs, those rollback paths remain fail-closed and are not acceptance passes. Active-profile rollback and message-source revoke use the existing canonical APIs.

宿主接线还需提供 actor-scope 绑定的 memory tombstone 回读、未激活画像候选的版本校验撤回，以及带独立删除回读的图谱 provider 补偿。在 core/domain owner 暴露这些 API 前，对应回滚路径保持 fail closed，不能计为验收通过。active 画像回滚与消息来源撤销使用现有规范 API。

No real user history is used by these tests. No live account, cloud service, or production bot is changed.

这些测试不使用真实用户历史数据，也不修改实时账号、云服务或生产 Bot。
