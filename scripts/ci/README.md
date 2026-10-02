# CI architecture boundary / CI 架构边界

`check-platform-boundary.py` rejects Platform source dependencies, retired
external-process bootstrap, closed Product artifact kinds, and release leakage
from the Windows mock prototype. The source CI workflow runs this repository-
owned guard without checking out another repository. The separate
`component-release.yml` may identify the trusted Runtime Maintenance SDK index
publisher and check out release tools at the exact source commit declared by
that attested index. This path-scoped exception applies only to that release
workflow; Product image builds receive the verified SDK wheel through a named
build context. Product Dockerfiles, runtime code, and every other workflow
remain subject to the full boundary checks. Azure Pipelines is retained only as
a manually invoked, non-authoritative integration definition.

`check-platform-boundary.py` 会拒绝 Platform 源码依赖、已退役的外部进程引导、封闭
Product artifact kind，以及 Windows mock 原型进入 Release。源码 CI workflow 执行本仓脚本，
不 checkout 其他仓库。单独的 `component-release.yml` 可以标识受信 Runtime Maintenance SDK
索引发布方，并按经过 attestation 的索引声明的精确 source commit 检出发布工具。此路径例外
仅适用于该发布 workflow；Product 镜像构建通过 named build context 接收已验证的 SDK wheel。
Product Dockerfile、运行时代码和其他所有 workflow 仍完整执行边界检查。Azure Pipelines 仅作为
手动、非权威的集成定义保留。

```bash
python scripts/ci/check-platform-boundary.py
```
