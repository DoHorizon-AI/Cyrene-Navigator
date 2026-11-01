# QQ conversation connector

This module owns the Navigator adapter for the existing Plugins `cyrene.connectors.im`
DirectPlugin endpoint. It consumes `message.connector.v1` interface version 1 through
the official DirectPlugin Python client and the frozen message connector contracts
SDK. It does not launch a second executor, vendor a connector, or depend on NapCat.

The host supplies only server-configured QQ bindings and implements
`ConversationConnectorHostPortV1`. The host must resolve a trusted account/sender/
conversation mapping, deduplicate and admit inbound events through WorkStore and the
existing DSH task path, and derive the destination for a reply from the durable task
origin. `sender_id`, model output, and browser inputs are never actor or destination
authority.

`QQConnectorBinding.binding_id` is a host-owned configuration identifier;
`connector_id` is fixed to `qq-v1`; `account_id` is the expected QQ account identity
reported by the configured Plugin. `VerifiedInboundContext.actor_id` must be the
host-mapped DSH actor UUID, and its workspace, connector, binding, account,
conversation, and sender values must match the binding and event before admission.
Only the host port maps QQ senders or subscriptions to actors and Work permissions.

Before each send, the adapter asks the host to authorize the task origin, persona,
subscription, and source permissions again. It writes a Work Operation intent before
the connector call. An existing intent is never replayed. A canceled or ambiguous
call is recorded as `uncertain`, because cancellation does not prove that QQ did not
accept the message. Recovery must reconcile the receipt or vendor history before a
new operation is created.

The status route reports only redacted runtime health within the authenticated
Workspace. It cannot configure accounts or arbitrary connection endpoints. A local
DirectPlugin process with a fixture QQ Host is simulation evidence; external QQ
account login, send, and platform readback remain `NOT_RUN` until performed with a
dedicated configured account.

The optional simulated gRPC process test is
`tests/test_qq_direct_plugin_process.py`. Run it with
`CYRENE_QQ_PLUGIN_SOURCE_ROOT`, `CYRENE_PLUGIN_RUNTIME_SOURCE_ROOT`, and
`CYRENE_MESSAGE_CONNECTOR_SDK_SOURCE` pointing to the corresponding source trees.
It launches the existing Python QQ reference Plugin and its fake QQ Host; its result
remains `SIMULATED`.

---

## 中文

此模块为现有 Plugins `cyrene.connectors.im` DirectPlugin endpoint 提供 Navigator
适配器，通过正式 DirectPlugin Python 客户端和冻结的 message connector contracts
SDK 消费 `message.connector.v1` interface version 1。它不会启动第二套执行器、内置
连接器实现或依赖 NapCat。

宿主仅注入服务端配置的 QQ binding，并实现 `ConversationConnectorHostPortV1`。宿主负责
解析可信的账号／发送者／会话映射，通过 WorkStore 和现有 DSH task 流程去重并接受入站
事件，再根据持久任务来源派生回复目的地。`sender_id`、模型输出和浏览器输入都不能作为
actor 或目的地授权。

`QQConnectorBinding.binding_id` 是宿主配置标识；`connector_id` 固定为 `qq-v1`；
`account_id` 是配置插件应回报的 QQ 账号身份。`VerifiedInboundContext.actor_id` 必须是宿主
映射到的 DSH actor UUID；workspace、connector、binding、account、conversation 和 sender
必须与 binding 及事件相符。只有宿主端口可以把 QQ sender 或订阅映射到 actor 与 Work 权限。

每次发送前，适配器会重新让宿主核验任务来源、人格、订阅和来源权限。调用 connector 前先
持久化 Work Operation 意图。已有意图不会重放。取消或结果含糊的调用会记为 `uncertain`，
因为取消不能证明 QQ 没有接受消息。恢复时必须先核对回执或平台历史，再创建新操作。

状态路由只在通过认证的 Workspace 内返回脱敏运行状态，不能配置账号或任意连接地址。带
fixture QQ Host 的本地 DirectPlugin 进程只算模拟证据；只有使用专用账号完成登录、发送和
平台回读后，外部 QQ 验收才能记为 `REAL`。

可选的模拟 gRPC 进程测试为 `tests/test_qq_direct_plugin_process.py`。运行时需设置
`CYRENE_QQ_PLUGIN_SOURCE_ROOT`、`CYRENE_PLUGIN_RUNTIME_SOURCE_ROOT` 和
`CYRENE_MESSAGE_CONNECTOR_SDK_SOURCE` 指向对应源码树。测试启动现有 Python QQ reference
Plugin 和 fake QQ Host；结果仍然属于 `SIMULATED`。
