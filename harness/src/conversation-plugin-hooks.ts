// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 conversation-plugin-hooks.ts                                     │
// │  Module: harness/conversation-plugin-hooks                           │
// │  Role: Let dynamic plugins propose conversation context; host decides.│
// │                                                                      │
// │  模块职责：动态插件只能"提议"上下文贡献，授权与送达证明始终由宿主完成。│
// │  · 插件无权写入送达证明，也不能冒用内置功能 ID。                      │
// └─────────────────────────────────────────────────────────────────────┘

import type { Context } from '@deepseek-ai/cordis';
import {
  authorizeConversationSourcesV1,
  recordConversationContextSourcesV1,
} from './features/conversation-memory.js';
import type {
  ConversationMemoryApiV1,
  ConversationMessageAttachment,
  ConversationSourceRef,
  TrustedTurnContext,
} from './features/conversation-memory.js';

/** Plugin feature IDs live in their own namespace; built-in IDs can never be claimed. */
const PLUGIN_FEATURE_ID = /^plugin\.[a-z0-9][a-z0-9-]{0,47}\.v[0-9]{1,3}$/u;
const MAX_PROPOSALS_PER_TURN = 8;
const MAX_CONTENT_BYTES = 32_000;
/** Route families a plugin may call; everything else under Work stays host-only. */
const PLUGIN_WORK_PATHS = /^\/(?:conversation-media|knowledge)\/[a-z][a-z-]{0,31}$/u;
const MAX_WORK_REQUEST_BYTES = 64_000;
const MAX_WORK_RESPONSE_BYTES = 1_000_000;
const MAX_WORK_CALLS_PER_TURN = 32;

/** Provenance that is not a Work message (for example a Catalyst knowledge page). */
export interface ConversationExternalProof {
  readonly kind: string;
  readonly evidence: unknown;
}

/**
 * Host-owned check for one external provenance kind. It runs when a proposal is accepted
 * and again immediately before delivery, so a stale or revoked source holds the reply.
 * It receives the turn's actor-scoped Work transport; it never trusts the plugin's word.
 */
export interface ConversationExternalProofVerifier {
  verify(
    context: TrustedTurnContext,
    evidence: unknown,
    work: ConversationPluginWorkTransport | undefined,
  ): Promise<{ readonly allowed: boolean; readonly code?: string }>;
}

export type ConversationExternalProofVerifiers = ReadonlyMap<string, ConversationExternalProofVerifier>;

/** One context contribution a plugin proposes; it has no effect until the host authorizes it. */
export interface ConversationPluginProposal {
  readonly featureId: string;
  readonly content: string;
  /** Work-message provenance; may be empty only when an `externalProof` is supplied. */
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly externalProof?: ConversationExternalProof;
}

/** One JSON call to an allowlisted Work route, made as the turn's own actor. */
export interface ConversationPluginWorkRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
}

/** Host-built transport for one turn; the plugin never sees a credential or a base URL. */
export type ConversationPluginWorkTransport = (
  request: ConversationPluginWorkRequest & { readonly taskId: string; readonly signal: AbortSignal },
) => Promise<unknown>;

/** Read-only turn facts handed to plugins. It carries neither tokens nor the Work API. */
export interface ConversationContextHookPayload {
  readonly scope: {
    readonly workspaceId: string;
    readonly actorId: string;
    readonly conversationId: string;
    readonly conversationKind: string;
    readonly personaId: string | null;
    readonly taskId: string;
    readonly sessionId: string;
  };
  readonly signal: AbortSignal;
  readonly messageId: string;
  readonly query: string;
  readonly attachments: readonly ConversationMessageAttachment[];
  /**
   * Allowlisted Work calls as this turn's actor. Absent when the host has no actor-scoped
   * Work client (for example in test mode); a plugin must then stay idle.
   */
  readonly work?: {
    request(request: ConversationPluginWorkRequest): Promise<unknown>;
  };
  /** Propose one contribution; invalid or unauthorized proposals are dropped by the host. */
  contribute(proposal: ConversationPluginProposal): void;
}

/** A plugin contribution the host has authorized and recorded for the delivery gate. */
export interface AuthorizedPluginContribution {
  readonly featureId: string;
  readonly content: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly externalProofs: readonly ConversationExternalProof[];
}

export interface PluginContextOutcome {
  readonly contributions: readonly AuthorizedPluginContribution[];
  /** Typed reasons for proposals or listeners that were held; never contains content. */
  readonly held: readonly { readonly featureId: string | null; readonly code: string }[];
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'navigator/conversation-context'(payload: ConversationContextHookPayload): void | Promise<void>;
  }
}

/**
 * Emit the context hook and keep only proposals the host can authorize.
 *
 * A plugin failure never fails the user's turn and never produces partial context; it is
 * reported as a held outcome. A cancelled turn is the only condition that propagates.
 */
export async function collectPluginContributions(
  ctx: Context,
  api: ConversationMemoryApiV1,
  context: TrustedTurnContext,
  input: {
    readonly messageId: string;
    readonly query: string;
    readonly attachments: readonly ConversationMessageAttachment[];
    readonly requestWork?: ConversationPluginWorkTransport;
  },
  options: { readonly verifiers?: ConversationExternalProofVerifiers } = {},
): Promise<PluginContextOutcome> {
  context.signal.throwIfAborted();
  const proposals: ConversationPluginProposal[] = [];
  const held: { featureId: string | null; code: string }[] = [];
  let closed = false;
  let workCalls = 0;
  const transport = input.requestWork;
  const work = transport === undefined ? undefined : Object.freeze({
    async request(request: ConversationPluginWorkRequest): Promise<unknown> {
      if (closed) throw new TypeError('The conversation context hook is closed');
      workCalls += 1;
      if (workCalls > MAX_WORK_CALLS_PER_TURN) throw new TypeError('Plugin Work call limit reached');
      if (request === null || typeof request !== 'object'
        || (request.method !== 'GET' && request.method !== 'POST')
        || typeof request.path !== 'string' || !PLUGIN_WORK_PATHS.test(request.path)) {
        throw new TypeError('Plugin Work path is not allowed');
      }
      const body = request.body;
      if (body !== undefined && new TextEncoder().encode(JSON.stringify(body) ?? '').byteLength > MAX_WORK_REQUEST_BYTES) {
        throw new TypeError('Plugin Work request body is too large');
      }
      context.signal.throwIfAborted();
      const result = await transport({
        method: request.method,
        path: request.path,
        ...(body === undefined ? {} : { body }),
        taskId: context.taskId,
        signal: context.signal,
      });
      if (new TextEncoder().encode(JSON.stringify(result) ?? '').byteLength > MAX_WORK_RESPONSE_BYTES) {
        throw new TypeError('Plugin Work response is too large');
      }
      return result;
    },
  });
  const payload: ConversationContextHookPayload = Object.freeze({
    scope: Object.freeze({
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      conversationId: context.conversationId,
      conversationKind: context.conversationKind,
      personaId: context.personaId,
      taskId: context.taskId,
      sessionId: context.sessionId,
    }),
    signal: context.signal,
    messageId: input.messageId,
    query: input.query,
    attachments: Object.freeze([...input.attachments]),
    ...(work === undefined ? {} : { work }),
    contribute(proposal: ConversationPluginProposal): void {
      if (closed) {
        held.push({ featureId: null, code: 'PLUGIN_CONTRIBUTION_AFTER_CLOSE' });
        return;
      }
      if (proposals.length >= MAX_PROPOSALS_PER_TURN) {
        held.push({ featureId: null, code: 'PLUGIN_PROPOSAL_LIMIT' });
        return;
      }
      proposals.push(proposal);
    },
  });

  try {
    await ctx.parallel('navigator/conversation-context', payload);
  } catch (error: unknown) {
    if (context.signal.aborted) throw error;
    held.push({ featureId: null, code: 'PLUGIN_LISTENER_FAILED' });
  } finally {
    closed = true;
  }
  context.signal.throwIfAborted();

  const contributions: AuthorizedPluginContribution[] = [];
  const claimed = new Set<string>();
  for (const proposal of proposals) {
    const featureId = typeof proposal?.featureId === 'string' ? proposal.featureId : null;
    const code = validateProposal(proposal, claimed);
    if (code !== null) {
      held.push({ featureId, code });
      continue;
    }
    if (proposal.sourceRefs.length > 0) {
      const proof = await authorizeConversationSourcesV1(api, context, proposal.sourceRefs);
      if (proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
        held.push({ featureId, code: 'AUTHORIZATION_EPOCH_CHANGED' });
        continue;
      }
      if (!proof.allowed) {
        held.push({ featureId, code: 'SOURCE_NOT_AUTHORIZED' });
        continue;
      }
    }
    const externalProofs: ConversationExternalProof[] = [];
    if (proposal.externalProof !== undefined) {
      const verdict = await checkExternalProof(options.verifiers, context, proposal.externalProof, transport);
      if (verdict !== 'allow') {
        held.push({ featureId, code: verdict });
        continue;
      }
      externalProofs.push(proposal.externalProof);
    }
    // The delivery proof is written by the host, never by the plugin.
    if (proposal.sourceRefs.length > 0) {
      recordConversationContextSourcesV1(context, proposal.featureId, proposal.sourceRefs);
    }
    claimed.add(proposal.featureId);
    contributions.push({
      featureId: proposal.featureId,
      content: proposal.content,
      sourceRefs: proposal.sourceRefs,
      externalProofs,
    });
  }
  return { contributions, held };
}

function validateProposal(proposal: ConversationPluginProposal, claimed: ReadonlySet<string>): string | null {
  if (proposal === null || typeof proposal !== 'object'
    || typeof proposal.featureId !== 'string' || !PLUGIN_FEATURE_ID.test(proposal.featureId)) {
    return 'PLUGIN_FEATURE_ID_INVALID';
  }
  if (claimed.has(proposal.featureId)) return 'PLUGIN_FEATURE_ID_DUPLICATE';
  if (typeof proposal.content !== 'string' || proposal.content.trim().length === 0
    || new TextEncoder().encode(proposal.content).byteLength > MAX_CONTENT_BYTES) {
    return 'PLUGIN_CONTENT_INVALID';
  }
  // A contribution without exact provenance can never be revalidated at delivery.
  if (!Array.isArray(proposal.sourceRefs)) return 'PLUGIN_SOURCE_REFS_REQUIRED';
  const external = proposal.externalProof;
  if (external !== undefined
    && (external === null || typeof external !== 'object' || typeof external.kind !== 'string'
      || !/^[a-z][a-z0-9.-]{0,63}$/u.test(external.kind))) {
    return 'PLUGIN_EXTERNAL_PROOF_INVALID';
  }
  if (proposal.sourceRefs.length === 0 && external === undefined) {
    return 'PLUGIN_SOURCE_REFS_REQUIRED';
  }
  return null;
}

/** Ask the host-owned verifier for one external proof; any failure is a hold, never an allow. */
async function checkExternalProof(
  verifiers: ConversationExternalProofVerifiers | undefined,
  context: TrustedTurnContext,
  proof: ConversationExternalProof,
  transport: ConversationPluginWorkTransport | undefined,
): Promise<'allow' | string> {
  const verifier = verifiers?.get(proof.kind);
  if (verifier === undefined) return 'PLUGIN_EXTERNAL_VERIFIER_UNAVAILABLE';
  try {
    const verdict = await verifier.verify(context, proof.evidence, transport);
    return verdict.allowed ? 'allow' : (verdict.code ?? 'EXTERNAL_SOURCE_NOT_AUTHORIZED');
  } catch {
    context.signal.throwIfAborted();
    return 'EXTERNAL_PROOF_UNAVAILABLE';
  }
}

/**
 * Recheck every external proof an accepted contribution carried, immediately before delivery.
 * Returns `allow` or the first typed hold code.
 */
export async function recheckExternalProofs(
  verifiers: ConversationExternalProofVerifiers | undefined,
  context: TrustedTurnContext,
  proofs: readonly ConversationExternalProof[],
  transport: ConversationPluginWorkTransport | undefined,
): Promise<'allow' | string> {
  for (const proof of proofs) {
    const verdict = await checkExternalProof(verifiers, context, proof, transport);
    if (verdict !== 'allow') return verdict;
  }
  return 'allow';
}
