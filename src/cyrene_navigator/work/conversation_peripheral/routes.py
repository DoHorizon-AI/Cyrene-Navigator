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

import base64
import dataclasses
import hashlib
import hmac
import ipaddress
import json
import re
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, cast
from urllib.parse import quote
from uuid import UUID, uuid4

from fastapi import FastAPI, Header, Query, Request, Response
from pydantic import Field

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.models import (
    AttachmentRecord,
    OperationReceipt,
)
from cyrene_navigator.work.store import WorkStore

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
    WorkModel,
)
from .ports import (
    ArtifactBridgeConfig,
    ExchangeBilibiliHttpError,
    ExchangeBilibiliPort,
    FixedToolBinding,
    PeripheralPortError,
    PeripheralPorts,
    VerifiedArtifactCaller,
)

_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_BRIDGE_TOKEN = re.compile(r"[0-9a-f]{64}\Z")
_MEDIA_TYPE = re.compile(r"[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+\Z")
_MAX_ATTACHMENT_BYTES = 10_000_000
_MAX_BASE64_BYTES = 14_000_000
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


class _ArtifactReadBody(WorkModel):
    artifact_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    tool_id: str = Field(min_length=1, max_length=200)
    arguments: dict[str, Any]
    caller_context: dict[str, Any]


class _ArtifactWriteBody(WorkModel):
    mime_type: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=512)
    content_base64: str = Field(min_length=1, max_length=_MAX_BASE64_BYTES)
    tool_id: str = Field(min_length=1, max_length=200)
    arguments: dict[str, Any]
    caller_context: dict[str, Any]


PrincipalFor = Callable[..., PersistencePrincipal]


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
        _read_attachment(
            store,
            principal,
            workspace_id,
            body.attachment_digest,
            accepted_types=_IMAGE_MIME_TYPES,
        )
        binding = _require_binding(ports.media, "MEDIA_PROVIDER_UNAVAILABLE")
        result = await _invoke_tool(
            binding,
            "media.asset.import",
            {
                "artifact_id": body.attachment_digest,
                "title": body.title,
                "alt_text": body.alt_text,
                "tags": body.tags,
            },
            principal=principal,
            workspace_id=workspace_id,
            request_id=_request_id(request),
        )
        asset = _validate_provider_model(MediaAsset, result)
        response.status_code = 201
        return asset

    @app.get(base + "/media/assets/{asset_id}", response_model=MediaAssetRead)
    async def get_media_asset(workspace_id: str, asset_id: str, request: Request) -> dict[str, Any]:
        principal = principal_for(request, workspace_id)
        binding = _require_binding(ports.media, "MEDIA_PROVIDER_UNAVAILABLE")
        result = await _invoke_tool(
            binding,
            "media.asset.get",
            {"asset_id": asset_id},
            principal=principal,
            workspace_id=workspace_id,
            request_id=_request_id(request),
        )
        value = _json_object(result, "MEDIA_PROVIDER_INVALID_PAYLOAD")
        asset = _validate_provider_model(MediaAsset, value.get("asset"))
        artifact = _json_object(value.get("artifact"), "MEDIA_PROVIDER_INVALID_PAYLOAD")
        digest = artifact.get("sha256")
        if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
            raise _provider_payload_error()
        attachment, _ = _read_attachment(
            store,
            principal,
            workspace_id,
            digest,
            accepted_types=_IMAGE_MIME_TYPES,
            actor_private_scope=True,
        )
        return {
            "asset": asset,
            "attachment": attachment,
            "downloadPath": _workspace_route_path(
                base,
                workspace_id,
                f"/media/assets/{quote(asset_id, safe='')}/attachment",
            ),
        }

    @app.get(base + "/media/assets/{asset_id}/attachment", response_model=None)
    async def download_media_asset(workspace_id: str, asset_id: str, request: Request) -> Response:
        principal = principal_for(request, workspace_id)
        result = await _invoke_tool(
            _require_binding(ports.media, "MEDIA_PROVIDER_UNAVAILABLE"),
            "media.asset.get",
            {"asset_id": asset_id},
            principal=principal,
            workspace_id=workspace_id,
            request_id=_request_id(request),
        )
        value = _json_object(result, "MEDIA_PROVIDER_INVALID_PAYLOAD")
        _validate_provider_model(MediaAsset, value.get("asset"))
        artifact = _json_object(value.get("artifact"), "MEDIA_PROVIDER_INVALID_PAYLOAD")
        digest = artifact.get("sha256")
        if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
            raise _provider_payload_error()
        attachment, data = _read_attachment(
            store,
            principal,
            workspace_id,
            digest,
            accepted_types=_IMAGE_MIME_TYPES,
            actor_private_scope=True,
        )
        return _attachment_response(attachment, data)

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
        result = await _invoke_tool(
            _require_binding(ports.media, "MEDIA_PROVIDER_UNAVAILABLE"),
            "media.card.render",
            {"title": body.title, "body": body.content, "theme": body.theme},
            principal=principal,
            workspace_id=workspace_id,
            request_id=_request_id(request),
        )
        value = _json_object(result, "MEDIA_PROVIDER_INVALID_PAYLOAD")
        asset = _validate_provider_model(MediaAsset, value.get("asset"))
        artifact = _json_object(value.get("artifact"), "MEDIA_PROVIDER_INVALID_PAYLOAD")
        digest = artifact.get("sha256")
        if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
            raise _provider_payload_error()
        attachment, _ = _read_attachment(
            store,
            principal,
            workspace_id,
            digest,
            accepted_types={"image/png"},
            actor_private_scope=True,
        )
        return {
            "asset": asset,
            "attachment": attachment,
            "downloadPath": _workspace_route_path(
                base,
                workspace_id,
                f"/media/assets/{quote(str(asset.get('assetId')), safe='')}/attachment",
            ),
        }

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
                        "connection_ref": _value(item, "connection_ref", "connectionRef", "id"),
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

    @app.post(base + "/bilibili/connections/{connection_ref}/reads/{operation_id}")
    async def bilibili_read(
        workspace_id: str,
        connection_ref: str,
        operation_id: str,
        body: BilibiliReadRequest,
        request: Request,
    ) -> dict[str, Any]:
        if operation_id not in _BILIBILI_READ_OPERATIONS:
            raise PersistenceError(
                "BILIBILI_OPERATION_NOT_FOUND", 404, "Read operation unavailable."
            )
        principal = principal_for(request, workspace_id)
        port = _bilibili_exchange_port(ports)
        await _require_bilibili_connection(port, principal, workspace_id, connection_ref)
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
            raise _exchange_error(error) from None
        except PeripheralPortError as error:
            status = 503 if error.unavailable else 502
            raise PersistenceError(
                error.code,
                status,
                "The configured Exchange connector service is unavailable.",
                error.unavailable,
            ) from None
        return _project_bilibili_read_result(operation_id, envelope)

    @app.post(
        base + "/bilibili/connections/{connection_ref}/writes/{operation_id}",
        response_model=OperationReceipt,
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
        principal = principal_for(request, workspace_id, write=True)
        port = _bilibili_exchange_port(ports)
        await _require_bilibili_connection(port, principal, workspace_id, connection_ref)
        connection_ref = str(UUID(connection_ref))
        connection_digest = hashlib.sha256(connection_ref.encode()).hexdigest()
        actor_scope_material = (
            f"{principal.organization_id or ''}\0{workspace_id}\0"
            f"{principal.actor_id}\0{connection_digest}"
        )
        actor_scope = hashlib.sha256(actor_scope_material.encode()).hexdigest()
        key_digest = hashlib.sha256(
            f"{actor_scope}\0{operation_id}\0{idempotency_key}".encode()
        ).hexdigest()
        effective_key = f"bilibili:{key_digest}"
        argument_digest = hashlib.sha256(
            json.dumps(
                body.arguments,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        operation, duplicate = store.create_operation(
            principal.organization_id,
            workspace_id,
            {
                "idempotencyKey": effective_key,
                "operationType": f"tool.provider.v1:{operation_id}",
                "target": f"connector-target:{actor_scope}",
                "request": {
                    "connectionRefDigest": connection_digest,
                    "operationId": operation_id,
                    "argumentsSha256": argument_digest,
                },
            },
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        if duplicate:
            response.status_code = (
                202 if operation.get("status") in {"started", "uncertain"} else 200
            )
            return {"operation": operation, "duplicate": True}

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

        updated, update_duplicate = store.update_operation(
            principal.organization_id,
            workspace_id,
            str(operation["id"]),
            final_status,
            evidence,
            actor_id=principal.actor_id,
            actor_private_scope=principal.actor_private_scope,
        )
        return {"operation": updated, "duplicate": update_duplicate}

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

    _mount_artifact_bridge(app, store, ports.artifact_bridge)


def _mount_artifact_bridge(
    app: FastAPI, store: WorkStore, config: ArtifactBridgeConfig | None
) -> None:
    """Mount fixed local bridge paths used by the media plugin resolver."""

    @app.post("/v1/artifacts/read")
    def read_work_artifact(body: _ArtifactReadBody, request: Request) -> dict[str, Any]:
        bridge = _require_bridge(config)
        _authorize_bridge_request(request, bridge.bearer_token)
        if body.tool_id != "media.asset.import":
            raise PersistenceError("WORK_ATTACHMENT_BRIDGE_FORBIDDEN", 403, "Tool is not allowed.")
        caller = _verify_artifact_call(bridge, body.tool_id, body.arguments, body.caller_context)
        metadata, path = store.get_attachment(
            caller.organization_id,
            caller.workspace_id,
            body.artifact_id,
            actor_id=caller.actor_id,
            actor_private_scope=True,
        )
        data = path.read_bytes()
        if (
            metadata["sha256"] != body.artifact_id
            or hashlib.sha256(data).hexdigest() != body.artifact_id
            or metadata["mediaType"] not in _IMAGE_MIME_TYPES
            or len(data) > _MAX_ATTACHMENT_BYTES
        ):
            raise PersistenceError(
                "WORK_ATTACHMENT_INTEGRITY_FAILURE", 422, "Attachment failed integrity validation."
            )
        return {
            "artifactId": body.artifact_id,
            "sha256": body.artifact_id,
            "mimeType": metadata["mediaType"],
            "size": len(data),
            "contentBase64": base64.b64encode(data).decode("ascii"),
        }

    @app.post("/v1/artifacts/write")
    def write_work_artifact(body: _ArtifactWriteBody, request: Request) -> dict[str, Any]:
        bridge = _require_bridge(config)
        _authorize_bridge_request(request, bridge.bearer_token)
        if body.tool_id not in {"media.asset.get", "media.card.render"}:
            raise PersistenceError("WORK_ATTACHMENT_BRIDGE_FORBIDDEN", 403, "Tool is not allowed.")
        caller = _verify_artifact_call(bridge, body.tool_id, body.arguments, body.caller_context)
        if body.mime_type not in _IMAGE_MIME_TYPES:
            raise PersistenceError(
                "WORK_ATTACHMENT_UNSUPPORTED_MEDIA", 415, "Unsupported media type."
            )
        try:
            data = base64.b64decode(body.content_base64, validate=True)
        except ValueError:
            raise PersistenceError(
                "WORK_ATTACHMENT_INVALID_ENCODING", 422, "Invalid attachment encoding."
            ) from None
        if not data or len(data) > _MAX_ATTACHMENT_BYTES:
            raise PersistenceError(
                "WORK_ATTACHMENT_INVALID_SIZE", 413, "Attachment bytes must be at most 10 MB."
            )
        digest = hashlib.sha256(data).hexdigest()
        metadata = store.put_attachment(
            caller.organization_id,
            caller.workspace_id,
            body.name,
            body.mime_type,
            data,
            actor_id=caller.actor_id,
            actor_private_scope=True,
        )
        if metadata["sha256"] != digest:
            raise PersistenceError(
                "WORK_ATTACHMENT_INTEGRITY_FAILURE", 500, "Attachment digest mismatch."
            )
        return {
            "artifactId": digest,
            "sha256": digest,
            "mimeType": body.mime_type,
            "size": len(data),
        }


def _bilibili_exchange_port(ports: PeripheralPorts) -> ExchangeBilibiliPort:
    """Return the fixed Exchange delegation client or a typed unavailable error."""

    return cast(
        ExchangeBilibiliPort,
        _require_port(ports.bilibili_exchange, "EXCHANGE_BILIBILI_UNAVAILABLE"),
    )


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
        if not isinstance(profile_ref, str) or not profile_ref:
            raise _provider_payload_error("EXCHANGE_CONNECTION_RESPONSE_INVALID")
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


def _verify_artifact_call(
    config: ArtifactBridgeConfig,
    tool_id: str,
    arguments: Mapping[str, Any],
    caller_context: Mapping[str, Any],
) -> VerifiedArtifactCaller:
    try:
        caller = config.verifier.verify_artifact_call(
            tool_id=tool_id,
            arguments=arguments,
            caller_context=caller_context,
            binding_id=config.binding_id,
        )
    except Exception:
        raise PersistenceError(
            "WORK_ATTACHMENT_BRIDGE_FORBIDDEN", 403, "Caller context invalid."
        ) from None
    if not isinstance(caller, VerifiedArtifactCaller):
        raise PersistenceError("WORK_ATTACHMENT_BRIDGE_FORBIDDEN", 403, "Caller context invalid.")
    return caller


def _authorize_bridge_request(request: Request, bearer_token: str) -> None:
    host = request.client.host if request.client is not None else ""
    try:
        is_loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        is_loopback = False
    auth = request.headers.get("authorization", "")
    scheme, _, token = auth.partition(" ")
    if (
        not is_loopback
        or scheme.lower() != "bearer"
        or not _BRIDGE_TOKEN.fullmatch(bearer_token)
        or not hmac.compare_digest(token, bearer_token)
    ):
        raise PersistenceError(
            "WORK_ATTACHMENT_BRIDGE_FORBIDDEN", 403, "Local bridge authorization failed."
        )


def _require_bridge(config: ArtifactBridgeConfig | None) -> ArtifactBridgeConfig:
    if config is None:
        raise PersistenceError(
            "WORK_ATTACHMENT_BRIDGE_UNAVAILABLE", 503, "Artifact bridge unavailable.", True
        )
    return config


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


def _value(value: Mapping[str, Any], snake: str, *aliases: str) -> Any:
    """Read one known projection field from its fixed wire-name alternatives."""

    if snake in value:
        return value[snake]
    for alias in aliases:
        if alias in value:
            return value[alias]
    return None


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
