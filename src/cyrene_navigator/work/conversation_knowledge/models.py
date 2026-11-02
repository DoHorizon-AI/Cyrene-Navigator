"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 models.py                                                           │
│  Module: cyrene_navigator.work.conversation_knowledge.models             │
│  Role: Strict package, search, citation, and revalidation DTOs.           │
│                                                                          │
│  模块职责：定义知识包、检索、引用与复验的严格线格式。                     │
│  · 客户端不能提交 principal、ArtifactRef 路径或 ToolProvider 身份。       │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from cyrene_navigator.work.models import WorkModel

_UUID = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
_SHA256 = r"^sha256:[0-9a-f]{64}$"
_MAX_QUERY_CHARS = 4_096
_MAX_PAGE_SIZE = 20
_MAX_CITATIONS = 100


class CatalystArtifactRef(BaseModel):
    """Provider-neutral immutable ArtifactRef as returned by Catalyst."""

    model_config = ConfigDict(extra="forbid", strict=True)

    uri: str = Field(pattern=r"^artifact://sha256/[0-9a-f]{64}$")
    digest: str = Field(pattern=_SHA256)
    size_bytes: int = Field(ge=1, le=268_435_456)
    kind: str = Field(min_length=1, max_length=128)
    manifest_digest: str | None = Field(default=None, pattern=_SHA256)

    @model_validator(mode="after")
    def uri_matches_digest(self) -> CatalystArtifactRef:
        """Reject references whose opaque URI and digest identify different bytes."""

        if self.uri != f"artifact://sha256/{self.digest.removeprefix('sha256:')}":
            raise ValueError("ArtifactRef uri and digest do not match")
        return self


class KnowledgeSearchRequest(WorkModel):
    """Model query only; package, principal, and purpose are server-selected."""

    query: str = Field(min_length=1, max_length=_MAX_QUERY_CHARS)
    limit: int = Field(default=5, ge=1, le=_MAX_PAGE_SIZE)
    cursor: str | None = Field(default=None, min_length=1, max_length=1_024)

    @field_validator("query")
    @classmethod
    def query_must_have_text(cls, value: str) -> str:
        """Reject whitespace-only retrieval calls before a Plugin invocation."""

        if not value.strip():
            raise ValueError("query must contain non-whitespace text")
        return value


class KnowledgePackageIdentity(WorkModel):
    """Exact selected Catalyst DatasetVersion and its immutable package ref."""

    library_selector: str = Field(min_length=1, max_length=128)
    dataset_id: str = Field(pattern=_UUID)
    dataset_name: str = Field(min_length=1, max_length=200)
    dataset_version_id: str = Field(pattern=_UUID)
    version: int = Field(ge=1)
    content_revision_id: str = Field(pattern=_UUID)
    source_revision_ids: list[str] = Field(min_length=1, max_length=20_000)
    knowledge_profile: str = Field(pattern=r"^CYRENE_KNOWLEDGE_BUNDLE_V1$")
    artifact_ref: CatalystArtifactRef
    resource_version: int = Field(ge=1)

    @field_validator("source_revision_ids")
    @classmethod
    def source_ids_are_unique(cls, value: list[str]) -> list[str]:
        """Reject repeated source identities in one published package projection."""

        if len(value) != len(set(value)) or any(_UUID.fullmatch(item) is None for item in value):
            raise ValueError("source revision ids must be unique UUIDs")
        return value


class KnowledgeCitation(WorkModel):
    """Source and locator identity for one authorized knowledge chunk."""

    library_selector: str = Field(min_length=1, max_length=128)
    dataset_id: str = Field(pattern=_UUID)
    dataset_version_id: str = Field(pattern=_UUID)
    content_revision_id: str = Field(pattern=_UUID)
    source_revision_id: str = Field(pattern=_UUID)
    source_id: str = Field(pattern=_UUID)
    block_id: str = Field(min_length=1, max_length=300)
    block_ordinal: int = Field(ge=0)
    chunk_id: str = Field(pattern=_SHA256)
    locator: dict[str, Any]
    hierarchy_path: list[str] = Field(default_factory=list, max_length=64)
    asset_refs: list[dict[str, Any]] = Field(default_factory=list, max_length=64)


class KnowledgeAuthorizationRequest(WorkModel):
    """Current source-authorization recheck for one earlier search page."""

    dataset_id: str = Field(pattern=_UUID)
    dataset_version_id: str = Field(pattern=_UUID)
    library_selector: str = Field(min_length=1, max_length=128)
    query: str = Field(min_length=1, max_length=_MAX_QUERY_CHARS)
    limit: int = Field(ge=1, le=_MAX_PAGE_SIZE)
    cursor: str | None = Field(default=None, min_length=1, max_length=1_024)
    result_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    citations: list[KnowledgeCitation] = Field(min_length=1, max_length=_MAX_CITATIONS)


class KnowledgeSearchHit(WorkModel):
    """One bounded BM25 result and its exact Catalyst provenance."""

    text: str = Field(min_length=1, max_length=10_000)
    score: float = Field(ge=0, le=1_000_000)
    citation: KnowledgeCitation


class KnowledgeSearchResult(WorkModel):
    """A verified provider page ready for context projection."""

    package: KnowledgePackageIdentity
    query: str = Field(min_length=1, max_length=_MAX_QUERY_CHARS)
    use_purpose: str = Field(pattern=r"^knowledge_retrieval$")
    package_digest: str = Field(pattern=_SHA256)
    manifest_digest: str = Field(pattern=_SHA256)
    content_revision_id: str = Field(pattern=_UUID)
    result_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    hits: list[KnowledgeSearchHit] = Field(max_length=_MAX_PAGE_SIZE)
    next_cursor: str | None = Field(default=None, max_length=1_024)

    @model_validator(mode="after")
    def hit_identities_match_package(self) -> KnowledgeSearchResult:
        """Keep every hit bound to the exact selected package and revision."""

        if (
            self.package_digest != self.package.artifact_ref.digest
            or self.content_revision_id != self.package.content_revision_id
            or self.query == ""
            or any(
                hit.citation.library_selector != self.package.library_selector
                or hit.citation.dataset_id != self.package.dataset_id
                or hit.citation.dataset_version_id != self.package.dataset_version_id
                or hit.citation.content_revision_id != self.package.content_revision_id
                or hit.citation.source_revision_id not in self.package.source_revision_ids
                for hit in self.hits
            )
        ):
            raise ValueError("knowledge hit provenance does not match its selected package")
        return self


class KnowledgeAuthorizationReceipt(WorkModel):
    """Fresh Catalyst/package recheck result; no synthetic authorization epoch."""

    allowed: bool
    dataset_version_id: str = Field(pattern=_UUID)
    content_revision_id: str = Field(pattern=_UUID)
    package_digest: str = Field(pattern=_SHA256)
    result_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    checked_at: int = Field(ge=0)
    reason_code: str | None = Field(default=None, max_length=96)


__all__ = [
    "CatalystArtifactRef",
    "KnowledgeAuthorizationReceipt",
    "KnowledgeAuthorizationRequest",
    "KnowledgeCitation",
    "KnowledgePackageIdentity",
    "KnowledgeSearchHit",
    "KnowledgeSearchRequest",
    "KnowledgeSearchResult",
]
