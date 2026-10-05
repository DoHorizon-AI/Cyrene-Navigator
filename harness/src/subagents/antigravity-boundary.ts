// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Antigravity sandbox boundary observer                       │
// │ Role: Detect explicit native permission denials without retaining  │
// │       child diagnostics or classifying assistant prose.             │
// │ 模块职责：识别原生权限拒绝，不保留子进程诊断或检查助手正文。          │
// └─────────────────────────────────────────────────────────────────────┘

import { StringDecoder } from 'node:string_decoder'
import { NativeSubagentFailure } from './common.js'

/** Stable code exposed to callers when Antigravity explicitly denies an action. */
export const SANDBOX_BOUNDARY_DENIED = 'SANDBOX_BOUNDARY_DENIED' as const

/** A safe native failure with no child-controlled text in its public fields. */
export type AntigravityBoundaryFailure = NativeSubagentFailure & {
  readonly code: typeof SANDBOX_BOUNDARY_DENIED
}

/** Safe blocked-work summary grouped by a fixed reason and allowlisted tool category. */
export interface AntigravityBlockedReceipt {
  readonly reasonCode: typeof SANDBOX_BOUNDARY_DENIED
  readonly toolCategory: 'file' | 'command' | 'network' | 'other' | 'unknown'
  readonly count: number
}

const MAX_PENDING_STDERR_CHARS = 2_048
const STDERR_TAIL_CHARS = 256
const MAX_BLOCKED_RECEIPT_COUNT = 100_000
const SAFE_FAILURE_MESSAGE = 'Antigravity could not execute the requested action.'
const SAFE_FAILURE_DIAGNOSTIC = '沙箱边界拒绝执行：无法执行该操作。'

/** Match only explicit denial language from native error fields or stderr notices. */
function explicitlyDenied(value: string): boolean {
  const pattern = /(?:soft[- ]denied|permission[-_ ]denied|sandbox[-_ ]denied|tool[-_ ]denied|permission (?:was )?denied|sandbox (?:has )?denied|not permitted by (?:the )?(?:sandbox|policy)|blocked by (?:the )?sandbox|permission required for\b.{0,240}\bdenied in headless mode|^\s*tool\b.{0,240}\bwas denied\b)/iu
  const stride = MAX_PENDING_STDERR_CHARS - STDERR_TAIL_CHARS
  for (let offset = 0; offset < value.length; offset += stride) {
    if (pattern.test(value.slice(offset, offset + MAX_PENDING_STDERR_CHARS))) return true
  }
  return false
}

/** Recognize explicit structured error types without looking at arbitrary frame text. */
function deniedType(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const type = value.toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')
  return type === 'eacces' || /^(?:permission|sandbox|tool)_(?:denied|blocked|rejected)$/u.test(type)
}

/** Read only documented native error/status slots; response and text deltas are ignored. */
function frameDenialCategory(frame: Record<string, unknown>): AntigravityBlockedReceipt['toolCategory'] | undefined {
  // Depending on event shape, tool_info is either at frame level or inside step_update.
  const stepUpdate = asObject(frame.step_update)
  for (const toolInfo of [asObject(frame.tool_info), asObject(stepUpdate?.tool_info)]) {
    const toolError = asObject(toolInfo?.error)
    if (toolError !== undefined && (deniedType(toolError.type)
      || (typeof toolError.message === 'string' && explicitlyDenied(toolError.message)))) {
      return classifyTool(toolInfo?.name ?? toolInfo?.tool ?? toolError.tool)
    }
  }

  const result = asObject(frame.result)
  if (result === undefined) return undefined
  const status = typeof result.status === 'string' ? result.status.toLowerCase().replaceAll('-', '_') : ''
  if (/^(?:denied|permission_denied|sandbox_denied|tool_denied|blocked)$/u.test(status)) {
    return classifyTool(result.tool ?? result.tool_name)
  }

  const resultError = result.error
  if (typeof resultError === 'string') {
    return explicitlyDenied(resultError) ? classifyTool(result.tool ?? result.tool_name) : undefined
  }
  const error = asObject(resultError)
  if (error !== undefined && (deniedType(error.type)
    || (typeof error.message === 'string' && explicitlyDenied(error.message)))) {
    return classifyTool(result.tool ?? result.tool_name ?? error.tool)
  }
  return undefined
}

/** Narrow unknown protocol fields without coercion or retaining their contents. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Map native tool labels to fixed categories; never return or retain the original label. */
function classifyTool(value: unknown): AntigravityBlockedReceipt['toolCategory'] {
  if (typeof value !== 'string') return 'unknown'
  const label = value.toLowerCase()
  if (/(?:file|read|write|edit|patch|directory|dir)/u.test(label)) return 'file'
  if (/(?:shell|bash|command|terminal|exec)/u.test(label)) return 'command'
  if (/(?:http|fetch|browser|web|network|search)/u.test(label)) return 'network'
  return 'other'
}

/** Infer a fixed category from a denial notice without preserving its native text. */
function classifyStderrLine(value: string): AntigravityBlockedReceipt['toolCategory'] {
  return classifyTool(value)
}

/** Construct the one fixed public failure; child paths, prompts, and tokens never escape. */
function boundaryFailure(): AntigravityBoundaryFailure {
  const failure = new NativeSubagentFailure(SAFE_FAILURE_MESSAGE, SAFE_FAILURE_DIAGNOSTIC)
  Object.defineProperty(failure, 'code', { value: SANDBOX_BOUNDARY_DENIED, enumerable: true })
  return failure as AntigravityBoundaryFailure
}

/**
 * Observe Antigravity's structured denial slots and bounded stderr stream.
 * This reports native denials; it does not itself create or enforce an OS sandbox.
 * 观察原生结构化拒绝与有界 stderr；该观察器本身不创建或强制执行操作系统沙箱。
 */
export class AntigravityBoundaryObserver {
  private denied = false
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private pendingDenialRecorded = false
  private readonly receiptCounts = new Map<AntigravityBlockedReceipt['toolCategory'], number>()

  /** Inspect only structured tool/result error fields, never assistant response text. */
  observeFrame(frame: Record<string, unknown>): void {
    const category = frameDenialCategory(frame)
    if (category !== undefined) {
      this.denied = true
      this.record(category)
    }
  }

  /** Return grouped fixed-field receipts with no native names or diagnostic contents. */
  getBlockedReceipts(): readonly AntigravityBlockedReceipt[] {
    return [...this.receiptCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([toolCategory, count]) => Object.freeze({
        reasonCode: SANDBOX_BOUNDARY_DENIED,
        toolCategory,
        count,
      }))
  }

  /**
   * Consume stderr incrementally, matching explicit soft-denial notices while keeping
   * only a short partial line. The denial latch survives subsequent diagnostics.
   * 分段读取 stderr，仅保留短行尾部；后续诊断不会清除已记录的拒绝状态。
   */
  observeStderr(chunk: Buffer | string): void {
    if (chunk.length === 0) return
    let text: string
    if (typeof chunk === 'string') {
      const decoderTail = this.decoder.end()
      this.decoder = new StringDecoder('utf8')
      text = decoderTail + chunk
    } else {
      text = this.decoder.write(chunk)
    }
    this.consumeStderrText(text)
  }

  /** Reject completion after any observed boundary denial with a fixed safe error. */
  assertAllowed(): void {
    // Call at child-stream completion so an unterminated stderr notice is still observed.
    const finalText = this.decoder.end()
    this.decoder = new StringDecoder('utf8')
    if (finalText.length > 0) this.consumeStderrText(finalText)
    if (this.pending.length > 0 && explicitlyDenied(this.pending) && !this.pendingDenialRecorded) {
      this.denied = true
      this.record(classifyStderrLine(this.pending))
      this.pendingDenialRecorded = true
    }
    if (this.denied) throw boundaryFailure()
  }

  /** Consume complete lines and scan oversized diagnostics before trimming their tail. */
  private consumeStderrText(text: string): void {
    let remainder = this.pending + text
    this.pending = ''
    let newline = remainder.indexOf('\n')
    while (newline >= 0) {
      const line = remainder.slice(0, newline).replace(/\r$/u, '')
      if (explicitlyDenied(line)) {
        this.denied = true
        if (!this.pendingDenialRecorded) this.record(classifyStderrLine(line))
      }
      this.pendingDenialRecorded = false
      remainder = remainder.slice(newline + 1)
      newline = remainder.indexOf('\n')
    }
    if (remainder.length > MAX_PENDING_STDERR_CHARS) {
      if (explicitlyDenied(remainder)) {
        this.denied = true
        if (!this.pendingDenialRecorded) this.record(classifyStderrLine(remainder))
        this.pendingDenialRecorded = true
      }
      this.pending = remainder.slice(-STDERR_TAIL_CHARS)
    } else {
      this.pending = remainder
    }
  }

  /** Aggregate one safe category count and discard every input value. */
  private record(toolCategory: AntigravityBlockedReceipt['toolCategory']): void {
    const count = this.receiptCounts.get(toolCategory) ?? 0
    this.receiptCounts.set(toolCategory, Math.min(count + 1, MAX_BLOCKED_RECEIPT_COUNT))
  }
}
