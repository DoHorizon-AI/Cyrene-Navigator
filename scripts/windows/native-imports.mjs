// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Windows native runtime dependency check                     │
// │ Role: Reject MSVC redistributable imports before packaging.         │
// │ 模块职责：打包前拒绝依赖开发机器 MSVC runtime 的 Rust 可执行文件。     │
// └─────────────────────────────────────────────────────────────────────┘

import { readFile, stat } from 'node:fs/promises';

const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const REDISTRIBUTABLE_DLL = /^(?:vcruntime|msvcp|msvcr|concrt)\d[\w]*\.dll$/iu;

/**
 * Inspect the x64 PE import directory without executing the supplied binary.
 * Only the PE32+ layout used by the Navigator native host is accepted.
 * Delay imports fail closed rather than silently escaping the dependency check.
 * 只读取 Navigator 原生宿主使用的 PE32+ 导入表；不支持的延迟导入明确失败。
 * @see https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
 */
export function inspectWindowsNativeImports(bytes, label = 'Windows native tool') {
  const invalid = detail => { throw new Error(`${label}: invalid native PE image (${detail})`); };
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BINARY_BYTES) invalid('binary size');
  const range = (offset, size) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) {
      invalid('truncated or unmapped data');
    }
  };
  const u16 = offset => { range(offset, 2); return bytes.readUInt16LE(offset); };
  const u32 = offset => { range(offset, 4); return bytes.readUInt32LE(offset); };
  if (u16(0) !== 0x5a4d) invalid('DOS signature');
  const pe = u32(0x3c);
  if (pe < 64 || u32(pe) !== 0x00004550) invalid('PE signature');
  if (u16(pe + 4) !== 0x8664) invalid('x64 is required');
  const sectionCount = u16(pe + 6);
  const optionalSize = u16(pe + 20);
  const optional = pe + 24;
  range(optional, optionalSize);
  if (sectionCount === 0 || sectionCount > 96 || optionalSize < 128
      || u16(optional) !== 0x20b) invalid('PE32+ headers');
  const directoryCount = u32(optional + 108);
  if (directoryCount < 2 || directoryCount > 16
      || optionalSize < 112 + directoryCount * 8) invalid('data directories');
  const headersSize = u32(optional + 60);
  range(0, headersSize);
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const section = optional + optionalSize + index * 40;
    range(section, 40);
    sections.push({ rva: u32(section + 12), size: u32(section + 16), offset: u32(section + 20) });
  }
  const atRva = (rva, size) => {
    if (rva < headersSize && rva + size <= headersSize) { range(rva, size); return rva; }
    const section = sections.find(item => rva >= item.rva && rva + size <= item.rva + item.size);
    if (section === undefined) invalid('import RVA');
    const offset = section.offset + rva - section.rva;
    range(offset, size);
    return offset;
  };
  const directory = index => ({ rva: u32(optional + 112 + index * 8), size: u32(optional + 116 + index * 8) });
  if (directoryCount > 13) {
    const delayed = directory(13);
    if (delayed.rva !== 0 || delayed.size !== 0) invalid('delay imports are unsupported for packaged native tools');
  }
  const imports = directory(1);
  if (imports.rva === 0 && imports.size === 0) return [];
  if (imports.rva === 0 || imports.size < 20 || imports.size > 4096 * 20) invalid('import directory size');
  const names = new Set();
  for (let offset = 0; offset + 20 <= imports.size; offset += 20) {
    const descriptor = atRva(imports.rva + offset, 20);
    if (bytes.subarray(descriptor, descriptor + 20).every(value => value === 0)) {
      const result = [...names].sort();
      const unsupported = result.filter(name => REDISTRIBUTABLE_DLL.test(name));
      if (unsupported.length > 0) {
        throw new Error(`${label} imports ${unsupported.join(', ')}; rebuild the Windows Rust tool with -C target-feature=+crt-static before packaging`);
      }
      return result;
    }
    const nameRva = u32(descriptor + 12);
    if (nameRva === 0) invalid('missing DLL name');
    let name = '';
    let terminated = false;
    for (let index = 0; index < 260; index += 1) {
      const byte = bytes[atRva(nameRva + index, 1)];
      if (byte === 0) { terminated = true; break; }
      if (byte < 0x20 || byte > 0x7e) invalid('DLL name encoding');
      name += String.fromCharCode(byte);
    }
    if (!terminated || !/^[a-z\d_.-]+\.dll$/iu.test(name)) invalid('DLL name');
    names.add(name);
  }
  invalid('unterminated import directory');
}

/** Read a bounded build artifact and verify its Windows runtime dependencies. */
export async function assertWindowsNativeImports(path, label) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_BINARY_BYTES) {
    throw new Error(`${label}: native executable must be a file no larger than 128 MiB`);
  }
  return inspectWindowsNativeImports(await readFile(path), label);
}
