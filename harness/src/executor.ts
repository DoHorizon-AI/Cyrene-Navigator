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
import { WorkStateHttpError } from './work-state-client.js';
import type { ExecutionStatus, TaskRecord, WorkStateStore } from './work-state-client.js';
import type { ExchangeAuthorizationWaitReceipt } from './integrations/exchange-authorization.js';

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
  | { type: 'subagent-blocked'; taskId: string; provider: string; runId: string; reasonCode: 'SANDBOX_BOUNDARY_DENIED' | 'SANDBOX_PROFILE_UNAVAILABLE' | 'SANDBOX_MODE_UNVERIFIED' | 'SUBAGENT_TIMEOUT' | 'SUBAGENT_FAILED'; toolCategory: 'file' | 'command' | 'network' | 'other' | 'unknown'; count: number; timestamp: number; seq?: number }
  | { type: 'permission'; taskId: string; provider: string; tool?: string; decision: 'approved' | 'denied'; timestamp: number; seq?: number }
  | { type: 'authorization-required'; taskId: string; code: string; source: string; callId?: string; connectionId?: string; authorizationRef?: string; generation?: number; timestamp: number; seq?: number }
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
  blocked?: Map<string, Extract<ExecutorStreamEvent, { type: 'subagent-blocked' }>>;
  authorizationWaits?: Map<string, ExchangeAuthorizationWaitReceipt>;
  agentError?: string;
  error?: string;
  agent?: Agent;
  authorizationPause?: boolean;
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
  readonly revalidateExchangeAuthorization?: (
    sessionId: string,
    connectionId: string,
  ) => Promise<{
    readonly connectionId: string;
    readonly authorizationRef: string | null;
    readonly loginState: string;
    readonly authorizationState: string;
    readonly generation: number;
  }>;
  readonly readExchangeOperationState?: (
    sessionId: string,
    operationId: string,
  ) => Promise<string>;
}

class ExecutorRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ExecutorRequestError';
  }
}

const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'aborted']);
const INTERRUPTED_STATUSES = new Set<TaskStatus>(['running', 'waiting_approval', 'waiting_input']);
const PAUSED_STATUSES = new Set<TaskStatus>(['waiting_approval', 'waiting_input', 'awaiting_user_authorization']);
const SAFE_CONTINUATION_TOOLS = new Set([
  'work_memory_search',
  'work_sources',
  'exchange_connections_list',
  'exchange_issue_query',
  'exchange_operation_read',
  'exchange_authorization_health',
  'exchange_reauthorization_status',
  'exchange_cloud_resources_query',
  'gcloud_readonly',
]);
const EXCHANGE_MUTATING_TOOLS = new Set([
  'exchange_issue_comment',
  'exchange_issue_state_update',
  'exchange_reauthorization_start',
]);

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
      if (!task || (task.record.status !== 'running' && task.record.status !== 'awaiting_user_authorization')) return;
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
        if (row.status === 'awaiting_user_authorization') {
          const events = await this.readAllTaskEvents(row.id);
          const hasPauseFinish = events.some(item => item.event.type === 'finish'
            && item.event.status === 'awaiting_user_authorization');
          if (!hasPauseFinish) {
            const now = Date.now();
            await this.config.workState.appendEvent(row.id, {
              type: 'finish',
              taskId: row.id,
              status: 'awaiting_user_authorization',
              output: row.output,
              durationMs: Math.max(row.durationMs, now - (row.startedAt ?? row.createdAt)),
              timestamp: now,
            });
          }
          continue;
        }
        if (INTERRUPTED_STATUSES.has(row.status)) {
          const now = Date.now();
          const startedAt = row.startedAt ?? row.createdAt;
          const reason = row.status === 'running'
            ? 'Execution interrupted by executor restart; automatic replay is disabled.'
            : 'Human-gated execution was interrupted by executor restart; review the preserved approval record before creating a new task.';
          const blocked = await this.readBlockedReceipts(row.id);
          const output = appendBlockedSummary(row.output, blocked);
          await this.config.workState.patchTask(row.id, { status: 'failed', error: reason, output });
          await this.config.workState.appendEvent(row.id, {
            type: 'error', taskId: row.id, message: reason, code: 'EXECUTOR_RESTARTED', timestamp: now,
          });
          await this.config.workState.appendEvent(row.id, {
            type: 'finish', taskId: row.id, status: 'failed', output,
            durationMs: Math.max(row.durationMs, now - startedAt), timestamp: now,
          });
        }
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }

  /** Restore refused work from ordered receipts without replaying native operations. | 从事件恢复无法执行记录，不重放原生操作。 */
  private async readBlockedReceipts(taskId: string): Promise<InternalTaskState['blocked']> {
    const blocked: NonNullable<InternalTaskState['blocked']> = new Map();
    let after = 0;
    for (;;) {
      const page = await this.config.workState.getEvents(taskId, after);
      for (const row of page.events) {
        const value = row.event;
        if (value.type !== 'subagent-blocked' || value.taskId !== taskId
          || typeof value.provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value.provider)
          || typeof value.runId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/u.test(value.runId)
          || !['SANDBOX_BOUNDARY_DENIED', 'SANDBOX_PROFILE_UNAVAILABLE', 'SANDBOX_MODE_UNVERIFIED', 'SUBAGENT_TIMEOUT', 'SUBAGENT_FAILED'].includes(String(value.reasonCode))
          || !['file', 'command', 'network', 'other', 'unknown'].includes(String(value.toolCategory))
          || typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 1) continue;
        const receipt = value as unknown as Extract<ExecutorStreamEvent, { type: 'subagent-blocked' }>;
        blocked.set(`${receipt.provider}:${receipt.runId}:${receipt.reasonCode}:${receipt.toolCategory}`, receipt);
      }
      const last = page.events.at(-1)?.seq;
      if (last === undefined || last <= after) break;
      after = last;
    }
    return blocked;
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
    let disposeContinuationGuard: (() => void) | undefined;
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
      task.blocked = await this.readBlockedReceipts(task.id);
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
      if (isReadOnlyContinuation(task.record)) {
        // Agent-scoped guards are inherited by child-agent contexts, without blocking unrelated sessions.
        disposeContinuationGuard = agent.ctx.tools.guard(execution => {
          if (SAFE_CONTINUATION_TOOLS.has(execution.name)) return undefined;
          return 'This authorization continuation is read-only; start a separately approved task for writes.';
        });
      }
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
      if (PAUSED_STATUSES.has(task.record.status)) {
        if (task.blocked?.size) await this.patch(task, { output: appendBlockedSummary(task.output, task.blocked) });
        const pausedAt = Date.now();
        await this.publish(task, {
          type: 'finish', taskId: task.id, status: task.record.status,
          output: task.record.output, durationMs: Math.max(0, pausedAt - (task.record.startedAt ?? task.record.createdAt)),
          timestamp: pausedAt,
        });
        await this.flushEvents(task);
        return outcome(task.record);
      }
      if (TERMINAL_STATUSES.has(task.record.status)) return outcome(task.record);

      if (!task.output) task.output = this.extractLatestAssistantText(agent.session);
      const finishedAt = Date.now();
      const isAborted = task.abortController.signal.aborted;
      // Let the agent finish all remaining work before reporting partial failure.
      // 中文：先完成其余可执行工作，再汇总无法执行项并记录部分失败。
      task.output = appendBlockedSummary(task.output, task.blocked);
      const hasBlocked = (task.blocked?.size ?? 0) > 0;
      const status: TaskStatus = isAborted ? 'aborted' : task.agentError || hasBlocked ? 'failed' : 'completed';
      const error = task.error ?? task.agentError ?? (isAborted ? 'Task was cancelled'
        : hasBlocked ? '部分子任务无法执行；已继续完成其余可执行工作，详见结果中的无法执行项。' : undefined);
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
      const awaitingAuthorization = !isAborted
        && (task.authorizationPause || task.record.status === 'awaiting_user_authorization');
      const status: TaskStatus = isAborted ? 'aborted' : awaitingAuthorization ? 'awaiting_user_authorization' : 'failed';
      const message = task.error ?? (awaitingAuthorization
        ? task.record.error ?? 'Exchange connection authorization is required. Progress is preserved and automatic replay is disabled.'
        : isAborted ? abortMessage(task.abortController.signal.reason) : safeErrorMessage(err));
      const durationMs = endedAt - (task.record.startedAt ?? task.record.createdAt);
      task.output ||= task.agent ? this.extractLatestAssistantText(task.agent.session) : '';
      task.output = appendBlockedSummary(task.output, task.blocked);
      try {
        // Close a failed write chain with an independent terminal reconciliation.
        // 中文：写入链失败后，独立尝试持久化失败终态，避免把执行成功写入事件。
        await task.patchChain;
        task.record = await this.config.workState.patchTask(task.id, {
          status, output: task.output, reasoning: task.reasoning, error: message,
        });
        if (!awaitingAuthorization) {
          await this.publish(task, {
            type: 'error', taskId: task.id, message,
            code: isAborted ? 'TASK_ABORTED' : 'EXECUTION_FAILED', timestamp: endedAt,
          });
        }
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
      disposeContinuationGuard?.();
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
      if (TERMINAL_STATUSES.has(record.status) || PAUSED_STATUSES.has(record.status)) {
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

  /** Persist an exact Exchange reauthorization wait and stop this DSH turn at the tool boundary. */
  async markTaskAwaitingUserAuthorization(
    sessionId: string,
    receipt: ExchangeAuthorizationWaitReceipt,
  ): Promise<boolean> {
    if (receipt.code !== 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED') {
      throw new TypeError('Exchange authorization wait reason is invalid');
    }
    for (const value of [receipt.connectionId, receipt.authorizationRef]) {
      if (value !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/u.test(value)) {
        throw new TypeError('Exchange authorization wait reference is invalid');
      }
    }
    if (receipt.callId !== undefined && !/^[A-Za-z0-9._:-]{1,200}$/u.test(receipt.callId)) {
      throw new TypeError('Exchange authorization call reference is invalid');
    }
    if (receipt.generation !== undefined && (!Number.isSafeInteger(receipt.generation) || receipt.generation < 0)) {
      throw new TypeError('Exchange authorization generation is invalid');
    }
    const taskId = this.activeTaskId(sessionId);
    const task = taskId === undefined ? undefined : this.tasks.get(taskId);
    if (!task || (task.record.status !== 'running' && task.record.status !== 'awaiting_user_authorization')) return false;

    const key = (receipt.connectionId ?? '') + '\0' + (receipt.authorizationRef ?? '')
      + '\0' + (receipt.callId ?? '');
    task.authorizationWaits ??= new Map();
    if (task.authorizationWaits.has(key)) return true;
    task.authorizationPause = true;
    try {
      await this.flushPatches(task);
      if (task.record.status === 'running') {
        const timestamp = Date.now();
        await this.patch(task, {
          status: 'awaiting_user_authorization',
          error: 'Exchange connection authorization is required. Progress is preserved and automatic replay is disabled.',
        });
        await this.publish(task, {
          type: 'status', taskId: task.id, sessionId: task.sessionId,
          status: 'awaiting_user_authorization', timestamp,
        });
      }
      task.authorizationWaits.set(key, receipt);
      await this.publish(task, {
        type: 'authorization-required',
        taskId: task.id,
        code: receipt.code,
        source: receipt.source,
        ...(receipt.callId === undefined ? {} : { callId: receipt.callId }),
        ...(receipt.connectionId === undefined ? {} : { connectionId: receipt.connectionId }),
        ...(receipt.authorizationRef === undefined ? {} : { authorizationRef: receipt.authorizationRef }),
        ...(receipt.generation === undefined ? {} : { generation: receipt.generation }),
        timestamp: Date.now(),
      });
      await this.flushEvents(task);
    } catch (error: unknown) {
      task.authorizationPause = false;
      task.error = 'Exchange authorization wait could not be persisted safely.';
      task.abortController.abort(new Error(task.error));
      task.agent?.cancel({ kind: 'hook', reason: 'exchange_authorization_wait_persist_failed' });
      throw error;
    }
    task.agent?.cancel({ kind: 'hook', reason: 'exchange_reauthorization_required' });
    return true;
  }

  /** Create a new read-only task only after exact Exchange authorization and prior writes revalidate. */
  async resumeTask(taskId: string, prompt: string, idempotencyKey: string): Promise<TaskRecord> {
    await this.ready;
    if (!prompt.trim() || prompt.length > 20_000) {
      throw new ExecutorRequestError(400, 'CONTINUATION_PROMPT_INVALID', 'A bounded new continuation prompt is required.');
    }
    if (!/^[\x21-\x7e]{1,200}$/u.test(idempotencyKey)) {
      throw new ExecutorRequestError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A bounded Idempotency-Key is required.');
    }
    const source = await this.config.workState.getTask(taskId);
    if (!source) throw new ExecutorRequestError(404, 'TASK_NOT_FOUND', 'Task not found.');
    if (source.status !== 'awaiting_user_authorization') {
      throw new ExecutorRequestError(409, 'TASK_NOT_AWAITING_USER_AUTHORIZATION', 'Task is not waiting for user authorization.');
    }

    const events = await this.readAllTaskEvents(taskId);
    const pauseFinished = events.some(row => row.event.type === 'finish'
      && row.event.status === 'awaiting_user_authorization');
    if (!pauseFinished || this.tasks.has(taskId)) {
      throw new ExecutorRequestError(409, 'TASK_TURN_NOT_SETTLED', 'The paused task turn has not settled yet.');
    }
    try {
      // Verify the Work bearer owns this source before using its stored DSH session identity with Exchange.
      await this.config.workState.verifyContinuationOwnership(taskId);
    } catch (error: unknown) {
      if (error instanceof WorkStateHttpError) {
        if (error.status === 404 && error.code === 'WORK_TASK_NOT_FOUND') {
          throw new ExecutorRequestError(404, 'TASK_NOT_FOUND', 'Task not found.');
        }
        if (error.status === 404) {
          throw new ExecutorRequestError(503, 'SAFE_CONTINUATION_UNAVAILABLE', 'Work service does not support safe task continuation.');
        }
        throw new ExecutorRequestError(error.status, error.code, error.message);
      }
      throw error;
    }
    const waits = authorizationWaitReceipts(events);
    if (waits.length === 0 || waits.some(receipt =>
      !receipt.connectionId || !receipt.authorizationRef || receipt.generation === undefined)) {
      throw new ExecutorRequestError(
        409, 'AUTHORIZATION_TARGET_UNAVAILABLE',
        'The task has no complete server-derived connection authorization target to revalidate.',
      );
    }
    if (!this.config.revalidateExchangeAuthorization) {
      throw new ExecutorRequestError(503, 'AUTHORIZATION_REVALIDATION_UNAVAILABLE', 'Exchange authorization revalidation is unavailable.');
    }

    const revalidated = new Map<string, { connectionId: string; authorizationRef: string; generation: number }>();
    for (const receipt of waits) {
      const connectionId = receipt.connectionId!;
      const authorizationRef = receipt.authorizationRef!;
      let health: Awaited<ReturnType<NonNullable<ExecutorConfig['revalidateExchangeAuthorization']>>>;
      try {
        health = await this.config.revalidateExchangeAuthorization(source.sessionId, connectionId);
      } catch {
        throw new ExecutorRequestError(409, 'AUTHORIZATION_REVALIDATION_FAILED', 'Current Exchange authorization could not be verified.');
      }
      if (health.connectionId !== connectionId || health.authorizationRef !== authorizationRef
        || health.loginState !== 'PRESENT' || health.authorizationState !== 'VALID'
        || health.generation <= receipt.generation!) {
        throw new ExecutorRequestError(409, 'AUTHORIZATION_NOT_READY', 'Exchange authorization or generation is not ready for continuation.');
      }
      revalidated.set(connectionId, { connectionId, authorizationRef, generation: health.generation });
    }

    await this.assertNoUnresolvedExchangeWrites(source.sessionId, events, waits);
    let continuation: TaskRecord;
    try {
      continuation = await this.config.workState.createContinuationTask(taskId, { prompt, idempotencyKey });
    } catch (error: unknown) {
      if (error instanceof WorkStateHttpError) {
        if (error.status === 404) {
          throw new ExecutorRequestError(503, 'SAFE_CONTINUATION_UNAVAILABLE', 'Work service does not support safe task continuation.');
        }
        throw new ExecutorRequestError(error.status, error.code, error.message);
      }
      throw error;
    }
    if (continuation.continuationOfTaskId !== taskId || !isReadOnlyContinuation(continuation)) {
      throw new ExecutorRequestError(503, 'SAFE_CONTINUATION_UNAVAILABLE', 'Work service did not create the required read-only continuation marker.');
    }
    await this.config.workState.appendEvent(continuation.id, {
      type: 'task.authorization_revalidated',
      sourceTaskId: taskId,
      connections: [...revalidated.values()],
    });
    return continuation;
  }

  /** Read a bounded durable event history for one continuation decision. */
  private async readAllTaskEvents(taskId: string): Promise<Awaited<ReturnType<WorkStateStore['getEvents']>>['events']> {
    const events: Awaited<ReturnType<WorkStateStore['getEvents']>>['events'][number][] = [];
    let cursor = 0;
    for (;;) {
      const page = await this.config.workState.getEvents(taskId, cursor);
      events.push(...page.events);
      if (events.length > 100_000) {
        throw new ExecutorRequestError(409, 'TASK_EVIDENCE_LIMIT_EXCEEDED', 'Task evidence is too large to revalidate safely.');
      }
      const last = page.events.at(-1)?.seq;
      if (last === undefined || last <= cursor) return events;
      cursor = last;
    }
  }

  /** Reconcile every prior Exchange mutation or leave the continuation manual. */
  private async assertNoUnresolvedExchangeWrites(
    sessionId: string,
    events: Awaited<ReturnType<WorkStateStore['getEvents']>>['events'],
    waits: readonly ExchangeAuthorizationWaitReceipt[],
  ): Promise<void> {
    const calls = new Map<string, string>();
    const results = new Map<string, { readonly isError: boolean; readonly result: string }>();
    for (const row of events) {
      const event = row.event;
      if (event.type === 'tool-call' && typeof event.callId === 'string' && typeof event.tool === 'string') {
        calls.set(event.callId, event.tool);
      } else if (event.type === 'tool-result' && typeof event.callId === 'string'
        && typeof event.result === 'string') {
        results.set(event.callId, { isError: event.isError === true, result: event.result });
      }
    }
    const confirmedAuthCalls = new Set(waits
      .filter(receipt => receipt.source === 'issue-action' && receipt.callId !== undefined)
      .map(receipt => receipt.callId!));

    for (const [callId, tool] of calls) {
      if (!EXCHANGE_MUTATING_TOOLS.has(tool)) continue;
      const result = results.get(callId);
      if (!result) {
        if (confirmedAuthCalls.has(callId)) continue;
        throw new ExecutorRequestError(409, 'EXCHANGE_WRITE_UNRESOLVED', 'A prior Exchange write has no durable outcome and needs manual reconciliation.');
      }
      if (result.isError) {
        if (confirmedAuthCalls.has(callId) || resultIsConfirmedAuthWait(result.result)) continue;
        throw new ExecutorRequestError(409, 'EXCHANGE_WRITE_UNRESOLVED', 'A prior Exchange write failed without a reconciled outcome.');
      }
      const value = parseJsonObject(result.result);
      if (resultIsConfirmedAuthWait(result.result)) continue;
      if (tool === 'exchange_reauthorization_start') {
        if (typeof value.sessionRef !== 'string'
          || !['WAITING_USER', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(String(value.state))) {
          throw new ExecutorRequestError(409, 'EXCHANGE_RENEWAL_UNRESOLVED', 'A prior renewal session has no durable outcome.');
        }
        if (value.state === 'VERIFYING') {
          throw new ExecutorRequestError(409, 'EXCHANGE_RENEWAL_UNKNOWN', 'A prior renewal session has an unknown start outcome and needs manual reconciliation.');
        }
        continue;
      }
      if (typeof value.operationId !== 'string' || typeof value.state !== 'string') {
        throw new ExecutorRequestError(409, 'EXCHANGE_WRITE_UNRESOLVED', 'A prior Exchange write has no operation reference to reconcile.');
      }
      let state = value.state;
      if (!isTerminalExchangeOperationState(state)) {
        if (!this.config.readExchangeOperationState) {
          throw new ExecutorRequestError(409, 'EXCHANGE_WRITE_UNRESOLVED', 'Exchange operation reconciliation is unavailable.');
        }
        try {
          state = await this.config.readExchangeOperationState(
            sessionId,
            value.operationId,
          );
        } catch {
          throw new ExecutorRequestError(409, 'EXCHANGE_WRITE_UNRESOLVED', 'Exchange operation could not be reconciled.');
        }
      }
      if (!isTerminalExchangeOperationState(state)) {
        throw new ExecutorRequestError(409, state === 'UNKNOWN' ? 'EXCHANGE_WRITE_UNKNOWN' : 'EXCHANGE_WRITE_IN_FLIGHT',
          'A prior Exchange write remains unresolved and needs manual reconciliation.');
      }
    }
  }

  /** Persist a safe subagent lifecycle fact on the active parent task.  中文：将子 Agent 生命周期事件写入活动父任务。 */
  async recordSubagentEvent(taskId: string, event: ExecutorStreamEvent): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_STATUSES.has(task.record.status)) return;
    if (event.type === 'subagent-blocked') {
      task.blocked ??= new Map();
      // Group by run/category; native observation counts may include duplicate notices.
      const key = `${event.provider}:${event.runId}:${event.reasonCode}:${event.toolCategory}`;
      task.blocked.set(key, event);
    }
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

      const resumeMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/resume$/u);
      if (method === 'POST' && resumeMatch) {
        const taskId = decodeURIComponent(resumeMatch[1]!);
        const idempotencyKey = req.headers['idempotency-key'];
        if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,200}$/u.test(idempotencyKey)) {
          throw new ExecutorRequestError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A bounded Idempotency-Key is required.');
        }
        const body = await this.readJsonBody(req);
        if (Object.keys(body).some(key => key !== 'prompt')
          || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 20_000) {
          throw new ExecutorRequestError(400, 'CONTINUATION_PROMPT_INVALID', 'A bounded new continuation prompt is required.');
        }
        const continuation = await this.resumeTask(taskId, body.prompt, idempotencyKey);
        this.sendJson(res, 202, continuation);
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
      if (err instanceof ExecutorRequestError) {
        this.sendJson(res, err.status, { code: err.code, error: err.message });
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
      let pausedTurnFinished = false;
      for (const row of page.events) {
        const eventType = typeof row.event.type === 'string' ? row.event.type : 'message';
        this.writeSseEvent(res, row.seq, eventType, { ...row.event, seq: row.seq });
        if (row.event.type === 'finish' && PAUSED_STATUSES.has(row.event.status as TaskStatus)) {
          pausedTurnFinished = true;
        }
        cursor = row.seq;
      }
      if (pausedTurnFinished) return;
      const record = await this.config.workState.getTask(taskId);
      if (!record) return;
      if (TERMINAL_STATUSES.has(record.status) && cursor >= page.nextSeq - 1) return;
      if (PAUSED_STATUSES.has(record.status) && !this.tasks.has(taskId) && cursor >= page.nextSeq - 1) return;
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Last-Event-ID, Idempotency-Key');
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

/** Append trusted receipts even when model prose omits an unavailable operation. | 即使模型未提及，也追加可信的无法执行记录。 */
function appendBlockedSummary(output: string, blocked: InternalTaskState['blocked']): string {
  if (!blocked?.size) return output;
  const categories: Record<string, string> = { file: '文件操作', command: '终端命令', network: '网络操作', other: '工具操作', unknown: '操作' };
  const rows = [...blocked.values()].map(receipt => {
    const reason = receipt.reasonCode === 'SANDBOX_BOUNDARY_DENIED' ? '超出沙箱或授权边界，无法执行'
      : receipt.reasonCode === 'SANDBOX_PROFILE_UNAVAILABLE' ? '沙箱配置未通过校验，无法执行'
      : receipt.reasonCode === 'SANDBOX_MODE_UNVERIFIED' ? '原生 CLI 未声明所要求的沙箱授权模式，无法执行'
      : receipt.reasonCode === 'SUBAGENT_TIMEOUT' ? '原生 CLI 响应超时，无法执行'
      : '原生子代理执行失败，无法完成';
    return `- ${receipt.provider} / ${receipt.runId}：${categories[receipt.toolCategory] ?? '操作'}，${reason}（${receipt.reasonCode}）。`;
  });
  const suffix = `\n\n无法执行项（原生执行记录；已完成内容保留在上文）：\n${rows.join('\n')}`;
  return output.endsWith(suffix) ? output : `${output}${suffix}`;
}

function stateFromRecord(record: TaskRecord): InternalTaskState {
  return {
    id: record.id, sessionId: record.sessionId, prompt: record.prompt, record,
    output: record.output, reasoning: record.reasoning, abortController: new AbortController(),
    subscribers: new Set(), eventChain: Promise.resolve(), patchChain: Promise.resolve(),
  };
}

/** Treat an explicit persisted marker or server-reserved ID prefix as read-only. */
function isReadOnlyContinuation(record: TaskRecord): boolean {
  return record.continuationMode === 'read_only' || record.id.startsWith('continuation-');
}

/** Recover only stable, server-derived Exchange authorization wait fields. */
function authorizationWaitReceipts(
  events: readonly { readonly event: Record<string, unknown> }[],
): ExchangeAuthorizationWaitReceipt[] {
  const unique = new Map<string, ExchangeAuthorizationWaitReceipt>();
  for (const row of events) {
    const event = row.event;
    if (event.type !== 'authorization-required'
      || event.code !== 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED'
      || !['authorization-health', 'connection-resources', 'issue-action'].includes(String(event.source))) continue;
    const receipt: ExchangeAuthorizationWaitReceipt = {
      code: 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED',
      source: event.source as ExchangeAuthorizationWaitReceipt['source'],
      ...(typeof event.callId === 'string' ? { callId: event.callId } : {}),
      ...(typeof event.connectionId === 'string' ? { connectionId: event.connectionId } : {}),
      ...(typeof event.authorizationRef === 'string' ? { authorizationRef: event.authorizationRef } : {}),
      ...(typeof event.generation === 'number' ? { generation: event.generation } : {}),
    };
    const key = (receipt.connectionId ?? '') + '\0' + (receipt.authorizationRef ?? '')
      + '\0' + (receipt.callId ?? '');
    const previous = unique.get(key);
    if (previous === undefined || (receipt.generation ?? -1) > (previous.generation ?? -1)) {
      unique.set(key, receipt);
    }
  }
  return [...unique.values()];
}

/** Parse one rendered tool result without trusting non-JSON text. */
function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The caller treats an unreadable receipt as unresolved and requires manual review.
  }
  return {};
}

function resultIsConfirmedAuthWait(value: string): boolean {
  const parsed = parseJsonObject(value);
  return parsed.status === 'awaiting_user_authorization'
    && parsed.code === 'EXCHANGE_CONNECTION_REAUTHORIZATION_REQUIRED';
}

function isTerminalExchangeOperationState(state: string): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED';
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
