"""Exercise actor backup restore, task recovery, and rollback against real SQLite stores."""

from __future__ import annotations

import hashlib
import importlib
import inspect
import io
import json
import os
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest

from cyrene_navigator.work.conversation_migration import (
    ActorScope,
    AuthorizedConversationContext,
    ConversationMigrationService,
    JsonLinesMigrationSource,
    MigrationError,
    MigrationRecord,
    MigrationSettings,
    build_actor_backup,
)
from cyrene_navigator.work.conversation_migration.ports import (
    AuthorizationDecision,
    OperationHandle,
)
from cyrene_navigator.work.store import WorkStore

SCOPE = ActorScope("migration-org", "migration-workspace", "migration-actor")
CONTEXT = AuthorizedConversationContext("current-conversation", "direct", None)


def _conversation_memory_types() -> tuple[type[Any], type[Any]]:
    """Load current core stores from the repository or an explicit active-core source path."""

    candidate_src = os.environ.get("CYRENE_NAVIGATOR_CORE_SOURCE")
    if candidate_src:
        work_path = Path(candidate_src).resolve() / "cyrene_navigator" / "work"
        import cyrene_navigator.work as work_package

        if work_path.is_dir() and str(work_path) not in work_package.__path__:
            work_package.__path__.append(str(work_path))
    try:
        memory_module = importlib.import_module("cyrene_navigator.work.conversation_memory.store")
        domains_module = importlib.import_module(
            "cyrene_navigator.work.conversation_memory.domains"
        )
    except ModuleNotFoundError as error:
        pytest.skip(
            f"Conversation SQLite stores are not integrated into this checkout yet: {error.name}"
        )
    return memory_module.ConversationMemoryStore, domains_module.ConversationDomainStore


class _MemoryPort:
    """Adapt public ConversationMemoryStore operations for the host migration ports."""

    def __init__(self, store: Any) -> None:
        self.store = store

    def create_message(self, scope: ActorScope, body: Mapping[str, object]) -> Mapping[str, object]:
        return self.store.create_message(
            scope.organization_id, scope.workspace_id, scope.actor_id, body
        )

    def get_message(
        self,
        scope: ActorScope,
        message_id: str,
        *,
        context: AuthorizedConversationContext,
        include_revoked: bool = False,
    ) -> Mapping[str, object] | None:
        cursor: str | None = None
        while True:
            page = self.store.list_messages(
                scope.organization_id,
                scope.workspace_id,
                scope.actor_id,
                context.conversation_id,
                conversation_kind=context.conversation_kind,
                persona_id=context.persona_id,
                order="asc",
                limit=100,
                cursor=cursor,
                include_revoked=include_revoked,
            )
            for item in page["items"]:
                if item.get("id") == message_id:
                    return item
            cursor = page["nextCursor"]
            if cursor is None:
                return None

    def create_memory(self, scope: ActorScope, body: Mapping[str, object]) -> Mapping[str, object]:
        return self.store.create_memory(
            scope.organization_id, scope.workspace_id, scope.actor_id, body
        )

    def get_memory(
        self, scope: ActorScope, memory_id: str, *, include_deleted: bool = False
    ) -> Mapping[str, object] | None:
        getter = self.store.get_memory
        try:
            arguments = (
                scope.organization_id,
                scope.workspace_id,
                scope.actor_id,
                memory_id,
            )
            if include_deleted:
                return getter(*arguments, include_deleted=True)
            return getter(*arguments)
        except Exception as error:
            if getattr(error, "code", None) == "CONVERSATION_MEMORY_NOT_FOUND":
                return None
            raise

    def delete_memory(
        self, scope: ActorScope, memory_id: str, expected_version: int
    ) -> Mapping[str, object]:
        return self.store.delete_memory(
            scope.organization_id,
            scope.workspace_id,
            scope.actor_id,
            memory_id,
            expected_version,
        )

    def revoke_message(self, scope: ActorScope, message_id: str) -> Mapping[str, object]:
        return self.store.revoke_source(
            scope.organization_id, scope.workspace_id, scope.actor_id, message_id
        )


class _MemoryWithoutTombstoneReadback:
    """Model a pre-migration host that cannot verify deleted memory state."""

    def __init__(self, store: Any) -> None:
        self.store = store

    def __getattr__(self, name: str) -> Any:
        return getattr(self.store, name)

    def get_memory(
        self,
        organization_id: str,
        workspace_id: str,
        actor_id: str,
        memory_id: str,
    ) -> Mapping[str, object] | None:
        return self.store.get_memory(organization_id, workspace_id, actor_id, memory_id)


class _ProfilePort:
    """Adapt public profile-candidate APIs and source validation to one test database."""

    def __init__(self, domains: Any, memory: Any) -> None:
        self.domains = domains
        self.memory = memory

    def create_candidate(
        self, scope: ActorScope, body: Mapping[str, object]
    ) -> Mapping[str, object]:
        self.memory.validate_source_message_ids(
            scope.organization_id,
            scope.workspace_id,
            scope.actor_id,
            str(body["conversationId"]),
            str(body["conversationKind"]),
            str(body["personaId"]) if body["personaId"] is not None else None,
            body["sourceMessageIds"],
        )
        return self.domains.create_profile_candidate(
            str(scope.organization_id), scope.workspace_id, scope.actor_id, body
        )

    def get_candidate(self, scope: ActorScope, candidate_id: str) -> Mapping[str, object] | None:
        return self.domains.get_profile_candidate(
            str(scope.organization_id), scope.workspace_id, scope.actor_id, candidate_id
        )

    def activate_candidate(
        self, scope: ActorScope, candidate_id: str, expected_version: int
    ) -> Mapping[str, object]:
        return self.domains.activate_profile_candidate(
            str(scope.organization_id),
            scope.workspace_id,
            scope.actor_id,
            candidate_id,
            expected_version,
        )

    def get_profile(self, scope: ActorScope, profile_id: str) -> Mapping[str, object] | None:
        return self.domains.get_profile(
            str(scope.organization_id), scope.workspace_id, scope.actor_id, profile_id
        )

    def rollback_profile(
        self, scope: ActorScope, profile_id: str, expected_version: int
    ) -> Mapping[str, object]:
        return self.domains.rollback_profile(
            str(scope.organization_id),
            scope.workspace_id,
            scope.actor_id,
            profile_id,
            expected_version,
        )

    def rollback_candidate(
        self, scope: ActorScope, candidate_id: str, expected_version: int
    ) -> Mapping[str, object]:
        return self.domains.rollback_profile_candidate(
            str(scope.organization_id),
            scope.workspace_id,
            scope.actor_id,
            candidate_id,
            expected_version,
        )


class _GraphUnavailable:
    """Fail closed when a graph record reaches a fixture without a real provider."""

    def project_changeset(self, *args: object, **kwargs: object) -> Mapping[str, object]:
        raise AssertionError("graph provider is not configured for this fixture")

    def get_changeset(self, *args: object, **kwargs: object) -> Mapping[str, object] | None:
        raise AssertionError("graph provider is not configured for this fixture")

    def rollback_changeset(self, *args: object, **kwargs: object) -> Mapping[str, object]:
        raise AssertionError("graph provider is not configured for this fixture")


class _RollbackCapabilities:
    """Inspect only public canonical endpoints before any batch projection starts."""

    def __init__(self, memory: Any, domains: Any) -> None:
        self.memory = memory
        self.domains = domains

    def missing_capabilities(self, scope: ActorScope, *, required: Sequence[str]) -> Sequence[str]:
        checks = {
            "conversation.message.revoke.v1": callable(getattr(self.memory, "revoke_source", None)),
            "conversation.memory.tombstone.v1": callable(
                getattr(self.memory, "delete_memory", None)
            )
            and _accepts_keyword(getattr(self.memory, "get_memory", None), "include_deleted"),
            "navigator.profile.candidate-rollback.v1": callable(
                getattr(self.domains, "rollback_profile_candidate", None)
            ),
            "navigator.profile.rollback.v1": callable(
                getattr(self.domains, "rollback_profile", None)
            ),
            "navigator.graph.provider-compensation.v1": False,
        }
        return [capability for capability in required if not checks.get(capability, False)]


class _OperationPort:
    """Use WorkStore's real operation table for import and compensation receipts."""

    def __init__(self, store: WorkStore) -> None:
        self.store = store

    def begin(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        idempotency_key: str,
        operation_type: str,
        request: Mapping[str, object],
    ) -> OperationHandle:
        value, duplicate = self.store.create_operation(
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
        value, duplicate = self.store.update_operation(
            scope.organization_id,
            scope.workspace_id,
            operation_id,
            "verified",
            evidence,
            actor_id=scope.actor_id,
            actor_private_scope=True,
        )
        return _operation_handle(value, duplicate)

    def get(self, scope: ActorScope, *, task_id: str, operation_id: str) -> OperationHandle:
        value = self.store.get_operation(
            scope.organization_id,
            scope.workspace_id,
            operation_id,
            actor_id=scope.actor_id,
            actor_private_scope=True,
        )
        return _operation_handle(value, True)


class _TaskProgressPort:
    """Use the real Work Task event log as the restart cursor and rollback receipt source."""

    def __init__(self, store: WorkStore) -> None:
        self.store = store

    def append_checkpoint(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        event_id: str,
        event: Mapping[str, object],
    ) -> None:
        self.store.append_task_event(
            scope.organization_id,
            scope.workspace_id,
            task_id,
            {"type": "conversation.migration.checkpoint", **event},
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
    ) -> tuple[Sequence[Mapping[str, Any]], int]:
        rows, _ = self.store.get_task_events(
            scope.organization_id,
            scope.workspace_id,
            task_id,
            after=after_sequence,
            limit=limit,
            actor_id=scope.actor_id,
            actor_private_scope=True,
        )
        events = [row["event"] for row in rows if isinstance(row.get("event"), Mapping)]
        next_sequence = max((int(row["seq"]) for row in rows), default=after_sequence)
        return events, next_sequence


class _FailOnceCheckpoint(_TaskProgressPort):
    """Simulate process loss after a canonical write and before its Task checkpoint."""

    def __init__(self, store: WorkStore) -> None:
        super().__init__(store)
        self._fail = True

    def append_checkpoint(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        event_id: str,
        event: Mapping[str, object],
    ) -> None:
        if self._fail and event.get("migrationEvent") == "record":
            self._fail = False
            raise RuntimeError("synthetic process interruption after canonical commit")
        super().append_checkpoint(scope, task_id=task_id, event_id=event_id, event=event)


class _AuthorizationPort:
    """Explicit fixture host that maps one private artifact into a real actor DB scope."""

    def __init__(self, memory: Any, *, artifact_id: str, digest: str) -> None:
        self.memory = memory
        self.artifact_id = artifact_id
        self.digest = digest

    def authorize_artifact(self, scope: ActorScope, artifact_id: str, sha256: str) -> bool:
        return scope == SCOPE and artifact_id == self.artifact_id and sha256 == self.digest

    def resolve_conversation_context(
        self,
        scope: ActorScope,
        *,
        artifact_id: str,
        source_conversation_id: str,
        source_conversation_kind: str,
        source_persona_id: str | None,
    ) -> AuthorizedConversationContext | None:
        if not self.authorize_artifact(scope, artifact_id, self.digest):
            return None
        if source_conversation_kind != "direct":
            return None
        return CONTEXT

    def authorize_staged_record(
        self,
        scope: ActorScope,
        *,
        artifact_id: str,
        artifact_sha256: str,
        record: MigrationRecord,
    ) -> AuthorizationDecision:
        return AuthorizationDecision(
            self.authorize_artifact(scope, artifact_id, artifact_sha256), 0
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
        overview = self.memory.overview(scope.organization_id, scope.workspace_id, scope.actor_id)
        result = self.memory.authorize_sources(
            scope.organization_id,
            scope.workspace_id,
            scope.actor_id,
            conversation_id,
            int(overview["authorizationEpoch"]),
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
        return False

    def approve_graph_projection(
        self, scope: ActorScope, approval_ref: str | None, record_digest: str
    ) -> bool:
        return False

    def approve_import(self, scope: ActorScope, approval_ref: str | None, plan_sha256: str) -> bool:
        return scope == SCOPE and approval_ref == "fixture-import-approved"

    def approve_rollback(self, scope: ActorScope, batch_id: str, plan_sha256: str) -> bool:
        return scope == SCOPE


def _operation_handle(value: Mapping[str, object], duplicate: bool) -> OperationHandle:
    """Map public WorkStore operation views into the migration port result."""

    evidence = value.get("evidence", {})
    return OperationHandle(
        operation_id=str(value["id"]),
        status=str(value["status"]),
        evidence=evidence if isinstance(evidence, Mapping) else {},
        duplicate=duplicate,
    )


def _accepts_keyword(method: object, keyword: str) -> bool:
    """Check whether a public method explicitly accepts a required keyword."""

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


def _service(
    memory: Any,
    domains: Any,
    work: WorkStore,
    artifact_id: str,
    digest: str,
    *,
    progress: Any | None = None,
) -> ConversationMigrationService:
    """Compose real SQLite stores and the explicit test-only host authorization gate."""

    return ConversationMigrationService(
        authorization=_AuthorizationPort(memory, artifact_id=artifact_id, digest=digest),
        memory=_MemoryPort(memory),
        profiles=_ProfilePort(domains, memory),
        graph=_GraphUnavailable(),
        rollback_capabilities=_RollbackCapabilities(memory, domains),
        operations=_OperationPort(work),
        progress=progress or _TaskProgressPort(work),
        settings=MigrationSettings(max_page_records=2),
    )


def _create_task(work: WorkStore, task_id: str) -> None:
    """Create and claim a private Work Task before recording any migration operation."""

    work.create_task(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        {"id": task_id, "sessionId": f"session-{task_id}", "prompt": "restore synthetic fixture"},
        actor_id=SCOPE.actor_id,
        actor_private_scope=True,
    )
    claimed, _ = work.claim_task(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        task_id,
        actor_id=SCOPE.actor_id,
        actor_private_scope=True,
    )
    assert claimed


def test_actor_backup_restores_to_fresh_sqlite_and_recovers_from_task_events(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A portable backup restores into a fresh DB through canonical stores and survives reopen."""

    core_src = os.environ.get("CYRENE_NAVIGATOR_CORE_SOURCE")
    if core_src is None:
        pytest.skip("Set CYRENE_NAVIGATOR_CORE_SOURCE to the integrated core source tree.")
    memory_type, domain_type = _conversation_memory_types()
    source_db = tmp_path / "source.sqlite"
    source_memory = memory_type(source_db)
    source_domains = domain_type(source_db)
    source_memory.create_message(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        SCOPE.actor_id,
        {
            "eventId": "fixture-source-message",
            "conversationId": "legacy-conversation-1",
            "conversationKind": "direct",
            "visibility": "private",
            "role": "user",
            "content": "Synthetic SQLite backup source.",
            "occurredAt": 1_700_000_000_000,
        },
    )["message"]
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
    artifact_id = "sqlite-backup-fixture"
    task_id = "sqlite-restore-fixture"
    target_db = tmp_path / "restored.sqlite"
    target_memory = memory_type(target_db)
    target_domains = domain_type(target_db)
    work = WorkStore(target_db)
    _create_task(work, task_id)
    service = _service(
        target_memory,
        target_domains,
        work,
        artifact_id,
        backup.sha256,
        progress=_FailOnceCheckpoint(work),
    )

    with pytest.raises(RuntimeError, match="synthetic process interruption"):
        service.restore_backup(
            SCOPE,
            task_id=task_id,
            artifact_id=artifact_id,
            content=backup.content,
            expected_sha256=backup.sha256,
            approval_ref="fixture-import-approved",
        )
    assert target_memory.overview(SCOPE.organization_id, SCOPE.workspace_id, SCOPE.actor_id)[
        "counts"
    ] == {"messages": 1, "memories": 0, "sources": 1}

    retry_memory = memory_type(target_db)
    retry_domains = domain_type(target_db)
    retry_work = WorkStore(target_db)
    service = _service(retry_memory, retry_domains, retry_work, artifact_id, backup.sha256)
    receipt = service.restore_backup(
        SCOPE,
        task_id=task_id,
        artifact_id=artifact_id,
        content=backup.content,
        expected_sha256=backup.sha256,
        approval_ref="fixture-import-approved",
    )

    assert receipt.status == "applied"
    assert receipt.read_count == 1
    assert receipt.projected_count == 1
    assert receipt.candidate_count == 0
    assert receipt.quarantined_count == 0
    assert target_memory.overview(SCOPE.organization_id, SCOPE.workspace_id, SCOPE.actor_id)[
        "counts"
    ] == {"messages": 1, "memories": 0, "sources": 1}

    # Reopen every SQLite store and reconstruct the service with no process-local checkpoint cache.
    reopened_memory = memory_type(target_db)
    reopened_domains = domain_type(target_db)
    reopened_work = WorkStore(target_db)
    restarted = _service(
        reopened_memory, reopened_domains, reopened_work, artifact_id, backup.sha256
    )
    replay = restarted.restore_backup(
        SCOPE,
        task_id=task_id,
        artifact_id=artifact_id,
        content=backup.content,
        expected_sha256=backup.sha256,
        approval_ref="fixture-import-approved",
    )
    assert replay.status == "applied"
    assert replay.read_count == 1
    assert replay.replayed_count == 0
    assert reopened_memory.overview(SCOPE.organization_id, SCOPE.workspace_id, SCOPE.actor_id)[
        "counts"
    ] == {"messages": 1, "memories": 0, "sources": 1}

    message_page = reopened_memory.list_messages(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        SCOPE.actor_id,
        CONTEXT.conversation_id,
        conversation_kind=CONTEXT.conversation_kind,
        persona_id=CONTEXT.persona_id,
        order="asc",
        limit=10,
    )
    imported_message_id = message_page["items"][0]["id"]
    reopened_memory.revoke_source(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        SCOPE.actor_id,
        imported_message_id,
    )
    with pytest.raises(MigrationError) as changed:
        restarted.restore_backup(
            SCOPE,
            task_id=task_id,
            artifact_id=artifact_id,
            content=backup.content,
            expected_sha256=backup.sha256,
            approval_ref="fixture-import-approved",
        )
    assert changed.value.code == "APPLIED_PROJECTION_CHANGED"


def test_restore_preflight_blocks_memory_without_tombstone_readback(
    tmp_path: Path,
) -> None:
    """Missing compensation APIs stop a mixed batch before its first canonical write."""

    core_src = os.environ.get("CYRENE_NAVIGATOR_CORE_SOURCE")
    if core_src is None:
        pytest.skip("Set CYRENE_NAVIGATOR_CORE_SOURCE to the integrated core source tree.")
    memory_type, domain_type = _conversation_memory_types()
    target_db = tmp_path / "unsupported-memory.sqlite"
    memory = memory_type(target_db)
    domains = domain_type(target_db)
    work = WorkStore(target_db)
    task_id = "unsupported-memory-task"
    _create_task(work, task_id)

    records = [
        {
            "recordType": "message",
            "recordId": "source-message-1",
            "conversationId": "legacy-conversation-1",
            "conversationKind": "direct",
            "personaId": None,
            "visibility": "private",
            "sourceRecordIds": [],
            "validUntil": None,
            "role": "user",
            "content": "Synthetic source for preflight.",
            "occurredAt": 1_700_000_000_030,
        },
        {
            "recordType": "memory",
            "recordId": "source-memory-1",
            "conversationId": "legacy-conversation-1",
            "conversationKind": "direct",
            "personaId": None,
            "visibility": "private",
            "sourceRecordIds": ["source-message-1"],
            "validUntil": None,
            "memoryKind": "preference",
            "text": "Synthetic memory for preflight.",
        },
    ]
    content = (
        b"\n".join(
            [
                json.dumps(
                    {
                        "recordType": "header",
                        "schemaVersion": 1,
                        "sourceKind": "test.fixture",
                        "recordCount": len(records),
                    },
                    separators=(",", ":"),
                ).encode(),
                *(json.dumps(row, separators=(",", ":")).encode() for row in records),
            ]
        )
        + b"\n"
    )
    artifact_id = "unsupported-memory-artifact"
    digest = hashlib.sha256(content).hexdigest()
    source = JsonLinesMigrationSource(
        io.BytesIO(content), artifact_id=artifact_id, expected_sha256=digest
    )
    service = _service(_MemoryWithoutTombstoneReadback(memory), domains, work, artifact_id, digest)
    preview = service.preview(SCOPE, source)

    with pytest.raises(MigrationError) as error:
        service.apply(
            SCOPE,
            task_id=task_id,
            source=source,
            preview=preview,
            approval_ref="fixture-import-approved",
        )
    assert error.value.code == "ROLLBACK_CAPABILITY_UNAVAILABLE"

    assert memory.overview(SCOPE.organization_id, SCOPE.workspace_id, SCOPE.actor_id)["counts"] == {
        "messages": 0,
        "memories": 0,
        "sources": 0,
    }
    events, _ = work.get_task_events(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        task_id,
        actor_id=SCOPE.actor_id,
        actor_private_scope=True,
    )
    assert not [
        row
        for row in events
        if isinstance(row.get("event"), Mapping) and row["event"].get("migrationEvent") is not None
    ]


def test_message_batch_rollback_uses_canonical_revoke_and_persistent_task_checkpoint(
    tmp_path: Path,
) -> None:
    """Rollback revokes the imported source and can be replayed from Work Task history."""

    core_src = os.environ.get("CYRENE_NAVIGATOR_CORE_SOURCE")
    if core_src is None:
        pytest.skip("Set CYRENE_NAVIGATOR_CORE_SOURCE to the integrated core source tree.")
    memory_type, domain_type = _conversation_memory_types()
    target_db = tmp_path / "rollback.sqlite"
    memory = memory_type(target_db)
    domains = domain_type(target_db)
    work = WorkStore(target_db)
    task_id = "rollback-fixture-task"
    _create_task(work, task_id)
    records = [
        {
            "recordType": "message",
            "recordId": "source-message-1",
            "conversationId": "legacy-conversation-1",
            "conversationKind": "direct",
            "personaId": None,
            "visibility": "private",
            "sourceRecordIds": [],
            "validUntil": None,
            "role": "user",
            "content": "Synthetic rollback fixture.",
            "occurredAt": 1_700_000_000_020,
        }
    ]
    content = (
        b"\n".join(
            [
                json.dumps(
                    {
                        "recordType": "header",
                        "schemaVersion": 1,
                        "sourceKind": "test.fixture",
                        "recordCount": 1,
                    },
                    separators=(",", ":"),
                ).encode(),
                json.dumps(records[0], separators=(",", ":")).encode(),
            ]
        )
        + b"\n"
    )
    artifact_id = "rollback-artifact"
    digest = hashlib.sha256(content).hexdigest()
    service = _service(memory, domains, work, artifact_id, digest)
    source = JsonLinesMigrationSource(
        io.BytesIO(content), artifact_id=artifact_id, expected_sha256=digest
    )
    preview = service.preview(SCOPE, source)
    applied = service.apply(
        SCOPE,
        task_id=task_id,
        source=source,
        preview=preview,
        approval_ref="fixture-import-approved",
    )
    assert applied.projected_count == 1

    rolled_back = service.rollback(SCOPE, task_id=task_id, source=source, preview=preview)
    replay = service.rollback(SCOPE, task_id=task_id, source=source, preview=preview)

    assert rolled_back.status == "rolled_back"
    assert rolled_back.rolled_back_count == 1
    assert replay.rolled_back_count == 1
    messages = memory.list_messages(
        SCOPE.organization_id,
        SCOPE.workspace_id,
        SCOPE.actor_id,
        CONTEXT.conversation_id,
        conversation_kind=CONTEXT.conversation_kind,
        order="asc",
        include_revoked=True,
    )["items"]
    assert len(messages) == 1
    assert messages[0]["status"] == "revoked"
