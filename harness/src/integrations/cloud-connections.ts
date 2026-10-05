// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Official Cloud Connections                        │
// │ Role: Load scoped MCP profiles and readonly Google Cloud CLI tools.  │
// │ 模块职责：加载官方 MCP 连接配置与只读 Google Cloud CLI 工具。             │
// └─────────────────────────────────────────────────────────────────────┘

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';

/** Official publisher and source details retained beside discovered MCP schemas. */
export interface OfficialSource {
  readonly publisher: string;
  readonly endpoint: string;
  readonly documentation: string;
}

/** MCP profile using a remote Streamable HTTP endpoint. */
export interface RemoteMcpProfile {
  readonly kind: 'mcp';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly serverName: string;
  readonly source: OfficialSource;
  readonly connection: {
    readonly transport: 'streamable-http';
    readonly url: string;
    readonly headerEnvRefs?: Readonly<Record<string, string>>;
  };
  /** Empty means no tool is admitted; tool names are the DSH-qualified names. */
  readonly allowedTools?: readonly string[];
}

/** MCP profile using a locally installed stdio server and named env references. */
export interface StdioMcpProfile {
  readonly kind: 'mcp';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly serverName: string;
  readonly source: OfficialSource;
  readonly connection: {
    readonly transport: 'stdio';
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly envRefs?: readonly string[];
  };
  readonly allowedTools?: readonly string[];
  readonly readOnly?: boolean;
  readonly namespaces?: readonly string[];
}

/** Readonly Google Cloud CLI profile; allowed project ids are operator supplied. */
export interface GcloudReadonlyProfile {
  readonly kind: 'gcloud-cli';
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly source: OfficialSource;
  readonly allowedProjectIds: readonly string[];
}

/** One supported official connection record. */
export type CloudConnectionProfile = RemoteMcpProfile | StdioMcpProfile | GcloudReadonlyProfile;

/** Versioned bundle shape for official connection profiles. */
export interface CloudConnectionConfig {
  readonly schemaVersion: 1;
  readonly profiles: readonly CloudConnectionProfile[];
}

/** Health state that avoids exposing auth values or raw connection errors. */
export type CloudConnectionStatus =
  | 'disabled'
  | 'missing-credential'
  | 'waiting-for-target'
  | 'connecting'
  | 'available'
  | 'degraded';

/** Public registry view for one loaded connector, including live tool descriptions. */
export interface CloudConnectionHealth {
  readonly id: string;
  readonly name: string;
  readonly kind: CloudConnectionProfile['kind'];
  readonly status: CloudConnectionStatus;
  readonly source: OfficialSource;
  readonly description: string;
  readonly tools: readonly CloudToolDescription[];
  readonly lastSuccessAt?: string;
  readonly lastFailureAt?: string;
  readonly lastFailureCode?: string;
}

/** DSH tool description copied from the live tool registry. */
export interface CloudToolDescription {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

/** Host registry exposed through `ctx.cloudConnections`. */
export interface CloudConnectionRegistry {
  /** Return a credential-free health snapshot for every bundled profile. */
  list(): readonly CloudConnectionHealth[];
  /** Read one credential-free profile health snapshot. */
  get(id: string): CloudConnectionHealth | undefined;
  /** Return only tools with a source-backed readonly contract for workflow use. */
  workflowReadonlyTools(id: string): readonly string[];
  /** Return the configured project ids that a workflow may bind to. */
  workflowReadonlyProjectIds(id: string): readonly string[];
}

interface MutableHealth {
  profile: CloudConnectionProfile;
  status: CloudConnectionStatus;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureCode?: string;
}

/** Model-call names that the Google Cloud CLI adapter can execute. */
export type GcloudReadonlyOperation = 'projects.describe' | 'services.list' | 'compute.instances.list';

/** Configuration passed to a testable, structured-argv gcloud runner. */
export interface GcloudReadonlyConfig {
  readonly allowedProjectIds: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/** Structured command runner contract; no shell string is accepted. */
export type GcloudCommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly maxOutputBytes: number; readonly signal: AbortSignal },
) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const GOOGLE_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const HF_PREFIX = 'mcp__huggingface__';
const OFFICIAL_SOURCES: Readonly<Record<string, OfficialSource>> = Object.freeze({
  'microsoft-learn': {
    publisher: 'Microsoft', endpoint: 'https://learn.microsoft.com/api/mcp',
    documentation: 'https://learn.microsoft.com/en-us/training/support/mcp',
  },
  'google-developer-knowledge': {
    publisher: 'Google', endpoint: 'https://developerknowledge.googleapis.com/mcp',
    documentation: 'https://developers.google.com/knowledge/reference/mcp',
  },
  huggingface: {
    publisher: 'Hugging Face', endpoint: 'https://huggingface.co/mcp',
    documentation: 'https://huggingface.co/docs/hub/agents-mcp',
  },
  azure: {
    publisher: 'Microsoft', endpoint: 'https://www.npmjs.com/package/@azure/mcp',
    documentation: 'https://learn.microsoft.com/en-us/azure/developer/azure-mcp-server/tools/',
  },
  'google-cloud-readonly': {
    publisher: 'Google', endpoint: 'https://cloud.google.com/sdk/gcloud',
    documentation: 'https://cloud.google.com/sdk/gcloud/reference',
  },
});

declare module '@deepseek-ai/cordis' {
  interface Context {
    cloudConnections: CloudConnectionRegistry;
  }
}

/**
 * Load the versioned official profile bundle shipped with Navigator.
 * @returns Validated profile JSON. Secret values are never read from this file.
 */
export async function loadCloudConnectionConfig(): Promise<CloudConnectionConfig> {
  const file = new URL('../../presets/cyrene-navigator/cloud-connections.json', import.meta.url);
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  return validateCloudConnectionConfig(parsed);
}

/**
 * Validate the profile envelope and its static security invariants.
 * @param input - Untrusted JSON value from an operator-managed profile file.
 * @returns A copied version-1 configuration with validated endpoints and argv.
 * @throws TypeError when a profile can widen its authority or execute an unscoped command.
 */
export function validateCloudConnectionConfig(input: unknown): CloudConnectionConfig {
  const root = record(input, 'cloud connection config');
  if (root.schemaVersion !== 1 || !Array.isArray(root.profiles)) throw new TypeError('Invalid cloud connection profile version');
  const profiles = root.profiles.map((value) => {
    const row = record(value, 'cloud connection profile');
    const id = stringValue(row.id, 'profile id');
    const name = stringValue(row.name, `${id}.name`);
    const description = stringValue(row.description, `${id}.description`, true);
    const source = validateSource(row.source, id);
    if (typeof row.enabled !== 'boolean') throw new TypeError(`${id}.enabled must be boolean`);
    if (row.kind === 'mcp') {
      const serverName = stringValue(row.serverName, `${id}.serverName`);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) throw new TypeError(`${id}.serverName is invalid`);
      const connection = record(row.connection, `${id}.connection`);
      const allowedTools = optionalStringArray(row.allowedTools, `${id}.allowedTools`);
      if (connection.transport === 'streamable-http') {
        const url = stringValue(connection.url, `${id}.connection.url`);
        assertAllowedEndpoint(url, source.endpoint, id);
        const headerEnvRefs = optionalStringRecord(connection.headerEnvRefs, `${id}.connection.headerEnvRefs`);
        if (id === 'huggingface' && row.enabled && (allowedTools === undefined || allowedTools.length === 0)) {
          throw new TypeError('Hugging Face MCP must declare an explicit non-empty tool allowlist before it can load');
        }
        return {
          kind: 'mcp', id, name, description, enabled: row.enabled, serverName, source,
          connection: { transport: 'streamable-http', url, ...(headerEnvRefs === undefined ? {} : { headerEnvRefs }) },
          ...(allowedTools === undefined ? {} : { allowedTools }),
        } satisfies RemoteMcpProfile;
      }
      if (connection.transport === 'stdio') {
        const command = stringValue(connection.command, `${id}.connection.command`);
        const args = stringArray(connection.args, `${id}.connection.args`);
        const envRefs = optionalStringArray(connection.envRefs, `${id}.connection.envRefs`);
        if (id !== 'azure') {
          if (process.env.NODE_ENV !== 'test') throw new TypeError(`${id} is not an approved stdio profile`);
          return {
            kind: 'mcp', id, name, description, enabled: row.enabled, serverName, source,
            connection: { transport: 'stdio', command, args, ...(envRefs === undefined ? {} : { envRefs }) },
            ...(allowedTools === undefined ? {} : { allowedTools }),
          } satisfies StdioMcpProfile;
        }
        if (row.readOnly !== true) throw new TypeError('Azure MCP must be configured read-only');
        const namespaces = stringArray(connection.namespaces ?? row.namespaces, `${id}.namespaces`);
        if (namespaces.length === 0 || namespaces.some(namespace => !['compute', 'monitor'].includes(namespace))) {
          throw new TypeError('Azure MCP namespaces must be a non-empty subset of compute and monitor');
        }
        assertAzureArgv(command, args, namespaces);
        return {
          kind: 'mcp', id, name, description, enabled: row.enabled, serverName, source,
          connection: { transport: 'stdio', command, args, ...(envRefs === undefined ? {} : { envRefs }) },
          readOnly: true, namespaces,
          ...(allowedTools === undefined ? {} : { allowedTools }),
        } satisfies StdioMcpProfile;
      }
      throw new TypeError(`${id}.connection.transport is unsupported`);
    }
    if (row.kind === 'gcloud-cli') {
      if (id !== 'google-cloud-readonly') throw new TypeError(`${id} is not an approved gcloud profile`);
      const allowedProjectIds = stringArray(row.allowedProjectIds, `${id}.allowedProjectIds`);
      if (allowedProjectIds.some(projectId => !GOOGLE_PROJECT_ID.test(projectId))) {
        throw new TypeError('gcloud project ids must be valid explicit project identifiers');
      }
      return { kind: 'gcloud-cli', id, name, description, enabled: row.enabled, source, allowedProjectIds } satisfies GcloudReadonlyProfile;
    }
    throw new TypeError(`${id}.kind is unsupported`);
  });
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new TypeError('Duplicate cloud profile id');
  if (new Set(profiles.filter(profile => profile.kind === 'mcp').map(profile => profile.serverName)).size
    !== profiles.filter(profile => profile.kind === 'mcp').length) throw new TypeError('Duplicate MCP server name');
  return { schemaVersion: 1, profiles };
}

/**
 * Register official cloud connectors and expose health/tool metadata on Context.
 * MCP server configs are built from environment references at startup; credential values are not retained in the registry.
 * @param ctx - Headless Cordis context with ToolRuntime mounted.
 * @param config - Versioned connector profile list.
 * @returns Live profile registry; MCP tools are registered directly with DSH.
 */
export async function registerCloudConnections(
  ctx: Context,
  config?: CloudConnectionConfig,
): Promise<CloudConnectionRegistry> {
  const validated = validateCloudConnectionConfig(config ?? await loadCloudConnectionConfig());
  const entries = new Map<string, MutableHealth>();
  const allowedHfTools = new Set<string>();
  const refresh = (): void => {
    const schemas = ctx.tools.schemas();
    for (const [id, entry] of entries) {
      if (entry.profile.kind === 'gcloud-cli') continue;
      const prefix = `mcp__${entry.profile.serverName}__`;
      const tools = schemas.filter(schema => schema.name.startsWith(prefix));
      if (entry.status !== 'disabled' && entry.status !== 'missing-credential' && entry.status !== 'waiting-for-target') {
        entry.status = tools.length > 0 ? 'available' : 'connecting';
      }
      if (id === 'huggingface') {
        allowedHfTools.clear();
        const allowed = new Set(entry.profile.allowedTools ?? []);
        for (const schema of tools) {
          if (allowed.has(schema.name) || allowed.has(schema.name.slice(prefix.length))) allowedHfTools.add(schema.name);
        }
        if ((entry.profile.allowedTools ?? []).some(name => !allowedHfTools.has(name) && !allowedHfTools.has(`${prefix}${name}`))) {
          entry.status = tools.length > 0 ? 'degraded' : entry.status;
        }
      }
    }
  };

  for (const profile of validated.profiles) {
    const entry: MutableHealth = { profile, status: profile.enabled ? 'connecting' : 'disabled' };
    entries.set(profile.id, entry);
  }
  const registry: CloudConnectionRegistry = Object.freeze({
    list: () => Object.freeze([...entries.values()].map(entry => healthSnapshot(ctx, entry))),
    get: (id: string) => {
      const entry = entries.get(id);
      return entry === undefined ? undefined : healthSnapshot(ctx, entry);
    },
    workflowReadonlyTools: (id: string) => {
      const entry = entries.get(id);
      if (entry === undefined || entry.status !== 'available') return [];
      const profile = entry.profile;
      if (profile.id === 'huggingface') return [];
      if (profile.kind === 'mcp' && (profile.id === 'microsoft-learn' || profile.id === 'google-developer-knowledge')) {
        return discoveredToolNames(ctx, profile);
      }
      if (profile.kind === 'mcp' && profile.id === 'azure' && 'readOnly' in profile && 'namespaces' in profile
        && profile.connection.transport === 'stdio'
        && profile.readOnly === true && profile.namespaces !== undefined && profile.namespaces.length > 0
        && profile.namespaces.every(namespace => ['compute', 'monitor'].includes(namespace))) {
        return discoveredToolNames(ctx, profile);
      }
      if (profile.id === 'google-cloud-readonly' && profile.kind === 'gcloud-cli'
        && ctx.tools.get('gcloud_readonly') !== undefined) return ['gcloud_readonly'];
      return [];
    },
    workflowReadonlyProjectIds: (id: string) => {
      const entry = entries.get(id);
      if (entry?.profile.id !== 'google-cloud-readonly' || entry.profile.kind !== 'gcloud-cli'
        || entry.status !== 'available') return [];
      return [...entry.profile.allowedProjectIds];
    },
  });
  ctx.provide('cloudConnections', registry);

  // ── Phase 1: Enforce the Hugging Face allowlist after every other tool policy. ──
  const disposeHfGuard = ctx.tools.guard(execution => {
    if (!execution.name.startsWith(HF_PREFIX)) return undefined;
    return allowedHfTools.has(execution.name) ? undefined : 'Hugging Face tool is not in the configured allowlist';
  });
  ctx.effect(() => disposeHfGuard, 'navigator.cloudConnections.huggingFaceGuard');

  // ── Phase 2: Load MCP servers, resolving only explicitly named env references. ──
  for (const entry of entries.values()) {
    const profile = entry.profile;
    if (!profile.enabled) continue;
    if (profile.kind === 'gcloud-cli') {
      registerGcloudProfile(ctx, entry, profile);
      continue;
    }
    const serverConfig = buildMcpConfig(profile, process.env);
    if ('missing' in serverConfig) {
      entry.status = 'missing-credential';
      continue;
    }
    if (profile.id === 'huggingface' && (profile.allowedTools?.length ?? 0) === 0) {
      entry.status = 'waiting-for-target';
      continue;
    }
    try {
      await ctx.plugin(McpClient, serverConfig.config);
      refresh();
    } catch (error: unknown) {
      entry.status = 'degraded';
      entry.lastFailureAt = new Date().toISOString();
      entry.lastFailureCode = stableFailureCode(error);
      ctx.logger.warn(`cloud connection ${profile.id} failed to initialize (${entry.lastFailureCode})`);
    }
  }

  // ── Phase 3: Keep discovery and health aligned with DSH's live tool registry. ──
  ctx.on('tools/change', () => { refresh(); });
  ctx.on('tools/result', (execution, result) => {
    const match = [...entries.values()].find(({ profile }) => profile.kind === 'mcp'
      && execution.name.startsWith(`mcp__${profile.serverName}__`));
    if (match === undefined) return;
    if (result.isError) {
      match.status = 'degraded';
      match.lastFailureAt = new Date().toISOString();
      match.lastFailureCode = 'MCP_TOOL_ERROR';
    } else {
      match.status = 'available';
      match.lastSuccessAt = new Date().toISOString();
      match.lastFailureCode = undefined;
    }
  });
  refresh();
  return registry;
}

/**
 * Build argv for one finite, read-only gcloud operation.
 * @param operation - Fixed operation selector received from the model.
 * @param projectId - Project identity that must be explicitly allowlisted.
 * @param config - Operator-owned allowlist and process bounds.
 * @returns Deterministic argv for `gcloud`; no shell syntax is interpreted.
 * @throws Error when the operation, target, or output budget is outside the allowlist.
 */
export function buildGcloudReadonlyArgs(
  operation: GcloudReadonlyOperation,
  projectId: string,
  config: GcloudReadonlyConfig,
): string[] {
  if (!GOOGLE_PROJECT_ID.test(projectId) || !config.allowedProjectIds.includes(projectId)) {
    throw new Error('Google Cloud project is not in the configured allowlist');
  }
  switch (operation) {
    case 'projects.describe':
      return ['projects', 'describe', projectId, '--format=json(projectId,name,lifecycleState)'];
    case 'services.list':
      return ['services', 'list', '--enabled', `--project=${projectId}`, '--format=json(config.name,state)'];
    case 'compute.instances.list':
      return ['compute', 'instances', 'list', `--project=${projectId}`, '--format=json(name,zone,status,machineType)'];
    default:
      throw new Error('Google Cloud operation is not in the readonly allowlist');
  }
}

/**
 * Run an allowlisted gcloud operation with structured argv and a bounded child process.
 * @param operation - Fixed readonly operation selector.
 * @param projectId - Explicit project id passed by a caller and checked against config.
 * @param config - Trusted operator allowlist and resource limits.
 * @param signal - Caller-owned cancellation signal.
 * @param runner - Optional structured test seam.
 * @returns Bounded JSON output from the gcloud process.
 */
export async function runGcloudReadonly(
  operation: GcloudReadonlyOperation,
  projectId: string,
  config: GcloudReadonlyConfig,
  signal: AbortSignal,
  runner: GcloudCommandRunner = runGcloudCommand,
): Promise<string> {
  const args = buildGcloudReadonlyArgs(operation, projectId, config);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('Invalid gcloud timeout');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 4_000_000) throw new Error('Invalid gcloud output limit');
  signal.throwIfAborted();
  return runner('gcloud', args, { timeoutMs, maxOutputBytes, signal });
}

/** Create a DSH tool only when explicit Google project targets are configured. */
function registerGcloudProfile(ctx: Context, entry: MutableHealth, profile: GcloudReadonlyProfile): void {
  if (profile.allowedProjectIds.length === 0) {
    entry.status = 'waiting-for-target';
    return;
  }
  const config: GcloudReadonlyConfig = { allowedProjectIds: profile.allowedProjectIds };
  const unregister = ctx.tools.register(defineTool({
    name: 'gcloud_readonly',
    description: 'Run one allowlisted, read-only Google Cloud inventory query for a configured project.',
    parameters: {
      operation: {
        type: 'string', enum: ['projects.describe', 'services.list', 'compute.instances.list'], required: true,
        description: 'One fixed read-only operation.',
      },
      projectId: { type: 'string', required: true, description: 'An explicitly configured Google Cloud project id.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, execution) {
      const request = record(args, 'gcloud readonly arguments');
      const operation = stringValue(request.operation, 'gcloud operation') as GcloudReadonlyOperation;
      const projectId = stringValue(request.projectId, 'gcloud project id');
      return runGcloudReadonly(operation, projectId, config, execution.signal);
    },
  }));
  ctx.effect(() => unregister, 'navigator.gcloudReadonly');
  entry.status = 'available';
}

/** Resolve auth at runtime and construct the pinned MCP client config. */
function buildMcpConfig(
  profile: RemoteMcpProfile | StdioMcpProfile,
  environment: NodeJS.ProcessEnv,
): { readonly config: McpClient.Config } | { readonly missing: true } {
  if (profile.connection.transport === 'streamable-http') {
    const headers: Record<string, string> = {};
    for (const [header, envRef] of Object.entries(profile.connection.headerEnvRefs ?? {})) {
      const value = environment[envRef];
      if (!value) return { missing: true };
      headers[header] = value;
    }
    return {
      config: {
        transport: 'streamable-http', serverName: profile.serverName, url: profile.connection.url, headers,
        toolCallTimeoutMs: 30_000, failOnStartupError: false,
      },
    };
  }
  const env: Record<string, string> = {};
  for (const envRef of profile.connection.envRefs ?? []) {
    const value = environment[envRef];
    if (value !== undefined) env[envRef] = value;
  }
  return {
    config: {
      transport: 'stdio', serverName: profile.serverName,
      command: profile.connection.command, args: [...profile.connection.args], env,
      cwd: profile.connection.cwd ?? process.cwd(), toolCallTimeoutMs: 30_000, failOnStartupError: false,
    },
  };
}

/** Bounded child-process adapter that explicitly disables shell parsing. */
function runGcloudCommand(
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly maxOutputBytes: number; readonly signal: AbortSignal },
): Promise<string> {
  if (basename(command) !== 'gcloud') return Promise.reject(new Error('Only the gcloud executable is permitted'));
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes,
      windowsHide: true, shell: false, signal: options.signal,
    }, (error, stdout) => {
      if (error) {
        reject(new Error(error.killed ? 'Google Cloud readonly command timed out' : 'Google Cloud readonly command failed'));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Produce live tool descriptions and copied health without exposing headers. */
function healthSnapshot(ctx: Context, entry: MutableHealth): CloudConnectionHealth {
  const prefix = entry.profile.kind === 'mcp' ? `mcp__${entry.profile.serverName}__` : undefined;
  const tools: CloudToolDescription[] = prefix === undefined
    ? ctx.tools.schemas().filter(schema => schema.name === 'gcloud_readonly').map(copyToolSchema)
    : ctx.tools.schemas().filter(schema => schema.name.startsWith(prefix)).map(copyToolSchema);
  return Object.freeze({
    id: entry.profile.id,
    name: entry.profile.name,
    kind: entry.profile.kind,
    status: entry.status,
    source: { ...entry.profile.source },
    description: entry.profile.description,
    tools: Object.freeze(tools),
    ...(entry.lastSuccessAt === undefined ? {} : { lastSuccessAt: entry.lastSuccessAt }),
    ...(entry.lastFailureAt === undefined ? {} : { lastFailureAt: entry.lastFailureAt }),
    ...(entry.lastFailureCode === undefined ? {} : { lastFailureCode: entry.lastFailureCode }),
  });
}

/** Return the live DSH-qualified schema names for one validated profile. */
function discoveredToolNames(ctx: Context, profile: RemoteMcpProfile | StdioMcpProfile): readonly string[] {
  const prefix = `mcp__${profile.serverName}__`;
  return ctx.tools.schemas().filter(schema => schema.name.startsWith(prefix)).map(schema => schema.name);
}

/** Copy a schema through its public model-facing fields only. */
function copyToolSchema(schema: { readonly name: string; readonly description: string; readonly parameters: unknown }): CloudToolDescription {
  return { name: schema.name, description: schema.description, parameters: structuredClone(schema.parameters) };
}

/** Validate official source metadata and reject accidental credential-bearing URLs. */
function validateSource(input: unknown, id: string): OfficialSource {
  const source = record(input, `${id}.source`);
  const publisher = stringValue(source.publisher, `${id}.source.publisher`);
  const endpoint = stringValue(source.endpoint, `${id}.source.endpoint`);
  const documentation = stringValue(source.documentation, `${id}.source.documentation`);
  for (const url of [endpoint, documentation]) {
    const parsed = new URL(url);
    const loopbackTestEndpoint = process.env.NODE_ENV === 'test' && parsed.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
    if ((!loopbackTestEndpoint && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new TypeError(`${id} source URLs must be credential-free HTTPS URLs`);
    }
  }
  const official = OFFICIAL_SOURCES[id];
  if (official !== undefined && (publisher !== official.publisher || endpoint !== official.endpoint || documentation !== official.documentation)) {
    throw new TypeError(`${id} source metadata does not match its official publisher`);
  }
  if (official === undefined && process.env.NODE_ENV !== 'test') throw new TypeError(`${id} is not a bundled official connection profile`);
  return { publisher, endpoint, documentation };
}

function assertAllowedEndpoint(url: string, officialEndpoint: string, id: string): void {
  const parsed = new URL(url);
  const official = new URL(officialEndpoint);
  const loopbackTestEndpoint = process.env.NODE_ENV === 'test' && parsed.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if ((!loopbackTestEndpoint && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.hash
    || parsed.origin !== official.origin || parsed.pathname !== official.pathname) {
    if (!loopbackTestEndpoint || parsed.username || parsed.password || parsed.hash) {
      throw new TypeError(`${id} endpoint does not match its official HTTPS source`);
    }
  }
  if (id === 'huggingface' && parsed.search && parsed.search !== '?login') {
    throw new TypeError('Hugging Face MCP accepts only its official login query option');
  }
  if (id !== 'huggingface' && parsed.search) throw new TypeError(`${id} endpoint must not contain a query string`);
}

function assertAzureArgv(command: string, args: readonly string[], namespaces: readonly string[]): void {
  if (command !== 'npm') throw new TypeError('Azure MCP must use the official preinstalled @azure/mcp npm package');
  const expected = [
    'exec', '--no', '--package=@azure/mcp@3.0.0-beta.49', '--', 'azmcp', 'server', 'start', '--mode', 'namespace',
    ...namespaces.flatMap(namespace => ['--namespace', namespace]), '--read-only',
  ];
  if (args.length !== expected.length || args.some((item, index) => item !== expected[index])) {
    throw new TypeError('Azure MCP argv must use only the pinned readonly namespace invocation');
  }
}

function stableFailureCode(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'CONNECTION_ABORTED';
  return 'CONNECTION_START_FAILED';
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) throw new TypeError(`${label} must be a string`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  return value === undefined ? undefined : stringArray(value, label);
}

function optionalStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const row = record(value, label);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(row)) {
    if (!/^[A-Za-z0-9-]+$/.test(key)) throw new TypeError(`${label} contains an invalid header name`);
    result[key] = stringValue(item, `${label}.${key}`);
  }
  return result;
}
