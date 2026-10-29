// ┌─────────────────────────────────────────────────────────────────────┐
// │ 📄 office-observation.ts                                            │
// │ Module: workflows/office-observation                                │
// │ Role: Read one selected Planner plan as bounded V3 observations.    │
// │                                                                      │
// │ 模块职责：读取固定 Planner 计划并生成有界 V3 观察事件。               │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';
import type {
  WorkflowObservationExecutionContext,
  WorkflowObservationPage,
  WorkflowObservationPageRequest,
} from './runtime.js';
import type { WorkflowSourceObservation } from './store.js';
import {
  authorizePlannerPlanRead,
  resolvePlannerPlanBinding,
} from './source-config.js';
import type {
  AutomationSourceBindings,
  PlannerPlanTarget,
  PlannerPlanAuthorizationClient,
  PlannerPlanSourceBinding,
} from './source-config.js';

const PAGE_CURSOR_PREFIX = 'office-v1.';
const MAX_PAGE_SIZE = 50;
const MAX_PROVIDER_CURSOR_LENGTH = 12_000;
const MAX_PAGE_CURSOR_LENGTH = 32_768;
const MAX_TASKS_PER_PAGE = 50;
const MAX_TASK_TITLE_LENGTH = 255;
const MAX_ETAG_LENGTH = 1_024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const GRAPH_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const EVENT_TYPE = 'office_graph.planner.task.snapshot';

export interface OfficeConnectorToolRequest {
  readonly bindingId: string;
  readonly providerId: 'microsoft_graph';
  readonly toolId: 'microsoft_graph.planner.tasks.list';
  readonly operationId: 'microsoft_graph.planner.tasks.list';
  readonly resourceProjection: 'microsoft_graph_plan';
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export interface OfficeObservationOptions {
  readonly sourceBindings: AutomationSourceBindings;
  /** Optional stronger Directory ACL; the fixed actor-owned Graph plan.get probe remains mandatory. */
  readonly authorization?: PlannerPlanAuthorizationClient;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

interface OfficeProviderTask {
  readonly taskId: string;
  readonly planId: string;
  readonly bucketId: string | null;
  readonly title: string;
  readonly percentComplete: number;
  readonly priority: number;
  readonly dueDateTime: string | null;
  readonly startDateTime: string | null;
  readonly createdDateTime: string;
  readonly lastModifiedDateTime: string;
  readonly etag: string;
}

interface OfficeProviderPage {
  readonly tasks: readonly OfficeProviderTask[];
  readonly nextCursor: string | null;
  readonly complete: boolean;
  readonly truncated: false;
}

interface OfficePageCursor {
  readonly version: 1;
  readonly targetId: string;
  readonly bindingId: string;
  readonly planId: string;
  readonly pageSize: number;
  readonly windowStart: string | null;
  readonly windowEnd: string;
  readonly providerCursor: string;
}

type OfficeObservationErrorCode = 'not_configured' | 'forbidden' | 'unavailable' | 'timeout' | 'invalid' | 'partial';

class OfficeObservationError extends Error {
  constructor(readonly code: OfficeObservationErrorCode) {
    super(code);
  }
}

/**
 * Create the read-only Planner source consumed by the deterministic V3 poller.
 * Plan IDs are resolved from host bindings and every page goes through the
 * fixed registered Graph tool, which obtains a one-use user lease and verifies
 * `/me` with that token. This adapter contains no Graph transport or credentials.
 */
export function createOfficeObservationSource(options: OfficeObservationOptions): {
  readonly source: 'office_graph';
  pollPage(
    request: WorkflowObservationPageRequest,
    context: WorkflowObservationExecutionContext,
  ): Promise<WorkflowObservationPage>;
} {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Office observation timeout must be between 1 and 60000 ms');
  }

  return {
    source: 'office_graph',
    async pollPage(
      request: WorkflowObservationPageRequest,
      context: WorkflowObservationExecutionContext,
    ): Promise<WorkflowObservationPage> {
      const firstObservedAt = now();
      const invalid = validateRequest(request);
      if (invalid !== undefined) return failedPage(request, firstObservedAt, invalid);
      if (request.signal.aborted) return failedPage(request, firstObservedAt, 'timeout');
      const actorId = request.ownerActorId;
      if (!boundedText(actorId, 256)) return failedPage(request, firstObservedAt, 'not_configured');
      if (typeof context.invokeConnectorTool !== 'function') {
        return failedPage(request, firstObservedAt, 'not_configured');
      }

      const timeoutController = new AbortController();
      const deadline = setTimeout(() => timeoutController.abort(), timeoutMs);
      const signal = AbortSignal.any([request.signal, timeoutController.signal]);
      let observedAt = firstObservedAt;
      try {
        // ── Phase 1: Resolve and authorize the exact host-selected plan. ──
        const target = request.target as PlannerPlanTarget;
        const binding = resolvePlannerPlanBinding(options.sourceBindings, actorId, target);
        if (binding === undefined) throw new OfficeObservationError('not_configured');
        if (!profileMatches(actorId, target, binding)) {
          throw new OfficeObservationError('forbidden');
        }
        // Validate an opaque page cursor against this exact actor-selected plan/window
        // before making even the authorization probe call.
        const cursor = decodePageCursor(request, binding);
        const permission = options.authorization === undefined
          ? await verifyPlannerPlanAccess(context, binding.bindingId, binding.planId, signal)
          : await awaitWithSignal(
            authorizePlannerPlanRead(options.authorization, actorId, target, binding, signal),
            signal,
          );
        if (signal.aborted) throw new OfficeObservationError('timeout');
        if (permission !== 'allowed') throw new OfficeObservationError(permission);
        const graphPermission = await verifyPlannerPlanAccess(context, binding.bindingId, binding.planId, signal);
        if (signal.aborted) throw new OfficeObservationError('timeout');
        if (graphPermission !== 'allowed') throw new OfficeObservationError(graphPermission);

        // ── Phase 2: Read only this selected plan through the fixed provider tool. ──
        const providerArguments = {
          plan_id: binding.planId,
          page_size: request.pageSize,
          ...(cursor === null ? {} : { page_cursor: cursor.providerCursor }),
        };

        // The fixed tool owns Graph HTTP, per-user Account Center leases and same-token /me checks.
        const invocation: OfficeConnectorToolRequest = {
          bindingId: binding.bindingId,
          providerId: 'microsoft_graph',
          toolId: 'microsoft_graph.planner.tasks.list',
          operationId: 'microsoft_graph.planner.tasks.list',
          resourceProjection: 'microsoft_graph_plan',
          arguments: providerArguments,
          signal,
        };
        const result = await awaitWithSignal(context.invokeConnectorTool(invocation), signal);
        if (signal.aborted) throw new OfficeObservationError('timeout');
        const providerPage = decodeProviderPage(result, cursor?.providerCursor ?? null, request.pageSize, binding.planId);
        observedAt = now();
        if (!Number.isFinite(observedAt) || observedAt < 0) throw new OfficeObservationError('invalid');

        const window = requestWindow(request);
        const observations = providerPage.tasks.flatMap(task => {
          const projection = makeTaskProjection(task, binding.planId, window.end, observedAt);
          return [toObservation(projection, binding.planId, window.start, window.end)];
        });
        const nextCursor = providerPage.nextCursor === null
          ? null
          : encodePageCursor({
            version: 1,
            targetId: binding.targetId,
            bindingId: binding.bindingId,
            planId: binding.planId,
            pageSize: request.pageSize,
            windowStart: request.windowStart,
            windowEnd: request.windowEnd,
            providerCursor: providerPage.nextCursor,
          });
        return {
          source: 'office_graph',
          observedAt,
          pageCursor: request.pageCursor,
          nextCursor,
          complete: providerPage.complete,
          truncated: false,
          observations,
        };
      } catch (error: unknown) {
        const code = error instanceof OfficeObservationError
          ? error.code
          : signal.aborted
            ? 'timeout'
            : classifyConnectorError(error);
        return failedPage(request, now(), code);
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

async function verifyPlannerPlanAccess(
  context: WorkflowObservationExecutionContext,
  bindingId: string,
  planId: string,
  signal: AbortSignal,
): Promise<'allowed' | OfficeObservationErrorCode> {
  try {
    const result = await awaitWithSignal(context.invokeConnectorTool({
      bindingId,
      providerId: 'microsoft_graph',
      toolId: 'microsoft_graph.planner.plan.get',
      operationId: 'microsoft_graph.planner.plan.get',
      resourceProjection: 'microsoft_graph_plan',
      arguments: { plan_id: planId },
      signal,
    }), signal);
    if (signal.aborted) return 'timeout';
    const extracted = extractToolResult(result);
    if (extracted.isError) return mapProviderError(extracted.errorCode);
    const row = asRecord(extracted.value);
    if (row === undefined) return 'invalid';
    if (row.id !== planId) return 'forbidden';
    return 'allowed';
  } catch (error: unknown) {
    if (signal.aborted) return 'timeout';
    if (error instanceof OfficeObservationError) return error.code;
    return mapProviderError(safeErrorCode(error));
  }
}

interface TaskProjection {
  readonly task: OfficeProviderTask;
  readonly title: string;
  readonly modifiedAt: number;
  readonly dueAt: number | null;
  readonly state: 'not_started' | 'in_progress' | 'completed';
  readonly dueState: 'unscheduled' | 'upcoming' | 'due' | 'overdue' | 'completed';
  readonly fingerprint: string;
  readonly stateClass: 'healthy' | 'incident' | 'neutral';
}

function validateRequest(request: WorkflowObservationPageRequest): OfficeObservationErrorCode | undefined {
  if (request === null || typeof request !== 'object'
    || request.source !== 'office_graph'
    || request.target?.kind !== 'planner_plan'
    || !boundedText(request.target.id, 256)
    || !boundedText(request.target.bindingId, 512)
    || !Number.isSafeInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > MAX_PAGE_SIZE
    || !(request.signal instanceof AbortSignal)) return 'invalid';
  try {
    requestWindow(request);
    if (request.pageCursor !== null
      && (typeof request.pageCursor !== 'string' || request.pageCursor.length > MAX_PAGE_CURSOR_LENGTH)) {
      return 'invalid';
    }
  } catch {
    return 'invalid';
  }
  return undefined;
}

function profileMatches(
  actorId: string,
  target: PlannerPlanTarget,
  profile: PlannerPlanSourceBinding,
): boolean {
  return profile.actorId === actorId
    && profile.targetId === target.id
    && profile.kind === target.kind
    && profile.bindingId === target.bindingId
    && boundedText(profile.profileRef, 512)
    && GRAPH_ID.test(profile.planId);
}

function decodePageCursor(
  request: WorkflowObservationPageRequest,
  profile: PlannerPlanSourceBinding,
): OfficePageCursor | null {
  if (request.pageCursor === null) return null;
  if (!request.pageCursor.startsWith(PAGE_CURSOR_PREFIX)) throw new OfficeObservationError('partial');
  const encoded = request.pageCursor.slice(PAGE_CURSOR_PREFIX.length);
  let decoded: string;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded || bytes.byteLength > 24_576) {
      throw new Error('non-canonical cursor');
    }
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new OfficeObservationError('partial');
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    throw new OfficeObservationError('partial');
  }
  const row = asRecord(value);
  if (row === undefined || !sameKeys(row, [
    'version', 'targetId', 'bindingId', 'planId', 'pageSize', 'windowStart', 'windowEnd', 'providerCursor',
  ]) || row.version !== 1
    || row.targetId !== profile.targetId || row.bindingId !== profile.bindingId || row.planId !== profile.planId
    || row.pageSize !== request.pageSize || row.windowStart !== request.windowStart
    || row.windowEnd !== request.windowEnd || typeof row.providerCursor !== 'string'
    || row.providerCursor.length < 1 || row.providerCursor.length > MAX_PROVIDER_CURSOR_LENGTH) {
    throw new OfficeObservationError('partial');
  }
  return row as unknown as OfficePageCursor;
}

function encodePageCursor(cursor: OfficePageCursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  const result = PAGE_CURSOR_PREFIX + encoded;
  if (result.length > MAX_PAGE_CURSOR_LENGTH) throw new OfficeObservationError('invalid');
  return result;
}

function decodeProviderPage(
  value: unknown,
  expectedCursor: string | null,
  pageSize: number,
  planId: string,
): OfficeProviderPage {
  const page = extractToolResult(value);
  if (page.isError) throw new OfficeObservationError(mapProviderError(page.errorCode));
  const row = asRecord(page.value);
  if (row === undefined || !sameKeys(row, ['tasks', 'page_cursor', 'next_cursor', 'complete', 'truncated'])
    || row.page_cursor !== expectedCursor
    || !(row.next_cursor === null || typeof row.next_cursor === 'string'
      && row.next_cursor.length > 0 && row.next_cursor.length <= MAX_PROVIDER_CURSOR_LENGTH)
    || typeof row.complete !== 'boolean' || row.truncated !== false
    || !Array.isArray(row.tasks) || row.tasks.length > pageSize || row.tasks.length > MAX_TASKS_PER_PAGE
    || row.complete !== (row.next_cursor === null)) {
    throw new OfficeObservationError('invalid');
  }
  if (typeof row.next_cursor === 'string' && row.next_cursor === expectedCursor) {
    throw new OfficeObservationError('partial');
  }
  const tasks = row.tasks.map(value => decodeTask(value, planId));
  const taskIds = tasks.map(task => task.taskId);
  if (new Set(taskIds).size !== taskIds.length) throw new OfficeObservationError('invalid');
  return {
    tasks,
    nextCursor: row.next_cursor as string | null,
    complete: row.complete,
    truncated: false,
  };
}

interface ExtractedToolResult {
  readonly value: unknown;
  readonly isError: boolean;
  readonly errorCode?: string;
}

function extractToolResult(value: unknown): ExtractedToolResult {
  const row = asRecord(value);
  if (row === undefined) return { value: undefined, isError: true };
  if (row.isError === true || row.error !== undefined) {
    return {
      value: undefined,
      isError: true,
      errorCode: readErrorCode(row.structuredContent) ?? readErrorCode(row.error) ?? readErrorCode(row.content),
    };
  }
  if (row.structuredContent !== undefined) {
    const structured = asRecord(row.structuredContent);
    if (structured?.error !== undefined) {
      return { value: undefined, isError: true, errorCode: readErrorCode(structured.error) };
    }
    return { value: row.structuredContent, isError: false };
  }
  const text = readTextContent(row.content);
  if (text !== undefined) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const parsedRow = asRecord(parsed);
      if (parsedRow?.error !== undefined) {
        return { value: undefined, isError: true, errorCode: readErrorCode(parsedRow.error) };
      }
      return { value: parsed, isError: false };
    } catch {
      return { value: undefined, isError: true };
    }
  }
  return { value, isError: false };
}

function readTextContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const blocks = value.flatMap(item => {
    const row = asRecord(item);
    return row?.type === 'text' && typeof row.text === 'string' ? [row.text] : [];
  });
  return blocks.length === 0 ? undefined : blocks.join('\n');
}

function readErrorCode(value: unknown): string | undefined {
  if (typeof value === 'string') {
    try {
      return readErrorCode(JSON.parse(value) as unknown);
    } catch {
      return /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : undefined;
    }
  }
  const row = asRecord(value);
  if (row === undefined) {
    const text = readTextContent(value);
    return text === undefined ? undefined : readErrorCode(text);
  }
  const error = asRecord(row.error);
  const direct = typeof row.code === 'string' ? row.code : undefined;
  const nested = typeof error?.code === 'string' ? error.code : undefined;
  const result = direct ?? nested;
  return result !== undefined && /^[A-Z][A-Z0-9_]{0,63}$/u.test(result) ? result : undefined;
}

function mapProviderError(code?: string): OfficeObservationErrorCode {
  switch (code) {
    case 'AUTHENTICATION_DENIED':
    case 'AUTHORIZATION_DENIED':
    case 'GRAPH_AUTHENTICATION_FAILED':
    case 'GRAPH_ACCESS_DENIED':
    case 'GRAPH_ACTOR_MISMATCH':
    case 'PROFILE_SCOPE_MISMATCH':
      return 'forbidden';
    case 'RESOURCE_NOT_FOUND':
    case 'GRAPH_RESOURCE_NOT_FOUND':
      return 'not_configured';
    case 'INVALID_PROVIDER_CURSOR':
    case 'GRAPH_DELTA_RESYNC_REQUIRED':
      return 'partial';
    case 'INVALID_ARGUMENTS':
    case 'INVALID_PROVIDER_RESPONSE':
    case 'GRAPH_RESPONSE_TOO_LARGE':
    case 'GRAPH_INVALID_REQUEST':
      return 'invalid';
    case 'AUTHORIZATION_UNAVAILABLE':
    case 'GRAPH_RATE_LIMITED':
    case 'GRAPH_UPSTREAM_UNAVAILABLE':
    case 'GRAPH_REQUEST_REJECTED':
      return 'unavailable';
    default:
      return 'unavailable';
  }
}

function decodeTask(value: unknown, expectedPlanId: string): OfficeProviderTask {
  const row = asRecord(value);
  const required = [
    'task_id', 'plan_id', 'bucket_id', 'title', 'percent_complete', 'priority',
    'due_date_time', 'start_date_time', 'created_date_time', 'last_modified_date_time', 'etag',
  ];
  if (row === undefined || !sameKeys(row, required)
    || typeof row.task_id !== 'string' || !GRAPH_ID.test(row.task_id)
    || row.plan_id !== expectedPlanId
    || !(row.bucket_id === null || typeof row.bucket_id === 'string' && GRAPH_ID.test(row.bucket_id))
    || typeof row.title !== 'string' || row.title.length > MAX_TASK_TITLE_LENGTH
    || !Number.isSafeInteger(row.percent_complete) || Number(row.percent_complete) < 0 || Number(row.percent_complete) > 100
    || !Number.isSafeInteger(row.priority) || Number(row.priority) < 0 || Number(row.priority) > 10
    || !optionalIsoDate(row.due_date_time) || !optionalIsoDate(row.start_date_time)
    || !requiredIsoDate(row.created_date_time) || !requiredIsoDate(row.last_modified_date_time)
    || typeof row.etag !== 'string' || row.etag.trim() !== row.etag
    || row.etag.length < 1 || row.etag.length > MAX_ETAG_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(row.etag)) {
    throw new OfficeObservationError('invalid');
  }
  return {
    taskId: row.task_id,
    planId: row.plan_id,
    bucketId: row.bucket_id as string | null,
    title: row.title,
    percentComplete: Number(row.percent_complete),
    priority: Number(row.priority),
    dueDateTime: row.due_date_time as string | null,
    startDateTime: row.start_date_time as string | null,
    createdDateTime: row.created_date_time,
    lastModifiedDateTime: row.last_modified_date_time,
    etag: row.etag,
  };
}

function makeTaskProjection(
  task: OfficeProviderTask,
  planId: string,
  windowEnd: number,
  observedAt: number,
): TaskProjection {
  const modifiedAt = Date.parse(task.lastModifiedDateTime);
  const createdAt = Date.parse(task.createdDateTime);
  const dueAt = task.dueDateTime === null ? null : Date.parse(task.dueDateTime);
  const startAt = task.startDateTime === null ? null : Date.parse(task.startDateTime);
  if (!Number.isFinite(modifiedAt) || !Number.isFinite(createdAt)
    || modifiedAt > observedAt + MAX_CLOCK_SKEW_MS || createdAt > observedAt + MAX_CLOCK_SKEW_MS
    || (dueAt !== null && !Number.isFinite(dueAt)) || (startAt !== null && !Number.isFinite(startAt))) {
    throw new OfficeObservationError('invalid');
  }
  if (task.planId !== planId) throw new OfficeObservationError('forbidden');
  const title = cleanTitle(task.title);
  const state = task.percentComplete === 100 ? 'completed'
    : task.percentComplete === 0 ? 'not_started' : 'in_progress';
  const dueState = state === 'completed' ? 'completed'
    : dueAt === null ? 'unscheduled'
      : dueAt > windowEnd ? 'upcoming'
        : dueAt === windowEnd ? 'due' : 'overdue';
  const fingerprint = sha256(JSON.stringify([
    1,
    task.taskId,
    task.planId,
    task.bucketId,
    title,
    task.percentComplete,
    task.priority,
    task.dueDateTime,
    task.startDateTime,
    state,
    dueState,
  ]));
  return {
    task,
    title,
    modifiedAt,
    dueAt,
    state,
    dueState,
    fingerprint,
    stateClass: dueState === 'overdue' ? 'incident' : state === 'completed' ? 'healthy' : 'neutral',
  };
}

function toObservation(
  projection: TaskProjection,
  planId: string,
  start: number | null,
  end: number,
): WorkflowSourceObservation {
  const dueTransition = projection.state !== 'completed'
    && projection.dueAt !== null && (start === null || projection.dueAt >= start) && projection.dueAt <= end;
  const transitionAt = dueTransition
    ? projection.dueAt!
    : projection.modifiedAt;
  const occurredAt = Math.min(transitionAt, end);
  const dueDescription = projection.dueState === 'overdue' ? 'overdue'
    : projection.dueState === 'due' ? 'due now'
      : projection.dueState === 'upcoming' ? `due ${projection.task.dueDateTime!.slice(0, 10)}`
        : projection.dueState === 'completed' ? 'no outstanding due date' : 'no due date';
  const safeTitle = projection.title || 'Untitled Planner task';
  const status = projection.state.replace('_', ' ');
  const summary = `Planner task "${safeTitle}" is ${status}; ${projection.task.percentComplete}% complete; ${dueDescription}.`;
  const sourceEventId = `planner-task:${sha256(JSON.stringify([
    planId, projection.task.taskId, projection.task.etag, projection.fingerprint,
  ]))}`;
  return {
    source: 'office_graph',
    sourceEventId,
    resourceUri: `https://graph.microsoft.com/v1.0/planner/tasks/${encodeURIComponent(projection.task.taskId)}`,
    // Work caps sourceVersion at 512 characters; hash only valid oversized Graph ETags.
    sourceVersion: projection.task.etag.length <= 512
      ? projection.task.etag
      : `sha256:${sha256(projection.task.etag)}`,
    eventType: EVENT_TYPE,
    occurredAt,
    title: safeTitle || 'Planner task',
    summary,
    ...(projection.dueState === 'overdue' ? { severity: 'warning' as const } : {}),
    semanticFingerprint: projection.fingerprint,
    stateClass: projection.stateClass,
  };
}

function cleanTitle(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_TASK_TITLE_LENGTH);
}

function optionalIsoDate(value: unknown): boolean {
  return value === null || requiredIsoDate(value);
}

function requiredIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function requestWindow(request: WorkflowObservationPageRequest): { readonly start: number | null; readonly end: number } {
  if (!requiredIsoDate(request.windowEnd)
    || (request.windowStart !== null && !requiredIsoDate(request.windowStart))) {
    throw new OfficeObservationError('invalid');
  }
  const start = request.windowStart === null ? null : Date.parse(request.windowStart);
  const end = Date.parse(request.windowEnd);
  if (start !== null && start > end) throw new OfficeObservationError('invalid');
  return { start, end };
}

function failedPage(
  request: Pick<WorkflowObservationPageRequest, 'pageCursor'> | undefined,
  observedAt: number,
  code: OfficeObservationErrorCode,
): WorkflowObservationPage {
  return {
    source: 'office_graph',
    observedAt: Number.isFinite(observedAt) && observedAt >= 0 ? observedAt : Date.now(),
    pageCursor: request?.pageCursor ?? null,
    nextCursor: null,
    complete: false,
    truncated: false,
    observations: [],
    error: { code },
  };
}

function classifyConnectorError(error: unknown): OfficeObservationErrorCode {
  const code = safeErrorCode(error);
  return code === undefined ? 'unavailable' : mapProviderError(code);
}

function safeErrorCode(error: unknown): string | undefined {
  if (error instanceof OfficeObservationError) return error.code.toUpperCase();
  if (error instanceof Error) {
    const row = error as Error & { readonly code?: unknown };
    if (typeof row.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(row.code)) return row.code;
    return /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.message) ? error.message : undefined;
  }
  return readErrorCode(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Race an asynchronous read against caller cancellation and the adapter deadline. */
function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new OfficeObservationError('timeout'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new OfficeObservationError('timeout')));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      result => finish(() => resolve(result)),
      error => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}
