"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 test_qq_conversation_connector.py                                │
│  Module: cyrene_navigator.work.conversation_connectors               │
│  Role: Verify QQ scope, admission, reauthorization, and receipt rules.  │
│                                                                      │
│  模块职责：验证 QQ 范围、任务接受、发送授权复验和持久回执边界。       │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass

import pytest
from cyrene_message_connector_contracts import (
    DELIVERY_RESULT_TYPE_URL,
    INBOUND_MESSAGE_TYPE_URL,
    MessageConnectorValidationError,
    encode_delivery_result,
    encode_inbound_message,
)
from cyrene_message_connector_contracts import (
    message_connector_pb2 as wire,
)
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from cyrene_navigator.work.conversation_connectors.api import (
    mount_conversation_connector_routes,
)
from cyrene_navigator.work.conversation_connectors.qq import (
    DirectPayload,
    QQConnectorBinding,
    QQConversationConnector,
    _event_key,
)
from cyrene_navigator.work.conversation_connectors.types import (
    AdmissionReceipt,
    AuthorizedReplyRoute,
    OperationLease,
    VerifiedInboundContext,
)

ACTOR_ID = "9f470dc4-7919-4881-a194-85dfb75f292a"


def test_inbound_event_uses_trusted_actor_scope_and_work_admission() -> None:
    async def run() -> None:
        host = FakeHost()
        connector = QQConversationConnector(_binding(FakeClient()), host)
        payload = _event_payload()

        receipt = await connector.process_payload(payload)

        assert receipt == AdmissionReceipt("event-1", False, "task-1")
        assert host.resolved_binding_ids == ["qq-account-a"]
        assert host.admitted[0][0].actor_id == ACTOR_ID
        assert host.admitted[0][1].sender_id == "qq-sender-3"
        assert host.admitted[0][2] == _event_key("qq-account-a", host.admitted[0][1])

    asyncio.run(run())


def test_inbound_account_mismatch_fails_before_actor_mapping() -> None:
    async def run() -> None:
        host = FakeHost()
        connector = QQConversationConnector(_binding(FakeClient()), host)
        event = _make_event(account_id="other-account")
        payload = DirectPayload(
            INBOUND_MESSAGE_TYPE_URL,
            encode_inbound_message(event),
            "inbound_message",
        )

        with pytest.raises(MessageConnectorValidationError, match="does not match"):
            await connector.process_payload(payload)
        assert host.resolved_binding_ids == []
        assert not host.admitted

    asyncio.run(run())


def test_event_key_binds_conversation_kind_and_identity() -> None:
    event = _make_event()
    group_key = _event_key("qq-account-a", event)
    event.conversation.kind = wire.CONVERSATION_KIND_PRIVATE
    private_key = _event_key("qq-account-a", event)
    event.conversation.kind = wire.CONVERSATION_KIND_GROUP
    event.conversation.conversation_id = "another-group"
    other_group_key = _event_key("qq-account-a", event)

    assert group_key != private_key
    assert group_key != other_group_key


def test_host_scope_must_match_conversation_kind() -> None:
    async def run() -> None:
        host = FakeHost()
        host.context = VerifiedInboundContext(
            organization_id="org-1",
            workspace_id="workspace-1",
            actor_id=ACTOR_ID,
            session_id="session-1",
            binding_id="qq-account-a",
            connector_id="qq-v1",
            account_id="qq-account-a",
            conversation_id="group-8",
            conversation_kind=wire.CONVERSATION_KIND_PRIVATE,
            sender_id="qq-sender-3",
            subscription_id="subscription-1",
        )
        connector = QQConversationConnector(_binding(FakeClient()), host)

        with pytest.raises(MessageConnectorValidationError, match="mismatched QQ actor/scope"):
            await connector.process_payload(_event_payload())
        assert not host.admitted

    asyncio.run(run())


def test_unmapped_sender_is_not_admitted_as_an_actor() -> None:
    async def run() -> None:
        host = FakeHost()
        host.context = None
        connector = QQConversationConnector(_binding(FakeClient()), host)

        assert await connector.process_payload(_event_payload()) is None
        assert not host.admitted
        assert connector.status["rejectedEvents"] == 1

    asyncio.run(run())


def test_host_cannot_ack_inbound_without_a_durable_dsh_task() -> None:
    async def run() -> None:
        host = FakeHost()
        host.admission_receipt = AdmissionReceipt("event-1", False, "")
        connector = QQConversationConnector(_binding(FakeClient()), host)

        with pytest.raises(MessageConnectorValidationError, match="without a durable Work event"):
            await connector.process_payload(_event_payload())

    asyncio.run(run())


def test_host_cannot_return_a_sender_mismatched_or_non_uuid_actor_mapping() -> None:
    async def run() -> None:
        host = FakeHost()
        host.context = VerifiedInboundContext(
            organization_id="org-1",
            workspace_id="workspace-1",
            actor_id="qq-sender-3",
            session_id="session-1",
            binding_id="qq-account-a",
            connector_id="qq-v1",
            account_id="qq-account-a",
            conversation_id="group-8",
            conversation_kind=wire.CONVERSATION_KIND_GROUP,
            sender_id="qq-sender-3",
            subscription_id="subscription-1",
        )
        connector = QQConversationConnector(_binding(FakeClient()), host)

        with pytest.raises(MessageConnectorValidationError, match="non-UUID"):
            await connector.process_payload(_event_payload())
        assert not host.admitted

    asyncio.run(run())


def test_send_persists_intent_reauthorizes_and_uses_host_route() -> None:
    async def run() -> None:
        client = FakeClient()
        host = FakeHost()
        connector = QQConversationConnector(_binding(client), host)

        outcome = await connector.send_reply(
            task_id="task-1", reply_key="completion-1", text="hello"
        )

        assert outcome.status == "accepted"
        assert outcome.vendor_message_id == "vendor-msg-1"
        assert len(host.begin_calls) == 1
        assert host.authorize_calls == 2
        assert len(client.invoke_calls) == 1
        sent_request = wire.SendMessageRequest()
        sent_request.ParseFromString(client.invoke_calls[0].value)
        assert sent_request.conversation.conversation_id == "group-8"
        assert sent_request.reply.message_id == "message-1"
        assert sent_request.content[0].text.text == "hello"
        assert host.finished[0][1] == "verified"

    asyncio.run(run())


def test_send_stops_when_authorization_changes_before_connector_call() -> None:
    async def run() -> None:
        client = FakeClient()
        host = FakeHost()
        changed = _route(revision="revoked-revision")
        host.routes = [_route(), changed]
        connector = QQConversationConnector(_binding(client), host)

        outcome = await connector.send_reply(
            task_id="task-1", reply_key="completion-2", text="hello"
        )

        assert outcome.status == "authorization_denied"
        assert not client.invoke_calls
        assert host.finished[0][1] == "verified"
        assert host.finished[0][2] == {"outcome": "authorization_denied", "sent": False}

    asyncio.run(run())


def test_existing_operation_is_never_replayed() -> None:
    async def run() -> None:
        client = FakeClient()
        host = FakeHost()
        host.operation = OperationLease("operation-1", "uncertain", False)
        connector = QQConversationConnector(_binding(client), host)

        outcome = await connector.send_reply(
            task_id="task-1", reply_key="completion-3", text="hello"
        )

        assert outcome.status == "uncertain"
        assert outcome.operation_id == "operation-1"
        assert not client.invoke_calls
        assert not host.finished

    asyncio.run(run())


def test_ambiguous_plugin_failure_is_recorded_uncertain_without_retry() -> None:
    async def run() -> None:
        client = FakeClient()
        client.invoke_error = TimeoutError("stream timed out")
        host = FakeHost()
        connector = QQConversationConnector(_binding(client), host)

        outcome = await connector.send_reply(
            task_id="task-1", reply_key="completion-4", text="hello"
        )

        assert outcome.status == "uncertain"
        assert host.finished[0][1] == "uncertain"
        assert host.finished[0][2]["sent"] == "unknown"
        assert len(client.invoke_calls) == 1
        host.operation = OperationLease("operation-1", "uncertain", False)
        second = await connector.send_reply(
            task_id="task-1", reply_key="completion-4", text="hello"
        )
        assert second.status == "uncertain"
        assert len(client.invoke_calls) == 1

    asyncio.run(run())


def test_cancellation_during_send_persists_uncertain_operation() -> None:
    async def run() -> None:
        client = BlockingClient()
        host = FakeHost()
        connector = QQConversationConnector(_binding(client), host)
        task = asyncio.create_task(
            connector.send_reply(task_id="task-1", reply_key="completion-5", text="hello")
        )
        await asyncio.to_thread(client.entered.wait, 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert host.finished[0][1] == "uncertain"
        assert host.finished[0][2]["outcome"] == "cancelled_during_send"
        assert client.cancelled

    asyncio.run(run())


def test_close_cancels_a_stuck_host_admission_without_hanging() -> None:
    async def run() -> None:
        host = BlockingAdmissionHost()
        client = StreamingClient()
        connector = QQConversationConnector(_binding(client), host)
        await connector.start()
        await asyncio.wait_for(host.entered.wait(), timeout=1)

        await asyncio.wait_for(connector.close(), timeout=1)

        assert host.cancelled
        assert client.stream_closed

    asyncio.run(run())


def test_event_filter_subscribes_only_to_inbound_message() -> None:
    from cyrene_navigator.work.conversation_connectors.qq import (
        SUBSCRIPTION_FILTER,
        SUBSCRIPTION_FILTER_TYPE_URL,
    )

    assert SUBSCRIPTION_FILTER_TYPE_URL.startswith("type.cyrene.io/")
    assert SUBSCRIPTION_FILTER == b'{"event_type":"inbound_message"}'


def test_verified_duplicate_send_receipt_is_returned_without_replay() -> None:
    async def run() -> None:
        client = FakeClient()
        host = FakeHost()
        host.operation = OperationLease(
            "operation-1",
            "verified",
            False,
            {"outcome": "accepted", "vendorMessageId": "vendor-msg-prior"},
        )
        connector = QQConversationConnector(_binding(client), host)

        outcome = await connector.send_reply(
            task_id="task-1", reply_key="completion-prior", text="hello"
        )

        assert outcome.status == "accepted"
        assert outcome.vendor_message_id == "vendor-msg-prior"
        assert not client.invoke_calls

    asyncio.run(run())


def test_status_route_is_workspace_authenticated_and_redacted() -> None:
    host = FakeHost()
    binding = _binding(FakeClient())
    app = FastAPI()

    @dataclass
    class Principal:
        organization_id: str | None

    def principal_for(_request: object, workspace_id: str) -> Principal:
        assert workspace_id == "workspace-1"
        return Principal("org-1")

    mount_conversation_connector_routes(
        app,
        "/api/v1/workspaces/{workspace_id}/work",
        principal_for,
        host,
        [binding],
    )
    with TestClient(app) as client:
        response = client.get("/api/v1/workspaces/workspace-1/work/conversation-connectors/qq")

    assert response.status_code == 200
    body = response.json()
    assert len(body["items"]) == 1
    assert body["items"][0]["bindingId"] == "qq-account-a"
    assert "connectionRef" not in body["items"][0]


def test_status_route_uses_workspace_authenticator_before_reading() -> None:
    app = FastAPI()

    def principal_for(_request: object, _workspace_id: str) -> object:
        raise HTTPException(status_code=403, detail="workspace not authorized")

    mount_conversation_connector_routes(
        app,
        "/api/v1/workspaces/{workspace_id}/work",
        principal_for,
        FakeHost(),
    )
    with TestClient(app) as client:
        response = client.get("/api/v1/workspaces/workspace-1/work/conversation-connectors/qq")
    assert response.status_code == 403


class FakeHost:
    def __init__(self) -> None:
        self.context: VerifiedInboundContext | None = VerifiedInboundContext(
            organization_id="org-1",
            workspace_id="workspace-1",
            actor_id=ACTOR_ID,
            session_id="session-1",
            binding_id="qq-account-a",
            connector_id="qq-v1",
            account_id="qq-account-a",
            conversation_id="group-8",
            conversation_kind=wire.CONVERSATION_KIND_GROUP,
            sender_id="qq-sender-3",
            subscription_id="subscription-1",
        )
        self.resolved_binding_ids: list[str] = []
        self.admission_receipt = AdmissionReceipt("event-1", False, "task-1")
        self.admitted: list[tuple[VerifiedInboundContext, wire.InboundMessagePayload, str]] = []
        self.routes = [_route()]
        self.authorize_calls = 0
        self.begin_calls: list[
            tuple[str, str, str, AuthorizedReplyRoute, wire.SendMessageRequest]
        ] = []
        self.operation = OperationLease("operation-1", "started", True)
        self.finished: list[tuple[OperationLease, str, dict[str, object]]] = []

    async def resolve_inbound_scope(
        self, binding_id: str, event: wire.InboundMessagePayload
    ) -> VerifiedInboundContext | None:
        del event
        self.resolved_binding_ids.append(binding_id)
        return self.context

    async def admit_inbound(
        self,
        context: VerifiedInboundContext,
        event: wire.InboundMessagePayload,
        event_key: str,
    ) -> AdmissionReceipt:
        self.admitted.append((context, event, event_key))
        return self.admission_receipt

    async def authorize_reply(self, task_id: str, binding_id: str) -> AuthorizedReplyRoute | None:
        assert task_id == "task-1"
        assert binding_id == "qq-account-a"
        index = min(self.authorize_calls, len(self.routes) - 1)
        self.authorize_calls += 1
        return self.routes[index]

    async def begin_send_operation(
        self,
        task_id: str,
        binding_id: str,
        reply_key: str,
        route: AuthorizedReplyRoute,
        request: wire.SendMessageRequest,
    ) -> OperationLease:
        self.begin_calls.append((task_id, binding_id, reply_key, route, request))
        return self.operation

    async def finish_send_operation(
        self,
        lease: OperationLease,
        status: str,
        receipt: dict[str, object],
    ) -> None:
        self.finished.append((lease, status, receipt))


class FakeClient:
    def __init__(self) -> None:
        response = wire.DeliveryResult(
            status=wire.DELIVERY_STATUS_ACCEPTED,
            vendor_message_id="vendor-msg-1",
        )
        self.response = DirectPayload(DELIVERY_RESULT_TYPE_URL, encode_delivery_result(response))
        self.invoke_calls: list[DirectPayload] = []
        self.invoke_error: Exception | None = None

    def subscribe(self, **_kwargs: object) -> object:
        return iter(())

    def invoke(self, **kwargs: object) -> DirectPayload:
        request = kwargs["request"]
        assert isinstance(request, DirectPayload)
        self.invoke_calls.append(request)
        if self.invoke_error is not None:
            raise self.invoke_error
        return self.response


class BlockingClient(FakeClient):
    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.cancelled = False

    def invoke(self, **kwargs: object) -> DirectPayload:
        cancel_event = kwargs["cancel_event"]
        assert isinstance(cancel_event, threading.Event)
        self.entered.set()
        cancel_event.wait(2)
        self.cancelled = cancel_event.is_set()
        raise TimeoutError("cancelled after send started")


class StreamingClient(FakeClient):
    def __init__(self) -> None:
        super().__init__()
        self.stream_closed = False

    def subscribe(self, **kwargs: object):
        cancel_event = kwargs["cancel_event"]
        assert isinstance(cancel_event, threading.Event)

        def events():
            try:
                yield _event_payload()
                cancel_event.wait(2)
            finally:
                self.stream_closed = True

        return events()


class BlockingAdmissionHost(FakeHost):
    def __init__(self) -> None:
        super().__init__()
        self.entered = asyncio.Event()
        self.cancelled = False

    async def admit_inbound(
        self,
        context: VerifiedInboundContext,
        event: wire.InboundMessagePayload,
        event_key: str,
    ) -> AdmissionReceipt:
        self.entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return await super().admit_inbound(context, event, event_key)


def _binding(client: FakeClient) -> QQConnectorBinding:
    return QQConnectorBinding(
        binding_id="qq-account-a",
        organization_id="org-1",
        workspace_id="workspace-1",
        account_id="qq-account-a",
        client=client,
    )


def _event_payload() -> DirectPayload:
    event = _make_event()
    return DirectPayload(INBOUND_MESSAGE_TYPE_URL, encode_inbound_message(event), "inbound_message")


def _make_event(*, account_id: str = "qq-account-a") -> wire.InboundMessagePayload:
    event = wire.InboundMessagePayload(message_id="message-1", sender_id="qq-sender-3")
    event.conversation.vendor = "qq"
    event.conversation.account_id = account_id
    event.conversation.conversation_id = "group-8"
    event.conversation.kind = wire.CONVERSATION_KIND_GROUP
    event.content.add().text.text = "hello"
    return event


def _route(*, revision: str = "grant-1") -> AuthorizedReplyRoute:
    conversation = wire.ConversationScope(
        vendor="qq",
        account_id="qq-account-a",
        conversation_id="group-8",
        kind=wire.CONVERSATION_KIND_GROUP,
    )
    return AuthorizedReplyRoute(
        binding_id="qq-account-a",
        authorization_revision=revision,
        conversation=conversation,
        reply_to_message_id="message-1",
    )
