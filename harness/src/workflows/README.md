# Durable workflows / 持久化工作流

Workflow definitions and run receipts live in the workspace Work API. DSH's
persisted Schedule domain is the only cadence trigger; the runtime routes its
typed timer inbox messages through the existing Navigator executor with a
stable occurrence task id. Read [cloud-connections.md](../../../docs/cloud-connections.md)
for the profile boundaries and deployment order.

工作流定义和执行回执保存在 workspace Work API。DSH 持久化 Schedule domain 是唯一的
周期触发源；运行时将带类型的 timer 收件箱消息路由到现有 Navigator executor，并使用
稳定的 occurrence task id。连接边界和部署顺序见
[cloud-connections.md](../../../docs/cloud-connections.md)。

| File | Responsibility / 职责 |
| --- | --- |
| `store.ts` | Workflow model, authenticated API client, immutable receipts, notification outbox, and explicit test store / 工作流模型、认证 API 客户端、不可变回执、通知 outbox 与测试存储 |
| `runtime.ts` | Shared DSH storage bootstrap, scheduler inbox, marker dispatch, and durable transition notifications / DSH 共享存储装配、Scheduler 收件箱、标记派发与持久化状态通知 |
| `readonly.ts` | Per-occurrence guard for configured observation-only tools / 每次 occurrence 的配置只读工具 guard |
| `index.ts` | Public package exports / 包公开导出 |

Call `registerWorkflowRuntime` after session persistence, AgentLoop, and the
Navigator executor are ready, and after cloud profile registration when
workflow cloud targets are in use. The function mounts or reuses one DSH
Schedule service, temporarily guards the occurrence Session to readonly
targets, awaits durable notification enqueue before observation, and does not
create a second timer loop.

请在 Session persistence、AgentLoop 和 Navigator executor 就绪后调用
`registerWorkflowRuntime`；工作流使用云 target 时，还应先注册 cloud profile。该函数挂载或复用
唯一的 DSH Schedule service，在 occurrence Session 上临时启用只读 target guard，并在发出观察事件前
等待持久化通知入队，不会另建计时循环。
