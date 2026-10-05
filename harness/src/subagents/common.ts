// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator native subagent lifecycle                         │
// │ Role: Resolve approved deployment facts and own child process exit. │
// │ 模块职责：校验部署事实并管理原生子 Agent 子进程生命周期。               │
// └─────────────────────────────────────────────────────────────────────┘

import { randomUUID } from 'node:crypto'
import { validateConfiguredCwd, resolveChildCwd } from '@deepseek-ai/dsh-subagent'
import { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SubagentAdapterConfig, SubagentDeployment, NativeSubagentBackend } from './types.js'

/** Grace before termination is escalated through the managed subprocess range. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Startup handshake bound keeps an unavailable CLI from wedging a parent turn. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 20_000

/** Default native child turn bound. */
export const DEFAULT_TURN_TIMEOUT_MS = 900_000

/** A provider failure contains only stable facts, never protocol contents. */
export class NativeSubagentFailure extends Error {
  constructor(
    message: string,
    readonly diagnostic: string,
  ) {
    super(message)
    this.name = 'NativeSubagentFailure'
  }
}

/** Validate argument overrides and reject all flags except static model selectors. */
export function validateDeployment(
  deployment: SubagentDeployment,
  usedProviderNames: ReadonlySet<string>,
): ValidatedDeployment {
  const prefix = `navigator-subagent-${deployment.backend}`
  if (deployment.command.trim().length === 0 || deployment.command.includes('\0')) {
    throw new Error(`${prefix}: deployment command must be non-empty and contain no NUL byte`)
  }
  const providerName = deployment.providerName ?? deployment.backend
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(providerName)) {
    throw new Error(`${prefix}: providerName must be a short registry identifier`)
  }
  if (usedProviderNames.has(providerName)) {
    throw new Error(`navigator-subagents: duplicate providerName "${providerName}"`)
  }
  const argv = validateSelectorArgv(deployment.backend, deployment.argv ?? [])
  const cwd = validateConfiguredCwd(prefix, deployment.cwd)
  const envRefs = validateEnvironmentReferences(deployment.envRefs ?? {})
  return { ...deployment, providerName, argv, cwd, envRefs }
}

/** Complete deployment after validation at registration time. */
export interface ValidatedDeployment extends SubagentDeployment {
  readonly providerName: string
  readonly argv: readonly string[]
  readonly cwd: string | undefined
  readonly envRefs: Readonly<Record<string, string>>
}

/** Check flag spelling, values, multiplicity, and backend-specific support. */
function validateSelectorArgv(backend: NativeSubagentBackend, argv: readonly string[]): readonly string[] {
  const allowed = backend === 'antigravity'
    ? new Set(['--model', '--effort', '--agent'])
    : new Set(['--model', '--agent'])
  const seen = new Set<string>()
  const result: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined || token.length === 0 || token.includes('\0')) {
      throw new Error(`navigator-subagent-${backend}: argv contains an empty or invalid value`)
    }
    const equalAt = token.indexOf('=')
    const flag = equalAt < 0 ? token : token.slice(0, equalAt)
    if (!allowed.has(flag)) {
      throw new Error(`navigator-subagent-${backend}: argv flag ${JSON.stringify(flag)} is not allowed`)
    }
    if (seen.has(flag)) throw new Error(`navigator-subagent-${backend}: duplicate argv flag ${flag}`)
    seen.add(flag)
    const value = equalAt < 0 ? argv[index + 1] : token.slice(equalAt + 1)
    if (value === undefined || value.length === 0 || value.startsWith('--') || value.includes('\0')) {
      throw new Error(`navigator-subagent-${backend}: ${flag} requires one non-empty scalar value`)
    }
    if (equalAt < 0) {
      result.push(flag, value)
      index += 1
    } else {
      result.push(`${flag}=${value}`)
    }
  }
  return result
}

/** Validate environment forwarding as explicit name references, never host values. */
function validateEnvironmentReferences(
  refs: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const [childName, hostName] of Object.entries(refs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(childName) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(hostName)) {
      throw new Error('navigator-subagents: environment references require valid environment variable names')
    }
    if (/(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|CREDENTIAL|AUTH)/iu.test(childName)
      || /(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|CREDENTIAL|AUTH)/iu.test(hostName)) {
      throw new Error('navigator-subagents: credential environment forwarding is not supported; native CLI credentials stay with the host')
    }
    const protectedName = childName.toUpperCase()
    if (protectedName.startsWith('DSH_') || protectedName === 'PATH' || protectedName === 'HOME'
      || protectedName === 'NODE_OPTIONS' || protectedName === 'LD_PRELOAD'
      || protectedName === 'DYLD_INSERT_LIBRARIES' || protectedName.startsWith('SUBPROCESS_')) {
      throw new Error(`navigator-subagents: environment target ${childName} is reserved`)
    }
    result[childName] = hostName
  }
  return result
}

/** Resolve only explicitly named host environment references for one spawn. */
export function resolveChildEnvironment(deployment: ValidatedDeployment): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [childName, hostName] of Object.entries(deployment.envRefs)) {
    const value = process.env[hostName]
    if (value === undefined) {
      throw new Error(`navigator-subagent-${deployment.backend}: configured environment reference ${hostName} is unavailable`)
    }
    env[childName] = value
  }
  return env
}

/** Resolve an explicit cwd or the delegating DSH session workspace. */
export function resolveRunCwd(
  deployment: ValidatedDeployment,
  request: SubagentStartRequest,
): string {
  return resolveChildCwd(
    `navigator-subagent-${deployment.backend}`,
    deployment.cwd,
    request.parent.session.header.cwd,
  )
}

/** Create a parent-scoped run id that cannot collide with native ids. */
export function createRunId(): SessionId {
  return randomUUID() as SessionId
}

/** Text-only transports reject unsupported content rather than silently dropping it. */
export function promptText(request: SubagentStartRequest): string {
  let output = ''
  for (const block of request.prompt) {
    if (block.type !== 'text') {
      throw new Error(`navigator-subagents: native provider does not support prompt content type "${block.type}"`)
    }
    output += block.text
  }
  return output
}

/** Spawn through DSH's managed subprocess service with explicit stdio and host env references. */
export function spawnNativeChild(
  ctx: Context,
  deployment: ValidatedDeployment,
  cwd: string,
  argv: readonly string[],
  signal: AbortSignal,
  disposeGraceMs: number,
): SubprocessHandle {
  const spec: SubprocessSpawnSpec = {
    argv,
    cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: disposeGraceMs,
    signal,
    env: resolveChildEnvironment(deployment),
  }
  const child = ctx.subprocess.spawn(spec)
  // stderr is diagnostic-only. Drain it into a fixed-size ring to avoid pipe backpressure,
  // but do not retain or surface native CLI text, which may contain sensitive context.
  if (child.stderr !== undefined) {
    child.stderr.on('data', () => {})
  }
  child.done.catch(() => {})
  return child
}

/** Graceful EOF followed by the subprocess seam's managed-range termination ladder. */
export async function disposeNativeChild(child: SubprocessHandle, graceMs: number): Promise<void> {
  child.stdin?.end()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), graceMs)
  let exited = false
  try {
    exited = await child.waitForExit(controller.signal)
  } catch (error: unknown) {
    // A lost observation channel must not skip the one managed-range kill
    // attempt; preserve both failures if the backend cannot confirm cleanup.
    child.terminate()
    try {
      await child.waitForExit()
    } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], 'native subagent child cleanup failed')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (exited) return
  child.terminate()
  await child.waitForExit()
}

/** Race one protocol operation against caller cancellation and a fixed deadline. */
export async function withDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  label: string,
): Promise<T> {
  signal.throwIfAborted()
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error(`${label} cancelled`))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, cancelled, timedOut])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** Emit an adapter observation while containing host sink failures. */
export function emitEvent(config: SubagentAdapterConfig, event: Parameters<NonNullable<SubagentAdapterConfig['onEvent']>>[0]): void {
  try {
    config.onEvent?.(event)
  } catch {
    // Progress sinks are observers and cannot replace child execution outcomes.
  }
}

/** Track adapter-owned runs so unloading the registration reaps every published process. */
export function trackRun(
  run: SubagentRun,
  activeRuns: Set<SubagentRun>,
): SubagentRun {
  let disposal: Promise<void> | undefined
  const tracked: SubagentRun = {
    id: run.id,
    localAgent: run.localAgent,
    result: run.result,
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      disposal = run.dispose().finally(() => { activeRuns.delete(tracked) })
      return disposal
    },
  }
  activeRuns.add(tracked)
  return tracked
}

/** Common out-of-process provider contract. */
export abstract class NativeSubagentProvider implements SubagentProvider {
  readonly capabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  private readonly activeParents = new Map<string, number>()

  protected constructor(
    readonly name: string,
    protected readonly ctx: Context,
    protected readonly deployment: ValidatedDeployment,
    protected readonly config: SubagentAdapterConfig,
    protected readonly timeoutMs: number,
    protected readonly disposeGraceMs: number,
    protected readonly activeRuns: Set<SubagentRun>,
  ) {}

  abstract start(request: Parameters<SubagentProvider['start']>[0]): ReturnType<SubagentProvider['start']>

  /** Avoid resuming one native thread concurrently from sibling DSH runs. */
  protected reserveParentConversation(
    parentSessionId: string,
    conversations: ReadonlyMap<string, string>,
  ): { previousConversation: string | undefined; release: () => void } {
    const active = this.activeParents.get(parentSessionId) ?? 0
    const previousConversation = active === 0 ? conversations.get(parentSessionId) : undefined
    this.activeParents.set(parentSessionId, active + 1)
    let released = false
    return {
      previousConversation,
      release: () => {
        if (released) return
        released = true
        const remaining = this.activeParents.get(parentSessionId) ?? 1
        if (remaining <= 1) this.activeParents.delete(parentSessionId)
        else this.activeParents.set(parentSessionId, remaining - 1)
      },
    }
  }

  protected publish(run: SubagentRun): SubagentRun {
    return trackRun(run, this.activeRuns)
  }
}

/** Validate common provider timing bounds before any provider is registered. */
export function resolveTiming(config: SubagentAdapterConfig): { timeoutMs: number; disposeGraceMs: number; startupTimeoutMs: number } {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  const disposeGraceMs = config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
  const startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS
  for (const [name, value] of Object.entries({ timeoutMs, disposeGraceMs, startupTimeoutMs })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error(`navigator-subagents: ${name} must be a positive integer no greater than 2147483647`)
    }
  }
  return { timeoutMs, disposeGraceMs, startupTimeoutMs }
}
