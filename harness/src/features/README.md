# Conversation features / 对话功能模块

This directory contains optional DSH consumer modules. The host owns identity,
authorization, scheduling, task execution, persistence and message delivery;
modules only contribute scoped context and request operations through versioned
host ports.

此目录存放可选 DSH 消费模块。宿主负责身份、授权、调度、任务执行、持久化和消息发送；
模块只提供范围受限的上下文，并通过版本化宿主端口请求操作。

| File | Responsibility / 职责 |
| --- | --- |
| `conversation-memory.ts` | Scope-safe retrieval, completed-turn persistence, summary archival and source revalidation / 隔离检索、回合持久化、摘要归档与来源重验 |

Read `conversation-memory.ts` first. Later modules should depend on its
versioned scope types and the Navigator Work API ports, never on another
module's storage implementation.

建议先读 `conversation-memory.ts`。后续模块应依赖其中的版本化范围类型和 Navigator Work
API 端口，不得直接依赖其他模块的存储实现。
