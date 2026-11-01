// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator knowledge graph feature                           │
// │ Role: Propose sourced graph changes and require provider readback.   │
// │ 模块职责：提出带来源的图谱变更，并要求真实提供方回读确认。             │
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
import { ConversationFeatureError } from './conversation-memory.ts';
import type {
  ConversationDomainApiV1,
  GraphApplyReceipt,
  GraphChangeset,
  GraphEdgeProposal,
  GraphExtractionProviderV1,
  GraphNodeProposal,
} from './conversation-domain-api.ts';
import { ConversationDomainApiError } from './conversation-domain-api.ts';

const GRAPH_FEATURE_ID = 'knowledge-graph-dream.v1';
const MAX_GRAPH_NODES_PER_TURN = 50;
const MAX_GRAPH_EDGES_PER_TURN = 100;
const MAX_GRAPH_CONTEXT_ITEMS = 24;
const MAX_GRAPH_CONTEXT_CHARACTERS = 8_000;
const MAX_SOURCE_IDS_PER_REF = 128;

/** Optional graph consumer settings; provider absence remains visible to the caller. */
export interface KnowledgeGraphFeatureOptions {
  readonly api: ConversationDomainApiV1;
  readonly extractor?: GraphExtractionProviderV1;
  readonly enabled?: boolean;
}

/** Query outcome distinguishes unavailable provider from a genuine empty graph. */
export interface GraphContextResult {
  readonly availability: 'ready' | 'unavailable' | 'disabled';
  readonly contributions: readonly ContextContribution[];
}

/** Proposal and explicit provider-apply/readback hooks for the graph domain. */
export interface KnowledgeGraphFeature {
  readonly apiVersion: 1;
  beforeContext(context: TrustedTurnContext, input: ConversationContextInput): Promise<GraphContextResult>;
  afterTurn(context: TrustedTurnContext, input: ConversationAfterTurnInput): Promise<GraphChangeset | undefined>;
  beforeDelivery(context: TrustedTurnContext, input: ConversationDeliveryInput): Promise<ConversationDeliveryDecision>;
  applyChangeset(context: TrustedTurnContext, changesetId: string, expectedVersion: number): Promise<{
    readonly changeset: GraphChangeset;
    readonly receipt: GraphApplyReceipt;
  }>;
}

/**
 * Create graph consumers over the authenticated Work API. Proposals remain reviewable;
 * apply succeeds only when the provider reports a matching independent readback.
 */
export function createKnowledgeGraphFeature(options: KnowledgeGraphFeatureOptions): KnowledgeGraphFeature {
  if (options.api?.apiVersion !== 1) {
    throw new ConversationFeatureError('MEMORY_API_UNAVAILABLE', 'Conversation Work API v1 is required');
  }
  const enabled = options.enabled ?? true;
  const extractor = options.extractor;
  if (enabled && (extractor?.apiVersion !== 1 || typeof extractor.extract !== 'function')) {
    throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'A configured graph extractor v1 is required');
  }

  const feature: KnowledgeGraphFeature = {
    apiVersion: 1 as const,

    async beforeContext(context, input) {
      context.signal.throwIfAborted();
      recordConversationContextSourcesV1(context, GRAPH_FEATURE_ID, []);
      if (!enabled) return { availability: 'disabled', contributions: [] };
      if (typeof input.query !== 'string' || input.query.trim().length === 0) {
        return { availability: 'ready', contributions: [] };
      }
      let graph: Awaited<ReturnType<ConversationDomainApiV1['queryGraph']>>;
      try {
        graph = await options.api.queryGraph(context, {
          conversationId: context.conversationId,
          conversationKind: context.conversationKind,
          personaId: context.personaId,
          query: input.query.slice(0, 2_000),
          limit: Math.min(MAX_GRAPH_CONTEXT_ITEMS, Math.max(1, input.maximumContributions ?? 16)),
        });
      } catch (error: unknown) {
        if (context.signal.aborted) throw error;
        if (isGraphProviderUnavailable(error)) return { availability: 'unavailable', contributions: [] };
        throw error;
      }
      context.signal.throwIfAborted();

      const rows: { readonly content: string; readonly sourceRefs: readonly ConversationSourceRef[] }[] = [];
      let characters = 0;
      if (graph.items.length > MAX_GRAPH_CONTEXT_ITEMS) {
        throw new ConversationDomainApiError('GRAPH_PROVIDER_RESULT_INVALID', 502, false, 'Graph provider exceeded its requested item limit');
      }
      for (const item of graph.items) {
        const refs = item.sourceRefs;
        if (!isSourceRefsWellFormed(refs)) {
          throw new ConversationDomainApiError('GRAPH_PROVIDER_RESULT_INVALID', 502, false, 'Graph provider returned an item without complete sourceRefs');
        }
        const content = item.itemType === 'node'
          ? `[entity:${item.id}] ${item.label}`
          : item.itemType === 'edge'
            ? `[relation:${item.id}] ${item.fromId} ${item.label} ${item.toId}`
            : undefined;
        if (content === undefined) {
          throw new ConversationDomainApiError('GRAPH_PROVIDER_RESULT_INVALID', 502, false, 'Graph provider item discriminator is invalid');
        }
        if (characters + content.length > MAX_GRAPH_CONTEXT_CHARACTERS) break;
        rows.push({ content, sourceRefs: refs });
        characters += content.length;
      }
      const sourceRefs = rows.flatMap(row => row.sourceRefs);
      if (sourceRefs.length > 256) {
        recordConversationContextSourcesV1(context, GRAPH_FEATURE_ID, []);
        return { availability: 'unavailable', contributions: [] };
      }
      if (sourceRefs.length > 0) {
        const proof = await authorizeConversationSourcesV1(options.api, context, sourceRefs);
        if (!proof.allowed || proof.unavailable === true
          || proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
          recordConversationContextSourcesV1(context, GRAPH_FEATURE_ID, []);
          return { availability: 'ready', contributions: [] };
        }
      }
      recordConversationContextSourcesV1(context, GRAPH_FEATURE_ID, sourceRefs);
      return {
        availability: 'ready',
        contributions: rows.map(row => ({ feature: GRAPH_FEATURE_ID, ...row })),
      };
    },

    async afterTurn(context, input) {
      context.signal.throwIfAborted();
      if (!enabled || input.status !== 'completed') return undefined;
      if (extractor === undefined) throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'A configured graph extractor v1 is required');

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
      if (userMessage === undefined) return undefined;

      const sourceRefs = rawSourceRefs([userMessage.id]);
      const sourceProof = await authorizeConversationSourcesV1(options.api, context, sourceRefs);
      if (!sourceProof.allowed || sourceProof.unavailable === true
        || sourceProof.currentAuthorizationEpoch !== context.authorizationEpoch) return undefined;

      let draft: Awaited<ReturnType<GraphExtractionProviderV1['extract']>>;
      try {
        draft = await extractor.extract({ scope: scopeOf(context), message: {
          id: userMessage.id,
          content: userMessage.content,
          occurredAt: userMessage.occurredAt,
        }, signal: context.signal });
      } catch (error: unknown) {
        if (context.signal.aborted) throw error;
        throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'Configured graph extraction failed');
      }
      context.signal.throwIfAborted();
      const nodes = validateNodes(draft.nodes, userMessage.id);
      const edges = validateEdges(draft.edges, userMessage.id, new Set(nodes.map(node => node.id)));
      if (nodes.length === 0 && edges.length === 0) return undefined;
      const proof = await authorizeConversationSourcesV1(options.api, context, sourceRefs);
      if (!proof.allowed || proof.unavailable === true
        || proof.currentAuthorizationEpoch !== context.authorizationEpoch) return undefined;
      const receipt = await options.api.createGraphProposal(context, {
        idempotencyKey: graphProposalKey(context, input.userEventId, nodes, edges),
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        personaId: context.personaId,
        nodes,
        edges,
      });
      return receipt.changeset;
    },

    async beforeDelivery(context, input) {
      context.signal.throwIfAborted();
      if (!hasConversationContextProofV1(context, GRAPH_FEATURE_ID, input.sourceRefs)) {
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

    async applyChangeset(context, changesetId, expectedVersion) {
      context.signal.throwIfAborted();
      const listed = await options.api.listGraphChangesets(context, { limit: 500 });
      const changeset = listed.items.find(item => item.id === changesetId);
      if (changeset === undefined) {
        throw new ConversationDomainApiError('GRAPH_CHANGESET_NOT_FOUND', 404, false, 'Graph changeset was not found');
      }
      if (changeset.conversationId !== context.conversationId
        || changeset.conversationKind !== context.conversationKind
        || changeset.personaId !== context.personaId
        || changeset.version !== expectedVersion) {
        throw new ConversationDomainApiError('GRAPH_CHANGESET_CONFLICT', 409, false, 'Graph changeset version changed');
      }
      const sourceRefs = normalizeGraphRefs([
        ...changeset.nodes.flatMap(node => node.sourceRefs),
        ...changeset.edges.flatMap(edge => edge.sourceRefs),
      ]);
      const proof = await authorizeConversationSourcesV1(options.api, context, sourceRefs);
      if (!proof.allowed || proof.unavailable === true
        || proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
        throw new ConversationDomainApiError('GRAPH_SOURCE_AUTHORIZATION_REVOKED', 409, false, 'Graph proposal sources are no longer authorized');
      }
      if (sourceRefs.length === 0) {
        throw new ConversationDomainApiError('GRAPH_SOURCE_AUTHORIZATION_REVOKED', 409, false, 'Graph proposal has no auditable source messages');
      }
      if (changeset.state === 'projected') {
        const priorReceipt = changeset.providerReceipt;
        if (!changeset.providerApplied || priorReceipt === undefined
          || priorReceipt.requestDigest !== changeset.digest
          || priorReceipt.readbackDigest !== changeset.digest
          || priorReceipt.nodeCount !== changeset.nodes.length
          || priorReceipt.edgeCount !== changeset.edges.length) {
          throw new ConversationDomainApiError('GRAPH_PROVIDER_READBACK_MISMATCH', 502, false, 'Stored graph projection lacks an exact provider receipt');
        }
        return { changeset, receipt: priorReceipt };
      }
      if (changeset.state !== 'proposed') {
        throw new ConversationDomainApiError('GRAPH_CHANGESET_CONFLICT', 409, false, 'Graph changeset is not awaiting application');
      }
      const applied = await options.api.applyGraphChangeset(context, changesetId, expectedVersion);
      const receipt = applied.changeset.providerReceipt;
      if (receipt === undefined
        || receipt.requestDigest !== changeset.digest
        || receipt.readbackDigest !== changeset.digest
        || receipt.nodeCount !== changeset.nodes.length
        || receipt.edgeCount !== changeset.edges.length
        || !Number.isSafeInteger(receipt.appliedAt)
        || applied.changeset.providerApplied !== true
        || applied.changeset.state !== 'projected') {
        throw new ConversationDomainApiError('GRAPH_PROVIDER_READBACK_MISMATCH', 502, false, 'Graph provider did not confirm the exact proposal');
      }
      return { changeset: applied.changeset, receipt };
    },
  };
  return Object.freeze(feature);
}

function validateNodes(
  values: readonly Omit<GraphNodeProposal, 'sourceMessageIds' | 'sourceRefs'>[],
  sourceMessageId: string,
): GraphNodeProposal[] {
  if (!Array.isArray(values) || values.length > MAX_GRAPH_NODES_PER_TURN) {
    throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'Graph extractor exceeded its node limit');
  }
  const seen = new Set<string>();
  return values.map(node => {
    if (!isIdentifier(node.id) || !isNonemptyText(node.label, 240) || seen.has(node.id)) {
      throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'Graph extractor returned an invalid node');
    }
    seen.add(node.id);
    const properties = safeProperties(node.properties);
    return {
      id: node.id,
      label: node.label.trim(),
      properties,
      sourceMessageIds: [sourceMessageId],
      sourceRefs: rawSourceRefs([sourceMessageId]),
    };
  });
}

function validateEdges(
  values: readonly Omit<GraphEdgeProposal, 'sourceMessageIds' | 'sourceRefs'>[],
  sourceMessageId: string,
  nodeIds: ReadonlySet<string>,
): GraphEdgeProposal[] {
  if (!Array.isArray(values) || values.length > MAX_GRAPH_EDGES_PER_TURN) {
    throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'Graph extractor exceeded its edge limit');
  }
  const seen = new Set<string>();
  return values.map(edge => {
    if (!isIdentifier(edge.id) || !isIdentifier(edge.fromId) || !isIdentifier(edge.toId)
      || !isNonemptyText(edge.label, 240) || seen.has(edge.id)
      || (!nodeIds.has(edge.fromId) && !nodeIds.has(edge.toId))) {
      throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'Graph extractor returned an invalid edge');
    }
    seen.add(edge.id);
    return {
      id: edge.id,
      fromId: edge.fromId,
      toId: edge.toId,
      label: edge.label.trim(),
      properties: safeProperties(edge.properties),
      sourceMessageIds: [sourceMessageId],
      sourceRefs: rawSourceRefs([sourceMessageId]),
    };
  });
}

function safeProperties(value: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'Graph properties are not JSON-safe');
  }
  if (encoded.length > 8_000 || /(?:password|secret|token|credential|authorization)/iu.test(encoded)) {
    throw new ConversationFeatureError('MODEL_UNAVAILABLE', 'Graph properties exceed safe content bounds');
  }
  return JSON.parse(encoded) as Record<string, unknown>;
}

function rawSourceRefs(sourceMessageIds: readonly string[]): ConversationSourceRef[] {
  const unique = [...new Set(sourceMessageIds)];
  const result: ConversationSourceRef[] = [];
  for (let offset = 0; offset < unique.length; offset += MAX_SOURCE_IDS_PER_REF) {
    result.push({ memoryId: null, memoryVersion: null, sourceMessageIds: unique.slice(offset, offset + MAX_SOURCE_IDS_PER_REF) });
  }
  return result;
}

function isSourceRefsWellFormed(sourceRefs: readonly ConversationSourceRef[]): boolean {
  return Array.isArray(sourceRefs)
    && sourceRefs.length > 0
    && sourceRefs.length <= 256
    && sourceRefs.every(ref => {
      const memoryValid = ref.memoryId === null
        ? ref.memoryVersion === null
        : isIdentifier(ref.memoryId) && Number.isSafeInteger(ref.memoryVersion) && (ref.memoryVersion ?? 0) >= 1;
      return memoryValid && Array.isArray(ref.sourceMessageIds)
        && ref.sourceMessageIds.length > 0
        && ref.sourceMessageIds.length <= MAX_SOURCE_IDS_PER_REF
        && ref.sourceMessageIds.every(isIdentifier);
    });
}

function normalizeGraphRefs(sourceRefs: readonly ConversationSourceRef[]): ConversationSourceRef[] {
  if (!Array.isArray(sourceRefs) || sourceRefs.length > 256 || !sourceRefs.every(ref => isSourceRefsWellFormed([ref]))) {
    throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Graph source lineage is malformed or exceeds its bound');
  }
  const grouped = new Map<string, { readonly memoryId: string | null; readonly memoryVersion: number | null; readonly ids: Set<string> }>();
  let totalIds = 0;
  for (const ref of sourceRefs) {
    const key = JSON.stringify([ref.memoryId, ref.memoryVersion]);
    const group = grouped.get(key) ?? { memoryId: ref.memoryId, memoryVersion: ref.memoryVersion, ids: new Set<string>() };
    for (const id of ref.sourceMessageIds) {
      group.ids.add(id);
      totalIds += 1;
    }
    grouped.set(key, group);
  }
  if (totalIds > 32_768) throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Graph source lineage is too large');
  const normalized: ConversationSourceRef[] = [];
  for (const group of grouped.values()) {
    const ids = [...group.ids].sort();
    for (let offset = 0; offset < ids.length; offset += MAX_SOURCE_IDS_PER_REF) {
      normalized.push({
        memoryId: group.memoryId,
        memoryVersion: group.memoryVersion,
        sourceMessageIds: ids.slice(offset, offset + MAX_SOURCE_IDS_PER_REF),
      });
    }
  }
  if (normalized.length > 256) throw new ConversationFeatureError('INVALID_SOURCE_PROOF', 'Graph source references exceed their limit');
  return normalized;
}

function isGraphProviderUnavailable(error: unknown): boolean {
  return error instanceof ConversationDomainApiError
    && error.code === 'GRAPH_PROVIDER_UNAVAILABLE'
    && error.status === 503;
}

function graphProposalKey(
  context: TrustedTurnContext,
  eventId: string,
  nodes: readonly GraphNodeProposal[],
  edges: readonly GraphEdgeProposal[],
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    workspaceId: context.workspaceId,
    actorId: context.actorId,
    conversationId: context.conversationId,
    personaId: context.personaId,
    eventId,
    nodes,
    edges,
  })).digest('hex');
  return `graph-proposal-${digest}`;
}

function scopeOf(context: TrustedTurnContext): {
  workspaceId: string;
  actorId: string;
  conversationId: string;
  conversationKind: TrustedTurnContext['conversationKind'];
  personaId: string | null;
  visibility: TrustedTurnContext['visibility'];
  authorizationEpoch: number;
} {
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

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isNonemptyText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}
