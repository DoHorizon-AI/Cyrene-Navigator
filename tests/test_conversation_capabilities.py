"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 test_conversation_capabilities.py                                    │
│  Test: tests.test_conversation_capabilities                              │
│  Role: Exercise real DirectPluginRuntime wire calls and scoped adapters.  │
│                                                                          │
│  测试职责：验证真实 gRPC runtime 边界、作用域和 provider readback。       │
│  · Plugin 行为由本文件的 SIMULATED fixture 提供；不代表外部平台验收。    │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Iterator, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Barrier
from typing import Any

import pytest
from cyrene_integration_contracts import TOOL_OPERATIONS, verify_context
from cyrene_knowledge_graph_contracts import (
    METHODS as GRAPH_METHODS,
)
from cyrene_knowledge_graph_contracts import (
    REQUEST_TYPE_URLS as GRAPH_REQUEST_URLS,
)
from cyrene_knowledge_graph_contracts import (
    RESPONSE_TYPE_URLS as GRAPH_RESPONSE_URLS,
)
from cyrene_knowledge_graph_contracts import (
    decode_request as decode_graph_request,
)
from cyrene_knowledge_graph_contracts import (
    encode_response as encode_graph_response,
)
from cyrene_knowledge_graph_contracts import (
    knowledge_graph_pb2 as graph_wire,
)
from cyrene_memory_provider_contracts import memory as memory_contract
from cyrene_model_provider_contracts.embeddings import (
    CAPABILITY_ID as MODEL_CAPABILITY_ID,
)
from cyrene_model_provider_contracts.embeddings import (
    EMBEDDINGS_METHOD,
    EMBEDDINGS_REQUEST_TYPE_URL,
    EMBEDDINGS_RESPONSE_TYPE_URL,
    EmbeddingsResponse,
    EmbeddingVector,
    decode_embeddings_request,
    encode_embeddings_response,
)
from cyrene_model_provider_contracts.embeddings import (
    EmbeddingBatch as ModelEmbeddingBatch,
)
from cyrene_plugin_runtime import (
    DirectPluginClient,
    serve,
)
from cyrene_speech_provider_contracts import (
    METHOD_TRANSCRIBE,
    speech_provider_pb2,
)
from cyrene_speech_provider_contracts import (
    REQUEST_TYPE_URLS as SPEECH_REQUEST_URLS,
)
from cyrene_speech_provider_contracts import (
    RESPONSE_TYPE_URLS as SPEECH_RESPONSE_URLS,
)
from cyrene_speech_provider_contracts import (
    decode_request as decode_speech_request,
)
from cyrene_speech_provider_contracts import (
    encode_response as encode_speech_response,
)
from cyrene_tool_provider_contracts import (
    METHOD_CALL_TOOL,
    METHOD_LIST_TOOLS,
    tool_provider_pb2,
)
from cyrene_tool_provider_contracts import (
    decode_request as decode_tool_request,
)
from cyrene_tool_provider_contracts import (
    encode_response as encode_tool_response,
)

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_capabilities.config import (
    CapabilityConfigurationError,
    EmbeddingProfile,
    PluginBindingSettings,
    SpeechProfile,
    ToolCallerSettings,
)
from cyrene_navigator.work.conversation_capabilities.embeddings import DirectEmbeddingClient
from cyrene_navigator.work.conversation_capabilities.factory import build_conversation_capabilities
from cyrene_navigator.work.conversation_capabilities.knowledge_graph import (
    DirectKnowledgeGraphProvider,
)
from cyrene_navigator.work.conversation_capabilities.memory import DirectMemoryProvider
from cyrene_navigator.work.conversation_capabilities.peripheral import (
    DirectSpeechProvider,
    DirectToolProviderClient,
    HostTrustedCallerSigner,
    build_host_trusted_caller_signer,
)
from cyrene_navigator.work.conversation_memory.providers import (
    MemoryProviderHit,
    MemoryProviderScope,
)

_CAPABILITIES = (
    MODEL_CAPABILITY_ID,
    memory_contract.CAPABILITY_ID,
    "knowledge.graph.v1",
    "tool.provider.v1",
    "speech.provider.v1",
)
_INTERFACE_VERSIONS = {capability: "1" for capability in _CAPABILITIES}
_TOOL_KEY = bytes(range(32))


class _TypedResult:
    """One fake provider response in the official DirectPluginRuntime wire shape."""

    def __init__(self, type_url: str, value: bytes) -> None:
        self.type_url = type_url
        self.value = value


class _SimulatedCapabilityPlugin:
    """SIMULATED capability implementations behind a real loopback gRPC server."""

    capabilities = _CAPABILITIES
    plugin_id = "test.conversation-capability-adapters"
    version = "0.0.1-test"

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.embedding_inputs: list[tuple[str, ...]] = []
        self.memory_items: dict[tuple[str, str], memory_contract.MemoryItem] = {}
        self.memory_recall_cross_actor = False
        self.memory_delete_mode = "normal"
        self.memory_delete_calls = 0
        self.memory_get_unavailable = False
        self.graph_nodes: dict[tuple[str, str, str], Any] = {}
        self.graph_edges: dict[tuple[str, str, str], Any] = {}
        self.graph_readback_mutation = False
        self.tool_arguments: Mapping[str, Any] | None = None
        self.tool_context: Mapping[str, Any] | None = None
        self.tool_id = "media.asset.import"
        self.speech_input: tuple[bytes, str, str | None] | None = None
        self.speech_fails = False
        self.embedding_zero = False

    def on_invoke(
        self,
        capability: str,
        action: str,
        payload: bytes,
        *,
        request_type_url: str | None = None,
        **_: object,
    ) -> tuple[bool, object]:
        self.calls.append((capability, action))
        if capability == MODEL_CAPABILITY_ID:
            return self._model(action, payload, request_type_url)
        if capability == memory_contract.CAPABILITY_ID:
            return self._memory(action, payload, request_type_url)
        if capability == "knowledge.graph.v1":
            return self._graph(action, payload, request_type_url)
        if capability == "tool.provider.v1":
            return self._tool(action, payload, request_type_url)
        if capability == "speech.provider.v1":
            return self._speech(action, payload, request_type_url)
        return False, "METHOD_NOT_FOUND: unsupported test capability"

    def _model(
        self, action: str, payload: bytes, request_type_url: str | None
    ) -> tuple[bool, object]:
        if action != EMBEDDINGS_METHOD or request_type_url != EMBEDDINGS_REQUEST_TYPE_URL:
            return False, "INVALID_INPUT: model method or type URL mismatch"
        request = decode_embeddings_request(payload)
        self.embedding_inputs.append(request.inputs)
        vector_values = (0.0, 0.0, 0.0) if self.embedding_zero else (0.75, 0.5, 0.25)
        response = EmbeddingsResponse(
            embeddings=ModelEmbeddingBatch(
                vectors=tuple(EmbeddingVector(vector_values) for _ in request.inputs),
                dimensions=3,
                model="test-embedding-model",
            )
        )
        return True, _TypedResult(
            EMBEDDINGS_RESPONSE_TYPE_URL, encode_embeddings_response(response)
        )

    def _memory(
        self, action: str, payload: bytes, request_type_url: str | None
    ) -> tuple[bool, object]:
        if (
            action not in memory_contract.METHODS
            or request_type_url != memory_contract.REQUEST_TYPE_URLS[action]
        ):
            return False, "INVALID_INPUT: memory method or type URL mismatch"
        request = memory_contract.decode_request(action, payload)
        tenant_id = str(getattr(request, "tenant_id", ""))
        if action == memory_contract.METHOD_STORE:
            item = request.item
            self.memory_items[(tenant_id, item.item_id)] = item
            response: object = memory_contract.StoreMemoryResponse(item_id=item.item_id)
        elif action == memory_contract.METHOD_GET:
            if self.memory_get_unavailable:
                return False, "UNAVAILABLE: independent readback unavailable"
            item = self.memory_items.get((tenant_id, request.item_id))
            response = (
                memory_contract.GetMemoryResponse(item=item)
                if item is not None
                else memory_contract.GetMemoryResponse(
                    error=memory_contract.MemoryError(
                        code=memory_contract.MemoryErrorCode.NOT_FOUND,
                        message="not found",
                    )
                )
            )
        elif action == memory_contract.METHOD_RECALL:
            matches = []
            for (tenant, _), item in self.memory_items.items():
                if tenant != request.tenant_id or (
                    not self.memory_recall_cross_actor
                    and (item.scope != request.scope or item.subject != request.subject)
                ):
                    continue
                if not self.memory_recall_cross_actor and any(
                    item.metadata.get(key) != value
                    for key, value in request.metadata_filters.items()
                ):
                    continue
                matches.append(memory_contract.MemoryMatch(item=item, score=1.0))
            response = memory_contract.RecallMemoryResponse(matches=tuple(matches[: request.top_k]))
        elif action == memory_contract.METHOD_DELETE:
            self.memory_delete_calls += 1
            key = (tenant_id, request.item_id)
            if self.memory_delete_mode == "return_false":
                deleted = False
            elif self.memory_delete_mode == "return_true_but_keep":
                deleted = True
            elif self.memory_delete_mode in {
                "remove_then_unavailable",
                "remove_then_unavailable_readback",
            }:
                deleted = self.memory_items.pop(key, None) is not None
                if self.memory_delete_mode == "remove_then_unavailable_readback":
                    self.memory_get_unavailable = True
                return False, "UNAVAILABLE: delete response was lost"
            else:
                deleted = self.memory_items.pop(key, None) is not None
            response = memory_contract.DeleteMemoryResponse(deleted=deleted)
        elif action == memory_contract.METHOD_PRUNE:
            removed = [
                key
                for key, item in self.memory_items.items()
                if key[0] == tenant_id and item.created_at_ms < request.before_timestamp_ms
            ]
            for key in removed:
                self.memory_items.pop(key, None)
            response = memory_contract.PruneMemoryResponse(pruned_count=len(removed))
        elif action == memory_contract.METHOD_EXPORT_BATCH:
            items = tuple(
                item
                for (tenant, _), item in self.memory_items.items()
                if tenant == tenant_id and (request.scope is None or item.scope == request.scope)
            )[: request.limit]
            response = memory_contract.ExportMemoryResponse(items=items, next_page_token="")
        elif action == memory_contract.METHOD_IMPORT_BATCH:
            imported = 0
            for item in request.items:
                key = (tenant_id, item.item_id)
                if key in self.memory_items and not request.overwrite:
                    continue
                self.memory_items[key] = item
                imported += 1
            response = memory_contract.ImportMemoryResponse(imported_count=imported)
        else:
            return False, "METHOD_NOT_FOUND: unsupported memory method"
        return True, _TypedResult(
            memory_contract.RESPONSE_TYPE_URLS[action],
            memory_contract.encode_response(action, response),
        )

    def _graph(
        self, action: str, payload: bytes, request_type_url: str | None
    ) -> tuple[bool, object]:
        if action not in GRAPH_METHODS or request_type_url != GRAPH_REQUEST_URLS[action]:
            return False, "INVALID_INPUT: graph method or type URL mismatch"
        request = decode_graph_request(action, payload)
        scope = (request.tenant_id, request.namespace)
        response: Any
        if action == "upsert_nodes":
            for node in request.nodes:
                self.graph_nodes[(*scope, node.node_id)] = _copy_proto(node)
            response = graph_wire.UpsertNodesResponse(upserted_count=len(request.nodes))
        elif action == "get_node":
            node = self.graph_nodes.get((*scope, request.node_id))
            if node is None:
                response = graph_wire.GetNodeResponse(
                    error=graph_wire.KnowledgeGraphError(
                        code=graph_wire.KNOWLEDGE_GRAPH_ERROR_CODE_NOT_FOUND,
                        message="not found",
                    )
                )
            else:
                selected = _copy_proto(node)
                if self.graph_readback_mutation:
                    selected.label += " changed"
                response = graph_wire.GetNodeResponse(node=selected)
        elif action == "upsert_edges":
            for edge in request.edges:
                if (*scope, edge.source_node_id) not in self.graph_nodes or (
                    *scope,
                    edge.target_node_id,
                ) not in self.graph_nodes:
                    return False, "INVALID_INPUT: edge endpoint is missing"
                self.graph_edges[(*scope, edge.edge_id)] = _copy_proto(edge)
            response = graph_wire.UpsertEdgesResponse(upserted_count=len(request.edges))
        elif action == "get_edge":
            edge = self.graph_edges.get((*scope, request.edge_id))
            response = (
                graph_wire.GetEdgeResponse(edge=_copy_proto(edge))
                if edge is not None
                else graph_wire.GetEdgeResponse(
                    error=graph_wire.KnowledgeGraphError(
                        code=graph_wire.KNOWLEDGE_GRAPH_ERROR_CODE_NOT_FOUND,
                        message="not found",
                    )
                )
            )
        elif action == "search_nodes":
            selected = []
            for (tenant, namespace, _), node in self.graph_nodes.items():
                if (tenant, namespace) != scope:
                    continue
                if any(
                    node.metadata.get(key) != value
                    for key, value in request.metadata_filters.items()
                ):
                    continue
                haystack = (node.label + " " + " ".join(node.metadata.values())).casefold()
                if request.query.casefold() not in haystack:
                    continue
                selected.append(_copy_proto(node))
            response = graph_wire.SearchNodesResponse(
                batch=graph_wire.SearchNodesBatch(nodes=selected[: request.page_size])
            )
        elif action == "expand":
            node_ids = set(request.seed_node_ids)
            edges = [
                edge
                for (tenant, namespace, _), edge in self.graph_edges.items()
                if (tenant, namespace) == scope
                and (edge.source_node_id in node_ids or edge.target_node_id in node_ids)
            ]
            for edge in edges:
                node_ids.add(edge.source_node_id)
                node_ids.add(edge.target_node_id)
            nodes = [
                _copy_proto(node)
                for (tenant, namespace, _), node in self.graph_nodes.items()
                if (tenant, namespace) == scope and node.node_id in node_ids
            ][: request.node_limit]
            response = graph_wire.ExpandGraphResponse(
                batch=graph_wire.ExpandGraphBatch(
                    nodes=nodes,
                    edges=[_copy_proto(edge) for edge in edges],
                )
            )
        else:
            return False, "METHOD_NOT_FOUND: unsupported graph method"
        return True, _TypedResult(
            GRAPH_RESPONSE_URLS[action], encode_graph_response(action, response)
        )

    def _tool(
        self, action: str, payload: bytes, request_type_url: str | None
    ) -> tuple[bool, object]:
        if action == METHOD_LIST_TOOLS:
            request = decode_tool_request(action, _tool_payload(request_type_url, payload))
            if request.binding_id != "test-tool-binding":
                return False, "INVALID_INPUT: binding mismatch"
            descriptor = tool_provider_pb2.ToolDescriptor(
                binding_id=request.binding_id,
                provider_tool_id=self.tool_id,
                display_name="Import media asset",
                description="Test catalog entry",
                input_schema_json=json.dumps(
                    {
                        "type": "object",
                        "properties": {"artifact_id": {"type": "string"}},
                        "required": ["artifact_id"],
                        "additionalProperties": False,
                    }
                ),
            )
            response = tool_provider_pb2.ListToolsResponse(
                catalog=tool_provider_pb2.ToolCatalog(catalog_version="v1", tools=[descriptor])
            )
        elif action == METHOD_CALL_TOOL:
            request = decode_tool_request(action, _tool_payload(request_type_url, payload))
            envelope = json.loads(request.arguments_json)
            context = envelope["caller_context"]
            arguments = envelope["arguments"]
            assert request.binding_id == "test-tool-binding"
            assert request.catalog_version == "v1"
            assert request.provider_tool_id == self.tool_id
            assert verify_context(
                method=request.provider_tool_id,
                operation_id=TOOL_OPERATIONS[request.provider_tool_id],
                payload=arguments,
                context=context,
                key=_TOOL_KEY,
                expected_caller_workload="navigator-local",
                expected_audience="cyrene.plugins.test-tool",
                expected_binding_id=request.binding_id,
                expected_organization_id="org-test",
                expected_workspace_id="workspace-test",
                expected_issuer="cyrene://navigator-test",
                expected_subject="actor-test",
            )
            self.tool_arguments = arguments
            self.tool_context = context
            content = tool_provider_pb2.ToolContentPart(
                json=tool_provider_pb2.ToolJsonContent(
                    json=json.dumps({"asset_id": "asset-real-from-provider"})
                )
            )
            response = tool_provider_pb2.CallToolResponse(
                outcome=tool_provider_pb2.ToolCallOutcome(content=[content])
            )
        else:
            return False, "METHOD_NOT_FOUND: unsupported tool method"
        encoded = encode_tool_response(action, response)
        return True, _TypedResult(encoded.type_url, encoded.value)

    def _speech(
        self, action: str, payload: bytes, request_type_url: str | None
    ) -> tuple[bool, object]:
        if action != METHOD_TRANSCRIBE or request_type_url != SPEECH_REQUEST_URLS[action]:
            return False, "INVALID_INPUT: speech method or type URL mismatch"
        request = decode_speech_request(action, payload)
        self.speech_input = (
            bytes(request.input.data),
            request.input.mime_type,
            request.language_hint if request.HasField("language_hint") else None,
        )
        if self.speech_fails:
            response = speech_provider_pb2.TranscribeResponse(
                error=speech_provider_pb2.SpeechError(
                    code=speech_provider_pb2.SPEECH_ERROR_CODE_PROVIDER_FAILED,
                    message="private plugin failure detail",
                )
            )
        else:
            response = speech_provider_pb2.TranscribeResponse(
                transcription=speech_provider_pb2.TranscriptionResult(
                    status=speech_provider_pb2.TRANSCRIPTION_STATUS_SUCCEEDED,
                    text="transcript from the test provider",
                    detected_language="en",
                    duration_ms=800,
                    model="sensevoice-test-model",
                    segments=[
                        speech_provider_pb2.TranscriptSegment(
                            start_ms=0, end_ms=800, text="transcript from the test provider"
                        )
                    ],
                )
            )
        return True, _TypedResult(
            SPEECH_RESPONSE_URLS[action],
            encode_speech_response(action, response),
        )


@contextmanager
def _direct_runtime() -> Iterator[tuple[_SimulatedCapabilityPlugin, DirectPluginClient]]:
    """Run SIMULATED plugin methods behind the official local DirectPluginRuntime."""

    plugin = _SimulatedCapabilityPlugin()
    server, connection_ref = serve(
        plugin,
        capability=_CAPABILITIES,
        interface_versions=_INTERFACE_VERSIONS,
        listen="127.0.0.1:0",
    )
    client = DirectPluginClient.for_local_connection_ref(connection_ref)
    try:
        yield plugin, client
    finally:
        client.close()
        server.stop(grace=0).wait(timeout=2)


def _copy_proto(message: Any) -> Any:
    """Copy one generated protobuf by serializing it as an RPC process would."""

    duplicate = type(message)()
    duplicate.ParseFromString(message.SerializeToString())
    return duplicate


def _tool_payload(type_url: str | None, payload: bytes) -> Any:
    from cyrene_tool_provider_contracts.payload import TypedPayload

    assert type_url is not None
    return TypedPayload(type_url=type_url, value=payload)


def _graph_digest(value: Mapping[str, object]) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _scope(
    *,
    actor_id: str = "actor-test",
    conversation_id: str = "conversation-test",
    conversation_kind: str = "direct",
    persona_id: str | None = None,
    visibility: str | None = "private",
) -> MemoryProviderScope:
    return MemoryProviderScope(
        organization_id="org-test",
        workspace_id="workspace-test",
        actor_id=actor_id,
        conversation_id=conversation_id,
        conversation_kind=conversation_kind,
        persona_id=persona_id,
        visibility=visibility,
    )


def test_embeddings_uses_purpose_prefixes_and_actual_model_batch() -> None:
    profile = EmbeddingProfile(
        model_id="test-embedding-model",
        profile_id="test-profile",
        dimensions=3,
        document_prefix="passage: ",
        query_prefix="query: ",
    )
    binding = PluginBindingSettings("grpc://127.0.0.1:51001")
    with _direct_runtime() as (plugin, client):
        embeddings = DirectEmbeddingClient(client, binding, profile)
        stored = embeddings.embed(["remember this"], purpose="document")
        recalled = embeddings.embed(["find this"], purpose="query")
        assert plugin.embedding_inputs == [("passage: remember this",), ("query: find this",)]
        assert stored.model == recalled.model == profile.model_id
        assert stored.dimensions == recalled.dimensions == 3
        assert stored.vectors == ((0.75, 0.5, 0.25),)


def test_embeddings_rejects_zero_vectors_and_wrong_model_dimensions() -> None:
    profile = EmbeddingProfile(
        model_id="test-embedding-model",
        profile_id="test-profile",
        dimensions=3,
    )
    with _direct_runtime() as (plugin, client):
        provider = DirectEmbeddingClient(
            client, PluginBindingSettings("grpc://127.0.0.1:51002"), profile
        )
        plugin.embedding_zero = True
        with pytest.raises(PersistenceError) as error:
            provider.embed(["text"])
        assert error.value.code == "MEMORY_EMBEDDING_RESPONSE_INVALID"
        with pytest.raises(PersistenceError) as model_error:
            provider.embed(["text"], model="another-model")
        assert model_error.value.code == "MEMORY_EMBEDDING_MODEL_MISMATCH"


def test_memory_adapter_exercises_all_seven_rpc_methods_and_scope_checks() -> None:
    profile = EmbeddingProfile(
        model_id="test-embedding-model", profile_id="test-profile", dimensions=3
    )
    selected_scope = _scope()
    with _direct_runtime() as (plugin, client):
        provider = DirectMemoryProvider(
            client,
            PluginBindingSettings("grpc://127.0.0.1:51003"),
            profile,
            maintenance_tenants=frozenset({"org-test"}),
        )
        provider.upsert(
            memory_id="memory-one",
            text="A sourced memory",
            embedding=(0.75, 0.5, 0.25),
            model=profile.model_id,
            dimensions=3,
            scope=selected_scope,
            authorization_epoch=9,
        )
        item = provider.get_memory(memory_id="memory-one", scope=selected_scope)
        assert item is not None
        assert item.content == "A sourced memory"
        assert item.metadata["cyrene.navigator.authorization_epoch"] == "9"
        hits = provider.query(
            text="A sourced memory",
            embedding=(0.75, 0.5, 0.25),
            model=profile.model_id,
            dimensions=3,
            scope=selected_scope,
            limit=5,
        )
        assert [hit.memory_id for hit in hits] == ["memory-one"]
        assert hits[0].model == profile.model_id and hits[0].dimensions == 3

        exported = provider.export_batch(scope=selected_scope, limit=20)
        assert [entry.item_id for entry in exported.items or ()] == ["memory-one"]
        imported_item = memory_contract.MemoryItem(
            item_id="memory-two",
            tenant_id="org-test",
            scope=item.scope,
            subject="actor-test",
            content="Second sourced memory",
            embedding=(0.75, 0.5, 0.25),
            metadata=dict(item.metadata),
        )
        assert provider.import_batch(scope=selected_scope, items=(imported_item,)) == 1
        provider.delete(memory_ids=("memory-two",), scope=selected_scope)
        assert provider.get_memory(memory_id="memory-two", scope=selected_scope) is None
        assert (
            provider.prune_tenant(
                tenant_id="org-test", before_timestamp_ms=time.time_ns() // 1_000_000
            )
            == 1
        )

        methods = {
            method
            for capability, method in plugin.calls
            if capability == memory_contract.CAPABILITY_ID
        }
        assert methods == set(memory_contract.METHODS)


def test_memory_adapter_fails_closed_for_wrong_actor_scope_and_zero_vector() -> None:
    profile = EmbeddingProfile(
        model_id="test-embedding-model", profile_id="test-profile", dimensions=3
    )
    with _direct_runtime() as (plugin, client):
        provider = DirectMemoryProvider(
            client, PluginBindingSettings("grpc://127.0.0.1:51004"), profile
        )
        with pytest.raises(PersistenceError) as invalid_vector:
            provider.upsert(
                memory_id="memory-zero",
                text="must not store",
                embedding=(0.0, 0.0, 0.0),
                model=profile.model_id,
                dimensions=3,
                scope=_scope(),
                authorization_epoch=1,
            )
        assert invalid_vector.value.code == "MEMORY_EMBEDDING_INVALID"
        assert not plugin.memory_items

        provider.upsert(
            memory_id="memory-private",
            text="private actor record",
            embedding=(1.0, 0.0, 0.0),
            model=profile.model_id,
            dimensions=3,
            scope=_scope(actor_id="actor-a"),
            authorization_epoch=1,
        )
        plugin.memory_recall_cross_actor = True
        with pytest.raises(PersistenceError) as invalid_scope:
            provider.query(
                text="query",
                embedding=(1.0, 0.0, 0.0),
                model=profile.model_id,
                dimensions=3,
                scope=_scope(actor_id="actor-b"),
                limit=5,
            )
        assert invalid_scope.value.code == "MEMORY_PROVIDER_SCOPE_MISMATCH"


def test_memory_group_queries_are_partitioned_and_missing_group_id_fails_closed() -> None:
    profile = EmbeddingProfile(
        model_id="test-embedding-model", profile_id="test-profile", dimensions=3
    )
    with _direct_runtime() as (_plugin, client):
        provider = DirectMemoryProvider(
            client, PluginBindingSettings("grpc://127.0.0.1:51009"), profile
        )
        for index in range(12):
            provider.upsert(
                memory_id=f"group-a-{index}",
                text=f"Group A record {index}",
                embedding=(1.0, 0.0, 0.0),
                model=profile.model_id,
                dimensions=3,
                scope=_scope(
                    actor_id="same-actor",
                    conversation_id="group-a",
                    conversation_kind="group",
                    visibility="group",
                ),
                authorization_epoch=1,
            )
        provider.upsert(
            memory_id="group-b-target",
            text="Group B record",
            embedding=(1.0, 0.0, 0.0),
            model=profile.model_id,
            dimensions=3,
            scope=_scope(
                actor_id="same-actor",
                conversation_id="group-b",
                conversation_kind="group",
                visibility="group",
            ),
            authorization_epoch=1,
        )
        hits = provider.query(
            text="group B question",
            embedding=(1.0, 0.0, 0.0),
            model=profile.model_id,
            dimensions=3,
            scope=_scope(
                actor_id="same-actor",
                conversation_id="group-b",
                conversation_kind="group",
                visibility=None,
            ),
            limit=1,
        )
        assert [hit.memory_id for hit in hits] == ["group-b-target"]

        query_barrier = Barrier(2)

        def query_group(
            scope: MemoryProviderScope, query_text: str, limit: int
        ) -> Sequence[MemoryProviderHit]:
            query_barrier.wait(timeout=2)
            return provider.query(
                text=query_text,
                embedding=(1.0, 0.0, 0.0),
                model=profile.model_id,
                dimensions=3,
                scope=scope,
                limit=limit,
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            group_a_future = executor.submit(
                query_group,
                _scope(
                    actor_id="same-actor",
                    conversation_id="group-a",
                    conversation_kind="group",
                    visibility=None,
                ),
                "group A question",
                20,
            )
            group_b_future = executor.submit(
                query_group,
                _scope(
                    actor_id="same-actor",
                    conversation_id="group-b",
                    conversation_kind="group",
                    visibility=None,
                ),
                "group B question",
                20,
            )
            concurrent_group_a_hits = group_a_future.result(timeout=5)
            concurrent_group_b_hits = group_b_future.result(timeout=5)
        assert {hit.memory_id for hit in concurrent_group_a_hits} == {
            f"group-a-{index}" for index in range(12)
        }
        assert [hit.memory_id for hit in concurrent_group_b_hits] == ["group-b-target"]

        with pytest.raises(PersistenceError) as missing_conversation:
            provider.query(
                text="group question",
                embedding=(1.0, 0.0, 0.0),
                model=profile.model_id,
                dimensions=3,
                scope=_scope(
                    actor_id="same-actor",
                    conversation_id="",
                    conversation_kind="group",
                    visibility=None,
                ),
                limit=1,
            )
        assert missing_conversation.value.code == "MEMORY_GROUP_CONVERSATION_ID_REQUIRED"

        for conversation_id, memory_id in (
            ("direct-chat-a", "direct-a-memory"),
            ("direct-chat-b", "direct-b-memory"),
        ):
            provider.upsert(
                memory_id=memory_id,
                text="direct conversation memory",
                embedding=(1.0, 0.0, 0.0),
                model=profile.model_id,
                dimensions=3,
                scope=_scope(
                    actor_id="same-actor",
                    conversation_id=conversation_id,
                    conversation_kind="direct",
                    visibility="private",
                ),
                authorization_epoch=1,
            )
        direct_hits = provider.query(
            text="direct chat question",
            embedding=(1.0, 0.0, 0.0),
            model=profile.model_id,
            dimensions=3,
            scope=_scope(
                actor_id="same-actor",
                conversation_id=None,
                conversation_kind="direct",
                visibility=None,
            ),
            limit=5,
        )
        assert {hit.memory_id for hit in direct_hits} == {
            "direct-a-memory",
            "direct-b-memory",
        }


def test_memory_delete_requires_independent_absence_and_reconciles_unknown_result() -> None:
    profile = EmbeddingProfile(
        model_id="test-embedding-model", profile_id="test-profile", dimensions=3
    )
    selected_scope = _scope()
    with _direct_runtime() as (plugin, client):
        provider = DirectMemoryProvider(
            client, PluginBindingSettings("grpc://127.0.0.1:51010"), profile
        )

        def store(memory_id: str) -> None:
            provider.upsert(
                memory_id=memory_id,
                text="deletion reconciliation fixture",
                embedding=(1.0, 0.0, 0.0),
                model=profile.model_id,
                dimensions=3,
                scope=selected_scope,
                authorization_epoch=1,
            )

        store("delete-false")
        plugin.memory_delete_mode = "return_false"
        with pytest.raises(PersistenceError) as false_delete:
            provider.delete(memory_ids=("delete-false",), scope=selected_scope)
        assert false_delete.value.code == "MEMORY_PROVIDER_DELETE_NOT_CONFIRMED"
        assert ("org-test", "delete-false") in plugin.memory_items

        store("delete-true-but-kept")
        plugin.memory_delete_mode = "return_true_but_keep"
        with pytest.raises(PersistenceError) as stale_delete:
            provider.delete(memory_ids=("delete-true-but-kept",), scope=selected_scope)
        assert stale_delete.value.code == "MEMORY_PROVIDER_DELETE_READBACK_MISMATCH"
        assert ("org-test", "delete-true-but-kept") in plugin.memory_items

        store("delete-response-lost")
        plugin.memory_delete_mode = "remove_then_unavailable"
        delete_count = plugin.memory_delete_calls
        provider.delete(memory_ids=("delete-response-lost",), scope=selected_scope)
        assert plugin.memory_delete_calls == delete_count + 1
        provider.delete(memory_ids=("delete-response-lost",), scope=selected_scope)
        assert plugin.memory_delete_calls == delete_count + 1

        store("delete-readback-lost")
        plugin.memory_delete_mode = "remove_then_unavailable_readback"
        with pytest.raises(PersistenceError) as uncertain:
            provider.delete(memory_ids=("delete-readback-lost",), scope=selected_scope)
        assert uncertain.value.code == "MEMORY_PROVIDER_DELETE_UNCERTAIN"
        assert uncertain.value.retryable is False


def _graph_changeset(
    *,
    conversation_id: str = "conversation-test",
    conversation_kind: str = "group",
    persona_id: str | None = "persona-a",
    suffix: str = "one",
) -> dict[str, object]:
    source_ref_a = {
        "memoryId": None,
        "memoryVersion": None,
        "sourceMessageIds": [f"message-{suffix}-a"],
    }
    source_ref_b = {
        "memoryId": "memory-shared",
        "memoryVersion": 2,
        "sourceMessageIds": [f"message-{suffix}-b"],
    }
    nodes: list[dict[str, object]] = [
        {
            "id": f"person-{suffix}",
            "label": "Alice",
            "properties": {"role": "engineer", "active": True},
            "sourceMessageIds": [f"message-{suffix}-a"],
            "sourceRefs": [source_ref_a],
        },
        {
            "id": f"project-{suffix}",
            "label": "Aether",
            "properties": {"status": "active"},
            "sourceMessageIds": [f"message-{suffix}-b"],
            "sourceRefs": [source_ref_b],
        },
    ]
    edges: list[dict[str, object]] = [
        {
            "id": f"edge-{suffix}",
            "fromId": f"person-{suffix}",
            "toId": f"project-{suffix}",
            "label": "works_on",
            "properties": {"confidence": 0.9},
            "sourceMessageIds": [f"message-{suffix}-a", f"message-{suffix}-b"],
            "sourceRefs": [source_ref_a, source_ref_b],
        }
    ]
    digest_document = {
        "conversationId": conversation_id,
        "conversationKind": conversation_kind,
        "personaId": persona_id,
        "nodes": nodes,
        "edges": edges,
    }
    return {
        **digest_document,
        "digest": _graph_digest(digest_document),
    }


def test_graph_adapter_upserts_reads_back_recomputes_digest_and_preserves_sources() -> None:
    with _direct_runtime() as (plugin, client):
        graph = DirectKnowledgeGraphProvider(
            client, PluginBindingSettings("grpc://127.0.0.1:51005")
        )
        proposal = _graph_changeset()
        receipt = graph.apply_changeset(
            organization_id="org-test",
            workspace_id="workspace-test",
            actor_id="actor-test",
            changeset=proposal,
        )
        assert receipt == {
            "readbackDigest": proposal["digest"],
            "nodeCount": 2,
            "edgeCount": 1,
        }
        assert sum(method == "get_node" for _, method in plugin.calls) == 2
        assert sum(method == "get_edge" for _, method in plugin.calls) == 1

        result = graph.query(
            organization_id="org-test",
            workspace_id="workspace-test",
            actor_id="actor-test",
            conversation_id="conversation-test",
            conversation_kind="group",
            persona_id="persona-a",
            query="Alice",
            limit=10,
        )
        assert isinstance(result["items"], list)
        assert {item["itemType"] for item in result["items"]} == {"node", "edge"}
        edge = next(item for item in result["items"] if item["itemType"] == "edge")
        assert edge["sourceRefs"] == proposal["edges"][0]["sourceRefs"]
        assert edge["sourceMessageIds"] == ["message-one-a", "message-one-b"]

        isolated = graph.query(
            organization_id="org-test",
            workspace_id="workspace-test",
            actor_id="actor-test",
            conversation_id="another-group",
            conversation_kind="group",
            persona_id="persona-a",
            query="Alice",
            limit=10,
        )
        assert isolated == {"items": []}


def test_graph_adapter_rejects_changed_readback_without_committing_receipt() -> None:
    with _direct_runtime() as (plugin, client):
        graph = DirectKnowledgeGraphProvider(
            client, PluginBindingSettings("grpc://127.0.0.1:51006")
        )
        plugin.graph_readback_mutation = True
        with pytest.raises(PersistenceError) as error:
            graph.apply_changeset(
                organization_id="org-test",
                workspace_id="workspace-test",
                actor_id="actor-test",
                changeset=_graph_changeset(suffix="mutated"),
            )
        assert error.value.code == "GRAPH_PROVIDER_READBACK_MISMATCH"


def test_tool_facade_uses_frozen_pair_hmac_and_current_catalog() -> None:
    profile = ToolCallerSettings(
        binding_id="test-tool-binding",
        caller_workload="navigator-local",
        audience="cyrene.plugins.test-tool",
        issuer="cyrene://navigator-test",
        key_environment_name="CYRENE_TEST_TOOL_KEY",
        tool_ids=("media.asset.import",),
    )
    principal = PersistencePrincipal(
        actor_id="actor-test",
        workspace_ids=frozenset({"workspace-test"}),
        organization_id="org-test",
        actor_private_scope=True,
    )
    arguments = {"artifact_id": "opaque-artifact-id"}
    signer = HostTrustedCallerSigner(profile, _TOOL_KEY)
    context = signer.sign_context(
        method="media.asset.import",
        operation_id=TOOL_OPERATIONS["media.asset.import"],
        payload=arguments,
        principal=principal,
        workspace_id="workspace-test",
        binding_id=profile.binding_id,
        caller_workload=profile.caller_workload,
        audience=profile.audience,
        request_id="request-test-1",
    )
    with _direct_runtime() as (plugin, client):
        tool_client = DirectToolProviderClient(
            client,
            PluginBindingSettings("grpc://127.0.0.1:51007"),
            profile,
        )
        result = tool_client.call_tool("media.asset.import", arguments, context)
        assert result == {"asset_id": "asset-real-from-provider"}
        assert plugin.tool_arguments == arguments
        assert plugin.tool_context is not None
        assert plugin.tool_context["subject"] == "actor-test"
        assert {
            method for capability, method in plugin.calls if capability == "tool.provider.v1"
        } == {
            METHOD_LIST_TOOLS,
            METHOD_CALL_TOOL,
        }


def test_host_signer_uses_the_frozen_bilibili_pair_and_environment_key_reference() -> None:
    profile = ToolCallerSettings(
        binding_id="test-bilibili-binding",
        caller_workload="navigator-local",
        audience="cyrene.plugins.bilibili",
        issuer="cyrene://navigator-test",
        key_environment_name="CYRENE_TEST_BILIBILI_KEY",
        tool_ids=("bilibili.search",),
    )
    principal = PersistencePrincipal(
        actor_id="actor-test",
        workspace_ids=frozenset({"workspace-test"}),
        organization_id="org-test",
        actor_private_scope=True,
    )
    signer = build_host_trusted_caller_signer(
        profile, {profile.key_environment_name: _TOOL_KEY.hex()}
    )
    arguments = {"keyword": "test"}
    context = signer.sign_context(
        method="bilibili.search",
        operation_id=TOOL_OPERATIONS["bilibili.search"],
        payload=arguments,
        principal=principal,
        workspace_id="workspace-test",
        binding_id=profile.binding_id,
        caller_workload=profile.caller_workload,
        audience=profile.audience,
        request_id="bilibili-read-1",
    )
    assert verify_context(
        method="bilibili.search",
        operation_id=TOOL_OPERATIONS["bilibili.search"],
        payload=arguments,
        context=context,
        key=_TOOL_KEY,
        expected_caller_workload=profile.caller_workload,
        expected_audience=profile.audience,
        expected_binding_id=profile.binding_id,
        expected_organization_id="org-test",
        expected_workspace_id="workspace-test",
        expected_issuer=profile.issuer,
        expected_subject="actor-test",
    )


def test_speech_facade_forwards_real_bytes_and_reports_provider_errors() -> None:
    profile = SpeechProfile(enabled=True, default_language_hint="en")
    with _direct_runtime() as (plugin, client):
        speech = DirectSpeechProvider(
            client,
            PluginBindingSettings("grpc://127.0.0.1:51008"),
            profile,
        )
        principal = PersistencePrincipal(
            actor_id="actor-test",
            workspace_ids=frozenset({"workspace-test"}),
            organization_id="org-test",
        )
        result = speech.transcribe(
            data=b"actual-authorized-audio-bytes",
            mime_type="audio/wav",
            language_hint=None,
            principal=principal,
            workspace_id="workspace-test",
            request_id="speech-request-1",
        )
        assert result["text"] == "transcript from the test provider"
        assert plugin.speech_input == (b"actual-authorized-audio-bytes", "audio/wav", "en")
        assert (
            speech.status(principal=principal, workspace_id="workspace-test")["available"] is True
        )

        plugin.speech_fails = True
        with pytest.raises(Exception) as error:
            speech.transcribe(
                data=b"actual-authorized-audio-bytes",
                mime_type="audio/wav",
                language_hint="en",
                principal=principal,
                workspace_id="workspace-test",
                request_id="speech-request-2",
            )
        assert error.value.code == "SPEECH_PROVIDER_ERROR_4"


def test_missing_endpoints_are_typed_unavailable_and_e5_profile_is_strict() -> None:
    bundle = build_conversation_capabilities(environment={})
    try:
        assert bundle.embedding_client is None
        assert bundle.memory_provider is None
        assert bundle.knowledge_graph_provider is None
        assert bundle.tool_provider_client is None
        assert bundle.speech_provider is None
        assert bundle.unavailable["memory.provider.v1"] == "NOT_CONFIGURED"
        assert bundle.unavailable["model.provider.v1 embeddings"] == "MODEL_BINDING_UNAVAILABLE"
    finally:
        bundle.close()
    with pytest.raises(CapabilityConfigurationError, match="distinct passage and query prefixes"):
        EmbeddingProfile(
            model_id="intfloat/multilingual-e5-small",
            profile_id="e5-profile",
            dimensions=384,
            document_prefix="query: ",
            query_prefix="query: ",
        )
