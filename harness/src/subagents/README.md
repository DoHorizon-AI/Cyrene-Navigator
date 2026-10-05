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
| `codebuddy.ts` | CodeBuddy ACP stdio provider, permission relay, and session load / CodeBuddy ACP stdio 提供方、权限转发与 session load |
| `index.ts` | `registerSubagents(ctx, config)` public registration entry / 对外注册入口 |

Suggested reading order: `types.ts` → `wire.ts` → `common.ts` → the backend
providers → `index.ts`. Tests live in `../../tests/subagents.test.mjs` and run
without authenticating to either native CLI.

推荐阅读顺序：`types.ts` → `wire.ts` → `common.ts` → 两个后端提供方 → `index.ts`。
测试位于 `../../tests/subagents.test.mjs`，不会对任一原生 CLI 发起认证请求。
