"""
┌─────────────────────────────────────────────────────────────────────────┐
│ 📄 models.py                                                            │
│ Module: cyrene_navigator.work.conversation_artifact_bridge.models        │
│ Role: Immutable per-call attachment grants and source authorization.    │
│                                                                         │
│ 模块职责：定义单次调用的附件读取授权与会话来源范围。                     │
└─────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
ConversationKind = Literal["direct", "group", "channel"]
ArtifactGrantKind = Literal["conversation_source", "task_input", "human_selection"]


@dataclass(frozen=True, slots=True)
class ConversationArtifactScope:
    """Current conversation, persona, epoch, and source lineage for one artifact."""

    conversation_id: str
    conversation_kind: ConversationKind
    persona_id: str | None
    authorization_epoch: int
    source_refs: tuple[Mapping[str, Any], ...]

    def __post_init__(self) -> None:
        if not self.conversation_id or len(self.conversation_id) > 512:
            raise ValueError("conversation_id must be bounded non-empty text")
        if self.conversation_kind not in {"direct", "group", "channel"}:
            raise ValueError("conversation_kind is not supported")
        if self.persona_id is not None and (not self.persona_id or len(self.persona_id) > 512):
            raise ValueError("persona_id must be bounded non-empty text")
        if (
            isinstance(self.authorization_epoch, bool)
            or not isinstance(self.authorization_epoch, int)
            or self.authorization_epoch < 0
        ):
            raise ValueError("authorization_epoch must be a non-negative integer")
        if not self.source_refs or len(self.source_refs) > 256:
            raise ValueError("source_refs must contain bounded authoritative lineage")
        if any(not isinstance(reference, Mapping) for reference in self.source_refs):
            raise ValueError("source_refs must contain objects")
        if any(
            not all(isinstance(key, str) for key in reference) for reference in self.source_refs
        ):
            raise ValueError("source_refs must use string keys")
        try:
            encoded_refs = json.dumps(
                [dict(reference) for reference in self.source_refs],
                ensure_ascii=False,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        except (TypeError, ValueError, UnicodeError, RecursionError):
            raise ValueError("source_refs must contain bounded JSON data") from None
        if len(encoded_refs.encode("utf-8")) > 512_000:
            raise ValueError("source_refs exceed the bounded size")
        object.__setattr__(self, "source_refs", tuple(json.loads(encoded_refs)))


@dataclass(frozen=True, slots=True)
class ArtifactReadGrant:
    """One exact file the active tool call may read from WorkStore."""

    artifact_id: str
    kind: ArtifactGrantKind
    allowed_mime_types: frozenset[str]
    source_scope: ConversationArtifactScope | None = None
    argument_name: str = "artifact_id"

    def __post_init__(self) -> None:
        object.__setattr__(self, "allowed_mime_types", frozenset(self.allowed_mime_types))
        if not isinstance(self.artifact_id, str) or not _SHA256.fullmatch(self.artifact_id):
            raise ValueError("artifact_id must be a lowercase SHA-256 digest")
        if self.kind not in {"conversation_source", "task_input", "human_selection"}:
            raise ValueError("artifact grant kind is invalid")
        if not self.allowed_mime_types or len(self.allowed_mime_types) > 32:
            raise ValueError("allowed_mime_types must be bounded and non-empty")
        if self.kind == "conversation_source" and self.source_scope is None:
            raise ValueError("conversation source grants require a current source scope")
        if self.kind != "conversation_source" and self.source_scope is not None:
            raise ValueError("only conversation source grants may carry a conversation scope")
        if not self.argument_name or len(self.argument_name) > 128:
            raise ValueError("argument_name must be bounded non-empty text")


__all__ = ["ArtifactGrantKind", "ArtifactReadGrant", "ConversationArtifactScope"]
