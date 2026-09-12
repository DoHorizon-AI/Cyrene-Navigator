// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator profile launcher                                │
// │ Role: Compose a Cyrene bundle using the unchanged upstream CLI.     │
// │ 模块职责：通过原有 CLI 启动独立 Navigator Profile，不替代 Agent Loop。│
// └─────────────────────────────────────────────────────────────────────┘
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  upstream: { type: 'string' },
  home: { type: 'string' },
  mode: { type: 'string', default: 'web' },
  'dump-config': { type: 'boolean', default: false },
} });
if (!['web', 'sdk'].includes(values.mode)) throw new Error('--mode must be web or sdk');
const upstream = resolve(values.upstream ?? join(repository, '.upstream/deepseek-harness'));
const home = resolve(values.home ?? join(repository, '.navigator'));
const lock = JSON.parse(readFileSync(join(repository, 'harness/upstream.lock.json'), 'utf8'));
const sourcePackage = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8'));
if (sourcePackage.version !== lock.version || sourcePackage.packageManager !== lock.packageManager) {
  throw new Error('Upstream package differs from the approved pin; run prepare-harness.mjs');
}
for (const name of ['CYRENE_EXCHANGE_URL', 'CYRENE_HARNESS_MODEL', 'CYRENE_PERSISTENCE_URL',
  'CYRENE_WORKSPACE_ID', 'CYRENE_NATIVE_HOST']) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}
const profileName = values.mode === 'web' ? 'cyrene-navigator' : 'cyrene-navigator-sdk';
const profile = join(home, 'profiles', profileName);
mkdirSync(profile, { recursive: true });
const bundleNames = ['@deepseek-ai/dsh-base', `@deepseek-ai/dsh-${values.mode}-app`, '@cyrene/navigator-harness'];
const manifest = {
  name: profileName, private: true, version: '0.1.0', type: 'module',
  dsh: { profile: { bundles: bundleNames, patchReload: 'startup' } },
  dependencies: {
    '@deepseek-ai/dsh-base': lock.version,
    [`@deepseek-ai/dsh-${values.mode}-app`]: lock.version,
    '@cyrene/navigator-harness': '0.1.0',
  },
};
const manifestPath = join(profile, 'package.json');
if (existsSync(manifestPath)) {
  const existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
    throw new Error(`Existing profile differs from the pinned composition: ${profileName}`);
  }
} else {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
for (const [name, target] of [
  ['@deepseek-ai/dsh-base', join(upstream, 'packages/bundle/base')],
  [`@deepseek-ai/dsh-${values.mode}-app`, join(upstream, `packages/bundle/${values.mode}-app`)],
  ['@cyrene/navigator-harness', join(repository, 'harness')],
]) {
  const destination = join(profile, 'node_modules', name);
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    if (realpathSync(destination) !== realpathSync(target)) throw new Error(`Conflicting bundle: ${name}`);
  } else {
    symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
  }
}
const args = [join(upstream, 'apps/cli/lib/bin.js'), '--profile', profileName];
if (values['dump-config']) args.push('--dump-config');
else if (values.mode === 'web') args.push('--port', '0', '--no-open');
args.push(...positionals);
const child = spawn(process.execPath, args, {
  cwd: process.cwd(), stdio: 'inherit',
  env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_MAX_TOKENS_AS_SUCCESS: 'false',
    CYRENE_NAVIGATOR_PRESETS: join(repository, 'harness/presets') },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(`Navigator runtime failed to start: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
