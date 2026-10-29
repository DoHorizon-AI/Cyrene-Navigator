// ┌─────────────────────────────────────────────────────────────────────┐
// │ 📄 product-observation.ts                                           │
// │ Module: workflows/product-observation                               │
// │ Role: Read fixed Product resources into bounded source observations.│
// │                                                                      │
// │ 模块职责：只读固定 Product 资源并生成有界观察事件。                    │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';

const PRODUCT_RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256 = /^sha256:([0-9a-f]{64})$/u;
const ARTIFACT_URI = /^artifact:\/\/sha256\/([0-9a-f]{64})$/u;
const MAX_PAGE_SIZE = 50;
const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const PRODUCT_RUN_STATES = new Set(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLING', 'CANCELLED', 'AWAITING_RETRY']);
const TRAINING_EVENT_KINDS = new Set(['log', 'progress', 'checkpoint', 'started', 'completed', 'failed']);

/** V3 source target shape. No URL, path, actor, or credential comes from the workflow definition. */
export type ProductObservationSource = 'product' | 'training';

export interface ProductObservationTarget {
  readonly id: string;
  readonly kind: 'product_resource' | 'training_run';
  readonly bindingId: string;
}

/** Request shared with the deterministic V3 workflow poller. Times are ISO-8601 values. */
export interface ProductObservationRequest {
  readonly source: ProductObservationSource;
  /** Verified internal Work owner context; never a workflow/model field. */
  readonly ownerActorId: string;
  readonly target: ProductObservationTarget;
  readonly pageSize: number;
  readonly pageCursor: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string;
  readonly signal: AbortSignal;
}

/** Reference-only lineage accepted by the Work API; artifact bytes are never fetched. */
export interface ProductWorkflowMetadataReference {
  readonly kind: string;
  readonly resourceUri: string;
  readonly resourceVersion?: number | string;
}

/** Identity-free event shape shared with the V3 workflow poller. */
export interface ProductWorkflowSourceObservation {
  readonly source: ProductObservationSource;
  readonly sourceEventId: string;
  readonly resourceUri: string;
  readonly sourceVersion: number | string;
  readonly eventType: string;
  readonly occurredAt: number;
  readonly title?: string;
  readonly summary?: string;
  readonly severity?: 'info' | 'warning' | 'critical';
  readonly semanticFingerprint: string;
  readonly stateClass: 'healthy' | 'incident' | 'neutral';
  readonly correlationId?: string;
  readonly experimentId?: string;
  readonly metadataReferences?: readonly ProductWorkflowMetadataReference[];
}

/** Explicit source failure codes; no missing/denied source is represented as an empty pass. */
export type ProductObservationErrorCode =
  | 'not_configured' | 'forbidden' | 'unavailable' | 'timeout' | 'invalid' | 'partial';

/** One bounded page; `pageCursor` echoes the request cursor for runtime validation. */
export interface ProductObservationPage {
  readonly source: ProductObservationSource;
  readonly observedAt: number;
  readonly pageCursor: string | null;
  readonly nextCursor: string | null;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly observations: readonly ProductWorkflowSourceObservation[];
  readonly error?: { readonly code: ProductObservationErrorCode };
}

/** Fixed resource classes whose read paths are published by the owning Product APIs. */
export type ProductResourceKind = 'training-run' | 'dataset-version' | 'evaluation-run' | 'deployment';

type ProductObservationFact = Omit<ProductWorkflowSourceObservation, 'semanticFingerprint'>;

/** One immutable server-directory mapping, resolved for the current trusted actor. */
export interface TrustedProductObservationProfile {
  readonly actorId: string;
  readonly targetId: string;
  readonly targetKind: 'product_resource' | 'training_run';
  readonly bindingId: string;
  readonly product: 'yield' | 'catalyst' | 'echo' | 'reactor';
  readonly resourceKind: ProductResourceKind;
  readonly resourceId: string;
  readonly baseUrl: string;
  /** Required by Yield's private Workspace routes and verified against every response. */
  readonly organizationId?: string;
  readonly workspaceId?: string;
}

/** Directory and source-ACL seam. Implementations must be server-owned and actor-specific. */
export interface ProductObservationAuthority {
  /** Resolve only a target already present in the trusted Product directory for this actor. */
  resolveTarget(
    actorId: string,
    target: ProductObservationTarget,
    signal: AbortSignal,
  ): Promise<TrustedProductObservationProfile | undefined>;
  /** Check the exact source binding as the authenticated actor on every poll. */
  authorizeRead(
    actorId: string,
    target: ProductObservationTarget,
    profile: TrustedProductObservationProfile,
    signal: AbortSignal,
  ): Promise<'allowed' | 'forbidden' | 'not_configured'>;
  /** Return the opaque server-held credential for that actor and exact Product profile. */
  bearerFor(
    actorId: string,
    profile: TrustedProductObservationProfile,
    signal: AbortSignal,
  ): Promise<string | undefined>;
}

/** Adapter configuration uses the trusted principal established by the host, never workflow input. */
export interface ProductObservationOptions {
  readonly actorId: string;
  readonly authority: ProductObservationAuthority;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

interface ProductReadContext {
  readonly profile: TrustedProductObservationProfile;
  readonly bearer: string;
  readonly request: ProductObservationRequest;
  readonly fetcher: typeof fetch;
  readonly now: number;
}

interface YieldRun {
  readonly id: string;
  readonly state: string;
  readonly updatedAt: number;
  readonly resourceVersion: number;
  readonly attemptCount: number;
  readonly result?: unknown;
  readonly spec: Record<string, unknown>;
  readonly outputArtifacts: readonly unknown[];
  readonly failureCode?: string;
}

interface YieldEvent {
  readonly sequence: number;
  readonly trainingRunId: string;
  readonly attemptId: string;
  readonly phase: string;
  readonly kind: string;
  readonly timestamp: number;
  readonly step?: number;
  readonly totalSteps?: number;
  readonly epoch?: number;
  readonly checkpoint?: Record<string, unknown>;
}

interface YieldEventPage {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly trainingRunId: string;
  readonly events: readonly YieldEvent[];
  readonly afterSequence: number;
  readonly nextSequence: number;
  readonly terminal: boolean;
  readonly state: string;
}

interface YieldAttemptPage {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly trainingRunId: string;
  readonly attempts: readonly { readonly id: string; readonly phase: string; readonly state: string }[];
}

class ProductObservationError extends Error {
  constructor(readonly code: ProductObservationErrorCode) {
    super(code);
  }
}

/**
 * Create the one-shot adapter consumed by the V3 source poller.
 * The host must bind `actorId`, Product directory, ACL check, and credential provider from trusted state.
 */
export function createProductObservationSource(options: ProductObservationOptions): {
  read(request: ProductObservationRequest): Promise<ProductObservationPage>;
} {
  const actorId = boundedText(options.actorId, 256);
  if (actorId === undefined) throw new TypeError('A trusted Product observation actor is required');
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Product observation timeout must be between 1 and 60000 ms');
  }

  return {
    async read(request: ProductObservationRequest): Promise<ProductObservationPage> {
      const observedAt = now();
      const invalid = validateRequest(request);
      if (invalid !== undefined) return failedPage(request, observedAt, invalid);
      if (request.ownerActorId !== actorId) return failedPage(request, observedAt, 'forbidden');
      if (request.signal.aborted) return failedPage(request, observedAt, 'timeout');

      try {
        // ── Phase 1: Resolve and authorize the exact resource for this actor. ──
        const profile = await options.authority.resolveTarget(actorId, request.target, request.signal);
        if (profile === undefined) return failedPage(request, now(), 'not_configured');
        if (!profileMatches(actorId, request.target, profile)) return failedPage(request, now(), 'forbidden');
        validateProfile(profile);
        const authorization = await options.authority.authorizeRead(actorId, request.target, profile, request.signal);
        if (authorization !== 'allowed') return failedPage(request, now(), authorization);
        const bearer = await options.authority.bearerFor(actorId, profile, request.signal);
        if (bearer === undefined || !isSafeBearer(bearer)) return failedPage(request, now(), 'not_configured');

        // ── Phase 2: Read only the fixed Product route selected by the trusted profile. ──
        const context: ProductReadContext = { profile, bearer, request, fetcher, now: now() };
        const page = await readProfilePage(context, timeoutMs);
        return { ...page, observedAt: now() };
      } catch (error: unknown) {
        const code = error instanceof ProductObservationError
          ? error.code
          : request.signal.aborted ? 'timeout' : 'unavailable';
        return failedPage(request, now(), code);
      }
    },
  };
}

async function readProfilePage(
  context: ProductReadContext,
  timeoutMs: number,
): Promise<ProductObservationPage> {
  const { profile, request } = context;
  if (request.source === 'training' && profile.targetKind === 'training_run'
    && profile.product === 'yield' && profile.resourceKind === 'training-run') {
    return readYieldTrainingRun(context, timeoutMs);
  }
  if (request.source !== 'product' || profile.targetKind !== 'product_resource') {
    throw new ProductObservationError('invalid');
  }
  if (profile.product === 'yield') throw new ProductObservationError('invalid');
  if (request.pageCursor !== null) throw new ProductObservationError('invalid');
  if (profile.product === 'catalyst' && profile.resourceKind === 'dataset-version') {
    const value = await readJson(context, `/api/v1/dataset-versions/${encodeURIComponent(profile.resourceId)}`, 'GET', undefined, timeoutMs);
    return oneResourcePage(context, decodeDatasetVersion(value, profile.resourceId));
  }
  if (profile.product === 'echo' && profile.resourceKind === 'evaluation-run') {
    const value = await readJson(context, `/api/v1/evaluation-runs/${encodeURIComponent(profile.resourceId)}`, 'GET', undefined, timeoutMs);
    return oneResourcePage(context, decodeEvaluationRun(value, profile.resourceId));
  }
  if (profile.product === 'reactor' && profile.resourceKind === 'deployment') {
    const value = await readJson(context, `/api/v1/deployments/${encodeURIComponent(profile.resourceId)}`, 'GET', undefined, timeoutMs);
    return oneResourcePage(context, decodeDeployment(value, profile.resourceId));
  }
  throw new ProductObservationError('invalid');
}

async function readYieldTrainingRun(
  context: ProductReadContext,
  timeoutMs: number,
): Promise<ProductObservationPage> {
  const { profile, request } = context;
  if (request.source !== 'training' || request.target.kind !== 'training_run' || profile.targetKind !== 'training_run') {
    throw new ProductObservationError('invalid');
  }
  if (!profile.organizationId || !profile.workspaceId) throw new ProductObservationError('not_configured');
  const afterSequence = parseSequenceCursor(request.pageCursor);
  const runId = profile.resourceId;
  const basePath = `/internal/workspace/v1/training-runs/${encodeURIComponent(runId)}`;

  // These are Product owner reads; the POST route is explicitly a bounded query endpoint.
  const [rawRun, rawAttempts, rawEvents] = await Promise.all([
    readJson(context, basePath, 'GET', undefined, timeoutMs),
    readJson(context, `${basePath}/attempts`, 'GET', undefined, timeoutMs),
    readJson(context, `${basePath}/events/query`, 'POST', { afterSequence, limit: request.pageSize }, timeoutMs),
  ]);
  const run = decodeYieldRun(rawRun, runId);
  const attempts = decodeYieldAttempts(rawAttempts, runId, profile.organizationId, profile.workspaceId);
  const eventPage = decodeYieldEvents(rawEvents, runId, profile.organizationId, profile.workspaceId, afterSequence, request.pageSize);
  if (eventPage.state !== run.state) throw new ProductObservationError('partial');

  const time = requestWindow(request);
  const observations: ProductObservationFact[] = [];
  const runUri = `cyrene://yield/training-runs/${runId}`;
  const stateObservation = inWindow(run.updatedAt, time.start, time.end) ? {
      source: 'training',
      sourceEventId: `yield:training-run:${runId}:resource-version:${run.resourceVersion}`,
      resourceUri: runUri,
      sourceVersion: run.resourceVersion,
      eventType: 'yield.training_run.state',
      occurredAt: run.updatedAt,
      title: 'Yield training run',
      summary: `Product state ${run.state}; attempts ${run.attemptCount}.`,
      ...(run.state === 'FAILED' ? { severity: 'critical' as const } : {}),
      stateClass: runStateClass(run.state),
      metadataReferences: yieldRunReferences(run, attempts),
    } satisfies ProductObservationFact : undefined;

  let cursorSequence = eventPage.nextSequence;
  let hitWindowEnd = false;
  let priorTimestamp = -1;
  for (const event of eventPage.events) {
    if (event.timestamp < priorTimestamp) throw new ProductObservationError('invalid');
    priorTimestamp = event.timestamp;
    if (event.timestamp > time.end) {
      // Keep the first future event unread so a later source window can collect it.
      cursorSequence = event.sequence - 1;
      hitWindowEnd = true;
      break;
    }
    if (!inWindow(event.timestamp, time.start, time.end)) continue;
    const references: ProductWorkflowMetadataReference[] = [
      { kind: 'yield.training_run', resourceUri: runUri, resourceVersion: run.resourceVersion },
      { kind: 'yield.training_attempt', resourceUri: `cyrene://yield/training-attempts/${event.attemptId}` },
    ];
    const checkpoint = checkpointReference(event.checkpoint);
    if (checkpoint !== undefined) references.push(checkpoint);
    observations.push({
      source: 'training',
      sourceEventId: `yield:training-run:${runId}:sequence:${event.sequence}`,
      resourceUri: runUri,
      sourceVersion: event.sequence,
      eventType: `yield.training_run.${event.kind}`,
      occurredAt: event.timestamp,
      title: 'Yield training run event',
      summary: trainingEventSummary(event),
      ...(event.kind === 'failed' ? { severity: 'critical' as const } : {}),
      stateClass: event.kind === 'failed' ? 'incident' : event.kind === 'completed' ? 'healthy' : 'neutral',
      metadataReferences: references,
    });
  }

  const fullPage = eventPage.events.length === request.pageSize;
  const pageObservations = observations.slice(0, request.pageSize);
  if (stateObservation !== undefined && pageObservations.length < request.pageSize) pageObservations.push(stateObservation);
  return {
    source: 'training',
    observedAt: context.now,
    pageCursor: request.pageCursor,
    nextCursor: String(cursorSequence),
    complete: hitWindowEnd || !fullPage,
    truncated: false,
    observations: pageObservations.map(withRuntimeSemantics),
  };
}

function oneResourcePage(
  context: ProductReadContext,
  item: ProductObservationFact | undefined,
): ProductObservationPage {
  const time = requestWindow(context.request);
  return {
    source: context.request.source,
    observedAt: context.now,
    pageCursor: context.request.pageCursor,
    nextCursor: null,
    complete: true,
    truncated: false,
    observations: item !== undefined && inWindow(item.occurredAt, time.start, time.end)
      ? [withRuntimeSemantics(item)] : [],
  };
}

function decodeYieldRun(value: unknown, expectedId: string): YieldRun {
  const row = record(value);
  const id = text(row.id);
  const state = text(row.state);
  const resourceVersion = row.resourceVersion;
  const attemptCount = row.attemptCount;
  const spec = recordOrUndefined(row.spec);
  const outputArtifacts = row.outputArtifacts;
  if (id !== expectedId || !isUuid(id) || state === undefined || !PRODUCT_RUN_STATES.has(state)
    || !isInteger(resourceVersion, 1) || !isInteger(attemptCount, 0)
    || !Array.isArray(outputArtifacts) || outputArtifacts.length > MAX_PAGE_SIZE || spec === undefined) {
    throw new ProductObservationError('invalid');
  }
  const datasetVersion = recordOrUndefined(spec.datasetVersion);
  const modelArtifact = artifactReference(spec.modelArtifact, 'yield.model_artifact');
  if (datasetVersion === undefined || !isUuid(datasetVersion.id) || !isInteger(datasetVersion.resourceVersion, 1)
    || datasetVersion.format !== 'ALPACA_JSONL' || artifactReference(datasetVersion.artifact, 'catalyst.dataset_artifact') === undefined
    || modelArtifact === undefined || spec.method !== 'SFT' || spec.finetuningType !== 'LORA'
    || recordOrUndefined(spec.parameters) === undefined) throw new ProductObservationError('invalid');
  for (const item of outputArtifacts) {
    const output = record(item);
    const kind = text(output.kind);
    const artifact = artifactReference(output.artifact, 'yield.output_artifact');
    if (!['MODEL_CHECKPOINT', 'MODEL_ADAPTER', 'METRICS', 'TRAINING_MANIFEST'].includes(kind ?? '')
      || artifact === undefined || !Array.isArray(output.derivedFromDigests)
      || output.derivedFromDigests.length > 32
      || output.derivedFromDigests.some(digest => typeof digest !== 'string' || !SHA256.test(digest))) {
      throw new ProductObservationError('invalid');
    }
  }
  const updatedAt = dateMillis(row.updatedAt);
  if (updatedAt === undefined) throw new ProductObservationError('invalid');
  const failure = row.failure === undefined ? undefined : record(row.failure);
  const failureCode = failure === undefined ? undefined : boundedText(failure.code, 100);
  if (failure !== undefined && (failureCode === undefined || typeof failure.retryable !== 'boolean')) {
    throw new ProductObservationError('invalid');
  }
  if (state === 'FAILED' && failure === undefined) throw new ProductObservationError('invalid');
  const result = row.result === undefined || row.result === null ? undefined : record(row.result);
  if (result !== undefined) {
    if (!isUuid(result.id) || dateMillis(result.createdAt) === undefined
      || artifactReference(result.adapterArtifact, 'yield.adapter_artifact') === undefined
      || !Array.isArray(result.checkpointArtifacts) || result.checkpointArtifacts.length > MAX_PAGE_SIZE) {
      throw new ProductObservationError('invalid');
    }
    for (const checkpoint of result.checkpointArtifacts) {
      if (artifactReference(checkpoint, 'artifact.checkpoint') === undefined) throw new ProductObservationError('invalid');
    }
  }
  return {
    id,
    state,
    updatedAt,
    resourceVersion,
    attemptCount,
    spec,
    outputArtifacts,
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(result === undefined ? {} : { result }),
  };
}

function decodeYieldAttempts(
  value: unknown,
  runId: string,
  organizationId: string,
  workspaceId: string,
): YieldAttemptPage {
  const row = record(value);
  if (row.trainingRunId !== runId || row.organizationId !== organizationId || row.workspaceId !== workspaceId
    || !Array.isArray(row.attempts) || row.attempts.length > MAX_PAGE_SIZE) throw new ProductObservationError('partial');
  const attempts = row.attempts.map((entry): YieldAttemptPage['attempts'][number] => {
    const attempt = record(entry);
    const id = text(attempt.id);
    const phase = boundedText(attempt.phase, 200);
    const state = boundedText(attempt.state, 100);
    if (!isUuid(id) || phase === undefined || state === undefined || attempt.trainingRunId !== runId) {
      throw new ProductObservationError('invalid');
    }
    return { id, phase, state };
  });
  return { organizationId, workspaceId, trainingRunId: runId, attempts };
}

function decodeYieldEvents(
  value: unknown,
  runId: string,
  organizationId: string,
  workspaceId: string,
  afterSequence: number,
  limit: number,
): YieldEventPage {
  const row = record(value);
  const nextSequence = row.nextSequence;
  const terminal = row.terminal;
  const state = text(row.state);
  if (row.trainingRunId !== runId || row.organizationId !== organizationId || row.workspaceId !== workspaceId
    || row.afterSequence !== afterSequence || !Array.isArray(row.events) || row.events.length > limit
    || !isInteger(nextSequence, afterSequence) || typeof terminal !== 'boolean'
    || state === undefined || !PRODUCT_RUN_STATES.has(state)) throw new ProductObservationError('partial');
  let sequence = afterSequence;
  const events = row.events.map((entry): YieldEvent => {
    const event = record(entry);
    const eventSequence = event.sequence;
    const attemptId = event.attemptId;
    const kind = text(event.kind);
    if (!isInteger(eventSequence, 1) || eventSequence <= sequence || event.trainingRunId !== runId
      || !isUuid(attemptId) || kind === undefined || !TRAINING_EVENT_KINDS.has(kind)) {
      throw new ProductObservationError('invalid');
    }
    sequence = eventSequence;
    const phase = boundedText(event.phase, 200);
    const timestamp = dateMillis(event.timestamp);
    if (phase === undefined || timestamp === undefined) throw new ProductObservationError('invalid');
    const checkpoint = event.checkpoint === undefined ? undefined : record(event.checkpoint);
    return {
      sequence: eventSequence,
      trainingRunId: runId,
      attemptId,
      phase,
      kind,
      timestamp,
      ...(isInteger(event.step, 0) ? { step: event.step } : {}),
      ...(isInteger(event.totalSteps, 0) ? { totalSteps: event.totalSteps } : {}),
      ...(typeof event.epoch === 'number' && Number.isFinite(event.epoch) && event.epoch >= 0 ? { epoch: event.epoch } : {}),
      ...(checkpoint === undefined ? {} : { checkpoint }),
    };
  });
  if (nextSequence !== sequence) throw new ProductObservationError('partial');
  return {
    organizationId,
    workspaceId,
    trainingRunId: runId,
    events,
    afterSequence,
    nextSequence,
    terminal,
    state,
  };
}

function yieldRunReferences(
  run: YieldRun,
  attempts: YieldAttemptPage,
): readonly ProductWorkflowMetadataReference[] {
  const runUri = `cyrene://yield/training-runs/${run.id}`;
  const references: ProductWorkflowMetadataReference[] = [
    { kind: 'yield.training_run', resourceUri: runUri, resourceVersion: run.resourceVersion },
  ];
  const spec = run.spec;
  const dataset = recordOrUndefined(spec.datasetVersion);
  if (dataset !== undefined && isUuid(dataset.id) && isInteger(dataset.resourceVersion, 1)) {
    references.push({
      kind: 'catalyst.dataset_version',
      resourceUri: `cyrene://catalyst/dataset-versions/${dataset.id}`,
      resourceVersion: dataset.resourceVersion,
    });
  }
  const modelArtifact = recordOrUndefined(spec.modelArtifact);
  const modelRef = artifactReference(modelArtifact, 'yield.model_artifact');
  if (modelRef !== undefined) references.push(modelRef);
  for (const attempt of attempts.attempts.slice(-8)) {
    references.push({
      kind: 'yield.training_attempt',
      resourceUri: `cyrene://yield/training-attempts/${attempt.id}`,
      resourceVersion: `${attempt.phase}:${attempt.state}`,
    });
  }
  const artifacts = [...run.outputArtifacts, ...extractCheckpointArtifacts(run.result)];
  for (const artifact of artifacts) {
    const row = recordOrUndefined(artifact);
    const inner = row === undefined ? undefined : recordOrUndefined(row.artifact);
    if (row === undefined || inner === undefined) continue;
    const kind = row.kind === 'MODEL_CHECKPOINT' || inner.kind === 'checkpoint'
      ? 'artifact.checkpoint' : 'yield.output_artifact';
    const reference = artifactReference(inner, kind);
    if (reference !== undefined) references.push(reference);
  }
  return deduplicateReferences(references).slice(0, 32);
}

function extractCheckpointArtifacts(value: unknown): readonly unknown[] {
  const result = recordOrUndefined(value);
  return result !== undefined && Array.isArray(result.checkpointArtifacts)
    ? result.checkpointArtifacts.slice(0, 32)
    : [];
}

function decodeDatasetVersion(value: unknown, expectedId: string): ProductObservationFact {
  const row = record(value);
  if (row.id !== expectedId || !isUuid(row.id) || !isInteger(row.resourceVersion, 1)
    || !isInteger(row.version, 1) || !['PROCESSING', 'PUBLISHED', 'FAILED'].includes(text(row.state) ?? '')) {
    throw new ProductObservationError('invalid');
  }
  const updatedAt = dateMillis(row.updatedAt);
  if (updatedAt === undefined) throw new ProductObservationError('invalid');
  const references: ProductWorkflowMetadataReference[] = [{
    kind: 'catalyst.dataset_version',
    resourceUri: `cyrene://catalyst/dataset-versions/${row.id}`,
    resourceVersion: row.resourceVersion,
  }];
  const source = artifactReference(row.source, 'catalyst.dataset_source');
  const output = artifactReference(row.output, 'catalyst.dataset_output');
  if (source !== undefined) references.push(source);
  if (output !== undefined) references.push(output);
  return {
    source: 'product',
    sourceEventId: `catalyst:dataset-version:${row.id}:resource-version:${row.resourceVersion}`,
    resourceUri: `cyrene://catalyst/dataset-versions/${row.id}`,
    sourceVersion: row.resourceVersion,
    eventType: 'catalyst.dataset_version.state',
    occurredAt: updatedAt,
    title: 'Catalyst DatasetVersion',
    summary: `Product state ${row.state}; version ${row.version}.`,
    ...(row.state === 'FAILED' ? { severity: 'critical' as const } : {}),
    stateClass: row.state === 'PUBLISHED' ? 'healthy' : row.state === 'FAILED' ? 'incident' : 'neutral',
    metadataReferences: deduplicateReferences(references).slice(0, 32),
  };
}

function decodeEvaluationRun(value: unknown, expectedId: string): ProductObservationFact {
  const row = record(value);
  if (row.id !== expectedId || !isUuid(row.id) || !isUuid(row.suiteId) || !isInteger(row.resourceVersion, 1)
    || !['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(text(row.state) ?? '')) {
    throw new ProductObservationError('invalid');
  }
  const updatedAt = dateMillis(row.updatedAt);
  if (updatedAt === undefined) throw new ProductObservationError('invalid');
  const uri = `cyrene://echo/evaluation-runs/${row.id}`;
  const references: ProductWorkflowMetadataReference[] = [
    { kind: 'echo.evaluation_run', resourceUri: uri, resourceVersion: row.resourceVersion },
  ];
  const input = artifactReference(row.inputArtifact, 'echo.input_artifact');
  if (input !== undefined) references.push(input);
  return {
    source: 'product',
    sourceEventId: `echo:evaluation-run:${row.id}:resource-version:${row.resourceVersion}`,
    resourceUri: uri,
    sourceVersion: row.resourceVersion,
    eventType: 'echo.evaluation_run.state',
    occurredAt: updatedAt,
    title: 'Echo EvaluationRun',
    summary: `Product state ${row.state}.`,
    ...(row.state === 'FAILED' ? { severity: 'critical' as const } : {}),
    stateClass: row.state === 'SUCCEEDED' ? 'healthy' : row.state === 'FAILED' ? 'incident' : 'neutral',
    metadataReferences: references,
  };
}

function decodeDeployment(value: unknown, expectedId: string): ProductObservationFact {
  const row = record(value);
  if (row.id !== expectedId || !isUuid(row.id) || !isInteger(row.resourceVersion, 1)
    || !['STARTING', 'READY', 'DEGRADED', 'FAILED', 'STOPPING', 'STOPPED'].includes(text(row.observedState) ?? '')
    || !['ACTIVE', 'STOPPED'].includes(text(row.desiredState) ?? '')) throw new ProductObservationError('invalid');
  const updatedAt = dateMillis(row.updatedAt);
  if (updatedAt === undefined) throw new ProductObservationError('invalid');
  const uri = `cyrene://reactor/deployments/${row.id}`;
  const references: ProductWorkflowMetadataReference[] = [
    { kind: 'reactor.deployment', resourceUri: uri, resourceVersion: row.resourceVersion },
  ];
  const artifact = artifactReference(row.modelArtifact, 'reactor.model_artifact');
  if (artifact !== undefined) references.push(artifact);
  const modelVersion = recordOrUndefined(row.modelVersion);
  const lineage = modelVersion === undefined ? undefined : recordOrUndefined(modelVersion.lineage);
  if (lineage !== undefined) {
    const trainingRun = safeProductLineage(lineage.trainingRun, 'yield', 'training-runs');
    const datasetVersion = safeProductLineage(lineage.datasetVersion, 'catalyst', 'dataset-versions');
    if (trainingRun !== undefined) references.push({ kind: 'yield.training_run', resourceUri: trainingRun });
    if (datasetVersion !== undefined) references.push({ kind: 'catalyst.dataset_version', resourceUri: datasetVersion });
    if (Array.isArray(lineage.inputArtifacts)) {
      for (const item of lineage.inputArtifacts.slice(0, 8)) {
        const reference = artifactReference(item, 'reactor.lineage_artifact');
        if (reference !== undefined) references.push(reference);
      }
    }
  }
  return {
    source: 'product',
    sourceEventId: `reactor:deployment:${row.id}:resource-version:${row.resourceVersion}`,
    resourceUri: uri,
    sourceVersion: row.resourceVersion,
    eventType: 'reactor.deployment.state',
    occurredAt: updatedAt,
    title: 'Reactor deployment',
    summary: `Product observed state ${row.observedState}; desired state ${row.desiredState}.`,
    ...(row.observedState === 'FAILED' ? { severity: 'critical' as const } : {}),
    stateClass: row.observedState === 'READY' ? 'healthy'
      : row.observedState === 'FAILED' || row.observedState === 'DEGRADED' ? 'incident' : 'neutral',
    metadataReferences: deduplicateReferences(references).slice(0, 32),
  };
}

async function readJson(
  context: ProductReadContext,
  path: string,
  method: 'GET' | 'POST',
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const endpoint = new URL(`${validateBaseUrlValue(context.profile.baseUrl)}${path}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  context.request.signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await context.fetcher(endpoint, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${context.bearer}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) throw new ProductObservationError('forbidden');
    if (response.status === 404) throw new ProductObservationError('not_configured');
    if (response.status === 408 || response.status === 504) throw new ProductObservationError('timeout');
    if (response.status === 429 || response.status >= 500) throw new ProductObservationError('unavailable');
    if (!response.ok) throw new ProductObservationError('invalid');
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
      throw new ProductObservationError('invalid');
    }
    const bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES, controller.signal);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new ProductObservationError('invalid');
    }
    if (payload === null || typeof payload !== 'object') throw new ProductObservationError('invalid');
    return payload;
  } catch (error: unknown) {
    if (error instanceof ProductObservationError) throw error;
    if (controller.signal.aborted) throw new ProductObservationError('timeout');
    throw new ProductObservationError('unavailable');
  } finally {
    clearTimeout(timeout);
    context.request.signal.removeEventListener('abort', abort);
  }
}

async function readBoundedBody(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  if (response.body === null) throw new ProductObservationError('invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new ProductObservationError('timeout');
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new ProductObservationError('invalid');
      chunks.push(value);
    }
  } finally {
    if (signal.aborted || length > maximum) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validateRequest(request: ProductObservationRequest): ProductObservationErrorCode | undefined {
  if (request === null || typeof request !== 'object'
    || !['product', 'training'].includes(request.source)
    || boundedText(request.ownerActorId, 256) === undefined
    || request.target?.kind !== (request.source === 'training' ? 'training_run' : 'product_resource')
    || !boundedText(request.target.id, 512)
    || !isUuid(request.target.bindingId) || !Number.isSafeInteger(request.pageSize)
    || request.pageSize < 1 || request.pageSize > MAX_PAGE_SIZE || !(request.signal instanceof AbortSignal)) return 'invalid';
  try {
    requestWindow(request);
    if (request.pageCursor !== null && (typeof request.pageCursor !== 'string' || request.pageCursor.length > 32)) return 'invalid';
  } catch {
    return 'invalid';
  }
  return undefined;
}

function validateProfile(profile: TrustedProductObservationProfile): void {
  if (!isUuid(profile.resourceId) || boundedText(profile.targetId, 512) === undefined
    || !isUuid(profile.bindingId) || !boundedText(profile.actorId, 256)
    || !['yield', 'catalyst', 'echo', 'reactor'].includes(profile.product)
    || !['training-run', 'dataset-version', 'evaluation-run', 'deployment'].includes(profile.resourceKind)) {
    throw new ProductObservationError('invalid');
  }
  validateBaseUrlValue(profile.baseUrl);
  if (profile.product === 'yield' && profile.resourceKind === 'training-run'
    && (!boundedText(profile.organizationId, 200) || !boundedText(profile.workspaceId, 200))) {
    throw new ProductObservationError('not_configured');
  }
}

function profileMatches(actorId: string, target: ProductObservationTarget, profile: TrustedProductObservationProfile): boolean {
  return profile.actorId === actorId && profile.targetId === target.id
    && profile.targetKind === target.kind && profile.bindingId === target.bindingId;
}

function validateBaseUrlValue(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || value.trim() !== value) {
    throw new ProductObservationError('invalid');
  }
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)
      || !url.hostname || url.username || url.password || url.search || url.hash || url.port === '0') {
      throw new Error('invalid');
    }
  } catch {
    throw new ProductObservationError('invalid');
  }
  return value.replace(/\/+$/u, '');
}

function failedPage(
  request: Pick<ProductObservationRequest, 'pageCursor' | 'source'> | undefined,
  observedAt: number,
  code: ProductObservationErrorCode,
): ProductObservationPage {
  return {
    source: request?.source ?? 'product',
    observedAt,
    pageCursor: request?.pageCursor ?? null,
    nextCursor: null,
    complete: false,
    truncated: false,
    observations: [],
    error: { code },
  };
}

function withRuntimeSemantics(fact: ProductObservationFact): ProductWorkflowSourceObservation {
  const metadataReferences = [...(fact.metadataReferences ?? [])].sort((left, right) => {
    const leftKey = `${left.kind}\u0000${left.resourceUri}\u0000${left.resourceVersion ?? ''}`;
    const rightKey = `${right.kind}\u0000${right.resourceUri}\u0000${right.resourceVersion ?? ''}`;
    return leftKey.localeCompare(rightKey);
  });
  const stableFacts = {
    eventType: fact.eventType,
    resourceUri: fact.resourceUri,
    stateClass: fact.stateClass,
    summary: fact.summary ?? null,
    metadataReferences,
  };
  const semanticFingerprint = createHash('sha256').update(JSON.stringify(stableFacts)).digest('hex');
  return { ...fact, metadataReferences, semanticFingerprint };
}

function runStateClass(state: string): 'healthy' | 'incident' | 'neutral' {
  if (state === 'COMPLETED') return 'healthy';
  if (state === 'FAILED') return 'incident';
  return 'neutral';
}

function requestWindow(request: Pick<ProductObservationRequest, 'windowStart' | 'windowEnd'>): { start: number | null; end: number } {
  const end = dateMillis(request.windowEnd);
  const start = request.windowStart === null ? null : dateMillis(request.windowStart);
  if (end === undefined || (request.windowStart !== null && start === undefined) || (start !== null && start! > end)) {
    throw new ProductObservationError('invalid');
  }
  return { start: start ?? null, end };
}

function inWindow(value: number, start: number | null, end: number): boolean {
  return value <= end && (start === null || value > start);
}

function parseSequenceCursor(value: string | null): number {
  if (value === null) return 0;
  if (!/^(0|[1-9][0-9]{0,15})$/u.test(value)) throw new ProductObservationError('invalid');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ProductObservationError('invalid');
  return parsed;
}

function dateMillis(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return undefined;
  const result = Date.parse(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProductObservationError('invalid');
  return value as Record<string, unknown>;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value === undefined ? undefined : record(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && [...value].every(character => character >= ' ' && character !== '\u007f')
    ? value : undefined;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && PRODUCT_RESOURCE_ID.test(value);
}

function isInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isSafeBearer(value: string): boolean {
  return value.length <= 8192 && value.trim() === value
    && [...value].every(character => character.charCodeAt(0) >= 33 && character.charCodeAt(0) <= 126);
}

function artifactReference(value: unknown, kind: string): ProductWorkflowMetadataReference | undefined {
  const row = recordOrUndefined(value);
  if (row === undefined) return undefined;
  const digest = text(row.digest);
  if (digest === undefined || !SHA256.test(digest)) throw new ProductObservationError('invalid');
  const uri = text(row.uri) ?? `artifact://sha256/${digest.slice('sha256:'.length)}`;
  const uriMatch = ARTIFACT_URI.exec(uri);
  const artifactKind = boundedText(row.kind, 128);
  const sizeBytes = row.sizeBytes ?? row.size_bytes;
  if (uriMatch === null || uriMatch[1] !== digest.slice('sha256:'.length)
    || artifactKind === undefined || !isInteger(sizeBytes, 0)) throw new ProductObservationError('invalid');
  const manifestDigest = text(row.manifestDigest) ?? text(row.manifest_digest);
  if ((row.manifestDigest !== undefined || row.manifest_digest !== undefined)
    && (manifestDigest === undefined || !SHA256.test(manifestDigest))) throw new ProductObservationError('invalid');
  return {
    kind,
    resourceUri: uri,
    ...(manifestDigest === undefined ? {} : { resourceVersion: manifestDigest }),
  };
}

function checkpointReference(value: Record<string, unknown> | undefined): ProductWorkflowMetadataReference | undefined {
  if (value === undefined) return undefined;
  const digestValue = text(value.digest);
  if (digestValue === undefined) {
    if (value.digest !== undefined) throw new ProductObservationError('invalid');
    return undefined;
  }
  const digest = digestValue.startsWith('sha256:') ? digestValue : `sha256:${digestValue}`;
  if (!SHA256.test(digest)) throw new ProductObservationError('invalid');
  return { kind: 'artifact.checkpoint', resourceUri: `artifact://sha256/${digest.slice('sha256:'.length)}` };
}

function deduplicateReferences(values: readonly ProductWorkflowMetadataReference[]): ProductWorkflowMetadataReference[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = `${value.kind}\u0000${value.resourceUri}\u0000${value.resourceVersion ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeProductLineage(
  value: unknown,
  product: 'yield' | 'catalyst',
  collection: 'training-runs' | 'dataset-versions',
): string | undefined {
  if (typeof value !== 'string' || value.length > 200) return undefined;
  const match = /^cyrene:\/\/(yield|catalyst)\/(training-runs|dataset-versions)\/([0-9a-f-]{36})$/iu.exec(value);
  if (match === null || match[1] !== product || match[2] !== collection || !isUuid(match[3])) return undefined;
  return value;
}

function trainingEventSummary(event: YieldEvent): string {
  const parts = [`${event.phase}: ${event.kind}`];
  if (event.step !== undefined) parts.push(`step ${event.step}${event.totalSteps === undefined ? '' : `/${event.totalSteps}`}`);
  if (event.epoch !== undefined) parts.push(`epoch ${event.epoch}`);
  if (event.checkpoint !== undefined) {
    const checkpoint = event.checkpoint;
    if (isInteger(checkpoint.step, 0)) parts.push(`checkpoint step ${checkpoint.step}`);
  }
  return parts.join('; ').slice(0, 2_000);
}
