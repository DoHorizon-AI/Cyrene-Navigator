// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 acp-mcp-stdio.ts                                                 │
// │  Module: harness/acp-mcp-stdio                                       │
// │  Role: Expose the one Navigator-owned MCP host over child stdio.     │
// │                                                                      │
// │  模块职责：通过 stdio 暴露唯一由 Navigator 宿主拥有的 MCP 工具桥。    │
// └─────────────────────────────────────────────────────────────────────┘

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const MAX_FRAME_BYTES = 2_000_000
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])
const bridgeUrl = process.env.NAVIGATOR_ACP_BRIDGE_URL
const bridgeToken = process.env.NAVIGATOR_ACP_BRIDGE_TOKEN
const bridgeSession = randomUUID()

interface RpcRequest {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
}

/** Read one request from the MCP stdio peer without exposing bridge diagnostics. */
async function handleLine(line: string): Promise<void> {
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) return
  let request: RpcRequest
  try {
    request = JSON.parse(line) as RpcRequest
  } catch {
    return
  }
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') return
  const hasId = typeof request.id === 'string' || typeof request.id === 'number'
  if (!hasId && request.method.startsWith('notifications/')) return

  try {
    const result = await dispatch(request)
    if (hasId) writeFrame({ jsonrpc: '2.0', id: request.id, result })
  } catch (error: unknown) {
    if (hasId) {
      const code = error instanceof McpRpcFailure ? error.code : -32603
      const message = error instanceof McpRpcFailure ? error.message : 'Navigator MCP bridge request failed.'
      writeFrame({ jsonrpc: '2.0', id: request.id, error: { code, message } })
    }
  }
}

/** Implement only initialization and the two tool methods required by this host. */
async function dispatch(request: RpcRequest): Promise<Record<string, unknown>> {
  switch (request.method) {
    case 'initialize': {
      const params = isRecord(request.params) ? request.params : {}
      const protocolVersion = params.protocolVersion
      if (typeof protocolVersion !== 'string' || !SUPPORTED_PROTOCOLS.has(protocolVersion)) {
        throw new McpRpcFailure(-32602, 'Unsupported MCP protocol version.')
      }
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'navigator-authorized-tools', version: '1.0.0' },
      }
    }
    case 'notifications/initialized':
      return {}
    case 'ping':
      return {}
    case 'tools/list':
      return await bridgeRequest('/tools/list', 'GET')
    case 'tools/call': {
      const params = isRecord(request.params) ? request.params : {}
      if (typeof params.name !== 'string' || params.name.length === 0 || params.name.length > 256) {
        throw new McpRpcFailure(-32602, 'MCP tool name is invalid.')
      }
      const argumentsValue = params.arguments === undefined ? {} : params.arguments
      if (!isRecord(argumentsValue)) throw new McpRpcFailure(-32602, 'MCP tool arguments must be an object.')
      return await bridgeRequest('/tools/call', 'POST', {
        name: params.name,
        arguments: argumentsValue,
        callId: `mcp:${bridgeSession}:${String(request.id)}`,
      })
    }
    default:
      throw new McpRpcFailure(-32601, 'Navigator MCP bridge method is unsupported.')
  }
}

/** Send one authenticated, bounded local request to the task-owned tool host. */
async function bridgeRequest(
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (bridgeUrl === undefined || bridgeToken === undefined) {
    throw new McpRpcFailure(-32000, 'Navigator MCP bridge is unavailable.')
  }
  let response: Response
  try {
    response = await fetch(new URL(path, bridgeUrl), {
      method,
      headers: {
        authorization: `Bearer ${bridgeToken}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    })
  } catch {
    throw new McpRpcFailure(-32000, 'Navigator MCP bridge is unavailable.')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
    throw new McpRpcFailure(-32000, 'Navigator MCP bridge response exceeded its limit.')
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new McpRpcFailure(-32000, 'Navigator MCP bridge returned an invalid response.')
  }
  if (!response.ok || !isRecord(value)) {
    throw new McpRpcFailure(-32000, 'Navigator MCP bridge rejected the request.')
  }
  return value
}

/** Write exactly one newline-delimited JSON-RPC frame to the MCP client. */
function writeFrame(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** Narrow JSON objects before using their fields as MCP protocol input. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

class McpRpcFailure extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = 'McpRpcFailure'
  }
}

if (bridgeUrl === undefined || bridgeToken === undefined) {
  process.exitCode = 1
} else {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', line => { void handleLine(line) })
}
