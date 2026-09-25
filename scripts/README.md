# Navigator development scripts / Navigator 开发脚本

The scripts bootstrap the exact DeepSeek Harness source, run Navigator's local
persistence service, launch its Profile, enforce repository boundaries, and
build or inspect the native process host. They do not own UI packaging or
checkout/build Platform source.

这些脚本负责精确 Harness 引导、本地持久化、Profile 启动、边界检查以及 native process
host 的构建或检查；不负责 UI 打包，也不会 checkout 或编译 Platform 源码。

| Path | Responsibility / 职责 |
| --- | --- |
| `prepare-harness.mjs` | Verify and prepare the exact upstream Harness / 校验并准备精确上游 |
| `launch-harness.mjs` | Launch the Navigator Profile / 启动 Navigator Profile |
| `serve-persistence.py` | Run the local session authority / 启动本地 Session authority |
| `serve-web.py` | Run the authenticated same-origin Web Host / 启动认证同源 Web Host |
| `ci/check-platform-boundary.py` | Reject Platform source coupling and retired Product surfaces / 阻止 Platform 源码耦合与已迁出 Product 表面 |
| `windows/build-native-host.ps1` | Build the static Navigator native host / 构建静态原生宿主 |
| `windows/native-imports.mjs` | Verify native-host imports / 验证 native host 导入 |

The persistence launcher reads credentials only through configured `token_env`
names. Its principal file is a development bootstrap mechanism, not a production
identity provider.
---
<!-- Chinese Translation / 中文翻译 -->

## 凭据边界

持久化启动器只通过配置的 `token_env` 名称读取凭据。principal 文件只是开发环境的引导机制，不是生产身份提供方。
