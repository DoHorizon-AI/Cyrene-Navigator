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
import type {
  WorkflowRecord,
  WorkflowSchedule,
  WorkflowScheduleEvent,
  WorkflowOutboxType,
  WorkflowStore,
  WorkflowWrite,
} from './store.js';
import { loadDefaultWorkflowTemplates } from './store.js';
import { installWorkflowReadonlyGuard, resolveWorkflowReadonlyPolicy } from './readonly.js';

/** Exact executor input for a durable workflow occurrence. */
export interface WorkflowDispatchRequest {
  readonly taskId: string;
  readonly sessionId: string;
  readonly prompt: string;
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
export type WorkflowNotificationKind = 'change' | 'failure' | 'recovery';

/** Credential-free event published after a meaningful workflow transition. */
export interface WorkflowNotification {
  readonly workflowId: string;
  readonly title: string;
  readonly kind: WorkflowNotificationKind;
  readonly scheduledAt: string;
  readonly summary: string;
  readonly taskId?: string;
}

/** Runtime dependencies; timer storage remains owned by the DSH storage domain. */
export interface WorkflowRuntimeOptions {
  readonly store: WorkflowStore;
  readonly executeTask: (request: WorkflowDispatchRequest) => Promise<WorkflowDispatchOutcome>;
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
}

interface TimerOccurrence {
  readonly scheduledAt: string;
  readonly marker: WorkflowTimerMarker;
}

interface ParsedWorkflowResult {
  readonly changed: boolean;
  readonly summary: string;
}

const WORKFLOW_MARKER = '[CYRENE_WORKFLOW_TIMER_V1]';
const DEFAULT_SCHEDULER_SESSION_ID = 'navigator-workflow-scheduler-v1';
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
      .then(() => reconcileWorkflowNotifications(ctx, options.store));
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
  const workflows = await store.listWorkflows();
  const desired = new Map(workflows
    .filter(workflow => workflow.enabled && workflow.schedule !== undefined && workflow.targets.length > 0)
    .map(workflow => [workflow.id, workflow]));
  const catalog = await ctx.schedule.catalog();
  const owned = catalog.filter(entry => String(entry.sessionId) === String(schedulerSessionId));
  const matched = new Map<string, ScheduleCatalogEntry>();

  for (const entry of owned) {
    const marker = parseMarkerPrompt(entry.prompt);
    // Only recurring cron rows represent workflow definitions. A one-shot
    // marker may be a delivered Schedule receipt racing startup reconciliation.
    if (marker === undefined || entry.kind !== 'cron') continue;
    if (!desired.has(marker.workflowId)) {
      if (entry.status === 'active') await ctx.schedule.delete({ sessionId: schedulerSessionId, id: entry.id });
      continue;
    }
    if (entry.status !== 'active' || matched.has(marker.workflowId)) {
      if (entry.status === 'active') await ctx.schedule.delete({ sessionId: schedulerSessionId, id: entry.id });
      continue;
    }
    matched.set(marker.workflowId, entry);
  }

  for (const [workflowId, workflow] of desired) {
    const existing = matched.get(workflowId);
    const prompt = renderMarkerPrompt(workflowId);
    const schedule = canonicalSchedule(workflow.schedule!);
    if (existing === undefined) {
      await ctx.schedule.create(schedulerSessionId, {
        title: workflow.title.slice(0, 120), prompt, cron: { expression: schedule.expression, time_zone: schedule.timeZone },
      });
      continue;
    }
    const record = existing as ScheduleRecord;
    const sameSchedule = record.kind === 'cron' && record.expression === schedule.expression && record.timeZone === schedule.timeZone;
    const sameContent = record.title === workflow.title.slice(0, 120) && record.prompt === prompt;
    if (sameSchedule && sameContent) continue;
    const update = await ctx.schedule.update({
      sessionId: schedulerSessionId,
      id: record.id,
      expected: record,
      title: workflow.title.slice(0, 120),
      prompt,
      ...(sameSchedule ? {} : { change: { kind: 'cron' as const, cron: { expression: schedule.expression, time_zone: schedule.timeZone } } }),
    });
    if ('updated' in update && !update.updated) {
      ctx.logger.warn(`workflow ${workflow.id} schedule changed while it was being reconciled`);
    }
  }
}

/** Convert a Work API schedule into the canonical expression and zone stored by DSH. */
function canonicalSchedule(schedule: WorkflowSchedule): { readonly expression: string; readonly timeZone: string } {
  return parseCronInput({ expression: schedule.expression, time_zone: schedule.timeZone });
}

/** Construct the fixed reminder content DSH persists and later returns to the source hook. */
function renderMarkerPrompt(workflowId: string): string {
  return `${WORKFLOW_MARKER}\n${JSON.stringify({ workflowId })}`;
}

/** Parse only the exact private marker envelope used for Navigator workflow timer rows. */
function parseMarkerPrompt(prompt: string): WorkflowTimerMarker | undefined {
  if (!prompt.startsWith(`${WORKFLOW_MARKER}\n`)) return undefined;
  try {
    const value = JSON.parse(prompt.slice(WORKFLOW_MARKER.length + 1)) as unknown;
    if (!isRecord(value) || typeof value.workflowId !== 'string' || value.workflowId.length === 0) return undefined;
    return { workflowId: value.workflowId };
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
  const workflows = await options.store.listWorkflows();
  const workflow = workflows.find(candidate => candidate.id === occurrence.marker.workflowId);
  const taskId = occurrenceTaskId(occurrence.marker.workflowId, occurrence.scheduledAt);
  const sessionId = occurrenceSessionId(occurrence.marker.workflowId, occurrence.scheduledAt);
  if (workflow === undefined || !workflow.enabled) return;
  const history = await options.store.listScheduleEvents({ workflowId: workflow.id, limit: 100 });
  if (history.items.some(event => event.scheduledAt === occurrence.scheduledAt
    && (event.status === 'succeeded' || event.status === 'failed'))) return;
  const previous = previousRunState(history.items, occurrence.scheduledAt);
  if (workflow.targets.length === 0) {
    const errorCode = 'WORKFLOW_TARGETS_REQUIRED';
    const summary = 'Workflow has no configured targets.';
    await appendOccurrenceEvent(options.store, workflow.id, occurrence.scheduledAt, 'failed', {
      errorCode, taskId, sessionId, summary,
    });
    if (workflow.notifications.onFailure && shouldNotifyFailure(previous, errorCode)) {
      await enqueueWorkflowNotification(ctx, options.store, workflow, occurrence.scheduledAt, 'failure', summary, taskId);
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
      await enqueueWorkflowNotification(ctx, options.store, workflow, occurrence.scheduledAt, 'failure', summary, taskId);
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
        await enqueueWorkflowNotification(ctx, options.store, workflow, occurrence.scheduledAt, 'failure',
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
        await enqueueWorkflowNotification(ctx, options.store, workflow, occurrence.scheduledAt, 'failure', summary, taskId);
      }
      return;
    }
    const result = parseWorkflowResult(outcome.output);
    await appendOccurrenceEvent(options.store, workflow.id, occurrence.scheduledAt, 'succeeded', {
      changed: result.changed, summary: result.summary, taskId, sessionId,
    });
    if (previous?.status === 'failed' && workflow.notifications.onRecovery) {
      await enqueueWorkflowNotification(ctx, options.store, workflow, occurrence.scheduledAt, 'recovery', result.summary, taskId);
    } else if (result.changed && workflow.notifications.onChange) {
      await enqueueWorkflowNotification(ctx, options.store, workflow, occurrence.scheduledAt, 'change', result.summary, taskId);
    }
  } catch (error: unknown) {
    const errorCode = error instanceof WorkflowResultError ? error.code : 'WORKFLOW_DISPATCH_FAILED';
    const summary = error instanceof WorkflowResultError ? error.message : 'Workflow execution failed before a valid result was recorded.';
    await appendOccurrenceEvent(options.store, workflow.id, occurrence.scheduledAt, 'failed', {
      errorCode, taskId, sessionId, summary,
    }).catch(() => undefined);
    if (workflow.notifications.onFailure && shouldNotifyFailure(previous, errorCode)) {
      await enqueueWorkflowNotification(ctx, options.store, workflow, occurrence.scheduledAt, 'failure', summary, taskId);
    }
    ctx.logger.warn(`workflow ${workflow.id} occurrence failed (${errorCode})`);
  }
}

/** Append deterministic per-occurrence states so DSH duplicate delivery is idempotent at the Work API. */
async function appendOccurrenceEvent(
  store: WorkflowStore,
  workflowId: string,
  scheduledAt: string,
  status: WorkflowScheduleEvent['status'],
  extra: Pick<WorkflowScheduleEvent, 'changed' | 'summary' | 'errorCode' | 'taskId' | 'sessionId'>,
): Promise<void> {
  const id = `workflow-${digest(`${workflowId}\0${scheduledAt}\0${status}`).slice(0, 48)}`;
  await store.appendScheduleEvent({
    id, workflowId, scheduledAt, status, createdAt: scheduledAt,
    ...(extra.changed === undefined ? {} : { changed: extra.changed }),
    ...(extra.summary === undefined ? {} : { summary: extra.summary }),
    ...(extra.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
    ...(extra.taskId === undefined ? {} : { taskId: extra.taskId }),
    ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
  });
}

/** Stable executor task id makes repeated DSH inbox delivery resolve to one durable task. */
function occurrenceTaskId(workflowId: string, scheduledAt: string): string {
  return `workflow-${digest(`${workflowId}\0${scheduledAt}`).slice(0, 40)}`;
}

/** Stable separate execution Session identity; the scheduler inbox Session is never reused. */
function occurrenceSessionId(workflowId: string, scheduledAt: string): string {
  return `workflow-run-${digest(`${workflowId}\0${scheduledAt}`).slice(0, 40)}`;
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
async function reconcileWorkflowNotifications(ctx: Context, store: WorkflowStore): Promise<void> {
  for (const workflow of await store.listWorkflows()) {
    const events: WorkflowScheduleEvent[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listScheduleEvents({ workflowId: workflow.id, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      events.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    const terminals = new Map<string, WorkflowScheduleEvent>();
    for (const event of events) {
      if (event.status !== 'failed' && event.status !== 'succeeded') continue;
      const existing = terminals.get(event.scheduledAt);
      if (existing === undefined || event.status === 'failed') terminals.set(event.scheduledAt, event);
    }
    let previous: PreviousWorkflowRun | undefined;
    let successfulSummary: string | undefined;
    for (const event of [...terminals.values()].sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt))) {
      let kind: WorkflowNotificationKind | undefined;
      if (event.status === 'failed') {
        if (workflow.notifications.onFailure && shouldNotifyFailure(previous, event.errorCode ?? 'WORKFLOW_DISPATCH_FAILED')) kind = 'failure';
      } else if (previous?.status === 'failed' && workflow.notifications.onRecovery) {
        kind = 'recovery';
      } else if (event.changed && workflow.notifications.onChange) {
        kind = 'change';
      }
      if (kind !== undefined) {
        await enqueueWorkflowNotification(ctx, store, workflow, event.scheduledAt, kind,
          event.summary ?? 'Workflow occurrence finished.', event.taskId ?? occurrenceTaskId(workflow.id, event.scheduledAt));
      }
      if (event.status === 'succeeded') successfulSummary = event.summary;
      previous = {
        status: event.status as 'succeeded' | 'failed',
        ...(successfulSummary === undefined ? {} : { summary: successfulSummary }),
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
      };
    }
  }
}

/** Persist a quiet-by-default transition before observers can enqueue product delivery. */
async function enqueueWorkflowNotification(
  ctx: Context,
  store: WorkflowStore,
  workflow: WorkflowRecord,
  scheduledAt: string,
  kind: WorkflowNotificationKind,
  summary: string,
  taskId: string,
): Promise<void> {
  const occurrenceId = `occ-${digest(`${workflow.id}\0${scheduledAt}`).slice(0, 40)}`;
  const type: WorkflowOutboxType = kind === 'change' ? 'workflow.change'
    : kind === 'failure' ? 'workflow.failure' : 'workflow.recovery';
  const deduplicationKey = `workflow:${workflow.id}:${occurrenceId}:${kind}`;
  let recorded = RECORDED_NOTICES.get(ctx);
  if (recorded === undefined) {
    recorded = new Set();
    RECORDED_NOTICES.set(ctx, recorded);
  }
  if (recorded.has(deduplicationKey)) return;
  try {
    const receipt = await store.enqueueNotification({
      deduplicationKey,
      type,
      payload: { workflowId: workflow.id, occurrenceId, summary: redactSummary(summary), taskId },
    });
    recorded.add(deduplicationKey);
    if (!receipt.duplicate) {
      emitNotification(ctx, { workflowId: workflow.id, title: workflow.title, kind, scheduledAt, summary: redactSummary(summary), taskId });
    }
  } catch {
    ctx.logger.warn(`workflow ${workflow.id} notification outbox write failed`);
  }
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
