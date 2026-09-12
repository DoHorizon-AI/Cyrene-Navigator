# Navigator development scripts / Navigator 开发脚本

The scripts bootstrap the exact DeepSeek Harness source, run Navigator's local
persistence service, launch its Profile, enforce repository boundaries, and
build or inspect the unpackaged Windows client. They do not create a signed
installer or checkout/build Platform source.

这些脚本负责精确 Harness 引导、本地持久化、Profile 启动、边界检查以及未打包 Windows
客户端的构建或检查；不会创建已签名安装包，也不会 checkout 或编译 Platform 源码。

| Path | Responsibility / 职责 |
| --- | --- |
| `prepare-harness.mjs` | Verify and prepare the exact upstream Harness / 校验并准备精确上游 |
| `launch-harness.mjs` | Launch the Navigator Profile / 启动 Navigator Profile |
| `serve-persistence.py` | Run the local session authority / 启动本地 Session authority |
| `ci/check-platform-boundary.py` | Reject source coupling and mock release leakage / 阻止源码耦合和 mock 发布泄漏 |
| `windows/build-native-host.ps1` | Build the static Navigator native host / 构建静态原生宿主 |
| `windows/native-imports.mjs` | Verify native-client imports / 验证原生客户端导入 |

The persistence launcher reads credentials only through configured `token_env`
names. Its principal file is a development bootstrap mechanism, not a production
identity provider.
