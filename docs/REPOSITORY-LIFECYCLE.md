# Repository Lifecycle: cyrene-navigator

Navigator is the built-in Harness component of the Native Client (`Cyrene-Client`),
developed based on secondary development of DeepSeek harness (`deepseek-harness`).
It is owned by the Client Applications Team. `develop` is its active development branch,
and `main` is its release branch. The machine-readable policy is
[`repository-policy.yaml`](../repository-policy.yaml).

Navigator 是 Native Client（`Cyrene-Client`）的内置 Harness 组件，基于 DeepSeek harness
进行二次开发，由 Client Applications Team 负责。Navigator 本身不带 UI，也不包含其他无关服务功能。
机器可读的治理权威是 [`repository-policy.yaml`](../repository-policy.yaml)。

## Ownership

This repository owns the DeepSeek harness runtime adapter, Agent loop coordination,
authoritative local session event persistence, and native host supervisor primitives.
It strictly carries NO UI (UI is exclusively owned by `Cyrene-Client`), and carries NO
unrelated service features (training, serving, evaluation, dataset processing, gateway governance,
or Platform kernel supervision).

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
- UI presentation: Navigator carries no UI; all UI is owned and rendered by the Native Client (`Cyrene-Client`).

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
---
<!-- Chinese Translation / 中文翻译 -->

## 所有权补充

本仓库拥有 DeepSeek harness 运行时适配、Agent 循环协调、权威本地 Session 持久化和原生进程宿主。本仓库严格**不包含任何 UI**（所有 UI 均归 `Cyrene-Client` 独占拥有），也不包含训练、模型服务、评估、数据集处理、API 网关治理或 Platform 底座等无关服务功能。

Navigator 可独立使用 Python、Cargo 和 npm 构建。构建、测试和打包作业不需要检出其他仓库。

## 交付配置

- **CI 权威**：GitHub Actions（`.github/workflows/`）。Azure Pipelines 仅作为手动、非权威的集成定义保留。
- **Push 检查**：三个仓库 workflow 覆盖 `main`、`feat/**`、`fix/**` 和 `refactor/**`；Pull Request 筛选按各 workflow 原有配置执行，并保留已声明的 `workflow_dispatch` 行为。
- **发布权威**：从 `main` 手动准备 GitHub Release。
- **自动发布**：已禁用，待签名制品和发布 workflow 经审查并验证后再启用。
- **包单元**：Python 持久化服务与 Harness bundle。
- **原生二进制**：`cyrene-native-host`。
- **分发配置**：`navigator_core` 组件发布。
- **UI 展示**：Navigator 本身不带 UI，所有图形界面由 Native Client（`Cyrene-Client`）拥有与呈现。

## 版本标签

已发布标签采用仓库范围的不可变 SemVer 格式（`v{version}`）。有缺陷的发布必须递增新的 patch 版本。
