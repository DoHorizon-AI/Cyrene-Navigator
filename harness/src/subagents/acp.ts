// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Shared ACP stdio subagent                                      │
// │ Role: Drive native ACP JSON-RPC over supervised child stdio.       │
// │ 模块职责：经由受监管子进程 stdio 驱动 Native ACP 会话。             │
// └─────────────────────────────────────────────────────────────────────┘

import type { Context } from '@deepseek-ai/cordis'
import { settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest, SubagentResult, SubagentRun, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
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
import type { SubagentAdapterConfig, SubagentPermissionRequest } from './types.js'
import {
  MAX_NATIVE_IDENTIFIER_BYTES,
  MAX_NATIVE_OUTPUT_BYTES,
  isJsonObject,
  optionalIdentifier,
  optionalString,
  pumpJsonLines,
  requiredIdentifier,
  nativeWireDiagnostic,
  NativeWireFailure,
  writeJsonLine,
} from './wire.js'

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

/** Small JSON-RPC 2.0 client for the documented ACP stdio transport. */
class AcpStdioClient {
  private nextId = 1
  private readonly pending = new Map<string, PendingRequest>()
  private failure?: Error
  private expectedClose = false
  private readonly abortListener: () => void

  constructor(
    private readonly child: SubprocessHandle,
    private readonly signal: AbortSignal,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onRequest: (id: string | number, method: string, params: unknown) => Promise<unknown>,
    private readonly onFailure: (error: Error) => void,
  ) {
    if (child.stdout === undefined) throw new Error('Native ACP child has no stdout pipe')
    pumpJsonLines(child.stdout, signal, frame => this.receive(frame), error => {
      if (this.expectedClose && error instanceof NativeWireFailure && error.code === 'NATIVE_PREMATURE_EOF') return
      this.fail(error)
    })
    this.abortListener = () => this.fail(new Error('Native ACP child was cancelled'))
    signal.addEventListener('abort', this.abortListener, { once: true })
  }

  /** Fail all outstanding requests and terminate after a framing or protocol fault. */
  failWith(error: Error): void {
    this.fail(error)
  }

  /** Mark the host's EOF during run disposal as an expected protocol close. */
  expectClose(): void {
    this.expectedClose = true
    this.signal.removeEventListener('abort', this.abortListener)
  }

  /** Settle local requests on disposal without relying on the peer to acknowledge cancellation. */
  cancelPending(): void {
    if (this.failure !== undefined) return
    const cancelled = new Error('Native ACP request was cancelled locally')
    this.failure = cancelled
    this.signal.removeEventListener('abort', this.abortListener)
    for (const pending of this.pending.values()) pending.reject(cancelled)
    this.pending.clear()
  }

  /** Send one request and correlate its response by the JSON-RPC id. */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    if (this.child.stdin === undefined) return Promise.reject(new Error('Native ACP child has no stdin pipe'))
    const id = this.nextId++
    const key = rpcKey(id)
    let resolvePending!: (value: unknown) => void
    let rejectPending!: (error: Error) => void
    const response = new Promise<unknown>((resolveResult, rejectResult) => {
      resolvePending = resolveResult
      rejectPending = rejectResult
    })
    this.pending.set(key, { resolve: resolvePending, reject: rejectPending })
    void writeJsonLine(this.child.stdin, { jsonrpc: '2.0', id, method, params }).catch(error => {
      const pending = this.pending.get(key)
      this.pending.delete(key)
      pending?.reject(error instanceof Error ? error : new Error('Native ACP request write failed'))
    })
    return response
  }

  /** Send one best-effort ACP notification. */
  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.failure !== undefined) throw this.failure
    if (this.child.stdin === undefined) throw new Error('Native ACP child has no stdin pipe')
    await writeJsonLine(this.child.stdin, { jsonrpc: '2.0', method, params })
  }

  private receive(frame: Record<string, unknown>): void {
    if (frame.jsonrpc !== '2.0') throw new Error('Native ACP frame has an invalid JSON-RPC version')
    const method = optionalString(frame.method)
    const rawId = frame.id
    if (method !== undefined) {
      if (typeof rawId === 'string' && Buffer.byteLength(rawId, 'utf8') > MAX_NATIVE_IDENTIFIER_BYTES) {
        throw new Error('Native ACP request id exceeds the configured byte limit')
      }
      const params = isJsonObject(frame.params) ? frame.params : {}
      if (typeof rawId === 'string' || typeof rawId === 'number') {
        void this.respondToRequest(rawId, method, params)
      } else {
        this.onNotification(method, params)
      }
      return
    }
    if (typeof rawId !== 'string' && typeof rawId !== 'number') {
      throw new Error('Native ACP response omitted its JSON-RPC id')
    }
    const key = rpcKey(rawId)
    const pending = this.pending.get(key)
    if (pending === undefined) return
    this.pending.delete(key)
    const error = isJsonObject(frame.error) ? frame.error : undefined
    if (error !== undefined) {
      const code = typeof error.code === 'number' && Number.isSafeInteger(error.code) ? error.code : -32603
      pending.reject(new RpcProtocolError(code))
    } else {
      pending.resolve(frame.result)
    }
  }

  private async respondToRequest(id: string | number, method: string, params: Record<string, unknown>): Promise<void> {
    if (this.child.stdin === undefined) return
    try {
      const result = await this.onRequest(id, method, params)
      await writeJsonLine(this.child.stdin, { jsonrpc: '2.0', id, result: asJsonObject(result) })
    } catch {
      await writeJsonLine(this.child.stdin, {
        jsonrpc: '2.0', id,
        error: { code: -32601, message: 'Navigator ACP client cannot serve this request' },
      }).catch(() => {})
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    try { this.onFailure(error) } catch { /* Diagnostic sinks cannot change child cleanup. */ }
    this.signal.removeEventListener('abort', this.abortListener)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.child.terminate()
  }
}

/** Retain only the JSON-RPC code needed for safe protocol-level classification. */
class RpcProtocolError extends Error {
  readonly code: number | undefined

  constructor(codeOrMessage: number | string) {
    super(typeof codeOrMessage === 'number'
      ? `Native ACP request failed with code ${codeOrMessage}`
      : codeOrMessage)
    this.code = typeof codeOrMessage === 'number' ? codeOrMessage : undefined
    this.name = 'RpcProtocolError'
  }
}

/** ACP uses -32000 for auth_required; never retain its message or data fields. */
function isAuthRequired(error: unknown): error is RpcProtocolError {
  return error instanceof RpcProtocolError && error.code === -32000
}

/** Return a fixed diagnostic that does not include child-provided RPC content. */
function authUnavailableFailure(): NativeSubagentFailure {
  return new NativeSubagentFailure(
    'Native ACP requires native CLI authentication',
    'NATIVE_AUTH_UNAVAILABLE: Native requires native CLI sign-in; Navigator did not start a login flow or proxy credentials.',
  )
}

/** Build a disjoint key for numeric and textual RPC ids. */
function rpcKey(id: string | number): string {
  if (typeof id === 'string' && Buffer.byteLength(id, 'utf8') > MAX_NATIVE_IDENTIFIER_BYTES) {
    throw new Error('Native ACP response id exceeds the configured byte limit')
  }
  return `${typeof id}:${String(id)}`
}

/** Retain only object results; ACP notification handlers always send plain JSON objects. */
function asJsonObject(value: unknown): Record<string, unknown> {
  return isJsonObject(value) ? value : {}
}

/** Narrow one ACP JSON-RPC result to an object. */
function objectResult(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error(`Native ACP ${label} returned a non-object result`)
  return value
}

/** Map standard ACP v1 prompt stop reasons into the DSH subagent vocabulary. */
function stopReason(value: unknown): SubagentStopReason {
  switch (value) {
    case 'end_turn': return 'completed'
    case 'cancelled': return 'aborted'
    case 'max_tokens': return 'max-tokens'
    case 'refusal': return 'refusal'
    default: return 'error'
  }
}

/** Bound optional child-provided permission labels before they reach Navigator storage. */
function safeLabel(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) return value
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '')
}

/** Shared ACP provider keeps native session association on the existing DSH seam. */
export class AcpSubagentProvider extends NativeSubagentProvider {
  private readonly conversations = new Map<string, string>()
  private readonly backend: 'codebuddy' | 'acp'

  constructor(
    ctx: Context,
    deployment: ValidatedDeployment,
    config: SubagentAdapterConfig,
    timeoutMs: number,
    disposeGraceMs: number,
    activeRuns: Set<SubagentRun>,
  ) {
    super(deployment.providerName, ctx, deployment, config, timeoutMs, disposeGraceMs, activeRuns)
    if (deployment.backend !== 'acp' && deployment.backend !== 'codebuddy') {
      throw new Error('ACP provider requires an ACP deployment')
    }
    this.backend = deployment.backend
  }

  /** Establish a new or capability-advertised resumable ACP session before publishing the run. */
  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    if (request.signal.aborted) throw new Error('Native subagent was cancelled before spawn')
    const prompt = promptText(request)
    const cwd = resolveRunCwd(this.deployment, request)
    const runId = createRunId()
    const parentSessionId = request.parent.session.id
    const parentReservation = this.reserveParentConversation(parentSessionId, this.conversations)
    const previousConversation = parentReservation.previousConversation

    let child: SubprocessHandle
    try {
      const launch = this.deployment.backend === 'codebuddy'
        ? ['--acp', '--acp-transport', 'stdio', '--permission-mode', 'default']
        : []
      child = spawnNativeChild(this.ctx, this.deployment, cwd, [
        this.deployment.command, ...this.deployment.argv, ...launch,
      ], request.signal, this.disposeGraceMs)
    } catch {
      parentReservation.release()
      throw new NativeSubagentFailure(
        'Native ACP process could not be started',
        'Native ACP process startup failed.',
      )
    }
    if (child.stdin === undefined || child.stdout === undefined) {
      try {
        await disposeNativeChild(child, this.disposeGraceMs)
      } finally {
        parentReservation.release()
      }
      throw new NativeSubagentFailure(
        'Native ACP process did not expose protocol stdio',
        'Native ACP process did not expose piped stdio.',
      )
    }

    let conversationId: string | undefined
    let output = ''
    let diagnostic: string | undefined
    const approvalCancellation = new AbortController()
    const approvalRequest = { ...request, signal: AbortSignal.any([request.signal, approvalCancellation.signal]) }
    let currentTurn = false
    const flags = { cancelled: false }
    let resultSettled = false
    const toolStatuses = new Map<string, string>()
    const failureDiagnostic = (error: unknown): string => (error instanceof NativeSubagentFailure ? error.diagnostic : undefined)
      ?? nativeWireDiagnostic(error)
      ?? (error instanceof RpcProtocolError && error.code !== undefined
        ? `NATIVE_RPC_ERROR: ACP request failed with code ${error.code}; native details omitted.`
        : 'NATIVE_PROTOCOL_UNAVAILABLE: ACP turn failed; partial output retained, native details omitted.')

    const peer = new AcpStdioClient(
      child,
      request.signal,
      (method, params) => {
        if (method !== 'session/update' || !isJsonObject(params) || !isJsonObject(params.update)) return
        const update = params.update
        const updateSessionId = optionalIdentifier(params.sessionId)
        if (updateSessionId !== undefined && conversationId !== undefined && updateSessionId !== conversationId) return
        const kind = optionalString(update.sessionUpdate)
        if (kind === 'agent_message_chunk' && isJsonObject(update.content)
          && update.content.type === 'text' && typeof update.content.text === 'string') {
          const text = update.content.text
          if (!currentTurn) return // `session/load` may replay prior history before the current prompt.
          if (Buffer.byteLength(output, 'utf8') + Buffer.byteLength(text, 'utf8') > MAX_NATIVE_OUTPUT_BYTES) {
            diagnostic = 'NATIVE_OUTPUT_LIMIT: ACP assistant output exceeded the byte limit; valid partial output retained.'
            peer.failWith(new Error('Native ACP output exceeded its size limit'))
            return
          }
          output += text
          emitEvent(this.config, {
            type: 'assistant-delta', providerName: this.name, backend: this.backend, parentSessionId, runId,
            ...(conversationId === undefined ? {} : { conversationId }), text,
          })
          return
        }
        if (kind === 'tool_call' || kind === 'tool_call_update') {
          if (!currentTurn) return // Ignore replayed tool states during session/load.
          // ACP session updates carry tool fields directly; retain the older nested shape.
          // 中文：标准 ACP 的 status/kind 位于 update 本身，而非 toolCall 子对象。
          const toolCall = isJsonObject(update.toolCall) ? update.toolCall : update
          // Streaming input/content updates do not represent a tool state transition.
          // 中文：工具参数分片不重复写入任务进度，也不把未校验字段当状态。
          if (kind === 'tool_call_update' && toolCall.status === undefined) return
          const status = ['pending', 'in_progress', 'completed', 'failed'].includes(String(toolCall.status))
            ? String(toolCall.status) : kind === 'tool_call' && toolCall.status === undefined ? 'pending' : 'unknown'
          const toolId = optionalIdentifier(toolCall.toolCallId)
          if (toolId !== undefined) {
            if (toolStatuses.get(toolId) === status) return
            if (toolStatuses.size >= 1024) toolStatuses.delete(toolStatuses.keys().next().value!)
            toolStatuses.set(toolId, status)
          }
          emitEvent(this.config, {
            type: 'progress', providerName: this.name, backend: this.backend, parentSessionId, runId,
            ...(conversationId === undefined ? {} : { conversationId }), phase: 'tool', status,
          })
        }
      },
      async (rpcId, method, params) => {
        if (method !== 'session/request_permission') {
          throw new RpcProtocolError('unsupported ACP agent request')
        }
        if (!isJsonObject(params)) throw new RpcProtocolError('ACP permission params are malformed')
        return await this.answerPermission(
          rpcId,
          params,
          approvalRequest,
          runId,
          conversationId,
        )
      },
      error => { diagnostic ??= failureDiagnostic(error) },
    )

    try {
      const initValue = await withDeadline(
        peer.request('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'cyrene-navigator', version: '0.1.0' },
          clientCapabilities: {},
        }),
        request.signal,
        DEFAULT_STARTUP_TIMEOUT_MS,
        'Native ACP initialize',
      )
      const init = objectResult(initValue, 'initialize')
      if (init.protocolVersion !== 1) throw new NativeSubagentFailure(
        'Native ACP protocol version is unsupported',
        'NATIVE_PROTOCOL_UNSUPPORTED: ACP protocol version 1 is required.',
      )
      const agentCapabilities = isJsonObject(init.agentCapabilities) ? init.agentCapabilities : {}
      const canLoadSession = agentCapabilities.loadSession === true
      if (previousConversation !== undefined && canLoadSession) {
        await withDeadline(peer.request('session/load', {
          sessionId: previousConversation,
          cwd,
          mcpServers: [],
        }), request.signal, DEFAULT_STARTUP_TIMEOUT_MS, 'Native ACP session load')
        conversationId = previousConversation
        // History replay remains outside the one-shot result and progress stream.
        currentTurn = false
      } else {
        if (previousConversation !== undefined) {
          this.conversations.delete(parentSessionId)
          emitEvent(this.config, {
            type: 'progress', providerName: this.name, backend: this.backend, parentSessionId, runId,
            conversationId: previousConversation, phase: 'resume', status: 'unsupported',
          })
        }
        const createdValue = await withDeadline(peer.request('session/new', { cwd, mcpServers: [] }),
          request.signal, DEFAULT_STARTUP_TIMEOUT_MS, 'Native ACP session creation')
        const created = objectResult(createdValue, 'session/new')
        conversationId = requiredIdentifier(created.sessionId, 'session id')
      }
      if (conversationId === undefined) throw new Error('Native ACP session identity is unavailable')
      currentTurn = true
      emitEvent(this.config, {
        type: 'progress', providerName: this.name, backend: this.backend, parentSessionId, runId,
        conversationId, phase: 'connected', status: previousConversation === conversationId ? 'resumed-conversation' : 'new-conversation',
      })

      const remoteSessionId = conversationId
      const attempt = async (): Promise<SubagentResult> => {
        const promptRequest = peer.request('session/prompt', {
          sessionId: remoteSessionId,
          prompt: [{ type: 'text', text: prompt }],
        }).then(value => objectResult(value, 'session/prompt'))
        let response: Record<string, unknown>
        try {
          response = await withDeadline(promptRequest, request.signal, this.timeoutMs, 'Native ACP prompt')
        } catch (error: unknown) {
          if (isAuthRequired(error)) {
            diagnostic = authUnavailableFailure().diagnostic
            throw authUnavailableFailure()
          }
          diagnostic ??= failureDiagnostic(error)
          throw error
        }
        const reason = stopReason(response.stopReason)
        if (reason === 'error') {
          diagnostic = 'NATIVE_STOP_UNSUPPORTED: ACP returned an unsupported terminal reason; partial output retained.'
          throw new NativeSubagentFailure('Native ACP turn did not complete', diagnostic)
        }
        if (reason === 'completed') this.conversations.set(parentSessionId, remoteSessionId)
        return {
          output: output.length === 0 ? [] : [{ type: 'text', text: output }],
          stopReason: reason,
        }
      }
      const onAbort = (): void => {
        if (flags.cancelled) return
        flags.cancelled = true
        if (conversationId !== undefined) {
          void peer.notify('session/cancel', { sessionId: conversationId }).catch(() => {})
        }
        emitEvent(this.config, {
          type: 'progress', providerName: this.name, backend: this.backend, parentSessionId, runId,
          ...(conversationId === undefined ? {} : { conversationId }), phase: 'cancelled', status: 'aborted',
        })
      }
      const requestCancel = (): void => {
        if (!resultSettled) onAbort()
        approvalCancellation.abort()
        peer.expectClose()
        if (!resultSettled) peer.cancelPending()
        child.stdin?.end()
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) onAbort()

      const result = settleRunResult({
        attempt,
        collectOutput: () => output.length === 0 ? [] : [{ type: 'text', text: output }],
        collectDiagnostic: () => diagnostic,
        cancelled: () => flags.cancelled,
        signal: request.signal,
        onAbort,
        onError: (_error, reason) => {
          emitEvent(this.config, {
            type: 'progress', providerName: this.name, backend: this.backend, parentSessionId, runId,
            conversationId: remoteSessionId, phase: 'error', status: reason,
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
        throw new AggregateError([safeStartupFailure(error), new Error('Native ACP child cleanup failed')])
      }
      parentReservation.release()
      throw safeStartupFailure(error)
    }
  }

  /** Answer native permission requests via Navigator storage or deny by default. */
  private async answerPermission(
    rpcId: string | number,
    params: Record<string, unknown>,
    request: ResolvedSubagentStartRequest,
    runId: ReturnType<typeof createRunId>,
    conversationId: string | undefined,
  ): Promise<Record<string, unknown>> {
    const requestedSessionId = optionalIdentifier(params.sessionId)
    const belongsToRun = conversationId !== undefined
      && (requestedSessionId === undefined || requestedSessionId === conversationId)
    const sessionId = belongsToRun ? conversationId : undefined
    const call = isJsonObject(params.toolCall) ? params.toolCall : {}
    const tool = safeLabel(call.kind, 80) ?? 'unknown'
    const title = safeLabel(call.title, 256)
    const rawInput = call.rawInput
    const inputForApproval = safeJsonValue(rawInput)
    let decision: 'allow-once' | 'deny' = 'deny'
    if (belongsToRun && sessionId !== undefined && !request.signal.aborted && this.config.requestPermission !== undefined) {
      const approval: SubagentPermissionRequest = {
        providerName: this.name,
        backend: this.backend,
        parentSessionId: request.parent.session.id,
        runId,
        conversationId: sessionId,
        requestId: rpcId,
        tool,
        ...(title === undefined ? {} : { title }),
        ...(inputForApproval === undefined ? {} : { rawInput: inputForApproval }),
        signal: request.signal,
      }
      try {
        decision = await withDeadline(
          this.config.requestPermission(approval),
          request.signal,
          this.timeoutMs,
          'Native ACP permission decision',
        )
      } catch {
        decision = 'deny'
      }
    }
    const options = Array.isArray(params.options) ? params.options.filter(isJsonObject) : []
    const allowOnce = options.find(option => option.kind === 'allow_once' && typeof option.optionId === 'string')
    if (decision === 'allow-once' && allowOnce !== undefined && !request.signal.aborted) {
      emitEvent(this.config, {
        type: 'permission', providerName: this.name, backend: this.backend, parentSessionId: request.parent.session.id, runId,
        ...(sessionId === undefined ? {} : { conversationId: sessionId }), tool, decision: 'approved',
      })
      return { outcome: { outcome: 'selected', optionId: allowOnce.optionId } }
    }
    emitEvent(this.config, {
      type: 'permission', providerName: this.name, backend: this.backend, parentSessionId: request.parent.session.id, runId,
      ...(sessionId === undefined ? {} : { conversationId: sessionId }), tool, decision: 'denied',
    })
    // Reject this operation without signalling cancellation of independent work.
    // 中文：拒绝本次工具操作；只有实际取消或缺少拒绝选项时才回传 cancelled。
    const rejectOnce = options.find(option => option.kind === 'reject_once' && typeof option.optionId === 'string')
    if (!request.signal.aborted && rejectOnce !== undefined) {
      return { outcome: { outcome: 'selected', optionId: rejectOnce.optionId } }
    }
    return { outcome: { outcome: 'cancelled' } }
  }
}

/** Drop permission input that is not safely JSON or exceeds approval-record bounds. */
function safeJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 32_768) return undefined
    return JSON.parse(encoded) as unknown
  } catch {
    return undefined
  }
}

/** Hide raw CLI errors and arguments behind provider-owned startup diagnostics. */
function safeStartupFailure(error: unknown): Error {
  if (error instanceof NativeSubagentFailure) return error
  if (isAuthRequired(error)) return authUnavailableFailure()
  const wireDiagnostic = nativeWireDiagnostic(error)
  if (wireDiagnostic !== undefined) return new NativeSubagentFailure('Native ACP protocol failed', wireDiagnostic)
  const message = error instanceof Error ? error.message : ''
  if (message.includes('timed out')) {
    return new NativeSubagentFailure('Native ACP startup timed out', 'Native ACP startup timed out.')
  }
  if (message.includes('cancelled') || message.includes('aborted')) {
    return new NativeSubagentFailure('Native ACP startup was cancelled', 'Native ACP startup was cancelled.')
  }
  return new NativeSubagentFailure('Native ACP session could not be established', 'Native ACP initialization or session setup failed.')
}
