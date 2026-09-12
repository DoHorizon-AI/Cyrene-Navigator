# Contributing to Navigator / 参与 Navigator 贡献

Navigator is published as a source-preview Product. It keeps the browser WebUI,
the native Windows client, the Harness adapters, the Rust native host, and the
Python persistence API as separate delivery surfaces. Contributions must keep
those boundaries explicit and must not imply that an unfinished surface is a
released product.

Navigator 以源代码预览 Product 的形式公开。浏览器 WebUI、原生 Windows 客户端、
Harness 适配器、Rust 原生宿主和 Python 持久化 API 是独立交付面。贡献必须保持这些
边界清晰，不能把尚未完成的界面描述为已发布产品。

## Before opening a change / 提交前

- Keep Product state and capability implementations in their owning repositories.
  Navigator consumes published API contracts and does not add a second authority.
- Keep the browser and native clients independent. Native views depend on
  `Core/Ports`; `Core/Mock` is a Debug-only preview fixture and is excluded from
  Release builds.
- Do not commit credentials, private endpoints, customer data, personal profiles,
  generated build output, or screenshots containing non-public identities.
- Keep the exact DeepSeek Harness pin in `harness/upstream.lock.json` and document
  any consumer-only adaptation in the adoption documentation.
- Update `THIRD_PARTY_NOTICES.md` when a manifest, lockfile, bundled font, or
  distribution dependency changes.

提交变更前请确认：

- Product 状态和能力实现仍归属其自身仓库；Navigator 只消费已发布 API 契约，不新增
  第二套权威状态。
- 浏览器与原生客户端保持独立；原生视图依赖 `Core/Ports`，`Core/Mock` 仅用于 Debug
  预览，Release 构建会排除它。
- 不提交凭据、私有端点、客户数据、个人资料、构建产物或包含非公开身份的截图。
- 保持 `harness/upstream.lock.json` 中的 DeepSeek Harness 精确 pin；消费者侧适配须在
  adoption 文档中说明。
- manifest、lockfile、内置字体或分发依赖发生变化时同步更新
  `THIRD_PARTY_NOTICES.md`。

## Local checks / 本地校验

Run the checks for every surface you touched. A command that was not run is not
evidence of a pass.

修改了哪个交付面就运行对应校验；没有运行的命令不能报告为通过。

```bash
# Python service
uv sync --frozen --group dev
uv run ruff check src tests scripts/serve-persistence.py
uv run ruff format --check src tests scripts/serve-persistence.py
uv run mypy src/cyrene_navigator scripts/serve-persistence.py
uv run pytest -q

# Browser WebUI
pnpm --dir apps/desktop install --frozen-lockfile
pnpm --dir apps/desktop build

# Rust native host
cargo fmt --manifest-path native/Cargo.toml --all -- --check
cargo clippy --manifest-path native/Cargo.toml --workspace --all-targets --locked -- -D warnings
cargo test --manifest-path native/Cargo.toml --workspace --all-targets --locked

# Native Windows surface (Linux/macOS/CI headless checks)
bash apps/windows/tools/check.sh
```

The exact Harness integration requires a clean checkout at the commit recorded
in `harness/upstream.lock.json`; follow `harness/README.md` and keep that result
separate from focused fixture tests. Windows GUI, installer, signing, and real
Harness control-channel checks are separate evidence lanes.

精确 Harness 集成必须使用 `harness/upstream.lock.json` 中记录的干净 checkout；请按
`harness/README.md` 操作，并将其与 focused fixture 测试分开报告。Windows GUI、安装包、
签名和真实 Harness 控制通道检查属于独立证据层。

## Pull requests / Pull Request

Use a focused branch and a Conventional Commit subject. Explain the affected
contract or boundary, list the commands that ran, and call out anything blocked
by a missing Windows machine, external service, credentials, or hosted CI
capacity. Keep `main` as the repository default/release branch and `develop` as
the integration branch.

使用聚焦分支和 Conventional Commit 标题。说明受影响的契约或边界，列出已运行的命令，
并明确 Windows 机器、外部服务、凭据或 Hosted CI 容量造成的阻塞。`main` 是仓库默认/发布
分支，`develop` 是集成分支。

The `private` flag in an npm `package.json` only prevents accidental registry
publishing of that package. It does not describe GitHub repository visibility.
Repository visibility is governed by the hosting settings and
`repository-policy.yaml`.

npm `package.json` 中的 `private` 只用于阻止该 package 被误发布到 registry，不代表
GitHub 仓库可见性。仓库可见性由托管平台设置与 `repository-policy.yaml` 共同描述。

## License / 许可证

By contributing, you agree that your contribution is provided under the Apache
License 2.0 in [`LICENSE`](LICENSE), unless you have a separate written
agreement with the project owner. Third-party dependencies remain under their
own licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

贡献即表示您同意将贡献按 [`LICENSE`](LICENSE) 中的 Apache License 2.0 提供，除非您与
项目所有者另有书面协议。第三方依赖仍受其自身许可证约束，详见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
