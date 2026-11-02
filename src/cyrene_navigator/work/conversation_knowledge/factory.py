"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 factory.py                                                          │
│  Module: cyrene_navigator.work.conversation_knowledge.factory            │
│  Role: Authenticated Work routes for knowledge search and revalidation.   │
│                                                                          │
│  模块职责：暴露知识检索与来源复验路由；包选择与身份均来自服务端。         │
│  · 请求体只有查询文本与翻页游标，拒绝任何包、主体或用途字段。             │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from cyrene_navigator.persistence.errors import WORKSPACE_FORBIDDEN, PersistenceError
from cyrene_navigator.work.conversation_memory.domain_api import PrincipalResolver

from .models import (
    KnowledgeAuthorizationReceipt,
    KnowledgeAuthorizationRequest,
    KnowledgeSearchRequest,
    KnowledgeSearchResult,
)
from .ports import KnowledgePortError, KnowledgeSelectionResolver
from .service import ConversationKnowledgeService


def build_conversation_knowledge_router(
    *,
    principal_for: PrincipalResolver,
    service: ConversationKnowledgeService,
    selection_resolver: KnowledgeSelectionResolver,
) -> APIRouter:
    """Create the read-only knowledge routes over host-injected authority."""

    router = APIRouter(
        prefix="/api/v1/workspaces/{workspace_id}/work/knowledge",
        tags=["conversation-knowledge"],
    )

    def scope(request: Request, workspace_id: str):  # type: ignore[no-untyped-def]
        principal = principal_for(request, workspace_id, write=False)
        if principal.organization_id is None:
            raise PersistenceError(
                WORKSPACE_FORBIDDEN, 403, "An organization-scoped principal is required."
            )
        selection = selection_resolver.resolve(
            request, principal=principal, workspace_id=workspace_id
        )
        if selection is None:
            raise KnowledgePortError("KNOWLEDGE_PACKAGE_NOT_SELECTED", status_code=409)
        if selection.actor_id != principal.actor_id:
            raise KnowledgePortError("KNOWLEDGE_SELECTION_ACTOR_MISMATCH", status_code=403)
        return principal, selection

    @router.post("/search", response_model=KnowledgeSearchResult)
    async def search(
        workspace_id: str, body: KnowledgeSearchRequest, request: Request
    ) -> KnowledgeSearchResult | JSONResponse:
        try:
            principal, selection = scope(request, workspace_id)
            return await service.search(principal, workspace_id, selection, body)
        except KnowledgePortError as error:
            return _problem(error)

    @router.post("/authorize", response_model=KnowledgeAuthorizationReceipt)
    async def authorize(
        workspace_id: str, body: KnowledgeAuthorizationRequest, request: Request
    ) -> KnowledgeAuthorizationReceipt | JSONResponse:
        try:
            principal, selection = scope(request, workspace_id)
            return await service.authorize(principal, workspace_id, selection, body)
        except KnowledgePortError as error:
            return _problem(error)

    return router


def _problem(error: KnowledgePortError) -> JSONResponse:
    """Project a redacted stable code; upstream text never reaches the caller."""

    return JSONResponse(
        status_code=error.status_code,
        content={"code": error.code, "retryable": error.retryable},
    )


__all__ = ["build_conversation_knowledge_router"]
