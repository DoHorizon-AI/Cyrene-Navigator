// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Connector provider operation outcome regression             │
// │ Role: Verify pending receipts fence replay until exact status checks. │
// │ 模块职责：验证长操作回执与状态对账阻止重复写入。                       │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { canonicalJson, sha256 } from '../dist/connector-authorization.js';
import { validateConnectorBindingMap } from '../dist/serve.js';
import { registerToolProviders } from '../dist/tool-providers.js';
import { registerWorkTools, WorkAssistantBridge } from '../dist/work-tools.js';

const bindingId = 'exchange-azure-11111111-1111-4111-8111-111111111111';
const connectionRef = '11111111-1111-4111-8111-111111111111';
const profileRef = 'azure-profile-1';
const ownerId = '11111111-1111-4111-8111-111111111111';
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
const sessionId = 'teams-session-1';
const taskId = 'teams-task-1';
const stopToolId = 'cloud_resource_stop';
const statusToolId = 'cloud_operation_status';

const tools = {
  tools: [
    {
      id: stopToolId,
      name: 'Stop cloud resource',
      description: 'Stop one exact cloud resource.',
      readOnly: false,
      inputSchema: {
        type: 'object',
        properties: {
          profile_ref: { type: 'string', pattern: '^[a-z]+-profile-[0-9]+$' },
          target: {
            type: 'object',
            properties: { resource_id: { type: 'string', maxLength: 2048 } },
            required: ['resource_id'],
            additionalProperties: false,
          },
        },
        required: ['profile_ref', 'target'],
        additionalProperties: false,
      },
    },
    {
      id: statusToolId,
      name: 'Read cloud operation status',
      description: 'Read one exact provider operation.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { profile_ref: { type: 'string' }, operation_ref: { type: 'string' } },
        required: ['profile_ref', 'operation_ref'],
        additionalProperties: false,
      },
    },
  ],
};

function createHarness(providerResponses = [
  {
    requestId: 'pending-call', outcome: 'pending', operationRef: 'azure-operation-42',
    result: {
      content: [{ type: 'text', text: JSON.stringify({ state: 'RUNNING', operation_ref: 'azure-operation-42' }) }],
      isError: false,
    },
  },
  {
    requestId: 'status-call', outcome: 'verified', operationRef: 'azure-operation-42',
    result: {
      content: [{ type: 'text', text: JSON.stringify({ state: 'SUCCEEDED', operation_ref: 'azure-operation-42' }) }],
      isError: false,
    },
  },
  {
    requestId: 'verified-call', outcome: 'verified',
    result: { content: [{ type: 'text', text: JSON.stringify({ state: 'STOPPED' }) }], isError: false },
  },
], options = {}) {
  const configuredBindingId = options.bindingId ?? bindingId;
  const configuredConnectionRef = options.connectionRef ?? connectionRef;
  const configuredProfileRef = options.profileRef ?? profileRef;
  const configuredProviderId = options.providerId ?? 'azure';
  const catalog = options.catalog ?? tools;
  const authorizedTools = options.authorizedTools ?? [
    { toolId: stopToolId, operationId: 'cloud.resource.stop', resourceProjection: 'cloud_target', mutating: true },
    { toolId: statusToolId, operationId: 'cloud.operation.status.read', resourceProjection: 'cloud_operation', mutating: false },
  ];
  const events = [];
  const receipts = new Map();
  const client = {
    mintCount: 0,
    callCount: 0,
    mintInputs: [],
    providerInputs: [],
    async mintGrant(input) {
      this.mintCount += 1;
      this.mintInputs.push(input);
      return {
        connectorGrantBin: 'AQ==', grantRef: `grant-${this.mintCount}`, audience: 'exchange',
        organizationId: 'org-1', issuedAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 15, request: input,
      };
    },
    async callProviderOperation(input) {
      this.callCount += 1;
      this.providerInputs.push(input);
      const response = providerResponses.shift();
      if (!response) throw new Error('Unexpected provider call');
      return { ...response, requestId: input.requestId };
    },
  };
  const bridge = {
    async request(path, method, body) {
      events.push({ type: 'request', path, method, body });
      if (path === '/tool-providers' && method === 'GET') {
        return {
          items: [{
            bindingId: configuredBindingId,
            capabilityId: 'tool.provider.v1',
            providerId: configuredProviderId,
            connectionRef: configuredConnectionRef,
            profileRef: configuredProfileRef,
          }],
        };
      }
      if (path === `/tool-providers/${encodeURIComponent(configuredBindingId)}/tools` && method === 'GET') return catalog;
      if (path === `/tasks/${taskId}` && method === 'GET') {
        return { metadata: { teamsCaller: { issuer, subject: ownerId, tenantId } } };
      }
      if (path.startsWith('/operations/unresolved') && method === 'GET') {
        const target = new URLSearchParams(path.split('?')[1] ?? '').get('target');
        const items = [...receipts.values()].filter(receipt => receipt.status !== 'verified'
          && (target === null || receipt.target === target));
        return { items };
      }
      const patch = path.match(/^\/operations\/([^/]+)$/u);
      if (patch && method === 'PATCH') {
        const prior = receipts.get(patch[1]);
        if (!prior) throw new Error('Unknown receipt');
        Object.assign(prior, { status: body.status, evidence: body.evidence });
        return { operation: prior };
      }
      throw new Error(`Unexpected bridge request ${method} ${path}`);
    },
    async requestApproval() { throw new Error('Teams connector operations do not use a second approval'); },
    async mutate(execution, path, method, body) {
      events.push({ type: 'mutate', path, method, body });
      if (path !== '/operations' || method !== 'POST') throw new Error('Unexpected bridge mutation');
      const id = `operation-${receipts.size + 1}`;
      const receipt = { id, status: 'started', target: body.target, evidence: {} };
      receipts.set(id, receipt);
      return { operation: receipt, duplicate: false };
    },
  };
  const bindingAuthorization = {
    bindingId: configuredBindingId,
    connectionRef: configuredConnectionRef,
    providerId: configuredProviderId,
    profileRef: configuredProfileRef,
    tools: authorizedTools,
  };
  return { bridge, client, events, receipts, bindingAuthorization };
}

async function setupHarness(fixture) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const dispose = await registerToolProviders(ctx, {
    bridge: fixture.bridge,
    taskIdForSession: value => value === sessionId ? taskId : undefined,
    connectorAuthorization: {
      client: fixture.client,
      workspaceId: 'workspace-1',
      bindings: new Map([[fixture.bindingAuthorization.bindingId, fixture.bindingAuthorization]]),
    },
  });
  return { ctx, dispose };
}

function toolName(ctx, label, configuredBindingId = bindingId) {
  return ctx.tools.schemas()
    .find(schema => schema.description.startsWith(`${label} (configured provider ${configuredBindingId})`))?.name;
}

async function execute(ctx, name, argumentsValue, callId) {
  return ctx.tools.execute({
    name,
    callId: ToolCallId(callId),
    arguments: argumentsValue,
    signal: new AbortController().signal,
    agent: { id: 'navigator-agent', session: { id: sessionId } },
  });
}

test('pending provider results fence writes until matching terminal status reconciliation', async () => {
  const fixture = createHarness();
  const { ctx, dispose } = await setupHarness(fixture);
  try {
    const stopName = toolName(ctx, 'Stop cloud resource');
    const statusName = toolName(ctx, 'Read cloud operation status');
    assert.ok(stopName);
    assert.ok(statusName);
    const target = { resource_id: '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/vm-1' };

    const pending = await execute(ctx, stopName, { profile_ref: profileRef, target }, 'pending-call');
    assert.equal(pending.isError, false);
    assert.equal(pending.value.structuredContent.outcome, 'pending');
    assert.equal(pending.value.structuredContent.operationRef, 'azure-operation-42');
    const firstReceipt = fixture.receipts.get('operation-1');
    assert.equal(firstReceipt.status, 'uncertain');
    assert.equal(firstReceipt.evidence.operationRef, 'azure-operation-42');

    const blocked = await execute(ctx, stopName, { profile_ref: profileRef, target }, 'blocked-call');
    assert.equal(blocked.isError, true);
    assert.match(blocked.error.message, /operation status before retrying/u);
    assert.equal(fixture.client.callCount, 1);
    assert.equal(fixture.client.mintCount, 1);

    const reconciled = await execute(ctx, statusName, {
      profile_ref: profileRef, operation_ref: 'azure-operation-42',
    }, 'status-call');
    assert.equal(reconciled.isError, false);
    assert.equal(fixture.client.callCount, 2);
    assert.equal(firstReceipt.status, 'verified');
    assert.equal(firstReceipt.evidence.reconciliationState, 'SUCCEEDED');

    const resumed = await execute(ctx, stopName, { profile_ref: profileRef, target }, 'verified-call');
    assert.equal(resumed.isError, false);
    assert.equal(fixture.client.callCount, 3);
    assert.equal(fixture.receipts.get('operation-2').status, 'verified');
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('REMOTE_STATE_UNVERIFIED and remote_state UNKNOWN cannot be marked verified', async () => {
  const fixture = createHarness([{
    requestId: 'unverified-call', outcome: 'verified', operationRef: 'cli-operation-unknown',
    result: {
      content: [{ type: 'text', text: JSON.stringify({
        state: 'REMOTE_STATE_UNVERIFIED',
        command_state: 'COMMAND_COMPLETED',
        remote_state: 'UNKNOWN',
        operation_ref: 'cli-operation-unknown',
      }) }],
      isError: false,
    },
  }]);
  const { ctx, dispose } = await setupHarness(fixture);
  try {
    const stopName = toolName(ctx, 'Stop cloud resource');
    assert.ok(stopName);
    const result = await execute(ctx, stopName, {
      profile_ref: profileRef,
      target: { resource_id: '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/vm-1' },
    }, 'unverified-call');
    assert.equal(result.isError, true);
    assert.match(result.error.message, /cli-operation-unknown/u);
    const receipt = fixture.receipts.get('operation-1');
    assert.equal(receipt.status, 'uncertain');
    assert.equal(receipt.evidence.outcome, 'uncertain');
    assert.equal(receipt.evidence.operationRef, 'cli-operation-unknown');
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('verified GitHub CI reads preserve PENDING, RUNNING, and ERROR as business state', async () => {
  const githubBindingId = 'exchange-github-44444444-4444-4444-8444-444444444444';
  const githubCiTool = {
    id: 'github.ci.status',
    name: 'Read GitHub CI status',
    description: 'Read the latest status for one commit.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        repository_id: { type: 'string' },
        repository: { type: 'string' },
        commit_sha: { type: 'string' },
      },
      required: ['repository_id', 'repository', 'commit_sha'],
      additionalProperties: false,
    },
  };
  const ciStates = ['PENDING', 'RUNNING', 'ERROR'];
  const fixture = createHarness([
    ...ciStates.map((state, index) => ({
      requestId: `github-ci-${index}`,
      outcome: 'verified',
      result: {
        content: [{ type: 'text', text: JSON.stringify({ state }) }],
        isError: false,
      },
    })),
    {
      requestId: 'github-ci-error-envelope',
      outcome: 'verified',
      result: {
        content: [{ type: 'text', text: JSON.stringify({ state: 'PENDING' }) }],
        isError: true,
      },
    },
    {
      requestId: 'github-ci-unknown-remote-state',
      outcome: 'verified',
      result: {
        content: [{ type: 'text', text: JSON.stringify({ state: 'PENDING', remote_state: 'UNKNOWN' }) }],
        isError: false,
      },
    },
  ], {
    providerId: 'github',
    bindingId: githubBindingId,
    connectionRef: '44444444-4444-4444-8444-444444444444',
    profileRef: 'github-profile-test',
    catalog: { tools: [githubCiTool] },
    authorizedTools: [{
      toolId: githubCiTool.id,
      operationId: 'github.ci.status',
      resourceProjection: 'profile',
      mutating: false,
    }],
  });
  const { ctx, dispose } = await setupHarness(fixture);
  try {
    const ciName = toolName(ctx, githubCiTool.name, githubBindingId);
    assert.ok(ciName);
    const args = {
      repository_id: 'repository-fixture-1',
      repository: 'owner/repository',
      commit_sha: 'a'.repeat(40),
    };

    for (const [index, state] of ciStates.entries()) {
      const result = await execute(ctx, ciName, args, `github-ci-${index}`);
      assert.equal(result.isError, false);
      assert.equal(result.value.structuredContent.outcome, 'verified');
      assert.equal(JSON.parse(result.value.content[0].text).state, state);
    }

    const providerError = await execute(ctx, ciName, args, 'github-ci-error-envelope');
    assert.equal(providerError.isError, true);
    assert.match(providerError.error.message, /unknown remote read result/u);
    const unknownRemoteState = await execute(ctx, ciName, args, 'github-ci-unknown-remote-state');
    assert.equal(unknownRemoteState.isError, true);
    assert.match(unknownRemoteState.error.message, /unknown remote read result/u);
    assert.equal(fixture.client.callCount, 5);
    assert.equal(fixture.client.mintCount, 5);
    assert.equal(fixture.receipts.size, 0, 'business states from read-only calls must not create lifecycle receipts');
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('a mutating RUNNING result with operationRef remains pending under a verified envelope', async () => {
  const fixture = createHarness([{
    requestId: 'running-write-call',
    outcome: 'verified',
    operationRef: 'azure-operation-44',
    result: {
      content: [{ type: 'text', text: JSON.stringify({
        state: 'RUNNING', operation_ref: 'azure-operation-44',
      }) }],
      isError: false,
    },
  }]);
  const { ctx, dispose } = await setupHarness(fixture);
  try {
    const stopName = toolName(ctx, 'Stop cloud resource');
    assert.ok(stopName);
    const result = await execute(ctx, stopName, {
      profile_ref: profileRef,
      target: { resource_id: '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/vm-1' },
    }, 'running-write-call');

    assert.equal(result.isError, false);
    assert.equal(result.value.structuredContent.outcome, 'pending');
    assert.equal(result.value.structuredContent.operationRef, 'azure-operation-44');
    const receipt = fixture.receipts.get('operation-1');
    assert.equal(receipt.status, 'uncertain');
    assert.equal(receipt.evidence.outcome, 'pending');
    assert.equal(receipt.evidence.operationRef, 'azure-operation-44');
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('connector mode registers only tools present in the launcher-owned grant map', async () => {
  const fixture = createHarness();
  fixture.bindingAuthorization.tools = [fixture.bindingAuthorization.tools[0]];
  const { ctx, dispose } = await setupHarness(fixture);
  try {
    assert.ok(toolName(ctx, 'Stop cloud resource'));
    assert.equal(toolName(ctx, 'Read cloud operation status'), undefined);
    const stop = ctx.tools.schemas().find(schema => schema.description.startsWith('Stop cloud resource'));
    assert.equal(stop.parameters.properties.profile_ref.pattern, undefined);
    assert.equal(stop.parameters.properties.target.properties.resource_id.maxLength, undefined);
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('launcher policy admits GitHub and Hugging Face vendor CLI only as profile-scoped writes', () => {
  for (const row of [
    {
      bindingId: 'exchange-github-11111111-1111-4111-8111-111111111111',
      providerId: 'github',
      toolId: 'github_vendor_cli',
      operationId: 'github.vendor.cli.execute',
    },
    {
      bindingId: 'exchange-huggingface-22222222-2222-4222-8222-222222222222',
      providerId: 'huggingface',
      toolId: 'hf_vendor_cli',
      operationId: 'huggingface.vendor.cli.execute',
    },
  ]) {
    const { toolId, operationId, ...bindingIdentity } = row;
    const binding = {
      ...bindingIdentity,
      connectionRef: row.providerId === 'github'
        ? '11111111-1111-4111-8111-111111111111'
        : '22222222-2222-4222-8222-222222222222',
      profileRef: `${row.providerId}-profile-1`,
      tools: [{
        toolId,
        operationId,
        resourceProjection: 'profile',
        mutating: true,
      }],
    };
    const accepted = validateConnectorBindingMap({ schemaVersion: 1, bindings: [binding] });
    assert.equal(accepted.get(row.bindingId).tools[0].mutating, true);
    assert.equal(accepted.get(row.bindingId).tools[0].resourceProjection, 'profile');

    const incorrectlyReadOnly = {
      ...binding,
      tools: [{ ...binding.tools[0], mutating: false }],
    };
    assert.throws(
      () => validateConnectorBindingMap({ schemaVersion: 1, bindings: [incorrectlyReadOnly] }),
      /canonical operation policy/u,
    );

    const incorrectProjection = {
      ...binding,
      tools: [{ ...binding.tools[0], resourceProjection: 'empty' }],
    };
    assert.throws(
      () => validateConnectorBindingMap({ schemaVersion: 1, bindings: [incorrectProjection] }),
      /canonical operation policy/u,
    );

    const mismatchedToolId = {
      ...binding,
      tools: [{ ...binding.tools[0], toolId: row.providerId === 'github' ? 'github.repository.list' : 'huggingface.models.list' }],
    };
    assert.throws(
      () => validateConnectorBindingMap({ schemaVersion: 1, bindings: [mismatchedToolId] }),
      /canonical tool mapping/u,
    );
  }
});

test('GitHub and Hugging Face grants bind exact raw provider arguments and keep profile outside the payload', async () => {
  const cases = [
    {
      providerId: 'github',
      bindingId: 'exchange-github-11111111-1111-4111-8111-111111111111',
      connectionRef: '11111111-1111-4111-8111-111111111111',
      profileRef: 'github-profile-1',
      apiTool: {
        id: 'github.repository.list',
        name: 'List GitHub Repositories',
        description: 'List configured repositories.',
        readOnly: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      cliTool: {
        id: 'github_vendor_cli',
        name: 'Run GitHub CLI Command',
        description: 'Run one authorized argv vector.',
        readOnly: false,
        inputSchema: {
          type: 'object',
          properties: { argv: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string', maxLength: 4096 } } },
          required: ['argv'],
          additionalProperties: false,
        },
      },
      apiOperationId: 'github.repository.list',
      cliOperationId: 'github.vendor.cli.execute',
      apiArguments: {},
      cliArguments: { argv: ['gh', 'repo', 'list'] },
    },
    {
      providerId: 'huggingface',
      bindingId: 'exchange-huggingface-22222222-2222-4222-8222-222222222222',
      connectionRef: '22222222-2222-4222-8222-222222222222',
      profileRef: 'huggingface-profile-1',
      apiTool: {
        id: 'huggingface.models.list',
        name: 'List Hugging Face Models',
        description: 'Search models allowed by the bound account.',
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: { search: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
          additionalProperties: false,
        },
      },
      cliTool: {
        id: 'hf_vendor_cli',
        name: 'Run Hugging Face CLI Command',
        description: 'Run one authorized argv vector.',
        readOnly: false,
        inputSchema: {
          type: 'object',
          properties: { argv: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string', maxLength: 4096 } } },
          required: ['argv'],
          additionalProperties: false,
        },
      },
      apiOperationId: 'huggingface.models.list',
      cliOperationId: 'huggingface.vendor.cli.execute',
      apiArguments: { search: 'private-corp', limit: 10 },
      cliArguments: { argv: ['hf', 'repo', 'list'] },
    },
  ];

  for (const item of cases) {
    const fixture = createHarness([
      { outcome: 'verified', result: { content: [{ type: 'text', text: '{}' }], isError: false } },
      { outcome: 'verified', result: { content: [{ type: 'text', text: '{}' }], isError: false } },
    ], {
      providerId: item.providerId,
      bindingId: item.bindingId,
      connectionRef: item.connectionRef,
      profileRef: item.profileRef,
      catalog: { tools: [item.apiTool, item.cliTool] },
      authorizedTools: [
        { toolId: item.apiTool.id, operationId: item.apiOperationId, resourceProjection: 'profile', mutating: false },
        { toolId: item.cliTool.id, operationId: item.cliOperationId, resourceProjection: 'profile', mutating: true },
      ],
    });
    const { ctx, dispose } = await setupHarness(fixture);
    try {
      const apiName = toolName(ctx, item.apiTool.name, item.bindingId);
      const cliName = toolName(ctx, item.cliTool.name, item.bindingId);
      assert.ok(apiName);
      assert.ok(cliName);

      const apiResult = await execute(ctx, apiName, item.apiArguments, `${item.providerId}-api-call`);
      assert.equal(apiResult.isError, false);
      const cliResult = await execute(ctx, cliName, item.cliArguments, `${item.providerId}-cli-call`);
      assert.equal(cliResult.isError, false);

      for (const [index, args] of [[0, item.apiArguments], [1, item.cliArguments]]) {
        const grant = fixture.client.mintInputs[index];
        const providerCall = fixture.client.providerInputs[index];
        const operationId = index === 0 ? item.apiOperationId : item.cliOperationId;
        assert.deepEqual(grant.arguments, args);
        assert.deepEqual(providerCall.arguments, args);
        assert.equal(grant.profileRef, item.profileRef);
        assert.equal(grant.argumentsDigestSha256, sha256(canonicalJson(args)));
        assert.equal(grant.resourceRef, `sha256:${sha256(canonicalJson({
          providerId: item.providerId,
          profileRef: item.profileRef,
          operationId,
          target: { profile_ref: item.profileRef },
        }))}`);
      }

      for (const invalidArguments of [
        { ...item.cliArguments, profile_ref: item.profileRef },
        { ...item.cliArguments, profileRef: item.profileRef },
      ]) {
        const invalid = await execute(ctx, cliName, invalidArguments, `${item.providerId}-invalid-profile`);
        assert.equal(invalid.isError, true);
        assert.equal(fixture.client.mintCount, 2);
      }
    } finally {
      dispose();
      await ctx.fiber.dispose();
    }
  }
});

test('projected cloud profile pattern and target length are enforced before grant minting', async () => {
  const fixture = createHarness();
  const { ctx, dispose } = await setupHarness(fixture);
  try {
    const stopName = toolName(ctx, 'Stop cloud resource');
    assert.ok(stopName);
    for (const argumentsValue of [
      { profile_ref: 'other/profile', target: { resource_id: 'vm-1' } },
      { profile_ref: profileRef, target: { resource_id: 'x'.repeat(2049) } },
    ]) {
      const result = await execute(ctx, stopName, argumentsValue, `invalid-${fixture.client.mintCount}`);
      assert.equal(result.isError, true);
      assert.match(result.error.message, /configured bounds/u);
      assert.equal(fixture.client.mintCount, 0);
      assert.equal(fixture.client.callCount, 0);
      assert.equal(fixture.receipts.size, 0);
    }
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('unknown GitHub CLI write can be reconciled only from a same-task read receipt and never auto-replays', async () => {
  const githubBindingId = 'exchange-github-33333333-3333-4333-8333-333333333333';
  const githubConnectionRef = '33333333-3333-4333-8333-333333333333';
  const githubProfileRef = 'github-profile-production';
  const githubSession = 'teams-github-session';
  const githubTask = 'teams-github-task';
  const githubCatalog = {
    tools: [
      {
        id: 'github_vendor_cli',
        name: 'Run GitHub CLI',
        description: 'Run one authorized argv vector.',
        readOnly: false,
        inputSchema: {
          type: 'object',
          properties: { argv: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string', maxLength: 4096 } } },
          required: ['argv'],
          additionalProperties: false,
        },
      },
      {
        id: 'github.branches.list',
        name: 'List GitHub branches',
        description: 'Read branches for one exact repository target.',
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: {
            repository_id: { type: 'string', pattern: '^[0-9]+$' },
            repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
          },
          required: ['repository_id', 'repository'],
          additionalProperties: false,
        },
      },
    ],
  };
  const operations = new Map();
  let nextOperation = 0;
  let approvalCalls = 0;
  const workRoot = '/api/v1/workspaces/github-workspace/work';
  const expectedIndependentReadResult = {
    content: [{ type: 'text', text: JSON.stringify({ branches: [{ name: 'test-branch', commit_sha: '0123456789abcdef' }] }) }],
    structuredContent: { branches: [{ name: 'test-branch', commit_sha: '0123456789abcdef' }] },
    isError: false,
  };
  const server = createServer(async (request, response) => {
    let rawBody = '';
    for await (const chunk of request) rawBody += chunk;
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    const path = request.url ?? '';
    response.setHeader('content-type', 'application/json');
    const send = (value, status = 200) => {
      response.statusCode = status;
      response.end(JSON.stringify(value));
    };
    if (path === `${workRoot}/tool-providers` && request.method === 'GET') {
      return send({ items: [{
        bindingId: githubBindingId,
        capabilityId: 'tool.provider.v1',
        providerId: 'github',
        connectionRef: githubConnectionRef,
        profileRef: githubProfileRef,
      }] });
    }
    if (path === `${workRoot}/tool-providers/${encodeURIComponent(githubBindingId)}/tools` && request.method === 'GET') {
      return send(githubCatalog);
    }
    if (path === `${workRoot}/tasks/${githubTask}` && request.method === 'GET') {
      return send({
        id: githubTask,
        status: 'running',
        metadata: { teamsCaller: { issuer, subject: ownerId, tenantId } },
      });
    }
    if (path.startsWith(`${workRoot}/tasks/${githubTask}/approvals`)) {
      approvalCalls += 1;
      return send({ approval: { id: 'unexpected-approval', status: 'approved' } });
    }
    if (path.startsWith(`${workRoot}/operations/unresolved?`) && request.method === 'GET') {
      const query = new URL(path, 'http://127.0.0.1').searchParams;
      const target = query.get('target');
      return send({ items: [...operations.values()]
        .filter(row => row.status === 'started' || row.status === 'uncertain')
        .filter(row => target === null || row.target === target)
        .map(({ id, operationType, taskId, target: receiptTarget, status, evidence, createdAt, updatedAt }) => ({
          id, operationType, taskId, target: receiptTarget, status, evidence, createdAt, updatedAt,
        })) });
    }
    if (path === `${workRoot}/operations` && request.method === 'POST') {
      const id = `github-work-operation-${++nextOperation}`;
      const operation = {
        id,
        taskId: body.taskId,
        operationType: body.operationType,
        target: body.target,
        request: body.request,
        status: 'started',
        evidence: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      operations.set(id, operation);
      return send({ operation, duplicate: false }, 201);
    }
    const operationPath = path.match(new RegExp(`^${workRoot}/operations/([^/]+)$`, 'u'));
    if (operationPath && request.method === 'GET') {
      const operation = operations.get(decodeURIComponent(operationPath[1]));
      return operation ? send({ operation }) : send({ error: 'not found' }, 404);
    }
    if (operationPath && request.method === 'PATCH') {
      const operation = operations.get(decodeURIComponent(operationPath[1]));
      if (!operation) return send({ error: 'not found' }, 404);
      Object.assign(operation, { status: body.status, evidence: body.evidence, updatedAt: Date.now() });
      return send({ operation, duplicate: false });
    }
    return send({ error: `unexpected ${request.method} ${path}` }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const priorToken = process.env.WORK_TOOL_TEST_TOKEN;
  process.env.WORK_TOOL_TEST_TOKEN = 'private-test-token';
  const providerResponses = [
    {
      outcome: 'uncertain', operationRef: 'github-cli-unknown-1',
      result: {
        content: [{ type: 'text', text: JSON.stringify({ state: 'UNKNOWN_RESULT', operation_ref: 'github-cli-unknown-1' }) }],
        structuredContent: { state: 'UNKNOWN_RESULT', operation_ref: 'github-cli-unknown-1' },
        isError: false,
      },
    },
    { outcome: 'verified', result: expectedIndependentReadResult },
    {
      outcome: 'verified',
      result: { content: [{ type: 'text', text: JSON.stringify({ state: 'CLEANED_UP' }) }], isError: false },
    },
    {
      outcome: 'uncertain', operationRef: 'github-cli-unknown-2',
      result: {
        content: [{ type: 'text', text: JSON.stringify({ state: 'UNKNOWN_RESULT', operation_ref: 'github-cli-unknown-2' }) }],
        structuredContent: { state: 'UNKNOWN_RESULT', operation_ref: 'github-cli-unknown-2' },
        isError: false,
      },
    },
  ];
  const authorizationClient = {
    mintInputs: [],
    providerInputs: [],
    async mintGrant(input) {
      this.mintInputs.push(input);
      return {
        connectorGrantBin: 'AQ==', grantRef: `github-grant-${this.mintInputs.length}`, audience: 'exchange',
        organizationId: 'github-test-org', issuedAt: Math.floor(Date.now() / 1_000),
        expiresAt: Math.floor(Date.now() / 1_000) + 15, request: input,
      };
    },
    async callProviderOperation(input) {
      this.providerInputs.push(input);
      const next = providerResponses.shift();
      if (!next) throw new Error('Unexpected provider call');
      return { ...next, requestId: input.requestId };
    },
  };

  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  try {
    const bridge = registerWorkTools(ctx, {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      workspaceId: 'github-workspace',
      tokenEnv: 'WORK_TOOL_TEST_TOKEN',
      taskIdForSession: value => value === githubSession ? githubTask : undefined,
    });
    const disposeProviders = await registerToolProviders(ctx, {
      bridge,
      taskIdForSession: value => value === githubSession ? githubTask : undefined,
      connectorAuthorization: {
        client: authorizationClient,
        workspaceId: 'github-workspace',
        bindings: new Map([[githubBindingId, {
          bindingId: githubBindingId,
          connectionRef: githubConnectionRef,
          providerId: 'github',
          profileRef: githubProfileRef,
          tools: [
            { toolId: 'github_vendor_cli', operationId: 'github.vendor.cli.execute', resourceProjection: 'profile', mutating: true },
            { toolId: 'github.branches.list', operationId: 'github.branches.list', resourceProjection: 'github_repository', mutating: false },
          ],
        }]]),
      },
    });
    try {
      const cliName = toolName(ctx, 'Run GitHub CLI', githubBindingId);
      const listName = toolName(ctx, 'List GitHub branches', githubBindingId);
      assert.ok(cliName);
      assert.ok(listName);
      const call = (name, args, id) => ctx.tools.execute({
        name,
        callId: ToolCallId(id),
        arguments: args,
        signal: new AbortController().signal,
        agent: { id: 'navigator-agent', session: { id: githubSession } },
      });

      const firstWrite = await call(cliName, {
        argv: ['api', 'repos/example/repo/git/refs', '-X', 'POST', '-f', 'ref=refs/heads/test-branch', '-f', 'sha=0123456789abcdef'],
      }, 'github-write-1');
      assert.equal(firstWrite.isError, true);
      assert.match(firstWrite.error.message, /github-cli-unknown-1/u);
      const firstReceiptId = operations.keys().next().value;
      assert.ok(firstWrite.error.message.includes(`Work operation ID: ${firstReceiptId}`));
      assert.equal(operations.get(firstReceiptId).status, 'uncertain');

      const blockedBeforeReadback = await call(cliName, {
        argv: ['api', 'repos/example/repo/git/refs/heads/test-branch', '-X', 'DELETE'],
      }, 'github-write-blocked-1');
      assert.equal(blockedBeforeReadback.isError, true);
      assert.match(blockedBeforeReadback.error.message, /Work operation ID/u);
      assert.equal(authorizationClient.mintInputs.length, 1);
      assert.equal(authorizationClient.providerInputs.length, 1);

      operations.get(firstReceiptId).evidence.privateNote = 'synthetic-sensitive-field';
      const writeReceiptRead = await call('work_operation_read', { operationId: firstReceiptId }, 'read-work-write-receipt');
      assert.equal(writeReceiptRead.isError, false);
      assert.equal(writeReceiptRead.value.id, firstReceiptId);
      assert.equal(Object.hasOwn(writeReceiptRead.value, 'request'), false);
      assert.equal(Object.hasOwn(writeReceiptRead.value.evidence, 'privateNote'), false);

      const independentRead = await call(listName, {
        repository_id: '42', repository: 'example/repo',
      }, 'github-independent-read');
      assert.equal(independentRead.isError, false);
      const readReceiptId = independentRead.value.structuredContent.workOperationId;
      assert.equal(typeof readReceiptId, 'string');
      const readReceiptRead = await call('work_operation_read', { operationId: readReceiptId }, 'read-work-readback-receipt');
      const readReceipt = readReceiptRead.value;
      assert.equal(readReceipt.status, 'verified');
      assert.equal(readReceipt.evidence.effect, 'read');
      assert.equal(readReceipt.evidence.resultSha256, sha256(canonicalJson(expectedIndependentReadResult)));

      const unprovenVerify = await call('work_operation_verify', {
        operationId: firstReceiptId,
        status: 'verified',
        evidence: { independentRead: { operationId: 'invented-readback', confirmed: true, observation: 'Invented.' } },
      }, 'verify-without-read-receipt');
      assert.equal(unprovenVerify.isError, true);
      assert.equal(operations.get(firstReceiptId).status, 'uncertain');

      operations.set('foreign-readback-receipt', {
        id: 'foreign-readback-receipt',
        taskId: 'another-teams-task',
        operationType: 'tool.provider.v1:github.repository.list',
        target: `connector-readback:${operations.get(firstReceiptId).evidence.targetDigestSha256}`,
        request: {},
        status: 'verified',
        evidence: {
          outcome: 'verified', effect: 'read', providerId: 'github', profileRef: githubProfileRef,
          operationId: 'github.repository.list',
          targetDigestSha256: operations.get(firstReceiptId).evidence.targetDigestSha256,
          resultSha256: 'a'.repeat(64),
        },
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      const crossTaskVerify = await call('work_operation_verify', {
        operationId: firstReceiptId,
        status: 'verified',
        evidence: {
          independentRead: {
            operationId: 'foreign-readback-receipt',
            confirmed: true,
            observation: 'This receipt belongs to another task and must not authorize reconciliation.',
          },
        },
      }, 'verify-with-foreign-task-readback');
      assert.equal(crossTaskVerify.isError, true);
      assert.equal(operations.get(firstReceiptId).status, 'uncertain');

      const verified = await call('work_operation_verify', {
        operationId: firstReceiptId,
        status: 'verified',
        evidence: {
          independentRead: {
            operationId: readReceiptId,
            confirmed: true,
            observation: 'The exact repository branch listing confirms the newly created test branch exists.',
            resultSha256: 'f'.repeat(64),
          },
        },
      }, 'verify-from-real-read-receipt');
      assert.equal(verified.isError, false);
      assert.equal(operations.get(firstReceiptId).status, 'verified');
      assert.equal(operations.get(firstReceiptId).evidence.independentRead.resultSha256, readReceipt.evidence.resultSha256);

      const cleanup = await call(cliName, {
        argv: ['api', 'repos/example/repo/git/refs/heads/test-branch', '-X', 'DELETE'],
      }, 'github-cleanup');
      assert.equal(cleanup.isError, false);
      assert.equal(authorizationClient.providerInputs.length, 3);
      assert.equal(authorizationClient.providerInputs[2].arguments.argv.at(-1), 'DELETE');

      const secondUnknownWrite = await call(cliName, {
        argv: ['api', 'repos/example/repo/git/refs/heads/another-branch', '-X', 'DELETE'],
      }, 'github-write-2');
      assert.equal(secondUnknownWrite.isError, true);
      assert.match(secondUnknownWrite.error.message, /Work operation ID/u);
      const countBeforeFinalAttempt = authorizationClient.providerInputs.length;
      const stillBlocked = await call(cliName, {
        argv: ['api', 'repos/example/repo/git/refs/heads/another-branch', '-X', 'DELETE'],
      }, 'github-write-blocked-2');
      assert.equal(stillBlocked.isError, true);
      assert.equal(authorizationClient.providerInputs.length, countBeforeFinalAttempt);
      assert.equal(providerResponses.length, 0);
      assert.equal(authorizationClient.mintInputs.length, 4);
      assert.equal(approvalCalls, 0);
    } finally {
      disposeProviders();
      await ctx.fiber.dispose();
    }
  } finally {
    if (priorToken === undefined) delete process.env.WORK_TOOL_TEST_TOKEN;
    else process.env.WORK_TOOL_TEST_TOKEN = priorToken;
    await new Promise(resolve => server.close(resolve));
  }
});
