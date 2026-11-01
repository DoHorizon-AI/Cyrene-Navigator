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
| `service.py` | Read-only preview, approved projection, restart recovery, and per-batch compensation. / 只读预演、获批投影、重启恢复与批次补偿。 |

Suggested reading order: `models.py` → `ports.py` → `records.py` → `jsonl.py` → `backup.py` → `service.py`.

建议阅读顺序：`models.py` → `ports.py` → `records.py` → `jsonl.py` → `backup.py` → `service.py`。
