# Harness adoption ledger / Harness 接入记录

Navigator composes the exact DeepSeek Harness source declared by
`harness/upstream.lock.json`. Repository adapters are compiled from
`harness/src`, loaded through `harness/cordis.patch.yml`, and tested against the
real upstream packages.

## Owned adapters

- Persistence maps upstream Session events to Navigator's HTTP persistence
  authority with explicit leases and takeover.
- Codex import invokes the Navigator Rust host, preserves the source archive,
  and never replays historical tools.
- Client delivery feedback correlates submitted input with durable receipts and
  retains failed input for explicit recovery.
- Compaction removes tool declarations only for the compaction request and
  fails closed on outputs that contain no text.
- CodeBuddy LLM turns use restricted structured output; the existing DSH
  AgentLoop remains the sole executor and returned tool arguments are checked
  against the active catalog before a DSH tool-call block is emitted.
- The explicit `codebuddy-acp` task backend runs the official CodeBuddy ACP
  stdio process without a DSH reasoning loop. Navigator retains Work/session
  ownership and exposes only host-authorized Exchange tools through a task-local
  MCP bridge that reuses the existing authorization and receipt path.

The native host is launched through `CYRENE_NATIVE_HOST`. It has no external
Platform tool or source dependency. Its implemented methods are reported by the
`hello` handshake and remain limited to Navigator-owned operations.

The ACP backend serializes one Work session inside a Navigator process. It does
not yet claim a cross-process session lease, so production must run exactly one
Navigator process/replica against a given Work SQLite database and CodeBuddy
profile. Do not overlap rollouts or mount those same state paths into another
replica. Cross-process session leasing is a separate follow-up. CodeBuddy's
`HOME` and XDG data paths are rooted at the persistent private
`CODEBUDDY_CONFIG_DIR/navigator-cli-home`; keep that profile path stable across
container replacements.

On cancellation, authorization pause, timeout, EOF, or protocol failure, the
ACP run aborts its task-local tool signal before disposing the child and MCP
listener. Shutdown waits for active host-owned tool handlers for a bounded
period. If a provider ignores cancellation, the Work task reports cleanup as
incomplete and an in-flight write receipt remains uncertain; it cannot be
replayed until reconciled. `exchange_operation_read` can inspect an Exchange
operation, but a model response or an unrelated status read does not promote a
generic uncertain Work receipt. Only the existing exact cloud-operation
readback path can reconcile its matching operation reference automatically;
other uncertain receipts require independent authoritative readback and
operator reconciliation.

## Compatibility and evidence

The profile tests use the real pinned Harness CLI, Bundle, Rust host, and local
persistence process. Deterministic model adapters used by focused tests are
fixtures and do not count as real model inference. Client UI integration tests
are owned by the Native Client (`Cyrene-Client`).

`CYRENE_HARNESS_MODEL_SOURCE` defaults to `exchange` for compatibility and may
select `codebuddy` or `antigravity`. Antigravity defaults to
`gemini-3.8-flash-medium` and requires the pinned model-only agent profile in
the service HOME. If `CYRENE_HARNESS_MODEL` is set, it must be one of the
allowlisted Antigravity model slugs. The production Docker executor selects it through
`node scripts/serve-executor.mjs`; the separate Python local-stack launcher is
not wired for Antigravity yet. The CodeBuddy adapter defaults to `glm-5.3-flash`, with
`deepseek-v4.1-flash` as an available model choice. Focused adapter tests use a
local fake CLI and establish process flags, DSH history serialization, schema
validation, terminal-result checks, timeout, and cancellation; they do not
claim a credentialed model call.

`CYRENE_HARNESS_EXECUTION_BACKEND` defaults to `dsh`; `codebuddy-acp` is a
separate top-level execution choice and ignores the legacy model-source selector.
It requires empty `CYRENE_HARNESS_MODEL_SOURCE` and `CYRENE_HARNESS_MODEL`, a
false CodeBuddy fallback setting, and the explicit
`CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP=true` deployment declaration. The
vendor CLI has no setting that enforces a no-top-up billing rule, so this
declaration is not a billing guarantee. Local stub tests verify ACP, strict MCP,
permission denial, bounded child environment, Work receipts, authorization
pause, cancellation-aware handler cleanup, restart loading, EOF, and
process-exit behavior. They do not prove CodeBuddy login or model billing.

The native supervisor matrix retains cancellation, reaping, protocol-version,
bounded-output, and credential-isolation checks. Its controlled fault fixture
only tests the transport; Codex import still crosses the real Navigator Rust host.

Generated profile inventories are snapshots of the lockfile composition. They
must be regenerated when the Profile patch or upstream pin changes and must not
be treated as a runtime success claim.

## Upstream patch policy

Navigator keeps its changes in repository-owned Cordis plugins and client
extensions. A change to upstream Harness is proposed upstream or retained as an
explicit, reviewable adapter; it must not be hidden in an installation script.
---
<!-- Chinese Translation / 中文翻译 -->

## 已拥有的适配器

- 持久化适配器将上游 Session event 映射到 Navigator 的 HTTP 持久化权威，并使用显式 lease 和接管机制。
- Codex 导入会调用 Navigator Rust host、保留来源 archive，且绝不重放历史工具。
- 客户端交付反馈会将已提交输入与持久化回执关联，并保留失败输入供用户显式恢复。
- Compaction 只在 compaction 请求中移除工具声明；输出不含文本时按 fail-closed 处理。
- CodeBuddy LLM 调用只使用受限结构化输出；现有 DSH AgentLoop 仍是唯一工具执行者，并且在发出 DSH tool-call block 前按当前工具目录检查工具名和参数。
- 显式 `codebuddy-acp` Work Task backend 使用官方 ACP stdio 进程，不套 DSH reasoning loop。Navigator 继续拥有 Work/session 状态，并通过任务级 MCP bridge 只公开宿主授权的 Exchange 工具，复用现有授权与回执路径。

原生宿主通过 `CYRENE_NATIVE_HOST` 启动，不依赖外部 Platform 工具或源码。实现的方法由 `hello` 握手报告，范围仅限 Navigator 所有的操作。

ACP backend 只在单个 Navigator 进程内串行处理同一 Work Session，目前没有跨进程 Session lease。因此生产中同一个 Work SQLite 数据库和 CodeBuddy profile 必须只由一个 Navigator 进程/副本使用；不要让滚动部署重叠，也不要把同一状态路径挂载给另一个副本。跨进程 Session lease 后续单独实现。CodeBuddy 的 `HOME` 与 XDG 数据目录固定在持久私有路径 `CODEBUDDY_CONFIG_DIR/navigator-cli-home` 下，容器替换后必须保持 profile 路径稳定。

取消、授权暂停、超时、EOF 或协议失败时，ACP run 会先取消任务级工具信号，再回收子进程和 MCP listener。关闭过程会在有界时间内等待宿主拥有的在途工具 handler。provider 忽略取消时，Work Task 会明确报告 cleanup 未完成；进行中的写入回执保持 uncertain，完成独立核对前不得重放。`exchange_operation_read` 可以读取 Exchange operation；模型返回一句确认或无关状态读取都不能把一般 uncertain Work 回执升级为成功。只有现有精确 cloud-operation readback 路径能自动核对匹配的 operation reference；其他 uncertain 回执需要独立权威读取和操作员核对。

## 兼容性与证据

Profile 测试使用真实固定版本 Harness CLI、Bundle、Rust host 和本地持久化进程。重点测试中的确定性模型适配器只是 fixture，不算真实模型推理。客户端 UI 集成测试完全由 Native Client（`Cyrene-Client`）负责。

原生 supervisor 矩阵保留取消、回收、协议版本、有界输出和凭据隔离检查。受控故障 fixture 只验证传输；Codex 导入仍通过真实 Navigator Rust host。

`CYRENE_HARNESS_MODEL_SOURCE` 为兼容旧部署默认 `exchange`，也可选择 `codebuddy` 或 `antigravity`。Antigravity 默认使用 `gemini-3.8-flash-medium`，要求服务 HOME 中存在固定的纯模型 agent profile；若设置 `CYRENE_HARNESS_MODEL`，其值必须属于 allowlist。生产 Docker executor 通过 `node scripts/serve-executor.mjs` 选择该 adapter；独立的 Python local-stack launcher 目前尚未接入。CodeBuddy adapter 默认模型为 `glm-5.3-flash`，并提供 `deepseek-v4.1-flash`。重点 adapter 测试用本地 fake CLI 验证进程参数、DSH 历史序列化、schema 校验、终态检查、超时和取消；这些测试不代表进行了带凭据的真实模型调用。

`CYRENE_HARNESS_EXECUTION_BACKEND` 默认 `dsh`；`codebuddy-acp` 是独立的顶层执行选择，并忽略旧 model-source selector。ACP 要求 `CYRENE_HARNESS_MODEL_SOURCE` 与 `CYRENE_HARNESS_MODEL` 为空、CodeBuddy fallback 为 false，并显式声明 `CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP=true`。供应商 CLI 没有可强制禁止使用已购 credits 的设置，因此该声明不构成扣费保证。本地 stub 测试覆盖 ACP、strict MCP、权限拒绝、子进程环境隔离、Work 回执、授权暂停、在途 handler 取消与清理、重启加载、EOF 和进程退出；不代表完成真实 CodeBuddy 登录或模型计费验收。

生成的 Profile 清单是 lockfile 组合快照。Profile patch 或上游 pin 变化时必须重新生成，不能把它作为运行成功证据。

## 上游补丁策略

Navigator 将改动保留在仓库自有 Cordis 插件和客户端扩展中。对上游 Harness 的修改应向上游提议，或作为明确且可审查的适配器保留；不得隐藏在安装脚本中。
