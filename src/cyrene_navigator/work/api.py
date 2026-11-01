"""
Module: cyrene_navigator.work.api
Role: Authenticated HTTP routes for durable Work resources and connector bridges.

模块职责：挂载有授权边界的工作域资源路由与可信连接器桥接路由。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import inspect
import json
import logging
import math
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from fastapi import FastAPI, Header, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse

from cyrene_navigator.persistence.errors import WORKSPACE_FORBIDDEN, PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_memory import ConversationMemoryStore
from cyrene_navigator.work.conversation_memory.domain_api import mount_domain_routes
from cyrene_navigator.work.conversation_memory.domain_models import ActorBackupReceipt, EmptyRequest
from cyrene_navigator.work.conversation_memory.domains import (
    ConversationDomainStore,
    maintenance_task_id,
)
from cyrene_navigator.work.conversation_memory.providers import (
    EmbeddingBatch,
    EmbeddingClient,
    KnowledgeGraphProvider,
    MemoryProvider,
    MemoryProviderHit,
    MemoryProviderScope,
    provider_unavailable,
)
from cyrene_navigator.work.models import (
    ApprovalCreate,
    ApprovalReceipt,
    ApprovalRecord,
    ApprovalResolve,
    AttachmentCreate,
    AttachmentRecord,
    AutomationEventCreate,
    AutomationEventList,
    AutomationEventNoticeIntentCreate,
    AutomationEventNoticeIntentReceipt,
    AutomationEventReceipt,
    BackendSessionBind,
    BackendSessionRecord,
    ConnectorEventCreate,
    ConnectorEventReceipt,
    ConnectorEvents,
    ConnectorList,
    ConnectorRecord,
    ConnectorStatusUpdate,
    ConversationKind,
    ConversationMemoryArtifactAuthorization,
    ConversationMemoryArtifactAuthorizationReceipt,
    ConversationMemoryCreate,
    ConversationMemoryDeleteReceipt,
    ConversationMemoryList,
    ConversationMemoryMessage,
    ConversationMemoryMessageCreate,
    ConversationMemoryMessages,
    ConversationMemoryOverview,
    ConversationMemoryPatch,
    ConversationMemoryQuery,
    ConversationMemoryQueryResult,
    ConversationMemoryReceipt,
    ConversationMemorySourceAuthorization,
    ConversationMemorySourceAuthorizationReceipt,
    ConversationMemorySourceGrantCreate,
    ConversationMemorySourceGrantReceipt,
    ConversationMemorySourceGrantRevocation,
    ConversationMemorySourceRevocationReceipt,
    ConversationMemorySources,
    CredentialHealthSnapshotBatch,
    CredentialHealthSnapshotReceipt,
    ExperimentPut,
    ExperimentRecord,
    InputList,
    InputReceipt,
    InputRecord,
    InputRequestCreate,
    InputResolve,
    MemoryFact,
    MemoryFacts,
    MemoryFactUpsert,
    MemoryQuery,
    NotificationClaim,
    NotificationClaimResult,
    NotificationCreate,
    NotificationFinish,
    NotificationList,
    NotificationQueued,
    NotificationRecord,
    NotificationStart,
    OperationCreate,
    OperationReceipt,
    OperationSummaryList,
    OperationVerify,
    PrivateInstallationEvent,
    PrivateInstallationReceipt,
    PrivateNotificationClaimResult,
    SourceInventoryPage,
    SourceInventoryReceipt,
    SourceList,
    TaskClaimResult,
    TaskContinuationCreate,
    TaskContinuationReceipt,
    TaskCreate,
    TaskEventAppend,
    TaskEventReceipt,
    TaskEvents,
    TaskList,
    TaskPatch,
    TaskRecord,
    TeamsThreadRecord,
    WorkflowDefinition,
    WorkflowList,
    WorkflowNoticeCreate,
    WorkflowScheduleEvent,
    WorkflowScheduleEventList,
    WorkModel,
)
from cyrene_navigator.work.store import PrivateConversationScope, WorkStore
from cyrene_navigator.work.tool_routes import mount_work_tool_routes

WorkAuthenticator = Callable[[Request, str], PersistencePrincipal]
_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class TeamsPrivateConversationPolicy:
    """Server-pinned owner projection and Teams app identity for private delivery."""

    actor_subjects_path: Path
    workspace_id: str
    issuer: str
    tenant_id: str
    bot_app_id: str

    def load_owner_subjects(self, workspace_id: str) -> frozenset[str]:
        """Read the owner projection on every use and fail closed on any mismatch."""

        def denied() -> PersistenceError:
            return PersistenceError(
                "WORK_TEAMS_PRIVATE_INSTALLATION_FORBIDDEN",
                403,
                "The private Teams owner binding is unavailable or unauthorized.",
            )

        if (
            workspace_id != self.workspace_id
            or not self.actor_subjects_path.is_absolute()
            or not self.issuer
            or not self.tenant_id
            or not self.bot_app_id
        ):
            raise denied()
        try:
            raw = self.actor_subjects_path.read_bytes()
            if len(raw) > 1_000_000:
                raise denied()
            document = json.loads(raw)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            raise denied() from None
        if not isinstance(document, dict) or set(document) != {
            "schemaVersion",
            "workspaceId",
            "issuer",
            "subjects",
        }:
            raise denied()
        expected_issuer = f"https://login.microsoftonline.com/{self.tenant_id}/v2.0"
        if (
            type(document.get("schemaVersion")) is not int
            or document.get("schemaVersion") != 1
            or document.get("workspaceId") != self.workspace_id
            or document.get("issuer") != self.issuer
            or self.issuer != expected_issuer
            or not _is_uuid(self.tenant_id)
            or not _is_uuid(self.bot_app_id)
        ):
            raise denied()
        subjects = document.get("subjects")
        if not isinstance(subjects, list) or not subjects or len(subjects) > 10_000:
            raise denied()
        normalized: set[str] = set()
        for subject in subjects:
            if not isinstance(subject, str) or not _is_uuid(subject):
                raise denied()
            normalized.add(subject.lower())
        if len(normalized) != len(subjects):
            raise denied()
        return frozenset(normalized)

    def load_scope(self, workspace_id: str) -> PrivateConversationScope:
        """Return the current projection and pinned route identity for one operation."""

        return PrivateConversationScope(
            workspace_id=workspace_id,
            issuer=self.issuer,
            tenant_id=self.tenant_id.lower(),
            bot_app_id=self.bot_app_id.lower(),
            owner_subjects=self.load_owner_subjects(workspace_id),
        )

    def validate_trust(self, workspace_id: str, trust: Mapping[str, Any]) -> dict[str, str]:
        """Validate one HMAC-relayed install identity against current server state."""

        subjects = self.load_owner_subjects(workspace_id)
        actor = trust.get("actorAadObjectId")
        tenant = trust.get("tenantId")
        bot_app = trust.get("botAppId")
        service_url = trust.get("serviceUrl")
        activity_occurred_at = trust.get("activityOccurredAt")
        if (
            trust.get("version") != 1
            or trust.get("provider") != "teams"
            or trust.get("conversationKind") != "private"
            or not isinstance(actor, str)
            or not _is_uuid(actor)
            or actor.lower() not in subjects
            or not isinstance(tenant, str)
            or tenant.lower() != self.tenant_id.lower()
            or not isinstance(bot_app, str)
            or bot_app.lower() != self.bot_app_id.lower()
            or not isinstance(service_url, str)
            or not isinstance(activity_occurred_at, str)
        ):
            raise PersistenceError(
                "WORK_TEAMS_PRIVATE_INSTALLATION_FORBIDDEN",
                403,
                "The private Teams owner binding is unavailable or unauthorized.",
            )
        from cyrene_navigator.work.store import _teams_service_url

        try:
            normalized_service_url = _teams_service_url(service_url, self.tenant_id.lower())
        except PersistenceError:
            raise PersistenceError(
                "WORK_TEAMS_PRIVATE_INSTALLATION_FORBIDDEN",
                403,
                "The private Teams owner binding is unavailable or unauthorized.",
            ) from None
        return {
            "tenantId": self.tenant_id.lower(),
            "actorAadObjectId": actor.lower(),
            "botAppId": self.bot_app_id.lower(),
            "conversationId": str(trust.get("conversationId") or ""),
            "activityId": str(trust.get("activityId") or ""),
            "activityOccurredAt": activity_occurred_at,
            "serviceUrl": normalized_service_url,
            "installationAction": str(trust.get("installationAction") or ""),
        }


def _is_uuid(value: str) -> bool:
    """Recognize one hyphenated UUID without normalization side effects."""

    return (
        re.fullmatch(
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
            value,
        )
        is not None
    )


class ConnectorBridge(Protocol):
    """Trusted, administrator-configured bridge for one local connector binding."""

    def health(self) -> Any | Awaitable[Any]:
        """Probe the configured connector host without accepting browser host details."""

    def request_qr(self, params: Mapping[str, Any]) -> Any | Awaitable[Any]:
        """Request a login QR from the trusted configured host."""

    def poll_login(self, params: Mapping[str, Any]) -> Any | Awaitable[Any]:
        """Poll a login id for the configured account and host."""


def mount_work_routes(
    app: FastAPI,
    db_path: Path,
    authenticate: WorkAuthenticator,
    *,
    attachment_root: Path | None = None,
    connector_bridges: Mapping[tuple[str | None, str, str], ConnectorBridge] | None = None,
    private_conversation_policy: TeamsPrivateConversationPolicy | None = None,
    embedding_client: EmbeddingClient | None = None,
    memory_provider: MemoryProvider | None = None,
    graph_provider: KnowledgeGraphProvider | None = None,
    summarizer_available: bool = False,
) -> WorkStore:
    """Mount authenticated Work routes on an existing persistence app.

    Mutations use the existing PersistencePrincipal and require the trusted writer
    context. Reads remain limited to the authenticated Workspace. 连接器登录路由
    只访问启动器配置的本地桥接器,不会接受浏览器传入的主机或账号。
    """

    store = WorkStore(db_path, attachment_root)
    conversation_memory = ConversationMemoryStore(
        Path(f"{db_path}.conversation-memory.sqlite3").absolute()
    )
    conversation_domains = ConversationDomainStore(
        Path(f"{db_path}.conversation-domains.sqlite3").absolute()
    )
    bridges = dict(connector_bridges or {})
    for organization_id, workspace_id, binding_id in bridges:
        store.seed_connector_binding(organization_id, workspace_id, binding_id)
    app.state.work_store = store
    app.state.work_conversation_memory = conversation_memory
    app.state.work_conversation_domains = conversation_domains
    app.state.work_memory_embedding_client = embedding_client
    app.state.work_memory_provider = memory_provider
    app.state.work_graph_provider = graph_provider
    app.state.work_conversation_summarizer_available = summarizer_available
    app.state.work_connector_bridges = bridges
    app.state.work_private_conversation_policy = private_conversation_policy
    base = "/api/v1/workspaces/{workspace_id}/work"
    conversation_base = base + "/conversation-memory"
    mount_work_tool_routes(app, authenticate, bridges)

    def principal_for(
        request: Request, workspace_id: str, *, write: bool = False
    ) -> PersistencePrincipal:
        """Authenticate Workspace scope and require write authority for mutations."""

        principal = authenticate(request, workspace_id)
        if write and principal.organization_id is not None and not principal.can_takeover:
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "A trusted Workspace writer principal is required for Work mutations.",
            )
        return principal

    def validate_domain_sources(
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str | None,
        conversation_kind: str | None,
        persona_id: str | None,
        source_ids: Sequence[str],
    ) -> None:
        """Validate every domain source in current actor, conversation, and persona scope."""

        conversation_memory.validate_source_message_ids(
            organization_id,
            workspace_id,
            actor_id,
            conversation_id,
            conversation_kind,
            persona_id,
            source_ids,
        )

    def validate_domain_source_refs(
        organization_id: str | None,
        workspace_id: str,
        actor_id: str,
        conversation_id: str | None,
        conversation_kind: str | None,
        persona_id: str | None,
        source_refs: Sequence[Mapping[str, object]],
    ) -> None:
        """Reauthorize full message and memory-version lineage at the current epoch."""

        if not source_refs:
            return
        if conversation_id is None or conversation_kind not in {"direct", "group", "channel"}:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_SOURCE_UNAVAILABLE",
                409,
                "Derived source references require a trusted conversation scope.",
            )
        current = conversation_memory.overview(organization_id, workspace_id, actor_id)
        decision = conversation_memory.authorize_sources(
            organization_id,
            workspace_id,
            actor_id,
            conversation_id,
            int(current["authorizationEpoch"]),
            list(source_refs),
            conversation_kind=conversation_kind,
            persona_id=persona_id,
        )
        if decision.get("allowed") is not True:
            raise PersistenceError(
                "CONVERSATION_DOMAIN_SOURCE_UNAVAILABLE",
                409,
                "A derived record source is revoked, stale, or outside its authorized scope.",
            )

    mount_domain_routes(
        app,
        conversation_base,
        principal_for,
        conversation_domains,
        validate_source_refs=validate_domain_source_refs,
    )

    @app.post(
        conversation_base + "/backups",
        response_model=ActorBackupReceipt,
        status_code=201,
    )
    def create_conversation_memory_backup(
        workspace_id: str,
        _body: EmptyRequest,
        request: Request,
    ) -> dict[str, Any]:
        """Create a bounded actor-private export of both conversation stores."""

        principal = principal_for(request, workspace_id, write=True)
        try:
            memory_export = json.loads(
                conversation_memory.export_actor_backup(
                    principal.organization_id, workspace_id, principal.actor_id
                )
            )
            domain_export = json.loads(
                conversation_domains.export_actor_backup(
                    principal.organization_id
                    or "legacy-"
                    + hashlib.sha256(
                        f"{workspace_id}\0{principal.actor_id}".encode()
                    ).hexdigest()[:32],
                    workspace_id,
                    principal.actor_id,
                )
            )
        except PersistenceError:
            raise
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PersistenceError(
                "CONVERSATION_MEMORY_BACKUP_INVALID",
                500,
                "An actor backup component returned invalid JSON.",
            ) from exc
        payload = {
            "schemaVersion": 1,
            "createdAt": int(time.time() * 1_000),
            "scopeDigest": hashlib.sha256(
                json.dumps(
                    [principal.organization_id or "", workspace_id, principal.actor_id],
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest(),
            "conversationMemory": memory_export,
            "conversationDomains": domain_export,
        }
        content = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if not content or len(content) > 10_000_000:
            raise PersistenceError(
                "CONVERSATION_MEMORY_BACKUP_TOO_LARGE",
                413,
                "Combined actor backup exceeds 10 MB.",
            )
        attachment = store.put_attachment(
            principal.organization_id,
            workspace_id,
            "conversation-memory-backup.json",
            "application/json",
            content,
            actor_id=principal.actor_id,
            actor_private_scope=True,
        )
        return {
            "artifactId": attachment["id"],
            "sha256": attachment["sha256"],
            "size": attachment["size"],
            "mimeType": "application/json",
        }

    def require_private_work_owner(request: Request, workspace_id: str) -> PersistencePrincipal:
        """Require owner authority and an organization for private Work indexes.

        中文：校验私有索引 owner。
        """

        principal = authenticate(request, workspace_id)
        if not principal.can_takeover or principal.organization_id is None:
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "An organization-scoped Workspace owner principal is required.",
            )
        return principal

    def require_private_installation_bridge(
        request: Request, workspace_id: str
    ) -> tuple[PersistencePrincipal, TeamsPrivateConversationPolicy]:
        """Require the dedicated least-privilege Teams bridge and its owner policy."""

        principal = authenticate(request, workspace_id)
        policy = private_conversation_policy
        if (
            not principal.can_bind_teams_private_conversations
            or principal.organization_id is None
            or policy is None
        ):
            raise PersistenceError(
                "WORK_TEAMS_PRIVATE_INSTALLATION_FORBIDDEN",
                403,
                "The private Teams owner binding is unavailable or unauthorized.",
            )
        return principal, policy

    def require_bridge_owner(request: Request, workspace_id: str) -> PersistencePrincipal:
        """Restrict connector QR and login polling to trusted owners. | 限制二维码与登录操作。"""

        principal = authenticate(request, workspace_id)
        if not principal.can_takeover:
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "A trusted Workspace owner principal is required for connector login operations.",
            )
        return principal

    def require_native_session_owner(request: Request, workspace_id: str) -> PersistencePrincipal:
        """Keep native ACP session IDs behind the trusted Work writer.

        中文：仅可信宿主可以读取或写入原生 ACP Session ID。
        """

        principal = authenticate(request, workspace_id)
        if not principal.can_takeover:
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "A trusted Workspace owner principal is required for native session mappings.",
            )
        return principal

    def optional_private_scope(workspace_id: str) -> PrivateConversationScope | None:
        """Read the current owner projection without failing a completed task write.

        A missing or invalid private policy holds the private delivery in Work; it
        never changes the task's terminal transition or enables a channel fallback.
        """

        if private_conversation_policy is None:
            return None
        try:
            return private_conversation_policy.load_scope(workspace_id)
        except PersistenceError:
            return None

    def require_credential_health_publisher(
        request: Request, workspace_id: str
    ) -> PersistencePrincipal:
        """Require the explicit host credential-health publication grant.

        This route accepts only Exchange's bounded health projection; it cannot
        choose a Teams destination or enqueue arbitrary connector messages.
        中文：仅允许配置了专用权限的可信宿主提交授权健康快照。
        """

        principal = authenticate(request, workspace_id)
        if not principal.can_publish_credential_health or principal.organization_id is None:
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "A trusted Workspace credential-health publisher is required.",
            )
        return principal

    def require_bridge(
        principal: PersistencePrincipal, workspace_id: str, binding_id: str
    ) -> ConnectorBridge:
        """Resolve only a bridge installed by the trusted host configuration."""

        bridge = bridges.get((principal.organization_id, workspace_id, binding_id))
        if bridge is None:
            raise PersistenceError(
                "QQ_HOST_NOT_CONFIGURED",
                503,
                "No trusted connector bridge is configured for this binding.",
                retryable=True,
            )
        return bridge

    @app.post(
        base + "/automation-events",
        response_model=AutomationEventReceipt,
        status_code=201,
    )
    def append_automation_event(
        workspace_id: str,
        body: AutomationEventCreate,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        """Append one immutable source observation for the authenticated owner actor.

        中文：actor、组织、工作区和可见性均由已认证 owner 身份派生。
        """

        principal = require_private_work_owner(request, workspace_id)
        event, duplicate = store.append_automation_event(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            body.model_dump(by_alias=True, exclude_none=True),
        )
        if duplicate:
            response.status_code = 200
        return {**event, "duplicate": duplicate}

    @app.post(
        base + "/automation-events/{event_id}/notices",
        response_model=AutomationEventNoticeIntentReceipt,
        status_code=201,
    )
    def decide_automation_event_notice(
        workspace_id: str,
        event_id: str,
        body: AutomationEventNoticeIntentCreate,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        """Persist one actor-owned event decision and any eligible outbox item atomically."""

        principal = require_private_work_owner(request, workspace_id)
        private_scope = (
            private_conversation_policy.load_scope(workspace_id)
            if private_conversation_policy is not None
            else None
        )
        receipt, duplicate = store.enqueue_automation_event_notice(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            event_id,
            body.model_dump(by_alias=True, exclude_none=True),
            private_scope=private_scope,
        )
        if duplicate:
            response.status_code = 200
        return {**receipt, "duplicate": duplicate}

    @app.post(
        base + "/private-installations/events",
        response_model=PrivateInstallationReceipt,
    )
    def register_private_installation_event(
        workspace_id: str,
        body: PrivateInstallationEvent,
        request: Request,
    ) -> dict[str, Any]:
        """Record or revoke a Teams route from the separately authenticated bridge.

        中文：仅接受 DSH 校验 HMAC/SDK 后，由专用 bridge Bearer 转发的路由事实。
        """

        principal, policy = require_private_installation_bridge(request, workspace_id)
        trust = policy.validate_trust(
            workspace_id,
            body.trust.model_dump(by_alias=True, exclude_none=True),
        )
        receipt, duplicate = store.apply_private_installation(
            principal.organization_id,
            workspace_id,
            body.payload.action,
            trust,
        )
        return {**receipt, "duplicate": duplicate}

    @app.get(base + "/automation-events", response_model=AutomationEventList)
    def list_automation_events(
        workspace_id: str,
        request: Request,
        limit: int = Query(default=50, ge=1, le=100),
        cursor: str | None = Query(default=None, max_length=2_000),
    ) -> dict[str, Any]:
        """List only observations owned by the authenticated actor. | 只读取本人事件。"""

        principal = require_private_work_owner(request, workspace_id)
        return store.list_automation_events(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            limit=limit,
            cursor=cursor,
        )

    @app.get(base + "/experiments/{experiment_id}", response_model=ExperimentRecord)
    def get_experiment(
        workspace_id: str,
        experiment_id: str,
        request: Request,
    ) -> dict[str, Any]:
        """Read one owner-scoped reference-only experiment index. | 读取本人实验引用索引。"""

        principal = require_private_work_owner(request, workspace_id)
        return store.get_experiment(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            experiment_id,
        )

    @app.put(base + "/experiments/{experiment_id}", response_model=ExperimentRecord)
    def put_experiment(
        workspace_id: str,
        experiment_id: str,
        body: ExperimentPut,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        """Replace Product reference links using an expected-revision check. | 更新引用索引。"""

        principal = require_private_work_owner(request, workspace_id)
        record, created, _duplicate = store.put_experiment(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            experiment_id,
            body.model_dump(by_alias=True, exclude_none=True),
        )
        if created:
            response.status_code = 201
        return record

    @app.post(base + "/tasks", response_model=TaskRecord, status_code=201)
    def create_task(
        workspace_id: str, body: TaskCreate, request: Request, response: Response
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        if (
            body.execution_class == "background"
            and body.metadata.get("source") == "conversation-maintenance"
        ):
            if (
                not principal.can_write_harness
                or not principal.actor_private_scope
                or principal.organization_id is None
            ):
                raise PersistenceError(
                    WORKSPACE_FORBIDDEN,
                    403,
                    "A trusted actor-private Harness worker principal is required for "
                    "conversation maintenance tasks.",
                )
            metadata = body.metadata
            job_id = metadata.get("maintenanceJobId")
            task_id = maintenance_task_id(workspace_id, principal.actor_id, str(job_id))
            if body.id != task_id or body.session_id != task_id:
                raise PersistenceError(
                    "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                    409,
                    "Conversation maintenance Task identity must derive from its durable job.",
                )
            job = conversation_domains.get_maintenance_job(
                principal.organization_id,
                workspace_id,
                principal.actor_id,
                str(job_id),
            )
            if (
                job.get("taskId") != task_id
                or metadata.get("workspaceId") != workspace_id
                or metadata.get("actorId") != principal.actor_id
                or metadata.get("kind") != job.get("kind")
                or metadata.get("idempotencyKey") != job.get("idempotencyKey")
            ):
                raise PersistenceError(
                    "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                    403,
                    "Conversation maintenance Task does not match the durable actor job.",
                )
            try:
                prior_task = store.get_task(
                    principal.organization_id,
                    workspace_id,
                    task_id,
                    actor_id=principal.actor_id,
                    actor_private_scope=True,
                )
            except PersistenceError as exc:
                if exc.status != 404 or exc.code != "WORK_TASK_NOT_FOUND":
                    raise
                prior_task = None
            if prior_task is None:
                if (
                    job.get("state") != "queued"
                    or metadata.get("jobVersion") != job.get("version")
                ):
                    raise PersistenceError(
                        "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                        409,
                        "A new maintenance Task must match the queued job version.",
                    )
            elif (
                prior_task.get("createdByActorId") != principal.actor_id
                or prior_task.get("metadata") != dict(metadata)
            ):
                raise PersistenceError(
                    "WORK_TASK_BACKGROUND_PROVENANCE_REQUIRED",
                    409,
                    "Existing maintenance Task provenance does not match this request.",
                )
        record, duplicate = store.create_task(
            principal.organization_id,
            workspace_id,
            body.model_dump(by_alias=True, exclude_none=True),
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        if duplicate:
            response.status_code = 200
        return record

    @app.post(
        base + "/tasks/{task_id}/resume/check",
        status_code=204,
    )
    def verify_task_continuation_owner(
        workspace_id: str,
        task_id: str,
        request: Request,
    ) -> Response:
        """Check ownership before Navigator uses the stored DSH session identity.

        Args:
            workspace_id: Authenticated Workspace from the route.
            task_id: Paused source task identifier.
            request: Bearer-authenticated Work request.
        Returns:
            An empty 204 response after actor and status validation.

        中文：在访问 Exchange 前验证当前 persistence principal 对源任务的所有权。
        """

        principal = principal_for(request, workspace_id, write=True)
        store.verify_task_continuation_owner(
            principal.organization_id,
            workspace_id,
            task_id,
            principal.actor_id,
        )
        return Response(status_code=204)

    @app.post(
        base + "/tasks/{task_id}/resume",
        response_model=TaskContinuationReceipt,
        status_code=201,
    )
    def create_task_continuation(
        workspace_id: str,
        task_id: str,
        body: TaskContinuationCreate,
        request: Request,
        response: Response,
        idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=200),
    ) -> dict[str, Any]:
        """Create an atomic, actor-owned, read-only child of a paused task.

        Args:
            workspace_id: Authenticated Workspace from the route.
            task_id: Paused source task identifier.
            body: New prompt only; source identity and continuation mode are server-derived.
            request: Bearer-authenticated Work request.
            response: Response whose status distinguishes creation from replay.
            idempotency_key: Stable client key for this continuation request.
        Returns:
            The atomically created TaskRecord and replay indicator.

        中文：服务端从调用者与源任务派生 Session、父任务关系和只读模式。
        """

        principal = principal_for(request, workspace_id, write=True)
        task, duplicate = store.create_task_continuation(
            principal.organization_id,
            workspace_id,
            task_id,
            principal.actor_id,
            body.prompt,
            idempotency_key,
        )
        if duplicate:
            response.status_code = 200
        return {"task": task, "duplicate": duplicate}

    @app.get(base + "/tasks", response_model=TaskList)
    def list_tasks(
        workspace_id: str,
        request: Request,
        limit: int = Query(default=50, ge=1, le=100),
        cursor: str | None = Query(default=None, max_length=2_000),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        items, next_cursor = store.list_tasks(
            principal.organization_id,
            workspace_id,
            limit=limit,
            cursor=cursor,
            request_actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        return {"items": items, "nextCursor": next_cursor}

    @app.get(base + "/tasks/owned", response_model=TaskList)
    def list_owned_tasks(
        workspace_id: str,
        request: Request,
        limit: int = Query(default=50, ge=1, le=100),
        cursor: str | None = Query(default=None, max_length=2_000),
    ) -> dict[str, Any]:
        """List recovery tasks only for the server-derived Work actor. | 按 actor 恢复任务。"""

        principal = require_private_work_owner(request, workspace_id)
        items, next_cursor = store.list_tasks(
            principal.organization_id,
            workspace_id,
            limit=limit,
            cursor=cursor,
            created_by_actor_id=principal.actor_id,
            request_actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        return {"items": items, "nextCursor": next_cursor}

    @app.get(base + "/tasks/{task_id}", response_model=TaskRecord)
    def get_task(workspace_id: str, task_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return store.get_task(
            principal.organization_id,
            workspace_id,
            task_id,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )

    @app.get(
        base + "/tasks/{task_id}/backend-session",
        response_model=BackendSessionRecord | None,
    )
    def get_backend_session(
        workspace_id: str,
        task_id: str,
        request: Request,
        backend: str = Query(min_length=1, max_length=64),
    ) -> dict[str, Any] | None:
        principal = require_native_session_owner(request, workspace_id)
        return store.get_backend_session(
            principal.organization_id,
            workspace_id,
            task_id,
            backend,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )

    @app.put(
        base + "/tasks/{task_id}/backend-session",
        response_model=BackendSessionRecord,
    )
    def bind_backend_session(
        workspace_id: str,
        task_id: str,
        body: BackendSessionBind,
        request: Request,
    ) -> dict[str, Any]:
        principal = require_native_session_owner(request, workspace_id)
        return store.bind_backend_session(
            principal.organization_id,
            workspace_id,
            task_id,
            body.backend,
            body.native_session_id,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )

    @app.patch(base + "/tasks/{task_id}", response_model=TaskRecord)
    def patch_task(
        workspace_id: str, task_id: str, body: TaskPatch, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        patch = body.model_dump(by_alias=True, exclude_unset=True)
        private_scope = (
            optional_private_scope(workspace_id)
            if patch.get("status") in {"completed", "failed", "aborted"}
            else None
        )
        return store.patch_task(
            principal.organization_id,
            workspace_id,
            task_id,
            patch,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
            private_scope=private_scope,
        )

    @app.post(base + "/tasks/{task_id}/claim", response_model=TaskClaimResult)
    def claim_task(workspace_id: str, task_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        claimed, task = store.claim_task(
            principal.organization_id,
            workspace_id,
            task_id,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        return {"claimed": claimed, "task": task}

    @app.get(base + "/tasks/{task_id}/events", response_model=TaskEvents)
    def get_task_events(
        workspace_id: str,
        task_id: str,
        request: Request,
        after: int = Query(default=0, ge=0),
        limit: int = Query(default=1_000, ge=1, le=10_000),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        events, next_seq = store.get_task_events(
            principal.organization_id,
            workspace_id,
            task_id,
            after,
            limit,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        return {"events": events, "nextSeq": next_seq}

    @app.post(base + "/tasks/{task_id}/events", response_model=TaskEventReceipt)
    def append_task_event(
        workspace_id: str, task_id: str, body: TaskEventAppend, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        seq, event, duplicate, task, created_at = store.append_task_event(
            principal.organization_id,
            workspace_id,
            task_id,
            body.event,
            body.message_id,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        return {
            "seq": seq,
            "event": event,
            "createdAt": created_at,
            "duplicate": duplicate,
            "task": task,
        }

    @app.post(
        base + "/tasks/{task_id}/approvals",
        response_model=ApprovalReceipt,
        status_code=201,
    )
    def create_approval(
        workspace_id: str,
        task_id: str,
        body: ApprovalCreate,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        approval, task, duplicate = store.create_approval(
            principal.organization_id,
            workspace_id,
            task_id,
            body.model_dump(by_alias=True, exclude_none=True),
            principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        if duplicate:
            response.status_code = 200
        return {"approval": approval, "task": task, "duplicate": duplicate}

    @app.get(base + "/approvals", response_model=list[ApprovalRecord])
    def list_approvals(
        workspace_id: str,
        request: Request,
        status: str | None = Query(default=None),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> list[dict[str, Any]]:
        principal = principal_for(request, workspace_id)
        return store.list_approvals(
            principal.organization_id,
            workspace_id,
            status,
            limit,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )

    @app.get(base + "/approvals/{approval_id}", response_model=ApprovalRecord)
    def get_approval(workspace_id: str, approval_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return store.get_approval(
            principal.organization_id,
            workspace_id,
            approval_id,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )

    @app.post(base + "/approvals/{approval_id}/resolve", response_model=ApprovalReceipt)
    def resolve_approval(
        workspace_id: str,
        approval_id: str,
        body: ApprovalResolve,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        private_scope = (
            optional_private_scope(workspace_id) if body.decision == "rejected" else None
        )
        approval, task, duplicate = store.resolve_approval(
            principal.organization_id,
            workspace_id,
            approval_id,
            body.decision,
            body.message_id,
            principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
            private_scope=private_scope,
        )
        return {"approval": approval, "task": task, "duplicate": duplicate}

    @app.post(
        base + "/tasks/{task_id}/inputs",
        response_model=InputReceipt,
        status_code=201,
    )
    def create_input_request(
        workspace_id: str,
        task_id: str,
        body: InputRequestCreate,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        input_record, task, duplicate = store.create_input_request(
            principal.organization_id,
            workspace_id,
            task_id,
            body.model_dump(by_alias=True, exclude_none=True),
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        if duplicate:
            response.status_code = 200
        return {"input": input_record, "task": task, "duplicate": duplicate}

    @app.get(base + "/inputs", response_model=InputList)
    def list_input_requests(
        workspace_id: str,
        request: Request,
        status: str | None = Query(default=None),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {
            "items": store.list_input_requests(
                principal.organization_id,
                workspace_id,
                status,
                limit,
                actor_id=principal.actor_id,
                actor_private_scope=principal.actor_private_scope,
            )
        }

    @app.get(base + "/inputs/{input_id}", response_model=InputRecord)
    def get_input_request(workspace_id: str, input_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return store.get_input_request(
            principal.organization_id,
            workspace_id,
            input_id,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )

    @app.post(base + "/inputs/{input_id}/resolve", response_model=InputReceipt)
    def resolve_input_request(
        workspace_id: str,
        input_id: str,
        body: InputResolve,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        input_record, task, duplicate = store.resolve_input_request(
            principal.organization_id,
            workspace_id,
            input_id,
            body.answer,
            body.message_id,
            principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        return {"input": input_record, "task": task, "duplicate": duplicate}

    @app.post(base + "/operations", response_model=OperationReceipt, status_code=201)
    def create_operation(
        workspace_id: str, body: OperationCreate, request: Request, response: Response
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        operation, duplicate = store.create_operation(
            principal.organization_id,
            workspace_id,
            body.model_dump(by_alias=True, exclude_none=True),
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        if duplicate:
            response.status_code = 200
        return {"operation": operation, "duplicate": duplicate}

    @app.get(base + "/operations/unresolved", response_model=OperationSummaryList)
    def list_unresolved_operations(
        workspace_id: str,
        request: Request,
        target: str | None = Query(default=None, max_length=2_000),
        operation_type: str | None = Query(default=None, max_length=128),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {
            "items": store.list_unresolved_operations(
                principal.organization_id,
                workspace_id,
                target=target,
                operation_type=operation_type,
                limit=limit,
                actor_id=principal.actor_id,
                actor_private_scope=principal.actor_private_scope,
            )
        }

    @app.get(base + "/operations/{operation_id}", response_model=OperationReceipt)
    def get_operation(workspace_id: str, operation_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {
            "operation": store.get_operation(
                principal.organization_id,
                workspace_id,
                operation_id,
                actor_id=principal.actor_id,
                actor_private_scope=principal.actor_private_scope,
            )
        }

    @app.patch(base + "/operations/{operation_id}", response_model=OperationReceipt)
    def update_operation(
        workspace_id: str,
        operation_id: str,
        body: OperationVerify,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        operation, duplicate = store.update_operation(
            principal.organization_id,
            workspace_id,
            operation_id,
            body.status,
            body.evidence,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        return {"operation": operation, "duplicate": duplicate}

    @app.post(base + "/memory/facts", response_model=MemoryFact)
    def upsert_memory_fact(
        workspace_id: str, body: MemoryFactUpsert, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        return store.upsert_memory_fact(
            principal.organization_id,
            workspace_id,
            body.model_dump(by_alias=True, exclude_none=True),
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )

    @app.get(base + "/memory/facts", response_model=MemoryFacts)
    def list_memory_facts(
        workspace_id: str,
        request: Request,
        include_stale: bool = Query(default=True),
        limit: int = Query(default=500, ge=1, le=1_000),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {
            "items": store.list_memory_facts(
                principal.organization_id,
                workspace_id,
                include_stale=include_stale,
                limit=limit,
                actor_id=principal.actor_id,
                actor_private_scope=principal.actor_private_scope,
            )
        }

    @app.post(base + "/memory/query", response_model=MemoryFacts)
    def query_memory(workspace_id: str, body: MemoryQuery, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {
            "items": store.query_memory(
                principal.organization_id,
                workspace_id,
                body.query,
                limit=body.limit,
                include_stale=body.include_stale,
                actor_id=principal.actor_id,
                actor_private_scope=principal.actor_private_scope,
            )
        }

    def index_conversation_memory(
        workspace_id: str, principal: PersistencePrincipal, memory_id: str
    ) -> dict[str, Any]:
        """Index a durable product record through the configured real providers."""

        current = conversation_memory.get_memory_for_index(
            principal.organization_id, workspace_id, principal.actor_id, memory_id
        )
        provider = memory_provider
        embeddings = embedding_client
        if provider is None or embeddings is None:
            return conversation_memory.set_index_state(
                principal.organization_id,
                workspace_id,
                principal.actor_id,
                memory_id,
                int(current["version"]),
                "unavailable",
            )
        try:
            batch: EmbeddingBatch = embeddings.embed(
                [str(current["text"])], purpose="document"
            )
            if len(batch.vectors) != 1:
                raise provider_unavailable(
                    "MEMORY_EMBEDDING_RESPONSE_INVALID",
                    "The configured embedding provider returned an unexpected vector count.",
                )
            scope = current["scope"]
            if not isinstance(scope, Mapping):
                raise provider_unavailable(
                    "MEMORY_RECORD_INVALID", "The stored memory scope is unavailable."
                )
            provider.upsert(
                memory_id=memory_id,
                text=str(current["text"]),
                embedding=batch.vectors[0],
                model=batch.model,
                dimensions=batch.dimensions,
                scope=MemoryProviderScope(
                    organization_id=principal.organization_id,
                    workspace_id=workspace_id,
                    actor_id=principal.actor_id,
                    conversation_id=str(scope["conversationId"]),
                    conversation_kind=str(scope["conversationKind"]),
                    persona_id=str(scope["personaId"]) if scope["personaId"] is not None else None,
                    visibility=str(scope["visibility"]),
                ),
                authorization_epoch=int(current["authorizationEpoch"]),
            )
        except PersistenceError:
            conversation_memory.set_index_state(
                principal.organization_id,
                workspace_id,
                principal.actor_id,
                memory_id,
                int(current["version"]),
                "failed",
            )
            raise
        except Exception as exc:
            conversation_memory.set_index_state(
                principal.organization_id,
                workspace_id,
                principal.actor_id,
                memory_id,
                int(current["version"]),
                "failed",
            )
            raise provider_unavailable(
                "MEMORY_PROVIDER_UNAVAILABLE",
                "The configured memory provider could not index this record.",
            ) from exc
        return conversation_memory.set_index_state(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            memory_id,
            int(current["version"]),
            "indexed",
        )

    @app.get(conversation_base + "/overview", response_model=ConversationMemoryOverview)
    def conversation_memory_overview(workspace_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        overview = conversation_memory.overview(
            principal.organization_id, workspace_id, principal.actor_id
        )
        overview["capabilities"] = {
            "memoryProvider": "ready"
            if memory_provider is not None and embedding_client is not None
            else "unavailable",
            "summarizer": "ready" if summarizer_available else "unavailable",
        }
        return overview

    @app.get(conversation_base + "/messages", response_model=ConversationMemoryMessages)
    def list_conversation_messages(
        workspace_id: str,
        request: Request,
        conversation_id: str = Query(alias="conversationId", min_length=1, max_length=512),
        conversation_kind: ConversationKind = Query(alias="conversationKind"),  # noqa: B008
        persona_id: str | None = Query(default=None, alias="personaId", max_length=512),
        order: str = Query(default="desc", pattern="^(asc|desc)$"),
        limit: int = Query(default=50, ge=1, le=100),
        cursor: str | None = Query(default=None, max_length=600),
        include_revoked: bool = Query(default=False, alias="includeRevoked"),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return conversation_memory.list_messages(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            conversation_id,
            conversation_kind=conversation_kind,
            persona_id=persona_id,
            order=order,
            limit=limit,
            cursor=cursor,
            include_revoked=include_revoked,
        )

    @app.get(
        conversation_base + "/messages/{message_id}",
        response_model=ConversationMemoryMessage,
    )
    def get_conversation_message(
        workspace_id: str,
        message_id: str,
        request: Request,
        conversation_id: str = Query(alias="conversationId", min_length=1, max_length=512),
        conversation_kind: ConversationKind = Query(alias="conversationKind"),  # noqa: B008
        persona_id: str | None = Query(default=None, alias="personaId", max_length=512),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        receipt = conversation_memory.get_message(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            conversation_id,
            message_id,
            conversation_kind=conversation_kind,
            persona_id=persona_id,
        )
        return receipt["message"]

    @app.post(conversation_base + "/messages", status_code=201)
    def create_conversation_message(
        workspace_id: str,
        body: ConversationMemoryMessageCreate,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        receipt = conversation_memory.create_message(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            body.model_dump(by_alias=True),
        )
        if receipt["duplicate"]:
            response.status_code = 200
        return receipt

    @app.get(conversation_base + "/memories", response_model=ConversationMemoryList)
    def list_conversation_memories(
        workspace_id: str,
        request: Request,
        conversation_id: str = Query(alias="conversationId", min_length=1, max_length=512),
        conversation_kind: ConversationKind = Query(alias="conversationKind"),  # noqa: B008
        persona_id: str | None = Query(default=None, alias="personaId", max_length=512),
        state: str = Query(default="active", max_length=32),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        result = conversation_memory.list_memories(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            conversation_id,
            conversation_kind=conversation_kind,
            persona_id=persona_id,
            state=state,
            limit=limit,
        )
        result["authorizationEpoch"] = conversation_memory.overview(
            principal.organization_id, workspace_id, principal.actor_id
        )["authorizationEpoch"]
        return result

    @app.post(
        conversation_base + "/memories",
        response_model=ConversationMemoryReceipt,
        status_code=201,
    )
    def create_conversation_memory(
        workspace_id: str,
        body: ConversationMemoryCreate,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        receipt = conversation_memory.create_memory(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            body.model_dump(by_alias=True),
        )
        if receipt["duplicate"]:
            response.status_code = 200
        memory = index_conversation_memory(workspace_id, principal, str(receipt["memory"]["id"]))
        return {"memory": memory, "duplicate": receipt["duplicate"]}

    @app.post(conversation_base + "/memories/query", response_model=ConversationMemoryQueryResult)
    def query_conversation_memories(
        workspace_id: str, body: ConversationMemoryQuery, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        if embedding_client is None or memory_provider is None:
            raise provider_unavailable(
                "MEMORY_PROVIDER_UNAVAILABLE",
                "Semantic memory search requires configured embedding and memory providers.",
            )
        try:
            batch = embedding_client.embed([body.query], purpose="query")
            if len(batch.vectors) != 1:
                raise provider_unavailable(
                    "MEMORY_EMBEDDING_RESPONSE_INVALID",
                    "The configured embedding provider returned an unexpected vector count.",
                )
            owner_ids = conversation_memory.query_owners(
                principal.organization_id,
                workspace_id,
                principal.actor_id,
                body.conversation_id,
            )
            per_owner_limit = max(1, min(body.limit, 100 // len(owner_ids)))
            all_hits: list[MemoryProviderHit] = []
            for owner_id in owner_ids:
                scope = MemoryProviderScope(
                    organization_id=principal.organization_id,
                    workspace_id=workspace_id,
                    actor_id=owner_id,
                    conversation_id=None,
                    conversation_kind=body.conversation_kind,
                    persona_id=body.persona_id,
                    visibility=None,
                )
                owner_hits: Sequence[MemoryProviderHit] = memory_provider.query(
                    text=body.query,
                    embedding=batch.vectors[0],
                    model=batch.model,
                    dimensions=batch.dimensions,
                    scope=scope,
                    limit=per_owner_limit,
                )
                all_hits.extend(owner_hits)
            hits = all_hits
        except PersistenceError:
            raise
        except Exception as exc:
            raise provider_unavailable(
                "MEMORY_PROVIDER_UNAVAILABLE", "Semantic memory search is unavailable."
            ) from exc
        if len(hits) > body.limit:
            raise provider_unavailable(
                "MEMORY_PROVIDER_RESPONSE_INVALID",
                "The memory provider returned more candidates than requested.",
            )
        hit_by_id: dict[str, MemoryProviderHit] = {}
        for hit in hits:
            if (
                hit.model != batch.model
                or hit.dimensions != batch.dimensions
                or not isinstance(hit.score, (int, float))
                or not math.isfinite(hit.score)
            ):
                raise provider_unavailable(
                    "MEMORY_PROVIDER_RESPONSE_INVALID",
                    "The memory provider returned an incompatible model or score.",
                )
            hit_by_id.setdefault(hit.memory_id, hit)
        current = conversation_memory.overview(
            principal.organization_id, workspace_id, principal.actor_id
        )
        candidates = conversation_memory.query_candidates(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            body.conversation_id,
            conversation_kind=body.conversation_kind,
            persona_id=body.persona_id,
            memory_ids=list(hit_by_id),
        )
        result_items: list[dict[str, Any]] = []
        for memory in candidates:
            hit = hit_by_id.get(str(memory["id"]))
            if hit is None:
                continue
            result_items.append(
                {
                    "memoryId": memory["id"],
                    "kind": memory["kind"],
                    "text": memory["text"],
                    "sourceMessageIds": memory["sourceMessageIds"],
                    "sourceRefs": memory["sourceRefs"],
                    "version": memory["version"],
                    "score": float(hit.score),
                    "stale": False,
                    "scope": memory["scope"],
                }
            )
        result_items.sort(key=lambda item: (-float(item["score"]), str(item["memoryId"])))
        return {
            "items": result_items[: body.limit],
            "authorizationEpoch": current["authorizationEpoch"],
        }

    @app.patch(
        conversation_base + "/memories/{memory_id}",
        response_model=ConversationMemoryReceipt,
    )
    def update_conversation_memory(
        workspace_id: str,
        memory_id: str,
        body: ConversationMemoryPatch,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        update = conversation_memory.update_memory(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            memory_id,
            body.model_dump(by_alias=True, exclude_unset=True),
        )
        if memory_provider is not None and update["invalidatedMemoryIds"]:
            try:
                memory_provider.delete(
                    memory_ids=update["invalidatedMemoryIds"],
                    scope=MemoryProviderScope(
                        organization_id=principal.organization_id,
                        workspace_id=workspace_id,
                        actor_id=principal.actor_id,
                        conversation_id=None,
                        conversation_kind=None,
                        persona_id=None,
                        visibility=None,
                    ),
                )
            except Exception:
                _LOGGER.warning(
                    "Invalidated memory vectors remain filtered by Navigator provenance state."
                )
        memory = index_conversation_memory(workspace_id, principal, memory_id)
        return {"memory": memory, "duplicate": False}

    @app.delete(
        conversation_base + "/memories/{memory_id}",
        response_model=ConversationMemoryDeleteReceipt,
    )
    def delete_conversation_memory(
        workspace_id: str,
        memory_id: str,
        request: Request,
        expected_version: int = Query(alias="expectedVersion", ge=1),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        receipt = conversation_memory.delete_memory(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            memory_id,
            expected_version,
        )
        if memory_provider is not None:
            try:
                memory_provider.delete(
                    memory_ids=[memory_id, *receipt["invalidatedMemoryIds"]],
                    scope=MemoryProviderScope(
                        organization_id=principal.organization_id,
                        workspace_id=workspace_id,
                        actor_id=principal.actor_id,
                        conversation_id=None,
                        conversation_kind=None,
                        persona_id=None,
                        visibility=None,
                    ),
                )
            except Exception:
                _LOGGER.warning(
                    "Conversation memory provider deletion will be reconciled "
                    "by authorization filtering."
                )
        return {
            "deleted": True,
            "authorizationEpoch": receipt["authorizationEpoch"],
            "duplicate": bool(receipt["duplicate"]),
        }

    @app.get(conversation_base + "/sources", response_model=ConversationMemorySources)
    def list_conversation_sources(
        workspace_id: str,
        request: Request,
        conversation_id: str = Query(alias="conversationId", min_length=1, max_length=512),
        limit: int = Query(default=200, ge=1, le=500),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return conversation_memory.list_sources(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            conversation_id,
            limit=limit,
        )

    @app.post(
        conversation_base + "/sources/authorize",
        response_model=ConversationMemorySourceAuthorizationReceipt,
    )
    def authorize_conversation_sources(
        workspace_id: str, body: ConversationMemorySourceAuthorization, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return conversation_memory.authorize_sources(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            body.conversation_id,
            body.authorization_epoch,
            [item.model_dump(by_alias=True) for item in body.source_refs],
            conversation_kind=body.conversation_kind,
            persona_id=body.persona_id,
        )

    @app.post(
        conversation_base + "/artifacts/authorize",
        response_model=ConversationMemoryArtifactAuthorizationReceipt,
    )
    def authorize_conversation_artifact(
        workspace_id: str,
        body: ConversationMemoryArtifactAuthorization,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return conversation_memory.authorize_artifact(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            body.artifact_id,
            body.conversation_id,
            body.conversation_kind,
            body.persona_id,
            body.authorization_epoch,
            [item.model_dump(by_alias=True) for item in body.source_refs],
        )

    @app.post(
        conversation_base + "/sources/{source_id}/revoke",
        response_model=ConversationMemorySourceRevocationReceipt,
    )
    def revoke_conversation_source(
        workspace_id: str, source_id: str, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        receipt = conversation_memory.revoke_source(
            principal.organization_id, workspace_id, principal.actor_id, source_id
        )
        if memory_provider is not None and receipt["invalidatedMemoryIds"]:
            try:
                memory_provider.delete(
                    memory_ids=receipt["invalidatedMemoryIds"],
                    scope=MemoryProviderScope(
                        organization_id=principal.organization_id,
                        workspace_id=workspace_id,
                        actor_id=principal.actor_id,
                        conversation_id=None,
                        conversation_kind=None,
                        persona_id=None,
                        visibility=None,
                    ),
                )
            except Exception:
                _LOGGER.warning(
                    "Revoked memory vectors remain filtered by Navigator provenance state."
                )
        return receipt

    @app.post(
        conversation_base + "/sources/{source_id}/grants",
        response_model=ConversationMemorySourceGrantReceipt,
        status_code=201,
    )
    def grant_conversation_source(
        workspace_id: str,
        source_id: str,
        body: ConversationMemorySourceGrantCreate,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        receipt = conversation_memory.grant_source(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            source_id,
            body.model_dump(by_alias=True),
        )
        if receipt["duplicate"]:
            response.status_code = 200
        return receipt

    @app.delete(
        conversation_base + "/sources/{source_id}/grants/{grant_id}",
        response_model=ConversationMemorySourceGrantRevocation,
    )
    def revoke_conversation_source_grant(
        workspace_id: str, source_id: str, grant_id: str, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        return conversation_memory.revoke_source_grant(
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            source_id,
            grant_id,
        )

    @app.get(base + "/sources", response_model=SourceList)
    def list_sources(workspace_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {"items": store.list_sources(principal.organization_id, workspace_id)}

    @app.get(base + "/sources/{source_id}/facts")
    def list_source_facts(
        workspace_id: str,
        source_id: str,
        request: Request,
        include_missing: bool = Query(default=False),
        limit: int = Query(default=1_000, ge=1, le=5_000),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {
            "items": store.list_source_facts(
                principal.organization_id,
                workspace_id,
                source_id,
                include_missing=include_missing,
                limit=limit,
                actor_private_scope=principal.actor_private_scope,
            )
        }

    @app.post(base + "/sources/{source_id}/inventory", response_model=SourceInventoryReceipt)
    def ingest_source_page(
        workspace_id: str,
        source_id: str,
        body: SourceInventoryPage,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        return store.ingest_source_page(
            principal.organization_id,
            workspace_id,
            source_id,
            body.model_dump(by_alias=True, exclude_none=True),
        )

    @app.post(base + "/notifications", response_model=NotificationQueued, status_code=201)
    def queue_notification(
        workspace_id: str,
        body: NotificationCreate,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        notification, duplicate = store.create_notification(
            principal.organization_id,
            workspace_id,
            body.model_dump(by_alias=True, exclude_none=True),
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        if duplicate:
            response.status_code = 200
        return {"notification": notification, "duplicate": duplicate}

    @app.post(
        base + "/credential-health/snapshots",
        response_model=CredentialHealthSnapshotReceipt,
    )
    def process_credential_health_snapshots(
        workspace_id: str,
        body: CredentialHealthSnapshotBatch,
        request: Request,
    ) -> dict[str, Any]:
        """Persist a fixed Exchange projection and its state-change notices.

        中文：该宿主专用入口不能接收凭据、授权材料或通知目标。
        """

        principal = require_credential_health_publisher(request, workspace_id)
        if body.organization_id != principal.organization_id:
            raise PersistenceError(
                WORKSPACE_FORBIDDEN,
                403,
                "Credential health snapshots must match the authenticated organization.",
            )
        return store.process_credential_health_snapshots(
            principal.organization_id,
            workspace_id,
            [item.model_dump(by_alias=True) for item in body.connections],
        )

    @app.get(base + "/notifications", response_model=NotificationList)
    def list_notifications(
        workspace_id: str,
        request: Request,
        status: str | None = Query(default=None),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {
            "items": store.list_notifications(
                principal.organization_id,
                workspace_id,
                status=status,
                limit=limit,
                actor_id=principal.actor_id,
                actor_private_scope=principal.actor_private_scope,
            )
        }

    @app.post(base + "/notifications/claim", response_model=NotificationClaimResult)
    def claim_notifications(
        workspace_id: str, body: NotificationClaim, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        return {
            "items": store.claim_notifications(
                principal.organization_id,
                workspace_id,
                body.worker_id,
                body.limit,
                body.lease_seconds,
                notification_type=body.type,
                connector_id=body.connector_id,
                recipient=body.recipient,
                actor_id=principal.actor_id,
                actor_private_scope=principal.actor_private_scope,
            )
        }

    @app.post(
        base + "/private-notifications/claim",
        response_model=PrivateNotificationClaimResult,
    )
    def claim_private_notifications(
        workspace_id: str, body: NotificationClaim, request: Request
    ) -> dict[str, Any]:
        """Lease private messages and Graph notices to the configured installation bridge."""

        principal, policy = require_private_installation_bridge(request, workspace_id)
        if (
            body.type not in {None, "teams.message", "teams.credential-health"}
            or body.connector_id not in {None, "teams-v1"}
            or body.recipient not in {None, "teams:owner-private"}
        ):
            raise PersistenceError(
                "WORK_NOTIFICATION_INVALID_FILTER",
                422,
                "Private notification claims use a fixed Teams route.",
            )
        scope = policy.load_scope(workspace_id)
        return {
            "items": store.claim_private_notifications(
                principal.organization_id,
                workspace_id,
                body.worker_id,
                body.limit,
                body.lease_seconds,
                scope,
                notification_type=body.type,
            )
        }

    @app.post(
        base + "/notifications/{notification_id}/start",
        response_model=NotificationRecord,
    )
    def start_notification(
        workspace_id: str,
        notification_id: str,
        body: NotificationStart,
        request: Request,
    ) -> dict[str, Any]:
        private_scope = None
        private_only = False
        if authenticate(request, workspace_id).can_bind_teams_private_conversations:
            principal, policy = require_private_installation_bridge(request, workspace_id)
            private_scope = policy.load_scope(workspace_id)
            private_only = True
        else:
            principal = principal_for(request, workspace_id, write=True)
        return store.start_notification(
            principal.organization_id,
            workspace_id,
            notification_id,
            body.lease_token,
            private_scope=private_scope,
            allow_private=private_only,
            private_only=private_only,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )

    @app.post(
        base + "/notifications/{notification_id}/finish",
        response_model=NotificationRecord,
    )
    def finish_notification(
        workspace_id: str,
        notification_id: str,
        body: NotificationFinish,
        request: Request,
    ) -> dict[str, Any]:
        private_scope = None
        private_only = False
        if authenticate(request, workspace_id).can_bind_teams_private_conversations:
            principal, policy = require_private_installation_bridge(request, workspace_id)
            private_scope = policy.load_scope(workspace_id)
            private_only = True
        else:
            principal = principal_for(request, workspace_id, write=True)
        return store.finish_notification(
            principal.organization_id,
            workspace_id,
            notification_id,
            body.lease_token,
            body.outcome,
            body.result,
            retry_after_seconds=body.retry_after_seconds,
            private_scope=private_scope,
            allow_private=private_only,
            private_only=private_only,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )

    @app.post(base + "/attachments", response_model=AttachmentRecord, status_code=201)
    def upload_attachment(
        workspace_id: str, body: AttachmentCreate, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        try:
            raw = base64.b64decode(body.content_base64, validate=True)
        except ValueError as exc:
            raise PersistenceError(
                "WORK_ATTACHMENT_INVALID_ENCODING",
                422,
                "contentBase64 must use standard base64 encoding.",
            ) from exc
        return store.put_attachment(
            principal.organization_id,
            workspace_id,
            body.name,
            body.media_type,
            raw,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )

    @app.get(base + "/attachments/{digest}", response_model=None)
    def download_attachment(workspace_id: str, digest: str, request: Request) -> FileResponse:
        principal = principal_for(request, workspace_id)
        metadata, path = store.get_attachment(
            principal.organization_id,
            workspace_id,
            digest,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        return FileResponse(path, media_type=metadata["mediaType"], filename=metadata["name"])

    @app.get(base + "/connectors", response_model=ConnectorList)
    def list_connectors(workspace_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return {"items": store.list_connectors(principal.organization_id, workspace_id)}

    @app.post(base + "/connectors/{connector_id}/status", response_model=ConnectorRecord)
    def update_connector_status(
        workspace_id: str,
        connector_id: str,
        body: ConnectorStatusUpdate,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        return store.update_connector_status(
            principal.organization_id,
            workspace_id,
            connector_id,
            body.model_dump(by_alias=True, exclude_none=True),
        )

    @app.post(base + "/connectors/{connector_id}/events", response_model=ConnectorEventReceipt)
    def register_connector_event(
        workspace_id: str,
        connector_id: str,
        body: ConnectorEventCreate,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        private_scope = None
        if body.teams_private_message is not None:
            if not principal.actor_private_scope or connector_id != "teams-v1":
                raise PersistenceError(
                    "WORK_TEAMS_PRIVATE_MESSAGE_FORBIDDEN",
                    403,
                    "Private Teams message intake requires an actor-private Teams principal.",
                )
            if private_conversation_policy is None:
                raise PersistenceError(
                    "WORK_TEAMS_PRIVATE_INSTALLATION_FORBIDDEN",
                    403,
                    "Private Teams message intake is not configured.",
                )
            private_scope = private_conversation_policy.load_scope(workspace_id)
        receipt, task = store.register_connector_event(
            principal.organization_id,
            workspace_id,
            connector_id,
            body.model_dump(by_alias=True, exclude_none=True),
            principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
            private_scope=private_scope,
        )
        if receipt["duplicate"]:
            response.status_code = 200
        return {**receipt, "task": task}

    @app.get(base + "/connectors/{connector_id}/events", response_model=ConnectorEvents)
    def list_connector_events(
        workspace_id: str,
        connector_id: str,
        request: Request,
        after: int = Query(default=0, ge=0),
        limit: int = Query(default=100, ge=1, le=1_000),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        events, next_seq = store.list_connector_events(
            principal.organization_id,
            workspace_id,
            connector_id,
            after,
            limit,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        return {"events": events, "nextSeq": next_seq}

    @app.get(
        base + "/connectors/{connector_id}/threads/{thread_id}",
        response_model=TeamsThreadRecord,
    )
    def get_connector_thread(
        workspace_id: str,
        connector_id: str,
        thread_id: str,
        request: Request,
        message_limit: int = Query(default=20, ge=1, le=100),
        exclude_message_id: str | None = Query(default=None, max_length=512),
    ) -> dict[str, Any]:
        """Read one durable Teams thread mapping and recent context messages.

        中文：只返回本 Workspace 的稳定 Teams 线程映射及最近讨论文本。
        """

        principal = principal_for(request, workspace_id)
        return store.get_connector_thread(
            principal.organization_id,
            workspace_id,
            connector_id,
            thread_id,
            actor_id=principal.actor_id,
            message_limit=message_limit,
            exclude_message_id=exclude_message_id,
        )

    @app.get(base + "/workflows", response_model=WorkflowList)
    def list_workflows(
        workspace_id: str,
        request: Request,
        definition_version: int = Query(default=1, ge=1, le=3, alias="definitionVersion"),
    ) -> dict[str, Any]:
        principal = (
            require_private_work_owner(request, workspace_id)
            if definition_version == 3
            else principal_for(request, workspace_id)
        )
        return {
            "items": store.list_workflows(
                principal.organization_id,
                workspace_id,
                definition_version,
                actor_id=principal.actor_id if definition_version == 3 else None,
            )
        }

    @app.put(base + "/workflows/{workflow_id}", response_model=WorkflowDefinition)
    def put_workflow(
        workspace_id: str,
        workflow_id: str,
        request: Request,
        body: WorkflowDefinition,
        definition_version: int = Query(default=1, ge=1, le=3, alias="definitionVersion"),
    ) -> dict[str, Any]:
        principal = (
            require_private_work_owner(request, workspace_id)
            if definition_version == 3
            else principal_for(request, workspace_id, write=True)
        )
        value = body.model_dump(by_alias=True, exclude_none=True)
        if value["version"] != definition_version:
            raise PersistenceError(
                "WORK_WORKFLOW_VERSION_MISMATCH",
                422,
                "definitionVersion must match the body version.",
            )
        if value["id"] != workflow_id:
            raise PersistenceError(
                "WORK_WORKFLOW_ID_MISMATCH",
                422,
                "The route workflowId must match body id.",
            )
        private_scope = None
        authorization = value.get("authorization")
        if (
            value.get("version") == 3
            and isinstance(authorization, Mapping)
            and authorization.get("kind") == "owner_private"
        ):
            if private_conversation_policy is None:
                raise PersistenceError(
                    "WORK_TEAMS_PRIVATE_INSTALLATION_FORBIDDEN",
                    403,
                    "The private Teams owner binding is unavailable or unauthorized.",
                )
            private_scope = private_conversation_policy.load_scope(workspace_id)
        return store.put_workflow(
            principal.organization_id,
            workspace_id,
            value,
            actor_id=principal.actor_id,
            private_scope=private_scope,
        )

    @app.post(
        base + "/workflows/{workflow_id}/notices",
        response_model=NotificationQueued,
        status_code=201,
    )
    def enqueue_workflow_notice(
        workspace_id: str,
        workflow_id: str,
        body: WorkflowNoticeCreate,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        """Project a terminal responsibility receipt into its stored Teams owner thread.

        中文：从 v2 工作流、运行回执与 owner Teams 任务生成通知；调用方不能指定路由。
        """

        principal = principal_for(request, workspace_id, write=True)
        private_scope = (
            private_conversation_policy.load_scope(workspace_id)
            if private_conversation_policy is not None
            else None
        )
        receipt, duplicate = store.enqueue_workflow_notice(
            principal.organization_id,
            workspace_id,
            workflow_id,
            body.model_dump(by_alias=True, exclude_none=True),
            actor_id=principal.actor_id,
            private_scope=private_scope,
        )
        if duplicate:
            response.status_code = 200
        return receipt

    @app.post(base + "/schedule-events", response_model=WorkflowScheduleEvent)
    def append_schedule_event(
        workspace_id: str,
        body: WorkflowScheduleEvent,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        return store.append_schedule_event(
            principal.organization_id,
            workspace_id,
            body.model_dump(by_alias=True, exclude_none=True),
            actor_id=principal.actor_id,
        )

    @app.get(base + "/schedule-events/{event_id}", response_model=WorkflowScheduleEvent)
    def get_schedule_event(workspace_id: str, event_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return store.get_schedule_event(
            principal.organization_id,
            workspace_id,
            event_id,
            actor_id=principal.actor_id,
        )

    @app.get(base + "/schedule-events", response_model=WorkflowScheduleEventList)
    def list_schedule_events(
        workspace_id: str,
        request: Request,
        workflow_id: str | None = Query(default=None, max_length=512),
        limit: int = Query(default=100, ge=1, le=500),
        cursor: str | None = Query(default=None, max_length=2_000),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        return store.list_schedule_events(
            principal.organization_id,
            workspace_id,
            workflow_id,
            limit,
            cursor,
            actor_id=principal.actor_id,
        )

    @app.get(base + "/connectors/{binding_id}/health")
    async def connector_health(workspace_id: str, binding_id: str, request: Request) -> Any:
        principal = require_bridge_owner(request, workspace_id)
        bridge = require_bridge(principal, workspace_id, binding_id)
        health = getattr(bridge, "health", None) or getattr(bridge, "tohealth", None)
        if health is None:
            raise PersistenceError(
                "QQ_HOST_NOT_CONFIGURED",
                503,
                "The connector bridge has no health probe.",
            )
        return jsonable_encoder(await _call_bridge(health))

    @app.post(base + "/connectors/{binding_id}/login/qr")
    async def connector_login_qr(workspace_id: str, binding_id: str, request: Request) -> Any:
        principal = require_bridge_owner(request, workspace_id)
        bridge = require_bridge(principal, workspace_id, binding_id)
        return jsonable_encoder(await _call_bridge(bridge.request_qr, {}))

    @app.post(base + "/connectors/{binding_id}/login/poll")
    async def connector_login_poll(
        workspace_id: str, binding_id: str, body: LoginPollRequest, request: Request
    ) -> Any:
        principal = require_bridge_owner(request, workspace_id)
        bridge = require_bridge(principal, workspace_id, binding_id)
        return jsonable_encoder(await _call_bridge(bridge.poll_login, {"login_id": body.login_id}))

    async def close_connector_bridges() -> None:
        """Close configured local bridges during application shutdown. | 关闭连接器子进程。"""

        closed: set[int] = set()
        for bridge in bridges.values():
            if id(bridge) in closed:
                continue
            closed.add(id(bridge))
            close = getattr(bridge, "close", None)
            if close is not None:
                await _call_bridge(close)

    if bridges:
        previous_lifespan = app.router.lifespan_context

        @asynccontextmanager
        async def work_lifespan(application: FastAPI) -> Any:
            """Start configured adapter workers in background and reap them on shutdown. |
            管理适配器生命周期。
            """

            async with previous_lifespan(application):
                start_tasks: list[asyncio.Task[Any]] = []
                started: set[int] = set()
                for bridge in bridges.values():
                    if id(bridge) in started:
                        continue
                    started.add(id(bridge))
                    start = getattr(bridge, "start", None)
                    if callable(start):
                        task = asyncio.create_task(_call_bridge(start))
                        task.add_done_callback(_report_background_failure)
                        start_tasks.append(task)
                try:
                    yield
                finally:
                    await close_connector_bridges()
                    for task in start_tasks:
                        if not task.done():
                            task.cancel()
                    if start_tasks:
                        await asyncio.gather(*start_tasks, return_exceptions=True)

        app.router.lifespan_context = work_lifespan
    return store


class LoginPollRequest(WorkModel):
    """Accept a login identifier only; host, path and account come from trusted config."""

    login_id: str


async def _call_bridge(function: Callable[..., Any], *args: Any) -> Any:
    """Call either synchronous or asynchronous trusted bridge implementations. | 调用本地桥。"""

    try:
        if inspect.iscoroutinefunction(function):
            return await function(*args)
        result = await asyncio.to_thread(function, *args)
        if inspect.isawaitable(result):
            return await result
        return result
    except PersistenceError:
        raise
    except Exception as exc:
        error_code = getattr(exc, "code", None)
        if error_code in {
            "UNSUPPORTED",
            "UNSUPPORTED_OPERATION",
            "UNAVAILABLE",
            "NOT_AVAILABLE",
            "NOT_CONFIGURED",
            "NOT_RUN",
            "HOST_NOT_CONFIGURED",
        }:
            raise PersistenceError(
                "CONNECTOR_OPERATION_UNAVAILABLE",
                503,
                "The configured connector does not provide this operation.",
                retryable=True,
            ) from None
        raise PersistenceError(
            "CONNECTOR_BRIDGE_FAILED",
            502,
            "The configured connector request failed.",
            retryable=True,
        ) from None


def _report_background_failure(task: asyncio.Task[Any]) -> None:
    """Retrieve a failed task without logging potentially sensitive text. | 仅记录后台错误类型。"""

    if task.cancelled():
        return
    error = task.exception()
    if error is not None:
        _LOGGER.error("configured connector background task stopped: %s", type(error).__name__)
