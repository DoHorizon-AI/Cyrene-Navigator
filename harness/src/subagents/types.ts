// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator native subagent contracts                        │
// │ Role: Typed deployment and host callback boundary for CLI children. │
// │ 模块职责：原生子 Agent 的部署配置与宿主回调契约。                      │
// └─────────────────────────────────────────────────────────────────────┘

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** Native agent transport selected by one approved deployment. */
export type NativeSubagentBackend = 'antigravity' | 'codebuddy'

/** Safe lifecycle observations that Navigator may forward to its task stream. */
export type SubagentAdapterEvent =
  | {
    readonly type: 'progress'
    readonly providerName: string
    readonly backend: NativeSubagentBackend
    readonly parentSessionId: SessionId
    readonly runId: SessionId
    readonly conversationId?: string
    readonly phase: string
    readonly status?: string
  }
  | {
    readonly type: 'assistant-delta'
    readonly providerName: string
    readonly backend: NativeSubagentBackend
    readonly parentSessionId: SessionId
    readonly runId: SessionId
    readonly conversationId?: string
    readonly text: string
  }
  | {
    readonly type: 'blocked'
    readonly providerName: string
    readonly backend: NativeSubagentBackend
    readonly parentSessionId: SessionId
    readonly runId: SessionId
    readonly reasonCode: 'SANDBOX_BOUNDARY_DENIED' | 'SANDBOX_PROFILE_UNAVAILABLE' | 'SANDBOX_MODE_UNVERIFIED' | 'SUBAGENT_TIMEOUT' | 'SUBAGENT_FAILED'
    readonly toolCategory: 'file' | 'command' | 'network' | 'other' | 'unknown'
    /** Number of native denial observations, not a count of unique operations. */
    readonly count: number
  }
  | {
    readonly type: 'permission'
    readonly providerName: string
    readonly backend: NativeSubagentBackend
    readonly parentSessionId: SessionId
    readonly runId: SessionId
    readonly conversationId?: string
    readonly tool: string
    readonly decision: 'approved' | 'denied'
  }

/** ACP permission request passed to Navigator's approval storage bridge. */
export interface SubagentPermissionRequest {
  readonly providerName: string
  readonly backend: 'codebuddy'
  /** DSH parent session used to correlate the permission with its Navigator task. */
  readonly parentSessionId: SessionId
  readonly runId: SessionId
  readonly conversationId: string
  readonly requestId: string | number
  readonly tool: string
  readonly title?: string
  /** Child-supplied, untrusted arguments for the approval record; never logged by this adapter. */
  readonly rawInput?: unknown
  readonly signal: AbortSignal
}

/** Only a single native `allow_once` option can be approved by the host. */
export type SubagentPermissionDecision = 'allow-once' | 'deny'

/** An allowlisted executable and the minimal host values explicitly forwarded to it. */
export interface SubagentDeployment {
  readonly backend: NativeSubagentBackend
  /** Registry name on `ctx.subagents`; defaults to the backend name. */
  readonly providerName?: string
  /** Bare PATH command or an absolute executable path; never shell-interpreted. */
  readonly command: string
  /** Additional native flags, restricted to model/effort/agent selectors. */
  readonly argv?: readonly string[]
  /** Optional fixed workspace. Omission uses the delegating DSH session cwd. */
  readonly cwd?: string
  /** Child environment name to host environment name; values are never extracted or logged. */
  readonly envRefs?: Readonly<Record<string, string>>
}

/** Registration configuration for the two native out-of-process providers. */
export interface SubagentAdapterConfig {
  /** Admin-approved native executable deployments. */
  readonly deployments: readonly SubagentDeployment[]
  /** Startup and single-turn time limit in milliseconds. */
  readonly timeoutMs?: number
  /** EOF grace before the subprocess seam escalates termination. */
  readonly disposeGraceMs?: number
  /** Normalized lifecycle events; sink failures are contained. */
  readonly onEvent?: (event: SubagentAdapterEvent) => void
  /** ACP permission approval bridge; omission denies every permission request. */
  readonly requestPermission?: (
    request: SubagentPermissionRequest,
  ) => Promise<SubagentPermissionDecision>
}

/** Provider diagnostic callback detail kept separate from model-visible output. */
export type SubagentAdapterErrorSink = (
  error: Error,
  stopReason: SubagentStopReason,
) => void
