"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 test_conversation_memory_api.py                                   │
│  Module: tests.test_conversation_memory_api                           │
│  Role: Verify scoped conversation memory routes and provider seams.    │
│                                                                      │
│  模块职责：验证消息来源、版本授权、真实 provider 接口与撤销隔离。       │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Literal

from fastapi.testclient import TestClient

from cyrene_navigator.persistence import PersistencePrincipal, create_persistence_app
from cyrene_navigator.work.conversation_memory.providers import (
    EmbeddingBatch,
    KnowledgeGraphProvider,
    MemoryProviderHit,
    MemoryProviderScope,
)

BASE = "/api/v1/workspaces/w1/work/conversation-memory"
TOKENS = {
    "alice-token": PersistencePrincipal(
        "alice", frozenset({"w1"}), can_takeover=True, organization_id="org-a"
    ),
    "bob-token": PersistencePrincipal(
        "bob", frozenset({"w1"}), can_takeover=True, organization_id="org-a"
    ),
}


class FakeEmbeddings:
    """Fixture adapter that proves the API calls the injected embeddings seam."""

    def embed(
        self,
        texts: Sequence[str],
        *,
        model: str | None = None,
        purpose: Literal["document", "query"] = "document",
    ) -> EmbeddingBatch:
        assert texts
        assert purpose in {"document", "query"}
        return EmbeddingBatch(((0.75, 0.25),), "fixture-embedding-v1", 2)


class FakeMemoryProvider:
    """Small deterministic fixture for provider binding and authorization filtering."""

    def __init__(self) -> None:
        self.records: dict[tuple[str, str], tuple[str, str, int, MemoryProviderScope]] = {}

    def upsert(
        self,
        *,
        memory_id: str,
        text: str,
        embedding: tuple[float, ...],
        model: str,
        dimensions: int,
        scope: MemoryProviderScope,
        authorization_epoch: int,
    ) -> None:
        assert len(embedding) == dimensions
        self.records[(scope.actor_id, memory_id)] = (
            text,
            model,
            dimensions,
            scope,
        )

    def query(
        self,
        *,
        text: str,
        embedding: tuple[float, ...],
        model: str,
        dimensions: int,
        scope: MemoryProviderScope,
        limit: int,
    ) -> Sequence[MemoryProviderHit]:
        assert len(embedding) == dimensions
        return [
            MemoryProviderHit(memory_id, 0.9, model, dimensions)
            for (owner, memory_id), (_, _, _, _) in self.records.items()
            if owner == scope.actor_id
        ][:limit]

    def delete(self, *, memory_ids: Sequence[str], scope: MemoryProviderScope) -> None:
        for memory_id in memory_ids:
            self.records.pop((scope.actor_id, memory_id), None)


class FakeGraphProvider:
    """Graph fixture used to verify the official persistence composition seam."""

    def apply_changeset(self, **_kwargs: object) -> dict[str, object]:
        return {"readbackDigest": "0" * 64, "nodeCount": 0, "edgeCount": 0}

    def query(self, **_kwargs: object) -> dict[str, object]:
        return {"items": []}


def _client(
    db_path: Path,
    *,
    with_provider: bool = False,
    graph_provider: KnowledgeGraphProvider | None = None,
) -> TestClient:
    provider = FakeMemoryProvider() if with_provider else None
    return TestClient(
        create_persistence_app(
            db_path,
            TOKENS,
            conversation_memory_embedding_client=FakeEmbeddings() if with_provider else None,
            conversation_memory_provider=provider,
            conversation_graph_provider=graph_provider,
        )
    )


def _headers(token: str = "alice-token") -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _post_message(
    client: TestClient,
    *,
    token: str = "alice-token",
    event_id: str = "event-user-1",
    conversation_id: str = "direct-alice",
    conversation_kind: str = "direct",
    persona_id: str | None = "persona-a",
    visibility: str = "private",
    role: str = "user",
    content: str = "I prefer quiet mornings.",
) -> dict[str, object]:
    response = client.post(
        BASE + "/messages",
        json={
            "eventId": event_id,
            "conversationId": conversation_id,
            "conversationKind": conversation_kind,
            "personaId": persona_id,
            "visibility": visibility,
            "role": role,
            "content": content,
        },
        headers=_headers(token),
    )
    assert response.status_code in {200, 201}, response.text
    return response.json()


def _create_memory(
    client: TestClient,
    source_id: str,
    *,
    token: str = "alice-token",
    conversation_id: str = "direct-alice",
    conversation_kind: str = "direct",
    persona_id: str | None = "persona-a",
    visibility: str = "private",
) -> dict[str, object]:
    response = client.post(
        BASE + "/memories",
        json={
            "idempotencyKey": f"memory-{source_id}",
            "conversationId": conversation_id,
            "conversationKind": conversation_kind,
            "personaId": persona_id,
            "kind": "preference",
            "text": "Prefers quiet mornings.",
            "sourceMessageIds": [source_id],
            "sourceRefs": [
                {
                    "memoryId": None,
                    "memoryVersion": None,
                    "sourceMessageIds": [source_id],
                }
            ],
            "visibility": visibility,
        },
        headers=_headers(token),
    )
    assert response.status_code == 201, response.text
    return response.json()["memory"]


def test_message_event_idempotency_ignores_server_generated_time(tmp_path: Path) -> None:
    """A retry without occurredAt returns the original record instead of conflicting."""

    with _client(tmp_path / "messages.sqlite3") as client:
        first = _post_message(client)
        repeated = _post_message(client)
        assert repeated["duplicate"] is True
        assert repeated["message"]["id"] == first["message"]["id"]
        assert "actorId" not in first["message"]
        forged = client.post(
            BASE + "/messages",
            json={
                "eventId": "forged-event",
                "conversationId": "direct-alice",
                "conversationKind": "direct",
                "personaId": "persona-a",
                "role": "user",
                "content": "forged actor",
                "actorId": "bob",
            },
            headers=_headers(),
        )
        assert forged.status_code == 422


def test_graph_provider_from_persistence_composition_is_visible_to_work_routes(
    tmp_path: Path,
) -> None:
    """The injected graph provider reaches the route that executes queries and changesets."""

    graph_provider = FakeGraphProvider()
    with _client(tmp_path / "graph-composition.sqlite3", graph_provider=graph_provider) as client:
        assert client.app.state.graph_provider is graph_provider
        response = client.post(
            BASE + "/graph/query",
            json={
                "conversationId": "direct-alice",
                "conversationKind": "direct",
                "personaId": "persona-a",
                "query": "project",
                "limit": 10,
            },
            headers=_headers(),
        )
        assert response.status_code == 200, response.text
        assert response.json()["items"] == []


def test_exact_message_readback_is_actor_scope_and_lineage_checked(tmp_path: Path) -> None:
    """Exact message lookup never returns revoked or cross-actor source content."""

    with _client(tmp_path / "message-readback.sqlite3") as client:
        message = _post_message(client)["message"]
        query = "conversationId=direct-alice&conversationKind=direct&personaId=persona-a"
        path = BASE + f"/messages/{message['id']}?{query}"
        current = client.get(path, headers=_headers())
        assert current.status_code == 200, current.text
        assert current.json()["id"] == message["id"]

        other_actor = client.get(path, headers=_headers("bob-token"))
        assert other_actor.status_code == 404

        revoked = client.post(
            BASE + f"/sources/{message['id']}/revoke", json={}, headers=_headers()
        )
        assert revoked.status_code == 200
        after_revoke = client.get(path, headers=_headers())
        assert after_revoke.status_code == 404


def test_private_source_cannot_cross_to_group_or_persona(tmp_path: Path) -> None:
    """Same-actor identity does not override direct-chat or persona boundaries."""

    with _client(tmp_path / "scope.sqlite3") as client:
        message = _post_message(client)["message"]
        source_id = message["id"]
        epoch = client.get(BASE + "/overview", headers=_headers()).json()["authorizationEpoch"]
        source_refs = [{"memoryId": None, "memoryVersion": None, "sourceMessageIds": [source_id]}]
        group_denied = client.post(
            BASE + "/sources/authorize",
            json={
                "conversationId": "group-1",
                "conversationKind": "group",
                "personaId": "persona-a",
                "authorizationEpoch": epoch,
                "sourceRefs": source_refs,
            },
            headers=_headers(),
        )
        assert group_denied.status_code == 200
        assert group_denied.json()["allowed"] is False
        persona_denied = client.post(
            BASE + "/sources/authorize",
            json={
                "conversationId": "direct-alice",
                "conversationKind": "direct",
                "personaId": "persona-b",
                "authorizationEpoch": epoch,
                "sourceRefs": source_refs,
            },
            headers=_headers(),
        )
        assert persona_denied.status_code == 200
        assert persona_denied.json()["allowed"] is False
        direct_allowed = client.post(
            BASE + "/sources/authorize",
            json={
                "conversationId": "direct-alice",
                "conversationKind": "direct",
                "personaId": "persona-a",
                "authorizationEpoch": epoch,
                "sourceRefs": source_refs,
            },
            headers=_headers(),
        )
        assert direct_allowed.json()["allowed"] is True


def test_explicit_source_grant_is_scoped_and_revocable(tmp_path: Path) -> None:
    """A grant enables one target conversation and revocation immediately closes it."""

    with _client(tmp_path / "grants.sqlite3", with_provider=True) as client:
        message = _post_message(client)["message"]
        source_id = message["id"]
        grant = client.post(
            BASE + f"/sources/{source_id}/grants",
            json={"visibility": "conversation", "targetConversationId": "group-bob"},
            headers=_headers(),
        )
        assert grant.status_code == 201, grant.text
        assert grant.json()["grant"]["targetConversationId"] == "group-bob"
        memory = _create_memory(
            client,
            source_id,
            conversation_id="direct-alice",
            visibility="workspace",
        )
        assert memory["indexState"] == "indexed"
        group_query = client.post(
            BASE + "/memories/query",
            json={
                "conversationId": "group-bob",
                "conversationKind": "group",
                "personaId": "persona-a",
                "query": "quiet mornings",
                "limit": 10,
            },
            headers=_headers("bob-token"),
        )
        assert group_query.status_code == 200, group_query.text
        assert [item["memoryId"] for item in group_query.json()["items"]] == [memory["id"]]
        epoch = group_query.json()["authorizationEpoch"]
        source_ref = {
            "memoryId": memory["id"],
            "memoryVersion": memory["version"],
            "sourceMessageIds": [source_id],
        }
        allowed = client.post(
            BASE + "/sources/authorize",
            json={
                "conversationId": "group-bob",
                "conversationKind": "group",
                "personaId": "persona-a",
                "authorizationEpoch": epoch,
                "sourceRefs": [source_ref],
            },
            headers=_headers("bob-token"),
        )
        assert allowed.json()["allowed"] is True
        revoked = client.delete(
            BASE + f"/sources/{source_id}/grants/{grant.json()['grant']['id']}",
            headers=_headers(),
        )
        assert revoked.status_code == 200
        current_epoch = revoked.json()["authorizationEpoch"]
        denied = client.post(
            BASE + "/sources/authorize",
            json={
                "conversationId": "group-bob",
                "conversationKind": "group",
                "personaId": "persona-a",
                "authorizationEpoch": current_epoch,
                "sourceRefs": [source_ref],
            },
            headers=_headers("bob-token"),
        )
        assert denied.json()["allowed"] is False
        no_longer_shared = client.post(
            BASE + "/memories/query",
            json={
                "conversationId": "group-bob",
                "conversationKind": "group",
                "personaId": "persona-a",
                "query": "quiet mornings",
                "limit": 10,
            },
            headers=_headers("bob-token"),
        )
        assert no_longer_shared.json()["items"] == []


def test_memory_query_merges_owner_scoped_provider_pages_before_global_limit(
    tmp_path: Path,
) -> None:
    """Several authorized owners may each return candidates before the shared limit is applied."""

    with _client(tmp_path / "multi-owner-query.sqlite3", with_provider=True) as client:
        owners = (
            ("alice-token", "alice", "direct-alice"),
            ("bob-token", "bob", "direct-bob"),
        )
        for token, actor, conversation_id in owners:
            for index in range(6):
                message = _post_message(
                    client,
                    token=token,
                    event_id=f"{actor}-event-{index}",
                    conversation_id=conversation_id,
                    visibility="conversation",
                    content=f"Shared memory {actor} {index}",
                )["message"]
                memory = _create_memory(
                    client,
                    message["id"],
                    token=token,
                    conversation_id=conversation_id,
                    visibility="workspace",
                )
                grant = client.post(
                    BASE + f"/sources/{message['id']}/grants",
                    json={
                        "visibility": "conversation",
                        "targetConversationId": "group-shared",
                    },
                    headers=_headers(token),
                )
                assert grant.status_code == 201, grant.text
                assert memory["indexState"] == "indexed"

        response = client.post(
            BASE + "/memories/query",
            json={
                "conversationId": "group-shared",
                "conversationKind": "group",
                "personaId": "persona-a",
                "query": "shared memory",
                "limit": 10,
            },
            headers=_headers("bob-token"),
        )
        assert response.status_code == 200, response.text
        assert len(response.json()["items"]) == 10
        assert {item["scope"]["visibility"] for item in response.json()["items"]} == {"workspace"}


def test_unconfigured_semantic_provider_fails_closed_and_revoke_invalidates(tmp_path: Path) -> None:
    """No provider is reported unavailable; source revocation removes indexed hits."""

    with _client(tmp_path / "unavailable.sqlite3") as client:
        message = _post_message(client)["message"]
        memory = _create_memory(client, message["id"])
        assert memory["indexState"] == "unavailable"
        unavailable = client.post(
            BASE + "/memories/query",
            json={
                "conversationId": "direct-alice",
                "conversationKind": "direct",
                "personaId": "persona-a",
                "query": "quiet mornings",
            },
            headers=_headers(),
        )
        assert unavailable.status_code == 503
        assert unavailable.json()["code"] == "MEMORY_PROVIDER_UNAVAILABLE"

    with _client(tmp_path / "revoke.sqlite3", with_provider=True) as client:
        message = _post_message(client)["message"]
        memory = _create_memory(client, message["id"])
        revoked = client.post(
            BASE + f"/sources/{message['id']}/revoke", json={}, headers=_headers()
        )
        assert revoked.status_code == 200
        query = client.post(
            BASE + "/memories/query",
            json={
                "conversationId": "direct-alice",
                "conversationKind": "direct",
                "personaId": "persona-a",
                "query": "quiet mornings",
                "limit": 10,
            },
            headers=_headers(),
        )
        assert query.status_code == 200
        assert query.json()["items"] == []


def test_attachment_requires_current_message_source_authorization(tmp_path: Path) -> None:
    """Opaque media IDs cannot escape their direct source without a grant."""

    artifact_id = "a" * 64
    with _client(tmp_path / "attachment-auth.sqlite3") as client:
        message = client.post(
            BASE + "/messages",
            json={
                "eventId": "event-with-image",
                "conversationId": "direct-alice",
                "conversationKind": "direct",
                "personaId": "persona-a",
                "visibility": "private",
                "role": "user",
                "content": "What is in this image?",
                "attachments": [
                    {
                        "artifactId": artifact_id,
                        "sha256": artifact_id,
                        "mimeType": "image/png",
                        "size": 128,
                    }
                ],
            },
            headers=_headers(),
        )
        assert message.status_code == 201, message.text
        message_id = message.json()["message"]["id"]
        epoch = client.get(BASE + "/overview", headers=_headers()).json()["authorizationEpoch"]
        body = {
            "artifactId": artifact_id,
            "conversationId": "direct-alice",
            "conversationKind": "direct",
            "personaId": "persona-a",
            "authorizationEpoch": epoch,
            "sourceRefs": [
                {"memoryId": None, "memoryVersion": None, "sourceMessageIds": [message_id]}
            ],
        }
        allowed = client.post(BASE + "/artifacts/authorize", json=body, headers=_headers())
        assert allowed.status_code == 200
        assert allowed.json()["allowed"] is True
        assert allowed.json()["artifact"]["artifactId"] == artifact_id

        group_request = {
            **body,
            "conversationId": "group-1",
            "conversationKind": "group",
        }
        denied = client.post(BASE + "/artifacts/authorize", json=group_request, headers=_headers())
        assert denied.status_code == 200
        assert denied.json()["allowed"] is False

        grant = client.post(
            BASE + f"/sources/{message_id}/grants",
            json={"visibility": "conversation", "targetConversationId": "group-1"},
            headers=_headers(),
        )
        assert grant.status_code == 201
        granted_request = {
            **group_request,
            "authorizationEpoch": grant.json()["authorizationEpoch"],
        }
        granted = client.post(
            BASE + "/artifacts/authorize", json=granted_request, headers=_headers("bob-token")
        )
        assert granted.status_code == 200
        assert granted.json()["allowed"] is True


def test_memory_corrections_and_deletion_use_version_cas(tmp_path: Path) -> None:
    """Concurrent edits fail closed while an exact delete retry stays idempotent."""

    with _client(tmp_path / "memory-cas.sqlite3", with_provider=True) as client:
        message = _post_message(client)["message"]
        memory = _create_memory(client, message["id"])
        memory_store = client.app.state.work_conversation_memory
        active_readback = memory_store.get_memory("org-a", "w1", "alice", memory["id"])
        assert active_readback is not None
        assert active_readback["state"] == "active"
        updated = client.patch(
            BASE + f"/memories/{memory['id']}",
            json={"expectedVersion": 1, "text": "Corrected preference."},
            headers=_headers(),
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["memory"]["version"] == 2
        stale_update = client.patch(
            BASE + f"/memories/{memory['id']}",
            json={"expectedVersion": 1, "text": "Stale correction."},
            headers=_headers(),
        )
        assert stale_update.status_code == 409
        assert stale_update.json()["code"] == "CONVERSATION_MEMORY_VERSION_CONFLICT"

        missing_version = client.delete(BASE + f"/memories/{memory['id']}", headers=_headers())
        assert missing_version.status_code == 422
        deleted = client.delete(
            BASE + f"/memories/{memory['id']}?expectedVersion=2", headers=_headers()
        )
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["deleted"] is True
        assert deleted.json()["duplicate"] is False
        repeated = client.delete(
            BASE + f"/memories/{memory['id']}?expectedVersion=2", headers=_headers()
        )
        assert repeated.status_code == 200
        assert repeated.json()["duplicate"] is True
        assert memory_store.get_memory("org-a", "w1", "alice", memory["id"]) is None
        tombstone = memory_store.get_memory(
            "org-a", "w1", "alice", memory["id"], include_deleted=True
        )
        assert tombstone is not None
        assert tombstone["state"] == "deleted"
        assert tombstone["version"] == updated.json()["memory"]["version"]
        assert (
            memory_store.get_memory("org-a", "w1", "bob", memory["id"], include_deleted=True)
            is None
        )
        stale_delete = client.delete(
            BASE + f"/memories/{memory['id']}?expectedVersion=1", headers=_headers()
        )
        assert stale_delete.status_code == 409
        assert stale_delete.json()["code"] == "CONVERSATION_MEMORY_VERSION_CONFLICT"


def test_actor_backup_is_private_and_contains_only_the_current_actor(tmp_path: Path) -> None:
    """Backups combine both product stores into an actor-private Work attachment."""

    with _client(tmp_path / "backup.sqlite3") as client:
        alice_message = _post_message(client, content="Alice private note")
        bob_message = _post_message(
            client,
            token="bob-token",
            event_id="bob-event",
            conversation_id="direct-bob",
            content="Bob private note",
        )
        assert alice_message["message"]["id"] != bob_message["message"]["id"]
        backup = client.post(BASE + "/backups", json={}, headers=_headers())
        assert backup.status_code == 201, backup.text
        receipt = backup.json()
        assert receipt["mimeType"] == "application/json"
        assert receipt["size"] > 0
        downloaded = client.get(
            "/api/v1/workspaces/w1/work/attachments/" + receipt["artifactId"],
            headers=_headers(),
        )
        assert downloaded.status_code == 200
        payload = downloaded.json()
        memory_rows = payload["conversationMemory"]["records"]
        assert any(
            row.get("message_id") == alice_message["message"]["id"]
            for row in memory_rows["conversation_memory_messages"]
        )
        assert all(
            row.get("message_id") != bob_message["message"]["id"]
            for row in memory_rows["conversation_memory_messages"]
        )
        denied = client.get(
            "/api/v1/workspaces/w1/work/attachments/" + receipt["artifactId"],
            headers=_headers("bob-token"),
        )
        assert denied.status_code == 404
