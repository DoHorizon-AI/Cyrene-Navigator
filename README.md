# Navigator

Navigator is Cyrene's Product API, session-persistence service, Harness adapter,
and native process host. Optional user interfaces consume its published API
from the Plugins repository.

## Boundaries

- Product lifecycle and payload operations go directly to Catalyst, Yield,
  Echo, Reactor, and Exchange.
- Navigator owns session persistence, the Codex import host, Product APIs, and
  its local Artifact publication adapter.
- Cross-product references use the transparent ArtifactRef wire shape. Artifact
  kinds are open producer-owned strings such as `navigator-text-jsonl-v1`.
- Platform may provide optional installation, compatibility, and control-plane
  services. Navigator's build and payload path do not require a Platform source
  checkout or Platform executable.
- Capability implementations, payload contracts, and optional client UI bundles
  belong to their Product or Plugin repositories.

The browser WebUI and native Windows client now live under
`Cyrene-Plugins-Official/plugins/ui/navigator`. That optional bundle owns its
presentation and Product-client adapters while this repository remains the
authority for the API and durable session state.

The Rust `native/` workspace remains a process/integration host. It is not a
WebUI shell and does not own presentation state.

## Current delivery status / 当前交付状态

This repository is public. Its UI source was extracted from commit
`a8091ca8e8a01ca8d103aa10ef706891c75c4fb3`; the private history archive and
this public clean-root history retain the provenance record. UI packaging,
signing, and interactive desktop evidence are owned and reported by the
Plugins bundle rather than this repository.

本仓库现已公开。UI 源码从 commit
`a8091ca8e8a01ca8d103aa10ef706891c75c4fb3` 迁出；私有历史归档与当前公开的 clean-root
历史继续保留来源记录。UI 打包、签名和交互式桌面证据由 Plugins 中的 UI 包负责，不再由
本仓库声明。

## Documentation

- [Product API contract](docs/API.md)
- [UI extraction record](docs/desktop/README.md)
- [Repository lifecycle](docs/REPOSITORY-LIFECYCLE.md)
- [Native host](native/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [License](LICENSE)
---
<!-- Chinese Translation / 中文翻译 -->

# Navigator

Navigator 是 Cyrene 的 Product API、会话持久化服务、Harness 适配器和原生进程宿主。可选用户界面通过 Plugins 仓库发布的 API 使用它。

## 边界

- Product 生命周期和业务负载操作直接调用 Catalyst、Yield、Echo、Reactor 和 Exchange。
- Navigator 拥有会话持久化、Codex 导入宿主、Product API 及本地 Artifact 发布适配器。
- 跨 Product 引用使用透明的 ArtifactRef 线格式。Artifact kind 是开放的、由生产方拥有的字符串，例如 `navigator-text-jsonl-v1`。
- Platform 可以提供可选安装、兼容性和控制面服务。Navigator 的构建与负载路径不需要检出 Platform 源码或 Platform 可执行文件。
- 能力实现、负载契约和可选客户端 UI 包归所属 Product 或 Plugin 所有。

浏览器 WebUI 和原生 Windows 客户端现位于 `Cyrene-Plugins-Official/plugins/ui/navigator`。该可选包拥有自己的展示层和 Product 客户端适配器；本仓库继续拥有 API 和持久化会话状态。

Rust `native/` workspace 仍然只是进程/集成宿主，不是 WebUI 容器，也不拥有展示状态。

## 文档索引

- [Product API 契约](docs/API.md)
- [UI 迁移记录](docs/desktop/README.md)
- [仓库生命周期](docs/REPOSITORY-LIFECYCLE.md)
- [原生宿主](native/README.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
- [许可证](LICENSE)
