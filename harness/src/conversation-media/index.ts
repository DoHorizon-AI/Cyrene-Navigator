// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 index.ts                                                         │
// │  Module: harness/conversation-media                                  │
// │  Role: Public package surface for the Work media bridge and feature. │
// │                                                                      │
// │  模块职责：导出受控媒体 bridge、上下文 feature 与类型。              │
// │  · 只向 DSH 提供当前回合贡献，不含 connector send API。              │
// └─────────────────────────────────────────────────────────────────────┘

export {
  ConversationMediaBridgeError,
  NavigatorConversationMediaHttpBridge,
} from './bridge.ts';
export type {
  ConversationMediaAttachment,
  ConversationMediaBridge,
  ConversationMediaOperation,
  MediaAnalysisResponse,
  MediaContextContribution,
} from './bridge.ts';
export {
  createConversationMediaFeature,
} from './feature.ts';
export type {
  ConversationMediaContextResult,
  ConversationMediaFeature,
  ConversationMediaFeatureOptions,
  ConversationMediaInput,
} from './feature.ts';
