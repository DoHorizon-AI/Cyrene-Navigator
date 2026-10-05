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
import { AntigravityBoundaryObserver } from './antigravity-boundary.js'
import { assertAntigravitySandboxProfile } from './antigravity-profile.js'
import type { SubagentAdapterConfig } from './types.js'
import { MAX_NATIVE_OUTPUT_BYTES, nativeWireDiagnostic, isJsonObject, optionalIdentifier, optionalString, pumpJsonLines, writeJsonLine } from './wire.js'

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
    const prompt = `${promptText(request)}\n\nNavigator execution policy: complete every permitted independent task. If an action is denied by the sandbox or permission policy, record it as cannot execute with its reason and continue the other permitted tasks. Preserve successful results. End with completed and cannot-execute items. Never retry outside the sandbox, request permission escalation, or change the permission profile.`
    const cwd = resolveRunCwd(this.deployment, request)
    const runId = createRunId()
    const parentSessionId = request.parent.session.id
    const reportBlocked = (reasonCode: 'SANDBOX_BOUNDARY_DENIED' | 'SANDBOX_PROFILE_UNAVAILABLE' | 'SANDBOX_MODE_UNVERIFIED' | 'SUBAGENT_TIMEOUT' | 'SUBAGENT_FAILED', toolCategory: 'file' | 'command' | 'network' | 'other' | 'unknown' = 'unknown', count = 1): void => {
      emitEvent(this.config, { type: 'blocked', providerName: this.name, backend: 'antigravity', parentSessionId, runId, reasonCode, toolCategory, count })
    }
    try {
      await assertAntigravitySandboxProfile(cwd)
    } catch (error: unknown) {
      reportBlocked('SANDBOX_PROFILE_UNAVAILABLE')
      throw safeStartupFailure(error)
    }
    const parentReservation = this.reserveParentConversation(parentSessionId, this.conversations)
    const previousConversation = parentReservation.previousConversation
    const argv = [
      this.deployment.command,
      ...this.deployment.argv,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--sandbox',
      '--mode', 'accept-edits',
      ...(previousConversation === undefined ? [] : ['--conversation', previousConversation]),
    ]

    let child: SubprocessHandle
    try {
      child = spawnNativeChild(this.ctx, this.deployment, cwd, argv, request.signal, this.disposeGraceMs)
    } catch {
      reportBlocked('SUBAGENT_FAILED')
      parentReservation.release()
      throw new NativeSubagentFailure(
        'Antigravity CLI could not be started',
        'Antigravity CLI process startup failed.',
      )
    }
    if (child.stdin === undefined || child.stdout === undefined) {
      reportBlocked('SUBAGENT_FAILED')
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

    const boundary = new AntigravityBoundaryObserver()
    // Native stderr may carry a soft denial even when result=SUCCESS and exit=0.
    // 中文：原生 stderr 可能报告软拒绝，而 result 和退出码仍表示成功。
    const stderrEnded = new Promise<void>((resolveEnd, rejectEnd) => {
      if (!child.stderr || child.stderr.readableEnded) return resolveEnd()
      child.stderr.on('data', (chunk: Buffer | string) => {
        boundary.observeStderr(chunk)
        publishBoundaryReceipts()
      })
      child.stderr.once('end', resolveEnd)
      child.stderr.once('close', () => {
        if (child.stderr?.readableEnded) resolveEnd()
        else rejectEnd(new NativeSubagentFailure('Antigravity diagnostic stream closed early', 'Antigravity diagnostic EOF could not be verified.'))
      })
      child.stderr.once('error', () => rejectEnd(new NativeSubagentFailure('Antigravity diagnostic stream failed', 'Antigravity diagnostic stream could not be verified.')))
    })
    stderrEnded.catch(() => {})
    let blockedReported = false
    const reportedCounts = new Map<string, number>()
    const publishBoundaryReceipts = (): void => {
      for (const receipt of boundary.getBlockedReceipts()) {
        if ((reportedCounts.get(receipt.toolCategory) ?? 0) >= receipt.count) continue
        reportedCounts.set(receipt.toolCategory, receipt.count)
        blockedReported = true
        reportBlocked(receipt.reasonCode, receipt.toolCategory, receipt.count)
      }
    }
    const checkBoundary = (): void => {
      try { boundary.assertAllowed() } catch (error: unknown) {
        diagnostic = 'SANDBOX_BOUNDARY_DENIED：无法执行受限操作。已保留成功结果，请继续其余可执行任务并在总结中列出无法执行项；禁止改到宿主执行或提升权限。'
        publishBoundaryReceipts()
        throw error
      }
    }
    const initialized = deferred<string>()
    const terminal = deferred<SubagentResult>()
    const flags = { initReceived: false, terminalReceived: false, cancelled: false, modeRejected: false }
    let output = ''
    let diagnostic: string | undefined
    let activeConversationId: string | undefined
    let resultSettled = false
    terminal.promise.catch(() => {})
    let streamFailed = false
    const failStream = (error: Error): void => {
      if (flags.terminalReceived || streamFailed) return
      streamFailed = true // Preserve the first failure rather than replacing it with cleanup EOF.
      const permissionModeRejected = error.message.includes('permission mode')
      if (permissionModeRejected) flags.modeRejected = true
      const wireDiagnostic = nativeWireDiagnostic(error) ?? (error instanceof NativeSubagentFailure ? error.diagnostic : undefined)
      diagnostic = wireDiagnostic ?? (error.message.includes('byte limit')
        ? 'Antigravity stream exceeded a configured byte limit.'
        : permissionModeRejected
          ? 'Antigravity did not advertise an approved native permission mode.'
          : 'Antigravity stream protocol returned malformed or incomplete data.')
      const failure = wireDiagnostic !== undefined
        ? new NativeSubagentFailure('Antigravity stream protocol failed', wireDiagnostic)
        : error.message.includes('byte limit')
        ? new NativeSubagentFailure('Antigravity stream frame exceeded its size limit', 'Antigravity stream frame was rejected by the byte limit.')
        : permissionModeRejected
          ? new NativeSubagentFailure('Antigravity native permission mode was not approved', diagnostic)
          : new NativeSubagentFailure('Antigravity stream protocol failed', diagnostic)
      if (!flags.initReceived) initialized.reject(failure)
      if (!flags.terminalReceived) terminal.reject(failure)
      child.terminate()
    }

    pumpJsonLines(child.stdout, request.signal, frame => {
      if (streamFailed) return
      boundary.observeFrame(frame)
      publishBoundaryReceipts()
      const event = frame.event
      if (event === 'init') {
        const init = isJsonObject(frame.init) ? frame.init : {}
        const conversationId = optionalIdentifier(frame.conversation_id) ?? optionalIdentifier(init.conversation_id)
        const permissionMode = optionalString(frame.permission_mode) ?? optionalString(init.permission_mode)
        if (conversationId === undefined) {
          failStream(new Error('Antigravity init omitted conversation id'))
          return
        }
        if (permissionMode !== 'proceed-in-sandbox') {
          failStream(new Error('Antigravity did not advertise the required proceed-in-sandbox permission mode'))
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
          if (Buffer.byteLength(output, 'utf8') + Buffer.byteLength(delta, 'utf8') > MAX_NATIVE_OUTPUT_BYTES) {
            failStream(new NativeSubagentFailure('Antigravity output exceeded its size limit',
              'NATIVE_OUTPUT_LIMIT: Antigravity assistant output exceeded the byte limit; valid partial output retained.'))
            return
          }
          output += delta
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
        const rawStatus = optionalString(result.status)
        const status = rawStatus !== undefined && ['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING'].includes(rawStatus) ? rawStatus : 'INVALID'
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
            output = response
            terminal.resolve({ output: [{ type: 'text', text: response }], stopReason: 'completed' })
          }
        } else {
          const stopReason = status === 'CANCELED' || status === 'INTERRUPTED' ? 'aborted' : 'error'
          diagnostic = `Antigravity CLI returned terminal status ${status}. ${nativeFailureCategory(result.error)}`
          terminal.reject(new NativeSubagentFailure(
            `Antigravity CLI stopped with status ${status}`,
            diagnostic,
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
        const attempt = await withDeadline(terminal.promise.then(result => ({ kind: 'result' as const, result }), error => ({ kind: 'error' as const, error })), request.signal, this.timeoutMs, 'Antigravity CLI turn')
        const outcome = await withDeadline(child.done, request.signal, this.disposeGraceMs, 'Antigravity CLI exit')
        await withDeadline(stderrEnded, request.signal, this.disposeGraceMs, 'Antigravity diagnostic EOF')
        checkBoundary()
        assertCleanExit(outcome)
        if (attempt.kind === 'error') throw attempt.error
        return attempt.result
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
          const timedOut = error.message.includes('timed out')
          diagnostic ??= error instanceof NativeSubagentFailure ? error.diagnostic
            : timedOut ? 'NATIVE_RESPONSE_TIMEOUT：原生 CLI 响应超时，无法执行；请继续其余可执行任务并在总结中列出该项。'
            : 'NATIVE_TRANSPORT_FAILED：原生 CLI 通道失败，无法执行；请继续其余可执行任务。'
          if (!flags.cancelled && !blockedReported) reportBlocked(timedOut ? 'SUBAGENT_TIMEOUT' : 'SUBAGENT_FAILED')
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
            try { checkBoundary() } catch { /* Receipts survive cancellation; no escalation or extra termination. */ }
            parentReservation.release()
          }
        },
      })
      return this.publish(run)
    } catch (error: unknown) {
      reportBlocked(flags.modeRejected ? 'SANDBOX_MODE_UNVERIFIED' : error instanceof Error && error.message.includes('timed out') ? 'SUBAGENT_TIMEOUT' : 'SUBAGENT_FAILED')
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

/** Classify a native failure without copying its paths, credentials, or diagnostic text. | 分类原生失败，不复制路径、凭据或原始诊断。 */
function nativeFailureCategory(value: unknown): string {
  if (typeof value !== 'string') return 'NATIVE_FAILURE: 无法执行，请继续其余可执行任务。'
  const text = value.slice(0, 4_096)
  if (/quota|credits? (?:exhausted|insufficient)|rate.?limit|resource.?exhausted/iu.test(text)) return 'NATIVE_QUOTA_UNAVAILABLE: 原生模型额度不可用，无法执行；请继续其余任务。'
  if (/not (?:authenticated|logged in)|authentication|login required|unauthori[sz]ed|access token/iu.test(text)) return 'NATIVE_AUTH_UNAVAILABLE: 原生登录不可用，无法执行；请继续其余任务。'
  if (/invalid model|unknown model|model .*not (?:recognized|available|found)/iu.test(text)) return 'NATIVE_MODEL_UNAVAILABLE: 原生模型选择不可用，无法执行；请继续其余任务。'
  if (/sandbox.*(?:failed|unavailable|not supported)|namespace.*(?:denied|not permitted)|bwrap|sandbox-exec/iu.test(text)) return 'NATIVE_SANDBOX_UNAVAILABLE: 原生沙箱不可用，无法执行；请继续其余任务。'
  if (/network|connect(?:ion)?.*(?:failed|refused|reset)|timed? out|timeout|dns|(?:service|provider|server|endpoint|backend).*(?:unavailable|unreachable)|502|503|504/iu.test(text)) return 'NATIVE_CONNECTION_UNAVAILABLE: 原生服务连接不可用，无法执行；请继续其余任务。'
  return 'NATIVE_FAILURE: 原生 CLI 返回失败，无法执行；请继续其余可执行任务。'
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
