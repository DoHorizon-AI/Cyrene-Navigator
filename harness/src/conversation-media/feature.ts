// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 feature.ts                                                       │
// │  Module: harness/conversation-media/feature                          │
// │  Role: Add source-authorized media analysis to the current DSH turn.  │
// │                                                                      │
// │  模块职责：将 ASR/vision 结果作为当前回合的可追溯上下文贡献。         │
// │  · 取消、来源复验或 provider 失败时不返回任何迟到/伪造内容。          │
// └─────────────────────────────────────────────────────────────────────┘

import {
  authorizeConversationSourcesV1,
  hasConversationContextProofV1,
  recordConversationContextSourcesV1,
} from '../features/conversation-memory.ts';
import type {
  ConversationDeliveryDecision,
  ConversationDeliveryInput,
  ConversationMemoryApiV1,
  ConversationSourceRef,
  TrustedTurnContext,
} from '../features/conversation-memory.ts';
import {
  ConversationMediaBridgeError,
  type ConversationMediaAttachment,
  type ConversationMediaBridge,
  type MediaContextContribution,
} from './bridge.ts';

const MEDIA_FEATURE_ID = 'conversation-media.v1';
const MAX_ATTACHMENTS_PER_TURN = 32;
const MAX_MEDIA_CONTRIBUTION_BYTES = 32_000;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm']);

/** Current Work user message and attachments resolved by the server-side turn hook. */
export interface ConversationMediaInput {
  readonly messageId: string;
  readonly query: string;
  readonly attachments: readonly ConversationMediaAttachment[];
}

/** Typed result for the host's after-attachment context hook. */
export interface ConversationMediaContextResult {
  readonly availability: 'ready' | 'unavailable' | 'disabled';
  readonly contributions: readonly MediaContextContribution[];
  readonly reasonCode?: string;
}

/** Narrow media feature shape; the Host owns lifecycle and connector sending. */
export interface ConversationMediaFeature {
  readonly apiVersion: 1;
  beforeContext(
    context: TrustedTurnContext,
    input: ConversationMediaInput,
  ): Promise<ConversationMediaContextResult>;
  beforeDelivery(
    context: TrustedTurnContext,
    input: ConversationDeliveryInput,
  ): Promise<ConversationDeliveryDecision>;
}

/** Constructor settings for one Harness-bound Work API and media bridge. */
export interface ConversationMediaFeatureOptions {
  readonly api: ConversationMemoryApiV1;
  readonly bridge: ConversationMediaBridge;
  readonly enabled?: boolean;
}

/**
 * Build a DSH media context hook over the core-owned Work message and media route.
 *
 * The Host supplies `messageId` and attachment metadata after the user message is stored.
 * The media route independently resolves that ID from its actor-private task and Work
 * record, then authorizes and reads bytes. This feature rechecks returned source refs before
 * it allows them into context; it never sends the resulting text to a connector.
 */
export function createConversationMediaFeature(
  options: ConversationMediaFeatureOptions,
): ConversationMediaFeature {
  if (options.api?.apiVersion !== 1 || typeof options.bridge?.analyze !== 'function') {
    throw new TypeError('Conversation Work API v1 and a media bridge are required');
  }
  const enabled = options.enabled ?? true;

  return Object.freeze({
    apiVersion: 1 as const,

    async beforeContext(
      context: TrustedTurnContext,
      input: ConversationMediaInput,
    ): Promise<ConversationMediaContextResult> {
      context.signal.throwIfAborted();
      recordConversationContextSourcesV1(context, MEDIA_FEATURE_ID, []);
      if (!enabled) return { availability: 'disabled', contributions: [] };

      const messageId = validateMediaInput(input);
      const supported = input.attachments.filter(isSupportedMedia);
      if (supported.length === 0) return { availability: 'ready', contributions: [] };

      const contributions: MediaContextContribution[] = [];
      for (const artifact of supported) {
        context.signal.throwIfAborted();
        const operation = AUDIO_MIMES.has(artifact.mimeType) ? 'transcribe' : 'describe_image';
        try {
          const response = await options.bridge.analyze({
            messageId,
            artifact,
            operation,
            ...(operation === 'describe_image' && input.query.trim().length > 0
              ? { prompt: [...input.query.trim()].slice(0, 1_024).join('') }
              : {}),
          }, context);
          context.signal.throwIfAborted();
          if (response.status === 'no_speech') continue;
          const contribution = validateContribution(response.contribution, messageId);
          contributions.push(contribution);
        } catch (error: unknown) {
          if (context.signal.aborted) throw error;
          recordConversationContextSourcesV1(context, MEDIA_FEATURE_ID, []);
          const code = error instanceof ConversationMediaBridgeError
            ? error.code
            : 'MEDIA_ANALYSIS_UNAVAILABLE';
          return { availability: 'unavailable', contributions: [], reasonCode: code };
        }
      }

      if (contributions.length === 0) {
        recordConversationContextSourcesV1(context, MEDIA_FEATURE_ID, []);
        return { availability: 'ready', contributions: [] };
      }
      const sourceRefs = normalizeSources(contributions.flatMap(item => item.sourceRefs));
      const proof = await authorizeConversationSourcesV1(options.api, context, sourceRefs);
      context.signal.throwIfAborted();
      if (!proof.allowed || proof.unavailable === true
        || proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
        recordConversationContextSourcesV1(context, MEDIA_FEATURE_ID, []);
        return {
          availability: 'unavailable',
          contributions: [],
          reasonCode: proof.unavailable === true
            ? 'SOURCE_AUTHORIZATION_UNAVAILABLE'
            : 'SOURCE_AUTHORIZATION_REVOKED',
        };
      }
      recordConversationContextSourcesV1(context, MEDIA_FEATURE_ID, sourceRefs);
      context.signal.throwIfAborted();
      return { availability: 'ready', contributions };
    },

    async beforeDelivery(
      context: TrustedTurnContext,
      input: ConversationDeliveryInput,
    ): Promise<ConversationDeliveryDecision> {
      context.signal.throwIfAborted();
      if (!hasConversationContextProofV1(context, MEDIA_FEATURE_ID, input.sourceRefs)) {
        return {
          decision: 'hold',
          code: 'SOURCE_PROOF_MISSING',
          authorizationEpoch: context.authorizationEpoch,
        };
      }
      const proof = await authorizeConversationSourcesV1(options.api, context, input.sourceRefs);
      context.signal.throwIfAborted();
      if (proof.unavailable === true) {
        return {
          decision: 'hold',
          code: 'SOURCE_AUTHORIZATION_UNAVAILABLE',
          authorizationEpoch: context.authorizationEpoch,
        };
      }
      if (!proof.allowed) {
        return {
          decision: 'hold',
          code: 'SOURCE_AUTHORIZATION_REVOKED',
          authorizationEpoch: proof.currentAuthorizationEpoch,
        };
      }
      if (proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
        return {
          decision: 'hold',
          code: 'SOURCE_AUTHORIZATION_EPOCH_CHANGED',
          authorizationEpoch: proof.currentAuthorizationEpoch,
        };
      }
      return { decision: 'allow', authorizationEpoch: proof.currentAuthorizationEpoch };
    },
  });
}

function validateMediaInput(input: ConversationMediaInput): string {
  if (input === null || typeof input !== 'object'
    || typeof input.messageId !== 'string'
    || input.messageId.trim().length === 0
    || input.messageId.length > 512
    || typeof input.query !== 'string'
    || !Array.isArray(input.attachments)
    || input.attachments.length > MAX_ATTACHMENTS_PER_TURN) {
    throw new ConversationMediaBridgeError('MEDIA_INPUT_INVALID', 422);
  }
  const seen = new Set<string>();
  for (const attachment of input.attachments) {
    if (attachment === null || typeof attachment !== 'object'
      || typeof attachment.artifactId !== 'string'
      || typeof attachment.sha256 !== 'string'
      || typeof attachment.mimeType !== 'string'
      || !/^[0-9a-f]{64}$/u.test(attachment.artifactId)
      || attachment.sha256 !== attachment.artifactId
      || !Number.isSafeInteger(attachment.size)
      || attachment.size < 1
      || attachment.size > 10_000_000
      || typeof attachment.mimeType !== 'string'
      || attachment.artifactId.length === 0
      || seen.has(attachment.artifactId)) {
      throw new ConversationMediaBridgeError('MEDIA_ATTACHMENT_METADATA_INVALID', 422);
    }
    seen.add(attachment.artifactId);
  }
  return input.messageId;
}

function isSupportedMedia(attachment: ConversationMediaAttachment): boolean {
  if (IMAGE_MIMES.has(attachment.mimeType) || AUDIO_MIMES.has(attachment.mimeType)) return true;
  if (attachment.mimeType.startsWith('image/') || attachment.mimeType.startsWith('audio/')) {
    throw new ConversationMediaBridgeError('MEDIA_ATTACHMENT_MIME_UNSUPPORTED', 415);
  }
  return false;
}

function validateContribution(
  contribution: MediaContextContribution,
  messageId: string,
): MediaContextContribution {
  if (contribution.feature !== MEDIA_FEATURE_ID
    || typeof contribution.content !== 'string'
    || contribution.content.trim().length === 0
    || new TextEncoder().encode(contribution.content).byteLength > MAX_MEDIA_CONTRIBUTION_BYTES
    || !Array.isArray(contribution.sourceRefs)
    || contribution.sourceRefs.length === 0
    || !contribution.sourceRefs.some(ref => ref.sourceMessageIds.includes(messageId))) {
    throw new ConversationMediaBridgeError('MEDIA_RESPONSE_INVALID', 502);
  }
  return {
    feature: MEDIA_FEATURE_ID,
    content: contribution.content,
    sourceRefs: normalizeSources(contribution.sourceRefs),
  };
}

function normalizeSources(sourceRefs: readonly ConversationSourceRef[]): readonly ConversationSourceRef[] {
  const unique = new Map<string, ConversationSourceRef>();
  for (const ref of sourceRefs) {
    const sourceMessageIds = [...new Set(ref.sourceMessageIds)].sort();
    if ((ref.memoryId !== null && (typeof ref.memoryId !== 'string'
      || ref.memoryId.length === 0 || ref.memoryId.length > 512))
      || (ref.memoryVersion !== null && typeof ref.memoryVersion !== 'number')
      || (ref.memoryVersion === null) !== (ref.memoryId === null)
      || (ref.memoryVersion !== null && (!Number.isSafeInteger(ref.memoryVersion) || ref.memoryVersion < 1))
      || (ref.memoryId === null && sourceMessageIds.length === 0)
      || sourceMessageIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 512)) {
      throw new ConversationMediaBridgeError('MEDIA_SOURCE_REFS_INVALID', 502);
    }
    const normalized = { memoryId: ref.memoryId, memoryVersion: ref.memoryVersion, sourceMessageIds };
    unique.set(JSON.stringify(normalized), normalized);
  }
  if (unique.size > 256) throw new ConversationMediaBridgeError('MEDIA_SOURCE_REFS_LIMIT', 502);
  return [...unique.values()];
}
