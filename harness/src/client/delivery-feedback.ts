// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 delivery-feedback.ts                                             │
// │  Module: Navigator browser delivery feedback                        │
// │  Role: Retain local failed inputs through public Harness snapshots.  │
// │                                                                     │
// │  模块职责：按 requestId 保留本页失败输入，通过公开事件确认执行结果。    │
// │  · 只读 Session/Connection，不改 Agent Loop 或会话存储                 │
// │  · 用户显式恢复输入；不覆盖新草稿，不自动再次发送                      │
// └─────────────────────────────────────────────────────────────────────┘

// Read-only structural views of the pinned public client faces. Importing the
// aggregate upstream declarations merges Host and Client Cordis authorities;
// these observations intentionally contain no Session mutation verbs.
// 固定上游公开客户端接口的只读视图；避免合并 Host/Client 声明，不引入写会话接口。
interface PendingSubmission {
  readonly requestId: string
  readonly text: string
}

interface SessionObservation {
  readonly pendingSubmissions: readonly PendingSubmission[]
  readonly promptError: { readonly op: 'send' | 'stop'; readonly error: unknown } | null
  readonly lastAgentError: string | null
}

interface EventWindow {
  readonly entries: readonly {
    readonly type: string
    readonly event: { readonly type: string; readonly data: unknown }
  }[]
}

interface InputView {
  readonly draft: string
  readonly phase: string
}

interface InputActions {
  setDraft(text: string): void
}

interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface ReactFace {
  createElement(type: string, props: Record<string, unknown> | null, ...children: unknown[]): unknown
  useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T
  useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, snapshot: () => T): T
}

// The CJS factory receives a browser module resolver, not Node's require.
// 中文：CJS factory 收到的是浏览器模块解析器，不是 Node 的 require。
declare function require(id: 'react'): ReactFace
declare const module: { exports: unknown }
const React = require('react')

type FailureKind = 'ownership' | 'transport' | 'unknown' | 'recovered'

interface NativeRetainedInputs {
  list(sessionId: string): Promise<readonly { readonly requestId: string; readonly text: string }[]>
  put(sessionId: string, requestId: string, text: string): Promise<void>
  remove(sessionId: string, requestId: string): Promise<void>
  completed(sessionId: string, requestIds: readonly string[]): Promise<readonly string[]>
}

type LocalRecovery = 'loading' | 'saving' | 'saved' | 'failed'

function nativeRetainedInputs(): NativeRetainedInputs | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { __cyreneNavigatorRetainedInputs?: NativeRetainedInputs })
    .__cyreneNavigatorRetainedInputs
}

interface Attempt {
  readonly requestId: string
  readonly text: string
  turn: number | null
  failure: FailureKind | null
  /** Native-backed terminal attempts wait for a durable completion receipt.  中文：原生端产生的终态尝试必须等待持久化完成回执。  中文：原生端产生的终态尝试必须等待持久化完成回执。 */
  // native 终态必须等待持久化回执，不能因页面事件直接删除本地副本。
  terminal: boolean
}

interface RetainedInput {
  readonly requestId: string
  readonly text: string
  readonly kind: FailureKind
}

interface DeliveryView {
  readonly retained: readonly RetainedInput[]
  readonly generic: FailureKind | null
  readonly localRecovery?: LocalRecovery
  readonly unconfirmed?: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function failureKind(error: unknown): FailureKind {
  const fields = record(error)
  const detail = typeof error === 'string' ? error : ['code', 'name', 'message']
    .map(key => typeof fields?.[key] === 'string' ? fields[key] : '').join(' ')
  if (/ownership|fenc|writer.*lost|already[_ -]?local/iu.test(detail)) return 'ownership'
  if (/connection|transport|network|timeout|ECONNREFUSED|ECONNRESET|fetch|unavailable/iu.test(detail)) return 'transport'
  return 'unknown'
}

function rpcId(message: unknown): string | null {
  const source = record(record(message)?.source)
  return source?.kind === 'user' && typeof source.rpcId === 'string' ? source.rpcId : null
}

/**
 * Read existing event order to associate only this page's RPCs with turns.
 * Inbox insertion is admission. A removal into an open turn or a matching
 * user/message identifies consumption; a subsequent turn/end settles it.
 *
 * 只按本页 RPC 关联 turn。入队不是完成；出队消费或匹配的 user/message 才能关联
 * 执行轮次，之后读取对应 turn/end。此函数不保存或改写事件历史。
 */
function observeEvents(
  attempts: Map<string, Attempt>,
  window: EventWindow,
  retainUnconfirmed: boolean,
): void {
  const queues = new Map<string, (string | null)[]>()
  let openTurn: number | null = null
  for (const entry of window.entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    const data = record(event.data)
    if (event.type === 'turn/start') {
      openTurn = typeof data?.turn === 'number' ? data.turn : null
    } else if (event.type === 'user/message') {
      const id = rpcId(data)
      const attempt = id === null ? undefined : attempts.get(id)
      if (attempt !== undefined && openTurn !== null) attempt.turn = openTurn
    } else if (event.type === 'agent/inbox/spliced') {
      if (typeof data?.target !== 'string' || !Number.isSafeInteger(data.start)
        || !Array.isArray(data.inserted)) continue
      const start = data.start as number
      const count = data.removedCount === undefined ? 0 : data.removedCount
      if (start < 0 || !Number.isSafeInteger(count) || (count as number) < 0) continue
      const queue = queues.get(data.target) ?? []
      // An incomplete historical window cannot establish the omitted queue.
      // Preserve uncertainty instead of guessing which RPC an index removed.
      // 中文：不完整的历史窗口无法确定被省略的队列内容。保留不确定性，不猜测某个 index 删除了哪个 RPC。
      if (start > queue.length || start + (count as number) > queue.length) {
        queues.delete(data.target)
        continue
      }
      const removed = queue.splice(start, count as number, ...data.inserted.map(rpcId))
      queues.set(data.target, queue)
      for (const id of removed) {
        const attempt = id === null ? undefined : attempts.get(id)
        if (attempt === undefined) continue
        if (data.outcome === 'canceled') {
          if (retainUnconfirmed) {
            attempt.failure = 'recovered'
            attempt.terminal = true
          } else attempts.delete(attempt.requestId)
        }
        else if (openTurn !== null) attempt.turn = openTurn
      }
    } else if (event.type === 'turn/end') {
      const reason = record(data?.reason)
      for (const attempt of attempts.values()) {
        if (attempt.turn === null || attempt.turn !== data?.turn) continue
        if (reason?.kind === 'error') {
          attempt.failure = failureKind(reason.error)
          if (retainUnconfirmed) attempt.terminal = true
        } else if (typeof reason?.kind === 'string') {
          if (retainUnconfirmed) {
            attempt.failure = 'recovered'
            attempt.terminal = true
          } else attempts.delete(attempt.requestId)
        }
      }
      if (openTurn === data?.turn) openTurn = null
    }
  }
}

/**
 * Delivery state for one mounted Session. Only pending local inputs and retained
 * failures are held; successful inputs are forgotten. A desktop capability may
 * retain failed input text locally across origins. It has no Session write API.
 * The public Session subscription captures short-lived echoes before React's
 * render batching can hide them. No Session verb or history write is used.
 *
 * 只保留 pending/失败输入，成功后移除。桌面可保存失败文本用于跨端口重开恢复；
 * 直接订阅公开 Session 快照，不调用写会话接口或维护另一份消息历史。
 */
class DeliveryTracker {
  private readonly attempts = new Map<string, Attempt>()
  private pendingIds = new Set<string>()
  private promptError: SessionObservation['promptError'] = null
  private agentError: string | null = null
  private generic: FailureKind | null = null
  private view: DeliveryView = { retained: [], generic: null }
  private readonly listeners = new Set<() => void>()
  private subscriptions: (() => void)[] = []
  private native: NativeRetainedInputs | undefined
  private nativeReady = false
  private nativeFailed = false
  private nativeSignature: string | undefined
  private nativePending = 0
  private nativeQueue: Promise<void> = Promise.resolve()
  private readonly nativeRecords = new Map<string, string>()
  private readonly nativeUnconfirmed = new Map<string, string>()
  private readonly dismissedIds = new Set<string>()
  private readonly pendingDismissals = new Set<string>()
  private readonly supersededIds = new Set<string>()
  private localRecovery: LocalRecovery | undefined

  constructor(
    private readonly session: Observable<SessionObservation>,
    private readonly events: Observable<EventWindow>,
    private readonly connection: Observable<string | undefined>,
    private readonly sessionId?: string,
  ) {}

  readonly getSnapshot = (): DeliveryView => this.view

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.subscriptions = [
        this.session.subscribe(this.refresh),
        this.events.subscribe(this.refresh),
        this.connection.subscribe(this.refresh),
      ]
      this.refresh()
      if (typeof window !== 'undefined') {
        window.addEventListener?.('cyrene:navigator-retained-inputs-ready', this.startNative)
      }
      this.startNative()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        for (const dispose of this.subscriptions) dispose()
        this.subscriptions = []
        if (typeof window !== 'undefined') {
          window.removeEventListener?.('cyrene:navigator-retained-inputs-ready', this.startNative)
        }
      }
    }
  }

  /** Dismissing a retained input is an explicit client action, not a resend.  中文：关闭保留输入是显式客户端操作，不会重新发送请求。  中文：关闭保留输入是显式客户端操作，不会重新发送请求。 */
  dismiss(requestId: string | null): void {
    if (requestId === null) this.generic = null
    else if (!this.hasNativeCapability()) {
      this.dismissedIds.add(requestId)
      this.attempts.delete(requestId)
      this.nativeUnconfirmed.delete(requestId)
      this.nativeSignature = undefined
    } else {
      // Keep the item visible until the durable local delete succeeds. A failed
      // delete is recoverable through the same explicit Retry local save action.
      // 删除成功前保持可见；失败时由显式 Retry local save 重试删除。
      this.pendingDismissals.add(requestId)
      this.nativeSignature = undefined
    }
    this.publish()
  }

  /** Retry only local input storage; this never resubmits a model request.  中文：只重试本地输入存储，绝不会重新提交模型请求。  中文：只重试本地输入存储，绝不会重新提交模型请求。 */
  retrySaving(): void {
    if (!this.nativeFailed) return
    this.nativeFailed = false
    if (!this.nativeReady) {
      this.native = undefined
      this.startNative()
    } else {
      this.nativeSignature = undefined
      this.publish()
    }
  }

  /** Re-read durable receipts without sending or taking over the Session.  中文：重新读取持久化回执；不发送请求，也不接管 Session。  中文：重新读取持久化回执；不发送请求，也不接管 Session。 */
  checkDelivery(): void {
    if (this.nativeFailed) { this.retrySaving(); return }
    this.nativeSignature = undefined
    this.publish()
  }

  private readonly startNative = (): void => {
    if (this.native !== undefined || this.sessionId === undefined) return
    const native = nativeRetainedInputs()
    if (native === undefined) return
    this.native = native
    this.localRecovery = 'loading'
    this.publish()
    void Promise.resolve().then(() => native.list(this.sessionId as string)).then(rows => {
      if (!Array.isArray(rows) || rows.length > 8 || rows.some(row =>
        typeof row?.requestId !== 'string' || row.requestId.length === 0 || row.requestId.length > 512
        || typeof row.text !== 'string' || row.text.length === 0 || row.text.length > 65536)) {
        throw new Error('Invalid local input recovery record')
      }
      for (const row of rows) {
        this.nativeRecords.set(row.requestId, row.text)
        if (this.dismissedIds.has(row.requestId) || this.pendingDismissals.has(row.requestId)
          || this.attempts.has(row.requestId)) continue
        // A new explicit retry may already exist while the local read completes.
        // Do not revive its earlier failed copy behind that newer request.
        // 中文：本地读取完成时，新的显式重试可能已经存在。不要在较新的请求后面恢复更早的失败副本。
        if ([...this.attempts.values()].some(attempt => attempt.text === row.text)) {
          this.supersededIds.add(row.requestId)
          continue
        }
        this.attempts.set(row.requestId, {
          requestId: row.requestId, text: row.text, turn: null, failure: 'recovered', terminal: false,
        })
      }
      this.nativeReady = true
      this.refresh()
    }).catch(() => {
      this.nativeFailed = true
      this.localRecovery = 'failed'
      this.publish()
    })
  }

  private hasNativeCapability(): boolean {
    return this.native !== undefined || nativeRetainedInputs() !== undefined
  }

  /** Serialize immutable input writes and removals independently of Session events.  中文：与 Session 事件相互独立地串行化不可变输入的写入和删除。  中文：与 Session 事件相互独立地串行化不可变输入的写入和删除。 */
  private syncNative(): void {
    const native = this.native
    const sessionId = this.sessionId
    if (!this.nativeReady || this.nativeFailed || native === undefined || sessionId === undefined) return
    const desired = new Map([...this.attempts.values()]
      .filter(attempt => !this.dismissedIds.has(attempt.requestId)
        && !this.pendingDismissals.has(attempt.requestId)
        // Once a terminal attempt has a local copy, the receipt check below is
        // the only authority allowed to remove it.
        // 中文：终态尝试一旦已有本地副本，只有下方回执检查可以授权删除。
        && (!attempt.terminal || this.nativeRecords.get(attempt.requestId) !== attempt.text))
      .map(attempt => [attempt.requestId, attempt.text]))
    const signature = JSON.stringify([...desired])
    if (signature === this.nativeSignature) return
    this.nativeSignature = signature
    this.nativePending += 1
    this.localRecovery = 'saving'
    this.nativeQueue = this.nativeQueue.then(async () => {
      if (this.nativeFailed) return
      for (const [requestId, text] of desired) {
        if (this.nativeRecords.get(requestId) === text) continue
        await native.put(sessionId, requestId, text)
        this.nativeRecords.set(requestId, text)
        this.nativeUnconfirmed.delete(requestId)
      }
      const candidates = [...this.nativeRecords.keys()].filter(requestId =>
        !desired.has(requestId) && !this.pendingDismissals.has(requestId) && !this.supersededIds.has(requestId))
      // A live Session event can precede its asynchronous persistence flush.
      // Only the backend's read-only receipt can retire an inferred completion.
      // 页面事件可能早于持久化 flush；推断完成必须再经服务端只读回执确认。
      const completed = new Set<string>()
      if (candidates.length > 0) {
        try {
          for (const requestId of await native.completed(sessionId, candidates)) completed.add(requestId)
        } catch {
          // An unavailable receipt leaves delivery unconfirmed. The local
          // writes above are already durable and must remain usable offline.
          // 回执不可用只表示投递未确认；已落盘的本地副本仍可离线恢复。
        }
      }
      for (const requestId of [...this.nativeRecords.keys()]) {
        if (desired.has(requestId)) continue
        const text = this.nativeRecords.get(requestId) as string
        const replacementReady = [...desired.values()].some(candidate => candidate === text)
        const pendingDismissal = this.pendingDismissals.has(requestId)
        if (!pendingDismissal && this.supersededIds.has(requestId) && !replacementReady) {
          this.nativeUnconfirmed.set(requestId, text)
          continue
        }
        if (!this.pendingDismissals.has(requestId) && !this.dismissedIds.has(requestId)
          && !completed.has(requestId) && !(this.supersededIds.has(requestId) && replacementReady)) {
          this.nativeUnconfirmed.set(requestId, text)
          continue
        }
        await native.remove(sessionId, requestId)
        this.nativeRecords.delete(requestId)
        this.nativeUnconfirmed.delete(requestId)
        if (this.pendingDismissals.delete(requestId)) {
          this.dismissedIds.add(requestId)
          this.attempts.delete(requestId)
        } else if (completed.has(requestId) && this.attempts.get(requestId)?.terminal === true) {
          this.attempts.delete(requestId)
        }
      }
      // A user can explicitly dismiss a request before its first local put, or
      // after a put response was lost. Always issue the idempotent native delete
      // even when this process has no record in its in-memory index; only a
      // successful delete may clear the pending dismissal.
      // 显式删除必须调用幂等 native remove，即使本进程没有本地索引记录；只有删除成功
      // 才能清理 pending 状态，避免“写入成功但响应丢失”的副本在重开后复活。
      for (const requestId of [...this.pendingDismissals]) {
        if (this.nativeRecords.has(requestId)) continue
        await native.remove(sessionId, requestId)
        this.pendingDismissals.delete(requestId)
        this.dismissedIds.add(requestId)
        this.attempts.delete(requestId)
        this.nativeUnconfirmed.delete(requestId)
      }
    }).catch(() => {
      this.nativeFailed = true
      for (const [requestId, text] of this.nativeRecords) {
        if (!this.attempts.has(requestId) && !this.dismissedIds.has(requestId)) {
          this.nativeUnconfirmed.set(requestId, text)
        }
      }
    }).finally(() => {
      this.nativePending -= 1
      this.localRecovery = this.nativeFailed ? 'failed' : this.nativePending === 0 ? 'saved' : 'saving'
      this.publish()
    })
  }

  private capture(submission: PendingSubmission): void {
    if (submission.text === '') return
    // Explicitly retrying the same retained input creates a new RPC identity.
    // 中文：显式重试同一保留输入会创建新的 RPC identity。
    for (const prior of this.attempts.values()) {
      if (prior.failure !== null && prior.text === submission.text) {
        this.pendingDismissals.delete(prior.requestId)
        this.supersededIds.add(prior.requestId)
        this.attempts.delete(prior.requestId)
      }
    }
    for (const [requestId, text] of this.nativeUnconfirmed) {
      if (text === submission.text) {
        this.pendingDismissals.delete(requestId)
        this.supersededIds.add(requestId)
        this.nativeUnconfirmed.delete(requestId)
      }
    }
    this.attempts.set(submission.requestId, {
      requestId: submission.requestId, text: submission.text, turn: null, failure: null, terminal: false,
    })
    this.generic = null
  }

  private readonly refresh = (): void => {
    const snapshot = this.session.getSnapshot()
    const currentIds = new Set<string>()
    for (const pending of snapshot.pendingSubmissions) {
      currentIds.add(pending.requestId)
      if (!this.pendingIds.has(pending.requestId)) this.capture(pending)
    }
    const retired = [...this.pendingIds].filter(id => !currentIds.has(id))
    this.pendingIds = currentIds

    // Durable terminal evidence takes precedence over sticky global errors.
    // 中文：持久化终态证据优先于粘滞的全局错误。
    observeEvents(this.attempts, this.events.getSnapshot(), this.hasNativeCapability())
    if (snapshot.promptError !== this.promptError) {
      this.promptError = snapshot.promptError
      if (snapshot.promptError?.op === 'send') {
        const kind = failureKind(snapshot.promptError.error)
        const correlated = retired.map(id => this.attempts.get(id))
          .filter((attempt): attempt is Attempt => attempt !== undefined)
        for (const attempt of correlated) attempt.failure = kind
        if (correlated.length === 0) this.generic = kind
      }
    }
    if (snapshot.lastAgentError !== this.agentError) {
      this.agentError = snapshot.lastAgentError
      if (snapshot.lastAgentError !== null) {
        const kind = failureKind(snapshot.lastAgentError)
        const unsettled = [...this.attempts.values()].filter(attempt => attempt.failure === null)
        for (const attempt of unsettled) attempt.failure = kind
        if (unsettled.length === 0 && this.attempts.size === 0) this.generic = kind
      }
    }
    if (this.connection.getSnapshot() === 'disconnected') {
      for (const attempt of this.attempts.values()) {
        if (attempt.failure === null) attempt.failure = 'transport'
      }
    }
    this.publish()
  }

  private publish(): void {
    this.syncNative()
    const retained = [...this.attempts.values()].flatMap(attempt =>
      attempt.failure === null ? [] : [{
        requestId: attempt.requestId, text: attempt.text, kind: attempt.failure,
      }])
    for (const [requestId, text] of this.nativeUnconfirmed) {
      if (!retained.some(item => item.requestId === requestId)) retained.push({ requestId, text, kind: 'recovered' })
    }
    const view: DeliveryView = {
      retained, generic: this.generic,
      ...(this.localRecovery === undefined ? {} : {
        localRecovery: this.localRecovery, unconfirmed: this.nativeUnconfirmed.size > 0,
      }),
    }
    if (JSON.stringify(view) === JSON.stringify(this.view)) return
    this.view = view
    for (const listener of this.listeners) listener()
  }
}

function notice(kind: FailureKind): string {
  if (kind === 'recovered') {
    return 'Recovered local input. Review the Session before choosing whether to send it.'
  }
  if (kind === 'ownership') {
    return 'This device no longer has write access. Observe Session ownership before continuing.'
  }
  if (kind === 'transport') {
    return 'The connection failed and delivery may be incomplete. Review the Session before retrying.'
  }
  return 'The turn failed. Review the Session before retrying.'
}

interface DeliveryFeedbackProps {
  readonly useInput: <T>(selector: (input: InputView) => T) => T
  readonly inputActions: InputActions
  readonly sessionSnapshot: Observable<SessionObservation>
  readonly events: Observable<EventWindow>
  readonly connection: Observable<string | undefined>
  readonly sessionId: string
}

function DeliveryFeedback({
  useInput, inputActions, sessionSnapshot, events, connection, sessionId,
}: DeliveryFeedbackProps): unknown {
  const input = useInput(value => value)
  const tracker = React.useMemo(
    () => new DeliveryTracker(sessionSnapshot, events, connection, sessionId),
    [sessionSnapshot, events, connection, sessionId],
  )
  const view = React.useSyncExternalStore(tracker.subscribe, tracker.getSnapshot)
  const messages: unknown[] = view.retained.map(item => React.createElement(
    'section',
    { key: item.requestId, 'data-cyrene-retained-input': item.requestId },
    React.createElement('p', null, notice(item.kind)),
    React.createElement('details', null,
      React.createElement('summary', null, 'Retained input'),
      React.createElement('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, item.text)),
    React.createElement('button', {
      type: 'button',
      disabled: input.phase !== 'plain' || input.draft !== '',
      onClick: () => {
        if (input.phase === 'plain' && input.draft === '') inputActions.setDraft(item.text)
      },
    }, 'Restore input'),
    React.createElement('button', { type: 'button', onClick: () => tracker.dismiss(item.requestId) }, 'Dismiss'),
  ))
  if (view.generic !== null) messages.push(React.createElement('section', { key: 'generic' },
    React.createElement('p', null, notice(view.generic) + ' This page has no associated input to restore.'),
    React.createElement('button', { type: 'button', onClick: () => tracker.dismiss(null) }, 'Dismiss')))
  if (messages.length === 0 && view.localRecovery !== 'failed' && view.localRecovery !== 'saving') return null
  if (view.localRecovery !== undefined) {
    const status = view.localRecovery === 'saved'
      ? 'Retained inputs are saved on this device. After reopening, select this Session and choose Restore input.'
      : view.localRecovery === 'failed'
        ? 'Local input recovery could not be updated. Copy any input you still need before closing Navigator.'
        : 'Updating local recovery inputs… Wait for confirmation before closing Navigator.'
    messages.push(React.createElement('p', { key: 'local-recovery', 'data-cyrene-local-recovery': view.localRecovery }, status))
    if (view.localRecovery === 'failed') messages.push(React.createElement('button', {
      key: 'retry-saving', type: 'button', onClick: () => tracker.retrySaving(),
    }, 'Retry local save'))
    else if (view.unconfirmed) messages.push(React.createElement('button', {
      key: 'check-delivery', type: 'button', onClick: () => tracker.checkDelivery(),
    }, 'Check delivery'))
  }
  return React.createElement('aside', {
    role: 'alert',
    'aria-live': 'polite',
    'data-cyrene-delivery-feedback': 'true',
    style: {
      // Dock entries span the seat; keep controls inside the shared composer
      // column so the upstream transcript resize strips cannot intercept them.
      // Dock 槽覆盖整个输入席位；使用共用列宽，避免按钮被上游宽度拖拽区遮挡。
      boxSizing: 'border-box', flex: 'none', minWidth: 0,
      width: 'calc(100% - 2 * var(--dsh-composer-side-clearance) - 2 * var(--dsh-composer-dock-inset))',
      maxWidth: 'calc(var(--dsh-composer-card-max-width) - 2 * var(--dsh-composer-dock-inset))',
      padding: '8px 12px', margin: '4px auto', border: '1px solid #d97706',
      borderRadius: '6px', fontSize: '12px', maxHeight: '240px', overflowY: 'auto',
    },
  }, ...messages)
}

/** Register a thin per-Session slot using only public client service faces.  中文：仅使用公开客户端服务接口注册轻量的逐 Session 插槽。  中文：仅使用公开客户端服务接口注册轻量的逐 Session 插槽。 */
const inject = ['slots', 'connection', 'sessions'] as const

function apply(ctx: object): void {
  const client = ctx as {
    slots: {
      inject(name: string, factory: () => unknown): void
      register(options: Record<string, unknown>, component: unknown): unknown
    }
    connection: { state: Observable<string | undefined> }
    sessions: {
      binding(id: string): {
        session: Observable<SessionObservation>
        eventSource: Observable<EventWindow>
      } | undefined
    }
  }
  client.slots.inject('conversation.input.dock', () => client.slots.register({
    name: 'conversation.input.dock',
    id: 'cyrene-delivery-feedback',
    order: 90,
    inject: (sessionId: string) => {
      const binding = client.sessions.binding(sessionId)
      if (binding === undefined) throw new Error('Delivery feedback requires an existing Session binding')
      return { sessionId, sessionSnapshot: binding.session, connection: client.connection.state, events: binding.eventSource }
    },
  }, DeliveryFeedback))
}

// The build entry wraps this face in the upstream Loader's CJS factory.
// 中文：构建入口会把此接口包装进上游 Loader 的 CJS factory。
module.exports = { inject, apply, DeliveryFeedback, DeliveryTracker }
