"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 test_qq_direct_plugin_process.py                                 │
│  Module: cyrene_navigator.work.conversation_connectors               │
│  Role: Exercise the adapter through a QQ DirectPlugin process.        │
│                                                                      │
│  模块职责：通过 QQ DirectPlugin 进程验收适配器链路。                  │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import asyncio
import json
import os
import selectors
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from cyrene_message_connector_contracts import message_connector_pb2 as wire

from cyrene_navigator.work.conversation_connectors.qq import (
    QQConnectorBinding,
    QQConversationConnector,
)
from cyrene_navigator.work.conversation_connectors.types import (
    AdmissionReceipt,
    AuthorizedReplyRoute,
    OperationLease,
    VerifiedInboundContext,
)

ACTOR_ID = "9f470dc4-7919-4881-a194-85dfb75f292a"


def test_qq_plugin_direct_runtime_process_with_fixture_host(tmp_path: Path) -> None:
    """Run the existing QQ reference plugin over gRPC with its fixture QQ Host.

    This is explicitly simulated evidence: it exercises Navigator adapter,
    DirectPluginRuntime, QQ connector code, and the QQ fixture host process. It
    does not prove a real QQ account login or platform delivery/readback.
    中文：这是模拟验收，不代表真实 QQ 账号或平台投递验收。
    """

    qq_source = os.environ.get("CYRENE_QQ_PLUGIN_SOURCE_ROOT")
    runtime_source = os.environ.get("CYRENE_PLUGIN_RUNTIME_SOURCE_ROOT")
    contracts_source = os.environ.get("CYRENE_MESSAGE_CONNECTOR_SDK_SOURCE")
    if not all((qq_source, runtime_source, contracts_source)):
        pytest.skip("QQ plugin/runtime/contract source paths are not configured")

    plugin_root = Path(qq_source).resolve(strict=True)
    runtime_root = Path(runtime_source).resolve(strict=True)
    contracts_root = Path(contracts_source).resolve(strict=True)
    im_source = plugin_root / "plugins/connectors/im/src"
    fake_host = plugin_root / "plugins/connectors/im/tests/fixtures/fake_qq_host.py"
    operation_log = tmp_path / "qq-host-operations.log"
    if not fake_host.is_file() or not (im_source / "qq_connector/plugin.py").is_file():
        pytest.skip("configured Plugins source does not contain the QQ reference plugin")

    config = {
        "runtime_profile": "qqnt-direct",
        "binding_id": "qq-native-test",
        "host_executable": sys.executable,
        "host_args": [
            "-B",
            str(fake_host),
            "--mode=normal",
            f"--operation-log={operation_log}",
        ],
        "data_dir": str(tmp_path / "qq-state"),
        "required_client_version": "qq-test-1",
        "required_host_abi": "fake-qqnt-linux-x86_64",
        "account_id": "10001",
        "dedicated_account_confirmed": True,
        "timeout_seconds": 1.0,
        "secret_refs": ["secret://test/qq-password"],
    }
    config_path = tmp_path / "plugin-config.json"
    config_path.write_text(json.dumps(config), encoding="utf-8")
    entrypoint = tmp_path / "qq_plugin_entrypoint.py"
    entrypoint.write_text(
        "import json, os\n"
        "from qq_connector.plugin import ConnectorPlugin\n"
        "class FixtureConnectorPlugin(ConnectorPlugin):\n"
        "    def __init__(self):\n"
        "        with open(os.environ['CYRENE_QQ_TEST_CONFIG'], encoding='utf-8') as stream:\n"
        "            config = json.load(stream)\n"
        "        super().__init__(config=config)\n",
        encoding="utf-8",
    )

    python_paths = [
        str(tmp_path),
        str(runtime_root / "src"),
        str(contracts_root / "src"),
        str(im_source),
    ]
    environment = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(python_paths),
        "PYTHONUNBUFFERED": "1",
        "CYRENE_QQ_TEST_CONFIG": str(config_path),
    }
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "cyrene_plugin_runtime.server",
            "--entrypoint",
            "qq_plugin_entrypoint:FixtureConnectorPlugin",
            "--capability",
            "message.connector.v1",
            "--interface-version",
            "1",
            "--listen",
            "127.0.0.1:0",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=environment,
    )
    client: Any | None = None
    connector: QQConversationConnector | None = None
    try:
        ready = _read_ready_record(process, timeout_seconds=15)
        from cyrene_plugin_runtime.client import DirectPluginClient

        client = ObservedDirectPluginClient(
            DirectPluginClient.for_local_connection_ref(ready["connection_ref"])
        )
        binding = QQConnectorBinding(
            binding_id="qq-native-test",
            organization_id="org-1",
            workspace_id="workspace-1",
            account_id="10001",
            client=client,
        )
        host = SimulatedWorkHost()
        connector = QQConversationConnector(binding, host)

        async def exercise() -> None:
            await connector.start()
            try:
                deadline = asyncio.get_running_loop().time() + 8
                while not host.admitted and asyncio.get_running_loop().time() < deadline:
                    await asyncio.sleep(0.02)
                operation_log_text = (
                    operation_log.read_text(encoding="utf-8")
                    if operation_log.exists()
                    else "none"
                )
                assert host.admitted, (
                    "QQ fixture event did not reach Work admission: "
                    f"{connector.status}; operations="
                    f"{operation_log_text}; "
                    f"error={client.last_subscription_error}"
                )
                assert host.admitted[0][1].content[0].text.text == "hello from qq"
                outcome = await connector.send_reply(
                    task_id="fixture-task-1",
                    reply_key="fixture-completion-1",
                    text="response from DSH",
                )
                assert outcome.status == "accepted"
                assert outcome.vendor_message_id == "qq-native-test-1-message-1"
            finally:
                await connector.close()

        asyncio.run(exercise())
        assert process.poll() is None
        assert host.finished[0][1] == "verified"
    finally:
        if client is not None:
            client.close()
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def _read_ready_record(process: subprocess.Popen[str], timeout_seconds: float) -> dict[str, str]:
    if process.stdout is None:
        raise AssertionError("QQ DirectPlugin process has no stdout pipe")
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        if not selector.select(timeout_seconds):
            error_output = process.stderr.read() if process.stderr is not None else ""
            raise AssertionError(f"QQ DirectPlugin did not become ready: {error_output}")
        line = process.stdout.readline()
    finally:
        selector.close()
    value = json.loads(line)
    if value.get("event") != "direct_plugin_ready" or not value.get("connection_ref"):
        raise AssertionError("QQ DirectPlugin emitted an invalid readiness record")
    return value


class SimulatedWorkHost:
    """Host-only mapping/admission and Work Operation fixture for this test."""

    def __init__(self) -> None:
        self.admitted: list[tuple[VerifiedInboundContext, wire.InboundMessagePayload, str]] = []
        self.finished: list[tuple[OperationLease, str, dict[str, object]]] = []
        self._route = AuthorizedReplyRoute(
            binding_id="qq-native-test",
            authorization_revision="fixture-grant-v1",
            conversation=wire.ConversationScope(
                vendor="qq",
                account_id="10001",
                conversation_id="20001",
                kind=wire.CONVERSATION_KIND_GROUP,
            ),
            reply_to_message_id="native-message-1",
        )

    async def resolve_inbound_scope(
        self, binding_id: str, event: wire.InboundMessagePayload
    ) -> VerifiedInboundContext | None:
        return VerifiedInboundContext(
            organization_id="org-1",
            workspace_id="workspace-1",
            actor_id=ACTOR_ID,
            session_id="fixture-session-1",
            binding_id=binding_id,
            connector_id="qq-v1",
            account_id=event.conversation.account_id,
            conversation_id=event.conversation.conversation_id,
            conversation_kind=event.conversation.kind,
            sender_id=event.sender_id,
            subscription_id="fixture-subscription-1",
        )

    async def admit_inbound(
        self,
        context: VerifiedInboundContext,
        event: wire.InboundMessagePayload,
        event_key: str,
    ) -> AdmissionReceipt:
        self.admitted.append((context, event, event_key))
        return AdmissionReceipt("fixture-event-1", False, "fixture-task-1")

    async def authorize_reply(
        self, task_id: str, binding_id: str
    ) -> AuthorizedReplyRoute | None:
        if task_id != "fixture-task-1" or binding_id != "qq-native-test":
            return None
        return self._route

    async def begin_send_operation(
        self,
        task_id: str,
        binding_id: str,
        reply_key: str,
        route: AuthorizedReplyRoute,
        request: wire.SendMessageRequest,
    ) -> OperationLease:
        del task_id, binding_id, reply_key, route, request
        return OperationLease("fixture-operation-1", "started", True)

    async def finish_send_operation(
        self,
        lease: OperationLease,
        status: str,
        receipt: dict[str, object],
    ) -> None:
        self.finished.append((lease, status, receipt))


class ObservedDirectPluginClient:
    """Capture the direct failure in the test without exposing it in status API."""

    def __init__(self, client: Any) -> None:
        self._client = client
        self.last_subscription_error: str | None = None

    def subscribe(self, **kwargs: Any):
        try:
            yield from self._client.subscribe(**kwargs)
        except Exception as error:
            self.last_subscription_error = f"{type(error).__name__}: {error}"
            raise

    def invoke(self, **kwargs: Any) -> Any:
        return self._client.invoke(**kwargs)

    def close(self) -> None:
        self._client.close()
