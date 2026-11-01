"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 api.py                                                           │
│  Module: cyrene_navigator.work.conversation_connectors               │
│  Role: Mount authenticated QQ connector status and lifecycle hooks.   │
│                                                                      │
│  模块职责：挂载受认证的 QQ 连接器状态接口与生命周期钩子。             │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Iterable
from contextlib import asynccontextmanager
from typing import Any, Protocol

from fastapi import FastAPI, Request

from .qq import QQConnectorBinding, QQConversationConnector
from .types import ConversationConnectorHostPortV1


class WorkspacePrincipal(Protocol):
    """Minimum authenticated principal fields needed for scoped status reads."""

    organization_id: str | None


PrincipalFor = Callable[[Request, str], WorkspacePrincipal]


class ConversationConnectorRuntime:
    """Own long-lived adapters for server-configured QQ bindings."""

    def __init__(
        self,
        bindings: Iterable[QQConnectorBinding],
        host_port: ConversationConnectorHostPortV1,
    ) -> None:
        self._connectors = tuple(
            QQConversationConnector(binding, host_port) for binding in bindings
        )
        binding_ids = [connector.binding.binding_id for connector in self._connectors]
        if len(binding_ids) != len(set(binding_ids)):
            raise ValueError("QQ connector binding IDs must be unique")

    async def start(self) -> None:
        """Start every configured binding without blocking the app startup loop."""

        await asyncio.gather(*(connector.start() for connector in self._connectors))

    async def close(self) -> None:
        """Stop and release all QQ subscriptions."""

        await asyncio.gather(*(connector.close() for connector in self._connectors))

    def statuses_for(self, organization_id: str | None, workspace_id: str) -> list[dict[str, Any]]:
        """Return only redacted statuses for the authenticated workspace."""

        return [
            connector.status
            for connector in self._connectors
            if connector.binding.organization_id == organization_id
            and connector.binding.workspace_id == workspace_id
        ]


def mount_conversation_connector_routes(
    app: FastAPI,
    base: str,
    principal_for: PrincipalFor,
    host_port: ConversationConnectorHostPortV1,
    bindings: Iterable[QQConnectorBinding] = (),
) -> ConversationConnectorRuntime:
    """Mount authenticated QQ runtime status and app startup/shutdown hooks.

    Bindings are supplied by server configuration. The route cannot create or
    change an account, endpoint, subscription, actor mapping, or destination.
    中文：绑定仅来自服务端配置；HTTP 路由不能创建或修改账号、endpoint、订阅或身份映射。
    """

    runtime = ConversationConnectorRuntime(bindings, host_port)
    app.state.conversation_connector_runtime = runtime
    previous_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[Any]:
        async with previous_lifespan(application) as state:
            await runtime.start()
            try:
                yield state
            finally:
                await runtime.close()

    app.router.lifespan_context = lifespan

    @app.get(base + "/conversation-connectors/qq")
    def list_qq_bindings(workspace_id: str, request: Request) -> dict[str, object]:
        principal = principal_for(request, workspace_id)
        return {
            "items": runtime.statuses_for(principal.organization_id, workspace_id),
        }

    return runtime
