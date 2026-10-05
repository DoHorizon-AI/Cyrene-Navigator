# Official cloud connections / 官方云连接

Navigator loads versioned connection profiles through the DSH MCP client and
publishes live health and discovered tool descriptions through
`ctx.cloudConnections`. Profile metadata records each publisher, endpoint, and
official documentation source. Credentials are resolved from named host
environment references at startup and are never copied into profile JSON or
workflow records.

Navigator 通过 DSH MCP client 加载版本化连接配置，并通过
`ctx.cloudConnections` 发布实时健康状态和已发现工具说明。配置元数据记录发布方、端点
和官方文档来源。凭据只在启动时从宿主环境引用中解析，不会复制到 profile JSON 或工作流记录。

## Bundled profiles / 内置配置

The bundle is `harness/presets/cyrene-navigator/cloud-connections.json`. Its
checked-in state enables documentation discovery and the fixed Google Cloud
CLI adapter; provider credentials, project IDs, and Azure packages remain
operator managed.

配置文件位于 `harness/presets/cyrene-navigator/cloud-connections.json`。仓库内默认启用
文档发现和受限的 Google Cloud CLI 适配器；云凭据、项目 ID 和 Azure 软件包由运维方配置。

| Profile | Connection and source | Workflow policy |
| --- | --- | --- |
| `microsoft-learn` | Remote Streamable HTTP at [`learn.microsoft.com/api/mcp`](https://learn.microsoft.com/api/mcp); no profile credential is required. See [Microsoft Learn MCP](https://learn.microsoft.com/en-us/training/support/mcp). | Discovered tools may be used only when a workflow target has `kind: "cloud-connection"` and `id: "microsoft-learn"`. |
| `google-developer-knowledge` | Remote Streamable HTTP at [`developerknowledge.googleapis.com/mcp`](https://developerknowledge.googleapis.com/mcp); resolves `X-Goog-Api-Key` from `DEVELOPERKNOWLEDGE_API_KEY`. See [Google Developer Knowledge MCP](https://developers.google.com/knowledge/reference/mcp). Restrict the API key to this API. | Discovered documentation tools may be used only when explicitly bound with `kind: "cloud-connection"` and `id: "google-developer-knowledge"`. |
| `azure` | Disabled by default. Runs the official pinned `@azure/mcp@3.0.0-beta.49` stdio server with namespace mode limited to `compute` and `monitor`, plus `--read-only`. See [Azure MCP tools](https://learn.microsoft.com/en-us/azure/developer/azure-mcp-server/tools/) and [the official npm package](https://www.npmjs.com/package/@azure/mcp). | If an operator installs and enables this profile with the validated argv, only its discovered tools are eligible for a workflow target `kind: "cloud-connection"`, `id: "azure"`. |
| `huggingface` | Disabled by default. Uses the official [`huggingface.co/mcp`](https://huggingface.co/mcp) endpoint and resolves `HF_TOKEN` from the host environment. See [Hugging Face MCP](https://huggingface.co/docs/hub/agents-mcp). Its tool surface includes write, job, sandbox, and community capabilities. | Never admitted to scheduled workflow sessions. An interactive tool allowlist does not prove read-only behavior. |
| `google-cloud-readonly` | Uses the host `gcloud` executable, with no shell, and only fixed `projects.describe`, `services.list`, and `compute.instances.list` argv templates. See [gcloud CLI](https://cloud.google.com/sdk/gcloud) and its [command reference](https://cloud.google.com/sdk/gcloud/reference). | A workflow must bind each project using `kind: "google-cloud-project"` and the exact configured project ID. The runtime intersects workflow targets with the profile's `allowedProjectIds`. |

微软、Google 文档端点只读；Azure 配置使用固定版本、固定命名空间和只读启动参数；Google
Cloud CLI 不接受任意 shell 命令。Hugging Face Hub 的工具面包含写操作、作业、沙盒和社区能力，
所以定时工作流始终拒绝该端点，即使交互式会话配置了工具白名单也不改变这个判定。

## Credentials and local setup / 凭据与本地配置

Set only the references required by enabled profiles in the service environment:

| Environment reference | Profile | Handling |
| --- | --- | --- |
| `DEVELOPERKNOWLEDGE_API_KEY` | Google Developer Knowledge | Provide a Google API key restricted to the Developer Knowledge API. |
| `AZURE_CLIENT_ID`, `IDENTITY_ENDPOINT`, `IDENTITY_HEADER` | Azure MCP | Supply the host's managed identity references; do not put values in the profile file. |
| `HF_TOKEN` | Hugging Face Hub | Optional for interactive use only; scheduled workflows reject every Hugging Face tool. |

启用相应 profile 时，只在服务环境设置必要引用。Google Developer Knowledge API key 应限制到
其官方 API。Azure 使用宿主提供的托管身份环境引用。任何凭据值都不得写进 profile 文件。

Google Cloud CLI uses the credential configuration already owned by the service
host. Configure project IDs explicitly in `allowedProjectIds`; an empty list
registers no CLI tool. Do not place service account keys or local credential
snapshots in the repository or workflow targets.

Google Cloud CLI 使用服务宿主已有的凭据配置。必须在 `allowedProjectIds` 中逐项列出项目；
空列表不会注册 CLI 工具。请勿将 service account key 或本地凭据快照放进仓库或工作流目标。

For a custom host profile, call `registerCloudConnections(ctx, config)` after
DSH ToolRuntime is ready and before `registerWorkflowRuntime(ctx, options)`.
MCP startup resolves only declared environment references. The registry omits
secret values and raw connection errors; MCP tools become available only after
the DSH client has discovered their schemas.

自定义宿主配置应先在 DSH ToolRuntime 就绪后调用
`registerCloudConnections(ctx, config)`，再调用 `registerWorkflowRuntime(ctx, options)`。
MCP 只解析配置中声明的环境引用。Registry 不公开凭据或原始连接错误；只有 DSH client
完成工具 schema 发现后，MCP 工具才可用。

## Workflow targets and durable notifications / 工作流目标与持久通知

Workflow targets are explicit references, not ambient account discovery. A
documentation target has this shape:

工作流 target 必须明确引用要检查的资源，不会扫描当前账号中的全部对象。文档连接示例：

```json
{
  "id": "microsoft-learn",
  "label": "Microsoft Learn",
  "kind": "cloud-connection"
}
```

A Google Cloud target uses the configured project ID as its `id` and
`kind: "google-cloud-project"`. Each active executor Session gets a temporary
tool guard. It permits `work_memory_search`, `work_sources`, and only the
source-classified readonly cloud tools bound by that workflow's targets. It
denies `work_notify`, provider writes, repository writes, subagent launchers,
Hugging Face tools, and every unlisted tool. The guard is removed when the
occurrence executor settles and does not affect other Sessions.

Scheduled observation targets currently support `cloud-connection` bindings
for `microsoft-learn`, `google-developer-knowledge`, and a configured readonly
`azure` profile, plus `google-cloud-project` bindings for exact project IDs in
the `google-cloud-readonly` profile. Hugging Face, unknown profile IDs, other
target kinds, and profiles that are disabled, missing credentials, or lack a
registered readonly tool fail preflight before executor dispatch. A completed
executor result is accepted only after a successful `tools/result` receipt from
the occurrence Session for **every configured target**. Memory/source lookup
does not count as a cloud observation, and a Google Cloud receipt must carry
the exact target project ID. A degraded official MCP profile may make a
bounded recovery probe with its already-discovered source-classified tools;
disabled or unauthenticated profiles remain unavailable.

Google Cloud target 的 `id` 是配置过的项目 ID，`kind` 为
`google-cloud-project`。每个执行 Session 都会临时安装工具 guard，只允许
`work_memory_search`、`work_sources` 和该工作流明确绑定且经来源分类的云只读工具。Guard
会拒绝 `work_notify`、provider 写工具、仓库写工具、subagent 启动器、Hugging Face 工具和其余
未列出的工具；执行完成后移除 guard，不改变其他 Session。

定时观察目前支持 `cloud-connection` 绑定 `microsoft-learn`、
`google-developer-knowledge` 和已配置只读策略的 `azure`，以及通过
`google-cloud-readonly` 精确绑定允许项目 ID 的 `google-cloud-project`。
Hugging Face、未知连接 ID、其他 target kind、已禁用或缺少凭据的连接，以及没有已注册只读工具的连接，
都会在执行器启动前被拒绝。只有当前 occurrence Session 为**每个已配置 target**产生成功的
`tools/result` 回执后，执行结果才会接受。记忆或来源查询不能代替云观察；Google Cloud 回执还必须包含
与目标完全一致的项目 ID。官方 MCP 连接暂时降级时，可用已发现且来源分类为只读的工具进行有限恢复探测；
已禁用或未配置凭据的连接仍不可用。

On a meaningful `change`, first `failure`, or `recovery` transition, the
runtime awaits `POST /api/v1/workspaces/{workspaceId}/work/notifications` before
emitting `workflow/notification`. The stable key is
`workflow:{workflowId}:{occurrenceId}:{kind}` and the payload contains only the
workflow ID, occurrence ID, redacted summary, and optional task ID. Replayed
occurrences reuse the Work API outbox item. Unchanged successes and repeated
failures remain quiet. The API persists notices in the shared SQLite-backed
outbox; it does not send them until an operator-configured adapter claims them.

发生 `change`、首次 `failure` 或 `recovery` 时，运行时先等待写入
`POST /api/v1/workspaces/{workspaceId}/work/notifications`，成功后才发出
`workflow/notification`。稳定去重键为
`workflow:{workflowId}:{occurrenceId}:{kind}`，payload 仅包含 workflow ID、occurrence ID、
已脱敏摘要和可选 task ID。重放 occurrence 会复用 Work API outbox 项。无变化的成功及重复失败
保持静默。API 将通知写入共享 SQLite outbox；只有运维方配置的 adapter 才会实际发送。

Outbox transport failures leave the terminal occurrence evidence intact.
Startup and periodic reconciliation retry missing notifications with the same
deduplication key, without re-executing the workflow. Recorded receipts are
cached only within the current host process; restart deduplication uses SQLite.

通知写入暂时失败时，保留已持久化的运行记录；启动和周期同步会用原去重键重试通知，
不会重新执行巡检。当前进程只缓存已记录的回执，重启后由 SQLite 保证去重。

## Local integration evidence / 本地集成验证

The cloud integration test uses local fake MCP HTTP and stdio servers and a
stubbed `gcloud` command runner. The workflow integration test mounts the real
DSH Schedule and JSON storage plugins, checks restart and occurrence dedup,
requires a successful receipt for each configured target (including two
projects sharing the same `gcloud_readonly` tool), checks unsupported-target
preflight, and attempts malicious write-tool calls against the real ToolRuntime
guard. These tests do not call live cloud APIs or launch chargeable workloads.

云集成测试使用本地伪造的 MCP HTTP/stdio 服务和 stub `gcloud` 命令执行器。工作流集成测试
挂载真实 DSH Schedule 与 JSON storage 插件，验证重启和 occurrence 去重，要求每个配置的 target 都有成功
回执（包括两个共用 `gcloud_readonly` 工具的项目），检查不支持 target 的预检失败，并通过真实
ToolRuntime guard 尝试恶意写工具调用。测试不会请求线上云 API，也不会启动计费工作负载。
