# Navigator Cloud Executor & Dynamic Plugin System

Navigator provides an autonomous, headless agent execution engine powered by **DeepSeek Harness** (`v0.2.0-rc.2`) and **Cordis** (`v4.0.4`). It operates seamlessly in dual modes:
1. **Embedded Local Mode**: Embedded within the Cyrene Client desktop application, providing authoritative local SQLite persistence, IPC to Rust native hosts, and desktop session control.
2. **Autonomous Cloud Headless Daemon**: Deployed as a standalone microservice or container (similar to Grok bot, muse, OpenAI dots), exposing REST and Server-Sent Events (SSE) APIs for programmatic agent execution, remote orchestration, and non-disruptive dynamic plugin hot-reloading.

---

## 1. Architecture Overview

```
                      ┌────────────────────────────────────────┐
                      │ External Callers (HTTP / REST / SSE)   │
                      │  (Cloud Backend / Microservices / CLI) │
                      └───────────────────┬────────────────────┘
                                          │
                                          ▼
                      ┌────────────────────────────────────────┐
                      │    Navigator Headless Cloud Daemon     │
                      │       (scripts/serve-executor.mjs)     │
                      ├────────────────────────────────────────┤
                      │  REST & SSE Controller (/api/v1/*)     │
                      ├───────────────────┬────────────────────┤
                      │  NavigatorExecutor│ DynamicPluginMgr   │
                      │  (Task & Session) │ (Cordis Fibers)    │
                      ├───────────────────┴────────────────────┤
                      │ DeepSeek Harness Runtime (v0.2.0-rc.2) │
                      │ - Cordis v4.0.4 Micro-Kernel           │
                      │ - Agent Loop & PTC Workflow Engine     │
                      │ - LLM Adapters (Exchange / Mock)       │
                      ├───────────────────┬────────────────────┤
                      │ Persistence Engine│ Tool Runtime & Rust│
                      │ (SQLite / Memory) │ Native IPC Host    │
                      └───────────────────┴────────────────────┘
```

### Key Capabilities
- **Non-blocking Autonomous Execution**: Submit tasks asynchronously or wait synchronously for final outcomes.
- **Real-Time Streaming**: Stream reasoning thought deltas (`reasoning-delta`) and response tokens (`text-delta`) in real time via standard SSE.
- **Dynamic Plugin Hot-Reload**: Load, reload, or unload Cordis plugins at runtime without killing the server or dropping active agent sessions.
- **Session Lifecycle & Recovery**: Seamless continuation, fork, and compaction backed by Cyrene session persistence.

---

## 2. API Reference

The headless daemon serves HTTP REST and SSE endpoints on its configured port (default: `8080`).

### 2.1 Health Check
- **Endpoint**: `GET /api/v1/health`
- **Response**:
```json
{
  "status": "ok",
  "service": "cyrene-navigator-executor",
  "version": "0.2.0-rc.2",
  "activeTasks": 0,
  "totalTasks": 12,
  "timestamp": 1791007107388
}
```

### 2.2 Submit Task (JSON or SSE)
- **Endpoint**: `POST /api/v1/execute` (or `POST /api/v1/tasks`)
- **Headers**:
  - `Content-Type: application/json`
  - `Accept: text/event-stream` (optional, for streaming)
- **Request Body**:
```json
{
  "prompt": "Analyze repository security posture and generate report",
  "sessionId": "session-custom-id",
  "cwd": "/workspace",
  "timeoutMs": 60000,
  "stream": false
}
```
- **Synchronous Response (`stream: false`)**:
```json
{
  "taskId": "task-e298d57f-75ff-4ba7-a8ad-49936bbefd4d",
  "sessionId": "session-custom-id",
  "status": "completed",
  "output": "Report generated successfully...",
  "reasoning": "Inspecting project dependencies...",
  "durationMs": 1420
}
```
- **Streaming Response (`stream: true` or `Accept: text/event-stream`)**:
Streams SSE events:
  - `event: status` — `{"type":"status","status":"running","taskId":"..."}`
  - `event: reasoning-delta` — `{"type":"reasoning-delta","text":"Thinking step..."}`
  - `event: text-delta` — `{"type":"text-delta","text":"Generated text..."}`
  - `event: finish` — `{"type":"finish","status":"completed","output":"...","reasoning":"..."}`

### 2.3 Query Task Status
- **Endpoint**: `GET /api/v1/tasks/:id/status`
- **Response**:
```json
{
  "id": "task-e298d57f-75ff-4ba7-a8ad-49936bbefd4d",
  "sessionId": "session-custom-id",
  "prompt": "Analyze repository security posture...",
  "status": "completed",
  "createdAt": 1791007106000,
  "startedAt": 1791007106010,
  "endedAt": 1791007107430,
  "output": "Report generated...",
  "reasoning": "...",
  "durationMs": 1420
}
```

### 2.4 Cancel Task
- **Endpoint**: `POST /api/v1/tasks/:id/cancel`
- **Response**:
```json
{
  "taskId": "task-e298d57f-75ff-4ba7-a8ad-49936bbefd4d",
  "cancelled": true
}
```

### 2.5 Trigger Plugin Hot-Reload
- **Endpoint**: `POST /api/v1/plugins/reload`
- **Response**:
```json
{
  "reloaded": true,
  "plugins": ["custom-tools.mjs", "auth-filter.mjs"]
}
```

---

## 3. Dynamic Plugin Hot-Reload

Navigator uses Cordis's hierarchical fiber tree to isolate plugin lifecycles.

### Creating a Plugin
Plugins are standard ESM modules exporting a Cordis plugin function:

```javascript
// plugins/custom-tool.mjs
export const name = 'my-custom-tool';

export function apply(ctx) {
  // Register custom tools, middleware, or services
  ctx.on('ready', () => {
    console.log('[plugin] My Custom Tool initialized');
  });

  // Resources registered within `apply` are scoped to this fiber
  // and will be automatically disposed upon reload.
}
```

### Hot-Reload Behavior
1. **Module Cache Busting**: Reload imports the module using timestamp query parameters (`?t=${Date.now()}`), defeating Node's ESM module cache.
2. **Safe Fiber Disposal**: Existing plugin fiber is cleanly unmounted via `fiber.dispose()`, removing its listeners, routes, and services without interfering with active agent execution or open sessions.
3. **Directory Watcher**: When `--watch-plugins` is enabled (default), changes in the plugins directory trigger automatic background reloads.

---

## 4. Running & Deployment

### 4.1 Running with Node.js
```bash
# Start standalone headless daemon
node scripts/serve-executor.mjs --port=8080 --host=0.0.0.0 --plugins-dir=./plugins
```

CLI Options:
- `--port` (default: `8080` or `process.env.PORT`): Port to bind.
- `--host` (default: `0.0.0.0` or `process.env.HOST`): Network interface.
- `--plugins-dir`: Directory containing dynamic plugins (`.mjs` / `.js`).
- `--watch-plugins` (default: `true`): Enable live file watching.
- `--workspace-id` (default: `default`): Workspace tenant context.
- `--drain-timeout-ms` (default: `30000`, maximum: `900000`): Maximum graceful-drain wait after SIGTERM/SIGINT.
- `--abort-cleanup-timeout-ms` (default: `5000`, maximum: `30000`): Bounded cleanup wait after the drain deadline expires.

### 4.2 Graceful drain for restart or hot update

The service keeps accepting and durably queuing HTTP and Teams work while it drains. It stops task claims and notification polling, rejects unclaimed limiter waiters back to their queued records, and lets already-running tasks and an already-claimed notification batch finish.

The service-bearer-protected control routes are:

- `GET /internal/v1/executor/drain`: Read the process instance, drain generation/token, active and queued task counts (`countsComplete` reports whether the durable Work listing completed), dispatch waiters, notification polling state, and `activeWorkDrained`.
- `POST /internal/v1/executor/drain` with `{}`: Enter drain. Repeated calls return the same generation and token for this process instance.
- `POST /internal/v1/executor/drain/resume` with `{"generation": 1, "token": "<token from this instance>"}`: Resume only the matching active drain. A stale token or generation returns `409`.

`activeWorkDrained` means this process has no running task, active dispatch, or claimed notification delivery left to finish. `queuedTasks` can remain nonzero by design. The notification fields report whether polling is paused and a claim is in flight; they do not report the durable notification backlog. A new process starts in `accepting` mode with a new instance ID, so a prior process token cannot resume it. Startup recovery runs only never-claimed queued tasks and closes interrupted running tasks without replay. Once SIGTERM/SIGINT cleanup starts, resume is rejected for that process.

If the configured graceful-drain deadline expires, SIGTERM cleanup aborts active work for a second bounded interval and exits nonzero. Any task still recorded as running is left for startup recovery, which records the interruption instead of claiming it again.

### 4.3 Running with Docker
A dedicated production Dockerfile is provided at `Dockerfile.executor`:

```bash
# Build Docker image
docker build -f Dockerfile.executor -t cyrene-navigator-executor:v0.2.0 .

# Run container
docker run -d \
  -p 8080:8080 \
  -v $(pwd)/plugins:/app/plugins \
  --name navigator-cloud \
  cyrene-navigator-executor:v0.2.0
```

---

## 5. Verification & Testing

Navigator includes a comprehensive verification suite:
- **Unit & Integration Suite**:
  ```bash
  node --test harness/tests/executor.integration.test.mjs
  ```
- **End-to-End Daemon Proof**:
  ```bash
  node scripts/proof/verify-cloud-executor.mjs
  ```
- **Component Packaging Validation**:
  ```bash
  python scripts/ci/generate_and_validate_manifest.py
  ```

---
<!-- Chinese Translation / 中文翻译 -->

## SIGTERM 与热更新前的排空

排空期间服务仍接收 HTTP 与 Teams 请求并将任务持久化为 `queued`，但停止新的任务认领和通知轮询。已开始的任务与已认领的通知批次自然完成；尚未认领的任务继续保存在 Work 队列中。

以下控制路由使用同一服务 Bearer 认证：

- `GET /internal/v1/executor/drain`：读取当前进程实例、排空代次/令牌、活动和排队任务数（`countsComplete` 表示持久 Work 列表是否完整读取）、dispatch 等待数，以及通知轮询状态和 `activeWorkDrained`。
- `POST /internal/v1/executor/drain`，请求体 `{}`：进入排空。重复请求返回本进程当前代次和令牌。
- `POST /internal/v1/executor/drain/resume`，请求体 `{"generation": 1, "token": "<本进程返回的令牌>"}`：仅匹配当前排空时恢复；旧令牌或代次返回 `409`。

`activeWorkDrained` 表示此进程没有仍在运行的任务、活动 dispatch 或已认领的通知投递。`queuedTasks` 可以继续大于零。通知字段只反映轮询是否暂停及当前是否有在途认领，不表示持久通知队列为空。新进程以新实例 ID 从 `accepting` 启动，旧进程令牌不能用于恢复它。启动恢复只执行从未认领的排队任务，并关闭中断的 running 任务，不会重放它们。SIGTERM/SIGINT 清理开始后，该进程会拒绝 resume。

如果 SIGTERM 排空期限到期，服务再用一个有界时间取消活动工作并以非零状态退出。退出时仍处于 running 的任务留给启动恢复记录为中断，不会再次认领。
