// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator DSH task execution ports                          │
// │ Role: Require background jobs to run through the existing Work Task.│
// │ 模块职责：要求后台任务复用现有 Work Task 与 DSH Session。               │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ExecutionStatus } from '../work-state-client.ts';
import type { TrustedTurnContext } from './conversation-memory.ts';

/** Canonical task identity supplied to the Navigator Host's existing executor. */
export interface DshWorkTaskRequestV1 {
  readonly taskId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Progress written only by the in-process, trusted feature task callback. */
export interface DshWorkTaskCheckpointV1 {
  readonly cursor: string | null;
  readonly processedCount: number;
  readonly checkpointDigest: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/** Terminal status is taken from the actual durable Navigator TaskOutcome. */
export interface DshWorkTaskOutcomeV1 {
  readonly taskId: string;
  readonly sessionId: string;
  readonly status: ExecutionStatus;
  readonly output: string;
  readonly reasoning: string;
  readonly error?: string;
  readonly durationMs: number;
}

/** Host adapter that persists/runs fixed Work Tasks through the existing DSH Session. */
export interface DshWorkTaskExecutionPortV1 {
  run(
    context: Pick<TrustedTurnContext, 'workspaceId' | 'actorId'>,
    request: DshWorkTaskRequestV1,
    operation: (
      agent: Agent,
      signal: AbortSignal,
      checkpoint: (value: DshWorkTaskCheckpointV1) => Promise<void>,
    ) => Promise<string>,
    signal: AbortSignal,
  ): Promise<DshWorkTaskOutcomeV1>;
  cancel(
    context: Pick<TrustedTurnContext, 'workspaceId' | 'actorId'>,
    taskId: string,
    signal: AbortSignal,
  ): Promise<boolean>;
}

/** Host adapter for scoped read-only DSH feature work such as scheduled research watches. */
export interface DshConversationFeatureTaskPortV1 {
  runFeatureTask(
    context: Pick<TrustedTurnContext, 'workspaceId' | 'actorId'>,
    request: DshWorkTaskRequestV1,
    operation: (agent: Agent, signal: AbortSignal) => Promise<string>,
    signal: AbortSignal,
  ): Promise<DshWorkTaskOutcomeV1>;
  cancelFeatureTask(
    context: Pick<TrustedTurnContext, 'workspaceId' | 'actorId'>,
    taskId: string,
    signal: AbortSignal,
  ): Promise<boolean>;
}

/** Stable Work Task id derived from a durable domain job without leaking its raw key. */
export function conversationWorkTaskId(domain: 'maintenance' | 'watch' | 'followup' | 'research', resourceId: string): string {
  if (!resourceId || resourceId.length > 512 || /[\u0000-\u001f\u007f]/u.test(resourceId)) {
    throw new TypeError('Conversation Work Task resource id is invalid');
  }
  const digest = createHash('sha256').update(`${domain}\u0000${resourceId}`).digest('hex').slice(0, 40);
  return `conversation-${domain}-${digest}`;
}

/** Stable maintenance Task identity required by the Host's authorization and replay checks. */
export function maintenanceWorkTaskId(workspaceId: string, actorId: string, jobId: string): string {
  for (const [label, value] of [['workspace', workspaceId], ['actor', actorId], ['job', jobId]] as const) {
    if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new TypeError(`Conversation maintenance ${label} id is invalid`);
    }
  }
  const digest = createHash('sha256')
    .update(`cyrene-maintenance-v1\u0000${workspaceId}\u0000${actorId}\u0000${jobId}`)
    .digest('hex')
    .slice(0, 32);
  return `maintenance-${digest}`;
}
