// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator canonical tool providers                          │
// │ Role: Register configured tool.provider.v1 tools through Work API.  │
// │ 模块职责：通过 Work API 注册已配置的 tool.provider.v1 工具。          │
// └─────────────────────────────────────────────────────────────────────┘

import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools';
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { isJsonValue, snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { WorkAssistantBridge } from './work-tools.js';

const MAX_PROVIDER_COUNT = 128;
const MAX_TOOL_COUNT = 512;
const MAX_SCHEMA_BYTES = 64_000;
const MAX_ARGUMENT_BYTES = 256_000;
const MAX_RESULT_BYTES = 2_000_000;
const MAX_CONTENT_BLOCKS = 512;

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
}

interface ProviderBinding {
  readonly bindingId: string;
  readonly capabilityId: 'tool.provider.v1';
}

interface ProviderTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly readOnly: boolean;
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
 * on DSH's existing ToolRuntime. Write calls require Navigator approval and
 * a durable operation receipt before reaching the canonical provider.
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
  const rawBindings = await options.bridge.request('/tool-providers', 'GET', undefined, signal);
  const bindings = parseBindings(rawBindings);
  if (bindings.length > MAX_PROVIDER_COUNT) throw new TypeError('Tool provider catalog exceeds its configured limit');

  const registrations: Array<() => void> = [];
  const names = new Set<string>();
  let registeredCount = 0;
  try {
    for (const binding of bindings) {
      const rawCatalog = await options.bridge.request(
        `/tool-providers/${encodeURIComponent(binding.bindingId)}/tools`, 'GET', undefined, signal,
      );
      const tools = parseTools(rawCatalog, binding.bindingId);
      for (const tool of tools) {
        registeredCount += 1;
        if (registeredCount > MAX_TOOL_COUNT) throw new TypeError('Tool provider catalog exceeds its configured tool limit');
        const name = publicToolName(binding.bindingId, tool.id);
        if (names.has(name)) throw new TypeError('Tool provider names collide after normalization');
        names.add(name);
        registrations.push(ctx.tools.register(createDefinition(options, binding, tool, name)));
      }
    }
  } catch (error: unknown) {
    for (const unregister of registrations.reverse()) unregister();
    throw error;
  }

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const unregister of registrations.reverse()) unregister();
  };
  ctx.effect(() => dispose, 'navigator.toolProviders');
  return dispose;
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
      if (tool.readOnly) {
        const rawResult = await callProvider(options.bridge, binding, tool, argumentsValue, execution.signal);
        return successfulResult(parseProviderResult(rawResult));
      }

      // Writes are always human-gated against the actual active DSH Session.
      const sessionId = activeSessionId(execution);
      const taskId = options.taskIdForSession(sessionId);
      if (!taskId) throw new Error('Write tools require an active durable Navigator task');
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

/** Create an idempotent task/call receipt before the provider can mutate state. */
async function beginOperation(
  bridge: ToolProviderRegistrationOptions['bridge'],
  execution: ToolRunContext,
  taskId: string,
  binding: ProviderBinding,
  tool: ProviderTool,
  args: Record<string, JsonValue>,
): Promise<OperationReceipt> {
  const digest = createHash('sha256').update(taskId).update('\0').update(String(execution.callId)).digest('hex');
  const response = await bridge.mutate(execution, '/operations', 'POST', {
    idempotencyKey: `tool-provider-v1:${digest}`,
    operationType: 'tool.provider.v1',
    taskId,
    target: `${binding.bindingId}/${tool.id}`,
    request: { bindingId: binding.bindingId, toolId: tool.id, arguments: args },
  }, true);
  const wrapper = objectValue(response.operation ?? response, 'operation receipt');
  const id = safeIdentifier(wrapper.id, 'operation receipt id');
  if (wrapper.status !== 'started' && wrapper.status !== 'uncertain' && wrapper.status !== 'verified') {
    throw new TypeError('Operation receipt has an invalid status');
  }
  if (typeof response.duplicate !== 'boolean') throw new TypeError('Operation receipt omitted duplicate status');
  return { id, status: wrapper.status, duplicate: response.duplicate };
}

/** Record an unknown remote outcome on a fresh bounded signal, even after caller cancellation. */
async function markUncertain(bridge: ToolProviderRegistrationOptions['bridge'], operationId: string): Promise<void> {
  try {
    await bridge.request(`/operations/${encodeURIComponent(operationId)}`, 'PATCH', {
      status: 'uncertain', evidence: { outcome: 'unknown_after_provider_call' },
    }, AbortSignal.timeout(5_000));
  } catch {
    // A remaining started receipt still blocks replay; recovery can reconcile it later.
  }
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
    bindings.push({ bindingId, capabilityId: 'tool.provider.v1' });
  }
  return bindings;
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
    assertObjectJsonSchema(schema);
    // The DSH ToolSchema uses an index-signature type; this validated JSON object is equivalent at runtime.
    return {
      id,
      name,
      description,
      inputSchema: structuredClone(schema) as unknown as Record<string, unknown>,
      readOnly: row.readOnly,
    };
  });
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
