# Conversation Artifact Bridge

This package provides a loopback HTTP bridge from fixed DirectPluginRuntime tool
bindings to actor-scoped Work attachments. The bridge does not accept paths,
URLs, or caller-selected credentials, and it stores no parallel task or
operation ledger.

The core host creates one `ActiveCallRegistry` with
`create_conversation_artifact_registry(work_store, source_authorizer=...)`, then
injects an `ArtifactBridgeConfig` through `PeripheralPorts.artifact_bridge`.
Immediately before a DSH provider call, register the exact task, arguments,
signed caller context, source grants, and output MIME policy with
`register_task_call`. Keep its returned lease open through the provider response
projection, close it in `finally`, and call
`revoke_task_calls(organization_id, workspace_id, task_id)` when a task is
cancelled or reaches a terminal state. Human-owned media operations use
`register_operation_call` and are already wired by
`conversation_peripheral.routes`.

| File | Responsibility |
| --- | --- |
| `models.py` | Immutable conversation source scope and attachment read grants. |
| `registry.py` | Task/operation-bound call leases, authorization rechecks, and output receipt tracking. |
| `routes.py` | Loopback-only `/v1/artifacts/read` and `/v1/artifacts/write` handlers. |

Suggested order: `models.py` → `registry.py` → `routes.py`.
