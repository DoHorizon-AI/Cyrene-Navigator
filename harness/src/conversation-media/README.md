# Conversation media bridge

This directory connects trusted DSH turns to the Navigator media analysis route.
It sends opaque Work message and artifact IDs only. The persistence host resolves
the actor-private running task, loads the canonical user message, authorizes its
attachment against current source lineage, reads the bytes through Work, and
returns a typed context contribution after rechecking authorization.

| File | Responsibility |
|---|---|
| `bridge.ts` | Authenticated HTTP client and strict response decoder for media analysis. |
| `feature.ts` | DSH context hook, source authorization, cancellation checks, and contribution proof. |
| `index.ts` | Stable package entrypoint for the Harness host. |

Call `createConversationMediaFeature` from the Harness after-attachment hook and
bind it to the same `TrustedTurnContext` signal and `ConversationMemoryApiV1`
used by the other conversation features. Connector delivery remains in the
Host's normal outbound path; this module only returns context contributions.

本目录把可信 DSH 回合连接到 Navigator 媒体分析路由，只发送 Work 消息和附件的 opaque ID。
持久化宿主负责解析 actor-private running task、读取 canonical user message、按当前 source
lineage 授权附件、通过 Work GET 读取字节，并在推理后复验授权再返回 typed context contribution。

| 文件 | 职责 |
|---|---|
| `bridge.ts` | 媒体分析 HTTP 客户端与严格响应解码。 |
| `feature.ts` | DSH 上下文 hook、来源授权、取消检查与贡献证明。 |
| `index.ts` | Harness host 使用的稳定导出入口。 |

由 Harness 的 after-attachment hook 调用 `createConversationMediaFeature`，并传入与其他对话能力相同的
`TrustedTurnContext` signal 和 `ConversationMemoryApiV1`。连接器发送仍由 Host 原有发送流程负责；本模块只返回上下文贡献。
