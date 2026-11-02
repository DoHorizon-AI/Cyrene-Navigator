"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 test_conversation_media_api.py                                        │
│  Test: tests.test_conversation_media_api                                  │
│  Role: Verify the Harness-only attachment analysis route and late guards. │
│                                                                          │
│  测试职责：验证授权回读、字节摘要校验、ASR/vision 贡献和取消边界。      │
│  · Local provider fakes are SIMULATED and do not prove real model inference.│
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import threading
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.responses import JSONResponse

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_capabilities.media import (
    MediaArtifactAuthorization,
    MediaTurnContext,
    WorkMediaAttachment,
    WorkMediaAttachmentRecord,
)
from cyrene_navigator.work.conversation_capabilities.media_api import (
    create_conversation_media_router,
)
from cyrene_navigator.work.models import ConversationMemorySourceRef

_WORKSPACE = "workspace-media-test"
_MESSAGE_ID = "current-message-media-test"
_TASK_ID = "current-task-media-test"


class _AttachmentAccess:
    """SIMULATED Work auth/readback boundary with deterministic test controls."""

    def __init__(self, record: WorkMediaAttachmentRecord, data: bytes) -> None:
        self.record = record
        self.data = data
        self.authorization_calls = 0
        self.deny_on_call: int | None = None
        self.read_calls = 0
        self.override_read: WorkMediaAttachment | None = None

    def authorize(self, turn: MediaTurnContext, artifact_id: str) -> MediaArtifactAuthorization:
        self.authorization_calls += 1
        allowed = self.authorization_calls != self.deny_on_call
        return MediaArtifactAuthorization(
            allowed=allowed,
            current_authorization_epoch=turn.authorization_epoch,
            artifact=self.record if allowed and artifact_id == self.record.artifact_id else None,
        )

    def read(self, turn: MediaTurnContext, artifact_id: str) -> WorkMediaAttachment:
        self.read_calls += 1
        if self.override_read is not None:
            return self.override_read
        return WorkMediaAttachment(
            artifact_id=artifact_id,
            sha256=self.record.sha256,
            mime_type=self.record.mime_type,
            size=len(self.data),
            data=self.data,
        )


class _SpeechProvider:
    """SIMULATED speech.provider.v1 facade for route behavior tests."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.cancel_on_return = False
        self.status = "succeeded"

    def transcribe(self, **kwargs: Any) -> dict[str, object]:
        self.calls.append(kwargs)
        if self.cancel_on_return:
            kwargs["cancel_event"].set()
        return {"status": self.status, "text": "transcript returned by test double"}


class _VisionProvider:
    """SIMULATED model.provider.v1 V3 facade for route behavior tests."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.cancel_on_return = False

    def describe_image(self, **kwargs: Any) -> Any:
        from cyrene_navigator.work.conversation_capabilities.vision import VisionResult

        self.calls.append(kwargs)
        if self.cancel_on_return:
            kwargs["cancel_event"].set()
        return VisionResult(
            description="A green circle appears in the image.",
            model="simulated-vision-model",
            image_sha256=kwargs["sha256"],
        )


def _attachment(mime_type: str, data: bytes) -> WorkMediaAttachmentRecord:
    digest = hashlib.sha256(data).hexdigest()
    return WorkMediaAttachmentRecord(
        artifact_id=digest,
        sha256=digest,
        name="test-attachment",
        mime_type=mime_type,
        size=len(data),
    )


def _app(
    access: _AttachmentAccess,
    speech: _SpeechProvider | None,
    vision: _VisionProvider | None,
) -> TestClient:
    def resolve_turn_context(
        *, request: Any, workspace_id: str, message_id: str, cancel_event: threading.Event
    ) -> MediaTurnContext:
        assert request.headers.get("x-cyrene-work-task-id") == _TASK_ID
        record = access.record
        return MediaTurnContext(
            principal=PersistencePrincipal(
                actor_id="actor-media-test",
                workspace_ids=frozenset({_WORKSPACE}),
                organization_id="org-media-test",
            ),
            workspace_id=workspace_id,
            message_id=_MESSAGE_ID,
            conversation_id="conversation-media-test",
            conversation_kind="direct",
            persona_id="persona-media-test",
            authorization_epoch=7,
            source_refs=(
                ConversationMemorySourceRef(
                    memory_id=None,
                    memory_version=None,
                    source_message_ids=[_MESSAGE_ID],
                ),
            ),
            attachments=(record,),
            request_id="request-media-test",
            cancel_event=cancel_event,
        )

    app = FastAPI()

    @app.exception_handler(PersistenceError)
    async def persistence_error_handler(_request: Any, error: PersistenceError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status,
            content={"code": error.code, "detail": error.detail},
        )

    app.include_router(
        create_conversation_media_router(
            resolve_turn_context=resolve_turn_context,
            attachment_access=access,
            speech_provider=speech,
            vision_provider=vision,
        )
    )
    client = TestClient(app)
    client.headers.update({"X-Cyrene-Work-Task-ID": _TASK_ID})
    return client


def test_audio_route_returns_only_real_transcript_with_current_source_ref() -> None:
    audio = b"RIFF\x00\x00\x00\x00WAVEtest-audio"
    record = _attachment("audio/wav", audio)
    access = _AttachmentAccess(record, audio)
    speech = _SpeechProvider()
    with _app(access, speech, None) as client:
        response = client.post(
            f"/api/v1/workspaces/{_WORKSPACE}/work/conversation-media/analyze",
            json={
                "messageId": _MESSAGE_ID,
                "artifactId": record.artifact_id,
                "operation": "transcribe",
            },
        )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "contributed"
    assert (
        body["contribution"]["content"] == "[Audio transcript]\ntranscript returned by test double"
    )
    assert body["contribution"]["sourceRefs"] == [
        {"memoryId": None, "memoryVersion": None, "sourceMessageIds": [_MESSAGE_ID]}
    ]
    assert access.authorization_calls == 2
    assert access.read_calls == 1
    assert speech.calls[0]["data"] == audio


def test_image_route_returns_v3_description_and_does_not_accept_caller_source_refs() -> None:
    image = b"\x89PNG\r\n\x1a\nfixture-image"
    record = _attachment("image/png", image)
    access = _AttachmentAccess(record, image)
    vision = _VisionProvider()
    with _app(access, None, vision) as client:
        response = client.post(
            f"/api/v1/workspaces/{_WORKSPACE}/work/conversation-media/analyze",
            json={
                "messageId": _MESSAGE_ID,
                "artifactId": record.artifact_id,
                "operation": "describe_image",
                "prompt": "What shape is visible?",
            },
        )
        forged = client.post(
            f"/api/v1/workspaces/{_WORKSPACE}/work/conversation-media/analyze",
            json={
                "messageId": _MESSAGE_ID,
                "artifactId": record.artifact_id,
                "operation": "describe_image",
                "sourceRefs": [],
            },
        )
    assert response.status_code == 200
    assert response.json()["contribution"]["content"] == (
        "[Image analysis]\nA green circle appears in the image."
    )
    assert vision.calls[0]["data"] == image
    assert forged.status_code == 422


def test_no_speech_and_cancelled_late_result_never_create_text_contribution() -> None:
    audio = b"RIFF\x00\x00\x00\x00WAVEtest-audio"
    record = _attachment("audio/wav", audio)
    access = _AttachmentAccess(record, audio)
    speech = _SpeechProvider()
    speech.status = "no_speech"
    with _app(access, speech, None) as client:
        no_speech = client.post(
            f"/api/v1/workspaces/{_WORKSPACE}/work/conversation-media/analyze",
            json={
                "messageId": _MESSAGE_ID,
                "artifactId": record.artifact_id,
                "operation": "transcribe",
            },
        )
        speech.status = "succeeded"
        speech.cancel_on_return = True
        cancelled = client.post(
            f"/api/v1/workspaces/{_WORKSPACE}/work/conversation-media/analyze",
            json={
                "messageId": _MESSAGE_ID,
                "artifactId": record.artifact_id,
                "operation": "transcribe",
            },
        )
    assert no_speech.status_code == 200
    assert no_speech.json() == {"status": "no_speech", "contribution": None}
    assert cancelled.status_code == 409
    assert cancelled.json()["code"] == "MEDIA_OPERATION_CANCELLED"


def test_work_readback_mismatch_blocks_call_and_revoked_result_is_not_returned() -> None:
    image = b"\x89PNG\r\n\x1a\nfixture-image"
    record = _attachment("image/png", image)
    access = _AttachmentAccess(record, image)
    vision = _VisionProvider()
    access.override_read = WorkMediaAttachment(
        artifact_id=record.artifact_id,
        sha256="0" * 64,
        mime_type=record.mime_type,
        size=record.size,
        data=image,
    )
    with _app(access, None, vision) as client:
        mismatch = client.post(
            f"/api/v1/workspaces/{_WORKSPACE}/work/conversation-media/analyze",
            json={
                "messageId": _MESSAGE_ID,
                "artifactId": record.artifact_id,
                "operation": "describe_image",
            },
        )
    assert mismatch.status_code == 502
    assert mismatch.json()["code"] == "WORK_ATTACHMENT_READBACK_MISMATCH"
    assert vision.calls == []

    access.override_read = None
    access.authorization_calls = 0
    access.deny_on_call = 2
    with _app(access, None, vision) as client:
        revoked = client.post(
            f"/api/v1/workspaces/{_WORKSPACE}/work/conversation-media/analyze",
            json={
                "messageId": _MESSAGE_ID,
                "artifactId": record.artifact_id,
                "operation": "describe_image",
            },
        )
    assert revoked.status_code == 403
    assert revoked.json()["code"] == "MEDIA_ARTIFACT_NOT_AUTHORIZED"
    assert len(vision.calls) == 1


def test_current_message_scope_and_supported_media_mime_fail_closed() -> None:
    pdf = b"%PDF-1.4 test"
    record = _attachment("application/pdf", pdf)
    access = _AttachmentAccess(record, pdf)
    with _app(access, None, None) as client:
        unsupported = client.post(
            f"/api/v1/workspaces/{_WORKSPACE}/work/conversation-media/analyze",
            json={
                "messageId": _MESSAGE_ID,
                "artifactId": record.artifact_id,
                "operation": "transcribe",
            },
        )
        wrong_message = client.post(
            f"/api/v1/workspaces/{_WORKSPACE}/work/conversation-media/analyze",
            json={
                "messageId": "another-message",
                "artifactId": record.artifact_id,
                "operation": "describe_image",
            },
        )
    assert unsupported.status_code == 415
    assert unsupported.json()["code"] == "MEDIA_AUDIO_MIME_UNSUPPORTED"
    assert wrong_message.status_code == 403
    assert wrong_message.json()["code"] == "MEDIA_CURRENT_TURN_INVALID"
    assert access.authorization_calls == 0
