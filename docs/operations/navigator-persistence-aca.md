# Navigator persistence service on Azure Container Apps

## Status

This is a review package, not a production deployment. No Navigator Container App exists, the YAML contains placeholders, and this repository adds no Azure deployment workflow. The image can run the current Python persistence service, but that does not establish production durability, a trusted caller, or network reachability.

The service uses SQLite WAL and synchronous commits. The review manifest uses one replica and EmptyDir, so replica replacement, scale-in, or revision cutover can lose all sessions. An EmptyDir volume may survive a container restart while its replica remains, but it is not durable storage. Do not mount the WAL database on Azure Files or another network filesystem; SQLite WAL requires local shared-memory and locking semantics. This profile must not hold authoritative production Workspace sessions.

生产门槛仍未满足：当前没有 Navigator ACA app；YAML 中保留占位符，也没有 Azure 部署 workflow。镜像可以启动现有 Python 持久化服务，但这不能证明生产数据持久性、调用方可信或网络连通。

服务使用 SQLite WAL 与同步提交。审查 manifest 只使用一个副本和 EmptyDir；副本替换、缩容或 revision 切换都可能丢失全部 Session。EmptyDir 在副本仍存在时可能跨容器重启保留数据，但它不是持久存储。不要把 WAL 数据库挂载到 Azure Files 或其他网络文件系统；SQLite WAL 依赖本地共享内存和文件锁语义。该配置不得保存生产 Workspace 权威 Session。

## Request and credential boundary

The image runs only scripts/serve-persistence.py; it does not load the Harness session-control.ts Connection routes. The persistence API returns writerToken and epoch to an authenticated caller when it grants a write handle. Keep the Harness bearer and every returned writer capability inside a trusted server-side Harness/Persistence runtime. A browser, BFF, Frontend Relay, or Workspace Connector must not call the raw Harness mutation routes, receive or forward a writerToken/epoch, or submit arbitrary event batches.

The internal ACA ingress restricts traffic to the Container Apps environment; it does not authorize individual apps or callers inside that environment. The manifest's inbound bearer is a server-to-server credential, not a browser session. Any production route must terminate at an independently authorized server-side boundary that owns the writer capability and never serializes it into a browser response. The separate Harness host now allowlists its takeover response fields, but that does not make this raw persistence API safe for browser/BFF use or prove that the Host is production-ready.

The BFF/Workspace call chain remains BFF → Frontend Relay → Workspace Connector → ProductHttpApiAdapter → Product ACA. This Navigator package is not a substitute for that Connector path. There is no production Connector placement or Navigator ACA app to demonstrate the required private network routes.

镜像只运行 scripts/serve-persistence.py，不会加载 Harness session-control.ts Connection 路由。持久化 API 在向经过认证的调用方授予写句柄时会返回 writerToken 和 epoch。Harness bearer 与返回的写能力必须留在可信的 server-side Harness/Persistence runtime 中。浏览器、BFF、Frontend Relay 或 Workspace Connector 不得调用原始 Harness 变更路由、接收或转发 writerToken/epoch，也不得提交任意 event batch。

ACA 内网 ingress 只将流量限定在 Container Apps 环境内，不会授权环境内的具体应用或调用方。manifest 的入站 bearer 是服务间凭据，不是浏览器 session。任何生产路由都必须经过独立授权的服务端边界；该边界拥有写能力，且不会把写能力序列化进浏览器响应。独立 Harness host 现已对 takeover 响应字段使用 allowlist，但这不代表原始持久化 API 可以供浏览器/BFF 调用，也不证明 Host 已达到生产就绪。

BFF/Workspace 调用链仍为 BFF → Frontend Relay → Workspace Connector → ProductHttpApiAdapter → Product ACA。这个 Navigator 包不能替代该 Connector 路径。当前没有生产 Connector host 部署位置或 Navigator ACA app 能证明所需的私网路由。

## Configuration contract

docker/container-entrypoint.sh requires a readable JSON principal configuration and starts the runner with --require-product-service-configuration. Startup fails unless all five Product origins are present and every organization/Workspace principal has a distinct service bearer for each Product. The service validates Product origins through its existing URL policy, including HTTPS outside loopback. Secret values are read from environment variables named by the JSON file; they are never printed by the entrypoint.

The mounted principal-config.json follows this shape. Store the configuration file as a Key Vault secret and mount it through the ACA secret volume. Replace all names and IDs with exact deployment assignments.

~~~json
{
  "principals": [
    {
      "token_env": "NAVIGATOR_HARNESS_BEARER",
      "actor_id": "REPLACE_WITH_SERVER_ACTOR_ID",
      "organization_id": "REPLACE_WITH_ORGANIZATION_ID",
      "workspace_ids": ["REPLACE_WITH_WORKSPACE_ID"]
    }
  ],
  "product_directory": [
    {"product": "CATALYST", "base_url_env": "CATALYST_BASE_URL"},
    {"product": "YIELD", "base_url_env": "YIELD_BASE_URL"},
    {"product": "REACTOR", "base_url_env": "REACTOR_BASE_URL"},
    {"product": "EXCHANGE", "base_url_env": "EXCHANGE_BASE_URL"},
    {"product": "ECHO", "base_url_env": "ECHO_BASE_URL"}
  ],
  "product_service_credentials": [
    {"product": "CATALYST", "organization_id": "REPLACE_WITH_ORGANIZATION_ID", "workspace_id": "REPLACE_WITH_WORKSPACE_ID", "token_env": "NAVIGATOR_CATALYST_SERVICE_BEARER"},
    {"product": "YIELD", "organization_id": "REPLACE_WITH_ORGANIZATION_ID", "workspace_id": "REPLACE_WITH_WORKSPACE_ID", "token_env": "NAVIGATOR_YIELD_SERVICE_BEARER"},
    {"product": "REACTOR", "organization_id": "REPLACE_WITH_ORGANIZATION_ID", "workspace_id": "REPLACE_WITH_WORKSPACE_ID", "token_env": "NAVIGATOR_REACTOR_SERVICE_BEARER"},
    {"product": "EXCHANGE", "organization_id": "REPLACE_WITH_ORGANIZATION_ID", "workspace_id": "REPLACE_WITH_WORKSPACE_ID", "token_env": "NAVIGATOR_EXCHANGE_SERVICE_BEARER"},
    {"product": "ECHO", "organization_id": "REPLACE_WITH_ORGANIZATION_ID", "workspace_id": "REPLACE_WITH_WORKSPACE_ID", "token_env": "NAVIGATOR_ECHO_SERVICE_BEARER"}
  ]
}
~~~

For every additional principal/Workspace scope, add a unique environment variable and one service credential entry for each of the five Products. Each token must be distinct across inbound and downstream roles. Put bearer values in Key Vault-backed ACA secrets and bind them through secretRef; never place values in YAML, image layers, build arguments, or command-line arguments. Grant the app's managed identity Key Vault Secrets User access before creating a revision that references those secrets.

docker/container-entrypoint.sh 要求可读的 JSON principal 配置，并使用 --require-product-service-configuration 启动 runner。缺少任一 Product origin，或任一组织/Workspace principal 未配置每个 Product 的独立 service bearer，服务都会拒绝启动。Product origin 继续使用现有 URL 策略校验，包括 loopback 以外必须使用 HTTPS。密钥值按 JSON 配置中的环境变量名读取，entrypoint 不会打印密钥值。

挂载的 principal-config.json 采用上述结构。该配置文件必须作为 Key Vault secret 保存，并通过 ACA secret volume 挂载；将所有名称和 ID 替换成精确的部署分配值。每增加一个 principal/Workspace scope，都要为五个 Product 分别添加唯一环境变量和 service credential。各 bearer 在入站与下游角色之间也必须互不相同。bearer 值必须存放在 Key Vault-backed ACA secret 中，并通过 secretRef 注入；不要写入 YAML、镜像层、build 参数或命令行参数。创建引用这些密钥的 revision 前，必须先授予 app managed identity 的 Key Vault Secrets User 权限。

## Health probes

- /healthz reports that the ASGI process can answer HTTP requests.
- /readyz reports that the principal/service configuration loaded, SQLite initialization completed, and the database file is still present.
- Neither endpoint checks Product reachability, Connector authorization, remote database health, or durable storage. A 200 from /readyz is not an end-to-end readiness claim.

The review manifest uses /readyz for startup and readiness probes and /healthz for liveness. Keep these meanings in dashboards and alerts. Do not use probe success as evidence that a Product request can reach an internal ACA FQDN.

- /healthz 仅报告 ASGI 进程可以响应 HTTP 请求。
- /readyz 仅报告 principal/service 配置已加载、SQLite 初始化已完成且数据库文件仍存在。
- 两个 endpoint 都不检查 Product 连通性、Connector 授权、远端数据库健康或持久存储。因此 /readyz 返回 200 不等于端到端 ready。

审查 manifest 使用 /readyz 作为 startup/readiness probe，使用 /healthz 作为 liveness probe。监控与告警必须保留这些语义。probe 成功不能作为 Product 请求可访问 ACA 内部 FQDN 的证据。

## Review manifest and production gates

The manifest is internal-only and uses an immutable image-digest placeholder, Key Vault references, a secret volume for the JSON configuration, a single replica, and local ephemeral storage. It is deliberately incomplete and has not been applied to Azure. No GHCR build or Azure deployment workflow is included in this slice.

Before production, the owner must provide and verify all of the following:

1. A supported durable storage design for authoritative Harness events. The current SQLite WAL store cannot use network storage, and the reviewed ephemeral volume loses data on restart.
2. A trusted server-side Harness/Persistence caller and an authorization boundary that keeps writer tokens, epochs, and raw events away from browser/BFF callers.
3. A production Connector host and placement with tested private reachability to Product apps. Current Azure topology has five East Asia internal Product apps in an ACA environment without a VNet, no Azure PostgreSQL Flexible Server, and a separate West US 2 VNet environment that cannot reach those East Asia internal FQDNs. Navigator also has no live ACA app.
4. Exact Key Vault identities, bearer rotation/ownership, Product base URLs, and per-Workspace credential assignments.
5. Real ACA ingress, probe, secret-volume, identity, and network acceptance. This review template is not live-environment evidence.

该 manifest 仅允许环境内访问，使用不可变镜像 digest 占位符、Key Vault 引用、挂载 JSON 配置的 secret volume、单副本和本地临时存储。模板故意保留未完成占位符，尚未应用到 Azure。本 slice 不包含 GHCR build 或 Azure 部署 workflow。

## References

- ACA ingress: https://learn.microsoft.com/en-us/azure/container-apps/ingress-how-to
- ACA health probes: https://learn.microsoft.com/en-us/azure/container-apps/health-probes
- ACA secret volumes and Key Vault references: https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets
- ACA storage mounts: https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts
- SQLite Write-Ahead Logging: https://www.sqlite.org/wal.html

生产前必须提供并验证：

1. 用于权威 Harness event 的受支持持久化方案。现有 SQLite WAL store 不能使用网络存储，审查配置的临时卷会在重启时丢失数据。
2. 可信的 server-side Harness/Persistence 调用方及授权边界，确保 writer token、epoch 和原始 event 不会到达浏览器/BFF。
3. 生产 Connector host 与部署位置，并实际验证到 Product apps 的私网连通性。当前 Azure 拓扑中，五个 East Asia 内网 Product app 位于无 VNet 的 ACA environment；Azure 没有 PostgreSQL Flexible Server；独立的 West US 2 VNet environment 无法访问 East Asia 内网 FQDN。Navigator 也没有 live ACA app。
4. 精确的 Key Vault identity、bearer 轮换与所有权、Product base URL 和每 Workspace 凭据分配。
5. 真实 ACA ingress、probe、secret volume、identity 与网络验收。该审查模板不能作为 live 环境证据。
