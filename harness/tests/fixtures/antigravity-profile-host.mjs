// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Isolated native-profile test host                           │
// │ Role: Prepare a private official-layout profile without host auth. │
// │ 模块职责：准备隔离的官方路径配置，不访问宿主认证信息。               │
// └─────────────────────────────────────────────────────────────────────┘

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ANTIGRAVITY_PROFILE_RELATIVE_PATH, buildSafeAntigravityProfile } from '../../../scripts/configure-antigravity-sandbox.mjs';

const hosts = new WeakMap();

/** Each test owns one private CLI home, shared by its native peers. */
export async function installNativeProfileFixture(t) {
  if (hosts.has(t)) return hosts.get(t);
  const directory = await mkdtemp(join(tmpdir(), 'navigator-native-profile-'));
  const settingsPath = join(directory, ANTIGRAVITY_PROFILE_RELATIVE_PATH);
  const prior = Object.fromEntries(['HOME', 'USERPROFILE'].map(name => [name, process.env[name]]));
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(buildSafeAntigravityProfile({})), { mode: 0o600 });
  // These variables retain their native HOME semantics; no credentials are copied.
  process.env.HOME = directory;
  if (process.platform === 'win32') process.env.USERPROFILE = directory;
  t.after(async () => {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const host = { directory, settingsPath };
  hosts.set(t, host);
  return host;
}
