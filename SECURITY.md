# Security policy / 安全策略

Navigator is a public repository. It composes a pinned revision of the upstream DeepSeek Harness
repository with Cyrene adapters and provides local session and Product-read APIs plus a Rust native
host. These surfaces have different trust and deployment boundaries. A report should name the
affected surface and the commit where it was observed. Application-shell and primary-presentation
findings belong to `Cyrene-Client`; findings in Navigator's Harness UI adapters remain in this
repository's scope.

Navigator 是公开仓库，将固定版本的上游 DeepSeek Harness 仓库与 Cyrene 适配器组合，并提供本地会话
与 Product 读取 API 以及 Rust 原生宿主。不同交付面具有不同的信任与部署边界。报告应说明受影响的
交付面和观察问题时使用的 commit。应用 shell 与主要展示层问题归 `Cyrene-Client`；Navigator 内
Harness UI 适配器的问题仍属于本仓库。

## Reporting a vulnerability / 报告漏洞

Please use GitHub's private vulnerability reporting or Security Advisory flow
for an unpatched vulnerability. Do not put credentials, tokens, customer data,
or an exploitable proof of concept in a public issue. If private reporting is not
enabled for the repository, contact the repository maintainers through the
organization's published contact channel and ask for a private security intake.

未修复的漏洞请使用 GitHub 的私密漏洞报告或 Security Advisory 流程。不要在公开 issue
中提交凭据、token、客户数据或可直接利用的 PoC。如果仓库尚未启用私密报告，请通过组织
公开的联系渠道联系维护者并请求私密安全入口。

Include, when safe to share privately:

- affected component, branch, and exact commit SHA;
- prerequisites and a minimal reproduction or failing request;
- confidentiality, integrity, availability, or supply-chain impact;
- whether the issue reaches a Release build or only a Debug/fixture path;
- a suggested mitigation and any disclosure timeline you require.

在安全范围内请私密提供：

- 受影响组件、分支和精确 commit SHA；
- 前置条件及最小复现步骤或失败请求；
- 对机密性、完整性、可用性或供应链的影响；
- 问题是否可达 Release 构建，还是仅存在于 Debug/fixture 路径；
- 建议的缓解方式及所需披露时间表。

## Scope notes / 范围说明

- The persistence API owns durable session state and must enforce workspace and
  principal boundaries.
- Harness and native-host inputs are untrusted protocol data; validate them
  before persistence or process execution.
- The Native Client application shell, preview fixtures, packaging, and signing
  are outside this repository. Navigator's Harness UI adapters remain in scope.

- 持久化 API 拥有持久会话状态，必须执行 workspace 与 principal 边界。
- Harness 与 native-host 输入是不可信协议数据，必须在持久化或启动进程前校验。
- Native Client 应用 shell、预览 fixture、打包与签名不属于本仓库；Navigator 的
  Harness UI 适配器仍在本仓库安全范围内。

Security fixes should preserve the repository's public API boundaries and must
not silently add a second Product, Plugin, or Platform authority.

安全修复应保持仓库公开 API 边界，不能静默新增第二套 Product、Plugin 或 Platform 权威。
