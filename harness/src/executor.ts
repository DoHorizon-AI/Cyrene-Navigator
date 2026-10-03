// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Headless Cloud Executor Daemon                    │
// │ Role: Autonomous Agent execution service over REST, SSE, and Cordis │
// │ 模块职责：Navigator 独立 Cloud/Local 执行器，支持 REST、SSE 与热插件。   │
// └─────────────────────────────────────────────────────────────────────┘

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { brandString } from '@deepseek-ai/dsh-brand';
import type { Agent, AgentOptions, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { DynamicPluginManager } from './plugin-manager.js';

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'aborted';

export interface ExecuteTaskParams {
  readonly prompt: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly agentPreset?: string;
  readonly timeoutMs?: number;
  readonly stream?: boolean;
}

export type ExecutorStreamEvent =
  | { type: 'status'; taskId: string; sessionId: string; status: TaskStatus; timestamp: number }
  | { type: 'text-delta'; taskId: string; text: string; timestamp: number }
  | { type: 'reasoning-delta'; taskId: string; text: string; timestamp: number }
  | { type: 'tool-call'; taskId: string; callId: string; tool: string; args: string; timestamp: number }
  | { type: 'tool-result'; taskId: string; callId: string; result: string; timestamp: number }
  | { type: 'finish'; taskId: string; status: TaskStatus; output: string; durationMs: number; timestamp: number }
  | { type: 'error'; taskId: string; message: string; code?: string; timestamp: number };

export interface TaskOutcome {
  readonly taskId: string;
  readonly sessionId: string;
  readonly status: TaskStatus;
  readonly output: string;
  readonly reasoning: string;
  readonly error?: string;
  readonly durationMs: number;
}

export interface TaskRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly status: TaskStatus;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly output: string;
  readonly reasoning: string;
  readonly error?: string;
  readonly durationMs: number;
}

interface InternalTaskState {
  id: string;
  sessionId: string;
  prompt: string;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  output: string;
  reasoning: string;
  error?: string;
  agent?: Agent;
  abortController?: AbortController;
  subscribers: Set<(event: ExecutorStreamEvent) => void>;
}

export interface ExecutorConfig {
  readonly port?: number;
  readonly host?: string;
  readonly defaultCwd?: string;
  readonly defaultTimeoutMs?: number;
}

export class NavigatorExecutor {
  private readonly tasks = new Map<string, InternalTaskState>();
  private readonly agentTaskMap = new Map<Agent, string>();
  private httpServer?: Server;
  private readonly defaultTimeoutMs: number;
  private disposeStreamListener?: () => void;

  constructor(
    private readonly ctx: Context,
    private readonly config: ExecutorConfig = {},
  ) {
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 300_000;
    this.setupStreamListener();
  }

  /**
   * Listen to upstream Cordis agent assistant stream events and forward to active tasks.
   */
  private setupStreamListener(): void {
    this.disposeStreamListener = this.ctx.on('agent/assistant-stream', (payload: { agent: Agent; frame: any }) => {
      const agent = payload?.agent as Agent | undefined;
      const frame = payload?.frame;
      if (!agent || !frame) return;

      const taskId = this.agentTaskMap.get(agent);
      if (!taskId) return;

      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'running') return;

      const now = Date.now();
      const chunk = frame.chunk;
      if (!chunk) return;

      if (chunk.type === 'text-delta' && chunk.text) {
        task.output += chunk.text;
        this.emitToSubscribers(task, {
          type: 'text-delta',
          taskId,
          text: chunk.text,
          timestamp: now,
        });
      } else if (chunk.type === 'reasoning-delta' && chunk.text) {
        task.reasoning += chunk.text;
        this.emitToSubscribers(task, {
          type: 'reasoning-delta',
          taskId,
          text: chunk.text,
          timestamp: now,
        });
      } else if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
        // Tool execution started
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
        this.emitToSubscribers(task, {
          type: 'tool-call',
          taskId,
          callId: chunk.block.id ?? '',
          tool: chunk.block.name ?? '',
          args: chunk.block.arguments ?? '',
          timestamp: now,
        });
      }
    });
  }

  /**
   * Execute an autonomous Agent task to completion or stream live events.
   * 中文：执行自主 Agent 任务，支持阻塞完成或实时事件订阅。
   */
  async executeTask(
    params: ExecuteTaskParams,
    subscriber?: (event: ExecutorStreamEvent) => void,
  ): Promise<TaskOutcome> {
    const taskId = params.taskId ?? `task-${randomUUID()}`;
    const sessionId = brandString<SessionId>(params.sessionId ?? `session-${randomUUID()}`);
    const abortController = new AbortController();

    const state: InternalTaskState = {
      id: taskId,
      sessionId,
      prompt: params.prompt,
      status: 'queued',
      createdAt: Date.now(),
      output: '',
      reasoning: '',
      abortController,
      subscribers: new Set(),
    };

    if (subscriber) {
      state.subscribers.add(subscriber);
    }
    this.tasks.set(taskId, state);

    this.emitToSubscribers(state, {
      type: 'status',
      taskId,
      sessionId,
      status: 'queued',
      timestamp: state.createdAt,
    });

    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutId = setTimeout(() => {
      abortController.abort(new Error(`Task timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      state.startedAt = Date.now();
      state.status = 'running';
      this.emitToSubscribers(state, {
        type: 'status',
        taskId,
        sessionId,
        status: 'running',
        timestamp: state.startedAt,
      });

      const agents = this.ctx.get('agents');
      const sessions = this.ctx.get('sessions');
      const defaultModel = this.ctx.get('agentDefaultModel');

      if (!agents || !sessions) {
        throw new Error('Required Cordis services (agents, sessions) are not available');
      }

      const cwd = params.cwd ?? this.config.defaultCwd ?? process.cwd();
      const selection = defaultModel?.currentSelection();
      const agentOptions: AgentOptions = selection
        ? { provider: selection.provider, model: selection.model }
        : {};

      const setup = (agentCtx: Context): void => {
        if (selection) {
          const selected: ModelSelectionRef = { current: selection, assembled: undefined };
          installModelSelection(agentCtx, selected);
        }
      };

      // Create fresh agent or resume existing session
      const existing = agents.get(sessionId);
      let agent: Agent;
      if (existing) {
        agent = existing;
      } else {
        const handle = await agents.create({
          sessionId,
          meta: { cwd, agentPreset: params.agentPreset },
          agentOptions,
          setup,
          signal: abortController.signal,
        });
        agent = handle.agent;
      }

      state.agent = agent;
      this.agentTaskMap.set(agent, taskId);

      // Enqueue the task input
      (agent as any).followup(createUserMessage({
        content: [{ type: 'text', text: params.prompt }],
        source: { kind: 'user' },
      }));

      // Wait until agent finishes the turn
      await (agent as any).whenIdle();

      const isAborted = (state.status as TaskStatus) === 'aborted' || abortController.signal.aborted;
      if (isAborted) {
        state.status = 'aborted';
        state.endedAt ??= Date.now();
        state.error ??= 'Task was cancelled';
        return {
          taskId,
          sessionId,
          status: 'aborted',
          output: state.output,
          reasoning: state.reasoning,
          error: state.error,
          durationMs: state.endedAt - (state.startedAt ?? state.createdAt),
        };
      }

      await sessions.flush(agent.session);

      state.endedAt = Date.now();
      state.status = 'completed';

      // Fallback: if output wasn't populated from stream, extract from session log
      if (!state.output) {
        state.output = this.extractLatestAssistantText(agent.session);
      }

      const outcome: TaskOutcome = {
        taskId,
        sessionId,
        status: 'completed',
        output: state.output,
        reasoning: state.reasoning,
        durationMs: state.endedAt - (state.startedAt ?? state.createdAt),
      };

      this.emitToSubscribers(state, {
        type: 'finish',
        taskId,
        status: 'completed',
        output: state.output,
        durationMs: outcome.durationMs,
        timestamp: state.endedAt,
      });

      return outcome;
    } catch (err: unknown) {
      state.endedAt = Date.now();
      const isAborted = abortController.signal.aborted;
      state.status = isAborted ? 'aborted' : 'failed';
      state.error = err instanceof Error ? err.message : String(err);

      const durationMs = state.endedAt - (state.startedAt ?? state.createdAt);
      this.emitToSubscribers(state, {
        type: 'error',
        taskId,
        message: state.error,
        code: isAborted ? 'TASK_ABORTED' : 'EXECUTION_FAILED',
        timestamp: state.endedAt,
      });

      return {
        taskId,
        sessionId,
        status: state.status,
        output: state.output,
        reasoning: state.reasoning,
        error: state.error,
        durationMs,
      };
    } finally {
      clearTimeout(timeoutId);
      if (state.agent) {
        this.agentTaskMap.delete(state.agent);
      }
    }
  }

  /**
   * Cancel / abort an ongoing task execution.
   * 中文：取消或终止正在执行中的任务。
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || (task.status !== 'running' && task.status !== 'queued')) {
      return false;
    }

    task.abortController?.abort(new Error(`Task ${taskId} was cancelled by caller`));
    if (task.agent) {
      try {
        if (typeof (task.agent as any).cancel === 'function') {
          (task.agent as any).cancel('caller-cancelled');
        } else if (typeof (task.agent as any).abort === 'function') {
          (task.agent as any).abort();
        }
      } catch {
        // Best-effort abort
      }
    }

    task.error = `Task ${taskId} was cancelled by caller`;
    task.status = 'aborted';
    task.endedAt = Date.now();
    this.emitToSubscribers(task, {
      type: 'status',
      taskId,
      sessionId: task.sessionId,
      status: 'aborted',
      timestamp: task.endedAt,
    });
    return true;
  }

  /**
   * Subscribe to real-time events for an existing task.
   */
  subscribe(taskId: string, listener: (event: ExecutorStreamEvent) => void): () => void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    task.subscribers.add(listener);
    return () => task.subscribers.delete(listener);
  }

  /**
   * Query status and details of a single task.
   */
  getTask(taskId: string): TaskRecord | undefined {
    const t = this.tasks.get(taskId);
    if (!t) return undefined;
    const durationMs = (t.endedAt ?? Date.now()) - (t.startedAt ?? t.createdAt);
    return {
      id: t.id,
      sessionId: t.sessionId,
      prompt: t.prompt,
      status: t.status,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      output: t.output,
      reasoning: t.reasoning,
      error: t.error,
      durationMs,
    };
  }

  /**
   * List all tracked tasks.
   */
  listTasks(): readonly TaskRecord[] {
    return Array.from(this.tasks.keys()).map(id => this.getTask(id)!);
  }

  /**
   * Launch standalone HTTP and SSE daemon listener for remote cloud backend execution.
   * 中文：启动独立 HTTP/SSE 守护监听服务，满足云端后端无头部署与远程调用。
   */
  async startServer(port: number, host = '0.0.0.0'): Promise<{ url: string; close: () => Promise<void> }> {
    if (this.httpServer) {
      throw new Error('HTTP server is already running');
    }

    const server = createServer(async (req, res) => {
      await this.handleHttpRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(port, host, () => resolve());
      server.once('error', reject);
    });

    this.httpServer = server;
    const address = server.address();
    const resolvedPort = typeof address === 'object' && address ? address.port : port;
    const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${resolvedPort}`;

    return {
      url,
      close: async () => {
        await new Promise<void>(resolve => server.close(() => resolve()));
        this.httpServer = undefined;
      },
    };
  }

  /**
   * Handle incoming REST and SSE HTTP requests.
   */
  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method?.toUpperCase();

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Health check endpoint
      if (method === 'GET' && url.pathname === '/api/v1/health') {
        this.sendJson(res, 200, {
          status: 'ok',
          service: 'cyrene-navigator-executor',
          activeTasks: Array.from(this.tasks.values()).filter(t => t.status === 'running').length,
          totalTasks: this.tasks.size,
          timestamp: Date.now(),
        });
        return;
      }

      // Execute task endpoint (supports stream=true or Accept: text/event-stream)
      if (method === 'POST' && (url.pathname === '/api/v1/execute' || url.pathname === '/api/v1/tasks')) {
        const body = await this.readJsonBody(req);
        if (!body.prompt || typeof body.prompt !== 'string') {
          this.sendJson(res, 400, { error: 'Missing or invalid "prompt" parameter' });
          return;
        }

        const isStream = Boolean(body.stream || req.headers.accept?.includes('text/event-stream'));

        if (isStream) {
          // SSE streaming mode
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
          });
          res.flushHeaders?.();

          const onEvent = (event: ExecutorStreamEvent) => {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          };

          await this.executeTask({
            prompt: body.prompt,
            taskId: body.taskId,
            sessionId: body.sessionId,
            cwd: body.cwd,
            agentPreset: body.agentPreset,
            timeoutMs: body.timeoutMs,
            stream: true,
          }, onEvent);

          res.end();
          return;
        } else {
          // Synchronous outcome JSON mode
          const outcome = await this.executeTask({
            prompt: body.prompt,
            taskId: body.taskId,
            sessionId: body.sessionId,
            cwd: body.cwd,
            agentPreset: body.agentPreset,
            timeoutMs: body.timeoutMs,
            stream: false,
          });
          this.sendJson(res, 200, outcome);
          return;
        }
      }

      // Query single task status
      const statusMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/status$/);
      if (method === 'GET' && statusMatch) {
        const taskId = decodeURIComponent(statusMatch[1]!);
        const task = this.getTask(taskId);
        if (!task) {
          this.sendJson(res, 404, { error: `Task not found: ${taskId}` });
          return;
        }
        this.sendJson(res, 200, task);
        return;
      }

      // Cancel single task
      const cancelMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/cancel$/);
      if (method === 'POST' && cancelMatch) {
        const taskId = decodeURIComponent(cancelMatch[1]!);
        const cancelled = await this.cancelTask(taskId);
        this.sendJson(res, 200, { taskId, cancelled });
        return;
      }

      // Stream subscription to an existing task
      const streamMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/stream$/);
      if (method === 'GET' && streamMatch) {
        const taskId = decodeURIComponent(streamMatch[1]!);
        const task = this.tasks.get(taskId);
        if (!task) {
          this.sendJson(res, 404, { error: `Task not found: ${taskId}` });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
        });
        res.flushHeaders?.();

        const unsubscribe = this.subscribe(taskId, event => {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          if (event.type === 'finish' || event.type === 'error') {
            res.end();
          }
        });

        req.on('close', unsubscribe);
        return;
      }

      // Plugin Management: List plugins
      if (method === 'GET' && url.pathname === '/api/v1/plugins') {
        const pluginManager = this.ctx.get('pluginManager') as DynamicPluginManager | undefined;
        const plugins = pluginManager ? pluginManager.listPlugins() : [];
        this.sendJson(res, 200, { plugins });
        return;
      }

      // Plugin Management: Reload plugin
      if (method === 'POST' && url.pathname === '/api/v1/plugins/reload') {
        const body = await this.readJsonBody(req);
        const pluginManager = this.ctx.get('pluginManager') as DynamicPluginManager | undefined;
        if (!pluginManager) {
          this.sendJson(res, 503, { error: 'Dynamic plugin manager is not enabled' });
          return;
        }

        if (body.id) {
          const result = await pluginManager.reloadPlugin(body.id);
          this.sendJson(res, 200, { reloaded: true, plugin: result });
        } else {
          const results = await pluginManager.reloadAll();
          this.sendJson(res, 200, { reloaded: true, plugins: results });
        }
        return;
      }

      this.sendJson(res, 404, { error: `Not found: ${method} ${url.pathname}` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 500, { error: msg });
    }
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    const payload = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  private readJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => {
        data += chunk;
        if (data.length > 5 * 1024 * 1024) {
          req.destroy(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Invalid JSON body: ${err}`));
        }
      });
      req.on('error', reject);
    });
  }

  private emitToSubscribers(task: InternalTaskState, event: ExecutorStreamEvent): void {
    for (const sub of task.subscribers) {
      try {
        sub(event);
      } catch {
        // Ignore subscriber delivery exceptions
      }
    }
  }

  private extractLatestAssistantText(session: Session): string {
    let result = '';
    const length = session.seq;
    for (let seq = length - 1; seq >= 0; seq--) {
      const event = session.eventAt(SessionSeq(seq));
      if (event?.type === 'assistant/message') {
        const content = (event as any).data?.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              result += block.text;
            }
          }
        }
        if (result) break;
      }
    }
    return result;
  }

  /**
   * Teardown executor resources and active HTTP server.
   */
  async dispose(): Promise<void> {
    this.disposeStreamListener?.();
    if (this.httpServer) {
      await new Promise<void>(resolve => this.httpServer!.close(() => resolve()));
      this.httpServer = undefined;
    }
    for (const [id, task] of this.tasks.entries()) {
      if (task.status === 'running') {
        void this.cancelTask(id);
      }
    }
    this.tasks.clear();
    this.agentTaskMap.clear();
  }
}

export const name = 'cyrene-executor';
export const inject = ['agents', 'sessions', 'agentDefaultModel'];

export function apply(ctx: Context, config?: ExecutorConfig): void {
  const executor = new NavigatorExecutor(ctx, config);
  ctx.provide('executor', executor);
  ctx.effect(() => () => { void executor.dispose(); });

  // If a port was specified in config, start the HTTP server automatically
  if (config?.port !== undefined) {
    void executor.startServer(config.port, config.host);
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    executor: NavigatorExecutor;
  }
  interface Events {
    'agent/assistant-stream'(payload: { agent: Agent; frame: any }): void;
  }
}
