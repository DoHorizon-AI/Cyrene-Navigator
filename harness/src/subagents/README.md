# Native subagent providers / 原生子 Agent 提供方

This directory registers native Antigravity and CodeBuddy CLI processes as
providers on the pinned DSH `ctx.subagents` service. It adapts the upstream
subagent and subprocess contracts; it does not add another Agent loop, model
adapter, or session history store.

本目录把 Antigravity 与 CodeBuddy CLI 子进程注册为固定版本 DSH
`ctx.subagents` 服务的提供方。它适配上游 subagent 与 subprocess 契约，不新增
Agent loop、模型适配器或会话历史存储。

| File | Responsibility / 职责 |
| --- | --- |
| `types.ts` | Typed deployment, lifecycle event, and approval bridge contracts / 部署、生命周期事件与审批桥接类型 |
| `wire.ts` | Bounded UTF-8 NDJSON framing and JSON validation / 有界 UTF-8 NDJSON 封装与 JSON 校验 |
| `common.ts` | Deployment validation, DSH subprocess ownership, and common run lifecycle / 部署校验、DSH 子进程所有权与通用运行生命周期 |
| `antigravity.ts` | Documented Antigravity stream-json provider and conversation association / Antigravity 文档化 stream-json 提供方与 conversation 关联 |
| `antigravity-profile.ts` | Native safe-profile preflight / 原生安全配置启动前校验 |
| `antigravity-boundary.ts` | Bounded refusal classification and receipts / 有界拒绝分类与记录 |
| `codebuddy.ts` | CodeBuddy ACP stdio provider, permission relay, and session load / CodeBuddy ACP stdio 提供方、权限转发与 session load |
| `index.ts` | `registerSubagents(ctx, config)` public registration entry / 对外注册入口 |

Suggested reading order: `types.ts` → `wire.ts` → `common.ts` → the backend
providers → `index.ts`. Tests live in `../../tests/subagents.test.mjs` and run
without authenticating to either native CLI.

推荐阅读顺序：`types.ts` → `wire.ts` → `common.ts` → 两个后端提供方 → `index.ts`。
测试位于 `../../tests/subagents.test.mjs`，不会对任一原生 CLI 发起认证请求。

Antigravity defaults require explicit host profile initialization with
`node scripts/configure-antigravity-sandbox.mjs --apply`; the runtime only validates
it. A refused operation does not cancel the parent batch. Successful partial work
and blocked receipts reach the final summary; see `../../../docs/subagent-connectors.md`.

Antigravity 默认策略需显式初始化宿主配置；运行时只校验。单项拒绝不会取消整批，成功的部分结果与
无法执行记录会进入最终摘要，详见上述连接器文档。
