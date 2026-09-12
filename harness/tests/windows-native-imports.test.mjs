// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Native Windows package dependency regression tests          │
// │ Role: Validate PE imports independently of the build host's DLLs.    │
// │ 模块职责：独立于构建机器已安装 DLL，验证 Windows native 导入检查。   │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectWindowsNativeImports } from '../../scripts/windows/native-imports.mjs';

// A minimal PE32+ image with a real section RVA/file-offset mapping. The
// ordinary string table can also contain DLL names that are not imports.
// 最小 PE32+ fixture 保留真实 RVA 映射，区分普通字符串和实际 DLL 导入。
function executable(names) {
  const bytes = Buffer.alloc(4096);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(240, 0x94);
  const optional = 0x98;
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(512, optional + 60);
  bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(0x1000, optional + 120);
  bytes.writeUInt32LE((names.length + 1) * 20, optional + 124);
  const section = optional + 240;
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(3584, section + 16);
  bytes.writeUInt32LE(512, section + 20);
  names.forEach((name, index) => {
    const nameOffset = 1024 + index * 128;
    bytes.writeUInt32LE(0x1000 + nameOffset - 512, 512 + index * 20 + 12);
    bytes.write(`${name}\0`, nameOffset, 'ascii');
  });
  return bytes;
}

test('accepts Windows OS imports and ignores non-import DLL strings', () => {
  const binary = executable(['KERNEL32.dll', 'api-ms-win-crt-runtime-l1-1-0.dll']);
  binary.write('VCRUNTIME140.dll\0', 3500, 'ascii');
  assert.deepEqual(inspectWindowsNativeImports(binary), ['KERNEL32.dll', 'api-ms-win-crt-runtime-l1-1-0.dll']);
});

test('rejects MSVC redistributable imports regardless of the host installation', () => {
  for (const name of ['VCRUNTIME140.dll', 'vcruntime140_1.dll', 'MSVCP140_ATOMIC_WAIT.dll', 'MSVCR120.dll', 'CONCRT140.dll']) {
    assert.throws(() => inspectWindowsNativeImports(executable(['KERNEL32.dll', name]), 'cyrene-native-host'), /cyrene-native-host imports .*crt-static/u);
  }
});

test('rejects truncated headers, a wrong architecture and invalid RVAs', () => {
  assert.throws(() => inspectWindowsNativeImports(Buffer.alloc(5)), /invalid native PE/u);
  const wrongArchitecture = executable(['KERNEL32.dll']);
  wrongArchitecture.writeUInt16LE(0x14c, 0x84);
  assert.throws(() => inspectWindowsNativeImports(wrongArchitecture), /x64 is required/u);
  const missingName = executable(['KERNEL32.dll']);
  missingName.writeUInt32LE(0xfffffff0, 524);
  assert.throws(() => inspectWindowsNativeImports(missingName), /import RVA/u);
});

test('requires a terminated import directory and a bounded DLL name', () => {
  const unterminated = executable(['KERNEL32.dll']);
  unterminated.writeUInt32LE(20, 0x98 + 124);
  assert.throws(() => inspectWindowsNativeImports(unterminated), /unterminated import directory/u);
  const missingTerminator = executable(['KERNEL32.dll']);
  missingTerminator.fill(0x61, 1024, 1024 + 260);
  assert.throws(() => inspectWindowsNativeImports(missingTerminator), /DLL name/u);
});

test('fails closed on delay imports instead of overlooking deferred DLL loads', () => {
  const delayed = executable(['KERNEL32.dll']);
  delayed.writeUInt32LE(0x1200, 0x98 + 112 + 13 * 8);
  delayed.writeUInt32LE(64, 0x98 + 116 + 13 * 8);
  assert.throws(() => inspectWindowsNativeImports(delayed), /delay imports are unsupported/u);
});
