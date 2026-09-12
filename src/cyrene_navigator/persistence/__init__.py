"""
┌─────────────────────────────────────────────────────────────────────┐
│  Module: cyrene_navigator.persistence                               │
│  Role: Cyrene-owned backend for the upstream Harness Session model.  │
│                                                                     │
│  模块职责：导出服务工厂与 SQLite 事件存储，不维护第二份消息历史。           │
└─────────────────────────────────────────────────────────────────────┘
"""

from cyrene_navigator.persistence.api import create_persistence_app
from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.persistence.store import (
    PersistencePrincipal,
    PersistenceStore,
    Principal,
    SessionHandleRecord,
)

__all__ = [
    "PersistenceError",
    "PersistencePrincipal",
    "PersistenceStore",
    "Principal",
    "SessionHandleRecord",
    "create_persistence_app",
]
