# Conversation Migration / 对话迁移

This package implements the bounded, optional offline import and actor-private portable backup restore flow for Navigator. It owns no database, router, task scheduler, authorization policy, or second migration ledger. The host supplies an authenticated actor scope, an actor-authorized artifact reader, live source authorization, canonical memory/profile/graph ports, and adapters over existing Work Task events and Work Operations. `build_conversation_migration_host` is the mount factory for the core-owned route; it does not start a service or create a second task system.

本包实现 Navigator 可选的离线导入与 actor 私有便携备份恢复。它不拥有数据库、路由、任务调度、授权策略或第二套迁移账本。宿主必须注入已认证 actor scope、actor 授权的制品读取器、实时来源授权、规范记忆/画像/图谱端口，以及复用现有 Work Task 事件和 Work Operation 的适配器。`build_conversation_migration_host` 是供 core-owned 路由挂载的工厂；它不会启动服务或创建第二套任务系统。

| File | Responsibility / 职责 |
| --- | --- |
| `models.py` | Host scope, portable records, limits, and privacy-safe receipts. / 宿主 scope、迁移记录、边界与安全回执。 |
| `ports.py` | Authorization, canonical store, graph provider, operation, task, and source contracts. / 授权、规范存储、图谱 provider、操作、任务与读取契约。 |
| `adapters.py` | Canonical memory/profile/domain and WorkStore adapters, Direct graph compensation, and the route mount factory. / 规范记忆/画像/域与 WorkStore 适配器、Direct 图谱补偿及路由挂载工厂。 |
| `records.py` | Closed-field record validation, lineage checks, and deterministic digests. / 封闭字段校验、来源链检查与稳定摘要。 |
| `jsonl.py` | Seekable, digest-verified, line-bounded JSONL pages without accepting a path string. / 不接收路径字符串的可定位、验摘要、有界 JSONL 分页。 |
| `backup.py` | Converts canonical store exports to the portable backup format and validates restores. / 将规范存储导出转换为便携备份并校验恢复包。 |
| `aether_convert.py` | Converts a bounded, offline Aether text-history export to canonical JSONL; defaults to dry-run. / 将有界离线 Aether 文本历史转为规范 JSONL，默认只预演。 |
| `service.py` | Read-only preview, approved projection, restart recovery, and per-batch compensation. / 只读预演、获批投影、重启恢复与批次补偿。 |

`python -m cyrene_navigator.work.conversation_migration.aether_convert --help` describes the optional source conversion command. It reads a pre-exported JSONL file and never connects to Aether or Navigator storage. Its only source format is Aether `platform_message_history` rows using `id`, `platform_id`, `user_id`, `content`, and `created_at`; current conversion covers messages only, not Aether memories, profiles, or graph data. Unknown roles, conversation kinds, payloads, sensitive fields, and unsupported task/session fields are quarantined by count. It emits only plain-text user/bot messages, hashes source conversation/persona references into opaque stable IDs, and drops sender identity, checkpoints, native targets, attachments, and source-message metadata. The `--source-namespace` value must be an opaque stable alias and must be reused when converting the same export again.

Suggested reading order: `models.py` → `ports.py` → `records.py` → `jsonl.py` → `aether_convert.py` → `backup.py` → `service.py`.

`python -m cyrene_navigator.work.conversation_migration.aether_convert --help` 可查看可选源数据转换命令。命令只读取预先导出的 JSONL，不连接 Aether 或 Navigator 存储。唯一支持的 Aether 输入是 `platform_message_history` 行，包含 `id`、`platform_id`、`user_id`、`content`、`created_at`；目前只转换消息，不转换 Aether 记忆、画像或图谱。未知角色、会话类型、负载、敏感字段及不支持的任务/登录态字段只计数隔离。输出只保留纯文本 user/bot 消息，将来源会话和 persona 引用哈希为不透明稳定 ID，并丢弃发送者身份、checkpoint、平台目标、附件和来源消息元数据。重复转换同一导出时必须复用 `--source-namespace` 不透明别名。

建议阅读顺序：`models.py` → `ports.py` → `records.py` → `jsonl.py` → `aether_convert.py` → `backup.py` → `service.py`。
