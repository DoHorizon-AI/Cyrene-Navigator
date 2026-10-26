// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Headless Cloud Executor Daemon                    │
// │ Role: Execute authenticated, durable tasks over REST and SSE.       │
// │ 模块职责：通过 REST/SSE 执行经过认证且持久化的任务。                    │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { brandString } from '@deepseek-ai/dsh-brand';
import type { Agent, AgentOptions, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { DynamicPluginManager } from './plugin-manager.js';
import { WorkStateHttpError } from './work-state-client.js';
import type { CredentialHealthSnapshot, ExecutionStatus, TaskRecord, WorkStateStore } from './work-state-client.js';
import type { ExchangeAuthorizationWaitReceipt } from './integrations/exchange-authorization.js';
import {
  ExchangeConnectorAuthorizationClient,
  ExchangeConnectorRequestError,
  canonicalJson,
  sha256,
  teamsThreadResourceRef,
  validateTeamsServiceUrl,
} from './connector-authorization.ts';
import type { ConnectorGrantRequest, TeamsMessageRoute } from './connector-authorization.ts';
import {
  decodeProviderTokenUsage,
  isModelAvailabilityFailure,
  modelRouteKey,
  nextFallbackRoute,
} from './model-policy.js';
import type { ModelRoute } from './model-policy.js';
import type { ConversationExecutionBackend } from './codebuddy-acp-execution.js';

export type TaskStatus = ExecutionStatus;
export type TaskExecutionClass = 'foreground' | 'background';

export interface ExecuteTaskParams {
  readonly prompt: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly agentPreset?: string;
  readonly timeoutMs?: number;
  readonly stream?: boolean;
  /** Host-only scheduling class; the public REST parser always chooses foreground. */
  readonly executionClass?: TaskExecutionClass;
  /** Host-owned provenance and policy facts persisted with the Work Task. */
  readonly metadata?: Readonly<Record<string, unknown>>;
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
  | { type: 'model-route'; taskId: string; provider: string; model: string; timestamp: number; seq?: number }
  | { type: 'model-usage'; taskId: string; provider: string; model: string; usage: TokenUsage; timestamp: number; seq?: number }
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

/** Provider-reported usage aggregated by the actual provider/model route. */
export interface TaskModelUsageRoute {
  readonly provider: string;
  readonly model: string;
  readonly reportedCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
}

export interface TaskModelUsageSnapshot {
  readonly taskId: string;
  readonly routes: readonly TaskModelUsageRoute[];
}

interface InternalTaskState {
  readonly id: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly executionClass: TaskExecutionClass;
  readonly abortController: AbortController;
  readonly subscribers: Set<(event: ExecutorStreamEvent) => void>;
  record: TaskRecord;
  output: string;
  reasoning: string;
  blocked?: Map<string, Extract<ExecutorStreamEvent, { type: 'subagent-blocked' }>>;
  authorizationWaits?: Map<string, ExchangeAuthorizationWaitReceipt>;
  authorizationPauseController?: AbortController;
  agentError?: string;
  error?: string;
  agent?: Agent;
  modelSelection?: ModelSelectionRef;
  modelRoute?: ModelSelection;
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
  readonly maxConcurrentTasks?: number;
  /** Real configured provider routes to use only after a provider availability failure. */
  readonly modelFallbacks?: readonly ModelRoute[];
  readonly workState: WorkStateStore;
  /** Optional top-level conversation engine; omission preserves the DSH AgentLoop backend. */
  readonly conversationBackend?: ConversationExecutionBackend;
  readonly workspaceId: string;
  readonly authTokenEnv?: string;
  readonly allowedOrigins?: readonly string[];
  readonly teams?: TeamsExecutorConfig;
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

/** Process-local drain state; durable queued rows remain in the Work service. */
export interface ExecutorDrainStatus {
  readonly mode: 'accepting' | 'draining';
  readonly instanceId: string;
  readonly generation: number;
  readonly token: string | null;
  readonly startedAt: number | null;
  readonly countsComplete: boolean;
  /** Durable Work Task rows that have been claimed and remain running. */
  readonly activeTasks: number;
  /** Durable Work Task rows that have not been claimed. */
  readonly queuedTasks: number;
  readonly dispatches: {
    readonly active: number;
    readonly waiting: number;
  };
  readonly notifications: {
    readonly configured: boolean;
    readonly pollingPaused: boolean;
    readonly inFlight: boolean;
  };
  /** True when this process has no active task/claim or notification delivery to finish. */
  readonly activeWorkDrained: boolean;
}

/** Verified transport policy and Exchange route for the built-in Teams bridge. */
export interface TeamsExecutorConfig {
  readonly connectorId: string;
  readonly tenantId: string;
  readonly allowedTeamIds: readonly string[];
  readonly botAppId: string;
  readonly taskActorSubjects: readonly string[];
  readonly taskActorSubjectsFile?: string;
  readonly ingressSecretEnv: string;
  readonly exchangeConnectionRef: string;
  readonly exchangeProfileRef: string;
  readonly exchangeAuthorization: ExchangeConnectorAuthorizationClient;
  readonly credentialNotifications?: CredentialNotificationsConfig;
}

/** Fixed host-owned health selectors and the only Teams route for credential notices. */
export interface CredentialNotificationsConfig {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly owner: {
    readonly issuer: string;
    readonly subject: string;
    readonly tenantId: string;
  };
  readonly connections: readonly { readonly connectionId: string; readonly provider: CredentialHealthSnapshot['provider'] }[];
  readonly destination: TeamsMessageRoute;
  readonly exchangeProfileRef: string;
  readonly pollIntervalMs: number;
}

class ExecutorRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ExecutorRequestError';
  }
}

/** Stop an unclaimed dispatch while preserving its durable queued row. */
class TaskDispatchPausedError extends Error {
  constructor() {
    super('Executor is draining; task remains queued');
    this.name = 'TaskDispatchPausedError';
  }
}

const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'aborted']);
/** Bound Work-state refresh frequency while waiting for drain completion. */
const DRAIN_STATUS_POLL_INTERVAL_MS = 500;
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

interface TaskWaiter {
  readonly executionClass: TaskExecutionClass;
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}

/** Bound active work, keep one background lane, and schedule foreground waiters first. */
class TaskConcurrencyLimiter {
  private active = 0;
  private activeForeground = 0;
  private activeBackground = 0;
  private draining = false;
  private readonly waiting: TaskWaiter[] = [];
  private readonly foregroundMaximum: number;
  private readonly backgroundMaximum = 1;

  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 2 || maximum > 32) {
      throw new TypeError('maxConcurrentTasks must be between 2 and 32');
    }
    this.foregroundMaximum = Math.max(1, maximum - this.backgroundMaximum);
  }

  async run<T>(executionClass: TaskExecutionClass, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    await this.acquire(executionClass, signal);
    try {
      return await action();
    } finally {
      this.release(executionClass);
    }
  }

  /** Stop dispatch and release every unclaimed waiter back to durable queued state. */
  beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(new TaskDispatchPausedError());
    }
  }

  /** Resume existing capacity scheduling after a matching drain token is presented. */
  resume(): void {
    if (!this.draining) return;
    this.draining = false;
    this.drain();
  }

  /** Recheck immediately before the durable Work claim, including a pre-drain slot reservation. */
  assertDispatchAllowed(): void {
    if (this.draining) throw new TaskDispatchPausedError();
  }

  snapshot(): { readonly active: number; readonly waiting: number; readonly draining: boolean } {
    return { active: this.active, waiting: this.waiting.length, draining: this.draining };
  }

  private acquire(executionClass: TaskExecutionClass, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.draining) return Promise.reject(new TaskDispatchPausedError());
    if (this.canRun(executionClass)) {
      this.reserve(executionClass);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: TaskWaiter = {
        executionClass,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal.reason instanceof Error ? signal.reason : new DOMException('The task was aborted', 'AbortError'));
          this.drain();
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      const firstBackground = this.waiting.findIndex(item => item.executionClass === 'background');
      if (executionClass === 'foreground' && firstBackground >= 0) this.waiting.splice(firstBackground, 0, waiter);
      else this.waiting.push(waiter);
    });
  }

  private canRun(executionClass: TaskExecutionClass): boolean {
    if (this.active >= this.maximum) return false;
    return executionClass === 'background'
      ? this.activeBackground < this.backgroundMaximum
      : this.activeForeground < this.foregroundMaximum;
  }

  private reserve(executionClass: TaskExecutionClass): void {
    this.active += 1;
    if (executionClass === 'background') this.activeBackground += 1;
    else this.activeForeground += 1;
  }

  private release(executionClass: TaskExecutionClass): void {
    this.active = Math.max(0, this.active - 1);
    if (executionClass === 'background') this.activeBackground = Math.max(0, this.activeBackground - 1);
    else this.activeForeground = Math.max(0, this.activeForeground - 1);
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
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

/** Run an autonomous agent against durable Work Task state and an authenticated REST/SSE boundary.  中文：基于持久 Work Task 执行 Agent，并提供认证 REST/SSE 边界。 */
export class NavigatorExecutor {
  /** Only active process-local handles live here; durable records stay in WorkStateStore.  中文：此 Map 只保存活动运行句柄；持久记录由 WorkStateStore 管理。 */
  private readonly tasks = new Map<string, InternalTaskState>();
  private readonly agentTaskMap = new Map<Agent, string>();
  private readonly sessionTaskMap = new Map<Session, string>();
  private readonly activeTaskBySessionId = new Map<string, string>();
  private readonly agentModelSelections = new WeakMap<Agent, ModelSelectionRef>();
  private readonly sessionTails = new Map<string, Promise<void>>();
  private readonly taskLimiter: TaskConcurrencyLimiter;
  private readonly instanceId = randomUUID();
  private drainGeneration = 0;
  private drainToken?: string;
  private drainStartedAt?: number;
  private shutdownRequested = false;
  private disposePromise?: Promise<void>;
  private readonly defaultTimeoutMs?: number;
  private httpServer?: Server;
  private drainTimer?: ReturnType<typeof setInterval>;
  private teamsNotificationDrainTimer?: ReturnType<typeof setInterval>;
  private teamsNotificationDrain?: Promise<void>;
  private lastCredentialHealthSnapshotAt = 0;
  private disposeStreamListener?: () => void;
  private disposeErrorListener?: () => void;
  private disposeSessionListener?: () => void;
  private readonly ready: Promise<void>;

  constructor(
    private readonly ctx: Context,
    private readonly config: ExecutorConfig,
  ) {
    this.defaultTimeoutMs = config.defaultTimeoutMs;
    this.taskLimiter = new TaskConcurrencyLimiter(config.maxConcurrentTasks ?? 2);
    this.setupStreamListeners();
    this.ready = this.recoverInterruptedTasks();
  }

  /** Stop new claims and cancel limiter waiters while leaving durable admission open. */
  startDrain(): { readonly instanceId: string; readonly generation: number; readonly token: string; readonly startedAt: number } {
    if (this.shutdownRequested || this.disposePromise !== undefined) {
      throw new ExecutorRequestError(503, 'EXECUTOR_STOPPED', 'Executor is shutting down.');
    }
    this.enterDrain();
    return this.currentDrainToken();
  }

  /** Enter a non-resumable drain for SIGTERM/SIGINT shutdown. */
  startShutdownDrain(): { readonly instanceId: string; readonly generation: number; readonly token: string; readonly startedAt: number } {
    if (this.disposePromise !== undefined) {
      throw new ExecutorRequestError(503, 'EXECUTOR_STOPPED', 'Executor is shutting down.');
    }
    this.shutdownRequested = true;
    this.enterDrain();
    return this.currentDrainToken();
  }

  private currentDrainToken(): { readonly instanceId: string; readonly generation: number; readonly token: string; readonly startedAt: number } {
    return {
      instanceId: this.instanceId,
      generation: this.drainGeneration,
      token: this.drainToken!,
      startedAt: this.drainStartedAt!,
    };
  }

  private enterDrain(): void {
    if (this.drainToken === undefined) {
      this.drainGeneration += 1;
      this.drainToken = randomUUID();
      this.drainStartedAt = Date.now();
      this.taskLimiter.beginDrain();
    }
  }

  /** Resume only the exact drain instance and generation returned by startDrain. */
  resumeFromDrain(generation: number, token: string): void {
    if (this.shutdownRequested || this.disposePromise !== undefined) {
      throw new ExecutorRequestError(409, 'EXECUTOR_STOPPED', 'This executor instance is stopping.');
    }
    if (this.drainToken === undefined || generation !== this.drainGeneration || token !== this.drainToken) {
      throw new ExecutorRequestError(409, 'DRAIN_GENERATION_MISMATCH', 'The drain token does not match this executor instance.');
    }
    this.drainToken = undefined;
    this.drainStartedAt = undefined;
    this.taskLimiter.resume();
    setImmediate(() => {
      void this.drainQueuedTasks().catch(error => {
        this.ctx.logger.warn(`Queued task dispatch failed after drain resume (${safeErrorMessage(error)})`);
      });
      void this.drainTeamsNotifications().catch(error => {
        this.ctx.logger.warn(`Teams notification dispatch failed after drain resume (${safeErrorMessage(error)})`);
      });
    });
  }

  /** Read process drain state and durable task counts without claiming queued work. */
  async getDrainStatus(): Promise<ExecutorDrainStatus> {
    await this.ready;
    let queuedTasks = 0;
    let activeTasks = 0;
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (;;) {
      const page = await this.config.workState.listTasks({ cursor, limit: 100 });
      for (const task of page.items) {
        if (task.status === 'queued') queuedTasks += 1;
        else if (task.status === 'running') activeTasks += 1;
      }
      if (!page.nextCursor) break;
      if (seenCursors.has(page.nextCursor)) throw new Error('Work task listing returned a repeated cursor');
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    const dispatches = this.taskLimiter.snapshot();
    const notificationsInFlight = this.teamsNotificationDrain !== undefined;
    return {
      mode: this.drainToken === undefined ? 'accepting' : 'draining',
      instanceId: this.instanceId,
      generation: this.drainGeneration,
      token: this.drainToken ?? null,
      startedAt: this.drainStartedAt ?? null,
      countsComplete: true,
      activeTasks,
      queuedTasks,
      dispatches: { active: dispatches.active, waiting: dispatches.waiting },
      notifications: {
        configured: this.config.teams !== undefined,
        pollingPaused: this.drainToken !== undefined,
        inFlight: notificationsInFlight,
      },
      activeWorkDrained: activeTasks === 0
        && dispatches.active === 0
        && dispatches.waiting === 0
        && this.tasks.size === 0
        && !notificationsInFlight,
    };
  }

  /** Return a conservative snapshot when durable Work-state counts are unavailable. */
  private localDrainStatus(): ExecutorDrainStatus {
    const dispatches = this.taskLimiter.snapshot();
    const activeTasks = [...this.tasks.values()].filter(task => task.record.status === 'running').length;
    const queuedTasks = [...this.tasks.values()].filter(task => task.record.status === 'queued').length;
    return {
      mode: this.drainToken === undefined ? 'accepting' : 'draining',
      instanceId: this.instanceId,
      generation: this.drainGeneration,
      token: this.drainToken ?? null,
      startedAt: this.drainStartedAt ?? null,
      countsComplete: false,
      activeTasks,
      queuedTasks,
      dispatches: { active: dispatches.active, waiting: dispatches.waiting },
      notifications: {
        configured: this.config.teams !== undefined,
        pollingPaused: this.drainToken !== undefined,
        inFlight: this.teamsNotificationDrain !== undefined,
      },
      activeWorkDrained: false,
    };
  }

  /** Wait for current task executions and a claimed notification batch, without waiting for durable queued rows. */
  async waitForIdle(timeoutMs: number): Promise<ExecutorDrainStatus> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 900_000) {
      throw new TypeError('Drain timeout must be an integer between 0 and 900000 milliseconds');
    }
    if (this.drainToken === undefined) {
      throw new ExecutorRequestError(409, 'EXECUTOR_NOT_DRAINING', 'Start a drain before waiting for idle.');
    }
    const deadline = Date.now() + timeoutMs;
    let status = this.localDrainStatus();
    for (;;) {
      const remainingBeforeRead = Math.max(0, deadline - Date.now());
      if (remainingBeforeRead === 0) return { ...status, activeWorkDrained: false };
      const read = this.getDrainStatus().then(value => value, () => undefined);
      let readTimer: ReturnType<typeof setTimeout> | undefined;
      const readTimeout = new Promise<undefined>(resolve => {
        readTimer = setTimeout(() => resolve(undefined), remainingBeforeRead);
      });
      const refreshed = await Promise.race([read, readTimeout]);
      if (readTimer !== undefined) clearTimeout(readTimer);
      if (refreshed === undefined) {
        if (Date.now() >= deadline) return { ...status, countsComplete: false, activeWorkDrained: false };
        status = this.localDrainStatus();
        await delay(Math.min(DRAIN_STATUS_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
        continue;
      }
      status = refreshed;
      if (status.activeWorkDrained || Date.now() >= deadline) return status;
      const pending: Promise<unknown>[] = [...this.tasks.values()]
        .map(task => task.completion)
        .filter((completion): completion is Promise<TaskOutcome> => completion !== undefined);
      if (this.teamsNotificationDrain !== undefined) pending.push(this.teamsNotificationDrain);
      const remainingMs = Math.max(0, deadline - Date.now());
      if (pending.length > 0) {
        await Promise.race([Promise.allSettled(pending), delay(Math.min(DRAIN_STATUS_POLL_INTERVAL_MS, remainingMs))]);
      } else {
        await delay(Math.min(DRAIN_STATUS_POLL_INTERVAL_MS, remainingMs));
      }
    }
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
      } else if (chunk.type === 'usage' && task.modelRoute !== undefined) {
        void this.publish(task, {
          type: 'model-usage',
          taskId: task.id,
          provider: task.modelRoute.provider,
          model: task.modelRoute.model,
          usage: chunk.usage,
          timestamp,
        }).catch(() => undefined);
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

  /** Install one mutable DSH selection and a bounded configured-provider failover chain. */
  private installAgentModelSelection(
    agentCtx: Context,
    selection: ModelSelectionRef,
    sessionId: string,
  ): void {
    this.installModelRoutingHooks(agentCtx, selection, sessionId);
    installModelSelection(agentCtx, selection);
  }

  /** Record each actual model route and retry only recognized provider-availability failures. */
  private installModelRoutingHooks(
    agentCtx: Context,
    selection: ModelSelectionRef,
    sessionId: string,
  ): void {
    let requestKey: string | undefined;
    const attempted = new Set<string>();
    agentCtx.on('agent/request', async ({ turn, step }, next) => {
      const request = await next();
      const nextKey = `${turn}:${step}`;
      if (requestKey !== nextKey) {
        requestKey = nextKey;
        attempted.clear();
      }
      const taskId = this.activeTaskBySessionId.get(sessionId);
      const task = taskId === undefined ? undefined : this.tasks.get(taskId);
      if (task !== undefined && (task.modelRoute?.provider !== request.provider || task.modelRoute.model !== request.model)) {
        task.modelRoute = { provider: request.provider, model: request.model };
        await this.publish(task, {
          type: 'model-route',
          taskId: task.id,
          provider: request.provider,
          model: request.model,
          timestamp: Date.now(),
        });
      }
      return request;
    });
    agentCtx.on('agent/request-error', async ({ turn, step, failure }, next) => {
      const action = await next();
      if (!isModelAvailabilityFailure(failure)) return action;
      const current = selection.assembled ?? selection.current;
      if (current === undefined) return action;
      const nextKey = `${turn}:${step}`;
      if (requestKey !== nextKey) {
        requestKey = nextKey;
        attempted.clear();
      }
      attempted.add(modelRouteKey(current));
      const backup = nextFallbackRoute(this.config.modelFallbacks ?? [], current, attempted);
      if (backup === undefined) return action;
      // This retries the failed model step before DSH can execute any tool from its response.
      selection.current = { ...backup };
      selection.assembled = { ...backup };
      return { kind: 'retry' };
    });
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
    return this.executeTask({
      taskId,
      sessionId: record.sessionId,
      prompt: record.prompt,
      executionClass: recordExecutionClass(record),
      ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    }, subscriber);
  }

  /** Poll durable queued rows and race-safely claim each for execution.  中文：轮询持久排队记录并通过原子认领安全执行。 */
  async drainQueuedTasks(): Promise<number> {
    await this.ready;
    if (this.drainToken !== undefined) return 0;
    let started = 0;
    let cursor: string | undefined;
    for (;;) {
      if (this.drainToken !== undefined) return started;
      const page = await this.config.workState.listTasks({ cursor, limit: 100 });
      const queued = page.items.filter(record => record.status === 'queued' && !this.tasks.has(record.id));
      queued.sort((left, right) => Number(recordExecutionClass(right) === 'foreground')
        - Number(recordExecutionClass(left) === 'foreground'));
      for (const record of queued) {
        if (this.drainToken !== undefined) return started;
        this.adoptQueuedTask(record, {
          taskId: record.id,
          sessionId: record.sessionId,
          prompt: record.prompt,
          executionClass: recordExecutionClass(record),
          ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
        });
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
    const requestedExecutionClass = params.executionClass === undefined
      ? undefined
      : normalizeExecutionClass(params.executionClass);
    const executionClass = requestedExecutionClass ?? 'foreground';
    const metadata = params.metadata === undefined ? undefined : normalizeTaskMetadata(params.metadata);
    if (params.timeoutMs !== undefined && (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs <= 0)) {
      throw new TypeError('timeoutMs must be a positive integer');
    }
    const requestedId = params.taskId ?? `task-${randomUUID()}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(requestedId)) throw new TypeError('Invalid taskId');
    const existing = await this.config.workState.getTask(requestedId);
    if (existing) {
      if (requestedExecutionClass !== undefined && recordExecutionClass(existing) !== requestedExecutionClass) {
        throw new Error('Existing task execution class does not match this dispatch request');
      }
      if (metadata !== undefined && canonicalJson(existing.metadata ?? {}) !== canonicalJson(metadata)) {
        throw new Error('Existing task provenance metadata does not match this dispatch request');
      }
      const active = this.tasks.get(existing.id);
      if (active) {
        if (subscriber) active.subscribers.add(subscriber);
        return active;
      }
      if (existing.status === 'queued') {
        if (existing.prompt !== params.prompt || (params.sessionId !== undefined && existing.sessionId !== params.sessionId)) {
          throw new Error('Existing queued task does not match this dispatch request');
        }
        if (dispatchQueued && this.drainToken !== undefined) return stateFromRecord(existing);
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
      record = await this.config.workState.createTask({
        id: requestedId,
        sessionId,
        prompt: params.prompt,
        executionClass,
        ...(metadata === undefined ? {} : { metadata }),
      });
    } catch (error) {
      // A simultaneous retry may have won the durable ID race. Read it once and never start duplicate work.
      const raced = await this.config.workState.getTask(requestedId);
      if (!raced) throw error;
      if (requestedExecutionClass !== undefined && recordExecutionClass(raced) !== requestedExecutionClass) {
        throw new Error('Existing task execution class does not match this dispatch request');
      }
      if (metadata !== undefined && canonicalJson(raced.metadata ?? {}) !== canonicalJson(metadata)) {
        throw new Error('Existing task provenance metadata does not match this dispatch request');
      }
      const active = this.tasks.get(raced.id);
      if (active) {
        if (subscriber) active.subscribers.add(subscriber);
        return active;
      }
      if (raced.status === 'queued') {
        if (dispatchQueued && this.drainToken !== undefined) return stateFromRecord(raced);
        return dispatchQueued ? this.adoptQueuedTask(raced, params, subscriber) : stateFromRecord(raced);
      }
      return stateFromRecord(raced);
    }

    // An API admission remains queued until the dispatcher claims it. This means connector
    // retries and process restarts cannot accidentally start a second model/tool side effect.
    if (!dispatchQueued) return stateFromRecord(record);
    if (this.drainToken !== undefined) return stateFromRecord(record);
    const concurrent = this.tasks.get(record.id);
    if (concurrent) {
      if (subscriber) concurrent.subscribers.add(subscriber);
      return concurrent;
    }

    const task: InternalTaskState = {
      id: record.id, sessionId: record.sessionId, prompt: record.prompt,
      executionClass: recordExecutionClass(record),
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
    task.completion = this.runSerialized(task, {
      ...params,
      taskId: task.id,
      sessionId: task.sessionId,
      prompt: task.prompt,
      executionClass: task.executionClass,
      ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    });
    return task;
  }

  /** A Session owns one task at a time so its output and tool events cannot mix. | 同一 Session 串行执行。 */
  private runSerialized(task: InternalTaskState, params: ExecuteTaskParams): Promise<TaskOutcome> {
    const predecessor = this.sessionTails.get(task.sessionId) ?? Promise.resolve();
    const completion = predecessor.then(() => this.runTask(task, params)).finally(() => {
      if (task.agent && this.agentTaskMap.get(task.agent) === task.id) this.agentTaskMap.delete(task.agent);
      if (task.agent && this.sessionTaskMap.get(task.agent.session) === task.id) this.sessionTaskMap.delete(task.agent.session);
      if (this.activeTaskBySessionId.get(task.sessionId) === task.id) this.activeTaskBySessionId.delete(task.sessionId);
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
    try {
      return await this.taskLimiter.run(
        task.executionClass,
        task.abortController.signal,
        () => this.runTaskWithSlot(task, params),
      );
    } catch (error: unknown) {
      if (error instanceof TaskDispatchPausedError) return outcome(task.record);
      if (!task.abortController.signal.aborted) throw error;
      const latest = await this.config.workState.getTask(task.id).catch(() => undefined);
      return outcome(latest ?? task.record, safeErrorMessage(error), 'aborted');
    }
  }

  private async runTaskWithSlot(task: InternalTaskState, params: ExecuteTaskParams): Promise<TaskOutcome> {
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new TypeError('timeoutMs must be a positive number');
    }
    const timeoutId = timeoutMs === undefined
      ? undefined
      : setTimeout(() => task.abortController.abort(new Error(`Task timed out after ${timeoutMs}ms`)), timeoutMs);
    let disposeContinuationGuard: (() => void) | undefined;
    let claimed = false;
    try {
      task.abortController.signal.throwIfAborted();
      this.taskLimiter.assertDispatchAllowed();
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

      if (this.config.conversationBackend !== undefined) {
        return await this.runConversationBackendTask(task, params);
      }

      const agents = this.ctx.get('agents');
      const sessions = this.ctx.get('sessions');
      const defaultModel = this.ctx.get('agentDefaultModel');
      if (!agents || !sessions) throw new Error('Required Cordis services (agents, sessions) are not available');

      const cwd = params.cwd ?? this.config.defaultCwd ?? process.cwd();
      const defaultSelection = defaultModel?.currentSelection();
      const agentOptions: AgentOptions = defaultSelection
        ? { provider: defaultSelection.provider, model: defaultSelection.model }
        : {};
      let selectionRef: ModelSelectionRef | undefined;
      const setup = (agentCtx: Context): void => {
        if (defaultSelection === undefined) return;
        selectionRef = { current: defaultSelection, assembled: undefined };
        this.installAgentModelSelection(agentCtx, selectionRef, task.sessionId);
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

      selectionRef ??= this.agentModelSelections.get(agent);
      if (selectionRef === undefined && defaultSelection !== undefined) {
        selectionRef = { current: defaultSelection, assembled: undefined };
        this.installAgentModelSelection(agent.ctx, selectionRef, task.sessionId);
      }
      if (selectionRef !== undefined && defaultSelection !== undefined) {
        // A newly admitted task uses the configured default; a failure may move this live Session to a backup.
        selectionRef.current = defaultSelection;
      }
      if (selectionRef !== undefined) this.agentModelSelections.set(agent, selectionRef);
      task.modelSelection = selectionRef;

      task.agent = agent;
      this.agentTaskMap.set(agent, task.id);
      this.sessionTaskMap.set(agent.session, task.id);
      this.activeTaskBySessionId.set(task.sessionId, task.id);
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
      const awaitingAuthorization = task.record.status === 'awaiting_user_authorization'
        && task.authorizationPause && task.error === undefined;
      const cleanupIncomplete = err instanceof Error && err.message === 'CodeBuddy ACP cleanup is incomplete';
      const status: TaskStatus = awaitingAuthorization
        ? 'awaiting_user_authorization'
        : isAborted ? 'aborted' : 'failed';
      const message = task.error ?? (awaitingAuthorization
        ? cleanupIncomplete
          ? `NATIVE_CLEANUP_INCOMPLETE: ${safeErrorMessage(err)} Authorization remains required; task context is preserved and no automatic replay occurred.`
          : task.record.error ?? 'Exchange connection authorization is required. Progress is preserved and automatic replay is disabled.'
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
        if (!awaitingAuthorization || cleanupIncomplete) {
          await this.publish(task, {
            type: 'error', taskId: task.id, message,
            code: cleanupIncomplete ? 'NATIVE_CLEANUP_INCOMPLETE'
              : isAborted ? 'TASK_ABORTED' : 'EXECUTION_FAILED', timestamp: endedAt,
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
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  /** Execute one host-owned backend turn while preserving the same durable Work lifecycle. */
  private async runConversationBackendTask(task: InternalTaskState, params: ExecuteTaskParams): Promise<TaskOutcome> {
    const backend = this.config.conversationBackend;
    if (backend === undefined) throw new Error('The configured conversation backend is unavailable');
    task.authorizationPauseController ??= new AbortController();
    this.activeTaskBySessionId.set(task.sessionId, task.id);
    const result = await backend.execute({
      taskId: task.id,
      sessionId: task.sessionId,
      prompt: params.prompt,
      signal: task.abortController.signal,
      authorizationPauseSignal: task.authorizationPauseController.signal,
      readOnly: isReadOnlyContinuation(task.record),
      onText: text => {
        task.output += text;
        this.publish(task, { type: 'text-delta', taskId: task.id, text, timestamp: Date.now() });
        void this.patch(task, { output: task.output }).catch(() => undefined);
      },
      onToolCall: event => this.publish(task, {
        type: 'tool-call', taskId: task.id, callId: event.callId, tool: event.name,
        args: event.arguments, timestamp: Date.now(),
      }),
      onToolResult: event => this.publish(task, {
        type: 'tool-result', taskId: task.id, callId: event.callId,
        result: event.result, isError: event.isError, timestamp: Date.now(),
      }),
    });
    task.output = result.output;
    await this.flushEvents(task);
    await this.flushPatches(task);
    task.abortController.signal.throwIfAborted();
    const latest = await this.config.workState.getTask(task.id);
    if (latest) task.record = latest;
    if (PAUSED_STATUSES.has(task.record.status)) {
      const finishedAt = Date.now();
      await this.publish(task, {
        type: 'finish', taskId: task.id, status: task.record.status,
        output: task.record.output, durationMs: Math.max(0, finishedAt - (task.record.startedAt ?? task.record.createdAt)),
        timestamp: finishedAt,
      });
      await this.flushEvents(task);
      return outcome(task.record);
    }
    if (TERMINAL_STATUSES.has(task.record.status)) return outcome(task.record);

    const finishedAt = Date.now();
    const durationMs = Math.max(0, finishedAt - (task.record.startedAt ?? task.record.createdAt));
    task.record = await this.config.workState.patchTask(task.id, {
      status: 'completed', output: task.output, reasoning: '',
    });
    await this.publish(task, {
      type: 'status', taskId: task.id, sessionId: task.sessionId,
      status: 'completed', timestamp: finishedAt,
    });
    await this.publish(task, {
      type: 'finish', taskId: task.id, status: 'completed', output: task.output,
      durationMs, timestamp: finishedAt,
    });
    await this.flushEvents(task);
    return outcome(task.record);
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
    const deadline = performance.now() + (this.defaultTimeoutMs ?? 300_000) + 10_000;
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
    task.authorizationPauseController?.abort(new Error('Exchange authorization is required.'));
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

  /** Resolve the active Work task for one Navigator Session at tool boundaries.  中文：按 Navigator Session 查找活动任务并绑定 Work authority。 */
  activeTaskId(sessionId: string): string | undefined {
    const taskId = this.activeTaskBySessionId.get(sessionId);
    if (taskId === undefined) return undefined;
    const task = this.tasks.get(taskId);
    if (!task || task.sessionId !== sessionId || TERMINAL_STATUSES.has(task.record.status)) return undefined;
    return task.agent !== undefined || this.config.conversationBackend !== undefined ? task.id : undefined;
  }

  /** Resolve the active Work Task scheduling class for a DSH model request. */
  executionClassForSession(sessionId: string): TaskExecutionClass {
    const taskId = this.activeTaskBySessionId.get(sessionId);
    return taskId === undefined ? 'foreground' : this.tasks.get(taskId)?.executionClass ?? 'foreground';
  }

  /** Read durable task events for a workflow receipt without adding another persistence client. */
  async readTaskEvents(taskId: string, after = 0) {
    return this.config.workState.getEvents(taskId, after);
  }

  /** Aggregate only durable provider-reported counts; absent counts remain absent and never gate work. */
  async readTaskModelUsage(taskId: string): Promise<TaskModelUsageSnapshot> {
    const aggregate = new Map<string, {
      provider: string;
      model: string;
      reportedCalls: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      completeTotal: boolean;
    }>();
    let after = 0;
    for (;;) {
      const page = await this.config.workState.getEvents(taskId, after);
      for (const row of page.events) {
        const event = row.event;
        if (event.type !== 'model-usage' || typeof event.provider !== 'string' || typeof event.model !== 'string') continue;
        const usage = decodeProviderTokenUsage(event.usage);
        if (usage === undefined) continue;
        const key = modelRouteKey({ provider: event.provider, model: event.model });
        const current = aggregate.get(key) ?? {
          provider: event.provider,
          model: event.model,
          reportedCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          completeTotal: true,
        };
        current.reportedCalls += 1;
        current.inputTokens += usage.inputTokens;
        current.outputTokens += usage.outputTokens;
        if (usage.totalTokens === undefined) current.completeTotal = false;
        else current.totalTokens += usage.totalTokens;
        aggregate.set(key, current);
      }
      const lastSeq = page.events.at(-1)?.seq;
      if (lastSeq === undefined || lastSeq <= after || lastSeq + 1 >= page.nextSeq) break;
      after = lastSeq;
    }
    return {
      taskId,
      routes: [...aggregate.values()]
        .sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
        .map(({ provider, model, reportedCalls, inputTokens, outputTokens, totalTokens, completeTotal }) => ({
          provider,
          model,
          reportedCalls,
          inputTokens,
          outputTokens,
          ...(completeTotal ? { totalTokens } : {}),
        })),
    };
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
    if (this.config.teams) {
      this.teamsNotificationDrainTimer = setInterval(() => {
        void this.drainTeamsNotifications().catch(error => {
          this.ctx.logger.warn(`Teams notification dispatch failed (${safeErrorMessage(error)})`);
        });
      }, 1_000);
      this.teamsNotificationDrainTimer.unref?.();
      void this.drainTeamsNotifications().catch(error => {
        this.ctx.logger.warn(`Teams notification dispatch failed (${safeErrorMessage(error)})`);
      });
    }
    const address = server.address();
    const resolvedPort = typeof address === 'object' && address ? address.port : port;
    const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${resolvedPort}`;
    return {
      url,
      close: async () => {
        if (this.drainTimer) clearInterval(this.drainTimer);
        this.drainTimer = undefined;
        if (this.teamsNotificationDrainTimer) clearInterval(this.teamsNotificationDrainTimer);
        this.teamsNotificationDrainTimer = undefined;
        await new Promise<void>(resolve => server.close(() => resolve()));
        this.httpServer = undefined;
      },
    };
  }

  /** Verify the adapter HMAC, persist the event/task/thread, then allow the caller to ACK. */
  private async acceptTeamsEvent(req: IncomingMessage): Promise<{
    readonly duplicate: boolean;
    readonly taskId?: string;
    readonly receipt: Record<string, unknown>;
  }> {
    const config = this.config.teams;
    if (!config || !this.config.workState.registerConnectorEvent
      || !this.config.workState.getConnectorThread || !this.config.workState.claimNotifications
      || !this.config.workState.startNotification || !this.config.workState.finishNotification) {
      throw new ExecutorRequestError(503, 'TEAMS_BRIDGE_NOT_CONFIGURED', 'Teams delivery is not configured.');
    }
    const secret = process.env[config.ingressSecretEnv];
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new ExecutorRequestError(503, 'TEAMS_BRIDGE_NOT_CONFIGURED', 'Teams delivery is not configured.');
    }
    const sourceKeyId = req.headers['x-cyrene-source-key-id'];
    const timestamp = req.headers['x-cyrene-source-timestamp'];
    const signature = req.headers['x-cyrene-source-signature'];
    if (sourceKeyId !== 'teams-v1' || typeof timestamp !== 'string' || !/^\d{1,12}$/u.test(timestamp)
      || typeof signature !== 'string' || !/^v1=[0-9a-f]{64}$/u.test(signature)) {
      throw new ExecutorRequestError(401, 'CONNECTOR_SOURCE_UNAUTHENTICATED', 'Teams event authentication failed.');
    }
    const timestampSeconds = Number(timestamp);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > 300) {
      throw new ExecutorRequestError(401, 'CONNECTOR_SOURCE_UNAUTHENTICATED', 'Teams event authentication failed.');
    }
    const rawBody = await this.readRawBody(req, 1_048_576);
    const expected = createHmac('sha256', secret).update(`${timestamp}.`, 'utf8').update(rawBody).digest();
    const presented = Buffer.from(signature.slice(3), 'hex');
    if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
      throw new ExecutorRequestError(401, 'CONNECTOR_SOURCE_UNAUTHENTICATED', 'Teams event authentication failed.');
    }
    const body = parseTeamsJsonObject(rawBody.toString('utf8'), 'Teams event body');
    if (!isExactObjectKeys(body, ['event_type', 'payload', 'trust']) || body.event_type !== 'inbound_message') {
      throw new ExecutorRequestError(400, 'TEAMS_EVENT_INVALID', 'Teams event is invalid.');
    }
    const normalized = normalizeTeamsActivity(body.payload, body.trust, config);
    const threadId = sha256(canonicalJson({
      tenantId: normalized.route.tenantId,
      teamId: normalized.route.teamId,
      channelId: normalized.route.channelId,
      rootThreadId: normalized.route.rootThreadId,
    }));
    const eventId = `teams-${sha256(canonicalJson({
      tenantId: normalized.route.tenantId,
      teamId: normalized.route.teamId,
      channelId: normalized.route.channelId,
      messageId: normalized.messageId,
    }))}`;

    let priorThread: Awaited<ReturnType<WorkStateStore['getConnectorThread']>> | undefined;
    try {
      priorThread = await this.config.workState.getConnectorThread(
        config.connectorId, threadId, 20, normalized.messageId,
      );
      assertTeamsThreadRoute(priorThread, normalized.route, threadId);
    } catch (error: unknown) {
      if (!(error instanceof WorkStateHttpError) || error.status !== 404) throw error;
    }
    const activeSessionId = priorThread?.sessionId;
    const taskActorSubjects = await resolveTeamsTaskActorSubjects(
      config, this.config.workspaceId, normalized.actorIssuer,
    );
    const isTaskActor = taskActorSubjects.includes(normalized.actorSubject);
    const createTask = isTaskActor && (activeSessionId !== undefined || normalized.mentionsBot);
    const sessionId = activeSessionId ?? (createTask ? `teams-${threadId}` : undefined);
    const teamsThreadMessage = {
      threadId,
      messageId: normalized.messageId,
      serviceUrl: normalized.route.serviceUrl,
      tenantId: normalized.route.tenantId,
      teamId: normalized.route.teamId,
      channelId: normalized.route.channelId,
      conversationId: normalized.route.conversationId,
      rootThreadId: normalized.route.rootThreadId,
      actorIssuer: normalized.actorIssuer,
      actorSubject: normalized.actorSubject,
      text: normalized.text,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
    const task = createTask
      ? {
        id: eventId,
        sessionId: sessionId!,
        prompt: buildTeamsTaskPrompt(priorThread?.messages ?? [], normalized.text, normalized.actorSubject),
        title: 'Teams request',
        metadata: {
          teamsCaller: {
            issuer: normalized.actorIssuer,
            subject: normalized.actorSubject,
            tenantId: normalized.route.tenantId,
            actorAadObjectId: normalized.actorSubject,
          },
          teamsThread: {
            threadId,
            tenantId: normalized.route.tenantId,
            teamId: normalized.route.teamId,
            channelId: normalized.route.channelId,
            conversationId: normalized.route.conversationId,
            rootThreadId: normalized.route.rootThreadId,
          },
          notification: {
            type: 'teams.message',
            connectorId: config.connectorId,
            recipient: `teams:${threadId}`,
            payload: normalized.route,
          },
        },
      }
      : undefined;
    const receipt = await this.config.workState.registerConnectorEvent({
      connectorId: config.connectorId,
      messageId: eventId,
      type: 'message.received',
      accountId: config.botAppId,
      conversationId: normalized.route.conversationId,
      senderId: normalized.actorSubject,
      payload: {
        provider: 'teams',
        tenantId: normalized.route.tenantId,
        teamId: normalized.route.teamId,
        channelId: normalized.route.channelId,
        conversationId: normalized.route.conversationId,
        rootThreadId: normalized.route.rootThreadId,
        messageId: normalized.messageId,
        senderId: normalized.actorSubject,
        text: normalized.text,
      },
      teamsThreadMessage,
      ...(task === undefined ? {} : { task }),
    });
    return {
      duplicate: receipt.duplicate,
      ...(receipt.task === undefined ? {} : { taskId: receipt.task.id }),
      receipt: {
        accepted: true,
        duplicate: receipt.duplicate,
        eventId: receipt.eventId,
        ...(receipt.task === undefined ? {} : { taskId: receipt.task.id, status: receipt.task.status }),
      },
    };
  }

  /** Deliver durable Teams notifications once; uncertain provider outcomes stay terminal. */
  private async drainTeamsNotifications(): Promise<void> {
    if (this.teamsNotificationDrain) return this.teamsNotificationDrain;
    if (this.drainToken !== undefined) return;
    const config = this.config.teams;
    if (!config) return;
    this.teamsNotificationDrain = (async () => {
      if (config.credentialNotifications !== undefined) {
        try {
          await this.refreshCredentialHealthSnapshots(config, config.credentialNotifications);
        } catch {
          this.ctx.logger.warn('credential health snapshot refresh failed; the next bounded check remains scheduled');
        }
      }
      if (this.drainToken !== undefined) return;
      const leases = await this.config.workState.claimNotifications({
        workerId: `navigator-teams-${process.pid}`,
        limit: 10,
        leaseSeconds: 60,
        type: 'teams.message',
        connectorId: config.connectorId,
      });
      for (const lease of leases) await this.deliverTeamsNotification(lease, config);
      if (config.credentialNotifications !== undefined && this.drainToken === undefined) {
        const credentialLeases = await this.config.workState.claimNotifications({
          workerId: `navigator-credential-notices-${process.pid}`,
          limit: 10,
          leaseSeconds: 60,
          type: 'teams.credential-health',
          connectorId: config.connectorId,
          recipient: 'teams:credential-health',
        });
        for (const lease of credentialLeases) {
          await this.deliverCredentialHealthNotification(lease, config, config.credentialNotifications);
        }
      }
    })().finally(() => { this.teamsNotificationDrain = undefined; });
    return this.teamsNotificationDrain;
  }

  /** Consume Exchange's cached projection on the existing durable Teams worker tick. */
  private async refreshCredentialHealthSnapshots(
    teams: TeamsExecutorConfig,
    config: CredentialNotificationsConfig,
  ): Promise<void> {
    const now = Date.now();
    if (now - this.lastCredentialHealthSnapshotAt < config.pollIntervalMs) return;
    this.lastCredentialHealthSnapshotAt = now;
    const selectors = new Map(config.connections.map(item => [item.connectionId, item.provider]));
    const snapshots = await teams.exchangeAuthorization.getAuthorizationHealthSnapshots({
      requestId: randomUUID(),
      organizationId: config.organizationId,
      workspaceId: config.workspaceId,
      connectionIds: config.connections.map(item => item.connectionId),
    }, AbortSignal.timeout(10_000));
    for (const snapshot of snapshots) {
      if (selectors.get(snapshot.connectionId) !== snapshot.provider) {
        throw new TypeError('Exchange returned a credential health snapshot outside the host configuration');
      }
    }
    if (snapshots.length > 0) {
      await this.config.workState.processCredentialHealthSnapshots(
        config.organizationId,
        snapshots,
      );
    }
  }

  private async deliverTeamsNotification(
    lease: Awaited<ReturnType<WorkStateStore['claimNotifications']>>[number],
    config: TeamsExecutorConfig,
  ): Promise<void> {
    const notification = lease.notification;
    let started = false;
    let providerCallStarted = false;
    try {
      await this.config.workState.startNotification(notification.id, lease.leaseToken);
      started = true;
      const retryCountValue = notification.result.retryCount ?? 0;
      if (typeof retryCountValue !== 'number' || !Number.isSafeInteger(retryCountValue)
        || retryCountValue < 0) {
        throw new TypeError('Teams notification retry counter is invalid');
      }
      const requestId = `${notification.id}:attempt:${retryCountValue + 1}`;
      if (requestId.length > 200) throw new TypeError('Teams notification request identifier is too long');
      if (notification.taskId === undefined) throw new TypeError('Teams notification has no source task');
      const task = await this.config.workState.getTask(notification.taskId);
      if (!task) throw new TypeError('Teams notification source task is unavailable');
      const metadata = task.metadata ?? {};
      const caller = readTeamsCaller(metadata.teamsCaller);
      const currentTaskActors = await resolveTeamsTaskActorSubjects(
        config, this.config.workspaceId, caller.issuer,
      );
      if (!currentTaskActors.includes(caller.subject)) throw new TypeError('Teams notification actor is no longer authorized');
      const route = readTeamsNotificationRoute(notification.payload);
      if (route.tenantId !== caller.tenantId) throw new TypeError('Teams notification tenant does not match its task actor');
      const text = boundedTeamsMessageText(notification.payload.text, 'Teams notification text', 20_000);
      const conversation = {
        tenantId: route.tenantId,
        teamId: route.teamId,
        channelId: route.channelId,
        conversationId: route.conversationId,
        rootThreadId: route.rootThreadId,
        serviceUrl: route.serviceUrl,
      };
      const argumentsValue: ConnectorGrantRequest['arguments'] = { conversation, text };
      const grantRequest: ConnectorGrantRequest = {
        requestId,
        workspaceId: this.config.workspaceId,
        principalIssuer: caller.issuer,
        principalSubject: caller.subject,
        connectionRef: config.exchangeConnectionRef,
        providerId: 'msteams',
        profileRef: config.exchangeProfileRef,
        operationId: 'msteams.message.reply',
        resourceRef: teamsThreadResourceRef(conversation),
        argumentsDigestSha256: sha256(canonicalJson(argumentsValue)),
        arguments: argumentsValue,
      };
      const grant = await config.exchangeAuthorization.mintGrant(grantRequest, AbortSignal.timeout(10_000));
      const message = { requestId, conversation, text };
      providerCallStarted = true;
      const result = await config.exchangeAuthorization.sendTeamsMessage(
        message, grant, config.exchangeConnectionRef, config.exchangeProfileRef, AbortSignal.timeout(15_000),
      );
      if (result.outcome === 'rate_limited' && result.retryAfterSeconds !== undefined) {
        await this.finishTeamsRateLimit(notification.id, lease.leaseToken, result.retryAfterSeconds, {
          reasonCode: result.reasonCode ?? 'rate_limited',
        });
        return;
      }
      const outcome = result.outcome === 'accepted'
        ? 'delivered'
        : result.outcome === 'uncertain' ? 'uncertain' : 'failed';
      await this.config.workState.finishNotification(notification.id, lease.leaseToken, outcome, {
        reasonCode: result.reasonCode ?? null,
        vendorMessageId: result.vendorMessageId ?? null,
      });
    } catch (error: unknown) {
      if (!started) return;
      if (providerCallStarted && error instanceof ExchangeConnectorRequestError
        && error.status === 429 && error.retryAfterSeconds !== undefined) {
        await this.finishTeamsRateLimit(notification.id, lease.leaseToken, error.retryAfterSeconds, {
          code: 'EXCHANGE_HTTP_429',
        }).catch(() => undefined);
        return;
      }
      const unknown = providerCallStarted && isUncertainConnectorOutcome(error);
      try {
        await this.config.workState.finishNotification(
          notification.id,
          lease.leaseToken,
          unknown ? 'uncertain' : 'failed',
          { code: safeErrorCode(error) },
        );
      } catch (finishError: unknown) {
        this.ctx.logger.warn(`Teams notification receipt could not be finalized (${safeErrorMessage(finishError)})`);
      }
    }
  }

  /** Deliver one host-owned credential alert through its dedicated fixed Exchange profile. */
  private async deliverCredentialHealthNotification(
    lease: Awaited<ReturnType<WorkStateStore['claimNotifications']>>[number],
    teams: TeamsExecutorConfig,
    config: CredentialNotificationsConfig,
  ): Promise<void> {
    const notification = lease.notification;
    let started = false;
    let providerCallStarted = false;
    try {
      await this.config.workState.startNotification(notification.id, lease.leaseToken);
      started = true;
      if (notification.taskId !== undefined
        || notification.type !== 'teams.credential-health'
        || notification.connectorId !== teams.connectorId
        || notification.recipient !== 'teams:credential-health') {
        throw new TypeError('Credential health notification has an invalid outbox source');
      }
      const retryCountValue = notification.result.retryCount ?? 0;
      if (typeof retryCountValue !== 'number' || !Number.isSafeInteger(retryCountValue)
        || retryCountValue < 0) {
        throw new TypeError('Credential health notification retry counter is invalid');
      }
      const requestId = `${notification.id}:attempt:${retryCountValue + 1}`;
      if (requestId.length > 200) throw new TypeError('Credential health request identifier is too long');
      const notice = readCredentialHealthNotice(notification.payload);
      const selectedConnection = config.connections.find(
        item => item.connectionId === notice.connectionId,
      );
      if (selectedConnection === undefined || selectedConnection.provider !== notice.provider) {
        throw new TypeError('Credential health notice is outside the host connection selectors');
      }
      const allowedSubjects = await resolveTeamsTaskActorSubjects(
        teams, config.workspaceId, config.owner.issuer,
      );
      if (!allowedSubjects.includes(config.owner.subject)) {
        throw new TypeError('Credential notification owner is not currently authorized');
      }
      const conversation = config.destination;
      const text = boundedTeamsMessageText(
        formatCredentialHealthNotice(notice), 'Credential health notification text', 20_000,
      );
      const argumentsValue: ConnectorGrantRequest['arguments'] = {
        conversation: { ...conversation },
        text,
      };
      const grantRequest: ConnectorGrantRequest = {
        requestId,
        workspaceId: config.workspaceId,
        principalIssuer: config.owner.issuer,
        principalSubject: config.owner.subject,
        connectionRef: teams.exchangeConnectionRef,
        providerId: 'msteams',
        profileRef: config.exchangeProfileRef,
        operationId: 'msteams.message.reply',
        resourceRef: teamsThreadResourceRef(conversation),
        argumentsDigestSha256: sha256(canonicalJson(argumentsValue)),
        arguments: argumentsValue,
      };
      const grant = await teams.exchangeAuthorization.mintGrant(
        grantRequest, AbortSignal.timeout(10_000),
      );
      if (grant.organizationId !== config.organizationId) {
        throw new TypeError('Credential notification Exchange grant has a different organization scope');
      }
      providerCallStarted = true;
      const result = await teams.exchangeAuthorization.sendTeamsMessage(
        { requestId, conversation, text },
        grant,
        teams.exchangeConnectionRef,
        config.exchangeProfileRef,
        AbortSignal.timeout(15_000),
      );
      if (result.outcome === 'rate_limited' && result.retryAfterSeconds !== undefined) {
        await this.finishTeamsRateLimit(notification.id, lease.leaseToken, result.retryAfterSeconds, {
          reasonCode: result.reasonCode ?? 'rate_limited',
        });
        return;
      }
      const outcome = result.outcome === 'accepted'
        ? 'delivered'
        : result.outcome === 'uncertain' ? 'uncertain' : 'failed';
      await this.config.workState.finishNotification(notification.id, lease.leaseToken, outcome, {
        reasonCode: result.reasonCode ?? null,
        vendorMessageId: result.vendorMessageId ?? null,
      });
    } catch (error: unknown) {
      if (!started) return;
      if (!providerCallStarted && error instanceof ExchangeConnectorRequestError
        && error.status === 429 && error.retryAfterSeconds !== undefined) {
        await this.finishTeamsRateLimit(notification.id, lease.leaseToken, error.retryAfterSeconds, {
          code: 'EXCHANGE_GRANT_HTTP_429',
        }).catch(() => undefined);
        return;
      }
      if (providerCallStarted && error instanceof ExchangeConnectorRequestError
        && error.status === 429 && error.retryAfterSeconds !== undefined) {
        await this.finishTeamsRateLimit(notification.id, lease.leaseToken, error.retryAfterSeconds, {
          code: 'EXCHANGE_HTTP_429',
        }).catch(() => undefined);
        return;
      }
      if (!providerCallStarted && error instanceof ExchangeConnectorRequestError
        && (error.status === undefined || error.status >= 500)) {
        await this.config.workState.finishNotification(
          notification.id,
          lease.leaseToken,
          'retry',
          { code: safeErrorCode(error) },
          30,
        ).catch(() => undefined);
        return;
      }
      const unknown = providerCallStarted && isUncertainConnectorOutcome(error);
      try {
        await this.config.workState.finishNotification(
          notification.id,
          lease.leaseToken,
          unknown ? 'uncertain' : 'failed',
          { code: safeErrorCode(error) },
        );
      } catch (finishError: unknown) {
        this.ctx.logger.warn(`Credential notification receipt could not be finalized (${safeErrorMessage(finishError)})`);
      }
    }
  }

  private async finishTeamsRateLimit(
    notificationId: string,
    leaseToken: string,
    retryAfterSeconds: number,
    result: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.config.workState.finishNotification(
      notificationId,
      leaseToken,
      'retry',
      result,
      Math.min(Math.max(Math.ceil(retryAfterSeconds), 1), 300),
    );
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
    if (method === 'POST' && url.pathname === '/internal/v1/connectors/teams/events') {
      try {
        await this.ready;
        const admission = await this.acceptTeamsEvent(req);
        this.sendJson(res, admission.duplicate ? 200 : 202, admission.receipt);
        if (admission.taskId) {
          setImmediate(() => {
            void this.dispatchTask(admission.taskId!).catch(error => {
              this.ctx.logger.warn(`Teams task dispatch failed (${safeErrorMessage(error)})`);
            });
          });
        }
      } catch (error: unknown) {
        if (error instanceof ExecutorRequestError) {
          if (error.code === 'CONNECTOR_SOURCE_UNAUTHENTICATED') {
            this.sendJson(res, error.status, {
              code: error.code,
              error: 'Teams event authentication failed',
              terminal: false,
              sourceAuthenticated: false,
            });
          } else if (['TEAMS_TENANT_NOT_ALLOWED', 'TEAMS_TEAM_NOT_ALLOWED'].includes(error.code)) {
            this.sendJson(res, error.status, {
              code: error.code,
              error: error.message,
              terminal: true,
              sourceAuthenticated: true,
            });
          } else {
            this.sendJson(res, error.status, { code: error.code, error: error.message });
          }
        } else if (error instanceof WorkStateHttpError) {
          const status = error.status >= 500 ? 503 : error.status;
          this.sendJson(res, status, {
            code: error.code,
            error: 'Teams event admission could not be persisted',
          });
        } else {
          this.sendJson(res, 503, { code: 'TEAMS_INGRESS_UNAVAILABLE', error: 'Teams event admission is unavailable' });
        }
      }
      return;
    }
    if (!this.isAuthorized(req)) {
      this.sendJson(res, 401, { error: 'Bearer authentication is required' }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }

    try {
      await this.ready;
      if (method === 'GET' && url.pathname === '/internal/v1/executor/drain') {
        this.sendJson(res, 200, await this.getDrainStatus());
        return;
      }
      if (method === 'POST' && url.pathname === '/internal/v1/executor/drain') {
        const body = await this.readJsonBody(req);
        if (!isExactObjectKeys(body, [])) {
          throw new ExecutorRequestError(400, 'DRAIN_REQUEST_INVALID', 'Drain requests must have an empty JSON object body.');
        }
        this.startDrain();
        this.sendJson(res, 200, await this.getDrainStatus());
        return;
      }
      if (method === 'POST' && url.pathname === '/internal/v1/executor/drain/resume') {
        const body = await this.readJsonBody(req);
        if (!isExactObjectKeys(body, ['generation', 'token'])
          || typeof body.generation !== 'number' || !Number.isSafeInteger(body.generation) || body.generation < 1
          || typeof body.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(body.token)) {
          throw new ExecutorRequestError(400, 'DRAIN_RESUME_INVALID', 'Resume requires the exact drain generation and token.');
        }
        this.resumeFromDrain(body.generation, body.token);
        this.sendJson(res, 200, await this.getDrainStatus());
        return;
      }
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
          if (this.drainToken !== undefined) {
            const record = await this.startTask(params);
            if (record.status === 'queued') {
              this.openEventStream(res, 202);
              this.writeSseEvent(res, undefined, 'status', {
                type: 'status', taskId: record.id, sessionId: record.sessionId,
                status: 'queued', timestamp: Date.now(),
              });
              res.end();
              return;
            }
            this.openEventStream(res);
            let observedEvent = false;
            const subscriber = (event: ExecutorStreamEvent) => {
              observedEvent = true;
              this.writeSseEvent(res, event.seq, event.type, event);
            };
            const outcome = await this.executeTask(params, subscriber);
            if (outcome.status === 'queued') {
              this.writeSseEvent(res, undefined, 'status', {
                type: 'status', taskId: outcome.taskId, sessionId: outcome.sessionId,
                status: 'queued', timestamp: Date.now(),
              });
            } else if (!observedEvent) {
              this.writeSseEvent(res, undefined, 'status', {
                type: 'status', taskId: outcome.taskId, sessionId: outcome.sessionId,
                status: outcome.status, timestamp: Date.now(),
              });
              if (TERMINAL_STATUSES.has(outcome.status) || PAUSED_STATUSES.has(outcome.status)) {
                this.writeSseEvent(res, undefined, 'finish', {
                  type: 'finish', taskId: outcome.taskId, status: outcome.status,
                  output: outcome.output, durationMs: outcome.durationMs, timestamp: Date.now(),
                });
              }
            }
            res.end();
            return;
          }
          this.openEventStream(res);
          const subscriber = (event: ExecutorStreamEvent) => this.writeSseEvent(res, event.seq, event.type, event);
          const outcome = await this.executeTask(params, subscriber);
          if (outcome.status === 'queued' && this.drainToken !== undefined) {
            this.writeSseEvent(res, undefined, 'status', {
              type: 'status', taskId: outcome.taskId, sessionId: outcome.sessionId,
              status: 'queued', timestamp: Date.now(),
            });
          }
          if (!res.writableEnded) res.end();
          return;
        }
        const outcome = await this.executeTask(params);
        this.sendJson(res, outcome.status === 'queued' ? 202 : 200, outcome);
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

  private openEventStream(res: ServerResponse, status = 200): void {
    res.writeHead(status, {
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

  private readRawBody(req: IncomingMessage, maximumBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      req.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > maximumBytes) {
          settled = true;
          reject(new ExecutorRequestError(413, 'TEAMS_EVENT_TOO_LARGE', 'Teams event exceeds the request limit.'));
          req.destroy();
          return;
        }
        chunks.push(bytes);
      });
      req.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks, total));
      });
      req.on('error', error => {
        if (settled) return;
        settled = true;
        reject(error);
      });
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
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.shutdownRequested = true;
    this.enterDrain();
    this.disposePromise = Promise.resolve().then(() => this.disposeImpl());
    return this.disposePromise;
  }

  private async disposeImpl(): Promise<void> {
    this.disposeStreamListener?.();
    this.disposeErrorListener?.();
    this.disposeSessionListener?.();
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = undefined;
    if (this.teamsNotificationDrainTimer) clearInterval(this.teamsNotificationDrainTimer);
    this.teamsNotificationDrainTimer = undefined;
    const live = [...this.tasks.values()];
    for (const task of live) {
      if (!TERMINAL_STATUSES.has(task.record.status)) {
        task.abortController.abort(new Error('Executor is shutting down'));
        task.agent?.cancel({ kind: 'hook', reason: 'navigator_executor_shutdown' });
      }
    }
    const pendingWork: Promise<unknown>[] = live
      .map(task => task.completion)
      .filter((completion): completion is Promise<TaskOutcome> => completion !== undefined);
    if (this.teamsNotificationDrain !== undefined) pendingWork.push(this.teamsNotificationDrain);
    await Promise.allSettled(pendingWork);
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
    executionClass: recordExecutionClass(record),
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

interface NormalizedTeamsActivity {
  readonly messageId: string;
  readonly actorSubject: string;
  readonly actorIssuer: string;
  readonly route: TeamsMessageRoute;
  readonly text: string;
  readonly mentionsBot: boolean;
}

function normalizeTeamsActivity(
  payloadValue: unknown,
  trustValue: unknown,
  config: TeamsExecutorConfig,
): NormalizedTeamsActivity {
  const payload = objectValue(payloadValue, 'Teams canonical payload');
  const trust = objectValue(trustValue, 'Teams trust envelope');
  const trustKeys = [
    'version', 'provider', 'tenant_id', 'actor_aad_object_id', 'team_id', 'channel_id',
    'root_thread_id', 'message_id', 'bot_app_id', 'service_url',
  ];
  if (!isExactObjectKeys(trust, trustKeys) || trust.version !== 1 || trust.provider !== 'teams') {
    throw new ExecutorRequestError(400, 'TEAMS_TRUST_ENVELOPE_INVALID', 'Teams event trust context is invalid.');
  }
  const tenantId = uuidText(trust.tenant_id, 'tenant id');
  const actorSubject = uuidText(trust.actor_aad_object_id, 'actor id');
  const botAppId = uuidText(trust.bot_app_id, 'bot app id');
  if (tenantId !== config.tenantId.toLowerCase() || botAppId !== config.botAppId.toLowerCase()) {
    throw new ExecutorRequestError(403, 'TEAMS_TENANT_NOT_ALLOWED', 'Teams tenant is not configured.');
  }
  const teamId = boundedText(trust.team_id, 'team id', 512);
  if (!config.allowedTeamIds.includes(teamId)) {
    throw new ExecutorRequestError(403, 'TEAMS_TEAM_NOT_ALLOWED', 'Teams team is not configured.');
  }
  const channelId = boundedText(trust.channel_id, 'channel id', 512);
  const rootThreadId = validateTeamsRootThreadId(trust.root_thread_id);
  const messageId = boundedText(trust.message_id, 'message id', 512);
  const serviceUrl = validateTeamsServiceUrl(trust.service_url, tenantId);
  const canonicalMessageId = boundedText(payload.message_id, 'canonical message id', 512);
  const senderId = uuidText(payload.sender_id, 'canonical sender id');
  if (canonicalMessageId !== messageId || senderId !== actorSubject || senderId === botAppId) {
    throw new ExecutorRequestError(403, 'TEAMS_SENDER_MISMATCH', 'Teams sender context does not match.');
  }
  const conversation = objectValue(payload.conversation, 'Teams conversation');
  if (conversation.vendor !== 'msteams' || conversation.kind !== 'channel'
    || uuidText(conversation.account_id, 'canonical bot account id') !== botAppId) {
    throw new ExecutorRequestError(400, 'TEAMS_CONVERSATION_INVALID', 'Teams conversation context is invalid.');
  }
  const conversationId = boundedText(conversation.conversation_id, 'conversation id', 512);
  const extension = objectValue(payload.vendor_extension, 'Teams vendor extension');
  if (extension.vendor !== 'msteams' || !Array.isArray(extension.facts)) {
    throw new ExecutorRequestError(400, 'TEAMS_VENDOR_EXTENSION_INVALID', 'Teams route facts are invalid.');
  }
  const facts = new Map<string, string>();
  for (const item of extension.facts) {
    const fact = objectValue(item, 'Teams route fact');
    if (typeof fact.name === 'string' && typeof fact.value === 'string') facts.set(fact.name, fact.value);
  }
  if (facts.get('tenant_id')?.toLowerCase() !== tenantId
    || facts.get('team_id') !== teamId || facts.get('channel_id') !== channelId) {
    throw new ExecutorRequestError(403, 'TEAMS_ROUTE_MISMATCH', 'Teams route context does not match.');
  }
  if (!Array.isArray(payload.content) || payload.content.length > 500) {
    throw new ExecutorRequestError(400, 'TEAMS_CONTENT_INVALID', 'Teams message content is invalid.');
  }

  const textParts: string[] = [];
  let mentionsBot = false;
  for (const blockValue of payload.content) {
    const block = objectValue(blockValue, 'Teams message content block');
    if (block.mention !== undefined) {
      const mention = objectValue(block.mention, 'Teams mention');
      const target = typeof mention.target_id === 'string' ? mention.target_id.toLowerCase() : '';
      if (target === botAppId) mentionsBot = true;
      else if (target) textParts.push(`@${target}`);
    }
    if (block.text !== undefined) {
      const textBlock = objectValue(block.text, 'Teams text block');
      if (typeof textBlock.text === 'string' && textBlock.text.trim()) textParts.push(textBlock.text.trim());
    }
    if (block.image !== undefined) textParts.push('[Image attachment is present in Teams; its contents were not transferred.]');
    if (block.file !== undefined) textParts.push('[File attachment is present in Teams; its contents were not transferred.]');
  }
  const text = boundedTeamsMessageText(
    textParts.join('\n').trim(),
    'Teams message text',
    20_000,
  );
  const actorIssuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  return {
    messageId,
    actorSubject,
    actorIssuer,
    route: { tenantId, teamId, channelId, conversationId, rootThreadId, serviceUrl },
    text,
    mentionsBot,
  };
}

function buildTeamsTaskPrompt(
  messages: readonly { readonly actorSubject: string; readonly text: string }[],
  currentText: string,
  actorSubject: string,
): string {
  const contextLines: string[] = [];
  let total = 0;
  const actorMessages = messages.filter(item => item.actorSubject === actorSubject);
  for (const item of [...actorMessages].slice(-20).reverse()) {
    const line = `[Teams context from actor ${item.actorSubject}]\n${item.text}`;
    if (total + line.length > 60_000) break;
    contextLines.unshift(line);
    total += line.length;
  }
  if (contextLines.length === 0) return currentText;
  return [
    'Earlier messages from the same authorized Teams actor are context. Messages from other actors are never included in an operation prompt.',
    ...contextLines,
    `Current request from authorized Teams actor ${actorSubject}:\n${currentText}`,
  ].join('\n\n');
}

function assertTeamsThreadRoute(
  value: { readonly threadId: string; readonly tenantId: string; readonly teamId: string; readonly channelId: string; readonly conversationId: string; readonly rootThreadId: string },
  route: TeamsMessageRoute,
  threadId: string,
): void {
  if (value.threadId !== threadId || value.tenantId !== route.tenantId || value.teamId !== route.teamId
    || value.channelId !== route.channelId || value.conversationId !== route.conversationId
    || value.rootThreadId !== route.rootThreadId) {
    throw new ExecutorRequestError(409, 'TEAMS_THREAD_ROUTE_CONFLICT', 'Teams thread route does not match its persisted mapping.');
  }
}

interface TeamsCaller {
  readonly issuer: string;
  readonly subject: string;
  readonly tenantId: string;
}

/** Resolve the configured Teams execution principals using the same live Directory file used by ingress/delivery. */
export async function resolveTeamsTaskActorSubjects(
  config: TeamsExecutorConfig,
  workspaceId: string,
  issuer: string,
): Promise<readonly string[]> {
  if (!config.taskActorSubjectsFile) return config.taskActorSubjects;
  const raw = await readFile(config.taskActorSubjectsFile);
  if (raw.byteLength > 64_000) throw new TypeError('Teams task actor authorization file exceeds its size limit');
  const value: unknown = JSON.parse(raw.toString('utf8'));
  const row = objectValue(value, 'Teams task actor authorization file');
  if (!isExactObjectKeys(row, ['schemaVersion', 'workspaceId', 'issuer', 'subjects'])
    || row.schemaVersion !== 1 || row.workspaceId !== workspaceId || row.issuer !== issuer
    || !Array.isArray(row.subjects) || row.subjects.length > 256) {
    throw new TypeError('Teams task actor authorization file has invalid scope or schema');
  }
  const subjects = row.subjects.map((subject, index) =>
    uuidText(subject, `Teams task actor authorization subject ${index}`));
  if (new Set(subjects).size !== subjects.length) {
    throw new TypeError('Teams task actor authorization file contains duplicate subjects');
  }
  return subjects;
}

/** Validate the opt-in private snapshot selectors, owner, and sole notice route. */
export function parseCredentialNotificationsConfig(
  value: unknown,
  workspaceId: string,
  tenantId: string,
  allowedTeamIds: readonly string[],
): CredentialNotificationsConfig {
  const row = objectValue(value, 'credential notifications configuration');
  const keys = [
    'schemaVersion', 'organizationId', 'workspaceId', 'owner', 'connections',
    'destination', 'exchange',
  ];
  if (row.pollIntervalMs !== undefined) keys.push('pollIntervalMs');
  if (!isExactObjectKeys(row, keys) || row.schemaVersion !== 1 || row.workspaceId !== workspaceId) {
    throw new TypeError('Credential notifications configuration has invalid scope or schema');
  }
  const organizationId = uuidText(row.organizationId, 'credential notification organization id');
  const owner = objectValue(row.owner, 'credential notification owner');
  if (!isExactObjectKeys(owner, ['actorAadObjectId', 'issuer', 'subject', 'tenantId'])) {
    throw new TypeError('Credential notification owner has an invalid shape');
  }
  const ownerTenantId = uuidText(owner.tenantId, 'credential notification owner tenant id');
  const ownerSubject = uuidText(owner.subject, 'credential notification owner subject');
  const ownerActorId = uuidText(owner.actorAadObjectId, 'credential notification owner actor id');
  const ownerIssuer = boundedText(owner.issuer, 'credential notification owner issuer', 512);
  if (ownerSubject !== ownerActorId || ownerTenantId !== tenantId.toLowerCase()
    || ownerIssuer !== `https://login.microsoftonline.com/${ownerTenantId}/v2.0`) {
    throw new TypeError('Credential notification owner does not match the configured Teams tenant');
  }
  if (!Array.isArray(row.connections) || row.connections.length < 1 || row.connections.length > 100) {
    throw new TypeError('Credential notification connections must contain 1 to 100 selectors');
  }
  const connections = row.connections.map((item, index) => {
    const selector = objectValue(item, `credential notification connection ${index}`);
    if (!isExactObjectKeys(selector, ['connectionId', 'provider'])) {
      throw new TypeError('Credential notification connection selector has an invalid shape');
    }
    const connectionId = uuidText(selector.connectionId, `credential notification connection ${index} id`);
    const provider = selector.provider;
    if (provider !== 'hf' && provider !== 'runpod' && provider !== 'azure' && provider !== 'gcp') {
      throw new TypeError('Credential notification connection provider is not supported');
    }
    return {
      connectionId,
      provider: provider as CredentialHealthSnapshot['provider'],
    };
  });
  if (new Set(connections.map(item => item.connectionId)).size !== connections.length) {
    throw new TypeError('Credential notification connection selectors must be unique');
  }
  const destinationValue = objectValue(row.destination, 'credential notification destination');
  if (!isExactObjectKeys(destinationValue, [
    'tenantId', 'teamId', 'channelId', 'conversationId', 'rootThreadId', 'serviceUrl',
  ])) {
    throw new TypeError('Credential notification destination has an invalid shape');
  }
  const destination = readTeamsNotificationRoute(destinationValue);
  if (destination.tenantId !== ownerTenantId || !allowedTeamIds.includes(destination.teamId)) {
    throw new TypeError('Credential notification destination is outside the configured Teams scope');
  }
  const exchange = objectValue(row.exchange, 'credential notification Exchange profile');
  if (!isExactObjectKeys(exchange, ['profileRef'])) {
    throw new TypeError('Credential notification Exchange profile has an invalid shape');
  }
  const exchangeProfileRef = boundedText(exchange.profileRef, 'credential notification Exchange profile', 512);
  const pollIntervalMs = row.pollIntervalMs ?? 15 * 60_000;
  if (typeof pollIntervalMs !== 'number' || !Number.isSafeInteger(pollIntervalMs)
    || pollIntervalMs < 60_000 || pollIntervalMs > 15 * 60_000) {
    throw new TypeError('Credential notification snapshot interval must be between one and fifteen minutes');
  }
  return Object.freeze({
    organizationId,
    workspaceId,
    owner: Object.freeze({ issuer: ownerIssuer, subject: ownerSubject, tenantId: ownerTenantId }),
    connections: Object.freeze(connections),
    destination: Object.freeze(destination),
    exchangeProfileRef,
    pollIntervalMs,
  });
}

function readTeamsCaller(value: unknown): TeamsCaller {
  const row = objectValue(value, 'Teams task caller');
  const tenantId = uuidText(row.tenantId, 'Teams task tenant id');
  const subject = uuidText(row.subject, 'Teams task actor id');
  const issuer = boundedText(row.issuer, 'Teams task actor issuer', 512);
  if (issuer !== `https://login.microsoftonline.com/${tenantId}/v2.0`
    || (row.actorAadObjectId !== undefined && uuidText(row.actorAadObjectId, 'Teams actor object id') !== subject)) {
    throw new TypeError('Teams task caller identity is invalid');
  }
  return { issuer, subject, tenantId };
}

function readTeamsNotificationRoute(value: Record<string, unknown>): TeamsMessageRoute {
  const tenantId = uuidText(value.tenantId, 'Teams notification tenant id');
  return {
    tenantId,
    teamId: boundedText(value.teamId, 'Teams notification team id', 512),
    channelId: boundedText(value.channelId, 'Teams notification channel id', 512),
    conversationId: boundedText(value.conversationId, 'Teams notification conversation id', 512),
    rootThreadId: validateTeamsRootThreadId(value.rootThreadId),
    serviceUrl: validateTeamsServiceUrl(value.serviceUrl, tenantId),
  };
}

interface CredentialHealthNotice {
  readonly event: 'action_required' | 'reminder' | 'recovered';
  readonly incidentId: string;
  readonly connectionId: string;
  readonly provider: 'hf' | 'runpod' | 'azure' | 'gcp';
  readonly generation: number;
  readonly loginState: 'PRESENT' | 'MISSING' | 'UNKNOWN' | 'UNAVAILABLE';
  readonly authorizationState: 'VALID' | 'REAUTHORIZATION_REQUIRED' | 'PERMISSION_DENIED' | 'UNKNOWN' | 'UNAVAILABLE';
  readonly capabilities: readonly {
    readonly capabilityId: string;
    readonly state: 'VALID' | 'REAUTHORIZATION_REQUIRED' | 'PERMISSION_DENIED' | 'UNKNOWN' | 'UNAVAILABLE';
  }[];
  readonly checkedAt: string | null;
  readonly expiresAt: string | null;
  readonly reasonCode: string | null;
}

/** Parse only the fixed, credential-free payload created by Work's system route. */
function readCredentialHealthNotice(value: Record<string, unknown>): CredentialHealthNotice {
  if (!isExactObjectKeys(value, [
    'schemaVersion', 'event', 'incidentId', 'connectionId', 'provider', 'generation',
    'loginState', 'authorizationState', 'capabilities', 'checkedAt', 'expiresAt', 'reasonCode',
  ]) || value.schemaVersion !== 1) {
    throw new TypeError('Credential health notice has an invalid payload schema');
  }
  const event = value.event;
  if (event !== 'action_required' && event !== 'reminder' && event !== 'recovered') {
    throw new TypeError('Credential health notice event is not supported');
  }
  const incidentId = boundedText(value.incidentId, 'credential incident id', 64);
  if (!/^[0-9a-f]{32}$/u.test(incidentId)) throw new TypeError('Credential incident id is invalid');
  const provider = value.provider;
  if (provider !== 'hf' && provider !== 'runpod' && provider !== 'azure' && provider !== 'gcp') {
    throw new TypeError('Credential health notice provider is not supported');
  }
  if (typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 0) {
    throw new TypeError('Credential health notice generation is invalid');
  }
  const loginState = value.loginState;
  if (loginState !== 'PRESENT' && loginState !== 'MISSING' && loginState !== 'UNKNOWN' && loginState !== 'UNAVAILABLE') {
    throw new TypeError('Credential health notice login state is invalid');
  }
  const authorizationState = value.authorizationState;
  if (authorizationState !== 'VALID' && authorizationState !== 'REAUTHORIZATION_REQUIRED'
    && authorizationState !== 'PERMISSION_DENIED' && authorizationState !== 'UNKNOWN'
    && authorizationState !== 'UNAVAILABLE') {
    throw new TypeError('Credential health notice authorization state is invalid');
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length > 100) {
    throw new TypeError('Credential health notice capabilities are invalid');
  }
  const capabilities = value.capabilities.map((item, index) => {
    const capability = objectValue(item, `credential health notice capability ${index}`);
    if (!isExactObjectKeys(capability, ['capabilityId', 'state'])) {
      throw new TypeError('Credential health notice capability has an invalid shape');
    }
    const state = capability.state;
    if (state !== 'VALID' && state !== 'REAUTHORIZATION_REQUIRED' && state !== 'PERMISSION_DENIED'
      && state !== 'UNKNOWN' && state !== 'UNAVAILABLE') {
      throw new TypeError('Credential health notice capability state is invalid');
    }
    return {
      capabilityId: boundedText(capability.capabilityId, 'credential health capability id', 256),
      state: state as CredentialHealthNotice['capabilities'][number]['state'],
    };
  });
  if (new Set(capabilities.map(item => item.capabilityId)).size !== capabilities.length) {
    throw new TypeError('Credential health notice capability ids are duplicated');
  }
  const checkedAt = readCredentialTimestamp(value.checkedAt, 'checkedAt');
  const expiresAt = readCredentialTimestamp(value.expiresAt, 'expiresAt');
  const reasonCode = readCredentialReasonCode(value.reasonCode);
  const actionable = authorizationState === 'REAUTHORIZATION_REQUIRED'
    || authorizationState === 'PERMISSION_DENIED'
    || capabilities.some(item => item.state === 'REAUTHORIZATION_REQUIRED' || item.state === 'PERMISSION_DENIED');
  const inconclusive = loginState === 'UNKNOWN' || loginState === 'UNAVAILABLE'
    || authorizationState === 'UNKNOWN' || authorizationState === 'UNAVAILABLE'
    || capabilities.some(item => item.state === 'UNKNOWN' || item.state === 'UNAVAILABLE');
  const healthy = loginState === 'PRESENT' && authorizationState === 'VALID'
    && capabilities.every(item => item.state === 'VALID');
  if (inconclusive || (event === 'recovered' && !healthy) || (event !== 'recovered' && !actionable)) {
    throw new TypeError('Credential health notice event contradicts its authorization state');
  }
  return {
    event,
    incidentId,
    connectionId: boundedText(value.connectionId, 'credential connection id', 512),
    provider,
    generation: value.generation,
    loginState,
    authorizationState,
    capabilities,
    checkedAt,
    expiresAt,
    reasonCode,
  };
}

function readCredentialTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Credential health notice ${field} is invalid`);
  }
  return value;
}

function readCredentialReasonCode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value)) {
    throw new TypeError('Credential health notice reason code is invalid');
  }
  return value;
}

/** Format a short provider-owned status message without arbitrary provider text. */
function formatCredentialHealthNotice(notice: CredentialHealthNotice): string {
  const labels = { hf: 'Hugging Face', runpod: 'RunPod', azure: 'Azure', gcp: 'Google Cloud' };
  const headline = notice.event === 'recovered'
    ? '授权已恢复'
    : notice.event === 'reminder' ? '授权仍需处理' : '授权需要处理';
  const lines = [
    `Cyrene 凭据状态：${headline}`,
    `平台：${labels[notice.provider]}`,
    `连接：${notice.connectionId}`,
    `授权状态：${notice.authorizationState}`,
  ];
  const allAffected = notice.capabilities.filter(item =>
    item.state === 'REAUTHORIZATION_REQUIRED' || item.state === 'PERMISSION_DENIED',
  );
  const affected = allAffected.slice(0, 20).map(item => `${item.capabilityId} (${item.state})`);
  if (affected.length > 0) lines.push(`需要处理的能力：${affected.join(', ')}`);
  if (allAffected.length > affected.length) {
    lines.push(`另有 ${allAffected.length - affected.length} 项能力未展开。`);
  }
  if (notice.reasonCode !== null) lines.push(`原因代码：${notice.reasonCode}`);
  if (notice.checkedAt !== null) lines.push(`最近检查：${notice.checkedAt}`);
  if (notice.expiresAt !== null) lines.push(`凭据过期时间：${notice.expiresAt}`);
  lines.push(notice.event === 'recovered'
    ? '最近的 Exchange 检查确认授权已恢复。'
    : '请检查连接授权或所需权限；确认恢复后会在这里通知。');
  return lines.join('\n');
}

function validateTeamsRootThreadId(value: unknown): string {
  const rootThreadId = boundedText(value, 'Teams root thread id', 512);
  if (!/^\d+$/u.test(rootThreadId) || BigInt(rootThreadId) === 0n) {
    throw new ExecutorRequestError(400, 'TEAMS_ROOT_THREAD_INVALID', 'Teams root thread ID must be a positive numeric activity ID.');
  }
  return rootThreadId;
}

function isUncertainConnectorOutcome(error: unknown): boolean {
  if (error instanceof ExchangeConnectorRequestError) return error.outcomeUnknown;
  if (error instanceof WorkStateHttpError) return error.status >= 500;
  return true;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof ExchangeConnectorRequestError && error.status !== undefined) return `EXCHANGE_HTTP_${error.status}`;
  if (error instanceof WorkStateHttpError) return error.code.slice(0, 128);
  return 'TEAMS_DELIVERY_FAILED';
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExecutorRequestError(400, 'TEAMS_EVENT_INVALID', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseTeamsJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return objectValue(parsed, label);
  } catch (error: unknown) {
    if (error instanceof ExecutorRequestError) throw error;
    throw new ExecutorRequestError(400, 'TEAMS_EVENT_INVALID', `${label} is invalid JSON.`);
  }
}

function isExactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ExecutorRequestError(400, 'TEAMS_EVENT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function boundedTeamsMessageText(value: unknown, label: string, maximum: number): string {
  // Match the store's NUL/length guards while allowing LF, CRLF, and TAB in message text.
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.includes('\u0000')) {
    throw new ExecutorRequestError(400, 'TEAMS_EVENT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function uuidText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u.test(value)) {
    throw new ExecutorRequestError(400, 'TEAMS_EVENT_INVALID', `${label} is invalid.`);
  }
  return value.toLowerCase();
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
  if (body.executionClass !== undefined || body.metadata !== undefined) {
    throw new TypeError('executionClass and metadata are host-owned task fields');
  }
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

function normalizeExecutionClass(value: unknown): TaskExecutionClass {
  if (value === undefined || value === 'foreground') return 'foreground';
  if (value === 'background') return value;
  throw new TypeError('executionClass must be foreground or background');
}

function recordExecutionClass(record: TaskRecord): TaskExecutionClass {
  return normalizeExecutionClass(record.executionClass);
}

/** Copy bounded JSON provenance so callers cannot mutate the durable task after admission. */
function normalizeTaskMetadata(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Task metadata must be a JSON object');
  }
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded, 'utf8') > 64_000) throw new TypeError('Task metadata exceeds its size limit');
  const decoded: unknown = JSON.parse(encoded);
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TypeError('Task metadata must be a JSON object');
  }
  return decoded as Readonly<Record<string, unknown>>;
}

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
