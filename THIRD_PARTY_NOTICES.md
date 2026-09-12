# Third-party notices / 第三方声明

Navigator source is licensed under the Apache License 2.0 in [`LICENSE`](LICENSE).
Dependencies, upstream source, fonts, SDKs, and generated runtime artifacts keep
their own licenses. This file records the direct manifests and the pinned
dependency boundaries audited on 2026-09-12; it is not a replacement for the
license text shipped by each dependency.

Navigator 源代码按 [`LICENSE`](LICENSE) 中的 Apache License 2.0 授权。依赖、上游源码、
字体、SDK 和生成的运行时产物仍受其自身许可证约束。本文件记录 2026-09-12 审计的直接
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

## Browser npm graph / 浏览器 npm 依赖

`apps/desktop/package.json` declares `@types/node` 22.15.30 (MIT), TypeScript
5.9.3 (Apache-2.0), and Vite 6.4.3 (MIT). The committed
`apps/desktop/pnpm-lock.yaml` also resolves Vite's transitive graph, including
esbuild (MIT), Rollup (MIT), PostCSS (MIT), picocolors (ISC), and platform
optional packages. All versions and optional platform packages are governed by
that lockfile; the exact installed graph must be regenerated for a distribution
build.

`apps/desktop/package.json` 声明 `@types/node` 22.15.30（MIT）、TypeScript 5.9.3
（Apache-2.0）和 Vite 6.4.3（MIT）。提交的 `apps/desktop/pnpm-lock.yaml` 还解析 Vite 的传递
依赖，包括 esbuild（MIT）、Rollup（MIT）、PostCSS（MIT）、picocolors（ISC）以及平台可选包。
所有版本和平台可选包以该 lockfile 为准；分发构建必须重新生成精确安装图。

The `private: true` fields in the Harness and WebUI package manifests only
prevent accidental npm publication. They do not make the GitHub repository
private and are intentionally retained.

Harness 与 WebUI package manifest 中的 `private: true` 只防止误发布到 npm，不表示 GitHub
仓库私有，故有意保留。

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

## .NET, Windows App SDK, and WinUI / .NET、Windows App SDK 与 WinUI

The Windows project directly references:

| Package | Version | License / terms |
| --- | ---: | --- |
| `Microsoft.WindowsAppSDK` | 1.8.260804001 | Microsoft Windows App SDK Software License Terms, package `license.txt` |
| `Microsoft.Windows.SDK.BuildTools` | 10.0.26100.9169 | Microsoft Windows SDK license terms, <https://aka.ms/WinSDKLicenseURL> |

The resolved Windows App SDK graph also contains `Microsoft.WindowsAppSDK.AI`
1.8.79, `Base` 1.8.251216001, `DWrite` 1.8.25122902, `Foundation`
1.8.260803002, `InteractiveExperiences` 1.8.260708001, `ML` 1.8.2197,
`Runtime` 1.8.260804001, `Widgets` 1.8.251231004, `WinUI` 1.8.260803003,
`Microsoft.Web.WebView2` 1.0.3179.45, `Microsoft.Windows.SDK.BuildTools.MSIX`
1.7.20250829.1, and `System.Numerics.Tensors` 9.0.0 (MIT). Windows App SDK
and SDK BuildTools packages carry Microsoft license files/EULAs rather than an
SPDX expression in the project manifest. Do not redistribute their package
payloads without reviewing the exact license files from the restored package
cache and the Windows runtime's own terms.

`Microsoft.Web.WebView2` 1.0.3179.45 carries a BSD-3-Clause-style `LICENSE.txt`
in its package. The restored package's license file is the authoritative text
for any distribution that includes the WebView2 payload.

Windows 工程直接引用 `Microsoft.WindowsAppSDK` 1.8.260804001 与
`Microsoft.Windows.SDK.BuildTools` 10.0.26100.9169。解析出的 Windows App SDK 图还包括
上述 AI、Base、DWrite、Foundation、InteractiveExperiences、ML、Runtime、Widgets、WinUI、
WebView2、BuildTools.MSIX 与 `System.Numerics.Tensors` 9.0.0（MIT）。Windows App SDK 与
SDK BuildTools 随包提供 Microsoft license/EULA，而不是 manifest 中的 SPDX 表达。分发其
payload 前必须检查精确 restore package cache 的许可证以及 Windows runtime 自身条款。

## Space Grotesk / Space Grotesk 字体

`apps/windows/build.ps1 -Fonts` optionally downloads Space Grotesk from Google
Fonts. The font is not vendored in this repository; it is distributed by its
authors under the SIL Open Font License 1.1:
<https://scripts.sil.org/OFL>. Without the optional download the client uses
the system Segoe UI Variable Display fallback. A future packaged build must
ship the OFL text and font attribution alongside the font files.

`apps/windows/build.ps1 -Fonts` 会从 Google Fonts 可选下载 Space Grotesk。本仓库不内置字体；
字体按作者的 SIL Open Font License 1.1 发布，详见 <https://scripts.sil.org/OFL>。未下载时
客户端使用系统 Segoe UI Variable Display fallback。未来打包分发必须将 OFL 原文与字体归属
和字体文件一同提供。

## Reproducible inventory and SBOM boundary / 可复现清单与 SBOM 边界

This repository does not currently commit a generated SBOM. The upstream
Harness checkout and Windows NuGet packages are intentionally fetched into
temporary or user caches, so a source-only scan cannot claim to enumerate their
binary contents. Before a binary or package release, run the following from a
clean checkout at the release SHA after restoring every target:

本仓库当前未提交生成的 SBOM。上游 Harness checkout 与 Windows NuGet 包有意放在临时目录或
用户缓存中，因此只扫描源码不能声称已经穷尽二进制内容。二进制或 package 发布前，请在
发布 SHA 的干净 checkout 中完成各目标 restore 后运行以下清单步骤：

```bash
set -euo pipefail
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

git rev-parse HEAD > "$OUT_DIR/repository.sha"
sha256sum uv.lock apps/desktop/pnpm-lock.yaml native/Cargo.lock harness/upstream.lock.json \
  > "$OUT_DIR/lockfile-sha256.txt"

uv sync --frozen --group dev
uv export --locked --all-groups --format requirements.txt > "$OUT_DIR/python-requirements.txt"

pnpm --dir apps/desktop install --frozen-lockfile
pnpm --dir apps/desktop list --depth Infinity --json > "$OUT_DIR/desktop-npm-tree.json"

cargo metadata --manifest-path native/Cargo.toml --locked --format-version 1 \
  > "$OUT_DIR/native-cargo-metadata.json"
cargo tree --manifest-path native/Cargo.toml --locked \
  > "$OUT_DIR/native-cargo-tree.txt"

dotnet restore apps/windows/src/Cyrene.Navigator.Windows/Cyrene.Navigator.Windows.csproj \
  -p:EnableWindowsTargeting=true
dotnet msbuild apps/windows/src/Cyrene.Navigator.Windows/Cyrene.Navigator.Windows.csproj \
  -getItem:PackageReference -getProperty:TargetFramework,RuntimeIdentifier \
  -p:EnableWindowsTargeting=true > "$OUT_DIR/windows-nuget-direct.json"
python3 - "$OUT_DIR/windows-nuget-tree.txt" <<'PY'
import json
import sys
from pathlib import Path

assets = json.loads(Path(
    "apps/windows/src/Cyrene.Navigator.Windows/obj/project.assets.json"
).read_text())
with Path(sys.argv[1]).open("w", encoding="utf-8") as output:
    for target_name, packages in sorted(assets.get("targets", {}).items()):
        for package_name, package in sorted(packages.items()):
            dependencies = ",".join(sorted(package.get("dependencies", {})))
            output.write(f"{target_name}\t{package_name}\t{dependencies}\n")
PY

# Optional, when the pinned release tool is available:
syft dir:. --scope all-layers -o cyclonedx-json="$OUT_DIR/cyrene-navigator.cdx.json"
```

For license text, inspect package metadata and bundled license files for every
entry in the generated trees. For a binary distribution, the SBOM must also
cover the exact temporary Harness checkout, restored NuGet cache, native output,
and the downloaded font archive. The repository's current hosted workflows do
not publish an SBOM, so this remains a release gate rather than a claim that the
source tree is already an exhaustive binary inventory.

对于生成树中的每项依赖，请进一步检查 package metadata 与随包许可证原文。二进制分发的
SBOM 还必须覆盖精确的临时 Harness checkout、restore 后的 NuGet cache、native 输出和下载
的字体压缩包。当前 Hosted workflow 不发布 SBOM，因此上述步骤是发布 gate，而不是声称当前
源码树已经完成穷尽的二进制清单。

The Windows project does not yet commit a `packages.lock.json`; NuGet's
transitive resolution is therefore an output of the restore command and must be
captured in the release evidence (or promoted to a reviewed lockfile) before a
binary release is called reproducible.

Windows 工程目前尚未提交 `packages.lock.json`；NuGet 传递依赖解析是 restore 命令的输出，
因此在宣称二进制发布可复现前，必须将其纳入 release evidence，或提升为经过审查的 lockfile。

## No bundled proprietary data / 不包含私有数据

No customer credentials, personal profiles, or private service endpoints are
part of the intended distribution. Demo fixtures use reserved `example.invalid`
domains and neutral identities. If a generated screenshot contains a real
identity or private environment label, remove it from the distribution and
regenerate it only from sanitized fixtures.

预期分发物不包含客户凭据、个人资料或私有服务端点。演示 fixture 使用保留的
`example.invalid` 域名和中性身份。若生成截图包含真实身份或私有环境标签，应从分发物中
删除，并且只能使用清理后的 fixture 重新生成。
