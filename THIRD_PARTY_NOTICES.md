# Third-party notices / 第三方声明

Navigator source is licensed under the Apache License 2.0 in [`LICENSE`](LICENSE).
Dependencies, upstream source, SDKs, and generated runtime artifacts keep
their own licenses. This file records the direct manifests and the pinned
dependency boundaries audited on 2026-09-12; it is not a replacement for the
license text shipped by each dependency.

Navigator 源代码按 [`LICENSE`](LICENSE) 中的 Apache License 2.0 授权。依赖、上游源码、
SDK 和生成的运行时产物仍受其自身许可证约束。本文件记录 2026-09-12 审计的直接
manifest 与锁定边界；它不替代各依赖随包提供的许可证原文。

## Python / Python 依赖

Runtime dependencies are pinned in `pyproject.toml` and resolved in `uv.lock`:

| Package | Version | License | Upstream / license source |
| --- | ---: | --- | --- |
| FastAPI | 0.141.1 | MIT | <https://github.com/fastapi/fastapi> |
| HTTPX | 0.28.1 | BSD-3-Clause | <https://github.com/encode/httpx> |
| Pydantic | 2.13.5 | MIT | <https://github.com/pydantic/pydantic> |
| Uvicorn | 0.52.4 | BSD-3-Clause | <https://github.com/encode/uvicorn> |

The locked development group additionally contains `jsonschema` 4.26.0 (MIT),
`mypy` 2.3.1 (MIT), `openapi-spec-validator` 0.9.0 (Apache-2.0), `pytest` 9.1.1
(MIT), and `ruff` 0.16.5 (MIT). `uv.lock` contains the complete resolved
Python graph, including transitive packages such as Starlette, AnyIO,
Pydantic-Core, HTTP Core, certifi, idna, jsonschema-path, referencing, and
their platform-specific dependencies. The lockfile, not this summary table,
is the version authority.

Python runtime 与开发依赖由 `pyproject.toml` 声明并在 `uv.lock` 中解析。开发组还包括
`jsonschema` 4.26.0（MIT）、`mypy` 2.3.1（MIT）、`openapi-spec-validator` 0.9.0
（Apache-2.0）、`pytest` 9.1.1（MIT）和 `ruff` 0.16.5（MIT）。`uv.lock` 保存完整解析图，
包括 Starlette、AnyIO、Pydantic-Core、HTTP Core、certifi、idna、jsonschema-path、
referencing 及平台依赖；版本以 lockfile 为准。

## DeepSeek Harness and Cordis / DeepSeek Harness 与 Cordis

Navigator does not vendor the upstream Harness tree. `harness/upstream.lock.json`
pins:

| Component | Exact source | License |
| --- | --- | --- |
| DeepSeek Harness source and `@deepseek-ai/dsh-*` packages | `deepseek-ai/deepseek-harness`, tag `dsh-v0.1.3-alpha.1`, commit `d347e703908d0406b7a7ef80e3a0e594d86b2215` | MIT, Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/cordis` peer package | 4.0.2, declared in `harness/package.json` and composed by `harness/cordis.patch.yml` | MIT |

The upstream root license and package metadata at the pinned commit are the
authoritative notices. The upstream `pnpm-lock.yaml` and `package.json` hashes
are recorded in `harness/upstream.lock.json`; `scripts/prepare-harness.mjs`
fetches that exact source into a temporary checkout and does not copy it into
this repository. Any generated Harness distribution must carry the upstream MIT
notice and the complete license inventory from that exact checkout.

Navigator 不内置上游 Harness 源码。`harness/upstream.lock.json` 固定上游仓库、tag、commit
以及 `pnpm-lock.yaml`、`package.json` 哈希。上游许可证与该 commit 的 package metadata 是
权威来源；`scripts/prepare-harness.mjs` 将精确源码拉取到临时 checkout，不复制进本仓库。
任何生成的 Harness 分发物都必须保留上游 MIT 声明，并生成该精确 checkout 的完整许可证清单。

The `private: true` field in the Harness package manifest prevents accidental
npm publication. It does not describe GitHub repository visibility.

Harness package manifest 中的 `private: true` 只防止误发布到 npm，不表示 GitHub 仓库
私有。

## Optional external Antigravity ACP runtime / 可选外部 Antigravity ACP runtime

The opt-in Navigator executor image may download Google's official Antigravity
ACP Linux x86_64 or ARM64 release `1.4.5` at image build time. Each archive contains two
required executables that remain adjacent at runtime:

| File | SHA-256 |
| --- | --- |
| `agy-acp-server-1.4.5-linux-x86_64.zip` | `923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b` |
| `agy-acp-server-1.4.5-linux-arm64.zip` | `7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056` |
| `agy_acp_server.par` from x86_64 archive | `7e7019c8989ca066cbac4d6580552b7a4ad39485dd6b6fd81de9daa9a7b39042` |
| `localharness_external` from x86_64 archive | `6c6d28b61a704e9bae4351ea8c4ad4b8b0aba7e1f1027bdf1017401b9c6e18c0` |

The release archives are downloaded from Google's official Linux release paths for [x86_64](https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-x86_64.zip) and [ARM64](https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-arm64.zip); see the [ACP Registry entry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json) for distribution metadata. The extracted-file hashes above were measured from the x86_64 archive only; the ARM64 archive hash is pinned, and its ZIP was checked for the two required sibling executables, but their extracted hashes were not independently measured. Google's terms are at <https://antigravity.google/terms>. The Registry marks the provider distribution proprietary. The binaries are not vendored in this source tree. This provenance notice does not grant redistribution rights or imply account eligibility, service entitlement, or billing behavior.

可选 Navigator executor 镜像可在构建时下载 Google 官方 Antigravity ACP Linux x86_64 或 ARM64 `1.4.5`
release。每个 archive 均含两个运行时必须保持同目录的可执行文件：

| 文件 | SHA-256 |
| --- | --- |
| `agy-acp-server-1.4.5-linux-x86_64.zip` | `923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b` |
| `agy-acp-server-1.4.5-linux-arm64.zip` | `7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056` |
| x86_64 archive 中的 `agy_acp_server.par` | `7e7019c8989ca066cbac4d6580552b7a4ad39485dd6b6fd81de9daa9a7b39042` |
| x86_64 archive 中的 `localharness_external` | `6c6d28b61a704e9bae4351ea8c4ad4b8b0aba7e1f1027bdf1017401b9c6e18c0` |

release archive 来自 Google 官方 Linux 发布地址：[x86_64](https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-x86_64.zip) 和
[ARM64](https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-arm64.zip)；分发元数据见
[ACP Registry 条目](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)。
上面的解压文件哈希仅从 x86_64 archive 实测；ARM64 archive 哈希已固定，ZIP 中的两个同目录可执行文件已确认存在，
但未单独测量其解压哈希。Google 服务条款见 <https://antigravity.google/terms>。Registry 将该 provider
distribution 标记为 proprietary；这些 binary 不纳入本源码树。本来源声明不授予再分发权，也不代表账号资格、
服务 entitlement 或计费行为。

## Rust / Rust 依赖

`native/Cargo.toml` directly uses `hex` 0.4.3, `serde` 1.0.229,
`serde_json` 1.0.151, and `sha2` 0.10.9. These crates and the resolved
`native/Cargo.lock` graph are permissively licensed under MIT or Apache-2.0
(dual-license expressions where published by the crate). The lock also records
the transitive digest, crypto-common, generic-array, typenum, libc, proc-macro,
and platform support crates. Cargo's package metadata and each crate's bundled
license file remain authoritative.

`native/Cargo.toml` 直接使用 `hex` 0.4.3、`serde` 1.0.229、`serde_json` 1.0.151 和
`sha2` 0.10.9。它们及 `native/Cargo.lock` 中解析出的依赖图按各 crate 发布的 MIT 或
Apache-2.0 双许可证表达授权。lockfile 还记录 digest、crypto-common、generic-array、
typenum、libc、proc-macro 和平台支持 crate；最终以 Cargo metadata 与 crate 随附许可证为准。

## Reproducible inventory and SBOM boundary / 可复现清单与 SBOM 边界

This repository does not currently commit a generated SBOM. The upstream
Harness checkout is intentionally fetched into a temporary cache, so a
source-only scan cannot claim to enumerate its contents. Before a binary or
package release, run the following from a
clean checkout at the release SHA after restoring every target:

本仓库当前未提交生成的 SBOM。上游 Harness checkout 有意放在临时目录，因此只扫描源码
不能声称已经穷尽其内容。二进制或 package 发布前，请在
发布 SHA 的干净 checkout 中完成各目标 restore 后运行以下清单步骤：

```bash
set -euo pipefail
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

git rev-parse HEAD > "$OUT_DIR/repository.sha"
sha256sum uv.lock native/Cargo.lock harness/upstream.lock.json \
  > "$OUT_DIR/lockfile-sha256.txt"

uv sync --frozen --group dev
uv export --locked --all-groups --format requirements.txt > "$OUT_DIR/python-requirements.txt"

cargo metadata --manifest-path native/Cargo.toml --locked --format-version 1 \
  > "$OUT_DIR/native-cargo-metadata.json"
cargo tree --manifest-path native/Cargo.toml --locked \
  > "$OUT_DIR/native-cargo-tree.txt"

# Optional, when the pinned release tool is available:
syft dir:. --scope all-layers -o cyclonedx-json="$OUT_DIR/cyrene-navigator.cdx.json"
```

For license text, inspect package metadata and bundled license files for every
entry in the generated trees. For a binary distribution, the SBOM must also
cover the exact temporary Harness checkout and native output. The repository's current hosted workflows do
not publish an SBOM, so this remains a release gate rather than a claim that the
source tree is already an exhaustive binary inventory.

对于生成树中的每项依赖，请进一步检查 package metadata 与随包许可证原文。二进制分发的
SBOM 还必须覆盖精确的临时 Harness checkout 与 native 输出。当前 Hosted workflow 不发布
SBOM，因此上述步骤是发布 gate，而不是声称当前
源码树已经完成穷尽的二进制清单。

## No bundled proprietary data / 不包含私有数据

The first-party Exchange consumer snapshot is pinned to merge
`2264a5392f5f188b958e660052f55e087922cefa` in its contract lock. This contract-only
update adds no third-party implementation or runtime dependency.

第一方 Exchange 消费者契约快照已在契约锁文件中固定到合并提交
`2264a5392f5f188b958e660052f55e087922cefa`。此次契约更新未增加第三方实现或运行依赖。

No customer credentials, personal profiles, or private service endpoints are
part of the intended distribution. Demo fixtures use reserved `example.invalid`
domains and neutral identities. If a generated screenshot contains a real
identity or private environment label, remove it from the distribution and
regenerate it only from sanitized fixtures.

预期分发物不包含客户凭据、个人资料或私有服务端点。演示 fixture 使用保留的
`example.invalid` 域名和中性身份。若生成截图包含真实身份或私有环境标签，应从分发物中
删除，并且只能使用清理后的 fixture 重新生成。
