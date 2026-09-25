# Navigator Harness adoption / Harness 接入

Navigator composes a pinned DeepSeek Harness runtime with an out-of-tree Cordis bundle. Cyrene owns persistence, Product integration, and desktop client integration; upstream owns the Agent Loop and Session event model. The repository's current desktop surfaces remain source-preview/unpackaged until their release gates are complete.

Navigator 使用固定版本的上游运行时，通过独立 Bundle 接入 Cyrene。该目录中存在代码不代表 adoption proof 已通过；浏览器与原生桌面当前仍是源代码预览/未打包交付面，实际验收以 Workspace 的 V1 清单和可重跑证据为准。

| Path | Responsibility / 职责 |
| --- | --- |
| `upstream.lock.json` | Exact source, dependency-lock hashes and patch ledger / 精确上游与补丁清单 |
| `package.json` | Out-of-tree bundle exports / 独立 Bundle |
| `cordis.patch.yml` | Navigator's plugin composition / 插件组合 |
| `src/` | Thin Harness adapters / 薄适配层 |
| `tsconfig.json` | Strict compilation against upstream types / 直接使用上游类型 |

Read the upstream lock first, then the bundle and adapter sources. The bootstrap script verifies the upstream tree and uses its exact dependency lock because the selected prerelease is not yet available from npm. It does not patch upstream Core.

The [adoption ledger](../docs/adoption/README.md) records observed plugin states,
compatibility boundaries, known limits and the consumer build adaptation.

先阅读上游锁文件，再阅读 Bundle 和适配器。指定预发布版本目前没有对应 npm 包，构建使用已固定源码及原始依赖锁文件。通用运行时不在本目录重新实现。

The pinned Session Controller declarations reference `dsh-util-values` without
declaring that package dependency. The consumer's TypeScript path maps that
reference to the same pinned package prepared by the bootstrap. This is a
consumer build adaptation; upstream source and runtime code remain unchanged.

固定版本的 Session Controller 类型声明缺少 `dsh-util-values` 依赖声明。消费者的
TypeScript path 指向 bootstrap 已链接的同一固定包，保留严格类型检查，不改上游
源码或运行时代码。上游补齐声明后即可移除此映射。

## Fresh Host and browser build / Host 与浏览器端新鲜构建

The Host adapters and the browser client are separate strict TypeScript
programs. `tsconfig.json` compiles `harness/src/**/*.ts` while excluding the
browser directory and includes Node environment types. `tsconfig.client.json`
compiles only `harness/src/client/**/*.ts` with the DOM library and no Node
environment types. Keeping these programs separate prevents the browser
artifact from importing aggregate Host/Client Cordis declarations or creating a
second Session library.

Host 适配层和浏览器客户端是两个独立的 strict TypeScript 程序。
`tsconfig.json` 编译 `harness/src/**/*.ts`（排除浏览器目录）并使用 Node 环境类型；
`tsconfig.client.json` 只编译 `harness/src/client/**/*.ts`，使用 DOM library 且不包含
Node 环境类型。分开编译可以避免浏览器产物导入聚合的 Host/Client Cordis 声明，
也避免建立第二套 Session library。

Start from a clean generated output directory on every platform. Set
`DSH_ROOT` to the clean checkout at the exact pinned commit. If that checkout
has not been prepared yet, run `prepare-harness.mjs` with
`--install --build --link`; for an already installed and built exact checkout,
`--link` is enough.
Then compile both programs and generate the Loader client:

每个平台都要从干净的生成目录开始。将 `DSH_ROOT` 设置为精确 pin 且干净的上游
checkout。若该 checkout 尚未准备，使用 `prepare-harness.mjs` 的
`--install --build --link`；已经安装并构建过的精确 checkout 可只使用 `--link`。
随后分别编译两个程序并生成 Loader client：

```bash
rm -rf harness/dist
node scripts/prepare-harness.mjs --root "$DSH_ROOT" --link
"$DSH_ROOT/node_modules/typescript/bin/tsc" -p harness/tsconfig.json --pretty false
"$DSH_ROOT/node_modules/typescript/bin/tsc" -p harness/tsconfig.client.json --pretty false
node scripts/windows/build-harness-client.mjs --root "$PWD"
```

The same sequence is required on Windows with the approved Node runtime; use
`Remove-Item harness/dist -Recurse -Force` before compiling and invoke `tsc`
and `build-harness-client.mjs` through that Node executable. The final
`harness/dist/client.js` is a generated DSH Loader artifact, not a source entry
point and must never be used as evidence that the installed desktop application
was tested.

Windows 也必须执行同一顺序并使用批准的 Node runtime；编译前执行
`Remove-Item harness/dist -Recurse -Force`，再通过该 Node executable 调用 `tsc`
和 `build-harness-client.mjs`。最终的 `harness/dist/client.js` 是生成的 DSH Loader
产物，不是源码入口，也不能用来证明已测试安装后的桌面应用。
---
<!-- Chinese Translation / 中文翻译 -->

## 上游锁文件与构建适配

应先阅读上游锁文件，再阅读 bundle 和适配器源码。bootstrap 脚本会验证上游树，并使用其精确依赖锁，因为当前选择的预发布版本尚未发布到 npm。脚本不会修改上游 Core。

固定版本的 Session Controller 声明引用 `dsh-util-values`，但没有声明该包依赖。消费者的 TypeScript path 将该引用映射到 bootstrap 准备的同一个固定包。这是消费者构建适配；上游源码和运行时代码保持不变。上游补齐声明后即可移除此映射。
