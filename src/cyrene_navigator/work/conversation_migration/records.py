"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 records.py                                                       │
│  Module: cyrene_navigator.work.conversation_migration.records         │
│  Role: Strictly validate and digest one portable migration record.   │
│                                                                      │
│  模块职责：按封闭白名单解析记录，拒绝身份、凭据、授权与活动任务字段。  │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping, Sequence
from typing import cast

from .models import MigrationRecord, MigrationSettings, RecordKind

_IDENTIFIER = re.compile(r"[^\s\x00-\x1f]{1,512}\Z")
_SENSITIVE_KEYS = {
    "active",
    "active_state",
    "actor_id",
    "api_key",
    "approved",
    "access_token",
    "authorization_state",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "private_key",
    "secret_key",
    "login_state",
    "login",
    "password",
    "principal_refs",
    "principal_ref",
    "organization_id",
    "refresh_token",
    "running_task",
    "session_cookie",
    "session",
    "session_state",
    "session_token",
    "task_status",
    "task_id",
    "token",
    "user_id",
    "workspace_id",
}
_MESSAGE_FIELDS = {"role", "content", "occurredAt"}
_MEMORY_FIELDS = {"memoryKind", "text"}
_PROFILE_FIELDS = {"subjectKind", "category", "text", "confidence"}
_GRAPH_FIELDS = {"nodes", "edges"}


def normalize_record(
    value: object,
    *,
    ordinal: int,
    prior_record_ids: set[str],
    settings: MigrationSettings,
) -> tuple[MigrationRecord | None, str | None]:
    """Validate one JSON-compatible record and return a privacy-safe reason on rejection.

    Args:
        value: One parsed JSON row from the host-resolved staged artifact.
        ordinal: One-based source row ordinal for count reconciliation only.
        prior_record_ids: IDs of already accepted rows in the source order.
        settings: Hard parser bounds shared by preview, import, and restore.
    Returns:
        A normalized record, or ``None`` plus a non-sensitive quarantine code.
    """

    if not isinstance(value, Mapping):
        return None, "record_not_object"
    if _contains_sensitive_key(value):
        return None, "sensitive_field"
    common = {
        "recordType",
        "recordId",
        "conversationId",
        "conversationKind",
        "visibility",
        "sourceRecordIds",
    }
    record_type = value.get("recordType")
    fields_by_type = {
        "message": _MESSAGE_FIELDS,
        "memory": _MEMORY_FIELDS,
        "profile": _PROFILE_FIELDS,
        "graph": _GRAPH_FIELDS,
    }
    payload_fields = fields_by_type.get(record_type) if isinstance(record_type, str) else None
    if payload_fields is None:
        return None, "unsupported_record_type"
    allowed = common | payload_fields | {"personaId", "validUntil"}
    if set(value) - allowed or not common.issubset(value):
        return None, "unsupported_fields"
    if (
        "personaId" in value
        and value["personaId"] is not None
        and not _valid_identifier(value["personaId"], 512)
    ):
        return None, "invalid_persona_ref"
    if (
        "validUntil" in value
        and value["validUntil"] is not None
        and (type(value["validUntil"]) is not int or value["validUntil"] < 0)
    ):
        return None, "invalid_expiry"

    record_id = value.get("recordId")
    if not _valid_identifier(record_id, 200):
        return None, "invalid_record_id"
    if record_id in prior_record_ids:
        return None, "duplicate_record_id"
    conversation_id = value.get("conversationId")
    if not _valid_identifier(conversation_id, 512):
        return None, "invalid_conversation_ref"
    conversation_kind = value.get("conversationKind")
    if conversation_kind not in {"direct", "group", "channel"}:
        return None, "invalid_conversation_kind"
    visibility = value.get("visibility")
    if visibility not in {"private", "conversation", "workspace"}:
        return None, "invalid_visibility"
    raw_sources = value.get("sourceRecordIds")
    if (
        not isinstance(raw_sources, list)
        or len(raw_sources) > settings.max_source_refs
        or any(not _valid_identifier(item, 200) for item in raw_sources)
        or len(set(raw_sources)) != len(raw_sources)
    ):
        return None, "invalid_source_refs"
    effective_sources = list(raw_sources)
    if record_type == "graph":
        graph_nodes = value.get("nodes")
        graph_edges = value.get("edges")
        if not isinstance(graph_nodes, list) or not isinstance(graph_edges, list):
            return None, "invalid_graph_payload"
        for graph_item in (*graph_nodes, *graph_edges):
            if isinstance(graph_item, Mapping):
                item_sources = graph_item.get("sourceRecordIds", [])
                if (
                    not isinstance(item_sources, list)
                    or len(item_sources) > settings.max_source_refs
                    or any(not _valid_identifier(item, 200) for item in item_sources)
                    or len(set(item_sources)) != len(item_sources)
                ):
                    return None, "invalid_graph_source_refs"
                if any(item not in raw_sources for item in item_sources):
                    return None, "graph_source_refs_outside_record"
                effective_sources.extend(item_sources)
    effective_sources = sorted(set(effective_sources))
    if any(source_id not in prior_record_ids for source_id in effective_sources):
        return None, "source_not_prior_or_importable"
    if record_type != "message" and not effective_sources:
        return None, "source_refs_required"

    payload: dict[str, object]
    if record_type == "message":
        role = value.get("role")
        content = value.get("content")
        occurred_at = value.get("occurredAt")
        if role not in {"user", "assistant", "tool"}:
            return None, "invalid_message_role"
        if role == "user" and raw_sources:
            return None, "user_message_cannot_claim_sources"
        if not isinstance(content, str) or not content.strip():
            return None, "invalid_message_content"
        if len(content) > settings.max_text_chars:
            return None, "message_content_too_large"
        if type(occurred_at) is not int or occurred_at < 0:
            return None, "invalid_occurred_at"
        payload = {"role": role, "content": content, "occurredAt": occurred_at}
    elif record_type == "memory":
        kind = value.get("memoryKind")
        text = value.get("text")
        if kind not in {"fact", "preference", "commitment", "episode"}:
            return None, "invalid_memory_kind"
        if not _valid_text(text, settings.max_text_chars):
            return None, "invalid_memory_text"
        payload = {"memoryKind": kind, "text": text}
    elif record_type == "profile":
        subject_kind = value.get("subjectKind")
        category = value.get("category")
        text = value.get("text")
        confidence = value.get("confidence")
        if subject_kind not in {"user", "group"}:
            return None, "invalid_profile_subject"
        if category not in {"preference", "style", "constraint", "temporary_state"}:
            return None, "invalid_profile_category"
        if not _valid_text(text, settings.max_text_chars):
            return None, "invalid_profile_text"
        if (
            isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not math.isfinite(float(confidence))
            or not 0 <= float(confidence) <= 1
        ):
            return None, "invalid_profile_confidence"
        payload = {
            "subjectKind": subject_kind,
            "category": category,
            "text": text,
            "confidence": float(confidence),
        }
    else:
        nodes = value.get("nodes")
        edges = value.get("edges")
        if not _valid_graph(nodes, edges, settings):
            return None, "invalid_graph_payload"
        payload = {"nodes": nodes, "edges": edges}

    record_payload = {
        "recordType": record_type,
        "recordId": record_id,
        "conversationId": conversation_id,
        "conversationKind": conversation_kind,
        "personaId": value.get("personaId"),
        "visibility": visibility,
        "sourceRecordIds": raw_sources,
        "validUntil": value.get("validUntil"),
        **payload,
    }
    try:
        encoded = json.dumps(
            record_payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError):
        return None, "record_not_json_safe"
    if len(encoded) > settings.max_line_bytes:
        return None, "record_too_large"
    return (
        MigrationRecord(
            record_id=str(record_id),
            kind=cast(RecordKind, record_type),
            conversation_id=str(conversation_id),
            conversation_kind=conversation_kind,
            persona_id=value.get("personaId"),
            visibility=visibility,
            source_record_ids=tuple(str(item) for item in effective_sources),
            valid_until=value.get("validUntil"),
            data=payload,
            digest=hashlib.sha256(encoded).hexdigest(),
        ),
        None,
    )


def canonical_json(value: object) -> bytes:
    """Encode bounded portable JSON deterministically for digests and idempotency."""

    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _valid_graph(nodes: object, edges: object, settings: MigrationSettings) -> bool:
    """Validate graph arrays and the closed node/edge field sets."""

    if not isinstance(nodes, list) or not isinstance(edges, list):
        return False
    if len(nodes) > 500 or len(edges) > 500 or (not nodes and not edges):
        return False
    node_ids: set[str] = set()
    edge_ids: set[str] = set()
    for item in nodes:
        if (
            not isinstance(item, Mapping)
            or set(item) - {"id", "label", "properties", "sourceRecordIds"}
            or not {"id", "label"}.issubset(item)
            or not _valid_identifier(item.get("id"), 512)
            or not _valid_text(item.get("label"), 240)
            or not isinstance(item.get("properties", {}), Mapping)
            or not _valid_optional_source_ids(item.get("sourceRecordIds"), settings)
            or not _safe_json_tree(item.get("properties", {}), settings)
        ):
            return False
        node_id = str(item["id"])
        if node_id in node_ids:
            return False
        node_ids.add(node_id)
    for item in edges:
        if (
            not isinstance(item, Mapping)
            or set(item) - {"id", "fromId", "toId", "label", "properties", "sourceRecordIds"}
            or not {"id", "fromId", "toId", "label"}.issubset(item)
            or any(not _valid_identifier(item.get(name), 512) for name in ("id", "fromId", "toId"))
            or not _valid_text(item.get("label"), 240)
            or not isinstance(item.get("properties", {}), Mapping)
            or not _valid_optional_source_ids(item.get("sourceRecordIds"), settings)
            or not _safe_json_tree(item.get("properties", {}), settings)
        ):
            return False
        edge_id = str(item["id"])
        if edge_id in edge_ids or item["fromId"] not in node_ids or item["toId"] not in node_ids:
            return False
        edge_ids.add(edge_id)
    return True


def _valid_optional_source_ids(value: object, settings: MigrationSettings) -> bool:
    """Validate optional per-node/per-edge lineage arrays."""

    if value is None:
        return True
    return (
        isinstance(value, list)
        and len(value) <= settings.max_source_refs
        and all(_valid_identifier(item, 200) for item in value)
        and len(set(value)) == len(value)
    )


def _safe_json_tree(value: object, settings: MigrationSettings) -> bool:
    """Reject nested secrets, unsupported values, and oversized metadata trees."""

    if _contains_sensitive_key(value):
        return False
    try:
        encoded = canonical_json(value)
    except (TypeError, ValueError, UnicodeEncodeError):
        return False
    return len(encoded) <= settings.max_line_bytes


def _contains_sensitive_key(value: object) -> bool:
    """Detect credential, login, identity, and authorization fields recursively."""

    if isinstance(value, Mapping):
        for key, child in value.items():
            snake_key = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(key))
            normalized = re.sub(r"[^a-z0-9]+", "_", snake_key.lower()).strip("_")
            if normalized in _SENSITIVE_KEYS:
                return True
            if _contains_sensitive_key(child):
                return True
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return any(_contains_sensitive_key(item) for item in value)
    return False


def _valid_identifier(value: object, maximum: int) -> bool:
    """Require bounded control-character-free identifiers."""

    return (
        isinstance(value, str)
        and len(value) <= maximum
        and _IDENTIFIER.fullmatch(value) is not None
    )


def _valid_text(value: object, maximum: int) -> bool:
    """Require bounded non-empty text with no unpaired UTF-8 surrogates."""

    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True
