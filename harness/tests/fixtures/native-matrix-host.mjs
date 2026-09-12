#!/usr/bin/env node
// ┌─────────────────────────────────────────────────────────────────────┐
// │ Fixture: Navigator native bridge fault matrix                      │
// │ Role: Exercise stdio supervision with controlled failure modes.    │
// │ 固件职责：用可控故障模式验证 Navigator stdio 监督边界。              │
// └─────────────────────────────────────────────────────────────────────┘
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const configuration = JSON.parse(readFileSync(join(process.cwd(), '.cyrene-native-fixture.json'), 'utf8'));
const mode = configuration.mode;
const statePath = configuration.statePath;
const diagnosticSecret = 'native-matrix-test-secret';

function state(status, extra = {}) {
  writeFileSync(statePath, JSON.stringify({ status, pid: process.pid, ...extra }));
}

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function finish(code = 0) {
  state('exited', { code });
  process.exit(code);
}

process.once('SIGTERM', () => finish(143));
process.once('SIGINT', () => finish(130));
state('started', { mode });

if (mode === 'oversized-stdout') {
  process.stdout.write('x'.repeat(128 * 1024));
  setInterval(() => {}, 60_000);
}
if (mode === 'stdout-log') {
  process.stdout.write(`diagnostic:${diagnosticSecret}\n`);
  setInterval(() => {}, 60_000);
}
if (mode === 'stderr-cap') {
  process.stderr.write(diagnosticSecret + 'x'.repeat(64 * 1024));
}

let activeRequestId;
let requestSeen = false;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  if (line.length === 0) continue;
  const frame = JSON.parse(line);
  if (frame.method === 'hello') {
    if (mode === 'version-mismatch') {
      send({ version: 2, id: frame.id, result: { protocol_version: 2 } });
      continue;
    }
    if (mode === 'handshake-mismatch') {
      send({ version: 1, id: frame.id, result: { protocol_version: 2 } });
      continue;
    }
    send({ version: 1, id: frame.id, result: { protocol_version: 1 } });
    state('handshake');
    if (mode === 'crash' || mode === 'eof') {
      setImmediate(() => finish(mode === 'crash' ? 17 : 0));
    }
    continue;
  }

  if (frame.method === 'fixture_operation') {
    requestSeen = true;
    activeRequestId = frame.id;
    state('active', { request_id: frame.id });
    if (mode === 'active-cancel' || mode === 'active-timeout') {
      send({
        version: 1,
        event: 'request_started',
        request_id: frame.id,
        data: { pid: process.pid },
      });
      continue;
    }
    send({
      version: 1,
      id: frame.id,
      result: {
        ok: true,
        request_id: frame.id,
        secret_env_present: process.env.CYRENE_NATIVE_TEST_SECRET !== undefined,
        stderr_bytes_written: mode === 'stderr-cap' ? diagnosticSecret.length + 64 * 1024 : 0,
      },
    });
    state('result');
    continue;
  }

  if (frame.method === 'cancel') {
    const target = frame.params?.request_id;
    state('cancel-received', { request_id: target });
    send({ version: 1, id: frame.id, result: { accepted: target === activeRequestId } });
    if (target === activeRequestId && mode === 'active-cancel') {
      send({
        version: 1,
        id: activeRequestId,
        error: { code: 'cancelled', message: 'fixture observed cancel' },
      });
      finish(0);
    }
  }
}

if (!requestSeen || mode === 'stderr-cap') finish(0);
