"""
┌─────────────────────────────────────────────────────────────────────┐
│ Test: Navigator actor-private session persistence                    │
│ Scope: Private reads, event writes, and stable-owner enforcement.     │
│ 测试职责：验证 actor-private session 的读取、写入与稳定 owner 边界。     │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from cyrene_navigator.persistence import PersistencePrincipal, create_persistence_app

SESSIONS = "/api/v1/harness/workspaces/{workspace}/sessions"
WORKSPACE = "workspace-a"
ORGANIZATION = "org-private"
PRINCIPALS = {
    "alice-private-token": PersistencePrincipal(
        "alice",
        frozenset({WORKSPACE}),
        organization_id=ORGANIZATION,
        can_write_harness=True,
        actor_private_scope=True,
    ),
    "alice-shared-token": PersistencePrincipal(
        "alice",
        frozenset({WORKSPACE}),
        organization_id=ORGANIZATION,
        can_write_harness=True,
    ),
    "bob-private-token": PersistencePrincipal(
        "bob",
        frozenset({WORKSPACE}),
        organization_id=ORGANIZATION,
        can_write_harness=True,
        actor_private_scope=True,
    ),
    "bob-reader-token": PersistencePrincipal(
        "bob", frozenset({WORKSPACE}), organization_id=ORGANIZATION
    ),
    "bob-admin-token": PersistencePrincipal(
        "bob",
        frozenset({WORKSPACE}),
        can_takeover=True,
        organization_id=ORGANIZATION,
        can_write_harness=True,
    ),
}


def _headers(token: str) -> dict[str, str]:
    """Build a bearer header for one configured actor. | 构造 actor bearer 请求头。"""

    return {"Authorization": f"Bearer {token}"}


def _header(session_id: str) -> dict[str, Any]:
    """Return a minimal Harness session header. | 返回最小 Harness session header。"""

    return {
        "version": 2,
        "id": session_id,
        "createdAt": 1_783_000_000_000,
        "isSeeded": False,
        "origin": "actor-privacy-fixture",
    }


def _event(seq: int, text: str) -> dict[str, Any]:
    """Return one committed opaque event. | 返回一条已提交的不透明事件。"""

    return {
        "seq": seq,
        "time": 1_783_000_000_001 + seq,
        "type": "fixture/private-session",
        "data": {"text": text},
    }


def _create_session(client: TestClient, session_id: str, token: str) -> dict[str, Any]:
    """Create a session under the authenticated principal's privacy mode."""

    response = client.post(
        SESSIONS.format(workspace=WORKSPACE),
        json={
            "header": _header(session_id),
            "inheritedEventCount": 0,
            "clientId": f"{token}-client",
        },
        headers=_headers(token),
    )
    assert response.status_code == 200, response.text
    return response.json()


def _append(
    client: TestClient,
    session_id: str,
    handle: dict[str, Any],
    token: str,
    event: dict[str, Any],
) -> Any:
    """Append one event using the issued handle and writer token."""

    return client.post(
        f"{SESSIONS.format(workspace=WORKSPACE)}/{session_id}/append",
        json={
            "writerToken": handle["writerToken"],
            "epoch": handle["epoch"],
            "batchId": f"batch-{event['seq']}",
            "events": [event],
        },
        headers=_headers(token),
    )


def test_actor_private_sessions_hide_snapshots_and_events_but_shared_sessions_remain_shared(
    tmp_path: Path,
) -> None:
    """Only the stable owner reads a private session through legacy read routes."""

    app = create_persistence_app(tmp_path / "session-privacy.sqlite3", PRINCIPALS)
    client = TestClient(app)

    private_handle = _create_session(client, "alice-private", "alice-private-token")
    private_event = _event(0, "alice-only message")
    assert (
        _append(
            client,
            "alice-private",
            private_handle,
            "alice-private-token",
            private_event,
        ).status_code
        == 200
    )
    shared_handle = _create_session(client, "alice-shared", "alice-shared-token")
    shared_event = _event(0, "workspace-shared message")
    assert (
        _append(
            client,
            "alice-shared",
            shared_handle,
            "alice-shared-token",
            shared_event,
        ).status_code
        == 200
    )
    bob_private_handle = _create_session(client, "bob-private", "bob-private-token")
    bob_private_event = _event(0, "bob-only message")
    assert (
        _append(
            client,
            "bob-private",
            bob_private_handle,
            "bob-private-token",
            bob_private_event,
        ).status_code
        == 200
    )

    private_path = f"{SESSIONS.format(workspace=WORKSPACE)}/alice-private"
    bob_private_path = f"{SESSIONS.format(workspace=WORKSPACE)}/bob-private"
    shared_path = f"{SESSIONS.format(workspace=WORKSPACE)}/alice-shared"
    private_summary_path = f"/internal/workspace/v1/workspaces/{WORKSPACE}/sessions/alice-private"

    for token, visible_sessions in (
        ("bob-reader-token", {"alice-shared", "bob-private"}),
        ("bob-private-token", {"bob-private"}),
        ("bob-admin-token", {"alice-shared", "bob-private"}),
    ):
        listing = client.get(SESSIONS.format(workspace=WORKSPACE), headers=_headers(token))
        assert listing.status_code == 200
        assert {item["meta"]["id"] for item in listing.json()["items"]} == visible_sessions
        assert client.get(private_path, headers=_headers(token)).status_code == 404
        assert client.get(bob_private_path, headers=_headers(token)).status_code == 200
        assert client.get(f"{private_path}/metadata", headers=_headers(token)).status_code == 404
        assert client.get(f"{private_path}/events", headers=_headers(token)).status_code == 404
        assert client.get(private_summary_path, headers=_headers(token)).status_code == 404
        assert (
            client.post(
                f"{private_path}/handles",
                json={"access": "read", "clientId": "other-actor-reader"},
                headers=_headers(token),
            ).status_code
            == 404
        )
        shared_status = client.get(shared_path, headers=_headers(token)).status_code
        assert shared_status == (404 if token == "bob-private-token" else 200)

    alice_private_listing = client.get(
        SESSIONS.format(workspace=WORKSPACE), headers=_headers("alice-private-token")
    )
    assert {item["meta"]["id"] for item in alice_private_listing.json()["items"]} == {
        "alice-private",
        "alice-shared",
    }
    assert client.get(bob_private_path, headers=_headers("alice-private-token")).status_code == 404

    # An unflagged credential for Alice still reads Alice's private session.
    owner_snapshot = client.get(private_path, headers=_headers("alice-shared-token"))
    assert owner_snapshot.status_code == 200
    assert owner_snapshot.json()["productMetadata"]["ownerActorId"] == "alice"
    owner_events = client.get(f"{private_path}/events", headers=_headers("alice-shared-token"))
    assert owner_events.status_code == 200
    assert owner_events.json() == {"events": [private_event], "nextSeq": 1}


def test_actor_private_principal_cannot_take_over_or_mutate_another_actors_session(
    tmp_path: Path,
) -> None:
    """Private ownership blocks even an otherwise privileged Workspace writer."""

    client = TestClient(
        create_persistence_app(tmp_path / "session-takeover-privacy.sqlite3", PRINCIPALS)
    )
    handle = _create_session(client, "alice-private", "alice-private-token")
    path = f"{SESSIONS.format(workspace=WORKSPACE)}/alice-private"

    takeover = client.post(
        f"{path}/handles",
        json={
            "access": "write",
            "clientId": "bob-admin-client",
            "takeoverExpectedEpoch": handle["epoch"],
        },
        headers=_headers("bob-admin-token"),
    )
    assert takeover.status_code == 404

    for operation in ("append", "flush", "heartbeat", "release"):
        body: dict[str, Any] = {
            "writerToken": handle["writerToken"],
            "epoch": handle["epoch"],
        }
        if operation == "append":
            body.update({"batchId": "bob-write", "events": [_event(0, "must not append")]})
        response = client.post(
            f"{path}/{operation}", json=body, headers=_headers("bob-admin-token")
        )
        assert response.status_code == 404

    # The original owner retains the valid lease after every denied attempt.
    owner_append = _append(
        client,
        "alice-private",
        handle,
        "alice-private-token",
        _event(0, "alice still owns this session"),
    )
    assert owner_append.status_code == 200, owner_append.text
    assert owner_append.json() == {"nextSeq": 1}


def _create_unknown_owner_legacy_database(db_path: Path) -> None:
    """Create an older organization-scoped schema without Product owner metadata."""

    legacy_event = _event(0, "legacy shared event")
    with sqlite3.connect(db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE sessions (
                organization_id TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL,
                session_id TEXT NOT NULL, header_json TEXT NOT NULL,
                inherited_event_count INTEGER NOT NULL, event_count INTEGER NOT NULL,
                revision TEXT NOT NULL, last_activity_at INTEGER NOT NULL,
                owner_actor_id TEXT, owner_client_id TEXT, writer_token_hash TEXT,
                epoch INTEGER NOT NULL, lease_expires_at INTEGER,
                PRIMARY KEY (organization_id, workspace_id, session_id)
            );
            CREATE TABLE session_events (
                organization_id TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL,
                session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL,
                PRIMARY KEY (organization_id, workspace_id, session_id, seq)
            );
            CREATE TABLE session_batches (
                organization_id TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL,
                session_id TEXT NOT NULL, epoch INTEGER NOT NULL, batch_id TEXT NOT NULL,
                digest TEXT NOT NULL, event_count INTEGER NOT NULL, next_seq INTEGER NOT NULL,
                PRIMARY KEY (organization_id, workspace_id, session_id, epoch, batch_id)
            );
            """
        )
        connection.execute(
            """
            INSERT INTO sessions (
                organization_id, workspace_id, session_id, header_json,
                inherited_event_count, event_count, revision, last_activity_at,
                owner_actor_id, owner_client_id, writer_token_hash, epoch, lease_expires_at
            ) VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, 3, ?)
            """,
            (
                ORGANIZATION,
                WORKSPACE,
                "legacy-unknown-owner",
                json.dumps(_header("legacy-unknown-owner")),
                "legacy-revision",
                1_783_000_000_000,
                "alice",
                "old-client",
                "legacy-writer-token-hash",
                1_900_000_000_000,
            ),
        )
        connection.execute(
            "INSERT INTO session_events VALUES (?, ?, ?, ?, ?)",
            (
                ORGANIZATION,
                WORKSPACE,
                "legacy-unknown-owner",
                0,
                json.dumps(legacy_event),
            ),
        )


def test_actor_private_principals_reject_unknown_legacy_owner_without_restricting_shared_reader(
    tmp_path: Path,
) -> None:
    """Legacy writer lease identity is not inferred as stable Product ownership."""

    db_path = tmp_path / "legacy-private-owner.sqlite3"
    _create_unknown_owner_legacy_database(db_path)
    client = TestClient(create_persistence_app(db_path, PRINCIPALS))
    path = f"{SESSIONS.format(workspace=WORKSPACE)}/legacy-unknown-owner"

    shared_snapshot = client.get(path, headers=_headers("bob-reader-token"))
    assert shared_snapshot.status_code == 200
    assert shared_snapshot.json()["productMetadata"]["ownerState"] == "unknown"
    assert client.get(f"{path}/events", headers=_headers("bob-reader-token")).status_code == 200

    for token in ("alice-private-token", "bob-private-token"):
        listing = client.get(SESSIONS.format(workspace=WORKSPACE), headers=_headers(token))
        assert listing.status_code == 200
        assert "legacy-unknown-owner" not in {
            item["meta"]["id"] for item in listing.json()["items"]
        }
        assert client.get(path, headers=_headers(token)).status_code == 404
        assert client.get(f"{path}/metadata", headers=_headers(token)).status_code == 404
        assert client.get(f"{path}/events", headers=_headers(token)).status_code == 404
        read_handle = client.post(
            f"{path}/handles",
            json={"access": "read", "clientId": f"{token}-reader"},
            headers=_headers(token),
        )
        assert read_handle.status_code == 404
        write_handle = client.post(
            f"{path}/handles",
            json={
                "access": "write",
                "clientId": f"{token}-writer",
                "takeoverExpectedEpoch": 3,
            },
            headers=_headers(token),
        )
        assert write_handle.status_code == 404
