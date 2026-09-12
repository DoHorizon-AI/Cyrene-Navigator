// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator native IPC client                                │
// │ Role: Supervise one versioned stdio request through Harness.        │
// │ 模块职责：监督 Rust 子进程、协议、取消和退出；不拥有 Tool 生命周期。  │
// └─────────────────────────────────────────────────────────────────────┘
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Context } from '@deepseek-ai/cordis';
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess';
import { record } from './persistence-wire.js';

export interface NativeConfig {
  binary: string;
  timeoutMs: number;
  cancelGraceMs: number;
  maxResponseBytes: number;
}

/** Run a supervised native request; process exit is part of completion. */
export async function runNativeRequest(
  ctx: Context, config: NativeConfig, cwd: string, method: string,
  params: Record<string, unknown>, signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const child = ctx.subprocess.spawn({
    argv: [config.binary], cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16_384 } },
    graceMs: config.cancelGraceMs,
  });
  if (!child.stdin || !child.stdout) {
    child.terminate();
    await child.done;
    throw new Error('Native host did not provide protocol pipes');
  }
  const requestId = randomUUID();
  const helloId = randomUUID();
  const cancelId = randomUUID();
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const cancellation = AbortSignal.any([signal, timeout]);
  let cancelled = false;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let sent = false;
  let settled = false;
  let receivedBytes = 0;
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  const write = (id: string, name: string, body: Record<string, unknown>) => {
    child.stdin!.write(`${JSON.stringify({ version: 1, id, method: name, params: body })}\n`);
  };
  const abort = () => {
    if (cancelled) return;
    cancelled = true;
    if (sent && !child.stdin!.destroyed) write(cancelId, 'cancel', { request_id: requestId });
    else child.terminate();
    cancelTimer = setTimeout(() => child.terminate(), config.cancelGraceMs);
    cancelTimer.unref();
  };
  cancellation.addEventListener('abort', abort, { once: true });
  const response = new Promise<unknown>((resolve, reject) => {
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
      child.terminate();
    };
    child.stdin!.on('error', fail);
    child.stdout!.on('error', fail);
    child.stdout!.on('data', (bytes: Buffer) => {
      if (settled) return;
      try {
        receivedBytes += bytes.length;
        if (receivedBytes > config.maxResponseBytes) throw new Error('Native response exceeded its byte limit');
        buffer += decoder.write(bytes);
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          const frame = record(JSON.parse(line));
          if (frame.version !== 1) throw new Error('Native protocol version mismatch');
          if (frame.event !== undefined) {
            if (frame.request_id !== requestId && frame.request_id !== helloId && frame.request_id !== cancelId) {
              throw new Error('Native event has an unknown request id');
            }
            continue;
          }
          if (frame.id === cancelId && cancelled) continue;
          if (frame.id !== helloId && frame.id !== requestId) throw new Error('Native response has an unknown id');
          if (('result' in frame) === ('error' in frame)) throw new Error('Native response must have one outcome');
          if (frame.error !== undefined) {
            const error = record(frame.error);
            throw new Error(`Native ${String(error.code)}: ${String(error.message)}`);
          }
          if (frame.id === helloId) {
            if (sent) throw new Error('Native host repeated the handshake');
            const hello = record(frame.result);
            if (hello.protocol_version !== 1) throw new Error('Native handshake version mismatch');
            cancellation.throwIfAborted();
            sent = true;
            write(requestId, method, params);
          } else {
            if (!sent) throw new Error('Native host answered before handshake');
            settled = true;
            child.stdin!.end();
            resolve(frame.result);
          }
        }
      } catch (error) { fail(error); }
    });
    void child.done.then(outcome => {
      if (!settled) fail(new Error(`Native host exited before a result (${outcome.exitCode ?? outcome.signal})`));
    }, fail);
  });
  try {
    write(helloId, 'hello', {});
    if (cancellation.aborted) abort();
    const result = await response;
    const outcome = await waitForQuiescence(child, config.cancelGraceMs);
    cancellation.throwIfAborted();
    if (outcome.exitCode !== 0) throw new Error(`Native host exit failed (${outcome.exitCode ?? outcome.signal})`);
    return result;
  } finally {
    cancellation.removeEventListener('abort', abort);
    if (cancelTimer) clearTimeout(cancelTimer);
    if (!settled || cancelled) child.terminate();
    if (!child.stdin.destroyed) child.stdin.end();
    await waitForQuiescence(child, config.cancelGraceMs);
  }
}

/** Escalate a host that does not exit after closing its request stream. */
async function waitForQuiescence(child: SubprocessHandle, graceMs: number) {
  const timer = setTimeout(() => child.terminate(), graceMs);
  timer.unref();
  try {
    const outcome = await child.done;
    if (!await child.waitForExit(AbortSignal.timeout(graceMs))) {
      child.terminate();
      if (!await child.waitForExit(AbortSignal.timeout(graceMs * 3))) {
        throw new Error('Native process tree did not stop');
      }
    }
    return outcome;
  }
  finally { clearTimeout(timer); }
}
