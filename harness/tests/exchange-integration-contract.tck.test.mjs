// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Exchange integration consumer contract TCK                  │
// │ Role: Verify Navigator's routes and DTOs against owner source data. │
// │                                                                      │
// │ 模块职责：将 Navigator 消费接口与 owner 源契约逐项校验。               │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  EXCHANGE_ISSUE_CONSUMER_OPERATIONS,
  EXCHANGE_ISSUE_OPERATION_STATES,
  EXCHANGE_ISSUE_SNAPSHOT_FRESHNESS,
  EXCHANGE_ISSUE_STATES,
} from '../dist/integrations/exchange-integration.js';

const lock = JSON.parse(readFileSync(new URL('../contracts/exchange-integration-v1.lock.json', import.meta.url), 'utf8'));
const fixtureBytes = readFileSync(new URL('../contracts/exchange-integration-v1.consumer.json', import.meta.url));
const ownerContract = JSON.parse(fixtureBytes.toString('utf8'));

test('consumer fixture is byte-pinned to the raw Exchange OpenAPI and catalog digests', () => {
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.ownerRepository, 'DoHorizon-AI/Cyrene-Exchange');
  assert.equal(
    createHash('sha256').update(fixtureBytes).digest('hex'),
    lock.consumerFixture.sha256,
  );
  assert.equal(ownerContract.sourceOpenapiSha256, lock.sourceArtifacts['contracts/product/v1/openapi.yaml']);
  assert.equal(ownerContract.sourceCatalogSha256, lock.sourceArtifacts['contracts/product/v2/catalog.json']);
});

test('pinned Exchange checkout reproduces every locked source artifact digest', () => {
  assert.match(lock.ownerCommitSha, /^[0-9a-f]{40}$/u);
  const sourceRoot = process.env.CYRENE_EXCHANGE_CONTRACT_SOURCE;
  if (process.env.CI === 'true') {
    assert.ok(sourceRoot, 'CI must supply the exact Exchange source checkout');
  }
  if (!sourceRoot) return;

  for (const [path, expectedDigest] of Object.entries(lock.sourceArtifacts)) {
    const sourceBytes = readFileSync(join(sourceRoot, path));
    assert.equal(
      createHash('sha256').update(sourceBytes).digest('hex'),
      expectedDigest,
      `${path} differs from the Exchange source pinned in the consumer lock`,
    );
  }
  const sourceFixture = readFileSync(join(sourceRoot, 'contracts/product/v1/exchange-integration-consumer.json'));
  assert.equal(
    createHash('sha256').update(sourceFixture).digest('hex'),
    lock.consumerFixture.sha256,
  );
});

test('the fixed Navigator operations match the owner OpenAPI and catalog routes', () => {
  assert.deepEqual(
    Object.keys(ownerContract.operations).sort(),
    Object.values(EXCHANGE_ISSUE_CONSUMER_OPERATIONS).map(operation => operation.operationId).sort(),
  );
  for (const operation of Object.values(EXCHANGE_ISSUE_CONSUMER_OPERATIONS)) {
    const ownerOperation = ownerContract.operations[operation.operationId];
    assert.ok(ownerOperation, `owner fixture omitted ${operation.operationId}`);
    assert.equal(ownerOperation.method, operation.method);
    assert.equal(ownerOperation.path, operation.path);
    assert.equal(ownerOperation.definition.operationId, operation.operationId);
    assert.equal(ownerOperation.catalog.operationId, operation.operationId);
    assert.equal(
      ownerOperation.catalog.resourceId.pathParameter,
      operation.operationId === 'integrationGetOperation' ? 'operation_id' : 'binding_id',
    );
    assert.ok(
      ownerOperation.definition.parameters.some(parameter =>
        parameter.name === 'X-Cyrene-Workspace-Id' && parameter.in === 'header' && parameter.required === false),
      `${operation.operationId} must document the Workspace header alternative`,
    );
  }
});

test('catalog request schema pointers target the operation request body path', () => {
  for (const operation of Object.values(EXCHANGE_ISSUE_CONSUMER_OPERATIONS)) {
    const ownerOperation = ownerContract.operations[operation.operationId];
    assert.ok(ownerOperation, `owner fixture omitted ${operation.operationId}`);
    if (!ownerOperation.definition.requestBody) {
      assert.equal(ownerOperation.catalog.requestSchemaPointer, null);
      continue;
    }

    const escapedPath = operation.path
      .replaceAll('~', '~0')
      .replaceAll('/', '~1');
    const expectedPointer = `#/paths/${escapedPath}/${operation.method.toLowerCase()}`
      + '/requestBody/content/application~1json/schema';
    assert.equal(
      ownerOperation.catalog.requestSchemaPointer,
      expectedPointer,
      `${operation.operationId} catalog request schema pointer must resolve from its path operation`,
    );
  }
});

test('issue request DTOs match the owner schemas and preserve read/write idempotency boundaries', () => {
  const schemas = ownerContract.schemas;
  const requestSchema = operationId => {
    const operation = ownerContract.operations[operationId];
    const reference = operation.definition.requestBody.content['application/json'].schema.$ref;
    const name = reference.split('/').at(-1);
    assert.ok(name && schemas[name], `${operationId} request schema is missing from the source fixture`);
    return schemas[name];
  };
  const hasIdempotencyHeader = operationId => ownerContract.operations[operationId]
    .definition.parameters.some(parameter => parameter.name === 'Idempotency-Key' && parameter.required === true);

  const query = requestSchema('integrationQueryIssue');
  assert.deepEqual(query.required, ['issueNumber']);
  assert.deepEqual(Object.keys(query.properties).sort(), ['issueNumber']);
  assert.equal(query.properties.issueNumber.minimum, 1);
  assert.equal(query.additionalProperties, false);

  const snapshot = requestSchema('integrationGetIssue');
  assert.deepEqual(snapshot.required, ['issueNumber']);
  assert.deepEqual(Object.keys(snapshot.properties).sort(), ['issueNumber']);
  assert.equal(hasIdempotencyHeader('integrationGetIssue'), false);

  const comment = requestSchema('integrationCreateIssueComment');
  assert.deepEqual(comment.required, ['issueNumber', 'body']);
  assert.deepEqual(Object.keys(comment.properties).sort(), ['body', 'issueNumber']);
  assert.equal(comment.properties.body.minLength, 1);
  assert.equal(comment.properties.body.maxLength, 4_000);
  assert.equal(comment.additionalProperties, false);

  const state = requestSchema('integrationUpdateIssueState');
  assert.deepEqual(state.required, ['issueNumber', 'state']);
  assert.deepEqual(state.properties.state.enum, [...EXCHANGE_ISSUE_STATES]);
  assert.equal(state.additionalProperties, false);
  for (const operationId of [
    'integrationQueryIssue', 'integrationCreateIssueComment', 'integrationUpdateIssueState',
  ]) {
    assert.equal(hasIdempotencyHeader(operationId), true);
    assert.equal(ownerContract.operations[operationId].catalog.idempotency.required, true);
  }
  assert.equal(ownerContract.operations.integrationGetIssue.catalog.idempotency.required, false);
  assert.equal(ownerContract.operations.integrationGetOperation.catalog.idempotency.required, false);
});

test('query 202 Location and cached issue/operation response fields match owner schemas', () => {
  const schemas = ownerContract.schemas;
  const responseSchema = (operationId, status) => {
    const response = ownerContract.operations[operationId].definition.responses[String(status)];
    const name = response.content['application/json'].schema.$ref.split('/').at(-1);
    assert.ok(name && schemas[name], `${operationId} response schema is missing`);
    return { response, schema: schemas[name] };
  };

  for (const operationId of [
    'integrationQueryIssue', 'integrationCreateIssueComment', 'integrationUpdateIssueState',
  ]) {
    const response = ownerContract.operations[operationId].definition.responses['202'];
    assert.ok(response.headers?.Location, `${operationId} 202 must publish its operation Location`);
    assert.equal(response.headers.Location.schema.format, 'uri-reference');
  }

  const query = responseSchema('integrationQueryIssue', 202);
  assert.deepEqual(query.schema.required, [
    'operationId', 'action', 'state', 'issueNumber', 'createdAt', 'updatedAt', 'result',
  ]);
  assert.deepEqual(query.schema.properties.state.enum, [...EXCHANGE_ISSUE_OPERATION_STATES]);
  assert.equal(query.schema.properties.result.anyOf.some(branch => branch.type === 'null'), true);
  assert.equal(query.schema.additionalProperties, false);

  const operation = responseSchema('integrationGetOperation', 200).schema;
  assert.deepEqual(operation.required, query.schema.required);
  assert.deepEqual(operation.properties.state.enum, [...EXCHANGE_ISSUE_OPERATION_STATES]);

  const issue = responseSchema('integrationGetIssue', 200).schema;
  assert.deepEqual(issue.required, [
    'issueNumber', 'state', 'title', 'version', 'freshness', 'observedAt',
  ]);
  assert.deepEqual(issue.properties.state.enum, [...EXCHANGE_ISSUE_STATES]);
  assert.deepEqual(issue.properties.freshness.enum, [...EXCHANGE_ISSUE_SNAPSHOT_FRESHNESS]);
  assert.equal(issue.additionalProperties, false);
});

test('owner merge SHA is populated before delivery', () => {
  assert.match(lock.ownerCommitSha, /^[0-9a-f]{40}$/u);
});
