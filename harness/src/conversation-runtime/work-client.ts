// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Conversation Runtime Work HTTP client                       │
// │ Role: Use fixed actor Work APIs with bounded response validation.   │
// │ 模块职责：通过固定的 actor Work API 执行有界请求与响应校验。          │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';
import { canonicalJson } from '../connector-authorization.ts';

const MAX_JSON_BYTES = 2_000_000;
const MAX_MESSAGES = 20_000;
const MAX_HISTORY_PAGES = Math.ceil(MAX_MESSAGES / 100);
const REQUEST_TIMEOUT_MS = 15_000;
const DIGEST = /^[0-9a-f]{64}$/u;

export type ConversationKind = 'direct' | 'group' | 'channel';

/** Exact P2 source lineage; IDs are always host-derived from a TrustedTurnContext. */
export interface ConversationSourceRef {
  readonly memoryId: string | null;
  readonly memoryVersion: number | null;
  readonly sourceMessageIds: readonly string[];
}

/** Actor and current Work task are resolved by the host, never model arguments. */
export interface RuntimeWorkContext {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly conversationId: string;
  readonly conversationKind: ConversationKind;
  readonly personaId: string | null;
  readonly authorizationEpoch: number;
  readonly taskId: string;
  readonly sessionId: string;
  readonly origin?: {
    readonly kind: string;
    readonly sourceId: string;
    readonly externalEventId: string;
  };
  readonly signal: AbortSignal;
}

export interface WorkAttachmentRef {
  readonly artifactId: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly size: number;
}

export interface ConversationMessageRecord {
  readonly id: string;
  readonly eventId: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly status: 'active' | 'revoked';
  readonly scope: {
    readonly conversationId: string;
    readonly conversationKind: ConversationKind;
    readonly personaId: string | null;
    readonly visibility: string;
  };
  readonly attachments: readonly WorkAttachmentRef[];
}

export interface ConversationRuntimeReadResult {
  readonly operationId: string;
  readonly title: string;
  readonly content: string;
  readonly resultSha256: string;
  readonly contentSha256: string;
  readonly sourceEvidence: readonly ResearchSourceEvidence[];
  readonly artifactId: string;
}

/** Server-derived ResearchOperationReceiptV1, including current Work provenance. */
export interface ConversationResearchOperationReceipt {
  readonly id: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly taskId: string;
  readonly taskStatus: 'completed';
  readonly taskOutputSha256: string;
  readonly status: 'verified';
  readonly operationType: 'conversation.research.read.v1';
  readonly effect: 'read';
  readonly resultSha256: string;
  readonly contentSha256: string;
  readonly targetDigestSha256: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly sourceEvidence: readonly ResearchSourceEvidence[];
  readonly verifiedAt: number;
}

export interface ResearchSourceEvidence {
  readonly sourceRef: string;
  readonly kind: 'web' | 'document';
  readonly title: string;
  readonly url?: string;
  readonly artifactId?: string;
  readonly sourceSha256: string;
  readonly retrievedAt: string;
}

export interface WorkCredentialResolver {
  /** Return the Work API token pre-bound to this exact actor and Workspace. */
  tokenFor(context: Pick<RuntimeWorkContext, 'workspaceId' | 'actorId'>): string;
}

export interface WorkOperationRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly operationType: string;
  readonly taskId: string | null;
  readonly target: string | null;
  readonly request: Readonly<Record<string, unknown>>;
  readonly status: 'started' | 'uncertain' | 'verified';
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly trustedProducer?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BiliOperationLookupV1 {
  readonly operation: WorkOperationRecord;
  readonly resultArtifact?: WorkAttachmentRef;
}

export interface WorkNotificationRecord {
  readonly id: string;
  readonly deduplicationKey: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly taskId: string | null;
  readonly connectorId: string | null;
  readonly recipient: string | null;
  readonly status: 'queued' | 'leased' | 'started' | 'uncertain' | 'delivered' | 'failed';
  readonly availableAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface RuntimeWorkTaskRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly createdByActorId: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted' | string;
  readonly output: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type BiliDomainRoute =
  | 'delegations.list'
  | 'delegations.create'
  | 'delegations.get'
  | 'delegations.authorize'
  | 'delegations.revoke'
  | 'subscriptions.list'
  | 'subscriptions.create'
  | 'subscriptions.get'
  | 'subscriptions.claim'
  | 'subscriptions.recordCheck'
  | 'subscriptions.authorizeNotification'
  | 'subscriptions.transition';

const BILIBILI_READ_OPERATIONS = new Set([
  'bilibili.search', 'bilibili.user.find', 'bilibili.video.read', 'bilibili.comments.list',
  'bilibili.dynamics.list', 'bilibili.dynamic.read', 'bilibili.dm.list', 'bilibili.dm.read',
]);
const BILIBILI_WRITE_OPERATIONS = new Set([
  'bilibili.comment.create', 'bilibili.dynamic.publish', 'bilibili.dm.send',
]);

export class WorkRuntimeHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'WorkRuntimeHttpError';
  }
}

/** Authenticated client with a fixed Work origin and actor credential source. */
export class ConversationRuntimeWorkClient {
  private readonly root: string;

  constructor(
    baseUrl: string,
    private readonly workspaceId: string,
    private readonly credentials: WorkCredentialResolver,
  ) {
    const origin = new URL(baseUrl);
    if (origin.username || origin.password || origin.search || origin.hash
      || !['https:', 'http:'].includes(origin.protocol)) {
      throw new TypeError('Invalid Work API origin');
    }
    if (origin.protocol === 'http:' && !isLoopbackHost(origin.hostname)) {
      throw new TypeError('Work API must use HTTPS outside loopback');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(workspaceId)) {
      throw new TypeError('Invalid configured Workspace');
    }
    this.root = `${baseUrl.replace(/\/+$/u, '')}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/work`;
  }

  async readResearch(
    context: RuntimeWorkContext,
    input: {
      readonly childTaskId: string;
      readonly parentTaskId: string;
      readonly parentSessionId: string;
      readonly sourceRefs: readonly ConversationSourceRef[];
      readonly query: string;
      readonly attachmentIds: readonly string[];
    },
  ): Promise<ConversationRuntimeReadResult> {
    this.assertContext(context);
    const value = await this.request(context, '/conversation-runtime/research/read', 'POST', {
      taskId: boundedId(input.childTaskId, 'child Task ID'),
      parentTaskId: boundedId(input.parentTaskId, 'parent Task ID'),
      parentSessionId: boundedId(input.parentSessionId, 'parent Session ID'),
      conversationId: boundedId(context.conversationId, 'conversation ID'),
      conversationKind: context.conversationKind,
      personaId: context.personaId,
      authorizationEpoch: safeInteger(context.authorizationEpoch, 'authorization epoch'),
      sourceRefs: validateSourceRefs(input.sourceRefs),
      query: boundedText(input.query, 'research query', 2_000),
      attachmentIds: input.attachmentIds.map(digest => checkedDigest(digest, 'attachment id')),
    }, context.signal);
    return decodeResearchResult(value);
  }

  async readResearchOperationReceipt(
    context: RuntimeWorkContext,
    operationId: string,
  ): Promise<ConversationResearchOperationReceipt> {
    this.assertContext(context);
    const id = boundedId(operationId, 'Work operation ID');
    const value = await this.request(
      context,
      `/conversation-runtime/operations/${encodeURIComponent(id)}/receipt`,
      'POST',
      {
        parentTaskId: context.taskId,
        parentSessionId: context.sessionId,
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        personaId: context.personaId,
        authorizationEpoch: safeInteger(context.authorizationEpoch, 'authorization epoch'),
        sourceRefs: [],
      },
      context.signal,
    );
    return decodeResearchReceipt(value, context, id);
  }

  async listConversationMessages(
    context: RuntimeWorkContext,
    sourceRefs: readonly ConversationSourceRef[],
  ): Promise<readonly ConversationMessageRecord[]> {
    this.assertContext(context);
    const wanted = new Set(validateSourceRefs(sourceRefs).flatMap(ref => ref.sourceMessageIds));
    const found = new Map<string, ConversationMessageRecord>();
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex += 1) {
      context.signal.throwIfAborted();
      const query = new URLSearchParams({
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        order: 'desc',
        limit: '100',
      });
      if (context.personaId !== null) query.set('personaId', context.personaId);
      if (cursor !== undefined) query.set('cursor', cursor);
      const page = await this.readConversationMessagePage(context, query, context.signal);
      if (!Array.isArray(page.items) || page.items.length > 100) throw new TypeError('Invalid Work message page');
      for (const raw of page.items) {
        const message = decodeMessage(raw);
        if (message.status === 'active'
          && message.scope.conversationId === context.conversationId
          && message.scope.conversationKind === context.conversationKind
          && message.scope.personaId === context.personaId
          && wanted.has(message.id)) {
          found.set(message.id, message);
        }
      }
      if ([...wanted].every(id => found.has(id))) return [...found.values()];
      const next = page.nextCursor;
      if (next === null || next === undefined) break;
      if (typeof next !== 'string' || next.length === 0 || next.length > 600
        || next === cursor || seenCursors.has(next)) {
        throw new WorkRuntimeHttpError(502, 'WORK_MESSAGE_CURSOR_INVALID');
      }
      cursor = next;
      seenCursors.add(next);
    }
    if (found.size !== wanted.size) throw new WorkRuntimeHttpError(404, 'WORK_SOURCE_MESSAGE_NOT_FOUND');
    return [...found.values()];
  }

  async resolveCurrentTurnSourceRefs(context: RuntimeWorkContext): Promise<readonly ConversationSourceRef[]> {
    this.assertContext(context);
    const eventId = context.origin?.externalEventId;
    if (!eventId) throw new WorkRuntimeHttpError(409, 'CONVERSATION_ORIGIN_REQUIRED');
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex += 1) {
      context.signal.throwIfAborted();
      const query = new URLSearchParams({
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        order: 'desc',
        limit: '100',
      });
      if (context.personaId !== null) query.set('personaId', context.personaId);
      if (cursor !== undefined) query.set('cursor', cursor);
      const page = await this.readConversationMessagePage(context, query, context.signal);
      for (const raw of page.items) {
        const message = decodeMessage(raw);
        if (message.eventId === eventId && message.role === 'user' && message.status === 'active'
          && message.scope.conversationId === context.conversationId
          && message.scope.conversationKind === context.conversationKind
          && message.scope.personaId === context.personaId) {
          return [{ memoryId: null, memoryVersion: null, sourceMessageIds: [message.id] }];
        }
      }
      const next = page.nextCursor;
      if (next === null) break;
      if (next === cursor || seenCursors.has(next)) throw new WorkRuntimeHttpError(502, 'WORK_MESSAGE_CURSOR_INVALID');
      cursor = next;
      seenCursors.add(next);
    }
    throw new WorkRuntimeHttpError(404, 'CONVERSATION_ORIGIN_MESSAGE_NOT_FOUND');
  }

  async authorizeSources(
    context: RuntimeWorkContext,
    sourceRefs: readonly ConversationSourceRef[],
  ): Promise<void> {
    this.assertContext(context);
    const value = object(await this.request(context, '/conversation-memory/sources/authorize', 'POST', {
      conversationId: context.conversationId,
      conversationKind: context.conversationKind,
      personaId: context.personaId,
      authorizationEpoch: context.authorizationEpoch,
      sourceRefs: validateSourceRefs(sourceRefs),
    }, context.signal), 'source authorization');
    if (value.allowed !== true || value.currentAuthorizationEpoch !== context.authorizationEpoch) {
      throw new WorkRuntimeHttpError(409, 'CONVERSATION_SOURCE_REVOKED');
    }
  }

  async authorizeConversationArtifact(
    context: RuntimeWorkContext,
    sourceRefs: readonly ConversationSourceRef[],
    attachment: WorkAttachmentRef,
  ): Promise<void> {
    this.assertContext(context);
    const digest = checkedDigest(attachment.artifactId, 'attachment id');
    if (attachment.sha256 !== digest || !Number.isSafeInteger(attachment.size)
      || attachment.size < 1 || attachment.size > 10_000_000) {
      throw new TypeError('Invalid Work attachment reference');
    }
    const value = object(await this.request(context, '/conversation-memory/artifacts/authorize', 'POST', {
      artifactId: digest,
      conversationId: context.conversationId,
      conversationKind: context.conversationKind,
      personaId: context.personaId,
      authorizationEpoch: context.authorizationEpoch,
      sourceRefs: validateSourceRefs(sourceRefs),
    }, context.signal), 'artifact authorization');
    if (value.allowed !== true || value.currentAuthorizationEpoch !== context.authorizationEpoch) {
      throw new WorkRuntimeHttpError(409, 'CONVERSATION_ARTIFACT_REVOKED');
    }
    const artifact = object(value.artifact, 'authorized artifact');
    if (artifact.artifactId !== digest || artifact.sha256 !== digest
      || artifact.mimeType !== attachment.mimeType || artifact.size !== attachment.size) {
      throw new WorkRuntimeHttpError(409, 'CONVERSATION_ARTIFACT_READBACK_MISMATCH');
    }
  }

  async listBilibiliAccounts(context: RuntimeWorkContext): Promise<readonly Record<string, unknown>[]> {
    this.assertContext(context);
    const value = object(await this.request(context, '/bilibili/accounts', 'GET', undefined, context.signal), 'Bilibili accounts');
    if (!Array.isArray(value.items) || value.items.length > 100) throw new WorkRuntimeHttpError(502, 'BILIBILI_ACCOUNT_RESPONSE_INVALID');
    return value.items.map((item: unknown) => object(item, 'Bilibili account'));
  }

  async listBilibiliConnections(context: RuntimeWorkContext): Promise<readonly Record<string, unknown>[]> {
    this.assertContext(context);
    const value = object(await this.request(context, '/bilibili/connections', 'GET', undefined, context.signal), 'Bilibili connections');
    if (!Array.isArray(value.items) || value.items.length > 100) throw new WorkRuntimeHttpError(502, 'BILIBILI_CONNECTION_RESPONSE_INVALID');
    return value.items.map((item: unknown) => object(item, 'Bilibili connection'));
  }

  async invokeBilibiliOperation(
    context: RuntimeWorkContext,
    connectionRef: string,
    operationId: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    idempotencyKey: string | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.assertContext(context);
    const connection = boundedId(connectionRef, 'Bilibili connection reference');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(connection)) {
      throw new TypeError('Bilibili connection reference is invalid');
    }
    const encodedOperation = encodeURIComponent(operationId);
    if (idempotencyKey === undefined) throw new TypeError('Bilibili operations require a stable host idempotency key');
    const operationKey = boundedText(idempotencyKey, 'Bilibili idempotency key', 200);
    if (BILIBILI_READ_OPERATIONS.has(operationId)) {
      return this.request(
        context,
        `/bilibili/connections/${encodeURIComponent(connection)}/reads/${encodedOperation}`,
        'POST',
        { arguments: argumentsValue },
        signal,
        {
          'idempotency-key': operationKey,
          'x-cyrene-work-task-id': context.taskId,
        },
      );
    }
    if (!BILIBILI_WRITE_OPERATIONS.has(operationId)) {
      throw new TypeError('Bilibili operation is not in the fixed read/write catalog');
    }
    return this.request(
      context,
      `/bilibili/connections/${encodeURIComponent(connection)}/writes/${encodedOperation}`,
      'POST',
      { arguments: argumentsValue },
      signal,
      {
        'idempotency-key': operationKey,
        'x-cyrene-work-task-id': context.taskId,
      },
    );
  }

  async findBilibiliOperation(
    context: RuntimeWorkContext,
    idempotencyKey: string,
    signal: AbortSignal,
    expectedTaskId = context.taskId,
  ): Promise<BiliOperationLookupV1 | undefined> {
    this.assertContext(context);
    const taskId = boundedId(expectedTaskId, 'Bilibili child Task ID');
    try {
      const value = object(
        await this.request(
          context,
          '/bilibili/operations/by-idempotency-key',
          'GET',
          undefined,
          signal,
          {
            'idempotency-key': boundedText(idempotencyKey, 'Bilibili idempotency key', 200),
            'x-cyrene-work-task-id': taskId,
          },
        ),
        'Bilibili Work operation lookup',
      );
      const operation = decodeWorkOperation(value.operation);
      if (operation.idempotencyKey !== idempotencyKey || operation.taskId !== taskId) {
        throw new WorkRuntimeHttpError(409, 'BILIBILI_OPERATION_LOOKUP_SCOPE_MISMATCH');
      }
      const resultArtifact = value.resultArtifact === undefined || value.resultArtifact === null
        ? undefined
        : decodeAttachmentRef(value.resultArtifact, 'Bilibili result artifact');
      return { operation, ...(resultArtifact === undefined ? {} : { resultArtifact }) };
    } catch (error) {
      if (error instanceof WorkRuntimeHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  async createWorkOperation(
    context: RuntimeWorkContext,
    input: {
      readonly idempotencyKey: string;
      readonly operationType: string;
      readonly target: string;
      readonly request: Readonly<Record<string, unknown>>;
    },
  ): Promise<{ readonly operation: WorkOperationRecord; readonly duplicate: boolean }> {
    this.assertContext(context);
    const value = object(await this.request(context, '/operations', 'POST', {
      idempotencyKey: boundedText(input.idempotencyKey, 'Work idempotency key', 512),
      operationType: boundedText(input.operationType, 'Work operation type', 128),
      taskId: context.taskId,
      target: boundedText(input.target, 'Work operation target', 2_000),
      request: input.request,
    }, context.signal), 'Work operation receipt');
    const operation = decodeWorkOperation(value.operation);
    if (operation.taskId !== context.taskId) throw new WorkRuntimeHttpError(409, 'WORK_OPERATION_TASK_MISMATCH');
    return { operation, duplicate: value.duplicate === true };
  }

  async enqueueWorkNotification(
    context: RuntimeWorkContext,
    input: {
      readonly deduplicationKey: string;
      readonly type: string;
      readonly payload: Readonly<Record<string, unknown>>;
      readonly connectorId: string;
      readonly recipient: string;
      readonly availableAt?: number;
    },
    signal: AbortSignal,
  ): Promise<{ readonly notification: WorkNotificationRecord; readonly duplicate: boolean }> {
    this.assertContext(context);
    const deduplicationKey = boundedText(input.deduplicationKey, 'notification deduplication key', 512);
    const type = boundedText(input.type, 'notification type', 128);
    const connectorId = boundedText(input.connectorId, 'notification connector', 512);
    const recipient = boundedText(input.recipient, 'notification recipient', 2_000);
    const payload = object(input.payload, 'notification payload');
    const value = object(await this.request(context, '/notifications', 'POST', {
      deduplicationKey,
      type,
      payload,
      taskId: context.taskId,
      connectorId,
      recipient,
      ...(input.availableAt === undefined ? {} : { availableAt: safeInteger(input.availableAt, 'notification availableAt') }),
    }, signal), 'Work notification receipt');
    const notification = decodeWorkNotification(value.notification ?? value);
    if (notification.deduplicationKey !== deduplicationKey || notification.type !== type
      || notification.taskId !== context.taskId || notification.connectorId !== connectorId
      || notification.recipient !== recipient || canonicalJson(notification.payload) !== canonicalJson(payload)) {
      throw new WorkRuntimeHttpError(409, 'WORK_NOTIFICATION_ENQUEUE_SCOPE_MISMATCH');
    }
    return { notification, duplicate: value.duplicate === true };
  }

  async getWorkNotification(
    context: RuntimeWorkContext,
    notificationId: string,
    signal: AbortSignal,
  ): Promise<WorkNotificationRecord> {
    this.assertContext(context);
    const value = await this.request(
      context,
      `/notifications/${encodeURIComponent(boundedId(notificationId, 'notification ID'))}`,
      'GET',
      undefined,
      signal,
    );
    return decodeWorkNotification(object(value, 'Work notification').notification ?? value);
  }

  async getWorkNotificationByDeduplicationKey(
    context: RuntimeWorkContext,
    deduplicationKey: string,
    signal: AbortSignal,
  ): Promise<WorkNotificationRecord | undefined> {
    this.assertContext(context);
    try {
      const value = await this.request(
        context,
        `/notifications/by-deduplication-key?deduplicationKey=${encodeURIComponent(boundedText(deduplicationKey, 'notification deduplication key', 512))}`,
        'GET',
        undefined,
        signal,
      );
      return decodeWorkNotification(object(value, 'Work notification').notification ?? value);
    } catch (error) {
      if (error instanceof WorkRuntimeHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  async getWorkTask(context: RuntimeWorkContext, taskId: string, signal: AbortSignal): Promise<RuntimeWorkTaskRecord> {
    this.assertContext(context);
    const value = object(await this.request(
      context,
      `/tasks/${encodeURIComponent(boundedId(taskId, 'Work Task ID'))}`,
      'GET',
      undefined,
      signal,
    ), 'Work Task');
    const task = object(value.task ?? value, 'Work Task');
    if (task.id !== taskId || task.workspaceId !== context.workspaceId
      || task.createdByActorId !== context.actorId || typeof task.sessionId !== 'string'
      || typeof task.output !== 'string' || !isRecord(task.metadata)) {
      throw new WorkRuntimeHttpError(403, 'WORK_TASK_PROVENANCE_INVALID');
    }
    return {
      id: boundedId(task.id, 'Work Task ID'),
      workspaceId: boundedId(task.workspaceId, 'Work Task Workspace'),
      sessionId: boundedId(task.sessionId, 'Work Task session'),
      createdByActorId: boundedId(task.createdByActorId, 'Work Task actor'),
      status: typeof task.status === 'string' ? task.status : 'unknown',
      output: task.output,
      metadata: object(task.metadata, 'Work Task metadata'),
    };
  }

  async writeWorkJsonArtifact(
    context: RuntimeWorkContext,
    name: string,
    value: unknown,
    signal: AbortSignal,
  ): Promise<{ readonly artifactId: string; readonly sha256: string }> {
    this.assertContext(context);
    const bytes = new TextEncoder().encode(canonicalJson(value));
    if (bytes.byteLength === 0 || bytes.byteLength > 10_000_000) {
      throw new WorkRuntimeHttpError(413, 'WORK_ATTACHMENT_INVALID_SIZE');
    }
    const digest = sha256Bytes(bytes);
    const stored = object(await this.request(context, '/attachments', 'POST', {
      name: boundedText(name, 'Work artifact name', 512),
      mediaType: 'application/json',
      contentBase64: toBase64(bytes),
    }, signal), 'Work attachment receipt');
    if (stored.sha256 !== digest || stored.id !== digest || stored.mediaType !== 'application/json'
      || stored.size !== bytes.byteLength) {
      throw new WorkRuntimeHttpError(502, 'WORK_ATTACHMENT_WRITE_READBACK_MISMATCH');
    }
    const readback = await this.readWorkArtifact(context, digest, 'application/json', signal);
    if (sha256Bytes(readback) !== digest || !bytesEqual(readback, bytes)) {
      throw new WorkRuntimeHttpError(502, 'WORK_ATTACHMENT_WRITE_READBACK_MISMATCH');
    }
    return { artifactId: digest, sha256: digest };
  }

  async readWorkArtifact(
    context: RuntimeWorkContext,
    artifactId: string,
    expectedMimeType: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    this.assertContext(context);
    const digest = checkedDigest(artifactId, 'Work artifact ID');
    const token = this.credentials.tokenFor({ workspaceId: context.workspaceId, actorId: context.actorId });
    if (typeof token !== 'string' || token.length < 16 || token.length > 16_384) {
      throw new Error('Actor-scoped Work credential is unavailable');
    }
    const response = await fetch(`${this.root}/attachments/${encodeURIComponent(digest)}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: expectedMimeType },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      redirect: 'error',
    });
    if (!response.ok) throw new WorkRuntimeHttpError(response.status, 'WORK_ATTACHMENT_READ_FAILED');
    const mimeType = (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
    if (mimeType !== expectedMimeType) throw new WorkRuntimeHttpError(415, 'WORK_ATTACHMENT_MEDIA_TYPE_UNSUPPORTED');
    const bytes = await readBoundedBody(response, 10_000_000);
    if (bytes.byteLength === 0 || sha256Bytes(bytes) !== digest) {
      throw new WorkRuntimeHttpError(502, 'WORK_ATTACHMENT_DIGEST_MISMATCH');
    }
    return bytes;
  }

  async readWorkJsonArtifact(
    context: RuntimeWorkContext,
    artifactId: string,
    expectedSha256: string,
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const digest = checkedDigest(expectedSha256, 'JSON artifact digest');
    const bytes = await this.readWorkArtifact(context, artifactId, 'application/json', signal);
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = object(JSON.parse(source), 'Work JSON artifact');
    if (sha256Bytes(bytes) !== digest || canonicalJson(value) !== source) {
      throw new WorkRuntimeHttpError(502, 'WORK_JSON_ARTIFACT_READBACK_MISMATCH');
    }
    return value;
  }

  async findWorkOperationByIdempotencyKey(
    context: RuntimeWorkContext,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<WorkOperationRecord | undefined> {
    this.assertContext(context);
    try {
      const value = object(await this.request(
        context,
        '/operations/by-idempotency-key',
        'GET',
        undefined,
        signal,
        { 'idempotency-key': boundedText(idempotencyKey, 'Work idempotency key', 512) },
      ), 'Work operation lookup');
      const operation = decodeWorkOperation(value.operation);
      return operation.taskId === context.taskId ? operation : undefined;
    } catch (error) {
      if (error instanceof WorkRuntimeHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  async updateWorkOperation(
    context: RuntimeWorkContext,
    operationId: string,
    status: 'uncertain' | 'verified',
    evidence: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<WorkOperationRecord> {
    this.assertContext(context);
    const value = object(await this.request(
      context,
      `/operations/${encodeURIComponent(boundedId(operationId, 'Work operation ID'))}`,
      'PATCH',
      { status, evidence },
      signal,
    ), 'Work operation receipt');
    const operation = decodeWorkOperation(value.operation);
    if (operation.id !== operationId || operation.taskId !== context.taskId || operation.status !== status) {
      throw new WorkRuntimeHttpError(409, 'WORK_OPERATION_UPDATE_MISMATCH');
    }
    return operation;
  }

  async callBiliDomain(
    context: RuntimeWorkContext,
    route: BiliDomainRoute,
    input: {
      readonly id?: string;
      readonly query?: Readonly<Record<string, string | number | undefined>>;
      readonly body?: Readonly<Record<string, unknown>>;
    },
    signal: AbortSignal,
  ): Promise<unknown> {
    this.assertContext(context);
    const safeId = input.id === undefined ? undefined : encodeURIComponent(boundedId(input.id, 'Bilibili domain ID'));
    const pathByRoute: Record<BiliDomainRoute, { method: 'GET' | 'POST' | 'PATCH'; path: string }> = {
      'delegations.list': { method: 'GET', path: '/conversation-memory/bilibili/delegations' },
      'delegations.create': { method: 'POST', path: '/conversation-memory/bilibili/delegations' },
      'delegations.get': { method: 'GET', path: `/conversation-memory/bilibili/delegations/${safeId ?? ''}` },
      'delegations.authorize': { method: 'POST', path: `/conversation-memory/bilibili/delegations/${safeId ?? ''}/authorize` },
      'delegations.revoke': { method: 'POST', path: `/conversation-memory/bilibili/delegations/${safeId ?? ''}/revoke` },
      'subscriptions.list': { method: 'GET', path: '/conversation-memory/bilibili/subscriptions' },
      'subscriptions.create': { method: 'POST', path: '/conversation-memory/bilibili/subscriptions' },
      'subscriptions.get': { method: 'GET', path: `/conversation-memory/bilibili/subscriptions/${safeId ?? ''}` },
      'subscriptions.claim': { method: 'POST', path: `/conversation-memory/bilibili/subscriptions/${safeId ?? ''}/claim` },
      'subscriptions.recordCheck': { method: 'PATCH', path: `/conversation-memory/bilibili/subscriptions/${safeId ?? ''}/check` },
      'subscriptions.authorizeNotification': { method: 'POST', path: `/conversation-memory/bilibili/subscriptions/${safeId ?? ''}/notification-authorization` },
      'subscriptions.transition': { method: 'POST', path: `/conversation-memory/bilibili/subscriptions/${safeId ?? ''}/transition` },
    };
    const routeInfo = pathByRoute[route];
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    const path = query.size === 0 ? routeInfo.path : `${routeInfo.path}?${query}`;
    return this.request(context, path, routeInfo.method, input.body, signal, {
      'x-cyrene-work-task-id': context.taskId,
    });
  }

  private async readConversationMessagePage(
    context: RuntimeWorkContext,
    query: URLSearchParams,
    signal: AbortSignal,
  ): Promise<{ readonly items: readonly unknown[]; readonly nextCursor: string | null }> {
    const page = object(await this.request(context, `/conversation-memory/messages?${query}`, 'GET', undefined, signal), 'message page');
    if (!Array.isArray(page.items) || page.items.length > 100
      || (page.nextCursor !== null && page.nextCursor !== undefined && typeof page.nextCursor !== 'string')) {
      throw new TypeError('Invalid Work message page');
    }
    return {
      items: page.items,
      nextCursor: page.nextCursor === null || page.nextCursor === undefined ? null : page.nextCursor,
    };
  }

  private async request(
    context: RuntimeWorkContext,
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    body: unknown,
    signal: AbortSignal,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    this.assertContext(context);
    const token = this.credentials.tokenFor({ workspaceId: context.workspaceId, actorId: context.actorId });
    if (typeof token !== 'string' || token.length < 16 || token.length > 16_384) {
      throw new Error('Actor-scoped Work credential is unavailable');
    }
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const response = await fetch(`${this.root}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: requestSignal,
      redirect: 'error',
    });
    const raw = await readBoundedBody(response, MAX_JSON_BYTES);
    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new WorkRuntimeHttpError(502, 'WORK_RESPONSE_INVALID_JSON');
    }
    if (!response.ok) {
      const error = isRecord(parsed) ? parsed : {};
      const code = typeof error.code === 'string' ? error.code : 'WORK_REQUEST_FAILED';
      throw new WorkRuntimeHttpError(response.status, code);
    }
    return parsed;
  }

  private assertContext(context: RuntimeWorkContext): void {
    if (context.workspaceId !== this.workspaceId || !context.actorId.trim()) {
      throw new TypeError('Work client context does not match its server binding');
    }
  }
}

function decodeWorkOperation(value: unknown): WorkOperationRecord {
  const row = object(value, 'Work operation');
  if (row.status !== 'started' && row.status !== 'uncertain' && row.status !== 'verified') {
    throw new WorkRuntimeHttpError(502, 'WORK_OPERATION_INVALID');
  }
  return {
    id: boundedId(String(row.id), 'Work operation ID'),
    idempotencyKey: boundedText(row.idempotencyKey, 'Work idempotency key', 512),
    operationType: boundedText(row.operationType, 'Work operation type', 128),
    taskId: row.taskId === null ? null : boundedId(String(row.taskId), 'Work operation Task ID'),
    target: row.target === null ? null : boundedText(row.target, 'Work operation target', 2_000),
    request: object(row.request, 'Work operation request'),
    status: row.status,
    evidence: object(row.evidence, 'Work operation evidence'),
    ...(typeof row.trustedProducer === 'string' ? { trustedProducer: row.trustedProducer } : {}),
    createdAt: safeInteger(Number(row.createdAt), 'Work operation createdAt'),
    updatedAt: safeInteger(Number(row.updatedAt), 'Work operation updatedAt'),
  };
}

function decodeAttachmentRef(value: unknown, label: string): WorkAttachmentRef {
  const row = object(value, label);
  const artifactId = checkedDigest(row.artifactId, `${label} ID`);
  const sha256 = checkedDigest(row.sha256, `${label} digest`);
  const mimeType = boundedText(row.mimeType, `${label} MIME type`, 128).toLowerCase();
  const size = safeInteger(Number(row.size), `${label} size`);
  if (artifactId !== sha256 || mimeType !== 'application/json' || size < 1 || size > 10_000_000) {
    throw new WorkRuntimeHttpError(502, 'BILIBILI_RESULT_ARTIFACT_INVALID');
  }
  return { artifactId, sha256, mimeType, size };
}

function decodeWorkNotification(value: unknown): WorkNotificationRecord {
  const row = object(value, 'Work notification');
  const status = row.status;
  if (status !== 'queued' && status !== 'leased' && status !== 'started'
    && status !== 'uncertain' && status !== 'delivered' && status !== 'failed') {
    throw new WorkRuntimeHttpError(502, 'WORK_NOTIFICATION_INVALID');
  }
  const nullable = (field: unknown, label: string, maximum: number): string | null =>
    field === null ? null : boundedText(field, label, maximum);
  return {
    id: boundedText(row.id, 'notification ID', 512),
    deduplicationKey: boundedText(row.deduplicationKey, 'notification deduplication key', 512),
    type: boundedText(row.type, 'notification type', 128),
    payload: object(row.payload, 'notification payload'),
    taskId: nullable(row.taskId, 'notification Task ID', 512),
    connectorId: nullable(row.connectorId, 'notification connector ID', 512),
    recipient: nullable(row.recipient, 'notification recipient', 2_000),
    status,
    availableAt: safeInteger(Number(row.availableAt), 'notification availableAt'),
    createdAt: safeInteger(Number(row.createdAt), 'notification createdAt'),
    updatedAt: safeInteger(Number(row.updatedAt), 'notification updatedAt'),
    result: object(row.result, 'notification result'),
  };
}

export function validateSourceRefs(values: readonly ConversationSourceRef[]): readonly ConversationSourceRef[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 256) {
    throw new TypeError('Conversation source lineage is empty or exceeds the Work bound');
  }
  const references: readonly ConversationSourceRef[] = values;
  return references.map((reference: ConversationSourceRef) => {
    const rawMessageIds: unknown = reference?.sourceMessageIds;
    if (reference === null || typeof reference !== 'object' || !Array.isArray(rawMessageIds)
      || rawMessageIds.length === 0 || rawMessageIds.length > 128
      || (reference.memoryId === null) !== (reference.memoryVersion === null)
      || (reference.memoryId !== null && (typeof reference.memoryId !== 'string' || !Number.isSafeInteger(reference.memoryVersion) || (reference.memoryVersion ?? 0) < 1))
      || rawMessageIds.some((id: unknown) => typeof id !== 'string' || id.length === 0 || id.length > 512)
      || new Set(rawMessageIds).size !== rawMessageIds.length) {
      throw new TypeError('Conversation source reference is invalid');
    }
    return {
      memoryId: reference.memoryId,
      memoryVersion: reference.memoryVersion,
      sourceMessageIds: rawMessageIds as string[],
    };
  });
}

function decodeResearchResult(value: unknown): ConversationRuntimeReadResult {
  const row = object(value, 'research result');
  const operationId = boundedText(row.operationId, 'operation ID', 512);
  const title = boundedText(row.title, 'research title', 512);
  const content = boundedText(row.content, 'research content', 1_000_000);
  const resultSha256 = checkedDigest(row.resultSha256, 'result sha256');
  const contentSha256 = checkedDigest(row.contentSha256, 'content sha256');
  const artifactId = checkedDigest(row.artifactId, 'artifact id');
  if (artifactId !== resultSha256 || sha256Text(content) !== contentSha256) {
    throw new WorkRuntimeHttpError(502, 'RESEARCH_RESULT_DIGEST_MISMATCH');
  }
  if (!Array.isArray(row.sourceEvidence) || row.sourceEvidence.length < 1 || row.sourceEvidence.length > 20) {
    throw new WorkRuntimeHttpError(502, 'RESEARCH_SOURCE_EVIDENCE_INVALID');
  }
  const sourceEvidence = row.sourceEvidence.map(decodeSourceEvidence);
  return { operationId, title, content, resultSha256, contentSha256, sourceEvidence, artifactId };
}

function decodeResearchReceipt(
  value: unknown,
  context: RuntimeWorkContext,
  expectedOperationId: string,
): ConversationResearchOperationReceipt {
  const row = object(value, 'research operation receipt');
  const receipt: ConversationResearchOperationReceipt = {
    id: boundedId(String(row.id), 'receipt ID'),
    workspaceId: boundedId(String(row.workspaceId), 'receipt Workspace'),
    actorId: boundedId(String(row.actorId), 'receipt actor'),
    taskId: boundedId(String(row.taskId), 'receipt Task ID'),
    taskStatus: 'completed',
    taskOutputSha256: checkedDigest(row.taskOutputSha256, 'Task output sha256'),
    status: 'verified',
    operationType: 'conversation.research.read.v1',
    effect: 'read',
    resultSha256: checkedDigest(row.resultSha256, 'result sha256'),
    contentSha256: checkedDigest(row.contentSha256, 'content sha256'),
    targetDigestSha256: checkedDigest(row.targetDigestSha256, 'target sha256'),
    sourceRefs: validateSourceRefs(row.sourceRefs as ConversationSourceRef[]),
    sourceEvidence: Array.isArray(row.sourceEvidence) ? row.sourceEvidence.map(decodeSourceEvidence) : [],
    verifiedAt: safeInteger(row.verifiedAt as number, 'verifiedAt'),
  };
  if (row.id !== expectedOperationId || row.workspaceId !== context.workspaceId
    || row.actorId !== context.actorId || row.status !== 'verified'
    || row.taskStatus !== 'completed' || row.operationType !== 'conversation.research.read.v1'
    || row.effect !== 'read' || receipt.sourceEvidence.length === 0) {
    throw new WorkRuntimeHttpError(409, 'WORK_OPERATION_RECEIPT_INVALID');
  }
  return receipt;
}

function decodeSourceEvidence(value: unknown): ResearchSourceEvidence {
  const row = object(value, 'research source evidence');
  if (typeof row.kind !== 'string' || !['web', 'document'].includes(row.kind)) {
    throw new WorkRuntimeHttpError(502, 'RESEARCH_SOURCE_EVIDENCE_INVALID');
  }
  const sourceRef = boundedText(row.sourceRef, 'source reference', 80);
  if (!/^sha256:[0-9a-f]{64}$/u.test(sourceRef)) throw new WorkRuntimeHttpError(502, 'RESEARCH_SOURCE_EVIDENCE_INVALID');
  const sourceSha256 = checkedDigest(row.sourceSha256, 'source sha256');
  const title = boundedText(row.title, 'source title', 512);
  const retrievedAt = boundedText(row.retrievedAt, 'retrievedAt', 64);
  if (!retrievedAt.endsWith('Z') || !Number.isFinite(Date.parse(retrievedAt))) {
    throw new WorkRuntimeHttpError(502, 'RESEARCH_SOURCE_EVIDENCE_INVALID');
  }
  const url = row.url === undefined ? undefined : boundedText(row.url, 'source URL', 4_096);
  const artifactId = row.artifactId === undefined ? undefined : checkedDigest(row.artifactId, 'source artifact ID');
  if (url !== undefined) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.href !== url) {
      throw new WorkRuntimeHttpError(502, 'RESEARCH_SOURCE_EVIDENCE_INVALID');
    }
  }
  if (row.kind === 'web' && url === undefined) throw new WorkRuntimeHttpError(502, 'RESEARCH_SOURCE_EVIDENCE_INVALID');
  if (row.kind === 'document' && url === undefined && artifactId === undefined) {
    throw new WorkRuntimeHttpError(502, 'RESEARCH_SOURCE_EVIDENCE_INVALID');
  }
  return {
    sourceRef,
    kind: row.kind as ResearchSourceEvidence['kind'],
    title,
    sourceSha256,
    retrievedAt,
    ...(url === undefined ? {} : { url }),
    ...(artifactId === undefined ? {} : { artifactId }),
  };
}

function decodeMessage(value: unknown): ConversationMessageRecord {
  const row = object(value, 'conversation message');
  const scope = object(row.scope, 'conversation message scope');
  if (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'tool') throw new TypeError('Invalid conversation role');
  if (row.status !== 'active' && row.status !== 'revoked') throw new TypeError('Invalid conversation message status');
  if (!Array.isArray(row.attachments) || row.attachments.length > 32) throw new TypeError('Invalid conversation attachments');
  const attachments = row.attachments.map(value => {
    const attachment = object(value, 'conversation attachment');
    const artifactId = checkedDigest(attachment.artifactId, 'artifact id');
    const sha256 = checkedDigest(attachment.sha256, 'attachment digest');
    if (artifactId !== sha256 || typeof attachment.mimeType !== 'string'
      || !Number.isSafeInteger(attachment.size) || Number(attachment.size) < 1 || Number(attachment.size) > 10_000_000) {
      throw new TypeError('Invalid conversation attachment metadata');
    }
    return { artifactId, sha256, mimeType: attachment.mimeType, size: Number(attachment.size) };
  });
  return {
    id: boundedText(row.id, 'conversation message ID', 512),
    eventId: boundedText(row.eventId, 'conversation event ID', 512),
    role: row.role,
    status: row.status,
    scope: {
      conversationId: boundedText(scope.conversationId, 'conversation ID', 512),
      conversationKind: readConversationKind(scope.conversationKind),
      personaId: scope.personaId === null ? null : boundedText(scope.personaId, 'persona ID', 512),
      visibility: boundedText(scope.visibility, 'visibility', 32),
    },
    attachments,
  };
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel();
    throw new WorkRuntimeHttpError(413, 'WORK_RESPONSE_TOO_LARGE');
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new WorkRuntimeHttpError(413, 'WORK_RESPONSE_TOO_LARGE');
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) throw new TypeError(`${label} is invalid`);
  return value.trim();
}

function boundedId(value: string, label: string): string {
  return boundedText(value, label, 512);
}

function checkedDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} is invalid`);
  return value;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function toBase64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function readConversationKind(value: unknown): ConversationKind {
  if (value !== 'direct' && value !== 'group' && value !== 'channel') throw new TypeError('Invalid conversation kind');
  return value;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}
