// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 antigravity-acp-execution.ts                                    │
// │  Module: harness/antigravity-acp-execution                          │
// │  Role: Bind Google's official ACP runtime to Navigator Work tasks.  │
// │                                                                      │
// │  模块职责：使用官方 Antigravity ACP 和隔离 profile 执行持久 Work Task。│
// └─────────────────────────────────────────────────────────────────────┘

import {
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { AcpConversationExecutionBackend, objectResult, withRunDeadline } from './acp-conversation-execution.js'
import type {
  AcpConversationExecutionProfile,
  PreparedAcpConversation,
  RecordAcpPermissionDiagnostic,
} from './acp-conversation-execution.js'
import type { AcpMcpBridge, AcpMcpServerStdio } from './acp-mcp-host.js'
import { getAcpToolCatalog } from './tool-providers.js'
import { AcpStdioClient } from './subagents/acp.js'
import { DEFAULT_DISPOSE_GRACE_MS, DEFAULT_STARTUP_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS, NativeSubagentFailure } from './subagents/common.js'
import { isJsonObject, optionalString } from './subagents/wire.js'
import type { WorkStateStore } from './work-state-client.js'

const PROFILE_MODE = 0o700
const __dirname = dirname(fileURLToPath(import.meta.url))
const MCP_SERVER_ENTRYPOINT = join(__dirname, 'acp-mcp-stdio.js')

interface SafeAntigravityPermissionDiagnostic {
  readonly type: 'execution.acp_permission_request';
  readonly diagnosticVersion: 1;
  readonly backend: 'antigravity-acp';
  readonly method: 'session/request_permission';
  readonly kind: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch'
    | 'switch_mode' | 'other' | 'unknown' | 'missing';
  readonly serverName: 'navigator' | 'other' | 'missing';
  readonly toolName: 'catalog_match' | 'unknown' | 'missing';
  readonly identitySource: 'antigravity_mcp_metadata' | 'none';
  readonly catalogAvailable: boolean;
  readonly optionKinds: { readonly allow_once: boolean; readonly reject_once: boolean; readonly otherCount: number };
  readonly decision: 'allow_once' | 'reject_once' | 'cancelled';
}

/** Exact launch, profile, and model selectors for one Antigravity ACP service. */
export interface AntigravityAcpExecutionOptions {
  readonly ctx: Context;
  readonly workState: WorkStateStore;
  readonly model?: string;
  readonly command?: string;
  readonly profileRoot?: string;
  /** Test-only prefix for a local fake ACP process; production never sets arguments. */
  readonly commandArgsPrefix?: readonly string[];
  /** Test-only sidecar override; production uses the bundled task-local stdio bridge. */
  readonly mcpServerEntrypoint?: string;
  readonly startupTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly disposeGraceMs?: number;
  readonly mcpCloseGraceMs?: number;
}

/** Google-native configuration options, permission identity, and isolated process profile. */
class AntigravityAcpProfile implements AcpConversationExecutionProfile {
  readonly backend = 'antigravity-acp' as const
  readonly displayName = 'Antigravity'
  private readonly command: string
  private readonly commandArgsPrefix: readonly string[]
  private readonly profileRoot: string
  private readonly model: string | undefined
  private readonly mcpServerEntrypoint: string
  private readonly expectedModels = new Map<string, string>()

  constructor(private readonly options: AntigravityAcpExecutionOptions) {
    this.command = validateAntigravityAcpCommand(
      options.command ?? process.env.CYRENE_HARNESS_ANTIGRAVITY_ACP_COMMAND,
      options.commandArgsPrefix !== undefined,
    )
    this.commandArgsPrefix = options.commandArgsPrefix ?? []
    this.profileRoot = validateAntigravityAcpProfile(options.profileRoot ?? process.env.CYRENE_HARNESS_ANTIGRAVITY_ACP_PROFILE)
    this.model = validateConfiguredModel(options.model ?? process.env.CYRENE_HARNESS_ANTIGRAVITY_ACP_MODEL)
    this.mcpServerEntrypoint = resolve(options.mcpServerEntrypoint ?? MCP_SERVER_ENTRYPOINT)
  }

  /** Start the official binary directly and pass only the task-local Navigator stdio MCP bridge. */
  prepare(bridge: AcpMcpBridge): PreparedAcpConversation {
    preparePrivateAntigravityProfile(this.profileRoot)
    assertNoGlobalMcpConfiguration(this.profileRoot)
    const cwd = join(this.profileRoot, 'navigator-acp-workspace')
    ensurePrivateDirectory(cwd)
    const server: AcpMcpServerStdio = {
      name: 'navigator',
      command: process.execPath,
      args: [this.mcpServerEntrypoint],
      env: [
        { name: 'NAVIGATOR_ACP_BRIDGE_URL', value: bridge.url },
        { name: 'NAVIGATOR_ACP_BRIDGE_TOKEN', value: bridge.token },
      ],
    }
    return {
      cwd,
      argv: [
        this.command,
        ...(this.options.commandArgsPrefix === undefined
          ? process.platform === 'linux' ? ['--uid='] : []
          : this.commandArgsPrefix),
      ],
      env: isolatedAntigravityEnvironment(this.profileRoot),
      sessionParameters: {
        cwd,
        mcpServers: [server],
        // Official 1.2.1+ filter: MCP tools remain available while native built-ins are disabled.
        _meta: { antigravity: { enabledTools: [] } },
      },
    }
  }

  /** Require exact native provider identity and a version with the built-in tool filter. */
  validateInitialize(result: Record<string, unknown>): void {
    const info = isJsonObject(result.agentInfo) ? result.agentInfo : {}
    if (info.name !== 'antigravity-acp') {
      throw new NativeSubagentFailure(
        "The configured process is not Google's Antigravity ACP server",
        'NATIVE_PROVIDER_IDENTITY_INVALID: ACP agentInfo did not identify antigravity-acp.',
      )
    }
    if (typeof info.version !== 'string' || !supportsToolFilter(info.version)) {
      throw new NativeSubagentFailure(
        'The configured Antigravity ACP version does not support native-tool filtering',
        'NATIVE_ANTIGRAVITY_VERSION_UNSUPPORTED: Official Antigravity ACP 1.2.1 or newer is required.',
      )
    }
  }

  /** Set an exact advertised model and verify the server's returned model inventory. */
  async configureSession(input: {
    readonly peer: AcpStdioClient;
    readonly signal: AbortController;
    readonly timeoutMs: number;
    readonly sessionId: string;
    readonly setupResult: Record<string, unknown>;
    readonly resumed: boolean;
  }): Promise<void> {
    const currentOptions = requireModelOptions(input.setupResult)
    const targetModel = this.model ?? currentOptions.currentValue
    if (!currentOptions.values.includes(targetModel)) {
      throw new NativeSubagentFailure(
        'The configured Antigravity model is not advertised by this native session',
        'NATIVE_MODEL_UNAVAILABLE: Configured Antigravity model ID is absent from the native session options.',
      )
    }
    let finalOptions = currentOptions
    if (currentOptions.currentValue !== targetModel) {
      const value = await withRunDeadline(input.peer.request('session/set_config_option', {
        sessionId: input.sessionId,
        configId: currentOptions.configId,
        value: targetModel,
      }), input.signal, input.timeoutMs, 'Antigravity ACP model selection', this)
      finalOptions = requireModelOptions(objectResult(value, 'model selection', this.displayName))
    }
    if (finalOptions.currentValue !== targetModel || !finalOptions.values.includes(targetModel)) {
      throw new NativeSubagentFailure(
        'Antigravity ACP did not confirm the requested model',
        'NATIVE_MODEL_READBACK_MISMATCH: Antigravity ACP did not read back the exact requested native model ID.',
      )
    }
    this.expectedModels.set(input.sessionId, targetModel)
  }

  /** Trust only Google's structured MCP metadata and the current exact tool catalog. */
  async answerPermission(
    params: Record<string, unknown>,
    recordDiagnostic: RecordAcpPermissionDiagnostic,
  ): Promise<Record<string, unknown>> {
    const toolCall = isJsonObject(params.toolCall) ? params.toolCall : {}
    const kindValue = optionalString(toolCall.kind)
    const metadata = isJsonObject(toolCall._meta) ? toolCall._meta : {}
    const mcpIdentity = isJsonObject(metadata.mcp) ? metadata.mcp : {}
    const mcpCandidate = metadata.is_mcp_tool_call === true || isJsonObject(metadata.mcp)
    const nativeMcp = metadata.is_mcp_tool_call === true
      && kindValue === 'other'
      && mcpIdentity.server === 'navigator'
      && typeof mcpIdentity.tool === 'string'
    let catalogAvailable = true
    let knownTools = new Set<string>()
    try {
      knownTools = new Set(getAcpToolCatalog(this.options.ctx).map(tool => tool.name))
    } catch {
      catalogAvailable = false
    }
    const toolName = typeof mcpIdentity.tool !== 'string'
      ? 'missing' as const
      : knownTools.has(mcpIdentity.tool) ? 'catalog_match' as const : 'unknown' as const
    const serverName = mcpIdentity.server === undefined
      ? 'missing' as const
      : mcpIdentity.server === 'navigator' ? 'navigator' as const : 'other' as const
    const trusted = nativeMcp && catalogAvailable && toolName === 'catalog_match'
    const options = Array.isArray(params.options) ? params.options.filter(isJsonObject) : []
    const allowOnce = options.find(option => option.kind === 'allow_once' && typeof option.optionId === 'string')
    const rejectOnce = options.find(option => option.kind === 'reject_once' && typeof option.optionId === 'string')
    const selection = trusted ? allowOnce : rejectOnce
    const decision = selection === undefined
      ? 'cancelled'
      : trusted ? 'allow_once' : 'reject_once'
    const event: SafeAntigravityPermissionDiagnostic = {
      type: 'execution.acp_permission_request',
      diagnosticVersion: 1,
      backend: this.backend,
      method: 'session/request_permission',
      kind: classifyPermissionKind(kindValue),
      serverName,
      toolName,
      identitySource: nativeMcp ? 'antigravity_mcp_metadata' : 'none',
      catalogAvailable,
      optionKinds: {
        allow_once: allowOnce !== undefined,
        reject_once: rejectOnce !== undefined,
        otherCount: options.filter(option => option.kind !== 'allow_once' && option.kind !== 'reject_once').length,
      },
      decision,
    }
    recordDiagnostic({ ...event }, mcpCandidate)
    if (selection !== undefined) return { outcome: { outcome: 'selected', optionId: selection.optionId } }
    return { outcome: { outcome: 'cancelled' } }
  }

  /** Treat any provider-reported in-session model change as an explicit failure. */
  onNotification(method: string, params: unknown, fail: (error: Error) => void): void {
    if (method !== 'session/update' || !isJsonObject(params) || !isJsonObject(params.update)
      || params.update.sessionUpdate !== 'config_option_update') return
    const sessionId = optionalString(params.sessionId)
    if (sessionId === undefined) return
    const expected = this.expectedModels.get(sessionId)
    if (expected === undefined) return
    try {
      const current = requireModelOptions({ configOptions: params.update.configOptions })
      if (current.currentValue !== expected) {
        fail(new NativeSubagentFailure(
          'Antigravity ACP changed the selected model during the session',
          'NATIVE_MODEL_CHANGED: Antigravity ACP reported a model change during the requested turn.',
        ))
      }
    } catch (error: unknown) {
      fail(error instanceof Error ? error : new Error('Native Antigravity model readback failed'))
    }
  }

  finishRun(sessionId: string): void {
    this.expectedModels.delete(sessionId)
  }

  authRequiredFailure(): NativeSubagentFailure {
    return new NativeSubagentFailure(
      'Antigravity ACP requires native sign-in in its isolated profile',
      'NATIVE_AUTH_REQUIRED: Antigravity ACP is not signed in through its isolated profile; Navigator did not start a login flow or proxy credentials.',
    )
  }
}

/** Explicit selectable backend for Google's official Antigravity ACP binary. */
export class AntigravityAcpExecutionBackend extends AcpConversationExecutionBackend {
  declare readonly name: 'antigravity-acp'

  constructor(options: AntigravityAcpExecutionOptions) {
    super({
      ctx: options.ctx,
      workState: options.workState,
      profile: new AntigravityAcpProfile(options),
      ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
      ...(options.disposeGraceMs === undefined ? {} : { disposeGraceMs: options.disposeGraceMs }),
      ...(options.mcpCloseGraceMs === undefined ? {} : { mcpCloseGraceMs: options.mcpCloseGraceMs }),
    })
  }
}

/** Validate and bound the native model selector without applying an external alias map. */
export function validateAntigravityAcpModel(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  if (Buffer.byteLength(value, 'utf8') > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('CYRENE_HARNESS_ANTIGRAVITY_ACP_MODEL must be a native model ID without control characters')
  }
  return value
}

interface ModelConfiguration {
  readonly configId: string;
  readonly currentValue: string;
  readonly values: readonly string[];
}

/** Resolve one model selector from native configOptions, accepting grouped or flat choices. */
function requireModelOptions(setup: Record<string, unknown>): ModelConfiguration {
  if (!Array.isArray(setup.configOptions)) {
    throw new NativeSubagentFailure(
      'Antigravity ACP omitted its native model options',
      'NATIVE_MODEL_OPTIONS_UNAVAILABLE: Antigravity ACP did not advertise session configOptions.',
    )
  }
  const options = setup.configOptions.filter(isJsonObject)
  const byCategory = options.filter(option => option.category === 'model')
  const byId = options.filter(option => option.id === 'model')
  const selected = byCategory.length === 1 ? byCategory[0]
    : byCategory.length === 0 && byId.length === 1 ? byId[0]
      : undefined
  if (selected === undefined || selected.type !== 'select' || typeof selected.id !== 'string'
    || typeof selected.currentValue !== 'string' || !Array.isArray(selected.options)) {
    throw new NativeSubagentFailure(
      'Antigravity ACP model configOptions are missing or ambiguous',
      'NATIVE_MODEL_OPTIONS_INVALID: Antigravity ACP did not expose one valid native model selector.',
    )
  }
  const values: string[] = []
  for (const item of selected.options) {
    if (!isJsonObject(item)) continue
    if (typeof item.value === 'string') values.push(item.value)
    if (Array.isArray(item.options)) {
      for (const grouped of item.options) {
        if (isJsonObject(grouped) && typeof grouped.value === 'string') values.push(grouped.value)
      }
    }
  }
  if (values.length === 0 || new Set(values).size !== values.length || !values.includes(selected.currentValue)) {
    throw new NativeSubagentFailure(
      'Antigravity ACP returned an invalid current model value',
      'NATIVE_MODEL_OPTIONS_INVALID: The native model selector current value is not among its advertised model IDs.',
    )
  }
  return { configId: selected.id, currentValue: selected.currentValue, values }
}

/** Accept only canonical semver and require the documented built-in filter release. */
function supportsToolFilter(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version)
  if (match === null) return false
  const [, majorText, minorText, patchText] = match
  const major = Number(majorText)
  const minor = Number(minorText)
  const patch = Number(patchText)
  return major > 1 || major === 1 && (minor > 2 || minor === 2 && patch >= 1)
}

export function validateAntigravityAcpCommand(value: string | undefined, allowTestExecutable = false): string {
  if (value === undefined || value.length === 0 || !isAbsolute(value)
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('CYRENE_HARNESS_ANTIGRAVITY_ACP_COMMAND must be an absolute official ACP executable path')
  }
  if (!allowTestExecutable) {
    const companionName = process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external'
    const companion = join(dirname(value), companionName)
    try {
      for (const path of [value, companion]) {
        const info = lstatSync(path)
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0 || (info.mode & 0o022) !== 0) {
          throw new Error('invalid official Antigravity bundle file')
        }
      }
    } catch {
      throw new TypeError('The official Antigravity ACP server and localharness_external companion must be installed together as immutable executables')
    }
  }
  return value
}

export function validateAntigravityAcpProfile(value: string | undefined): string {
  if (value === undefined || value.length === 0 || !isAbsolute(value)
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('CYRENE_HARNESS_ANTIGRAVITY_ACP_PROFILE must be an absolute private persistent profile path')
  }
  return resolve(value)
}

function validateConfiguredModel(value: string | undefined): string | undefined {
  return validateAntigravityAcpModel(value)
}

/** Create profile/XDG directories without chmod or following a symlinked path. */
function preparePrivateAntigravityProfile(profileRoot: string): void {
  try {
    assertNoSymlinkAncestors(dirname(profileRoot))
    ensurePrivateDirectory(profileRoot)
    assertPrivatePathChain(profileRoot)
    assertPrivatePath(profileRoot)
    for (const path of [
      join(profileRoot, '.config'),
      join(profileRoot, '.cache'),
      join(profileRoot, '.local'),
      join(profileRoot, '.local', 'share'),
      join(profileRoot, '.local', 'state'),
    ]) ensureProfileChildDirectory(path, profileRoot)
  } catch {
    throw new NativeSubagentFailure(
      'Antigravity profile is not a private owner-owned directory',
      'NATIVE_ANTIGRAVITY_PROFILE_NOT_PRIVATE: ACP profile must be a persistent owner-only directory owned by this Navigator process.',
    )
  }
}

/** Keep session-provided Navigator MCP as the only server in the isolated profile. */
function assertNoGlobalMcpConfiguration(profileRoot: string): void {
  const configuredPath = join(profileRoot, '.gemini', 'config', 'mcp_config.json')
  try {
    assertNoSymlinkAncestors(configuredPath)
    lstatSync(configuredPath)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw new NativeSubagentFailure(
      'Antigravity profile cannot be checked for global MCP servers',
      'NATIVE_ANTIGRAVITY_PROFILE_MCP_CONFIG_UNSAFE: Navigator could not verify the isolated profile MCP configuration.',
    )
  }
  throw new NativeSubagentFailure(
    'Antigravity profile contains a global MCP configuration',
    'NATIVE_ANTIGRAVITY_PROFILE_MCP_CONFIG_PRESENT: The isolated ACP profile must not load global MCP servers.',
  )
}

/** Reject symlinks in an existing config path without reading its contents. */
function assertNoSymlinkAncestors(path: string): void {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error('Antigravity MCP config path contains a symlink')
  }
}

function ensurePrivateDirectory(path: string): void {
  try { mkdirSync(path, { mode: PROFILE_MODE }) } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
  }
  assertPrivatePathChain(path)
  assertPrivatePath(path)
}

/** Keep XDG state inside the private root without rewriting existing profile permissions. */
function ensureProfileChildDirectory(path: string, profileRoot: string): void {
  try { mkdirSync(path, { mode: PROFILE_MODE }) } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
  }
  assertPrivatePathChain(path)
  assertProfileChildPath(path, profileRoot)
}

/** Reject symlinks throughout the private profile path. */
function assertPrivatePathChain(path: string): void {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error('Antigravity profile path contains a symlink')
  }
}

/** Verify the private directory mode and owner without taking over unsafe state. */
function assertPrivatePath(path: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0
    || (info.mode & PROFILE_MODE) !== PROFILE_MODE
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || resolve(realpathSync(path)) !== resolve(path)) {
    throw new Error('Antigravity profile directory failed its private mode and owner check')
  }
}

/** The private profile root protects nested owner-owned directories from other users. */
function assertProfileChildPath(path: string, profileRoot: string): void {
  const absolutePath = resolve(path)
  const absoluteRoot = resolve(profileRoot)
  const childPath = relative(absoluteRoot, absolutePath)
  if (childPath === '' || childPath === '..' || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
    throw new Error('Antigravity profile state escaped its private root')
  }
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || resolve(realpathSync(path)) !== absolutePath) {
    throw new Error('Antigravity profile state directory failed its owner and path check')
  }
}

/** Inherit only process-launch, proxy, locale, and TLS settings; auth remains in the native profile. */
export function isolatedAntigravityEnvironment(profileRoot: string): NodeJS.ProcessEnv {
  const allowedNames = new Set([
    'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE',
  ])
  const env: NodeJS.ProcessEnv = {}
  for (const name of Object.keys(process.env)) env[name] = undefined
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (allowedNames.has(name) || /^LC_[A-Z0-9_]+$/u.test(name))) env[name] = value
  }
  env.HOME = profileRoot
  env.USERPROFILE = profileRoot
  env.APPDATA = join(profileRoot, 'AppData', 'Roaming')
  env.LOCALAPPDATA = join(profileRoot, 'AppData', 'Local')
  env.XDG_CONFIG_HOME = join(profileRoot, '.config')
  env.XDG_CACHE_HOME = join(profileRoot, '.cache')
  env.XDG_DATA_HOME = join(profileRoot, '.local', 'share')
  env.XDG_STATE_HOME = join(profileRoot, '.local', 'state')
  return env
}

function classifyPermissionKind(value: string | undefined): SafeAntigravityPermissionDiagnostic['kind'] {
  if (value === undefined) return 'missing'
  const known = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'])
  return known.has(value) ? value as SafeAntigravityPermissionDiagnostic['kind'] : 'unknown'
}
