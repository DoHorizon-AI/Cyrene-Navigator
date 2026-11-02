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
import json
import os
import re
import sqlite3
import stat
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Literal, Protocol, cast
from urllib.parse import urlsplit

from fastapi import FastAPI, Query, Request, Response
from pydantic import BaseModel, ValidationError

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
    PersonaBindingPut,
    PersonaBindingReadReceipt,
    PersonaBindingReceipt,
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
    ResearchSourceEvidence,
    ReviewEventCreate,
    ReviewEventReceipt,
    ReviewEventsView,
    VerifiedSkillCreate,
    VerifiedSkillReceipt,
    VerifiedSkillsView,
    WatchCreate,
    WatchesView,
    WatchObservation,
    WatchReceipt,
    WatchSchedule,
    WatchUpdateReceipt,
)
from cyrene_navigator.work.conversation_memory.domains import (
    ConversationDomainStore,
    WireView,
    conversation_watch_task_id,
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

    def get_attachment(
        self,
        organization_id: str | None,
        workspace_id: str,
        digest: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
        require_actor_private: bool = False,
    ) -> tuple[Mapping[str, object], Path]: ...


class TrustedTurnContextResolver(Protocol):
    """Host resolver for the real parent Task/session of an authenticated turn."""

    def __call__(
        self,
        request: Request,
        workspace_id: str,
        principal: PersistencePrincipal,
    ) -> Mapping[str, str]: ...


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


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _canonical_sha256(value: object) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _source_evidence_payloads(value: object) -> list[Mapping[str, object]]:
    if not isinstance(value, list) or len(value) > 64:
        raise PersistenceError(
            "CONVERSATION_DOMAIN_INVALID", 422, "sourceEvidence exceeds its supported limit."
        )
    result: list[Mapping[str, object]] = []
    seen: set[str] = set()
    for item in value:
        try:
            evidence = ResearchSourceEvidence.model_validate(item)
        except ValidationError as exc:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_INVALID", 422, "sourceEvidence entry is invalid."
            ) from exc
        if evidence.source_ref in seen:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_INVALID", 422, "sourceEvidence sourceRefs must be unique."
            )
        seen.add(evidence.source_ref)
        result.append(evidence.model_dump(by_alias=True, exclude_none=False))
    return result


def mount_domain_routes(
    app: FastAPI,
    base: str,
    principal_for: PrincipalResolver,
    domain_store: ConversationDomainStore,
    validate_source_ids: SourceIdValidator | None = None,
    *,
    validate_source_refs: SourceRefValidator | None = None,
    trusted_turn_context: TrustedTurnContextResolver | None = None,
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

    def resolve_trusted_turn(
        request: Request, workspace_id: str, principal: PersistencePrincipal
    ) -> tuple[str, str]:
        resolver = trusted_turn_context or cast(
            TrustedTurnContextResolver | None,
            getattr(app.state, "trusted_turn_context", None),
        )
        if resolver is None:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_TURN_CONTEXT_UNAVAILABLE",
                503,
                "A trusted Work Task/session resolver is required for durable watches.",
            )
        context = resolver(request, workspace_id, principal)
        task_id = context.get("taskId")
        session_id = context.get("sessionId")
        if not isinstance(task_id, str) or not task_id.strip():
            raise PersistenceError(
                "CONVERSATION_DOMAIN_TURN_CONTEXT_REQUIRED",
                409,
                "A real parent Work Task is required.",
            )
        if not isinstance(session_id, str) or not session_id.strip():
            raise PersistenceError(
                "CONVERSATION_DOMAIN_TURN_CONTEXT_REQUIRED",
                409,
                "A real Work session is required.",
            )
        return task_id, session_id

    def validate_source_evidence_artifacts(
        principal: PersistencePrincipal,
        workspace_id: str,
        conversation_id: str | None,
        conversation_kind: str | None,
        persona_id: str | None,
        source_refs: Sequence[Mapping[str, object]],
        source_evidence: Sequence[Mapping[str, object]],
        *,
        read_contents: bool,
    ) -> None:
        artifacts = [
            item.get("artifactId")
            for item in source_evidence
            if isinstance(item.get("artifactId"), str)
        ]
        if not artifacts:
            return
        if conversation_id is None or conversation_kind not in {"direct", "group", "channel"}:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_SOURCE_UNAVAILABLE",
                409,
                "Document evidence requires an exact conversation scope.",
            )
        organization_id = principal.organization_id
        memory_store = getattr(app.state, "work_conversation_memory", None)
        work_store = cast(WorkTaskLookup | None, getattr(app.state, "work_store", None))
        if organization_id is None or memory_store is None or work_store is None:
            raise PersistenceError(
                "CONVERSATION_RESEARCH_ARTIFACT_AUTHORIZATION_UNAVAILABLE",
                503,
                "P2 memory authorization and actor-private Work attachments are required.",
            )
        overview = memory_store.overview(organization_id, workspace_id, principal.actor_id)
        epoch = overview.get("authorizationEpoch")
        if not isinstance(epoch, int) or isinstance(epoch, bool):
            raise PersistenceError(
                "CONVERSATION_RESEARCH_ARTIFACT_AUTHORIZATION_UNAVAILABLE",
                503,
                "Current P2 authorization epoch is unavailable.",
            )
        for evidence in source_evidence:
            artifact_id = evidence.get("artifactId")
            if artifact_id is None:
                continue
            if not isinstance(artifact_id, str):
                raise PersistenceError(
                    "CONVERSATION_DOMAIN_INVALID", 422, "sourceEvidence artifactId is invalid."
                )
            authorization = memory_store.authorize_artifact(
                organization_id,
                workspace_id,
                principal.actor_id,
                artifact_id,
                conversation_id,
                conversation_kind,
                persona_id,
                epoch,
                source_refs,
            )
            artifact_metadata = authorization.get("artifact")
            if authorization.get("allowed") is not True or not isinstance(
                artifact_metadata, Mapping
            ):
                raise PersistenceError(
                    "CONVERSATION_DOMAIN_SOURCE_UNAVAILABLE",
                    409,
                    "A document artifact is no longer authorized by its source messages.",
                )
            attachment, path = work_store.get_attachment(
                organization_id,
                workspace_id,
                artifact_id,
                actor_id=principal.actor_id,
                actor_private_scope=True,
                require_actor_private=True,
            )
            if (
                attachment.get("id") != artifact_id
                or attachment.get("sha256") != evidence.get("sourceSha256")
                or attachment.get("size") != artifact_metadata.get("size")
                or attachment.get("mediaType") != artifact_metadata.get("mimeType")
                or artifact_metadata.get("artifactId") != artifact_id
            ):
                raise PersistenceError(
                    "CONVERSATION_DOMAIN_SOURCE_UNAVAILABLE",
                    409,
                    "Document metadata does not match the currently authorized Work attachment.",
                )
            if read_contents:
                try:
                    descriptor = os.open(
                        path,
                        os.O_RDONLY
                        | getattr(os, "O_BINARY", 0)
                        | getattr(os, "O_NOFOLLOW", 0),
                    )
                    with os.fdopen(descriptor, "rb") as stream:
                        info = os.fstat(stream.fileno())
                        if not stat.S_ISREG(info.st_mode) or info.st_size > 10_000_000:
                            raise ValueError("document attachment is not bounded regular content")
                        content = stream.read(10_000_001)
                except (OSError, ValueError) as exc:
                    raise PersistenceError(
                        "CONVERSATION_RESEARCH_ARTIFACT_READBACK_FAILED",
                        409,
                        "Authorized document bytes could not be independently read.",
                    ) from exc
                if (
                    len(content) != info.st_size
                    or hashlib.sha256(content).hexdigest() != evidence.get("sourceSha256")
                ):
                    raise PersistenceError(
                        "CONVERSATION_RESEARCH_ARTIFACT_READBACK_FAILED",
                        409,
                        "Document bytes do not match sourceEvidence sourceSha256.",
                    )

    def verify_research_evidence_receipt(
        principal: PersistencePrincipal,
        organization_id: str,
        workspace_id: str,
        body: ResearchNoteCreate,
    ) -> tuple[list[Mapping[str, object]], list[Mapping[str, object]]]:
        refs = _source_ref_payloads(body.source_refs)
        evidence = _source_evidence_payloads(
            [item.model_dump(by_alias=True, exclude_none=False) for item in body.source_evidence]
        )
        if not evidence:
            if body.research_operation_receipt_id is not None:
                raise PersistenceError(
                    "CONVERSATION_DOMAIN_INVALID",
                    422,
                    "researchOperationReceiptId requires sourceEvidence.",
                )
            return refs, evidence
        receipt_id = body.research_operation_receipt_id
        if receipt_id is None:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_INVALID", 422, "Trusted research evidence receipt is required."
            )
        work_store = cast(WorkTaskLookup | None, getattr(app.state, "work_store", None))
        if work_store is None:
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_UNAVAILABLE",
                503,
                "A WorkStore is required to verify research sourceEvidence.",
            )
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
                    "Research operation receipt is unavailable in this actor scope.",
                ) from exc
            raise
        trusted_producer = operation.get("trustedProducer")
        if trusted_producer is None:
            raise PersistenceError(
                "WORK_OPERATION_PROVENANCE_UNAVAILABLE",
                503,
                "WorkStore has no immutable research runtime producer marker yet.",
            )
        if trusted_producer != "conversation-research-runtime":
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Receipt was not produced by the trusted research runtime.",
            )
        operation_type = operation.get("operationType")
        task_id = operation.get("taskId")
        request_payload = operation.get("request")
        operation_evidence = operation.get("evidence")
        if (
            operation.get("id") != receipt_id
            or operation_type != "conversation.research.read.v1"
            or operation.get("status") != "verified"
            or not isinstance(task_id, str)
            or not isinstance(request_payload, Mapping)
            or not isinstance(operation_evidence, Mapping)
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Research operation receipt has an invalid scope or status.",
            )
        request = cast(Mapping[str, object], request_payload)
        operation_source = request.get("source")
        parent_task_id = request.get("parentTaskId")
        parent_session_id = request.get("parentSessionId")
        request_key = request.get("idempotencyKey")
        request_source_refs = request.get("sourceRefs")
        is_watch_read = operation_source == "conversation-watch"
        expected_request: dict[str, object] = {
            "source": operation_source,
            "workspaceId": workspace_id,
            "actorId": principal.actor_id,
            "conversationId": body.conversation_id,
            "conversationKind": body.conversation_kind,
            "personaId": body.persona_id,
            "idempotencyKey": request_key,
            "parentTaskId": parent_task_id,
            "parentSessionId": parent_session_id,
            "sourceRefs": refs,
        }
        expected_metadata: dict[str, object] = {
            "source": str(operation_source),
            "workspaceId": workspace_id,
            "actorId": principal.actor_id,
            "conversationId": body.conversation_id,
            "conversationKind": body.conversation_kind,
            "personaId": body.persona_id,
            "idempotencyKey": request_key,
            "parentTaskId": parent_task_id,
            "parentSessionId": parent_session_id,
            "sourceRefs": refs,
        }
        watch: Mapping[str, object] | None = None
        if is_watch_read:
            watch_id_value = request.get("watchId")
            watch_version = request.get("watchVersion")
            source_refs_digest = _canonical_sha256(refs)
            condition_sha256 = request.get("conditionSha256")
            if (
                not isinstance(watch_id_value, str)
                or type(watch_version) is not int
                or not isinstance(condition_sha256, str)
                or re.fullmatch(r"[a-f0-9]{64}", condition_sha256) is None
                or request.get("sourceRefsDigest") != source_refs_digest
            ):
                raise PersistenceError(
                    "WORK_OPERATION_VERIFICATION_REQUIRED",
                    409,
                    "Watch research receipt is missing its exact watch source snapshot.",
                )
            watch = domain_store.get_watch(
                organization_id, workspace_id, principal.actor_id, watch_id_value
            )
            if task_id != conversation_watch_task_id(watch_id_value, watch_version):
                raise PersistenceError(
                    "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                    409,
                    "Watch research Task identity does not match its persisted version.",
                )
            if (
                watch.get("conversationId") != body.conversation_id
                or watch.get("conversationKind") != body.conversation_kind
                or watch.get("personaId") != body.persona_id
                or _canonical_json(watch.get("sourceRefs")) != _canonical_json(refs)
                or hashlib.sha256(str(watch.get("condition", "")).encode()).hexdigest()
                != condition_sha256
                or not (
                    watch.get("state") == "active"
                    and (
                        watch.get("version") == watch_version
                        or (
                            watch.get("lastOperationReceiptId") == receipt_id
                            and watch.get("lastResultSha256")
                            == operation_evidence.get("resultSha256")
                        )
                    )
                )
            ):
                raise PersistenceError(
                    "CONVERSATION_DOMAIN_SOURCE_UNAVAILABLE",
                    409,
                    "Research result no longer matches the exact active watch version.",
                )
            expected_request.update(
                {
                    "watchId": watch_id_value,
                    "watchVersion": watch_version,
                    "sourceRefsDigest": source_refs_digest,
                    "conditionSha256": condition_sha256,
                    "taskId": task_id,
                }
            )
            expected_metadata.update(
                {
                    "watchId": watch_id_value,
                    "watchVersion": watch_version,
                    "sourceRefsDigest": source_refs_digest,
                    "conditionSha256": condition_sha256,
                }
            )
        if (
            operation_source not in {"conversation-research-read", "conversation-watch"}
            or request.get("workspaceId") != workspace_id
            or request.get("actorId") != principal.actor_id
            or request.get("conversationId") != body.conversation_id
            or request.get("conversationKind") != body.conversation_kind
            or request.get("personaId") != body.persona_id
            or request_key is None
            or not isinstance(parent_task_id, str)
            or not isinstance(parent_session_id, str)
            or not isinstance(request_source_refs, list)
            or _canonical_json(_source_ref_payloads(request_source_refs)) != _canonical_json(refs)
            or dict(request) != expected_request
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Research receipt request does not match the note source scope.",
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
                    "Research receipt requires its actor-private completed Task.",
                ) from exc
            raise
        task_metadata_raw = task.get("metadata")
        output = task.get("output")
        output_digest = (
            hashlib.sha256(output.encode()).hexdigest() if isinstance(output, str) else None
        )
        projected_output_digest = operation.get("taskOutputSha256")
        source_evidence = _source_evidence_payloads(operation_evidence.get("sourceEvidence"))
        operation_refs = _source_ref_payloads(operation_evidence.get("sourceRefs", []))
        if (
            task.get("id") != task_id
            or task.get("workspaceId") != workspace_id
            or task.get("createdByActorId") != principal.actor_id
            or task.get("sessionId") != parent_session_id
            or task.get("status") != "completed"
            or not isinstance(task_metadata_raw, Mapping)
            or dict(task_metadata_raw) != expected_metadata
            or not isinstance(output, str)
            or projected_output_digest != output_digest
            or _canonical_json(operation_refs) != _canonical_json(refs)
            or _canonical_json(source_evidence) != _canonical_json(evidence)
            or not re.fullmatch(r"[a-f0-9]{64}", str(operation_evidence.get("resultSha256")))
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Research sourceEvidence does not match its trusted completed read receipt.",
            )
        return refs, evidence

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
        raw_evidence = view.get("sourceEvidence", [])
        try:
            normalized_evidence = _source_evidence_payloads(raw_evidence)
            validate_source_evidence_artifacts(
                principal,
                workspace_id,
                conversation_id,
                conversation_kind,
                persona_id,
                deduplicated_refs,
                normalized_evidence,
                read_contents=False,
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
        body: VerifiedSkillCreate,
        parent_task_id: str | None,
        parent_session_id: str | None,
        *,
        require_worker: bool = True,
    ) -> Mapping[str, object]:
        """Require one real action and a distinct independent effect readback."""

        if require_worker and (
            not principal.can_write_harness
            or not principal.actor_private_scope
            or principal.organization_id is None
        ):
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "Verified skills require a trusted actor-private Harness worker.",
            )

        work_store = cast(WorkTaskLookup | None, getattr(app.state, "work_store", None))
        if work_store is None:
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_UNAVAILABLE",
                503,
                "A WorkStore is required to verify skill receipts.",
            )
        conversation_kind = body.conversation_kind or "direct"
        source_refs = _source_ref_payloads(body.source_refs)
        source_refs_digest = _canonical_sha256(source_refs)
        operation_specs = (
            (body.operation_receipt_id, "conversation.skill.verify"),
            (body.independent_read_receipt_id, "conversation.skill.readback"),
        )
        operations: list[Mapping[str, object]] = []
        for receipt_id, expected_type in operation_specs:
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
            trusted_producer = operation.get("trustedProducer")
            if (
                operation.get("id") != receipt_id
                or operation.get("operationType") != expected_type
                or operation.get("status") != "verified"
                or not isinstance(task_id, str)
                or not isinstance(operation.get("evidence"), Mapping)
                or not isinstance(operation.get("request"), Mapping)
            ):
                raise PersistenceError(
                    "WORK_OPERATION_VERIFICATION_REQUIRED",
                    409,
                    "Skill verification operation receipt has invalid provenance.",
                )
            if trusted_producer is None:
                raise PersistenceError(
                    "WORK_OPERATION_PROVENANCE_UNAVAILABLE",
                    503,
                    "WorkStore has no immutable research runtime producer marker yet.",
                )
            if trusted_producer != "conversation-research-runtime":
                raise PersistenceError(
                    "WORK_OPERATION_VERIFICATION_REQUIRED",
                    409,
                    "Skill receipt was not produced by the trusted research runtime.",
                )
            operations.append(operation)
        verify_operation, read_operation = operations
        verify_evidence = cast(Mapping[str, object], verify_operation.get("evidence"))
        read_evidence = cast(Mapping[str, object], read_operation.get("evidence"))
        verify_request = cast(Mapping[str, object], verify_operation.get("request"))
        read_request = cast(Mapping[str, object], read_operation.get("request"))
        action_task_id = verify_operation.get("taskId")
        readback_task_id = read_operation.get("taskId")
        if (
            not isinstance(action_task_id, str)
            or not isinstance(readback_task_id, str)
            or action_task_id == readback_task_id
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Action and readback must use distinct actor-private Tasks.",
            )
        action_effect_id = verify_evidence.get("actionEffectOperationId")
        read_action_effect_id = read_evidence.get("actionEffectOperationId")
        readback_effect_id = read_evidence.get("readbackEffectOperationId")
        action_result_sha = verify_evidence.get("effectResultSha256")
        readback_result_sha = read_evidence.get("effectReadbackSha256")
        if (
            not isinstance(action_effect_id, str)
            or not action_effect_id
            or read_action_effect_id != action_effect_id
            or not isinstance(readback_effect_id, str)
            or not readback_effect_id
            or readback_effect_id == action_effect_id
            or not isinstance(action_result_sha, str)
            or re.fullmatch(r"[a-f0-9]{64}", action_result_sha) is None
            or not isinstance(readback_result_sha, str)
            or re.fullmatch(r"[a-f0-9]{64}", readback_result_sha) is None
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Skill receipts do not bind distinct action and readback effect operations.",
            )
        write_parent_id = parent_task_id or verify_request.get("parentTaskId")
        parent_session = parent_session_id or verify_request.get("parentSessionId")
        if not isinstance(write_parent_id, str) or not isinstance(parent_session, str):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Skill action Task is missing its authenticated parent context.",
            )
        common_request = {
            "source": "conversation-skill-probe",
            "actionId": body.action_id,
            "targetDigestSha256": body.target_digest_sha256,
            "inputSha256": body.input_sha256,
            "guideVersion": body.guide_version,
            "guideSha256": body.guide_sha256,
            "sourceRefsSha256": source_refs_digest,
        }
        expected_verify_request = {
            **common_request,
            "taskId": action_task_id,
            "parentTaskId": write_parent_id,
            "parentSessionId": parent_session,
            "actionEffectOperationId": action_effect_id,
            "effectResultSha256": action_result_sha,
            "readbackOperationId": body.independent_read_receipt_id,
        }
        expected_read_request = {
            **common_request,
            "taskId": readback_task_id,
            "parentTaskId": action_task_id,
            "parentSessionId": parent_session,
            "actionEffectOperationId": action_effect_id,
            "readbackEffectOperationId": readback_effect_id,
            "effectReadbackSha256": readback_result_sha,
        }
        if (
            dict(verify_request) != expected_verify_request
            or dict(read_request) != expected_read_request
            or verify_evidence.get("readbackReceiptId") != body.independent_read_receipt_id
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Skill operation requests do not bind the exact action/readback pair.",
            )
        verify_source_evidence = _source_evidence_payloads(
            verify_evidence.get("sourceEvidence")
        )
        read_source_evidence = _source_evidence_payloads(read_evidence.get("sourceEvidence"))
        if (
            len(verify_source_evidence) != 1
            or verify_source_evidence[0].get("kind") != "web"
            or _canonical_json(verify_source_evidence)
            != _canonical_json(read_source_evidence)
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Action and readback must carry the same single public web source.",
            )
        source_evidence = verify_source_evidence[0]
        expected_source_values = {
            "sourceRef": source_evidence.get("sourceRef"),
            "canonicalUrl": source_evidence.get("url"),
            "sourceSha256": source_evidence.get("sourceSha256"),
        }
        for evidence in (verify_evidence, read_evidence):
            if any(evidence.get(key) != value for key, value in expected_source_values.items()):
                raise PersistenceError(
                    "WORK_OPERATION_VERIFICATION_REQUIRED",
                    409,
                    "Skill sourceEvidence does not match its receipt digests.",
                )
        artifact_sha = verify_evidence.get("workArtifactSha256")
        raw_source_ref = verify_evidence.get("sourceRef")
        canonical_url = verify_evidence.get("canonicalUrl")
        source_sha = verify_evidence.get("sourceSha256")
        if (
            body.action_id != "public-web.lookup"
            or verify_evidence.get("actionId") != body.action_id
            or read_evidence.get("actionId") != body.action_id
            or verify_evidence.get("targetDigestSha256") != body.target_digest_sha256
            or read_evidence.get("targetDigestSha256") != body.target_digest_sha256
            or verify_evidence.get("inputSha256") != body.input_sha256
            or read_evidence.get("inputSha256") != body.input_sha256
            or verify_evidence.get("guideVersion") != body.guide_version
            or read_evidence.get("guideVersion") != body.guide_version
            or verify_evidence.get("guideSha256") != body.guide_sha256
            or read_evidence.get("guideSha256") != body.guide_sha256
            or verify_evidence.get("effectOutcome") != "verified"
            or verify_evidence.get("effectResultSha256") != action_result_sha
            or read_evidence.get("effectReadbackOutcome") != "verified"
            or read_evidence.get("effectReadbackSha256") != readback_result_sha
            or read_evidence.get("readbackVerified") is not True
            or action_result_sha != readback_result_sha
            or action_result_sha != source_sha
            or not isinstance(raw_source_ref, str)
            or re.fullmatch(r"sha256:[a-f0-9]{64}", raw_source_ref) is None
            or not isinstance(canonical_url, str)
            or not isinstance(source_sha, str)
            or re.fullmatch(r"[a-f0-9]{64}", source_sha) is None
            or not isinstance(artifact_sha, str)
            or re.fullmatch(r"[a-f0-9]{64}", artifact_sha) is None
            or read_evidence.get("workArtifactSha256") != artifact_sha
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Skill action and independent effect readback receipts do not match.",
            )
        try:
            parsed_url = urlsplit(canonical_url)
        except ValueError as exc:
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Skill source URL is invalid.",
            ) from exc
        if (
            parsed_url.scheme != "https"
            or not parsed_url.hostname
            or parsed_url.username is not None
            or parsed_url.password is not None
            or parsed_url.netloc != parsed_url.netloc.lower()
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Skill source URL must be canonical HTTPS without userinfo.",
            )

        expected_verify_metadata = {
            "source": "conversation-skill-verify",
            "workspaceId": workspace_id,
            "actorId": principal.actor_id,
            "conversationId": body.conversation_id,
            "conversationKind": conversation_kind,
            "personaId": body.persona_id,
            "parentTaskId": write_parent_id,
            "parentSessionId": parent_session,
            "sourceRefs": source_refs,
            "actionId": body.action_id,
            "targetDigestSha256": body.target_digest_sha256,
            "inputSha256": body.input_sha256,
            "guideVersion": body.guide_version,
            "guideSha256": body.guide_sha256,
        }
        expected_read_metadata = {
            **expected_verify_metadata,
            "source": "conversation-skill-readback",
            "parentTaskId": action_task_id,
            "sourceRef": raw_source_ref,
            "canonicalUrl": canonical_url,
            "sourceSha256": source_sha,
            "workArtifactSha256": artifact_sha,
        }
        for operation, task_id, expected_metadata in (
            (verify_operation, action_task_id, expected_verify_metadata),
            (read_operation, readback_task_id, expected_read_metadata),
        ):
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
            if (
                task.get("id") != task_id
                or task.get("createdByActorId") != principal.actor_id
                or task.get("workspaceId") != workspace_id
                or task.get("sessionId") != parent_session
                or task.get("status") != "completed"
                or task.get("metadata") != expected_metadata
                or not isinstance(output, str)
                or operation.get("taskOutputSha256")
                != hashlib.sha256(output.encode()).hexdigest()
            ):
                raise PersistenceError(
                    "WORK_OPERATION_VERIFICATION_REQUIRED",
                    409,
                    "Skill receipt does not match its exact completed Task.",
                )
        validate_private_work_artifact(principal, workspace_id, artifact_sha)
        return {
            "actionId": body.action_id,
            "targetDigestSha256": body.target_digest_sha256,
            "inputSha256": body.input_sha256,
            "guideVersion": body.guide_version,
            "guideSha256": body.guide_sha256,
            "actionEffectOperationId": action_effect_id,
            "readbackEffectOperationId": readback_effect_id,
            "effectOutcome": "verified",
            "effectResultSha256": action_result_sha,
            "effectReadbackOutcome": "verified",
            "effectReadbackSha256": readback_result_sha,
            "readbackVerified": True,
            "sourceRef": raw_source_ref,
            "canonicalUrl": canonical_url,
            "sourceSha256": source_sha,
            "workArtifactSha256": artifact_sha,
        }
        if (
            body.action_id != "public-web.lookup"
            or verify_evidence.get("actionId") != body.action_id
            or read_evidence.get("actionId") != body.action_id
            or verify_evidence.get("targetDigestSha256") != body.target_digest_sha256
            or read_evidence.get("targetDigestSha256") != body.target_digest_sha256
            or verify_evidence.get("inputSha256") != body.input_sha256
            or read_evidence.get("inputSha256") != body.input_sha256
            or verify_evidence.get("guideVersion") != body.guide_version
            or read_evidence.get("guideVersion") != body.guide_version
            or verify_evidence.get("guideSha256") != body.guide_sha256
            or read_evidence.get("guideSha256") != body.guide_sha256
            or verify_evidence.get("effectOutcome") != "verified"
            or verify_evidence.get("effectOperationId") != effect_operation_id
            or verify_evidence.get("effectResultSha256") != effect_result_sha256
            or verify_evidence.get("effectResultSha256")
            != read_evidence.get("effectReadbackSha256")
            or read_evidence.get("effectReadbackOutcome") != "verified"
            or read_evidence.get("readbackVerified") is not True
            or verify_evidence.get("readbackReceiptId") != body.independent_read_receipt_id
            or not isinstance(verify_evidence.get("sourceRef"), str)
            or verify_evidence.get("sourceRef") != read_evidence.get("sourceRef")
            or verify_evidence.get("canonicalUrl") != read_evidence.get("canonicalUrl")
            or verify_evidence.get("sourceSha256") != read_evidence.get("sourceSha256")
            or verify_evidence.get("workArtifactSha256")
            != read_evidence.get("workArtifactSha256")
            or verify_evidence.get("effectResultSha256")
            != verify_evidence.get("sourceSha256")
            or read_evidence.get("effectReadbackSha256")
            != read_evidence.get("sourceSha256")
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Skill action and independent effect readback receipts do not match.",
            )
        raw_source_ref = verify_evidence.get("sourceRef")
        source_sha = verify_evidence.get("sourceSha256")
        canonical_url = verify_evidence.get("canonicalUrl")
        artifact_sha = verify_evidence.get("workArtifactSha256")
        if (
            not isinstance(raw_source_ref, str)
            or re.fullmatch(r"sha256:[a-f0-9]{64}", raw_source_ref) is None
            or not isinstance(canonical_url, str)
            or not isinstance(source_sha, str)
            or re.fullmatch(r"[a-f0-9]{64}", source_sha) is None
            or not isinstance(artifact_sha, str)
            or re.fullmatch(r"[a-f0-9]{64}", artifact_sha) is None
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Skill source and artifact evidence are malformed.",
            )
        try:
            parsed_url = urlsplit(canonical_url)
        except ValueError as exc:
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Skill source URL is invalid.",
            ) from exc
        if (
            parsed_url.scheme != "https"
            or not parsed_url.hostname
            or parsed_url.username is not None
            or parsed_url.password is not None
            or parsed_url.netloc != parsed_url.netloc.lower()
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Skill source URL must be canonical HTTPS without userinfo.",
            )
        return {
            "actionId": body.action_id,
            "targetDigestSha256": body.target_digest_sha256,
            "inputSha256": body.input_sha256,
            "guideVersion": body.guide_version,
            "guideSha256": body.guide_sha256,
            "effectOutcome": "verified",
            "effectResultSha256": cast(str, effect_result_sha256),
            "effectReadbackOutcome": "verified",
            "effectReadbackSha256": cast(str, read_evidence.get("effectReadbackSha256")),
            "readbackVerified": True,
            "sourceRef": raw_source_ref,
            "canonicalUrl": canonical_url,
            "sourceSha256": source_sha,
            "workArtifactSha256": artifact_sha,
        }

    def skill_receipt_body_from_view(
        principal: PersistencePrincipal,
        organization_id: str,
        workspace_id: str,
        skill: Mapping[str, object],
    ) -> VerifiedSkillCreate:
        work_store = cast(WorkTaskLookup | None, getattr(app.state, "work_store", None))
        operation_id = skill.get("operationReceiptId")
        if work_store is None or not isinstance(operation_id, str):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_UNAVAILABLE",
                503,
                "A WorkStore is required to reconstruct verified skill evidence.",
            )
        operation = work_store.get_operation(
            organization_id,
            workspace_id,
            operation_id,
            actor_id=principal.actor_id,
            actor_private_scope=True,
        )
        request_payload = operation.get("request")
        if not isinstance(request_payload, Mapping):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Stored skill receipt request is invalid.",
            )
        try:
            return VerifiedSkillCreate.model_validate(
                {
                    "idempotencyKey": skill.get("idempotencyKey"),
                    "conversationId": skill.get("conversationId"),
                    "conversationKind": skill.get("conversationKind"),
                    "personaId": skill.get("personaId"),
                    "name": skill.get("name"),
                    "content": skill.get("content"),
                    "sourceRefs": skill.get("sourceRefs"),
                    "operationReceiptId": skill.get("operationReceiptId"),
                    "independentReadReceiptId": skill.get("independentReadReceiptId"),
                    "actionId": request_payload.get("actionId"),
                    "targetDigestSha256": request_payload.get("targetDigestSha256"),
                    "inputSha256": request_payload.get("inputSha256"),
                    "guideVersion": request_payload.get("guideVersion"),
                    "guideSha256": request_payload.get("guideSha256"),
                }
            )
        except ValidationError as exc:
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Stored skill receipt does not contain its typed action scope.",
            ) from exc

    def verify_watch_observation(
        principal: PersistencePrincipal,
        organization_id: str,
        workspace_id: str,
        watch: Mapping[str, object],
        body: WatchObservation,
    ) -> None:
        """Verify a completed actor-private research read before watch CAS."""

        if (
            not principal.can_write_harness
            or not principal.actor_private_scope
            or principal.organization_id is None
        ):
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "Watch observations require a trusted actor-private Harness worker.",
            )
        version_matches = watch.get("version") == body.expected_version
        replay_matches = (
            watch.get("version") == body.expected_version + 1
            and watch.get("lastOperationReceiptId") == body.operation_receipt_id
            and watch.get("lastResultSha256") == body.result_sha256
            and watch.get("nextCheckAt") == body.next_check_at
        )
        if watch.get("state") != "active" or not (version_matches or replay_matches):
            raise PersistenceError(
                "CONVERSATION_DOMAIN_CONFLICT", 409, "Watch state or version changed."
            )
        task_id = conversation_watch_task_id(str(watch["id"]), body.expected_version)
        if body.task_id != task_id:
            raise PersistenceError(
                "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                409,
                "Watch Task identity does not match the persisted watch version.",
            )
        work_store = cast(WorkTaskLookup | None, getattr(app.state, "work_store", None))
        if work_store is None:
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_UNAVAILABLE",
                503,
                "A WorkStore is required to verify watch observations.",
            )
        try:
            operation = work_store.get_operation(
                organization_id,
                workspace_id,
                body.operation_receipt_id,
                actor_id=principal.actor_id,
                actor_private_scope=True,
            )
        except PersistenceError as exc:
            if exc.status == 404:
                raise PersistenceError(
                    "WORK_OPERATION_VERIFICATION_REQUIRED",
                    409,
                    "Watch observation operation receipt is unavailable.",
                ) from exc
            raise
        trusted_producer = operation.get("trustedProducer")
        if trusted_producer is None:
            raise PersistenceError(
                "WORK_OPERATION_PROVENANCE_UNAVAILABLE",
                503,
                "WorkStore has no immutable research runtime producer marker yet.",
            )
        if trusted_producer != "conversation-research-runtime":
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Watch receipt was not produced by the trusted research runtime.",
            )
        refs = _source_ref_payloads(cast(Sequence[object], watch.get("sourceRefs", [])))
        refs_digest = _canonical_sha256(refs)
        condition_digest = hashlib.sha256(str(watch.get("condition", "")).encode()).hexdigest()
        expected_request = {
            "source": "conversation-watch",
            "taskId": task_id,
            "workspaceId": workspace_id,
            "actorId": principal.actor_id,
            "conversationId": watch.get("conversationId"),
            "conversationKind": watch.get("conversationKind"),
            "personaId": watch.get("personaId"),
            "idempotencyKey": watch.get("idempotencyKey"),
            "parentTaskId": watch.get("ownerTaskId"),
            "parentSessionId": watch.get("ownerSessionId"),
            "watchId": watch.get("id"),
            "watchVersion": body.expected_version,
            "sourceRefsDigest": refs_digest,
            "conditionSha256": condition_digest,
        }
        request_payload = operation.get("request")
        evidence = operation.get("evidence")
        if (
            operation.get("id") != body.operation_receipt_id
            or operation.get("operationType") != "conversation.research.read.v1"
            or operation.get("status") != "verified"
            or operation.get("taskId") != task_id
            or not isinstance(request_payload, Mapping)
            or dict(request_payload) != expected_request
            or not isinstance(evidence, Mapping)
            or evidence.get("outcome") != "verified"
            or evidence.get("effect") != "read"
            or evidence.get("resultSha256") != body.result_sha256
            or evidence.get("sourceRefs") is None
            or _canonical_json(_source_ref_payloads(cast(Sequence[object], evidence["sourceRefs"])))
            != _canonical_json(refs)
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Watch receipt does not match its exact versioned source scope.",
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
                    "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                    409,
                    "Watch observation requires its completed actor-private Task.",
                ) from exc
            raise
        metadata = {
            "source": "conversation-watch",
            "workspaceId": workspace_id,
            "actorId": principal.actor_id,
            "watchId": watch["id"],
            "watchVersion": body.expected_version,
            "idempotencyKey": watch["idempotencyKey"],
            "parentTaskId": watch["ownerTaskId"],
            "parentSessionId": watch["ownerSessionId"],
            "conversationId": watch["conversationId"],
            "conversationKind": watch["conversationKind"],
            "personaId": watch["personaId"],
            "sourceRefsDigest": refs_digest,
            "conditionSha256": condition_digest,
            "sourceRefs": refs,
        }
        output = task.get("output")
        task_digest = operation.get("taskOutputSha256")
        if (
            task.get("id") != task_id
            or task.get("workspaceId") != workspace_id
            or task.get("createdByActorId") != principal.actor_id
            or task.get("sessionId") != watch.get("ownerSessionId")
            or task.get("status") != "completed"
            or task.get("metadata") != metadata
            or not isinstance(output, str)
            or task_digest != hashlib.sha256(output.encode()).hexdigest()
        ):
            raise PersistenceError(
                "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                409,
                "Watch Task metadata or output does not match the verified operation.",
            )

    def verify_daily_review_report(
        principal: PersistencePrincipal,
        organization_id: str,
        workspace_id: str,
        body: ReviewEventCreate,
    ) -> None:
        """Bind a source-free daily-review ledger row to a live private Task and report."""

        if not principal.can_write_harness or not principal.actor_private_scope:
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "Daily review requires the actor-private Harness worker principal.",
            )
        work_store = cast(WorkTaskLookup | None, getattr(app.state, "work_store", None))
        if work_store is None:
            raise PersistenceError(
                "DAILY_REVIEW_REPORT_UNAVAILABLE",
                503,
                "A WorkStore is required to verify daily review reports.",
                retryable=True,
            )
        task_id = body.task_id
        if task_id is None:
            raise PersistenceError(
                "DAILY_REVIEW_TASK_REQUIRED", 422, "daily_review requires its exact Work Task id."
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
                    "DAILY_REVIEW_TASK_REQUIRED",
                    409,
                    "Daily review Task is unavailable in the current actor scope.",
                ) from exc
            raise
        raw_metadata = task.get("metadata")
        if not isinstance(raw_metadata, Mapping):
            raise PersistenceError(
                "DAILY_REVIEW_TASK_REQUIRED",
                409,
                "Daily review Task metadata is unavailable.",
            )
        metadata = cast(Mapping[str, object], raw_metadata)
        job_id_value = metadata.get("maintenanceJobId")
        if not isinstance(job_id_value, str):
            raise PersistenceError(
                "DAILY_REVIEW_TASK_REQUIRED",
                409,
                "The Work Task is not bound to an actor-owned maintenance job.",
            )
        job_id = job_id_value
        job = domain_store.get_maintenance_job(
            organization_id, workspace_id, principal.actor_id, job_id
        )
        if (
            job.get("kind") != "daily_review"
            or job.get("state") != "running"
            or job.get("taskId") != task_id
            or job.get("conversationId") != body.conversation_id
            or job.get("conversationKind") != body.conversation_kind
            or job.get("personaId") != body.persona_id
        ):
            raise PersistenceError(
                "DAILY_REVIEW_TASK_SCOPE_MISMATCH",
                409,
                "The report Task does not match the current daily-review job scope.",
            )
        verified_task = maintenance_task_for_job(principal, organization_id, workspace_id, job)
        if (
            verified_task is None
            or verified_task.get("id") != task_id
            or verified_task.get("status") != "running"
            or not isinstance(verified_task.get("metadata"), Mapping)
        ):
            raise PersistenceError(
                "DAILY_REVIEW_TASK_REQUIRED",
                409,
                "The report must be written by its running actor-private Work Task.",
            )
        metadata = cast(Mapping[str, object], verified_task["metadata"])
        if (
            metadata.get("source") != "conversation-maintenance"
            or metadata.get("kind") != "daily_review"
            or metadata.get("maintenanceJobId") != job_id
        ):
            raise PersistenceError(
                "DAILY_REVIEW_TASK_SCOPE_MISMATCH",
                409,
                "The report Task metadata does not identify this daily-review job.",
            )

        try:
            summary = json.loads(body.summary)
        except json.JSONDecodeError as exc:
            raise PersistenceError(
                "DAILY_REVIEW_REPORT_INVALID", 422, "Daily review summary is invalid JSON."
            ) from exc
        report = summary.get("report") if isinstance(summary, Mapping) else None
        if not isinstance(report, Mapping):
            raise PersistenceError(
                "DAILY_REVIEW_REPORT_INVALID", 422, "Daily review summary has no report receipt."
            )
        artifact_id = report.get("artifactId")
        digest = report.get("sha256")
        report_size = report.get("sizeBytes")
        if (
            not isinstance(artifact_id, str)
            or artifact_id != digest
            or not re.fullmatch(r"[a-f0-9]{64}", artifact_id)
            or type(report_size) is not int
            or not 1 <= report_size <= 10_000_000
        ):
            raise PersistenceError(
                "DAILY_REVIEW_REPORT_INVALID", 422, "Daily review report receipt is malformed."
            )
        try:
            attachment, path = work_store.get_attachment(
                organization_id,
                workspace_id,
                artifact_id,
                actor_id=principal.actor_id,
                actor_private_scope=True,
                require_actor_private=True,
            )
            descriptor = os.open(
                path,
                os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0),
            )
            with os.fdopen(descriptor, "rb") as stream:
                file_info = os.fstat(stream.fileno())
                if not stat.S_ISREG(file_info.st_mode) or file_info.st_size != report_size:
                    raise ValueError("report attachment size or type differs from its receipt")
                content = stream.read(10_000_001)
        except (OSError, ValueError) as exc:
            raise PersistenceError(
                "DAILY_REVIEW_REPORT_READBACK_FAILED",
                409,
                "Daily review report attachment could not be independently read back.",
            ) from exc
        if (
            len(content) != report_size
            or hashlib.sha256(content).hexdigest() != digest
            or attachment.get("id") != artifact_id
            or attachment.get("sha256") != digest
            or attachment.get("size") != report_size
            or not isinstance(attachment.get("mediaType"), str)
            or not str(attachment["mediaType"]).startswith("application/")
            or not (
                attachment["mediaType"] == "application/json"
                or str(attachment["mediaType"]).endswith("+json")
            )
        ):
            raise PersistenceError(
                "DAILY_REVIEW_REPORT_READBACK_FAILED",
                409,
                "Daily review report attachment metadata or digest differs from its receipt.",
            )
        try:
            manifest = json.loads(content)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PersistenceError(
                "DAILY_REVIEW_REPORT_READBACK_FAILED",
                409,
                "Daily review report attachment is not valid JSON.",
            ) from exc
        if (
            not isinstance(manifest, Mapping)
            or manifest.get("schema") != "cyrene.conversation-daily-review.v1"
        ):
            raise PersistenceError(
                "DAILY_REVIEW_REPORT_READBACK_FAILED",
                409,
                "Daily review report attachment has an unexpected schema.",
            )
        report_scope = manifest.get("scope")
        if not isinstance(report_scope, Mapping) or any(
            report_scope.get(key) != value
            for key, value in (
                ("conversationId", body.conversation_id),
                ("conversationKind", body.conversation_kind),
                ("personaId", body.persona_id),
            )
        ):
            raise PersistenceError(
                "DAILY_REVIEW_REPORT_READBACK_FAILED",
                409,
                "Daily review report scope does not match the authenticated ledger scope.",
            )
        manifest_refs = manifest.get("sourceRefs")
        if not isinstance(manifest_refs, list):
            raise PersistenceError(
                "DAILY_REVIEW_REPORT_READBACK_FAILED",
                409,
                "Daily review report sourceRefs are missing.",
            )
        expected_refs = _source_ref_payloads(body.source_refs)
        actual_refs = _source_ref_payloads(manifest_refs)
        if json.dumps(actual_refs, sort_keys=True, separators=(",", ":")) != json.dumps(
            expected_refs, sort_keys=True, separators=(",", ":")
        ):
            raise PersistenceError(
                "DAILY_REVIEW_REPORT_READBACK_FAILED",
                409,
                "Daily review report source lineage differs from its ledger event.",
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

    @app.get(base + "/personas/binding", response_model=PersonaBindingReadReceipt)
    def get_persona_binding(
        workspace_id: str,
        request: Request,
        conversation_id: str = Query(
            alias="conversationId", min_length=1, max_length=200
        ),
        conversation_kind: Literal["direct", "group", "channel"] = Query(
            alias="conversationKind"
        ),
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        binding = domain_store.get_persona_binding(
            organization_id,
            workspace_id,
            principal.actor_id,
            conversation_id,
            conversation_kind,
        )
        personas = domain_store.list_personas(
            organization_id,
            workspace_id,
            principal.actor_id,
            conversation_id,
        )
        available_ids = [
            str(persona["id"])
            for persona in personas
            if persona.get("enabled") is True
        ]
        return {"binding": binding, "availablePersonaIds": available_ids}

    @app.put(base + "/personas/binding", response_model=PersonaBindingReceipt)
    def put_persona_binding(
        workspace_id: str,
        body: PersonaBindingPut,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        binding = domain_store.put_persona_binding(
            organization_id,
            workspace_id,
            principal.actor_id,
            body.model_dump(by_alias=True, exclude_none=False),
        )
        return binding

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
        normalized_refs, normalized_evidence = verify_research_evidence_receipt(
            principal, organization_id, workspace_id, body
        )
        validate_source_evidence_artifacts(
            principal,
            workspace_id,
            body.conversation_id,
            body.conversation_kind,
            body.persona_id,
            normalized_refs,
            normalized_evidence,
            read_contents=True,
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
        parent_task_id, parent_session_id = resolve_trusted_turn(
            request, workspace_id, principal
        )
        evidence = verify_skill_receipts(
            principal,
            organization_id,
            workspace_id,
            body,
            parent_task_id,
            parent_session_id,
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
            domain_body(
                body,
                "action_id",
                "target_digest_sha256",
                "input_sha256",
                "guide_version",
                "guide_sha256",
            ),
        )
        skill["evidence"] = evidence
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
        verified_items: list[WireView] = []
        for item in filter_authorized_views(principal, workspace_id, items):
            evidence_body = skill_receipt_body_from_view(
                principal, organization_id, workspace_id, item
            )
            evidence = verify_skill_receipts(
                principal,
                organization_id,
                workspace_id,
                evidence_body,
                None,
                None,
                require_worker=False,
            )
            verified_items.append({**item, "evidence": evidence})
        return {"items": verified_items}

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
        owner_task_id, owner_session_id = resolve_trusted_turn(request, workspace_id, principal)
        duplicate = has_idempotency_record(
            organization_id,
            workspace_id,
            principal.actor_id,
            "watches",
            "idempotency_key",
            body.idempotency_key,
        )
        watch_body = domain_body(body)
        watch_body["ownerTaskId"] = owner_task_id
        watch_body["ownerSessionId"] = owner_session_id
        watch = domain_store.create_watch(
            organization_id,
            workspace_id,
            principal.actor_id,
            watch_body,
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

    @app.post(base + "/watches/{watch_id}/observe", response_model=WatchUpdateReceipt)
    def record_watch_observation(
        workspace_id: str,
        watch_id: str,
        body: WatchObservation,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        current = domain_store.get_watch(
            organization_id, workspace_id, principal.actor_id, watch_id
        )
        require_view_sources(principal, workspace_id, current)
        verify_watch_observation(principal, organization_id, workspace_id, current, body)
        watch = domain_store.record_watch_observation(
            organization_id,
            workspace_id,
            principal.actor_id,
            watch_id,
            body.expected_version,
            body.task_id,
            body.operation_receipt_id,
            body.result_sha256,
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
        if body.event_type == "daily_review" and not (
            principal.can_write_harness and principal.actor_private_scope
        ):
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "Daily review ledger events require the actor-private Harness worker principal.",
            )
        if body.event_type == "daily_review":
            verify_daily_review_report(principal, organization_id, workspace_id, body)
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
            domain_body(body, "task_id"),
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
