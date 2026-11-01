// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator durable executor work-state client                │
// │ Role: Read and mutate execution TaskRecords through the SQLite API. │
// │ 模块职责：通过 SQLite Work API 读写执行器 TaskRecord 与事件。          │
// └─────────────────────────────────────────────────────────────────────┘

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type {
  ConversationMemoryApiV1,
  ConversationMemory as ConversationMemoryFeatureRecord,
  ConversationMessage as ConversationMessageFeatureRecord,
  ConversationSourceRef as ConversationSourceRefFeatureRecord,
  TrustedTurnContext,
} from './features/conversation-memory.js';

export type ExecutionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'waiting_approval'
  | 'waiting_input'
  | 'awaiting_user_authorization';

export type ExecutionClass = 'foreground' | 'background';
export type WorkExecutionBackend = 'codebuddy-acp' | 'antigravity-acp';

/** Durable executor record; the Work service is the production authority.  中文：持久化执行器记录；生产环境以 Work service 为准。 */
export interface TaskRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly status: ExecutionStatus;
  readonly executionClass: ExecutionClass;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly output: string;
  readonly reasoning: string;
  readonly error?: string;
  readonly durationMs: number;
  readonly workspaceId?: string;
  /** Server-derived Work principal actor; never accepted from Task creation metadata. */
  readonly createdByActorId?: string;
  readonly sequence?: number;
  readonly continuationOfTaskId?: string | null;
  readonly continuationMode?: 'read_only' | null;
  /** Immutable, server-derived Teams private ingress proof; contains no reply route. */
  readonly origin?: TeamsPrivateTaskOrigin;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TeamsPrivateTaskOrigin {
  readonly kind: 'teams_private';
  readonly messageId: string;
  readonly tenantId: string;
  readonly botAppId: string;
  readonly actorAadObjectId: string;
}

/** Native process identity stored by the existing Workspace-scoped Work service. */
export interface BackendSessionRecord {
  readonly backend: WorkExecutionBackend;
  readonly sessionId: string;
  readonly nativeSessionId: string;
}

/** One canonical inbound connector event with optional atomic task admission. */
export interface ConnectorEventInput {
  readonly connectorId: string;
  readonly messageId: string;
  readonly type: string;
  readonly occurredAt?: number;
  readonly accountId?: string;
  readonly conversationId?: string;
  readonly senderId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly teamsPrivateMessage?: {
    readonly messageId: string;
    readonly text: string;
  };
  readonly teamsThreadMessage?: {
    readonly threadId: string;
    readonly messageId: string;
    readonly serviceUrl: string;
    readonly tenantId: string;
    readonly teamId: string;
    readonly channelId: string;
    readonly conversationId: string;
    readonly rootThreadId: string;
    readonly actorIssuer: string;
    readonly actorSubject: string;
    readonly text: string;
    readonly sessionId?: string;
  };
  readonly task?: {
    readonly id: string;
    readonly sessionId: string;
    readonly prompt: string;
    readonly title?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}

/** Durable connector acknowledgement; replay returns the original task row. */
export interface ConnectorEventReceipt {
  readonly eventId: string;
  readonly duplicate: boolean;
  readonly receivedAt: number;
  readonly task?: TaskRecord;
}

/** Stable thread route plus its bound DSH session and recent participant context. */
export interface ConnectorThreadRecord {
  readonly threadId: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly conversationId: string;
  readonly rootThreadId: string;
  readonly serviceUrl: string;
  readonly sessionId?: string;
  readonly messages: readonly {
    readonly messageId: string;
    readonly actorIssuer: string;
    readonly actorSubject: string;
    readonly text: string;
    readonly createdAt: number;
  }[];
}

/** One immutable outbox payload claimed by a single adapter worker. */
export interface NotificationLease {
  readonly notification: {
    readonly id: string;
    readonly deduplicationKey: string;
    readonly type: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly taskId?: string;
    readonly connectorId?: string;
    readonly recipient?: string;
    readonly status: 'queued' | 'leased' | 'started' | 'uncertain' | 'delivered' | 'failed';
    readonly result: Readonly<Record<string, unknown>>;
  };
  readonly leaseToken: string;
  /** Work-resolved personal route, available only on the private notification lease. */
  readonly teamsPersonalRoute?: TeamsPersonalNotificationRoute;
}

/** Private conversation binding returned only inside a trusted Work notification lease. */
export interface TeamsPersonalNotificationRoute {
  readonly kind: 'teams_personal';
  readonly tenantId: string;
  readonly botAppId: string;
  readonly actorAadObjectId: string;
  readonly conversationId: string;
  readonly serviceUrl: string;
}

/** Verified personal-install activity forwarded from the authenticated Teams adapter. */
export interface TeamsPrivateInstallationEvent {
  readonly eventType: 'personal_installation';
  readonly payload: { readonly action: 'add' | 'remove' };
  readonly trust: {
    readonly version: 1;
    readonly provider: 'teams';
    readonly conversationKind: 'private';
    readonly installationAction: 'add' | 'remove';
    readonly tenantId: string;
    readonly actorAadObjectId: string;
    readonly botAppId: string;
    readonly conversationId: string;
    readonly activityId: string;
    readonly activityOccurredAt: string;
    readonly serviceUrl: string;
  };
}

export interface TeamsPrivateInstallationReceipt {
  readonly action: 'add' | 'remove';
  readonly active: boolean;
  /** Whether this event changed the currently applied installation state. */
  readonly applied: boolean;
  readonly revision: number;
  readonly updatedAt: number;
  readonly duplicate: boolean;
}

/** Credential-free authorization health returned by Exchange's fixed snapshot projection. */
export interface CredentialHealthSnapshot {
  readonly connectionId: string;
  readonly provider: 'hf' | 'runpod' | 'azure' | 'gcp' | 'microsoft_graph';
  readonly loginState: 'PRESENT' | 'MISSING' | 'UNKNOWN' | 'UNAVAILABLE';
  readonly authorizationState: 'VALID' | 'REAUTHORIZATION_REQUIRED' | 'PERMISSION_DENIED' | 'UNKNOWN' | 'UNAVAILABLE';
  readonly checkedAt: string | null;
  readonly expiresAt: string | null;
  readonly generation: number;
  readonly capabilities: readonly {
    readonly capabilityId: string;
    readonly state: 'VALID' | 'REAUTHORIZATION_REQUIRED' | 'PERMISSION_DENIED' | 'UNKNOWN' | 'UNAVAILABLE';
    readonly lastVerifiedAt: string | null;
    readonly expiresAt: string | null;
    readonly reasonCode: string | null;
  }[];
  /** Host-derived owner and Bot installation scope for private Graph health notices. */
  readonly privateOwner?: {
    readonly actorAadObjectId: string;
    readonly tenantId: string;
    readonly botAppId: string;
  };
  readonly reasonCode: string | null;
}

/** One ordered durable event attached to a task.  中文：与任务关联的一条有序持久化事件。 */
export interface DurableTaskEvent {
  readonly seq: number;
  readonly event: Record<string, unknown>;
  readonly createdAt: number;
  readonly messageId?: string;
}

export interface TaskPage {
  readonly items: readonly TaskRecord[];
  readonly nextCursor: string | null;
}

export interface TaskEventPage {
  readonly events: readonly DurableTaskEvent[];
  readonly nextSeq: number;
}

/** Minimal started/uncertain connector receipts used to block replay and reconcile status. */
export interface UnresolvedOperationSummary {
  readonly id: string;
  readonly operationType: string;
  readonly taskId?: string | null;
  readonly target?: string | null;
  readonly status: 'started' | 'uncertain';
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** Opaque content-addressed attachment metadata returned by Work. */
export interface WorkAttachmentRecord {
  readonly artifactId: string;
  readonly sha256: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
}

/** Bounded attachment bytes resolved only through the active Work principal. */
export interface WorkAttachmentBytes extends WorkAttachmentRecord {
  readonly bytes: Uint8Array;
}

/** Server decision for reading an attachment cited by the current conversation turn. */
export interface WorkConversationArtifactAuthorization {
  readonly artifactId: string;
  readonly conversationId: string;
  readonly conversationKind: 'direct' | 'group' | 'channel';
  readonly personaId: string | null;
  readonly authorizationEpoch: number;
  readonly sourceRefs: readonly {
    readonly memoryId: string | null;
    readonly memoryVersion: number | null;
    readonly sourceMessageIds: readonly string[];
  }[];
}

/** Current source authorization and safe content metadata for one artifact. */
export interface WorkConversationArtifactAuthorizationReceipt {
  readonly allowed: boolean;
  readonly currentAuthorizationEpoch: number;
  readonly artifact?: WorkAttachmentRecord;
}

export type ConversationMaintenanceState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ConversationMaintenanceJobRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly kind: 'dream' | 'forget' | 'daily_review' | 'backup' | 'import';
  readonly conversationId: string | null;
  readonly conversationKind: 'direct' | 'group' | 'channel' | null;
  readonly personaId: string | null;
  readonly state: ConversationMaintenanceState;
  readonly cursor: string | null;
  readonly processedCount: number;
  readonly checkpointDigest: string | null;
  readonly details: Readonly<Record<string, unknown>>;
  readonly queuedVersion: number;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ConversationMaintenanceCheckpoint {
  readonly cursor: string | null;
  readonly processedCount: number;
  readonly checkpointDigest: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/** Artifact resolver bound to one authenticated Work principal and task actor. */
export interface MediaArtifactResolver {
  readonly expectedSubject: string;
  read(artifactId: string, signal?: AbortSignal): Promise<WorkAttachmentBytes>;
  write(
    bytes: Uint8Array,
    mimeType: string,
    metadata: { readonly name: string },
    signal?: AbortSignal,
  ): Promise<WorkAttachmentRecord>;
}

/** Narrow storage contract shared by the HTTP service and explicit test store.  中文：HTTP 服务和显式测试存储共用的最小存储契约。 */
export interface WorkStateStore {
  createTask(input: {
    id?: string;
    sessionId: string;
    prompt: string;
    executionClass?: ExecutionClass;
    metadata?: Readonly<Record<string, unknown>>;
  }): Promise<TaskRecord>;
  createContinuationTask(
    sourceTaskId: string,
    input: { prompt: string; idempotencyKey: string },
  ): Promise<TaskRecord>;
  verifyContinuationOwnership(sourceTaskId: string): Promise<void>;
  getTask(taskId: string): Promise<TaskRecord | undefined>;
  getBackendSession(taskId: string, backend?: WorkExecutionBackend): Promise<BackendSessionRecord | undefined>;
  bindBackendSession(
    taskId: string,
    nativeSessionId: string,
    backend?: WorkExecutionBackend,
  ): Promise<BackendSessionRecord>;
  listTasks(options?: { cursor?: string; limit?: number }): Promise<TaskPage>;
  listOwnedTasks?(options?: { cursor?: string; limit?: number }): Promise<TaskPage>;
  claimTask(taskId: string): Promise<{ claimed: boolean; task: TaskRecord }>;
  patchTask(taskId: string, patch: Partial<Omit<TaskRecord, 'id' | 'workspaceId' | 'sequence'>>): Promise<TaskRecord>;
  appendEvent(taskId: string, event: Record<string, unknown>, messageId?: string): Promise<DurableTaskEvent>;
  getEvents(taskId: string, after?: number): Promise<TaskEventPage>;
  listUnresolvedOperations(options?: { target?: string; limit?: number }): Promise<readonly UnresolvedOperationSummary[]>;
  registerConnectorEvent(input: ConnectorEventInput): Promise<ConnectorEventReceipt>;
  getConnectorThread(connectorId: string, threadId: string, messageLimit?: number, excludeMessageId?: string): Promise<ConnectorThreadRecord>;
  claimNotifications(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
    type: string;
    connectorId: string;
    recipient?: string;
  }): Promise<readonly NotificationLease[]>;
  claimPrivateNotifications?(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
    type: string;
    connectorId: string;
  }): Promise<readonly NotificationLease[]>;
  startPrivateNotification?(notificationId: string, leaseToken: string): Promise<void>;
  finishPrivateNotification?(
    notificationId: string,
    leaseToken: string,
    outcome: 'delivered' | 'failed' | 'uncertain' | 'retry',
    result?: Readonly<Record<string, unknown>>,
    retryAfterSeconds?: number,
  ): Promise<void>;
  registerTeamsPrivateInstallation?(event: TeamsPrivateInstallationEvent): Promise<TeamsPrivateInstallationReceipt>;
  processCredentialHealthSnapshots(
    organizationId: string,
    connections: readonly CredentialHealthSnapshot[],
  ): Promise<{
    readonly processed: number;
    readonly stale: number;
    readonly notificationsQueued: number;
  }>;
  startNotification(notificationId: string, leaseToken: string): Promise<void>;
  finishNotification(
    notificationId: string,
    leaseToken: string,
    outcome: 'delivered' | 'failed' | 'uncertain' | 'retry',
    result?: Readonly<Record<string, unknown>>,
    retryAfterSeconds?: number,
  ): Promise<void>;
  readAttachment?(artifactId: string, signal?: AbortSignal): Promise<WorkAttachmentBytes>;
  writeAttachment?(
    bytes: Uint8Array,
    mimeType: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<WorkAttachmentRecord>;
  authorizeConversationArtifact?(
    request: WorkConversationArtifactAuthorization,
    signal?: AbortSignal,
  ): Promise<WorkConversationArtifactAuthorizationReceipt>;
  /** Build the actor-scoped conversation API over this already authenticated client. */
  conversationMemoryApiV1?(actorId: string): ConversationMemoryApiV1;
  /** Read the current authorization epoch through this actor-scoped client. */
  getConversationMemoryOverview?(signal?: AbortSignal): Promise<{
    readonly authorizationEpoch: number;
    readonly counts: Readonly<{ messages: number; memories: number; sources: number }>;
  }>;
  getConversationMemoryMessage?(input: {
    readonly messageId: string;
    readonly conversationId: string;
    readonly conversationKind: 'direct' | 'group' | 'channel';
    readonly personaId: string | null;
  }, signal?: AbortSignal): Promise<ConversationMessageFeatureRecord | undefined>;
}

export interface WorkStateConnection {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly tokenEnv?: string;
  /** Separate Work principal scoped to Teams private installation/notification bridge operations. */
  readonly privateBridgeTokenEnv?: string;
  readonly requestTimeoutMs?: number;
}

const WORK_ATTACHMENT_LIMIT_BYTES = 10_000_000;
const WORK_IMAGE_MIME_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);

/** A task-local resolver; its WorkStateStore must already be actor-token scoped. */
export class WorkMediaArtifactResolver implements MediaArtifactResolver {
  constructor(
    private readonly workState: WorkStateStore,
    readonly expectedSubject: string,
  ) {
    if (!expectedSubject.trim() || expectedSubject.length > 512) {
      throw new TypeError('A verified Work Task subject is required for media artifacts');
    }
  }

  /** Resolve an opaque digest only through the bound Work authorization. */
  async read(artifactId: string, signal?: AbortSignal): Promise<WorkAttachmentBytes> {
    if (this.workState.readAttachment === undefined) {
      throw new WorkStateHttpError(503, 'WORK_ATTACHMENT_RESOLVER_UNAVAILABLE');
    }
    return this.workState.readAttachment(artifactId, signal);
  }

  /** Write bounded image output into this actor's Work attachment scope. */
  async write(
    bytes: Uint8Array,
    mimeType: string,
    metadata: { readonly name: string },
    signal?: AbortSignal,
  ): Promise<WorkAttachmentRecord> {
    if (this.workState.writeAttachment === undefined) {
      throw new WorkStateHttpError(503, 'WORK_ATTACHMENT_RESOLVER_UNAVAILABLE');
    }
    return this.workState.writeAttachment(bytes, mimeType, metadata.name, signal);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, key: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`Invalid Work Task ${key}`);
  }
  return value;
}

function timeField(value: unknown, key: string, optional = false): number | undefined {
  if (optional && (value === undefined || value === null)) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid Work Task ${key}`);
  }
  return value;
}

function countField(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid Work credential health ${key}`);
  }
  return value;
}

function finiteNumber(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid Work ${key}`);
  }
  return value;
}

function booleanField(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`Invalid Work ${key}`);
  return value;
}

function decodeWorkAttachment(value: unknown): WorkAttachmentRecord {
  const row = object(value, 'Work attachment');
  const artifactId = stringField(row.artifactId, 'artifactId');
  const sha256 = stringField(row.sha256, 'sha256');
  const name = stringField(row.name, 'name');
  const mimeType = stringField(row.mimeType, 'mimeType').toLowerCase();
  const size = countField(row.size, 'size');
  if (!/^[0-9a-f]{64}$/u.test(artifactId) || artifactId !== sha256
    || !WORK_IMAGE_MIME_TYPES.has(mimeType) || size < 1 || size > WORK_ATTACHMENT_LIMIT_BYTES) {
    throw new TypeError('Invalid authorized Work attachment metadata');
  }
  return { artifactId, sha256, name, mimeType, size };
}

function decodeConversationMaintenanceJob(value: unknown): ConversationMaintenanceJobRecord {
  const row = object(value, 'Conversation maintenance job');
  const states: ConversationMaintenanceState[] = ['queued', 'running', 'completed', 'failed', 'cancelled'];
  const kinds = ['dream', 'forget', 'daily_review', 'backup', 'import'] as const;
  const conversations = ['direct', 'group', 'channel'] as const;
  if (!states.includes(row.state as ConversationMaintenanceState)
    || !kinds.includes(row.kind as typeof kinds[number])) {
    throw new TypeError('Invalid conversation maintenance job state or kind');
  }
  const conversationKind = row.conversationKind === null
    ? null
    : row.conversationKind as typeof conversations[number];
  if (conversationKind !== null && !conversations.includes(conversationKind)) {
    throw new TypeError('Invalid conversation maintenance conversation kind');
  }
  const conversationId = row.conversationId === null
    ? null
    : stringField(row.conversationId, 'conversationId');
  const personaId = row.personaId === null
    ? null
    : stringField(row.personaId, 'personaId');
  const cursor = row.cursor === null ? null : stringField(row.cursor, 'cursor', true);
  const checkpointDigest = row.checkpointDigest === null
    ? null
    : stringField(row.checkpointDigest, 'checkpointDigest');
  const queuedVersion = countField(row.queuedVersion, 'queuedVersion');
  const version = countField(row.version, 'version');
  if (queuedVersion !== 1 || version < queuedVersion) {
    throw new TypeError('Invalid conversation maintenance version');
  }
  return {
    id: stringField(row.id, 'id'),
    idempotencyKey: stringField(row.idempotencyKey, 'idempotencyKey'),
    kind: row.kind as ConversationMaintenanceJobRecord['kind'],
    conversationId,
    conversationKind,
    personaId,
    state: row.state as ConversationMaintenanceState,
    cursor,
    processedCount: countField(row.processedCount, 'processedCount'),
    checkpointDigest,
    details: object(row.details, 'maintenance details'),
    queuedVersion,
    version,
    createdAt: timeField(row.createdAt, 'createdAt')!,
    updatedAt: timeField(row.updatedAt, 'updatedAt')!,
  };
}

function decodeConversationSourceRefs(value: unknown, field: string): readonly ConversationSourceRefFeatureRecord[] {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError(`Invalid ${field}`);
  return value.map((entry, index) => {
    const row = object(entry, `${field}[${index}]`);
    const memoryId = row.memoryId === null ? null : stringField(row.memoryId, 'memoryId');
    const memoryVersion = row.memoryVersion === null
      ? null
      : timeField(row.memoryVersion, 'memoryVersion')!;
    if ((memoryId === null) !== (memoryVersion === null) || (memoryVersion !== null && memoryVersion < 1)) {
      throw new TypeError(`Invalid ${field}[${index}] memory version`);
    }
    if (!Array.isArray(row.sourceMessageIds) || row.sourceMessageIds.length > 128) {
      throw new TypeError(`Invalid ${field}[${index}] message ids`);
    }
    const sourceMessageIds = row.sourceMessageIds.map((item, idIndex) =>
      stringField(item, `${field}[${index}].sourceMessageIds[${idIndex}]`));
    if (memoryId === null && sourceMessageIds.length === 0) {
      throw new TypeError(`Invalid empty ${field}[${index}]`);
    }
    return { memoryId, memoryVersion, sourceMessageIds };
  });
}

function decodeConversationResourceScope(value: unknown): ConversationMessageFeatureRecord['scope'] {
  const row = object(value, 'Conversation resource scope');
  const kinds = ['direct', 'group', 'channel'] as const;
  const visibilityValues = ['private', 'conversation', 'workspace'] as const;
  const conversationKind = row.conversationKind as typeof kinds[number];
  const visibility = row.visibility as typeof visibilityValues[number];
  if (!kinds.includes(conversationKind) || !visibilityValues.includes(visibility)) {
    throw new TypeError('Invalid conversation resource scope');
  }
  return {
    conversationId: stringField(row.conversationId, 'conversationId'),
    conversationKind,
    personaId: row.personaId === null ? null : stringField(row.personaId, 'personaId'),
    visibility,
  };
}

function decodeConversationMessage(value: unknown): ConversationMessageFeatureRecord {
  const row = object(value, 'Conversation message');
  if (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'tool') {
    throw new TypeError('Invalid conversation message role');
  }
  if (row.status !== 'active' && row.status !== 'revoked') {
    throw new TypeError('Invalid conversation message status');
  }
  return {
    id: stringField(row.id, 'message id'),
    eventId: stringField(row.eventId, 'eventId'),
    role: row.role,
    content: stringField(row.content, 'message content', true),
    occurredAt: timeField(row.occurredAt, 'occurredAt')!,
    status: row.status,
    ...(row.sourceRefs === undefined
      ? {}
      : { sourceRefs: decodeConversationSourceRefs(row.sourceRefs, 'message sourceRefs') }),
    scope: decodeConversationResourceScope(row.scope),
  };
}

function decodeConversationMemory(
  value: unknown,
  isHit: boolean,
): ConversationMemoryFeatureRecord {
  const row = object(value, 'Conversation memory');
  const id = row.id === undefined || row.id === null ? undefined : stringField(row.id, 'memory id');
  const memoryId = row.memoryId === undefined || row.memoryId === null
    ? undefined
    : stringField(row.memoryId, 'memoryId');
  if (id === undefined && memoryId === undefined) throw new TypeError('Conversation memory omitted its identity');
  const kinds = ['fact', 'preference', 'commitment', 'episode'] as const;
  if (!kinds.includes(row.kind as typeof kinds[number])) throw new TypeError('Invalid conversation memory kind');
  const state = row.state;
  if (state !== undefined && !['active', 'invalidated', 'deleted'].includes(String(state))) {
    throw new TypeError('Invalid conversation memory state');
  }
  if (!Array.isArray(row.sourceMessageIds) || row.sourceMessageIds.length > 32_768) {
    throw new TypeError('Invalid conversation memory source message ids');
  }
  const memory: ConversationMemoryFeatureRecord = {
    ...(id === undefined ? {} : { id }),
    ...(memoryId === undefined ? {} : { memoryId }),
    version: timeField(row.version, 'memory version')!,
    kind: row.kind as ConversationMemoryFeatureRecord['kind'],
    text: stringField(row.text, 'memory text', true),
    sourceMessageIds: row.sourceMessageIds.map((item, index) => stringField(item, `sourceMessageIds[${index}]`)),
    ...(row.sourceRefs === undefined
      ? {}
      : { sourceRefs: decodeConversationSourceRefs(row.sourceRefs, 'memory sourceRefs') }),
    scope: decodeConversationResourceScope(row.scope),
    ...(row.authorizationEpoch === undefined
      ? {}
      : { authorizationEpoch: timeField(row.authorizationEpoch, 'authorizationEpoch')! }),
    ...(state === undefined ? {} : { state: state as ConversationMemoryFeatureRecord['state'] }),
    ...(row.score === undefined ? {} : { score: finiteNumber(row.score, 'memory score') }),
    ...(row.stale === undefined ? {} : { stale: booleanField(row.stale, 'memory stale') }),
  };
  if (!isHit && memory.state === undefined) {
    throw new TypeError('Conversation memory record omitted its state');
  }
  return memory;
}

function decodeTask(value: unknown): TaskRecord {
  const row = object(value, 'Work Task');
  const statuses: ExecutionStatus[] = [
    'queued', 'running', 'completed', 'failed', 'aborted', 'waiting_approval', 'waiting_input',
    'awaiting_user_authorization',
  ];
  if (!statuses.includes(row.status as ExecutionStatus)) throw new TypeError('Invalid Work Task status');
  const executionClass = row.executionClass === undefined ? 'foreground' : row.executionClass;
  if (executionClass !== 'foreground' && executionClass !== 'background') {
    throw new TypeError('Invalid Work Task executionClass');
  }
  const task: TaskRecord = {
    id: stringField(row.id, 'id'),
    sessionId: stringField(row.sessionId, 'sessionId'),
    prompt: stringField(row.prompt, 'prompt', true),
    status: row.status as ExecutionStatus,
    executionClass,
    createdAt: timeField(row.createdAt, 'createdAt')!,
    output: stringField(row.output, 'output', true),
    reasoning: stringField(row.reasoning, 'reasoning', true),
    durationMs: timeField(row.durationMs, 'durationMs')!,
  };
  const startedAt = timeField(row.startedAt, 'startedAt', true);
  const endedAt = timeField(row.endedAt, 'endedAt', true);
  const error = row.error === undefined || row.error === null ? undefined : stringField(row.error, 'error', true);
  const workspaceId = row.workspaceId === undefined ? undefined : stringField(row.workspaceId, 'workspaceId');
  const createdByActorId = row.createdByActorId === undefined
    ? undefined : stringField(row.createdByActorId, 'createdByActorId');
  const sequence = row.sequence === undefined ? undefined : timeField(row.sequence, 'sequence');
  const continuationOfTaskId = row.continuationOfTaskId === undefined
    ? undefined
    : row.continuationOfTaskId === null ? null : stringField(row.continuationOfTaskId, 'continuationOfTaskId');
  const continuationMode = row.continuationMode === undefined
    ? undefined
    : row.continuationMode === null ? null
        : row.continuationMode === 'read_only' ? 'read_only'
        : (() => { throw new TypeError('Invalid Work Task continuationMode'); })();
  const origin = row.origin === undefined || row.origin === null
    ? undefined : decodeTeamsPrivateTaskOrigin(row.origin);
  const metadata = row.metadata === undefined ? undefined : object(row.metadata, 'Work Task metadata');
  return {
    ...task,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(error === undefined ? {} : { error }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(createdByActorId === undefined ? {} : { createdByActorId }),
    ...(sequence === undefined ? {} : { sequence }),
    ...(continuationOfTaskId === undefined ? {} : { continuationOfTaskId }),
    ...(continuationMode === undefined ? {} : { continuationMode }),
    ...(origin === undefined ? {} : { origin }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function decodeTeamsPrivateTaskOrigin(value: unknown): TeamsPrivateTaskOrigin {
  const row = object(value, 'Work private Teams task origin');
  if (Object.keys(row).sort().join(',') !== 'actorAadObjectId,botAppId,kind,messageId,tenantId'
    || row.kind !== 'teams_private') {
    throw new TypeError('Invalid Work private Teams task origin');
  }
  const actorAadObjectId = boundedString(row.actorAadObjectId, 'private Teams origin actor', 36).toLowerCase();
  const tenantId = boundedString(row.tenantId, 'private Teams origin tenant', 36).toLowerCase();
  const botAppId = boundedString(row.botAppId, 'private Teams origin bot app', 36).toLowerCase();
  if (!isUuid(actorAadObjectId) || !isUuid(tenantId) || !isUuid(botAppId)) {
    throw new TypeError('Invalid Work private Teams task origin identity');
  }
  return {
    kind: 'teams_private',
    messageId: boundedString(row.messageId, 'private Teams origin message id', 512),
    tenantId,
    botAppId,
    actorAadObjectId,
  };
}

function decodeBackendSession(value: unknown): BackendSessionRecord {
  const row = object(value, 'Work backend session');
  if (row.backend !== 'codebuddy-acp' && row.backend !== 'antigravity-acp') {
    throw new TypeError('Invalid Work backend session backend');
  }
  return {
    backend: row.backend,
    sessionId: stringField(row.sessionId, 'backend sessionId'),
    nativeSessionId: stringField(row.nativeSessionId, 'native sessionId'),
  };
}

function decodeEventPage(value: unknown): TaskEventPage {
  const row = object(value, 'Work Task event page');
  if (!Array.isArray(row.events)) throw new TypeError('Invalid Work Task events');
  const events = row.events.map(item => {
    const eventRow = object(item, 'Work Task event');
    const event = object(eventRow.event, 'Work Task event payload');
    const messageId = eventRow.messageId === undefined || eventRow.messageId === null ? undefined : stringField(eventRow.messageId, 'messageId');
    return {
      seq: timeField(eventRow.seq, 'event sequence')!,
      event,
      createdAt: timeField(eventRow.createdAt, 'event createdAt')!,
      ...(messageId === undefined ? {} : { messageId }),
    };
  });
  return { events, nextSeq: timeField(row.nextSeq, 'nextSeq')! };
}

function decodeUnresolvedOperation(value: unknown): UnresolvedOperationSummary {
  const row = object(value, 'Work unresolved operation');
  if (row.status !== 'started' && row.status !== 'uncertain') {
    throw new TypeError('Invalid Work unresolved operation status');
  }
  const taskId = row.taskId === undefined || row.taskId === null
    ? row.taskId as null | undefined
    : stringField(row.taskId, 'operation taskId');
  const target = row.target === undefined || row.target === null
    ? row.target as null | undefined
    : stringField(row.target, 'operation target');
  return {
    id: stringField(row.id, 'operation id'),
    operationType: stringField(row.operationType, 'operation type'),
    ...(taskId === undefined ? {} : { taskId }),
    ...(target === undefined ? {} : { target }),
    status: row.status,
    evidence: object(row.evidence, 'operation evidence'),
  };
}

/** Authenticated client for one configured workspace; callers cannot select another tenant.  中文：绑定单个配置 Workspace 的认证客户端；调用方无法选择其他租户。 */
export class WorkStateClient implements WorkStateStore {
  readonly tasksUrl: string;
  readonly workUrl: string;

  constructor(private readonly connection: WorkStateConnection) {
    const base = new URL(connection.baseUrl);
    if (base.username || base.password || base.search || base.hash) throw new Error('Invalid persistence base URL');
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
      throw new Error('Remote work-state persistence requires HTTPS; HTTP is limited to loopback');
    }
    if (!connection.workspaceId.trim()) throw new Error('A configured workspace is required');
    this.workUrl = `${base.href.replace(/\/$/, '')}/api/v1/workspaces/${encodeURIComponent(connection.workspaceId)}/work`;
    this.tasksUrl = `${this.workUrl}/tasks`;
  }

  /** Read image bytes after Work authorizes the exact attachment digest for this principal. */
  async readAttachment(artifactId: string, signal?: AbortSignal): Promise<WorkAttachmentBytes> {
    if (!/^[0-9a-f]{64}$/u.test(artifactId)) throw new TypeError('Invalid Work attachment id');
    const tokenEnv = this.connection.tokenEnv ?? 'CYRENE_SESSION_TOKEN';
    const token = process.env[tokenEnv];
    if (!token) throw new Error(`Missing persistence credential in ${tokenEnv}`);
    const url = `${this.workUrl}/attachments/${encodeURIComponent(artifactId)}`;
    const timeout = AbortSignal.timeout(this.connection.requestTimeoutMs ?? 10_000);
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: [...WORK_IMAGE_MIME_TYPES].join(', ') },
      signal: requestSignal,
      redirect: 'error',
    });
    if (!response.ok) {
      const text = await response.text();
      let value: unknown;
      try { value = text.length === 0 ? {} : JSON.parse(text); } catch { value = {}; }
      throw new WorkStateHttpError(response.status, errorCode(value));
    }
    const mimeType = (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
    if (!WORK_IMAGE_MIME_TYPES.has(mimeType)) throw new WorkStateHttpError(415, 'WORK_ATTACHMENT_MEDIA_TYPE_UNSUPPORTED');
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > WORK_ATTACHMENT_LIMIT_BYTES) {
      throw new WorkStateHttpError(413, 'WORK_ATTACHMENT_INVALID_SIZE');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > WORK_ATTACHMENT_LIMIT_BYTES) {
      throw new WorkStateHttpError(413, 'WORK_ATTACHMENT_INVALID_SIZE');
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== artifactId) throw new WorkStateHttpError(502, 'WORK_ATTACHMENT_DIGEST_MISMATCH');
    return {
      artifactId,
      sha256: digest,
      name: artifactId,
      mimeType,
      size: bytes.byteLength,
      bytes,
    };
  }

  /** Store generated PNG bytes through the same actor-bound Work API. */
  async writeAttachment(
    bytes: Uint8Array,
    mimeType: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<WorkAttachmentRecord> {
    const normalizedMimeType = mimeType.trim().toLowerCase();
    if (normalizedMimeType !== 'image/png' || !WORK_IMAGE_MIME_TYPES.has(normalizedMimeType)) {
      throw new WorkStateHttpError(415, 'WORK_ATTACHMENT_MEDIA_TYPE_UNSUPPORTED');
    }
    if (bytes.byteLength === 0 || bytes.byteLength > WORK_ATTACHMENT_LIMIT_BYTES) {
      throw new WorkStateHttpError(413, 'WORK_ATTACHMENT_INVALID_SIZE');
    }
    const safeName = boundedString(name, 'attachment name', 512);
    const result = object(await this.requestAt(
      `${this.workUrl}/attachments`,
      'POST',
      { name: safeName, mediaType: normalizedMimeType, contentBase64: Buffer.from(bytes).toString('base64') },
      undefined,
      {},
      undefined,
      signal,
    ), 'Work attachment record');
    const artifactId = stringField(result.id, 'attachment id');
    const sha256 = stringField(result.sha256, 'attachment sha256');
    const returnedName = stringField(result.name, 'attachment name');
    const returnedMime = stringField(result.mediaType, 'attachment media type').toLowerCase();
    const size = countField(result.size, 'attachment size');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (artifactId !== digest || sha256 !== digest || size !== bytes.byteLength || returnedMime !== normalizedMimeType) {
      throw new WorkStateHttpError(502, 'WORK_ATTACHMENT_WRITE_READBACK_MISMATCH');
    }
    return { artifactId, sha256, name: returnedName, mimeType: returnedMime, size };
  }

  /** Recheck current source, persona, conversation, and authorization epoch for media bytes. */
  async authorizeConversationArtifact(
    request: WorkConversationArtifactAuthorization,
    signal?: AbortSignal,
  ): Promise<WorkConversationArtifactAuthorizationReceipt> {
    const value = object(await this.requestAt(
      `${this.workUrl}/conversation-memory/artifacts/authorize`,
      'POST',
      request,
      undefined,
      {},
      undefined,
      signal,
    ), 'Conversation artifact authorization');
    const allowed = value.allowed;
    const currentAuthorizationEpoch = timeField(
      value.currentAuthorizationEpoch,
      'currentAuthorizationEpoch',
    )!;
    if (typeof allowed !== 'boolean') throw new TypeError('Invalid conversation artifact authorization');
    if (!allowed) return { allowed, currentAuthorizationEpoch };
    const artifact = object(value.artifact, 'authorized Work attachment');
    const record = decodeWorkAttachment(artifact);
    if (record.artifactId !== request.artifactId) {
      throw new TypeError('Authorized Work attachment does not match the requested artifact');
    }
    return { allowed, currentAuthorizationEpoch, artifact: record };
  }

  /** Read actor-scoped conversation counts and the current authorization epoch. */
  async getConversationMemoryOverview(signal?: AbortSignal): Promise<{
    readonly authorizationEpoch: number;
    readonly counts: Readonly<{ messages: number; memories: number; sources: number }>;
  }> {
    const row = object(await this.requestAt(
      `${this.workUrl}/conversation-memory/overview`,
      'GET',
      undefined,
      undefined,
      {},
      undefined,
      signal,
    ), 'Conversation memory overview');
    const counts = object(row.counts, 'Conversation memory counts');
    return {
      authorizationEpoch: timeField(row.authorizationEpoch, 'authorizationEpoch')!,
      counts: {
        messages: countField(counts.messages, 'message count'),
        memories: countField(counts.memories, 'memory count'),
        sources: countField(counts.sources, 'source count'),
      },
    };
  }

  /** Read one exact active message through the authenticated actor-scoped Work route. */
  async getConversationMemoryMessage(input: {
    readonly messageId: string;
    readonly conversationId: string;
    readonly conversationKind: 'direct' | 'group' | 'channel';
    readonly personaId: string | null;
  }, signal?: AbortSignal): Promise<ConversationMessageFeatureRecord | undefined> {
    const query = new URLSearchParams({
      conversationId: boundedString(input.conversationId, 'conversation id', 512),
      conversationKind: input.conversationKind,
    });
    if (input.personaId !== null) query.set('personaId', boundedString(input.personaId, 'persona id', 512));
    try {
      const value = await this.requestAt(
        `${this.workUrl}/conversation-memory/messages/${encodeURIComponent(boundedString(input.messageId, 'conversation message id', 512))}?${query}`,
        'GET',
        undefined,
        undefined,
        {},
        undefined,
        signal,
      );
      return decodeConversationMessage(value);
    } catch (error: unknown) {
      if (error instanceof WorkStateHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Build the typed P2 API adapter for one already verified Work principal. */
  conversationMemoryApiV1(actorId: string): ConversationMemoryApiV1 {
    const expectedActor = boundedString(actorId, 'conversation memory actor id', 512).toLowerCase();
    const base = `${this.workUrl}/conversation-memory`;
    const assertScope = (context: TrustedTurnContext): void => {
      if (context.workspaceId !== this.connection.workspaceId
        || context.actorId.toLowerCase() !== expectedActor) {
        throw new WorkStateHttpError(403, 'CONVERSATION_MEMORY_ACTOR_SCOPE_MISMATCH');
      }
      context.signal.throwIfAborted();
    };
    const cursorQuery = (input: {
      readonly conversationId: string;
      readonly conversationKind: string;
      readonly order: 'desc';
      readonly cursor?: string;
      readonly limit: number;
      readonly includeRevoked?: boolean;
    }): string => {
      const query = new URLSearchParams({
        conversationId: input.conversationId,
        conversationKind: input.conversationKind,
        order: input.order,
        limit: String(Math.min(input.limit, 100)),
      });
      if (input.cursor !== undefined) query.set('cursor', input.cursor);
      if (input.includeRevoked !== undefined) query.set('includeRevoked', String(input.includeRevoked));
      return query.toString();
    };
    const api: ConversationMemoryApiV1 = {
      apiVersion: 1,
      createMessage: async (context, input) => {
        assertScope(context);
        const receipt = object(await this.requestAt(
          `${base}/messages`,
          'POST',
          input,
          undefined,
          {},
          undefined,
          context.signal,
        ), 'Conversation message receipt');
        if (typeof receipt.duplicate !== 'boolean') throw new TypeError('Invalid conversation message duplicate flag');
        return {
          message: decodeConversationMessage(receipt.message),
          duplicate: receipt.duplicate,
        };
      },
      listMessages: async (context, input) => {
        assertScope(context);
        const row = object(await this.requestAt(
          `${base}/messages?${cursorQuery(input)}`,
          'GET',
          undefined,
          undefined,
          {},
          undefined,
          context.signal,
        ), 'Conversation message page');
        if (!Array.isArray(row.items)) throw new TypeError('Invalid conversation message page items');
        const nextCursor = row.nextCursor === null || row.nextCursor === undefined
          ? null
          : stringField(row.nextCursor, 'conversation nextCursor');
        return {
          items: row.items.map(decodeConversationMessage),
          nextCursor,
        };
      },
      listMemories: async (context, input) => {
        assertScope(context);
        const query = new URLSearchParams({
          conversationId: input.conversationId,
          conversationKind: input.conversationKind,
          state: input.state,
          limit: String(Math.min(input.limit, 500)),
        });
        if (input.personaId !== null) query.set('personaId', input.personaId);
        const row = object(await this.requestAt(
          `${base}/memories?${query}`,
          'GET',
          undefined,
          undefined,
          {},
          undefined,
          context.signal,
        ), 'Conversation memory page');
        if (!Array.isArray(row.items)) throw new TypeError('Invalid conversation memory items');
        return {
          items: row.items.map(value => decodeConversationMemory(value, false)),
          authorizationEpoch: timeField(row.authorizationEpoch, 'authorizationEpoch')!,
        };
      },
      queryMemories: async (context, input) => {
        assertScope(context);
        const row = object(await this.requestAt(
          `${base}/memories/query`,
          'POST',
          input,
          undefined,
          {},
          undefined,
          context.signal,
        ), 'Conversation memory query result');
        if (!Array.isArray(row.items)) throw new TypeError('Invalid conversation memory query items');
        return {
          items: row.items.map(value => decodeConversationMemory(value, true)),
          authorizationEpoch: timeField(row.authorizationEpoch, 'authorizationEpoch')!,
        };
      },
      createMemory: async (context, input) => {
        assertScope(context);
        const receipt = object(await this.requestAt(
          `${base}/memories`,
          'POST',
          input,
          undefined,
          {},
          undefined,
          context.signal,
        ), 'Conversation memory receipt');
        if (typeof receipt.duplicate !== 'boolean') throw new TypeError('Invalid conversation memory duplicate flag');
        return {
          memory: decodeConversationMemory(receipt.memory, false),
          duplicate: receipt.duplicate,
        };
      },
      updateMemory: async (context, memoryId, input) => {
        assertScope(context);
        const receipt = object(await this.requestAt(
          `${base}/memories/${encodeURIComponent(boundedString(memoryId, 'memory id', 512))}`,
          'PATCH',
          input,
          undefined,
          {},
          undefined,
          context.signal,
        ), 'Conversation memory update receipt');
        if (typeof receipt.duplicate !== 'boolean') throw new TypeError('Invalid conversation memory duplicate flag');
        return {
          memory: decodeConversationMemory(receipt.memory, false),
          duplicate: receipt.duplicate,
        };
      },
      deleteMemory: async (context, memoryId, expectedVersion) => {
        assertScope(context);
        const query = new URLSearchParams({ expectedVersion: String(expectedVersion) });
        const receipt = object(await this.requestAt(
          `${base}/memories/${encodeURIComponent(boundedString(memoryId, 'memory id', 512))}?${query}`,
          'DELETE',
          undefined,
          undefined,
          {},
          undefined,
          context.signal,
        ), 'Conversation memory delete receipt');
        if (typeof receipt.deleted !== 'boolean' || typeof receipt.duplicate !== 'boolean') {
          throw new TypeError('Invalid conversation memory delete result');
        }
        return {
          deleted: receipt.deleted,
          duplicate: receipt.duplicate,
          authorizationEpoch: timeField(receipt.authorizationEpoch, 'authorizationEpoch')!,
        };
      },
      revokeSource: async (context, sourceId) => {
        assertScope(context);
        const receipt = object(await this.requestAt(
          `${base}/sources/${encodeURIComponent(boundedString(sourceId, 'source id', 512))}/revoke`,
          'POST',
          {},
          undefined,
          {},
          undefined,
          context.signal,
        ), 'Conversation source revocation receipt');
        if (!Array.isArray(receipt.invalidatedMessageIds) || !Array.isArray(receipt.invalidatedMemoryIds)) {
          throw new TypeError('Invalid conversation source invalidation result');
        }
        return {
          sourceId: stringField(receipt.sourceId, 'sourceId'),
          authorizationEpoch: timeField(receipt.authorizationEpoch, 'authorizationEpoch')!,
          invalidatedCount: countField(receipt.invalidatedCount, 'invalidatedCount'),
          invalidatedMessageIds: receipt.invalidatedMessageIds.map((item, index) => stringField(item, `invalidatedMessageIds[${index}]`)),
          invalidatedMemoryIds: receipt.invalidatedMemoryIds.map((item, index) => stringField(item, `invalidatedMemoryIds[${index}]`)),
        };
      },
      authorizeSources: async (context, input) => {
        assertScope(context);
        const receipt = object(await this.requestAt(
          `${base}/sources/authorize`,
          'POST',
          input,
          undefined,
          {},
          undefined,
          context.signal,
        ), 'Conversation source authorization');
        if (typeof receipt.allowed !== 'boolean' || !Array.isArray(receipt.deniedSourceIds)) {
          throw new TypeError('Invalid conversation source authorization receipt');
        }
        return {
          allowed: receipt.allowed,
          currentAuthorizationEpoch: timeField(receipt.currentAuthorizationEpoch, 'currentAuthorizationEpoch')!,
          deniedSourceIds: receipt.deniedSourceIds.map((item, index) => stringField(item, `deniedSourceIds[${index}]`)),
        };
      },
    };
    return Object.freeze(api);
  }

  /** Read one actor-owned maintenance job for trusted DSH recovery and CAS. */
  async getConversationMaintenanceJob(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<ConversationMaintenanceJobRecord | undefined> {
    const safeJobId = encodeURIComponent(boundedString(jobId, 'maintenance job id', 200));
    try {
      const value = await this.requestAt(
        `${this.workUrl}/conversation-memory/maintenance/jobs/${safeJobId}`,
        'GET',
        undefined,
        undefined,
        {},
        undefined,
        signal,
      );
      return decodeConversationMaintenanceJob(value);
    } catch (error) {
      if (error instanceof WorkStateHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Persist one DSH worker checkpoint using the current actor-scoped writer credential. */
  async checkpointConversationMaintenanceJob(
    jobId: string,
    expectedVersion: number,
    checkpoint: ConversationMaintenanceCheckpoint,
    signal?: AbortSignal,
  ): Promise<ConversationMaintenanceJobRecord> {
    const safeJobId = encodeURIComponent(boundedString(jobId, 'maintenance job id', 200));
    const receipt = object(await this.requestAt(
      `${this.workUrl}/conversation-memory/maintenance/jobs/${safeJobId}/checkpoint`,
      'PATCH',
      { expectedVersion, checkpoint },
      undefined,
      {},
      undefined,
      signal,
    ), 'Conversation maintenance checkpoint receipt');
    return decodeConversationMaintenanceJob(receipt.job);
  }

  /** Cancel an actor-owned queued or running maintenance job with version CAS. */
  async cancelConversationMaintenanceJob(
    jobId: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<ConversationMaintenanceJobRecord> {
    const safeJobId = encodeURIComponent(boundedString(jobId, 'maintenance job id', 200));
    const receipt = object(await this.requestAt(
      `${this.workUrl}/conversation-memory/maintenance/jobs/${safeJobId}/cancel`,
      'POST',
      { expectedVersion },
      undefined,
      {},
      undefined,
      signal,
    ), 'Conversation maintenance cancellation receipt');
    return decodeConversationMaintenanceJob(receipt.job);
  }

  /** Create one durable task. The server binds organization and workspace from the bearer principal.  中文：创建持久任务；服务端从 bearer principal 绑定组织和 Workspace。 */
  async createTask(input: {
    id?: string;
    sessionId: string;
    prompt: string;
    executionClass?: ExecutionClass;
    metadata?: Readonly<Record<string, unknown>>;
  }): Promise<TaskRecord> {
    return decodeTask(await this.request('', 'POST', input));
  }

  /** Ask Work to create a server-linked read-only task from one owned authorization wait. */
  async createContinuationTask(
    sourceTaskId: string,
    input: { prompt: string; idempotencyKey: string },
  ): Promise<TaskRecord> {
    if (!input.idempotencyKey || input.idempotencyKey.length > 200
      || /[\u0000-\u001f\u007f]/u.test(input.idempotencyKey)) {
      throw new TypeError('Invalid continuation Idempotency-Key');
    }
    const receipt = object(await this.request(
      '/' + encodeURIComponent(sourceTaskId) + '/resume',
      'POST',
      { prompt: input.prompt },
      undefined,
      { 'idempotency-key': input.idempotencyKey },
    ), 'Work Task continuation receipt');
    const task = decodeTask(receipt.task);
    if (task.continuationOfTaskId !== sourceTaskId || task.continuationMode !== 'read_only') {
      throw new TypeError('Work service does not support atomic read-only task continuation');
    }
    return task;
  }

  /** Confirm that this persistence principal owns the paused source before Exchange revalidation. */
  async verifyContinuationOwnership(sourceTaskId: string): Promise<void> {
    await this.request('/' + encodeURIComponent(sourceTaskId) + '/resume/check', 'POST');
  }

  /** Read one task; cross-workspace identities are intentionally indistinguishable from missing IDs.  中文：读取任务；跨 Workspace 的标识按不存在处理。 */
  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    try {
      return decodeTask(await this.request(`/${encodeURIComponent(taskId)}`, 'GET'));
    } catch (error) {
      if (error instanceof WorkStateHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Read the native ACP session mapped to the currently running Work Task. */
  async getBackendSession(
    taskId: string,
    backend: WorkExecutionBackend = 'codebuddy-acp',
  ): Promise<BackendSessionRecord | undefined> {
    const value = await this.request(
      `/${encodeURIComponent(taskId)}/backend-session?backend=${encodeURIComponent(backend)}`,
      'GET',
    );
    if (value === null) return undefined;
    return decodeBackendSession(value);
  }

  /** Bind one native ACP identity without allowing a Work session mapping to be replaced. */
  async bindBackendSession(
    taskId: string,
    nativeSessionId: string,
    backend: WorkExecutionBackend = 'codebuddy-acp',
  ): Promise<BackendSessionRecord> {
    return decodeBackendSession(await this.request(
      `/${encodeURIComponent(taskId)}/backend-session`,
      'PUT',
      { backend, nativeSessionId },
    ));
  }

  /** List the configured Workspace's durable tasks.  中文：列出配置 Workspace 的持久任务。 */
  async listTasks(options: { cursor?: string; limit?: number } = {}): Promise<TaskPage> {
    const query = new URLSearchParams();
    if (options.cursor) query.set('cursor', options.cursor);
    if (options.limit !== undefined) query.set('limit', String(Math.min(options.limit, 100)));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const row = object(await this.request(suffix, 'GET'), 'Work Task page');
    if (!Array.isArray(row.items)) throw new TypeError('Invalid Work Task page items');
    if (row.nextCursor !== null && row.nextCursor !== undefined && typeof row.nextCursor !== 'string') {
      throw new TypeError('Invalid Work Task page cursor');
    }
    return { items: row.items.map(decodeTask), nextCursor: (row.nextCursor as string | null | undefined) ?? null };
  }

  /** List tasks owned by this actor principal, independent of broader workspace list behavior. */
  async listOwnedTasks(options: { cursor?: string; limit?: number } = {}): Promise<TaskPage> {
    const query = new URLSearchParams();
    if (options.cursor) query.set('cursor', options.cursor);
    if (options.limit !== undefined) query.set('limit', String(Math.min(options.limit, 50)));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const row = object(await this.requestAt(`${this.tasksUrl}/owned${suffix}`, 'GET'), 'Owned Work Task page');
    if (!Array.isArray(row.items)) throw new TypeError('Invalid owned Work Task page items');
    if (row.nextCursor !== null && row.nextCursor !== undefined && typeof row.nextCursor !== 'string') {
      throw new TypeError('Invalid owned Work Task cursor');
    }
    const items = row.items.map(decodeTask);
    if (items.some(item => item.createdByActorId === undefined)) throw new TypeError('Owned Task page omitted the server actor identity');
    return { items, nextCursor: (row.nextCursor as string | null | undefined) ?? null };
  }

  /** Atomically claim a queued task so only one executor process can run it.  中文：原子认领排队任务，确保只有一个执行器进程启动它。 */
  async claimTask(taskId: string): Promise<{ claimed: boolean; task: TaskRecord }> {
    const row = object(await this.request(`/${encodeURIComponent(taskId)}/claim`, 'POST', {}), 'Work Task claim');
    if (typeof row.claimed !== 'boolean') throw new TypeError('Invalid Work Task claim result');
    return { claimed: row.claimed, task: decodeTask(row.task) };
  }

  /** Update a task atomically through the Work service transition validator.  中文：由 Work service 原子校验并更新任务状态。 */
  async patchTask(
    taskId: string,
    patch: Partial<Omit<TaskRecord, 'id' | 'workspaceId' | 'sequence'>>,
  ): Promise<TaskRecord> {
    return decodeTask(await this.request(`/${encodeURIComponent(taskId)}`, 'PATCH', patch));
  }

  /** Append one idempotent event to the durable task timeline.  中文：向持久任务时间线追加一条幂等事件。 */
  async appendEvent(taskId: string, event: Record<string, unknown>, messageId = randomUUID()): Promise<DurableTaskEvent> {
    boundedString(messageId, 'messageId', 512);
    const payload = { event, messageId };
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const row = object(await this.request(`/${encodeURIComponent(taskId)}/events`, 'POST', payload), 'Work Task event');
        const eventValue = object(row.event, 'Work Task event payload');
        return {
          seq: timeField(row.seq, 'event sequence')!,
          event: eventValue,
          createdAt: timeField(row.createdAt, 'event createdAt')!,
          messageId,
        };
      } catch (error) {
        lastError = error;
        if (error instanceof WorkStateHttpError && error.status < 500) throw error;
      }
    }
    throw lastError;
  }

  /** Replay the durable event suffix after an exclusive sequence cursor.  中文：按排他序号游标重放持久事件后缀。 */
  async getEvents(taskId: string, after = 0): Promise<TaskEventPage> {
    const query = new URLSearchParams({ after: String(after) });
    return decodeEventPage(await this.request(`/${encodeURIComponent(taskId)}/events?${query}`, 'GET'));
  }

  /** Read scoped unresolved operation receipts without exposing their original arguments. */
  async listUnresolvedOperations(
    options: { target?: string; limit?: number } = {},
  ): Promise<readonly UnresolvedOperationSummary[]> {
    const query = new URLSearchParams({ limit: String(Math.min(Math.max(options.limit ?? 100, 1), 500)) });
    if (options.target !== undefined) query.set('target', boundedString(options.target, 'operation target', 2_000));
    const row = object(await this.request(`/operations/unresolved?${query}`, 'GET'), 'Work unresolved operations');
    if (!Array.isArray(row.items)) throw new TypeError('Invalid Work unresolved operations');
    return row.items.map(decodeUnresolvedOperation);
  }

  /** Deduplicate an inbound event and persist its task admission atomically. */
  async registerConnectorEvent(input: ConnectorEventInput): Promise<ConnectorEventReceipt> {
    if (input.teamsPrivateMessage !== undefined && input.task === undefined) {
      throw new TypeError('Private Teams events require an actor-owned Task in the same admission.');
    }
    const row = object(await this.requestAt(
      `${this.workUrl}/connectors/${encodeURIComponent(safeIdentifier(input.connectorId, 'connectorId'))}/events`,
      'POST',
      {
        messageId: boundedString(input.messageId, 'messageId', 512),
        type: boundedString(input.type, 'type', 256),
        ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.senderId === undefined ? {} : { senderId: input.senderId }),
        payload: input.payload,
        ...(input.teamsPrivateMessage === undefined ? {} : {
          teamsPrivateMessage: {
            messageId: boundedString(input.teamsPrivateMessage.messageId, 'private Teams message id', 512),
            text: boundedThreadMessageText(input.teamsPrivateMessage.text, 'private Teams message text', 20_000),
          },
        }),
        ...(input.teamsThreadMessage === undefined ? {} : { teamsThreadMessage: input.teamsThreadMessage }),
        ...(input.task === undefined ? {} : { task: input.task }),
      },
    ), 'Work connector event receipt');
    if (typeof row.eventId !== 'string' || typeof row.duplicate !== 'boolean'
      || typeof row.receivedAt !== 'number' || !Number.isSafeInteger(row.receivedAt)) {
      throw new TypeError('Invalid Work connector event receipt');
    }
    return {
      eventId: row.eventId,
      duplicate: row.duplicate,
      receivedAt: row.receivedAt,
      ...(row.task === undefined || row.task === null ? {} : { task: decodeTask(row.task) }),
    };
  }

  /** Read the exact durable Teams thread mapping and bounded participant context. */
  async getConnectorThread(
    connectorId: string,
    threadId: string,
    messageLimit = 20,
    excludeMessageId?: string,
  ): Promise<ConnectorThreadRecord> {
    const query = new URLSearchParams({ message_limit: String(Math.min(Math.max(messageLimit, 1), 100)) });
    if (excludeMessageId !== undefined) query.set('exclude_message_id', boundedString(excludeMessageId, 'excludeMessageId', 512));
    const row = object(await this.requestAt(
      `${this.workUrl}/connectors/${encodeURIComponent(safeIdentifier(connectorId, 'connectorId'))}/threads/${encodeURIComponent(boundedString(threadId, 'threadId', 128))}?${query}`,
      'GET',
    ), 'Work connector thread');
    if (!Array.isArray(row.messages)) throw new TypeError('Invalid Work connector thread messages');
    const messages = row.messages.map(item => {
      const message = object(item, 'Work connector thread message');
      return {
        messageId: boundedString(message.messageId, 'thread message id', 512),
        actorIssuer: boundedString(message.actorIssuer, 'thread actor issuer', 512),
        actorSubject: boundedString(message.actorSubject, 'thread actor subject', 256),
        text: boundedThreadMessageText(message.text, 'thread message text', 20_000),
        createdAt: timeField(message.createdAt, 'thread message createdAt')!,
      };
    });
    const serviceUrl = row.serviceUrl ?? '';
    if (typeof serviceUrl !== 'string' || serviceUrl.length > 512) {
      throw new TypeError('Invalid Work connector thread serviceUrl');
    }
    return {
      threadId: boundedString(row.threadId, 'threadId', 128),
      tenantId: boundedString(row.tenantId, 'tenantId', 128),
      teamId: boundedString(row.teamId, 'teamId', 512),
      channelId: boundedString(row.channelId, 'channelId', 512),
      conversationId: boundedString(row.conversationId, 'conversationId', 512),
      rootThreadId: boundedString(row.rootThreadId, 'rootThreadId', 512),
      serviceUrl,
      ...(typeof row.sessionId === 'string' ? { sessionId: boundedString(row.sessionId, 'sessionId', 512) } : {}),
      messages,
    };
  }

  /** Lease one connector's durable messages; expired started sends are never replayed. */
  async claimNotifications(input: {
    workerId: string; limit: number; leaseSeconds: number; type: string; connectorId: string; recipient?: string;
  }): Promise<readonly NotificationLease[]> {
    const row = object(await this.requestAt(`${this.workUrl}/notifications/claim`, 'POST', input), 'Work notification claim');
    if (!Array.isArray(row.items)) throw new TypeError('Invalid Work notification claim response');
    return row.items.map(item => {
      const lease = object(item, 'Work notification lease');
      const notice = object(lease.notification, 'Work notification');
      const payload = object(notice.payload, 'Work notification payload');
      const status = notice.status;
      if (!['queued', 'leased', 'started', 'uncertain', 'delivered', 'failed'].includes(String(status))) {
        throw new TypeError('Invalid Work notification state');
      }
      if (notice.type !== input.type || notice.connectorId !== input.connectorId
        || (input.recipient !== undefined && notice.recipient !== input.recipient)) {
        throw new TypeError('Work returned a notification outside the requested connector scope');
      }
      return {
        notification: {
          id: boundedString(notice.id, 'notification id', 512),
          deduplicationKey: boundedString(notice.deduplicationKey, 'deduplication key', 512),
          type: String(notice.type), payload,
          ...(typeof notice.taskId === 'string' ? { taskId: notice.taskId } : {}),
          ...(typeof notice.connectorId === 'string' ? { connectorId: notice.connectorId } : {}),
          ...(typeof notice.recipient === 'string' ? { recipient: notice.recipient } : {}),
          status: status as NotificationLease['notification']['status'],
          result: notice.result === undefined ? {} : object(notice.result, 'Work notification result'),
        },
        leaseToken: boundedString(lease.leaseToken, 'notification lease token', 512),
      };
    });
  }

  /** Lease only owner-private notices under the dedicated private bridge capability. */
  async claimPrivateNotifications(input: {
    workerId: string; limit: number; leaseSeconds: number; type: string; connectorId: string;
  }): Promise<readonly NotificationLease[]> {
    const row = object(await this.requestPrivate('/private-notifications/claim', 'POST', input), 'Private notification claim');
    if (!Array.isArray(row.items)) throw new TypeError('Invalid private notification claim response');
    return row.items.map(item => {
      const lease = object(item, 'Private notification lease');
      const notice = object(lease.notification, 'Private notification');
      const route = decodeTeamsPersonalNotificationRoute(lease.teamsPersonalRoute);
      const status = notice.status;
      if (!['queued', 'leased', 'started', 'uncertain', 'delivered', 'failed'].includes(String(status))) {
        throw new TypeError('Invalid private notification state');
      }
      if (notice.type !== input.type || notice.connectorId !== input.connectorId) {
        throw new TypeError('Work returned a private notification outside the requested connector scope');
      }
      return {
        notification: {
          id: boundedString(notice.id, 'private notification id', 512),
          deduplicationKey: boundedString(notice.deduplicationKey, 'private notification deduplication key', 512),
          type: String(notice.type),
          payload: object(notice.payload, 'private notification payload'),
          ...(typeof notice.taskId === 'string' ? { taskId: notice.taskId } : {}),
          ...(typeof notice.connectorId === 'string' ? { connectorId: notice.connectorId } : {}),
          ...(typeof notice.recipient === 'string' ? { recipient: notice.recipient } : {}),
          status: status as NotificationLease['notification']['status'],
          result: notice.result === undefined ? {} : object(notice.result, 'private notification result'),
        },
        leaseToken: boundedString(lease.leaseToken, 'private notification lease token', 512),
        teamsPersonalRoute: route,
      };
    });
  }

  /** Persist a verified personal-install event using the separately scoped Work bridge bearer. */
  async registerTeamsPrivateInstallation(event: TeamsPrivateInstallationEvent): Promise<TeamsPrivateInstallationReceipt> {
    validateTeamsPrivateInstallationEvent(event);
    const row = object(await this.requestPrivate('/private-installations/events', 'POST', event), 'Private installation receipt');
    if ((row.action !== 'add' && row.action !== 'remove') || typeof row.active !== 'boolean'
      || typeof row.applied !== 'boolean' || typeof row.duplicate !== 'boolean') {
      throw new TypeError('Invalid private installation receipt');
    }
    return {
      action: row.action,
      active: row.active,
      applied: row.applied,
      revision: countField(row.revision, 'private installation revision'),
      updatedAt: timeField(row.updatedAt, 'private installation updatedAt')!,
      duplicate: row.duplicate,
    };
  }

  /** Atomically checkpoint Exchange health and enqueue its incident transitions. */
  async processCredentialHealthSnapshots(
    organizationId: string,
    connections: readonly CredentialHealthSnapshot[],
  ): Promise<{ readonly processed: number; readonly stale: number; readonly notificationsQueued: number }> {
    const row = object(await this.requestAt(
      `${this.workUrl}/credential-health/snapshots`,
      'POST',
      { organizationId, connections },
    ), 'Work credential health receipt');
    return {
      processed: countField(row.processed, 'processed'),
      stale: countField(row.stale, 'stale'),
      notificationsQueued: countField(row.notificationsQueued, 'notificationsQueued'),
    };
  }

  async startNotification(notificationId: string, leaseToken: string): Promise<void> {
    await this.requestAt(`${this.workUrl}/notifications/${encodeURIComponent(notificationId)}/start`, 'POST', { leaseToken });
  }

  async finishNotification(
    notificationId: string,
    leaseToken: string,
    outcome: 'delivered' | 'failed' | 'uncertain' | 'retry',
    result: Readonly<Record<string, unknown>> = {},
    retryAfterSeconds?: number,
  ): Promise<void> {
    await this.requestAt(`${this.workUrl}/notifications/${encodeURIComponent(notificationId)}/finish`, 'POST', {
      leaseToken,
      outcome,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      result,
    });
  }

  async startPrivateNotification(notificationId: string, leaseToken: string): Promise<void> {
    await this.requestPrivate(`/notifications/${encodeURIComponent(notificationId)}/start`, 'POST', { leaseToken });
  }

  async finishPrivateNotification(
    notificationId: string,
    leaseToken: string,
    outcome: 'delivered' | 'failed' | 'uncertain' | 'retry',
    result: Readonly<Record<string, unknown>> = {},
    retryAfterSeconds?: number,
  ): Promise<void> {
    await this.requestPrivate(`/notifications/${encodeURIComponent(notificationId)}/finish`, 'POST', {
      leaseToken,
      outcome,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      result,
    });
  }

  private async requestPrivate(path: string, method: string, body?: unknown): Promise<unknown> {
    return this.requestAt(`${this.workUrl}${path}`, method, body, undefined, {},
      this.connection.privateBridgeTokenEnv ?? 'CYRENE_PRIVATE_TEAMS_BRIDGE_TOKEN');
  }

  private async request(
    path: string,
    method: string,
    body?: unknown,
    timeoutMs?: number,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    return this.requestAt(this.tasksUrl + path, method, body, timeoutMs, extraHeaders);
  }

  private async requestAt(
    url: string,
    method: string,
    body?: unknown,
    timeoutMs?: number,
    extraHeaders: Readonly<Record<string, string>> = {},
    tokenEnvOverride?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const tokenEnv = tokenEnvOverride ?? this.connection.tokenEnv ?? 'CYRENE_SESSION_TOKEN';
    const token = process.env[tokenEnv];
    if (!token) throw new Error(`Missing persistence credential in ${tokenEnv}`);
    const requestTimeoutMs = timeoutMs ?? this.connection.requestTimeoutMs ?? 10_000;
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: requestSignal,
      redirect: 'error',
    });
    const text = await response.text();
    let value: unknown;
    try {
      value = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      throw new WorkStateHttpError(response.status, 'Work service returned invalid JSON');
    }
    if (!response.ok) throw new WorkStateHttpError(response.status, errorCode(value));
    return value;
  }
}

/** Host-private reference from one verified Teams actor to its server-issued Work bearer env. */
export interface WorkActorTokenReference {
  readonly actorAadObjectId: string;
  readonly tokenEnv: string;
}

/** Load a root-owned or owner-private map of actor ids to dedicated Work token environment names. */
export async function loadWorkActorTokenReferences(
  pathValue: string,
  expectedWorkspaceId: string,
): Promise<readonly WorkActorTokenReference[]> {
  if (typeof pathValue !== 'string' || !isAbsolute(pathValue) || pathValue.includes('..')
    || pathValue.length > 2_000) throw new TypeError('Work actor map path must be absolute and bounded');
  if (process.platform === 'win32') {
    throw new TypeError('Private Work actor maps are unsupported on Windows until ACL verification is available');
  }
  const path = pathValue;
  try {
    if (await realpath(path) !== path) throw new TypeError('Work actor map path must not use symlinks');
    const before = await lstat(path);
    const parentPath = dirname(path);
    const parent = await lstat(parentPath);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const currentGid = typeof process.getgid === 'function' ? process.getgid() : undefined;
    const mode = before.mode & 0o7777;
    const rootReadable = before.uid === 0 && mode === 0o640 && currentGid !== undefined && before.gid === currentGid;
    const ownerPrivate = currentUid !== undefined && before.uid === currentUid && mode === 0o600;
    if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > 64_000
      || (!rootReadable && !ownerPrivate) || !parent.isDirectory() || parent.isSymbolicLink()
      || parent.uid !== before.uid || (parent.mode & 0o022) !== 0 || await realpath(parentPath) !== parentPath) {
      throw new TypeError('Work actor map must be a bounded root-readable private file');
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: Uint8Array;
    try {
      const after = await handle.stat();
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
        || after.uid !== before.uid || after.gid !== before.gid || (after.mode & 0o7777) !== mode
        || after.size !== before.size) throw new TypeError('Work actor map changed while opening');
      raw = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (raw.byteLength !== before.size || raw.byteLength > 64_000) throw new TypeError('Work actor map exceeds its size limit');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown; }
    catch { throw new TypeError('Work actor map must be valid UTF-8 JSON'); }
    return decodeWorkActorTokenReferences(value, expectedWorkspaceId);
  } catch (error: unknown) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Work actor map is unavailable');
  }
}

export function decodeWorkActorTokenReferences(
  value: unknown,
  expectedWorkspaceId: string,
): readonly WorkActorTokenReference[] {
  const root = object(value, 'Work actor map');
  if (Object.keys(root).sort().join(',') !== 'actors,schemaVersion,workspaceId'
    || root.schemaVersion !== 1 || root.workspaceId !== expectedWorkspaceId
    || !Array.isArray(root.actors) || root.actors.length < 1 || root.actors.length > 5) {
    throw new TypeError('Work actor map must use the selected workspace and five-person schema version 1');
  }
  const actorIds = new Set<string>();
  const tokenEnvs = new Set<string>();
  return root.actors.map((value, index) => {
    const row = object(value, `Work actor map entry ${index}`);
    if (Object.keys(row).sort().join(',') !== 'actorAadObjectId,tokenEnv') {
      throw new TypeError(`Work actor map entry ${index} contains unsupported fields`);
    }
    const actorAadObjectId = boundedString(row.actorAadObjectId, 'Work actor AAD id', 36).toLowerCase();
    const tokenEnv = boundedString(row.tokenEnv, 'Work actor token environment reference', 128);
    if (!isUuid(actorAadObjectId) || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(tokenEnv)
      || ['CYRENE_SESSION_TOKEN', 'CYRENE_EXECUTOR_TOKEN', 'CYRENE_PRIVATE_TEAMS_BRIDGE_TOKEN'].includes(tokenEnv)
      || actorIds.has(actorAadObjectId) || tokenEnvs.has(tokenEnv)) {
      throw new TypeError(`Work actor map entry ${index} is invalid or reused`);
    }
    actorIds.add(actorAadObjectId);
    tokenEnvs.add(tokenEnv);
    return { actorAadObjectId, tokenEnv };
  });
}

/** Prebuilt Work clients for only the actors in the root-owned provisioned token map. */
export class WorkActorClientRegistry {
  private readonly clientsByActor = new Map<string, WorkStateClient>();
  private readonly tokenEnvsByActor = new Map<string, string>();

  constructor(
    connection: Omit<WorkStateConnection, 'tokenEnv' | 'privateBridgeTokenEnv'>,
    references: readonly WorkActorTokenReference[],
  ) {
    if (references.length > 5) throw new TypeError('Work actor token map exceeds the five-person pilot bound');
    const tokenEnvs = new Set<string>();
    for (const reference of references) {
      const actorAadObjectId = boundedString(reference.actorAadObjectId, 'Work actor AAD subject', 36).toLowerCase();
      if (!isUuid(actorAadObjectId) || this.clientsByActor.has(actorAadObjectId)) {
        throw new TypeError('Work actor token map contains an invalid or duplicate actor');
      }
      const tokenEnv = boundedString(reference.tokenEnv, 'Work actor token env reference', 128);
      if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(tokenEnv)
        || ['CYRENE_SESSION_TOKEN', 'CYRENE_EXECUTOR_TOKEN', 'CYRENE_PRIVATE_TEAMS_BRIDGE_TOKEN'].includes(tokenEnv)
        || tokenEnvs.has(tokenEnv)) {
        throw new TypeError('Work actor token references must be unique dedicated environment names');
      }
      tokenEnvs.add(tokenEnv);
      this.clientsByActor.set(actorAadObjectId, new WorkStateClient({ ...connection, tokenEnv }));
      this.tokenEnvsByActor.set(actorAadObjectId, tokenEnv);
    }
  }

  /** Resolve only an actor already present in the trusted host registry. */
  forActor(actorAadObjectId: string): WorkStateClient | undefined {
    return this.clientsByActor.get(actorAadObjectId.toLowerCase());
  }

  /** Resolve only the host-private environment reference for a verified configured actor. */
  tokenEnvForActor(actorAadObjectId: string): string | undefined {
    return this.tokenEnvsByActor.get(actorAadObjectId.toLowerCase());
  }

  /** Enumerate configured actor ids without returning token references or values. */
  actorIds(): readonly string[] {
    return [...this.clientsByActor.keys()];
  }

  /** Read a Task through actor-filtered clients and verify the server-owned creator field. */
  async resolveTask(taskId: string): Promise<{ readonly actorAadObjectId: string; readonly store: WorkStateClient; readonly task: TaskRecord } | undefined> {
    for (const [actorAadObjectId, store] of this.clientsByActor) {
      const task = await store.getTask(taskId);
      if (task === undefined) continue;
      if (task.createdByActorId?.toLowerCase() !== actorAadObjectId) {
        throw new Error('Work Task creator does not match its actor-scoped Work token.');
      }
      return { actorAadObjectId, store, task };
    }
    return undefined;
  }

  /** List each actor's own tasks for host recovery without asking Work for another actor ID. */
  async listOwnedTasks(): Promise<readonly { readonly actorAadObjectId: string; readonly store: WorkStateClient; readonly task: TaskRecord }[]> {
    const rows: { actorAadObjectId: string; store: WorkStateClient; task: TaskRecord }[] = [];
    for (const [actorAadObjectId, store] of this.clientsByActor) {
      let cursor: string | undefined;
      do {
        const page = await store.listOwnedTasks({ ...(cursor === undefined ? {} : { cursor }), limit: 50 });
        for (const task of page.items) {
          if (task.createdByActorId?.toLowerCase() !== actorAadObjectId) {
            throw new Error('Owned Work Task page contains a different creator.');
          }
          rows.push({ actorAadObjectId, store, task });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
    }
    return rows;
  }
}

function errorCode(value: unknown): string {
  try {
    const row = object(value, 'Work API error');
    return typeof row.code === 'string' ? row.code : `HTTP_ERROR`;
  } catch {
    return 'HTTP_ERROR';
  }
}

function decodeTeamsPersonalNotificationRoute(value: unknown): TeamsPersonalNotificationRoute {
  const row = object(value, 'Work private notification route');
  if (row.kind !== 'teams_personal') throw new TypeError('Invalid Work private notification route kind');
  const tenantId = boundedString(row.tenantId, 'private notification tenant id', 128).toLowerCase();
  const botAppId = boundedString(row.botAppId, 'private notification bot app id', 128).toLowerCase();
  const actorAadObjectId = boundedString(row.actorAadObjectId, 'private notification actor id', 128).toLowerCase();
  const conversationId = boundedString(row.conversationId, 'private notification conversation id', 512);
  const serviceUrl = boundedString(row.serviceUrl, 'private notification service URL', 512);
  if (!isUuid(tenantId) || !isUuid(botAppId) || !isUuid(actorAadObjectId)
    || !/^https:\/\/(?:smba\.trafficmanager\.net|smba\.infra\.teams\.microsoft\.com)(?::443)?\//iu.test(serviceUrl)) {
    throw new TypeError('Invalid Work private notification route fields');
  }
  return { kind: 'teams_personal', tenantId, botAppId, actorAadObjectId, conversationId, serviceUrl };
}

function validateTeamsPrivateInstallationEvent(event: TeamsPrivateInstallationEvent): void {
  if (Object.keys(event as unknown as Record<string, unknown>).sort().join(',') !== 'eventType,payload,trust'
    || event.eventType !== 'personal_installation'
    || !['add', 'remove'].includes(event.payload.action)
    || event.trust.version !== 1 || event.trust.provider !== 'teams'
    || event.trust.conversationKind !== 'private'
    || event.trust.installationAction !== event.payload.action
    || !isUuid(event.trust.tenantId) || !isUuid(event.trust.actorAadObjectId) || !isUuid(event.trust.botAppId)) {
    throw new TypeError('Invalid Teams private-installation event');
  }
  const timestamp = boundedString(event.trust.activityOccurredAt, 'private installation activity timestamp', 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError('Invalid private installation activity timestamp');
  }
  boundedString(event.trust.conversationId, 'private installation conversation id', 512);
  boundedString(event.trust.activityId, 'private installation activity id', 512);
  const serviceUrl = boundedString(event.trust.serviceUrl, 'private installation service URL', 512);
  if (!/^https:\/\/(?:smba\.trafficmanager\.net|smba\.infra\.teams\.microsoft\.com)(?::443)?\//iu.test(serviceUrl)) {
    throw new TypeError('Invalid Teams private-installation service URL');
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function canonicalTaskJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

/** Validate stored message bodies using the Work store's NUL/length rule. | 按 Work store 的 NUL/长度规则校验正文。 */
function boundedThreadMessageText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.includes('\u0000')) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

/** Sanitized HTTP failure with no response body or credential details.  中文：不携带响应正文或凭据细节的安全 HTTP 错误。 */
export class WorkStateHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Work state request failed (${status}, ${code})`);
    this.name = 'WorkStateHttpError';
  }
}

/** Explicitly ephemeral store for tests only; production construction must use WorkStateClient.  中文：仅供显式测试使用的临时存储；生产构造必须使用 WorkStateClient。 */
export class InMemoryWorkStateStore implements WorkStateStore {
  private readonly records = new Map<string, TaskRecord>();
  private readonly backendSessions = new Map<string, BackendSessionRecord>();
  private readonly events = new Map<string, DurableTaskEvent[]>();
  private readonly connectorEvents = new Map<string, { digest: string; receipt: ConnectorEventReceipt }>();
  private readonly connectorThreads = new Map<string, ConnectorThreadRecord>();
  private readonly connectorThreadRoutes = new Map<string, Omit<ConnectorThreadRecord, 'sessionId' | 'messages'>>();
  private readonly connectorThreadMessages = new Map<string, ConnectorThreadRecord['messages'][number][]>();
  private readonly credentialHealth = new Map<string, CredentialHealthSnapshot>();
  private readonly privateInstallations: Map<string, {
    readonly active: boolean;
    readonly revision: number;
    readonly updatedAt: number;
    readonly lastActivityOccurredAt?: number;
    readonly events: Map<string, {
      readonly digest: string;
      readonly receipt: Omit<TeamsPrivateInstallationReceipt, 'duplicate'>;
    }>;
  }>;

  constructor(
    private readonly actorAadObjectId?: string,
    privateInstallations?: Map<string, {
      readonly active: boolean;
      readonly revision: number;
      readonly updatedAt: number;
      readonly lastActivityOccurredAt?: number;
      readonly events: Map<string, {
        readonly digest: string;
        readonly receipt: Omit<TeamsPrivateInstallationReceipt, 'duplicate'>;
      }>;
    }>,
  ) {
    if (actorAadObjectId !== undefined && !isUuid(actorAadObjectId)) {
      throw new TypeError('In-memory actor scope must be a UUID');
    }
    this.privateInstallations = privateInstallations ?? new Map();
  }

  async createTask(input: {
    id?: string;
    sessionId: string;
    prompt: string;
    executionClass?: ExecutionClass;
    metadata?: Readonly<Record<string, unknown>>;
  }): Promise<TaskRecord> {
    const id = input.id ?? `task-${randomUUID()}`;
    if (this.records.has(id)) throw new WorkStateHttpError(409, 'TASK_ALREADY_EXISTS');
    const now = Date.now();
    const row: TaskRecord = {
      id, sessionId: input.sessionId, prompt: input.prompt, status: 'queued',
      executionClass: input.executionClass ?? 'foreground',
      createdAt: now, output: '', reasoning: '', durationMs: 0,
      ...(this.actorAadObjectId === undefined ? {} : { createdByActorId: this.actorAadObjectId.toLowerCase() }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    this.records.set(id, row);
    this.events.set(id, []);
    return row;
  }

  async createContinuationTask(
    sourceTaskId: string,
    input: { prompt: string; idempotencyKey: string },
  ): Promise<TaskRecord> {
    const source = this.records.get(sourceTaskId);
    if (!source) throw new WorkStateHttpError(404, 'TASK_NOT_FOUND');
    if (source.status !== 'awaiting_user_authorization') {
      throw new WorkStateHttpError(409, 'TASK_NOT_AWAITING_AUTHORIZATION');
    }
    const digest = createHash('sha256')
      .update(sourceTaskId).update('\0').update(input.idempotencyKey).digest('hex');
    const id = 'continuation-' + digest;
    const prior = this.records.get(id);
    if (prior) {
      if (prior.prompt !== input.prompt || prior.sessionId !== source.sessionId
        || prior.continuationOfTaskId !== sourceTaskId || prior.continuationMode !== 'read_only') {
        throw new WorkStateHttpError(409, 'TASK_ID_CONFLICT');
      }
      return prior;
    }
    const now = Date.now();
    const task: TaskRecord = {
      id,
      sessionId: source.sessionId,
      prompt: input.prompt,
      status: 'queued',
      executionClass: source.executionClass,
      createdAt: now,
      output: '',
      reasoning: '',
      durationMs: 0,
      continuationOfTaskId: sourceTaskId,
      continuationMode: 'read_only',
    };
    this.records.set(id, task);
    this.events.set(id, [
      { seq: 1, event: { type: 'task.created', continuationOfTaskId: sourceTaskId, continuationMode: 'read_only' }, createdAt: now },
      { seq: 2, event: { type: 'task.continuation_started', sourceTaskId, mode: 'read_only' }, createdAt: now },
    ]);
    const sourceEvents = this.events.get(sourceTaskId)!;
    sourceEvents.push({
      seq: sourceEvents.length + 1,
      event: { type: 'task.continuation_started', continuationTaskId: id, mode: 'read_only' },
      createdAt: now,
    });
    return task;
  }

  async verifyContinuationOwnership(sourceTaskId: string): Promise<void> {
    const source = this.records.get(sourceTaskId);
    if (!source) throw new WorkStateHttpError(404, 'TASK_NOT_FOUND');
    if (source.status !== 'awaiting_user_authorization') {
      throw new WorkStateHttpError(409, 'TASK_NOT_AWAITING_AUTHORIZATION');
    }
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> { return this.records.get(taskId); }

  async getBackendSession(
    taskId: string,
    backend: WorkExecutionBackend = 'codebuddy-acp',
  ): Promise<BackendSessionRecord | undefined> {
    const task = this.records.get(taskId);
    if (!task) throw new WorkStateHttpError(404, 'TASK_NOT_FOUND');
    if (task.status !== 'running') throw new WorkStateHttpError(409, 'WORK_BACKEND_SESSION_TASK_NOT_RUNNING');
    return this.backendSessions.get(`${task.sessionId}\0${backend}`);
  }

  async bindBackendSession(
    taskId: string,
    nativeSessionId: string,
    backend: WorkExecutionBackend = 'codebuddy-acp',
  ): Promise<BackendSessionRecord> {
    const task = this.records.get(taskId);
    if (!task) throw new WorkStateHttpError(404, 'TASK_NOT_FOUND');
    if (task.status !== 'running') throw new WorkStateHttpError(409, 'WORK_BACKEND_SESSION_TASK_NOT_RUNNING');
    const key = `${task.sessionId}\0${backend}`;
    const prior = this.backendSessions.get(key);
    if (prior && prior.nativeSessionId !== nativeSessionId) {
      throw new WorkStateHttpError(409, 'WORK_BACKEND_SESSION_CONFLICT');
    }
    const row: BackendSessionRecord = {
      backend, sessionId: task.sessionId, nativeSessionId,
    };
    this.backendSessions.set(key, row);
    return row;
  }

  async listTasks(options: { cursor?: string; limit?: number } = {}): Promise<TaskPage> {
    const all = [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const start = options.cursor ? Math.max(0, all.findIndex(row => row.id === options.cursor) + 1) : 0;
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
    const items = all.slice(start, start + limit);
    return { items, nextCursor: start + items.length < all.length ? items.at(-1)?.id ?? null : null };
  }

  async claimTask(taskId: string): Promise<{ claimed: boolean; task: TaskRecord }> {
    const old = this.records.get(taskId);
    if (!old) throw new WorkStateHttpError(404, 'TASK_NOT_FOUND');
    if (old.status !== 'queued') return { claimed: false, task: old };
    const task = await this.patchTask(taskId, { status: 'running' });
    return { claimed: true, task };
  }

  async patchTask(taskId: string, patch: Partial<Omit<TaskRecord, 'id' | 'workspaceId' | 'sequence'>>): Promise<TaskRecord> {
    const old = this.records.get(taskId);
    if (!old) throw new WorkStateHttpError(404, 'TASK_NOT_FOUND');
    const now = Date.now();
    const next = { ...old, ...patch };
    if (next.status === 'running' && next.startedAt === undefined) Object.assign(next, { startedAt: now });
    if (TERMINAL_STATUSES.has(next.status) && next.endedAt === undefined) {
      Object.assign(next, {
        endedAt: now,
        durationMs: Math.max(0, now - (next.startedAt ?? next.createdAt)),
      });
    }
    this.records.set(taskId, next);
    if (old.status !== next.status) await this.appendEvent(taskId, { type: 'task.status_changed', from: old.status, to: next.status });
    return next;
  }

  async appendEvent(taskId: string, event: Record<string, unknown>, messageId = randomUUID()): Promise<DurableTaskEvent> {
    if (!this.records.has(taskId)) throw new WorkStateHttpError(404, 'TASK_NOT_FOUND');
    const events = this.events.get(taskId)!;
    const prior = events.find(item => item.messageId === messageId);
    if (prior !== undefined) {
      if (canonicalTaskJson(prior.event) !== canonicalTaskJson(event)) {
        throw new WorkStateHttpError(409, 'TASK_EVENT_CONFLICT');
      }
      return prior;
    }
    const row = { seq: events.length + 1, event: structuredClone(event), createdAt: Date.now(), messageId };
    events.push(row);
    return row;
  }

  async getEvents(taskId: string, after = 0): Promise<TaskEventPage> {
    if (!this.records.has(taskId)) throw new WorkStateHttpError(404, 'TASK_NOT_FOUND');
    const events = this.events.get(taskId)!.filter(row => row.seq > after);
    return { events, nextSeq: this.events.get(taskId)!.length + 1 };
  }

  async listUnresolvedOperations(): Promise<readonly UnresolvedOperationSummary[]> { return []; }

  async registerConnectorEvent(input: ConnectorEventInput): Promise<ConnectorEventReceipt> {
    const teamsPrivateMessage = input.teamsPrivateMessage;
    const teamsThreadMessage = input.teamsThreadMessage;
    if (teamsPrivateMessage !== undefined && teamsThreadMessage !== undefined) {
      throw new WorkStateHttpError(400, 'WORK_CONNECTOR_INVALID_TEAMS_ORIGIN');
    }
    let privateOrigin: TeamsPrivateTaskOrigin | undefined;
    let key = `${input.connectorId}\0${input.messageId}`;
    if (teamsPrivateMessage !== undefined) {
      if (input.task === undefined) {
        throw new WorkStateHttpError(400, 'WORK_CONNECTOR_INVALID_TEAMS_PRIVATE_MESSAGE');
      }
      const actorAadObjectId = this.actorAadObjectId?.toLowerCase();
      if (actorAadObjectId === undefined || input.accountId !== undefined || input.conversationId !== undefined
        || input.senderId !== undefined || input.messageId !== teamsPrivateMessage.messageId
        || input.payload.messageId !== teamsPrivateMessage.messageId
        || input.payload.text !== teamsPrivateMessage.text) {
        throw new WorkStateHttpError(403, 'WORK_TEAMS_PRIVATE_MESSAGE_FORBIDDEN');
      }
      const activeInstallation = [...this.privateInstallations.entries()].find(([identity, value]) => {
        const [tenantId, actorId, botAppId] = identity.split('\0');
        return actorId === actorAadObjectId && value.active && tenantId !== undefined && botAppId !== undefined;
      });
      if (activeInstallation === undefined) {
        throw new WorkStateHttpError(403, 'WORK_TEAMS_PRIVATE_INSTALLATION_NOT_FOUND');
      }
      const [tenantId, , botAppId] = activeInstallation[0].split('\0');
      if (tenantId === undefined || botAppId === undefined) {
        throw new WorkStateHttpError(403, 'WORK_TEAMS_PRIVATE_INSTALLATION_NOT_FOUND');
      }
      privateOrigin = {
        kind: 'teams_private',
        messageId: teamsPrivateMessage.messageId,
        tenantId,
        botAppId,
        actorAadObjectId,
      };
      key = `${input.connectorId}\0teams-private\0${actorAadObjectId}\0${input.messageId}`;
    }
    if (teamsThreadMessage !== undefined && input.payload.messageId !== teamsThreadMessage.messageId) {
      throw new TypeError('Teams thread message ID does not match its canonical event payload');
    }
    const digestInput = teamsThreadMessage === undefined ? input : {
      ...input,
      teamsThreadMessage: Object.fromEntries(Object.entries(teamsThreadMessage).filter(([field]) => field !== 'sessionId')),
    };
    const digest = createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
    const prior = this.connectorEvents.get(key);
    if (prior) {
      if (prior.digest !== digest) throw new WorkStateHttpError(409, 'CONNECTOR_EVENT_ID_CONFLICT');
      return { ...prior.receipt, duplicate: true };
    }
    if (teamsThreadMessage) {
      const threadKey = `${input.connectorId}\0${teamsThreadMessage.threadId}`;
      const route = this.connectorThreadRoutes.get(threadKey);
      if (route && (route.tenantId !== teamsThreadMessage.tenantId || route.teamId !== teamsThreadMessage.teamId
        || route.channelId !== teamsThreadMessage.channelId || route.conversationId !== teamsThreadMessage.conversationId
        || route.rootThreadId !== teamsThreadMessage.rootThreadId)) {
        throw new WorkStateHttpError(409, 'CONNECTOR_THREAD_CONFLICT');
      }
    }
    if (teamsThreadMessage?.sessionId) {
      const threadKey = `${input.connectorId}\0${teamsThreadMessage.threadId}`;
      if (this.actorAadObjectId !== undefined
        && teamsThreadMessage.actorSubject.toLowerCase() !== this.actorAadObjectId.toLowerCase()) {
        throw new WorkStateHttpError(403, 'WORK_CONNECTOR_TEAMS_ACTOR_MISMATCH');
      }
      const mapped = this.connectorThreads.get(this.scopedConnectorThreadKey(threadKey));
      if (mapped && (mapped.sessionId !== teamsThreadMessage.sessionId
        || mapped.tenantId !== teamsThreadMessage.tenantId || mapped.teamId !== teamsThreadMessage.teamId
        || mapped.channelId !== teamsThreadMessage.channelId || mapped.conversationId !== teamsThreadMessage.conversationId
        || mapped.rootThreadId !== teamsThreadMessage.rootThreadId)) {
        throw new WorkStateHttpError(409, 'CONNECTOR_THREAD_CONFLICT');
      }
    }
    const taskInput = input.task === undefined || teamsPrivateMessage === undefined
      ? input.task
      : {
        ...input.task,
        metadata: Object.fromEntries(Object.entries(input.task.metadata ?? {}).filter(([field]) =>
          !['notification', 'teamsCaller', 'teamsThread', 'teamsPrivate'].includes(field))),
      };
    let task = taskInput ? await this.createTask(taskInput) : undefined;
    if (task !== undefined && teamsThreadMessage !== undefined) {
      task = { ...task, createdByActorId: teamsThreadMessage.actorSubject.toLowerCase() };
      this.records.set(task.id, task);
    }
    if (task !== undefined && privateOrigin !== undefined) {
      task = { ...task, createdByActorId: privateOrigin.actorAadObjectId, origin: privateOrigin };
      this.records.set(task.id, task);
    }
    if (teamsThreadMessage) {
      const threadKey = `${input.connectorId}\0${teamsThreadMessage.threadId}`;
      this.connectorThreadRoutes.set(threadKey, {
        threadId: teamsThreadMessage.threadId,
        tenantId: teamsThreadMessage.tenantId,
        teamId: teamsThreadMessage.teamId,
        channelId: teamsThreadMessage.channelId,
        conversationId: teamsThreadMessage.conversationId,
        rootThreadId: teamsThreadMessage.rootThreadId,
        serviceUrl: teamsThreadMessage.serviceUrl,
      });
      if (teamsThreadMessage.sessionId) {
        this.connectorThreads.set(this.scopedConnectorThreadKey(threadKey), {
          threadId: teamsThreadMessage.threadId,
          tenantId: teamsThreadMessage.tenantId,
          teamId: teamsThreadMessage.teamId,
          channelId: teamsThreadMessage.channelId,
          conversationId: teamsThreadMessage.conversationId,
          rootThreadId: teamsThreadMessage.rootThreadId,
          serviceUrl: teamsThreadMessage.serviceUrl,
          sessionId: teamsThreadMessage.sessionId,
          messages: [],
        });
      }
      const messages = this.connectorThreadMessages.get(threadKey) ?? [];
      messages.push({
        messageId: teamsThreadMessage.messageId,
        actorIssuer: teamsThreadMessage.actorIssuer,
        actorSubject: teamsThreadMessage.actorSubject,
        text: teamsThreadMessage.text,
        createdAt: Date.now(),
      });
      this.connectorThreadMessages.set(threadKey, messages);
    }
    const receipt: ConnectorEventReceipt = {
      eventId: randomUUID(), duplicate: false, receivedAt: Date.now(),
      ...(task === undefined ? {} : { task }),
    };
    this.connectorEvents.set(key, { digest, receipt });
    return receipt;
  }

  async getConnectorThread(
    connectorId: string,
    threadId: string,
    messageLimit = 20,
    excludeMessageId?: string,
  ): Promise<ConnectorThreadRecord> {
    const key = `${connectorId}\0${threadId}`;
    const route = this.connectorThreadRoutes.get(key);
    if (!route) throw new WorkStateHttpError(404, 'WORK_CONNECTOR_THREAD_NOT_FOUND');
    const record = this.connectorThreads.get(this.scopedConnectorThreadKey(key));
    return {
      ...route,
      ...(record === undefined ? {} : { sessionId: record.sessionId }),
      messages: (this.connectorThreadMessages.get(key) ?? [])
        .filter(message => this.actorAadObjectId === undefined
          || message.actorSubject.toLowerCase() === this.actorAadObjectId.toLowerCase())
        .filter(message => message.messageId !== excludeMessageId)
        .slice(-messageLimit),
    };
  }

  private scopedConnectorThreadKey(threadKey: string): string {
    return this.actorAadObjectId === undefined
      ? threadKey
      : `${threadKey}\0${this.actorAadObjectId.toLowerCase()}`;
  }

  async claimNotifications(): Promise<readonly NotificationLease[]> { return []; }

  async claimPrivateNotifications(): Promise<readonly NotificationLease[]> { return []; }

  async startPrivateNotification(): Promise<void> {}

  async finishPrivateNotification(): Promise<void> {}

  async registerTeamsPrivateInstallation(event: TeamsPrivateInstallationEvent): Promise<TeamsPrivateInstallationReceipt> {
    validateTeamsPrivateInstallationEvent(event);
    const actorId = event.trust.actorAadObjectId.toLowerCase();
    if (this.actorAadObjectId !== undefined && actorId !== this.actorAadObjectId.toLowerCase()) {
      throw new WorkStateHttpError(403, 'WORK_TEAMS_PRIVATE_INSTALLATION_FORBIDDEN');
    }
    const tenantId = event.trust.tenantId.toLowerCase();
    const botAppId = event.trust.botAppId.toLowerCase();
    const identity = `${tenantId}\0${actorId}\0${botAppId}`;
    const eventDigest = canonicalTaskJson(event);
    const prior = this.privateInstallations.get(identity);
    const priorEvent = prior?.events.get(event.trust.activityId);
    if (priorEvent !== undefined) {
      if (priorEvent.digest !== eventDigest) throw new WorkStateHttpError(409, 'PRIVATE_INSTALLATION_EVENT_CONFLICT');
      return { ...priorEvent.receipt, duplicate: true };
    }
    const events = new Map(prior?.events);
    const activityOccurredAt = Date.parse(event.trust.activityOccurredAt);
    const currentTimestamp = prior?.lastActivityOccurredAt;
    const ignored = prior !== undefined && (
      (currentTimestamp === undefined && event.payload.action === 'add')
      || (currentTimestamp !== undefined && activityOccurredAt < currentTimestamp)
      || (currentTimestamp !== undefined && activityOccurredAt === currentTimestamp
        && (event.payload.action === 'add' || !prior.active))
    );
    if (ignored && prior !== undefined) {
      const receipt = {
        action: event.payload.action,
        active: prior.active,
        applied: false,
        revision: prior.revision,
        updatedAt: prior.updatedAt,
      } satisfies Omit<TeamsPrivateInstallationReceipt, 'duplicate'>;
      events.set(event.trust.activityId, { digest: eventDigest, receipt });
      this.privateInstallations.set(identity, { ...prior, events });
      return { ...receipt, duplicate: false };
    }
    const updatedAt = Date.now();
    const active = event.payload.action === 'add';
    const receipt = {
      action: event.payload.action,
      active,
      applied: true,
      revision: (prior?.revision ?? 0) + 1,
      updatedAt,
    } satisfies Omit<TeamsPrivateInstallationReceipt, 'duplicate'>;
    events.set(event.trust.activityId, { digest: eventDigest, receipt });
    const next = {
      active,
      revision: receipt.revision,
      updatedAt,
      lastActivityOccurredAt: activityOccurredAt,
      events,
    };
    this.privateInstallations.set(identity, next);
    return { ...receipt, duplicate: false };
  }
  async processCredentialHealthSnapshots(
    _organizationId: string,
    connections: readonly CredentialHealthSnapshot[],
  ): Promise<{ readonly processed: number; readonly stale: number; readonly notificationsQueued: number }> {
    let processed = 0;
    let stale = 0;
    for (const snapshot of connections) {
      const prior = this.credentialHealth.get(snapshot.connectionId);
      if (prior && snapshot.generation < prior.generation) {
        stale += 1;
        continue;
      }
      this.credentialHealth.set(snapshot.connectionId, snapshot);
      processed += 1;
    }
    return { processed, stale, notificationsQueued: 0 };
  }
  async startNotification(): Promise<void> { throw new WorkStateHttpError(404, 'NOTIFICATION_NOT_FOUND'); }
  async finishNotification(): Promise<void> { throw new WorkStateHttpError(404, 'NOTIFICATION_NOT_FOUND'); }
}

const TERMINAL_STATUSES = new Set<ExecutionStatus>(['completed', 'failed', 'aborted']);
