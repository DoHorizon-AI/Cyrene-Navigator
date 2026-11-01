"""
┌─────────────────────────────────────────────────────────────────────────┐
│ 📄 ports.py                                                             │
│ Module: cyrene_navigator.work.conversation_peripheral.ports              │
│ Role: Fixed binding, trusted caller, Product profile, and artifact ports.│
│                                                                         │
│ 模块职责：定义固定绑定、受信调用方、Product profile 和附件端口。         │
│ · Transport, signer, keys, issuer and binding details are host-injected. │
└─────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import ipaddress
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import quote, urlsplit
from uuid import UUID, uuid4

import httpx

from cyrene_navigator.persistence.store import PersistencePrincipal


class PeripheralPortError(Exception):
    """A configured capability port failed with a stable safe error code."""

    def __init__(
        self,
        code: str,
        *,
        unavailable: bool = False,
        status_code: int | None = None,
        side_effect_possible: bool = False,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.unavailable = unavailable
        self.status_code = status_code
        self.side_effect_possible = side_effect_possible


class ExchangeBilibiliHttpError(PeripheralPortError):
    """A safe Exchange HTTP failure with its authoritative response class."""

    def __init__(
        self,
        code: str,
        *,
        status_code: int,
        side_effect_possible: bool = False,
    ) -> None:
        super().__init__(code, status_code=status_code, side_effect_possible=side_effect_possible)


@dataclass(frozen=True, slots=True)
class SignedExchangeRequest:
    """Raw canonical request bytes and Navigator HMAC headers for one Exchange call."""

    body: bytes
    headers: Mapping[str, str]


class NavigatorHmacRequestSigner(Protocol):
    """Sign internal Exchange HTTP bodies, separate from plugin caller contexts."""

    def sign(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        *,
        method: str,
        path: str,
        payload: Mapping[str, Any],
    ) -> SignedExchangeRequest:
        """Add server-derived actor claims and sign the exact raw HTTP body."""


class TrustedCallerSigner(Protocol):
    """Host signer deriving all identity and binding claims from trusted config."""

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
    ) -> Mapping[str, Any]:
        """Sign the exact arguments; issuer, subject and HMAC key are host-derived."""


class ToolProviderClient(Protocol):
    """DirectPluginRuntime adapter for one already fixed tool-provider binding."""

    def call_tool(
        self,
        provider_tool_id: str,
        arguments: Mapping[str, Any],
        caller_context: Mapping[str, Any],
    ) -> Mapping[str, Any] | Any:
        """Invoke the configured binding with a signed caller envelope."""


@dataclass(frozen=True, slots=True)
class FixedToolBinding:
    """One immutable server binding and trusted invocation profile."""

    binding_id: str
    caller_workload: str
    audience: str
    operation_ids: Mapping[str, str]
    signer: TrustedCallerSigner
    client: ToolProviderClient

    async def invoke(
        self,
        provider_tool_id: str,
        arguments: Mapping[str, Any],
        *,
        principal: PersistencePrincipal,
        workspace_id: str,
        request_id: str,
    ) -> Mapping[str, Any]:
        """Sign and invoke one allowlisted tool through the configured binding."""

        operation_id = self.operation_ids.get(provider_tool_id)
        if operation_id is None:
            raise PeripheralPortError("PERIPHERAL_OPERATION_UNAVAILABLE", unavailable=True)
        context = self.signer.sign_context(
            method=provider_tool_id,
            operation_id=operation_id,
            payload=arguments,
            principal=principal,
            workspace_id=workspace_id,
            binding_id=self.binding_id,
            caller_workload=self.caller_workload,
            audience=self.audience,
            request_id=request_id,
        )
        call_tool = self.client.call_tool
        if inspect.iscoroutinefunction(call_tool):
            result = await call_tool(provider_tool_id, arguments, context)
        else:
            result = await asyncio.to_thread(call_tool, provider_tool_id, arguments, context)
            if inspect.isawaitable(result):
                result = await result
        if not isinstance(result, Mapping):
            raise PeripheralPortError("PERIPHERAL_INVALID_PROVIDER_PAYLOAD")
        return result


class SpeechProviderPort(Protocol):
    """Fixed speech binding facade with redacted config and bounded transcription."""

    def get_config(
        self, *, principal: PersistencePrincipal, workspace_id: str
    ) -> Mapping[str, Any] | Any:
        """Return safe non-secret feature settings."""

    def update_config(
        self,
        config: Mapping[str, Any],
        *,
        principal: PersistencePrincipal,
        workspace_id: str,
    ) -> Mapping[str, Any] | Any:
        """Update safe preferences; host binding credentials are not in the input."""

    def status(
        self, *, principal: PersistencePrincipal, workspace_id: str
    ) -> Mapping[str, Any] | Any:
        """Return bounded availability/model facts without endpoint details."""

    def transcribe(
        self,
        *,
        data: bytes,
        mime_type: str,
        language_hint: str | None,
        principal: PersistencePrincipal,
        workspace_id: str,
        request_id: str,
    ) -> Mapping[str, Any] | Any:
        """Invoke the fixed speech.provider.v1 binding with validated bytes."""


class ExchangeBilibiliPort(Protocol):
    """Actor-scoped Exchange port for profiles, connections, QR, and Bilibili tools."""

    def list_owned_provider_profiles(
        self, principal: PersistencePrincipal, workspace_id: str
    ) -> Mapping[str, Any] | Any:
        """List safe Account Center profiles for the signed Work principal."""

    def get_owned_provider_profile(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        *,
        profile_ref: str,
    ) -> Any:
        """Resolve one exact owned Bilibili profile."""

    def list_owned_connections(
        self, principal: PersistencePrincipal, workspace_id: str
    ) -> Mapping[str, Any] | Any:
        """List the caller's safe Bilibili connection selections."""

    def begin_qr(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        *,
        idempotency_key: str,
    ) -> Mapping[str, Any] | Any:
        """Start a server-bound Account Center QR session."""

    def poll_qr(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        *,
        login_flow_id: str,
    ) -> Mapping[str, Any] | Any:
        """Poll one actor-owned QR session and return safe metadata only."""

    def invoke_operation(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        *,
        connection_ref: str,
        operation_id: str,
        arguments: Mapping[str, Any],
        work_operation_id: str | None,
    ) -> Mapping[str, Any] | Any:
        """Use Exchange's grant and connector dispatcher for one fixed operation."""


class ExchangeBilibiliHttpClient:
    """Real HMAC-authenticated Exchange HTTP adapter for conversation surfaces.

    Exchange remains the owner of human authorization, connection mapping, fresh
    Directory grants, credential leases, and provider execution. This adapter
    sends no browser bearer and never accepts a URL or actor selector from body.
    """

    _PROFILES_LIST = "/internal/v1/bilibili/provider-profiles/list"
    _PROFILE_GET = "/internal/v1/bilibili/provider-profiles/get"
    _CONNECTIONS_LIST = "/internal/v1/bilibili/connections/list"
    _QR_BEGIN = "/internal/v1/bilibili/qr-sessions/begin"
    _QR_STATUS = "/internal/v1/bilibili/qr-sessions/status"
    _GRANT_PATH = "/internal/v1/connector-operation-grants"
    _EXECUTE_PATH = "/internal/v1/connector-operations/{}"
    _UUID = re.compile(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
        r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z"
    )
    _READ_OPERATIONS = frozenset(
        {
            "bilibili.search",
            "bilibili.user.find",
            "bilibili.video.read",
            "bilibili.comments.list",
            "bilibili.dynamics.list",
            "bilibili.dynamic.read",
            "bilibili.dm.list",
            "bilibili.dm.read",
        }
    )
    _WRITE_OPERATIONS = frozenset(
        {
            "bilibili.comment.create",
            "bilibili.dynamic.publish",
            "bilibili.dm.send",
        }
    )

    def __init__(
        self,
        base_url: str,
        signer: NavigatorHmacRequestSigner,
        *,
        client: httpx.AsyncClient | None = None,
        response_limit_bytes: int = 2_000_000,
    ) -> None:
        parsed = urlsplit(base_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or len(base_url) > 2048
        ):
            raise ValueError("Exchange API base URL is invalid")
        if parsed.scheme != "https":
            try:
                loopback = ipaddress.ip_address(parsed.hostname).is_loopback
            except ValueError:
                loopback = parsed.hostname in {"localhost"}
            if not loopback:
                raise ValueError("Exchange API must use HTTPS outside loopback")
        if not 1 <= response_limit_bytes <= 2_000_000:
            raise ValueError("Exchange response limit must be between 1 byte and 2 MB")
        self._base_url = base_url.rstrip("/")
        self._signer = signer
        self._client = client
        self._response_limit_bytes = response_limit_bytes

    async def list_owned_provider_profiles(
        self, principal: PersistencePrincipal, workspace_id: str
    ) -> Mapping[str, Any]:
        return await self._signed_post(
            self._PROFILES_LIST,
            principal=principal,
            workspace_id=workspace_id,
        )

    async def get_owned_provider_profile(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        *,
        profile_ref: str,
    ) -> Mapping[str, Any]:
        return await self._signed_post(
            self._PROFILE_GET,
            {"profile_ref": profile_ref},
            principal=principal,
            workspace_id=workspace_id,
        )

    async def list_owned_connections(
        self, principal: PersistencePrincipal, workspace_id: str
    ) -> Mapping[str, Any]:
        return await self._signed_post(
            self._CONNECTIONS_LIST,
            principal=principal,
            workspace_id=workspace_id,
        )

    async def begin_qr(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        *,
        idempotency_key: str,
    ) -> Mapping[str, Any]:
        return await self._signed_post(
            self._QR_BEGIN,
            {"idempotency_key": idempotency_key},
            principal=principal,
            workspace_id=workspace_id,
        )

    async def poll_qr(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        *,
        login_flow_id: str,
    ) -> Mapping[str, Any]:
        return await self._signed_post(
            self._QR_STATUS,
            {"login_flow_id": login_flow_id},
            principal=principal,
            workspace_id=workspace_id,
        )

    async def invoke_operation(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        *,
        connection_ref: str,
        operation_id: str,
        arguments: Mapping[str, Any],
        work_operation_id: str | None,
    ) -> Mapping[str, Any]:
        """Mint and consume one exact Authority grant; provider inputs never replay."""

        if operation_id not in self._READ_OPERATIONS | self._WRITE_OPERATIONS:
            raise ExchangeBilibiliHttpError("BILIBILI_OPERATION_NOT_FOUND", status_code=404)
        if self._UUID.fullmatch(connection_ref) is None:
            raise ExchangeBilibiliHttpError("BILIBILI_CONNECTION_NOT_FOUND", status_code=404)
        normalized_connection = str(UUID(connection_ref))
        argument_bytes = _canonical_bilibili_json(arguments)
        if len(argument_bytes) > 64_000:
            raise ExchangeBilibiliHttpError("BILIBILI_ARGUMENTS_TOO_LARGE", status_code=413)

        connection_page = await self.list_owned_connections(principal, workspace_id)
        rows = connection_page.get("connections")
        if not isinstance(rows, list):
            raise PeripheralPortError("EXCHANGE_CONNECTION_RESPONSE_INVALID")
        connection = next(
            (
                row
                for row in rows
                if isinstance(row, Mapping)
                and str(_exchange_value(row, "connection_ref", "connectionRef", "id")).lower()
                == normalized_connection.lower()
            ),
            None,
        )
        if (
            connection is None
            or connection.get("provider") != "bilibili"
            or connection.get("enabled") is not True
        ):
            raise ExchangeBilibiliHttpError("BILIBILI_CONNECTION_NOT_FOUND", status_code=404)
        profile_ref = _exchange_value(connection, "profile_ref", "profileRef", "accountLinkRef")
        if not isinstance(profile_ref, str) or self._UUID.fullmatch(profile_ref) is None:
            raise PeripheralPortError("EXCHANGE_CONNECTION_RESPONSE_INVALID")
        target = _bilibili_resource_projection(operation_id, arguments)
        resource_ref = _bilibili_resource_ref(profile_ref, operation_id, target)
        digest = hashlib.sha256(argument_bytes).hexdigest()
        request_id = uuid4().hex
        idempotency_key: str | None = None
        if operation_id in self._WRITE_OPERATIONS:
            if work_operation_id is None or self._UUID.fullmatch(work_operation_id) is None:
                raise ExchangeBilibiliHttpError("WORK_OPERATION_ID_REQUIRED", status_code=422)
            idempotency_key = "work-operation:" + str(UUID(work_operation_id))

        grant_payload: dict[str, Any] = {
            "request_id": request_id,
            "workspace_id": workspace_id,
            "connection_ref": normalized_connection,
            "provider_id": "bilibili",
            "profile_ref": profile_ref,
            "operation_id": operation_id,
            "resource_ref": resource_ref,
            "arguments": dict(arguments),
            "arguments_digest_sha256": digest,
        }
        if idempotency_key is not None:
            grant_payload["idempotency_key"] = idempotency_key
        grant = await self._signed_post(
            self._GRANT_PATH,
            grant_payload,
            principal=principal,
            workspace_id=workspace_id,
            request_id=request_id,
        )
        grant_bin = grant.get("connectorGrantBin")
        if not isinstance(grant_bin, str) or not grant_bin:
            raise PeripheralPortError("EXCHANGE_CONNECTOR_GRANT_INVALID")

        invoke_payload: dict[str, Any] = {
            "request_id": request_id,
            "provider_id": "bilibili",
            "profile_ref": profile_ref,
            "operation_id": operation_id,
            "resource_ref": resource_ref,
            "arguments": dict(arguments),
        }
        if idempotency_key is not None:
            invoke_payload["idempotency_key"] = idempotency_key
        invoke_path = self._EXECUTE_PATH.format(quote(normalized_connection, safe=""))
        invoke_body = _canonical_bilibili_json(invoke_payload)
        try:
            return await self._post_raw(
                invoke_path,
                invoke_body,
                headers={"x-cyrene-connector-grant-bin": grant_bin},
            )
        except ExchangeBilibiliHttpError as error:
            if error.status_code is not None and error.status_code >= 500:
                error.side_effect_possible = True
            raise

    async def _signed_post(
        self,
        path: str,
        payload: Mapping[str, Any] | None = None,
        *,
        principal: PersistencePrincipal,
        workspace_id: str,
        request_id: str | None = None,
    ) -> Mapping[str, Any]:
        signed = self._signer.sign(
            principal,
            workspace_id,
            method="POST",
            path=path,
            payload={
                **dict(payload or {}),
                "request_id": request_id or uuid4().hex,
            },
        )
        signed_body = getattr(signed, "body", None)
        signed_headers = getattr(signed, "headers", None)
        if not isinstance(signed_body, bytes) or not isinstance(signed_headers, Mapping):
            raise PeripheralPortError("EXCHANGE_REQUEST_SIGNER_UNAVAILABLE", unavailable=True)
        headers = {str(key).lower(): str(value) for key, value in signed_headers.items()}
        if "authorization" in headers or "x-cyrene-execution-credential-bin" in headers:
            raise PeripheralPortError("EXCHANGE_REQUEST_SIGNER_INVALID")
        return await self._post_raw(path, signed_body, headers=headers)

    async def _post_raw(
        self, path: str, body: bytes, *, headers: Mapping[str, str]
    ) -> Mapping[str, Any]:
        if not path.startswith("/internal/v1/") or "?" in path or "#" in path:
            raise PeripheralPortError("EXCHANGE_INTERNAL_PATH_INVALID")
        request_headers = {key.lower(): value for key, value in headers.items()}
        request_headers.setdefault("content-type", "application/json")
        if "authorization" in request_headers:
            raise PeripheralPortError("EXCHANGE_AUTH_HEADER_FORBIDDEN")

        if self._client is not None:
            return await self._read_response(self._client, path, body, request_headers)
        async with httpx.AsyncClient(
            timeout=30.0, follow_redirects=False, trust_env=False
        ) as client:
            return await self._read_response(client, path, body, request_headers)

    async def _read_response(
        self,
        client: httpx.AsyncClient,
        path: str,
        body: bytes,
        headers: Mapping[str, str],
    ) -> Mapping[str, Any]:
        try:
            async with client.stream(
                "POST", self._base_url + path, content=body, headers=dict(headers)
            ) as response:
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > self._response_limit_bytes:
                        raise ExchangeBilibiliHttpError(
                            "EXCHANGE_RESPONSE_TOO_LARGE", status_code=502
                        )
                value = _decode_exchange_json(bytes(raw), response.headers.get("content-type"))
                if not 200 <= response.status_code < 300:
                    code = value.get("code")
                    safe_code = (
                        code
                        if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,99}", code)
                        else "EXCHANGE_REQUEST_FAILED"
                    )
                    raise ExchangeBilibiliHttpError(safe_code, status_code=response.status_code)
                return value
        except ExchangeBilibiliHttpError:
            raise
        except (httpx.HTTPError, OSError):
            raise ExchangeBilibiliHttpError(
                "EXCHANGE_REQUEST_UNAVAILABLE", status_code=502
            ) from None


def _decode_exchange_json(raw: bytes, content_type: str | None) -> Mapping[str, Any]:
    """Decode a bounded Exchange JSON object without surfacing response prose."""

    media_type = (content_type or "").partition(";")[0].strip().lower()
    if media_type not in {"application/json", "application/problem+json"}:
        raise ExchangeBilibiliHttpError("EXCHANGE_RESPONSE_INVALID", status_code=502)
    try:
        value = json.loads(raw, object_pairs_hook=_unique_json_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise ExchangeBilibiliHttpError("EXCHANGE_RESPONSE_INVALID", status_code=502) from None
    if not isinstance(value, Mapping) or not all(isinstance(key, str) for key in value):
        raise ExchangeBilibiliHttpError("EXCHANGE_RESPONSE_INVALID", status_code=502)
    return value


def _exchange_value(value: Mapping[str, Any], *keys: str) -> Any:
    """Read a field from the one fixed Exchange internal response projection."""

    for key in keys:
        if key in value:
            return value[key]
    return None


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Reject duplicate JSON names at the Exchange trust boundary."""

    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON member")
        result[key] = value
    return result


def _canonical_bilibili_json(value: Any) -> bytes:
    """Serialize the Bilibili JSON subset identically to Exchange connector JCS."""

    def validate(item: Any) -> None:
        if isinstance(item, float):
            raise ValueError("Bilibili payloads use finite integer JSON numbers only")
        if isinstance(item, Mapping):
            if not all(isinstance(key, str) for key in item):
                raise ValueError("Bilibili object keys must be strings")
            for nested in item.values():
                validate(nested)
            return
        if isinstance(item, list):
            for nested in item:
                validate(nested)
            return
        if item is None or isinstance(item, (str, int, bool)):
            return
        raise ValueError("Bilibili payload must contain finite JSON values")

    validate(value)
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        raise ValueError("Bilibili payload is not canonicalizable JSON") from None


def _bilibili_resource_projection(
    operation_id: str, arguments: Mapping[str, Any]
) -> dict[str, Any]:
    """Match Exchange's fixed Bilibili resource selector projection."""

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
        raise ValueError("operation has no Bilibili resource projection")
    if operation_id == "bilibili.comments.list":
        if "video_id" not in arguments:
            raise ValueError("video_id is required for comment resources")
        target: dict[str, Any] = {"video_id": arguments["video_id"]}
        if "root_comment_id" in arguments:
            target["root_comment_id"] = arguments["root_comment_id"]
        return target
    if any(field not in arguments for field in fields):
        raise ValueError("Bilibili resource selector is incomplete")
    return {field: arguments[field] for field in fields}


def _bilibili_resource_ref(profile_ref: str, operation_id: str, target: Mapping[str, Any]) -> str:
    """Compute the same opaque resource reference used by Exchange Directory grants."""

    payload = {
        "providerId": "bilibili",
        "profileRef": profile_ref,
        "operationId": operation_id,
        "target": dict(target),
    }
    return "sha256:" + hashlib.sha256(_canonical_bilibili_json(payload)).hexdigest()


class BackupPort(Protocol):
    """Core-owned domain backup export; this port owns serialized data content."""

    def create_backup(
        self, *, principal: PersistencePrincipal, workspace_id: str
    ) -> tuple[str, str, bytes] | Any:
        """Return `(filename, media_type, bytes)` for one bounded backup artifact."""


class ArtifactCallerVerifier(Protocol):
    """Configured verifier that checks signed tool payload and fixed binding scope."""

    def verify_artifact_call(
        self,
        *,
        tool_id: str,
        arguments: Mapping[str, Any],
        caller_context: Mapping[str, Any],
        binding_id: str,
    ) -> VerifiedArtifactCaller:
        """Verify HMAC and return only validated actor/org/workspace claims."""


@dataclass(frozen=True, slots=True)
class VerifiedArtifactCaller:
    """Identity and scope extracted only from a successfully verified signature."""

    organization_id: str
    workspace_id: str
    actor_id: str


@dataclass(frozen=True, slots=True)
class ArtifactBridgeConfig:
    """Loopback-only Work attachment bridge secrets and binding verifier."""

    bearer_token: str
    binding_id: str
    verifier: ArtifactCallerVerifier


@dataclass(frozen=True, slots=True)
class PeripheralPorts:
    """Optional server-configured adapters; a missing port remains unavailable."""

    media: FixedToolBinding | None = None
    speech: SpeechProviderPort | None = None
    bilibili_exchange: ExchangeBilibiliPort | None = None
    backup: BackupPort | None = None
    artifact_bridge: ArtifactBridgeConfig | None = None


__all__ = [
    "ArtifactBridgeConfig",
    "ArtifactCallerVerifier",
    "BackupPort",
    "ExchangeBilibiliHttpClient",
    "ExchangeBilibiliHttpError",
    "ExchangeBilibiliPort",
    "FixedToolBinding",
    "NavigatorHmacRequestSigner",
    "PeripheralPortError",
    "PeripheralPorts",
    "SignedExchangeRequest",
    "SpeechProviderPort",
    "ToolProviderClient",
    "TrustedCallerSigner",
    "VerifiedArtifactCaller",
]
