"""SIMULATED local HTTP and WorkStore coverage for conversation research."""

from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, ClassVar

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_memory.store import ConversationMemoryStore
from cyrene_navigator.work.conversation_runtime import (
    ConversationResearchRuntime,
    ConversationResearchScope,
    ConversationRuntimeError,
    mount_conversation_runtime_routes,
)
from cyrene_navigator.work.store import WorkStore

WORKSPACE = "w1"
ORG = "org-a"
ACTOR = "alice"
CONVERSATION = "conversation-1"
PARENT_TASK = "task-parent"
SESSION = "session-1"
CHILD_TASK = "task-research"
PRINCIPAL = PersistencePrincipal(
    ACTOR,
    frozenset({WORKSPACE}),
    can_takeover=True,
    organization_id=ORG,
    actor_private_scope=True,
)


class FixtureSigner:
    """Simulated server signer for a local component fixture."""

    def sign_context(self, **values: Any) -> dict[str, Any]:
        return {"request_id": values["request_id"], "method": values["method"]}


class FixtureClient:
    """DirectPlugin client seam unused by the service-level fixture."""

    def call_tool(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise AssertionError("the fixture binding's invoke method is the active transport")


class FixturePublicWebBinding:
    """SIMULATED bounded provider responses; no external web request is made."""

    binding_id = "public-web-test"
    caller_workload = "navigator-test"
    audience = "cyrene.tools.public-web"
    operation_ids: ClassVar[dict[str, str]] = {
        "web.search": "web.search",
        "web.open": "web.open",
        "document.read": "document.read",
    }

    def __init__(self) -> None:
        self.signer = FixtureSigner()
        self.client = FixtureClient()
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.fail_after_search: asyncio.Event | None = None
        self.search_started: asyncio.Event | None = None

    async def invoke(
        self,
        provider_tool_id: str,
        arguments: dict[str, Any],
        *,
        principal: PersistencePrincipal,
        workspace_id: str,
        request_id: str,
        caller_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        assert principal.actor_id == ACTOR
        assert workspace_id == WORKSPACE
        assert request_id
        assert caller_context is not None
        self.calls.append((provider_tool_id, dict(arguments)))
        if provider_tool_id == "web.search" and self.search_started is not None:
            self.search_started.set()
        if self.fail_after_search is not None:
            await self.fail_after_search.wait()
        if provider_tool_id == "web.search":
            return {
                "query": arguments["query"],
                "items": [
                    {
                        "title": "Fixture page",
                        "url": "https://public.example/page",
                        "snippet": "A fixture result.",
                        "source_ref": "sha256:" + "1" * 64,
                    }
                ],
                "next_cursor": None,
            }
        if provider_tool_id == "web.open":
            raw = b"<html><title>Fixture page</title><p>Reviewed public source.</p></html>"
            return {
                "source_ref": "sha256:" + "2" * 64,
                "url": arguments["url"],
                "title": "Fixture page",
                "content_type": "text/html",
                "content_sha256": hashlib.sha256(raw).hexdigest(),
                "content": "Reviewed public source.",
                "char_offset": 0,
                "total_chars": 23,
                "content_truncated": False,
                "next_cursor": None,
            }
        raise AssertionError(f"unexpected provider tool {provider_tool_id}")


@pytest.fixture
def state(tmp_path: Path) -> tuple[WorkStore, ConversationMemoryStore, ConversationResearchScope]:
    work = WorkStore(tmp_path / "work.sqlite3")
    conversations = ConversationMemoryStore((tmp_path / "conversation.sqlite3").absolute())
    message = conversations.create_message(
        ORG,
        WORKSPACE,
        ACTOR,
        {
            "eventId": "event-1",
            "conversationId": CONVERSATION,
            "conversationKind": "direct",
            "role": "user",
            "content": "Find a reliable source.",
            "visibility": "private",
        },
    )["message"]
    scope = ConversationResearchScope(
        conversation_id=CONVERSATION,
        conversation_kind="direct",
        persona_id=None,
        authorization_epoch=conversations.overview(ORG, WORKSPACE, ACTOR)["authorizationEpoch"],
        source_refs=(
            {
                "memoryId": None,
                "memoryVersion": None,
                "sourceMessageIds": [message["id"]],
            },
        ),
    )
    parent, _ = work.create_task(
        ORG,
        WORKSPACE,
        {
            "id": PARENT_TASK,
            "sessionId": SESSION,
            "prompt": "Find a reliable source.",
        },
        actor_id=ACTOR,
        actor_private_scope=True,
    )
    assert parent["status"] == "queued"
    work.claim_task(ORG, WORKSPACE, PARENT_TASK, actor_id=ACTOR, actor_private_scope=True)
    child, _ = work.create_task(
        ORG,
        WORKSPACE,
        {
            "id": CHILD_TASK,
            "sessionId": SESSION,
            "prompt": "Read bounded public sources.",
            "metadata": {
                "source": "conversation-research-read",
                "workspaceId": WORKSPACE,
                "actorId": ACTOR,
                "conversationId": CONVERSATION,
                "parentTaskId": PARENT_TASK,
                "parentSessionId": SESSION,
                "sourceRefs": [dict(scope.source_refs[0])],
            },
        },
        actor_id=ACTOR,
        actor_private_scope=True,
    )
    assert child["status"] == "queued"
    work.claim_task(ORG, WORKSPACE, CHILD_TASK, actor_id=ACTOR, actor_private_scope=True)
    return work, conversations, scope


def _runtime(
    work: WorkStore,
    conversations: ConversationMemoryStore,
    binding: FixturePublicWebBinding | None = None,
    *,
    timeout: float = 2.0,
) -> ConversationResearchRuntime:
    return ConversationResearchRuntime(
        work,
        conversations,
        binding or FixturePublicWebBinding(),
        call_timeout_seconds=timeout,
        now=lambda: datetime(2026, 10, 31, tzinfo=UTC),
    )


def _request(scope: ConversationResearchScope):
    from cyrene_navigator.work.conversation_runtime import ConversationResearchRequest

    return ConversationResearchRequest(
        task_id=CHILD_TASK,
        parent_task_id=PARENT_TASK,
        parent_session_id=SESSION,
        scope=scope,
        query="reliable public source",
    )


def test_research_http_route_writes_and_reads_back_real_work_receipt(
    tmp_path: Path,
) -> None:
    """SIMULATED local provider plus real Work/SQLite HTTP and receipt readback."""

    work = WorkStore(tmp_path / "work.sqlite3")
    conversations = ConversationMemoryStore((tmp_path / "conversation.sqlite3").absolute())
    # Use the fixture helper's independently-created SQLite data in the same store objects.
    # This explicit setup keeps the test route exercising one ASGI app and one authority.
    message = conversations.create_message(
        ORG,
        WORKSPACE,
        ACTOR,
        {
            "eventId": "route-event",
            "conversationId": CONVERSATION,
            "conversationKind": "direct",
            "role": "user",
            "content": "Find a reliable source.",
            "visibility": "private",
        },
    )["message"]
    source_refs = [
        {
            "memoryId": None,
            "memoryVersion": None,
            "sourceMessageIds": [message["id"]],
        }
    ]
    epoch = conversations.overview(ORG, WORKSPACE, ACTOR)["authorizationEpoch"]
    scope = ConversationResearchScope(
        conversation_id=CONVERSATION,
        conversation_kind="direct",
        persona_id=None,
        authorization_epoch=epoch,
        source_refs=tuple(source_refs),
    )
    for task_id, task_metadata in (
        (PARENT_TASK, {}),
        (
            CHILD_TASK,
            {
                "source": "conversation-research-read",
                "workspaceId": WORKSPACE,
                "actorId": ACTOR,
                "conversationId": CONVERSATION,
                "parentTaskId": PARENT_TASK,
                "parentSessionId": SESSION,
                "sourceRefs": source_refs,
            },
        ),
    ):
        work.create_task(
            ORG,
            WORKSPACE,
            {
                "id": task_id,
                "sessionId": SESSION,
                "prompt": "Execute conversation research.",
                "metadata": task_metadata,
            },
            actor_id=ACTOR,
            actor_private_scope=True,
        )
        work.claim_task(ORG, WORKSPACE, task_id, actor_id=ACTOR, actor_private_scope=True)

    binding = FixturePublicWebBinding()
    runtime = _runtime(work, conversations, binding)
    app = FastAPI()

    def principal_for(
        _request: Any, _workspace_id: str, *, write: bool = False
    ) -> PersistencePrincipal:
        assert write is False or PRINCIPAL.can_takeover
        return PRINCIPAL

    app.add_exception_handler(
        PersistenceError,
        lambda _request, error: JSONResponse(
            status_code=error.status,
            content={"code": error.code, "detail": error.detail},
        ),
    )
    mount_conversation_runtime_routes(
        app,
        "/api/v1/workspaces/{workspace_id}/work",
        principal_for,
        runtime,
    )

    with TestClient(app) as client:
        response = client.post(
            f"/api/v1/workspaces/{WORKSPACE}/work/conversation-runtime/research/read",
            json={
                "taskId": CHILD_TASK,
                "parentTaskId": PARENT_TASK,
                "parentSessionId": SESSION,
                "conversationId": CONVERSATION,
                "conversationKind": "direct",
                "personaId": None,
                "authorizationEpoch": epoch,
                "sourceRefs": source_refs,
                "query": "reliable public source",
            },
        )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["operationId"]
    assert result["resultSha256"] == result["artifactId"]
    assert result["sourceEvidence"][0]["sourceRef"] == "sha256:" + "2" * 64
    assert [tool for tool, _args in binding.calls] == ["web.search", "web.open"]

    output = json.dumps(
        {
            "version": 1,
            "operationId": result["operationId"],
            "title": result["title"],
            "content": result["content"],
            "resultSha256": result["resultSha256"],
            "contentSha256": result["contentSha256"],
        },
        separators=(",", ":"),
    )
    work.patch_task(
        ORG,
        WORKSPACE,
        CHILD_TASK,
        {"status": "completed", "output": output},
        actor_id=ACTOR,
        actor_private_scope=True,
    )
    request = _request(scope)
    receipt = asyncio.run(
        runtime.read_operation_receipt(
            PRINCIPAL,
            WORKSPACE,
            parent_task_id=request.parent_task_id,
            parent_session_id=request.parent_session_id,
            operation_id=result["operationId"],
            scope=scope,
        )
    )
    receipt_without_caller_lineage = asyncio.run(
        runtime.read_operation_receipt(
            PRINCIPAL,
            WORKSPACE,
            parent_task_id=request.parent_task_id,
            parent_session_id=request.parent_session_id,
            operation_id=result["operationId"],
            scope=ConversationResearchScope(
                conversation_id=scope.conversation_id,
                conversation_kind=scope.conversation_kind,
                persona_id=scope.persona_id,
                authorization_epoch=scope.authorization_epoch,
                source_refs=(),
            ),
        )
    )
    assert receipt["taskStatus"] == "completed"
    assert receipt["taskOutputSha256"] == hashlib.sha256(output.encode()).hexdigest()
    assert receipt["sourceEvidence"] == result["sourceEvidence"]
    assert receipt_without_caller_lineage["sourceRefs"] == source_refs


def test_research_refuses_disabled_binding_without_creating_receipt(
    state: tuple[WorkStore, ConversationMemoryStore, ConversationResearchScope],
) -> None:
    work, conversations, scope = state
    runtime = ConversationResearchRuntime(work, conversations, None)

    with pytest.raises(ConversationRuntimeError, match="PUBLIC_WEB_NOT_CONFIGURED"):
        asyncio.run(runtime.research(PRINCIPAL, WORKSPACE, _request(scope)))

    assert (
        work.list_unresolved_operations(
            ORG,
            WORKSPACE,
            operation_type="conversation.research.read.v1",
            actor_id=ACTOR,
            actor_private_scope=True,
        )
        == []
    )


def test_research_rejects_another_actors_active_task(
    state: tuple[WorkStore, ConversationMemoryStore, ConversationResearchScope],
) -> None:
    work, conversations, scope = state
    bob = PersistencePrincipal(
        "bob",
        frozenset({WORKSPACE}),
        can_takeover=True,
        organization_id=ORG,
        actor_private_scope=True,
    )

    with pytest.raises(PersistenceError):
        asyncio.run(_runtime(work, conversations).research(bob, WORKSPACE, _request(scope)))


def test_cancellation_revokes_public_call_result_and_leaves_unknown_work_receipt(
    state: tuple[WorkStore, ConversationMemoryStore, ConversationResearchScope],
) -> None:
    work, conversations, scope = state
    binding = FixturePublicWebBinding()
    binding.fail_after_search = asyncio.Event()
    binding.search_started = asyncio.Event()
    runtime = _runtime(work, conversations, binding)

    async def run_and_cancel() -> None:
        cancelled = asyncio.Event()
        operation = asyncio.create_task(
            runtime.research(PRINCIPAL, WORKSPACE, _request(scope), cancelled=cancelled)
        )
        await binding.search_started.wait()
        cancelled.set()
        with pytest.raises(asyncio.CancelledError):
            await operation

    asyncio.run(run_and_cancel())
    receipts = work.list_unresolved_operations(
        ORG,
        WORKSPACE,
        operation_type="conversation.research.read.v1",
        actor_id=ACTOR,
        actor_private_scope=True,
    )
    assert len(receipts) == 1
    assert receipts[0]["status"] == "uncertain"
    assert [tool for tool, _args in binding.calls] == ["web.search"]
