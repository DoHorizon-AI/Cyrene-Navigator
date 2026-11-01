"""Independent SQLite behavior tests for Navigator conversation product domains."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.work.conversation_memory.domains import ConversationDomainStore


@pytest.fixture
def store(tmp_path: Path) -> ConversationDomainStore:
    return ConversationDomainStore(tmp_path / "conversation-domains.sqlite3")


def test_personas_are_versioned_and_scoped(store: ConversationDomainStore) -> None:
    body = {
        "id": "persona-1",
        "name": "Concise",
        "description": "Short answers",
        "prompt": "Use clear, short sentences.",
        "enabled": True,
        "conversationIds": ["conversation-1"],
    }
    first = store.put_persona("org-a", "workspace-a", "actor-a", body)
    assert first["version"] == 1
    assert store.put_persona("org-a", "workspace-a", "actor-a", body)["version"] == 1

    changed = {**body, "prompt": "Use direct, short sentences."}
    assert store.put_persona("org-a", "workspace-a", "actor-a", changed)["version"] == 2
    assert len(store.list_personas("org-a", "workspace-a", "actor-a", "conversation-1")) == 1
    assert store.list_personas("org-a", "workspace-a", "actor-a", "other-conversation") == []
    assert store.list_personas("org-a", "workspace-a", "actor-b") == []
    assert store.list_personas("org-b", "workspace-a", "actor-a") == []
    assert store.list_personas("org-a", "workspace-b", "actor-a") == []
    reopened = ConversationDomainStore(store.db_path)
    assert reopened.list_personas("org-a", "workspace-a", "actor-a")[0]["version"] == 2

    with pytest.raises(PersistenceError) as error:
        store.put_persona("org-a", "workspace-a", "actor-a", {**body, "actorId": "actor-b"})
    assert error.value.status == 422


def test_v1_migration_preserves_unknown_source_context_as_null(tmp_path: Path) -> None:
    db_path = tmp_path / "legacy-domain.sqlite3"
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """CREATE TABLE research_notes (
                   org TEXT NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL,
                   note_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
                   conversation_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
                   source_refs_json TEXT NOT NULL, revision INTEGER NOT NULL,
                   created_at INTEGER NOT NULL,
                   PRIMARY KEY (org, workspace, actor, note_id),
                   UNIQUE (org, workspace, actor, idempotency_key)
               )"""
        )
        connection.execute(
            """INSERT INTO research_notes (
                   org, workspace, actor, note_id, idempotency_key, conversation_id,
                   title, content, source_refs_json, revision, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)""",
            (
                "org-a",
                "workspace-a",
                "actor-a",
                "legacy-note",
                "legacy-key",
                "conversation-1",
                "Old note",
                "Old context cannot be inferred.",
                '["source:legacy"]',
            ),
        )
        connection.execute("PRAGMA user_version=1")

    migrated = ConversationDomainStore(db_path)
    note = migrated.list_research_notes("org-a", "workspace-a", "actor-a")[0]
    assert note["conversationKind"] is None
    assert note["personaId"] is None
    with sqlite3.connect(db_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 4


def test_behavior_policy_is_scoped_and_uses_version_cas_without_default_rows(
    store: ConversationDomainStore,
) -> None:
    assert (
        store.get_active_behavior_policy("org-a", "workspace-a", "actor-a", "conversation-1")
        is None
    )
    with sqlite3.connect(store.db_path) as connection:
        assert (
            connection.execute("SELECT COUNT(*) FROM active_behavior_policies").fetchone()[0] == 0
        )

    body = {
        "conversationId": "conversation-1",
        "enabled": True,
        "quietHours": {"timeZone": "America/New_York", "start": "22:00", "end": "07:00"},
        "cooldownSeconds": 600,
        "allowGroupInterjections": False,
        "followupEnabled": True,
    }
    created = store.put_active_behavior_policy("org-a", "workspace-a", "actor-a", body)
    assert created["version"] == 1
    assert created["quietHours"] == body["quietHours"]
    assert (
        store.get_active_behavior_policy("org-a", "workspace-a", "actor-a", "conversation-1")
        == created
    )
    assert (
        store.get_active_behavior_policy("org-a", "workspace-a", "actor-a", "conversation-2")
        is None
    )
    assert (
        store.get_active_behavior_policy("org-a", "workspace-a", "actor-b", "conversation-1")
        is None
    )
    assert (
        store.get_active_behavior_policy("org-a", "workspace-b", "actor-a", "conversation-1")
        is None
    )

    changed = {**body, "cooldownSeconds": 900, "expectedVersion": 1}
    updated = store.put_active_behavior_policy("org-a", "workspace-a", "actor-a", changed)
    assert updated["version"] == 2
    assert store.put_active_behavior_policy("org-a", "workspace-a", "actor-a", changed) == updated
    with pytest.raises(PersistenceError) as conflict:
        store.put_active_behavior_policy(
            "org-a", "workspace-a", "actor-a", {**changed, "cooldownSeconds": 1}
        )
    assert conflict.value.status == 409


def test_actor_backup_is_scoped_and_filters_sensitive_content(
    store: ConversationDomainStore,
) -> None:
    persona = {
        "id": "persona-a",
        "name": "Private persona",
        "prompt": "Use sourced facts.",
        "enabled": True,
    }
    store.put_persona("org-a", "workspace-a", "actor-a", persona)
    store.put_persona("org-a", "workspace-a", "actor-b", {**persona, "id": "persona-b"})
    note = {
        "idempotencyKey": "backup-note-a",
        "conversationId": "conversation-1",
        "conversationKind": "direct",
        "title": "Backup note",
        "content": "Initially safe.",
        "sourceRefs": ["message:backup-1"],
    }
    store.create_research_note("org-a", "workspace-a", "actor-a", note)
    store.create_research_note(
        "org-a",
        "workspace-a",
        "actor-b",
        {**note, "idempotencyKey": "backup-note-b", "content": "Other actor's private data."},
    )
    store.create_verified_skill(
        "org-a",
        "workspace-a",
        "actor-a",
        {
            "idempotencyKey": "backup-skill-a",
            "name": "Sourced answer",
            "content": "Cite the source.",
            "sourceRefs": ["message:backup-2"],
            "operationReceiptId": "operation-verify-backup",
            "independentReadReceiptId": "operation-readback-backup",
        },
    )
    with sqlite3.connect(store.db_path) as connection:
        connection.execute(
            "UPDATE research_notes SET content=? WHERE actor=? AND idempotency_key=?",
            ("Stored text password=topsecret-value", "actor-a", "backup-note-a"),
        )

    raw = store.export_actor_backup("org-a", "workspace-a", "actor-a")
    document = json.loads(raw)
    assert isinstance(raw, bytes)
    assert document["schemaVersion"] == 1
    assert isinstance(document["createdAt"], int)
    assert len(document["scopeDigest"]) == 64
    assert [item["id"] for item in document["records"]["personas"]] == ["persona-a"]
    assert len(document["records"]["researchNotes"]) == 1
    assert document["records"]["researchNotes"][0]["content"] == "[REDACTED]"
    assert "verifiedBy" not in document["records"]["verifiedSkills"][0]
    assert "topsecret-value" not in raw.decode("utf-8")
    assert "Other actor's private data" not in raw.decode("utf-8")
    assert "actor-a" not in document
    assert "org-a" not in raw.decode("utf-8")


def test_actor_backup_stops_at_hard_size_limit(store: ConversationDomainStore) -> None:
    with sqlite3.connect(store.db_path) as connection:
        connection.executemany(
            """INSERT INTO research_notes (
                   org, workspace, actor, note_id, idempotency_key, conversation_id,
                   title, content, source_refs_json, revision, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)""",
            [
                (
                    "org-a",
                    "workspace-a",
                    "actor-a",
                    f"large-note-{index}",
                    f"large-key-{index}",
                    "conversation-1",
                    f"Large note {index}",
                    "x" * 15_000,
                    '["source:large"]',
                )
                for index in range(700)
            ],
        )

    with pytest.raises(PersistenceError) as error:
        store.export_actor_backup("org-a", "workspace-a", "actor-a")
    assert error.value.code == "CONVERSATION_DOMAIN_BACKUP_TOO_LARGE"
    assert error.value.status == 413


def test_profile_candidates_activate_and_rollback_with_provenance(
    store: ConversationDomainStore,
) -> None:
    def candidate(key: str, text: str) -> dict[str, object]:
        return {
            "idempotencyKey": key,
            "conversationId": "conversation-1",
            "conversationKind": "direct",
            "subjectKind": "user",
            "category": "preference",
            "text": text,
            "sourceMessageIds": ["message-1"],
            "confidence": 0.9,
        }

    first_candidate = store.create_profile_candidate(
        "org-a", "workspace-a", "actor-a", candidate("candidate-1", "Prefers concise replies")
    )
    assert first_candidate["state"] == "candidate"
    assert first_candidate["sourceMessageIds"] == ["message-1"]
    assert (
        store.create_profile_candidate(
            "org-a", "workspace-a", "actor-a", candidate("candidate-1", "Prefers concise replies")
        )["id"]
        == first_candidate["id"]
    )
    with pytest.raises(PersistenceError) as reused_key:
        store.create_profile_candidate(
            "org-a", "workspace-a", "actor-a", candidate("candidate-1", "Different proposal")
        )
    assert reused_key.value.status == 409

    first_profile = store.activate_profile_candidate(
        "org-a", "workspace-a", "actor-a", str(first_candidate["id"]), 1
    )
    assert first_profile["state"] == "active"
    assert (
        store.activate_profile_candidate(
            "org-a", "workspace-a", "actor-a", str(first_candidate["id"]), 1
        )["id"]
        == first_profile["id"]
    )

    second_candidate = store.create_profile_candidate(
        "org-a",
        "workspace-a",
        "actor-a",
        candidate("candidate-2", "Prefers concise and direct replies"),
    )
    second_profile = store.activate_profile_candidate(
        "org-a", "workspace-a", "actor-a", str(second_candidate["id"]), 1
    )
    rolled_back = store.rollback_profile(
        "org-a", "workspace-a", "actor-a", str(second_profile["id"]), 1
    )
    assert rolled_back["state"] == "rolled_back"
    assert (
        store.rollback_profile("org-a", "workspace-a", "actor-a", str(second_profile["id"]), 1)[
            "version"
        ]
        == 2
    )

    with pytest.raises(PersistenceError) as error:
        store.rollback_profile("org-a", "workspace-a", "actor-b", str(second_profile["id"]), 1)
    assert error.value.status == 404
    with pytest.raises(PersistenceError):
        store.create_profile_candidate(
            "org-a",
            "workspace-a",
            "actor-a",
            {**candidate("candidate-3", "Unprovenanced"), "sourceMessageIds": []},
        )

    with sqlite3.connect(store.db_path) as connection:
        states = connection.execute(
            "SELECT state FROM profiles WHERE actor='actor-a' ORDER BY created_at"
        ).fetchall()
    assert [row[0] for row in states] == ["active", "rolled_back"]


def test_graph_changesets_require_provider_receipts_before_projection(
    store: ConversationDomainStore,
) -> None:
    body = {
        "idempotencyKey": "graph-1",
        "conversationId": "conversation-1",
        "conversationKind": "direct",
        "nodes": [
            {
                "id": "node-a",
                "label": "Project",
                "properties": {"status": "active"},
                "sourceMessageIds": ["message-1"],
            }
        ],
        "edges": [
            {
                "id": "edge-a",
                "fromId": "node-a",
                "toId": "node-b",
                "label": "related_to",
                "sourceMessageIds": ["message-2"],
            }
        ],
    }
    proposal = store.upsert_graph_entities("org-a", "workspace-a", "actor-a", body)
    assert proposal["state"] == "proposed"
    assert proposal["providerApplied"] is False
    assert proposal["nodes"][0]["sourceMessageIds"] == ["message-1"]
    assert store.list_graph_changesets("org-a", "workspace-a", "actor-a")[0]["id"] == proposal["id"]

    with pytest.raises(PersistenceError) as error:
        store.query_graph("org-a", "workspace-a", "actor-a", {"query": "project"})
    assert error.value.code == "GRAPH_PROVIDER_UNAVAILABLE"
    assert error.value.status == 503

    with pytest.raises(PersistenceError) as unavailable:
        store.apply_graph_changeset("org-a", "workspace-a", "actor-a", str(proposal["id"]), 1)
    assert unavailable.value.code == "GRAPH_PROVIDER_UNAVAILABLE"
    assert (
        store.get_graph_changeset("org-a", "workspace-a", "actor-a", str(proposal["id"]))["state"]
        == "proposed"
    )

    provider_receipt = {
        "requestDigest": proposal["digest"],
        "readbackDigest": proposal["digest"],
        "nodeCount": 1,
        "edgeCount": 1,
        "appliedAt": 1_800_000_000_000,
    }
    bad_receipt = {**provider_receipt, "readbackDigest": hashlib.sha256(b"mismatch").hexdigest()}
    with pytest.raises(PersistenceError):
        store.apply_graph_changeset(
            "org-a", "workspace-a", "actor-a", str(proposal["id"]), 1, bad_receipt
        )
    assert (
        store.get_graph_changeset("org-a", "workspace-a", "actor-a", str(proposal["id"]))["state"]
        == "proposed"
    )
    projected = store.apply_graph_changeset(
        "org-a", "workspace-a", "actor-a", str(proposal["id"]), 1, provider_receipt
    )
    assert projected["state"] == "projected"
    assert projected["providerStatus"] == "applied"
    assert projected["providerApplied"] is True
    assert projected["providerReceipt"] == provider_receipt
    assert (
        store.apply_graph_changeset(
            "org-a", "workspace-a", "actor-a", str(proposal["id"]), 1, provider_receipt
        )["version"]
        == 2
    )


def test_maintenance_jobs_use_idempotency_and_page_checkpoints(
    store: ConversationDomainStore,
) -> None:
    request = {
        "idempotencyKey": "maintenance-1",
        "kind": "dream",
        "conversationId": "conversation-1",
        "conversationKind": "direct",
        "cursor": "page-1",
    }
    job = store.create_maintenance_job("org-a", "workspace-a", "actor-a", request)
    assert job["state"] == "queued"
    assert (
        store.create_maintenance_job("org-a", "workspace-a", "actor-a", request)["id"] == job["id"]
    )

    checkpoint = {
        "cursor": "page-2",
        "processedCount": 10,
        "checkpointDigest": hashlib.sha256(b"page-1").hexdigest(),
        "details": {"state": "running", "sourceRefs": ["message:1"]},
    }
    running = store.checkpoint_maintenance_job(
        "org-a", "workspace-a", "actor-a", str(job["id"]), 1, checkpoint
    )
    assert running["version"] == 2
    assert running["cursor"] == "page-2"
    assert running["processedCount"] == 10
    assert (
        store.checkpoint_maintenance_job(
            "org-a", "workspace-a", "actor-a", str(job["id"]), 1, checkpoint
        )["version"]
        == 2
    )
    assert (
        store.create_maintenance_job("org-a", "workspace-a", "actor-a", request)["state"]
        == "running"
    )

    terminal_checkpoint = {
        "cursor": "page-3",
        "processedCount": 25,
        "checkpointDigest": hashlib.sha256(b"page-2").hexdigest(),
        "details": {
            "state": "completed",
            "taskId": "maintenance-task-1",
            "taskOutputSha256": hashlib.sha256(b"complete").hexdigest(),
        },
    }
    with pytest.raises(PersistenceError):
        store.checkpoint_maintenance_job(
            "org-a", "workspace-a", "actor-a", str(job["id"]), 2, terminal_checkpoint
        )
    completed = store.checkpoint_maintenance_job(
        "org-a",
        "workspace-a",
        "actor-a",
        str(job["id"]),
        2,
        terminal_checkpoint,
        terminal_receipt_validated=True,
    )
    assert completed["state"] == "completed"
    assert completed["processedCount"] == 25
    assert (
        store.get_maintenance_job("org-a", "workspace-a", "actor-a", str(job["id"]))["id"]
        == job["id"]
    )
    with pytest.raises(PersistenceError):
        store.checkpoint_maintenance_job(
            "org-a", "workspace-a", "actor-a", str(job["id"]), 3, checkpoint
        )


def test_research_skills_watches_focus_handoff_and_review_are_sourced_and_scoped(
    store: ConversationDomainStore,
) -> None:
    note_body = {
        "idempotencyKey": "research-1",
        "conversationId": "conversation-1",
        "conversationKind": "direct",
        "title": "Launch criteria",
        "content": "The launch requires an owner and rollback plan.",
        "sourceRefs": ["message:1"],
    }
    note = store.create_research_note("org-a", "workspace-a", "actor-a", note_body)
    assert note["revision"] == 1
    updated_note = store.create_research_note(
        "org-a",
        "workspace-a",
        "actor-a",
        {
            **note_body,
            "idempotencyKey": "research-2",
            "content": "The launch also needs a dry run.",
        },
    )
    assert updated_note["revision"] == 2
    assert len(store.list_research_notes("org-a", "workspace-a", "actor-a", "conversation-1")) == 2

    skill = store.create_verified_skill(
        "org-a",
        "workspace-a",
        "actor-a",
        {
            "idempotencyKey": "skill-1",
            "name": "Summarize decisions",
            "content": "Record decisions with owner and source.",
            "sourceRefs": ["message:2"],
            "operationReceiptId": "operation-verify-1",
            "independentReadReceiptId": "operation-readback-1",
        },
    )
    assert skill["verified"] is True
    assert skill["verifiedBy"] == "actor-a"
    assert isinstance(skill["verifiedAt"], int)
    with pytest.raises(PersistenceError):
        store.create_verified_skill(
            "org-a",
            "workspace-a",
            "actor-a",
            {
                "idempotencyKey": "skill-2",
                "name": "Unverified",
                "content": "No proof",
                "sourceRefs": [],
                "operationReceiptId": "operation-verify-2",
                "independentReadReceiptId": "operation-readback-2",
            },
        )

    watch = store.create_watch(
        "org-a",
        "workspace-a",
        "actor-a",
        {
            "idempotencyKey": "watch-1",
            "conversationId": "conversation-1",
            "conversationKind": "direct",
            "title": "Release date",
            "condition": "Notify when the release date changes.",
            "sourceRefs": ["message:3"],
        },
    )
    scheduled = store.schedule_watch(
        "org-a", "workspace-a", "actor-a", str(watch["id"]), 1, 1_800_000_000_000
    )
    assert scheduled["nextCheckAt"] == 1_800_000_000_000
    assert scheduled["version"] == 2
    assert (
        store.schedule_watch(
            "org-a", "workspace-a", "actor-a", str(watch["id"]), 1, 1_800_000_000_000
        )["version"]
        == 2
    )
    cancelled = store.cancel_watch("org-a", "workspace-a", "actor-a", str(watch["id"]), 2)
    assert cancelled["state"] == "cancelled"
    assert (
        store.cancel_watch("org-a", "workspace-a", "actor-a", str(watch["id"]), 2)["version"] == 3
    )
    with pytest.raises(PersistenceError):
        store.schedule_watch("org-a", "workspace-a", "actor-a", str(watch["id"]), 3, None)
    assert store.list_watches("org-a", "workspace-a", "actor-b") == []

    focus = store.create_focus_item(
        "org-a",
        "workspace-a",
        "actor-a",
        {
            "idempotencyKey": "focus-1",
            "conversationId": "conversation-1",
            "conversationKind": "direct",
            "kind": "wait",
            "summary": "Wait for the security review.",
            "sourceRefs": ["message:4"],
        },
    )
    assert focus["state"] == "waiting"
    transitioned = store.transition_focus_item(
        "org-a", "workspace-a", "actor-a", str(focus["id"]), {"state": "open", "expectedVersion": 1}
    )
    assert transitioned["version"] == 2
    assert (
        store.transition_focus_item(
            "org-a",
            "workspace-a",
            "actor-a",
            str(focus["id"]),
            {"state": "open", "expectedVersion": 1},
        )["version"]
        == 2
    )

    handoff_body = {
        "idempotencyKey": "handoff-1",
        "taskId": "task-1",
        "sessionId": "session-1",
        "summary": "Confirm review timing.",
        "unresolvedItems": ["Ask the reviewer for an ETA."],
        "unknownOperationRefs": ["operation:missing-1"],
        "sourceRefs": ["message:5"],
    }
    handoff = store.create_handoff("org-a", "workspace-a", "actor-a", handoff_body)
    assert handoff["unresolvedItems"] == ["Ask the reviewer for an ETA."]
    assert (
        store.read_handoff("org-a", "workspace-a", "actor-a", str(handoff["id"]))["id"]
        == handoff["id"]
    )
    with pytest.raises(PersistenceError):
        store.read_handoff("org-a", "workspace-a", "actor-b", str(handoff["id"]))

    review = store.append_review_event(
        "org-a",
        "workspace-a",
        "actor-a",
        {
            "idempotencyKey": "review-1",
            "eventType": "approved",
            "summary": "The sourced note is approved.",
            "sourceRefs": ["message:6"],
            "decision": "keep",
        },
    )
    assert (
        store.append_review_event(
            "org-a",
            "workspace-a",
            "actor-a",
            {
                "idempotencyKey": "review-1",
                "eventType": "approved",
                "summary": "The sourced note is approved.",
                "sourceRefs": ["message:6"],
                "decision": "keep",
            },
        )["id"]
        == review["id"]
    )
    assert store.list_review_events("org-a", "workspace-a", "actor-b") == []


def test_import_preview_is_ephemeral_and_apply_quarantines_sensitive_or_unsourced_rows(
    store: ConversationDomainStore,
) -> None:
    body = {
        "batchId": "import-1",
        "sourceKind": "legacy_notes",
        "records": [
            {
                "recordId": "safe-1",
                "kind": "researchNote",
                "conversationId": "conversation-1",
                "conversationKind": "direct",
                "text": "A sourced historical note.",
                "sourceRefs": ["archive:message-1"],
                "visibility": "private",
            },
            {
                "recordId": "secret-1",
                "kind": "credentials",
                "text": "Contains private material.",
                "sourceRefs": ["archive:message-2"],
                "visibility": "private",
            },
            {
                "recordId": "unsourced-1",
                "kind": "researchNote",
                "text": "No traceable origin.",
                "sourceRefs": [],
                "visibility": "private",
            },
            {
                "recordId": "task-1",
                "kind": "runningTask",
                "text": "A task currently running.",
                "sourceRefs": ["archive:message-3"],
                "visibility": "private",
            },
        ],
    }
    preview = store.preview_import_batch("org-a", "workspace-a", "actor-a", body)
    assert preview == {
        "recordCount": 4,
        "acceptedCount": 1,
        "quarantinedCount": 3,
        "digest": preview["digest"],
    }
    assert "A sourced historical note." not in repr(preview)
    with sqlite3.connect(store.db_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM import_batches").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM import_records").fetchone()[0] == 0

    applied = store.apply_import_batch("org-a", "workspace-a", "actor-a", body)
    assert applied["state"] == "applied"
    assert applied["acceptedCount"] == 1
    assert applied["quarantinedCount"] == 3
    assert (
        store.apply_import_batch("org-a", "workspace-a", "actor-a", body)["batchId"] == "import-1"
    )
    with sqlite3.connect(store.db_path) as connection:
        rows = connection.execute(
            "SELECT record_id, text, source_refs_json, state FROM import_records"
        ).fetchall()
    assert rows == [
        (
            "safe-1",
            "A sourced historical note.",
            '[{"memoryId":null,"memoryVersion":null,"sourceMessageIds":["archive:message-1"]}]',
            "active",
        )
    ]

    rolled_back = store.rollback_import_batch("org-a", "workspace-a", "actor-a", "import-1")
    assert rolled_back["state"] == "rolledBack"
    assert (
        store.rollback_import_batch("org-a", "workspace-a", "actor-a", "import-1")["version"] == 2
    )
    with sqlite3.connect(store.db_path) as connection:
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM import_records WHERE state='active'"
            ).fetchone()[0]
            == 0
        )
