"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 jsonl.py                                                         │
│  Module: cyrene_navigator.work.conversation_migration.jsonl           │
│  Role: Bounded, seekable reader for the explicit migration JSONL v1. │
│                                                                      │
│  模块职责：分页读取严格版本化的导入文件，校验摘要并拒绝未知字段。       │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import io
import json
import re
from collections.abc import Mapping
from typing import BinaryIO

from .models import MigrationSettings
from .ports import SourceLine, SourcePage

_DIGEST = re.compile(r"(?:sha256:)?([a-f0-9]{64})\Z")
_SOURCE_KIND = re.compile(r"[a-z][a-z0-9._/-]{0,63}\Z")
_MAX_CURSOR = 20


class JsonLinesMigrationSource:
    """Read a host-opened artifact as bounded pages; never accepts a path string."""

    def __init__(
        self,
        stream: BinaryIO,
        *,
        artifact_id: str,
        expected_sha256: str,
        settings: MigrationSettings | None = None,
    ) -> None:
        """Bind the file-like stream to one host-resolved ArtifactRef digest."""

        self._stream = stream
        self._artifact_id = _required_text(artifact_id, "artifact_id", 512)
        digest_match = _DIGEST.fullmatch(expected_sha256)
        if digest_match is None:
            raise ValueError("expected_sha256 must be a lowercase SHA-256 digest")
        self._expected_sha256 = digest_match.group(1)
        self._settings = settings or MigrationSettings()
        self._header: dict[str, object] | None = None
        self._header_end = 0
        self._verified = False
        try:
            if not stream.seekable():
                raise ValueError("migration source stream must be seekable")
            stream.seek(0)
        except (AttributeError, OSError) as error:
            raise ValueError("migration source stream must be seekable") from error

    @property
    def artifact_id(self) -> str:
        """Return the opaque host artifact identity, never a filesystem locator."""

        return self._artifact_id

    @property
    def expected_sha256(self) -> str:
        """Return the verified source digest in lowercase hexadecimal form."""

        return self._expected_sha256

    @property
    def header(self) -> Mapping[str, object]:
        """Return the validated JSONL header after an explicit verification pass."""

        if self._header is None:
            raise ValueError("migration source must be verified before reading")
        return dict(self._header)

    def verify(self) -> None:
        """Hash the entire bounded artifact, then validate its exact header row."""

        digest = hashlib.sha256()
        byte_count = 0
        snapshot = bytearray()
        try:
            self._stream.seek(0)
            while chunk := self._stream.read(64 * 1024):
                if not isinstance(chunk, bytes):
                    raise ValueError("migration source must be opened in binary mode")
                byte_count += len(chunk)
                if byte_count > self._settings.max_artifact_bytes:
                    raise ValueError("migration artifact exceeds the configured size limit")
                digest.update(chunk)
                snapshot.extend(chunk)
        except OSError as error:
            raise ValueError("migration artifact could not be read") from error
        if byte_count == 0 or digest.hexdigest() != self._expected_sha256:
            raise ValueError("migration artifact digest does not match its ArtifactRef")
        self._stream = io.BytesIO(snapshot)
        self._header = None
        self._header_end = 0
        self._read_header()
        self._verified = True
        self._stream.seek(0)

    def read_page(self, cursor: str | None, limit: int) -> SourcePage:
        """Read at most ``limit`` record rows and return a byte-offset cursor."""

        if not self._verified or self._header is None:
            raise ValueError("migration source must be verified before reading")
        if type(limit) is not int or not 1 <= limit <= self._settings.max_page_records:
            raise ValueError("page limit exceeds the configured bound")
        offset = self._cursor_offset(cursor)
        if offset == 0:
            offset = self._header_end
        elif offset < self._header_end:
            raise ValueError("page cursor precedes the first record")
        try:
            self._stream.seek(offset)
        except OSError as error:
            raise ValueError("page cursor is not seekable") from error

        items: list[SourceLine] = []
        while len(items) < limit:
            row, eof, too_large = self._read_bounded_line()
            if eof:
                break
            cursor_after = str(self._stream.tell())
            if too_large:
                items.append(SourceLine(None, cursor_after, "record_too_large"))
                continue
            assert row is not None
            if not row.strip():
                items.append(SourceLine(None, cursor_after, "blank_record"))
                continue
            try:
                value = json.loads(
                    row,
                    object_pairs_hook=_unique_object,
                    parse_constant=_reject_constant,
                )
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                items.append(SourceLine(None, cursor_after, "invalid_json"))
                continue
            items.append(SourceLine(value, cursor_after))

        position = self._stream.tell()
        end = self._stream.seek(0, 2)
        next_cursor = None if position >= end else str(position)
        self._stream.seek(position)
        return SourcePage(tuple(items), next_cursor)

    def _read_header(self) -> None:
        """Validate the only accepted header shape and its bounded record count."""

        self._stream.seek(0)
        row, eof, too_large = self._read_bounded_line()
        if eof or too_large or row is None or not row.strip():
            raise ValueError("migration JSONL header is missing")
        try:
            value = json.loads(
                row,
                object_pairs_hook=_unique_object,
                parse_constant=_reject_constant,
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            raise ValueError("migration JSONL header is invalid") from error
        if (
            not isinstance(value, Mapping)
            or set(value) != {"recordType", "schemaVersion", "sourceKind", "recordCount"}
            or value.get("recordType") != "header"
            or type(value.get("schemaVersion")) is not int
            or value.get("schemaVersion") != 1
            or not isinstance(value.get("sourceKind"), str)
            or _SOURCE_KIND.fullmatch(str(value.get("sourceKind"))) is None
            or type(value.get("recordCount")) is not int
            or not 0 <= int(value["recordCount"]) <= self._settings.max_records
        ):
            raise ValueError("migration JSONL header has an unsupported shape")
        self._header = dict(value)
        self._header_end = self._stream.tell()

    def _read_bounded_line(self) -> tuple[bytes | None, bool, bool]:
        """Read one line without retaining content beyond the configured limit."""

        raw = self._stream.readline(self._settings.max_line_bytes + 1)
        if raw == b"":
            return None, True, False
        if len(raw) <= self._settings.max_line_bytes:
            return raw.rstrip(b"\r\n"), False, False
        has_newline = raw.endswith(b"\n")
        while not has_newline:
            chunk = self._stream.readline(min(self._settings.max_line_bytes + 1, 64 * 1024))
            if chunk == b"":
                break
            has_newline = chunk.endswith(b"\n")
        return None, False, True

    def _cursor_offset(self, cursor: str | None) -> int:
        """Reject noncanonical or out-of-artifact byte offsets."""

        if cursor is None:
            return 0
        if (
            not isinstance(cursor, str)
            or len(cursor) > _MAX_CURSOR
            or re.fullmatch(r"0|[1-9][0-9]{0,18}", cursor) is None
        ):
            raise ValueError("migration page cursor is invalid")
        value = int(cursor)
        if value > self._settings.max_artifact_bytes:
            raise ValueError("migration page cursor exceeds the artifact bound")
        return value


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Reject duplicate JSON object keys instead of silently taking the last value."""

    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("JSON object contains duplicate fields")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    """Reject JavaScript NaN and infinity extensions to JSON."""

    raise ValueError(f"unsupported JSON constant: {value}")


def _required_text(value: object, name: str, maximum: int) -> str:
    """Require bounded text for host artifact metadata."""

    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{name} must be bounded non-empty text")
    return value
