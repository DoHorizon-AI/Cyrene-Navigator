// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator compaction profile                                 │
// │ Role: Keep compaction summaries text-only without changing Agent tools.│
// │ 模块职责：仅为 compaction 请求移除工具声明，不改变 Agent 工具集合。    │
// └─────────────────────────────────────────────────────────────────────┘

import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  SummarizationInput,
  SummaryResult,
} from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'

/**
 * Navigator's compaction backend.
 *
 * The upstream basic backend intentionally replays the current conversation's
 * tool schemas to preserve a warm provider prefix. Some OpenAI-compatible
 * providers can answer that auxiliary `purpose=compaction` request with only a
 * tool call, which has no text for the upstream summary projection. This
 * profile narrows only the auxiliary summarization input through the upstream
 * protected hook; the normal Agent request path and its tools are untouched.
 * 中文：Navigator 的 compaction 后端。上游基础后端会刻意重放当前对话的工具 schema，以保留 Provider 热前缀。某些 OpenAI 兼容 Provider 对辅助的 `purpose=compaction` 请求只返回工具调用，导致上游摘要投影没有文本。此 Profile 通过上游受保护 hook，只收窄辅助摘要请求的输入；正常 Agent 请求路径及其工具保持不变。
 */
export default class NavigatorCompactionEngine extends BasicCompactionEngine {
  /**
   * Ask the upstream summarizer for a text checkpoint without tool schemas.
   *
   * `BasicCompactionEngine.summarize` is the public extension seam for a
   * profile-specific summary policy. Keeping the call delegated to `super`
   * preserves its routing, `purpose: 'compaction'`, cancellation, usage, and
   * fail-closed text projection behavior.
   *
   * @param input - replayed conversation region selected by upstream policy.
   * @param agent - routed conversation owner supplied by upstream policy.
   * @param signal - cancellation forwarded to the provider adapter.
   * @returns the upstream summary result and provider-reported metadata.
   * 中文：请求上游摘要器在不携带工具 schema 的情况下生成文本检查点。`BasicCompactionEngine.summarize` 是公开的 Profile 摘要策略扩展点。调用仍委托给 `super`，以保留其路由、`purpose: 'compaction'`、取消、用量和 fail-closed 文本投影行为。`input` 是上游策略选定的重放对话片段；`agent` 是上游策略提供的路由对话 owner；`signal` 会被转发给 Provider 适配器用于取消；返回上游摘要结果和 Provider 报告的元数据。
   */
  protected override summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const { tools: _tools, ...textOnlyInput } = input
    return super.summarize(textOnlyInput, agent, signal)
  }
}
