// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: CodeBuddy ACP launch profile                                │
// │ Role: Retain the CodeBuddy provider name on the shared ACP runtime.  │
// │ 模块职责：在共享 ACP 运行时保留 CodeBuddy 原生启动配置。              │
// └─────────────────────────────────────────────────────────────────────┘

import { AcpSubagentProvider } from './acp.js'

/** CodeBuddy deployments retain the default-permission stdio launch flags. */
export class CodeBuddySubagentProvider extends AcpSubagentProvider {}
