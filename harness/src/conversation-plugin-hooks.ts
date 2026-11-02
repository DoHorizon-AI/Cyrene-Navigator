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

/** One context contribution a plugin proposes; it has no effect until the host authorizes it. */
export interface ConversationPluginProposal {
  readonly featureId: string;
  readonly content: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
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
    const proof = await authorizeConversationSourcesV1(api, context, proposal.sourceRefs);
    if (proof.currentAuthorizationEpoch !== context.authorizationEpoch) {
      held.push({ featureId, code: 'AUTHORIZATION_EPOCH_CHANGED' });
      continue;
    }
    if (!proof.allowed) {
      held.push({ featureId, code: 'SOURCE_NOT_AUTHORIZED' });
      continue;
    }
    // The delivery proof is written by the host, never by the plugin.
    recordConversationContextSourcesV1(context, proposal.featureId, proposal.sourceRefs);
    claimed.add(proposal.featureId);
    contributions.push({
      featureId: proposal.featureId,
      content: proposal.content,
      sourceRefs: proposal.sourceRefs,
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
  if (!Array.isArray(proposal.sourceRefs) || proposal.sourceRefs.length === 0) {
    return 'PLUGIN_SOURCE_REFS_REQUIRED';
  }
  return null;
}
