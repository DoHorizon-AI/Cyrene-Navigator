// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Antigravity sandbox profile fixtures                        │
// │ Role: Verify safe profile preparation and native preflight checks.   │
// │ 模块职责：验证沙箱配置准备和原生启动前校验。                            │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  AntigravitySandboxProfileFailure,
  validateAntigravitySandboxProfile,
} from '../dist/subagents/antigravity-profile.js'
import {
  buildSafeAntigravityProfile,
  configureAntigravityProfile,
} from '../../scripts/configure-antigravity-sandbox.mjs'

const safeProfile = Object.freeze({
  enableTerminalSandbox: true,
  toolPermission: 'proceed-in-sandbox',
  allowNonWorkspaceAccess: false,
  artifactReviewPolicy: 'always-proceed',
  agentMode: 'accept-edits',
  permissions: { allow: [], ask: [], deny: ['unsandboxed(*)', 'mcp(*)'] },
})

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-agy-profile-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function assertUnavailable(callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof AntigravitySandboxProfileFailure)
    assert.equal(error.code, 'SANDBOX_PROFILE_UNAVAILABLE')
    assert.equal(error.message, '无法执行 Antigravity 子 Agent')
    assert.match(error.diagnostic, /请继续使用其他 Agent 或主流程处理/u)
    return true
  })
}

test('preflight accepts exact safe profile on documented native platforms', async () => {
  await withTempDirectory(async directory => {
    const cwd = join(directory, 'workspace')
    const profilePath = join(directory, 'home', '.gemini', 'antigravity-cli', 'settings.json')
    await mkdir(cwd)
    for (const platform of ['linux', 'darwin', 'win32']) {
      validateAntigravitySandboxProfile(safeProfile, cwd, profilePath, platform)
    }
  })
})

test('preflight accepts the native CLI rewritten profile with documented safe defaults omitted', async () => {
  await withTempDirectory(async directory => {
    const cwd = join(directory, 'workspace')
    const profilePath = join(directory, 'home', '.gemini', 'antigravity-cli', 'settings.json')
    await mkdir(cwd)
    const rewrittenProfile = {
      enableTerminalSandbox: true,
      toolPermission: 'proceed-in-sandbox',
      artifactReviewPolicy: 'always-proceed',
      agentMode: 'accept-edits',
      permissions: { deny: ['unsandboxed(*)', 'mcp(*)'] },
    }
    validateAntigravitySandboxProfile(rewrittenProfile, cwd, profilePath, 'linux')
  })
})

test('preflight rejects unsafe fields, workspace policy access, roots, and unsupported platforms', async () => {
  await withTempDirectory(async directory => {
    const cwd = join(directory, 'workspace')
    const profilePath = join(directory, 'home', '.gemini', 'antigravity-cli', 'settings.json')
    await mkdir(cwd)
    const unsafeProfiles = [
      { ...safeProfile, enableTerminalSandbox: false },
      { ...safeProfile, toolPermission: 'always-proceed' },
      { ...safeProfile, allowNonWorkspaceAccess: true },
      { ...safeProfile, artifactReviewPolicy: 'request-review' },
      { ...safeProfile, agentMode: 'plan' },
      { ...safeProfile, permissions: { allow: ['*'], ask: [], deny: safeProfile.permissions.deny } },
      { ...safeProfile, permissions: { allow: [], ask: ['*'], deny: safeProfile.permissions.deny } },
      { ...safeProfile, permissions: { allow: null, ask: [], deny: safeProfile.permissions.deny } },
      { ...safeProfile, permissions: { allow: false, ask: [], deny: safeProfile.permissions.deny } },
      { ...safeProfile, permissions: { allow: [], ask: null, deny: safeProfile.permissions.deny } },
      { ...safeProfile, permissions: { allow: [], ask: 'none', deny: safeProfile.permissions.deny } },
      { ...safeProfile, permissions: { allow: [], ask: [], deny: ['unsandboxed(*)'] } },
      { ...safeProfile, allowNonWorkspaceAccess: null },
      { ...safeProfile, allowNonWorkspaceAccess: true },
      null,
    ]
    for (const candidate of unsafeProfiles) {
      assertUnavailable(() => validateAntigravitySandboxProfile(candidate, cwd, profilePath, 'linux'))
    }
    assertUnavailable(() => validateAntigravitySandboxProfile(safeProfile, '/', profilePath, 'linux'))
    assertUnavailable(() => validateAntigravitySandboxProfile(safeProfile, directory, profilePath, 'linux'))
    assertUnavailable(() => validateAntigravitySandboxProfile(safeProfile, cwd, profilePath, 'aix'))
  })
})

test('profile builder retains unrelated settings and clears all existing grants', () => {
  const existing = {
    model: { name: 'user-choice' },
    theme: 'dark',
    enableTerminalSandbox: false,
    permissions: { allow: ['*'], ask: ['write(*)'], deny: [] },
  }
  const next = buildSafeAntigravityProfile(existing)
  assert.deepEqual(next.model, existing.model)
  assert.equal(next.theme, 'dark')
  assert.deepEqual(next.permissions, { allow: [], ask: [], deny: ['unsandboxed(*)', 'mcp(*)'] })
  assert.equal(existing.permissions.allow[0], '*')
})

test('setup previews without edits, then atomically applies private backup and mode', async () => {
  await withTempDirectory(async directory => {
    const settingsPath = join(directory, 'home', '.gemini', 'antigravity-cli', 'settings.json')
    await mkdir(join(directory, 'home', '.gemini', 'antigravity-cli'), { recursive: true })
    const initial = Buffer.from(JSON.stringify({ theme: 'dark', permissions: { allow: ['*'], ask: [], deny: [] } }))
    await writeFile(settingsPath, initial, { mode: 0o600 })

    const preview = await configureAntigravityProfile({ settingsPath, fixturePath: true })
    assert.equal(preview.status, 'preview')
    assert.equal(preview.exists, true)
    assert.deepEqual(await readFile(settingsPath), initial)

    const applied = await configureAntigravityProfile({ settingsPath, fixturePath: true, apply: true })
    assert.equal(applied.status, 'applied')
    assert.equal(applied.backupCreated, true)
    const result = JSON.parse(await readFile(settingsPath, 'utf8'))
    assert.equal(result.theme, 'dark')
    assert.deepEqual(result.permissions, safeProfile.permissions)
    assert.equal(result.enableTerminalSandbox, true)
    const mode = (await lstat(settingsPath)).mode & 0o777
    if (process.platform !== 'win32') assert.equal(mode, 0o600)

    const files = await readdir(join(directory, 'home', '.gemini', 'antigravity-cli'))
    const backupName = files.find(name => name.startsWith('settings.json.backup-'))
    assert.ok(backupName)
    const backupPath = join(directory, 'home', '.gemini', 'antigravity-cli', backupName)
    assert.deepEqual(await readFile(backupPath), initial)
    if (process.platform !== 'win32') assert.equal((await lstat(backupPath)).mode & 0o777, 0o600)
  })
})

test('setup refuses symlink settings and alternate paths without fixture opt-in', async () => {
  await withTempDirectory(async directory => {
    const realPath = join(directory, 'real-settings.json')
    const linkPath = join(directory, 'linked-settings.json')
    await writeFile(realPath, '{}', { mode: 0o600 })
    await symlink(realPath, linkPath)
    await assert.rejects(configureAntigravityProfile({ settingsPath: join(directory, 'not-official.json'), apply: true }), /setup failed/u)
    await assert.rejects(configureAntigravityProfile({ settingsPath: linkPath, fixturePath: true, apply: true }), /setup failed/u)
  })
})
