"""
┌─────────────────────────────────────────────────────────────────────────┐
│ 📄 routes.py                                                            │
│ Module: cyrene_navigator.work.conversation_peripheral.routes             │
│ Role: Authenticated REST adapters for fixed media, speech, Bilibili,    │
│       backups, and the local Work artifact bridge.                      │
│                                                                         │
│ 模块职责：提供媒体、语音、B站、备份和Work附件桥接REST路由。             │
│ · Principal由宿主注入；模型和浏览器无法选择binding或凭据。               │
└─────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import hashlib
import json
import os
import re
import stat
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from urllib.parse import quote
from uuid import UUID, uuid4

from fastapi import FastAPI, Header, Query, Request, Response

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_artifact_bridge.models import ArtifactReadGrant
from cyrene_navigator.work.conversation_artifact_bridge.registry import (
    ActiveCallLease,
    actor_scope_sha256,
    canonical_arguments_sha256,
)
from cyrene_navigator.work.conversation_artifact_bridge.routes import (
    mount_conversation_artifact_bridge,
)
from cyrene_navigator.work.models import (
    AttachmentRecord,
)
from cyrene_navigator.work.store import WorkStore

from .identity import bilibili_operation_idempotency_key
from .models import (
    BackupReceipt,
    BilibiliAccount,
    BilibiliAccountList,
    BilibiliConnection,
    BilibiliConnectionList,
    BilibiliLinkStart,
    BilibiliLinkStatus,
    BilibiliLinkStatusRequest,
    BilibiliOperationList,
    BilibiliOperationReceipt,
    BilibiliReadRequest,
    BilibiliWriteRequest,
    MediaAsset,
    MediaAssetDeleteReceipt,
    MediaAssetImport,
    MediaAssetPage,
    MediaAssetRead,
    MediaCardRender,
    PeripheralEmptyRequest,
    SpeechConfig,
    SpeechConfigUpdate,
    SpeechStatus,
    SpeechTranscription,
    SpeechTranscriptionRequest,
)
from .ports import (
    ArtifactBridgeConfig,
    ExchangeBilibiliHttpError,
    ExchangeBilibiliPort,
    FixedToolBinding,
    PeripheralPortError,
    PeripheralPorts,
)

_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_MEDIA_TYPE = re.compile(r"[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+\Z")
_MAX_ATTACHMENT_BYTES = 10_000_000
_MAX_BILIBILI_RESULT_BYTES = 1_500_000
_IMAGE_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
_AUDIO_MIME_TYPES = frozenset(
    {"audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm", "audio/x-wav"}
)
_BILIBILI_READ_OPERATIONS = (
    "bilibili.search",
    "bilibili.user.find",
    "bilibili.video.read",
    "bilibili.comments.list",
    "bilibili.dynamics.list",
    "bilibili.dynamic.read",
    "bilibili.dm.list",
    "bilibili.dm.read",
)
_BILIBILI_WRITE_OPERATIONS = (
    "bilibili.comment.create",
    "bilibili.dynamic.publish",
    "bilibili.dm.send",
)
_BILIBILI_TASK_HEADER = "X-Cyrene-Work-Task-Id"
_BILIBILI_TASK_SOURCES = frozenset(
    {"conversation-bili-operation", "conversation-bili-subscription-read"}
)


PrincipalFor = Callable[..., PersistencePrincipal]


@dataclass(frozen=True, slots=True)
class _BilibiliChildTask:
    """A verified running actor-private Task authorized for one exact Bili call."""

    task_id: str
    source: str
    profile_ref: str
    idempotency_key: str
    resource_ref: str
    target: Mapping[str, Any]
    operation_request: Mapping[str, Any]


def mount_peripheral_routes(
    app: FastAPI,
    base: str,
    principal_for: PrincipalFor,
    store: WorkStore,
    ports: PeripheralPorts,
) -> None:
    """Mount authenticated peripheral routes on the canonical Work host.

    Reads and mutations always derive organization, workspace, and actor from
    ``principal_for``. Optional capability ports fail closed when unconfigured.
    中文：所有Scope均从宿主Principal派生；未配置端口时明确不可用。
    """

    @app.get(base + "/media/assets", response_model=MediaAssetPage)
    async def search_media_assets(
        workspace_id: str,
        request: Request,
        q: str = Query(default="", max_length=128),
        cursor: str | None = Query(default=None, max_length=256),
        limit: int = Query(default=20, ge=1, le=20),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        binding = _require_binding(ports.media, "MEDIA_PROVIDER_UNAVAILABLE")
        result = await _invoke_tool(
            binding,
            "media.asset.search",
            {"query": q, "limit": limit, "cursor": cursor},
            principal=principal,
            workspace_id=workspace_id,
            request_id=_request_id(request),
        )
        return _validate_provider_model(MediaAssetPage, result)

    @app.post(base + "/media/assets/import", response_model=MediaAsset, status_code=201)
    async def import_media_asset(
        workspace_id: str, body: MediaAssetImport, request: Request, response: Response
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        selected_attachment, _ = _read_attachment(
            store,
            principal,
            workspace_id,
            body.attachment_digest,
            accepted_types=_IMAGE_MIME_TYPES,
        )
        binding = _require_binding(ports.media, "MEDIA_PROVIDER_UNAVAILABLE")
        arguments = {
            "artifact_id": body.attachment_digest,
            "title": body.title,
            "alt_text": body.alt_text,
            "tags": body.tags,
        }

        def project_import(
            result: Mapping[str, Any], _lease: ActiveCallLease
        ) -> tuple[dict[str, Any], Mapping[str, Any]]:
            asset = _validate_provider_model(MediaAsset, result)
            _validate_asset_attachment(asset, selected_attachment, body.attachment_digest)
            return asset, {}

        asset = await _invoke_artifact_tool(
            binding,
            "media.asset.import",
            arguments,
            principal=principal,
            workspace_id=workspace_id,
            request_id=_request_id(request),
            store=store,
            bridge=ports.artifact_bridge,
            read_grants=(
                ArtifactReadGrant(
                    body.attachment_digest,
                    "human_selection",
                    frozenset(_IMAGE_MIME_TYPES),
                ),
            ),
            projector=project_import,
        )
        response.status_code = 201
        return asset

    @app.get(base + "/media/assets/{asset_id}", response_model=MediaAssetRead)
    async def get_media_asset(workspace_id: str, asset_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        binding = _require_binding(ports.media, "MEDIA_PROVIDER_UNAVAILABLE")

        def project_asset_read(
            result: Mapping[str, Any], lease: ActiveCallLease
        ) -> tuple[dict[str, Any], Mapping[str, Any]]:
            value = _json_object(result, "MEDIA_PROVIDER_INVALID_PAYLOAD")
            asset = _validate_provider_model(MediaAsset, value.get("asset"))
            artifact = _json_object(value.get("artifact"), "MEDIA_PROVIDER_INVALID_PAYLOAD")
            digest = artifact.get("sha256")
            if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
                raise _provider_payload_error("MEDIA_PROVIDER_INVALID_PAYLOAD")
            bridge = _require_artifact_bridge(ports.artifact_bridge)
            bridge.registry.assert_output(lease, digest)
            attachment, _ = _read_attachment(
                store,
                principal,
                workspace_id,
                digest,
                accepted_types=_IMAGE_MIME_TYPES,
                actor_private_scope=True,
            )
            _validate_asset_attachment(asset, attachment, digest)
            return (
                {
                    "asset": asset,
                    "attachment": attachment,
                    "downloadPath": _workspace_route_path(
                        base,
                        workspace_id,
                        f"/media/assets/{quote(asset_id, safe='')}/attachment",
                    ),
                },
                {"artifactSha256": digest},
            )

        return await _invoke_artifact_tool(
            binding,
            "media.asset.get",
            {"asset_id": asset_id},
            principal=principal,
            workspace_id=workspace_id,
            request_id=_request_id(request),
            store=store,
            bridge=ports.artifact_bridge,
            write_mime_types=_IMAGE_MIME_TYPES,
            projector=project_asset_read,
        )

    @app.get(base + "/media/assets/{asset_id}/attachment", response_model=None)
    async def download_media_asset(workspace_id: str, asset_id: str, request: Request) -> Response:
        principal = principal_for(request, workspace_id)

        def project_asset_download(
            result: Mapping[str, Any], lease: ActiveCallLease
        ) -> tuple[Response, Mapping[str, Any]]:
            value = _json_object(result, "MEDIA_PROVIDER_INVALID_PAYLOAD")
            asset = _validate_provider_model(MediaAsset, value.get("asset"))
            artifact = _json_object(value.get("artifact"), "MEDIA_PROVIDER_INVALID_PAYLOAD")
            digest = artifact.get("sha256")
            if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
                raise _provider_payload_error("MEDIA_PROVIDER_INVALID_PAYLOAD")
            bridge = _require_artifact_bridge(ports.artifact_bridge)
            bridge.registry.assert_output(lease, digest)
            attachment, data = _read_attachment(
                store,
                principal,
                workspace_id,
                digest,
                accepted_types=_IMAGE_MIME_TYPES,
                actor_private_scope=True,
            )
            _validate_asset_attachment(asset, attachment, digest)
            return _attachment_response(attachment, data), {"artifactSha256": digest}

        return await _invoke_artifact_tool(
            _require_binding(ports.media, "MEDIA_PROVIDER_UNAVAILABLE"),
            "media.asset.get",
            {"asset_id": asset_id},
            principal=principal,
            workspace_id=workspace_id,
            request_id=_request_id(request),
            store=store,
            bridge=ports.artifact_bridge,
            write_mime_types=_IMAGE_MIME_TYPES,
            projector=project_asset_download,
        )

    @app.delete(base + "/media/assets/{asset_id}", response_model=MediaAssetDeleteReceipt)
    async def delete_media_asset(
        workspace_id: str, asset_id: str, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        result = await _invoke_tool(
            _require_binding(ports.media, "MEDIA_PROVIDER_UNAVAILABLE"),
            "media.asset.delete",
            {"asset_id": asset_id},
            principal=principal,
            workspace_id=workspace_id,
            request_id=_request_id(request),
        )
        return _validate_provider_model(MediaAssetDeleteReceipt, result)

    @app.post(base + "/media/assets/{asset_id}/restore", response_model=MediaAsset)
    async def restore_media_asset(
        workspace_id: str, asset_id: str, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        result = await _invoke_tool(
            _require_binding(ports.media, "MEDIA_PROVIDER_UNAVAILABLE"),
            "media.asset.restore",
            {"asset_id": asset_id},
            principal=principal,
            workspace_id=workspace_id,
            request_id=_request_id(request),
        )
        return _validate_provider_model(MediaAsset, result)

    @app.post(base + "/media/cards/render", response_model=MediaAssetRead, status_code=201)
    async def render_media_card(
        workspace_id: str, body: MediaCardRender, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)

        def project_card_render(
            result: Mapping[str, Any], lease: ActiveCallLease
        ) -> tuple[dict[str, Any], Mapping[str, Any]]:
            value = _json_object(result, "MEDIA_PROVIDER_INVALID_PAYLOAD")
            asset = _validate_provider_model(MediaAsset, value.get("asset"))
            artifact = _json_object(value.get("artifact"), "MEDIA_PROVIDER_INVALID_PAYLOAD")
            digest = artifact.get("sha256")
            if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
                raise _provider_payload_error("MEDIA_PROVIDER_INVALID_PAYLOAD")
            bridge = _require_artifact_bridge(ports.artifact_bridge)
            bridge.registry.assert_output(lease, digest)
            attachment, _ = _read_attachment(
                store,
                principal,
                workspace_id,
                digest,
                accepted_types={"image/png"},
                actor_private_scope=True,
            )
            _validate_asset_attachment(asset, attachment, digest)
            return (
                {
                    "asset": asset,
                    "attachment": attachment,
                    "downloadPath": _workspace_route_path(
                        base,
                        workspace_id,
                        f"/media/assets/{quote(str(asset.get('assetId')), safe='')}/attachment",
                    ),
                },
                {"artifactSha256": digest},
            )

        return await _invoke_artifact_tool(
            _require_binding(ports.media, "MEDIA_PROVIDER_UNAVAILABLE"),
            "media.card.render",
            {"title": body.title, "body": body.content, "theme": body.theme},
            principal=principal,
            workspace_id=workspace_id,
            request_id=_request_id(request),
            store=store,
            bridge=ports.artifact_bridge,
            write_mime_types={"image/png"},
            projector=project_card_render,
        )

    @app.get(base + "/speech/config", response_model=SpeechConfig)
    async def get_speech_config(workspace_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        port = _require_port(ports.speech, "SPEECH_PROVIDER_UNAVAILABLE")
        result = await invoke_port(port.get_config, principal=principal, workspace_id=workspace_id)
        return _validate_provider_model(SpeechConfig, result)

    @app.put(base + "/speech/config", response_model=SpeechConfig)
    async def update_speech_config(
        workspace_id: str, body: SpeechConfigUpdate, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        port = _require_port(ports.speech, "SPEECH_PROVIDER_UNAVAILABLE")
        result = await invoke_port(
            port.update_config,
            body.model_dump(exclude_none=True),
            principal=principal,
            workspace_id=workspace_id,
        )
        return _validate_provider_model(SpeechConfig, result)

    @app.get(base + "/speech/status", response_model=SpeechStatus)
    async def speech_status(workspace_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        port = _require_port(ports.speech, "SPEECH_PROVIDER_UNAVAILABLE")
        result = await invoke_port(port.status, principal=principal, workspace_id=workspace_id)
        return _validate_provider_model(SpeechStatus, result)

    @app.post(base + "/speech/transcriptions", response_model=SpeechTranscription)
    async def transcribe_attachment(
        workspace_id: str, body: SpeechTranscriptionRequest, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        attachment, data = _read_attachment(
            store,
            principal,
            workspace_id,
            body.attachment_digest,
            accepted_types=_AUDIO_MIME_TYPES,
        )
        if attachment.size > _MAX_ATTACHMENT_BYTES:
            raise PersistenceError(
                "WORK_ATTACHMENT_INVALID_SIZE", 413, "Speech attachment exceeds 10 MB."
            )
        port = _require_port(ports.speech, "SPEECH_PROVIDER_UNAVAILABLE")
        result = await invoke_port(
            port.transcribe,
            data=data,
            mime_type=attachment.media_type,
            language_hint=body.language_hint,
            principal=principal,
            workspace_id=workspace_id,
            request_id=_request_id(request),
        )
        return _validate_provider_model(SpeechTranscription, result)

    @app.get(base + "/bilibili/accounts", response_model=BilibiliAccountList)
    async def list_bilibili_accounts(workspace_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        port = _bilibili_exchange_port(ports)
        result = _json_object(
            await _call_bilibili_exchange(
                port.list_owned_provider_profiles, principal, workspace_id
            ),
            "EXCHANGE_PROFILE_INVALID_PAYLOAD",
        )
        raw_profiles = result.get("profiles")
        if not isinstance(raw_profiles, list):
            raise _provider_payload_error("EXCHANGE_PROFILE_INVALID_PAYLOAD")
        profiles = [
            _project_bilibili_profile(raw) for raw in raw_profiles if _is_bilibili_profile(raw)
        ]
        return {"items": profiles}

    @app.get(base + "/bilibili/connections", response_model=BilibiliConnectionList)
    async def list_bilibili_connections(workspace_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        result = _json_object(
            await _call_bilibili_exchange(
                _bilibili_exchange_port(ports).list_owned_connections,
                principal,
                workspace_id,
            ),
            "EXCHANGE_CONNECTION_RESPONSE_INVALID",
        )
        raw_connections = result.get("connections")
        if not isinstance(raw_connections, list):
            raise _provider_payload_error("EXCHANGE_CONNECTION_RESPONSE_INVALID")
        safe_items: list[dict[str, Any]] = []
        for raw in raw_connections:
            item = _mapping_view(raw)
            if item is None or _value(item, "provider") != "bilibili":
                continue
            safe_items.append(
                _validate_provider_model(
                    BilibiliConnection,
                    {
                        "connection_ref": _exchange_uuid_ref(
                            _value(item, "connection_ref", "connectionRef", "id"),
                            "EXCHANGE_CONNECTION_RESPONSE_INVALID",
                        ),
                        "profile_ref": _exchange_uuid_ref(
                            _value(item, "profile_ref", "profileRef"),
                            "EXCHANGE_CONNECTION_RESPONSE_INVALID",
                        ),
                        "provider": "bilibili",
                        "display_name": _value(item, "display_name", "displayName") or "Bilibili",
                        "enabled": _value(item, "enabled") is True,
                    },
                )
            )
        return {"items": safe_items}

    @app.post(
        base + "/bilibili/accounts/link",
        response_model=BilibiliLinkStart,
        status_code=202,
    )
    async def begin_bilibili_link(
        workspace_id: str, _body: PeripheralEmptyRequest, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        idempotency_key = uuid4().hex
        value = _json_object(
            await _call_bilibili_exchange(
                _bilibili_exchange_port(ports).begin_qr,
                principal,
                workspace_id,
                idempotency_key=idempotency_key,
            ),
            "BILIBILI_PROVIDER_INVALID_PAYLOAD",
        )
        try:
            if value.get("status") != "PENDING":
                raise ValueError("QR begin must return PENDING")
            login_flow_id = value["loginFlowId"]
            qr_base64 = value["qrPngBase64"]
            digest = value["qrPngSha256"]
            expires_at = _parse_provider_expiry(value["expiresAt"])
            if (
                not isinstance(login_flow_id, str)
                or not re.fullmatch(r"[0-9a-f]{64}", login_flow_id)
                or not isinstance(qr_base64, str)
                or not isinstance(digest, str)
            ):
                raise ValueError("QR response fields are invalid")
            qr_png = base64.b64decode(qr_base64, validate=True)
            if (
                len(qr_png) > 1_000_000
                or not qr_png.startswith(b"\x89PNG\r\n\x1a\n")
                or hashlib.sha256(qr_png).hexdigest() != digest
            ):
                raise ValueError("QR digest invalid")
            return {
                "loginFlowId": login_flow_id,
                "qrCodeBase64": qr_base64,
                "qrCodeSha256": digest,
                "expiresAt": expires_at,
                "status": "pending",
            }
        except (KeyError, TypeError, ValueError):
            raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD") from None

    @app.post(base + "/bilibili/link-status", response_model=BilibiliLinkStatus)
    async def bilibili_link_status(
        workspace_id: str,
        body: BilibiliLinkStatusRequest,
        request: Request,
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        value = _json_object(
            await _call_bilibili_exchange(
                _bilibili_exchange_port(ports).poll_qr,
                principal,
                workspace_id,
                login_flow_id=body.login_flow_id,
            ),
            "BILIBILI_PROVIDER_INVALID_PAYLOAD",
        )
        status = str(value.get("status", "")).lower()
        allowed = {
            "pending",
            "scanned",
            "linked",
            "expired",
            "failed",
            "unknown_result",
            "not_found",
        }
        if status not in allowed:
            raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD")
        safe_profile: dict[str, Any] | None = None
        profile_value = value.get("profile")
        if status == "linked":
            safe_profile = _project_bilibili_profile(profile_value)
        return {
            "status": status,
            "loginFlowId": body.login_flow_id,
            "profile": safe_profile,
            "reloginRequired": False,
        }

    @app.get(
        base + "/bilibili/connections/{connection_ref}/read-operations",
        response_model=BilibiliOperationList,
    )
    async def bilibili_read_operations(
        workspace_id: str, connection_ref: str, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        await _require_bilibili_connection(
            _bilibili_exchange_port(ports), principal, workspace_id, connection_ref
        )
        return {
            "readOperations": list(_BILIBILI_READ_OPERATIONS),
            "writeOperations": list(_BILIBILI_WRITE_OPERATIONS),
        }

    @app.get(
        base + "/bilibili/operations/by-idempotency-key",
        response_model=BilibiliOperationReceipt,
    )
    async def get_bilibili_operation_by_idempotency_key(
        workspace_id: str,
        request: Request,
        response: Response,
        idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=200),
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        task_id = request.headers.get(_BILIBILI_TASK_HEADER.lower())
        task_source: str | None = None
        if task_id is not None:
            task_source, task_metadata = _require_bilibili_task_for_lookup(
                store,
                principal,
                workspace_id,
                task_id,
                idempotency_key,
            )
        effective_key = _bilibili_effective_operation_key(principal, workspace_id, idempotency_key)
        lookup = getattr(store, "get_operation_by_idempotency_key", None)
        if not callable(lookup):
            raise PersistenceError(
                "WORK_OPERATION_LOOKUP_UNAVAILABLE",
                503,
                "Work operation lookup is unavailable.",
                True,
            )
        try:
            operation = lookup(
                principal.organization_id,
                workspace_id,
                effective_key,
                actor_id=principal.actor_id,
                actor_private_scope=principal.actor_private_scope,
            )
        except PersistenceError as error:
            if error.code == "WORK_OPERATION_NOT_FOUND":
                raise PersistenceError(
                    "BILIBILI_OPERATION_NOT_FOUND", 404, "Bilibili operation not found."
                ) from None
            raise
        operation_request = operation.get("request")
        stored_operation_id = (
            operation_request.get("operationId") if isinstance(operation_request, Mapping) else None
        )
        if (
            not isinstance(operation_request, Mapping)
            or operation_request.get("actorScopeSha256")
            != actor_scope_sha256(principal, workspace_id)
            or stored_operation_id
            not in (
                _BILIBILI_WRITE_OPERATIONS
                if task_id is None
                else (*_BILIBILI_READ_OPERATIONS, *_BILIBILI_WRITE_OPERATIONS)
            )
            or operation.get("operationType") != f"tool.provider.v1:{stored_operation_id}"
            or not isinstance(operation_request.get("argumentsSha256"), str)
            or _DIGEST.fullmatch(operation_request["argumentsSha256"]) is None
            or not isinstance(operation_request.get("connectionRefDigest"), str)
            or _DIGEST.fullmatch(operation_request["connectionRefDigest"]) is None
        ):
            raise PersistenceError(
                "BILIBILI_OPERATION_NOT_FOUND", 404, "Bilibili operation not found."
            )
        if task_id is not None:
            operation_request = operation.get("request")
            if (
                task_source not in _BILIBILI_TASK_SOURCES
                or operation.get("taskId") != task_id
                or operation.get("trustedProducer") != "exchange-connector-dispatch"
                or not isinstance(operation_request, Mapping)
                or operation_request.get("source") != task_source
                or operation_request.get("taskId") != task_id
                or operation_request.get("idempotencyKey") != idempotency_key
                or operation_request.get("actorScopeSha256")
                != actor_scope_sha256(principal, workspace_id)
                or not _bilibili_task_metadata_matches_operation(
                    task_metadata, operation_request, idempotency_key
                )
            ):
                raise PersistenceError(
                    "BILIBILI_OPERATION_NOT_FOUND", 404, "Bilibili operation not found."
                )
            artifact = _bilibili_result_artifact_from_operation(
                store,
                principal,
                workspace_id,
                operation,
                _BilibiliChildTask(
                    task_id=task_id,
                    source=task_source,
                    profile_ref=str(operation_request.get("profileRef") or ""),
                    idempotency_key=idempotency_key,
                    resource_ref=str(operation_request.get("resourceRef") or ""),
                    target={},
                    operation_request=operation_request,
                ),
            )
            evidence = operation.get("evidence")
            outcome = evidence.get("outcome") if isinstance(evidence, Mapping) else None
            response.status_code = (
                202
                if operation.get("status") in {"started", "uncertain"}
                or outcome in {"pending", "uncertain"}
                else 200
            )
            return {
                "operation": operation,
                "resultArtifact": artifact,
                "duplicate": True,
            }
        return {"operation": operation, "resultArtifact": None, "duplicate": True}

    @app.post(base + "/bilibili/connections/{connection_ref}/reads/{operation_id}")
    async def bilibili_read(
        workspace_id: str,
        connection_ref: str,
        operation_id: str,
        body: BilibiliReadRequest,
        request: Request,
        response: Response,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key", max_length=200),
    ) -> dict[str, Any]:
        if operation_id not in _BILIBILI_READ_OPERATIONS:
            raise PersistenceError(
                "BILIBILI_OPERATION_NOT_FOUND", 404, "Read operation unavailable."
            )
        principal = principal_for(request, workspace_id)
        task = _require_bilibili_child_task(
            store,
            principal,
            workspace_id,
            request,
            connection_ref=connection_ref,
            operation_id=operation_id,
            arguments=body.arguments,
            idempotency_key=idempotency_key,
        )
        port = _bilibili_exchange_port(ports)
        connection = await _require_bilibili_connection(
            port, principal, workspace_id, connection_ref
        )
        normalized_connection = str(UUID(connection_ref))
        profile_ref = _value(connection, "profile_ref", "profileRef")
        if task is not None and profile_ref != task.profile_ref:
            raise _bilibili_task_metadata_error()

        work_operation: dict[str, Any] | None = None
        operation_duplicate = False
        if task is not None:
            effective_key = _bilibili_effective_operation_key(
                principal, workspace_id, task.idempotency_key
            )
            actor_scope = actor_scope_sha256(principal, workspace_id)
            connection_digest = hashlib.sha256(normalized_connection.encode()).hexdigest()
            connection_scope = hashlib.sha256(
                f"{actor_scope}\0{connection_digest}".encode()
            ).hexdigest()
            work_operation, operation_duplicate = _create_bilibili_work_operation(
                store,
                principal,
                workspace_id,
                {
                    "idempotencyKey": effective_key,
                    "operationType": f"tool.provider.v1:{operation_id}",
                    "taskId": task.task_id,
                    "target": f"connector-target:{connection_scope}",
                    "request": {
                        **dict(task.operation_request),
                        "connectionRef": normalized_connection,
                        "profileRef": task.profile_ref,
                    },
                },
                task,
            )
            if operation_duplicate:
                artifact = _bilibili_result_artifact_from_operation(
                    store, principal, workspace_id, work_operation, task
                )
                evidence = work_operation.get("evidence")
                operation_outcome = (
                    evidence.get("outcome") if isinstance(evidence, Mapping) else None
                )
                response.status_code = (
                    202
                    if work_operation.get("status") in {"started", "uncertain"}
                    or operation_outcome in {"pending", "uncertain"}
                    else 200
                )
                return {
                    "operation": work_operation,
                    "resultArtifact": artifact,
                    "duplicate": True,
                }
        try:
            envelope = await invoke_port(
                port.invoke_operation,
                principal,
                workspace_id,
                connection_ref=connection_ref,
                operation_id=operation_id,
                arguments=body.arguments,
                work_operation_id=None,
            )
        except ExchangeBilibiliHttpError as error:
            if task is not None and work_operation is not None:
                failure_evidence = {
                    **dict(task.operation_request),
                    "effect": "read",
                    "outcome": "uncertain" if error.side_effect_possible else "failed",
                    "providerId": "bilibili",
                    "connectionRef": normalized_connection,
                    "profileRef": task.profile_ref,
                    "operationId": operation_id,
                    "resourceRef": task.resource_ref,
                    "argumentsSha256": task.operation_request["argumentsSha256"],
                    "resultArtifactId": None,
                    "resultSha256": None,
                    "readbackVerified": False,
                    "externalReadbackVerified": False,
                    "errorCode": error.code,
                }
                _update_bilibili_work_operation(
                    store,
                    principal,
                    workspace_id,
                    str(work_operation["id"]),
                    "uncertain" if error.side_effect_possible else "verified",
                    failure_evidence,
                    task,
                )
            raise _exchange_error(error) from None
        except PeripheralPortError as error:
            if task is not None and work_operation is not None:
                failure_evidence = {
                    **dict(task.operation_request),
                    "effect": "read",
                    "outcome": "uncertain" if error.side_effect_possible else "failed",
                    "providerId": "bilibili",
                    "connectionRef": normalized_connection,
                    "profileRef": task.profile_ref,
                    "operationId": operation_id,
                    "resourceRef": task.resource_ref,
                    "argumentsSha256": task.operation_request["argumentsSha256"],
                    "resultArtifactId": None,
                    "resultSha256": None,
                    "readbackVerified": False,
                    "externalReadbackVerified": False,
                    "errorCode": error.code,
                }
                _update_bilibili_work_operation(
                    store,
                    principal,
                    workspace_id,
                    str(work_operation["id"]),
                    "uncertain" if error.side_effect_possible else "verified",
                    failure_evidence,
                    task,
                )
            status = 503 if error.unavailable else 502
            raise PersistenceError(
                error.code,
                status,
                "The configured Exchange connector service is unavailable.",
                error.unavailable,
            ) from None
        except Exception:
            if task is not None and work_operation is not None:
                failure_evidence = {
                    **dict(task.operation_request),
                    "effect": "read",
                    "outcome": "uncertain",
                    "providerId": "bilibili",
                    "connectionRef": normalized_connection,
                    "profileRef": task.profile_ref,
                    "operationId": operation_id,
                    "resourceRef": task.resource_ref,
                    "argumentsSha256": task.operation_request["argumentsSha256"],
                    "resultArtifactId": None,
                    "resultSha256": None,
                    "readbackVerified": False,
                    "externalReadbackVerified": False,
                    "errorCode": "EXCHANGE_RESULT_UNKNOWN",
                }
                _update_bilibili_work_operation(
                    store,
                    principal,
                    workspace_id,
                    str(work_operation["id"]),
                    "uncertain",
                    failure_evidence,
                    task,
                )
            raise PersistenceError(
                "BILIBILI_READ_UNAVAILABLE",
                502,
                "Exchange could not verify the Bilibili read result.",
                True,
            ) from None
        try:
            result = _project_bilibili_read_result(operation_id, envelope)
        except PersistenceError as error:
            if task is not None and work_operation is not None:
                failure_evidence = {
                    **dict(task.operation_request),
                    "effect": "read",
                    "outcome": "failed",
                    "providerId": "bilibili",
                    "connectionRef": normalized_connection,
                    "profileRef": task.profile_ref,
                    "operationId": operation_id,
                    "resourceRef": task.resource_ref,
                    "argumentsSha256": task.operation_request["argumentsSha256"],
                    "resultArtifactId": None,
                    "resultSha256": None,
                    "readbackVerified": False,
                    "externalReadbackVerified": False,
                    "errorCode": error.code,
                }
                _update_bilibili_work_operation(
                    store,
                    principal,
                    workspace_id,
                    str(work_operation["id"]),
                    "verified",
                    failure_evidence,
                    task,
                )
            raise
        if task is None or work_operation is None:
            return result
        try:
            result_artifact = _store_bilibili_result_artifact(
                store, principal, workspace_id, operation_id, result
            )
        except PersistenceError as error:
            evidence = {
                **dict(task.operation_request),
                "effect": "read",
                "outcome": "uncertain",
                "providerId": "bilibili",
                "connectionRef": normalized_connection,
                "profileRef": task.profile_ref,
                "operationId": operation_id,
                "resourceRef": task.resource_ref,
                "argumentsSha256": task.operation_request["argumentsSha256"],
                "resultArtifactId": None,
                "resultSha256": None,
                "readbackVerified": False,
                "externalReadbackVerified": False,
                "errorCode": error.code,
            }
            _update_bilibili_work_operation(
                store,
                principal,
                workspace_id,
                str(work_operation["id"]),
                "uncertain",
                evidence,
                task,
            )
            raise
        result_digest = result_artifact["sha256"]
        evidence = {
            **dict(task.operation_request),
            "effect": "read",
            "outcome": "verified",
            "providerId": "bilibili",
            "connectionRef": normalized_connection,
            "profileRef": task.profile_ref,
            "operationId": operation_id,
            "resourceRef": task.resource_ref,
            "argumentsSha256": task.operation_request["argumentsSha256"],
            "resultArtifactId": result_digest,
            "resultSha256": result_digest,
            "readbackVerified": True,
            "externalReadbackVerified": False,
        }
        operation, _ = _update_bilibili_work_operation(
            store,
            principal,
            workspace_id,
            str(work_operation["id"]),
            "verified",
            evidence,
            task,
        )
        response.status_code = 200
        return {
            "operation": operation,
            "resultArtifact": result_artifact,
            "duplicate": False,
        }

    @app.post(
        base + "/bilibili/connections/{connection_ref}/writes/{operation_id}",
        response_model=BilibiliOperationReceipt,
    )
    async def bilibili_write(
        workspace_id: str,
        connection_ref: str,
        operation_id: str,
        body: BilibiliWriteRequest,
        request: Request,
        response: Response,
        idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=200),
    ) -> dict[str, Any]:
        if operation_id not in _BILIBILI_WRITE_OPERATIONS:
            raise PersistenceError(
                "BILIBILI_OPERATION_NOT_FOUND", 404, "Write operation unavailable."
            )
        task_header_present = request.headers.get(_BILIBILI_TASK_HEADER.lower()) is not None
        principal = principal_for(request, workspace_id, write=not task_header_present)
        task = _require_bilibili_child_task(
            store,
            principal,
            workspace_id,
            request,
            connection_ref=connection_ref,
            operation_id=operation_id,
            arguments=body.arguments,
            idempotency_key=idempotency_key,
        )
        port = _bilibili_exchange_port(ports)
        connection = await _require_bilibili_connection(
            port, principal, workspace_id, connection_ref
        )
        connection_ref = str(UUID(connection_ref))
        profile_ref = _value(connection, "profile_ref", "profileRef")
        if task is not None and profile_ref != task.profile_ref:
            raise _bilibili_task_metadata_error()
        connection_digest = hashlib.sha256(connection_ref.encode()).hexdigest()
        actor_scope = actor_scope_sha256(principal, workspace_id)
        connection_scope = hashlib.sha256(
            f"{actor_scope}\0{connection_digest}".encode()
        ).hexdigest()
        effective_key = _bilibili_effective_operation_key(principal, workspace_id, idempotency_key)
        argument_digest = canonical_arguments_sha256(body.arguments)
        operation_request: dict[str, Any] = {
            "actorScopeSha256": actor_scope,
            "connectionRefDigest": connection_digest,
            "operationId": operation_id,
            "argumentsSha256": argument_digest,
        }
        if task is not None:
            operation_request.update(task.operation_request)
            operation_request["connectionRef"] = connection_ref
            operation_request["profileRef"] = task.profile_ref
        operation, duplicate = _create_bilibili_work_operation(
            store,
            principal,
            workspace_id,
            {
                "idempotencyKey": effective_key,
                "operationType": f"tool.provider.v1:{operation_id}",
                "taskId": task.task_id if task is not None else None,
                "target": f"connector-target:{connection_scope}",
                "request": operation_request,
            },
            task,
        )
        if duplicate:
            response.status_code = (
                202 if operation.get("status") in {"started", "uncertain"} else 200
            )
            return {"operation": operation, "resultArtifact": None, "duplicate": True}

        work_operation_id = str(UUID(str(operation["id"])))
        expected_operation_ref = f"work-operation:{work_operation_id}"
        try:
            envelope = await invoke_port(
                port.invoke_operation,
                principal,
                workspace_id,
                connection_ref=connection_ref,
                operation_id=operation_id,
                arguments=body.arguments,
                work_operation_id=work_operation_id,
            )
            exchange_outcome, provider_result = _exchange_operation_payload(envelope)
            evidence, final_status = _bilibili_write_evidence(
                provider_result,
                exchange_outcome,
                expected_operation_ref,
            )
            response.status_code = 202 if final_status == "uncertain" else 200
        except ExchangeBilibiliHttpError as error:
            if 400 <= (error.status_code or 0) < 500 or not error.side_effect_possible:
                evidence = {
                    "status": "REJECTED",
                    "receiptId": operation["id"],
                    "errorCode": error.code,
                    "replay": "NOT_REPLAYED",
                }
                final_status = "verified"
                response.status_code = 200
            else:
                evidence = {
                    "status": "UNKNOWN_RESULT",
                    "receiptId": operation["id"],
                    "errorCode": error.code,
                    "replay": "NOT_REPLAYED",
                }
                final_status = "uncertain"
                response.status_code = 202
        except PeripheralPortError as error:
            if error.side_effect_possible:
                evidence = {
                    "status": "UNKNOWN_RESULT",
                    "receiptId": operation["id"],
                    "errorCode": error.code,
                    "replay": "NOT_REPLAYED",
                }
                final_status = "uncertain"
                response.status_code = 202
            else:
                evidence = {
                    "status": "REJECTED",
                    "receiptId": operation["id"],
                    "errorCode": error.code,
                    "replay": "NOT_REPLAYED",
                }
                final_status = "verified"
                response.status_code = 200
        except Exception:
            # Failures after the Exchange dispatch may have followed an external side effect.
            evidence = {
                "status": "UNKNOWN_RESULT",
                "receiptId": operation["id"],
                "replay": "NOT_REPLAYED",
            }
            final_status = "uncertain"
            response.status_code = 202

        if task is not None:
            operation_outcome = (
                "uncertain"
                if final_status == "uncertain"
                else "failed"
                if evidence.get("status") == "REJECTED"
                else "verified"
            )
            evidence = {
                **dict(task.operation_request),
                **evidence,
                "effect": "write",
                "outcome": operation_outcome,
                "providerId": "bilibili",
                "connectionRef": connection_ref,
                "profileRef": task.profile_ref,
                "operationId": operation_id,
                "resourceRef": task.resource_ref,
                "argumentsSha256": argument_digest,
                "resultArtifactId": None,
                "resultSha256": _bilibili_json_sha256(evidence),
                "readbackVerified": evidence.get("readbackVerified") is True,
                "externalReadbackVerified": evidence.get("readbackVerified") is True,
            }

        updated, update_duplicate = _update_bilibili_work_operation(
            store,
            principal,
            workspace_id,
            str(operation["id"]),
            final_status,
            evidence,
            task,
        )
        return {
            "operation": updated,
            "resultArtifact": None,
            "duplicate": update_duplicate,
        }

    @app.post(base + "/backups", response_model=BackupReceipt, status_code=201)
    async def create_backup(
        workspace_id: str, _body: PeripheralEmptyRequest, request: Request
    ) -> dict[str, Any]:
        principal = principal_for(request, workspace_id, write=True)
        port = _require_port(ports.backup, "CONVERSATION_BACKUP_UNAVAILABLE")
        result = await invoke_port(
            port.create_backup, principal=principal, workspace_id=workspace_id
        )
        if not isinstance(result, tuple) or len(result) != 3:
            raise _provider_payload_error("CONVERSATION_BACKUP_INVALID_PAYLOAD")
        name, media_type, data = result
        if (
            not isinstance(name, str)
            or not isinstance(media_type, str)
            or not _MEDIA_TYPE.fullmatch(media_type)
            or not isinstance(data, bytes)
            or not data
            or len(data) > _MAX_ATTACHMENT_BYTES
        ):
            raise PersistenceError(
                "WORK_ATTACHMENT_INVALID_SIZE", 413, "Backup attachment exceeds 10 MB."
            )
        attachment = store.put_attachment(
            principal.organization_id,
            workspace_id,
            name,
            media_type,
            data,
            actor_id=principal.actor_id,
            actor_private_scope=True,
        )
        return {
            "attachment": attachment,
            "downloadPath": _workspace_route_path(
                base, workspace_id, f"/backups/attachments/{attachment['sha256']}"
            ),
        }

    @app.get(base + "/backups/attachments/{digest}", response_model=None)
    def download_backup_attachment(workspace_id: str, digest: str, request: Request) -> Response:
        principal = principal_for(request, workspace_id)
        attachment, data = _read_attachment(
            store,
            principal,
            workspace_id,
            digest,
            accepted_types=None,
            actor_private_scope=True,
        )
        return _attachment_response(attachment, data)

    mount_conversation_artifact_bridge(app, store, ports.artifact_bridge)


def _bilibili_exchange_port(ports: PeripheralPorts) -> ExchangeBilibiliPort:
    """Return the fixed Exchange delegation client or a typed unavailable error."""

    return cast(
        ExchangeBilibiliPort,
        _require_port(ports.bilibili_exchange, "EXCHANGE_BILIBILI_UNAVAILABLE"),
    )


def _require_bilibili_child_task(
    store: WorkStore,
    principal: PersistencePrincipal,
    workspace_id: str,
    request: Request,
    *,
    connection_ref: str,
    operation_id: str,
    arguments: Mapping[str, Any],
    idempotency_key: str | None,
) -> _BilibiliChildTask | None:
    """Validate the real actor-private running Task carried by the host header.

    Ordinary UI calls omit the host-only Task header and remain taskless Work
    operations. A header-bearing call is accepted only for an exact Bilibili
    feature Task created by the Harness, with matching account, operation,
    arguments, target, and server-issued idempotency metadata.
    """

    task_id = request.headers.get(_BILIBILI_TASK_HEADER.lower())
    if task_id is None:
        return None
    if principal.can_write_harness is not True or principal.actor_private_scope is not True:
        raise PersistenceError(
            "BILIBILI_WORK_TASK_FORBIDDEN",
            403,
            "A private Harness writer is required for task-bound Bilibili operations.",
        )
    if principal.organization_id is None:
        raise PersistenceError(
            "BILIBILI_WORK_TASK_UNAVAILABLE", 503, "Task provenance is unavailable.", True
        )
    if (
        not task_id
        or len(task_id) > 512
        or any(ord(character) < 0x21 or ord(character) > 0x7E for character in task_id)
    ):
        raise PersistenceError(
            "BILIBILI_WORK_TASK_NOT_FOUND", 404, "The Bilibili Work Task was not found."
        )
    if idempotency_key is None or not idempotency_key:
        raise PersistenceError(
            "BILIBILI_WORK_OPERATION_KEY_REQUIRED",
            422,
            "Task-bound Bilibili operations require the server-issued operation key.",
        )
    try:
        task = store.get_task(
            principal.organization_id,
            workspace_id,
            task_id,
            actor_id=principal.actor_id,
            actor_private_scope=True,
        )
    except PersistenceError:
        raise
    except Exception:
        raise PersistenceError(
            "BILIBILI_WORK_TASK_UNAVAILABLE", 503, "Task provenance is unavailable.", True
        ) from None
    if (
        task.get("id") != task_id
        or task.get("workspaceId") != workspace_id
        or task.get("status") != "running"
        or not isinstance(task.get("createdByActorId"), str)
        or str(task["createdByActorId"]).lower() != principal.actor_id.lower()
    ):
        raise PersistenceError(
            "BILIBILI_WORK_TASK_NOT_RUNNING",
            409,
            "The Bilibili operation must be bound to the current actor's running Task.",
        )
    metadata = task.get("metadata")
    if not isinstance(metadata, Mapping):
        raise _bilibili_task_metadata_error()
    source = metadata.get("source")
    if source not in _BILIBILI_TASK_SOURCES:
        raise _bilibili_task_metadata_error()
    normalized_connection = _exchange_uuid_ref(connection_ref, "BILIBILI_CONNECTION_NOT_FOUND")
    profile_ref = metadata.get("profileRef")
    try:
        normalized_profile = _exchange_uuid_ref(profile_ref, "BILIBILI_TASK_METADATA_INVALID")
        target = _bilibili_target_for_task(operation_id, arguments)
        resource_ref = _bilibili_task_resource_ref(normalized_profile, operation_id, target)
        arguments_digest = canonical_arguments_sha256(arguments)
    except PersistenceError:
        raise
    except (TypeError, ValueError):
        raise _bilibili_task_metadata_error() from None

    if (
        metadata.get("workspaceId") != workspace_id
        or metadata.get("actorId") != principal.actor_id
        or metadata.get("connectionRef") != normalized_connection
        or metadata.get("operationId") != operation_id
        or metadata.get("resourceRef") != resource_ref
        or metadata.get("argumentsDigestSha256") != arguments_digest
    ):
        raise _bilibili_task_metadata_error()

    source_refs_digest: str
    task_key: Any
    if source == "conversation-bili-operation":
        parent_task_id = metadata.get("parentTaskId")
        parent_session_id = metadata.get("parentSessionId")
        delegation_id = metadata.get("delegationId")
        delegation_version = metadata.get("delegationVersion")
        source_refs = metadata.get("sourceRefs")
        task_key = metadata.get("idempotencyKey")
        if (
            not _is_bounded_identifier(parent_task_id)
            or not _is_bounded_identifier(parent_session_id)
            or task.get("sessionId") != parent_session_id
            or not _is_bounded_identifier(delegation_id)
            or type(delegation_version) is not int
            or delegation_version < 1
            or not isinstance(source_refs, list)
            or not source_refs
            or len(source_refs) > 256
            or not _bilibili_json_equal(metadata.get("target"), target)
            or not _bilibili_json_equal(metadata.get("arguments"), arguments)
            or task_key != idempotency_key
        ):
            raise _bilibili_task_metadata_error()
        source_refs_digest = _bilibili_json_sha256(source_refs)
        subscription_fields: dict[str, Any] = {}
    else:
        parent_task_id = metadata.get("ownerTaskId")
        parent_session_id = metadata.get("ownerSessionId")
        delegation_id = metadata.get("delegationId")
        delegation_version = metadata.get("delegationVersion")
        source_refs_digest_value = metadata.get("sourceRefsDigest")
        task_key = metadata.get("operationIdempotencyKey")
        runtime_plan_digest = metadata.get("runtimePlanDigest")
        subscription_id = metadata.get("subscriptionId")
        expected_version = metadata.get("expectedVersion")
        run_key = metadata.get("runKey")
        if (
            not _is_bounded_identifier(parent_task_id)
            or not _is_bounded_identifier(parent_session_id)
            or task.get("sessionId") != parent_session_id
            or not _is_bounded_identifier(delegation_id)
            or type(delegation_version) is not int
            or delegation_version < 1
            or not isinstance(source_refs_digest_value, str)
            or _DIGEST.fullmatch(source_refs_digest_value) is None
            or not isinstance(runtime_plan_digest, str)
            or _DIGEST.fullmatch(runtime_plan_digest) is None
            or not _is_bounded_identifier(subscription_id)
            or type(expected_version) is not int
            or expected_version < 1
            or not _is_bounded_identifier(run_key)
            or task_key != idempotency_key
        ):
            raise _bilibili_task_metadata_error()
        source_refs_digest = source_refs_digest_value
        subscription_fields = {
            "subscriptionId": subscription_id,
            "subscriptionVersion": expected_version,
            "expectedVersion": expected_version,
            "runKey": run_key,
            "runtimePlanDigest": runtime_plan_digest,
        }

    operation_request = {
        "source": source,
        "actorScopeSha256": actor_scope_sha256(principal, workspace_id),
        "connectionRefDigest": hashlib.sha256(normalized_connection.encode()).hexdigest(),
        "profileRefDigest": hashlib.sha256(normalized_profile.encode()).hexdigest(),
        "operationId": operation_id,
        "resourceRef": resource_ref,
        "argumentsSha256": arguments_digest,
        "taskId": task_id,
        "parentTaskId": parent_task_id,
        "parentSessionId": parent_session_id,
        "delegationId": delegation_id,
        "delegationVersion": delegation_version,
        "sourceRefsSha256": source_refs_digest,
        "idempotencyKey": idempotency_key,
        **subscription_fields,
    }
    return _BilibiliChildTask(
        task_id=task_id,
        source=str(source),
        profile_ref=normalized_profile,
        idempotency_key=idempotency_key,
        resource_ref=resource_ref,
        target=target,
        operation_request=operation_request,
    )


def _require_bilibili_task_for_lookup(
    store: WorkStore,
    principal: PersistencePrincipal,
    workspace_id: str,
    task_id: str,
    idempotency_key: str,
) -> tuple[str, Mapping[str, Any]]:
    """Authenticate a task-bound GET without requiring the Task to still run."""

    if principal.can_write_harness is not True or principal.actor_private_scope is not True:
        raise PersistenceError(
            "BILIBILI_WORK_TASK_FORBIDDEN",
            403,
            "A private Harness writer is required for task-bound Bilibili receipts.",
        )
    if principal.organization_id is None:
        raise PersistenceError(
            "BILIBILI_WORK_TASK_UNAVAILABLE", 503, "Task provenance is unavailable.", True
        )
    task = store.get_task(
        principal.organization_id,
        workspace_id,
        task_id,
        actor_id=principal.actor_id,
        actor_private_scope=True,
    )
    if (
        task.get("id") != task_id
        or task.get("workspaceId") != workspace_id
        or task.get("status") not in {"running", "completed", "failed", "aborted"}
        or not isinstance(task.get("createdByActorId"), str)
        or str(task["createdByActorId"]).lower() != principal.actor_id.lower()
    ):
        raise PersistenceError("BILIBILI_OPERATION_NOT_FOUND", 404, "Bilibili operation not found.")
    metadata = task.get("metadata")
    if not isinstance(metadata, Mapping):
        raise PersistenceError("BILIBILI_OPERATION_NOT_FOUND", 404, "Bilibili operation not found.")
    source = metadata.get("source")
    task_key = (
        metadata.get("idempotencyKey")
        if source == "conversation-bili-operation"
        else metadata.get("operationIdempotencyKey")
    )
    task_session = (
        metadata.get("parentSessionId")
        if source == "conversation-bili-operation"
        else metadata.get("ownerSessionId")
    )
    if (
        source not in _BILIBILI_TASK_SOURCES
        or metadata.get("workspaceId") != workspace_id
        or metadata.get("actorId") != principal.actor_id
        or task_key != idempotency_key
        or task_session != task.get("sessionId")
    ):
        raise PersistenceError("BILIBILI_OPERATION_NOT_FOUND", 404, "Bilibili operation not found.")
    return str(source), metadata


def _bilibili_task_metadata_matches_operation(
    metadata: Mapping[str, Any],
    operation_request: Mapping[str, Any],
    idempotency_key: str,
) -> bool:
    """Recheck immutable Work receipt identity against the current exact Task view."""

    source = metadata.get("source")
    if (
        source not in _BILIBILI_TASK_SOURCES
        or metadata.get("connectionRef") != operation_request.get("connectionRef")
        or metadata.get("profileRef") != operation_request.get("profileRef")
        or metadata.get("operationId") != operation_request.get("operationId")
        or metadata.get("resourceRef") != operation_request.get("resourceRef")
        or metadata.get("argumentsDigestSha256") != operation_request.get("argumentsSha256")
        or metadata.get("delegationId") != operation_request.get("delegationId")
        or metadata.get("delegationVersion") != operation_request.get("delegationVersion")
    ):
        return False
    if source == "conversation-bili-operation":
        arguments = metadata.get("arguments")
        source_refs = metadata.get("sourceRefs")
        if not isinstance(arguments, Mapping) or not isinstance(source_refs, list):
            return False
        try:
            target = _bilibili_target_for_task(str(metadata.get("operationId")), arguments)
            resource_ref = _bilibili_task_resource_ref(
                str(metadata.get("profileRef")), str(metadata.get("operationId")), target
            )
            arguments_digest = canonical_arguments_sha256(arguments)
            source_refs_digest = _bilibili_json_sha256(source_refs)
        except (PersistenceError, TypeError, ValueError):
            return False
        return (
            metadata.get("idempotencyKey") == idempotency_key
            and metadata.get("parentTaskId") == operation_request.get("parentTaskId")
            and metadata.get("parentSessionId") == operation_request.get("parentSessionId")
            and _bilibili_json_equal(metadata.get("target"), target)
            and operation_request.get("sourceRefsSha256") == source_refs_digest
            and operation_request.get("resourceRef") == resource_ref
            and operation_request.get("argumentsSha256") == arguments_digest
        )
    return (
        metadata.get("operationIdempotencyKey") == idempotency_key
        and metadata.get("ownerTaskId") == operation_request.get("parentTaskId")
        and metadata.get("ownerSessionId") == operation_request.get("parentSessionId")
        and metadata.get("sourceRefsDigest") == operation_request.get("sourceRefsSha256")
        and metadata.get("subscriptionId") == operation_request.get("subscriptionId")
        and metadata.get("expectedVersion") == operation_request.get("expectedVersion")
        and metadata.get("runKey") == operation_request.get("runKey")
        and metadata.get("runtimePlanDigest") == operation_request.get("runtimePlanDigest")
    )


def _bilibili_task_metadata_error() -> PersistenceError:
    """Hide malformed or mismatched feature Task provenance behind one code."""

    return PersistenceError(
        "BILIBILI_WORK_TASK_METADATA_INVALID",
        409,
        "The Bilibili Work Task metadata does not match this operation.",
    )


def _is_bounded_identifier(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= 512
        and all(0x21 <= ord(character) <= 0x7E for character in value)
    )


def _bilibili_target_for_task(operation_id: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
    """Return the fixed directory target projection from exact operation arguments."""

    selectors: dict[str, tuple[str, ...]] = {
        "bilibili.search": ("search_type",),
        "bilibili.user.find": ("user_id",),
        "bilibili.video.read": ("video_id",),
        "bilibili.comments.list": ("video_id", "root_comment_id"),
        "bilibili.dynamics.list": ("user_id",),
        "bilibili.dynamic.read": ("dynamic_id",),
        "bilibili.dm.list": ("peer_user_id",),
        "bilibili.dm.read": ("peer_user_id", "message_id"),
        "bilibili.comment.create": (
            "video_id",
            "root_comment_id",
            "parent_comment_id",
        ),
        "bilibili.dynamic.publish": ("user_id",),
        "bilibili.dm.send": ("peer_user_id",),
    }
    fields = selectors.get(operation_id)
    if fields is None:
        raise ValueError("unsupported Bilibili operation")
    if operation_id == "bilibili.comments.list":
        if "video_id" not in arguments:
            raise ValueError("video_id is required for comments")
        target = {"video_id": arguments["video_id"]}
        if "root_comment_id" in arguments:
            target["root_comment_id"] = arguments["root_comment_id"]
        return target
    if any(field not in arguments for field in fields):
        raise ValueError("Bilibili operation target is incomplete")
    return {field: arguments[field] for field in fields}


def _bilibili_task_resource_ref(
    profile_ref: str, operation_id: str, target: Mapping[str, Any]
) -> str:
    value = {
        "providerId": "bilibili",
        "profileRef": profile_ref,
        "operationId": operation_id,
        "target": dict(target),
    }
    return "sha256:" + _bilibili_json_sha256(value)


def _bilibili_json_sha256(value: Any) -> str:
    try:
        payload = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        raise _bilibili_task_metadata_error() from None
    return hashlib.sha256(payload).hexdigest()


def _bilibili_json_equal(left: Any, right: Any) -> bool:
    try:
        return json.dumps(
            left,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ) == json.dumps(
            right,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError, UnicodeError):
        return False


def _create_bilibili_work_operation(
    store: WorkStore,
    principal: PersistencePrincipal,
    workspace_id: str,
    body: Mapping[str, Any],
    task: _BilibiliChildTask | None,
) -> tuple[dict[str, Any], bool]:
    """Record one Bilibili intent using the immutable producer path for Tasks."""

    create = getattr(store, "create_operation", None)
    if not callable(create):
        raise PersistenceError(
            "WORK_OPERATION_UNAVAILABLE", 503, "Work operation receipts are unavailable.", True
        )
    kwargs: dict[str, Any] = {
        "actor_id": principal.actor_id,
        "actor_private_scope": principal.actor_private_scope,
    }
    if task is not None:
        kwargs["trusted_producer"] = "exchange-connector-dispatch"
    try:
        operation, duplicate = create(
            principal.organization_id,
            workspace_id,
            body,
            **kwargs,
        )
    except TypeError as error:
        if task is not None and "trusted_producer" in str(error):
            raise PersistenceError(
                "WORK_TRUSTED_OPERATION_UNAVAILABLE",
                503,
                "Trusted Bilibili Work operation receipts are unavailable.",
                True,
            ) from None
        raise
    if not isinstance(operation, dict) or not isinstance(duplicate, bool):
        raise PersistenceError(
            "WORK_OPERATION_RESPONSE_INVALID", 502, "Work operation receipt is invalid."
        )
    if task is not None and (
        operation.get("trustedProducer") != "exchange-connector-dispatch"
        or operation.get("taskId") != task.task_id
    ):
        raise PersistenceError(
            "WORK_TRUSTED_OPERATION_INVALID",
            502,
            "Work did not return the exact trusted Bilibili Task operation.",
        )
    return operation, duplicate


def _update_bilibili_work_operation(
    store: WorkStore,
    principal: PersistencePrincipal,
    workspace_id: str,
    operation_id: str,
    status: str,
    evidence: Mapping[str, Any],
    task: _BilibiliChildTask | None,
) -> tuple[dict[str, Any], bool]:
    """Persist one closed outcome and retain the immutable producer attribution."""

    update = getattr(store, "update_operation", None)
    if not callable(update):
        raise PersistenceError(
            "WORK_OPERATION_UNAVAILABLE", 503, "Work operation receipts are unavailable.", True
        )
    kwargs: dict[str, Any] = {
        "actor_id": principal.actor_id,
        "actor_private_scope": principal.actor_private_scope,
    }
    if task is not None:
        kwargs["trusted_producer"] = "exchange-connector-dispatch"
    try:
        operation, duplicate = update(
            principal.organization_id,
            workspace_id,
            operation_id,
            status,
            evidence,
            **kwargs,
        )
    except TypeError as error:
        if task is not None and "trusted_producer" in str(error):
            raise PersistenceError(
                "WORK_TRUSTED_OPERATION_UNAVAILABLE",
                503,
                "Trusted Bilibili Work operation receipts are unavailable.",
                True,
            ) from None
        raise
    if not isinstance(operation, dict) or not isinstance(duplicate, bool):
        raise PersistenceError(
            "WORK_OPERATION_RESPONSE_INVALID", 502, "Work operation receipt is invalid."
        )
    if task is not None and (
        operation.get("trustedProducer") != "exchange-connector-dispatch"
        or operation.get("taskId") != task.task_id
    ):
        raise PersistenceError(
            "WORK_TRUSTED_OPERATION_INVALID",
            502,
            "Work did not return the exact trusted Bilibili Task operation.",
        )
    return operation, duplicate


def _store_bilibili_result_artifact(
    store: WorkStore,
    principal: PersistencePrincipal,
    workspace_id: str,
    operation_id: str,
    result: Mapping[str, Any],
) -> dict[str, Any]:
    """Persist and independently read back one safe Bilibili read result."""

    if principal.organization_id is None or not principal.actor_private_scope:
        raise PersistenceError(
            "BILIBILI_RESULT_SCOPE_REQUIRED",
            403,
            "Bilibili read results require an actor-private Work attachment.",
        )
    try:
        raw = json.dumps(
            result,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD") from None
    if not raw or len(raw) > _MAX_BILIBILI_RESULT_BYTES:
        raise PersistenceError(
            "BILIBILI_RESULT_TOO_LARGE", 413, "The Bilibili result exceeds the Work limit."
        )
    expected_digest = hashlib.sha256(raw).hexdigest()
    attachment = store.put_attachment(
        principal.organization_id,
        workspace_id,
        f"bilibili-{operation_id}.json",
        "application/json",
        raw,
        actor_id=principal.actor_id,
        actor_private_scope=True,
    )
    digest = attachment.get("sha256")
    if digest != expected_digest:
        raise PersistenceError(
            "BILIBILI_RESULT_READBACK_MISMATCH", 502, "Work stored another Bilibili result."
        )
    metadata, path = store.get_attachment(
        principal.organization_id,
        workspace_id,
        expected_digest,
        actor_id=principal.actor_id,
        actor_private_scope=True,
        require_actor_private=True,
    )
    readback = _read_bilibili_result_attachment(path, metadata.get("size"))
    if (
        metadata.get("sha256") != expected_digest
        or metadata.get("mediaType") != "application/json"
        or metadata.get("size") != len(raw)
        or readback != raw
        or hashlib.sha256(readback).hexdigest() != expected_digest
    ):
        raise PersistenceError(
            "BILIBILI_RESULT_READBACK_MISMATCH",
            502,
            "The actor-private Bilibili result did not pass Work readback.",
        )
    return {
        "artifactId": expected_digest,
        "sha256": expected_digest,
        "mimeType": "application/json",
        "size": len(raw),
    }


def _bilibili_result_artifact_from_operation(
    store: WorkStore,
    principal: PersistencePrincipal,
    workspace_id: str,
    operation: Mapping[str, Any],
    task: _BilibiliChildTask | None,
) -> dict[str, Any] | None:
    """Validate a prior result artifact before returning its opaque Work reference."""

    if task is None:
        return None
    if (
        operation.get("trustedProducer") != "exchange-connector-dispatch"
        or operation.get("taskId") != task.task_id
    ):
        raise PersistenceError("BILIBILI_OPERATION_NOT_FOUND", 404, "Bilibili operation not found.")
    evidence = operation.get("evidence")
    if not isinstance(evidence, Mapping):
        raise PersistenceError("BILIBILI_OPERATION_NOT_FOUND", 404, "Bilibili operation not found.")
    digest = evidence.get("resultArtifactId")
    result_sha = evidence.get("resultSha256")
    if not isinstance(digest, str) or _DIGEST.fullmatch(digest) is None or result_sha != digest:
        return None
    if principal.organization_id is None or not principal.actor_private_scope:
        raise PersistenceError(
            "BILIBILI_RESULT_SCOPE_REQUIRED", 403, "Actor-private Work scope is required."
        )
    metadata, path = store.get_attachment(
        principal.organization_id,
        workspace_id,
        digest,
        actor_id=principal.actor_id,
        actor_private_scope=True,
        require_actor_private=True,
    )
    raw = _read_bilibili_result_attachment(path, metadata.get("size"))
    if (
        metadata.get("sha256") != digest
        or metadata.get("mediaType") != "application/json"
        or hashlib.sha256(raw).hexdigest() != digest
    ):
        raise PersistenceError(
            "BILIBILI_RESULT_READBACK_MISMATCH",
            502,
            "The actor-private Bilibili result did not pass Work readback.",
        )
    return {
        "artifactId": digest,
        "sha256": digest,
        "mimeType": "application/json",
        "size": len(raw),
    }


def _read_bilibili_result_attachment(path: Path, expected_size: Any) -> bytes:
    """Read only a bounded regular result file without following its final symlink."""

    if type(expected_size) is not int or not 1 <= expected_size <= _MAX_BILIBILI_RESULT_BYTES:
        raise PersistenceError(
            "BILIBILI_RESULT_READBACK_MISMATCH", 502, "Work result size is invalid."
        )
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as source:
            before = os.fstat(source.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_size != expected_size:
                raise PersistenceError(
                    "BILIBILI_RESULT_READBACK_MISMATCH", 502, "Work result content is invalid."
                )
            raw = source.read(_MAX_BILIBILI_RESULT_BYTES + 1)
            after = os.fstat(source.fileno())
    except OSError:
        raise PersistenceError(
            "BILIBILI_RESULT_READBACK_MISMATCH", 502, "Work result content is unavailable."
        ) from None
    if len(raw) != expected_size or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    ):
        raise PersistenceError(
            "BILIBILI_RESULT_READBACK_MISMATCH", 502, "Work result changed during readback."
        )
    return raw


async def _call_bilibili_exchange(function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Map safe Exchange HTTP errors onto the existing Work Problem contract."""

    try:
        return await invoke_port(function, *args, **kwargs)
    except ExchangeBilibiliHttpError as error:
        raise _exchange_error(error) from None
    except PeripheralPortError as error:
        status = 503 if error.unavailable else 502
        raise PersistenceError(
            error.code,
            status,
            "The configured Exchange connector service is unavailable.",
            error.unavailable,
        ) from None
    except Exception:
        raise PersistenceError(
            "EXCHANGE_BILIBILI_UNAVAILABLE",
            502,
            "The configured Exchange connector service is unavailable.",
            True,
        ) from None


async def _require_bilibili_connection(
    port: ExchangeBilibiliPort,
    principal: PersistencePrincipal,
    workspace_id: str,
    connection_ref: str,
) -> Mapping[str, Any]:
    """Verify the selected connection through Exchange's actor-scoped internal list."""

    try:
        normalized_ref = str(UUID(connection_ref))
    except (TypeError, ValueError):
        raise PersistenceError(
            "BILIBILI_CONNECTION_NOT_FOUND", 404, "Bilibili connection not found."
        ) from None
    result = await _call_bilibili_exchange(port.list_owned_connections, principal, workspace_id)
    value = _json_object(result, "EXCHANGE_CONNECTION_RESPONSE_INVALID")
    items = value.get("connections")
    if not isinstance(items, list):
        raise _provider_payload_error("EXCHANGE_CONNECTION_RESPONSE_INVALID")
    for raw_item in items:
        item = _mapping_view(raw_item)
        if item is None:
            raise _provider_payload_error("EXCHANGE_CONNECTION_RESPONSE_INVALID")
        selected_ref = _value(item, "connection_ref", "connectionRef", "id")
        if not isinstance(selected_ref, str) or selected_ref.lower() != normalized_ref.lower():
            continue
        if _value(item, "provider") != "bilibili" or _value(item, "enabled") is not True:
            raise PersistenceError(
                "BILIBILI_CONNECTION_NOT_FOUND", 404, "Bilibili connection not found."
            )
        profile_ref = _value(item, "profile_ref", "profileRef")
        _exchange_uuid_ref(profile_ref, "EXCHANGE_CONNECTION_RESPONSE_INVALID")
        return item
    raise PersistenceError("BILIBILI_CONNECTION_NOT_FOUND", 404, "Bilibili connection not found.")


def _exchange_error(error: ExchangeBilibiliHttpError) -> PersistenceError:
    """Map an Exchange error code without copying upstream detail or response text."""

    upstream_status = error.status_code or 502
    if upstream_status in {401, 403}:
        status = 403
    elif upstream_status in {404, 409, 413, 422}:
        status = upstream_status
    elif upstream_status == 503:
        status = 503
    else:
        status = 502
    return PersistenceError(
        error.code,
        status,
        "The selected Bilibili connection operation failed in Exchange.",
        status in {502, 503},
    )


def _is_bilibili_profile(value: Any) -> bool:
    item = _mapping_view(value)
    return item is not None and _value(item, "provider") == "bilibili"


def _project_bilibili_profile(value: Any) -> dict[str, Any]:
    """Project the closed, non-secret Account Center profile response."""

    item = _mapping_view(value)
    if item is None:
        raise _provider_payload_error("EXCHANGE_PROFILE_INVALID_PAYLOAD")
    projected = {
        "profile_ref": _value(item, "profile_ref", "profileRef"),
        "provider": "bilibili",
        "identity_ref": _value(item, "identity_ref", "identityRef"),
        "target_scope": _value(item, "target_scope", "targetScope"),
        "auth_status": _value(item, "auth_status", "authStatus"),
        "external_subject": _value(item, "external_subject", "externalSubject"),
        "auth_mode": _value(item, "auth_mode", "authMode"),
        "access_mode": _value(item, "access_mode", "accessMode"),
        "expires_at": _value(item, "expires_at", "expiresAt"),
        "credential_revision": _value(item, "credential_revision", "credentialRevision"),
    }
    return _validate_provider_model(BilibiliAccount, projected)


def _exchange_operation_payload(value: Any) -> tuple[str, dict[str, Any]]:
    """Unwrap Exchange's canonical connector result without exposing wrapper prose."""

    envelope = _json_object(value, "BILIBILI_PROVIDER_INVALID_PAYLOAD")
    outcome = envelope.get("outcome")
    if outcome not in {"verified", "uncertain", "failed", "pending"}:
        raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD")
    result = _json_object(envelope.get("result"), "BILIBILI_PROVIDER_INVALID_PAYLOAD")
    content = result.get("content")
    if not isinstance(content, list) or not content:
        raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD")
    first = _json_object(content[0], "BILIBILI_PROVIDER_INVALID_PAYLOAD")
    text_value = first.get("text")
    if not isinstance(text_value, str) or len(text_value.encode("utf-8")) > 1_500_000:
        raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD")
    try:
        decoded = json.loads(text_value, object_pairs_hook=_unique_json_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD") from None
    return str(outcome), _json_object(decoded, "BILIBILI_PROVIDER_INVALID_PAYLOAD")


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Reject duplicate keys while decoding provider result text."""

    decoded: dict[str, Any] = {}
    for key, item in pairs:
        if key in decoded:
            raise ValueError("duplicate JSON member")
        decoded[key] = item
    return decoded


def _project_bilibili_read_result(operation_id: str, envelope: Any) -> dict[str, Any]:
    """Project only the documented public-read fields for one Bilibili operation."""

    outcome, value = _exchange_operation_payload(envelope)
    if outcome != "verified":
        raise PersistenceError(
            "BILIBILI_READ_UNAVAILABLE",
            502,
            "Exchange could not verify the Bilibili read result.",
            True,
        )
    if operation_id == "bilibili.search":
        return {
            "items": _project_records(
                value.get("items"),
                {"id", "type", "title", "description", "author", "url"},
                {"id", "type", "title", "author", "url"},
            ),
            "page": _required_int(value, "page"),
            "has_more": _required_bool(value, "has_more"),
        }
    if operation_id == "bilibili.user.find":
        return {
            "item": _project_record(
                value.get("item"),
                {"user_id", "name", "signature", "level", "is_following"},
                {"user_id", "name", "signature", "level", "is_following"},
            )
        }
    if operation_id == "bilibili.video.read":
        metadata = _project_record(
            value.get("metadata"),
            {
                "video_id",
                "title",
                "description",
                "author_id",
                "author",
                "duration_seconds",
                "published_at",
                "views",
                "comments",
            },
            {
                "video_id",
                "title",
                "description",
                "author_id",
                "author",
                "duration_seconds",
                "published_at",
                "views",
                "comments",
            },
        )
        read_state = value.get("content_read_state")
        if read_state not in {"METADATA_ONLY", "SUBTITLES_READ"}:
            raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD")
        subtitles = value.get("subtitles")
        if not isinstance(subtitles, list) or len(subtitles) > 100:
            raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD")
        return {
            "metadata": metadata,
            "subtitles": [_project_subtitle(item) for item in subtitles],
            "content_read_state": read_state,
        }
    if operation_id == "bilibili.comments.list":
        return {
            "items": _project_records(
                value.get("items"),
                {"id", "root_id", "parent_id", "user_id", "user", "content", "created_at"},
                {"id", "root_id", "user_id", "user", "content", "created_at"},
            ),
            "next_page": _optional_int(value.get("next_page"), "next_page"),
        }
    if operation_id == "bilibili.dynamics.list":
        return {
            "items": _project_records(
                value.get("items"),
                {"id", "user_id", "user", "text", "published_at", "video_title", "video_url"},
                {"id", "user_id", "user", "text", "published_at"},
            ),
            "next_cursor": _optional_string(value.get("next_cursor"), "next_cursor"),
        }
    if operation_id == "bilibili.dynamic.read":
        return {
            "item": _project_record(
                value.get("item"),
                {"id", "user_id", "user", "text", "published_at", "video_title", "video_url"},
                {"id", "user_id", "user", "text", "published_at"},
            )
        }
    if operation_id == "bilibili.dm.list":
        return {
            "items": _project_records(
                value.get("items"),
                {"id", "sender_user_id", "direction", "text", "created_at"},
                {"id", "sender_user_id", "direction", "text", "created_at"},
            ),
            "next_cursor": _optional_string(value.get("next_cursor"), "next_cursor"),
        }
    if operation_id == "bilibili.dm.read":
        return {
            "item": _project_record(
                value.get("item"),
                {"id", "sender_user_id", "direction", "text", "created_at"},
                {"id", "sender_user_id", "direction", "text", "created_at"},
            )
        }
    raise PersistenceError("BILIBILI_OPERATION_NOT_FOUND", 404, "Read operation unavailable.")


def _project_records(value: Any, allowed: set[str], required: set[str]) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > 100:
        raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD")
    return [_project_record(item, allowed, required) for item in value]


def _project_record(value: Any, allowed: set[str], required: set[str]) -> dict[str, Any]:
    if not isinstance(value, Mapping) or not required.issubset(value):
        raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD")
    projected = {key: value[key] for key in allowed if key in value}
    try:
        json.dumps(projected, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError):
        raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD") from None
    return projected


def _project_subtitle(value: Any) -> dict[str, Any]:
    subtitle = _project_record(value, {"language", "segments"}, {"language", "segments"})
    if not isinstance(subtitle["language"], str) or not isinstance(subtitle["segments"], list):
        raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD")
    if len(subtitle["segments"]) > 10_000:
        raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD")
    segments = [
        _project_record(
            segment,
            {"start_seconds", "end_seconds", "text"},
            {"start_seconds", "end_seconds", "text"},
        )
        for segment in subtitle["segments"]
    ]
    return {"language": subtitle["language"], "segments": segments}


def _required_int(value: Mapping[str, Any], key: str) -> int:
    result = value.get(key)
    if isinstance(result, bool) or not isinstance(result, int):
        raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD")
    return result


def _optional_int(value: Any, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD")
    return value


def _required_bool(value: Mapping[str, Any], key: str) -> bool:
    result = value.get(key)
    if not isinstance(result, bool):
        raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD")
    return result


def _optional_string(value: Any, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise _provider_payload_error("BILIBILI_PROVIDER_INVALID_PAYLOAD")
    return value


def _bilibili_write_evidence(
    value: Mapping[str, Any],
    outcome: str,
    expected_operation_ref: str,
) -> tuple[dict[str, Any], str]:
    """Persist only receipt metadata and a readback digest, never message text."""

    status = value.get("status")
    receipt_id = value.get("receipt_id")
    operation_ref = value.get("operation_ref")
    if (
        not isinstance(receipt_id, str)
        or not receipt_id
        or len(receipt_id) > 200
        or operation_ref != expected_operation_ref
    ):
        raise ValueError("provider receipt does not match the durable Work operation")
    evidence: dict[str, Any] = {
        "receiptId": receipt_id,
        "operationRef": expected_operation_ref,
        "replay": "NOT_REPLAYED",
    }
    external_id = value.get("external_id")
    if isinstance(external_id, str) and external_id:
        evidence["externalId"] = external_id[:200]
    if status == "SUCCEEDED":
        digest = value.get("readback_sha256")
        if not isinstance(external_id, str) or not external_id:
            raise ValueError("provider success lacks external identity")
        if outcome != "verified" or value.get("readback_verified") is not True:
            raise ValueError("provider success lacks verified readback")
        if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
            raise ValueError("provider success lacks a readback digest")
        evidence.update(
            {
                "status": "SUCCEEDED",
                "readbackVerified": True,
                "readbackSha256": digest,
            }
        )
        return evidence, "verified"
    if status == "REJECTED":
        error_code = value.get("error_code")
        if (
            not isinstance(error_code, str)
            or re.fullmatch(r"[A-Z][A-Z0-9_]{0,99}", error_code) is None
        ):
            raise ValueError("provider rejection lacks an error code")
        evidence["status"] = "REJECTED"
        evidence["errorCode"] = error_code
        return evidence, "verified"
    if status == "UNKNOWN_RESULT" or outcome in {"uncertain", "pending"}:
        error_code = value.get("error_code")
        if (
            not isinstance(error_code, str)
            or re.fullmatch(r"[A-Z][A-Z0-9_]{0,99}", error_code) is None
        ):
            raise ValueError("uncertain provider result lacks an error code")
        evidence["status"] = "UNKNOWN_RESULT"
        evidence["errorCode"] = error_code
        return evidence, "uncertain"
    raise ValueError("provider mutation outcome is not closed")


async def _invoke_tool(
    binding: FixedToolBinding,
    tool_id: str,
    arguments: Mapping[str, Any],
    *,
    principal: PersistencePrincipal,
    workspace_id: str,
    request_id: str,
) -> Mapping[str, Any]:
    try:
        result = await binding.invoke(
            tool_id,
            arguments,
            principal=principal,
            workspace_id=workspace_id,
            request_id=request_id,
        )
    except PeripheralPortError as error:
        status = 503 if error.unavailable else 502
        raise PersistenceError(
            error.code, status, "Configured capability unavailable or failed.", error.unavailable
        ) from None
    except Exception:
        raise PersistenceError(
            "PERIPHERAL_PROVIDER_FAILED", 502, "Configured capability failed.", True
        ) from None
    return _json_object(result, "PERIPHERAL_PROVIDER_INVALID_PAYLOAD")


async def _invoke_artifact_tool[ArtifactResult](
    binding: FixedToolBinding,
    tool_id: str,
    arguments: Mapping[str, Any],
    *,
    principal: PersistencePrincipal,
    workspace_id: str,
    request_id: str,
    store: WorkStore,
    bridge: ArtifactBridgeConfig | None,
    projector: Callable[
        [Mapping[str, Any], ActiveCallLease], tuple[ArtifactResult, Mapping[str, Any]]
    ],
    read_grants: Sequence[ArtifactReadGrant] = (),
    write_mime_types: Collection[str] = (),
) -> ArtifactResult:
    """Run one media artifact operation under a durable Work receipt and live lease.

    The receipt contains only argument and actor-scope digests. The registry binds
    the short-lived bridge permission to this exact Work Operation and signature.
    中文：操作回执不存参数正文；插件桥权限仅在本次调用期有效。
    """

    configured_bridge = _require_artifact_bridge(bridge)
    artifact_binding = configured_bridge.bindings.get(binding.binding_id)
    if (
        artifact_binding is None
        or artifact_binding.binding_id != binding.binding_id
        or not request_id
        or len(request_id) > 200
        or binding.operation_ids.get(tool_id) != tool_id
    ):
        raise PersistenceError(
            "ARTIFACT_PROVIDER_UNAVAILABLE", 503, "Artifact provider binding is unavailable.", True
        )

    try:
        caller_context = binding.create_caller_context(
            tool_id,
            arguments,
            principal=principal,
            workspace_id=workspace_id,
            request_id=request_id,
        )
    except Exception:
        raise PersistenceError(
            "ARTIFACT_PROVIDER_UNAVAILABLE", 503, "Artifact provider binding is unavailable.", True
        ) from None

    actor_scope = actor_scope_sha256(principal, workspace_id)
    idempotency_material = f"{actor_scope}\0{tool_id}\0{request_id}".encode()
    idempotency_key = "artifact-call:" + hashlib.sha256(idempotency_material).hexdigest()
    operation, duplicate = store.create_operation(
        principal.organization_id,
        workspace_id,
        {
            "idempotencyKey": idempotency_key,
            "operationType": f"tool.provider.v1:{tool_id}",
            "request": {
                "toolId": tool_id,
                "argumentsSha256": canonical_arguments_sha256(arguments),
                "actorScopeSha256": actor_scope,
            },
        },
        actor_id=principal.actor_id,
        actor_private_scope=principal.actor_private_scope,
    )
    if duplicate:
        raise PersistenceError(
            "WORK_ARTIFACT_CALL_ALREADY_RECORDED",
            409,
            "This artifact call already has a durable outcome; it was not replayed.",
        )

    operation_id = str(operation["id"])
    try:
        lease = configured_bridge.registry.register_operation_call(
            principal,
            workspace_id,
            work_operation_id=operation_id,
            request_id=request_id,
            binding_id=binding.binding_id,
            tool_id=tool_id,
            operation_id=tool_id,
            arguments=arguments,
            caller_context=caller_context,
            read_grants=read_grants,
            write_mime_types=tuple(write_mime_types),
        )
    except Exception:
        store.update_operation(
            principal.organization_id,
            workspace_id,
            operation_id,
            "verified",
            {"status": "REJECTED", "toolId": tool_id, "errorCode": "CALL_NOT_AUTHORIZED"},
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        raise

    try:
        try:
            raw_result = await binding.invoke(
                tool_id,
                arguments,
                principal=principal,
                workspace_id=workspace_id,
                request_id=request_id,
                caller_context=caller_context,
            )
            result = _json_object(raw_result, "MEDIA_PROVIDER_INVALID_PAYLOAD")
            projected, details = projector(result, lease)
            configured_bridge.registry.assert_call_current(lease)
            safe_details = _json_object(details, "MEDIA_PROVIDER_INVALID_PAYLOAD")
            store.update_operation(
                principal.organization_id,
                workspace_id,
                operation_id,
                "verified",
                {"status": "SUCCEEDED", "toolId": tool_id, **safe_details},
                actor_id=principal.actor_id,
                actor_private_scope=principal.actor_private_scope,
            )
            return projected
        except BaseException as error:
            store.update_operation(
                principal.organization_id,
                workspace_id,
                operation_id,
                "uncertain",
                {"status": "UNKNOWN_RESULT", "toolId": tool_id},
                actor_id=principal.actor_id,
                actor_private_scope=principal.actor_private_scope,
            )
            if isinstance(error, asyncio.CancelledError):
                raise
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            if isinstance(error, PersistenceError):
                raise
            if isinstance(error, PeripheralPortError):
                status = 503 if error.unavailable else 502
                raise PersistenceError(
                    error.code,
                    status,
                    "Configured artifact provider failed after call admission.",
                    error.unavailable,
                ) from None
            raise PersistenceError(
                "PERIPHERAL_PROVIDER_FAILED",
                502,
                "Configured artifact provider returned an invalid result.",
                True,
            ) from None
    finally:
        lease.close()


def _require_artifact_bridge(
    bridge: ArtifactBridgeConfig | None,
) -> ArtifactBridgeConfig:
    if bridge is None or not bridge.bindings:
        raise PersistenceError(
            "ARTIFACT_BRIDGE_UNAVAILABLE", 503, "Artifact bridge is not configured.", True
        )
    return bridge


async def invoke_port(function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Invoke host adapters without blocking the ASGI loop for sync implementations."""

    import asyncio
    import inspect

    if inspect.iscoroutinefunction(function):
        return await function(*args, **kwargs)
    value = await asyncio.to_thread(function, *args, **kwargs)
    return await value if inspect.isawaitable(value) else value


def _read_attachment(
    store: WorkStore,
    principal: PersistencePrincipal,
    workspace_id: str,
    digest: str,
    *,
    accepted_types: set[str] | frozenset[str] | None,
    actor_private_scope: bool | None = None,
) -> tuple[AttachmentRecord, bytes]:
    if not _DIGEST.fullmatch(digest):
        raise PersistenceError("WORK_ATTACHMENT_NOT_FOUND", 404, "Attachment not found.")
    metadata, path = store.get_attachment(
        principal.organization_id,
        workspace_id,
        digest,
        actor_id=principal.actor_id,
        actor_private_scope=(
            principal.actor_private_scope if actor_private_scope is None else actor_private_scope
        ),
    )
    record = AttachmentRecord.model_validate(metadata)
    if accepted_types is not None and record.media_type not in accepted_types:
        raise PersistenceError(
            "WORK_ATTACHMENT_UNSUPPORTED_MEDIA", 415, "Unsupported attachment media type."
        )
    if record.size > _MAX_ATTACHMENT_BYTES:
        raise PersistenceError("WORK_ATTACHMENT_INVALID_SIZE", 413, "Attachment exceeds 10 MB.")
    data = path.read_bytes()
    if len(data) != record.size or hashlib.sha256(data).hexdigest() != digest:
        raise PersistenceError(
            "WORK_ATTACHMENT_INTEGRITY_FAILURE", 422, "Attachment failed integrity validation."
        )
    return record, data


def _attachment_response(attachment: AttachmentRecord, data: bytes) -> Response:
    """Serve attachment bytes with an integrity header and encoded filename."""

    return Response(
        content=data,
        media_type=attachment.media_type,
        headers={
            "Content-Disposition": (
                "attachment; filename*=UTF-8''" + quote(attachment.name, safe="")
            ),
            "X-Content-SHA256": attachment.sha256,
        },
    )


def _require_port(port: Any, code: str) -> Any:
    if port is None:
        raise PersistenceError(code, 503, "Configured capability is unavailable.", True)
    return port


def _require_binding(binding: FixedToolBinding | None, code: str) -> FixedToolBinding:
    if binding is None:
        raise PersistenceError(code, 503, "Configured capability binding is unavailable.", True)
    return binding


def _validate_provider_model(model_type: type[Any], value: Any) -> dict[str, Any]:
    try:
        parsed = model_type.model_validate(value)
    except Exception:
        raise _provider_payload_error() from None
    return cast(dict[str, Any], parsed.model_dump(by_alias=True, exclude_none=False))


def _validate_asset_attachment(
    asset: Mapping[str, Any], attachment: AttachmentRecord, digest: str
) -> None:
    """Bind provider metadata to the exact bytes authorized by WorkStore."""

    if (
        attachment.sha256 != digest
        or asset.get("digest") != digest
        or asset.get("mimeType") != attachment.media_type
        or asset.get("byteSize") != attachment.size
    ):
        raise _provider_payload_error("MEDIA_PROVIDER_INVALID_PAYLOAD")


def _json_object(value: Any, code: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or not all(isinstance(key, str) for key in value):
        raise _provider_payload_error(code)
    try:
        encoded = json.dumps(dict(value), allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError):
        raise _provider_payload_error(code) from None
    if len(encoded.encode("utf-8")) > 2_000_000:
        raise PersistenceError(
            "PERIPHERAL_PROVIDER_PAYLOAD_TOO_LARGE", 413, "Provider payload too large."
        )
    return dict(value)


def _provider_payload_error(code: str = "PERIPHERAL_PROVIDER_INVALID_PAYLOAD") -> PersistenceError:
    return PersistenceError(code, 502, "Configured provider returned an invalid payload.")


def _request_id(request: Request) -> str:
    value = getattr(request.state, "request_id", None)
    if isinstance(value, str) and value:
        return value[:200]
    return uuid4().hex


def _bilibili_effective_operation_key(
    principal: PersistencePrincipal,
    workspace_id: str,
    logical_key: str,
) -> str:
    """Scope one stable feature key to the authenticated Work actor and tenant."""

    actor_scope = actor_scope_sha256(principal, workspace_id)
    return bilibili_operation_idempotency_key(actor_scope, logical_key)


def _value(value: Mapping[str, Any], snake: str, *aliases: str) -> Any:
    """Read one known projection field from its fixed wire-name alternatives."""

    if snake in value:
        return value[snake]
    for alias in aliases:
        if alias in value:
            return value[alias]
    return None


def _exchange_uuid_ref(value: Any, error_code: str) -> str:
    """Project one opaque Exchange UUID without accepting arbitrary identities."""

    if not isinstance(value, str):
        raise _provider_payload_error(error_code)
    try:
        return str(UUID(value))
    except ValueError:
        raise _provider_payload_error(error_code) from None


def _mapping_view(value: Any) -> Mapping[str, Any] | None:
    """Read safe Product DTOs from mapping, dataclass, or Pydantic projections."""

    if isinstance(value, Mapping):
        return value
    if dataclasses.is_dataclass(value):
        return cast(Mapping[str, Any], dataclasses.asdict(cast(Any, value)))
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        result = dump(by_alias=False)
        return result if isinstance(result, Mapping) else None
    return None


def _parse_provider_expiry(value: Any) -> datetime:
    """Parse a provider RFC3339 UTC expiry and reject naive timestamps."""

    if not isinstance(value, str):
        raise ValueError("provider expiry must be an RFC3339 string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("provider expiry must be timezone-aware")
    return parsed.astimezone(UTC)


def _workspace_route_path(base: str, workspace_id: str, suffix: str) -> str:
    """Return a same-origin path with the authenticated Workspace substituted."""

    return base.replace("{workspace_id}", quote(workspace_id, safe="")) + suffix


__all__ = ["invoke_port", "mount_peripheral_routes"]
