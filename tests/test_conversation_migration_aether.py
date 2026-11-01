"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 test_conversation_migration_aether.py                            │
│  Module: tests.test_conversation_migration_aether                    │
│  Role: Verify offline Aether conversion with synthetic rows only.    │
│                                                                      │
│  模块职责：使用合成记录验证 Aether 离线转换，不读取真实历史。          │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import io
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from cyrene_navigator.work.conversation_migration.aether_convert import (
    AetherConversionError,
    convert_aether_platform_message_history,
    main,
)
from cyrene_navigator.work.conversation_migration.jsonl import JsonLinesMigrationSource
from cyrene_navigator.work.conversation_migration.models import MigrationSettings

_NAMESPACE = "synthetic-aether-namespace-01"


def _source_row(
    row_id: int = 1,
    *,
    role: str = "user",
    message: str = "Synthetic fixture text.",
    kind: str = "private",
) -> dict[str, object]:
    """Create one synthetic Aether database row without reading a history store."""

    return {
        "id": row_id,
        "platform_id": "synthetic-platform-id",
        "user_id": "synthetic-source-conversation-id",
        "sender_id": "synthetic-sender-id",
        "sender_name": "Synthetic Sender",
        "llm_checkpoint_id": "synthetic-running-checkpoint-id",
        "created_at": "2026-10-30T14:00:00",
        "updated_at": "2026-10-30T14:01:00",
        "content": {
            "type": role,
            "history_scope": "synthetic-history-scope",
            "bot_account_id": "synthetic-bot-account",
            "persona_id": "synthetic-persona-id",
            "conversation_kind": kind,
            "message": [{"type": "Plain", "text": message}],
            "source_timestamp": "2026-10-30T14:00:00Z",
            "source_message_ids": ["synthetic-trace-id"],
            "source_messages": [{"body": "excluded raw source event"}],
            "memory_source_dependencies": ["excluded-source-dependency"],
            "local_profile_revisions": {"persona": "excluded-revision"},
            "native_message_id": "excluded-platform-message-id",
            "native_target": {"chat_id": "excluded-native-target"},
        },
    }


def _jsonl(rows: list[object]) -> bytes:
    """Encode a synthetic source export as one JSON object per line."""

    return b"".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode() + b"\n" for row in rows
    )


def test_converts_user_and_bot_rows_to_verified_canonical_jsonl() -> None:
    group_row = _source_row(3, kind="group", message="Synthetic group message.")
    del group_row["content"]["source_timestamp"]
    rows = [
        _source_row(1),
        _source_row(2, role="bot", message="Synthetic reply."),
        group_row,
    ]
    raw = _jsonl(rows)

    report = convert_aether_platform_message_history(io.BytesIO(raw), source_namespace=_NAMESPACE)

    assert report.input_bytes == len(raw)
    assert report.input_rows == 3
    assert report.accepted_rows == 3
    assert report.quarantine_reasons == {}
    assert report.sha256 == hashlib.sha256(report.content).hexdigest()
    assert b"synthetic-source-conversation-id" not in report.content
    assert b"synthetic-platform-id" not in report.content
    assert b"synthetic-persona-id" not in report.content
    assert b"synthetic-running-checkpoint-id" not in report.content
    assert b"excluded raw source event" not in report.content
    assert b"excluded-native-target" not in report.content

    source = JsonLinesMigrationSource(
        io.BytesIO(report.content),
        artifact_id="synthetic-artifact",
        expected_sha256=report.sha256,
    )
    source.verify()
    assert source.header == {
        "recordType": "header",
        "schemaVersion": 1,
        "sourceKind": "aether.platform_message_history",
        "recordCount": 3,
    }
    page = source.read_page(None, 10)
    assert page.next_cursor is None
    records = [line.value for line in page.items]
    assert [record["role"] for record in records if isinstance(record, dict)] == [
        "user",
        "assistant",
        "user",
    ]
    assert [record["content"] for record in records if isinstance(record, dict)] == [
        "Synthetic fixture text.",
        "Synthetic reply.",
        "Synthetic group message.",
    ]
    assert records[0]["conversationKind"] == "direct"
    assert records[0]["visibility"] == "private"
    assert records[2]["conversationKind"] == "group"
    assert records[2]["visibility"] == "conversation"
    assert records[0]["occurredAt"] == int(
        datetime(2026, 10, 30, 14, tzinfo=UTC).timestamp() * 1_000
    )


def test_opaque_ids_are_stable_only_with_the_same_source_namespace() -> None:
    row = _jsonl([_source_row()])
    first = convert_aether_platform_message_history(io.BytesIO(row), source_namespace=_NAMESPACE)
    replay = convert_aether_platform_message_history(io.BytesIO(row), source_namespace=_NAMESPACE)
    different = convert_aether_platform_message_history(
        io.BytesIO(row), source_namespace="another-synthetic-namespace"
    )

    assert first.content == replay.content
    assert first.sha256 == replay.sha256
    first_source = JsonLinesMigrationSource(
        io.BytesIO(first.content), artifact_id="a", expected_sha256=first.sha256
    )
    different_source = JsonLinesMigrationSource(
        io.BytesIO(different.content), artifact_id="b", expected_sha256=different.sha256
    )
    first_source.verify()
    different_source.verify()
    first_record = first_source.read_page(None, 1).items[0].value
    different_record = different_source.read_page(None, 1).items[0].value
    assert first_record["recordId"] != different_record["recordId"]
    assert first_record["conversationId"] != different_record["conversationId"]


def test_quarantines_unsupported_sensitive_and_duplicate_rows_without_retaining_them() -> None:
    unsupported_fields = _source_row(2)
    unsupported_fields["session_token"] = "must-never-be-copied"
    credential_content = _source_row(3)
    credential_content["content"] = {
        **credential_content["content"],
        "api_key": "must-never-be-copied",
    }
    unsupported_kind = _source_row(4, kind="public_thread")
    unsupported_payload = _source_row(5)
    unsupported_payload["content"] = {
        **unsupported_payload["content"],
        "message": [{"type": "Image", "url": "private-url"}],
    }
    raw = (
        _jsonl(
            [
                _source_row(1),
                _source_row(1),
                unsupported_fields,
                credential_content,
                unsupported_kind,
                unsupported_payload,
                {"malformed": "source shape"},
            ]
        )
        + b"not-json\n"
    )

    report = convert_aether_platform_message_history(io.BytesIO(raw), source_namespace=_NAMESPACE)

    assert report.input_rows == 8
    assert report.accepted_rows == 1
    assert report.quarantine_reasons == {
        "duplicate_source_row_id": 1,
        "invalid_source_json": 1,
        "unsupported_aether_conversation_kind": 1,
        "unsupported_aether_message_payload": 1,
        "unsupported_or_sensitive_aether_content": 1,
        "unsupported_source_row_fields": 2,
    }
    assert b"must-never-be-copied" not in report.content
    assert b"private-url" not in report.content


def test_bounds_source_lines_and_total_bytes() -> None:
    oversized_line = b'{"id":1,"padding":"' + b"x" * 400 + b'"}\n'
    report = convert_aether_platform_message_history(
        io.BytesIO(oversized_line),
        source_namespace=_NAMESPACE,
        settings=MigrationSettings(max_artifact_bytes=1_000, max_line_bytes=100),
    )
    assert report.input_rows == 1
    assert report.accepted_rows == 0
    assert report.quarantine_reasons == {"source_row_too_large": 1}

    with pytest.raises(AetherConversionError) as error:
        convert_aether_platform_message_history(
            io.BytesIO(oversized_line),
            source_namespace=_NAMESPACE,
            settings=MigrationSettings(max_artifact_bytes=128, max_line_bytes=100),
        )
    assert error.value.code == "SOURCE_ARTIFACT_TOO_LARGE"


def test_cli_defaults_to_dry_run_and_never_overwrites_an_existing_output(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source_path = tmp_path / "aether-export.jsonl"
    output_path = tmp_path / "canonical-import.jsonl"
    source_path.write_bytes(_jsonl([_source_row()]))

    assert main(["--input", str(source_path), "--source-namespace", _NAMESPACE]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["mode"] == "dry_run"
    assert summary["acceptedRows"] == 1
    assert not output_path.exists()

    assert (
        main(
            [
                "--input",
                str(source_path),
                "--source-namespace",
                _NAMESPACE,
                "--output",
                str(output_path),
            ]
        )
        == 0
    )
    written = output_path.read_bytes()
    assert json.loads(written.splitlines()[0])["recordCount"] == 1
    assert (
        main(
            [
                "--input",
                str(source_path),
                "--source-namespace",
                _NAMESPACE,
                "--output",
                str(output_path),
            ]
        )
        == 2
    )
    assert output_path.read_bytes() == written


def test_namespace_must_be_an_opaque_stable_alias() -> None:
    with pytest.raises(AetherConversionError) as error:
        convert_aether_platform_message_history(io.BytesIO(b""), source_namespace="user-123")
    assert error.value.code == "SOURCE_NAMESPACE_INVALID"
