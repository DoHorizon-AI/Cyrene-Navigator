# Repository Lifecycle: cyrene-navigator

Navigator provides Harness adapters and local APIs used by the Native Client
(`Cyrene-Client`) over its configured service URL. The client control service
reaches the separate Navigator Web Host. Navigator composes a pinned revision of
the upstream DeepSeek Harness repository with Cyrene adapters. It is owned by the Client Applications Team.
`develop` is its active development branch, and `release` is its release branch.
The machine-readable policy is
[`repository-policy.yaml`](../repository-policy.yaml).

Navigator 通过配置的服务 URL 为 Native Client（`Cyrene-Client`）提供 Harness 适配器与本地 API。客户端
control service 访问独立的 Navigator Web Host。Navigator 将固定版本的上游 DeepSeek Harness 仓库与 Cyrene 适配器组合，由 Client Applications Team 负责。`Cyrene-Client`
拥有应用 shell 和主要面向用户的展示层；Navigator 也包含 Harness UI 适配器。机器可读的治理权威是
[`repository-policy.yaml`](../repository-policy.yaml)。

## Ownership

This repository owns Cyrene's pinned Harness integration, local session persistence API,
bounded Product workspace-read API, explicit Product handoffs, Harness UI adapters, and native
host integration. The upstream Harness owns the Agent Loop and Session event model. The
Native Client owns the application shell and primary user-facing presentation. This repository
does not own Product services such as training, serving, evaluation, dataset processing, or
gateway governance.

Navigator is independently buildable with Python, Cargo, and npm. Its
build, tests, and package jobs do not require another repository checkout.

## Delivery

- CI authority: GitHub Actions (`.github/workflows/`). Azure Pipelines is kept
  as a manual, non-authoritative integration definition.
- The CI, Product Contract, and Native Windows workflows run push checks on
  `develop`, `main`, `release`, `feat/**`, `fix/**`, and `refactor/**`;
  pull-request filters remain workflow-specific.
- Release authority: a manually prepared GitHub Release from `release`.
- Automated release: disabled until a signed artifact and release workflow have
  been reviewed and proven.
- Package units: Python persistence service and Harness bundle.
- Native binary: `cyrene-native-host`.
- Distribution profile: `navigator_core` component release.
- Client application presentation: owned by the Native Client (`Cyrene-Client`); Navigator retains UI adapter code for its pinned Harness profile.

GitHub Actions are the current CI authority. A workflow run with no executed
steps is `NOT_RUN/BLOCKED`, not a source pass or failure. Azure does not replace
the GitHub checks and does not authorize a release.

CI、Product Contract 和 Native Windows workflow 的 push 检查覆盖 `develop`、`main`、`release`、
`feat/**`、`fix/**` 和 `refactor/**`；Pull request 筛选仍按各 workflow 原有语义保留。

GitHub Actions 是当前 CI 权威。没有执行任何 step 的 workflow run 属于
`NOT_RUN/BLOCKED`，不能归类为源码通过或失败。Azure 不替代 GitHub 检查，也不授权发布。

## Public publication gate / 公开发布门槛

The former repository history, including the private demo assets, is retained
unchanged in the private `Cyrene-Navigator-history-archive` repository. The
canonical `Cyrene-Navigator` repository starts from a clean root and publishes
only the new canonical history; no old branches, tags, or pull-request refs are
copied into it. The archive remains private and is the only place where the old
commit IDs are retained. The canonical repository is now public; the private
archive remains the sole owner of the former history and private demo assets.
The publication record keeps the old and new SHAs plus the privacy and
large-object scan evidence.

此前仓库的完整历史（包括私有演示资产）原样保存在私有
`Cyrene-Navigator-history-archive` 仓库中。规范的 `Cyrene-Navigator` 仓库从 clean root 开始，
只发布新的规范历史；旧 branch、tag 和 pull-request ref 不会复制到规范仓库。归档仓库保持
private，是保留旧 commit ID 的唯一位置。规范仓库现已公开；私有归档继续作为旧历史与私有
演示资产的唯一权威。发布记录继续保留旧/新 SHA 以及隐私和大对象扫描证据。

## Verification

Local and GitHub checks cover Python lint/type/tests, OpenAPI, the repository
boundary guard, the independent native host, and exact Harness integration.
Native Client application UI, packaging, signing, and interactive checks are
owned by `Cyrene-Client`; Navigator CI does not imply that application's checks.

Local 与 GitHub 检查覆盖 Python lint/type/test、OpenAPI、仓库边界、独立 native host、精确
Harness 集成。Native Client 应用 UI、打包、签名和交互检查由 `Cyrene-Client` 负责；Navigator CI
不代表该客户端应用的门禁已经通过。

Published tags follow immutable repository-scoped SemVer (`v{version}`). A
defective release receives a new patch version.
---
<!-- Chinese Translation / 中文翻译 -->

## 所有权补充

本仓库拥有固定版本的 Harness 集成、本地会话持久化 API、受限的 Product Workspace 读取 API、显式 Product 交接、Harness UI 适配器和原生宿主集成。上游 Harness 拥有 Agent Loop 与 Session 事件模型。Native Client 拥有应用 shell 和主要面向用户的展示层。本仓库不拥有训练、服务部署、评估、数据集处理或网关治理等 Product 服务。

Navigator 可独立使用 Python、Cargo 和 npm 构建。构建、测试和打包作业不需要检出其他仓库。

## 交付配置

- **CI 权威**：GitHub Actions（`.github/workflows/`）。Azure Pipelines 仅作为手动、非权威的集成定义保留。
- **Push 检查**：CI、Product Contract 和 Native Windows workflow 覆盖 `develop`、`main`、`release`、`feat/**`、`fix/**` 和 `refactor/**`；Pull Request 筛选按各 workflow 原有配置执行。
- **发布权威**：从 `release` 手动准备 GitHub Release。
- **自动发布**：已禁用，待签名制品和发布 workflow 经审查并验证后再启用。
- **包单元**：Python 持久化服务与 Harness bundle。
- **原生二进制**：`cyrene-native-host`。
- **分发配置**：`navigator_core` 组件发布。
- **客户端应用展示**：应用 shell 和主要面向用户的展示层由 Native Client（`Cyrene-Client`）负责；Navigator 保留其 Harness UI 适配代码。

## 版本标签

已发布标签采用仓库范围的不可变 SemVer 格式（`v{version}`）。有缺陷的发布必须递增新的 patch 版本。
