// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Workflow Readonly Tool Policy                     │
// │ Role: Fail closed on unbound targets and prove scoped observations.  │
// │ 模块职责：拒绝未绑定目标，并验证当前工作流 Session 的观察回执。           │
// └─────────────────────────────────────────────────────────────────────┘

import type { Context } from '@deepseek-ai/cordis';
import type { CloudConnectionRegistry } from '../integrations/cloud-connections.js';
import type { WorkflowRecord } from './store.js';

const WORKFLOW_MEMORY_TOOLS = new Set(['work_memory_search', 'work_sources']);
const READONLY_CONNECTIONS: Readonly<Record<string, { readonly publisher: string; readonly endpoint: string }>> = Object.freeze({
  'microsoft-learn': { publisher: 'Microsoft', endpoint: 'https://learn.microsoft.com/api/mcp' },
  'google-developer-knowledge': {
    publisher: 'Google', endpoint: 'https://developerknowledge.googleapis.com/mcp',
  },
  azure: { publisher: 'Microsoft', endpoint: 'https://www.npmjs.com/package/@azure/mcp' },
});

/** Runtime permissions derived from every configured, currently available observation target. */
export interface WorkflowReadonlyPolicy {
  readonly supported: boolean;
  readonly allowedTools: ReadonlySet<string>;
  readonly observationTargets: readonly WorkflowObservationTarget[];
  readonly targetProjects: ReadonlySet<string>;
}

/** Tool names and optional project discriminator required to prove one target observation. */
export interface WorkflowObservationTarget {
  readonly index: number;
  readonly id: string;
  readonly tools: ReadonlySet<string>;
  readonly projectId?: string;
}

/**
 * Resolve the complete tool surface before starting an executor task.
 * Every configured target must map to at least one currently registered, source-classified readonly tool.
 * @param ctx - Host Context with ToolRuntime and optional official cloud registry.
 * @param workflow - Persisted workflow definition whose target references grant bounded read access.
 * @returns Memory tools plus approved target tools, or `supported:false` for any unsupported target.
 */
export function resolveWorkflowReadonlyPolicy(ctx: Context, workflow: WorkflowRecord): WorkflowReadonlyPolicy {
  const registry = ctx.get('cloudConnections');
  const allowedTools = new Set(WORKFLOW_MEMORY_TOOLS);
  const observationTargets: WorkflowObservationTarget[] = [];
  const targetProjects = new Set<string>();
  let supported = workflow.targets.length > 0;

  for (const [index, target] of workflow.targets.entries()) {
    let names: readonly string[] = [];
    let projectId: string | undefined;
    if (target.kind === 'cloud-connection' && target.id in READONLY_CONNECTIONS) {
      names = readonlyConnectionTools(registry, target.id);
    } else if (target.kind === 'google-cloud-project') {
      const projects = registry?.workflowReadonlyProjectIds('google-cloud-readonly') ?? [];
      const tools = registry?.workflowReadonlyTools('google-cloud-readonly') ?? [];
      if (projects.includes(target.id) && tools.includes('gcloud_readonly')) {
        names = ['gcloud_readonly'];
        targetProjects.add(target.id);
        projectId = target.id;
      }
    }
    if (names.length === 0) {
      supported = false;
      continue;
    }
    observationTargets.push({ index, id: target.id, tools: new Set(names), ...(projectId === undefined ? {} : { projectId }) });
    for (const name of names) {
      allowedTools.add(name);
    }
  }

  return { supported, allowedTools, observationTargets, targetProjects };
}

/**
 * Install a temporary monotonic guard for one executor Session.
 * The same observation-tool set is used by the runtime to validate actual `tools/result` receipts.
 * @param ctx - Host Context with ToolRuntime.
 * @param policy - Preflighted policy for the workflow's configured targets.
 * @param occurrenceSessionId - Deterministic executor Session id for one timer occurrence.
 * @returns Disposer that removes the occurrence policy after the executor settles.
 */
export function installWorkflowReadonlyGuard(
  ctx: Context,
  policy: WorkflowReadonlyPolicy,
  occurrenceSessionId: string,
): () => void {
  return ctx.tools.guard(execution => {
    if (execution.agent === undefined || String(execution.agent.session.id) !== occurrenceSessionId) return undefined;
    if (!policy.allowedTools.has(execution.name)) return 'Scheduled workflows may only call read-only tools for configured targets.';
    if (execution.name === 'gcloud_readonly') {
      const args = asRecord(execution.arguments);
      if (args === undefined || typeof args.projectId !== 'string' || !policy.targetProjects.has(args.projectId)) {
        return 'Scheduled workflows may only inspect a Google Cloud project named in their configured targets.';
      }
    }
    return undefined;
  });
}

/** Return tools classified for a validated official profile, including a bounded probe after transient failure. */
function readonlyConnectionTools(
  registry: CloudConnectionRegistry | undefined,
  id: string,
): readonly string[] {
  if (id === 'huggingface') return [];
  if (registry === undefined) return [];
  const registered = registry.workflowReadonlyTools(id);
  if (registered.length > 0) return registered;

  const health = registry.get(id);
  const source = READONLY_CONNECTIONS[id];
  if (health === undefined || source === undefined || health.status !== 'degraded' || health.kind !== 'mcp'
    || health.source.publisher !== source.publisher || health.source.endpoint !== source.endpoint) return [];
  // A degraded profile still has its DSH-discovered schemas registered. Let the next bounded
  // scheduled observation probe them so a successful tool result can restore available health.
  return health.tools.map(tool => tool.name);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
