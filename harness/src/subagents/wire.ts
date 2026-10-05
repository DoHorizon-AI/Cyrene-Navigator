// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Bounded child-process wire utilities                        │
// │ Role: Frame, validate, and write newline-delimited JSON safely.     │
// │ 模块职责：对受监管子进程的 NDJSON 进行有界封装与校验。                  │
// └─────────────────────────────────────────────────────────────────────┘

import type { Readable, Writable } from 'node:stream'

/** Maximum encoded size of one native event or RPC frame. */
export const MAX_NATIVE_FRAME_BYTES = 1_048_576

/** Maximum assistant output retained for one child turn. */
export const MAX_NATIVE_OUTPUT_BYTES = 2_097_152

/** Total stdio payload per native turn, including progress and protocol frames. */
export const MAX_NATIVE_STREAM_BYTES = 16_777_216

/** Maximum number of protocol records from one child turn. */
export const MAX_NATIVE_STREAM_FRAMES = 100_000

/** Maximum encoded length of a native conversation/thread identifier. */
export const MAX_NATIVE_IDENTIFIER_BYTES = 512

/** Stable, payload-free categories for failures while reading a native NDJSON stream. */
export type NativeWireFailureCode =
  | 'NATIVE_FRAME_LIMIT'
  | 'NATIVE_STREAM_LIMIT'
  | 'NATIVE_FRAME_COUNT_LIMIT'
  | 'NATIVE_INVALID_UTF8'
  | 'NATIVE_INVALID_JSON'
  | 'NATIVE_INVALID_OBJECT'
  | 'NATIVE_EMPTY_FRAME'
  | 'NATIVE_INCOMPLETE_FRAME'
  | 'NATIVE_PREMATURE_EOF'
  | 'NATIVE_UNKNOWN_READER_ERROR'
  | 'NATIVE_CALLBACK_FAILED'

const nativeWireMessages: Record<NativeWireFailureCode, string> = {
  NATIVE_FRAME_LIMIT: 'Native protocol frame exceeds the configured byte limit',
  NATIVE_STREAM_LIMIT: 'Native protocol stream exceeds the configured byte limit',
  NATIVE_FRAME_COUNT_LIMIT: 'Native protocol stream exceeds the configured frame limit',
  NATIVE_INVALID_UTF8: 'Native protocol frame is not valid UTF-8',
  NATIVE_INVALID_JSON: 'Native protocol frame is not valid JSON',
  NATIVE_INVALID_OBJECT: 'Native protocol frame must be a JSON object',
  NATIVE_EMPTY_FRAME: 'Native protocol emitted an empty frame',
  NATIVE_INCOMPLETE_FRAME: 'Native protocol closed with an incomplete frame',
  NATIVE_PREMATURE_EOF: 'Native protocol stream closed before completion',
  NATIVE_UNKNOWN_READER_ERROR: 'Native protocol reader failed',
  NATIVE_CALLBACK_FAILED: 'Native protocol frame callback failed',
}

const nativeWireFailureCodes = new Set<string>(Object.keys(nativeWireMessages))

/**
 * A sanitized native wire failure with only stable classification and byte/frame counts.
 * The original payload or reader error is never attached to this error.
 */
export class NativeWireFailure extends Error {
  readonly code: NativeWireFailureCode
  readonly bytesObserved: number
  readonly framesObserved: number

  constructor(code: NativeWireFailureCode, bytesObserved = 0, framesObserved = 0) {
    const safeCode = nativeWireFailureCodes.has(code) ? code : 'NATIVE_UNKNOWN_READER_ERROR'
    super(nativeWireMessages[safeCode])
    this.name = 'NativeWireFailure'
    this.code = safeCode
    this.bytesObserved = safeCount(bytesObserved)
    this.framesObserved = safeCount(framesObserved)
  }
}

/**
 * Return a fixed safe diagnostic for a recognized wire failure.
 * Cumulative limit diagnostics include only numeric observations from the trusted failure class.
 */
export function nativeWireDiagnostic(error: unknown): string | undefined {
  if (!(error instanceof NativeWireFailure)) return undefined
  const message = nativeWireMessages[error.code]
  if (message === undefined) return undefined
  if (error.code === 'NATIVE_FRAME_LIMIT'
    || error.code === 'NATIVE_STREAM_LIMIT'
    || error.code === 'NATIVE_FRAME_COUNT_LIMIT') {
    return `${error.code}: ${message} (observed ${safeCount(error.bytesObserved)} bytes across ${safeCount(error.framesObserved)} frames)`
  }
  return `${error.code}: ${message}`
}

function safeCount(value: number): number {
  return Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value))
    : 0
}

/** A JSON object after strict frame parsing. */
export type JsonObject = Record<string, unknown>

/** Detect plain JSON object frames without accepting arrays or null. */
export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse one bounded UTF-8 JSON object and hide raw malformed payloads. */
export function parseJsonFrame(
  frame: Buffer,
  observed: { bytesObserved: number; framesObserved: number } = {
    bytesObserved: frame.byteLength,
    framesObserved: 1,
  },
): JsonObject {
  if (frame.byteLength > MAX_NATIVE_FRAME_BYTES) {
    throw new NativeWireFailure('NATIVE_FRAME_LIMIT', observed.bytesObserved, observed.framesObserved)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(frame)
  } catch {
    throw new NativeWireFailure('NATIVE_INVALID_UTF8', observed.bytesObserved, observed.framesObserved)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new NativeWireFailure('NATIVE_INVALID_JSON', observed.bytesObserved, observed.framesObserved)
  }
  if (!isJsonObject(value)) {
    throw new NativeWireFailure('NATIVE_INVALID_OBJECT', observed.bytesObserved, observed.framesObserved)
  }
  return value
}

/** Pump NDJSON frames while retaining partial chunks and rejecting oversized or malformed lines. */
export function pumpJsonLines(
  stream: Readable,
  signal: AbortSignal,
  onFrame: (frame: JsonObject) => void,
  onFailure: (error: Error) => void,
): void {
  let failed = false
  const fail = (error: Error): void => {
    if (failed || signal.aborted) return
    failed = true
    try {
      onFailure(error)
    } catch {
      // Failure reporters are user callbacks too; they must not escape the detached pump task.
    }
  }

  let buffered: Buffer = Buffer.alloc(0)
  let totalBytes = 0
  let frameCount = 0
  const unknownReaderFailure = (): NativeWireFailure =>
    new NativeWireFailure('NATIVE_UNKNOWN_READER_ERROR', totalBytes, frameCount)

  const run = async (): Promise<void> => {
    try {
      for await (const chunk of stream) {
        if (signal.aborted) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        totalBytes += bytes.byteLength
        if (totalBytes > MAX_NATIVE_STREAM_BYTES) {
          fail(new NativeWireFailure('NATIVE_STREAM_LIMIT', totalBytes, frameCount))
          return
        }
        buffered = buffered.length === 0 ? bytes : Buffer.concat([buffered, bytes])
        let newline = buffered.indexOf(0x0a)
        while (newline >= 0) {
          let frame = buffered.subarray(0, newline)
          buffered = buffered.subarray(newline + 1)
          if (frame.at(-1) === 0x0d) frame = frame.subarray(0, frame.length - 1)
          frameCount += 1
          if (frame.length === 0) {
            fail(new NativeWireFailure('NATIVE_EMPTY_FRAME', totalBytes, frameCount))
            return
          }
          if (frameCount > MAX_NATIVE_STREAM_FRAMES) {
            fail(new NativeWireFailure('NATIVE_FRAME_COUNT_LIMIT', totalBytes, frameCount))
            return
          }
          let parsed: JsonObject
          try {
            parsed = parseJsonFrame(frame, { bytesObserved: totalBytes, framesObserved: frameCount })
          } catch (error: unknown) {
            fail(error instanceof NativeWireFailure ? error : unknownReaderFailure())
            return
          }
          try {
            onFrame(parsed)
          } catch {
            fail(new NativeWireFailure('NATIVE_CALLBACK_FAILED', totalBytes, frameCount))
            return
          }
          if (signal.aborted) return
          newline = buffered.indexOf(0x0a)
        }
        if (buffered.byteLength > MAX_NATIVE_FRAME_BYTES) {
          fail(new NativeWireFailure('NATIVE_FRAME_LIMIT', totalBytes, frameCount))
          return
        }
      }
      if (signal.aborted) return
      if (buffered.length > 0) {
        fail(new NativeWireFailure('NATIVE_INCOMPLETE_FRAME', totalBytes, frameCount))
        return
      }
      fail(new NativeWireFailure('NATIVE_PREMATURE_EOF', totalBytes, frameCount))
    } catch (error: unknown) {
      if (signal.aborted) return
      fail(error instanceof NativeWireFailure
        ? new NativeWireFailure(error.code, totalBytes, frameCount)
        : unknownReaderFailure())
    }
  }

  void run().catch(() => fail(unknownReaderFailure()))
}

/** Write one bounded NDJSON frame and honor stream backpressure. */
export async function writeJsonLine(stream: Writable, value: JsonObject): Promise<void> {
  const frame = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  if (frame.byteLength > MAX_NATIVE_FRAME_BYTES) {
    throw new Error('native protocol request exceeds the configured byte limit')
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      stream.off('error', onError)
      stream.off('drain', onDrain)
    }
    const complete = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onError = (error: Error): void => complete(error)
    const onDrain = (): void => complete()
    stream.once('error', onError)
    try {
      if (stream.write(frame)) complete()
      else stream.once('drain', onDrain)
    } catch (error: unknown) {
      complete(error instanceof Error ? error : new Error('native protocol write failed'))
    }
  })
}

/** Read an optional string field without coercing untrusted protocol values. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read a bounded identifier without coercing untrusted protocol values. */
export function optionalIdentifier(value: unknown): string | undefined {
  const result = optionalString(value)
  if (result !== undefined && Buffer.byteLength(result, 'utf8') > MAX_NATIVE_IDENTIFIER_BYTES) {
    throw new Error('native protocol identifier exceeds the configured byte limit')
  }
  return result
}

/** Read a required non-empty string field. */
export function requiredString(value: unknown, label: string): string {
  const result = optionalString(value)
  if (result === undefined) throw new Error(`native protocol omitted ${label}`)
  return result
}

/** Read a required bounded identifier without including child data in errors. */
export function requiredIdentifier(value: unknown, label: string): string {
  const result = requiredString(value, label)
  if (Buffer.byteLength(result, 'utf8') > MAX_NATIVE_IDENTIFIER_BYTES) {
    throw new Error('native protocol identifier exceeds the configured byte limit')
  }
  return result
}
