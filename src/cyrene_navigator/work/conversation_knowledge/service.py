"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 service.py                                                          │
│  Module: cyrene_navigator.work.conversation_knowledge.service            │
│  Role: Fresh package selection, signed retrieval, and source revalidation.│
│                                                                          │
│  模块职责：每次检索前后按 Catalyst 当前状态复核知识包与来源策略。         │
│  · stale、撤权、选择变化都会失败关闭；模型只提供查询文本。                │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Callable, Mapping
from typing import Any

from pydantic import ValidationError

from cyrene_navigator.persistence.store import PersistencePrincipal

from .models import (
    CatalystArtifactRef,
    KnowledgeAuthorizationReceipt,
    KnowledgeAuthorizationRequest,
    KnowledgeCitation,
    KnowledgePackageIdentity,
    KnowledgeSearchHit,
    KnowledgeSearchRequest,
    KnowledgeSearchResult,
)
from .ports import (
    CatalystKnowledgePort,
    KnowledgePackageSelection,
    KnowledgePortError,
    KnowledgePrincipalRefResolver,
    KnowledgeToolProviderPort,
)
from .provider import new_knowledge_request_id

KNOWLEDGE_PROFILE = "CYRENE_KNOWLEDGE_BUNDLE_V1"
KNOWLEDGE_PURPOSE = "knowledge_retrieval"


class ConversationKnowledgeService:
    """Consume one explicitly selected, published Catalyst knowledge package.

    Nothing the model supplies selects the package, the principal, or the
    purpose. Catalyst is re-read before the signed search call, after it for
    every returned block, and again on demand before context or delivery.
    """

    def __init__(
        self,
        catalyst: CatalystKnowledgePort,
        tool_provider: KnowledgeToolProviderPort,
        principal_refs: KnowledgePrincipalRefResolver,
        *,
        now_ms: Callable[[], int] = lambda: time.time_ns() // 1_000_000,
    ) -> None:
        self._catalyst = catalyst
        self._tool_provider = tool_provider
        self._principal_refs = principal_refs
        self._now_ms = now_ms

    async def search(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        selection: KnowledgePackageSelection,
        request: KnowledgeSearchRequest,
    ) -> KnowledgeSearchResult:
        """Search the selected package and return only currently authorized hits."""

        refs = self._refs(principal, workspace_id)
        package = await self.resolve_package(principal, workspace_id, selection)
        arguments: dict[str, Any] = {
            "librarySelector": selection.library_selector,
            "query": request.query,
            "limit": request.limit,
        }
        if request.cursor is not None:
            arguments["chunkCursor"] = request.cursor
        raw = await self._tool_provider.search(
            principal=principal,
            workspace_id=workspace_id,
            arguments=arguments,
            request_id=new_knowledge_request_id(),
        )
        result = _result_from_provider(raw, package, request)
        await self._recheck_citations(
            principal, workspace_id, package, [hit.citation for hit in result.hits], refs
        )
        # A package republished or revoked while the provider ranked must not leak.
        current = await self.resolve_package(principal, workspace_id, selection)
        if current.model_dump(mode="json") != package.model_dump(mode="json"):
            raise KnowledgePortError("KNOWLEDGE_PACKAGE_CHANGED", status_code=409)
        return result

    async def authorize(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        selection: KnowledgePackageSelection,
        request: KnowledgeAuthorizationRequest,
    ) -> KnowledgeAuthorizationReceipt:
        """Recheck an earlier page against current package and source policy.

        A denial is a normal receipt with a reason code, so callers can hold a
        context contribution or reply without treating it as a transport error.
        """

        if (
            selection.dataset_id.lower() != request.dataset_id.lower()
            or selection.dataset_version_id.lower() != request.dataset_version_id.lower()
            or selection.library_selector != request.library_selector
        ):
            raise KnowledgePortError("KNOWLEDGE_SELECTION_CHANGED", status_code=409)
        refs = self._refs(principal, workspace_id)
        try:
            package = await self.resolve_package(principal, workspace_id, selection)
            await self._recheck_citations(
                principal, workspace_id, package, list(request.citations), refs
            )
        except KnowledgePortError as error:
            if error.status_code not in {403, 404, 409}:
                raise
            return self._receipt(request, allowed=False, reason=error.code, package=None)
        return self._receipt(request, allowed=True, reason=None, package=package)

    async def resolve_package(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        selection: KnowledgePackageSelection,
    ) -> KnowledgePackageIdentity:
        """Read the exact published DatasetVersion again; stale packages are held."""

        datasets = await self._catalyst.list_datasets(principal, workspace_id)
        dataset = next(
            (item for item in datasets if _same_id(item.get("id"), selection.dataset_id)), None
        )
        if dataset is None:
            raise KnowledgePortError("KNOWLEDGE_DATASET_UNAVAILABLE", status_code=404)
        versions = await self._catalyst.list_dataset_versions(
            principal, workspace_id, selection.dataset_id
        )
        version = next(
            (
                item
                for item in versions
                if _same_id(item.get("id"), selection.dataset_version_id)
                and _same_id(item.get("datasetId"), selection.dataset_id)
            ),
            None,
        )
        if version is None:
            raise KnowledgePortError("KNOWLEDGE_VERSION_UNAVAILABLE", status_code=404)
        if version.get("state") != "PUBLISHED":
            raise KnowledgePortError("KNOWLEDGE_VERSION_NOT_PUBLISHED", status_code=409)
        tools = version.get("dataTools")
        if not isinstance(tools, Mapping):
            raise KnowledgePortError("KNOWLEDGE_PACKAGE_UNAVAILABLE", status_code=409)
        if tools.get("stale") is not False:
            raise KnowledgePortError("KNOWLEDGE_PACKAGE_STALE", status_code=409)
        if tools.get("knowledgeProfile") != KNOWLEDGE_PROFILE:
            raise KnowledgePortError("KNOWLEDGE_PACKAGE_UNAVAILABLE", status_code=409)
        try:
            artifact = CatalystArtifactRef.model_validate(tools.get("knowledgeArtifact"))
            return KnowledgePackageIdentity(
                library_selector=selection.library_selector,
                dataset_id=selection.dataset_id.lower(),
                dataset_name=str(dataset.get("name")),
                dataset_version_id=selection.dataset_version_id.lower(),
                version=version.get("version"),  # type: ignore[arg-type]
                content_revision_id=tools.get("contentRevisionId"),  # type: ignore[arg-type]
                source_revision_ids=tools.get("sourceRevisionIds"),  # type: ignore[arg-type]
                knowledge_profile=KNOWLEDGE_PROFILE,
                artifact_ref=artifact,
                resource_version=version.get("resourceVersion"),  # type: ignore[arg-type]
            )
        except ValidationError:
            raise KnowledgePortError(
                "KNOWLEDGE_PACKAGE_RESPONSE_INVALID", status_code=502
            ) from None

    def _refs(self, principal: PersistencePrincipal, workspace_id: str) -> frozenset[str]:
        refs = frozenset(
            self._principal_refs.resolve(principal=principal, workspace_id=workspace_id)
        )
        if not refs:
            raise KnowledgePortError("KNOWLEDGE_PRINCIPAL_UNMAPPED", status_code=403)
        return refs

    async def _recheck_citations(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        package: KnowledgePackageIdentity,
        citations: list[KnowledgeCitation],
        refs: frozenset[str],
    ) -> None:
        """Require every cited block to be allowed by its current stored policy."""

        seen: set[tuple[str, int]] = set()
        for citation in citations:
            if (
                citation.dataset_id.lower() != package.dataset_id
                or citation.dataset_version_id.lower() != package.dataset_version_id
                or citation.content_revision_id.lower() != package.content_revision_id.lower()
                or citation.library_selector != package.library_selector
                or citation.source_revision_id not in package.source_revision_ids
            ):
                raise KnowledgePortError("KNOWLEDGE_CITATION_MISMATCH", status_code=409)
            key = (citation.block_id, citation.block_ordinal)
            if key in seen:
                continue
            seen.add(key)
            page = await self._catalyst.get_content_block_page(
                principal,
                workspace_id,
                package.content_revision_id,
                offset=citation.block_ordinal,
                limit=1,
            )
            blocks = page.get("blocks")
            block = blocks[0] if isinstance(blocks, list) and len(blocks) == 1 else None
            if (
                not isinstance(block, Mapping)
                or block.get("id") != citation.block_id
                or block.get("ordinal") != citation.block_ordinal
                or not _same_id(block.get("sourceRevisionId"), citation.source_revision_id)
            ):
                raise KnowledgePortError("KNOWLEDGE_SOURCE_NOT_AUTHORIZED", status_code=403)
            if not _policy_allows(block.get("policy"), refs):
                raise KnowledgePortError("KNOWLEDGE_SOURCE_NOT_AUTHORIZED", status_code=403)

    def _receipt(
        self,
        request: KnowledgeAuthorizationRequest,
        *,
        allowed: bool,
        reason: str | None,
        package: KnowledgePackageIdentity | None,
    ) -> KnowledgeAuthorizationReceipt:
        content_revision = (
            package.content_revision_id if package else request.citations[0].content_revision_id
        )
        package_digest = package.artifact_ref.digest if package else "sha256:" + "0" * 64
        return KnowledgeAuthorizationReceipt(
            allowed=allowed,
            dataset_version_id=request.dataset_version_id,
            content_revision_id=content_revision,
            package_digest=package_digest,
            result_digest=request.result_digest,
            checked_at=self._now_ms(),
            reason_code=reason,
        )


def _policy_allows(policy: object, refs: frozenset[str]) -> bool:
    """Match the plugin's stored-policy rule against current Catalyst policy."""

    if not isinstance(policy, Mapping):
        return False
    principals = policy.get("allowedPrincipalRefs")
    purposes = policy.get("allowedUsePurposes")
    return (
        policy.get("allowKnowledge") is True
        and isinstance(purposes, list)
        and KNOWLEDGE_PURPOSE in purposes
        and isinstance(principals, list)
        and any(isinstance(item, str) and item in refs for item in principals)
    )


def _same_id(left: object, right: str) -> bool:
    return isinstance(left, str) and left.lower() == right.lower()


def _result_from_provider(
    raw: Mapping[str, Any],
    package: KnowledgePackageIdentity,
    request: KnowledgeSearchRequest,
) -> KnowledgeSearchResult:
    """Verify the provider page against the freshly resolved package identity."""

    artifact = package.artifact_ref
    hits_raw = raw.get("hits")
    if (
        raw.get("librarySelector") != package.library_selector
        or raw.get("packageDigest") != artifact.digest
        or (
            artifact.manifest_digest is not None
            and raw.get("manifestDigest") != artifact.manifest_digest
        )
        or raw.get("usePurpose") != KNOWLEDGE_PURPOSE
        or raw.get("query") != request.query
        or not _same_id(raw.get("contentRevisionId"), package.content_revision_id)
        or not isinstance(hits_raw, list)
        or len(hits_raw) > request.limit
    ):
        raise KnowledgePortError("KNOWLEDGE_PROVIDER_RESPONSE_MISMATCH", status_code=502)
    try:
        hits = [_hit(item, package) for item in hits_raw]
        next_cursor = raw.get("nextCursor")
        result = KnowledgeSearchResult(
            package=package,
            query=request.query,
            use_purpose=KNOWLEDGE_PURPOSE,
            package_digest=artifact.digest,
            manifest_digest=str(raw.get("manifestDigest")),
            content_revision_id=package.content_revision_id,
            result_digest=_result_digest(package, request, hits, next_cursor),
            hits=hits,
            next_cursor=next_cursor if isinstance(next_cursor, str) else None,
        )
    except (ValidationError, KeyError, TypeError, ValueError):
        raise KnowledgePortError("KNOWLEDGE_PROVIDER_RESPONSE_INVALID", status_code=502) from None
    return result


def _hit(item: object, package: KnowledgePackageIdentity) -> KnowledgeSearchHit:
    if not isinstance(item, Mapping) or not isinstance(item.get("chunk"), Mapping):
        raise ValueError("hit shape")
    chunk = item["chunk"]
    return KnowledgeSearchHit(
        text=chunk["text"],
        score=float(item["score"]),
        citation=KnowledgeCitation(
            library_selector=package.library_selector,
            dataset_id=package.dataset_id,
            dataset_version_id=package.dataset_version_id,
            content_revision_id=chunk["contentRevisionId"],
            source_revision_id=chunk["sourceRevisionId"],
            source_id=chunk["sourceId"],
            block_id=chunk["blockId"],
            block_ordinal=chunk["blockOrdinal"],
            chunk_id=chunk["chunkId"],
            locator=chunk["locator"],
            hierarchy_path=chunk["hierarchyPath"],
            asset_refs=chunk["assetRefs"],
        ),
    )


def _result_digest(
    package: KnowledgePackageIdentity,
    request: KnowledgeSearchRequest,
    hits: list[KnowledgeSearchHit],
    next_cursor: object,
) -> str:
    """Bind an earlier page to its package, query, limit, and exact chunk text."""

    material = {
        "packageDigest": package.artifact_ref.digest,
        "datasetVersionId": package.dataset_version_id,
        "query": request.query,
        "limit": request.limit,
        "cursor": request.cursor,
        "hits": [
            {
                "chunkId": hit.citation.chunk_id,
                "textSha256": hashlib.sha256(hit.text.encode("utf-8")).hexdigest(),
            }
            for hit in hits
        ],
        "nextCursor": next_cursor if isinstance(next_cursor, str) else None,
    }
    encoded = json.dumps(material, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


__all__ = ["KNOWLEDGE_PROFILE", "KNOWLEDGE_PURPOSE", "ConversationKnowledgeService"]
