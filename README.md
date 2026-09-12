# Navigator

Navigator is Cyrene's desktop workspace and client-facing local host. It calls
Product APIs directly and owns the desktop adapters needed to present those
Products to users.

## Boundaries

- Product lifecycle and payload operations go directly to Catalyst, Yield,
  Echo, Reactor, and Exchange.
- Navigator owns its UI, session persistence, Codex import host, and local
  Artifact publication adapter.
- Cross-product references use the transparent ArtifactRef wire shape. Artifact
  kinds are open producer-owned strings such as `navigator-text-jsonl-v1`.
- Platform may provide optional installation, compatibility, and control-plane
  services. Navigator's build and payload path do not require a Platform source
  checkout or Platform executable.
- Capability implementations and payload contracts belong to their Product or
  Plugin repositories.

Navigator has two UI modes with one contract boundary:

- Browser WebUI: `apps/desktop` is a standalone Vite package that opens directly
  in the browser and talks to Navigator over HTTP.
- Native Windows client: `apps/windows` owns the Windows-native presentation
  surface. Its product data source is an explicit seam, so the UI can move to a
  separate repository without changing Navigator's service or contract code.

The Rust `native/` workspace remains a process/integration host. It is not a
WebUI shell and does not own presentation state.

## Current delivery status / 当前交付状态

This repository is a public source preview, not a finished binary release.
`apps/desktop` currently renders a standalone browser shell and probes the
Navigator API; it is not yet a complete chat client. `apps/windows` is an
`API_CONNECTED_PROTOTYPE`: reads use the real API through `Core/Ports`, while
send, cancel, and approve fail closed because the Harness control route is not
connected. The Windows client is unpackaged, framework-dependent, unsigned, and
not packable (`IsPackable=false`). Automated release is disabled.

本仓库是公开的源代码预览，不是已经完成的二进制发布物。`apps/desktop` 当前只渲染独立
浏览器 shell 并探测 Navigator API，还不是完整聊天客户端。`apps/windows` 是
`API_CONNECTED_PROTOTYPE`：读取通过 `Core/Ports` 使用真实 API；由于 Harness 控制通道尚未
接通，发送、取消和审批会 fail closed。Windows 客户端目前不打包、依赖框架、未签名且
不可 pack（`IsPackable=false`），自动发布已禁用。

The `private: true` values in npm manifests prevent accidental registry
publishing of those packages; they do not describe GitHub repository visibility.

npm manifest 中的 `private: true` 只防止 package 被误发布到 registry，不表示 GitHub 仓库
的可见性。

## Documentation

- [Product API and desktop contract](docs/API.md)
- [Desktop/native client status](docs/desktop/README.md)
- [Repository lifecycle](docs/REPOSITORY-LIFECYCLE.md)
- [Native host](native/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [License](LICENSE)
