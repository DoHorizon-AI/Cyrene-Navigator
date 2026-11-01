"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 backup.py                                                        │
│  Module: cyrene_navigator.work.conversation_migration.backup          │
│  Role: Build and validate portable actor-scoped conversation backups.│
│                                                                      │
│  模块职责：转换现有 memory/domain 导出为无身份、无授权的便携归档。     │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from .models import ActorScope, MigrationError, MigrationRecord, MigrationSettings
from .ports import SourceLine, SourcePage
from .records import canonical_json, normalize_record

BACKUP_FORMAT = "cyrene.navigator.conversation-backup.v1"
_DIGEST = re.compile(r"[a-f0-9]{64}\Z")
_MAX_MEMORY_MESSAGE_FIELDS = {
    "message_id",
    "event_id",
    "conversation_id",
    "conversation_kind",
    "persona_id",
    "visibility",
    "role",
    "content",
    "source_refs_json",
    "attachments_json",
    "payload_digest",
    "status",
    "occurred_at",
    "created_at",
    "revoked_at",
}
_MAX_MEMORY_ITEM_FIELDS = {
    "memory_id",
    "idempotency_key",
    "conversation_id",
    "conversation_kind",
    "persona_id",
    "visibility",
    "memory_kind",
    "text",
    "source_message_ids_json",
    "source_refs_json",
    "payload_digest",
    "version",
    "state",
    "index_state",
    "authorization_epoch",
    "valid_until",
    "created_at",
    "updated_at",
}
_KNOWN_MEMORY_TABLES = {
    "conversation_memory_messages",
    "conversation_memory_message_sources",
    "conversation_memory_message_memory_sources",
    "conversation_memory_items",
    "conversation_memory_item_sources",
    "conversation_memory_item_memory_sources",
    "conversation_memory_source_grants",
}
_KNOWN_DOMAIN_TABLES = {
    "personas",
    "activeBehaviorPolicies",
    "profileCandidates",
    "profiles",
    "graphChangesets",
    "maintenanceJobs",
    "researchNotes",
    "verifiedSkills",
    "watches",
    "focusItems",
    "handoffs",
    "reviewEvents",
    "importBatches",
    "importRecords",
}


@dataclass(frozen=True, slots=True)
class ActorBackup:
    """Portable backup bytes and safe count metadata; content is never repr-printed."""

    content: bytes = field(repr=False)
    sha256: str
    records: tuple[MigrationRecord, ...] = field(repr=False)
    record_counts: Mapping[str, int]
    quarantined_count: int
    quarantine_reasons: Mapping[str, int]
    omitted_counts: Mapping[str, int]


class ActorBackupSource:
    """Bounded sequence reader for one already digest-verified portable backup."""

    def __init__(self, backup: ActorBackup, *, artifact_id: str) -> None:
        """Bind normalized backup records to the host's opaque artifact ID."""

        if not isinstance(artifact_id, str) or not artifact_id.strip() or len(artifact_id) > 512:
            raise ValueError("artifact_id must be bounded non-empty text")
        self._backup = backup
        self._artifact_id = artifact_id
        self._header = {
            "recordType": "header",
            "schemaVersion": 1,
            "sourceKind": "cyrene.actor-backup",
            "recordCount": len(backup.records),
        }

    @property
    def artifact_id(self) -> str:
        """Return the opaque host artifact identity."""

        return self._artifact_id

    @property
    def expected_sha256(self) -> str:
        """Return the artifact content digest verified during backup parsing."""

        return self._backup.sha256

    @property
    def header(self) -> Mapping[str, object]:
        """Return the validated record count for the portable backup."""

        return dict(self._header)

    def verify(self) -> None:
        """Reconfirm the immutable in-memory content digest before projection."""

        if hashlib.sha256(self._backup.content).hexdigest() != self._backup.sha256:
            raise MigrationError("BACKUP_DIGEST_MISMATCH", "Actor backup content changed.")

    def read_page(self, cursor: str | None, limit: int) -> SourcePage:
        """Return at most ``limit`` records using a canonical sequence cursor."""

        if type(limit) is not int or limit < 1:
            raise ValueError("page limit must be positive")
        if cursor is None:
            start = 0
        elif re.fullmatch(r"0|[1-9][0-9]{0,8}", cursor) is not None:
            start = int(cursor)
        else:
            raise ValueError("backup page cursor is invalid")
        if start > len(self._backup.records):
            raise ValueError("backup page cursor is past the final record")
        stop = min(start + limit, len(self._backup.records))
        lines = tuple(
            SourceLine(_record_to_json(record), str(index + 1))
            for index, record in enumerate(self._backup.records[start:stop], start)
        )
        return SourcePage(lines, str(stop) if stop < len(self._backup.records) else None)


def build_actor_backup(
    scope: ActorScope,
    memory_export: bytes,
    domain_export: bytes,
    *,
    created_at: int,
    settings: MigrationSettings | None = None,
) -> ActorBackup:
    """Build a portable archive from current actor-scoped canonical store exports.

    Args:
        scope: Target actor scope supplied by the authenticated host.
        memory_export: Bounded JSON bytes from the canonical conversation memory store.
        domain_export: Bounded JSON bytes from the canonical conversation domain store.
        created_at: Host time in Unix milliseconds.
        settings: Optional hard parser and artifact bounds.
    Returns:
        Portable backup content, digest, and reconciled safe record counts.
    Raises:
        MigrationError: If an export is malformed, too large, or has unsupported tables.
    """

    limits = settings or MigrationSettings()
    if type(created_at) is not int or created_at < 0:
        raise MigrationError("BACKUP_TIME_INVALID", "Backup timestamp is invalid.")
    memory = _parse_store_export(
        memory_export,
        "memory",
        limits,
        expected_scope_digest=_component_scope_digest(scope, "memory"),
    )
    domains = _parse_store_export(
        domain_export,
        "domains",
        limits,
        expected_scope_digest=_component_scope_digest(scope, "domains"),
    )
    portable, omitted = _portable_records(memory, domains, limits)
    ordered, rejected = _order_records(portable, limits)
    if rejected:
        raise MigrationError(
            "BACKUP_LINEAGE_INCOMPLETE",
            "The actor backup contains missing or cyclic source references.",
        )
    raw_records = [_record_to_json(record) for record in ordered]
    scope_digest = hashlib.sha256(
        canonical_json([scope.organization_id or "", scope.workspace_id, scope.actor_id])
    ).hexdigest()
    body = {
        "format": BACKUP_FORMAT,
        "schemaVersion": 1,
        "createdAt": created_at,
        "scopeDigest": scope_digest,
        "recordCount": len(raw_records),
        "excludedCounts": omitted,
        "records": raw_records,
    }
    content = canonical_json(body)
    if not content or len(content) > limits.max_artifact_bytes:
        raise MigrationError("BACKUP_TOO_LARGE", "Actor backup exceeds the configured limit.")
    return parse_actor_backup(
        content,
        expected_sha256=hashlib.sha256(content).hexdigest(),
        settings=limits,
        omitted_counts=omitted,
    )


def parse_actor_backup(
    content: bytes,
    *,
    expected_sha256: str,
    settings: MigrationSettings | None = None,
    omitted_counts: Mapping[str, int] | None = None,
) -> ActorBackup:
    """Verify and normalize one portable backup without trusting its identity digest.

    Args:
        content: Exact bytes read from the host-authorized actor-private artifact.
        expected_sha256: SHA-256 digest from the ArtifactRef or Work attachment receipt.
        settings: Optional hard parser bounds.
        omitted_counts: Safe counts produced by the builder, never imported as state.
    Returns:
        A validated portable backup and source-linked normalized records.
    Raises:
        MigrationError: If bytes, digest, schema, order, or count reconciliation fails.
    """

    limits = settings or MigrationSettings()
    expected = _normalize_digest(expected_sha256)
    if not isinstance(content, bytes) or not content or len(content) > limits.max_artifact_bytes:
        raise MigrationError("BACKUP_TOO_LARGE", "Actor backup is empty or exceeds its limit.")
    actual = hashlib.sha256(content).hexdigest()
    if actual != expected:
        raise MigrationError("BACKUP_DIGEST_MISMATCH", "Actor backup digest does not match.")
    value = _loads_strict(content)
    required = {
        "format",
        "schemaVersion",
        "createdAt",
        "scopeDigest",
        "recordCount",
        "excludedCounts",
        "records",
    }
    if (
        not isinstance(value, Mapping)
        or set(value) != required
        or value.get("format") != BACKUP_FORMAT
        or type(value.get("schemaVersion")) is not int
        or value.get("schemaVersion") != 1
        or type(value.get("createdAt")) is not int
        or int(value["createdAt"]) < 0
        or not isinstance(value.get("scopeDigest"), str)
        or _DIGEST.fullmatch(str(value.get("scopeDigest"))) is None
        or type(value.get("recordCount")) is not int
        or not isinstance(value.get("excludedCounts"), Mapping)
        or not isinstance(value.get("records"), list)
    ):
        raise MigrationError("BACKUP_SCHEMA_INVALID", "Actor backup uses an unsupported schema.")
    records_raw = value["records"]
    excluded_counts = value["excludedCounts"]
    if (
        len(records_raw) != int(value["recordCount"])
        or len(records_raw) > limits.max_records
        or any(
            not isinstance(key, str)
            or re.fullmatch(r"[a-z][a-z0-9_]{0,63}", key) is None
            or type(count) is not int
            or not 0 <= count <= limits.max_records
            for key, count in excluded_counts.items()
        )
    ):
        raise MigrationError("BACKUP_COUNT_MISMATCH", "Actor backup record count does not match.")
    normalized: list[MigrationRecord] = []
    known: set[str] = set()
    quarantine: Counter[str] = Counter()
    for ordinal, raw in enumerate(records_raw, 1):
        record, reason = normalize_record(
            raw,
            ordinal=ordinal,
            prior_record_ids=known,
            settings=limits,
        )
        if reason is not None or record is None:
            quarantine[reason or "invalid_record"] += 1
            continue
        known.add(record.record_id)
        normalized.append(record)
    return ActorBackup(
        content=content,
        sha256=actual,
        records=tuple(normalized),
        record_counts=dict(Counter(record.kind for record in normalized)),
        quarantined_count=sum(quarantine.values()),
        quarantine_reasons=dict(quarantine),
        omitted_counts=dict(omitted_counts or excluded_counts),
    )


def _parse_store_export(
    content: bytes,
    name: str,
    settings: MigrationSettings,
    *,
    expected_scope_digest: str,
) -> Mapping[str, object]:
    """Validate one existing component export before selecting portable records."""

    if not isinstance(content, bytes) or not content or len(content) > settings.max_artifact_bytes:
        raise MigrationError(
            "BACKUP_COMPONENT_TOO_LARGE", f"The {name} backup component is invalid."
        )
    value = _loads_strict(content)
    if (
        not isinstance(value, Mapping)
        or set(value) != {"schemaVersion", "createdAt", "scopeDigest", "records"}
        or type(value.get("schemaVersion")) is not int
        or value.get("schemaVersion") != 1
        or type(value.get("createdAt")) is not int
        or not isinstance(value.get("scopeDigest"), str)
        or _DIGEST.fullmatch(str(value.get("scopeDigest"))) is None
        or not isinstance(value.get("records"), Mapping)
    ):
        raise MigrationError("BACKUP_COMPONENT_INVALID", f"The {name} export is invalid.")
    if value.get("scopeDigest") != expected_scope_digest:
        raise MigrationError(
            "BACKUP_SCOPE_MISMATCH", f"The {name} export scope does not match the host."
        )
    table_names = set(value["records"])
    known = _KNOWN_MEMORY_TABLES if name == "memory" else _KNOWN_DOMAIN_TABLES
    if table_names - known:
        raise MigrationError("BACKUP_COMPONENT_INVALID", f"The {name} export has unknown tables.")
    if any(not isinstance(rows, list) for rows in value["records"].values()):
        raise MigrationError("BACKUP_COMPONENT_INVALID", f"The {name} export has invalid rows.")
    return value


def _portable_records(
    memory: Mapping[str, object], domains: Mapping[str, object], settings: MigrationSettings
) -> tuple[list[dict[str, object]], dict[str, int]]:
    """Convert only canonical conversation data and omit grants, tasks, and staging rows."""

    memory_tables = memory["records"]
    domain_tables = domains["records"]
    assert isinstance(memory_tables, Mapping) and isinstance(domain_tables, Mapping)
    output: list[dict[str, object]] = []
    omitted: Counter[str] = Counter()
    for table, rows in memory_tables.items():
        assert isinstance(rows, list)
        if table == "conversation_memory_messages":
            for row in rows:
                if not isinstance(row, Mapping):
                    raise MigrationError(
                        "BACKUP_COMPONENT_INVALID", "Memory message row is invalid."
                    )
                if row.get("status") != "active":
                    omitted["inactive_messages"] += 1
                    continue
                if set(row) != _MAX_MEMORY_MESSAGE_FIELDS:
                    raise MigrationError(
                        "BACKUP_COMPONENT_INVALID", "Memory message fields are invalid."
                    )
                sources, _ = _portable_source_refs(
                    row.get("source_refs_json"), row.get("message_id"), "message"
                )
                # Attachments are opaque artifacts and are never cloned or reauthorized by backup.
                if _decode_json_value(row.get("attachments_json"), "attachments"):
                    omitted["message_attachments"] += 1
                output.append(
                    {
                        "recordType": "message",
                        "recordId": _record_key("message", row["message_id"]),
                        "conversationId": row["conversation_id"],
                        "conversationKind": row["conversation_kind"],
                        "personaId": row["persona_id"],
                        "visibility": row["visibility"],
                        "sourceRecordIds": sources,
                        "role": row["role"],
                        "content": row["content"],
                        "occurredAt": row["occurred_at"],
                    }
                )
        elif table == "conversation_memory_items":
            for row in rows:
                if not isinstance(row, Mapping):
                    raise MigrationError("BACKUP_COMPONENT_INVALID", "Memory item row is invalid.")
                if row.get("state") != "active":
                    omitted["inactive_memories"] += 1
                    continue
                if set(row) != _MAX_MEMORY_ITEM_FIELDS:
                    raise MigrationError(
                        "BACKUP_COMPONENT_INVALID", "Memory item fields are invalid."
                    )
                sources, _ = _portable_source_refs(
                    row.get("source_refs_json"), row.get("memory_id"), "memory"
                )
                source_message_ids = _decode_json_value(
                    row.get("source_message_ids_json"), "source message ids"
                )
                if not isinstance(source_message_ids, list):
                    raise MigrationError(
                        "BACKUP_COMPONENT_INVALID", "Memory source IDs are invalid."
                    )
                sources = sorted(
                    set(sources) | {_record_key("message", item) for item in source_message_ids}
                )
                output.append(
                    {
                        "recordType": "memory",
                        "recordId": _record_key("memory", row["memory_id"]),
                        "conversationId": row["conversation_id"],
                        "conversationKind": row["conversation_kind"],
                        "personaId": row["persona_id"],
                        "visibility": row["visibility"],
                        "sourceRecordIds": sources,
                        "validUntil": row["valid_until"],
                        "memoryKind": row["memory_kind"],
                        "text": row["text"],
                    }
                )
        elif table in {"conversation_memory_message_sources", "conversation_memory_item_sources"}:
            # These join rows are reconstructed from sourceRefs through the public write APIs.
            omitted["derived_memory_links"] += len(rows)
        else:
            # Authorization grants and memory-to-memory join tables are never imported.
            omitted["authorization_or_derived_memory_tables"] += len(rows)

    for table, rows in domain_tables.items():
        assert isinstance(rows, list)
        if table == "profileCandidates":
            for row in rows:
                if not isinstance(row, Mapping):
                    raise MigrationError(
                        "BACKUP_COMPONENT_INVALID", "Profile candidate row is invalid."
                    )
                if row.get("state") != "candidate":
                    omitted["resolved_profile_candidates"] += 1
                    continue
                output.append(_profile_to_record(row, "candidate"))
        elif table == "profiles":
            for row in rows:
                if not isinstance(row, Mapping):
                    raise MigrationError("BACKUP_COMPONENT_INVALID", "Profile row is invalid.")
                if row.get("state") != "active":
                    omitted["inactive_profiles"] += 1
                    continue
                output.append(_profile_to_record(row, "profile"))
        elif table == "graphChangesets":
            for row in rows:
                if not isinstance(row, Mapping):
                    raise MigrationError(
                        "BACKUP_COMPONENT_INVALID", "Graph changeset row is invalid."
                    )
                output.append(_graph_to_record(row, settings))
        else:
            # Operational jobs, import staging, login, policy, and unrelated domains stay behind.
            omitted[f"excluded_{_snake_case(table)}"] += len(rows)

    return output, dict(omitted)


def _profile_to_record(row: Mapping[str, object], label: str) -> dict[str, object]:
    """Normalize a stored candidate or active profile as a fresh candidate record."""

    sources, _ = _domain_source_refs(row.get("sourceRefs", []), row.get("sourceMessageIds", []))
    evidence = row.get("evidence")
    confidence = row.get("confidence", 1.0)
    if confidence == 1.0 and isinstance(evidence, Mapping):
        confidence = evidence.get("confidence", confidence)
    return {
        "recordType": "profile",
        "recordId": _record_key(label, row.get("id")),
        "conversationId": row.get("conversationId"),
        "conversationKind": row.get("conversationKind"),
        "personaId": row.get("personaId"),
        "visibility": "private",
        "sourceRecordIds": sources,
        "validUntil": row.get("validUntil"),
        "subjectKind": row.get("subjectKind"),
        "category": row.get("category"),
        "text": row.get("text"),
        "confidence": confidence,
    }


def _graph_to_record(row: Mapping[str, object], settings: MigrationSettings) -> dict[str, object]:
    """Normalize graph nodes and edges while dropping archived provider receipts/state."""

    nodes = row.get("nodes")
    edges = row.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise MigrationError("BACKUP_COMPONENT_INVALID", "Graph changeset arrays are invalid.")
    all_sources: set[str] = set()
    portable_nodes: list[dict[str, object]] = []
    portable_edges: list[dict[str, object]] = []
    for item in nodes:
        if not isinstance(item, Mapping):
            raise MigrationError("BACKUP_COMPONENT_INVALID", "Graph node is invalid.")
        sources, _ = _domain_source_refs(
            item.get("sourceRefs", []), item.get("sourceMessageIds", [])
        )
        all_sources.update(sources)
        portable_nodes.append(
            {
                "id": item.get("id"),
                "label": item.get("label"),
                "properties": item.get("properties", {}),
                "sourceRecordIds": sources,
            }
        )
    for item in edges:
        if not isinstance(item, Mapping):
            raise MigrationError("BACKUP_COMPONENT_INVALID", "Graph edge is invalid.")
        sources, _ = _domain_source_refs(
            item.get("sourceRefs", []), item.get("sourceMessageIds", [])
        )
        all_sources.update(sources)
        portable_edges.append(
            {
                "id": item.get("id"),
                "fromId": item.get("fromId"),
                "toId": item.get("toId"),
                "label": item.get("label"),
                "properties": item.get("properties", {}),
                "sourceRecordIds": sources,
            }
        )
    raw = {
        "recordType": "graph",
        "recordId": _record_key("graph", row.get("id")),
        "conversationId": row.get("conversationId"),
        "conversationKind": row.get("conversationKind"),
        "personaId": row.get("personaId"),
        "visibility": "private",
        "sourceRecordIds": sorted(all_sources),
        "nodes": portable_nodes,
        "edges": portable_edges,
    }
    encoded = canonical_json(raw)
    if len(encoded) > settings.max_line_bytes:
        raise MigrationError("BACKUP_RECORD_TOO_LARGE", "Graph backup record exceeds its limit.")
    return raw


def _portable_source_refs(
    raw: object, record_id: object, kind: str
) -> tuple[list[str], list[dict[str, object]]]:
    """Map archived memory and message identifiers to portable record references."""

    references = _decode_json_value(raw, "source refs")
    if not isinstance(references, list):
        raise MigrationError("BACKUP_COMPONENT_INVALID", "Source reference data is invalid.")
    sources: set[str] = set()
    portable: list[dict[str, object]] = []
    for ref in references:
        if not isinstance(ref, Mapping) or set(ref) != {
            "memoryId",
            "memoryVersion",
            "sourceMessageIds",
        }:
            raise MigrationError("BACKUP_COMPONENT_INVALID", "Source reference shape is invalid.")
        source_ids = ref.get("sourceMessageIds")
        memory_id = ref.get("memoryId")
        version = ref.get("memoryVersion")
        if not isinstance(source_ids, list):
            raise MigrationError("BACKUP_COMPONENT_INVALID", "Source message IDs are invalid.")
        portable_sources = [_record_key("message", source) for source in source_ids]
        memory_record = _record_key("memory", memory_id) if memory_id is not None else None
        if memory_record is not None:
            if type(version) is not int or version < 1:
                raise MigrationError(
                    "BACKUP_COMPONENT_INVALID", "Source memory version is invalid."
                )
            sources.add(memory_record)
        sources.update(portable_sources)
        portable.append(
            {
                "sourceRecordIds": portable_sources,
                "memoryRecordId": memory_record,
                "memoryVersion": version,
            }
        )
    if not references and kind == "message":
        return [], []
    return sorted(sources), portable


def _domain_source_refs(
    raw_refs: object, raw_message_ids: object
) -> tuple[list[str], list[dict[str, object]]]:
    """Convert public domain source views to portable IDs without carrying grants."""

    if not isinstance(raw_refs, list) or not isinstance(raw_message_ids, list):
        raise MigrationError("BACKUP_COMPONENT_INVALID", "Domain source references are invalid.")
    sources: set[str] = {_record_key("message", item) for item in raw_message_ids}
    portable: list[dict[str, object]] = []
    for ref in raw_refs:
        if not isinstance(ref, Mapping):
            raise MigrationError("BACKUP_COMPONENT_INVALID", "Domain source reference is invalid.")
        memory_id = ref.get("memoryId")
        version = ref.get("memoryVersion")
        raw_sources = ref.get("sourceMessageIds", [])
        if not isinstance(raw_sources, list):
            raise MigrationError(
                "BACKUP_COMPONENT_INVALID", "Domain source message IDs are invalid."
            )
        portable_sources = [_record_key("message", item) for item in raw_sources]
        memory_record = _record_key("memory", memory_id) if memory_id is not None else None
        if memory_record is not None:
            if type(version) is not int or version < 1:
                raise MigrationError(
                    "BACKUP_COMPONENT_INVALID", "Domain source memory version is invalid."
                )
            sources.add(memory_record)
        sources.update(portable_sources)
        portable.append(
            {
                "sourceRecordIds": portable_sources,
                "memoryRecordId": memory_record,
                "memoryVersion": version,
            }
        )
    return sorted(sources), portable


def _order_records(
    raw_records: Sequence[dict[str, object]], settings: MigrationSettings
) -> tuple[list[MigrationRecord], Counter[str]]:
    """Topologically order source records while dropping invalid derived rows safely."""

    pending: dict[str, dict[str, object]] = {}
    rejected: Counter[str] = Counter()
    for raw in raw_records:
        record_id = raw.get("recordId")
        if not isinstance(record_id, str) or record_id in pending:
            rejected["duplicate_or_invalid_id"] += 1
            continue
        pending[record_id] = raw
    accepted: list[MigrationRecord] = []
    known: set[str] = set()
    while pending:
        advanced = False
        for record_id, raw in list(pending.items()):
            dependencies = raw.get("sourceRecordIds")
            if not isinstance(dependencies, list):
                rejected["invalid_source_refs"] += 1
                del pending[record_id]
                continue
            missing = [item for item in dependencies if item not in pending and item not in known]
            if missing:
                rejected["missing_source"] += 1
                del pending[record_id]
                continue
            if any(item not in known for item in dependencies):
                continue
            normalized, reason = normalize_record(
                raw, ordinal=len(accepted) + 1, prior_record_ids=known, settings=settings
            )
            del pending[record_id]
            advanced = True
            if reason is not None or normalized is None:
                rejected[reason or "invalid_record"] += 1
                continue
            accepted.append(normalized)
            known.add(normalized.record_id)
        if not advanced:
            rejected["cyclic_source_refs"] += len(pending)
            break
    return accepted, rejected


def _record_to_json(record: MigrationRecord) -> dict[str, object]:
    """Return one deterministic portable record without private runtime fields."""

    return {
        "recordType": record.kind,
        "recordId": record.record_id,
        "conversationId": record.conversation_id,
        "conversationKind": record.conversation_kind,
        "personaId": record.persona_id,
        "visibility": record.visibility,
        "sourceRecordIds": list(record.source_record_ids),
        "validUntil": record.valid_until,
        **dict(record.data),
    }


def _decode_json_value(value: object, label: str) -> object:
    """Decode one stored JSON value with duplicate-key and non-finite rejection."""

    if not isinstance(value, str):
        raise MigrationError("BACKUP_COMPONENT_INVALID", f"Stored {label} is not JSON text.")
    try:
        return json.loads(value, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (json.JSONDecodeError, ValueError) as error:
        raise MigrationError("BACKUP_COMPONENT_INVALID", f"Stored {label} is invalid.") from error


def _loads_strict(content: bytes) -> object:
    """Decode UTF-8 JSON while rejecting duplicate keys and non-finite values."""

    try:
        return json.loads(
            content,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise MigrationError("BACKUP_JSON_INVALID", "Actor backup JSON is invalid.") from error


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Reject ambiguous JSON fields."""

    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    """Reject NaN and infinity JSON extensions."""

    raise ValueError(f"unsupported JSON constant: {value}")


def _record_key(kind: str, value: object) -> str:
    """Build a source-local record key without importing any source scope identity."""

    if not isinstance(value, str) or not value.strip() or len(value) > 160:
        raise MigrationError("BACKUP_COMPONENT_INVALID", "Stored source ID is invalid.")
    return f"{kind}:{value}"


def _snake_case(value: str) -> str:
    """Normalize export table labels into bounded lowercase audit count keys."""

    return re.sub(r"[^a-z0-9]+", "_", re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", value).lower()).strip(
        "_"
    )


def _normalize_digest(value: str) -> str:
    """Accept a lowercase SHA-256 digest with or without its standard prefix."""

    match = re.fullmatch(r"(?:sha256:)?([a-f0-9]{64})", value)
    if match is None:
        raise MigrationError("BACKUP_DIGEST_INVALID", "Expected SHA-256 digest is invalid.")
    return match.group(1)


def _component_scope_digest(scope: ActorScope, component: str) -> str:
    """Recompute the component-specific scope commitment without exporting identity."""

    if component == "memory":
        fields = {
            "organizationId": scope.organization_id or "",
            "workspaceId": scope.workspace_id,
            "actorId": scope.actor_id,
        }
    elif component == "domains":
        organization = scope.organization_id
        if organization is None:
            organization = (
                "legacy-"
                + hashlib.sha256(f"{scope.workspace_id}\0{scope.actor_id}".encode()).hexdigest()[
                    :32
                ]
            )
        fields = {"org": organization, "workspace": scope.workspace_id, "actor": scope.actor_id}
    else:
        raise ValueError("unknown backup component")
    return hashlib.sha256(canonical_json(fields)).hexdigest()
