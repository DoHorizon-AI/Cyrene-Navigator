// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator work assistant tools                             │
// │ Role: Expose scoped memory, approval and durable receipts to dsh.   │
// │ 模块职责：向 dsh 提供隔离的记忆、人工审批与持久操作回执。             │
// └─────────────────────────────────────────────────────────────────────┘

import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { canonicalJson, sha256 } from './connector-authorization.ts';

export interface WorkToolsConfig {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly tokenEnv?: string;
  readonly taskIdForSession: (sessionId: string) => string | undefined;
  readonly onTaskDenied?: (sessionId: string) => void;
}

/** Credentials and workspace are host-owned, never model arguments. | 凭据与空间由宿主指定。 */
export class WorkAssistantBridge {
  private readonly root: string;

  constructor(private readonly config: WorkToolsConfig) {
    const origin = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
      throw new TypeError('Invalid work service URL');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(config.workspaceId)) {
      throw new TypeError('Invalid work workspace');
    }
    this.root = `${config.baseUrl.replace(/\/+$/, '')}/api/v1/workspaces/${encodeURIComponent(config.workspaceId)}/work`;
  }

  /** Bound requests cannot choose another host or workspace. | 请求只能到固定宿主与空间。 */
  async request(path: string, method: string, body: unknown, signal: AbortSignal): Promise<Record<string, JsonValue>> {
    const token = process.env[this.config.tokenEnv ?? 'CYRENE_SESSION_TOKEN'];
    if (!token) throw new Error('Work service credential is unavailable');
    const response = await fetch(`${this.root}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Work service request failed (${response.status})`);
    return asRecord(await response.json());
  }

  /** Correlate model mutations to their live, human-authorized task. | 关联仍获授权的活动任务。 */
  async mutate(exec: ToolRunContext, path: string, method: string, body: Record<string, unknown>, taskLinked = false): Promise<Record<string, JsonValue>> {
    const id = sessionId(exec);
    const taskId = this.config.taskIdForSession(id);
    if (!taskId) throw new Error('Work mutation requires an active durable Navigator task');
    const task = await this.request(`/tasks/${encodeURIComponent(taskId)}`, 'GET', undefined, exec.signal);
    if (task.status !== 'running') {
      this.config.onTaskDenied?.(id);
      throw new Error('This task is paused or closed; further mutations are denied');
    }
    return this.request(path, method, taskLinked ? { ...body, taskId } : body, exec.signal);
  }

  /** Read a minimal operation receipt owned by the active durable task. | 读取当前任务的最小回执。 */
  async readCurrentTaskOperation(
    sessionId: string,
    operationId: string,
    signal: AbortSignal,
  ): Promise<Record<string, JsonValue>> {
    const { taskId, operation } = await this.readOwnedOperation(sessionId, operationId, signal);
    return projectCurrentTaskOperation(taskId, operationId, operation);
  }

  private async readOwnedOperation(
    sessionId: string,
    operationId: string,
    signal: AbortSignal,
  ): Promise<{ taskId: string; operation: Record<string, JsonValue> }> {
    const taskId = this.config.taskIdForSession(sessionId);
    if (!taskId) throw new Error('Operation receipt reads require an active durable Navigator task');
    const response = await this.request(`/operations/${encodeURIComponent(operationId)}`, 'GET', undefined, signal);
    const operation = asRecord(response.operation ?? response);
    if (operation.id !== operationId || operation.taskId !== taskId) {
      throw new Error('Operation receipt does not belong to the active durable task');
    }
    if (operation.status !== 'started' && operation.status !== 'uncertain' && operation.status !== 'verified') {
      throw new Error('Operation receipt has an invalid lifecycle state');
    }
    if (typeof operation.operationType !== 'string'
      || typeof operation.createdAt !== 'number' || !Number.isSafeInteger(operation.createdAt)
      || typeof operation.updatedAt !== 'number' || !Number.isSafeInteger(operation.updatedAt)) {
      throw new Error('Operation receipt is incomplete');
    }
    return { taskId, operation };
  }

  /** Explicitly reconcile only a receipt owned by the active task. | 显式对账当前任务回执。 */
  async verifyCurrentTaskOperation(
    exec: ToolRunContext,
    operationId: string,
    status: 'uncertain' | 'verified',
    evidence: Record<string, unknown>,
  ): Promise<Record<string, JsonValue>> {
    const session = sessionId(exec);
    const { taskId, operation: rawReceipt } = await this.readOwnedOperation(session, operationId, exec.signal);
    const receipt = projectCurrentTaskOperation(taskId, operationId, rawReceipt);
    if (receipt.status === 'verified') {
      if (status !== 'verified') throw new Error('A verified operation receipt cannot move backward');
      return { operation: receipt, duplicate: true };
    }
    if (receipt.status === 'uncertain' && status === 'uncertain') {
      return { operation: receipt, duplicate: true };
    }
    if (receipt.status !== 'started' && receipt.status !== 'uncertain') {
      throw new Error('Operation receipt is not eligible for reconciliation');
    }
    let verifiedEvidence = evidence;
    const writeEvidence = recordValue(receipt.evidence);
    const operationType = typeof receipt.operationType === 'string' ? receipt.operationType : '';
    const connectorOperation = operationType.startsWith('tool.provider.v1:');
    const connectorWrite = connectorOperation && writeEvidence.effect !== 'read';
    if (status === 'verified' && connectorWrite) {
      const requestedReadback = recordValue(evidence.independentRead);
      const readbackOperationId = textValue(requestedReadback.operationId, 'independent read receipt ID');
      if (requestedReadback.confirmed !== true) {
        throw new Error('Connector write reconciliation requires an explicit confirmed independent readback');
      }
      const observation = textValue(requestedReadback.observation, 'independent readback observation');
      if (observation.length > 1_000) throw new Error('Independent readback observation is too long');
      const { operation: rawReadback } = await this.readOwnedOperation(session, readbackOperationId, exec.signal);
      const readback = projectCurrentTaskOperation(taskId, readbackOperationId, rawReadback);
      const readEvidence = recordValue(readback.evidence);
      const resultSha256 = readEvidence.resultSha256;
      const writeOperationId = typeof writeEvidence.operationId === 'string'
        ? writeEvidence.operationId
        : operationType.slice('tool.provider.v1:'.length);
      const writeTargetDigest = typeof writeEvidence.targetDigestSha256 === 'string'
        ? writeEvidence.targetDigestSha256
        : connectorTargetDigest(receipt.target);
      const relation = matchVerifiedReadback(rawReceipt, rawReadback, writeEvidence, readEvidence, writeTargetDigest);
      if (readback.status !== 'verified'
        || readEvidence.effect !== 'read'
        || readEvidence.outcome !== 'verified'
        || typeof readEvidence.operationId !== 'string'
        || readEvidence.operationId === writeOperationId
        || relation === undefined
        || typeof resultSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(resultSha256)) {
        throw new Error('Connector operation verification requires a completed read receipt for the same provider/profile target');
      }
      verifiedEvidence = {
        ...evidence,
        independentRead: {
          operationId: readback.id,
          providerId: readEvidence.providerId,
          profileRef: readEvidence.profileRef,
          operation: readEvidence.operationId,
          targetDigestSha256: readEvidence.targetDigestSha256,
          resultSha256,
          match: relation.kind,
          ...(relation.repository === undefined ? {} : { repository: relation.repository }),
          confirmed: true,
          observation,
        },
      };
    }
    return this.mutate(exec, `/operations/${encodeURIComponent(operationId)}`, 'PATCH', {
      status,
      evidence: verifiedEvidence,
    });
  }

  /** Wait for a human-owned decision; there is deliberately no model resolve tool. | 等待人工决策。 */
  async requestApproval(
    sessionId: string, kind: string, summary: string,
    details: Record<string, unknown>, signal: AbortSignal, messageId?: string,
  ): Promise<Record<string, JsonValue>> {
    const taskId = this.config.taskIdForSession(sessionId);
    if (!taskId) throw new Error('Approval requires an active durable Navigator task');
    const receipt = await this.request(`/tasks/${encodeURIComponent(taskId)}/approvals`, 'POST', {
      kind, summary, details, ...(messageId === undefined ? {} : { messageId }),
    }, signal);
    let approval = asRecord(receipt.approval ?? receipt);
    if (typeof approval.id !== 'string') throw new Error('Invalid approval receipt');
    const id = approval.id;
    while (approval.status === 'pending') {
      await delay(500, undefined, { signal });
      const result = await this.request(`/approvals/${encodeURIComponent(id)}`, 'GET', undefined, signal);
      approval = asRecord(result.approval ?? result);
    }
    if (approval.status !== 'approved') {
      this.config.onTaskDenied?.(sessionId);
      throw new Error('The human rejected this operation');
    }
    return approval;
  }

  /** Pause for a human answer recorded by the same durable authority. | 等待持久化人工输入。 */
  async requestInput(
    sessionId: string, summary: string, details: Record<string, unknown>,
    signal: AbortSignal, messageId?: string,
  ): Promise<Record<string, JsonValue>> {
    const taskId = this.config.taskIdForSession(sessionId);
    if (!taskId) throw new Error('Input requires an active durable Navigator task');
    const receipt = await this.request(`/tasks/${encodeURIComponent(taskId)}/inputs`, 'POST', {
      summary, details, ...(messageId === undefined ? {} : { messageId }),
    }, signal);
    let input = asRecord(receipt.input ?? receipt);
    if (typeof input.id !== 'string') throw new Error('Invalid input receipt');
    const id = input.id;
    while (input.status === 'pending') {
      await delay(500, undefined, { signal });
      const result = await this.request(`/inputs/${encodeURIComponent(id)}`, 'GET', undefined, signal);
      input = asRecord(result.input ?? result);
    }
    if (input.status !== 'answered') throw new Error('The human input was closed without an answer');
    return input;
  }
}

function asRecord(value: unknown): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an object');
  return value as Record<string, JsonValue>;
}

function sessionId(exec: ToolRunContext): string {
  if (!exec.agent) throw new Error('Work tools require an agent session');
  return String(exec.agent.session.id);
}

const output = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

/** Register ordinary tools in the existing dsh loop, without another executor. | 注册到现有 dsh。 */
export function registerWorkTools(ctx: Context, config: WorkToolsConfig): WorkAssistantBridge {
  const bridge = new WorkAssistantBridge(config);
  ctx.tools.register(defineTool({
    name: 'work_memory_search',
    description: 'Search structured workspace facts. Inspect source and stale flags before relying on a fact.',
    parameters: {
      query: { type: 'string', required: true },
      includeStale: { type: 'boolean' },
    }, output,
    execute: (args, exec) => bridge.request('/memory/query', 'POST', {
      query: args.query, includeStale: args.includeStale ?? false,
    }, exec.signal),
  }));
  ctx.tools.register(defineTool({
    name: 'work_memory_remember',
    description: 'Save an observed workspace fact with its source and freshness. Do not store credentials or raw login QR payloads.',
    parameters: {
      namespace: { type: 'string', required: true }, key: { type: 'string', required: true },
      value: { type: 'object', additionalProperties: true, required: true },
      sourceId: { type: 'string' }, observedAt: { type: 'integer' }, freshUntil: { type: 'integer' },
    }, output,
    execute: (args, exec) => bridge.mutate(exec, '/memory/facts', 'POST', args),
  }));
  ctx.tools.register(defineTool({
    name: 'work_sources',
    description: 'List source inventory health. A failed or incomplete inventory does not prove an item was removed.',
    parameters: {}, output,
    execute: (_args, exec) => bridge.request('/sources', 'GET', undefined, exec.signal),
  }));
  ctx.tools.register(defineTool({
    name: 'work_request_approval',
    description: 'Ask a human to approve a concrete action. This tool pauses until approved or rejected; it cannot approve its own request.',
    parameters: {
      kind: { type: 'string', required: true }, summary: { type: 'string', required: true },
      details: { type: 'object', additionalProperties: true },
    }, output,
    execute: (args, exec) => bridge.requestApproval(sessionId(exec), args.kind, args.summary,
      args.details ?? {}, exec.signal, String(exec.callId)),
  }));
  ctx.tools.register(defineTool({
    name: 'work_request_input',
    description: 'Ask a human for missing information. Waits for a durable answer. Never request passwords, tokens or raw login QR contents.',
    parameters: {
      summary: { type: 'string', required: true },
      details: { type: 'object', additionalProperties: true },
    }, output,
    execute: (args, exec) => bridge.requestInput(sessionId(exec), args.summary,
      args.details ?? {}, exec.signal, String(exec.callId)),
  }));
  ctx.tools.register(defineTool({
    name: 'work_operation_begin',
    description: 'Create an idempotent receipt BEFORE an approved external side effect. An existing uncertain receipt must be reconciled, never blindly replayed.',
    parameters: {
      idempotencyKey: { type: 'string', required: true }, operationType: { type: 'string', required: true },
      target: { type: 'string' }, request: { type: 'object', additionalProperties: true },
    }, output,
    execute: (args, exec) => bridge.mutate(exec, '/operations', 'POST', args, true),
  }));
  ctx.tools.register(defineTool({
    name: 'work_operation_read',
    description: 'Read a minimal operation receipt by its exact ID. Only receipts created by the active durable task are visible; original arguments are never returned.',
    parameters: { operationId: { type: 'string', required: true } }, output,
    execute: (args, exec) => bridge.readCurrentTaskOperation(
      sessionId(exec), args.operationId, exec.signal,
    ),
  }));
  ctx.tools.register(defineTool({
    name: 'work_operation_verify',
    description: 'Explicitly reconcile one operation receipt from the active task. Before verifying a connector write, perform a separate read-only provider tool call for the same provider/profile target, then provide that call’s workOperationId, confirmed=true, and a short observation. The host validates the read receipt and supplies its stored result digest; it never replays the write.',
    parameters: {
      operationId: { type: 'string', required: true },
      status: { type: 'string', enum: ['verified', 'uncertain'], required: true },
      evidence: { type: 'object', additionalProperties: true, required: true },
    }, output,
    execute: (args, exec) => bridge.verifyCurrentTaskOperation(
      exec, args.operationId, args.status, args.evidence,
    ),
  }));
  ctx.tools.register(defineTool({
    name: 'work_notify',
    description: 'Queue one notification with a stable deduplication key. For patrol workflows keep quiet if nothing changed.',
    parameters: {
      deduplicationKey: { type: 'string', required: true }, type: { type: 'string', required: true },
      payload: { type: 'object', additionalProperties: true, required: true }, recipient: { type: 'string' },
    }, output,
    execute: (args, exec) => bridge.mutate(exec, '/notifications', 'POST', args, true),
  }));
  return bridge;
}

function recordValue(value: unknown): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}

function projectCurrentTaskOperation(
  taskId: string,
  operationId: string,
  operation: Record<string, JsonValue>,
): Record<string, JsonValue> {
  return {
    id: operationId,
    taskId,
    operationType: operation.operationType as string,
    ...(typeof operation.target === 'string'
      && (operation.target.startsWith('connector-target:') || operation.target.startsWith('connector-readback:'))
      ? { target: operation.target }
      : {}),
    status: operation.status as string,
    evidence: projectOperationEvidence(operation.evidence),
    createdAt: operation.createdAt as number,
    updatedAt: operation.updatedAt as number,
  };
}

function matchVerifiedReadback(
  writeReceipt: Record<string, JsonValue>,
  readReceipt: Record<string, JsonValue>,
  writeEvidence: Record<string, JsonValue>,
  readEvidence: Record<string, JsonValue>,
  writeTargetDigest: string | undefined,
): { kind: string; repository?: string } | undefined {
  const providerId = writeEvidence.providerId;
  const profileRef = writeEvidence.profileRef;
  const writeOperationId = writeEvidence.operationId;
  const readOperationId = readEvidence.operationId;
  if (typeof providerId !== 'string' || typeof profileRef !== 'string'
    || readEvidence.providerId !== providerId || readEvidence.profileRef !== profileRef
    || typeof writeOperationId !== 'string' || typeof readOperationId !== 'string'
    || writeReceipt.operationType !== `tool.provider.v1:${writeOperationId}`
    || readReceipt.operationType !== `tool.provider.v1:${readOperationId}`) return undefined;

  const writeRequest = recordValue(writeReceipt.request);
  const readRequest = recordValue(readReceipt.request);
  if (typeof writeRequest.bindingId !== 'string' || writeRequest.bindingId.length === 0
    || readRequest.bindingId !== writeRequest.bindingId
    || writeRequest.operationId !== writeOperationId
    || readRequest.operationId !== readOperationId) return undefined;

  const readTargetDigest = readEvidence.targetDigestSha256;
  const isVendorCliWrite = writeOperationId === 'github.vendor.cli.execute'
    || writeOperationId === 'huggingface.vendor.cli.execute'
    || writeOperationId === 'cloud.vendor.cli.execute';
  if (!isVendorCliWrite && writeTargetDigest !== undefined && readTargetDigest === writeTargetDigest) {
    return { kind: 'exact_resource_projection' };
  }

  const writeArguments = recordValue(writeRequest.arguments);
  const readArguments = recordValue(readRequest.arguments);
  if (providerId !== 'github'
    || writeOperationId !== 'github.vendor.cli.execute'
    || writeRequest.toolId !== 'github_vendor_cli'
    || readOperationId !== 'github.branches.list'
    || readRequest.toolId !== 'github.branches.list'
    ) return undefined;

  const repository = writeArguments.argv === undefined
    ? undefined
    : githubCliBranchesRepository(writeArguments.argv);
  const readRepository = readArguments.repository;
  const repositoryId = readArguments.repository_id;
  if (repository === undefined || readRepository !== repository
    || typeof repositoryId !== 'string' || !/^[0-9]+$/u.test(repositoryId)) return undefined;
  const expectedReadTargetDigest = sha256(canonicalJson({
    providerId,
    profileRef,
    target: { repository_id: repositoryId, repository },
  }));
  if (readTargetDigest !== expectedReadTargetDigest) return undefined;
  return { kind: 'github_cli_api_repo_to_branches_list', repository };
}

function githubCliBranchesRepository(value: JsonValue): string | undefined {
  if (!Array.isArray(value) || value.length < 2 || value[0] !== 'api'
    || value.some(item => typeof item !== 'string')) return undefined;
  const argv = value as string[];
  const endpoint = argv.slice(1).find(item => !item.startsWith('-'));
  if (endpoint === undefined || endpoint.includes('%')) return undefined;
  const path = endpoint.split(/[?#]/u, 1)[0];
  if (path === undefined) return undefined;
  const match = /^repos\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/(?:branches(?:\/[^?#]+)?|git\/refs(?:\/heads(?:\/[^?#]+)?)?)\/?$/iu.exec(path);
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be non-empty text`);
  }
  return value;
}

function connectorTargetDigest(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^connector-target:([0-9a-f]{64})$/u.exec(value);
  return match?.[1];
}

function projectOperationEvidence(value: unknown): Record<string, JsonValue> {
  const source = recordValue(value);
  const allowed = new Set([
    'outcome', 'effect', 'providerId', 'profileRef', 'operationId', 'targetDigestSha256',
    'operationRef', 'isError', 'status', 'resultSha256', 'reconciliationState', 'reconciledByOperationRef',
  ]);
  const projected: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(source)) {
    if (!allowed.has(key)) continue;
    if (typeof item === 'string' || typeof item === 'boolean'
      || typeof item === 'number' && Number.isFinite(item)) projected[key] = item;
  }
  return projected;
}
