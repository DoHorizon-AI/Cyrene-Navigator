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
