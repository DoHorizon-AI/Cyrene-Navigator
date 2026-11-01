// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator persona and profile feature                       │
// │ Role: Add selected persona context and propose evidence-backed profiles.│
// │ 模块职责：装配人格上下文并提出带证据的用户/群体画像候选。               │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';
import {
  authorizeConversationSourcesV1,
  hasConversationContextProofV1,
  recordConversationContextSourcesV1,
} from './conversation-memory.ts';
import type {
  ConversationAfterTurnInput,
  ConversationContextInput,
  ConversationDeliveryDecision,
  ConversationDeliveryInput,
  ContextContribution,
  ConversationSourceRef,
  TrustedTurnContext,
} from './conversation-memory.ts';
import type {
  ConversationDomainApiV1,
  ConversationPersona,
  ConversationProfile,
  ProfileCandidate,
  ProfileCategory,
  ProfileExtractionProviderV1,
} from './conversation-domain-api.ts';
import { ConversationFeatureError as FeatureError } from './conversation-memory.ts';

const PROFILE_FEATURE_ID = 'persona-profile.v1';
const MAX_ACTIVE_PROFILES = 100;
const MAX_PROFILE_CONTEXT_ITEMS = 16;
const MAX_PROFILE_CONTEXT_CHARACTERS = 4_000;
const MAX_CANDIDATES_PER_TURN = 8;
const MAX_SOURCE_IDS_PER_REF = 128;

/** Optional module configuration; disabling preserves Work API data and source checks. */
export interface PersonaProfileFeatureOptions {
  readonly api: ConversationDomainApiV1;
  readonly extractor?: ProfileExtractionProviderV1;
  readonly enabled?: boolean;
  readonly now?: () => number;
}

/** Current persona plus safe user/group profile contributions for one DSH context. */
export interface PersonaProfileContext {
  readonly persona: ConversationPersona | null;
  readonly contributions: readonly ContextContribution[];
}

/** User-facing feature hooks and explicit review operations. */
export interface PersonaProfileFeature {
  readonly apiVersion: 1;
  beforeContext(context: TrustedTurnContext, input: ConversationContextInput): Promise<PersonaProfileContext>;
  afterTurn(context: TrustedTurnContext, input: ConversationAfterTurnInput): Promise<readonly ProfileCandidate[]>;
  beforeDelivery(context: TrustedTurnContext, input: ConversationDeliveryInput): Promise<ConversationDeliveryDecision>;
  putPersona(context: TrustedTurnContext, persona: Parameters<ConversationDomainApiV1['putPersona']>[1]): Promise<ConversationPersona>;
  activateCandidate(context: TrustedTurnContext, candidateId: string, expectedVersion: number): Promise<ConversationProfile>;
  rollbackProfile(context: TrustedTurnContext, profileId: string, expectedVersion: number): Promise<ConversationProfile>;
}

/**
 * Build the optional P3 persona/profile consumer. Extracted profiles remain candidates
 * until an explicit Work API activation; they are never applied automatically.
 */
export function createPersonaProfileFeature(options: PersonaProfileFeatureOptions): PersonaProfileFeature {
  if (options.api?.apiVersion !== 1) {
    throw new FeatureError('MEMORY_API_UNAVAILABLE', 'Conversation Work API v1 is required');
  }
  const enabled = options.enabled ?? true;
  const extractor = options.extractor;
  if (enabled && (extractor?.apiVersion !== 1 || typeof extractor.extract !== 'function')) {
    throw new FeatureError('MODEL_UNAVAILABLE', 'A configured profile extractor v1 is required');
  }
  const now = options.now ?? Date.now;

  const feature: PersonaProfileFeature = {
    apiVersion: 1 as const,

    async beforeContext(context, _input) {
      context.signal.throwIfAborted();
      recordConversationContextSourcesV1(context, PROFILE_FEATURE_ID, []);
      if (!enabled) return { persona: null, contributions: [] };

      const [personas, profiles] = await Promise.all([
        options.api.listPersonas(context, { conversationId: context.conversationId }),
        options.api.listProfiles(context, {
          conversationId: context.conversationId,
          conversationKind: context.conversationKind,
          state: 'active',
          limit: MAX_ACTIVE_PROFILES,
        }),
      ]);
      context.signal.throwIfAborted();
      const activePersona = personas.items.find(persona => persona.id === context.personaId
        && persona.enabled
        && (persona.conversationIds.length === 0 || persona.conversationIds.includes(context.conversationId))) ?? null;
      const userScope = context.conversationKind === 'direct';
      const subjectKind = userScope ? 'user' : 'group';
      const eligible = profiles.items.filter(profile => profile.state === 'active'
        && profile.subjectKind === subjectKind
        && profile.personaId === context.personaId
        && (userScope || profile.conversationId === context.conversationId)
        && (profile.validUntil === null || profile.validUntil > now())
        && profile.text.length <= 2_000
        && profile.sourceMessageIds.length > 0
        && isSourceRefsWellFormed(profile.sourceRefs))
        .slice(0, MAX_PROFILE_CONTEXT_ITEMS);

      const profileContributions: ContextContribution[] = [];
      const profileSources: ConversationSourceRef[] = [];
      let usedCharacters = 0;
      for (const profile of eligible) {
        const refs = profile.sourceRefs;
        if (profileSources.length + refs.length > 256) break;
        const content = `[profile:${profile.category}] ${profile.text}`;
        if (usedCharacters + content.length > MAX_PROFILE_CONTEXT_CHARACTERS) break;
        profileSources.push(...refs);
        profileContributions.push({ feature: PROFILE_FEATURE_ID, content, sourceRefs: refs });
        usedCharacters += content.length;
      }

      if (profileSources.length > 0) {
        const proof = await authorizeConversationSourcesV1(options.api, context, profileSources);
        if (!proof.allowed || proof.unavailable === true
          || proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
          recordConversationContextSourcesV1(context, PROFILE_FEATURE_ID, []);
          return {
            persona: activePersona,
            contributions: [],
          };
        }
      }
      recordConversationContextSourcesV1(context, PROFILE_FEATURE_ID, profileSources);
      return {
        persona: activePersona,
        contributions: profileContributions,
      };
    },

    async afterTurn(context, input) {
      context.signal.throwIfAborted();
      if (!enabled || input.status !== 'completed') return [];
      if (extractor === undefined) throw new FeatureError('MODEL_UNAVAILABLE', 'A configured profile extractor v1 is required');

      const page = await options.api.listMessages(context, {
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        order: 'desc',
        limit: 100,
      });
      const userMessage = page.items.find(message => message.eventId === input.userEventId
        && message.role === 'user'
        && message.status === 'active'
        && message.scope.conversationId === context.conversationId
        && message.scope.conversationKind === context.conversationKind
        && message.scope.personaId === context.personaId
        && message.scope.visibility === context.visibility);
      if (userMessage === undefined) return [];

      const sourceRefs = rawSourceRefs([userMessage.id]);
      const sourceProof = await authorizeConversationSourcesV1(options.api, context, sourceRefs);
      if (!sourceProof.allowed || sourceProof.unavailable === true
        || sourceProof.currentAuthorizationEpoch !== context.authorizationEpoch) return [];

      let drafts: Awaited<ReturnType<ProfileExtractionProviderV1['extract']>>;
      try {
        drafts = await extractor.extract({
          scope: {
            workspaceId: context.workspaceId,
            actorId: context.actorId,
            conversationId: context.conversationId,
            conversationKind: context.conversationKind,
            personaId: context.personaId,
            visibility: context.visibility,
            authorizationEpoch: context.authorizationEpoch,
          },
          message: { id: userMessage.id, content: userMessage.content, occurredAt: userMessage.occurredAt },
          signal: context.signal,
        });
      } catch (error: unknown) {
        if (context.signal.aborted) throw error;
        throw new FeatureError('MODEL_UNAVAILABLE', 'Configured profile extraction failed');
      }
      context.signal.throwIfAborted();
      if (drafts.length > MAX_CANDIDATES_PER_TURN) {
        throw new FeatureError('MODEL_UNAVAILABLE', 'Profile extractor exceeded its bounded candidate count');
      }
      const normalized = drafts.map(draft => validateDraft(draft, now()));
      const proof = await authorizeConversationSourcesV1(options.api, context, sourceRefs);
      if (!proof.allowed || proof.unavailable === true
        || proof.currentAuthorizationEpoch !== context.authorizationEpoch) return [];

      const subjectKind = context.conversationKind === 'direct' ? 'user' : 'group';
      const created: ProfileCandidate[] = [];
      for (const draft of normalized) {
        context.signal.throwIfAborted();
        const receipt = await options.api.createProfileCandidate(context, {
          idempotencyKey: profileCandidateKey(context, input.userEventId, draft),
          conversationId: context.conversationId,
          conversationKind: context.conversationKind,
          subjectKind,
          personaId: context.personaId,
          category: draft.category,
          text: draft.text,
          sourceMessageIds: [userMessage.id],
          sourceRefs,
          confidence: draft.confidence,
          ...(draft.validUntil === undefined ? {} : { validUntil: draft.validUntil }),
        });
        created.push(receipt.candidate);
      }
      return created;
    },

    async beforeDelivery(context, input) {
      context.signal.throwIfAborted();
      if (!hasConversationContextProofV1(context, PROFILE_FEATURE_ID, input.sourceRefs)) {
        return { decision: 'hold', code: 'SOURCE_PROOF_MISSING', authorizationEpoch: context.authorizationEpoch };
      }
      const proof = await authorizeConversationSourcesV1(options.api, context, input.sourceRefs);
      if (proof.unavailable === true) {
        return { decision: 'hold', code: 'SOURCE_AUTHORIZATION_UNAVAILABLE', authorizationEpoch: context.authorizationEpoch };
      }
      if (!proof.allowed) {
        return { decision: 'hold', code: 'SOURCE_AUTHORIZATION_REVOKED', authorizationEpoch: proof.currentAuthorizationEpoch };
      }
      if (proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
        return { decision: 'hold', code: 'SOURCE_AUTHORIZATION_EPOCH_CHANGED', authorizationEpoch: proof.currentAuthorizationEpoch };
      }
      return { decision: 'allow', authorizationEpoch: proof.currentAuthorizationEpoch };
    },

    putPersona: async (context, persona) => (await options.api.putPersona(context, persona)).persona,
    activateCandidate: async (context, candidateId, expectedVersion) =>
      (await options.api.activateProfileCandidate(context, candidateId, expectedVersion)).profile,
    rollbackProfile: async (context, profileId, expectedVersion) =>
      (await options.api.rollbackProfile(context, profileId, expectedVersion)).profile,
  };
  return Object.freeze(feature);
}

function rawSourceRefs(sourceMessageIds: readonly string[]): ConversationSourceRef[] {
  const unique = [...new Set(sourceMessageIds)];
  const result: ConversationSourceRef[] = [];
  for (let offset = 0; offset < unique.length; offset += MAX_SOURCE_IDS_PER_REF) {
    result.push({
      memoryId: null,
      memoryVersion: null,
      sourceMessageIds: unique.slice(offset, offset + MAX_SOURCE_IDS_PER_REF),
    });
  }
  return result;
}

function isSourceRefsWellFormed(sourceRefs: readonly ConversationSourceRef[]): boolean {
  return Array.isArray(sourceRefs)
    && sourceRefs.length > 0
    && sourceRefs.length <= 256
    && sourceRefs.every(ref => {
      const versionValid = ref.memoryId === null
        ? ref.memoryVersion === null
        : isIdentifier(ref.memoryId) && Number.isSafeInteger(ref.memoryVersion) && (ref.memoryVersion ?? 0) >= 1;
      return versionValid
        && Array.isArray(ref.sourceMessageIds)
        && ref.sourceMessageIds.length > 0
        && ref.sourceMessageIds.length <= MAX_SOURCE_IDS_PER_REF
        && ref.sourceMessageIds.every(isIdentifier);
    });
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_048
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateDraft(draft: {
  readonly category: ProfileCategory;
  readonly text: string;
  readonly confidence: number;
  readonly validUntil?: number;
}, now: number): {
  readonly category: ProfileCategory;
  readonly text: string;
  readonly confidence: number;
  readonly validUntil?: number;
} {
  if (!['preference', 'style', 'constraint', 'temporary_state'].includes(draft.category)
    || typeof draft.text !== 'string'
    || draft.text.trim().length === 0
    || draft.text.length > 8_000
    || !Number.isFinite(draft.confidence)
    || draft.confidence < 0
    || draft.confidence > 1
    || (draft.validUntil !== undefined && (!Number.isSafeInteger(draft.validUntil) || draft.validUntil <= now))
    || (draft.category === 'temporary_state' && draft.validUntil === undefined)) {
    throw new FeatureError('MODEL_UNAVAILABLE', 'Profile extractor returned an invalid candidate');
  }
  return {
    category: draft.category,
    text: draft.text.trim(),
    confidence: draft.confidence,
    ...(draft.validUntil === undefined ? {} : { validUntil: draft.validUntil }),
  };
}

function profileCandidateKey(
  context: TrustedTurnContext,
  userEventId: string,
  draft: ReturnType<typeof validateDraft>,
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    workspaceId: context.workspaceId,
    actorId: context.actorId,
    conversationId: context.conversationId,
    personaId: context.personaId,
    userEventId,
    category: draft.category,
    text: draft.text,
    confidence: draft.confidence,
    validUntil: draft.validUntil ?? null,
  })).digest('hex');
  return `profile-candidate-${digest}`;
}
