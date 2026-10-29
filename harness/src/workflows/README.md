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
| `source-config.ts` | Host-selected source references with fresh actor/source authorization ports / 宿主选择的来源引用及即时 actor、来源授权接口 |
| `product-observation.ts` | Fixed Product resource reads; Yield remains training authority / 固定 Product 资源读取；训练状态仍由 Yield 权威管理 |
| `host-observation.ts` | Bounded sanitized host snapshots without a host command channel / 有界脱敏宿主状态，不提供宿主命令通道 |
| `office-observation.ts` | Selected Planner metadata through the registered Graph tool / 通过注册 Graph 工具读取选定 Planner 元数据 |
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

V3 is separately negotiated with `definitionVersion=3`; v1 and v2 keep their
existing contracts. Source collection runs fixed tools or typed read adapters,
without a model. A source binding selects a target; current Directory and source
access still need verification on each poll. Missing proof disables that source.
Incomplete pages keep their prior watermark. Work persists immutable events and
server-derived notification decisions so retries can resume after either an event
write or an outbox write. Initial baselines remain quiet.

V3 also accepts a fixed GitHub Actions workflow target whose ID is
`github-actions-workflow:<repository-id>:<workflow-id>`, whose label is the exact
`owner/repository` slug, and whose `bindingId` is the actor's existing GitHub
Exchange binding. The host reads only the `develop` branch head, then calls the
registered `github.actions.runs.list` tool for that exact commit and selects the
configured numeric workflow ID. It selects the highest numeric run ID first,
then that run's latest attempt/update; a late completion from an older run cannot
override a newer pending run. It does not accept a URL, CLI arguments, or a
branch chosen by model output. The provider returns at most 100 runs and no
continuation cursor; the host accepts the snapshot only when the provider reports
it complete. A truncated result records a partial source run and retains the
previous watermark. Missing or in-progress runs are unknown and do not count as
healthy. Completed failures and successes use one stable workflow resource URI,
so a later completed success can recover a prior failure through the same Work
event/outbox state machine. This observes only the configured workflow on the
current `develop` head, not every historical or other-branch run; a failure on a
commit superseded before a poll may be missed. V3 notification delivery still
requires the owner-private Teams route; this adapter does not grant channel sharing.

V3 通过 `definitionVersion=3` 单独协商，v1、v2 保持原有契约。来源采集使用固定工具或
类型化只读适配器，不调用模型。来源绑定只负责选择目标；每次轮询仍须验证当前 Directory
和来源访问权，缺少证明时关闭该来源。不完整分页不推进原有水位。Work 持久保存不可变
事件和服务端生成的通知决定，使事件写入或 outbox 写入后的重试能够继续；首次基线不通知。

V3 还接受固定的 GitHub Actions 工作流 target：ID 为
`github-actions-workflow:<repository-id>:<workflow-id>`，label 必须是精确的
`owner/repository`，`bindingId` 必须是该 actor 现有的 GitHub Exchange binding。宿主只读取
`develop` 分支 head，再通过已注册的 `github.actions.runs.list` 工具读取该确切 commit，并
筛选配置的数字 workflow ID。它优先选择数值最大的 run ID，再选择该 run 的最新 attempt/update；
旧 run 的迟到完成不能覆盖更新的 pending run。它不接受 URL、CLI 参数或模型选择的分支。
Provider 最多返回 100 条 run 且不提供续页 cursor；只有 Provider 明确报告完整时宿主才接受该快照。截断结果会
记录为 partial source run 并保留原水位。没有 run 或仍在执行的 run 表示状态未知，不会被算作
健康。已完成失败和成功事件使用同一个稳定 workflow resource URI，因此后续已完成的成功可
通过同一 Work 事件/outbox 状态机恢复先前失败。该观察只覆盖配置的 workflow 在当前
`develop` head 上的状态，不覆盖历史或其他分支的所有 run；若失败所在 commit 在 poll 前已
被新 commit 替代，该历史失败可能漏报。V3 通知仍要求 owner-private Teams route；此适配器
不会授予频道共享权限。

The optional pilot uses a dedicated host token for each actor, including the
owner. Each token must have `actor_private_scope`, Work write and Harness write
capabilities limited to one organization and Workspace. The shared legacy token
is not a fallback for this pilot. Personal Teams delivery requires the separate
bridge principal and a current verified personal installation; model output
cannot choose a recipient. Product, Graph and Teams local tests do not establish
live source consent, delivery, capacity admission or a completed observation period.

可选试点为包括 owner 在内的每个 actor 配置独立宿主 token，并限制在单个组织和
Workspace，启用 `actor_private_scope` 及本人的 Work、Harness 写入能力。试点不会退回
共享旧 token。Teams 个人通知需要独立 bridge 身份和当前已验证的个人安装；模型输出
不能选择收件人。本地测试不代表真实来源授权、Teams 送达、容量准入或稳定性观察完成。
