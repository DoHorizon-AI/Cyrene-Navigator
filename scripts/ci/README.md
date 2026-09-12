# CI architecture boundary / CI 架构边界

`check-platform-boundary.py` rejects Platform source dependencies, retired
external-process bootstrap, closed Product artifact kinds, and release leakage
from the Windows mock prototype. GitHub Actions runs this repository-owned guard
as part of the authoritative CI workflows without checking out another
repository. Azure Pipelines is retained only as a manually invoked,
non-authoritative integration definition.

`check-platform-boundary.py` 会拒绝 Platform 源码依赖、已退役的外部进程引导、封闭
Product artifact kind，以及 Windows mock 原型进入 Release。GitHub Actions 在权威 CI
workflow 中执行本仓脚本，不再 checkout 其他仓库；Azure Pipelines 仅作为手动、非权威的
集成定义保留。

```bash
python scripts/ci/check-platform-boundary.py
```
