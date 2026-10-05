// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Antigravity sandbox boundary tests                           │
// │ Role: Verify explicit denial detection, bounded stderr, and redaction│
// │ 模块职责：验证明确拒绝识别、有界 stderr 与敏感内容脱敏。               │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AntigravityBoundaryObserver, SANDBOX_BOUNDARY_DENIED } from '../dist/subagents/antigravity-boundary.js';

function capturedFailure(observer) {
  try {
    observer.assertAllowed();
  } catch (error) {
    return error;
  }
  assert.fail('expected the native boundary denial to reject completion');
}

test('structured native tool denial defeats a nominal SUCCESS result', () => {
  const observer = new AntigravityBoundaryObserver();
  observer.observeFrame({
    event: 'tool_info',
    tool_info: { error: { type: 'permission_denied', message: 'denied for /private/path token=secret' } },
  });
  observer.observeFrame({ event: 'result', result: { status: 'SUCCESS', response: 'done' } });

  const error = capturedFailure(observer);
  assert.equal(error.code, SANDBOX_BOUNDARY_DENIED);
  assert.equal(error.name, 'NativeSubagentFailure');
  assert.match(error.diagnostic, /无法执行/u);
  assert.equal(`${error.message} ${error.diagnostic}`.includes('/private/path'), false);
  assert.equal(`${error.message} ${error.diagnostic}`.includes('secret'), false);
  assert.deepEqual(observer.getBlockedReceipts(), [{
    reasonCode: SANDBOX_BOUNDARY_DENIED, toolCategory: 'unknown', count: 1,
  }]);
});

test('structured denied status and explicit result error are boundary failures', () => {
  for (const result of [
    { status: 'DENIED' },
    { status: 'permission-denied' },
    { status: 'ERROR', error: { type: 'sandbox_blocked' } },
    { status: 'ERROR', error: 'tool soft-denied by policy' },
  ]) {
    const observer = new AntigravityBoundaryObserver();
    observer.observeFrame({ event: 'result', result });
    assert.equal(capturedFailure(observer).code, SANDBOX_BOUNDARY_DENIED);
  }
});

test('nested step_update tool_info is observed while assistant text remains uninspected', () => {
  const observer = new AntigravityBoundaryObserver();
  observer.observeFrame({ event: 'step_update', step_update: {
    tool_info: { name: 'write_file', error: { type: 'permission_denied' } },
    text_delta: 'The tool was denied by the sandbox.',
  } });
  observer.observeFrame({ event: 'result', result: {
    status: 'SUCCESS', response: 'Tool shell was denied by sandbox.',
  } });

  assert.equal(capturedFailure(observer).code, SANDBOX_BOUNDARY_DENIED);
  assert.deepEqual(observer.getBlockedReceipts(), [{
    reasonCode: SANDBOX_BOUNDARY_DENIED, toolCategory: 'file', count: 1,
  }]);

  const proseOnly = new AntigravityBoundaryObserver();
  proseOnly.observeFrame({ event: 'step_update', step_update: {
    text_delta: 'Tool shell was denied by sandbox.',
  } });
  proseOnly.observeFrame({ event: 'result', result: {
    status: 'SUCCESS', response: 'Permission required for a task; the tool was denied.',
  } });
  assert.equal(proseOnly.assertAllowed(), undefined);
  assert.deepEqual(proseOnly.getBlockedReceipts(), []);
});

test('stderr denial marker split across chunks latches despite later diagnostics', () => {
  const observer = new AntigravityBoundaryObserver();
  const notice = Buffer.from('提示 Tool edit was soft-denied by policy\n');
  const markerOffset = notice.indexOf(Buffer.from('soft-'));
  observer.observeStderr(notice.subarray(0, 1)); // Split the first UTF-8 character.
  observer.observeStderr(notice.subarray(1, markerOffset + 5));
  observer.observeStderr(Buffer.concat([
    notice.subarray(markerOffset + 5),
    Buffer.from('subsequent benign diagnostic\n'),
  ]));
  assert.equal(capturedFailure(observer).code, SANDBOX_BOUNDARY_DENIED);
  assert.deepEqual(observer.getBlockedReceipts(), [{
    reasonCode: SANDBOX_BOUNDARY_DENIED, toolCategory: 'file', count: 1,
  }]);
});

test('explicit headless and tool-context stderr denials are classified', () => {
  for (const [notice, toolCategory] of [
    ['Permission required for write_file was denied in headless mode', 'file'],
    ['Tool shell was denied by the headless permission policy', 'command'],
  ]) {
    const observer = new AntigravityBoundaryObserver();
    observer.observeStderr(`${notice}\n`);
    assert.equal(capturedFailure(observer).code, SANDBOX_BOUNDARY_DENIED);
    assert.deepEqual(observer.getBlockedReceipts(), [{
      reasonCode: SANDBOX_BOUNDARY_DENIED, toolCategory, count: 1,
    }]);
  }
});

test('ordinary warnings and assistant prose containing permission words do not fail', () => {
  const observer = new AntigravityBoundaryObserver();
  observer.observeStderr('warning: permission settings are available in the help page\n');
  observer.observeFrame({ event: 'result', result: {
    status: 'SUCCESS', response: 'The word permission appears here, but this is assistant prose.',
  } });
  assert.equal(observer.assertAllowed(), undefined);
});

test('oversized diagnostics remain bounded and expose no raw path, prompt, or token', () => {
  const observer = new AntigravityBoundaryObserver();
  observer.observeStderr(`${'diagnostic '.repeat(700)}Tool write was soft-denied by sandbox at /sensitive/path prompt=private token=secret\n`);

  const error = capturedFailure(observer);
  const publicFields = `${error.message}\n${error.diagnostic}\n${error.stack ?? ''}`;
  assert.equal(error.code, SANDBOX_BOUNDARY_DENIED);
  assert.equal(publicFields.includes('/sensitive/path'), false);
  assert.equal(publicFields.includes('private'), false);
  assert.equal(publicFields.includes('secret'), false);
  assert.ok(publicFields.length < 2_000);
  assert.deepEqual(observer.getBlockedReceipts(), [{
    reasonCode: SANDBOX_BOUNDARY_DENIED, toolCategory: 'file', count: 1,
  }]);
});

test('blocked receipt counts saturate at a fixed safe limit', () => {
  const observer = new AntigravityBoundaryObserver();
  const deniedFrame = { tool_info: { name: 'shell', error: { type: 'permission_denied' } } };
  for (let index = 0; index < 100_005; index += 1) observer.observeFrame(deniedFrame);

  const receipts = observer.getBlockedReceipts();
  assert.deepEqual(receipts, [{
    reasonCode: SANDBOX_BOUNDARY_DENIED, toolCategory: 'command', count: 100_000,
  }]);
  assert.ok(Number.isSafeInteger(receipts[0].count));
});
