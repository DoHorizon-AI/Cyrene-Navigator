// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Durable Workflow Runtime                          │
// │ Role: Use DSH Schedule as the sole durable timer and dispatch runs.   │
// │ 模块职责：以 DSH Schedule 作为唯一持久计时器并派发工作流。               │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { UserMessage } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session-persistence';
import Storage from '@deepseek-ai/dsh-storage';
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage';
import * as StorageJson from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import type {} from '@deepseek-ai/dsh-storage-domain';
import ScheduleService, { parseCronInput } from '@deepseek-ai/dsh-schedule';
import type { ScheduleCatalogEntry, ScheduleRecord } from '@deepseek-ai/dsh-schedule';
import { getConnectorToolCatalog } from '../tool-providers.js';
import type {
  WorkflowActionGrant,
  WorkflowActionReceipt,
  WorkflowAttentionKind,
  WorkflowCheckpoint,
  WorkflowDefinition,
  WorkflowEvidence,
  WorkflowRecord,
  WorkflowRepositoryCursor,
  WorkflowSchedule,
  WorkflowScheduleEvent,
  WorkflowV2Record,
  WorkflowOutboxType,
  WorkflowOperationState,
  WorkflowStore,
  WorkflowTeamsNoticeRequest,
  WorkflowWrite,
} from './store.js';
import { loadDefaultWorkflowTemplates } from './store.js';
import { installWorkflowReadonlyGuard, resolveWorkflowReadonlyPolicy } from './readonly.js';

/** Exact executor input for a durable workflow occurrence. */
export interface WorkflowDispatchRequest {
  readonly taskId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly executionClass?: 'foreground' | 'background';
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Narrow executor outcome used to distinguish success from failure. */
export interface WorkflowDispatchOutcome {
  readonly taskId: string;
  readonly sessionId: string;
  readonly status: string;
  readonly output: string;
  readonly error?: string;
}

/** Transition the UI or host should surface; unchanged successes produce no event. */
export type WorkflowNotificationKind = 'change' | 'failure' | 'recovery' | 'digest' | 'blocker';

/** Credential-free event published after a meaningful workflow transition. */
export interface WorkflowNotification {
  readonly workflowId: string;
  readonly occurrenceId: string;
  readonly triggerId: string;
  readonly deduplicationKey: string;
  readonly title: string;
  readonly kind: WorkflowNotificationKind;
  readonly scheduledAt: string;
  readonly summary: string;
  readonly taskId?: string;
  readonly attentionKind?: WorkflowAttentionKind;
}

/** Runtime dependencies; timer storage remains owned by the DSH storage domain. */
export interface WorkflowRuntimeOptions {
  readonly store: WorkflowStore;
  readonly executeTask: (request: WorkflowDispatchRequest) => Promise<WorkflowDispatchOutcome>;
  /** Read durable tool/operation receipts from the existing Work task authority. */
  readonly readTaskEvents?: (taskId: string, after?: number) => Promise<{
    readonly events: readonly { readonly seq: number; readonly event: Readonly<Record<string, unknown>> }[];
    readonly nextSeq: number;
  }>;
  /** Resolve the host-owned thread and return its already verified Teams outbox projection. */
  readonly projectTeamsNotification?: (notification: WorkflowNotification) => Promise<WorkflowTeamsNoticeRequest | undefined>;
  /** Persistent DSH storage root, used only if the shared JSON backend is absent. */
  readonly storageRoot?: string;
  /** Stable host Session receiving typed DSH timer messages. */
  readonly schedulerSessionId?: string;
  /**
   * Bounded polling interval for definition-only reconciliation; DSH Schedule remains the occurrence timer.
   * Values are clamped to 1 second through 5 minutes. Zero disables periodic reconciliation for tests.
   */
  readonly reconcileEveryMs?: number;
  /** Optional version-1 defaults; omission loads the bundled seven workflows. */
  readonly defaultWorkflows?: readonly WorkflowWrite[];
}

/** Runtime handle retained by the Host for an explicit workflow reconcile. */
export interface WorkflowRuntimeHandle {
  readonly schedulerSessionId: string;
  /** Reconcile persisted workflow definitions against DSH's durable Schedule rows. */
  sync(): Promise<void>;
  /** Stop reconciliation and remove the marker hook; DSH plugin and agent teardown follow Context lifecycle. */
  dispose(): Promise<void>;
}

interface ScheduleSessionController {
  resolveAgent(sessionId: ReturnType<typeof SessionId>): Promise<{ readonly agent: Agent } | { readonly error: Error }>;
}

interface WorkflowTimerMarker {
  readonly workflowId: string;
  readonly triggerId: string;
}

interface TimerOccurrence {
  readonly scheduledAt: string;
  readonly marker: WorkflowTimerMarker;
}

interface ParsedWorkflowResult {
  readonly changed: boolean;
  readonly summary: string;
}

interface ProposedWorkflowAction {
  readonly actionId: string;
  readonly actionType: WorkflowActionGrant['action'];
  readonly targetId: string;
  readonly objective: string;
}

interface WorkflowAttention {
  readonly kind: WorkflowAttentionKind;
  readonly summary: string;
}

interface ParsedWorkflowV2Result {
  readonly changed: boolean;
  readonly summary: string;
  readonly actionRequests: readonly ProposedWorkflowAction[];
  readonly attention?: WorkflowAttention;
}

interface GitHubSearchPageResult {
  readonly complete: boolean;
  readonly incompleteResults: boolean;
  readonly resultLimitReached: boolean;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly totalCount: number;
  readonly echoedPageCursor: string;
  readonly issues: readonly Readonly<Record<string, unknown>>[];
}

interface GitHubSearchPageReceipt {
  readonly targetId: string;
  readonly bindingId: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly page: GitHubSearchPageResult;
}

interface GitHubPollAssessment {
  readonly checkpoint: WorkflowCheckpoint;
  readonly changed: boolean;
  readonly attention?: WorkflowAttention;
}

const WORKFLOW_MARKER = '[CYRENE_WORKFLOW_TIMER_V1]';
const DEFAULT_SCHEDULER_SESSION_ID = 'navigator-workflow-scheduler-v1';
const DAILY_DIGEST_TRIGGER_ID = 'daily-digest';
const ACTIVE_RUNTIMES = new WeakMap<Context, Promise<WorkflowRuntimeHandle>>();

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowRuntime: WorkflowRuntimeHandle;
  }

  interface Events {
    /** Meaningful workflow state transition; unchanged successes are deliberately quiet. */
    'workflow/notification'(notification: WorkflowNotification): void;
  }
}

/**
 * Bootstrap shared durable DSH storage, one Schedule service, one scheduler Session, and its executor consumer.
 * The hook is installed before Schedule activation so overdue persisted tasks cannot reach an ordinary model turn.
 * @param ctx - Headless Cordis context after ToolRuntime, session persistence, and AgentLoop activation.
 * @param options - Durable workflow store, executor dispatcher, and optional DSH storage root.
 * @returns Handle for reading the stable scheduler Session and explicitly reconciling definitions.
 */
export async function registerWorkflowRuntime(ctx: Context, options: WorkflowRuntimeOptions): Promise<WorkflowRuntimeHandle> {
  const active = ACTIVE_RUNTIMES.get(ctx);
  if (active !== undefined) return active;
  const creating = createWorkflowRuntime(ctx, options);
  ACTIVE_RUNTIMES.set(ctx, creating);
  try {
    return await creating;
  } catch (error: unknown) {
    ACTIVE_RUNTIMES.delete(ctx);
    throw error;
  }
}

/** Assemble lifecycle-sensitive DSH dependencies in an order safe for overdue inbox recovery. */
async function createWorkflowRuntime(ctx: Context, options: WorkflowRuntimeOptions): Promise<WorkflowRuntimeHandle> {
  // ── Phase 1: Reuse or mount the shared persistent JSON domain stack. ──
  await ensureStorageStack(ctx, options.storageRoot);

  // ── Phase 2: Install the typed timer consumer before the Schedule runtime can deliver. ──
  const schedulerSessionId = SessionId(options.schedulerSessionId ?? DEFAULT_SCHEDULER_SESSION_ID);
  const idText = String(schedulerSessionId);
  // Install before Agent resume/create: an interrupted Scheduler Session may
  // already contain a delivered-but-unconsumed Schedule inbox message.
  const disposeMarkerHook = ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    if (String(agent.id) !== idText) return next();
    const scheduled = messages.filter(message => String(message.source?.kind) === 'schedule');
    if (scheduled.length === 0) return next();
    const occurrences = scheduled.flatMap(message => parseTimerOccurrences(message));
    for (const occurrence of occurrences) await dispatchOccurrence(ctx, options, occurrence);
    // A blocked step records consumption and prevents the scheduler Agent from starting a second run.
    return { kind: 'reject' };
  });
  let schedulerAgent: Awaited<ReturnType<typeof ensureSchedulerAgent>>;
  try {
    schedulerAgent = await ensureSchedulerAgent(ctx, schedulerSessionId);
  } catch (error: unknown) {
    disposeMarkerHook();
    throw error;
  }
  let disposed = false;
  let reconciliation: Promise<void> | undefined;
  let reconciliationTimer: ReturnType<typeof setInterval> | undefined;
  const sync = async (): Promise<void> => {
    if (reconciliation !== undefined) return reconciliation;
    const pending = reconcileSchedules(ctx, options.store, schedulerSessionId)
      .then(() => reconcileWorkflowNotifications(ctx, options));
    reconciliation = pending;
    try {
      await pending;
    } finally {
      if (reconciliation === pending) reconciliation = undefined;
    }
  };
  const handle: WorkflowRuntimeHandle = Object.freeze({
    schedulerSessionId: idText,
    sync,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (reconciliationTimer !== undefined) clearInterval(reconciliationTimer);
      reconciliationTimer = undefined;
      await reconciliation?.catch(() => undefined);
      disposeMarkerHook();
      ACTIVE_RUNTIMES.delete(ctx);
    },
  });
  ctx.provide('workflowRuntime', handle);
  ctx.effect(() => async () => {
    await handle.dispose();
    await schedulerAgent.ownedHandle?.dispose();
  }, 'navigator.workflowRuntime');

  // The Host adapter is intentionally only the one method DSH Schedule invokes.
  // It uses the official Agent and Session persistence services, not an API-controller replica.
  if (ctx.get('sessionController') === undefined) {
    const adapter: ScheduleSessionController = {
      resolveAgent: async (sessionId) => {
        const live = ctx.agents.get(sessionId);
        if (live !== undefined) return { agent: live };
        try {
          const snapshot = await ctx.sessionPersistence.stat(sessionId);
          if (snapshot === undefined) return { error: new Error('Scheduled Session not found') };
          const restored = await ctx.agents.resume({ resumeSessionId: sessionId });
          return { agent: restored.agent };
        } catch (error: unknown) {
          return { error: error instanceof Error ? error : new Error('Scheduled Session restore failed') };
        }
      },
    };
    ctx.provide('sessionController' as never, adapter as never);
  }

  // ── Phase 3: Seed default workflow memory before overdue Schedule rows can dispatch. ──
  await seedWorkflowTemplates(options.store, options.defaultWorkflows ?? await loadDefaultWorkflowTemplates());

  // ── Phase 4: Mount or reuse DSH Schedule exactly once, after its inbox is safe. ──
  if (ctx.get('schedule') === undefined) await ctx.plugin(ScheduleService);

  // ── Phase 5: Reconcile the Work API definitions with DSH's persistent task domain. ──
  await handle.sync();
  const reconcileEveryMs = options.reconcileEveryMs ?? 30_000;
  if (reconcileEveryMs !== 0) {
    const interval = Math.min(300_000, Math.max(1_000, reconcileEveryMs));
    reconciliationTimer = setInterval(() => {
      void handle.sync().catch(() => {
        // Do not log response bodies, URLs, or credential-bearing transport errors.
        ctx.logger.warn('workflow definition reconciliation failed; the next bounded retry remains scheduled');
      });
    }, interval);
    reconciliationTimer.unref?.();
  }
  return handle;
}

/** Reuse an existing storage stack and mount only missing services over the operator's persistent root. */
async function ensureStorageStack(ctx: Context, storageRoot?: string): Promise<void> {
  if (ctx.get('storage') === undefined) await ctx.plugin(Storage);
  if (ctx.get(storageBackendServiceKey('json')) === undefined) {
    if (storageRoot === undefined || storageRoot.trim().length === 0) {
      throw new Error('Persistent storageRoot is required when the shared DSH JSON backend is absent');
    }
    await ctx.plugin(StorageJson, { root: storageRoot });
  }
  if (ctx.get('storageDomain') === undefined) await ctx.plugin(StorageDomain, { backend: 'json' });
}

/** Resolve one static scheduler Session using DSH's actual persistence and AgentLoop services. */
async function ensureSchedulerAgent(
  ctx: Context,
  sessionId: ReturnType<typeof SessionId>,
): Promise<{ readonly agent: Agent; readonly ownedHandle?: { dispose(): Promise<void> } }> {
  const live = ctx.agents.get(sessionId);
  if (live !== undefined) return { agent: live };
  const snapshot = await ctx.sessionPersistence.stat(sessionId);
  if (snapshot === undefined) {
    const created = await ctx.agents.create({ sessionId, meta: { cwd: process.cwd() } });
    return { agent: created.agent, ownedHandle: created };
  }
  const resumed = await ctx.agents.resume({ resumeSessionId: sessionId });
  return { agent: resumed.agent, ownedHandle: resumed };
}

/** Insert only missing default workflow rows; operator edits survive every restart. */
async function seedWorkflowTemplates(store: WorkflowStore, templates: readonly WorkflowWrite[]): Promise<void> {
  const existing = new Set((await store.listWorkflows()).map(workflow => workflow.id));
  for (const template of templates) {
    if (existing.has(template.id)) continue;
    await store.putWorkflow(template);
    existing.add(template.id);
  }
}

/** Bring DSH's durable cron rows into agreement with enabled, configured workflow definitions. */
async function reconcileSchedules(
  ctx: Context,
  store: WorkflowStore,
  schedulerSessionId: ReturnType<typeof SessionId>,
): Promise<void> {
  const workflows: readonly WorkflowDefinition[] = [
    ...await store.listWorkflows(1),
    ...await store.listWorkflows(2),
  ];
  const desired = new Map<string, { readonly workflow: WorkflowDefinition; readonly triggerId: string; readonly schedule: WorkflowSchedule }>();
  for (const workflow of workflows) {
    if (!workflow.enabled || workflow.targets.length === 0) continue;
    if (workflow.version === 1) {
      if (workflow.schedule !== undefined) desired.set(scheduleKey(workflow.id, 'default'), {
        workflow, triggerId: 'default', schedule: workflow.schedule,
      });
      continue;
    }
    for (const trigger of workflow.triggers) desired.set(scheduleKey(workflow.id, trigger.id), {
      workflow, triggerId: trigger.id, schedule: trigger.schedule,
    });
    if (workflow.notifications.digest.enabled) desired.set(scheduleKey(workflow.id, DAILY_DIGEST_TRIGGER_ID), {
      workflow, triggerId: DAILY_DIGEST_TRIGGER_ID, schedule: workflow.notifications.digest.schedule,
    });
  }
  const catalog = await ctx.schedule.catalog();
  const owned = catalog.filter(entry => String(entry.sessionId) === String(schedulerSessionId));
  const matched = new Map<string, ScheduleCatalogEntry>();

  for (const entry of owned) {
    const marker = parseMarkerPrompt(entry.prompt);
    // Only recurring cron rows represent workflow definitions. A one-shot
    // marker may be a delivered Schedule receipt racing startup reconciliation.
    if (marker === undefined || entry.kind !== 'cron') continue;
    const key = scheduleKey(marker.workflowId, marker.triggerId);
    if (!desired.has(key)) {
      if (entry.status === 'active') await ctx.schedule.delete({ sessionId: schedulerSessionId, id: entry.id });
      continue;
    }
    if (entry.status !== 'active' || matched.has(key)) {
      if (entry.status === 'active') await ctx.schedule.delete({ sessionId: schedulerSessionId, id: entry.id });
      continue;
    }
    matched.set(key, entry);
  }

  for (const [key, target] of desired) {
    const { workflow, triggerId, schedule: desiredSchedule } = target;
    const existing = matched.get(key);
    const title = (workflow.version === 1 ? workflow.title : `${workflow.title} · ${triggerId}`).slice(0, 120);
    const prompt = renderMarkerPrompt(workflow.id, triggerId);
    const schedule = canonicalSchedule(desiredSchedule);
    if (existing === undefined) {
      await ctx.schedule.create(schedulerSessionId, {
        title, prompt, cron: { expression: schedule.expression, time_zone: schedule.timeZone },
      });
      continue;
    }
    const record = existing as ScheduleRecord;
    const sameSchedule = record.kind === 'cron' && record.expression === schedule.expression && record.timeZone === schedule.timeZone;
    const sameContent = record.title === title && record.prompt === prompt;
    if (sameSchedule && sameContent) continue;
    const update = await ctx.schedule.update({
      sessionId: schedulerSessionId,
      id: record.id,
      expected: record,
      title,
      prompt,
      ...(sameSchedule ? {} : { change: { kind: 'cron' as const, cron: { expression: schedule.expression, time_zone: schedule.timeZone } } }),
    });
    if ('updated' in update && !update.updated) {
      ctx.logger.warn(`workflow ${workflow.id} trigger ${triggerId} changed while it was being reconciled`);
    }
  }
}

function scheduleKey(workflowId: string, triggerId: string): string {
  return `${workflowId}\0${triggerId}`;
}

/** Convert a Work API schedule into the canonical expression and zone stored by DSH. */
function canonicalSchedule(schedule: WorkflowSchedule): { readonly expression: string; readonly timeZone: string } {
  return parseCronInput({ expression: schedule.expression, time_zone: schedule.timeZone });
}

/** Construct the fixed reminder content DSH persists and later returns to the source hook. */
function renderMarkerPrompt(workflowId: string, triggerId = 'default'): string {
  return `${WORKFLOW_MARKER}\n${JSON.stringify({ workflowId, triggerId })}`;
}

/** Parse only the exact private marker envelope used for Navigator workflow timer rows. */
function parseMarkerPrompt(prompt: string): WorkflowTimerMarker | undefined {
  if (!prompt.startsWith(`${WORKFLOW_MARKER}\n`)) return undefined;
  try {
    const value = JSON.parse(prompt.slice(WORKFLOW_MARKER.length + 1)) as unknown;
    if (!isRecord(value) || typeof value.workflowId !== 'string' || value.workflowId.length === 0) return undefined;
    return {
      workflowId: value.workflowId,
      triggerId: typeof value.triggerId === 'string' && value.triggerId.length > 0 ? value.triggerId : 'default',
    };
  } catch {
    return undefined;
  }
}

/** Decode one or a recurring batch of official DSH Schedule frames. */
function parseTimerOccurrences(message: UserMessage): TimerOccurrence[] {
  const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  const batchLine = text.split('\n').find(line => line.startsWith('reminders_json: '));
  if (batchLine !== undefined) {
    try {
      const batch = JSON.parse(batchLine.slice('reminders_json: '.length)) as unknown;
      if (!Array.isArray(batch)) return [];
      return batch.flatMap(value => {
        if (!isRecord(value) || typeof value.occurrence_at !== 'string' || typeof value.reminder_prompt !== 'string') return [];
        const marker = parseMarkerPrompt(value.reminder_prompt);
        return marker === undefined ? [] : [{ scheduledAt: value.occurrence_at, marker }];
      });
    } catch {
      return [];
    }
  }
  const occurrenceLine = text.split('\n').find(line => line.startsWith('occurrence_at: '));
  const promptLine = text.split('\n').find(line => line.startsWith('reminder_prompt_json: '));
  if (occurrenceLine === undefined || promptLine === undefined) return [];
  try {
    const scheduledAt = occurrenceLine.slice('occurrence_at: '.length);
    const prompt = JSON.parse(promptLine.slice('reminder_prompt_json: '.length)) as unknown;
    if (typeof prompt !== 'string') return [];
    const marker = parseMarkerPrompt(prompt);
    return marker === undefined ? [] : [{ scheduledAt, marker }];
  } catch {
    return [];
  }
}

/** Dispatch one DSH occurrence through durable workflow receipts and the existing idempotent executor. */
async function dispatchOccurrence(
  ctx: Context,
  options: WorkflowRuntimeOptions,
  occurrence: TimerOccurrence,
): Promise<void> {
  if (!Number.isFinite(Date.parse(occurrence.scheduledAt))) {
    ctx.logger.warn('workflow timer marker contained an invalid occurrence time');
    return;
  }
  const workflows: readonly WorkflowDefinition[] = [
    ...await options.store.listWorkflows(1),
    ...await options.store.listWorkflows(2),
  ];
  const workflow = workflows.find(candidate => candidate.id === occurrence.marker.workflowId);
  if (workflow === undefined || !workflow.enabled) return;
  if (workflow.version === 2) {
    if (occurrence.marker.triggerId === DAILY_DIGEST_TRIGGER_ID) {
      await dispatchDailyDigest(ctx, options, workflow, occurrence.scheduledAt);
      return;
    }
    const trigger = workflow.triggers.find(candidate => candidate.id === occurrence.marker.triggerId);
    if (trigger === undefined) return;
    await dispatchV2Occurrence(ctx, options, workflow, trigger, occurrence.scheduledAt);
    return;
  }
  if (occurrence.marker.triggerId !== 'default') return;
  const taskId = occurrenceTaskId(occurrence.marker.workflowId, occurrence.scheduledAt);
  const sessionId = occurrenceSessionId(occurrence.marker.workflowId, occurrence.scheduledAt);
  const history = await options.store.listScheduleEvents({ workflowId: workflow.id, limit: 100 });
  if (history.items.some(event => eventTriggerId(event) === 'default' && event.scheduledAt === occurrence.scheduledAt
    && (event.status === 'succeeded' || event.status === 'failed'))) return;
  const previous = previousRunState(history.items, occurrence.scheduledAt);
  if (workflow.targets.length === 0) {
    const errorCode = 'WORKFLOW_TARGETS_REQUIRED';
    const summary = 'Workflow has no configured targets.';
    await appendOccurrenceEvent(options.store, workflow.id, occurrence.scheduledAt, 'failed', {
      errorCode, taskId, sessionId, summary,
    });
    if (workflow.notifications.onFailure && shouldNotifyFailure(previous, errorCode)) {
      await enqueueWorkflowNotification(ctx, options, workflow, occurrence.scheduledAt, 'default', 'failure', summary, taskId);
    }
    return;
  }

  const readonlyPolicy = resolveWorkflowReadonlyPolicy(ctx, workflow);
  if (!readonlyPolicy.supported) {
    const errorCode = 'WORKFLOW_READONLY_TARGET_UNAVAILABLE';
    const summary = 'No supported read-only observation tool is available for every configured target.';
    await appendOccurrenceEvent(options.store, workflow.id, occurrence.scheduledAt, 'failed', {
      errorCode, taskId, sessionId, summary,
    });
    if (workflow.notifications.onFailure && shouldNotifyFailure(previous, errorCode)) {
      await enqueueWorkflowNotification(ctx, options, workflow, occurrence.scheduledAt, 'default', 'failure', summary, taskId);
    }
    return;
  }

  await appendOccurrenceEvent(options.store, workflow.id, occurrence.scheduledAt, 'queued', { taskId, sessionId });
  await appendOccurrenceEvent(options.store, workflow.id, occurrence.scheduledAt, 'running', { taskId, sessionId });

  try {
    const observedTargets = new Set<number>();
    const disposeReadonlyGuard = installWorkflowReadonlyGuard(ctx, readonlyPolicy, sessionId);
    const disposeObservationListener = ctx.on('tools/result', (execution, result) => {
      if (execution.agent === undefined || String(execution.agent.session.id) !== sessionId || result.isError) return;
      for (const target of readonlyPolicy.observationTargets) {
        if (!target.tools.has(execution.name)) continue;
        if (target.projectId !== undefined) {
          const args = isRecord(execution.arguments) ? execution.arguments : undefined;
          if (args?.projectId !== target.projectId) continue;
        }
        observedTargets.add(target.index);
      }
    });
    let outcome: WorkflowDispatchOutcome;
    try {
      outcome = await options.executeTask({
        taskId, sessionId, prompt: renderWorkflowPrompt(workflow, previous?.summary),
      });
    } finally {
      disposeReadonlyGuard();
      disposeObservationListener();
    }
    if (outcome.status !== 'completed') {
      const errorCode = outcome.status === 'aborted' ? 'EXECUTOR_ABORTED'
        : outcome.status === 'waiting_approval' || outcome.status === 'waiting_input' ? 'EXECUTOR_WAITING_FOR_INPUT'
          : 'EXECUTOR_FAILED';
      await appendOccurrenceEvent(options.store, workflow.id, occurrence.scheduledAt, 'failed', {
        errorCode, taskId, sessionId, summary: 'Workflow execution did not complete.',
      });
      if (workflow.notifications.onFailure && shouldNotifyFailure(previous, errorCode)) {
        await enqueueWorkflowNotification(ctx, options, workflow, occurrence.scheduledAt, 'default', 'failure',
          'Workflow execution did not complete.', taskId);
      }
      return;
    }
    if (readonlyPolicy.observationTargets.some(target => !observedTargets.has(target.index))) {
      const errorCode = 'WORKFLOW_OBSERVATION_REQUIRED';
      const summary = 'A successful target-bound read-only observation is required for every configured target.';
      await appendOccurrenceEvent(options.store, workflow.id, occurrence.scheduledAt, 'failed', {
        errorCode, taskId, sessionId, summary,
      });
      if (workflow.notifications.onFailure && shouldNotifyFailure(previous, errorCode)) {
        await enqueueWorkflowNotification(ctx, options, workflow, occurrence.scheduledAt, 'default', 'failure', summary, taskId);
      }
      return;
    }
    const result = parseWorkflowResult(outcome.output);
    await appendOccurrenceEvent(options.store, workflow.id, occurrence.scheduledAt, 'succeeded', {
      changed: result.changed, summary: result.summary, taskId, sessionId,
    });
    if (previous?.status === 'failed' && workflow.notifications.onRecovery) {
      await enqueueWorkflowNotification(ctx, options, workflow, occurrence.scheduledAt, 'default', 'recovery', result.summary, taskId);
    } else if (result.changed && workflow.notifications.onChange) {
      await enqueueWorkflowNotification(ctx, options, workflow, occurrence.scheduledAt, 'default', 'change', result.summary, taskId);
    }
  } catch (error: unknown) {
    const errorCode = error instanceof WorkflowResultError ? error.code : 'WORKFLOW_DISPATCH_FAILED';
    const summary = error instanceof WorkflowResultError ? error.message : 'Workflow execution failed before a valid result was recorded.';
    await appendOccurrenceEvent(options.store, workflow.id, occurrence.scheduledAt, 'failed', {
      errorCode, taskId, sessionId, summary,
    }).catch(() => undefined);
    if (workflow.notifications.onFailure && shouldNotifyFailure(previous, errorCode)) {
      await enqueueWorkflowNotification(ctx, options, workflow, occurrence.scheduledAt, 'default', 'failure', summary, taskId);
    }
    ctx.logger.warn(`workflow ${workflow.id} occurrence failed (${errorCode})`);
  }
}

/** Run one v2 observation, then dispatch each approved proposal as a separate task. */
async function dispatchV2Occurrence(
  ctx: Context,
  options: WorkflowRuntimeOptions,
  workflow: WorkflowV2Record,
  trigger: WorkflowV2Record['triggers'][number],
  scheduledAt: string,
): Promise<void> {
  const triggerId = trigger.id;
  const taskId = occurrenceTaskId(workflow.id, scheduledAt, triggerId);
  const sessionId = responsibilitySessionId(workflow.id);
  const occurrenceId = workflowOccurrenceId(workflow.id, triggerId, scheduledAt);
  const history = await listWorkflowEvents(options.store, workflow.id);
  const scopedHistory = history.filter(event => eventTriggerId(event) === triggerId);
  if (scopedHistory.some(event => event.scheduledAt === scheduledAt
    && (event.status === 'succeeded' || event.status === 'failed'))) return;
  const previous = previousRunState(scopedHistory, scheduledAt);
  if (isInFailureBackoff(scopedHistory, scheduledAt)) return;

  const baselineEstablished = scopedHistory.some(event => event.status === 'succeeded'
    && event.baseline === true && event.checkpoint?.complete !== false);
  const initialBaseline = !baselineEstablished;
  const priorCheckpoint = latestCheckpoint(scopedHistory);
  if (trigger.kind === 'github_incremental_poll'
    && (hasNoRunnableGitHubCursor(trigger, priorCheckpoint)
      || isInIncompleteSearchBackoff(scopedHistory, scheduledAt))) return;
  const readonlyPolicy = resolveWorkflowReadonlyPolicy(ctx, workflow);
  if (!readonlyPolicy.supported) {
    const errorCode = 'WORKFLOW_READONLY_TARGET_UNAVAILABLE';
    const summary = 'No supported read-only observation tool is available for every configured target.';
    await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'failed', {
      taskId, sessionId, triggerId, errorCode, summary,
    });
    if (workflow.notifications.onFailure && shouldNotifyFailure(previous, errorCode)) {
      await enqueueWorkflowNotification(ctx, options, workflow, scheduledAt, triggerId, 'failure', summary, taskId);
    }
    return;
  }

  const metadata = workflowTaskMetadata(workflow, triggerId, occurrenceId, scheduledAt);
  await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'queued', {
    taskId, sessionId, triggerId,
  });
  await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'running', {
    taskId, sessionId, triggerId,
  });

  try {
    const observedTargets = new Set<number>();
    const evidence: WorkflowEvidence[] = [];
    const githubSearchPages: GitHubSearchPageReceipt[] = [];
    const connectorTools = getConnectorToolCatalog(ctx);
    const disposeReadonlyGuard = installWorkflowReadonlyGuard(ctx, readonlyPolicy, sessionId);
    const disposeObservationListener = ctx.on('tools/result', (execution, result) => {
      if (execution.agent === undefined || String(execution.agent.session.id) !== sessionId || result.isError) return;
      const args = isRecord(execution.arguments) ? execution.arguments : undefined;
      for (const target of readonlyPolicy.observationTargets) {
        if (!target.tools.has(execution.name)) continue;
        if (target.projectId !== undefined && args?.projectId !== target.projectId) continue;
        if (target.repositoryId !== undefined
          && (!matchesRepositoryId(args?.repository_id, target.repositoryId) || args?.repository !== target.repository)) continue;
        observedTargets.add(target.index);
        if (evidence.length < 1_000) evidence.push({
          targetId: target.id,
          tool: execution.name,
          observedAt: new Date().toISOString(),
          resultDigest: digest(safeJson(result)),
        });
        if (trigger.kind === 'github_incremental_poll' && target.repositoryId !== undefined
          && target.bindingId !== undefined && args !== undefined) {
          const catalogEntry = connectorTools.find(entry => entry.name === execution.name
            && entry.providerId === 'github'
            && entry.bindingId === target.bindingId
            && entry.operationId === 'github.issues.search'
            && !entry.mutating);
          if (catalogEntry !== undefined && githubSearchPages.length < 1_000) {
            const page = parseGitHubSearchPage(result);
            if (page !== undefined) githubSearchPages.push({
              targetId: target.id,
              bindingId: target.bindingId,
              args,
              page,
            });
          }
        }
      }
    });
    let outcome: WorkflowDispatchOutcome;
    try {
      outcome = await options.executeTask({
        taskId,
        sessionId,
        prompt: renderWorkflowV2Prompt(workflow, trigger, previous?.summary, priorCheckpoint, initialBaseline),
        executionClass: 'background',
        metadata,
      });
    } finally {
      disposeReadonlyGuard();
      disposeObservationListener();
    }
    if (outcome.status !== 'completed') {
      const errorCode = outcome.status === 'aborted' ? 'EXECUTOR_ABORTED'
        : outcome.status === 'waiting_approval' || outcome.status === 'waiting_input' ? 'EXECUTOR_WAITING_FOR_INPUT'
          : 'EXECUTOR_FAILED';
      const summary = outcome.status === 'waiting_input' || outcome.status === 'waiting_approval'
        ? 'The responsibility is waiting for a decision or missing input.'
        : 'The responsibility observation did not complete.';
      await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'failed', {
        errorCode, taskId, sessionId, triggerId, summary, evidence,
        attentionKind: outcome.status === 'waiting_input' || outcome.status === 'waiting_approval' ? 'user_decision' : undefined,
      });
      if (outcome.status === 'waiting_input' || outcome.status === 'waiting_approval') {
        await enqueueWorkflowNotification(ctx, options, workflow, scheduledAt, triggerId, 'blocker', summary, taskId, 'user_decision');
      } else if (workflow.notifications.onFailure && shouldNotifyFailure(previous, errorCode)) {
        await enqueueWorkflowNotification(ctx, options, workflow, scheduledAt, triggerId, 'failure', summary, taskId);
      }
      return;
    }
    if (readonlyPolicy.observationTargets.some(target => !observedTargets.has(target.index))) {
      const errorCode = 'WORKFLOW_OBSERVATION_REQUIRED';
      const summary = 'A successful target-bound read-only observation is required for every configured target.';
      await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'failed', {
        errorCode, taskId, sessionId, triggerId, summary, evidence,
      });
      if (workflow.notifications.onFailure && shouldNotifyFailure(previous, errorCode)) {
        await enqueueWorkflowNotification(ctx, options, workflow, scheduledAt, triggerId, 'failure', summary, taskId);
      }
      return;
    }

    const result = parseWorkflowV2Result(outcome.output, workflow);
    const pollCheckpoint = trigger.kind === 'github_incremental_poll'
      ? deriveGitHubPollCheckpoint(workflow, trigger, scheduledAt, priorCheckpoint, githubSearchPages)
      : undefined;
    const checkpoint = pollCheckpoint?.checkpoint;
    const incompletePoll = trigger.kind === 'github_incremental_poll' && checkpoint?.complete !== true;
    let actionResults: WorkflowActionReceipt[] = [];
    const attention = result.attention ?? pollCheckpoint?.attention;

    if (!initialBaseline && !incompletePoll) {
      actionResults = await dispatchProposedActions(
        ctx, options, workflow, triggerId, occurrenceId, scheduledAt, taskId, result.actionRequests, history,
      );
    }
    const actionTaskIds = [...new Set(actionResults.filter(item => item.status !== 'skipped').map(item => item.taskId))];
    const operationIds = [...new Set(actionResults.flatMap(item => item.operationIds))];
    const failedAction = actionResults.some(item => item.status === 'failed');
    const actionAttention = actionResults.find(item => item.status === 'waiting' || item.status === 'unknown');
    const notificationAttention = attention ?? (actionAttention !== undefined
      ? { kind: actionAttention.status === 'waiting' ? 'user_decision' as const : 'service_or_auth_outage' as const,
          summary: actionAttention.status === 'waiting' ? 'An approved action is waiting for user input.' : 'An action outcome is uncertain and must be reconciled before retry.' }
      : undefined);
    const terminalStatus: WorkflowScheduleEvent['status'] = failedAction ? 'failed' : 'succeeded';
    const summary = redactSummary(notificationAttention?.summary ?? result.summary);
    const reportedChange = trigger.kind === 'github_incremental_poll'
      ? pollCheckpoint?.changed === true
      : result.changed;
    const meaningfulChange = reportedChange && !initialBaseline && !incompletePoll;
    await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, terminalStatus, {
      changed: meaningfulChange,
      summary,
      errorCode: failedAction ? 'WORKFLOW_ACTION_FAILED' : undefined,
      taskId,
      sessionId,
      triggerId,
      baseline: initialBaseline,
      evidence,
      operationIds,
      actionTaskIds,
      actionResults,
      checkpoint,
      attentionKind: notificationAttention?.kind,
    });

    if (notificationAttention !== undefined
      && workflow.notifications.immediateOn.includes(notificationAttention.kind)) {
      await enqueueWorkflowNotification(ctx, options, workflow, scheduledAt, triggerId, 'blocker', summary, taskId, notificationAttention.kind);
    } else if (previous?.status === 'failed' && workflow.notifications.onRecovery && !incompletePoll) {
      await enqueueWorkflowNotification(ctx, options, workflow, scheduledAt, triggerId, 'recovery', result.summary, taskId);
    } else if (meaningfulChange && workflow.notifications.onChange && !isQuietTime(scheduledAt, workflow.notifications.quietHours)) {
      await enqueueWorkflowNotification(ctx, options, workflow, scheduledAt, triggerId, 'change', result.summary, taskId);
    } else if (failedAction && workflow.notifications.onFailure && shouldNotifyFailure(previous, 'WORKFLOW_ACTION_FAILED')) {
      await enqueueWorkflowNotification(ctx, options, workflow, scheduledAt, triggerId, 'failure', summary, taskId);
    }
  } catch (error: unknown) {
    const errorCode = error instanceof WorkflowResultError ? error.code : 'WORKFLOW_DISPATCH_FAILED';
    const summary = error instanceof WorkflowResultError ? error.message : 'Workflow execution failed before a valid result was recorded.';
    await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'failed', {
      errorCode, taskId, sessionId, triggerId, summary,
    }).catch(() => undefined);
    if (workflow.notifications.onFailure && shouldNotifyFailure(previous, errorCode)) {
      const attentionKind = isAvailabilityError(errorCode) ? 'service_or_auth_outage' : undefined;
      if (attentionKind !== undefined) {
        await enqueueWorkflowNotification(ctx, options, workflow, scheduledAt, triggerId, 'blocker', summary, taskId, attentionKind);
      } else {
        await enqueueWorkflowNotification(ctx, options, workflow, scheduledAt, triggerId, 'failure', summary, taskId);
      }
    }
    ctx.logger.warn(`workflow ${workflow.id} trigger ${triggerId} failed (${errorCode})`);
  }
}

/** Run only proposals matching a canonical workflow grant, each in its own trusted child task. */
async function dispatchProposedActions(
  ctx: Context,
  options: WorkflowRuntimeOptions,
  workflow: WorkflowV2Record,
  triggerId: string,
  occurrenceId: string,
  scheduledAt: string,
  parentTaskId: string,
  requests: readonly ProposedWorkflowAction[],
  history: readonly WorkflowScheduleEvent[],
): Promise<WorkflowActionReceipt[]> {
  const receipts: WorkflowActionReceipt[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    const grant = workflow.actionPolicy.allowedActions.find(candidate => candidate.id === request.actionId);
    if (grant === undefined || grant.action !== request.actionType || !grant.targetIds.includes(request.targetId)) {
      throw new WorkflowResultError('WORKFLOW_ACTION_PROPOSAL_DENIED', 'A proposed action exceeded its configured action scope.');
    }
    const uniquenessKey = `${request.actionId}\0${request.targetId}\0${request.objective}`;
    if (seen.has(uniquenessKey)) continue;
    seen.add(uniquenessKey);
    const requestDigest = digest(uniquenessKey);
    const previous = history.flatMap(event => event.actionResults ?? []).find(item =>
      item.actionId === request.actionId && item.targetId === request.targetId && item.requestDigest === requestDigest);
    if (previous !== undefined) {
      const recovered = await reconcilePriorAction(options, previous);
      if (recovered !== undefined) {
        receipts.push(recovered);
        continue;
      }
    }

    const childTaskId = `workflow-action-${digest(`${occurrenceId}\0${request.actionId}\0${request.targetId}`).slice(0, 40)}`;
    const childSessionId = `workflow-action-session-${digest(`${occurrenceId}\0${request.actionId}\0${request.targetId}`).slice(0, 40)}`;
    const authorizationReceipt: WorkflowActionReceipt = {
      actionId: request.actionId,
      actionType: request.actionType,
      targetId: request.targetId,
      taskId: childTaskId,
      requestDigest,
      status: 'waiting',
      operationIds: [],
    };
    await appendActionAuthorizationEvent(
      options.store, workflow.id, triggerId, occurrenceId, scheduledAt, parentTaskId,
      childTaskId, childSessionId, authorizationReceipt,
    );
    const metadata = {
      source: 'workflow',
      workflowId: workflow.id,
      triggerId,
      occurrenceId,
      scheduledAt,
      authorizationRef: {
        kind: workflow.authorization.kind,
        threadBindingId: workflow.authorization.threadBindingId,
        ownerTaskId: workflow.authorization.ownerTaskId,
      },
      parentTaskId,
      actionId: grant.id,
      actionType: grant.action,
      targetId: request.targetId,
      permittedOperations: [...grant.permittedOperations],
      actionRequestDigest: requestDigest,
    };
    const outcome = await options.executeTask({
      taskId: childTaskId,
      sessionId: childSessionId,
      executionClass: 'background',
      metadata,
      prompt: renderWorkflowActionPrompt(workflow, grant, request),
    });
    const operationIds = await taskOperationIds(options, childTaskId);
    const status = await classifyActionOutcome(options, outcome, childTaskId, operationIds);
    receipts.push({
      actionId: grant.id,
      actionType: grant.action,
      targetId: request.targetId,
      taskId: childTaskId,
      requestDigest,
      status,
      operationIds,
    });
  }
  return receipts;
}

/** Persist authorization before the child can ask a connector provider for a write. */
async function appendActionAuthorizationEvent(
  store: WorkflowStore,
  workflowId: string,
  triggerId: string,
  occurrenceId: string,
  scheduledAt: string,
  parentTaskId: string,
  actionTaskId: string,
  sessionId: string,
  receipt: WorkflowActionReceipt,
): Promise<void> {
  const id = `workflow-auth-${digest(`${occurrenceId}\0${receipt.actionId}\0${receipt.targetId}`).slice(0, 40)}`;
  await store.appendScheduleEvent({
    id,
    workflowId,
    triggerId,
    scheduledAt,
    status: 'running',
    createdAt: scheduledAt,
    taskId: parentTaskId,
    sessionId,
    actionTaskIds: [actionTaskId],
    actionResults: [receipt],
  });
}

async function reconcilePriorAction(
  options: WorkflowRuntimeOptions,
  prior: WorkflowActionReceipt,
): Promise<WorkflowActionReceipt | undefined> {
  if (prior.status === 'waiting') return prior;
  if (prior.status === 'completed' && prior.operationIds.length > 0) return prior;
  if (prior.status === 'unknown' && prior.operationIds.length === 0) return prior;
  if (prior.operationIds.length === 0) return prior.status === 'failed' ? undefined : prior;
  if (options.store.getOperation === undefined) return { ...prior, status: 'unknown' };
  const states = await Promise.all(prior.operationIds.map(async id => {
    try {
      return await options.store.getOperation!(id);
    } catch {
      return undefined;
    }
  }));
  if (states.every((state, index) => state?.status === 'verified' && state.taskId === prior.taskId)) {
    if (states.every(state => state !== undefined && isPositiveWriteReceipt(state))) {
      return { ...prior, status: 'completed' };
    }
    return { ...prior, status: 'failed' };
  }
  if (states.some(state => state === undefined || state.status === 'started' || state.status === 'uncertain')) {
    return { ...prior, status: 'unknown' };
  }
  return prior.status === 'failed' ? undefined : { ...prior, status: 'unknown' };
}

async function taskOperationIds(options: WorkflowRuntimeOptions, taskId: string): Promise<string[]> {
  if (options.readTaskEvents === undefined) return [];
  const page = await options.readTaskEvents(taskId, 0);
  const ids = new Set<string>();
  for (const { event } of page.events) {
    if (event.type !== 'connector.operation.receipt.v1' || event.effect !== 'write'
      || event.taskId !== undefined && event.taskId !== taskId
      || typeof event.operationId !== 'string' || !/^[a-f0-9]{32}$/i.test(event.operationId)) continue;
    ids.add(event.operationId);
  }
  return [...ids];
}

async function classifyActionOutcome(
  options: WorkflowRuntimeOptions,
  outcome: WorkflowDispatchOutcome,
  taskId: string,
  operationIds: readonly string[],
): Promise<WorkflowActionReceipt['status']> {
  if (outcome.status === 'waiting_input' || outcome.status === 'waiting_approval' || outcome.status === 'awaiting_user_authorization') {
    return 'waiting';
  }
  if (outcome.status !== 'completed') return 'failed';
  if (operationIds.length === 0 || options.store.getOperation === undefined) return 'unknown';
  const states = await Promise.all(operationIds.map(async id => {
    try {
      return await options.store.getOperation!(id);
    } catch {
      return undefined;
    }
  }));
  if (states.some(state => state === undefined || state.status === 'started' || state.status === 'uncertain')) return 'unknown';
  if (states.some(state => state === undefined || state.taskId !== taskId || !isPositiveWriteReceipt(state))) return 'failed';
  return 'completed';
}

/** Build one daily digest from complete changed receipts since the preceding digest. */
async function dispatchDailyDigest(
  ctx: Context,
  options: WorkflowRuntimeOptions,
  workflow: WorkflowV2Record,
  scheduledAt: string,
): Promise<void> {
  const triggerId = DAILY_DIGEST_TRIGGER_ID;
  const events = await listWorkflowEvents(options.store, workflow.id);
  if (events.some(event => eventTriggerId(event) === triggerId && event.scheduledAt === scheduledAt
    && (event.status === 'succeeded' || event.status === 'failed'))) return;
  const previousDigest = events.filter(event => eventTriggerId(event) === triggerId && event.status === 'succeeded')
    .sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt))[0]?.scheduledAt;
  const changes = events.filter(event => eventTriggerId(event) !== triggerId
    && event.status === 'succeeded' && event.changed === true && event.baseline !== true
    && event.checkpoint?.complete !== false
    && (previousDigest === undefined || event.scheduledAt > previousDigest))
    .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
  const summaries = changes.slice(-10).map(event => redactSummary(event.summary ?? '')).filter(Boolean);
  const changed = summaries.length > 0;
  const summary = changed
    ? redactSummary(`Daily review: ${summaries.join(' | ')}`)
    : 'No material new changes or decisions since the previous daily review.';
  const taskId = workflow.authorization.ownerTaskId;
  await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'queued', { triggerId, taskId });
  await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'running', { triggerId, taskId });
  await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'succeeded', {
    triggerId, taskId, changed, summary,
  });
  if (changed && workflow.notifications.digest.enabled) {
    await enqueueWorkflowNotification(ctx, options, workflow, scheduledAt, triggerId, 'digest', summary, taskId);
  }
}

function isPositiveWriteReceipt(operation: WorkflowOperationState): boolean {
  return operation.status === 'verified'
    && operation.evidence.effect === 'write'
    && operation.evidence.outcome === 'verified'
    && operation.evidence.isError !== true;
}

function renderWorkflowActionPrompt(
  workflow: WorkflowV2Record,
  grant: WorkflowActionGrant,
  request: ProposedWorkflowAction,
): string {
  return [
    'Carry out this one owner-authorized source task using connector APIs only.',
    'Use only the repository, branch, path, issue, and operation scope in the grant. Do not merge, release, deploy, change production, or incur new spend.',
    'Read current provider state before writing. If an earlier write outcome is uncertain, reconcile it by a separate read before considering another write.',
    'Return a concise result and include the exact readback evidence. Do not claim success from an exit code alone.',
    `Responsibility: ${workflow.id} — ${workflow.title}`,
    `Approved grant: ${JSON.stringify(grant)}`,
    `Approved target: ${request.targetId}`,
    `Requested objective: ${request.objective}`,
  ].join('\n\n');
}

/** Append deterministic per-occurrence states so DSH duplicate delivery is idempotent at the Work API. */
async function appendOccurrenceEvent(
  store: WorkflowStore,
  workflowId: string,
  scheduledAt: string,
  status: WorkflowScheduleEvent['status'],
  extra: Pick<WorkflowScheduleEvent,
    'changed' | 'summary' | 'errorCode' | 'taskId' | 'sessionId' | 'triggerId' | 'baseline'
    | 'evidence' | 'operationIds' | 'actionTaskIds' | 'actionResults' | 'checkpoint' | 'attentionKind'>,
): Promise<void> {
  const triggerId = extra.triggerId ?? 'default';
  const occurrenceKey = triggerId === 'default' ? `${workflowId}\0${scheduledAt}` : `${workflowId}\0${triggerId}\0${scheduledAt}`;
  const id = `workflow-${digest(`${occurrenceKey}\0${status}`).slice(0, 48)}`;
  await store.appendScheduleEvent({
    id, workflowId, scheduledAt, status, createdAt: scheduledAt,
    ...(extra.triggerId === undefined ? {} : { triggerId: extra.triggerId }),
    ...(extra.baseline === undefined ? {} : { baseline: extra.baseline }),
    ...(extra.evidence === undefined ? {} : { evidence: extra.evidence }),
    ...(extra.operationIds === undefined ? {} : { operationIds: extra.operationIds }),
    ...(extra.actionTaskIds === undefined ? {} : { actionTaskIds: extra.actionTaskIds }),
    ...(extra.actionResults === undefined ? {} : { actionResults: extra.actionResults }),
    ...(extra.checkpoint === undefined ? {} : { checkpoint: extra.checkpoint }),
    ...(extra.attentionKind === undefined ? {} : { attentionKind: extra.attentionKind }),
    ...(extra.changed === undefined ? {} : { changed: extra.changed }),
    ...(extra.summary === undefined ? {} : { summary: extra.summary }),
    ...(extra.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
    ...(extra.taskId === undefined ? {} : { taskId: extra.taskId }),
    ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
  });
}

/** Stable executor task id makes repeated DSH inbox delivery resolve to one durable task. */
function occurrenceTaskId(workflowId: string, scheduledAt: string, triggerId = 'default'): string {
  const key = triggerId === 'default' ? `${workflowId}\0${scheduledAt}` : `${workflowId}\0${triggerId}\0${scheduledAt}`;
  return `workflow-${digest(key).slice(0, 40)}`;
}

/** Stable separate execution Session identity; the scheduler inbox Session is never reused. */
function occurrenceSessionId(workflowId: string, scheduledAt: string): string {
  return `workflow-run-${digest(`${workflowId}\0${scheduledAt}`).slice(0, 40)}`;
}

/** Keep one durable DSH context per responsibility, separate from foreground and timer sessions. */
function responsibilitySessionId(workflowId: string): string {
  return `workflow-session-${digest(workflowId).slice(0, 40)}`;
}

function eventTriggerId(event: WorkflowScheduleEvent): string {
  return event.triggerId ?? 'default';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Provide the newest successful summary as a baseline, but classify recovery from the latest terminal run. */
interface PreviousWorkflowRun {
  readonly status: 'succeeded' | 'failed';
  readonly summary?: string;
  readonly errorCode?: string;
}

function previousRunState(events: readonly WorkflowScheduleEvent[], scheduledAt: string): PreviousWorkflowRun | undefined {
  const prior = events.filter(event => Date.parse(event.scheduledAt) < Date.parse(scheduledAt));
  const successful = prior.filter(event => event.status === 'succeeded')
    .sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt))[0];
  const occurrenceTimes = [...new Set(prior.map(event => event.scheduledAt))].sort((left, right) => right.localeCompare(left));
  for (const occurrenceAt of occurrenceTimes) {
    const terminal = prior.find(event => event.scheduledAt === occurrenceAt
      && (event.status === 'succeeded' || event.status === 'failed'));
    if (terminal !== undefined) {
      return {
        status: terminal.status as 'succeeded' | 'failed',
        ...(successful?.summary === undefined ? {} : { summary: successful.summary }),
        ...(terminal.errorCode === undefined ? {} : { errorCode: terminal.errorCode }),
      };
    }
  }
  return successful === undefined ? undefined : { status: 'succeeded', summary: successful.summary };
}

async function listWorkflowEvents(store: WorkflowStore, workflowId: string): Promise<WorkflowScheduleEvent[]> {
  const events: WorkflowScheduleEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listScheduleEvents({
      workflowId,
      limit: 500,
      ...(cursor === undefined ? {} : { cursor }),
    });
    events.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return events;
}

function latestCheckpoint(events: readonly WorkflowScheduleEvent[]): WorkflowCheckpoint | undefined {
  return [...events]
    .filter(event => event.checkpoint !== undefined)
    .sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt))[0]?.checkpoint;
}

function isInFailureBackoff(events: readonly WorkflowScheduleEvent[], scheduledAt: string): boolean {
  const terminalFailures = events.filter(event => event.status === 'failed')
    .sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt));
  const latest = terminalFailures[0];
  if (latest === undefined || latest.errorCode === undefined) return false;
  let consecutive = 0;
  for (const event of events.filter(item => item.status === 'failed')
    .sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt))) {
    if (event.errorCode !== latest.errorCode) break;
    consecutive += 1;
  }
  const delayMs = Math.min(6 * 60 * 60 * 1_000, 5 * 60 * 1_000 * (2 ** Math.min(consecutive - 1, 10)));
  return Date.parse(scheduledAt) < Date.parse(latest.scheduledAt) + delayMs;
}

function hasNoRunnableGitHubCursor(
  trigger: WorkflowV2Record['triggers'][number],
  prior: WorkflowCheckpoint | undefined,
): boolean {
  if (trigger.kind !== 'github_incremental_poll' || prior === undefined || prior.complete) return false;
  const search = trigger.search;
  if (search === undefined) return false;
  return trigger.targetIds.every(targetId => {
    const queryDigest = githubSearchQueryDigest(targetId, search, prior.watermark, prior.windowEnd);
    const cursor = prior.repositories.find(item => item.targetId === targetId);
    if (cursor === undefined || cursor.queryDigest !== queryDigest) return false;
    return cursor.complete || cursor.blockedReason === 'result_limit' || cursor.blockedReason === 'missing_pages';
  });
}

function isInIncompleteSearchBackoff(events: readonly WorkflowScheduleEvent[], scheduledAt: string): boolean {
  const recent = events.filter(event => event.status === 'succeeded'
    && event.checkpoint?.complete === false
    && event.checkpoint.repositories.some(cursor => cursor.blockedReason === 'incomplete_results'))
    .sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt));
  const latest = recent[0];
  if (latest === undefined) return false;
  const latestBlocked = latest.checkpoint!.repositories
    .filter(cursor => cursor.blockedReason === 'incomplete_results')
    .map(cursor => `${cursor.targetId}\0${cursor.queryDigest}\0${cursor.pageCursor}`)
    .sort()
    .join('\0');
  let repeats = 0;
  for (const event of recent) {
    const blocked = event.checkpoint!.repositories
      .filter(cursor => cursor.blockedReason === 'incomplete_results')
      .map(cursor => `${cursor.targetId}\0${cursor.queryDigest}\0${cursor.pageCursor}`)
      .sort()
      .join('\0');
    if (blocked !== latestBlocked) break;
    repeats += 1;
  }
  const backoffMs = Math.min(6 * 60 * 60 * 1_000, 10 * 60 * 1_000 * (2 ** Math.min(repeats - 1, 10)));
  return Date.parse(scheduledAt) < Date.parse(latest.scheduledAt) + backoffMs;
}

function workflowOccurrenceId(workflowId: string, triggerId: string, scheduledAt: string): string {
  const key = triggerId === 'default'
    ? `${workflowId}\0${scheduledAt}`
    : `${workflowId}\0${triggerId}\0${scheduledAt}`;
  return `occ-${digest(key).slice(0, 40)}`;
}

/** Give the executor a constrained read-only task and a strict small result contract. */
function renderWorkflowPrompt(workflow: WorkflowRecord, previousSummary?: string): string {
  const config = JSON.stringify({
    id: workflow.id, title: workflow.title, description: workflow.description,
    instructions: workflow.instructions, targets: workflow.targets,
  });
  return [
    'Run one scheduled Navigator workflow using only its explicitly configured targets and currently available readonly tools.',
    'Do not write, delete, deploy, install packages, start jobs, incur workload charges, or send external messages.',
    'Compare observations to the prior successful baseline when one is supplied. Do not treat missing permission or missing targets as a clean result.',
    'Return exactly one JSON object with boolean `changed` and a concise `summary` string (maximum 400 characters). Do not wrap it in Markdown.',
    `Workflow: ${config}`,
    `Previous successful summary: ${previousSummary ?? '(none)'}`,
  ].join('\n\n');
}

/** Render the v2 observation task without exposing owner or delivery authority fields. */
function renderWorkflowV2Prompt(
  workflow: WorkflowV2Record,
  trigger: WorkflowV2Record['triggers'][number],
  previousSummary: string | undefined,
  checkpoint: WorkflowCheckpoint | undefined,
  initialBaseline: boolean,
): string {
  const config = JSON.stringify({
    id: workflow.id,
    title: workflow.title,
    goal: workflow.goal,
    instructions: workflow.instructions,
    trigger,
    targets: workflow.targets,
    actionGrants: workflow.actionPolicy.allowedActions,
  });
  const pollGuidance = trigger.kind === 'github_incremental_poll'
    ? [
      'Use github.issues.search with the exact state/query/labels/page size from this trigger. The host supplies updated_since, updated_until, and page_cursor; pass them through unchanged.',
      'Continue all contiguous next_cursor pages for each configured repository until the provider reports next_cursor=null, unless it reports incomplete/truncated results.',
      'Never claim the poll is complete. The host verifies every real page receipt and owns the watermark.',
    ]
    : [];
  const baselineGuidance = initialBaseline
    ? 'This is the initial baseline. Record current state and do not report historical changes or propose write actions until a complete baseline exists.'
    : 'Compare current state with the prior complete baseline and report only material new changes.';
  return [
    'Observe one Navigator responsibility using only read-only connector tools for its configured targets.',
    'Do not write, delete, deploy, install packages, start jobs, incur workload charges, or send external messages in this observation task.',
    'If the goal is blocked, a user decision is required, or service/auth is unavailable, return a structured attention item.',
    'Propose an action only by its exact configured actionId, actionType, and targetId. The host will run each proposal as a separate policy-checked child task.',
    'Return exactly one JSON object with `changed`, `summary`, `actionRequests`, and optional `attention`; do not return checkpoint/watermark/page state and do not wrap in Markdown.',
    ...pollGuidance,
    baselineGuidance,
    `Responsibility: ${config}`,
    `Previous successful summary: ${previousSummary ?? '(none)'}`,
    `Prior poll checkpoint: ${JSON.stringify(checkpoint ?? null)}`,
  ].join('\n\n');
}

/** Parse the stable model result and redact common secret-shaped values before persistence. */
function parseWorkflowResult(output: string): ParsedWorkflowResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new WorkflowResultError('WORKFLOW_RESULT_INVALID', 'Workflow returned an invalid result.');
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 2 || typeof parsed.changed !== 'boolean' || typeof parsed.summary !== 'string') {
    throw new WorkflowResultError('WORKFLOW_RESULT_INVALID', 'Workflow returned an invalid result.');
  }
  const summary = redactSummary(parsed.summary);
  if (!summary || parsed.summary.length > 400) throw new WorkflowResultError('WORKFLOW_RESULT_INVALID', 'Workflow returned an invalid summary.');
  return { changed: parsed.changed, summary };
}

function parseWorkflowV2Result(output: string, workflow: WorkflowV2Record): ParsedWorkflowV2Result {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new WorkflowResultError('WORKFLOW_RESULT_INVALID', 'Responsibility returned invalid structured output.');
  }
  if (!isRecord(parsed) || Object.keys(parsed).some(key => !['changed', 'summary', 'actionRequests', 'attention'].includes(key))
    || typeof parsed.changed !== 'boolean' || typeof parsed.summary !== 'string') {
    throw new WorkflowResultError('WORKFLOW_RESULT_INVALID', 'Responsibility returned invalid structured output.');
  }
  const summary = redactSummary(parsed.summary);
  if (!summary || parsed.summary.length > 400) throw new WorkflowResultError('WORKFLOW_RESULT_INVALID', 'Responsibility summary is invalid.');
  const actionRequestsRaw = parsed.actionRequests ?? [];
  if (!Array.isArray(actionRequestsRaw) || actionRequestsRaw.length > 100) {
    throw new WorkflowResultError('WORKFLOW_ACTION_PROPOSAL_INVALID', 'Action proposals must be a bounded array.');
  }
  const actionRequests: ProposedWorkflowAction[] = actionRequestsRaw.map(item => {
    if (!isRecord(item) || Object.keys(item).some(key => !['actionId', 'actionType', 'targetId', 'objective'].includes(key))) {
      throw new WorkflowResultError('WORKFLOW_ACTION_PROPOSAL_INVALID', 'Action proposal contains unsupported fields.');
    }
    const actionId = boundedResultText(item.actionId, 'actionId', 128);
    const targetId = boundedResultText(item.targetId, 'targetId', 512);
    const objective = redactSummary(boundedResultText(item.objective, 'objective', 1_000));
    const actionType = item.actionType;
    if (actionType !== 'draft_pull_request' && actionType !== 'rerun_source_ci' && actionType !== 'update_issue_progress') {
      throw new WorkflowResultError('WORKFLOW_ACTION_PROPOSAL_INVALID', 'Action proposal type is unsupported.');
    }
    const grant = workflow.actionPolicy.allowedActions.find(candidate => candidate.id === actionId);
    if (grant === undefined || grant.action !== actionType || !grant.targetIds.includes(targetId)) {
      throw new WorkflowResultError('WORKFLOW_ACTION_PROPOSAL_DENIED', 'A proposed action exceeded its configured action scope.');
    }
    return { actionId, actionType, targetId, objective };
  });
  const attention = parsed.attention === undefined ? undefined : parseWorkflowAttention(parsed.attention);
  return {
    changed: parsed.changed,
    summary,
    actionRequests,
    ...(attention === undefined ? {} : { attention }),
  };
}

function parseWorkflowAttention(value: unknown): WorkflowAttention {
  if (!isRecord(value) || Object.keys(value).some(key => !['kind', 'summary'].includes(key))) {
    throw new WorkflowResultError('WORKFLOW_ATTENTION_INVALID', 'Attention item is invalid.');
  }
  const kind = value.kind;
  if (kind !== 'blocked_goal' && kind !== 'user_decision' && kind !== 'service_or_auth_outage') {
    throw new WorkflowResultError('WORKFLOW_ATTENTION_INVALID', 'Attention kind is unsupported.');
  }
  const summary = redactSummary(boundedResultText(value.summary, 'attention.summary', 400));
  return { kind, summary };
}

function parseGitHubSearchPage(value: unknown): GitHubSearchPageResult | undefined {
  const envelope = asRecord(value);
  if (envelope === undefined) return undefined;
  // DSH ToolRuntime wraps the provider's declared output under `value` in its
  // `tools/result` event; direct unit fixtures may already pass that inner value.
  const output = asRecord(envelope.value) ?? envelope;
  const structured = asRecord(output.structuredContent);
  let result = structured;
  if (result?.businessResult !== undefined) result = asRecord(result.businessResult);
  if (result?.result !== undefined && asRecord(result.result) !== undefined) result = asRecord(result.result);
  if (result === undefined && Array.isArray(output.content)) {
    for (const block of output.content) {
      const row = asRecord(block);
      if (row?.type !== 'text' || typeof row.text !== 'string') continue;
      try {
        const parsed = asRecord(JSON.parse(row.text) as unknown);
        if (parsed?.issues !== undefined) { result = parsed; break; }
      } catch {
        continue;
      }
    }
  }
  if (result === undefined || !Array.isArray(result.issues)
    || typeof result.complete !== 'boolean' || typeof result.incomplete_results !== 'boolean'
    || typeof result.result_limit_reached !== 'boolean' || typeof result.truncated !== 'boolean'
    || typeof result.total_count !== 'number' || !Number.isSafeInteger(result.total_count) || result.total_count < 0
    || (result.next_cursor !== null && typeof result.next_cursor !== 'string')) return undefined;
  const echoedPageCursor = typeof result.page_cursor === 'number' && Number.isSafeInteger(result.page_cursor)
    ? String(result.page_cursor)
    : typeof result.page_cursor === 'string' ? result.page_cursor : undefined;
  if (echoedPageCursor === undefined) return undefined;
  const issues: Record<string, unknown>[] = [];
  for (const item of result.issues) {
    const issue = asRecord(item);
    if (issue === undefined) return undefined;
    issues.push(issue);
  }
  return {
    complete: result.complete,
    incompleteResults: result.incomplete_results,
    resultLimitReached: result.result_limit_reached,
    truncated: result.truncated,
    nextCursor: result.next_cursor as string | null,
    totalCount: result.total_count,
    echoedPageCursor,
    issues,
  };
}

/** Derive page completeness and watermarks from host-observed, scope-checked provider receipts. */
function deriveGitHubPollCheckpoint(
  workflow: WorkflowV2Record,
  trigger: WorkflowV2Record['triggers'][number],
  scheduledAt: string,
  prior: WorkflowCheckpoint | undefined,
  pages: readonly GitHubSearchPageReceipt[],
): GitHubPollAssessment {
  const search = trigger.search;
  if (search === undefined) throw new WorkflowResultError('WORKFLOW_SEARCH_CONFIG_MISSING', 'GitHub search filters are missing.');
  const resuming = prior !== undefined && !prior.complete;
  const windowEnd = resuming ? prior.windowEnd : utcSecond(scheduledAt);
  const watermark = prior?.watermark ?? null;
  const targetById = new Map(workflow.targets.map(target => [target.id, target]));
  const states = new Map<string, WorkflowRepositoryCursor>();
  for (const targetId of trigger.targetIds) {
    const target = targetById.get(targetId);
    if (target === undefined || target.kind !== 'github_repository' || target.bindingId === undefined) {
      throw new WorkflowResultError('WORKFLOW_GITHUB_TARGET_INVALID', 'A GitHub poll target is not bound to a configured connector.');
    }
    const updatedSince = watermark;
    const queryDigest = githubSearchQueryDigest(targetId, search, updatedSince, windowEnd);
    const previous = resuming ? prior.repositories.find(item => item.targetId === targetId) : undefined;
    states.set(targetId, previous !== undefined && previous.queryDigest === queryDigest
      ? previous
      : {
        targetId,
        pageCursor: '1',
        queryDigest,
        complete: false,
        hasChanges: false,
        pagesCollected: 0,
      });
  }
  const accepted = new Set<string>();
  let attention: WorkflowAttention | undefined;
  const orderedPages = [...pages].sort((left, right) => left.targetId.localeCompare(right.targetId)
    || Number(left.page.echoedPageCursor) - Number(right.page.echoedPageCursor));
  for (const receipt of orderedPages) {
    const target = targetById.get(receipt.targetId);
    const state = states.get(receipt.targetId);
    if (target === undefined || state === undefined || state.complete
      || state.blockedReason === 'result_limit' || state.blockedReason === 'missing_pages') continue;
    const searchArgs = receipt.args;
    const updatedSince = watermark;
    const argsMatch = receipt.bindingId === target.bindingId
      && matchesRepositoryId(searchArgs.repository_id, target.id)
      && searchArgs.repository === target.label
      && searchArgs.state === search.state
      && normalizeOptionalText(searchArgs.query) === (search.query ?? undefined)
      && normalizeLabels(searchArgs.labels) === normalizeLabels(search.labels)
      && searchArgs.limit === search.limit
      && searchArgs.updated_until === windowEnd
      && (updatedSince === null ? searchArgs.updated_since === undefined || searchArgs.updated_since === null
        : searchArgs.updated_since === updatedSince)
      && String(searchArgs.page_cursor ?? '') === state.pageCursor
      && receipt.page.echoedPageCursor === state.pageCursor;
    if (!argsMatch) continue;
    const seenKey = `${receipt.targetId}\0${state.pageCursor}`;
    if (accepted.has(seenKey)) continue;
    accepted.add(seenKey);

    if (state.pagesCollected !== Number(state.pageCursor) - 1) {
      states.set(receipt.targetId, { ...state, blockedReason: 'missing_pages' });
      attention ??= { kind: 'service_or_auth_outage', summary: 'GitHub pagination did not contain a contiguous page chain; the watermark was retained.' };
      continue;
    }
    if (state.totalCount !== undefined && state.totalCount !== receipt.page.totalCount) {
      states.set(receipt.targetId, { ...state, blockedReason: 'incomplete_results' });
      if (state.blockedReason !== 'incomplete_results') attention ??= { kind: 'service_or_auth_outage', summary: 'GitHub search totals changed during pagination; the current window was retained.' };
      continue;
    }
    if (receipt.page.incompleteResults) {
      states.set(receipt.targetId, { ...state, totalCount: receipt.page.totalCount, blockedReason: 'incomplete_results' });
      if (state.blockedReason !== 'incomplete_results') attention ??= { kind: 'service_or_auth_outage', summary: 'GitHub returned incomplete search results; the same page will be retried before advancing the watermark.' };
      continue;
    }
    if (receipt.page.resultLimitReached) {
      states.set(receipt.targetId, { ...state, totalCount: receipt.page.totalCount, blockedReason: 'result_limit' });
      attention ??= { kind: 'user_decision', summary: 'GitHub search reached its 1,000-result limit; narrow the configured state, query, or labels before the watermark can advance.' };
      continue;
    }
    const pageNumber = Number(state.pageCursor);
    const truncatedExpected = pageNumber > 1 || receipt.page.nextCursor !== null
      || receipt.page.incompleteResults || receipt.page.resultLimitReached || receipt.page.totalCount > search.limit;
    if (receipt.page.truncated !== truncatedExpected) {
      states.set(receipt.targetId, { ...state, totalCount: receipt.page.totalCount, blockedReason: 'incomplete_results' });
      if (state.blockedReason !== 'incomplete_results') attention ??= { kind: 'service_or_auth_outage', summary: 'GitHub page truncation metadata did not match its cursor and totals; the watermark was retained.' };
      continue;
    }
    const observedChange = receipt.page.issues.some(issue => {
      const updatedAt = issue.updated_at;
      if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) return false;
      return updatedSince === null || Date.parse(updatedAt) > Date.parse(updatedSince);
    });
    const pagesCollected = state.pagesCollected + 1;
    const hasChanges = state.hasChanges || observedChange;
    if (pageNumber === 1) {
      const singlePageComplete = receipt.page.nextCursor === null && !receipt.page.incompleteResults
        && !receipt.page.resultLimitReached && !receipt.page.truncated && receipt.page.totalCount <= search.limit;
      if (receipt.page.complete !== singlePageComplete) {
        states.set(receipt.targetId, { ...state, totalCount: receipt.page.totalCount, blockedReason: 'incomplete_results' });
        if (state.blockedReason !== 'incomplete_results') attention ??= { kind: 'service_or_auth_outage', summary: 'GitHub page completeness did not match its cursor and total count; the watermark was retained.' };
        continue;
      }
    } else if (receipt.page.complete) {
      states.set(receipt.targetId, { ...state, totalCount: receipt.page.totalCount, blockedReason: 'incomplete_results' });
      attention ??= { kind: 'service_or_auth_outage', summary: 'GitHub marked a later page as independently complete; the page chain was rejected.' };
      continue;
    }
    if (receipt.page.nextCursor !== null) {
      const next = Number(receipt.page.nextCursor);
      if (!Number.isSafeInteger(next) || next !== pageNumber + 1 || next > 1000) {
        states.set(receipt.targetId, { ...state, totalCount: receipt.page.totalCount, blockedReason: 'missing_pages' });
        attention ??= { kind: 'service_or_auth_outage', summary: 'GitHub returned a noncontiguous next-page cursor; the watermark was retained.' };
        continue;
      }
      states.set(receipt.targetId, {
        targetId: state.targetId,
        queryDigest: state.queryDigest,
        complete: false,
        hasChanges,
        pageCursor: String(next),
        pagesCollected,
        totalCount: receipt.page.totalCount,
      });
      continue;
    }
    const expectedPages = Math.max(1, Math.ceil(receipt.page.totalCount / search.limit));
    const pageChainComplete = receipt.page.totalCount <= 1000
      && pageNumber === expectedPages
      && pagesCollected === pageNumber
      && (pageNumber !== 1 || receipt.page.complete);
    if (!pageChainComplete) {
      states.set(receipt.targetId, {
        ...state,
        pagesCollected,
        totalCount: receipt.page.totalCount,
        hasChanges,
        blockedReason: 'missing_pages',
      });
      attention ??= { kind: 'user_decision', summary: 'GitHub search ended before a complete page chain was proven; the watermark was retained.' };
      continue;
    }
    states.set(receipt.targetId, {
      ...state,
      pagesCollected,
      totalCount: receipt.page.totalCount,
      hasChanges,
      complete: true,
    });
  }

  const repositoryCursors = [...states.values()];
  const complete = repositoryCursors.length === trigger.targetIds.length && repositoryCursors.every(item => item.complete);
  const checkpoint: WorkflowCheckpoint = {
    kind: 'github_issues_search',
    watermark: complete ? windowEnd : watermark,
    windowEnd,
    complete,
    repositories: complete ? [] : repositoryCursors,
  };
  const changed = complete && repositoryCursors.some(item => item.hasChanges);
  return {
    checkpoint,
    changed,
    ...(attention === undefined ? {} : { attention }),
  };
}

function githubSearchQueryDigest(
  targetId: string,
  search: NonNullable<WorkflowV2Record['triggers'][number]['search']>,
  updatedSince: string | null,
  updatedUntil: string,
): string {
  return digest(JSON.stringify({
    targetId,
    state: search.state,
    query: search.query ?? null,
    labels: [...search.labels].sort(),
    limit: search.limit,
    updatedSince,
    updatedUntil,
  }));
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeLabels(value: unknown): string {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return '';
  return [...value].sort().join('\0');
}

function matchesRepositoryId(value: unknown, expected: string): boolean {
  return value === expected
    || (typeof value === 'number' && Number.isSafeInteger(value) && String(value) === expected);
}

function utcSecond(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new WorkflowResultError('WORKFLOW_SCHEDULE_INVALID', 'Schedule timestamp is invalid.');
  return `${date.toISOString().slice(0, 19)}Z`;
}

function workflowTaskMetadata(
  workflow: WorkflowV2Record,
  triggerId: string,
  occurrenceId: string,
  scheduledAt: string,
): Readonly<Record<string, unknown>> {
  return {
    source: 'workflow',
    workflowId: workflow.id,
    triggerId,
    occurrenceId,
    scheduledAt,
    authorizationRef: {
      kind: workflow.authorization.kind,
      threadBindingId: workflow.authorization.threadBindingId,
      ownerTaskId: workflow.authorization.ownerTaskId,
    },
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable-tool-result]';
  }
}

function boundedResultText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\u0000')) {
    throw new WorkflowResultError('WORKFLOW_RESULT_INVALID', `${label} is invalid.`);
  }
  return value.trim();
}

/** Keep receipts compact and prevent common credential/token strings from entering workflow event rows. */
function redactSummary(value: string): string {
  return value.replace(/\b(authorization|api[_ -]?key|password|secret|token)\b\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(?:hf_[A-Za-z0-9]{16,}|AIza[\w-]{20,})\b/g, '[redacted]')
    .replace(/\s+/g, ' ').trim().slice(0, 400);
}

/** Emit only configured transitions; listeners can deliver these to product-owned notification channels. */
function emitNotification(ctx: Context, notification: WorkflowNotification): void {
  try {
    ctx.emit('workflow/notification', notification);
  } catch {
    ctx.logger.warn(`workflow ${notification.workflowId} notification listener failed`);
  }
}

const RECORDED_NOTICES = new WeakMap<Context, Set<string>>();

/** Retry outbox writes from durable terminal events, including after a host restart. */
async function reconcileWorkflowNotifications(ctx: Context, options: WorkflowRuntimeOptions): Promise<void> {
  const store = options.store;
  const workflows: readonly WorkflowDefinition[] = [
    ...await store.listWorkflows(1),
    ...await store.listWorkflows(2),
  ];
  for (const workflow of workflows) {
    const events = await listWorkflowEvents(store, workflow.id);
    const terminals = new Map<string, WorkflowScheduleEvent>();
    for (const event of events) {
      if (event.status !== 'failed' && event.status !== 'succeeded') continue;
      const key = scheduleKey(eventTriggerId(event), event.scheduledAt);
      const existing = terminals.get(key);
      if (existing === undefined || event.status === 'failed') terminals.set(key, event);
    }
    const triggerIds = new Set([...terminals.values()].map(event => eventTriggerId(event)));
    for (const triggerId of triggerIds) {
      const scoped = [...terminals.values()].filter(event => eventTriggerId(event) === triggerId)
        .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
      let previous: PreviousWorkflowRun | undefined;
      for (const event of scoped) {
        const eventSummary = event.summary ?? 'Workflow occurrence finished.';
        let kind: WorkflowNotificationKind | undefined;
        let attentionKind: WorkflowAttentionKind | undefined;
        if (workflow.version === 1) {
          if (event.status === 'failed') {
            if (workflow.notifications.onFailure && shouldNotifyFailure(previous, event.errorCode ?? 'WORKFLOW_DISPATCH_FAILED')) kind = 'failure';
          } else if (previous?.status === 'failed' && workflow.notifications.onRecovery) {
            kind = 'recovery';
          } else if (event.changed && workflow.notifications.onChange) {
            kind = 'change';
          }
        } else if (event.attentionKind !== undefined && workflow.notifications.immediateOn.includes(event.attentionKind)) {
          kind = 'blocker';
          attentionKind = event.attentionKind;
        } else if (triggerId === DAILY_DIGEST_TRIGGER_ID && event.changed && workflow.notifications.digest.enabled) {
          kind = 'digest';
        } else if (event.status === 'failed') {
          if (isAvailabilityError(event.errorCode ?? '') && workflow.notifications.immediateOn.includes('service_or_auth_outage')) {
            kind = 'blocker';
            attentionKind = 'service_or_auth_outage';
          } else if (workflow.notifications.onFailure && shouldNotifyFailure(previous, event.errorCode ?? 'WORKFLOW_DISPATCH_FAILED')
            && !isQuietTime(event.scheduledAt, workflow.notifications.quietHours)) {
            kind = 'failure';
          }
        } else if (previous?.status === 'failed' && workflow.notifications.onRecovery
          && !isQuietTime(event.scheduledAt, workflow.notifications.quietHours)) {
          kind = 'recovery';
        } else if (event.changed && event.baseline !== true && event.checkpoint?.complete !== false
          && workflow.notifications.onChange && !isQuietTime(event.scheduledAt, workflow.notifications.quietHours)) {
          kind = 'change';
        }
        if (kind !== undefined) {
          const taskId = event.taskId ?? (workflow.version === 2
            ? workflow.authorization.ownerTaskId
            : occurrenceTaskId(workflow.id, event.scheduledAt, triggerId));
          await enqueueWorkflowNotification(ctx, options, workflow,
            event.scheduledAt, triggerId, kind, eventSummary, taskId, attentionKind);
        }
        previous = {
          status: event.status as 'succeeded' | 'failed',
          ...(event.summary === undefined ? {} : { summary: event.summary }),
          ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
        };
      }
    }
  }
}

/** Persist a quiet-by-default transition before observers can enqueue product delivery. */
async function enqueueWorkflowNotification(
  ctx: Context,
  options: Pick<WorkflowRuntimeOptions, 'store' | 'projectTeamsNotification'>,
  workflow: WorkflowDefinition,
  scheduledAt: string,
  triggerId: string,
  kind: WorkflowNotificationKind,
  summary: string,
  taskId: string,
  attentionKind?: WorkflowAttentionKind,
): Promise<void> {
  const occurrenceId = workflowOccurrenceId(workflow.id, triggerId, scheduledAt);
  const type: WorkflowOutboxType = kind === 'change' ? 'workflow.change'
    : kind === 'failure' ? 'workflow.failure'
      : kind === 'recovery' ? 'workflow.recovery'
        : kind === 'digest' ? 'workflow.digest' : 'workflow.blocker';
  const deduplicationKey = `workflow:${workflow.id}:${occurrenceId}:${kind}`;
  let recorded = RECORDED_NOTICES.get(ctx);
  if (recorded === undefined) {
    recorded = new Set();
    RECORDED_NOTICES.set(ctx, recorded);
  }
  if (recorded.has(deduplicationKey)) return;
  try {
    const safeSummary = redactSummary(summary);
    const receipt = await options.store.enqueueNotification({
      deduplicationKey,
      type,
      payload: {
        workflowId: workflow.id,
        occurrenceId,
        ...(triggerId === 'default' ? {} : { triggerId }),
        summary: safeSummary,
        taskId,
      },
    });
    let teamsDuplicate = true;
    if (workflow.version === 2 && options.projectTeamsNotification !== undefined) {
      const notice: WorkflowNotification = {
        workflowId: workflow.id,
        occurrenceId,
        triggerId,
        deduplicationKey,
        title: workflow.title,
        kind,
        scheduledAt,
        summary: safeSummary,
        taskId,
        ...(attentionKind === undefined ? {} : { attentionKind }),
      };
      const request = await options.projectTeamsNotification(notice);
      if (request === undefined) throw new Error('No verified responsibility thread is available for this notice');
      const teamsReceipt = await options.store.enqueueTeamsNotification(workflow.id, request);
      teamsDuplicate = teamsReceipt.duplicate;
    }
    recorded.add(deduplicationKey);
    if (!receipt.duplicate || !teamsDuplicate) emitNotification(ctx, {
      workflowId: workflow.id,
      occurrenceId,
      triggerId,
      deduplicationKey,
      title: workflow.title,
      kind,
      scheduledAt,
      summary: safeSummary,
      taskId,
      ...(attentionKind === undefined ? {} : { attentionKind }),
    });
  } catch {
    ctx.logger.warn(`workflow ${workflow.id} notification outbox write failed`);
  }
}

function isQuietTime(timestamp: string, quietHours: WorkflowV2Record['notifications']['quietHours']): boolean {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: quietHours.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  const minute = Number(parts.find(part => part.type === 'minute')?.value);
  const start = parseMinutes(quietHours.start);
  const end = parseMinutes(quietHours.end);
  const current = hour * 60 + minute;
  return start > end ? current >= start || current < end : current >= start && current < end;
}

function parseMinutes(value: string): number {
  const [hourText, minuteText] = value.split(':');
  return Number(hourText) * 60 + Number(minuteText);
}

function isAvailabilityError(value: string): boolean {
  return /AUTH|CONNECTOR|UNAVAILABLE|UPSTREAM|TIMEOUT|RATE|429|PERSISTENCE/u.test(value);
}

/** Suppress a repeated terminal failure while still reporting a new failure transition. */
function shouldNotifyFailure(previous: PreviousWorkflowRun | undefined, errorCode: string): boolean {
  return previous?.status !== 'failed' || previous.errorCode !== errorCode;
}

class WorkflowResultError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkflowResultError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
