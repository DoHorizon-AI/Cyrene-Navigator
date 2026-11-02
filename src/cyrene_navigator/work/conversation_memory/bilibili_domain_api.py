"""
┌─────────────────────────────────────────────────────────────────────┐
│  Module: cyrene_navigator.work.conversation_memory.bilibili_domain_api│
│  Role: Authenticated Bilibili delegation and subscription routes.   │
│                                                                     │
│  模块职责：挂载 Bilibili 委托、订阅与受信回执验证 API。               │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections.abc import Mapping, Sequence
from typing import Any, Literal, Protocol, cast

from fastapi import FastAPI, Query, Request, Response
from pydantic import Field

from cyrene_navigator.persistence.errors import WORKSPACE_FORBIDDEN, PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_memory.bilibili_domains import (
    BilibiliDomainStore,
    WireView,
    bilibili_notification_readback_task_id,
    bilibili_notification_task_id,
    bilibili_resource_ref,
    bilibili_subscription_operation_idempotency_key,
    bilibili_subscription_task_id,
    bilibili_target_from_arguments,
    normalize_bilibili_arguments,
)
from cyrene_navigator.work.conversation_memory.domain_models import (
    DomainModel,
    DomainSourceRef,
)

ConversationKind = Literal["direct", "group", "channel"]
BilibiliOperationId = Literal[
    "bilibili.search",
    "bilibili.user.find",
    "bilibili.video.read",
    "bilibili.comments.list",
    "bilibili.dynamics.list",
    "bilibili.dynamic.read",
    "bilibili.dm.list",
    "bilibili.dm.read",
    "bilibili.comment.create",
    "bilibili.dynamic.publish",
    "bilibili.dm.send",
]
SubscriptionState = Literal["active", "paused", "cancelled", "expired", "revoked", "uncertain"]
NotificationOutcome = Literal["queued", "accepted", "delivered", "held", "uncertain"]


class BilibiliGrantCreate(DomainModel):
    """One exact provider operation, target selector, and full argument digest."""

    operation_id: BilibiliOperationId
    target: dict[str, str | int]
    arguments_digest_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class BilibiliGrantView(BilibiliGrantCreate):
    """Server-computed resource reference for one delegated operation."""

    resource_ref: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")


class BilibiliDelegationCreate(DomainModel):
    """Create owner intent without accepting owner or credential identity fields."""

    idempotency_key: str = Field(min_length=1, max_length=200)
    connection_ref: str = Field(min_length=1, max_length=512)
    profile_ref: str = Field(min_length=1, max_length=512)
    conversation_id: str = Field(min_length=1, max_length=512)
    conversation_kind: ConversationKind
    persona_id: str | None = Field(default=None, max_length=512)
    expires_at: int = Field(ge=0)
    grants: list[BilibiliGrantCreate] = Field(min_length=1, max_length=256)
    source_refs: list[DomainSourceRef] = Field(min_length=1, max_length=256)


class BilibiliDelegationView(DomainModel):
    """Owner-scoped delegation and exact operation targets."""

    id: str
    idempotency_key: str
    workspace_id: str
    owner_actor_id: str
    connection_ref: str
    profile_ref: str
    conversation_id: str
    conversation_kind: ConversationKind
    persona_id: str | None = None
    grants: list[BilibiliGrantView]
    source_refs: list[DomainSourceRef]
    expires_at: int
    state: Literal["active", "revoked", "expired"]
    version: int = Field(ge=1)
    created_at: int = Field(ge=0)
    updated_at: int = Field(ge=0)


class BilibiliDelegationReceipt(DomainModel):
    delegation: BilibiliDelegationView
    duplicate: bool = False


class BilibiliDelegationsView(DomainModel):
    items: list[BilibiliDelegationView]
    next_cursor: str | None = None


class BilibiliDelegationAuthorize(DomainModel):
    operation_id: BilibiliOperationId
    target: dict[str, str | int]
    arguments: dict[str, Any]
    arguments_digest_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class BilibiliDelegationAuthorizationView(DomainModel):
    allowed: bool
    reason: str | None = None
    delegation_id: str
    resource_ref: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    version: int = Field(ge=1)
    expires_at: int = Field(ge=0)
    fresh_grant_ref: str | None = None
    fresh_proof_digest: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    proof_expires_at: int | None = Field(default=None, ge=0)
    requires_fresh_provider_proof: Literal[True] = True


class BilibiliDelegationRevoke(DomainModel):
    expected_version: int = Field(ge=1)


class BilibiliDelegationRevocation(DomainModel):
    delegation_id: str
    state: Literal["revoked"]
    version: int = Field(ge=2)


class BilibiliSubscriptionCreate(DomainModel):
    """Create an owner-scoped, delegation-bound durable subscription."""

    idempotency_key: str = Field(min_length=1, max_length=200)
    delegation_id: str = Field(min_length=1, max_length=512)
    connection_ref: str = Field(min_length=1, max_length=512)
    profile_ref: str = Field(min_length=1, max_length=512)
    operation_id: BilibiliOperationId
    resource_ref: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    arguments: dict[str, Any]
    source_refs: list[DomainSourceRef] = Field(min_length=1, max_length=256)
    conversation_id: str = Field(min_length=1, max_length=512)
    conversation_kind: ConversationKind
    persona_id: str | None = Field(default=None, max_length=512)
    expires_at: int = Field(ge=0)
    next_check_at: int | None = Field(default=None, ge=0)


class BilibiliSubscriptionView(DomainModel):
    """Restartable subscription state and its latest operation/outbox receipts."""

    id: str
    idempotency_key: str
    workspace_id: str
    owner_actor_id: str
    conversation_id: str
    conversation_kind: ConversationKind
    persona_id: str | None = None
    delegation_id: str
    connection_ref: str
    profile_ref: str
    owner_task_id: str
    owner_session_id: str
    operation_id: BilibiliOperationId
    resource_ref: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    arguments: dict[str, Any]
    source_refs: list[DomainSourceRef]
    expires_at: int
    next_check_at: int | None = None
    scheduled_run_key: str | None = None
    scheduled_expected_version: int = Field(ge=1)
    scheduled_run_state: Literal["scheduled", "claimed", "completed"]
    cursor: str | None = None
    last_output_sha256: str | None = None
    last_operation_receipt_id: str | None = None
    last_notification_receipt_id: str | None = None
    last_notification_readback_receipt_id: str | None = None
    last_notification_outcome: NotificationOutcome | None = None
    notification_send_allowed: bool
    last_delivery_receipt_id: str | None = None
    state: SubscriptionState
    version: int = Field(ge=1)
    created_at: int = Field(ge=0)
    updated_at: int = Field(ge=0)


class BilibiliSubscriptionReceipt(DomainModel):
    subscription: BilibiliSubscriptionView
    duplicate: bool = False


class BilibiliSubscriptionsView(DomainModel):
    items: list[BilibiliSubscriptionView]
    next_cursor: str | None = None


class BilibiliSubscriptionCheck(DomainModel):
    """Worker-produced durable subscription check and outbox checkpoint."""

    expected_version: int = Field(ge=1)
    run_key: str = Field(min_length=1, max_length=512)
    cursor: str | None = Field(max_length=2_048)
    last_output_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    last_operation_receipt_id: str = Field(min_length=1, max_length=512)
    last_notification_receipt_id: str | None = Field(default=None, max_length=512)
    last_notification_readback_receipt_id: str | None = Field(default=None, max_length=512)
    last_notification_outcome: NotificationOutcome | None
    last_delivery_receipt_id: str | None = Field(default=None, max_length=512)
    state: SubscriptionState
    next_check_at: int | None = Field(default=None, ge=0)


class BilibiliNotificationReconciliation(DomainModel):
    """Worker-only readback checkpoint for a previously queued notification."""

    expected_version: int = Field(ge=1)
    run_key: str = Field(min_length=1, max_length=512)
    notification_receipt_id: str = Field(min_length=1, max_length=512)
    notification_readback_receipt_id: str | None = Field(default=None, max_length=512)
    notification_outcome: NotificationOutcome
    delivery_receipt_id: str | None = Field(default=None, max_length=512)
    state: Literal["active", "paused", "cancelled", "uncertain"]
    next_check_at: int | None = Field(..., ge=0)


class BilibiliSubscriptionTransition(DomainModel):
    expected_version: int = Field(ge=1)
    state: Literal["active", "paused", "cancelled"]
    next_check_at: int | None = Field(default=None, ge=0)


class BilibiliSubscriptionClaim(DomainModel):
    expected_version: int = Field(ge=1)


class BilibiliNotificationAuthorizationRequest(DomainModel):
    expected_version: int = Field(ge=1)
    run_key: str = Field(min_length=1, max_length=512)
    source_output_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class BilibiliNotificationAuthorizationView(DomainModel):
    allowed: bool
    reason: str | None = None
    subscription_id: str
    version: int = Field(ge=1)
    run_key: str | None = None
    notification_id: str | None = None
    notification_idempotency_key: str | None = None


class BilibiliSubscriptionReceiptView(DomainModel):
    subscription: BilibiliSubscriptionView


class BilibiliSubscriptionRunPlan(DomainModel):
    """Server-derived Task admission data for one persisted subscription run."""

    task_id: str
    operation_idempotency_key: str
    source_metadata: dict[str, str | int | None]
    runtime_plan_digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class BilibiliSubscriptionRunPlanReceipt(DomainModel):
    subscription: BilibiliSubscriptionView
    run_plan: BilibiliSubscriptionRunPlan


class PrincipalResolver(Protocol):
    def __call__(
        self, request: Request, workspace_id: str, *, write: bool = False
    ) -> PersistencePrincipal: ...


class SourceRefValidator(Protocol):
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


class BilibiliConnectionResolver(Protocol):
    def __call__(
        self,
        organization_id: str,
        workspace_id: str,
        actor_id: str,
        connection_ref: str,
        profile_ref: str,
    ) -> str: ...


class ConnectorOperationPreflight(Protocol):
    """Mint, but do not consume, a fresh Directory-backed Exchange proof."""

    def __call__(
        self,
        organization_id: str,
        workspace_id: str,
        actor_id: str,
        connection_ref: str,
        profile_ref: str,
        operation_id: str,
        target: Mapping[str, object],
        arguments: Mapping[str, object],
    ) -> Mapping[str, object]: ...


class TrustedTurnContextResolver(Protocol):
    """Resolve the current real Work Task/session from host-authenticated context."""

    def __call__(
        self,
        request: Request,
        workspace_id: str,
        principal: PersistencePrincipal,
    ) -> Mapping[str, str]: ...


class WorkReceiptReader(Protocol):
    def get_operation(
        self,
        organization_id: str | None,
        workspace_id: str,
        operation_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> Mapping[str, object]: ...

    def get_task(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> Mapping[str, object]: ...

    def get_notification(
        self,
        organization_id: str | None,
        workspace_id: str,
        notification_id: str,
        *,
        actor_id: str | None = None,
        actor_private_scope: bool = False,
    ) -> Mapping[str, object]: ...


def _canonical_sha256(value: object) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _text_sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _bilibili_effective_operation_key(actor_scope_sha256: str, logical_key: str) -> str:
    digest = hashlib.sha256(f"{actor_scope_sha256}\0{logical_key}".encode()).hexdigest()
    return f"bilibili:{digest}"


def _subscription_run_plan(
    organization_id: str,
    workspace_id: str,
    actor_id: str,
    subscription: Mapping[str, object],
    delegation_version: int,
) -> WireView:
    """Rebuild stable Task metadata and digest from the persisted subscription row."""

    subscription_id = subscription.get("id")
    run_key = subscription.get("scheduledRunKey")
    expected_version = subscription.get("scheduledExpectedVersion")
    arguments = subscription.get("arguments")
    source_refs = subscription.get("sourceRefs")
    required_text_fields = (
        "delegationId",
        "connectionRef",
        "profileRef",
        "operationId",
        "resourceRef",
        "conversationId",
        "conversationKind",
        "ownerTaskId",
        "ownerSessionId",
    )
    if (
        not isinstance(subscription_id, str)
        or not isinstance(run_key, str)
        or not isinstance(expected_version, int)
        or isinstance(expected_version, bool)
        or not isinstance(arguments, Mapping)
        or not isinstance(source_refs, list)
        or any(not isinstance(subscription.get(key), str) for key in required_text_fields)
        or (
            subscription.get("personaId") is not None
            and not isinstance(subscription.get("personaId"), str)
        )
    ):
        raise PersistenceError(
            "BILIBILI_STORAGE_CORRUPT", 500, "Persisted subscription run plan is incomplete."
        )
    operation_key = bilibili_subscription_operation_idempotency_key(
        workspace_id, actor_id, subscription_id, run_key
    )
    task_id = bilibili_subscription_task_id(workspace_id, actor_id, subscription_id, run_key)
    metadata: dict[str, str | int | None] = {
        "source": "conversation-bili-subscription-read",
        "organizationId": organization_id,
        "workspaceId": workspace_id,
        "actorId": actor_id,
        "subscriptionId": subscription_id,
        "delegationId": str(subscription["delegationId"]),
        "delegationVersion": delegation_version,
        "connectionRef": str(subscription["connectionRef"]),
        "profileRef": str(subscription["profileRef"]),
        "operationId": str(subscription["operationId"]),
        "resourceRef": str(subscription["resourceRef"]),
        "argumentsDigestSha256": _canonical_sha256(arguments),
        "sourceRefsDigest": _canonical_sha256(source_refs),
        "conversationId": str(subscription["conversationId"]),
        "conversationKind": str(subscription["conversationKind"]),
        "personaId": cast(str | None, subscription.get("personaId")),
        "ownerTaskId": str(subscription["ownerTaskId"]),
        "ownerSessionId": str(subscription["ownerSessionId"]),
        "runKey": run_key,
        "expectedVersion": expected_version,
        "operationIdempotencyKey": operation_key,
    }
    plan_payload = {
        "taskId": task_id,
        "operationIdempotencyKey": operation_key,
        "sourceMetadata": metadata,
        "arguments": dict(arguments),
        "cursor": subscription.get("cursor"),
        "sourceRefs": source_refs,
    }
    return {
        "taskId": task_id,
        "operationIdempotencyKey": operation_key,
        "sourceMetadata": metadata,
        "runtimePlanDigest": _canonical_sha256(plan_payload),
    }


def mount_bilibili_routes(
    app: FastAPI,
    base: str,
    principal_for: PrincipalResolver,
    domain_store: BilibiliDomainStore,
    validate_source_refs: SourceRefValidator,
    resolve_connection: BilibiliConnectionResolver,
    trusted_turn_context: TrustedTurnContextResolver,
    preflight_operation: ConnectorOperationPreflight | None = None,
    work_store: WorkReceiptReader | None = None,
) -> None:
    """Mount same-origin, actor-scoped Bilibili intent and subscription routes.

    `base` should be the host Work conversation-memory route followed by
    `/bilibili`. Directory/profile resolution remains a host callback; a grant is
    user intent only and cannot stand in for fresh provider authorization.
    """

    def actor_scope(
        request: Request, workspace_id: str, *, write: bool
    ) -> tuple[PersistencePrincipal, str]:
        principal = principal_for(request, workspace_id, write=write)
        if principal.organization_id is None:
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "Organization-scoped Work identity is required for Bilibili state.",
            )
        return principal, principal.organization_id

    def validate_sources(
        principal: PersistencePrincipal,
        workspace_id: str,
        view: Mapping[str, object],
    ) -> None:
        refs = view.get("sourceRefs")
        if not isinstance(refs, list) or not refs:
            raise PersistenceError(
                "BILIBILI_DOMAIN_SOURCE_UNAVAILABLE",
                409,
                "Bilibili record has no valid source lineage.",
            )
        context = (
            view.get("conversationId"),
            view.get("conversationKind"),
            view.get("personaId"),
        )
        if (not isinstance(context[0], str) or not isinstance(context[1], str)) or (
            context[2] is not None and not isinstance(context[2], str)
        ):
            raise PersistenceError(
                "BILIBILI_DOMAIN_SOURCE_UNAVAILABLE", 409, "Bilibili source context is invalid."
            )
        try:
            normalized = [
                ref.model_dump(by_alias=True, exclude_none=False)
                if isinstance(ref, DomainSourceRef)
                else ref
                for ref in refs
            ]
            if any(not isinstance(ref, Mapping) for ref in normalized):
                raise PersistenceError(
                    "BILIBILI_DOMAIN_STORAGE_CORRUPT", 500, "Stored source refs are invalid."
                )
            validate_source_refs(
                principal.organization_id,
                workspace_id,
                principal.actor_id,
                context[0],
                context[1],
                context[2],
                cast(Sequence[Mapping[str, object]], normalized),
            )
        except PersistenceError:
            raise

    def require_sources(
        principal: PersistencePrincipal, workspace_id: str, view: Mapping[str, object]
    ) -> None:
        try:
            validate_sources(principal, workspace_id, view)
        except PersistenceError as exc:
            if exc.status in {401, 403, 404, 409, 422}:
                raise PersistenceError(
                    "BILIBILI_DOMAIN_SOURCE_UNAVAILABLE",
                    409,
                    "A Bilibili source is no longer authorized.",
                ) from exc
            raise

    def view_sources_authorized(
        principal: PersistencePrincipal,
        workspace_id: str,
        view: Mapping[str, object],
    ) -> bool:
        try:
            validate_sources(principal, workspace_id, view)
        except PersistenceError as exc:
            if exc.status in {401, 403, 404, 409, 422}:
                return False
            raise
        return True

    def authorized_items(
        principal: PersistencePrincipal,
        workspace_id: str,
        page: Mapping[str, object],
    ) -> list[WireView]:
        raw_items = page.get("items")
        if not isinstance(raw_items, list):
            raise PersistenceError(
                "BILIBILI_STORAGE_CORRUPT", 500, "Bilibili page items are invalid."
            )
        return [
            cast(WireView, item)
            for item in raw_items
            if isinstance(item, Mapping) and view_sources_authorized(principal, workspace_id, item)
        ]

    def resolve_owned_profile(
        principal: PersistencePrincipal,
        organization_id: str,
        workspace_id: str,
        connection_ref: str,
        profile_ref: str,
    ) -> str:
        subject = resolve_connection(
            organization_id,
            workspace_id,
            principal.actor_id,
            connection_ref,
            profile_ref,
        )
        if not isinstance(subject, str) or not subject.strip():
            raise PersistenceError(
                "BILIBILI_CONNECTION_UNAVAILABLE",
                409,
                "The Bilibili profile is not currently owned by this Work actor.",
            )
        return subject

    def resolve_trusted_turn(
        request: Request, workspace_id: str, principal: PersistencePrincipal
    ) -> tuple[str, str]:
        context = trusted_turn_context(request, workspace_id, principal)
        task_id = context.get("taskId")
        session_id = context.get("sessionId")
        if not isinstance(task_id, str) or not task_id.strip():
            raise PersistenceError(
                "BILIBILI_TRUSTED_TURN_REQUIRED", 409, "A real parent Work Task is required."
            )
        if not isinstance(session_id, str) or not session_id.strip():
            raise PersistenceError(
                "BILIBILI_TRUSTED_TURN_REQUIRED", 409, "A real Work session is required."
            )
        return task_id, session_id

    def verify_subscription_check(
        principal: PersistencePrincipal,
        organization_id: str,
        workspace_id: str,
        subscription: Mapping[str, object],
        checkpoint: BilibiliSubscriptionCheck,
    ) -> Mapping[str, object]:
        if (
            not principal.actor_private_scope
            or not principal.can_write_harness
            or principal.organization_id is None
        ):
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "An actor-private Harness worker is required for subscription checks.",
            )
        reader = work_store or cast(
            WorkReceiptReader | None, getattr(app.state, "work_store", None)
        )
        if reader is None:
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_UNAVAILABLE",
                503,
                "A WorkStore is required to verify Bilibili subscription results.",
            )
        expected_version = checkpoint.expected_version
        if (
            subscription.get("version") != expected_version
            or subscription.get("scheduledRunState") != "claimed"
            or subscription.get("scheduledExpectedVersion") != expected_version
            or subscription.get("scheduledRunKey") != checkpoint.run_key
            or subscription.get("state") != "active"
        ):
            raise PersistenceError(
                "BILIBILI_DOMAIN_CONFLICT",
                409,
                "Subscription check does not match its current scheduled run snapshot.",
            )
        delegation = domain_store.get_delegation(
            organization_id,
            workspace_id,
            principal.actor_id,
            str(subscription["delegationId"]),
        )
        require_sources(principal, workspace_id, delegation)
        if delegation.get("state") != "active":
            raise PersistenceError(
                "BILIBILI_DOMAIN_CONFLICT", 409, "Subscription delegation is no longer active."
            )
        operation_id = str(subscription["operationId"])
        connection_ref = str(subscription["connectionRef"])
        profile_ref = str(subscription["profileRef"])
        resource_ref = str(subscription["resourceRef"])
        arguments = subscription.get("arguments")
        source_refs = subscription.get("sourceRefs")
        if not isinstance(arguments, Mapping) or not isinstance(source_refs, list):
            raise PersistenceError(
                "BILIBILI_STORAGE_CORRUPT", 500, "Subscription request snapshot is invalid."
            )
        arguments_digest = _canonical_sha256(arguments)
        source_refs_digest = _canonical_sha256(source_refs)
        actor_scope_digest = _canonical_sha256(
            {
                "organizationId": organization_id,
                "workspaceId": workspace_id,
                "actorId": principal.actor_id,
            }
        )
        delegation_version = delegation.get("version")
        if not isinstance(delegation_version, int):
            raise PersistenceError(
                "BILIBILI_STORAGE_CORRUPT", 500, "Delegation version is invalid."
            )
        run_plan = _subscription_run_plan(
            organization_id,
            workspace_id,
            principal.actor_id,
            subscription,
            delegation_version,
        )
        metadata_from_plan = run_plan.get("sourceMetadata")
        check_task_id = run_plan.get("taskId")
        operation_idempotency_key = run_plan.get("operationIdempotencyKey")
        runtime_plan_digest = run_plan.get("runtimePlanDigest")
        if (
            not isinstance(metadata_from_plan, Mapping)
            or not isinstance(check_task_id, str)
            or not isinstance(operation_idempotency_key, str)
            or not isinstance(runtime_plan_digest, str)
        ):
            raise PersistenceError(
                "BILIBILI_STORAGE_CORRUPT", 500, "Subscription run plan is invalid."
            )
        expected_metadata = {
            **dict(metadata_from_plan),
            "runtimePlanDigest": runtime_plan_digest,
        }
        if expected_metadata.get("runKey") != checkpoint.run_key:
            raise PersistenceError("BILIBILI_DOMAIN_CONFLICT", 409, "Subscription run key changed.")
        expected_request = {
            "source": "conversation-bili-subscription-read",
            "actorScopeSha256": actor_scope_digest,
            "connectionRefDigest": _text_sha256(connection_ref),
            "profileRefDigest": _text_sha256(profile_ref),
            "operationId": operation_id,
            "resourceRef": resource_ref,
            "argumentsSha256": arguments_digest,
            "taskId": check_task_id,
            "parentTaskId": subscription["ownerTaskId"],
            "parentSessionId": subscription["ownerSessionId"],
            "delegationId": subscription["delegationId"],
            "delegationVersion": delegation_version,
            "sourceRefsSha256": source_refs_digest,
            "subscriptionId": subscription["id"],
            "subscriptionVersion": expected_version,
            "expectedVersion": expected_version,
            "runKey": checkpoint.run_key,
            "runtimePlanDigest": runtime_plan_digest,
            "idempotencyKey": operation_idempotency_key,
        }
        try:
            operation = reader.get_operation(
                organization_id,
                workspace_id,
                checkpoint.last_operation_receipt_id,
                actor_id=principal.actor_id,
                actor_private_scope=True,
            )
        except PersistenceError as exc:
            if exc.status == 404:
                raise PersistenceError(
                    "WORK_OPERATION_VERIFICATION_REQUIRED",
                    409,
                    "Subscription checkpoint requires an actor-private Bilibili operation.",
                ) from exc
            raise
        trusted_producer = operation.get("trustedProducer")
        if trusted_producer is None:
            raise PersistenceError(
                "BILIBILI_PRODUCER_PROVENANCE_UNAVAILABLE",
                503,
                "WorkStore has no immutable connector producer provenance yet.",
            )
        if trusted_producer != "exchange-connector-dispatch":
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Operation receipt was not produced by the trusted Exchange dispatcher.",
            )
        request_payload = operation.get("request")
        if not isinstance(request_payload, Mapping):
            request_payload = {}
        task_id = operation.get("taskId")
        evidence = operation.get("evidence")
        effective_operation_key = _bilibili_effective_operation_key(
            actor_scope_digest, operation_idempotency_key
        )
        if (
            operation.get("id") != checkpoint.last_operation_receipt_id
            or operation.get("idempotencyKey") != effective_operation_key
            or operation.get("status") != "verified"
            or operation.get("operationType") != f"tool.provider.v1:{operation_id}"
            or not isinstance(task_id, str)
            or not isinstance(evidence, Mapping)
            or task_id != check_task_id
            or dict(request_payload) != expected_request
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Bilibili operation receipt does not match this subscription.",
            )
        try:
            task = reader.get_task(
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
                    "Subscription results require a completed actor-private Task.",
                ) from exc
            raise
        output = task.get("output")
        task_digest = operation.get("taskOutputSha256")
        result_digest = evidence.get("resultSha256")
        metadata = task.get("metadata")
        if (
            task.get("id") != check_task_id
            or task.get("workspaceId") != workspace_id
            or task.get("createdByActorId") != principal.actor_id
            or task.get("status") != "completed"
            or task.get("sessionId") != subscription.get("ownerSessionId")
            or not isinstance(metadata, Mapping)
            or dict(metadata) != expected_metadata
            or not isinstance(output, str)
            or task_digest != hashlib.sha256(output.encode()).hexdigest()
            or result_digest != checkpoint.last_output_sha256
            or evidence.get("outcome") != "verified"
            or evidence.get("effect") != "read"
            or evidence.get("providerId") != "bilibili"
            or evidence.get("connectionRef") != connection_ref
            or evidence.get("profileRef") != profile_ref
            or evidence.get("operationId") != operation_id
            or evidence.get("resourceRef") != resource_ref
            or evidence.get("argumentsSha256") != arguments_digest
            or evidence.get("readbackVerified") is not True
        ):
            raise PersistenceError(
                "WORK_OPERATION_VERIFICATION_REQUIRED",
                409,
                "Subscription result digest does not match its completed Work Task receipt.",
            )
        verify_notification_checkpoint(
            reader,
            principal,
            organization_id,
            workspace_id,
            subscription,
            checkpoint,
        )
        return run_plan

    def verify_notification_checkpoint(
        reader: WorkReceiptReader,
        principal: PersistencePrincipal,
        organization_id: str,
        workspace_id: str,
        subscription: Mapping[str, object],
        checkpoint: BilibiliSubscriptionCheck,
    ) -> None:
        outcome = checkpoint.last_notification_outcome
        notification_id = checkpoint.last_notification_receipt_id
        readback_id = checkpoint.last_notification_readback_receipt_id
        delivery_id = checkpoint.last_delivery_receipt_id
        if outcome is None:
            if notification_id is not None or readback_id is not None or delivery_id is not None:
                raise PersistenceError(
                    "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                    409,
                    "A missing notification outcome cannot carry outbox or delivery receipts.",
                )
            return
        if outcome in {"queued", "accepted", "delivered"} and notification_id is None:
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "A queued or sent notification requires its Work outbox receipt.",
            )
        if outcome != "delivered" and (readback_id is not None or delivery_id is not None):
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "A delivery receipt can only be recorded after delivered status readback.",
            )
        if notification_id is None:
            return
        get_notification = getattr(reader, "get_notification", None)
        if not callable(get_notification):
            raise PersistenceError(
                "WORK_NOTIFICATION_LOOKUP_UNAVAILABLE",
                503,
                "WorkStore has no actor-private notification lookup yet.",
            )
        try:
            notification = get_notification(
                organization_id,
                workspace_id,
                notification_id,
                actor_id=principal.actor_id,
                actor_private_scope=True,
            )
        except PersistenceError as exc:
            if exc.status == 404:
                raise PersistenceError(
                    "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                    409,
                    "The actor-private Work outbox record is unavailable.",
                ) from exc
            raise
        source_output_sha = checkpoint.last_output_sha256
        expected_key = "bili-notification-" + _text_sha256(
            f"{subscription['id']}\0{source_output_sha}"
        )
        send_task_id = bilibili_notification_task_id(
            workspace_id,
            principal.actor_id,
            str(subscription["id"]),
            expected_key,
        )
        notification_payload = notification.get("payload")
        if (
            notification.get("id") != notification_id
            or notification.get("deduplicationKey") != expected_key
            or notification.get("taskId") != send_task_id
            or not isinstance(notification_payload, Mapping)
            or notification_payload.get("subscriptionId") != subscription.get("id")
            or notification_payload.get("sourceOutputSha256") != source_output_sha
            or notification_payload.get("resourceRef") != subscription.get("resourceRef")
        ):
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "Outbox notification does not match this subscription result.",
            )
        send_task_metadata = {
            "source": "conversation-bili-subscription-notification",
            "subscriptionId": subscription["id"],
            "subscriptionVersion": checkpoint.expected_version,
            "delegationId": subscription["delegationId"],
            "workspaceId": workspace_id,
            "actorId": principal.actor_id,
            "connectionRef": subscription["connectionRef"],
            "profileRef": subscription["profileRef"],
            "operationId": subscription["operationId"],
            "resourceRef": subscription["resourceRef"],
            "argumentsDigestSha256": _canonical_sha256(subscription.get("arguments")),
            "sourceRefsDigest": _canonical_sha256(subscription.get("sourceRefs")),
            "readOperationReceiptId": checkpoint.last_operation_receipt_id,
            "sourceOutputSha256": source_output_sha,
            "notificationIdempotencyKey": expected_key,
            "parentTaskId": subscription["ownerTaskId"],
            "parentSessionId": subscription["ownerSessionId"],
            "sourceRefs": subscription["sourceRefs"],
        }
        try:
            send_task = reader.get_task(
                organization_id,
                workspace_id,
                send_task_id,
                actor_id=principal.actor_id,
                actor_private_scope=True,
            )
        except PersistenceError as exc:
            if exc.status == 404:
                raise PersistenceError(
                    "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                    409,
                    "Notification outbox must be bound to its owner-private child Task.",
                ) from exc
            raise
        if (
            send_task.get("id") != send_task_id
            or send_task.get("workspaceId") != workspace_id
            or send_task.get("createdByActorId") != principal.actor_id
            or send_task.get("sessionId") != subscription.get("ownerSessionId")
            or send_task.get("status") != "completed"
            or send_task.get("metadata") != send_task_metadata
        ):
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "Notification Task metadata does not match this subscription result.",
            )
        expected_status = {
            "queued": {"queued"},
            "accepted": {"leased", "started"},
            "uncertain": {"uncertain", "started"},
            "held": {"failed"},
            "delivered": {"delivered"},
        }[outcome]
        if notification.get("status") not in expected_status:
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "Outbox status does not match the claimed notification outcome.",
            )
        if outcome != "delivered":
            if delivery_id is not None:
                raise PersistenceError(
                    "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                    409,
                    "Non-delivered outbox states cannot carry a platform receipt.",
                )
            return
        if readback_id is None or delivery_id is None:
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "Delivery requires an independent Work notification status readback.",
            )
        result = notification.get("result")
        if not isinstance(result, Mapping) or result.get("deliveryReceiptId") != delivery_id:
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "Work outbox has no matching platform delivery receipt.",
            )
        connector_id = notification.get("connectorId")
        recipient = notification.get("recipient")
        notification_updated_at = notification.get("updatedAt")
        target_digest = notification_payload.get("targetDigestSha256")
        if (
            not isinstance(connector_id, str)
            or not connector_id
            or not isinstance(recipient, str)
            or not recipient
            or not isinstance(notification_updated_at, int)
            or isinstance(notification_updated_at, bool)
            or not isinstance(target_digest, str)
            or re.fullmatch(r"[a-f0-9]{64}", target_digest) is None
        ):
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "Outbox target and update timestamp are missing.",
            )
        host_target_digest = target_digest
        readback_task_id_expected = bilibili_notification_readback_task_id(
            workspace_id,
            principal.actor_id,
            str(subscription["id"]),
            expected_key,
            notification_id,
            notification_updated_at,
        )
        try:
            readback = reader.get_operation(
                organization_id,
                workspace_id,
                readback_id,
                actor_id=principal.actor_id,
                actor_private_scope=True,
            )
        except PersistenceError as exc:
            if exc.status == 404:
                raise PersistenceError(
                    "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                    409,
                    "Notification delivery readback is unavailable.",
                ) from exc
            raise
        trusted_producer = readback.get("trustedProducer")
        if trusted_producer is None:
            raise PersistenceError(
                "BILIBILI_PRODUCER_PROVENANCE_UNAVAILABLE",
                503,
                "WorkStore has no immutable notification producer provenance yet.",
            )
        if trusted_producer != "notification-outbox":
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "Readback was not produced by the trusted notification outbox.",
            )
        request = readback.get("request")
        evidence = readback.get("evidence")
        expected_request = {
            "source": "conversation-bili-notification-readback",
            "notificationId": notification_id,
            "idempotencyKey": expected_key,
            "subscriptionId": subscription["id"],
            "sourceOutputSha256": source_output_sha,
            "hostResolvedTargetDigest": host_target_digest,
        }
        readback_task_id = readback.get("taskId")
        if (
            readback.get("id") != readback_id
            or readback.get("operationType")
            != "conversation.bilibili.subscription.notification.readback.v1"
            or readback.get("status") != "verified"
            or not isinstance(request, Mapping)
            or dict(request) != expected_request
            or not isinstance(evidence, Mapping)
            or not isinstance(readback_task_id, str)
            or readback_task_id != readback_task_id_expected
            or evidence.get("outcome") != "verified"
            or evidence.get("deliveryStatus") != "delivered"
            or evidence.get("deliveryReceiptId") != delivery_id
            or evidence.get("readbackVerified") is not True
            or not isinstance(evidence.get("readbackSha256"), str)
            or re.fullmatch(r"[a-f0-9]{64}", str(evidence.get("readbackSha256"))) is None
        ):
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "Independent outbox delivery readback does not match the notification.",
            )
        try:
            readback_task = reader.get_task(
                organization_id,
                workspace_id,
                readback_task_id,
                actor_id=principal.actor_id,
                actor_private_scope=True,
            )
        except PersistenceError as exc:
            if exc.status == 404:
                raise PersistenceError(
                    "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                    409,
                    "Notification readback requires an actor-private completed Task.",
                ) from exc
            raise
        readback_output = readback_task.get("output")
        readback_task_metadata = {
            "source": "conversation-bili-subscription-notification-readback",
            "workspaceId": workspace_id,
            "actorId": principal.actor_id,
            "subscriptionId": subscription["id"],
            "notificationId": notification_id,
            "notificationIdempotencyKey": expected_key,
            "sourceOutputSha256": source_output_sha,
            "hostResolvedTargetDigest": host_target_digest,
            "parentTaskId": send_task_id,
            "parentSessionId": subscription["ownerSessionId"],
        }
        if (
            readback_task.get("id") != readback_task_id_expected
            or readback_task.get("createdByActorId") != principal.actor_id
            or readback_task.get("workspaceId") != workspace_id
            or readback_task.get("status") != "completed"
            or readback_task.get("sessionId") != subscription.get("ownerSessionId")
            or readback_task.get("metadata") != readback_task_metadata
            or not isinstance(readback_output, str)
            or readback.get("taskOutputSha256") != _text_sha256(readback_output)
        ):
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "Notification readback Task provenance is invalid.",
            )

    def verify_subscription_notification_reconciliation(
        principal: PersistencePrincipal,
        organization_id: str,
        workspace_id: str,
        subscription: Mapping[str, object],
        body: BilibiliNotificationReconciliation,
    ) -> None:
        """Revalidate the prior read/outbox chain before a separate notification CAS."""

        if (
            not principal.actor_private_scope
            or not principal.can_write_harness
            or principal.organization_id is None
        ):
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "An actor-private Harness worker is required for notification reconciliation.",
            )
        expected_reconciliation = {
            "expectedVersion": body.expected_version,
            **body.model_dump(by_alias=True, exclude={"expected_version"}),
        }
        saved_reconciliation = domain_store.get_notification_reconciliation_snapshot(
            organization_id, workspace_id, principal.actor_id, str(subscription["id"])
        )
        replay = (
            subscription.get("version") == body.expected_version + 1
            and saved_reconciliation is not None
            and _canonical_sha256(saved_reconciliation)
            == _canonical_sha256(expected_reconciliation)
        )
        if not replay and (
            subscription.get("version") != body.expected_version
            or subscription.get("scheduledRunState") != "scheduled"
            or subscription.get("scheduledExpectedVersion") != body.expected_version
            or subscription.get("scheduledRunKey") != body.run_key
            or subscription.get("lastNotificationReceiptId") != body.notification_receipt_id
        ):
            raise PersistenceError(
                "BILIBILI_DOMAIN_CONFLICT",
                409,
                "Notification reconciliation does not match the current scheduled subscription.",
            )
        snapshot = domain_store.get_subscription_checkpoint_snapshot(
            organization_id,
            workspace_id,
            principal.actor_id,
            str(subscription["id"]),
        )
        if not isinstance(snapshot, Mapping):
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "Notification reconciliation has no prior verified read checkpoint.",
            )
        prior_version = snapshot.get("expectedVersion")
        prior_run_key = snapshot.get("runKey")
        run_snapshot = snapshot.get("verifiedRunPlan")
        if (
            not isinstance(prior_version, int)
            or isinstance(prior_version, bool)
            or not isinstance(prior_run_key, str)
            or not isinstance(run_snapshot, Mapping)
            or run_snapshot.get("taskId")
            != bilibili_subscription_task_id(
                workspace_id, principal.actor_id, str(subscription["id"]), prior_run_key
            )
            or run_snapshot.get("runtimePlanDigest") is None
            or not isinstance(run_snapshot.get("sourceMetadata"), Mapping)
        ):
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "Prior subscription run snapshot is incomplete or invalid.",
            )
        source_metadata = run_snapshot["sourceMetadata"]
        if source_metadata.get("runKey") != prior_run_key:
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "Prior subscription run key does not match its persisted metadata.",
            )
        source_subscription = dict(subscription)
        source_subscription.update(
            {
                "version": prior_version,
                "scheduledRunKey": prior_run_key,
                "scheduledExpectedVersion": prior_version,
                "scheduledRunState": "claimed",
                "state": "active",
                "cursor": run_snapshot.get("cursorBefore"),
            }
        )
        try:
            prior_checkpoint = BilibiliSubscriptionCheck(
                expected_version=prior_version,
                run_key=prior_run_key,
                cursor=cast(str | None, subscription.get("cursor")),
                last_output_sha256=str(subscription.get("lastOutputSha256")),
                last_operation_receipt_id=str(subscription.get("lastOperationReceiptId")),
                last_notification_receipt_id=body.notification_receipt_id,
                last_notification_readback_receipt_id=body.notification_readback_receipt_id,
                last_notification_outcome=body.notification_outcome,
                last_delivery_receipt_id=body.delivery_receipt_id,
                state="active",
                next_check_at=cast(int | None, subscription.get("nextCheckAt")),
            )
        except (TypeError, ValueError) as exc:
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "Prior subscription checkpoint cannot be reconstructed.",
            ) from exc
        recomputed_plan = verify_subscription_check(
            principal,
            organization_id,
            workspace_id,
            source_subscription,
            prior_checkpoint,
        )
        saved_metadata = dict(cast(Mapping[str, object], run_snapshot["sourceMetadata"]))
        recomputed_metadata = dict(
            cast(Mapping[str, object], recomputed_plan.get("sourceMetadata"))
        )
        recomputed_metadata.pop("actorId", None)
        if (
            run_snapshot.get("taskId") != recomputed_plan.get("taskId")
            or run_snapshot.get("operationIdempotencyKey")
            != recomputed_plan.get("operationIdempotencyKey")
            or run_snapshot.get("runtimePlanDigest") != recomputed_plan.get("runtimePlanDigest")
            or saved_metadata != recomputed_metadata
        ):
            raise PersistenceError(
                "WORK_NOTIFICATION_VERIFICATION_REQUIRED",
                409,
                "Persisted prior run plan no longer matches the verified read receipt.",
            )

    @app.post(
        base + "/delegations",
        response_model=BilibiliDelegationReceipt,
        status_code=201,
    )
    def create_delegation(
        workspace_id: str,
        body: BilibiliDelegationCreate,
        request: Request,
        response: Response,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        external_subject = resolve_owned_profile(
            principal,
            organization_id,
            workspace_id,
            body.connection_ref,
            body.profile_ref,
        )
        validate_sources(principal, workspace_id, body.model_dump(by_alias=True))
        delegation, duplicate = domain_store.create_delegation(
            organization_id,
            workspace_id,
            principal.actor_id,
            body.model_dump(by_alias=True),
            external_subject=external_subject,
        )
        if duplicate:
            response.status_code = 200
        return {"delegation": delegation, "duplicate": duplicate}

    @app.get(base + "/delegations", response_model=BilibiliDelegationsView)
    def list_delegations(
        workspace_id: str,
        request: Request,
        state: Literal["active", "revoked", "expired"] | None = None,
        cursor: str | None = Query(default=None, max_length=512),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        page = domain_store.list_delegations(
            organization_id,
            workspace_id,
            principal.actor_id,
            state=state,
            cursor=cursor,
            limit=limit,
        )
        items = authorized_items(principal, workspace_id, page)
        return {"items": items, "nextCursor": page["nextCursor"]}

    @app.get(base + "/delegations/{delegation_id}", response_model=BilibiliDelegationReceipt)
    def get_delegation(workspace_id: str, delegation_id: str, request: Request) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        delegation = domain_store.get_delegation(
            organization_id, workspace_id, principal.actor_id, delegation_id
        )
        require_sources(principal, workspace_id, delegation)
        return {"delegation": delegation, "duplicate": False}

    @app.post(
        base + "/delegations/{delegation_id}/authorize",
        response_model=BilibiliDelegationAuthorizationView,
    )
    def authorize_delegation(
        workspace_id: str,
        delegation_id: str,
        body: BilibiliDelegationAuthorize,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        delegation = domain_store.get_delegation(
            organization_id, workspace_id, principal.actor_id, delegation_id
        )
        require_sources(principal, workspace_id, delegation)
        external_subject = resolve_owned_profile(
            principal,
            organization_id,
            workspace_id,
            str(delegation["connectionRef"]),
            str(delegation["profileRef"]),
        )
        arguments = normalize_bilibili_arguments(body.operation_id, body.arguments)
        arguments_digest = _canonical_sha256(arguments)
        if arguments_digest != body.arguments_digest_sha256:
            raise PersistenceError(
                "BILIBILI_ARGUMENTS_DIGEST_MISMATCH",
                422,
                "argumentsDigestSha256 must match the exact normalized arguments.",
            )
        normalized_target = bilibili_target_from_arguments(body.operation_id, arguments)
        if normalized_target != body.target:
            raise PersistenceError(
                "BILIBILI_PROFILE_TARGET_MISMATCH",
                409,
                "The exact operation target must match the normalized arguments.",
            )
        if (
            body.operation_id == "bilibili.dynamic.publish"
            and normalized_target.get("user_id") != external_subject
        ):
            raise PersistenceError(
                "BILIBILI_PROFILE_TARGET_MISMATCH",
                409,
                "Dynamic publishing target must be the currently connected profile owner.",
            )
        decision = domain_store.authorize_delegation(
            organization_id,
            workspace_id,
            principal.actor_id,
            delegation_id,
            body.operation_id,
            normalized_target,
            arguments_digest,
        )
        expected_resource_ref = bilibili_resource_ref(
            str(delegation["profileRef"]), body.operation_id, normalized_target
        )
        if decision.get("resourceRef") != expected_resource_ref:
            raise PersistenceError(
                "BILIBILI_DOMAIN_CONFLICT", 409, "Persisted grant target is inconsistent."
            )
        if decision.get("allowed") is not True:
            return {**decision, "requiresFreshProviderProof": True}
        if preflight_operation is None:
            raise PersistenceError(
                "BILIBILI_PROVIDER_PREFLIGHT_UNAVAILABLE",
                503,
                "A fresh Exchange connector-operation grant preflight is required.",
            )
        preflight = preflight_operation(
            organization_id,
            workspace_id,
            principal.actor_id,
            str(delegation["connectionRef"]),
            str(delegation["profileRef"]),
            body.operation_id,
            normalized_target,
            arguments,
        )
        grant_ref = preflight.get("grantRef")
        proof_digest = preflight.get("proofDigest")
        proof_expires_at = preflight.get("expiresAt")
        delegation_expires_at = delegation.get("expiresAt")
        if (
            not isinstance(grant_ref, str)
            or not grant_ref.strip()
            or not isinstance(proof_digest, str)
            or re.fullmatch(r"[a-f0-9]{64}", proof_digest) is None
            or isinstance(proof_expires_at, bool)
            or not isinstance(proof_expires_at, int)
            or not isinstance(delegation_expires_at, int)
            or proof_expires_at <= time.time_ns() // 1_000_000
            or proof_expires_at > delegation_expires_at
        ):
            raise PersistenceError(
                "BILIBILI_PROVIDER_PREFLIGHT_INVALID",
                502,
                "Exchange returned invalid fresh connector grant metadata.",
            )
        return {
            **decision,
            "freshGrantRef": grant_ref,
            "freshProofDigest": proof_digest,
            "proofExpiresAt": proof_expires_at,
            "requiresFreshProviderProof": True,
        }

    @app.post(
        base + "/delegations/{delegation_id}/revoke",
        response_model=BilibiliDelegationRevocation,
    )
    def revoke_delegation(
        workspace_id: str,
        delegation_id: str,
        body: BilibiliDelegationRevoke,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        view = domain_store.revoke_delegation(
            organization_id,
            workspace_id,
            principal.actor_id,
            delegation_id,
            body.expected_version,
        )
        return {
            "delegationId": view["id"],
            "state": view["state"],
            "version": view["version"],
        }

    @app.post(
        base + "/subscriptions",
        response_model=BilibiliSubscriptionReceipt,
        status_code=201,
    )
    def create_subscription(
        workspace_id: str,
        body: BilibiliSubscriptionCreate,
        request: Request,
        response: Response,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        resolve_owned_profile(
            principal,
            organization_id,
            workspace_id,
            body.connection_ref,
            body.profile_ref,
        )
        validate_sources(principal, workspace_id, body.model_dump(by_alias=True))
        owner_task_id, owner_session_id = resolve_trusted_turn(request, workspace_id, principal)
        subscription_body = body.model_dump(by_alias=True)
        subscription_body["ownerTaskId"] = owner_task_id
        subscription_body["ownerSessionId"] = owner_session_id
        subscription, duplicate = domain_store.create_subscription(
            organization_id,
            workspace_id,
            principal.actor_id,
            subscription_body,
        )
        if duplicate:
            response.status_code = 200
        return {"subscription": subscription, "duplicate": duplicate}

    @app.get(base + "/subscriptions", response_model=BilibiliSubscriptionsView)
    def list_subscriptions(
        workspace_id: str,
        request: Request,
        state: SubscriptionState | None = None,
        delegation_id: str | None = Query(default=None, alias="delegationId", max_length=512),
        cursor: str | None = Query(default=None, max_length=512),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        page = domain_store.list_subscriptions(
            organization_id,
            workspace_id,
            principal.actor_id,
            state=state,
            delegation_id=delegation_id,
            cursor=cursor,
            limit=limit,
        )
        items = authorized_items(principal, workspace_id, page)
        return {"items": items, "nextCursor": page["nextCursor"]}

    @app.get(
        base + "/subscriptions/{subscription_id}", response_model=BilibiliSubscriptionReceiptView
    )
    def get_subscription(workspace_id: str, subscription_id: str, request: Request) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=False)
        subscription = domain_store.get_subscription(
            organization_id, workspace_id, principal.actor_id, subscription_id
        )
        require_sources(principal, workspace_id, subscription)
        return {"subscription": subscription}

    @app.post(
        base + "/subscriptions/{subscription_id}/claim",
        response_model=BilibiliSubscriptionRunPlanReceipt,
    )
    def claim_subscription_check(
        workspace_id: str,
        subscription_id: str,
        body: BilibiliSubscriptionClaim,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        if (
            not principal.actor_private_scope
            or not principal.can_write_harness
            or principal.organization_id is None
        ):
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "An actor-private Harness worker is required to claim Bilibili checks.",
            )
        current = domain_store.get_subscription(
            organization_id, workspace_id, principal.actor_id, subscription_id
        )
        require_sources(principal, workspace_id, current)
        delegation = domain_store.get_delegation(
            organization_id,
            workspace_id,
            principal.actor_id,
            str(current["delegationId"]),
        )
        require_sources(principal, workspace_id, delegation)
        delegation_version = delegation.get("version")
        if delegation.get("state") != "active" or not isinstance(delegation_version, int):
            raise PersistenceError(
                "BILIBILI_DOMAIN_CONFLICT", 409, "Subscription delegation is inactive."
            )
        resolve_owned_profile(
            principal,
            organization_id,
            workspace_id,
            str(current["connectionRef"]),
            str(current["profileRef"]),
        )
        subscription = domain_store.claim_subscription_check(
            organization_id,
            workspace_id,
            principal.actor_id,
            subscription_id,
            body.expected_version,
        )
        latest_delegation = domain_store.get_delegation(
            organization_id,
            workspace_id,
            principal.actor_id,
            str(subscription["delegationId"]),
        )
        require_sources(principal, workspace_id, latest_delegation)
        if (
            latest_delegation.get("state") != "active"
            or latest_delegation.get("version") != delegation_version
        ):
            raise PersistenceError(
                "BILIBILI_DOMAIN_CONFLICT",
                409,
                "Subscription delegation changed while the run was claimed.",
            )
        run_plan = _subscription_run_plan(
            organization_id,
            workspace_id,
            principal.actor_id,
            subscription,
            delegation_version,
        )
        return {"subscription": subscription, "runPlan": run_plan}

    @app.patch(
        base + "/subscriptions/{subscription_id}/check",
        response_model=BilibiliSubscriptionReceiptView,
    )
    def record_subscription_check(
        workspace_id: str,
        subscription_id: str,
        body: BilibiliSubscriptionCheck,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        current = domain_store.get_subscription(
            organization_id, workspace_id, principal.actor_id, subscription_id
        )
        require_sources(principal, workspace_id, current)
        resolve_owned_profile(
            principal,
            organization_id,
            workspace_id,
            str(current["connectionRef"]),
            str(current["profileRef"]),
        )
        run_plan = verify_subscription_check(
            principal, organization_id, workspace_id, current, body
        )
        source_metadata = run_plan.get("sourceMetadata")
        if not isinstance(source_metadata, Mapping):
            raise PersistenceError(
                "BILIBILI_STORAGE_CORRUPT", 500, "Verified subscription run metadata is invalid."
            )
        persisted_plan = {
            "taskId": run_plan.get("taskId"),
            "operationIdempotencyKey": run_plan.get("operationIdempotencyKey"),
            "runtimePlanDigest": run_plan.get("runtimePlanDigest"),
            "sourceMetadata": {
                key: value for key, value in source_metadata.items() if key != "actorId"
            },
            "cursorBefore": current.get("cursor"),
        }
        checkpoint_payload = body.model_dump(by_alias=True, exclude={"expected_version"})
        checkpoint_payload["verifiedRunPlan"] = persisted_plan
        subscription = domain_store.record_subscription_check(
            organization_id,
            workspace_id,
            principal.actor_id,
            subscription_id,
            body.expected_version,
            checkpoint_payload,
        )
        return {"subscription": subscription}

    @app.post(
        base + "/subscriptions/{subscription_id}/notification-reconciliation",
        response_model=BilibiliSubscriptionReceiptView,
    )
    def reconcile_subscription_notification(
        workspace_id: str,
        subscription_id: str,
        body: BilibiliNotificationReconciliation,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        current = domain_store.get_subscription(
            organization_id, workspace_id, principal.actor_id, subscription_id
        )
        require_sources(principal, workspace_id, current)
        resolve_owned_profile(
            principal,
            organization_id,
            workspace_id,
            str(current["connectionRef"]),
            str(current["profileRef"]),
        )
        verify_subscription_notification_reconciliation(
            principal, organization_id, workspace_id, current, body
        )
        subscription = domain_store.reconcile_subscription_notification(
            organization_id,
            workspace_id,
            principal.actor_id,
            subscription_id,
            body.expected_version,
            body.model_dump(by_alias=True, exclude={"expected_version"}),
        )
        return {"subscription": subscription}

    @app.post(
        base + "/subscriptions/{subscription_id}/notification-authorization",
        response_model=BilibiliNotificationAuthorizationView,
    )
    def authorize_subscription_notification(
        workspace_id: str,
        subscription_id: str,
        body: BilibiliNotificationAuthorizationRequest,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        if (
            not principal.actor_private_scope
            or not principal.can_write_harness
            or principal.organization_id is None
        ):
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "An actor-private Harness worker is required to authorize notifications.",
            )
        current = domain_store.get_subscription(
            organization_id, workspace_id, principal.actor_id, subscription_id
        )
        require_sources(principal, workspace_id, current)
        resolve_owned_profile(
            principal,
            organization_id,
            workspace_id,
            str(current["connectionRef"]),
            str(current["profileRef"]),
        )
        return domain_store.authorize_subscription_notification(
            organization_id,
            workspace_id,
            principal.actor_id,
            subscription_id,
            body.expected_version,
            body.run_key,
            body.source_output_sha256,
        )

    @app.post(
        base + "/subscriptions/{subscription_id}/transition",
        response_model=BilibiliSubscriptionReceiptView,
    )
    def transition_subscription(
        workspace_id: str,
        subscription_id: str,
        body: BilibiliSubscriptionTransition,
        request: Request,
    ) -> WireView:
        principal, organization_id = actor_scope(request, workspace_id, write=True)
        current = domain_store.get_subscription(
            organization_id, workspace_id, principal.actor_id, subscription_id
        )
        if body.state == "active":
            require_sources(principal, workspace_id, current)
            resolve_owned_profile(
                principal,
                organization_id,
                workspace_id,
                str(current["connectionRef"]),
                str(current["profileRef"]),
            )
        subscription = domain_store.transition_subscription(
            organization_id,
            workspace_id,
            principal.actor_id,
            subscription_id,
            body.expected_version,
            body.state,
            body.next_check_at,
        )
        return {"subscription": subscription}
