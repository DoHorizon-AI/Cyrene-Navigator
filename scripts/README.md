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
| `serve-persistence.py` | Run persistence and the internal Product snapshot adapter / 启动持久化与内部 Product snapshot 适配器 |
| `serve-web.py` | Run the authenticated same-origin Web Host / 启动认证同源 Web Host |
| `serve-local.py` | Supervise persistent same-host services with generated internal credentials / 监督同机持久服务并生成内部凭据 |
| `ci/check-platform-boundary.py` | Reject Platform source coupling and retired Product surfaces / 阻止 Platform 源码耦合与已迁出 Product 表面 |
| `windows/build-native-host.ps1` | Build the static Navigator native host / 构建静态原生宿主 |
| `windows/native-imports.mjs` | Verify native-host imports / 验证 native host 导入 |

The persistence launcher reads credentials only through configured `token_env`
names. The same runner also mounts `POST /api/v1/workspace-snapshots` on the
same listener. Owner URLs use `base_url_env`; downstream Bearers use exact
`product + organization_id + workspace_id + token_env` entries. Missing owner
configuration returns 503 before an upstream call. The default listener is
loopback, and this script does not change cloud ingress. Its principal file is a
development bootstrap mechanism, not a production identity provider.

`serve-local.py` starts persistence, the executor, and the paired Web Host as a
single supervised stack. It keeps SQLite, attachments, `DSH_HOME`, and the
plugin directory under `--state-dir`, and keeps generated credentials in child
environment variables. Its default generated principal has no connector
binding. Optional QQ bridges require an explicit owner `--principal-config` and
an installed `qq_connector` package; see [`local-stack.md`](../docs/operations/local-stack.md).

For the Client's first-party Exchange API calls, `serve-web.py` accepts
`--proxy-product-auth /api/v1/exchange` only when that exact prefix is registered
with `--proxy /api/v1/exchange=ORIGIN`. The origin must be HTTPS, except for
loopback HTTP during local development. The Client supplies the personal bearer
and Workspace selector per request using `X-Cyrene-Product-Authorization` and
`X-Cyrene-Workspace-Id`; Web Host forwards them only to the fixed Exchange
integration and account-renewal routes. The Web Host session remains required,
mutations retain CSRF checks, and static proxy credentials cannot authorize these
routes. Other target/path requests cannot receive the dedicated bearer. See
[`local-stack.md`](../docs/operations/local-stack.md) for the full boundary.
---
<!-- Chinese Translation / 中文翻译 -->

## 凭据边界

持久化启动器只通过配置的 `token_env` 名称读取凭据；同一 runner 还会在同一 listener 上挂载
`POST /api/v1/workspace-snapshots`。owner URL 使用 `base_url_env`，下游 Bearer 按精确的
`product + organization_id + workspace_id + token_env` 配置。缺少 owner 配置时会在上游请求前返回 503。
默认只监听 loopback，本脚本不会修改云 ingress。principal 文件只是开发环境的引导机制，不是生产身份提供方。

`serve-local.py` 将 persistence、executor 和配对 Web Host 作为一个服务栈监督运行。SQLite、附件、
`DSH_HOME` 与插件目录都保存在 `--state-dir` 下，生成的凭据只通过子进程环境变量传递。默认生成的
principal 不配置连接器。可选 QQ bridge 要求显式提供 owner `--principal-config`，并安装
`qq_connector` package；参见 [`local-stack.md`](../docs/operations/local-stack.md)。

Client 的 first-party Exchange API 请求可通过 `serve-web.py` 显式启用
`--proxy-product-auth /api/v1/exchange`，但必须同时以
`--proxy /api/v1/exchange=ORIGIN` 注册完全相同的前缀。origin 必须使用 HTTPS；本地开发时才允许
loopback HTTP。Client 按请求通过 `X-Cyrene-Product-Authorization` 和 `X-Cyrene-Workspace-Id` 提供个人
bearer 与 Workspace selector；Web Host 只将它们转发到固定 Exchange integrations 和账户续期路由。
Web Host session 仍是必需条件，写操作继续校验 CSRF，静态代理凭据不能为这些路由授权。其他 target
或 path 不会收到该专用 bearer。完整边界参见
[`local-stack.md`](../docs/operations/local-stack.md)。
