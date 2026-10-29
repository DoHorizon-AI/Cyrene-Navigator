// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator and Exchange connector contract acceptance         │
// │ Role: Exercise the real Navigator client against a real Exchange app.│
// │                                                                      │
// │ 模块职责：通过真实 Navigator 客户端和 Exchange HTTP 路由验证跨仓契约。│
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import {
  ExchangeConnectorAuthorizationClient,
  ExchangeConnectorRequestError,
  canonicalJson,
  sha256,
  teamsThreadResourceRef,
  validateTeamsServiceUrl,
} from '../dist/connector-authorization.js';
import { registerToolProviders } from '../dist/tool-providers.js';

const SESSION_ID = 'cross-repo-dsh-session';
const TASK_ID = 'teams-cross-repo-acceptance-task';
const TEAM_REPLY = 'Synthetic acceptance reply; no Teams message is sent.';
const FIXTURE_FILE = process.env.EXCHANGE_CONTRACT_FIXTURE_FILE;
const JCS_VECTOR_FILE = process.env.EXCHANGE_CONTRACT_JCS_VECTOR_FILE;
const FIXTURE_AVAILABLE = Boolean(FIXTURE_FILE && JCS_VECTOR_FILE);

function contractTest(name, callback) {
  test(name, {
    skip: FIXTURE_AVAILABLE ? false : 'run the private Exchange acceptance runner to provide local fixture metadata',
  }, callback);
}

let fixture;
let jcsVectors;
let client;
let trackedClient;
let authorizations;
let mintedGrants;
let context;
let disposeProviders;
let workBridge;
let bridgeEvents;
let receipts;

before(async () => {
  if (!FIXTURE_AVAILABLE) return;
  assert.ok(FIXTURE_FILE, 'The local Exchange fixture runner must set EXCHANGE_CONTRACT_FIXTURE_FILE');
  assert.ok(JCS_VECTOR_FILE, 'The local Exchange fixture runner must set EXCHANGE_CONTRACT_JCS_VECTOR_FILE');
  fixture = JSON.parse(await readFile(FIXTURE_FILE, 'utf8'));
  jcsVectors = JSON.parse(await readFile(JCS_VECTOR_FILE, 'utf8')).vectors;
  client = new ExchangeConnectorAuthorizationClient({
    baseUrl: fixture.baseUrl,
    hmacKeyFile: fixture.hmacKeyFile,
    hmacKeyId: fixture.hmacKeyId,
    audience: fixture.audience,
    requestTimeoutMs: 5_000,
  });
  mintedGrants = new Map();
  trackedClient = {
    async mintGrant(input, signal) {
      const grant = await client.mintGrant(input, signal);
      mintedGrants.set(input.requestId, grant);
      return grant;
    },
    callProviderOperation(input, grant, signal) {
      return client.callProviderOperation(input, grant, signal);
    },
  };
  bridgeEvents = [];
  receipts = [];
  workBridge = createWorkBridge(fixture, bridgeEvents, receipts);
  context = new Context();
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime);

  authorizations = new Map();
  for (const providerId of Object.keys(fixture.bindings)) {
    const binding = fixture.bindings[providerId];
    authorizations.set(binding.bindingId, {
      bindingId: binding.bindingId,
      connectionRef: binding.connectionRef,
      providerId: binding.providerId,
      profileRef: binding.profileRef,
      tools: binding.tools,
    });
  }
  disposeProviders = await registerToolProviders(context, {
    bridge: workBridge,
    taskIdForSession: sessionId => sessionId === SESSION_ID ? TASK_ID : undefined,
    connectorAuthorization: {
      client: trackedClient,
      workspaceId: fixture.workspaceId,
      bindings: authorizations,
    },
  });
});

after(async () => {
  disposeProviders?.();
  if (context) await context.fiber.dispose();
});

contractTest('real DSH ToolResult round-trips GitHub repository list and the empty lease target', async () => {
  const binding = fixture.bindings.github;
  const schema = findSchema(context, 'List GitHub Repositories', binding.bindingId);
  const result = await executeTool(context, schema.name, {}, 'cross-gh-list-1');

  assert.equal(result.isError, false);
  assert.match(result.value.content[0].text, /acceptance-probe/u);
  const grant = mintedGrants.get('cross-gh-list-1');
  assertRawProviderGrant(grant, fixture.githubProfileRef, {});
  const audit = await readAudit(fixture.baseUrl);
  const lease = audit.accountLeases.find(row => row.operationId === 'github.repository.list');
  assert.deepEqual(lease?.target, {});
  assert.equal(lease?.argumentsSha256, sha256(canonicalJson({})));
  assert.equal(audit.githubCalls.filter(row => row.toolId === 'github.repository.list').length, 1);
});

contractTest('Exchange Python verifier accepts the Platform Rust signer protobuf wire vector', async () => {
  const audit = await readAudit(fixture.baseUrl);
  assert.equal(audit.platformWireValidation?.verified, true);
  assert.equal(typeof audit.platformWireValidation?.grantRef, 'string');
  assert.equal(typeof audit.platformWireValidation?.signingKeyId, 'string');
  assert.match(audit.platformWireValidation?.platformSourceCommit ?? '', /^[0-9a-f]{7,40}$/u);
});

contractTest('all mapped official GitHub, Hugging Face, Azure, and RunPod schemas register with DSH', () => {
  for (const providerId of ['github', 'huggingface', 'azure', 'runpod']) {
    const binding = fixture.bindings[providerId];
    assert.ok(binding.catalog.length > 0, `${providerId} catalog should come from the official provider source`);
    for (const tool of binding.catalog) {
      const registered = context.tools.schemas().some(schema =>
        schema.description.startsWith(`${tool.name} (configured provider ${binding.bindingId})`));
      assert.equal(registered, true, `${providerId} ${tool.id} should register with DSH`);
    }
  }

  const hfModels = fixture.bindings.huggingface.catalog.find(tool => tool.id === 'huggingface.models.list');
  assert.equal(hfModels?.inputSchema.properties.limit.minimum, 1);
  assert.equal(hfModels?.inputSchema.properties.limit.maximum, 100);
  const hfModelsDsh = findSchema(context, 'List Hugging Face Models', fixture.bindings.huggingface.bindingId);
  assert.equal(hfModelsDsh.parameters.properties.limit.minimum, undefined);
  assert.equal(hfModelsDsh.parameters.properties.limit.maximum, undefined);

  const hfUpload = fixture.bindings.huggingface.catalog.find(tool => tool.id === 'huggingface.file.upload');
  assert.equal(hfUpload?.inputSchema.properties.content_base64.maxLength, 1_398_104);
  const hfUploadDsh = findSchema(context, 'Upload Hugging Face File', fixture.bindings.huggingface.bindingId);
  assert.equal(hfUploadDsh.parameters.properties.content_base64.maxLength, undefined);

  const githubIssueSearch = fixture.bindings.github.catalog.find(tool => tool.id === 'github.issues.search');
  assert.equal(githubIssueSearch?.inputSchema.properties.labels.uniqueItems, true);
  const githubIssueSearchDsh = findSchema(context, 'Search GitHub Issues', fixture.bindings.github.bindingId);
  assert.equal(githubIssueSearchDsh.parameters.properties.labels.uniqueItems, undefined);

  const azureTarget = fixture.bindings.azure.catalog.find(tool => tool.id === 'cloud_resource_get');
  assert.equal(azureTarget?.inputSchema.properties.target.minProperties, 1);
  assert.equal(azureTarget?.inputSchema.properties.target.maxProperties, 8);
  const azureTargetDsh = findSchema(context, 'Get Cloud Resource', fixture.bindings.azure.bindingId);
  assert.equal(azureTargetDsh.parameters.properties.target.minProperties, undefined);
  assert.equal(azureTargetDsh.parameters.properties.target.maxProperties, undefined);

  const cloudCli = fixture.bindings.azure.catalog.find(tool => tool.id === 'cloud_vendor_cli');
  assert.equal(cloudCli?.inputSchema.properties.argv.minItems, 1);
  assert.equal(cloudCli?.inputSchema.properties.argv.maxItems, 128);
  assert.equal(cloudCli?.inputSchema.properties.argv.items.maxLength, 4_096);
  const cloudCliDsh = findSchema(context, 'Run Cloud Vendor CLI', fixture.bindings.azure.bindingId);
  assert.equal(cloudCliDsh.parameters.properties.argv.minItems, undefined);
  assert.equal(cloudCliDsh.parameters.properties.argv.maxItems, undefined);
  assert.equal(cloudCliDsh.parameters.properties.argv.items.maxLength, undefined);
});

contractTest('full official numeric, object, array, and HF upload bounds reject before grant mint', async () => {
  const initialAudit = await readAudit(fixture.baseUrl);
  const initialGrantCount = initialAudit.authorityGrants.length;
  const initialGithubCount = initialAudit.githubCalls.length;
  const initialHfCount = initialAudit.hfCalls.length;

  const hfModels = findSchema(context, 'List Hugging Face Models', fixture.bindings.huggingface.bindingId);
  const invalidLimit = await executeTool(context, hfModels.name, { limit: 101 }, 'cross-invalid-hf-limit-1');
  assert.equal(invalidLimit.isError, true);
  assert.match(invalidLimit.error.message, /violates its configured bounds/u);

  const hfUpload = findSchema(context, 'Upload Hugging Face File', fixture.bindings.huggingface.bindingId);
  const oversizedContent = await executeTool(context, hfUpload.name, {
    repo_type: 'model',
    repo_id: fixture.huggingfaceRepository,
    path: 'README.md',
    content_base64: 'A'.repeat(1_398_105),
  }, 'cross-invalid-hf-upload-length-1');
  assert.equal(oversizedContent.isError, true);
  assert.match(oversizedContent.error.message, /violates its configured bounds/u);

  const azureTarget = findSchema(context, 'Get Cloud Resource', fixture.bindings.azure.bindingId);
  const emptyTarget = await executeTool(context, azureTarget.name, {
    profile_ref: 'azure-profile-fixture',
    target: {},
  }, 'cross-invalid-azure-target-1');
  assert.equal(emptyTarget.isError, true);
  assert.match(emptyTarget.error.message, /violates its configured bounds/u);

  const cloudCli = findSchema(context, 'Run Cloud Vendor CLI', fixture.bindings.azure.bindingId);
  const emptyArgv = await executeTool(context, cloudCli.name, {
    profile_ref: 'azure-profile-fixture',
    argv: [],
  }, 'cross-invalid-cloud-cli-argv-1');
  assert.equal(emptyArgv.isError, true);
  assert.match(emptyArgv.error.message, /violates its configured bounds/u);

  for (const requestId of [
    'cross-invalid-hf-limit-1',
    'cross-invalid-hf-upload-length-1',
    'cross-invalid-azure-target-1',
    'cross-invalid-cloud-cli-argv-1',
  ]) assert.equal(mintedGrants.has(requestId), false);

  const finalAudit = await readAudit(fixture.baseUrl);
  assert.equal(finalAudit.authorityGrants.length, initialGrantCount);
  assert.equal(finalAudit.githubCalls.length, initialGithubCount);
  assert.equal(finalAudit.hfCalls.length, initialHfCount);
});

contractTest('official Cloud Resources schemas register through the production DSH adapter and keep selector bounds', async () => {
  const bindingId = 'cloud-resources-schema-only';
  const schemaCatalog = fixture.cloudResourcesSchemaOnly;
  assert.equal(schemaCatalog.length, 2);
  let providerCallCount = 0;
  const schemaContext = new Context();
  await schemaContext.plugin(SystemPrompt);
  await schemaContext.plugin(ToolRuntime);
  const bridge = {
    async request(path, method) {
      if (path === '/tool-providers' && method === 'GET') {
        return { items: [{ bindingId, capabilityId: 'tool.provider.v1' }] };
      }
      if (path === `/tool-providers/${bindingId}/tools` && method === 'GET') {
        return { tools: schemaCatalog };
      }
      providerCallCount += 1;
      throw new Error(`Unexpected schema-only provider invocation ${method} ${path}`);
    },
    async requestApproval() { throw new Error('Schema-only catalog must not request approval'); },
    async mutate() { throw new Error('Schema-only catalog must not mutate'); },
  };
  const dispose = await registerToolProviders(schemaContext, {
    bridge,
    taskIdForSession: () => undefined,
  });
  try {
    for (const tool of schemaCatalog) {
      const registered = schemaContext.tools.schemas().find(schema =>
        schema.description.startsWith(`${tool.name} (configured provider ${bindingId})`));
      assert.ok(registered, `${tool.id} should register from the unchanged official schema`);
      assert.equal(registered.parameters.properties.target_ref.pattern, undefined);
      assert.equal(registered.parameters.properties.target_ref.maxLength, undefined);
    }
    const query = schemaContext.tools.schemas().find(schema =>
      schema.description.startsWith(`Query Cloud Resource Observation (configured provider ${bindingId})`));
    assert.ok(query);
    const invalid = await schemaContext.tools.execute({
      name: query.name,
      callId: ToolCallId('cross-invalid-cloud-resource-ref-1'),
      arguments: { target_ref: 'invalid selector with spaces' },
      signal: new AbortController().signal,
      agent: { id: 'schema-only-agent', session: { id: SESSION_ID } },
    });
    assert.equal(invalid.isError, true);
    assert.match(invalid.error.message, /violates its configured bounds/u);
    assert.equal(providerCallCount, 0);
  } finally {
    dispose();
    await schemaContext.fiber.dispose();
  }
});

contractTest('Navigator and Exchange canonical JSON match Platform float and Unicode JCS vectors', async () => {
  const audit = await readAudit(fixture.baseUrl);
  assert.equal(audit.exchangeJcsVectors.length, jcsVectors.length);
  for (const vector of jcsVectors) {
    const expectedCanonical = Buffer.from(vector.canonical_utf8_base64, 'base64').toString('utf8');
    const navigatorCanonical = canonicalJson(vector.input);
    assert.equal(navigatorCanonical, expectedCanonical, vector.id);
    assert.equal(sha256(navigatorCanonical), vector.sha256_hex, vector.id);
    const exchangeVector = audit.exchangeJcsVectors.find(row => row.id === vector.id);
    assert.equal(exchangeVector?.canonicalUtf8, expectedCanonical, vector.id);
    assert.equal(exchangeVector?.sha256Hex, vector.sha256_hex, vector.id);
  }
});

contractTest('real DSH ToolResult round-trips Hugging Face model listing with a model lease target', async () => {
  const binding = fixture.bindings.huggingface;
  const schema = findSchema(context, 'List Hugging Face Models', binding.bindingId);
  const result = await executeTool(context, schema.name, {}, 'cross-hf-list-1');

  assert.equal(result.isError, false);
  assert.match(result.value.content[0].text, /acceptance-probe/u);
  const grant = mintedGrants.get('cross-hf-list-1');
  assertRawProviderGrant(grant, fixture.huggingfaceProfileRef, {});
  const audit = await readAudit(fixture.baseUrl);
  const lease = audit.accountLeases.find(row => row.operationId === 'huggingface.models.list');
  assert.deepEqual(lease?.target, { repo_type: 'model' });
  assert.equal(lease?.argumentsSha256, sha256(canonicalJson({})));
  assert.equal(audit.hfCalls.filter(row => row.operationId === 'huggingface.models.list').length, 1);
});

contractTest('large synthetic Hugging Face download replays as receiptOnly without persisting content', async () => {
  const binding = fixture.bindings.huggingface;
  const schema = findSchema(context, 'Download Hugging Face File', binding.bindingId);
  const callId = 'cross-hf-download-large-1';
  const result = await executeTool(context, schema.name, {
    repo_type: 'model',
    repo_id: fixture.huggingfaceRepository,
    path: 'README.md',
  }, callId);

  assert.equal(result.isError, false);
  const businessResult = JSON.parse(result.value.content[0].text);
  assert.equal(businessResult.byte_length > 16_384, true);
  assert.equal(businessResult.content_base64.length, fixture.syntheticHfContentLength);

  const grant = mintedGrants.get(callId);
  assertRawProviderGrant(grant, fixture.huggingfaceProfileRef, {
    repo_type: 'model',
    repo_id: fixture.huggingfaceRepository,
    path: 'README.md',
  });
  const replay = await client.callProviderOperation({
    requestId: callId,
    connectionRef: fixture.huggingfaceConnectionRef,
    providerId: 'huggingface',
    profileRef: fixture.huggingfaceProfileRef,
    operationId: 'huggingface.file.download',
    resourceRef: grant.request.resourceRef,
    arguments: grant.request.arguments,
  }, grant, new AbortController().signal);
  assert.equal(replay.outcome, 'verified');
  const replayReceipt = JSON.parse(replay.result.content[0].text);
  assert.equal(replayReceipt.receiptOnly, true);
  assert.equal(replayReceipt.freshRequestRequired, true);
  assert.match(replayReceipt.resultDigestSha256, /^[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(replayReceipt, 'content_base64'), false);

  const persisted = await readLedger(fixture.baseUrl, callId);
  assert.equal(persisted.found, true);
  assert.equal(persisted.containsSyntheticHfPayload, false);
  assert.equal(persisted.containsReceiptOnly, true);
  assert.equal(persisted.containsFreshRequestRequired, true);
  assert.equal(persisted.responseBytes < 4_096, true);
  const audit = await readAudit(fixture.baseUrl);
  assert.equal(audit.hfCalls.filter(row => row.operationId === 'huggingface.file.download').length, 1);
});

contractTest('GitHub branch and CI reads preserve the exact synthetic commit SHA', async () => {
  const binding = fixture.bindings.github;
  const branchSchema = findSchema(context, 'List GitHub Branches', binding.bindingId);
  const branchResult = await executeTool(context, branchSchema.name, {
    repository_id: fixture.githubRepositoryId,
    repository: fixture.githubRepository,
  }, 'cross-gh-branches-1');
  assert.equal(branchResult.isError, false);
  assert.match(branchResult.value.content[0].text, new RegExp(fixture.githubCommitSha, 'u'));
  assertRawProviderGrant(mintedGrants.get('cross-gh-branches-1'), fixture.githubProfileRef, {
    repository_id: fixture.githubRepositoryId,
    repository: fixture.githubRepository,
  });

  const ciSchema = findSchema(context, 'Get GitHub CI Status', binding.bindingId);
  const ciArguments = {
    repository_id: fixture.githubRepositoryId,
    repository: fixture.githubRepository,
    commit_sha: fixture.githubCommitSha,
  };
  const ciResult = await executeTool(context, ciSchema.name, {
    ...ciArguments,
  }, 'cross-gh-ci-1');
  assert.equal(ciResult.isError, false);
  assert.match(ciResult.value.content[0].text, new RegExp(fixture.githubCommitSha, 'u'));
  assertRawProviderGrant(mintedGrants.get('cross-gh-ci-1'), fixture.githubProfileRef, ciArguments);
  const audit = await readAudit(fixture.baseUrl);
  const branchLease = audit.accountLeases.find(row => row.operationId === 'github.branches.list');
  assert.deepEqual(branchLease?.target, {
    repository_id: fixture.githubRepositoryId,
    repository: fixture.githubRepository,
  });
  const lease = audit.accountLeases.find(row => row.operationId === 'github.ci.status');
  assert.deepEqual(lease?.target, {
    repository_id: fixture.githubRepositoryId,
    repository: fixture.githubRepository,
    commit_sha: fixture.githubCommitSha,
  });
});

contractTest('full official GitHub schema validation rejects an invalid repository id before mint', async () => {
  const binding = fixture.bindings.github;
  const schema = findSchema(context, 'List GitHub Branches', binding.bindingId);
  const grantsBefore = (await readAudit(fixture.baseUrl)).authorityGrants.length;
  const providerCallsBefore = (await readAudit(fixture.baseUrl)).githubCalls.length;
  const requestId = 'cross-invalid-gh-repository-id-1';
  const result = await executeTool(context, schema.name, {
    repository_id: 'not-decimal',
    repository: fixture.githubRepository,
  }, requestId);

  assert.equal(result.isError, true);
  assert.equal(mintedGrants.has(requestId), false);
  const audit = await readAudit(fixture.baseUrl);
  assert.equal(audit.authorityGrants.length, grantsBefore);
  assert.equal(audit.githubCalls.length, providerCallsBefore);
});

contractTest('full official GitHub schema rejects duplicate search labels before grant mint', async () => {
  const binding = fixture.bindings.github;
  const schema = findSchema(context, 'Search GitHub Issues', binding.bindingId);
  const grantsBefore = (await readAudit(fixture.baseUrl)).authorityGrants.length;
  const providerCallsBefore = (await readAudit(fixture.baseUrl)).githubCalls.length;
  const requestId = 'cross-invalid-gh-duplicate-labels-1';
  const result = await executeTool(context, schema.name, {
    repository_id: fixture.githubRepositoryId,
    repository: fixture.githubRepository,
    state: 'OPEN',
    labels: ['bug', 'bug'],
    limit: 10,
  }, requestId);

  assert.equal(result.isError, true);
  assert.match(result.error.message, /labels violates its configured bounds or uniqueness/u);
  assert.equal(mintedGrants.has(requestId), false);
  const audit = await readAudit(fixture.baseUrl);
  assert.equal(audit.authorityGrants.length, grantsBefore);
  assert.equal(audit.githubCalls.length, providerCallsBefore);
});

contractTest('unknown GitHub write result is an error and leaves its DSH receipt uncertain', async () => {
  const binding = fixture.bindings.github;
  const schema = findSchema(context, 'Create GitHub Issue Comment', binding.bindingId);
  const result = await executeTool(context, schema.name, {
    repository_id: fixture.githubRepositoryId,
    repository: fixture.githubRepository,
    issue_number: 1,
    body: 'Synthetic unknown-result probe; no GitHub write is performed.',
  }, 'cross-gh-write-unknown-1');

  assert.equal(result.isError, true);
  assertRawProviderGrant(mintedGrants.get('cross-gh-write-unknown-1'), fixture.githubProfileRef, {
    repository_id: fixture.githubRepositoryId,
    repository: fixture.githubRepository,
    issue_number: 1,
    body: 'Synthetic unknown-result probe; no GitHub write is performed.',
  });
  assert.match(String(result.error?.message ?? result.value?.content?.[0]?.text ?? ''), /unknown remote (?:operation|write) result|uncertain/u);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'uncertain');
  assert.equal(receipts[0].evidence?.outcome, 'uncertain');
  assert.equal(receipts[0].evidence?.operationRef, 'synthetic-unknown-write-1');
  const audit = await readAudit(fixture.baseUrl);
  assert.equal(audit.githubCalls.filter(row => row.toolId === 'github.issue.comment.create').length, 1);
});

contractTest('GitHub and Hugging Face CLI calls bind argv-only claims to host profiles and empty lease targets', async () => {
  const githubBinding = fixture.bindings.github;
  const huggingfaceBinding = fixture.bindings.huggingface;
  const githubTool = githubBinding.catalog.find(tool => tool.id === 'github_vendor_cli');
  const huggingfaceTool = huggingfaceBinding.catalog.find(tool => tool.id === 'hf_vendor_cli');
  assert.ok(githubTool, 'official GitHub catalog must expose its fixed native CLI tool');
  assert.ok(huggingfaceTool, 'official Hugging Face catalog must expose its fixed native CLI tool');
  for (const tool of [githubTool, huggingfaceTool]) {
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['argv']);
    assert.deepEqual(tool.inputSchema.required, ['argv']);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }

  const githubSchema = findSchema(context, githubTool.name, githubBinding.bindingId);
  const githubArgv = ['repo', 'list', '--limit', '1'];
  const githubRequestId = 'cross-github-vendor-cli-1';
  const githubResult = await executeTool(context, githubSchema.name, { argv: githubArgv }, githubRequestId);
  assert.equal(githubResult.isError, false);
  const githubGrant = mintedGrants.get(githubRequestId);
  assert.ok(githubGrant);
  assert.deepEqual(githubGrant.request.arguments, { argv: githubArgv });
  assert.equal(githubGrant.request.profileRef, fixture.githubProfileRef);
  assert.equal(githubGrant.request.resourceRef, fixture.githubCliResourceRef);

  const huggingfaceSchema = findSchema(context, huggingfaceTool.name, huggingfaceBinding.bindingId);
  const huggingfaceArgv = ['models', 'ls', '--limit', '1'];
  const huggingfaceRequestId = 'cross-huggingface-vendor-cli-1';
  const huggingfaceResult = await executeTool(
    context,
    huggingfaceSchema.name,
    { argv: huggingfaceArgv },
    huggingfaceRequestId,
  );
  assert.equal(huggingfaceResult.isError, false);
  const huggingfaceGrant = mintedGrants.get(huggingfaceRequestId);
  assert.ok(huggingfaceGrant);
  assert.deepEqual(huggingfaceGrant.request.arguments, { argv: huggingfaceArgv });
  assert.equal(huggingfaceGrant.request.profileRef, fixture.huggingfaceProfileRef);
  assert.equal(huggingfaceGrant.request.resourceRef, fixture.huggingfaceCliResourceRef);

  const audit = await readAudit(fixture.baseUrl);
  for (const [providerId, operationId, requestId, argv, profileRef, resourceRef] of [
    ['github', 'github.vendor.cli.execute', githubRequestId, githubArgv, fixture.githubProfileRef, fixture.githubCliResourceRef],
    ['huggingface', 'huggingface.vendor.cli.execute', huggingfaceRequestId, huggingfaceArgv, fixture.huggingfaceProfileRef, fixture.huggingfaceCliResourceRef],
  ]) {
    const grant = audit.authorityGrants.find(row => row.requestId === requestId);
    assert.equal(grant?.providerId, providerId);
    assert.equal(grant?.profileRef, profileRef);
    assert.equal(grant?.operationId, operationId);
    assert.equal(grant?.resourceRef, resourceRef);
    assert.equal(grant?.argumentsDigestSha256, sha256(canonicalJson({ argv })));
    const lease = audit.accountLeases.find(row => row.operationId === operationId);
    assert.deepEqual(lease?.target, {});
    assert.equal(lease?.profileRef, profileRef);
    assert.equal(lease?.argumentsSha256, sha256(canonicalJson({ argv })));
  }
  const githubInvocation = audit.githubCalls.find(row => row.toolId === 'github_vendor_cli');
  assert.equal(githubInvocation?.profileRef, fixture.githubProfileRef);
  assert.deepEqual(githubInvocation?.payload, { argv: githubArgv });
  const huggingfaceInvocation = audit.hfCalls.find(row => row.operationId === 'huggingface.vendor.cli.execute');
  assert.equal(huggingfaceInvocation?.operationId, 'huggingface.vendor.cli.execute');
  assert.deepEqual(huggingfaceInvocation?.payload, { argv: huggingfaceArgv });
});

contractTest('two Teams actors receive fresh grants for one shared workspace service connection', async () => {
  assert.equal(fixture.githubSharedAccessMode, 'workspace_operator');
  assert.equal(fixture.githubSharedBootstrapRoleVerified, true);
  const firstSubject = fixture.principalSubject;
  const secondSubject = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const deniedSubject = fixture.unauthorizedActorSubject;
  const firstSession = 'teams-shared-actor-one-session';
  const secondSession = 'teams-shared-actor-two-session';
  const deniedSession = 'teams-shared-actor-denied-session';
  const firstTask = 'teams-shared-actor-one-task';
  const secondTask = 'teams-shared-actor-two-task';
  const deniedTask = 'teams-shared-actor-denied-task';
  const firstRequestId = 'cross-shared-connection-actor-one-1';
  const secondRequestId = 'cross-shared-connection-actor-two-1';
  const deniedRequestId = 'cross-shared-connection-actor-denied-1';
  const argv = ['repo', 'list', '--limit', '1'];
  const taskCallers = new Map([
    [firstTask, {
      issuer: fixture.principalIssuer,
      subject: firstSubject,
      tenantId: fixture.tenantId,
      actorAadObjectId: firstSubject,
    }],
    [secondTask, {
      issuer: fixture.principalIssuer,
      subject: secondSubject,
      tenantId: fixture.tenantId,
      actorAadObjectId: secondSubject,
    }],
    [deniedTask, {
      issuer: fixture.principalIssuer,
      subject: deniedSubject,
      tenantId: fixture.tenantId,
      actorAadObjectId: deniedSubject,
    }],
  ]);
  const sessionTasks = new Map([
    [firstSession, firstTask],
    [secondSession, secondTask],
    [deniedSession, deniedTask],
  ]);
  const actorContext = new Context();
  await actorContext.plugin(SystemPrompt);
  await actorContext.plugin(ToolRuntime);
  const bridge = createWorkBridge(fixture, bridgeEvents, receipts, taskCallers);
  const dispose = await registerToolProviders(actorContext, {
    bridge,
    taskIdForSession: sessionId => sessionTasks.get(sessionId),
    connectorAuthorization: {
      client: trackedClient,
      workspaceId: fixture.workspaceId,
      bindings: authorizations,
    },
  });
  try {
    const binding = fixture.bindings.githubShared;
    const tool = binding.catalog.find(row => row.id === 'github_vendor_cli');
    assert.ok(tool);
    const schema = findSchema(actorContext, tool.name, binding.bindingId);
    const firstResult = await executeTool(actorContext, schema.name, { argv }, firstRequestId, firstSession);
    const secondResult = await executeTool(actorContext, schema.name, { argv }, secondRequestId, secondSession);
    assert.equal(firstResult.isError, false);
    assert.equal(secondResult.isError, false);

    const firstGrant = mintedGrants.get(firstRequestId);
    const secondGrant = mintedGrants.get(secondRequestId);
    assertRawProviderGrant(firstGrant, fixture.githubSharedProfileRef, { argv });
    assertRawProviderGrant(secondGrant, fixture.githubSharedProfileRef, { argv });
    assert.equal(firstGrant.request.connectionRef, secondGrant.request.connectionRef);
    assert.equal(firstGrant.request.profileRef, secondGrant.request.profileRef);
    assert.equal(firstGrant.request.resourceRef, secondGrant.request.resourceRef);
    assert.notEqual(firstGrant.grantRef, secondGrant.grantRef);
    assert.notEqual(firstGrant.request.requestId, secondGrant.request.requestId);

    const audit = await readAudit(fixture.baseUrl);
    const consumedAccountGrantRefs = [];
    for (const [requestId, subject] of [
      [firstRequestId, firstSubject],
      [secondRequestId, secondSubject],
    ]) {
    const grant = audit.authorityGrants.find(row => row.requestId === requestId);
      assert.equal(grant?.principalSubject, subject);
      assert.equal(grant?.connectionRef, firstGrant.request.connectionRef);
      assert.equal(grant?.profileRef, fixture.githubSharedProfileRef);
      assert.equal(grant?.operationId, 'github.vendor.cli.execute');
      assert.equal(grant?.resourceRef, fixture.githubSharedCliResourceRef);
      assert.equal(grant?.argumentsDigestSha256, sha256(canonicalJson({ argv })));
      const lease = audit.accountLeases.find(row =>
        row.operationId === 'github.vendor.cli.execute'
        && row.principalSubject === subject
        && row.profileRef === fixture.githubSharedProfileRef);
      assert.equal(lease?.profileRef, fixture.githubSharedProfileRef);
      assert.equal(lease?.connectorGrantConnectionRef, fixture.githubSharedConnectionRef);
      assert.equal(lease?.connectorGrantResourceRef, fixture.githubSharedCliResourceRef);
      assert.deepEqual(lease?.target, {});
      assert.equal(lease?.argumentsSha256, sha256(canonicalJson({ argv })));
      assert.equal(typeof lease?.connectorGrantRef, 'string');
      consumedAccountGrantRefs.push(lease?.connectorGrantRef);
    }
    assert.notEqual(consumedAccountGrantRefs[0], consumedAccountGrantRefs[1]);

    const callsBeforeDenied = audit.githubCalls.length;
    const leasesBeforeDenied = audit.accountLeases.length;
    const grantsBeforeDenied = audit.authorityGrants.length;
    const deniedResult = await executeTool(
      actorContext,
      schema.name,
      { argv },
      deniedRequestId,
      deniedSession,
    );
    assert.equal(deniedResult.isError, true);
    assert.equal(mintedGrants.has(deniedRequestId), false);
    const afterRoleDenied = await readAudit(fixture.baseUrl);
    assert.equal(afterRoleDenied.githubCalls.length, callsBeforeDenied);
    assert.equal(afterRoleDenied.accountLeases.length, leasesBeforeDenied);
    assert.equal(afterRoleDenied.authorityGrants.length, grantsBeforeDenied);

    const sharedCliRequest = (requestId, overrides = {}) => ({
      requestId,
      workspaceId: fixture.workspaceId,
      principalIssuer: fixture.principalIssuer,
      principalSubject: firstSubject,
      connectionRef: fixture.githubSharedConnectionRef,
      providerId: 'github',
      profileRef: fixture.githubSharedProfileRef,
      operationId: 'github.vendor.cli.execute',
      resourceRef: fixture.githubSharedCliResourceRef,
      argumentsDigestSha256: sha256(canonicalJson({ argv })),
      arguments: { argv },
      ...overrides,
    });
    for (const [requestId, changes] of [
      ['cross-shared-connection-changed-issuer-1', { principalIssuer: 'https://other-issuer.invalid' }],
      ['cross-shared-connection-changed-workspace-1', { workspaceId: 'other-workspace' }],
    ]) {
      await assert.rejects(
        client.mintGrant(sharedCliRequest(requestId, changes), new AbortController().signal),
        error => error instanceof ExchangeConnectorRequestError && error.status === 404,
      );
    }
    await assert.rejects(
      client.mintGrant(
        sharedCliRequest('cross-shared-authority-wrong-org-1'),
        new AbortController().signal,
      ),
      error => error instanceof ExchangeConnectorRequestError && error.status === 403,
    );
    const afterScopeDenials = await readAudit(fixture.baseUrl);
    assert.equal(afterScopeDenials.githubCalls.length, callsBeforeDenied);
    assert.equal(afterScopeDenials.accountLeases.length, leasesBeforeDenied);
    assert.equal(
      afterScopeDenials.authorityGrants.filter(row => row.organizationId === 'org-synthetic-authority-mismatch').length,
      1,
    );
  } finally {
    dispose();
    await actorContext.fiber.dispose();
  }
});

contractTest('Teams nested route grant reaches Exchange and exposes a typed 429 result', async () => {
  const route = fixture.teamsRoute;
  assert.equal(validateTeamsServiceUrl(route.serviceUrl, route.tenantId), route.serviceUrl);
  assert.throws(
    () => validateTeamsServiceUrl('https://attacker.example/teams/', route.tenantId),
    /host is not allowed/u,
  );
  const argumentsValue = { conversation: route, text: TEAM_REPLY };
  const requestId = 'cross-teams-send-1';
  const grant = await client.mintGrant({
    requestId,
    workspaceId: fixture.workspaceId,
    principalIssuer: fixture.principalIssuer,
    principalSubject: fixture.principalSubject,
    connectionRef: fixture.teamsConnectionRef,
    providerId: 'msteams',
    profileRef: fixture.teamsProfileRef,
    operationId: 'msteams.message.reply',
    resourceRef: teamsThreadResourceRef(route),
    argumentsDigestSha256: sha256(canonicalJson(argumentsValue)),
    arguments: argumentsValue,
  }, new AbortController().signal);
  const outcome = await client.sendTeamsMessage(
    { requestId, conversation: route, text: TEAM_REPLY },
    grant,
    fixture.teamsConnectionRef,
    fixture.teamsProfileRef,
    new AbortController().signal,
  );

  assert.equal(outcome.outcome, 'rate_limited');
  assert.equal(outcome.retryAfterSeconds, 7);
  const audit = await readAudit(fixture.baseUrl);
  const call = audit.teamsCalls.at(-1);
  assert.deepEqual(
    {
      tenantId: call.tenantId,
      serviceUrl: call.serviceUrl,
      teamId: call.teamId,
      channelId: call.channelId,
      conversationId: call.conversationId,
      rootThreadId: call.rootThreadId,
      requestId: call.requestId,
    },
    { ...route, requestId },
  );
  const grantRecord = audit.authorityGrants.find(row => row.requestId === requestId);
  assert.equal(grantRecord?.providerId, 'msteams');
  assert.equal(grantRecord?.operationId, 'msteams.message.reply');
  assert.equal(grantRecord?.resourceRef, teamsThreadResourceRef(route));
  assert.equal(grantRecord?.argumentsDigestSha256, sha256(canonicalJson(argumentsValue)));

  const invalidRoute = { ...route, serviceUrl: 'https://attacker.example/teams/' };
  const invalidArguments = { conversation: invalidRoute, text: TEAM_REPLY };
  await assert.rejects(
    client.mintGrant({
      requestId: 'cross-teams-invalid-service-url-1',
      workspaceId: fixture.workspaceId,
      principalIssuer: fixture.principalIssuer,
      principalSubject: fixture.principalSubject,
      connectionRef: fixture.teamsConnectionRef,
      providerId: 'msteams',
      profileRef: fixture.teamsProfileRef,
      operationId: 'msteams.message.reply',
      resourceRef: teamsThreadResourceRef(invalidRoute),
      argumentsDigestSha256: sha256(canonicalJson(invalidArguments)),
      arguments: invalidArguments,
    }, new AbortController().signal),
    error => error instanceof ExchangeConnectorRequestError && error.status === 403,
  );
});

contractTest('Exchange rejects a cryptographically valid but expired grant before provider dispatch', async () => {
  const call = fixture.expiredGrantCall;
  const { connectionRef, ...body } = call;
  const callsBefore = (await readAudit(fixture.baseUrl)).githubCalls.length;
  const response = await fetch(
    `${fixture.baseUrl}/internal/v1/connector-operations/${encodeURIComponent(connectionRef)}`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'X-Cyrene-Connector-Grant-Bin': fixture.expiredGrantBin,
      },
      body: JSON.stringify(body),
    },
  );
  assert.equal(response.status, 403);
  const callsAfter = (await readAudit(fixture.baseUrl)).githubCalls.length;
  assert.equal(callsAfter, callsBefore);
});

contractTest('wrong HMAC, signed-request replay, grant receipt replay, and ambiguous auth stay bounded', async () => {
  const wrongClient = new ExchangeConnectorAuthorizationClient({
    baseUrl: fixture.baseUrl,
    hmacKeyFile: fixture.wrongHmacKeyFile,
    hmacKeyId: fixture.hmacKeyId,
    audience: fixture.audience,
    requestTimeoutMs: 5_000,
  });
  await assert.rejects(
    wrongClient.mintGrant(githubListRequest('cross-invalid-hmac-1'), new AbortController().signal),
    error => error instanceof ExchangeConnectorRequestError && error.status === 403,
  );

  const replayRequest = githubListRequest('cross-hmac-replay-1');
  await client.mintGrant(replayRequest, new AbortController().signal);
  await assert.rejects(
    client.mintGrant(replayRequest, new AbortController().signal),
    error => error instanceof ExchangeConnectorRequestError && error.status === 409,
  );

  const grant = await client.mintGrant(
    githubListRequest('cross-grant-replay-1'),
    new AbortController().signal,
  );
  const operation = githubListCall('cross-grant-replay-1');
  const first = await client.callProviderOperation(operation, grant, new AbortController().signal);
  assert.equal(first.outcome, 'verified');
  const callsBeforeReplay = (await readAudit(fixture.baseUrl)).githubCalls.filter(
    row => row.toolId === 'github.repository.list',
  ).length;
  const replayed = await client.callProviderOperation(operation, grant, new AbortController().signal);
  assert.equal(replayed.outcome, 'verified');
  const receiptOnly = JSON.parse(replayed.result.content[0].text);
  assert.equal(receiptOnly.receiptOnly, true);
  assert.equal(receiptOnly.freshRequestRequired, true);
  assert.equal(Object.hasOwn(receiptOnly, 'repositories'), false);
  const callsAfterReplay = (await readAudit(fixture.baseUrl)).githubCalls.filter(
    row => row.toolId === 'github.repository.list',
  ).length;
  assert.equal(callsAfterReplay, callsBeforeReplay);

  const protectedGrant = await client.mintGrant(
    githubListRequest('cross-ambiguous-auth-1'),
    new AbortController().signal,
  );
  const call = githubListCall('cross-ambiguous-auth-1');
  const rawResponse = await fetch(
    `${fixture.baseUrl}/internal/v1/connector-operations/${encodeURIComponent(call.connectionRef)}`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: 'Bearer synthetic-ambiguous-auth',
        'X-Cyrene-Connector-Grant-Bin': protectedGrant.connectorGrantBin,
      },
      body: JSON.stringify({
        requestId: call.requestId,
        providerId: call.providerId,
        profileRef: call.profileRef,
        operationId: call.operationId,
        resourceRef: call.resourceRef,
        arguments: call.arguments,
      }),
    },
  );
  assert.equal(rawResponse.status, 401);
  const recovered = await client.callProviderOperation(
    call,
    protectedGrant,
    new AbortController().signal,
  );
  assert.equal(recovered.outcome, 'verified');
});

function createWorkBridge(source, events, operationReceipts, taskCallers = new Map()) {
  const bindings = Object.values(source.bindings);
  return {
    async request(path, method, body, signal) {
      events.push({ type: 'request', path, method, body });
      signal?.throwIfAborted();
      if (method === 'GET' && path === '/tool-providers') {
        return {
          items: bindings.map(({ bindingId, capabilityId, providerId, connectionRef, profileRef }) => ({
            bindingId, capabilityId, providerId, connectionRef, profileRef,
          })),
        };
      }
      if (method === 'GET' && path.startsWith('/tool-providers/')) {
        const binding = bindings.find(item => path === `/tool-providers/${encodeURIComponent(item.bindingId)}/tools`);
        if (!binding) throw new Error(`Unexpected tool provider catalog path: ${path}`);
        return {
          tools: binding.catalog.map(tool => ({
            ...tool,
            connectionRef: binding.connectionRef,
            profileRef: binding.profileRef,
          })),
        };
      }
      if (method === 'GET' && path.startsWith('/tasks/')) {
        const requestedTaskId = path.slice('/tasks/'.length);
        const caller = taskCallers.get(requestedTaskId) ?? (requestedTaskId === TASK_ID ? {
          issuer: source.principalIssuer,
          subject: source.principalSubject,
          tenantId: source.tenantId,
          actorAadObjectId: source.principalSubject,
        } : undefined);
        if (caller === undefined) throw new Error(`Unknown synthetic Teams task: ${requestedTaskId}`);
        return {
          id: requestedTaskId,
          createdByActorId: caller.subject,
          metadata: {
            teamsCaller: caller,
          },
        };
      }
      if (method === 'GET' && path.startsWith('/operations/unresolved?')) return { items: [] };
      if (method === 'PATCH' && path.startsWith('/operations/')) {
        const receipt = operationReceipts.find(item => path === `/operations/${item.id}`);
        if (!receipt) throw new Error(`Unknown synthetic operation receipt: ${path}`);
        receipt.status = body.status;
        receipt.evidence = body.evidence;
        events.push({ type: 'receipt-patch', path, body });
        return { operation: { id: receipt.id, status: receipt.status } };
      }
      throw new Error(`Unexpected Work fixture request ${method} ${path}`);
    },
    async requestApproval() {
      throw new Error('The Teams acceptance fixture must not request a second approval');
    },
    async mutate(_execution, path, method, body) {
      events.push({ type: 'mutate', path, method, body });
      assert.equal(path, '/operations');
      assert.equal(method, 'POST');
      const receipt = {
        id: `synthetic-operation-${operationReceipts.length + 1}`,
        status: 'started',
      };
      operationReceipts.push(receipt);
      return { operation: receipt, duplicate: false };
    },
  };
}

function findSchema(ctx, displayName, bindingId) {
  const schema = ctx.tools.schemas().find(item =>
    item.description.startsWith(`${displayName} (configured provider ${bindingId})`));
  assert.ok(schema, `Expected registered DSH schema for ${displayName}`);
  return schema;
}

async function executeTool(ctx, name, args, callId, sessionId = SESSION_ID) {
  return ctx.tools.execute({
    name,
    callId: ToolCallId(callId),
    arguments: args,
    signal: new AbortController().signal,
    agent: { id: 'cross-repo-acceptance-agent', session: { id: sessionId } },
  });
}

function assertRawProviderGrant(grant, profileRef, rawArguments) {
  assert.ok(grant, 'The Navigator client should expose the fresh grant minted for this DSH call');
  assert.equal(grant.request.profileRef, profileRef);
  assert.deepEqual(grant.request.arguments, rawArguments);
  assert.equal(Object.hasOwn(grant.request.arguments, 'profile_ref'), false);
  assert.equal(Object.hasOwn(grant.request.arguments, 'profileRef'), false);
  assert.equal(grant.request.argumentsDigestSha256, sha256(canonicalJson(rawArguments)));
}

function githubListRequest(requestId) {
  const args = {};
  return {
    requestId,
    workspaceId: fixture.workspaceId,
    principalIssuer: fixture.principalIssuer,
    principalSubject: fixture.principalSubject,
    connectionRef: fixture.githubConnectionRef,
    providerId: 'github',
    profileRef: fixture.githubProfileRef,
    operationId: 'github.repository.list',
    resourceRef: sha256GithubRef(fixture.githubProfileRef, 'github.repository.list', {
      profile_ref: fixture.githubProfileRef,
    }),
    argumentsDigestSha256: sha256(canonicalJson(args)),
    arguments: args,
  };
}

function githubListCall(requestId) {
  const grantRequest = githubListRequest(requestId);
  return {
    requestId,
    connectionRef: grantRequest.connectionRef,
    providerId: grantRequest.providerId,
    profileRef: grantRequest.profileRef,
    operationId: grantRequest.operationId,
    resourceRef: grantRequest.resourceRef,
    arguments: grantRequest.arguments,
  };
}

function sha256GithubRef(profileRef, operationId, target) {
  return `sha256:${sha256(canonicalJson({
    providerId: 'github',
    profileRef,
    operationId,
    target,
  }))}`;
}

async function readAudit(baseUrl) {
  const response = await fetch(`${baseUrl}/__fixture/audit`, { redirect: 'error' });
  assert.equal(response.status, 200);
  return response.json();
}

async function readLedger(baseUrl, requestId) {
  const response = await fetch(`${baseUrl}/__fixture/ledger/${encodeURIComponent(requestId)}`, {
    redirect: 'error',
  });
  assert.equal(response.status, 200);
  return response.json();
}
