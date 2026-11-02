"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 __init__.py                                                      │
│  Module: cyrene_navigator.work.conversation_migration                │
│  Role: Public offline import and actor-backup migration surface.     │
│                                                                      │
│  模块职责：导出受限的离线导入与 actor 备份迁移服务。                   │
└─────────────────────────────────────────────────────────────────────┘
"""

from .adapters import (
    CanonicalGraphAdapter,
    CanonicalMemoryAdapter,
    CanonicalProfileAdapter,
    CanonicalRollbackCapabilities,
    ConversationMigrationHost,
    DirectGraphCompensator,
    GraphCompensationProvider,
    WorkStoreOperationAdapter,
    WorkStoreTaskProgressAdapter,
    build_conversation_migration_host,
)
from .backup import ActorBackup, ActorBackupSource, build_actor_backup, parse_actor_backup
from .jsonl import JsonLinesMigrationSource
from .models import (
    ActorScope,
    AuthorizedConversationContext,
    ImportPreview,
    MigrationError,
    MigrationReceipt,
    MigrationRecord,
    MigrationSettings,
)
from .service import ConversationMigrationService

__all__ = [
    "ActorBackup",
    "ActorBackupSource",
    "ActorScope",
    "AuthorizedConversationContext",
    "CanonicalGraphAdapter",
    "CanonicalMemoryAdapter",
    "CanonicalProfileAdapter",
    "CanonicalRollbackCapabilities",
    "ConversationMigrationHost",
    "ConversationMigrationService",
    "DirectGraphCompensator",
    "GraphCompensationProvider",
    "ImportPreview",
    "JsonLinesMigrationSource",
    "MigrationError",
    "MigrationReceipt",
    "MigrationRecord",
    "MigrationSettings",
    "WorkStoreOperationAdapter",
    "WorkStoreTaskProgressAdapter",
    "build_actor_backup",
    "build_conversation_migration_host",
    "parse_actor_backup",
]
