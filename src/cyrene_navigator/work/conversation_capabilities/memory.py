"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 memory.py                                                            │
│  Module: cyrene_navigator.work.conversation_capabilities.memory           │
│  Role: Strict memory.provider.v1 adapter and bounded maintenance methods. │
│                                                                          │
│  模块职责：将 Navigator actor scope 和真实向量接入七个记忆 RPC。         │
│  · 只返回候选 ID；正文与来源授权由 Navigator canonical store 再验证。     │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from collections.abc import Sequence

from cyrene_memory_provider_contracts import memory as contract
from cyrene_plugin_runtime import DirectPluginClient

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.work.conversation_memory.providers import (
    MemoryProviderHit,
    MemoryProviderScope,
)

from .config import EmbeddingProfile, PluginBindingSettings
from .runtime import DirectCapabilityError, invoke_typed

_MAX_MEMORY_ID_BYTES = 256
_MAX_MEMORY_TEXT_BYTES = 1_048_576
_MAX_RECALL_LIMIT = 1_000
_MAX_EXPORT_LIMIT = 1_000
_MAX_IMPORT_ITEMS = 1_000
_MODEL_ID_KEY = "cyrene.embedding.model_id"
_DIMENSIONS_KEY = "cyrene.embedding.dimensions"
_PROVIDER_MODEL_KEY = "cyrene.embedding.provider_model_id"
_AUTHORIZATION_EPOCH_KEY = "cyrene.navigator.authorization_epoch"
_WORKSPACE_KEY = "cyrene.navigator.workspace_id"
_ACTOR_KEY = "cyrene.navigator.actor_id"
_CONVERSATION_KEY = "cyrene.navigator.conversation_id"
_KIND_KEY = "cyrene.navigator.conversation_kind"
_PERSONA_KEY = "cyrene.navigator.persona_id"
_VISIBILITY_KEY = "cyrene.navigator.visibility"


class DirectMemoryProvider:
    """Use memory.provider.v1 for persistence, recall, and scoped maintenance."""

    def __init__(
        self,
        client: DirectPluginClient,
        binding: PluginBindingSettings,
        profile: EmbeddingProfile,
        *,
        maintenance_tenants: frozenset[str] = frozenset(),
    ) -> None:
        self._client = client
        self._binding = binding
        self._profile = profile
        self._maintenance_tenants = maintenance_tenants

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
        """Store a real precomputed vector and independently verify the stored record."""

        identifier = _required_text(memory_id, "memory id", _MAX_MEMORY_ID_BYTES)
        body = _required_text(text, "memory text", _MAX_MEMORY_TEXT_BYTES)
        vector = self._validate_vector(embedding, model, dimensions)
        tenant_id, scope_key = _scope_key(scope)
        if (
            isinstance(authorization_epoch, bool)
            or not isinstance(authorization_epoch, int)
            or authorization_epoch < 0
        ):
            raise _memory_failure("MEMORY_AUTHORIZATION_EPOCH_INVALID", 422)
        metadata = _metadata_for(scope, self._profile, authorization_epoch)
        item = contract.MemoryItem(
            item_id=identifier,
            tenant_id=tenant_id,
            scope=scope_key,
            subject=scope.actor_id,
            content=body,
            embedding=vector,
            metadata=metadata,
        )
        response = self._call(contract.METHOD_STORE, contract.StoreMemoryRequest(tenant_id, item))
        if not isinstance(response, contract.StoreMemoryResponse):
            raise _memory_failure("MEMORY_PROVIDER_RESPONSE_INVALID", 502)
        if response.error is not None:
            _raise_contract_error(response.error)
        if response.item_id != identifier:
            raise _memory_failure("MEMORY_PROVIDER_READBACK_MISMATCH", 502)
        stored = self._get_item(tenant_id, identifier)
        if stored is None or not _same_record(stored, item):
            raise _memory_failure("MEMORY_PROVIDER_READBACK_MISMATCH", 502)

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
        """Return bounded candidate IDs only; canonical Work storage owns text and ACLs."""

        _required_text(text, "query text", _MAX_MEMORY_TEXT_BYTES)
        vector = self._validate_vector(embedding, model, dimensions)
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= _MAX_RECALL_LIMIT
        ):
            raise _memory_failure("MEMORY_QUERY_LIMIT_INVALID", 422)
        tenant_id, scope_value = _scope_key(scope)
        filters = _metadata_filters(scope, self._profile)
        response = self._call(
            contract.METHOD_RECALL,
            contract.RecallMemoryRequest(
                tenant_id=tenant_id,
                scope=scope_value,
                subject=scope.actor_id,
                query_embedding=vector,
                metadata_filters=filters,
                min_similarity=0.0,
                top_k=limit,
            ),
        )
        if not isinstance(response, contract.RecallMemoryResponse):
            raise _memory_failure("MEMORY_PROVIDER_RESPONSE_INVALID", 502)
        if response.error is not None:
            _raise_contract_error(response.error)
        if response.matches is None or len(response.matches) > limit:
            raise _memory_failure("MEMORY_PROVIDER_RESPONSE_INVALID", 502)
        hits: list[MemoryProviderHit] = []
        for match in response.matches:
            item = match.item
            _verify_item_scope(item, scope, tenant_id, scope_value, self._profile)
            if (
                not math.isfinite(match.score)
                or not 0.0 <= match.score <= 1.0
                or not item.item_id
                or item.metadata.get(_AUTHORIZATION_EPOCH_KEY) is None
            ):
                raise _memory_failure("MEMORY_PROVIDER_RESPONSE_INVALID", 502)
            epoch = item.metadata[_AUTHORIZATION_EPOCH_KEY]
            if not epoch.isdecimal():
                raise _memory_failure("MEMORY_PROVIDER_RESPONSE_INVALID", 502)
            hits.append(
                MemoryProviderHit(
                    memory_id=item.item_id,
                    score=float(match.score),
                    model=self._profile.model_id,
                    dimensions=self._profile.dimensions,
                )
            )
        return tuple(hits)

    def delete(self, *, memory_ids: Sequence[str], scope: MemoryProviderScope) -> None:
        """Delete only records that read back under the same organization, actor, and workspace."""

        tenant_id, _ = _scope_key(scope)
        seen: set[str] = set()
        for raw_id in memory_ids:
            identifier = _required_text(raw_id, "memory id", _MAX_MEMORY_ID_BYTES)
            if identifier in seen:
                continue
            seen.add(identifier)
            item = self._get_item(tenant_id, identifier)
            if item is None:
                continue
            _verify_actor_workspace(item, scope, tenant_id)
            response = self._call(
                contract.METHOD_DELETE,
                contract.DeleteMemoryRequest(tenant_id=tenant_id, item_id=identifier),
            )
            if not isinstance(response, contract.DeleteMemoryResponse):
                raise _memory_failure("MEMORY_PROVIDER_RESPONSE_INVALID", 502)
            if response.error is not None:
                _raise_contract_error(response.error)
            if response.deleted is None:
                raise _memory_failure("MEMORY_PROVIDER_RESPONSE_INVALID", 502)

    def get_memory(
        self, *, memory_id: str, scope: MemoryProviderScope
    ) -> contract.MemoryItem | None:
        """Read one actor-scoped item for reconciliation and verify its profile metadata."""

        tenant_id, scope_value = _scope_key(scope)
        item = self._get_item(
            tenant_id, _required_text(memory_id, "memory id", _MAX_MEMORY_ID_BYTES)
        )
        if item is None:
            return None
        _verify_item_scope(item, scope, tenant_id, scope_value, self._profile)
        return item

    def prune_tenant(self, *, tenant_id: str, before_timestamp_ms: int) -> int:
        """Run tenant-wide pruning only for explicitly server-allowlisted tenants."""

        tenant = _required_text(tenant_id, "tenant id", 256)
        if tenant not in self._maintenance_tenants:
            raise _memory_failure("MEMORY_MAINTENANCE_FORBIDDEN", 403)
        if (
            isinstance(before_timestamp_ms, bool)
            or not isinstance(before_timestamp_ms, int)
            or before_timestamp_ms < 0
            or before_timestamp_ms > time.time_ns() // 1_000_000
        ):
            raise _memory_failure("MEMORY_PRUNE_CUTOFF_INVALID", 422)
        response = self._call(
            contract.METHOD_PRUNE,
            contract.PruneMemoryRequest(tenant_id=tenant, before_timestamp_ms=before_timestamp_ms),
        )
        if not isinstance(response, contract.PruneMemoryResponse):
            raise _memory_failure("MEMORY_PROVIDER_RESPONSE_INVALID", 502)
        if response.error is not None:
            _raise_contract_error(response.error)
        if response.pruned_count is None or response.pruned_count < 0:
            raise _memory_failure("MEMORY_PROVIDER_RESPONSE_INVALID", 502)
        return response.pruned_count

    def export_batch(
        self,
        *,
        scope: MemoryProviderScope,
        limit: int,
        page_token: str | None = None,
    ) -> contract.ExportMemoryResponse:
        """Export one bounded exact actor/workspace page for an authorized host workflow."""

        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= _MAX_EXPORT_LIMIT
        ):
            raise _memory_failure("MEMORY_EXPORT_LIMIT_INVALID", 422)
        tenant_id, scope_value = _scope_key(scope)
        response = self._call(
            contract.METHOD_EXPORT_BATCH,
            contract.ExportMemoryRequest(
                tenant_id=tenant_id,
                scope=scope_value,
                limit=limit,
                page_token=page_token,
            ),
        )
        if not isinstance(response, contract.ExportMemoryResponse):
            raise _memory_failure("MEMORY_PROVIDER_RESPONSE_INVALID", 502)
        if response.error is not None:
            _raise_contract_error(response.error)
        if response.items is None or len(response.items) > limit:
            raise _memory_failure("MEMORY_PROVIDER_RESPONSE_INVALID", 502)
        for item in response.items:
            _verify_item_scope(item, scope, tenant_id, scope_value, self._profile)
        return response

    def import_batch(
        self,
        *,
        scope: MemoryProviderScope,
        items: Sequence[contract.MemoryItem],
        overwrite: bool = False,
    ) -> int:
        """Import a bounded actor/workspace batch after validating every profile and scope."""

        if isinstance(items, (str, bytes)) or len(items) > _MAX_IMPORT_ITEMS:
            raise _memory_failure("MEMORY_IMPORT_LIMIT_INVALID", 422)
        tenant_id, scope_value = _scope_key(scope)
        normalized: list[contract.MemoryItem] = []
        for item in items:
            if not isinstance(item, contract.MemoryItem):
                raise _memory_failure("MEMORY_IMPORT_RECORD_INVALID", 422)
            _verify_item_scope(item, scope, tenant_id, scope_value, self._profile)
            self._validate_vector(item.embedding, self._profile.model_id, self._profile.dimensions)
            normalized.append(item)
        response = self._call(
            contract.METHOD_IMPORT_BATCH,
            contract.ImportMemoryRequest(
                tenant_id=tenant_id,
                items=tuple(normalized),
                overwrite=overwrite,
            ),
        )
        if not isinstance(response, contract.ImportMemoryResponse):
            raise _memory_failure("MEMORY_PROVIDER_RESPONSE_INVALID", 502)
        if response.error is not None:
            _raise_contract_error(response.error)
        if response.imported_count != len(normalized):
            raise _memory_failure("MEMORY_PROVIDER_READBACK_MISMATCH", 502)
        return int(response.imported_count)

    def _get_item(self, tenant_id: str, memory_id: str) -> contract.MemoryItem | None:
        response = self._call(
            contract.METHOD_GET,
            contract.GetMemoryRequest(tenant_id=tenant_id, item_id=memory_id),
        )
        if not isinstance(response, contract.GetMemoryResponse):
            raise _memory_failure("MEMORY_PROVIDER_RESPONSE_INVALID", 502)
        if response.error is not None:
            if int(response.error.code) == int(contract.MemoryErrorCode.NOT_FOUND):
                return None
            _raise_contract_error(response.error)
        return response.item

    def _call(self, method: str, request: object) -> object:
        """Encode a canonical v1 request and decode its exact method response."""

        try:
            request_bytes = contract.encode_request(method, request)
            result = invoke_typed(
                self._client,
                capability=contract.CAPABILITY_ID,
                interface_version=contract.INTERFACE_VERSION,
                method=method,
                request_type_url=contract.REQUEST_TYPE_URLS[method],
                request_bytes=request_bytes,
                response_type_url=contract.RESPONSE_TYPE_URLS[method],
                deadline_seconds=self._binding.deadline_seconds,
            )
            return contract.decode_response(method, result.value)
        except DirectCapabilityError as error:
            raise PersistenceError(
                error.code,
                503 if error.unavailable else 502,
                "The configured memory provider is unavailable or failed.",
                error.retryable,
            ) from error
        except (contract.MemoryCodecError, KeyError, TypeError, ValueError) as error:
            raise _memory_failure("MEMORY_PROVIDER_PROTOCOL_INVALID", 502) from error

    def _validate_vector(
        self, embedding: Sequence[float], model: str, dimensions: int
    ) -> tuple[float, ...]:
        """Bind each supplied vector to the configured model and fixed dimension."""

        if model != self._profile.model_id or dimensions != self._profile.dimensions:
            raise _memory_failure("MEMORY_EMBEDDING_PROFILE_MISMATCH", 409)
        try:
            values = tuple(float(value) for value in embedding)
        except (TypeError, ValueError, OverflowError) as error:
            raise _memory_failure("MEMORY_EMBEDDING_INVALID", 422) from error
        if (
            len(values) != self._profile.dimensions
            or not all(math.isfinite(value) for value in values)
            or not any(value != 0 for value in values)
        ):
            raise _memory_failure("MEMORY_EMBEDDING_INVALID", 422)
        return values


def _scope_key(scope: MemoryProviderScope) -> tuple[str, str]:
    """Derive the provider tenant and exact actor/workspace/profile partition."""

    if not isinstance(scope, MemoryProviderScope):
        raise _memory_failure("MEMORY_SCOPE_INVALID", 403)
    tenant_id = _required_text(scope.organization_id, "organization id", 256)
    actor_id = _required_text(scope.actor_id, "actor id", 256)
    workspace_id = _required_text(scope.workspace_id, "workspace id", 256)
    scope_document = _canonical_json(
        {
            "schemaVersion": 1,
            "actorId": actor_id,
            "workspaceId": workspace_id,
            "conversationKind": scope.conversation_kind or "_none",
            "personaId": scope.persona_id or "_none",
        }
    )
    scope_value = (
        "navigator-memory-v1:" + hashlib.sha256(scope_document.encode("utf-8")).hexdigest()
    )
    return tenant_id, scope_value


def _metadata_for(
    scope: MemoryProviderScope,
    profile: EmbeddingProfile,
    authorization_epoch: int,
) -> dict[str, str]:
    """Store only profile and indexing facts; source lineage stays in Navigator."""

    metadata = {
        _MODEL_ID_KEY: profile.profile_id,
        _DIMENSIONS_KEY: str(profile.dimensions),
        _PROVIDER_MODEL_KEY: profile.model_id,
        _AUTHORIZATION_EPOCH_KEY: str(authorization_epoch),
        _WORKSPACE_KEY: scope.workspace_id,
        _ACTOR_KEY: scope.actor_id,
    }
    optional = {
        _CONVERSATION_KEY: scope.conversation_id,
        _KIND_KEY: scope.conversation_kind,
        _PERSONA_KEY: scope.persona_id,
        _VISIBILITY_KEY: scope.visibility,
    }
    metadata.update({key: value for key, value in optional.items() if value is not None})
    return metadata


def _metadata_filters(scope: MemoryProviderScope, profile: EmbeddingProfile) -> dict[str, str]:
    """Apply server-derived query filters while leaving source authorization to Work."""

    filters = {
        _MODEL_ID_KEY: profile.profile_id,
        _DIMENSIONS_KEY: str(profile.dimensions),
        _PROVIDER_MODEL_KEY: profile.model_id,
        _WORKSPACE_KEY: scope.workspace_id,
        _ACTOR_KEY: scope.actor_id,
    }
    optional = {
        _CONVERSATION_KEY: scope.conversation_id,
        _KIND_KEY: scope.conversation_kind,
        _PERSONA_KEY: scope.persona_id,
        _VISIBILITY_KEY: scope.visibility,
    }
    filters.update({key: value for key, value in optional.items() if value is not None})
    return filters


def _verify_item_scope(
    item: contract.MemoryItem,
    scope: MemoryProviderScope,
    tenant_id: str,
    scope_value: str,
    profile: EmbeddingProfile,
) -> None:
    """Reject a provider result outside the exact tenant, actor, workspace, or profile."""

    _verify_actor_workspace(item, scope, tenant_id)
    if (
        item.scope != scope_value
        or item.metadata.get(_MODEL_ID_KEY) != profile.profile_id
        or item.metadata.get(_DIMENSIONS_KEY) != str(profile.dimensions)
        or item.metadata.get(_PROVIDER_MODEL_KEY) != profile.model_id
        or len(item.embedding) != profile.dimensions
        or not all(math.isfinite(value) for value in item.embedding)
        or not any(value != 0 for value in item.embedding)
    ):
        raise _memory_failure("MEMORY_PROVIDER_SCOPE_MISMATCH", 502)


def _verify_actor_workspace(
    item: contract.MemoryItem, scope: MemoryProviderScope, tenant_id: str
) -> None:
    """Check actor and workspace facts before a record can be returned or deleted."""

    if (
        item.tenant_id != tenant_id
        or item.subject != scope.actor_id
        or item.metadata.get(_ACTOR_KEY) != scope.actor_id
        or item.metadata.get(_WORKSPACE_KEY) != scope.workspace_id
    ):
        raise _memory_failure("MEMORY_PROVIDER_SCOPE_MISMATCH", 502)


def _same_record(left: contract.MemoryItem, right: contract.MemoryItem) -> bool:
    """Compare a real get readback with the exact stored record projection."""

    return (
        left.item_id == right.item_id
        and left.tenant_id == right.tenant_id
        and left.scope == right.scope
        and left.subject == right.subject
        and left.content == right.content
        and tuple(left.embedding) == tuple(right.embedding)
        and dict(left.metadata) == dict(right.metadata)
    )


def _raise_contract_error(error: contract.MemoryError) -> None:
    """Convert contract errors to stable redacted Navigator persistence errors."""

    code = int(error.code)
    if code == int(contract.MemoryErrorCode.NOT_FOUND):
        raise _memory_failure("MEMORY_NOT_FOUND", 404)
    retryable = error.retryable or code in {
        int(contract.MemoryErrorCode.STORAGE_FAILED),
        int(contract.MemoryErrorCode.QUOTA_EXCEEDED),
    }
    raise _memory_failure("MEMORY_PROVIDER_FAILED", 503 if retryable else 502, retryable)


def _memory_failure(code: str, status: int, retryable: bool = False) -> PersistenceError:
    """Create a safe stable error without exposing provider message or record text."""

    return PersistenceError(
        code, status, "The configured memory provider request failed.", retryable
    )


def _required_text(value: object, field_name: str, maximum_bytes: int) -> str:
    """Validate one bounded identifier or memory text at the adapter boundary."""

    if not isinstance(value, str) or not value.strip():
        raise _memory_failure("MEMORY_PROVIDER_INPUT_INVALID", 422)
    if len(value.encode("utf-8")) > maximum_bytes:
        raise _memory_failure("MEMORY_PROVIDER_INPUT_LIMIT", 413)
    return value


def _canonical_json(value: object) -> str:
    """Serialize deterministic provider partition keys without carrying hidden state."""

    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


__all__ = ["DirectMemoryProvider"]
