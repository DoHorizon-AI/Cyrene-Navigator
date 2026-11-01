"""Verify privileged DSH maintenance Task admission and actor binding."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from cyrene_navigator.persistence import PersistencePrincipal, create_persistence_app


def test_conversation_maintenance_tasks_require_trusted_actor_binding(tmp_path: Path) -> None:
    """Only a Harness worker can create the host-owned background task envelope."""

    principals = {
        "actor-token": PersistencePrincipal(
            "actor-a", frozenset({"workspace-a"}), can_takeover=True, organization_id="org-a"
        ),
        "worker-token": PersistencePrincipal(
            "actor-a",
            frozenset({"workspace-a"}),
            can_takeover=True,
            organization_id="org-a",
            can_write_harness=True,
            actor_private_scope=True,
        ),
    }
    with TestClient(create_persistence_app(tmp_path / "tasks.sqlite3", principals)) as client:
        conversation_base = "/api/v1/workspaces/workspace-a/work/conversation-memory"
        job_response = client.post(
            conversation_base + "/maintenance/jobs",
            json={"idempotencyKey": "dream-key-1", "kind": "dream"},
            headers={"Authorization": "Bearer actor-token"},
        )
        assert job_response.status_code == 201, job_response.text
        job = job_response.json()["job"]
        task_body = {
            "id": job["taskId"],
            "sessionId": job["taskId"],
            "prompt": "Run the typed conversation maintenance operation.",
            "executionClass": "background",
            "metadata": {
                "source": "conversation-maintenance",
                "maintenanceJobId": job["id"],
                "kind": job["kind"],
                "workspaceId": "workspace-a",
                "actorId": "actor-a",
                "idempotencyKey": job["idempotencyKey"],
                "jobVersion": job["queuedVersion"],
            },
        }
        base = "/api/v1/workspaces/workspace-a/work/tasks"
        denied = client.post(base, json=task_body, headers={"Authorization": "Bearer actor-token"})
        assert denied.status_code == 403

        wrong_actor = {
            **task_body,
            "metadata": {**task_body["metadata"], "actorId": "actor-b"},
        }
        mismatch = client.post(
            base, json=wrong_actor, headers={"Authorization": "Bearer worker-token"}
        )
        assert mismatch.status_code == 403

        created = client.post(
            base, json=task_body, headers={"Authorization": "Bearer worker-token"}
        )
        assert created.status_code == 201, created.text
        assert created.json()["createdByActorId"] == "actor-a"
        assert created.json()["executionClass"] == "background"
