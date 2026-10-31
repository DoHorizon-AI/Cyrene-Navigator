// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 codebuddy-acp-execution.ts                                       │
// │  Module: harness/codebuddy-acp-execution                             │
// │  Role: Bind CodeBuddy's native profile to shared ACP task mechanics.  │
// │                                                                      │
// │  模块职责：将 CodeBuddy 专属配置接入共享 ACP Work Task 生命周期。    │
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
import { AcpConversationExecutionBackend } from './acp-conversation-execution.js'
import type {
  AcpConversationExecutionProfile,
  PreparedAcpConversation,
  RecordAcpPermissionDiagnostic,
} from './acp-conversation-execution.js'
import { getCodeBuddyAcpToolCatalog } from './tool-providers.js'
import type { AcpMcpBridge, AcpMcpServerStdio } from './acp-mcp-host.js'
import { NativeSubagentFailure } from './subagents/common.js'
import { isJsonObject, optionalString } from './subagents/wire.js'
import type { WorkStateStore } from './work-state-client.js'

export type {
  ConversationExecutionBackend,
  ConversationExecutionInput,
  ConversationExecutionResult,
} from './acp-conversation-execution.js'

const CODEBUDDY_MODELS = new Set(['glm-5.3-flash', 'deepseek-v4.1-flash'])
const CODEBUDDY_MCP_TOOL_PREFIX = 'mcp__navigator__'
const ACP_TOOL_KINDS = new Set([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
])
const CODEBUDDY_SETTINGS = JSON.stringify({
  disableAllHooks: true,
  enabledPlugins: {},
  deferToolLoading: false,
})
const __dirname = dirname(fileURLToPath(import.meta.url))
const MCP_SERVER_ENTRYPOINT = join(__dirname, 'acp-mcp-stdio.js')

interface AcpMcpEnvironmentVariable {
  readonly name: string;
  readonly value: string;
}

interface SafeAcpPermissionDiagnostic {
  readonly type: 'execution.acp_permission_request';
  readonly diagnosticVersion: 1;
  readonly method: 'session/request_permission';
  readonly kind: SafeAcpPermissionKind;
  readonly serverName: 'navigator' | 'other' | 'missing';
  readonly toolName: 'catalog_match' | 'unknown' | 'missing';
  readonly identitySource: PermissionIdentitySource;
  readonly catalogAvailable: boolean;
  readonly optionKinds: {
    readonly allow_once: boolean;
    readonly reject_once: boolean;
    readonly otherCount: number;
  };
  readonly decision: 'allow_once' | 'reject_once' | 'cancelled';
}

type SafeAcpPermissionKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other'
  | 'legacy_mcp' | 'unknown' | 'missing'
type PermissionIdentitySource = 'codebuddy_metadata' | 'legacy_mcp_raw_input' | 'none'

interface PermissionToolIdentity {
  readonly serverName: 'navigator' | 'other' | 'missing';
  readonly toolName: 'catalog_match' | 'unknown' | 'missing';
  readonly trusted: boolean;
}

/** CodeBuddy owns process flags and its task-local MCP configuration file. */
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

interface PrivateConfigFile {
  readonly path: string;
  readonly cwd: string;
  readonly childHome: string;
  readonly profileRoot: string;
  cleanup(): void;
}

/** Provider-specific CodeBuddy setup and permission identity rules. */
class CodeBuddyAcpProfile implements AcpConversationExecutionProfile {
  readonly backend = 'codebuddy-acp' as const
  readonly displayName = 'CodeBuddy'
  readonly migrationPrompt = migrationAwarePrompt
  private readonly command: string
  private readonly commandArgsPrefix: readonly string[]
  private readonly model: string
  private readonly mcpServerEntrypoint: string

  constructor(private readonly options: CodeBuddyAcpExecutionOptions) {
    this.command = options.command ?? 'codebuddy'
    this.commandArgsPrefix = options.commandArgsPrefix ?? []
    this.model = validateCodeBuddyModel(options.model)
    this.mcpServerEntrypoint = resolve(options.mcpServerEntrypoint ?? MCP_SERVER_ENTRYPOINT)
  }

  /** Prepare the isolated CLI profile and stdio MCP configuration for this run. */
  prepare(bridge: AcpMcpBridge): PreparedAcpConversation {
    const mcpServer: AcpMcpServerStdio = {
      name: 'navigator',
      command: process.execPath,
      args: [this.mcpServerEntrypoint],
      env: [
        { name: 'NAVIGATOR_ACP_BRIDGE_URL', value: bridge.url },
        { name: 'NAVIGATOR_ACP_BRIDGE_TOKEN', value: bridge.token },
      ],
    }
    const environment = Object.fromEntries(mcpServer.env.map(({ name, value }) => [name, value]))
    const configFile = createPrivateMcpConfigFile({
      mcpServers: {
        navigator: {
          type: 'stdio',
          command: mcpServer.command,
          args: [...mcpServer.args],
          alwaysLoad: true,
          defer_loading: false,
          env: environment,
        },
      },
    })
    const args = [
      ...this.commandArgsPrefix,
      '--acp', '--acp-transport', 'stdio', '--agent', 'cli', '--permission-mode', 'default',
      '--tools', '', '--strict-mcp-config', '--mcp-config', configFile.path,
      '--setting-sources', 'project,local',
      '--settings', CODEBUDDY_SETTINGS,
      '--model', this.model,
    ]
    return {
      cwd: configFile.cwd,
      argv: [this.command, ...args],
      env: isolatedCodeBuddyEnvironment(configFile.childHome, configFile.profileRoot),
      sessionParameters: { cwd: configFile.cwd, mcpServers: [mcpServer] },
      cleanup: () => configFile.cleanup(),
    }
  }

  /** Deny every untrusted request and permit only a catalog-matched Navigator MCP tool once. */
  async answerPermission(
    params: Record<string, unknown>,
    recordDiagnostic: RecordAcpPermissionDiagnostic,
  ): Promise<Record<string, unknown>> {
    const toolCall = isJsonObject(params.toolCall) ? params.toolCall : {}
    const kindValue = optionalString(toolCall.kind)
    const kind = classifyAcpPermissionKind(kindValue)
    const rawInput = isJsonObject(toolCall.rawInput) ? toolCall.rawInput : {}
    const metadata = isJsonObject(toolCall._meta) ? toolCall._meta : {}
    const codeBuddyToolName = metadata['codebuddy.ai/toolName']
    const hasCodeBuddyToolName = Object.prototype.hasOwnProperty.call(metadata, 'codebuddy.ai/toolName')
    let knownTools = new Set<string>()
    let catalogAvailable = true
    try {
      knownTools = new Set(getCodeBuddyAcpToolCatalog(this.options.ctx).map(tool => tool.name))
    } catch {
      catalogAvailable = false
    }
    const nativeIdentity = codeBuddyMcpToolIdentity(codeBuddyToolName, knownTools)
    const legacyIdentity = hasCodeBuddyToolName
      ? { serverName: 'missing' as const, toolName: 'missing' as const, trusted: false }
      : legacyMcpToolIdentity(kindValue, rawInput, knownTools)
    const identity = nativeIdentity.trusted
      ? { ...nativeIdentity, identitySource: 'codebuddy_metadata' as const }
      : legacyIdentity.trusted
        ? { ...legacyIdentity, identitySource: 'legacy_mcp_raw_input' as const }
        : {
          serverName: hasCodeBuddyToolName ? nativeIdentity.serverName : legacyIdentity.serverName,
          toolName: hasCodeBuddyToolName ? nativeIdentity.toolName : legacyIdentity.toolName,
          trusted: false,
          identitySource: hasCodeBuddyToolName
            ? 'codebuddy_metadata' as const
            : kindValue === 'mcp' ? 'legacy_mcp_raw_input' as const : 'none' as const,
        }
    const options = Array.isArray(params.options) ? params.options.filter(isJsonObject) : []
    const allowOnce = options.find(option => option.kind === 'allow_once' && typeof option.optionId === 'string')
    const rejectOnce = options.find(option => option.kind === 'reject_once' && typeof option.optionId === 'string')
    const selection = identity.trusted ? allowOnce ?? rejectOnce : rejectOnce
    const decision = selection === undefined
      ? 'cancelled'
      : identity.trusted && selection === allowOnce ? 'allow_once' : 'reject_once'
    const event: SafeAcpPermissionDiagnostic = {
      type: 'execution.acp_permission_request',
      diagnosticVersion: 1,
      method: 'session/request_permission',
      kind,
      serverName: identity.serverName,
      toolName: identity.toolName,
      identitySource: identity.identitySource,
      catalogAvailable,
      optionKinds: {
        allow_once: allowOnce !== undefined,
        reject_once: rejectOnce !== undefined,
        otherCount: options.filter(option => option.kind !== 'allow_once' && option.kind !== 'reject_once').length,
      },
      decision,
    }
    recordDiagnostic({ ...event }, hasCodeBuddyToolName
      && typeof codeBuddyToolName === 'string' && codeBuddyToolName.startsWith('mcp__'))
    if (selection !== undefined) return { outcome: { outcome: 'selected', optionId: selection.optionId } }
    return { outcome: { outcome: 'cancelled' } }
  }
}

/** CodeBuddy remains the existing named ACP choice; its behavior stays provider-specific. */
export class CodeBuddyAcpExecutionBackend extends AcpConversationExecutionBackend {
  declare readonly name: 'codebuddy-acp'

  constructor(options: CodeBuddyAcpExecutionOptions) {
    super({
      ctx: options.ctx,
      workState: options.workState,
      profile: new CodeBuddyAcpProfile(options),
      ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
      ...(options.disposeGraceMs === undefined ? {} : { disposeGraceMs: options.disposeGraceMs }),
      ...(options.mcpCloseGraceMs === undefined ? {} : { mcpCloseGraceMs: options.mcpCloseGraceMs }),
    })
  }
}

/** Keep ACP tool-kind diagnostics inside the fixed v1 vocabulary. */
function classifyAcpPermissionKind(value: string | undefined): SafeAcpPermissionKind {
  if (value === undefined) return 'missing'
  if (value === 'mcp') return 'legacy_mcp'
  return ACP_TOOL_KINDS.has(value) ? value as SafeAcpPermissionKind : 'unknown'
}

/** Trust only CodeBuddy's provider-owned name when it resolves to the live catalog. */
function codeBuddyMcpToolIdentity(value: unknown, knownTools: ReadonlySet<string>): PermissionToolIdentity {
  if (typeof value !== 'string' || value.length === 0) {
    return { serverName: 'missing', toolName: 'missing', trusted: false }
  }
  if (value.startsWith(CODEBUDDY_MCP_TOOL_PREFIX)) {
    const requestedTool = value.slice(CODEBUDDY_MCP_TOOL_PREFIX.length)
    if (requestedTool.length === 0) return { serverName: 'navigator', toolName: 'missing', trusted: false }
    const catalogMatch = knownTools.has(requestedTool)
    return { serverName: 'navigator', toolName: catalogMatch ? 'catalog_match' : 'unknown', trusted: catalogMatch }
  }
  if (!value.startsWith('mcp__')) return { serverName: 'other', toolName: 'unknown', trusted: false }
  const separator = value.indexOf('__', 'mcp__'.length)
  if (separator < 0) return { serverName: 'other', toolName: 'unknown', trusted: false }
  const serverName = value.slice('mcp__'.length, separator) === 'navigator' ? 'navigator' : 'other'
  const requestedTool = value.slice(separator + 2)
  if (requestedTool.length === 0) return { serverName, toolName: 'missing', trusted: false }
  const catalogMatch = knownTools.has(requestedTool)
  return { serverName, toolName: catalogMatch ? 'catalog_match' : 'unknown', trusted: serverName === 'navigator' && catalogMatch }
}

/** Preserve the old custom ACP raw-input shape without treating it as native identity. */
function legacyMcpToolIdentity(
  kind: string | undefined,
  rawInput: Record<string, unknown>,
  knownTools: ReadonlySet<string>,
): PermissionToolIdentity {
  if (kind !== 'mcp') return { serverName: 'missing', toolName: 'missing', trusted: false }
  const serverValue = [rawInput.serverName, rawInput.server, rawInput.name]
    .find(value => typeof value === 'string') as string | undefined
  const toolValue = [rawInput.toolName, rawInput.tool]
    .find(value => typeof value === 'string') as string | undefined
  const serverName = serverValue === undefined ? 'missing' : serverValue === 'navigator' ? 'navigator' : 'other'
  const toolName = toolValue === undefined ? 'missing' : knownTools.has(toolValue) ? 'catalog_match' : 'unknown'
  return { serverName, toolName, trusted: serverName === 'navigator' && toolName === 'catalog_match' }
}

/** Choose an allowlisted CodeBuddy model; an empty deployment value uses GLM. */
export function validateCodeBuddyModel(value: string | undefined): string {
  const model = value === undefined || value === '' ? 'glm-5.3-flash' : value
  if (!CODEBUDDY_MODELS.has(model)) {
    throw new TypeError('CYRENE_HARNESS_CODEBUDDY_ACP_MODEL must be glm-5.3-flash or deepseek-v4.1-flash')
  }
  return model
}

/** Preserve only the CodeBuddy profile and basic runtime/network environment. */
export function isolatedCodeBuddyEnvironment(childHome?: string, profileRoot?: string): NodeJS.ProcessEnv {
  const allowedNames = new Set([
    'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'CODEBUDDY_CONFIG_DIR',
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

/** Write the bridge capability below CodeBuddy's stable private CWD, never to CLI argv. */
function createPrivateMcpConfigFile(value: Record<string, unknown>): PrivateConfigFile {
  const encoded = JSON.stringify(value)
  const configuredHome = process.env.CODEBUDDY_CONFIG_DIR
    ?? process.env.CODEBUDDY_HOME
    ?? join(process.env.HOME ?? homedir(), '.codebuddy')
  if (!isAbsolute(configuredHome)) throw new Error('Navigator CodeBuddy configuration path must be absolute')
  const configuredRoot = resolve(configuredHome)
  try {
    mkdirSync(configuredRoot, { mode: 0o700, recursive: true })
    assertPrivatePath(configuredRoot, 'directory', 0o700)
  } catch {
    throw privateCodeBuddyProfileFailure()
  }
  let profileRoot: string
  try {
    profileRoot = resolve(realpathSync(configuredRoot))
    assertPrivatePath(profileRoot, 'directory', 0o700)
  } catch {
    throw privateCodeBuddyProfileFailure()
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
      try { assertPrivatePath(path, 'file', 0o600); unlinkSync(path) } catch { /* Do not follow a replaced path. */ }
    }
    if (directoryCreated) {
      try { assertPrivatePath(directory, 'directory', 0o700); rmdirSync(directory) } catch { /* Do not remove a replacement. */ }
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

/** Build CodeBuddy's stdio MCP descriptor from the current task capability. */
function migrationAwarePrompt(prompt: string): string {
  return [
    'Navigator created a new CodeBuddy ACP conversation for this Work session. No previous DSH conversation history was imported.',
    'Do not assume prior conversation context, repeat historical actions, or claim that an earlier operation was completed. Use only the current request and results returned by Navigator tools.',
    '',
    'Current user request:',
    prompt,
  ].join('\n')
}

function ensurePrivateDirectory(path: string, diagnostic: string): void {
  try { mkdirSync(path, { mode: 0o700 }) } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw new Error(diagnostic)
  }
  try { assertPrivatePath(path, 'directory', 0o700) } catch { throw new Error(diagnostic) }
}

function privateCodeBuddyProfileFailure(): NativeSubagentFailure {
  return new NativeSubagentFailure(
    'CodeBuddy profile is not a private owner-owned directory',
    'NATIVE_CODEBUDDY_PROFILE_NOT_PRIVATE: CodeBuddy profile must resolve to an owner-only directory owned by this Navigator process.',
  )
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
