"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 providers.py                                                      │
│  Module: cyrene_navigator.work.conversation_memory.providers           │
│  Role: Typed seams for real embeddings and memory-provider plugins.   │
│                                                                      │
│  模块职责：定义真实向量与记忆检索插件的注入契约，不提供模拟实现。       │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from cyrene_navigator.persistence.errors import PersistenceError


@dataclass(frozen=True, slots=True)
class EmbeddingBatch:
    """One provider response bound to its model identity and vector dimensions."""

    vectors: tuple[tuple[float, ...], ...]
    model: str
    dimensions: int

    def __post_init__(self) -> None:
        """Reject malformed, non-finite, and all-zero provider outputs."""

        if not self.model or self.dimensions < 1 or not self.vectors:
            raise ValueError("embedding batch identity and vectors are required")
        for vector in self.vectors:
            if len(vector) != self.dimensions:
                raise ValueError("embedding vector dimensions do not match the batch")
            if not all(math.isfinite(value) for value in vector):
                raise ValueError("embedding vectors must contain only finite values")
            if not any(value != 0 for value in vector):
                raise ValueError("all-zero embeddings are not accepted")


@dataclass(frozen=True, slots=True)
class MemoryProviderHit:
    """A provider match before Navigator applies source authorization."""

    memory_id: str
    score: float
    model: str
    dimensions: int


@dataclass(frozen=True, slots=True)
class MemoryProviderScope:
    """Server-derived scope filters supplied to memory.provider.v1."""

    organization_id: str | None
    workspace_id: str
    actor_id: str
    conversation_id: str | None
    conversation_kind: str | None
    persona_id: str | None
    visibility: str | None = None


@dataclass(frozen=True, slots=True)
class GraphProviderReadback:
    """Independent graph state returned after provider upsert and read-back."""

    readback_digest: str
    node_count: int
    edge_count: int


class KnowledgeGraphProvider(Protocol):
    """Narrow host adapter over the published ``knowledge.graph.v1`` capability."""

    def apply_changeset(
        self,
        *,
        organization_id: str,
        workspace_id: str,
        actor_id: str,
        changeset: Mapping[str, object],
    ) -> GraphProviderReadback:
        """Upsert a proposal and independently read back every node and edge."""
        ...

    def query(
        self,
        *,
        organization_id: str,
        workspace_id: str,
        actor_id: str,
        conversation_id: str,
        conversation_kind: str,
        persona_id: str | None,
        query: str,
        limit: int,
    ) -> Sequence[Mapping[str, object]]:
        """Return bounded graph matches with their original source message IDs."""
        ...


class EmbeddingClient(Protocol):
    """Invoke the configured model.provider.v1 embeddings method."""

    def embed(self, texts: Sequence[str], *, model: str | None = None) -> EmbeddingBatch:
        """Return real vectors or raise a safe typed provider failure."""
        ...


class MemoryProvider(Protocol):
    """Narrow adapter over the published memory.provider.v1 capability."""

    def upsert(
        self,
        *,
        memory_id: str,
        text: str,
        embedding: tuple[float, ...],
        model: str,
        dimensions: int,
        scope: MemoryProviderScope,
        authorization_epoch: int,
    ) -> None:
        """Index one authorized memory projection idempotently."""
        ...

    def query(
        self,
        *,
        text: str,
        embedding: tuple[float, ...],
        model: str,
        dimensions: int,
        scope: MemoryProviderScope,
        limit: int,
    ) -> Sequence[MemoryProviderHit]:
        """Return candidate IDs; Navigator rechecks each result's provenance."""
        ...

    def delete(self, *, memory_ids: Sequence[str], scope: MemoryProviderScope) -> None:
        """Remove indexed projections for the exact server-derived scope."""
        ...


def provider_unavailable(code: str, detail: str) -> PersistenceError:
    """Create a stable 503 that prevents absent providers from looking successful."""

    return PersistenceError(code, 503, detail, retryable=True)
