"""HTTP boundary tests for actor-owned Bilibili intent and run plans."""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from cyrene_navigator.persistence.errors import WORKSPACE_FORBIDDEN, PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_memory.bilibili_domain_api import (
    mount_bilibili_routes,
)
from cyrene_navigator.work.conversation_memory.bilibili_domains import BilibiliDomainStore

BASE = "/api/v1/workspaces/workspace-a/work/conversation-memory/bilibili"
ROUTE = "/api/v1/workspaces/{workspace_id}/work/conversation-memory/bilibili"


class _FakeWorkStore:
    """Actor-private receipt lookup fixture; no evidence is trusted by default."""

    def __init__(self) -> None:
        self.operations: dict[str, dict[str, object]] = {}
        self.tasks: dict[str, dict[str, object]] = {}
        self.notifications: dict[str, dict[str, object]] = {}

    def get_operation(
        self,
        organization_id: str | None,
        workspace_id: str,
        operation_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> Mapping[str, object]:
        if organization_id != "org-a" or workspace_id != "workspace-a" or not actor_private_scope:
            raise PersistenceError(WORKSPACE_FORBIDDEN, 403, "Private operation scope required")
        row = self.operations.get(operation_id)
        if row is None:
            raise PersistenceError("WORK_OPERATION_NOT_FOUND", 404, "Operation was not found")
        return row

    def get_task(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> Mapping[str, object]:
        if organization_id != "org-a" or workspace_id != "workspace-a" or not actor_private_scope:
            raise PersistenceError(WORKSPACE_FORBIDDEN, 403, "Private task scope required")
        row = self.tasks.get(task_id)
        if row is None:
            raise PersistenceError("WORK_TASK_NOT_FOUND", 404, "Task was not found")
        return row

    def get_notification(
        self,
        organization_id: str | None,
        workspace_id: str,
        notification_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> Mapping[str, object]:
        if organization_id != "org-a" or workspace_id != "workspace-a" or not actor_private_scope:
            raise PersistenceError(WORKSPACE_FORBIDDEN, 403, "Private notification scope required")
        row = self.notifications.get(notification_id)
        if row is None:
            raise PersistenceError("WORK_NOTIFICATION_NOT_FOUND", 404, "Notification was not found")
        return row


@pytest.fixture
def domain_api(
    tmp_path: Path,
) -> tuple[TestClient, BilibiliDomainStore, dict[str, Any]]:
    store = BilibiliDomainStore(tmp_path / "bilibili-domain-api.sqlite3")
    work_store = _FakeWorkStore()
    state: dict[str, Any] = {
        "revoked": set(),
        "preflight_enabled": False,
        "preflight_calls": [],
        "work_store": work_store,
    }
    app = FastAPI()
    app.state.work_store = work_store

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

    def validate_source_refs(
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str | None,
        conversation_kind: str | None,
        persona_id: str | None,
        source_refs: Sequence[Mapping[str, object]],
    ) -> None:
        assert organization_id == "org-a"
        assert workspace_id == "workspace-a"
        assert actor_id in {"actor-a", "actor-b"}
        assert conversation_id == "conversation-a"
        assert conversation_kind == "direct"
        assert persona_id is None
        source_ids = {
            message_id
            for ref in source_refs
            for message_id in ref.get("sourceMessageIds", [])
            if isinstance(message_id, str)
        }
        if source_ids.intersection(state["revoked"]):
            raise PersistenceError("SOURCE_REVOKED", 403, "Source is no longer authorized")

    def resolve_connection(
        organization_id: str,
        workspace_id: str,
        actor_id: str,
        connection_ref: str,
        profile_ref: str,
    ) -> str:
        assert (organization_id, workspace_id) == ("org-a", "workspace-a")
        assert actor_id in {"actor-a", "actor-b"}
        assert (connection_ref, profile_ref) == ("connection-a", "profile-a")
        return "external-user-a"

    def trusted_turn_context(
        _request: Request, workspace_id: str, principal: PersistencePrincipal
    ) -> Mapping[str, str]:
        assert workspace_id == "workspace-a"
        assert principal.actor_id == "actor-a"
        return {"taskId": "parent-task-a", "sessionId": "parent-session-a"}

    def preflight_operation(
        organization_id: str,
        workspace_id: str,
        actor_id: str,
        connection_ref: str,
        profile_ref: str,
        operation_id: str,
        target: Mapping[str, object],
        arguments: Mapping[str, object],
    ) -> Mapping[str, object]:
        call = {
            "organizationId": organization_id,
            "workspaceId": workspace_id,
            "actorId": actor_id,
            "connectionRef": connection_ref,
            "profileRef": profile_ref,
            "operationId": operation_id,
            "target": dict(target),
            "arguments": dict(arguments),
        }
        state["preflight_calls"].append(call)
        if not state["preflight_enabled"]:
            raise PersistenceError(
                "BILIBILI_PROVIDER_PREFLIGHT_UNAVAILABLE",
                503,
                "No Exchange preflight is configured",
            )
        return {
            "grantRef": "exchange-grant-a",
            "proofDigest": "a" * 64,
            "expiresAt": time.time_ns() // 1_000_000 + 5_000,
        }

    mount_bilibili_routes(
        app,
        ROUTE,
        principal_for,
        store,
        validate_source_refs,
        resolve_connection,
        trusted_turn_context,
        preflight_operation,
        work_store,
    )
    return TestClient(app), store, state


def _sha(value: object) -> str:
    serialized = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(serialized.encode()).hexdigest()


def _source_refs() -> list[dict[str, object]]:
    return [{"memoryId": None, "memoryVersion": None, "sourceMessageIds": ["message-a"]}]


def _delegation_body(*, expires_at: int, arguments: Mapping[str, object]) -> dict[str, object]:
    return {
        "idempotencyKey": "delegation-key-a",
        "connectionRef": "connection-a",
        "profileRef": "profile-a",
        "conversationId": "conversation-a",
        "conversationKind": "direct",
        "expiresAt": expires_at,
        "grants": [
            {
                "operationId": "bilibili.video.read",
                "target": {"video_id": arguments["video_id"]},
                "argumentsDigestSha256": _sha(arguments),
            }
        ],
        "sourceRefs": _source_refs(),
    }


def _write_headers(actor: str = "actor-a", *, worker: bool = False) -> dict[str, str]:
    headers = {"X-Actor": actor, "X-Write": "true"}
    if worker:
        headers["X-Harness"] = "true"
        headers["X-Actor-Private"] = "true"
    return headers


def test_delegation_routes_enforce_owner_scope_source_revocation_and_exact_preflight(
    domain_api: tuple[TestClient, BilibiliDomainStore, dict[str, Any]],
) -> None:
    client, _store, state = domain_api
    now = time.time_ns() // 1_000_000
    arguments = {"video_id": "BV1abc"}
    body = _delegation_body(expires_at=now + 60_000, arguments=arguments)

    response = client.post(BASE + "/delegations", json={**body, "actorId": "actor-b"})
    assert response.status_code == 422
    assert client.post(BASE + "/delegations", json=body).status_code == 403
    wildcard = client.post(
        BASE + "/delegations",
        json={
            **body,
            "idempotencyKey": "wildcard-delegation",
            "grants": [
                {
                    "operationId": "bilibili.video.read",
                    "target": {"video_id": "*"},
                    "argumentsDigestSha256": _sha(arguments),
                }
            ],
        },
        headers=_write_headers(),
    )
    assert wildcard.status_code == 422

    created = client.post(BASE + "/delegations", json=body, headers=_write_headers())
    assert created.status_code == 201
    delegation = created.json()["delegation"]
    delegation_id = delegation["id"]
    assert delegation["ownerActorId"] == "actor-a"

    other_actor = client.get(BASE + f"/delegations/{delegation_id}", headers={"X-Actor": "actor-b"})
    assert other_actor.status_code == 404

    state["revoked"].add("message-a")
    hidden = client.get(BASE + "/delegations", headers={"X-Actor": "actor-a"})
    assert hidden.status_code == 200
    assert hidden.json()["items"] == []
    denied = client.get(BASE + f"/delegations/{delegation_id}", headers={"X-Actor": "actor-a"})
    assert denied.status_code == 409
    assert denied.json()["code"] == "BILIBILI_DOMAIN_SOURCE_UNAVAILABLE"

    state["revoked"].clear()
    wrong_digest = client.post(
        BASE + f"/delegations/{delegation_id}/authorize",
        json={
            "operationId": "bilibili.video.read",
            "target": {"video_id": "BV1abc"},
            "arguments": {"video_id": "BV1other"},
            "argumentsDigestSha256": _sha(arguments),
        },
    )
    assert wrong_digest.status_code == 422
    assert wrong_digest.json()["code"] == "BILIBILI_ARGUMENTS_DIGEST_MISMATCH"

    unavailable = client.post(
        BASE + f"/delegations/{delegation_id}/authorize",
        json={
            "operationId": "bilibili.video.read",
            "target": {"video_id": "BV1abc"},
            "arguments": arguments,
            "argumentsDigestSha256": _sha(arguments),
        },
    )
    assert unavailable.status_code == 503
    assert unavailable.json()["code"] == "BILIBILI_PROVIDER_PREFLIGHT_UNAVAILABLE"

    state["preflight_enabled"] = True
    authorized = client.post(
        BASE + f"/delegations/{delegation_id}/authorize",
        json={
            "operationId": "bilibili.video.read",
            "target": {"video_id": "BV1abc"},
            "arguments": arguments,
            "argumentsDigestSha256": _sha(arguments),
        },
    )
    assert authorized.status_code == 200
    assert authorized.json()["freshGrantRef"] == "exchange-grant-a"
    assert state["preflight_calls"][-1]["arguments"] == arguments


def test_subscription_claim_replays_run_plan_and_missing_producer_marker_fails_closed(
    domain_api: tuple[TestClient, BilibiliDomainStore, dict[str, Any]],
) -> None:
    client, store, state = domain_api
    now = time.time_ns() // 1_000_000
    arguments = {"video_id": "BV1abc"}
    created = client.post(
        BASE + "/delegations",
        json=_delegation_body(expires_at=now + 60_000, arguments=arguments),
        headers=_write_headers(),
    )
    assert created.status_code == 201
    delegation = created.json()["delegation"]
    subscription_response = client.post(
        BASE + "/subscriptions",
        json={
            "idempotencyKey": "subscription-key-a",
            "delegationId": delegation["id"],
            "connectionRef": "connection-a",
            "profileRef": "profile-a",
            "operationId": "bilibili.video.read",
            "resourceRef": delegation["grants"][0]["resourceRef"],
            "arguments": arguments,
            "sourceRefs": _source_refs(),
            "conversationId": "conversation-a",
            "conversationKind": "direct",
            "expiresAt": now + 50_000,
            "nextCheckAt": now - 1,
        },
        headers=_write_headers(),
    )
    assert subscription_response.status_code == 201
    subscription = subscription_response.json()["subscription"]
    subscription_id = subscription["id"]
    assert subscription["ownerTaskId"] == "parent-task-a"
    assert subscription["ownerSessionId"] == "parent-session-a"

    worker_headers = _write_headers(worker=True)
    state["revoked"].add("message-a")
    hidden_subscriptions = client.get(BASE + "/subscriptions", headers={"X-Actor": "actor-a"})
    assert hidden_subscriptions.status_code == 200
    assert hidden_subscriptions.json()["items"] == []
    revoked_source_claim = client.post(
        BASE + f"/subscriptions/{subscription_id}/claim",
        json={"expectedVersion": 1},
        headers=worker_headers,
    )
    assert revoked_source_claim.status_code == 409
    assert (
        store.get_subscription("org-a", "workspace-a", "actor-a", subscription_id)["version"] == 1
    )
    state["revoked"].clear()
    claim = client.post(
        BASE + f"/subscriptions/{subscription_id}/claim",
        json={"expectedVersion": 1},
        headers=worker_headers,
    )
    assert claim.status_code == 200
    run_plan = claim.json()["runPlan"]
    assert run_plan["taskId"].startswith("bili-watch-")
    assert run_plan["operationIdempotencyKey"].startswith("bili-operation-")
    assert run_plan["sourceMetadata"]["runKey"] == claim.json()["subscription"]["scheduledRunKey"]
    assert run_plan["sourceMetadata"]["expectedVersion"] == 2
    assert run_plan["sourceMetadata"]["delegationVersion"] == 1
    assert run_plan["sourceMetadata"]["source"] == "conversation-bili-subscription-read"
    assert len(run_plan["runtimePlanDigest"]) == 64

    # A process can crash after the claim. A GET version must recover the same plan.
    recovered = client.post(
        BASE + f"/subscriptions/{subscription_id}/claim",
        json={"expectedVersion": 2},
        headers=worker_headers,
    )
    assert recovered.status_code == 200
    assert recovered.json()["runPlan"] == run_plan

    run_key = run_plan["sourceMetadata"]["runKey"]
    state["work_store"].operations["operation-a"] = {"id": "operation-a"}
    output = "completed Bilibili video read"
    result_digest = hashlib.sha256(b"normalized provider result").hexdigest()
    checkpoint_body = {
        "expectedVersion": 2,
        "runKey": run_key,
        "cursor": None,
        "lastOutputSha256": result_digest,
        "lastOperationReceiptId": "operation-a",
        "lastNotificationReceiptId": None,
        "lastNotificationReadbackReceiptId": None,
        "lastNotificationOutcome": None,
        "lastDeliveryReceiptId": None,
        "state": "active",
        "nextCheckAt": now + 10_000,
    }
    checkpoint = client.patch(
        BASE + f"/subscriptions/{subscription_id}/check",
        json=checkpoint_body,
        headers=worker_headers,
    )
    assert checkpoint.status_code == 503
    assert checkpoint.json()["code"] == "BILIBILI_PRODUCER_PROVENANCE_UNAVAILABLE"
    assert (
        store.get_subscription("org-a", "workspace-a", "actor-a", subscription_id)["version"] == 2
    )

    arguments_digest = _sha(arguments)
    source_refs_digest = _sha(_source_refs())
    actor_scope_digest = _sha(
        {"organizationId": "org-a", "workspaceId": "workspace-a", "actorId": "actor-a"}
    )
    operation_request = {
        "source": "conversation-bili-subscription-read",
        "actorScopeSha256": actor_scope_digest,
        "connectionRefDigest": hashlib.sha256(b"connection-a").hexdigest(),
        "profileRefDigest": hashlib.sha256(b"profile-a").hexdigest(),
        "operationId": "bilibili.video.read",
        "resourceRef": subscription["resourceRef"],
        "argumentsSha256": arguments_digest,
        "taskId": run_plan["taskId"],
        "parentTaskId": "parent-task-a",
        "parentSessionId": "parent-session-a",
        "delegationId": delegation["id"],
        "delegationVersion": 1,
        "sourceRefsSha256": source_refs_digest,
        "subscriptionId": subscription_id,
        "subscriptionVersion": 2,
        "expectedVersion": 2,
        "runKey": run_key,
        "runtimePlanDigest": run_plan["runtimePlanDigest"],
        "idempotencyKey": run_plan["operationIdempotencyKey"],
    }
    state["work_store"].tasks[run_plan["taskId"]] = {
        "id": run_plan["taskId"],
        "workspaceId": "workspace-a",
        "createdByActorId": "actor-a",
        "sessionId": "parent-session-a",
        "status": "completed",
        "metadata": {
            **run_plan["sourceMetadata"],
            "runtimePlanDigest": run_plan["runtimePlanDigest"],
        },
        "output": output,
    }
    state["work_store"].operations["operation-a"] = {
        "id": "operation-a",
        "idempotencyKey": "bilibili:"
        + hashlib.sha256(
            f"{actor_scope_digest}\0{run_plan['operationIdempotencyKey']}".encode()
        ).hexdigest(),
        "status": "verified",
        "operationType": "tool.provider.v1:bilibili.video.read",
        "taskId": run_plan["taskId"],
        "trustedProducer": "exchange-connector-dispatch",
        "taskOutputSha256": hashlib.sha256(output.encode()).hexdigest(),
        "request": operation_request,
        "evidence": {
            "taskOutputSha256": hashlib.sha256(output.encode()).hexdigest(),
            "resultSha256": result_digest,
            "outcome": "verified",
            "effect": "read",
            "providerId": "bilibili",
            "connectionRef": "connection-a",
            "profileRef": "profile-a",
            "operationId": "bilibili.video.read",
            "resourceRef": subscription["resourceRef"],
            "argumentsSha256": arguments_digest,
            "readbackVerified": True,
        },
    }
    accepted = client.patch(
        BASE + f"/subscriptions/{subscription_id}/check",
        json=checkpoint_body,
        headers=worker_headers,
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["subscription"]["lastOutputSha256"] == result_digest
    assert (
        store.get_subscription("org-a", "workspace-a", "actor-a", subscription_id)["version"] == 3
    )


def test_delegation_limits_accept_256_scopes_and_reject_scope_aliases(
    domain_api: tuple[TestClient, BilibiliDomainStore, dict[str, Any]],
) -> None:
    client, _store, _state = domain_api
    now = time.time_ns() // 1_000_000
    grants = [
        {
            "operationId": "bilibili.video.read",
            "target": {"video_id": f"BV{index}"},
            "argumentsDigestSha256": _sha({"video_id": f"BV{index}"}),
        }
        for index in range(256)
    ]
    body = {
        "idempotencyKey": "many-scopes",
        "connectionRef": "connection-a",
        "profileRef": "profile-a",
        "conversationId": "conversation-a",
        "conversationKind": "direct",
        "expiresAt": now + 60_000,
        "grants": grants,
        "sourceRefs": _source_refs(),
    }
    accepted = client.post(BASE + "/delegations", json=body, headers=_write_headers())
    assert accepted.status_code == 201, accepted.text
    assert len(accepted.json()["delegation"]["grants"]) == 256

    duplicate_target = {
        **body,
        "idempotencyKey": "duplicate-target",
        "grants": [grants[0], {**grants[0], "argumentsDigestSha256": "b" * 64}],
    }
    rejected = client.post(BASE + "/delegations", json=duplicate_target, headers=_write_headers())
    assert rejected.status_code == 422


def test_delegation_expiry_is_bounded_to_30_days(
    domain_api: tuple[TestClient, BilibiliDomainStore, dict[str, Any]],
) -> None:
    client, _store, _state = domain_api
    now = time.time_ns() // 1_000_000
    arguments = {"video_id": "BV1abc"}
    accepted = client.post(
        BASE + "/delegations",
        json=_delegation_body(
            expires_at=now + 30 * 24 * 60 * 60 * 1_000 - 1_000,
            arguments=arguments,
        ),
        headers=_write_headers(),
    )
    assert accepted.status_code == 201

    too_long = client.post(
        BASE + "/delegations",
        json={
            **_delegation_body(
                expires_at=now + 30 * 24 * 60 * 60 * 1_000 + 10_000,
                arguments=arguments,
            ),
            "idempotencyKey": "too-long-delegation",
        },
        headers=_write_headers(),
    )
    assert too_long.status_code == 422
    assert too_long.json()["code"] == "BILIBILI_DOMAIN_INVALID"
