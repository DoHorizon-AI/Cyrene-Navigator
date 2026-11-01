"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 knowledge_graph.py                                                   │
│  Module: cyrene_navigator.work.conversation_capabilities.knowledge_graph │
│  Role: Scoped knowledge.graph.v1 adapter with independent readback.      │
│                                                                          │
│  模块职责：按组织/工作区/会话/人格隔离图谱并逐项读回应用结果。           │
│  · sourceRefs 原样往返；readbackDigest 由真实插件回读重算。               │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from typing import Any

from cyrene_knowledge_graph_contracts import (
    CAPABILITY_ID,
    INTERFACE_VERSION,
    REQUEST_TYPE_URLS,
    RESPONSE_TYPE_URLS,
    KnowledgeGraphCodecError,
    decode_response,
    encode_request,
)
from cyrene_knowledge_graph_contracts import (
    knowledge_graph_pb2 as wire,
)
from cyrene_plugin_runtime import DirectPluginClient

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.work.conversation_memory.providers import KnowledgeGraphProvider as GraphPort

from .config import PluginBindingSettings
from .runtime import DirectCapabilityError, invoke_typed

_graph_wire: Any = wire

_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_PROPERTY_PREFIX = "cyrene.navigator.v1.property."
_SOURCE_REF_PREFIX = "sr1:"
_SOURCE_REF_CHUNK_BYTES = 1_700
_PROPERTY_CHUNK_CHARACTERS = 3_600
_MAX_ITEMS = 500
_MAX_QUERY_ITEMS = 100
_MAX_SOURCE_REFS = 256
_MAX_METADATA_ENTRIES = 128


class DirectKnowledgeGraphProvider(GraphPort):
    """Persist graph proposals through canonical graph RPCs and return proof of readback."""

    def __init__(self, client: DirectPluginClient, binding: PluginBindingSettings) -> None:
        self._client = client
        self._binding = binding

    def apply_changeset(
        self,
        *,
        organization_id: str,
        workspace_id: str,
        actor_id: str,
        changeset: Mapping[str, object],
    ) -> Mapping[str, object]:
        """Upsert every proposed node/edge, get each one back, and recompute its digest."""

        tenant_id = _identifier(organization_id, "organization id")
        workspace = _identifier(workspace_id, "workspace id")
        actor = _identifier(actor_id, "actor id")
        conversation_id, conversation_kind, persona_id = _changeset_scope(changeset)
        namespace = _namespace(
            tenant_id,
            workspace,
            conversation_id,
            conversation_kind,
            persona_id,
        )
        nodes = _require_records(changeset.get("nodes"), "nodes")
        edges = _require_records(changeset.get("edges"), "edges")
        request_digest = changeset.get("digest")
        if not isinstance(request_digest, str) or _DIGEST.fullmatch(request_digest) is None:
            raise _graph_failure("GRAPH_PROVIDER_INPUT_INVALID", 422)
        if not nodes and not edges:
            raise _graph_failure("GRAPH_PROVIDER_INPUT_INVALID", 422)

        node_messages = [
            _encode_node(
                tenant_id,
                namespace,
                actor,
                conversation_id,
                conversation_kind,
                persona_id,
                record,
            )
            for record in nodes
        ]
        edge_messages = [
            _encode_edge(
                tenant_id,
                namespace,
                actor,
                conversation_id,
                conversation_kind,
                persona_id,
                record,
            )
            for record in edges
        ]

        if node_messages:
            upserted = self._call(
                "upsert_nodes",
                _graph_wire.UpsertNodesRequest(
                    tenant_id=tenant_id,
                    namespace=namespace,
                    nodes=node_messages,
                ),
            )
            if not isinstance(
                upserted, _graph_wire.UpsertNodesResponse
            ) or upserted.upserted_count != len(node_messages):
                raise _graph_failure("GRAPH_PROVIDER_UPSERT_MISMATCH", 502)
        if edge_messages:
            upserted_edges = self._call(
                "upsert_edges",
                _graph_wire.UpsertEdgesRequest(
                    tenant_id=tenant_id,
                    namespace=namespace,
                    edges=edge_messages,
                ),
            )
            if not isinstance(
                upserted_edges, _graph_wire.UpsertEdgesResponse
            ) or upserted_edges.upserted_count != len(edge_messages):
                raise _graph_failure("GRAPH_PROVIDER_UPSERT_MISMATCH", 502)

        # Read each record through a separate canonical get RPC. Upsert counts are
        # not accepted as proof that graph contents and lineage were persisted.
        read_nodes = [
            self._read_node(
                tenant_id,
                namespace,
                str(record["id"]),
                actor,
                conversation_id,
                conversation_kind,
                persona_id,
            )
            for record in nodes
        ]
        read_edges = [
            self._read_edge(
                tenant_id,
                namespace,
                str(record["id"]),
                actor,
                conversation_id,
                conversation_kind,
                persona_id,
            )
            for record in edges
        ]
        readback = {
            "conversationId": conversation_id,
            "conversationKind": conversation_kind,
            "personaId": persona_id,
            "nodes": read_nodes,
            "edges": read_edges,
        }
        readback_digest = _digest(readback)
        if readback_digest != request_digest:
            raise _graph_failure("GRAPH_PROVIDER_READBACK_MISMATCH", 502)
        return {
            "readbackDigest": readback_digest,
            "nodeCount": len(read_nodes),
            "edgeCount": len(read_edges),
        }

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
    ) -> Mapping[str, object]:
        """Search and expand one exact conversation namespace with source metadata intact."""

        tenant_id = _identifier(organization_id, "organization id")
        workspace = _identifier(workspace_id, "workspace id")
        _identifier(actor_id, "actor id")
        conversation = _identifier(conversation_id, "conversation id")
        kind = _identifier(conversation_kind, "conversation kind")
        if persona_id is not None:
            _identifier(persona_id, "persona id")
        if not isinstance(query, str) or not query.strip() or len(query.encode("utf-8")) > 8_000:
            raise _graph_failure("GRAPH_QUERY_INVALID", 422)
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= _MAX_QUERY_ITEMS
        ):
            raise _graph_failure("GRAPH_QUERY_LIMIT_INVALID", 422)
        namespace = _namespace(tenant_id, workspace, conversation, kind, persona_id)
        filters = _conversation_filters(conversation, kind, persona_id)
        search = self._call(
            "search_nodes",
            _graph_wire.SearchNodesRequest(
                tenant_id=tenant_id,
                namespace=namespace,
                query=query,
                metadata_filters=filters,
                page_size=limit,
            ),
        )
        if not isinstance(search, _graph_wire.SearchNodesResponse) or not search.HasField("batch"):
            raise _graph_failure("GRAPH_PROVIDER_RESPONSE_INVALID", 502)
        seed_ids = [node.node_id for node in search.batch.nodes]
        if not seed_ids:
            return {"items": []}
        expanded = self._call(
            "expand",
            _graph_wire.ExpandGraphRequest(
                tenant_id=tenant_id,
                namespace=namespace,
                seed_node_ids=seed_ids,
                max_depth=1,
                node_limit=limit,
            ),
        )
        if not isinstance(expanded, _graph_wire.ExpandGraphResponse) or not expanded.HasField(
            "batch"
        ):
            raise _graph_failure("GRAPH_PROVIDER_RESPONSE_INVALID", 502)
        items: list[dict[str, object]] = []
        for node in expanded.batch.nodes:
            item = _query_node(node, tenant_id, namespace, conversation, kind, persona_id)
            if item is not None and len(items) < limit:
                items.append(item)
        for edge in expanded.batch.edges:
            item = _query_edge(edge, tenant_id, namespace, conversation, kind, persona_id)
            if item is not None and len(items) < limit:
                items.append(item)
        return {"items": items}

    def _read_node(
        self,
        tenant_id: str,
        namespace: str,
        node_id: str,
        actor_id: str,
        conversation_id: str,
        conversation_kind: str,
        persona_id: str | None,
    ) -> dict[str, object]:
        """Fetch a node independently and project the exact normalized proposal shape."""

        response = self._call(
            "get_node",
            _graph_wire.GetNodeRequest(tenant_id=tenant_id, namespace=namespace, node_id=node_id),
        )
        if not isinstance(response, _graph_wire.GetNodeResponse) or not response.HasField("node"):
            raise _graph_failure("GRAPH_PROVIDER_READBACK_INVALID", 502)
        return _node_record(
            response.node,
            tenant_id,
            namespace,
            actor_id,
            conversation_id,
            conversation_kind,
            persona_id,
        )

    def _read_edge(
        self,
        tenant_id: str,
        namespace: str,
        edge_id: str,
        actor_id: str,
        conversation_id: str,
        conversation_kind: str,
        persona_id: str | None,
    ) -> dict[str, object]:
        """Fetch an edge independently and project the exact normalized proposal shape."""

        response = self._call(
            "get_edge",
            _graph_wire.GetEdgeRequest(tenant_id=tenant_id, namespace=namespace, edge_id=edge_id),
        )
        if not isinstance(response, _graph_wire.GetEdgeResponse) or not response.HasField("edge"):
            raise _graph_failure("GRAPH_PROVIDER_READBACK_INVALID", 502)
        return _edge_record(
            response.edge,
            tenant_id,
            namespace,
            actor_id,
            conversation_id,
            conversation_kind,
            persona_id,
        )

    def _call(self, method: str, request: Any) -> Any:
        """Encode and invoke one typed graph method, then decode its selected result."""

        try:
            request_bytes = encode_request(method, request)
            result = invoke_typed(
                self._client,
                capability=CAPABILITY_ID,
                interface_version=INTERFACE_VERSION,
                method=method,
                request_type_url=REQUEST_TYPE_URLS[method],
                request_bytes=request_bytes,
                response_type_url=RESPONSE_TYPE_URLS[method],
                deadline_seconds=self._binding.deadline_seconds,
            )
            response = decode_response(method, result.value)
        except DirectCapabilityError as error:
            raise PersistenceError(
                error.code,
                503 if error.unavailable else 502,
                "The configured knowledge graph provider is unavailable or failed.",
                error.retryable,
            ) from error
        except (KnowledgeGraphCodecError, KeyError, TypeError, ValueError) as error:
            raise _graph_failure("GRAPH_PROVIDER_PROTOCOL_INVALID", 502) from error
        if response.WhichOneof("result") == "error":
            retryable = response.error.retryable
            raise _graph_failure("GRAPH_PROVIDER_FAILED", 503 if retryable else 502, retryable)
        return response


def _encode_node(
    tenant_id: str,
    namespace: str,
    actor_id: str,
    conversation_id: str,
    conversation_kind: str,
    persona_id: str | None,
    record: Mapping[str, object],
) -> Any:
    """Encode one normalized Navigator node while preserving arbitrary safe properties."""

    identifier = _identifier(record.get("id"), "node id")
    label = _required_text(record.get("label"), "node label", 240)
    properties = _mapping(record.get("properties", {}), "node properties")
    source_refs = _source_refs(record.get("sourceRefs"))
    _source_message_ids(record.get("sourceMessageIds"), source_refs)
    metadata = _metadata(
        properties,
        actor_id,
        conversation_id,
        conversation_kind,
        persona_id,
    )
    if len(metadata) > _MAX_METADATA_ENTRIES:
        raise _graph_failure("GRAPH_PROVIDER_INPUT_LIMIT", 413)
    return _graph_wire.GraphNode(
        node_id=identifier,
        tenant_id=tenant_id,
        namespace=namespace,
        kind="entity",
        label=label,
        metadata=metadata,
        source_refs=_encode_source_refs(source_refs),
    )


def _encode_edge(
    tenant_id: str,
    namespace: str,
    actor_id: str,
    conversation_id: str,
    conversation_kind: str,
    persona_id: str | None,
    record: Mapping[str, object],
) -> Any:
    """Encode one normalized Navigator edge with exact source and property metadata."""

    identifier = _identifier(record.get("id"), "edge id")
    source_node_id = _identifier(record.get("fromId"), "edge source node id")
    target_node_id = _identifier(record.get("toId"), "edge target node id")
    relation = _required_text(record.get("label"), "edge label", 240)
    properties = _mapping(record.get("properties", {}), "edge properties")
    source_refs = _source_refs(record.get("sourceRefs"))
    _source_message_ids(record.get("sourceMessageIds"), source_refs)
    metadata = _metadata(
        properties,
        actor_id,
        conversation_id,
        conversation_kind,
        persona_id,
    )
    if len(metadata) > _MAX_METADATA_ENTRIES:
        raise _graph_failure("GRAPH_PROVIDER_INPUT_LIMIT", 413)
    return _graph_wire.GraphEdge(
        edge_id=identifier,
        tenant_id=tenant_id,
        namespace=namespace,
        source_node_id=source_node_id,
        target_node_id=target_node_id,
        relation=relation,
        metadata=metadata,
        source_refs=_encode_source_refs(source_refs),
    )


def _node_record(
    node: Any,
    tenant_id: str,
    namespace: str,
    actor_id: str,
    conversation_id: str,
    conversation_kind: str,
    persona_id: str | None,
) -> dict[str, object]:
    """Decode provider readback into the canonical changeset representation."""

    if node.tenant_id != tenant_id or node.namespace != namespace:
        raise _graph_failure("GRAPH_PROVIDER_SCOPE_MISMATCH", 502)
    metadata = dict(node.metadata)
    _verify_scope_metadata(metadata, actor_id, conversation_id, conversation_kind, persona_id)
    properties = _decode_properties(metadata)
    source_refs = _decode_source_refs(node.source_refs)
    return {
        "id": node.node_id,
        "label": node.label,
        "properties": properties,
        "sourceMessageIds": _source_ids_from_refs(source_refs),
        "sourceRefs": source_refs,
    }


def _edge_record(
    edge: Any,
    tenant_id: str,
    namespace: str,
    actor_id: str,
    conversation_id: str,
    conversation_kind: str,
    persona_id: str | None,
) -> dict[str, object]:
    """Decode provider edge readback into the canonical changeset representation."""

    if edge.tenant_id != tenant_id or edge.namespace != namespace:
        raise _graph_failure("GRAPH_PROVIDER_SCOPE_MISMATCH", 502)
    metadata = dict(edge.metadata)
    _verify_scope_metadata(metadata, actor_id, conversation_id, conversation_kind, persona_id)
    properties = _decode_properties(metadata)
    source_refs = _decode_source_refs(edge.source_refs)
    return {
        "id": edge.edge_id,
        "fromId": edge.source_node_id,
        "toId": edge.target_node_id,
        "label": edge.relation,
        "properties": properties,
        "sourceMessageIds": _source_ids_from_refs(source_refs),
        "sourceRefs": source_refs,
    }


def _metadata(
    properties: Mapping[str, object],
    actor_id: str,
    conversation_id: str,
    conversation_kind: str,
    persona_id: str | None,
) -> dict[str, str]:
    """Encode JSON properties in bounded metadata chunks plus exact query scope facts."""

    encoded = _canonical_json(dict(properties))
    chunks = [
        encoded[index : index + _PROPERTY_CHUNK_CHARACTERS]
        for index in range(0, len(encoded), _PROPERTY_CHUNK_CHARACTERS)
    ] or ["{}"]
    metadata = {
        "cyrene.navigator.v1.schema": "1",
        "cyrene.navigator.v1.actor": actor_id,
        "cyrene.navigator.v1.conversation": conversation_id,
        "cyrene.navigator.v1.kind": conversation_kind,
        "cyrene.navigator.v1.persona": persona_id or "_none",
        "cyrene.navigator.v1.property_count": str(len(chunks)),
    }
    metadata.update({f"{_PROPERTY_PREFIX}{index:03d}": chunk for index, chunk in enumerate(chunks)})
    if any(not value or len(value) > 4_096 for value in metadata.values()):
        raise _graph_failure("GRAPH_PROVIDER_INPUT_LIMIT", 413)
    return metadata


def _decode_properties(metadata: Mapping[str, str]) -> dict[str, object]:
    """Rebuild properties from the provider readback and reject malformed chunks."""

    try:
        count_text = metadata["cyrene.navigator.v1.property_count"]
        count = int(count_text)
        if not 1 <= count <= _MAX_METADATA_ENTRIES:
            raise ValueError
        property_keys = {key for key in metadata if key.startswith(_PROPERTY_PREFIX)}
        expected_keys = {f"{_PROPERTY_PREFIX}{index:03d}" for index in range(count)}
        if property_keys != expected_keys:
            raise ValueError
        chunks = [metadata[f"{_PROPERTY_PREFIX}{index:03d}"] for index in range(count)]
        if any(len(chunk) > _PROPERTY_CHUNK_CHARACTERS for chunk in chunks):
            raise ValueError
        properties = json.loads("".join(chunks))
    except (KeyError, ValueError, TypeError, json.JSONDecodeError) as error:
        raise _graph_failure("GRAPH_PROVIDER_READBACK_INVALID", 502) from error
    if not isinstance(properties, dict):
        raise _graph_failure("GRAPH_PROVIDER_READBACK_INVALID", 502)
    return properties


def _encode_source_refs(source_refs: Sequence[Mapping[str, object]]) -> tuple[str, ...]:
    """Encode ordered source-reference objects into bounded opaque Graph strings."""

    values: list[str] = []
    for group, source_ref in enumerate(source_refs):
        encoded = _canonical_json(dict(source_ref))
        chunks = [
            encoded[index : index + _SOURCE_REF_CHUNK_BYTES]
            for index in range(0, len(encoded), _SOURCE_REF_CHUNK_BYTES)
        ] or ["{}"]
        for part, chunk in enumerate(chunks):
            values.append(f"{_SOURCE_REF_PREFIX}{group}:{part}:{len(chunks)}:{chunk}")
    if not values or len(values) > _MAX_SOURCE_REFS or any(len(value) > 2_048 for value in values):
        raise _graph_failure("GRAPH_PROVIDER_SOURCE_LIMIT", 413)
    return tuple(values)


def _decode_source_refs(values: Sequence[str]) -> list[dict[str, object]]:
    """Reassemble exact, ordered source references from graph readback strings."""

    if not values or len(values) > _MAX_SOURCE_REFS:
        raise _graph_failure("GRAPH_PROVIDER_READBACK_INVALID", 502)
    groups: dict[int, dict[int, tuple[int, str]]] = {}
    for value in values:
        if not isinstance(value, str) or not value.startswith(_SOURCE_REF_PREFIX):
            raise _graph_failure("GRAPH_PROVIDER_READBACK_INVALID", 502)
        try:
            group_text, part_text, total_text, chunk = value.removeprefix(_SOURCE_REF_PREFIX).split(
                ":", 3
            )
            group, part, total = int(group_text), int(part_text), int(total_text)
        except (ValueError, TypeError) as error:
            raise _graph_failure("GRAPH_PROVIDER_READBACK_INVALID", 502) from error
        if (
            group < 0
            or part < 0
            or total < 1
            or part >= total
            or len(chunk) > _SOURCE_REF_CHUNK_BYTES
        ):
            raise _graph_failure("GRAPH_PROVIDER_READBACK_INVALID", 502)
        parts = groups.setdefault(group, {})
        if part in parts:
            raise _graph_failure("GRAPH_PROVIDER_READBACK_INVALID", 502)
        parts[part] = (total, chunk)
    if sorted(groups) != list(range(len(groups))):
        raise _graph_failure("GRAPH_PROVIDER_READBACK_INVALID", 502)
    result: list[dict[str, object]] = []
    for group in range(len(groups)):
        parts = groups[group]
        totals = {total for total, _ in parts.values()}
        if len(totals) != 1:
            raise _graph_failure("GRAPH_PROVIDER_READBACK_INVALID", 502)
        total = totals.pop()
        if sorted(parts) != list(range(total)):
            raise _graph_failure("GRAPH_PROVIDER_READBACK_INVALID", 502)
        try:
            decoded = json.loads("".join(parts[index][1] for index in range(total)))
        except (json.JSONDecodeError, TypeError) as error:
            raise _graph_failure("GRAPH_PROVIDER_READBACK_INVALID", 502) from error
        if not isinstance(decoded, dict):
            raise _graph_failure("GRAPH_PROVIDER_READBACK_INVALID", 502)
        result.append(decoded)
    return result


def _query_node(
    node: Any,
    tenant_id: str,
    namespace: str,
    conversation_id: str,
    conversation_kind: str,
    persona_id: str | None,
) -> dict[str, object] | None:
    """Project a graph node only when its persisted scope and source metadata match."""

    if node.tenant_id != tenant_id or node.namespace != namespace:
        raise _graph_failure("GRAPH_PROVIDER_SCOPE_MISMATCH", 502)
    metadata = dict(node.metadata)
    _verify_query_metadata(metadata, conversation_id, conversation_kind, persona_id)
    source_refs = _decode_source_refs(node.source_refs)
    source_ids = _source_ids_from_refs(source_refs)
    if not source_ids:
        return None
    return {
        "itemType": "node",
        "id": node.node_id,
        "label": node.label,
        "properties": _decode_properties(metadata),
        "sourceRefs": source_refs,
        "sourceMessageIds": source_ids,
    }


def _query_edge(
    edge: Any,
    tenant_id: str,
    namespace: str,
    conversation_id: str,
    conversation_kind: str,
    persona_id: str | None,
) -> dict[str, object] | None:
    """Project a graph edge only when its persisted scope and source metadata match."""

    if edge.tenant_id != tenant_id or edge.namespace != namespace:
        raise _graph_failure("GRAPH_PROVIDER_SCOPE_MISMATCH", 502)
    metadata = dict(edge.metadata)
    _verify_query_metadata(metadata, conversation_id, conversation_kind, persona_id)
    source_refs = _decode_source_refs(edge.source_refs)
    source_ids = _source_ids_from_refs(source_refs)
    if not source_ids:
        return None
    return {
        "itemType": "edge",
        "id": edge.edge_id,
        "fromId": edge.source_node_id,
        "toId": edge.target_node_id,
        "label": edge.relation,
        "properties": _decode_properties(metadata),
        "sourceRefs": source_refs,
        "sourceMessageIds": source_ids,
    }


def _verify_query_metadata(
    metadata: Mapping[str, str],
    conversation_id: str,
    conversation_kind: str,
    persona_id: str | None,
) -> None:
    """Require the original conversation and persona scope from actual graph readback."""

    if (
        metadata.get("cyrene.navigator.v1.schema") != "1"
        or metadata.get("cyrene.navigator.v1.conversation") != conversation_id
        or metadata.get("cyrene.navigator.v1.kind") != conversation_kind
        or metadata.get("cyrene.navigator.v1.persona") != (persona_id or "_none")
    ):
        raise _graph_failure("GRAPH_PROVIDER_SCOPE_MISMATCH", 502)


def _verify_scope_metadata(
    metadata: Mapping[str, str],
    actor_id: str,
    conversation_id: str,
    conversation_kind: str,
    persona_id: str | None,
) -> None:
    """Confirm readback still carries the exact author and conversation namespace facts."""

    if (
        metadata.get("cyrene.navigator.v1.schema") != "1"
        or metadata.get("cyrene.navigator.v1.actor") != actor_id
        or metadata.get("cyrene.navigator.v1.conversation") != conversation_id
        or metadata.get("cyrene.navigator.v1.kind") != conversation_kind
        or metadata.get("cyrene.navigator.v1.persona") != (persona_id or "_none")
    ):
        raise _graph_failure("GRAPH_PROVIDER_SCOPE_MISMATCH", 502)


def _conversation_filters(
    conversation_id: str,
    conversation_kind: str,
    persona_id: str | None,
) -> dict[str, str]:
    """Build exact server-derived metadata filters for one conversation namespace."""

    return {
        "cyrene.navigator.v1.conversation": conversation_id,
        "cyrene.navigator.v1.kind": conversation_kind,
        "cyrene.navigator.v1.persona": persona_id or "_none",
    }


def _namespace(
    tenant_id: str,
    workspace_id: str,
    conversation_id: str,
    conversation_kind: str,
    persona_id: str | None,
) -> str:
    """Derive a stable private namespace shared only by the exact conversation/persona."""

    digest = _digest(
        {
            "organizationId": tenant_id,
            "workspaceId": workspace_id,
            "conversationId": conversation_id,
            "conversationKind": conversation_kind,
            "personaId": persona_id,
        }
    )
    return f"navigator-conversation-v1-{digest}"


def _changeset_scope(changeset: Mapping[str, object]) -> tuple[str, str, str | None]:
    """Read the immutable conversation context embedded in the stored changeset."""

    conversation_id = _identifier(changeset.get("conversationId"), "conversation id")
    conversation_kind = _identifier(changeset.get("conversationKind"), "conversation kind")
    persona_id_value = changeset.get("personaId")
    persona_id = None if persona_id_value is None else _identifier(persona_id_value, "persona id")
    return conversation_id, conversation_kind, persona_id


def _require_records(value: object, field_name: str) -> list[Mapping[str, object]]:
    """Require a bounded list of normalized graph records."""

    if not isinstance(value, list) or len(value) > _MAX_ITEMS:
        raise _graph_failure("GRAPH_PROVIDER_INPUT_LIMIT", 413)
    if any(not isinstance(item, Mapping) for item in value):
        raise _graph_failure("GRAPH_PROVIDER_INPUT_INVALID", 422)
    return list(value)


def _mapping(value: object, field_name: str) -> Mapping[str, object]:
    """Require a JSON object for one graph property set."""

    if not isinstance(value, Mapping):
        raise _graph_failure("GRAPH_PROVIDER_INPUT_INVALID", 422)
    try:
        encoded = _canonical_json(dict(value))
    except (TypeError, ValueError) as error:
        raise _graph_failure("GRAPH_PROVIDER_INPUT_INVALID", 422) from error
    if len(encoded.encode("utf-8")) > 32 * 1024:
        raise _graph_failure("GRAPH_PROVIDER_INPUT_LIMIT", 413)
    del field_name
    return value


def _source_refs(value: object) -> list[dict[str, object]]:
    """Validate the exact P2 source-reference objects without flattening lineage."""

    if not isinstance(value, list) or not value or len(value) > _MAX_SOURCE_REFS:
        raise _graph_failure("GRAPH_PROVIDER_SOURCE_INVALID", 422)
    refs: list[dict[str, object]] = []
    for item in value:
        if not isinstance(item, Mapping) or set(item) != {
            "memoryId",
            "memoryVersion",
            "sourceMessageIds",
        }:
            raise _graph_failure("GRAPH_PROVIDER_SOURCE_INVALID", 422)
        memory_id = item["memoryId"]
        memory_version = item["memoryVersion"]
        raw_ids = item["sourceMessageIds"]
        if (memory_id is None) != (memory_version is None):
            raise _graph_failure("GRAPH_PROVIDER_SOURCE_INVALID", 422)
        if memory_id is not None:
            _identifier(memory_id, "source memory id")
            if (
                isinstance(memory_version, bool)
                or not isinstance(memory_version, int)
                or memory_version < 1
            ):
                raise _graph_failure("GRAPH_PROVIDER_SOURCE_INVALID", 422)
        if not isinstance(raw_ids, list) or len(raw_ids) > 128:
            raise _graph_failure("GRAPH_PROVIDER_SOURCE_INVALID", 422)
        source_ids = [_identifier(source_id, "source message id") for source_id in raw_ids]
        if memory_id is None and not source_ids:
            raise _graph_failure("GRAPH_PROVIDER_SOURCE_INVALID", 422)
        refs.append(
            {
                "memoryId": memory_id,
                "memoryVersion": memory_version,
                "sourceMessageIds": list(dict.fromkeys(source_ids)),
            }
        )
    return refs


def _source_message_ids(value: object, source_refs: Sequence[Mapping[str, object]]) -> list[str]:
    """Check the flattened source IDs against the exact reference projection."""

    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise _graph_failure("GRAPH_PROVIDER_SOURCE_INVALID", 422)
    expected = _source_ids_from_refs(source_refs)
    if value != expected:
        raise _graph_failure("GRAPH_PROVIDER_SOURCE_INVALID", 422)
    return expected


def _source_ids_from_refs(source_refs: Sequence[Mapping[str, object]]) -> list[str]:
    """Project the same ordered de-duplicated message IDs used by Navigator storage."""

    result: list[str] = []
    seen: set[str] = set()
    for source_ref in source_refs:
        source_ids = source_ref.get("sourceMessageIds")
        if not isinstance(source_ids, list):
            raise _graph_failure("GRAPH_PROVIDER_SOURCE_INVALID", 502)
        for source_id in source_ids:
            if not isinstance(source_id, str):
                raise _graph_failure("GRAPH_PROVIDER_SOURCE_INVALID", 502)
            if source_id not in seen:
                seen.add(source_id)
                result.append(source_id)
    return result


def _identifier(value: object, field_name: str) -> str:
    """Validate an identifier using the closed Navigator domain syntax."""

    if (
        not isinstance(value, str)
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}", value) is None
        or ".." in value
    ):
        raise _graph_failure("GRAPH_PROVIDER_INPUT_INVALID", 422)
    del field_name
    return value


def _required_text(value: object, field_name: str, maximum: int) -> str:
    """Validate bounded human-readable graph labels and relation names."""

    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise _graph_failure("GRAPH_PROVIDER_INPUT_INVALID", 422)
    del field_name
    return value


def _digest(value: object) -> str:
    """Hash Navigator's deterministic JSON representation of a graph changeset."""

    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _canonical_json(value: object) -> str:
    """Return bounded deterministic UTF-8 JSON, rejecting NaN and non-JSON values."""

    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise _graph_failure("GRAPH_PROVIDER_INPUT_INVALID", 422) from error


def _graph_failure(code: str, status: int, retryable: bool = False) -> PersistenceError:
    """Create a redacted persistence error for graph RPC and readback failures."""

    return PersistenceError(
        code, status, "The configured knowledge graph provider request failed.", retryable
    )


__all__ = ["DirectKnowledgeGraphProvider"]
