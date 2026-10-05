// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator authenticated executor HTTP client                │
// │ Role: Submit tasks and replay their durable event streams.         │
// │ 模块职责：提交任务，并按游标重放经过认证的持久事件流。                 │
// └─────────────────────────────────────────────────────────────────────┘

import type { ExecuteTaskParams, ExecutorStreamEvent, TaskOutcome } from './executor.js';
import type { TaskRecord, TaskPage } from './work-state-client.js';

export interface ExecutorClientConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly requestTimeoutMs?: number;
}

export interface ExecutorEventFrame {
  readonly seq?: number;
  readonly type: string;
  readonly data: ExecutorStreamEvent | Record<string, unknown>;
}

/** Authenticated client for the workspace-pinned executor API.  中文：面向 Workspace 固定执行器 API 的认证客户端。 */
export class NavigatorExecutorClient {
  private readonly baseUrl: string;

  constructor(private readonly config: ExecutorClientConfig) {
    const url = new URL(config.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Invalid executor base URL');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('Remote executor requires HTTPS; HTTP is limited to loopback');
    }
    if (!config.token.trim()) throw new Error('Executor bearer token is required');
    this.baseUrl = url.href.replace(/\/$/u, '');
  }

  /** Submit work asynchronously and return the durable TaskRecord.  中文：异步提交任务并返回持久 TaskRecord。 */
  createTask(params: ExecuteTaskParams): Promise<TaskRecord> {
    return this.request('/api/v1/tasks', 'POST', params);
  }

  /** Read a workspace-scoped task.  中文：读取 Workspace 范围内任务。 */
  getTask(taskId: string): Promise<TaskRecord> {
    return this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}`, 'GET');
  }

  /** List durable tasks in backend cursor order.  中文：按后端游标顺序列出持久任务。 */
  listTasks(options: { cursor?: string; limit?: number } = {}): Promise<TaskPage> {
    const query = new URLSearchParams();
    if (options.cursor) query.set('cursor', options.cursor);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request(`/api/v1/tasks${suffix}`, 'GET');
  }

  /** Cancel a queued or running task.  中文：取消排队或运行中的任务。 */
  cancelTask(taskId: string): Promise<{ taskId: string; cancelled: boolean }> {
    return this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, 'POST', {});
  }

  /** Execute synchronously for trusted callers that require a final outcome.  中文：为需要最终结果的可信调用方同步执行任务。 */
  executeTask(params: ExecuteTaskParams, signal?: AbortSignal): Promise<TaskOutcome> {
    return this.request('/api/v1/execute', 'POST', params, signal);
  }

  /** Replay durable SSE events after an exclusive sequence cursor and continue with live appends.  中文：从排他序号游标重放持久 SSE 事件，并继续读取实时追加。 */
  async *streamTaskEvents(
    taskId: string,
    after = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<ExecutorEventFrame> {
    const response = await this.fetch(`/api/v1/tasks/${encodeURIComponent(taskId)}/events?after=${after}`, 'GET', undefined, signal, true);
    if (!response.ok) throw new Error(`Executor event stream failed (${response.status})`);
    if (!response.body) throw new Error('Executor event stream did not include a body');
    const decoder = new TextDecoder();
    let buffer = '';
    let id: string | undefined;
    let type = 'message';
    let data: string[] = [];
    const parseEvent = (): ExecutorEventFrame | undefined => {
      if (data.length === 0) { id = undefined; type = 'message'; return undefined; }
      let parsed: unknown;
      try { parsed = JSON.parse(data.join('\n')); } catch { throw new Error('Executor sent malformed SSE JSON'); }
      const seq = id === undefined ? undefined : Number(id);
      const result: ExecutorEventFrame = {
        ...(seq === undefined || !Number.isSafeInteger(seq) ? {} : { seq }),
        type,
        data: parsed as ExecutorStreamEvent | Record<string, unknown>,
      };
      id = undefined;
      type = 'message';
      data = [];
      return result;
    };

    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf('\n');
      while (boundary >= 0) {
        const line = buffer.slice(0, boundary).replace(/\r$/u, '');
        buffer = buffer.slice(boundary + 1);
        if (line.length === 0) {
          const event = parseEvent();
          if (event) yield event;
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /u, '');
          if (field === 'id' && !value.includes('\u0000')) id = value;
          else if (field === 'event') type = value;
          else if (field === 'data') data.push(value);
        }
        boundary = buffer.indexOf('\n');
      }
    }
    if (buffer.length > 0) {
      for (const line of buffer.split(/\r?\n/u)) {
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
        else if (line.startsWith('event:')) type = line.slice(6).replace(/^ /u, '');
        else if (line.startsWith('id:')) id = line.slice(3).replace(/^ /u, '');
      }
    }
    const finalEvent = parseEvent();
    if (finalEvent) yield finalEvent;
  }

  private async request<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetch(path, method, body, signal);
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error(`Executor returned invalid JSON (${response.status})`); }
    if (!response.ok) throw new Error(`Executor request failed (${response.status})`);
    return value as T;
  }

  private fetch(path: string, method: string, body?: unknown, signal?: AbortSignal, sse = false): Promise<Response> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs ?? (sse ? 0x7fffffff : 15_000));
    return fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: sse ? 'text/event-stream' : 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error',
    });
  }
}
