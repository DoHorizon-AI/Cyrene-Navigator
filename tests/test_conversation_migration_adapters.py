"""Exercise concrete canonical-store, WorkStore, and Direct graph adapters."""

from __future__ import annotations

import hashlib
import io
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest
from cyrene_knowledge_graph_contracts import (
    RESPONSE_TYPE_URLS,
    decode_request,
)
from cyrene_knowledge_graph_contracts import knowledge_graph_pb2 as graph_wire
from cyrene_plugin_runtime import DirectPayload

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.work.conversation_capabilities.config import PluginBindingSettings
from cyrene_navigator.work.conversation_capabilities.knowledge_graph import (
    DirectKnowledgeGraphProvider,
)
from cyrene_navigator.work.conversation_memory.domains import ConversationDomainStore
from cyrene_navigator.work.conversation_memory.store import ConversationMemoryStore
from cyrene_navigator.work.conversation_migration import (
    ActorBackupSource,
    ActorScope,
    AuthorizedConversationContext,
    ConversationMigrationService,
    DirectGraphCompensator,
    JsonLinesMigrationSource,
    MigrationError,
    MigrationSettings,
    build_actor_backup,
)
from cyrene_navigator.work.conversation_migration.adapters import (
    CanonicalGraphAdapter,
    CanonicalMemoryAdapter,
    CanonicalProfileAdapter,
    ConversationMigrationHost,
    WorkStoreOperationAdapter,
    WorkStoreTaskProgressAdapter,
    build_conversation_migration_host,
)
from cyrene_navigator.work.conversation_migration.ports import AuthorizationDecision
from cyrene_navigator.work.conversation_migration.records import canonical_json
from cyrene_navigator.work.store import WorkStore

SCOPE = ActorScope("adapter-org", "adapter-workspace", "adapter-actor")
CONTEXT = AuthorizedConversationContext("adapter-conversation", "direct", None)


class _GraphRuntimePeer:
    """Small stateful protocol peer for exercising production Direct graph adapters."""

    def __init__(self) -> None:
        self.nodes: dict[tuple[str, str, str], Any] = {}
        self.edges: dict[tuple[str, str, str], Any] = {}
        self.upsert_count = 0

    def invoke(
        self,
        *,
        capability: str,
        interface_version: str,
        method: str,
        request: DirectPayload,
        deadline_seconds: float,
    ) -> DirectPayload:
        assert capability == "knowledge.graph.v1"
        assert interface_version == "1"
        assert deadline_seconds > 0
        value = decode_request(method, request.value)
        response = self._dispatch(method, value)
        return DirectPayload(
            type_url=RESPONSE_TYPE_URLS[method],
            value=response.SerializeToString(deterministic=True),
        )

    def _dispatch(self, method: str, request: Any) -> Any:
        if method == "upsert_nodes":
            for node in request.nodes:
                stored = graph_wire.GraphNode()
                stored.CopyFrom(node)
                self.nodes[(node.tenant_id, node.namespace, node.node_id)] = stored
            self.upsert_count += len(request.nodes)
            return graph_wire.UpsertNodesResponse(upserted_count=len(request.nodes))
        if method == "upsert_edges":
            for edge in request.edges:
                stored = graph_wire.GraphEdge()
                stored.CopyFrom(edge)
                self.edges[(edge.tenant_id, edge.namespace, edge.edge_id)] = stored
            self.upsert_count += len(request.edges)
            return graph_wire.UpsertEdgesResponse(upserted_count=len(request.edges))
        if method == "get_node":
            response = graph_wire.GetNodeResponse()
            node = self.nodes.get((request.tenant_id, request.namespace, request.node_id))
            if node is None:
                response.error.code = graph_wire.KNOWLEDGE_GRAPH_ERROR_CODE_NOT_FOUND
            else:
                response.node.CopyFrom(node)
            return response
        if method == "get_edge":
            response = graph_wire.GetEdgeResponse()
            edge = self.edges.get((request.tenant_id, request.namespace, request.edge_id))
            if edge is None:
                response.error.code = graph_wire.KNOWLEDGE_GRAPH_ERROR_CODE_NOT_FOUND
            else:
                response.edge.CopyFrom(edge)
            return response
        if method == "delete_edge":
            key = (request.tenant_id, request.namespace, request.edge_id)
            return graph_wire.DeleteEdgeResponse(deleted=self.edges.pop(key, None) is not None)
        if method == "delete_node":
            key = (request.tenant_id, request.namespace, request.node_id)
            return graph_wire.DeleteNodeResponse(deleted=self.nodes.pop(key, None) is not None)
        raise AssertionError(f"unexpected graph method {method}")


def _graph_changeset() -> dict[str, object]:
    """Build one exact source-bound node/edge changeset for provider RPCs."""

    source_refs = [{"memoryId": None, "memoryVersion": None, "sourceMessageIds": ["source-1"]}]
    body: dict[str, object] = {
        "conversationId": CONTEXT.conversation_id,
        "conversationKind": CONTEXT.conversation_kind,
        "personaId": CONTEXT.persona_id,
        "nodes": [
            {
                "id": "node-1",
                "label": "Synthetic entity",
                "properties": {"category": "fixture"},
                "sourceMessageIds": ["source-1"],
                "sourceRefs": source_refs,
            },
            {
                "id": "node-2",
                "label": "Synthetic relation target",
                "properties": {},
                "sourceMessageIds": ["source-1"],
                "sourceRefs": source_refs,
            },
        ],
        "edges": [
            {
                "id": "edge-1",
                "fromId": "node-1",
                "toId": "node-2",
                "label": "related_to",
                "properties": {"weight": 1},
                "sourceMessageIds": ["source-1"],
                "sourceRefs": source_refs,
            }
        ],
    }
    body["digest"] = hashlib.sha256(canonical_json(body)).hexdigest()
    return body


def test_direct_graph_write_readback_and_compensation_are_exact_and_idempotent() -> None:
    """The typed Direct client proves exact content, read-only replay, and delete readback."""

    peer = _GraphRuntimePeer()
    binding = PluginBindingSettings("grpc://127.0.0.1:18777")
    provider = DirectKnowledgeGraphProvider(peer, binding)  # type: ignore[arg-type]
    compensator = DirectGraphCompensator(peer, binding)  # type: ignore[arg-type]
    changeset = _graph_changeset()

    assert compensator.inspect_projection(SCOPE, changeset) == {"state": "absent"}
    applied = provider.apply_changeset(
        organization_id=str(SCOPE.organization_id),
        workspace_id=SCOPE.workspace_id,
        actor_id=SCOPE.actor_id,
        changeset=changeset,
    )
    assert applied == {"readbackDigest": changeset["digest"], "nodeCount": 2, "edgeCount": 1}
    writes_after_apply = peer.upsert_count

    current = compensator.verify_projection(SCOPE, changeset)
    assert current == applied
    assert compensator.inspect_projection(SCOPE, changeset) == {
        "state": "exact",
        **applied,
    }
    assert peer.upsert_count == writes_after_apply

    receipt = compensator.delete_changeset(
        SCOPE, changeset, operation_id="stable-graph-rollback-operation"
    )
    assert receipt["requestDigest"] == changeset["digest"]
    assert receipt["nodeCount"] == 2
    assert receipt["edgeCount"] == 1
    assert peer.nodes == {}
    assert peer.edges == {}
    assert (
        compensator.verify_absent(SCOPE, changeset, operation_id="stable-graph-rollback-operation")
        == receipt
    )
    assert compensator.inspect_projection(SCOPE, changeset) == {"state": "absent"}


class _FailOnceGraphApply:
    """Inject process loss after the real provider write and before domain receipt CAS."""

    def __init__(self, store: ConversationDomainStore) -> None:
        self._store = store
        self._fail = True

    def __getattr__(self, name: str) -> Any:
        return getattr(self._store, name)

    def apply_graph_changeset(self, *args: object, **kwargs: object) -> Any:
        if self._fail:
            self._fail = False
            raise RuntimeError("synthetic interruption after graph provider readback")
        return self._store.apply_graph_changeset(*args, **kwargs)


def test_graph_adapter_recovers_exact_provider_write_after_domain_commit_interruption(
    tmp_path: Path,
) -> None:
    """A proposed exact changeset resumes idempotently and later reads provider state only."""

    domains = ConversationDomainStore(tmp_path / "graph-recovery.sqlite")
    peer = _GraphRuntimePeer()
    binding = PluginBindingSettings("grpc://127.0.0.1:18778")
    provider = DirectKnowledgeGraphProvider(peer, binding)  # type: ignore[arg-type]
    compensator = DirectGraphCompensator(peer, binding)  # type: ignore[arg-type]
    graph = _graph_changeset()
    body = {key: value for key, value in graph.items() if key != "digest"}
    body["idempotencyKey"] = "graph-migration-recovery-key"
    interrupted = CanonicalGraphAdapter(
        _FailOnceGraphApply(domains),
        provider,
        compensator,  # type: ignore[arg-type]
    )

    try:
        interrupted.project_changeset(SCOPE, body, operation_id="operation-graph-recovery")
    except RuntimeError as error:
        assert "synthetic interruption" in str(error)
    else:
        raise AssertionError("the fixture must interrupt after provider readback")

    assert len(peer.nodes) == 2
    assert len(peer.edges) == 1
    writes_before_restart = peer.upsert_count
    restarted = CanonicalGraphAdapter(domains, provider, compensator)
    applied = restarted.project_changeset(SCOPE, body, operation_id="operation-graph-recovery")
    assert applied["state"] == "projected"
    assert applied["digest"] == graph["digest"]
    writes_after_recovery = peer.upsert_count

    current = restarted.get_changeset(SCOPE, str(applied["id"]))

    assert current is not None
    assert current["state"] == "projected"
    assert peer.upsert_count == writes_before_restart == writes_after_recovery


def test_graph_adapter_does_not_replay_partial_provider_state(tmp_path: Path) -> None:
    """An ambiguous partial graph write fails closed without issuing another upsert."""

    domains = ConversationDomainStore(tmp_path / "graph-partial.sqlite")
    peer = _GraphRuntimePeer()
    binding = PluginBindingSettings("grpc://127.0.0.1:18779")
    provider = DirectKnowledgeGraphProvider(peer, binding)  # type: ignore[arg-type]
    compensator = DirectGraphCompensator(peer, binding)  # type: ignore[arg-type]
    graph = _graph_changeset()
    body = {key: value for key, value in graph.items() if key != "digest"}
    body["idempotencyKey"] = "graph-migration-partial-recovery-key"
    proposal = domains.upsert_graph_entities(
        str(SCOPE.organization_id), SCOPE.workspace_id, SCOPE.actor_id, body
    )
    provider.apply_changeset(
        organization_id=str(SCOPE.organization_id),
        workspace_id=SCOPE.workspace_id,
        actor_id=SCOPE.actor_id,
        changeset=proposal,
    )
    first_node_id = str(proposal["nodes"][0]["id"])
    first_node_key = next(key for key in peer.nodes if key[2] == first_node_id)
    del peer.nodes[first_node_key]
    writes_before_reconciliation = peer.upsert_count

    with pytest.raises(PersistenceError) as error:
        CanonicalGraphAdapter(domains, provider, compensator).project_changeset(
            SCOPE, body, operation_id="operation-graph-partial-recovery"
        )

    assert error.value.code == "GRAPH_PROVIDER_RECONCILIATION_REQUIRED"
    assert peer.upsert_count == writes_before_reconciliation
    assert (
        domains.get_graph_changeset(
            str(SCOPE.organization_id), SCOPE.workspace_id, SCOPE.actor_id, str(proposal["id"])
        )["state"]
        == "proposed"
    )


def test_work_store_adapters_persist_operation_and_task_checkpoint(tmp_path: Path) -> None:
    """The host adapters use the existing actor-private Work Task and Operation APIs."""

    store = WorkStore(tmp_path / "work.sqlite")
    task_id = "migration-adapter-task"
    store.create_task(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        {"id": task_id, "sessionId": "migration-session", "prompt": "fixture"},
        actor_id=SCOPE.actor_id,
        actor_private_scope=True,
    )
    store.claim_task(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        task_id,
        actor_id=SCOPE.actor_id,
        actor_private_scope=True,
    )
    operations = WorkStoreOperationAdapter(store)
    operation = operations.begin(
        SCOPE,
        task_id=task_id,
        idempotency_key="migration-operation-adapter-key",
        operation_type="navigator.conversation_migration.message.project",
        request={"recordDigest": "a" * 64},
    )
    assert operation.status == "started"
    verified = operations.complete(
        SCOPE,
        task_id=task_id,
        operation_id=operation.operation_id,
        evidence={"readbackSha256": "b" * 64},
    )
    assert verified.status == "verified"
    assert operations.get(SCOPE, task_id=task_id, operation_id=operation.operation_id).evidence == {
        "readbackSha256": "b" * 64
    }

    progress = WorkStoreTaskProgressAdapter(store)
    progress.append_checkpoint(
        SCOPE,
        task_id=task_id,
        event_id="migration-checkpoint-event-0",
        event={"migrationEvent": "record", "batchId": "batch-a", "ordinal": 0},
    )
    for ordinal in range(1, 206):
        progress.append_checkpoint(
            SCOPE,
            task_id=task_id,
            event_id=f"migration-checkpoint-event-{ordinal}",
            event={"migrationEvent": "record", "batchId": "batch-a", "ordinal": ordinal},
        )
    all_events: list[Mapping[str, object]] = []
    cursor = 0
    while True:
        events, next_cursor = progress.list_checkpoints(
            SCOPE,
            task_id=task_id,
            batch_id="batch-a",
            after_sequence=cursor,
            limit=50,
        )
        all_events.extend(events)
        if next_cursor <= cursor:
            break
        cursor = next_cursor
    assert len(all_events) == 206
    assert [event["ordinal"] for event in all_events] == list(range(206))


def test_canonical_memory_and_profile_adapters_use_actor_scoped_public_stores(
    tmp_path: Path,
) -> None:
    """Memory tombstones and profile CAS transitions read back from real SQLite stores."""

    database = tmp_path / "canonical-adapters.sqlite"
    memory_store = ConversationMemoryStore(database)
    domain_store = ConversationDomainStore(database)
    memory = CanonicalMemoryAdapter(memory_store)
    profiles = CanonicalProfileAdapter(domain_store)

    message_reply = memory.create_message(
        SCOPE,
        {
            "eventId": "canonical-adapter-message",
            "conversationId": CONTEXT.conversation_id,
            "conversationKind": CONTEXT.conversation_kind,
            "personaId": CONTEXT.persona_id,
            "visibility": "private",
            "role": "user",
            "content": "Synthetic source message.",
            "occurredAt": 1_700_000_000_000,
            "sourceRefs": [],
            "attachments": [],
            "relatedEventIds": [],
        },
    )
    message_id = str(message_reply["id"])
    assert memory.get_message(SCOPE, message_id, context=CONTEXT)["id"] == message_id

    memory_reply = memory.create_memory(
        SCOPE,
        {
            "idempotencyKey": "canonical-adapter-memory",
            "conversationId": CONTEXT.conversation_id,
            "conversationKind": CONTEXT.conversation_kind,
            "personaId": CONTEXT.persona_id,
            "kind": "preference",
            "text": "Synthetic preference.",
            "sourceMessageIds": [message_id],
            "sourceRefs": [],
            "visibility": "private",
            "validUntil": None,
        },
    )
    memory_id = str(memory_reply["id"])
    assert memory.get_memory(SCOPE, memory_id)["state"] == "active"

    candidate = profiles.create_candidate(
        SCOPE,
        {
            "idempotencyKey": "canonical-adapter-profile",
            "conversationId": CONTEXT.conversation_id,
            "conversationKind": CONTEXT.conversation_kind,
            "personaId": CONTEXT.persona_id,
            "subjectKind": "user",
            "category": "preference",
            "text": "Synthetic sourced profile.",
            "confidence": 0.8,
            "sourceMessageIds": [message_id],
            "sourceRefs": [],
            "validUntil": None,
        },
    )
    candidate_id = str(candidate["id"])
    activated = profiles.activate_candidate(SCOPE, candidate_id, 1)
    profile_id = str(activated["id"])
    assert profiles.get_profile(SCOPE, profile_id)["state"] == "active"
    rolled_profile = profiles.rollback_profile(SCOPE, profile_id, 1)
    assert rolled_profile["state"] == "rolled_back"
    assert profiles.get_candidate(SCOPE, candidate_id)["state"] == "rolled_back"

    memory.delete_memory(SCOPE, memory_id, int(memory_reply["version"]))
    tombstone = memory.get_memory(SCOPE, memory_id, include_deleted=True)
    assert tombstone is not None
    assert tombstone["state"] == "deleted"
    memory.revoke_message(SCOPE, message_id)
    revoked = memory.get_message(SCOPE, message_id, context=CONTEXT, include_revoked=True)
    assert revoked is not None
    assert revoked["status"] == "revoked"


class _RestoreAuthorization:
    """Test-only current host scope and source authorization for SQLite restore fixtures."""

    def __init__(self, memory: ConversationMemoryStore, artifact_id: str, digest: str) -> None:
        self._memory = memory
        self._artifact_id = artifact_id
        self._digest = digest

    def authorize_artifact(self, scope: ActorScope, artifact_id: str, sha256: str) -> bool:
        return scope == SCOPE and artifact_id == self._artifact_id and sha256 == self._digest

    def resolve_conversation_context(
        self,
        scope: ActorScope,
        *,
        artifact_id: str,
        source_conversation_id: str,
        source_conversation_kind: str,
        source_persona_id: str | None,
    ) -> AuthorizedConversationContext | None:
        if (
            scope != SCOPE
            or artifact_id != self._artifact_id
            or source_conversation_kind != "direct"
            or source_conversation_id != "legacy-adapter-conversation"
        ):
            return None
        return CONTEXT

    def authorize_staged_record(
        self,
        scope: ActorScope,
        *,
        artifact_id: str,
        artifact_sha256: str,
        record: object,
    ) -> AuthorizationDecision:
        del record
        return AuthorizationDecision(
            scope == SCOPE and artifact_id == self._artifact_id and artifact_sha256 == self._digest,
            int(
                self._memory.overview(SCOPE.organization_id, SCOPE.workspace_id, SCOPE.actor_id)[
                    "authorizationEpoch"
                ]
            ),
        )

    def authorize_source_refs(
        self,
        scope: ActorScope,
        *,
        conversation_id: str,
        conversation_kind: str,
        persona_id: str | None,
        source_refs: Sequence[Mapping[str, object]],
    ) -> AuthorizationDecision:
        overview = self._memory.overview(scope.organization_id, scope.workspace_id, scope.actor_id)
        epoch = int(overview["authorizationEpoch"])
        result = self._memory.authorize_sources(
            scope.organization_id,
            scope.workspace_id,
            scope.actor_id,
            conversation_id,
            epoch,
            source_refs,
            conversation_kind=conversation_kind,
            persona_id=persona_id,
        )
        return AuthorizationDecision(
            bool(result["allowed"]),
            int(result["currentAuthorizationEpoch"]),
            None if result["allowed"] else "source_authorization_denied",
        )

    def approve_profile_activation(
        self, scope: ActorScope, approval_ref: str | None, record_digest: str
    ) -> bool:
        return scope == SCOPE and approval_ref == "profile-approved" and len(record_digest) == 64

    def approve_graph_projection(
        self, scope: ActorScope, approval_ref: str | None, record_digest: str
    ) -> bool:
        del scope, approval_ref, record_digest
        return False

    def approve_import(self, scope: ActorScope, approval_ref: str | None, plan_sha256: str) -> bool:
        return scope == SCOPE and approval_ref == "import-approved" and len(plan_sha256) == 64

    def approve_rollback(self, scope: ActorScope, batch_id: str, plan_sha256: str) -> bool:
        return scope == SCOPE and batch_id.startswith("conversation-migration-")


class _FixtureCompensationCapabilities:
    """Only lets this integration fixture exercise writes before rollback API delivery."""

    def missing_capabilities(self, scope: ActorScope, *, required: Sequence[str]) -> Sequence[str]:
        assert scope == SCOPE
        assert required
        return ()


class _FailAfterProfileActivation(WorkStoreOperationAdapter):
    """Simulate process loss after profile activation but before operation verification."""

    def __init__(self, store: WorkStore) -> None:
        super().__init__(store)
        self._failed = False

    def complete(self, scope: ActorScope, **kwargs: Any) -> Any:
        evidence = kwargs.get("evidence")
        if (
            not self._failed
            and isinstance(evidence, Mapping)
            and evidence.get("projectionKind") == "profile_active"
        ):
            self._failed = True
            raise RuntimeError("synthetic process loss after profile activation")
        return super().complete(scope, **kwargs)  # type: ignore[arg-type]


def test_fresh_sqlite_restore_reconciles_profile_activation_after_process_loss(
    tmp_path: Path,
) -> None:
    """A committed profile activation is discovered by key/readback, never duplicated."""

    source_path = tmp_path / "profile-source.sqlite"
    source_memory = ConversationMemoryStore(source_path)
    source_domains = ConversationDomainStore(source_path)
    source_message = source_memory.create_message(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        SCOPE.actor_id,
        {
            "eventId": "profile-source-message",
            "conversationId": "legacy-adapter-conversation",
            "conversationKind": "direct",
            "visibility": "private",
            "role": "user",
            "content": "Synthetic source for profile recovery.",
            "occurredAt": 1_700_000_000_000,
        },
    )["message"]
    source_memory.create_memory(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        SCOPE.actor_id,
        {
            "idempotencyKey": "profile-recovery-source-memory",
            "conversationId": "legacy-adapter-conversation",
            "conversationKind": "direct",
            "kind": "preference",
            "text": "Synthetic memory in the same restore.",
            "sourceMessageIds": [source_message["id"]],
            "sourceRefs": [],
            "visibility": "private",
        },
    )
    source_domains.create_profile_candidate(
        str(SCOPE.organization_id),
        SCOPE.workspace_id,
        SCOPE.actor_id,
        {
            "idempotencyKey": "profile-source-candidate",
            "conversationId": "legacy-adapter-conversation",
            "conversationKind": "direct",
            "subjectKind": "user",
            "category": "preference",
            "text": "Synthetic durable profile.",
            "confidence": 0.9,
            "sourceMessageIds": [source_message["id"]],
            "sourceRefs": [],
        },
    )
    backup = build_actor_backup(
        SCOPE,
        source_memory.export_actor_backup(
            SCOPE.organization_id, SCOPE.workspace_id, SCOPE.actor_id
        ),
        source_domains.export_actor_backup(
            str(SCOPE.organization_id), SCOPE.workspace_id, SCOPE.actor_id
        ),
        created_at=1_700_000_000_010,
    )

    target_path = tmp_path / "profile-target.sqlite"
    target_memory = ConversationMemoryStore(target_path)
    target_domains = ConversationDomainStore(target_path)
    work = WorkStore(target_path)
    task_id = "profile-activation-recovery-task"
    work.create_task(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        {"id": task_id, "sessionId": "profile-recovery", "prompt": "restore fixture"},
        actor_id=SCOPE.actor_id,
        actor_private_scope=True,
    )
    work.claim_task(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        task_id,
        actor_id=SCOPE.actor_id,
        actor_private_scope=True,
    )
    artifact_id = "profile-recovery-artifact"
    authorization = _RestoreAuthorization(target_memory, artifact_id, backup.sha256)

    def service(operations: WorkStoreOperationAdapter) -> ConversationMigrationService:
        return ConversationMigrationService(
            authorization=authorization,
            memory=CanonicalMemoryAdapter(target_memory),
            profiles=CanonicalProfileAdapter(target_domains),
            graph=CanonicalGraphAdapter(target_domains, None, None),
            rollback_capabilities=_FixtureCompensationCapabilities(),  # type: ignore[arg-type]
            operations=operations,
            progress=WorkStoreTaskProgressAdapter(work),
            settings=MigrationSettings(max_page_records=1),
        )

    with pytest.raises(RuntimeError, match="after profile activation"):
        service(_FailAfterProfileActivation(work)).restore_backup(
            SCOPE,
            task_id=task_id,
            artifact_id=artifact_id,
            content=backup.content,
            expected_sha256=backup.sha256,
            approval_ref="import-approved",
            profile_approval_ref="profile-approved",
        )

    active_before = target_domains.list_profiles(
        str(SCOPE.organization_id),
        SCOPE.workspace_id,
        SCOPE.actor_id,
        CONTEXT.conversation_id,
        state="active",
    )
    assert len(active_before) == 1

    restarted = service(WorkStoreOperationAdapter(WorkStore(target_path)))
    receipt = restarted.restore_backup(
        SCOPE,
        task_id=task_id,
        artifact_id=artifact_id,
        content=backup.content,
        expected_sha256=backup.sha256,
        approval_ref="import-approved",
        profile_approval_ref="profile-approved",
    )
    assert receipt.status == "applied"
    assert receipt.projected_count == 3
    assert target_memory.overview(SCOPE.organization_id, SCOPE.workspace_id, SCOPE.actor_id)[
        "counts"
    ] == {"messages": 1, "memories": 1, "sources": 1}
    active_after = target_domains.list_profiles(
        str(SCOPE.organization_id),
        SCOPE.workspace_id,
        SCOPE.actor_id,
        CONTEXT.conversation_id,
        state="active",
    )
    assert len(active_after) == 1
    assert active_after[0]["text"] == "Synthetic durable profile."

    replay = restarted.restore_backup(
        SCOPE,
        task_id=task_id,
        artifact_id=artifact_id,
        content=backup.content,
        expected_sha256=backup.sha256,
        approval_ref="import-approved",
        profile_approval_ref="profile-approved",
    )
    assert replay.status == "applied"
    assert (
        len(
            target_domains.list_profiles(
                str(SCOPE.organization_id),
                SCOPE.workspace_id,
                SCOPE.actor_id,
                CONTEXT.conversation_id,
                state="active",
            )
        )
        == 1
    )


def test_mount_factory_exports_only_the_portable_actor_backup_subset(tmp_path: Path) -> None:
    """The mount factory restores and rolls back through canonical stores and WorkStore."""

    memory_store = ConversationMemoryStore(tmp_path / "portable.sqlite")
    domain_store = ConversationDomainStore(tmp_path / "portable.sqlite")
    work_store = WorkStore(tmp_path / "portable.sqlite")
    memory_store.create_message(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        SCOPE.actor_id,
        {
            "eventId": "portable-fixture-message",
            "conversationId": "legacy-adapter-conversation",
            "conversationKind": CONTEXT.conversation_kind,
            "visibility": "private",
            "role": "user",
            "content": "Synthetic adapter fixture.",
            "occurredAt": 1_700_000_000_000,
        },
    )
    export_host = build_conversation_migration_host(
        memory_store=memory_store,
        domain_store=domain_store,
        work_store=work_store,
        authorization=object(),  # type: ignore[arg-type]
    )
    backup = export_host.create_actor_backup(SCOPE, created_at=1_700_000_000_100)

    assert backup.record_counts == {"message": 1}
    assert backup.quarantined_count == 0

    artifact_id = "portable-real-artifact"
    authorization = _RestoreAuthorization(memory_store, artifact_id, backup.sha256)
    host = build_conversation_migration_host(
        memory_store=memory_store,
        domain_store=domain_store,
        work_store=work_store,
        authorization=authorization,
    )
    assert isinstance(host, ConversationMigrationHost)
    task_id = "portable-real-restore-task"
    work_store.create_task(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        {"id": task_id, "sessionId": "portable-session", "prompt": "restore fixture"},
        actor_id=SCOPE.actor_id,
        actor_private_scope=True,
    )
    work_store.claim_task(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        task_id,
        actor_id=SCOPE.actor_id,
        actor_private_scope=True,
    )
    restored_backup, preview = host.service.preview_backup(
        SCOPE,
        artifact_id=artifact_id,
        content=backup.content,
        expected_sha256=backup.sha256,
    )
    source = ActorBackupSource(restored_backup, artifact_id=artifact_id)
    receipt = host.service.restore_backup(
        SCOPE,
        task_id=task_id,
        artifact_id=artifact_id,
        content=backup.content,
        expected_sha256=backup.sha256,
        approval_ref="import-approved",
    )
    assert receipt.projected_count == 1

    rolled_back = host.service.rollback(SCOPE, task_id=task_id, source=source, preview=preview)
    assert rolled_back.status == "rolled_back"
    replay = host.service.rollback(SCOPE, task_id=task_id, source=source, preview=preview)
    assert replay.status == "rolled_back"
    messages = memory_store.list_messages(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        SCOPE.actor_id,
        CONTEXT.conversation_id,
        conversation_kind=CONTEXT.conversation_kind,
        order="asc",
        limit=10,
        include_revoked=True,
    )["items"]
    imported_id = next(
        str(item["id"]) for item in messages if item["content"] == "Synthetic adapter fixture."
    )
    imported = CanonicalMemoryAdapter(memory_store).get_message(
        SCOPE,
        imported_id,
        context=CONTEXT,
        include_revoked=True,
    )
    assert imported is not None
    assert imported["status"] == "revoked"


@pytest.mark.parametrize("record_kind", ["profile", "graph"])
def test_mount_factory_fails_closed_before_message_write_when_later_kind_lacks_rollback(
    tmp_path: Path, record_kind: str
) -> None:
    """Production capability preflight prevents partial writes for unrollbackable plans."""

    database = tmp_path / f"missing-{record_kind}-rollback.sqlite"
    memory_store = ConversationMemoryStore(database)
    domain_store = ConversationDomainStore(database)
    work_store = WorkStore(database)
    rows: list[dict[str, object]] = [
        {
            "recordType": "message",
            "recordId": "message-record-1",
            "conversationId": "legacy-adapter-conversation",
            "conversationKind": "direct",
            "personaId": None,
            "visibility": "private",
            "sourceRecordIds": [],
            "validUntil": None,
            "role": "user",
            "content": "Synthetic preflight source.",
            "occurredAt": 1_700_000_000_000,
        }
    ]
    if record_kind == "profile":
        rows.append(
            {
                "recordType": "profile",
                "recordId": "profile-record-1",
                "conversationId": "legacy-adapter-conversation",
                "conversationKind": "direct",
                "personaId": None,
                "visibility": "private",
                "sourceRecordIds": ["message-record-1"],
                "validUntil": None,
                "subjectKind": "user",
                "category": "preference",
                "text": "Synthetic profile candidate.",
                "confidence": 0.9,
            }
        )
    else:
        rows.append(
            {
                "recordType": "graph",
                "recordId": "graph-record-1",
                "conversationId": "legacy-adapter-conversation",
                "conversationKind": "direct",
                "personaId": None,
                "visibility": "private",
                "sourceRecordIds": ["message-record-1"],
                "validUntil": None,
                "nodes": [
                    {
                        "id": "node-1",
                        "label": "Synthetic graph node",
                        "sourceRecordIds": ["message-record-1"],
                    }
                ],
                "edges": [],
            }
        )
    content = (
        b"\n".join(
            [
                json.dumps(
                    {
                        "recordType": "header",
                        "schemaVersion": 1,
                        "sourceKind": "test.fixture",
                        "recordCount": len(rows),
                    },
                    separators=(",", ":"),
                ).encode(),
                *(json.dumps(row, separators=(",", ":")).encode() for row in rows),
            ]
        )
        + b"\n"
    )
    artifact_id = f"missing-{record_kind}-artifact"
    artifact_digest = hashlib.sha256(content).hexdigest()
    source = JsonLinesMigrationSource(
        io.BytesIO(content), artifact_id=artifact_id, expected_sha256=artifact_digest
    )
    authorization = _RestoreAuthorization(memory_store, artifact_id, artifact_digest)
    host = build_conversation_migration_host(
        memory_store=memory_store,
        domain_store=domain_store,
        work_store=work_store,
        authorization=authorization,
    )
    task_id = f"missing-{record_kind}-rollback-task"
    work_store.create_task(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        {"id": task_id, "sessionId": f"missing-{record_kind}", "prompt": "fixture"},
        actor_id=SCOPE.actor_id,
        actor_private_scope=True,
    )
    work_store.claim_task(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        task_id,
        actor_id=SCOPE.actor_id,
        actor_private_scope=True,
    )
    preview = host.service.preview(SCOPE, source)

    with pytest.raises(MigrationError) as error:
        host.service.apply(
            SCOPE,
            task_id=task_id,
            source=source,
            preview=preview,
            approval_ref="import-approved",
            profile_approval_ref=("profile-approved" if record_kind == "profile" else None),
        )

    assert error.value.code == "ROLLBACK_CAPABILITY_UNAVAILABLE"
    assert memory_store.overview(SCOPE.organization_id, SCOPE.workspace_id, SCOPE.actor_id)[
        "counts"
    ] == {"messages": 0, "memories": 0, "sources": 0}
