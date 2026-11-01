// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator research and work feature                         │
// │ Role: Save receipt-backed notes and run sourced DSH watch checks.   │
// │ 模块职责：保存回执支持的研究笔记并执行带来源的 DSH 观察任务。         │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';
import {
  authorizeConversationSourcesV1,
  hasConversationContextProofV1,
  recordConversationContextSourcesV1,
  ConversationFeatureError,
  type ContextContribution,
  type ConversationContextInput,
  type ConversationDeliveryDecision,
  type ConversationDeliveryInput,
  type ConversationSourceRef,
  type TrustedTurnContext,
} from './conversation-memory.ts';
import {
  ConversationDomainApiError,
  type ConversationDomainApiV1,
  type ConversationWatch,
  type ResearchNote,
  type VerifiedSkill,
} from './conversation-domain-api.ts';
import { conversationWorkTaskId } from './conversation-dsh-runtime.ts';
import type { DshConversationFeatureTaskPortV1 } from './conversation-dsh-runtime.ts';
import {
  conversationScheduleMarker,
  type ConversationDshScheduler,
} from './conversation-schedule.ts';

const RESEARCH_FEATURE_ID = 'research-work.v1';
const MAX_RESEARCH_NOTES = 12;
const MAX_VERIFIED_SKILLS = 24;
const MAX_RESEARCH_CONTEXT_CHARACTERS = 12_000;
const MAX_NOTE_CONTENT = 16_000;
const MAX_WATCH_TITLE = 180;
const MAX_WATCH_CONDITION = 2_000;
const DEFAULT_WATCH_INTERVAL_MS = 15 * 60_000;

/** One verified Work operation; source references come from the server receipt, not the model. */
export interface ResearchOperationReceiptV1 {
  readonly id: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly taskId: string;
  readonly taskStatus: 'completed' | 'failed' | 'aborted';
  readonly taskOutputSha256: string;
  readonly status: 'started' | 'uncertain' | 'verified';
  readonly operationType: string;
  readonly effect: 'read' | 'write';
  readonly resultSha256: string;
  readonly contentSha256: string;
  readonly targetDigestSha256: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly independentReadOperationId?: string;
  readonly verifiedAt: number;
}

/** Host adapter reads receipt data from the authenticated durable Work receipt store. */
export interface ResearchOperationReceiptReaderV1 {
  readonly apiVersion: 1;
  read(context: TrustedTurnContext, operationId: string): Promise<ResearchOperationReceiptV1>;
}

/** Native web/document reader; it returns a Work operation ID, never caller-supplied source refs. */
export interface ResearchReadProviderV1 {
  readonly apiVersion: 1;
  read(input: {
    readonly agent: Agent;
    readonly scope: {
      readonly workspaceId: string;
      readonly actorId: string;
      readonly conversationId: string;
      readonly conversationKind: TrustedTurnContext['conversationKind'];
      readonly personaId: string | null;
    };
    readonly query: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly operationId: string;
    readonly title: string;
    readonly content: string;
    readonly resultSha256: string;
    readonly contentSha256: string;
  }>;
}

/** Read-only observation provider invoked from one DSH scheduled feature task. */
export interface ResearchWatchProviderV1 {
  readonly apiVersion: 1;
  observe(input: {
    readonly agent: Agent;
    readonly scope: {
      readonly workspaceId: string;
      readonly actorId: string;
      readonly conversationId: string;
      readonly conversationKind: TrustedTurnContext['conversationKind'];
      readonly personaId: string | null;
    };
    readonly condition: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly operationId: string;
    readonly title: string;
    readonly content: string;
    readonly resultSha256: string;
    readonly contentSha256: string;
    readonly changed: boolean;
    readonly nextCheckAt: number;
  }>;
}

export interface ResearchWorkOptions {
  readonly api: ConversationDomainApiV1;
  readonly receipts?: ResearchOperationReceiptReaderV1;
  readonly reader?: ResearchReadProviderV1;
  readonly watcher?: ResearchWatchProviderV1;
  readonly tasks?: DshConversationFeatureTaskPortV1;
  readonly scheduler: ConversationDshScheduler;
  readonly enabled?: boolean;
  readonly now?: () => number;
}

export interface ResearchWorkFeature {
  readonly apiVersion: 1;
  beforeContext(context: TrustedTurnContext, input: ConversationContextInput): Promise<{
    readonly contributions: readonly ContextContribution[];
  }>;
  beforeDelivery(context: TrustedTurnContext, input: ConversationDeliveryInput): Promise<ConversationDeliveryDecision>;
  research(context: TrustedTurnContext, input: { readonly query: string; readonly idempotencyKey: string }): Promise<ResearchNote>;
  createVerifiedSkill(context: TrustedTurnContext, input: {
    readonly operationId: string;
    readonly readbackOperationId: string;
    readonly name: string;
    readonly content: string;
  }): Promise<VerifiedSkill>;
  createWatch(context: TrustedTurnContext, input: {
    readonly userEventId: string;
    readonly title: string;
    readonly condition: string;
    readonly nextCheckAt?: number;
  }): Promise<ConversationWatch>;
  recoverWatches(context: TrustedTurnContext): Promise<number>;
  runScheduledWatch(context: TrustedTurnContext, watchId: string): Promise<{
    readonly watch: ConversationWatch;
    readonly taskId: string;
    readonly taskStatus: string;
    readonly note?: ResearchNote;
  }>;
  cancelWatch(context: TrustedTurnContext, watchId: string, expectedVersion: number): Promise<{
    readonly watch: ConversationWatch;
    readonly taskCancellationRequested: boolean;
    readonly scheduleEntriesRemoved: number;
  }>;
}

interface ResearchTaskOutputV1 {
  readonly version: 1;
  readonly operationId: string;
  readonly title: string;
  readonly content: string;
  readonly resultSha256: string;
  readonly contentSha256: string;
  readonly changed?: boolean;
  readonly nextCheckAt?: number;
}

/** Receipt-backed research consumer and durable DSH watch scheduler. */
export function createResearchWorkFeature(options: ResearchWorkOptions): ResearchWorkFeature {
  if (options.api?.apiVersion !== 1) throw new ConversationFeatureError('MEMORY_API_UNAVAILABLE', 'Conversation Work API v1 is required');
  const enabled = options.enabled ?? true;
  const now = options.now ?? Date.now;
  if (enabled && options.receipts?.apiVersion !== 1) {
    throw new ConversationFeatureError('MEMORY_API_UNAVAILABLE', 'A trusted Work operation receipt reader v1 is required');
  }
  if (enabled && options.reader?.apiVersion !== 1) {
    throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'A configured research reader v1 is required');
  }
  if (enabled && (options.watcher?.apiVersion !== 1 || options.tasks?.runFeatureTask === undefined)) {
    throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'A configured DSH watch task and observation provider are required');
  }

  const feature: ResearchWorkFeature = {
    apiVersion: 1 as const,

    async beforeContext(context) {
      recordConversationContextSourcesV1(context, RESEARCH_FEATURE_ID, []);
      context.signal.throwIfAborted();
      if (!enabled) return { contributions: [] };
      const [notes, skills] = await Promise.all([
        options.api.listResearchNotes(context, { conversationId: context.conversationId, limit: MAX_RESEARCH_NOTES }),
        options.api.listVerifiedSkills(context, { limit: MAX_VERIFIED_SKILLS }),
      ]);
      const contributions: ContextContribution[] = [];
      let characterCount = 0;
      const retainedSources: ConversationSourceRef[] = [];
      const entries = [
        ...notes.items.filter(note => note.conversationId === context.conversationId).map(note => ({
          type: 'note' as const, id: note.id, title: note.title, content: note.content, sourceRefs: note.sourceRefs,
        })),
        ...skills.items.filter(skill => skill.verified === true).map(skill => ({
          type: 'skill' as const, id: skill.id, title: skill.name, content: skill.content, sourceRefs: skill.sourceRefs,
        })),
      ];
      for (const entry of entries) {
        context.signal.throwIfAborted();
        const refs = validateSourceRefs(entry.sourceRefs);
        if (refs.length === 0) continue;
        const proof = await authorizeConversationSourcesV1(options.api, context, refs);
        if (proof.unavailable === true || !proof.allowed
          || proof.currentAuthorizationEpoch !== context.authorizationEpoch) continue;
        const text = `[${entry.type}:${entry.title}] ${entry.content}`;
        if (characterCount + text.length > MAX_RESEARCH_CONTEXT_CHARACTERS) break;
        contributions.push({ feature: RESEARCH_FEATURE_ID, content: text, sourceRefs: refs });
        retainedSources.push(...refs);
        characterCount += text.length;
      }
      recordConversationContextSourcesV1(context, RESEARCH_FEATURE_ID, retainedSources);
      return { contributions };
    },

    async beforeDelivery(context, input) {
      context.signal.throwIfAborted();
      if (!hasConversationContextProofV1(context, RESEARCH_FEATURE_ID, input.sourceRefs)) {
        return { decision: 'hold', code: 'SOURCE_PROOF_MISSING', authorizationEpoch: context.authorizationEpoch };
      }
      const proof = await authorizeConversationSourcesV1(options.api, context, input.sourceRefs);
      if (proof.unavailable === true) return { decision: 'hold', code: 'SOURCE_AUTHORIZATION_UNAVAILABLE', authorizationEpoch: context.authorizationEpoch };
      if (!proof.allowed) return { decision: 'hold', code: 'SOURCE_AUTHORIZATION_REVOKED', authorizationEpoch: proof.currentAuthorizationEpoch };
      if (proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
        return { decision: 'hold', code: 'SOURCE_AUTHORIZATION_EPOCH_CHANGED', authorizationEpoch: proof.currentAuthorizationEpoch };
      }
      return { decision: 'allow', authorizationEpoch: proof.currentAuthorizationEpoch };
    },

    async research(context, input) {
      context.signal.throwIfAborted();
      ensureEnabled(enabled);
      const query = boundedText(input.query, 2_000);
      const idempotencyKey = checkedIdentifier(input.idempotencyKey, 'research idempotency key');
      if (!query) throw new ConversationDomainApiError('RESEARCH_QUERY_INVALID', 422, false, 'Research query is empty');
      const provider = options.reader!;
      const outcome = await requireTasks(options).runFeatureTask({ workspaceId: context.workspaceId, actorId: context.actorId }, {
        taskId: conversationWorkTaskId('research', `research:${context.taskId}:${idempotencyKey}`),
        sessionId: context.sessionId,
        prompt: 'Read the requested source using authorized read-only tools and return only the verified result envelope.',
        metadata: {
          source: 'conversation-research-read',
          workspaceId: context.workspaceId,
          actorId: context.actorId,
          conversationId: context.conversationId,
          idempotencyKey,
        },
      }, async (agent, signal) => {
        const result = await provider.read({ agent, scope: scopeOf(context), query, signal });
        return serializeTaskOutput(validateTaskOutput({ version: 1, ...result }));
      }, context.signal);
      if (outcome.status !== 'completed') {
        throw new ConversationDomainApiError('RESEARCH_TASK_INCOMPLETE', 409, false, 'Research read task did not complete');
      }
      const result = parseTaskOutput(outcome.output);
      return saveResearchNote(options, context, result, idempotencyKey);
    },

    async createVerifiedSkill(context, input) {
      context.signal.throwIfAborted();
      ensureEnabled(enabled);
      const operationId = checkedIdentifier(input.operationId, 'Work operation id');
      const readbackOperationId = checkedIdentifier(input.readbackOperationId, 'Work readback receipt id');
      const write = await requireReceipts(options).read(context, operationId);
      const readback = await requireReceipts(options).read(context, readbackOperationId);
      if (write.id !== operationId || readback.id !== readbackOperationId) {
        throw new ConversationDomainApiError('WORK_OPERATION_RECEIPT_INVALID', 409, false, 'Work receipt lookup returned another operation');
      }
      validateVerifiedWriteReceipt(write, context);
      validateVerifiedReadReceipt(readback, context);
      if (write.independentReadOperationId !== readback.id || write.targetDigestSha256 !== readback.targetDigestSha256) {
        throw new ConversationDomainApiError('SKILL_OPERATION_READBACK_MISMATCH', 409, false, 'Skill operation has no matching independent readback receipt');
      }
      const sourceRefs = normalizeSourceRefs([...validateSourceRefs(write.sourceRefs), ...validateSourceRefs(readback.sourceRefs)]);
      if (sourceRefs.length === 0) throw new ConversationDomainApiError('SKILL_SOURCE_REQUIRED', 422, false, 'Verified skill requires sourced operation evidence');
      const proof = await authorizeConversationSourcesV1(options.api, context, sourceRefs);
      if (proof.unavailable === true || !proof.allowed || proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
        throw new ConversationDomainApiError('SKILL_SOURCE_REVOKED', 409, false, 'Skill evidence is no longer authorized');
      }
      const name = boundedText(input.name, 160);
      const content = boundedText(input.content, 12_000);
      if (!name || !content) throw new ConversationDomainApiError('SKILL_CONTENT_INVALID', 422, false, 'Skill name and content are required');
      if (readback.contentSha256 !== sha256Text(content)) {
        throw new ConversationDomainApiError('SKILL_READBACK_CONTENT_MISMATCH', 409, false, 'Independent readback content does not match the proposed skill');
      }
      const result = await options.api.createVerifiedSkill(context, {
        idempotencyKey: operationIdempotencyKey(write.id, readback.id, name, content),
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        personaId: context.personaId,
        operationReceiptId: write.id,
        independentReadReceiptId: readback.id,
        name,
        content,
        sourceRefs,
      });
      return result.skill;
    },

    async createWatch(context, input) {
      context.signal.throwIfAborted();
      ensureEnabled(enabled);
      const title = boundedText(input.title, MAX_WATCH_TITLE);
      const condition = boundedText(input.condition, MAX_WATCH_CONDITION);
      if (!title || !condition) throw new ConversationDomainApiError('WATCH_INPUT_INVALID', 422, false, 'Watch title and condition are required');
      const message = await findUserMessage(options.api, context, input.userEventId);
      const sourceRefs = [rawRef(message.id)];
      await requireAuthorized(options.api, context, sourceRefs, 'WATCH_SOURCE_REVOKED');
      const nextCheckAt = input.nextCheckAt ?? now() + DEFAULT_WATCH_INTERVAL_MS;
      if (!Number.isSafeInteger(nextCheckAt) || nextCheckAt <= now()) {
        throw new ConversationDomainApiError('WATCH_TIME_INVALID', 422, false, 'Watch check time must be in the future');
      }
      const created = await options.api.createWatch(context, {
        idempotencyKey: operationIdempotencyKey('watch', context.conversationId, message.id, title, condition),
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        personaId: context.personaId,
        title,
        condition,
        sourceRefs,
        nextCheckAt,
      });
      const watch = created.watch;
      if (watch.state !== 'active') throw new ConversationDomainApiError('WATCH_CREATE_INACTIVE', 409, false, 'New watch was not active');
      await options.scheduler.ensureOneShot(conversationScheduleMarker('watch', watch.id), nextCheckAt, { signal: context.signal });
      return watch;
    },

    async recoverWatches(context) {
      context.signal.throwIfAborted();
      if (!enabled) return 0;
      let restored = 0;
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      while (true) {
        context.signal.throwIfAborted();
        const page = await options.api.listWatches(context, {
          state: 'active', conversationId: context.conversationId,
          ...(cursor === undefined ? {} : { cursor }), limit: 500,
        });
        if (page.items.length > 500) throw new ConversationDomainApiError('WATCH_RECOVERY_PAGE_LIMIT', 502, false, 'Watch recovery page exceeded its limit');
        for (const watch of page.items) {
          context.signal.throwIfAborted();
          if (watch.state !== 'active' || watch.conversationId !== context.conversationId
            || watch.conversationKind !== context.conversationKind || watch.personaId !== context.personaId) continue;
          const proof = await authorizeConversationSourcesV1(options.api, context, validateSourceRefs(watch.sourceRefs));
          if (proof.unavailable === true || !proof.allowed || proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
            await options.api.cancelWatch(context, watch.id, watch.version);
            await options.scheduler.cancel(conversationScheduleMarker('watch', watch.id), context.signal);
            continue;
          }
          const dueAt = watch.nextCheckAt !== null && watch.nextCheckAt > now()
            ? watch.nextCheckAt
            : now() + 1_000;
          const effectiveWatch = dueAt === watch.nextCheckAt ? watch : (await options.api.scheduleWatch(context, watch.id, {
            expectedVersion: watch.version,
            nextCheckAt: dueAt,
          })).watch;
          const entry = await options.scheduler.ensureOneShot(
            conversationScheduleMarker('watch', effectiveWatch.id), dueAt,
            { signal: context.signal, rearmInactive: true },
          );
          if (entry.active) restored += 1;
        }
        if (page.nextCursor === null) break;
        if (!page.nextCursor || page.nextCursor === cursor || seenCursors.has(page.nextCursor)) {
          throw new ConversationDomainApiError('WATCH_RECOVERY_CURSOR_STALLED', 502, false, 'Watch recovery cursor did not advance');
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      return restored;
    },

    async runScheduledWatch(context, watchId) {
      context.signal.throwIfAborted();
      ensureEnabled(enabled);
      const { watch } = await findWatch(options.api, context, watchId);
      if (watch.state !== 'active') throw new ConversationDomainApiError('WATCH_NOT_ACTIVE', 409, false, 'Watch is no longer active');
      await requireAuthorized(options.api, context, validateSourceRefs(watch.sourceRefs), 'WATCH_SOURCE_REVOKED');
      const taskId = conversationWorkTaskId('watch', `${watch.id}:v${watch.version}`);
      const provider = options.watcher!;
      const outcome = await requireTasks(options).runFeatureTask({ workspaceId: context.workspaceId, actorId: context.actorId }, {
        taskId,
        sessionId: context.sessionId,
        prompt: 'Evaluate one stored read-only watch condition using authorized tools. Do not perform writes or send messages.',
        metadata: {
          source: 'conversation-watch',
          workspaceId: context.workspaceId,
          actorId: context.actorId,
          watchId: watch.id,
          watchVersion: watch.version,
          idempotencyKey: watch.idempotencyKey,
        },
      }, async (agent, signal) => {
        const result = await provider.observe({ agent, scope: scopeOf(context), condition: watch.condition, signal });
        return serializeTaskOutput(validateTaskOutput({ version: 1, ...result, changed: result.changed, nextCheckAt: result.nextCheckAt }));
      }, context.signal);
      if (outcome.status !== 'completed') return { watch, taskId, taskStatus: outcome.status };
      const observation = parseTaskOutput(outcome.output);
      const receipt = await requireReceipts(options).read(context, observation.operationId);
      validateVerifiedReadReceipt(receipt, context);
      if (receipt.id !== observation.operationId) throw new ConversationDomainApiError('WORK_OPERATION_RECEIPT_INVALID', 409, false, 'Watch receipt lookup returned another operation');
      if (receipt.resultSha256 !== observation.resultSha256) {
        throw new ConversationDomainApiError('WATCH_RECEIPT_DIGEST_MISMATCH', 409, false, 'Watch result does not match its Work operation receipt');
      }
      if (receipt.contentSha256 !== observation.contentSha256) {
        throw new ConversationDomainApiError('WATCH_RECEIPT_CONTENT_MISMATCH', 409, false, 'Watch content does not match its Work operation receipt');
      }
      const sourceRefs = normalizeSourceRefs([...validateSourceRefs(watch.sourceRefs), ...validateSourceRefs(receipt.sourceRefs)]);
      await requireAuthorized(options.api, context, sourceRefs, 'WATCH_SOURCE_REVOKED');
      let note: ResearchNote | undefined;
      if (observation.changed === true) {
        const saved = await options.api.createResearchNote(context, {
          idempotencyKey: operationIdempotencyKey('watch-note', watch.id, receipt.id, observation.resultSha256),
          conversationId: context.conversationId,
          conversationKind: context.conversationKind,
          personaId: context.personaId,
          title: observation.title,
          content: observation.content,
          sourceRefs,
        });
        note = saved.note;
      }
      if (watch.state === 'active') {
        const nextCheckAt = observation.nextCheckAt ?? now() + DEFAULT_WATCH_INTERVAL_MS;
        if (nextCheckAt <= now()) throw new ConversationDomainApiError('WATCH_TIME_INVALID', 502, false, 'Watch provider returned a past next check');
        const updated = await options.api.scheduleWatch(context, watch.id, {
          expectedVersion: watch.version,
          nextCheckAt,
        });
        if (updated.watch.state === 'active') {
          await options.scheduler.ensureOneShot(conversationScheduleMarker('watch', watch.id), nextCheckAt, {
            signal: context.signal,
          });
        }
        return { watch: updated.watch, taskId, taskStatus: outcome.status, ...(note === undefined ? {} : { note }) };
      }
      return { watch, taskId, taskStatus: outcome.status, ...(note === undefined ? {} : { note }) };
    },

    async cancelWatch(context, watchId, expectedVersion) {
      context.signal.throwIfAborted();
      const { watch } = await findWatch(options.api, context, watchId);
      if (watch.version !== expectedVersion) throw new ConversationDomainApiError('WATCH_VERSION_CONFLICT', 409, false, 'Watch version changed');
      const taskCancellationRequested = await requireTasks(options).cancelFeatureTask(
        { workspaceId: context.workspaceId, actorId: context.actorId },
        conversationWorkTaskId('watch', `${watch.id}:v${watch.version}`),
        context.signal,
      );
      const scheduleEntriesRemoved = await options.scheduler.cancel(conversationScheduleMarker('watch', watch.id), context.signal);
      const cancelled = await options.api.cancelWatch(context, watchId, expectedVersion);
      return { watch: cancelled.watch, taskCancellationRequested, scheduleEntriesRemoved };
    },
  };
  return Object.freeze(feature);
}

async function saveResearchNote(
  options: ResearchWorkOptions,
  context: TrustedTurnContext,
  result: ResearchTaskOutputV1,
  idempotencyKey: string,
): Promise<ResearchNote> {
  const receipt = await requireReceipts(options).read(context, result.operationId);
  validateVerifiedReadReceipt(receipt, context);
  if (receipt.id !== result.operationId) throw new ConversationDomainApiError('WORK_OPERATION_RECEIPT_INVALID', 409, false, 'Research receipt lookup returned another operation');
  if (receipt.resultSha256 !== result.resultSha256) {
    throw new ConversationDomainApiError('RESEARCH_RECEIPT_DIGEST_MISMATCH', 409, false, 'Research output does not match its Work operation receipt');
  }
  if (receipt.contentSha256 !== result.contentSha256) {
    throw new ConversationDomainApiError('RESEARCH_RECEIPT_CONTENT_MISMATCH', 409, false, 'Research content does not match its Work operation receipt');
  }
  const sourceRefs = validateSourceRefs(receipt.sourceRefs);
  if (sourceRefs.length === 0) throw new ConversationDomainApiError('RESEARCH_SOURCE_REQUIRED', 422, false, 'Research note has no verified source references');
  await requireAuthorized(options.api, context, sourceRefs, 'RESEARCH_SOURCE_REVOKED');
  const created = await options.api.createResearchNote(context, {
    idempotencyKey: operationIdempotencyKey(idempotencyKey, receipt.id, result.resultSha256),
    conversationId: context.conversationId,
    conversationKind: context.conversationKind,
    personaId: context.personaId,
    title: result.title,
    content: result.content,
    sourceRefs,
  });
  return created.note;
}

async function findUserMessage(api: ConversationDomainApiV1, context: TrustedTurnContext, eventId: string) {
  const result = await api.listMessages(context, {
    conversationId: context.conversationId,
    conversationKind: context.conversationKind,
    order: 'desc',
    limit: 100,
  });
  const message = result.items.find(item => item.eventId === eventId && item.role === 'user' && item.status === 'active'
    && item.scope.conversationId === context.conversationId
    && item.scope.conversationKind === context.conversationKind
    && item.scope.personaId === context.personaId
    && item.scope.visibility === context.visibility);
  if (message === undefined) throw new ConversationDomainApiError('WATCH_MESSAGE_NOT_FOUND', 404, false, 'Watch request user message was not found');
  return message;
}

async function findWatch(api: ConversationDomainApiV1, context: TrustedTurnContext, watchId: string): Promise<{ readonly watch: ConversationWatch }> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await api.listWatches(context, {
      conversationId: context.conversationId,
      ...(cursor === undefined ? {} : { cursor }),
      limit: 500,
    });
    const watch = page.items.find(item => item.id === watchId && item.conversationId === context.conversationId);
    if (watch !== undefined) return { watch };
    if (page.nextCursor === null) break;
    if (!page.nextCursor || page.nextCursor === cursor || seenCursors.has(page.nextCursor)) {
      throw new ConversationDomainApiError('WATCH_CURSOR_STALLED', 502, false, 'Watch list cursor did not advance');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new ConversationDomainApiError('WATCH_NOT_FOUND', 404, false, 'Watch was not found in this conversation');
}

async function requireAuthorized(
  api: ConversationDomainApiV1,
  context: TrustedTurnContext,
  refs: readonly ConversationSourceRef[],
  code: string,
): Promise<void> {
  const proof = await authorizeConversationSourcesV1(api, context, refs);
  if (proof.unavailable === true || proof.currentAuthorizationEpoch !== context.authorizationEpoch || !proof.allowed) {
    throw new ConversationDomainApiError(code, 409, false, 'Stored research evidence is no longer authorized');
  }
}

function validateVerifiedReadReceipt(receipt: ResearchOperationReceiptV1, context: TrustedTurnContext): void {
  validateReceipt(receipt, context);
  if (receipt.effect !== 'read') throw new ConversationDomainApiError('RESEARCH_RECEIPT_NOT_READ', 409, false, 'A completed read operation receipt is required');
}

function validateVerifiedWriteReceipt(receipt: ResearchOperationReceiptV1, context: TrustedTurnContext): void {
  validateReceipt(receipt, context);
  if (receipt.effect !== 'write' || receipt.independentReadOperationId === undefined) {
    throw new ConversationDomainApiError('SKILL_RECEIPT_NOT_VERIFIED', 409, false, 'A verified write and independent readback are required');
  }
}

function validateReceipt(receipt: ResearchOperationReceiptV1, context: TrustedTurnContext): void {
  if (receipt.status !== 'verified' || receipt.workspaceId !== context.workspaceId || receipt.actorId !== context.actorId
    || receipt.taskStatus !== 'completed' || !isIdentifier(receipt.taskId)
    || !/^[a-f0-9]{64}$/u.test(receipt.taskOutputSha256)
    || !/^[a-f0-9]{64}$/u.test(receipt.resultSha256)
    || !/^[a-f0-9]{64}$/u.test(receipt.contentSha256)
    || !/^[a-f0-9]{64}$/u.test(receipt.targetDigestSha256)
    || typeof receipt.operationType !== 'string' || receipt.operationType.length === 0
    || !Number.isSafeInteger(receipt.verifiedAt) || receipt.verifiedAt <= 0) {
    throw new ConversationDomainApiError('WORK_OPERATION_RECEIPT_INVALID', 409, false, 'Work operation receipt is not a verified result for the active task');
  }
}

function validateTaskOutput(value: ResearchTaskOutputV1): ResearchTaskOutputV1 {
  if (value.version !== 1 || !isIdentifier(value.operationId)
    || !boundedText(value.title, 200) || !boundedText(value.content, MAX_NOTE_CONTENT)
    || !/^[a-f0-9]{64}$/u.test(value.resultSha256)
    || !/^[a-f0-9]{64}$/u.test(value.contentSha256)
    || (value.changed !== undefined && typeof value.changed !== 'boolean')
    || (value.nextCheckAt !== undefined && !Number.isSafeInteger(value.nextCheckAt))) {
    throw new ConversationDomainApiError('RESEARCH_OUTPUT_INVALID', 502, false, 'Research provider returned an invalid result envelope');
  }
  if (sha256Text(value.content) !== value.contentSha256) {
    throw new ConversationDomainApiError('RESEARCH_OUTPUT_DIGEST_MISMATCH', 409, false, 'Research output content digest is invalid');
  }
  return {
    version: 1,
    operationId: value.operationId,
    title: value.title.trim(),
    content: value.content,
    resultSha256: value.resultSha256,
    contentSha256: value.contentSha256,
    ...(value.changed === undefined ? {} : { changed: value.changed }),
    ...(value.nextCheckAt === undefined ? {} : { nextCheckAt: value.nextCheckAt }),
  };
}

function parseTaskOutput(value: string): ResearchTaskOutputV1 {
  if (typeof value !== 'string' || value.length > MAX_NOTE_CONTENT + 1_024) {
    throw new ConversationDomainApiError('RESEARCH_TASK_OUTPUT_INVALID', 502, false, 'Completed Work Task has no valid research result');
  }
  try {
    return validateTaskOutput(JSON.parse(value) as ResearchTaskOutputV1);
  } catch (error: unknown) {
    if (error instanceof ConversationDomainApiError) throw error;
    throw new ConversationDomainApiError('RESEARCH_TASK_OUTPUT_INVALID', 502, false, 'Completed Work Task has no valid research result');
  }
}

function serializeTaskOutput(value: ResearchTaskOutputV1): string {
  return JSON.stringify(value);
}

function validateSourceRefs(values: readonly ConversationSourceRef[]): ConversationSourceRef[] {
  if (!Array.isArray(values) || values.length > 256) {
    throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Work receipt source references exceed their limit');
  }
  const groups = new Map<string, { readonly memoryId: string | null; readonly memoryVersion: number | null; readonly ids: Set<string> }>();
  for (const value of values) {
    if (typeof value !== 'object' || value === null || !Array.isArray(value.sourceMessageIds)
      || value.sourceMessageIds.length === 0 || value.sourceMessageIds.length > 128) {
      throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Work receipt contains a malformed source reference');
    }
    const validMemory = value.memoryId === null
      ? value.memoryVersion === null
      : isIdentifier(value.memoryId) && Number.isSafeInteger(value.memoryVersion) && (value.memoryVersion ?? 0) >= 1;
    if (!validMemory || value.sourceMessageIds.some((id: unknown) => !isIdentifier(id))) {
      throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Work receipt contains an invalid source identity');
    }
    const key = JSON.stringify([value.memoryId, value.memoryVersion]);
    const group = groups.get(key) ?? { memoryId: value.memoryId, memoryVersion: value.memoryVersion, ids: new Set<string>() };
    for (const id of value.sourceMessageIds) group.ids.add(id);
    groups.set(key, group);
  }
  const refs: ConversationSourceRef[] = [];
  let total = 0;
  for (const group of groups.values()) {
    const ids = [...group.ids].sort();
    total += ids.length;
    for (let offset = 0; offset < ids.length; offset += 128) {
      refs.push({ memoryId: group.memoryId, memoryVersion: group.memoryVersion, sourceMessageIds: ids.slice(offset, offset + 128) });
    }
  }
  if (total > 32_768 || refs.length > 256) throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Work receipt source lineage exceeds its limit');
  return refs;
}

function normalizeSourceRefs(values: readonly ConversationSourceRef[]): ConversationSourceRef[] {
  return validateSourceRefs(values);
}

function rawRef(messageId: string): ConversationSourceRef {
  return { memoryId: null, memoryVersion: null, sourceMessageIds: [messageId] };
}

function scopeOf(context: TrustedTurnContext) {
  return {
    workspaceId: context.workspaceId,
    actorId: context.actorId,
    conversationId: context.conversationId,
    conversationKind: context.conversationKind,
    personaId: context.personaId,
  };
}

function requireTasks(options: ResearchWorkOptions): DshConversationFeatureTaskPortV1 {
  if (options.tasks === undefined) throw new ConversationFeatureError('MEMORY_API_UNAVAILABLE', 'DSH feature Task adapter is unavailable');
  return options.tasks;
}

function requireReceipts(options: ResearchWorkOptions): ResearchOperationReceiptReaderV1 {
  if (options.receipts === undefined) throw new ConversationFeatureError('MEMORY_API_UNAVAILABLE', 'Work operation receipt reader is unavailable');
  return options.receipts;
}

function ensureEnabled(enabled: boolean): void {
  if (!enabled) throw new ConversationDomainApiError('RESEARCH_DISABLED', 409, false, 'Research features are disabled');
}

function operationIdempotencyKey(...values: readonly string[]): string {
  return `research:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function checkedIdentifier(value: string, label: string): string {
  if (!isIdentifier(value)) throw new ConversationDomainApiError('RESEARCH_INPUT_INVALID', 422, false, `${label} is invalid`);
  return value;
}

function boundedText(value: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) return '';
  return value.trim();
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_048
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
