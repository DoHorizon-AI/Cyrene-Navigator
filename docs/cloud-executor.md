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

### 4.2 Running with Docker
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
