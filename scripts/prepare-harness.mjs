// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Harness bootstrap                                │
// │ Role: Verify and build the exact upstream without source patches.   │
// │ 模块职责：校验固定上游并构建，保持上游源码不变。                        │
// └─────────────────────────────────────────────────────────────────────┘
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(repository, 'harness/upstream.lock.json'), 'utf8'));
const { values } = parseArgs({ options: {
  root: { type: 'string' },
  install: { type: 'boolean', default: false },
  build: { type: 'boolean', default: false },
  link: { type: 'boolean', default: false },
} });
const upstream = resolve(values.root ?? join(repository, '.upstream/deepseek-harness'));
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/** Run an explicit argv; never interpret paths or arguments through a shell. */
function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ''}`);
  return result.stdout?.trim() ?? '';
}

if (!existsSync(upstream)) {
  mkdirSync(dirname(upstream), { recursive: true });
  run('git', ['clone', '--depth', '1', '--branch', lock.tag, lock.repository, upstream], repository);
}
const commit = run('git', ['rev-parse', 'HEAD'], upstream, true);
if (commit !== lock.commit) throw new Error(`Upstream commit mismatch: ${commit}`);
const tagCommit = run('git', ['rev-parse', `${lock.tag}^{commit}`], upstream, true);
if (tagCommit !== lock.commit) throw new Error(`Upstream tag mismatch: ${tagCommit}`);
const sourceChanges = run('git', ['diff', 'HEAD', '--name-only'], upstream, true);
if (sourceChanges) throw new Error(`Upstream source differs from the pin:\n${sourceChanges}`);
const untrackedSources = run('git', ['ls-files', '--others', '--exclude-standard'], upstream, true);
if (untrackedSources) throw new Error(`Untracked upstream source files:\n${untrackedSources}`);
for (const [path, expected] of Object.entries(lock.sha256)) {
  const actual = createHash('sha256').update(readFileSync(join(upstream, path))).digest('hex');
  if (actual !== expected) throw new Error(`Upstream ${path} digest mismatch`);
}
const manifest = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8'));
if (manifest.version !== lock.version || manifest.packageManager !== lock.packageManager) {
  throw new Error('Upstream version or package manager differs from the lock');
}
if (values.install) run(pnpmCommand, ['install', '--frozen-lockfile'], upstream);
if (values.build) run(pnpmCommand, ['run', 'build:official'], upstream);

/** Bind build-time imports to the same upstream package instances used by dsh. */
function linkPackage(name, target) {
  const destination = join(repository, 'harness/node_modules', name);
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    if (realpathSync(destination) !== realpathSync(target)) throw new Error(`Conflicting dependency: ${name}`);
    return;
  }
  symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
}
if (values.link) {
  const roots = [];
  for (const group of readdirSync(join(upstream, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const entry of readdirSync(join(upstream, 'packages', group.name), { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(upstream, 'packages', group.name, entry.name));
    }
  }
  for (const group of ['vendor', 'apps']) {
    for (const entry of readdirSync(join(upstream, group), { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(upstream, group, entry.name));
    }
  }
  for (const path of roots) {
    const packagePath = join(path, 'package.json');
    if (!existsSync(packagePath)) continue;
    const dependency = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (dependency.name) linkPackage(dependency.name, path);
  }
  linkPackage('@types/node', join(upstream, 'node_modules/@types/node'));
}
console.log(JSON.stringify({ commit, tag: lock.tag, packageManager: manifest.packageManager, corePatches: 0, upstream }));
