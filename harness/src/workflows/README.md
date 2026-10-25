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

Proactive responsibility definitions use an explicit `definitionVersion=2` Work API negotiation; an omitted version continues to expose the v1 workflow contract. GitHub polling advances only after the host verifies every repository's contiguous provider page receipts within one frozen time window. A model's summary cannot declare source completeness or move the watermark. Actions use separate background child tasks, with source scope rechecked by the host before provider calls. Teams notice routes are resolved from the stored owner thread, and GitHub branch writes share an atomic SQLite scope lock until their operation receipt is verified.

主动责任通过 Work API 显式请求 `definitionVersion=2`；省略版本时仍只返回 v1 工作流契约。GitHub 轮询只有在主机核验完同一固定时间窗口内各仓库连续分页回执后才会推进水位。模型摘要不能声明来源完整，也不能移动水位。写操作由单独的后台子任务执行，连接器调用前由主机重新校验范围。Teams 通知目标从已保存的维护者线程解析；GitHub 分支写入通过 SQLite 原子范围锁串行执行，直到操作回执验证完成。

`workflows-v2.test.mjs` runs the DSH timer hook with the actual registered provider tool catalog for two GitHub repositories. It verifies that a truncated page keeps the watermark, a later run resumes the stored cursor, and the completed repository is retained while the pending page chain resumes.

`workflows-v2.test.mjs` 使用 DSH timer hook 和双仓库 GitHub provider 工具目录 fixture，验证截断分页不推进水位、后续运行续接持久游标，并在恢复分页时保留已完成仓库状态。
