"""HTTP boundary tests for authenticated conversation domain routes."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from cyrene_navigator.persistence.errors import WORKSPACE_FORBIDDEN, PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_memory.domain_api import mount_domain_routes
from cyrene_navigator.work.conversation_memory.domains import (
    ConversationDomainStore,
    maintenance_task_id,
)

BASE = "/api/v1/workspaces/{workspace_id}/work"


class _FakeWorkStore:
    """Minimal actor-private WorkStore surface for terminal receipt tests."""

    def __init__(self) -> None:
        self.tasks: dict[tuple[str, str, str], dict[str, object]] = {}
        self.operations: dict[tuple[str, str, str], dict[str, object]] = {}

    def get_task(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> dict[str, object]:
        if not actor_private_scope or organization_id is None or actor_id is None:
            raise PersistenceError(WORKSPACE_FORBIDDEN, 403, "Private task scope required")
        task = self.tasks.get((organization_id, workspace_id, task_id))
        if task is None or task.get("createdByActorId") != actor_id:
            raise PersistenceError("WORK_TASK_NOT_FOUND", 404, "Task was not found")
        return task

    def get_operation(
        self,
        organization_id: str | None,
        workspace_id: str,
        operation_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> dict[str, object]:
        if not actor_private_scope or organization_id is None or actor_id is None:
            raise PersistenceError(WORKSPACE_FORBIDDEN, 403, "Private operation scope required")
        operation = self.operations.get((organization_id, workspace_id, operation_id))
        if operation is None:
            raise PersistenceError("WORK_OPERATION_NOT_FOUND", 404, "Operation was not found")
        task_id = operation.get("taskId")
        task = self.tasks.get((organization_id, workspace_id, str(task_id)))
        if task is None or task.get("createdByActorId") != actor_id:
            raise PersistenceError("WORK_OPERATION_NOT_FOUND", 404, "Operation was not found")
        return operation


class _FakeGraphProvider:
    """Provider fixture that reports independently read back graph counts."""

    def __init__(self, *, mismatch_digest: bool = False) -> None:
        self.mismatch_digest = mismatch_digest

    def apply_changeset(
        self,
        *,
        organization_id: str,
        workspace_id: str,
        actor_id: str,
        changeset: dict[str, object],
    ) -> dict[str, object]:
        assert (organization_id, workspace_id, actor_id) == ("org-a", "workspace-a", "actor-a")
        nodes = changeset["nodes"]
        edges = changeset["edges"]
        assert isinstance(nodes, list)
        assert isinstance(edges, list)
        return {
            "readbackDigest": ("0" * 64 if self.mismatch_digest else str(changeset["digest"])),
            "nodeCount": len(nodes),
            "edgeCount": len(edges),
        }

    def query(
        self,
        *,
        organization_id: str,
        workspace_id: str,
        actor_id: str,
        conversation_id: str,
        conversation_kind: str,
        persona_id: str | None,
        query: str,
        limit: int,
    ) -> dict[str, object]:
        assert (organization_id, workspace_id, actor_id) == ("org-a", "workspace-a", "actor-a")
        assert (conversation_id, conversation_kind, persona_id, query, limit) == (
            "conversation-1",
            "direct",
            None,
            "project",
            10,
        )
        return {
            "items": [
                {"id": "visible", "label": "Visible", "sourceMessageIds": ["source-visible"]},
                {"id": "revoked", "label": "Revoked", "sourceMessageIds": ["source-revoked"]},
            ]
        }


@pytest.fixture
def domain_api(
    tmp_path: Path,
) -> tuple[TestClient, ConversationDomainStore, list[tuple[object, ...]]]:
    store = ConversationDomainStore(tmp_path / "domain-api.sqlite3")
    source_checks: list[tuple[object, ...]] = []
    app = FastAPI()
    app.state.work_store = _FakeWorkStore()

    @app.exception_handler(PersistenceError)
    async def persistence_error(_request: Request, exc: PersistenceError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content={"code": exc.code, "detail": exc.detail},
            media_type="application/problem+json",
        )

    def principal_for(
        request: Request, workspace_id: str, *, write: bool = False
    ) -> PersistencePrincipal:
        if workspace_id != "workspace-a":
            raise PersistenceError(WORKSPACE_FORBIDDEN, 403, "Workspace is not available")
        if write and request.headers.get("x-write") != "true":
            raise PersistenceError(WORKSPACE_FORBIDDEN, 403, "Writer authorization is required")
        return PersistencePrincipal(
            actor_id=request.headers.get("x-actor", "actor-a"),
            workspace_ids=frozenset({workspace_id}),
            can_takeover=write,
            can_write_harness=request.headers.get("x-harness") == "true",
            organization_id="org-a",
            actor_private_scope=request.headers.get("x-actor-private") == "true",
        )

    def validate_source_ids(
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str | None,
        conversation_kind: str | None,
        persona_id: str | None,
        source_ids: list[str] | tuple[str, ...],
    ) -> None:
        source_checks.append(
            (
                organization_id,
                workspace_id,
                actor_id,
                conversation_id,
                conversation_kind,
                persona_id,
                tuple(source_ids),
            )
        )
        revoked_sources = {
            str(entry[1])
            for entry in source_checks
            if len(entry) == 2 and entry[0] == "__revoked__"
        }
        if "denied-source" in source_ids or revoked_sources.intersection(source_ids):
            raise PersistenceError("SOURCE_DENIED", 403, "Source is outside this actor scope")

    def validate_source_refs(
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str | None,
        conversation_kind: str | None,
        persona_id: str | None,
        source_refs: Sequence[Mapping[str, object]],
    ) -> None:
        source_ids = tuple(
            source_id
            for source_ref in source_refs
            for source_id in source_ref.get("sourceMessageIds", [])
            if isinstance(source_id, str)
        )
        revoked_memories = {
            str(entry[1])
            for entry in source_checks
            if len(entry) == 2 and entry[0] == "__revoked_memory__"
        }
        if any(source_ref.get("memoryId") in revoked_memories for source_ref in source_refs):
            raise PersistenceError("SOURCE_DENIED", 403, "Memory revision is no longer active")
        source_checks.append(
            (
                "__validated_refs__",
                tuple(
                    (
                        source_ref.get("memoryId"),
                        source_ref.get("memoryVersion"),
                        tuple(source_ref.get("sourceMessageIds", [])),
                    )
                    for source_ref in source_refs
                ),
            )
        )
        validate_source_ids(
            organization_id,
            workspace_id,
            actor_id,
            conversation_id,
            conversation_kind,
            persona_id,
            source_ids,
        )

    mount_domain_routes(
        app,
        BASE,
        principal_for,
        store,
        validate_source_ids,
        validate_source_refs=validate_source_refs,
    )
    return TestClient(app), store, source_checks


def _write_headers(actor: str = "actor-a") -> dict[str, str]:
    return {"X-Actor": actor, "X-Write": "true"}


def _worker_headers(actor: str = "actor-a") -> dict[str, str]:
    return {
        "X-Actor": actor,
        "X-Write": "true",
        "X-Harness": "true",
        "X-Actor-Private": "true",
    }


def _seed_maintenance_task(
    client: TestClient, job: dict[str, object], *, status: str, output: str = ""
) -> str:
    task_id = maintenance_task_id("workspace-a", "actor-a", str(job["id"]))
    task = {
        "id": task_id,
        "workspaceId": "workspace-a",
        "createdByActorId": "actor-a",
        "status": status,
        "output": output,
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
    client.app.state.work_store.tasks[("org-a", "workspace-a", task_id)] = task
    return task_id


def _seed_skill_receipts(
    client: TestClient, *, content: str, valid_readback: bool = True
) -> tuple[str, str]:
    work_store = client.app.state.work_store
    task_specs = (
        ("skill-verify-task", "verified skill operation output"),
        ("skill-readback-task", "independent skill readback output"),
    )
    for task_id, output in task_specs:
        work_store.tasks[("org-a", "workspace-a", task_id)] = {
            "id": task_id,
            "workspaceId": "workspace-a",
            "createdByActorId": "actor-a",
            "status": "completed",
            "output": output,
            "metadata": {},
        }
    verify_id = "skill-verify-receipt"
    read_id = "skill-readback-receipt"
    work_store.operations[("org-a", "workspace-a", verify_id)] = {
        "id": verify_id,
        "operationType": "conversation.skill.verify",
        "taskId": "skill-verify-task",
        "status": "verified",
        "evidence": {
            "taskOutputSha256": hashlib.sha256(task_specs[0][1].encode()).hexdigest(),
            "readbackReceiptId": read_id,
        },
    }
    content_digest = hashlib.sha256(content.encode()).hexdigest()
    if not valid_readback:
        content_digest = "0" * 64
    work_store.operations[("org-a", "workspace-a", read_id)] = {
        "id": read_id,
        "operationType": "conversation.skill.readback",
        "taskId": "skill-readback-task",
        "status": "verified",
        "evidence": {
            "taskOutputSha256": hashlib.sha256(task_specs[1][1].encode()).hexdigest(),
            "contentSha256": content_digest,
        },
    }
    return verify_id, read_id


def test_policy_defaults_are_unpersisted_and_updates_use_cas(
    domain_api: tuple[TestClient, ConversationDomainStore, list[tuple[object, ...]]],
) -> None:
    client, store, _ = domain_api
    url = "/api/v1/workspaces/workspace-a/work/policies/active-behavior"
    default = client.get(url, params={"conversationId": "conversation-1"})
    assert default.status_code == 200
    assert default.json() == {
        "policy": {
            "conversationId": "conversation-1",
            "enabled": False,
            "quietHours": {"timeZone": "UTC", "start": "22:00", "end": "08:00"},
            "cooldownSeconds": 900,
            "allowGroupInterjections": False,
            "followupEnabled": False,
            "version": 0,
        }
    }
    assert (
        store.get_active_behavior_policy("org-a", "workspace-a", "actor-a", "conversation-1")
        is None
    )

    body = {
        "conversationId": "conversation-1",
        "enabled": True,
        "quietHours": {"timeZone": "UTC", "start": "21:00", "end": "08:00"},
        "cooldownSeconds": 600,
        "allowGroupInterjections": False,
        "followupEnabled": True,
    }
    created = client.put(url, json=body, headers=_write_headers())
    assert created.status_code == 200
    assert created.json()["policy"]["version"] == 1

    changed = {**body, "cooldownSeconds": 1_200, "expectedVersion": 1}
    updated = client.put(url, json=changed, headers=_write_headers())
    assert updated.status_code == 200
    assert updated.json()["policy"]["version"] == 2
    stale = client.put(
        url,
        json={**changed, "cooldownSeconds": 1_800},
        headers=_write_headers(),
    )
    assert stale.status_code == 409
    assert stale.json()["code"] == "CONVERSATION_DOMAIN_CONFLICT"


def test_maintenance_owner_can_cancel_but_only_harness_worker_can_checkpoint(
    domain_api: tuple[TestClient, ConversationDomainStore, list[tuple[object, ...]]],
) -> None:
    client, _, _ = domain_api
    base = "/api/v1/workspaces/workspace-a/work/maintenance/jobs"
    create = {
        "idempotencyKey": "owner-job",
        "kind": "dream",
        "conversationId": "conversation-1",
        "conversationKind": "direct",
    }
    job_response = client.post(base, json=create, headers=_write_headers())
    assert job_response.status_code == 201
    job_id = job_response.json()["job"]["id"]

    checkpoint = {
        "expectedVersion": 1,
        "checkpoint": {
            "cursor": "next-page",
            "processedCount": 1,
            "checkpointDigest": "a" * 64,
            "details": {"state": "completed", "taskId": "unused", "taskOutputSha256": "0" * 64},
        },
    }
    owner_checkpoint = client.patch(
        f"{base}/{job_id}/checkpoint", json=checkpoint, headers=_write_headers()
    )
    assert owner_checkpoint.status_code == 403
    assert client.get(f"{base}/{job_id}").json()["state"] == "queued"
    harness_without_private_scope = client.patch(
        f"{base}/{job_id}/checkpoint",
        json=checkpoint,
        headers={"X-Actor": "actor-a", "X-Write": "true", "X-Harness": "true"},
    )
    assert harness_without_private_scope.status_code == 403

    cancelled = client.post(
        f"{base}/{job_id}/cancel",
        json={"expectedVersion": 1},
        headers=_write_headers(),
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["job"]["state"] == "cancelled"
    assert cancelled.json()["job"]["version"] == 2

    worker_checkpoint = client.patch(
        f"{base}/{job_id}/checkpoint", json=checkpoint, headers=_worker_headers()
    )
    assert worker_checkpoint.status_code == 409
    assert worker_checkpoint.json()["code"] == "CONVERSATION_DOMAIN_CONFLICT"

    second = client.post(
        base,
        json={**create, "idempotencyKey": "worker-job"},
        headers=_write_headers(),
    )
    second_job = second.json()["job"]
    second_id = second_job["id"]
    task_id = _seed_maintenance_task(client, second_job, status="running")
    running_checkpoint = {
        "expectedVersion": 1,
        "checkpoint": {
            "cursor": "page-2",
            "processedCount": 1,
            "checkpointDigest": "b" * 64,
            "details": {"state": "running"},
        },
    }
    running = client.patch(
        f"{base}/{second_id}/checkpoint",
        json=running_checkpoint,
        headers=_worker_headers(),
    )
    assert running.status_code == 200
    assert running.json()["job"]["state"] == "running"
    work_task = client.app.state.work_store.tasks[("org-a", "workspace-a", task_id)]
    work_task["status"] = "completed"
    work_task["output"] = "finished output"
    terminal_checkpoint = {
        "expectedVersion": 2,
        "checkpoint": {
            "cursor": "page-3",
            "processedCount": 2,
            "checkpointDigest": "c" * 64,
            "details": {
                "state": "completed",
                "taskId": task_id,
                "taskOutputSha256": "0" * 64,
            },
        },
    }
    bad_receipt = client.patch(
        f"{base}/{second_id}/checkpoint",
        json=terminal_checkpoint,
        headers=_worker_headers(),
    )
    assert bad_receipt.status_code == 409
    assert bad_receipt.json()["code"] == "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED"

    terminal_checkpoint["checkpoint"]["details"]["taskOutputSha256"] = hashlib.sha256(
        b"finished output"
    ).hexdigest()
    completed = client.patch(
        f"{base}/{second_id}/checkpoint",
        json=terminal_checkpoint,
        headers=_worker_headers(),
    )
    assert completed.status_code == 200
    assert completed.json()["job"]["state"] == "completed"
    assert completed.json()["job"]["queuedVersion"] == 1

    third = client.post(
        base,
        json={**create, "idempotencyKey": "worker-cancel-job"},
        headers=_write_headers(),
    )
    third_job = third.json()["job"]
    third_id = third_job["id"]
    task_id = _seed_maintenance_task(client, third_job, status="running")
    running = client.patch(
        f"{base}/{third_id}/checkpoint",
        json=running_checkpoint,
        headers=_worker_headers(),
    )
    assert running.status_code == 200
    cancel_url = f"{base}/{third_id}/cancel"
    active_task_cancel = client.post(
        cancel_url,
        json={"expectedVersion": 2},
        headers=_write_headers(),
    )
    assert active_task_cancel.status_code == 409
    assert active_task_cancel.json()["code"] == "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED"
    client.app.state.work_store.tasks[("org-a", "workspace-a", task_id)]["status"] = "aborted"
    cancelled_running = client.post(
        cancel_url,
        json={"expectedVersion": 2},
        headers=_write_headers(),
    )
    assert cancelled_running.status_code == 200
    assert cancelled_running.json()["job"]["state"] == "cancelled"


def test_routes_require_writer_and_reject_body_identity_fields(
    domain_api: tuple[TestClient, ConversationDomainStore, list[tuple[object, ...]]],
) -> None:
    client, store, _ = domain_api
    url = "/api/v1/workspaces/workspace-a/work/personas"
    persona = {
        "id": "persona-1",
        "name": "Direct",
        "prompt": "Use clear sourced answers.",
        "enabled": True,
    }
    denied = client.put(url, json=persona)
    assert denied.status_code == 403

    injected = client.put(url, json={**persona, "actorId": "actor-b"}, headers=_write_headers())
    assert injected.status_code == 422
    assert store.list_personas("org-a", "workspace-a", "actor-a") == []


def test_source_context_is_checked_before_profile_write(
    domain_api: tuple[TestClient, ConversationDomainStore, list[tuple[object, ...]]],
) -> None:
    client, store, source_checks = domain_api
    url = "/api/v1/workspaces/workspace-a/work/profile-candidates"
    body = {
        "idempotencyKey": "profile-1",
        "conversationId": "conversation-1",
        "conversationKind": "group",
        "subjectKind": "group",
        "personaId": "persona-1",
        "category": "preference",
        "text": "Use the group terminology.",
        "sourceMessageIds": ["denied-source"],
        "confidence": 0.8,
    }
    denied = client.post(url, json=body, headers=_write_headers())
    assert denied.status_code == 403
    assert denied.json()["code"] == "SOURCE_DENIED"
    assert source_checks[-1] == (
        "org-a",
        "workspace-a",
        "actor-a",
        "conversation-1",
        "group",
        "persona-1",
        ("denied-source",),
    )
    assert store.list_profile_candidates("org-a", "workspace-a", "actor-a") == []


def test_revoked_sources_hide_records_and_block_activate_or_graph_apply(
    domain_api: tuple[TestClient, ConversationDomainStore, list[tuple[object, ...]]],
) -> None:
    client, _, source_checks = domain_api
    base = "/api/v1/workspaces/workspace-a/work"
    source_id = "source-revoke-after-create"
    profile_body = {
        "idempotencyKey": "revocation-profile-active",
        "conversationId": "conversation-revoke",
        "conversationKind": "group",
        "subjectKind": "group",
        "category": "preference",
        "text": "Use the established project term.",
        "sourceMessageIds": [source_id],
        "confidence": 0.9,
    }
    first = client.post(base + "/profile-candidates", json=profile_body, headers=_write_headers())
    assert first.status_code == 201
    first_id = first.json()["candidate"]["id"]
    assert (
        client.post(
            f"{base}/profile-candidates/{first_id}/activate",
            json={"expectedVersion": 1},
            headers=_write_headers(),
        ).status_code
        == 200
    )

    pending_body = {**profile_body, "idempotencyKey": "revocation-profile-pending"}
    pending = client.post(base + "/profile-candidates", json=pending_body, headers=_write_headers())
    assert pending.status_code == 201
    pending_id = pending.json()["candidate"]["id"]

    graph = client.post(
        base + "/graph/proposals",
        json={
            "idempotencyKey": "revocation-graph",
            "conversationId": "conversation-revoke",
            "conversationKind": "group",
            "nodes": [{"id": "node-revoke", "label": "Project", "sourceMessageIds": [source_id]}],
            "edges": [],
        },
        headers=_write_headers(),
    )
    assert graph.status_code == 201
    graph_id = graph.json()["changeset"]["id"]

    source_checks.append(("__revoked__", source_id))
    assert client.get(base + "/profile-candidates").json()["items"] == []
    assert (
        client.get(base + "/profiles", params={"conversationId": "conversation-revoke"}).json()[
            "items"
        ]
        == []
    )
    assert client.get(base + "/graph/changesets").json()["items"] == []

    activate = client.post(
        f"{base}/profile-candidates/{pending_id}/activate",
        json={"expectedVersion": 1},
        headers=_write_headers(),
    )
    assert activate.status_code == 409
    assert activate.json()["code"] == "CONVERSATION_DOMAIN_SOURCE_UNAVAILABLE"
    apply_graph = client.post(
        f"{base}/graph/changesets/{graph_id}/apply",
        json={"expectedVersion": 1},
        headers=_write_headers(),
    )
    assert apply_graph.status_code == 409
    assert apply_graph.json()["code"] == "CONVERSATION_DOMAIN_SOURCE_UNAVAILABLE"


def test_profiles_list_exposes_bounded_active_context_and_actor_scope(
    domain_api: tuple[TestClient, ConversationDomainStore, list[tuple[object, ...]]],
) -> None:
    client, _, _ = domain_api
    base = "/api/v1/workspaces/workspace-a/work"
    candidate_body = {
        "idempotencyKey": "profile-for-context",
        "conversationId": "conversation-1",
        "conversationKind": "direct",
        "subjectKind": "user",
        "category": "preference",
        "text": "Prefers concise answers.",
        "sourceMessageIds": ["source-context"],
        "confidence": 0.95,
    }
    created = client.post(
        base + "/profile-candidates", json=candidate_body, headers=_write_headers()
    )
    assert created.status_code == 201
    candidate_id = created.json()["candidate"]["id"]
    activated = client.post(
        f"{base}/profile-candidates/{candidate_id}/activate",
        json={"expectedVersion": 1},
        headers=_write_headers(),
    )
    assert activated.status_code == 200

    listed = client.get(
        base + "/profiles",
        params={"conversationId": "conversation-1", "state": "active", "limit": 1},
    )
    assert listed.status_code == 200
    assert len(listed.json()["items"]) == 1
    assert listed.json()["items"][0]["id"] == activated.json()["profile"]["id"]
    assert listed.json()["items"][0]["sourceMessageIds"] == ["source-context"]

    other_actor = client.get(
        base + "/profiles",
        params={"conversationId": "conversation-1"},
        headers={"X-Actor": "actor-b"},
    )
    assert other_actor.status_code == 200
    assert other_actor.json()["items"] == []


def test_watch_schedule_revalidates_source_and_uses_owner_cas(
    domain_api: tuple[TestClient, ConversationDomainStore, list[tuple[object, ...]]],
) -> None:
    client, _, source_checks = domain_api
    base = "/api/v1/workspaces/workspace-a/work"
    created = client.post(
        base + "/watches",
        json={
            "idempotencyKey": "schedule-watch",
            "conversationId": "conversation-1",
            "conversationKind": "direct",
            "title": "Release date",
            "condition": "Watch for a date change.",
            "sourceRefs": ["watch-source"],
        },
        headers=_write_headers(),
    )
    assert created.status_code == 201
    watch_id = created.json()["watch"]["id"]
    schedule_url = f"{base}/watches/{watch_id}/schedule"
    scheduled = client.put(
        schedule_url,
        json={"expectedVersion": 1, "nextCheckAt": 1_800_000_000_000},
        headers=_write_headers(),
    )
    assert scheduled.status_code == 200
    assert scheduled.json()["watch"]["version"] == 2
    assert scheduled.json()["watch"]["nextCheckAt"] == 1_800_000_000_000
    replay = client.put(
        schedule_url,
        json={"expectedVersion": 1, "nextCheckAt": 1_800_000_000_000},
        headers=_write_headers(),
    )
    assert replay.status_code == 200
    assert replay.json()["watch"]["version"] == 2

    source_checks.append(("__revoked__", "watch-source"))
    revoked = client.put(
        schedule_url,
        json={"expectedVersion": 2, "nextCheckAt": None},
        headers=_write_headers(),
    )
    assert revoked.status_code == 409
    assert revoked.json()["code"] == "CONVERSATION_DOMAIN_SOURCE_UNAVAILABLE"
    source_checks.remove(("__revoked__", "watch-source"))

    cancel = client.post(
        f"{base}/watches/{watch_id}/cancel",
        json={"expectedVersion": 2},
        headers=_write_headers(),
    )
    assert cancel.status_code == 200
    after_cancel = client.put(
        schedule_url,
        json={"expectedVersion": 3, "nextCheckAt": None},
        headers=_write_headers(),
    )
    assert after_cancel.status_code == 409


def test_skill_verification_requires_independent_work_operation_receipts(
    domain_api: tuple[TestClient, ConversationDomainStore, list[tuple[object, ...]]],
) -> None:
    client, _, _ = domain_api
    base = "/api/v1/workspaces/workspace-a/work/research/skills"
    body = {
        "idempotencyKey": "verified-skill",
        "conversationId": "conversation-1",
        "conversationKind": "direct",
        "name": "Sourced summary",
        "content": "Summarize the cited decision.",
        "sourceRefs": [
            {
                "memoryId": "memory-1",
                "memoryVersion": 3,
                "sourceMessageIds": ["source-skill"],
            }
        ],
    }
    missing = client.post(base, json=body, headers=_write_headers())
    assert missing.status_code == 422

    verify_id, read_id = _seed_skill_receipts(client, content=body["content"], valid_readback=False)
    submitted = {
        **body,
        "operationReceiptId": verify_id,
        "independentReadReceiptId": read_id,
    }
    denied = client.post(base, json=submitted, headers=_write_headers())
    assert denied.status_code == 409
    assert denied.json()["code"] == "WORK_OPERATION_VERIFICATION_REQUIRED"

    _seed_skill_receipts(client, content=body["content"])
    created = client.post(
        base,
        json={**submitted, "verifiedBy": "actor-spoof"},
        headers=_write_headers(),
    )
    assert created.status_code == 422
    created = client.post(base, json=submitted, headers=_write_headers())
    assert created.status_code == 201
    skill = created.json()["skill"]
    assert skill["verified"] is True
    assert skill["verifiedBy"] == "actor-a"
    assert skill["operationReceiptId"] == verify_id
    assert skill["independentReadReceiptId"] == read_id


def test_graph_query_is_unavailable_and_never_returns_fixture_hits(
    domain_api: tuple[TestClient, ConversationDomainStore, list[tuple[object, ...]]],
) -> None:
    client, _, _ = domain_api
    response = client.post(
        "/api/v1/workspaces/workspace-a/work/graph/query",
        json={
            "conversationId": "conversation-1",
            "conversationKind": "direct",
            "query": "project",
            "limit": 10,
        },
    )
    assert response.status_code == 503
    assert response.json()["code"] == "GRAPH_PROVIDER_UNAVAILABLE"
    assert "items" not in response.json()


def test_graph_provider_readback_is_persisted_and_query_results_reauthorize_sources(
    domain_api: tuple[TestClient, ConversationDomainStore, list[tuple[object, ...]]],
) -> None:
    client, _, source_checks = domain_api
    client.app.state.graph_provider = _FakeGraphProvider(mismatch_digest=True)
    base = "/api/v1/workspaces/workspace-a/work"
    proposal = client.post(
        base + "/graph/proposals",
        json={
            "idempotencyKey": "provider-proposal",
            "conversationId": "conversation-1",
            "conversationKind": "direct",
            "nodes": [{"id": "node-1", "label": "Project", "sourceMessageIds": ["source-a"]}],
            "edges": [],
        },
        headers=_write_headers(),
    )
    assert proposal.status_code == 201
    changeset_id = proposal.json()["changeset"]["id"]
    bad_readback = client.post(
        f"{base}/graph/changesets/{changeset_id}/apply",
        json={"expectedVersion": 1},
        headers=_write_headers(),
    )
    assert bad_readback.status_code == 502
    assert bad_readback.json()["code"] == "GRAPH_PROVIDER_READBACK_MISMATCH"
    listed = client.get(base + "/graph/changesets")
    assert listed.json()["items"][0]["state"] == "proposed"

    client.app.state.graph_provider = _FakeGraphProvider()
    applied = client.post(
        f"{base}/graph/changesets/{changeset_id}/apply",
        json={"expectedVersion": 1},
        headers=_write_headers(),
    )
    assert applied.status_code == 200
    assert applied.json()["changeset"]["state"] == "projected"
    assert applied.json()["changeset"]["providerStatus"] == "applied"
    assert applied.json()["changeset"]["providerApplied"] is True
    assert applied.json()["changeset"]["providerReceipt"]["nodeCount"] == 1

    source_checks.append(("__revoked__", "source-revoked"))
    query = client.post(
        base + "/graph/query",
        json={
            "conversationId": "conversation-1",
            "conversationKind": "direct",
            "query": "project",
            "limit": 10,
        },
        headers={"X-Actor": "actor-a"},
    )
    assert query.status_code == 200
    assert [item["id"] for item in query.json()["items"]] == ["visible"]


def test_daily_review_event_allows_empty_lineage_only_with_exact_report_scope(
    domain_api: tuple[TestClient, ConversationDomainStore, list[tuple[object, ...]]],
) -> None:
    """A no-message review stores only its verified report pointer and exact chat scope."""

    client, _, _ = domain_api
    base = "/api/v1/workspaces/workspace-a/work/review-events"
    body = {
        "idempotencyKey": "daily-review-empty-window",
        "eventType": "daily_review",
        "summary": json.dumps(
            {"report": {"artifactId": "review-artifact-1", "sha256": "a" * 64, "sizeBytes": 128}},
            separators=(",", ":"),
        ),
        "sourceRefs": [],
        "conversationId": "conversation-1",
        "conversationKind": "direct",
        "personaId": "conversation-assistant",
    }
    created = client.post(base, json=body, headers=_write_headers())
    assert created.status_code == 201, created.text
    event = created.json()["event"]
    assert event["eventType"] == "daily_review"
    assert event["sourceRefs"] == []
    assert event["conversationId"] == "conversation-1"
    assert event["personaId"] == "conversation-assistant"

    duplicate = client.post(base, json=body, headers=_write_headers())
    assert duplicate.status_code == 200, duplicate.text
    assert duplicate.json()["event"]["id"] == event["id"]

    no_report = client.post(
        base,
        json={**body, "idempotencyKey": "daily-review-missing-report", "summary": "No report."},
        headers=_write_headers(),
    )
    assert no_report.status_code == 422

    ordinary_empty = client.post(
        base,
        json={**body, "idempotencyKey": "reviewed-empty", "eventType": "reviewed"},
        headers=_write_headers(),
    )
    assert ordinary_empty.status_code == 422


def test_import_responses_only_return_counts_and_digest(
    domain_api: tuple[TestClient, ConversationDomainStore, list[tuple[object, ...]]],
) -> None:
    client, store, _ = domain_api
    body = {
        "batchId": "batch-1",
        "sourceKind": "legacy_notes",
        "records": [
            {
                "recordId": "safe-note",
                "kind": "researchNote",
                "conversationId": "conversation-1",
                "conversationKind": "direct",
                "text": "Private sourced note.",
                "sourceRefs": ["source-1"],
                "visibility": "private",
            },
            {
                "recordId": "credentials-row",
                "kind": "credentials",
                "text": "Must be quarantined.",
                "sourceRefs": ["source-2"],
                "visibility": "private",
            },
        ],
    }
    preview = client.post(
        "/api/v1/workspaces/workspace-a/work/imports/preview",
        json=body,
        headers={"X-Actor": "actor-a"},
    )
    assert preview.status_code == 200
    assert set(preview.json()) == {"recordCount", "acceptedCount", "quarantinedCount", "digest"}
    assert preview.json()["acceptedCount"] == 1
    assert preview.json()["quarantinedCount"] == 1
    assert "Private sourced note." not in preview.text
    with sqlite3.connect(store.db_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM import_batches").fetchone()[0] == 0

    applied = client.post(
        "/api/v1/workspaces/workspace-a/work/imports",
        json=body,
        headers=_write_headers(),
    )
    assert applied.status_code == 201
    assert applied.json() == {
        "batchId": "batch-1",
        "importedCount": 1,
        "quarantinedCount": 1,
        "digest": preview.json()["digest"],
    }
    assert "Private sourced note." not in applied.text


def test_actor_backup_export_includes_only_the_authenticated_actor(
    domain_api: tuple[TestClient, ConversationDomainStore, list[tuple[object, ...]]],
) -> None:
    client, store, _ = domain_api
    url = "/api/v1/workspaces/workspace-a/work/research/notes"
    for actor, key, conversation_id, text in (
        ("actor-a", "note-a", "conversation-a", "Actor A record."),
        ("actor-b", "note-b", "conversation-b", "Actor B private record."),
    ):
        response = client.post(
            url,
            json={
                "idempotencyKey": key,
                "conversationId": conversation_id,
                "conversationKind": "direct",
                "title": "Backup record",
                "content": text,
                "sourceRefs": ["source-a" if actor == "actor-a" else "source-b"],
            },
            headers=_write_headers(actor),
        )
        assert response.status_code == 201

    backup = store.export_actor_backup("org-a", "workspace-a", "actor-a")
    document = json.loads(backup)
    notes = document["records"]["researchNotes"]
    assert [item["content"] for item in notes] == ["Actor A record."]
    assert "Actor B private record." not in backup.decode("utf-8")
    assert "actor-a" not in backup.decode("utf-8")
