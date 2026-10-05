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
    name: 'work_operation_verify',
    description: 'Record independently checked result evidence. Use uncertain when remote delivery or outcome is unknown.',
    parameters: {
      operationId: { type: 'string', required: true },
      status: { type: 'string', enum: ['verified', 'uncertain'], required: true },
      evidence: { type: 'object', additionalProperties: true, required: true },
    }, output,
    execute: (args, exec) => bridge.request(`/operations/${encodeURIComponent(args.operationId)}`, 'PATCH', {
      status: args.status, evidence: args.evidence,
    }, exec.signal),
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
