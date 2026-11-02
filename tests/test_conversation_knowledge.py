"""Catalyst knowledge consumption: fresh package, signed search, source recheck."""

from __future__ import annotations

import copy
from typing import Any

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_knowledge import build_conversation_knowledge_router
from cyrene_navigator.work.conversation_knowledge.ports import (
    KnowledgePackageSelection,
    KnowledgePortError,
)
from cyrene_navigator.work.conversation_knowledge.service import ConversationKnowledgeService

WORKSPACE = "workspace-a"
DATASET = "11111111-1111-4111-8111-111111111111"
VERSION = "22222222-2222-4222-8222-222222222222"
REVISION = "33333333-3333-4333-8333-333333333333"
SOURCE_REVISION = "44444444-4444-4444-8444-444444444444"
SOURCE = "55555555-5555-4555-8555-555555555555"
PACKAGE_DIGEST = "sha256:" + "a" * 64
MANIFEST_DIGEST = "sha256:" + "b" * 64
CHUNK_ID = "sha256:" + "c" * 64
PRINCIPAL_REF = "teams:user:actor-a"
PRINCIPAL = PersistencePrincipal(
    actor_id="actor-a",
    workspace_ids=frozenset({WORKSPACE}),
    organization_id="org-a",
)
BASE = f"/api/v1/workspaces/{WORKSPACE}/work/knowledge"


def _policy(**changes: Any) -> dict[str, Any]:
    policy: dict[str, Any] = {
        "allowKnowledge": True,
        "allowTraining": False,
        "allowedPrincipalRefs": [PRINCIPAL_REF],
        "allowedUsePurposes": ["knowledge_retrieval"],
    }
    policy.update(changes)
    return policy


class _FakeCatalyst:
    def __init__(self) -> None:
        self.stale = False
        self.policy = _policy()
        self.calls: list[str] = []

    async def list_datasets(self, principal: Any, workspace_id: str) -> list[dict[str, Any]]:
        self.calls.append("datasets")
        return [{"id": DATASET, "name": "Handbook"}]

    async def list_dataset_versions(
        self, principal: Any, workspace_id: str, dataset_id: str
    ) -> list[dict[str, Any]]:
        self.calls.append("versions")
        return [
            {
                "id": VERSION,
                "datasetId": DATASET,
                "version": 3,
                "state": "PUBLISHED",
                "resourceVersion": 7,
                "dataTools": {
                    "contentRevisionId": REVISION,
                    "sourceRevisionIds": [SOURCE_REVISION],
                    "knowledgeProfile": "CYRENE_KNOWLEDGE_BUNDLE_V1",
                    "knowledgeArtifact": {
                        "uri": "artifact://sha256/" + "a" * 64,
                        "digest": PACKAGE_DIGEST,
                        "size_bytes": 4096,
                        "kind": "knowledge-bundle",
                        "manifest_digest": MANIFEST_DIGEST,
                    },
                    "stale": self.stale,
                },
            }
        ]

    async def get_content_block_page(
        self,
        principal: Any,
        workspace_id: str,
        content_revision_id: str,
        *,
        offset: int,
        limit: int,
    ) -> dict[str, Any]:
        self.calls.append(f"block:{offset}")
        blocks = []
        if offset == 0:
            blocks.append(
                {
                    "id": "block-1",
                    "ordinal": 0,
                    "sourceRevisionId": SOURCE_REVISION,
                    "policy": copy.deepcopy(self.policy),
                }
            )
        return {
            "revisionId": content_revision_id,
            "offset": offset,
            "limit": limit,
            "total": 1,
            "blocks": blocks,
        }


class _FakeToolProvider:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.package_digest = PACKAGE_DIGEST

    async def search(
        self,
        *,
        principal: Any,
        workspace_id: str,
        arguments: dict[str, Any],
        request_id: str,
    ) -> dict[str, Any]:
        self.calls.append(arguments)
        return {
            "librarySelector": arguments["librarySelector"],
            "packageDigest": self.package_digest,
            "manifestDigest": MANIFEST_DIGEST,
            "contentRevisionId": REVISION,
            "usePurpose": "knowledge_retrieval",
            "query": arguments["query"],
            "hits": [
                {
                    "score": 1.5,
                    "chunk": {
                        "chunkId": CHUNK_ID,
                        "text": "Reset the gateway before restarting.",
                        "sourceId": SOURCE,
                        "sourceRevisionId": SOURCE_REVISION,
                        "contentRevisionId": REVISION,
                        "blockId": "block-1",
                        "blockOrdinal": 0,
                        "locator": {"page": 2},
                        "hierarchyPath": ["Operations"],
                        "assetRefs": [],
                    },
                }
            ],
        }


class _Refs:
    def __init__(self, refs: tuple[str, ...]) -> None:
        self.refs = refs

    def resolve(self, *, principal: Any, workspace_id: str) -> tuple[str, ...]:
        return self.refs


class _Selection:
    def __init__(self, selection: KnowledgePackageSelection | None) -> None:
        self.selection = selection

    def resolve(
        self, request: Request, *, principal: Any, workspace_id: str
    ) -> KnowledgePackageSelection | None:
        return self.selection


def _selection(actor_id: str = "actor-a") -> KnowledgePackageSelection:
    return KnowledgePackageSelection(
        library_selector="handbook",
        dataset_id=DATASET,
        dataset_version_id=VERSION,
        actor_id=actor_id,
    )


def _client(
    *,
    refs: tuple[str, ...] = (PRINCIPAL_REF,),
    selection: KnowledgePackageSelection | None = None,
) -> tuple[TestClient, _FakeCatalyst, _FakeToolProvider]:
    catalyst = _FakeCatalyst()
    provider = _FakeToolProvider()
    service = ConversationKnowledgeService(
        catalyst,  # type: ignore[arg-type]
        provider,
        _Refs(refs),
        now_ms=lambda: 1_800_000_000_000,
    )
    app = FastAPI()
    app.include_router(
        build_conversation_knowledge_router(
            principal_for=lambda request, workspace_id, write=False: PRINCIPAL,
            service=service,
            selection_resolver=_Selection(selection or _selection()),
        )
    )
    return TestClient(app), catalyst, provider


def _search(client: TestClient, **body: Any) -> Any:
    return client.post(f"{BASE}/search", json={"query": "restart gateway", **body})


def test_search_returns_cited_hits_and_sends_only_server_selected_arguments() -> None:
    client, _catalyst, provider = _client()
    response = _search(client, limit=3)
    assert response.status_code == 200
    body = response.json()
    assert body["usePurpose"] == "knowledge_retrieval"
    assert body["package"]["datasetName"] == "Handbook"
    assert body["package"]["version"] == 3
    assert body["packageDigest"] == PACKAGE_DIGEST
    hit = body["hits"][0]
    assert hit["text"] == "Reset the gateway before restarting."
    assert hit["citation"]["datasetVersionId"] == VERSION
    assert hit["citation"]["sourceRevisionId"] == SOURCE_REVISION
    assert hit["citation"]["blockOrdinal"] == 0
    assert provider.calls == [
        {"librarySelector": "handbook", "query": "restart gateway", "limit": 3}
    ]
    again = _search(client, limit=3).json()
    assert again["resultDigest"] == body["resultDigest"]


@pytest.mark.parametrize(
    "extra",
    [
        {"datasetVersionId": VERSION},
        {"librarySelector": "other"},
        {"principalRefs": ["x"]},
        {"packageDigest": PACKAGE_DIGEST},
    ],
)
def test_model_cannot_choose_package_principal_or_digest(extra: dict[str, Any]) -> None:
    client, _catalyst, provider = _client()
    assert _search(client, **extra).status_code == 422
    assert provider.calls == []


def test_stale_package_is_held_before_any_provider_call() -> None:
    client, catalyst, provider = _client()
    catalyst.stale = True
    response = _search(client)
    assert response.status_code == 409
    assert response.json()["code"] == "KNOWLEDGE_PACKAGE_STALE"
    assert provider.calls == []


def test_revoked_source_policy_holds_the_returned_page() -> None:
    client, catalyst, provider = _client()
    catalyst.policy = _policy(allowedPrincipalRefs=["someone-else"])
    response = _search(client)
    assert response.status_code == 403
    assert response.json()["code"] == "KNOWLEDGE_SOURCE_NOT_AUTHORIZED"
    assert len(provider.calls) == 1


@pytest.mark.parametrize(
    "policy",
    [
        {"allowKnowledge": False},
        {"allowedUsePurposes": ["model_training"]},
        {"allowedPrincipalRefs": []},
    ],
)
def test_each_policy_denial_is_fail_closed(policy: dict[str, Any]) -> None:
    client, catalyst, _provider = _client()
    catalyst.policy = _policy(**policy)
    assert _search(client).status_code == 403


def test_unmapped_principal_and_missing_selection_are_rejected() -> None:
    unmapped, _catalyst, provider = _client(refs=())
    assert _search(unmapped).json()["code"] == "KNOWLEDGE_PRINCIPAL_UNMAPPED"
    assert provider.calls == []
    wrong_actor, _catalyst, _provider = _client(selection=_selection("actor-b"))
    assert _search(wrong_actor).status_code == 403
    service = ConversationKnowledgeService(
        _FakeCatalyst(),  # type: ignore[arg-type]
        _FakeToolProvider(),
        _Refs((PRINCIPAL_REF,)),
    )
    app = FastAPI()
    app.include_router(
        build_conversation_knowledge_router(
            principal_for=lambda request, workspace_id, write=False: PRINCIPAL,
            service=service,
            selection_resolver=_Selection(None),
        )
    )
    missing = _search(TestClient(app))
    assert missing.status_code == 409
    assert missing.json()["code"] == "KNOWLEDGE_PACKAGE_NOT_SELECTED"


def test_provider_page_for_a_different_package_is_rejected() -> None:
    client, _catalyst, provider = _client()
    provider.package_digest = "sha256:" + "d" * 64
    response = _search(client)
    assert response.status_code == 502
    assert response.json()["code"] == "KNOWLEDGE_PROVIDER_RESPONSE_MISMATCH"


def _authorize_body(search: dict[str, Any]) -> dict[str, Any]:
    return {
        "datasetId": DATASET,
        "datasetVersionId": VERSION,
        "librarySelector": "handbook",
        "query": "restart gateway",
        "limit": 5,
        "resultDigest": search["resultDigest"],
        "citations": [hit["citation"] for hit in search["hits"]],
    }


def test_authorization_recheck_allows_then_holds_after_revocation_or_stale() -> None:
    client, catalyst, _provider = _client()
    searched = _search(client).json()
    allowed = client.post(f"{BASE}/authorize", json=_authorize_body(searched))
    assert allowed.status_code == 200
    receipt = allowed.json()
    assert receipt["allowed"] is True
    assert receipt["resultDigest"] == searched["resultDigest"]
    assert receipt["packageDigest"] == PACKAGE_DIGEST
    assert receipt["checkedAt"] == 1_800_000_000_000

    catalyst.policy = _policy(allowKnowledge=False)
    revoked = client.post(f"{BASE}/authorize", json=_authorize_body(searched)).json()
    assert revoked["allowed"] is False
    assert revoked["reasonCode"] == "KNOWLEDGE_SOURCE_NOT_AUTHORIZED"

    catalyst.policy = _policy()
    catalyst.stale = True
    stale = client.post(f"{BASE}/authorize", json=_authorize_body(searched)).json()
    assert stale["allowed"] is False
    assert stale["reasonCode"] == "KNOWLEDGE_PACKAGE_STALE"


def test_authorization_for_a_different_selection_is_a_conflict() -> None:
    client, _catalyst, _provider = _client()
    searched = _search(client).json()
    body = _authorize_body(searched)
    body["datasetVersionId"] = "66666666-6666-4666-8666-666666666666"
    response = client.post(f"{BASE}/authorize", json=body)
    assert response.status_code == 409
    assert response.json()["code"] == "KNOWLEDGE_SELECTION_CHANGED"


def test_port_error_is_redacted_and_typed() -> None:
    error = KnowledgePortError("CATALYST_PRODUCT_UNAVAILABLE", status_code=503, retryable=True)
    assert error.code == "CATALYST_PRODUCT_UNAVAILABLE"
    assert error.retryable is True
