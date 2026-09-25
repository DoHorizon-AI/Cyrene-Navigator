"""
┌─────────────────────────────────────────────────────────────────────┐
│ Module: cyrene_navigator.persistence.echo_handoff                   │
│ Role: Export selected committed text through Artifact references.  │
│ 模块职责：从 DSH 权威日志导出显式选择的文本快照，创建 Echo 评估草稿。    │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

import httpx
from pydantic import Field, field_validator, model_validator

from cyrene_navigator.persistence.artifacts import ArtifactPublicationError, LocalArtifactStore
from cyrene_navigator.persistence.errors import PersistenceError
from cyrene_navigator.persistence.models import PersistenceModel
from cyrene_navigator.persistence.store import PersistenceStore


class SendToEcho(PersistenceModel):
    """Explicit selection at a read-back revision; external lineage is optional.

    中文：在回读到的 revision 上显式选择；外部血缘信息为可选。
    """
# 中文：基于读回 revision 的显式选择；外部沿袭信息可选。

    expected_revision: str = Field(min_length=1)
    selected_event_seqs: list[int] | None = Field(default=None, min_length=1, max_length=2000)
    provenance_refs: list[str] = Field(default_factory=list, max_length=100)

    @field_validator("selected_event_seqs")
    @classmethod
    def valid_selection(cls, values: list[int] | None) -> list[int] | None:
        if values is not None and (
            any(item < 0 for item in values) or len(values) != len(set(values))
        ):
            raise ValueError("Select distinct nonnegative event sequences")
        return values

    @field_validator("provenance_refs")
    @classmethod
    def resource_references(cls, values: list[str]) -> list[str]:
        if any(
            not item.startswith(("cyrene://", "artifact://", "model-version://", "https://"))
            or len(item) > 2000
            or any(c.isspace() for c in item)
            for item in values
        ):
            raise ValueError("Lineage must use Product or Artifact resource references")
        return values


class TargetResource(PersistenceModel):
    """Identity returned by Echo, with no imported evaluation authority.

    中文：Echo 返回的身份，不导入评估权威。
    """
# 中文：Echo 返回的身份信息，不导入评估权威。

    uri: str = Field(pattern=r"^cyrene://echo/evaluation-inputs/")
    id: str
    resource_version: int = Field(ge=1)

    @model_validator(mode="after")
    def matches_identity(self) -> TargetResource:
        """Require Echo's URI and id to name the same evaluation input.

        中文：确保 Echo 返回的 URI 与 ID 指向同一个评估输入。
        """
    # 中文：要求 Echo URI 和 ID 指向同一个评估输入。

        if self.uri != f"cyrene://echo/evaluation-inputs/{self.id}":
            raise ValueError("Echo target URI does not match its resource id")
        return self


class EchoReceipt(PersistenceModel):
    target_resource: TargetResource
    status: Literal["DRAFT", "STARTED"]
    open_in: str


def _error(code: str, detail: str, status: int = 422) -> PersistenceError:
    return PersistenceError(code, status, detail, retryable=status >= 500)


def _text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if not isinstance(content, list):
        return ""
    return "".join(
        block["text"]
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    )


def text_snapshot(
    events: list[dict[str, Any]], source_uri: str, command: SendToEcho
) -> list[dict[str, Any]]:
    """Project only text and whitelisted metadata; tools and raw replay state stay in DSH.

    中文：仅投影文本与白名单元数据；工具和原始 replay 状态仍归 DSH 所有。
    """
# 中文：只投影文本和白名单元数据；工具及原始重放状态保留在 DSH 中。
    completed: set[int] = set()
    pending: dict[int, list[int]] = {}
    for event in events:
        data = event.get("data")
        if not isinstance(data, dict) or type(data.get("turn")) is not int:
            continue
        turn = data["turn"]
        if event["type"] == "turn/start":
            pending[turn] = []
        elif event["type"] == "assistant/message":
            pending.setdefault(turn, []).append(event["seq"])
        elif event["type"] == "turn/end":
            members = pending.pop(turn, [])
            if isinstance(data.get("reason"), dict) and data["reason"].get("kind") == "completed":
                completed.update(members)
    selected = set(command.selected_event_seqs) if command.selected_event_seqs else None
    valid = set()
    prompt = ""
    prompt_ref = ""
    rows: list[dict[str, Any]] = []
    for event in events:
        data = event.get("data")
        if not isinstance(data, dict):
            continue
        content_ref = source_uri + "/events/" + str(event["seq"])
        if event["type"] == "user/message":
            prompt, prompt_ref = _text(data), content_ref
            if prompt:
                valid.add(event["seq"])
        if event["type"] != "assistant/message" or event["seq"] not in completed:
            continue
        message = data.get("message")
        if not isinstance(message, dict):
            continue
        output = _text(message)
        if not prompt or not output:
            continue
        valid.add(event["seq"])
        if selected is not None and event["seq"] not in selected:
            continue
        source = message.get("source", {})
        metadata = {
            key: source[key]
            for key in ("provider", "model", "requestId")
            if isinstance(source, dict) and isinstance(source.get(key), str)
        }
        row: dict[str, Any] = {
            "instruction": prompt,
            "input": "",
            "output": output,
            "sourceRef": source_uri,
            "contentRefs": [prompt_ref, content_ref],
            "modelMetadataRef": content_ref + "#/data/message/source",
            "modelMetadata": metadata,
            "provenanceRefs": command.provenance_refs,
        }
        if "model" in metadata:
            row["model"] = metadata["model"]
        if isinstance(data.get("usage"), dict):
            row["usageRef"] = content_ref + "#/data/usage"
            row["usage"] = {
                key: value
                for key, value in data["usage"].items()
                if key
                in {
                    "inputTokens",
                    "outputTokens",
                    "totalTokens",
                    "promptTokens",
                    "completionTokens",
                    "input_tokens",
                    "output_tokens",
                    "total_tokens",
                    "prompt_tokens",
                    "completion_tokens",
                }
                and type(value) is int
                and value >= 0
            }
        rows.append(row)
    if selected is not None and not selected.issubset(valid):
        raise _error(
            "NAVIGATOR_ECHO_SELECTION_INVALID",
            "Select committed text messages from completed turns.",
        )
    if not rows or len(rows) > 1000:
        raise _error(
            "NAVIGATOR_ECHO_SELECTION_INVALID",
            "Select between one and 1000 completed text outputs.",
        )
    return rows


class EchoHandoff:
    """Snapshot transport over the existing session store, never a second history store.

    中文：通过现有 session store 传输 snapshot，不另建历史存储。
    """
# 中文：通过现有 Session store 传输快照，绝不创建第二份历史存储。

    def __init__(
        self,
        store: PersistenceStore,
        artifact_root: Path | None,
        echo_url: str | None,
        client: httpx.Client | None = None,
    ) -> None:
        self.store = store
        self.artifacts = LocalArtifactStore(artifact_root) if artifact_root else None
        self.echo_url = echo_url.rstrip("/") if echo_url else None
        self.client = client or httpx.Client(timeout=30, trust_env=False)

    def send(self, workspace_id: str, session_id: str, command: SendToEcho) -> EchoReceipt:
        if self.echo_url is None or self.artifacts is None:
            raise _error(
                "NAVIGATOR_ECHO_NOT_CONNECTED",
                "Configure Echo and the shared Artifact provider.",
                503,
            )
        snapshot = self.store.get_snapshot(workspace_id, session_id)
        if snapshot["revision"] != command.expected_revision:
            raise _error(
                "NAVIGATOR_SESSION_CHANGED", "Reload the session before selecting content.", 409
            )
        count = int(snapshot["eventCount"])
        if count > 100_000:
            raise _error(
                "NAVIGATOR_ECHO_SNAPSHOT_TOO_LARGE",
                "This V1 export supports at most 100000 session events.",
            )
        events: list[dict[str, Any]] = []
        for offset in range(0, count, 10_000):
            page, _next_seq = self.store.read_events(
                workspace_id, session_id, offset, min(10_000, count - offset)
            )
            events.extend(page)
        if (
            self.store.get_snapshot(workspace_id, session_id)["revision"]
            != command.expected_revision
        ):
            raise _error(
                "NAVIGATOR_SESSION_CHANGED",
                "The session changed while the snapshot was being prepared.",
                409,
            )
        source = (
            "cyrene://navigator/workspaces/"
            + quote(workspace_id, safe="")
            + "/sessions/"
            + quote(session_id, safe="")
        )
        rows = text_snapshot(events, source, command)
        payload = (
            "\n".join(json.dumps(row, sort_keys=True, ensure_ascii=False) for row in rows) + "\n"
        ).encode()
        if len(payload) > 16 * 1024**2:
            raise _error(
                "NAVIGATOR_ECHO_SNAPSHOT_TOO_LARGE", "Select text output totaling at most 16 MiB."
            )
        try:
            artifact = self.artifacts.publish_bytes(payload, kind="navigator-text-jsonl-v1")
            body = {
                "sourceRef": {"uri": source, "id": session_id, "resourceVersion": max(1, count)},
                "artifact": artifact.to_dict(),
                "format": "NAVIGATOR_TEXT_JSONL_V1",
                "contentRefs": list(
                    dict.fromkeys(ref for row in rows for ref in row["contentRefs"])
                ),
                "provenanceRefs": command.provenance_refs,
            }
            key = (
                "navigator-snapshot:"
                + hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
            )
            response = self.client.post(
                self.echo_url + "/api/v1/evaluation-inputs",
                json=body,
                headers={"Idempotency-Key": key},
            )
            response.raise_for_status()
            if response.status_code != 201:
                raise ValueError("Echo evaluation input did not return HTTP 201")
            result = response.json()
            target = TargetResource.model_validate(result["resourceRef"])
            return EchoReceipt(
                target_resource=target,
                status=result["state"],
                open_in=self.echo_url + "/api/v1/evaluation-inputs/" + target.id,
            )
        except (httpx.HTTPError, ArtifactPublicationError, TypeError, ValueError, KeyError) as exc:
            raise _error(
                "NAVIGATOR_ECHO_HANDOFF_FAILED",
                "Echo did not acknowledge an evaluation input. Retry the same selection.",
                502,
            ) from exc
