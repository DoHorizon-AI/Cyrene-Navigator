// ┌─────────────────────────────────────────────────────────────────────┐
// │ 📄 host-observation.ts                                              │
// │ Module: workflows/host-observation                                  │
// │ Role: Read one private VM health snapshot as a fixed source page.    │
// │                                                                      │
// │ 模块职责：只读取私有 VM 健康快照并映射为固定来源页。                   │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ProductObservationErrorCode, ProductWorkflowMetadataReference } from './product-observation.js';

const HOST_STATUS_FILE_NAME = 'latest-status.json';
const HOST_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BINDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SERVICE_ALIAS = /^[a-z][a-z0-9_-]{0,63}$/u;
const MAX_STATUS_BYTES = 32 * 1024;
const MAX_PAGE_SIZE = 50;

/** Host source target; the workflow never chooses a path, hostname, or Docker resource. */
export interface HostObservationTarget {
  readonly id: string;
  readonly kind: 'host_health';
  readonly bindingId: string;
}

/** One source page request using the shared V3 poller shape. */
export interface HostObservationRequest {
  readonly source: 'vm_health';
  /** Verified internal Work owner context; never a workflow/model field. */
  readonly ownerActorId: string;
  readonly target: HostObservationTarget;
  readonly pageSize: number;
  readonly pageCursor: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string;
  readonly signal: AbortSignal;
}

/** Runtime-only observation fields consumed by V3 change detection. */
export interface HostWorkflowSourceObservation {
  readonly source: 'vm_health';
  readonly sourceEventId: string;
  readonly resourceUri: string;
  readonly sourceVersion: string;
  readonly eventType: 'vm.health.snapshot';
  readonly occurredAt: number;
  readonly title: 'VM health snapshot';
  readonly summary: string;
  readonly severity?: 'warning';
  readonly semanticFingerprint: string;
  readonly stateClass: 'healthy' | 'incident' | 'neutral';
  readonly metadataReferences?: readonly ProductWorkflowMetadataReference[];
}

/** Fixed V3 source page with explicit read errors and cursor echo. */
export interface HostObservationPage {
  readonly source: 'vm_health';
  readonly observedAt: number;
  readonly pageCursor: string | null;
  readonly nextCursor: string | null;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly observations: readonly HostWorkflowSourceObservation[];
  readonly error?: { readonly code: ProductObservationErrorCode };
}

/** One server-owned host status mount authorized for the trusted actor. */
export interface TrustedHostHealthProfile {
  readonly actorId: string;
  readonly targetId: string;
  readonly targetKind: 'host_health';
  readonly bindingId: string;
  readonly hostRef: string;
  readonly mountDirectory: string;
  readonly mountGid: number;
  readonly maxAgeSeconds: number;
  readonly maxClockSkewSeconds: number;
}

/** Per-actor host target resolver; a role or application token alone is insufficient. */
export interface HostObservationAuthority {
  resolveTarget(
    actorId: string,
    target: HostObservationTarget,
    signal: AbortSignal,
  ): Promise<TrustedHostHealthProfile | undefined>;
  authorizeRead(
    actorId: string,
    target: HostObservationTarget,
    profile: TrustedHostHealthProfile,
    signal: AbortSignal,
  ): Promise<'allowed' | 'forbidden' | 'not_configured'>;
}

/** The optional owner UID override exists for local synthetic file fixtures; production leaves it unset (UID 0). */
export interface HostObservationOptions {
  readonly actorId: string;
  readonly authority: HostObservationAuthority;
  readonly now?: () => number;
  readonly expectedOwnerUid?: number;
}

interface HostHealthService {
  readonly serviceAlias: string;
  readonly state: 'healthy' | 'degraded' | 'unknown';
  readonly restartCount: number | null;
}

interface HostHealthSnapshot {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly hostRef: string;
  readonly state: 'healthy' | 'degraded' | 'unknown';
  readonly services: readonly HostHealthService[];
}

class HostObservationError extends Error {
  constructor(readonly code: ProductObservationErrorCode) {
    super(code);
  }
}

/**
 * Create the fixed VM health file reader. Production must mount the exporter output read-only and root-owned.
 * The adapter never invokes Docker, provider APIs, or an operator-supplied URL.
 */
export function createHostHealthObservationSource(options: HostObservationOptions): {
  read(request: HostObservationRequest): Promise<HostObservationPage>;
} {
  const actorId = safeText(options.actorId, 256);
  if (actorId === undefined) throw new TypeError('A trusted host observation actor is required');
  const now = options.now ?? Date.now;
  const expectedOwnerUid = options.expectedOwnerUid ?? 0;
  if (!Number.isSafeInteger(expectedOwnerUid) || expectedOwnerUid < 0) {
    throw new TypeError('Invalid host status owner UID');
  }

  return {
    async read(request: HostObservationRequest): Promise<HostObservationPage> {
      let observedAt = now();
      const invalid = validateRequest(request);
      if (invalid !== undefined) return failedPage(request, observedAt, invalid);
      if (request.ownerActorId !== actorId) return failedPage(request, observedAt, 'forbidden');
      if (request.signal.aborted) return failedPage(request, observedAt, 'timeout');
      try {
        // ── Phase 1: Resolve and authorize one host target for the current actor. ──
        const profile = await options.authority.resolveTarget(actorId, request.target, request.signal);
        if (profile === undefined) return failedPage(request, now(), 'not_configured');
        if (!profileMatches(actorId, request.target, profile)) return failedPage(request, now(), 'forbidden');
        validateProfile(profile);
        const permission = await options.authority.authorizeRead(actorId, request.target, profile, request.signal);
        if (permission !== 'allowed') return failedPage(request, now(), permission);

        // ── Phase 2: Read only the exact mounted status filename without following links. ──
        const snapshot = await readMountedSnapshot(profile, expectedOwnerUid);
        observedAt = now();
        if (snapshot.snapshot.hostRef !== profile.hostRef) return failedPage(request, observedAt, 'forbidden');
        const sampleTime = Date.parse(snapshot.snapshot.observedAt);
        if (sampleTime > observedAt + profile.maxClockSkewSeconds * 1000
          || observedAt - sampleTime > profile.maxAgeSeconds * 1000) {
          return failedPage(request, observedAt, 'unavailable');
        }
        const item = makeObservation(snapshot.snapshot, sha256(snapshot.bytes));
        const window = requestWindow(request);
        if (item.occurredAt > window.end) return failedPage(request, observedAt, 'partial');
        const observations = window.start === null || item.occurredAt > window.start ? [item] : [];
        return {
          source: 'vm_health',
          observedAt,
          pageCursor: request.pageCursor,
          nextCursor: null,
          complete: true,
          truncated: false,
          observations,
        };
      } catch (error: unknown) {
        const code = error instanceof HostObservationError
          ? error.code
          : request.signal.aborted ? 'timeout' : 'unavailable';
        return failedPage(request, now(), code);
      }
    },
  };
}

async function readMountedSnapshot(
  profile: TrustedHostHealthProfile,
  expectedOwnerUid: number,
): Promise<{ readonly snapshot: HostHealthSnapshot; readonly bytes: Uint8Array }> {
  const directory = resolve(profile.mountDirectory);
  if (!isAbsolute(profile.mountDirectory) || directory !== profile.mountDirectory || profile.mountDirectory.includes('..')) {
    throw new HostObservationError('not_configured');
  }
  const path = join(directory, HOST_STATUS_FILE_NAME);
  try {
    if (await realpath(directory) !== directory || await realpath(path) !== path) {
      throw new HostObservationError('forbidden');
    }
    const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
        || directoryInfo.uid !== expectedOwnerUid || directoryInfo.gid !== profile.mountGid
        || (directoryInfo.mode & 0o7777) !== 0o750) throw new HostObservationError('forbidden');
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== expectedOwnerUid
      || before.gid !== profile.mountGid || (before.mode & 0o7777) !== 0o640
      || before.size < 1 || before.size > MAX_STATUS_BYTES) throw new HostObservationError('forbidden');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Uint8Array;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.uid !== expectedOwnerUid || opened.gid !== profile.mountGid
        || (opened.mode & 0o7777) !== 0o640 || opened.size !== before.size) {
        throw new HostObservationError('forbidden');
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (bytes.byteLength !== before.size || bytes.byteLength > MAX_STATUS_BYTES) {
      throw new HostObservationError('invalid');
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new HostObservationError('invalid');
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new HostObservationError('invalid');
    }
    const snapshot = decodeSnapshot(value, text);
    return { snapshot, bytes };
  } catch (error: unknown) {
    if (error instanceof HostObservationError) throw error;
    if (isMissingFile(error)) throw new HostObservationError('not_configured');
    throw new HostObservationError('unavailable');
  }
}

function decodeSnapshot(value: unknown, original: string): HostHealthSnapshot {
  const row = asRecord(value);
  if (row === undefined || !sameKeys(row, ['schemaVersion', 'observedAt', 'hostRef', 'state', 'services'])
    || row.schemaVersion !== 1 || !isIsoTimestamp(row.observedAt) || !safeHostRef(row.hostRef)
    || !['healthy', 'degraded', 'unknown'].includes(String(row.state)) || !Array.isArray(row.services)
    || row.services.length < 1 || row.services.length > 14) throw new HostObservationError('invalid');
  const services = row.services.map((value): HostHealthService => {
    const service = asRecord(value);
    if (service === undefined || !sameKeys(service, ['serviceAlias', 'state', 'restartCount'])
      || typeof service.serviceAlias !== 'string' || !SERVICE_ALIAS.test(service.serviceAlias)
      || !['healthy', 'degraded', 'unknown'].includes(String(service.state))
      || (service.restartCount !== null && !safeInteger(service.restartCount, 0))) {
      throw new HostObservationError('invalid');
    }
    return {
      serviceAlias: service.serviceAlias,
      state: service.state as HostHealthService['state'],
      restartCount: service.restartCount as number | null,
    };
  });
  if (services.some((service, index) => index > 0 && services[index - 1]!.serviceAlias >= service.serviceAlias)) {
    throw new HostObservationError('invalid');
  }
  if (row.state === 'healthy' && services.some(service => service.state !== 'healthy' || service.restartCount === null)) {
    throw new HostObservationError('invalid');
  }
  if (`${canonicalJson(canonicalSnapshot({
    schemaVersion: 1,
    observedAt: row.observedAt,
    hostRef: row.hostRef,
    state: row.state as HostHealthSnapshot['state'],
    services,
  }))}\n` !== original) throw new HostObservationError('invalid');
  return {
    schemaVersion: 1,
    observedAt: row.observedAt,
    hostRef: row.hostRef,
    state: row.state as HostHealthSnapshot['state'],
    services,
  };
}

function makeObservation(
  snapshot: HostHealthSnapshot,
  fileDigest: string,
): HostWorkflowSourceObservation {
  const occurredAt = Date.parse(snapshot.observedAt);
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) throw new HostObservationError('invalid');
  const stableFacts = {
    hostRef: snapshot.hostRef,
    state: snapshot.state,
    services: snapshot.services.map(({ serviceAlias, state, restartCount }) => ({ serviceAlias, state, restartCount })),
  };
  const semanticFingerprint = sha256(new TextEncoder().encode(JSON.stringify(stableFacts)));
  const resourceUri = `cyrene://vm-health/${snapshot.hostRef}`;
  const metadataReferences = snapshot.services.map(service => ({
    kind: 'vm_health.service',
    resourceUri: `${resourceUri}/services/${service.serviceAlias}`,
    ...(service.restartCount === null ? {} : { resourceVersion: `${service.state}:${service.restartCount}` }),
  }));
  const stateClass = snapshot.state === 'healthy' ? 'healthy'
    : snapshot.state === 'degraded' ? 'incident' : 'neutral';
  return {
    source: 'vm_health',
    sourceEventId: `vm-health:${snapshot.hostRef}:${occurredAt}:${fileDigest}`,
    resourceUri,
    sourceVersion: fileDigest,
    eventType: 'vm.health.snapshot',
    occurredAt,
    title: 'VM health snapshot',
    summary: `Host health ${snapshot.state}; monitored services ${snapshot.services.length}.`,
    ...(snapshot.state === 'healthy' ? {} : { severity: 'warning' as const }),
    semanticFingerprint,
    stateClass,
    metadataReferences,
  };
}

function validateRequest(request: HostObservationRequest): ProductObservationErrorCode | undefined {
  if (request === null || typeof request !== 'object' || request.source !== 'vm_health'
    || safeText(request.ownerActorId, 256) === undefined
    || request.target?.kind !== 'host_health' || safeText(request.target.id, 512) === undefined
    || !BINDING_ID.test(request.target.bindingId) || !safeInteger(request.pageSize, 1)
    || request.pageSize > MAX_PAGE_SIZE || !(request.signal instanceof AbortSignal)) return 'invalid';
  try {
    const window = requestWindow(request);
    if (window.start !== null && window.start > window.end) return 'invalid';
    if (request.pageCursor !== null) return 'invalid';
  } catch {
    return 'invalid';
  }
  return undefined;
}

function validateProfile(profile: TrustedHostHealthProfile): void {
  if (profile.targetKind !== 'host_health' || !BINDING_ID.test(profile.bindingId)
    || safeText(profile.targetId, 512) === undefined || !safeHostRef(profile.hostRef)
    || !isAbsolute(profile.mountDirectory) || profile.mountDirectory.includes('..')
    || !safeInteger(profile.mountGid, 0) || !safeInteger(profile.maxAgeSeconds, 1)
    || profile.maxAgeSeconds > 600 || !safeInteger(profile.maxClockSkewSeconds, 0)
    || profile.maxClockSkewSeconds > 120) throw new HostObservationError('invalid');
}

function profileMatches(actorId: string, target: HostObservationTarget, profile: TrustedHostHealthProfile): boolean {
  return profile.actorId === actorId && profile.targetId === target.id
    && profile.targetKind === target.kind && profile.bindingId === target.bindingId;
}

function requestWindow(request: Pick<HostObservationRequest, 'windowStart' | 'windowEnd'>): { start: number | null; end: number } {
  const end = timestampMillis(request.windowEnd);
  const start = request.windowStart === null ? null : timestampMillis(request.windowStart);
  if (end === undefined || (request.windowStart !== null && start === undefined)) throw new HostObservationError('invalid');
  return { start: start ?? null, end };
}

function timestampMillis(value: unknown): number | undefined {
  if (!isIsoTimestamp(value)) return undefined;
  const result = Date.parse(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value);
}

function safeHostRef(value: unknown): value is string {
  return typeof value === 'string' && HOST_REF.test(value);
}

function safeText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && [...value].every(character => character >= ' ' && character !== '\u007f')
    ? value : undefined;
}

function safeInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function canonicalSnapshot(value: HostHealthSnapshot): Record<string, unknown> {
  return {
    schemaVersion: value.schemaVersion,
    observedAt: value.observedAt,
    hostRef: value.hostRef,
    state: value.state,
    services: value.services.map(service => ({
      serviceAlias: service.serviceAlias,
      state: service.state,
      restartCount: service.restartCount,
    })),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function failedPage(
  request: Pick<HostObservationRequest, 'pageCursor'> | undefined,
  observedAt: number,
  code: ProductObservationErrorCode,
): HostObservationPage {
  return {
    source: 'vm_health',
    observedAt,
    pageCursor: request?.pageCursor ?? null,
    nextCursor: null,
    complete: false,
    truncated: false,
    observations: [],
    error: { code },
  };
}
