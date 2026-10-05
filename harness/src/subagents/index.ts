// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator native subagent registry                          │
// │ Role: Register native CLI launch profiles on the DSH subagent seam.  │
// │ 模块职责：在 DSH 子 Agent seam 注册原生 CLI 启动配置。          │
// └─────────────────────────────────────────────────────────────────────┘

import type { Context } from '@deepseek-ai/cordis'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
// The pinned package root declaration omits this module's projection-state
// augmentation even though SubagentRuntime registers those projections.
import type {} from '@deepseek-ai/dsh-subagent/src/projection.ts'
import { AntigravitySubagentProvider } from './antigravity.js'
import { CodeBuddySubagentProvider } from './codebuddy.js'
import { AcpSubagentProvider } from './acp.js'
import {
  resolveTiming,
  validateDeployment,
  type ValidatedDeployment,
} from './common.js'
import type { SubagentAdapterConfig } from './types.js'

export type {
  NativeSubagentBackend,
  SubagentAdapterConfig,
  SubagentAdapterEvent,
  SubagentDeployment,
  SubagentPermissionDecision,
  SubagentPermissionRequest,
} from './types.js'

/**
 * Register native CLI providers on the pinned `ctx.subagents` service.
 *
 * Each deployment is explicit configuration owned by the Navigator host:
 * command and argv remain separate, environment values are selected by name,
 * and the cwd is fixed or inherited from the delegating DSH session. The
 * returned async disposer unregisters providers and waits for their children.
 *
 * @param ctx - DSH context carrying the existing subagent and subprocess services.
 * @param config - approved deployments and optional event/permission bridges.
 * @returns disposer for provider registrations and active process ranges.
 */
export function registerSubagents(ctx: Context, config: SubagentAdapterConfig): () => Promise<void> {
  if (!Array.isArray(config.deployments)) {
    throw new Error('navigator-subagents: deployments must be an array')
  }
  const timing = resolveTiming(config)
  const activeRuns = new Set<SubagentRun>()
  const unregister: Array<() => void> = []
  const names = new Set<string>()
  const deployments: ValidatedDeployment[] = []

  for (const deployment of config.deployments) {
    if (deployment.backend !== 'antigravity' && deployment.backend !== 'codebuddy' && deployment.backend !== 'acp') {
      throw new Error('navigator-subagents: deployment backend must be antigravity, codebuddy or acp')
    }
    const validated = validateDeployment(deployment, names)
    deployments.push(validated)
    names.add(validated.providerName)
  }

  try {
    for (const deployment of deployments) {
      const provider = deployment.backend === 'antigravity'
        ? new AntigravitySubagentProvider(
          ctx, deployment, config, timing.timeoutMs, timing.disposeGraceMs, activeRuns,
        )
        : deployment.backend === 'acp'
        ? new AcpSubagentProvider(
          ctx, deployment, config, timing.timeoutMs, timing.disposeGraceMs, activeRuns,
        )
        : new CodeBuddySubagentProvider(
          ctx, deployment, config, timing.timeoutMs, timing.disposeGraceMs, activeRuns,
        )
      unregister.push(ctx.subagents.registerProvider(provider))
    }
  } catch (error: unknown) {
    for (const dispose of [...unregister].reverse()) dispose()
    throw error
  }

  let disposal: Promise<void> | undefined
  return (): Promise<void> => (disposal ??= (async () => {
    for (const dispose of [...unregister].reverse()) dispose()
    const runs = [...activeRuns]
    const settled = await Promise.allSettled(runs.map(run => run.dispose()))
    const failures = settled.flatMap(item => item.status === 'rejected' ? [item.reason] : [])
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'navigator-subagents child cleanup failed')
  })())
}
