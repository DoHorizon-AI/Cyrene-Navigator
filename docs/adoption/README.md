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
- The CodeBuddy prompt distinguishes successful evidence from failed
  observations, requires explicit comparison evidence for ancestry claims, and
  discourages repeating a call when `retryable` is false or unknown. Provider
  constraints omitted from DSH's enforced JSON Schema subset remain visible as
  model-facing hints; Navigator's host validator stays authoritative. This
  guidance improves behavior but cannot guarantee that a model never makes an
  unsupported claim.
- The explicit `codebuddy-acp` task backend runs the official CodeBuddy ACP
  stdio process without a DSH reasoning loop. Navigator retains Work/session
  ownership and exposes only host-authorized Exchange tools through a task-local
  MCP bridge that reuses the existing authorization and receipt path.
- The separate, opt-in `antigravity-acp` task backend launches Google's official
  ACP binary and uses the native session's advertised model selector. It keeps
  provider auth/session state in a private persistent profile, disables built-in
  tools with the documented native filter, and permits only a current-catalog
  Navigator MCP call whose official ACP metadata identifies its server and tool.

The native host is launched through `CYRENE_NATIVE_HOST`. It has no external
Platform tool or source dependency. Its implemented methods are reported by the
`hello` handshake and remain limited to Navigator-owned operations.

The ACP backends serialize one Work session inside a Navigator process. They do
not yet claim a cross-process session lease, so production must run exactly one
Navigator process/replica against a given Work SQLite database and each selected
provider's private profile. Do not overlap rollouts or mount those same state
paths into another replica. Cross-process session leasing is a separate
follow-up. CodeBuddy's `HOME` and XDG data paths are rooted at the persistent
private `CODEBUDDY_CONFIG_DIR/navigator-cli-home`; Antigravity's child `HOME` is
its `CYRENE_HARNESS_ANTIGRAVITY_ACP_PROFILE`, with XDG paths below it. Keep the
selected profile path stable across container replacements.

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

The official Antigravity ACP backend is selected only with
`CYRENE_HARNESS_EXECUTION_BACKEND=antigravity-acp`; the default remains `dsh`.
Production sets the absolute official server path in
`CYRENE_HARNESS_ANTIGRAVITY_ACP_COMMAND`, installs its adjacent
`localharness_external` executable, and mounts a private persistent profile at
`CYRENE_HARNESS_ANTIGRAVITY_ACP_PROFILE`. Linux uses the official registry's
fixed `--uid=` argv item. The profile root must be process-owned and mode 0700;
nested XDG directories must remain owner-owned, real directories inside that
root. The runtime preserves their existing mode bits because the private root
is the operating-system-user access boundary. It requires
`agentInfo.name=antigravity-acp`,
an ACP version with the built-in tool filter; its MCP server uses ACP v1's
baseline stdio transport. It rejects the profile's global
`~/.gemini/config/mcp_config.json` so the task-local Navigator server is the
only custom MCP source.

`CYRENE_HARNESS_ANTIGRAVITY_ACP_MODEL` is optional. When set, it must exactly
match a value in the native session's model `configOptions`, and the server
must confirm that current value before prompting. When unset, the runtime uses
the server's advertised current model; it does not translate legacy model
variants. A model change during a turn fails that turn. The runtime has no DSH,
CodeBuddy, or model fallback path; Google owns external entitlement and billing
behavior. Navigator starts no login flow and forwards no provider credential
environment variables.

The local fake-ACP integration covers model selection/readback, model drift,
separate backend session mappings, restart loading, native permission identity,
one-time catalog approval, denial, cancellation, partial output, profile
credential isolation, and the DSH persistence-hook boundary. It does not run the
official binary, authenticate, send a model request, or prove a real connector
call.

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

## Business-agent merge boundary

When integrating older plugins or the Aether conversation work, retain the
CodeBuddy transport envelope, the shared evidence/retry policy, and host-side
provider-constraint validation. Merge conversation memory and presentation
features in their owning modules; do not replace the evidence policy with
feature-specific prompt text, treat a tool error as a successful fact, or move
execution authority out of the DSH AgentLoop. If both branches edit the prompt,
combine their policies and keep the transport rules explicit. Prompt text guides
the model; tool validation and durable receipts remain the enforceable boundary.
---
<!-- Chinese Translation / 中文翻译 -->

## 已拥有的适配器

- 持久化适配器将上游 Session event 映射到 Navigator 的 HTTP 持久化权威，并使用显式 lease 和接管机制。
- Codex 导入会调用 Navigator Rust host、保留来源 archive，且绝不重放历史工具。
- 客户端交付反馈会将已提交输入与持久化回执关联，并保留失败输入供用户显式恢复。
- Compaction 只在 compaction 请求中移除工具声明；输出不含文本时按 fail-closed 处理。
- CodeBuddy LLM 调用只使用受限结构化输出；现有 DSH AgentLoop 仍是唯一工具执行者，并且在发出 DSH tool-call block 前按当前工具目录检查工具名和参数。
- CodeBuddy prompt 会区分成功证据与失败观察；提交祖先关系必须有明确 compare 证据；`retryable` 为 false 或未知时不应重复同一调用。DSH 强制执行的 JSON Schema 子集未包含的 provider 约束会作为模型可见提示保留，Navigator 宿主 validator 仍是权威校验。这些规则用于改善行为，不能保证模型绝不作无依据陈述。
- 显式 `codebuddy-acp` Work Task backend 使用官方 ACP stdio 进程，不套 DSH reasoning loop。Navigator 继续拥有 Work/session 状态，并通过任务级 MCP bridge 只公开宿主授权的 Exchange 工具，复用现有授权与回执路径。

原生宿主通过 `CYRENE_NATIVE_HOST` 启动，不依赖外部 Platform 工具或源码。实现的方法由 `hello` 握手报告，范围仅限 Navigator 所有的操作。

ACP backends 只在单个 Navigator 进程内串行处理同一 Work Session，目前没有跨进程 Session lease。因此生产中同一个 Work SQLite 数据库及所选 provider 的私有 profile 必须只由一个 Navigator 进程/副本使用；不要让滚动部署重叠，也不要把同一状态路径挂载给另一个副本。跨进程 Session lease 后续单独实现。CodeBuddy 的 `HOME` 与 XDG 数据目录固定在持久私有路径 `CODEBUDDY_CONFIG_DIR/navigator-cli-home` 下；Antigravity 子进程 HOME 是 `CYRENE_HARNESS_ANTIGRAVITY_ACP_PROFILE`，XDG 路径位于其子目录。Antigravity profile 根目录须由进程拥有且权限为 `0700`；嵌套 XDG 目录须由同一进程拥有、位于该根目录且不是符号链接，运行时保留其已有权限位。容器替换后必须保持所选 profile 路径稳定。

取消、授权暂停、超时、EOF 或协议失败时，ACP run 会先取消任务级工具信号，再回收子进程和 MCP listener。关闭过程会在有界时间内等待宿主拥有的在途工具 handler。provider 忽略取消时，Work Task 会明确报告 cleanup 未完成；进行中的写入回执保持 uncertain，完成独立核对前不得重放。`exchange_operation_read` 可以读取 Exchange operation；模型返回一句确认或无关状态读取都不能把一般 uncertain Work 回执升级为成功。只有现有精确 cloud-operation readback 路径能自动核对匹配的 operation reference；其他 uncertain 回执需要独立权威读取和操作员核对。

## 兼容性与证据

Profile 测试使用真实固定版本 Harness CLI、Bundle、Rust host 和本地持久化进程。重点测试中的确定性模型适配器只是 fixture，不算真实模型推理。客户端 UI 集成测试完全由 Native Client（`Cyrene-Client`）负责。

原生 supervisor 矩阵保留取消、回收、协议版本、有界输出和凭据隔离检查。受控故障 fixture 只验证传输；Codex 导入仍通过真实 Navigator Rust host。

`CYRENE_HARNESS_MODEL_SOURCE` 为兼容旧部署默认 `exchange`，也可选择 `codebuddy` 或 `antigravity`。Antigravity 默认使用 `gemini-3.8-flash-medium`，要求服务 HOME 中存在固定的纯模型 agent profile；若设置 `CYRENE_HARNESS_MODEL`，其值必须属于 allowlist。生产 Docker executor 通过 `node scripts/serve-executor.mjs` 选择该 adapter；独立的 Python local-stack launcher 目前尚未接入。CodeBuddy adapter 默认模型为 `glm-5.3-flash`，并提供 `deepseek-v4.1-flash`。重点 adapter 测试用本地 fake CLI 验证进程参数、DSH 历史序列化、schema 校验、终态检查、超时和取消；这些测试不代表进行了带凭据的真实模型调用。

`CYRENE_HARNESS_EXECUTION_BACKEND` 默认 `dsh`；`codebuddy-acp` 是独立的顶层执行选择，并忽略旧 model-source selector。ACP 要求 `CYRENE_HARNESS_MODEL_SOURCE` 与 `CYRENE_HARNESS_MODEL` 为空、CodeBuddy fallback 为 false，并显式声明 `CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP=true`。供应商 CLI 没有可强制禁止使用已购 credits 的设置，因此该声明不构成扣费保证。本地 stub 测试覆盖 ACP、strict MCP、权限拒绝、子进程环境隔离、Work 回执、授权暂停、在途 handler 取消与清理、重启加载、EOF 和进程退出；不代表完成真实 CodeBuddy 登录或模型计费验收。

官方 Antigravity ACP backend 仅在设置 `CYRENE_HARNESS_EXECUTION_BACKEND=antigravity-acp` 后启用；默认仍为 `dsh`。生产环境通过 `CYRENE_HARNESS_ANTIGRAVITY_ACP_COMMAND` 设置官方 server 绝对路径，在其旁边安装 `localharness_external`，并将私有持久 profile 挂载到 `CYRENE_HARNESS_ANTIGRAVITY_ACP_PROFILE`。Linux 按官方 registry 固定传入 `--uid=`。Runtime 要求 `agentInfo.name=antigravity-acp` 和支持 built-in tool filter 的 ACP 版本；MCP server 使用 ACP v1 基线 stdio transport。若 profile 中存在全局 `~/.gemini/config/mcp_config.json` 则拒绝启动，确保 task-local Navigator server 是唯一自定义 MCP 来源。

`CYRENE_HARNESS_ANTIGRAVITY_ACP_MODEL` 可选。若设置，必须与原生 session model `configOptions` 的 value 完全相同，并且 server 必须在 prompt 前回读确认。若未设置，则使用 server 公布的当前模型；不会转换 legacy model variant。turn 中报告模型变更会让当前 turn 失败。Runtime 不提供 DSH、CodeBuddy 或模型 fallback；Google 管理外部账号 entitlement 和计费。Navigator 不启动登录流程，也不转发 provider credential 环境变量。

本地 fake ACP 集成覆盖模型选择和回读、模型漂移、backend session 隔离、重启续接、原生权限身份、目录匹配工具的一次性授权、拒绝、取消、部分输出、profile 凭据隔离及 DSH persistence hook 边界。它不会运行官方 binary、登录、发出模型请求或证明真实 connector call。

生成的 Profile 清单是 lockfile 组合快照。Profile patch 或上游 pin 变化时必须重新生成，不能把它作为运行成功证据。

## 上游补丁策略

Navigator 将改动保留在仓库自有 Cordis 插件和客户端扩展中。对上游 Harness 的修改应向上游提议，或作为明确且可审查的适配器保留；不得隐藏在安装脚本中。

## Business agent 合并边界

合入旧插件或 Aether conversation 改动时，必须保留 CodeBuddy transport envelope、共享证据/重试规则和宿主侧 provider constraint 校验。Conversation memory 与展示能力留在其所属模块；不能用功能专属 prompt 替换通用证据规则，不能把工具错误当作成功事实，也不能把执行权移出 DSH AgentLoop。若双方修改同一 prompt，应合并各自规则并保留明确的 transport 约束。Prompt 只指导模型；工具校验和持久化回执才是可执行的边界。
