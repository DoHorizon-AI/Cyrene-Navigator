// ┌─────────────────────────────────────────────────────────────────────┐
// │ 📄 source-config.ts                                                 │
// │ Module: workflows/source-config                                     │
// │ Role: Load private target bindings and bind current ACL clients.      │
// │                                                                      │
// │ 模块职责：加载私有来源目标映射并绑定每轮动态 ACL 客户端。             │
// └─────────────────────────────────────────────────────────────────────┘

import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type {
  HostObservationAuthority,
  HostObservationTarget,
  TrustedHostHealthProfile,
} from './host-observation.js';
import type {
  ProductObservationAuthority,
  ProductObservationTarget,
  TrustedProductObservationProfile,
} from './product-observation.js';

const MAX_CONFIG_BYTES = 512_000;
export const AUTOMATION_SOURCE_BINDINGS_ENV = 'CYRENE_AUTOMATION_SOURCE_BINDINGS_FILE';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SAFE_TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const SAFE_HOST_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** One immutable target selector shared with a persisted workflow target. */
export type AutomationSourceTarget =
  | { readonly id: string; readonly kind: 'training_run'; readonly bindingId: string }
  | { readonly id: string; readonly kind: 'product_resource'; readonly bindingId: string }
  | { readonly id: string; readonly kind: 'host_health'; readonly bindingId: string }
  | { readonly id: string; readonly kind: 'planner_plan'; readonly bindingId: string };

/** Planner workflow selector whose ID is a private registry lookup key, not a Graph plan ID. */
export type PlannerPlanTarget = AutomationSourceTarget & { readonly kind: 'planner_plan' };

/** Exact trusted Yield resource binding; `targetId` is a lookup key, `resourceId` is Product-owned. */
export interface YieldTrainingRunSourceBinding {
  readonly actorId: string;
  readonly targetId: string;
  readonly kind: 'training_run';
  readonly bindingId: string;
  readonly product: 'yield';
  readonly resourceKind: 'training-run';
  readonly resourceId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
}

/** Exact trusted Catalyst, Echo, or Reactor resource binding. */
export interface ProductResourceSourceBinding {
  readonly actorId: string;
  readonly targetId: string;
  readonly kind: 'product_resource';
  readonly bindingId: string;
  readonly product: 'catalyst' | 'echo' | 'reactor';
  readonly resourceKind: 'dataset-version' | 'evaluation-run' | 'deployment';
  readonly resourceId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
}

/** Root-mounted sanitized host status location. This row contains no access grant. */
export interface HostHealthSourceBinding {
  readonly actorId: string;
  readonly targetId: string;
  readonly kind: 'host_health';
  readonly bindingId: string;
  readonly hostRef: string;
  readonly mountDirectory: string;
  readonly mountGid: number;
  readonly maxAgeSeconds: number;
  readonly maxClockSkewSeconds: number;
}

/** Planner target resolution stores server-owned ids; `targetId` is only the lookup key. */
export interface PlannerPlanSourceBinding {
  readonly actorId: string;
  readonly targetId: string;
  readonly kind: 'planner_plan';
  readonly bindingId: string;
  readonly connectionRef: string;
  readonly profileRef: string;
  readonly tenantId: string;
  readonly planId: string;
}

export type AutomationSourceTargetBinding =
  | YieldTrainingRunSourceBinding
  | ProductResourceSourceBinding
  | HostHealthSourceBinding
  | PlannerPlanSourceBinding;

/** Validated private target registry. It stores selectors and resource references, never authorization decisions. */
export interface AutomationSourceBindings {
  readonly schemaVersion: 1;
  readonly targets: readonly AutomationSourceTargetBinding[];
}

export type SourceReadDecision = 'allowed' | 'forbidden' | 'not_configured';

/** Existing Product Directory client; it resolves the host-owned service URL and checks source ACLs per poll. */
export interface ProductDirectorySourceClient {
  baseUrlFor(
    binding: YieldTrainingRunSourceBinding | ProductResourceSourceBinding,
    actorId: string,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  authorizeRead(
    actorId: string,
    target: ProductObservationTarget,
    binding: YieldTrainingRunSourceBinding | ProductResourceSourceBinding,
    resolvedProfile: TrustedProductObservationProfile,
    signal: AbortSignal,
  ): Promise<SourceReadDecision>;
}

/** Server-held scoped Product credential resolver; credential bytes never enter this file or the workflow. */
export interface ProductSourceCredentialClient {
  bearerFor(
    actorId: string,
    binding: YieldTrainingRunSourceBinding | ProductResourceSourceBinding,
    signal: AbortSignal,
  ): Promise<string | undefined>;
}

/** Existing current host-source ACL client. Missing policy is a denial or disabled result. */
export interface HostSourceAuthorizationClient {
  authorizeRead(
    actorId: string,
    target: HostObservationTarget,
    binding: HostHealthSourceBinding,
    signal: AbortSignal,
  ): Promise<SourceReadDecision>;
}

/** Current planner source authorization client, invoked for every poll. */
export interface PlannerPlanAuthorizationClient {
  authorizeRead(
    actorId: string,
    target: PlannerPlanTarget,
    binding: PlannerPlanSourceBinding,
    signal: AbortSignal,
  ): Promise<SourceReadDecision>;
}

/** Load one host-authored, bounded JSON profile with a root/private ownership mode. */
export async function loadAutomationSourceBindings(pathValue: string): Promise<AutomationSourceBindings> {
  if (!safeText(pathValue, 4096) || !isAbsolute(pathValue) || pathValue.includes('..')) {
    throw new TypeError('Automation source binding path must be an absolute configured path');
  }
  if (process.platform === 'win32') {
    throw new TypeError('Private automation source bindings are unsupported on Windows until ACL verification is available');
  }
  const path = pathValue;
  try {
    if (await realpath(path) !== path) throw new TypeError('Automation source binding path must not use symlinks');
    const before = await lstat(path);
    const mode = before.mode & 0o7777;
    const parentPath = dirname(path);
    const parentInfo = await lstat(parentPath);
    const currentGid = typeof process.getgid === 'function' ? process.getgid() : undefined;
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const rootReadable = before.uid === 0 && mode === 0o640 && currentGid !== undefined && before.gid === currentGid;
    const ownerPrivate = currentUid !== undefined && before.uid === currentUid && mode === 0o600;
    if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > MAX_CONFIG_BYTES
      || (!rootReadable && !ownerPrivate) || !parentInfo.isDirectory() || parentInfo.isSymbolicLink()
      || parentInfo.uid !== before.uid || (parentInfo.mode & 0o022) !== 0
      || await realpath(parentPath) !== parentPath) {
      throw new TypeError('Automation source bindings must be a bounded root-readable private file');
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: Uint8Array;
    try {
      const after = await handle.stat();
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
        || after.uid !== before.uid || after.gid !== before.gid || (after.mode & 0o7777) !== mode
        || after.size !== before.size) throw new TypeError('Automation source bindings changed while opening');
      raw = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (raw.byteLength !== before.size || raw.byteLength > MAX_CONFIG_BYTES) {
      throw new TypeError('Automation source bindings exceeded their size limit');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown;
    } catch {
      throw new TypeError('Automation source bindings must be valid UTF-8 JSON');
    }
    return decodeAutomationSourceBindings(parsed);
  } catch (error: unknown) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Automation source bindings are unavailable');
  }
}

/** Validate a source registry without accepting caller-provided URLs, tokens, or access booleans. */
export function decodeAutomationSourceBindings(input: unknown): AutomationSourceBindings {
  const root = record(input, 'automation source bindings');
  requireExactKeys(root, ['schemaVersion', 'targets'], 'automation source bindings');
  if (root.schemaVersion !== 1 || !Array.isArray(root.targets) || root.targets.length > 100) {
    throw new TypeError('Automation source bindings require a bounded version-1 target array');
  }
  const rows = root.targets.map((value, index) => decodeTargetBinding(value, index));
  const keys = rows.map(row => `${row.actorId}\u0000${row.kind}\u0000${row.targetId}\u0000${row.bindingId}`);
  if (new Set(keys).size !== keys.length) throw new TypeError('Automation source bindings contain a duplicate target');
  return { schemaVersion: 1, targets: rows };
}

/** Resolve one Product target for the verified actor, then require current Directory ACL on every page read. */
export function createProductObservationAuthority(
  bindings: AutomationSourceBindings,
  directory: ProductDirectorySourceClient,
  credentials: ProductSourceCredentialClient,
): ProductObservationAuthority {
  return {
    async resolveTarget(actorId, target, signal) {
      const binding = findProductBinding(bindings, actorId, target);
      if (binding === undefined) return undefined;
      const baseUrl = await directory.baseUrlFor(binding, actorId, signal);
      if (baseUrl === undefined) return undefined;
      return {
        actorId,
        targetId: binding.targetId,
        targetKind: binding.kind,
        bindingId: binding.bindingId,
        product: binding.product,
        resourceKind: binding.resourceKind,
        resourceId: binding.resourceId,
        baseUrl,
        organizationId: binding.organizationId,
        workspaceId: binding.workspaceId,
      } satisfies TrustedProductObservationProfile;
    },
    async authorizeRead(actorId, target, profile, signal) {
      const binding = findProductBinding(bindings, actorId, target);
      if (binding === undefined || !productProfileMatches(binding, profile, actorId)) return 'forbidden';
      return directory.authorizeRead(actorId, target, binding, profile, signal);
    },
    async bearerFor(actorId, profile, signal) {
      const binding = findProductBinding(bindings, actorId, {
        id: profile.targetId,
        kind: profile.targetKind,
        bindingId: profile.bindingId,
      });
      return binding === undefined ? undefined : credentials.bearerFor(actorId, binding, signal);
    },
  };
}

/** Resolve a host health binding and require the current host-source ACL at every poll. */
export function createHostObservationAuthority(
  bindings: AutomationSourceBindings,
  authorization: HostSourceAuthorizationClient,
): HostObservationAuthority {
  return {
    async resolveTarget(actorId, target) {
      const binding = findHostBinding(bindings, actorId, target);
      if (binding === undefined) return undefined;
      return {
        actorId,
        targetId: binding.targetId,
        targetKind: binding.kind,
        bindingId: binding.bindingId,
        hostRef: binding.hostRef,
        mountDirectory: binding.mountDirectory,
        mountGid: binding.mountGid,
        maxAgeSeconds: binding.maxAgeSeconds,
        maxClockSkewSeconds: binding.maxClockSkewSeconds,
      } satisfies TrustedHostHealthProfile;
    },
    async authorizeRead(actorId, target, _profile, signal) {
      const binding = findHostBinding(bindings, actorId, target);
      if (binding === undefined || !hostProfileMatches(binding, _profile, actorId)) return 'forbidden';
      return authorization.authorizeRead(actorId, target, binding, signal);
    },
  };
}

/** Resolve a Planner plan only by the opaque workflow lookup key; never treat target.id as a plan ID. */
export function resolvePlannerPlanBinding(
  bindings: AutomationSourceBindings,
  actorId: string,
  target: PlannerPlanTarget,
): PlannerPlanSourceBinding | undefined {
  if (target.kind !== 'planner_plan') return undefined;
  return bindings.targets.find((binding): binding is PlannerPlanSourceBinding =>
    binding.kind === 'planner_plan' && binding.actorId === actorId
      && binding.targetId === target.id && binding.bindingId === target.bindingId);
}

/** Call current per-poll ACL; no binding field can assert that a read is authorized. */
export async function authorizePlannerPlanRead(
  authorization: PlannerPlanAuthorizationClient,
  actorId: string,
  target: PlannerPlanTarget,
  binding: PlannerPlanSourceBinding | undefined,
  signal: AbortSignal,
): Promise<SourceReadDecision> {
  return target.kind !== 'planner_plan' || binding === undefined || binding.actorId !== actorId
    || binding.targetId !== target.id || binding.bindingId !== target.bindingId
    ? 'forbidden'
    : authorization.authorizeRead(actorId, target, binding, signal);
}

function productProfileMatches(
  binding: YieldTrainingRunSourceBinding | ProductResourceSourceBinding,
  profile: TrustedProductObservationProfile,
  actorId: string,
): boolean {
  return profile.actorId === actorId && profile.targetId === binding.targetId
    && profile.targetKind === binding.kind && profile.bindingId === binding.bindingId
    && profile.product === binding.product && profile.resourceKind === binding.resourceKind
    && profile.resourceId === binding.resourceId && profile.organizationId === binding.organizationId
    && profile.workspaceId === binding.workspaceId;
}

function hostProfileMatches(
  binding: HostHealthSourceBinding,
  profile: TrustedHostHealthProfile,
  actorId: string,
): boolean {
  return profile.actorId === actorId && profile.targetId === binding.targetId
    && profile.targetKind === binding.kind && profile.bindingId === binding.bindingId
    && profile.hostRef === binding.hostRef && profile.mountDirectory === binding.mountDirectory
    && profile.mountGid === binding.mountGid && profile.maxAgeSeconds === binding.maxAgeSeconds
    && profile.maxClockSkewSeconds === binding.maxClockSkewSeconds;
}

function findProductBinding(
  bindings: AutomationSourceBindings,
  actorId: string,
  target: ProductObservationTarget,
): YieldTrainingRunSourceBinding | ProductResourceSourceBinding | undefined {
  return bindings.targets.find((binding): binding is YieldTrainingRunSourceBinding | ProductResourceSourceBinding =>
    (binding.kind === 'training_run' || binding.kind === 'product_resource')
      && binding.actorId === actorId && binding.targetId === target.id
      && binding.kind === target.kind && binding.bindingId === target.bindingId);
}

function findHostBinding(
  bindings: AutomationSourceBindings,
  actorId: string,
  target: HostObservationTarget,
): HostHealthSourceBinding | undefined {
  return bindings.targets.find((binding): binding is HostHealthSourceBinding =>
    binding.kind === 'host_health' && binding.actorId === actorId
      && binding.targetId === target.id && binding.bindingId === target.bindingId);
}

function decodeTargetBinding(value: unknown, index: number): AutomationSourceTargetBinding {
  const row = record(value, `automation source target ${index}`);
  const kind = text(row.kind, `automation source target ${index}.kind`);
  if (kind === 'training_run') {
    requireExactKeys(row, ['actorId', 'targetId', 'kind', 'bindingId', 'product', 'resourceKind', 'resourceId', 'organizationId', 'workspaceId'], `target ${index}`);
    if (row.product !== 'yield' || row.resourceKind !== 'training-run') throw new TypeError(`target ${index} has an invalid Yield binding`);
    return {
      actorId: text(row.actorId, 'actorId'), targetId: targetId(row.targetId), kind,
      bindingId: uuid(row.bindingId, 'bindingId'), product: 'yield', resourceKind: 'training-run',
      resourceId: uuid(row.resourceId, 'resourceId'), organizationId: text(row.organizationId, 'organizationId'),
      workspaceId: text(row.workspaceId, 'workspaceId'),
    };
  }
  if (kind === 'product_resource') {
    requireExactKeys(row, ['actorId', 'targetId', 'kind', 'bindingId', 'product', 'resourceKind', 'resourceId', 'organizationId', 'workspaceId'], `target ${index}`);
    const resourceKind = text(row.resourceKind, 'resourceKind');
    const compatible = row.product === 'catalyst' && resourceKind === 'dataset-version'
      || row.product === 'echo' && resourceKind === 'evaluation-run'
      || row.product === 'reactor' && resourceKind === 'deployment';
    if (!compatible) throw new TypeError(`target ${index} has an invalid Product resource binding`);
    return {
      actorId: text(row.actorId, 'actorId'), targetId: targetId(row.targetId), kind,
      bindingId: uuid(row.bindingId, 'bindingId'), product: row.product as ProductResourceSourceBinding['product'],
      resourceKind: resourceKind as ProductResourceSourceBinding['resourceKind'],
      resourceId: uuid(row.resourceId, 'resourceId'), organizationId: text(row.organizationId, 'organizationId'),
      workspaceId: text(row.workspaceId, 'workspaceId'),
    };
  }
  if (kind === 'host_health') {
    requireExactKeys(row, ['actorId', 'targetId', 'kind', 'bindingId', 'hostRef', 'mountDirectory', 'mountGid', 'maxAgeSeconds', 'maxClockSkewSeconds'], `target ${index}`);
    const mountDirectory = text(row.mountDirectory, 'mountDirectory');
    const mountGid = row.mountGid;
    const maxAgeSeconds = row.maxAgeSeconds;
    const maxClockSkewSeconds = row.maxClockSkewSeconds;
    if (!mountDirectory.startsWith('/') || mountDirectory.includes('..') || resolve(mountDirectory) !== mountDirectory
      || !safeInteger(mountGid, 0)
      || !safeInteger(maxAgeSeconds, 1) || maxAgeSeconds > 600
      || !safeInteger(maxClockSkewSeconds, 0) || maxClockSkewSeconds > 120) {
      throw new TypeError(`target ${index} has invalid host health mount settings`);
    }
    return {
      actorId: text(row.actorId, 'actorId'), targetId: targetId(row.targetId), kind,
      bindingId: uuid(row.bindingId, 'bindingId'), hostRef: hostRef(row.hostRef), mountDirectory,
      mountGid, maxAgeSeconds, maxClockSkewSeconds,
    };
  }
  if (kind === 'planner_plan') {
    requireExactKeys(row, ['actorId', 'targetId', 'kind', 'bindingId', 'connectionRef', 'profileRef', 'tenantId', 'planId'], `target ${index}`);
    return {
      actorId: text(row.actorId, 'actorId'), targetId: targetId(row.targetId), kind,
      bindingId: uuid(row.bindingId, 'bindingId'), connectionRef: safeReference(row.connectionRef, 'connectionRef'),
      profileRef: safeReference(row.profileRef, 'profileRef'), tenantId: uuid(row.tenantId, 'tenantId'),
      planId: safeReference(row.planId, 'planId'),
    };
  }
  throw new TypeError(`automation source target ${index} kind is unsupported`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} has unsupported fields`);
  }
}

function text(value: unknown, label: string): string {
  if (!safeText(value, 256)) throw new TypeError(`${label} is invalid`);
  return value;
}

function targetId(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_TARGET_ID.test(value)) throw new TypeError('targetId is invalid');
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function safeReference(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_REF.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function hostRef(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_HOST_REF.test(value)) throw new TypeError('hostRef is invalid');
  return value;
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && [...value].every(character => character >= ' ' && character !== '\u007f');
}

function safeInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
