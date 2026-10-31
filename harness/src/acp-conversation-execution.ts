// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 acp-conversation-execution.ts                                   │
// │  Module: harness/acp-conversation-execution                         │
// │  Role: Own shared ACP task lifecycle behind provider-specific hooks. │
// │                                                                      │
// │  模块职责：集中管理原生 ACP Work Task 生命周期，并保留 provider 差异。│
// └─────────────────────────────────────────────────────────────────────┘

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { AcpMcpHost } from './acp-mcp-host.js'
import type { AcpMcpBridge } from './acp-mcp-host.js'
import { AcpStdioClient, authUnavailableFailure, isAuthRequired, nativeAcpRpcErrorCode } from './subagents/acp.js'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  NativeSubagentFailure,
  disposeNativeChildWithOutcome,
} from './subagents/common.js'
import {
  MAX_NATIVE_OUTPUT_BYTES,
  isJsonObject,
  nativeWireDiagnostic,
  optionalIdentifier,
  optionalString,
  requiredIdentifier,
} from './subagents/wire.js'
import type { WorkStateStore } from './work-state-client.js'

export type NativeAcpBackendName = 'codebuddy-acp' | 'antigravity-acp'

/** One active Work Task plus the host callbacks for its terminal and tool stream. */
export interface ConversationExecutionInput {
  readonly taskId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly authorizationPauseSignal: AbortSignal;
  readonly readOnly: boolean;
  readonly onText: (text: string) => void | Promise<void>;
  readonly onToolCall?: (event: { name: string; callId: string; arguments: string }) => void | Promise<void>;
  readonly onToolResult?: (event: { name: string; callId: string; result: string; isError: boolean }) => void | Promise<void>;
}

/** Only complete native turns become successful conversation results. */
export interface ConversationExecutionResult {
  readonly stopReason: 'end_turn' | 'refusal' | 'cancelled';
  readonly nativeSessionId: string;
  readonly output: string;
  readonly pausedForUserAuthorization?: true;
}

/** Top-level task execution boundary selected by the Navigator composition root. */
export interface ConversationExecutionBackend {
  readonly name: NativeAcpBackendName;
  execute(input: ConversationExecutionInput): Promise<ConversationExecutionResult>;
}

export interface PreparedAcpConversation {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly sessionParameters: Readonly<Record<string, unknown>>;
  /** Remove only transient per-run setup; persistent provider state stays in its profile. */
  cleanup?(): void | Promise<void>;
}

export type RecordAcpPermissionDiagnostic = (
  event: Readonly<Record<string, unknown>>,
  nativeMcpCandidate: boolean,
) => void

/** Narrow provider hooks around shared session, process, cancellation, and cleanup mechanics. */
export interface AcpConversationExecutionProfile {
  readonly backend: NativeAcpBackendName;
  readonly displayName: string;
  readonly migrationPrompt?: (prompt: string) => string;
  prepare(bridge: AcpMcpBridge): Promise<PreparedAcpConversation> | PreparedAcpConversation;
  answerPermission(
    params: Record<string, unknown>,
    recordDiagnostic: RecordAcpPermissionDiagnostic,
  ): Promise<Record<string, unknown>>;
  onNotification?(
    method: string,
    params: unknown,
    fail: (error: Error) => void,
  ): void;
  finishRun?(sessionId: string): void;
  configureSession?(input: {
    readonly peer: AcpStdioClient;
    readonly signal: AbortController;
    readonly timeoutMs: number;
    readonly sessionId: string;
    readonly setupResult: Record<string, unknown>;
    readonly resumed: boolean;
  }): Promise<void>;
  authRequiredFailure?(): NativeSubagentFailure;
  validateInitialize?(result: Record<string, unknown>): void;
}

/** Fixed lifecycle controls shared by the explicit ACP backends. */
export interface AcpConversationExecutionOptions {
  readonly ctx: Context;
  readonly workState: WorkStateStore;
  readonly profile: AcpConversationExecutionProfile;
  readonly startupTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly disposeGraceMs?: number;
  readonly mcpCloseGraceMs?: number;
}

/** Run one native ACP conversation turn without creating or invoking a DSH Agent. */
export class AcpConversationExecutionBackend implements ConversationExecutionBackend {
  readonly name: NativeAcpBackendName
  private readonly startupTimeoutMs: number
  private readonly turnTimeoutMs: number
  private readonly disposeGraceMs: number
  private readonly mcpCloseGraceMs: number | undefined

  constructor(private readonly options: AcpConversationExecutionOptions) {
    this.name = options.profile.backend
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    this.disposeGraceMs = options.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
    this.mcpCloseGraceMs = options.mcpCloseGraceMs
  }

  /** Load or create a native session, bind it to Work, and send one user turn. */
  async execute(input: ConversationExecutionInput): Promise<ConversationExecutionResult> {
    input.signal.throwIfAborted()
    const runController = new AbortController()
    let currentTurn = false
    let nativeTurnNeedsCancel = false
    const abortRelays: Array<() => void> = []
    const relayAbort = (signal: AbortSignal): void => {
      if (signal.aborted) {
        if (currentTurn) nativeTurnNeedsCancel = true
        runController.abort(signal.reason)
        return
      }
      const onAbort = (): void => {
        if (currentTurn) nativeTurnNeedsCancel = true
        runController.abort(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      abortRelays.push(() => signal.removeEventListener('abort', onAbort))
    }
    relayAbort(input.signal)
    relayAbort(input.authorizationPauseSignal)

    let prior: Awaited<ReturnType<WorkStateStore['getBackendSession']>>
    try {
      runController.signal.throwIfAborted()
      prior = await this.options.workState.getBackendSession(input.taskId, this.name)
      if (prior !== undefined && (prior.backend !== this.name || prior.sessionId !== input.sessionId)) {
        throw new NativeSubagentFailure(
          'Navigator returned a mismatched native session mapping',
          'NATIVE_SESSION_MAPPING_INVALID: Work returned a mapping for a different backend or session.',
        )
      }
    } catch (error: unknown) {
      for (const release of abortRelays) release()
      throw error
    }

    const mcpHost = new AcpMcpHost({
      ctx: this.options.ctx,
      sessionId: input.sessionId,
      backend: this.name,
      signal: runController.signal,
      readOnly: input.readOnly,
      ...(this.mcpCloseGraceMs === undefined ? {} : { closeGraceMs: this.mcpCloseGraceMs }),
      ...(input.onToolCall === undefined ? {} : { onToolCall: input.onToolCall }),
      ...(input.onToolResult === undefined ? {} : { onToolResult: input.onToolResult }),
    })
    let resources: PreparedAcpConversation | undefined
    let child: SubprocessHandle | undefined
    let peer: AcpStdioClient | undefined
    let conversationId: string | undefined
    let output = ''
    let diagnostic: string | undefined
    let result: ConversationExecutionResult | undefined
    let failure: unknown
    let cleanupFailure: unknown
    let authorizationPaused = false
    let permissionDiagnosticRecorded = false
    const recordPermissionDiagnostic: RecordAcpPermissionDiagnostic = (event, nativeMcpCandidate): void => {
      if (permissionDiagnosticRecorded || !nativeMcpCandidate) return
      permissionDiagnosticRecorded = true
      // Diagnostics are asynchronous so persistence cannot delay a permission decision.
      try {
        void this.options.workState.appendEvent(input.taskId, { ...event }).catch(() => {})
      } catch {
        // A diagnostic sink may throw before returning its promise.
      }
    }

    try {
      const mcpUrl = await mcpHost.listen()
      resources = await this.options.profile.prepare({ url: mcpUrl, token: mcpHost.token })
      child = this.spawnChild(resources)
      let peerFailure: Error | undefined
      peer = new AcpStdioClient(
        child,
        new AbortController().signal,
        (method, params) => {
          this.options.profile.onNotification?.(method, params, error => peer?.failWith(error))
          if (method !== 'session/update' || !isJsonObject(params) || !isJsonObject(params.update)) return
          const updateSessionId = optionalIdentifier(params.sessionId)
          if (updateSessionId !== undefined && conversationId !== undefined && updateSessionId !== conversationId) return
          const update = params.update
          if (update.sessionUpdate !== 'agent_message_chunk' || !isJsonObject(update.content)
            || update.content.type !== 'text' || typeof update.content.text !== 'string' || !currentTurn) return
          const text = update.content.text
          if (Buffer.byteLength(output, 'utf8') + Buffer.byteLength(text, 'utf8') > MAX_NATIVE_OUTPUT_BYTES) {
            diagnostic = 'NATIVE_OUTPUT_LIMIT: ACP assistant output exceeded the byte limit; valid partial output retained.'
            peer?.failWith(new Error('Native ACP output exceeded its configured size limit'))
            return
          }
          output += text
          try {
            void Promise.resolve(input.onText(text)).catch(() => {
              peerFailure = new Error('Navigator could not persist ACP assistant output')
              peer?.failWith(peerFailure)
            })
          } catch {
            peerFailure = new Error('Navigator could not persist ACP assistant output')
            peer?.failWith(peerFailure)
          }
        },
        async (_requestId, method, params) => {
          if (method !== 'session/request_permission' || !isJsonObject(params)) {
            throw new Error('Native ACP client request is unsupported')
          }
          return this.options.profile.answerPermission(params, recordPermissionDiagnostic)
        },
        error => { diagnostic ??= safeAcpDiagnostic(error, this.options.profile) },
      )

      const initValue = await withRunDeadline(
        peer.request('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'cyrene-navigator', version: '0.1.0' },
          clientCapabilities: {},
        }),
        runController,
        this.startupTimeoutMs,
        `${this.options.profile.displayName} ACP initialize`,
        this.options.profile,
      )
      const init = objectResult(initValue, 'initialize', this.options.profile.displayName)
      if (init.protocolVersion !== 1) {
        throw new NativeSubagentFailure(
          `${this.options.profile.displayName} ACP protocol version is unsupported`,
          'NATIVE_PROTOCOL_UNSUPPORTED: ACP protocol version 1 is required.',
        )
      }
      this.options.profile.validateInitialize?.(init)
      const canLoadSession = isJsonObject(init.agentCapabilities) && init.agentCapabilities.loadSession === true
      let setupResult: Record<string, unknown>
      if (prior !== undefined) {
        if (!canLoadSession) {
          throw new NativeSubagentFailure(
            `${this.options.profile.displayName} ACP cannot restore the stored native session`,
            'NATIVE_SESSION_RESUME_UNSUPPORTED: ACP did not advertise session/load; prior context was preserved.',
          )
        }
        const loadedValue = await withRunDeadline(peer.request('session/load', {
          sessionId: prior.nativeSessionId,
          ...resources.sessionParameters,
        }), runController, this.startupTimeoutMs, `${this.options.profile.displayName} ACP session load`, this.options.profile)
        setupResult = isJsonObject(loadedValue) ? loadedValue : {}
        conversationId = prior.nativeSessionId
      } else {
        const createdValue = await withRunDeadline(peer.request('session/new', {
          ...resources.sessionParameters,
        }), runController, this.startupTimeoutMs, `${this.options.profile.displayName} ACP session creation`, this.options.profile)
        setupResult = objectResult(createdValue, 'session/new', this.options.profile.displayName)
        conversationId = requiredIdentifier(setupResult.sessionId, 'session id')
        // Persist before model selection or prompting so a restart never invents context.
        const bound = await this.options.workState.bindBackendSession(input.taskId, conversationId, this.name)
        if (bound.sessionId !== input.sessionId || bound.nativeSessionId !== conversationId || bound.backend !== this.name) {
          throw new NativeSubagentFailure(
            'Navigator could not bind the ACP session to this Work session',
            'NATIVE_SESSION_MAPPING_CONFLICT: Work did not confirm the exact ACP session mapping.',
          )
        }
      }
      await this.options.profile.configureSession?.({
        peer,
        signal: runController,
        timeoutMs: this.startupTimeoutMs,
        sessionId: conversationId,
        setupResult,
        resumed: prior !== undefined,
      })
      await this.options.workState.appendEvent(input.taskId, {
        type: 'execution.backend_session',
        backend: this.name,
        resumed: prior !== undefined,
        legacyDshHistoryImported: false,
      })
      currentTurn = true
      const prompt = prior === undefined
        ? (this.options.profile.migrationPrompt?.(input.prompt) ?? input.prompt)
        : input.prompt
      const promptValue = await withRunDeadline(peer.request('session/prompt', {
        sessionId: conversationId,
        prompt: [{ type: 'text', text: prompt }],
      }), runController, this.turnTimeoutMs, `${this.options.profile.displayName} ACP prompt`, this.options.profile)
      const promptResult = objectResult(promptValue, 'session/prompt', this.options.profile.displayName)
      if (peerFailure !== undefined) throw peerFailure
      switch (promptResult.stopReason) {
        case 'end_turn':
        case 'refusal':
          result = { stopReason: promptResult.stopReason, nativeSessionId: conversationId, output }
          break
        case 'cancelled':
          if (input.signal.aborted) throw abortFailure(input.signal, this.options.profile.displayName)
          if (input.authorizationPauseSignal.aborted) {
            authorizationPaused = true
            break
          }
          throw new NativeSubagentFailure(
            `${this.options.profile.displayName} ACP cancelled the turn`,
            'NATIVE_STOP_CANCELLED: ACP cancelled the task.',
          )
        case 'max_tokens':
          throw new NativeSubagentFailure(
            `${this.options.profile.displayName} ACP reached its output limit`,
            'NATIVE_STOP_MAX_TOKENS: ACP returned partial output at its token limit.',
          )
        default:
          throw new NativeSubagentFailure(
            `${this.options.profile.displayName} ACP turn failed`,
            'NATIVE_STOP_ERROR: ACP did not complete the requested turn.',
          )
      }
    } catch (error: unknown) {
      if (currentTurn && conversationId !== undefined) nativeTurnNeedsCancel = true
      runController.abort(error)
      authorizationPaused = input.authorizationPauseSignal.aborted && !input.signal.aborted
      if (!authorizationPaused) {
        failure = diagnostic === undefined
          ? safeAcpFailure(error, input.signal, this.options.profile)
          : new NativeSubagentFailure(diagnostic, diagnostic)
      }
    } finally {
      // Abort host-owned tool work before reaping the protocol child or MCP listener.
      runController.abort(new Error(`${this.options.profile.displayName} ACP run is terminating.`))
      if (peer !== undefined) {
        if (nativeTurnNeedsCancel && conversationId !== undefined) {
          await peer.notify('session/cancel', { sessionId: conversationId }).catch(() => undefined)
        }
        peer.expectClose()
        peer.cancelPending()
      }
      if (child !== undefined) {
        try {
          const exitedBeforeTerminate = await disposeNativeChildWithOutcome(child, this.disposeGraceMs)
          if (exitedBeforeTerminate) {
            const outcome = await child.done
            if ((outcome.exitCode !== 0 || outcome.signal !== null) && failure === undefined) {
              const exit = outcome.exitCode === null ? `signal ${outcome.signal ?? 'unknown'}` : `code ${outcome.exitCode}`
              failure = new NativeSubagentFailure(
                `NATIVE_PROCESS_EXIT: ${this.options.profile.displayName} ACP exited with ${exit}.`,
                `NATIVE_PROCESS_EXIT: ${this.options.profile.displayName} ACP exited with ${exit}.`,
              )
            }
          }
        } catch {
          cleanupFailure = new NativeSubagentFailure(
            `${this.options.profile.displayName} ACP process cleanup failed`,
            'NATIVE_PROCESS_CLEANUP_FAILED: Navigator could not confirm ACP process cleanup.',
          )
        }
      }
      try {
        await mcpHost.close()
      } catch {
        cleanupFailure ??= new NativeSubagentFailure(
          'Navigator MCP bridge cleanup is incomplete',
          'NATIVE_MCP_CLEANUP_INCOMPLETE: An authorized tool handler did not settle after cancellation; cleanup is incomplete.',
        )
      }
      if (resources?.cleanup !== undefined) {
        try {
          await resources.cleanup()
        } catch {
          cleanupFailure ??= new NativeSubagentFailure(
            `${this.options.profile.displayName} ACP run setup cleanup failed`,
            'NATIVE_ACP_SETUP_CLEANUP_FAILED: Navigator could not remove task-local ACP setup.',
          )
        }
      }
      if (conversationId !== undefined) this.options.profile.finishRun?.(conversationId)
      for (const release of abortRelays) release()
    }

    if (authorizationPaused && conversationId !== undefined) {
      result = {
        stopReason: 'cancelled',
        nativeSessionId: conversationId,
        output,
        pausedForUserAuthorization: true,
      }
    }
    if (cleanupFailure !== undefined) {
      throw new NativeSubagentFailure(
        `${this.options.profile.displayName} ACP cleanup is incomplete`,
        failure === undefined
          ? 'NATIVE_CLEANUP_INCOMPLETE: Navigator could not confirm that task-local ACP resources and authorized tool handlers stopped.'
          : 'NATIVE_CLEANUP_INCOMPLETE: ACP failed and Navigator could not confirm that every authorized tool handler stopped.',
      )
    }
    if (failure !== undefined) throw failure
    if (result === undefined) {
      throw new NativeSubagentFailure(
        `${this.options.profile.displayName} ACP returned no terminal result`,
        diagnostic ?? 'NATIVE_RESULT_MISSING: ACP returned no terminal result.',
      )
    }
    return result
  }

  private spawnChild(resources: PreparedAcpConversation): SubprocessHandle {
    const child = this.options.ctx.subprocess.spawn({
      argv: [...resources.argv],
      cwd: resources.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: this.disposeGraceMs,
      env: resources.env,
    })
    child.stderr?.on('data', () => {})
    child.done.catch(() => {})
    return child
  }
}

/** Abort the entire run when an ACP protocol operation exceeds its fixed deadline. */
export async function withRunDeadline<T>(
  promise: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
  label: string,
  profile: AcpConversationExecutionProfile,
): Promise<T> {
  const signal = controller.signal
  signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(`${label} cancelled`))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new NativeSubagentFailure(
        `${label} timed out`,
        `NATIVE_TIMEOUT: ${profile.displayName} ACP request timed out; task-local tool operations were cancelled and reconciled as uncertain when needed.`,
      )
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, cancelled, timedOut])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** Narrow one ACP result before provider-specific session setup. */
export function objectResult(value: unknown, label: string, provider: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error(`${provider} ACP ${label} returned a non-object result`)
  return value
}

/** Return a fixed diagnostic that excludes native child response content. */
export function safeAcpDiagnostic(error: unknown, profile: AcpConversationExecutionProfile): string {
  const wire = nativeWireDiagnostic(error)
  if (wire !== undefined) return wire
  if (error instanceof NativeSubagentFailure) return error.diagnostic
  if (isAuthRequired(error)) return (profile.authRequiredFailure?.() ?? authUnavailableFailure()).diagnostic
  const rpcCode = nativeAcpRpcErrorCode(error)
  if (rpcCode !== undefined) {
    return `NATIVE_ACP_RPC_ERROR: ${profile.displayName} ACP request failed with JSON-RPC code ${rpcCode}; vendor details omitted.`
  }
  return 'NATIVE_PROTOCOL_UNAVAILABLE: ACP turn failed; partial output retained, native details omitted.'
}

function safeAcpFailure(error: unknown, signal: AbortSignal, profile: AcpConversationExecutionProfile): Error {
  if (signal.aborted) return abortFailure(signal, profile.displayName)
  if (error instanceof NativeSubagentFailure) {
    return new NativeSubagentFailure(error.diagnostic, error.diagnostic)
  }
  if (isAuthRequired(error)) return profile.authRequiredFailure?.() ?? authUnavailableFailure()
  const diagnostic = safeAcpDiagnostic(error, profile)
  if (error instanceof Error && error.message.includes('timed out')) {
    return new NativeSubagentFailure('NATIVE_TIMEOUT: ACP request timed out.', 'NATIVE_TIMEOUT: ACP request timed out.')
  }
  return new NativeSubagentFailure(diagnostic, diagnostic)
}

function abortFailure(signal: AbortSignal, provider: string): Error {
  const reason = signal.reason
  const suffix = reason instanceof Error && /timed out/iu.test(reason.message) ? 'TASK_TIMEOUT' : 'TASK_ABORTED'
  return new NativeSubagentFailure(
    suffix === 'TASK_TIMEOUT' ? `${provider} ACP task timed out` : `${provider} ACP task was cancelled`,
    `${suffix}: ${provider} ACP execution was stopped by Navigator.`,
  )
}
