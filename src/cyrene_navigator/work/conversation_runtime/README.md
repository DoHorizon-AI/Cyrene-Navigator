# Conversation Runtime / 对话运行时

This package provides the server-side research adapter used by the existing DSH
feature Task lifecycle. It validates the active actor-owned Work Task and current
conversation sources, invokes only a server-configured Public Web binding, stores
the bounded result as a Work attachment, reads it back by digest, and records the
result in Work's existing Operation ledger. It does not create a scheduler,
executor, or parallel receipt store.

本包为既有 DSH 功能任务生命周期提供服务端研究适配器。它校验当前 actor 所有且仍在运行的
Work Task 和会话来源，只调用服务端配置的公网工具绑定，将有界结果写入 Work 附件、按摘要
独立读回，并写入 Work 既有 Operation 回执账本。本包不创建新的调度器、执行器或回执存储。

`ConversationResearchRuntime` is intentionally mounted by the host's normal Work
API composition. Its request scope must come from the current trusted feature
Task; model-visible arguments contain only the research query and opaque
attachment IDs selected from authorized message lineage. A missing binding,
task, source authorization, artifact bridge, or Work receipt store fails closed.

`ConversationResearchRuntime` 由宿主在现有 Work API 装配过程中挂载。请求范围必须来自当前可信
功能 Task；模型可见参数仅包含研究查询和从已授权消息来源中选出的不透明附件 ID。缺少绑定、
Task、来源授权、附件桥或 Work 回执存储时会拒绝执行。

| File | Responsibility / 职责 |
| --- | --- |
| `service.py` | Active Task validation, Public Web calls, source evidence, and Work readback receipts. / 活动 Task 校验、公网工具调用、来源证据与 Work 读回回执。 |
| `models.py` | Closed internal request, scope, and result shapes. / 封闭的内部请求、范围与结果结构。 |
