"""
┌─────────────────────────────────────────────────────────────────────┐
│  Test: Navigator persistence HTTP service                          │
│  Scope: SQLite durability, writer fencing, and Workspace isolation.  │
│                                                                     │
│  测试职责：验证持久化 API 的真实边界语义，而非复制 Harness 事件词汇。        │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from openapi_spec_validator.readers import read_from_filename

from cyrene_navigator.persistence import PersistencePrincipal, create_persistence_app

BASE = "/api/v1/harness/workspaces/{workspace}/sessions"
TOKENS = {
    "alice-token": PersistencePrincipal("alice", frozenset({"w1"})),
    "bob-token": PersistencePrincipal("bob", frozenset({"w1"})),
    "admin-token": PersistencePrincipal("admin", frozenset({"w1"}), can_takeover=True),
    "other-token": PersistencePrincipal("other", frozenset({"w2"})),
}


def test_runtime_paths_match_frozen_persistence_openapi(tmp_path: Path) -> None:
    """The published persistence contract covers every implemented route.

    中文:已发布的 persistence 契约覆盖所有已实现的 route。
    """
    # 中文:已发布的持久化契约覆盖每个已实现路由。

    app = create_persistence_app(tmp_path / "contract.sqlite3", TOKENS)
    contract, _ = read_from_filename(
        str(Path(__file__).parents[1] / "contracts/product/v1/persistence.openapi.yaml")
    )
    assert set(app.openapi()["paths"]) == set(contract["paths"])


def _headers(token: str = "alice-token") -> dict[str, str]:
    """Build a bearer header for one configured principal. | 构造 bearer 请求头。"""

    return {"Authorization": f"Bearer {token}"}


def _client(db_path: Path, *, lease_seconds: float = 120) -> TestClient:
    """Build an isolated service instance against one database file. | 创建隔离服务实例。"""

    return TestClient(create_persistence_app(db_path, TOKENS, lease_seconds=lease_seconds))


def _header(session_id: str, *, seeded: bool = False) -> dict[str, Any]:
    """Return the minimum DSH v2 header accepted by the boundary. | 返回最小 v2 头。"""

    return {
        "version": 2,
        "id": session_id,
        "createdAt": 1_783_000_000_000,
        "isSeeded": seeded,
        "origin": "external-fixture",
    }


def _event(seq: int, text: str = "hello") -> dict[str, Any]:
    """Return an opaque event envelope; the Harness owns its vocabulary. | 返回事件信封。"""

    return {
        "seq": seq,
        "time": 1_783_000_000_001 + seq,
        "type": "fixture/event",
        "data": {"text": text},
    }


def _create(
    client: TestClient,
    session_id: str = "session-1",
    *,
    token: str = "alice-token",
    workspace: str = "w1",
    header: dict[str, Any] | None = None,
    inherited_event_count: int = 0,
) -> dict[str, Any]:
    """Create one session and return its write handle. | 创建会话并返回写句柄。"""

    response = client.post(
        BASE.format(workspace=workspace),
        json={
            "header": header or _header(session_id),
            "inheritedEventCount": inherited_event_count,
            "clientId": "test-client",
        },
        headers=_headers(token),
    )
    assert response.status_code == 200, response.text
    return response.json()


def _append(
    client: TestClient,
    handle: dict[str, Any],
    events: list[dict[str, Any]],
    *,
    batch_id: str,
    token: str = "alice-token",
    workspace: str = "w1",
) -> Any:
    """Append through the public HTTP route. | 通过公开 HTTP 路由追加。"""

    return client.post(
        f"{BASE.format(workspace=workspace)}/{handle['id']}/append",
        json={
            "writerToken": handle["writerToken"],
            "epoch": handle["epoch"],
            "batchId": batch_id,
            "events": events,
        },
        headers=_headers(token),
    )


def _problem(response: Any) -> dict[str, Any]:
    """Read a problem response and assert its media type. | 读取 RFC 9457 错误。"""

    assert response.headers["content-type"].startswith("application/problem+json")
    return response.json()


def test_session_survives_service_restart_and_uses_durable_sqlite(tmp_path: Path) -> None:
    """A committed event remains readable after a new service instance starts. | 重启可恢复。"""

    db_path = tmp_path / "persistence.db"
    first = _client(db_path)
    handle = _create(first)
    event_batch = [_event(0), _event(1, "world")]
    response = _append(first, handle, event_batch, batch_id="batch-1")
    assert response.status_code == 200
    assert response.json() == {"nextSeq": 2}
    flushed = first.post(
        f"{BASE.format(workspace='w1')}/{handle['id']}/flush",
        json={"writerToken": handle["writerToken"], "epoch": handle["epoch"]},
        headers=_headers(),
    )
    assert flushed.status_code == 200
    assert flushed.json()["nextSeq"] == 2

    second = _client(db_path)
    listing = second.get(BASE.format(workspace="w1"), headers=_headers())
    assert listing.status_code == 200
    assert listing.json()["items"][0]["eventCount"] == 2
    events = second.get(
        f"{BASE.format(workspace='w1')}/{handle['id']}/events?offset=0&length=10",
        headers=_headers(),
    )
    assert events.status_code == 200
    assert events.json() == {"events": event_batch, "nextSeq": 2}

    with sqlite3.connect(db_path) as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        assert connection.execute("PRAGMA synchronous").fetchone()[0] == 2
        stored_hash = connection.execute("SELECT writer_token_hash FROM sessions").fetchone()[0]
        assert stored_hash != handle["writerToken"]
        assert stored_hash is not None and len(stored_hash) == 64


def test_writer_takeover_fences_old_token_and_requires_expected_epoch(tmp_path: Path) -> None:
    """Takeover is explicit and every old mutation is rejected. | 接管需显式 epoch。"""

    client = _client(tmp_path / "takeover.db")
    handle = _create(client)
    path = f"{BASE.format(workspace='w1')}/{handle['id']}/handles"

    already_owned = client.post(
        path,
        json={"access": "write", "clientId": "bob-client"},
        headers=_headers("bob-token"),
    )
    assert already_owned.status_code == 409
    assert _problem(already_owned)["code"] == "SESSION_ALREADY_OWNED"

    same_owner_without_epoch = client.post(
        path,
        json={"access": "write", "clientId": "second-client"},
        headers=_headers("alice-token"),
    )
    assert same_owner_without_epoch.status_code == 409

    forbidden_takeover = client.post(
        path,
        json={"access": "write", "clientId": "bob-client", "takeoverExpectedEpoch": 1},
        headers=_headers("bob-token"),
    )
    assert forbidden_takeover.status_code == 403
    assert _problem(forbidden_takeover)["code"] == "SESSION_TAKEOVER_FORBIDDEN"

    replacement = client.post(
        path,
        json={"access": "write", "clientId": "admin-client", "takeoverExpectedEpoch": 1},
        headers=_headers("admin-token"),
    )
    assert replacement.status_code == 200
    new_handle = replacement.json()
    assert new_handle["epoch"] == 2
    assert new_handle["writerToken"] != handle["writerToken"]

    for operation in ("append", "heartbeat", "flush", "release"):
        body: dict[str, Any] = {
            "writerToken": handle["writerToken"],
            "epoch": handle["epoch"],
        }
        if operation == "append":
            body.update({"batchId": "old-batch", "events": [_event(0)]})
        response = client.post(
            f"{BASE.format(workspace='w1')}/{handle['id']}/{operation}",
            json=body,
            headers=_headers(),
        )
        assert response.status_code == 409
        assert _problem(response)["code"] == "SESSION_OWNERSHIP_LOST"

    current = _append(client, new_handle, [_event(0)], batch_id="new-batch", token="admin-token")
    assert current.status_code == 200
    assert current.json() == {"nextSeq": 1}


def test_two_clients_competing_for_one_epoch_have_one_writer(tmp_path: Path) -> None:
    """Immediate transactions serialize competing takeovers. | 即时事务串行接管。"""

    client = _client(tmp_path / "competition.db")
    handle = _create(client)
    path = f"{BASE.format(workspace='w1')}/{handle['id']}/handles"

    def take_over(client_id: str) -> Any:
        """Attempt the same expected epoch from a separate client identity. | 竞争同一 epoch。"""

        return client.post(
            path,
            json={
                "access": "write",
                "clientId": client_id,
                "takeoverExpectedEpoch": handle["epoch"],
            },
            headers=_headers(),
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(take_over, ["client-a", "client-b"]))
    assert sorted(response.status_code for response in responses) == [200, 409]
    loser = next(response for response in responses if response.status_code == 409)
    assert _problem(loser)["code"] == "SESSION_OWNERSHIP_LOST"


def test_same_actor_can_take_over_after_lease_expiry(tmp_path: Path) -> None:
    """An expired owner can recover with its actor and expected epoch. | 租约过期可恢复。"""

    client = _client(tmp_path / "lease.db", lease_seconds=0.03)
    handle = _create(client)
    time.sleep(0.08)
    takeover = client.post(
        f"{BASE.format(workspace='w1')}/{handle['id']}/handles",
        json={"access": "write", "clientId": "recovered", "takeoverExpectedEpoch": handle["epoch"]},
        headers=_headers(),
    )
    assert takeover.status_code == 200
    assert takeover.json()["epoch"] == handle["epoch"] + 1
    stale = _append(client, handle, [_event(0)], batch_id="stale")
    assert stale.status_code == 409
    assert _problem(stale)["code"] == "SESSION_OWNERSHIP_LOST"


def test_batch_retry_is_idempotent_and_conflicts_are_atomic(tmp_path: Path) -> None:
    """Retries preserve one commit while gaps and body conflicts add nothing. | 批次原子幂等。"""

    client = _client(tmp_path / "batches.db")
    handle = _create(client)
    first_event = [_event(0)]
    first = _append(client, handle, first_event, batch_id="batch-1")
    assert first.status_code == 200 and first.json() == {"nextSeq": 1}
    retry = _append(client, handle, first_event, batch_id="batch-1")
    assert retry.status_code == 200 and retry.json() == {"nextSeq": 1}

    changed = _append(client, handle, [_event(0, "changed")], batch_id="batch-1")
    assert changed.status_code == 409
    assert _problem(changed)["code"] == "SESSION_SEQUENCE_CONFLICT"

    gap = _append(client, handle, [_event(2), _event(3)], batch_id="batch-gap")
    assert gap.status_code == 409
    assert _problem(gap)["code"] == "SESSION_SEQUENCE_CONFLICT"
    unchanged = client.get(
        f"{BASE.format(workspace='w1')}/{handle['id']}/events?offset=0&length=10",
        headers=_headers(),
    )
    assert unchanged.json() == {"events": first_event, "nextSeq": 1}

    valid = _append(client, handle, [_event(1, "second")], batch_id="batch-2")
    assert valid.status_code == 200 and valid.json() == {"nextSeq": 2}


def test_authentication_and_workspace_scope_fail_closed(tmp_path: Path) -> None:
    """Missing, unknown, and cross-Workspace credentials cannot read or write. | 认证隔离。"""

    client = _client(tmp_path / "auth.db")
    path = BASE.format(workspace="w1")
    no_auth = client.get(path)
    assert no_auth.status_code == 401
    assert _problem(no_auth)["code"] == "WORKSPACE_UNAUTHORIZED"
    unknown = client.get(path, headers=_headers("unknown-token"))
    assert unknown.status_code == 401
    assert _problem(unknown)["code"] == "WORKSPACE_UNAUTHORIZED"
    cross_workspace = client.get(path, headers=_headers("other-token"))
    assert cross_workspace.status_code == 403
    assert _problem(cross_workspace)["code"] == "WORKSPACE_FORBIDDEN"

    created_elsewhere = _create(
        client, session_id="other-session", token="other-token", workspace="w2"
    )
    assert created_elsewhere["id"] == "other-session"
    denied = client.get(
        f"{BASE.format(workspace='w2')}/{created_elsewhere['id']}", headers=_headers("alice-token")
    )
    assert denied.status_code == 403


def test_read_handles_do_not_change_event_log_or_writer_epoch(tmp_path: Path) -> None:
    """Read access is observational and never mutates ownership or history. | 只读不变更。"""

    client = _client(tmp_path / "readonly.db")
    handle = _create(client)
    assert (
        _append(client, handle, [_event(0), _event(1, "two")], batch_id="history").status_code
        == 200
    )
    before = client.get(f"{BASE.format(workspace='w1')}/{handle['id']}", headers=_headers()).json()

    read_handle = client.post(
        f"{BASE.format(workspace='w1')}/{handle['id']}/handles",
        json={"access": "read", "clientId": "reader"},
        headers=_headers("bob-token"),
    )
    assert read_handle.status_code == 200
    assert "writerToken" not in read_handle.json()
    assert "leaseExpiresAt" not in read_handle.json()
    selected = client.get(
        f"{BASE.format(workspace='w1')}/{handle['id']}/events?offset=1&length=1",
        headers=_headers("bob-token"),
    )
    assert selected.status_code == 200
    assert selected.json() == {"events": [_event(1, "two")], "nextSeq": 2}
    after = client.get(f"{BASE.format(workspace='w1')}/{handle['id']}", headers=_headers()).json()
    assert after == before


def test_header_and_event_boundary_validation_does_not_create_partial_state(tmp_path: Path) -> None:
    """Invalid v2 headers and envelopes fail before durable state changes. | 边界校验无半成品。"""

    client = _client(tmp_path / "validation.db")
    response = client.post(
        BASE.format(workspace="w1"),
        json={
            "header": {"version": 1, "id": "bad", "createdAt": 1, "isSeeded": False},
            "inheritedEventCount": 0,
            "clientId": "client",
        },
        headers=_headers(),
    )
    assert response.status_code == 422
    assert _problem(response)["code"] == "SESSION_INVALID_HEADER"
    assert client.get(BASE.format(workspace="w1"), headers=_headers()).json() == {"items": []}

    handle = _create(client, session_id="validated")
    invalid_event = _append(
        client,
        handle,
        [{"seq": 0, "time": 1, "type": "fixture/event"}],
        batch_id="missing-data",
    )
    assert invalid_event.status_code == 422
    assert _problem(invalid_event)["code"] == "SESSION_INVALID_EVENT"
    assert client.get(
        f"{BASE.format(workspace='w1')}/{handle['id']}/events", headers=_headers()
    ).json() == {"events": [], "nextSeq": 0}
