// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator DSH conversation scheduler tests                  │
// │ Role: Verify durable Schedule idempotency, debounce and marker parse.│
// │ 模块职责：验证持久 Schedule 幂等、防抖重排和消息标记解析。            │
// └─────────────────────────────────────────────────────────────────────┘

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Storage from '@deepseek-ai/dsh-storage';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import * as StorageJson from '@deepseek-ai/dsh-storage-json';
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import ScheduleService from '@deepseek-ai/dsh-schedule';
import {
  conversationScheduleMarker,
  createConversationDshScheduler,
  parseConversationScheduleMarkerV1,
  renderConversationScheduleMarkerV1,
} from '../dist/features/conversation-schedule.js';

function fakeSchedule() {
  const calls = { create: [], delete: [] };
  let next = 0;
  const records = [];
  const service = {
    async catalog() { return [...records]; },
    async create(sessionId, input, signal) {
      signal?.throwIfAborted();
      calls.create.push({ sessionId: String(sessionId), input });
      const record = {
        id: `schedule-${++next}`,
        kind: 'at',
        title: input.title,
        prompt: input.prompt,
        scheduledAt: input.at,
        sessionId: String(sessionId),
        status: 'active',
      };
      records.push(record);
      return record;
    },
    async delete(request, signal) {
      signal?.throwIfAborted();
      calls.delete.push({ sessionId: String(request.sessionId), id: String(request.id) });
      const index = records.findIndex(record => record.id === request.id);
      if (index < 0) return { id: request.id, deleted: false, code: 'schedule_not_found' };
      records.splice(index, 1);
      return { id: request.id, deleted: true };
    },
  };
  return { service, calls, records };
}

test('schedule markers accept only the versioned identifier payload', () => {
  const marker = conversationScheduleMarker('maintenance', 'job-domain-17');
  const prompt = renderConversationScheduleMarkerV1(marker);
  assert.deepEqual(parseConversationScheduleMarkerV1(prompt), marker);
  assert.equal(parseConversationScheduleMarkerV1('remind me to do something'), undefined);
  assert.equal(parseConversationScheduleMarkerV1(`${prompt} extra`), undefined);
  assert.equal(parseConversationScheduleMarkerV1('[CYRENE_CONVERSATION_SCHEDULE_V1]\n{"version":1,"kind":"watch","resourceId":"x","text":"private"}'), undefined);
  assert.throws(() => conversationScheduleMarker('followup', 'bad\nresource'), /invalid/u);
});

test('ensureOneShot is durable and idempotent for the same marker and target', async () => {
  const { service, calls } = fakeSchedule();
  const scheduler = createConversationDshScheduler({
    service,
    schedulerSessionId: 'navigator-shared-scheduler-v1',
    now: () => 1_800_000_000_000,
  });
  const marker = conversationScheduleMarker('watch', 'watch-1');
  const dueAt = 1_800_000_060_000;

  const first = await scheduler.ensureOneShot(marker, dueAt);
  const second = await scheduler.ensureOneShot(marker, dueAt);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].sessionId, 'navigator-shared-scheduler-v1');
  assert.equal(calls.create[0].input.at, new Date(dueAt).toISOString());
  assert.equal(calls.create[0].input.prompt, renderConversationScheduleMarkerV1(marker));
  assert.equal(calls.create[0].input.prompt.includes('watch-1'), true);
});

test('rescheduling replaces only the matching DSH entry and cancellation removes it', async () => {
  const { service, calls, records } = fakeSchedule();
  const scheduler = createConversationDshScheduler({
    service,
    schedulerSessionId: 'scheduler-v1',
    now: () => 1_800_000_000_000,
  });
  const marker = conversationScheduleMarker('followup', 'conversation-1');
  await scheduler.ensureOneShot(marker, 1_800_000_060_000);
  const rescheduled = await scheduler.ensureOneShot(marker, 1_800_000_120_000);
  assert.equal(rescheduled.created, true);
  assert.equal(calls.create.length, 2);
  assert.equal(calls.delete.length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].scheduledAt, new Date(1_800_000_120_000).toISOString());
  assert.equal(await scheduler.cancel(marker), 1);
  assert.equal(records.length, 0);
  assert.equal(await scheduler.cancel(marker), 0);
});

test('failed or uncertain reschedule creation leaves the existing active reminder recoverable', async () => {
  const { service, calls, records } = fakeSchedule();
  const scheduler = createConversationDshScheduler({
    service,
    schedulerSessionId: 'scheduler-v1',
    now: () => 1_800_000_000_000,
  });
  const marker = conversationScheduleMarker('followup', 'conversation-recoverable');
  await scheduler.ensureOneShot(marker, 1_800_000_060_000);
  const originalId = records[0].id;
  const create = service.create.bind(service);
  service.create = async () => { throw new Error('write failed before commit'); };

  await assert.rejects(scheduler.ensureOneShot(marker, 1_800_000_120_000), /write failed/u);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, originalId);
  assert.equal(records[0].status, 'active');
  assert.equal(calls.delete.length, 0, 'the old reminder is not removed before a verified replacement exists');

  let loseResponseOnce = true;
  service.create = async (...args) => {
    const record = await create(...args);
    if (loseResponseOnce) {
      loseResponseOnce = false;
      throw new Error('response lost after commit');
    }
    return record;
  };
  const reconciled = await scheduler.ensureOneShot(marker, 1_800_000_120_000);
  assert.equal(reconciled.active, true);
  assert.equal(records.length, 1);
  assert.equal(records[0].id === originalId, false);
  assert.equal(records[0].scheduledAt, new Date(1_800_000_120_000).toISOString());
});

test('inactive DSH receipts stay deduplicated unless recovery explicitly rearms them', async () => {
  const { service, calls, records } = fakeSchedule();
  const marker = conversationScheduleMarker('maintenance', 'job-1');
  const prompt = renderConversationScheduleMarkerV1(marker);
  records.push({
    id: 'schedule-old', kind: 'at', title: 'Cyrene maintenance old', prompt,
    scheduledAt: '2027-01-15T08:00:00.000Z', sessionId: 'scheduler-v1', status: 'inactive',
  });
  const scheduler = createConversationDshScheduler({
    service,
    schedulerSessionId: 'scheduler-v1',
    now: () => 1_800_000_000_000,
  });
  const inactive = await scheduler.ensureOneShot(marker, 1_800_000_060_000);
  assert.equal(inactive.active, false);
  assert.equal(calls.create.length, 0);
  const rearmed = await scheduler.ensureOneShot(marker, 1_800_000_060_000, { rearmInactive: true });
  assert.equal(rearmed.created, true);
  assert.equal(calls.create.length, 1);
});

test('schedule create observes cancellation and rejects past targets before DSH writes', async () => {
  const { service, calls } = fakeSchedule();
  const scheduler = createConversationDshScheduler({ service, schedulerSessionId: 'scheduler-v1', now: () => 100_000 });
  const marker = conversationScheduleMarker('watch', 'watch-cancel');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scheduler.ensureOneShot(marker, 200_000, { signal: controller.signal }), error => error.name === 'AbortError');
  await assert.rejects(scheduler.ensureOneShot(marker, 99_999), /future epoch millisecond/u);
  assert.equal(calls.create.length, 0);
});

test('conversation triggers persist in the exact DSH Schedule service and shared scheduler Session', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navigator-conversation-schedule-'));
  const context = new Context();
  try {
    await context.plugin(Storage);
    await context.plugin(StorageJson, { root: join(directory, 'dsh-storage') });
    await context.plugin(StorageDomain, { backend: 'json' });
    await context.plugin(LlmRuntime);
    await context.plugin(SessionStore);
    await context.plugin(SessionProjectionRegistry);
    await context.plugin(SystemPrompt);
    await context.plugin(ToolRuntime);
    await context.plugin(AgentRegistry);
    await context.plugin(SessionPersistenceJsonl, { root: join(directory, 'session-logs'), compression: 'none' });
    await context.plugin(AgentLoop, { agents: [] });
    context.provide('sessionController', {
      async resolveAgent() { return { error: new Error('The integration does not create a delivered session. ') }; },
    });
    const scheduleFiber = await context.plugin(ScheduleService);
    const scheduleService = context.get('schedule') ?? scheduleFiber.ctx.get('schedule');
    assert.ok(scheduleService, 'the pinned DSH Schedule service is mounted');

    const scheduler = createConversationDshScheduler({
      service: scheduleService,
      schedulerSessionId: 'navigator-shared-scheduler-v1',
    });
    const marker = conversationScheduleMarker('maintenance', 'maintenance-job-real-dsh');
    const created = await scheduler.ensureOneShot(marker, Date.now() + 60 * 60_000);
    const persisted = (await scheduleService.catalog()).find(entry => entry.id === created.record.id);

    assert.ok(persisted);
    assert.equal(String(persisted.sessionId), scheduler.schedulerSessionId);
    assert.equal(persisted.prompt, renderConversationScheduleMarkerV1(marker));
    assert.deepEqual(parseConversationScheduleMarkerV1(persisted.prompt), marker);

    const replay = await scheduler.ensureOneShot(marker, Date.parse(persisted.scheduledAt));
    assert.equal(replay.record.id, created.record.id);
    assert.equal(replay.created, false);
  } finally {
    await context.fiber.dispose().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
