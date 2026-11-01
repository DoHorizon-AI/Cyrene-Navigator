// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Bilibili conversation Work adapters                         │
// │ Role: Resolve owned connections and call canonical Work domain APIs. │
// │ 模块职责：解析当前actor账户并调用标准Work领域API。                    │
// └─────────────────────────────────────────────────────────────────────┘

import { canonicalJson, sha256 } from '../connector-authorization.ts';
import {
  ConversationRuntimeWorkClient,
  WorkRuntimeHttpError,
  type BiliOperationLookupV1,
  type ConversationSourceRef,
  type RuntimeWorkContext,
  type WorkOperationRecord,
  validateSourceRefs,
} from './work-client.ts';

export const BILIBILI_OPERATION_IDS = [
  'bilibili.search',
  'bilibili.user.find',
  'bilibili.video.read',
  'bilibili.comments.list',
  'bilibili.dynamics.list',
  'bilibili.dynamic.read',
  'bilibili.dm.list',
  'bilibili.dm.read',
  'bilibili.comment.create',
  'bilibili.dynamic.publish',
  'bilibili.dm.send',
] as const;

export type BiliOperationId = typeof BILIBILI_OPERATION_IDS[number];
export type BiliReadOperationId = Exclude<BiliOperationId,
  'bilibili.comment.create' | 'bilibili.dynamic.publish' | 'bilibili.dm.send'>;
const BILIBILI_WRITE_OPERATION_IDS = new Set<BiliOperationId>([
  'bilibili.comment.create', 'bilibili.dynamic.publish', 'bilibili.dm.send',
]);

export interface BiliTargetScopeV1 {
  readonly operationId: BiliOperationId;
  readonly target: Readonly<Record<string, string>>;
  readonly resourceRef: string;
  readonly argumentsDigestSha256: string;
}

export interface BiliOwnedConnectionV1 {
  readonly workspaceId: string;
  readonly ownerActorId: string;
  readonly connectionRef: string;
  readonly profileRef: string;
  readonly provider: 'bilibili';
  readonly enabled: boolean;
  readonly externalSubject: string | null;
}

export interface BiliDelegationV1 {
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerActorId: string;
  readonly granteeActorId: string;
  readonly connectionRef: string;
  readonly profileRef: string;
  readonly operationIds: readonly BiliOperationId[];
  readonly targetScopes: readonly BiliTargetScopeV1[];
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly state: 'active' | 'revoked' | 'expired';
  readonly version: number;
}

export interface BiliDelegationAuthorizationV1 {
  readonly delegationId: string;
  readonly workspaceId: string;
  readonly ownerActorId: string;
  readonly granteeActorId: string;
  readonly connectionRef: string;
  readonly profileRef: string;
  readonly operationId: BiliOperationId;
  readonly resourceRef: string;
  readonly argumentsDigestSha256: string;
  readonly delegationVersion: number;
  readonly directoryEpoch?: number;
  readonly validUntil: number;
  readonly proofRef: string;
  readonly proofDigest: string;
}

export interface BiliSubscriptionV1 {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly workspaceId: string;
  readonly ownerActorId: string;
  readonly conversationId: string;
  readonly conversationKind: BiliConversationKind;
  readonly personaId: string | null;
  readonly delegationId: string;
  readonly connectionRef: string;
  readonly profileRef: string;
  readonly ownerTaskId: string;
  readonly ownerSessionId: string;
  readonly operationId: BiliReadOperationId;
  readonly argumentsDigestSha256: string;
  readonly resourceRef: string;
  readonly arguments: Readonly<Record<string, string | number>>;
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly expiresAt: number;
  readonly nextCheckAt: number | null;
  readonly scheduledRunKey: string | null;
  readonly scheduledExpectedVersion: number;
  readonly scheduledRunState: 'scheduled' | 'claimed' | 'completed';
  readonly cursor: string | null;
  readonly lastOutputSha256: string | null;
  readonly lastOperationReceiptId: string | null;
  readonly lastNotificationReceiptId: string | null;
  readonly lastNotificationReadbackReceiptId: string | null;
  readonly lastNotificationOutcome: 'queued' | 'accepted' | 'delivered' | 'held' | 'uncertain' | null;
  readonly lastDeliveryReceiptId: string | null;
  readonly notificationSendAllowed: boolean;
  readonly state: 'active' | 'paused' | 'cancelled' | 'expired' | 'revoked' | 'uncertain';
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type BiliNotificationAuthorizationV1 =
  | {
      readonly allowed: true;
      readonly reason: null;
      readonly subscriptionId: string;
      readonly version: number;
      readonly runKey: string;
      readonly notificationIdempotencyKey: string;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly subscriptionId: string;
      readonly version: number;
      readonly runKey?: string;
      readonly notificationId?: string;
    };

export interface BiliSubscriptionRunPlanV1 {
  readonly taskId: string;
  readonly operationIdempotencyKey: string;
  readonly sourceMetadata: Readonly<Record<string, string | number | null>>;
  readonly runtimePlanDigest: string;
}

export type BiliConversationKind = 'direct' | 'group' | 'channel';

export interface BiliOperationInvocationV1 {
  readonly delegation: BiliDelegationAuthorizationV1;
  readonly connection: BiliOwnedConnectionV1;
  readonly operationId: BiliOperationId;
  readonly target: Readonly<Record<string, string>>;
  readonly resourceRef: string;
  readonly arguments: Readonly<Record<string, string | number>>;
  readonly argumentsDigestSha256: string;
  readonly sourceRefs: readonly ConversationSourceRef[];
  readonly subscriptionId?: string;
  readonly expectedVersion?: number;
  readonly scheduledRunKey?: string;
  readonly runtimePlanDigest?: string;
  readonly idempotencyKey?: string;
  readonly signal: AbortSignal;
}

export interface BiliWorkOperationReceiptV1 {
  readonly id: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly connectionRef: string;
  readonly profileRef: string;
  readonly operationId: BiliOperationId;
  readonly resourceRef: string;
  readonly argumentsDigestSha256: string;
  readonly outcome: 'verified' | 'pending' | 'uncertain' | 'failed';
  readonly taskStatus: 'completed' | 'failed' | 'aborted' | 'running' | 'queued';
  readonly taskId: string;
  readonly taskOutputSha256: string | null;
  readonly outputSha256: string | null;
  readonly externalReadbackVerified: boolean;
  readonly workOperationId: string;
  readonly createdAt: number;
}

export interface BiliOperationOutcomeV1 {
  readonly receipt: BiliWorkOperationReceiptV1;
  readonly result?: Readonly<Record<string, unknown>>;
}

/** Reads only the current actor's exact Work connection and Account Center profile. */
export class ConversationBilibiliConnectionDirectoryV1 {
  constructor(private readonly work: ConversationRuntimeWorkClient) {}

  async getOwnedConnectionByProfile(
    context: RuntimeWorkContext,
    profileRef: string,
  ): Promise<BiliOwnedConnectionV1 | undefined> {
    const profile = boundedId(profileRef, 'Bilibili profile reference');
    const connections = await this.connections(context);
    const matches = connections.filter(item => item.profileRef === profile);
    if (matches.length > 1) throw new WorkRuntimeHttpError(409, 'BILIBILI_PROFILE_CONNECTION_AMBIGUOUS');
    if (matches.length === 0) return undefined;
    const accounts = await this.accounts(context);
    const account = accounts.find(item => item.profileRef === profile);
    if (account === undefined) throw new WorkRuntimeHttpError(404, 'BILIBILI_PROFILE_NOT_OWNED');
    return toOwnedConnection(context, matches[0]!, account);
  }

  async getOwnedConnection(
    context: RuntimeWorkContext,
    connectionRef: string,
  ): Promise<BiliOwnedConnectionV1 | undefined> {
    const id = boundedId(connectionRef, 'Bilibili connection reference');
    const connections = await this.connections(context);
    const matches = connections.filter(item => item.connectionRef === id);
    if (matches.length > 1) throw new WorkRuntimeHttpError(502, 'BILIBILI_CONNECTION_DUPLICATE');
    if (matches.length === 0) return undefined;
    const accounts = await this.accounts(context);
    const account = accounts.find(item => item.profileRef === matches[0]!.profileRef);
    if (account === undefined) throw new WorkRuntimeHttpError(404, 'BILIBILI_PROFILE_NOT_OWNED');
    return toOwnedConnection(context, matches[0]!, account);
  }

  private async connections(context: RuntimeWorkContext): Promise<readonly SafeBiliConnection[]> {
    const rows = await this.work.listBilibiliConnections(context);
    const values = rows.map(decodeConnection);
    if (values.some(value => value.provider !== 'bilibili')) throw new WorkRuntimeHttpError(502, 'BILIBILI_CONNECTION_RESPONSE_INVALID');
    return values;
  }

  private async accounts(context: RuntimeWorkContext): Promise<readonly SafeBiliAccount[]> {
    const rows = await this.work.listBilibiliAccounts(context);
    const values = rows.map(decodeAccount);
    if (values.some(value => value.provider !== 'bilibili')) throw new WorkRuntimeHttpError(502, 'BILIBILI_ACCOUNT_RESPONSE_INVALID');
    return values;
  }
}

/** Concrete HTTP facade for Work's durable Bilibili delegation/subscription domain. */
export class ConversationBilibiliDomainWorkPortV1 {
  constructor(private readonly work: ConversationRuntimeWorkClient) {}

  delegationPort() {
    return {
      apiVersion: 1 as const,
      create: this.createDelegation.bind(this),
      get: this.getDelegation.bind(this),
      list: this.listDelegations.bind(this),
      authorize: this.authorizeDelegation.bind(this),
      revoke: this.revokeDelegation.bind(this),
    };
  }

  subscriptionPort() {
    return {
      apiVersion: 1 as const,
      create: this.createSubscription.bind(this),
      get: this.getSubscription.bind(this),
      claim: this.claimSubscriptionCheck.bind(this),
      list: this.listSubscriptions.bind(this),
      recordCheck: this.recordSubscriptionCheck.bind(this),
      transition: this.transitionSubscription.bind(this),
      authorizeNotification: this.authorizeSubscriptionNotification.bind(this),
    };
  }

  async createDelegation(context: RuntimeWorkContext, input: {
    readonly granteeActorId: string;
    readonly connectionRef: string;
    readonly profileRef: string;
    readonly operationIds: readonly BiliOperationId[];
    readonly targetScopes: readonly BiliTargetScopeV1[];
    readonly expiresAt: number;
  }): Promise<{ readonly delegation: BiliDelegationV1; readonly duplicate: boolean }> {
    if (input.granteeActorId !== context.actorId) {
      throw new WorkRuntimeHttpError(403, 'BILI_DELEGATION_GRANTEE_MISMATCH');
    }
    const sourceRefs = await this.work.resolveCurrentTurnSourceRefs(context);
    await this.work.authorizeSources(context, sourceRefs);
    const scopes = input.targetScopes.map(scope => {
      const operation = operationId(scope.operationId);
      const target = decodeBiliTarget(operation, scope.target);
      if (scope.resourceRef !== biliResourceRef(input.profileRef, operation, target)) {
        throw new WorkRuntimeHttpError(403, 'BILI_RESOURCE_SCOPE_MISMATCH');
      }
      return { ...scope, operationId: operation, target };
    });
    const scopedOperations = [...new Set(scopes.map(scope => scope.operationId))].sort();
    const declaredOperations = [...new Set(input.operationIds.map(operationId))].sort();
    if (scopedOperations.length !== declaredOperations.length
      || scopedOperations.some((item, index) => item !== declaredOperations[index])) {
      throw new WorkRuntimeHttpError(422, 'BILI_DELEGATION_OPERATION_SCOPE_MISMATCH');
    }
    const stableKey = `bili-delegation-${sha256(canonicalJson({
      taskId: context.taskId,
      actorId: context.actorId,
      workspaceId: context.workspaceId,
      granteeActorId: input.granteeActorId,
      connectionRef: input.connectionRef,
      profileRef: input.profileRef,
      operationIds: input.operationIds,
      targetScopes: scopes,
      expiresAt: input.expiresAt,
    })).slice(0, 40)}`;
    const value = object(await this.work.callBiliDomain(context, 'delegations.create', {
      body: {
        idempotencyKey: stableKey,
        connectionRef: input.connectionRef,
        profileRef: input.profileRef,
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        personaId: context.personaId,
        expiresAt: safeInteger(input.expiresAt, 'delegation expiry'),
        grants: scopes.map(scope => ({
          operationId: scope.operationId,
          target: scope.target,
          argumentsDigestSha256: scope.argumentsDigestSha256,
        })),
        sourceRefs,
      },
    }, context.signal), 'Bilibili delegation receipt');
    const delegation = decodeDelegation(value.delegation);
    assertDelegationContext(delegation, context);
    return { delegation, duplicate: value.duplicate === true };
  }

  async getDelegation(context: RuntimeWorkContext, delegationId: string): Promise<{ readonly delegation: BiliDelegationV1 }> {
    const value = object(await this.work.callBiliDomain(context, 'delegations.get', {
      id: boundedId(delegationId, 'delegation ID'),
    }, context.signal), 'Bilibili delegation readback');
    const delegation = decodeDelegation(value.delegation);
    assertDelegationContext(delegation, context);
    return { delegation };
  }

  async listDelegations(context: RuntimeWorkContext, input: { readonly cursor?: string; readonly limit: number }): Promise<{
    readonly items: readonly BiliDelegationV1[];
    readonly nextCursor: string | null;
  }> {
    const query = { limit: boundedInteger(input.limit, 1, 500, 'delegation page limit'), cursor: input.cursor };
    const value = object(await this.work.callBiliDomain(context, 'delegations.list', {
      query,
    }, context.signal), 'Bilibili delegation page');
    if (!Array.isArray(value.items) || value.items.length > query.limit) throw new WorkRuntimeHttpError(502, 'BILI_DELEGATION_PAGE_INVALID');
    const items = value.items.map(decodeDelegation);
    items.forEach(item => assertDelegationContext(item, context));
    return { items, nextCursor: nullableCursor(value.nextCursor) };
  }

  async authorizeDelegation(context: RuntimeWorkContext, input: {
    readonly delegationId: string;
    readonly granteeActorId: string;
    readonly connectionRef: string;
    readonly profileRef: string;
    readonly operationId: BiliOperationId;
    readonly target: Readonly<Record<string, string>>;
    readonly resourceRef: string;
    readonly arguments: Readonly<Record<string, string | number>>;
    readonly argumentsDigestSha256: string;
    readonly now: number;
  }): Promise<{ readonly authorization: BiliDelegationAuthorizationV1 | null; readonly denialCode?: string }> {
    const target = decodeBiliTarget(input.operationId, input.target);
    if (input.argumentsDigestSha256 !== sha256(canonicalJson(input.arguments))
      || input.resourceRef !== biliResourceRef(input.profileRef, input.operationId, target)
      || canonicalJson(targetFromArguments(input.operationId, input.arguments)) !== canonicalJson(target)) {
      throw new WorkRuntimeHttpError(403, 'BILI_AUTHORIZATION_ARGUMENT_SCOPE_MISMATCH');
    }
    const value = object(await this.work.callBiliDomain(context, 'delegations.authorize', {
      id: boundedId(input.delegationId, 'delegation ID'),
      body: {
        operationId: input.operationId,
        target,
        arguments: input.arguments,
        argumentsDigestSha256: checkedDigest(input.argumentsDigestSha256, 'arguments digest'),
      },
    }, context.signal), 'Bilibili authorization result');
    if (value.allowed !== true) {
      return {
        authorization: null,
        ...(typeof value.reason === 'string' ? { denialCode: value.reason } : {}),
      };
    }
    if (value.requiresFreshProviderProof !== true
      || value.delegationId !== input.delegationId || value.resourceRef !== input.resourceRef) {
      throw new WorkRuntimeHttpError(409, 'BILI_AUTHORIZATION_PROOF_INVALID');
    }
    const grantRef = boundedText(value.freshGrantRef, 'fresh Exchange grant reference', 512);
    const proofDigest = checkedDigest(value.freshProofDigest, 'fresh Exchange proof digest');
    const proofExpiresAt = safeInteger(Number(value.proofExpiresAt), 'fresh Exchange grant expiry');
    return { authorization: {
      delegationId: input.delegationId,
      workspaceId: context.workspaceId,
      ownerActorId: context.actorId,
      granteeActorId: context.actorId,
      connectionRef: input.connectionRef,
      profileRef: input.profileRef,
      operationId: input.operationId,
      resourceRef: input.resourceRef,
      argumentsDigestSha256: input.argumentsDigestSha256,
      delegationVersion: boundedInteger(Number(value.version), 1, Number.MAX_SAFE_INTEGER, 'delegation version'),
      validUntil: proofExpiresAt,
      proofRef: grantRef,
      proofDigest,
    } };
  }

  async revokeDelegation(
    context: RuntimeWorkContext,
    delegationId: string,
    expectedVersion: number,
  ): Promise<{ readonly delegation: BiliDelegationV1 }> {
    const value = object(await this.work.callBiliDomain(context, 'delegations.revoke', {
      id: boundedId(delegationId, 'delegation ID'),
      body: { expectedVersion: boundedInteger(expectedVersion, 1, Number.MAX_SAFE_INTEGER, 'delegation version') },
    }, context.signal), 'Bilibili delegation revoke');
    if (value.state !== 'revoked' || Number(value.version) <= expectedVersion) {
      throw new WorkRuntimeHttpError(409, 'BILI_DELEGATION_REVOKE_READBACK_MISMATCH');
    }
    const delegation = (await this.getDelegation(context, delegationId)).delegation;
    assertDelegationContext(delegation, context);
    return { delegation };
  }

  async createSubscription(context: RuntimeWorkContext, input: {
    readonly idempotencyKey: string;
    readonly conversationId: string;
    readonly conversationKind: BiliConversationKind;
    readonly personaId: string | null;
    readonly delegationId: string;
    readonly connectionRef: string;
    readonly profileRef: string;
    readonly operationId: BiliReadOperationId;
    readonly argumentsDigestSha256: string;
    readonly resourceRef: string;
    readonly arguments: Readonly<Record<string, string | number>>;
    readonly sourceRefs: readonly ConversationSourceRef[];
    readonly expiresAt: number;
    readonly nextCheckAt: number;
  }): Promise<{ readonly subscription: BiliSubscriptionV1; readonly duplicate: boolean }> {
    if (input.conversationId !== context.conversationId
      || input.conversationKind !== context.conversationKind
      || input.personaId !== context.personaId
      || !BILIBILI_OPERATION_IDS.includes(input.operationId)
      || BILIBILI_WRITE_OPERATION_IDS.has(input.operationId)
      || input.argumentsDigestSha256 !== sha256(canonicalJson(input.arguments))
      || input.resourceRef !== biliResourceRef(
        input.profileRef,
        input.operationId,
        targetFromArguments(input.operationId, input.arguments),
      )) {
      throw new WorkRuntimeHttpError(403, 'BILI_SUBSCRIPTION_ARGUMENT_SCOPE_MISMATCH');
    }
    await this.work.authorizeSources(context, input.sourceRefs);
    const value = object(await this.work.callBiliDomain(context, 'subscriptions.create', {
      body: {
        idempotencyKey: boundedText(input.idempotencyKey, 'subscription idempotency key', 200),
        delegationId: input.delegationId,
        connectionRef: input.connectionRef,
        profileRef: input.profileRef,
        operationId: input.operationId,
        resourceRef: checkedResourceRef(input.resourceRef),
        arguments: decodeArguments(input.arguments),
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
        personaId: context.personaId,
        expiresAt: safeInteger(input.expiresAt, 'subscription expiry'),
        nextCheckAt: safeInteger(input.nextCheckAt, 'subscription next check'),
        sourceRefs: validateSourceRefs(input.sourceRefs),
      },
    }, context.signal), 'Bilibili subscription receipt');
    const subscription = decodeSubscription(value.subscription);
    assertSubscriptionContext(subscription, context);
    return { subscription, duplicate: value.duplicate === true };
  }

  async getSubscription(context: RuntimeWorkContext, subscriptionId: string): Promise<{ readonly subscription: BiliSubscriptionV1 }> {
    const value = object(await this.work.callBiliDomain(context, 'subscriptions.get', {
      id: boundedId(subscriptionId, 'subscription ID'),
    }, context.signal), 'Bilibili subscription');
    const subscription = decodeSubscription(value.subscription);
    assertSubscriptionContext(subscription, context);
    return { subscription };
  }

  async listSubscriptions(context: RuntimeWorkContext, input: {
    readonly state?: BiliSubscriptionV1['state'];
    readonly delegationId?: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{ readonly items: readonly BiliSubscriptionV1[]; readonly nextCursor: string | null }> {
    const value = object(await this.work.callBiliDomain(context, 'subscriptions.list', {
      query: {
        state: input.state,
        delegationId: input.delegationId,
        cursor: input.cursor,
        limit: boundedInteger(input.limit, 1, 500, 'subscription page limit'),
      },
    }, context.signal), 'Bilibili subscription page');
    if (!Array.isArray(value.items) || value.items.length > input.limit) throw new WorkRuntimeHttpError(502, 'BILI_SUBSCRIPTION_PAGE_INVALID');
    const items = value.items.map(decodeSubscription);
    items.forEach(item => assertSubscriptionContext(item, context));
    return { items, nextCursor: nullableCursor(value.nextCursor) };
  }

  async recordSubscriptionCheck(context: RuntimeWorkContext, subscriptionId: string, input: {
    readonly expectedVersion: number;
    readonly runKey: string;
    readonly cursor: string | null;
    readonly outcome: 'changed' | 'unchanged' | 'held' | 'uncertain' | 'failed';
    readonly operationReceiptId: string;
    readonly outputSha256: string;
    readonly notificationReceiptId?: string;
    readonly notificationReadbackReceiptId?: string;
    readonly notificationOutcome?: 'queued' | 'accepted' | 'delivered' | 'held' | 'uncertain';
    readonly deliveryReceiptId?: string | null;
    readonly nextCheckAt: number | null;
    readonly state: BiliSubscriptionV1['state'];
  }): Promise<{ readonly subscription: BiliSubscriptionV1 }> {
    const value = object(await this.work.callBiliDomain(context, 'subscriptions.recordCheck', {
      id: boundedId(subscriptionId, 'subscription ID'),
      body: {
        expectedVersion: input.expectedVersion,
        runKey: boundedText(input.runKey, 'subscription run key', 512),
        cursor: input.cursor,
        lastOutputSha256: checkedDigest(input.outputSha256, 'subscription output digest'),
        lastOperationReceiptId: boundedId(input.operationReceiptId, 'Bilibili operation receipt ID'),
        lastNotificationReceiptId: input.notificationReceiptId ?? null,
        lastNotificationReadbackReceiptId: input.notificationReadbackReceiptId ?? null,
        lastNotificationOutcome: input.notificationOutcome ?? null,
        lastDeliveryReceiptId: input.deliveryReceiptId ?? null,
        state: input.state,
        nextCheckAt: input.nextCheckAt,
      },
    }, context.signal), 'Bilibili subscription check');
    const subscription = decodeSubscription(value.subscription);
    assertSubscriptionContext(subscription, context);
    return { subscription };
  }

  async transitionSubscription(context: RuntimeWorkContext, subscriptionId: string, input: {
    readonly expectedVersion: number;
    readonly state: BiliSubscriptionV1['state'];
    readonly nextCheckAt?: number | null;
  }): Promise<{ readonly subscription: BiliSubscriptionV1 }> {
    const value = object(await this.work.callBiliDomain(context, 'subscriptions.transition', {
      id: boundedId(subscriptionId, 'subscription ID'),
      body: { ...input },
    }, context.signal), 'Bilibili subscription transition');
    const subscription = decodeSubscription(value.subscription);
    assertSubscriptionContext(subscription, context);
    return { subscription };
  }

  async claimSubscriptionCheck(
    context: RuntimeWorkContext,
    subscriptionId: string,
    expectedVersion: number,
  ): Promise<{ readonly subscription: BiliSubscriptionV1; readonly runPlan: BiliSubscriptionRunPlanV1 }> {
    const value = object(await this.work.callBiliDomain(context, 'subscriptions.claim', {
      id: boundedId(subscriptionId, 'subscription ID'),
      body: { expectedVersion: boundedInteger(expectedVersion, 1, Number.MAX_SAFE_INTEGER, 'subscription version') },
    }, context.signal), 'Bilibili subscription claim');
    const subscription = decodeSubscription(value.subscription);
    assertSubscriptionContext(subscription, context);
    if (subscription.scheduledRunState !== 'claimed'
      || subscription.scheduledExpectedVersion !== subscription.version
      || subscription.version !== expectedVersion + 1
      || subscription.scheduledRunKey === null) {
      throw new WorkRuntimeHttpError(409, 'BILI_SUBSCRIPTION_CLAIM_READBACK_MISMATCH');
    }
    return { subscription, runPlan: decodeSubscriptionRunPlan(value.runPlan, subscription, context) };
  }

  async authorizeSubscriptionNotification(context: RuntimeWorkContext, subscriptionId: string, input: {
    readonly expectedVersion: number;
    readonly runKey: string;
    readonly sourceOutputSha256: string;
  }): Promise<BiliNotificationAuthorizationV1> {
    const id = boundedId(subscriptionId, 'subscription ID');
    const expectedVersion = boundedInteger(input.expectedVersion, 1, Number.MAX_SAFE_INTEGER, 'subscription version');
    const runKey = boundedText(input.runKey, 'subscription run key', 512);
    const sourceOutputSha256 = checkedDigest(input.sourceOutputSha256, 'subscription source output digest');
    const result = await this.work.callBiliDomain(context, 'subscriptions.authorizeNotification', {
      id,
      body: {
        expectedVersion,
        runKey,
        sourceOutputSha256,
      },
    }, context.signal);
    const row = object(result, 'Bilibili notification authorization');
    if (row.subscriptionId !== id || Number(row.version) !== expectedVersion) {
      throw new WorkRuntimeHttpError(409, 'BILI_NOTIFICATION_AUTHORIZATION_SCOPE_MISMATCH');
    }
    if (row.allowed === true) {
      const key = `bili-notification-${sha256(`${id}\0${sourceOutputSha256}`)}`;
      if (row.reason !== null || row.runKey !== runKey || row.notificationIdempotencyKey !== key
        || row.notificationId !== undefined) {
        throw new WorkRuntimeHttpError(409, 'BILI_NOTIFICATION_AUTHORIZATION_INVALID');
      }
      return {
        allowed: true,
        reason: null,
        subscriptionId: id,
        version: expectedVersion,
        runKey,
        notificationIdempotencyKey: key,
      };
    }
    if (row.allowed !== false || typeof row.reason !== 'string'
      || !['subscription_inactive', 'outbox_reconciliation_required', 'unchanged_result'].includes(row.reason)
      || row.notificationIdempotencyKey !== undefined
      || row.runKey !== undefined && row.runKey !== runKey) {
      throw new WorkRuntimeHttpError(502, 'BILI_NOTIFICATION_AUTHORIZATION_INVALID');
    }
    const notificationId = row.notificationId === undefined
      ? undefined
      : boundedId(row.notificationId, 'notification ID');
    return {
      allowed: false,
      reason: row.reason,
      subscriptionId: id,
      version: expectedVersion,
      ...(row.runKey === undefined ? {} : { runKey }),
      ...(notificationId === undefined ? {} : { notificationId }),
    };
  }
}

/** Concrete Work receipt adapter for the fixed Bilibili connector operations. */
export class ConversationBilibiliOperationWorkPortV1 {
  constructor(private readonly work: ConversationRuntimeWorkClient) {}

  operationPort() {
    return {
      apiVersion: 1 as const,
      findByIdempotencyKey: this.findByIdempotencyKey.bind(this),
      invoke: this.invoke.bind(this),
    };
  }

  async findByIdempotencyKey(
    context: RuntimeWorkContext,
    idempotencyKey: string,
    signal: AbortSignal,
    expectedTaskId = context.taskId,
  ): Promise<BiliOperationOutcomeV1 | undefined> {
    const key = boundedText(idempotencyKey, 'Bilibili operation key', 512);
    const taskId = boundedId(expectedTaskId, 'Bilibili operation Task ID');
    const lookup = await this.work.findBilibiliOperation(context, key, signal, taskId);
    if (lookup === undefined) return undefined;
    return this.project(context, taskId, key, lookup);
  }

  async invoke(
    context: RuntimeWorkContext,
    input: BiliOperationInvocationV1,
  ): Promise<BiliOperationOutcomeV1> {
    const key = boundedText(input.idempotencyKey, 'Bilibili operation key', 512);
    const operation = operationId(input.operationId);
    const target = decodeBiliTarget(operation, input.target);
    const args = decodeArguments(input.arguments);
    const digest = sha256(canonicalJson(args));
    const resourceRef = biliResourceRef(input.connection.profileRef, operation, target);
    if (input.connection.workspaceId !== context.workspaceId
      || input.connection.ownerActorId !== context.actorId
      || input.connection.provider !== 'bilibili'
      || !input.connection.enabled
      || input.delegation.workspaceId !== context.workspaceId
      || input.delegation.ownerActorId !== context.actorId
      || input.delegation.granteeActorId !== context.actorId
      || input.delegation.connectionRef !== input.connection.connectionRef
      || input.delegation.profileRef !== input.connection.profileRef
      || input.delegation.operationId !== operation
      || input.delegation.resourceRef !== resourceRef
      || input.delegation.argumentsDigestSha256 !== digest
      || input.delegation.validUntil <= Date.now()
      || input.argumentsDigestSha256 !== digest
      || input.resourceRef !== resourceRef
      || canonicalJson(targetFromArguments(operation, args)) !== canonicalJson(target)) {
      throw new WorkRuntimeHttpError(403, 'BILI_OPERATION_INVOCATION_SCOPE_MISMATCH');
    }
    const sourceRefs = validateSourceRefs(input.sourceRefs);
    const taskId = boundedId(context.taskId, 'Bilibili operation Task ID');
    let dispatchError: unknown;
    try {
      await this.work.invokeBilibiliOperation(
        context,
        input.connection.connectionRef,
        operation,
        args,
        key,
        signalFor(context.signal, input.signal),
      );
    } catch (error) {
      dispatchError = error;
    }
    const lookup = await this.work.findBilibiliOperation(context, key, signalFor(context.signal, input.signal), taskId);
    if (lookup === undefined) {
      if (dispatchError !== undefined) {
        throw new WorkRuntimeHttpError(503, 'BILI_OPERATION_OUTCOME_UNKNOWN');
      }
      throw new WorkRuntimeHttpError(503, 'BILI_OPERATION_RECEIPT_UNAVAILABLE');
    }
    const outcome = await this.project(context, taskId, key, lookup, {
      connectionRef: input.connection.connectionRef,
      profileRef: input.connection.profileRef,
      operationId: operation,
      target,
      resourceRef,
      arguments: args,
      argumentsDigestSha256: digest,
      sourceRefs,
      delegationId: input.delegation.delegationId,
      delegationVersion: input.delegation.delegationVersion,
      ...(input.subscriptionId === undefined ? {} : { subscriptionId: input.subscriptionId }),
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      ...(input.scheduledRunKey === undefined ? {} : { scheduledRunKey: input.scheduledRunKey }),
      ...(input.runtimePlanDigest === undefined ? {} : { runtimePlanDigest: input.runtimePlanDigest }),
    });
    if (dispatchError !== undefined && outcome.receipt.outcome === 'verified') return outcome;
    if (dispatchError !== undefined && outcome.receipt.outcome === 'pending') {
      throw new WorkRuntimeHttpError(503, 'BILI_OPERATION_OUTCOME_UNKNOWN');
    }
    return outcome;
  }

  private async project(
    context: RuntimeWorkContext,
    taskId: string,
    idempotencyKey: string,
    lookup: BiliOperationLookupV1,
    expected?: {
      readonly connectionRef: string;
      readonly profileRef: string;
      readonly operationId: BiliOperationId;
      readonly target: Readonly<Record<string, string>>;
      readonly resourceRef: string;
      readonly arguments: Readonly<Record<string, string | number>>;
      readonly argumentsDigestSha256: string;
      readonly sourceRefs: readonly ConversationSourceRef[];
      readonly delegationId: string;
      readonly delegationVersion: number;
      readonly subscriptionId?: string;
      readonly expectedVersion?: number;
      readonly scheduledRunKey?: string;
      readonly runtimePlanDigest?: string;
    },
  ): Promise<BiliOperationOutcomeV1> {
    const { operation } = lookup;
    if (operation.idempotencyKey !== idempotencyKey || operation.taskId !== taskId
      || operation.trustedProducer !== 'exchange-connector-dispatch'
      || !/^tool\.provider\.v1:bilibili\.(?:search|user\.find|video\.read|comments\.list|dynamics\.list|dynamic\.read|dm\.list|dm\.read|comment\.create|dynamic\.publish|dm\.send)$/u.test(operation.operationType)) {
      throw new WorkRuntimeHttpError(409, 'BILI_OPERATION_RECEIPT_SCOPE_INVALID');
    }
    const task = await this.work.getWorkTask(context, taskId, context.signal);
    const metadata = task.metadata;
    const request = operation.request;
    const evidence = operation.evidence;
    const selectedOperation = operationId(operation.operationType.slice('tool.provider.v1:'.length));
    const connectionRef = expected?.connectionRef ?? boundedId(metadata.connectionRef, 'Bilibili Task connection');
    const profileRef = expected?.profileRef ?? boundedId(metadata.profileRef, 'Bilibili Task profile');
    const resourceRef = expected?.resourceRef ?? checkedResourceRef(metadata.resourceRef);
    const argumentsDigestSha256 = expected?.argumentsDigestSha256
      ?? checkedDigest(metadata.argumentsDigestSha256 ?? request.argumentsSha256, 'Bilibili arguments digest');
    const isSubscriptionTask = metadata.source === 'conversation-bili-subscription-read';
    const sourceRefsDigest = expected !== undefined
      ? sha256(canonicalJson(expected.sourceRefs))
      : isSubscriptionTask
        ? checkedDigest(metadata.sourceRefsDigest, 'Bilibili source refs digest')
        : sha256(canonicalJson(metadata.sourceRefs ?? []));
    const parentTaskId = boundedId(metadata.parentTaskId ?? metadata.ownerTaskId, 'Bilibili parent Task ID');
    const parentSessionId = boundedId(metadata.parentSessionId ?? metadata.ownerSessionId, 'Bilibili parent session ID');
    const subscription = expected?.subscriptionId !== undefined || isSubscriptionTask;
    const expectedRequestKeys = [
      'source', 'actorScopeSha256', 'connectionRefDigest', 'profileRefDigest', 'operationId',
      'resourceRef', 'argumentsSha256', 'taskId', 'parentTaskId', 'parentSessionId',
      'delegationId', 'delegationVersion', 'sourceRefsSha256',
      ...(subscription ? ['subscriptionId', 'subscriptionVersion', 'expectedVersion', 'runKey', 'runtimePlanDigest'] : []),
    ];
    if (!sameKeys(request, expectedRequestKeys)
      || request.source !== 'conversation-bili-operation'
      || !/^[a-f0-9]{64}$/u.test(String(request.actorScopeSha256))
      || request.connectionRefDigest !== sha256(connectionRef)
      || request.profileRefDigest !== sha256(profileRef)
      || request.operationId !== selectedOperation
      || (expected?.operationId !== undefined && expected.operationId !== selectedOperation)
      || request.resourceRef !== resourceRef
      || request.argumentsSha256 !== argumentsDigestSha256
      || request.taskId !== taskId
      || request.parentTaskId !== parentTaskId
      || request.parentSessionId !== parentSessionId
      || request.delegationId !== metadata.delegationId
      || !Number.isSafeInteger(request.delegationVersion)
      || request.sourceRefsSha256 !== sourceRefsDigest
      || subscription && (request.subscriptionId !== (expected?.subscriptionId ?? metadata.subscriptionId)
        || request.subscriptionVersion !== (expected?.expectedVersion ?? metadata.expectedVersion)
        || request.expectedVersion !== (expected?.expectedVersion ?? metadata.expectedVersion)
        || request.runKey !== (expected?.scheduledRunKey ?? metadata.runKey)
        || request.runtimePlanDigest !== (expected?.runtimePlanDigest ?? metadata.runtimePlanDigest))) {
      throw new WorkRuntimeHttpError(409, 'BILI_OPERATION_REQUEST_SCOPE_MISMATCH');
    }
    const expectedTaskSource = subscription ? 'conversation-bili-subscription-read' : 'conversation-bili-operation';
    if (metadata.source !== expectedTaskSource || metadata.workspaceId !== context.workspaceId
      || metadata.actorId !== context.actorId || task.createdByActorId !== context.actorId
      || task.workspaceId !== context.workspaceId || task.id !== taskId) {
      throw new WorkRuntimeHttpError(403, 'BILI_OPERATION_TASK_PROVENANCE_INVALID');
    }
    if (expected !== undefined) {
      const expectedTarget = decodeBiliTarget(selectedOperation, expected.target);
      if (expected.resourceRef !== biliResourceRef(profileRef, selectedOperation, expectedTarget)
        || expected.argumentsDigestSha256 !== sha256(canonicalJson(expected.arguments))
        || metadata.connectionRef !== connectionRef || metadata.profileRef !== profileRef
        || metadata.operationId !== selectedOperation || metadata.resourceRef !== resourceRef
        || metadata.delegationId !== request.delegationId
        || !subscription && Number(metadata.delegationVersion) !== Number(request.delegationVersion)
        || request.delegationId !== expected.delegationId
        || Number(request.delegationVersion) !== expected.delegationVersion
        || metadata.argumentsDigestSha256 !== argumentsDigestSha256
        || expected.subscriptionId !== undefined && metadata.subscriptionId !== expected.subscriptionId) {
        throw new WorkRuntimeHttpError(409, 'BILI_OPERATION_TASK_SCOPE_MISMATCH');
      }
      if (!subscription && (canonicalJson(metadata.target) !== canonicalJson(expectedTarget)
        || canonicalJson(metadata.arguments) !== canonicalJson(expected.arguments)
        || !Array.isArray(metadata.sourceRefs)
        || canonicalJson(validateSourceRefs(metadata.sourceRefs as ConversationSourceRef[]))
          !== canonicalJson(expected.sourceRefs))) {
        throw new WorkRuntimeHttpError(409, 'BILI_OPERATION_TASK_LINEAGE_MISMATCH');
      }
    }
    if (evidence.providerId !== 'bilibili' || evidence.effect !== (BILIBILI_WRITE_OPERATION_IDS.has(selectedOperation) ? 'write' : 'read')
      || evidence.connectionRef !== connectionRef || evidence.profileRef !== profileRef
      || evidence.operationId !== selectedOperation || evidence.resourceRef !== resourceRef
      || evidence.argumentsSha256 !== argumentsDigestSha256
      || typeof evidence.readbackVerified !== 'boolean'
      || typeof evidence.externalReadbackVerified !== 'boolean') {
      throw new WorkRuntimeHttpError(409, 'BILI_OPERATION_EVIDENCE_SCOPE_MISMATCH');
    }
    const taskStatus = task.status === 'completed' || task.status === 'failed' || task.status === 'aborted'
      ? task.status
      : task.status === 'queued' ? 'queued' : 'running';
    const outcomeValue = evidence.outcome;
    let outcome: BiliWorkOperationReceiptV1['outcome'];
    if (operation.status === 'uncertain' || outcomeValue === 'uncertain') outcome = 'uncertain';
    else if (operation.status === 'verified' && outcomeValue === 'verified' && taskStatus === 'completed') outcome = 'verified';
    else if (outcomeValue === 'failed') outcome = 'failed';
    else outcome = 'pending';
    const taskOutputSha256 = taskStatus === 'completed' ? sha256(task.output) : null;
    if (evidence.taskOutputSha256 !== undefined && evidence.taskOutputSha256 !== null
      && evidence.taskOutputSha256 !== taskOutputSha256) {
      throw new WorkRuntimeHttpError(409, 'BILI_OPERATION_TASK_OUTPUT_MISMATCH');
    }
    const externalReadbackVerified = evidence.externalReadbackVerified;
    const receipt: BiliWorkOperationReceiptV1 = {
      id: operation.id,
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      connectionRef,
      profileRef,
      operationId: selectedOperation,
      resourceRef,
      argumentsDigestSha256,
      outcome,
      taskStatus,
      taskId,
      taskOutputSha256,
      outputSha256: null,
      externalReadbackVerified,
      workOperationId: operation.id,
      createdAt: operation.createdAt,
    };
    if (outcome !== 'verified') return { receipt };
    if (taskStatus !== 'completed' || taskOutputSha256 === null || evidence.readbackVerified !== true) {
      throw new WorkRuntimeHttpError(409, 'BILI_OPERATION_RESULT_NOT_VERIFIED');
    }
    if (BILIBILI_WRITE_OPERATION_IDS.has(selectedOperation) && externalReadbackVerified !== true) {
      throw new WorkRuntimeHttpError(409, 'BILI_WRITE_EXTERNAL_READBACK_REQUIRED');
    }
    const resultDigest = checkedDigest(evidence.resultSha256, 'Bilibili result digest');
    const artifactId = checkedDigest(evidence.resultArtifactId, 'Bilibili result artifact');
    const artifact = lookup.resultArtifact;
    if (artifact === undefined || artifact.artifactId !== artifactId || artifact.sha256 !== resultDigest
      || artifact.mimeType !== 'application/json') {
      throw new WorkRuntimeHttpError(409, 'BILI_OPERATION_RESULT_ARTIFACT_MISMATCH');
    }
    const result = await this.work.readWorkJsonArtifact(context, artifact.artifactId, resultDigest, context.signal);
    if (sha256(canonicalJson(result)) !== resultDigest) {
      throw new WorkRuntimeHttpError(502, 'BILI_OPERATION_RESULT_DIGEST_MISMATCH');
    }
    return { receipt: { ...receipt, outputSha256: resultDigest }, result };
  }
}

interface SafeBiliConnection {
  readonly connectionRef: string;
  readonly profileRef: string;
  readonly provider: string;
  readonly enabled: boolean;
}

interface SafeBiliAccount {
  readonly profileRef: string;
  readonly provider: string;
  readonly externalSubject: string | null;
}

function decodeConnection(value: Record<string, unknown>): SafeBiliConnection {
  return {
    connectionRef: boundedId(value.connectionRef, 'connection reference'),
    profileRef: boundedId(value.profileRef, 'profile reference'),
    provider: boundedText(value.provider, 'connection provider', 64),
    enabled: requiredBoolean(value.enabled, 'connection enabled'),
  };
}

function decodeAccount(value: Record<string, unknown>): SafeBiliAccount {
  const externalSubject = value.externalSubject;
  if (externalSubject !== null && typeof externalSubject !== 'string') throw new WorkRuntimeHttpError(502, 'BILIBILI_ACCOUNT_RESPONSE_INVALID');
  return {
    profileRef: boundedId(value.profileRef, 'profile reference'),
    provider: boundedText(value.provider, 'account provider', 64),
    externalSubject: externalSubject as string | null,
  };
}

function toOwnedConnection(
  context: RuntimeWorkContext,
  connection: SafeBiliConnection,
  account: SafeBiliAccount,
): BiliOwnedConnectionV1 {
  if (connection.profileRef !== account.profileRef || account.provider !== 'bilibili') {
    throw new WorkRuntimeHttpError(409, 'BILIBILI_PROFILE_CONNECTION_MISMATCH');
  }
  return {
    workspaceId: context.workspaceId,
    ownerActorId: context.actorId,
    connectionRef: connection.connectionRef,
    profileRef: connection.profileRef,
    provider: 'bilibili',
    enabled: connection.enabled,
    externalSubject: account.externalSubject,
  };
}

function decodeDelegation(value: unknown): BiliDelegationV1 {
  const row = object(value, 'Bilibili delegation');
  if (!Array.isArray(row.grants) || row.grants.length === 0 || row.grants.length > 256) {
    throw new WorkRuntimeHttpError(502, 'BILI_DELEGATION_RESPONSE_INVALID');
  }
  const targetScopes = row.grants.map(decodeTargetScope);
  const uniqueTargetScopes = new Set(targetScopes.map(scope => `${scope.operationId}\0${scope.resourceRef}`));
  if (uniqueTargetScopes.size !== targetScopes.length) {
    throw new WorkRuntimeHttpError(502, 'BILI_DELEGATION_RESPONSE_INVALID');
  }
  const operationIds = [...new Set(targetScopes.map(scope => scope.operationId))];
  if (operationIds.length === 0) throw new WorkRuntimeHttpError(502, 'BILI_DELEGATION_RESPONSE_INVALID');
  const state = row.state;
  if (state !== 'active' && state !== 'revoked' && state !== 'expired') {
    throw new WorkRuntimeHttpError(502, 'BILI_DELEGATION_RESPONSE_INVALID');
  }
  const updatedAt = safeInteger(Number(row.updatedAt), 'delegation updatedAt');
  return {
    id: boundedId(row.id, 'delegation ID'),
    workspaceId: boundedId(row.workspaceId, 'delegation Workspace'),
    ownerActorId: boundedId(row.ownerActorId, 'delegation owner'),
    granteeActorId: boundedId(row.granteeActorId, 'delegation grantee'),
    connectionRef: boundedId(row.connectionRef, 'delegation connection'),
    profileRef: boundedId(row.profileRef, 'delegation profile'),
    operationIds,
    targetScopes,
    expiresAt: safeInteger(Number(row.expiresAt), 'delegation expiry'),
    revokedAt: state === 'active' ? null : updatedAt,
    state,
    version: boundedInteger(Number(row.version), 1, Number.MAX_SAFE_INTEGER, 'delegation version'),
  };
}

function decodeTargetScope(value: unknown): BiliTargetScopeV1 {
  const row = object(value, 'Bilibili target scope');
  const targetValue = object(row.target, 'Bilibili target');
  const target: Record<string, string> = {};
  for (const [key, entry] of Object.entries(targetValue)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key) || typeof entry !== 'string' || entry.length > 2_048) {
      throw new WorkRuntimeHttpError(502, 'BILI_DELEGATION_TARGET_INVALID');
    }
    target[key] = entry;
  }
  return {
    operationId: operationId(row.operationId),
    target: decodeBiliTarget(operationId(row.operationId), target),
    resourceRef: checkedResourceRef(row.resourceRef),
    argumentsDigestSha256: checkedDigest(row.argumentsDigestSha256, 'arguments digest'),
  };
}

function targetFromArguments(
  operation: BiliOperationId,
  argumentsValue: Readonly<Record<string, string | number>>,
): Readonly<Record<string, string>> {
  const value = (name: string): string => {
    const field = argumentsValue[name];
    if (typeof field !== 'string') throw new WorkRuntimeHttpError(422, 'BILI_ARGUMENTS_INVALID');
    return field;
  };
  switch (operation) {
    case 'bilibili.search': {
      const type = value('search_type');
      if (type !== 'video' && type !== 'user' && type !== 'article') throw new WorkRuntimeHttpError(422, 'BILI_SEARCH_TYPE_INVALID');
      return { search_type: type };
    }
    case 'bilibili.user.find': return { user_id: decimalId(value('user_id')) };
    case 'bilibili.video.read': return { video_id: validVideoId(value('video_id')) };
    case 'bilibili.comments.list': return {
      video_id: validVideoId(value('video_id')),
      ...(argumentsValue.root_comment_id === undefined ? {} : { root_comment_id: decimalId(value('root_comment_id'), true) }),
    };
    case 'bilibili.dynamics.list': return { user_id: decimalId(value('user_id')) };
    case 'bilibili.dynamic.read': return { dynamic_id: decimalId(value('dynamic_id')) };
    case 'bilibili.dm.list': return { peer_user_id: decimalId(value('peer_user_id')) };
    case 'bilibili.dm.read': return {
      peer_user_id: decimalId(value('peer_user_id')),
      message_id: decimalId(value('message_id')),
    };
    case 'bilibili.comment.create': return {
      video_id: validVideoId(value('video_id')),
      root_comment_id: decimalId(value('root_comment_id'), true),
      parent_comment_id: decimalId(value('parent_comment_id'), true),
    };
    case 'bilibili.dynamic.publish': return { user_id: decimalId(value('user_id')) };
    case 'bilibili.dm.send': return { peer_user_id: decimalId(value('peer_user_id')) };
  }
}

function decodeBiliTarget(
  operation: BiliOperationId,
  value: unknown,
): Readonly<Record<string, string>> {
  const target = object(value, 'Bilibili target');
  const expected = targetFromArguments(operation, target as Record<string, string>);
  if (canonicalJson(expected) !== canonicalJson(target)) {
    throw new WorkRuntimeHttpError(422, 'BILI_TARGET_INVALID');
  }
  return expected;
}

function biliResourceRef(
  profileRef: string,
  operationIdValue: BiliOperationId,
  target: Readonly<Record<string, string>>,
): string {
  return `sha256:${sha256(canonicalJson({
    providerId: 'bilibili',
    profileRef: boundedId(profileRef, 'Bilibili profile reference'),
    operationId: operationIdValue,
    target,
  }))}`;
}

function decimalId(value: string, allowZero = false): string {
  if (!/^[0-9]{1,20}$/u.test(value) || (!allowZero && (value === '0' || value.startsWith('0')))) {
    throw new WorkRuntimeHttpError(422, 'BILI_TARGET_ID_INVALID');
  }
  return value;
}

function validVideoId(value: string): string {
  if (!/^(?:BV[0-9A-Za-z]{10}|av[1-9][0-9]{0,19})$/u.test(value)) {
    throw new WorkRuntimeHttpError(422, 'BILI_VIDEO_ID_INVALID');
  }
  return value;
}

function decodeAuthorization(value: unknown): BiliDelegationAuthorizationV1 {
  const row = object(value, 'Bilibili authorization proof');
  const directoryEpoch = row.directoryEpoch === undefined ? undefined : safeInteger(Number(row.directoryEpoch), 'Directory epoch');
  const proofRef = boundedText(row.proofRef, 'grant reference', 512);
  const proofDigest = checkedDigest(row.proofDigest, 'grant proof digest');
  return {
    delegationId: boundedId(row.delegationId, 'delegation ID'),
    workspaceId: boundedId(row.workspaceId, 'authorization Workspace'),
    ownerActorId: boundedId(row.ownerActorId, 'authorization owner'),
    granteeActorId: boundedId(row.granteeActorId, 'authorization grantee'),
    connectionRef: boundedId(row.connectionRef, 'authorization connection'),
    profileRef: boundedId(row.profileRef, 'authorization profile'),
    operationId: operationId(row.operationId),
    resourceRef: checkedResourceRef(row.resourceRef),
    argumentsDigestSha256: checkedDigest(row.argumentsDigestSha256, 'arguments digest'),
    delegationVersion: boundedInteger(Number(row.delegationVersion), 1, Number.MAX_SAFE_INTEGER, 'delegation version'),
    ...(directoryEpoch === undefined ? {} : { directoryEpoch }),
    validUntil: safeInteger(Number(row.validUntil), 'grant expiry'),
    proofRef,
    proofDigest,
  };
}

function decodeSubscription(value: unknown): BiliSubscriptionV1 {
  const row = object(value, 'Bilibili subscription');
  const state = row.state;
  if (!['active', 'paused', 'cancelled', 'expired', 'revoked', 'uncertain'].includes(String(state))) {
    throw new WorkRuntimeHttpError(502, 'BILI_SUBSCRIPTION_RESPONSE_INVALID');
  }
  const notificationOutcome = row.lastNotificationOutcome;
  if (notificationOutcome !== null && !['queued', 'accepted', 'delivered', 'held', 'uncertain'].includes(String(notificationOutcome))) {
    throw new WorkRuntimeHttpError(502, 'BILI_SUBSCRIPTION_RESPONSE_INVALID');
  }
  const scheduledRunState = row.scheduledRunState;
  if (scheduledRunState !== 'scheduled' && scheduledRunState !== 'claimed' && scheduledRunState !== 'completed') {
    throw new WorkRuntimeHttpError(502, 'BILI_SUBSCRIPTION_RESPONSE_INVALID');
  }
  return {
    id: boundedId(row.id, 'subscription ID'),
    idempotencyKey: boundedText(row.idempotencyKey, 'subscription idempotency key', 512),
    workspaceId: boundedId(row.workspaceId, 'subscription Workspace'),
    ownerActorId: boundedId(row.ownerActorId, 'subscription owner'),
    conversationId: boundedId(row.conversationId, 'subscription conversation'),
    conversationKind: conversationKind(row.conversationKind),
    personaId: row.personaId === null ? null : boundedId(row.personaId, 'subscription persona'),
    delegationId: boundedId(row.delegationId, 'subscription delegation'),
    connectionRef: boundedId(row.connectionRef, 'subscription connection'),
    profileRef: boundedId(row.profileRef, 'subscription profile'),
    ownerTaskId: boundedId(row.ownerTaskId, 'subscription owner Task'),
    ownerSessionId: boundedId(row.ownerSessionId, 'subscription owner session'),
    operationId: readOperationId(row.operationId),
    argumentsDigestSha256: checkedDigest(row.argumentsDigestSha256, 'subscription arguments digest'),
    resourceRef: checkedResourceRef(row.resourceRef),
    arguments: decodeArguments(row.arguments),
    sourceRefs: validateSourceRefs(row.sourceRefs as ConversationSourceRef[]),
    expiresAt: safeInteger(Number(row.expiresAt), 'subscription expiry'),
    nextCheckAt: row.nextCheckAt === null ? null : safeInteger(Number(row.nextCheckAt), 'subscription next check'),
    scheduledRunKey: nullableId(row.scheduledRunKey, 'subscription scheduled run key'),
    scheduledExpectedVersion: boundedInteger(Number(row.scheduledExpectedVersion), 1, Number.MAX_SAFE_INTEGER, 'subscription scheduled version'),
    scheduledRunState,
    cursor: nullableCursor(row.cursor),
    lastOutputSha256: nullableDigest(row.lastOutputSha256, 'subscription output digest'),
    lastOperationReceiptId: nullableId(row.lastOperationReceiptId, 'operation receipt ID'),
    lastNotificationReceiptId: nullableId(row.lastNotificationReceiptId, 'notification receipt ID'),
    lastNotificationReadbackReceiptId: nullableId(row.lastNotificationReadbackReceiptId, 'notification readback ID'),
    lastNotificationOutcome: notificationOutcome as BiliSubscriptionV1['lastNotificationOutcome'],
    lastDeliveryReceiptId: nullableId(row.lastDeliveryReceiptId, 'delivery receipt ID'),
    notificationSendAllowed: requiredBoolean(row.notificationSendAllowed, 'notification send allowed'),
    state: state as BiliSubscriptionV1['state'],
    version: boundedInteger(Number(row.version), 1, Number.MAX_SAFE_INTEGER, 'subscription version'),
    createdAt: safeInteger(Number(row.createdAt), 'subscription createdAt'),
    updatedAt: safeInteger(Number(row.updatedAt), 'subscription updatedAt'),
  };
}

function decodeSubscriptionRunPlan(
  value: unknown,
  subscription: BiliSubscriptionV1,
  context: RuntimeWorkContext,
): BiliSubscriptionRunPlanV1 {
  const row = object(value, 'Bilibili subscription run plan');
  if (!sameKeys(row, ['taskId', 'operationIdempotencyKey', 'sourceMetadata', 'runtimePlanDigest'])) {
    throw new WorkRuntimeHttpError(502, 'BILI_SUBSCRIPTION_RUN_PLAN_INVALID');
  }
  const taskId = boundedId(row.taskId, 'subscription check Task ID');
  const operationIdempotencyKey = boundedId(row.operationIdempotencyKey, 'subscription operation key');
  const runtimePlanDigest = checkedDigest(row.runtimePlanDigest, 'runtime plan digest');
  const metadata = object(row.sourceMetadata, 'Bilibili subscription Task metadata');
  const metadataKeys = [
    'source', 'organizationId', 'workspaceId', 'actorId', 'subscriptionId', 'delegationId',
    'connectionRef', 'profileRef', 'operationId', 'resourceRef', 'argumentsDigestSha256',
    'sourceRefsDigest', 'conversationId', 'conversationKind', 'personaId', 'ownerTaskId',
    'ownerSessionId', 'runKey', 'expectedVersion', 'operationIdempotencyKey',
  ];
  if (!sameKeys(metadata, metadataKeys)) throw new WorkRuntimeHttpError(502, 'BILI_SUBSCRIPTION_TASK_METADATA_INVALID');
  const expectedMetadata: Readonly<Record<string, unknown>> = {
    source: 'conversation-bili-subscription-read',
    organizationId: boundedId(metadata.organizationId, 'subscription organization'),
    workspaceId: context.workspaceId,
    actorId: context.actorId,
    subscriptionId: subscription.id,
    delegationId: subscription.delegationId,
    connectionRef: subscription.connectionRef,
    profileRef: subscription.profileRef,
    operationId: subscription.operationId,
    resourceRef: subscription.resourceRef,
    argumentsDigestSha256: subscription.argumentsDigestSha256,
    sourceRefsDigest: sha256(canonicalJson(subscription.sourceRefs)),
    conversationId: context.conversationId,
    conversationKind: context.conversationKind,
    personaId: context.personaId,
    ownerTaskId: subscription.ownerTaskId,
    ownerSessionId: subscription.ownerSessionId,
    runKey: subscription.scheduledRunKey,
    expectedVersion: subscription.scheduledExpectedVersion,
    operationIdempotencyKey,
  };
  if (!sameJson(metadata, expectedMetadata)) {
    throw new WorkRuntimeHttpError(409, 'BILI_SUBSCRIPTION_RUN_PLAN_SCOPE_MISMATCH');
  }
  const planPayload = {
    taskId,
    operationIdempotencyKey,
    sourceMetadata: metadata,
    arguments: subscription.arguments,
    cursor: subscription.cursor,
    sourceRefs: subscription.sourceRefs,
  };
  if (sha256(canonicalJson(planPayload)) !== runtimePlanDigest) {
    throw new WorkRuntimeHttpError(502, 'BILI_SUBSCRIPTION_RUN_PLAN_DIGEST_MISMATCH');
  }
  const sourceMetadata: Record<string, string | number | null> = {};
  for (const [key, field] of Object.entries(metadata)) {
    if (field !== null && typeof field !== 'string' && typeof field !== 'number') {
      throw new WorkRuntimeHttpError(502, 'BILI_SUBSCRIPTION_TASK_METADATA_INVALID');
    }
    if (typeof field === 'number' && !Number.isSafeInteger(field)) {
      throw new WorkRuntimeHttpError(502, 'BILI_SUBSCRIPTION_TASK_METADATA_INVALID');
    }
    sourceMetadata[key] = field as string | number | null;
  }
  return { taskId, operationIdempotencyKey, sourceMetadata, runtimePlanDigest };
}

function assertDelegationContext(value: BiliDelegationV1, context: RuntimeWorkContext): void {
  if (value.workspaceId !== context.workspaceId || value.ownerActorId !== context.actorId
    || value.granteeActorId !== context.actorId) {
    throw new WorkRuntimeHttpError(403, 'BILI_DELEGATION_SCOPE_MISMATCH');
  }
}

function assertSubscriptionContext(value: BiliSubscriptionV1, context: RuntimeWorkContext): void {
  if (value.workspaceId !== context.workspaceId || value.ownerActorId !== context.actorId
    || value.conversationId !== context.conversationId || value.conversationKind !== context.conversationKind
    || value.personaId !== context.personaId) {
    throw new WorkRuntimeHttpError(403, 'BILI_SUBSCRIPTION_SCOPE_MISMATCH');
  }
}

function operationId(value: unknown): BiliOperationId {
  if (typeof value !== 'string' || !(BILIBILI_OPERATION_IDS as readonly string[]).includes(value)) {
    throw new WorkRuntimeHttpError(502, 'BILI_OPERATION_INVALID');
  }
  return value as BiliOperationId;
}

function readOperationId(value: unknown): BiliReadOperationId {
  const selected = operationId(value);
  if (BILIBILI_WRITE_OPERATION_IDS.has(selected)) throw new WorkRuntimeHttpError(502, 'BILI_SUBSCRIPTION_OPERATION_INVALID');
  return selected as BiliReadOperationId;
}

function conversationKind(value: unknown): BiliConversationKind {
  if (value !== 'direct' && value !== 'group' && value !== 'channel') throw new WorkRuntimeHttpError(502, 'BILI_SUBSCRIPTION_SCOPE_INVALID');
  return value;
}

function checkedResourceRef(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new WorkRuntimeHttpError(502, 'BILI_RESOURCE_REF_INVALID');
  return value;
}

function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : checkedDigest(value, label);
}

function nullableId(value: unknown, label: string): string | null {
  return value === null ? null : boundedId(value, label);
}

function nullableCursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) throw new WorkRuntimeHttpError(502, 'BILI_CURSOR_INVALID');
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new WorkRuntimeHttpError(502, `${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label} is invalid`);
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function signalFor(first: AbortSignal, second: AbortSignal): AbortSignal {
  return AbortSignal.any([first, second]);
}

function decodeArguments(value: unknown): Readonly<Record<string, string | number>> {
  const row = object(value, 'Bilibili arguments');
  const result: Record<string, string | number> = {};
  const entries = Object.entries(row);
  if (entries.length === 0 || entries.length > 32) throw new WorkRuntimeHttpError(502, 'BILI_ARGUMENTS_INVALID');
  for (const [key, field] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key)
      || (typeof field !== 'string' && typeof field !== 'number')
      || (typeof field === 'string' && (field.length > 8_192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(field)))
      || (typeof field === 'number' && !Number.isSafeInteger(field))) {
      throw new WorkRuntimeHttpError(502, 'BILI_ARGUMENTS_INVALID');
    }
    result[key] = field;
  }
  return result;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) throw new TypeError(`${label} is invalid`);
  return value.trim();
}

function boundedId(value: unknown, label: string): string {
  return boundedText(value, label, 512);
}

function checkedDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new WorkRuntimeHttpError(502, `${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  return value;
}

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} is invalid`);
  return value;
}
