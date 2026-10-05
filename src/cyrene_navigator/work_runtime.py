"""Scoped local work-service proxy configuration.

The paired Web Host forwards only the deployment's configured workspace and
keeps downstream credentials out of browser requests. 同源代理不向浏览器暴露凭据。
"""

from __future__ import annotations

import re
from urllib.parse import quote

from cyrene_navigator.web_host import ProxyTarget


def work_proxy_targets(
    *,
    persistence_url: str,
    executor_url: str,
    workspace_id: str,
    persistence_token: str,
    executor_token: str,
) -> dict[str, ProxyTarget]:
    """Build fixed, credential-bearing targets for one paired owner workspace."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}", workspace_id):
        raise ValueError("workspace_id must be a bounded deployment identifier")
    if not persistence_token or not executor_token:
        raise ValueError("work-service credentials are required")
    workspace_path = "/api/v1/workspaces/" + quote(workspace_id, safe="") + "/work"
    return {
        "/api/v1/tasks": ProxyTarget(
            executor_url.rstrip("/") + "/api/v1/tasks",
            bearer_token=executor_token,
            timeout_seconds=600,
        ),
        "/api/v1/execute": ProxyTarget(
            executor_url.rstrip("/") + "/api/v1/execute",
            bearer_token=executor_token,
            timeout_seconds=600,
        ),
        workspace_path: ProxyTarget(
            persistence_url.rstrip("/") + workspace_path,
            bearer_token=persistence_token,
        ),
    }
