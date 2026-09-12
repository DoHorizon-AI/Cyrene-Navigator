# Contributing to Navigator / 参与 Navigator 贡献

Navigator is published as a Product API and local-host component. It keeps the
Harness adapters, Rust native host, and Python persistence API as separate
delivery surfaces. The optional browser and WinUI clients are maintained in the
`cyrene.ui.navigator` Plugin.

Navigator 以 Product API 与本地主机组件的形式公开。Harness 适配器、Rust 原生宿主和
Python 持久化 API 是独立交付面；可选浏览器与 WinUI 客户端由 `cyrene.ui.navigator`
Plugin 维护。

## Before opening a change / 提交前

- Keep Product state and capability implementations in their owning repositories.
  Navigator consumes published API contracts and does not add a second authority.
- Keep presentation and Product-client adapter changes in the owning UI Plugin;
  do not copy them back into Navigator.
- Do not commit credentials, private endpoints, customer data, personal profiles,
  generated build output, or screenshots containing non-public identities.
- Keep the exact DeepSeek Harness pin in `harness/upstream.lock.json` and document
  any consumer-only adaptation in the adoption documentation.
- Update `THIRD_PARTY_NOTICES.md` when a manifest, lockfile, bundled font, or
  distribution dependency changes.

提交变更前请确认：

- Product 状态和能力实现仍归属其自身仓库；Navigator 只消费已发布 API 契约，不新增
  第二套权威状态。
- 展示层与 Product 客户端适配器改动应进入所属 UI Plugin，不得复制回 Navigator。
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

# Rust native host
cargo fmt --manifest-path native/Cargo.toml --all -- --check
cargo clippy --manifest-path native/Cargo.toml --workspace --all-targets --locked -- -D warnings
cargo test --manifest-path native/Cargo.toml --workspace --all-targets --locked

```

The exact Harness integration requires a clean checkout at the commit recorded
in `harness/upstream.lock.json`; follow `harness/README.md` and keep that result
separate from focused fixture tests. UI-specific checks run in the Plugins
repository and are not implied by Navigator acceptance.

精确 Harness 集成必须使用 `harness/upstream.lock.json` 中记录的干净 checkout；请按
`harness/README.md` 操作，并将其与 focused fixture 测试分开报告。UI 专属检查在 Plugins
仓库运行，不能由 Navigator 验收结果推导。

## Pull requests / Pull Request

Use a focused branch and a Conventional Commit subject. Explain the affected
contract or boundary, list the commands that ran, and call out anything blocked
by a missing Windows machine, external service, credentials, or hosted CI
capacity. Keep `main` as the repository default, integration, and release branch.

使用聚焦分支和 Conventional Commit 标题。说明受影响的契约或边界，列出已运行的命令，
并明确外部服务、凭据或 Hosted CI 容量造成的阻塞。`main` 是仓库默认、集成与发布分支。

## License / 许可证

By contributing, you agree that your contribution is provided under the Apache
License 2.0 in [`LICENSE`](LICENSE), unless you have a separate written
agreement with the project owner. Third-party dependencies remain under their
own licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

贡献即表示您同意将贡献按 [`LICENSE`](LICENSE) 中的 Apache License 2.0 提供，除非您与
项目所有者另有书面协议。第三方依赖仍受其自身许可证约束，详见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
