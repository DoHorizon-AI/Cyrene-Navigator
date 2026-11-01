"""
┌─────────────────────────────────────────────────────────────────────┐
│  Module: cyrene_navigator.work.conversation_memory.domain_api        │
│  Role: Authenticated routes for conversation product domains.       │
│                                                                     │
│  模块职责：挂载产品域 HTTP 路由并在持久化前校验 actor 与来源授权。    │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
import time
from collections.abc import Mapping, Sequence
from typing import Literal, Protocol, cast

from fastapi import FastAPI, Query, Request, Response
from pydantic import BaseModel

from cyrene_navigator.persistence.errors import WORKSPACE_FORBIDDEN, PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_memory.domain_models import (
    ActiveBehaviorPolicyPut,
    ActiveBehaviorPolicyReceipt,
    ExpectedVersion,
    FocusItemCreate,
    FocusItemReceipt,
    FocusItemsView,
    FocusItemTransitionReceipt,
    FocusState,
    FocusTransition,
    GraphChangesetsView,
    GraphProposalCreate,
    GraphProposalReceipt,
    GraphQuery,
    GraphQueryView,
    HandoffCreate,
    HandoffReceipt,
    HandoffView,
    ImportApplyReceipt,
    ImportBatchCreate,
    ImportPreviewView,
    ImportRollbackReceipt,
    MaintenanceCheckpointRequest,
    MaintenanceJobCancelReceipt,
    MaintenanceJobCreate,
    MaintenanceJobReceipt,
    MaintenanceJobsView,
    MaintenanceJobUpdateReceipt,
    MaintenanceJobView,
    MaintenanceState,
    PersonaPut,
    PersonaReceipt,
    PersonasView,
    ProfileCandidateCreate,
    ProfileCandidateReceipt,
    ProfileCandidatesView,
    ProfileReceipt,
    ProfilesView,
    ResearchNoteCreate,
    ResearchNoteReceipt,
    ResearchNotesView,
    ReviewEventCreate,
    ReviewEventReceipt,
    ReviewEventsView,
    VerifiedSkillCreate,
    VerifiedSkillReceipt,
    VerifiedSkillsView,
    WatchCreate,
    WatchesView,
    WatchReceipt,
    WatchSchedule,
    WatchUpdateReceipt,
)
from cyrene_navigator.work.conversation_memory.domains import (
    ConversationDomainStore,
    WireView,
    maintenance_task_id,
)


class PrincipalResolver(Protocol):
    """Host authentication callback with an explicit write boundary."""

    def __call__(
        self, request: Request, workspace_id: str, *, write: bool = False
    ) -> PersistencePrincipal: ...


class SourceIdValidator(Protocol):
    """Host callback that raises PersistenceError when any source is out of scope."""

    def __call__(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str | None,
        conversation_kind: str | None,
        persona_id: str | None,
        source_ids: Sequence[str],
    ) -> None: ...


class SourceRefValidator(Protocol):
    """Current-epoch P2 source and exact memory revision authorization."""

    def __call__(
        self,
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str | None,
        conversation_kind: str | None,
        persona_id: str | None,
        source_refs: Sequence[Mapping[str, object]],
    ) -> None: ...


class WorkTaskLookup(Protocol):
    """Actor-private WorkStore lookup used to verify maintenance receipts."""

    def get_task(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> Mapping[str, object]: ...

    def get_operation(
        self,
        organization_id: str | None,
        workspace_id: str,
        operation_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> Mapping[str, object]: ...


class GraphProvider(Protocol):
    """Provider operations whose write method performs an independent readback."""

    def apply_changeset(
        self,
        *,
        organization_id: str,
        workspace_id: str,
        actor_id: str,
        changeset: Mapping[str, object],
    ) -> Mapping[str, object]: ...

    def query(
        self,
        *,
        organization_id: str,
        workspace_id: str,
        actor_id: str,
        conversation_id: str,
        conversation_kind: str,
        persona_id: str | None,
        query: str,
        limit: int,
    ) -> Mapping[str, object]: ...


def _source_ref_payloads(
    source_refs: Sequence[object], source_ids: Sequence[str] = ()
) -> list[Mapping[str, object]]:
    """Normalize strict DTO refs and legacy message IDs to the P2 lineage shape."""

    if len(source_refs) > 256 or len(source_ids) > 128:
        raise PersistenceError(
            "CONVERSATION_DOMAIN_INVALID", 422, "Source reference count exceeds its limit."
        )
    normalized: list[Mapping[str, object]] = []
    for item in source_refs:
        if isinstance(item, str):
            value: Mapping[str, object] = {
                "memoryId": None,
                "memoryVersion": None,
                "sourceMessageIds": [item],
            }
        elif isinstance(item, Mapping):
            value = item
        elif isinstance(item, BaseModel):
            dumped = item.model_dump(by_alias=True, exclude_none=False)
            if not isinstance(dumped, Mapping):
                raise PersistenceError(
                    "CONVERSATION_DOMAIN_INVALID", 422, "Source reference must be an object."
                )
            value = dumped
        else:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_INVALID", 422, "Source reference must be an object."
            )
        if set(value) - {"memoryId", "memoryVersion", "sourceMessageIds"}:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_INVALID", 422, "Source reference has unsupported fields."
            )
        memory_id = value.get("memoryId")
        memory_version = value.get("memoryVersion")
        ids = value.get("sourceMessageIds", [])
        if (memory_id is None) != (memory_version is None):
            raise PersistenceError(
                "CONVERSATION_DOMAIN_INVALID", 422, "memoryId and memoryVersion must pair."
            )
        if memory_id is not None and (
            not isinstance(memory_id, str) or not memory_id or len(memory_id) > 512
        ):
            raise PersistenceError("CONVERSATION_DOMAIN_INVALID", 422, "memoryId is invalid.")
        if memory_version is not None and (
            isinstance(memory_version, bool)
            or not isinstance(memory_version, int)
            or memory_version < 1
        ):
            raise PersistenceError("CONVERSATION_DOMAIN_INVALID", 422, "memoryVersion is invalid.")
        if (
            not isinstance(ids, list)
            or len(ids) > 128
            or any(not isinstance(source_id, str) or not source_id for source_id in ids)
        ):
            raise PersistenceError(
                "CONVERSATION_DOMAIN_INVALID", 422, "sourceMessageIds are invalid."
            )
        if memory_id is None and not ids:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_INVALID", 422, "Source reference has no lineage."
            )
        normalized.append(
            {
                "memoryId": memory_id,
                "memoryVersion": memory_version,
                "sourceMessageIds": list(dict.fromkeys(ids)),
            }
        )
    unique_ids = list(dict.fromkeys(source_ids))
    if unique_ids:
        normalized.append({"memoryId": None, "memoryVersion": None, "sourceMessageIds": unique_ids})
    return _deduplicate_source_refs(normalized)


def _deduplicate_source_refs(
    source_refs: Sequence[Mapping[str, object]],
) -> list[Mapping[str, object]]:
    """Deduplicate normalized refs without losing exact memory revisions."""

    result: list[Mapping[str, object]] = []
    seen: set[tuple[str | None, int | None, tuple[str, ...]]] = set()
    for ref in source_refs:
        memory_id = ref.get("memoryId")
        memory_version = ref.get("memoryVersion")
        ids = ref.get("sourceMessageIds", [])
        if not isinstance(ids, list):
            continue
        key = (
            memory_id if isinstance(memory_id, str) else None,
            memory_version if isinstance(memory_version, int) else None,
            tuple(source_id for source_id in ids if isinstance(source_id, str)),
        )
        if key not in seen:
            seen.add(key)
            result.append(ref)
    return result

    def query(
        self,
        *,
        organization_id: str,
        workspace_id: str,
        actor_id: str,
        conversation_id: str,
        conversation_kind: str,
        persona_id: str | None,
        query: str,
        limit: int,
    ) -> Mapping[str, object]: ...


def mount_domain_routes(
    app: FastAPI,
    base: str,
    principal_for: PrincipalResolver,
    domain_store: ConversationDomainStore,
    validate_source_ids: SourceIdValidator | None = None,
    *,
    validate_source_refs: SourceRefValidator | None = None,
) -> None:
    """Mount authenticated P3–P10 routes on the host Work API.

    The host supplies identity, Workspace authorization, and source ownership
    checks. This module never accepts actor identity from a request body.
    """

    if validate_source_ids is None and validate_source_refs is None:
        raise ValueError("a source authorization callback is required")

    def actor_scope(
        request: Request, workspace_id: str, *, write: bool
    ) -> tuple[PersistencePrincipal, str]:
        principal = principal_for(request, workspace_id, write=write)
        if principal.organization_id is None:
            if write:
                raise PersistenceError(
                    WORKSPACE_FORBIDDEN,
                    403,
                    "An organization-scoped principal is required for domain writes.",
                )
            legacy_key = hashlib.sha256(
                f"{workspace_id}\0{principal.actor_id}".encode()
            ).hexdigest()[:32]
            return principal, f"legacy-{legacy_key}"
        return principal, principal.organization_id

    def validate_sources(
        principal: PersistencePrincipal,
        workspace_id: str,
        conversation_id: str | None,
        conversation_kind: str | None,
        persona_id: str | None,
        source_refs: Sequence[object],
        source_ids: Sequence[str] = (),
    ) -> None:
        normalized_refs = _source_ref_payloads(source_refs, source_ids)
        if normalized_refs and validate_source_refs is not None:
            validate_source_refs(
                principal.organization_id,
                workspace_id,
                principal.actor_id,
                conversation_id,
                conversation_kind,
                persona_id,
                normalized_refs,
            )
            return
        if normalized_refs and validate_source_ids is not None:
            if any(ref.get("memoryId") is not None for ref in normalized_refs):
                raise PersistenceError(
                    "CONVERSATION_DOMAIN_SOURCE_UNAVAILABLE",
                    409,
                    "Exact memory revision authorization is unavailable.",
                )
            message_id_set: set[str] = set()
            for ref in normalized_refs:
                ids = ref.get("sourceMessageIds")
                if isinstance(ids, list):
                    message_id_set.update(
                        source_id for source_id in ids if isinstance(source_id, str)
                    )
            message_ids = sorted(message_id_set)
            validate_source_ids(
                principal.organization_id,
                workspace_id,
                principal.actor_id,
                conversation_id,
                conversation_kind,
                persona_id,
                message_ids,
            )

    def view_sources_authorized(
        principal: PersistencePrincipal,
        workspace_id: str,
        view: Mapping[str, object],
    ) -> bool:
        """Recheck every stored source against current grants, expiry, and owner scope."""

        normalized_refs: list[Mapping[str, object]] = []
        source_ids: set[str] = set()

        def collect(value: object) -> None:
            if isinstance(value, Mapping):
                for key, nested in value.items():
                    if key == "sourceRefs":
                        if not isinstance(nested, list):
                            raise PersistenceError(
                                "CONVERSATION_DOMAIN_STORAGE_CORRUPT",
                                500,
                                "Stored source references are invalid",
                            )
                        for item in nested:
                            normalized_refs.extend(_source_ref_payloads([item]))
                    elif key == "sourceMessageIds":
                        if not isinstance(nested, list) or any(
                            not isinstance(item, str) for item in nested
                        ):
                            raise PersistenceError(
                                "CONVERSATION_DOMAIN_STORAGE_CORRUPT",
                                500,
                                "Stored source references are invalid",
                            )
                        source_ids.update(nested)
                    else:
                        collect(nested)
            elif isinstance(value, list):
                for nested in value:
                    collect(nested)

        collect(view)
        normalized_refs.extend(_source_ref_payloads([], sorted(source_ids)))
        deduplicated_refs = _deduplicate_source_refs(normalized_refs)
        if not deduplicated_refs:
            return True
        valid_until = view.get("validUntil")
        if (
            isinstance(valid_until, int)
            and not isinstance(valid_until, bool)
            and valid_until <= time.time_ns() // 1_000_000
        ):
            return False
        conversation_id = view.get("conversationId")
        conversation_kind = view.get("conversationKind")
        persona_id = view.get("personaId")
        if conversation_id is not None and not isinstance(conversation_id, str):
            return False
        if not isinstance(conversation_kind, str) or conversation_kind not in {
            "direct",
            "group",
            "channel",
        }:
            return False
        if conversation_id is None and (conversation_kind != "direct" or persona_id is not None):
            return False
        if persona_id is not None and not isinstance(persona_id, str):
            return False
        try:
            validate_sources(
                principal,
                workspace_id,
                conversation_id,
                conversation_kind,
                persona_id,
                deduplicated_refs,
            )
        except PersistenceError as exc:
            if exc.status in {401, 403, 404, 409, 422}:
                return False
            raise
        return True

    def require_view_sources(
        principal: PersistencePrincipal,
        workspace_id: str,
        view: Mapping[str, object],
    ) -> None:
        if not view_sources_authorized(principal, workspace_id, view):
            raise PersistenceError(
                "CONVERSATION_DOMAIN_SOURCE_UNAVAILABLE",
                409,
                "A source for this derived record is no longer authorized",
            )

    def filter_authorized_views(
        principal: PersistencePrincipal,
        workspace_id: str,
        views: Sequence[WireView],
    ) -> list[WireView]:
        return [view for view in views if view_sources_authorized(principal, workspace_id, view)]

    def maintenance_task_for_job(
        principal: PersistencePrincipal,
        organization_id: str,
        workspace_id: str,
        job: Mapping[str, object],
    ) -> Mapping[str, object] | None:
        """Read and verify the immutable actor-private task metadata, if it exists."""

        work_store = cast(WorkTaskLookup | None, getattr(app.state, "work_store", None))
        if work_store is None:
            raise PersistenceError(
                "WORK_TASK_UNAVAILABLE",
                503,
                "A WorkStore is required to inspect maintenance task state.",
            )
        job_id = job.get("id")
        task_id = maintenance_task_id(workspace_id, principal.actor_id, str(job_id))
        if job.get("taskId") != task_id:
            raise PersistenceError(
                "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                409,
                "Maintenance Task identity does not match the durable job.",
            )
        queued_version = job.get("queuedVersion")
        if queued_version != 1:
            raise PersistenceError(
                "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                409,
                "Maintenance job queued version is invalid.",
            )
        expected_metadata = {
            "source": "conversation-maintenance",
            "maintenanceJobId": job_id,
            "kind": job.get("kind"),
            "workspaceId": workspace_id,
            "actorId": principal.actor_id,
            "idempotencyKey": job.get("idempotencyKey"),
            "jobVersion": queued_version,
        }
        try:
            task = work_store.get_task(
                organization_id,
                workspace_id,
                task_id,
                actor_id=principal.actor_id,
                actor_private_scope=True,
            )
        except PersistenceError as exc:
            if exc.status == 404:
                return None
            raise
        if (
            task.get("id") != task_id
            or task.get("workspaceId") != workspace_id
            or task.get("createdByActorId") != principal.actor_id
            or task.get("metadata") != expected_metadata
        ):
            raise PersistenceError(
                "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                409,
                "Work Task provenance does not match the durable maintenance job.",
            )
        return task

    def verify_maintenance_task(
        principal: PersistencePrincipal,
        organization_id: str,
        workspace_id: str,
        job: Mapping[str, object],
        requested_state: str,
        details: Mapping[str, object],
    ) -> None:
        """Verify a checkpoint against the immutable actor-private Work Task."""

        if (
            not principal.can_write_harness
            or not principal.actor_private_scope
            or principal.organization_id is None
        ):
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "A trusted actor-private organization-scoped harness worker is required.",
            )
        task_id = maintenance_task_id(workspace_id, principal.actor_id, str(job.get("id")))
        task = maintenance_task_for_job(principal, organization_id, workspace_id, job)
        if task is None:
            raise PersistenceError(
                "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                409,
                "Maintenance checkpoint requires its actor-private Work Task.",
            )
        expected_status = {
            "running": "running",
            "completed": "completed",
            "failed": "failed",
            "cancelled": "aborted",
        }[requested_state]
        if task.get("status") != expected_status:
            raise PersistenceError(
                "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                409,
                "Maintenance checkpoint state does not match the Work Task state.",
            )
        if requested_state != "running":
            output = task.get("output")
            receipt_task_id = details.get("taskId")
            receipt_digest = details.get("taskOutputSha256")
            if not isinstance(output, str):
                raise PersistenceError(
                    "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                    409,
                    "Work Task output is unavailable for terminal checkpoint verification.",
                )
            actual_digest = hashlib.sha256(output.encode("utf-8")).hexdigest()
            if receipt_task_id != task_id or receipt_digest != actual_digest:
                raise PersistenceError(
                    "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                    409,
                    "Terminal checkpoint receipt does not match the Work Task output.",
                )

    def verify_skill_receipts(
        principal: PersistencePrincipal,
        organization_id: str,
        workspace_id: str,
        operation_receipt_id: str,
        read_receipt_id: str,
        content: str,
    ) -> None:
        """Require two immutable verified operation receipts and completed task outputs."""

        work_store = cast(WorkTaskLookup | None, getattr(app.state, "work_store", None))
        if work_store is None:
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_UNAVAILABLE",
                503,
                "A WorkStore is required to verify skill receipts.",
            )
        receipts: list[Mapping[str, object]] = []
        for receipt_id, expected_type in (
            (operation_receipt_id, "conversation.skill.verify"),
            (read_receipt_id, "conversation.skill.readback"),
        ):
            try:
                operation = work_store.get_operation(
                    organization_id,
                    workspace_id,
                    receipt_id,
                    actor_id=principal.actor_id,
                    actor_private_scope=True,
                )
            except PersistenceError as exc:
                if exc.status == 404:
                    raise PersistenceError(
                        "WORK_OPERATION_VERIFICATION_REQUIRED",
                        409,
                        "Skill verification operation receipt is unavailable.",
                    ) from exc
                raise
            task_id = operation.get("taskId")
            evidence = operation.get("evidence")
            if (
                operation.get("id") != receipt_id
                or operation.get("operationType") != expected_type
                or operation.get("status") != "verified"
                or not isinstance(task_id, str)
                or not isinstance(evidence, Mapping)
            ):
                raise PersistenceError(
                    "WORK_OPERATION_VERIFICATION_REQUIRED",
                    409,
                    "Skill verification operation receipt has invalid provenance.",
                )
            try:
                task = work_store.get_task(
                    organization_id,
                    workspace_id,
                    task_id,
                    actor_id=principal.actor_id,
                    actor_private_scope=True,
                )
            except PersistenceError as exc:
                if exc.status == 404:
                    raise PersistenceError(
                        "WORK_OPERATION_VERIFICATION_REQUIRED",
                        409,
                        "Skill verification requires an actor-private completed Task.",
                    ) from exc
                raise
            output = task.get("output")
            task_digest = evidence.get("taskOutputSha256")
            if (
                task.get("createdByActorId") != principal.actor_id
                or task.get("status") != "completed"
                or not isinstance(output, str)
                or task_digest != hashlib.sha256(output.encode()).hexdigest()
            ):
                raise PersistenceError(
                    "WORK_OPERATION_VERIFICATION_REQUIRED",
                    409,
                    "Skill verification receipt does not match a completed Task output.",
                )
            receipts.append(evidence)
        verify_evidence, read_evidence = receipts
        content_digest = hashlib.sha256(content.encode()).hexdigest()
        if (
            verify_evidence.get("readbackReceiptId") != read_receipt_id
            or read_evidence.get("contentSha256") != content_digest
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Skill verification and independent readback receipts do not match.",
            )

    def require_graph_provider() -> GraphProvider:
        """Resolve a configured provider without fabricating graph results."""

        provider = cast(GraphProvider | None, getattr(app.state, "graph_provider", None))
        if provider is None:
            raise PersistenceError(
                "GRAPH_PROVIDER_UNAVAILABLE",
                503,
                "Graph provider is unavailable.",
                retryable=True,
            )
        return provider

    def has_idempotency_record(
        organization_id: str,
        workspace_id: str,
        actor_id: str,
        table: str,
        column: str,
        value: str,
    ) -> bool:
        if (table, column) not in {
            ("profile_candidates", "idempotency_key"),
            ("graph_changesets", "idempotency_key"),
            ("maintenance_jobs", "idempotency_key"),
            ("research_notes", "idempotency_key"),
            ("verified_skills", "idempotency_key"),
            ("watches", "idempotency_key"),
            ("focus_items", "idempotency_key"),
            ("handoffs", "idempotency_key"),
            ("review_events", "idempotency_key"),
            ("import_batches", "batch_id"),
        }:
            raise RuntimeError("unsupported domain idempotency table")
        try:
            with sqlite3.connect(domain_store.db_path, timeout=10) as connection:
                row = connection.execute(
                    f"SELECT 1 FROM {table} WHERE org=? AND workspace=? AND actor=? "
                    f"AND {column}=? LIMIT 1",
                    (organization_id, workspace_id, actor_id, value),
                ).fetchone()
        except sqlite3.Error as exc:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_STORAGE_ERROR",
                503,
                "Domain storage read failed",
                retryable=True,
            ) from exc
        return row is not None

    def domain_body(body: BaseModel, *exclude: str) -> dict[str, object]:
        return body.model_dump(by_alias=True, exclude=set(exclude))

    @app.get(base + "/personas", response_model=PersonasView)
    def list_personas(
        workspace_id: str,
        request: Request,
        conversation_id: str | None = Query(default=None, alias="conversationId", max_length=200),
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        items = domain_store.list_personas(
            organization_id, workspace_id, principal.actor_id, conversation_id
        )
        return {"items": items}

    @app.put(base + "/personas", response_model=PersonaReceipt)
    def put_persona(
        workspace_id: str,
        body: PersonaPut,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        persona = domain_store.put_persona(
            organization_id,
            workspace_id,
            principal.actor_id,
            domain_body(body),
        )
        return {"persona": persona}

    @app.post(
        base + "/profile-candidates",
        response_model=ProfileCandidateReceipt,
        status_code=201,
    )
    def create_profile_candidate(
        workspace_id: str,
        body: ProfileCandidateCreate,
        request: Request,
        response: Response,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        validate_sources(
            principal,
            workspace_id,
            body.conversation_id,
            body.conversation_kind,
            body.persona_id,
            body.source_refs,
            body.source_message_ids,
        )
        duplicate = has_idempotency_record(
            organization_id,
            workspace_id,
            principal.actor_id,
            "profile_candidates",
            "idempotency_key",
            body.idempotency_key,
        )
        candidate = domain_store.create_profile_candidate(
            organization_id,
            workspace_id,
            principal.actor_id,
            domain_body(body),
        )
        if duplicate:
            response.status_code = 200
        return {"candidate": candidate}

    @app.get(base + "/profile-candidates", response_model=ProfileCandidatesView)
    def list_profile_candidates(
        workspace_id: str,
        request: Request,
        state: Literal["candidate", "active", "rolled_back", "expired"] | None = None,
        limit: int = Query(default=100, ge=1, le=500),
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        items = domain_store.list_profile_candidates(
            organization_id,
            workspace_id,
            principal.actor_id,
            state,
            limit,
        )
        return {"items": filter_authorized_views(principal, workspace_id, items)}

    @app.post(base + "/profile-candidates/{candidate_id}/activate", response_model=ProfileReceipt)
    def activate_profile_candidate(
        workspace_id: str,
        candidate_id: str,
        body: ExpectedVersion,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        candidate = domain_store.get_profile_candidate(
            organization_id, workspace_id, principal.actor_id, candidate_id
        )
        require_view_sources(principal, workspace_id, candidate)
        profile = domain_store.activate_profile_candidate(
            organization_id,
            workspace_id,
            principal.actor_id,
            candidate_id,
            body.expected_version,
        )
        return {"profile": profile}

    @app.post(base + "/profiles/{profile_id}/rollback", response_model=ProfileReceipt)
    def rollback_profile(
        workspace_id: str,
        profile_id: str,
        body: ExpectedVersion,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        current = domain_store.get_profile(
            organization_id, workspace_id, principal.actor_id, profile_id
        )
        require_view_sources(principal, workspace_id, current)
        previous_id = current.get("previousProfileId")
        if isinstance(previous_id, str):
            previous = domain_store.get_profile(
                organization_id, workspace_id, principal.actor_id, previous_id
            )
            require_view_sources(principal, workspace_id, previous)
        profile = domain_store.rollback_profile(
            organization_id,
            workspace_id,
            principal.actor_id,
            profile_id,
            body.expected_version,
        )
        return {"profile": profile}

    @app.get(base + "/profiles", response_model=ProfilesView)
    def list_profiles(
        workspace_id: str,
        request: Request,
        conversation_id: str | None = Query(default=None, alias="conversationId", max_length=200),
        state: Literal["active", "superseded", "rolled_back"] = "active",
        limit: int = Query(default=100, ge=1, le=500),
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        items = domain_store.list_profiles(
            organization_id,
            workspace_id,
            principal.actor_id,
            conversation_id,
            state,
            limit,
        )
        return {"items": filter_authorized_views(principal, workspace_id, items)}

    @app.post(
        base + "/graph/proposals",
        response_model=GraphProposalReceipt,
        status_code=201,
    )
    def create_graph_proposal(
        workspace_id: str,
        body: GraphProposalCreate,
        request: Request,
        response: Response,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        for node in body.nodes:
            validate_sources(
                principal,
                workspace_id,
                body.conversation_id,
                body.conversation_kind,
                body.persona_id,
                node.source_refs,
                node.source_message_ids,
            )
        for edge in body.edges:
            validate_sources(
                principal,
                workspace_id,
                body.conversation_id,
                body.conversation_kind,
                body.persona_id,
                edge.source_refs,
                edge.source_message_ids,
            )
        duplicate = has_idempotency_record(
            organization_id,
            workspace_id,
            principal.actor_id,
            "graph_changesets",
            "idempotency_key",
            body.idempotency_key,
        )
        changeset = domain_store.upsert_graph_entities(
            organization_id,
            workspace_id,
            principal.actor_id,
            domain_body(body),
        )
        if duplicate:
            response.status_code = 200
        return {"changeset": changeset}

    @app.get(base + "/graph/changesets", response_model=GraphChangesetsView)
    def list_graph_changesets(
        workspace_id: str,
        request: Request,
        state: Literal["proposed", "projected"] | None = None,
        limit: int = Query(default=100, ge=1, le=500),
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        items = domain_store.list_graph_changesets(
            organization_id,
            workspace_id,
            principal.actor_id,
            state,
            limit,
        )
        return {"items": filter_authorized_views(principal, workspace_id, items)}

    @app.post(base + "/graph/changesets/{changeset_id}/apply", response_model=GraphProposalReceipt)
    def apply_graph_changeset(
        workspace_id: str,
        changeset_id: str,
        body: ExpectedVersion,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        current = domain_store.get_graph_changeset(
            organization_id, workspace_id, principal.actor_id, changeset_id
        )
        require_view_sources(principal, workspace_id, current)
        if (
            current.get("state") == "projected"
            and current.get("version") == body.expected_version + 1
        ):
            return {"changeset": current}
        if current.get("state") != "proposed" or current.get("version") != body.expected_version:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_CONFLICT",
                409,
                "Graph changeset state or version changed.",
            )
        provider = require_graph_provider()
        provider_result = provider.apply_changeset(
            organization_id=organization_id,
            workspace_id=workspace_id,
            actor_id=principal.actor_id,
            changeset=current,
        )
        if set(provider_result) != {"readbackDigest", "nodeCount", "edgeCount"}:
            raise PersistenceError(
                "GRAPH_PROVIDER_READBACK_INVALID",
                502,
                "Graph provider returned an invalid readback receipt.",
            )
        readback_digest = provider_result.get("readbackDigest")
        node_count = provider_result.get("nodeCount")
        edge_count = provider_result.get("edgeCount")
        nodes = current.get("nodes")
        edges = current.get("edges")
        if not isinstance(nodes, list) or not isinstance(edges, list):
            raise PersistenceError(
                "CONVERSATION_DOMAIN_STORAGE_CORRUPT",
                500,
                "Stored graph changeset nodes and edges are invalid.",
            )
        if (
            not isinstance(readback_digest, str)
            or re.fullmatch(r"[a-f0-9]{64}", readback_digest) is None
            or readback_digest != current.get("digest")
            or isinstance(node_count, bool)
            or not isinstance(node_count, int)
            or node_count != len(nodes)
            or isinstance(edge_count, bool)
            or not isinstance(edge_count, int)
            or edge_count != len(edges)
        ):
            raise PersistenceError(
                "GRAPH_PROVIDER_READBACK_MISMATCH",
                502,
                "Graph provider readback does not match the proposed node and edge counts.",
            )
        provider_receipt = {
            "requestDigest": current["digest"],
            "readbackDigest": readback_digest,
            "nodeCount": node_count,
            "edgeCount": edge_count,
            "appliedAt": time.time_ns() // 1_000_000,
        }
        changeset = domain_store.apply_graph_changeset(
            organization_id,
            workspace_id,
            principal.actor_id,
            changeset_id,
            body.expected_version,
            provider_receipt,
        )
        return {"changeset": changeset}

    @app.post(base + "/graph/query", response_model=GraphQueryView)
    def query_graph(
        workspace_id: str,
        body: GraphQuery,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        provider = require_graph_provider()
        provider_result = provider.query(
            organization_id=organization_id,
            workspace_id=workspace_id,
            actor_id=principal.actor_id,
            conversation_id=body.conversation_id,
            conversation_kind=body.conversation_kind,
            persona_id=body.persona_id,
            query=body.query,
            limit=body.limit,
        )
        raw_items = provider_result.get("items")
        if not isinstance(raw_items, list):
            raise PersistenceError(
                "GRAPH_PROVIDER_RESULT_INVALID",
                502,
                "Graph provider query result must contain an items list.",
            )
        authorized_items: list[dict[str, object]] = []
        for item in raw_items:
            if not isinstance(item, Mapping):
                raise PersistenceError(
                    "GRAPH_PROVIDER_RESULT_INVALID",
                    502,
                    "Graph provider query items must be objects.",
                )
            sources = item.get("sourceMessageIds")
            if (
                not isinstance(sources, list)
                or not sources
                or any(not isinstance(source_id, str) for source_id in sources)
            ):
                raise PersistenceError(
                    "GRAPH_PROVIDER_RESULT_INVALID",
                    502,
                    "Graph provider query items require sourceMessageIds.",
                )
            auth_view = dict(item)
            auth_view.update(
                {
                    "conversationId": body.conversation_id,
                    "conversationKind": body.conversation_kind,
                    "personaId": body.persona_id,
                }
            )
            if view_sources_authorized(principal, workspace_id, auth_view):
                authorized_items.append(dict(item))
        return {"items": authorized_items}

    @app.post(
        base + "/maintenance/jobs",
        response_model=MaintenanceJobReceipt,
        status_code=201,
    )
    def create_maintenance_job(
        workspace_id: str,
        body: MaintenanceJobCreate,
        request: Request,
        response: Response,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        duplicate = has_idempotency_record(
            organization_id,
            workspace_id,
            principal.actor_id,
            "maintenance_jobs",
            "idempotency_key",
            body.idempotency_key,
        )
        job = domain_store.create_maintenance_job(
            organization_id,
            workspace_id,
            principal.actor_id,
            domain_body(body),
        )
        if duplicate:
            response.status_code = 200
        return {"job": job, "duplicate": duplicate}

    @app.get(base + "/maintenance/jobs", response_model=MaintenanceJobsView)
    def list_maintenance_jobs(
        workspace_id: str,
        request: Request,
        state: MaintenanceState | None = None,
        limit: int = Query(default=100, ge=1, le=500),
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        query = "SELECT job_id FROM maintenance_jobs WHERE org=? AND workspace=? AND actor=?"
        params: tuple[object, ...] = (organization_id, workspace_id, principal.actor_id)
        if state is not None:
            query += " AND state=?"
            params += (state,)
        query += " ORDER BY created_at DESC, job_id LIMIT ?"
        params += (limit,)
        try:
            with sqlite3.connect(domain_store.db_path, timeout=10) as connection:
                rows = connection.execute(query, params).fetchall()
        except sqlite3.Error as exc:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_STORAGE_ERROR",
                503,
                "Domain storage read failed",
                retryable=True,
            ) from exc
        items = [
            domain_store.get_maintenance_job(
                organization_id, workspace_id, principal.actor_id, str(row[0])
            )
            for row in rows
        ]
        return {"items": filter_authorized_views(principal, workspace_id, items)}

    @app.get(base + "/maintenance/jobs/{job_id}", response_model=MaintenanceJobView)
    def get_maintenance_job(
        workspace_id: str,
        job_id: str,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        job = domain_store.get_maintenance_job(
            organization_id, workspace_id, principal.actor_id, job_id
        )
        require_view_sources(principal, workspace_id, job)
        return job

    @app.patch(
        base + "/maintenance/jobs/{job_id}/checkpoint",
        response_model=MaintenanceJobUpdateReceipt,
    )
    def checkpoint_maintenance_job(
        workspace_id: str,
        job_id: str,
        body: MaintenanceCheckpointRequest,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        if (
            not principal.can_write_harness
            or not principal.actor_private_scope
            or principal.organization_id is None
        ):
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "A trusted actor-private organization-scoped harness worker is required "
                "for checkpoints.",
            )
        current = domain_store.get_maintenance_job(
            organization_id, workspace_id, principal.actor_id, job_id
        )
        require_view_sources(principal, workspace_id, current)
        if current.get("state") == "cancelled":
            raise PersistenceError(
                "CONVERSATION_DOMAIN_CONFLICT",
                409,
                "Cancelled maintenance jobs cannot accept worker checkpoints.",
            )
        checkpoint = body.checkpoint.model_dump(by_alias=True)
        details = checkpoint.get("details")
        if not isinstance(details, Mapping):
            raise PersistenceError(
                "CONVERSATION_DOMAIN_INVALID", 422, "checkpoint.details must be an object."
            )
        requested_state = details.get("state", "running")
        if not isinstance(requested_state, str):
            raise PersistenceError(
                "CONVERSATION_DOMAIN_INVALID", 422, "checkpoint.details.state is invalid."
            )
        verify_maintenance_task(
            principal,
            organization_id,
            workspace_id,
            current,
            requested_state,
            details,
        )
        job = domain_store.checkpoint_maintenance_job(
            organization_id,
            workspace_id,
            principal.actor_id,
            job_id,
            body.expected_version,
            checkpoint,
            terminal_receipt_validated=requested_state != "running",
        )
        return {"job": job}

    @app.post(
        base + "/maintenance/jobs/{job_id}/cancel",
        response_model=MaintenanceJobCancelReceipt,
    )
    def cancel_maintenance_job(
        workspace_id: str,
        job_id: str,
        body: ExpectedVersion,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        current = domain_store.get_maintenance_job(
            organization_id, workspace_id, principal.actor_id, job_id
        )
        require_view_sources(principal, workspace_id, current)
        if current.get("state") == "cancelled":
            job = domain_store.cancel_maintenance_job(
                organization_id,
                workspace_id,
                principal.actor_id,
                job_id,
                body.expected_version,
            )
            return {"job": job}
        task = None
        if current.get("state") in {"queued", "running"}:
            task = maintenance_task_for_job(principal, organization_id, workspace_id, current)
            if current.get("state") == "running" and task is None:
                raise PersistenceError(
                    "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                    409,
                    "Running maintenance cancellation requires its actor-private Work Task.",
                )
            if task is not None and task.get("status") != "aborted":
                raise PersistenceError(
                    "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                    409,
                    "Cancel the maintenance Work Task before cancelling its durable job.",
                )
        job = domain_store.cancel_maintenance_job(
            organization_id,
            workspace_id,
            principal.actor_id,
            job_id,
            body.expected_version,
            task_cancellation_verified=task is not None,
        )
        return {"job": job}

    @app.post(
        base + "/research/notes",
        response_model=ResearchNoteReceipt,
        status_code=201,
    )
    def create_research_note(
        workspace_id: str,
        body: ResearchNoteCreate,
        request: Request,
        response: Response,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        validate_sources(
            principal,
            workspace_id,
            body.conversation_id,
            body.conversation_kind,
            body.persona_id,
            body.source_refs,
        )
        duplicate = has_idempotency_record(
            organization_id,
            workspace_id,
            principal.actor_id,
            "research_notes",
            "idempotency_key",
            body.idempotency_key,
        )
        note = domain_store.create_research_note(
            organization_id,
            workspace_id,
            principal.actor_id,
            domain_body(body),
        )
        if duplicate:
            response.status_code = 200
        return {"note": note, "duplicate": duplicate}

    @app.get(base + "/research/notes", response_model=ResearchNotesView)
    def list_research_notes(
        workspace_id: str,
        request: Request,
        conversation_id: str | None = Query(default=None, alias="conversationId", max_length=200),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        items = domain_store.list_research_notes(
            organization_id,
            workspace_id,
            principal.actor_id,
            conversation_id,
            limit,
        )
        return {"items": filter_authorized_views(principal, workspace_id, items)}

    @app.post(
        base + "/research/skills",
        response_model=VerifiedSkillReceipt,
        status_code=201,
    )
    def create_verified_skill(
        workspace_id: str,
        body: VerifiedSkillCreate,
        request: Request,
        response: Response,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        validate_sources(
            principal,
            workspace_id,
            body.conversation_id,
            body.conversation_kind or "direct",
            body.persona_id,
            body.source_refs,
        )
        verify_skill_receipts(
            principal,
            organization_id,
            workspace_id,
            body.operation_receipt_id,
            body.independent_read_receipt_id,
            body.content,
        )
        duplicate = has_idempotency_record(
            organization_id,
            workspace_id,
            principal.actor_id,
            "verified_skills",
            "idempotency_key",
            body.idempotency_key,
        )
        skill = domain_store.create_verified_skill(
            organization_id,
            workspace_id,
            principal.actor_id,
            domain_body(body),
        )
        if duplicate:
            response.status_code = 200
        return {"skill": skill, "duplicate": duplicate}

    @app.get(base + "/research/skills", response_model=VerifiedSkillsView)
    def list_verified_skills(
        workspace_id: str,
        request: Request,
        limit: int = Query(default=100, ge=1, le=500),
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        items = domain_store.list_verified_skills(
            organization_id, workspace_id, principal.actor_id, limit
        )
        return {"items": filter_authorized_views(principal, workspace_id, items)}

    @app.post(base + "/watches", response_model=WatchReceipt, status_code=201)
    def create_watch(
        workspace_id: str,
        body: WatchCreate,
        request: Request,
        response: Response,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        validate_sources(
            principal,
            workspace_id,
            body.conversation_id,
            body.conversation_kind,
            body.persona_id,
            body.source_refs,
        )
        duplicate = has_idempotency_record(
            organization_id,
            workspace_id,
            principal.actor_id,
            "watches",
            "idempotency_key",
            body.idempotency_key,
        )
        watch = domain_store.create_watch(
            organization_id,
            workspace_id,
            principal.actor_id,
            domain_body(body),
        )
        if duplicate:
            response.status_code = 200
        return {"watch": watch, "duplicate": duplicate}

    @app.get(base + "/watches", response_model=WatchesView)
    def list_watches(
        workspace_id: str,
        request: Request,
        state: Literal["active", "cancelled"] | None = None,
        limit: int = Query(default=100, ge=1, le=500),
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        items = domain_store.list_watches(
            organization_id,
            workspace_id,
            principal.actor_id,
            state,
            limit=limit,
        )
        return {"items": filter_authorized_views(principal, workspace_id, items)}

    @app.post(base + "/watches/{watch_id}/cancel", response_model=WatchUpdateReceipt)
    def cancel_watch(
        workspace_id: str,
        watch_id: str,
        body: ExpectedVersion,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        current = domain_store.get_watch(
            organization_id, workspace_id, principal.actor_id, watch_id
        )
        require_view_sources(principal, workspace_id, current)
        return {
            "watch": domain_store.cancel_watch(
                organization_id,
                workspace_id,
                principal.actor_id,
                watch_id,
                body.expected_version,
            )
        }

    @app.put(base + "/watches/{watch_id}/schedule", response_model=WatchUpdateReceipt)
    def schedule_watch(
        workspace_id: str,
        watch_id: str,
        body: WatchSchedule,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        current = domain_store.get_watch(
            organization_id, workspace_id, principal.actor_id, watch_id
        )
        require_view_sources(principal, workspace_id, current)
        watch = domain_store.schedule_watch(
            organization_id,
            workspace_id,
            principal.actor_id,
            watch_id,
            body.expected_version,
            body.next_check_at,
        )
        return {"watch": watch}

    @app.post(base + "/focus-items", response_model=FocusItemReceipt, status_code=201)
    def create_focus_item(
        workspace_id: str,
        body: FocusItemCreate,
        request: Request,
        response: Response,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        validate_sources(
            principal,
            workspace_id,
            body.conversation_id,
            body.conversation_kind,
            body.persona_id,
            body.source_refs,
        )
        duplicate = has_idempotency_record(
            organization_id,
            workspace_id,
            principal.actor_id,
            "focus_items",
            "idempotency_key",
            body.idempotency_key,
        )
        item = domain_store.create_focus_item(
            organization_id,
            workspace_id,
            principal.actor_id,
            domain_body(body),
        )
        if duplicate:
            response.status_code = 200
        return {"item": item, "duplicate": duplicate}

    @app.get(base + "/focus-items", response_model=FocusItemsView)
    def list_focus_items(
        workspace_id: str,
        request: Request,
        conversation_id: str | None = Query(default=None, alias="conversationId", max_length=200),
        state: FocusState | None = None,
        limit: int = Query(default=100, ge=1, le=500),
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        items = domain_store.list_focus_items(
            organization_id,
            workspace_id,
            principal.actor_id,
            state,
            conversation_id,
            limit,
        )
        return {"items": filter_authorized_views(principal, workspace_id, items)}

    @app.post(
        base + "/focus-items/{focus_item_id}/transition",
        response_model=FocusItemTransitionReceipt,
    )
    def transition_focus_item(
        workspace_id: str,
        focus_item_id: str,
        body: FocusTransition,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        current = domain_store.get_focus_item(
            organization_id, workspace_id, principal.actor_id, focus_item_id
        )
        require_view_sources(principal, workspace_id, current)
        return {
            "item": domain_store.transition_focus_item(
                organization_id,
                workspace_id,
                principal.actor_id,
                focus_item_id,
                body.model_dump(by_alias=True),
            )
        }

    @app.post(base + "/handoffs", response_model=HandoffReceipt, status_code=201)
    def create_handoff(
        workspace_id: str,
        body: HandoffCreate,
        request: Request,
        response: Response,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        validate_sources(
            principal,
            workspace_id,
            body.conversation_id,
            body.conversation_kind or "direct",
            body.persona_id,
            body.source_refs,
        )
        duplicate = has_idempotency_record(
            organization_id,
            workspace_id,
            principal.actor_id,
            "handoffs",
            "idempotency_key",
            body.idempotency_key,
        )
        handoff = domain_store.create_handoff(
            organization_id,
            workspace_id,
            principal.actor_id,
            domain_body(body),
        )
        if duplicate:
            response.status_code = 200
        return {"handoff": handoff, "duplicate": duplicate}

    @app.get(base + "/handoffs/{handoff_id}", response_model=HandoffView)
    def read_handoff(
        workspace_id: str,
        handoff_id: str,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        handoff = domain_store.read_handoff(
            organization_id, workspace_id, principal.actor_id, handoff_id
        )
        if not view_sources_authorized(principal, workspace_id, handoff):
            raise PersistenceError("CONVERSATION_DOMAIN_NOT_FOUND", 404, "Handoff was not found")
        return handoff

    @app.get(
        base + "/policies/active-behavior",
        response_model=ActiveBehaviorPolicyReceipt,
        response_model_exclude_none=True,
    )
    def get_active_behavior_policy(
        workspace_id: str,
        request: Request,
        conversation_id: str = Query(alias="conversationId", min_length=1, max_length=200),
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        policy = domain_store.get_active_behavior_policy(
            organization_id, workspace_id, principal.actor_id, conversation_id
        )
        if policy is None:
            policy = {
                "conversationId": conversation_id,
                "enabled": False,
                "quietHours": {"timeZone": "UTC", "start": "22:00", "end": "08:00"},
                "cooldownSeconds": 900,
                "allowGroupInterjections": False,
                "followupEnabled": False,
                "version": 0,
            }
        return {"policy": policy}

    @app.put(base + "/policies/active-behavior", response_model=ActiveBehaviorPolicyReceipt)
    def put_active_behavior_policy(
        workspace_id: str,
        body: ActiveBehaviorPolicyPut,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        policy = domain_store.put_active_behavior_policy(
            organization_id,
            workspace_id,
            principal.actor_id,
            body.model_dump(by_alias=True),
        )
        return {"policy": policy}

    @app.post(base + "/review-events", response_model=ReviewEventReceipt, status_code=201)
    def append_review_event(
        workspace_id: str,
        body: ReviewEventCreate,
        request: Request,
        response: Response,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        conversation_kind = body.conversation_kind or "direct"
        validate_sources(
            principal,
            workspace_id,
            body.conversation_id,
            conversation_kind,
            body.persona_id,
            body.source_refs,
        )
        duplicate = has_idempotency_record(
            organization_id,
            workspace_id,
            principal.actor_id,
            "review_events",
            "idempotency_key",
            body.idempotency_key,
        )
        event = domain_store.append_review_event(
            organization_id,
            workspace_id,
            principal.actor_id,
            domain_body(body),
        )
        if duplicate:
            response.status_code = 200
        return {"event": event, "duplicate": duplicate}

    @app.get(base + "/review-events", response_model=ReviewEventsView)
    def list_review_events(
        workspace_id: str,
        request: Request,
        limit: int = Query(default=100, ge=1, le=500),
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        items = domain_store.list_review_events(
            organization_id, workspace_id, principal.actor_id, limit=limit
        )
        return {"items": filter_authorized_views(principal, workspace_id, items)}

    @app.post(base + "/imports/preview", response_model=ImportPreviewView)
    def preview_import_batch(
        workspace_id: str,
        body: ImportBatchCreate,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        for record in body.records:
            validate_sources(
                principal,
                workspace_id,
                record.conversation_id,
                record.conversation_kind or "direct",
                record.persona_id,
                record.source_refs,
            )
        return domain_store.preview_import_batch(
            organization_id,
            workspace_id,
            principal.actor_id,
            _import_body(body),
        )

    @app.post(base + "/imports", response_model=ImportApplyReceipt, status_code=201)
    def apply_import_batch(
        workspace_id: str,
        body: ImportBatchCreate,
        request: Request,
        response: Response,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        for record in body.records:
            validate_sources(
                principal,
                workspace_id,
                record.conversation_id,
                record.conversation_kind or "direct",
                record.persona_id,
                record.source_refs,
            )
        duplicate = has_idempotency_record(
            organization_id,
            workspace_id,
            principal.actor_id,
            "import_batches",
            "batch_id",
            body.batch_id,
        )
        imported = domain_store.apply_import_batch(
            organization_id,
            workspace_id,
            principal.actor_id,
            _import_body(body),
        )
        if duplicate:
            response.status_code = 200
        return {
            "batchId": imported["batchId"],
            "importedCount": imported["acceptedCount"],
            "quarantinedCount": imported["quarantinedCount"],
            "digest": imported["digest"],
        }

    @app.post(base + "/imports/{batch_id}/rollback", response_model=ImportRollbackReceipt)
    def rollback_import_batch(
        workspace_id: str,
        batch_id: str,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        rolled_back = domain_store.rollback_import_batch(
            organization_id, workspace_id, principal.actor_id, batch_id
        )
        return {
            "batchId": rolled_back["batchId"],
            "rolledBack": rolled_back["state"] == "rolledBack",
            "quarantinedCount": rolled_back["quarantinedCount"],
        }


def _import_body(body: ImportBatchCreate) -> dict[str, object]:
    return {
        "batchId": body.batch_id,
        "sourceKind": body.source_kind,
        "records": [record.model_dump(by_alias=True) for record in body.records],
    }
