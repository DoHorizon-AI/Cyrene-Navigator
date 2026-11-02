"""
┌──────────────────────────────────────────────────────────────────────────┐
│  📄 test_conversation_media_library.py                                    │
│  Test: tests.test_conversation_media_library                              │
│  Role: Verify signed official media-tool mapping and consent boundaries.  │
│                                                                          │
│  测试职责：验证 emoji/sticker 目录查询、明确收集和 PNG artifact 分离。    │
│  · The provider client is SIMULATED; no real media runtime is claimed.    │
└──────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import threading
from collections.abc import Mapping
from typing import Any

import pytest
from cyrene_integration_contracts import TOOL_OPERATIONS, verify_context

from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.persistence.store import PersistencePrincipal
from cyrene_navigator.work.conversation_capabilities.config import ToolCallerSettings
from cyrene_navigator.work.conversation_capabilities.factory import build_conversation_capabilities
from cyrene_navigator.work.conversation_capabilities.media import (
    MediaCollectionPermit,
    MediaTurnContext,
    WorkMediaAttachmentRecord,
)
from cyrene_navigator.work.conversation_capabilities.media_library import (
    DirectMediaLibraryClient,
)
from cyrene_navigator.work.conversation_capabilities.peripheral import HostTrustedCallerSigner
from cyrene_navigator.work.models import ConversationMemorySourceRef

_KEY = bytes(range(32))
_TOOL_IDS = tuple(
    sorted(
        {
            "media.asset.import",
            "media.asset.search",
            "media.asset.get",
            "media.asset.delete",
            "media.asset.restore",
            "media.card.render",
        }
    )
)
_PROFILE = ToolCallerSettings(
    binding_id="media-binding-test",
    caller_workload="navigator-media-test",
    audience="cyrene.plugins.media-test",
    issuer="cyrene://navigator-test",
    key_environment_name="CYRENE_TEST_MEDIA_KEY",
    tool_ids=_TOOL_IDS,
)
_PRINCIPAL = PersistencePrincipal(
    actor_id="actor-media-test",
    workspace_ids=frozenset({"workspace-media-test"}),
    organization_id="org-media-test",
)
_ASSET = {
    "asset_id": "2f4aa00a-28e9-4b11-8a77-0dfe7c2fcb93",
    "digest": "a" * 64,
    "mime_type": "image/png",
    "byte_size": 128,
    "title": "Happy face",
    "alt_text": "A yellow smiling face",
    "tags": ["emoji", "smile", "happy"],
    "width": 32,
    "height": 32,
    "created_at": 1_798_000_000,
    "deleted_at": None,
}


class _SimulatedMediaToolClient:
    """Return catalog responses while verifying each fixed signed tool envelope."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Mapping[str, object]]] = []
        self.fail_tool_id: str | None = None

    def call_tool(
        self,
        provider_tool_id: str,
        arguments: Mapping[str, Any],
        caller_context: Mapping[str, Any],
        *,
        cancel_event: threading.Event | None = None,
        request_id: str | None = None,
    ) -> Mapping[str, Any]:
        assert request_id
        assert verify_context(
            method=provider_tool_id,
            operation_id=TOOL_OPERATIONS[provider_tool_id],
            payload=arguments,
            context=caller_context,
            key=_KEY,
            expected_caller_workload=_PROFILE.caller_workload,
            expected_audience=_PROFILE.audience,
            expected_binding_id=_PROFILE.binding_id,
            expected_organization_id="org-media-test",
            expected_workspace_id="workspace-media-test",
            expected_issuer=_PROFILE.issuer,
            expected_subject="actor-media-test",
        )
        self.calls.append((provider_tool_id, dict(arguments)))
        if self.fail_tool_id == provider_tool_id:
            from cyrene_navigator.work.conversation_capabilities.peripheral import (
                ConversationCapabilityPortError,
            )

            raise ConversationCapabilityPortError(
                "DIRECT_PLUGIN_TIMEOUT", unavailable=True, retryable=True, side_effect_possible=True
            )
        if provider_tool_id == "media.asset.import":
            return dict(_ASSET)
        if provider_tool_id == "media.asset.search":
            return {"items": [dict(_ASSET)], "next_cursor": None}
        if provider_tool_id in {"media.asset.get", "media.card.render"}:
            asset = dict(_ASSET)
            if provider_tool_id == "media.card.render":
                asset.update(
                    {
                        "asset_id": "3f4aa00a-28e9-4b11-8a77-0dfe7c2fcb93",
                        "digest": "b" * 64,
                        "mime_type": "image/png",
                        "byte_size": 256,
                        "title": "A card",
                        "tags": [],
                        "width": 640,
                        "height": 360,
                    }
                )
            return {
                "asset": asset,
                "artifact": {
                    "artifact_id": asset["digest"],
                    "sha256": asset["digest"],
                    "mime_type": asset["mime_type"],
                    "size": asset["byte_size"],
                },
            }
        if provider_tool_id in {"media.asset.delete", "media.asset.restore"}:
            return {"asset_id": arguments["asset_id"], "deleted": False}
        raise AssertionError(f"unexpected media tool: {provider_tool_id}")


def _client(fake: _SimulatedMediaToolClient) -> DirectMediaLibraryClient:
    return DirectMediaLibraryClient(
        fake,  # type: ignore[arg-type]
        HostTrustedCallerSigner(_PROFILE, _KEY),
        _PROFILE,
    )


def _turn(artifact_id: str) -> tuple[MediaTurnContext, WorkMediaAttachmentRecord, MediaCollectionPermit]:
    attachment = WorkMediaAttachmentRecord(
        artifact_id=artifact_id,
        sha256=artifact_id,
        name="incoming.png",
        mime_type="image/png",
        size=128,
    )
    turn = MediaTurnContext(
        principal=_PRINCIPAL,
        workspace_id="workspace-media-test",
        message_id="message-media-test",
        conversation_id="conversation-media-test",
        conversation_kind="direct",
        persona_id="persona-media-test",
        authorization_epoch=4,
        source_refs=(
            ConversationMemorySourceRef(
                memory_id=None,
                memory_version=None,
                source_message_ids=["message-media-test"],
            ),
        ),
        attachments=(attachment,),
        request_id="media-task-request",
        cancel_event=threading.Event(),
    )
    permit = MediaCollectionPermit(
        message_id=turn.message_id,
        artifact_id=artifact_id,
        authorization_epoch=turn.authorization_epoch,
        category="emoji",
        consent_id="host-issued-explicit-collection-consent",
    )
    return turn, attachment, permit


def test_collect_requires_host_permit_and_reads_back_real_catalog_asset() -> None:
    fake = _SimulatedMediaToolClient()
    client = _client(fake)
    turn, record, permit = _turn("a" * 64)
    asset = client.collect_attachment(
        turn=turn,
        attachment=record,
        permit=permit,
        category="emoji",
        title="Happy face",
        alt_text="A yellow smiling face",
        tags=("smile", "happy"),
    )
    assert asset.asset_id == _ASSET["asset_id"]
    assert asset.digest == record.sha256
    assert [tool_id for tool_id, _ in fake.calls] == [
        "media.asset.import",
        "media.asset.search",
    ]
    import_args = fake.calls[0][1]
    assert import_args["artifact_id"] == record.artifact_id
    assert import_args["tags"] == ["emoji", "smile", "happy"]
    assert "data" not in import_args

    mismatched_turn, mismatched_record, _ = _turn("c" * 64)
    with pytest.raises(PersistenceError) as denied:
        client.collect_attachment(
            turn=mismatched_turn,
            attachment=mismatched_record,
            permit=permit,
            category="emoji",
            title="No consent for this image",
        )
    assert denied.value.code == "MEDIA_COLLECTION_CONSENT_REQUIRED"


def test_query_selection_returns_only_an_actual_unique_asset_id() -> None:
    fake = _SimulatedMediaToolClient()
    client = _client(fake)
    selected = client.select_asset(
        category="emoji",
        query="yellow smile",
        principal=_PRINCIPAL,
        workspace_id="workspace-media-test",
    )
    assert selected.asset.asset_id == _ASSET["asset_id"]
    assert selected.score > 0
    assert fake.calls[0][0] == "media.asset.search"
    assert fake.calls[0][1]["query"] == "emoji"


def test_png_render_returns_verified_work_artifact_without_any_send_call() -> None:
    fake = _SimulatedMediaToolClient()
    client = _client(fake)
    exported = client.render_card(
        title="Status",
        body="All checks passed.",
        principal=_PRINCIPAL,
        workspace_id="workspace-media-test",
        theme="dark",
    )
    assert exported.asset.mime_type == "image/png"
    assert exported.artifact.artifact_id == exported.asset.digest
    assert [tool_id for tool_id, _ in fake.calls] == ["media.card.render"]
    assert exported.artifact.size == 256
    assert client.status()["available"] is True


def test_unknown_media_write_result_is_uncertain_and_never_replayed() -> None:
    fake = _SimulatedMediaToolClient()
    fake.fail_tool_id = "media.card.render"
    client = _client(fake)
    with pytest.raises(PersistenceError) as uncertain:
        client.render_card(
            title="Status",
            body="A possibly stored image.",
            principal=_PRINCIPAL,
            workspace_id="workspace-media-test",
        )
    assert uncertain.value.code == "MEDIA_OPERATION_UNCERTAIN"
    assert len(fake.calls) == 1


def test_media_factory_uses_its_own_endpoint_profile_and_unverified_health() -> None:
    environment = {
        "CYRENE_NAVIGATOR_MEDIA_PROVIDER_CONNECTION_REF": "grpc://127.0.0.1:51020",
        "CYRENE_NAVIGATOR_MEDIA_TOOL_BINDING_ID": _PROFILE.binding_id,
        "CYRENE_NAVIGATOR_MEDIA_TOOL_CALLER_WORKLOAD": _PROFILE.caller_workload,
        "CYRENE_NAVIGATOR_MEDIA_TOOL_AUDIENCE": _PROFILE.audience,
        "CYRENE_NAVIGATOR_MEDIA_TOOL_ISSUER": _PROFILE.issuer,
        "CYRENE_NAVIGATOR_MEDIA_TOOL_SIGNING_KEY_ENV": "CYRENE_TEST_MEDIA_KEY",
        "CYRENE_NAVIGATOR_MEDIA_TOOL_IDS": ",".join(_TOOL_IDS),
        "CYRENE_TEST_MEDIA_KEY": _KEY.hex(),
        "CYRENE_NAVIGATOR_TOOL_PROVIDER_CONNECTION_REF": "grpc://127.0.0.1:51021",
    }
    capabilities = build_conversation_capabilities(environment=environment)
    try:
        assert capabilities.media_library_client is not None
        assert capabilities.unavailable["cyrene.tools.media"] == "NOT_VERIFIED"
        assert capabilities.media_library_client.status() == {
            "configured": True,
            "available": False,
            "reason_code": "NOT_VERIFIED",
        }
        assert capabilities.tool_provider_client is None
    finally:
        capabilities.close()
