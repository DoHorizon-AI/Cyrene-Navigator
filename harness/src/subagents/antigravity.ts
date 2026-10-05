// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Antigravity native CLI subagent                             │
// │ Role: Drive documented stream-json sessions through DSH subprocess. │
// │ 模块职责：经由 DSH 子进程接口驱动 Antigravity 原生流式会话。          │
// └─────────────────────────────────────────────────────────────────────┘

import type { Context } from '@deepseek-ai/cordis'
import { settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  NativeSubagentFailure,
  NativeSubagentProvider,
  createRunId,
  disposeNativeChild,
  emitEvent,
  promptText,
  resolveRunCwd,
  spawnNativeChild,
  withDeadline,
  type ValidatedDeployment,
} from './common.js'
import type { SubagentAdapterConfig } from './types.js'
import { MAX_NATIVE_OUTPUT_BYTES, isJsonObject, optionalIdentifier, optionalString, pumpJsonLines, writeJsonLine } from './wire.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
}

/** Create one promise with explicit completion functions for process callbacks. */
function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (error: Error) => void
  const promise = new Promise<T>((resolveResult, rejectResult) => {
    resolvePromise = resolveResult
    rejectPromise = rejectResult
  })
  return {
    promise,
    resolve: value => resolvePromise(value),
    reject: error => rejectPromise(error),
  }
}

/** Antigravity's documented stream-json result envelope, narrowed at the wire boundary. */
function resultPayload(frame: Record<string, unknown>): Record<string, unknown> {
  const value = frame.result
  if (!isJsonObject(value)) throw new Error('Antigravity stream omitted its result object')
  return value
}

/** The native Antigravity provider uses only its documented NDJSON headless interface. */
export class AntigravitySubagentProvider extends NativeSubagentProvider {
  private readonly conversations = new Map<string, string>()

  constructor(
    ctx: Context,
    deployment: ValidatedDeployment,
    config: SubagentAdapterConfig,
    timeoutMs: number,
    disposeGraceMs: number,
    activeRuns: Set<SubagentRun>,
  ) {
    super(deployment.providerName, ctx, deployment, config, timeoutMs, disposeGraceMs, activeRuns)
  }

  /** Start one native child turn and publish after the CLI announces its conversation. */
  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    if (request.signal.aborted) throw new Error('Antigravity subagent was cancelled before spawn')
    const prompt = promptText(request)
    const cwd = resolveRunCwd(this.deployment, request)
    const runId = createRunId()
    const parentSessionId = request.parent.session.id
    const parentReservation = this.reserveParentConversation(parentSessionId, this.conversations)
    const previousConversation = parentReservation.previousConversation
    const argv = [
      this.deployment.command,
      ...this.deployment.argv,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--sandbox',
      '--mode', 'default',
      ...(previousConversation === undefined ? [] : ['--conversation', previousConversation]),
    ]

    let child: SubprocessHandle
    try {
      child = spawnNativeChild(this.ctx, this.deployment, cwd, argv, request.signal, this.disposeGraceMs)
    } catch {
      parentReservation.release()
      throw new NativeSubagentFailure(
        'Antigravity CLI could not be started',
        'Antigravity CLI process startup failed.',
      )
    }
    if (child.stdin === undefined || child.stdout === undefined) {
      try {
        await disposeNativeChild(child, this.disposeGraceMs)
      } finally {
        parentReservation.release()
      }
      throw new NativeSubagentFailure(
        'Antigravity CLI did not expose protocol stdio',
        'Antigravity CLI process did not expose piped stdio.',
      )
    }

    const initialized = deferred<string>()
    const terminal = deferred<SubagentResult>()
    const flags = { initReceived: false, terminalReceived: false, cancelled: false }
    let output = ''
    let diagnostic: string | undefined
    let activeConversationId: string | undefined
    let resultSettled = false
    terminal.promise.catch(() => {})
    const failStream = (error: Error): void => {
      if (flags.terminalReceived) return
      const permissionModeRejected = error.message.includes('permission mode')
      diagnostic = error.message.includes('byte limit')
        ? 'Antigravity stream exceeded a configured byte limit.'
        : permissionModeRejected
          ? 'Antigravity did not advertise an approved native permission mode.'
          : 'Antigravity stream protocol returned malformed or incomplete data.'
      const failure = error.message.includes('byte limit')
        ? new NativeSubagentFailure('Antigravity stream frame exceeded its size limit', 'Antigravity stream frame was rejected by the byte limit.')
        : permissionModeRejected
          ? new NativeSubagentFailure('Antigravity native permission mode was not approved', diagnostic)
          : new NativeSubagentFailure('Antigravity stream protocol failed', diagnostic)
      if (!flags.initReceived) initialized.reject(failure)
      if (!flags.terminalReceived) terminal.reject(failure)
      child.terminate()
    }

    pumpJsonLines(child.stdout, request.signal, frame => {
      const event = frame.event
      if (event === 'init') {
        const init = isJsonObject(frame.init) ? frame.init : {}
        const conversationId = optionalIdentifier(frame.conversation_id) ?? optionalIdentifier(init.conversation_id)
        const permissionMode = optionalString(frame.permission_mode) ?? optionalString(init.permission_mode)
        if (conversationId === undefined) {
          failStream(new Error('Antigravity init omitted conversation id'))
          return
        }
        if (permissionMode !== 'request-review') {
          failStream(new Error('Antigravity did not advertise the documented request-review permission mode'))
          return
        }
        flags.initReceived = true
        activeConversationId = conversationId
        emitEvent(this.config, {
          type: 'progress',
          providerName: this.name,
          backend: 'antigravity',
          parentSessionId,
          runId,
          conversationId,
          phase: 'connected',
          status: previousConversation === undefined ? 'new-conversation' : 'resumed-conversation',
        })
        initialized.resolve(conversationId)
        return
      }
      if (event === 'step_update') {
        const step = isJsonObject(frame.step_update) ? frame.step_update : undefined
        if (step === undefined) {
          failStream(new Error('Antigravity step update was malformed'))
          return
        }
        const stepType = (optionalString(step.step_type) ?? 'agent').slice(0, 80)
        const state = optionalString(step.state)?.slice(0, 80)
        const conversationId = optionalIdentifier(step.conversation_id)
        // The CLI emits short answers in the terminal DONE frame without an earlier ACTIVE text event.
        if (stepType === 'agent_response' && (state === 'ACTIVE' || state === 'DONE') && typeof step.text_delta === 'string') {
          const delta = step.text_delta
          output += delta
          if (Buffer.byteLength(output, 'utf8') > MAX_NATIVE_OUTPUT_BYTES) {
            failStream(new Error('Antigravity output exceeded its size limit'))
            return
          }
          if (delta.length > 0) {
            emitEvent(this.config, {
              type: 'assistant-delta',
              providerName: this.name,
              backend: 'antigravity',
              parentSessionId,
              runId,
              ...(conversationId === undefined ? {} : { conversationId }),
              text: delta,
            })
          }
        }
        emitEvent(this.config, {
          type: 'progress',
          providerName: this.name,
          backend: 'antigravity',
          parentSessionId,
          runId,
          ...(conversationId === undefined ? {} : { conversationId }),
          phase: stepType,
          ...(state === undefined ? {} : { status: state.toLowerCase() }),
        })
        return
      }
      if (event === 'result') {
        if (flags.terminalReceived) {
          failStream(new Error('Antigravity emitted more than one terminal result'))
          return
        }
        flags.terminalReceived = true
        let result: Record<string, unknown>
        try {
          result = resultPayload(frame)
        } catch (error: unknown) {
          terminal.reject(error instanceof Error ? error : new Error('Antigravity result was malformed'))
          child.stdin?.end()
          return
        }
        const status = (optionalString(result.status) ?? 'INVALID').slice(0, 80)
        const response = typeof result.response === 'string' ? result.response : ''
        const resultConversation = optionalIdentifier(result.conversation_id)
        if (status === 'SUCCESS' && response.trim().length > 0) {
          if (Buffer.byteLength(response, 'utf8') > MAX_NATIVE_OUTPUT_BYTES) {
            terminal.reject(new NativeSubagentFailure(
              'Antigravity result exceeded its output limit',
              'Antigravity terminal output exceeded the byte limit.',
            ))
          } else {
            const completedConversation = resultConversation ?? activeConversationId
            if (completedConversation !== undefined) this.conversations.set(parentSessionId, completedConversation)
            terminal.resolve({ output: [{ type: 'text', text: response }], stopReason: 'completed' })
          }
        } else {
          const stopReason = status === 'CANCELED' || status === 'INTERRUPTED' ? 'aborted' : 'error'
          diagnostic = `Antigravity CLI returned terminal status ${status}.`
          terminal.reject(new NativeSubagentFailure(
            `Antigravity CLI stopped with status ${status}`,
            `Antigravity CLI returned terminal status ${status}.`,
          ))
          if (stopReason === 'aborted') flags.cancelled = true
        }
        emitEvent(this.config, {
          type: 'progress',
          providerName: this.name,
          backend: 'antigravity',
          parentSessionId,
          runId,
          ...(resultConversation === undefined ? {} : { conversationId: resultConversation }),
          phase: 'result',
          status: status.toLowerCase(),
        })
        child.stdin?.end()
        return
      }
      failStream(new Error('Antigravity emitted an unknown event'))
    }, failStream)

    try {
      const conversationId = await withDeadline(
        initialized.promise,
        request.signal,
        DEFAULT_STARTUP_TIMEOUT_MS,
        'Antigravity CLI startup',
      )
      await withDeadline(writeJsonLine(child.stdin, {
        event: 'user',
        message: { content: prompt },
      }), request.signal, DEFAULT_STARTUP_TIMEOUT_MS, 'Antigravity CLI prompt write')

      const terminalAttempt = async (): Promise<SubagentResult> => {
        const result = await withDeadline(terminal.promise, request.signal, this.timeoutMs, 'Antigravity CLI turn')
        const outcome = await withDeadline(child.done, request.signal, this.disposeGraceMs, 'Antigravity CLI exit')
        assertCleanExit(outcome)
        return result
      }
      const onAbort = (): void => {
        if (flags.cancelled) return
        flags.cancelled = true
        emitEvent(this.config, {
          type: 'progress', providerName: this.name, backend: 'antigravity', parentSessionId, runId,
          conversationId: activeConversationId ?? conversationId, phase: 'cancelled', status: 'aborted',
        })
      }
      const requestCancel = (): void => {
        if (!resultSettled) onAbort()
        child.stdin?.end()
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) onAbort()

      const result = settleRunResult({
        attempt: terminalAttempt,
        collectOutput: () => output.length === 0 ? [] : [{ type: 'text', text: output }],
        collectDiagnostic: () => diagnostic,
        cancelled: () => flags.cancelled,
        signal: request.signal,
        onAbort,
        onError: (error, stopReason) => {
          emitEvent(this.config, {
            type: 'progress', providerName: this.name, backend: 'antigravity', parentSessionId, runId,
            conversationId: activeConversationId ?? conversationId, phase: 'error', status: stopReason,
          })
        },
      })
      void result.finally(() => { resultSettled = true }).catch(() => {})
      void result.catch(() => {})
      const run = subprocessRunHandle({
        id: runId,
        result,
        signal: request.signal,
        onAbort,
        requestCancel,
        teardown: async () => {
          try {
            await disposeNativeChild(child, this.disposeGraceMs)
          } finally {
            parentReservation.release()
          }
        },
      })
      return this.publish(run)
    } catch (error: unknown) {
      try {
        await disposeNativeChild(child, this.disposeGraceMs)
      } catch {
        parentReservation.release()
        throw new AggregateError([safeStartupFailure(error), new Error('Antigravity child cleanup failed')])
      }
      parentReservation.release()
      throw safeStartupFailure(error)
    }
  }
}

/** Verify that the child process exited normally after its terminal result. */
function assertCleanExit(outcome: SubprocessOutcome): void {
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    throw new NativeSubagentFailure(
      'Antigravity CLI exited unsuccessfully after its result',
      `Antigravity CLI process exited with code ${String(outcome.exitCode)}.`,
    )
  }
}

/** Remove unsafe error details from pre-publication failures. */
function safeStartupFailure(error: unknown): Error {
  if (error instanceof NativeSubagentFailure) return error
  const message = error instanceof Error ? error.message : ''
  if (message.includes('timed out')) {
    return new NativeSubagentFailure('Antigravity CLI startup timed out', 'Antigravity CLI startup timed out.')
  }
  if (message.includes('cancelled') || message.includes('aborted')) {
    return new NativeSubagentFailure('Antigravity CLI startup was cancelled', 'Antigravity CLI startup was cancelled.')
  }
  return new NativeSubagentFailure('Antigravity CLI could not establish its stream session', 'Antigravity CLI startup protocol failed.')
}
