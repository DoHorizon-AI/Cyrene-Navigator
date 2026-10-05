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

/** A JSON object after strict frame parsing. */
export type JsonObject = Record<string, unknown>

/** Detect plain JSON object frames without accepting arrays or null. */
export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse one bounded UTF-8 JSON object and hide raw malformed payloads. */
export function parseJsonFrame(frame: Buffer): JsonObject {
  if (frame.byteLength > MAX_NATIVE_FRAME_BYTES) {
    throw new Error('native protocol frame exceeds the configured byte limit')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(frame)
  } catch {
    throw new Error('native protocol frame is not valid UTF-8')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('native protocol frame is not valid JSON')
  }
  if (!isJsonObject(value)) throw new Error('native protocol frame must be a JSON object')
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
    onFailure(error)
  }

  void (async (): Promise<void> => {
    let buffered: Buffer = Buffer.alloc(0)
    let totalBytes = 0
    let frameCount = 0
    try {
      for await (const chunk of stream) {
        if (signal.aborted) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        totalBytes += bytes.byteLength
        if (totalBytes > MAX_NATIVE_STREAM_BYTES) {
          throw new Error('native protocol stream exceeds the configured byte limit')
        }
        buffered = buffered.length === 0 ? bytes : Buffer.concat([buffered, bytes])
        let newline = buffered.indexOf(0x0a)
        while (newline >= 0) {
          let frame = buffered.subarray(0, newline)
          buffered = buffered.subarray(newline + 1)
          if (frame.at(-1) === 0x0d) frame = frame.subarray(0, frame.length - 1)
          if (frame.length === 0) throw new Error('native protocol emitted an empty frame')
          frameCount += 1
          if (frameCount > MAX_NATIVE_STREAM_FRAMES) {
            throw new Error('native protocol stream exceeds the configured frame limit')
          }
          onFrame(parseJsonFrame(frame))
          newline = buffered.indexOf(0x0a)
        }
        if (buffered.byteLength > MAX_NATIVE_FRAME_BYTES) {
          throw new Error('native protocol frame exceeds the configured byte limit')
        }
      }
      if (buffered.length > 0) throw new Error('native protocol closed with an incomplete frame')
      if (!signal.aborted) fail(new Error('native protocol stream closed'))
    } catch (error: unknown) {
      if (signal.aborted) return
      fail(error instanceof Error ? error : new Error('native protocol reader failed'))
    }
  })()
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
