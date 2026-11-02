"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 aether_convert.py                                                │
│  Module: cyrene_navigator.work.conversation_migration.aether_convert  │
│  Role: Convert bounded Aether history exports to canonical JSONL.   │
│                                                                      │
│  模块职责：离线转换 Aether 纯文本历史，不连接源数据库或导入凭据。     │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import BinaryIO

from .models import MigrationSettings
from .records import canonical_json

AETHER_SOURCE_KIND = "aether.platform_message_history"
_NAMESPACE = re.compile(r"[A-Za-z0-9_-]{16,128}\Z")
_SOURCE_ROW_FIELDS = {
    "id",
    "platform_id",
    "user_id",
    "content",
    "created_at",
    "updated_at",
    "sender_id",
    "sender_name",
    "llm_checkpoint_id",
}
_REQUIRED_SOURCE_ROW_FIELDS = {"id", "platform_id", "user_id", "content", "created_at"}
_AETHER_CONTENT_FIELDS = {
    "type",
    "history_scope",
    "bot_account_id",
    "persona_id",
    "conversation_kind",
    "message",
    "source_message_ids",
    "source_timestamp",
    "source_messages",
    "memory_source_dependencies",
    "local_profile_revisions",
    "native_message_id",
    "native_target",
    "delivery_confirmation",
}
_SENSITIVE_KEYS = {
    "access_token",
    "api_key",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "login",
    "login_state",
    "password",
    "private_key",
    "refresh_token",
    "running_task",
    "session_cookie",
    "session_state",
    "session_token",
    "token",
}


class AetherConversionError(ValueError):
    """A bounded source export cannot be converted without guessing. | 源格式不明确时拒绝转换。"""

    def __init__(self, code: str, detail: str) -> None:
        """Keep conversion errors free of source row contents and identity values."""

        super().__init__(detail)
        self.code = code


@dataclass(frozen=True, slots=True)
class AetherConversionReport:
    """Sanitized output and reconciled conversion counts. | 保存安全产物与对账计数。"""

    content: bytes = field(repr=False)
    sha256: str
    input_bytes: int
    input_rows: int
    accepted_rows: int
    quarantine_reasons: Mapping[str, int]


def convert_aether_platform_message_history(
    stream: BinaryIO,
    *,
    source_namespace: str,
    settings: MigrationSettings | None = None,
) -> AetherConversionReport:
    """Convert Aether's text-only message-history export into migration JSONL v1.

    Args:
        stream: Binary JSONL export containing only selected table columns.
        source_namespace: Stable opaque batch namespace used to pseudonymize source IDs.
        settings: Existing hard bounds for artifact bytes, row count, and line size.
    Returns:
        Canonical JSONL bytes, its digest, and privacy-safe accepted/quarantine counts.
    Raises:
        AetherConversionError: If file or output limits are exceeded or the stream is invalid.

    中文：仅接受离线导出的 `platform_message_history` 行；不访问 Aether 数据库。
    """

    limits = settings or MigrationSettings()
    if not isinstance(source_namespace, str) or _NAMESPACE.fullmatch(source_namespace) is None:
        raise AetherConversionError(
            "SOURCE_NAMESPACE_INVALID", "A stable opaque source namespace is required."
        )

    # ── Phase 1: Read bounded rows and quarantine unsupported records ──
    # 第一阶段 有界读取源行并按固定原因隔离不支持的记录。
    accepted: list[bytes] = []
    quarantine: Counter[str] = Counter()
    seen_source_ids: set[str] = set()
    input_bytes = 0
    input_rows = 0
    accepted_bytes = 0

    while True:
        line, eof, consumed_bytes, too_large = _read_bounded_line(stream, limits.max_line_bytes)
        if eof:
            break
        input_bytes += consumed_bytes
        if input_bytes > limits.max_artifact_bytes:
            raise AetherConversionError(
                "SOURCE_ARTIFACT_TOO_LARGE", "Aether export exceeds the configured byte bound."
            )
        input_rows += 1
        if input_rows > limits.max_records:
            raise AetherConversionError(
                "SOURCE_ROW_COUNT_TOO_LARGE", "Aether export exceeds the configured row bound."
            )
        if too_large:
            quarantine["source_row_too_large"] += 1
            continue
        if line is None or not line.strip():
            quarantine["blank_source_row"] += 1
            continue
        try:
            row = json.loads(
                line.decode("utf-8"),
                object_pairs_hook=_unique_object,
                parse_constant=_reject_constant,
            )
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError):
            quarantine["invalid_source_json"] += 1
            continue

        record, reason = _convert_row(
            row,
            source_namespace,
            seen_source_ids,
            max_text_chars=limits.max_text_chars,
        )
        if reason is not None:
            quarantine[reason] += 1
            continue
        assert record is not None
        encoded = canonical_json(record) + b"\n"
        if len(encoded) > limits.max_line_bytes:
            quarantine["converted_record_too_large"] += 1
            continue
        if accepted_bytes + len(encoded) + 256 > limits.max_artifact_bytes:
            raise AetherConversionError(
                "CONVERTED_ARTIFACT_TOO_LARGE",
                "Converted JSONL exceeds the configured artifact bound; split the source export.",
            )
        accepted.append(encoded)
        accepted_bytes += len(encoded)

    # ── Phase 2: Emit and digest the closed migration JSONL envelope ───
    # 第二阶段 写入封闭格式的规范 JSONL 首行并计算摘要。
    header = canonical_json(
        {
            "recordType": "header",
            "schemaVersion": 1,
            "sourceKind": AETHER_SOURCE_KIND,
            "recordCount": len(accepted),
        }
    )
    content = b"\n".join((header, *(row.rstrip(b"\n") for row in accepted))) + b"\n"
    if len(content) > limits.max_artifact_bytes:
        raise AetherConversionError(
            "CONVERTED_ARTIFACT_TOO_LARGE",
            "Converted JSONL exceeds the configured artifact bound; split the source export.",
        )
    return AetherConversionReport(
        content=content,
        sha256=hashlib.sha256(content).hexdigest(),
        input_bytes=input_bytes,
        input_rows=input_rows,
        accepted_rows=len(accepted),
        quarantine_reasons=dict(sorted(quarantine.items())),
    )


def main(argv: Sequence[str] | None = None) -> int:
    """Run a local dry-run or create one new artifact. | 默认只预演，不覆盖输出文件。"""

    parser = argparse.ArgumentParser(
        description="Convert an offline Aether platform_message_history JSONL export."
    )
    parser.add_argument("--input", required=True, type=Path, help="offline JSONL row export")
    parser.add_argument(
        "--source-namespace",
        required=True,
        help="stable opaque ID namespace (not a credential or source identity)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="new output path; omitted means dry-run counts only",
    )
    arguments = parser.parse_args(argv)

    try:
        with arguments.input.open("rb") as source:
            report = convert_aether_platform_message_history(
                source,
                source_namespace=arguments.source_namespace,
            )
        if arguments.output is not None:
            if arguments.input.resolve() == arguments.output.resolve():
                raise AetherConversionError(
                    "OUTPUT_EQUALS_INPUT", "Output must not replace the source export."
                )
            _write_new_artifact(arguments.output, report.content)
        summary = {
            "sourceKind": AETHER_SOURCE_KIND,
            "inputBytes": report.input_bytes,
            "inputRows": report.input_rows,
            "acceptedRows": report.accepted_rows,
            "quarantinedRows": sum(report.quarantine_reasons.values()),
            "quarantineReasons": report.quarantine_reasons,
            "outputBytes": len(report.content),
            "outputSha256": report.sha256,
            "mode": "written" if arguments.output is not None else "dry_run",
        }
        sys.stdout.write(json.dumps(summary, sort_keys=True, separators=(",", ":")) + "\n")
    except (OSError, AetherConversionError) as error:
        code = error.code if isinstance(error, AetherConversionError) else "IO_ERROR"
        sys.stderr.write(f"{code}: offline conversion failed\n")
        return 2
    return 0


def _convert_row(
    value: object,
    source_namespace: str,
    seen_source_ids: set[str],
    *,
    max_text_chars: int,
) -> tuple[dict[str, object] | None, str | None]:
    """Map one allowlisted row and drop source identity fields. | 只保留可移植文本。"""

    if not isinstance(value, Mapping):
        return None, "source_row_not_object"
    row_id = _source_row_id(value.get("id"))
    if row_id is not None and row_id in seen_source_ids:
        return None, "duplicate_source_row_id"
    if row_id is not None:
        seen_source_ids.add(row_id)
    if set(value) - _SOURCE_ROW_FIELDS:
        return None, "unsupported_source_row_fields"
    if not _REQUIRED_SOURCE_ROW_FIELDS.issubset(value):
        return None, "missing_source_row_fields"
    if row_id is None:
        return None, "invalid_source_row_id"

    platform_id = _bounded_source_text(value.get("platform_id"), 256)
    source_conversation = _bounded_source_text(value.get("user_id"), 512)
    content = value.get("content")
    if platform_id is None or source_conversation is None:
        return None, "invalid_source_conversation"
    if not isinstance(content, Mapping):
        return None, "invalid_aether_content"
    if set(content) - _AETHER_CONTENT_FIELDS or _contains_sensitive_key(content):
        return None, "unsupported_or_sensitive_aether_content"

    role_type = content.get("type")
    if not isinstance(role_type, str):
        return None, "unsupported_aether_message_type"
    role = {"user": "user", "bot": "assistant"}.get(role_type)
    if role is None:
        return None, "unsupported_aether_message_type"
    conversation_kind = content.get("conversation_kind")
    if not isinstance(conversation_kind, str):
        return None, "unsupported_aether_conversation_kind"
    kind = {"private": "direct", "group": "group"}.get(conversation_kind)
    if kind is None:
        return None, "unsupported_aether_conversation_kind"
    history_scope, invalid_history_scope = _optional_source_text(content.get("history_scope"), 512)
    persona_id, invalid_persona_id = _optional_source_text(content.get("persona_id"), 512)
    bot_account_id, invalid_bot_account_id = _optional_source_text(
        content.get("bot_account_id"), 256
    )
    if invalid_history_scope or invalid_persona_id or invalid_bot_account_id:
        return None, "invalid_aether_scope_metadata"

    message_parts = content.get("message")
    if not isinstance(message_parts, list) or len(message_parts) != 1:
        return None, "unsupported_aether_message_payload"
    message = message_parts[0]
    message_text = message.get("text") if isinstance(message, Mapping) else None
    if (
        not isinstance(message, Mapping)
        or set(message) != {"type", "text"}
        or message.get("type") != "Plain"
        or not isinstance(message_text, str)
        or not message_text.strip()
    ):
        return None, "unsupported_aether_message_payload"
    if len(message_text) > max_text_chars:
        return None, "aether_message_too_large"
    try:
        message_text.encode("utf-8")
    except UnicodeEncodeError:
        return None, "invalid_aether_message_text"

    occurred_at = _timestamp_ms(content.get("source_timestamp"))
    if occurred_at is None:
        occurred_at = _timestamp_ms(value.get("created_at"))
    if occurred_at is None:
        return None, "invalid_aether_timestamp"

    conversation_id = _opaque_id(
        source_namespace,
        "conversation",
        platform_id,
        source_conversation,
        history_scope,
        bot_account_id,
        persona_id,
        conversation_kind,
    )
    safe_persona_id = (
        _opaque_id(source_namespace, "persona", persona_id) if persona_id is not None else None
    )
    record_id = _opaque_id(
        source_namespace,
        "message",
        platform_id,
        source_conversation,
        row_id,
    )
    visibility = "conversation" if kind == "group" else "private"
    return (
        {
            "recordType": "message",
            "recordId": record_id,
            "conversationId": conversation_id,
            "conversationKind": kind,
            "personaId": safe_persona_id,
            "visibility": visibility,
            "sourceRecordIds": [],
            "validUntil": None,
            "role": role,
            "content": message_text,
            "occurredAt": occurred_at,
        },
        None,
    )


def _read_bounded_line(
    stream: BinaryIO,
    maximum_bytes: int,
) -> tuple[bytes | None, bool, int, bool]:
    """Read one bounded input line while draining an oversized line safely."""

    chunk = stream.readline(maximum_bytes + 1)
    if not isinstance(chunk, bytes):
        raise AetherConversionError("BINARY_INPUT_REQUIRED", "Source export must be binary.")
    if not chunk:
        return None, True, 0, False
    consumed = len(chunk)
    if len(chunk) <= maximum_bytes:
        return chunk.rstrip(b"\r\n"), False, consumed, False
    while not chunk.endswith(b"\n"):
        chunk = stream.readline(min(maximum_bytes + 1, 64 * 1024))
        if not isinstance(chunk, bytes):
            raise AetherConversionError("BINARY_INPUT_REQUIRED", "Source export must be binary.")
        if not chunk:
            break
        consumed += len(chunk)
    return None, False, consumed, True


def _write_new_artifact(path: Path, content: bytes) -> None:
    """Create a complete new output file or remove the partial file on write failure."""

    created = False
    try:
        with path.open("xb") as destination:
            created = True
            destination.write(content)
            destination.flush()
            os.fsync(destination.fileno())
    except OSError:
        if created:
            path.unlink(missing_ok=True)
        raise


def _source_row_id(value: object) -> str | None:
    """Normalize only positive integer primary keys from the Aether source table."""

    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value) if value > 0 else None
    if isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,18}", value):
        return value
    return None


def _bounded_source_text(value: object, maximum: int) -> str | None:
    """Accept bounded source key text only for hashing, never for output."""

    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        return None
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return None
    return value


def _optional_source_text(value: object, maximum: int) -> tuple[str | None, bool]:
    """Validate nullable source metadata and report malformed values explicitly."""

    if value is None:
        return None, False
    text = _bounded_source_text(value, maximum)
    return text, text is None


def _opaque_id(namespace: str, kind: str, *parts: object) -> str:
    """Derive a stable scoped identifier without copying source identities to JSONL."""

    digest = hashlib.sha256(canonical_json([namespace, kind, *parts])).hexdigest()
    return f"aether-{kind}-{digest}"


def _timestamp_ms(value: object) -> int | None:
    """Parse Aether ISO timestamps, treating its documented naive SQL values as UTC."""

    if not isinstance(value, str) or not value.strip() or len(value) > 64:
        return None
    try:
        normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    try:
        utc_value = parsed.astimezone(UTC)
        epoch = datetime(1970, 1, 1, tzinfo=UTC)
        elapsed = utc_value - epoch
        return (elapsed.days * 86_400 + elapsed.seconds) * 1_000 + elapsed.microseconds // 1_000
    except (OverflowError, OSError, ValueError):
        return None


def _contains_sensitive_key(value: object) -> bool:
    """Reject credential and active-task fields recursively without echoing their values."""

    if isinstance(value, Mapping):
        for key, child in value.items():
            normalized = re.sub(r"[^a-z0-9]+", "_", str(key).lower()).strip("_")
            if normalized in _SENSITIVE_KEYS or _contains_sensitive_key(child):
                return True
    elif isinstance(value, list):
        return any(_contains_sensitive_key(item) for item in value)
    return False


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Reject duplicate JSON keys so no source value is silently overwritten."""

    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("JSON object contains duplicate keys")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    """Reject NaN and Infinity extensions that are not valid JSON values."""

    raise ValueError(f"unsupported JSON constant: {value}")


if __name__ == "__main__":
    raise SystemExit(main())
