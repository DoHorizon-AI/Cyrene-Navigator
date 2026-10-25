// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator prioritized model request gate                    │
// │ Role: Reserve one bounded model lane for each execution class.       │
// │ 模块职责：为前台聊天和后台任务各保留一个有界模型调用槽。                │
// └─────────────────────────────────────────────────────────────────────┘

import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { TaskExecutionClass } from './executor.js';

interface ModelWaiter {
  readonly executionClass: TaskExecutionClass;
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}

/** One model request per class; background calls cannot occupy foreground capacity. */
export class PrioritizedModelGate {
  private activeForeground = false;
  private activeBackground = false;
  private readonly waiting: ModelWaiter[] = [];

  /**
   * Acquire the caller's isolated model lane and return its release function.
   * @param executionClass - foreground chat or background responsibility.
   * @param signal - cancellation source for a queued or active provider call.
   * @returns A release function that must run after the provider stream settles.
   */
  async acquire(executionClass: TaskExecutionClass, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.canRun(executionClass)) {
      this.reserve(executionClass);
      return () => this.release(executionClass);
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: ModelWaiter = {
        executionClass,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal.reason instanceof Error ? signal.reason : new DOMException('The model request was aborted', 'AbortError'));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      if (executionClass === 'foreground') {
        const firstBackground = this.waiting.findIndex(item => item.executionClass === 'background');
        if (firstBackground >= 0) this.waiting.splice(firstBackground, 0, waiter);
        else this.waiting.push(waiter);
      } else {
        this.waiting.push(waiter);
      }
    });
    return () => this.release(executionClass);
  }

  private canRun(executionClass: TaskExecutionClass): boolean {
    return executionClass === 'background' ? !this.activeBackground : !this.activeForeground;
  }

  private reserve(executionClass: TaskExecutionClass): void {
    if (executionClass === 'background') this.activeBackground = true;
    else this.activeForeground = true;
  }

  private release(executionClass: TaskExecutionClass): void {
    if (executionClass === 'background') this.activeBackground = false;
    else this.activeForeground = false;
    for (;;) {
      const index = this.waiting.findIndex(waiter => this.canRun(waiter.executionClass));
      if (index < 0) return;
      const waiter = this.waiting.splice(index, 1)[0]!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason);
        continue;
      }
      this.reserve(waiter.executionClass);
      waiter.resolve();
    }
  }
}

/** DSH adapter wrapper that shares each bounded class slot across every configured route. */
export class PrioritizedModelAdapter extends LlmAdapter {
  constructor(
    private readonly inner: LlmAdapter,
    private readonly gate: PrioritizedModelGate,
    private readonly executionClassForSession: (sessionId: string) => TaskExecutionClass,
  ) {
    super();
  }

  override providerInfo(provider: string) {
    return this.inner.providerInfo(provider);
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.inner.listModels(provider);
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return this.inner.resolveModel(provider, model);
  }

  /** Keep foreground chat independent from a provider call already in flight for the background lane. */
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const sessionId = options.sessionId === undefined ? '' : String(options.sessionId);
    const executionClass = sessionId === '' ? 'foreground' : this.executionClassForSession(sessionId);
    const signal = options.signal ?? new AbortController().signal;
    const release = await this.gate.acquire(executionClass, signal);
    try {
      for await (const chunk of this.inner.stream(options)) yield chunk;
    } finally {
      release();
    }
  }
}
