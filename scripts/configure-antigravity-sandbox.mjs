#!/usr/bin/env node
// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Explicit Antigravity native profile setup                    │
// │ Role: Prepare sandbox defaults without exposing settings or auth.  │
// │ 模块职责：显式准备原生沙箱配置，不输出设置内容或访问认证文件。       │
// └─────────────────────────────────────────────────────────────────────┘

import { constants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ANTIGRAVITY_PROFILE_RELATIVE_PATH = join('.gemini', 'antigravity-cli', 'settings.json')
export const SECURITY_PROFILE_FIELDS = Object.freeze([
  'enableTerminalSandbox',
  'toolPermission',
  'allowNonWorkspaceAccess',
  'artifactReviewPolicy',
  'agentMode',
  'permissions',
])
const MAX_PROFILE_BYTES = 256 * 1024
const REQUIRED_DENIALS = Object.freeze(['unsandboxed(*)', 'mcp(*)'])
const SAFE_ERROR = 'Antigravity profile setup failed; inspect the profile path and retry.'

/** Build safe security fields while retaining unrelated user settings. */
export function buildSafeAntigravityProfile(existing) {
  const source = isRecord(existing) ? existing : {}
  return {
    ...source,
    enableTerminalSandbox: true,
    toolPermission: 'proceed-in-sandbox',
    allowNonWorkspaceAccess: false,
    artifactReviewPolicy: 'always-proceed',
    agentMode: 'accept-edits',
    // Replacing all old grants prevents stale wildcard and remembered approvals from surviving.
    permissions: { allow: [], ask: [], deny: [...REQUIRED_DENIALS] },
  }
}

/** Preview safe metadata by default; writes require `apply: true`. */
export async function configureAntigravityProfile({
  apply = false,
  settingsPath = join(homedir(), ANTIGRAVITY_PROFILE_RELATIVE_PATH),
  fixturePath = false,
} = {}) {
  const officialPath = join(homedir(), ANTIGRAVITY_PROFILE_RELATIVE_PATH)
  if (!isAbsolute(settingsPath) || (settingsPath !== officialPath && !fixturePath)) throw new Error(SAFE_ERROR)

  try {
    const prior = await readSettingsIfPresent(settingsPath)
    if (!apply) {
      return {
        status: 'preview',
        profile: fixturePath ? 'fixture' : 'official',
        exists: prior !== undefined,
        changes: SECURITY_PROFILE_FIELDS,
      }
    }

    const current = prior === undefined ? {} : JSON.parse(prior.toString('utf8'))
    if (!isRecord(current)) throw new Error(SAFE_ERROR)
    const next = buildSafeAntigravityProfile(current)
    const serialized = `${JSON.stringify(next, null, 2)}\n`
    const backupCreated = prior !== undefined
    await atomicWriteSettings(settingsPath, Buffer.from(serialized, 'utf8'), prior)
    return {
      status: 'applied',
      profile: fixturePath ? 'fixture' : 'official',
      backupCreated,
      changes: SECURITY_PROFILE_FIELDS,
    }
  } catch {
    throw new Error(SAFE_ERROR)
  }
}

/** Read existing settings safely, rejecting links, non-files, and oversized input. */
async function readSettingsIfPresent(settingsPath) {
  await rejectExistingSymlinkComponents(settingsPath)
  let handle
  try {
    handle = await open(settingsPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_PROFILE_BYTES) throw new Error(SAFE_ERROR)
    const content = await handle.readFile()
    if (content.byteLength > MAX_PROFILE_BYTES) throw new Error(SAFE_ERROR)
    // Validate JSON before either previewing or writing so malformed files are never replaced.
    JSON.parse(content.toString('utf8'))
    return content
  } finally {
    await handle.close()
  }
}

/** Replace via same-directory temporary file and retain a private backup of prior bytes. */
async function atomicWriteSettings(settingsPath, content, prior) {
  const directory = dirname(settingsPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await rejectExistingSymlinkComponents(settingsPath)
  const suffix = `${Date.now()}-${process.pid}-${randomToken()}`
  const temporaryPath = join(directory, `.antigravity-settings-${suffix}.tmp`)
  const backupPath = prior === undefined ? undefined : join(directory, `settings.json.backup-${suffix}`)
  try {
    if (backupPath !== undefined) {
      const backup = await open(backupPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      try {
        await backup.writeFile(prior)
        await backup.sync()
      } finally {
        await backup.close()
      }
    }
    const temporary = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      await temporary.writeFile(content)
      await temporary.sync()
    } finally {
      await temporary.close()
    }
    await rename(temporaryPath, settingsPath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    if (backupPath !== undefined) await rm(backupPath, { force: true }).catch(() => {})
    throw error
  }
}

/** Reject existing symlink path components while allowing not-yet-created directories. */
async function rejectExistingSymlinkComponents(path) {
  const absolute = resolveAbsolute(path)
  const root = parse(absolute).root
  const components = absolute.slice(root.length).split(sep).filter(Boolean)
  let current = root
  for (const component of components) {
    current = join(current, component)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new Error(SAFE_ERROR)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

function resolveAbsolute(path) {
  if (!isAbsolute(path)) throw new Error(SAFE_ERROR)
  return resolve(path)
}

function randomToken() {
  return randomBytes(12).toString('hex')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function main(argv) {
  let apply = false
  let fixturePath = false
  let settingsPath
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') apply = true
    else if (arg === '--testing-fixture') fixturePath = true
    else if (arg === '--settings-path' && fixturePath && argv[index + 1] !== undefined) {
      settingsPath = argv[index + 1]
      index += 1
    } else if (arg === '--help') {
      process.stdout.write('Preview: node scripts/configure-antigravity-sandbox.mjs\nApply: node scripts/configure-antigravity-sandbox.mjs --apply\n')
      return
    } else {
      throw new Error(SAFE_ERROR)
    }
  }
  const result = await configureAntigravityProfile({ apply, fixturePath, ...(settingsPath === undefined ? {} : { settingsPath }) })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write(`${SAFE_ERROR}\n`)
    process.exitCode = 1
  })
}
