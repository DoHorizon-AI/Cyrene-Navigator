"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 ports.py                                                            │
│  Module: cyrene_navigator.work.conversation_knowledge.ports              │
│  Role: Inject Catalyst reads, explicit package selection, and retrieval.  │
│                                                                          │
│  模块职责：定义 Catalyst 读取、人工选择与签名检索的宿主端口。             │
│  · 选择、身份映射和 Plugin binding 均由服务端注入。                      │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Protocol

from fastapi import Request

from cyrene_navigator.persistence.store import PersistencePrincipal

_UUID = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z"
)
_SELECTOR = re.compile(r"[A-Za-z0-9._-]{1,128}\Z")


class KnowledgePortError(Exception):
    """Redacted failure raised at a fixed Catalyst or ToolProvider boundary."""

    def __init__(
        self,
        code: str,
        *,
        status_code: int = 503,
        retryable: bool = False,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code
        self.retryable = retryable


class CatalystKnowledgePort(Protocol):
    """Workspace-scoped read-only access to canonical Catalyst Product APIs."""

    async def list_datasets(
        self, principal: PersistencePrincipal, workspace_id: str
    ) -> list[dict[str, Any]]:
        """List only datasets in the configured organization and Workspace."""

    async def list_dataset_versions(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        dataset_id: str,
    ) -> list[dict[str, Any]]:
        """Return the exact Product-owned DatasetVersion projections."""

    async def get_content_block_page(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        content_revision_id: str,
        *,
        offset: int,
        limit: int,
    ) -> dict[str, Any]:
        """Read a bounded page of the exact immutable ContentRevision blocks."""


class KnowledgeSelectionResolver(Protocol):
    """Resolve a user-selected package from server-owned turn context.

    The request body is intentionally absent from this interface: the model
    cannot choose a DatasetVersion, library selector, artifact, or principal.
    """

    def resolve(
        self,
        request: Request,
        *,
        principal: PersistencePrincipal,
        workspace_id: str,
    ) -> KnowledgePackageSelection | None:
        """Return the exact package selected for this actor and active turn."""


class KnowledgePrincipalRefResolver(Protocol):
    """Resolve exact Catalyst ACL principal refs from authenticated host identity."""

    def resolve(self, *, principal: PersistencePrincipal, workspace_id: str) -> tuple[str, ...]:
        """Return only server-mapped principal refs for the signed host identity."""


class KnowledgeToolProviderPort(Protocol):
    """Call the configured `knowledge.search` tool with a signed host envelope."""

    async def search(
        self,
        *,
        principal: PersistencePrincipal,
        workspace_id: str,
        arguments: dict[str, Any],
        request_id: str,
    ) -> dict[str, Any]:
        """Return the actual ToolProvider JSON result without substituting a fixture."""


@dataclass(frozen=True, slots=True)
class KnowledgePackageSelection:
    """Server-selected Product version and provider-registry selector."""

    library_selector: str
    dataset_id: str
    dataset_version_id: str
    actor_id: str

    def __post_init__(self) -> None:
        """Keep all opaque package identifiers within closed bounds."""

        if _SELECTOR.fullmatch(self.library_selector) is None:
            raise ValueError("knowledge library selector is invalid")
        if _UUID.fullmatch(self.dataset_id) is None:
            raise ValueError("knowledge Dataset id is invalid")
        if _UUID.fullmatch(self.dataset_version_id) is None:
            raise ValueError("knowledge DatasetVersion id is invalid")
        if not self.actor_id or len(self.actor_id) > 512:
            raise ValueError("knowledge selection actor is invalid")


__all__ = [
    "CatalystKnowledgePort",
    "KnowledgePackageSelection",
    "KnowledgePortError",
    "KnowledgePrincipalRefResolver",
    "KnowledgeSelectionResolver",
    "KnowledgeToolProviderPort",
]
