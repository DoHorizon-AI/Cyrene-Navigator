"""
┌─────────────────────────────────────────────────────────────────────────┐
│ 📄 routes.py                                                            │
│ Module: cyrene_navigator.work.conversation_artifact_bridge.routes       │
│ Role: Serve only live-call-authorized Work attachment bytes.            │
│                                                                         │
│ 模块职责：仅为当前有效签名工具调用提供经过WorkStore授权的附件。         │
└─────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import ipaddress
import json
import os
import re
import stat
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from fastapi import FastAPI, Request
from pydantic import Field

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.work.models import WorkModel
from cyrene_navigator.work.store import WorkStore

if TYPE_CHECKING:
    from cyrene_navigator.work.conversation_peripheral.ports import (
        ArtifactBridgeBinding,
        ArtifactBridgeConfig,
    )

_SERVICE_BEARER = re.compile(r"[0-9a-f]{64}\Z")
_ARTIFACT_ID = re.compile(r"[0-9a-f]{64}\Z")
_MAX_ATTACHMENT_BYTES = 10_000_000
_MAX_BASE64_CHARS = 13_333_336
_MAX_READ_REQUEST_BYTES = 256_000
_MAX_WRITE_REQUEST_BYTES = 14_000_000
_IMAGE_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})


class _VerifiedArtifactCaller(Protocol):
    """Minimum identity shape returned only after configured HMAC verification."""

    @property
    def organization_id(self) -> str: ...

    @property
    def workspace_id(self) -> str: ...

    @property
    def actor_id(self) -> str: ...


class _ReadArtifactBody(WorkModel):
    artifact_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    tool_id: str = Field(min_length=1, max_length=200)
    arguments: dict[str, Any]
    caller_context: dict[str, Any]


class _WriteArtifactBody(WorkModel):
    mime_type: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=512)
    content_base64: str = Field(min_length=1, max_length=_MAX_BASE64_CHARS)
    tool_id: str = Field(min_length=1, max_length=200)
    arguments: dict[str, Any]
    caller_context: dict[str, Any]


def mount_conversation_artifact_bridge(
    app: FastAPI,
    store: WorkStore,
    config: ArtifactBridgeConfig | None,
) -> None:
    """Mount the stable loopback bridge shared by media, web, and document tools."""

    @app.post("/v1/artifacts/read")
    async def read_artifact(request: Request) -> dict[str, Any]:
        bridge = _require_config(config)
        body = await _parse_request(_ReadArtifactBody, request, _MAX_READ_REQUEST_BYTES)
        binding = _authorize_bridge_binding(request, bridge, body.caller_context)
        caller = _verify_caller(
            binding,
            body.tool_id,
            body.arguments,
            body.caller_context,
        )
        authorization = bridge.registry.authorize_read(
            verified_caller=caller,
            binding_id=binding.binding_id,
            tool_id=body.tool_id,
            arguments=body.arguments,
            caller_context=body.caller_context,
            artifact_id=body.artifact_id,
        )
        grant = authorization.artifact_read_grant
        if grant is None:
            raise PersistenceError(
                "WORK_ARTIFACT_BRIDGE_FORBIDDEN", 403, "Artifact read grant is unavailable."
            )
        metadata, path = store.get_attachment(
            authorization.principal.organization_id,
            authorization.workspace_id,
            body.artifact_id,
            actor_id=authorization.principal.actor_id,
            actor_private_scope=authorization.principal.actor_private_scope,
        )
        declared_size = metadata.get("size")
        declared_mime = metadata.get("mediaType")
        if (
            metadata.get("sha256") != body.artifact_id
            or not isinstance(declared_size, int)
            or isinstance(declared_size, bool)
            or not 1 <= declared_size <= _MAX_ATTACHMENT_BYTES
            or declared_mime not in grant.allowed_mime_types
        ):
            raise PersistenceError(
                "WORK_ATTACHMENT_INTEGRITY_FAILURE",
                422,
                "The authorized attachment metadata failed integrity validation.",
            )
        data = _read_bounded_attachment(path)
        if (
            metadata.get("sha256") != body.artifact_id
            or hashlib.sha256(data).hexdigest() != body.artifact_id
            or declared_mime not in grant.allowed_mime_types
            or len(data) != declared_size
            or len(data) > _MAX_ATTACHMENT_BYTES
        ):
            raise PersistenceError(
                "WORK_ATTACHMENT_INTEGRITY_FAILURE",
                422,
                "The authorized attachment failed integrity validation.",
            )
        authorization.assert_current()
        return {
            "artifactId": body.artifact_id,
            "sha256": body.artifact_id,
            "mimeType": str(declared_mime),
            "size": len(data),
            "contentBase64": base64.b64encode(data).decode("ascii"),
        }

    @app.post("/v1/artifacts/write")
    async def write_artifact(request: Request) -> dict[str, Any]:
        bridge = _require_config(config)
        body = await _parse_request(_WriteArtifactBody, request, _MAX_WRITE_REQUEST_BYTES)
        binding = _authorize_bridge_binding(request, bridge, body.caller_context)
        caller = _verify_caller(
            binding,
            body.tool_id,
            body.arguments,
            body.caller_context,
        )
        try:
            data = base64.b64decode(body.content_base64, validate=True)
        except (ValueError, binascii.Error):
            raise PersistenceError(
                "WORK_ATTACHMENT_INVALID_ENCODING", 422, "Attachment encoding is invalid."
            ) from None
        if not data or len(data) > _MAX_ATTACHMENT_BYTES:
            raise PersistenceError(
                "WORK_ATTACHMENT_INVALID_SIZE", 413, "Attachment must be at most 10 MB."
            )
        if body.mime_type not in _IMAGE_TYPES or _image_mime_type(data) != body.mime_type:
            raise PersistenceError(
                "WORK_ATTACHMENT_UNSUPPORTED_MEDIA", 415, "Generated media type is unsupported."
            )
        authorization = bridge.registry.authorize_write(
            verified_caller=caller,
            binding_id=binding.binding_id,
            tool_id=body.tool_id,
            arguments=body.arguments,
            caller_context=body.caller_context,
            mime_type=body.mime_type,
            size=len(data),
        )
        recorded = False
        try:
            safe_name = _safe_display_name(body.name)
            authorization.assert_current()
            digest = hashlib.sha256(data).hexdigest()
            metadata = store.put_attachment(
                authorization.principal.organization_id,
                authorization.workspace_id,
                safe_name,
                body.mime_type,
                data,
                actor_id=authorization.principal.actor_id,
                actor_private_scope=True,
            )
            if metadata.get("sha256") != digest:
                raise PersistenceError(
                    "WORK_ATTACHMENT_INTEGRITY_FAILURE",
                    500,
                    "Stored attachment digest mismatch.",
                )
            bridge.registry.record_output(authorization, digest)
            recorded = True
            authorization.assert_current()
        finally:
            if not recorded:
                bridge.registry.release_output(authorization)
        return {
            "artifactId": digest,
            "sha256": digest,
            "mimeType": body.mime_type,
            "size": len(data),
        }


async def _parse_request(model_type: type[Any], request: Request, max_bytes: int) -> Any:
    """Stream and validate a small JSON envelope before parsing attachment bytes."""

    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) < 0 or int(content_length) > max_bytes:
                raise PersistenceError(
                    "WORK_ATTACHMENT_INVALID_SIZE", 413, "Artifact bridge request is too large."
                )
        except ValueError:
            raise PersistenceError(
                "WORK_ARTIFACT_BRIDGE_REQUEST_INVALID", 400, "Artifact bridge request is invalid."
            ) from None
    content_type = request.headers.get("content-type", "").partition(";")[0].strip().lower()
    if content_type != "application/json":
        raise PersistenceError(
            "WORK_ARTIFACT_BRIDGE_REQUEST_INVALID", 415, "Artifact bridge requires JSON."
        )
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > max_bytes:
            raise PersistenceError(
                "WORK_ATTACHMENT_INVALID_SIZE", 413, "Artifact bridge request is too large."
            )
        raw.extend(chunk)
    try:
        parsed = json.loads(bytes(raw), object_pairs_hook=_unique_json_object)
        return model_type.model_validate(parsed)
    except Exception:
        raise PersistenceError(
            "WORK_ARTIFACT_BRIDGE_REQUEST_INVALID", 422, "Artifact bridge request is invalid."
        ) from None


def _require_config(config: ArtifactBridgeConfig | None) -> ArtifactBridgeConfig:
    if config is None or not config.bindings:
        raise PersistenceError(
            "WORK_ARTIFACT_BRIDGE_UNAVAILABLE", 503, "Artifact bridge is not configured.", True
        )
    return config


def _authorize_bridge_binding(
    request: Request,
    config: ArtifactBridgeConfig,
    caller_context: Mapping[str, Any],
) -> ArtifactBridgeBinding:
    """Select a preconfigured binding and constant-time check its loopback token."""

    host = request.client.host if request.client is not None else ""
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host == "localhost"
    binding_id = caller_context.get("binding_id")
    binding = config.bindings.get(binding_id) if isinstance(binding_id, str) else None
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if (
        not loopback
        or binding is None
        or not _SERVICE_BEARER.fullmatch(binding.bearer_token)
        or scheme.lower() != "bearer"
        or not hmac.compare_digest(token, binding.bearer_token)
    ):
        raise PersistenceError(
            "WORK_ARTIFACT_BRIDGE_FORBIDDEN", 403, "Artifact bridge authorization failed."
        )
    return binding


def _verify_caller(
    binding: ArtifactBridgeBinding,
    tool_id: str,
    arguments: Mapping[str, Any],
    caller_context: Mapping[str, Any],
) -> _VerifiedArtifactCaller:
    try:
        caller = binding.verifier.verify_artifact_call(
            tool_id=tool_id,
            arguments=arguments,
            caller_context=caller_context,
            binding_id=binding.binding_id,
        )
    except Exception:
        raise PersistenceError(
            "WORK_ARTIFACT_BRIDGE_FORBIDDEN", 403, "Artifact caller context is invalid."
        ) from None
    if not all(
        isinstance(getattr(caller, field, None), str)
        for field in ("organization_id", "workspace_id", "actor_id")
    ):
        raise PersistenceError(
            "WORK_ARTIFACT_BRIDGE_FORBIDDEN", 403, "Artifact caller context is invalid."
        )
    return caller


def _safe_display_name(value: str) -> str:
    """Accept metadata only; path separators and controls never reach WorkStore."""

    if (
        not value
        or len(value) > 512
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
        or "/" in value
        or "\\" in value
    ):
        raise PersistenceError("WORK_ATTACHMENT_INVALID_NAME", 422, "Attachment name is invalid.")
    normalized = value.strip()
    if not normalized:
        raise PersistenceError("WORK_ATTACHMENT_INVALID_NAME", 422, "Attachment name is invalid.")
    return normalized


def _read_bounded_attachment(path: Path) -> bytes:
    """Open only a regular content file and never read beyond the bridge limit."""

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        raise PersistenceError(
            "WORK_ATTACHMENT_CONTENT_UNAVAILABLE",
            500,
            "The authorized attachment content is unavailable.",
        ) from None
    try:
        with os.fdopen(descriptor, "rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise PersistenceError(
                    "WORK_ATTACHMENT_CONTENT_UNAVAILABLE",
                    500,
                    "The authorized attachment is not a regular file.",
                )
            return source.read(_MAX_ATTACHMENT_BYTES + 1)
    except OSError:
        raise PersistenceError(
            "WORK_ATTACHMENT_CONTENT_UNAVAILABLE",
            500,
            "The authorized attachment content is unavailable.",
        ) from None


def _image_mime_type(data: bytes) -> str | None:
    """Identify supported image containers without decoding into unbounded pixels."""

    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    decoded: dict[str, Any] = {}
    for key, value in pairs:
        if key in decoded:
            raise ValueError("duplicate JSON member")
        decoded[key] = value
    return decoded


__all__ = ["mount_conversation_artifact_bridge"]
