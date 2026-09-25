"""
Navigator same-origin Web Host authentication, credentials, and proxy boundary.

The host owns browser-facing session state only. Product APIs remain behind
explicitly configured proxy prefixes, and credential values are write-only at
the HTTP boundary.

Navigator 同源 Web Host 的身份验证、凭据和代理边界。主机只拥有面向浏览器的会话状态。Product API 始终位于显式配置的代理前缀之后；凭据值在 HTTP 边界上只写不读。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import secrets
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import Any
from urllib.parse import unquote, urlsplit
from uuid import uuid4

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator
from pydantic.alias_generators import to_camel

JsonObject = dict[str, Any]
Clock = Callable[[], float]

_SESSION_COOKIE = "cyrene_session"
_REFRESH_COOKIE = "cyrene_refresh"
_CSRF_COOKIE = "cyrene_csrf"
_MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_TRACEPARENT = r"^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$"
_PROXY_REQUEST_HEADERS = frozenset(
    {"accept", "content-type", "idempotency-key", "traceparent", "tracestate"}
)
_PROXY_RESPONSE_HEADERS = frozenset(
    {
        "cache-control",
        "content-disposition",
        "content-type",
        "etag",
        "last-modified",
        "location",
        "traceparent",
        "tracestate",
        "x-request-id",
    }
)


class WebHostModel(BaseModel):
    """Strict camelCase request model used by the Web Host boundary.

    Web Host 边界使用的严格 camelCase 请求模型。
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
        strict=True,
    )


class PairingRequest(WebHostModel):
    """Accept the documented pairingCode and a short code compatibility alias.

    接受文档规定的 pairingCode，并兼容较短的 code 别名。
    """

    pairing_code: str | None = Field(default=None, min_length=1, max_length=512)
    code: str | None = Field(default=None, min_length=1, max_length=512)

    @model_validator(mode="after")
    def require_code(self) -> PairingRequest:
        """Require one non-empty pairing value without exposing it in errors.

        要求提供一个非空配对值，且错误信息不得泄露该值。
        """

        if self.pairing_code is None and self.code is None:
            raise ValueError("a pairing code is required")
        return self

    def resolved_code(self) -> str:
        """Return the supplied pairing value, preferring the canonical field.

        返回提供的配对值，优先使用规范字段。
        """

        return self.pairing_code or self.code or ""


class ActiveRouteRequest(WebHostModel):
    """Session-level active route configuration.

    会话级活动路由配置。
    """

    gateway_endpoint_id: str = Field(min_length=1)
    model_id: str = Field(min_length=1)
    base_url: str = Field(min_length=1)
    api_key_hint: str = Field(default="", max_length=100)


class CredentialCreateRequest(WebHostModel):
    """Write-only credential input; neither secret field is ever serialized back.

    只写凭据输入；任何密钥字段都不会被序列化返回。
    """

    name: str = Field(min_length=1, max_length=200)
    provider: str = Field(default="generic", min_length=1, max_length=100)
    kind: str | None = Field(default=None, min_length=1, max_length=100)
    type: str | None = Field(default=None, min_length=1, max_length=100)
    secret: SecretStr | None = None
    token: SecretStr | None = None

    @model_validator(mode="after")
    def require_secret(self) -> CredentialCreateRequest:
        """Require a value while keeping validation responses value-free.

        要求字段有值，同时确保校验响应不包含该值。
        """

        if self.secret is None and self.token is None:
            raise ValueError("a credential secret is required")
        return self

    def resolved_kind(self) -> str:
        """Return the canonical metadata kind.

        返回规范的元数据类型。
        """

        return self.kind or self.type or "generic"

    def resolved_secret(self) -> str:
        """Return the write-only value for internal storage.

        返回供内部存储使用的只写值。
        """

        value = self.secret or self.token
        return value.get_secret_value() if value is not None else ""


class CredentialUpdateRequest(WebHostModel):
    """Mutable credential metadata and optional replacement secret.

    可变凭据元数据和可选的替换密钥。
    """

    name: str | None = Field(default=None, min_length=1, max_length=200)
    provider: str | None = Field(default=None, min_length=1, max_length=100)
    kind: str | None = Field(default=None, min_length=1, max_length=100)
    type: str | None = Field(default=None, min_length=1, max_length=100)
    secret: SecretStr | None = None
    token: SecretStr | None = None

    @model_validator(mode="after")
    def require_change(self) -> CredentialUpdateRequest:
        """Reject empty updates before any store mutation occurs.

        在修改存储前拒绝空更新。
        """

        if not self.model_fields_set:
            raise ValueError("at least one credential field is required")
        return self

    def resolved_secret(self) -> str | None:
        """Return a replacement secret when one was supplied.

        如果提供了替换密钥，则返回该密钥。
        """

        value = self.secret or self.token
        return value.get_secret_value() if value is not None else None

    def has_secret_change(self) -> bool:
        """Report whether the request explicitly supplied a secret field.

        报告请求是否显式提供了密钥字段。
        """

        return "secret" in self.model_fields_set or "token" in self.model_fields_set

    def resolved_kind(self) -> str | None:
        """Return the requested kind alias, if present.

        如果存在类型别名，则返回请求中的别名。
        """

        return self.kind or self.type


class WebHostError(RuntimeError):
    """Stable problem response raised by the browser-facing host boundary.

    面向浏览器的主机边界返回的稳定问题响应。
    """

    def __init__(self, code: str, status: int, detail: str, *, retryable: bool = False) -> None:
        super().__init__(detail)
        self.code = code
        self.status = status
        self.detail = detail
        self.retryable = retryable


class CredentialStoreError(RuntimeError):
    """Internal credential-store failure that contains no credential value.

    不包含任何凭据值的内部凭据存储错误。
    """

    def __init__(self, code: str, detail: str, *, status: int) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status = status


class CredentialNotFound(CredentialStoreError):
    """Raised when a credential is not in the host's metadata store.

    当凭据不存在于主机元数据存储中时抛出。
    """

    def __init__(self) -> None:
        super().__init__(
            "NAVIGATOR_CREDENTIAL_NOT_FOUND",
            "The requested credential does not exist.",
            status=404,
        )


class CredentialConflict(CredentialStoreError):
    """Raised for conflicting idempotency keys or invalid credential state.

    幂等键冲突或凭据状态无效时抛出。
    """

    def __init__(self, detail: str) -> None:
        super().__init__("NAVIGATOR_CREDENTIAL_CONFLICT", detail, status=409)


@dataclass(frozen=True, slots=True)
class CredentialMetadata:
    """Non-secret credential metadata returned to the WebUI.

    返回给 WebUI 的非密钥凭据元数据。
    """

    credential_id: str
    name: str
    provider: str
    kind: str
    state: str
    credential_ref: str
    created_at: str
    updated_at: str

    def as_dict(self) -> JsonObject:
        """Return metadata only; the secret is intentionally absent.

        只返回元数据；密钥会被有意省略。
        """

        return {
            "id": self.credential_id,
            "name": self.name,
            "provider": self.provider,
            "kind": self.kind,
            "state": self.state,
            "credentialRef": self.credential_ref,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class CredentialStore:
    """Process-local write-only credential store for the Web Host seam.

    Metadata and an in-memory secret resolver are kept separate. The resolver is
    available only to configured proxy targets; no HTTP response or exception
    contains the stored value. A later encrypted platform store can replace this
    class without changing the Web Host routes.

    供 Web Host 接口使用的进程内只写凭据存储。元数据与内存中的密钥解析器彼此分离。解析器仅对已配置的代理目标开放；HTTP 响应和异常都不包含已存储的值。后续可替换为加密的平台存储，而无需改变 Web Host 路由。
    """

    def __init__(self, *, clock: Clock = time.time) -> None:
        """Create an isolated store with an injectable clock for focused tests.

        创建隔离的存储，并允许注入时钟以便进行针对性测试。
        """

        self._clock = clock
        self._lock = RLock()
        self._records: dict[str, CredentialMetadata] = {}
        self._secrets: dict[str, str] = {}
        self._idempotency: dict[str, tuple[str, str]] = {}

    def create(
        self,
        *,
        name: str,
        provider: str,
        kind: str,
        secret: str,
        idempotency_key: str | None = None,
    ) -> tuple[CredentialMetadata, bool]:
        """Create metadata and retain the secret only for internal resolution.

        创建元数据，并仅为内部解析保留密钥。
        """

        _validate_credential_text(name, "name", max_length=200)
        _validate_credential_text(provider, "provider", max_length=100)
        _validate_credential_text(kind, "kind", max_length=100)
        _validate_secret(secret)
        fingerprint = _credential_fingerprint(name, provider, kind, secret)
        with self._lock:
            if idempotency_key is not None:
                previous = self._idempotency.get(idempotency_key)
                if previous is not None:
                    previous_fingerprint, previous_id = previous
                    if previous_fingerprint != fingerprint:
                        raise CredentialConflict(
                            "The idempotency key was already used for another credential."
                        )
                    return self._records[previous_id], True

            credential_id = str(uuid4())
            now = _iso_timestamp(self._clock())
            record = CredentialMetadata(
                credential_id=credential_id,
                name=name,
                provider=provider,
                kind=kind,
                state="ACTIVE",
                credential_ref=f"credential://{credential_id}",
                created_at=now,
                updated_at=now,
            )
            self._records[credential_id] = record
            self._secrets[credential_id] = secret
            if idempotency_key is not None:
                self._idempotency[idempotency_key] = (fingerprint, credential_id)
            return record, False

    def list(self) -> list[CredentialMetadata]:
        """Return stable metadata sorted by creation time and identifier.

        返回按创建时间和标识符排序的稳定元数据列表。
        """

        with self._lock:
            return sorted(
                self._records.values(), key=lambda row: (row.created_at, row.credential_id)
            )

    def get(self, credential_id: str) -> CredentialMetadata:
        """Read one metadata record without returning its secret.

        读取一条元数据记录，但不返回其密钥。
        """

        with self._lock:
            record = self._records.get(credential_id)
            if record is None:
                raise CredentialNotFound
            return record

    def update(
        self,
        credential_id: str,
        *,
        name: str | None = None,
        provider: str | None = None,
        kind: str | None = None,
        secret: str | None = None,
        secret_provided: bool = False,
    ) -> CredentialMetadata:
        """Update metadata or replace a secret without echoing either value.

        更新元数据或替换密钥，但不回显任一值。
        """

        with self._lock:
            current = self._records.get(credential_id)
            if current is None:
                raise CredentialNotFound
            if current.state != "ACTIVE":
                raise CredentialConflict("A revoked credential cannot be updated.")
            if name is not None:
                _validate_credential_text(name, "name", max_length=200)
            if provider is not None:
                _validate_credential_text(provider, "provider", max_length=100)
            if kind is not None:
                _validate_credential_text(kind, "kind", max_length=100)
            if secret_provided:
                _validate_secret(secret or "")
            if name is None and provider is None and kind is None and not secret_provided:
                raise CredentialConflict("The credential update contains no changes.")
            updated = CredentialMetadata(
                credential_id=current.credential_id,
                name=name if name is not None else current.name,
                provider=provider if provider is not None else current.provider,
                kind=kind if kind is not None else current.kind,
                state=current.state,
                credential_ref=current.credential_ref,
                created_at=current.created_at,
                updated_at=_iso_timestamp(self._clock()),
            )
            self._records[credential_id] = updated
            if secret_provided:
                self._secrets[credential_id] = secret or ""
            return updated

    def revoke(self, credential_id: str) -> CredentialMetadata:
        """Revoke metadata and erase the resolver value.

        撤销元数据并删除解析器中的值。
        """

        with self._lock:
            current = self._records.get(credential_id)
            if current is None:
                raise CredentialNotFound
            if current.state == "REVOKED":
                return current
            revoked = CredentialMetadata(
                credential_id=current.credential_id,
                name=current.name,
                provider=current.provider,
                kind=current.kind,
                state="REVOKED",
                credential_ref=current.credential_ref,
                created_at=current.created_at,
                updated_at=_iso_timestamp(self._clock()),
            )
            self._records[credential_id] = revoked
            self._secrets.pop(credential_id, None)
            return revoked

    def resolve(self, credential_ref: str) -> str | None:
        """Resolve an active configured reference for internal proxy use only.

        仅为内部代理用途解析处于活动状态的已配置引用。
        """

        prefix = "credential://"
        if not credential_ref.startswith(prefix):
            return None
        credential_id = credential_ref.removeprefix(prefix)
        with self._lock:
            record = self._records.get(credential_id)
            if record is None or record.state != "ACTIVE":
                return None
            return self._secrets.get(credential_id)

    def counts(self) -> dict[str, int]:
        """Return non-secret lifecycle counts for system status.

        返回用于系统状态的非密钥生命周期计数。
        """

        with self._lock:
            active = sum(record.state == "ACTIVE" for record in self._records.values())
            revoked = len(self._records) - active
            return {"active": active, "revoked": revoked}


@dataclass(frozen=True, slots=True)
class ProxyTarget:
    """One immutable allowlisted upstream origin and optional bearer source.

    一个不可变的 allowlist 上游 origin 和可选 bearer 来源。
    """

    base_url: str
    credential_ref: str | None = None
    bearer_token: str | None = field(default=None, repr=False)
    timeout_seconds: float = 10.0

    def __post_init__(self) -> None:
        """Reject origin changes, embedded credentials, and invalid timeouts.

        拒绝 origin 变更、内嵌凭据和无效超时设置。
        """

        object.__setattr__(self, "base_url", _validate_base_url(self.base_url))
        if self.credential_ref and self.bearer_token:
            raise ValueError("a proxy target cannot configure two credential sources")
        if self.credential_ref is not None and not self.credential_ref.strip():
            raise ValueError("credential_ref must be non-empty")
        if self.bearer_token is not None and not self.bearer_token:
            raise ValueError("bearer_token must be non-empty")
        if not math.isfinite(self.timeout_seconds) or self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive and finite")


@dataclass(frozen=True, slots=True)
class _SessionRecord:
    """Server-side session state; raw cookie tokens are never retained.

    服务端会话状态；不会保留原始 cookie token。
    """

    session_id: str
    access_hash: str
    refresh_hash: str
    csrf_token: str
    created_at: float
    access_expires_at: float
    refresh_expires_at: float


@dataclass(frozen=True, slots=True)
class _SessionCredentials:
    """Raw cookies returned only to the response cookie setter.

    仅供响应 cookie setter 使用的原始 cookie。
    """

    access_token: str
    refresh_token: str
    record: _SessionRecord


class WebHostState:
    """Own one-time pairing and rotating browser session state.

    管理一次性配对状态和轮换的浏览器会话状态。
    """

    def __init__(
        self,
        pairing_code: str,
        *,
        pairing_code_issued_at: float | None = None,
        session_ttl_seconds: float = 3600,
        refresh_ttl_seconds: float = 7 * 24 * 3600,
        clock: Clock = time.time,
    ) -> None:
        """Initialize a hashed pairing code and bounded session lifetimes.

        初始化经过哈希的配对码，并限制会话有效期。
        """

        if not isinstance(pairing_code, str) or not pairing_code or len(pairing_code) > 512:
            raise ValueError("pairing_code must be a non-empty string of at most 512 characters")
        if not math.isfinite(session_ttl_seconds) or session_ttl_seconds <= 0:
            raise ValueError("session_ttl_seconds must be positive and finite")
        if not math.isfinite(refresh_ttl_seconds) or refresh_ttl_seconds < session_ttl_seconds:
            raise ValueError("refresh_ttl_seconds must be at least the session lifetime")
        self._pairing_hash = _hash_secret(pairing_code)
        self._pairing_code_issued_at = pairing_code_issued_at
        self.session_ttl_seconds = session_ttl_seconds
        self.refresh_ttl_seconds = refresh_ttl_seconds
        self._clock = clock
        self._lock = RLock()
        self._pairing_consumed = False
        self._sessions: dict[str, _SessionRecord] = {}
        self._access_index: dict[str, str] = {}
        self._refresh_index: dict[str, str] = {}
        self._active_routes: dict[str, JsonObject] = {}

    def pair(self, pairing_code: str) -> _SessionCredentials:
        """Consume the pairing code exactly once and issue a fresh session.

        仅消费一次配对码，并签发新的会话。
        """

        with self._lock:
            now = self._clock()
            if (
                self._pairing_code_issued_at is not None
                and now - self._pairing_code_issued_at > 900
            ):
                raise WebHostError(
                    "NAVIGATOR_PAIR_CODE_EXPIRED",
                    410,
                    "The pairing code is invalid or has already been used.",
                )
            if self._pairing_consumed:
                status_code = 410 if self._pairing_code_issued_at is not None else 401
                raise WebHostError(
                    "NAVIGATOR_PAIR_CODE_CONSUMED",
                    status_code,
                    "The pairing code is invalid or has already been used.",
                )
            if not hmac.compare_digest(self._pairing_hash, _hash_secret(pairing_code)):
                raise WebHostError(
                    "NAVIGATOR_PAIRING_INVALID",
                    401,
                    "The pairing code is invalid or has already been used.",
                )
            self._pairing_consumed = True
            return self._issue_session_locked()

    def set_active_route(self, session_id: str, route: JsonObject) -> None:
        """Set the session-bound active gateway route.

        设置与当前会话绑定的活动网关路由。
        """

        with self._lock:
            self._active_routes[session_id] = route

    def get_active_route(self, session_id: str) -> JsonObject | None:
        """Get the session-bound active gateway route.

        读取与当前会话绑定的活动网关路由。
        """

        with self._lock:
            return self._active_routes.get(session_id)

    def current_session(self, access_token: str | None) -> _SessionRecord | None:
        """Resolve an unexpired access cookie without revealing failure details.

        解析未过期的访问 cookie，且不泄露失败细节。
        """

        if not access_token:
            return None
        with self._lock:
            record = self._record_for_hash_locked(self._access_index, _hash_secret(access_token))
            if record is None:
                return None
            now = self._clock()
            if record.refresh_expires_at <= now:
                self._delete_session_locked(record)
                return None
            if record.access_expires_at <= now:
                return None
            return record

    def current_refresh(self, refresh_token: str | None) -> _SessionRecord | None:
        """Resolve a still-valid refresh cookie for explicit session renewal.

        解析仍有效的 refresh cookie，以便显式续期会话。
        """

        if not refresh_token:
            return None
        with self._lock:
            record = self._record_for_hash_locked(self._refresh_index, _hash_secret(refresh_token))
            if record is None:
                return None
            if record.refresh_expires_at <= self._clock():
                self._delete_session_locked(record)
                return None
            return record

    def refresh(self, refresh_token: str) -> _SessionCredentials:
        """Rotate both browser cookies and invalidate the previous refresh token.

        轮换两个浏览器 cookie，并使先前的 refresh token 失效。
        """

        with self._lock:
            record = self._record_for_hash_locked(self._refresh_index, _hash_secret(refresh_token))
            if record is None or record.refresh_expires_at <= self._clock():
                if record is not None:
                    self._delete_session_locked(record)
                raise WebHostError(
                    "NAVIGATOR_SESSION_REFRESH_INVALID",
                    401,
                    "The session refresh credential is invalid or expired.",
                )
            self._delete_session_locked(record)
            return self._issue_session_locked(
                session_id=record.session_id,
                created_at=record.created_at,
                refresh_expires_at=record.refresh_expires_at,
            )

    def revoke(self, access_token: str) -> None:
        """Revoke the session represented by the current access cookie.

        撤销当前访问 cookie 所代表的会话。
        """

        with self._lock:
            record = self._record_for_hash_locked(self._access_index, _hash_secret(access_token))
            if record is not None:
                self._delete_session_locked(record)

    def csrf_matches(self, record: _SessionRecord, cookie: str | None, header: str | None) -> bool:
        """Apply a session-bound double-submit CSRF check.

        执行与会话绑定的 double-submit CSRF 校验。
        """

        return bool(
            cookie
            and header
            and hmac.compare_digest(record.csrf_token, cookie)
            and hmac.compare_digest(record.csrf_token, header)
        )

    def session_payload(self, record: _SessionRecord, *, refreshed: bool = False) -> JsonObject:
        """Build the non-secret login/session state returned to the browser.

        构建返回给浏览器的非密钥登录/会话状态。
        """

        return {
            "authenticated": True,
            "state": "AUTHENTICATED",
            "sessionId": record.session_id,
            "expiresAt": _iso_timestamp(record.access_expires_at),
            "refreshExpiresAt": _iso_timestamp(record.refresh_expires_at),
            "refreshable": record.refresh_expires_at > self._clock(),
            "csrfToken": record.csrf_token,
            "refreshed": refreshed,
        }

    def anonymous_payload(self) -> JsonObject:
        """Build a stable unauthenticated session response without an error.

        构建稳定的未认证会话响应，不返回错误。
        """

        refreshable = False
        return {
            "authenticated": False,
            "state": "ANONYMOUS",
            "sessionId": None,
            "expiresAt": None,
            "refreshExpiresAt": None,
            "refreshable": refreshable,
            "csrfToken": None,
            "refreshed": False,
        }

    def _issue_session_locked(
        self,
        *,
        session_id: str | None = None,
        created_at: float | None = None,
        refresh_expires_at: float | None = None,
    ) -> _SessionCredentials:
        now = self._clock()
        access_token = secrets.token_urlsafe(32)
        refresh_token = secrets.token_urlsafe(32)
        record = _SessionRecord(
            session_id=session_id or str(uuid4()),
            access_hash=_hash_secret(access_token),
            refresh_hash=_hash_secret(refresh_token),
            csrf_token=secrets.token_urlsafe(32),
            created_at=created_at if created_at is not None else now,
            access_expires_at=now + self.session_ttl_seconds,
            refresh_expires_at=(
                refresh_expires_at
                if refresh_expires_at is not None
                else now + self.refresh_ttl_seconds
            ),
        )
        self._sessions[record.session_id] = record
        self._access_index[record.access_hash] = record.session_id
        self._refresh_index[record.refresh_hash] = record.session_id
        return _SessionCredentials(access_token, refresh_token, record)

    def _record_for_hash_locked(
        self, index: Mapping[str, str], token_hash: str
    ) -> _SessionRecord | None:
        session_id = index.get(token_hash)
        return self._sessions.get(session_id) if session_id is not None else None

    def _delete_session_locked(self, record: _SessionRecord) -> None:
        self._sessions.pop(record.session_id, None)
        self._access_index.pop(record.access_hash, None)
        self._refresh_index.pop(record.refresh_hash, None)


@dataclass(frozen=True, slots=True)
class _ConfiguredProxy:
    """Normalized prefix and target pair used for longest-prefix matching.

    用于最长前缀匹配的规范化前缀与目标配对。
    """

    prefix: str
    target: ProxyTarget


# Gateway base URL used when neither an override nor an Exchange proxy target is
# configured. Matches the development stack that serves Exchange on port 8000.
# 当没有覆盖值或 Exchange 代理目标时使用的 Gateway 基础 URL，与开发栈中 Exchange 监听 8000 端口的配置一致。
DEFAULT_GATEWAY_BASE_URL = "http://127.0.0.1:8000/v1"
_GATEWAY_PROXY_PREFIX = "/api/proxy/exchange-gateway"


def _gateway_base_url(configured: Sequence[_ConfiguredProxy]) -> str:
    """Resolve the Exchange OpenAI-compatible base URL for client snippets.

    The port differs between the development stack and packaged deployments and
    can be HTTPS behind Caddy, so it is resolved here and published to the UI
    rather than guessed in the browser.

    解析供客户端示例使用的 Exchange OpenAI 兼容基础 URL。开发栈与打包部署使用的端口不同，且 Caddy 后方可能使用 HTTPS；因此由此处解析后提供给 UI，避免浏览器自行猜测。
    """

    override = os.environ.get("CYRENE_GATEWAY_BASE_URL", "").strip()
    if override:
        candidate = override
    else:
        candidate = DEFAULT_GATEWAY_BASE_URL
        for entry in configured:
            if entry.prefix.rstrip("/") == _GATEWAY_PROXY_PREFIX:
                candidate = entry.target.base_url
                break
    base = candidate.rstrip("/")
    return base if base.endswith("/v1") else f"{base}/v1"


def _query_gpu() -> dict[str, Any]:
    """调用 nvidia-smi 查询 GPU 信息，失败时返回 unavailable。"""
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.used,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if out.returncode != 0 or not out.stdout.strip():
            return {"available": False}
        gpus: list[dict[str, Any]] = []
        for line in out.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 4:
                gpus.append(
                    {
                        "name": parts[0],
                        "totalMib": float(parts[1]) if "." in parts[1] else int(parts[1]),
                        "usedMib": float(parts[2]) if "." in parts[2] else int(parts[2]),
                        "utilizationPct": float(parts[3]) if "." in parts[3] else int(parts[3]),
                    }
                )
        return {"available": True, "gpus": gpus}
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError, ValueError):
        return {"available": False}


def _query_disk() -> dict[str, Any]:
    """查询 Workspace 数据目录的磁盘使用情况。"""
    try:
        usage = shutil.disk_usage("/")
        total = usage.total if usage.total > 0 else 1
        return {
            "available": True,
            "totalGib": round(usage.total / 1024**3, 1),
            "usedGib": round(usage.used / 1024**3, 1),
            "freeGib": round(usage.free / 1024**3, 1),
            "usedPct": round(usage.used / total * 100, 1),
        }
    except OSError:
        return {"available": False}


def _query_services(proxies: Sequence[_ConfiguredProxy]) -> list[dict[str, Any]]:
    """对每个已配置的 proxy target 发送 GET /health，返回 UP/DOWN 状态。"""
    results: list[dict[str, Any]] = []
    for entry in proxies:
        name = entry.prefix.strip("/").split("/")[-1] or entry.prefix
        url = f"{entry.target.base_url.rstrip('/')}/health"
        start = time.perf_counter()
        status = "DOWN"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Cyrene-HealthCheck"})
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                if 200 <= resp.status < 300:
                    status = "UP"
        except Exception:
            status = "DOWN"
        latency_ms = round((time.perf_counter() - start) * 1000, 1)
        results.append(
            {
                "name": name,
                "url": url,
                "status": status,
                "latencyMs": latency_ms,
            }
        )
    return results


_INSTALL_ROOT_ENV = "CYRENE_INSTALL_ROOT"
_BOOTSTRAP_STATE_ENV = "CYRENE_BOOTSTRAP_STATE"
_CUDA_PROFILE_ENV = "CYRENE_CUDA_PROFILE"
_BOOTSTRAP_MARKER_NAME = "bootstrap-state.json"
_RELEASE_LOCK_NAME = "release-lock.json"


def _cyrene_roots() -> list[Path]:
    """Candidate install/workspace roots, most explicit first.

    A packaged host keeps everything under one install root; a development
    checkout keeps the release lock inside the Workspace repository.

    按明确程度从高到低排列的候选安装/工作区根目录。打包主机会将所有内容放在一个安装根目录下；开发检出则将 release lock 保存在 Workspace 仓库中。
    """

    roots: list[Path] = []
    override = os.environ.get(_INSTALL_ROOT_ENV, "").strip()
    if override:
        roots.append(Path(override))
    roots.append(Path("/usr/lib/cyrene"))
    for parent in Path(__file__).resolve().parents:
        roots.append(parent / "Cyrene-Workspace")
    return roots


def _locate_release_inputs() -> tuple[Path | None, Path | None]:
    """Return (release lock, bootstrap marker) from the first root that has one.

    从第一个包含这些文件的根目录返回 (release lock, bootstrap marker)。
    """

    fallback: tuple[Path | None, Path | None] = (None, None)
    for root in _cyrene_roots():
        lock = root / _RELEASE_LOCK_NAME
        marker = root / _BOOTSTRAP_MARKER_NAME
        if lock.is_file() or marker.is_file():
            return (lock if lock.is_file() else None, marker if marker.is_file() else None)
    return fallback


def _query_bootstrap() -> dict[str, Any]:
    """Report whether the pinned runtime was installed and verified.

    States: READY (bootstrap completed and left its marker), PENDING (pins are
    present but no completed bootstrap was recorded), UNKNOWN (neither found).

    报告固定版本的运行时是否已安装并验证。状态包括：READY（引导已完成并留下标记）、PENDING（存在版本固定信息，但没有已完成引导的记录）、UNKNOWN（两者都未找到）。
    """

    override = os.environ.get(_BOOTSTRAP_STATE_ENV, "").strip().upper()
    lock, marker = _locate_release_inputs()
    if override:
        return {"state": override, "source": "environment"}
    if marker is not None:
        try:
            document = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"state": "UNKNOWN", "source": "marker_unreadable"}
        state = str(document.get("state", "UNKNOWN")).upper()
        return {
            "state": state,
            "source": "marker",
            "completedAt": document.get("completedAt") or document.get("completed_at"),
        }
    if lock is not None:
        return {"state": "PENDING", "source": "release_lock_only"}
    return {"state": "UNKNOWN", "source": "not_found"}


def _query_runtime() -> dict[str, Any]:
    """Report the pinned engine versions and the CUDA wheel profile in use.

    报告固定的引擎版本和当前使用的 CUDA wheel 配置。
    """

    lock, _ = _locate_release_inputs()
    engines: dict[str, str] = {}
    if lock is not None:
        try:
            document = json.loads(lock.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            document = {}
        for _key, entry in (document.get("engines") or {}).items():
            if isinstance(entry, dict) and isinstance(entry.get("package"), str):
                version = entry.get("acceptedVersion") or entry.get("version")
                engines[entry["package"]] = str(version) if version else "UNKNOWN"
    profile = os.environ.get(_CUDA_PROFILE_ENV, "").strip() or "UNKNOWN"
    return {
        "releaseLock": str(lock) if lock is not None else None,
        "engines": engines,
        "cudaProfile": profile,
    }


def _diagnostics_degraded(services: list[dict[str, Any]], bootstrap: dict[str, Any]) -> bool:
    """Whether the host's view of the stack is known to be incomplete.

    True when a configured Product is unreachable or the runtime state could not
    be determined: in both cases any diagnostics shown elsewhere are partial.

    主机对系统栈的视图是否已知不完整。如果某个已配置 Product 无法访问，或无法确定运行时状态，则返回 True；这两种情况下其他位置显示的诊断信息都只是部分信息。
    """

    if any(entry.get("status") != "UP" for entry in services):
        return True
    return bootstrap.get("state") == "UNKNOWN"


def _compute_blockers(
    gpu: dict[str, Any], disk: dict[str, Any], services: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """计算会阻塞用户操作的状态，返回结构化列表。"""
    blockers: list[dict[str, Any]] = []
    if not gpu.get("available"):
        blockers.append(
            {
                "code": "GPU_UNAVAILABLE",
                "message": "No NVIDIA GPU detected. Training and serving require a GPU.",
            }
        )
    elif gpu.get("gpus") and all(g.get("totalMib", 0) < 12000 for g in gpu["gpus"]):
        blockers.append(
            {
                "code": "GPU_VRAM_INSUFFICIENT",
                "message": "GPU VRAM is less than 12 GiB. Training may fail.",
            }
        )
    if disk.get("available") and disk.get("freeGib", 999) < 50:
        free_gib = disk.get("freeGib")
        blockers.append(
            {
                "code": "DISK_LOW",
                "message": f"Free disk space is {free_gib} GiB. At least 50 GiB is recommended.",
            }
        )
    for svc in services:
        if svc.get("status") != "UP":
            code_name = svc["name"].upper().replace(" ", "_").replace("-", "_")
            blockers.append(
                {
                    "code": f"SERVICE_DOWN_{code_name}",
                    "message": f"{svc['name']} is unreachable.",
                }
            )
    return blockers


def _query_plugins(services: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """探测已知插件端点，返回 {name, kind, state} 列表。"""
    service_map = {s["name"]: s.get("status") == "UP" for s in services}
    yield_up = service_map.get("yield", False)
    reactor_up = service_map.get("reactor", False)
    return [
        {
            "name": "llama-factory",
            "kind": "training",
            "state": "READY" if yield_up else "UNKNOWN",
        },
        {
            "name": "vllm-runtime",
            "kind": "serving",
            "state": "READY" if reactor_up else "UNKNOWN",
        },
    ]


def create_web_host_app(
    *,
    pairing_code: str | None = None,
    pairing_code_issued_at: float | None = None,
    proxy_targets: Mapping[str, str | ProxyTarget] | None = None,
    credential_store: CredentialStore | None = None,
    app_version: str = "1.0.0",
    session_ttl_seconds: float = 3600,
    refresh_ttl_seconds: float = 7 * 24 * 3600,
    secure_cookies: bool = False,
    clock: Clock = time.time,
    http_client: httpx.AsyncClient | None = None,
) -> FastAPI:
    """Build the same-origin Web Host boundary.

    ``proxy_targets`` is the complete allowlist. Request data cannot select an
    origin, and proxy responses never set browser cookies from an upstream.

    构建同源 Web Host 边界。``proxy_targets`` 是完整 allowlist。请求数据不能选择 origin，代理响应也不会设置来自上游的浏览器 cookie。
    """

    resolved_pairing_code = (
        pairing_code or os.environ.get("CYRENE_WEB_HOST_PAIR_CODE") or generate_pairing_code()
    )
    resolved_issued_at = pairing_code_issued_at
    if resolved_issued_at is None:
        env_issued = os.environ.get("CYRENE_WEB_HOST_PAIR_CODE_ISSUED_AT")
        if env_issued:
            try:
                resolved_issued_at = float(env_issued)
            except ValueError:
                try:
                    resolved_issued_at = datetime.fromisoformat(env_issued).timestamp()
                except Exception:
                    resolved_issued_at = None

    state = WebHostState(
        resolved_pairing_code,
        pairing_code_issued_at=resolved_issued_at,
        session_ttl_seconds=session_ttl_seconds,
        refresh_ttl_seconds=refresh_ttl_seconds,
        clock=clock,
    )
    credentials = credential_store or CredentialStore(clock=clock)
    configured_proxies = _normalize_proxy_targets(proxy_targets or {})
    app = FastAPI(title="Cyrene Navigator Web Host", version=app_version)
    app.state.web_host_state = state
    app.state.web_host_credentials = credentials
    app.state.web_host_proxy_targets = configured_proxies

    @app.middleware("http")
    async def propagate_trace(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        """Propagate a valid W3C trace parent or create a local one.

        传播有效的 W3C traceparent；若无效则创建本地关联标识。
        """

        incoming = request.headers.get("traceparent", "")
        match = re.fullmatch(_TRACEPARENT, incoming)
        if match is None or match.group(1) == "0" * 32 or match.group(2) == "0" * 16:
            trace_id = uuid4().hex
            traceparent = f"00-{trace_id}-0000000000000001-01"
            tracestate = None
        else:
            trace_id = match.group(1)
            traceparent = incoming
            tracestate = request.headers.get("tracestate")
        request.state.trace_id = trace_id
        request.state.traceparent = traceparent
        request.state.tracestate = tracestate
        response = await call_next(request)
        response.headers["traceparent"] = traceparent
        if tracestate:
            response.headers["tracestate"] = tracestate
        return response

    @app.exception_handler(WebHostError)
    async def web_host_error(request: Request, exc: WebHostError) -> JSONResponse:
        """Render a stable RFC 9457 response without sensitive request data.

        生成稳定的 RFC 9457 响应，不包含敏感请求数据。
        """

        return _problem_response(request, exc.code, exc.status, exc.detail, exc.retryable)

    @app.exception_handler(CredentialStoreError)
    async def credential_error(request: Request, exc: CredentialStoreError) -> JSONResponse:
        """Translate internal credential errors without revealing their values.

        转换内部凭据错误，同时不泄露凭据值。
        """

        return _problem_response(request, exc.code, exc.status, exc.detail, False)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, _exc: RequestValidationError) -> JSONResponse:
        """Render generic validation details so secrets never enter error payloads.

        生成通用校验详情，确保密钥不会进入错误载荷。
        """

        return _problem_response(
            request,
            "NAVIGATOR_REQUEST_INVALID",
            422,
            "The request does not conform to the Navigator Web Host contract.",
            False,
        )

    def cookie_secure(request: Request) -> bool:
        """Use Secure cookies for HTTPS while permitting explicit local HTTP mode.

        HTTPS 下使用 Secure cookie，同时允许显式启用本地 HTTP 模式。
        """

        return secure_cookies or request.url.scheme == "https"

    def set_session_cookies(
        response: Response, request: Request, issued: _SessionCredentials
    ) -> None:
        """Set rotated HttpOnly session/refresh cookies and a readable CSRF cookie.

        设置已轮换的 HttpOnly session/refresh cookie，以及可读取的 CSRF cookie。
        """

        secure = cookie_secure(request)
        response.set_cookie(
            _SESSION_COOKIE,
            issued.access_token,
            max_age=max(1, int(issued.record.access_expires_at - clock())),
            httponly=True,
            secure=secure,
            samesite="lax",
            path="/",
        )
        response.set_cookie(
            _REFRESH_COOKIE,
            issued.refresh_token,
            max_age=max(1, int(issued.record.refresh_expires_at - clock())),
            httponly=True,
            secure=secure,
            samesite="lax",
            path="/",
        )
        response.set_cookie(
            _CSRF_COOKIE,
            issued.record.csrf_token,
            max_age=max(1, int(issued.record.refresh_expires_at - clock())),
            httponly=False,
            secure=secure,
            samesite="lax",
            path="/",
        )

    def clear_session_cookies(response: Response) -> None:
        """Expire all Web Host cookies without returning their previous values.

        使所有 Web Host cookie 过期，但不返回旧值。
        """

        for cookie_name in (_SESSION_COOKIE, _REFRESH_COOKIE, _CSRF_COOKIE):
            response.delete_cookie(cookie_name, path="/")

    def require_session(request: Request, *, mutation: bool = False) -> _SessionRecord:
        """Authenticate the access cookie and optionally enforce CSRF.

        验证访问 cookie，并可按需执行 CSRF 校验。
        """

        record = state.current_session(request.cookies.get(_SESSION_COOKIE))
        if record is None:
            raise WebHostError(
                "NAVIGATOR_AUTH_REQUIRED",
                401,
                "An authenticated Web Host session is required.",
            )
        if mutation and not state.csrf_matches(
            record,
            request.cookies.get(_CSRF_COOKIE),
            request.headers.get("x-csrf-token"),
        ):
            raise WebHostError(
                "NAVIGATOR_CSRF_INVALID",
                403,
                "A matching CSRF token is required for this mutation.",
            )
        return record

    def require_refresh_csrf(request: Request, record: _SessionRecord) -> None:
        """Apply the same double-submit check when only refresh state remains.

        仅剩 refresh 状态时，也执行相同的 double-submit 校验。
        """

        if not state.csrf_matches(
            record,
            request.cookies.get(_CSRF_COOKIE),
            request.headers.get("x-csrf-token"),
        ):
            raise WebHostError(
                "NAVIGATOR_CSRF_INVALID",
                403,
                "A matching CSRF token is required for this mutation.",
            )

    @app.post("/api/v1/auth/pair")
    def pair(body: PairingRequest, request: Request) -> Response:
        """Consume the stdout-delivered pairing code and establish browser state.

        消费通过 stdout 传递的配对码，并建立浏览器状态。
        """

        issued = state.pair(body.resolved_code())
        response = JSONResponse(state.session_payload(issued.record))
        set_session_cookies(response, request, issued)
        return response

    @app.get("/api/v1/auth/session")
    def get_session(request: Request) -> JsonObject:
        """Return login/refresh state without turning anonymous access into an error.

        返回登录/刷新状态，不将匿名访问转换为错误。
        """

        record = state.current_session(request.cookies.get(_SESSION_COOKIE))
        if record is not None:
            return state.session_payload(record)
        refreshable = state.current_refresh(request.cookies.get(_REFRESH_COOKIE)) is not None
        payload = state.anonymous_payload()
        payload["refreshable"] = refreshable
        return payload

    @app.post("/api/v1/auth/session/refresh")
    def refresh_session(request: Request) -> Response:
        """Rotate a valid refresh cookie and require CSRF when it is used.

        轮换有效的 refresh cookie，并在使用时要求通过 CSRF 校验。
        """

        old_record = state.current_refresh(request.cookies.get(_REFRESH_COOKIE))
        if old_record is None:
            raise WebHostError(
                "NAVIGATOR_SESSION_REFRESH_INVALID",
                401,
                "The session refresh credential is invalid or expired.",
            )
        require_refresh_csrf(request, old_record)
        issued = state.refresh(request.cookies.get(_REFRESH_COOKIE) or "")
        response = JSONResponse(state.session_payload(issued.record, refreshed=True))
        set_session_cookies(response, request, issued)
        return response

    @app.delete("/api/v1/auth/session", status_code=204)
    def delete_session(request: Request) -> Response:
        """Revoke the current session and clear all browser credentials.

        撤销当前会话并清除所有浏览器凭据。
        """

        require_session(request, mutation=True)
        state.revoke(request.cookies.get(_SESSION_COOKIE) or "")
        response = Response(status_code=204)
        clear_session_cookies(response)
        return response

    @app.get("/api/v1/system/status")
    def system_status(request: Request) -> JsonObject:
        """Return safe host readiness and non-secret credential lifecycle state.

        返回安全的主机就绪状态和非密钥凭据生命周期状态。
        """

        authenticated = state.current_session(request.cookies.get(_SESSION_COOKIE)) is not None
        counts = credentials.counts()
        gpu_info = _query_gpu()
        disk_info = _query_disk()
        svc_info = _query_services(configured_proxies)
        bootstrap_info = _query_bootstrap()
        runtime_info = _query_runtime()
        return {
            "service": "cyrene-navigator-web-host",
            "status": "ok",
            "version": app_version,
            "authenticated": authenticated,
            "proxyPrefixes": [entry.prefix for entry in configured_proxies],
            "credentials": counts,
            "gpu": gpu_info,
            "disk": disk_info,
            "services": svc_info,
            "blockers": _compute_blockers(gpu_info, disk_info, svc_info),
            "plugins": _query_plugins(svc_info),
            # Whether the pinned runtime is installed, which engine versions it
            # holds, and whether this host can see the whole stack. A console
            # cannot decide what to offer without them.
            # 用于判断固定运行时是否已安装、包含哪些引擎版本，以及主机能否访问完整系统栈。缺少这些信息时，控制台无法确定应提供哪些选项。
            "bootstrapState": bootstrap_info,
            "runtime": runtime_info,
            "diagnosticsDegraded": _diagnostics_degraded(svc_info, bootstrap_info),
            # The Exchange OpenAI-compatible gateway port differs between the
            # dev stack and packaged deployments, so it is published here
            # instead of being guessed in the browser.
            # Exchange OpenAI 兼容网关在开发栈和打包部署中的端口不同，因此在此发布给 UI，避免由浏览器猜测。
            "gatewayBaseUrl": _gateway_base_url(configured_proxies),
            "observedAt": _iso_timestamp(clock()),
        }

    @app.post("/api/v1/credentials", status_code=201)
    def create_credential(body: CredentialCreateRequest, request: Request) -> JsonObject:
        """Create credential metadata without returning the supplied secret.

        创建凭据元数据，但不返回所提供的密钥。
        """

        require_session(request, mutation=True)
        record, _replayed = credentials.create(
            name=body.name,
            provider=body.provider,
            kind=body.resolved_kind(),
            secret=body.resolved_secret(),
            idempotency_key=_idempotency_key(request),
        )
        return record.as_dict()

    @app.get("/api/v1/credentials")
    def list_credentials(request: Request) -> list[JsonObject]:
        """List credential metadata while omitting every secret value.

        列出凭据元数据，并省略所有密钥值。
        """

        require_session(request)
        return [record.as_dict() for record in credentials.list()]

    @app.get("/api/v1/credentials/{credential_id}")
    def get_credential(credential_id: str, request: Request) -> JsonObject:
        """Read one credential metadata record without secret recovery.

        读取一条凭据元数据记录，不提供密钥恢复功能。
        """

        require_session(request)
        return credentials.get(credential_id).as_dict()

    @app.put("/api/v1/credentials/{credential_id}")
    @app.patch("/api/v1/credentials/{credential_id}")
    def update_credential(
        credential_id: str, body: CredentialUpdateRequest, request: Request
    ) -> JsonObject:
        """Update metadata or rotate a secret without echoing the new value.

        更新元数据或轮换密钥，不回显新值。
        """

        require_session(request, mutation=True)
        return credentials.update(
            credential_id,
            name=body.name,
            provider=body.provider,
            kind=body.resolved_kind(),
            secret=body.resolved_secret(),
            secret_provided=body.has_secret_change(),
        ).as_dict()

    @app.delete("/api/v1/credentials/{credential_id}")
    def delete_credential(credential_id: str, request: Request) -> JsonObject:
        """Revoke a credential as the deletion operation while retaining metadata.

        通过删除操作撤销凭据，同时保留元数据。
        """

        require_session(request, mutation=True)
        return credentials.revoke(credential_id).as_dict()

    @app.post("/api/v1/credentials/{credential_id}/actions/revoke")
    def revoke_credential(credential_id: str, request: Request) -> JsonObject:
        """Expose an explicit action alias for clients that do not use DELETE.

        为不使用 DELETE 的客户端提供显式操作别名。
        """

        require_session(request, mutation=True)
        return credentials.revoke(credential_id).as_dict()

    @app.post("/api/v1/navigator/active-route")
    def set_active_route(body: ActiveRouteRequest, request: Request) -> JsonObject:
        """Store the session-level active gateway route.

        保存会话级活动网关路由。
        """

        record = require_session(request, mutation=True)
        route_data = body.model_dump(by_alias=True)
        state.set_active_route(record.session_id, route_data)
        return {"status": "ok", **route_data}

    @app.get("/api/v1/navigator/active-route")
    def get_active_route(request: Request) -> JsonObject:
        """Read the session-level active gateway route.

        读取会话级活动网关路由。
        """

        record = require_session(request)
        route = state.get_active_route(record.session_id)
        if route is None:
            raise WebHostError(
                "NAVIGATOR_ACTIVE_ROUTE_NOT_FOUND",
                404,
                "No active gateway route has been configured in this session.",
            )
        return route

    @app.api_route(
        "/{proxy_path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
        include_in_schema=False,
    )
    async def proxy_request(proxy_path: str, request: Request) -> Response:
        """Forward only to the configured longest matching prefix.

        仅向配置中最长匹配前缀对应的目标转发。
        """

        del proxy_path
        target_entry = _match_proxy_target(request.url.path, configured_proxies)
        if target_entry is None:
            raise WebHostError(
                "NAVIGATOR_PROXY_NOT_ALLOWED",
                404,
                "The requested Web Host path is not allowlisted.",
            )
        require_session(request, mutation=request.method in _MUTATING_METHODS)
        target = target_entry.target
        suffix = request.url.path.removeprefix(target_entry.prefix)
        upstream_url = target.base_url + (suffix or "/")
        if request.url.query:
            upstream_url += "?" + request.url.query
        headers = {
            name: value for name, value in request.headers.items() if name in _PROXY_REQUEST_HEADERS
        }
        headers.setdefault("traceparent", request.state.traceparent)
        if request.state.tracestate:
            headers.setdefault("tracestate", request.state.tracestate)
        if target_entry.prefix.rstrip("/") == "/api/proxy/exchange-gateway":
            if "authorization" in request.headers:
                headers["authorization"] = request.headers["authorization"]
            upstream_url = re.sub(r"/v1/v1/", "/v1/", upstream_url)
        elif target.bearer_token is not None:
            headers["authorization"] = f"Bearer {target.bearer_token}"
        elif target.credential_ref is not None:
            secret = credentials.resolve(target.credential_ref)
            if secret is None:
                raise WebHostError(
                    "NAVIGATOR_PROXY_CREDENTIAL_UNAVAILABLE",
                    502,
                    "The configured proxy credential is unavailable.",
                    retryable=True,
                )
            headers["authorization"] = f"Bearer {secret}"
        body = await request.body()
        is_stream = "text/event-stream" in request.headers.get("accept", "").lower()
        if is_stream:
            try:
                client = http_client or httpx.AsyncClient(follow_redirects=False)
                req = client.build_request(
                    request.method, upstream_url, content=body, headers=headers, timeout=600.0
                )
                upstream_stream = await client.send(req, stream=True)
                return StreamingResponse(
                    upstream_stream.aiter_raw(),
                    status_code=upstream_stream.status_code,
                    headers={
                        name: value
                        for name, value in upstream_stream.headers.items()
                        if name in _PROXY_RESPONSE_HEADERS
                    },
                    media_type="text/event-stream",
                )
            except httpx.RequestError as exc:
                raise WebHostError(
                    "NAVIGATOR_PROXY_UNAVAILABLE",
                    502,
                    "The configured upstream is unavailable.",
                    retryable=True,
                ) from exc
        try:
            if http_client is None:
                async with httpx.AsyncClient(follow_redirects=False) as client:
                    upstream = await client.request(
                        request.method,
                        upstream_url,
                        content=body,
                        headers=headers,
                        timeout=target.timeout_seconds,
                    )
            else:
                upstream = await http_client.request(
                    request.method,
                    upstream_url,
                    content=body,
                    headers=headers,
                    timeout=target.timeout_seconds,
                )
        except httpx.RequestError as exc:
            raise WebHostError(
                "NAVIGATOR_PROXY_UNAVAILABLE",
                502,
                "The configured upstream is unavailable.",
                retryable=True,
            ) from exc
        response_headers = {
            name: value
            for name, value in upstream.headers.items()
            if name in _PROXY_RESPONSE_HEADERS
        }
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            headers=response_headers,
        )

    return app


create_app = create_web_host_app


def generate_pairing_code() -> str:
    """Generate a high-entropy one-time code for the Web Host launcher.

    为 Web Host 启动器生成高熵的一次性配对码。
    """

    return secrets.token_urlsafe(18)


def _problem_response(
    request: Request, code: str, status: int, detail: str, retryable: bool
) -> JSONResponse:
    """Create a generic RFC 9457 response with the request trace identifier."""

    trace_id = getattr(request.state, "trace_id", uuid4().hex)
    content = {
        "type": f"https://errors.cyrene.dev/navigator/web-host/{code.lower()}",
        "title": code.replace("_", " ").title(),
        "status": status,
        "detail": detail,
        "instance": request.url.path,
        "code": code,
        "retryable": retryable,
        "traceId": trace_id,
    }
    headers = {"WWW-Authenticate": "Session"} if status == 401 else None
    return JSONResponse(
        status_code=status,
        content=content,
        headers=headers,
        media_type="application/problem+json",
    )


def _idempotency_key(request: Request) -> str | None:
    """Read and bound an optional mutation idempotency key.

    读取可选的变更幂等键，并限制其长度。
    """

    value = request.headers.get("idempotency-key")
    if value is not None and (not value or len(value) > 200):
        raise WebHostError(
            "NAVIGATOR_IDEMPOTENCY_INVALID",
            422,
            "Idempotency-Key must be between 1 and 200 characters.",
        )
    return value


def _normalize_proxy_targets(
    values: Mapping[str, str | ProxyTarget],
) -> tuple[_ConfiguredProxy, ...]:
    """Validate and freeze the fixed prefix-to-origin allowlist.

    验证并冻结固定的前缀到 origin allowlist。
    """

    normalized: dict[str, ProxyTarget] = {}
    for prefix, target in values.items():
        key = _normalize_prefix(prefix)
        if key in normalized:
            raise ValueError(f"duplicate proxy prefix: {key}")
        normalized[key] = ProxyTarget(target) if isinstance(target, str) else target
    return tuple(
        _ConfiguredProxy(prefix, normalized[prefix])
        for prefix in sorted(normalized, key=lambda item: (-len(item), item))
    )


def _match_proxy_target(
    path: str, configured: tuple[_ConfiguredProxy, ...]
) -> _ConfiguredProxy | None:
    """Find an exact or slash-delimited prefix without accepting traversal.

    查找精确前缀或以斜杠分隔的前缀，同时拒绝路径穿越。
    """

    _validate_proxy_path(path)
    for entry in configured:
        if path == entry.prefix or path.startswith(entry.prefix + "/"):
            return entry
    return None


def _normalize_prefix(value: str) -> str:
    """Normalize an allowlist prefix and reject URL or traversal syntax.

    规范化 allowlist 前缀，并拒绝 URL 或路径穿越语法。
    """

    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError("proxy prefixes must be absolute paths")
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("proxy prefixes cannot contain a URL authority or query")
    _validate_proxy_path(parsed.path)
    normalized = parsed.path.rstrip("/")
    if not normalized:
        raise ValueError("the root path cannot be a proxy prefix")
    return normalized


def _validate_proxy_path(path: str) -> None:
    """Reject encoded traversal and authority changes before forwarding.

    转发前拒绝编码后的路径穿越和 authority 变更。
    """

    decoded = path
    for _ in range(len(path) + 1):
        next_path = unquote(decoded)
        if next_path == decoded:
            break
        decoded = next_path
    if (
        not decoded.startswith("/")
        or decoded.startswith("//")
        or "//" in decoded
        or "\\" in decoded
        or "://" in decoded
        or any(ord(character) < 32 or ord(character) == 127 for character in decoded)
        or any(segment in {".", ".."} for segment in decoded.split("/"))
    ):
        raise WebHostError(
            "NAVIGATOR_PROXY_PATH_INVALID",
            400,
            "The proxy path is not a safe relative API path.",
        )


def _validate_base_url(value: str) -> str:
    """Require a configured HTTP(S) origin without embedded user credentials.

    要求配置 HTTP(S) origin，且不得内嵌用户凭据。
    """

    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("proxy base URLs must be credential-free HTTP(S) URLs")
    _validate_proxy_path(parsed.path or "/")
    return value.rstrip("/")


def _validate_credential_text(value: str, field: str, *, max_length: int) -> None:
    """Validate metadata without ever including the supplied value in an error.

    校验元数据，且错误信息绝不包含所提供的值。
    """

    if not isinstance(value, str) or not value.strip() or len(value) > max_length:
        raise CredentialStoreError(
            "NAVIGATOR_CREDENTIAL_INVALID",
            f"credential {field} is invalid",
            status=422,
        )


def _validate_secret(value: str, *, field: str = "secret") -> None:
    """Validate a secret's shape without retaining it in exception text.

    校验密钥格式，但不将密钥保留在异常文本中。
    """

    if not isinstance(value, str) or not value or len(value) > 10_000:
        raise CredentialStoreError(
            "NAVIGATOR_CREDENTIAL_INVALID",
            f"credential {field} is invalid",
            status=422,
        )


def _credential_fingerprint(name: str, provider: str, kind: str, secret: str) -> str:
    """Build an idempotency fingerprint without storing the raw secret.

    生成幂等指纹，不存储原始密钥。
    """

    secret_hash = _hash_secret(secret)
    value = "\0".join((name, provider, kind, secret_hash)).encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def _hash_secret(value: str) -> str:
    """Hash an opaque pairing, cookie, or credential value for comparisons.

    对不透明的配对码、cookie 或凭据值进行哈希，以供比较使用。
    """

    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _iso_timestamp(value: float) -> str:
    """Format a UTC timestamp consistently across auth and metadata responses.

    在身份验证和元数据响应中统一格式化 UTC 时间戳。
    """

    return datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z")
