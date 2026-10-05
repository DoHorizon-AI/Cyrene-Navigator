# Local Navigator service stack / 本地 Navigator 服务栈

`scripts/serve-local.py` supervises the SQLite persistence service, the DSH
executor, and the paired Web Host on one machine. The SQLite database,
attachments, DSH home, and plugin directory live under `--state-dir`; restarting
the supervisor rotates its in-memory service credentials but keeps that data.
One supervisor owns a state directory at a time; a nonblocking OS file lock
rejects a second launch until the first stack has shut down. Configure optional
host-owned integrations with `CYRENE_SUBAGENT_CONFIG` and
`CYRENE_CLOUD_PROFILE_CONFIG` JSON paths. The launcher validates these files,
passes their paths to the executor, and forwards only environment names listed
in their `envRefs` or `headerEnvRefs`. `CYRENE_WORKFLOWS_ENABLED=true|false`
overrides the default workflow composition. These integration values go only to
the Node executor, never the persistence or Web Host child.
The session principal token is generated when its selected environment reference
is absent; an explicitly supplied value is reused so a separately managed
trusted connector can authenticate with the same reference. The executor token
is always generated internally.
Only the Web Host accepts a configurable bind address. The default is
`127.0.0.1`; bind to a remote interface only when explicitly required.

`scripts/serve-local.py` 在同一台机器上监督 SQLite 持久化服务、DSH executor 和配对的 Web
Host。SQLite 数据库、附件、DSH home 和插件目录都保存在 `--state-dir` 下；重启 supervisor
会轮换只驻留内存的服务凭据，但保留这些数据。若所选环境引用没有值，则生成 session principal
token；若 operator 显式提供了值，则复用该值，供独立管理的可信 connector 使用同一引用认证。
同一 state directory 同时只允许一个 supervisor 持有；非阻塞操作系统文件锁会拒绝第二个启动，
直到首个服务栈关闭。可用 `CYRENE_SUBAGENT_CONFIG` 与 `CYRENE_CLOUD_PROFILE_CONFIG` JSON 路径
配置由宿主管理的可选集成。launcher 会验证文件、将路径传给 executor，并且只转发文件中
`envRefs` 或 `headerEnvRefs` 列出的环境变量。`CYRENE_WORKFLOWS_ENABLED=true|false` 可覆盖默认
workflow 组合。这些集成环境变量只传给 Node executor，不会传给 persistence 或 Web Host 子进程。
executor token 始终由内部生成。只有 Web Host 接受可配置的监听地址，默认值为
`127.0.0.1`；仅在明确需要时才绑定远程网卡。

## Start the local stack / 启动本地服务

Prepare the pinned DSH source and build Navigator's Host adapters with Node
24.13.0 and pnpm 11.7.0. The launcher requires the real Exchange adapter
configuration; obtain its token from the local secret manager and export it in
the supervisor's environment. Do not put credentials in arguments or files.

使用 Node 24.13.0 和 pnpm 11.7.0 准备固定版本的 DSH source，并构建 Navigator Host
adapter。launcher 要求配置真实 Exchange adapter；从本地 secret manager 获取 token，并在
supervisor 环境中导出。不要把凭据放入命令行参数或文件。

```sh
uv sync --frozen --group dev
node scripts/prepare-harness.mjs --root "$CYRENE_DSH_ROOT" --install --build --link
node "$CYRENE_DSH_ROOT/node_modules/typescript/bin/tsc" -p harness/tsconfig.json --pretty false
export CYRENE_EXCHANGE_URL="https://exchange.example.invalid"
export CYRENE_EXCHANGE_TOKEN="<provided by the secret manager>"
export CYRENE_HARNESS_MODEL="<approved model id>"
uv run python scripts/serve-local.py --state-dir "$HOME/.local/share/cyrene-navigator"
```

The process prints one JSON line with the Web Host, persistence, and executor
URLs after all three listeners pass readiness probes. Child logs are discarded
by the supervisor. The one-time pairing code is written to
`<state-dir>/pairing-code`; on POSIX systems the file mode is `0600`. Pair from
the local machine, then remove the file after use. On Windows, keep the state
directory on a user-only ACL because POSIX mode bits are not available there.

三个 listener 通过 readiness probe 后，进程会打印一行包含 Web Host、persistence 和 executor URL
的 JSON。supervisor 会丢弃子进程日志。一次性 pairing code 写入
`<state-dir>/pairing-code`；POSIX 系统上的文件权限为 `0600`。请在本机完成配对后删除该文件。
Windows 不支持 POSIX mode bits，应将 state 目录限制为当前用户可访问。

For a deliberate reverse-proxy or cloud listener, select a fixed port and
provide an externally reachable origin. The Web Host can remain on loopback
behind a same-host proxy, or bind to all IPv4 interfaces explicitly:

```sh
uv run python scripts/serve-local.py \
  --state-dir /data/navigator \
  --host 0.0.0.0 \
  --port 8080 \
  --public-url https://navigator.example.invalid
```

持久化与 executor 仍只绑定 loopback；上述示例显式将 Web Host 绑定到所有 IPv4 网卡。
反向代理部署可改为 `--host 127.0.0.1`，并让同机代理转发到该 listener。

## Optional QQ binding / 可选 QQ binding

The default generated principal has one owner-scoped organization and Workspace
and configures no connector. To enable an optional QQ bridge, install the
Plugins repository's Python reference package and shared runtime into the same
Python environment used by `serve-local.py`:

默认生成的 principal 只拥有一个组织和 Workspace，并且不配置连接器。如需启用可选 QQ bridge，
请将 Plugins 仓库中的 Python reference package 和 shared runtime 安装到 `serve-local.py` 使用的
同一 Python 环境：

```sh
uv pip install --python .venv/bin/python \
  -e ../Cyrene-Plugins-Official/sdk/python/cyrene_plugin_runtime \
  -e ../Cyrene-Plugins-Official/plugins/connectors/im
```

Create an owner-managed principal configuration and pass its path with
`--principal-config`. Set `--principal-token-env` to the owner row's token
reference; the supervisor supplies its fresh internal value through that
environment variable. Other `*_env` and `secret_refs` names in the file are
passed to persistence only when those variables exist in the supervisor's
environment. The config itself contains references, not credential values.

创建由 owner 管理的 principal 配置，并通过 `--principal-config` 传入路径。将
`--principal-token-env` 设为 owner 行的 token reference；supervisor 会通过该环境变量提供新生成的
内部值（若环境已有该引用则沿用其值）。配置中的其他 `*_env` 和 `secret_refs` 名称只会在
supervisor 环境存在对应变量时传给
persistence。配置文件只保存引用，不保存凭据值。

```sh
uv run python scripts/serve-local.py \
  --state-dir "$HOME/.local/share/cyrene-navigator" \
  --workspace-id workspace-id \
  --organization-id organization-id \
  --principal-config /etc/cyrene/navigator-principals.json \
  --principal-token-env CYRENE_NAVIGATOR_OWNER_TOKEN
```

For each `work_connectors` QQ row, configure the exact authorized Host
executable, client version, Host ABI, binding id, account id, and persistent
account data directory. The persistence process fails startup if the optional
`qq_connector` package or its bridge is unavailable. It does not invent a Host
artifact, discover an account, or start an unconfigured client. The current
Python package is a behavioral reference; `qqnt-direct` is Linux x86_64 only,
and a real QR login still requires its exact authorized Host and account.

每条 `work_connectors` QQ 配置都必须给出经过授权的 Host executable、client version、Host ABI、
binding id、account id 和持久账号数据目录。缺少可选 `qq_connector` package 或 bridge 时，
persistence 会拒绝启动。它不会伪造 Host 制品、扫描账号或启动未配置的客户端。当前 Python
package 仅为行为参考；`qqnt-direct` 目前仅支持 Linux x86_64，真实 QR 登录还需要精确授权的 Host
和账号。

A separately managed trusted WeCom process may use the same owner principal
token, but it needs a stable local listener port and the same configured
workspace. Supply its credential through the environment reference selected by
`--principal-token-env`; set `--persistence-port` to a fixed loopback port and
configure the connector's base URL as `http://127.0.0.1:<port>`. The port remains
loopback-only. Do not put the bearer into a URL, command argument, or log. The
default random internal token is intentionally unavailable to an independently
managed process.

独立管理的可信 WeCom 进程可以使用同一 owner principal token，但需要固定的本地 listener port 和
相同的 Workspace。通过 `--principal-token-env` 指定的环境引用提供凭据；将
`--persistence-port` 设为固定 loopback port，并将 connector base URL 配置为
`http://127.0.0.1:<port>`。该 port 仍只监听 loopback。不要把 bearer 放入 URL、命令行参数或日志。
默认随机生成的内部 token 不会提供给独立管理的进程。

The default Docker image does not bundle the optional Plugins package or a QQ
Host executable. Build a reviewed custom image that installs the package and
its shared runtime before using a QQ binding. Mount the owner configuration
and account data only into that image's configured paths. No real QQ, WeCom,
or model-provider operation is implied by a successful container build.

默认 Docker 镜像不包含可选 Plugins package 或 QQ Host executable。启用 QQ binding 前，应构建经过
审查的自定义镜像，并在其中安装 package 和 shared runtime。将 owner 配置和账号数据挂载到该镜像
明确配置的路径。容器构建成功不代表执行了真实 QQ、企业微信或模型服务商操作。
