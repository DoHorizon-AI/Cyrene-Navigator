// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator conversation DSH scheduler                        │
// │ Role: Store versioned feature markers in the official DSH Schedule.  │
// │ 模块职责：用官方 DSH Schedule 持久化对话功能触发器。                   │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {
  ScheduleCatalogEntry,
  ScheduleCreateRequest,
  ScheduleDeleteRequest,
  ScheduleRecord,
  ScheduleService,
} from '@deepseek-ai/dsh-schedule';

const MARKER_PREFIX = '[CYRENE_CONVERSATION_SCHEDULE_V1]\n';

export type ConversationScheduleKind = 'maintenance' | 'watch' | 'followup';

/** Durable DSH Schedule payload contains identifiers only, never message text or credentials. */
export interface ConversationScheduleMarker {
  readonly version: 1;
  readonly kind: ConversationScheduleKind;
  readonly resourceId: string;
}

/** Official DSH Schedule operations injected by the Navigator Host. */
export type DshConversationScheduleService = Pick<ScheduleService, 'catalog' | 'create' | 'delete'>;

/** Result distinguishes a new future reminder from an existing delivered marker. */
export interface ConversationScheduleResult {
  readonly record: ScheduleRecord;
  readonly created: boolean;
  readonly active: boolean;
}

/** Configure the one existing DSH scheduler Session the Host consumes before model inference. */
export interface ConversationDshScheduleOptions {
  readonly service: DshConversationScheduleService;
  readonly schedulerSessionId: string;
  readonly now?: () => number;
}

/** Durable create, debounce/reschedule, and cancel operations over DSH Schedule. */
export interface ConversationDshScheduler {
  readonly schedulerSessionId: string;
  ensureOneShot(
    marker: ConversationScheduleMarker,
    dueAt: number,
    options?: { readonly signal?: AbortSignal; readonly rearmInactive?: boolean },
  ): Promise<ConversationScheduleResult>;
  cancel(marker: ConversationScheduleMarker, signal?: AbortSignal): Promise<number>;
}

/**
 * Create an adapter over DSH Schedule's persistent Session domain.
 * It does not own a timer, Agent loop, or Work Task ledger.
 */
export function createConversationDshScheduler(options: ConversationDshScheduleOptions): ConversationDshScheduler {
  const schedulerSessionId = SessionId(options.schedulerSessionId);
  const now = options.now ?? Date.now;
  const queueTails = new Map<string, Promise<void>>();

  const scheduler: ConversationDshScheduler = {
    schedulerSessionId: String(schedulerSessionId),

    ensureOneShot(marker, dueAt, scheduleOptions = {}) {
      const normalized = validateMarker(marker);
      const markerText = renderConversationScheduleMarkerV1(normalized);
      const title = scheduleTitle(normalized);
      const signal = scheduleOptions.signal;
      if (!Number.isSafeInteger(dueAt) || dueAt <= now()) {
        return Promise.reject(new RangeError('Conversation schedule target must be a future epoch millisecond'));
      }
      return withMarkerLock(queueTails, markerText, async () => {
        signal?.throwIfAborted();
        const entries = await options.service.catalog();
        const matching = entries.filter(entry => belongsToSession(entry, schedulerSessionId)
          && entry.prompt === markerText);
        const active = matching.filter(entry => entry.status === 'active');
        const hadActive = active.length > 0;
        const desiredTime = new Date(dueAt).toISOString();
        const exact = active.find(entry => entry.kind === 'at' && entry.scheduledAt === desiredTime);
        if (exact !== undefined) {
          for (const duplicate of active) {
            if (duplicate.id !== exact.id) await deleteEntry(options.service, schedulerSessionId, duplicate, signal);
          }
          return { record: exact, created: false, active: true };
        }
        const existingInactive = matching.find(entry => entry.status === 'inactive');
        if (existingInactive !== undefined && !hadActive && scheduleOptions.rearmInactive !== true) {
          return { record: existingInactive, created: false, active: false };
        }
        const request: ScheduleCreateRequest = { title, prompt: markerText, at: desiredTime };
        let createReturned = false;
        let createFailure: unknown;
        try {
          await options.service.create(schedulerSessionId, request, signal);
          createReturned = true;
        } catch (createError: unknown) {
          // The DSH call may have committed before its response was lost. Reconcile once; never replay the write.
          if (signal?.aborted) throw createError;
          createFailure = createError;
        }
        signal?.throwIfAborted();
        const readback = await options.service.catalog();
        const verified = readback.find(entry => belongsToSession(entry, schedulerSessionId)
          && entry.status === 'active'
          && entry.kind === 'at'
          && entry.prompt === markerText
          && entry.scheduledAt === desiredTime);
        if (verified === undefined) {
          if (!createReturned) throw createFailure;
          throw new Error('DSH Schedule create returned without an active matching readback');
        }
        // Keep the prior reminder until the replacement is durably visible in the shared DSH catalog.
        for (const old of readback.filter(entry => belongsToSession(entry, schedulerSessionId)
          && entry.status === 'active'
          && entry.prompt === markerText
          && entry.id !== verified.id)) {
          await deleteEntry(options.service, schedulerSessionId, old, signal);
        }
        return { record: verified, created: true, active: true };
      });
    },

    cancel(marker, signal) {
      const normalized = validateMarker(marker);
      const markerText = renderConversationScheduleMarkerV1(normalized);
      return withMarkerLock(queueTails, markerText, async () => {
        signal?.throwIfAborted();
        const entries = await options.service.catalog();
        const matching = entries.filter(entry => belongsToSession(entry, schedulerSessionId)
          && entry.status === 'active'
          && entry.prompt === markerText);
        let cancelled = 0;
        for (const entry of matching) {
          await deleteEntry(options.service, schedulerSessionId, entry, signal);
          cancelled += 1;
        }
        return cancelled;
      });
    },
  };
  return Object.freeze(scheduler);
}

/** Serialize one marker's catalog/read/write sequence to prevent duplicate local creates. */
async function withMarkerLock<T>(
  tails: Map<string, Promise<void>>,
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  tails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

async function deleteEntry(
  service: DshConversationScheduleService,
  sessionId: ReturnType<typeof SessionId>,
  entry: ScheduleCatalogEntry,
  signal?: AbortSignal,
): Promise<void> {
  const request: ScheduleDeleteRequest = { sessionId, id: entry.id };
  await service.delete(request, signal);
}

/** Render an opaque identifier-only prompt for the Host's pre-step consumer. */
export function renderConversationScheduleMarkerV1(marker: ConversationScheduleMarker): string {
  const valid = validateMarker(marker);
  return `${MARKER_PREFIX}${JSON.stringify(valid)}`;
}

/** Parse only the exact versioned marker; arbitrary scheduler text is never dispatched as work. */
export function parseConversationScheduleMarkerV1(prompt: string): ConversationScheduleMarker | undefined {
  if (typeof prompt !== 'string' || !prompt.startsWith(MARKER_PREFIX)) return undefined;
  try {
    const value: unknown = JSON.parse(prompt.slice(MARKER_PREFIX.length));
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 3
      || record.version !== 1
      || (record.kind !== 'maintenance' && record.kind !== 'watch' && record.kind !== 'followup')
      || !isIdentifier(record.resourceId)) return undefined;
    return { version: 1, kind: record.kind, resourceId: record.resourceId };
  } catch {
    return undefined;
  }
}

/** Build a stable Host marker for one DSH task, watch or conversation follow-up. */
export function conversationScheduleMarker(
  kind: ConversationScheduleKind,
  resourceId: string,
): ConversationScheduleMarker {
  return validateMarker({ version: 1, kind, resourceId });
}

function validateMarker(marker: ConversationScheduleMarker): ConversationScheduleMarker {
  if (marker?.version !== 1
    || (marker.kind !== 'maintenance' && marker.kind !== 'watch' && marker.kind !== 'followup')
    || !isIdentifier(marker.resourceId)) {
    throw new TypeError('Conversation schedule marker is invalid');
  }
  return { version: 1, kind: marker.kind, resourceId: marker.resourceId };
}

function scheduleTitle(marker: ConversationScheduleMarker): string {
  const digest = createHash('sha256').update(marker.resourceId).digest('hex').slice(0, 12);
  return `Cyrene ${marker.kind} ${digest}`;
}

function belongsToSession(entry: ScheduleCatalogEntry, sessionId: ReturnType<typeof SessionId>): boolean {
  return String(entry.sessionId) === String(sessionId);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}
