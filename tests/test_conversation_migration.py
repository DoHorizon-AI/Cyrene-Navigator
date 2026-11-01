"""Focused tests for bounded migration parsing, backup conversion, and preview behavior."""

from __future__ import annotations

import hashlib
import io
import json
from collections.abc import Sequence
from typing import Any

import pytest

from cyrene_navigator.work.conversation_migration import (
    ActorBackupSource,
    ActorScope,
    ConversationMigrationService,
    ImportPreview,
    JsonLinesMigrationSource,
    MigrationError,
    MigrationSettings,
    build_actor_backup,
    parse_actor_backup,
)
from cyrene_navigator.work.conversation_migration.models import AuthorizedConversationContext
from cyrene_navigator.work.conversation_migration.ports import AuthorizationDecision

SCOPE = ActorScope("org-test", "workspace-test", "actor-private-test")


def _message(record_id: str = "message-1") -> dict[str, object]:
    """Return one content-only synthetic user message."""

    return {
        "recordType": "message",
        "recordId": record_id,
        "conversationId": "legacy-conversation-1",
        "conversationKind": "direct",
        "personaId": None,
        "visibility": "private",
        "sourceRecordIds": [],
        "validUntil": None,
        "role": "user",
        "content": "Synthetic fixture message.",
        "occurredAt": 1_700_000_000_000,
    }


def _memory(record_id: str = "memory-1", source_id: str = "message-1") -> dict[str, object]:
    """Return one source-linked synthetic memory."""

    return {
        "recordType": "memory",
        "recordId": record_id,
        "conversationId": "legacy-conversation-1",
        "conversationKind": "direct",
        "personaId": None,
        "visibility": "private",
        "sourceRecordIds": [source_id],
        "validUntil": None,
        "memoryKind": "preference",
        "text": "Synthetic preference fixture.",
    }


def _jsonl(records: list[dict[str, object]]) -> bytes:
    """Encode the closed JSONL v1 header and rows."""

    header = {
        "recordType": "header",
        "schemaVersion": 1,
        "sourceKind": "test.fixture",
        "recordCount": len(records),
    }
    return (
        b"\n".join(
            [
                json.dumps(header, separators=(",", ":")).encode(),
                *(json.dumps(row, separators=(",", ":")).encode() for row in records),
            ]
        )
        + b"\n"
    )


class _AuthorizationFixture:
    """Explicit fixture host gate; production policy remains in Navigator's host."""

    def __init__(self) -> None:
        self.preview_checks = 0

    def authorize_artifact(self, scope: ActorScope, artifact_id: str, sha256: str) -> bool:
        return scope == SCOPE and artifact_id == "artifact-fixture" and len(sha256) == 64

    def resolve_conversation_context(
        self,
        scope: ActorScope,
        *,
        artifact_id: str,
        source_conversation_id: str,
        source_conversation_kind: str,
        source_persona_id: str | None,
    ) -> AuthorizedConversationContext | None:
        if scope != SCOPE or artifact_id != "artifact-fixture":
            return None
        if (
            source_conversation_id != "legacy-conversation-1"
            or source_conversation_kind != "direct"
        ):
            return None
        return AuthorizedConversationContext("current-conversation-1", "direct", None)

    def authorize_staged_record(
        self,
        scope: ActorScope,
        *,
        artifact_id: str,
        artifact_sha256: str,
        record: Any,
    ) -> AuthorizationDecision:
        self.preview_checks += 1
        return AuthorizationDecision(
            scope == SCOPE and artifact_id == "artifact-fixture" and len(artifact_sha256) == 64,
            0,
            None,
        )

    def authorize_source_refs(self, *args: object, **kwargs: object) -> AuthorizationDecision:
        return AuthorizationDecision(True, 0)

    def approve_profile_activation(self, *args: object, **kwargs: object) -> bool:
        return False

    def approve_graph_projection(self, *args: object, **kwargs: object) -> bool:
        return False

    def approve_import(self, *args: object, **kwargs: object) -> bool:
        return True

    def approve_rollback(self, *args: object, **kwargs: object) -> bool:
        return True


class _UnusedProjection:
    """Fail the test if preview attempts a canonical write."""

    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"preview must not call projection method {name}")


class _UnusedJournal:
    """Fail the test if preview creates operations or task events."""

    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"preview must not create durable state through {name}")


class _MissingCapabilities:
    """Record requested compensation paths and report them unavailable."""

    def __init__(self) -> None:
        self.required: list[str] = []

    def missing_capabilities(self, scope: ActorScope, *, required: Sequence[str]) -> list[str]:
        self.required = list(required)
        return list(required)


def _service(
    authorization: _AuthorizationFixture,
    *,
    settings: MigrationSettings | None = None,
    rollback_capabilities: Any | None = None,
) -> ConversationMigrationService:
    """Construct the service with write ports that fail if the dry-run crosses a boundary."""

    return ConversationMigrationService(
        authorization=authorization,
        memory=_UnusedProjection(),
        profiles=_UnusedProjection(),
        graph=_UnusedProjection(),
        rollback_capabilities=rollback_capabilities or _UnusedJournal(),
        operations=_UnusedJournal(),
        progress=_UnusedJournal(),
        settings=settings,
    )


def test_jsonl_source_pages_by_cursor_and_verifies_exact_digest() -> None:
    """A bounded page cursor resumes after the exact bytes consumed."""

    content = _jsonl([_message(), _memory()])
    mutable_stream = io.BytesIO(content)
    source = JsonLinesMigrationSource(
        mutable_stream,
        artifact_id="artifact-fixture",
        expected_sha256=hashlib.sha256(content).hexdigest(),
        settings=MigrationSettings(max_page_records=1),
    )

    source.verify()
    mutable_stream.seek(0)
    mutable_stream.write(b"x" * len(content))
    first = source.read_page(None, 1)
    second = source.read_page(first.next_cursor, 1)

    assert first.items[0].value == _message()
    assert second.items[0].value == _memory()
    assert first.next_cursor is not None
    assert second.next_cursor is None


def test_jsonl_source_rejects_digest_change_and_unknown_identity_fields() -> None:
    """Artifact tampering fails before records can be staged or projected."""

    content = _jsonl([_message()])
    source = JsonLinesMigrationSource(
        io.BytesIO(content),
        artifact_id="artifact-fixture",
        expected_sha256="0" * 64,
    )
    with pytest.raises(ValueError, match="digest"):
        source.verify()

    unauthorized = _message()
    unauthorized["actorId"] = "untrusted-actor"
    invalid_source_bytes = _jsonl([unauthorized])
    invalid_source = JsonLinesMigrationSource(
        io.BytesIO(invalid_source_bytes),
        artifact_id="artifact-fixture",
        expected_sha256=hashlib.sha256(invalid_source_bytes).hexdigest(),
    )
    invalid_source.verify()
    page = invalid_source.read_page(None, 1)
    assert page.items[0].value is not None


def test_preview_is_read_only_bounded_and_counts_authorized_records() -> None:
    """Dry-run uses host scope checks and never touches canonical writes or task state."""

    content = _jsonl([_message(), _memory()])
    source = JsonLinesMigrationSource(
        io.BytesIO(content),
        artifact_id="artifact-fixture",
        expected_sha256=hashlib.sha256(content).hexdigest(),
        settings=MigrationSettings(max_page_records=1),
    )
    authorization = _AuthorizationFixture()

    preview = _service(authorization, settings=MigrationSettings(max_page_records=1)).preview(
        SCOPE, source
    )

    assert preview.record_count == 2
    assert preview.accepted_count == 2
    assert preview.quarantined_count == 0
    assert preview.accepted_by_kind == {"memory": 1, "message": 1}
    assert authorization.preview_checks == 2
    assert len(preview.plan_sha256) == 64


def test_preview_quarantines_secret_and_non_prior_lineage_without_returning_content() -> None:
    """Malformed, secret-bearing, or forward-linked rows are count-only quarantines."""

    bad_memory = _memory(source_id="later-message")
    secret_message = _message("secret-message")
    secret_message["content"] = "fixture"
    secret_message["token"] = "do-not-return-this"
    content = _jsonl([bad_memory, secret_message])
    source = JsonLinesMigrationSource(
        io.BytesIO(content),
        artifact_id="artifact-fixture",
        expected_sha256=hashlib.sha256(content).hexdigest(),
    )

    preview = _service(
        _AuthorizationFixture(), settings=MigrationSettings(max_page_records=1)
    ).preview(SCOPE, source)

    assert preview.record_count == 2
    assert preview.accepted_count == 0
    assert preview.quarantined_count == 2
    assert preview.quarantine_reasons == {"sensitive_field": 1, "source_not_prior_or_importable": 1}
    assert "do-not-return-this" not in repr(preview)


def test_preflight_requires_all_canonical_compensation_paths() -> None:
    """Accepted memory, profile, and graph rows require real rollback readbacks."""

    capabilities = _MissingCapabilities()
    service = _service(_AuthorizationFixture(), rollback_capabilities=capabilities)
    preview = ImportPreview(
        artifact_id="artifact-fixture",
        artifact_sha256="a" * 64,
        plan_sha256="b" * 64,
        record_count=4,
        accepted_count=4,
        quarantined_count=0,
        accepted_by_kind={"message": 1, "memory": 1, "profile": 1, "graph": 1},
        quarantine_reasons={},
    )

    with pytest.raises(MigrationError) as error:
        service._require_rollback_capabilities(SCOPE, preview)
    assert error.value.code == "ROLLBACK_CAPABILITY_UNAVAILABLE"

    assert capabilities.required == [
        "conversation.memory.tombstone.v1",
        "conversation.message.revoke.v1",
        "navigator.graph.provider-compensation.v1",
        "navigator.profile.candidate-rollback.v1",
        "navigator.profile.rollback.v1",
    ]


def _component_export(records: dict[str, list[dict[str, object]]], scope_digest: str) -> bytes:
    """Encode one synthetic store export with only privacy-safe test data."""

    value = {
        "schemaVersion": 1,
        "createdAt": 1_700_000_000_000,
        "scopeDigest": scope_digest,
        "records": records,
    }
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def test_backup_builder_exports_only_portable_records_and_omits_auth_and_jobs() -> None:
    """Portable archive keeps lineage but excludes identity, grants, attachments, and task state."""

    message_id = "old-message-1"
    memory_scope_digest = hashlib.sha256(
        json.dumps(
            {
                "organizationId": SCOPE.organization_id,
                "workspaceId": SCOPE.workspace_id,
                "actorId": SCOPE.actor_id,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    domain_scope_digest = hashlib.sha256(
        json.dumps(
            {
                "org": SCOPE.organization_id,
                "workspace": SCOPE.workspace_id,
                "actor": SCOPE.actor_id,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    memory_export = _component_export(
        {
            "conversation_memory_messages": [
                {
                    "message_id": message_id,
                    "event_id": "old-event-1",
                    "conversation_id": "legacy-conversation-1",
                    "conversation_kind": "direct",
                    "persona_id": None,
                    "visibility": "private",
                    "role": "user",
                    "content": "Synthetic backup fixture.",
                    "source_refs_json": "[]",
                    "attachments_json": "[]",
                    "payload_digest": "b" * 64,
                    "status": "active",
                    "occurred_at": 1_700_000_000_000,
                    "created_at": 1_700_000_000_000,
                    "revoked_at": None,
                }
            ],
            "conversation_memory_items": [
                {
                    "memory_id": "old-memory-1",
                    "idempotency_key": "old-key",
                    "conversation_id": "legacy-conversation-1",
                    "conversation_kind": "direct",
                    "persona_id": None,
                    "visibility": "private",
                    "memory_kind": "preference",
                    "text": "Synthetic preference.",
                    "source_message_ids_json": json.dumps([message_id]),
                    "source_refs_json": "[]",
                    "payload_digest": "c" * 64,
                    "version": 1,
                    "state": "active",
                    "index_state": "indexed",
                    "authorization_epoch": 9,
                    "valid_until": None,
                    "created_at": 1_700_000_000_001,
                    "updated_at": 1_700_000_000_001,
                }
            ],
            "conversation_memory_source_grants": [{"token": "fixture-only-grant"}],
        },
        memory_scope_digest,
    )
    domain_export = _component_export(
        {
            "profileCandidates": [
                {
                    "id": "old-candidate-1",
                    "idempotencyKey": "old-profile-key",
                    "conversationId": "legacy-conversation-1",
                    "conversationKind": "direct",
                    "subjectKind": "user",
                    "personaId": None,
                    "category": "preference",
                    "text": "Synthetic profile candidate.",
                    "sourceMessageIds": [message_id],
                    "sourceRefs": [],
                    "confidence": 0.8,
                    "validUntil": None,
                    "state": "candidate",
                    "version": 1,
                    "evidence": {"confidence": 0.8},
                    "createdAt": 1_700_000_000_002,
                    "updatedAt": 1_700_000_000_002,
                }
            ],
            "profiles": [],
            "graphChangesets": [],
            "maintenanceJobs": [{"state": "running", "taskId": "fixture-task"}],
            "importRecords": [{"text": "staging only"}],
        },
        domain_scope_digest,
    )

    backup = build_actor_backup(
        SCOPE,
        memory_export,
        domain_export,
        created_at=1_700_000_000_003,
    )
    restored = parse_actor_backup(backup.content, expected_sha256=backup.sha256)
    source = ActorBackupSource(restored, artifact_id="artifact-fixture")
    source.verify()
    first_page = source.read_page(None, 2)
    second_page = source.read_page(first_page.next_cursor, 2)

    assert backup.record_counts == {"message": 1, "memory": 1, "profile": 1}
    assert backup.quarantined_count == 0
    assert backup.omitted_counts["authorization_or_derived_memory_tables"] == 1
    assert backup.omitted_counts["excluded_maintenance_jobs"] == 1
    assert backup.omitted_counts["excluded_import_records"] == 1
    assert b"fixture-only-grant" not in backup.content
    assert b"actor-private-test" not in backup.content
    assert [
        item.value["recordType"] for item in first_page.items if isinstance(item.value, dict)
    ] == [
        "message",
        "profile",
    ]
    assert [
        item.value["recordType"] for item in second_page.items if isinstance(item.value, dict)
    ] == ["memory"]


def test_backup_restore_requires_exact_checksum_and_closed_schema() -> None:
    """An altered package cannot pass merely because its JSON remains parseable."""

    content = _jsonl([_message()])
    with pytest.raises(MigrationError, match="digest"):
        parse_actor_backup(content, expected_sha256="f" * 64)
