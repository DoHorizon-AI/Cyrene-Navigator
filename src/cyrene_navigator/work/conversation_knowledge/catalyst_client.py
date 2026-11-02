"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 catalyst_client.py                                                  │
│  Module: cyrene_navigator.work.conversation_knowledge.catalyst_client    │
│  Role: Fixed, Workspace-bound, read-only Catalyst API client.            │
│                                                                          │
│  模块职责：调用 Catalyst 规范 Product 读取 API，验证 org/Workspace 范围。│
│  · 只使用服务端固定 base URL 与 Bearer 引用；不接收用户 URL/凭据。      │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import ipaddress
import json
import re
from collections.abc import Mapping
from urllib.parse import quote, urlsplit

import httpx

from cyrene_navigator.persistence.store import PersistencePrincipal

from .ports import CatalystKnowledgePort, KnowledgePortError

_UUID = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z"
)
_MAX_JSON_RESPONSE_BYTES = 16_000_000
_MAX_DATASETS = 10_000
_MAX_VERSIONS = 20_000
_MAX_BLOCKS_PER_PAGE = 200


class CatalystKnowledgeHttpClient(CatalystKnowledgePort):
    """Read canonical Catalyst packages and source ACLs through fixed Product paths."""

    def __init__(
        self,
        base_url: str,
        bearer_token: str,
        *,
        organization_id: str,
        workspace_id: str,
        client: httpx.AsyncClient | None = None,
        response_limit_bytes: int = _MAX_JSON_RESPONSE_BYTES,
    ) -> None:
        """Pin a server-owned Catalyst endpoint, service identity, and size bounds."""

        parsed = urlsplit(base_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or len(base_url) > 2_048
        ):
            raise ValueError("Catalyst Product API base URL is invalid")
        if parsed.scheme != "https":
            try:
                is_loopback = ipaddress.ip_address(parsed.hostname).is_loopback
            except ValueError:
                is_loopback = parsed.hostname == "localhost"
            if not is_loopback:
                raise ValueError("Catalyst Product API must use HTTPS outside loopback")
        if (
            not isinstance(bearer_token, str)
            or not 16 <= len(bearer_token) <= 8_192
            or any(ord(character) < 33 or ord(character) > 126 for character in bearer_token)
        ):
            raise ValueError("Catalyst service bearer is invalid")
        if not organization_id.strip() or len(organization_id) > 200:
            raise ValueError("Catalyst service organization is invalid")
        if not workspace_id.strip() or len(workspace_id) > 200:
            raise ValueError("Catalyst service Workspace is invalid")
        if not 1 <= response_limit_bytes <= 16_000_000:
            raise ValueError("Catalyst response limit must be between 1 byte and 16 MB")
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        self.organization_id = organization_id
        self.workspace_id = workspace_id
        self._client = client
        self._response_limit_bytes = response_limit_bytes

    async def list_datasets(
        self, principal: PersistencePrincipal, workspace_id: str
    ) -> list[dict[str, object]]:
        """List datasets through Catalyst's Workspace-scoped Product route."""

        self._assert_scope(principal, workspace_id)
        value = await self._request_json("/api/v1/datasets")
        if not isinstance(value, list) or len(value) > _MAX_DATASETS:
            raise KnowledgePortError("CATALYST_DATASET_RESPONSE_INVALID", status_code=502)
        return [_object(item, "dataset") for item in value]

    async def list_dataset_versions(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        dataset_id: str,
    ) -> list[dict[str, object]]:
        """Read published versions for one UUID-scoped Dataset."""

        self._assert_scope(principal, workspace_id)
        dataset = _uuid_path(dataset_id, "dataset id")
        value = await self._request_json(
            f"/api/v1/datasets/{quote(dataset, safe='')}/data-tools/versions"
        )
        if not isinstance(value, list) or len(value) > _MAX_VERSIONS:
            raise KnowledgePortError("CATALYST_VERSION_RESPONSE_INVALID", status_code=502)
        return [_object(item, "DatasetVersion") for item in value]

    async def get_content_block_page(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        content_revision_id: str,
        *,
        offset: int,
        limit: int,
    ) -> dict[str, object]:
        """Read one bounded page from an immutable ContentRevision."""

        self._assert_scope(principal, workspace_id)
        revision = _uuid_path(content_revision_id, "ContentRevision id")
        if type(offset) is not int or not 0 <= offset <= 200_000:
            raise ValueError("ContentBlock offset exceeds the Catalyst bound")
        if type(limit) is not int or not 1 <= limit <= _MAX_BLOCKS_PER_PAGE:
            raise ValueError("ContentBlock page size exceeds the Catalyst bound")
        path = f"/api/v1/content-revisions/{quote(revision, safe='')}/blocks"
        value = await self._request_json(path, params={"offset": str(offset), "limit": str(limit)})
        result = _object(value, "ContentBlock page")
        blocks = result.get("blocks")
        if not isinstance(blocks, list) or len(blocks) > limit:
            raise KnowledgePortError("CATALYST_CONTENT_BLOCK_PAGE_INVALID", status_code=502)
        if (
            result.get("revisionId") != revision
            or result.get("offset") != offset
            or result.get("limit") != limit
            or type(result.get("total")) is not int
            or result["total"] > 200_000
        ):
            raise KnowledgePortError("CATALYST_CONTENT_BLOCK_PAGE_INVALID", status_code=502)
        return result

    def _assert_scope(self, principal: PersistencePrincipal, workspace_id: str) -> None:
        """Require Product credentials and the current caller to share exact tenant scope."""

        if (
            principal.organization_id != self.organization_id
            or workspace_id != self.workspace_id
            or workspace_id not in principal.workspace_ids
        ):
            raise KnowledgePortError("CATALYST_SCOPE_MISMATCH", status_code=403)

    async def _request_json(
        self,
        path: str,
        *,
        params: Mapping[str, str] | None = None,
    ) -> object:
        """Perform one fixed GET and return bounded strict JSON."""

        if not path.startswith("/api/v1/") or "#" in path or "?" in path:
            raise KnowledgePortError("CATALYST_ROUTE_INVALID", status_code=500)
        headers = {
            "accept": "application/json",
            "authorization": f"Bearer {self._bearer_token}",
        }
        try:
            if self._client is not None:
                return await self._send_json(self._client, path, headers, params)
            async with httpx.AsyncClient(
                timeout=30.0,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                return await self._send_json(client, path, headers, params)
        except KnowledgePortError:
            raise
        except (httpx.HTTPError, OSError):
            raise KnowledgePortError(
                "CATALYST_PRODUCT_UNAVAILABLE", status_code=503, retryable=True
            ) from None

    async def _send_json(
        self,
        client: httpx.AsyncClient,
        path: str,
        headers: Mapping[str, str],
        params: Mapping[str, str] | None,
    ) -> object:
        try:
            async with client.stream(
                "GET",
                self._base_url + path,
                params=params,
                headers=dict(headers),
            ) as response:
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > self._response_limit_bytes:
                        raise KnowledgePortError("CATALYST_RESPONSE_TOO_LARGE", status_code=502)
                if not 200 <= response.status_code < 300:
                    code = _problem_code(bytes(raw), response.headers.get("content-type"))
                    raise KnowledgePortError(code, status_code=_mapped_status(response.status_code))
                media_type = (response.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
                if media_type != "application/json":
                    raise KnowledgePortError("CATALYST_RESPONSE_INVALID", status_code=502)
                try:
                    return json.loads(bytes(raw), object_pairs_hook=_unique_object)
                except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                    raise KnowledgePortError("CATALYST_RESPONSE_INVALID", status_code=502) from None
        except KnowledgePortError:
            raise
        except (httpx.HTTPError, OSError):
            raise KnowledgePortError(
                "CATALYST_PRODUCT_UNAVAILABLE", status_code=503, retryable=True
            ) from None


def _uuid_path(value: str, label: str) -> str:
    """Return a canonical UUID for one path component."""

    if not isinstance(value, str) or _UUID.fullmatch(value) is None:
        raise KnowledgePortError("CATALYST_ID_INVALID", status_code=422)
    return value.lower()


def _object(value: object, label: str) -> dict[str, object]:
    """Require one JSON object without propagating upstream text."""

    del label
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise KnowledgePortError("CATALYST_RESPONSE_INVALID", status_code=502)
    return value


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Reject duplicate JSON members at the remote Product boundary."""

    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _problem_code(raw: bytes, content_type: str | None) -> str:
    """Project a safe Catalyst error code without returning private detail text."""

    media_type = (content_type or "").split(";", 1)[0].strip().lower()
    if media_type not in {"application/problem+json", "application/json"}:
        return "CATALYST_PRODUCT_REQUEST_FAILED"
    try:
        value = json.loads(raw, object_pairs_hook=_unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return "CATALYST_PRODUCT_REQUEST_FAILED"
    if isinstance(value, dict):
        code = value.get("code")
        if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,95}", code):
            return code
    return "CATALYST_PRODUCT_REQUEST_FAILED"


def _mapped_status(status: int) -> int:
    """Keep only stable HTTP classes from the upstream Product."""

    if status in {401, 403}:
        return 403
    if status in {404, 409, 422}:
        return status
    if status == 503:
        return 503
    return 502


__all__ = ["CatalystKnowledgeHttpClient"]
