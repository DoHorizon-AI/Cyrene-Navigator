"""
┌─────────────────────────────────────────────────────────────────────────┐
│ 📄 test_conversation_peripheral.py                                      │
│ Module: tests.test_conversation_peripheral                              │
│ Role: Exercise authenticated media, speech, Bilibili, and backup routes.│
│                                                                         │
│ 模块职责：验证外围能力的真实HTTP边界、作用域与持久回执。                 │
└─────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import sqlite3
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from fastapi import Request
from fastapi.testclient import TestClient

from cyrene_navigator.persistence import PersistencePrincipal, create_persistence_app
from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.work.conversation_artifact_bridge import (
    create_conversation_artifact_registry,
)
from cyrene_navigator.work.conversation_peripheral.ports import (
    ArtifactBridgeBinding,
    ArtifactBridgeConfig,
    ExchangeBilibiliHttpClient,
    ExchangeBilibiliHttpError,
    FixedToolBinding,
    PeripheralPorts,
    SignedExchangeRequest,
    VerifiedArtifactCaller,
)
from cyrene_navigator.work.conversation_peripheral.routes import mount_peripheral_routes
from cyrene_navigator.work.store import WorkStore

WORKSPACE = "workspace-test"
ORGANIZATION = "org-test"
BASE = "/api/v1/workspaces/{workspace_id}/work/conversation-memory"
CONNECTION_REF = "11111111-1111-4111-8111-111111111111"
PROFILE_REF = "22222222-2222-4222-8222-222222222222"
PRINCIPALS = {
    "writer-token": PersistencePrincipal(
        "writer",
        frozenset({WORKSPACE}),
        can_takeover=True,
        organization_id=ORGANIZATION,
        actor_private_scope=True,
    ),
    "reader-token": PersistencePrincipal(
        "reader", frozenset({WORKSPACE}), organization_id=ORGANIZATION
    ),
}
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"aether-test-image"
PNG_BASE64 = base64.b64encode(PNG_BYTES).decode("ascii")
PNG_SHA256 = hashlib.sha256(PNG_BYTES).hexdigest()


def _asset(digest: str = PNG_SHA256) -> dict[str, Any]:
    return {
        "asset_id": "asset-test",
        "digest": digest,
        "mime_type": "image/png",
        "byte_size": len(PNG_BYTES),
        "title": "test image",
        "alt_text": "",
        "tags": [],
        "width": 1,
        "height": 1,
        "created_at": 1_800_000_000_000,
        "deleted_at": None,
    }


def _profile() -> dict[str, Any]:
    return {
        "profileRef": PROFILE_REF,
        "provider": "bilibili",
        "identityRef": "identity-bili-1",
        "externalSubject": "7656119",
        "authStatus": "healthy",
        "authMode": "session_cookie",
        "accessMode": "actor_owned",
        "targetScope": {"schema_version": 1, "account_id": "7656119"},
        "expiresAt": None,
        "credentialRevision": 1,
        "workspaceId": WORKSPACE,
    }


class _FakeSigner:
    """Capture the exact method and body sent to one fixed tool binding."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def sign_context(self, **kwargs: Any) -> Mapping[str, Any]:
        self.calls.append(kwargs)
        issued = datetime.now(UTC)
        fields = {
            "method": kwargs["method"],
            "operation_id": kwargs["operation_id"],
            "caller_workload": kwargs["caller_workload"],
            "audience": kwargs["audience"],
            "issuer": "https://navigator.test/issuer",
            "subject": kwargs["principal"].actor_id,
            "organization_id": kwargs["principal"].organization_id,
            "workspace_id": kwargs["workspace_id"],
            "binding_id": kwargs["binding_id"],
            "request_id": kwargs["request_id"],
            "issued_at": issued.isoformat(timespec="microseconds").replace("+00:00", "Z"),
            "expires_at": (issued + timedelta(seconds=120))
            .isoformat(timespec="microseconds")
            .replace("+00:00", "Z"),
            "payload_sha256": hashlib.sha256(
                json.dumps(
                    kwargs["payload"],
                    ensure_ascii=False,
                    allow_nan=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode()
            ).hexdigest(),
        }
        return {**fields, "signature": "a" * 64}


class _FakeArtifactCallerVerifier:
    """Return only identity claims for fixed test tool contexts."""

    def verify_artifact_call(
        self,
        *,
        tool_id: str,
        arguments: Mapping[str, Any],
        caller_context: Mapping[str, Any],
        binding_id: str,
    ) -> VerifiedArtifactCaller:
        del arguments
        if (
            caller_context.get("method") != tool_id
            or caller_context.get("operation_id") != tool_id
            or caller_context.get("binding_id") != binding_id
            or caller_context.get("signature") != "a" * 64
        ):
            raise ValueError("invalid test caller context")
        return VerifiedArtifactCaller(
            organization_id=str(caller_context["organization_id"]),
            workspace_id=str(caller_context["workspace_id"]),
            actor_id=str(caller_context["subject"]),
        )


class _FakeToolClient:
    """Call the real ASGI artifact bridge before returning test provider results."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], Mapping[str, Any]]] = []
        self.bridge_app: Any | None = None
        self.bridge_token = "c" * 64
        self.import_asset_override: dict[str, Any] | None = None
        self.output_asset_override: dict[str, Any] | None = None

    async def call_tool(
        self,
        provider_tool_id: str,
        arguments: Mapping[str, Any],
        caller_context: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        selected = dict(arguments)
        self.calls.append((provider_tool_id, selected, caller_context))
        if provider_tool_id == "media.asset.import":
            response = await self._bridge_request(
                "/v1/artifacts/read",
                {
                    "artifactId": selected["artifact_id"],
                    "toolId": provider_tool_id,
                    "arguments": selected,
                    "callerContext": dict(caller_context),
                },
            )
            if response.status_code != 200:
                raise RuntimeError("artifact read was denied")
            if (
                hashlib.sha256(base64.b64decode(response.json()["contentBase64"])).hexdigest()
                != selected["artifact_id"]
            ):
                raise RuntimeError("artifact read digest did not match")
            if self.import_asset_override is not None:
                return self.import_asset_override
            return _asset(selected["artifact_id"])
        if provider_tool_id in {"media.asset.get", "media.card.render"}:
            response = await self._bridge_request(
                "/v1/artifacts/write",
                {
                    "mimeType": "image/png",
                    "name": "test-image.png",
                    "contentBase64": PNG_BASE64,
                    "toolId": provider_tool_id,
                    "arguments": selected,
                    "callerContext": dict(caller_context),
                },
            )
            if response.status_code != 200:
                raise RuntimeError("artifact write was denied")
            artifact = response.json()
            return {
                "asset": self.output_asset_override or _asset(artifact["sha256"]),
                "artifact": {
                    "artifact_id": artifact["artifactId"],
                    "sha256": artifact["sha256"],
                    "mime_type": "image/png",
                    "size": artifact["size"],
                },
            }
        raise AssertionError(f"unexpected media operation {provider_tool_id}")

    async def _bridge_request(self, path: str, body: Mapping[str, Any]) -> httpx.Response:
        if self.bridge_app is None:
            raise RuntimeError("artifact bridge test app was not injected")
        transport = httpx.ASGITransport(
            app=self.bridge_app,
            client=("127.0.0.1", 31337),
        )
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            return await client.post(
                path,
                json=dict(body),
                headers={"Authorization": f"Bearer {self.bridge_token}"},
            )


class _FakeSpeech:
    """Record actual attachment bytes and return a truthful transcript."""

    def __init__(self) -> None:
        self.transcribed: list[tuple[bytes, str, str | None]] = []

    def get_config(self, **_: Any) -> Mapping[str, Any]:
        return {
            "enabled": True,
            "default_language_hint": "zh",
            "max_upload_bytes": 10_000_000,
            "allowed_media_types": ["audio/wav"],
        }

    def update_config(self, config: Mapping[str, Any], **_: Any) -> Mapping[str, Any]:
        return {**self.get_config(), **config}

    def status(self, **_: Any) -> Mapping[str, Any]:
        return {"available": True, "model": "sensevoice-local", "reason_code": None}

    def transcribe(self, **kwargs: Any) -> Mapping[str, Any]:
        self.transcribed.append((kwargs["data"], kwargs["mime_type"], kwargs["language_hint"]))
        return {
            "status": "succeeded",
            "text": "真实音频转写",
            "detected_language": "zh",
            "duration_ms": 500,
            "model": "sensevoice-local",
            "segments": [{"start_ms": 0, "end_ms": 500, "text": "真实音频转写"}],
        }


class _FakeBackup:
    """Return a bounded archive for actor-private attachment delivery."""

    def create_backup(self, **_: Any) -> tuple[str, str, bytes]:
        return "conversation-backup.json", "application/json", b'{"schemaVersion":1}'


class _FakeExchangeBilibili:
    """Model the typed Exchange boundary and capture writes for idempotency tests."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.write_outcomes: list[tuple[str, Mapping[str, Any]]] = []
        self.qr_begin_calls = 0

    async def list_owned_provider_profiles(self, *_: Any) -> Mapping[str, Any]:
        return {"profiles": [_profile()]}

    async def get_owned_provider_profile(self, *_: Any, **__: Any) -> Mapping[str, Any]:
        return {"profile": _profile()}

    async def list_owned_connections(self, *_: Any) -> Mapping[str, Any]:
        return {
            "connections": [
                {
                    "connectionRef": CONNECTION_REF,
                    "provider": "bilibili",
                    "profileRef": PROFILE_REF,
                    "displayName": "我的哔哩哔哩",
                    "enabled": True,
                },
                {
                    "connectionRef": "33333333-3333-4333-8333-333333333333",
                    "provider": "bilibili",
                    "profileRef": "44444444-4444-4444-8444-444444444444",
                    "displayName": "第二个哔哩哔哩连接",
                    "enabled": True,
                },
            ]
        }

    async def begin_qr(self, *_: Any, **__: Any) -> Mapping[str, Any]:
        self.qr_begin_calls += 1
        return {
            "status": "PENDING",
            "loginFlowId": "a" * 64,
            "qrPngBase64": PNG_BASE64,
            "qrPngSha256": PNG_SHA256,
            "expiresAt": "2030-01-01T00:00:00Z",
        }

    async def poll_qr(self, *_: Any, **__: Any) -> Mapping[str, Any]:
        return {"status": "LINKED", "profile": _profile()}

    async def invoke_operation(
        self,
        *_: Any,
        connection_ref: str,
        operation_id: str,
        arguments: Mapping[str, Any],
        work_operation_id: str | None,
    ) -> Mapping[str, Any]:
        self.calls.append(
            {
                "connection_ref": connection_ref,
                "operation_id": operation_id,
                "arguments": dict(arguments),
                "work_operation_id": work_operation_id,
            }
        )
        if operation_id in {
            "bilibili.comment.create",
            "bilibili.dynamic.publish",
            "bilibili.dm.send",
        }:
            status, result = self.write_outcomes.pop(0)
            return _exchange_envelope(
                status,
                {
                    **dict(result),
                    "operation_ref": f"work-operation:{work_operation_id}",
                },
            )
        return _exchange_envelope(
            "verified",
            {
                "items": [
                    {
                        "id": "BV1234567890",
                        "type": "video",
                        "title": "公开标题",
                        "description": "公开说明",
                        "author": "公开作者",
                        "url": "https://www.bilibili.com/video/BV1234567890",
                        "cookie": "must-not-escape",
                    }
                ],
                "page": 1,
                "has_more": False,
            },
        )


class _FailingExchangeBilibili(_FakeExchangeBilibili):
    """Inject an Exchange failure before dispatch or an ambiguous post-dispatch loss."""

    def __init__(self, error: ExchangeBilibiliHttpError) -> None:
        super().__init__()
        self.error = error

    async def invoke_operation(self, *_: Any, **__: Any) -> Mapping[str, Any]:
        raise self.error


def _exchange_envelope(outcome: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "requestId": "exchange-request",
        "outcome": outcome,
        "result": {
            "content": [{"type": "text", "text": json.dumps(payload)}],
            "isError": outcome in {"failed", "uncertain"},
        },
    }


def _principal_for(
    request: Request, workspace_id: str, *, write: bool = False
) -> PersistencePrincipal:
    """Resolve the same fixture principal as the durable Work test host."""

    token = request.headers.get("authorization", "").removeprefix("Bearer ")
    principal = PRINCIPALS.get(token)
    if principal is None or workspace_id not in principal.workspace_ids:
        raise PersistenceError("WORKSPACE_FORBIDDEN", 403, "Workspace access denied.")
    if write and not principal.can_takeover:
        raise PersistenceError("WORKSPACE_FORBIDDEN", 403, "Workspace writer required.")
    return principal


def _app(tmp_path: Path, ports: PeripheralPorts) -> tuple[TestClient, WorkStore]:
    app = create_persistence_app(tmp_path / "conversation.sqlite3", PRINCIPALS)
    store: WorkStore = app.state.work_store
    if ports.media is not None and ports.artifact_bridge is None:
        ports = replace(
            ports,
            artifact_bridge=ArtifactBridgeConfig(
                bindings={
                    ports.media.binding_id: ArtifactBridgeBinding(
                        bearer_token="c" * 64,
                        binding_id=ports.media.binding_id,
                        verifier=_FakeArtifactCallerVerifier(),
                    )
                },
                registry=create_conversation_artifact_registry(store),
            ),
        )
    mount_peripheral_routes(app, BASE, _principal_for, store, ports)
    if ports.media is not None:
        tool_client = ports.media.client
        if isinstance(tool_client, _FakeToolClient):
            tool_client.bridge_app = app
    return TestClient(app), store


def _headers(token: str = "writer-token") -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _media_binding() -> tuple[FixedToolBinding, _FakeSigner, _FakeToolClient]:
    signer = _FakeSigner()
    client = _FakeToolClient()
    tools = {
        operation: operation
        for operation in (
            "media.asset.import",
            "media.asset.search",
            "media.asset.get",
            "media.asset.delete",
            "media.asset.restore",
            "media.card.render",
        )
    }
    return (
        FixedToolBinding(
            "media-binding",
            "navigator-harness",
            "exchange.product",
            tools,
            signer,
            client,
        ),
        signer,
        client,
    )


def test_media_import_uses_authorized_work_attachment_and_signed_fixed_tool(tmp_path: Path) -> None:
    binding, signer, tool = _media_binding()
    client, store = _app(tmp_path, PeripheralPorts(media=binding))
    attachment = store.put_attachment(
        ORGANIZATION,
        WORKSPACE,
        "source.png",
        "image/png",
        PNG_BYTES,
        actor_id="writer",
    )

    with client:
        response = client.post(
            f"{BASE.format(workspace_id=WORKSPACE)}/media/assets/import",
            headers=_headers(),
            json={
                "attachmentDigest": attachment["sha256"],
                "title": "test image",
                "altText": "source attachment",
                "tags": ["test"],
            },
        )

    assert response.status_code == 201
    assert response.json()["digest"] == attachment["sha256"]
    assert len(tool.calls) == 1
    operation, arguments, _context = tool.calls[0]
    assert operation == "media.asset.import"
    assert arguments["artifact_id"] == attachment["sha256"]
    assert "path" not in arguments and "url" not in arguments
    assert signer.calls[0]["principal"].actor_id == "writer"


def test_media_outputs_cross_real_bridge_and_remain_owner_private(tmp_path: Path) -> None:
    binding, _signer, tool = _media_binding()
    client, store = _app(tmp_path, PeripheralPorts(media=binding))
    base = BASE.format(workspace_id=WORKSPACE)

    with client:
        fetched = client.get(f"{base}/media/assets/asset-test", headers=_headers())
        rendered = client.post(
            f"{base}/media/cards/render",
            headers=_headers(),
            json={"title": "Private card", "content": "Private body", "theme": "warm"},
        )

    assert fetched.status_code == 200
    assert rendered.status_code == 201
    assert fetched.json()["attachment"]["sha256"] == PNG_SHA256
    assert rendered.json()["attachment"]["sha256"] == PNG_SHA256
    assert [call[0] for call in tool.calls] == ["media.asset.get", "media.card.render"]
    _metadata, path = store.get_attachment(
        ORGANIZATION,
        WORKSPACE,
        PNG_SHA256,
        actor_id="writer",
        actor_private_scope=True,
    )
    assert path.read_bytes() == PNG_BYTES
    try:
        store.get_attachment(
            ORGANIZATION,
            WORKSPACE,
            PNG_SHA256,
            actor_id="reader",
            actor_private_scope=True,
        )
    except PersistenceError as error:
        assert error.code == "WORK_ATTACHMENT_NOT_FOUND"
    else:
        raise AssertionError("a different actor read a private media output")
    with sqlite3.connect(store.db_path) as connection:
        operations = connection.execute(
            "SELECT status, request_json, evidence_json FROM work_operations"
        ).fetchall()
    assert len(operations) == 2
    assert all(status == "verified" for status, _request, _evidence in operations)
    receipts = json.dumps(operations)
    assert "Private card" not in receipts and "Private body" not in receipts


def test_media_import_rejects_well_formed_metadata_for_different_bytes(tmp_path: Path) -> None:
    binding, _signer, tool = _media_binding()
    tool.import_asset_override = _asset("d" * 64)
    client, store = _app(tmp_path, PeripheralPorts(media=binding))
    attachment = store.put_attachment(
        ORGANIZATION,
        WORKSPACE,
        "source.png",
        "image/png",
        PNG_BYTES,
        actor_id="writer",
    )

    with client:
        response = client.post(
            f"{BASE.format(workspace_id=WORKSPACE)}/media/assets/import",
            headers=_headers(),
            json={"attachmentDigest": attachment["sha256"], "title": "test"},
        )

    assert response.status_code == 502
    with sqlite3.connect(store.db_path) as connection:
        status = connection.execute("SELECT status FROM work_operations").fetchone()[0]
    assert status == "uncertain"


def test_media_output_rejects_asset_metadata_not_bound_to_written_bytes(tmp_path: Path) -> None:
    binding, _signer, tool = _media_binding()
    tool.output_asset_override = _asset("d" * 64)
    client, store = _app(tmp_path, PeripheralPorts(media=binding))

    with client:
        response = client.get(
            f"{BASE.format(workspace_id=WORKSPACE)}/media/assets/asset-test",
            headers=_headers(),
        )

    assert response.status_code == 502
    with sqlite3.connect(store.db_path) as connection:
        status = connection.execute("SELECT status FROM work_operations").fetchone()[0]
    assert status == "uncertain"


def test_media_and_speech_fail_closed_for_missing_or_unowned_inputs(tmp_path: Path) -> None:
    no_ports, _ = _app(tmp_path / "missing", PeripheralPorts())
    with no_ports:
        missing = no_ports.get(
            f"{BASE.format(workspace_id=WORKSPACE)}/media/assets", headers=_headers()
        )
    assert missing.status_code == 503

    speech = _FakeSpeech()
    client, store = _app(tmp_path / "speech", PeripheralPorts(speech=speech))
    attachment = store.put_attachment(
        ORGANIZATION,
        WORKSPACE,
        "voice.wav",
        "audio/wav",
        b"authorized audio bytes",
        actor_id="writer",
        actor_private_scope=True,
    )
    with client:
        response = client.post(
            f"{BASE.format(workspace_id=WORKSPACE)}/speech/transcriptions",
            headers=_headers(),
            json={"attachmentDigest": attachment["sha256"], "languageHint": "zh"},
        )
        forbidden = client.post(
            f"{BASE.format(workspace_id=WORKSPACE)}/speech/transcriptions",
            headers=_headers("reader-token"),
            json={"attachmentDigest": attachment["sha256"]},
        )
    assert response.status_code == 200
    assert response.json()["text"] == "真实音频转写"
    assert speech.transcribed == [(b"authorized audio bytes", "audio/wav", "zh")]
    assert forbidden.status_code == 404


def test_bilibili_account_qr_and_read_routes_project_only_safe_data(tmp_path: Path) -> None:
    exchange = _FakeExchangeBilibili()
    client, _ = _app(tmp_path, PeripheralPorts(bilibili_exchange=exchange))
    with client:
        profiles = client.get(
            f"{BASE.format(workspace_id=WORKSPACE)}/bilibili/accounts", headers=_headers()
        )
        connections = client.get(
            f"{BASE.format(workspace_id=WORKSPACE)}/bilibili/connections", headers=_headers()
        )
        started = client.post(
            f"{BASE.format(workspace_id=WORKSPACE)}/bilibili/accounts/link",
            headers=_headers(),
            json={},
        )
        linked = client.post(
            f"{BASE.format(workspace_id=WORKSPACE)}/bilibili/link-status",
            headers=_headers(),
            json={"loginFlowId": "a" * 64},
        )
        search = client.post(
            f"{BASE.format(workspace_id=WORKSPACE)}/bilibili/connections/{CONNECTION_REF}/reads/bilibili.search",
            headers=_headers(),
            json={"arguments": {"keyword": "cyrene", "search_type": "video"}},
        )

    assert profiles.status_code == 200
    assert profiles.json()["items"][0]["profileRef"] == PROFILE_REF
    assert connections.status_code == 200
    assert connections.json()["items"][0] == {
        "connectionRef": CONNECTION_REF,
        "profileRef": PROFILE_REF,
        "provider": "bilibili",
        "displayName": "我的哔哩哔哩",
        "enabled": True,
    }
    assert len(connections.json()["items"]) == 2
    assert started.status_code == 202
    assert started.json()["qrCodeSha256"] == PNG_SHA256
    assert linked.status_code == 200
    assert linked.json()["profile"]["profileRef"] == PROFILE_REF
    assert search.status_code == 200
    assert "cookie" not in json.dumps(search.json())
    assert search.json()["items"][0]["title"] == "公开标题"


def test_bilibili_write_receipts_are_idempotent_and_never_store_message_text(
    tmp_path: Path,
) -> None:
    exchange = _FakeExchangeBilibili()
    exchange.write_outcomes.extend(
        [
            (
                "verified",
                {
                    "status": "SUCCEEDED",
                    "receipt_id": "receipt-ok",
                    "external_id": "comment-1",
                    "readback_verified": True,
                    "readback_sha256": "b" * 64,
                },
            ),
            (
                "uncertain",
                {
                    "status": "UNKNOWN_RESULT",
                    "receipt_id": "receipt-unknown",
                    "error_code": "READBACK_UNAVAILABLE",
                },
            ),
            (
                "failed",
                {
                    "status": "REJECTED",
                    "receipt_id": "receipt-rejected",
                    "error_code": "PLATFORM_REJECTED",
                },
            ),
        ]
    )
    client, _store = _app(tmp_path, PeripheralPorts(bilibili_exchange=exchange))
    path = (
        f"{BASE.format(workspace_id=WORKSPACE)}/bilibili/connections/"
        f"{CONNECTION_REF}/writes/bilibili.comment.create"
    )
    body = {
        "arguments": {
            "video_id": "BV1234567890",
            "root_comment_id": "0",
            "parent_comment_id": "0",
            "content": "private comment text",
        }
    }
    with client:
        success = client.post(path, headers={**_headers(), "Idempotency-Key": "once-ok"}, json=body)
        duplicate = client.post(
            path, headers={**_headers(), "Idempotency-Key": "once-ok"}, json=body
        )
        unknown = client.post(
            path, headers={**_headers(), "Idempotency-Key": "once-unknown"}, json=body
        )
        rejected = client.post(
            path.replace(CONNECTION_REF, "33333333-3333-4333-8333-333333333333"),
            headers={**_headers(), "Idempotency-Key": "once-rejected"},
            json=body,
        )
        saved = client.get(
            f"/api/v1/workspaces/{WORKSPACE}/work/operations/{success.json()['operation']['id']}",
            headers=_headers(),
        )

    assert success.status_code == 200
    assert success.json()["operation"]["status"] == "verified"
    assert success.json()["operation"]["evidence"]["readbackSha256"] == "b" * 64
    assert duplicate.status_code == 200 and duplicate.json()["duplicate"] is True
    assert unknown.status_code == 202
    assert unknown.json()["operation"]["status"] == "uncertain"
    assert rejected.status_code == 200
    assert rejected.json()["operation"]["evidence"]["status"] == "REJECTED"
    assert len(exchange.calls) == 3
    assert UUID(exchange.calls[0]["work_operation_id"] or "")
    assert "private comment text" not in json.dumps(saved.json())


def test_bilibili_idempotency_lookup_is_read_only_and_actor_scoped(
    tmp_path: Path, monkeypatch: Any
) -> None:
    exchange = _FakeExchangeBilibili()
    exchange.write_outcomes.append(
        (
            "verified",
            {
                "status": "SUCCEEDED",
                "receipt_id": "receipt-feature",
                "external_id": "comment-feature",
                "readback_verified": True,
                "readback_sha256": "c" * 64,
            },
        )
    )
    client, store = _app(tmp_path, PeripheralPorts(bilibili_exchange=exchange))
    base = BASE.format(workspace_id=WORKSPACE)
    key = "feature-write:subscription-1:version-7"
    write_path = f"{base}/bilibili/connections/{CONNECTION_REF}/writes/bilibili.comment.create"
    body = {
        "arguments": {
            "video_id": "BV1234567890",
            "root_comment_id": "0",
            "parent_comment_id": "0",
            "content": "do not persist this body",
        }
    }
    with client:
        started = client.post(
            write_path,
            headers={**_headers(), "Idempotency-Key": key},
            json=body,
        )
    operation = started.json()["operation"]
    captured_keys: list[str] = []

    def read_operation(_organization: str, _workspace: str, effective_key: str) -> dict[str, Any]:
        captured_keys.append(effective_key)
        return store.get_operation(
            ORGANIZATION,
            WORKSPACE,
            operation["id"],
            actor_id="writer",
            actor_private_scope=True,
        )

    monkeypatch.setattr(store, "get_operation_by_idempotency_key", read_operation, raising=False)
    with client:
        receipt = client.get(
            f"{base}/bilibili/operations/by-idempotency-key",
            headers={**_headers(), "Idempotency-Key": key},
        )
        other_actor = client.get(
            f"{base}/bilibili/operations/by-idempotency-key",
            headers={**_headers("reader-token"), "Idempotency-Key": key},
        )

    assert started.status_code == 200
    assert receipt.status_code == 200
    assert receipt.json()["operation"]["id"] == operation["id"]
    assert receipt.json()["operation"]["status"] == "verified"
    assert other_actor.status_code == 404
    assert len(exchange.calls) == 1, "GET lookup must not dispatch a provider write"
    assert len(captured_keys) == 2 and captured_keys[0] != captured_keys[1]
    assert "do not persist this body" not in json.dumps(receipt.json())


def test_bilibili_http_rejection_is_definite_and_post_dispatch_loss_is_uncertain(
    tmp_path: Path,
) -> None:
    path = (
        f"{BASE.format(workspace_id=WORKSPACE)}/bilibili/connections/"
        f"{CONNECTION_REF}/writes/bilibili.dm.send"
    )
    body = {"arguments": {"peer_user_id": "7656119", "content": "private DM text"}}

    denied_client, _ = _app(
        tmp_path / "denied",
        PeripheralPorts(
            bilibili_exchange=_FailingExchangeBilibili(
                ExchangeBilibiliHttpError(
                    "EXCHANGE_CONNECTOR_AUTHORIZATION_DENIED", status_code=403
                )
            )
        ),
    )
    with denied_client:
        denied = denied_client.post(
            path, headers={**_headers(), "Idempotency-Key": "write-denied"}, json=body
        )

    uncertain_client, _ = _app(
        tmp_path / "uncertain",
        PeripheralPorts(
            bilibili_exchange=_FailingExchangeBilibili(
                ExchangeBilibiliHttpError(
                    "EXCHANGE_RESPONSE_LOST", status_code=502, side_effect_possible=True
                )
            )
        ),
    )
    with uncertain_client:
        uncertain = uncertain_client.post(
            path, headers={**_headers(), "Idempotency-Key": "write-uncertain"}, json=body
        )

    assert denied.status_code == 200
    assert denied.json()["operation"]["evidence"]["status"] == "REJECTED"
    assert uncertain.status_code == 202
    assert uncertain.json()["operation"]["status"] == "uncertain"
    assert "private DM text" not in json.dumps(uncertain.json())


def test_backup_attachment_is_owner_private_and_download_digest_is_verified(tmp_path: Path) -> None:
    client, _ = _app(tmp_path, PeripheralPorts(backup=_FakeBackup()))
    with client:
        created = client.post(
            f"{BASE.format(workspace_id=WORKSPACE)}/backups", headers=_headers(), json={}
        )
        receipt = created.json()
        download = client.get(receipt["downloadPath"], headers=_headers())
        other_actor = client.get(receipt["downloadPath"], headers=_headers("reader-token"))

    assert created.status_code == 201
    assert download.content == b'{"schemaVersion":1}'
    assert download.headers["x-content-sha256"] == receipt["attachment"]["sha256"]
    assert other_actor.status_code == 404


class _FakeNavigatorHmacSigner:
    """Build deterministic signed raw bodies for the HTTP adapter contract tests."""

    def sign(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        *,
        method: str,
        path: str,
        payload: Mapping[str, Any],
    ) -> SignedExchangeRequest:
        body = {
            "request_id": payload["request_id"],
            "principal_issuer": "https://navigator.test/issuer",
            "principal_subject": principal.actor_id,
            "organization_id": principal.organization_id,
            "workspace_id": workspace_id,
            **{key: value for key, value in payload.items() if key != "request_id"},
        }
        return SignedExchangeRequest(
            body=json.dumps(body, separators=(",", ":")).encode(),
            headers={
                "content-type": "application/json",
                "x-cyrene-navigator-key-id": "test-key",
                "x-cyrene-navigator-timestamp": "1800000000",
                "x-cyrene-navigator-signature": "a" * 64,
            },
        )


def test_exchange_http_adapter_mints_grant_and_invokes_only_fixed_internal_paths() -> None:
    seen: list[tuple[str, dict[str, Any], Mapping[str, str]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        headers = dict(request.headers)
        seen.append((request.url.path, body, headers))
        assert "authorization" not in headers
        if request.url.path == "/internal/v1/bilibili/connections/list":
            return httpx.Response(
                200,
                json={
                    "connections": [
                        {
                            "connectionRef": CONNECTION_REF,
                            "provider": "bilibili",
                            "profileRef": PROFILE_REF,
                            "displayName": "Bilibili",
                            "enabled": True,
                        }
                    ]
                },
            )
        if request.url.path == "/internal/v1/connector-operation-grants":
            return httpx.Response(200, json={"connectorGrantBin": "c2lnbmVkLWdyYW50"})
        if request.url.path == f"/internal/v1/connector-operations/{CONNECTION_REF}":
            assert headers["x-cyrene-connector-grant-bin"] == "c2lnbmVkLWdyYW50"
            return httpx.Response(
                200,
                json=_exchange_envelope(
                    "verified",
                    {
                        "items": [],
                        "page": 1,
                        "has_more": False,
                    },
                ),
            )
        raise AssertionError(f"unexpected Exchange path: {request.url.path}")

    transport = httpx.MockTransport(handler)
    async_client = httpx.AsyncClient(transport=transport)
    port = ExchangeBilibiliHttpClient(
        "https://exchange.example",
        _FakeNavigatorHmacSigner(),
        client=async_client,
    )
    try:
        result = asyncio.run(
            port.invoke_operation(
                PRINCIPALS["writer-token"],
                WORKSPACE,
                connection_ref=CONNECTION_REF,
                operation_id="bilibili.search",
                arguments={"keyword": "cyrene", "search_type": "video"},
                work_operation_id=None,
            )
        )
    finally:
        asyncio.run(async_client.aclose())

    assert result["outcome"] == "verified"
    assert [path for path, _, _ in seen] == [
        "/internal/v1/bilibili/connections/list",
        "/internal/v1/connector-operation-grants",
        f"/internal/v1/connector-operations/{CONNECTION_REF}",
    ]
    grant_body = seen[1][1]
    invoke_body = seen[2][1]
    assert grant_body["profile_ref"] == PROFILE_REF
    assert (
        grant_body["arguments_digest_sha256"]
        == hashlib.sha256(b'{"keyword":"cyrene","search_type":"video"}').hexdigest()
    )
    assert invoke_body["request_id"] == grant_body["request_id"]
    assert "keyword" not in json.dumps(seen[0][1])


def test_exchange_http_adapter_signs_profile_and_qr_routes_without_browser_credentials() -> None:
    seen: list[tuple[str, dict[str, Any], Mapping[str, str]]] = []
    png_digest = hashlib.sha256(PNG_BYTES).hexdigest()

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        headers = dict(request.headers)
        seen.append((request.url.path, body, headers))
        assert "authorization" not in headers
        assert body["principal_issuer"] == "https://navigator.test/issuer"
        assert body["principal_subject"] == "writer"
        assert body["organization_id"] == ORGANIZATION
        assert body["workspace_id"] == WORKSPACE
        if request.url.path.endswith("/provider-profiles/list"):
            return httpx.Response(200, json={"profiles": [_profile()]})
        if request.url.path.endswith("/provider-profiles/get"):
            return httpx.Response(200, json={"profile": _profile()})
        if request.url.path.endswith("/qr-sessions/begin"):
            return httpx.Response(
                200,
                json={
                    "status": "PENDING",
                    "loginFlowId": "a" * 64,
                    "qrPngBase64": PNG_BASE64,
                    "qrPngSha256": png_digest,
                    "expiresAt": "2030-01-01T00:00:00Z",
                },
            )
        if request.url.path.endswith("/qr-sessions/status"):
            return httpx.Response(200, json={"status": "PENDING"})
        raise AssertionError(f"unexpected Exchange path: {request.url.path}")

    async_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    port = ExchangeBilibiliHttpClient(
        "https://exchange.example", _FakeNavigatorHmacSigner(), client=async_client
    )

    async def request_account_routes() -> None:
        await port.list_owned_provider_profiles(PRINCIPALS["writer-token"], WORKSPACE)
        await port.get_owned_provider_profile(
            PRINCIPALS["writer-token"], WORKSPACE, profile_ref=PROFILE_REF
        )
        await port.begin_qr(
            PRINCIPALS["writer-token"], WORKSPACE, idempotency_key="server-generated-key"
        )
        await port.poll_qr(PRINCIPALS["writer-token"], WORKSPACE, login_flow_id="a" * 64)

    try:
        asyncio.run(request_account_routes())
    finally:
        asyncio.run(async_client.aclose())

    assert [path for path, _, _ in seen] == [
        "/internal/v1/bilibili/provider-profiles/list",
        "/internal/v1/bilibili/provider-profiles/get",
        "/internal/v1/bilibili/qr-sessions/begin",
        "/internal/v1/bilibili/qr-sessions/status",
    ]
    assert seen[1][1]["profile_ref"] == PROFILE_REF
    assert seen[2][1]["idempotency_key"] == "server-generated-key"
    assert seen[3][1]["login_flow_id"] == "a" * 64
