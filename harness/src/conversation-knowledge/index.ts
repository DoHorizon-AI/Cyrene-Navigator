// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 index.ts                                                         │
// │  Module: harness/conversation-knowledge                              │
// │  Role: Public surface for the Catalyst knowledge bridge.             │
// │                                                                      │
// │  模块职责：导出知识检索 bridge、上下文贡献与类型。                    │
// └─────────────────────────────────────────────────────────────────────┘

export {
  ConversationKnowledgeBridgeError,
  NavigatorConversationKnowledgeHttpBridge,
  knowledgeContextContribution,
} from './bridge.ts';
export type {
  ConversationKnowledgeBridge,
  KnowledgeAuthorizationReceipt,
  KnowledgeCitation,
  KnowledgeHit,
  KnowledgeSearchPage,
} from './bridge.ts';
