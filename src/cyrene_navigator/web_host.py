"""
Navigator same-origin Web Host authentication, credentials, and proxy boundary.

The host owns browser-facing session state only. Product APIs remain behind
explicitly configured proxy prefixes, and credential values are write-only at
the HTTP boundary.
"""

from __future__ import annotations

import hashlib
import hmac
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
from threading import RLock
from typing import Any
from urllib.parse import unquote, urlsplit
from uuid import uuid4

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
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
    """Strict camelCase request model used by the Web Host boundary."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
        strict=True,
    )


class PairingRequest(WebHostModel):
    """Accept the documented pairingCode and a short code compatibility alias."""

    pairing_code: str | None = Field(default=None, min_length=1, max_length=512)
    code: str | None = Field(default=None, min_length=1, max_length=512)

    @model_validator(mode="after")
    def require_code(self) -> PairingRequest:
        """Require one non-empty pairing value without exposing it in errors."""

        if self.pairing_code is None and self.code is None:
            raise ValueError("a pairing code is required")
        return self

    def resolved_code(self) -> str:
        """Return the supplied pairing value, preferring the canonical field."""

        return self.pairing_code or self.code or ""


class CredentialCreateRequest(WebHostModel):
    """Write-only credential input; neither secret field is ever serialized back."""

    name: str = Field(min_length=1, max_length=200)
    provider: str = Field(default="generic", min_length=1, max_length=100)
    kind: str | None = Field(default=None, min_length=1, max_length=100)
    type: str | None = Field(default=None, min_length=1, max_length=100)
    secret: SecretStr | None = None
    token: SecretStr | None = None

    @model_validator(mode="after")
    def require_secret(self) -> CredentialCreateRequest:
        """Require a value while keeping validation responses value-free."""

        if self.secret is None and self.token is None:
            raise ValueError("a credential secret is required")
        return self

    def resolved_kind(self) -> str:
        """Return the canonical metadata kind."""

        return self.kind or self.type or "generic"

    def resolved_secret(self) -> str:
        """Return the write-only value for internal storage."""

        value = self.secret or self.token
        return value.get_secret_value() if value is not None else ""


class CredentialUpdateRequest(WebHostModel):
    """Mutable credential metadata and optional replacement secret."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    provider: str | None = Field(default=None, min_length=1, max_length=100)
    kind: str | None = Field(default=None, min_length=1, max_length=100)
    type: str | None = Field(default=None, min_length=1, max_length=100)
    secret: SecretStr | None = None
    token: SecretStr | None = None

    @model_validator(mode="after")
    def require_change(self) -> CredentialUpdateRequest:
        """Reject empty updates before any store mutation occurs."""

        if not self.model_fields_set:
            raise ValueError("at least one credential field is required")
        return self

    def resolved_secret(self) -> str | None:
        """Return a replacement secret when one was supplied."""

        value = self.secret or self.token
        return value.get_secret_value() if value is not None else None

    def has_secret_change(self) -> bool:
        """Report whether the request explicitly supplied a secret field."""

        return "secret" in self.model_fields_set or "token" in self.model_fields_set

    def resolved_kind(self) -> str | None:
        """Return the requested kind alias, if present."""

        return self.kind or self.type


class WebHostError(RuntimeError):
    """Stable problem response raised by the browser-facing host boundary."""

    def __init__(self, code: str, status: int, detail: str, *, retryable: bool = False) -> None:
        super().__init__(detail)
        self.code = code
        self.status = status
        self.detail = detail
        self.retryable = retryable


class CredentialStoreError(RuntimeError):
    """Internal credential-store failure that contains no credential value."""

    def __init__(self, code: str, detail: str, *, status: int) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status = status


class CredentialNotFound(CredentialStoreError):
    """Raised when a credential is not in the host's metadata store."""

    def __init__(self) -> None:
        super().__init__(
            "NAVIGATOR_CREDENTIAL_NOT_FOUND",
            "The requested credential does not exist.",
            status=404,
        )


class CredentialConflict(CredentialStoreError):
    """Raised for conflicting idempotency keys or invalid credential state."""

    def __init__(self, detail: str) -> None:
        super().__init__("NAVIGATOR_CREDENTIAL_CONFLICT", detail, status=409)


@dataclass(frozen=True, slots=True)
class CredentialMetadata:
    """Non-secret credential metadata returned to the WebUI."""

    credential_id: str
    name: str
    provider: str
    kind: str
    state: str
    credential_ref: str
    created_at: str
    updated_at: str

    def as_dict(self) -> JsonObject:
        """Return metadata only; the secret is intentionally absent."""

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
    """

    def __init__(self, *, clock: Clock = time.time) -> None:
        """Create an isolated store with an injectable clock for focused tests."""

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
        """Create metadata and retain the secret only for internal resolution."""

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
        """Return stable metadata sorted by creation time and identifier."""

        with self._lock:
            return sorted(
                self._records.values(), key=lambda row: (row.created_at, row.credential_id)
            )

    def get(self, credential_id: str) -> CredentialMetadata:
        """Read one metadata record without returning its secret."""

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
        """Update metadata or replace a secret without echoing either value."""

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
        """Revoke metadata and erase the resolver value."""

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
        """Resolve an active configured reference for internal proxy use only."""

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
        """Return non-secret lifecycle counts for system status."""

        with self._lock:
            active = sum(record.state == "ACTIVE" for record in self._records.values())
            revoked = len(self._records) - active
            return {"active": active, "revoked": revoked}


@dataclass(frozen=True, slots=True)
class ProxyTarget:
    """One immutable allowlisted upstream origin and optional bearer source."""

    base_url: str
    credential_ref: str | None = None
    bearer_token: str | None = field(default=None, repr=False)
    timeout_seconds: float = 10.0

    def __post_init__(self) -> None:
        """Reject origin changes, embedded credentials, and invalid timeouts."""

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
    """Server-side session state; raw cookie tokens are never retained."""

    session_id: str
    access_hash: str
    refresh_hash: str
    csrf_token: str
    created_at: float
    access_expires_at: float
    refresh_expires_at: float


@dataclass(frozen=True, slots=True)
class _SessionCredentials:
    """Raw cookies returned only to the response cookie setter."""

    access_token: str
    refresh_token: str
    record: _SessionRecord


class WebHostState:
    """Own one-time pairing and rotating browser session state."""

    def __init__(
        self,
        pairing_code: str,
        *,
        session_ttl_seconds: float = 3600,
        refresh_ttl_seconds: float = 7 * 24 * 3600,
        clock: Clock = time.time,
    ) -> None:
        """Initialize a hashed pairing code and bounded session lifetimes."""

        if not isinstance(pairing_code, str) or not pairing_code or len(pairing_code) > 512:
            raise ValueError("pairing_code must be a non-empty string of at most 512 characters")
        if not math.isfinite(session_ttl_seconds) or session_ttl_seconds <= 0:
            raise ValueError("session_ttl_seconds must be positive and finite")
        if not math.isfinite(refresh_ttl_seconds) or refresh_ttl_seconds < session_ttl_seconds:
            raise ValueError("refresh_ttl_seconds must be at least the session lifetime")
        self._pairing_hash = _hash_secret(pairing_code)
        self.session_ttl_seconds = session_ttl_seconds
        self.refresh_ttl_seconds = refresh_ttl_seconds
        self._clock = clock
        self._lock = RLock()
        self._pairing_consumed = False
        self._sessions: dict[str, _SessionRecord] = {}
        self._access_index: dict[str, str] = {}
        self._refresh_index: dict[str, str] = {}

    def pair(self, pairing_code: str) -> _SessionCredentials:
        """Consume the pairing code exactly once and issue a fresh session."""

        with self._lock:
            if self._pairing_consumed or not hmac.compare_digest(
                self._pairing_hash, _hash_secret(pairing_code)
            ):
                raise WebHostError(
                    "NAVIGATOR_PAIRING_INVALID",
                    401,
                    "The pairing code is invalid or has already been used.",
                )
            self._pairing_consumed = True
            return self._issue_session_locked()

    def current_session(self, access_token: str | None) -> _SessionRecord | None:
        """Resolve an unexpired access cookie without revealing failure details."""

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
        """Resolve a still-valid refresh cookie for explicit session renewal."""

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
        """Rotate both browser cookies and invalidate the previous refresh token."""

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
        """Revoke the session represented by the current access cookie."""

        with self._lock:
            record = self._record_for_hash_locked(self._access_index, _hash_secret(access_token))
            if record is not None:
                self._delete_session_locked(record)

    def csrf_matches(self, record: _SessionRecord, cookie: str | None, header: str | None) -> bool:
        """Apply a session-bound double-submit CSRF check."""

        return bool(
            cookie
            and header
            and hmac.compare_digest(record.csrf_token, cookie)
            and hmac.compare_digest(record.csrf_token, header)
        )

    def session_payload(self, record: _SessionRecord, *, refreshed: bool = False) -> JsonObject:
        """Build the non-secret login/session state returned to the browser."""

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
        """Build a stable unauthenticated session response without an error."""

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
    """Normalized prefix and target pair used for longest-prefix matching."""

    prefix: str
    target: ProxyTarget


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


def create_web_host_app(
    *,
    pairing_code: str | None = None,
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
    """

    resolved_pairing_code = (
        pairing_code or os.environ.get("CYRENE_WEB_HOST_PAIR_CODE") or generate_pairing_code()
    )
    state = WebHostState(
        resolved_pairing_code,
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
        """Propagate a valid W3C trace parent or create a local one."""

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
        """Render a stable RFC 9457 response without sensitive request data."""

        return _problem_response(request, exc.code, exc.status, exc.detail, exc.retryable)

    @app.exception_handler(CredentialStoreError)
    async def credential_error(request: Request, exc: CredentialStoreError) -> JSONResponse:
        """Translate internal credential errors without revealing their values."""

        return _problem_response(request, exc.code, exc.status, exc.detail, False)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, _exc: RequestValidationError) -> JSONResponse:
        """Render generic validation details so secrets never enter error payloads."""

        return _problem_response(
            request,
            "NAVIGATOR_REQUEST_INVALID",
            422,
            "The request does not conform to the Navigator Web Host contract.",
            False,
        )

    def cookie_secure(request: Request) -> bool:
        """Use Secure cookies for HTTPS while permitting explicit local HTTP mode."""

        return secure_cookies or request.url.scheme == "https"

    def set_session_cookies(
        response: Response, request: Request, issued: _SessionCredentials
    ) -> None:
        """Set rotated HttpOnly session/refresh cookies and a readable CSRF cookie."""

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
        """Expire all Web Host cookies without returning their previous values."""

        for cookie_name in (_SESSION_COOKIE, _REFRESH_COOKIE, _CSRF_COOKIE):
            response.delete_cookie(cookie_name, path="/")

    def require_session(request: Request, *, mutation: bool = False) -> _SessionRecord:
        """Authenticate the access cookie and optionally enforce CSRF."""

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
        """Apply the same double-submit check when only refresh state remains."""

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
        """Consume the stdout-delivered pairing code and establish browser state."""

        issued = state.pair(body.resolved_code())
        response = JSONResponse(state.session_payload(issued.record))
        set_session_cookies(response, request, issued)
        return response

    @app.get("/api/v1/auth/session")
    def get_session(request: Request) -> JsonObject:
        """Return login/refresh state without turning anonymous access into an error."""

        record = state.current_session(request.cookies.get(_SESSION_COOKIE))
        if record is not None:
            return state.session_payload(record)
        refreshable = state.current_refresh(request.cookies.get(_REFRESH_COOKIE)) is not None
        payload = state.anonymous_payload()
        payload["refreshable"] = refreshable
        return payload

    @app.post("/api/v1/auth/session/refresh")
    def refresh_session(request: Request) -> Response:
        """Rotate a valid refresh cookie and require CSRF when it is used."""

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
        """Revoke the current session and clear all browser credentials."""

        require_session(request, mutation=True)
        state.revoke(request.cookies.get(_SESSION_COOKIE) or "")
        response = Response(status_code=204)
        clear_session_cookies(response)
        return response

    @app.get("/api/v1/system/status")
    def system_status(request: Request) -> JsonObject:
        """Return safe host readiness and non-secret credential lifecycle state."""

        authenticated = state.current_session(request.cookies.get(_SESSION_COOKIE)) is not None
        counts = credentials.counts()
        return {
            "service": "cyrene-navigator-web-host",
            "status": "ok",
            "version": app_version,
            "authenticated": authenticated,
            "proxyPrefixes": [entry.prefix for entry in configured_proxies],
            "credentials": counts,
            "gpu": _query_gpu(),
            "disk": _query_disk(),
            "services": _query_services(configured_proxies),
            "observedAt": _iso_timestamp(clock()),
        }

    @app.post("/api/v1/credentials", status_code=201)
    def create_credential(body: CredentialCreateRequest, request: Request) -> JsonObject:
        """Create credential metadata without returning the supplied secret."""

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
        """List credential metadata while omitting every secret value."""

        require_session(request)
        return [record.as_dict() for record in credentials.list()]

    @app.get("/api/v1/credentials/{credential_id}")
    def get_credential(credential_id: str, request: Request) -> JsonObject:
        """Read one credential metadata record without secret recovery."""

        require_session(request)
        return credentials.get(credential_id).as_dict()

    @app.put("/api/v1/credentials/{credential_id}")
    @app.patch("/api/v1/credentials/{credential_id}")
    def update_credential(
        credential_id: str, body: CredentialUpdateRequest, request: Request
    ) -> JsonObject:
        """Update metadata or rotate a secret without echoing the new value."""

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
        """Revoke a credential as the deletion operation while retaining metadata."""

        require_session(request, mutation=True)
        return credentials.revoke(credential_id).as_dict()

    @app.post("/api/v1/credentials/{credential_id}/actions/revoke")
    def revoke_credential(credential_id: str, request: Request) -> JsonObject:
        """Expose an explicit action alias for clients that do not use DELETE."""

        require_session(request, mutation=True)
        return credentials.revoke(credential_id).as_dict()

    @app.api_route(
        "/{proxy_path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
        include_in_schema=False,
    )
    async def proxy_request(proxy_path: str, request: Request) -> Response:
        """Forward only to the configured longest matching prefix."""

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
        if target.bearer_token is not None:
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
    """Generate a high-entropy one-time code for the Web Host launcher."""

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
    """Read and bound an optional mutation idempotency key."""

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
    """Validate and freeze the fixed prefix-to-origin allowlist."""

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
    """Find an exact or slash-delimited prefix without accepting traversal."""

    _validate_proxy_path(path)
    for entry in configured:
        if path == entry.prefix or path.startswith(entry.prefix + "/"):
            return entry
    return None


def _normalize_prefix(value: str) -> str:
    """Normalize an allowlist prefix and reject URL or traversal syntax."""

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
    """Reject encoded traversal and authority changes before forwarding."""

    decoded = path
    for _ in range(len(path) + 1):
        next_path = unquote(decoded)
        if next_path == decoded:
            break
        decoded = next_path
    if (
        not decoded.startswith("/")
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
    """Require a configured HTTP(S) origin without embedded user credentials."""

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
    """Validate metadata without ever including the supplied value in an error."""

    if not isinstance(value, str) or not value.strip() or len(value) > max_length:
        raise CredentialStoreError(
            "NAVIGATOR_CREDENTIAL_INVALID",
            f"credential {field} is invalid",
            status=422,
        )


def _validate_secret(value: str, *, field: str = "secret") -> None:
    """Validate a secret's shape without retaining it in exception text."""

    if not isinstance(value, str) or not value or len(value) > 10_000:
        raise CredentialStoreError(
            "NAVIGATOR_CREDENTIAL_INVALID",
            f"credential {field} is invalid",
            status=422,
        )


def _credential_fingerprint(name: str, provider: str, kind: str, secret: str) -> str:
    """Build an idempotency fingerprint without storing the raw secret."""

    secret_hash = _hash_secret(secret)
    value = "\0".join((name, provider, kind, secret_hash)).encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def _hash_secret(value: str) -> str:
    """Hash an opaque pairing, cookie, or credential value for comparisons."""

    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _iso_timestamp(value: float) -> str:
    """Format a UTC timestamp consistently across auth and metadata responses."""

    return datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z")
