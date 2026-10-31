// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Headless Cloud Executor Application Factory       │
// │ Role: Bootstrap and export executor app runtime within Harness.     │
// │ 模块职责：在 Harness 作用域内装配并导出 Cloud Executor 运行时。         │
// └─────────────────────────────────────────────────────────────────────┘

import { existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import CyreneSessionPersistence from './persistence.js';
import { DynamicPluginManager, apply as applyPluginManager } from './plugin-manager.js';
import {
  NavigatorExecutor,
  apply as applyExecutor,
  parseCredentialNotificationsConfig,
  resolveTeamsTaskActorSubjects,
} from './executor.js';
import type { CredentialNotificationsConfig, TeamsExecutorConfig, TeamsPersonalMessageSendRequest } from './executor.js';
import { ExchangeLlmAdapter } from './exchange-adapter.js';
import { CodeBuddyLlmAdapter } from './codebuddy-adapter.js';
import { AntigravityLlmAdapter, DEFAULT_ANTIGRAVITY_MODEL } from './antigravity-adapter.js';
import {
  ExchangeConnectorAuthorizationClient,
  canonicalJson,
  sha256,
  validateTeamsServiceUrl,
} from './connector-authorization.js';
import {
  InMemoryWorkStateStore,
  WorkActorClientRegistry,
  WorkStateClient,
  loadWorkActorTokenReferences,
} from './work-state-client.js';
import type { WorkStateStore } from './work-state-client.js';
import { WorkAssistantBridge, registerWorkTools } from './work-tools.js';
import { getConnectorToolCatalog, registerToolProviders } from './tool-providers.js';
import type {
  ConnectorBindingAuthorization,
  ConnectorResourceProjection,
  GithubBindingDisplayHint,
} from './tool-providers.js';
import {
  createResponsibilityAuthorizationResolver,
  verifiedTeamsPrincipalForTask,
  verifyActiveTeamsOwnerContext,
  verifyWorkflowOwnerAccess,
} from './responsibility-authority.js';
import type {
  ActiveTeamsOwnerContext,
  BackgroundTaskAuthorizationResolver,
  ResponsibilityAuthorityConfig,
  ResponsibilityPrincipal,
} from './responsibility-authority.js';
import { registerResponsibilityTools } from './responsibility-tools.js';
import type { ResponsibilityTargetConfig } from './responsibility-tools.js';
import { projectWorkflowNoticeToTeamsMessage } from './workflow-teams-delivery.js';
import type { WorkflowV2Write } from './workflows/store.js';
import type { ModelRoute } from './model-policy.js';
import { readCodeBuddyFallbackConfig } from './model-policy.js';
import { PrioritizedModelAdapter, PrioritizedModelGate } from './model-gate.js';
import { registerSubagents } from './subagents/index.js';
import type { SubagentAdapterConfig, SubagentAdapterEvent } from './subagents/types.js';
import { CodeBuddyAcpExecutionBackend, validateCodeBuddyModel } from './codebuddy-acp-execution.js';
import {
  AntigravityAcpExecutionBackend,
  validateAntigravityAcpCommand,
  validateAntigravityAcpModel,
  validateAntigravityAcpProfile,
} from './antigravity-acp-execution.js';
import type { ConversationExecutionBackend } from './codebuddy-acp-execution.js';
import { WorkflowsClient } from './workflows/store.js';
import { registerWorkflowRuntime } from './workflows/runtime.js';
import { createProductObservationSource } from './workflows/product-observation.js';
import type { ProductObservationRequest } from './workflows/product-observation.js';
import { createHostHealthObservationSource } from './workflows/host-observation.js';
import type { HostObservationRequest } from './workflows/host-observation.js';
import { createOfficeObservationSource } from './workflows/office-observation.js';
import {
  AUTOMATION_SOURCE_BINDINGS_ENV,
  createHostObservationAuthority,
  createProductObservationAuthority,
  loadAutomationSourceBindings,
} from './workflows/source-config.js';
import type {
  AutomationSourceBindings,
  HostSourceAuthorizationClient,
  PlannerPlanAuthorizationClient,
  ProductDirectorySourceClient,
  ProductSourceCredentialClient,
} from './workflows/source-config.js';
import type { WorkflowObservationPageRequest, WorkflowObservationSourceDriver } from './workflows/runtime.js';
import { registerCloudConnections, validateCloudConnectionConfig } from './integrations/cloud-connections.js';
import {
  ExchangeAuthorizationClient,
  registerExchangeAuthorizationTools,
} from './integrations/exchange-authorization.js';
import type { ExchangeAuthorizationWaitReceipt } from './integrations/exchange-authorization.js';
import {
  registerExchangeIssueTools,
  resolveExchangeUserBearerProvider,
} from './integrations/exchange-integration.js';
import type { TrustedUserBearerProvider } from './integrations/exchange-integration.js';

export interface CreateExecutorAppOptions {
  readonly persistenceUrl?: string;
  readonly workspaceId?: string;
  readonly exchangeUrl?: string;
  readonly exchangeIntegrationUrl?: string;
  readonly exchangeIntegrationWorkspaceId?: string;
  readonly exchangeIntegrationUserBearerProvider?: TrustedUserBearerProvider;
  readonly allowSingleSessionExchangeCliEnvironmentBearer?: boolean;
  readonly revalidateExchangeAuthorization?: (
    sessionId: string,
    connectionId: string,
  ) => Promise<{
    readonly connectionId: string;
    readonly authorizationRef: string | null;
    readonly loginState: string;
    readonly authorizationState: string;
    readonly generation: number;
  }>;
  readonly readExchangeOperationState?: (sessionId: string, operationId: string) => Promise<string>;
  readonly modelSource?: 'exchange' | 'codebuddy' | 'antigravity';
  readonly model?: string;
  /** Test-only route injection for deterministic provider-failover fixtures. */
  readonly modelFallbacks?: readonly ModelRoute[];
  readonly pluginsDir?: string;
  readonly watchPlugins?: boolean;
  readonly defaultCwd?: string;
  /** Bounded total active task slots; one is reserved for foreground when at least two are configured. */
  readonly maxConcurrentTasks?: number;
  readonly customLlmAdapter?: { provider: string; adapter: LlmAdapter };
  /** Additional fixture providers available only to explicit testMode failover cases. */
  readonly customTestModelAdapters?: readonly { provider: string; adapter: LlmAdapter }[];
  readonly testMode?: boolean;
  readonly enableTestEchoAdapter?: boolean;
  readonly authTokenEnv?: string;
  readonly allowedOrigins?: readonly string[];
  readonly workStateStore?: WorkStateStore;
  /** Mandatory server-owned source readers and per-poll ACL clients; absent ports keep those sources disabled. */
  readonly automationSourceClients?: {
    readonly productDirectory?: ProductDirectorySourceClient;
    readonly productCredentials?: ProductSourceCredentialClient;
    readonly hostAuthorization?: HostSourceAuthorizationClient;
    readonly plannerAuthorization?: PlannerPlanAuthorizationClient;
  };
  readonly enableWorkflows?: boolean;
  readonly dshHome?: string;
  readonly cloudConnectionConfigPath?: string;
  readonly subagentConfigPath?: string;
  readonly teams?: TeamsExecutorConfig;
  /** Restrict a Teams deployment to authenticated text conversations with no model tools. | 仅允许通过身份校验的纯文字对话，不向模型开放工具。 */
  readonly teamsChatOnly?: boolean;
  readonly connectorBindingsPath?: string;
  readonly connectorToolCatalogPath?: string;
  /** Host-owned verifier for persisted background responsibility connector calls. */
  readonly backgroundTaskAuthority?: BackgroundTaskAuthorizationResolver;
  /** Host-approved repository/action list for owner responsibility commands. */
  readonly responsibilityTargets?: readonly ResponsibilityTargetConfig[];
  /** Test-only override for backend selection; production uses CYRENE_HARNESS_EXECUTION_BACKEND. */
  readonly executionBackend?: 'dsh' | 'codebuddy-acp' | 'antigravity-acp';
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repository = resolve(__dirname, '../..');
const MAX_CONNECTOR_TOOL_CATALOG_BYTES = 32 * 1024 * 1024;

export async function createExecutorApp(options: CreateExecutorAppOptions = {}) {
  const testMode = options.testMode === true;
  const production = process.env.NODE_ENV === 'production';
  const teamsChatOnly = resolveTeamsChatOnly(options.teamsChatOnly);
  if (production && testMode) throw new Error('Executor test mode is disabled in production');
  if (options.customLlmAdapter && !testMode) throw new Error('Custom LLM adapters require explicit testMode');
  if (options.customTestModelAdapters !== undefined && !testMode) {
    throw new Error('Custom test model adapters require explicit testMode');
  }
  if (options.enableTestEchoAdapter && !testMode) throw new Error('The echo adapter is test-only');
  const executionBackend = resolveExecutionBackend(options.executionBackend, testMode);

  const persistenceUrl = options.persistenceUrl ?? process.env.CYRENE_PERSISTENCE_URL;
  const workspaceId = options.workspaceId ?? process.env.CYRENE_WORKSPACE_ID;
  const configuredTeams = options.teams ?? await createTeamsExecutorConfig(workspaceId);
  const privateTeamsMessageSender = configuredTeams?.personalChatEnabled === true && workspaceId !== undefined
    ? createPrivateTeamsMessageSender(configuredTeams, workspaceId)
    : undefined;
  const teams = configuredTeams !== undefined && privateTeamsMessageSender !== undefined
    ? { ...configuredTeams, sendPrivateMessage: privateTeamsMessageSender }
    : configuredTeams;
  const maxConcurrentTasks = validateTaskConcurrency(
    options.maxConcurrentTasks ?? parseTaskConcurrency(process.env.CYRENE_EXECUTOR_MAX_CONCURRENT_TASKS),
  );
  const connectorBindingsPath = options.connectorBindingsPath ?? process.env.CYRENE_CONNECTOR_BINDINGS_FILE;
  const connectorBindings = connectorBindingsPath === undefined
    ? new Map<string, ConnectorBindingAuthorization>()
    : validateConnectorBindingMap(JSON.parse(await readFile(resolve(connectorBindingsPath), 'utf8')) as unknown);
  if (teamsChatOnly && teams === undefined) {
    throw new Error('TEAMS_CHAT_ONLY requires Teams to be enabled');
  }
  if (teamsChatOnly && connectorBindings.size > 0) {
    throw new Error('TEAMS_CHAT_ONLY requires an empty connector binding map');
  }
  if (!teamsChatOnly && teams !== undefined && production && connectorBindings.size === 0) {
    throw new Error('CYRENE_CONNECTOR_BINDINGS_FILE is required when Teams connector execution is enabled');
  }
  const connectorToolCatalogPath = options.connectorToolCatalogPath ?? process.env.CYRENE_CONNECTOR_TOOL_CATALOG_FILE;
  if (!teamsChatOnly && teams !== undefined && production && connectorToolCatalogPath === undefined) {
    throw new Error('CYRENE_CONNECTOR_TOOL_CATALOG_FILE is required when Teams connector execution is enabled');
  }
  const connectorToolCatalogSnapshot = connectorToolCatalogPath === undefined
    ? undefined
    : await readHostConnectorToolCatalog(resolve(connectorToolCatalogPath));
  const exchangeIntegrationUrl = options.exchangeIntegrationUrl ?? process.env.CYRENE_EXCHANGE_INTEGRATION_URL;
  const cloudConfigPath = options.cloudConnectionConfigPath ?? process.env.CYRENE_CLOUD_PROFILE_CONFIG;
  const subagentConfigPath = options.subagentConfigPath ?? process.env.CYRENE_SUBAGENT_CONFIG;
  const configuredPluginsDir = options.pluginsDir ?? process.env.NAVIGATOR_PLUGINS_DIR;
  if (teamsChatOnly) {
    if (connectorToolCatalogSnapshot !== undefined) assertEmptyConnectorToolCatalog(connectorToolCatalogSnapshot);
    if (exchangeIntegrationUrl) throw new Error('TEAMS_CHAT_ONLY disallows Exchange business tools');
    if (cloudConfigPath) throw new Error('TEAMS_CHAT_ONLY disallows cloud connection tools');
    if (subagentConfigPath) throw new Error('TEAMS_CHAT_ONLY disallows subagent tools');
    if (configuredPluginsDir) throw new Error('TEAMS_CHAT_ONLY disallows configured dynamic plugins');
    if (options.enableWorkflows === true || process.env.CYRENE_WORKFLOWS_ENABLED === 'true') {
      throw new Error('TEAMS_CHAT_ONLY disallows workflow tools');
    }
    if (process.env.CYRENE_WORKFLOWS_ENABLED !== undefined
      && process.env.CYRENE_WORKFLOWS_ENABLED !== 'false'
      && process.env.CYRENE_WORKFLOWS_ENABLED !== 'true') {
      throw new TypeError('CYRENE_WORKFLOWS_ENABLED must be true or false');
    }
  }
  const exchangeIntegrationWorkspaceId = options.exchangeIntegrationWorkspaceId
    ?? process.env.CYRENE_EXCHANGE_INTEGRATION_WORKSPACE_ID ?? workspaceId;
  if (exchangeIntegrationUrl && !exchangeIntegrationWorkspaceId) {
    throw new Error('Exchange integration tools require a configured Workspace');
  }
  const exchangeIntegrationUserBearerProvider = resolveExchangeUserBearerProvider(
    options.exchangeIntegrationUserBearerProvider,
    options.allowSingleSessionExchangeCliEnvironmentBearer === true,
  );
  const exchangeAuthorizationClient = exchangeIntegrationUrl && exchangeIntegrationWorkspaceId
    ? new ExchangeAuthorizationClient({
      baseUrl: exchangeIntegrationUrl,
      workspaceId: exchangeIntegrationWorkspaceId,
      trustedUserBearerProvider: exchangeIntegrationUserBearerProvider,
    })
    : undefined;
  const dshHome = options.dshHome ?? process.env.DSH_HOME;
  const workflowsRequested = teamsChatOnly ? false : options.enableWorkflows ?? (
    process.env.CYRENE_WORKFLOWS_ENABLED === 'true'
    || (!testMode && Boolean(dshHome) && process.env.CYRENE_WORKFLOWS_ENABLED !== 'false')
  );
  const workflowRequirementsMet = Boolean(persistenceUrl && workspaceId && dshHome);
  const workflowsEnabled = workflowsRequested && workflowRequirementsMet;
  const workflowSetupUnavailable = workflowsRequested && !workflowRequirementsMet;
  const sessionToken = process.env.CYRENE_SESSION_TOKEN;
  const publicTokenEnv = options.authTokenEnv ?? (process.env.CYRENE_EXECUTOR_TOKEN ? 'CYRENE_EXECUTOR_TOKEN' : 'CYRENE_SESSION_TOKEN');
  const publicToken = process.env[publicTokenEnv] ?? sessionToken;
  if (!testMode && !persistenceUrl) throw new Error('CYRENE_PERSISTENCE_URL is required outside explicit testMode');
  if (!testMode && !workspaceId) throw new Error('CYRENE_WORKSPACE_ID is required outside explicit testMode');
  if (!testMode && !sessionToken) throw new Error('CYRENE_SESSION_TOKEN is required outside explicit testMode');
  if (!testMode && !publicToken) throw new Error(`${publicTokenEnv} or CYRENE_SESSION_TOKEN is required for executor API authentication`);
  const workState: WorkStateStore = options.workStateStore
    ?? (persistenceUrl && workspaceId
      ? new WorkStateClient({
        baseUrl: persistenceUrl,
        workspaceId,
        tokenEnv: 'CYRENE_SESSION_TOKEN',
        privateBridgeTokenEnv: 'CYRENE_PRIVATE_TEAMS_BRIDGE_TOKEN',
        requestTimeoutMs: 10_000,
      })
      : testMode ? new InMemoryWorkStateStore() : (() => { throw new Error('Durable work-state configuration is required'); })());
  if (production && (workState instanceof InMemoryWorkStateStore || options.workStateStore === undefined && !persistenceUrl)) {
    throw new Error('Production executor requires the SQLite-backed WorkStateClient');
  }
  const workActorTokenMapPath = process.env.CYRENE_WORK_ACTOR_TOKEN_MAP_FILE;
  const configuredWorkActorReferences = workActorTokenMapPath === undefined
    ? undefined
    : await loadWorkActorTokenReferences(resolve(configText(workActorTokenMapPath, 'CYRENE_WORK_ACTOR_TOKEN_MAP_FILE', 2_000)), workspaceId!);
  let workActorReferences = configuredWorkActorReferences;
  let workActorClients: WorkActorClientRegistry | undefined;
  if (workActorReferences !== undefined) {
    const configuredReferences = configuredWorkActorReferences ?? [];
    if (!persistenceUrl || !workspaceId) throw new Error('A Work actor token map requires durable Workspace configuration');
    if (teams?.personalChatEnabled === true) {
      const issuer = `https://login.microsoftonline.com/${teams.tenantId.toLowerCase()}/v2.0`;
      const currentlyAuthorized = new Set(
        await resolveTeamsTaskActorSubjects(teams, workspaceId, issuer),
      );
      workActorReferences = workActorReferences.filter(reference =>
        currentlyAuthorized.has(reference.actorAadObjectId.toLowerCase()));
      const modelActorSubject = teams.modelActorSubject?.toLowerCase();
      if (modelActorSubject !== undefined
        && !configuredReferences.some(reference => reference.actorAadObjectId.toLowerCase() === modelActorSubject)) {
        throw new Error('CYRENE_TEAMS_MODEL_ACTOR_SUBJECT must name a configured actor Work principal');
      }
    }
    const values = workActorReferences.map(reference => process.env[reference.tokenEnv]);
    if (values.some(value => !value || Buffer.byteLength(value, 'utf8') < 32)
      || new Set(values).size !== values.length
      || values.some(value => value === process.env.CYRENE_SESSION_TOKEN
        || value === process.env.CYRENE_EXECUTOR_TOKEN
        || value === process.env.CYRENE_PRIVATE_TEAMS_BRIDGE_TOKEN)) {
      throw new Error('Work actor token environment references must resolve to distinct dedicated credentials');
    }
    workActorClients = new WorkActorClientRegistry({ baseUrl: persistenceUrl, workspaceId, requestTimeoutMs: 10_000 }, workActorReferences);
  }
  if (teams?.personalChatEnabled === true) {
    if (workActorReferences === undefined || workActorReferences.length < 1 || workActorReferences.length > 5) {
      throw new Error('Personal Teams mode requires 1 to 5 dedicated actor Work principals in CYRENE_WORK_ACTOR_TOKEN_MAP_FILE');
    }
  }
  const automationSourceBindingsPath = process.env[AUTOMATION_SOURCE_BINDINGS_ENV];
  let automationSourceBindings: AutomationSourceBindings | undefined;
  let automationSourceBindingsUnavailable = false;
  if (automationSourceBindingsPath !== undefined) {
    try {
      automationSourceBindings = await loadAutomationSourceBindings(resolve(configText(
        automationSourceBindingsPath, AUTOMATION_SOURCE_BINDINGS_ENV, 2_000,
      )));
    } catch {
      automationSourceBindingsUnavailable = true;
    }
  }

  const ctx = new Context();
  if (teams?.personalChatEnabled === true && teams.sendPrivateMessage === undefined) {
    ctx.logger.warn('Teams personal notifications are disabled because the fixed Exchange private sender is unavailable');
  }
  if (automationSourceBindingsUnavailable) {
    ctx.logger.warn('automation source bindings are unavailable or invalid; Product, host-health, and Planner observations are disabled');
  }
  if (workflowSetupUnavailable) {
    ctx.logger.warn('background workflow runtime is unavailable because durable storage or DSH_HOME is not configured; foreground chat remains online');
  }

  // Core Cordis runtime and Agent loop
  await ctx.plugin(LocalSubprocessRuntime);
  if (executionBackend === 'dsh') await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt);
  if (teamsChatOnly) {
    ctx.systemPrompt.section({
      name: 'navigator:teams-chat-only-capability',
      order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: [
        'This deployment supports text conversation only. No external search, query, or action tools are available.',
        'Do not claim to have checked GitHub, Hugging Face, cloud resources, or other external systems, and do not claim to have completed an operation.',
        'If asked to perform an external check or action, explain that connector tools are not enabled in this chat deployment.',
      ].join('\n'),
    });
  } else if (teams !== undefined) {
    ctx.systemPrompt.section({
      name: 'navigator:teams-connector-execution-policy',
      order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: [
        'For a task admitted from an authenticated Teams caller, treat a clear instruction from the configured authorized operator as direct authorization to execute the requested connector action.',
        'Call the matching connector tool directly when the target and required arguments are present. Do not ask for an extra per-action confirmation or create an approval request.',
        'Use work_request_input only when a required target or argument is missing or ambiguous; ask only for the missing information and never guess it.',
        'This task policy does not grant connector access: each call still requires the trusted task identity, launcher-owned binding, and a fresh Exchange/Directory grant. If authorization is denied, report the denial and do not bypass it.',
        'An unknown or uncertain remote write result is never success. Do not replay that write or claim it succeeded. Read its exact Work operation receipt with work_operation_read, perform a separate read-only check for the same configured provider/profile scope, then explicitly reconcile with work_operation_verify using that read receipt ID and what the returned state proves. Leave the receipt uncertain when the independent read does not settle the outcome.',
      ].join('\n'),
    });
  }
  let persistenceTokenEnvForSession = (_sessionId: string): string | undefined => undefined;
  let actorPrivateScopeForSession = (sessionId: string): boolean => sessionId.startsWith('teams-');
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);

  // Persistence (if configured)
  if (persistenceUrl) {
    if (!workspaceId) throw new Error('CYRENE_WORKSPACE_ID is required when persistence is configured');
    await ctx.plugin(CyreneSessionPersistence, {
      baseUrl: persistenceUrl,
      workspaceId,
      tokenEnv: 'CYRENE_SESSION_TOKEN',
      tokenEnvForSession: (sessionId: string) => persistenceTokenEnvForSession(sessionId),
      actorPrivateScopeForSession: (sessionId: string) => actorPrivateScopeForSession(sessionId),
      clientId: process.env.CYRENE_DEVICE_ID ?? 'navigator-cloud-daemon',
      requestTimeoutMs: 10_000,
      heartbeatMs: 1_000,
      batchDelayMs: 10,
      maxPendingEvents: 128,
      batchSize: 256,
    });
  }

  if (executionBackend === 'dsh') await ctx.plugin(AgentLoop, { agents: [] });

  // Model source remains a DSH-only setting; ACP has its own native profile.
  let modelFallbacks: readonly ModelRoute[] = [];
  let codeBuddyAcpModel: string | undefined;
  let codeBuddyAcpCommand = 'codebuddy';
  let antigravityAcpModel: string | undefined;
  let antigravityAcpCommand: string | undefined;
  let antigravityAcpProfile: string | undefined;
  if (executionBackend === 'codebuddy-acp') {
    const modelSource = options.modelSource ?? process.env.CYRENE_HARNESS_MODEL_SOURCE;
    const legacyModel = options.model ?? process.env.CYRENE_HARNESS_MODEL;
    if (modelSource !== undefined && modelSource !== '') {
      throw new Error('CYRENE_HARNESS_MODEL_SOURCE must be unset or empty when CYRENE_HARNESS_EXECUTION_BACKEND=codebuddy-acp');
    }
    if (legacyModel !== undefined && legacyModel !== '') {
      throw new Error('CYRENE_HARNESS_MODEL must be unset or empty when CYRENE_HARNESS_EXECUTION_BACKEND=codebuddy-acp');
    }
    if (options.customLlmAdapter || options.customTestModelAdapters !== undefined || options.enableTestEchoAdapter) {
      throw new Error('DSH LLM adapters cannot be configured with the CodeBuddy ACP execution backend');
    }
    if (options.modelFallbacks !== undefined) {
      throw new Error('DSH model fallbacks cannot be configured with the CodeBuddy ACP execution backend');
    }
    if (subagentConfigPath !== undefined) {
      throw new Error('DSH subagents cannot be configured with the CodeBuddy ACP execution backend');
    }
    const fallbackPolicy = readCodeBuddyFallbackConfig(process.env);
    if (fallbackPolicy.enabled) {
      throw new Error('CYRENE_HARNESS_CODEBUDDY_FALLBACK_ENABLED must be false with the CodeBuddy ACP execution backend');
    }
    if (!fallbackPolicy.noPaidTopUp) {
      throw new Error('CYRENE_HARNESS_CODEBUDDY_NO_PAID_TOPUP=true is required as an explicit ACP deployment policy');
    }
    const configuredCommand = process.env.CYRENE_HARNESS_CODEBUDDY_ACP_COMMAND;
    if (configuredCommand !== undefined && configuredCommand !== '' && configuredCommand !== 'codebuddy') {
      throw new Error('CYRENE_HARNESS_CODEBUDDY_ACP_COMMAND only allows the codebuddy executable');
    }
    codeBuddyAcpCommand = configuredCommand || 'codebuddy';
    codeBuddyAcpModel = validateCodeBuddyModel(process.env.CYRENE_HARNESS_CODEBUDDY_ACP_MODEL);
  } else if (executionBackend === 'antigravity-acp') {
    const modelSource = options.modelSource ?? process.env.CYRENE_HARNESS_MODEL_SOURCE;
    const legacyModel = options.model ?? process.env.CYRENE_HARNESS_MODEL;
    if (modelSource !== undefined && modelSource !== '') {
      throw new Error('CYRENE_HARNESS_MODEL_SOURCE must be unset or empty when CYRENE_HARNESS_EXECUTION_BACKEND=antigravity-acp');
    }
    if (legacyModel !== undefined && legacyModel !== '') {
      throw new Error('CYRENE_HARNESS_MODEL must be unset or empty when CYRENE_HARNESS_EXECUTION_BACKEND=antigravity-acp');
    }
    if (options.customLlmAdapter || options.customTestModelAdapters !== undefined || options.enableTestEchoAdapter) {
      throw new Error('DSH LLM adapters cannot be configured with the Antigravity ACP execution backend');
    }
    if (options.modelFallbacks !== undefined) {
      throw new Error('DSH model fallbacks cannot be configured with the Antigravity ACP execution backend');
    }
    if (subagentConfigPath !== undefined) {
      throw new Error('DSH subagents cannot be configured with the Antigravity ACP execution backend');
    }
    antigravityAcpCommand = validateAntigravityAcpCommand(
      process.env.CYRENE_HARNESS_ANTIGRAVITY_ACP_COMMAND,
      testMode,
    );
    antigravityAcpProfile = validateAntigravityAcpProfile(process.env.CYRENE_HARNESS_ANTIGRAVITY_ACP_PROFILE);
    antigravityAcpModel = validateAntigravityAcpModel(process.env.CYRENE_HARNESS_ANTIGRAVITY_ACP_MODEL);
  } else {
    // DSH LLM Model Adapter setup
    const exchangeUrl = options.exchangeUrl ?? process.env.CYRENE_EXCHANGE_URL;
    const configuredModelSource = options.modelSource ?? (process.env.CYRENE_HARNESS_MODEL_SOURCE || 'antigravity');
    if (configuredModelSource !== 'exchange'
      && configuredModelSource !== 'codebuddy'
      && configuredModelSource !== 'antigravity') {
      throw new Error('CYRENE_HARNESS_MODEL_SOURCE must be exchange, codebuddy or antigravity');
    }
    const modelId = options.model
      ?? (process.env.CYRENE_HARNESS_MODEL || undefined)
      ?? (configuredModelSource === 'codebuddy'
        ? 'glm-5.3-flash'
        : configuredModelSource === 'antigravity'
          ? DEFAULT_ANTIGRAVITY_MODEL
          : testMode ? 'test-model' : undefined);
    const codeBuddyFallback = readCodeBuddyFallbackConfig(process.env);
    if (codeBuddyFallback.enabled && configuredModelSource !== 'antigravity') {
      throw new TypeError('CodeBuddy fallback is supported only when Antigravity is the primary model source');
    }
    if (options.modelFallbacks !== undefined && !testMode) {
      throw new Error('Explicit model fallback routes are test-only; production fallbacks come from host configuration');
    }
    modelFallbacks = options.modelFallbacks ?? (!options.customLlmAdapter
      && codeBuddyFallback.enabled && codeBuddyFallback.model !== undefined
      ? [{ provider: 'codebuddy', model: codeBuddyFallback.model }]
      : []);
    const modelGate = new PrioritizedModelGate();
    const prioritized = (adapter: LlmAdapter): LlmAdapter => new PrioritizedModelAdapter(
      adapter,
      modelGate,
      sessionId => ctx.get('executor')?.executionClassForSession(sessionId) ?? 'foreground',
    );

    if (configuredModelSource === 'exchange' && exchangeUrl) {
      const exchangeToken = process.env.CYRENE_EXCHANGE_TOKEN;
      if (!exchangeToken) throw new Error('CYRENE_EXCHANGE_TOKEN is required when Exchange is configured');
      if (!modelId) throw new Error('CYRENE_HARNESS_MODEL is required when Exchange is configured');
      ctx.llm.registerAdapter(['cyrene-exchange'], prioritized(new ExchangeLlmAdapter({
        baseUrl: exchangeUrl,
        tokenEnv: 'CYRENE_EXCHANGE_TOKEN',
        requestTimeoutMs: 120_000,
      })));
      ctx.provide('agentDefaultModel', {
        currentSelection: () => ({ provider: 'cyrene-exchange', model: modelId }),
      });
    } else if (options.customLlmAdapter) {
      const custom = options.customLlmAdapter;
      ctx.llm.registerAdapter([custom.provider], prioritized(custom.adapter));
      for (const fixture of options.customTestModelAdapters ?? []) {
        ctx.llm.registerAdapter([fixture.provider], prioritized(fixture.adapter));
      }
      ctx.provide('agentDefaultModel', {
        currentSelection: () => ({ provider: custom.provider, model: modelId! }),
      });
    } else if (configuredModelSource === 'codebuddy') {
      ctx.llm.registerAdapter(['codebuddy'], prioritized(new CodeBuddyLlmAdapter()));
      ctx.provide('agentDefaultModel', {
        currentSelection: () => ({ provider: 'codebuddy', model: modelId! }),
      });
    } else if (configuredModelSource === 'antigravity') {
      const antigravityAdapter = new AntigravityLlmAdapter();
      await antigravityAdapter.resolveModel('antigravity', modelId!);
      ctx.llm.registerAdapter(['antigravity'], prioritized(antigravityAdapter));
      // Existing in-memory CodeBuddy Agents retain their original provider selection.
      ctx.llm.registerAdapter(['codebuddy'], prioritized(new CodeBuddyLlmAdapter()));
      ctx.provide('agentDefaultModel', {
        currentSelection: () => ({ provider: 'antigravity', model: modelId! }),
      });
    } else if (testMode && options.enableTestEchoAdapter === true) {
      // Explicit test-only deterministic adapter; it is never the production default.
      class CloudDefaultAdapter extends LlmAdapter {
        async *stream(genOptions: GenerateOptions): AsyncGenerator<StreamChunk> {
          const prompt = genOptions.messages?.at(-1)?.content?.[0]?.type === 'text'
            ? (genOptions.messages.at(-1)?.content?.[0] as { type: 'text'; text: string }).text
            : 'acknowledged';
          const reply = `[Cloud Executor] Task processed: "${prompt}"`;
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: reply };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } };
          yield { type: 'usage', usage: { inputTokens: 20, outputTokens: reply.length, totalTokens: 20 + reply.length } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
      ctx.llm.registerAdapter(['cloud-default'], prioritized(new CloudDefaultAdapter()));
      ctx.provide('agentDefaultModel', {
        currentSelection: () => ({ provider: 'cloud-default', model: modelId }),
      });
    } else if (!testMode) {
      throw new Error('CYRENE_EXCHANGE_URL and CYRENE_HARNESS_MODEL are required when CYRENE_HARNESS_MODEL_SOURCE=exchange');
    }
  }

  const pluginsDir = configuredPluginsDir ?? join(repository, 'plugins');
  if (!teamsChatOnly && !existsSync(pluginsDir)) {
    mkdirSync(pluginsDir, { recursive: true });
  }

  // Dynamic Plugin Hot-Reload supervisor
  applyPluginManager(ctx, {
    ...(teamsChatOnly ? {} : { pluginsDir }),
    watch: teamsChatOnly ? false : options.watchPlugins ?? true,
  });

  const revalidateExchangeAuthorization = options.revalidateExchangeAuthorization
    ?? (exchangeAuthorizationClient === undefined ? undefined : async (sessionId: string, connectionId: string) =>
      exchangeAuthorizationClient.getAuthorizationHealth(connectionId, {
        sessionId, signal: AbortSignal.timeout(15_000),
      }));
  const readExchangeOperationState = options.readExchangeOperationState
    ?? (exchangeAuthorizationClient === undefined ? undefined : async (sessionId: string, operationId: string) =>
      exchangeAuthorizationClient.getOperationState(operationId, {
        sessionId, signal: AbortSignal.timeout(15_000),
      }));

  const conversationBackend: ConversationExecutionBackend | undefined = executionBackend === 'codebuddy-acp'
    ? new CodeBuddyAcpExecutionBackend({
      ctx,
      workState,
      command: codeBuddyAcpCommand,
      model: codeBuddyAcpModel,
    })
    : executionBackend === 'antigravity-acp'
      ? new AntigravityAcpExecutionBackend({
        ctx,
        workState,
        command: antigravityAcpCommand,
        profileRoot: antigravityAcpProfile,
        model: antigravityAcpModel,
        ...(testMode ? { commandArgsPrefix: [] } : {}),
      })
      : undefined;

  // Autonomous Cloud Executor Daemon service
  applyExecutor(ctx, {
    defaultCwd: options.defaultCwd ?? process.cwd(),
    workspaceId: workspaceId ?? 'test-workspace',
    workState,
    workStateTokenEnv: 'CYRENE_SESSION_TOKEN',
    ...(workActorClients === undefined ? {} : { workActorClients }),
    authTokenEnv: publicTokenEnv,
    maxConcurrentTasks,
    modelFallbacks,
    ...(conversationBackend === undefined ? {} : { conversationBackend }),
    ...(teams === undefined ? {} : { teams }),
    allowedOrigins: options.allowedOrigins,
    ...(revalidateExchangeAuthorization === undefined ? {} : { revalidateExchangeAuthorization }),
    ...(readExchangeOperationState === undefined ? {} : { readExchangeOperationState }),
  });

  const executor = ctx.get('executor');
  if (!executor) throw new Error('Navigator executor service was not registered');
  persistenceTokenEnvForSession = sessionId => executor.workTokenEnvForSession(sessionId);
  actorPrivateScopeForSession = sessionId => executor.actorPrivateSession(sessionId);
  const pluginManager = ctx.get('pluginManager');
  const workflowStore = workflowsEnabled
    ? new WorkflowsClient({
      baseUrl: persistenceUrl!, workspaceId: workspaceId!, tokenEnv: 'CYRENE_SESSION_TOKEN', requestTimeoutMs: 10_000,
    })
    : undefined;
  const workflowStoresByActor = new Map<string, WorkflowsClient>();
  if (workflowsEnabled && workActorClients !== undefined && persistenceUrl && workspaceId) {
    for (const actorId of workActorClients.actorIds()) {
      const tokenEnv = workActorClients.tokenEnvForActor(actorId);
      if (tokenEnv === undefined) continue;
      workflowStoresByActor.set(actorId, new WorkflowsClient({
        baseUrl: persistenceUrl, workspaceId, tokenEnv, requestTimeoutMs: 10_000,
      }));
    }
  }
  const trustedAutomationSourceBindings = automationSourceBindings === undefined
    ? undefined
    : {
      schemaVersion: 1 as const,
      targets: automationSourceBindings.targets.filter(binding => {
        if (binding.kind !== 'planner_plan') return true;
        const graphBinding = connectorBindings.get(binding.bindingId);
        return graphBinding?.providerId === 'microsoft_graph'
          && graphBinding.connectionRef.toLowerCase() === binding.connectionRef.toLowerCase()
          && graphBinding.profileRef === binding.profileRef
          && graphBinding.tools.some(tool => tool.toolId === 'microsoft_graph.planner.tasks.list'
            && tool.operationId === 'microsoft_graph.planner.tasks.list'
            && tool.resourceProjection === 'microsoft_graph_plan' && !tool.mutating)
          && graphBinding.tools.some(tool => tool.toolId === 'microsoft_graph.planner.plan.get'
            && tool.operationId === 'microsoft_graph.planner.plan.get'
            && tool.resourceProjection === 'microsoft_graph_plan' && !tool.mutating);
      }),
    };
  if (automationSourceBindings !== undefined
    && trustedAutomationSourceBindings?.targets.length !== automationSourceBindings.targets.length) {
    ctx.logger.warn('one or more Planner source bindings do not match an actor-owned Microsoft Graph connector profile and are disabled');
  }
  const workflowSourceDrivers: WorkflowObservationSourceDriver[] = [];
  const sourceClients = options.automationSourceClients;
  if (trustedAutomationSourceBindings !== undefined && sourceClients?.productDirectory !== undefined
    && sourceClients.productCredentials !== undefined) {
    const authority = createProductObservationAuthority(
      trustedAutomationSourceBindings, sourceClients.productDirectory, sourceClients.productCredentials,
    );
    const adapters = new Map<string, ReturnType<typeof createProductObservationSource>>();
    const readProduct = (request: WorkflowObservationPageRequest) => {
      let adapter = adapters.get(request.ownerActorId);
      if (adapter === undefined) {
        adapter = createProductObservationSource({ actorId: request.ownerActorId, authority });
        adapters.set(request.ownerActorId, adapter);
      }
      return adapter.read(request as ProductObservationRequest);
    };
    workflowSourceDrivers.push(
      { source: 'product', pollPage: readProduct },
      { source: 'training', pollPage: readProduct },
    );
  }
  if (trustedAutomationSourceBindings !== undefined && sourceClients?.hostAuthorization !== undefined) {
    const authority = createHostObservationAuthority(trustedAutomationSourceBindings, sourceClients.hostAuthorization);
    const adapters = new Map<string, ReturnType<typeof createHostHealthObservationSource>>();
    workflowSourceDrivers.push({
      source: 'vm_health',
      pollPage: request => {
        let adapter = adapters.get(request.ownerActorId);
        if (adapter === undefined) {
          adapter = createHostHealthObservationSource({ actorId: request.ownerActorId, authority });
          adapters.set(request.ownerActorId, adapter);
        }
        return adapter.read(request as HostObservationRequest);
      },
    });
  }
  if (trustedAutomationSourceBindings?.targets.some(binding => binding.kind === 'planner_plan')) {
    workflowSourceDrivers.push(createOfficeObservationSource({
      sourceBindings: trustedAutomationSourceBindings,
      ...(sourceClients?.plannerAuthorization === undefined ? {} : { authorization: sourceClients.plannerAuthorization }),
    }));
  }
  if (trustedAutomationSourceBindings !== undefined && sourceClients === undefined) {
    ctx.logger.warn('Product and host source bindings are loaded without their required Directory/ACL clients; those configured reads remain disabled');
  }
  const responsibilityAuthority: ResponsibilityAuthorityConfig | undefined =
    workflowStore !== undefined && teams !== undefined && workspaceId !== undefined
      ? {
        workspaceId,
        teamsConnectorId: teams.connectorId,
        allowedTenantId: teams.tenantId,
        allowedBotAppId: teams.botAppId,
        allowedTeamIds: teams.allowedTeamIds,
        workState,
        workStateForActor: actorId => workActorClients === undefined
          ? workState
          : workActorClients.forActor(actorId),
        workflows: workflowStore,
        workflowsForActor: actorId => workActorClients === undefined
          ? workflowStore
          : workflowStoresByActor.get(actorId),
        isDirectoryAuthorized: async (principal, signal) => {
          signal.throwIfAborted();
          if (principal.tenantId !== teams.tenantId.toLowerCase()) return false;
          const subjects = await resolveTeamsTaskActorSubjects(teams, workspaceId, principal.issuer);
          return subjects.includes(principal.subject.toLowerCase());
        },
      }
      : undefined;
  const backgroundTaskAuthority = options.backgroundTaskAuthority ?? (
    responsibilityAuthority === undefined
      ? undefined
      : createResponsibilityAuthorizationResolver(responsibilityAuthority)
  );
  let responsibilityTargets = options.responsibilityTargets;
  let responsibilityTargetsUnavailable = false;
  if (responsibilityTargets === undefined) {
    const responsibilityTargetsPath = process.env.CYRENE_RESPONSIBILITY_TARGETS_FILE;
    if (responsibilityTargetsPath !== undefined) {
      try {
        responsibilityTargets = await readHostResponsibilityTargets(responsibilityTargetsPath);
      } catch {
        responsibilityTargetsUnavailable = true;
      }
    } else {
      responsibilityTargetsUnavailable = true;
    }
  }
  const githubBindingDisplayHints = buildGithubBindingDisplayHints(connectorBindings, responsibilityTargets);

  let workAssistantBridge: WorkAssistantBridge | undefined;
  if (!teamsChatOnly && persistenceUrl && workspaceId) {
    workAssistantBridge = registerWorkTools(ctx, {
      baseUrl: persistenceUrl,
      workspaceId,
      tokenEnv: 'CYRENE_SESSION_TOKEN',
      taskIdForSession: sessionId => executor.activeTaskId(sessionId),
      tokenEnvForSession: sessionId => {
        const taskId = executor.activeTaskId(sessionId);
        return taskId === undefined ? undefined : executor.workTokenEnvForTask(taskId);
      },
      onTaskDenied: sessionId => ctx.agents.get(SessionId(sessionId))?.cancel({ kind: 'hook', reason: 'work_approval_denied' }),
    });
    await registerToolProviders(ctx, {
      bridge: workAssistantBridge,
      bridgeForTask: taskId => {
        const tokenEnv = executor.workTokenEnvForTask(taskId);
        return tokenEnv === undefined ? workAssistantBridge! : new WorkAssistantBridge({
          baseUrl: persistenceUrl!,
          workspaceId: workspaceId!,
          tokenEnv,
          taskIdForSession: sessionId => executor.activeTaskId(sessionId),
          onTaskDenied: sessionId => ctx.agents.get(SessionId(sessionId))?.cancel({ kind: 'hook', reason: 'work_approval_denied' }),
        });
      },
      readBackgroundTask: taskId => executor.readTaskForExecution(taskId),
      taskIdForSession: sessionId => executor.activeTaskId(sessionId),
      ...(backgroundTaskAuthority === undefined
        ? {}
        : { backgroundTaskAuthority }),
      githubBindingDisplayHints,
      ...(teams === undefined ? {} : {
        connectorAuthorization: {
          client: teams.exchangeAuthorization,
          workspaceId: workspaceId!,
          bindings: connectorBindings,
        },
      }),
      ...(connectorToolCatalogSnapshot === undefined ? {} : { connectorToolCatalogSnapshot }),
    });
  }

  if (exchangeIntegrationUrl) {
    if (!workAssistantBridge) throw new Error('Exchange issue tools require the durable Navigator approval bridge');
    const recordAuthorizationWait = async (
      sessionId: string,
      receipt: ExchangeAuthorizationWaitReceipt,
    ): Promise<void> => {
      let enriched = receipt;
      if (exchangeAuthorizationClient && receipt.connectionId && receipt.generation === undefined) {
        try {
          const health = await exchangeAuthorizationClient.getAuthorizationHealth(receipt.connectionId, {
            sessionId, signal: AbortSignal.timeout(15_000),
          });
          if (health.authorizationRef !== null
            && (receipt.authorizationRef === undefined || health.authorizationRef === receipt.authorizationRef)
            && health.authorizationState === 'REAUTHORIZATION_REQUIRED') {
            enriched = {
              ...receipt,
              authorizationRef: health.authorizationRef,
              generation: health.generation,
            };
          }
        } catch {
          // A wait without current generation remains non-resumable until a trusted health read succeeds.
        }
      }
      await executor.markTaskAwaitingUserAuthorization(sessionId, enriched);
    };
    await registerExchangeIssueTools(ctx, {
      baseUrl: exchangeIntegrationUrl,
      workspaceId: exchangeIntegrationWorkspaceId!,
      trustedUserBearerProvider: exchangeIntegrationUserBearerProvider,
      approvalBridge: workAssistantBridge,
      taskIdForSession: sessionId => executor.activeTaskId(sessionId),
      onAuthorizationRequired: recordAuthorizationWait,
    });
    await registerExchangeAuthorizationTools(ctx, {
      baseUrl: exchangeIntegrationUrl,
      workspaceId: exchangeIntegrationWorkspaceId!,
      trustedUserBearerProvider: exchangeIntegrationUserBearerProvider,
      approvalBridge: workAssistantBridge,
      taskIdForSession: sessionId => executor.activeTaskId(sessionId),
      onAuthorizationRequired: recordAuthorizationWait,
    });
  }

  if (!teamsChatOnly && cloudConfigPath) {
    const source = await readFile(resolve(cloudConfigPath), 'utf8');
    const cloudConfig = validateCloudConnectionConfig(JSON.parse(source) as unknown);
    await registerCloudConnections(ctx, cloudConfig);
  }

  if (!teamsChatOnly && subagentConfigPath) {
    const source = await readFile(resolve(subagentConfigPath), 'utf8');
    const subagentConfig = parseHostSubagentConfig(JSON.parse(source) as unknown);
    if (subagentConfig.deployments.length > 0) {
      await registerNativeSubagents(ctx, executor, workAssistantBridge, subagentConfig);
    }
  }

  let workflowRuntimeReady = false;
  if (workflowsEnabled) {
    try {
      if (!workflowStore) throw new Error('durable workflow store is unavailable');
      await registerWorkflowRuntime(ctx, {
        store: workflowStore,
        storageRoot: join(resolve(dshHome!), 'storages'),
        schedulerSessionId: 'navigator-workflow-scheduler-v1',
        executeTask: params => executor.executeTask(params),
        sourceDrivers: workflowSourceDrivers,
        executeFixedToolTask: (request, execute, actorAadObjectId, actorWorkState) =>
          executor.executeFixedToolTask(request, execute, actorAadObjectId, actorWorkState),
        recordSourcePageReceipt: (taskId, receipt) => executor.recordWorkflowSourcePage(taskId, receipt),
        resolveWorkflowActor: async ownerTaskId => {
          const actorTask = await workActorClients?.resolveTask(ownerTaskId);
          if (actorTask !== undefined) return actorTask.actorAadObjectId;
          const legacyTask = await workState.getTask(ownerTaskId);
          return legacyTask?.createdByActorId?.toLowerCase();
        },
        authorizeWorkflowActor: async (actorAadObjectId, ownerTaskId) => {
          if (!teams || !workspaceId || teams.personalChatEnabled !== true) return false;
          const actorId = actorAadObjectId.toLowerCase();
          const actorStore = workActorClients === undefined ? undefined : workActorClients.forActor(actorId);
          if (workActorClients !== undefined && actorStore === undefined) return false;
          const selectedStore = actorStore ?? workState;
          const task = await selectedStore.getTask(ownerTaskId);
          if (task === undefined) return false;
          const principal = verifiedTeamsPrincipalForTask(task, actorId, teams.tenantId, teams.botAppId);
          if (principal === undefined) return false;
          const subjects = await resolveTeamsTaskActorSubjects(teams, workspaceId, principal.issuer);
          return subjects.includes(actorId);
        },
        invokeObservationConnectorTool: async (agent, request) => {
          const entry = getConnectorToolCatalog(ctx).find(item => item.bindingId === request.bindingId
            && item.providerId === request.providerId && item.toolId === request.toolId
            && item.operationId === request.operationId && item.resourceProjection === request.resourceProjection
            && !item.mutating);
          if (entry === undefined) throw new Error('Fixed observation connector tool is not configured');
          const callId = ToolCallId(`workflow-observation-${randomUUID()}`);
          const result = await ctx.tools.execute({
            name: entry.name,
            callId,
            rootCallId: callId,
            arguments: request.arguments,
            signal: request.signal,
            agent,
          });
          return result;
        },
        actorStores: [...workflowStoresByActor].map(([actorAadObjectId, store]) => ({
          actorAadObjectId,
          store,
          workState: workActorClients?.forActor(actorAadObjectId),
          sourceDrivers: workflowSourceDrivers,
        })),
        readTaskEvents: (taskId, after) => executor.readTaskEvents(taskId, after),
        ...(responsibilityAuthority === undefined
          ? {}
          : {
            projectTeamsNotification: notification => projectWorkflowNoticeToTeamsMessage(
              notification,
              responsibilityAuthority,
              AbortSignal.timeout(10_000),
            ),
          }),
      });
      workflowRuntimeReady = true;
    } catch {
      ctx.logger.warn('background workflow runtime is unavailable; foreground chat remains online');
    }
  }

  if (workflowRuntimeReady && workflowStore !== undefined && responsibilityAuthority !== undefined
    && responsibilityTargets !== undefined) {
    try {
      const modelPolicy = currentResponsibilityModelPolicy(ctx, codeBuddyAcpModel);
      if (modelPolicy === undefined) throw new TypeError('No supported host model route is configured for responsibilities');
      const dispose = registerResponsibilityTools(ctx, {
        workflows: workflowStore,
        resolveActiveOwner: async (sessionId, signal) => {
          const taskId = executor.activeTaskId(sessionId);
          return taskId === undefined
            ? undefined
            : verifyActiveTeamsOwnerContext(responsibilityAuthority, taskId, signal);
        },
        authorizeWorkflowOwner: (workflowId, principal, signal) =>
          verifyWorkflowOwnerAccess(responsibilityAuthority, workflowId, principal, signal),
        readModelUsage: taskId => executor.readTaskModelUsage(taskId),
        syncWorkflows: async () => {
          const runtime = ctx.get('workflowRuntime');
          if (runtime === undefined) throw new Error('Durable workflow scheduler is unavailable');
          await runtime.sync();
        },
        allowedTargets: responsibilityTargets,
        modelPolicy,
      });
      ctx.effect(() => dispose, 'navigator.responsibilityTools');
    } catch {
      ctx.logger.warn('responsibility management tools are unavailable; foreground chat remains online');
    }
  } else if (workflowRuntimeReady && workflowsEnabled) {
    ctx.logger.warn(responsibilityTargetsUnavailable
      ? 'responsibility management tools are unavailable because the host target configuration is missing or invalid'
      : 'responsibility management tools are unavailable until Teams owner context and host repository targets are configured');
  }

  if (teamsChatOnly && ctx.tools.schemas().length !== 0) {
    throw new Error('TEAMS_CHAT_ONLY startup registered model tools');
  }

  return { ctx, executor, pluginManager, pluginsDir };
}

async function createTeamsExecutorConfig(workspaceId: string | undefined): Promise<TeamsExecutorConfig | undefined> {
  const enabled = process.env.TEAMS_ENABLED;
  if (enabled === undefined || enabled === 'false') return undefined;
  if (enabled !== 'true') throw new TypeError('TEAMS_ENABLED must be true or false');
  if (!workspaceId) throw new Error('CYRENE_WORKSPACE_ID is required when Teams is enabled');
  const ingressSecret = process.env.TEAMS_NAVIGATOR_HMAC_KEY;
  if (!ingressSecret || Buffer.byteLength(ingressSecret, 'utf8') < 32) {
    throw new Error('TEAMS_NAVIGATOR_HMAC_KEY is unavailable');
  }
  const tenantId = requiredUuidEnvironment('TEAMS_TENANT_ID');
  const botAppId = requiredUuidEnvironment('TEAMS_BOT_APP_ID');
  const personalChatEnabledValue = process.env.CYRENE_TEAMS_PERSONAL_CHAT_ENABLED;
  if (personalChatEnabledValue !== undefined && personalChatEnabledValue !== 'true' && personalChatEnabledValue !== 'false') {
    throw new TypeError('CYRENE_TEAMS_PERSONAL_CHAT_ENABLED must be true or false');
  }
  const personalChatEnabled = personalChatEnabledValue === 'true';
  const modelActorSubjectValue = process.env.CYRENE_TEAMS_MODEL_ACTOR_SUBJECT;
  const modelActorSubject = modelActorSubjectValue === undefined || modelActorSubjectValue === ''
    ? undefined
    : requireUuidValue(modelActorSubjectValue, 'CYRENE_TEAMS_MODEL_ACTOR_SUBJECT');
  const allowedTeamIds = requiredCsvEnvironment('TEAMS_ALLOWED_TEAM_IDS');
  const taskActorSubjectsFile = process.env.TEAMS_TASK_ACTOR_SUBJECTS_FILE === undefined
    ? undefined
    : resolve(configText(process.env.TEAMS_TASK_ACTOR_SUBJECTS_FILE, 'TEAMS_TASK_ACTOR_SUBJECTS_FILE', 2_000));
  if (taskActorSubjectsFile !== undefined && !existsSync(taskActorSubjectsFile)) {
    throw new Error('TEAMS_TASK_ACTOR_SUBJECTS_FILE is unavailable');
  }
  const configuredSubjects = taskActorSubjectsFile === undefined
    ? requiredCsvEnvironment('TEAMS_TASK_ACTOR_SUBJECTS')
    : [];
  const taskActorSubjects = configuredSubjects.map(value => {
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u.test(value)) {
      throw new TypeError('TEAMS_TASK_ACTOR_SUBJECTS must contain AAD object UUIDs');
    }
    return value.toLowerCase();
  });
  const baseUrl = requiredEnvironment('CYRENE_EXCHANGE_CONNECTOR_INTERNAL_URL');
  const hmacKeyFile = requiredEnvironment('NAVIGATOR_EXCHANGE_HMAC_KEY_FILE');
  if (!existsSync(hmacKeyFile)) throw new Error('Navigator Exchange HMAC key file is unavailable');
  const hmacKeyId = requiredEnvironment('NAVIGATOR_EXCHANGE_HMAC_KEY_ID');
  const audience = process.env.CYRENE_AUTHORITY_EXCHANGE_WORKLOAD_AUDIENCE ?? 'exchange';
  const exchangeConnectionRef = requiredUuidEnvironment('TEAMS_EXCHANGE_CONNECTION_REF');
  const exchangeProfileRef = requiredEnvironment('TEAMS_EXCHANGE_PROFILE_REF');
  const config: TeamsExecutorConfig = {
    connectorId: 'teams-v1',
    tenantId,
    allowedTeamIds,
    botAppId,
    taskActorSubjects,
    personalChatEnabled,
    ...(modelActorSubject === undefined ? {} : { modelActorSubject }),
    ...(taskActorSubjectsFile === undefined ? {} : { taskActorSubjectsFile }),
    ingressSecretEnv: 'TEAMS_NAVIGATOR_HMAC_KEY',
    exchangeConnectionRef,
    exchangeProfileRef,
    exchangeAuthorization: new ExchangeConnectorAuthorizationClient({ baseUrl, hmacKeyFile, hmacKeyId, audience }),
  };
  const credentialConfigPath = process.env.TEAMS_CREDENTIAL_NOTIFICATIONS_CONFIG_FILE;
  if (credentialConfigPath === undefined) return config;
  const path = resolve(configText(
    credentialConfigPath,
    'TEAMS_CREDENTIAL_NOTIFICATIONS_CONFIG_FILE',
    2_000,
  ));
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch {
    throw new Error('Credential notifications configuration file is unavailable');
  }
  if (raw.byteLength > 64_000) {
    throw new Error('Credential notifications configuration file exceeds its size limit');
  }
  let credentialNotifications: CredentialNotificationsConfig;
  try {
    credentialNotifications = parseCredentialNotificationsConfig(
      JSON.parse(raw.toString('utf8')) as unknown,
      workspaceId,
      tenantId,
      allowedTeamIds,
    );
  } catch {
    throw new Error('Credential notifications configuration is invalid');
  }
  const allowedSubjects = await resolveTeamsTaskActorSubjects(
    config, workspaceId, credentialNotifications.owner.issuer,
  );
  if (!allowedSubjects.includes(credentialNotifications.owner.subject)) {
    throw new Error('Credential notification owner is not in the configured Teams actor scope');
  }
  return { ...config, credentialNotifications };
}

/** Bind Work-resolved private targets to the configured Teams Exchange profile and original actor. */
function createPrivateTeamsMessageSender(
  config: TeamsExecutorConfig,
  workspaceId: string,
): NonNullable<TeamsExecutorConfig['sendPrivateMessage']> | undefined {
  const client = config.exchangeAuthorization;
  if (!(client instanceof ExchangeConnectorAuthorizationClient)) return undefined;
  return async (request: TeamsPersonalMessageSendRequest, signal: AbortSignal) => {
    if (config.personalChatEnabled !== true || request.target_kind !== 'owner_private'
      || !exactKeys(request as unknown as Readonly<Record<string, unknown>>, [
        'requestId', 'conversation', 'tenant_id', 'service_url', 'target_kind', 'actor_aad_object_id', 'text',
      ])) {
      throw new TypeError('Private Teams delivery is not enabled or the host request shape is invalid');
    }
    const conversationInput = request.conversation as unknown as Record<string, unknown>;
    if (!exactKeys(conversationInput, ['vendor', 'account_id', 'conversation_id', 'kind'])
      || conversationInput.vendor !== 'msteams' || conversationInput.kind !== 'private') {
      throw new TypeError('Private Teams conversation scope is invalid');
    }
    const tenantId = requireUuidValue(request.tenant_id, 'private Teams tenant id');
    const botAppId = requireUuidValue(conversationInput.account_id, 'private Teams bot app id');
    const actorAadObjectId = requireUuidValue(request.actor_aad_object_id, 'private Teams actor id');
    if (tenantId !== config.tenantId.toLowerCase() || botAppId !== config.botAppId.toLowerCase()) {
      throw new TypeError('Private Teams route is outside the configured tenant or bot');
    }
    const conversationId = boundedHostText(conversationInput.conversation_id, 'private Teams conversation id', 512);
    const serviceUrl = validateTeamsServiceUrl(request.service_url, tenantId);
    const text = boundedHostText(request.text, 'private Teams message text', 20_000);
    const requestId = boundedHostText(request.requestId, 'private Teams request id', 200);
    const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const currentSubjects = await resolveTeamsTaskActorSubjects(config, workspaceId, issuer);
    if (!currentSubjects.includes(actorAadObjectId)) {
      throw new TypeError('Private Teams route actor is no longer authorized');
    }
    const conversation = { tenantId, botAppId, actorAadObjectId, conversationId, serviceUrl };
    const args = { targetKind: 'owner_private', conversation, text } as const;
    const grant = await client.mintGrant({
      requestId,
      workspaceId,
      principalIssuer: issuer,
      principalSubject: actorAadObjectId,
      connectionRef: config.exchangeConnectionRef,
      providerId: 'msteams',
      profileRef: config.exchangeProfileRef,
      operationId: 'msteams.message.reply',
      resourceRef: `msteams-personal:${sha256(canonicalJson(conversation))}`,
      argumentsDigestSha256: sha256(canonicalJson(args)),
      arguments: args,
    }, signal);
    if (grant.request.principalSubject.toLowerCase() !== actorAadObjectId) {
      throw new TypeError('Exchange private Teams grant actor does not match the Work-resolved owner');
    }
    return client.sendPrivateTeamsMessage({ requestId, targetKind: 'owner_private', conversation, text },
      grant, config.exchangeConnectionRef, config.exchangeProfileRef, signal);
  };
}

function exactKeys(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function requireUuidValue(value: unknown, label: string): string {
  const result = boundedHostText(value, label, 36).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(result)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return result;
}

function boundedHostText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function parseTaskConcurrency(value: string | undefined): number {
  if (value === undefined || value === '') return 2;
  if (!/^\d{1,2}$/u.test(value)) throw new TypeError('CYRENE_EXECUTOR_MAX_CONCURRENT_TASKS must be an integer');
  return validateTaskConcurrency(Number(value), 'CYRENE_EXECUTOR_MAX_CONCURRENT_TASKS');
}

/** Select the top-level task engine independently from the DSH model source. */
export function resolveExecutionBackend(
  override: 'dsh' | 'codebuddy-acp' | 'antigravity-acp' | undefined,
  testMode: boolean,
  environmentValue = process.env.CYRENE_HARNESS_EXECUTION_BACKEND,
): 'dsh' | 'codebuddy-acp' | 'antigravity-acp' {
  if (override !== undefined && !testMode) {
    throw new Error('Execution backend overrides are available only in explicit testMode');
  }
  const configured = override ?? (environmentValue === '' ? undefined : environmentValue) ?? 'dsh';
  if (configured !== 'dsh' && configured !== 'codebuddy-acp' && configured !== 'antigravity-acp') {
    throw new TypeError('CYRENE_HARNESS_EXECUTION_BACKEND must be dsh, codebuddy-acp or antigravity-acp');
  }
  return configured;
}

/** Validate the bounded foreground/background task budget before creating any runtime resources. */
function validateTaskConcurrency(maximum: number, label = 'maxConcurrentTasks'): number {
  if (!Number.isSafeInteger(maximum) || maximum < 2 || maximum > 32) {
    throw new TypeError(`${label} must be between 2 and 32`);
  }
  return maximum;
}

/** Resolve the explicit text-only deployment switch and reject ambiguous environment values. */
function resolveTeamsChatOnly(option: boolean | undefined): boolean {
  const environmentValues = [process.env.CYRENE_TEAMS_CHAT_ONLY, process.env.TEAMS_CHAT_ONLY]
    .filter((value): value is string => value !== undefined);
  if (environmentValues.some(value => value !== 'true' && value !== 'false')) {
    throw new TypeError('CYRENE_TEAMS_CHAT_ONLY and TEAMS_CHAT_ONLY must be true or false');
  }
  if (new Set(environmentValues).size > 1) {
    throw new TypeError('CYRENE_TEAMS_CHAT_ONLY and TEAMS_CHAT_ONLY must agree');
  }
  return option ?? environmentValues[0] === 'true';
}

/** Reject a private connector catalog that would expose any model-callable provider tool. */
function assertEmptyConnectorToolCatalog(value: unknown): void {
  const root = asObject(value, 'private connector tool catalog');
  assertKeys(root, ['schemaVersion', 'items'], 'private connector tool catalog');
  if (root.schemaVersion !== 1 || !Array.isArray(root.items) || root.items.length !== 0) {
    throw new Error('TEAMS_CHAT_ONLY requires an empty connector tool catalog');
  }
}

export function validateConnectorBindingMap(value: unknown): Map<string, ConnectorBindingAuthorization> {
  const root = asObject(value, 'connector binding map');
  assertKeys(root, ['schemaVersion', 'bindings'], 'connector binding map');
  if (root.schemaVersion !== 1 || !Array.isArray(root.bindings)) {
    throw new TypeError('connector binding map must use schemaVersion 1 and a bindings array');
  }
  const projections = new Set<ConnectorResourceProjection>([
    'empty', 'profile', 'github_repository', 'github_pull_request', 'github_ci', 'github_commit', 'github_issue',
    'github_actions_run', 'github_actions_job', 'github_branch', 'github_file', 'github_pull_request_draft',
    'computer_workspace', 'computer_file', 'computer_directory',
    'huggingface_repository', 'cloud_target', 'cloud_operation',
    'azure_devops_source', 'microsoft_graph_plan', 'microsoft_graph_task',
    'microsoft_graph_site', 'microsoft_graph_list', 'microsoft_graph_todo_list', 'microsoft_graph_todo_task',
    'microsoft_graph_calendar', 'microsoft_graph_event', 'microsoft_graph_freebusy',
    'microsoft_graph_drive', 'microsoft_graph_drive_item',
  ]);
  const result = new Map<string, ConnectorBindingAuthorization>();
  const connectionRefs = new Set<string>();
  for (const [index, value] of root.bindings.entries()) {
    const row = asObject(value, `connector binding ${index}`);
    assertKeys(row, ['bindingId', 'connectionRef', 'providerId', 'profileRef', 'tools'], `connector binding ${index}`);
    const bindingId = configText(row.bindingId, 'bindingId', 200);
    const connectionRef = configText(row.connectionRef, 'connectionRef', 64);
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u.test(connectionRef)) {
      throw new TypeError(`connector binding ${index} connectionRef must be an Exchange UUID`);
    }
    const providerId = configText(row.providerId, 'providerId', 64);
    if (!['github', 'huggingface', 'azure', 'gcp', 'runpod', 'computer', 'azure_devops', 'microsoft_graph'].includes(providerId)) {
      throw new TypeError(`connector binding ${index} providerId is not supported`);
    }
    const profileRef = configText(row.profileRef, 'profileRef', 512);
    if (!Array.isArray(row.tools) || row.tools.length === 0) {
      throw new TypeError(`connector binding ${index} must declare tools`);
    }
    if (result.has(bindingId) || connectionRefs.has(connectionRef.toLowerCase())) {
      throw new TypeError('connector binding IDs and Exchange connection refs must be unique');
    }
    const toolIds = new Set<string>();
    const tools = row.tools.map((toolValue, toolIndex) => {
      const tool = asObject(toolValue, `connector binding ${index} tool ${toolIndex}`);
      assertKeys(tool, ['toolId', 'operationId', 'resourceProjection', 'mutating'], `connector binding ${index} tool ${toolIndex}`);
      const toolId = configText(tool.toolId, 'toolId', 200);
      const operationId = configText(tool.operationId, 'operationId', 256);
      if (!projections.has(tool.resourceProjection as ConnectorResourceProjection)) {
        throw new TypeError(`connector binding ${index} tool ${toolIndex} has an invalid resourceProjection`);
      }
      if (typeof tool.mutating !== 'boolean' || toolIds.has(toolId)) {
        throw new TypeError(`connector binding ${index} tool ${toolIndex} must have a unique toolId and mutating flag`);
      }
      const canonical = connectorOperationPolicy(providerId, operationId);
      if (toolId !== canonical.toolId) {
        throw new TypeError(`connector binding ${index} tool ${toolIndex} does not match the canonical tool mapping`);
      }
      if (tool.mutating !== canonical.mutating || tool.resourceProjection !== canonical.resourceProjection) {
        throw new TypeError(`connector binding ${index} tool ${toolIndex} does not match the canonical operation policy`);
      }
      toolIds.add(toolId);
      return {
        toolId,
        operationId,
        resourceProjection: tool.resourceProjection as ConnectorResourceProjection,
        mutating: tool.mutating,
      };
    });
    result.set(bindingId, { bindingId, connectionRef: connectionRef.toLowerCase(), providerId, profileRef, tools });
    connectionRefs.add(connectionRef.toLowerCase());
  }
  return result;
}

/** Join host repository labels to trusted GitHub bindings for display only. */
export function buildGithubBindingDisplayHints(
  bindings: ReadonlyMap<string, ConnectorBindingAuthorization>,
  targets: readonly ResponsibilityTargetConfig[] | undefined,
): ReadonlyMap<string, GithubBindingDisplayHint> {
  const targetsByBinding = new Map<string, ResponsibilityTargetConfig[]>();
  for (const target of targets ?? []) {
    if (bindings.get(target.bindingId)?.providerId !== 'github') continue;
    const matches = targetsByBinding.get(target.bindingId) ?? [];
    matches.push(target);
    targetsByBinding.set(target.bindingId, matches);
  }

  const hints = new Map<string, GithubBindingDisplayHint>();
  for (const [bindingId, binding] of bindings) {
    if (binding.providerId !== 'github') continue;
    const matches = targetsByBinding.get(bindingId) ?? [];
    if (matches.length !== 1) continue;
    const target = matches[0];
    if (target === undefined || !isSafeGithubRepositoryLabel(target.label)
      || target.uri !== `https://github.com/${target.label}`) continue;
    hints.set(bindingId, { label: target.label, uri: target.uri });
  }
  return hints;
}

function isSafeGithubRepositoryLabel(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value);
}

function connectorOperationPolicy(
  providerId: string,
  operationId: string,
): {
  readonly toolId: string;
  readonly mutating: boolean;
  readonly resourceProjection: ConnectorResourceProjection;
} {
  const policies: Readonly<Record<string, {
    readonly toolId: string;
    readonly mutating: boolean;
    readonly resourceProjection: ConnectorResourceProjection;
  }>> = {
    'github.repository.list': { toolId: 'github.repository.list', mutating: false, resourceProjection: 'profile' },
    'github.repository.get': { toolId: 'github.repository.get', mutating: false, resourceProjection: 'github_repository' },
    'github.branches.list': { toolId: 'github.branches.list', mutating: false, resourceProjection: 'github_repository' },
    'github.pull_requests.list': { toolId: 'github.pull_requests.list', mutating: false, resourceProjection: 'github_repository' },
    'github.pull_request.get': { toolId: 'github.pull_request.get', mutating: false, resourceProjection: 'github_pull_request' },
    'github.actions.runs.list': { toolId: 'github.actions.runs.list', mutating: false, resourceProjection: 'github_repository' },
    'github.issues.search': { toolId: 'github.issues.search', mutating: false, resourceProjection: 'github_repository' },
    'github.actions.jobs.list': { toolId: 'github.actions.jobs.list', mutating: false, resourceProjection: 'github_actions_run' },
    'github.actions.job.logs.read': { toolId: 'github.actions.job.logs.read', mutating: false, resourceProjection: 'github_actions_job' },
    'github.actions.rerun_failed': { toolId: 'github.actions.rerun_failed', mutating: true, resourceProjection: 'github_actions_run' },
    'github.branch.get': { toolId: 'github.branch.get', mutating: false, resourceProjection: 'github_branch' },
    'github.branch.create': { toolId: 'github.branch.create', mutating: true, resourceProjection: 'github_branch' },
    'github.branch.delete': { toolId: 'github.branch.delete', mutating: true, resourceProjection: 'github_branch' },
    'github.file.get': { toolId: 'github.file.get', mutating: false, resourceProjection: 'github_file' },
    'github.file.commit': { toolId: 'github.file.commit', mutating: true, resourceProjection: 'github_file' },
    'github.pull_request.draft.find': {
      toolId: 'github.pull_request.draft.find', mutating: false, resourceProjection: 'github_pull_request_draft',
    },
    'github.pull_request.draft.create': {
      toolId: 'github.pull_request.draft.create', mutating: true, resourceProjection: 'github_pull_request_draft',
    },
    'github.ci.status': { toolId: 'github.ci.status', mutating: false, resourceProjection: 'github_commit' },
    'github.issue.get': { toolId: 'github.issue.get', mutating: false, resourceProjection: 'github_issue' },
    'github.issue.comment.create': { toolId: 'github.issue.comment.create', mutating: true, resourceProjection: 'github_issue' },
    'github.issue.state.update': { toolId: 'github.issue.state.update', mutating: true, resourceProjection: 'github_issue' },
    'github.vendor.cli.execute': { toolId: 'github_vendor_cli', mutating: true, resourceProjection: 'profile' },
    'computer.command.execute': {
      toolId: 'computer.command.execute', mutating: true, resourceProjection: 'computer_workspace',
    },
    'computer.file.read': { toolId: 'computer.file.read', mutating: false, resourceProjection: 'computer_file' },
    'computer.file.write': { toolId: 'computer.file.write', mutating: true, resourceProjection: 'computer_file' },
    'computer.directory.list': {
      toolId: 'computer.directory.list', mutating: false, resourceProjection: 'computer_directory',
    },
    'huggingface.models.list': { toolId: 'huggingface.models.list', mutating: false, resourceProjection: 'profile' },
    'huggingface.datasets.list': { toolId: 'huggingface.datasets.list', mutating: false, resourceProjection: 'profile' },
    'huggingface.spaces.list': { toolId: 'huggingface.spaces.list', mutating: false, resourceProjection: 'profile' },
    'huggingface.repo.get': { toolId: 'huggingface.repo.get', mutating: false, resourceProjection: 'huggingface_repository' },
    'huggingface.file.download': { toolId: 'huggingface.file.download', mutating: false, resourceProjection: 'huggingface_repository' },
    'huggingface.file.upload': { toolId: 'huggingface.file.upload', mutating: true, resourceProjection: 'huggingface_repository' },
    'huggingface.vendor.cli.execute': { toolId: 'hf_vendor_cli', mutating: true, resourceProjection: 'profile' },
    'cloud.provider.health.read': { toolId: 'cloud_provider_health', mutating: false, resourceProjection: 'profile' },
    'cloud.resources.list': { toolId: 'cloud_resources_list', mutating: false, resourceProjection: 'cloud_target' },
    'cloud.resource.get': { toolId: 'cloud_resource_get', mutating: false, resourceProjection: 'cloud_target' },
    'cloud.resource.create': { toolId: 'cloud_resource_create', mutating: true, resourceProjection: 'cloud_target' },
    'cloud.resource.deploy': { toolId: 'cloud_resource_deploy', mutating: true, resourceProjection: 'cloud_target' },
    'cloud.resource.start': { toolId: 'cloud_resource_start', mutating: true, resourceProjection: 'cloud_target' },
    'cloud.resource.stop': { toolId: 'cloud_resource_stop', mutating: true, resourceProjection: 'cloud_target' },
    'cloud.resource.restart': { toolId: 'cloud_resource_restart', mutating: true, resourceProjection: 'cloud_target' },
    'cloud.resource.update': { toolId: 'cloud_resource_update', mutating: true, resourceProjection: 'cloud_target' },
    'cloud.resource.delete': { toolId: 'cloud_resource_delete', mutating: true, resourceProjection: 'cloud_target' },
    'cloud.operation.status.read': { toolId: 'cloud_operation_status', mutating: false, resourceProjection: 'cloud_operation' },
    'cloud.operation.logs.read': { toolId: 'cloud_operation_logs', mutating: false, resourceProjection: 'cloud_operation' },
    'cloud.operation.cancel': { toolId: 'cloud_operation_cancel', mutating: true, resourceProjection: 'cloud_operation' },
    'cloud.vendor.cli.execute': { toolId: 'cloud_vendor_cli', mutating: true, resourceProjection: 'profile' },
    'azure_devops.observations.poll': {
      toolId: 'azure_devops.observations.poll', mutating: false, resourceProjection: 'azure_devops_source',
    },
    'microsoft_graph.planner.plans.list': {
      toolId: 'microsoft_graph.planner.plans.list', mutating: false, resourceProjection: 'microsoft_graph_plan',
    },
    'microsoft_graph.planner.plan.get': {
      toolId: 'microsoft_graph.planner.plan.get', mutating: false, resourceProjection: 'microsoft_graph_plan',
    },
    'microsoft_graph.planner.tasks.list': {
      toolId: 'microsoft_graph.planner.tasks.list', mutating: false, resourceProjection: 'microsoft_graph_plan',
    },
    'microsoft_graph.planner.task.get': {
      toolId: 'microsoft_graph.planner.task.get', mutating: false, resourceProjection: 'microsoft_graph_task',
    },
    'microsoft_graph.planner.task.create': {
      toolId: 'microsoft_graph.planner.task.create', mutating: true, resourceProjection: 'microsoft_graph_task',
    },
    'microsoft_graph.planner.task.update': {
      toolId: 'microsoft_graph.planner.task.update', mutating: true, resourceProjection: 'microsoft_graph_task',
    },
    'microsoft_graph.sharepoint.site.get': {
      toolId: 'microsoft_graph.sharepoint.site.get', mutating: false, resourceProjection: 'microsoft_graph_site',
    },
    'microsoft_graph.sharepoint.list.get': {
      toolId: 'microsoft_graph.sharepoint.list.get', mutating: false, resourceProjection: 'microsoft_graph_list',
    },
    'microsoft_graph.sharepoint.list.items.delta': {
      toolId: 'microsoft_graph.sharepoint.list.items.delta', mutating: false, resourceProjection: 'microsoft_graph_list',
    },
    'microsoft_graph.todo.lists.list': {
      toolId: 'microsoft_graph.todo.lists.list', mutating: false, resourceProjection: 'microsoft_graph_todo_list',
    },
    'microsoft_graph.todo.tasks.list': {
      toolId: 'microsoft_graph.todo.tasks.list', mutating: false, resourceProjection: 'microsoft_graph_todo_list',
    },
    'microsoft_graph.todo.task.get': {
      toolId: 'microsoft_graph.todo.task.get', mutating: false, resourceProjection: 'microsoft_graph_todo_task',
    },
    'microsoft_graph.todo.task.create': {
      toolId: 'microsoft_graph.todo.task.create', mutating: true, resourceProjection: 'microsoft_graph_todo_task',
    },
    'microsoft_graph.todo.task.update': {
      toolId: 'microsoft_graph.todo.task.update', mutating: true, resourceProjection: 'microsoft_graph_todo_task',
    },
    'microsoft_graph.todo.task.delete': {
      toolId: 'microsoft_graph.todo.task.delete', mutating: true, resourceProjection: 'microsoft_graph_todo_task',
    },
    'microsoft_graph.calendar.calendars.list': {
      toolId: 'microsoft_graph.calendar.calendars.list', mutating: false, resourceProjection: 'microsoft_graph_calendar',
    },
    'microsoft_graph.calendar.events.list': {
      toolId: 'microsoft_graph.calendar.events.list', mutating: false, resourceProjection: 'microsoft_graph_calendar',
    },
    'microsoft_graph.calendar.event.get': {
      toolId: 'microsoft_graph.calendar.event.get', mutating: false, resourceProjection: 'microsoft_graph_event',
    },
    'microsoft_graph.calendar.event.create': {
      toolId: 'microsoft_graph.calendar.event.create', mutating: true, resourceProjection: 'microsoft_graph_event',
    },
    'microsoft_graph.calendar.event.update': {
      toolId: 'microsoft_graph.calendar.event.update', mutating: true, resourceProjection: 'microsoft_graph_event',
    },
    'microsoft_graph.calendar.event.delete': {
      toolId: 'microsoft_graph.calendar.event.delete', mutating: true, resourceProjection: 'microsoft_graph_event',
    },
    'microsoft_graph.calendar.freebusy.get': {
      toolId: 'microsoft_graph.calendar.freebusy.get', mutating: false, resourceProjection: 'microsoft_graph_freebusy',
    },
    'microsoft_graph.sharepoint.drives.list': {
      toolId: 'microsoft_graph.sharepoint.drives.list', mutating: false, resourceProjection: 'microsoft_graph_drive',
    },
    'microsoft_graph.sharepoint.drive.items.list': {
      toolId: 'microsoft_graph.sharepoint.drive.items.list', mutating: false, resourceProjection: 'microsoft_graph_drive_item',
    },
  };
  const policy = policies[operationId];
  if (!policy) throw new TypeError(`Connector operation ${operationId} is not in the canonical operation table`);
  const providerAllowed = providerId === 'github'
    ? operationId.startsWith('github.')
    : providerId === 'huggingface'
      ? operationId.startsWith('huggingface.')
      : providerId === 'computer'
        ? operationId.startsWith('computer.')
        : providerId === 'azure_devops'
          ? operationId.startsWith('azure_devops.')
          : providerId === 'microsoft_graph'
            ? operationId.startsWith('microsoft_graph.')
            : ['azure', 'gcp', 'runpod'].includes(providerId) && operationId.startsWith('cloud.');
  if (!providerAllowed || (operationId === 'cloud.resource.restart' && providerId !== 'runpod')) {
    throw new TypeError(`Connector operation ${operationId} is not valid for provider ${providerId}`);
  }
  return policy;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredUuidEnvironment(name: string): string {
  const value = requiredEnvironment(name);
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function requiredCsvEnvironment(name: string): string[] {
  const values = requiredEnvironment(name).split(',').map(value => value.trim());
  if (values.length === 0 || values.some(value => value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value))
    || new Set(values).size !== values.length) {
    throw new TypeError(`${name} must contain unique non-empty values`);
  }
  return values;
}

function configText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`Invalid connector ${label}`);
  return value;
}

/** Read the host-authored responsibility allowlist without following symlinks or accepting model-supplied scope. */
async function readHostResponsibilityTargets(pathValue: string): Promise<readonly ResponsibilityTargetConfig[]> {
  const path = resolve(configText(pathValue, 'CYRENE_RESPONSIBILITY_TARGETS_FILE', 2_000));
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 512_000
    || (metadata.mode & 0o022) !== 0) {
    throw new TypeError('Responsibility target config must be a bounded regular host file');
  }
  const root = asObject(JSON.parse(await readFile(path, 'utf8')) as unknown, 'responsibility target config');
  assertKeys(root, ['schemaVersion', 'targets'], 'responsibility target config');
  if (root.schemaVersion !== 1 || !Array.isArray(root.targets) || root.targets.length < 1 || root.targets.length > 100) {
    throw new TypeError('Responsibility target config must use schemaVersion 1 and a bounded targets array');
  }
  return root.targets.map((targetValue, index) => {
    const target = asObject(targetValue, `responsibility target ${index}`);
    assertKeys(target, ['id', 'label', 'bindingId', 'uri', 'actionGrants'], `responsibility target ${index}`);
    if (!Array.isArray(target.actionGrants) || target.actionGrants.length > 100) {
      throw new TypeError(`responsibility target ${index} actionGrants must be a bounded array`);
    }
    const actionGrants = target.actionGrants.map((grantValue, grantIndex) => {
      const grant = asObject(grantValue, `responsibility target ${index} action grant ${grantIndex}`);
      assertKeys(grant, [
        'id', 'action', 'baseBranches', 'branchPrefixes', 'pathPrefixes', 'issueNumbers', 'sourceWorkflowIds',
        'permittedOperations',
      ], `responsibility target ${index} action grant ${grantIndex}`);
      if (!['draft_pull_request', 'rerun_source_ci', 'update_issue_progress'].includes(String(grant.action))) {
        throw new TypeError(`responsibility target ${index} action grant ${grantIndex} has an unsupported action`);
      }
      const strings = (value: unknown, label: string): readonly string[] => {
        if (!Array.isArray(value) || value.length > 100) throw new TypeError(`${label} must be a bounded string array`);
        return value.map((item, itemIndex) => configText(item, `${label}[${itemIndex}]`, 512));
      };
      if (!Array.isArray(grant.issueNumbers) || grant.issueNumbers.length > 100
        || grant.issueNumbers.some(item => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1)) {
        throw new TypeError(`responsibility target ${index} action grant ${grantIndex} issueNumbers are invalid`);
      }
      return {
        id: configText(grant.id, 'responsibility action grant id', 100),
        action: grant.action as ResponsibilityTargetConfig['actionGrants'][number]['action'],
        baseBranches: strings(grant.baseBranches, 'baseBranches'),
        branchPrefixes: strings(grant.branchPrefixes, 'branchPrefixes'),
        pathPrefixes: strings(grant.pathPrefixes, 'pathPrefixes'),
        issueNumbers: grant.issueNumbers as number[],
        sourceWorkflowIds: strings(grant.sourceWorkflowIds, 'sourceWorkflowIds'),
        permittedOperations: strings(grant.permittedOperations, 'permittedOperations') as ResponsibilityTargetConfig['actionGrants'][number]['permittedOperations'],
      };
    });
    return {
      id: configText(target.id, `responsibility target ${index} id`, 32),
      label: configText(target.label, `responsibility target ${index} label`, 256),
      bindingId: configText(target.bindingId, `responsibility target ${index} bindingId`, 200),
      uri: configText(target.uri, `responsibility target ${index} uri`, 512),
      actionGrants,
    };
  });
}

export function currentResponsibilityModelPolicy(
  ctx: Context,
  codeBuddyAcpModel?: string,
): WorkflowV2Write['modelPolicy'] | undefined {
  if (codeBuddyAcpModel !== undefined) {
    return {
      preferredProvider: 'codebuddy',
      preferredModel: codeBuddyAcpModel,
      fallback: 'configured_no_additional_spend',
    };
  }
  const selection = ctx.get('agentDefaultModel')?.currentSelection();
  if (selection === undefined) return undefined;
  const preferredProvider = selection.provider === 'cyrene-exchange' ? 'exchange' : selection.provider;
  if (!['antigravity', 'codebuddy', 'exchange'].includes(preferredProvider)) return undefined;
  return {
    preferredProvider: preferredProvider as WorkflowV2Write['modelPolicy']['preferredProvider'],
    preferredModel: selection.model,
    fallback: 'configured_no_additional_spend',
  };
}

/** Load the private Exchange-exported provider catalog without inline secrets. | 读取私有 Exchange provider catalog。 */
async function readHostConnectorToolCatalog(path: string): Promise<unknown> {
  try {
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_CONNECTOR_TOOL_CATALOG_BYTES) {
      throw new TypeError('Connector tool catalog must be a bounded regular file');
    }
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new Error('CYRENE_CONNECTOR_TOOL_CATALOG_FILE is unavailable or invalid');
  }
}

/** Parse the host-only CLI deployment file without accepting inline secret values. | 解析仅由宿主管理且不含内联凭据的部署文件。 */
function parseHostSubagentConfig(value: unknown): SubagentAdapterConfig {
  const root = asObject(value, 'subagent config');
  assertKeys(root, ['deployments', 'timeoutMs', 'disposeGraceMs'], 'subagent config');
  if (!Array.isArray(root.deployments)) throw new TypeError('subagent config deployments must be an array');
  const deployments = root.deployments.map((entry, index) => {
    const row = asObject(entry, `subagent deployment ${index}`);
    assertKeys(row, ['backend', 'providerName', 'command', 'argv', 'cwd', 'envRefs'], `subagent deployment ${index}`);
    if (row.backend !== 'antigravity' && row.backend !== 'codebuddy' && row.backend !== 'acp') {
      throw new TypeError(`subagent deployment ${index} has an unsupported backend`);
    }
    const backend = row.backend as SubagentAdapterConfig['deployments'][number]['backend'];
    if (typeof row.command !== 'string' || row.command.trim().length === 0) {
      throw new TypeError(`subagent deployment ${index} requires a command`);
    }
    if (row.providerName !== undefined && typeof row.providerName !== 'string') {
      throw new TypeError(`subagent deployment ${index} providerName must be text`);
    }
    if (row.cwd !== undefined && typeof row.cwd !== 'string') {
      throw new TypeError(`subagent deployment ${index} cwd must be text`);
    }
    if (row.argv !== undefined && (!Array.isArray(row.argv) || row.argv.some(item => typeof item !== 'string'))) {
      throw new TypeError(`subagent deployment ${index} argv must be a string array`);
    }
    let envRefs: Record<string, string> | undefined;
    if (row.envRefs !== undefined) {
      const refs = asObject(row.envRefs, `subagent deployment ${index} envRefs`);
      envRefs = {};
      for (const [childName, hostName] of Object.entries(refs)) {
        if (typeof hostName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(childName)
          || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(hostName)) {
          throw new TypeError(`subagent deployment ${index} envRefs must map environment names to environment names`);
        }
        envRefs[childName] = hostName;
      }
    }
    return {
      backend,
      command: row.command,
      ...(row.providerName === undefined ? {} : { providerName: row.providerName }),
      ...(row.argv === undefined ? {} : { argv: row.argv as string[] }),
      ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
      ...(envRefs === undefined ? {} : { envRefs }),
    };
  });
  for (const key of ['timeoutMs', 'disposeGraceMs'] as const) {
    const number = root[key];
    if (number !== undefined && (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1)) {
      throw new TypeError(`subagent config ${key} must be a positive integer`);
    }
  }
  return {
    deployments,
    ...(root.timeoutMs === undefined ? {} : { timeoutMs: root.timeoutMs as number }),
    ...(root.disposeGraceMs === undefined ? {} : { disposeGraceMs: root.disposeGraceMs as number }),
  };
}

/** Bind native child tools, lifecycle events, and ACP permission to durable parent Work Tasks. | 将原生子 Agent 工具与 ACP 权限绑定到持久父任务。 */
async function registerNativeSubagents(
  ctx: Context,
  executor: NavigatorExecutor,
  workBridge: WorkAssistantBridge | undefined,
  config: SubagentAdapterConfig,
): Promise<void> {
  const runtime = await import('@deepseek-ai/dsh-subagent');
  await ctx.plugin(runtime.SubagentRuntime, { maxActiveSubagents: 4, maxDepth: 2 });
  const providerDisposer = registerSubagents(ctx, {
    ...config,
    onEvent: event => publishSubagentEvent(executor, event),
    requestPermission: async request => {
      if (!workBridge || request.signal.aborted) return 'deny';
      const taskId = executor.activeTaskId(String(request.parentSessionId));
      if (!taskId) return 'deny';
      try {
        await workBridge.requestApproval(
          String(request.parentSessionId),
          'native_subagent_permission',
          request.title ?? `${request.backend} requested ${request.tool}`,
          {
            providerName: request.providerName,
            backend: request.backend,
            runId: request.runId,
            conversationId: request.conversationId,
            requestId: request.requestId,
            tool: request.tool,
            ...(request.rawInput === undefined ? {} : { rawInput: request.rawInput }),
          },
          request.signal,
          `subagent:${request.runId}:${String(request.requestId)}`,
        );
        return 'allow-once';
      } catch {
        return 'deny';
      }
    },
  });
  ctx.effect(() => providerDisposer, 'navigator.nativeSubagents');

  const toolPlugin = await import('@deepseek-ai/dsh-tool-subagent');
  const names = new Set<string>();
  for (const deployment of config.deployments) {
    const providerName = deployment.providerName ?? deployment.backend;
    const toolName = `subagent_${providerName.replace(/[^A-Za-z0-9_]/gu, '_')}`;
    if (names.has(toolName)) throw new TypeError('subagent provider names collide after tool-name normalization');
    names.add(toolName);
    await ctx.plugin(toolPlugin, {
      provider: providerName,
      toolName,
      maxDepth: 'provider-managed',
      enableRunInBackground: false,
    });
  }
}

function publishSubagentEvent(executor: NavigatorExecutor, event: SubagentAdapterEvent): void {
  const taskId = executor.activeTaskId(String(event.parentSessionId));
  if (!taskId) return;
  const timestamp = Date.now();
  if (event.type === 'progress') {
    void executor.recordSubagentEvent(taskId, {
      type: 'subagent-progress', taskId, provider: event.providerName,
      phase: event.phase, message: event.status, timestamp,
    });
  } else if (event.type === 'assistant-delta') {
    void executor.recordSubagentEvent(taskId, {
      type: 'subagent-assistant-delta', taskId, provider: event.providerName,
      text: event.text, timestamp,
    });
  } else if (event.type === 'blocked') {
    void executor.recordSubagentEvent(taskId, {
      type: 'subagent-blocked', taskId, provider: event.providerName, runId: String(event.runId),
      reasonCode: event.reasonCode, toolCategory: event.toolCategory, count: event.count, timestamp,
    });
  } else {
    void executor.recordSubagentEvent(taskId, {
      type: 'permission', taskId, provider: event.providerName,
      tool: event.tool, decision: event.decision, timestamp,
    });
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).find(key => !allow.has(key));
  if (unknown !== undefined) throw new TypeError(`${label} contains unsupported field ${unknown}`);
}
