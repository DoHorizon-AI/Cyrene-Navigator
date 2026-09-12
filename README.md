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
