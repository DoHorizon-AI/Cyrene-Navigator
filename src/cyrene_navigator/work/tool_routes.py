"""Scoped bridge from dsh to configured canonical tool.provider.v1 packages.

中文:将 dsh 调用连接到已配置的标准工具提供者,不实现第二套 CLI 或执行器。
"""

from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Callable, Mapping
from typing import Any

from fastapi import FastAPI, Request
from pydantic import BaseModel, ConfigDict, Field

from cyrene_navigator.persistence.errors import WORKSPACE_FORBIDDEN, PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal


class ToolCallBody(BaseModel):
    """The model supplies tool arguments only; host and credentials are fixed.

    中文:模型仅传工具参数,不能选择宿主或凭据。
    """

    model_config = ConfigDict(extra="forbid", strict=True)
    arguments: dict[str, Any] = Field(default_factory=dict)


def mount_work_tool_routes(
    app: FastAPI,
    authenticate: Callable[[Request, str], PersistencePrincipal],
    bridges: Mapping[tuple[str | None, str, str], Any],
) -> None:
    """Publish configured providers in their authenticated organization/workspace.

    中文:在现有组织与工作区授权边界内发布已配置工具提供者。
    """

    base = "/api/v1/workspaces/{workspace_id}/work/tool-providers"

    def resolve(request: Request, workspace_id: str, binding_id: str) -> Any:
        principal = authenticate(request, workspace_id)
        bridge = bridges.get((principal.organization_id, workspace_id, binding_id))
        if not callable(getattr(bridge, "list_tools", None)) or not callable(
            getattr(bridge, "call_tool", None)
        ):
            raise PersistenceError(
                "TOOL_PROVIDER_NOT_CONFIGURED", 404, "Tool provider not configured"
            )
        return bridge

    @app.get(base)
    def list_providers(workspace_id: str, request: Request) -> dict[str, Any]:
        """Discover only local bindings in the authorized scope. | 仅发现已授权本地绑定。"""

        principal = authenticate(request, workspace_id)
        return {
            "items": [
                {"bindingId": binding_id, "capabilityId": "tool.provider.v1"}
                for (organization_id, scope, binding_id), bridge in bridges.items()
                if organization_id == principal.organization_id
                and scope == workspace_id
                and callable(getattr(bridge, "list_tools", None))
                and callable(getattr(bridge, "call_tool", None))
            ]
        }

    @app.get(base + "/{binding_id}/tools")
    async def list_tools(workspace_id: str, binding_id: str, request: Request) -> dict[str, Any]:
        """Project the canonical provider catalog without accepting a provider URL.

        中文:投影标准工具目录,不接受请求提供的 provider URL。
        """

        result = await invoke(resolve(request, workspace_id, binding_id).list_tools)
        return bounded_object(result)

    @app.post(base + "/{binding_id}/tools/{tool_id}/call")
    async def call_tool(
        workspace_id: str, binding_id: str, tool_id: str, body: ToolCallBody, request: Request
    ) -> dict[str, Any]:
        """Invoke the installed provider; its own operation allowlist remains authoritative.

        中文:调用已安装提供者,其自身操作白名单仍是执行权限边界。
        """

        principal = authenticate(request, workspace_id)
        if not principal.can_takeover:
            raise PersistenceError(WORKSPACE_FORBIDDEN, 403, "A Workspace writer is required")
        bounded_object(body.arguments)
        result = await invoke(
            resolve(request, workspace_id, binding_id).call_tool, tool_id, body.arguments
        )
        return bounded_object(result)


async def invoke(function: Callable[..., Any], *args: Any) -> Any:
    """Keep synchronous official CLI work off the ASGI event loop. | CLI 不阻塞 ASGI。"""

    try:
        if inspect.iscoroutinefunction(function):
            return await function(*args)
        result = await asyncio.to_thread(function, *args)
        return await result if inspect.isawaitable(result) else result
    except Exception:
        raise PersistenceError(
            "TOOL_PROVIDER_FAILED", 502, "Configured tool provider failed"
        ) from None


def bounded_object(value: Any) -> dict[str, Any]:
    """Keep provider payloads finite JSON and bounded in size. | 限制有限 JSON 负载大小。"""

    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise PersistenceError("TOOL_PROVIDER_INVALID_PAYLOAD", 502, "Invalid provider payload")
    try:
        encoded = json.dumps(value, allow_nan=False)
    except (ValueError, TypeError):
        raise PersistenceError(
            "TOOL_PROVIDER_INVALID_PAYLOAD", 502, "Invalid provider payload"
        ) from None
    if len(encoded.encode("utf-8")) > 2_000_000:
        raise PersistenceError("TOOL_PROVIDER_PAYLOAD_TOO_LARGE", 413, "Provider payload too large")
    return value
