"""
┌─────────────────────────────────────────────────────────────────────┐
│  Module: cyrene_navigator.persistence.errors                        │
│  Role: Stable RFC 9457 persistence failures.                         │
│                                                                     │
│  模块职责：集中定义可观察、可审计的持久化错误代码。                       │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations


class PersistenceError(Exception):
    """A safe API error with a stable code and HTTP status. | 稳定持久化错误。"""

    __slots__ = ("code", "detail", "retryable", "status")

    def __init__(self, code: str, status: int, detail: str, retryable: bool = False) -> None:
        """Initialize a serializable failure. | 初始化可序列化错误。"""

        super().__init__(detail)
        self.code = code
        self.status = status
        self.detail = detail
        self.retryable = retryable


SESSION_NOT_FOUND = "SESSION_NOT_FOUND"
SESSION_ALREADY_EXISTS = "SESSION_ALREADY_EXISTS"
SESSION_ALREADY_OWNED = "SESSION_ALREADY_OWNED"
SESSION_OWNERSHIP_LOST = "SESSION_OWNERSHIP_LOST"
SESSION_SEQUENCE_CONFLICT = "SESSION_SEQUENCE_CONFLICT"
SESSION_INVALID_HEADER = "SESSION_INVALID_HEADER"
SESSION_INVALID_EVENT = "SESSION_INVALID_EVENT"
SESSION_STORAGE_CORRUPT = "SESSION_STORAGE_CORRUPT"
WORKSPACE_UNAUTHORIZED = "WORKSPACE_UNAUTHORIZED"
WORKSPACE_FORBIDDEN = "WORKSPACE_FORBIDDEN"
