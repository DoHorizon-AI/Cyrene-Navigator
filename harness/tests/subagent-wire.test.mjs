// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Native subagent wire diagnostics tests                      │
// │ Role: Verify bounded NDJSON parsing and payload-safe failures.       │
// │ 模块职责：验证有界 NDJSON 解析与安全诊断。                              │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { setImmediate as defer } from 'node:timers/promises';
import { test } from 'node:test';
import {
  MAX_NATIVE_FRAME_BYTES,
  MAX_NATIVE_STREAM_BYTES,
  MAX_NATIVE_STREAM_FRAMES,
  NativeWireFailure,
  nativeWireDiagnostic,
  pumpJsonLines,
} from '../dist/subagents/wire.js';

async function pump(stream, signal = new AbortController().signal) {
  const frames = [];
  const failure = new Promise(resolve => {
    pumpJsonLines(stream, signal, frame => frames.push(frame), resolve);
  });
  return { frames, failure: await failure };
}

test('pumpJsonLines preserves fragmented UTF-8 and strips CRLF delimiters', async () => {
  const payload = Buffer.from('{"text":"snowman ☃"}\r\n', 'utf8');
  const symbolStart = payload.indexOf(Buffer.from('☃', 'utf8'));
  const stream = Readable.from([
    payload.subarray(0, symbolStart + 1),
    payload.subarray(symbolStart + 1, symbolStart + 2),
    payload.subarray(symbolStart + 2),
  ]);

  const result = await pump(stream);

  assert.deepEqual(result.frames, [{ text: 'snowman ☃' }]);
  assert.ok(result.failure instanceof NativeWireFailure);
  assert.equal(result.failure.code, 'NATIVE_PREMATURE_EOF');
  assert.equal(result.failure.bytesObserved, payload.byteLength);
  assert.equal(result.failure.framesObserved, 1);
});

test('malformed secret-bearing frames expose a fixed diagnostic only', async () => {
  const secret = 'private-token-89f2';
  const payload = Buffer.from(`{"token":"${secret}" broken}\n`, 'utf8');
  const result = await pump(Readable.from([payload]));
  const diagnostic = nativeWireDiagnostic(result.failure);

  assert.ok(result.failure instanceof NativeWireFailure);
  assert.equal(result.failure.code, 'NATIVE_INVALID_JSON');
  assert.equal(result.failure.bytesObserved, payload.byteLength);
  assert.equal(result.failure.framesObserved, 1);
  assert.equal(diagnostic, 'NATIVE_INVALID_JSON: Native protocol frame is not valid JSON');
  assert.equal(result.failure.message, 'Native protocol frame is not valid JSON');
  assert.equal(diagnostic.includes(secret), false);
  assert.equal(nativeWireDiagnostic(new Error(secret)), undefined);
});

test('invalid UTF-8 and non-object JSON receive distinct stable codes', async t => {
  await t.test('invalid UTF-8', async () => {
    const payload = Buffer.from([0xff, 0x0a]);
    const result = await pump(Readable.from([payload]));

    assert.equal(result.failure.code, 'NATIVE_INVALID_UTF8');
    assert.equal(result.failure.bytesObserved, payload.byteLength);
    assert.equal(result.failure.framesObserved, 1);
  });

  await t.test('non-object JSON', async () => {
    const payload = Buffer.from('[1,2]\n');
    const result = await pump(Readable.from([payload]));

    assert.equal(result.failure.code, 'NATIVE_INVALID_OBJECT');
    assert.equal(result.failure.bytesObserved, payload.byteLength);
    assert.equal(result.failure.framesObserved, 1);
  });
});

test('a stream over 16 MiB reports cumulative counts without retaining payload', async () => {
  const frame = Buffer.from(`${JSON.stringify({ padding: 'x'.repeat(220) })}\n`, 'utf8');
  const frameCount = Math.ceil((MAX_NATIVE_STREAM_BYTES + 1) / frame.byteLength);
  const payload = Buffer.alloc(frame.byteLength * frameCount);
  for (let offset = 0; offset < payload.byteLength; offset += frame.byteLength) {
    frame.copy(payload, offset);
  }

  async function* chunks() {
    const chunkBytes = 64 * 1024;
    for (let offset = 0; offset < payload.byteLength; offset += chunkBytes) {
      yield payload.subarray(offset, Math.min(offset + chunkBytes, payload.byteLength));
    }
  }

  const result = await pump(Readable.from(chunks()));
  const diagnostic = nativeWireDiagnostic(result.failure);

  assert.equal(result.failure.code, 'NATIVE_STREAM_LIMIT');
  assert.ok(result.failure.bytesObserved > MAX_NATIVE_STREAM_BYTES);
  assert.ok(result.failure.framesObserved > 0);
  assert.ok(result.failure.framesObserved < frameCount);
  assert.match(diagnostic, new RegExp(`observed ${result.failure.bytesObserved} bytes across ${result.failure.framesObserved} frames`));
  assert.equal(Object.values(result.failure).some(value => Buffer.isBuffer(value)), false);
});

test('a single frame over 1 MiB reports the frame limit with safe counts', async () => {
  const payload = Buffer.alloc(MAX_NATIVE_FRAME_BYTES + 1, 0x61);
  const result = await pump(Readable.from([payload]));
  const diagnostic = nativeWireDiagnostic(result.failure);

  assert.equal(result.failure.code, 'NATIVE_FRAME_LIMIT');
  assert.equal(result.failure.bytesObserved, payload.byteLength);
  assert.equal(result.failure.framesObserved, 0);
  assert.match(diagnostic, /observed 1048577 bytes across 0 frames/);
});

test('the configured stream frame-count limit remains enforced', async () => {
  const payload = Buffer.from('{}\n'.repeat(MAX_NATIVE_STREAM_FRAMES + 1), 'utf8');
  const result = await pump(Readable.from([payload]));

  assert.equal(result.failure.code, 'NATIVE_FRAME_COUNT_LIMIT');
  assert.equal(result.failure.bytesObserved, payload.byteLength);
  assert.equal(result.failure.framesObserved, MAX_NATIVE_STREAM_FRAMES + 1);
  assert.equal(result.frames.length, MAX_NATIVE_STREAM_FRAMES);
});

test('clean EOF and EOF during a frame have separate failure codes', async t => {
  await t.test('empty frame', async () => {
    const payload = Buffer.from('\r\n', 'utf8');
    const result = await pump(Readable.from([payload]));

    assert.equal(result.failure.code, 'NATIVE_EMPTY_FRAME');
    assert.equal(result.failure.bytesObserved, payload.byteLength);
    assert.equal(result.failure.framesObserved, 1);
  });

  await t.test('clean EOF', async () => {
    const result = await pump(Readable.from([]));

    assert.equal(result.failure.code, 'NATIVE_PREMATURE_EOF');
    assert.equal(result.failure.bytesObserved, 0);
    assert.equal(result.failure.framesObserved, 0);
  });

  await t.test('incomplete frame', async () => {
    const payload = Buffer.from('{"complete":true}', 'utf8');
    const result = await pump(Readable.from([payload]));

    assert.equal(result.failure.code, 'NATIVE_INCOMPLETE_FRAME');
    assert.equal(result.failure.bytesObserved, payload.byteLength);
    assert.equal(result.failure.framesObserved, 0);
  });
});

test('aborting from a frame callback suppresses subsequent frames and EOF failure', async () => {
  const controller = new AbortController();
  const source = Readable.from([Buffer.from('{}\n{}\n')]);
  const frames = [];
  const failures = [];
  pumpJsonLines(source, controller.signal, frame => {
    frames.push(frame);
    controller.abort();
  }, error => failures.push(error));

  await defer();

  assert.deepEqual(frames, [{}]);
  assert.deepEqual(failures, []);
});

test('callback failures are sanitized and a failing failure callback does not reject the pump task', async () => {
  const secret = 'callback-secret-11';
  const result = await new Promise(resolve => {
    pumpJsonLines(
      Readable.from([Buffer.from('{}\n')]),
      new AbortController().signal,
      () => { throw new Error(secret); },
      resolve,
    );
  });

  assert.equal(result.code, 'NATIVE_CALLBACK_FAILED');
  assert.equal(nativeWireDiagnostic(result), 'NATIVE_CALLBACK_FAILED: Native protocol frame callback failed');
  assert.equal(nativeWireDiagnostic(result).includes(secret), false);

  let unhandledRejection;
  const onUnhandledRejection = error => { unhandledRejection = error; };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    await new Promise(resolve => {
      pumpJsonLines(
        Readable.from([Buffer.from('not-json\n')]),
        new AbortController().signal,
        () => {},
        () => {
          resolve();
          throw new Error(secret);
        },
      );
    });
    await defer();
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
  assert.equal(unhandledRejection, undefined);
});

test('reader errors are replaced with the fixed unknown-reader diagnostic', async () => {
  const secret = 'reader-token-1a';
  const source = new Readable({ read() {} });
  const pending = pump(source);
  source.destroy(new Error(secret));
  const result = await pending;

  assert.equal(result.failure.code, 'NATIVE_UNKNOWN_READER_ERROR');
  assert.equal(nativeWireDiagnostic(result.failure), 'NATIVE_UNKNOWN_READER_ERROR: Native protocol reader failed');
  assert.equal(nativeWireDiagnostic(result.failure).includes(secret), false);
});
