// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Nous active behavior feature                      │
// │ Role: Gate sourced follow-ups and lifecycle changes through DSH.    │
// │ 模块职责：通过 DSH 管控有来源的跟进任务和主动行为生命周期。           │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';
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
  type ActiveBehaviorPolicy,
  type ConversationDomainApiV1,
  type ConversationHandoff,
  type FocusItem,
} from './conversation-domain-api.ts';
import { conversationWorkTaskId } from './conversation-dsh-runtime.ts';
import {
  conversationScheduleMarker,
  type ConversationDshScheduler,
} from './conversation-schedule.ts';

const NOUS_FEATURE_ID = 'nous-active.v1';
const MAX_ACTIVE_FOCUS_ITEMS = 24;
const MAX_HANDOFFS = 12;
const MAX_NOUS_CONTEXT_CHARACTERS = 8_000;
const MAX_FOCUS_SUMMARY = 2_000;
const MAX_HANDOFF_SUMMARY = 8_000;

export interface ExistingConversationTaskOutcomeV1 {
  readonly taskId: string;
  readonly status: 'completed' | 'failed' | 'aborted' | 'queued' | 'running'
    | 'waiting_approval' | 'waiting_input' | 'awaiting_user_authorization';
  readonly deliveryStatus: 'delivered' | 'held' | 'not_applicable' | 'unknown';
  readonly deliveryReceiptId?: string;
}

/** Host adapter for the normal Navigator DSH executor and authorized connector send path. */
export interface ExistingConversationTaskPortV1 {
  dispatch(context: TrustedTurnContext, input: {
    readonly taskId: string;
    readonly conversationId: string;
    readonly conversationKind: TrustedTurnContext['conversationKind'];
    readonly personaId: string | null;
    readonly visibility: TrustedTurnContext['visibility'];
    readonly idempotencyKey: string;
    readonly prompt: string;
    readonly origin: { readonly kind: string; readonly sourceId: string; readonly externalEventId: string };
    readonly sourceRefs: readonly ConversationSourceRef[];
    readonly executionClass: 'background';
  }, signal: AbortSignal): Promise<ExistingConversationTaskOutcomeV1>;
  cancel(context: TrustedTurnContext, taskId: string, signal: AbortSignal): Promise<boolean>;
  retract(context: TrustedTurnContext, taskId: string, signal: AbortSignal): Promise<{
    readonly status: 'retracted' | 'not-sent' | 'unsupported' | 'unknown';
    readonly receiptId?: string;
  }>;
}

export interface NousActiveOptions {
  readonly api: ConversationDomainApiV1;
  readonly scheduler: ConversationDshScheduler;
  readonly tasks: ExistingConversationTaskPortV1;
  readonly enabled?: boolean;
  readonly now?: () => number;
}

export interface NousActiveFeature {
  readonly apiVersion: 1;
  beforeContext(context: TrustedTurnContext, input: ConversationContextInput): Promise<{
    readonly contributions: readonly ContextContribution[];
  }>;
  beforeDelivery(context: TrustedTurnContext, input: ConversationDeliveryInput): Promise<ConversationDeliveryDecision>;
  createFocusItem(context: TrustedTurnContext, input: {
    readonly userEventId: string;
    readonly kind: FocusItem['kind'];
    readonly summary: string;
    readonly dueAt?: number;
    readonly condition?: string;
  }): Promise<FocusItem>;
  transitionFocusItem(context: TrustedTurnContext, focusItemId: string, input: {
    readonly state: FocusItem['state'];
    readonly expectedVersion: number;
  }): Promise<FocusItem>;
  scheduleFollowup(context: TrustedTurnContext, focusItemId: string, dueAt?: number): Promise<{
    readonly status: 'scheduled' | 'deferred' | 'disabled' | 'held';
    readonly dueAt?: number;
    readonly scheduleId?: string;
  }>;
  runScheduledFollowup(context: TrustedTurnContext, focusItemId: string): Promise<{
    readonly status: 'dispatched' | 'deferred' | 'held' | 'disabled';
    readonly taskOutcome?: ExistingConversationTaskOutcomeV1;
    readonly dueAt?: number;
  }>;
  retractFollowup(context: TrustedTurnContext, focusItemId: string, version: number): Promise<{
    readonly taskCancellationRequested: boolean;
    readonly scheduleEntriesRemoved: number;
    readonly retraction: 'retracted' | 'unsupported' | 'unknown' | 'not-sent';
    readonly receiptId?: string;
  }>;
  createHandoff(context: TrustedTurnContext, input: {
    readonly summary: string;
    readonly unresolvedItems: readonly string[];
    readonly unknownOperationRefs: readonly string[];
    readonly sourceRefs: readonly ConversationSourceRef[];
  }): Promise<ConversationHandoff>;
  getPolicy(context: TrustedTurnContext): Promise<ActiveBehaviorPolicy | null>;
  putPolicy(context: TrustedTurnContext, input: {
    readonly enabled: boolean;
    readonly quietHours: ActiveBehaviorPolicy['quietHours'];
    readonly cooldownSeconds: number;
    readonly allowGroupInterjections: boolean;
    readonly followupEnabled: boolean;
    readonly expectedVersion?: number;
  }): Promise<ActiveBehaviorPolicy>;
}

/** Product behavior over Work records and existing DSH Schedule/Executor services. */
export function createNousActiveFeature(options: NousActiveOptions): NousActiveFeature {
  if (options.api?.apiVersion !== 1) throw new ConversationFeatureError('MEMORY_API_UNAVAILABLE', 'Conversation Work API v1 is required');
  const enabled = options.enabled ?? true;
  const now = options.now ?? Date.now;

  const feature: NousActiveFeature = {
    apiVersion: 1 as const,

    async beforeContext(context) {
      recordConversationContextSourcesV1(context, NOUS_FEATURE_ID, []);
      context.signal.throwIfAborted();
      if (!enabled) return { contributions: [] };
      const [open, waiting, handoffs] = await Promise.all([
        options.api.listFocusItems(context, { state: 'open', conversationId: context.conversationId, limit: MAX_ACTIVE_FOCUS_ITEMS }),
        options.api.listFocusItems(context, { state: 'waiting', conversationId: context.conversationId, limit: MAX_ACTIVE_FOCUS_ITEMS }),
        options.api.listHandoffs(context, { limit: MAX_HANDOFFS }),
      ]);
      const contributions: ContextContribution[] = [];
      const trustedSources: ConversationSourceRef[] = [];
      let characters = 0;
      const entries = [
        ...open.items,
        ...waiting.items,
        ...handoffs.items.filter(handoff => handoff.conversationId === context.conversationId),
      ];
      const seen = new Set<string>();
      for (const entry of entries) {
        context.signal.throwIfAborted();
        const id = 'id' in entry ? entry.id : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const refs = validateSourceRefs(entry.sourceRefs);
        if (refs.length === 0 || !matchesTrustedConversation(entry, context)) continue;
        const proof = await authorizeConversationSourcesV1(options.api, context, refs);
        if (proof.unavailable === true || !proof.allowed
          || proof.currentAuthorizationEpoch !== context.authorizationEpoch) continue;
        const text = 'unresolvedItems' in entry
          ? `[handoff] ${entry.summary}; unresolved: ${entry.unresolvedItems.slice(0, 8).join('; ')}`
          : `[${entry.kind}:${entry.state}] ${entry.summary}`;
        if (characters + text.length > MAX_NOUS_CONTEXT_CHARACTERS) break;
        contributions.push({ feature: NOUS_FEATURE_ID, content: text, sourceRefs: refs });
        trustedSources.push(...refs);
        characters += text.length;
      }
      recordConversationContextSourcesV1(context, NOUS_FEATURE_ID, trustedSources);
      return { contributions };
    },

    async beforeDelivery(context, input) {
      context.signal.throwIfAborted();
      if (!hasConversationContextProofV1(context, NOUS_FEATURE_ID, input.sourceRefs)) {
        return { decision: 'hold', code: 'SOURCE_PROOF_MISSING', authorizationEpoch: context.authorizationEpoch };
      }
      if (context.origin?.kind === 'conversation-followup') {
        const policy = await options.api.getActiveBehaviorPolicy(context);
        if (policy === null || !policy.enabled || !policy.followupEnabled
          || (context.conversationKind !== 'direct' && !policy.allowGroupInterjections)) {
          return { decision: 'hold', code: 'PROACTIVE_POLICY_BLOCKED', authorizationEpoch: context.authorizationEpoch };
        }
        if (isInQuietHours(policy.quietHours, now())) {
          return { decision: 'hold', code: 'PROACTIVE_QUIET_HOURS', authorizationEpoch: context.authorizationEpoch };
        }
        if (policy.cooldownSeconds > 0) {
          if (input.assistantEventId === undefined) {
            return { decision: 'hold', code: 'PROACTIVE_PROOF_MISSING', authorizationEpoch: context.authorizationEpoch };
          }
          const decision = await evaluatePolicy(options.api, context, policy, now(), input.assistantEventId);
          if (decision.deferUntil !== undefined && decision.deferUntil > now()) {
            return { decision: 'hold', code: 'PROACTIVE_COOLDOWN', authorizationEpoch: context.authorizationEpoch };
          }
        }
      }
      const proof = await authorizeConversationSourcesV1(options.api, context, input.sourceRefs);
      if (proof.unavailable === true) return { decision: 'hold', code: 'SOURCE_AUTHORIZATION_UNAVAILABLE', authorizationEpoch: context.authorizationEpoch };
      if (!proof.allowed) return { decision: 'hold', code: 'SOURCE_AUTHORIZATION_REVOKED', authorizationEpoch: proof.currentAuthorizationEpoch };
      if (proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
        return { decision: 'hold', code: 'SOURCE_AUTHORIZATION_EPOCH_CHANGED', authorizationEpoch: proof.currentAuthorizationEpoch };
      }
      return { decision: 'allow', authorizationEpoch: proof.currentAuthorizationEpoch };
    },

    async createFocusItem(context, input) {
      context.signal.throwIfAborted();
      ensureEnabled(enabled);
      assertNoFollowupLoop(context);
      const summary = checkedText(input.summary, MAX_FOCUS_SUMMARY, 'focus summary');
      const message = await findUserMessage(options.api, context, input.userEventId);
      const refs = rawSourceRefs([message.id]);
      await authorizeOrThrow(options.api, context, refs, 'FOCUS_SOURCE_REVOKED');
      if (input.dueAt !== undefined && (!Number.isSafeInteger(input.dueAt) || input.dueAt <= now())) {
        throw new ConversationDomainApiError('FOCUS_DUE_TIME_INVALID', 422, false, 'Focus due time must be in the future');
      }
      const result = await options.api.createFocusItem(context, {
        idempotencyKey: operationKey('focus', context.conversationId, message.id, input.kind, summary),
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        personaId: context.personaId,
        kind: input.kind,
        summary,
        sourceRefs: refs,
        ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
        ...(input.condition === undefined ? {} : { condition: checkedText(input.condition, 2_000, 'focus condition') }),
      });
      if (result.item.dueAt !== null && result.item.dueAt !== undefined) {
        await feature.scheduleFollowup(context, result.item.id, result.item.dueAt);
      }
      return result.item;
    },

    async transitionFocusItem(context, focusItemId, input) {
      context.signal.throwIfAborted();
      const { item } = await findFocusItem(options.api, context, focusItemId);
      if (item.version !== input.expectedVersion) throw new ConversationDomainApiError('FOCUS_VERSION_CONFLICT', 409, false, 'Focus item version changed');
      const refs = validateSourceRefs(item.sourceRefs);
      await authorizeOrThrow(options.api, context, refs, 'FOCUS_SOURCE_REVOKED');
      const result = await options.api.transitionFocusItem(context, focusItemId, input);
      if (input.state === 'done' || input.state === 'cancelled') {
        const scheduleEntriesRemoved = await options.scheduler.cancel(conversationScheduleMarker('followup', item.id), context.signal);
        const taskId = followupTaskId(context, item);
        await options.tasks.cancel(context, taskId, context.signal);
        void scheduleEntriesRemoved;
      }
      return result.item;
    },

    async scheduleFollowup(context, focusItemId, dueAt) {
      context.signal.throwIfAborted();
      ensureEnabled(enabled);
      assertNoFollowupLoop(context);
      const { item } = await findFocusItem(options.api, context, focusItemId);
      if (item.state !== 'open' && item.state !== 'waiting') return { status: 'held' };
      const refs = validateSourceRefs(item.sourceRefs);
      const proof = await authorizeConversationSourcesV1(options.api, context, refs);
      if (proof.unavailable === true || !proof.allowed || proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
        return { status: 'held' };
      }
      const policy = await options.api.getActiveBehaviorPolicy(context);
      const decision = await evaluatePolicy(options.api, context, policy, now());
      if (decision.status === 'disabled' || decision.status === 'held') return decision;
      const requestedAt = dueAt ?? item.dueAt ?? now() + 1_000;
      if (!Number.isSafeInteger(requestedAt) || requestedAt <= now()) {
        throw new ConversationDomainApiError('FOLLOWUP_TIME_INVALID', 422, false, 'Follow-up time must be in the future');
      }
      const actualAt = Math.max(requestedAt, decision.deferUntil ?? requestedAt);
      const receipt = await options.scheduler.ensureOneShot(
        conversationScheduleMarker('followup', item.id), actualAt,
        { signal: context.signal },
      );
      return {
        status: actualAt > requestedAt ? 'deferred' : 'scheduled',
        dueAt: actualAt,
        scheduleId: receipt.record.id,
      };
    },

    async runScheduledFollowup(context, focusItemId) {
      context.signal.throwIfAborted();
      ensureEnabled(enabled);
      const { item } = await findFocusItem(options.api, context, focusItemId);
      if (item.state !== 'open' && item.state !== 'waiting') return { status: 'held' };
      const refs = validateSourceRefs(item.sourceRefs);
      const proof = await authorizeConversationSourcesV1(options.api, context, refs);
      if (proof.unavailable === true || !proof.allowed || proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
        await options.scheduler.cancel(conversationScheduleMarker('followup', item.id), context.signal);
        return { status: 'held' };
      }
      const policy = await options.api.getActiveBehaviorPolicy(context);
      const decision = await evaluatePolicy(options.api, context, policy, now());
      if (decision.status === 'disabled' || decision.status === 'held') {
        await options.scheduler.cancel(conversationScheduleMarker('followup', item.id), context.signal);
        return decision;
      }
      if (decision.deferUntil !== undefined && decision.deferUntil > now()) {
        await options.scheduler.ensureOneShot(
          conversationScheduleMarker('followup', item.id), decision.deferUntil,
          { signal: context.signal },
        );
        return { status: 'deferred', dueAt: decision.deferUntil };
      }
      assertNoFollowupLoop(context);
      const taskId = followupTaskId(context, item);
      const origin = {
        kind: 'conversation-followup',
        sourceId: item.id,
        externalEventId: followupEventId(item),
      };
      const outcome = await options.tasks.dispatch(context, {
        taskId,
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        personaId: context.personaId,
        visibility: context.visibility,
        idempotencyKey: operationKey('followup', item.id, String(item.version)),
        prompt: `Send a concise, source-grounded follow-up about this open item: ${item.summary}`,
        origin,
        sourceRefs: refs,
        executionClass: 'background',
      }, context.signal);
      if (outcome.taskId !== taskId) {
        throw new ConversationDomainApiError('FOLLOWUP_TASK_ID_MISMATCH', 502, false, 'Follow-up executor returned another task identity');
      }
      if (outcome.status === 'completed' && outcome.deliveryStatus === 'delivered') {
        const latest = await findFocusItem(options.api, context, item.id);
        if (latest.item.version === item.version && latest.item.state === 'open') {
          await options.api.transitionFocusItem(context, item.id, { state: 'waiting', expectedVersion: item.version });
        }
        await options.scheduler.cancel(conversationScheduleMarker('followup', item.id), context.signal);
        return { status: 'dispatched', taskOutcome: outcome };
      }
      return { status: outcome.deliveryStatus === 'held' ? 'held' : 'dispatched', taskOutcome: outcome };
    },

    async retractFollowup(context, focusItemId, version) {
      context.signal.throwIfAborted();
      const { item } = await findFocusItem(options.api, context, focusItemId);
      if (item.version !== version) throw new ConversationDomainApiError('FOCUS_VERSION_CONFLICT', 409, false, 'Focus item version changed');
      const taskId = followupTaskId(context, item);
      const taskCancellationRequested = await options.tasks.cancel(context, taskId, context.signal);
      const scheduleEntriesRemoved = await options.scheduler.cancel(conversationScheduleMarker('followup', item.id), context.signal);
      const retraction = await options.tasks.retract(context, taskId, context.signal);
      if (retraction.status === 'retracted' || retraction.status === 'not-sent') {
        await options.api.transitionFocusItem(context, item.id, { state: 'cancelled', expectedVersion: item.version });
      }
      return {
        taskCancellationRequested,
        scheduleEntriesRemoved,
        retraction: retraction.status,
        ...(retraction.receiptId === undefined ? {} : { receiptId: retraction.receiptId }),
      };
    },

    async createHandoff(context, input) {
      context.signal.throwIfAborted();
      ensureEnabled(enabled);
      const summary = checkedText(input.summary, MAX_HANDOFF_SUMMARY, 'handoff summary');
      const unresolvedItems = checkedTextList(input.unresolvedItems, 64, 2_000);
      const unknownOperationRefs = checkedIdentifierList(input.unknownOperationRefs, 100);
      const refs = validateSourceRefs(input.sourceRefs);
      if (refs.length === 0) throw new ConversationDomainApiError('HANDOFF_SOURCE_REQUIRED', 422, false, 'Handoff needs explicit source references');
      await authorizeOrThrow(options.api, context, refs, 'HANDOFF_SOURCE_REVOKED');
      const result = await options.api.createHandoff(context, {
        idempotencyKey: operationKey('handoff', context.taskId, context.sessionId, summary),
        taskId: context.taskId,
        sessionId: context.sessionId,
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        personaId: context.personaId,
        summary,
        unresolvedItems,
        unknownOperationRefs,
        sourceRefs: refs,
      });
      return result.handoff;
    },

    async getPolicy(context) {
      return options.api.getActiveBehaviorPolicy(context);
    },

    async putPolicy(context, input) {
      context.signal.throwIfAborted();
      if (input.cooldownSeconds < 0 || input.cooldownSeconds > 7 * 24 * 60 * 60) {
        throw new ConversationDomainApiError('ACTIVE_BEHAVIOR_POLICY_INVALID', 422, false, 'Cooldown is outside the supported range');
      }
      validateQuietHours(input.quietHours);
      return options.api.putActiveBehaviorPolicy(context, {
        conversationId: context.conversationId,
        enabled: input.enabled,
        quietHours: input.quietHours,
        cooldownSeconds: input.cooldownSeconds,
        allowGroupInterjections: input.allowGroupInterjections,
        followupEnabled: input.followupEnabled,
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      });
    },
  };
  return Object.freeze(feature);
}

async function evaluatePolicy(
  api: ConversationDomainApiV1,
  context: TrustedTurnContext,
  policy: ActiveBehaviorPolicy | null,
  now: number,
  excludeAssistantEventId?: string,
): Promise<{ readonly status: 'disabled' | 'held' | 'deferred'; readonly deferUntil?: number }> {
  if (policy === null || !policy.enabled || !policy.followupEnabled) return { status: 'disabled' };
  if (policy.conversationId !== context.conversationId
    || (context.conversationKind !== 'direct' && !policy.allowGroupInterjections)) return { status: 'held' };
  validateQuietHours(policy.quietHours);
  let deferUntil: number | undefined;
  if (isInQuietHours(policy.quietHours, now)) deferUntil = nextQuietEnd(policy.quietHours, now);
  if (policy.cooldownSeconds > 0) {
    const page = await api.listMessages(context, {
      conversationId: context.conversationId,
      conversationKind: context.conversationKind,
      order: 'desc',
      limit: 100,
    });
    const latestAssistant = page.items.find(message => message.role === 'assistant'
      && message.eventId !== excludeAssistantEventId
      && message.status === 'active'
      && message.scope.conversationId === context.conversationId
      && message.scope.conversationKind === context.conversationKind
      && message.scope.personaId === context.personaId
      && message.scope.visibility === context.visibility);
    if (latestAssistant !== undefined) {
      const cooldownEnd = latestAssistant.occurredAt + policy.cooldownSeconds * 1_000;
      if (cooldownEnd > now) deferUntil = Math.max(deferUntil ?? 0, cooldownEnd);
    }
  }
  return deferUntil === undefined ? { status: 'deferred' } : { status: 'deferred', deferUntil };
}

async function findFocusItem(api: ConversationDomainApiV1, context: TrustedTurnContext, id: string): Promise<{ readonly item: FocusItem }> {
  const result = await api.listFocusItems(context, { conversationId: context.conversationId, limit: 500 });
  const item = result.items.find(candidate => candidate.id === id && candidate.conversationId === context.conversationId
    && candidate.conversationKind === context.conversationKind && candidate.personaId === context.personaId);
  if (item === undefined) throw new ConversationDomainApiError('FOCUS_ITEM_NOT_FOUND', 404, false, 'Focus item was not found in this trusted scope');
  return { item };
}

async function findUserMessage(api: ConversationDomainApiV1, context: TrustedTurnContext, eventId: string) {
  const page = await api.listMessages(context, {
    conversationId: context.conversationId,
    conversationKind: context.conversationKind,
    order: 'desc',
    limit: 100,
  });
  const message = page.items.find(item => item.eventId === eventId && item.role === 'user' && item.status === 'active'
    && item.scope.conversationId === context.conversationId
    && item.scope.conversationKind === context.conversationKind
    && item.scope.personaId === context.personaId
    && item.scope.visibility === context.visibility);
  if (message === undefined) throw new ConversationDomainApiError('FOCUS_MESSAGE_NOT_FOUND', 404, false, 'Focus request message was not found');
  return message;
}

async function authorizeOrThrow(
  api: ConversationDomainApiV1,
  context: TrustedTurnContext,
  refs: readonly ConversationSourceRef[],
  code: string,
): Promise<void> {
  const proof = await authorizeConversationSourcesV1(api, context, refs);
  if (proof.unavailable === true || !proof.allowed || proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
    throw new ConversationDomainApiError(code, 409, false, 'Conversation source is no longer authorized');
  }
}

function followupTaskId(context: TrustedTurnContext, item: FocusItem): string {
  return conversationWorkTaskId('followup', `${context.workspaceId}:${context.actorId}:${item.id}:v${item.version}`);
}

function followupEventId(item: FocusItem): string {
  return `followup-${createHash('sha256').update(`${item.id}\0${item.version}`).digest('hex').slice(0, 32)}`;
}

function operationKey(...values: readonly string[]): string {
  return `nous-${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
}

function rawSourceRefs(ids: readonly string[]): ConversationSourceRef[] {
  const unique = [...new Set(ids)];
  const refs: ConversationSourceRef[] = [];
  for (let offset = 0; offset < unique.length; offset += 128) {
    refs.push({ memoryId: null, memoryVersion: null, sourceMessageIds: unique.slice(offset, offset + 128) });
  }
  return refs;
}

function validateSourceRefs(values: readonly ConversationSourceRef[]): ConversationSourceRef[] {
  if (!Array.isArray(values) || values.length > 256) throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Nous source references exceed their limit');
  const totalIds = values.reduce((total, ref) => total + (Array.isArray(ref.sourceMessageIds) ? ref.sourceMessageIds.length : 0), 0);
  if (totalIds > 32_768 || values.some(ref => {
    const memoryValid = ref.memoryId === null
      ? ref.memoryVersion === null
      : isIdentifier(ref.memoryId) && Number.isSafeInteger(ref.memoryVersion) && (ref.memoryVersion ?? 0) >= 1;
    return !memoryValid || !Array.isArray(ref.sourceMessageIds) || ref.sourceMessageIds.length === 0
      || ref.sourceMessageIds.length > 128 || ref.sourceMessageIds.some((id: unknown) => !isIdentifier(id));
  })) throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Nous source references are malformed');
  return values.map(ref => ({
    memoryId: ref.memoryId,
    memoryVersion: ref.memoryVersion,
    sourceMessageIds: [...ref.sourceMessageIds],
  }));
}

function matchesTrustedConversation(
  entry: FocusItem | ConversationHandoff,
  context: TrustedTurnContext,
): boolean {
  return entry.conversationId === context.conversationId
    && entry.conversationKind === context.conversationKind
    && entry.personaId === context.personaId;
}

function assertNoFollowupLoop(context: TrustedTurnContext): void {
  if (context.origin?.kind === 'conversation-followup') {
    throw new ConversationDomainApiError('FOLLOWUP_LOOP_BLOCKED', 409, false, 'A follow-up task cannot create or schedule another follow-up');
  }
}

function ensureEnabled(enabled: boolean): void {
  if (!enabled) throw new ConversationDomainApiError('NOUS_ACTIVE_DISABLED', 409, false, 'Nous active behavior is disabled');
}

function checkedText(value: string, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new ConversationDomainApiError('NOUS_TEXT_INVALID', 422, false, `${label} is invalid`);
  }
  return value.trim();
}

function checkedTextList(values: readonly string[], maximum: number, itemMaximum: number): string[] {
  if (!Array.isArray(values) || values.length > maximum) throw new ConversationDomainApiError('HANDOFF_LIST_INVALID', 422, false, 'Handoff item list is too large');
  return values.map(value => checkedText(value, itemMaximum, 'handoff item'));
}

function checkedIdentifierList(values: readonly string[], maximum: number): string[] {
  if (!Array.isArray(values) || values.length > maximum || values.some(value => !isIdentifier(value))) {
    throw new ConversationDomainApiError('HANDOFF_OPERATION_REF_INVALID', 422, false, 'Handoff operation reference list is invalid');
  }
  return [...new Set(values)];
}

function validateQuietHours(value: ActiveBehaviorPolicy['quietHours']): void {
  if (typeof value.timeZone !== 'string' || !value.timeZone || !isClock(value.start) || !isClock(value.end)) {
    throw new ConversationDomainApiError('ACTIVE_BEHAVIOR_POLICY_INVALID', 422, false, 'Quiet hours are invalid');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }).format(new Date(0));
  } catch {
    throw new ConversationDomainApiError('ACTIVE_BEHAVIOR_POLICY_INVALID', 422, false, 'Quiet hour time zone is invalid');
  }
}

function isInQuietHours(value: ActiveBehaviorPolicy['quietHours'], timestamp: number): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: value.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? '0');
  const current = hour * 60 + minute;
  const start = clockMinutes(value.start);
  const end = clockMinutes(value.end);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function nextQuietEnd(value: ActiveBehaviorPolicy['quietHours'], timestamp: number): number {
  const deadline = timestamp + 36 * 60 * 60_000;
  for (let candidate = Math.floor(timestamp / 60_000) * 60_000 + 60_000; candidate <= deadline; candidate += 60_000) {
    if (!isInQuietHours(value, candidate)) return candidate;
  }
  throw new ConversationDomainApiError('QUIET_HOURS_UNRESOLVABLE', 422, false, 'Quiet hour window has no next allowed time');
}

function isClock(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour! * 60 + minute!;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_048
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
