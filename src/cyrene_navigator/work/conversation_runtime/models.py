"""Closed shapes for current-turn conversation research.

中文：当前回合会话研究使用的封闭结构。
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
ConversationKind = Literal["direct", "group", "channel"]


@dataclass(frozen=True, slots=True)
class ConversationResearchScope:
    """Trusted conversation scope supplied by the active host Task."""

    conversation_id: str
    conversation_kind: ConversationKind
    persona_id: str | None
    authorization_epoch: int
    source_refs: tuple[Mapping[str, Any], ...]

    def __post_init__(self) -> None:
        if (
            not isinstance(self.conversation_id, str)
            or not self.conversation_id.strip()
            or len(self.conversation_id) > 512
        ):
            raise ValueError("conversation_id must be bounded non-empty text")
        if self.conversation_kind not in {"direct", "group", "channel"}:
            raise ValueError("conversation_kind is not supported")
        if self.persona_id is not None and (
            not self.persona_id.strip() or len(self.persona_id) > 512
        ):
            raise ValueError("persona_id must be bounded non-empty text")
        if (
            isinstance(self.authorization_epoch, bool)
            or not isinstance(self.authorization_epoch, int)
            or self.authorization_epoch < 0
        ):
            raise ValueError("authorization_epoch must be a non-negative integer")
        if len(self.source_refs) > 256:
            raise ValueError("source_refs exceed the bounded current-turn lineage")
        try:
            encoded = json.dumps(
                [dict(reference) for reference in self.source_refs],
                ensure_ascii=False,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        except (TypeError, ValueError, UnicodeError, RecursionError):
            raise ValueError("source_refs must contain bounded JSON objects") from None
        if len(encoded.encode("utf-8")) > 512_000:
            raise ValueError("source_refs exceed the bounded size")
        object.__setattr__(self, "source_refs", tuple(json.loads(encoded)))


@dataclass(frozen=True, slots=True)
class ConversationResearchRequest:
    """Host-derived invocation data; model input cannot provide scope or identity."""

    task_id: str
    parent_task_id: str
    parent_session_id: str
    scope: ConversationResearchScope
    query: str
    attachment_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.task_id, str) or not self.task_id.strip() or len(self.task_id) > 512:
            raise ValueError("task_id must be bounded non-empty text")
        if (
            not isinstance(self.parent_task_id, str)
            or not self.parent_task_id.strip()
            or len(self.parent_task_id) > 512
        ):
            raise ValueError("parent_task_id must be bounded non-empty text")
        if (
            not isinstance(self.parent_session_id, str)
            or not self.parent_session_id.strip()
            or len(self.parent_session_id) > 512
        ):
            raise ValueError("parent_session_id must be bounded non-empty text")
        if not isinstance(self.query, str) or not self.query.strip() or len(self.query) > 2_000:
            raise ValueError("query must be bounded non-empty text")
        if len(self.attachment_ids) > 8:
            raise ValueError("at most eight authorized attachments may be read")
        if any(
            not isinstance(item, str) or not _SHA256.fullmatch(item) for item in self.attachment_ids
        ):
            raise ValueError("attachment_ids must be lowercase SHA-256 ids")
        if len(set(self.attachment_ids)) != len(self.attachment_ids):
            raise ValueError("attachment_ids must be unique")
