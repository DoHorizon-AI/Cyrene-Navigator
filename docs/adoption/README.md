# Harness adoption ledger / Harness 接入记录

Navigator composes the exact DeepSeek Harness source declared by
`harness/upstream.lock.json`. Repository adapters are compiled from
`harness/src`, loaded through `harness/cordis.patch.yml`, and tested against the
real upstream packages.

## Owned adapters

- Persistence maps upstream Session events to Navigator's HTTP persistence
  authority with explicit leases and takeover.
- Codex import invokes the Navigator Rust host, preserves the source archive,
  and never replays historical tools.
- Client delivery feedback correlates submitted input with durable receipts and
  retains failed input for explicit recovery.
- Compaction removes tool declarations only for the compaction request and
  fails closed on outputs that contain no text.

The native host is launched through `CYRENE_NATIVE_HOST`. It has no external
Platform tool or source dependency. Its implemented methods are reported by the
`hello` handshake and remain limited to Navigator-owned operations.

## Compatibility and evidence

The profile tests use the real pinned Harness CLI, Bundle, Rust host, and local
persistence process. Deterministic model adapters used by focused tests are
fixtures and do not count as real model inference. Installed Windows smoke and
interactive GUI checks remain separate evidence lanes.

The native supervisor matrix retains cancellation, reaping, protocol-version,
bounded-output, and credential-isolation checks. Its controlled fault fixture
only tests the transport; Codex import still crosses the real Navigator Rust host.

Generated profile inventories are snapshots of the lockfile composition. They
must be regenerated when the Profile patch or upstream pin changes and must not
be treated as a runtime success claim.

## Upstream patch policy

Navigator keeps its changes in repository-owned Cordis plugins and client
extensions. A change to upstream Harness is proposed upstream or retained as an
explicit, reviewable adapter; it must not be hidden in an installation script.
---
<!-- Chinese Translation / 中文翻译 -->

## 已拥有的适配器

- 持久化适配器将上游 Session event 映射到 Navigator 的 HTTP 持久化权威，并使用显式 lease 和接管机制。
- Codex 导入会调用 Navigator Rust host、保留来源 archive，且绝不重放历史工具。
- 客户端交付反馈会将已提交输入与持久化回执关联，并保留失败输入供用户显式恢复。
- Compaction 只在 compaction 请求中移除工具声明；输出不含文本时按 fail-closed 处理。

原生宿主通过 `CYRENE_NATIVE_HOST` 启动，不依赖外部 Platform 工具或源码。实现的方法由 `hello` 握手报告，范围仅限 Navigator 所有的操作。

## 兼容性与证据

Profile 测试使用真实固定版本 Harness CLI、Bundle、Rust host 和本地持久化进程。重点测试中的确定性模型适配器只是 fixture，不算真实模型推理。已安装 Windows 冒烟和交互式 GUI 检查属于独立证据路径。

原生 supervisor 矩阵保留取消、回收、协议版本、有界输出和凭据隔离检查。受控故障 fixture 只验证传输；Codex 导入仍通过真实 Navigator Rust host。

生成的 Profile 清单是 lockfile 组合快照。Profile patch 或上游 pin 变化时必须重新生成，不能把它作为运行成功证据。

## 上游补丁策略

Navigator 将改动保留在仓库自有 Cordis 插件和客户端扩展中。对上游 Harness 的修改应向上游提议，或作为明确且可审查的适配器保留；不得隐藏在安装脚本中。
