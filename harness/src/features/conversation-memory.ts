// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator conversation memory feature                       │
// │ Role: Scope retrieval, archive completed turns, and recheck sources. │
// │ 模块职责：隔离检索、归档已完成回合并在发送前复验来源授权。              │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';

export type ConversationKind = 'direct' | 'group' | 'channel';
export type ConversationVisibility = 'private' | 'conversation' | 'workspace';
export type ConversationRole = 'user' | 'assistant' | 'tool';
export type ConversationMemoryKind = 'fact' | 'preference' | 'commitment' | 'episode';
export type ConversationFeatureId = 'conversation-memory.v1' | 'persona-profile.v1'
  | 'knowledge-graph-dream.v1' | 'research-work.v1' | 'nous-active.v1';

/** Server-derived scope attached to every turn and returned resource. */
export interface ConversationScope {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly conversationId: string;
  readonly conversationKind: ConversationKind;
  readonly personaId: string | null;
  readonly visibility: ConversationVisibility;
  readonly authorizationEpoch: number;
}

/** Trust-bearing context supplied by the Navigator Host, never by model output. */
export interface TrustedTurnContext extends ConversationScope {
  readonly taskId: string;
  readonly sessionId: string;
  readonly origin?: {
    readonly kind: string;
    readonly sourceId: string;
    readonly externalEventId: string;
  };
  readonly signal: AbortSignal;
}

/** Public resource scope; actor and workspace remain in the authenticated host context. */
export interface ConversationResourceScope {
  readonly conversationId: string;
  readonly conversationKind: ConversationKind;
  readonly personaId: string | null;
  readonly visibility: ConversationVisibility;
}

/** A persisted message and the scope the Work API applied to it. */
export interface ConversationMessage {
  readonly id: string;
  readonly eventId: string;
  readonly role: ConversationRole;
  readonly content: string;
  readonly occurredAt: number;
  readonly status: 'active' | 'revoked';
  readonly sourceRefs?: readonly ConversationSourceRef[];
  readonly scope: ConversationResourceScope;
}

/** A durable memory returned by the authenticated conversation-memory API. */
export interface ConversationMemory {
  readonly id?: string;
  readonly memoryId?: string;
  readonly version: number;
  readonly kind: ConversationMemoryKind;
  readonly text: string;
  readonly sourceMessageIds: readonly string[];
  readonly sourceRefs?: readonly ConversationSourceRef[];
  readonly scope: ConversationResourceScope;
  readonly authorizationEpoch?: number;
  readonly state?: 'active' | 'invalidated' | 'deleted';
  readonly score?: number;
  readonly stale?: boolean;
}

/** Page shape returned by scoped Work API reads. */
export interface ConversationPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Exact versioned link to parent memory or raw source messages. */
export interface ConversationSourceRef {
  readonly memoryId: string | null;
  readonly memoryVersion: number | null;
  readonly sourceMessageIds: readonly string[];
}

/** Current authorization outcome with an explicit transport-unavailable marker. */
export interface ConversationSourceAuthorizationResult {
  readonly allowed: boolean;
  readonly currentAuthorizationEpoch: number;
  readonly deniedSourceIds: readonly string[];
  readonly unavailable?: boolean;
}

/** Context added to model input with the proof the host retains for delivery. */
export interface ContextContribution {
  readonly feature: ConversationFeatureId;
  readonly content: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
}

/** Authenticated, versioned HTTP adapter implemented by Navigator Host. */
export interface ConversationMemoryApiV1 {
  readonly apiVersion: 1;
  createMessage(
    context: TrustedTurnContext,
    input: {
      readonly eventId: string;
      readonly conversationId: string;
      readonly conversationKind: ConversationKind;
      readonly personaId: string | null;
      readonly visibility: ConversationVisibility;
      readonly role: ConversationRole;
      readonly content: string;
      readonly occurredAt?: number;
      readonly sourceRefs?: readonly ConversationSourceRef[];
      readonly relatedEventIds?: readonly string[];
    },
  ): Promise<{ readonly message: ConversationMessage; readonly duplicate: boolean }>;
  listMessages(
    context: TrustedTurnContext,
    input: {
      readonly conversationId: string;
      readonly conversationKind: ConversationKind;
      readonly order: 'desc';
      readonly cursor?: string;
      readonly limit: number;
      readonly includeRevoked?: boolean;
    },
  ): Promise<ConversationPage<ConversationMessage>>;
  listMemories(
    context: TrustedTurnContext,
    input: {
      readonly conversationId: string;
      readonly conversationKind: ConversationKind;
      readonly personaId: string | null;
      readonly state: 'active';
      readonly limit: number;
    },
  ): Promise<{ readonly items: readonly ConversationMemory[]; readonly authorizationEpoch: number }>;
  queryMemories(
    context: TrustedTurnContext,
    input: {
      readonly conversationId: string;
      readonly conversationKind: ConversationKind;
      readonly personaId: string | null;
      readonly query: string;
      readonly limit: number;
    },
  ): Promise<{ readonly items: readonly ConversationMemory[]; readonly authorizationEpoch: number }>;
  createMemory(
    context: TrustedTurnContext,
    input: {
      readonly idempotencyKey: string;
      readonly conversationId: string;
      readonly conversationKind: ConversationKind;
      readonly personaId: string | null;
      readonly kind: ConversationMemoryKind;
      readonly text: string;
      readonly sourceMessageIds: readonly string[];
      readonly sourceRefs: readonly ConversationSourceRef[];
      readonly visibility: ConversationVisibility;
      readonly validUntil?: number;
    },
  ): Promise<{ readonly memory: ConversationMemory; readonly duplicate: boolean }>;
  authorizeSources(
    context: TrustedTurnContext,
    input: {
      readonly conversationId: string;
      readonly conversationKind: ConversationKind;
      readonly authorizationEpoch: number;
      readonly personaId: string | null;
      readonly sourceRefs: readonly ConversationSourceRef[];
    },
  ): Promise<{
    readonly allowed: boolean;
    readonly currentAuthorizationEpoch: number;
    readonly deniedSourceIds: readonly string[];
  }>;
}

/** Real model-backed summary adapter; construction fails when it is not configured. */
export interface ConversationSummaryProviderV1 {
  readonly apiVersion: 1;
  summarize(input: {
    readonly scope: ConversationScope;
    readonly messages: readonly Pick<ConversationMessage, 'id' | 'role' | 'content' | 'occurredAt'>[];
    readonly signal: AbortSignal;
  }): Promise<string>;
}

export interface ConversationMemoryFeatureOptions {
  readonly api: ConversationMemoryApiV1;
  readonly summaryProvider?: ConversationSummaryProviderV1;
  /** Disabled modules stop writes and context contribution while source checks remain active. */
  readonly enabled?: boolean;
  readonly minimumMessages?: number;
  readonly minimumCharacters?: number;
  readonly historyLimit?: number;
  readonly retrievalLimit?: number;
  readonly contributionCharacterLimit?: number;
}

/** Search text and optional contribution cap for one turn. */
export interface ConversationContextInput {
  readonly query: string;
  readonly maximumContributions?: number;
}

/** Completed model output with host-tracked evidence references. */
export interface ConversationAfterTurnInput {
  readonly userEventId: string;
  readonly assistantText: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  /** Complete source references tracked by the host from the actual DSH context. */
  readonly sourceRefs: readonly ConversationSourceRef[];
}

/** Candidate outgoing text and all host-retained source references. */
export interface ConversationDeliveryInput {
  readonly text: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
}

/** Fail-closed result consumed before the host performs connector delivery. */
export interface ConversationDeliveryDecision {
  readonly decision: 'allow' | 'hold';
  readonly code?: 'SOURCE_AUTHORIZATION_REVOKED' | 'SOURCE_AUTHORIZATION_EPOCH_CHANGED'
    | 'SOURCE_AUTHORIZATION_UNAVAILABLE' | 'SOURCE_PROOF_MISSING';
  readonly authorizationEpoch: number;
}

/** Typed feature error separating provider and provenance failures. */
export class ConversationFeatureError extends Error {
  readonly code: 'INVALID_SCOPE' | 'INVALID_SOURCE_PROOF' | 'MODEL_UNAVAILABLE' | 'MEMORY_API_UNAVAILABLE';

  constructor(code: 'INVALID_SCOPE' | 'INVALID_SOURCE_PROOF' | 'MODEL_UNAVAILABLE' | 'MEMORY_API_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'ConversationFeatureError';
    this.code = code;
  }
}

/** Optional DSH lifecycle hooks; authority and delivery remain in the Host. */
export interface ConversationMemoryFeature {
  readonly apiVersion: 1;
  beforeContext(context: TrustedTurnContext, input: ConversationContextInput): Promise<{
    readonly contributions: readonly ContextContribution[];
  }>;
  afterTurn(context: TrustedTurnContext, input: ConversationAfterTurnInput): Promise<void>;
  beforeDelivery(context: TrustedTurnContext, input: ConversationDeliveryInput): Promise<ConversationDeliveryDecision>;
}

const DEFAULT_MINIMUM_MESSAGES = 8;
const DEFAULT_MINIMUM_CHARACTERS = 3_200;
const DEFAULT_HISTORY_LIMIT = 96;
const DEFAULT_HISTORY_SCAN_PAGES = 8;
const DEFAULT_MEMORY_LIST_LIMIT = 500;
const DEFAULT_RETRIEVAL_LIMIT = 8;
const DEFAULT_CONTRIBUTION_CHARACTER_LIMIT = 8_000;
const MAX_MESSAGE_LENGTH = 32_000;
const MAX_MEMORY_LENGTH = 8_000;
const MAX_SOURCE_IDS_PER_REF = 128;
const MAX_TOTAL_SOURCE_IDS = 32_768;
const MAX_SOURCE_REFS = 256;
const MAX_SUMMARY_SOURCE_INPUTS = 25_600;
const pendingSourcesByTurn = new Map<string, Map<string, readonly ConversationSourceRef[]>>();
const abortCleanupKeysBySignal = new WeakMap<AbortSignal, Set<string>>();
const CONVERSATION_MEMORY_FEATURE_ID = 'conversation-memory.v1';

/**
 * Create the optional P2 consumer hooks over the authenticated Navigator Work API.
 * The module never owns storage or delivery; all writes are scoped and idempotent.
 */
export function createConversationMemoryFeature(options: ConversationMemoryFeatureOptions): ConversationMemoryFeature {
  if (options.api?.apiVersion !== 1) {
    throw new ConversationFeatureError('MEMORY_API_UNAVAILABLE', 'Conversation Work API v1 is required');
  }
  const enabled = options.enabled ?? true;
  const summaryProvider = options.summaryProvider;
  if (enabled && (summaryProvider?.apiVersion !== 1 || typeof summaryProvider.summarize !== 'function')) {
    throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'A configured summary provider v1 is required');
  }

  const historyLimit = boundedInteger(options.historyLimit ?? DEFAULT_HISTORY_LIMIT, 8, 100);
  const minimumMessages = boundedInteger(options.minimumMessages ?? DEFAULT_MINIMUM_MESSAGES, 2, 100);
  const maximumHistoryScanPages = DEFAULT_HISTORY_SCAN_PAGES;
  const retrievalLimit = boundedInteger(options.retrievalLimit ?? DEFAULT_RETRIEVAL_LIMIT, 1, 32);
  const minimumCharacters = boundedInteger(options.minimumCharacters ?? DEFAULT_MINIMUM_CHARACTERS, 200, 100_000);
  const contributionCharacterLimit = boundedInteger(
    options.contributionCharacterLimit ?? DEFAULT_CONTRIBUTION_CHARACTER_LIMIT,
    256,
    32_000,
  );

  const feature: ConversationMemoryFeature = {
    apiVersion: 1 as const,

    async beforeContext(context, input) {
      assertTrustedScope(context);
      context.signal.throwIfAborted();
      rememberPendingSources(context, CONVERSATION_MEMORY_FEATURE_ID, []);
      if (!enabled) {
        return { contributions: [] };
      }
      if (typeof input.query !== 'string' || input.query.trim().length === 0) return { contributions: [] };
      const result = await options.api.queryMemories(context, {
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        personaId: context.personaId,
        query: input.query.slice(0, MAX_MESSAGE_LENGTH),
        limit: Math.min(retrievalLimit, boundedInteger(input.maximumContributions ?? retrievalLimit, 1, 32)),
      });
      if (result.authorizationEpoch !== context.authorizationEpoch) return { contributions: [] };

      const contributions: ContextContribution[] = [];
      let totalCharacters = 0;
      for (const memory of result.items) {
        context.signal.throwIfAborted();
        if (memory.stale === true || (memory.state !== undefined && memory.state !== 'active')
          || (memory.authorizationEpoch !== undefined && memory.authorizationEpoch > context.authorizationEpoch)
          || !matchesScope(memory, context)) continue;
        if (!isIdentifier(memory.memoryId)) continue;
        const text = boundedText(memory.text, MAX_MEMORY_LENGTH);
        let sourceMessageIds: string[];
        try {
          sourceMessageIds = stableUnique(memory.sourceMessageIds, MAX_TOTAL_SOURCE_IDS);
        } catch {
          continue;
        }
        if (!text || sourceMessageIds.length === 0) continue;
        const content = `[memory:${memory.memoryId}] ${text}`;
        if (totalCharacters + content.length > contributionCharacterLimit) break;
        contributions.push({
          feature: 'conversation-memory.v1',
          content,
          sourceRefs: splitSourceRefs(memory.memoryId, memory.version, sourceMessageIds),
        });
        totalCharacters += content.length;
      }
      const sourceRefs = normalizeSourceRefs(contributions.flatMap(item => item.sourceRefs));
      const proof = await authorizeConversationSourcesV1(options.api, context, sourceRefs);
      if (!proof.allowed || proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
        rememberPendingSources(context, CONVERSATION_MEMORY_FEATURE_ID, []);
        return { contributions: [] };
      }
      rememberPendingSources(context, CONVERSATION_MEMORY_FEATURE_ID, sourceRefs);
      return { contributions };
    },

    async afterTurn(context, input) {
      assertTrustedScope(context);
      const expectedSources = pendingSourcesByTurn.get(turnKey(context))?.get(CONVERSATION_MEMORY_FEATURE_ID);
      context.signal.throwIfAborted();
      if (!enabled || input.status !== 'completed') return;
      const assistantText = boundedText(input.assistantText, MAX_MESSAGE_LENGTH);
      const userEventId = boundedText(input.userEventId, 512);
      if (!assistantText || !userEventId) return;
      if (expectedSources === undefined || !isSourceRefsWellFormed(input.sourceRefs)
        || !containsAllSourceRefs(input.sourceRefs, expectedSources)) {
        throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Completed turn omitted a context source reference');
      }

      // The ingress event is already persisted; this deterministic event id makes host retries safe.
      await options.api.createMessage(context, {
        eventId: deterministicId('assistant-turn', context, [userEventId]),
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        personaId: context.personaId,
        visibility: context.visibility,
        role: 'assistant',
        content: assistantText,
        sourceRefs: normalizeSourceRefs(input.sourceRefs),
        relatedEventIds: [userEventId],
      });

      const activeMemories = await options.api.listMemories(context, {
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        personaId: context.personaId,
        state: 'active',
        limit: DEFAULT_MEMORY_LIST_LIMIT,
      });
      context.signal.throwIfAborted();

      const archivedIds = new Set<string>();
      for (const memory of activeMemories.items) {
        if (!matchesScope(memory, context) || memory.state !== 'active' || memory.kind !== 'episode') continue;
        for (const id of memory.sourceMessageIds) archivedIds.add(id);
      }
      if (activeMemories.authorizationEpoch !== context.authorizationEpoch) return;
      const scannedMessages: ConversationMessage[] = [];
      const scannedMessageIds = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let scannedPending = 0;
      for (let pageIndex = 0; pageIndex < maximumHistoryScanPages && scannedPending < historyLimit; pageIndex += 1) {
        context.signal.throwIfAborted();
        const page = await options.api.listMessages(context, {
          conversationId: context.conversationId,
          conversationKind: context.conversationKind,
          order: 'desc',
          ...(cursor === undefined ? {} : { cursor }),
          limit: 100,
        });
        if (page.items.length > 100) {
          throw new ConversationFeatureError('MEMORY_API_UNAVAILABLE', 'Conversation page exceeded its requested limit');
        }
        if (page.items.length === 0) break;
        const unseen = page.items.filter(message => !scannedMessageIds.has(message.id));
        for (const message of unseen) scannedMessageIds.add(message.id);
        scannedMessages.push(...unseen);
        scannedPending += unseen.filter(message => (message.role === 'user' || message.role === 'assistant')
          && message.status === 'active' && matchesScope(message, context) && !archivedIds.has(message.id)).length;
        if (page.nextCursor === null) break;
        if (seenCursors.has(page.nextCursor) || page.nextCursor === cursor) {
          throw new ConversationFeatureError('MEMORY_API_UNAVAILABLE', 'Conversation page cursor did not advance');
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      const pending = scannedMessages
        .filter(message => message.role === 'user' || message.role === 'assistant')
        .filter(message => message.status === 'active' && matchesScope(message, context) && !archivedIds.has(message.id))
        .sort(compareMessages)
        .slice(-historyLimit);
      const characterCount = pending.reduce((total, message) => total + message.content.length, 0);
      if (pending.length < minimumMessages || characterCount < minimumCharacters) return;

      for (const message of pending) {
        if (message.sourceRefs !== undefined && !isSourceRefsWellFormed(message.sourceRefs)) {
          throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Stored message source lineage is invalid');
        }
      }
      const inheritedSourceIds = pending.flatMap(message => (message.sourceRefs ?? []).flatMap(ref => ref.sourceMessageIds));
      const sourceMessageIds = stableUnique([...pending.map(message => message.id), ...inheritedSourceIds], MAX_TOTAL_SOURCE_IDS);
      if (sourceMessageIds.length < minimumMessages) return;
      const sourceRefs = normalizeSourceRefs([
        ...pending.flatMap(message => message.sourceRefs ?? []),
        ...splitSourceRefs(null, null, stableUnique(pending.map(message => message.id), MAX_TOTAL_SOURCE_IDS)),
      ], MAX_SUMMARY_SOURCE_INPUTS);
      const proof = await authorizeConversationSourcesV1(options.api, context, sourceRefs);
      if (!proof.allowed || proof.currentAuthorizationEpoch !== context.authorizationEpoch) return;
      context.signal.throwIfAborted();
      let summary: string;
      try {
        if (summaryProvider === undefined) {
          throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'A configured summary provider v1 is required');
        }
        summary = boundedText(await summaryProvider.summarize({
          scope: scopeOf(context),
          messages: pending.map(({ id, role, content, occurredAt }) => ({ id, role, content, occurredAt })),
          signal: context.signal,
        }), MAX_MEMORY_LENGTH);
      } catch (error: unknown) {
        if (context.signal.aborted) throw error;
        throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'Configured summary provider failed');
      }
      if (!summary) throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'Configured summary provider returned an empty summary');

      context.signal.throwIfAborted();
      await options.api.createMemory(context, {
        idempotencyKey: deterministicId('summary', context, sourceMessageIds),
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        personaId: context.personaId,
        kind: 'episode',
        text: summary,
        sourceMessageIds,
        sourceRefs,
        visibility: context.visibility,
      });
    },

    async beforeDelivery(context, input) {
      assertTrustedScope(context);
      context.signal.throwIfAborted();
      if (!isSourceRefsWellFormed(input.sourceRefs)) {
        return { decision: 'hold', code: 'SOURCE_PROOF_MISSING', authorizationEpoch: context.authorizationEpoch };
      }
      const sourceRefs = normalizeSourceRefs(input.sourceRefs);
      if (!hasConversationContextProofV1(context, CONVERSATION_MEMORY_FEATURE_ID, sourceRefs)) {
        return { decision: 'hold', code: 'SOURCE_PROOF_MISSING', authorizationEpoch: context.authorizationEpoch };
      }
      try {
        const proof = await options.api.authorizeSources(context, {
          conversationId: context.conversationId,
          conversationKind: context.conversationKind,
          authorizationEpoch: context.authorizationEpoch,
          personaId: context.personaId,
          sourceRefs,
        });
        if (!proof.allowed) {
          return { decision: 'hold', code: 'SOURCE_AUTHORIZATION_REVOKED', authorizationEpoch: proof.currentAuthorizationEpoch };
        }
        if (proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
          return { decision: 'hold', code: 'SOURCE_AUTHORIZATION_EPOCH_CHANGED', authorizationEpoch: proof.currentAuthorizationEpoch };
        }
        return { decision: 'allow', authorizationEpoch: proof.currentAuthorizationEpoch };
      } catch (error: unknown) {
        if (context.signal.aborted) throw error;
        return { decision: 'hold', code: 'SOURCE_AUTHORIZATION_UNAVAILABLE', authorizationEpoch: context.authorizationEpoch };
      }
    },
  };
  return Object.freeze(feature);
}

/** Recheck retrieval provenance before any memory text is added to a model context. */
/** Authorize exact versioned sources for other built-in conversation features. */
export async function authorizeConversationSourcesV1(
  api: ConversationMemoryApiV1,
  context: TrustedTurnContext,
  sourceRefs: readonly ConversationSourceRef[],
): Promise<ConversationSourceAuthorizationResult> {
  assertTrustedScope(context);
  context.signal.throwIfAborted();
  const normalizedSourceRefs = normalizeSourceRefs(sourceRefs);
  try {
    return await api.authorizeSources(context, {
      conversationId: context.conversationId,
      conversationKind: context.conversationKind,
      authorizationEpoch: context.authorizationEpoch,
      personaId: context.personaId,
      sourceRefs: normalizedSourceRefs,
    });
  } catch (error: unknown) {
    if (context.signal.aborted) throw error;
    return {
      allowed: false,
      currentAuthorizationEpoch: context.authorizationEpoch,
      deniedSourceIds: [],
      unavailable: true,
    };
  }
}

/** Reject untrusted or malformed context before it can influence a cross-conversation query. */
function assertTrustedScope(context: TrustedTurnContext): void {
  if (!isIdentifier(context.workspaceId)
    || !isIdentifier(context.actorId)
    || !isIdentifier(context.conversationId)
    || !isIdentifier(context.taskId)
    || !isIdentifier(context.sessionId)
    || !['direct', 'group', 'channel'].includes(context.conversationKind)
    || !['private', 'conversation', 'workspace'].includes(context.visibility)
    || (context.personaId !== null && !isIdentifier(context.personaId))
    || !Number.isSafeInteger(context.authorizationEpoch)
    || context.authorizationEpoch < 0) {
    throw new ConversationFeatureError('INVALID_SCOPE', 'Trusted turn scope is invalid');
  }
}

/** Require owner and persona matches; conversation-visible facts also match the exact thread. */
function matchesScope(resource: { readonly scope: ConversationResourceScope }, context: ConversationScope): boolean {
  const scope = resource.scope;
  // Actor and workspace are enforced by the authenticated Work API principal and route.
  if (scope.personaId !== context.personaId || scope.visibility !== context.visibility) return false;
  if (scope.visibility === 'conversation') {
    return scope.conversationKind === context.conversationKind && scope.conversationId === context.conversationId;
  }
  if (scope.visibility === 'private') {
    // User-private memories may cross direct chats for the same authenticated actor, never into a group.
    return scope.conversationKind === 'direct' && context.conversationKind === 'direct';
  }
  // Workspace sharing is authorized by the Work API token and may span conversation kinds.
  return true;
}

function scopeOf(context: ConversationScope): ConversationScope {
  return {
    workspaceId: context.workspaceId,
    actorId: context.actorId,
    conversationId: context.conversationId,
    conversationKind: context.conversationKind,
    personaId: context.personaId,
    visibility: context.visibility,
    authorizationEpoch: context.authorizationEpoch,
  };
}

function splitSourceRefs(
  memoryId: string | null,
  memoryVersion: number | null,
  sourceMessageIds: readonly string[],
): ConversationSourceRef[] {
  if ((memoryId === null) !== (memoryVersion === null)
    || (memoryId !== null && (!isIdentifier(memoryId) || !Number.isSafeInteger(memoryVersion) || (memoryVersion ?? 0) < 1))) {
    throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Memory source revision is invalid');
  }
  const uniqueIds = stableUnique(sourceMessageIds, MAX_TOTAL_SOURCE_IDS);
  const references: ConversationSourceRef[] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += MAX_SOURCE_IDS_PER_REF) {
    references.push({
      memoryId,
      memoryVersion,
      sourceMessageIds: uniqueIds.slice(offset, offset + MAX_SOURCE_IDS_PER_REF),
    });
  }
  return references;
}

function normalizeSourceRefs(
  sourceRefs: readonly ConversationSourceRef[],
  maximumInputRefs = MAX_SOURCE_REFS,
): ConversationSourceRef[] {
  if (!isSourceRefsWellFormed(sourceRefs, maximumInputRefs)) {
    throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Source reference list is invalid or exceeds its limit');
  }
  const byMemory = new Map<string, {
    readonly memoryId?: string;
    readonly memoryVersion: number | null;
    readonly ids: Set<string>;
  }>();
  const allSourceIds = new Set<string>();
  for (const ref of sourceRefs) {
    const key = ref.memoryId === null
      ? 'source:raw-messages'
      : `memory:${ref.memoryId}:v${ref.memoryVersion}`;
    const existing = byMemory.get(key);
    const ids = existing?.ids ?? new Set<string>();
    for (const id of ref.sourceMessageIds) {
      if (!isIdentifier(id)) throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Source reference contains an invalid message id');
      ids.add(id);
      allSourceIds.add(id);
    }
    if (ids.size > 0) {
      byMemory.set(key, {
        ...(ref.memoryId === null ? {} : { memoryId: ref.memoryId }),
        memoryVersion: ref.memoryVersion,
        ids,
      });
    }
  }
  if (allSourceIds.size > MAX_TOTAL_SOURCE_IDS) {
    throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Source lineage exceeds its message limit');
  }
  const normalized: ConversationSourceRef[] = [];
  for (const { memoryId, memoryVersion, ids } of byMemory.values()) {
    const sorted = [...ids].sort();
    for (let offset = 0; offset < sorted.length; offset += MAX_SOURCE_IDS_PER_REF) {
      normalized.push({
        memoryId: memoryId ?? null,
        memoryVersion,
        sourceMessageIds: sorted.slice(offset, offset + MAX_SOURCE_IDS_PER_REF),
      });
    }
  }
  if (normalized.length > MAX_SOURCE_REFS) {
    throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Source reference list exceeds its limit');
  }
  return normalized;
}

function isSourceRefsWellFormed(
  sourceRefs: readonly ConversationSourceRef[],
  maximumRefs = MAX_SOURCE_REFS,
): boolean {
  return Array.isArray(sourceRefs)
    && sourceRefs.length <= maximumRefs
    && sourceRefs.every(isSourceRefWellFormed);
}

function isSourceRefWellFormed(value: unknown): value is ConversationSourceRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as ConversationSourceRef;
  const memoryValid = ref.memoryId === null
    ? ref.memoryVersion === null
    : isIdentifier(ref.memoryId) && Number.isSafeInteger(ref.memoryVersion) && (ref.memoryVersion ?? 0) >= 1;
  return memoryValid
    && Array.isArray(ref.sourceMessageIds)
    && ref.sourceMessageIds.length > 0
    && ref.sourceMessageIds.length <= MAX_SOURCE_IDS_PER_REF
    && ref.sourceMessageIds.every(isIdentifier);
}

function containsAllSourceRefs(actual: readonly ConversationSourceRef[], expected: readonly ConversationSourceRef[]): boolean {
  return expected.every(ref => {
    const matching = actual.filter(candidate => candidate.memoryId === ref.memoryId
      && candidate.memoryVersion === ref.memoryVersion);
    const actualIds = new Set(matching.flatMap(candidate => candidate.sourceMessageIds));
    return matching.length > 0 && ref.sourceMessageIds.every(id => actualIds.has(id));
  });
}

/** Record one built-in feature's exact context references for the later delivery gate. */
export function recordConversationContextSourcesV1(
  context: TrustedTurnContext,
  featureId: string,
  sourceRefs: readonly ConversationSourceRef[],
): void {
  assertTrustedScope(context);
  if (!/^[a-z][a-z0-9.-]{0,63}$/u.test(featureId) || !isSourceRefsWellFormed(sourceRefs)) {
    throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Conversation feature proof is invalid');
  }
  rememberPendingSources(context, featureId, sourceRefs);
}

/** Require the host's actual delivery references to include one feature's complete contribution. */
export function hasConversationContextProofV1(
  context: TrustedTurnContext,
  featureId: string,
  sourceRefs: readonly ConversationSourceRef[],
): boolean {
  if (!isSourceRefsWellFormed(sourceRefs)) return false;
  const expected = pendingSourcesByTurn.get(turnKey(context))?.get(featureId);
  return expected !== undefined && containsAllSourceRefs(sourceRefs, expected);
}

function rememberPendingSources(
  context: TrustedTurnContext,
  featureId: string,
  sourceRefs: readonly ConversationSourceRef[],
): void {
  const key = turnKey(context);
  const normalized = normalizeSourceRefs(sourceRefs);
  const featureProofs = pendingSourcesByTurn.get(key) ?? new Map<string, readonly ConversationSourceRef[]>();
  featureProofs.set(featureId, normalized);
  pendingSourcesByTurn.delete(key);
  pendingSourcesByTurn.set(key, featureProofs);
  while (pendingSourcesByTurn.size > 2_048) {
    const oldest = pendingSourcesByTurn.keys().next().value;
    if (oldest === undefined) break;
    pendingSourcesByTurn.delete(oldest);
  }
  let keys = abortCleanupKeysBySignal.get(context.signal);
  if (keys === undefined) {
    keys = new Set<string>();
    abortCleanupKeysBySignal.set(context.signal, keys);
    context.signal.addEventListener('abort', () => {
      for (const pendingKey of keys ?? []) pendingSourcesByTurn.delete(pendingKey);
      keys?.clear();
    }, { once: true });
  }
  keys.add(key);
  while (keys.size > 2_048) {
    const oldest = keys.values().next().value;
    if (oldest === undefined) break;
    keys.delete(oldest);
  }
}

function turnKey(context: TrustedTurnContext): string {
  return `${context.workspaceId}\u0000${context.actorId}\u0000${context.conversationId}\u0000${context.taskId}\u0000${context.sessionId}`;
}

function stableUnique(values: readonly string[], maximum: number): string[] {
  if (!Array.isArray(values)) {
    throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Source message ids are invalid');
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isIdentifier(value)) throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Source message id is invalid');
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length > maximum) {
      throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Derived source lineage exceeds its limit');
    }
  }
  return result;
}

function deterministicId(prefix: string, context: ConversationScope, sourceIds: readonly string[]): string {
  const digest = createHash('sha256').update(JSON.stringify({
    workspaceId: context.workspaceId,
    actorId: context.actorId,
    conversationId: context.conversationId,
    personaId: context.personaId,
    sourceIds: [...sourceIds].sort(),
  })).digest('hex');
  return `${prefix}-${digest}`;
}

function compareMessages(left: ConversationMessage, right: ConversationMessage): number {
  return left.occurredAt - right.occurredAt || left.id.localeCompare(right.id);
}

function boundedText(value: string, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError('Feature limit must be a safe integer');
  return Math.min(maximum, Math.max(minimum, value));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}
