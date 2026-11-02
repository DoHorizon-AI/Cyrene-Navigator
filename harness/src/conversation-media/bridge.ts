// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 bridge.ts                                                        │
// │  Module: harness/conversation-media/bridge                           │
// │  Role: Call the authenticated Navigator media analysis route.         │
// │                                                                      │
// │  模块职责：把当前 Work 消息的 opaque artifact 发给本地 media API。    │
// │  · 不传原始字节、身份、来源列表、URL 或文件路径。                     │
// └─────────────────────────────────────────────────────────────────────┘

import type { WorkStateConnection } from '../work-state-client.ts';
import type { TrustedTurnContext, ConversationSourceRef } from '../features/conversation-memory.ts';

export type ConversationMediaOperation = 'transcribe' | 'describe_image';

/** Metadata read back from the current canonical Work user message. */
export interface ConversationMediaAttachment {
  readonly artifactId: string;
  readonly sha256: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
}

/** A media-derived context contribution with exact canonical source references. */
export interface MediaContextContribution {
  readonly feature: 'conversation-media.v1';
  readonly content: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
}

export type MediaAnalysisResponse =
  | { readonly status: 'no_speech'; readonly contribution: null }
  | { readonly status: 'contributed'; readonly contribution: MediaContextContribution };

/** Bounded provider error without any response text or attachment content. */
export class ConversationMediaBridgeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, status: number, retryable = false) {
    super(code);
    this.name = 'ConversationMediaBridgeError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/** Narrow bridge used by the DSH context adapter; sending remains a separate host action. */
export interface ConversationMediaBridge {
  analyze(input: {
    readonly messageId: string;
    readonly artifact: ConversationMediaAttachment;
    readonly operation: ConversationMediaOperation;
    readonly prompt?: string;
  }, context: TrustedTurnContext): Promise<MediaAnalysisResponse>;
}

/**
 * Authenticated HTTP bridge to the persistence process media route.
 *
 * The Work token is read by its configured server-side environment reference. Only the
 * current Work message ID and its content-addressed artifact ID cross this boundary.
 */
export class NavigatorConversationMediaHttpBridge implements ConversationMediaBridge {
  private readonly endpoint: URL;

  constructor(private readonly connection: WorkStateConnection) {
    const base = new URL(connection.baseUrl);
    if (base.username || base.password || base.search || base.hash) {
      throw new TypeError('Invalid conversation media API base URL');
    }
    if (base.protocol !== 'https:'
      && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
      throw new TypeError('Remote conversation media API requires HTTPS');
    }
    if (!connection.workspaceId.trim()) throw new TypeError('A configured workspace is required');
    this.endpoint = new URL(
      `/api/v1/workspaces/${encodeURIComponent(connection.workspaceId)}/work/conversation-media/analyze`,
      base,
    );
  }

  /** Send one opaque reference through the task-bound route and decode only a contribution. */
  async analyze(
    input: {
      readonly messageId: string;
      readonly artifact: ConversationMediaAttachment;
      readonly operation: ConversationMediaOperation;
      readonly prompt?: string;
    },
    context: TrustedTurnContext,
  ): Promise<MediaAnalysisResponse> {
    context.signal.throwIfAborted();
    validateRequest(input);
    const tokenEnv = this.connection.tokenEnv ?? 'CYRENE_SESSION_TOKEN';
    const token = process.env[tokenEnv];
    if (token === undefined || token.length === 0) {
      throw new ConversationMediaBridgeError('MEDIA_WORK_CREDENTIAL_UNAVAILABLE', 503, true);
    }
    const timeoutSignal = AbortSignal.timeout(this.connection.requestTimeoutMs ?? 10_000);
    const signal = AbortSignal.any([context.signal, timeoutSignal]);
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Cyrene-Work-Task-ID': context.taskId,
        },
        body: JSON.stringify({
          messageId: input.messageId,
          artifactId: input.artifact.artifactId,
          operation: input.operation,
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        }),
        redirect: 'error',
        signal,
      });
    } catch (error: unknown) {
      if (context.signal.aborted) {
        throw new ConversationMediaBridgeError('MEDIA_OPERATION_CANCELLED', 409);
      }
      const code = error instanceof DOMException && error.name === 'TimeoutError'
        ? 'MEDIA_BRIDGE_TIMEOUT'
        : 'MEDIA_BRIDGE_UNAVAILABLE';
      throw new ConversationMediaBridgeError(code, 503, true);
    }
    const payload = await readBoundedJson(response);
    if (!response.ok) {
      throw new ConversationMediaBridgeError(
        errorCode(payload) ?? `MEDIA_ANALYSIS_HTTP_${response.status}`,
        response.status,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    context.signal.throwIfAborted();
    return decodeAnalysisResponse(payload);
  }
}

function validateRequest(input: {
  readonly messageId: string;
  readonly artifact: ConversationMediaAttachment;
  readonly operation: ConversationMediaOperation;
  readonly prompt?: string;
}): void {
  if (input.messageId.trim().length === 0 || input.messageId.length > 512) {
    throw new ConversationMediaBridgeError('MEDIA_MESSAGE_ID_INVALID', 422);
  }
  if (!/^[0-9a-f]{64}$/u.test(input.artifact.artifactId)
    || input.artifact.sha256 !== input.artifact.artifactId
    || !Number.isSafeInteger(input.artifact.size)
    || input.artifact.size < 1
    || input.artifact.size > 10_000_000) {
    throw new ConversationMediaBridgeError('MEDIA_ATTACHMENT_METADATA_INVALID', 422);
  }
  if (input.prompt !== undefined && new TextEncoder().encode(input.prompt).byteLength > 4_096) {
    throw new ConversationMediaBridgeError('MEDIA_PROMPT_LIMIT', 413);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > 256_000) {
    throw new ConversationMediaBridgeError('MEDIA_RESPONSE_LIMIT', 502);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 256_000) {
    throw new ConversationMediaBridgeError('MEDIA_RESPONSE_LIMIT', 502);
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ConversationMediaBridgeError('MEDIA_RESPONSE_INVALID', 502);
  }
}

/** Strictly decode a media analysis response; shared by the HTTP bridge and plugins. */
export function decodeAnalysisResponse(value: unknown): MediaAnalysisResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConversationMediaBridgeError('MEDIA_RESPONSE_INVALID', 502);
  }
  const row = value as Record<string, unknown>;
  if (row.status === 'no_speech' && (row.contribution === null || row.contribution === undefined)) {
    return { status: 'no_speech', contribution: null };
  }
  if (row.status !== 'contributed' || row.contribution === null
    || typeof row.contribution !== 'object' || Array.isArray(row.contribution)) {
    throw new ConversationMediaBridgeError('MEDIA_RESPONSE_INVALID', 502);
  }
  const contribution = row.contribution as Record<string, unknown>;
  if (contribution.feature !== 'conversation-media.v1'
    || typeof contribution.content !== 'string'
    || contribution.content.trim().length === 0
    || new TextEncoder().encode(contribution.content).byteLength > 32_000
    || !Array.isArray(contribution.sourceRefs)
    || contribution.sourceRefs.length === 0
    || contribution.sourceRefs.length > 256) {
    throw new ConversationMediaBridgeError('MEDIA_RESPONSE_INVALID', 502);
  }
  const sourceRefs = contribution.sourceRefs.map(decodeSourceRef);
  return {
    status: 'contributed',
    contribution: {
      feature: 'conversation-media.v1',
      content: contribution.content,
      sourceRefs,
    },
  };
}

function decodeSourceRef(value: unknown): ConversationSourceRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConversationMediaBridgeError('MEDIA_RESPONSE_INVALID', 502);
  }
  const row = value as Record<string, unknown>;
  const memoryId = row.memoryId;
  const memoryVersion = row.memoryVersion;
  const sourceMessageIds = row.sourceMessageIds;
  if ((memoryId !== null && typeof memoryId !== 'string')
    || (memoryVersion !== null && (!Number.isSafeInteger(memoryVersion) || Number(memoryVersion) < 1))
    || ((memoryId === null) !== (memoryVersion === null))
    || !Array.isArray(sourceMessageIds)
    || sourceMessageIds.length > 128
    || sourceMessageIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 512)
    || (memoryId === null && sourceMessageIds.length === 0)) {
    throw new ConversationMediaBridgeError('MEDIA_RESPONSE_INVALID', 502);
  }
  return {
    memoryId: memoryId as string | null,
    memoryVersion: memoryVersion as number | null,
    sourceMessageIds: sourceMessageIds as string[],
  };
}

function errorCode(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const code = (value as Record<string, unknown>).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(code) ? code : undefined;
}
