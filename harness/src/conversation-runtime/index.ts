// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Conversation runtime adapter exports                        │
// │ Role: Public host-composition surface for P6/P7/P9 adapters.         │
// │ 模块职责：导出P6/P7/P9宿主适配器的公开装配接口。                     │
// └─────────────────────────────────────────────────────────────────────┘

export {
  ConversationRuntimeWorkClient,
  WorkRuntimeHttpError,
  validateSourceRefs,
} from './work-client.ts';
export type {
  ConversationKind,
  ConversationMessageRecord,
  ConversationRuntimeReadResult,
  ConversationResearchOperationReceipt,
  ConversationSourceRef,
  ResearchSourceEvidence,
  RuntimeWorkContext,
  RuntimeWorkTaskRecord,
  WorkOperationRecord,
  WorkAttachmentRef,
  WorkCredentialResolver,
} from './work-client.ts';
export { ConversationResearchReadProviderV1 } from './research-provider.ts';
export {
  ConversationResearchOperationReceiptReaderV1,
  ConversationResearchWatchProviderV1,
} from './research-provider.ts';
export type {
  ResearchOperationReceiptReaderV1,
  ResearchReadInputV1,
  ResearchWatchInputV1,
  ResearchWatchResultV1,
} from './research-provider.ts';
export {
  BILIBILI_OPERATION_IDS,
  ConversationBilibiliConnectionDirectoryV1,
  ConversationBilibiliDomainWorkPortV1,
} from './bilibili-adapters.ts';
export type {
  BiliNotificationAuthorizationV1,
  BiliDelegationAuthorizationV1,
  BiliDelegationV1,
  BiliOperationInvocationV1,
  BiliOperationOutcomeV1,
  BiliOperationId,
  BiliOwnedConnectionV1,
  BiliReadOperationId,
  BiliSubscriptionRunPlanV1,
  BiliSubscriptionV1,
  BiliWorkOperationReceiptV1,
  BiliTargetScopeV1,
} from './bilibili-adapters.ts';
export { ConversationBilibiliOperationWorkPortV1 } from './bilibili-adapters.ts';
