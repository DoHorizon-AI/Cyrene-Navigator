// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Headless Cloud Executor Daemon                    │
// │ Role: Execute authenticated, durable tasks over REST and SSE.       │
// │ 模块职责：通过 REST/SSE 执行经过认证且持久化的任务。                    │
// └─────────────────────────────────────────────────────────────────────┘

import { timingSafeEqual } from 'node:crypto';
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
import type { ExecutionStatus, TaskRecord, WorkStateStore } from './work-state-client.js';

export type TaskStatus = ExecutionStatus;

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
  | { type: 'status'; taskId: string; sessionId: string; status: TaskStatus; timestamp: number; seq?: number }
  | { type: 'text-delta'; taskId: string; text: string; timestamp: number; seq?: number }
  | { type: 'reasoning-delta'; taskId: string; text: string; timestamp: number; seq?: number }
  | { type: 'tool-call'; taskId: string; callId: string; tool: string; args: string; timestamp: number; seq?: number }
  | { type: 'tool-result'; taskId: string; callId: string; result: string; isError?: boolean; timestamp: number; seq?: number }
  | { type: 'subagent-progress'; taskId: string; provider: string; phase?: string; message?: string; timestamp: number; seq?: number }
  | { type: 'subagent-assistant-delta'; taskId: string; provider: string; text: string; timestamp: number; seq?: number }
  | { type: 'permission'; taskId: string; provider: string; tool?: string; decision: 'approved' | 'denied'; timestamp: number; seq?: number }
  | { type: 'finish'; taskId: string; status: TaskStatus; output: string; durationMs: number; timestamp: number; seq?: number }
  | { type: 'error'; taskId: string; message: string; code?: string; timestamp: number; seq?: number };

export interface TaskOutcome {
  readonly taskId: string;
  readonly sessionId: string;
  readonly status: TaskStatus;
  readonly output: string;
  readonly reasoning: string;
  readonly error?: string;
  readonly durationMs: number;
}

interface InternalTaskState {
  readonly id: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly abortController: AbortController;
  readonly subscribers: Set<(event: ExecutorStreamEvent) => void>;
  record: TaskRecord;
  output: string;
  reasoning: string;
  agentError?: string;
  error?: string;
  agent?: Agent;
  eventChain: Promise<void>;
  eventFailure?: unknown;
  patchChain: Promise<void>;
  patchFailure?: unknown;
  completion?: Promise<TaskOutcome>;
}

export interface ExecutorConfig {
  readonly port?: number;
  readonly host?: string;
  readonly defaultCwd?: string;
  readonly defaultTimeoutMs?: number;
  readonly workState: WorkStateStore;
  readonly workspaceId: string;
  readonly authTokenEnv?: string;
  readonly allowedOrigins?: readonly string[];
}

const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'aborted']);
const INTERRUPTED_STATUSES = new Set<TaskStatus>(['running', 'waiting_approval', 'waiting_input']);

/** Run an autonomous agent against durable Work Task state and an authenticated REST/SSE boundary.  中文：基于持久 Work Task 执行 Agent，并提供认证 REST/SSE 边界。 */
export class NavigatorExecutor {
  /** Only active process-local handles live here; durable records stay in WorkStateStore.  中文：此 Map 只保存活动运行句柄；持久记录由 WorkStateStore 管理。 */
  private readonly tasks = new Map<string, InternalTaskState>();
  private readonly agentTaskMap = new Map<Agent, string>();
  private readonly sessionTaskMap = new Map<Session, string>();
  private readonly sessionTails = new Map<string, Promise<void>>();
  private readonly defaultTimeoutMs: number;
  private httpServer?: Server;
  private drainTimer?: ReturnType<typeof setInterval>;
  private disposeStreamListener?: () => void;
  private disposeErrorListener?: () => void;
  private disposeSessionListener?: () => void;
  private readonly ready: Promise<void>;

  constructor(
    private readonly ctx: Context,
    private readonly config: ExecutorConfig,
  ) {
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 300_000;
    this.setupStreamListeners();
    this.ready = this.recoverInterruptedTasks();
  }

  /** Capture actual upstream failures and tool lifecycle facts for the active task.  中文：捕获上游真实失败和工具生命周期事实。 */
  private setupStreamListeners(): void {
    this.disposeStreamListener = this.ctx.on('agent/assistant-stream', (payload: { agent: Agent; frame: any }) => {
      const task = this.activeForAgent(payload?.agent);
      const chunk = payload?.frame?.type === 'chunk' ? payload.frame.chunk : undefined;
      if (!task || !chunk) return;
      const timestamp = Date.now();
      if (chunk.type === 'text-delta' && chunk.text) {
        task.output += chunk.text;
        this.publish(task, { type: 'text-delta', taskId: task.id, text: chunk.text, timestamp });
        void this.patch(task, { output: task.output }).catch(() => undefined);
      } else if (chunk.type === 'reasoning-delta' && chunk.text) {
        task.reasoning += chunk.text;
        this.publish(task, { type: 'reasoning-delta', taskId: task.id, text: chunk.text, timestamp });
        void this.patch(task, { reasoning: task.reasoning }).catch(() => undefined);
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
        this.publish(task, {
          type: 'tool-call', taskId: task.id, callId: String(chunk.block.id),
          tool: chunk.block.name, args: chunk.block.arguments, timestamp,
        });
      }
    });

    this.disposeErrorListener = this.ctx.on('agent/error', (payload: { agent: Agent; error: unknown }) => {
      const task = this.activeForAgent(payload?.agent);
      if (!task) return;
      const message = safeErrorMessage(payload.error);
      task.agentError ??= message;
      this.publish(task, { type: 'error', taskId: task.id, message, code: 'AGENT_FAILED', timestamp: Date.now() });
    });

    this.disposeSessionListener = this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const taskId = this.sessionTaskMap.get(session);
      const task = taskId ? this.tasks.get(taskId) : undefined;
      if (!task || task.record.status !== 'running') return;
      if (event.type === 'tool/result') {
        const data = event.data as SessionEvent<'tool/result'>['data'];
        const blocks = data.message.content;
        const result = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
        this.publish(task, {
          type: 'tool-result', taskId: task.id, callId: String(data.message.toolCallId),
          result: result || JSON.stringify(blocks), isError: data.message.isError === true, timestamp: Date.now(),
        });
      }
    });
  }

  private activeForAgent(agent: Agent | undefined): InternalTaskState | undefined {
    const taskId = agent ? this.agentTaskMap.get(agent) : undefined;
    return taskId ? this.tasks.get(taskId) : undefined;
  }

  /** Fail uncertain running rows, then safely adopt queued rows with no model/tool side effects.  中文：失败关闭不确定的运行记录，并安全接管尚未产生模型/工具副作用的排队记录。 */
  private async recoverInterruptedTasks(): Promise<void> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.config.workState.listTasks({ cursor, limit: 100 });
      for (const row of page.items) {
        if (INTERRUPTED_STATUSES.has(row.status)) {
          const now = Date.now();
          const startedAt = row.startedAt ?? row.createdAt;
          const reason = row.status === 'running'
            ? 'Execution interrupted by executor restart; automatic replay is disabled.'
            : 'Human-gated execution was interrupted by executor restart; review the preserved approval record before creating a new task.';
          await this.config.workState.patchTask(row.id, { status: 'failed', error: reason });
          await this.config.workState.appendEvent(row.id, {
            type: 'error', taskId: row.id, message: reason, code: 'EXECUTOR_RESTARTED', timestamp: now,
          });
          await this.config.workState.appendEvent(row.id, {
            type: 'finish', taskId: row.id, status: 'failed', output: row.output,
            durationMs: Math.max(row.durationMs, now - startedAt), timestamp: now,
          });
        }
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }

  /** Execute one task, returning a prior durable result or joining its live run when taskId repeats.  中文：执行任务；重复 taskId 会读取结果或加入当前运行。 */
  async executeTask(
    params: ExecuteTaskParams,
    subscriber?: (event: ExecutorStreamEvent) => void,
  ): Promise<TaskOutcome> {
    await this.ready;
    const state = await this.prepareTask(params, subscriber, true);
    if (state.completion) return state.completion;
    return outcome(state.record);
  }

  /** Admit a task asynchronously for the task-control API and return its durable queued record.  中文：供任务控制 API 异步接收任务并返回持久排队记录。 */
  async startTask(params: ExecuteTaskParams): Promise<TaskRecord> {
    await this.ready;
    const state = await this.prepareTask(params, undefined, false);
    return state.record;
  }

  /** Dispatch one already-admitted queued task without creating a second TaskRecord.  中文：派发已接收的排队任务，不创建重复 TaskRecord。 */
  async dispatchTask(taskId: string, subscriber?: (event: ExecutorStreamEvent) => void): Promise<TaskOutcome> {
    const record = await this.getTask(taskId);
    if (!record) throw new Error('Task not found');
    return this.executeTask({ taskId, sessionId: record.sessionId, prompt: record.prompt }, subscriber);
  }

  /** Poll durable queued rows and race-safely claim each for execution.  中文：轮询持久排队记录并通过原子认领安全执行。 */
  async drainQueuedTasks(): Promise<number> {
    await this.ready;
    let started = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.config.workState.listTasks({ cursor, limit: 100 });
      for (const record of page.items) {
        if (record.status !== 'queued' || this.tasks.has(record.id)) continue;
        this.adoptQueuedTask(record, { taskId: record.id, sessionId: record.sessionId, prompt: record.prompt });
        started += 1;
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return started;
  }

  private async prepareTask(
    params: ExecuteTaskParams,
    subscriber?: (event: ExecutorStreamEvent) => void,
    dispatchQueued = true,
  ): Promise<InternalTaskState> {
    if (typeof params.prompt !== 'string' || params.prompt.length === 0) throw new TypeError('Missing or invalid "prompt" parameter');
    if (params.timeoutMs !== undefined && (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs <= 0)) {
      throw new TypeError('timeoutMs must be a positive integer');
    }
    const requestedId = params.taskId ?? `task-${randomUUID()}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(requestedId)) throw new TypeError('Invalid taskId');
    const existing = await this.config.workState.getTask(requestedId);
    if (existing) {
      const active = this.tasks.get(existing.id);
      if (active) {
        if (subscriber) active.subscribers.add(subscriber);
        return active;
      }
      if (existing.status === 'queued') {
        if (existing.prompt !== params.prompt || (params.sessionId !== undefined && existing.sessionId !== params.sessionId)) {
          throw new Error('Existing queued task does not match this dispatch request');
        }
        return dispatchQueued
          ? this.adoptQueuedTask(existing, params, subscriber)
          : stateFromRecord(existing);
      }
      const state = stateFromRecord(existing);
      if (dispatchQueued && existing.status === 'running') {
        state.completion = this.waitForTask(existing.id, subscriber);
      }
      return state;
    }

    const sessionId = brandString<SessionId>(params.sessionId ?? `session-${randomUUID()}`);
    if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 200) throw new TypeError('Invalid sessionId');
    let record: TaskRecord;
    try {
      record = await this.config.workState.createTask({ id: requestedId, sessionId, prompt: params.prompt });
    } catch (error) {
      // A simultaneous retry may have won the durable ID race. Read it once and never start duplicate work.
      const raced = await this.config.workState.getTask(requestedId);
      if (!raced) throw error;
      const active = this.tasks.get(raced.id);
      if (active) {
        if (subscriber) active.subscribers.add(subscriber);
        return active;
      }
      if (raced.status === 'queued') {
        return dispatchQueued ? this.adoptQueuedTask(raced, params, subscriber) : stateFromRecord(raced);
      }
      return stateFromRecord(raced);
    }

    // An API admission remains queued until the dispatcher claims it. This means connector
    // retries and process restarts cannot accidentally start a second model/tool side effect.
    if (!dispatchQueued) return stateFromRecord(record);
    const concurrent = this.tasks.get(record.id);
    if (concurrent) {
      if (subscriber) concurrent.subscribers.add(subscriber);
      return concurrent;
    }

    const task: InternalTaskState = {
      id: record.id, sessionId: record.sessionId, prompt: record.prompt,
      record, output: record.output, reasoning: record.reasoning,
      abortController: new AbortController(), subscribers: new Set(), eventChain: Promise.resolve(), patchChain: Promise.resolve(),
    };
    if (subscriber) task.subscribers.add(subscriber);
    this.tasks.set(task.id, task);
    task.abortController.signal.addEventListener('abort', () => {
      task.agent?.cancel({ kind: 'hook', reason: 'navigator_executor_cancelled' });
    }, { once: true });
    this.publish(task, {
      type: 'status', taskId: task.id, sessionId: task.sessionId, status: 'queued', timestamp: record.createdAt,
    });
    task.completion = this.runSerialized(task, params);
    return task;
  }

  /** Adopt a connector-created queued row through the same atomic claim path as a new task.  中文：通过同一原子认领路径接管连接器预先创建的排队任务。 */
  private adoptQueuedTask(
    record: TaskRecord,
    params: ExecuteTaskParams,
    subscriber?: (event: ExecutorStreamEvent) => void,
  ): InternalTaskState {
    const concurrent = this.tasks.get(record.id);
    if (concurrent) {
      if (subscriber) concurrent.subscribers.add(subscriber);
      return concurrent;
    }
    const task = stateFromRecord(record);
    if (subscriber) task.subscribers.add(subscriber);
    this.tasks.set(task.id, task);
    task.abortController.signal.addEventListener('abort', () => {
      task.agent?.cancel({ kind: 'hook', reason: 'navigator_executor_cancelled' });
    }, { once: true });
    task.completion = this.runSerialized(task, { ...params, taskId: task.id, sessionId: task.sessionId, prompt: task.prompt });
    return task;
  }

  /** A Session owns one task at a time so its output and tool events cannot mix. | 同一 Session 串行执行。 */
  private runSerialized(task: InternalTaskState, params: ExecuteTaskParams): Promise<TaskOutcome> {
    const predecessor = this.sessionTails.get(task.sessionId) ?? Promise.resolve();
    const completion = predecessor.then(() => this.runTask(task, params)).finally(() => {
      if (task.agent && this.agentTaskMap.get(task.agent) === task.id) this.agentTaskMap.delete(task.agent);
      if (task.agent && this.sessionTaskMap.get(task.agent.session) === task.id) this.sessionTaskMap.delete(task.agent.session);
      if (this.tasks.get(task.id) === task) this.tasks.delete(task.id);
    });
    const tail = completion.then(() => undefined, () => undefined);
    this.sessionTails.set(task.sessionId, tail);
    void tail.then(() => {
      if (this.sessionTails.get(task.sessionId) === tail) this.sessionTails.delete(task.sessionId);
    });
    return completion;
  }

  private async runTask(task: InternalTaskState, params: ExecuteTaskParams): Promise<TaskOutcome> {
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive number');
    const timeoutId = setTimeout(() => task.abortController.abort(new Error(`Task timed out after ${timeoutMs}ms`)), timeoutMs);
    let claimed = false;
    try {
      task.abortController.signal.throwIfAborted();
      const claim = await this.config.workState.claimTask(task.id);
      task.record = claim.task;
      if (!claim.claimed) {
        if (claim.task.status === 'running') return await this.waitForTask(task.id, event => this.deliver(task, event));
        return outcome(claim.task);
      }
      claimed = true;
      const startedAt = claim.task.startedAt ?? Date.now();
      await this.flushEvents(task);
      await this.publish(task, {
        type: 'status', taskId: task.id, sessionId: task.sessionId, status: 'running', timestamp: startedAt,
      });

      const agents = this.ctx.get('agents');
      const sessions = this.ctx.get('sessions');
      const defaultModel = this.ctx.get('agentDefaultModel');
      if (!agents || !sessions) throw new Error('Required Cordis services (agents, sessions) are not available');

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

      const sessionId = brandString<SessionId>(task.sessionId);
      const existing = agents.get(sessionId);
      let agent: Agent;
      if (existing) agent = existing;
      else {
        const persisted = this.ctx.get('sessionPersistence')
          ? await this.ctx.sessionPersistence.stat(sessionId, { signal: task.abortController.signal })
          : undefined;
        const handle = persisted
          ? await agents.resume({ resumeSessionId: sessionId, agentOptions, setup, signal: task.abortController.signal })
          : await agents.create({
            sessionId,
            meta: { cwd, agentPreset: params.agentPreset },
            agentOptions,
            setup,
            signal: task.abortController.signal,
          });
        agent = handle.agent;
      }

      task.agent = agent;
      this.agentTaskMap.set(agent, task.id);
      this.sessionTaskMap.set(agent.session, task.id);
      task.abortController.signal.throwIfAborted();
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: params.prompt }],
        source: { kind: 'user' },
      }));

      await agent.whenIdle();
      await this.flushEvents(task);
      await this.flushPatches(task);
      task.abortController.signal.throwIfAborted();
      await sessions.flush(agent.session);
      const latestRecord = await this.config.workState.getTask(task.id);
      if (latestRecord) task.record = latestRecord;
      if (task.record.status === 'waiting_approval' || task.record.status === 'waiting_input') {
        return outcome(task.record);
      }
      if (TERMINAL_STATUSES.has(task.record.status)) return outcome(task.record);

      if (!task.output) task.output = this.extractLatestAssistantText(agent.session);
      const finishedAt = Date.now();
      const isAborted = task.abortController.signal.aborted;
      const status: TaskStatus = isAborted ? 'aborted' : task.agentError ? 'failed' : 'completed';
      const error = task.error ?? task.agentError ?? (isAborted ? 'Task was cancelled' : undefined);
      const durationMs = finishedAt - (task.record.startedAt ?? task.record.createdAt);
      await this.patch(task, {
        status, output: task.output, reasoning: task.reasoning,
        ...(error === undefined ? {} : { error }),
      });
      await this.publish(task, {
        type: 'status', taskId: task.id, sessionId: task.sessionId, status, timestamp: finishedAt,
      });
      if (status === 'failed' || status === 'aborted') {
        await this.publish(task, {
          type: 'error', taskId: task.id, message: error ?? 'Task failed',
          code: status === 'aborted' ? 'TASK_ABORTED' : 'EXECUTION_FAILED', timestamp: finishedAt,
        });
      }
      await this.publish(task, {
        type: 'finish', taskId: task.id, status, output: task.output, durationMs, timestamp: finishedAt,
      });
      await this.flushEvents(task);
      return outcome(task.record);
    } catch (err: unknown) {
      if (!claimed) {
        try {
          const latest = await this.config.workState.getTask(task.id);
          if (latest) {
            task.record = latest;
            if (latest.status === 'running') return await this.waitForTask(task.id);
            return outcome(latest);
          }
        } catch {
          return outcome(task.record, safeErrorMessage(err), task.record.status);
        }
      }
      const endedAt = Date.now();
      const isAborted = task.abortController.signal.aborted;
      const status: TaskStatus = isAborted ? 'aborted' : 'failed';
      const message = task.error ?? (isAborted ? abortMessage(task.abortController.signal.reason) : safeErrorMessage(err));
      const durationMs = endedAt - (task.record.startedAt ?? task.record.createdAt);
      task.output ||= task.agent ? this.extractLatestAssistantText(task.agent.session) : '';
      try {
        // Close a failed write chain with an independent terminal reconciliation.
        // 中文：写入链失败后，独立尝试持久化失败终态，避免把执行成功写入事件。
        await task.patchChain;
        task.record = await this.config.workState.patchTask(task.id, {
          status, output: task.output, reasoning: task.reasoning, error: message,
        });
        await this.publish(task, {
          type: 'error', taskId: task.id, message,
          code: isAborted ? 'TASK_ABORTED' : 'EXECUTION_FAILED', timestamp: endedAt,
        });
        await this.publish(task, {
          type: 'status', taskId: task.id, sessionId: task.sessionId, status, timestamp: endedAt,
        });
        await this.publish(task, {
          type: 'finish', taskId: task.id, status, output: task.output, durationMs, timestamp: endedAt,
        });
        await this.flushEvents(task);
      } catch {
        // Preserve the original execution failure; startup recovery will close an uncommitted row.
      }
      return outcome(task.record, message, status, durationMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private deliver(task: InternalTaskState, event: ExecutorStreamEvent): void {
    for (const subscriber of task.subscribers) {
      try { subscriber(event); } catch { /* One disconnected stream must not disrupt the task. */ }
    }
  }

  /** Join a claimed task owned by another executor process without issuing its side effects again.  中文：加入其他执行器已认领的任务，不重复产生副作用。 */
  private async waitForTask(
    taskId: string,
    subscriber?: (event: ExecutorStreamEvent) => void,
  ): Promise<TaskOutcome> {
    let cursor = 0;
    const deadline = performance.now() + this.defaultTimeoutMs + 10_000;
    while (performance.now() < deadline) {
      const page = await this.config.workState.getEvents(taskId, cursor);
      for (const row of page.events) {
        cursor = row.seq;
        if (subscriber) subscriber({ ...row.event, seq: row.seq } as unknown as ExecutorStreamEvent);
      }
      const record = await this.config.workState.getTask(taskId);
      if (!record) throw new Error('Task disappeared from durable work state');
      if (TERMINAL_STATUSES.has(record.status) || record.status === 'waiting_approval' || record.status === 'waiting_input') {
        return outcome(record);
      }
      await delay(250);
    }
    const latest = await this.config.workState.getTask(taskId);
    if (!latest) throw new Error('Task disappeared from durable work state');
    return outcome(latest);
  }

  /** Cancel an active task through the Agent's real cancellation contract.  中文：通过 Agent 正式取消接口终止活动任务。 */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    const message = `Task ${taskId} was cancelled by caller`;
    if (!task) {
      const record = await this.getTask(taskId);
      if (!record || TERMINAL_STATUSES.has(record.status)) return false;
      const endedAt = Date.now();
      const durationMs = endedAt - (record.startedAt ?? record.createdAt);
      try {
        await this.config.workState.patchTask(taskId, {
          status: 'aborted', error: message,
        });
        await this.config.workState.appendEvent(taskId, {
          type: 'error', taskId, message, code: 'TASK_ABORTED', timestamp: endedAt,
        });
        await this.config.workState.appendEvent(taskId, {
          type: 'finish', taskId, status: 'aborted', output: record.output, durationMs, timestamp: endedAt,
        });
        return true;
      } catch {
        return (await this.getTask(taskId))?.status === 'aborted';
      }
    }
    if (TERMINAL_STATUSES.has(task.record.status)) return false;
    task.error = message;
    task.abortController.abort(new Error(message));
    task.agent?.cancel({ kind: 'hook', reason: 'navigator_executor_cancelled' });
    const endedAt = Date.now();
    try {
      await this.patch(task, {
        status: 'aborted', error: message,
      });
      await this.publish(task, {
        type: 'status', taskId, sessionId: task.sessionId, status: 'aborted', timestamp: endedAt,
      });
    } catch {
      // The active agent is still cancelled; durable recovery closes this row if storage is unavailable.
    }
    return true;
  }

  /** Read one current record directly from the durable authority.  中文：直接从持久化权威读取任务。 */
  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    await this.ready;
    return this.config.workState.getTask(taskId);
  }

  /** List records directly from the durable authority.  中文：直接从持久化权威列出任务。 */
  async listTasks(options: { cursor?: string; limit?: number } = {}): Promise<{ items: readonly TaskRecord[]; nextCursor: string | null }> {
    await this.ready;
    return this.config.workState.listTasks(options);
  }

  /** Persist a safe subagent lifecycle fact on the active parent task.  中文：将子 Agent 生命周期事件写入活动父任务。 */
  async recordSubagentEvent(taskId: string, event: ExecutorStreamEvent): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_STATUSES.has(task.record.status)) return;
    await this.publish(task, event);
  }

  /** Resolve the active executor task for one DSH Session, preserving Work Task ownership at tool boundaries.  中文：按 DSH Session 查找活动执行任务，供工具绑定 Work Task authority。 */
  activeTaskId(sessionId: string): string | undefined {
    for (const task of this.tasks.values()) {
      if (task.sessionId === sessionId && task.agent && !TERMINAL_STATUSES.has(task.record.status)) return task.id;
    }
    return undefined;
  }

  /** Launch the authenticated HTTP listener; loopback is the safe default.  中文：启动认证 HTTP listener，默认仅绑定 loopback。 */
  async startServer(port: number, host = '127.0.0.1'): Promise<{ url: string; close: () => Promise<void> }> {
    if (this.httpServer) throw new Error('HTTP server is already running');
    await this.ready;
    const server = createServer((req, res) => { void this.handleHttpRequest(req, res); });
    await new Promise<void>((resolve, reject) => {
      server.listen(port, host, () => resolve());
      server.once('error', reject);
    });
    this.httpServer = server;
    this.drainTimer = setInterval(() => {
      void this.drainQueuedTasks().catch(() => undefined);
    }, 1_000);
    this.drainTimer.unref?.();
    const address = server.address();
    const resolvedPort = typeof address === 'object' && address ? address.port : port;
    const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${resolvedPort}`;
    return {
      url,
      close: async () => {
        if (this.drainTimer) clearInterval(this.drainTimer);
        this.drainTimer = undefined;
        await new Promise<void>(resolve => server.close(() => resolve()));
        this.httpServer = undefined;
      },
    };
  }

  /** Route every task operation through fixed workspace state after bearer authentication.  中文：认证后将任务操作全部路由至固定 Workspace 状态。 */
  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method?.toUpperCase() ?? 'GET';
    this.applyOriginPolicy(req, res);

    if (method === 'OPTIONS') {
      res.writeHead(req.headers.origin && !this.isAllowedOrigin(req.headers.origin) ? 403 : 204);
      res.end();
      return;
    }
    if (method === 'GET' && url.pathname === '/api/v1/health') {
      this.sendJson(res, 200, {
        status: 'ok', service: 'cyrene-navigator-executor', version: '0.2.0-rc.2',
        timestamp: Date.now(),
      });
      return;
    }
    if (!this.isAuthorized(req)) {
      this.sendJson(res, 401, { error: 'Bearer authentication is required' }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }

    try {
      await this.ready;
      if (method === 'GET' && url.pathname === '/api/v1/tasks') {
        const cursor = url.searchParams.get('cursor') ?? undefined;
        const limitValue = url.searchParams.get('limit');
        const limit = limitValue === null ? undefined : Number(limitValue);
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
          this.sendJson(res, 400, { error: 'Invalid task page limit' });
          return;
        }
        this.sendJson(res, 200, await this.listTasks({ cursor, limit }));
        return;
      }
      if (method === 'POST' && url.pathname === '/api/v1/tasks') {
        const body = await this.readJsonBody(req);
        const record = await this.startTask(taskParams(body));
        this.sendJson(res, 202, record);
        return;
      }
      if (method === 'POST' && url.pathname === '/api/v1/tasks/dispatch') {
        const started = await this.drainQueuedTasks();
        this.sendJson(res, 200, { started });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/v1/execute') {
        const body = await this.readJsonBody(req);
        const params = taskParams(body);
        if (body.stream === true || req.headers.accept?.includes('text/event-stream')) {
          this.openEventStream(res);
          const subscriber = (event: ExecutorStreamEvent) => this.writeSseEvent(res, event.seq, event.type, event);
          await this.executeTask(params, subscriber);
          if (!res.writableEnded) res.end();
          return;
        }
        this.sendJson(res, 200, await this.executeTask(params));
        return;
      }

      const eventMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/(?:events|stream)$/u);
      if (method === 'GET' && eventMatch) {
        const taskId = decodeURIComponent(eventMatch[1]!);
        const queryAfter = url.searchParams.get('after');
        const lastEventId = req.headers['last-event-id'];
        const rawAfter = queryAfter ?? (typeof lastEventId === 'string' ? lastEventId : '0');
        const after = Number(rawAfter);
        if (!Number.isSafeInteger(after) || after < 0) {
          this.sendJson(res, 400, { error: 'Invalid event cursor' });
          return;
        }
        if (!await this.getTask(taskId)) {
          this.sendJson(res, 404, { error: 'Task not found' });
          return;
        }
        this.openEventStream(res);
        await this.streamTaskEvents(taskId, after, res);
        if (!res.writableEnded) res.end();
        return;
      }

      const statusMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)(?:\/status)?$/u);
      if (method === 'GET' && statusMatch) {
        const taskId = decodeURIComponent(statusMatch[1]!);
        const record = await this.getTask(taskId);
        this.sendJson(res, record ? 200 : 404, record ?? { error: 'Task not found' });
        return;
      }

      const dispatchMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/dispatch$/u);
      if (method === 'POST' && dispatchMatch) {
        const taskId = decodeURIComponent(dispatchMatch[1]!);
        const task = await this.config.workState.getTask(taskId);
        if (!task) {
          this.sendJson(res, 404, { error: 'Task not found' });
          return;
        }
        if (task.status === 'queued' && !this.tasks.has(taskId)) {
          this.adoptQueuedTask(task, { taskId, sessionId: task.sessionId, prompt: task.prompt });
        }
        this.sendJson(res, 202, task);
        return;
      }

      const cancelMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)(?:\/cancel)?$/u);
      if ((method === 'POST' && cancelMatch && cancelMatch[0].endsWith('/cancel'))
        || (method === 'DELETE' && cancelMatch)) {
        const taskId = decodeURIComponent(cancelMatch![1]!);
        this.sendJson(res, 200, { taskId, cancelled: await this.cancelTask(taskId) });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/v1/plugins') {
        const pluginManager = this.ctx.get('pluginManager') as DynamicPluginManager | undefined;
        this.sendJson(res, 200, { plugins: pluginManager?.listPlugins() ?? [] });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/v1/plugins/reload') {
        const body = await this.readJsonBody(req);
        const pluginManager = this.ctx.get('pluginManager') as DynamicPluginManager | undefined;
        if (!pluginManager) {
          this.sendJson(res, 503, { error: 'Dynamic plugin manager is not enabled' });
          return;
        }
        const result = body.id ? await pluginManager.reloadPlugin(String(body.id)) : await pluginManager.reloadAll();
        this.sendJson(res, 200, body.id ? { reloaded: true, plugin: result } : { reloaded: true, plugins: result });
        return;
      }
      this.sendJson(res, 404, { error: `Not found: ${method} ${url.pathname}` });
    } catch (err: unknown) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      const message = err instanceof Error ? err.message : 'Request failed';
      const status = err instanceof TypeError ? 400 : 500;
      this.sendJson(res, status, { error: message });
    }
  }

  private async streamTaskEvents(taskId: string, after: number, res: ServerResponse): Promise<void> {
    let cursor = after;
    let lastHeartbeat = Date.now();
    let closed = false;
    res.once('close', () => { closed = true; });
    while (!closed && !res.writableEnded) {
      const page = await this.config.workState.getEvents(taskId, cursor);
      for (const row of page.events) {
        const eventType = typeof row.event.type === 'string' ? row.event.type : 'message';
        this.writeSseEvent(res, row.seq, eventType, { ...row.event, seq: row.seq });
        cursor = row.seq;
      }
      const record = await this.config.workState.getTask(taskId);
      if (!record) return;
      if (TERMINAL_STATUSES.has(record.status) && cursor >= page.nextSeq - 1) return;
      if (Date.now() - lastHeartbeat >= 15_000 && !res.writableEnded) {
        res.write(': keep-alive\n\n');
        lastHeartbeat = Date.now();
      }
      await delay(250);
    }
  }

  private openEventStream(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
  }

  private writeSseEvent(res: ServerResponse, seq: number | undefined, type: string, value: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    if (seq !== undefined) res.write(`id: ${seq}\n`);
    res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const token = this.authorizationToken();
    const header = req.headers.authorization;
    if (!token || typeof header !== 'string') return false;
    const match = /^Bearer ([^\s]+)$/u.exec(header);
    if (!match) return false;
    const presented = Buffer.from(match[1]!, 'utf8');
    const expected = Buffer.from(token, 'utf8');
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }

  private authorizationToken(): string | undefined {
    const principalTokenEnv = this.config.authTokenEnv ?? 'CYRENE_SESSION_TOKEN';
    return process.env[principalTokenEnv];
  }

  private isAllowedOrigin(origin: string): boolean {
    return this.config.allowedOrigins?.includes(origin) === true;
  }

  private applyOriginPolicy(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !this.isAllowedOrigin(origin)) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Last-Event-ID');
    res.setHeader('Vary', 'Origin');
  }

  private sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      ...headers,
    });
    res.end(text);
  }

  private readJsonBody(req: IncomingMessage): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      let text = '';
      req.on('data', (chunk: Buffer | string) => {
        text += chunk;
        if (Buffer.byteLength(text) > 1_048_576) reject(new TypeError('Payload too large'));
      });
      req.on('end', () => {
        if (!text) { resolve({}); return; }
        try {
          const value: unknown = JSON.parse(text);
          if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Request body must be an object');
          resolve(value as Record<string, any>);
        } catch (error) {
          reject(error instanceof TypeError ? error : new TypeError('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  private async patch(task: InternalTaskState, patch: Partial<Omit<TaskRecord, 'id' | 'workspaceId' | 'sequence'>>): Promise<void> {
    const next = task.patchChain.then(async () => {
      if (task.patchFailure) throw task.patchFailure;
      task.record = await this.config.workState.patchTask(task.id, patch);
    });
    task.patchChain = next.catch(error => { task.patchFailure ??= error; });
    await next;
  }

  private async flushPatches(task: InternalTaskState): Promise<void> {
    await task.patchChain;
    if (task.patchFailure) throw task.patchFailure;
  }

  private publish(task: InternalTaskState, event: ExecutorStreamEvent): Promise<void> {
    const serialized = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
    const next = task.eventChain.then(async () => {
      if (task.eventFailure) throw task.eventFailure;
      const stored = await this.config.workState.appendEvent(task.id, serialized);
      const delivered = { ...event, seq: stored.seq } as ExecutorStreamEvent;
      for (const subscriber of task.subscribers) {
        try { subscriber(delivered); } catch { /* One disconnected stream must not disrupt the task. */ }
      }
    });
    task.eventChain = next.catch(error => { task.eventFailure ??= error; });
    return task.eventChain;
  }

  private async flushEvents(task: InternalTaskState): Promise<void> {
    await task.eventChain;
    if (task.eventFailure) throw task.eventFailure;
  }

  private extractLatestAssistantText(session: Session): string {
    let result = '';
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(SessionSeq(seq));
      if (event?.type !== 'assistant/message') continue;
      const content = event.data.message.content;
      result = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
      if (result) break;
    }
    return result;
  }

  /** Stop active agent work and release listeners/server resources.  中文：取消活动 Agent 并释放监听器和服务资源。 */
  async dispose(): Promise<void> {
    this.disposeStreamListener?.();
    this.disposeErrorListener?.();
    this.disposeSessionListener?.();
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = undefined;
    const live = [...this.tasks.values()];
    for (const task of live) {
      if (!TERMINAL_STATUSES.has(task.record.status)) {
        task.abortController.abort(new Error('Executor is shutting down'));
        task.agent?.cancel({ kind: 'hook', reason: 'navigator_executor_shutdown' });
      }
    }
    await Promise.allSettled(live.map(task => task.completion).filter((p): p is Promise<TaskOutcome> => p !== undefined));
    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = undefined;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    this.tasks.clear();
    this.agentTaskMap.clear();
    this.sessionTaskMap.clear();
  }
}

function stateFromRecord(record: TaskRecord): InternalTaskState {
  return {
    id: record.id, sessionId: record.sessionId, prompt: record.prompt, record,
    output: record.output, reasoning: record.reasoning, abortController: new AbortController(),
    subscribers: new Set(), eventChain: Promise.resolve(), patchChain: Promise.resolve(),
  };
}

function outcome(record: TaskRecord, error?: string, status?: TaskStatus, durationMs?: number): TaskOutcome {
  const resolvedError = error ?? record.error;
  return {
    taskId: record.id, sessionId: record.sessionId, status: status ?? record.status,
    output: record.output, reasoning: record.reasoning,
    ...(resolvedError === undefined ? {} : { error: resolvedError }),
    durationMs: durationMs ?? record.durationMs,
  };
}

function safeErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message.slice(0, 2_000);
  if (typeof value === 'string') return value.slice(0, 2_000);
  return 'Agent execution failed';
}

function abortMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Task was aborted';
}

function taskParams(body: Record<string, any>): ExecuteTaskParams {
  if (typeof body.prompt !== 'string' || body.prompt.length === 0) throw new TypeError('Missing or invalid "prompt" parameter');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new TypeError('Invalid "stream" parameter');
  for (const key of ['taskId', 'sessionId', 'cwd', 'agentPreset'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'string') throw new TypeError(`Invalid "${key}" parameter`);
  }
  if (body.timeoutMs !== undefined && (!Number.isSafeInteger(body.timeoutMs) || body.timeoutMs <= 0)) {
    throw new TypeError('Invalid "timeoutMs" parameter');
  }
  return {
    prompt: body.prompt,
    ...(body.taskId === undefined ? {} : { taskId: body.taskId }),
    ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
    ...(body.cwd === undefined ? {} : { cwd: body.cwd }),
    ...(body.agentPreset === undefined ? {} : { agentPreset: body.agentPreset }),
    ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
    stream: body.stream === true,
  };
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

export const name = 'cyrene-executor';
export const inject = ['agents', 'sessions', 'agentDefaultModel'];

export function apply(ctx: Context, config: ExecutorConfig): void {
  const executor = new NavigatorExecutor(ctx, config);
  ctx.provide('executor', executor);
  ctx.effect(() => () => executor.dispose());
  if (config.port !== undefined) void executor.startServer(config.port, config.host);
}

declare module '@deepseek-ai/cordis' {
  interface Context { executor: NavigatorExecutor; }
  interface Events {
    'agent/assistant-stream'(payload: { agent: Agent; frame: any }): void;
    'agent/error'(payload: { agent: Agent; error: unknown }): void;
    'session/event'(session: Session, event: SessionEvent): void;
  }
}
