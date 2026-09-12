"""Completed text selection and source authority regressions. | 完成文本选择回归。"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from cyrene_navigator.persistence.echo_handoff import EchoHandoff, SendToEcho, text_snapshot
from cyrene_navigator.persistence.errors import PersistenceError


def events():
    values = [
        ("turn/start", {"turn": 1}),
        ("user/message", {"content": [{"type": "text", "text": "Hello"}]}),
        (
            "assistant/message",
            {
                "turn": 1,
                "message": {
                    "source": {
                        "model": "route-alias",
                        "replayState": {"private": "retained only in DSH"},
                    },
                    "content": [
                        {"type": "text", "text": "Hi"},
                        {"type": "tool-call", "arguments": "excluded"},
                    ],
                },
            },
        ),
        ("turn/end", {"turn": 1, "reason": {"kind": "completed"}}),
        ("turn/start", {"turn": 1}),
        ("user/message", {"content": [{"type": "text", "text": "Second"}]}),
        (
            "assistant/message",
            {"turn": 1, "message": {"content": [{"type": "text", "text": "Partial"}]}},
        ),
    ]
    return [
        {"seq": index, "time": index, "type": kind, "data": value}
        for index, (kind, value) in enumerate(values)
    ]


def test_completed_prefix_does_not_accept_a_later_unfinished_turn_with_reused_number():
    original = events()
    rows = text_snapshot(
        original, "cyrene://navigator/sessions/unit", SendToEcho(expected_revision="unit")
    )
    assert [row["output"] for row in rows] == ["Hi"]
    assert rows[0]["modelMetadata"] == {"model": "route-alias"}
    assert "replayState" not in str(rows) and "tool-call" not in str(rows)
    assert original == events()
    with pytest.raises(PersistenceError) as failure:
        text_snapshot(
            original,
            "cyrene://navigator/sessions/unit",
            SendToEcho(expected_revision="unit", selected_event_seqs=[6]),
        )
    assert failure.value.status == 422


def test_reference_selection_rejects_paths_and_malformed_text():
    with pytest.raises(ValueError):
        SendToEcho(expected_revision="unit", provenance_refs=["local/output/model"])
    malformed = events()
    malformed[2]["data"]["message"]["content"] = None
    with pytest.raises(PersistenceError):
        text_snapshot(
            malformed, "cyrene://navigator/sessions/unit", SendToEcho(expected_revision="unit")
        )


def test_echo_handoff_publishes_navigator_owned_artifact_and_calls_echo(tmp_path: Path):
    captured: dict[str, object] = {}

    class Store:
        def get_snapshot(self, workspace_id: str, session_id: str):
            assert (workspace_id, session_id) == ("workspace", "session")
            return {"revision": "expected", "eventCount": len(events())}

        def read_events(self, workspace_id: str, session_id: str, offset: int, limit: int):
            values = events()[offset : offset + limit]
            return values, offset + len(values)

    def echo(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(
            201,
            json={
                "resourceRef": {
                    "uri": "cyrene://echo/evaluation-inputs/input-1",
                    "id": "input-1",
                    "resourceVersion": 1,
                },
                "state": "DRAFT",
            },
        )

    with httpx.Client(transport=httpx.MockTransport(echo)) as client:
        receipt = EchoHandoff(Store(), tmp_path / "artifacts", "https://echo.example", client).send(
            "workspace", "session", SendToEcho(expected_revision="expected")
        )

    artifact = captured["artifact"]
    assert isinstance(artifact, dict)
    assert artifact["kind"] == "navigator-text-jsonl-v1"
    assert artifact["uri"] == "artifact://sha256/" + artifact["digest"].removeprefix("sha256:")
    assert receipt.status == "DRAFT"
