"""Authenticated HTTP surface for the current-turn research runtime.

中文：当前回合研究运行时的认证 HTTP 接口。
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from typing import Any, Literal

from fastapi import FastAPI, Request
from pydantic import Field

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.models import ConversationMemorySourceRef, WorkModel

from .models import ConversationResearchRequest, ConversationResearchScope
from .service import ConversationResearchRuntime, ConversationRuntimeError


class _ResearchReadBody(WorkModel):
    """Strict request; actor identity and provider binding are server-owned."""

    task_id: str = Field(min_length=1, max_length=512)
    parent_task_id: str = Field(min_length=1, max_length=512)
    parent_session_id: str = Field(min_length=1, max_length=512)
    conversation_id: str = Field(min_length=1, max_length=512)
    conversation_kind: Literal["direct", "group", "channel"]
    persona_id: str | None = Field(default=None, max_length=512)
    authorization_epoch: int = Field(ge=0)
    source_refs: list[ConversationMemorySourceRef] = Field(min_length=1, max_length=256)
    query: str = Field(min_length=1, max_length=2_000)
    attachment_ids: list[str] = Field(
        default_factory=list,
        max_length=8,
        pattern=r"^[0-9a-f]{64}$",
    )


class _ReceiptReadBody(WorkModel):
    """Current parent Task and source lineage for one real receipt lookup."""

    parent_task_id: str = Field(min_length=1, max_length=512)
    parent_session_id: str = Field(min_length=1, max_length=512)
    conversation_id: str = Field(min_length=1, max_length=512)
    conversation_kind: Literal["direct", "group", "channel"]
    persona_id: str | None = Field(default=None, max_length=512)
    authorization_epoch: int = Field(ge=0)
    source_refs: list[ConversationMemorySourceRef] = Field(default_factory=list, max_length=256)


PrincipalFor = Callable[..., PersistencePrincipal]


def mount_conversation_runtime_routes(
    app: FastAPI,
    base: str,
    principal_for: PrincipalFor,
    runtime: ConversationResearchRuntime,
) -> None:
    """Mount actor-scoped routes without exposing the runtime as a generic tool."""

    @app.post(base + "/conversation-runtime/research/read")
    async def research_read(
        workspace_id: str, body: _ResearchReadBody, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        scope = _scope(body)
        cancelled = asyncio.Event()
        disconnect_monitor = asyncio.create_task(_watch_disconnect(request, cancelled))
        try:
            result = await runtime.research(
                principal,
                workspace_id,
                ConversationResearchRequest(
                    task_id=body.task_id,
                    parent_task_id=body.parent_task_id,
                    parent_session_id=body.parent_session_id,
                    scope=scope,
                    query=body.query,
                    attachment_ids=tuple(body.attachment_ids),
                ),
                cancelled=cancelled,
            )
        except ConversationRuntimeError as error:
            raise PersistenceError(
                error.code,
                error.status_code,
                "The conversation research operation could not be verified.",
                error.retryable,
            ) from None
        finally:
            disconnect_monitor.cancel()
            await asyncio.gather(disconnect_monitor, return_exceptions=True)
        return {
            "operationId": result.operation_id,
            "title": result.title,
            "content": result.content,
            "resultSha256": result.result_sha256,
            "contentSha256": result.content_sha256,
            "sourceEvidence": [dict(item) for item in result.source_evidence],
            "artifactId": result.artifact_id,
        }

    @app.post(base + "/conversation-runtime/operations/{operation_id}/receipt")
    async def read_operation_receipt(
        workspace_id: str,
        operation_id: str,
        body: _ReceiptReadBody,
        request: Request,
    ) -> Mapping[str, Any]:
        principal = principal_for(request, workspace_id)
        try:
            return await runtime.read_operation_receipt(
                principal,
                workspace_id,
                parent_task_id=body.parent_task_id,
                parent_session_id=body.parent_session_id,
                operation_id=operation_id,
                scope=_scope(body),
            )
        except ConversationRuntimeError as error:
            raise PersistenceError(
                error.code,
                error.status_code,
                "The Work operation receipt could not be verified.",
                error.retryable,
            ) from None


def _scope(body: _ResearchReadBody | _ReceiptReadBody) -> ConversationResearchScope:
    kind = body.conversation_kind
    if kind not in {"direct", "group", "channel"}:
        raise PersistenceError(
            "CONVERSATION_KIND_INVALID", 422, "Conversation kind is not supported."
        )
    refs = tuple(
        reference.model_dump(by_alias=True, exclude_none=False) for reference in body.source_refs
    )
    try:
        return ConversationResearchScope(
            conversation_id=body.conversation_id,
            conversation_kind=kind,
            persona_id=body.persona_id,
            authorization_epoch=body.authorization_epoch,
            source_refs=refs,
        )
    except ValueError as error:
        raise PersistenceError(
            "CONVERSATION_SOURCE_INVALID", 422, "Conversation source lineage is invalid."
        ) from error


async def _watch_disconnect(request: Request, cancelled: asyncio.Event) -> None:
    """Propagate a disconnected HTTP caller to the active plugin invocation."""

    while not cancelled.is_set():
        if await request.is_disconnected():
            cancelled.set()
            return
        await asyncio.sleep(0.1)
