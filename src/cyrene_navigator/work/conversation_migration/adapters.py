"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 adapters.py                                                          │
│  Module: cyrene_navigator.work.conversation_migration.adapters            │
│  Role: Bind migration ports to canonical Navigator and Work stores.       │
│                                                                          │
│  模块职责：将迁移端口连接到规范记忆/画像/图谱存储与现有 Work 账本。        │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Mapping, Sequence
from typing import Any, Protocol, cast

from cyrene_knowledge_graph_contracts import (
    CAPABILITY_ID as GRAPH_CAPABILITY_ID,
)
from cyrene_knowledge_graph_contracts import (
    INTERFACE_VERSION as GRAPH_INTERFACE_VERSION,
)
from cyrene_knowledge_graph_contracts import (
    REQUEST_TYPE_URLS as GRAPH_REQUEST_TYPE_URLS,
)
from cyrene_knowledge_graph_contracts import (
    RESPONSE_TYPE_URLS as GRAPH_RESPONSE_TYPE_URLS,
)
from cyrene_knowledge_graph_contracts import (
    KnowledgeGraphCodecError,
)
from cyrene_knowledge_graph_contracts import (
    decode_response as decode_graph_response,
)
from cyrene_knowledge_graph_contracts import (
    encode_request as encode_graph_request,
)
from cyrene_knowledge_graph_contracts import knowledge_graph_pb2 as graph_wire
from cyrene_plugin_runtime import DirectPluginClient

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.work.conversation_capabilities.config import PluginBindingSettings
from cyrene_navigator.work.conversation_capabilities.runtime import (
    DirectCapabilityError,
    invoke_typed,
)
from cyrene_navigator.work.conversation_memory.domains import ConversationDomainStore
from cyrene_navigator.work.conversation_memory.providers import KnowledgeGraphProvider
from cyrene_navigator.work.conversation_memory.store import ConversationMemoryStore
from cyrene_navigator.work.store import WorkStore

from .models import (
    ActorScope,
    AuthorizedConversationContext,
    MigrationError,
    MigrationSettings,
)
from .ports import (
    CurrentAuthorizationPort,
    GraphProjectionPort,
    MemoryProjectionPort,
    OperationHandle,
    ProfileProjectionPort,
    RollbackCapabilityPort,
    WorkOperationPort,
    WorkTaskProgressPort,
)
from .records import canonical_json
from .service import ConversationMigrationService

_graph_wire: Any = graph_wire
_MAX_MESSAGE_READBACK_SCAN = 100_000


class GraphCompensationProvider(Protocol):
    """Exact graph deletion and independent absence-readback operations."""

    def verify_projection(
        self, scope: ActorScope, changeset: Mapping[str, object]
    ) -> Mapping[str, object]:
        """Read every exact node and edge without writing and return a recomputed digest."""
        ...

    def delete_changeset(
        self,
        scope: ActorScope,
        changeset: Mapping[str, object],
        *,
        operation_id: str,
    ) -> Mapping[str, object]:
        """Delete exact nodes and edges, then independently confirm every item is absent."""
        ...

    def verify_absent(
        self,
        scope: ActorScope,
        changeset: Mapping[str, object],
        *,
        operation_id: str,
    ) -> Mapping[str, object]:
        """Freshly read every exact node and edge and fail if any item remains."""
        ...


class CanonicalMemoryAdapter(MemoryProjectionPort):
    """Actor-scoped adapter over the canonical conversation memory store."""

    def __init__(self, store: ConversationMemoryStore) -> None:
        self._store = store

    def create_message(self, scope: ActorScope, body: Mapping[str, object]) -> Mapping[str, object]:
        value = self._store.create_message(
            scope.organization_id, scope.workspace_id, scope.actor_id, body
        )
        return _unwrap(value, "message")

    def get_message(
        self,
        scope: ActorScope,
        message_id: str,
        *,
        context: AuthorizedConversationContext,
        include_revoked: bool = False,
    ) -> Mapping[str, object] | None:
        """Read by exact actor and target conversation, optionally observing its tombstone."""

        if include_revoked:
            return self._get_message_including_revoked(scope, message_id, context=context)
        try:
            reader: Any = cast(Any, self._store.get_message)
            value = reader(
                scope.organization_id,
                scope.workspace_id,
                scope.actor_id,
                context.conversation_id,
                message_id,
                conversation_kind=context.conversation_kind,
                persona_id=context.persona_id,
            )
        except PersistenceError as error:
            if error.status == 404:
                return None
            raise
        return _unwrap(value, "message")

    def _get_message_including_revoked(
        self,
        scope: ActorScope,
        message_id: str,
        *,
        context: AuthorizedConversationContext,
    ) -> Mapping[str, object] | None:
        """Find one tombstone through bounded pages in the exact actor conversation scope."""

        cursor: str | None = None
        scanned = 0
        while scanned < _MAX_MESSAGE_READBACK_SCAN:
            limit = min(100, _MAX_MESSAGE_READBACK_SCAN - scanned)
            page = self._store.list_messages(
                scope.organization_id,
                scope.workspace_id,
                scope.actor_id,
                context.conversation_id,
                conversation_kind=context.conversation_kind,
                persona_id=context.persona_id,
                order="asc",
                limit=limit,
                cursor=cursor,
                include_revoked=True,
            )
            items = page.get("items")
            if not isinstance(items, list) or len(items) > limit:
                raise MigrationError(
                    "CANONICAL_READBACK_INVALID", "Message tombstone page is invalid."
                )
            scanned += len(items)
            for item in items:
                if not isinstance(item, Mapping):
                    raise MigrationError(
                        "CANONICAL_READBACK_INVALID", "Message tombstone item is invalid."
                    )
                if item.get("id") == message_id:
                    return item
            next_cursor = page.get("nextCursor")
            if next_cursor is None:
                return None
            if not isinstance(next_cursor, str) or not next_cursor or next_cursor == cursor:
                raise MigrationError(
                    "CANONICAL_READBACK_CURSOR_INVALID", "Message tombstone cursor stalled."
                )
            cursor = next_cursor
        raise PersistenceError(
            "CONVERSATION_MEMORY_READBACK_LIMIT",
            413,
            "Message tombstone lookup exceeded its bounded page scan.",
        )

    def create_memory(self, scope: ActorScope, body: Mapping[str, object]) -> Mapping[str, object]:
        value = self._store.create_memory(
            scope.organization_id, scope.workspace_id, scope.actor_id, body
        )
        return _unwrap(value, "memory")

    def get_memory(
        self, scope: ActorScope, memory_id: str, *, include_deleted: bool = False
    ) -> Mapping[str, object] | None:
        value = self._store.get_memory(
            scope.organization_id,
            scope.workspace_id,
            scope.actor_id,
            memory_id,
            include_deleted=include_deleted,
        )
        return value

    def delete_memory(
        self, scope: ActorScope, memory_id: str, expected_version: int
    ) -> Mapping[str, object]:
        return self._store.delete_memory(
            scope.organization_id,
            scope.workspace_id,
            scope.actor_id,
            memory_id,
            expected_version,
        )

    def revoke_message(self, scope: ActorScope, message_id: str) -> Mapping[str, object]:
        return self._store.revoke_source(
            scope.organization_id, scope.workspace_id, scope.actor_id, message_id
        )


class CanonicalProfileAdapter(ProfileProjectionPort):
    """Actor-scoped adapter over canonical profile candidate and active-profile APIs."""

    def __init__(self, store: ConversationDomainStore) -> None:
        self._store = store

    def create_candidate(
        self, scope: ActorScope, body: Mapping[str, object]
    ) -> Mapping[str, object]:
        return self._store.create_profile_candidate(
            _organization(scope), scope.workspace_id, scope.actor_id, body
        )

    def get_candidate(self, scope: ActorScope, candidate_id: str) -> Mapping[str, object] | None:
        try:
            return self._store.get_profile_candidate(
                _organization(scope), scope.workspace_id, scope.actor_id, candidate_id
            )
        except PersistenceError as error:
            if error.status == 404:
                return None
            raise

    def activate_candidate(
        self, scope: ActorScope, candidate_id: str, expected_version: int
    ) -> Mapping[str, object]:
        return self._store.activate_profile_candidate(
            _organization(scope),
            scope.workspace_id,
            scope.actor_id,
            candidate_id,
            expected_version,
        )

    def get_profile(self, scope: ActorScope, profile_id: str) -> Mapping[str, object] | None:
        try:
            return self._store.get_profile(
                _organization(scope), scope.workspace_id, scope.actor_id, profile_id
            )
        except PersistenceError as error:
            if error.status == 404:
                return None
            raise

    def rollback_profile(
        self, scope: ActorScope, profile_id: str, expected_version: int
    ) -> Mapping[str, object]:
        return self._store.rollback_profile(
            _organization(scope),
            scope.workspace_id,
            scope.actor_id,
            profile_id,
            expected_version,
        )

    def rollback_candidate(
        self, scope: ActorScope, candidate_id: str, expected_version: int
    ) -> Mapping[str, object]:
        rollback = getattr(self._store, "rollback_profile_candidate", None)
        if not callable(rollback):
            raise MigrationError(
                "PROFILE_CANDIDATE_ROLLBACK_UNAVAILABLE",
                "Canonical candidate rollback is unavailable.",
            )
        rollback(
            _organization(scope),
            scope.workspace_id,
            scope.actor_id,
            candidate_id,
            expected_version,
        )
        return _required_mapping(self.get_candidate(scope, candidate_id), "candidate rollback")


class CanonicalGraphAdapter(GraphProjectionPort):
    """Compose domain proposals with the configured provider and compensation port."""

    def __init__(
        self,
        store: ConversationDomainStore,
        provider: KnowledgeGraphProvider | None,
        compensator: GraphCompensationProvider | None,
    ) -> None:
        self._store = store
        self._provider = provider
        self._compensator = compensator

    def project_changeset(
        self, scope: ActorScope, body: Mapping[str, object], *, operation_id: str
    ) -> Mapping[str, object]:
        if self._provider is None:
            raise PersistenceError(
                "GRAPH_PROVIDER_UNAVAILABLE", 503, "Graph provider is unavailable.", True
            )
        proposal = self._store.upsert_graph_entities(
            _organization(scope), scope.workspace_id, scope.actor_id, body
        )
        changeset_id = _required_text(proposal.get("id"), "graph changeset id")
        current = self._store.get_graph_changeset(
            _organization(scope), scope.workspace_id, scope.actor_id, changeset_id
        )
        if current.get("idempotencyKey") != body.get("idempotencyKey"):
            raise PersistenceError(
                "GRAPH_CHANGESSET_IDEMPOTENCY_MISMATCH",
                409,
                "Stored graph proposal does not match this migration operation.",
            )
        if current.get("state") == "projected":
            actual = self._verify_current_projection(scope, current)
            receipt = current.get("providerReceipt")
            if not isinstance(receipt, Mapping) or any(
                receipt.get(key) != actual.get(key)
                for key in ("readbackDigest", "nodeCount", "edgeCount")
            ):
                raise PersistenceError(
                    "GRAPH_PROVIDER_READBACK_MISMATCH",
                    502,
                    "Current graph readback differs from its stored proposal receipt.",
                )
            return current
        if current.get("state") != "proposed":
            raise PersistenceError(
                "CONVERSATION_DOMAIN_CONFLICT", 409, "Graph proposal is not projectable."
            )
        provider_result = self._verify_provider_projection(scope, current)
        provider_receipt = {
            "requestDigest": current.get("digest"),
            "readbackDigest": provider_result.get("readbackDigest"),
            "nodeCount": provider_result.get("nodeCount"),
            "edgeCount": provider_result.get("edgeCount"),
            "appliedAt": time.time_ns() // 1_000_000,
        }
        return self._store.apply_graph_changeset(
            _organization(scope),
            scope.workspace_id,
            scope.actor_id,
            changeset_id,
            _positive_version(current.get("version")),
            provider_receipt,
        )

    def get_changeset(self, scope: ActorScope, changeset_id: str) -> Mapping[str, object] | None:
        try:
            current = self._store.get_graph_changeset(
                _organization(scope), scope.workspace_id, scope.actor_id, changeset_id
            )
        except PersistenceError as error:
            if error.status == 404:
                return None
            raise
        state = current.get("state")
        if state == "projected":
            actual = self._verify_current_projection(scope, current)
            receipt = current.get("providerReceipt")
            if not isinstance(receipt, Mapping) or any(
                receipt.get(key) != actual.get(key)
                for key in ("readbackDigest", "nodeCount", "edgeCount")
            ):
                raise PersistenceError(
                    "GRAPH_PROVIDER_READBACK_MISMATCH",
                    502,
                    "Current graph state differs from its stored proposal receipt.",
                )
        elif state == "rolled_back":
            if self._compensator is None:
                raise PersistenceError(
                    "GRAPH_COMPENSATION_UNAVAILABLE",
                    503,
                    "Graph compensation readback is unavailable.",
                    True,
                )
            receipt = current.get("rollbackReceipt")
            operation_id = receipt.get("operationId") if isinstance(receipt, Mapping) else None
            if not isinstance(operation_id, str):
                raise PersistenceError(
                    "GRAPH_ROLLBACK_RECEIPT_INVALID", 500, "Graph rollback receipt is missing."
                )
            actual_receipt = self._compensator.verify_absent(
                scope, current, operation_id=operation_id
            )
            _verify_graph_rollback_receipt(receipt, actual_receipt)
        return current

    def rollback_changeset(
        self, scope: ActorScope, changeset_id: str, expected_version: int
    ) -> Mapping[str, object]:
        current = _required_mapping(
            self.get_changeset(scope, changeset_id), "graph changeset rollback"
        )
        state = current.get("state")
        if state == "rolled_back":
            return current
        if state == "proposed":
            rollback = getattr(self._store, "rollback_graph_changeset", None)
            if not callable(rollback):
                raise MigrationError(
                    "GRAPH_COMPENSATION_UNAVAILABLE", "Canonical graph rollback is unavailable."
                )
            return _required_mapping(
                rollback(
                    _organization(scope),
                    scope.workspace_id,
                    scope.actor_id,
                    changeset_id,
                    expected_version,
                    None,
                ),
                "proposed graph rollback result",
            )
        if state != "projected" or self._compensator is None:
            raise MigrationError(
                "GRAPH_COMPENSATION_UNAVAILABLE", "Provider graph compensation is unavailable."
            )
        if _positive_version(current.get("version")) != expected_version:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_CONFLICT", 409, "Graph changeset version changed."
            )
        operation_id = _graph_rollback_operation_id(scope, current, expected_version)
        provider_receipt = self._compensator.delete_changeset(
            scope, current, operation_id=operation_id
        )
        rollback = getattr(self._store, "rollback_graph_changeset", None)
        if not callable(rollback):
            raise MigrationError(
                "GRAPH_COMPENSATION_UNAVAILABLE", "Canonical graph rollback is unavailable."
            )
        result_view = _required_mapping(
            rollback(
                _organization(scope),
                scope.workspace_id,
                scope.actor_id,
                changeset_id,
                expected_version,
                provider_receipt,
            ),
            "graph rollback result",
        )
        actual_receipt = self._compensator.verify_absent(
            scope, result_view, operation_id=operation_id
        )
        _verify_graph_rollback_receipt(result_view.get("rollbackReceipt"), actual_receipt)
        return result_view

    def _verify_provider_projection(
        self, scope: ActorScope, changeset: Mapping[str, object]
    ) -> Mapping[str, object]:
        """Run the provider's deterministic idempotent upsert plus fresh per-item readback."""

        assert self._provider is not None
        result = self._provider.apply_changeset(
            organization_id=_organization(scope),
            workspace_id=scope.workspace_id,
            actor_id=scope.actor_id,
            changeset=changeset,
        )
        nodes = changeset.get("nodes")
        edges = changeset.get("edges")
        digest = changeset.get("digest")
        if (
            set(result) != {"readbackDigest", "nodeCount", "edgeCount"}
            or not isinstance(nodes, list)
            or not isinstance(edges, list)
            or result.get("readbackDigest") != digest
            or result.get("nodeCount") != len(nodes)
            or result.get("edgeCount") != len(edges)
        ):
            raise PersistenceError(
                "GRAPH_PROVIDER_READBACK_MISMATCH",
                502,
                "Graph provider did not independently read back this exact changeset.",
            )
        return result

    def _verify_current_projection(
        self, scope: ActorScope, changeset: Mapping[str, object]
    ) -> Mapping[str, object]:
        """Perform a read-only exact provider reconciliation for a stored projection."""

        if self._compensator is None:
            raise PersistenceError(
                "GRAPH_PROVIDER_READBACK_UNAVAILABLE",
                503,
                "Read-only exact graph verification is unavailable.",
                True,
            )
        result = self._compensator.verify_projection(scope, changeset)
        nodes = changeset.get("nodes")
        edges = changeset.get("edges")
        if (
            not isinstance(nodes, list)
            or not isinstance(edges, list)
            or set(result) != {"readbackDigest", "nodeCount", "edgeCount"}
            or result.get("readbackDigest") != changeset.get("digest")
            or result.get("nodeCount") != len(nodes)
            or result.get("edgeCount") != len(edges)
        ):
            raise PersistenceError(
                "GRAPH_PROVIDER_READBACK_MISMATCH",
                502,
                "Graph provider current state differs from the stored changeset.",
            )
        return result


class DirectGraphCompensator(GraphCompensationProvider):
    """Delete graph records using the canonical typed plugin RPC and verify absence."""

    def __init__(self, client: DirectPluginClient, binding: PluginBindingSettings) -> None:
        self._client = client
        self._binding = binding

    def delete_changeset(
        self,
        scope: ActorScope,
        changeset: Mapping[str, object],
        *,
        operation_id: str,
    ) -> Mapping[str, object]:
        """Delete edges before nodes and confirm every exact ID is absent afterward."""

        tenant, namespace, node_ids, edge_ids = _graph_deletion_scope(scope, changeset)
        for edge_id in edge_ids:
            response = self._call(
                "delete_edge",
                _graph_wire.DeleteEdgeRequest(
                    tenant_id=tenant, namespace=namespace, edge_id=edge_id
                ),
                allow_not_found=True,
            )
            if response is None:
                continue
            if (
                not isinstance(response, _graph_wire.DeleteEdgeResponse)
                or type(response.deleted) is not bool
            ):
                raise PersistenceError(
                    "GRAPH_PROVIDER_DELETE_INVALID", 502, "Graph edge delete response is invalid."
                )
        for node_id in node_ids:
            response = self._call(
                "delete_node",
                _graph_wire.DeleteNodeRequest(
                    tenant_id=tenant, namespace=namespace, node_id=node_id
                ),
                allow_not_found=True,
            )
            if response is None:
                continue
            if (
                not isinstance(response, _graph_wire.DeleteNodeResponse)
                or type(response.deleted) is not bool
            ):
                raise PersistenceError(
                    "GRAPH_PROVIDER_DELETE_INVALID", 502, "Graph node delete response is invalid."
                )
        receipt = self.verify_absent(scope, changeset, operation_id=operation_id)
        return receipt

    def verify_projection(
        self, scope: ActorScope, changeset: Mapping[str, object]
    ) -> Mapping[str, object]:
        """Get every node and edge and hash its normalized current content without mutation."""

        tenant, namespace, node_ids, edge_ids = _graph_deletion_scope(scope, changeset)
        conversation_id = _required_text(changeset.get("conversationId"), "conversation id")
        conversation_kind = _required_text(changeset.get("conversationKind"), "conversation kind")
        persona_id_value = changeset.get("personaId")
        persona_id = persona_id_value if isinstance(persona_id_value, str) else None
        nodes: list[dict[str, object]] = []
        edges: list[dict[str, object]] = []
        for node_id in node_ids:
            response = self._call(
                "get_node",
                _graph_wire.GetNodeRequest(tenant_id=tenant, namespace=namespace, node_id=node_id),
                allow_not_found=True,
            )
            if response is None or not response.HasField("node"):
                raise PersistenceError(
                    "GRAPH_PROVIDER_READBACK_MISMATCH", 502, "A projected graph node is missing."
                )
            nodes.append(
                _decode_graph_node(
                    response.node,
                    tenant=tenant,
                    namespace=namespace,
                    actor=scope.actor_id,
                    conversation_id=conversation_id,
                    conversation_kind=conversation_kind,
                    persona_id=persona_id,
                )
            )
        for edge_id in edge_ids:
            response = self._call(
                "get_edge",
                _graph_wire.GetEdgeRequest(tenant_id=tenant, namespace=namespace, edge_id=edge_id),
                allow_not_found=True,
            )
            if response is None or not response.HasField("edge"):
                raise PersistenceError(
                    "GRAPH_PROVIDER_READBACK_MISMATCH", 502, "A projected graph edge is missing."
                )
            edges.append(
                _decode_graph_edge(
                    response.edge,
                    tenant=tenant,
                    namespace=namespace,
                    actor=scope.actor_id,
                    conversation_id=conversation_id,
                    conversation_kind=conversation_kind,
                    persona_id=persona_id,
                )
            )
        readback = {
            "conversationId": conversation_id,
            "conversationKind": conversation_kind,
            "personaId": persona_id,
            "nodes": nodes,
            "edges": edges,
        }
        return {
            "readbackDigest": hashlib.sha256(canonical_json(readback)).hexdigest(),
            "nodeCount": len(nodes),
            "edgeCount": len(edges),
        }

    def verify_absent(
        self,
        scope: ActorScope,
        changeset: Mapping[str, object],
        *,
        operation_id: str,
    ) -> Mapping[str, object]:
        """Freshly query all graph IDs in the exact tenant/workspace/conversation namespace."""

        tenant, namespace, node_ids, edge_ids = _graph_deletion_scope(scope, changeset)
        for node_id in node_ids:
            response = self._call(
                "get_node",
                _graph_wire.GetNodeRequest(tenant_id=tenant, namespace=namespace, node_id=node_id),
                allow_not_found=True,
            )
            if response is not None:
                if not response.HasField("node"):
                    raise PersistenceError(
                        "GRAPH_PROVIDER_READBACK_INVALID",
                        502,
                        "Graph node readback returned neither a node nor NOT_FOUND.",
                    )
                raise PersistenceError(
                    "GRAPH_PROVIDER_DELETE_READBACK_MISMATCH",
                    502,
                    "A graph node remains after compensation.",
                )
        for edge_id in edge_ids:
            response = self._call(
                "get_edge",
                _graph_wire.GetEdgeRequest(tenant_id=tenant, namespace=namespace, edge_id=edge_id),
                allow_not_found=True,
            )
            if response is not None:
                if not response.HasField("edge"):
                    raise PersistenceError(
                        "GRAPH_PROVIDER_READBACK_INVALID",
                        502,
                        "Graph edge readback returned neither an edge nor NOT_FOUND.",
                    )
                raise PersistenceError(
                    "GRAPH_PROVIDER_DELETE_READBACK_MISMATCH",
                    502,
                    "A graph edge remains after compensation.",
                )
        digest = changeset.get("digest")
        if not isinstance(digest, str):
            raise PersistenceError(
                "GRAPH_PROVIDER_INPUT_INVALID", 422, "Graph changeset digest is missing."
            )
        readback_digest = hashlib.sha256(
            canonical_json(
                {
                    "requestDigest": digest,
                    "operationId": operation_id,
                    "deletedNodeIds": node_ids,
                    "deletedEdgeIds": edge_ids,
                    "remainingNodeIds": [],
                    "remainingEdgeIds": [],
                }
            )
        ).hexdigest()
        return {
            "operationId": operation_id,
            "requestDigest": digest,
            "readbackDigest": readback_digest,
            "nodeCount": len(node_ids),
            "edgeCount": len(edge_ids),
            "deletedNodeIds": node_ids,
            "deletedEdgeIds": edge_ids,
        }

    def _call(self, method: str, request: Any, *, allow_not_found: bool = False) -> Any | None:
        """Invoke one generated graph RPC and fail closed on every non-NOT_FOUND error."""

        try:
            invocation = invoke_typed(
                self._client,
                capability=GRAPH_CAPABILITY_ID,
                interface_version=GRAPH_INTERFACE_VERSION,
                method=method,
                request_type_url=GRAPH_REQUEST_TYPE_URLS[method],
                request_bytes=encode_graph_request(method, request),
                response_type_url=GRAPH_RESPONSE_TYPE_URLS[method],
                deadline_seconds=self._binding.deadline_seconds,
            )
            response = decode_graph_response(method, invocation.value)
        except DirectCapabilityError as error:
            raise PersistenceError(
                error.code,
                503 if error.unavailable else 502,
                "The configured graph provider failed during rollback.",
                error.retryable,
            ) from error
        except (KnowledgeGraphCodecError, KeyError, TypeError, ValueError) as error:
            raise PersistenceError(
                "GRAPH_PROVIDER_PROTOCOL_INVALID", 502, "Graph rollback response is invalid."
            ) from error
        result = response.WhichOneof("result")
        if result == "error":
            if (
                allow_not_found
                and response.error.code == _graph_wire.KNOWLEDGE_GRAPH_ERROR_CODE_NOT_FOUND
            ):
                return None
            raise PersistenceError(
                "GRAPH_PROVIDER_FAILED",
                503 if response.error.retryable else 502,
                "Graph provider rejected a rollback read or delete.",
                response.error.retryable,
            )
        return response


class WorkStoreOperationAdapter(WorkOperationPort):
    """Adapt WorkStore's durable Operation API using actor-private task ownership."""

    def __init__(self, store: WorkStore) -> None:
        self._store = store

    def begin(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        idempotency_key: str,
        operation_type: str,
        request: Mapping[str, object],
    ) -> OperationHandle:
        value, duplicate = self._store.create_operation(
            scope.organization_id,
            scope.workspace_id,
            {
                "idempotencyKey": idempotency_key,
                "operationType": operation_type,
                "taskId": task_id,
                "request": dict(request),
            },
            actor_id=scope.actor_id,
            actor_private_scope=True,
        )
        return _operation_handle(value, duplicate)

    def complete(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        operation_id: str,
        evidence: Mapping[str, object],
    ) -> OperationHandle:
        del task_id
        value, duplicate = self._store.update_operation(
            scope.organization_id,
            scope.workspace_id,
            operation_id,
            "verified",
            dict(evidence),
            actor_id=scope.actor_id,
            actor_private_scope=True,
        )
        return _operation_handle(value, duplicate)

    def get(self, scope: ActorScope, *, task_id: str, operation_id: str) -> OperationHandle:
        del task_id
        value = self._store.get_operation(
            scope.organization_id,
            scope.workspace_id,
            operation_id,
            actor_id=scope.actor_id,
            actor_private_scope=True,
        )
        return _operation_handle(value, True)


class WorkStoreTaskProgressAdapter(WorkTaskProgressPort):
    """Store migration cursors in existing actor-private Work Task events."""

    def __init__(self, store: WorkStore) -> None:
        self._store = store

    def append_checkpoint(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        event_id: str,
        event: Mapping[str, object],
    ) -> None:
        self._store.append_task_event(
            scope.organization_id,
            scope.workspace_id,
            task_id,
            {"type": "conversation.migration.checkpoint", **dict(event)},
            event_id,
            actor_id=scope.actor_id,
            actor_private_scope=True,
        )

    def list_checkpoints(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        batch_id: str,
        after_sequence: int,
        limit: int,
    ) -> tuple[Sequence[Mapping[str, object]], int]:
        rows, _task_sequence = self._store.get_task_events(
            scope.organization_id,
            scope.workspace_id,
            task_id,
            after=after_sequence,
            limit=limit,
            actor_id=scope.actor_id,
            actor_private_scope=True,
        )
        events: list[Mapping[str, object]] = []
        next_cursor = after_sequence
        for row in rows:
            sequence = row.get("seq")
            if type(sequence) is int:
                next_cursor = max(next_cursor, sequence)
            event = row.get("event")
            if (
                isinstance(event, Mapping)
                and event.get("type") == "conversation.migration.checkpoint"
                and event.get("batchId") == batch_id
            ):
                events.append(event)
        return tuple(events), next_cursor


class CanonicalRollbackCapabilities(RollbackCapabilityPort):
    """Fail closed unless all requested canonical compensation seams are callable."""

    def __init__(
        self,
        memory_store: ConversationMemoryStore,
        domain_store: ConversationDomainStore,
        graph_provider: KnowledgeGraphProvider | None,
        graph_compensator: GraphCompensationProvider | None,
    ) -> None:
        self._memory = memory_store
        self._domains = domain_store
        self._graph_provider = graph_provider
        self._graph_compensator = graph_compensator

    def missing_capabilities(self, scope: ActorScope, *, required: Sequence[str]) -> Sequence[str]:
        del scope
        checks = {
            "conversation.message.revoke.v1": callable(getattr(self._memory, "revoke_source", None))
            and callable(getattr(self._memory, "list_messages", None))
            and _accepts_keyword(getattr(self._memory, "list_messages", None), "include_revoked"),
            "conversation.memory.tombstone.v1": callable(
                getattr(self._memory, "delete_memory", None)
            )
            and _accepts_keyword(getattr(self._memory, "get_memory", None), "include_deleted"),
            "navigator.profile.candidate-rollback.v1": callable(
                getattr(self._domains, "rollback_profile_candidate", None)
            ),
            "navigator.profile.rollback.v1": callable(
                getattr(self._domains, "rollback_profile", None)
            ),
            "navigator.graph.provider-compensation.v1": callable(
                getattr(self._domains, "rollback_graph_changeset", None)
            )
            and self._graph_provider is not None
            and self._graph_compensator is not None
            and callable(getattr(self._graph_compensator, "delete_changeset", None))
            and callable(getattr(self._graph_compensator, "verify_absent", None)),
        }
        return tuple(capability for capability in required if not checks.get(capability, False))


class ConversationMigrationHost:
    """Mounted host facade over the portable migration service and canonical backups."""

    def __init__(
        self,
        service: ConversationMigrationService,
        memory_store: ConversationMemoryStore,
        domain_store: ConversationDomainStore,
    ) -> None:
        self.service = service
        self._memory_store = memory_store
        self._domain_store = domain_store

    def create_actor_backup(self, scope: ActorScope, *, created_at: int) -> Any:
        """Export one actor's canonical memory and domain rows into the portable subset."""

        return self.service.create_backup(
            scope,
            self._memory_store.export_actor_backup(
                scope.organization_id, scope.workspace_id, scope.actor_id
            ),
            self._domain_store.export_actor_backup(
                _organization(scope), scope.workspace_id, scope.actor_id
            ),
            created_at=created_at,
        )


def build_conversation_migration_host(
    *,
    memory_store: ConversationMemoryStore,
    domain_store: ConversationDomainStore,
    work_store: WorkStore,
    authorization: CurrentAuthorizationPort,
    graph_provider: KnowledgeGraphProvider | None = None,
    graph_compensator: GraphCompensationProvider | None = None,
    settings: MigrationSettings | None = None,
) -> ConversationMigrationHost:
    """Build the mountable migration facade using only canonical public store APIs."""

    memory = CanonicalMemoryAdapter(memory_store)
    profiles = CanonicalProfileAdapter(domain_store)
    graph = CanonicalGraphAdapter(domain_store, graph_provider, graph_compensator)
    rollback_capabilities = CanonicalRollbackCapabilities(
        memory_store, domain_store, graph_provider, graph_compensator
    )
    service = ConversationMigrationService(
        authorization=authorization,
        memory=memory,
        profiles=profiles,
        graph=graph,
        rollback_capabilities=rollback_capabilities,
        operations=WorkStoreOperationAdapter(work_store),
        progress=WorkStoreTaskProgressAdapter(work_store),
        settings=settings,
    )
    return ConversationMigrationHost(service, memory_store, domain_store)


def _operation_handle(value: Mapping[str, object], duplicate: bool) -> OperationHandle:
    """Map a WorkStore view to the minimal migration Operation handle."""

    evidence = value.get("evidence", {})
    return OperationHandle(
        operation_id=_required_text(value.get("id"), "operation id"),
        status=_required_text(value.get("status"), "operation status"),
        evidence=evidence if isinstance(evidence, Mapping) else {},
        duplicate=duplicate,
    )


def _verify_graph_rollback_receipt(stored: object, current: Mapping[str, object]) -> None:
    """Bind the current absence readback to the canonical domain rollback receipt."""

    fields = (
        "operationId",
        "requestDigest",
        "readbackDigest",
        "nodeCount",
        "edgeCount",
        "deletedNodeIds",
        "deletedEdgeIds",
    )
    if not isinstance(stored, Mapping) or any(
        stored.get(field) != current.get(field) for field in fields
    ):
        raise PersistenceError(
            "GRAPH_PROVIDER_DELETE_READBACK_MISMATCH",
            502,
            "Current graph absence differs from its canonical rollback receipt.",
        )


def _unwrap(value: object, key: str) -> Mapping[str, object]:
    """Unwrap one canonical reply object while accepting both store and route shapes."""

    if not isinstance(value, Mapping):
        raise MigrationError("CANONICAL_SHAPE_INVALID", "Canonical reply is invalid.")
    nested = value.get(key)
    return nested if isinstance(nested, Mapping) else value


def _required_mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise MigrationError("CANONICAL_SHAPE_INVALID", f"Canonical {label} is unavailable.")
    return value


def _required_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise MigrationError("CANONICAL_ID_INVALID", f"Canonical {label} is invalid.")
    return value


def _positive_version(value: object) -> int:
    if type(value) is not int or value < 1:
        raise MigrationError("CANONICAL_VERSION_INVALID", "Canonical version is invalid.")
    return value


def _organization(scope: ActorScope) -> str:
    if scope.organization_id is None:
        raise MigrationError(
            "MIGRATION_ORGANIZATION_REQUIRED",
            "Conversation domain migration requires an org scope.",
        )
    return scope.organization_id


def _accepts_keyword(method: object, keyword: str) -> bool:
    import inspect

    if not callable(method):
        return False
    try:
        parameters = inspect.signature(method).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(
        parameter.name == keyword or parameter.kind is inspect.Parameter.VAR_KEYWORD
        for parameter in parameters
    )


def _graph_deletion_scope(
    scope: ActorScope, changeset: Mapping[str, object]
) -> tuple[str, str, list[str], list[str]]:
    organization = _organization(scope)
    conversation_id = _required_text(changeset.get("conversationId"), "conversation id")
    conversation_kind = _required_text(changeset.get("conversationKind"), "conversation kind")
    persona_value = changeset.get("personaId")
    if persona_value is not None and not isinstance(persona_value, str):
        raise PersistenceError(
            "GRAPH_PROVIDER_INPUT_INVALID", 422, "Graph persona scope is invalid."
        )
    persona_id = persona_value
    digest_value = hashlib.sha256(
        json.dumps(
            {
                "organizationId": organization,
                "workspaceId": scope.workspace_id,
                "conversationId": conversation_id,
                "conversationKind": conversation_kind,
                "personaId": persona_id,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    ).hexdigest()
    namespace = f"navigator-conversation-v1-{digest_value}"
    nodes_value = changeset.get("nodes")
    edges_value = changeset.get("edges")
    if not isinstance(nodes_value, list) or not isinstance(edges_value, list):
        raise PersistenceError("GRAPH_PROVIDER_INPUT_INVALID", 422, "Graph rows are invalid.")
    node_ids = [
        _required_text(item.get("id"), "node id")
        for item in nodes_value
        if isinstance(item, Mapping)
    ]
    edge_ids = [
        _required_text(item.get("id"), "edge id")
        for item in edges_value
        if isinstance(item, Mapping)
    ]
    if len(node_ids) != len(nodes_value) or len(edge_ids) != len(edges_value):
        raise PersistenceError("GRAPH_PROVIDER_INPUT_INVALID", 422, "Graph IDs are invalid.")
    if len(set(node_ids)) != len(node_ids) or len(set(edge_ids)) != len(edge_ids):
        raise PersistenceError("GRAPH_PROVIDER_INPUT_INVALID", 422, "Graph IDs are duplicated.")
    return organization, namespace, node_ids, edge_ids


def _decode_graph_node(
    node: Any,
    *,
    tenant: str,
    namespace: str,
    actor: str,
    conversation_id: str,
    conversation_kind: str,
    persona_id: str | None,
) -> dict[str, object]:
    """Normalize a single typed node readback and require exact provider scope facts."""

    if (
        node.tenant_id != tenant
        or node.namespace != namespace
        or node.kind != "entity"
        or not node.node_id
        or not node.label
    ):
        raise PersistenceError(
            "GRAPH_PROVIDER_SCOPE_MISMATCH", 502, "Graph node readback scope or shape changed."
        )
    properties = _decode_graph_properties(
        dict(node.metadata),
        actor=actor,
        conversation_id=conversation_id,
        conversation_kind=conversation_kind,
        persona_id=persona_id,
    )
    source_refs = _decode_graph_source_refs(tuple(node.source_refs))
    source_ids = _graph_source_ids(source_refs)
    return {
        "id": node.node_id,
        "label": node.label,
        "properties": properties,
        "sourceMessageIds": source_ids,
        "sourceRefs": source_refs,
    }


def _decode_graph_edge(
    edge: Any,
    *,
    tenant: str,
    namespace: str,
    actor: str,
    conversation_id: str,
    conversation_kind: str,
    persona_id: str | None,
) -> dict[str, object]:
    """Normalize a single typed edge readback and require exact provider scope facts."""

    if (
        edge.tenant_id != tenant
        or edge.namespace != namespace
        or not edge.edge_id
        or not edge.source_node_id
        or not edge.target_node_id
        or not edge.relation
    ):
        raise PersistenceError(
            "GRAPH_PROVIDER_SCOPE_MISMATCH", 502, "Graph edge readback scope or shape changed."
        )
    properties = _decode_graph_properties(
        dict(edge.metadata),
        actor=actor,
        conversation_id=conversation_id,
        conversation_kind=conversation_kind,
        persona_id=persona_id,
    )
    source_refs = _decode_graph_source_refs(tuple(edge.source_refs))
    source_ids = _graph_source_ids(source_refs)
    return {
        "id": edge.edge_id,
        "fromId": edge.source_node_id,
        "toId": edge.target_node_id,
        "label": edge.relation,
        "properties": properties,
        "sourceMessageIds": source_ids,
        "sourceRefs": source_refs,
    }


def _decode_graph_properties(
    metadata: Mapping[str, str],
    *,
    actor: str,
    conversation_id: str,
    conversation_kind: str,
    persona_id: str | None,
) -> dict[str, object]:
    """Validate graph scope metadata and rebuild bounded canonical property chunks."""

    prefix = "cyrene.navigator.v1.property."
    count_key = "cyrene.navigator.v1.property_count"
    expected_scope = {
        "cyrene.navigator.v1.schema": "1",
        "cyrene.navigator.v1.actor": actor,
        "cyrene.navigator.v1.conversation": conversation_id,
        "cyrene.navigator.v1.kind": conversation_kind,
        "cyrene.navigator.v1.persona": persona_id or "_none",
    }
    if any(metadata.get(key) != value for key, value in expected_scope.items()):
        raise PersistenceError(
            "GRAPH_PROVIDER_SCOPE_MISMATCH", 502, "Graph provider metadata scope changed."
        )
    try:
        count_text = metadata[count_key]
        count = int(count_text)
        if not 1 <= count <= 128:
            raise ValueError
        property_keys = {key for key in metadata if key.startswith(prefix)}
        expected_keys = {f"{prefix}{index:03d}" for index in range(count)}
        if property_keys != expected_keys:
            raise ValueError
        chunks = [metadata[f"{prefix}{index:03d}"] for index in range(count)]
        if any(not isinstance(chunk, str) or len(chunk) > 3_600 for chunk in chunks):
            raise ValueError
        if set(metadata) != set(expected_scope) | {count_key} | expected_keys:
            raise ValueError
        value = json.loads("".join(chunks))
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise PersistenceError(
            "GRAPH_PROVIDER_READBACK_INVALID", 502, "Graph property readback is invalid."
        ) from error
    if not isinstance(value, dict):
        raise PersistenceError(
            "GRAPH_PROVIDER_READBACK_INVALID", 502, "Graph properties are not an object."
        )
    return value


def _decode_graph_source_refs(values: Sequence[str]) -> list[dict[str, object]]:
    """Reassemble ordered lineage objects from the graph provider's canonical wire strings."""

    if not values or len(values) > 256:
        raise PersistenceError(
            "GRAPH_PROVIDER_READBACK_INVALID", 502, "Graph source references are invalid."
        )
    groups: dict[int, dict[int, tuple[int, str]]] = {}
    for value in values:
        if not isinstance(value, str) or not value.startswith("sr1:") or len(value) > 2_048:
            raise PersistenceError(
                "GRAPH_PROVIDER_READBACK_INVALID", 502, "Graph source references are invalid."
            )
        try:
            group_text, part_text, total_text, chunk = value.removeprefix("sr1:").split(":", 3)
            group, part, total = int(group_text), int(part_text), int(total_text)
        except (TypeError, ValueError) as error:
            raise PersistenceError(
                "GRAPH_PROVIDER_READBACK_INVALID", 502, "Graph source references are invalid."
            ) from error
        if (
            group < 0
            or part < 0
            or not 1 <= total <= 256
            or part >= total
            or len(chunk) > 1_700
            or part in groups.setdefault(group, {})
        ):
            raise PersistenceError(
                "GRAPH_PROVIDER_READBACK_INVALID", 502, "Graph source references are invalid."
            )
        groups[group][part] = (total, chunk)
    if sorted(groups) != list(range(len(groups))):
        raise PersistenceError(
            "GRAPH_PROVIDER_READBACK_INVALID", 502, "Graph source reference groups are invalid."
        )
    result: list[dict[str, object]] = []
    for group in range(len(groups)):
        parts = groups[group]
        totals = {total for total, _ in parts.values()}
        if len(totals) != 1:
            raise PersistenceError(
                "GRAPH_PROVIDER_READBACK_INVALID", 502, "Graph source reference parts differ."
            )
        total = totals.pop()
        if sorted(parts) != list(range(total)):
            raise PersistenceError(
                "GRAPH_PROVIDER_READBACK_INVALID", 502, "Graph source reference parts are missing."
            )
        try:
            value = json.loads("".join(parts[index][1] for index in range(total)))
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise PersistenceError(
                "GRAPH_PROVIDER_READBACK_INVALID", 502, "Graph source reference JSON is invalid."
            ) from error
        if not isinstance(value, dict):
            raise PersistenceError(
                "GRAPH_PROVIDER_READBACK_INVALID", 502, "Graph source reference is not an object."
            )
        result.append(value)
    return result


def _graph_source_ids(source_refs: Sequence[Mapping[str, object]]) -> list[str]:
    """Project stable de-duplicated source message IDs from exact graph lineage."""

    result: list[str] = []
    seen: set[str] = set()
    for source_ref in source_refs:
        values = source_ref.get("sourceMessageIds")
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            raise PersistenceError(
                "GRAPH_PROVIDER_READBACK_INVALID", 502, "Graph lineage IDs are invalid."
            )
        for value in values:
            if value not in seen:
                seen.add(value)
                result.append(value)
    return result


def _graph_rollback_operation_id(
    scope: ActorScope, changeset: Mapping[str, object], expected_version: int
) -> str:
    value = {
        "organizationId": scope.organization_id,
        "workspaceId": scope.workspace_id,
        "actorId": scope.actor_id,
        "changesetId": changeset.get("id"),
        "digest": changeset.get("digest"),
        "expectedVersion": expected_version,
    }
    return "conversation-graph-rollback-" + hashlib.sha256(canonical_json(value)).hexdigest()


__all__ = [
    "CanonicalGraphAdapter",
    "CanonicalMemoryAdapter",
    "CanonicalProfileAdapter",
    "CanonicalRollbackCapabilities",
    "ConversationMigrationHost",
    "DirectGraphCompensator",
    "GraphCompensationProvider",
    "WorkStoreOperationAdapter",
    "WorkStoreTaskProgressAdapter",
    "build_conversation_migration_host",
]
