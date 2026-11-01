// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Conversation ResearchRead HTTP adapter                      │
// │ Role: Bind current Work lineage and authorized attachments to P6.   │
// │ 模块职责：将当前Work来源lineage和授权附件绑定到P6研究任务。           │
// └─────────────────────────────────────────────────────────────────────┘

import {
  ConversationRuntimeWorkClient,
  type ConversationRuntimeReadResult,
  type ConversationSourceRef,
  type RuntimeWorkContext,
  type WorkAttachmentRef,
} from './work-client.ts';

const MAX_AUTHORIZED_ATTACHMENTS = 8;

/** Minimal current ResearchRead port; feature owns the canonical interface. */
export interface ResearchReadInputV1 {
  readonly context: RuntimeWorkContext;
  readonly childTask: { readonly taskId: string; readonly sessionId: string };
  readonly scope: {
    readonly workspaceId: string;
    readonly actorId: string;
    readonly conversationId: string;
    readonly conversationKind: RuntimeWorkContext['conversationKind'];
    readonly personaId: string | null;
  };
  readonly query: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly signal: AbortSignal;
}

export interface ResearchOperationReceiptReaderV1 {
  readonly apiVersion: 1;
  read(context: RuntimeWorkContext, operationId: string): ReturnType<ConversationRuntimeWorkClient['readResearchOperationReceipt']>;
}

export interface ResearchWatchInputV1 {
  readonly context: RuntimeWorkContext;
  readonly childTask: { readonly taskId: string; readonly sessionId: string };
  readonly scope: ResearchReadInputV1['scope'];
  readonly watchId: string;
  readonly condition: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly previousResult: { readonly resultSha256: string; readonly operationId: string } | null;
  readonly signal: AbortSignal;
}

export interface ResearchWatchResultV1 extends ConversationRuntimeReadResult {
  readonly changed: boolean;
  readonly nextCheckAt: number;
}

/** Concrete provider used by `research-work.v1`; credentials stay in the host. */
export class ConversationResearchReadProviderV1 {
  readonly apiVersion = 1 as const;

  constructor(private readonly work: ConversationRuntimeWorkClient) {}

  async read(input: ResearchReadInputV1): Promise<ConversationRuntimeReadResult> {
    const { context } = input;
    context.signal.throwIfAborted();
    input.signal.throwIfAborted();
    if (input.scope.workspaceId !== context.workspaceId
      || input.scope.actorId !== context.actorId
      || input.scope.conversationId !== context.conversationId
      || input.scope.conversationKind !== context.conversationKind
      || input.scope.personaId !== context.personaId
      || input.childTask.taskId === context.taskId
      || input.childTask.sessionId !== context.sessionId) {
      throw new TypeError('Research child Task does not match the trusted conversation scope');
    }
    const signal = AbortSignal.any([context.signal, input.signal]);
    const scopedContext: RuntimeWorkContext = { ...context, signal };
    const sourceRefs = input.sourceRefs;
    await this.work.authorizeSources(scopedContext, sourceRefs);
    const messages = await this.work.listConversationMessages(scopedContext, sourceRefs);
    const attachments = new Map<string, WorkAttachmentRef>();
    for (const message of messages) {
      signal.throwIfAborted();
      for (const attachment of message.attachments) {
        if (!attachments.has(attachment.artifactId)) attachments.set(attachment.artifactId, attachment);
      }
    }
    if (attachments.size > MAX_AUTHORIZED_ATTACHMENTS) {
      throw new TypeError('Current source lineage contains too many document attachments');
    }
    const authorizedIds: string[] = [];
    for (const attachment of attachments.values()) {
      signal.throwIfAborted();
      await this.work.authorizeConversationArtifact(scopedContext, sourceRefs, attachment);
      authorizedIds.push(attachment.artifactId);
    }
    signal.throwIfAborted();
    return this.work.readResearch(scopedContext, {
      childTaskId: input.childTask.taskId,
      parentTaskId: context.taskId,
      parentSessionId: context.sessionId,
      sourceRefs,
      query: input.query,
      attachmentIds: authorizedIds,
    });
  }
}

/** Concrete receipt reader that projects only server-verified Work evidence. */
export class ConversationResearchOperationReceiptReaderV1 implements ResearchOperationReceiptReaderV1 {
  readonly apiVersion = 1 as const;

  constructor(private readonly work: ConversationRuntimeWorkClient) {}

  read(context: RuntimeWorkContext, operationId: string) {
    context.signal.throwIfAborted();
    return this.work.readResearchOperationReceipt(context, operationId);
  }
}

/** Watch adapter bases change only on independently stored Work result digests. */
export class ConversationResearchWatchProviderV1 {
  readonly apiVersion = 1 as const;

  constructor(
    private readonly work: ConversationRuntimeWorkClient,
    private readonly intervalMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 7 * 24 * 60 * 60_000) {
      throw new TypeError('Research watch interval is outside its supported bound');
    }
  }

  async observe(input: ResearchWatchInputV1): Promise<ResearchWatchResultV1> {
    const result = await new ConversationResearchReadProviderV1(this.work).read({
      context: input.context,
      childTask: input.childTask,
      scope: input.scope,
      query: input.condition,
      sourceRefs: input.sourceRefs,
      signal: input.signal,
    });
    const changed = input.previousResult === null
      || input.previousResult.resultSha256 !== result.resultSha256;
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Research watch clock is invalid');
    return { ...result, changed, nextCheckAt: now + this.intervalMs };
  }
}
