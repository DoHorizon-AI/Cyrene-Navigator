// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Integration Exports                                │
// │ Role: Export supported official cloud connection hooks.             │
// │ 模块职责：导出受支持的官方云连接接口。                                  │
// └─────────────────────────────────────────────────────────────────────┘

export {
  buildGcloudReadonlyArgs,
  loadCloudConnectionConfig,
  registerCloudConnections,
  runGcloudReadonly,
  validateCloudConnectionConfig,
} from './cloud-connections.js';
export type {
  CloudConnectionConfig,
  CloudConnectionHealth,
  CloudConnectionProfile,
  CloudConnectionRegistry,
  CloudConnectionStatus,
  CloudToolDescription,
  GcloudCommandRunner,
  GcloudReadonlyConfig,
  GcloudReadonlyOperation,
  OfficialSource,
  RemoteMcpProfile,
  StdioMcpProfile,
} from './cloud-connections.js';
