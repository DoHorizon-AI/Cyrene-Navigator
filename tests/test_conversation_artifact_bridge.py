"""
┌─────────────────────────────────────────────────────────────────────────┐
│ 📄 test_conversation_artifact_bridge.py                                 │
│ Module: tests.test_conversation_artifact_bridge                        │
│ Role: Exercise live-call artifact authorization over real ASGI HTTP.    │
│                                                                         │
│ 模块职责：通过真实ASGI HTTP验证单次调用附件授权与隔离。                 │
└─────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_artifact_bridge import (
    ActiveCallLease,
    ArtifactReadGrant,
    ConversationArtifactScope,
    create_conversation_artifact_registry,
)
from cyrene_navigator.work.conversation_artifact_bridge.routes import (
    mount_conversation_artifact_bridge,
)
from cyrene_navigator.work.conversation_peripheral.ports import (
    ArtifactBridgeBinding,
    ArtifactBridgeConfig,
    VerifiedArtifactCaller,
)
from cyrene_navigator.work.store import WorkStore

ORGANIZATION = "org-test"
WORKSPACE = "workspace-test"
BINDING_ID = "document-provider-binding"
SERVICE_BEARER = "1" * 64
SIGNING_KEY = b"aether-artifact-bridge-key-00010"
_CONTEXT_FIELDS = (
    "method",
    "operation_id",
    "caller_workload",
    "audience",
    "issuer",
    "subject",
    "organization_id",
    "workspace_id",
    "binding_id",
    "request_id",
    "issued_at",
    "expires_at",
    "payload_sha256",
)
_PNG = b"\x89PNG\r\n\x1a\nartifact-bridge-test"


class _HmacVerifier:
    """Verify the production caller-context fields with a real test HMAC key."""

    def verify_artifact_call(
        self,
        *,
        tool_id: str,
        arguments: dict[str, Any],
        caller_context: dict[str, Any],
        binding_id: str,
    ) -> VerifiedArtifactCaller:
        if set(caller_context) != {*_CONTEXT_FIELDS, "signature"}:
            raise ValueError("caller context fields are not closed")
        fields = {name: caller_context[name] for name in _CONTEXT_FIELDS}
        expected = hmac.new(SIGNING_KEY, _canonical_json(fields), hashlib.sha256).hexdigest()
        if (
            not hmac.compare_digest(str(caller_context.get("signature", "")), expected)
            or caller_context.get("method") != tool_id
            or caller_context.get("operation_id") != tool_id
            or caller_context.get("binding_id") != binding_id
            or caller_context.get("payload_sha256")
            != hashlib.sha256(_canonical_json(arguments)).hexdigest()
        ):
            raise ValueError("caller HMAC does not match this request")
        return VerifiedArtifactCaller(
            organization_id=str(caller_context["organization_id"]),
            workspace_id=str(caller_context["workspace_id"]),
            actor_id=str(caller_context["subject"]),
        )


class _MutableSourceAuthorizer:
    """Expose a fresh authorization epoch and keep the exact checked scope."""

    def __init__(self) -> None:
        self.epoch = 7
        self.return_boolean = False
        self.calls: list[tuple[str, ConversationArtifactScope]] = []

    def authorize_artifact(
        self,
        principal: PersistencePrincipal,
        workspace_id: str,
        artifact_id: str,
        scope: ConversationArtifactScope,
    ) -> dict[str, Any] | bool:
        self.calls.append((principal.actor_id, scope))
        if self.return_boolean:
            return True
        return {
            "allowed": artifact_id == scope.source_refs[0]["artifact_id"],
            "currentAuthorizationEpoch": self.epoch,
        }


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()


def _principal(actor_id: str) -> PersistencePrincipal:
    return PersistencePrincipal(
        actor_id,
        frozenset({WORKSPACE}),
        organization_id=ORGANIZATION,
        actor_private_scope=True,
    )


def _context(
    principal: PersistencePrincipal,
    *,
    tool_id: str,
    request_id: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    issued = datetime.now(UTC)
    expires = issued + timedelta(seconds=120)
    fields = {
        "method": tool_id,
        "operation_id": tool_id,
        "caller_workload": "navigator-harness",
        "audience": "exchange.product",
        "issuer": "https://navigator.test/issuer",
        "subject": principal.actor_id,
        "organization_id": ORGANIZATION,
        "workspace_id": WORKSPACE,
        "binding_id": BINDING_ID,
        "request_id": request_id,
        "issued_at": issued.isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "expires_at": expires.isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "payload_sha256": hashlib.sha256(_canonical_json(arguments)).hexdigest(),
    }
    signature = hmac.new(SIGNING_KEY, _canonical_json(fields), hashlib.sha256).hexdigest()
    return {**fields, "signature": signature}


def _start_task(store: WorkStore, principal: PersistencePrincipal, task_id: str) -> None:
    task, duplicate = store.create_task(
        ORGANIZATION,
        WORKSPACE,
        {
            "id": task_id,
            "sessionId": f"session-{task_id}",
            "prompt": "Read the selected document.",
            "metadata": {},
        },
        actor_id=principal.actor_id,
        actor_private_scope=True,
    )
    assert not duplicate and task["status"] == "queued"
    claimed, running = store.claim_task(
        ORGANIZATION,
        WORKSPACE,
        task_id,
        actor_id=principal.actor_id,
        actor_private_scope=True,
    )
    assert claimed and running["status"] == "running"


def _register_document_call(
    registry: Any,
    principal: PersistencePrincipal,
    *,
    task_id: str,
    request_id: str,
    artifact_id: str,
    source_scope: ConversationArtifactScope | None = None,
) -> tuple[ActiveCallLease, dict[str, Any], dict[str, Any]]:
    arguments = {"artifact_id": artifact_id}
    context = _context(
        principal,
        tool_id="document.read",
        request_id=request_id,
        arguments=arguments,
    )
    lease = registry.register_task_call(
        principal,
        WORKSPACE,
        task_id=task_id,
        request_id=request_id,
        binding_id=BINDING_ID,
        tool_id="document.read",
        operation_id="document.read",
        arguments=arguments,
        caller_context=context,
        read_grants=(
            ArtifactReadGrant(
                artifact_id,
                "conversation_source" if source_scope else "task_input",
                frozenset({"application/pdf"}),
                source_scope=source_scope,
            ),
        ),
    )
    return lease, arguments, context


def _bridge_app(store: WorkStore, registry: Any) -> FastAPI:
    app = FastAPI()

    @app.exception_handler(PersistenceError)
    async def persistence_error(_request: Request, error: PersistenceError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status,
            content={"code": error.code, "detail": error.detail},
        )

    config = ArtifactBridgeConfig(
        bindings={
            BINDING_ID: ArtifactBridgeBinding(
                bearer_token=SERVICE_BEARER,
                binding_id=BINDING_ID,
                verifier=_HmacVerifier(),
            )
        },
        registry=registry,
    )
    mount_conversation_artifact_bridge(app, store, config)
    return app


def _read_request(
    artifact_id: str,
    arguments: dict[str, Any],
    caller_context: dict[str, Any],
) -> dict[str, Any]:
    return {
        "artifactId": artifact_id,
        "toolId": "document.read",
        "arguments": arguments,
        "callerContext": caller_context,
    }


def _post_json(
    app: FastAPI,
    path: str,
    body: dict[str, Any],
    *,
    bearer: str = SERVICE_BEARER,
    client_address: tuple[str, int] = ("127.0.0.1", 31337),
) -> httpx.Response:
    async def request() -> httpx.Response:
        transport = httpx.ASGITransport(app=app, client=client_address)
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            return await client.post(
                path,
                json=body,
                headers={"Authorization": f"Bearer {bearer}"},
            )

    return asyncio.run(request())


def test_same_provider_serves_parallel_actor_tasks_without_cross_scope_leaks(
    tmp_path: Path,
) -> None:
    """One long-lived binding serves two tasks but each call sees only its grant."""

    store = WorkStore(tmp_path / "work.sqlite3")
    registry = create_conversation_artifact_registry(store)
    principal_a = _principal("actor-a")
    principal_b = _principal("actor-b")
    _start_task(store, principal_a, "task-a")
    _start_task(store, principal_b, "task-b")
    bytes_a = b"%PDF-1.7 actor-a source"
    bytes_b = b"%PDF-1.7 actor-b source"
    attachment_a = store.put_attachment(
        ORGANIZATION,
        WORKSPACE,
        "a.pdf",
        "application/pdf",
        bytes_a,
        actor_id=principal_a.actor_id,
        actor_private_scope=True,
    )
    attachment_b = store.put_attachment(
        ORGANIZATION,
        WORKSPACE,
        "b.pdf",
        "application/pdf",
        bytes_b,
        actor_id=principal_b.actor_id,
        actor_private_scope=True,
    )
    lease_a, args_a, context_a = _register_document_call(
        registry,
        principal_a,
        task_id="task-a",
        request_id="call-a",
        artifact_id=str(attachment_a["sha256"]),
    )
    lease_b, args_b, context_b = _register_document_call(
        registry,
        principal_b,
        task_id="task-b",
        request_id="call-b",
        artifact_id=str(attachment_b["sha256"]),
    )
    app = _bridge_app(store, registry)

    async def concurrent_reads() -> tuple[httpx.Response, httpx.Response, httpx.Response]:
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 31337))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            responses = await asyncio.gather(
                client.post(
                    "/v1/artifacts/read",
                    json=_read_request(str(attachment_a["sha256"]), args_a, context_a),
                    headers={"Authorization": f"Bearer {SERVICE_BEARER}"},
                ),
                client.post(
                    "/v1/artifacts/read",
                    json=_read_request(str(attachment_b["sha256"]), args_b, context_b),
                    headers={"Authorization": f"Bearer {SERVICE_BEARER}"},
                ),
                client.post(
                    "/v1/artifacts/read",
                    json={
                        "artifactId": attachment_a["sha256"],
                        "toolId": "document.read",
                        "arguments": args_b,
                        "callerContext": context_b,
                    },
                    headers={"Authorization": f"Bearer {SERVICE_BEARER}"},
                ),
            )
        return responses[0], responses[1], responses[2]

    response_a, response_b, swapped = asyncio.run(concurrent_reads())
    lease_a.close()
    lease_b.close()

    assert response_a.status_code == 200
    assert response_a.json()["contentBase64"] == base64.b64encode(bytes_a).decode()
    assert response_b.status_code == 200
    assert response_b.json()["contentBase64"] == base64.b64encode(bytes_b).decode()
    assert swapped.status_code == 403
    assert registry.active_call_count == 0
    closed_call = _post_json(
        app,
        "/v1/artifacts/read",
        _read_request(str(attachment_a["sha256"]), args_a, context_a),
    )
    assert closed_call.status_code == 403


def test_task_terminal_state_cancels_live_artifact_access(tmp_path: Path) -> None:
    store = WorkStore(tmp_path / "work.sqlite3")
    registry = create_conversation_artifact_registry(store)
    principal = _principal("actor-a")
    _start_task(store, principal, "task-a")
    attachment = store.put_attachment(
        ORGANIZATION,
        WORKSPACE,
        "source.pdf",
        "application/pdf",
        b"%PDF task input",
        actor_id=principal.actor_id,
        actor_private_scope=True,
    )
    lease, arguments, context = _register_document_call(
        registry,
        principal,
        task_id="task-a",
        request_id="cancelled-call",
        artifact_id=str(attachment["sha256"]),
    )
    store.patch_task(
        ORGANIZATION,
        WORKSPACE,
        "task-a",
        {"status": "aborted"},
        actor_id=principal.actor_id,
        actor_private_scope=True,
    )
    app = _bridge_app(store, registry)
    response = _post_json(
        app,
        "/v1/artifacts/read",
        {
            "artifactId": attachment["sha256"],
            "toolId": "document.read",
            "arguments": arguments,
            "callerContext": context,
        },
    )
    lease.close()
    assert response.status_code == 403


@pytest.mark.skipif(not hasattr(os, "O_NOFOLLOW"), reason="host OS does not expose O_NOFOLLOW")
def test_read_rejects_symlinked_attachment_content(tmp_path: Path) -> None:
    store = WorkStore(tmp_path / "work.sqlite3")
    registry = create_conversation_artifact_registry(store)
    principal = _principal("actor-a")
    _start_task(store, principal, "task-a")
    source = b"%PDF protected input"
    attachment = store.put_attachment(
        ORGANIZATION,
        WORKSPACE,
        "source.pdf",
        "application/pdf",
        source,
        actor_id=principal.actor_id,
        actor_private_scope=True,
    )
    digest = str(attachment["sha256"])
    lease, arguments, context = _register_document_call(
        registry,
        principal,
        task_id="task-a",
        request_id="symlink-call",
        artifact_id=digest,
    )
    _metadata, stored_path = store.get_attachment(
        ORGANIZATION,
        WORKSPACE,
        digest,
        actor_id=principal.actor_id,
        actor_private_scope=True,
    )
    outside_path = tmp_path / "outside.pdf"
    outside_path.write_bytes(source)
    stored_path.unlink()
    stored_path.symlink_to(outside_path)

    response = _post_json(
        _bridge_app(store, registry),
        "/v1/artifacts/read",
        _read_request(digest, arguments, context),
    )
    lease.close()

    assert response.status_code == 500
    assert response.json()["code"] == "WORK_ATTACHMENT_CONTENT_UNAVAILABLE"


def test_conversation_source_epoch_is_rechecked_on_every_read(tmp_path: Path) -> None:
    store = WorkStore(tmp_path / "work.sqlite3")
    authorizer = _MutableSourceAuthorizer()
    registry = create_conversation_artifact_registry(store, source_authorizer=authorizer)
    principal = _principal("actor-a")
    _start_task(store, principal, "task-a")
    attachment = store.put_attachment(
        ORGANIZATION,
        WORKSPACE,
        "source.pdf",
        "application/pdf",
        b"%PDF group source",
        actor_id=principal.actor_id,
        actor_private_scope=True,
    )
    digest = str(attachment["sha256"])
    scope = ConversationArtifactScope(
        conversation_id="group-42",
        conversation_kind="group",
        persona_id="persona-a",
        authorization_epoch=7,
        source_refs=({"artifact_id": digest, "source_id": "message-1"},),
    )
    lease, arguments, context = _register_document_call(
        registry,
        principal,
        task_id="task-a",
        request_id="source-call",
        artifact_id=digest,
        source_scope=scope,
    )
    app = _bridge_app(store, registry)

    def read_once() -> httpx.Response:
        return _post_json(
            app,
            "/v1/artifacts/read",
            {
                "artifactId": digest,
                "toolId": "document.read",
                "arguments": arguments,
                "callerContext": context,
            },
        )

    first = read_once()
    authorizer.epoch = 8
    stale = read_once()
    authorizer.return_boolean = True
    boolean_only = read_once()
    lease.close()

    assert first.status_code == 200
    assert stale.status_code == 409
    assert boolean_only.status_code == 409
    assert stale.json()["code"] == "WORK_ARTIFACT_SOURCE_REVOKED"
    assert boolean_only.json()["code"] == "WORK_ARTIFACT_SOURCE_REVOKED"
    assert len(authorizer.calls) == 4
    assert all(
        actor_id == "actor-a" and checked_scope == scope
        for actor_id, checked_scope in authorizer.calls
    )


def test_loopback_service_token_and_closed_request_shape_are_required(tmp_path: Path) -> None:
    store = WorkStore(tmp_path / "work.sqlite3")
    registry = create_conversation_artifact_registry(store)
    principal = _principal("actor-a")
    _start_task(store, principal, "task-a")
    attachment = store.put_attachment(
        ORGANIZATION,
        WORKSPACE,
        "source.pdf",
        "application/pdf",
        b"%PDF selected input",
        actor_id=principal.actor_id,
        actor_private_scope=True,
    )
    lease, arguments, context = _register_document_call(
        registry,
        principal,
        task_id="task-a",
        request_id="strict-call",
        artifact_id=str(attachment["sha256"]),
    )
    app = _bridge_app(store, registry)
    body = _read_request(str(attachment["sha256"]), arguments, context)

    wrong_token = _post_json(app, "/v1/artifacts/read", body, bearer="2" * 64)
    remote_peer = _post_json(
        app,
        "/v1/artifacts/read",
        body,
        client_address=("192.0.2.50", 31337),
    )
    path_in_body = _post_json(
        app,
        "/v1/artifacts/read",
        {**body, "path": "/etc/passwd"},
    )
    lease.close()

    assert wrong_token.status_code == 403
    assert remote_peer.status_code == 403
    assert path_in_body.status_code == 422


def test_write_is_call_bound_private_and_rejects_oversized_output(tmp_path: Path) -> None:
    store = WorkStore(tmp_path / "work.sqlite3")
    registry = create_conversation_artifact_registry(store)
    principal = _principal("actor-a")
    _start_task(store, principal, "task-a")
    arguments = {"title": "Test", "body": "Private card", "theme": "light"}
    context = _context(
        principal,
        tool_id="media.card.render",
        request_id="render-call",
        arguments=arguments,
    )
    lease = registry.register_task_call(
        principal,
        WORKSPACE,
        task_id="task-a",
        request_id="render-call",
        binding_id=BINDING_ID,
        tool_id="media.card.render",
        operation_id="media.card.render",
        arguments=arguments,
        caller_context=context,
        write_mime_types=("image/png",),
    )
    app = _bridge_app(store, registry)
    bad_name = _post_json(
        app,
        "/v1/artifacts/write",
        {
            "mimeType": "image/png",
            "name": "../private.png",
            "contentBase64": base64.b64encode(_PNG).decode(),
            "toolId": "media.card.render",
            "arguments": arguments,
            "callerContext": context,
        },
    )
    oversized = b"\x89PNG\r\n\x1a\n" + b"x" * (10_000_001 - 8)
    too_large = _post_json(
        app,
        "/v1/artifacts/write",
        {
            "mimeType": "image/png",
            "name": "oversized.png",
            "contentBase64": base64.b64encode(oversized).decode(),
            "toolId": "media.card.render",
            "arguments": arguments,
            "callerContext": context,
        },
    )
    written = _post_json(
        app,
        "/v1/artifacts/write",
        {
            "mimeType": "image/png",
            "name": "render.png",
            "contentBase64": base64.b64encode(_PNG).decode(),
            "toolId": "media.card.render",
            "arguments": arguments,
            "callerContext": context,
        },
    )
    digest = hashlib.sha256(_PNG).hexdigest()
    registry.assert_output(lease, digest)
    lease.close()

    assert bad_name.status_code == 422
    assert too_large.status_code == 413
    assert written.status_code == 200
    assert written.json() == {
        "artifactId": digest,
        "sha256": digest,
        "mimeType": "image/png",
        "size": len(_PNG),
    }
    with pytest.raises(PersistenceError) as error:
        store.get_attachment(
            ORGANIZATION,
            WORKSPACE,
            digest,
            actor_id="actor-b",
            actor_private_scope=True,
        )
    assert error.value.code == "WORK_ATTACHMENT_NOT_FOUND"
