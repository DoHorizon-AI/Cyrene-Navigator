// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Public Web skill probe producer                             │
// │ Role: Run one fixed action and independent exact-source readback.   │
// │ 模块职责：执行固定公网读取动作，并在独立Task中回读相同来源。          │
// └─────────────────────────────────────────────────────────────────────┘

import { canonicalJson, sha256 } from '../connector-authorization.ts';
import type { Agent } from '@deepseek-ai/dsh-agent';
import {
  ConversationRuntimeWorkClient,
  WorkRuntimeHttpError,
  type ConversationResearchOperationReceipt,
  type ConversationSourceRef,
  type RuntimeWorkContext,
} from './work-client.ts';
import { ConversationResearchReadProviderV1 } from './research-provider.ts';

const ACTION_ID = 'public-web.lookup';
const MAX_QUERY_CHARS = 2_000;
const MAX_GUIDE_CHARS = 12_000;

export interface SkillEvidenceTaskPortV1 {
  runFeatureTask(
    owner: { readonly workspaceId: string; readonly actorId: string },
    input: {
      readonly taskId: string;
      readonly sessionId: string;
      readonly prompt: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    },
    execute: (agent: Agent, signal: AbortSignal) => Promise<string>,
    signal: AbortSignal,
  ): Promise<{ readonly taskId: string; readonly sessionId: string; readonly status: string; readonly output: string }>;
}

export interface SkillEvidenceInputV1 {
  readonly actionId: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly actionInput: Readonly<Record<string, unknown>>;
  readonly guideVersion: string;
  readonly guideText: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly signal: AbortSignal;
}

interface SkillProbeObservation {
  readonly sourceRef: string;
  readonly url: string;
  readonly sourceSha256: string;
  readonly workArtifactSha256: string;
}

interface SkillProbeTaskOutput {
  readonly version: 1;
  readonly phase: 'verify' | 'readback';
  readonly actionId: string;
  readonly targetDigestSha256: string;
  readonly inputSha256: string;
  readonly guideVersion: string;
  readonly guideSha256: string;
  readonly sourceRef: string;
  readonly canonicalUrl: string;
  readonly sourceSha256: string;
  readonly workArtifactSha256: string;
  readonly artifactId: string;
  readonly contentSha256: string;
  readonly sourceEvidence: ConversationResearchOperationReceipt['sourceEvidence'];
}

/** Server-side producer used only by the fixed `public-web.lookup` action catalog. */
export class ConversationSkillEvidenceProducerV1 {
  readonly apiVersion = 1 as const;

  constructor(
    private readonly work: ConversationRuntimeWorkClient,
    private readonly tasks: SkillEvidenceTaskPortV1,
    private readonly research = new ConversationResearchReadProviderV1(work),
  ) {}

  async execute(
    context: RuntimeWorkContext,
    input: SkillEvidenceInputV1,
  ): Promise<{ readonly writeOperationId: string; readonly readbackOperationId: string }> {
    const normalized = normalizeSkillProbe(input);
    const signal = AbortSignal.any([context.signal, input.signal]);
    signal.throwIfAborted();
    const sourceRefs = validateLineage(input.sourceRefs);
    const sourceRefsSha256 = sha256(canonicalJson(sourceRefs));
    const targetDigestSha256 = sha256(canonicalJson(normalized.target));
    const inputSha256 = sha256(canonicalJson(normalized.actionInput));
    const guideSha256 = sha256(normalized.guideText);
    await this.work.authorizeSources({ ...context, signal }, sourceRefs);

    const actionTaskId = skillTaskId(context, 'verify', targetDigestSha256, inputSha256, guideSha256, sourceRefsSha256);
    const actionTask = { taskId: actionTaskId, sessionId: context.sessionId };
    const actionMetadata = skillTaskMetadata(context, {
      source: 'conversation-skill-verify',
      parentTaskId: context.taskId,
      parentSessionId: context.sessionId,
      sourceRefs,
      actionId: ACTION_ID,
      targetDigestSha256,
      inputSha256,
      guideVersion: input.guideVersion,
      guideSha256,
    });
    const actionOutcome = await this.tasks.runFeatureTask(
      { workspaceId: context.workspaceId, actorId: context.actorId },
      {
        taskId: actionTaskId,
        sessionId: context.sessionId,
        prompt: 'Run the fixed public-web lookup probe with the approved query. Do not perform writes or send a message.',
        metadata: actionMetadata,
      },
      async (agent, taskSignal) => {
        void agent;
        const taskContext = { ...context, signal: AbortSignal.any([signal, taskSignal]) };
        const result = await this.research.read({
          context: taskContext,
          childTask: actionTask,
          scope: scopeOf(context),
          query: normalized.actionInput.query,
          sourceRefs,
          signal: taskContext.signal,
        });
        const observed = selectWebEvidence(result.sourceEvidence);
        const artifact = await this.work.readWorkJsonArtifact(
          taskContext,
          result.artifactId,
          result.resultSha256,
          taskContext.signal,
        );
        if (artifact.content !== result.content
          || artifact.contentSha256 !== result.contentSha256
          || canonicalJson(artifact.sourceEvidence) !== canonicalJson(result.sourceEvidence)) {
          throw new WorkRuntimeHttpError(409, 'SKILL_ACTION_ARTIFACT_READBACK_MISMATCH');
        }
        return taskOutput({
          version: 1,
          phase: 'verify',
          actionId: ACTION_ID,
          targetDigestSha256,
          inputSha256,
          guideVersion: input.guideVersion,
          guideSha256,
          sourceEvidence: result.sourceEvidence,
          sourceRef: observed.sourceRef,
          canonicalUrl: observed.url,
          sourceSha256: observed.sourceSha256,
          workArtifactSha256: result.resultSha256,
          artifactId: result.artifactId,
          contentSha256: result.contentSha256,
        });
      },
      signal,
    );
    assertCompletedTask(actionOutcome, actionTask);
    const actionOutput = decodeSkillTaskOutput(actionOutcome.output, 'verify');
    assertTaskOutput(actionOutput, {
      actionId: ACTION_ID,
      targetDigestSha256,
      inputSha256,
      guideVersion: input.guideVersion,
      guideSha256,
    });
    const observed = selectWebEvidence(actionOutput.sourceEvidence);
    if (actionOutput.sourceRef !== observed.sourceRef
      || actionOutput.canonicalUrl !== observed.url
      || actionOutput.sourceSha256 !== observed.sourceSha256
      || actionOutput.artifactId !== actionOutput.workArtifactSha256) {
      throw new WorkRuntimeHttpError(409, 'SKILL_ACTION_TASK_OUTPUT_INVALID');
    }
    await verifyArtifact(this.work, context, actionOutput);
    const actionEffect = await this.work.finalizeResearchOperationReceipt(context, actionTask, sourceRefs);
    const verifiedActionReceipt = await this.work.readResearchOperationReceipt(context, actionEffect.operationId);
    assertResearchEffect(verifiedActionReceipt, actionTaskId, actionOutput, sourceRefsSha256);

    const readbackTaskId = skillTaskId(
      context,
      'readback',
      targetDigestSha256,
      inputSha256,
      guideSha256,
      sourceRefsSha256,
      actionTaskId,
    );
    const readbackTask = { taskId: readbackTaskId, sessionId: context.sessionId };
    const readbackContext: RuntimeWorkContext = { ...context, taskId: actionTaskId, signal };
    const readbackMetadata = skillTaskMetadata(readbackContext, {
      source: 'conversation-skill-readback',
      parentTaskId: actionTaskId,
      parentSessionId: context.sessionId,
      sourceRefs,
      actionTaskId,
      actionId: ACTION_ID,
      targetDigestSha256,
      inputSha256,
      guideVersion: input.guideVersion,
      guideSha256,
      sourceRef: observed.sourceRef,
      canonicalUrl: observed.url,
      sourceSha256: observed.sourceSha256,
      workArtifactSha256: observed.workArtifactSha256,
    });
    const readbackOutcome = await this.tasks.runFeatureTask(
      { workspaceId: context.workspaceId, actorId: context.actorId },
      {
        taskId: readbackTaskId,
        sessionId: context.sessionId,
        prompt: 'Independently reopen the exact public URL selected by the completed probe and verify the source snapshot. Do not read the guide as proof.',
        metadata: readbackMetadata,
      },
      async (_agent, taskSignal) => {
        const taskContext = { ...context, signal: AbortSignal.any([signal, taskSignal]) };
        taskContext.signal.throwIfAborted();
        await this.work.authorizeSources(taskContext, sourceRefs);
        const result = await this.work.readResearch(taskContext, {
          childTaskId: readbackTaskId,
          parentTaskId: actionTaskId,
          parentSessionId: context.sessionId,
          sourceRefs,
          query: `Verify public source ${observed.url}`,
          attachmentIds: [],
          sourceUrls: [observed.url],
        });
        const current = selectWebEvidence(result.sourceEvidence);
        if (current.sourceRef !== observed.sourceRef || current.url !== observed.url
          || current.sourceSha256 !== observed.sourceSha256) {
          throw new WorkRuntimeHttpError(409, 'SKILL_EFFECT_READBACK_MISMATCH');
        }
        const artifact = await this.work.readWorkJsonArtifact(
          taskContext,
          result.artifactId,
          result.resultSha256,
          taskContext.signal,
        );
        if (artifact.content !== result.content
          || artifact.contentSha256 !== result.contentSha256
          || canonicalJson(artifact.sourceEvidence) !== canonicalJson(result.sourceEvidence)) {
          throw new WorkRuntimeHttpError(409, 'SKILL_READBACK_ARTIFACT_MISMATCH');
        }
        return taskOutput({
          version: 1,
          phase: 'readback',
          actionId: ACTION_ID,
          targetDigestSha256,
          inputSha256,
          guideVersion: input.guideVersion,
          guideSha256,
          sourceEvidence: result.sourceEvidence,
          sourceRef: current.sourceRef,
          canonicalUrl: current.url,
          sourceSha256: current.sourceSha256,
          workArtifactSha256: result.resultSha256,
          artifactId: result.artifactId,
          contentSha256: result.contentSha256,
        });
      },
      signal,
    );
    assertCompletedTask(readbackOutcome, readbackTask);
    const readbackOutput = decodeSkillTaskOutput(readbackOutcome.output, 'readback');
    assertTaskOutput(readbackOutput, {
      actionId: ACTION_ID,
      targetDigestSha256,
      inputSha256,
      guideVersion: input.guideVersion,
      guideSha256,
    });
    const readbackObservation = selectWebEvidence(readbackOutput.sourceEvidence);
    if (readbackOutput.sourceRef !== observed.sourceRef
      || readbackOutput.canonicalUrl !== observed.url
      || readbackOutput.sourceSha256 !== observed.sourceSha256
      || readbackOutput.artifactId !== readbackOutput.workArtifactSha256
      || readbackObservation.sourceRef !== observed.sourceRef
      || readbackObservation.url !== observed.url
      || readbackObservation.sourceSha256 !== observed.sourceSha256) {
      throw new WorkRuntimeHttpError(409, 'SKILL_READBACK_TASK_OUTPUT_INVALID');
    }
    await verifyArtifact(this.work, readbackContext, readbackOutput);
    const readbackEffect = await this.work.finalizeResearchOperationReceipt(
      readbackContext,
      readbackTask,
      sourceRefs,
    );
    const verifiedReadbackReceipt = await this.work.readResearchOperationReceipt(
      readbackContext,
      readbackEffect.operationId,
    );
    assertResearchEffect(verifiedReadbackReceipt, readbackTaskId, readbackOutput, sourceRefsSha256);

    await this.work.authorizeSources({ ...context, signal }, sourceRefs);
    return this.work.finalizeSkillOperationReceipts(context, {
      actionTaskId,
      readbackTaskId,
      actionEffectOperationId: actionEffect.operationId,
      readbackEffectOperationId: readbackEffect.operationId,
      parentTaskId: context.taskId,
      parentSessionId: context.sessionId,
      sourceRefs,
    });
  }
}

function scopeOf(context: RuntimeWorkContext) {
  return {
    workspaceId: context.workspaceId,
    actorId: context.actorId,
    conversationId: context.conversationId,
    conversationKind: context.conversationKind,
    personaId: context.personaId,
  };
}

function skillTaskMetadata(
  context: RuntimeWorkContext,
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    source: metadata.source,
    workspaceId: context.workspaceId,
    actorId: context.actorId,
    conversationId: context.conversationId,
    conversationKind: context.conversationKind,
    personaId: context.personaId,
    parentTaskId: metadata.parentTaskId,
    parentSessionId: metadata.parentSessionId,
    sourceRefs: metadata.sourceRefs,
    ...Object.fromEntries(Object.entries(metadata).filter(([key]) => ![
      'source', 'parentTaskId', 'parentSessionId', 'sourceRefs',
    ].includes(key))),
  };
}

function skillTaskId(
  context: RuntimeWorkContext,
  phase: 'verify' | 'readback',
  targetDigestSha256: string,
  inputSha256: string,
  guideSha256: string,
  sourceRefsSha256: string,
  actionTaskId?: string,
): string {
  const resource = [
    context.workspaceId,
    context.actorId,
    'skill',
    phase,
    context.taskId,
    context.sessionId,
    targetDigestSha256,
    inputSha256,
    guideSha256,
    sourceRefsSha256,
    actionTaskId ?? '',
  ].join(':');
  return `conversation-research-${sha256(`research\0${resource}`).slice(0, 40)}`;
}

function normalizeSkillProbe(input: SkillEvidenceInputV1): {
  readonly actionInput: { readonly query: string };
  readonly guideText: string;
  readonly target: { readonly querySha256: string };
} {
  if (input.actionId !== ACTION_ID) throw new WorkRuntimeHttpError(422, 'SKILL_ACTION_NOT_AUTHORIZED');
  const guideVersion = boundedText(input.guideVersion, 'skill guide version', 128);
  if (!guideVersion) throw new WorkRuntimeHttpError(422, 'SKILL_GUIDE_VERSION_INVALID');
  if (typeof input.guideText !== 'string' || !input.guideText.trim() || input.guideText.length > MAX_GUIDE_CHARS) {
    throw new WorkRuntimeHttpError(422, 'SKILL_GUIDE_INVALID');
  }
  const target = exactObject(input.target, ['querySha256'], 'skill target');
  const querySha256 = checkedDigest(target.querySha256, 'skill query target digest');
  const actionInputValue = exactObject(input.actionInput, ['query'], 'skill action input');
  const query = boundedText(actionInputValue.query, 'skill lookup query', MAX_QUERY_CHARS);
  if (sha256(query) !== querySha256) throw new WorkRuntimeHttpError(403, 'SKILL_TARGET_INPUT_MISMATCH');
  return { actionInput: { query }, guideText: input.guideText, target: { querySha256 } };
}

function selectWebEvidence(values: ConversationResearchOperationReceipt['sourceEvidence']): SkillProbeObservation {
  const source = values.find(item => item.kind === 'web' && item.url !== undefined);
  if (source === undefined || source.url === undefined) throw new WorkRuntimeHttpError(422, 'SKILL_PUBLIC_SOURCE_REQUIRED');
  const url = new URL(source.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href !== source.url) {
    throw new WorkRuntimeHttpError(422, 'SKILL_SOURCE_URL_INVALID');
  }
  return {
    sourceRef: checkedSourceRef(source.sourceRef),
    url: source.url,
    sourceSha256: checkedDigest(source.sourceSha256, 'skill source snapshot digest'),
    workArtifactSha256: '',
  };
}

function assertCompletedTask(
  task: { readonly taskId: string; readonly sessionId: string; readonly status: string; readonly output: string },
  expected: { readonly taskId: string; readonly sessionId: string },
): void {
  if (task.taskId !== expected.taskId || task.sessionId !== expected.sessionId
    || task.status !== 'completed' || typeof task.output !== 'string') {
    throw new WorkRuntimeHttpError(409, 'SKILL_TASK_NOT_COMPLETED');
  }
}

function assertTaskOutput(
  output: SkillProbeTaskOutput,
  expected: Pick<SkillProbeTaskOutput, 'actionId' | 'targetDigestSha256' | 'inputSha256' | 'guideVersion' | 'guideSha256'>,
): void {
  if (output.actionId !== expected.actionId || output.targetDigestSha256 !== expected.targetDigestSha256
    || output.inputSha256 !== expected.inputSha256 || output.guideVersion !== expected.guideVersion
    || output.guideSha256 !== expected.guideSha256) {
    throw new WorkRuntimeHttpError(409, 'SKILL_TASK_OUTPUT_INVALID');
  }
}

async function verifyArtifact(
  work: ConversationRuntimeWorkClient,
  context: RuntimeWorkContext,
  output: SkillProbeTaskOutput,
): Promise<void> {
  const artifact = await work.readWorkJsonArtifact(context, output.artifactId, output.workArtifactSha256, context.signal);
  if (artifact.contentSha256 !== output.contentSha256
    || canonicalJson(artifact.sourceEvidence) !== canonicalJson(output.sourceEvidence)) {
    throw new WorkRuntimeHttpError(409, 'SKILL_TASK_ARTIFACT_READBACK_MISMATCH');
  }
  const observed = selectWebEvidence(artifact.sourceEvidence);
  if (observed.sourceRef !== output.sourceRef || observed.url !== output.canonicalUrl
    || observed.sourceSha256 !== output.sourceSha256) {
    throw new WorkRuntimeHttpError(409, 'SKILL_TASK_SOURCE_EVIDENCE_MISMATCH');
  }
}

function assertResearchEffect(
  receipt: ConversationResearchOperationReceipt,
  taskId: string,
  output: SkillProbeTaskOutput,
  sourceRefsSha256: string,
): void {
  if (receipt.taskId !== taskId || receipt.taskStatus !== 'completed'
    || receipt.trustedProducer !== 'conversation-research-runtime'
    || receipt.status !== 'verified' || receipt.effect !== 'read'
    || receipt.resultSha256 !== output.workArtifactSha256
    || receipt.sourceEvidence.length !== output.sourceEvidence.length
    || sha256(canonicalJson(receipt.sourceRefs)) !== sourceRefsSha256
    || canonicalJson(receipt.sourceEvidence) !== canonicalJson(output.sourceEvidence)) {
    throw new WorkRuntimeHttpError(409, 'SKILL_EFFECT_OPERATION_INVALID');
  }
}

function exactObject(value: Readonly<Record<string, unknown>>, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new WorkRuntimeHttpError(422, `${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  }
  return value as Record<string, unknown>;
}

function taskOutput(value: Readonly<Record<string, unknown>>): string {
  const output = canonicalJson(value);
  if (Buffer.byteLength(output, 'utf8') > 32_000) throw new WorkRuntimeHttpError(413, 'SKILL_TASK_OUTPUT_TOO_LARGE');
  return output;
}

function decodeSkillTaskOutput(value: string, phase: 'verify' | 'readback'): SkillProbeTaskOutput {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new WorkRuntimeHttpError(409, 'SKILL_TASK_OUTPUT_INVALID');
  }
  const row = exactObject(decoded as Record<string, unknown>, [
    'version', 'phase', 'actionId', 'targetDigestSha256', 'inputSha256', 'guideVersion',
    'guideSha256', 'sourceEvidence', 'sourceRef', 'canonicalUrl', 'sourceSha256',
    'workArtifactSha256', 'artifactId', 'contentSha256',
  ], 'skill task output');
  if (row.version !== 1 || row.phase !== phase || typeof row.actionId !== 'string'
    || typeof row.sourceRef !== 'string' || typeof row.canonicalUrl !== 'string'
    || typeof row.sourceSha256 !== 'string' || typeof row.artifactId !== 'string'
    || typeof row.contentSha256 !== 'string' || !Array.isArray(row.sourceEvidence)) {
    throw new WorkRuntimeHttpError(409, 'SKILL_TASK_OUTPUT_INVALID');
  }
  const sourceEvidence = row.sourceEvidence.map(value => {
    const item = exactObject(value as Record<string, unknown>, [
      'sourceRef', 'kind', 'title', 'url', 'sourceSha256', 'retrievedAt',
    ], 'skill source evidence');
    if (item.kind !== 'web' || typeof item.sourceRef !== 'string' || typeof item.title !== 'string'
      || typeof item.url !== 'string' || typeof item.sourceSha256 !== 'string'
      || typeof item.retrievedAt !== 'string') {
      throw new WorkRuntimeHttpError(409, 'SKILL_SOURCE_EVIDENCE_INVALID');
    }
    return {
      sourceRef: checkedSourceRef(item.sourceRef),
      kind: 'web' as const,
      title: boundedText(item.title, 'skill source title', 512),
      url: boundedText(item.url, 'skill source URL', 4_096),
      sourceSha256: checkedDigest(item.sourceSha256, 'skill source snapshot digest'),
      retrievedAt: boundedText(item.retrievedAt, 'skill source retrieval time', 64),
    };
  });
  if (typeof row.guideVersion !== 'string') throw new WorkRuntimeHttpError(409, 'SKILL_TASK_OUTPUT_INVALID');
  return {
    version: 1,
    phase,
    actionId: boundedText(row.actionId, 'skill action ID', 128),
    targetDigestSha256: checkedDigest(row.targetDigestSha256, 'skill target digest'),
    inputSha256: checkedDigest(row.inputSha256, 'skill input digest'),
    guideVersion: boundedText(row.guideVersion, 'skill guide version', 128),
    guideSha256: checkedDigest(row.guideSha256, 'skill guide digest'),
    sourceEvidence,
    sourceRef: checkedSourceRef(row.sourceRef),
    canonicalUrl: boundedText(row.canonicalUrl, 'skill canonical URL', 4_096),
    sourceSha256: checkedDigest(row.sourceSha256, 'skill source snapshot digest'),
    workArtifactSha256: checkedDigest(row.workArtifactSha256, 'skill Work artifact digest'),
    artifactId: checkedDigest(row.artifactId, 'skill artifact ID'),
    contentSha256: checkedDigest(row.contentSha256, 'skill content digest'),
  };
}

function validateLineage(values: readonly ConversationSourceRef[]): readonly ConversationSourceRef[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 256) {
    throw new WorkRuntimeHttpError(422, 'SKILL_SOURCE_REQUIRED');
  }
  return values;
}

function checkedDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new WorkRuntimeHttpError(502, `${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  }
  return value;
}

function checkedSourceRef(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new WorkRuntimeHttpError(502, 'SKILL_SOURCE_REF_INVALID');
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WorkRuntimeHttpError(422, `${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  }
  return value;
}
