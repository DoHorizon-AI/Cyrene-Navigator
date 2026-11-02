// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 verifier.ts                                                      │
// │  Module: harness/conversation-knowledge/verifier                     │
// │  Role: Host-owned recheck of Catalyst knowledge before and at delivery.│
// │                                                                      │
// │  模块职责：宿主在接受知识上下文时、以及发送前，用当前用户身份复核来源。 │
// │  · 过期、撤权、选择变化都会拒绝；插件的说法不被信任。                 │
// └─────────────────────────────────────────────────────────────────────┘

import type {
  ConversationExternalProofVerifier,
} from '../conversation-plugin-hooks.js';
import { authorizationBodyFromPage, decodeCitation, decodeReceipt } from './bridge.ts';
import type { KnowledgeAuthorizationBody } from './bridge.ts';

export const KNOWLEDGE_PROOF_KIND = 'catalyst-knowledge.v1';
const MAX_CITATIONS = 100;

/**
 * Build the verifier the executor registers for knowledge contributions.
 *
 * The plugin supplies the authorization body for the page it retrieved. The host decodes it
 * strictly, drops unknown fields, and asks the Work server to recheck the selected package
 * and every cited block with the turn's own actor. Only an allowed receipt for the same
 * result digest and DatasetVersion passes. This establishes that the cited sources are
 * currently authorized, not that the plugin's text equals those blocks; plugins are
 * reviewed first-party code, and the Work server rechecks sources after ranking.
 */
export function createKnowledgeProofVerifier(): ConversationExternalProofVerifier {
  return {
    async verify(context, evidence, work) {
      if (work === undefined) return { allowed: false, code: 'KNOWLEDGE_VERIFIER_UNAVAILABLE' };
      const body = decodeEvidence(evidence);
      if (body === undefined) return { allowed: false, code: 'KNOWLEDGE_EVIDENCE_INVALID' };
      const receipt = decodeReceipt(await work({
        method: 'POST',
        path: '/knowledge/authorize',
        body,
        taskId: context.taskId,
        signal: context.signal,
      }));
      if (!receipt.allowed) {
        return { allowed: false, code: receipt.reasonCode ?? 'KNOWLEDGE_SOURCE_NOT_AUTHORIZED' };
      }
      if (receipt.resultDigest !== body.resultDigest || receipt.datasetVersionId !== body.datasetVersionId) {
        return { allowed: false, code: 'KNOWLEDGE_RECEIPT_MISMATCH' };
      }
      return { allowed: true };
    },
  };
}

function decodeEvidence(value: unknown): KnowledgeAuthorizationBody | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const citations = row.citations;
  if (typeof row.datasetId !== 'string' || typeof row.datasetVersionId !== 'string'
    || typeof row.librarySelector !== 'string' || typeof row.query !== 'string'
    || row.query.trim().length === 0 || new TextEncoder().encode(row.query).byteLength > 4_096
    || !Number.isSafeInteger(row.limit) || Number(row.limit) < 1 || Number(row.limit) > 20
    || (row.cursor !== undefined && (typeof row.cursor !== 'string' || row.cursor.length === 0 || row.cursor.length > 1_024))
    || typeof row.resultDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(row.resultDigest)
    || !Array.isArray(citations) || citations.length === 0 || citations.length > MAX_CITATIONS) {
    return undefined;
  }
  try {
    return authorizationBodyFromPage({
      datasetName: 'unused',
      datasetVersion: 1,
      packageDigest: 'unused',
      resultDigest: row.resultDigest,
      query: row.query,
      limit: Number(row.limit),
      ...(row.cursor === undefined ? {} : { cursor: row.cursor as string }),
      hits: citations.map(citation => ({ text: 'unused', score: 0, citation: decodeCitation(citation) })),
      datasetId: row.datasetId,
      datasetVersionId: row.datasetVersionId,
      librarySelector: row.librarySelector,
    });
  } catch {
    return undefined;
  }
}
