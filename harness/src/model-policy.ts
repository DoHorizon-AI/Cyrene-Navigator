// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator model availability policy                         │
// │ Role: Select configured model routes and classify safe failover.     │
// │ 模块职责：选择已配置的模型路由并分类可安全切换的故障。                 │
// └─────────────────────────────────────────────────────────────────────┘

import type { LlmFailure, TokenUsage } from '@deepseek-ai/dsh-llm';

/** A real provider route; it is never presented as a synthetic model. */
export interface ModelRoute {
  readonly provider: string;
  readonly model: string;
}

/** Explicit opt-in facts required before CodeBuddy can be used as a backup. */
export interface CodeBuddyFallbackConfig {
  readonly enabled: boolean;
  readonly model?: string;
  readonly noPaidTopUp: boolean;
}

const CODEBUDDY_MODELS = new Set(['glm-5.3-flash', 'deepseek-v4.1-flash']);

/** Provider failures safe to retry through another configured provider route. */
const AVAILABILITY_FAILURE_CODES = new Set([
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_AUTH_REQUIRED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_QUOTA_EXHAUSTED',
]);

/**
 * Read the operator's opt-in CodeBuddy route without accepting implicit paid fallback.
 * @param environment - process environment or an explicit test fixture.
 * @returns The validated fallback configuration.
 * @throws TypeError when enabled fallback does not declare the no-paid-top-up policy.
 */
export function readCodeBuddyFallbackConfig(
  environment: Readonly<Record<string, string | undefined>>,
): CodeBuddyFallbackConfig {
  const enabledValue = environment.CYRENE_HARNESS_CODEBUDDY_FALLBACK_ENABLED;
  if (enabledValue !== undefined && enabledValue !== 'true' && enabledValue !== 'false') {
    throw new TypeError('CYRENE_HARNESS_CODEBUDDY_FALLBACK_ENABLED must be true or false');
  }
  const enabled = enabledValue === 'true';
  const noPaidTopUpValue = environment.CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP;
  if (noPaidTopUpValue !== undefined && noPaidTopUpValue !== 'true' && noPaidTopUpValue !== 'false') {
    throw new TypeError('CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP must be true or false');
  }
  const noPaidTopUp = noPaidTopUpValue === 'true';
  const configuredModel = environment.CYRENE_HARNESS_CODEBUDDY_FALLBACK_MODEL;
  if (enabled && !noPaidTopUp) {
    throw new TypeError('CodeBuddy fallback requires CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP=true');
  }
  if (!enabled) return { enabled: false, noPaidTopUp };
  const model = configuredModel ?? 'glm-5.3-flash';
  if (!CODEBUDDY_MODELS.has(model)) {
    throw new TypeError('CYRENE_HARNESS_CODEBUDDY_FALLBACK_MODEL is not an allowlisted CodeBuddy model');
  }
  return { enabled: true, noPaidTopUp, model };
}

/** Determine whether an upstream failure represents provider availability, not a protocol or tool error. */
export function isModelAvailabilityFailure(failure: Pick<LlmFailure, 'code'>): boolean {
  return AVAILABILITY_FAILURE_CODES.has(failure.code);
}

/** Format a route key consistently for the per-request failover set. */
export function modelRouteKey(route: ModelRoute): string {
  return `${route.provider}\u0000${route.model}`;
}

/**
 * Select the first configured route not already attempted for this DSH model step.
 * @param fallbacks - operator-enabled provider routes in priority order.
 * @param current - route that just failed.
 * @param attempted - provider routes already tried for this turn and step.
 * @returns One configured provider route, or undefined when no route remains.
 */
export function nextFallbackRoute(
  fallbacks: readonly ModelRoute[],
  current: ModelRoute,
  attempted: ReadonlySet<string>,
): ModelRoute | undefined {
  const currentKey = modelRouteKey(current);
  return fallbacks.find(route => modelRouteKey(route) !== currentKey && !attempted.has(modelRouteKey(route)));
}

/** Keep only authoritative non-negative token counts reported by a provider. */
export function decodeProviderTokenUsage(value: unknown): TokenUsage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const inputTokens = count(row.input_tokens ?? row.inputTokens ?? row.prompt_tokens);
  const outputTokens = count(row.output_tokens ?? row.outputTokens ?? row.completion_tokens);
  const totalTokens = count(row.total_tokens ?? row.totalTokens);
  const cacheReadTokens = count(row.cache_read_tokens ?? row.cacheReadTokens ?? row.cached_input_tokens);
  const cacheWriteTokens = count(row.cache_write_tokens ?? row.cacheWriteTokens);
  const reasoningTokens = count(row.reasoning_tokens ?? row.reasoningTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
