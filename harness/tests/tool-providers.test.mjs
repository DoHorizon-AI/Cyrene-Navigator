// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Canonical tool-provider adapter fixtures                   │
// │ Role: Verify DSH registration, approval, receipts, and call scope. │
// │ 模块职责：验证 DSH 工具注册、人工审批、操作回执与调用范围。            │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { getCodeBuddyAcpToolCatalog, registerToolProviders } from '../dist/tool-providers.js';

const bindingId = 'wecom-primary';
const readToolId = 'contacts_search';
const writeToolId = 'send_message';
const sessionId = 'navigator-session-42';
const taskId = 'work-task-42';
const computerToolCatalog = JSON.parse(readFileSync(
  new URL('./fixtures/computer-provider-schemas.json', import.meta.url), 'utf8',
));

const catalog = {
  items: [{ bindingId, capabilityId: 'tool.provider.v1' }],
};

const tools = {
  tools: [
    {
      id: readToolId,
      name: 'Search contacts',
      description: 'Search the configured WeCom directory.',
      inputSchema: {
        type: 'object', properties: { query: { type: 'string', pattern: '^[A-Za-z]+$' } }, required: ['query'], additionalProperties: false,
      },
      readOnly: true,
    },
    {
      id: writeToolId,
      name: 'Send message',
      description: 'Send a message to one approved conversation.',
      inputSchema: {
        type: 'object', properties: {
          conversationId: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: 64 },
        },
        required: ['conversationId', 'text'], additionalProperties: false,
      },
      readOnly: false,
    },
  ],
};

/** Small authenticated-bridge fixture with explicit task, approval, and receipt seams. */
function createBridgeFixture(options = {}) {
  const events = [];
  let beginCount = 0;
  let callCount = 0;
  const toolCatalog = options.toolCatalog ?? tools;
  const bridge = {
    async request(path, method, body, signal) {
      events.push({ type: 'request', path, method, body, signal });
      if (path === '/tool-providers' && method === 'GET') return catalog;
      if (path === `/tool-providers/${bindingId}/tools` && method === 'GET') return toolCatalog;
      if (path.startsWith(`/tool-providers/${bindingId}/tools/`) && path.endsWith('/call') && method === 'POST') {
        callCount += 1;
        return { content: [{ type: 'text', text: 'Found Ada Lovelace.' }], structuredContent: { count: 1 } };
      }
      if (path === `/operations/operation-${beginCount}` && method === 'PATCH') return { operation: { id: `operation-${beginCount}` } };
      throw new Error(`Unexpected bridge request ${method} ${path}`);
    },
    async requestApproval(actualSessionId, kind, summary, details, signal, messageId) {
      events.push({ type: 'approval', actualSessionId, kind, summary, details, signal, messageId });
      if (options.approvalError) throw options.approvalError;
      return { id: 'approval-42', status: 'approved' };
    },
    async mutate(execution, path, method, body, taskLinked = false) {
      events.push({ type: 'mutate', path, method, body, taskLinked, sessionId: execution.agent?.session.id });
      if (path === '/operations' && method === 'POST') {
        beginCount += 1;
        if (options.receipt) return options.receipt;
        return { operation: { id: `operation-${beginCount}`, status: 'started' }, duplicate: false };
      }
      if (path.endsWith(`/tools/${writeToolId}/call`) && method === 'POST') {
        callCount += 1;
        if (options.callError) throw options.callError;
        return { content: [{ type: 'text', text: 'Message delivered.' }], structuredContent: { messageId: 'message-42' } };
      }
      throw new Error(`Unexpected bridge mutation ${method} ${path}`);
    },
  };
  return { bridge, events, callCount: () => callCount };
}

async function createToolContext(bridgeFixture) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const dispose = await registerToolProviders(ctx, {
    bridge: bridgeFixture.bridge,
    taskIdForSession: id => id === sessionId ? taskId : undefined,
  });
  return { ctx, dispose };
}

function schemaFor(ctx, id) {
  const label = id === readToolId ? 'Search contacts' : 'Send message';
  return ctx.tools.schemas().find(item => item.description.startsWith(`${label} (configured provider ${bindingId})`));
}

function agent() {
  return { id: 'navigator-agent-42', session: { id: sessionId } };
}

async function execute(ctx, name, args, callId, withAgent = true) {
  return ctx.tools.execute({
    name,
    callId: ToolCallId(callId),
    arguments: args,
    signal: new AbortController().signal,
    ...(withAgent ? { agent: agent() } : {}),
  });
}

test('host catalog snapshot fixture registers only matching launcher-authorized connector tools', async () => {
  const githubBindingId = 'exchange-github-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const connectionRef = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const profileRef = 'github-profile-snapshot-test';
  const snapshot = {
    schemaVersion: 1,
    items: [{
      bindingId: githubBindingId,
      capabilityId: 'tool.provider.v1',
      providerId: 'github',
      connectionRef,
      profileRef,
      tools: [
        {
          id: 'github_vendor_cli',
          name: 'Run GitHub CLI Command',
          description: 'Run one profile-bound argv vector.',
          readOnly: false,
          inputSchema: {
            type: 'object',
            properties: { argv: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string', maxLength: 4096 } } },
            required: ['argv'],
            additionalProperties: false,
          },
        },
        {
          id: 'github.repository.list',
          name: 'List GitHub Repositories',
          description: 'List repositories for this profile.',
          readOnly: true,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    }],
  };
  const trustedBinding = {
    bindingId: githubBindingId,
    connectionRef,
    providerId: 'github',
    profileRef,
    tools: [{
      toolId: 'github_vendor_cli',
      operationId: 'github.vendor.cli.execute',
      resourceProjection: 'profile',
      mutating: true,
    }],
  };
  const bridge = {
    async request() { throw new Error('Snapshot registration must not discover tools from Work'); },
    async requestApproval() { throw new Error('Catalog registration must not call tools'); },
    async mutate() { throw new Error('Catalog registration must not call tools'); },
  };
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  try {
    const dispose = await registerToolProviders(ctx, {
      bridge,
      taskIdForSession: () => undefined,
      githubBindingDisplayHints: new Map([[githubBindingId, {
        label: 'DoHorizon-AI/Cyrene-Exchange',
        uri: 'https://github.com/DoHorizon-AI/Cyrene-Exchange',
      }]]),
      connectorAuthorization: {
        client: {},
        workspaceId: 'workspace-snapshot-test',
        bindings: new Map([[githubBindingId, trustedBinding]]),
      },
      connectorToolCatalogSnapshot: snapshot,
    });
    try {
      const schemas = ctx.tools.schemas();
      assert.equal(schemas.length, 1);
      assert.match(schemas[0].description, /Run GitHub CLI Command/u);
      assert.match(
        schemas[0].description,
        /Host-configured GitHub repository: DoHorizon-AI\/Cyrene-Exchange \(https:\/\/github\.com\/DoHorizon-AI\/Cyrene-Exchange\)/u,
      );
      assert.deepEqual(schemas[0].parameters.required, ['argv']);
      assert.equal(schemas.some(schema => schema.description.includes('List GitHub Repositories')), false);
      const acpTool = getCodeBuddyAcpToolCatalog(ctx).find(item => item.name === schemas[0].name);
      assert.equal(acpTool?.description, schemas[0].description);
    } finally {
      dispose();
    }

    const disposeWithoutHint = await registerToolProviders(ctx, {
      bridge,
      taskIdForSession: () => undefined,
      connectorAuthorization: {
        client: {},
        workspaceId: 'workspace-snapshot-test',
        bindings: new Map([[githubBindingId, trustedBinding]]),
      },
      connectorToolCatalogSnapshot: snapshot,
    });
    try {
      const schema = ctx.tools.schemas()[0];
      assert.match(schema.description, /Host repository mapping unavailable; do not infer the target/u);
      const acpTool = getCodeBuddyAcpToolCatalog(ctx).find(item => item.name === schema.name);
      assert.equal(acpTool?.description, schema.description);
    } finally {
      disposeWithoutHint();
    }

    await assert.rejects(registerToolProviders(ctx, {
      bridge,
      taskIdForSession: () => undefined,
      connectorAuthorization: {
        client: {},
        workspaceId: 'workspace-snapshot-test',
        bindings: new Map([[githubBindingId, trustedBinding]]),
      },
      connectorToolCatalogSnapshot: {
        ...snapshot,
        items: [{ ...snapshot.items[0], connectionRef: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
      },
    }), /launcher-owned connector binding/u);
    await assert.rejects(registerToolProviders(ctx, {
      bridge,
      taskIdForSession: () => undefined,
      connectorAuthorization: {
        client: {},
        workspaceId: 'workspace-snapshot-test',
        bindings: new Map([[githubBindingId, trustedBinding]]),
      },
      connectorToolCatalogSnapshot: {
        ...snapshot,
        items: [{
          ...snapshot.items[0],
          tools: [{ ...snapshot.items[0].tools[0], operationId: 'caller-controlled.operation' }],
        }],
      },
    }), /missing or unsupported fields/u);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('cloud tools show their trusted provider profile without changing required arguments', async () => {
  const bindingId = 'exchange-azure-primary';
  const connectionRef = '33333333-3333-4333-8333-333333333333';
  const profileRef = 'azure-primary';
  const inputSchema = {
    type: 'object',
    properties: {
      profile_ref: { type: 'string' },
      target: {
        type: 'object',
        properties: { resource_group: { type: 'string' } },
        required: ['resource_group'],
        additionalProperties: false,
      },
    },
    required: ['profile_ref', 'target'],
    additionalProperties: false,
  };
  const snapshot = {
    schemaVersion: 1,
    items: [{
      bindingId,
      capabilityId: 'tool.provider.v1',
      providerId: 'azure',
      connectionRef,
      profileRef,
      tools: [{
        id: 'cloud_resources_list',
        name: 'List Cloud Resources',
        description: 'List resources in the supplied target.',
        readOnly: true,
        inputSchema,
      }],
    }],
  };
  const trustedBinding = {
    bindingId,
    connectionRef,
    providerId: 'azure',
    profileRef,
    tools: [{
      toolId: 'cloud_resources_list',
      operationId: 'cloud.resources.list',
      resourceProjection: 'cloud_target',
      mutating: false,
    }],
  };
  const bridge = {
    async request() { throw new Error('Private snapshot registration must not fetch provider metadata.'); },
    async requestApproval() { throw new Error('Registration must not request approval.'); },
    async mutate() { throw new Error('Registration must not execute tools.'); },
  };
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  try {
    const dispose = await registerToolProviders(ctx, {
      bridge,
      taskIdForSession: () => undefined,
      connectorAuthorization: {
        client: {},
        workspaceId: 'workspace-cloud-profile-hint',
        bindings: new Map([[bindingId, trustedBinding]]),
      },
      connectorToolCatalogSnapshot: snapshot,
    });
    try {
      const schema = ctx.tools.schemas()[0];
      assert.match(schema.description, /Trusted cloud call context: provider azure; profile_ref "azure-primary"/u);
      assert.deepEqual(schema.parameters, inputSchema);
      const acpTool = getCodeBuddyAcpToolCatalog(ctx).find(item => item.name === schema.name);
      assert.equal(acpTool?.description, schema.description);
      assert.deepEqual(acpTool?.inputSchema, inputSchema);
    } finally {
      dispose();
    }
  } finally {
    await ctx.fiber.dispose();
  }
});

test('a provider catalog cannot claim a host repository hint without a trusted GitHub binding', async () => {
  const bindingId = 'untrusted-github-binding-collision';
  const bridge = {
    async request(path) {
      if (path === '/tool-providers') {
        return { items: [{ bindingId, capabilityId: 'tool.provider.v1', providerId: 'github' }] };
      }
      if (path === `/tool-providers/${bindingId}/tools`) {
        return { tools: [{
          id: 'github.issues.search',
          name: 'Search GitHub Issues',
          description: 'Search issues in the supplied repository.',
          readOnly: true,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }] };
      }
      throw new Error(`Unexpected provider metadata request: ${path}`);
    },
    async requestApproval() { throw new Error('Registration must not request approval.'); },
    async mutate() { throw new Error('Registration must not execute tools.'); },
  };
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  try {
    const dispose = await registerToolProviders(ctx, {
      bridge,
      taskIdForSession: () => undefined,
      githubBindingDisplayHints: new Map([[bindingId, {
        label: 'DoHorizon-AI/Cyrene-Exchange',
        uri: 'https://github.com/DoHorizon-AI/Cyrene-Exchange',
      }]]),
    });
    try {
      const schema = ctx.tools.schemas()[0];
      assert.match(schema.description, /Host repository mapping unavailable; do not infer the target/u);
      assert.doesNotMatch(schema.description, /DoHorizon-AI\/Cyrene-Exchange/u);
    } finally {
      dispose();
    }
  } finally {
    await ctx.fiber.dispose();
  }
});

test('separate GitHub bindings expose distinct host repository labels in DSH and ACP', async () => {
  const repositoryBindings = [
    {
      bindingId: 'exchange-github-workspace',
      connectionRef: '11111111-1111-4111-8111-111111111111',
      profileRef: 'github-workspace-profile',
      repository: 'DoHorizon-AI/Cyrene-Workspace',
    },
    {
      bindingId: 'exchange-github-exchange',
      connectionRef: '22222222-2222-4222-8222-222222222222',
      profileRef: 'github-exchange-profile',
      repository: 'DoHorizon-AI/Cyrene-Exchange',
    },
  ];
  const inputSchema = {
    type: 'object',
    properties: {
      repository_id: { type: 'string' },
      repository: { type: 'string' },
      query: { type: 'string' },
    },
    required: ['repository_id', 'repository', 'query'],
    additionalProperties: false,
  };
  const snapshot = {
    schemaVersion: 1,
    items: repositoryBindings.map(item => ({
      bindingId: item.bindingId,
      capabilityId: 'tool.provider.v1',
      providerId: 'github',
      connectionRef: item.connectionRef,
      profileRef: item.profileRef,
      tools: [{
        id: 'github.issues.search',
        name: 'Search GitHub Issues',
        description: 'Search issues in the supplied repository.',
        readOnly: true,
        inputSchema,
      }],
    })),
  };
  const connectorBindings = new Map(repositoryBindings.map(item => [item.bindingId, {
    bindingId: item.bindingId,
    connectionRef: item.connectionRef,
    providerId: 'github',
    profileRef: item.profileRef,
    tools: [{
      toolId: 'github.issues.search',
      operationId: 'github.issues.search',
      resourceProjection: 'github_repository',
      mutating: false,
    }],
  }]));
  const bridge = {
    async request() { throw new Error('Private snapshot registration must not fetch provider metadata.'); },
    async requestApproval() { throw new Error('Registration must not request approval.'); },
    async mutate() { throw new Error('Registration must not execute tools.'); },
  };
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  try {
    const dispose = await registerToolProviders(ctx, {
      bridge,
      taskIdForSession: () => undefined,
      connectorAuthorization: {
        client: {},
        workspaceId: 'workspace-repository-hints',
        bindings: connectorBindings,
      },
      connectorToolCatalogSnapshot: snapshot,
      githubBindingDisplayHints: new Map(repositoryBindings.map(item => [item.bindingId, {
        label: item.repository,
        uri: `https://github.com/${item.repository}`,
      }])),
    });
    try {
      const schemas = ctx.tools.schemas().filter(item => item.description.startsWith('Search GitHub Issues'));
      assert.equal(schemas.length, 2);
      for (const item of repositoryBindings) {
        const schema = schemas.find(entry => entry.description.includes(item.repository));
        assert.ok(schema, `the model-facing schema should name ${item.repository}`);
        assert.ok(schema.description.includes(`configured provider ${item.bindingId})`));
        assert.ok(schema.description.includes(`https://github.com/${item.repository}`));
        assert.deepEqual(schema.parameters, inputSchema);
        const acpTool = getCodeBuddyAcpToolCatalog(ctx).find(entry => entry.name === schema.name);
        assert.equal(acpTool?.description, schema.description);
        assert.deepEqual(acpTool?.inputSchema, inputSchema);
      }
      assert.notEqual(schemas[0].name, schemas[1].name);
    } finally {
      dispose();
    }
  } finally {
    await ctx.fiber.dispose();
  }
});

test('registers canonical read tools and routes calls through the configured binding', async () => {
  const fixture = createBridgeFixture();
  const { ctx, dispose } = await createToolContext(fixture);
  try {
    const schemas = ctx.tools.schemas();
    const schema = schemas.find(item => item.description.startsWith(`Search contacts (configured provider ${bindingId})`));
    assert.ok(schema);
    assert.equal(schema.parameters.properties.query.type, 'string');
    assert.equal(schema.parameters.properties.query.pattern, undefined);
    const name = schema.name;
    const result = await execute(ctx, name, { query: 'Ada' }, 'read-call-1', false);

    assert.equal(result.isError, false);
    assert.deepEqual(result.value, {
      content: [{ type: 'text', text: 'Found Ada Lovelace.' }],
      structuredContent: { count: 1 },
    });
    assert.equal(fixture.callCount(), 1);
    assert.equal(fixture.events.some(event => event.type === 'approval' || event.path === '/operations'), false);
    assert.ok(fixture.events.some(event => event.path === `/tool-providers/${bindingId}/tools/${readToolId}/call`));

    const rejected = await execute(ctx, name, { query: 'Ada/Lovelace' }, 'pattern-invalid-call', false);
    assert.equal(rejected.isError, true);
    assert.match(rejected.error.message, /violates its configured bounds/u);
    assert.equal(fixture.callCount(), 1);
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('projects uniqueItems to the host and rejects duplicate values before provider invocation', async () => {
  const toolCatalog = {
    tools: [{
      id: 'labels_search',
      name: 'Search labels',
      description: 'Search labels with duplicate values rejected by the host.',
      inputSchema: {
        type: 'object',
        properties: {
          labels: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 10,
            uniqueItems: true,
          },
          selectors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                filter: {
                  type: 'object',
                  properties: {
                    active: { type: 'boolean' },
                    labels: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['active', 'labels'],
                  additionalProperties: false,
                },
              },
              required: ['name', 'filter'],
              additionalProperties: false,
            },
            uniqueItems: true,
          },
          uniqueItems: { type: 'string' },
          pattern: { type: 'string' },
          variants: {
            type: 'array',
            items: {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    uniqueItems: {
                      type: 'array',
                      items: { type: 'string' },
                      uniqueItems: false,
                    },
                  },
                  required: ['uniqueItems'],
                  additionalProperties: false,
                },
                {
                  type: 'object',
                  properties: { pattern: { type: 'string' } },
                  required: ['pattern'],
                  additionalProperties: false,
                },
              ],
            },
          },
        },
        required: ['labels', 'selectors', 'uniqueItems', 'pattern', 'variants'],
      },
      readOnly: true,
    }],
  };
  const fixture = createBridgeFixture({ toolCatalog });
  const { ctx, dispose } = await createToolContext(fixture);
  try {
    const schema = ctx.tools.schemas().find(item =>
      item.description.startsWith(`Search labels (configured provider ${bindingId})`));
    assert.ok(schema);
    assert.equal(schema.parameters.properties.labels.uniqueItems, undefined);
    assert.equal(schema.parameters.properties.labels.minItems, undefined);
    assert.equal(schema.parameters.properties.labels.maxItems, undefined);
    assert.equal(schema.parameters.properties.selectors.uniqueItems, undefined);
    assert.equal(schema.parameters.properties.uniqueItems.type, 'string');
    assert.equal(schema.parameters.properties.pattern.type, 'string');
    assert.equal(schema.parameters.properties.variants.items.oneOf[0].properties.uniqueItems.type, 'array');
    assert.equal(schema.parameters.properties.variants.items.oneOf[0].properties.uniqueItems.uniqueItems, undefined);
    assert.equal(schema.parameters.properties.variants.items.oneOf[1].properties.pattern.type, 'string');

    const baseArguments = {
      labels: ['bug', 'feature'],
      selectors: [{ name: 'primary', filter: { active: true, labels: ['bug', 'feature'] } }],
      uniqueItems: 'preserved property name',
      pattern: 'preserved property name',
      variants: [{ uniqueItems: ['repeat', 'repeat'] }],
    };
    assert.deepEqual(validateJsonSchemaValue(schema.parameters, baseArguments), []);
    const invalidPropertyNamedUniqueItems = validateJsonSchemaValue(schema.parameters, {
      ...baseArguments,
      uniqueItems: 42,
      pattern: 42,
    });
    assert.notDeepEqual(invalidPropertyNamedUniqueItems, []);
    assert.match(invalidPropertyNamedUniqueItems.join(' '), /uniqueItems.*string/u);
    assert.match(invalidPropertyNamedUniqueItems.join(' '), /pattern.*string/u);

    const duplicateLabels = await execute(
      ctx,
      schema.name,
      { ...baseArguments, labels: ['bug', 'bug'] },
      'duplicate-labels',
      false,
    );
    assert.equal(duplicateLabels.isError, true);
    assert.match(duplicateLabels.error.message, /violates its configured bounds or uniqueness/u);
    assert.equal(fixture.callCount(), 0);

    const duplicateNestedObjects = await execute(ctx, schema.name, {
      ...baseArguments,
      selectors: [
        { name: 'primary', filter: { active: true, labels: ['bug', 'feature'] } },
        { filter: { labels: ['bug', 'feature'], active: true }, name: 'primary' },
      ],
    }, 'duplicate-nested-selectors', false);
    assert.equal(duplicateNestedObjects.isError, true);
    assert.match(duplicateNestedObjects.error.message, /violates its configured bounds or uniqueness/u);
    assert.equal(fixture.callCount(), 0);

    const unique = await execute(ctx, schema.name, baseArguments, 'unique-labels', false);
    assert.equal(unique.isError, false);
    assert.equal(fixture.callCount(), 1);
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('projects the known UTF-8 byte annotation and enforces it before provider invocation', async () => {
  const fixture = createBridgeFixture({ toolCatalog: computerToolCatalog });
  const { ctx, dispose } = await createToolContext(fixture);
  try {
    const schemas = ctx.tools.schemas();
    const rawSchemas = computerToolCatalog.tools.map(tool => structuredClone(tool.inputSchema));
    assert.equal(schemas.length, 4);
    for (const name of ['Execute command', 'List directory', 'Read file', 'Write file']) {
      assert.ok(schemas.some(schema => schema.description.startsWith(`${name} (configured provider ${bindingId})`)));
    }

    const readSchema = schemas.find(schema =>
      schema.description.startsWith(`Read file (configured provider ${bindingId})`));
    assert.ok(readSchema);
    assert.equal(readSchema.parameters.properties.path.type, 'string');
    assert.equal(readSchema.parameters.properties.path.maxLength, undefined);
    assert.equal(readSchema.parameters.properties.path['x-maxUtf8Bytes'], undefined);
    assert.equal(readSchema.parameters.properties.length.type, 'integer');
    assert.equal(readSchema.parameters.properties.offset.type, 'integer');
    assert.deepEqual(computerToolCatalog.tools.map(tool => tool.inputSchema), rawSchemas);

    const invalidPath = await execute(ctx, readSchema.name, {
      path: '😀'.repeat(1_025),
      length: 1,
    }, 'utf8-over-limit', false);
    assert.equal(invalidPath.isError, true);
    assert.match(invalidPath.error.message, /UTF-8 byte limit/u);
    assert.equal(fixture.callCount(), 0);

    const validPath = await execute(ctx, readSchema.name, {
      path: '文'.repeat(512),
      length: 1,
    }, 'utf8-under-limit', false);
    assert.equal(validPath.isError, false);
    assert.equal(fixture.callCount(), 1);

    const invalidLength = await execute(ctx, readSchema.name, {
      path: '文档/说明.txt',
      length: 65_537,
    }, 'read-length-over-limit', false);
    assert.equal(invalidLength.isError, true);
    assert.match(invalidLength.error.message, /configured bounds/u);
    assert.equal(fixture.callCount(), 1);

    const invalidOffset = await execute(ctx, readSchema.name, {
      path: '文档/说明.txt',
      length: 1,
      offset: 9_007_199_254_740_992,
    }, 'offset-over-limit', false);
    assert.equal(invalidOffset.isError, true);
    assert.match(invalidOffset.error.message, /configured bounds/u);
    assert.equal(fixture.callCount(), 1);

    const commandSchema = schemas.find(schema =>
      schema.description.startsWith(`Execute command (configured provider ${bindingId})`));
    assert.ok(commandSchema);
    const invalidTimeout = await execute(ctx, commandSchema.name, {
      command: 'true',
      timeout_ms: 600_001,
    }, 'timeout-over-limit', false);
    assert.equal(invalidTimeout.isError, true);
    assert.match(invalidTimeout.error.message, /configured bounds/u);
    assert.equal(fixture.callCount(), 1);

    const invalidCommand = await execute(ctx, commandSchema.name, {
      command: '',
    }, 'command-under-minimum', false);
    assert.equal(invalidCommand.isError, true);
    assert.match(invalidCommand.error.message, /configured bounds/u);
    assert.equal(fixture.callCount(), 1);

    const directorySchema = schemas.find(schema =>
      schema.description.startsWith(`List directory (configured provider ${bindingId})`));
    assert.ok(directorySchema);
    const invalidDepth = await execute(ctx, directorySchema.name, {
      path: '.',
      max_depth: 33,
    }, 'directory-depth-over-limit', false);
    assert.equal(invalidDepth.isError, true);
    assert.match(invalidDepth.error.message, /configured bounds/u);
    assert.equal(fixture.callCount(), 1);

    const invalidDirectoryPath = await execute(ctx, directorySchema.name, {
      path: 'x'.repeat(1_025),
    }, 'directory-path-over-limit', false);
    assert.equal(invalidDirectoryPath.isError, true);
    assert.match(invalidDirectoryPath.error.message, /configured bounds/u);
    assert.equal(fixture.callCount(), 1);

    const writeSchema = schemas.find(schema =>
      schema.description.startsWith(`Write file (configured provider ${bindingId})`));
    assert.ok(writeSchema);
    const invalidEncodedContent = await execute(ctx, writeSchema.name, {
      path: '文档/新文件.bin',
      content_base64: 'A'.repeat(1_398_105),
      overwrite: true,
    }, 'encoded-content-over-limit', false);
    assert.equal(invalidEncodedContent.isError, true);
    assert.match(invalidEncodedContent.error.message, /configured bounds/u);
    assert.equal(fixture.callCount(), 1);
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('unknown provider schema extensions remain rejected', async () => {
  const tool = structuredClone(computerToolCatalog.tools[1]);
  tool.inputSchema.properties.path['x-unrecognizedPolicy'] = 1;
  const fixture = createBridgeFixture({ toolCatalog: { tools: [tool] } });
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  try {
    await assert.rejects(registerToolProviders(ctx, {
      bridge: fixture.bridge,
      taskIdForSession: id => id === sessionId ? taskId : undefined,
    }), /x-unrecognizedPolicy is not a supported keyword/u);
    assert.equal(ctx.tools.schemas().length, 0);
    assert.equal(fixture.callCount(), 0);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('write tools await approval, create a task-linked receipt, then call and verify', async () => {
  const fixture = createBridgeFixture();
  const { ctx, dispose } = await createToolContext(fixture);
  try {
    const schema = schemaFor(ctx, writeToolId);
    assert.ok(schema);
    const args = { conversationId: 'team-chat-9', text: 'Deployment completed.' };
    const result = await execute(ctx, schema.name, args, 'write-call-7');

    assert.equal(result.isError, false);
    assert.deepEqual(result.value, {
      content: [{ type: 'text', text: 'Message delivered.' }],
      structuredContent: { messageId: 'message-42' },
    });
    const approval = fixture.events.find(event => event.type === 'approval');
    const receipt = fixture.events.find(event => event.type === 'mutate' && event.path === '/operations');
    const call = fixture.events.find(event => event.type === 'mutate' && event.path.endsWith(`/tools/${writeToolId}/call`));
    const verification = fixture.events.find(event => event.type === 'request' && event.path.startsWith('/operations/'));
    assert.equal(approval.actualSessionId, sessionId);
    assert.equal(approval.kind, 'tool.provider.v1');
    assert.deepEqual(approval.details, { bindingId, toolId: writeToolId, arguments: args });
    assert.ok(fixture.events.indexOf(approval) < fixture.events.indexOf(receipt));
    assert.ok(fixture.events.indexOf(receipt) < fixture.events.indexOf(call));
    assert.equal(receipt.body.taskId, taskId);
    assert.equal(receipt.taskLinked, true);
    assert.equal(call.taskLinked, false);
    assert.equal(call.sessionId, sessionId);
    assert.equal(JSON.parse(JSON.stringify(verification.body)).status, 'verified');
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('approval rejection prevents operation receipt creation and provider call', async () => {
  const fixture = createBridgeFixture({ approvalError: new Error('The human rejected this operation') });
  const { ctx, dispose } = await createToolContext(fixture);
  try {
    const schema = schemaFor(ctx, writeToolId);
    assert.ok(schema);
    const result = await execute(ctx, schema.name, { conversationId: 'team-chat-9', text: 'No send.' }, 'rejected-call');

    assert.equal(result.isError, true);
    assert.equal(fixture.events.some(event => event.type === 'mutate' || event.path?.includes('/operations/')), false);
    assert.equal(fixture.callCount(), 0);
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('projected string bounds remain enforced before approval and provider calls', async () => {
  const fixture = createBridgeFixture();
  const { ctx, dispose } = await createToolContext(fixture);
  try {
    const schema = schemaFor(ctx, writeToolId);
    assert.ok(schema);
    assert.equal(schema.parameters.properties.text.minLength, undefined);
    const result = await execute(
      ctx, schema.name, { conversationId: 'team-chat-9', text: '' }, 'empty-message',
    );
    assert.equal(result.isError, true);
    assert.match(result.error.message, /configured bounds/u);
    assert.equal(fixture.events.some(event => event.type === 'approval'), false);
    assert.equal(fixture.callCount(), 0);
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});

test('uncertain receipts stop retries after a provider call failure', async () => {
  const fixture = createBridgeFixture({ callError: new Error('unavailable') });
  const { ctx, dispose } = await createToolContext(fixture);
  try {
    const schema = schemaFor(ctx, writeToolId);
    assert.ok(schema);
    const args = { conversationId: 'team-chat-9', text: 'May have been sent.' };
    const first = await execute(ctx, schema.name, args, 'same-write-call');
    assert.equal(first.isError, true);
    assert.match(first.error.message, /uncertain/u);
    const uncertain = fixture.events.find(event => event.type === 'request' && event.method === 'PATCH');
    assert.deepEqual(uncertain.body, {
      status: 'uncertain', evidence: { outcome: 'unknown_after_provider_call' },
    });

    fixture.bridge.mutate = async (execution, path, method, body, taskLinked = false) => {
      fixture.events.push({ type: 'mutate', path, method, body, taskLinked, sessionId: execution.agent?.session.id });
      if (path === '/operations' && method === 'POST') {
        return { operation: { id: 'operation-existing', status: 'uncertain' }, duplicate: true };
      }
      throw new Error(`Unexpected replay ${method} ${path}`);
    };
    const retry = await execute(ctx, schema.name, args, 'same-write-call');
    assert.equal(retry.isError, true);
    assert.match(retry.error.message, /reconcile/u);
    assert.equal(fixture.callCount(), 1);
  } finally {
    dispose();
    await ctx.fiber.dispose();
  }
});
