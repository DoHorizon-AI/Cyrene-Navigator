# FAQ and troubleshooting / 常见问题与排障

## Is Navigator's runtime in this repository? / Navigator 的运行时在本仓库吗？

Yes. The active Product and host implementation is:

- `harness/` — Navigator-owned adapters on the pinned DeepSeek Harness profile.
- `native/` — the Rust `cyrene-native-host` process/integration host.
- `src/cyrene_navigator/` — the Python session persistence and Product read service.

是。活跃的 Product 与宿主实现包括 `harness/`（固定 DeepSeek Harness profile 上的
Navigator 适配器）、`native/`
（Rust `cyrene-native-host` 进程/集成宿主）、`src/cyrene_navigator/`（Python 会话
持久化与产品读取服务）。

## How does the Windows client get its data? / Windows 客户端的数据从哪里来？

The WinUI client now lives in `cyrene.ui.navigator`. Its reads come from the
workspace-scoped Navigator persistence service through its client adapters
(`CYRENE_NAVIGATOR_API_URL`, `CYRENE_NAVIGATOR_API_TOKEN`,
`CYRENE_NAVIGATOR_WORKSPACE`). Actions that require the Harness control route
(send, cancel, approve) fail closed with `NAVIGATOR_CONTROL_NOT_CONNECTED`. When
no API is configured the client says so; `CYRENE_NAVIGATOR_UI_PREVIEW=mock` is a
Debug-only preview mode, and Release builds do not compile the fixtures at all.

WinUI 客户端现位于 `cyrene.ui.navigator`。其读取路径经客户端适配器来自工作区级
Navigator 持久化服务（通过 `CYRENE_NAVIGATOR_API_URL`、
`CYRENE_NAVIGATOR_API_TOKEN`、`CYRENE_NAVIGATOR_WORKSPACE` 配置）。需要 Harness 控制
通道的动作（发送、取消、审批）以 `NAVIGATOR_CONTROL_NOT_CONNECTED` fail closed。未配置
API 时客户端会如实说明；`CYRENE_NAVIGATOR_UI_PREVIEW=mock` 是仅 Debug 的预览模式，
Release 构建完全不编译 fixture。

## Where are local capability contracts defined? / 本地能力契约在哪里定义？

Not in Navigator. Capability IDs, payload schemas, SDKs, and TCKs are owned by
their Product or Plugin repositories (Plugins publishes the canonical index in
its `contracts/capabilities.yaml`). Navigator V1 does not connect local Plugin
capabilities; the `skill.runtime.v1`, `tool.provider.v1`, and `mcp.server.v1`
snapshots are `MIGRATING` and must not be treated as deployable. Navigator-owned
Product API references live under `contracts/product/v1/`.

不在 Navigator。能力 ID、载荷 schema、SDK 与 TCK 由其所属 Product 或 Plugin 仓库
拥有（Plugins 在 `contracts/capabilities.yaml` 发布规范索引）。Navigator V1 尚未接入
本地 Plugin 能力；`skill.runtime.v1`、`tool.provider.v1`、`mcp.server.v1` 快照均为
`MIGRATING`，不得视为可部署。Navigator 自有的产品 API 引用位于 `contracts/product/v1/`。

## Does Navigator own remote product state? / Navigator 是否拥有远程产品状态？

No. Navigator coordinates user-facing workflows and renders remote results.
Catalyst, Yield, Echo, Reactor, and Exchange remain authorities for their own
domain state and APIs.

不拥有。Navigator 负责协调面向用户的工作流并呈现远程结果；Catalyst、Yield、Echo、
Reactor 与 Exchange 仍分别是各自领域状态和 API 的权威。

## Can the client call a local tool directly? / 客户端可以直接调用本地工具吗？

Local tool and MCP integration is not connected in V1. When it is connected,
tools must be resolved through the Plugins-owned capability contract at its
direct endpoint so approval, cancellation, policy, and diagnostics remain
observable and consistent; Navigator must not bypass that resolution.

V1 尚未接入本地工具与 MCP 集成。接入时必须通过 Plugins-owned 能力契约直连其端点解析
工具，以保持审批、取消、策略与诊断的一致性和可见性；Navigator 不得绕过该解析。

## How should an MCP issue be isolated? / 如何定位 MCP 问题？

Check the layers in order: server identity and discovery, capability resolution,
user approval, argument validation, transport, provider execution, result
validation, and UI rendering. Keep protocol, policy, provider, and presentation
errors separate.

按以下层次排查：服务身份与发现、能力解析、用户审批、参数校验、传输、提供方执行、
结果校验、界面呈现。将协议、策略、提供方与呈现错误分开。

## What should not be added to Navigator? / Navigator 不应加入什么？

Do not add independent control-plane state, a second plugin architecture, heavy
training loops, or model serving. Navigator calls Product APIs directly and
delegates training and serving to Yield and Reactor; it must not restore a
retired service manifest, add a Platform source dependency, or assume a Platform
payload API for capability calls.

不要在 Navigator 中加入独立控制平面状态、第二套插件架构、重量级训练循环或模型服务。
Navigator 直连产品 API，并将训练与服务交给 Yield 和 Reactor；不得恢复已退役的服务
清单、新增 Platform 源码依赖，或假设通过 Platform payload API 调用能力。
