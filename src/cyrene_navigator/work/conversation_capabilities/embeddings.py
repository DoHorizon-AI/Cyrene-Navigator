"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 embeddings.py                                                        │
│  Module: cyrene_navigator.work.conversation_capabilities.embeddings       │
│  Role: Invoke the real model.provider.v1 embeddings RPC.                  │
│                                                                          │
│  模块职责：调用真实 embedding 插件并绑定模型身份、维数和输入用途。       │
│  · E5 文档与查询使用各自前缀；任何 malformed/zero 向量均失败关闭。       │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Literal

from cyrene_model_provider_contracts.embeddings import (
    CAPABILITY_ID,
    EMBEDDINGS_METHOD,
    EMBEDDINGS_REQUEST_TYPE_URL,
    EMBEDDINGS_RESPONSE_TYPE_URL,
    EmbeddingErrorCode,
    EmbeddingsCodecError,
    EmbeddingsRequest,
    decode_embeddings_response,
    encode_embeddings_request,
)
from cyrene_plugin_runtime import DirectPluginClient

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.work.conversation_memory.providers import EmbeddingBatch

from .config import EmbeddingProfile, PluginBindingSettings
from .runtime import DirectCapabilityError, invoke_typed

_MAX_INPUTS = 32
_MAX_INPUT_BYTES = 32 * 1024
_MAX_BATCH_BYTES = 256 * 1024
_RETRYABLE_EMBEDDING_CODES = {int(EmbeddingErrorCode.RATE_LIMITED)}


class DirectEmbeddingClient:
    """Call a fixed model.provider.v1 embedding method without synthetic fallback."""

    def __init__(
        self,
        client: DirectPluginClient,
        binding: PluginBindingSettings,
        profile: EmbeddingProfile,
    ) -> None:
        self._client = client
        self._binding = binding
        self._profile = profile

    def embed(
        self,
        texts: Sequence[str],
        *,
        model: str | None = None,
        purpose: Literal["document", "query"] = "document",
    ) -> EmbeddingBatch:
        """Return real model vectors after validating order, identity, and dimensions."""

        if purpose not in {"document", "query"}:
            raise _embedding_failure("MEMORY_EMBEDDING_PURPOSE_INVALID")
        if model is not None and model != self._profile.model_id:
            raise _embedding_failure("MEMORY_EMBEDDING_MODEL_MISMATCH")
        normalized = _validate_inputs(texts)
        prefix = (
            self._profile.document_prefix if purpose == "document" else self._profile.query_prefix
        )
        request = EmbeddingsRequest(
            inputs=tuple(prefix + text for text in normalized),
            model=self._profile.model_id,
        )
        try:
            encoded_request = encode_embeddings_request(request)
            result = invoke_typed(
                self._client,
                capability=CAPABILITY_ID,
                interface_version="1",
                method=EMBEDDINGS_METHOD,
                request_type_url=EMBEDDINGS_REQUEST_TYPE_URL,
                request_bytes=encoded_request,
                response_type_url=EMBEDDINGS_RESPONSE_TYPE_URL,
                deadline_seconds=self._binding.deadline_seconds,
            )
            response = decode_embeddings_response(result.value)
        except DirectCapabilityError as error:
            raise PersistenceError(
                error.code,
                503 if error.unavailable else 502,
                "The configured embedding provider is unavailable or failed.",
                error.retryable,
            ) from error
        except (EmbeddingsCodecError, ValueError) as error:
            raise _embedding_failure("MEMORY_EMBEDDING_UNAVAILABLE") from error
        if response.error is not None:
            code = int(response.error.code)
            retryable = code in _RETRYABLE_EMBEDDING_CODES
            raise _embedding_failure("MEMORY_EMBEDDING_PROVIDER_FAILED", retryable=retryable)
        batch = response.embeddings
        if batch is None:
            raise _embedding_failure("MEMORY_EMBEDDING_RESPONSE_INVALID")
        if (
            batch.model != self._profile.model_id
            or batch.dimensions != self._profile.dimensions
            or len(batch.vectors) != len(normalized)
        ):
            raise _embedding_failure("MEMORY_EMBEDDING_RESPONSE_MISMATCH")
        vectors: list[tuple[float, ...]] = []
        for vector in batch.vectors:
            values = tuple(vector.values)
            if (
                len(values) != self._profile.dimensions
                or not all(math.isfinite(value) for value in values)
                or not any(value != 0 for value in values)
            ):
                raise _embedding_failure("MEMORY_EMBEDDING_RESPONSE_INVALID")
            vectors.append(values)
        try:
            return EmbeddingBatch(
                vectors=tuple(vectors),
                model=batch.model,
                dimensions=batch.dimensions,
            )
        except ValueError as error:
            raise _embedding_failure("MEMORY_EMBEDDING_RESPONSE_INVALID") from error


def _validate_inputs(texts: Sequence[str]) -> tuple[str, ...]:
    """Bound embedding batches and reject empty or non-text inputs before RPC."""

    if not isinstance(texts, Sequence) or isinstance(texts, (str, bytes)):
        raise _embedding_failure("MEMORY_EMBEDDING_INPUT_INVALID")
    if not 1 <= len(texts) <= _MAX_INPUTS:
        raise _embedding_failure("MEMORY_EMBEDDING_INPUT_LIMIT")
    result: list[str] = []
    total_bytes = 0
    for text in texts:
        if not isinstance(text, str) or not text.strip():
            raise _embedding_failure("MEMORY_EMBEDDING_INPUT_INVALID")
        size = len(text.encode("utf-8"))
        if size > _MAX_INPUT_BYTES:
            raise _embedding_failure("MEMORY_EMBEDDING_INPUT_LIMIT")
        total_bytes += size
        if total_bytes > _MAX_BATCH_BYTES:
            raise _embedding_failure("MEMORY_EMBEDDING_INPUT_LIMIT")
        result.append(text)
    return tuple(result)


def _embedding_failure(code: str, *, retryable: bool = False) -> PersistenceError:
    """Create a stable redacted persistence error for embedding callers."""

    return PersistenceError(
        code,
        503 if retryable or code.endswith("UNAVAILABLE") or "FAILED" in code else 422,
        "The configured embedding provider did not return an acceptable vector batch.",
        retryable,
    )


__all__ = ["DirectEmbeddingClient"]
