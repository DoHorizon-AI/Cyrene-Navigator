# Native CLI adapter compatibility / 原生 CLI 适配兼容性

This document defines the reusable contract for running native CLI agents as
Navigator subagents. A protocol match or a passing fixture does not certify a
vendor CLI. Keep implementation, portable test, real native process, and
end-to-end product-route evidence separate.

本文定义 Navigator 将原生 CLI Agent 作为子 Agent 运行时应遵守的通用契约。协议兼容或 fixture
通过都不等于某个厂商 CLI 已通过认证。实现、可移植测试、真实原生进程和端到端产品路由证据应分别记录。

The shared ACP provider and `backend: 'acp'` wiring are implemented.
Portable checks, CI, and native-run evidence are recorded separately at delivery. Registration of the generic backend does not establish
compatibility with every ACP agent or vendor.

共享 ACP 提供方和 `backend: 'acp'` 接线已经实现。可移植测试、CI 和原生运行证据在交付时分别记录。注册通用后端并不代表兼容所有 ACP Agent 或厂商。

## Provider and launch contract / 提供方与启动契约

Navigator has one shared ACP-over-stdio provider, with `backend: 'acp'`, plus
the existing Antigravity stream-json provider and the CodeBuddy launch profile
on the shared ACP implementation. ACP itself is the common wire contract;
each vendor still needs its own documented launch form and real-run evidence.

Navigator 使用一个共享 ACP-over-stdio 提供方（`backend: 'acp'`），并保留 Antigravity
stream-json 提供方和基于共享 ACP 实现的 CodeBuddy 启动配置。ACP 是共同线协议；每个厂商仍须具备
有文档依据的启动形式和真实运行证据。

| Backend | Launch behavior / 启动行为 |
| --- | --- |
| `antigravity` | Uses Antigravity's documented stream-json protocol and adapter-owned safety profile. / 使用 Antigravity 文档化的 stream-json 协议和适配器管理的安全配置。 |
| `codebuddy` | Uses shared ACP handling with the CodeBuddy-specific `--acp --acp-transport stdio --permission-mode default` launch profile. / 使用共享 ACP 处理，并由 CodeBuddy 专用启动配置添加相应参数。 |
| `acp` | Uses only the host-approved command and configured `argv`; it adds no CodeBuddy flags. / 只使用宿主批准的命令及配置的 `argv`，不会追加 CodeBuddy 参数。 |

For `backend: 'acp'`, `argv` may begin with one optional `acp` or `--acp`
transport selector, followed only by static `--model <id>` and/or
`--agent <id>` selectors. Values are deployment configuration, not prompt
content. Do not pass arbitrary flags or shell fragments. If an official CLI
requires another transport or launch option, an administrator must approve an
executable wrapper that owns those details; Navigator still starts it without
a shell and does not synthesize vendor flags.

`backend: 'acp'` 的 `argv` 可在开头包含一个可选的 `acp` 或 `--acp` 传输选择符，之后只允许静态
`--model <id>` 和/或 `--agent <id>` 选择符。参数值属于部署配置，不来自提示内容。不得传入任意参数或
shell 片段。若官方 CLI 需要其他传输或启动参数，管理员必须批准一个封装这些细节的可执行 wrapper；
Navigator 仍然不经 shell 启动它，也不会自动拼接厂商参数。

```ts
{
  backend: 'acp',
  providerName: 'vendor-assistant',
  command: 'vendor-assistant', // approved executable or approved wrapper
  argv: ['acp', '--model', 'model-id'],
}
```

The registry name defaults to `acp`; use a distinct `providerName` when more
than one ACP deployment may be registered. `command` and `argv` remain
separate, child processes are started through DSH's managed subprocess service,
and the command is never shell-interpreted. The host owns the executable,
working directory, environment references, native sign-in, and deployment
approval. Credential values must not be copied into Navigator configuration.

注册名默认是 `acp`；同时注册多个 ACP 部署时应使用不同的 `providerName`。`command` 与 `argv`
分开传递，子进程通过 DSH 受管 subprocess 服务启动，命令不会交给 shell 解释。宿主负责可执行文件、
工作目录、环境引用、原生登录和部署审批。不得将凭据值复制到 Navigator 配置中。

## ACP protocol and permission rules / ACP 协议与权限规则

The client initializes ACP v1 before creating or loading a session. It calls
`session/load` only when the initialize response advertises
`agentCapabilities.loadSession`; otherwise it creates a new session. ACP
`authMethods` lists available authentication methods and is not a signed-in
state bit. Use the CLI's existing host login. Do not call `authenticate`,
extract credentials, or hide an actual `auth_required` response.

客户端必须先初始化 ACP v1，再创建或加载 session。只有初始化响应声明
`agentCapabilities.loadSession` 时才调用 `session/load`；否则创建新 session。ACP 的
`authMethods` 表示可用认证方式，不代表当前登录状态。使用 CLI 在宿主上的现有登录；不得调用
`authenticate`、提取凭据或隐藏真实的 `auth_required` 响应。

ACP tool-call updates carry fields such as `kind`, `status`, and `toolCallId`
directly in the update object. Parse the standard flat shape, ignore absent
optional update fields, and suppress repeated status reports for the same
tool-call identifier with bounded state. Tool `name` is informational metadata,
not a permission or capability declaration. If `kind` is absent or unknown,
route the request for explicit host review as unknown; never infer approval
from a tool name or title. See the official [ACP Tool Calls
specification](https://agentclientprotocol.com/protocol/v1/tool-calls).

ACP 工具调用更新会把 `kind`、`status`、`toolCallId` 等字段直接放在 update 对象中。应解析标准平铺
结构，忽略缺失的可选更新字段，并用有界状态抑制同一 tool-call 标识的重复状态。工具 `name` 只是说明
元数据，不是权限或能力声明。若缺少 `kind` 或其值未知，应按 unknown 交由宿主明确审核；不得根据工具
名称或标题推断批准。详见官方 [ACP Tool Calls 规范](https://agentclientprotocol.com/protocol/v1/tool-calls)。

The provider currently advertises an empty ACP `clientCapabilities` object.
An agent that requires Client-provided filesystem or terminal services is not
covered by the generic stdio implementation. Add the official SDK or protocol
capability implementation and test it before claiming that profile is
compatible; unsupported incoming requests must fail explicitly.

提供方当前向 ACP 声明空的 `clientCapabilities`。需要 Client 提供文件系统或终端服务的 Agent 不在
通用 stdio 实现的支持范围内。只有补齐官方 SDK 或协议能力实现并完成测试后，才能声称兼容该配置；
未支持的入站请求必须明确失败。

Native session IDs are currently associated with DSH parent sessions in
provider memory. `session/load` therefore depends on that association surviving;
Navigator task/SSE persistence does not prove that native session association
recovers after a host restart. Acceptance must cover restart recovery using the
existing persistence layer for provider, parent-session, and native-session
references. Do not create a second conversation-history store.

当前通过提供方内存将原生 session ID 关联到 DSH parent session。因此 `session/load` 依赖该关联仍然
存在；Navigator task/SSE 持久化不能证明宿主重启后原生 session 关联可恢复。验收必须使用现有持久化层
覆盖重启恢复，并保存提供方、父 session 与原生 session 的引用。不得另建第二套会话历史存储。

The host callback is the only approval authority. The adapter may select a
native `allow_once` option only after an explicit host `allow-once` decision;
it never selects persistent approval. On denial, select `reject_once` when the
agent offers it so independent work can continue. Return ACP's `cancelled`
outcome for actual caller cancellation, or when no safe reject-once option is
available. A vendor may still stop the entire prompt after receiving
`reject_once`; fixture continuation does not prove native continuation. See
the official [ACP Session Setup
specification](https://agentclientprotocol.com/protocol/v1/session-setup) for
capability-negotiated session loading.

宿主回调是唯一审批权威。只有宿主明确返回 `allow-once` 后，适配器才可选择原生 `allow_once`；不会
选择永久授权。拒绝时，如果 Agent 提供 `reject_once`，应选择该选项以便其他独立工作继续。只有调用方
确实取消，或没有安全的本次拒绝选项时，才返回 ACP `cancelled`。厂商收到 `reject_once` 后仍可能结束
整个 prompt；fixture 中继续工作不能证明原生 CLI 也会继续。有关按能力协商加载 session，详见官方
[ACP Session Setup 规范](https://agentclientprotocol.com/protocol/v1/session-setup)。

## Bounds, errors, and child lifetime / 边界、错误与子进程生命周期

Native stdio is strict UTF-8 NDJSON. Keep the current per-frame limit at
1 MiB, per-turn stream limit at 16 MiB, frame-count limit at 100,000,
assistant-output limit at 2 MiB, and identifier limit at 512 bytes. Reject
malformed, incomplete, or oversized frames. Shared typed wire failures expose
a fixed diagnostic code and bounded byte/frame count fields; they must not
retain raw frames, vendor error text, stderr, prompts, paths, or tokens.

原生 stdio 使用严格 UTF-8 NDJSON。单帧上限保持为 1 MiB，单轮数据流上限为 16 MiB，帧数上限为
100,000，助手输出上限为 2 MiB，标识符上限为 512 字节。畸形、不完整或超限帧必须拒绝。共享 wire
错误只暴露固定诊断码和有界字节/帧计数字段；不得保留原始帧、厂商错误文本、stderr、提示、路径或 token。

Every run uses DSH's managed child-process lifecycle. On disposal, close
stdin, wait for the configured grace period, terminate the managed process
range if needed, and wait for exit. Cancellation and cleanup must not leave an
unreaped child. Do not automatically retry a command after an ambiguous
failure: it may already have performed a side effect. Preserve valid partial
assistant output alongside a failed or cancelled terminal result; never turn
partial output into a success claim.

每次运行都使用 DSH 受管子进程生命周期。销毁时关闭 stdin，等待配置的宽限期；必要时终止受管进程范围，
并等待进程退出。取消和清理不得遗留未回收的子进程。结果不明确时不得自动重试命令，因为它可能已经产生
副作用。失败或取消的终态结果应保留有效的部分助手输出，但不得把部分输出描述为成功。

Local cancellation and protocol cancellation have separate evidence gates.
Explicit disposal attempts `session/cancel` before settling local requests.
Direct caller-signal abort currently fails the peer and terminates the managed
child before that notification can be sent. A promptly settled result and a
reaped child therefore do not prove that the native agent received or processed
the notification. A future cooperative-cancellation implementation must retain
a bounded forced-stop path and test native receipt separately.

本地取消与协议取消需要分别验收。显式销毁会先尝试发送 `session/cancel`，再结算本地请求。
调用方信号直接中止时，当前实现会先使协议端失败并终止受管子进程，导致取消通知无法发出。
因此，及时结算结果且回收子进程不能证明原生 Agent 已收到或处理通知。后续协作式取消实现必须保留
有期限的强制停止路径，并单独验证原生通知接收。

## Acceptance checklist / 验收清单

Each adapter change should satisfy the portable fixture checks and, for every
vendor and supported execution host, a separate opt-in native check. Record
the exact adapter source revision, CLI version, host OS/architecture, configured
selector, and model/agent actually reported by the native session. A native
provider call proves only that provider/subprocess path; HTTP, Client, cloud,
Exchange, and business workflow routing require their own evidence.

每项适配器变更都应通过可移植 fixture 检查；对每个厂商和每种受支持执行宿主，还要单独进行可选的原生
检查。记录适配器源码版本、CLI 版本、宿主 OS/架构、配置的选择符，以及原生 session 实际报告的模型或
Agent。原生提供方调用只证明提供方/子进程路径；HTTP、Client、云端、Exchange 和业务流程路由都需要
各自的证据。

| Area | Portable fixture gate | Native evidence gate |
| --- | --- | --- |
| Launch and protocol | Verify the exact command/argv, no shell use, ACP v1 initialization, standard stdio framing, and no CodeBuddy flags on `backend: 'acp'`. / 校验命令与参数、无 shell、ACP v1 初始化、标准 stdio 封装，以及通用 ACP 不带 CodeBuddy 参数。 | Run the official CLI or approved wrapper on each claimed host and confirm ACP v1 session creation. / 在每个声称支持的宿主运行官方 CLI 或批准的 wrapper，并确认创建 ACP v1 session。 |
| Model/agent selection | Reject unsupported, repeated, or dynamic selector arguments. / 拒绝不支持、重复或动态选择参数。 | Confirm the actual selected model/agent in native protocol evidence; do not infer it from requested argv. / 从原生协议证据确认实际选择的模型或 Agent，不能只根据请求参数推断。 |
| Auth and sessions | Cover advertised `authMethods`, actual `auth_required`, and both `loadSession` capability values. / 覆盖 `authMethods` 声明、真实 `auth_required` 及 `loadSession` 能力的两种取值。 | Verify cached host login without an authenticate flow; if login is unavailable, retain explicit auth failure. / 验证宿主缓存登录且不触发 authenticate 流程；登录不可用时保留明确认证失败。 |
| Client capabilities and restart | Fail clearly when an unadvertised filesystem/terminal request arrives; test provider-to-parent-to-native session reference persistence across host restart. / 未声明的文件系统/终端请求应明确失败；验证宿主重启后提供方、父 session 与原生 session 引用的持久化。 | Test an agent requiring each advertised Client capability and read back native session association after restart. / 对需要各项已声明 Client 能力的 Agent 进行测试，并在重启后回读原生 session 关联。 |
| Permissions and progress | Cover flat status fields, absent/unknown `kind`, explicit host allow-once, reject-once, no reject option, and actual cancellation. / 覆盖平铺状态、缺失/未知 `kind`、宿主明确一次批准、本次拒绝、无拒绝选项和真实取消。 | Observe the vendor's prompt result after allow/deny/cancel; do not assume it continues after reject-once. / 观察厂商在批准、拒绝、取消后的 prompt 结果；不得假设 reject-once 后会继续。 |
| Errors, bounds, and privacy | Cover malformed UTF-8/JSON, incomplete and oversized frames, stream/frame/output limits, fixed wire codes and counts, and absence of raw error/token retention. / 覆盖畸形 UTF-8/JSON、不完整及超限帧、数据流/帧数/输出上限、固定 wire 码与计数，以及不保留原始错误/token。 | Keep native diagnostics summarized to approved codes/counts; never store raw prompts or credentials in evidence. / 原生诊断只保留获准的错误码/计数；证据中不得保存原始提示或凭据。 |
| Partial work and cleanup | Verify a terminal error preserves completed output, invokes no automatic retry, and reaps the child for cancellation, timeout, and disposal. / 验证终态错误保留已完成输出、不自动重试，并在取消、超时和销毁时回收子进程。 | For a bounded private task, read back the artifact and terminal result independently; distinguish partial completion from task success. / 对有界私有任务，独立回读产物和终态结果，区分部分完成与任务成功。 |

Do not add an Exchange proxy or a second agent executor to this integration.
Navigator adapts the native CLI to the existing DSH subagent seam.

此集成不增加 Exchange 代理或第二套 Agent 执行器。Navigator 只将原生 CLI 适配到现有 DSH 子 Agent 接口。

## Recorded evidence and open work / 已记录证据与待查事项

The following is historical, host-scoped evidence, not a broad vendor support
claim. `FIXED` means the named adapter behavior has code and portable evidence;
`OBSERVED` means a bounded native run happened; `OPEN` and `NOT_RUN` remain
unproven.

以下是有宿主范围的历史证据，不代表对厂商功能的广泛支持声明。`FIXED` 表示对应适配器行为已有代码和
可移植证据；`OBSERVED` 表示执行过有界原生运行；`OPEN` 与 `NOT_RUN` 仍未得到证明。

| Status | Evidence / 证据 |
| --- | --- |
| **FIXED — PR #33** | ACP `authMethods` was initially mistaken for a logged-out state. A real cached-login session succeeded without `authenticate`; the adapter now lets the native session operation decide and reports actual `auth_required`. / 最初错误地把 ACP `authMethods` 当作未登录状态。真实缓存登录已在不调用 `authenticate` 的情况下创建会话；适配器现在由原生会话操作判断，并报告真实的 `auth_required`。 |
| **FIXED — PR #34** | ACP flat tool status fields were ignored and operation denial was returned as cancellation. The adapter now reads the standard flat update shape and selects native `reject_once` when available. / ACP 平铺工具状态字段曾被忽略，操作拒绝也曾被当作取消返回。适配器现在解析标准平铺更新，并在可用时选择原生 `reject_once`。 |
| **FIXED — local disposal** | A notification-ignoring peer reproduced pending prompt settlement waiting for the full turn deadline after disposal. Local disposal now rejects pending ACP requests and aborts outstanding host approvals independently of the caller signal; regression tests use a 60-second turn deadline and a one-second settlement bound. / 忽略取消通知的模拟端复现了销毁后 prompt 仍等待整轮超时的问题。现在本地销毁会结算 ACP 请求并取消待处理宿主审批，不依赖调用方信号；回归测试采用 60 秒整轮期限和 1 秒结算上限。 |
| **FIXED — retained output and first cause** | Both providers check UTF-8 bytes before appending an output chunk. Oversized output retains only the valid prefix within 2 MiB. Antigravity latches the first failure so cleanup EOF cannot replace the output-limit cause. / 两个提供方在追加输出前检查 UTF-8 字节数，超限时只保留 2 MiB 内的有效前缀。Antigravity 保留首个故障，避免清理 EOF 覆盖输出超限原因。 |
| **OBSERVED — generic ACP regression** | Linux WSL2 CodeBuddy with the approved default-permission launcher completed a generic ACP call using the observed `glm-5.3` model in 15.74 seconds. A separate active-run disposal settled locally in 3 ms and reaped the native child. This establishes reuse with the tested CLI, not other vendors. / Linux WSL2 上的 CodeBuddy 经审核的默认权限启动器，以实际观测到的 `glm-5.3` 在 15.74 秒内完成通用 ACP 调用。另一次运行中的销毁在本地 3 毫秒内结算，并回收原生子进程。这证明已测 CLI 的共用能力，不代表其他厂商。 |
| **OPEN — current Antigravity availability** | A further bounded `gemini-3.8-flash-medium` marker call connected and reported the configured model but did not return within its 90-second turn deadline. The child was reaped; no host fallback or permission elevation was used. Native availability remains unresolved. / 再次对 `gemini-3.8-flash-medium` 发起有界简短调用，已连接且报告配置模型，但未在 90 秒整轮期限内返回。子进程已回收，未回退到宿主执行或提升权限；原生可用性仍待定位。 |
| **OPEN — vendor denial behavior** | The tested CodeBuddy CLI may still end the whole prompt as `cancelled` after receiving `reject_once`. Fixture continuation proves protocol handling only, not native vendor continuation. / 已测 CodeBuddy CLI 收到 `reject_once` 后仍可能以 `cancelled` 结束整个 prompt。Fixture 继续执行只能证明协议处理，不能证明原生厂商 CLI 会继续。 |
| **OPEN — cooperative cancellation** | Direct caller-signal abort currently terminates the managed child before `session/cancel` can be sent. Explicit disposal attempts the notification, but the native test establishes only local settlement and reaping. A future change needs a bounded grace period plus separate notification-receipt evidence. / 调用方信号直接中止时，当前实现会先终止受管子进程，无法发送 `session/cancel`。显式销毁会尝试通知，但原生测试只证明本地结算和回收。后续变更需要有界宽限期，以及单独的通知接收证据。 |
| **OPEN — incomplete permission metadata** | A request with absent or unknown `kind` must receive explicit host review as unknown. Tool names and titles must never trigger automatic approval. / `kind` 缺失或未知的请求必须作为 unknown 交由宿主明确审核。工具名称和标题不得触发自动批准。 |
| **OPEN — client capabilities** | The shared ACP client currently advertises `{}`. An ACP agent requiring Client filesystem or terminal methods needs a documented capability implementation and native test before it can be called compatible. / 共享 ACP 客户端当前声明 `{}`。需要 Client 文件系统或终端方法的 ACP Agent，必须完成有文档依据的能力实现及原生测试后才能称为兼容。 |
| **OPEN — host restart association** | Native conversation IDs live in provider memory. Durable Navigator tasks/SSE do not establish that `provider + parent session + native session` association survives restart; recovery must use existing persistence, without a second history store. / 原生 conversation ID 位于提供方内存中。Navigator 持久任务/SSE 不能证明 `provider + parent session + native session` 关联可跨重启保留；恢复必须使用现有持久化能力，不能另建历史存储。 |
| **OBSERVED — model selectors** | On Linux WSL2 x86_64, native session evidence reported `gemini-3.8-flash-medium` for Antigravity and `glm-5.3` for CodeBuddy. No fallback model was configured. These observations do not certify other versions, hosts, or vendors. / 在 Linux WSL2 x86_64 上，原生 session 证据报告 Antigravity 使用 `gemini-3.8-flash-medium`、CodeBuddy 使用 `glm-5.3`。没有配置备用模型。这些观察不代表其他版本、宿主或厂商也已验证。 |
| **SNAPSHOT_ONLY — smoke verdict** | Review found malformed sandbox-smoke evidence could pass two fail-closed checks. A separate experimental snapshot corrected the pure verdict checks and passed 25/25 tests; that snapshot is not merged production evidence and does not prove native sandbox enforcement. / 审查发现畸形 sandbox-smoke 证据可能通过两项 fail-closed 检查。独立实验快照修复了纯 verdict 校验并通过 25/25 项测试；该快照未合入生产代码，也不能证明原生沙箱实际生效。 |
| **OBSERVED / UNKNOWN — GLM task sizes** | A small bounded CodeBuddy note task completed in 37.74 seconds with host allow-once, artifact read-back, and child reaping. A larger cancellation-test coding task produced no accepted artifact and ended in timeout/error; its cause is unknown. Do not infer auth, quota, or sandbox failure, and do not generalize the small task into coding reliability. / 一个小型有界 CodeBuddy 记录任务在 37.74 秒内完成，宿主执行一次批准，产物已回读且子进程已回收。较大的取消测试编码任务未产出被接受的产物，并以超时/错误结束；具体原因未知。不得推断为认证、额度或沙箱故障，也不得用小任务概括编码可靠性。 |
| **OBSERVED — partial output** | A Gemini task wrote useful files and returned 6,243 characters of partial output but ended with `NATIVE_CONNECTION_UNAVAILABLE`; it was not a pass. Retain valid partial work while keeping the failed terminal status. / 一个 Gemini 任务写入了有用文件并返回 6,243 个字符的部分输出，但最终以 `NATIVE_CONNECTION_UNAVAILABLE` 结束，因此不算通过。保留有效部分工作，同时保留失败终态。 |
| **NOT_RUN / UNVERIFIED** | Windows/ARM64 native subscription work, full HTTP/Client/cloud-to-local execution, VM migration, and a fully observed Antigravity sandbox refusal followed by allowed continuation remain unrun or unverified. Other ACP vendors also need their own official launch evidence and native checks. / Windows/ARM64 原生订阅任务、完整 HTTP/Client/云端到本地执行、VM 迁移，以及完整观测的 Antigravity 沙箱拒绝后继续执行，仍未运行或未验证。其他 ACP 厂商也需要各自的官方启动证据和原生检查。 |

## Acceptance reporting / 验收记录

Report each check as `PASS`, `FAIL`, `INCOMPLETE`, `OPEN`, or `NOT_RUN` with
the tested backend and evidence layer. Keep experimental snapshots distinct
from merged source, CI results, native process runs, and end-to-end product
runs. Preserve partial outputs without changing failed or unknown terminal
states to success.

每项检查都应标为 `PASS`、`FAIL`、`INCOMPLETE`、`OPEN` 或 `NOT_RUN`，并注明后端及证据层级。
实验快照、已合入源码、CI 结果、原生进程运行和端到端产品运行应分别记录。保留部分输出时，不得将失败
或未知终态改写为成功。
