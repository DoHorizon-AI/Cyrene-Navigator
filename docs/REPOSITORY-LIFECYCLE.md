# Repository Lifecycle: cyrene-navigator

Navigator is a public source-preview Product owned by the Client Applications
Team. `main` is its remote default, integration, and release branch. The
machine-readable policy is
[`repository-policy.yaml`](../repository-policy.yaml).

Navigator 是公开的源代码预览 Product，由 Client Applications Team 负责。`main` 是远端
默认、集成与发布分支。机器可读的治理权威是
[`repository-policy.yaml`](../repository-policy.yaml)。

## Ownership

This repository owns local Session persistence, Navigator Product APIs, Harness
adapters, the Codex import host, and its native process host. It does not own
training, serving, evaluation, dataset processing, Plugin capability
implementations, the optional Navigator UI, or the Platform substrate.

Navigator is independently buildable with Python, Cargo, and npm. Its
build, tests, and package jobs do not require another repository checkout.

## Delivery

- CI authority: GitHub Actions (`.github/workflows/`). Azure Pipelines is kept
  as a manual, non-authoritative integration definition.
- Push checks in the three repository workflows cover `main`, `feat/**`,
  `fix/**`, and `refactor/**`. Pull-request filters remain workflow-specific, and
  each workflow keeps its existing `workflow_dispatch` behavior.
- Release authority: a manually prepared GitHub Release from `main`.
- Automated release: disabled until a signed artifact and release workflow have
  been reviewed and proven.
- Package units: Python persistence service and Harness bundle.
- Native binary: `cyrene-native-host`.
- Distribution profile: `navigator_core` component release.
- UI packaging and signing belong to the optional `cyrene.ui.navigator` Plugin.

GitHub Actions are the current CI authority. A workflow run with no executed
steps is `NOT_RUN/BLOCKED`, not a source pass or failure. Azure does not replace
the GitHub checks and does not authorize a release.

三个仓库 workflow 的 push 检查统一覆盖 `main`、`feat/**`、`fix/**` 和 `refactor/**`。Pull request
筛选仍按各 workflow 原有语义保留；各 workflow 已声明的 `workflow_dispatch` 行为不变。

GitHub Actions 是当前 CI 权威。没有执行任何 step 的 workflow run 属于
`NOT_RUN/BLOCKED`，不能归类为源码通过或失败。Azure 不替代 GitHub 检查，也不授权发布。

## Public publication gate / 公开发布门槛

The former repository history, including the private demo assets, is retained
unchanged in the private `Cyrene-Navigator-history-archive` repository. The
canonical `Cyrene-Navigator` repository starts from a clean root and publishes
only its new `main` history; no old branches, tags, or pull-request refs are
copied into it. The archive remains private and is the only place where the old
commit IDs are retained. The canonical repository is now public; the private
archive remains the sole owner of the former history and private demo assets.
The publication record keeps the old and new SHAs plus the privacy and
large-object scan evidence.

此前仓库的完整历史（包括私有演示资产）原样保存在私有
`Cyrene-Navigator-history-archive` 仓库中。规范的 `Cyrene-Navigator` 仓库从 clean root 开始，
只发布新的 `main` 历史；旧 branch、tag 和 pull-request ref 不会复制到规范仓库。归档仓库保持
private，是保留旧 commit ID 的唯一位置。规范仓库现已公开；私有归档继续作为旧历史与私有
演示资产的唯一权威。发布记录继续保留旧/新 SHA 以及隐私和大对象扫描证据。

## Verification

Local and GitHub checks cover Python lint/type/tests, OpenAPI, the repository
boundary guard, the independent native host, and exact Harness integration.
Browser/WinUI source, packaging, signing, and interactive checks are separate
evidence lanes in `cyrene.ui.navigator`; Navigator CI does not imply them.

Local 与 GitHub 检查覆盖 Python lint/type/test、OpenAPI、仓库边界、独立 native host、精确
Harness 集成。浏览器/WinUI 源码、打包、签名与交互式检查属于 `cyrene.ui.navigator` 的独立
证据层；Navigator CI 不代表这些门禁已经通过。

Published tags follow immutable repository-scoped SemVer (`v{version}`). A
defective release receives a new patch version.
