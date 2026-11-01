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
| `conversation-domain-api.ts` | Versioned P3–P7 Work API DTOs and real-provider ports / P3–P7 版本化 Work API DTO 与真实提供方端口 |
| `conversation-dsh-runtime.ts` | Stable DSH Work Task identity and executor ports / 稳定 DSH Work Task 身份及执行器端口 |
| `conversation-schedule.ts` | Identifier-only DSH Schedule markers with create/readback reconciliation / 仅含标识符的 DSH Schedule 标记及创建回读对账 |
| `persona-profile.ts` | Persona context and sourced, review-only profile candidates / 人格上下文与带来源、待审核的画像候选 |
| `knowledge-graph.ts` | Sourced graph proposals, guarded context and provider readback checks / 带来源的图谱提案、上下文门禁及提供方回读校验 |
| `dream-maintenance.ts` | Bounded paged Dream plans with persisted recovery state and idempotent writes / 有界分页 Dream 计划、持久恢复状态与幂等写入 |
| `research-work.ts` | Work-receipt-backed notes and scheduled read-only watches / Work 回执支持的研究笔记与定时只读观察 |
| `nous-active.ts` | Sourced focus/handoff context, policy-gated follow-ups and retraction / 带来源的焦点与交接上下文、策略门控跟进及撤回 |
| `conversation-daily-review.ts` | Resumable, source-authorized daily review artifacts with independent Work readback / 可恢复、来源授权的对话每日复盘制品及 Work 独立回读 |

All modules use the authenticated Work API and current source authorization.
Background maintenance uses the existing DSH Work Task and Schedule; proactive
turns are submitted through the existing Navigator executor port. A missing real
provider, receipt, executor adapter or authorization proof is a typed failure or
hold, never an empty success. Host wiring remains in the Navigator core-owned
executor/serve modules.

Read `conversation-memory.ts` first. Feature modules depend on its versioned
scope and source-reference types, never on another module's storage implementation.

所有模块使用已认证的 Work API 和当前来源授权。后台维护复用现有 DSH Work Task 与
Schedule；主动对话通过现有 Navigator executor 端口提交。缺少真实提供方、回执、执行器
适配器或授权证明时必须失败或暂缓，不能返回空成功。宿主接线位于 Navigator core 所有的
executor/serve 模块。

建议先读 `conversation-memory.ts`。功能模块依赖其中的版本化范围和来源引用类型，不得直接
依赖其他模块的存储实现。
