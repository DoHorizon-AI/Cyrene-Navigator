# Security policy / 安全策略

Navigator is a public source-preview repository. The browser WebUI, Python
persistence API, Harness adapters, Rust native host, and native Windows client
have different trust and deployment boundaries. A report should name the
affected surface and the commit where it was observed.

Navigator 是公开的源代码预览仓库。浏览器 WebUI、Python 持久化 API、Harness 适配器、
Rust 原生宿主和原生 Windows 客户端具有不同的信任与部署边界。报告应说明受影响的交付
面以及观察问题时使用的 commit。

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

- `Core/Mock` is a local Debug preview and is not compiled into the Windows
  Release path. It still must not contain real personal data or credentials.
- The browser WebUI currently performs an API availability probe; it is not a
  complete chat client or an authentication authority.
- The Windows client reads through `Core/Ports`, while send, cancel, and approve
  control actions fail closed until an owning Harness control route is exposed.
- `apps/windows` is unpackaged and unsigned. Do not treat a locally built `.exe`
  as a trusted release artifact.

- `Core/Mock` 是本地 Debug 预览，Windows Release 路径不会编译它；即便如此也不能放入
  真实个人数据或凭据。
- 当前浏览器 WebUI 只做 API 可用性探测，不是完整聊天客户端，也不是身份认证权威。
- Windows 客户端通过 `Core/Ports` 读取；在所属 Harness 控制通道开放前，发送、取消、审批
  动作会 fail closed。
- `apps/windows` 目前不打包且未签名；本地生成的 `.exe` 不能视为可信发布产物。

Security fixes should preserve the repository's public API boundaries and must
not silently add a second Product, Plugin, or Platform authority.

安全修复应保持仓库公开 API 边界，不能静默新增第二套 Product、Plugin 或 Platform 权威。
