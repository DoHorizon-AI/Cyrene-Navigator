// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator workflow Teams delivery                           │
// │ Role: Project verified duty notices into the durable Teams outbox.   │
// │                                                                      │
// │ 模块职责：将经过校验的责任通知投递到原 Teams 主题的持久 outbox。       │
// └─────────────────────────────────────────────────────────────────────┘

import type { ResponsibilityAuthorityConfig } from './responsibility-authority.ts';
import { verifyResponsibilityNoticeContext } from './responsibility-authority.ts';
import type { WorkflowOutboxReceipt, WorkflowStore, WorkflowTeamsNoticeRequest } from './workflows/store.ts';

/** Safe transition notice emitted by the durable workflow runtime. */
export interface WorkflowTeamsNotice {
  readonly deduplicationKey: string;
  readonly workflowId: string;
  readonly occurrenceId: string;
  readonly triggerId: string;
  readonly kind: 'change' | 'failure' | 'recovery' | 'digest' | 'blocker';
  readonly attentionKind?: 'blocked_goal' | 'user_decision' | 'service_or_auth_outage';
  readonly scheduledAt: string;
  readonly title: string;
  readonly summary: string;
  readonly taskId?: string;
}

export type TeamsNotificationEnqueuer = Pick<WorkflowStore, 'enqueueTeamsNotification'>;

/**
 * Verify a terminal transition and create a route-free request for Work's dedicated notice endpoint.
 * The server resolves the Teams route and owner task from canonical v2 workflow state.
 *
 * @param notice - transition metadata and summary from the durable workflow outbox.
 * @param authority - Work API, Directory, and allowed Teams route configuration.
 * @param signal - cancellation signal for the verification reads.
 * @returns A safe Work notice request, or undefined when authority is stale or revoked.
 */
export async function projectWorkflowNoticeToTeamsMessage(
  notice: WorkflowTeamsNotice,
  authority: ResponsibilityAuthorityConfig,
  signal: AbortSignal,
): Promise<WorkflowTeamsNoticeRequest | undefined> {
  validateNotice(notice);
  const context = await verifyResponsibilityNoticeContext(authority, {
    workflowId: notice.workflowId,
    triggerId: notice.triggerId,
    occurrenceId: notice.occurrenceId,
    scheduledAt: notice.scheduledAt,
    ...(notice.taskId === undefined ? {} : { taskId: notice.taskId }),
  }, signal);
  if (!context || !context.workflow.enabled
    || context.workflow.id !== notice.workflowId
    || context.workflow.title !== notice.title
    || context.occurrence.scheduledAt !== notice.scheduledAt) return undefined;
  if (notice.kind === 'digest') {
    if (notice.triggerId !== 'daily-digest' || !context.workflow.notifications.digest.enabled
      || context.occurrence.status !== 'succeeded') return undefined;
  } else if (notice.triggerId === 'daily-digest') return undefined;
  if (notice.kind === 'failure' && context.occurrence.status !== 'failed'
    || notice.kind !== 'failure' && context.occurrence.status !== 'succeeded') return undefined;
  if (notice.kind === 'blocker' && notice.attentionKind === undefined
    || notice.kind !== 'blocker' && notice.attentionKind !== undefined) return undefined;

  const expectedKey = `workflow:${notice.workflowId}:${notice.occurrenceId}:${notice.kind}`;
  if (notice.deduplicationKey !== expectedKey) return undefined;
  const summary = plainText(notice.summary, 400);
  if (!summary) return undefined;
  return {
    occurrenceId: notice.occurrenceId,
    triggerId: notice.triggerId,
    scheduledAt: notice.scheduledAt,
    kind: notice.kind,
    summary,
    ...(notice.attentionKind === undefined ? {} : { attentionKind: notice.attentionKind }),
  };
}

/** Project and durably enqueue one notice; the stable Work API key makes recovery replay safe. */
export async function enqueueWorkflowNoticeToTeams(
  notice: WorkflowTeamsNotice,
  authority: ResponsibilityAuthorityConfig,
  enqueuer: TeamsNotificationEnqueuer,
  signal: AbortSignal,
): Promise<WorkflowOutboxReceipt | undefined> {
  const request = await projectWorkflowNoticeToTeamsMessage(notice, authority, signal);
  return request === undefined ? undefined : enqueuer.enqueueTeamsNotification(notice.workflowId, request);
}

function validateNotice(notice: WorkflowTeamsNotice): void {
  const allowed = new Set([
    'deduplicationKey', 'workflowId', 'occurrenceId', 'triggerId', 'kind', 'attentionKind',
    'scheduledAt', 'title', 'summary', 'taskId',
  ]);
  if (Object.keys(notice as unknown as Record<string, unknown>).some(key => !allowed.has(key))) {
    throw new TypeError('Workflow Teams notice cannot contain routing or identity fields');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(notice.workflowId)
    || !/^occ-[a-f0-9]{40}$/u.test(notice.occurrenceId)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(notice.triggerId)
    || !['change', 'failure', 'recovery', 'digest', 'blocker'].includes(notice.kind)
    || typeof notice.scheduledAt !== 'string' || !Number.isFinite(Date.parse(notice.scheduledAt))
    || typeof notice.title !== 'string' || !notice.title.trim() || notice.title.length > 200
    || typeof notice.summary !== 'string' || notice.summary.length > 4_000
    || (notice.attentionKind !== undefined
      && !['blocked_goal', 'user_decision', 'service_or_auth_outage'].includes(notice.attentionKind))
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(notice.deduplicationKey)
    || notice.taskId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(notice.taskId)) {
    throw new TypeError('Workflow Teams notice identity is invalid');
  }
}

function plainText(value: string, maxLength: number): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ' ')
    .replace(/@/gu, '＠')
    .replace(/</gu, '＜')
    .replace(/>/gu, '＞')
    .trim()
    .slice(0, maxLength);
}
