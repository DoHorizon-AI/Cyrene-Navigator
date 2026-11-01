"""Real Public Web research over the existing Work and plugin authorities.

中文：通过既有 Work 与插件 authority 执行真实公网研究。
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_memory.store import ConversationMemoryStore
from cyrene_navigator.work.store import WorkStore

from .models import ConversationResearchRequest, ConversationResearchScope

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_SOURCE_REF = re.compile(r"sha256:[0-9a-f]{64}\Z")
_MAX_SOURCE_COUNT = 20
_MAX_RESULT_CHARS = 1_000_000
_MAX_ATTACHMENT_BYTES = 10_000_000
_MAX_SEARCH_PAGES = 3
_MAX_SEARCH_RESULTS = 5
_MAX_PAGE_READS = 4
_MAX_DOCUMENT_PAGES = 3
_DOCUMENT_MIME_TYPES = frozenset(
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
)


class ConversationRuntimeError(Exception):
    """Stable, safe failure from the conversation runtime adapter."""

    def __init__(
        self,
        code: str,
        status_code: int = 409,
        *,
        retryable: bool = False,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code
        self.retryable = retryable


class PublicWebBindingUnavailable(ConversationRuntimeError):
    """Configured public-web capability is absent or lacks required operations."""

    def __init__(self) -> None:
        super().__init__("PUBLIC_WEB_NOT_CONFIGURED", 503, retryable=True)


class _CallerSigner(Protocol):
    def sign_context(
        self,
        *,
        method: str,
        operation_id: str,
        payload: Mapping[str, Any],
        principal: PersistencePrincipal,
        workspace_id: str,
        binding_id: str,
        caller_workload: str,
        audience: str,
        request_id: str,
    ) -> Mapping[str, Any]: ...


class _ToolProviderClient(Protocol):
    def call_tool(
        self,
        provider_tool_id: str,
        arguments: Mapping[str, Any],
        caller_context: Mapping[str, Any],
    ) -> Any: ...


class _FixedPublicWebBinding(Protocol):
    binding_id: str
    caller_workload: str
    audience: str
    operation_ids: Mapping[str, str]
    signer: _CallerSigner
    client: _ToolProviderClient

    async def invoke(
        self,
        provider_tool_id: str,
        arguments: Mapping[str, Any],
        *,
        principal: PersistencePrincipal,
        workspace_id: str,
        request_id: str,
        caller_context: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]: ...


class _ActiveCallRegistry(Protocol):
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
        read_grants: Sequence[Any] = (),
        ttl_seconds: int = 120,
    ) -> Any: ...

    def assert_call_current(self, lease: Any) -> None: ...


@dataclass(frozen=True, slots=True)
class ConversationRuntimeResult:
    """Digest-backed result projected to the research feature after Work readback."""

    operation_id: str
    title: str
    content: str
    result_sha256: str
    content_sha256: str
    source_evidence: tuple[Mapping[str, Any], ...]
    artifact_id: str


@dataclass(frozen=True, slots=True)
class _FetchedSource:
    title: str
    content: str
    source_ref: str
    source_sha256: str
    kind: str
    url: str | None = None
    artifact_id: str | None = None


class ConversationResearchRuntime:
    """Validate, invoke, persist, and independently verify one research read.

    The class uses WorkStore as the only Task, attachment, and operation ledger.
    ``public_web`` and its binding ID are server-provisioned. Model input cannot
    select a provider, host, credential, source reference, or artifact path.
    """

    def __init__(
        self,
        work_store: WorkStore,
        conversation_store: ConversationMemoryStore,
        public_web: _FixedPublicWebBinding | None,
        *,
        active_calls: _ActiveCallRegistry | None = None,
        now: Any = None,
        call_timeout_seconds: float = 90.0,
    ) -> None:
        if not 1 <= call_timeout_seconds <= 180:
            raise ValueError("call_timeout_seconds must be between 1 and 180")
        self._work = work_store
        self._conversation = conversation_store
        self._public_web = public_web
        self._active_calls = active_calls
        self._now = now or (lambda: datetime.now(UTC))
        self._call_timeout_seconds = call_timeout_seconds

    async def research(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        request: ConversationResearchRequest,
        *,
        cancelled: Any = None,
    ) -> ConversationRuntimeResult:
        """Run a bounded search/open/document sequence under the exact active Task."""

        binding = self._public_web
        if binding is None or not all(
            tool_id in binding.operation_ids
            for tool_id in ("web.search", "web.open", "document.read")
        ):
            raise PublicWebBindingUnavailable()
        self._require_principal(principal, workspace_id)
        task = await self._get_task(principal, workspace_id, request.task_id)
        self._require_active_research_task(task, principal, workspace_id, request)
        await self._authorize_sources(principal, workspace_id, request.scope)
        attachments = await self._authorize_attachments(
            principal, workspace_id, request.scope, request.attachment_ids
        )

        query_digest = _sha256(request.query.strip().encode("utf-8"))
        lineage_digest = _sha256(_canonical_json(list(request.scope.source_refs)))
        request_shape = {
            "querySha256": query_digest,
            "sourceRefsSha256": lineage_digest,
            "attachmentIds": list(request.attachment_ids),
            "bindingId": binding.binding_id,
        }
        request_digest = _sha256(_canonical_json(request_shape))
        operation_key = (
            f"conversation-research:{_sha256((request.task_id + chr(0) + request_digest).encode())}"
        )
        operation_type = "conversation.research.read.v1"
        target = f"conversation-research:{request_digest}"

        operation, duplicate = await asyncio.to_thread(
            self._work.create_operation,
            principal.organization_id,
            workspace_id,
            {
                "idempotencyKey": operation_key,
                "operationType": operation_type,
                "taskId": request.task_id,
                "target": target,
                "request": request_shape,
            },
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        if duplicate:
            return await self._read_duplicate(principal, workspace_id, request, operation)

        try:
            self._raise_if_cancelled(cancelled)
            sources: list[_FetchedSource] = []
            for artifact_id, media_type in attachments:
                self._raise_if_cancelled(cancelled)
                sources.append(
                    await self._read_document_artifact(
                        binding,
                        principal,
                        workspace_id,
                        request.task_id,
                        request.scope,
                        artifact_id,
                        media_type,
                        cancelled,
                    )
                )
            sources.extend(
                await self._search_and_open(
                    binding,
                    principal,
                    workspace_id,
                    request.task_id,
                    request.query.strip(),
                    cancelled,
                )
            )
            self._raise_if_cancelled(cancelled)
            if not sources:
                raise ConversationRuntimeError("RESEARCH_SOURCE_REQUIRED", 422)
            title = sources[0].title[:512]
            content = _render_sources(sources)
            if not content.strip():
                raise ConversationRuntimeError("RESEARCH_CONTENT_EMPTY", 502)
            content_bytes = content.encode("utf-8")
            content_sha256 = _sha256(content_bytes)
            source_evidence = tuple(_source_evidence(source, self._now()) for source in sources)
            artifact_payload = {
                "version": 1,
                "title": title,
                "content": content,
                "contentSha256": content_sha256,
                "sourceEvidence": list(source_evidence),
            }
            artifact_bytes = _canonical_json(artifact_payload)
            if len(artifact_bytes) > _MAX_ATTACHMENT_BYTES:
                raise ConversationRuntimeError("RESEARCH_RESULT_TOO_LARGE", 413)
            self._require_active_research_task(
                await self._get_task(principal, workspace_id, request.task_id),
                principal,
                workspace_id,
                request,
            )
            current = await self._authorize_sources(principal, workspace_id, request.scope)
            if current != request.scope.authorization_epoch:
                raise ConversationRuntimeError("RESEARCH_SOURCE_REVOKED", 409)
            attachment = await asyncio.to_thread(
                self._work.put_attachment,
                principal.organization_id,
                workspace_id,
                f"research-{operation['id']}.json",
                "application/json",
                artifact_bytes,
                actor_id=principal.actor_id,
                actor_private_scope=True,
            )
            verified_bytes = await self._read_attachment(
                principal, workspace_id, str(attachment.get("sha256", ""))
            )
            if verified_bytes != artifact_bytes:
                raise ConversationRuntimeError("RESEARCH_ARTIFACT_READBACK_MISMATCH", 409)
            self._raise_if_cancelled(cancelled)
            result_sha256 = _sha256(verified_bytes)
            evidence = {
                "outcome": "verified",
                "effect": "read",
                "taskSource": (
                    task.get("metadata", {}).get("source")
                    if isinstance(task.get("metadata"), Mapping)
                    else None
                ),
                "resultSha256": result_sha256,
                "contentSha256": content_sha256,
                "targetDigestSha256": request_digest,
                "sourceRefs": [dict(reference) for reference in request.scope.source_refs],
                "sourceEvidence": list(source_evidence),
                "artifactId": result_sha256,
                "bindingId": binding.binding_id,
                "readbackVerified": True,
                "readbackSha256": _sha256(verified_bytes),
            }
            await asyncio.to_thread(
                self._work.update_operation,
                principal.organization_id,
                workspace_id,
                str(operation["id"]),
                "verified",
                evidence,
                actor_id=principal.actor_id,
                actor_private_scope=principal.actor_private_scope,
            )
            return ConversationRuntimeResult(
                operation_id=str(operation["id"]),
                title=title,
                content=content,
                result_sha256=result_sha256,
                content_sha256=content_sha256,
                source_evidence=source_evidence,
                artifact_id=result_sha256,
            )
        except asyncio.CancelledError:
            await self._finish_uncertain(principal, workspace_id, operation, "CANCELLED")
            raise
        except ConversationRuntimeError as error:
            await self._finish_failed(principal, workspace_id, operation, error.code)
            raise
        except (PersistenceError, OSError, ValueError, TypeError, KeyError) as error:
            await self._finish_uncertain(
                principal, workspace_id, operation, _safe_error_code(error)
            )
            raise ConversationRuntimeError(
                "RESEARCH_PROVIDER_FAILED", 502, retryable=True
            ) from None
        except Exception:
            await self._finish_uncertain(principal, workspace_id, operation, "PROVIDER_FAILURE")
            raise ConversationRuntimeError(
                "RESEARCH_PROVIDER_FAILED", 502, retryable=True
            ) from None

    async def read_operation_receipt(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        *,
        parent_task_id: str,
        parent_session_id: str,
        operation_id: str,
        scope: ConversationResearchScope,
    ) -> Mapping[str, Any]:
        """Project one completed child Task's real Work operation evidence.

        The operation ID is only a lookup hint. Ownership, Task lineage, source
        authorization, operation type, task output, and result artifact are all
        read independently from WorkStore before returning a receipt.
        """

        self._require_principal(principal, workspace_id)
        try:
            operation = await asyncio.to_thread(
                self._work.get_operation,
                principal.organization_id,
                workspace_id,
                operation_id,
                actor_id=principal.actor_id,
                actor_private_scope=principal.actor_private_scope,
            )
        except PersistenceError as error:
            if error.status == 404:
                raise ConversationRuntimeError("WORK_OPERATION_NOT_FOUND", 404) from None
            raise
        task_id = operation.get("taskId")
        evidence = operation.get("evidence")
        stored_source_refs = evidence.get("sourceRefs") if isinstance(evidence, Mapping) else None
        if (
            operation.get("id") != operation_id
            or operation.get("operationType") != "conversation.research.read.v1"
            or operation.get("status") != "verified"
            or not isinstance(task_id, str)
            or not isinstance(evidence, Mapping)
            or evidence.get("outcome") != "verified"
            or evidence.get("effect") != "read"
            or evidence.get("readbackVerified") is not True
            or evidence.get("readbackSha256") != evidence.get("resultSha256")
            or not _SHA256.fullmatch(str(evidence.get("resultSha256", "")))
            or not _SHA256.fullmatch(str(evidence.get("contentSha256", "")))
            or not _SHA256.fullmatch(str(evidence.get("targetDigestSha256", "")))
            or not isinstance(stored_source_refs, list)
            or not stored_source_refs
            or len(stored_source_refs) > 256
            or (
                bool(scope.source_refs)
                and stored_source_refs != [dict(reference) for reference in scope.source_refs]
            )
        ):
            raise ConversationRuntimeError("WORK_OPERATION_RECEIPT_INVALID", 409)
        authoritative_scope = ConversationResearchScope(
            conversation_id=scope.conversation_id,
            conversation_kind=scope.conversation_kind,
            persona_id=scope.persona_id,
            authorization_epoch=scope.authorization_epoch,
            source_refs=tuple(
                reference for reference in stored_source_refs if isinstance(reference, Mapping)
            ),
        )
        if len(authoritative_scope.source_refs) != len(stored_source_refs):
            raise ConversationRuntimeError("WORK_OPERATION_RECEIPT_INVALID", 409)
        await self._authorize_sources(principal, workspace_id, authoritative_scope)
        try:
            task = await self._get_task(principal, workspace_id, task_id)
        except PersistenceError as error:
            if error.status == 404:
                raise ConversationRuntimeError("WORK_OPERATION_TASK_NOT_FOUND", 409) from None
            raise
        metadata = task.get("metadata")
        output = task.get("output")
        if (
            task.get("status") != "completed"
            or str(task.get("createdByActorId") or "").lower() != principal.actor_id.lower()
            or task.get("workspaceId") != workspace_id
            or not isinstance(output, str)
            or not isinstance(metadata, Mapping)
            or metadata.get("source") not in {"conversation-research-read", "conversation-watch"}
            or str(metadata.get("workspaceId") or "") != workspace_id
            or str(metadata.get("actorId") or "").lower() != principal.actor_id.lower()
            or metadata.get("conversationId") != authoritative_scope.conversation_id
            or metadata.get("parentTaskId") != parent_task_id
            or metadata.get("parentSessionId") != parent_session_id
            or _canonical_json(metadata.get("sourceRefs"))
            != _canonical_json([dict(reference) for reference in authoritative_scope.source_refs])
        ):
            raise ConversationRuntimeError("WORK_OPERATION_TASK_PROVENANCE_INVALID", 409)
        if task_id == parent_task_id:
            raise ConversationRuntimeError("WORK_OPERATION_TASK_PROVENANCE_INVALID", 409)
        try:
            parent = await self._get_task(principal, workspace_id, parent_task_id)
        except PersistenceError as error:
            if error.status == 404:
                raise ConversationRuntimeError(
                    "WORK_OPERATION_PARENT_TASK_NOT_FOUND", 409
                ) from None
            raise
        if (
            str(parent.get("createdByActorId") or "").lower() != principal.actor_id.lower()
            or parent.get("workspaceId") != workspace_id
            or parent.get("sessionId") != parent_session_id
        ):
            raise ConversationRuntimeError("WORK_OPERATION_PARENT_TASK_PROVENANCE_INVALID", 409)
        expected_source = (
            "conversation-research-read"
            if metadata.get("source") == "conversation-research-read"
            else "conversation-watch"
        )
        if evidence.get("taskSource") not in {None, expected_source}:
            raise ConversationRuntimeError("WORK_OPERATION_TASK_PROVENANCE_INVALID", 409)
        artifact_id = evidence.get("artifactId")
        if artifact_id != evidence.get("resultSha256"):
            raise ConversationRuntimeError("WORK_OPERATION_ARTIFACT_INVALID", 409)
        raw = await self._read_attachment(principal, workspace_id, str(artifact_id))
        try:
            stored = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ConversationRuntimeError("WORK_OPERATION_ARTIFACT_INVALID", 409) from None
        if (
            not isinstance(stored, Mapping)
            or stored.get("contentSha256") != evidence.get("contentSha256")
            or not isinstance(stored.get("title"), str)
            or not isinstance(stored.get("content"), str)
            or not isinstance(stored.get("sourceEvidence"), list)
            or not stored["sourceEvidence"]
            or stored.get("sourceEvidence") != evidence.get("sourceEvidence")
            or _sha256(str(stored.get("content")).encode("utf-8")) != evidence.get("contentSha256")
            or _sha256(raw) != evidence.get("resultSha256")
        ):
            raise ConversationRuntimeError("WORK_OPERATION_ARTIFACT_INVALID", 409)
        return {
            "id": operation_id,
            "workspaceId": workspace_id,
            "actorId": principal.actor_id,
            "taskId": task_id,
            "taskStatus": "completed",
            "taskOutputSha256": _sha256(output.encode("utf-8")),
            "status": "verified",
            "operationType": str(operation["operationType"]),
            "effect": "read",
            "resultSha256": str(evidence["resultSha256"]),
            "contentSha256": str(evidence["contentSha256"]),
            "targetDigestSha256": str(evidence["targetDigestSha256"]),
            "sourceRefs": [dict(reference) for reference in authoritative_scope.source_refs],
            "sourceEvidence": stored["sourceEvidence"],
            "verifiedAt": int(operation.get("updatedAt", 0)),
        }

    async def _search_and_open(
        self,
        binding: _FixedPublicWebBinding,
        principal: PersistencePrincipal,
        workspace_id: str,
        task_id: str,
        query: str,
        cancelled: Any,
    ) -> list[_FetchedSource]:
        items: list[Mapping[str, Any]] = []
        cursor: str | None = None
        seen_cursors: set[str] = set()
        for _ in range(_MAX_SEARCH_PAGES):
            arguments: dict[str, Any] = {"query": query, "limit": 5}
            if cursor is not None:
                arguments["cursor"] = cursor
            result = await self._invoke_tool(
                binding, principal, workspace_id, task_id, "web.search", arguments, cancelled
            )
            page_items = result.get("items")
            if not isinstance(page_items, list) or len(page_items) > 20:
                raise ConversationRuntimeError("PUBLIC_WEB_RESPONSE_INVALID", 502)
            for item in page_items:
                if isinstance(item, Mapping):
                    items.append(item)
                    if len(items) >= _MAX_SEARCH_RESULTS:
                        break
            if len(items) >= _MAX_SEARCH_RESULTS:
                break
            next_cursor = result.get("next_cursor")
            if next_cursor is None:
                break
            if not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_cursors:
                raise ConversationRuntimeError("PUBLIC_WEB_CURSOR_INVALID", 502)
            seen_cursors.add(next_cursor)
            cursor = next_cursor

        sources: list[_FetchedSource] = []
        seen_urls: set[str] = set()
        for item in items:
            self._raise_if_cancelled(cancelled)
            url = item.get("url")
            title = item.get("title")
            source_ref = item.get("source_ref")
            if (
                not isinstance(url, str)
                or not url.startswith("https://")
                or len(url) > 4_096
                or not isinstance(title, str)
                or not isinstance(source_ref, str)
                or not _SOURCE_REF.fullmatch(source_ref)
                or url in seen_urls
            ):
                continue
            seen_urls.add(url)
            try:
                sources.append(
                    await self._open_web_page(
                        binding, principal, workspace_id, task_id, url, title, cancelled
                    )
                )
            except ConversationRuntimeError as error:
                if error.code != "NOT_HTML":
                    raise
                sources.append(
                    await self._read_document_url(
                        binding, principal, workspace_id, task_id, url, title, cancelled
                    )
                )
        return sources

    async def _open_web_page(
        self,
        binding: _FixedPublicWebBinding,
        principal: PersistencePrincipal,
        workspace_id: str,
        task_id: str,
        url: str,
        fallback_title: str,
        cancelled: Any,
    ) -> _FetchedSource:
        content: list[str] = []
        cursor: str | None = None
        source_ref: str | None = None
        source_sha256: str | None = None
        title = fallback_title
        for _ in range(_MAX_PAGE_READS):
            arguments: dict[str, Any] = {"url": url, "chunk_chars": 12_000}
            if cursor is not None:
                arguments["cursor"] = cursor
            result = await self._invoke_tool(
                binding, principal, workspace_id, task_id, "web.open", arguments, cancelled
            )
            if result.get("content_type") not in {"text/html", "application/xhtml+xml"}:
                raise ConversationRuntimeError("NOT_HTML", 415)
            content_value = result.get("content")
            candidate_ref = result.get("source_ref")
            candidate_digest = result.get("content_sha256")
            candidate_title = result.get("title")
            if (
                not isinstance(content_value, str)
                or not isinstance(candidate_ref, str)
                or not _SOURCE_REF.fullmatch(candidate_ref)
                or not isinstance(candidate_digest, str)
                or not _SHA256.fullmatch(candidate_digest)
            ):
                raise ConversationRuntimeError("PUBLIC_WEB_RESPONSE_INVALID", 502)
            if source_ref is not None and (
                source_ref != candidate_ref or source_sha256 != candidate_digest
            ):
                raise ConversationRuntimeError("PUBLIC_WEB_PAGE_CHANGED", 409)
            source_ref = candidate_ref
            source_sha256 = candidate_digest
            if isinstance(candidate_title, str) and candidate_title.strip():
                title = candidate_title[:512]
            content.append(content_value)
            next_cursor = result.get("next_cursor")
            if next_cursor is None:
                break
            if not isinstance(next_cursor, str) or not next_cursor:
                raise ConversationRuntimeError("PUBLIC_WEB_CURSOR_INVALID", 502)
            cursor = next_cursor
        else:
            content.append("[Further page content omitted at the configured bound.]")
        if source_ref is None or source_sha256 is None:
            raise ConversationRuntimeError("PUBLIC_WEB_RESPONSE_INVALID", 502)
        return _FetchedSource(
            title=title,
            content="".join(content),
            source_ref=source_ref,
            source_sha256=source_sha256,
            kind="web",
            url=url,
        )

    async def _read_document_url(
        self,
        binding: _FixedPublicWebBinding,
        principal: PersistencePrincipal,
        workspace_id: str,
        task_id: str,
        url: str,
        fallback_title: str,
        cancelled: Any,
    ) -> _FetchedSource:
        result = await self._read_document_pages(
            binding,
            principal,
            workspace_id,
            task_id,
            {"url": url},
            cancelled,
        )
        title = result["title"] or fallback_title
        return _FetchedSource(
            title=title,
            content=result["content"],
            source_ref=result["source_ref"],
            source_sha256=result["source_sha256"],
            kind="document",
            url=url,
        )

    async def _read_document_artifact(
        self,
        binding: _FixedPublicWebBinding,
        principal: PersistencePrincipal,
        workspace_id: str,
        task_id: str,
        scope: ConversationResearchScope,
        artifact_id: str,
        media_type: str,
        cancelled: Any,
    ) -> _FetchedSource:
        arguments = {"artifact_id": artifact_id, "limit": 20}
        pages: list[Mapping[str, Any]] = []
        cursor: str | None = None
        for _ in range(_MAX_DOCUMENT_PAGES):
            page_arguments = dict(arguments)
            if cursor is not None:
                page_arguments["cursor"] = cursor
            result = await self._invoke_tool(
                binding,
                principal,
                workspace_id,
                task_id,
                "document.read",
                page_arguments,
                cancelled,
                artifact_scope=scope,
                artifact_media_type=media_type,
            )
            pages.append(result)
            cursor_value = result.get("next_cursor")
            if cursor_value is None:
                break
            if not isinstance(cursor_value, str) or not cursor_value:
                raise ConversationRuntimeError("PUBLIC_WEB_CURSOR_INVALID", 502)
            cursor = cursor_value
        source_refs = {str(page.get("source_ref")) for page in pages}
        source_digests = {str(page.get("source_digest")) for page in pages}
        if len(source_refs) != 1 or len(source_digests) != 1:
            raise ConversationRuntimeError("DOCUMENT_READBACK_MISMATCH", 409)
        source_ref = next(iter(source_refs))
        source_digest = next(iter(source_digests))
        if (
            not _SOURCE_REF.fullmatch(source_ref)
            or not source_digest.startswith("sha256:")
            or not _SHA256.fullmatch(source_digest[7:])
        ):
            raise ConversationRuntimeError("PUBLIC_WEB_RESPONSE_INVALID", 502)
        title = str(pages[0].get("filename") or "Authorized conversation document")[:512]
        content = _document_page_text(pages)
        return _FetchedSource(
            title=title,
            content=content,
            source_ref=source_ref,
            source_sha256=source_digest[7:],
            kind="document",
            artifact_id=artifact_id,
        )

    async def _read_document_pages(
        self,
        binding: _FixedPublicWebBinding,
        principal: PersistencePrincipal,
        workspace_id: str,
        task_id: str,
        initial_arguments: Mapping[str, Any],
        cancelled: Any,
    ) -> dict[str, str]:
        pages: list[Mapping[str, Any]] = []
        cursor: str | None = None
        for _ in range(_MAX_DOCUMENT_PAGES):
            arguments = dict(initial_arguments)
            arguments["limit"] = 20
            if cursor is not None:
                arguments["cursor"] = cursor
            page = await self._invoke_tool(
                binding, principal, workspace_id, task_id, "document.read", arguments, cancelled
            )
            pages.append(page)
            cursor_value = page.get("next_cursor")
            if cursor_value is None:
                break
            if not isinstance(cursor_value, str) or not cursor_value:
                raise ConversationRuntimeError("PUBLIC_WEB_CURSOR_INVALID", 502)
            cursor = cursor_value
        first = pages[0]
        source_ref = first.get("source_ref")
        source_digest = first.get("source_digest")
        if (
            not isinstance(source_ref, str)
            or not _SOURCE_REF.fullmatch(source_ref)
            or not isinstance(source_digest, str)
            or not source_digest.startswith("sha256:")
            or not _SHA256.fullmatch(source_digest[7:])
            or any(
                page.get("source_ref") != source_ref or page.get("source_digest") != source_digest
                for page in pages
            )
        ):
            raise ConversationRuntimeError("PUBLIC_WEB_RESPONSE_INVALID", 502)
        return {
            "title": str(first.get("filename") or "Public document")[:512],
            "content": _document_page_text(pages),
            "source_ref": source_ref,
            "source_sha256": source_digest[7:],
        }

    async def _invoke_tool(
        self,
        binding: _FixedPublicWebBinding,
        principal: PersistencePrincipal,
        workspace_id: str,
        task_id: str,
        tool_id: str,
        arguments: Mapping[str, Any],
        cancelled: Any,
        *,
        artifact_scope: ConversationResearchScope | None = None,
        artifact_media_type: str | None = None,
    ) -> Mapping[str, Any]:
        self._raise_if_cancelled(cancelled)
        operation_id = binding.operation_ids.get(tool_id)
        if operation_id != tool_id:
            raise PublicWebBindingUnavailable()
        request_id = str(uuid4())
        caller_context = binding.signer.sign_context(
            method=tool_id,
            operation_id=operation_id,
            payload=arguments,
            principal=principal,
            workspace_id=workspace_id,
            binding_id=binding.binding_id,
            caller_workload=binding.caller_workload,
            audience=binding.audience,
            request_id=request_id,
        )
        lease: Any = None
        active_calls = self._active_calls
        if artifact_scope is not None:
            if (
                tool_id != "document.read"
                or active_calls is None
                or artifact_media_type not in _DOCUMENT_MIME_TYPES
            ):
                raise ConversationRuntimeError(
                    "DOCUMENT_SOURCE_AUTH_UNAVAILABLE", 503, retryable=True
                )
            artifact_id = arguments.get("artifact_id")
            if not isinstance(artifact_id, str) or not _SHA256.fullmatch(artifact_id):
                raise ConversationRuntimeError("DOCUMENT_SOURCE_INVALID", 422)
            read_grant = self._artifact_grant(artifact_scope, artifact_id, artifact_media_type)
            lease = active_calls.register_task_call(
                principal,
                workspace_id,
                task_id=task_id,
                request_id=request_id,
                binding_id=binding.binding_id,
                tool_id=tool_id,
                operation_id=operation_id,
                arguments=arguments,
                caller_context=caller_context,
                read_grants=(read_grant,),
                ttl_seconds=min(120, max(1, int(self._call_timeout_seconds))),
            )
        try:
            result = await _await_tool_call(
                binding.invoke(
                    tool_id,
                    arguments,
                    principal=principal,
                    workspace_id=workspace_id,
                    request_id=request_id,
                    caller_context=caller_context,
                ),
                cancelled=cancelled,
                timeout_seconds=self._call_timeout_seconds,
            )
            if lease is not None and active_calls is not None:
                active_calls.assert_call_current(lease)
            return _decode_tool_result(result)
        except TimeoutError:
            raise ConversationRuntimeError("PUBLIC_WEB_TIMEOUT", 504, retryable=True) from None
        finally:
            if lease is not None:
                lease.close()

    @staticmethod
    def _artifact_grant(scope: ConversationResearchScope, artifact_id: str, media_type: str) -> Any:
        try:
            bridge_models = importlib.import_module(
                "cyrene_navigator.work.conversation_artifact_bridge.models"
            )
        except ImportError:
            raise ConversationRuntimeError(
                "DOCUMENT_SOURCE_AUTH_UNAVAILABLE", 503, retryable=True
            ) from None
        artifact_scope = bridge_models.ConversationArtifactScope(
            conversation_id=scope.conversation_id,
            conversation_kind=scope.conversation_kind,
            persona_id=scope.persona_id,
            authorization_epoch=scope.authorization_epoch,
            source_refs=scope.source_refs,
        )
        return bridge_models.ArtifactReadGrant(
            artifact_id=artifact_id,
            kind="conversation_source",
            allowed_mime_types=frozenset({media_type}),
            source_scope=artifact_scope,
        )

    async def _authorize_sources(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        scope: ConversationResearchScope,
    ) -> int:
        if not scope.source_refs:
            raise ConversationRuntimeError("RESEARCH_SOURCE_REQUIRED", 422)
        result = await asyncio.to_thread(
            self._conversation.authorize_sources,
            principal.organization_id,
            workspace_id,
            principal.actor_id,
            scope.conversation_id,
            scope.authorization_epoch,
            list(scope.source_refs),
            conversation_kind=scope.conversation_kind,
            persona_id=scope.persona_id,
        )
        current_epoch = result.get("currentAuthorizationEpoch")
        if result.get("allowed") is not True or current_epoch != scope.authorization_epoch:
            raise ConversationRuntimeError("RESEARCH_SOURCE_REVOKED", 409)
        return int(current_epoch)

    async def _authorize_attachments(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        scope: ConversationResearchScope,
        artifact_ids: Sequence[str],
    ) -> list[tuple[str, str]]:
        authorized: list[tuple[str, str]] = []
        for artifact_id in artifact_ids:
            result = await asyncio.to_thread(
                self._conversation.authorize_artifact,
                principal.organization_id,
                workspace_id,
                principal.actor_id,
                artifact_id,
                scope.conversation_id,
                scope.conversation_kind,
                scope.persona_id,
                scope.authorization_epoch,
                list(scope.source_refs),
            )
            if (
                result.get("allowed") is not True
                or result.get("currentAuthorizationEpoch") != scope.authorization_epoch
            ):
                raise ConversationRuntimeError("DOCUMENT_SOURCE_REVOKED", 409)
            artifact_view = result.get("artifact")
            media_type = (
                artifact_view.get("mediaType") if isinstance(artifact_view, Mapping) else None
            )
            if not isinstance(media_type, str) or media_type not in _DOCUMENT_MIME_TYPES:
                raise ConversationRuntimeError("DOCUMENT_MEDIA_UNSUPPORTED", 415)
            metadata, _path = await asyncio.to_thread(
                self._work.get_attachment,
                principal.organization_id,
                workspace_id,
                artifact_id,
                actor_id=principal.actor_id,
                actor_private_scope=True,
            )
            if metadata.get("sha256") != artifact_id or metadata.get("mediaType") != media_type:
                raise ConversationRuntimeError("DOCUMENT_SOURCE_INTEGRITY_FAILURE", 422)
            authorized.append((artifact_id, media_type))
        return authorized

    async def _get_task(
        self, principal: PersistencePrincipal, workspace_id: str, task_id: str
    ) -> Mapping[str, Any]:
        return await asyncio.to_thread(
            self._work.get_task,
            principal.organization_id,
            workspace_id,
            task_id,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )

    @staticmethod
    def _require_principal(principal: PersistencePrincipal, workspace_id: str) -> None:
        if (
            principal.organization_id is None
            or workspace_id not in principal.workspace_ids
            or not principal.can_takeover
        ):
            raise ConversationRuntimeError("WORKSPACE_FORBIDDEN", 403)

    @staticmethod
    def _require_active_research_task(
        task: Mapping[str, Any],
        principal: PersistencePrincipal,
        workspace_id: str,
        request: ConversationResearchRequest,
    ) -> None:
        metadata = task.get("metadata")
        if (
            task.get("id") != request.task_id
            or task.get("workspaceId") != workspace_id
            or task.get("status") != "running"
            or str(task.get("createdByActorId") or "").lower() != principal.actor_id.lower()
            or not isinstance(metadata, Mapping)
            or metadata.get("workspaceId") != workspace_id
            or str(metadata.get("actorId") or "").lower() != principal.actor_id.lower()
            or metadata.get("conversationId") != request.scope.conversation_id
            or metadata.get("parentTaskId") != request.parent_task_id
            or metadata.get("parentSessionId") != request.parent_session_id
            or _canonical_json(metadata.get("sourceRefs"))
            != _canonical_json([dict(reference) for reference in request.scope.source_refs])
            or metadata.get("source") not in {"conversation-research-read", "conversation-watch"}
        ):
            raise ConversationRuntimeError("WORK_TASK_NOT_AUTHORIZED", 403)

    async def _read_attachment(
        self, principal: PersistencePrincipal, workspace_id: str, digest: str
    ) -> bytes:
        if not _SHA256.fullmatch(digest):
            raise ConversationRuntimeError("RESEARCH_ARTIFACT_INVALID", 422)
        metadata, path = await asyncio.to_thread(
            self._work.get_attachment,
            principal.organization_id,
            workspace_id,
            digest,
            actor_id=principal.actor_id,
            actor_private_scope=True,
        )
        if metadata.get("sha256") != digest or metadata.get("size", 0) > _MAX_ATTACHMENT_BYTES:
            raise ConversationRuntimeError("RESEARCH_ARTIFACT_READBACK_MISMATCH", 409)
        data = await asyncio.to_thread(_read_bounded_file, path)
        if len(data) != metadata.get("size") or _sha256(data) != digest:
            raise ConversationRuntimeError("RESEARCH_ARTIFACT_READBACK_MISMATCH", 409)
        return data

    async def _read_duplicate(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        request: ConversationResearchRequest,
        operation: Mapping[str, Any],
    ) -> ConversationRuntimeResult:
        if (
            operation.get("taskId") != request.task_id
            or operation.get("operationType") != "conversation.research.read.v1"
            or operation.get("status") != "verified"
        ):
            raise ConversationRuntimeError(
                "RESEARCH_OPERATION_OUTCOME_UNKNOWN", 409, retryable=True
            )
        evidence = operation.get("evidence")
        if not isinstance(evidence, Mapping):
            raise ConversationRuntimeError("RESEARCH_OPERATION_RECEIPT_INVALID", 409)
        if evidence.get("outcome") != "verified" or evidence.get("readbackVerified") is not True:
            error_code = evidence.get("errorCode")
            raise ConversationRuntimeError(
                error_code if isinstance(error_code, str) else "RESEARCH_PREVIOUS_ATTEMPT_FAILED",
                409,
            )
        artifact_id = evidence.get("artifactId")
        expected_result_sha = evidence.get("resultSha256")
        if (
            not isinstance(artifact_id, str)
            or not _SHA256.fullmatch(artifact_id)
            or artifact_id != expected_result_sha
            or evidence.get("sourceRefs") != [dict(ref) for ref in request.scope.source_refs]
        ):
            raise ConversationRuntimeError("RESEARCH_OPERATION_RECEIPT_INVALID", 409)
        raw = await self._read_attachment(principal, workspace_id, artifact_id)
        try:
            stored = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ConversationRuntimeError("RESEARCH_ARTIFACT_READBACK_MISMATCH", 409) from None
        if not isinstance(stored, Mapping):
            raise ConversationRuntimeError("RESEARCH_ARTIFACT_READBACK_MISMATCH", 409)
        title = stored.get("title")
        content = stored.get("content")
        sources = stored.get("sourceEvidence")
        if (
            not isinstance(title, str)
            or not isinstance(content, str)
            or not isinstance(sources, list)
            or not sources
            or sources != evidence.get("sourceEvidence")
            or evidence.get("readbackSha256") != evidence.get("resultSha256")
            or _sha256(content.encode("utf-8")) != evidence.get("contentSha256")
        ):
            raise ConversationRuntimeError("RESEARCH_ARTIFACT_READBACK_MISMATCH", 409)
        return ConversationRuntimeResult(
            operation_id=str(operation["id"]),
            title=title,
            content=content,
            result_sha256=artifact_id,
            content_sha256=str(evidence["contentSha256"]),
            source_evidence=tuple(item for item in sources if isinstance(item, Mapping)),
            artifact_id=artifact_id,
        )

    async def _finish_failed(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        operation: Mapping[str, Any],
        code: str,
    ) -> None:
        await self._finish_operation(
            principal,
            workspace_id,
            operation,
            "verified",
            {"outcome": "failed", "effect": "read", "errorCode": code},
        )

    async def _finish_uncertain(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        operation: Mapping[str, Any],
        code: str,
    ) -> None:
        await self._finish_operation(
            principal,
            workspace_id,
            operation,
            "uncertain",
            {"outcome": "uncertain", "effect": "read", "errorCode": code},
        )

    async def _finish_operation(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        operation: Mapping[str, Any],
        status: str,
        evidence: Mapping[str, Any],
    ) -> None:
        try:
            await asyncio.shield(
                asyncio.to_thread(
                    self._work.update_operation,
                    principal.organization_id,
                    workspace_id,
                    str(operation["id"]),
                    status,
                    evidence,
                    actor_id=principal.actor_id,
                    actor_private_scope=principal.actor_private_scope,
                )
            )
        except Exception:
            # The original error remains authoritative; an untransitioned Work
            # Operation is left for normal Work reconciliation instead of masking it.
            return

    @staticmethod
    def _raise_if_cancelled(cancelled: Any) -> None:
        if cancelled is None:
            return
        is_set = getattr(cancelled, "is_set", None)
        if (callable(is_set) and is_set()) or getattr(cancelled, "cancelled", False):
            raise asyncio.CancelledError


def _decode_tool_result(value: Any) -> Mapping[str, Any]:
    """Decode either a Navigator-projected mapping or the canonical JSON tool envelope."""

    if not isinstance(value, Mapping):
        raise ConversationRuntimeError("PUBLIC_WEB_RESPONSE_INVALID", 502)
    candidate: Any = value
    outcome = value.get("outcome")
    if isinstance(outcome, Mapping):
        if outcome.get("isError") is True or outcome.get("is_error") is True:
            candidate = _envelope_json(outcome)
            if not isinstance(candidate, Mapping):
                raise ConversationRuntimeError("PUBLIC_WEB_PROVIDER_FAILED", 502, retryable=True)
            error = candidate.get("error")
            code = error.get("code") if isinstance(error, Mapping) else None
            if not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9_]{1,128}", code):
                code = "PUBLIC_WEB_PROVIDER_FAILED"
            raise ConversationRuntimeError(
                code,
                503
                if code in {"NOT_CONFIGURED", "PARSER_BUSY", "PUBLIC_HTTP_UNAVAILABLE"}
                else 502,
                retryable=True,
            )
        candidate = _envelope_json(outcome)
    elif "error" in value:
        error = value.get("error")
        code = error.get("code") if isinstance(error, Mapping) else None
        if not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9_]{1,128}", code):
            code = "PUBLIC_WEB_PROVIDER_FAILED"
        raise ConversationRuntimeError(
            code, 503 if code == "NOT_CONFIGURED" else 502, retryable=True
        )
    if isinstance(candidate, Mapping) and isinstance(candidate.get("result"), Mapping):
        candidate = candidate["result"]
    if not isinstance(candidate, Mapping):
        raise ConversationRuntimeError("PUBLIC_WEB_RESPONSE_INVALID", 502)
    return candidate


async def _await_tool_call(
    awaitable: Any,
    *,
    cancelled: Any,
    timeout_seconds: float,
) -> Any:
    """Poll host cancellation while a fixed DirectPlugin call is in flight."""

    task = asyncio.ensure_future(awaitable)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_seconds
    try:
        while True:
            ConversationResearchRuntime._raise_if_cancelled(cancelled)
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise TimeoutError
            done, _pending = await asyncio.wait({task}, timeout=min(0.1, remaining))
            if task in done:
                return task.result()
    except BaseException:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        raise


def _envelope_json(outcome: Mapping[str, Any]) -> Any:
    content = outcome.get("content")
    if not isinstance(content, list) or not content:
        return None
    first = content[0]
    if not isinstance(first, Mapping):
        return None
    json_value = first.get("json")
    raw = json_value.get("json") if isinstance(json_value, Mapping) else json_value
    if isinstance(raw, Mapping):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, Mapping) else None
    return None


def _document_page_text(pages: Sequence[Mapping[str, Any]]) -> str:
    chunks: list[str] = []
    for page in pages:
        blocks = page.get("blocks")
        if not isinstance(blocks, list) or len(blocks) > 100:
            raise ConversationRuntimeError("DOCUMENT_RESPONSE_INVALID", 502)
        for block in blocks:
            if isinstance(block, Mapping) and isinstance(block.get("text"), str):
                text = block["text"].strip()
                if text:
                    chunks.append(text)
                if sum(len(item) for item in chunks) > _MAX_RESULT_CHARS:
                    raise ConversationRuntimeError("RESEARCH_RESULT_TOO_LARGE", 413)
    return "\n\n".join(chunks)


def _render_sources(sources: Sequence[_FetchedSource]) -> str:
    parts: list[str] = []
    current_length = 0
    for source in sources[:_MAX_SOURCE_COUNT]:
        locator = source.url or f"Work attachment sha256:{source.artifact_id}"
        excerpt = source.content[: min(120_000, _MAX_RESULT_CHARS - current_length)]
        if not excerpt:
            continue
        part = (
            f"# {source.title}\nSource: {locator}\n"
            f"Source SHA-256: {source.source_sha256}\n\n{excerpt}"
        )
        parts.append(part)
        current_length += len(part)
        if current_length >= _MAX_RESULT_CHARS:
            break
    return "\n\n---\n\n".join(parts)


def _source_evidence(source: _FetchedSource, retrieved_at: datetime) -> Mapping[str, Any]:
    if (
        source.kind not in {"web", "document"}
        or not _SOURCE_REF.fullmatch(source.source_ref)
        or not _SHA256.fullmatch(source.source_sha256)
    ):
        raise ConversationRuntimeError("RESEARCH_SOURCE_EVIDENCE_INVALID", 502)
    iso_time = retrieved_at.astimezone(UTC).isoformat().replace("+00:00", "Z")
    value: dict[str, Any] = {
        "sourceRef": source.source_ref,
        "kind": source.kind,
        "title": source.title[:512],
        "sourceSha256": source.source_sha256,
        "retrievedAt": iso_time,
    }
    if source.url is not None:
        if not source.url.startswith("https://") or len(source.url) > 4_096:
            raise ConversationRuntimeError("RESEARCH_SOURCE_EVIDENCE_INVALID", 502)
        value["url"] = source.url
    if source.artifact_id is not None:
        if not _SHA256.fullmatch(source.artifact_id):
            raise ConversationRuntimeError("RESEARCH_SOURCE_EVIDENCE_INVALID", 502)
        value["artifactId"] = source.artifact_id
    return value


def _canonical_json(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise ConversationRuntimeError("RESEARCH_RESULT_INVALID", 422) from None


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _read_bounded_file(path: Path) -> bytes:
    import os
    import stat

    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        with os.fdopen(descriptor, "rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise ConversationRuntimeError("RESEARCH_ARTIFACT_READBACK_MISMATCH", 409)
            value = source.read(_MAX_ATTACHMENT_BYTES + 1)
    except OSError:
        raise ConversationRuntimeError("RESEARCH_ARTIFACT_READBACK_MISMATCH", 409) from None
    if len(value) > _MAX_ATTACHMENT_BYTES:
        raise ConversationRuntimeError("RESEARCH_ARTIFACT_READBACK_MISMATCH", 409)
    return value


def _safe_error_code(error: BaseException) -> str:
    code = getattr(error, "code", None)
    if isinstance(code, str) and re.fullmatch(r"[A-Z0-9_]{1,128}", code):
        return code
    return "WORK_RUNTIME_FAILURE"
