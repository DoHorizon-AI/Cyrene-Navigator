"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 service.py                                                       │
│  Module: cyrene_navigator.work.conversation_migration.service         │
│  Role: Dry-run, bounded import, canonical projection, and rollback.   │
│                                                                      │
│  模块职责：编排离线迁移；授权、规范写入、回读与任务状态均由宿主提供。  │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import re
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .backup import ActorBackup, ActorBackupSource, build_actor_backup, parse_actor_backup
from .models import (
    ActorScope,
    AuthorizedConversationContext,
    ImportPreview,
    MigrationError,
    MigrationReceipt,
    MigrationRecord,
    MigrationSettings,
)
from .ports import (
    CurrentAuthorizationPort,
    GraphProjectionPort,
    MemoryProjectionPort,
    MigrationSource,
    OperationHandle,
    ProfileProjectionPort,
    RollbackCapabilityPort,
    SourceLine,
    WorkOperationPort,
    WorkTaskProgressPort,
)
from .records import canonical_json, normalize_record

_BATCH_PREFIX = "conversation-migration-"
_TASK_ID = re.compile(r"[^\s\x00-\x1f]{1,512}\Z")
_MAX_PROGRESS_EVENTS = 1_000_000
_ROLLBACK_CAPABILITY_BY_KIND = {
    "message": ("conversation.message.revoke.v1",),
    "memory": ("conversation.memory.tombstone.v1",),
    "profile": ("navigator.profile.candidate-rollback.v1", "navigator.profile.rollback.v1"),
    "graph": ("navigator.graph.provider-compensation.v1",),
}


@dataclass(frozen=True, slots=True)
class _ProjectionRef:
    """Canonical IDs required to bind later records to their imported sources."""

    kind: str
    entity_id: str
    version: int
    context: AuthorizedConversationContext
    candidate_id: str | None = None
    readback_sha256: str = ""
    operation_id: str | None = None
    replayed: bool = False
    authorization_epoch: int = 0


@dataclass(frozen=True, slots=True)
class _LoadedProgress:
    """Rebuilt bounded state from existing Work Task event pages."""

    next_sequence: int
    cursor: str | None
    ordinal: int
    known_records: frozenset[str]
    projections: Mapping[str, _ProjectionRef]
    record_events: tuple[Mapping[str, object], ...]
    rollback_ordinals: frozenset[int]
    batch_rolled_back: bool


class ConversationMigrationService:
    """Coordinate an actor-private import through host-authorized canonical ports.

    The service owns no database, task scheduler, migration journal, or access policy.
    All progress goes through existing Work Task events, and all writes go through
    the canonical memory, profile, and graph interfaces supplied by the host.
    """

    def __init__(
        self,
        *,
        authorization: CurrentAuthorizationPort,
        memory: MemoryProjectionPort,
        profiles: ProfileProjectionPort,
        graph: GraphProjectionPort,
        rollback_capabilities: RollbackCapabilityPort,
        operations: WorkOperationPort,
        progress: WorkTaskProgressPort,
        settings: MigrationSettings | None = None,
    ) -> None:
        """Bind every required authority and projection seam; there are no fake defaults."""

        self._authorization = authorization
        self._memory = memory
        self._profiles = profiles
        self._graph = graph
        self._rollback_capabilities = rollback_capabilities
        self._operations = operations
        self._progress = progress
        self._settings = settings or MigrationSettings()

    def create_backup(
        self,
        scope: ActorScope,
        memory_export: bytes,
        domain_export: bytes,
        *,
        created_at: int,
    ) -> ActorBackup:
        """Build a portable actor backup from exports returned by canonical stores."""

        return build_actor_backup(
            scope,
            memory_export,
            domain_export,
            created_at=created_at,
            settings=self._settings,
        )

    def preview_backup(
        self,
        scope: ActorScope,
        *,
        artifact_id: str,
        content: bytes,
        expected_sha256: str,
    ) -> tuple[ActorBackup, ImportPreview]:
        """Verify an actor-private portable backup and perform its read-only dry-run."""

        if not self._authorization.authorize_artifact(scope, artifact_id, expected_sha256):
            raise MigrationError(
                "IMPORT_ARTIFACT_FORBIDDEN", "Backup is not authorized for this actor."
            )
        backup = parse_actor_backup(
            content,
            expected_sha256=expected_sha256,
            settings=self._settings,
        )
        source = ActorBackupSource(backup, artifact_id=artifact_id)
        return backup, self.preview(scope, source)

    def restore_backup(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        artifact_id: str,
        content: bytes,
        expected_sha256: str,
        approval_ref: str | None,
        profile_approval_ref: str | None = None,
        graph_approval_ref: str | None = None,
    ) -> MigrationReceipt:
        """Restore a verified actor-private backup through the same approved import saga."""

        backup, preview = self.preview_backup(
            scope,
            artifact_id=artifact_id,
            content=content,
            expected_sha256=expected_sha256,
        )
        source = ActorBackupSource(backup, artifact_id=artifact_id)
        return self.apply(
            scope,
            task_id=task_id,
            source=source,
            preview=preview,
            approval_ref=approval_ref,
            profile_approval_ref=profile_approval_ref,
            graph_approval_ref=graph_approval_ref,
        )

    def preview(self, scope: ActorScope, source: MigrationSource) -> ImportPreview:
        """Perform a read-only count, lineage, scope, and authorization dry-run."""

        self._verify_source(scope, source)
        header = _validate_header(source.header, self._settings)
        prior_ids: set[str] = set()
        accepted = Counter[str]()
        rejected = Counter[str]()
        plan_stream = hashlib.sha256()
        scope_digest = _scope_digest(scope)
        plan_stream.update(b"cyrene.conversation-migration.plan.v1\0")
        plan_stream.update(source.expected_sha256.encode("ascii"))
        plan_stream.update(scope_digest.encode("ascii"))

        ordinal = 0
        cursor: str | None = None
        while True:
            page = source.read_page(cursor, self._settings.max_page_records)
            _validate_page(page, self._settings.max_page_records)
            if not page.items and page.next_cursor is not None:
                raise MigrationError(
                    "SOURCE_CURSOR_STALLED", "Artifact page cursor did not advance."
                )
            for line in page.items:
                ordinal += 1
                record, reason = self._normalize_line(line, ordinal, prior_ids)
                if record is None:
                    rejected[reason or "invalid_record"] += 1
                    _hash_plan_row(
                        plan_stream, ordinal, None, reason or "invalid_record", None, None
                    )
                    continue
                accepted_reason, context_digest, authorization_epoch = self._preview_authorization(
                    scope, source, record
                )
                if accepted_reason is not None:
                    rejected[accepted_reason] += 1
                    _hash_plan_row(
                        plan_stream,
                        ordinal,
                        record,
                        accepted_reason,
                        context_digest,
                        authorization_epoch,
                    )
                    continue
                prior_ids.add(record.record_id)
                accepted[record.kind] += 1
                _hash_plan_row(
                    plan_stream,
                    ordinal,
                    record,
                    "accepted",
                    context_digest,
                    authorization_epoch,
                )
            cursor = page.next_cursor
            if cursor is None:
                break
            if ordinal > self._settings.max_records:
                raise MigrationError("IMPORT_RECORD_LIMIT", "Artifact exceeds the record limit.")

        declared_count = header.get("recordCount")
        if not isinstance(declared_count, int) or ordinal != declared_count:
            raise MigrationError(
                "IMPORT_COUNT_MISMATCH", "Artifact row count does not match its header."
            )
        if ordinal > self._settings.max_records:
            raise MigrationError("IMPORT_RECORD_LIMIT", "Artifact exceeds the record limit.")
        plan_material = {
            "artifactId": source.artifact_id,
            "artifactSha256": source.expected_sha256,
            "scopeDigest": scope_digest,
            "recordsDigest": plan_stream.hexdigest(),
            "recordCount": ordinal,
            "acceptedByKind": dict(sorted(accepted.items())),
            "quarantineReasons": dict(sorted(rejected.items())),
        }
        plan_sha256 = hashlib.sha256(canonical_json(plan_material)).hexdigest()
        return ImportPreview(
            artifact_id=source.artifact_id,
            artifact_sha256=source.expected_sha256,
            plan_sha256=plan_sha256,
            record_count=ordinal,
            accepted_count=sum(accepted.values()),
            quarantined_count=sum(rejected.values()),
            accepted_by_kind=dict(sorted(accepted.items())),
            quarantine_reasons=dict(sorted(rejected.items())),
        )

    def apply(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        source: MigrationSource,
        preview: ImportPreview,
        approval_ref: str | None,
        profile_approval_ref: str | None = None,
        graph_approval_ref: str | None = None,
    ) -> MigrationReceipt:
        """Apply the exact approved plan with idempotent writes and task-backed checkpoints."""

        _validate_task_id(task_id)
        _match_preview(source, preview)
        current_preview = self.preview(scope, source)
        if current_preview.plan_sha256 != preview.plan_sha256:
            raise MigrationError(
                "IMPORT_PLAN_CHANGED", "Dry-run plan no longer matches the artifact."
            )
        if not self._authorization.approve_import(scope, approval_ref, preview.plan_sha256):
            raise MigrationError(
                "IMPORT_APPROVAL_REQUIRED", "Host approval for this import is required."
            )

        batch_id = _batch_id(preview.plan_sha256)
        progress = self._load_progress(scope, task_id, batch_id)
        if progress.batch_rolled_back:
            raise MigrationError(
                "IMPORT_ALREADY_ROLLED_BACK",
                "This exact import batch was already rolled back; preview a new plan to reapply.",
            )
        if progress.ordinal >= preview.record_count and progress.cursor is None:
            return self._receipt_from_progress(batch_id, preview, progress, "applied")
        self._require_rollback_capabilities(scope, current_preview)

        known_ids = set(progress.known_records)
        projections = dict(progress.projections)
        read_count = progress.ordinal
        cursor = progress.cursor
        cursor_after_last = cursor
        projected_count = sum(
            1 for item in progress.record_events if item.get("state") == "projected"
        )
        candidate_count = sum(
            1 for item in progress.record_events if item.get("state") == "candidate"
        )
        replayed_count = sum(1 for item in progress.record_events if item.get("replayed") is True)
        quarantine = Counter(
            str(item.get("reasonCode"))
            for item in progress.record_events
            if item.get("state") == "quarantined" and isinstance(item.get("reasonCode"), str)
        )
        projection_stream = hashlib.sha256()
        for event in progress.record_events:
            if event.get("state") in {"projected", "candidate"}:
                projection_stream.update(
                    f"{event.get('recordDigest')}:{event.get('readbackSha256')}\n".encode("ascii")
                )

        while True:
            page = source.read_page(cursor, self._settings.max_page_records)
            _validate_page(page, self._settings.max_page_records)
            if not page.items and page.next_cursor is not None:
                raise MigrationError(
                    "SOURCE_CURSOR_STALLED", "Artifact page cursor did not advance."
                )
            for line in page.items:
                read_count += 1
                if read_count > self._settings.max_records:
                    raise MigrationError(
                        "IMPORT_RECORD_LIMIT", "Artifact exceeds the record limit."
                    )
                record, reason = self._normalize_line(line, read_count, known_ids)
                if record is None:
                    quarantine[reason or "invalid_record"] += 1
                    self._append_quarantine(
                        scope,
                        task_id,
                        batch_id,
                        preview,
                        read_count,
                        line,
                        reason or "invalid_record",
                    )
                    cursor_after_last = line.cursor_after
                    continue

                projection_ref, denied_reason = self._apply_record(
                    scope,
                    task_id=task_id,
                    batch_id=batch_id,
                    source=source,
                    preview=preview,
                    record=record,
                    ordinal=read_count,
                    cursor_after=line.cursor_after,
                    prior_projections=projections,
                    profile_approval_ref=profile_approval_ref,
                    graph_approval_ref=graph_approval_ref,
                )
                if projection_ref is None:
                    reason_code = denied_reason or "authorization_or_scope_denied"
                    quarantine[reason_code] += 1
                    self._append_quarantine(
                        scope,
                        task_id,
                        batch_id,
                        preview,
                        read_count,
                        line,
                        reason_code,
                        record=record,
                    )
                    cursor_after_last = line.cursor_after
                    continue

                known_ids.add(record.record_id)
                projections[record.record_id] = projection_ref
                state = "candidate" if projection_ref.kind == "profile_candidate" else "projected"
                if state == "candidate":
                    candidate_count += 1
                else:
                    projected_count += 1
                projection_stream.update(
                    f"{record.digest}:{projection_ref.readback_sha256}\n".encode("ascii")
                )
                if projection_ref.replayed:
                    replayed_count += 1
                self._append_projection_checkpoint(
                    scope,
                    task_id,
                    batch_id,
                    preview,
                    record,
                    read_count,
                    line.cursor_after,
                    projection_ref,
                    state,
                )
                cursor_after_last = line.cursor_after
            cursor = page.next_cursor
            if cursor is None:
                break

        if read_count != preview.record_count:
            raise MigrationError(
                "IMPORT_COUNT_MISMATCH", "Imported page count changed after preview."
            )
        if sum((projected_count, candidate_count, sum(quarantine.values()))) != read_count:
            raise MigrationError("IMPORT_COUNT_MISMATCH", "Imported outcomes do not reconcile.")
        return MigrationReceipt(
            batch_id=batch_id,
            artifact_sha256=preview.artifact_sha256,
            status="applied",
            read_count=read_count,
            projected_count=projected_count,
            candidate_count=candidate_count,
            replayed_count=replayed_count,
            quarantined_count=sum(quarantine.values()),
            rolled_back_count=0,
            projection_sha256=projection_stream.hexdigest(),
            completed_cursor=cursor_after_last,
        )

    def rollback(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        source: MigrationSource,
        preview: ImportPreview,
    ) -> MigrationReceipt:
        """Compensate one applied batch in reverse order through canonical rollback APIs."""

        _validate_task_id(task_id)
        _match_preview(source, preview)
        self._verify_source(scope, source)
        batch_id = _batch_id(preview.plan_sha256)
        if not self._authorization.approve_rollback(scope, batch_id, preview.plan_sha256):
            raise MigrationError(
                "IMPORT_APPROVAL_REQUIRED", "Host approval is required for rollback."
            )
        progress = self._load_progress(scope, task_id, batch_id)
        if progress.batch_rolled_back:
            return MigrationReceipt(
                batch_id=batch_id,
                artifact_sha256=preview.artifact_sha256,
                status="rolled_back",
                read_count=progress.ordinal,
                projected_count=sum(
                    1 for item in progress.record_events if item.get("state") == "projected"
                ),
                candidate_count=sum(
                    1 for item in progress.record_events if item.get("state") == "candidate"
                ),
                replayed_count=0,
                quarantined_count=sum(
                    1 for item in progress.record_events if item.get("state") == "quarantined"
                ),
                rolled_back_count=len(progress.rollback_ordinals),
                projection_sha256=_progress_digest(progress.record_events),
                completed_cursor=progress.cursor,
            )
        source_record_kinds = self._read_record_kinds(source)
        self._require_rollback_capabilities(scope, preview, record_kinds=source_record_kinds)
        progress = self._reconcile_tail_for_rollback(
            scope, task_id, batch_id, source, preview, progress
        )
        applied = [
            event
            for event in progress.record_events
            if event.get("state") in {"projected", "candidate"}
            and type(event.get("ordinal")) is int
        ]
        rolled_back = set(progress.rollback_ordinals)
        rolled_back_count = 0
        for event in reversed(applied):
            ordinal = _required_int(event.get("ordinal"), "checkpoint ordinal")
            if ordinal in rolled_back:
                continue
            self._rollback_one(scope, task_id, batch_id, preview, event)
            rolled_back_count += 1
        progress = self._load_progress(scope, task_id, batch_id)
        if len(progress.rollback_ordinals) < len(applied):
            raise MigrationError(
                "ROLLBACK_COUNT_MISMATCH", "Rollback checkpoints do not reconcile."
            )
        self._progress.append_checkpoint(
            scope,
            task_id=task_id,
            event_id=_progress_event_id(batch_id, 0, "batch-rollback"),
            event={
                "migrationEvent": "batch_rollback",
                "batchId": batch_id,
                "artifactSha256": preview.artifact_sha256,
                "state": "rolled_back",
                "recordCount": preview.record_count,
                "rolledBackCount": len(progress.rollback_ordinals),
            },
        )
        return MigrationReceipt(
            batch_id=batch_id,
            artifact_sha256=preview.artifact_sha256,
            status="rolled_back",
            read_count=progress.ordinal,
            projected_count=sum(1 for item in applied if item.get("state") == "projected"),
            candidate_count=sum(1 for item in applied if item.get("state") == "candidate"),
            replayed_count=0,
            quarantined_count=sum(
                1 for item in progress.record_events if item.get("state") == "quarantined"
            ),
            rolled_back_count=len(progress.rollback_ordinals),
            projection_sha256=_progress_digest(progress.record_events),
            completed_cursor=progress.cursor,
        )

    def _require_rollback_capabilities(
        self,
        scope: ActorScope,
        preview: ImportPreview,
        *,
        record_kinds: Sequence[str] | None = None,
    ) -> None:
        """Reject plans whose canonical projections cannot all be compensated."""

        kinds = (
            set(record_kinds)
            if record_kinds is not None
            else {
                kind
                for kind, count in preview.accepted_by_kind.items()
                if type(count) is int and count > 0
            }
        )
        required = sorted(
            {
                capability
                for kind, capabilities in _ROLLBACK_CAPABILITY_BY_KIND.items()
                if kind in kinds
                for capability in capabilities
            }
        )
        if not required:
            return
        capability_check = getattr(self._rollback_capabilities, "missing_capabilities", None)
        if not callable(capability_check):
            raise MigrationError(
                "ROLLBACK_CAPABILITY_CHECK_UNAVAILABLE",
                "Host rollback capability preflight is unavailable.",
            )
        missing = capability_check(scope, required=required)
        if not isinstance(missing, Sequence) or isinstance(missing, (str, bytes)):
            raise MigrationError(
                "ROLLBACK_CAPABILITY_CHECK_INVALID",
                "Host returned an invalid rollback capability result.",
            )
        if any(
            not isinstance(capability, str) or capability not in required or len(capability) > 128
            for capability in missing
        ):
            raise MigrationError(
                "ROLLBACK_CAPABILITY_CHECK_INVALID",
                "Host returned an unknown rollback capability.",
            )
        unavailable = sorted(set(missing))
        if unavailable:
            raise MigrationError(
                "ROLLBACK_CAPABILITY_UNAVAILABLE",
                "Required compensation is unavailable: " + ", ".join(unavailable),
            )

    def _read_record_kinds(self, source: MigrationSource) -> tuple[str, ...]:
        """Boundedly scan valid rows so rollback preflight does not trust a preview map."""

        header = _validate_header(source.header, self._settings)
        declared_count = header.get("recordCount")
        if not isinstance(declared_count, int):
            raise MigrationError("IMPORT_HEADER_INVALID", "Artifact record count is invalid.")
        prior_record_ids: set[str] = set()
        kinds: set[str] = set()
        cursor: str | None = None
        ordinal = 0
        while True:
            page = source.read_page(cursor, self._settings.max_page_records)
            _validate_page(page, self._settings.max_page_records)
            if not page.items and page.next_cursor is not None:
                raise MigrationError(
                    "SOURCE_CURSOR_STALLED", "Artifact page cursor did not advance."
                )
            for line in page.items:
                ordinal += 1
                if ordinal > self._settings.max_records:
                    raise MigrationError(
                        "IMPORT_RECORD_LIMIT", "Artifact exceeds the record limit."
                    )
                record, _ = self._normalize_line(line, ordinal, prior_record_ids)
                if record is not None:
                    prior_record_ids.add(record.record_id)
                    kinds.add(record.kind)
            cursor = page.next_cursor
            if cursor is None:
                break
        if ordinal != declared_count:
            raise MigrationError(
                "IMPORT_COUNT_MISMATCH", "Artifact row count does not match its header."
            )
        return tuple(sorted(kinds))

    def _reconcile_tail_for_rollback(
        self,
        scope: ActorScope,
        task_id: str,
        batch_id: str,
        source: MigrationSource,
        preview: ImportPreview,
        progress: _LoadedProgress,
    ) -> _LoadedProgress:
        """Resolve the single in-flight row that may have written before its task checkpoint."""

        if progress.ordinal >= preview.record_count:
            return progress
        page = source.read_page(progress.cursor, 1)
        _validate_page(page, 1)
        if not page.items:
            return progress
        line = page.items[0]
        ordinal = progress.ordinal + 1
        record, _ = self._normalize_line(line, ordinal, set(progress.known_records))
        if record is None:
            return progress
        context = self._authorization.resolve_conversation_context(
            scope,
            artifact_id=source.artifact_id,
            source_conversation_id=record.conversation_id,
            source_conversation_kind=record.conversation_kind,
            source_persona_id=record.persona_id,
        )
        if context is None:
            raise MigrationError(
                "ROLLBACK_RECONCILIATION_REQUIRED",
                "An in-flight operation has no current host-resolved target context.",
            )
        operation = self._operations.begin(
            scope,
            task_id=task_id,
            idempotency_key=_operation_key(scope, task_id, batch_id, record, "project"),
            operation_type=f"navigator.conversation_migration.{record.kind}.project",
            request=_operation_request(preview, record, context),
        )
        if not operation.duplicate:
            # No earlier intent existed, so no canonical write could have run.
            no_effect_digest = hashlib.sha256(
                canonical_json({"recordDigest": record.digest, "notApplied": True})
            ).hexdigest()
            completed = self._operations.complete(
                scope,
                task_id=task_id,
                operation_id=operation.operation_id,
                evidence={
                    "recordId": record.record_id,
                    "recordDigest": record.digest,
                    "notApplied": True,
                    "readbackSha256": no_effect_digest,
                    "authorizationEpoch": 0,
                },
            )
            if completed.status != "verified":
                raise MigrationError(
                    "OPERATION_NOT_VERIFIED", "Unstarted tail operation could not be reconciled."
                )
            return progress
        if operation.status == "verified":
            if operation.evidence.get("notApplied") is True:
                return progress
            projection, readback_digest = self._read_verified_operation(
                scope, operation, record, context
            )
            projection = _ProjectionRef(
                kind=projection.kind,
                entity_id=projection.entity_id,
                version=projection.version,
                context=context,
                candidate_id=projection.candidate_id,
                readback_sha256=readback_digest,
                operation_id=operation.operation_id,
                replayed=True,
                authorization_epoch=projection.authorization_epoch,
            )
        else:
            reconciled, denied_reason = self._apply_record(
                scope,
                task_id=task_id,
                batch_id=batch_id,
                source=source,
                preview=preview,
                record=record,
                ordinal=ordinal,
                cursor_after=line.cursor_after,
                prior_projections=progress.projections,
                profile_approval_ref=None,
                graph_approval_ref=None,
            )
            if reconciled is None:
                raise MigrationError(
                    "ROLLBACK_RECONCILIATION_REQUIRED",
                    "An in-flight write needs host authorization before it can be reconciled: "
                    f"{denied_reason or 'authorization_denied'}.",
                )
            projection = reconciled
        checkpoint_state = "candidate" if projection.kind == "profile_candidate" else "projected"
        self._append_projection_checkpoint(
            scope,
            task_id,
            batch_id,
            preview,
            record,
            ordinal,
            line.cursor_after,
            projection,
            checkpoint_state,
        )
        return self._load_progress(scope, task_id, batch_id)

    def _verify_source(self, scope: ActorScope, source: MigrationSource) -> None:
        """Re-hash the source and bind it to the authenticated host actor."""

        if (
            not isinstance(source.artifact_id, str)
            or not source.artifact_id.strip()
            or len(source.artifact_id) > 512
            or any(ord(char) < 0x20 for char in source.artifact_id)
            or not isinstance(source.expected_sha256, str)
            or re.fullmatch(r"(?:sha256:)?[a-f0-9]{64}", source.expected_sha256) is None
        ):
            raise MigrationError("IMPORT_ARTIFACT_INVALID", "A host-resolved artifact is required.")
        try:
            source.verify()
        except (OSError, ValueError) as error:
            raise MigrationError(
                "IMPORT_ARTIFACT_INVALID", "Artifact digest verification failed."
            ) from error
        if not self._authorization.authorize_artifact(
            scope, source.artifact_id, source.expected_sha256
        ):
            raise MigrationError(
                "IMPORT_ARTIFACT_FORBIDDEN", "Artifact is not authorized for this actor."
            )

    def _preview_authorization(
        self, scope: ActorScope, source: MigrationSource, record: MigrationRecord
    ) -> tuple[str | None, str | None, int | None]:
        """Bind source conversation metadata and lineage to current host authorization."""

        context = self._authorization.resolve_conversation_context(
            scope,
            artifact_id=source.artifact_id,
            source_conversation_id=record.conversation_id,
            source_conversation_kind=record.conversation_kind,
            source_persona_id=record.persona_id,
        )
        if context is None:
            return "conversation_scope_denied", None, None
        decision = self._authorization.authorize_staged_record(
            scope,
            artifact_id=source.artifact_id,
            artifact_sha256=source.expected_sha256,
            record=record,
        )
        if not decision.allowed:
            return (
                decision.reason_code or "source_authorization_denied",
                _context_digest(context),
                decision.authorization_epoch,
            )
        return None, _context_digest(context), decision.authorization_epoch

    def _normalize_line(
        self, line: SourceLine, ordinal: int, prior_ids: set[str]
    ) -> tuple[MigrationRecord | None, str | None]:
        """Normalize one source row while never returning raw invalid content."""

        if line.error_code is not None:
            return None, line.error_code
        return normalize_record(
            line.value,
            ordinal=ordinal,
            prior_record_ids=prior_ids,
            settings=self._settings,
        )

    def _load_progress(self, scope: ActorScope, task_id: str, batch_id: str) -> _LoadedProgress:
        """Rebuild bounded migration state from the current actor's existing task events."""

        sequence = 0
        cursor: str | None = None
        ordinal = 0
        known: set[str] = set()
        projections: dict[str, _ProjectionRef] = {}
        records: list[Mapping[str, object]] = []
        rollback_ordinals: set[int] = set()
        batch_rolled_back = False
        seen_events = 0
        while True:
            events, next_sequence = self._progress.list_checkpoints(
                scope,
                task_id=task_id,
                batch_id=batch_id,
                after_sequence=sequence,
                limit=min(500, self._settings.max_page_records),
            )
            if len(events) > min(500, self._settings.max_page_records):
                raise MigrationError(
                    "TASK_CHECKPOINT_PAGE_INVALID", "Task checkpoint page is oversized."
                )
            if events and next_sequence <= sequence:
                raise MigrationError(
                    "TASK_CHECKPOINT_CURSOR_STALLED", "Task checkpoint cursor did not advance."
                )
            for event in events:
                if not isinstance(event, Mapping) or event.get("batchId") != batch_id:
                    continue
                event_type = event.get("migrationEvent")
                if event_type == "record":
                    records.append(event)
                    if type(event.get("ordinal")) is int:
                        ordinal = max(ordinal, int(event["ordinal"]))
                    raw_cursor = event.get("sourceCursor")
                    if raw_cursor is not None:
                        if not isinstance(raw_cursor, str):
                            raise MigrationError(
                                "TASK_CHECKPOINT_INVALID", "Stored source cursor is invalid."
                            )
                        cursor = raw_cursor
                    record_id = event.get("recordId")
                    if isinstance(record_id, str) and event.get("state") in {
                        "projected",
                        "candidate",
                    }:
                        known.add(record_id)
                        record_kind = event.get("projectionKind")
                        entity_id = event.get("entityId")
                        entity_version = event.get("entityVersion")
                        context_raw = event.get("targetContext")
                        if (
                            not isinstance(record_kind, str)
                            or not isinstance(entity_id, str)
                            or type(entity_version) is not int
                            or not isinstance(context_raw, Mapping)
                        ):
                            raise MigrationError(
                                "TASK_CHECKPOINT_INVALID", "Stored projection reference is invalid."
                            )
                        context = _context_from_mapping(context_raw)
                        projections[record_id] = _ProjectionRef(
                            kind=record_kind,
                            entity_id=entity_id,
                            version=entity_version,
                            context=context,
                            candidate_id=(
                                str(event["candidateId"])
                                if isinstance(event.get("candidateId"), str)
                                else None
                            ),
                            readback_sha256=str(event.get("readbackSha256", "")),
                            operation_id=(
                                str(event["operationId"])
                                if isinstance(event.get("operationId"), str)
                                else None
                            ),
                            replayed=event.get("replayed") is True,
                            authorization_epoch=(
                                int(event["authorizationEpoch"])
                                if type(event.get("authorizationEpoch")) is int
                                else 0
                            ),
                        )
                elif event_type == "rollback" and type(event.get("ordinal")) is int:
                    rollback_ordinals.add(int(event["ordinal"]))
                elif event_type == "batch_rollback":
                    batch_rolled_back = event.get("state") == "rolled_back"
                seen_events += 1
                if seen_events > _MAX_PROGRESS_EVENTS:
                    raise MigrationError(
                        "TASK_CHECKPOINT_LIMIT", "Task has too many migration checkpoints."
                    )
            if next_sequence <= sequence:
                if events:
                    raise MigrationError(
                        "TASK_CHECKPOINT_CURSOR_STALLED", "Task checkpoint cursor did not advance."
                    )
                break
            if next_sequence > _MAX_PROGRESS_EVENTS:
                raise MigrationError(
                    "TASK_CHECKPOINT_LIMIT", "Task event cursor exceeds the reconciliation bound."
                )
            sequence = next_sequence
        return _LoadedProgress(
            next_sequence=sequence,
            cursor=cursor,
            ordinal=ordinal,
            known_records=frozenset(known),
            projections=projections,
            record_events=tuple(records),
            rollback_ordinals=frozenset(rollback_ordinals),
            batch_rolled_back=batch_rolled_back,
        )

    def _apply_record(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        batch_id: str,
        source: MigrationSource,
        preview: ImportPreview,
        record: MigrationRecord,
        ordinal: int,
        cursor_after: str,
        prior_projections: Mapping[str, _ProjectionRef],
        profile_approval_ref: str | None,
        graph_approval_ref: str | None,
    ) -> tuple[_ProjectionRef | None, str | None]:
        """Authorize, project, read back, and audit one record before checkpointing it."""

        context = self._authorization.resolve_conversation_context(
            scope,
            artifact_id=source.artifact_id,
            source_conversation_id=record.conversation_id,
            source_conversation_kind=record.conversation_kind,
            source_persona_id=record.persona_id,
        )
        if context is None:
            return None, "conversation_scope_denied"
        staged_decision = self._authorization.authorize_staged_record(
            scope,
            artifact_id=source.artifact_id,
            artifact_sha256=source.expected_sha256,
            record=record,
        )
        if not staged_decision.allowed:
            return None, staged_decision.reason_code or "source_authorization_denied"
        source_refs = _resolve_source_refs(record, prior_projections, context)
        if source_refs is None:
            return None, "source_lineage_unavailable"
        authorization_epoch = staged_decision.authorization_epoch
        if source_refs:
            source_decision = self._authorization.authorize_source_refs(
                scope,
                conversation_id=context.conversation_id,
                conversation_kind=context.conversation_kind,
                persona_id=context.persona_id,
                source_refs=source_refs,
            )
            if not source_decision.allowed:
                return None, source_decision.reason_code or "source_authorization_denied"
            authorization_epoch = source_decision.authorization_epoch
        if record.kind == "graph" and not self._authorization.approve_graph_projection(
            scope, graph_approval_ref, record.digest
        ):
            return None, "graph_projection_approval_required"

        request = _operation_request(preview, record, context)
        key = _operation_key(scope, task_id, batch_id, record, "project")
        operation = self._operations.begin(
            scope,
            task_id=task_id,
            idempotency_key=key,
            operation_type=f"navigator.conversation_migration.{record.kind}.project",
            request=request,
        )
        if operation.status == "verified":
            projection_ref, readback_digest = self._read_verified_operation(
                scope, operation, record, context
            )
            return (
                _ProjectionRef(
                    kind=projection_ref.kind,
                    entity_id=projection_ref.entity_id,
                    version=projection_ref.version,
                    context=context,
                    candidate_id=projection_ref.candidate_id,
                    readback_sha256=readback_digest,
                    operation_id=operation.operation_id,
                    replayed=True,
                    authorization_epoch=authorization_epoch,
                ),
                None,
            )

        try:
            projection_ref, readback_digest = self._project_and_verify(
                scope,
                task_id=task_id,
                batch_id=batch_id,
                record=record,
                context=context,
                source_refs=source_refs,
                prior_projections=prior_projections,
                operation=operation,
                profile_approval_ref=profile_approval_ref,
            )
        except MigrationError:
            raise
        except Exception as error:
            raise MigrationError(
                "CANONICAL_PROJECTION_FAILED",
                "Canonical import projection failed and requires task reconciliation.",
            ) from error
        completed = self._operations.complete(
            scope,
            task_id=task_id,
            operation_id=operation.operation_id,
            evidence={
                "recordId": record.record_id,
                "recordDigest": record.digest,
                "projectionKind": projection_ref.kind,
                "entityId": projection_ref.entity_id,
                "entityVersion": projection_ref.version,
                "candidateId": projection_ref.candidate_id,
                "readbackSha256": readback_digest,
                "authorizationEpoch": authorization_epoch,
            },
        )
        if completed.status != "verified":
            raise MigrationError(
                "OPERATION_NOT_VERIFIED", "Canonical write lacks a verified operation receipt."
            )
        return (
            _ProjectionRef(
                kind=projection_ref.kind,
                entity_id=projection_ref.entity_id,
                version=projection_ref.version,
                context=context,
                candidate_id=projection_ref.candidate_id,
                readback_sha256=readback_digest,
                operation_id=operation.operation_id,
                authorization_epoch=authorization_epoch,
            ),
            None,
        )

    def _project_and_verify(
        self,
        scope: ActorScope,
        *,
        task_id: str,
        batch_id: str,
        record: MigrationRecord,
        context: AuthorizedConversationContext,
        source_refs: Sequence[Mapping[str, object]],
        prior_projections: Mapping[str, _ProjectionRef],
        operation: OperationHandle,
        profile_approval_ref: str | None,
    ) -> tuple[_ProjectionRef, str]:
        """Call one canonical writer, independently read it back, and enforce state."""

        idempotency_key = _projection_key(scope, batch_id, record)
        if record.kind == "message":
            body = {
                "eventId": f"migration-{idempotency_key[-32:]}",
                "conversationId": context.conversation_id,
                "conversationKind": context.conversation_kind,
                "personaId": context.persona_id,
                "visibility": record.visibility,
                "role": record.data["role"],
                "content": record.data["content"],
                "occurredAt": record.data.get("occurredAt"),
                "sourceRefs": list(source_refs),
                "attachments": [],
                "relatedEventIds": [],
            }
            receipt = self._memory.create_message(scope, body)
            message = _nested_mapping(receipt, "message")
            entity_id = _required_id(message.get("id"), "message id")
            readback = self._memory.get_message(scope, entity_id)
            expected = _message_expected(body)
            actual = _message_actual(readback)
            if canonical_json(actual) != canonical_json(expected):
                raise MigrationError(
                    "MESSAGE_READBACK_MISMATCH", "Imported message readback differs."
                )
            projection = _ProjectionRef("message", entity_id, 1, context)
            return projection, hashlib.sha256(canonical_json(actual)).hexdigest()

        if record.kind == "memory":
            source_message_ids = _source_message_ids(source_refs)
            body = {
                "idempotencyKey": idempotency_key,
                "conversationId": context.conversation_id,
                "conversationKind": context.conversation_kind,
                "personaId": context.persona_id,
                "kind": record.data["memoryKind"],
                "text": record.data["text"],
                "sourceMessageIds": source_message_ids,
                "sourceRefs": list(source_refs),
                "visibility": record.visibility,
                "validUntil": record.valid_until,
            }
            receipt = self._memory.create_memory(scope, body)
            memory = _nested_mapping(receipt, "memory")
            entity_id = _required_id(memory.get("id"), "memory id")
            readback = _required_mapping(
                self._memory.get_memory(scope, entity_id), "memory readback"
            )
            expected = _memory_expected(body, source_message_ids)
            actual = _memory_actual(readback)
            if canonical_json(actual) != canonical_json(expected):
                raise MigrationError(
                    "MEMORY_READBACK_MISMATCH", "Imported memory readback differs."
                )
            version = _positive_version(readback.get("version"))
            projection = _ProjectionRef("memory", entity_id, version, context)
            return projection, hashlib.sha256(canonical_json(actual)).hexdigest()

        if record.kind == "profile":
            source_message_ids = _source_message_ids(source_refs)
            body = {
                "idempotencyKey": idempotency_key,
                "conversationId": context.conversation_id,
                "conversationKind": context.conversation_kind,
                "personaId": context.persona_id,
                "subjectKind": record.data["subjectKind"],
                "category": record.data["category"],
                "text": record.data["text"],
                "confidence": record.data["confidence"],
                "sourceMessageIds": source_message_ids,
                "sourceRefs": list(source_refs),
                "validUntil": record.valid_until,
            }
            receipt = self._profiles.create_candidate(scope, body)
            candidate = _unwrap_domain(receipt, "candidate")
            candidate_id = _required_id(candidate.get("id"), "profile candidate id")
            readback = _required_mapping(
                self._profiles.get_candidate(scope, candidate_id), "profile candidate readback"
            )
            expected = _profile_expected(body, source_message_ids, state="candidate")
            actual = _profile_candidate_actual(readback)
            if canonical_json(actual) != canonical_json(expected):
                raise MigrationError(
                    "PROFILE_READBACK_MISMATCH", "Imported profile candidate differs."
                )
            version = _positive_version(readback.get("version"))
            profile_id: str | None = None
            if self._authorization.approve_profile_activation(
                scope, profile_approval_ref, record.digest
            ):
                activated = self._profiles.activate_candidate(scope, candidate_id, version)
                profile = _unwrap_domain(activated, "profile")
                profile_id = _required_id(profile.get("id"), "profile id")
                active_readback = _required_mapping(
                    self._profiles.get_profile(scope, profile_id), "profile readback"
                )
                active_expected = _profile_expected(body, source_message_ids, state="active")
                active_actual = _profile_actual(active_readback)
                if canonical_json(active_actual) != canonical_json(active_expected):
                    raise MigrationError(
                        "PROFILE_READBACK_MISMATCH", "Activated profile readback differs."
                    )
                active_version = _positive_version(active_readback.get("version"))
                projection = _ProjectionRef(
                    "profile_active", profile_id, active_version, context, candidate_id=candidate_id
                )
                return projection, hashlib.sha256(canonical_json(active_actual)).hexdigest()
            projection = _ProjectionRef(
                "profile_candidate", candidate_id, version, context, candidate_id=candidate_id
            )
            return projection, hashlib.sha256(canonical_json(actual)).hexdigest()

        if record.kind == "graph":
            body = self._graph_body(record, batch_id, context, prior_projections)
            changeset = self._graph.project_changeset(
                scope, body, operation_id=operation.operation_id
            )
            changeset_view = _unwrap_domain(changeset, "changeset")
            entity_id = _required_id(changeset_view.get("id"), "graph changeset id")
            readback = _required_mapping(
                self._graph.get_changeset(scope, entity_id), "graph changeset readback"
            )
            _verify_graph_readback(readback)
            version = _positive_version(readback.get("version"))
            projection = _ProjectionRef("graph", entity_id, version, context)
            digest = hashlib.sha256(canonical_json(_graph_actual(readback))).hexdigest()
            return projection, digest

        raise MigrationError("RECORD_KIND_UNSUPPORTED", "Migration record kind is unsupported.")

    def _graph_body(
        self,
        record: MigrationRecord,
        batch_id: str,
        context: AuthorizedConversationContext,
        prior_projections: Mapping[str, _ProjectionRef],
    ) -> dict[str, object]:
        """Rebind graph lineage to canonical message and memory IDs in target scope."""

        key = _projection_key_from_digest(batch_id, record.digest)
        raw_nodes = record.data.get("nodes")
        raw_edges = record.data.get("edges")
        if not isinstance(raw_nodes, list) or not isinstance(raw_edges, list):
            raise MigrationError("GRAPH_PAYLOAD_INVALID", "Graph record arrays are invalid.")
        id_map: dict[str, str] = {}
        for item in raw_nodes:
            if not isinstance(item, Mapping) or not isinstance(item.get("id"), str):
                raise MigrationError("GRAPH_PAYLOAD_INVALID", "Graph node ID is invalid.")
            id_map[str(item["id"])] = f"migration-{key[:12]}-{_short_hash(str(item['id']))}"
        nodes: list[dict[str, object]] = []
        for item in raw_nodes:
            assert isinstance(item, Mapping)
            refs = _source_refs_for_ids(
                item.get("sourceRecordIds", record.source_record_ids), prior_projections, context
            )
            if refs is None:
                raise MigrationError("GRAPH_SOURCE_MISSING", "Graph node lineage is not available.")
            nodes.append(
                {
                    "id": id_map[str(item["id"])],
                    "label": item["label"],
                    "properties": item.get("properties", {}),
                    "sourceMessageIds": _source_message_ids(refs),
                    "sourceRefs": refs,
                }
            )
        edges: list[dict[str, object]] = []
        for item in raw_edges:
            assert isinstance(item, Mapping)
            refs = _source_refs_for_ids(
                item.get("sourceRecordIds", record.source_record_ids), prior_projections, context
            )
            if refs is None:
                raise MigrationError("GRAPH_SOURCE_MISSING", "Graph edge lineage is not available.")
            from_id = str(item["fromId"])
            to_id = str(item["toId"])
            if from_id not in id_map or to_id not in id_map:
                raise MigrationError(
                    "GRAPH_ENDPOINT_MISSING", "Graph edge endpoint is outside its changeset."
                )
            edges.append(
                {
                    "id": f"migration-{key[:12]}-{_short_hash(str(item['id']))}",
                    "fromId": id_map[from_id],
                    "toId": id_map[to_id],
                    "label": item["label"],
                    "properties": item.get("properties", {}),
                    "sourceMessageIds": _source_message_ids(refs),
                    "sourceRefs": refs,
                }
            )
        return {
            "idempotencyKey": key,
            "conversationId": context.conversation_id,
            "conversationKind": context.conversation_kind,
            "personaId": context.persona_id,
            "nodes": nodes,
            "edges": edges,
        }

    def _read_verified_operation(
        self,
        scope: ActorScope,
        operation: OperationHandle,
        record: MigrationRecord,
        context: AuthorizedConversationContext,
    ) -> tuple[_ProjectionRef, str]:
        """Validate an already verified operation through a fresh canonical readback."""

        evidence = operation.evidence
        if (
            evidence.get("recordDigest") != record.digest
            or evidence.get("projectionKind")
            not in {"message", "memory", "profile_candidate", "profile_active", "graph"}
            or not isinstance(evidence.get("entityId"), str)
            or type(evidence.get("entityVersion")) is not int
            or not isinstance(evidence.get("readbackSha256"), str)
            or type(evidence.get("authorizationEpoch")) is not int
        ):
            raise MigrationError(
                "OPERATION_EVIDENCE_INVALID", "Verified operation evidence is incomplete."
            )
        kind = str(evidence["projectionKind"])
        entity_id = str(evidence["entityId"])
        version = _required_int(evidence.get("entityVersion"), "operation entity version")
        candidate_value = evidence.get("candidateId")
        candidate_id = candidate_value if isinstance(candidate_value, str) else None
        readback = self._read_projection(scope, kind, entity_id)
        digest = _projection_readback_digest(kind, readback)
        if digest != evidence["readbackSha256"]:
            raise MigrationError(
                "OPERATION_READBACK_CHANGED", "Previously verified projection changed."
            )
        return (
            _ProjectionRef(
                kind,
                entity_id,
                version,
                context,
                candidate_id,
                authorization_epoch=_required_int(
                    evidence.get("authorizationEpoch"), "operation authorization epoch"
                ),
            ),
            digest,
        )

    def _read_projection(
        self, scope: ActorScope, kind: str, entity_id: str
    ) -> Mapping[str, object]:
        """Read one canonical projection through its public scope-bound API."""

        if kind == "message":
            return _required_mapping(self._memory.get_message(scope, entity_id), "message readback")
        if kind == "memory":
            return _required_mapping(self._memory.get_memory(scope, entity_id), "memory readback")
        if kind == "profile_candidate":
            return _required_mapping(
                self._profiles.get_candidate(scope, entity_id), "candidate readback"
            )
        if kind == "profile_active":
            return _required_mapping(
                self._profiles.get_profile(scope, entity_id), "profile readback"
            )
        if kind == "graph":
            return _required_mapping(self._graph.get_changeset(scope, entity_id), "graph readback")
        raise MigrationError("PROJECTION_KIND_INVALID", "Stored projection kind is unsupported.")

    def _read_rollback_projection(
        self, scope: ActorScope, kind: str, entity_id: str
    ) -> Mapping[str, object]:
        """Read terminal compensation state, including a memory tombstone when required."""

        if kind == "memory":
            return _required_mapping(
                self._memory.get_memory(scope, entity_id, include_deleted=True),
                "deleted memory tombstone",
            )
        return self._read_projection(scope, kind, entity_id)

    def _append_quarantine(
        self,
        scope: ActorScope,
        task_id: str,
        batch_id: str,
        preview: ImportPreview,
        ordinal: int,
        line: SourceLine,
        reason: str,
        *,
        record: MigrationRecord | None = None,
    ) -> None:
        """Persist one privacy-safe quarantine checkpoint in the existing Work Task."""

        event = {
            "migrationEvent": "record",
            "batchId": batch_id,
            "artifactSha256": preview.artifact_sha256,
            "ordinal": ordinal,
            "sourceCursor": line.cursor_after,
            "recordId": record.record_id if record is not None else None,
            "recordKind": record.kind if record is not None else None,
            "recordDigest": record.digest if record is not None else None,
            "state": "quarantined",
            "reasonCode": reason,
        }
        self._progress.append_checkpoint(
            scope,
            task_id=task_id,
            event_id=_progress_event_id(batch_id, ordinal, "record"),
            event=event,
        )

    def _append_projection_checkpoint(
        self,
        scope: ActorScope,
        task_id: str,
        batch_id: str,
        preview: ImportPreview,
        record: MigrationRecord,
        ordinal: int,
        cursor: str,
        projection: _ProjectionRef,
        state: str,
    ) -> None:
        """Persist IDs, versions, and readback digest without storing source text."""

        if projection.operation_id is None:
            raise MigrationError(
                "OPERATION_CHECKPOINT_MISSING", "Projection has no Work Operation ID."
            )
        operation = self._operations.get(
            scope, task_id=task_id, operation_id=projection.operation_id
        )
        if operation.status != "verified":
            raise MigrationError(
                "OPERATION_NOT_VERIFIED", "Projection checkpoint has no verified operation."
            )
        evidence = operation.evidence
        if evidence.get("readbackSha256") != projection.readback_sha256:
            raise MigrationError(
                "OPERATION_EVIDENCE_MISMATCH", "Projection readback evidence changed."
            )
        event = {
            "migrationEvent": "record",
            "batchId": batch_id,
            "artifactSha256": preview.artifact_sha256,
            "ordinal": ordinal,
            "sourceCursor": cursor,
            "recordId": record.record_id,
            "recordKind": record.kind,
            "recordDigest": record.digest,
            "state": state,
            "projectionKind": projection.kind,
            "entityId": projection.entity_id,
            "entityVersion": projection.version,
            "candidateId": projection.candidate_id,
            "targetContext": _context_to_mapping(projection.context),
            "readbackSha256": evidence.get("readbackSha256"),
            "operationId": operation.operation_id,
            "replayed": projection.replayed,
            "authorizationEpoch": projection.authorization_epoch,
        }
        self._progress.append_checkpoint(
            scope,
            task_id=task_id,
            event_id=_progress_event_id(batch_id, ordinal, "record"),
            event=event,
        )

    def _rollback_one(
        self,
        scope: ActorScope,
        task_id: str,
        batch_id: str,
        preview: ImportPreview,
        event: Mapping[str, object],
    ) -> None:
        """Compensate one durable projection and independently confirm its terminal state."""

        ordinal = _required_int(event.get("ordinal"), "rollback ordinal")
        kind = event.get("projectionKind")
        entity_id = event.get("entityId")
        version = event.get("entityVersion")
        if (
            kind not in {"message", "memory", "profile_candidate", "profile_active", "graph"}
            or not isinstance(entity_id, str)
            or type(version) is not int
        ):
            raise MigrationError(
                "ROLLBACK_CHECKPOINT_INVALID", "Rollback checkpoint is incomplete."
            )
        operation = self._operations.begin(
            scope,
            task_id=task_id,
            idempotency_key=_rollback_operation_key(task_id, batch_id, ordinal),
            operation_type=f"navigator.conversation_migration.{kind}.rollback",
            request={
                "artifactSha256": preview.artifact_sha256,
                "batchId": batch_id,
                "ordinal": ordinal,
                "entityId": entity_id,
                "entityVersion": version,
            },
        )
        if operation.status == "verified":
            readback = self._read_rollback_projection(scope, str(kind), entity_id)
            if not _is_rolled_back(str(kind), readback):
                raise MigrationError(
                    "ROLLBACK_READBACK_MISMATCH", "Verified rollback is no longer visible."
                )
            rollback_digest = hashlib.sha256(
                canonical_json(_projection_view_for_rollback(str(kind), readback))
            ).hexdigest()
        else:
            readback = self._compensate(scope, str(kind), entity_id, version, event)
            if not _is_rolled_back(str(kind), readback):
                raise MigrationError(
                    "ROLLBACK_READBACK_MISMATCH", "Canonical rollback did not read back."
                )
            rollback_digest = hashlib.sha256(
                canonical_json(_projection_view_for_rollback(str(kind), readback))
            ).hexdigest()
            completed = self._operations.complete(
                scope,
                task_id=task_id,
                operation_id=operation.operation_id,
                evidence={
                    "batchId": batch_id,
                    "ordinal": ordinal,
                    "entityId": entity_id,
                    "readbackSha256": rollback_digest,
                    "rolledBack": True,
                },
            )
            if completed.status != "verified":
                raise MigrationError(
                    "ROLLBACK_OPERATION_UNVERIFIED", "Rollback lacks a verified operation receipt."
                )
        self._progress.append_checkpoint(
            scope,
            task_id=task_id,
            event_id=_progress_event_id(batch_id, ordinal, "rollback"),
            event={
                "migrationEvent": "rollback",
                "batchId": batch_id,
                "artifactSha256": preview.artifact_sha256,
                "ordinal": ordinal,
                "entityId": entity_id,
                "readbackSha256": rollback_digest,
                "state": "rolled_back",
                "operationId": operation.operation_id,
            },
        )

    def _compensate(
        self,
        scope: ActorScope,
        kind: str,
        entity_id: str,
        version: int,
        event: Mapping[str, object],
    ) -> Mapping[str, object]:
        """Call the exact canonical compensating operation for one projection type."""

        if kind == "message":
            self._memory.revoke_message(scope, entity_id)
            return _required_mapping(self._memory.get_message(scope, entity_id), "revoked message")
        if kind == "memory":
            self._memory.delete_memory(scope, entity_id, version)
            return _required_mapping(
                self._memory.get_memory(scope, entity_id, include_deleted=True),
                "deleted memory tombstone",
            )
        if kind == "profile_candidate":
            self._profiles.rollback_candidate(scope, entity_id, version)
            return _required_mapping(
                self._profiles.get_candidate(scope, entity_id), "rolled-back candidate"
            )
        if kind == "profile_active":
            self._profiles.rollback_profile(scope, entity_id, version)
            return _required_mapping(
                self._profiles.get_profile(scope, entity_id), "rolled-back profile"
            )
        if kind == "graph":
            self._graph.rollback_changeset(scope, entity_id, version)
            return _required_mapping(
                self._graph.get_changeset(scope, entity_id), "rolled-back graph"
            )
        raise MigrationError(
            "ROLLBACK_KIND_UNSUPPORTED", "Rollback projection kind is unsupported."
        )

    def _receipt_from_progress(
        self,
        batch_id: str,
        preview: ImportPreview,
        progress: _LoadedProgress,
        status: str,
    ) -> MigrationReceipt:
        """Reconstruct a terminal count receipt from task events."""

        projected = sum(1 for event in progress.record_events if event.get("state") == "projected")
        candidates = sum(1 for event in progress.record_events if event.get("state") == "candidate")
        quarantined = sum(
            1 for event in progress.record_events if event.get("state") == "quarantined"
        )
        return MigrationReceipt(
            batch_id=batch_id,
            artifact_sha256=preview.artifact_sha256,
            status=status,  # type: ignore[arg-type]
            read_count=progress.ordinal,
            projected_count=projected,
            candidate_count=candidates,
            replayed_count=0,
            quarantined_count=quarantined,
            rolled_back_count=len(progress.rollback_ordinals),
            projection_sha256=_progress_digest(progress.record_events),
            completed_cursor=progress.cursor,
        )


def _validate_header(header: object, settings: MigrationSettings) -> Mapping[str, object]:
    """Validate one explicit migration or actor-backup header."""

    if not isinstance(header, Mapping):
        raise MigrationError("IMPORT_HEADER_INVALID", "Staged artifact header is invalid.")
    source_kind = header.get("sourceKind")
    record_count = header.get("recordCount")
    if (
        not isinstance(header, Mapping)
        or set(header) != {"recordType", "schemaVersion", "sourceKind", "recordCount"}
        or header.get("recordType") != "header"
        or header.get("schemaVersion") != 1
        or not isinstance(source_kind, str)
        or not source_kind.strip()
        or len(source_kind) > 64
        or type(record_count) is not int
        or not 0 <= record_count <= settings.max_records
    ):
        raise MigrationError("IMPORT_HEADER_INVALID", "Staged artifact header is invalid.")
    return header


def _validate_page(page: object, maximum: int) -> None:
    """Reject malformed or unbounded source pages before consuming them."""

    from .ports import SourcePage

    if not isinstance(page, SourcePage) or len(page.items) > maximum:
        raise MigrationError("IMPORT_PAGE_INVALID", "Staged artifact page exceeds its limit.")
    for line in page.items:
        if (
            not isinstance(line, SourceLine)
            or not isinstance(line.cursor_after, str)
            or not line.cursor_after
            or len(line.cursor_after) > 1_024
        ):
            raise MigrationError("IMPORT_PAGE_INVALID", "Staged artifact line cursor is invalid.")
    if page.next_cursor is not None and (
        not isinstance(page.next_cursor, str)
        or not page.next_cursor
        or len(page.next_cursor) > 1_024
    ):
        raise MigrationError("IMPORT_PAGE_INVALID", "Staged artifact next cursor is invalid.")


def _scope_digest(scope: ActorScope) -> str:
    """Hash the host-derived target scope without exposing actor identity in reports."""

    return hashlib.sha256(
        canonical_json([scope.organization_id or "", scope.workspace_id, scope.actor_id])
    ).hexdigest()


def _context_digest(context: AuthorizedConversationContext) -> str:
    """Return a privacy-safe digest of one host-authorized conversation mapping."""

    return hashlib.sha256(canonical_json(_context_to_mapping(context))).hexdigest()


def _context_to_mapping(context: AuthorizedConversationContext) -> dict[str, object]:
    """Serialize only target conversation scope for actor-private task checkpoints."""

    return {
        "conversationId": context.conversation_id,
        "conversationKind": context.conversation_kind,
        "personaId": context.persona_id,
    }


def _context_from_mapping(value: Mapping[str, object]) -> AuthorizedConversationContext:
    """Validate a persisted host-resolved target context before resuming a batch."""

    if set(value) != {"conversationId", "conversationKind", "personaId"}:
        raise MigrationError("TASK_CHECKPOINT_INVALID", "Stored target context has invalid fields.")
    try:
        return AuthorizedConversationContext(
            conversation_id=str(value["conversationId"]),
            conversation_kind=value["conversationKind"],  # type: ignore[arg-type]
            persona_id=value["personaId"],  # type: ignore[arg-type]
        )
    except (TypeError, ValueError) as error:
        raise MigrationError(
            "TASK_CHECKPOINT_INVALID", "Stored target context is invalid."
        ) from error


def _hash_plan_row(
    digest: Any,
    ordinal: int,
    record: MigrationRecord | None,
    result: str,
    target_context_digest: str | None,
    authorization_epoch: int | None,
) -> None:
    """Fold one privacy-safe dry-run outcome into the stable plan digest."""

    digest.update(
        canonical_json(
            {
                "ordinal": ordinal,
                "recordId": record.record_id if record is not None else None,
                "recordKind": record.kind if record is not None else None,
                "recordDigest": record.digest if record is not None else None,
                "result": result,
                "targetContextDigest": target_context_digest,
                "authorizationEpoch": authorization_epoch,
            }
        )
    )
    digest.update(b"\n")


def _match_preview(source: MigrationSource, preview: ImportPreview) -> None:
    """Require the preview to name the exact host artifact and a valid plan digest."""

    if (
        not isinstance(preview, ImportPreview)
        or preview.artifact_id != source.artifact_id
        or preview.artifact_sha256 != source.expected_sha256
        or re.fullmatch(r"[a-f0-9]{64}", preview.plan_sha256) is None
        or type(preview.record_count) is not int
        or type(preview.accepted_count) is not int
        or type(preview.quarantined_count) is not int
        or preview.record_count != preview.accepted_count + preview.quarantined_count
    ):
        raise MigrationError(
            "IMPORT_PREVIEW_INVALID", "Import preview does not match this artifact."
        )


def _batch_id(plan_sha256: str) -> str:
    """Create a stable bounded batch identity from the approved dry-run plan."""

    return _BATCH_PREFIX + plan_sha256


def _validate_task_id(task_id: str) -> None:
    """Require the caller to bind progress to an existing bounded Work Task."""

    if not isinstance(task_id, str) or _TASK_ID.fullmatch(task_id) is None:
        raise MigrationError("WORK_TASK_REQUIRED", "An existing Work Task ID is required.")


def _operation_key(
    scope: ActorScope,
    task_id: str,
    batch_id: str,
    record: MigrationRecord,
    action: str,
) -> str:
    """Create a stable per-record Work Operation idempotency key without source text."""

    material = {
        "scopeDigest": _scope_digest(scope),
        "taskId": task_id,
        "batchId": batch_id,
        "recordId": record.record_id,
        "recordDigest": record.digest,
        "action": action,
    }
    return "migration-operation:" + hashlib.sha256(canonical_json(material)).hexdigest()


def _operation_request(
    preview: ImportPreview,
    record: MigrationRecord,
    context: AuthorizedConversationContext,
) -> dict[str, object]:
    """Return the content-free stable intent for replay and tail reconciliation."""

    return {
        "artifactSha256": preview.artifact_sha256,
        "recordId": record.record_id,
        "recordKind": record.kind,
        "recordDigest": record.digest,
        "targetContextDigest": _context_digest(context),
    }


def _projection_key(scope: ActorScope, batch_id: str, record: MigrationRecord) -> str:
    """Create the canonical store idempotency key for one imported entity."""

    material = {
        "scopeDigest": _scope_digest(scope),
        "batchId": batch_id,
        "recordId": record.record_id,
        "recordDigest": record.digest,
    }
    return "migration-" + hashlib.sha256(canonical_json(material)).hexdigest()


def _projection_key_from_digest(batch_id: str, record_digest: str) -> str:
    """Produce the stable graph ID namespace from this specific approved batch."""

    return hashlib.sha256(f"{batch_id}\0{record_digest}".encode("ascii")).hexdigest()


def _progress_event_id(batch_id: str, ordinal: int, event_type: str) -> str:
    """Build a durable event ID that makes task checkpoint appends idempotent."""

    digest = hashlib.sha256(f"{batch_id}\0{ordinal}\0{event_type}".encode()).hexdigest()
    return f"migration-{digest}"


def _rollback_operation_key(task_id: str, batch_id: str, ordinal: int) -> str:
    """Derive a stable Work Operation key for one per-batch compensation."""

    return (
        "migration-rollback:"
        + hashlib.sha256(f"{task_id}\0{batch_id}\0{ordinal}".encode("ascii")).hexdigest()
    )


def _short_hash(value: str) -> str:
    """Return a short collision-resistant suffix for imported graph entity IDs."""

    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]


def _resolve_source_refs(
    record: MigrationRecord,
    projections: Mapping[str, _ProjectionRef],
    context: AuthorizedConversationContext,
) -> list[dict[str, object]] | None:
    """Resolve source-local IDs only through prior canonical message/memory readbacks."""

    return _source_refs_for_ids(record.source_record_ids, projections, context)


def _source_refs_for_ids(
    source_ids: object,
    projections: Mapping[str, _ProjectionRef],
    context: AuthorizedConversationContext,
) -> list[dict[str, object]] | None:
    """Translate source record links to current canonical IDs and versions."""

    if not isinstance(source_ids, (list, tuple)):
        return None
    message_ids: list[str] = []
    memory_refs: list[dict[str, object]] = []
    seen: set[str] = set()
    for source_id in source_ids:
        if not isinstance(source_id, str) or source_id in seen:
            return None
        seen.add(source_id)
        projection = projections.get(source_id)
        if projection is None or projection.context != context:
            return None
        if projection.kind == "message":
            message_ids.append(projection.entity_id)
        elif projection.kind == "memory":
            memory_refs.append(
                {
                    "memoryId": projection.entity_id,
                    "memoryVersion": projection.version,
                    "sourceMessageIds": [],
                }
            )
        else:
            return None
    references = sorted(memory_refs, key=lambda item: str(item["memoryId"]))
    if message_ids:
        references.append(
            {
                "memoryId": None,
                "memoryVersion": None,
                "sourceMessageIds": sorted(set(message_ids)),
            }
        )
    return references


def _source_message_ids(source_refs: Sequence[Mapping[str, object]]) -> list[str]:
    """Flatten the message portion of canonical source references deterministically."""

    message_ids: set[str] = set()
    for source_ref in source_refs:
        raw_ids = source_ref.get("sourceMessageIds", [])
        if isinstance(raw_ids, list):
            message_ids.update(item for item in raw_ids if isinstance(item, str))
    return sorted(message_ids)


def _required_mapping(value: object, label: str) -> Mapping[str, object]:
    """Require a mapping returned by a canonical readback port."""

    if not isinstance(value, Mapping):
        raise MigrationError("CANONICAL_READBACK_MISSING", f"Canonical {label} is unavailable.")
    return value


def _nested_mapping(value: object, key: str) -> Mapping[str, object]:
    """Read one wrapped provider receipt or accept a direct canonical view."""

    mapping = _required_mapping(value, key)
    nested = mapping.get(key)
    if nested is None and key == "candidate":
        nested = mapping.get("profileCandidate")
    if nested is None and key == "changeset":
        nested = mapping.get("graphChangeset")
    if nested is None and key == "message":
        nested = mapping.get("message")
    if nested is None and key == "memory":
        nested = mapping.get("memory")
    return nested if isinstance(nested, Mapping) else mapping


def _unwrap_domain(value: object, key: str) -> Mapping[str, object]:
    """Accept the canonical store's direct view or its documented wrapper shape."""

    mapping = _required_mapping(value, key)
    nested = mapping.get(key)
    if isinstance(nested, Mapping):
        return nested
    aliases = {"candidate": "profileCandidate", "changeset": "graphChangeset"}
    alias = aliases.get(key)
    if alias is not None and isinstance(mapping.get(alias), Mapping):
        return mapping[alias]  # type: ignore[return-value]
    return mapping


def _required_id(value: object, label: str) -> str:
    """Validate an opaque canonical object ID before storing it in progress."""

    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise MigrationError("CANONICAL_ID_INVALID", f"Canonical {label} is invalid.")
    return value


def _required_int(value: object, label: str) -> int:
    """Require a JSON integer without accepting booleans."""

    if type(value) is not int:
        raise MigrationError("CANONICAL_INTEGER_INVALID", f"{label} is invalid.")
    return value


def _mapping_list(value: object, label: str) -> list[Mapping[str, object]]:
    """Require a list containing only mapping values before copying it."""

    if not isinstance(value, list) or any(not isinstance(item, Mapping) for item in value):
        raise MigrationError("CANONICAL_SHAPE_INVALID", f"{label} has an invalid shape.")
    return list(value)


def _positive_version(value: object) -> int:
    """Require a positive canonical record version."""

    if type(value) is not int or value < 1:
        raise MigrationError("CANONICAL_VERSION_INVALID", "Canonical object version is invalid.")
    return value


def _message_expected(body: Mapping[str, object]) -> dict[str, object]:
    """Select stable message fields that must survive an independent readback."""

    return {
        "eventId": body["eventId"],
        "role": body["role"],
        "content": body["content"],
        "occurredAt": body["occurredAt"],
        "status": "active",
        "sourceRefs": _mapping_list(body.get("sourceRefs"), "sourceRefs"),
        "attachments": [],
        "scope": {
            "conversationId": body["conversationId"],
            "conversationKind": body["conversationKind"],
            "personaId": body["personaId"],
            "visibility": body["visibility"],
        },
    }


def _message_actual(value: object) -> dict[str, object]:
    """Read exact stable message payload fields while excluding generated IDs/times."""

    message = _required_mapping(value, "message readback")
    scope = _required_mapping(message.get("scope"), "message scope")
    return {
        "eventId": message.get("eventId"),
        "role": message.get("role"),
        "content": message.get("content"),
        "occurredAt": message.get("occurredAt"),
        "status": message.get("status"),
        "sourceRefs": message.get("sourceRefs"),
        "attachments": message.get("attachments"),
        "scope": {
            "conversationId": scope.get("conversationId"),
            "conversationKind": scope.get("conversationKind"),
            "personaId": scope.get("personaId"),
            "visibility": scope.get("visibility"),
        },
    }


def _memory_expected(
    body: Mapping[str, object], source_message_ids: Sequence[str]
) -> dict[str, object]:
    """Select stable memory fields for exact canonical readback comparison."""

    return {
        "kind": body["kind"],
        "text": body["text"],
        "sourceMessageIds": list(source_message_ids),
        "sourceRefs": _mapping_list(body.get("sourceRefs"), "sourceRefs"),
        "state": "active",
        "validUntil": body["validUntil"],
        "scope": {
            "conversationId": body["conversationId"],
            "conversationKind": body["conversationKind"],
            "personaId": body["personaId"],
            "visibility": body["visibility"],
        },
    }


def _memory_actual(value: object) -> dict[str, object]:
    """Read stable memory fields, including current state and exact source lineage."""

    memory = _required_mapping(value, "memory readback")
    scope = _required_mapping(memory.get("scope"), "memory scope")
    return {
        "kind": memory.get("kind"),
        "text": memory.get("text"),
        "sourceMessageIds": memory.get("sourceMessageIds"),
        "sourceRefs": memory.get("sourceRefs"),
        "state": memory.get("state"),
        "validUntil": memory.get("validUntil"),
        "scope": {
            "conversationId": scope.get("conversationId"),
            "conversationKind": scope.get("conversationKind"),
            "personaId": scope.get("personaId"),
            "visibility": scope.get("visibility"),
        },
    }


def _profile_expected(
    body: Mapping[str, object], source_message_ids: Sequence[str], *, state: str
) -> dict[str, object]:
    """Select common candidate/profile evidence fields for independent readback."""

    return {
        "conversationId": body["conversationId"],
        "conversationKind": body["conversationKind"],
        "subjectKind": body["subjectKind"],
        "personaId": body["personaId"],
        "category": body["category"],
        "text": body["text"],
        "sourceMessageIds": list(source_message_ids),
        "sourceRefs": _mapping_list(body.get("sourceRefs"), "sourceRefs"),
        "confidence": body["confidence"],
        "validUntil": body["validUntil"],
        "state": state,
    }


def _profile_candidate_actual(value: object) -> dict[str, object]:
    """Read a source-bound candidate without treating it as an active profile."""

    profile = _required_mapping(value, "profile candidate readback")
    return _profile_common_actual(profile, confidence=profile.get("confidence"))


def _profile_actual(value: object) -> dict[str, object]:
    """Read an activated profile and its persisted evidence confidence."""

    profile = _required_mapping(value, "profile readback")
    evidence = profile.get("evidence")
    confidence = evidence.get("confidence") if isinstance(evidence, Mapping) else None
    return _profile_common_actual(profile, confidence=confidence)


def _profile_common_actual(
    profile: Mapping[str, object], *, confidence: object
) -> dict[str, object]:
    """Return the common source-backed profile state used for readback checks."""

    return {
        "conversationId": profile.get("conversationId"),
        "conversationKind": profile.get("conversationKind"),
        "subjectKind": profile.get("subjectKind"),
        "personaId": profile.get("personaId"),
        "category": profile.get("category"),
        "text": profile.get("text"),
        "sourceMessageIds": profile.get("sourceMessageIds"),
        "sourceRefs": profile.get("sourceRefs"),
        "confidence": confidence,
        "validUntil": profile.get("validUntil"),
        "state": profile.get("state"),
    }


def _verify_graph_readback(value: object) -> None:
    """Require an applied graph receipt that matches an independent provider readback."""

    changeset = _required_mapping(value, "graph changeset readback")
    nodes = changeset.get("nodes")
    edges = changeset.get("edges")
    receipt = changeset.get("providerReceipt")
    digest = changeset.get("digest")
    if (
        changeset.get("state") != "projected"
        or not isinstance(nodes, list)
        or not isinstance(edges, list)
        or not isinstance(digest, str)
        or not isinstance(receipt, Mapping)
        or receipt.get("requestDigest") != digest
        or receipt.get("readbackDigest") != digest
        or receipt.get("nodeCount") != len(nodes)
        or receipt.get("edgeCount") != len(edges)
    ):
        raise MigrationError(
            "GRAPH_READBACK_MISMATCH", "Provider graph readback is incomplete or mismatched."
        )


def _graph_actual(value: object) -> dict[str, object]:
    """Return the verified graph digest, counts, state, and provider receipt digest."""

    changeset = _required_mapping(value, "graph changeset readback")
    _verify_graph_readback(changeset)
    nodes = changeset["nodes"]
    edges = changeset["edges"]
    receipt = changeset["providerReceipt"]
    assert isinstance(nodes, list) and isinstance(edges, list) and isinstance(receipt, Mapping)
    return {
        "digest": changeset["digest"],
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
        "state": changeset["state"],
        "providerReadbackDigest": receipt["readbackDigest"],
    }


def _projection_readback_digest(kind: str, readback: Mapping[str, object]) -> str:
    """Hash stable canonical fields using the same representation as initial projection."""

    if kind == "message":
        actual = _message_actual(readback)
    elif kind == "memory":
        actual = _memory_actual(readback)
    elif kind == "profile_candidate":
        actual = _profile_candidate_actual(readback)
    elif kind == "profile_active":
        actual = _profile_actual(readback)
    elif kind == "graph":
        actual = _graph_actual(readback)
    else:
        raise MigrationError("PROJECTION_KIND_INVALID", "Stored projection kind is unsupported.")
    return hashlib.sha256(canonical_json(actual)).hexdigest()


def _is_rolled_back(kind: str, value: Mapping[str, object]) -> bool:
    """Recognize only explicit canonical terminal rollback states."""

    expected = {
        "message": "revoked",
        "memory": "deleted",
        "profile_candidate": "rolled_back",
        "profile_active": "rolled_back",
        "graph": "rolled_back",
    }
    field_name = "status" if kind == "message" else "state"
    return value.get(field_name) == expected.get(kind)


def _projection_view_for_rollback(kind: str, value: Mapping[str, object]) -> Mapping[str, object]:
    """Select non-content terminal fields for rollback receipt hashing."""

    return {
        "kind": kind,
        "id": value.get("id"),
        "state": value.get("status") if kind == "message" else value.get("state"),
        "version": value.get("version"),
    }


def _progress_digest(events: Sequence[Mapping[str, object]]) -> str:
    """Hash projection receipts in task order for deterministic reconciliation."""

    digest = hashlib.sha256()
    for event in events:
        if event.get("state") in {"projected", "candidate"}:
            digest.update(
                f"{event.get('recordDigest')}:{event.get('readbackSha256')}\n".encode("ascii")
            )
    return digest.hexdigest()
