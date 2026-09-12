// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Harness browser bundle                            │
// │ Role: Wrap the compiled Cyrene client face in the DSH Loader ABI.    │
// │ 模块职责：将编译后的 Cyrene 客户端封装成 DSH Loader ABI。              │
// └─────────────────────────────────────────────────────────────────────┘

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptDirectory, '../..');
const packageName = '@cyrene/navigator-harness';

function usage() {
  return `Usage: node scripts/windows/build-harness-client.mjs [options]

  --root <path>   Navigator repository root (default: repository root)
  --help          print this help
`;
}

function options() {
  const parsed = parseArgs({
    allowPositionals: false,
    options: {
      root: { type: 'string', default: repository },
      help: { type: 'boolean', default: false },
    },
  });
  if (parsed.values.help) {
    console.log(usage());
    process.exit(0);
  }
  return resolve(parsed.values.root);
}

/**
 * Remove the harmless TypeScript module marker before inserting the source in
 * the CJS factory.  The client source deliberately has no ESM exports, but
 * NodeNext emits this marker for a file containing `module.exports`.
 */
function withoutEsmMarker(source) {
  const cleaned = source.replace(/\nexport \{\};?\s*$/u, '\n');
  if (/\bexport\s+(?:default\s+)?/u.test(cleaned)) {
    throw new Error('Navigator client source contains an ESM export and cannot enter the Loader factory');
  }
  return cleaned;
}

/** Build one self-registering browser artifact for the DSH client module table. */
export async function buildHarnessClient(root) {
  const sourcePath = join(root, 'harness/dist/client/delivery-feedback.js');
  const outputPath = join(root, 'harness/dist/client.js');
  const source = withoutEsmMarker(await readFile(sourcePath, 'utf8'));
  const output = [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => {`,
    'var module = { exports: {} }; var exports = module.exports;',
    source,
    'return module.exports; } });',
    '',
  ].join('\n');
  await writeFile(outputPath, output, 'utf8');
  return outputPath;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildHarnessClient(options());
}
