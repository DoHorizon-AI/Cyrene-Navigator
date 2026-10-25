// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 acp-mcp-host.ts                                                  │
// │  Module: harness/acp-mcp-host                                        │
// │  Role: Serve authorized connector tools to one CodeBuddy ACP task.   │
// │                                                                      │
// │  模块职责：为单个 ACP Work Task 提供受限的本机 MCP connector host。   │
// └─────────────────────────────────────────────────────────────────────┘

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { executeCodeBuddyAcpTool, getCodeBuddyAcpToolCatalog } from './tool-providers.js'
import { isJsonObject } from './subagents/wire.js'

const MAX_REQUEST_BYTES = 1_500_000
const MAX_RESPONSE_BYTES = 2_000_000
const MCP_HOST_CLOSE_GRACE_MS = 3_000

export interface AcpMcpHostOptions {
  readonly ctx: Context;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly readOnly: boolean;
  /** Bounded shutdown wait; callers only shorten this in local protocol tests. */
  readonly closeGraceMs?: number;
  readonly onToolCall?: (event: { name: string; callId: string; arguments: string }) => void | Promise<void>;
  readonly onToolResult?: (event: { name: string; callId: string; result: string; isError: boolean }) => void | Promise<void>;
}

/** One task-scoped loopback MCP bridge with a random capability token. */
export class AcpMcpHost {
  readonly token = randomBytes(32).toString('base64url')
  private readonly server: Server
  private readonly activeHandlers = new Set<Promise<void>>()
  private closing = false
  private closePromise: Promise<void> | undefined

  constructor(private readonly options: AcpMcpHostOptions) {
    if (options.closeGraceMs !== undefined
      && (!Number.isSafeInteger(options.closeGraceMs) || options.closeGraceMs < 1 || options.closeGraceMs > 30_000)) {
      throw new TypeError('MCP bridge close grace must be between 1 and 30000 milliseconds')
    }
    this.server = createServer((request, response) => {
      if (this.closing) {
        send(response, 503, { error: 'bridge_closing' })
        return
      }
      let active!: Promise<void>
      active = this.handle(request, response)
        .catch(() => {
          try {
            if (!response.destroyed && !response.headersSent) {
              send(response, 500, { error: 'bridge_request_failed' })
            }
          } catch {
            response.destroy()
          }
        })
        .finally(() => this.activeHandlers.delete(active))
      this.activeHandlers.add(active)
      void active.catch(() => {})
    })
    this.server.headersTimeout = 5_000
    this.server.requestTimeout = 30_000
    this.server.maxHeadersCount = 32
  }

  /** Bind to loopback only and expose a per-run opaque HTTP endpoint. */
  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('ACP MCP host did not bind a TCP endpoint')
    return `http://127.0.0.1:${address.port}/`
  }

  /** Stop accepting calls and wait for every active tool handler to settle. */
  close(): Promise<void> {
    this.closePromise ??= this.closeWithinGrace()
    return this.closePromise
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authenticated(request)) {
      send(response, 401, { error: 'unauthorized' })
      return
    }
    if (request.method === 'GET' && request.url === '/tools/list') {
      try {
        send(response, 200, { tools: getCodeBuddyAcpToolCatalog(this.options.ctx) })
      } catch {
        send(response, 503, { error: 'tool_catalog_unavailable' })
      }
      return
    }
    if (request.method !== 'POST' || request.url !== '/tools/call') {
      send(response, 404, { error: 'not_found' })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJsonObject(request)
    } catch {
      send(response, 400, { error: 'invalid_request' })
      return
    }
    try {
      const result = await this.execute(body)
      send(response, 200, result)
    } catch {
      send(response, 500, {
        isError: true,
        content: [{ type: 'text', text: 'Navigator could not complete the authorized tool call.' }],
      })
    }
  }

  private authenticated(request: IncomingMessage): boolean {
    const supplied = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice('Bearer '.length)
      : undefined
    if (supplied === undefined) return false
    const expectedBytes = Buffer.from(this.token, 'utf8')
    const suppliedBytes = Buffer.from(supplied, 'utf8')
    return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  }

  private async execute(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof body.name !== 'string' || body.name.length === 0 || body.name.length > 256
      || typeof body.callId !== 'string' || body.callId.length === 0 || body.callId.length > 512
      || !isJsonObject(body.arguments)) {
      return mcpError('The connector tool request is invalid.')
    }
    const catalog = getCodeBuddyAcpToolCatalog(this.options.ctx)
    const declared = catalog.find(item => item.name === body.name)
    if (declared === undefined) {
      return mcpError('Unknown or unauthorized connector tool.')
    }
    if (this.options.signal.aborted) return mcpError('The Work Task was cancelled before tool execution.')

    const argumentsJson = safeJsonText(body.arguments, 64_000)
    const callEvent = {
      name: declared.name,
      callId: body.callId,
      arguments: argumentsJson,
    }
    await this.options.onToolCall?.(callEvent)
    this.options.signal.throwIfAborted()

    let result: ToolExecutionResult | undefined
    try {
      result = await executeCodeBuddyAcpTool(this.options.ctx, {
        name: declared.name,
        arguments: body.arguments,
        callId: body.callId,
        sessionId: this.options.sessionId,
        signal: this.options.signal,
        readOnly: this.options.readOnly,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Connector tool execution failed.'
      const safeMessage = boundedMessage(message)
      await this.options.onToolResult?.({
        name: declared.name,
        callId: body.callId,
        result: safeMessage,
        isError: true,
      })
      return mcpError(safeMessage)
    }
    if (result === undefined) {
      await this.options.onToolResult?.({
        name: declared.name,
        callId: body.callId,
        result: 'Unknown or unauthorized connector tool.',
        isError: true,
      })
      return mcpError('Unknown or unauthorized connector tool.')
    }

    const content = mcpContent(result)
    const serialized = safeJsonText(content, MAX_RESPONSE_BYTES)
    await this.options.onToolResult?.({
      name: declared.name,
      callId: body.callId,
      result: serialized,
      isError: result.isError,
    })
    return {
      content,
      isError: result.isError,
      ...(!result.isError && result.value !== null && typeof result.value === 'object' && !Array.isArray(result.value)
        ? { structuredContent: result.value }
        : {}),
    }
  }

  private async closeWithinGrace(): Promise<void> {
    this.closing = true
    let closed: Promise<void> = Promise.resolve()
    if (this.server.listening) {
      closed = new Promise<void>((resolve, reject) => {
        this.server.close(error => error ? reject(error) : resolve())
      })
    }
    // The signal belongs to the run and is aborted by the backend before close.
    // Server.close alone only observes sockets and cannot prove tool promises ended.
    const settled = Promise.all([closed, ...this.activeHandlers]).then(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        settled,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('MCP bridge still has active tool handlers')),
            this.options.closeGraceMs ?? MCP_HOST_CLOSE_GRACE_MS)
        }),
      ])
    } catch {
      this.server.closeAllConnections()
      throw new Error('Navigator MCP bridge cleanup incomplete: an active tool handler did not settle after cancellation')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  let length = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > MAX_REQUEST_BYTES) throw new Error('Request exceeded the configured limit')
    chunks.push(bytes)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!isJsonObject(value)) throw new TypeError('Request body must be an object')
  return value
}

function mcpContent(result: ToolExecutionResult): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  for (const block of result.content) {
    if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
  }
  if (blocks.length === 0) {
    blocks.push({
      type: 'text',
      text: result.isError ? boundedMessage(result.error.message) : safeJsonText(result.value, MAX_RESPONSE_BYTES),
    })
  }
  return blocks
}

function mcpError(message: string): Record<string, unknown> {
  return { isError: true, content: [{ type: 'text', text: boundedMessage(message) }] }
}

function boundedMessage(value: string): string {
  return Buffer.byteLength(value, 'utf8') <= 4_000
    ? value
    : Buffer.from(value, 'utf8').subarray(0, 4_000).toString('utf8')
}

function safeJsonText(value: unknown, maximum: number): string {
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    return '[unavailable]'
  }
  if (Buffer.byteLength(text, 'utf8') <= maximum) return text
  return '[omitted: value exceeded the configured size limit]'
}

function send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (response.destroyed || response.writableEnded) return
  const text = JSON.stringify(body)
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'response_limit' }))
    return
  }
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text, 'utf8')),
    'cache-control': 'no-store',
  }).end(text)
}
