# Responsibility management tools / 职责管理工具

Navigator exposes the owner's long-running GitHub duties as tools in the existing DSH conversation. The tools use the durable Workflow API and do not create a second task or workflow authority.

Navigator 在现有 DSH 对话中向所有者提供长期 GitHub 职责管理工具。工具复用持久化 Workflow API，不另建任务或工作流权威。

## Available commands / 可用命令

| Tool | Purpose / 用途 |
| --- | --- |
| `responsibility_repositories` | List host-configured GitHub repositories that a new duty may select / 列出新职责可选的宿主配置仓库 |
| `responsibility_list` | List duties owned by the currently authorized Teams principal / 列出当前已授权 Teams 身份拥有的职责 |
| `responsibility_create` | Create a duty from a title, goal, and selected configured repository IDs / 按标题、目标和选定的配置仓库创建职责 |
| `responsibility_pause` / `responsibility_resume` | Change only the enabled state of an owned duty / 仅变更自有职责的启用状态 |
| `responsibility_update_goal` | Change only the goal text of an owned duty / 仅修改自有职责的目标描述 |
| `responsibility_status` | Read recent run status and source-backed evidence / 查看最近执行状态和来源证据 |
| `responsibility_usage` | Read provider-reported usage for the current conversation or an owned duty / 查看当前对话或自有职责的供应商真实用量 |

## Authorization and scope / 授权与范围

Every command resolves the active foreground Teams task and rechecks the current Directory role. The host derives the caller, thread, and source task from authenticated task metadata. Tool arguments cannot supply an identity, owner task, notification route, model route, or action grant. A duty read or mutation is allowed only after Navigator verifies its stored owner task, stable Teams principal, thread binding, and current authorization.

每个命令都会解析当前前台 Teams 任务并重新检查 Directory 角色。调用者、线程和源任务均由宿主从已验证的任务元数据中取得。工具参数不能指定身份、所有者任务、通知路由、模型路由或操作授权。只有在 Navigator 验证职责保存的所有者任务、稳定 Teams 身份、线程绑定及当前权限后，才允许读取或修改。

Repository IDs, names, Exchange bindings, and typed action grants come only from the host allowlist. A new duty can select a subset of those repositories; it cannot add a repository or broaden the configured grant. The default schedule polls GitHub every five minutes and reviews at 09:00 and 17:00 America/New_York. Notifications return to the originating Teams thread. Merge, release, production changes, and new spend remain outside autonomous grants.

仓库 ID、名称、Exchange 绑定及类型化操作授权只来自宿主 allowlist。新职责只能从其中选择仓库，不能增加仓库或扩大配置授权。默认每五分钟轮询 GitHub，并在 America/New_York 时区 09:00 和 17:00 进行复查。通知回到职责原始 Teams 线程。合并、发布、生产变更和新增支出不属于自动授权范围。

Usage responses aggregate only durable `model-usage` events reported by the provider. The tool does not estimate cost or enforce a quota. A history query samples the latest 100 schedule events per duty and reports when a duty has older events; use the duty status cursor to page through run receipts.

用量结果只汇总供应商报告并持久保存的 `model-usage` 事件。工具不估算费用，也不限制额度。历史用量查询最多读取每项职责最近 100 条调度事件，并会标明是否还有更早记录；执行回执可通过职责状态游标继续分页读取。
