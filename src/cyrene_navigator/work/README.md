# Work Domain / 工作域

This package stores Navigator work tasks, approvals, connector receipts, memory facts,
operation receipts, notifications, attachments, and workflow run history in the same
SQLite file used by Harness persistence. Every stored record is keyed by organization
and Workspace. Host-configured actor-private principals add immutable actor ownership
for new Tasks, memory facts, and attachments; verified Teams events and thread text are
always filtered to their authenticated actor. Actor-private Teams Tasks expose a
route-free private-origin proof; terminal results and accepted acknowledgements use the
owner-private outbox, and ordinary channel workers cannot claim them. It does not run
tools, send messages, or schedule work.

本目录在 Harness 共用的 SQLite 文件中保存 Navigator 工作任务、审批、连接器回执、记忆事实、
操作回执、通知、附件及工作流执行历史。每条记录均按组织与 Workspace 隔离。本模块不执行工具、
不发送外部消息，也不负责调度。宿主配置的 actor-private principal 会为新任务、记忆事实和附件
记录不可变 actor 所有权；已验证的 Teams 事件与线程文本始终按认证 actor 过滤。
actor-private Teams Task 仅暴露不含 route 的来源证明；最终结果和接纳确认进入 owner-private outbox，普通 channel worker 无法认领。

| File | Responsibility / 职责 |
| --- | --- |
| `api.py` | Authenticated Work routes, writer checks, and trusted connector bridge dispatch. / 工作路由、写入权限及可信连接器桥接。 |
| `models.py` | Strict camelCase request and response schemas. / 严格 camelCase 请求与响应模型。 |
| `store.py` | SQLite schema, scoped transactions, receipts, outbox leases, and content storage. / SQLite 表、范围事务、回执、通知租约及内容存储。 |

Suggested reading order: `models.py` → `store.py` → `api.py`.

建议阅读顺序：`models.py` → `store.py` → `api.py`。
