// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator conversation domain API ports                     │
// │ Role: Type the P3-P7 versioned Work API consumed by DSH features.    │
// │ 模块职责：定义 DSH 功能消费的 P3-P7 版本化 Work API。                  │
// └─────────────────────────────────────────────────────────────────────┘

import type {
  ConversationKind,
  ConversationMemoryApiV1,
  ConversationMessage,
  ConversationScope,
  ConversationSourceRef,
  TrustedTurnContext,
} from './conversation-memory.ts';

export type ProfileCategory = 'preference' | 'style' | 'constraint' | 'temporary_state';
export type ProfileSubjectKind = 'user' | 'group';

/** A configured persona selected by the host for a conversation. */
export interface ConversationPersona {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly conversationIds: readonly string[];
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A sourced proposal awaiting review and explicit activation. */
export interface ProfileCandidate {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly conversationId: string;
  readonly conversationKind: ConversationKind | null;
  readonly subjectKind: ProfileSubjectKind;
  readonly personaId: string | null;
  readonly category: ProfileCategory;
  readonly text: string;
  readonly sourceMessageIds: readonly string[];
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly confidence: number;
  readonly validUntil: number | null;
  readonly state: 'candidate' | 'active' | 'rolled_back' | 'expired';
  readonly version: number;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** An active or superseded user/group profile revision. */
export interface ConversationProfile {
  readonly id: string;
  readonly candidateId: string;
  readonly conversationId: string;
  readonly conversationKind: ConversationKind | null;
  readonly subjectKind: ProfileSubjectKind;
  readonly personaId: string | null;
  readonly category: ProfileCategory;
  readonly text: string;
  readonly sourceMessageIds: readonly string[];
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly validUntil: number | null;
  readonly state: 'active' | 'superseded' | 'rolled_back';
  readonly version: number;
  readonly previousProfileId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** One graph node proposed from message-backed evidence. */
export interface GraphNodeProposal {
  readonly id: string;
  readonly label: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly sourceMessageIds: readonly string[];
  readonly sourceRefs: readonly ConversationSourceRef[];
}

/** One graph edge proposed from message-backed evidence. */
export interface GraphEdgeProposal {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly label: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly sourceMessageIds: readonly string[];
  readonly sourceRefs: readonly ConversationSourceRef[];
}

/** One provider-backed node or edge returned for the authenticated conversation scope. */
export type GraphQueryItem =
  | ({ readonly itemType: 'node' } & GraphNodeProposal)
  | ({ readonly itemType: 'edge' } & GraphEdgeProposal);

/** Model proposal fields; source identities are supplied by the trusted host. */
export type GraphNodeDraft = Omit<GraphNodeProposal, 'sourceMessageIds' | 'sourceRefs'>;
export type GraphEdgeDraft = Omit<GraphEdgeProposal, 'sourceMessageIds' | 'sourceRefs'>;

/** Real configured model adapter that extracts graph proposals from one user message. */
export interface GraphExtractionProviderV1 {
  readonly apiVersion: 1;
  extract(input: {
    readonly scope: ConversationScope;
    readonly message: Pick<ConversationMessage, 'id' | 'content' | 'occurredAt'>;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly nodes: readonly GraphNodeDraft[];
    readonly edges: readonly GraphEdgeDraft[];
  }>;
}

/** A reviewable graph proposal; local projection never claims provider application. */
export interface GraphChangeset {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly conversationId: string;
  readonly conversationKind: ConversationKind | null;
  readonly personaId: string | null;
  readonly nodes: readonly GraphNodeProposal[];
  readonly edges: readonly GraphEdgeProposal[];
  readonly digest: string;
  readonly state: 'proposed' | 'projected';
  readonly version: number;
  readonly providerStatus: 'unavailable' | 'applied';
  readonly providerApplied: boolean;
  readonly providerReceipt?: GraphApplyReceipt;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Independent plugin readback receipt required before a graph proposal is projected. */
export interface GraphApplyReceipt {
  readonly requestDigest: string;
  readonly readbackDigest: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly appliedAt: number;
}

/** Durable maintenance state; execution remains a DSH Work Task. */
export interface ConversationMaintenanceJob {
  readonly id: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly kind: 'dream' | 'forget' | 'daily_review' | 'backup' | 'import';
  readonly conversationId: string | null;
  readonly conversationKind: ConversationKind | null;
  readonly personaId: string | null;
  readonly state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly cursor: string | null;
  readonly processedCount: number;
  readonly checkpointDigest: string | null;
  /** Immutable version when the queued job was first committed. */
  readonly queuedVersion: number;
  readonly details: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ConversationMaintenanceJobPage {
  readonly items: readonly ConversationMaintenanceJob[];
  readonly nextCursor: string | null;
}

/** One resumable maintenance checkpoint, committed with compare-and-update. */
export interface MaintenanceCheckpoint {
  readonly cursor: string | null;
  readonly processedCount: number;
  readonly checkpointDigest: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** A research note tied to exact source revisions. */
export interface ResearchNote {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly conversationId: string;
  readonly conversationKind: ConversationKind | null;
  readonly personaId: string | null;
  readonly title: string;
  readonly content: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly revision: number;
  readonly createdAt: number;
}

/** A verified, sourced instruction card; verification identity is server-owned. */
export interface VerifiedSkill {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly conversationId: string | null;
  readonly conversationKind: ConversationKind | null;
  readonly personaId: string | null;
  readonly name: string;
  readonly content: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly operationReceiptId: string;
  readonly independentReadReceiptId: string;
  readonly verified: true;
  readonly verifiedBy: string;
  readonly verifiedAt: number;
  readonly revision: number;
  readonly createdAt: number;
}

/** A durable observation request that is scheduled through DSH Schedule. */
export interface ConversationWatch {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly conversationId: string;
  readonly conversationKind: ConversationKind | null;
  readonly personaId: string | null;
  readonly title: string;
  readonly condition: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly nextCheckAt: number | null;
  readonly state: 'active' | 'cancelled';
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ConversationWatchPage {
  readonly items: readonly ConversationWatch[];
  readonly nextCursor: string | null;
}

/** A focus, commitment, wait or attention item with explicit lifecycle state. */
export interface FocusItem {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly conversationId: string;
  readonly conversationKind: ConversationKind | null;
  readonly personaId: string | null;
  readonly kind: 'commitment' | 'wait' | 'attention';
  readonly summary: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly dueAt: number | null;
  readonly condition: string | null;
  readonly state: 'open' | 'waiting' | 'done' | 'cancelled';
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Minimal session handoff retaining unresolved and unknown operation references. */
export interface ConversationHandoff {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly conversationId: string | null;
  readonly conversationKind: ConversationKind | null;
  readonly personaId: string | null;
  readonly summary: string;
  readonly unresolvedItems: readonly string[];
  readonly unknownOperationRefs: readonly string[];
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly createdAt: number;
}

/** Persisted proactive behavior gate, disabled by default when no row exists. */
export interface ActiveBehaviorPolicy {
  readonly conversationId: string;
  readonly enabled: boolean;
  readonly quietHours: {
    readonly timeZone: string;
    readonly start: string;
    readonly end: string;
  };
  readonly cooldownSeconds: number;
  readonly allowGroupInterjections: boolean;
  readonly followupEnabled: boolean;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Exact P3-P7 Work API methods implemented by the authenticated Navigator Host. */
export interface ConversationDomainApiV1 extends ConversationMemoryApiV1 {
  readonly apiVersion: 1;
  listPersonas(context: TrustedTurnContext, input: { readonly conversationId?: string }): Promise<{ readonly items: readonly ConversationPersona[] }>;
  putPersona(context: TrustedTurnContext, input: {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly prompt: string;
    readonly enabled: boolean;
    readonly conversationIds?: readonly string[];
  }): Promise<{ readonly persona: ConversationPersona }>;
  listProfiles(context: TrustedTurnContext, input: {
    readonly conversationId: string;
    readonly conversationKind: ConversationKind;
    readonly state: 'active';
    readonly limit: number;
  }): Promise<{ readonly items: readonly ConversationProfile[] }>;
  createProfileCandidate(context: TrustedTurnContext, input: {
    readonly idempotencyKey: string;
    readonly conversationId: string;
    readonly conversationKind: ConversationKind;
    readonly subjectKind: ProfileSubjectKind;
    readonly personaId?: string | null;
    readonly category: ProfileCategory;
    readonly text: string;
    readonly sourceMessageIds: readonly string[];
    readonly sourceRefs: readonly ConversationSourceRef[];
    readonly confidence: number;
    readonly validUntil?: number;
  }): Promise<{ readonly candidate: ProfileCandidate; readonly duplicate?: boolean }>;
  listProfileCandidates(context: TrustedTurnContext, input: {
    readonly state?: ProfileCandidate['state'];
    readonly limit: number;
  }): Promise<{ readonly items: readonly ProfileCandidate[] }>;
  activateProfileCandidate(context: TrustedTurnContext, candidateId: string, expectedVersion: number): Promise<{ readonly profile: ConversationProfile }>;
  rollbackProfile(context: TrustedTurnContext, profileId: string, expectedVersion: number): Promise<{ readonly profile: ConversationProfile }>;
  createGraphProposal(context: TrustedTurnContext, input: {
    readonly idempotencyKey: string;
    readonly conversationId: string;
    readonly conversationKind: ConversationKind;
    readonly personaId: string | null;
    readonly nodes: readonly GraphNodeProposal[];
    readonly edges: readonly GraphEdgeProposal[];
  }): Promise<{ readonly changeset: GraphChangeset }>;
  queryGraph(context: TrustedTurnContext, input: {
    readonly conversationId: string;
    readonly conversationKind: ConversationKind;
    readonly personaId: string | null;
    readonly query: string;
    readonly limit: number;
  }): Promise<{ readonly items: readonly GraphQueryItem[] }>;
  listGraphChangesets(context: TrustedTurnContext, input: {
    readonly state?: GraphChangeset['state'];
    readonly limit: number;
  }): Promise<{ readonly items: readonly GraphChangeset[] }>;
  applyGraphChangeset(context: TrustedTurnContext, changesetId: string, expectedVersion: number): Promise<{ readonly changeset: GraphChangeset }>;
  createMaintenanceJob(context: TrustedTurnContext, input: {
    readonly idempotencyKey: string;
    readonly kind: ConversationMaintenanceJob['kind'];
    readonly conversationId?: string;
    readonly conversationKind?: ConversationKind;
    readonly personaId?: string | null;
    readonly cursor?: string;
  }): Promise<{ readonly job: ConversationMaintenanceJob; readonly duplicate: boolean }>;
  listMaintenanceJobs(context: TrustedTurnContext, input: {
    readonly state?: ConversationMaintenanceJob['state'];
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<ConversationMaintenanceJobPage>;
  getMaintenanceJob(context: TrustedTurnContext, jobId: string): Promise<{ readonly job: ConversationMaintenanceJob }>;
  retryMaintenanceJob(context: TrustedTurnContext, jobId: string, expectedVersion: number): Promise<{
    readonly job: ConversationMaintenanceJob;
    readonly duplicate: boolean;
  }>;
  cancelMaintenanceJob(context: TrustedTurnContext, jobId: string, expectedVersion: number): Promise<{ readonly job: ConversationMaintenanceJob }>;
  createResearchNote(context: TrustedTurnContext, input: {
    readonly idempotencyKey: string;
    readonly conversationId: string;
    readonly conversationKind: ConversationKind;
    readonly personaId: string | null;
    readonly title: string;
    readonly content: string;
    readonly sourceRefs: readonly ConversationSourceRef[];
  }): Promise<{ readonly note: ResearchNote; readonly duplicate?: boolean }>;
  listResearchNotes(context: TrustedTurnContext, input: { readonly conversationId?: string; readonly limit: number }): Promise<{ readonly items: readonly ResearchNote[] }>;
  createVerifiedSkill(context: TrustedTurnContext, input: {
    readonly idempotencyKey: string;
    readonly conversationId?: string;
    readonly conversationKind?: ConversationKind;
    readonly personaId?: string | null;
    readonly operationReceiptId: string;
    readonly independentReadReceiptId: string;
    readonly name: string;
    readonly content: string;
    readonly sourceRefs: readonly ConversationSourceRef[];
  }): Promise<{ readonly skill: VerifiedSkill; readonly duplicate?: boolean }>;
  listVerifiedSkills(context: TrustedTurnContext, input: { readonly limit: number }): Promise<{ readonly items: readonly VerifiedSkill[] }>;
  createWatch(context: TrustedTurnContext, input: {
    readonly idempotencyKey: string;
    readonly conversationId: string;
    readonly conversationKind: ConversationKind;
    readonly personaId: string | null;
    readonly title: string;
    readonly condition: string;
    readonly sourceRefs: readonly ConversationSourceRef[];
    readonly nextCheckAt?: number;
  }): Promise<{ readonly watch: ConversationWatch; readonly duplicate?: boolean }>;
  listWatches(context: TrustedTurnContext, input: {
    readonly state?: ConversationWatch['state'];
    readonly conversationId?: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<ConversationWatchPage>;
  cancelWatch(context: TrustedTurnContext, watchId: string, expectedVersion: number): Promise<{ readonly watch: ConversationWatch }>;
  scheduleWatch(context: TrustedTurnContext, watchId: string, input: {
    readonly expectedVersion: number;
    readonly nextCheckAt: number | null;
  }): Promise<{ readonly watch: ConversationWatch }>;
  createFocusItem(context: TrustedTurnContext, input: {
    readonly idempotencyKey: string;
    readonly conversationId: string;
    readonly conversationKind: ConversationKind;
    readonly personaId: string | null;
    readonly kind: FocusItem['kind'];
    readonly summary: string;
    readonly sourceRefs: readonly ConversationSourceRef[];
    readonly dueAt?: number;
    readonly condition?: string;
  }): Promise<{ readonly item: FocusItem; readonly duplicate?: boolean }>;
  listFocusItems(context: TrustedTurnContext, input: {
    readonly state?: FocusItem['state'];
    readonly conversationId?: string;
    readonly limit: number;
  }): Promise<{ readonly items: readonly FocusItem[] }>;
  transitionFocusItem(context: TrustedTurnContext, focusItemId: string, input: {
    readonly state: FocusItem['state'];
    readonly expectedVersion: number;
  }): Promise<{ readonly item: FocusItem }>;
  createHandoff(context: TrustedTurnContext, input: {
    readonly idempotencyKey: string;
    readonly taskId: string;
    readonly sessionId: string;
    readonly conversationId: string;
    readonly conversationKind: ConversationKind;
    readonly personaId: string | null;
    readonly summary: string;
    readonly unresolvedItems: readonly string[];
    readonly unknownOperationRefs: readonly string[];
    readonly sourceRefs: readonly ConversationSourceRef[];
  }): Promise<{ readonly handoff: ConversationHandoff; readonly duplicate?: boolean }>;
  listHandoffs(context: TrustedTurnContext, input: { readonly limit: number }): Promise<{ readonly items: readonly ConversationHandoff[] }>;
  getActiveBehaviorPolicy(context: TrustedTurnContext): Promise<ActiveBehaviorPolicy | null>;
  putActiveBehaviorPolicy(context: TrustedTurnContext, input: {
    readonly conversationId: string;
    readonly enabled: boolean;
    readonly quietHours: ActiveBehaviorPolicy['quietHours'];
    readonly cooldownSeconds: number;
    readonly allowGroupInterjections: boolean;
    readonly followupEnabled: boolean;
    readonly expectedVersion?: number;
  }): Promise<ActiveBehaviorPolicy>;
}

/** Typed product API failure used to classify unavailable capabilities without fake success. */
export class ConversationDomainApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'ConversationDomainApiError';
  }
}

/** User-only evidence from one completed message, passed to real profile extraction. */
export interface ProfileExtractionInput {
  readonly scope: ConversationScope;
  readonly message: Pick<ConversationMessage, 'id' | 'content' | 'occurredAt'>;
  readonly signal: AbortSignal;
}

/** Model-backed profile extraction provider; it returns candidates and never applies them. */
export interface ProfileExtractionProviderV1 {
  readonly apiVersion: 1;
  extract(input: ProfileExtractionInput): Promise<readonly {
    readonly category: ProfileCategory;
    readonly text: string;
    readonly confidence: number;
    readonly validUntil?: number;
  }[]>;
}
