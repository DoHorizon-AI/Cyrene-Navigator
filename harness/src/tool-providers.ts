// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator canonical tool providers                          │
// │ Role: Register configured tool.provider.v1 tools through Work API.  │
// │ 模块职责：通过 Work API 注册已配置的 tool.provider.v1 工具。          │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools';
import type {
  JsonSchemaNode,
  ToolDefinition,
  ToolRunContext,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools';
import { isJsonValue, snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { WorkAssistantBridge } from './work-tools.js';
import {
  ExchangeConnectorAuthorizationClient,
  ExchangeConnectorRequestError,
  canonicalJson,
  sha256,
} from './connector-authorization.ts';
import type { ConnectorGrantRequest } from './connector-authorization.ts';
import type {
  BackgroundTaskAuthorizationResolver,
  ConnectorResourceProjection,
  ResponsibilityPrincipal,
  ResponsibilityTaskRecord,
} from './responsibility-authority.ts';

export type { ConnectorResourceProjection } from './responsibility-authority.ts';

const MAX_PROVIDER_COUNT = 128;
const MAX_TOOL_COUNT = 512;
const MAX_SCHEMA_BYTES = 64_000;
const MAX_ARGUMENT_BYTES = 1_500_000;
const MAX_RESULT_BYTES = 2_000_000;
const MAX_CONTENT_BLOCKS = 512;
const CODEBUDDY_ACP_EXCHANGE_TOOLS = [
  'exchange_connections_list',
  'exchange_authorization_health',
  'exchange_reauthorization_start',
  'exchange_reauthorization_status',
  'exchange_cloud_resources_query',
  'exchange_issue_query',
  'exchange_issue_comment',
  'exchange_issue_state_update',
  'exchange_operation_read',
] as const;
const CODEBUDDY_ACP_READ_ONLY_CONTINUATION_TOOLS = new Set([
  'exchange_connections_list',
  'exchange_authorization_health',
  'exchange_reauthorization_status',
  'exchange_cloud_resources_query',
  'exchange_issue_query',
  'exchange_operation_read',
]);

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'array', items: { type: 'object', additionalProperties: true } },
    structuredContent: {},
  },
  required: ['content'],
  additionalProperties: false,
} as const satisfies JsonSchemaNode;

/** Bridge and active-session mapping already owned by Navigator's task composition. | 使用 Navigator 现有桥接与会话映射。 */
export interface ToolProviderRegistrationOptions {
  readonly bridge: Pick<WorkAssistantBridge, 'request' | 'requestApproval' | 'mutate'>;
  readonly taskIdForSession: (sessionId: string) => string | undefined;
  readonly connectorAuthorization?: {
    readonly client: ExchangeConnectorAuthorizationClient;
    readonly workspaceId: string;
    readonly bindings: ReadonlyMap<string, ConnectorBindingAuthorization>;
  };
  /** Host-only verifier for persisted background responsibility tasks. */
  readonly backgroundTaskAuthority?: BackgroundTaskAuthorizationResolver;
  /** Private Exchange-exported ListTools snapshot; still intersected with host authorization. */
  readonly connectorToolCatalogSnapshot?: unknown;
}

export interface ConnectorToolAuthorization {
  readonly toolId: string;
  readonly operationId: string;
  readonly resourceProjection: ConnectorResourceProjection;
  readonly mutating: boolean;
}

export interface ConnectorBindingAuthorization {
  readonly bindingId: string;
  readonly connectionRef: string;
  readonly providerId: string;
  readonly profileRef: string;
  readonly tools: readonly ConnectorToolAuthorization[];
}

/** Host-verified mapping from one opaque DSH schema name to its canonical connector operation. */
export interface ConnectorToolCatalogEntry {
  readonly name: string;
  readonly bindingId: string;
  readonly providerId: string;
  readonly toolId: string;
  readonly operationId: string;
  readonly resourceProjection: ConnectorResourceProjection;
  readonly mutating: boolean;
}

const connectorToolCatalogs = new WeakMap<Context, readonly ConnectorToolCatalogEntry[]>();

/** Read the canonical provider/tool map installed for this Context, without parsing opaque tool names. */
export function getConnectorToolCatalog(ctx: Context): readonly ConnectorToolCatalogEntry[] {
  return connectorToolCatalogs.get(ctx) ?? [];
}

/** MCP projection of the fixed Exchange tools and bindings authorized by Navigator. */
export interface CodeBuddyAcpToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaNode;
}

/** Return detached schemas for only registered Exchange and authorized connector tools. */
export function getCodeBuddyAcpToolCatalog(ctx: Context): readonly CodeBuddyAcpToolSchema[] {
  const authorizedConnectorTools = getConnectorToolCatalog(ctx).map(entry => {
    const definition = ctx.tools.get(entry.name);
    if (definition === undefined) throw new Error('Authorized connector tool registration is unavailable');
    return {
      name: entry.name,
      description: definition.description,
      inputSchema: structuredClone(definition.parameters),
    };
  });
  const registeredExchangeTools = CODEBUDDY_ACP_EXCHANGE_TOOLS.flatMap(name => {
    const definition = ctx.tools.get(name);
    return definition === undefined ? [] : [{
      name,
      description: definition.description,
      inputSchema: structuredClone(definition.parameters),
    }];
  });
  return [...registeredExchangeTools, ...authorizedConnectorTools];
}

/** Run one existing Exchange tool definition with host validation and its existing authorization/receipt body. */
export async function executeCodeBuddyAcpTool(
  ctx: Context,
  input: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
    readonly callId: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly readOnly: boolean;
  },
): Promise<ToolExecutionResult | undefined> {
  const declared = getCodeBuddyAcpToolCatalog(ctx).find(item => item.name === input.name);
  if (declared === undefined) return undefined;
  if (input.readOnly && !CODEBUDDY_ACP_READ_ONLY_CONTINUATION_TOOLS.has(declared.name)) {
    throw new Error('This authorization continuation is read-only; this tool is outside the approved read-only set.');
  }
  const definition = ctx.tools.get(declared.name);
  if (definition === undefined || typeof definition.execute !== 'function') {
    throw new Error('Authorized connector tool implementation is unavailable.');
  }
  const agent = {
    id: input.sessionId,
    session: { id: input.sessionId },
    navigatorExecutionBackend: 'codebuddy-acp',
  } as unknown as Agent;
  const callId = input.callId as Parameters<typeof ctx.tools.execute>[0]['callId'];
  try {
    return await ctx.tools.execute({
      name: declared.name,
      callId,
      rootCallId: callId,
      arguments: input.arguments,
      signal: input.signal,
      agent,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Connector tool execution failed.';
    return toolExecutionFailure(declared.name, 'TOOL_EXECUTION_FAILED', message);
  }
}

function toolExecutionFailure(name: string, code: string, message: string): ToolExecutionResult {
  return {
    isError: true,
    error: { message, info: { name, code } },
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

interface ProviderBinding {
  readonly bindingId: string;
  readonly capabilityId: 'tool.provider.v1';
  readonly providerId?: string;
  readonly connectionRef?: string;
  readonly profileRef?: string;
}

interface ProviderTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly constraints: readonly ProviderInputConstraint[];
  readonly readOnly: boolean;
  readonly providerId?: string;
  readonly operationId?: string;
  readonly connectionRef?: string;
  readonly profileRef?: string;
}

interface ProviderInputConstraint {
  readonly path: readonly (string | '*')[];
  readonly pattern?: string;
  readonly regex?: RegExp;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minProperties?: number;
  readonly maxProperties?: number;
}

interface ProviderTextBlock {
  readonly type: 'text';
  readonly text: string;
}

interface ProviderToolResult {
  readonly content: readonly ProviderTextBlock[];
  readonly isError?: boolean;
  readonly structuredContent?: JsonValue;
}

interface OperationReceipt {
  readonly id: string;
  readonly status: 'started' | 'uncertain' | 'verified';
  readonly duplicate: boolean;
}

/**
 * Discover configured provider bindings and register their JSON Schema tools
 * on DSH's existing ToolRuntime. Non-Teams writes require Navigator approval;
 * trusted Teams calls use fresh grants and durable operation receipts.
 *
 * @param ctx - DSH context whose tool registrations share the active runtime.
 * @param options - authenticated Work bridge and host-owned session/task map.
 * @returns An idempotent disposer for every registered provider tool.
 * @throws TypeError when the authenticated provider catalog is malformed or unsafe.
 */
export async function registerToolProviders(
  ctx: Context,
  options: ToolProviderRegistrationOptions,
): Promise<() => void> {
  const signal = AbortSignal.timeout(15_000);
  const snapshot = options.connectorToolCatalogSnapshot === undefined
    ? undefined
    : parseConnectorToolCatalogSnapshot(options.connectorToolCatalogSnapshot);
  if (snapshot !== undefined && options.connectorAuthorization === undefined) {
    throw new TypeError('A private connector tool catalog requires launcher-owned connector authorization');
  }
  const snapshotByBinding = snapshot === undefined
    ? undefined
    : new Map(snapshot.map(item => [item.binding.bindingId, item]));
  let bindings: ProviderBinding[];
  if (snapshotByBinding !== undefined) {
    const authorizedBindings = options.connectorAuthorization!.bindings;
    const absent = [...authorizedBindings.keys()].find(bindingId => !snapshotByBinding.has(bindingId));
    if (absent !== undefined) throw new TypeError(`Private connector tool catalog omitted launcher binding ${absent}`);
    const untrusted = [...snapshotByBinding.keys()].find(bindingId => !authorizedBindings.has(bindingId));
    if (untrusted !== undefined) throw new TypeError(`Private connector tool catalog contains unbound binding ${untrusted}`);
    bindings = snapshot!.map(item => item.binding);
  } else {
    const rawBindings = await options.bridge.request('/tool-providers', 'GET', undefined, signal);
    bindings = parseBindings(rawBindings);
  }
  if (bindings.length > MAX_PROVIDER_COUNT) throw new TypeError('Tool provider catalog exceeds its configured limit');

  const registrations: Array<() => void> = [];
  const names = new Set<string>();
  const catalogEntries: ConnectorToolCatalogEntry[] = [];
  let registeredCount = 0;
  try {
    for (const binding of bindings) {
      const trustedBinding = options.connectorAuthorization?.bindings.get(binding.bindingId);
      if (options.connectorAuthorization !== undefined && trustedBinding === undefined) continue;
      if (trustedBinding !== undefined) assertCatalogBinding(binding, trustedBinding);
      const rawCatalog = snapshotByBinding?.get(binding.bindingId)?.toolCatalog
        ?? await options.bridge.request(
          `/tool-providers/${encodeURIComponent(binding.bindingId)}/tools`, 'GET', undefined, signal,
        );
      const tools = parseTools(rawCatalog, binding.bindingId);
      if (snapshotByBinding !== undefined && trustedBinding !== undefined) {
        const absentTool = trustedBinding.tools.find(item => !tools.some(tool => tool.id === item.toolId));
        if (absentTool !== undefined) {
          throw new TypeError(`Private connector tool catalog omitted authorized tool ${absentTool.toolId}`);
        }
      }
      for (const tool of tools) {
        const trustedTool = trustedBinding?.tools.find(item => item.toolId === tool.id);
        if (trustedBinding !== undefined && trustedTool === undefined) continue;
        if (trustedBinding !== undefined && trustedTool !== undefined) {
          assertCatalogTool(binding, tool, trustedBinding, trustedTool);
        }
        registeredCount += 1;
        if (registeredCount > MAX_TOOL_COUNT) throw new TypeError('Tool provider catalog exceeds its configured tool limit');
        const name = publicToolName(binding.bindingId, tool.id);
        if (names.has(name)) throw new TypeError('Tool provider names collide after normalization');
        names.add(name);
        registrations.push(ctx.tools.register(createDefinition(options, binding, tool, name)));
        if (trustedBinding !== undefined && trustedTool !== undefined) {
          catalogEntries.push(Object.freeze({
            name,
            bindingId: trustedBinding.bindingId,
            providerId: trustedBinding.providerId,
            toolId: trustedTool.toolId,
            operationId: trustedTool.operationId,
            resourceProjection: trustedTool.resourceProjection,
            mutating: trustedTool.mutating,
          }));
        }
      }
    }
  } catch (error: unknown) {
    for (const unregister of registrations.reverse()) unregister();
    throw error;
  }

  const catalogSnapshot = Object.freeze([...catalogEntries]);
  connectorToolCatalogs.set(ctx, catalogSnapshot);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const unregister of registrations.reverse()) unregister();
    if (connectorToolCatalogs.get(ctx) === catalogSnapshot) connectorToolCatalogs.delete(ctx);
  };
  ctx.effect(() => dispose, 'navigator.toolProviders');
  return dispose;
}

function assertCatalogBinding(binding: ProviderBinding, trusted: ConnectorBindingAuthorization): void {
  if (binding.bindingId !== trusted.bindingId
    || (binding.providerId !== undefined && binding.providerId !== trusted.providerId)
    || (binding.connectionRef !== undefined && binding.connectionRef !== trusted.connectionRef)
    || (binding.profileRef !== undefined && binding.profileRef !== trusted.profileRef)) {
    throw new TypeError('Tool provider binding does not match its launcher-owned connector binding');
  }
}

function assertCatalogTool(
  binding: ProviderBinding,
  tool: ProviderTool,
  trustedBinding: ConnectorBindingAuthorization,
  trustedTool: ConnectorToolAuthorization,
): void {
  if ((binding.providerId !== undefined && binding.providerId !== trustedBinding.providerId)
    || (binding.connectionRef !== undefined && binding.connectionRef !== trustedBinding.connectionRef)
    || (binding.profileRef !== undefined && binding.profileRef !== trustedBinding.profileRef)
    || (tool.providerId !== undefined && tool.providerId !== trustedBinding.providerId)
    || (tool.connectionRef !== undefined && tool.connectionRef !== trustedBinding.connectionRef)
    || (tool.profileRef !== undefined && tool.profileRef !== trustedBinding.profileRef)
    || (tool.operationId !== undefined && tool.operationId !== trustedTool.operationId)
    || tool.readOnly === trustedTool.mutating) {
    throw new TypeError('Provider catalog operation does not match its launcher-owned connector grant');
  }
}

/** Build one DSH-native tool from an authenticated canonical provider entry. */
function createDefinition(
  options: ToolProviderRegistrationOptions,
  binding: ProviderBinding,
  tool: ProviderTool,
  name: string,
): ToolDefinition {
  return {
    name,
    description: `${tool.name} (configured provider ${binding.bindingId}): ${tool.description}`,
    parameters: structuredClone(tool.inputSchema),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args: unknown, execution: ToolRunContext): Promise<unknown> {
      const argumentsValue = parseArguments(args);
      validateProviderConstraints(argumentsValue, tool.constraints);
      const sessionId = execution.agent?.session.id === undefined ? undefined : String(execution.agent.session.id);
      const taskId = sessionId === undefined ? undefined : options.taskIdForSession(sessionId);
      if (options.connectorAuthorization !== undefined) {
        if (!taskId) throw new Error('Connector tools require a durable Navigator task');
        const trustedBinding = options.connectorAuthorization.bindings.get(binding.bindingId);
        const trustedTool = trustedBinding?.tools.find(item => item.toolId === tool.id);
        if (!trustedBinding || !trustedTool) throw new Error('Connector tool is outside the launcher-owned binding');
        if (taskId.startsWith('teams-')) {
          const teamsCaller = await readTeamsCallerForTask(options.bridge, taskId, execution.signal);
          if (teamsCaller === undefined) throw new Error('Trusted Teams task caller identity is missing');
          return executeTeamsProviderCall(options, binding, tool, argumentsValue, execution, taskId, teamsCaller);
        }
        if (!options.backgroundTaskAuthority) {
          throw new Error('Background connector authorization is unavailable');
        }
        const task = readBackgroundTaskRecord(
          await options.bridge.request(`/tasks/${encodeURIComponent(taskId)}`, 'GET', undefined, execution.signal),
          taskId,
        );
        const principal = await options.backgroundTaskAuthority({
          taskId,
          task,
          binding: trustedBinding,
          tool: trustedTool,
          arguments: argumentsValue,
          signal: execution.signal,
        });
        if (principal === undefined) {
          throw new Error('Background task is outside its active responsibility authorization');
        }
        return executeTeamsProviderCall(
          options, binding, tool, argumentsValue, execution, taskId, principal,
        );
      }
      if (tool.readOnly) {
        const rawResult = await callProvider(options.bridge, binding, tool, argumentsValue, execution.signal);
        return successfulResult(parseProviderResult(rawResult));
      }

      // Writes are always human-gated against the actual active DSH Session.
      if (!sessionId || !taskId) throw new Error('Write tools require an active durable Navigator task');
      await options.bridge.requestApproval(
        sessionId,
        'tool.provider.v1',
        `Run ${tool.name} through ${binding.bindingId}`,
        { bindingId: binding.bindingId, toolId: tool.id, arguments: argumentsValue },
        execution.signal,
        String(execution.callId),
      );

      const receipt = await beginOperation(
        options.bridge, execution, taskId, binding, tool, argumentsValue,
      );
      if (receipt.duplicate || receipt.status !== 'started') {
        throw new Error('An operation receipt already exists; reconcile it before retrying this provider call');
      }
      if (execution.signal.aborted) {
        await markUncertain(options.bridge, receipt.id);
        throw abortError(execution.signal);
      }

      let result: ProviderToolResult;
      try {
        result = parseProviderResult(await callProvider(
          options.bridge, binding, tool, argumentsValue, execution.signal, execution,
        ));
      } catch {
        await markUncertain(options.bridge, receipt.id);
        if (execution.signal.aborted) throw abortError(execution.signal);
        throw new Error('Canonical tool call failed; its remote outcome is uncertain');
      }

      try {
        await options.bridge.request(`/operations/${encodeURIComponent(receipt.id)}`, 'PATCH', {
          status: 'verified',
          evidence: { outcome: 'response_received', isError: result.isError === true },
        }, AbortSignal.timeout(5_000));
      } catch {
        throw new Error('Canonical tool response arrived but its receipt could not be finalized; reconcile before retrying');
      }
      return successfulResult(result);
    },
  };
}

/** Route one call only through the host-configured binding and identifier. */
function callProvider(
  bridge: ToolProviderRegistrationOptions['bridge'],
  binding: ProviderBinding,
  tool: ProviderTool,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  execution?: ToolRunContext,
): Promise<Record<string, JsonValue>> {
  const path = `/tool-providers/${encodeURIComponent(binding.bindingId)}/tools/${encodeURIComponent(tool.id)}/call`;
  if (execution !== undefined) return bridge.mutate(execution, path, 'POST', { arguments: args });
  return bridge.request(path, 'POST', { arguments: args }, signal);
}

interface TeamsTaskCaller {
  readonly issuer: string;
  readonly subject: string;
  readonly tenantId: string;
}

function readBackgroundTaskRecord(value: unknown, expectedTaskId: string): ResponsibilityTaskRecord {
  const row = objectValue(value, 'background responsibility task');
  const statuses = new Set(['queued', 'running', 'completed', 'failed', 'aborted', 'waiting_approval', 'waiting_input', 'awaiting_user_authorization']);
  if (row.id !== expectedTaskId || typeof row.sessionId !== 'string' || !row.sessionId
    || typeof row.prompt !== 'string' || !statuses.has(String(row.status))
    || typeof row.createdAt !== 'number' || !Number.isSafeInteger(row.createdAt)
    || typeof row.output !== 'string' || typeof row.reasoning !== 'string'
    || typeof row.durationMs !== 'number' || !Number.isSafeInteger(row.durationMs)) {
    throw new TypeError('Work API returned an invalid background responsibility task');
  }
  if (row.metadata !== undefined && (row.metadata === null || typeof row.metadata !== 'object' || Array.isArray(row.metadata))) {
    throw new TypeError('Work API returned invalid task metadata');
  }
  if (row.executionClass !== undefined && row.executionClass !== 'foreground' && row.executionClass !== 'background') {
    throw new TypeError('Work API returned an invalid task execution class');
  }
  if (row.parentTaskId !== undefined && row.parentTaskId !== null && typeof row.parentTaskId !== 'string') {
    throw new TypeError('Work API returned an invalid task parent');
  }
  return row as unknown as ResponsibilityTaskRecord;
}

async function readTeamsCallerForTask(
  bridge: ToolProviderRegistrationOptions['bridge'],
  taskId: string,
  signal: AbortSignal,
): Promise<TeamsTaskCaller | undefined> {
  const task = objectValue(await bridge.request(`/tasks/${encodeURIComponent(taskId)}`, 'GET', undefined, signal), 'durable task');
  if (task.metadata === null || typeof task.metadata !== 'object' || Array.isArray(task.metadata)) return undefined;
  const metadata = task.metadata as Record<string, unknown>;
  const value = metadata.teamsCaller;
  if (value === undefined) return undefined;
  const row = objectValue(value, 'trusted Teams task caller');
  const issuer = boundedText(row.issuer, 'Teams caller issuer', 512);
  const subject = boundedText(row.subject, 'Teams caller subject', 128).toLowerCase();
  const tenantId = boundedText(row.tenantId, 'Teams caller tenant', 128).toLowerCase();
  if (!isUuid(subject) || !isUuid(tenantId)
    || issuer !== `https://login.microsoftonline.com/${tenantId}/v2.0`
    || (row.actorAadObjectId !== undefined && row.actorAadObjectId !== subject)) {
    throw new TypeError('Trusted Teams task caller identity is malformed');
  }
  return { issuer, subject, tenantId };
}

async function executeTeamsProviderCall(
  options: ToolProviderRegistrationOptions,
  binding: ProviderBinding,
  tool: ProviderTool,
  args: Record<string, JsonValue>,
  execution: ToolRunContext,
  taskId: string,
  caller: TeamsTaskCaller | ResponsibilityPrincipal,
): Promise<unknown> {
  const authorization = options.connectorAuthorization;
  if (!authorization) throw new Error('Teams connector authorization is unavailable');
  const hostBinding = authorization.bindings.get(binding.bindingId);
  const toolAuthorization = hostBinding?.tools.find(item => item.toolId === tool.id);
  if (!hostBinding || !toolAuthorization) {
    throw new Error('This connector tool has no launcher-owned operation binding');
  }
  if ((binding.providerId !== undefined && binding.providerId !== hostBinding.providerId)
    || (binding.connectionRef !== undefined && binding.connectionRef !== hostBinding.connectionRef)
    || (binding.profileRef !== undefined && binding.profileRef !== hostBinding.profileRef)
    || (tool.providerId !== undefined && tool.providerId !== hostBinding.providerId)
    || (tool.connectionRef !== undefined && tool.connectionRef !== hostBinding.connectionRef)
    || (tool.profileRef !== undefined && tool.profileRef !== hostBinding.profileRef)
    || (tool.operationId !== undefined && tool.operationId !== toolAuthorization.operationId)) {
    throw new Error('Provider catalog metadata does not match the launcher-owned connector binding');
  }
  const profileArgument = argumentString(args, 'profile_ref', 'profileRef');
  const profileIsOuterClaim = hostBinding.providerId === 'github'
    || hostBinding.providerId === 'huggingface'
    || hostBinding.providerId === 'computer';
  if (profileIsOuterClaim && (args.profile_ref !== undefined || args.profileRef !== undefined)) {
    throw new Error('This connector provider does not accept a model-supplied profile');
  }
  if (!profileIsOuterClaim && profileArgument !== undefined && profileArgument !== hostBinding.profileRef) {
    throw new Error('The requested profile is outside this launcher-owned connector binding');
  }
  const actualArguments: Record<string, JsonValue> = profileIsOuterClaim
    ? { ...args }
    : { ...args, profile_ref: hostBinding.profileRef };
  const providerId = hostBinding.providerId;
  const connectionRef = hostBinding.connectionRef;
  const profileRef = hostBinding.profileRef;
  const operationId = toolAuthorization.operationId;
  const target = connectorTargetProjection(toolAuthorization.resourceProjection, profileRef, connectionRef, actualArguments);
  const resourceRef = `sha256:${sha256(canonicalJson({ providerId, profileRef, operationId, target }))}`;
  const targetDigestSha256 = sha256(canonicalJson({ providerId, profileRef, target }));
  const receiptTarget = `connector-target:${sha256(canonicalJson({ providerId, profileRef, target }))}`;
  const readbackReceiptTarget = `connector-readback:${targetDigestSha256}`;
  const scopeLock = toolAuthorization.mutating
    ? connectorScopeLock(providerId, profileRef, operationId, actualArguments)
    : undefined;
  const requestId = boundedText(String(execution.callId), 'connector request id', 512);
  const backgroundActionTask = taskId.startsWith('workflow-action-');
  const grantRequest: ConnectorGrantRequest = {
    requestId,
    workspaceId: authorization.workspaceId,
    principalIssuer: caller.issuer,
    principalSubject: caller.subject,
    connectionRef,
    providerId,
    profileRef,
    operationId,
    resourceRef,
    argumentsDigestSha256: sha256(canonicalJson(actualArguments)),
    arguments: actualArguments,
  };
  let operation: OperationReceipt | undefined;
  const unresolved = await listUnresolvedOperations(
    options.bridge,
    toolAuthorization.mutating && !backgroundActionTask ? receiptTarget : undefined,
    execution.signal,
  );
  if (toolAuthorization.mutating) {
    const blockers = backgroundActionTask
      ? unresolved.filter(item => isBackgroundActionWriteBlocked(item, taskId, providerId, profileRef, receiptTarget))
      : unresolved;
    if (blockers.length > 0) {
      const priorReceiptId = blockers.find(item => typeof item.id === 'string')?.id;
      const receiptHint = typeof priorReceiptId === 'string' ? ` Work operation ID: ${priorReceiptId}.` : '';
      const scope = backgroundActionTask ? 'this workflow action' : 'this exact provider target';
      throw new Error(`A prior operation in ${scope} has no reconciled outcome; read its operation status before retrying, then reconcile its receipt with an independent readback.${receiptHint}`);
    }
  }
  const readbackForUnresolvedWrite = !toolAuthorization.mutating
    && unresolved.some(item => isMatchingUnresolvedConnectorWrite(item, taskId, providerId, profileRef));
  const grant = await authorization.client.mintGrant(grantRequest, execution.signal);
  if (toolAuthorization.mutating || readbackForUnresolvedWrite) {
    operation = await beginOperation(
      options.bridge, execution, taskId, binding, tool, actualArguments, operationId,
      toolAuthorization.mutating ? receiptTarget : readbackReceiptTarget, scopeLock,
    );
    if (operation.duplicate || operation.status !== 'started') {
      throw new Error('An operation receipt already exists; reconcile it before retrying this provider call');
    }
  }
  if (execution.signal.aborted) {
    if (operation) {
      await options.bridge.request(`/operations/${encodeURIComponent(operation.id)}`, 'PATCH', {
        status: 'verified', evidence: {
          outcome: 'cancelled_before_invoke',
          effect: toolAuthorization.mutating ? 'write' : 'read',
          bindingId: binding.bindingId,
          providerId,
          profileRef,
          operationId,
          targetDigestSha256,
        },
      }, AbortSignal.timeout(5_000));
    }
    if (operation && toolAuthorization.mutating) {
      throw new Error('The provider call was cancelled before it started.', { cause: abortError(execution.signal) });
    }
    throw abortError(execution.signal);
  }
  if (backgroundActionTask && toolAuthorization.mutating && operation !== undefined) {
    try {
      await appendBackgroundWriteReceipt(
        options.bridge, execution, taskId, operation.id, String(execution.callId),
        binding.bindingId, providerId, profileRef, targetDigestSha256,
      );
    } catch (error: unknown) {
      await options.bridge.request(`/operations/${encodeURIComponent(operation.id)}`, 'PATCH', {
        status: 'verified',
        evidence: {
          outcome: 'cancelled_before_invoke', effect: 'write', bindingId: binding.bindingId,
          providerId, profileRef, operationId, targetDigestSha256,
          reason: 'operation_receipt_link_unavailable',
        },
      }, AbortSignal.timeout(5_000)).catch(() => undefined);
      throw new Error('The Work operation receipt could not be linked to this action before provider invocation; no provider call was made.', {
        cause: error,
      });
    }
  }
  if (execution.signal.aborted) {
    if (operation) {
      await options.bridge.request(`/operations/${encodeURIComponent(operation.id)}`, 'PATCH', {
        status: 'verified', evidence: {
          outcome: 'cancelled_before_invoke', effect: toolAuthorization.mutating ? 'write' : 'read',
          bindingId: binding.bindingId, providerId, profileRef, operationId, targetDigestSha256,
        },
      }, AbortSignal.timeout(5_000)).catch(() => undefined);
    }
    throw abortError(execution.signal);
  }

  let providerResponse: Awaited<ReturnType<ExchangeConnectorAuthorizationClient['callProviderOperation']>>;
  let result: ProviderToolResult;
  let abortReceiptUpdate: Promise<void> | undefined;
  const markProviderCallUncertainOnAbort = (): void => {
    if (operation === undefined) return;
    abortReceiptUpdate ??= markUncertain(options.bridge, operation.id, {
      outcome: 'unknown_after_cancellation_during_provider_call',
      effect: toolAuthorization.mutating ? 'write' : 'read',
      bindingId: binding.bindingId,
      providerId,
      profileRef,
      operationId,
      targetDigestSha256,
    });
  };
  execution.signal.addEventListener('abort', markProviderCallUncertainOnAbort, { once: true });
  try {
    providerResponse = await authorization.client.callProviderOperation({
      requestId,
      connectionRef,
      providerId,
      profileRef,
      operationId,
      resourceRef,
      arguments: actualArguments,
    }, grant, execution.signal);
    if (execution.signal.aborted) {
      markProviderCallUncertainOnAbort();
      await abortReceiptUpdate;
      throw new Error('The provider call was cancelled after invocation; its remote outcome is unknown.');
    }
    result = parseProviderResult(providerResponse.result);
  } catch (error: unknown) {
    execution.signal.removeEventListener('abort', markProviderCallUncertainOnAbort);
    if (execution.signal.aborted) {
      markProviderCallUncertainOnAbort();
      await abortReceiptUpdate;
      if (toolAuthorization.mutating && operation !== undefined) {
        throw new Error('The remote write outcome is unknown after cancellation. Do not retry until an independent readback is reconciled.', {
          cause: error,
        });
      }
      throw error;
    }
    if (operation) {
      if (error instanceof ExchangeConnectorRequestError && !error.outcomeUnknown) {
        await options.bridge.request(`/operations/${encodeURIComponent(operation.id)}`, 'PATCH', {
          status: 'verified', evidence: {
            outcome: 'rejected',
            effect: toolAuthorization.mutating ? 'write' : 'read',
            bindingId: binding.bindingId,
            providerId,
            profileRef,
            operationId,
            targetDigestSha256,
            status: error.status ?? null,
          },
        }, AbortSignal.timeout(5_000)).catch(() => undefined);
      } else {
        await markUncertain(options.bridge, operation.id, {
          outcome: 'unknown_after_provider_call',
          effect: toolAuthorization.mutating ? 'write' : 'read',
          bindingId: binding.bindingId,
          providerId,
          profileRef,
          operationId,
          targetDigestSha256,
          ...(error instanceof ExchangeConnectorRequestError ? { status: error.status ?? null } : {}),
        });
        if (toolAuthorization.mutating) {
          throw new Error('The remote write outcome is unknown. Do not retry until an independent readback is reconciled.', {
            cause: error,
          });
        }
      }
      if (toolAuthorization.mutating && operation) {
        throw new Error('The provider rejected the write; inspect its Work receipt before choosing another action.', { cause: error });
      }
    }
    throw error;
  }
  execution.signal.removeEventListener('abort', markProviderCallUncertainOnAbort);
  const operationRef = providerResponse.operationRef ?? providerResultOperationRef(result);
  const effectiveOutcome = effectiveProviderOutcome(providerResponse.outcome, result, operationRef);
  const knownOutcome = effectiveOutcome === 'verified' || effectiveOutcome === 'failed';
  if (operation) {
    const receiptEvidence: Record<string, unknown> = {
      outcome: effectiveOutcome,
      effect: toolAuthorization.mutating ? 'write' : 'read',
      bindingId: binding.bindingId,
      providerId,
      profileRef,
      operationId,
      targetDigestSha256,
      ...(operationRef === undefined ? {} : { operationRef }),
      isError: result.isError === true,
      ...(toolAuthorization.mutating || !knownOutcome ? {} : {
        resultSha256: sha256(canonicalJson(result)),
      }),
    };
    try {
      await options.bridge.request(`/operations/${encodeURIComponent(operation.id)}`, 'PATCH', {
        status: knownOutcome ? 'verified' : 'uncertain',
        evidence: receiptEvidence,
      }, AbortSignal.timeout(5_000));
    } catch {
      throw new Error(
        `Canonical connector response arrived but Work receipt ${operation.id} could not be finalized; reconcile before retrying`,
      );
    }
  }
  if (operationId === 'cloud.operation.status.read'
    && ['verified', 'failed'].includes(providerResponse.outcome)) {
    await reconcileTerminalOperation(
      options.bridge,
      providerId,
      profileRef,
      result,
      execution.signal,
      operationRef,
    );
  }
  if (effectiveOutcome === 'uncertain') {
    const operationHint = operationRef === undefined ? '' : ` (operationRef: ${operationRef})`;
    const effectHint = toolAuthorization.mutating ? 'write' : 'read';
    const receiptHint = operation === undefined ? '' : ` Work operation ID: ${operation.id}.`;
    throw new Error(`Exchange reports an unknown remote ${effectHint} result${operationHint}.${receiptHint} The receipt remains blocked pending independent status reconciliation.`);
  }
  if (effectiveOutcome === 'failed' && result.isError !== true) {
    throw new Error('Exchange reports a failed remote operation');
  }
  const returned = withProviderOutcome(result, effectiveOutcome, operationRef);
  let finalResult = returned;
  if (!toolAuthorization.mutating && operation !== undefined) {
    const structured = returned.structuredContent !== undefined
      && returned.structuredContent !== null && typeof returned.structuredContent === 'object'
      && !Array.isArray(returned.structuredContent)
      ? { ...(returned.structuredContent as Record<string, JsonValue>) }
      : {};
    structured.workOperationId = operation.id;
    finalResult = { ...returned, structuredContent: structured };
  }
  return successfulResult(finalResult);
}

function connectorTargetProjection(
  projection: ConnectorResourceProjection,
  profileRef: string,
  connectionRef: string,
  args: Record<string, JsonValue>,
): JsonValue {
  switch (projection) {
    case 'empty':
      return {};
    case 'profile':
      return { profile_ref: profileRef };
    case 'github_repository':
      return pickRequiredFields(args, ['repository_id', 'repository']);
    case 'github_pull_request':
      return { ...pickRequiredFields(args, ['repository_id', 'repository']), ...pickRequiredFields(args, ['pull_number']) };
    case 'github_ci':
      return { ...pickRequiredFields(args, ['repository_id', 'repository']), ...pickRequiredFields(args, ['commit_sha']) };
    case 'github_commit':
      return { ...pickRequiredFields(args, ['repository_id', 'repository']), ...pickRequiredFields(args, ['commit_sha']) };
    case 'github_issue':
      return { ...pickRequiredFields(args, ['repository_id', 'repository']), ...pickRequiredFields(args, ['issue_number']) };
    case 'github_actions_run':
      return { ...pickRequiredFields(args, ['repository_id', 'repository']), ...pickRequiredFields(args, ['run_id']) };
    case 'github_actions_job':
      return {
        ...pickRequiredFields(args, ['repository_id', 'repository']),
        ...pickRequiredFields(args, ['run_id']),
        ...pickRequiredFields(args, ['job_id']),
      };
    case 'github_branch':
      return { ...pickRequiredFields(args, ['repository_id', 'repository']), ...pickRequiredFields(args, ['branch']) };
    case 'github_file':
      return {
        ...pickRequiredFields(args, ['repository_id', 'repository']),
        ...pickRequiredFields(args, ['branch']),
        ...pickRequiredFields(args, ['path']),
      };
    case 'github_pull_request_draft':
      return {
        ...pickRequiredFields(args, ['repository_id', 'repository']),
        ...pickRequiredFields(args, ['head_branch', 'base_branch']),
      };
    case 'computer_workspace':
      return { workspace_ref: connectionRef };
    case 'computer_file':
    case 'computer_directory':
      return { workspace_ref: connectionRef, ...pickRequiredFields(args, ['path']) };
    case 'huggingface_repository':
      return {
        ...pickRequiredFields(args, ['repo_type', 'repo_id']),
        ...pickAvailableFields(args, ['path', 'revision']),
      };
    case 'cloud_target':
      if (args.target === undefined) throw new TypeError('Connector operation needs an exact target; ask for the missing resource');
      return args.target;
    case 'cloud_operation':
      return pickRequiredFields(args, ['operation_ref']);
    default:
      throw new TypeError('Connector binding has an unsupported resource projection');
  }
}

/** Compute a host-owned serialization key for GitHub writes sharing one branch. */
function connectorScopeLock(
  providerId: string,
  profileRef: string,
  operationId: string,
  args: Record<string, JsonValue>,
): string | undefined {
  if (providerId !== 'github') return undefined;
  const branchField = operationId === 'github.branch.create' || operationId === 'github.branch.delete'
    || operationId === 'github.file.commit'
    ? 'branch'
    : operationId === 'github.pull_request.draft.create'
      ? 'head_branch'
      : operationId === 'github.actions.rerun_failed' ? 'expected_head_branch' : undefined;
  if (branchField === undefined) return undefined;

  const idValue = args.repository_id;
  const repositoryId = typeof idValue === 'number' && Number.isSafeInteger(idValue) && idValue > 0
    ? String(idValue)
    : typeof idValue === 'string' && /^[1-9]\d{0,18}$/u.test(idValue) ? idValue : undefined;
  const repository = typeof args.repository === 'string'
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(args.repository)
    ? args.repository.toLowerCase()
    : undefined;
  const branch = args[branchField];
  if (!repositoryId || !repository || typeof branch !== 'string' || branch.length === 0
    || branch.length > 255 || branch.includes('\\') || /[\u0000-\u0020]/u.test(branch)) {
    throw new TypeError('GitHub branch write requires a canonical repository and branch for serialization');
  }
  const digest = sha256(canonicalJson({
    providerId,
    profileRef,
    repository_id: repositoryId,
    repository,
    branch,
  }));
  return `connector-branch:${digest}`;
}

function pickRequiredFields(args: Record<string, JsonValue>, fields: readonly string[]): Record<string, JsonValue> {
  const value = pickAvailableFields(args, fields);
  if (Object.keys(value).length === 0) throw new TypeError('Connector operation needs an exact target; ask for the missing resource');
  return value;
}

function pickAvailableFields(args: Record<string, JsonValue>, fields: readonly string[]): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const field of fields) {
    const value = args[field];
    if (value !== undefined) result[field] = value;
  }
  return result;
}

function argumentString(args: Record<string, JsonValue>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

/** Create an idempotent task/call receipt before the provider can mutate state. */
async function beginOperation(
  bridge: ToolProviderRegistrationOptions['bridge'],
  execution: ToolRunContext,
  taskId: string,
  binding: ProviderBinding,
  tool: ProviderTool,
  args: Record<string, JsonValue>,
  operationId: string = tool.operationId ?? tool.id,
  receiptTarget?: string,
  scopeLock?: string,
): Promise<OperationReceipt> {
  const digest = createHash('sha256').update(taskId).update('\0').update(String(execution.callId)).digest('hex');
  const response = await bridge.mutate(execution, '/operations', 'POST', {
    idempotencyKey: `tool-provider-v1:${digest}`,
    operationType: `tool.provider.v1:${operationId}`,
    taskId,
    target: receiptTarget ?? `${binding.bindingId}/${operationId}`,
    request: { bindingId: binding.bindingId, toolId: tool.id, operationId, arguments: args },
    ...(scopeLock === undefined ? {} : { scopeLock }),
  }, true);
  const wrapper = objectValue(response.operation ?? response, 'operation receipt');
  const id = safeIdentifier(wrapper.id, 'operation receipt id');
  if (wrapper.status !== 'started' && wrapper.status !== 'uncertain' && wrapper.status !== 'verified') {
    throw new TypeError('Operation receipt has an invalid status');
  }
  if (typeof response.duplicate !== 'boolean') throw new TypeError('Operation receipt omitted duplicate status');
  return { id, status: wrapper.status, duplicate: response.duplicate };
}

/** Link a background write receipt to its durable task before any provider side effect can start. */
async function appendBackgroundWriteReceipt(
  bridge: ToolProviderRegistrationOptions['bridge'],
  execution: ToolRunContext,
  taskId: string,
  operationId: string,
  callId: string,
  bindingId: string,
  providerId: string,
  profileRef: string,
  targetDigestSha256: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(targetDigestSha256)) throw new TypeError('Connector operation target digest is invalid');
  const event = {
    type: 'connector.operation.receipt.v1',
    operationId: safeIdentifier(operationId, 'connector operation receipt id'),
    callId: boundedText(callId, 'connector call id', 512),
    bindingId: safeIdentifier(bindingId, 'connector binding id'),
    providerId: safeIdentifier(providerId, 'connector provider id'),
    profileRef: safeIdentifier(profileRef, 'connector profile reference'),
    targetDigestSha256,
    effect: 'write',
    outcome: 'started',
  };
  await bridge.mutate(execution, `/tasks/${encodeURIComponent(taskId)}/events`, 'POST', {
    event,
    messageId: `connector-operation-${event.operationId}`,
  }, false);
}

/** Record an unknown remote outcome on a fresh bounded signal, even after caller cancellation. */
async function markUncertain(
  bridge: ToolProviderRegistrationOptions['bridge'],
  operationId: string,
  evidence: Readonly<Record<string, unknown>> = { outcome: 'unknown_after_provider_call' },
): Promise<void> {
  try {
    await bridge.request(`/operations/${encodeURIComponent(operationId)}`, 'PATCH', {
      status: 'uncertain', evidence,
    }, AbortSignal.timeout(5_000));
  } catch {
    // A remaining started receipt still blocks replay; recovery can reconcile it later.
  }
}

async function listUnresolvedOperations(
  bridge: ToolProviderRegistrationOptions['bridge'],
  target: string | undefined,
  signal: AbortSignal,
): Promise<readonly Record<string, unknown>[]> {
  const query = new URLSearchParams({ limit: '500' });
  if (target !== undefined) query.set('target', target);
  const response = objectValue(await bridge.request(`/operations/unresolved?${query}`, 'GET', undefined, signal), 'unresolved provider operations');
  if (!Array.isArray(response.items)) throw new TypeError('Work omitted unresolved provider operation rows');
  if (response.items.length === 500) {
    throw new Error('The unresolved operation set reached its inspection limit; reconcile receipts before starting another write.');
  }
  return response.items.map((item, index) => objectValue(item, `unresolved provider operation ${index}`));
}

function isMatchingUnresolvedConnectorWrite(
  operation: Record<string, unknown>,
  taskId: string,
  providerId: string,
  profileRef: string,
): boolean {
  const evidence = operation.evidence;
  if (operation.taskId !== taskId || evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return false;
  }
  const row = evidence as Record<string, unknown>;
  return row.effect !== 'read'
    && row.providerId === providerId
    && row.profileRef === profileRef;
}

/** Block replay inside one action and block exact-target replay across later child tasks. */
export function isBackgroundActionWriteBlocked(
  operation: Readonly<Record<string, unknown>>,
  taskId: string,
  providerId: string,
  profileRef: string,
  target: string,
): boolean {
  const evidence = operation.evidence;
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return true;
  const row = evidence as Record<string, unknown>;
  if (row.effect === 'read' || row.providerId !== providerId || row.profileRef !== profileRef) return false;
  if (operation.taskId === taskId) return true;
  if (typeof operation.target !== 'string' || !operation.target) return true;
  return operation.target === target;
}

async function reconcileTerminalOperation(
  bridge: ToolProviderRegistrationOptions['bridge'],
  providerId: string,
  profileRef: string,
  result: ProviderToolResult,
  signal: AbortSignal,
  envelopeOperationRef?: string,
): Promise<void> {
  const status = providerResultState(result);
  if (!['SUCCEEDED', 'FAILED', 'CANCELED', 'CANCELLED', 'COMPLETED'].includes(status ?? '')) return;
  const operationRef = providerResultOperationRef(result) ?? envelopeOperationRef;
  if (!operationRef) return;
  const query = new URLSearchParams({ limit: '500' });
  const response = objectValue(await bridge.request(`/operations/unresolved?${query}`, 'GET', undefined, signal), 'unresolved provider operations');
  if (!Array.isArray(response.items)) throw new TypeError('Work omitted unresolved provider operation rows');
  for (const [index, value] of response.items.entries()) {
    const row = objectValue(value, `unresolved provider operation ${index}`);
    const evidence = objectValue(row.evidence, 'provider operation evidence');
    if (evidence.providerId !== providerId || evidence.profileRef !== profileRef
      || evidence.operationRef !== operationRef || row.status !== 'started' && row.status !== 'uncertain') continue;
    const id = safeIdentifier(row.id, 'provider operation receipt id');
    await bridge.request(`/operations/${encodeURIComponent(id)}`, 'PATCH', {
      status: 'verified',
      evidence: {
        ...evidence,
        reconciledByOperationRef: operationRef,
        reconciliationState: status,
      },
    }, AbortSignal.timeout(5_000));
  }
}

function providerResultState(result: ProviderToolResult): string | undefined {
  const structured = result.structuredContent;
  if (structured !== undefined && structured !== null && typeof structured === 'object' && !Array.isArray(structured)) {
    const row = structured as Record<string, unknown>;
    const state = row.state ?? row.status;
    if (typeof state === 'string') return state.toUpperCase();
  }
  for (const block of result.content) {
    try {
      const value: unknown = JSON.parse(block.text);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const row = value as Record<string, unknown>;
        const state = row.state ?? row.status;
        if (typeof state === 'string') return state.toUpperCase();
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function providerResultOperationRef(result: ProviderToolResult): string | undefined {
  const structured = result.structuredContent;
  if (structured !== undefined && structured !== null && typeof structured === 'object' && !Array.isArray(structured)) {
    const row = structured as Record<string, unknown>;
    const value = row.operation_ref ?? row.operationRef;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  for (const block of result.content) {
    try {
      const value: unknown = JSON.parse(block.text);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const row = value as Record<string, unknown>;
        const operationRef = row.operation_ref ?? row.operationRef;
        if (typeof operationRef === 'string' && operationRef.length > 0) return operationRef;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function effectiveProviderOutcome(
  envelopeOutcome: 'verified' | 'pending' | 'uncertain' | 'failed',
  result: ProviderToolResult,
  operationRef?: string,
): 'verified' | 'pending' | 'uncertain' | 'failed' {
  const state = providerResultState(result);
  const remoteState = providerResultRemoteState(result);
  if (state && ['UNKNOWN', 'UNKNOWN_RESULT', 'UNCERTAIN', 'REMOTE_STATE_UNVERIFIED'].includes(state)
    || remoteState === 'UNKNOWN' || remoteState === 'UNKNOWN_RESULT') return 'uncertain';
  if (remoteState && ['PENDING', 'RUNNING', 'SUBMITTED', 'ACCEPTED'].includes(remoteState)
    || state && ['PENDING', 'RUNNING', 'SUBMITTED', 'ACCEPTED'].includes(state)) {
    return operationRef === undefined ? 'uncertain' : 'pending';
  }
  if (remoteState && ['FAILED', 'REJECTED', 'ERROR'].includes(remoteState)
    || state && ['FAILED', 'REJECTED', 'ERROR'].includes(state)) return 'failed';
  if (result.isError === true && envelopeOutcome !== 'failed') return 'uncertain';
  return envelopeOutcome;
}

function providerResultRemoteState(result: ProviderToolResult): string | undefined {
  const structured = result.structuredContent;
  if (structured !== undefined && structured !== null && typeof structured === 'object' && !Array.isArray(structured)) {
    const value = (structured as Record<string, unknown>).remote_state;
    if (typeof value === 'string') return value.toUpperCase();
  }
  for (const block of result.content) {
    try {
      const value: unknown = JSON.parse(block.text);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const remoteState = (value as Record<string, unknown>).remote_state;
        if (typeof remoteState === 'string') return remoteState.toUpperCase();
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function withProviderOutcome(
  result: ProviderToolResult,
  outcome: 'verified' | 'pending' | 'uncertain' | 'failed',
  operationRef?: string,
): ProviderToolResult {
  const previous = result.structuredContent;
  const structured: Record<string, JsonValue> = previous !== undefined
    && previous !== null && typeof previous === 'object' && !Array.isArray(previous)
    ? { ...(previous as Record<string, JsonValue>) }
    : previous === undefined ? {} : { businessResult: previous };
  structured.outcome = outcome;
  if (operationRef !== undefined) structured.operationRef = operationRef;
  return { ...result, structuredContent: structured };
}

/** Require the exact canonical text-result contract returned by tool.provider.v1. */
function parseProviderResult(value: unknown): ProviderToolResult {
  const result = objectValue(value, 'provider result');
  if (!Array.isArray(result.content) || result.content.length > MAX_CONTENT_BLOCKS) {
    throw new TypeError('Provider result content is invalid');
  }
  if (result.isError !== undefined && typeof result.isError !== 'boolean') {
    throw new TypeError('Provider result isError must be boolean');
  }
  let contentBytes = 0;
  const content = result.content.map((block, index): ProviderTextBlock => {
    const row = objectValue(block, `provider result content ${index}`);
    if (row.type !== 'text' || typeof row.text !== 'string') throw new TypeError('Provider result contains unsupported content');
    const text = boundedText(row.text, `provider result content ${index}`, MAX_RESULT_BYTES);
    contentBytes += Buffer.byteLength(text, 'utf8');
    if (contentBytes > MAX_RESULT_BYTES) throw new TypeError('Provider result exceeds its configured size limit');
    return { type: 'text', text };
  });
  const structuredContent = result.structuredContent;
  let safeStructuredContent: JsonValue | undefined;
  if (structuredContent !== undefined) {
    const snapshot = snapshotJsonValue(structuredContent);
    if (snapshot === undefined) throw new TypeError('Provider structuredContent is not lossless JSON');
    safeStructuredContent = snapshot as JsonValue;
  }
  const parsed: ProviderToolResult = {
    content,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(safeStructuredContent === undefined ? {} : { structuredContent: safeStructuredContent }),
  };
  if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_RESULT_BYTES) {
    throw new TypeError('Provider result exceeds its configured size limit');
  }
  return parsed;
}

/** Convert successful provider data to the DSH tool's declared output value. */
function successfulResult(result: ProviderToolResult): Record<string, JsonValue> {
  if (result.isError === true) {
    const text = result.content.map(block => block.text).filter(Boolean).join('\n');
    throw new Error(text || 'Configured tool provider returned an error');
  }
  return {
    content: result.content as unknown as JsonValue,
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
  };
}

/** Render canonical text, falling back to structured JSON when no text was emitted. */
function renderResult(value: JsonValue): string {
  const result = objectValue(value, 'canonical tool result');
  const text = Array.isArray(result.content)
    ? result.content.flatMap(block => {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) return [];
      return typeof block.text === 'string' ? [block.text] : [];
    }).join('\n')
    : '';
  return text || JSON.stringify(result.structuredContent ?? result);
}

/** Validate one catalog page before any model-facing tool registration. */
function parseBindings(value: unknown): ProviderBinding[] {
  const root = objectValue(value, 'tool provider catalog');
  if (!Array.isArray(root.items)) throw new TypeError('Tool provider catalog omitted items');
  if (root.items.length > MAX_PROVIDER_COUNT) throw new TypeError('Tool provider catalog exceeds its configured limit');
  const bindings: ProviderBinding[] = [];
  const seen = new Set<string>();
  for (const item of root.items) {
    const row = objectValue(item, 'tool provider binding');
    const bindingId = safeIdentifier(row.bindingId, 'tool provider binding id');
    if (row.capabilityId !== 'tool.provider.v1') continue;
    if (seen.has(bindingId)) throw new TypeError('Tool provider catalog contains a duplicate binding');
    seen.add(bindingId);
    bindings.push({
      bindingId,
      capabilityId: 'tool.provider.v1',
      ...(row.providerId === undefined ? {} : { providerId: safeIdentifier(row.providerId, 'provider id') }),
      ...(row.connectionRef === undefined ? {} : { connectionRef: safeIdentifier(row.connectionRef, 'connection reference') }),
      ...(row.profileRef === undefined ? {} : { profileRef: safeIdentifier(row.profileRef, 'profile reference') }),
    });
  }
  return bindings;
}

function parseConnectorToolCatalogSnapshot(value: unknown): Array<{ binding: ProviderBinding; toolCatalog: unknown }> {
  const root = objectValue(value, 'private connector tool catalog');
  assertExactKeys(root, ['schemaVersion', 'items'], 'private connector tool catalog');
  if (root.schemaVersion !== 1 || !Array.isArray(root.items) || root.items.length > MAX_PROVIDER_COUNT) {
    throw new TypeError('Private connector tool catalog has an unsupported version or item count');
  }
  const rows = root.items.map((item, index) => {
    const row = objectValue(item, `private connector catalog binding ${index}`);
    assertExactKeys(row, [
      'bindingId', 'capabilityId', 'providerId', 'connectionRef', 'profileRef', 'tools',
    ], `private connector catalog binding ${index}`);
    if (row.capabilityId !== 'tool.provider.v1' || !Array.isArray(row.tools)
      || row.tools.length > MAX_TOOL_COUNT) {
      throw new TypeError(`Private connector catalog binding ${index} is invalid`);
    }
    for (const [toolIndex, tool] of row.tools.entries()) {
      const toolRow = objectValue(tool, `private connector catalog tool ${index}:${toolIndex}`);
      assertExactKeys(toolRow, ['id', 'name', 'description', 'readOnly', 'inputSchema'],
        `private connector catalog tool ${index}:${toolIndex}`);
    }
    return {
      binding: {
        bindingId: row.bindingId,
        capabilityId: row.capabilityId,
        providerId: row.providerId,
        connectionRef: row.connectionRef,
        profileRef: row.profileRef,
      },
      toolCatalog: { tools: row.tools },
    };
  });
  const parsedBindings = parseBindings({ items: rows.map(row => row.binding) });
  if (parsedBindings.length !== rows.length) {
    throw new TypeError('Private connector catalog contains an unsupported capability');
  }
  return rows.map((row, index) => {
    const binding = parsedBindings[index];
    if (binding === undefined) throw new TypeError('Private connector catalog binding is invalid');
    return { binding, toolCatalog: row.toolCatalog };
  });
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const orderedExpected = [...expected].sort();
  if (actual.length !== orderedExpected.length
    || actual.some((key, index) => key !== orderedExpected[index])) {
    throw new TypeError(`${label} contains missing or unsupported fields`);
  }
}

/** Validate tool metadata and provider-supplied JSON Schema before registration. */
function parseTools(value: unknown, bindingId: string): ProviderTool[] {
  const root = objectValue(value, `${bindingId} tool catalog`);
  if (!Array.isArray(root.tools)) throw new TypeError('Tool provider catalog omitted tools');
  if (root.tools.length > MAX_TOOL_COUNT) throw new TypeError('Tool provider catalog exceeds its configured tool limit');
  const seen = new Set<string>();
  return root.tools.map((item, index) => {
    const row = objectValue(item, `tool provider tool ${index}`);
    const id = safeIdentifier(row.id, 'tool provider tool id');
    if (seen.has(id)) throw new TypeError('Tool provider catalog contains a duplicate tool id');
    seen.add(id);
    const name = boundedText(row.name, 'tool provider tool name', 128);
    const description = boundedText(row.description, 'tool provider description', 4_096);
    if (typeof row.readOnly !== 'boolean') throw new TypeError(`Tool ${id} must declare readOnly`);
    const schema = row.inputSchema;
    if (!isJsonValue(schema) || schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new TypeError(`Tool ${id} inputSchema must be a JSON object`);
    }
    if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MAX_SCHEMA_BYTES) {
      throw new TypeError(`Tool ${id} inputSchema exceeds its configured size limit`);
    }
    const schemaValue = schema as JsonValue;
    const constraints = collectProviderConstraints(schemaValue);
    const dshSchema = projectProviderSchemaForDsh(schemaValue);
    assertObjectJsonSchema(dshSchema);
    // DSH's enforced subset omits these provider keywords; host validation preserves their constraints.
    return {
      id,
      name,
      description,
      inputSchema: structuredClone(dshSchema) as unknown as Record<string, unknown>,
      constraints,
      readOnly: row.readOnly,
      ...(row.providerId === undefined ? {} : { providerId: safeIdentifier(row.providerId, 'tool provider id') }),
      ...(row.operationId === undefined ? {} : { operationId: safeIdentifier(row.operationId, 'provider operation id') }),
      ...(row.connectionRef === undefined ? {} : { connectionRef: safeIdentifier(row.connectionRef, 'tool connection reference') }),
      ...(row.profileRef === undefined ? {} : { profileRef: safeIdentifier(row.profileRef, 'tool profile reference') }),
    };
  });
}

const PROJECTED_PROVIDER_CONSTRAINTS = new Set([
  'pattern', 'minimum', 'maximum', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
]);

function collectProviderConstraints(schema: JsonValue): ProviderInputConstraint[] {
  const constraints: ProviderInputConstraint[] = [];
  const pending: Array<{ node: JsonValue; path: (string | '*')[]; depth: number }> = [
    { node: schema, path: [], depth: 0 },
  ];
  while (pending.length > 0) {
    const frame = pending.pop()!;
    if (frame.depth > 64) throw new TypeError('Provider schema nesting exceeds its configured limit');
    if (frame.node === null || Array.isArray(frame.node)
      || typeof frame.node !== 'object') continue;
    const node = frame.node as Record<string, JsonValue>;
    const constraint: {
      path: readonly (string | '*')[];
      pattern?: string;
      regex?: RegExp;
      minimum?: number;
      maximum?: number;
      minLength?: number;
      maxLength?: number;
      minItems?: number;
      maxItems?: number;
      uniqueItems?: boolean;
      minProperties?: number;
      maxProperties?: number;
    } = { path: frame.path };
    if (Object.hasOwn(node, 'pattern')) {
      const expression = node.pattern;
      if (node.type !== 'string' || typeof expression !== 'string' || expression.length > 256) {
        throw new TypeError('Provider schema pattern must be a bounded string constraint');
      }
      try {
        constraint.pattern = expression;
        constraint.regex = new RegExp(expression, 'u');
      } catch {
        throw new TypeError('Provider schema pattern is not a supported ECMAScript expression');
      }
    }
    if (['minLength', 'maxLength'].some(key => Object.hasOwn(node, key))) {
      if (node.type !== 'string') throw new TypeError('Provider length bounds require a string schema');
      if (Object.hasOwn(node, 'minLength')) constraint.minLength = boundedSchemaInteger(node.minLength, 'minLength');
      if (Object.hasOwn(node, 'maxLength')) constraint.maxLength = boundedSchemaInteger(node.maxLength, 'maxLength');
      if (constraint.minLength !== undefined && constraint.maxLength !== undefined
        && constraint.minLength > constraint.maxLength) throw new TypeError('Provider string bounds conflict');
    }
    if (['minimum', 'maximum'].some(key => Object.hasOwn(node, key))) {
      if (node.type !== 'number' && node.type !== 'integer') {
        throw new TypeError('Provider numeric bounds require a number schema');
      }
      if (Object.hasOwn(node, 'minimum')) constraint.minimum = finiteSchemaNumber(node.minimum, 'minimum');
      if (Object.hasOwn(node, 'maximum')) constraint.maximum = finiteSchemaNumber(node.maximum, 'maximum');
      if (constraint.minimum !== undefined && constraint.maximum !== undefined
        && constraint.minimum > constraint.maximum) throw new TypeError('Provider numeric bounds conflict');
    }
    if (['minItems', 'maxItems'].some(key => Object.hasOwn(node, key))) {
      if (node.type !== 'array') throw new TypeError('Provider item bounds require an array schema');
      if (Object.hasOwn(node, 'minItems')) constraint.minItems = boundedSchemaInteger(node.minItems, 'minItems');
      if (Object.hasOwn(node, 'maxItems')) constraint.maxItems = boundedSchemaInteger(node.maxItems, 'maxItems');
      if (constraint.minItems !== undefined && constraint.maxItems !== undefined
        && constraint.minItems > constraint.maxItems) throw new TypeError('Provider item bounds conflict');
    }
    if (Object.hasOwn(node, 'uniqueItems')) {
      if (node.type !== 'array' || typeof node.uniqueItems !== 'boolean') {
        throw new TypeError('Provider uniqueItems requires an array schema and boolean value');
      }
      if (node.uniqueItems) constraint.uniqueItems = true;
    }
    if (['minProperties', 'maxProperties'].some(key => Object.hasOwn(node, key))) {
      if (node.type !== 'object') throw new TypeError('Provider property bounds require an object schema');
      if (Object.hasOwn(node, 'minProperties')) {
        constraint.minProperties = boundedSchemaInteger(node.minProperties, 'minProperties');
      }
      if (Object.hasOwn(node, 'maxProperties')) {
        constraint.maxProperties = boundedSchemaInteger(node.maxProperties, 'maxProperties');
      }
      if (constraint.minProperties !== undefined && constraint.maxProperties !== undefined
        && constraint.minProperties > constraint.maxProperties) throw new TypeError('Provider property bounds conflict');
    }
    if (Object.keys(constraint).length > 1) constraints.push(constraint);
    if (constraints.length > 512) throw new TypeError('Provider schema has too many runtime constraints');
    const properties = node.properties;
    if (properties !== undefined) {
      if (properties === null || Array.isArray(properties) || typeof properties !== 'object') {
        throw new TypeError('Provider schema properties must be an object');
      }
      for (const [name, child] of Object.entries(properties)) {
        pending.push({ node: child, path: [...frame.path, name], depth: frame.depth + 1 });
      }
    }
    if (node.items !== undefined) pending.push({ node: node.items, path: [...frame.path, '*'], depth: frame.depth + 1 });
    if (node.oneOf !== undefined) {
      if (!Array.isArray(node.oneOf)) throw new TypeError('Provider schema oneOf must be an array');
      if (node.oneOf.some(branch => schemaHasProjectedConstraints(branch))) {
        throw new TypeError('Provider bounds inside oneOf cannot be projected safely');
      }
      for (const branch of node.oneOf) pending.push({ node: branch, path: frame.path, depth: frame.depth + 1 });
    }
  }
  return constraints;
}

function boundedSchemaInteger(value: JsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Provider schema ${label} must be a non-negative safe integer`);
  }
  return value;
}

function finiteSchemaNumber(value: JsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Provider schema ${label} must be finite`);
  }
  return value;
}

function schemaHasProjectedConstraints(value: JsonValue): boolean {
  const pending: JsonValue[] = [value];
  let visited = 0;
  while (pending.length > 0 && visited < 20_000) {
    const current = pending.pop()!;
    visited += 1;
    if (current === null || Array.isArray(current) || typeof current !== 'object') continue;
    const node = current as Record<string, JsonValue>;
    if (hasProjectedProviderConstraint(node)) return true;
    const properties = node.properties;
    if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
      pending.push(...Object.values(properties));
    }
    if (node.items !== undefined) pending.push(node.items);
    if (Array.isArray(node.oneOf)) pending.push(...node.oneOf);
  }
  return pending.length > 0;
}

function projectProviderSchemaForDsh(schema: JsonValue, depth = 0): JsonValue {
  if (depth > 64) throw new TypeError('Provider schema nesting exceeds its configured limit');
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const node = schema as Record<string, JsonValue>;
  const projected: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(node)) {
    if (PROJECTED_PROVIDER_CONSTRAINTS.has(key)) continue;
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      projected[key] = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertySchema]) => [
          propertyName,
          projectProviderSchemaForDsh(propertySchema, depth + 1),
        ]),
      );
    } else if (key === 'items') {
      projected[key] = projectProviderSchemaForDsh(value, depth + 1);
    } else if (key === 'oneOf' && Array.isArray(value)) {
      projected[key] = value.map(branch => projectProviderSchemaForDsh(branch, depth + 1));
    } else {
      projected[key] = value;
    }
  }
  return projected;
}

/** Match projected keywords only on schema nodes, never on user property names or JSON values. */
function hasProjectedProviderConstraint(node: Record<string, JsonValue>): boolean {
  for (const key of PROJECTED_PROVIDER_CONSTRAINTS) {
    if (Object.hasOwn(node, key) && (key !== 'uniqueItems' || node.uniqueItems === true)) return true;
  }
  return false;
}

function validateProviderConstraints(
  argumentsValue: Record<string, JsonValue>,
  constraints: readonly ProviderInputConstraint[],
): void {
  for (const constraint of constraints) {
    let values: unknown[] = [argumentsValue];
    for (const segment of constraint.path) {
      const next: unknown[] = [];
      for (const value of values) {
        if (segment === '*') {
          if (Array.isArray(value)) next.push(...value);
          continue;
        }
        if (value !== null && typeof value === 'object' && !Array.isArray(value)
          && Object.hasOwn(value, segment)) {
          next.push((value as Record<string, unknown>)[segment]);
        }
      }
      values = next;
    }
    for (const value of values) {
      if (value === undefined) continue;
      let valid = true;
      if (constraint.pattern !== undefined) valid = typeof value === 'string' && constraint.regex!.test(value);
      if (constraint.minLength !== undefined || constraint.maxLength !== undefined) {
        const length = typeof value === 'string' ? [...value].length : -1;
        valid = valid && length >= (constraint.minLength ?? 0)
          && (constraint.maxLength === undefined || length <= constraint.maxLength);
      }
      if (constraint.minimum !== undefined || constraint.maximum !== undefined) {
        const numeric = typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
        valid = valid && numeric >= (constraint.minimum ?? Number.NEGATIVE_INFINITY)
          && (constraint.maximum === undefined || numeric <= constraint.maximum);
      }
      if (constraint.minItems !== undefined || constraint.maxItems !== undefined) {
        const length = Array.isArray(value) ? value.length : -1;
        valid = valid && length >= (constraint.minItems ?? 0)
          && (constraint.maxItems === undefined || length <= constraint.maxItems);
      }
      if (constraint.uniqueItems === true) {
        const items = Array.isArray(value) ? value : [];
        valid = valid && Array.isArray(value)
          && new Set(items.map(item => canonicalJson(item))).size === items.length;
      }
      if (constraint.minProperties !== undefined || constraint.maxProperties !== undefined) {
        const count = value !== null && typeof value === 'object' && !Array.isArray(value)
          ? Object.keys(value).length : -1;
        valid = valid && count >= (constraint.minProperties ?? 0)
          && (constraint.maxProperties === undefined || count <= constraint.maxProperties);
      }
      if (!valid) {
        const field = constraint.path.filter(segment => segment !== '*').join('.') || 'arguments';
        throw new TypeError(`Provider argument ${field} violates its configured bounds or uniqueness`);
      }
    }
  }
}

/** Build a stable, short tool name that cannot alias another binding/tool pair. */
function publicToolName(bindingId: string, toolId: string): string {
  const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 12) || 'tool';
  const hash = createHash('sha256').update(bindingId).update('\0').update(toolId).digest('hex').slice(0, 12);
  return `tool_provider_${slug(bindingId)}_${slug(toolId)}_${hash}`;
}

/** Require the DSH Agent's live Session identity rather than trusting model arguments. */
function activeSessionId(execution: ToolRunContext): string {
  const id = execution.agent?.session.id;
  if (id === undefined || id === null || String(id).length === 0) {
    throw new Error('Write tools require the active Navigator Session');
  }
  return String(id);
}

/** Bound identifiers used in backend path segments and durable receipts. */
function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

/** Bound text accepted from canonical provider metadata and responses. */
function boundedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

/** Require a plain JSON object at each untrusted bridge boundary. */
function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Freeze model arguments to a bounded lossless JSON object before approval or dispatch. */
function parseArguments(value: unknown): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !isJsonValue(value)) {
    throw new TypeError('Provider tool arguments must be a JSON object');
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_ARGUMENT_BYTES) {
    throw new TypeError('Provider tool arguments exceed their configured size limit');
  }
  return structuredClone(value) as Record<string, JsonValue>;
}

/** Preserve native cancellation semantics without exposing an arbitrary abort reason. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
}
