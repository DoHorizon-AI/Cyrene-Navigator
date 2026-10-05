// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Workflow Readonly Tool Policy                     │
// │ Role: Limit each scheduled occurrence to bound observation tools.    │
// │ 模块职责：将每次定时工作流限制为目标绑定的只读观察工具。                  │
// └─────────────────────────────────────────────────────────────────────┘

import type { Context } from '@deepseek-ai/cordis';
import type { WorkflowRecord } from './store.js';

const WORKFLOW_MEMORY_TOOLS = new Set(['work_memory_search', 'work_sources']);

/**
 * Install a temporary global guard that denies non-readonly calls only for one executor Session.
 * A workflow may use cloud tools only when its versioned targets bind the corresponding official profile.
 * @param ctx - Host Context with ToolRuntime and optional official cloud registry.
 * @param workflow - Persisted workflow definition whose target references grant bounded read access.
 * @param occurrenceSessionId - Deterministic executor Session id for this single timer occurrence.
 * @returns Disposer that removes the occurrence policy after the executor settles.
 */
export function installWorkflowReadonlyGuard(
  ctx: Context,
  workflow: WorkflowRecord,
  occurrenceSessionId: string,
): () => void {
  const registry = ctx.get('cloudConnections');
  const allowedTools = new Set(WORKFLOW_MEMORY_TOOLS);
  for (const target of workflow.targets) {
    if (target.kind !== 'cloud-connection' || !isSupportedProfileId(target.id)) continue;
    for (const name of registry?.workflowReadonlyTools(target.id) ?? []) allowedTools.add(name);
  }

  const configuredProjects = new Set(registry?.workflowReadonlyProjectIds('google-cloud-readonly') ?? []);
  const targetProjects = new Set(workflow.targets
    .filter(target => target.kind === 'google-cloud-project' && configuredProjects.has(target.id))
    .map(target => target.id));
  if (targetProjects.size > 0) {
    for (const name of registry?.workflowReadonlyTools('google-cloud-readonly') ?? []) allowedTools.add(name);
  }

  return ctx.tools.guard(execution => {
    if (execution.agent === undefined || String(execution.agent.session.id) !== occurrenceSessionId) return undefined;
    if (!allowedTools.has(execution.name)) return 'Scheduled workflows may only call read-only tools for configured targets.';
    if (execution.name === 'gcloud_readonly') {
      const args = asRecord(execution.arguments);
      if (args === undefined || typeof args.projectId !== 'string' || !targetProjects.has(args.projectId)) {
        return 'Scheduled workflows may only inspect a Google Cloud project named in their configured targets.';
      }
    }
    return undefined;
  });
}

function isSupportedProfileId(id: string): boolean {
  return id === 'microsoft-learn' || id === 'google-developer-knowledge' || id === 'azure' || id === 'huggingface';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
