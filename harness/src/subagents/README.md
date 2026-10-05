# Native subagent providers / 原生子 Agent 提供方

This directory registers native Antigravity stream-json and ACP-over-stdio CLI
processes as providers on the pinned DSH `ctx.subagents` service. `acp.ts`
contains the shared ACP implementation; `codebuddy.ts` retains CodeBuddy's
native launch profile. These adapters use the upstream subagent and subprocess
contracts; they do not add another Agent loop, model adapter, or session history
store.

本目录把 Antigravity stream-json 与 ACP-over-stdio CLI 子进程注册为固定版本 DSH
`ctx.subagents` 服务的提供方。`acp.ts` 实现共享 ACP 逻辑；`codebuddy.ts` 保留 CodeBuddy
原生启动配置。适配器遵循上游 subagent 与 subprocess 契约，不新增 Agent loop、模型适配器或会话历史存储。

| File | Responsibility / 职责 |
| --- | --- |
| `types.ts` | Typed deployment, lifecycle event, and approval bridge contracts / 部署、生命周期事件与审批桥接类型 |
| `wire.ts` | Bounded UTF-8 NDJSON framing and JSON validation / 有界 UTF-8 NDJSON 封装与 JSON 校验 |
| `common.ts` | Deployment validation, DSH subprocess ownership, and common run lifecycle / 部署校验、DSH 子进程所有权与通用运行生命周期 |
| `acp.ts` | Shared ACP v1 stdio/session provider for `acp` and CodeBuddy deployments / 为 `acp` 与 CodeBuddy 部署提供共享 ACP v1 stdio/session 运行时 |
| `antigravity.ts` | Documented Antigravity stream-json provider and conversation association / Antigravity 文档化 stream-json 提供方与 conversation 关联 |
| `antigravity-profile.ts` | Native safe-profile preflight / 原生安全配置启动前校验 |
| `antigravity-boundary.ts` | Bounded refusal classification and receipts / 有界拒绝分类与记录 |
| `codebuddy.ts` | Backward-compatible CodeBuddy provider name and native ACP launch profile / 向后兼容的 CodeBuddy 提供方名称与原生 ACP 启动配置 |
| `index.ts` | `registerSubagents(ctx, config)` public registration entry / 对外注册入口 |

Suggested reading order: `types.ts` → `wire.ts` → `common.ts` → `acp.ts` and
the backend profiles → `index.ts`. Portable tests live in
`../../tests/subagents.test.mjs` and do not authenticate to a native CLI. The
shared launch and acceptance contract is in
[`docs/cli-adapter-compatibility.md`](../../../docs/cli-adapter-compatibility.md).

推荐阅读顺序：`types.ts` → `wire.ts` → `common.ts` → `acp.ts` 与各后端配置 → `index.ts`。
可移植测试位于 `../../tests/subagents.test.mjs`，不会对原生 CLI 发起认证请求。共享启动与验收契约见
[`docs/cli-adapter-compatibility.md`](../../../docs/cli-adapter-compatibility.md)。

Antigravity defaults require explicit host profile initialization with
`node scripts/configure-antigravity-sandbox.mjs --apply`; the runtime only validates
it. ACP approvals are host-mediated and allow-once only. A refusal selects
`reject_once` when available, but the native CLI may still end its prompt;
see `../../../docs/subagent-connectors.md` and the compatibility checklist.

Antigravity 默认策略需显式初始化宿主配置；运行时只校验。ACP 审批由宿主处理，且只允许一次性批准。
拒绝时如果可用则选择 `reject_once`，但原生 CLI 仍可能结束 prompt；详见上述连接器文档和兼容性验收清单。
