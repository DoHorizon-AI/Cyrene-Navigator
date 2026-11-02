// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 bridge.ts                                                        │
// │  Module: harness/conversation-knowledge/bridge                       │
// │  Role: Call the authenticated Navigator knowledge routes.             │
// │                                                                      │
// │  模块职责：检索已选知识包并在注入上下文/发送前复核来源授权。          │
// │  · 只传查询文本与游标；包、主体、用途均由服务端固定。                 │
// └─────────────────────────────────────────────────────────────────────┘

import type { WorkStateConnection } from '../work-state-client.ts';
import type { TrustedTurnContext } from '../features/conversation-memory.ts';

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_CONTEXT_BYTES = 32_000;

/** One authorized chunk and the exact Catalyst provenance it came from. */
export interface KnowledgeCitation {
  readonly librarySelector: string;
  readonly datasetId: string;
  readonly datasetVersionId: string;
  readonly contentRevisionId: string;
  readonly sourceRevisionId: string;
  readonly sourceId: string;
  readonly blockId: string;
  readonly blockOrdinal: number;
  readonly chunkId: string;
  readonly locator: Readonly<Record<string, unknown>>;
  readonly hierarchyPath: readonly string[];
  readonly assetRefs: readonly Readonly<Record<string, unknown>>[];
}

export interface KnowledgeHit {
  readonly text: string;
  readonly score: number;
  readonly citation: KnowledgeCitation;
}

export interface KnowledgeSearchPage {
  readonly datasetName: string;
  readonly datasetVersion: number;
  readonly packageDigest: string;
  readonly resultDigest: string;
  readonly query: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly nextCursor?: string;
  readonly hits: readonly KnowledgeHit[];
  /** Identity fields the authorize route needs to recheck this exact page. */
  readonly datasetId: string;
  readonly datasetVersionId: string;
  readonly librarySelector: string;
}

export interface KnowledgeAuthorizationReceipt {
  readonly allowed: boolean;
  readonly datasetVersionId: string;
  readonly contentRevisionId: string;
  readonly packageDigest: string;
  readonly resultDigest: string;
  readonly checkedAt: number;
  readonly reasonCode?: string;
}

/** Bounded error without response text or any knowledge content. */
export class ConversationKnowledgeBridgeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, status: number, retryable = false) {
    super(code);
    this.name = 'ConversationKnowledgeBridgeError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface ConversationKnowledgeBridge {
  search(input: {
    readonly query: string;
    readonly limit?: number;
    readonly cursor?: string;
  }, context: TrustedTurnContext): Promise<KnowledgeSearchPage>;
  authorize(page: KnowledgeSearchPage, context: TrustedTurnContext): Promise<KnowledgeAuthorizationReceipt>;
}

/** Authenticated HTTP bridge to the persistence process knowledge routes. */
export class NavigatorConversationKnowledgeHttpBridge implements ConversationKnowledgeBridge {
  private readonly base: URL;

  constructor(private readonly connection: WorkStateConnection) {
    const base = new URL(connection.baseUrl);
    if (base.username || base.password || base.search || base.hash) {
      throw new TypeError('Invalid conversation knowledge API base URL');
    }
    if (base.protocol !== 'https:'
      && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
      throw new TypeError('Remote conversation knowledge API requires HTTPS');
    }
    if (!connection.workspaceId.trim()) throw new TypeError('A configured workspace is required');
    this.base = base;
  }

  async search(
    input: { readonly query: string; readonly limit?: number; readonly cursor?: string },
    context: TrustedTurnContext,
  ): Promise<KnowledgeSearchPage> {
    const limit = input.limit ?? 5;
    if (input.query.trim().length === 0 || new TextEncoder().encode(input.query).byteLength > 4_096
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new ConversationKnowledgeBridgeError('KNOWLEDGE_QUERY_INVALID', 422);
    }
    const payload = await this.post('search', {
      query: input.query,
      limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }, context);
    return decodeSearch(payload, input.query, limit, input.cursor);
  }

  async authorize(
    page: KnowledgeSearchPage,
    context: TrustedTurnContext,
  ): Promise<KnowledgeAuthorizationReceipt> {
    const payload = await this.post('authorize', {
      datasetId: page.datasetId,
      datasetVersionId: page.datasetVersionId,
      librarySelector: page.librarySelector,
      query: page.query,
      limit: page.limit,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      resultDigest: page.resultDigest,
      citations: page.hits.map(hit => hit.citation),
    }, context);
    const receipt = decodeReceipt(payload);
    if (receipt.resultDigest !== page.resultDigest || receipt.datasetVersionId !== page.datasetVersionId) {
      throw new ConversationKnowledgeBridgeError('KNOWLEDGE_RECEIPT_MISMATCH', 502);
    }
    return receipt;
  }

  private async post(route: 'search' | 'authorize', body: unknown, context: TrustedTurnContext): Promise<unknown> {
    context.signal.throwIfAborted();
    const tokenEnv = this.connection.tokenEnv ?? 'CYRENE_SESSION_TOKEN';
    const token = process.env[tokenEnv];
    if (token === undefined || token.length === 0) {
      throw new ConversationKnowledgeBridgeError('KNOWLEDGE_WORK_CREDENTIAL_UNAVAILABLE', 503, true);
    }
    const url = new URL(
      `/api/v1/workspaces/${encodeURIComponent(this.connection.workspaceId)}/work/knowledge/${route}`,
      this.base,
    );
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(this.connection.requestTimeoutMs ?? 15_000)]);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Cyrene-Work-Task-ID': context.taskId,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal,
      });
    } catch (error: unknown) {
      if (context.signal.aborted) throw new ConversationKnowledgeBridgeError('KNOWLEDGE_OPERATION_CANCELLED', 409);
      const timeout = error instanceof DOMException && error.name === 'TimeoutError';
      throw new ConversationKnowledgeBridgeError(timeout ? 'KNOWLEDGE_BRIDGE_TIMEOUT' : 'KNOWLEDGE_BRIDGE_UNAVAILABLE', 503, true);
    }
    const payload = await readBoundedJson(response);
    if (!response.ok) {
      throw new ConversationKnowledgeBridgeError(
        errorCode(payload) ?? `KNOWLEDGE_HTTP_${response.status}`,
        response.status,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    context.signal.throwIfAborted();
    return payload;
  }
}

/**
 * Render a page as model context only after a fresh allowed receipt for that exact page.
 * A denied or mismatched receipt holds the contribution instead of degrading to partial text.
 */
export function knowledgeContextContribution(
  page: KnowledgeSearchPage,
  receipt: KnowledgeAuthorizationReceipt,
): { readonly feature: 'conversation-knowledge.v1'; readonly content: string; readonly citations: readonly KnowledgeCitation[] } {
  if (!receipt.allowed) {
    throw new ConversationKnowledgeBridgeError(receipt.reasonCode ?? 'KNOWLEDGE_SOURCE_NOT_AUTHORIZED', 403);
  }
  if (receipt.resultDigest !== page.resultDigest || receipt.datasetVersionId !== page.datasetVersionId
    || receipt.packageDigest !== page.packageDigest) {
    throw new ConversationKnowledgeBridgeError('KNOWLEDGE_RECEIPT_MISMATCH', 502);
  }
  const lines: string[] = [];
  let bytes = 0;
  const cited: KnowledgeCitation[] = [];
  page.hits.forEach((hit, index) => {
    const line = `[${index + 1}] ${hit.text}`;
    bytes += new TextEncoder().encode(line).byteLength + 1;
    if (bytes > MAX_CONTEXT_BYTES) return;
    lines.push(line);
    cited.push(hit.citation);
  });
  if (lines.length === 0) throw new ConversationKnowledgeBridgeError('KNOWLEDGE_NO_CONTEXT', 404);
  return { feature: 'conversation-knowledge.v1', content: lines.join('\n'), citations: cited };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new ConversationKnowledgeBridgeError('KNOWLEDGE_RESPONSE_LIMIT', 502);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ConversationKnowledgeBridgeError('KNOWLEDGE_RESPONSE_INVALID', 502);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConversationKnowledgeBridgeError('KNOWLEDGE_RESPONSE_INVALID', 502);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, max = 4_096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ConversationKnowledgeBridgeError('KNOWLEDGE_RESPONSE_INVALID', 502);
  }
  return value;
}

function decodeCitation(value: unknown): KnowledgeCitation {
  const row = object(value);
  if (!Number.isSafeInteger(row.blockOrdinal) || Number(row.blockOrdinal) < 0
    || !Array.isArray(row.hierarchyPath) || !Array.isArray(row.assetRefs)) {
    throw new ConversationKnowledgeBridgeError('KNOWLEDGE_RESPONSE_INVALID', 502);
  }
  return {
    librarySelector: text(row.librarySelector, 128),
    datasetId: text(row.datasetId, 64),
    datasetVersionId: text(row.datasetVersionId, 64),
    contentRevisionId: text(row.contentRevisionId, 64),
    sourceRevisionId: text(row.sourceRevisionId, 64),
    sourceId: text(row.sourceId, 64),
    blockId: text(row.blockId, 300),
    blockOrdinal: Number(row.blockOrdinal),
    chunkId: text(row.chunkId, 80),
    locator: object(row.locator),
    hierarchyPath: row.hierarchyPath.map(item => text(item, 1_024)),
    assetRefs: row.assetRefs.map(object),
  };
}

function decodeSearch(value: unknown, query: string, limit: number, cursor: string | undefined): KnowledgeSearchPage {
  const row = object(value);
  const pkg = object(row.package);
  if (row.query !== query || !Array.isArray(row.hits) || row.hits.length > limit
    || row.usePurpose !== 'knowledge_retrieval' || !Number.isSafeInteger(pkg.version)) {
    throw new ConversationKnowledgeBridgeError('KNOWLEDGE_RESPONSE_INVALID', 502);
  }
  const hits = row.hits.map((item): KnowledgeHit => {
    const hit = object(item);
    if (typeof hit.score !== 'number' || !Number.isFinite(hit.score)) {
      throw new ConversationKnowledgeBridgeError('KNOWLEDGE_RESPONSE_INVALID', 502);
    }
    return { text: text(hit.text, 10_000), score: hit.score, citation: decodeCitation(hit.citation) };
  });
  return {
    datasetName: text(pkg.datasetName, 200),
    datasetVersion: Number(pkg.version),
    datasetId: text(pkg.datasetId, 64),
    datasetVersionId: text(pkg.datasetVersionId, 64),
    librarySelector: text(pkg.librarySelector, 128),
    packageDigest: text(row.packageDigest, 80),
    resultDigest: text(row.resultDigest, 80),
    query,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
    ...(typeof row.nextCursor === 'string' ? { nextCursor: row.nextCursor } : {}),
    hits,
  };
}

function decodeReceipt(value: unknown): KnowledgeAuthorizationReceipt {
  const row = object(value);
  if (typeof row.allowed !== 'boolean' || !Number.isSafeInteger(row.checkedAt)) {
    throw new ConversationKnowledgeBridgeError('KNOWLEDGE_RESPONSE_INVALID', 502);
  }
  return {
    allowed: row.allowed,
    datasetVersionId: text(row.datasetVersionId, 64),
    contentRevisionId: text(row.contentRevisionId, 64),
    packageDigest: text(row.packageDigest, 80),
    resultDigest: text(row.resultDigest, 80),
    checkedAt: Number(row.checkedAt),
    ...(typeof row.reasonCode === 'string' ? { reasonCode: row.reasonCode } : {}),
  };
}

function errorCode(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const code = (value as Record<string, unknown>).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(code) ? code : undefined;
}
