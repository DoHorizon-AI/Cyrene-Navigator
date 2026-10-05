// Verify host-owned approval identity, human decisions, and cooperative cancellation.
// 中文：验证宿主审批身份、人工决策以及协作取消。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WorkAssistantBridge } from '../dist/work-tools.js';

test('approval uses the active host task and only continues after a human decision', async () => {
  const requests = [];
  let status = 'pending';
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, method: request.method, token: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.method === 'POST'
      ? { approval: { id: 'approval-1', status: 'pending' } }
      : { id: 'approval-1', status }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const old = process.env.WORK_TOOL_TEST_TOKEN;
  process.env.WORK_TOOL_TEST_TOKEN = 'private-test-token';
  try {
    const bridge = new WorkAssistantBridge({
      baseUrl: `http://127.0.0.1:${server.address().port}`, workspaceId: 'owner',
      tokenEnv: 'WORK_TOOL_TEST_TOKEN', taskIdForSession: id => id === 's1' ? 't1' : undefined,
    });
    await assert.rejects(bridge.requestApproval('unknown', 'write', 'Change approved resource', {}, new AbortController().signal), /active durable/);
    assert.equal(requests.length, 0);
    let continued = false;
    const pending = bridge.requestApproval('s1', 'write', 'Change approved resource', { target: 'fixture' }, new AbortController().signal, 'call-1')
      .then(value => { continued = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(continued, false);
    status = 'approved';
    assert.equal((await pending).status, 'approved');
    assert.equal(requests[0].url, '/api/v1/workspaces/owner/work/tasks/t1/approvals');
    assert.equal(requests[0].token, 'Bearer private-test-token');
    assert.deepEqual(JSON.parse(requests[0].body), { kind: 'write', summary: 'Change approved resource', details: { target: 'fixture' }, messageId: 'call-1' });
    assert.ok(requests.slice(1).every(request => request.method === 'GET'));
  } finally {
    if (old === undefined) delete process.env.WORK_TOOL_TEST_TOKEN;
    else process.env.WORK_TOOL_TEST_TOKEN = old;
    await new Promise(resolve => server.close(resolve));
  }
});

test('waiting approval observes cancellation and rejected decisions', async () => {
  let status = 'rejected';
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ approval: { id: 'a1', status } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const old = process.env.WORK_TOOL_TEST_TOKEN;
  process.env.WORK_TOOL_TEST_TOKEN = 'private-test-token';
  try {
    const bridge = new WorkAssistantBridge({
      baseUrl: `http://127.0.0.1:${server.address().port}`, workspaceId: 'owner',
      tokenEnv: 'WORK_TOOL_TEST_TOKEN', taskIdForSession: () => 't1',
    });
    await assert.rejects(bridge.requestApproval('s1', 'write', 'Write once', {}, new AbortController().signal), /rejected/);
    status = 'pending';
    const controller = new AbortController();
    const pending = bridge.requestApproval('s1', 'write', 'Write once', {}, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, error => error.name === 'AbortError');
  } finally {
    if (old === undefined) delete process.env.WORK_TOOL_TEST_TOKEN;
    else process.env.WORK_TOOL_TEST_TOKEN = old;
    await new Promise(resolve => server.close(resolve));
  }
});

test('human input pauses the tool and closed tasks cannot enqueue model mutations', async () => {
  const requests = [];
  let inputStatus = 'pending';
  let taskStatus = 'failed';
  let deniedSession;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, method: request.method, body });
    response.setHeader('content-type', 'application/json');
    const input = { id: 'input-1', status: inputStatus, ...(inputStatus === 'answered' ? { answer: 'Use the test workspace' } : {}) };
    response.end(JSON.stringify(request.url.endsWith('/tasks/t1')
      ? { id: 't1', status: taskStatus }
      : { input }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const old = process.env.WORK_TOOL_TEST_TOKEN;
  process.env.WORK_TOOL_TEST_TOKEN = 'private-test-token';
  try {
    const bridge = new WorkAssistantBridge({
      baseUrl: `http://127.0.0.1:${server.address().port}`, workspaceId: 'owner',
      tokenEnv: 'WORK_TOOL_TEST_TOKEN', taskIdForSession: () => 't1',
      onTaskDenied: id => { deniedSession = id; },
    });
    let answered = false;
    const pending = bridge.requestInput('s1', 'Which workspace?', {}, new AbortController().signal, 'input-call')
      .then(value => { answered = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(answered, false);
    inputStatus = 'answered';
    assert.equal((await pending).answer, 'Use the test workspace');
    assert.equal(requests[0].path, '/api/v1/workspaces/owner/work/tasks/t1/inputs');
    const execution = { agent: { session: { id: 's1' } }, signal: new AbortController().signal };
    await assert.rejects(bridge.mutate(execution, '/notifications', 'POST', { payload: {} }, true), /paused or closed/u);
    assert.equal(deniedSession, 's1');
    assert.equal(requests.filter(row => row.path.endsWith('/notifications')).length, 0);
    taskStatus = 'running';
    await bridge.mutate(execution, '/notifications', 'POST', { payload: {} }, true);
    assert.deepEqual(JSON.parse(requests.at(-1).body), { payload: {}, taskId: 't1' });
  } finally {
    if (old === undefined) delete process.env.WORK_TOOL_TEST_TOKEN;
    else process.env.WORK_TOOL_TEST_TOKEN = old;
    await new Promise(resolve => server.close(resolve));
  }
});
