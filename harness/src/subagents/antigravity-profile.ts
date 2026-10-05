// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Antigravity native sandbox profile                          │
// │ Role: Validate the official host profile before native child start. │
// │ 模块职责：在启动原生子进程前校验官方主机沙箱配置。                    │
// └─────────────────────────────────────────────────────────────────────┘

import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { NativeSubagentFailure } from './common.js'

/** Relative location of the documented native settings file below the active user home. */
export const ANTIGRAVITY_PROFILE_RELATIVE_PATH = join('.gemini', 'antigravity-cli', 'settings.json')

/** The only settings file that runtime preflight is allowed to inspect. */
export const ANTIGRAVITY_OFFICIAL_PROFILE_PATH = getAntigravityOfficialProfilePath()

const MAX_PROFILE_BYTES = 256 * 1024
const REQUIRED_DENIALS = ['unsandboxed(*)', 'mcp(*)'] as const
const SAFE_PROFILE_UNAVAILABLE_MESSAGE = '无法执行 Antigravity 子 Agent'
const SAFE_PROFILE_UNAVAILABLE_DIAGNOSTIC = 'Antigravity 安全配置不可用或不符合要求。请继续使用其他 Agent 或主流程处理当前任务。'
const SUPPORTED_NATIVE_SANDBOX_PLATFORMS = new Set<NodeJS.Platform>(['linux', 'darwin', 'win32'])

/** Resolve dynamically so isolated test homes are honored after module initialization. */
export function getAntigravityOfficialProfilePath(): string {
  return join(homedir(), ANTIGRAVITY_PROFILE_RELATIVE_PATH)
}

/** Stable error shape lets the provider report a safe, fixed diagnostic without settings data. */
export class AntigravitySandboxProfileFailure extends NativeSubagentFailure {
  readonly code = 'SANDBOX_PROFILE_UNAVAILABLE' as const

  constructor() {
    super(SAFE_PROFILE_UNAVAILABLE_MESSAGE, SAFE_PROFILE_UNAVAILABLE_DIAGNOSTIC)
    this.name = 'NativeSubagentFailure'
  }
}

/**
 * Check the documented security fields and reject a workspace that can edit its own policy.
 * `profilePath` and `platform` are injectable only for fixture validation; runtime uses the
 * official path and current platform through `assertAntigravitySandboxProfile`.
 */
export function validateAntigravitySandboxProfile(
  value: unknown,
  cwd: string,
  profilePath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!SUPPORTED_NATIVE_SANDBOX_PLATFORMS.has(platform) || !isAbsolute(cwd) || !isAbsolute(profilePath)) {
    throw new AntigravitySandboxProfileFailure()
  }
  const workspacePath = resolve(cwd)
  const settingsPath = resolve(profilePath)
  if (workspacePath === parse(workspacePath).root || containsPath(workspacePath, settingsPath)) {
    throw new AntigravitySandboxProfileFailure()
  }
  if (!isRecord(value)) throw new AntigravitySandboxProfileFailure()

  const permissions = value.permissions
  if (!isRecord(permissions)) throw new AntigravitySandboxProfileFailure()
  const denyList = permissions.deny
  if (!isStringArray(denyList)) throw new AntigravitySandboxProfileFailure()
  if (value.enableTerminalSandbox !== true
    || value.toolPermission !== 'proceed-in-sandbox'
    // The CLI omits this setting after shutdown; the documented default is false.
    || (value.allowNonWorkspaceAccess !== false && value.allowNonWorkspaceAccess !== undefined)
    || value.artifactReviewPolicy !== 'always-proceed'
    || value.agentMode !== 'accept-edits'
    || !isEmptyOrAbsentArray(permissions.allow)
    || !isEmptyOrAbsentArray(permissions.ask)
    || !REQUIRED_DENIALS.every(rule => denyList.includes(rule))) {
    throw new AntigravitySandboxProfileFailure()
  }
}

/** Read and validate the official host profile before starting an Antigravity child. */
export async function assertAntigravitySandboxProfile(cwd: string): Promise<void> {
  try {
    const platform = process.platform
    if (!SUPPORTED_NATIVE_SANDBOX_PLATFORMS.has(platform)) throw new AntigravitySandboxProfileFailure()
    const workspacePath = await realpath(cwd)
    const profilePath = getAntigravityOfficialProfilePath()
    await rejectSymlinkPath(profilePath)
    validateAntigravitySandboxProfile(await readProfile(profilePath), workspacePath, profilePath, platform)
  } catch {
    // Do not expose file contents, path-specific errors, or parser details to callers.
    throw new AntigravitySandboxProfileFailure()
  }
}

/** Read a bounded regular file without following a final-component symlink. */
async function readProfile(path: string): Promise<unknown> {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_PROFILE_BYTES) throw new Error('unavailable')
    const contents = await handle.readFile('utf8')
    if (Buffer.byteLength(contents, 'utf8') > MAX_PROFILE_BYTES) throw new Error('unavailable')
    return JSON.parse(contents) as unknown
  } finally {
    await handle.close()
  }
}

/** Reject symlinks in the official settings path, including its parent directories. */
async function rejectSymlinkPath(path: string): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const parts = absolute.slice(root.length).split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new Error('unavailable')
  }
}

/** Whether `parent` equals or contains `candidate` after lexical normalization. */
function containsPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEmptyArray(value: unknown): value is [] {
  return Array.isArray(value) && value.length === 0
}

function isEmptyOrAbsentArray(value: unknown): boolean {
  return value === undefined || isEmptyArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

/** Resolve a settings parent for callers that need to create the official profile directory. */
export function antigravityOfficialProfileDirectory(): string {
  return dirname(ANTIGRAVITY_OFFICIAL_PROFILE_PATH)
}
