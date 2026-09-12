# Navigator client extensions / Navigator 客户端扩展

This directory contains thin browser-side Cordis extensions for Navigator.
They observe public upstream client services and add Cyrene product behavior;
they do not own the Harness Agent Loop, Session event history, or a second
message store.

本目录存放 Navigator 的浏览器端 Cordis 薄扩展。扩展只观察上游公开的客户端
服务并补充 Cyrene 产品行为，不拥有 Harness Agent Loop、Session 事件历史，
也不建立第二套消息存储。

| File | Responsibility / 职责 |
| --- | --- |
| `delivery-feedback.ts` | Preserve an unconfirmed composer draft and show explicit transport or ownership feedback / 保留未确认草稿并显示明确的传输或 ownership 反馈 |
| `README.md` | This directory map and authority boundary / 本目录导航与 authority 边界 |

`delivery-feedback.ts` subscribes to the public Session snapshot and correlates
each local `PendingSubmission.requestId` with the authoritative
`ctx.sessions.binding(sessionId).eventSource`. Only matching user messages or
inbox consumption associate an input with a turn. Its terminal event settles
the attempt; pending-echo retirement alone does not prove success. Failed inputs
remain available with an explicit Restore input button. The button
only fills an empty composer; it never sends, overwrites newer text, or writes
another Session history. In the desktop, a dedicated Rust capability retains
unconfirmed submission text independently of the temporary browser origin.
The UI confirms a local save before the user closes the application. Plain
text that has never been submitted is still the upstream composer's draft.

`delivery-feedback.ts` 直接订阅公开 Session 快照，按每次本地提交的 requestId
关联权威事件。只有匹配的 user/message 或 inbox 消费才能关联 turn；pending 回显
消失不能证明成功。失败输入可由用户显式点击 Restore input
填回空输入框；不会自动发送、覆盖新输入或保存另一份会话历史。桌面通过独立的 Rust
capability 保存未确认提交的文本，不依赖临时浏览器来源；界面确认保存后才可关闭应用。
从未提交的普通草稿仍由上游 composer 负责。

The extension is mounted by the Bundle's `conversation.input.dock` slot and
is loaded through the browser `./client` subpath. It must remain a UI adapter,
not a replacement for the upstream Session persistence or message authority.

该扩展由 Bundle 的 `conversation.input.dock` slot 挂载，并通过浏览器端
`./client` 子路径加载。它必须保持为 UI 适配层，不能替代上游 Session 持久化
或消息 authority。

## Build and runtime boundary / 构建与运行边界

Compile this directory only with the browser program:
`harness/tsconfig.client.json`. It is strict, targets the DOM, and intentionally
declares no Node environment types. The Host program uses `harness/tsconfig.json`
and excludes this directory. The browser source consumes the public client
faces supplied by the pinned Harness; it does not import the aggregate Host or
Client Cordis declarations, add a Node runtime library, or create another
Session/message-history store.

本目录只能使用浏览器程序 `harness/tsconfig.client.json` 编译。该配置启用 strict、
目标为 DOM，并明确不声明 Node 环境类型。Host 程序使用 `harness/tsconfig.json`，
并排除本目录。浏览器源码只消费固定 Harness 提供的公开 client face，不导入聚合的
Host 或 Client Cordis 声明，不增加 Node runtime library，也不创建另一套
Session/message-history store。

Always remove `harness/dist` before compiling both programs. After the two
strict compilations, run `node scripts/windows/build-harness-client.mjs` to
wrap `harness/dist/client/delivery-feedback.js` in the DSH `__ModuleLoader__`
ABI and produce `harness/dist/client.js`. This generated Loader artifact is
shared by Linux and Windows staging; it is not a separate browser runtime.

每次分别编译两个程序前都要先删除 `harness/dist`。两个 strict 编译完成后，运行
`node scripts/windows/build-harness-client.mjs`，把
`harness/dist/client/delivery-feedback.js` 包装成 DSH `__ModuleLoader__` ABI，生成
`harness/dist/client.js`。Linux 和 Windows staging 使用同一个生成的 Loader 产物；
它不是另一套浏览器 runtime。

The desktop recovery namespace is local to its data profile, persistence
authority, Workspace, and stable local account profile. It contains request IDs and
unconfirmed submitted text only. Live completion events must be confirmed by
the backend's read-only durable receipt before removing a copy; only a
successful explicit dismissal can remove a copy directly. Queue cancellation
and terminal turn events remain visible until that receipt or an explicit
dismissal succeeds. If local `put` or `remove` fails, the unconfirmed copy stays
visible and `Retry local save` retries the local operation; it never sends a
model request. A retry publishes its new local copy before removing the old
one. An unavailable receipt keeps delivery unconfirmed without marking a
successful local save as failed; Check delivery explicitly re-reads the receipt.
After reopening, the same receipt barrier applies to recovered copies;
an unconfirmed copy remains an explicit review/restore choice. The account
profile remains stable across token rotation and changes when switching
accounts. It scopes local client data; Workspace Identity remains the
authorization authority.

桌面恢复数据按本地 profile、persistence authority、Workspace 和稳定账户配置隔离，
只包含 request ID 与未确认的已提交文本；实时完成事件必须经服务端只读持久化回执
确认后才能删除副本，只有成功的显式 Dismiss 才能直接删除。队列取消和 turn 终态在
收到回执或显式删除成功前仍保持可见。`put` 或 `remove` 本地操作失败时，未确认副本
仍保持可见，`Retry local save` 会重试对应本地操作，不会发送模型请求。重试先保存新
副本再删除旧副本。重开后仍需相同回执确认；未确认输入仍需人工检查并 Restore。
回执查询不可用不会把已成功落盘的副本标成保存失败；Check delivery 显式重读回执。
账户配置标识在 token 轮换时保持不变，切换账户时更换；它只划分本地数据，权限仍由
Workspace Identity 决定。

The browser-only Profile has no native recovery capability and keeps its
volatile input behavior. Regression tests cover request correlation and local
storage ordering; installed-app durability and WebView permissions require the
separate Windows desktop proof.

单独使用浏览器 Profile 时没有 native recovery capability，输入保留仍为临时状态。
回归测试覆盖请求关联与本地存储顺序；安装应用的持久化和 WebView 权限仍需单独验收。
