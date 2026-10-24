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

## Persistence HTTPS / 持久化 HTTPS

The persistence launcher serves HTTPS when both
`CYRENE_PERSISTENCE_TLS_CERT_FILE` and `CYRENE_PERSISTENCE_TLS_KEY_FILE` name
absolute readable certificate and private-key files. Set both or leave both
unset; partial, unreadable, malformed, or mismatched pairs fail startup before
the listener is advertised. The local supervisor preserves the reported
`http` or `https` scheme when building backend URLs and passes the key pair only
to the persistence child.

Configure `SSL_CERT_FILE` as a PEM bundle containing the system roots and the
private internal root for Python HTTPX clients. Set `NODE_EXTRA_CA_CERTS` to the
internal root for the Node executor. Do not replace the public CA bundle with a
private-root-only file when the same process also connects to public services.
For the cloud Compose stack, the persistence URL is
`https://navigator-persistence:8080` and the certificate must cover that DNS
name.

当 `CYRENE_PERSISTENCE_TLS_CERT_FILE` 和 `CYRENE_PERSISTENCE_TLS_KEY_FILE` 同时指向绝对路径、可读的
证书与私钥文件时，persistence launcher 会启用 HTTPS。必须同时设置两个变量，或都不设置；只设置一个、文件
不可读、格式错误或证书与私钥不匹配时，会在公布监听地址前拒绝启动。local supervisor 会保留启动回执中的
`http` 或 `https` scheme，并且只向 persistence 子进程传递证书与私钥路径。

将 `SSL_CERT_FILE` 设置为 PEM 信任 bundle，其中同时包含系统根证书和私有内部根证书，供 Python HTTPX
客户端使用。为 Node executor 设置指向内部根证书的 `NODE_EXTRA_CA_CERTS`。若同一进程还会访问公共服务，
不要用仅含私有根证书的文件替换公共 CA bundle。云端 Compose persistence URL 为
`https://navigator-persistence:8080`，服务器证书必须覆盖此 DNS 名称。

## First-party Exchange API proxy / First-party Exchange API 代理

`scripts/serve-web.py` can opt one registered Exchange proxy into request-scoped
first-party Product authorization. Configure the fixed prefix at the Exchange
origin (without an API path) and enable that exact prefix:

```sh
uv run python scripts/serve-web.py \
  --proxy "/api/v1/exchange=${CYRENE_EXCHANGE_PRODUCT_URL}" \
  --proxy-product-auth /api/v1/exchange
```

The Client sends a personal Platform user bearer in
`X-Cyrene-Product-Authorization: Bearer …` and selects its Workspace with
`X-Cyrene-Workspace-Id`. The Web Host forwards these values only for Exchange
integration routes and the current account-renewal routes; the bearer becomes
the upstream `Authorization` header. Exchange verifies the user and Workspace
membership. The Web Host still requires its paired session and CSRF token for
mutations. A browser `Authorization` or cookie is never treated as a Product
identity.

Product authorization is opt-in, is not persisted by Navigator, and cannot use
a configured proxy credential as a fallback. Use HTTPS for remote Exchange
origins; HTTP is accepted only for a loopback target. Redirects are blocked on
these requests so a personal bearer cannot follow an origin change. The same
Exchange prefix keeps its existing model/gateway proxy behavior when no
dedicated Product authorization header is present. Do not send that dedicated
header on model, gateway, or other proxy routes.

`scripts/serve-web.py` 可在一个已注册的 Exchange 代理上显式启用按请求转发的 first-party
Product authorization。固定代理前缀应指向 Exchange origin（不包含 API 路径），并启用同一个前缀：

```sh
uv run python scripts/serve-web.py \
  --proxy "/api/v1/exchange=${CYRENE_EXCHANGE_PRODUCT_URL}" \
  --proxy-product-auth /api/v1/exchange
```

Client 将个人 Platform 用户 bearer 放在
`X-Cyrene-Product-Authorization: Bearer …` 中，并通过
`X-Cyrene-Workspace-Id` 选择 Workspace。Web Host 只为 Exchange integrations 路由和当前账户续期
路由转发这些值，并将 bearer 转为上游 `Authorization`。Exchange 会验证用户身份与 Workspace 成员关系。
写操作仍要求已配对的 Web Host session 和 CSRF token；浏览器 `Authorization` 或 cookie 不会被视为
Product 身份。

Product authorization 默认关闭，不由 Navigator 持久化，也不会回退到已配置的代理凭据。远程
Exchange origin 必须使用 HTTPS；HTTP 仅允许 loopback target。这些请求会阻止重定向，避免个人 bearer
跟随 origin 变化。同一 Exchange 前缀在没有专用 Product authorization header 时仍保留现有模型/gateway
代理行为。不要在模型、gateway 或其他代理路由上发送该专用 header。

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
# Optional: typed issue tools for this single-user local CLI session.
export CYRENE_EXCHANGE_INTEGRATION_URL="https://exchange.example.invalid"
export CYRENE_EXCHANGE_INTEGRATION_SESSION_ID="<exact active DSH session id>"
export CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN="<current first-party user bearer>"
uv run python scripts/serve-local.py --state-dir "$HOME/.local/share/cyrene-navigator"
```

The launcher binds this Bearer to the exact configured DSH session and
Workspace. It reads the token for each tool call and sends it only to
Exchange's user API. Keep it separate from `CYRENE_EXCHANGE_TOKEN`, which
authenticates model inference. Multi-user and cloud hosts must inject a
session-bound `trustedUserBearerProvider`; there is no process-token fallback.
The local CLI does not implement the Client's session-bound Control bridge, so
this integration option still requires an externally supplied current-user
Bearer. The CLI never writes it to Navigator's database.

launcher 会将此 Bearer 绑定到精确配置的 DSH Session 与 Workspace。token 在每次工具调用时读取，
且只发送到 Exchange 用户 API。它必须与用于模型推理认证的 `CYRENE_EXCHANGE_TOKEN` 分开。
多用户与云宿主必须注入绑定到 Session 的 `trustedUserBearerProvider`；系统没有进程令牌回退。
本地 CLI 尚未实现 Client 的 session-bound Control bridge，因此此集成选项仍要求外部提供当前用户
Bearer。CLI 不会把它写入 Navigator 数据库。

## Teams ingress and connector grants / Teams 入站与连接器授权

Teams is disabled unless `TEAMS_ENABLED=true`. The executor accepts only the
Teams adapter's timestamped HMAC callback, checks the configured tenant and
team allowlist, and persists the activity before returning success. Configure
`TEAMS_NAVIGATOR_HMAC_KEY` through the secret manager (at least 32 bytes),
`TEAMS_TENANT_ID`, `TEAMS_ALLOWED_TEAM_IDS`, `TEAMS_BOT_APP_ID`, and
`TEAMS_TASK_ACTOR_SUBJECTS_FILE`. The private JSON file uses
`{"schemaVersion":1,"workspaceId":"...","issuer":"https://login.microsoftonline.com/<tenant-uuid>/v2.0","subjects":["<aad-object-uuid>"]}`.
Navigator reloads it for each admission and before each Teams reply; a scope
mismatch or unreadable file fails closed. The owner provisioning command updates
this projection after Directory authorization. `TEAMS_TASK_ACTOR_SUBJECTS` remains
available for static deployments that do not configure the file. The first task
actor is Derek's immutable Entra object ID; additional actor IDs can be added by
the owner command. Member
messages in an admitted thread are stored as context but never start tasks or
enter another actor's operation prompt. The SDK-verified per-activity service
URL is validated against exact Bot Framework HTTPS hosts and regional paths,
then kept only in the private thread/outbox route and exact connector grant.

The outbox dispatcher uses `CYRENE_EXCHANGE_CONNECTOR_INTERNAL_URL`,
`NAVIGATOR_EXCHANGE_HMAC_KEY_FILE`, `NAVIGATOR_EXCHANGE_HMAC_KEY_ID`, and the
host-bound `TEAMS_EXCHANGE_CONNECTION_REF` / `TEAMS_EXCHANGE_PROFILE_REF`. It
mints a short-lived grant for each exact provider call and each final Teams
reply. Grants stay in memory. Unknown delivery results become `uncertain` and
are not resent automatically. `CYRENE_EXECUTOR_MAX_CONCURRENT_TASKS` defaults
to `1`; the launcher accepts values from 1 to 32.

`CYRENE_CONNECTOR_BINDINGS_FILE` is a read-only launcher-owned JSON file. Its
`schemaVersion: 1` binding rows map a Tool Provider `bindingId` to an Exchange
connection UUID, provider ID, fixed profile reference, and a list of fixed
`toolId → operationId` mappings with `resourceProjection` and `mutating` fields.
`CYRENE_CONNECTOR_TOOL_CATALOG_FILE` is also required for Teams deployments; it
points to the private Exchange snapshot with `schemaVersion: 1` and an `items`
array (mounted in Compose at `/run/config/connector-tool-catalog.json`). The
Python supervisor checks that it is a bounded regular JSON file and forwards its
resolved path. Node validates the full catalog and exact binding intersection.
Navigator validates every operation and mutability flag against its closed
table before it registers these mappings. It rejects unknown operations or a
projection/mutability mismatch at startup. With connector authorization enabled,
Navigator exposes only catalog tools named by the trusted binding map. String,
numeric, and collection bounds unsupported by DSH are removed from its display
schema and enforced by Navigator before approval or dispatch; any other
unsupported schema keyword rejects registration. The model cannot change the binding,
profile, operation ID, or caller identity. Cloud, GitHub, and Hugging Face CLI
operations bind to the fixed profile scope, are classified as writes, and sign
the complete `argv` in the exact argument digest. Prefer typed API tools when
they provide the requested query result.
GitHub and Hugging Face provider tools expose only their canonical operation
arguments to the model; Navigator keeps their profile outside the payload and
binds it in the grant. Their CLI tools expose only `argv`, and Exchange uses an
empty Account Center lease target for those CLI calls.

### Teams text-only chat / Teams 纯文字对话

Set `CYRENE_TEAMS_CHAT_ONLY=true` to admit authenticated Teams conversations
without enabling connector tools. `TEAMS_CHAT_ONLY=true` is a supported alias;
if both variables are set, their values must agree. The default is `false`.
The connector binding map must be empty, and any configured tool catalog must
use `schemaVersion: 1` with an empty `items` array. This mode exposes no model
tools and must not be used to claim that an external resource was checked or an
operation completed.

Keep `TEAMS_ENABLED=true`, the existing tenant/team and Directory actor
authorization, durable Work state, and the fixed Exchange Teams reply profile
(`TEAMS_EXCHANGE_CONNECTION_REF` / `TEAMS_EXCHANGE_PROFILE_REF`) configured.
Use the selected real model adapter as usual. Leave
`CYRENE_WORKFLOWS_ENABLED` unset or set it to `false`; leave
`NAVIGATOR_PLUGINS_DIR`, `CYRENE_EXCHANGE_INTEGRATION_URL`,
`CYRENE_CLOUD_PROFILE_CONFIG`, and `CYRENE_SUBAGENT_CONFIG` unset. The stock
Docker command includes `--plugins-dir`; override the Compose command for this
mode and omit that argument. Startup rejects any configured dynamic plugin
directory or business-tool configuration, then verifies the model tool list is
empty.

Teams 默认关闭。设置 `TEAMS_ENABLED=true` 后，executor 只接受带时间戳 HMAC 的 Teams adapter
回调，核对配置的 tenant/team allowlist，并在持久接纳事件后才返回成功。通过 secret manager 配置
`TEAMS_NAVIGATOR_HMAC_KEY`（至少 32 字节）、`TEAMS_TENANT_ID`、`TEAMS_ALLOWED_TEAM_IDS`、
`TEAMS_BOT_APP_ID` 和 `TEAMS_TASK_ACTOR_SUBJECTS_FILE`。私有 JSON 使用
`{"schemaVersion":1,"workspaceId":"...","issuer":"https://login.microsoftonline.com/<tenant-uuid>/v2.0","subjects":["<aad-object-uuid>"]}`；Navigator 在每次接纳事件和发送 Teams 回帖前重新读取，范围不匹配或文件不可读时关闭授权。维护者命令在 Directory 授权成功后更新此投影。未配置文件时仍兼容静态 `TEAMS_TASK_ACTOR_SUBJECTS`。首位任务执行者是 Derek 不变的 Entra object ID；
后续维护者可用宿主管理命令添加。已接纳线程里的其他成员消息会保存为讨论上下文，不会启动任务，
也不会进入另一位维护者的操作提示。

outbox dispatcher 使用 `CYRENE_EXCHANGE_CONNECTOR_INTERNAL_URL`、
`NAVIGATOR_EXCHANGE_HMAC_KEY_FILE`、`NAVIGATOR_EXCHANGE_HMAC_KEY_ID` 和宿主绑定的
`TEAMS_EXCHANGE_CONNECTION_REF` / `TEAMS_EXCHANGE_PROFILE_REF`。每次精确 provider 调用和最终 Teams
回帖都会申请短期 grant，grant 仅驻留内存。投递结果未知时记录为 `uncertain`，不自动重发。
`CYRENE_EXECUTOR_MAX_CONCURRENT_TASKS` 默认 `1`，launcher 接受 `1` 到 `32`。

`CYRENE_CONNECTOR_BINDINGS_FILE` 是 launcher 只读管理的 JSON 文件。`schemaVersion: 1` 的 binding
行把 Tool Provider `bindingId` 映射到 Exchange connection UUID、provider ID、固定 profile reference，
以及固定的 `toolId → operationId` 列表和 `resourceProjection`、`mutating` 字段。Navigator 会用闭合表
校验每项 operation 和 mutability；未知操作或投影/权限标记不匹配会阻止启动。模型无法更改 binding、
profile、operation ID 或调用者身份。CLI 操作绑定固定 profile，并在 exact argument digest 中签入完整
`argv`。
Teams 部署还必须设置 `CYRENE_CONNECTOR_TOOL_CATALOG_FILE`，指向包含 `schemaVersion: 1` 与 `items` 数组的
Exchange 私有 snapshot；Compose 挂载路径为 `/run/config/connector-tool-catalog.json`。Python supervisor 只
校验它是有界普通 JSON 文件并转发解析后的路径，Node 会验证完整 catalog 和精确 binding 交集。
GitHub 和 Hugging Face provider tools 只向模型暴露各自的标准 operation 参数；Navigator 不把 profile 写进参数，
而是在 grant 中单独绑定。两类 CLI 只暴露 `argv`，Exchange 对它们使用空的 Account Center lease target。

### Teams 纯文字对话

设置 `CYRENE_TEAMS_CHAT_ONLY=true`，可接收经过身份校验的 Teams 对话而不开放连接器工具。也支持别名
`TEAMS_CHAT_ONLY=true`；若同时设置，两个值必须一致。默认值为 `false`。连接器 binding map 必须为空；若配置了
tool catalog，必须使用 `schemaVersion: 1` 且 `items` 为空。此模式不向模型提供工具，因此不能声称已检查外部资源
或完成了某项操作。

仍须保留 `TEAMS_ENABLED=true`、现有 tenant/team 与 Directory 执行者授权、持久 Work 状态，以及固定的 Exchange
Teams 回复 profile（`TEAMS_EXCHANGE_CONNECTION_REF` / `TEAMS_EXCHANGE_PROFILE_REF`），并按常规配置真实模型适配器。
`CYRENE_WORKFLOWS_ENABLED` 应未设置或设为 `false`；`NAVIGATOR_PLUGINS_DIR`、
`CYRENE_EXCHANGE_INTEGRATION_URL`、`CYRENE_CLOUD_PROFILE_CONFIG` 和 `CYRENE_SUBAGENT_CONFIG` 应保持未设置。
标准 Docker 命令带有 `--plugins-dir`；使用此模式时要覆盖 Compose command 并移除该参数。启动会拒绝动态插件目录和
业务工具配置，并在启动完成前验证模型工具列表为空。

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
environment variable. Other `*_env`, `*_env_ref`, and `secret_refs` names in the file are
passed to persistence only when those variables exist in the supervisor's
environment. The config itself contains references, not credential values.

创建由 owner 管理的 principal 配置，并通过 `--principal-config` 传入路径。将
`--principal-token-env` 设为 owner 行的 token reference；supervisor 会通过该环境变量提供新生成的
内部值（若环境已有该引用则沿用其值）。配置中的其他 `*_env`、`*_env_ref` 和 `secret_refs` 名称只会在
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
