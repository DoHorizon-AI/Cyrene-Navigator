// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 codebuddy-acp-execution.ts                                       │
// │  Module: harness/codebuddy-acp-execution                             │
// │  Role: Run one native CodeBuddy ACP turn under Navigator ownership.  │
// │                                                                      │
// │  模块职责：由 Navigator 管理 Work Task 并执行 CodeBuddy 原生 ACP 轮次。│
// └─────────────────────────────────────────────────────────────────────┘

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AcpMcpHost } from './acp-mcp-host.js'
import { getCodeBuddyAcpToolCatalog } from './tool-providers.js'
import { AcpStdioClient, authUnavailableFailure, isAuthRequired } from './subagents/acp.js'
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

const CODEBUDDY_MODELS = new Set(['glm-5.3-flash', 'deepseek-v4.1-flash'])
const CODEBUDDY_SETTINGS = JSON.stringify({ disableAllHooks: true, enabledPlugins: {} })
const __dirname = dirname(fileURLToPath(import.meta.url))
const MCP_SERVER_ENTRYPOINT = join(__dirname, 'acp-mcp-stdio.js')

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
  readonly name: 'codebuddy-acp';
  execute(input: ConversationExecutionInput): Promise<ConversationExecutionResult>;
}

/** Fixed host profile and test seams for one CodeBuddy ACP process. */
export interface CodeBuddyAcpExecutionOptions {
  readonly ctx: Context;
  readonly workState: WorkStateStore;
  readonly model?: string;
  /** Test-only executable seam; production selection is validated in serve.ts. */
  readonly command?: string;
  /** Test-only prefix used to start a local ACP protocol fixture. */
  readonly commandArgsPrefix?: readonly string[];
  /** Test-only bridge script override; production uses the bundled sibling entrypoint. */
  readonly mcpServerEntrypoint?: string;
  readonly startupTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly disposeGraceMs?: number;
  readonly mcpCloseGraceMs?: number;
}

/** Implement a top-level CodeBuddy turn without creating or invoking a DSH Agent. */
export class CodeBuddyAcpExecutionBackend implements ConversationExecutionBackend {
  readonly name = 'codebuddy-acp' as const
  private readonly command: string
  private readonly commandArgsPrefix: readonly string[]
  private readonly model: string
  private readonly mcpServerEntrypoint: string
  private readonly startupTimeoutMs: number
  private readonly turnTimeoutMs: number
  private readonly disposeGraceMs: number
  private readonly mcpCloseGraceMs: number | undefined

  constructor(private readonly options: CodeBuddyAcpExecutionOptions) {
    this.command = options.command ?? 'codebuddy'
    this.commandArgsPrefix = options.commandArgsPrefix ?? []
    this.model = validateCodeBuddyModel(options.model)
    this.mcpServerEntrypoint = resolve(options.mcpServerEntrypoint ?? MCP_SERVER_ENTRYPOINT)
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    this.disposeGraceMs = options.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
    this.mcpCloseGraceMs = options.mcpCloseGraceMs
  }

  /** Load or create a native session, then send exactly one user turn. */
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
      prior = await this.options.workState.getBackendSession(input.taskId)
      if (prior !== undefined && (prior.backend !== 'codebuddy-acp' || prior.sessionId !== input.sessionId)) {
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
      signal: runController.signal,
      readOnly: input.readOnly,
      ...(this.mcpCloseGraceMs === undefined ? {} : { closeGraceMs: this.mcpCloseGraceMs }),
      ...(input.onToolCall === undefined ? {} : { onToolCall: input.onToolCall }),
      ...(input.onToolResult === undefined ? {} : { onToolResult: input.onToolResult }),
    })
    let mcpConfigFile: PrivateConfigFile | undefined
    let child: SubprocessHandle | undefined
    let peer: AcpStdioClient | undefined
    let conversationId: string | undefined
    let output = ''
    let diagnostic: string | undefined
    let result: ConversationExecutionResult | undefined
    let failure: unknown
    let cleanupFailure: unknown
    let authorizationPaused = false

    try {
      const mcpUrl = await mcpHost.listen()
      mcpConfigFile = createPrivateMcpConfigFile({
        mcpServers: {
          navigator: {
            type: 'stdio',
            command: process.execPath,
            args: [this.mcpServerEntrypoint],
            alwaysLoad: true,
            env: {
              NAVIGATOR_ACP_BRIDGE_URL: mcpUrl,
              NAVIGATOR_ACP_BRIDGE_TOKEN: mcpHost.token,
            },
          },
        },
      })
      child = this.spawnChild(
        mcpConfigFile.cwd, mcpConfigFile.path, mcpConfigFile.childHome, mcpConfigFile.profileRoot,
      )
      let peerFailure: Error | undefined
      peer = new AcpStdioClient(
        child,
        new AbortController().signal,
        (method, params) => {
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
          return this.answerPermission(params)
        },
        error => { diagnostic ??= safeAcpDiagnostic(error) },
      )

      const initValue = await withRunDeadline(
        peer.request('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'cyrene-navigator', version: '0.1.0' },
          clientCapabilities: {},
        }),
        runController,
        this.startupTimeoutMs,
        'CodeBuddy ACP initialize',
      )
      const init = objectResult(initValue, 'initialize')
      if (init.protocolVersion !== 1) {
        throw new NativeSubagentFailure(
          'CodeBuddy ACP protocol version is unsupported',
          'NATIVE_PROTOCOL_UNSUPPORTED: ACP protocol version 1 is required.',
        )
      }
      const canLoadSession = isJsonObject(init.agentCapabilities) && init.agentCapabilities.loadSession === true
      if (prior !== undefined) {
        if (!canLoadSession) {
          throw new NativeSubagentFailure(
            'CodeBuddy ACP cannot restore the stored native session',
            'NATIVE_SESSION_RESUME_UNSUPPORTED: CodeBuddy ACP did not advertise session/load; prior context was preserved.',
          )
        }
        await withRunDeadline(peer.request('session/load', {
          sessionId: prior.nativeSessionId,
          cwd: mcpConfigFile.cwd,
          mcpServers: [],
        }), runController, this.startupTimeoutMs, 'CodeBuddy ACP session load')
        conversationId = prior.nativeSessionId
      } else {
        const createdValue = await withRunDeadline(peer.request('session/new', {
          cwd: mcpConfigFile.cwd,
          mcpServers: [],
        }), runController, this.startupTimeoutMs, 'CodeBuddy ACP session creation')
        const created = objectResult(createdValue, 'session/new')
        conversationId = requiredIdentifier(created.sessionId, 'session id')
        // Persist before prompting so a process restart never invents a replacement context.
        const bound = await this.options.workState.bindBackendSession(input.taskId, conversationId)
        if (bound.sessionId !== input.sessionId || bound.nativeSessionId !== conversationId) {
          throw new NativeSubagentFailure(
            'Navigator could not bind the ACP session to this Work session',
            'NATIVE_SESSION_MAPPING_CONFLICT: Work did not confirm the exact ACP session mapping.',
          )
        }
      }
      await this.options.workState.appendEvent(input.taskId, {
        type: 'execution.backend_session',
        backend: 'codebuddy-acp',
        resumed: prior !== undefined,
        legacyDshHistoryImported: false,
      })
      currentTurn = true
      const prompt = prior === undefined
        ? migrationAwarePrompt(input.prompt)
        : input.prompt
      const promptValue = await withRunDeadline(peer.request('session/prompt', {
        sessionId: conversationId,
        prompt: [{ type: 'text', text: prompt }],
      }), runController, this.turnTimeoutMs, 'CodeBuddy ACP prompt')
      const promptResult = objectResult(promptValue, 'session/prompt')
      if (peerFailure !== undefined) throw peerFailure
      switch (promptResult.stopReason) {
        case 'end_turn':
        case 'refusal':
          result = { stopReason: promptResult.stopReason, nativeSessionId: conversationId, output }
          break
        case 'cancelled':
          if (input.signal.aborted) throw abortFailure(input.signal)
          if (input.authorizationPauseSignal.aborted) {
            authorizationPaused = true
            break
          }
          throw new NativeSubagentFailure('CodeBuddy ACP cancelled the turn', 'NATIVE_STOP_CANCELLED: CodeBuddy ACP cancelled the task.')
        case 'max_tokens':
          throw new NativeSubagentFailure('CodeBuddy ACP reached its output limit', 'NATIVE_STOP_MAX_TOKENS: ACP returned partial output at its token limit.')
        default:
          throw new NativeSubagentFailure('CodeBuddy ACP turn failed', 'NATIVE_STOP_ERROR: ACP did not complete the requested turn.')
      }
    } catch (error: unknown) {
      if (currentTurn && conversationId !== undefined) nativeTurnNeedsCancel = true
      runController.abort(error)
      authorizationPaused = input.authorizationPauseSignal.aborted && !input.signal.aborted
      if (!authorizationPaused) {
        failure = diagnostic === undefined
          ? safeAcpFailure(error, input.signal)
          : new NativeSubagentFailure(diagnostic, diagnostic)
      }
    } finally {
      // Stop connector and approval work before reaping the protocol child or MCP listener.
      runController.abort(new Error('CodeBuddy ACP run is terminating.'))
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
            if (outcome.exitCode !== 0 || outcome.signal !== null) {
              const exit = outcome.exitCode === null ? `signal ${outcome.signal ?? 'unknown'}` : `code ${outcome.exitCode}`
              failure = new NativeSubagentFailure(
                `NATIVE_PROCESS_EXIT: CodeBuddy ACP exited with ${exit}.`,
                `NATIVE_PROCESS_EXIT: CodeBuddy ACP exited with ${exit}.`,
              )
            }
          }
        } catch {
          cleanupFailure = new NativeSubagentFailure(
            'CodeBuddy ACP process cleanup failed',
            'NATIVE_PROCESS_CLEANUP_FAILED: Navigator could not confirm CodeBuddy ACP process cleanup.',
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
      if (mcpConfigFile !== undefined) {
        try {
          mcpConfigFile.cleanup()
        } catch {
          cleanupFailure ??= new NativeSubagentFailure(
            'CodeBuddy MCP configuration cleanup failed',
            'NATIVE_MCP_CONFIG_CLEANUP_FAILED: Navigator could not remove the task-local MCP configuration.',
          )
        }
      }
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
        'CodeBuddy ACP cleanup is incomplete',
        failure === undefined
          ? 'NATIVE_CLEANUP_INCOMPLETE: Navigator could not confirm that all task-local CodeBuddy resources and authorized tool handlers stopped.'
          : 'NATIVE_CLEANUP_INCOMPLETE: CodeBuddy ACP failed and Navigator could not confirm that every authorized tool handler stopped.',
      )
    }
    if (failure !== undefined) throw failure
    if (result === undefined) {
      throw new NativeSubagentFailure('CodeBuddy ACP returned no terminal result', diagnostic ?? 'NATIVE_RESULT_MISSING: ACP returned no terminal result.')
    }
    return result
  }

  private spawnChild(cwd: string, configPath: string, childHome: string, profileRoot: string): SubprocessHandle {
    const args = [
      ...this.commandArgsPrefix,
      '--acp', '--acp-transport', 'stdio', '--agent', 'cli', '--permission-mode', 'default',
      '--tools', '', '--strict-mcp-config', '--mcp-config', configPath,
      '--setting-sources', 'project,local',
      '--settings', CODEBUDDY_SETTINGS,
      '--model', this.model,
    ]
    const spec: SubprocessSpawnSpec = {
      argv: [this.command, ...args],
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: this.disposeGraceMs,
      env: isolatedCodeBuddyEnvironment(childHome, profileRoot),
    }
    const child = this.options.ctx.subprocess.spawn(spec)
    child.stderr?.on('data', () => {})
    child.done.catch(() => {})
    return child
  }

  private async answerPermission(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const toolCall = isJsonObject(params.toolCall) ? params.toolCall : {}
    const kind = optionalString(toolCall.kind)
    const rawInput = isJsonObject(toolCall.rawInput) ? toolCall.rawInput : {}
    const serverName = [rawInput.serverName, rawInput.server, rawInput.name]
      .find(value => typeof value === 'string') as string | undefined
    const requestedTool = [rawInput.toolName, rawInput.tool]
      .find(value => typeof value === 'string') as string | undefined
    const knownTools = new Set(getCodeBuddyAcpToolCatalog(this.options.ctx).map(tool => tool.name))
    const trustedMcpPermission = kind === 'mcp'
      && serverName === 'navigator'
      && requestedTool !== undefined
      && knownTools.has(requestedTool)
    const options = Array.isArray(params.options) ? params.options.filter(isJsonObject) : []
    const selection = trustedMcpPermission
      ? options.find(option => option.kind === 'allow_once' && typeof option.optionId === 'string')
      : options.find(option => option.kind === 'reject_once' && typeof option.optionId === 'string')
    if (selection !== undefined) return { outcome: { outcome: 'selected', optionId: selection.optionId } }
    return { outcome: { outcome: 'cancelled' } }
  }
}

/** Choose an allowlisted CodeBuddy model; an empty deployment value uses GLM. */
export function validateCodeBuddyModel(value: string | undefined): string {
  const model = value === undefined || value === '' ? 'glm-5.3-flash' : value
  if (!CODEBUDDY_MODELS.has(model)) {
    throw new TypeError('CYRENE_HARNESS_CODEBUDDY_ACP_MODEL must be glm-5.3-flash or deepseek-v4.1-flash')
  }
  return model
}

/** Abort the entire run when an ACP protocol operation exceeds its fixed deadline. */
async function withRunDeadline<T>(
  promise: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
  label: string,
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
        'NATIVE_TIMEOUT: CodeBuddy ACP request timed out; task-local tool operations were cancelled and reconciled as uncertain when needed.',
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

/** Preserve only the CodeBuddy profile and basic runtime/network environment. */
export function isolatedCodeBuddyEnvironment(childHome?: string, profileRoot?: string): NodeJS.ProcessEnv {
  const allowedNames = new Set([
    'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'CODEBUDDY_HOME',
    'CODEBUDDY_CONFIG_DIR',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL',
    'LC_CTYPE', 'TZ', 'TERM', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY', 'SSL_CERT_FILE',
    'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE',
  ])
  const env: NodeJS.ProcessEnv = {}
  for (const name of Object.keys(process.env)) env[name] = undefined
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (allowedNames.has(name) || /^LC_[A-Z0-9_]+$/u.test(name))) env[name] = value
  }
  if (childHome !== undefined) {
    env.HOME = childHome
    env.USERPROFILE = childHome
    env.APPDATA = join(childHome, 'AppData', 'Roaming')
    env.LOCALAPPDATA = join(childHome, 'AppData', 'Local')
    env.XDG_CONFIG_HOME = join(childHome, '.config')
    env.XDG_CACHE_HOME = join(childHome, '.cache')
    env.XDG_DATA_HOME = join(childHome, '.local', 'share')
    env.XDG_STATE_HOME = join(childHome, '.local', 'state')
  }
  if (profileRoot !== undefined) env.CODEBUDDY_CONFIG_DIR = profileRoot
  return env
}

interface PrivateConfigFile {
  readonly path: string;
  readonly cwd: string;
  readonly childHome: string;
  readonly profileRoot: string;
  cleanup(): void;
}

/** Write the bridge capability below CodeBuddy's stable private CWD, never to CLI argv. */
function createPrivateMcpConfigFile(value: Record<string, unknown>): PrivateConfigFile {
  const encoded = JSON.stringify(value)
  const configuredHome = process.env.CODEBUDDY_CONFIG_DIR
    ?? process.env.CODEBUDDY_HOME
    ?? join(process.env.HOME ?? homedir(), '.codebuddy')
  if (!isAbsolute(configuredHome)) {
    throw new Error('Navigator CodeBuddy configuration path must be absolute')
  }
  const configuredRoot = resolve(configuredHome)
  try {
    mkdirSync(configuredRoot, { mode: 0o700, recursive: true })
  } catch {
    throw new Error('Navigator could not access the private CodeBuddy configuration directory')
  }
  let profileRoot: string
  try {
    profileRoot = resolve(realpathSync(configuredRoot))
  } catch {
    throw new Error('Navigator could not resolve the private CodeBuddy configuration directory')
  }
  const cwd = join(profileRoot, 'navigator-acp-workspace')
  const childHome = join(profileRoot, 'navigator-cli-home')
  ensurePrivateDirectory(cwd, 'Navigator could not create the private CodeBuddy working directory')
  ensurePrivateDirectory(childHome, 'Navigator could not create the private CodeBuddy HOME directory')
  const directory = join(cwd, `cyrene-navigator-codebuddy-acp-${randomUUID()}`)
  const path = join(directory, 'mcp.json')
  let directoryCreated = false
  let fileCreated = false
  let descriptor: number | undefined
  try {
    mkdirSync(directory, { mode: 0o700 })
    directoryCreated = true
    chmodSync(directory, 0o700)
    assertPrivatePath(directory, 'directory', 0o700)
    descriptor = openSync(path, 'wx', 0o600)
    fileCreated = true
    writeFileSync(descriptor, encoded, { encoding: 'utf8' })
    closeSync(descriptor)
    descriptor = undefined
    chmodSync(path, 0o600)
    assertPrivatePath(path, 'file', 0o600)
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* Preserve only the fixed startup diagnostic. */ }
    }
    if (fileCreated) {
      try {
        assertPrivatePath(path, 'file', 0o600)
        unlinkSync(path)
      } catch { /* Never follow or remove a replacement path. */ }
    }
    if (directoryCreated) {
      try {
        assertPrivatePath(directory, 'directory', 0o700)
        rmdirSync(directory)
      } catch { /* Never recursively remove an unexpected directory. */ }
    }
    throw new Error('Navigator could not create a private CodeBuddy MCP configuration')
  }
  return {
    path,
    cwd,
    childHome,
    profileRoot,
    cleanup(): void {
      assertPrivatePath(path, 'file', 0o600)
      assertPrivatePath(directory, 'directory', 0o700)
      assertPrivatePath(cwd, 'directory', 0o700)
      unlinkSync(path)
      rmdirSync(directory)
    },
  }
}

/** Create or verify one same-owner directory without following a replaced path. */
function ensurePrivateDirectory(path: string, diagnostic: string): void {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
      throw new Error(diagnostic)
    }
  }
  try {
    assertPrivatePath(path, 'directory', 0o700)
  } catch {
    throw new Error(diagnostic)
  }
}

/** Reject symlinks, non-regular paths, wrong owners, and group/world access. */
function assertPrivatePath(path: string, kind: 'file' | 'directory', requiredOwnerMode: number): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || (kind === 'file' ? !info.isFile() : !info.isDirectory())
    || (info.mode & 0o077) !== 0 || (info.mode & requiredOwnerMode) !== requiredOwnerMode
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('The CodeBuddy MCP configuration path failed its private-file check')
  }
  if (resolve(realpathSync(path)) !== resolve(path)) {
    throw new Error('The CodeBuddy MCP configuration path resolved through a symlink')
  }
}

function objectResult(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error(`CodeBuddy ACP ${label} returned a non-object result`)
  return value
}

function safeAcpDiagnostic(error: unknown): string {
  const wire = nativeWireDiagnostic(error)
  if (wire !== undefined) return wire
  if (error instanceof NativeSubagentFailure) return error.diagnostic
  if (isAuthRequired(error)) return authUnavailableFailure().diagnostic
  return 'NATIVE_PROTOCOL_UNAVAILABLE: ACP turn failed; partial output retained, native details omitted.'
}

function safeAcpFailure(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return abortFailure(signal)
  if (error instanceof NativeSubagentFailure) {
    return new NativeSubagentFailure(error.diagnostic, error.diagnostic)
  }
  if (isAuthRequired(error)) return authUnavailableFailure()
  const diagnostic = safeAcpDiagnostic(error)
  if (error instanceof Error && error.message.includes('timed out')) {
    return new NativeSubagentFailure('NATIVE_TIMEOUT: CodeBuddy ACP request timed out.', 'NATIVE_TIMEOUT: CodeBuddy ACP request timed out.')
  }
  return new NativeSubagentFailure(diagnostic, diagnostic)
}

function abortFailure(signal: AbortSignal): Error {
  const reason = signal.reason
  const suffix = reason instanceof Error && /timed out/iu.test(reason.message) ? 'TASK_TIMEOUT' : 'TASK_ABORTED'
  return new NativeSubagentFailure(
    suffix === 'TASK_TIMEOUT' ? 'CodeBuddy ACP task timed out' : 'CodeBuddy ACP task was cancelled',
    `${suffix}: CodeBuddy ACP execution was stopped by Navigator.`,
  )
}

function migrationAwarePrompt(prompt: string): string {
  return [
    'Navigator created a new CodeBuddy ACP conversation for this Work session. No previous DSH conversation history was imported.',
    'Do not assume prior conversation context, repeat historical actions, or claim that an earlier operation was completed. Use only the current request and results returned by Navigator tools.',
    '',
    'Current user request:',
    prompt,
  ].join('\n')
}
