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
  WorkflowAutomationEventWrite,
  WorkflowAutomationEventNoticeRequest,
  WorkflowObservationSource,
  WorkflowRecord,
  WorkflowRepositoryCursor,
  WorkflowSchedule,
  WorkflowScheduleEvent,
  WorkflowV2Record,
  WorkflowV3Record,
  WorkflowV3Trigger,
  WorkflowSourceCheckpoint,
  WorkflowSourceCursor,
  WorkflowSourceState,
  WorkflowSourcePageReceipt,
  WorkflowSourceTaskReceipt,
  WorkflowSourceObservation,
  WorkflowOutboxType,
  WorkflowOperationState,
  WorkflowStore,
  WorkflowTeamsNoticeRequest,
  WorkflowWrite,
  WorkflowSourceErrorReceipt,
} from './store.js';
import { validateWorkflowAutomationEvent } from './store.js';
import type { WorkStateStore } from '../work-state-client.js';
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

/** Bounded input for one source-specific page read within a frozen poll window. */
export interface WorkflowObservationPageRequest {
  readonly source: WorkflowObservationSource;
  readonly ownerActorId: string;
  readonly target: { readonly id: string; readonly kind: string; readonly bindingId: string; readonly label?: string };
  readonly pageSize: number;
  readonly pageCursor: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string;
  readonly signal: AbortSignal;
}

/** Fixed registered connector invocation available only inside the active host-owned Work Task. */
export interface WorkflowObservationExecutionContext {
  readonly invokeConnectorTool: (request: {
    readonly bindingId: string;
    readonly providerId: string;
    readonly toolId: string;
    readonly operationId: string;
    readonly resourceProjection: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal;
  }) => Promise<unknown>;
}

/** Classified provider failure; no vendor response body crosses into Work or notifications. */
export interface WorkflowObservationPageError {
  readonly code: 'not_configured' | 'forbidden' | 'unavailable' | 'timeout' | 'invalid' | 'partial';
}

/** One bounded normalized page from a fixed connector or host-native observation adapter. */
export interface WorkflowObservationPage {
  readonly source: WorkflowObservationSource;
  readonly observedAt: number;
  readonly pageCursor: string | null;
  readonly nextCursor: string | null;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly observations: readonly WorkflowSourceObservation[];
  readonly error?: WorkflowObservationPageError;
}

/** Source driver port; implementations must use fixed host configuration and fail closed. */
export interface WorkflowObservationSourceDriver {
  readonly source: WorkflowObservationSource;
  pollPage(
    request: WorkflowObservationPageRequest,
    context: WorkflowObservationExecutionContext,
  ): Promise<WorkflowObservationPage>;
}

/** Durable host task fields for deterministic source calls. */
export interface WorkflowFixedToolTaskRequest {
  readonly taskId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
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
  /** Run fixed native connector calls in a durable Work Task without invoking an LLM. */
  readonly executeFixedToolTask?: (
    request: WorkflowFixedToolTaskRequest,
    execute: (agent: Agent, signal: AbortSignal) => Promise<string>,
    actorAadObjectId?: string,
    actorWorkState?: WorkStateStore,
  ) => Promise<WorkflowDispatchOutcome>;
  /** Host-owned source adapters for fixed Product/health observations not registered as tool providers. */
  readonly sourceDrivers?: readonly WorkflowObservationSourceDriver[];
  /** Execute one fixed registered provider tool inside the already active durable Work Task. */
  readonly invokeObservationConnectorTool?: (
    agent: Agent,
    request: Parameters<WorkflowObservationExecutionContext['invokeConnectorTool']>[0],
  ) => Promise<unknown>;
  /** Actor-owned Work and Workflow clients used for V3 dispatch isolation. */
  readonly actorStores?: readonly {
    readonly actorAadObjectId: string;
    readonly store: WorkflowStore;
    readonly workState?: WorkStateStore;
    readonly sourceDrivers?: readonly WorkflowObservationSourceDriver[];
  }[];
  /** Recheck live Directory membership before a source poll. */
  readonly authorizeWorkflowActor?: (actorAadObjectId: string, ownerTaskId: string) => Promise<boolean>;
  /** Recover the owner actor only from Work's server-derived Task creator projection. */
  readonly resolveWorkflowActor?: (ownerTaskId: string) => Promise<string | undefined>;
  /** Append immutable page evidence to the active deterministic Work Task. */
  readonly recordSourcePageReceipt?: (taskId: string, receipt: WorkflowSourceTaskReceipt, actorAadObjectId?: string) => Promise<void>;
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
  readonly actorRef: string;
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
/** Work requires an explicit cursor for an incomplete chain; this means retry its first page. */
const SOURCE_RETRY_FROM_START_CURSOR = 'navigator-source-start-v1';
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
    const pending = reconcileSchedules(ctx, options, schedulerSessionId)
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
  options: WorkflowRuntimeOptions,
  schedulerSessionId: ReturnType<typeof SessionId>,
): Promise<void> {
  const definitions: { readonly workflow: WorkflowDefinition; readonly actorRef: string }[] = [
    ...await options.store.listWorkflows(1).then(items => items.map(workflow => ({ workflow, actorRef: 'legacy' }))),
    ...await options.store.listWorkflows(2).then(items => items.map(workflow => ({ workflow, actorRef: 'legacy' }))),
  ];
  if (options.actorStores === undefined || options.actorStores.length === 0) {
    definitions.push(...await options.store.listWorkflows(3).then(items => items.map(workflow => ({ workflow, actorRef: 'legacy' }))));
  } else {
    for (const actorStore of options.actorStores) {
      const actorRef = workflowActorRef(actorStore.actorAadObjectId);
      definitions.push(...await actorStore.store.listWorkflows(3).then(items => items.map(workflow => ({ workflow, actorRef }))));
    }
  }
  const desired = new Map<string, {
    readonly workflow: WorkflowDefinition;
    readonly triggerId: string;
    readonly schedule: WorkflowSchedule;
    readonly actorRef: string;
  }>();
  for (const { workflow, actorRef } of definitions) {
    if (!workflow.enabled || workflow.targets.length === 0) continue;
    if (workflow.version === 1) {
      if (workflow.schedule !== undefined) desired.set(scheduleKey(workflow.id, 'default', actorRef), {
        workflow, triggerId: 'default', schedule: workflow.schedule, actorRef,
      });
      continue;
    }
    for (const trigger of workflow.triggers) desired.set(scheduleKey(workflow.id, trigger.id, actorRef), {
      workflow, triggerId: trigger.id, schedule: trigger.schedule, actorRef,
    });
    if (workflow.notifications.digest.enabled) desired.set(scheduleKey(workflow.id, DAILY_DIGEST_TRIGGER_ID, actorRef), {
      workflow, triggerId: DAILY_DIGEST_TRIGGER_ID, schedule: workflow.notifications.digest.schedule, actorRef,
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
    const key = scheduleKey(marker.workflowId, marker.triggerId, marker.actorRef);
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
    const { workflow, triggerId, schedule: desiredSchedule, actorRef } = target;
    const existing = matched.get(key);
    const title = (workflow.version === 1 ? workflow.title : `${workflow.title} · ${triggerId}${actorRef === 'legacy' ? '' : ` · ${actorRef}`}`).slice(0, 120);
    const prompt = renderMarkerPrompt(workflow.id, triggerId, actorRef);
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

function workflowActorRef(actorAadObjectId: string): string {
  return digest(actorAadObjectId.toLowerCase()).slice(0, 16);
}

function scheduleKey(workflowId: string, triggerId: string, actorRef = 'legacy'): string {
  return `${actorRef}\0${workflowId}\0${triggerId}`;
}

/** Convert a Work API schedule into the canonical expression and zone stored by DSH. */
function canonicalSchedule(schedule: WorkflowSchedule): { readonly expression: string; readonly timeZone: string } {
  return parseCronInput({ expression: schedule.expression, time_zone: schedule.timeZone });
}

/** Construct the fixed reminder content DSH persists and later returns to the source hook. */
function renderMarkerPrompt(workflowId: string, triggerId = 'default', actorRef = 'legacy'): string {
  return `${WORKFLOW_MARKER}\n${JSON.stringify({ workflowId, triggerId, actorRef })}`;
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
      actorRef: typeof value.actorRef === 'string' && /^(?:legacy|[a-f0-9]{16})$/u.test(value.actorRef)
        ? value.actorRef : 'legacy',
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
  const actorStore = occurrence.marker.actorRef === 'legacy' ? undefined
    : options.actorStores?.find(item => workflowActorRef(item.actorAadObjectId) === occurrence.marker.actorRef);
  if (occurrence.marker.actorRef !== 'legacy' && actorStore === undefined) {
    ctx.logger.warn(`workflow timer ${occurrence.marker.actorRef} has no actor-scoped Work client`);
    return;
  }
  const scopedOptions: WorkflowRuntimeOptions = actorStore === undefined ? options : {
    ...options,
    store: actorStore.store,
    sourceDrivers: actorStore.sourceDrivers ?? options.sourceDrivers,
    executeFixedToolTask: options.executeFixedToolTask === undefined ? undefined
      : (request, execute) => options.executeFixedToolTask!(request, execute, actorStore.actorAadObjectId, actorStore.workState),
    recordSourcePageReceipt: options.recordSourcePageReceipt === undefined ? undefined
      : (taskId, receipt) => options.recordSourcePageReceipt!(taskId, receipt, actorStore.actorAadObjectId),
  };
  const workflows: readonly WorkflowDefinition[] = [
    ...await scopedOptions.store.listWorkflows(1),
    ...await scopedOptions.store.listWorkflows(2),
    ...await scopedOptions.store.listWorkflows(3),
  ];
  const workflow = workflows.find(candidate => candidate.id === occurrence.marker.workflowId);
  if (workflow === undefined || !workflow.enabled) return;
  const ownerActorId = workflow.version === 3
    ? actorStore?.actorAadObjectId ?? await options.resolveWorkflowActor?.(workflow.authorization.ownerTaskId)
    : actorStore?.actorAadObjectId;
  if (workflow.version === 2) {
    if (occurrence.marker.triggerId === DAILY_DIGEST_TRIGGER_ID) {
      await dispatchDailyDigest(ctx, scopedOptions, workflow, occurrence.scheduledAt, occurrence.marker.actorRef,
        ownerActorId);
      return;
    }
    const trigger = workflow.triggers.find(candidate => candidate.id === occurrence.marker.triggerId);
    if (trigger === undefined) return;
    await dispatchV2Occurrence(ctx, scopedOptions, workflow, trigger, occurrence.scheduledAt);
    return;
  }
  if (workflow.version === 3) {
    if (occurrence.marker.triggerId === DAILY_DIGEST_TRIGGER_ID) {
      await dispatchDailyDigest(ctx, scopedOptions, workflow, occurrence.scheduledAt, occurrence.marker.actorRef,
        ownerActorId);
      return;
    }
    const trigger = workflow.triggers.find(candidate => candidate.id === occurrence.marker.triggerId);
    if (trigger === undefined) return;
    await dispatchV3Occurrence(ctx, scopedOptions, workflow, trigger, occurrence.scheduledAt, occurrence.marker.actorRef,
      ownerActorId);
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

/** Collect one bounded v3 source window without entering any model path. */
async function dispatchV3Occurrence(
  ctx: Context,
  options: WorkflowRuntimeOptions,
  workflow: WorkflowV3Record,
  trigger: WorkflowV3Trigger,
  scheduledAt: string,
  actorRef: string,
  ownerActorId?: string,
): Promise<void> {
  const triggerId = trigger.id;
  if (ownerActorId === undefined) {
    ctx.logger.warn(`workflow ${workflow.id} has no verified owner actor for source polling`);
    return;
  }
  const occurrenceId = workflowV3OccurrenceId(workflow.id, triggerId, scheduledAt, ownerActorId);
  const taskId = `workflow-${occurrenceId.slice(4)}`;
  const sessionId = `workflow-source-${actorRef}-${digest(occurrenceId).slice(0, 32)}`;
  const history = await listWorkflowEvents(options.store, workflow.id);
  const scoped = history.filter(event => eventTriggerId(event) === triggerId);
  const successful = scoped.find(event => event.scheduledAt === scheduledAt && event.status === 'succeeded');
  if (successful !== undefined) return;
  const priorCheckpoint = latestSourceCheckpoint(scoped);
  const baselineEstablished = scoped.some(event => event.status === 'succeeded' && event.baseline === true
    && event.checkpoint?.kind === 'source_poll' && event.checkpoint.complete);
  const initialBaseline = !baselineEstablished;
  const continuingWindow = priorCheckpoint !== undefined && !priorCheckpoint.complete;
  const windowStart = continuingWindow ? priorCheckpoint.windowStart : priorCheckpoint?.windowEnd ?? null;
  const windowEnd = continuingWindow ? priorCheckpoint.windowEnd : utcSecond(scheduledAt);
  const priorByTarget = new Map((priorCheckpoint?.sources ?? [])
    .filter(cursor => cursor.source === trigger.source)
    .map(cursor => [cursor.targetId, cursor]));
  const metadata = workflowV3TaskMetadata(workflow, triggerId, occurrenceId, scheduledAt);
  await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'queued', {
    taskId, sessionId, triggerId, actorRef,
  });
  await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'running', {
    taskId, sessionId, triggerId, baseline: initialBaseline, actorRef,
  });

  let outcome: WorkflowDispatchOutcome | undefined;
  let failureCode: string | undefined;
  let recordedSourceIncident: { readonly targetId: string; readonly reasonCode: WorkflowObservationPageError['code'] } | undefined;
  let checkpoint: WorkflowSourceCheckpoint | undefined;
  const collected: {
    readonly targetId: string;
    readonly pageCursor: string | null;
    readonly nextCursor: string | null;
    readonly observedAt: number;
    readonly observation: WorkflowSourceObservation;
  }[] = [];
  const nextStates = new Map<string, WorkflowSourceCursor>();
  const completedPages = new Map<string, {
    readonly pageCursor: string | null;
    readonly nextCursor: string | null;
    readonly observedAt: number;
  }>();
  let pagesUsed = 0;
  let currentTargetId = trigger.targetIds[0] ?? '';

  try {
    if (workflow.notifications.destination.kind !== 'owner_private'
      || workflow.authorization.kind !== 'owner_private') {
      // Source-event notices are owner-private unless Work proves an exact share grant.
      // The runtime has no such grant resolver in this slice, so it never starts shared collection.
      throw new WorkflowSourceError('forbidden');
    }
    if (options.executeFixedToolTask === undefined) throw new WorkflowSourceError('not_configured');

    const targetById = new Map(workflow.targets.map(target => [target.id, target]));
    const driver = options.sourceDrivers?.find(item => item.source === trigger.source);
    const prompt = `Deterministic source poll ${workflow.id}/${triggerId} at ${scheduledAt}. No model execution is permitted.`;
    outcome = await options.executeFixedToolTask({ taskId, sessionId, prompt, metadata }, async (agent, signal) => {
      try {
       let sourceComplete = true;
       if (options.authorizeWorkflowActor === undefined) throw new WorkflowSourceError('not_configured', currentTargetId);
       if (!await options.authorizeWorkflowActor(ownerActorId, workflow.authorization.ownerTaskId)) {
         throw new WorkflowSourceError('forbidden', currentTargetId);
       }
       for (const targetId of trigger.targetIds) {
        currentTargetId = targetId;
        const target = targetById.get(targetId);
        if (target === undefined || target.bindingId === undefined) throw new WorkflowSourceError('not_configured');
        const prior = priorByTarget.get(targetId);
        let pageCursor = continuingWindow ? prior?.pageCursor ?? null : prior?.resumeCursor ?? null;
        if (pageCursor === SOURCE_RETRY_FROM_START_CURSOR) pageCursor = null;
        let targetComplete = false;
        let lastNextCursor = pageCursor;
        let targetPages = 0;
        const cursorChain = new Set<string>();
        while (pagesUsed < trigger.maxPages && !targetComplete) {
          if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new WorkflowSourceError('timeout');
          const requestedCursor = pageCursor;
          if (requestedCursor !== null) {
            if (cursorChain.has(requestedCursor)) throw new WorkflowSourceError('invalid');
            cursorChain.add(requestedCursor);
          }
          const request: WorkflowObservationPageRequest = {
            source: trigger.source,
            ownerActorId: ownerActorId ?? workflow.authorization.ownerTaskId,
            target: { id: target.id, kind: target.kind, bindingId: target.bindingId, label: target.label },
            pageSize: trigger.pageSize,
            pageCursor: requestedCursor,
            windowStart,
            windowEnd,
            signal,
          };
          const executionContext: WorkflowObservationExecutionContext = {
            invokeConnectorTool: toolRequest => {
              if (options.invokeObservationConnectorTool === undefined) {
                throw new WorkflowSourceError('not_configured');
              }
              return options.invokeObservationConnectorTool(agent, toolRequest);
            },
          };
          const page = driver === undefined
            ? await pollRegisteredObservationPage(ctx, request, executionContext)
            : await driver.pollPage(request, executionContext);
          validateObservationPage(page, request);
          if (page.error !== undefined) throw new WorkflowSourceError(page.error.code, targetId);
          if (page.truncated) throw new WorkflowSourceError('partial');
          if (!page.complete && (page.nextCursor === null || page.nextCursor === requestedCursor)) {
            throw new WorkflowSourceError('partial');
          }
          const previousEnd = Date.parse(windowStart ?? '1970-01-01T00:00:00.000Z');
          const frozenEnd = Date.parse(windowEnd);
          for (const observation of page.observations) {
            if (observation.occurredAt > frozenEnd
              || trigger.source !== 'office_graph' && windowStart !== null && observation.occurredAt <= previousEnd) {
              throw new WorkflowSourceError('invalid');
            }
            collected.push({
              targetId,
              pageCursor: requestedCursor,
              nextCursor: page.nextCursor,
              observedAt: page.observedAt,
              observation,
            });
          }
          pagesUsed += 1;
          targetPages += 1;
          lastNextCursor = page.nextCursor;
          targetComplete = page.complete;
          pageCursor = page.nextCursor;
          if (page.complete) completedPages.set(targetId, {
            pageCursor: requestedCursor,
            nextCursor: page.nextCursor,
            observedAt: page.observedAt,
          });
        }
        if (!targetComplete) sourceComplete = false;
        nextStates.set(targetId, {
          source: trigger.source,
          targetId,
          pageCursor: targetComplete ? null : lastNextCursor,
          ...(targetComplete && lastNextCursor !== null ? { resumeCursor: lastNextCursor } : {}),
          watermark: targetComplete ? windowEnd : prior?.watermark ?? null,
          complete: targetComplete,
          pagesCollected: targetPages,
          ...(prior?.seenEventIds === undefined ? {} : { seenEventIds: prior.seenEventIds }),
          ...(prior?.states === undefined ? {} : { states: prior.states }),
        });
       }

      // Server event ordering is deterministic even when providers return newest-first pages.
      collected.sort((left, right) => left.observation.occurredAt - right.observation.occurredAt
        || left.observation.sourceEventId.localeCompare(right.observation.sourceEventId)
        || left.targetId.localeCompare(right.targetId));
      const observationsById = new Map<string, typeof collected[number]>();
      for (const item of collected) {
        const key = `${item.observation.source}\0${item.observation.sourceEventId}`;
        const existing = observationsById.get(key);
        if (existing !== undefined) {
          if (canonicalObservation(existing.observation) !== canonicalObservation(item.observation)) {
            throw new WorkflowSourceError('invalid');
          }
          continue;
        }
        observationsById.set(key, item);
      }
      const eventIdsByTarget = new Map<string, Set<string>>();
      const resourceStatesByTarget = new Map<string, Map<string, WorkflowSourceState>>();
      for (const item of observationsById.values()) {
        const write: WorkflowAutomationEventWrite = { ...item.observation };
        const stored = await options.store.appendAutomationEvent(write);
        const event = stored.event;
        const pageReceipt: WorkflowSourcePageReceipt = {
          workflowId: workflow.id,
          triggerId,
          occurrenceId,
          scheduledAt,
          source: trigger.source,
          targetId: item.targetId,
          pageCursor: item.pageCursor,
          nextCursor: item.nextCursor,
          windowStart,
          windowEnd,
          automationEventIds: [event.id],
          sourceEventIds: [event.sourceEventId],
          observedAt: item.observedAt,
        };
        if (options.recordSourcePageReceipt === undefined) throw new WorkflowSourceError('not_configured');
        await options.recordSourcePageReceipt(taskId, pageReceipt, ownerActorId);
        const notice: WorkflowAutomationEventNoticeRequest = {
          eventId: event.id,
          workflowId: workflow.id,
          triggerId,
          occurrenceId,
          scheduledAt,
          taskId,
        };
        // Always reconcile the atomic Work intent, even when POST replayed an existing event.
        const receipt = await options.store.enqueueAutomationEventNotice(notice);
        if (receipt.eventId !== event.id || receipt.workflowId !== workflow.id
          || receipt.triggerId !== triggerId) {
          throw new WorkflowSourceError('invalid');
        }
        const ids = eventIdsByTarget.get(item.targetId) ?? new Set<string>();
        ids.add(event.sourceEventId);
        eventIdsByTarget.set(item.targetId, ids);
        const resourceStates = resourceStatesByTarget.get(item.targetId) ?? new Map<string, WorkflowSourceState>();
        resourceStates.set(digest(event.resourceUri), {
          resourceKey: digest(event.resourceUri),
          fingerprint: event.semanticFingerprint!,
          state: event.stateClass!,
        });
        resourceStatesByTarget.set(item.targetId, resourceStates);
      }
      for (const [targetId, state] of nextStates) {
        const prior = priorByTarget.get(targetId);
        const seen = new Set([...(prior?.seenEventIds ?? []), ...(eventIdsByTarget.get(targetId) ?? [])]);
        const states = new Map((prior?.states ?? []).map(item => [item.resourceKey, item]));
        for (const [key, value] of resourceStatesByTarget.get(targetId) ?? []) states.set(key, value);
        nextStates.set(targetId, {
          ...state,
          seenEventIds: [...seen].sort().slice(-1_000),
          states: [...states.values()].sort((left, right) => left.resourceKey.localeCompare(right.resourceKey)).slice(-1_000),
        });
      }

      // A complete, authorized read resolves a prior source-poll incident even if the
      // source returned no resource events. Work's semantic state receipt suppresses
      // repeated healthy snapshots and owns the one recovery notice.
      for (const [targetId, page] of completedPages) {
        const prior = priorByTarget.get(targetId);
        const statusResourceKey = digest(`cyrene://workflow-sources/${trigger.source}/${targetId}`);
        if (!prior?.states?.some(item => item.resourceKey === statusResourceKey && item.state === 'incident')) continue;
        await persistWorkflowSourceStatus(options, workflow, trigger, {
          targetId,
          occurrenceId,
          scheduledAt,
          taskId,
          windowStart,
          windowEnd,
          pageCursor: page.pageCursor,
          nextCursor: page.nextCursor,
          observedAt: page.observedAt,
          status: 'healthy',
          actorAadObjectId: ownerActorId,
        });
        const state = nextStates.get(targetId);
        if (state !== undefined) {
          const states = new Map((state.states ?? []).map(item => [item.resourceKey, item]));
          states.set(statusResourceKey, {
            resourceKey: statusResourceKey,
            fingerprint: digest('cyrene.source-poll.healthy.v1'),
            state: 'healthy',
          });
          nextStates.set(targetId, {
            ...state,
            states: [...states.values()].sort((left, right) => left.resourceKey.localeCompare(right.resourceKey)).slice(-1_000),
          });
        }
      }
      checkpoint = {
        kind: 'source_poll',
        windowStart,
        windowEnd,
        complete: sourceComplete,
        sources: [...nextStates.values()],
      };
      return safeJson({ pagesCollected: pagesUsed, observationsCollected: observationsById.size, complete: sourceComplete });
      } catch (error: unknown) {
        const sourceError = error instanceof WorkflowSourceError
          ? error
          : signal.aborted ? new WorkflowSourceError('timeout', currentTargetId)
            : new WorkflowSourceError('unavailable', currentTargetId);
        if (sourceError.code !== 'partial' && trigger.targetIds.includes(sourceError.targetId ?? currentTargetId)) {
          await persistWorkflowSourceStatus(options, workflow, trigger, {
            targetId: sourceError.targetId ?? currentTargetId,
            occurrenceId,
            scheduledAt,
            taskId,
            windowStart,
            windowEnd,
            pageCursor: null,
            nextCursor: null,
            observedAt: Date.now(),
            status: 'incident',
            reasonCode: sourceError.code,
            actorAadObjectId: ownerActorId,
          });
          recordedSourceIncident = {
            targetId: sourceError.targetId ?? currentTargetId,
            reasonCode: sourceError.code,
          };
        }
        throw sourceError;
      }
    }, ownerActorId, options.actorStores?.find(item => item.actorAadObjectId === ownerActorId)?.workState);

    if (outcome.status !== 'completed') throw new WorkflowSourceError(outcome.status === 'aborted' ? 'timeout' : 'unavailable');
  } catch (error: unknown) {
    failureCode = error instanceof WorkflowSourceError ? `WORKFLOW_SOURCE_${error.code.toUpperCase()}` : 'WORKFLOW_SOURCE_UNAVAILABLE';
    if (checkpoint === undefined) {
      const sources = trigger.targetIds.map(targetId => {
        const prior = priorByTarget.get(targetId);
        // Nothing in the in-flight window is checkpointed until all event/evidence/
        // intent writes finish. Replay from the window's original cursor after a
        // failure so an event POST or Work intent response loss cannot drop a page.
        const retryCursor = continuingWindow ? prior?.pageCursor : prior?.resumeCursor;
        const states = new Map((prior?.states ?? []).map(item => [item.resourceKey, item]));
        if (recordedSourceIncident?.targetId === targetId) {
          const resourceKey = digest(`cyrene://workflow-sources/${trigger.source}/${targetId}`);
          states.set(resourceKey, {
            resourceKey,
            fingerprint: digest(`cyrene.source-poll.failure.v1:${recordedSourceIncident.reasonCode}`),
            state: 'incident',
          });
        }
        return {
          source: trigger.source,
          targetId,
          pageCursor: retryCursor ?? SOURCE_RETRY_FROM_START_CURSOR,
          watermark: prior?.watermark ?? null,
          complete: false,
          pagesCollected: continuingWindow ? prior?.pagesCollected ?? 0 : 0,
          ...(prior?.seenEventIds === undefined ? {} : { seenEventIds: prior.seenEventIds }),
          ...(states.size === 0 ? {} : {
            states: [...states.values()].sort((left, right) => left.resourceKey.localeCompare(right.resourceKey)).slice(-1_000),
          }),
        } satisfies WorkflowSourceCursor;
      });
      checkpoint = { kind: 'source_poll', windowStart, windowEnd, complete: false, sources };
    }
    const summary = sourceFailureSummary(failureCode);
    await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'failed', {
      taskId, sessionId, triggerId, errorCode: failureCode, summary, checkpoint, actorRef,
    });
    ctx.logger.warn(`workflow ${workflow.id} source poll failed (${failureCode})`);
    return;
  }

  const complete = checkpoint?.complete === true;
  if (!complete) {
    await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'failed', {
      taskId,
      sessionId,
      triggerId,
      errorCode: 'WORKFLOW_SOURCE_PARTIAL',
      summary: 'The deterministic source window reached its bounded page budget; its cursor was retained for continuation.',
      checkpoint,
      actorRef,
    });
    return;
  }
  const summary = complete ? 'The deterministic source window was collected.'
    : 'The deterministic source window reached its bounded page budget; its cursor was retained for continuation.';
  try {
    await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'succeeded', {
      taskId,
      sessionId,
      triggerId,
      baseline: initialBaseline && complete,
      changed: false,
      summary,
      checkpoint,
      actorRef,
    });
  } catch (error: unknown) {
    ctx.logger.warn(`workflow ${workflow.id} source checkpoint could not be persisted (${error instanceof Error ? error.name : 'unknown'})`);
    await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'failed', {
      taskId,
      sessionId,
      triggerId,
      errorCode: 'WORKFLOW_SOURCE_CHECKPOINT_INVALID',
      summary: 'The deterministic source checkpoint could not be persisted.',
      actorRef,
    }).catch(() => undefined);
  }
}

class WorkflowSourceError extends Error {
  constructor(readonly code: WorkflowObservationPageError['code'], readonly targetId?: string) {
    super(code);
  }
}

async function pollRegisteredObservationPage(
  ctx: Context,
  request: WorkflowObservationPageRequest,
  execution: WorkflowObservationExecutionContext,
): Promise<WorkflowObservationPage> {
  if (request.source === 'github') {
    const target = request.target;
    if (target.kind !== 'github_repository' || target.bindingId === '' || !/^[1-9]\d{0,18}$/u.test(target.id)
      || !/^[^/\s]+\/[^/\s]+$/u.test(target.label ?? '')) throw new WorkflowSourceError('not_configured', target.id);
    const cursor = request.pageCursor ?? '1';
    const args = {
      repository_id: Number(target.id),
      repository: target.label,
      state: 'all',
      labels: [],
      limit: request.pageSize,
      ...(request.windowStart === null ? {} : { updated_since: request.windowStart }),
      updated_until: request.windowEnd,
      page_cursor: cursor,
    };
    const result = await execution.invokeConnectorTool({
      bindingId: target.bindingId,
      providerId: 'github',
      toolId: 'github.issues.search',
      operationId: 'github.issues.search',
      resourceProjection: 'github_repository',
      arguments: args,
      signal: request.signal,
    });
    const page = parseGitHubSearchPage(result);
    if (page === undefined || page.echoedPageCursor !== cursor) throw new WorkflowSourceError('invalid', target.id);
    if (page.incompleteResults || page.resultLimitReached) throw new WorkflowSourceError('partial', target.id);
    const observations = page.issues.map(issue => githubIssueObservation(issue, target));
    return {
      source: 'github',
      observedAt: Date.now(),
      pageCursor: request.pageCursor,
      nextCursor: page.nextCursor,
      complete: page.complete,
      truncated: page.truncated,
      observations,
    };
  }
  if (request.source === 'azure_devops') {
    if (!['pipeline_runs', 'release_deployments'].includes(request.target.kind)) {
      throw new WorkflowSourceError('not_configured', request.target.id);
    }
    const raw = await execution.invokeConnectorTool({
      bindingId: request.target.bindingId,
      providerId: 'azure_devops',
      toolId: 'azure_devops.observations.poll',
      operationId: 'azure_devops.observations.poll',
      resourceProjection: 'azure_devops_source',
      arguments: {
        target: { id: request.target.id, kind: request.target.kind, bindingId: request.target.bindingId },
        pageSize: request.pageSize,
        pageCursor: request.pageCursor,
        windowStart: request.windowStart,
        windowEnd: request.windowEnd,
      },
      signal: request.signal,
    });
    const value = unwrapFixedConnectorResult(raw);
    const row = asRecord(value);
    if (row === undefined || row.source !== 'azure_devops' || row.pageCursor !== request.pageCursor
      || !(row.nextCursor === null || typeof row.nextCursor === 'string')
      || typeof row.complete !== 'boolean' || typeof row.truncated !== 'boolean'
      || !Array.isArray(row.observations)) throw new WorkflowSourceError('invalid', request.target.id);
    return {
      source: 'azure_devops',
      observedAt: Number.isSafeInteger(row.observedAt) ? row.observedAt as number : Date.now(),
      pageCursor: request.pageCursor,
      nextCursor: row.nextCursor,
      complete: row.complete,
      truncated: row.truncated,
      observations: row.observations as WorkflowSourceObservation[],
      ...(row.error === undefined ? {} : { error: row.error as WorkflowObservationPageError }),
    };
  }
  throw new WorkflowSourceError('not_configured', request.target.id);
}

function githubIssueObservation(
  issue: Readonly<Record<string, unknown>>,
  target: WorkflowObservationPageRequest['target'],
): WorkflowSourceObservation {
  const number = issue.number;
  const updatedAt = issue.updated_at;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1
    || typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) {
    throw new WorkflowSourceError('invalid', target.id);
  }
  const repository = target.label!;
  const uri = `https://github.com/${repository}/issues/${number}`;
  const title = typeof issue.title === 'string' ? redactSummary(issue.title).slice(0, 256) : undefined;
  const state = typeof issue.state === 'string' ? issue.state : 'unknown';
  const semanticFingerprint = digest(JSON.stringify({ number, state, title: title ?? null, updatedAt }));
  return {
    source: 'github',
    sourceEventId: `github:issue:${target.id}:${number}:${updatedAt}`,
    resourceUri: uri,
    sourceVersion: updatedAt,
    eventType: 'github.issue.updated',
    occurredAt: Date.parse(updatedAt),
    ...(title === undefined ? {} : { title }),
    summary: title === undefined ? `GitHub issue #${number} was updated.` : `GitHub issue #${number}: ${title}`,
    semanticFingerprint,
    stateClass: 'neutral',
  };
}

function unwrapFixedConnectorResult(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 6; depth += 1) {
    const row = asRecord(current);
    if (row === undefined) return current;
    if (row.isError === true || row.error !== undefined) throw new WorkflowSourceError('unavailable');
    if (row.structuredContent !== undefined) { current = row.structuredContent; continue; }
    if (row.businessResult !== undefined) { current = row.businessResult; continue; }
    if (row.result !== undefined && asRecord(row.result) !== undefined) { current = row.result; continue; }
    if (row.value !== undefined && asRecord(row.value) !== undefined) { current = row.value; continue; }
    if (Array.isArray(row.content)) {
      const block = row.content.find(item => asRecord(item)?.type === 'text' && typeof asRecord(item)?.text === 'string');
      const text = block === undefined ? undefined : asRecord(block)?.text;
      if (typeof text === 'string') {
        try { current = JSON.parse(text) as unknown; continue; } catch { return current; }
      }
    }
    return row;
  }
  return current;
}

function validateObservationPage(
  page: WorkflowObservationPage,
  request: WorkflowObservationPageRequest,
): void {
  if (page === null || typeof page !== 'object' || page.source !== request.source
    || !Number.isSafeInteger(page.observedAt) || page.observedAt < 0
    || page.pageCursor !== request.pageCursor
    || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length <= 32_768)
    || typeof page.complete !== 'boolean' || typeof page.truncated !== 'boolean'
    || !Array.isArray(page.observations) || page.observations.length > request.pageSize) {
    throw new WorkflowSourceError('invalid', request.target.id);
  }
  if (page.error !== undefined) {
    if (!['not_configured', 'forbidden', 'unavailable', 'timeout', 'invalid', 'partial'].includes(page.error.code)
      || page.observations.length !== 0) throw new WorkflowSourceError('invalid', request.target.id);
    return;
  }
  for (const observation of page.observations) {
    if (observation.source !== request.source || typeof observation.semanticFingerprint !== 'string'
      || typeof observation.stateClass !== 'string') throw new WorkflowSourceError('invalid', request.target.id);
    try {
      validateWorkflowAutomationEvent(observation);
    } catch {
      throw new WorkflowSourceError('invalid', request.target.id);
    }
  }
}

function canonicalObservation(value: WorkflowSourceObservation): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]))
      : item;
  return JSON.stringify(normalize(value));
}

async function persistWorkflowSourceStatus(
  options: WorkflowRuntimeOptions,
  workflow: WorkflowV3Record,
  trigger: WorkflowV3Trigger,
  input: {
    readonly targetId: string;
    readonly occurrenceId: string;
    readonly scheduledAt: string;
    readonly taskId: string;
    readonly windowStart: string | null;
    readonly windowEnd: string;
    readonly pageCursor: string | null;
    readonly nextCursor: string | null;
    readonly observedAt: number;
    readonly status: 'incident' | 'healthy';
    readonly reasonCode?: WorkflowObservationPageError['code'];
    readonly actorAadObjectId?: string;
  },
): Promise<void> {
  const fingerprintText = input.status === 'incident'
    ? `cyrene.source-poll.failure.v1:${input.reasonCode ?? 'unavailable'}`
    : 'cyrene.source-poll.healthy.v1';
  const semanticFingerprint = digest(fingerprintText);
  const sourceEventId = `workflow-poll:${workflow.id}:${trigger.id}:${input.targetId}:${input.occurrenceId}:${input.status}`;
  const targetUri = `cyrene://workflow-sources/${trigger.source}/${input.targetId}`;
  const event: WorkflowAutomationEventWrite = {
    source: trigger.source,
    sourceEventId,
    resourceUri: targetUri,
    sourceVersion: input.scheduledAt,
    eventType: input.status === 'incident' ? 'source.poll.failure' : 'source.poll.recovery',
    occurredAt: Date.parse(input.scheduledAt),
    title: input.status === 'incident' ? 'Source poll failure' : 'Source poll recovered',
    summary: input.status === 'incident'
      ? `A configured ${trigger.source} source poll failed (${input.reasonCode ?? 'unavailable'}).`
      : `The configured ${trigger.source} source is responding again.`,
    severity: input.status === 'incident' ? 'warning' : 'info',
    semanticFingerprint,
    stateClass: input.status,
  };
  const stored = await options.store.appendAutomationEvent(event);
  if (options.recordSourcePageReceipt === undefined) throw new WorkflowSourceError('not_configured', input.targetId);
  if (input.status === 'incident') {
    const failure: WorkflowSourceErrorReceipt = {
      workflowId: workflow.id,
      triggerId: trigger.id,
      occurrenceId: input.occurrenceId,
      scheduledAt: input.scheduledAt,
      source: trigger.source,
      targetId: input.targetId,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      outcome: 'failed',
      reasonCode: input.reasonCode ?? 'unavailable',
      observedAt: new Date(input.observedAt).toISOString(),
    };
    await options.recordSourcePageReceipt(input.taskId, failure, input.actorAadObjectId);
  } else {
    const success: WorkflowSourcePageReceipt = {
      workflowId: workflow.id,
      triggerId: trigger.id,
      occurrenceId: input.occurrenceId,
      scheduledAt: input.scheduledAt,
      source: trigger.source,
      targetId: input.targetId,
      pageCursor: input.pageCursor,
      nextCursor: input.nextCursor,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      automationEventIds: [stored.event.id],
      sourceEventIds: [stored.event.sourceEventId],
      observedAt: input.observedAt,
    };
    await options.recordSourcePageReceipt(input.taskId, success, input.actorAadObjectId);
  }
  await options.store.enqueueAutomationEventNotice({
    eventId: stored.event.id,
    workflowId: workflow.id,
    triggerId: trigger.id,
    occurrenceId: input.occurrenceId,
    scheduledAt: input.scheduledAt,
    taskId: input.taskId,
  });
}

function sourceFailureSummary(code: string): string {
  if (code.includes('FORBIDDEN')) return 'A configured source is not authorized for this actor.';
  if (code.includes('NOT_CONFIGURED')) return 'A configured source binding or adapter is unavailable.';
  if (code.includes('TIMEOUT')) return 'A configured source did not respond before the bounded timeout.';
  if (code.includes('INVALID') || code.includes('PARTIAL')) return 'A configured source returned an incomplete or invalid page.';
  return 'A configured source is temporarily unavailable.';
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
  if (states.every((state, _index) => state?.status === 'verified' && state.taskId === prior.taskId)) {
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
  workflow: WorkflowV2Record | WorkflowV3Record,
  scheduledAt: string,
  actorRef = 'legacy',
  actorAadObjectId?: string,
): Promise<void> {
  const triggerId = DAILY_DIGEST_TRIGGER_ID;
  const events = await listWorkflowEvents(options.store, workflow.id);
  const existing = events.find(event => eventTriggerId(event) === triggerId && event.scheduledAt === scheduledAt
    && event.status === 'succeeded');
  if (workflow.version === 3) {
    if (existing !== undefined) {
      await enqueueV3DigestNotice(options.store, workflow, existing, actorAadObjectId);
      return;
    }
    if (events.some(event => eventTriggerId(event) === triggerId && event.scheduledAt === scheduledAt && event.status === 'failed')) return;
    const occurrenceId = workflowV3OccurrenceId(workflow.id, triggerId, scheduledAt, actorAadObjectId);
    const taskId = `workflow-${occurrenceId.slice(4)}`;
    const sessionId = `workflow-digest-${actorRef}-${digest(occurrenceId).slice(0, 32)}`;
    const metadata = workflowV3TaskMetadata(workflow, triggerId, occurrenceId, scheduledAt);
    if (options.executeFixedToolTask === undefined) {
      await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'failed', {
        triggerId, taskId, sessionId, errorCode: 'WORKFLOW_FIXED_TASK_UNAVAILABLE',
        summary: 'The deterministic digest task could not be started.', actorRef,
      });
      return;
    }
    await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'queued', { triggerId, taskId, sessionId, actorRef });
    await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'running', { triggerId, taskId, sessionId, actorRef });
    const outcome = await options.executeFixedToolTask({
      taskId,
      sessionId,
      prompt: `Deterministic digest receipt ${workflow.id}/${scheduledAt}. No model execution is permitted.`,
      metadata,
    }, async () => 'V3 digest schedule receipt completed without model invocation.', actorAadObjectId,
    options.actorStores?.find(item => item.actorAadObjectId === actorAadObjectId)?.workState);
    if (outcome.status !== 'completed') {
      await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'failed', {
        triggerId, taskId, sessionId, errorCode: 'WORKFLOW_DIGEST_TASK_FAILED',
        summary: 'The deterministic digest task did not complete.', actorRef,
      });
      return;
    }
    await appendOccurrenceEvent(options.store, workflow.id, scheduledAt, 'succeeded', {
      triggerId, taskId, sessionId, changed: false,
      summary: 'Daily digest receipt completed.', actorRef,
    });
    const terminal = (await listWorkflowEvents(options.store, workflow.id)).find(event => eventTriggerId(event) === triggerId
      && event.scheduledAt === scheduledAt && event.status === 'succeeded');
    if (terminal !== undefined) await enqueueV3DigestNotice(options.store, workflow, terminal, actorAadObjectId);
    return;
  }
  if (existing !== undefined || events.some(event => eventTriggerId(event) === triggerId && event.scheduledAt === scheduledAt
    && event.status === 'failed')) return;
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

async function enqueueV3DigestNotice(
  store: WorkflowStore,
  workflow: WorkflowV3Record,
  event: WorkflowScheduleEvent,
  actorAadObjectId?: string,
): Promise<void> {
  if (event.taskId === undefined || event.status !== 'succeeded') return;
  const occurrenceId = workflowV3OccurrenceId(workflow.id, DAILY_DIGEST_TRIGGER_ID, event.scheduledAt, actorAadObjectId);
  const taskId = `workflow-${occurrenceId.slice(4)}`;
  if (event.taskId !== taskId) throw new WorkflowSourceError('forbidden');
  await store.enqueueV3DigestNotice(workflow.id, {
    occurrenceId,
    triggerId: DAILY_DIGEST_TRIGGER_ID,
    scheduledAt: event.scheduledAt,
    taskId,
  });
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
    | 'evidence' | 'operationIds' | 'actionTaskIds' | 'actionResults' | 'checkpoint' | 'attentionKind'> & {
      readonly actorRef?: string;
    },
): Promise<void> {
  const triggerId = extra.triggerId ?? 'default';
  const actorPrefix = extra.actorRef === undefined || extra.actorRef === 'legacy' ? '' : `${extra.actorRef}\0`;
  const occurrenceKey = actorPrefix + (triggerId === 'default'
    ? `${workflowId}\0${scheduledAt}` : `${workflowId}\0${triggerId}\0${scheduledAt}`);
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
    .filter((event): event is WorkflowScheduleEvent & { readonly checkpoint: WorkflowCheckpoint } =>
      event.checkpoint?.kind === 'github_issues_search')
    .sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt))[0]?.checkpoint;
}

function latestSourceCheckpoint(events: readonly WorkflowScheduleEvent[]): WorkflowSourceCheckpoint | undefined {
  for (const event of [...events].sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt))) {
    if (event.checkpoint?.kind === 'source_poll') return event.checkpoint;
  }
  return undefined;
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
  const recent = events.filter((event): event is WorkflowScheduleEvent & { readonly checkpoint: WorkflowCheckpoint } =>
    event.status === 'succeeded' && event.checkpoint?.kind === 'github_issues_search'
    && event.checkpoint.complete === false
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

/** V3 identity is namespaced by Work's server-derived actor subject. */
function workflowV3OccurrenceId(
  workflowId: string,
  triggerId: string,
  scheduledAt: string,
  createdByActorId?: string,
): string {
  if (createdByActorId === undefined) throw new WorkflowSourceError('not_configured');
  const actorRef = digest(createdByActorId.toLowerCase()).slice(0, 16);
  return `occ-${digest(`${workflowId}\0${triggerId}\0${scheduledAt}\0${actorRef}`).slice(0, 40)}`;
}

function workflowV3TaskMetadata(
  workflow: WorkflowV3Record,
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
      ownerTaskId: workflow.authorization.ownerTaskId,
    },
  };
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
  const scoped: { readonly store: WorkflowStore; readonly workflow: WorkflowDefinition; readonly actorAadObjectId?: string }[] = [
    ...await options.store.listWorkflows(1).then(items => items.map(workflow => ({ store: options.store, workflow }))),
    ...await options.store.listWorkflows(2).then(items => items.map(workflow => ({ store: options.store, workflow }))),
  ];
  if (options.actorStores === undefined || options.actorStores.length === 0) {
    scoped.push(...await options.store.listWorkflows(3).then(items => items.map(workflow => ({ store: options.store, workflow }))));
  } else {
    for (const actorStore of options.actorStores) {
      scoped.push(...await actorStore.store.listWorkflows(3).then(items => items.map(workflow => ({
        store: actorStore.store, workflow, actorAadObjectId: actorStore.actorAadObjectId,
      }))));
    }
  }
  for (const { store, workflow, actorAadObjectId } of scoped) {
    const events = await listWorkflowEvents(store, workflow.id);
    if (workflow.version === 3) {
      const digestEvents = events.filter(event => eventTriggerId(event) === DAILY_DIGEST_TRIGGER_ID
        && event.status === 'succeeded' && event.taskId !== undefined);
      for (const event of digestEvents) await enqueueV3DigestNotice(store, workflow, event, actorAadObjectId);
      continue;
    }
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
        } else if (workflow.version === 2 && event.changed && event.baseline !== true && event.checkpoint?.complete !== false
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
    if (workflow.version >= 2 && options.projectTeamsNotification !== undefined) {
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
