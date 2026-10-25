// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator responsibility management tools                   │
// │ Role: Expose owner-scoped, durable duties to the existing DSH loop. │
// │                                                                      │
// │ 模块职责：向现有 DSH 对话开放经身份校验的长期职责管理能力。            │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {
  ActiveTeamsOwnerContext,
  ResponsibilityPrincipal,
  WorkflowOwnerContext,
} from './responsibility-authority.js';
import type {
  WorkflowAction,
  WorkflowOperation,
  WorkflowScheduleEvent,
  WorkflowV2Record,
  WorkflowV2Write,
} from './workflows/store.js';
import { validateWorkflowWrite } from './workflows/store.js';

export interface ResponsibilityTargetActionGrant {
  readonly id: string;
  readonly action: WorkflowAction;
  readonly baseBranches: readonly string[];
  readonly branchPrefixes: readonly string[];
  readonly pathPrefixes: readonly string[];
  readonly issueNumbers: readonly number[];
  readonly sourceWorkflowIds: readonly string[];
  readonly permittedOperations: readonly WorkflowOperation[];
}

/** One GitHub repository and its fixed, operator-approved write boundaries. */
export interface ResponsibilityTargetConfig {
  readonly id: string;
  readonly label: string;
  readonly bindingId: string;
  readonly uri: string;
  readonly actionGrants: readonly ResponsibilityTargetActionGrant[];
}

/** Provider-reported model usage read from the durable task event stream. */
export interface ResponsibilityModelUsageSnapshot {
  readonly taskId: string;
  readonly routes: readonly {
    readonly provider: string;
    readonly model: string;
    readonly reportedCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens?: number;
  }[];
}

/** Host-only dependencies; identity, routing, model defaults, and write scope never come from model arguments. */
export interface ResponsibilityToolsConfig {
  readonly workflows: {
    listWorkflows(definitionVersion: 2): Promise<readonly WorkflowV2Record[]>;
    putWorkflow(workflow: WorkflowV2Write): Promise<WorkflowV2Record>;
    listScheduleEvents(options: {
      readonly workflowId: string;
      readonly limit?: number;
      readonly cursor?: string;
    }): Promise<{
      readonly items: readonly WorkflowScheduleEvent[];
      readonly nextCursor: string | null;
    }>;
  };
  readonly resolveActiveOwner: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<ActiveTeamsOwnerContext | undefined>;
  readonly authorizeWorkflowOwner: (
    workflowId: string,
    principal: ResponsibilityPrincipal,
    signal: AbortSignal,
  ) => Promise<WorkflowOwnerContext | undefined>;
  readonly readModelUsage: (taskId: string) => Promise<ResponsibilityModelUsageSnapshot>;
  readonly syncWorkflows: () => Promise<void>;
  readonly allowedTargets: readonly ResponsibilityTargetConfig[];
  readonly modelPolicy: WorkflowV2Write['modelPolicy'];
  readonly quietHours?: {
    readonly start: string;
    readonly end: string;
    readonly timeZone: string;
  };
}

const toolOutput = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

const TOOL_PREFIX = 'responsibility_';
const EVENT_PAGE_SIZE = 50;
const USAGE_EVENT_PAGE_SIZE = 100;
const DEFAULT_QUIET_HOURS = { start: '22:00', end: '08:00', timeZone: 'America/New_York' } as const;
const DEFAULT_INSTRUCTIONS = [
  'Continuously observe only the configured repositories and advance the owner\'s goal using the allowed action grants.',
  'Report concrete evidence and meaningful progress in the originating Teams thread.',
  'Ask the owner when a decision or required detail is missing.',
  'Never merge, release, change production, incur new spend, broaden repository scope, or change this action policy.',
].join(' ');
const WRITE_OPERATIONS: Readonly<Record<WorkflowAction, ReadonlySet<WorkflowOperation>>> = {
  draft_pull_request: new Set([
    'github.branch.create', 'github.branch.delete', 'github.file.commit', 'github.pull_request.draft.create',
  ]),
  rerun_source_ci: new Set(['github.actions.rerun_failed']),
  update_issue_progress: new Set(['github.issue.comment.create', 'github.issue.state.update']),
};

/**
 * Register owner-scoped responsibility commands in the existing model tool catalog.
 * @param ctx - the active DSH Cordis context.
 * @param config - canonical Work API, Directory authorization, and host policy callbacks.
 * @returns A disposer for the exact tools registered by this call.
 */
export function registerResponsibilityTools(ctx: Context, config: ResponsibilityToolsConfig): () => void {
  validateResponsibilityToolsConfig(config);
  const handlers = new ResponsibilityCommandHandlers(config);
  const disposers = [
    ctx.tools.register(defineTool({
      name: `${TOOL_PREFIX}repositories`,
      description: 'List the GitHub repositories configured for owner-managed duties. Returns safe labels and opaque repository ids; this never grants or changes access.',
      parameters: {},
      output: toolOutput,
      execute: (_args, exec) => handlers.listRepositories(exec),
    })),
    ctx.tools.register(defineTool({
      name: `${TOOL_PREFIX}list`,
      description: 'List this currently authorized Teams owner\'s proactive duties. Use before creating a duty or changing one.',
      parameters: {},
      output: toolOutput,
      execute: (_args, exec) => handlers.listDuties(exec),
    })),
    ctx.tools.register(defineTool({
      name: `${TOOL_PREFIX}create`,
      description: 'Create an owner-requested GitHub duty from a title, goal, and configured repository ids. Repository access, allowed actions, model route, and notification thread are fixed by host policy; this tool cannot grant permissions.',
      parameters: {
        title: { type: 'string', required: true },
        goal: { type: 'string', required: true },
        repositoryIds: { type: 'array', items: { type: 'string' }, required: true },
      },
      output: toolOutput,
      execute: (args, exec) => handlers.createDuty(args, exec),
    })),
    ctx.tools.register(defineTool({
      name: `${TOOL_PREFIX}pause`,
      description: 'Pause one of this owner\'s duties by its id. Does not delete history or alter its access policy.',
      parameters: { dutyId: { type: 'string', required: true } },
      output: toolOutput,
      execute: (args, exec) => handlers.setDutyEnabled(args, exec, false),
    })),
    ctx.tools.register(defineTool({
      name: `${TOOL_PREFIX}resume`,
      description: 'Resume one of this owner\'s paused duties by its id, keeping the original target, action, model, and notification policies.',
      parameters: { dutyId: { type: 'string', required: true } },
      output: toolOutput,
      execute: (args, exec) => handlers.setDutyEnabled(args, exec, true),
    })),
    ctx.tools.register(defineTool({
      name: `${TOOL_PREFIX}update_goal`,
      description: 'Update the goal text for one of this owner\'s duties. This cannot change its repositories or permitted actions.',
      parameters: {
        dutyId: { type: 'string', required: true },
        goal: { type: 'string', required: true },
      },
      output: toolOutput,
      execute: (args, exec) => handlers.updateGoal(args, exec),
    })),
    ctx.tools.register(defineTool({
      name: `${TOOL_PREFIX}status`,
      description: 'Read the latest status and source-backed evidence for one of this owner\'s duties. Use the returned cursor to continue through older receipts.',
      parameters: {
        dutyId: { type: 'string', required: true },
        cursor: { type: 'string' },
      },
      output: toolOutput,
      execute: (args, exec) => handlers.readStatus(args, exec),
    })),
    ctx.tools.register(defineTool({
      name: `${TOOL_PREFIX}usage`,
      description: 'Read actual provider-reported token usage for the current conversation or an owned duty. Reports provider and model names and token counts only; it does not estimate cost or enforce a usage limit.',
      parameters: { dutyId: { type: 'string' } },
      output: toolOutput,
      execute: (args, exec) => handlers.readUsage(args, exec),
    })),
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

class ResponsibilityCommandHandlers {
  constructor(private readonly config: ResponsibilityToolsConfig) {}

  async listRepositories(exec: ToolRunContext): Promise<Record<string, JsonValue>> {
    await this.activeOwner(exec);
    return {
      repositories: this.config.allowedTargets.map(target => ({ id: target.id, label: target.label })),
    };
  }

  async listDuties(exec: ToolRunContext): Promise<Record<string, JsonValue>> {
    const owner = await this.activeOwner(exec);
    const rows = await this.config.workflows.listWorkflows(2);
    const duties: JsonValue[] = [];
    for (const candidate of rows) {
      const verified = await this.authorizedWorkflow(candidate.id, owner, exec.signal);
      if (verified === undefined) continue;
      duties.push(projectDuty(verified.workflow, this.config.allowedTargets));
    }
    return { duties };
  }

  async createDuty(args: unknown, exec: ToolRunContext): Promise<Record<string, JsonValue>> {
    const owner = await this.activeOwner(exec);
    const input = object(args, 'duty request');
    const title = safeText(input.title, 'title', 120, false);
    const goal = safeText(input.goal, 'goal', 4_000, true);
    const repositoryIds = stringList(input.repositoryIds, 'repositoryIds', 1, this.config.allowedTargets.length);
    if (new Set(repositoryIds).size !== repositoryIds.length) throw new TypeError('repositoryIds must be unique');
    const selected = repositoryIds.map(id => {
      const target = this.config.allowedTargets.find(candidate => candidate.id === id);
      if (target === undefined) throw new Error('A requested repository is not in the host-configured allowlist');
      return target;
    });
    const titleKey = title.toLocaleLowerCase('en-US').trim();
    const workflowId = `duty-${hash(`${owner.task.id}\0${titleKey}\0${goal}\0${selected.map(target => target.id).sort().join(',')}`).slice(0, 40)}`;
    const existing = await this.config.workflows.listWorkflows(2);
    if (existing.some(row => row.id === workflowId)) {
      const prior = await this.authorizedWorkflow(workflowId, owner, exec.signal);
      if (prior === undefined) throw new Error('A matching duty id already exists but its owner cannot be verified');
      const schedule = await this.syncSchedules();
      return { created: false, duty: projectDuty(prior.workflow, this.config.allowedTargets), schedule };
    }

    const targetIds = selected.map(target => target.id);
    const write: WorkflowV2Write = {
      id: workflowId,
      version: 2,
      title,
      description: 'Owner-managed proactive GitHub duty.',
      goal,
      instructions: DEFAULT_INSTRUCTIONS,
      targets: selected.map(target => ({
        id: target.id,
        label: target.label,
        kind: 'github_repository',
        bindingId: target.bindingId,
        uri: target.uri,
      })),
      triggers: [
        {
          id: 'github-poll',
          kind: 'github_incremental_poll',
          schedule: { kind: 'cron', expression: '*/5 * * * *', timeZone: 'UTC' },
          targetIds,
          initialBaseline: 'record_without_notification',
          search: { state: 'open', labels: [], limit: 50 },
        },
        {
          id: 'review-morning',
          kind: 'review',
          schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'America/New_York' },
          targetIds,
          initialBaseline: 'record_without_notification',
        },
        {
          id: 'review-evening',
          kind: 'review',
          schedule: { kind: 'cron', expression: '0 17 * * *', timeZone: 'America/New_York' },
          targetIds,
          initialBaseline: 'record_without_notification',
        },
      ],
      actionPolicy: {
        allowedActions: selected.flatMap(target => target.actionGrants.map(grant => ({
          id: `grant-${hash(`${target.id}\0${grant.id}`).slice(0, 40)}`,
          action: grant.action,
          targetIds: [target.id],
          baseBranches: [...grant.baseBranches],
          branchPrefixes: [...grant.branchPrefixes],
          pathPrefixes: [...grant.pathPrefixes],
          issueNumbers: [...grant.issueNumbers],
          sourceWorkflowIds: [...grant.sourceWorkflowIds],
          permittedOperations: [...grant.permittedOperations],
        }))),
        separateChildTask: true,
        productionChanges: 'forbidden',
        requiresUserAuthorization: ['merge', 'release', 'production', 'new_spend'],
      },
      modelPolicy: this.config.modelPolicy,
      authorization: {
        kind: 'teams_thread',
        threadBindingId: owner.thread.threadId,
        ownerTaskId: owner.task.id,
      },
      notifications: {
        onChange: true,
        onFailure: true,
        onRecovery: true,
        quietWhenUnchanged: true,
        quietHours: this.config.quietHours ?? DEFAULT_QUIET_HOURS,
        digest: {
          enabled: true,
          schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'America/New_York' },
          maxPerDay: 1,
        },
        destination: { kind: 'responsibility_thread' },
        immediateOn: ['blocked_goal', 'user_decision', 'service_or_auth_outage'],
      },
      enabled: true,
    };
    validateWorkflowWrite(write);
    const created = await this.config.workflows.putWorkflow(write);
    const schedule = await this.syncSchedules();
    return { created: true, duty: projectDuty(created, this.config.allowedTargets), schedule };
  }

  async setDutyEnabled(args: unknown, exec: ToolRunContext, enabled: boolean): Promise<Record<string, JsonValue>> {
    const owner = await this.activeOwner(exec);
    const { dutyId } = parseDutyId(args);
    const verified = await this.requireOwnedDuty(dutyId, owner, exec.signal);
    const updated = await this.config.workflows.putWorkflow(toWrite(verified.workflow, { enabled }));
    const schedule = await this.syncSchedules();
    return { updated: true, duty: projectDuty(updated, this.config.allowedTargets), schedule };
  }

  async updateGoal(args: unknown, exec: ToolRunContext): Promise<Record<string, JsonValue>> {
    const owner = await this.activeOwner(exec);
    const input = object(args, 'duty goal request');
    const dutyId = safeText(input.dutyId, 'dutyId', 128, false);
    const goal = safeText(input.goal, 'goal', 4_000, true);
    const verified = await this.requireOwnedDuty(dutyId, owner, exec.signal);
    const updated = await this.config.workflows.putWorkflow(toWrite(verified.workflow, { goal }));
    const schedule = await this.syncSchedules();
    return { updated: true, duty: projectDuty(updated, this.config.allowedTargets), schedule };
  }

  async readStatus(args: unknown, exec: ToolRunContext): Promise<Record<string, JsonValue>> {
    const owner = await this.activeOwner(exec);
    const input = object(args, 'duty status request');
    const dutyId = safeText(input.dutyId, 'dutyId', 128, false);
    const cursor = input.cursor === undefined ? undefined : safeCursor(input.cursor);
    const verified = await this.requireOwnedDuty(dutyId, owner, exec.signal);
    const page = await this.config.workflows.listScheduleEvents({
      workflowId: verified.workflow.id,
      limit: EVENT_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    return {
      duty: projectDuty(verified.workflow, this.config.allowedTargets),
      events: page.items.map(event => projectEvent(event, verified.workflow, this.config.allowedTargets)),
      nextCursor: page.nextCursor,
    };
  }

  async readUsage(args: unknown, exec: ToolRunContext): Promise<Record<string, JsonValue>> {
    const owner = await this.activeOwner(exec);
    const input = object(args, 'duty usage request');
    const requestedDutyId = input.dutyId === undefined ? undefined : safeText(input.dutyId, 'dutyId', 128, false);
    const taskIds = new Set<string>(requestedDutyId === undefined ? [owner.task.id] : []);
    let sampledEvents = 0;
    let truncatedDuties = 0;
    if (requestedDutyId !== undefined) {
      const workflow = await this.requireOwnedDuty(requestedDutyId, owner, exec.signal);
      const page = await this.config.workflows.listScheduleEvents({ workflowId: workflow.workflow.id, limit: USAGE_EVENT_PAGE_SIZE });
      sampledEvents = page.items.length;
      if (page.nextCursor !== null) truncatedDuties = 1;
      addAuthorizedOccurrenceTaskIds(taskIds, page.items);
    } else {
      const rows = await this.config.workflows.listWorkflows(2);
      for (const row of rows) {
        const verified = await this.authorizedWorkflow(row.id, owner, exec.signal);
        if (verified === undefined) continue;
        const page = await this.config.workflows.listScheduleEvents({ workflowId: verified.workflow.id, limit: USAGE_EVENT_PAGE_SIZE });
        sampledEvents += page.items.length;
        if (page.nextCursor !== null) truncatedDuties += 1;
        addAuthorizedOccurrenceTaskIds(taskIds, page.items);
      }
    }
    const aggregate = new Map<string, UsageAggregate>();
    let unavailableTasks = 0;
    for (const taskId of taskIds) {
      exec.signal.throwIfAborted();
      try {
        const snapshot = await this.config.readModelUsage(taskId);
        if (snapshot.taskId !== taskId) throw new Error('Usage snapshot task identity mismatch');
        for (const route of snapshot.routes) addUsage(aggregate, route);
      } catch (error: unknown) {
        if (exec.signal.aborted) throw error;
        unavailableTasks += 1;
      }
    }
    return {
      scope: requestedDutyId === undefined ? 'active_conversation_and_owned_duties' : 'owned_duty',
      ...(requestedDutyId === undefined ? {} : { dutyId: requestedDutyId }),
      sampledEvents,
      truncatedDuties,
      unavailableTasks,
      routes: [...aggregate.values()].map(route => ({ ...route })),
      source: 'durable_provider_reported_usage',
    };
  }

  private async activeOwner(exec: ToolRunContext): Promise<ActiveTeamsOwnerContext> {
    if (!exec.agent) throw new Error('Responsibility tools require an active DSH conversation');
    const sessionId = String(exec.agent.session.id);
    const owner = await this.config.resolveActiveOwner(sessionId, exec.signal);
    if (owner === undefined || owner.task.sessionId !== sessionId
      || owner.task.executionClass !== 'foreground' || owner.task.status !== 'running'
      || !owner.task.id.startsWith('teams-') || !owner.principal.issuer.trim()
      || !owner.principal.subject.trim() || !owner.principal.tenantId.trim()
      || !activeTaskMatchesOwnerContext(owner)) {
      throw new Error('This command requires a currently authorized owner Teams conversation');
    }
    return owner;
  }

  private async authorizedWorkflow(
    workflowId: string,
    owner: ActiveTeamsOwnerContext,
    signal: AbortSignal,
  ): Promise<WorkflowOwnerContext | undefined> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(workflowId)) return undefined;
    const verified = await this.config.authorizeWorkflowOwner(workflowId, owner.principal, signal);
    const workflow = verified?.workflow;
    if (verified === undefined || workflow === undefined || workflow.id !== workflowId
      || workflow.version !== 2 || !samePrincipal(verified.principal, owner.principal)
      || workflow.authorization.ownerTaskId === ''
      || workflow.authorization.threadBindingId !== verified.thread.threadId) return undefined;
    return { ...verified, workflow };
  }

  private async requireOwnedDuty(
    dutyId: string,
    owner: ActiveTeamsOwnerContext,
    signal: AbortSignal,
  ): Promise<WorkflowOwnerContext> {
    const verified = await this.authorizedWorkflow(dutyId, owner, signal);
    if (verified === undefined) throw new Error('Duty not found or the current owner is not authorized to manage it');
    return verified;
  }

  private async syncSchedules(): Promise<'synchronized' | 'pending_retry'> {
    try {
      await this.config.syncWorkflows();
      return 'synchronized';
    } catch {
      // The Work API write has completed; periodic reconciliation can recover without replaying the write.
      return 'pending_retry';
    }
  }
}

interface UsageAggregate {
  readonly provider: string;
  readonly model: string;
  reportedCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

function projectDuty(workflow: WorkflowV2Record, allowedTargets: readonly ResponsibilityTargetConfig[]): Record<string, JsonValue> {
  const targetLabels = new Map(allowedTargets.map(target => [target.id, target.label]));
  return {
    id: workflow.id,
    title: workflow.title,
    goal: workflow.goal,
    enabled: workflow.enabled,
    repositories: workflow.targets.map(target => targetLabels.get(target.id) ?? target.label),
    allowedActions: [...new Set(workflow.actionPolicy.allowedActions.map(grant => grant.action))],
    updatedAt: workflow.updatedAt ?? null,
  };
}

function projectEvent(
  event: WorkflowScheduleEvent,
  workflow: WorkflowV2Record,
  allowedTargets: readonly ResponsibilityTargetConfig[],
): Record<string, JsonValue> {
  const targetLabels = new Map(allowedTargets.map(target => [target.id, target.label]));
  return {
    scheduledAt: event.scheduledAt,
    status: event.status,
    ...(event.changed === undefined ? {} : { changed: event.changed }),
    ...(event.summary === undefined ? {} : { summary: event.summary.slice(0, 2_000) }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    ...(event.attentionKind === undefined ? {} : { attention: event.attentionKind }),
    evidence: (event.evidence ?? []).map(item => ({
      repository: targetLabels.get(item.targetId) ?? (workflow.targets.find(target => target.id === item.targetId)?.label ?? 'configured repository'),
      source: item.tool,
      observedAt: item.observedAt,
      resultDigest: item.resultDigest,
    })),
    actions: (event.actionResults ?? []).map(action => ({
      action: action.actionType,
      repository: targetLabels.get(action.targetId) ?? (workflow.targets.find(target => target.id === action.targetId)?.label ?? 'configured repository'),
      status: action.status,
      operationIds: [...action.operationIds],
    })),
  };
}

function toWrite(workflow: WorkflowV2Record, changes: Partial<Pick<WorkflowV2Write, 'enabled' | 'goal'>> = {}): WorkflowV2Write {
  return {
    id: workflow.id,
    version: 2,
    title: workflow.title,
    description: workflow.description,
    goal: changes.goal ?? workflow.goal,
    instructions: workflow.instructions,
    targets: workflow.targets,
    triggers: workflow.triggers,
    actionPolicy: workflow.actionPolicy,
    modelPolicy: workflow.modelPolicy,
    authorization: workflow.authorization,
    notifications: workflow.notifications,
    enabled: changes.enabled ?? workflow.enabled,
  };
}

function addAuthorizedOccurrenceTaskIds(taskIds: Set<string>, events: readonly WorkflowScheduleEvent[]): void {
  for (const event of events) {
    for (const taskId of [event.taskId, ...(event.actionTaskIds ?? []), ...(event.actionResults ?? []).map(item => item.taskId)]) {
      if (taskId !== undefined && /^workflow-(?:action-)?[a-f0-9]{40}$/u.test(taskId)) taskIds.add(taskId);
    }
  }
}

function addUsage(target: Map<string, UsageAggregate>, route: ResponsibilityModelUsageSnapshot['routes'][number]): void {
  if (!route.provider || !route.model || !count(route.reportedCalls)
    || !count(route.inputTokens) || !count(route.outputTokens)
    || route.totalTokens !== undefined && !count(route.totalTokens)) return;
  const key = `${route.provider}\0${route.model}`;
  const existing = target.get(key) ?? {
    provider: route.provider,
    model: route.model,
    reportedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...(route.totalTokens === undefined ? {} : { totalTokens: 0 }),
  };
  existing.reportedCalls += route.reportedCalls;
  existing.inputTokens += route.inputTokens;
  existing.outputTokens += route.outputTokens;
  if (route.totalTokens !== undefined) existing.totalTokens = (existing.totalTokens ?? 0) + route.totalTokens;
  target.set(key, existing);
}

function validateResponsibilityToolsConfig(config: ResponsibilityToolsConfig): void {
  if (config.allowedTargets.length < 1 || config.allowedTargets.length > 100) {
    throw new TypeError('Responsibility tools require a bounded host repository allowlist');
  }
  const targetIds = new Set<string>();
  for (const target of config.allowedTargets) {
    if (!/^\d+$/u.test(target.id) || !/^[^/\s]+\/[^/\s]+$/u.test(target.label)
      || target.uri !== `https://github.com/${target.label}`
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(target.bindingId)
      || targetIds.has(target.id)) throw new TypeError('Invalid or duplicate host responsibility repository target');
    targetIds.add(target.id);
    const grantIds = new Set<string>();
    for (const grant of target.actionGrants) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(grant.id) || grantIds.has(grant.id)
        || !WRITE_OPERATIONS[grant.action]
        || grant.permittedOperations.length === 0
        || !Array.isArray(grant.sourceWorkflowIds)
        || grant.permittedOperations.some(operation => !WRITE_OPERATIONS[grant.action].has(operation))) {
        throw new TypeError('Invalid host responsibility action grant');
      }
      if (grant.action === 'rerun_source_ci') {
        if (grant.sourceWorkflowIds.length === 0
          || new Set(grant.sourceWorkflowIds).size !== grant.sourceWorkflowIds.length
          || grant.sourceWorkflowIds.some(id => !/^[1-9][0-9]{0,19}$/u.test(id))
          || grant.baseBranches.length > 0 || grant.pathPrefixes.length > 0 || grant.issueNumbers.length > 0
          || grant.branchPrefixes.length === 0
          || grant.branchPrefixes.some(prefix => !prefix.startsWith('cyrene/assistant/'))
          || grant.permittedOperations.length !== 1
          || grant.permittedOperations[0] !== 'github.actions.rerun_failed') {
          throw new TypeError('CI rerun grants require exact workflow ids and assistant branch scope');
        }
      } else if (grant.sourceWorkflowIds.length !== 0) {
        throw new TypeError('Source workflow ids are only valid for typed CI rerun grants');
      } else if (grant.action === 'draft_pull_request') {
        if (!grant.permittedOperations.includes('github.branch.create')
          || !grant.permittedOperations.includes('github.file.commit')
          || !grant.permittedOperations.includes('github.pull_request.draft.create')
          || grant.baseBranches.length === 0 || grant.branchPrefixes.length === 0 || grant.pathPrefixes.length === 0
          || grant.issueNumbers.length > 0
          || grant.branchPrefixes.some(prefix => !prefix.startsWith('cyrene/assistant/'))) {
          throw new TypeError('Draft PR grants must stay within configured assistant branch and path scopes');
        }
      } else if (grant.issueNumbers.length === 0 || grant.baseBranches.length > 0
        || grant.branchPrefixes.length > 0 || grant.pathPrefixes.length > 0) {
        throw new TypeError('Issue progress grants require explicit issue-number scopes');
      }
      for (const values of [grant.baseBranches, grant.branchPrefixes, grant.pathPrefixes, grant.sourceWorkflowIds]) {
        if (new Set(values).size !== values.length || values.some(value => !value.trim())) {
          throw new TypeError('Responsibility grant scopes must contain unique non-empty values');
        }
      }
      if (grant.pathPrefixes.some(path => path.startsWith('/') || path.includes('\\')
        || path.includes('*') || path.split('/').includes('..'))) {
        throw new TypeError('Responsibility path scopes must be repository-relative literal prefixes');
      }
      grantIds.add(grant.id);
    }
  }
  if (config.modelPolicy.fallback !== 'configured_no_additional_spend'
    || !['antigravity', 'codebuddy', 'exchange'].includes(config.modelPolicy.preferredProvider)
    || !config.modelPolicy.preferredModel.trim()) throw new TypeError('Invalid host responsibility model policy');
  const quiet = config.quietHours ?? DEFAULT_QUIET_HOURS;
  if (!/^\d{2}:\d{2}$/u.test(quiet.start) || !/^\d{2}:\d{2}$/u.test(quiet.end) || !quiet.timeZone.trim()) {
    throw new TypeError('Invalid host responsibility quiet hours');
  }
}

function parseDutyId(args: unknown): { readonly dutyId: string } {
  const input = object(args, 'duty request');
  return { dutyId: safeText(input.dutyId, 'dutyId', 128, false) };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function stringList(value: unknown, name: string, min: number, max: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new TypeError(`${name} has an invalid number of items`);
  return value.map(item => safeText(item, name, 128, false));
}

function safeText(value: unknown, name: string, maximum: number, multiline: boolean): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be text`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
    || !multiline && /[\r\n\t]/u.test(normalized)) throw new TypeError(`${name} is empty or outside the allowed text format`);
  return normalized;
}

function safeCursor(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,10}$/u.test(value)) throw new TypeError('cursor must be a numeric Work API cursor');
  return value;
}

function samePrincipal(left: ResponsibilityPrincipal, right: ResponsibilityPrincipal): boolean {
  return left.issuer === right.issuer && left.subject === right.subject && left.tenantId === right.tenantId;
}

function activeTaskMatchesOwnerContext(owner: ActiveTeamsOwnerContext): boolean {
  const metadata = owner.task.metadata;
  if (metadata === undefined) return false;
  const caller = objectValue(metadata.teamsCaller);
  const route = objectValue(metadata.teamsThread);
  return caller?.issuer === owner.principal.issuer
    && caller.subject === owner.principal.subject
    && caller.tenantId === owner.principal.tenantId
    && route?.threadId === owner.thread.threadId
    && route.tenantId === owner.thread.tenantId
    && route.teamId === owner.thread.teamId
    && route.channelId === owner.thread.channelId
    && route.conversationId === owner.thread.conversationId
    && route.rootThreadId === owner.thread.rootThreadId
    && owner.thread.tenantId === owner.principal.tenantId;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function count(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
