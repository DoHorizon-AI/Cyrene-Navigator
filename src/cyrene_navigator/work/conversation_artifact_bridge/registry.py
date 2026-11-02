"""
┌─────────────────────────────────────────────────────────────────────────┐
│ 📄 registry.py                                                          │
│ Module: cyrene_navigator.work.conversation_artifact_bridge.registry     │
│ Role: Bind artifact access to one live signed tool call.                 │
│                                                                         │
│ 模块职责：将附件读写权限绑定到单次、未撤销的签名工具调用。               │
└─────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import uuid4

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_artifact_bridge.models import (
    ArtifactReadGrant,
    ConversationArtifactScope,
)
from cyrene_navigator.work.store import WorkStore

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_READ_ARTIFACT_MIME_TYPES: dict[str, frozenset[str]] = {
    "media.asset.import": frozenset({"image/jpeg", "image/png", "image/webp"}),
    "document.read": frozenset(
        {
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "text/csv",
            "text/html",
            "text/markdown",
            "text/plain",
            "image/png",
            "image/jpeg",
        }
    ),
}
_READ_ARTIFACT_TOOLS = frozenset(_READ_ARTIFACT_MIME_TYPES)
_WRITE_ARTIFACT_MIME_TYPES: dict[str, frozenset[str]] = {
    "media.asset.get": frozenset({"image/jpeg", "image/png", "image/webp"}),
    "media.card.render": frozenset({"image/png"}),
}
_MAX_ACTIVE_CALLS = 2_048
_MAX_CALL_TTL_SECONDS = 180


class ArtifactSourceAuthorizer(Protocol):
    """Recheck current ConversationMemory source epoch and visibility.

    The host adapter should call ``ConversationMemoryStore.authorize_artifact``
    with this exact actor, artifact digest, and captured scope on every read.
    """

    def authorize_artifact(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        artifact_id: str,
        scope: ConversationArtifactScope,
    ) -> Mapping[str, Any]:
        """Return a current ``allowed`` decision and matching authorization epoch."""


@dataclass(slots=True)
class _ActiveCall:
    """Host-only immutable call claims plus a revocation bit."""

    lease_id: str
    request_id: str
    principal: PersistencePrincipal
    workspace_id: str
    binding_id: str
    tool_id: str
    operation_id: str
    arguments_json: str
    caller_context_json: str
    task_id: str | None
    work_operation_id: str | None
    read_grants: Mapping[str, ArtifactReadGrant]
    write_mime_types: frozenset[str]
    expires_at: float
    revoked: bool = False
    output_digests: set[str] = field(default_factory=set)
    pending_output_reservations: set[str] = field(default_factory=set)


@dataclass(frozen=True, slots=True)
class ActiveCallAuthorization:
    """Verified current call authority used by one bridge request."""

    registry: ActiveCallRegistry
    entry: _ActiveCall
    artifact_read_grant: ArtifactReadGrant | None = None
    write_mime_types: frozenset[str] = frozenset()
    write_reservation_id: str | None = None

    @property
    def principal(self) -> PersistencePrincipal:
        return self.entry.principal

    @property
    def workspace_id(self) -> str:
        return self.entry.workspace_id

    def assert_current(self) -> None:
        """Recheck call revocation, lifetime, Task/Operation status, and sources."""

        self.registry._assert_current(self.entry, self.artifact_read_grant)


class ActiveCallLease:
    """One-shot host lease; close it as soon as the provider call returns."""

    def __init__(self, registry: ActiveCallRegistry, entry: _ActiveCall) -> None:
        self._registry = registry
        self._entry = entry
        self._closed = False

    @property
    def request_id(self) -> str:
        return self._entry.request_id

    def close(self) -> None:
        """Revoke this exact request ID so delayed provider calls fail closed."""

        if not self._closed:
            self._registry.revoke(self._entry.request_id, lease_id=self._entry.lease_id)
            self._closed = True

    def __enter__(self) -> ActiveCallLease:
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _traceback: Any) -> None:
        self.close()


class ActiveCallRegistry:
    """Bound temporary plugin file access to a verified Task or Work Operation.

    It stores no attachment bytes or parallel operation ledger. WorkStore remains
    the only source of Task, Operation, and attachment state. Registry entries
    are short lived and contain only in-flight call authority.
    """

    def __init__(
        self,
        store: WorkStore,
        *,
        source_authorizer: ArtifactSourceAuthorizer | None = None,
        clock: Any = time.time,
        max_active_calls: int = _MAX_ACTIVE_CALLS,
        max_call_ttl_seconds: int = _MAX_CALL_TTL_SECONDS,
    ) -> None:
        if not 1 <= max_active_calls <= _MAX_ACTIVE_CALLS:
            raise ValueError("max_active_calls is outside the supported bound")
        if not 1 <= max_call_ttl_seconds <= _MAX_CALL_TTL_SECONDS:
            raise ValueError("max_call_ttl_seconds is outside the supported bound")
        self._store = store
        self._source_authorizer = source_authorizer
        self._clock = clock
        self._max_active_calls = max_active_calls
        self._max_call_ttl_seconds = max_call_ttl_seconds
        self._lock = threading.RLock()
        self._calls: dict[str, _ActiveCall] = {}

    def register_task_call(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        *,
        task_id: str,
        request_id: str,
        binding_id: str,
        tool_id: str,
        operation_id: str,
        arguments: Mapping[str, Any],
        caller_context: Mapping[str, Any],
        read_grants: Sequence[ArtifactReadGrant] = (),
        write_mime_types: Sequence[str] = (),
        ttl_seconds: int = 120,
    ) -> ActiveCallLease:
        """Register a real actor-owned running Task before DirectPluginRuntime.

        The host must call this immediately before the provider invocation and
        close the lease on success, exception, cancellation, or timeout.
        """

        return self._register(
            principal,
            workspace_id,
            request_id=request_id,
            binding_id=binding_id,
            tool_id=tool_id,
            operation_id=operation_id,
            arguments=arguments,
            caller_context=caller_context,
            task_id=task_id,
            work_operation_id=None,
            read_grants=read_grants,
            write_mime_types=write_mime_types,
            ttl_seconds=ttl_seconds,
        )

    def register_operation_call(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        *,
        work_operation_id: str,
        request_id: str,
        binding_id: str,
        tool_id: str,
        operation_id: str,
        arguments: Mapping[str, Any],
        caller_context: Mapping[str, Any],
        read_grants: Sequence[ArtifactReadGrant] = (),
        write_mime_types: Sequence[str] = (),
        ttl_seconds: int = 120,
    ) -> ActiveCallLease:
        """Register one human Work Operation before a provider read/write call."""

        return self._register(
            principal,
            workspace_id,
            request_id=request_id,
            binding_id=binding_id,
            tool_id=tool_id,
            operation_id=operation_id,
            arguments=arguments,
            caller_context=caller_context,
            task_id=None,
            work_operation_id=work_operation_id,
            read_grants=read_grants,
            write_mime_types=write_mime_types,
            ttl_seconds=ttl_seconds,
        )

    def authorize_read(
        self,
        *,
        verified_caller: Any,
        binding_id: str,
        tool_id: str,
        arguments: Mapping[str, Any],
        caller_context: Mapping[str, Any],
        artifact_id: str,
    ) -> ActiveCallAuthorization:
        """Authorize one exact original-input artifact for the live call."""

        if not _SHA256.fullmatch(artifact_id):
            raise _denied()
        entry = self._find_verified_call(
            verified_caller=verified_caller,
            binding_id=binding_id,
            tool_id=tool_id,
            arguments=arguments,
            caller_context=caller_context,
        )
        if tool_id not in _READ_ARTIFACT_TOOLS:
            raise _denied()
        grant = entry.read_grants.get(artifact_id)
        allowed_types = _READ_ARTIFACT_MIME_TYPES[tool_id]
        if (
            grant is None
            or arguments.get(grant.argument_name) != artifact_id
            or not grant.allowed_mime_types.issubset(allowed_types)
        ):
            raise _denied()
        if entry.task_id is not None and grant.kind == "human_selection":
            raise _denied()
        if entry.task_id is None and grant.kind != "human_selection":
            raise _denied()
        self._assert_current(entry, grant)
        return ActiveCallAuthorization(self, entry, artifact_read_grant=grant)

    def authorize_write(
        self,
        *,
        verified_caller: Any,
        binding_id: str,
        tool_id: str,
        arguments: Mapping[str, Any],
        caller_context: Mapping[str, Any],
        mime_type: str,
        size: int,
    ) -> ActiveCallAuthorization:
        """Authorize one bounded output generated by the exact live call."""

        entry = self._find_verified_call(
            verified_caller=verified_caller,
            binding_id=binding_id,
            tool_id=tool_id,
            arguments=arguments,
            caller_context=caller_context,
        )
        allowed_types = entry.write_mime_types
        if (
            tool_id not in _WRITE_ARTIFACT_MIME_TYPES
            or mime_type not in allowed_types
            or mime_type not in _WRITE_ARTIFACT_MIME_TYPES[tool_id]
            or len(entry.output_digests) >= 4
            or isinstance(size, bool)
            or not isinstance(size, int)
            or not 1 <= size <= 10_000_000
        ):
            raise _denied()
        self._assert_current(entry, None)
        reservation_id = uuid4().hex
        with self._lock:
            if self._calls.get(entry.request_id) is not entry or entry.revoked:
                raise _denied()
            if len(entry.output_digests) + len(entry.pending_output_reservations) >= 4:
                raise _denied()
            entry.pending_output_reservations.add(reservation_id)
        return ActiveCallAuthorization(
            self,
            entry,
            write_mime_types=allowed_types,
            write_reservation_id=reservation_id,
        )

    def revoke(self, request_id: str, *, lease_id: str | None = None) -> bool:
        """Revoke one provider call after completion, timeout, or cancellation."""

        with self._lock:
            entry = self._calls.get(request_id)
            if entry is None or (lease_id is not None and entry.lease_id != lease_id):
                return False
            entry.revoked = True
            del self._calls[request_id]
            return True

    def record_output(self, authorization: ActiveCallAuthorization, artifact_id: str) -> None:
        """Count one current-call output artifact without creating a side ledger."""

        reservation_id = authorization.write_reservation_id
        if not _SHA256.fullmatch(artifact_id) or reservation_id is None:
            raise _denied()
        entry = authorization.entry
        authorization.assert_current()
        with self._lock:
            if (
                self._calls.get(entry.request_id) is not entry
                or entry.revoked
                or reservation_id not in entry.pending_output_reservations
            ):
                raise _denied()
            entry.pending_output_reservations.remove(reservation_id)
            if artifact_id not in entry.output_digests and len(entry.output_digests) >= 4:
                raise PersistenceError(
                    "WORK_ARTIFACT_BRIDGE_OUTPUT_LIMIT", 413, "Call output artifact limit reached."
                )
            entry.output_digests.add(artifact_id)

    def release_output(self, authorization: ActiveCallAuthorization) -> None:
        """Release an unconsumed output slot when validation or storage fails."""

        reservation_id = authorization.write_reservation_id
        if reservation_id is None:
            return
        with self._lock:
            authorization.entry.pending_output_reservations.discard(reservation_id)

    def assert_output(self, lease: ActiveCallLease, artifact_id: str) -> None:
        """Require a provider result to reference bytes written during this call."""

        if not _SHA256.fullmatch(artifact_id):
            raise _denied()
        entry = lease._entry
        self._assert_current(entry, None)
        with self._lock:
            if (
                self._calls.get(entry.request_id) is not entry
                or entry.revoked
                or artifact_id not in entry.output_digests
            ):
                raise _denied()

    def assert_call_current(self, lease: ActiveCallLease) -> None:
        """Recheck one Task or Work Operation immediately before host publication."""

        self._assert_current(lease._entry, None)

    def revoke_task_calls(
        self,
        organization_id: str | None,
        workspace_id: str,
        task_id: str,
    ) -> int:
        """Revoke every active call for one server-authorized Task lifecycle event."""

        with self._lock:
            selected = [
                request_id
                for request_id, entry in self._calls.items()
                if entry.principal.organization_id == organization_id
                and entry.workspace_id == workspace_id
                and entry.task_id == task_id
            ]
            for request_id in selected:
                self._calls[request_id].revoked = True
                del self._calls[request_id]
            return len(selected)

    @property
    def active_call_count(self) -> int:
        """Return the bounded number of currently registered in-flight calls."""

        with self._lock:
            self._purge_expired_locked()
            return len(self._calls)

    def _register(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        *,
        request_id: str,
        binding_id: str,
        tool_id: str,
        operation_id: str,
        arguments: Mapping[str, Any],
        caller_context: Mapping[str, Any],
        task_id: str | None,
        work_operation_id: str | None,
        read_grants: Sequence[ArtifactReadGrant],
        write_mime_types: Sequence[str],
        ttl_seconds: int,
    ) -> ActiveCallLease:
        if workspace_id not in principal.workspace_ids or principal.organization_id is None:
            raise _denied()
        if (task_id is None) == (work_operation_id is None):
            raise ValueError("exactly one Task or Work Operation must anchor an artifact call")
        if not 1 <= ttl_seconds <= self._max_call_ttl_seconds:
            raise ValueError("active artifact call TTL is outside the supported bound")
        if not request_id or len(request_id) > 200 or not binding_id or len(binding_id) > 200:
            raise ValueError("active artifact call identity is invalid")
        if not tool_id or len(tool_id) > 200 or operation_id != tool_id:
            raise ValueError("active artifact method and operation must match the fixed tool")
        if not isinstance(arguments, Mapping) or not isinstance(caller_context, Mapping):
            raise ValueError("active artifact call payloads must be objects")
        arguments_json = _canonical_json(arguments)
        caller_context_json = _canonical_json(caller_context)
        _validate_signed_context_claims(
            caller_context,
            arguments=arguments,
            principal=principal,
            workspace_id=workspace_id,
            binding_id=binding_id,
            tool_id=tool_id,
            operation_id=operation_id,
            request_id=request_id,
            now_epoch=self._clock(),
        )
        grants: dict[str, ArtifactReadGrant] = {}
        for grant in read_grants:
            if grant.artifact_id in grants:
                raise ValueError("artifact call contains duplicate read grants")
            if arguments.get(grant.argument_name) != grant.artifact_id:
                raise ValueError("read grant is not bound to the exact tool arguments")
            grants[grant.artifact_id] = _copy_read_grant(grant)
        write_types = frozenset(write_mime_types)
        if tool_id not in _READ_ARTIFACT_TOOLS | frozenset(_WRITE_ARTIFACT_MIME_TYPES):
            raise ValueError("only artifact-capable fixed tools can register artifact calls")
        if read_grants and write_types:
            raise ValueError("one artifact call cannot mix source reads and output writes")
        if any(
            (task_id is None and grant.kind != "human_selection")
            or (task_id is not None and grant.kind == "human_selection")
            for grant in read_grants
        ):
            raise ValueError("artifact grant kind does not match its Task or human operation")
        if write_types and (
            tool_id not in _WRITE_ARTIFACT_MIME_TYPES
            or not write_types.issubset(_WRITE_ARTIFACT_MIME_TYPES[tool_id])
        ):
            raise ValueError("write output policy is outside the fixed media tool map")
        if any(
            not grant.allowed_mime_types.issubset(
                _READ_ARTIFACT_MIME_TYPES.get(tool_id, frozenset())
            )
            for grant in read_grants
        ):
            raise ValueError("read MIME policy is outside the fixed tool map")

        if task_id is not None:
            self._require_running_task(principal, workspace_id, task_id)
        if work_operation_id is not None:
            self._require_started_operation(
                principal,
                workspace_id,
                work_operation_id,
                operation_id,
                arguments,
            )

        expires_at = min(
            self._clock() + ttl_seconds,
            _context_expiry(caller_context),
        )
        if expires_at <= self._clock():
            raise _denied()
        entry = _ActiveCall(
            lease_id=uuid4().hex,
            request_id=request_id,
            principal=principal,
            workspace_id=workspace_id,
            binding_id=binding_id,
            tool_id=tool_id,
            operation_id=operation_id,
            arguments_json=arguments_json,
            caller_context_json=caller_context_json,
            task_id=task_id,
            work_operation_id=work_operation_id,
            read_grants=grants,
            write_mime_types=write_types,
            expires_at=expires_at,
        )
        with self._lock:
            self._purge_expired_locked()
            if request_id in self._calls:
                raise PersistenceError(
                    "WORK_ARTIFACT_CALL_ID_CONFLICT", 409, "Artifact call ID is already active."
                )
            if len(self._calls) >= self._max_active_calls:
                raise PersistenceError(
                    "WORK_ARTIFACT_CALL_CAPACITY", 503, "Artifact call capacity is full.", True
                )
            self._calls[request_id] = entry
        return ActiveCallLease(self, entry)

    def _find_verified_call(
        self,
        *,
        verified_caller: Any,
        binding_id: str,
        tool_id: str,
        arguments: Mapping[str, Any],
        caller_context: Mapping[str, Any],
    ) -> _ActiveCall:
        request_id = caller_context.get("request_id")
        if not isinstance(request_id, str) or not request_id:
            raise _denied()
        with self._lock:
            self._purge_expired_locked()
            entry = self._calls.get(request_id)
        if entry is None or entry.revoked:
            raise _denied()
        if (
            verified_caller.organization_id != entry.principal.organization_id
            or verified_caller.workspace_id != entry.workspace_id
            or verified_caller.actor_id.lower() != entry.principal.actor_id.lower()
            or binding_id != entry.binding_id
            or tool_id != entry.tool_id
            or _canonical_json(arguments) != entry.arguments_json
            or _canonical_json(caller_context) != entry.caller_context_json
        ):
            raise _denied()
        return entry

    def _assert_current(
        self,
        entry: _ActiveCall,
        grant: ArtifactReadGrant | None,
    ) -> None:
        with self._lock:
            if (
                self._calls.get(entry.request_id) is not entry
                or entry.revoked
                or self._clock() >= entry.expires_at
            ):
                raise _denied()
        if entry.task_id is not None:
            self._require_running_task(entry.principal, entry.workspace_id, entry.task_id)
        if entry.work_operation_id is not None:
            self._require_started_operation(
                entry.principal,
                entry.workspace_id,
                entry.work_operation_id,
                entry.operation_id,
                json.loads(entry.arguments_json),
            )
        if grant is not None and grant.kind == "conversation_source":
            if self._source_authorizer is None or grant.source_scope is None:
                raise _denied()
            result = self._source_authorizer.authorize_artifact(
                entry.principal,
                entry.workspace_id,
                grant.artifact_id,
                grant.source_scope,
            )
            allowed = (
                isinstance(result, Mapping)
                and result.get("allowed") is True
                and result.get("currentAuthorizationEpoch")
                == grant.source_scope.authorization_epoch
            )
            if not allowed:
                raise PersistenceError(
                    "WORK_ARTIFACT_SOURCE_REVOKED",
                    409,
                    "The source authorization changed before the artifact read.",
                )

    def _require_running_task(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        task_id: str,
    ) -> None:
        task = self._store.get_task(
            principal.organization_id,
            workspace_id,
            task_id,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        if (
            task.get("status") != "running"
            or str(task.get("createdByActorId") or "").lower() != principal.actor_id.lower()
        ):
            raise _denied()
        origin = task.get("origin")
        if (
            isinstance(origin, Mapping)
            and origin.get("kind") == "teams_private"
            and str(origin.get("actorAadObjectId") or "").lower() != principal.actor_id.lower()
        ):
            raise _denied()

    def _require_started_operation(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        work_operation_id: str,
        operation_id: str,
        arguments: Mapping[str, Any],
    ) -> None:
        operation = self._store.get_operation(
            principal.organization_id,
            workspace_id,
            work_operation_id,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        if (
            operation.get("status") != "started"
            or operation.get("operationType") != f"tool.provider.v1:{operation_id}"
            or operation.get("taskId") is not None
        ):
            raise _denied()
        request = operation.get("request")
        if not isinstance(request, Mapping):
            raise _denied()
        expected_digest = request.get("argumentsSha256")
        actual_digest = canonical_arguments_sha256(arguments)
        if expected_digest != actual_digest:
            raise _denied()
        if request.get("actorScopeSha256") != actor_scope_sha256(principal, workspace_id):
            raise _denied()
        request_tool = request.get("toolId")
        if request_tool != operation_id:
            raise _denied()
        registered_arguments = request.get("arguments")
        if registered_arguments is not None and _canonical_json(
            registered_arguments
        ) != _canonical_json(arguments):
            raise _denied()

    def _purge_expired_locked(self) -> None:
        now = self._clock()
        stale = [
            request_id
            for request_id, entry in self._calls.items()
            if entry.revoked or entry.expires_at <= now
        ]
        for request_id in stale:
            self._calls.pop(request_id, None)


def create_conversation_artifact_registry(
    store: WorkStore,
    *,
    source_authorizer: ArtifactSourceAuthorizer | None = None,
    clock: Any = time.time,
) -> ActiveCallRegistry:
    """Create the sole in-memory registry over the existing WorkStore authority."""

    return ActiveCallRegistry(store, source_authorizer=source_authorizer, clock=clock)


def _validate_signed_context_claims(
    context: Mapping[str, Any],
    *,
    arguments: Mapping[str, Any],
    principal: PersistencePrincipal,
    workspace_id: str,
    binding_id: str,
    tool_id: str,
    operation_id: str,
    request_id: str,
    now_epoch: float,
) -> None:
    if (
        context.get("request_id") != request_id
        or context.get("method") != tool_id
        or context.get("operation_id") != operation_id
        or context.get("binding_id") != binding_id
        or context.get("subject") != principal.actor_id
        or context.get("organization_id") != principal.organization_id
        or context.get("workspace_id") != workspace_id
        or not isinstance(context.get("issuer"), str)
        or not context.get("issuer")
    ):
        raise _denied()
    principal_issuer = getattr(principal, "issuer", None)
    if principal_issuer is not None and context.get("issuer") != principal_issuer:
        raise _denied()
    if (
        not isinstance(context.get("caller_workload"), str)
        or not context.get("caller_workload")
        or not isinstance(context.get("audience"), str)
        or not context.get("audience")
        or not isinstance(context.get("signature"), str)
        or re.fullmatch(r"[0-9a-f]{64}", str(context.get("signature"))) is None
        or context.get("payload_sha256")
        != hashlib.sha256(_canonical_json(arguments).encode("utf-8")).hexdigest()
    ):
        raise _denied()
    expires_at = _context_expiry(context)
    issued_at = _context_issue_time(context)
    if (
        issued_at > now_epoch + 30
        or expires_at <= now_epoch
        or expires_at <= issued_at
        or expires_at - issued_at > 300
    ):
        raise _denied()


def _context_expiry(context: Mapping[str, Any]) -> float:
    value = context.get("expires_at")
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            raise _denied() from None
    else:
        raise _denied()
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise _denied()
    return parsed.astimezone(UTC).timestamp()


def _context_issue_time(context: Mapping[str, Any]) -> float:
    value = context.get("issued_at")
    if not isinstance(value, str):
        raise _denied()
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise _denied() from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise _denied()
    return parsed.astimezone(UTC).timestamp()


def _copy_read_grant(grant: ArtifactReadGrant) -> ArtifactReadGrant:
    """Detach grants from mutable caller-owned mappings before registry storage."""

    source_scope = grant.source_scope
    if source_scope is not None:
        copied_refs = json.loads(_canonical_json(source_scope.source_refs))
        source_scope = ConversationArtifactScope(
            conversation_id=source_scope.conversation_id,
            conversation_kind=source_scope.conversation_kind,
            persona_id=source_scope.persona_id,
            authorization_epoch=source_scope.authorization_epoch,
            source_refs=tuple(copied_refs),
        )
    return ArtifactReadGrant(
        artifact_id=grant.artifact_id,
        kind=grant.kind,
        allowed_mime_types=frozenset(grant.allowed_mime_types),
        source_scope=source_scope,
        argument_name=grant.argument_name,
    )


def _canonical_json(value: Any) -> str:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError, UnicodeError):
        raise _denied() from None
    if len(encoded.encode("utf-8")) > 2_000_000:
        raise _denied()
    return encoded


def canonical_arguments_sha256(arguments: Mapping[str, Any]) -> str:
    """Fingerprint one exact JSON arguments object for the Work Operation record."""

    return hashlib.sha256(_canonical_json(arguments).encode("utf-8")).hexdigest()


def actor_scope_sha256(principal: PersistencePrincipal, workspace_id: str) -> str:
    """Return a non-reversible scope key for matching a Work Operation owner."""

    scope = f"{principal.organization_id or ''}\0{workspace_id}\0{principal.actor_id.lower()}"
    return hashlib.sha256(scope.encode("utf-8")).hexdigest()


def _denied() -> PersistenceError:
    return PersistenceError(
        "WORK_ARTIFACT_BRIDGE_FORBIDDEN",
        403,
        "The artifact is not authorized for the active provider call.",
    )


__all__ = [
    "ActiveCallLease",
    "ActiveCallRegistry",
    "ArtifactSourceAuthorizer",
    "actor_scope_sha256",
    "canonical_arguments_sha256",
    "create_conversation_artifact_registry",
]
