// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator responsibility authorization                      │
// │ Role: Verify background workflow provenance and exact connector scope.│
// │                                                                      │
// │ 模块职责：校验后台责任任务来源、所有者身份与连接器目标范围。            │
// └─────────────────────────────────────────────────────────────────────┘

import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { canonicalJson, sha256 } from './connector-authorization.ts';
import type { ConnectorThreadRecord, TaskRecord, WorkStateStore } from './work-state-client.ts';
import type {
  WorkflowAction,
  WorkflowActionGrant,
  WorkflowOperation,
  WorkflowScheduleEvent,
  WorkflowTarget,
  WorkflowV2Record,
} from './workflows/store.ts';

export type ConnectorResourceProjection =
  | 'empty'
  | 'profile'
  | 'github_repository'
  | 'github_pull_request'
  | 'github_ci'
  | 'github_commit'
  | 'github_issue'
  | 'github_actions_run'
  | 'github_actions_job'
  | 'github_branch'
  | 'github_file'
  | 'github_pull_request_draft'
  | 'computer_workspace'
  | 'computer_file'
  | 'computer_directory'
  | 'huggingface_repository'
  | 'cloud_target'
  | 'cloud_operation';

/** Stable Teams principal resolved from authenticated task state and current Directory policy. */
export interface ResponsibilityPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly tenantId: string;
}

/** Host-owned connector call details; no field is accepted from model routing metadata. */
export type ResponsibilityTaskRecord = TaskRecord;

export interface ResponsibilityConnectorBinding {
  readonly bindingId: string;
  readonly connectionRef: string;
  readonly providerId: string;
  readonly profileRef: string;
  readonly tools: readonly {
    readonly toolId: string;
    readonly operationId: string;
    readonly resourceProjection: ConnectorResourceProjection;
    readonly mutating: boolean;
  }[];
}

export interface ResponsibilityConnectorTool {
  readonly toolId: string;
  readonly operationId: string;
  readonly resourceProjection: ConnectorResourceProjection;
  readonly mutating: boolean;
}

export interface BackgroundConnectorCall {
  readonly taskId: string;
  readonly task: ResponsibilityTaskRecord;
  readonly binding: ResponsibilityConnectorBinding;
  readonly tool: ResponsibilityConnectorTool;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly signal: AbortSignal;
}

/** Return the canonical task owner only after the complete responsibility chain passes. */
export type BackgroundTaskAuthorizationResolver = (
  request: BackgroundConnectorCall,
) => Promise<ResponsibilityPrincipal | undefined>;

/** Narrow canonical v2 definition access needed for independent task verification. */
export interface ResponsibilityWorkflowStore {
  listWorkflows(definitionVersion: 2): Promise<readonly WorkflowV2Record[]>;
  getScheduleEvent(eventId: string): Promise<WorkflowScheduleEvent | undefined>;
}

/** Directory and Teams route policies supplied by the host configuration. */
export interface ResponsibilityAuthorityConfig {
  readonly workspaceId: string;
  readonly teamsConnectorId: string;
  readonly allowedTenantId: string;
  readonly allowedTeamIds: readonly string[];
  readonly allowedChannelIds?: readonly string[];
  readonly workState: Pick<WorkStateStore, 'getTask' | 'getConnectorThread'>;
  readonly workflows: ResponsibilityWorkflowStore;
  readonly isDirectoryAuthorized: (
    principal: ResponsibilityPrincipal,
    signal: AbortSignal,
  ) => Promise<boolean>;
}

/** Canonical context allowed to produce one Teams notification for a duty. */
export interface ResponsibilityNoticeContext {
  readonly task?: ResponsibilityTaskRecord;
  readonly workflow: WorkflowV2Record;
  readonly occurrence: ScheduleEvent;
  readonly ownerTask: TaskRecord;
  readonly principal: ResponsibilityPrincipal;
  readonly thread: ConnectorThreadRecord;
}

interface WorkflowTaskMetadata {
  readonly source: 'workflow';
  readonly workflowId: string;
  readonly triggerId: string;
  readonly occurrenceId: string;
  readonly scheduledAt: string;
  readonly authorizationRef: {
    readonly kind: 'teams_thread';
    readonly threadBindingId: string;
    readonly ownerTaskId: string;
  };
  readonly parentTaskId?: string;
  readonly actionId?: string;
  readonly actionType?: WorkflowAction;
  readonly actionRequestDigest?: string;
  readonly targetId?: string;
  readonly permittedOperations?: readonly WorkflowOperation[];
}

type WorkflowTaskRecord = ResponsibilityTaskRecord;

type WorkflowDefinition = WorkflowV2Record;
type ScheduleEvent = WorkflowScheduleEvent;

/**
 * Create a host-only resolver that independently reloads Work API provenance,
 * v2 workflow policy, the original Teams thread, and current Directory state.
 *
 * @param config - authenticated Work API, Directory, and allowed Teams routes.
 * @returns A fail-closed resolver for background connector calls.
 */
export function createResponsibilityAuthorizationResolver(
  config: ResponsibilityAuthorityConfig,
): BackgroundTaskAuthorizationResolver {
  const allowedTeams = new Set(config.allowedTeamIds.map(value => value.toLowerCase()));
  const allowedChannels = config.allowedChannelIds === undefined
    ? undefined
    : new Set(config.allowedChannelIds.map(value => value.toLowerCase()));
  const tenantId = normalizeUuid(config.allowedTenantId, 'allowed Teams tenant');

  return async request => {
    if (request.binding.providerId !== 'github' || request.taskId !== request.task.id) return undefined;
    if (request.signal.aborted) throw abortError(request.signal);

    const task = await config.workState.getTask(request.taskId);
    if (!task || !sameTaskAuthority(task as WorkflowTaskRecord, request.task)) return undefined;
    const taskRecord = task as WorkflowTaskRecord;
    if (taskRecord.workspaceId !== config.workspaceId || taskRecord.executionClass !== 'background') return undefined;
    if (taskRecord.status !== 'running') return undefined;
    const metadata = parseWorkflowTaskMetadata(taskRecord.metadata);
    if (!metadata) return undefined;

    const bindingTool = request.binding.tools.find(item => item.toolId === request.tool.toolId);
    if (!bindingTool || bindingTool.operationId !== request.tool.operationId
      || bindingTool.resourceProjection !== request.tool.resourceProjection
      || bindingTool.mutating !== request.tool.mutating) return undefined;

    const workflow = await readWorkflow(config.workflows, metadata.workflowId, request.signal);
    if (!workflow || !workflow.enabled || workflow.id !== metadata.workflowId) return undefined;
    const trigger = workflow.triggers.find(item => item.id === metadata.triggerId);
    if (!trigger) return undefined;
    const canonicalAuthorization = workflow.authorization;
    if (canonicalAuthorization.kind !== 'teams_thread'
      || canonicalAuthorization.threadBindingId !== metadata.authorizationRef.threadBindingId
      || canonicalAuthorization.ownerTaskId !== metadata.authorizationRef.ownerTaskId
      || workflow.notifications.destination.kind !== 'responsibility_thread') return undefined;

    if (!/^occ-[a-f0-9]{40}$/u.test(metadata.occurrenceId)) return undefined;
    const expectedObservationTaskId = `workflow-${metadata.occurrenceId.slice(4)}`;
    const occurrence = await readOccurrenceForTask(
      config.workflows, workflow.id, metadata.triggerId, metadata.scheduledAt, metadata.occurrenceId,
      expectedObservationTaskId, request.signal,
    );
    if (!occurrence || occurrence.status !== 'running') return undefined;

    const isActionChild = metadata.actionId !== undefined || metadata.actionType !== undefined
      || metadata.parentTaskId !== undefined || metadata.targetId !== undefined
      || metadata.permittedOperations !== undefined || metadata.actionRequestDigest !== undefined;
    let actionGrant: WorkflowActionGrant | undefined;
    if (isActionChild) {
      if (!metadata.actionId || !metadata.actionType || !metadata.parentTaskId || !metadata.targetId
        || !metadata.permittedOperations || !metadata.actionRequestDigest) return undefined;
      const expectedChildId = `workflow-action-${sha256(`${metadata.occurrenceId}\0${metadata.actionId}\0${metadata.targetId}`).slice(0, 40)}`;
      if (taskRecord.id !== expectedChildId) return undefined;
      const parentTask = await config.workState.getTask(metadata.parentTaskId);
      if (!parentTask || parentTask.id !== expectedObservationTaskId
        || (parentTask as WorkflowTaskRecord).executionClass !== 'background'
        || parentTask.status !== 'running'
        || parentTask.sessionId !== taskRecord.sessionId
        || !sameWorkflowOccurrence(parseWorkflowTaskMetadata(parentTask.metadata), metadata)) return undefined;
      if (occurrence.taskId !== parentTask.id || occurrence.status !== 'running') return undefined;
      actionGrant = workflow.actionPolicy.allowedActions.find(grant => grant.id === metadata.actionId);
      if (!actionGrant || actionGrant.action !== metadata.actionType
        || !actionGrant.targetIds.includes(metadata.targetId)
        || canonicalJson(actionGrant.permittedOperations) !== canonicalJson(metadata.permittedOperations)) return undefined;
      if (!await hasActiveActionAuthorization(
        config.workflows, workflow.id, metadata.triggerId, occurrence.scheduledAt,
        taskRecord.id, metadata.actionId, metadata.actionType, metadata.targetId,
        metadata.actionRequestDigest, request.signal,
      )) return undefined;
    } else {
      if (taskRecord.id !== expectedObservationTaskId || occurrence.taskId !== taskRecord.id
        || metadata.targetId !== undefined || metadata.permittedOperations !== undefined
        || metadata.actionRequestDigest !== undefined) return undefined;
      if (occurrence.status !== 'running') return undefined;
    }

    const ownerTask = await config.workState.getTask(canonicalAuthorization.ownerTaskId);
    if (!ownerTask || ownerTask.workspaceId !== config.workspaceId) return undefined;
    const principal = parseTeamsPrincipal(ownerTask.metadata?.teamsCaller);
    if (!principal || principal.tenantId !== tenantId) return undefined;
    if (!await config.isDirectoryAuthorized(principal, request.signal)) return undefined;

    const thread = await config.workState.getConnectorThread(
      config.teamsConnectorId,
      canonicalAuthorization.threadBindingId,
      100,
    );
    if (thread.threadId !== canonicalAuthorization.threadBindingId
      || !isAllowedThread(thread, ownerTask, principal, tenantId, allowedTeams, allowedChannels)) return undefined;

    const repo = matchRepositoryTarget(workflow.targets, request.binding.bindingId, request.arguments);
    if (!repo) return undefined;
    if (!workflow.targets.some(target => target.id === repo.id)) return undefined;
    if (!trigger.targetIds.includes(repo.id)) return undefined;
    if (isActionChild && metadata.targetId !== repo.id) return undefined;

    if (!request.tool.mutating) {
      if (!isTargetedReadProjection(request.tool.resourceProjection)) return undefined;
      if (actionGrant && !actionGrant.targetIds.includes(repo.id)) return undefined;
      return principal;
    }

    if (!isActionChild || !actionGrant || !isAllowedActionOperation(actionGrant, request.tool.operationId)) return undefined;
    if (!actionGrant.targetIds.includes(repo.id)) return undefined;
    if (!isActionTargetWithinPolicy(actionGrant, request.tool.resourceProjection, request.arguments)) return undefined;
    return principal;
  };
}

/** Canonical schedule identity used to validate a route-free notification request. */
export interface ResponsibilityNoticeProof {
  readonly workflowId: string;
  readonly triggerId: string;
  readonly occurrenceId: string;
  readonly scheduledAt: string;
  readonly taskId?: string;
}

/** Verified active Teams owner context for host-registered responsibility controls. */
export interface ActiveTeamsOwnerContext {
  readonly task: TaskRecord;
  readonly principal: ResponsibilityPrincipal;
  readonly thread: ConnectorThreadRecord;
}

/** Canonical responsibility definition owned by the caller of the current Teams task. */
export interface WorkflowOwnerContext {
  readonly workflow: WorkflowV2Record;
  readonly ownerTask: TaskRecord;
  readonly principal: ResponsibilityPrincipal;
  readonly thread: ConnectorThreadRecord;
}

/** Validate a live Teams task and its current Directory/thread authority for owner controls. */
export async function verifyActiveTeamsOwnerContext(
  config: ResponsibilityAuthorityConfig,
  taskId: string,
  signal: AbortSignal,
): Promise<ActiveTeamsOwnerContext | undefined> {
  if (signal.aborted) throw abortError(signal);
  if (!/^teams-[A-Za-z0-9._-]{1,120}$/u.test(taskId)) return undefined;
  const task = await config.workState.getTask(taskId);
  if (!task || task.id !== taskId || task.workspaceId !== config.workspaceId
    || task.executionClass !== 'foreground' || task.status !== 'running') return undefined;
  const principal = parseTeamsPrincipal(task.metadata?.teamsCaller);
  const tenantId = normalizeUuid(config.allowedTenantId, 'allowed Teams tenant');
  if (!principal || principal.tenantId !== tenantId
    || !await config.isDirectoryAuthorized(principal, signal)) return undefined;
  const route = asRecord(task.metadata?.teamsThread);
  const threadId = safeText(route?.threadId, 128);
  if (!threadId || !/^[a-f0-9]{64}$/u.test(threadId)) return undefined;
  const thread = await config.workState.getConnectorThread(config.teamsConnectorId, threadId, 100);
  const allowedTeams = new Set(config.allowedTeamIds.map(value => value.toLowerCase()));
  const allowedChannels = config.allowedChannelIds === undefined
    ? undefined
    : new Set(config.allowedChannelIds.map(value => value.toLowerCase()));
  if (thread.threadId !== threadId
    || !isAllowedThread(thread, task, principal, tenantId, allowedTeams, allowedChannels)) return undefined;
  return { task, principal, thread };
}

/** Verify a selected responsibility belongs to the same currently authorized Teams principal. */
export async function verifyWorkflowOwnerAccess(
  config: ResponsibilityAuthorityConfig,
  workflowId: string,
  activePrincipal: ResponsibilityPrincipal,
  signal: AbortSignal,
): Promise<WorkflowOwnerContext | undefined> {
  if (signal.aborted) throw abortError(signal);
  const workflow = await readWorkflow(config.workflows, workflowId, signal);
  if (!workflow || workflow.id !== workflowId
    || workflow.authorization.kind !== 'teams_thread'
    || workflow.notifications.destination.kind !== 'responsibility_thread') return undefined;
  const tenantId = normalizeUuid(config.allowedTenantId, 'allowed Teams tenant');
  if (activePrincipal.tenantId !== tenantId
    || !await config.isDirectoryAuthorized(activePrincipal, signal)) return undefined;
  const ownerTask = await config.workState.getTask(workflow.authorization.ownerTaskId);
  if (!ownerTask || ownerTask.workspaceId !== config.workspaceId) return undefined;
  const owner = parseTeamsPrincipal(ownerTask.metadata?.teamsCaller);
  if (!owner || owner.issuer !== activePrincipal.issuer || owner.subject !== activePrincipal.subject
    || owner.tenantId !== activePrincipal.tenantId) return undefined;
  const allowedTeams = new Set(config.allowedTeamIds.map(value => value.toLowerCase()));
  const allowedChannels = config.allowedChannelIds === undefined
    ? undefined
    : new Set(config.allowedChannelIds.map(value => value.toLowerCase()));
  const thread = await config.workState.getConnectorThread(
    config.teamsConnectorId, workflow.authorization.threadBindingId, 100,
  );
  if (thread.threadId !== workflow.authorization.threadBindingId
    || !isAllowedThread(thread, ownerTask, owner, tenantId, allowedTeams, allowedChannels)) return undefined;
  return { workflow, ownerTask, principal: owner, thread };
}

/** Verify the terminal schedule receipt and the original owner/thread before projection. */
export async function verifyResponsibilityNoticeContext(
  config: ResponsibilityAuthorityConfig,
  proof: ResponsibilityNoticeProof,
  signal: AbortSignal,
): Promise<ResponsibilityNoticeContext | undefined> {
  if (signal.aborted) throw abortError(signal);
  const workflow = await readWorkflow(config.workflows, proof.workflowId, signal);
  if (!workflow || !workflow.enabled || workflow.id !== proof.workflowId
    || workflow.notifications.destination.kind !== 'responsibility_thread') return undefined;
  const isDigest = proof.triggerId === 'daily-digest';
  if (isDigest ? !workflow.notifications.digest.enabled
    : !workflow.triggers.some(trigger => trigger.id === proof.triggerId)) return undefined;
  const occurrence = await readTerminalOccurrence(
    config.workflows, workflow.id, proof.triggerId, proof.scheduledAt, proof.occurrenceId, signal,
  );
  if (!occurrence || occurrence.workflowId !== workflow.id || occurrence.taskId === undefined
    || proof.taskId !== undefined && proof.taskId !== occurrence.taskId) return undefined;

  const ownerTask = await config.workState.getTask(workflow.authorization.ownerTaskId);
  if (!ownerTask || ownerTask.workspaceId !== config.workspaceId) return undefined;
  let task: ResponsibilityTaskRecord | undefined;
  if (isDigest) {
    if (occurrence.taskId !== ownerTask.id || proof.taskId !== ownerTask.id) return undefined;
  } else {
    if (occurrence.taskId !== `workflow-${proof.occurrenceId.slice(4)}`) return undefined;
    task = await config.workState.getTask(occurrence.taskId) as ResponsibilityTaskRecord | undefined;
    if (!task || task.workspaceId !== config.workspaceId || task.executionClass !== 'background') return undefined;
    const metadata = parseWorkflowTaskMetadata(task.metadata);
    if (!metadata || metadata.source !== 'workflow' || metadata.workflowId !== workflow.id
      || metadata.triggerId !== proof.triggerId || metadata.occurrenceId !== proof.occurrenceId
      || metadata.scheduledAt !== proof.scheduledAt
      || metadata.authorizationRef.threadBindingId !== workflow.authorization.threadBindingId
      || metadata.authorizationRef.ownerTaskId !== workflow.authorization.ownerTaskId
      || task.id !== occurrence.taskId) return undefined;
  }
  const principal = parseTeamsPrincipal(ownerTask.metadata?.teamsCaller);
  const allowedTeams = new Set(config.allowedTeamIds.map(value => value.toLowerCase()));
  const allowedChannels = config.allowedChannelIds === undefined
    ? undefined
    : new Set(config.allowedChannelIds.map(value => value.toLowerCase()));
  const tenantId = normalizeUuid(config.allowedTenantId, 'allowed Teams tenant');
  if (!principal || principal.tenantId !== tenantId
    || !await config.isDirectoryAuthorized(principal, signal)) return undefined;
  const thread = await config.workState.getConnectorThread(
    config.teamsConnectorId, workflow.authorization.threadBindingId, 100,
  );
  if (thread.threadId !== workflow.authorization.threadBindingId
    || !isAllowedThread(thread, ownerTask, principal, tenantId, allowedTeams, allowedChannels)) return undefined;
  return { ...(task === undefined ? {} : { task }), workflow, occurrence, ownerTask, principal, thread };
}

function parseWorkflowTaskMetadata(value: Readonly<Record<string, unknown>> | undefined): WorkflowTaskMetadata | undefined {
  if (!value || value.source !== 'workflow') return undefined;
  const workflowId = safeText(value.workflowId, 120);
  const triggerId = safeText(value.triggerId, 120);
  const occurrenceId = safeText(value.occurrenceId, 120);
  const scheduledAt = safeText(value.scheduledAt, 64);
  const authorization = asRecord(value.authorizationRef);
  if (!workflowId || !triggerId || !occurrenceId || !scheduledAt || !authorization
    || authorization.kind !== 'teams_thread') return undefined;
  const threadBindingId = safeText(authorization.threadBindingId, 128);
  const ownerTaskId = safeText(authorization.ownerTaskId, 128);
  if (!threadBindingId || !ownerTaskId || !/^[a-f0-9]{64}$/u.test(threadBindingId)) return undefined;
  const parentTaskId = safeText(value.parentTaskId, 128);
  const actionId = safeText(value.actionId, 120);
  const actionTypeText = safeText(value.actionType, 80);
  const actionType = isWorkflowAction(actionTypeText) ? actionTypeText : undefined;
  const actionRequestDigest = safeText(value.actionRequestDigest, 64);
  const targetId = safeText(value.targetId, 32);
  const operationTexts = value.permittedOperations === undefined
    ? undefined
    : stringList(value.permittedOperations, 100, 160);
  const permittedOperations: readonly WorkflowOperation[] | undefined = operationTexts !== undefined
    && operationTexts.every(isWorkflowOperation)
    ? operationTexts as readonly WorkflowOperation[]
    : undefined;
  if (value.permittedOperations !== undefined && permittedOperations === undefined
    || actionTypeText !== undefined && actionType === undefined
    || actionRequestDigest !== undefined && !/^[a-f0-9]{64}$/u.test(actionRequestDigest)
    || !Number.isFinite(Date.parse(scheduledAt))) return undefined;
  return {
    source: 'workflow', workflowId, triggerId, occurrenceId,
    authorizationRef: { kind: 'teams_thread', threadBindingId, ownerTaskId },
    scheduledAt,
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    ...(actionId === undefined ? {} : { actionId }),
    ...(actionType === undefined ? {} : { actionType }),
    ...(actionRequestDigest === undefined ? {} : { actionRequestDigest }),
    ...(targetId === undefined ? {} : { targetId }),
    ...(permittedOperations === undefined ? {} : { permittedOperations }),
  };
}

async function readWorkflow(
  store: ResponsibilityWorkflowStore,
  workflowId: string,
  signal: AbortSignal,
): Promise<WorkflowDefinition | undefined> {
  if (signal.aborted) throw abortError(signal);
  const definitions = await store.listWorkflows(2);
  const matches = definitions.filter(row => row.id === workflowId && row.version === 2);
  if (matches.length !== 1) return undefined;
  return matches[0];
}

async function readOccurrenceForTask(
  store: ResponsibilityWorkflowStore,
  workflowId: string,
  triggerId: string,
  scheduledAt: string,
  occurrenceId: string,
  taskId: string,
  signal: AbortSignal,
): Promise<ScheduleEvent | undefined> {
  if (workflowOccurrenceId(workflowId, triggerId, scheduledAt) !== occurrenceId
    || taskId !== `workflow-${occurrenceId.slice(4)}`) return undefined;
  const [running, succeeded, failed] = await Promise.all([
    readScheduleEvent(store, scheduleEventId(workflowId, triggerId, scheduledAt, 'running'), signal),
    readScheduleEvent(store, scheduleEventId(workflowId, triggerId, scheduledAt, 'succeeded'), signal),
    readScheduleEvent(store, scheduleEventId(workflowId, triggerId, scheduledAt, 'failed'), signal),
  ]);
  if (succeeded || failed) return undefined;
  return running?.workflowId === workflowId && running.triggerId === triggerId
    && running.scheduledAt === scheduledAt && running.taskId === taskId && running.status === 'running'
    ? running
    : undefined;
}

async function readTerminalOccurrence(
  store: ResponsibilityWorkflowStore,
  workflowId: string,
  triggerId: string,
  scheduledAt: string,
  occurrenceId: string,
  signal: AbortSignal,
): Promise<ScheduleEvent | undefined> {
  if (workflowOccurrenceId(workflowId, triggerId, scheduledAt) !== occurrenceId) return undefined;
  const [succeeded, failed] = await Promise.all([
    readScheduleEvent(store, scheduleEventId(workflowId, triggerId, scheduledAt, 'succeeded'), signal),
    readScheduleEvent(store, scheduleEventId(workflowId, triggerId, scheduledAt, 'failed'), signal),
  ]);
  if (Boolean(succeeded) === Boolean(failed)) return undefined;
  const event = succeeded ?? failed;
  return event?.workflowId === workflowId && event.triggerId === triggerId
    && event.scheduledAt === scheduledAt && event.status === (succeeded ? 'succeeded' : 'failed')
    ? event
    : undefined;
}

async function hasActiveActionAuthorization(
  store: ResponsibilityWorkflowStore,
  workflowId: string,
  triggerId: string,
  scheduledAt: string,
  taskId: string,
  actionId: string,
  actionType: string,
  targetId: string,
  requestDigest: string,
  signal: AbortSignal,
): Promise<boolean> {
  const occurrenceId = workflowOccurrenceId(workflowId, triggerId, scheduledAt);
  const id = `workflow-auth-${sha256(`${occurrenceId}\0${actionId}\0${targetId}`).slice(0, 40)}`;
  const event = await readScheduleEvent(store, id, signal);
  if (!event || event.workflowId !== workflowId || event.triggerId !== triggerId
    || event.scheduledAt !== scheduledAt || event.status !== 'running' || event.actionResults?.length !== 1) return false;
  const [terminalSucceeded, terminalFailed] = await Promise.all([
    readScheduleEvent(store, scheduleEventId(workflowId, triggerId, scheduledAt, 'succeeded'), signal),
    readScheduleEvent(store, scheduleEventId(workflowId, triggerId, scheduledAt, 'failed'), signal),
  ]);
  if (terminalSucceeded || terminalFailed) return false;
  const receipt = event.actionResults[0];
  return receipt !== undefined && receipt.taskId === taskId && receipt.actionId === actionId
    && receipt.actionType === actionType && receipt.targetId === targetId
    && receipt.requestDigest === requestDigest && receipt.status === 'waiting';
}

async function readScheduleEvent(
  store: ResponsibilityWorkflowStore,
  eventId: string,
  signal: AbortSignal,
): Promise<ScheduleEvent | undefined> {
  if (signal.aborted) throw abortError(signal);
  const raw = await store.getScheduleEvent(eventId);
  if (raw === undefined || raw === null) return undefined;
  if (raw.id !== eventId) throw new TypeError('Work API returned a mismatched workflow schedule event');
  return raw;
}

function scheduleEventId(
  workflowId: string,
  triggerId: string,
  scheduledAt: string,
  status: 'queued' | 'running' | 'succeeded' | 'failed',
): string {
  const occurrenceKey = triggerId === 'default'
    ? `${workflowId}\0${scheduledAt}`
    : `${workflowId}\0${triggerId}\0${scheduledAt}`;
  return `workflow-${sha256(`${occurrenceKey}\0${status}`).slice(0, 48)}`;
}

function workflowOccurrenceId(workflowId: string, triggerId: string, scheduledAt: string): string {
  return `occ-${sha256(`${workflowId}\0${triggerId}\0${scheduledAt}`).slice(0, 40)}`;
}

function parseTeamsPrincipal(value: unknown): ResponsibilityPrincipal | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const tenantId = safeText(row.tenantId, 64)?.toLowerCase();
  const subject = safeText(row.subject, 64)?.toLowerCase();
  const issuer = safeText(row.issuer, 256);
  if (!tenantId || !subject || !issuer || !isUuid(tenantId) || !isUuid(subject)
    || issuer !== `https://login.microsoftonline.com/${tenantId}/v2.0`
    || row.actorAadObjectId !== undefined && String(row.actorAadObjectId).toLowerCase() !== subject) return undefined;
  return { issuer, subject, tenantId };
}

function isAllowedThread(
  thread: ConnectorThreadRecord,
  ownerTask: TaskRecord,
  owner: ResponsibilityPrincipal,
  tenantId: string,
  allowedTeams: ReadonlySet<string>,
  allowedChannels: ReadonlySet<string> | undefined,
): boolean {
  if (thread.tenantId.toLowerCase() !== tenantId || thread.tenantId.toLowerCase() !== owner.tenantId
    || !allowedTeams.has(thread.teamId.toLowerCase())
    || allowedChannels !== undefined && !allowedChannels.has(thread.channelId.toLowerCase())) return false;
  if (thread.messages.length > 100) return false;
  const threadMetadata = asRecord(ownerTask.metadata?.teamsThread);
  const routeMetadata = asRecord(asRecord(ownerTask.metadata?.notification)?.payload);
  if (!threadMetadata || !routeMetadata) return false;
  const routeFields: readonly (keyof Pick<ConnectorThreadRecord,
    'tenantId' | 'teamId' | 'channelId' | 'conversationId' | 'rootThreadId'>)[] = [
      'tenantId', 'teamId', 'channelId', 'conversationId', 'rootThreadId',
    ];
  return thread.sessionId === ownerTask.sessionId
    && threadMetadata.threadId === thread.threadId
    && routeFields.every(field => threadMetadata[field] === thread[field] && routeMetadata[field] === thread[field])
    && routeMetadata.serviceUrl === thread.serviceUrl;
}

function matchRepositoryTarget(
  targets: readonly WorkflowTarget[],
  bindingId: string,
  args: Readonly<Record<string, JsonValue>>,
): WorkflowTarget | undefined {
  const idValue = args.repository_id;
  const id = typeof idValue === 'number' && Number.isSafeInteger(idValue) && idValue > 0
    ? String(idValue)
    : typeof idValue === 'string' && /^[1-9]\d{0,18}$/u.test(idValue) ? idValue : undefined;
  const name = typeof args.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(args.repository)
    ? args.repository
    : undefined;
  if (!id || !name) return undefined;
  return targets.find(target => target.kind === 'github_repository'
    && target.bindingId === bindingId
    && /^[1-9]\d{0,18}$/u.test(target.id)
    && target.id === id && target.label === name && target.uri === `https://github.com/${name}`);
}

function isTargetedReadProjection(projection: ConnectorResourceProjection): boolean {
  return [
    'github_repository', 'github_pull_request', 'github_ci', 'github_commit', 'github_issue',
    'github_actions_run', 'github_actions_job', 'github_branch', 'github_file', 'github_pull_request_draft',
  ].includes(projection);
}

function isAllowedActionOperation(grant: WorkflowActionGrant, operationId: string): boolean {
  if (!isWorkflowOperation(operationId) || !grant.permittedOperations.includes(operationId)) return false;
  const allowedByAction: Readonly<Record<WorkflowAction, readonly WorkflowOperation[]>> = {
    draft_pull_request: [
      'github.branch.create', 'github.branch.delete', 'github.file.commit', 'github.pull_request.draft.create',
    ],
    rerun_source_ci: ['github.actions.rerun_failed'],
    update_issue_progress: ['github.issue.comment.create', 'github.issue.state.update'],
  };
  return allowedByAction[grant.action]?.includes(operationId) === true;
}

function isActionTargetWithinPolicy(
  grant: WorkflowActionGrant,
  projection: ConnectorResourceProjection,
  args: Readonly<Record<string, JsonValue>>,
): boolean {
  switch (projection) {
    case 'github_branch':
      return typeof args.branch === 'string'
        && grant.branchPrefixes.some(prefix => (args.branch as string).startsWith(prefix));
    case 'github_file':
      return typeof args.branch === 'string' && grant.branchPrefixes.some(prefix => (args.branch as string).startsWith(prefix))
        && typeof args.path === 'string' && grant.pathPrefixes.some(prefix => isPathWithinPrefix(args.path as string, prefix));
    case 'github_pull_request_draft':
      return typeof args.head_branch === 'string'
        && grant.branchPrefixes.some(prefix => (args.head_branch as string).startsWith(prefix))
        && typeof args.base_branch === 'string' && grant.baseBranches.includes(args.base_branch);
    case 'github_issue': {
      const number = typeof args.issue_number === 'number' ? args.issue_number
        : typeof args.issue_number === 'string' && /^\d+$/u.test(args.issue_number) ? Number(args.issue_number) : Number.NaN;
      return Number.isSafeInteger(number) && grant.issueNumbers.includes(number);
    }
    case 'github_actions_run': {
      const expectedWorkflowId = args.expected_workflow_id;
      const expectedHeadBranch = args.expected_head_branch;
      const expectedHeadSha = args.expected_head_sha;
      const expectedAttempt = args.expected_attempt;
      return grant.action === 'rerun_source_ci'
        && grant.permittedOperations.includes('github.actions.rerun_failed')
        && grant.sourceWorkflowIds.length > 0
        && typeof expectedWorkflowId === 'string'
        && /^[1-9][0-9]{0,19}$/u.test(expectedWorkflowId)
        && grant.sourceWorkflowIds.includes(expectedWorkflowId)
        && typeof expectedHeadBranch === 'string'
        && isSafeSourceBranch(expectedHeadBranch)
        && grant.branchPrefixes.some(prefix => expectedHeadBranch.startsWith(prefix))
        && typeof expectedHeadSha === 'string'
        && /^[a-f0-9]{40}$/iu.test(expectedHeadSha)
        && typeof expectedAttempt === 'number'
        && Number.isSafeInteger(expectedAttempt)
        && expectedAttempt > 0
        && expectedAttempt <= 2_147_483_647;
    }
    default:
      return false;
  }
}

function isSafeSourceBranch(branch: string): boolean {
  return branch.startsWith('cyrene/assistant/')
    && branch.length <= 255
    && !branch.includes('..')
    && !branch.includes('\\')
    && !/\s/u.test(branch)
    && !branch.endsWith('/')
    && branch.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isPathWithinPrefix(path: string, prefix: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) return false;
  if (prefix === '**') return true;
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path === prefix || path.startsWith(normalizedPrefix);
}

function sameWorkflowOccurrence(
  parent: WorkflowTaskMetadata | undefined,
  child: WorkflowTaskMetadata,
): boolean {
  return parent?.source === 'workflow' && parent.workflowId === child.workflowId
    && parent.triggerId === child.triggerId && parent.occurrenceId === child.occurrenceId
    && parent.scheduledAt === child.scheduledAt
    && parent.authorizationRef.threadBindingId === child.authorizationRef.threadBindingId
    && parent.authorizationRef.ownerTaskId === child.authorizationRef.ownerTaskId
    && parent.parentTaskId === undefined && parent.actionId === undefined && parent.actionType === undefined
    && parent.actionRequestDigest === undefined && parent.targetId === undefined && parent.permittedOperations === undefined;
}

function isWorkflowAction(value: string | undefined): value is WorkflowAction {
  return value === 'draft_pull_request' || value === 'rerun_source_ci' || value === 'update_issue_progress';
}

function isWorkflowOperation(value: string): value is WorkflowOperation {
  return value === 'github.branch.create'
    || value === 'github.branch.delete'
    || value === 'github.file.commit'
    || value === 'github.pull_request.draft.create'
    || value === 'github.actions.rerun_failed'
    || value === 'github.issue.comment.create'
    || value === 'github.issue.state.update';
}

function sameTaskAuthority(left: WorkflowTaskRecord, right: WorkflowTaskRecord): boolean {
  return left.id === right.id && left.status === right.status && left.sessionId === right.sessionId
    && left.workspaceId === right.workspaceId && left.executionClass === right.executionClass
    && canonicalJson(left.metadata ?? {}) === canonicalJson(right.metadata ?? {});
}

function stringList(value: unknown, limit: number, maxLength: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > limit) return undefined;
  const result = value.map(item => safeText(item, maxLength));
  if (result.some(item => item === undefined) || new Set(result).size !== result.length) return undefined;
  return result as string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeText(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && value === value.trim()
    ? value
    : undefined;
}

function normalizeUuid(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!isUuid(normalized)) throw new TypeError(`${label} must be a UUID`);
  return normalized;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Background authorization was cancelled');
}
