# Repository Lifecycle: cyrene-navigator

Navigator is a public source-preview Product owned by the Client Applications
Team. `main` is its remote default and release branch; `develop` is the
integration branch. The machine-readable policy is
[`repository-policy.yaml`](../repository-policy.yaml).

Navigator 是公开的源代码预览 Product，由 Client Applications Team 负责。`main` 是远端
默认与发布分支，`develop` 是集成分支。机器可读的治理权威是
[`repository-policy.yaml`](../repository-policy.yaml)。

## Ownership

This repository owns the desktop UI and packaging, local Session persistence,
Navigator Harness adapters, Codex import host, and Product-facing client
adapters. It does not own training, serving, evaluation, dataset processing,
Plugin capability implementations, or the Platform substrate.

Navigator is independently buildable with Python, Cargo, npm, and .NET. Its
build, tests, and package jobs do not require another repository checkout.

## Delivery

- CI authority: GitHub Actions (`.github/workflows/`). Azure Pipelines is kept
  as a manual, non-authoritative integration definition.
- Push checks in the three repository workflows cover `main`, `develop`,
  `feat/**`, and `fix/**`. Pull-request filters remain workflow-specific, and
  each workflow keeps its existing `workflow_dispatch` behavior.
- Release authority: a manually prepared GitHub Release from `main`.
- Automated release: disabled until a signed artifact and release workflow have
  been reviewed and proven.
- Package units: Python persistence service, Harness bundle, and desktop.
- Native binaries: the Windows native client and `cyrene-native-host`.
- Distribution profile: `client_desktop` source preview.
- Packaging: the browser is source-preview-only; the Windows client is
  unpackaged, framework-dependent, unsigned, and `IsPackable=false`.

GitHub Actions are the current CI authority. A workflow run with no executed
steps is `NOT_RUN/BLOCKED`, not a source pass or failure. Azure does not replace
the GitHub checks and does not authorize a release.

三个仓库 workflow 的 push 检查统一覆盖 `main`、`develop`、`feat/**` 和 `fix/**`。Pull request
筛选仍按各 workflow 原有语义保留；各 workflow 已声明的 `workflow_dispatch` 行为不变。

GitHub Actions 是当前 CI 权威。没有执行任何 step 的 workflow run 属于
`NOT_RUN/BLOCKED`，不能归类为源码通过或失败。Azure 不替代 GitHub 检查，也不授权发布。

## Public publication gate / 公开发布门槛

The former repository history, including the private demo assets, is retained
unchanged in the private `Cyrene-Navigator-history-archive` repository. The
canonical `Cyrene-Navigator` repository starts from a clean root and publishes
only its new `main` history; no old branches, tags, or pull-request refs are
copied into it. The archive remains private and is the only place where the old
commit IDs are retained. This clean-root replacement does not change GitHub
visibility; the canonical repository remains private until an authorized
maintainer explicitly approves a future public switch.

Before any future public switch, an authorized maintainer must audit the
canonical tree, every reachable ref, and the private archive record, then read
back the remote visibility and blob-scan results. The publication record keeps
the old and new SHAs plus the privacy and large-object scan evidence.

此前仓库的完整历史（包括私有演示资产）原样保存在私有
`Cyrene-Navigator-history-archive` 仓库中。规范的 `Cyrene-Navigator` 仓库从 clean root 开始，
只发布新的 `main` 历史；旧 branch、tag 和 pull-request ref 不会复制到规范仓库。归档仓库保持
private，是保留旧 commit ID 的唯一位置。本次 clean-root 替换不改变 GitHub 可见性；规范仓库在
获授权维护者明确批准未来公开切换之前仍保持 private。

未来若要公开，获授权维护者必须审计规范仓库当前树、全部可达 ref 及私有归档记录，并回读远端
可见性和 blob 扫描结果。发布记录保留旧/新 SHA 以及隐私和大对象扫描证据。

## Verification

Local and GitHub checks cover Python lint/type/tests, OpenAPI, the repository
boundary guard, the independent native host, exact Harness integration, the
browser WebUI build, and the headless Windows client checks. A Windows GUI run,
installer/package creation, signing, and a real Harness control-channel run are
separate evidence lanes and are not implied by source or headless checks. The
browser WebUI currently performs an API probe only; the native client reads
through `Core/Ports`, while send, cancel, and approve are fail-closed until the
Harness control route is exposed.

Local 与 GitHub 检查覆盖 Python lint/type/test、OpenAPI、仓库边界、独立 native host、精确
Harness 集成、浏览器 WebUI 构建和无头 Windows 客户端检查。Windows GUI、安装包/打包、签名
以及真实 Harness 控制通道属于独立证据层，源码或无头检查不代表这些证据已经存在。当前
浏览器 WebUI 仅做 API probe；原生客户端经 `Core/Ports` 读取，发送、取消、审批在 Harness
控制路由开放前会 fail closed。

Published tags follow immutable repository-scoped SemVer (`v{version}`). A
defective release receives a new patch version.
