"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 qq.py                                                            │
│  Module: cyrene_navigator.work.conversation_connectors               │
│  Role: Adapt the QQ message.connector.v1 DirectPlugin endpoint.       │
│                                                                      │
│  模块职责：适配 QQ message.connector.v1 DirectPlugin endpoint。        │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, Literal, Protocol, cast

from cyrene_message_connector_contracts import (
    DELIVERY_RESULT_TYPE_URL,
    INBOUND_MESSAGE_TYPE_URL,
    INTERFACE_VERSION,
    SEND_MESSAGE_REQUEST_TYPE_URL,
    MessageConnectorValidationError,
    decode_delivery_result,
    decode_inbound_message,
    encode_send_message_request,
    message_connector_pb2,
)

from .types import (
    AdmissionReceipt,
    AuthorizedReplyRoute,
    ConversationConnectorHostPortV1,
    OperationLease,
    SendOutcome,
    VerifiedInboundContext,
)

CAPABILITY_ID = "message.connector.v1"
CONNECTOR_ID = "qq-v1"
message_wire: Any = message_connector_pb2
QQ_VENDOR = "qq"
INBOUND_EVENT_TYPE = "inbound_message"
SUBSCRIPTION_FILTER_TYPE_URL = "type.cyrene.io/message.connector.v1.SubscriptionFilter"
SUBSCRIPTION_FILTER = b'{"event_type":"inbound_message"}'
DIRECT_CALL_DEADLINE_SECONDS = 30.0
INGRESS_PROCESSING_DEADLINE_SECONDS = 15.0
MAX_TEXT_REPLY_BYTES = 100_000
MAX_INGRESS_ADMISSION_ATTEMPTS = 3
INGRESS_RETRY_DELAY_SECONDS = 0.05


@dataclass(frozen=True, slots=True)
class DirectPayload:
    """Typed request payload passed to the Plugins DirectPlugin client."""

    type_url: str
    value: bytes
    event_type: str = ""


class DirectPluginClientV1(Protocol):
    """Narrow subset of the canonical Python DirectPluginClient API."""

    def subscribe(
        self,
        *,
        capability: str,
        interface_version: str,
        request: Any,
        method: str = "subscribe",
        deadline_seconds: float | None = None,
        cancel_event: threading.Event | None = None,
        request_id: str | None = None,
    ) -> Iterator[Any]:
        """Open a typed capability-owned event subscription."""

        ...

    def invoke(
        self,
        *,
        capability: str,
        interface_version: str,
        method: str,
        request: Any,
        deadline_seconds: float | None = None,
        cancel_event: threading.Event | None = None,
        request_id: str | None = None,
    ) -> Any:
        """Call one message.connector.v1 unary method."""

        ...


@dataclass(frozen=True, slots=True)
class QQConnectorBinding:
    """One server-configured QQ endpoint and its expected account identity.

    中文：服务端配置的 QQ endpoint 及预期账号身份。
    """

    binding_id: str
    organization_id: str | None
    workspace_id: str
    account_id: str
    client: DirectPluginClientV1
    connector_id: str = CONNECTOR_ID


class QQConversationConnector:
    """Subscribe, admit trusted inbound messages, and send authorized replies.

    The client is bound to one configured QQ Plugin endpoint. The connector
    never accepts a model-supplied account or destination. Inbound admission,
    actor mapping, authorization checks, and durable Work Operation receipts
    remain host callbacks.

    中文：订阅 QQ 消息并通过宿主接受任务、授权回复；账号和收件目标都不来自模型。
    """

    def __init__(
        self,
        binding: QQConnectorBinding,
        host: ConversationConnectorHostPortV1,
        *,
        reconnect_min_seconds: float = 0.25,
        reconnect_max_seconds: float = 15.0,
    ) -> None:
        if not binding.binding_id.strip() or not binding.workspace_id.strip():
            raise ValueError("QQ binding_id and workspace_id are required")
        if not binding.account_id.strip():
            raise ValueError("QQ expected account_id is required")
        if binding.connector_id != CONNECTOR_ID:
            raise ValueError("QQ Work connector_id must be qq-v1")
        if reconnect_min_seconds <= 0 or reconnect_max_seconds < reconnect_min_seconds:
            raise ValueError("QQ subscription retry backoff is invalid")
        self.binding = binding
        self._host = host
        self._min_backoff = reconnect_min_seconds
        self._max_backoff = reconnect_max_seconds
        self._stop = threading.Event()
        self._active_cancel: threading.Event | None = None
        self._active_event_future: concurrent.futures.Future[AdmissionReceipt | None] | None = None
        self._lock = threading.Lock()
        self._task: asyncio.Task[None] | None = None
        self._status: Literal["stopped", "connecting", "connected", "degraded"] = "stopped"
        self._last_error: str | None = None
        self._last_event_at: int | None = None
        self._accepted_events = 0
        self._rejected_events = 0

    @property
    def status(self) -> dict[str, object]:
        """Return a redacted runtime status snapshot for an authenticated route."""

        with self._lock:
            return {
                "bindingId": self.binding.binding_id,
                "accountId": self.binding.account_id,
                "status": self._status,
                "lastError": self._last_error,
                "lastEventAt": self._last_event_at,
                "acceptedEvents": self._accepted_events,
                "rejectedEvents": self._rejected_events,
            }

    async def start(self) -> None:
        """Start one long-lived connector subscription task."""

        if self._task is not None and not self._task.done():
            return
        self._stop.clear()
        task_name = f"qq-{self.binding.binding_id}"
        self._task = asyncio.create_task(self._run_subscription(), name=task_name)

    async def close(self) -> None:
        """Cancel the subscription and wait for provider-side unsubscribe."""

        self._stop.set()
        with self._lock:
            active_cancel = self._active_cancel
            active_event_future = self._active_event_future
        if active_cancel is not None:
            active_cancel.set()
        if active_event_future is not None:
            active_event_future.cancel()
        if self._task is not None:
            await asyncio.shield(self._task)
            self._task = None
        with self._lock:
            self._status = "stopped"

    async def process_payload(self, payload: DirectPayload) -> AdmissionReceipt | None:
        """Validate one real typed event and submit it through host authority.

        Returns ``None`` for well-formed non-message events or messages with
        no trusted actor/scope mapping. Invalid payloads raise validation errors.
        中文：校验一条类型化事件并交给宿主权限路径；未授权消息不会创建任务。
        """

        if payload.event_type != INBOUND_EVENT_TYPE:
            return None
        if payload.type_url != INBOUND_MESSAGE_TYPE_URL:
            raise MessageConnectorValidationError("inbound_message event type URL is invalid")
        event = decode_inbound_message(payload.value)
        if event.conversation.vendor != QQ_VENDOR:
            raise MessageConnectorValidationError("QQ binding received a non-QQ vendor event")
        if event.conversation.account_id != self.binding.account_id:
            raise MessageConnectorValidationError("QQ event account does not match its binding")
        context = await self._host.resolve_inbound_scope(self.binding.binding_id, event)
        if context is None:
            self._increment_rejected()
            return None
        _validate_verified_context(self.binding, event, context)
        event_key = _event_key(self.binding.account_id, event)
        receipt = await self._admit_inbound_with_retry(context, event, event_key)
        if not receipt.event_id.strip() or not receipt.task_id.strip():
            raise MessageConnectorValidationError(
                "host acknowledged QQ ingress without a durable Work event and DSH task"
            )
        with self._lock:
            self._accepted_events += 1
            self._last_event_at = int(time.time() * 1000)
        return receipt

    async def _admit_inbound_with_retry(
        self,
        context: VerifiedInboundContext,
        event: message_wire.InboundMessagePayload,
        event_key: str,
    ) -> AdmissionReceipt:
        """Retry an idempotent host admission a small fixed number of times."""

        for attempt in range(MAX_INGRESS_ADMISSION_ATTEMPTS):
            try:
                return await self._host.admit_inbound(context, event, event_key)
            except asyncio.CancelledError:
                raise
            except Exception:
                if attempt + 1 == MAX_INGRESS_ADMISSION_ATTEMPTS:
                    raise
                await asyncio.sleep(INGRESS_RETRY_DELAY_SECONDS * (attempt + 1))
        raise AssertionError("unreachable")

    async def send_reply(
        self,
        *,
        task_id: str,
        reply_key: str,
        text: str,
    ) -> SendOutcome:
        """Send one task reply after current source/persona authorization.

        ``reply_key`` is a host-created stable completion key. A duplicate Work
        Operation is read back and never resent, including ``started`` or
        ``uncertain`` records left by cancellation or process loss.

        中文：使用宿主生成的完成键发送回复；重复或不确定操作不会重发。
        """

        if not task_id.strip() or not reply_key.strip():
            raise ValueError("task_id and host reply_key are required")
        if not text.strip() or len(text.encode("utf-8")) > MAX_TEXT_REPLY_BYTES:
            raise ValueError("QQ reply text must be non-empty and at most 100000 UTF-8 bytes")
        route = await self._host.authorize_reply(task_id, self.binding.binding_id)
        if route is None:
            return SendOutcome(
                "authorization_denied",
                reason="reply source is no longer authorized",
            )
        _validate_reply_route(self.binding, route)
        request = _send_request(route, text)
        request_payload = encode_send_message_request(request)
        operation = await self._host.begin_send_operation(
            task_id,
            self.binding.binding_id,
            reply_key,
            route,
            request,
        )
        if not operation.created:
            if operation.status == "uncertain":
                return SendOutcome(
                    "uncertain",
                    operation_id=operation.operation_id,
                    reason="existing Work Operation is uncertain and requires reconciliation",
                )
            if operation.status == "verified" and operation.receipt is not None:
                return _recorded_outcome(operation)
            return SendOutcome(
                "already_recorded",
                operation_id=operation.operation_id,
                reason=f"existing Work Operation is {operation.status}; it will not be replayed",
            )
        if operation.status != "started":
            return SendOutcome(
                "already_recorded",
                operation_id=operation.operation_id,
                reason=f"new Work Operation has unexpected status {operation.status}",
            )

        try:
            current = await self._host.authorize_reply(task_id, self.binding.binding_id)
        except asyncio.CancelledError:
            await _finish_shielded(
                self._host,
                operation,
                "verified",
                {"outcome": "cancelled_before_send", "sent": False},
            )
            raise
        if current is None or not _same_authorized_route(route, current):
            receipt = {"outcome": "authorization_denied", "sent": False}
            await self._host.finish_send_operation(operation, "verified", receipt)
            return SendOutcome(
                "authorization_denied",
                operation_id=operation.operation_id,
                reason="reply authorization changed before connector invocation",
            )

        cancel_event = threading.Event()
        request_id = _operation_request_id(operation.operation_id)
        invocation = asyncio.create_task(
            asyncio.to_thread(
                self.binding.client.invoke,
                capability=CAPABILITY_ID,
                interface_version=str(INTERFACE_VERSION),
                method="send_message",
                request=DirectPayload(SEND_MESSAGE_REQUEST_TYPE_URL, request_payload),
                deadline_seconds=DIRECT_CALL_DEADLINE_SECONDS,
                cancel_event=cancel_event,
                request_id=request_id,
            )
        )
        try:
            result_payload = await asyncio.shield(invocation)
            if result_payload.type_url != DELIVERY_RESULT_TYPE_URL:
                raise MessageConnectorValidationError("QQ send response type URL is invalid")
            result = decode_delivery_result(result_payload.value)
        except asyncio.CancelledError:
            cancel_event.set()
            with suppress(Exception):
                await asyncio.shield(invocation)
            await _finish_shielded(
                self._host,
                operation,
                "uncertain",
                {"outcome": "cancelled_during_send", "sent": "unknown"},
            )
            raise
        except Exception as error:
            await self._host.finish_send_operation(
                operation,
                "uncertain",
                {
                    "outcome": "connector_result_unknown",
                    "errorType": type(error).__name__,
                    "sent": "unknown",
                },
            )
            return SendOutcome(
                "uncertain",
                operation_id=operation.operation_id,
                reason="QQ send result is unknown; no retry was issued",
            )

        outcome = _delivery_outcome(result)
        await self._host.finish_send_operation(
            operation,
            "verified",
            {
                "outcome": outcome.status,
                "vendorMessageId": result.vendor_message_id,
                "reason": result.reason,
                "acceptedByVendor": result.status == message_wire.DELIVERY_STATUS_ACCEPTED,
            },
        )
        return SendOutcome(
            outcome.status,
            operation_id=operation.operation_id,
            vendor_message_id=result.vendor_message_id or None,
            reason=result.reason or None,
        )

    async def _run_subscription(self) -> None:
        loop = asyncio.get_running_loop()
        backoff = self._min_backoff
        while not self._stop.is_set():
            self._set_status("connecting", None)
            cancel_event = threading.Event()
            with self._lock:
                self._active_cancel = cancel_event
            try:
                await asyncio.to_thread(self._consume_subscription, loop, cancel_event)
                backoff = self._min_backoff
                if not self._stop.is_set():
                    self._set_status("degraded", "QQ subscription ended; reconnecting")
            except asyncio.CancelledError:
                cancel_event.set()
                raise
            except Exception as error:
                detail = getattr(error, "domain_code", None)
                self._set_status(
                    "degraded",
                    detail if isinstance(detail, str) and detail else type(error).__name__,
                )
            finally:
                cancel_event.set()
                with self._lock:
                    self._active_cancel = None
                    self._active_event_future = None
            if not self._stop.is_set():
                await asyncio.to_thread(self._stop.wait, backoff)
                backoff = min(self._max_backoff, max(self._min_backoff, backoff * 2))
        self._set_status("stopped", None)

    def _consume_subscription(
        self,
        loop: asyncio.AbstractEventLoop,
        cancel_event: threading.Event,
    ) -> None:
        request = DirectPayload(SUBSCRIPTION_FILTER_TYPE_URL, SUBSCRIPTION_FILTER)
        stream = self.binding.client.subscribe(
            capability=CAPABILITY_ID,
            interface_version=str(INTERFACE_VERSION),
            request=request,
            deadline_seconds=None,
            cancel_event=cancel_event,
            request_id=f"qq-sub-{uuid.uuid4()}",
        )
        if not hasattr(stream, "__iter__"):
            raise TypeError("DirectPluginClient.subscribe must return an iterator")
        self._set_status("connected", None)
        try:
            for payload in stream:
                if cancel_event.is_set() or self._stop.is_set():
                    return
                if not isinstance(payload, DirectPayload):
                    payload = DirectPayload(
                        str(getattr(payload, "type_url", "")),
                        bytes(getattr(payload, "value", b"")),
                        str(getattr(payload, "event_type", "")),
                    )
                future = asyncio.run_coroutine_threadsafe(self.process_payload(payload), loop)
                with self._lock:
                    self._active_event_future = future
                try:
                    future.result(timeout=INGRESS_PROCESSING_DEADLINE_SECONDS)
                except concurrent.futures.CancelledError:
                    if cancel_event.is_set() or self._stop.is_set():
                        return
                    raise
                except concurrent.futures.TimeoutError as error:
                    future.cancel()
                    raise TimeoutError("QQ inbound Work admission exceeded its deadline") from error
                except MessageConnectorValidationError:
                    self._increment_rejected()
                finally:
                    with self._lock:
                        if self._active_event_future is future:
                            self._active_event_future = None
        finally:
            close = getattr(stream, "close", None)
            if callable(close):
                close()

    def _set_status(
        self,
        status: Literal["stopped", "connecting", "connected", "degraded"],
        error: str | None,
    ) -> None:
        with self._lock:
            self._status = status
            self._last_error = error

    def _increment_rejected(self) -> None:
        with self._lock:
            self._rejected_events += 1


def _validate_verified_context(
    binding: QQConnectorBinding,
    event: message_wire.InboundMessagePayload,
    context: VerifiedInboundContext,
) -> None:
    if (
        context.organization_id != binding.organization_id
        or context.binding_id != binding.binding_id
        or context.connector_id != binding.connector_id
        or context.workspace_id != binding.workspace_id
        or context.account_id != binding.account_id
        or context.conversation_id != event.conversation.conversation_id
        or context.conversation_kind != event.conversation.kind
        or context.sender_id != event.sender_id
        or not context.subscription_id.strip()
        or not context.session_id.strip()
    ):
        raise MessageConnectorValidationError("host returned a mismatched QQ actor/scope mapping")
    try:
        uuid.UUID(context.actor_id)
    except (ValueError, AttributeError) as error:
        raise MessageConnectorValidationError("host returned a non-UUID DSH actor id") from error


def _validate_reply_route(binding: QQConnectorBinding, route: AuthorizedReplyRoute) -> None:
    if route.binding_id != binding.binding_id or not route.authorization_revision.strip():
        raise MessageConnectorValidationError(
            "host returned a mismatched or unversioned reply route"
        )
    if (
        route.conversation.vendor != QQ_VENDOR
        or route.conversation.account_id != binding.account_id
        or not route.conversation.conversation_id
        or route.conversation.kind
        not in {
            message_wire.CONVERSATION_KIND_PRIVATE,
            message_wire.CONVERSATION_KIND_GROUP,
            message_wire.CONVERSATION_KIND_CHANNEL,
        }
        or not route.reply_to_message_id.strip()
    ):
        raise MessageConnectorValidationError("host returned an invalid QQ reply destination")


def _same_authorized_route(
    original: AuthorizedReplyRoute,
    current: AuthorizedReplyRoute,
) -> bool:
    return (
        current.binding_id == original.binding_id
        and current.authorization_revision == original.authorization_revision
        and current.reply_to_message_id == original.reply_to_message_id
        and current.conversation == original.conversation
    )


def _send_request(route: AuthorizedReplyRoute, text: str) -> message_wire.SendMessageRequest:
    request = message_wire.SendMessageRequest()
    request.conversation.CopyFrom(route.conversation)
    request.content.add().text.text = text
    request.reply.message_id = route.reply_to_message_id
    return request


def _event_key(account_id: str, event: message_wire.InboundMessagePayload) -> str:
    material = "\0".join(
        (
            "message.connector.v1",
            QQ_VENDOR,
            account_id,
            str(int(event.conversation.kind)),
            event.conversation.conversation_id,
            event.message_id,
        )
    ).encode()
    return "qq-event-" + hashlib.sha256(material).hexdigest()


def _operation_request_id(operation_id: str) -> str:
    return "qq-send-" + hashlib.sha256(operation_id.encode("utf-8")).hexdigest()


def _delivery_outcome(result: message_wire.DeliveryResult) -> SendOutcome:
    if result.status == message_wire.DELIVERY_STATUS_ACCEPTED:
        return SendOutcome("accepted", vendor_message_id=result.vendor_message_id or None)
    if result.status == message_wire.DELIVERY_STATUS_REJECTED:
        return SendOutcome("rejected", reason=result.reason or None)
    if result.status == message_wire.DELIVERY_STATUS_RATE_LIMITED:
        return SendOutcome("rate_limited", reason=result.reason or None)
    raise MessageConnectorValidationError("QQ send result has an unspecified delivery status")


def _recorded_outcome(lease: OperationLease) -> SendOutcome:
    """Map a durable verified receipt without invoking the connector again."""

    assert lease.receipt is not None
    outcome = lease.receipt.get("outcome")
    if outcome not in {"accepted", "rejected", "rate_limited", "authorization_denied"}:
        return SendOutcome(
            "already_recorded",
            operation_id=lease.operation_id,
            reason="verified Work Operation has no recognized send outcome",
        )
    return SendOutcome(
        cast(
            Literal["accepted", "rejected", "rate_limited", "authorization_denied"],
            outcome,
        ),
        operation_id=lease.operation_id,
        vendor_message_id=(
            str(lease.receipt["vendorMessageId"]) if lease.receipt.get("vendorMessageId") else None
        ),
        reason=str(lease.receipt["reason"]) if lease.receipt.get("reason") else None,
    )


async def _finish_shielded(
    host: ConversationConnectorHostPortV1,
    lease: OperationLease,
    status: Literal["uncertain", "verified"],
    receipt: dict[str, object],
) -> None:
    update = asyncio.create_task(host.finish_send_operation(lease, status, receipt))
    try:
        await asyncio.shield(update)
    except asyncio.CancelledError:
        await update
