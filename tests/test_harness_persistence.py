"""
┌─────────────────────────────────────────────────────────────────────┐
│  Test: Harness metadata and authorization authority                  │
│  Scope: Workspace/session key separation and owner durability.       │
│                                                                     │
│  测试职责：证明 header 元数据与服务端 Workspace/owner authority 分离，      │
│  并证明事件日志仍是唯一可写 Harness history。                           │
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
PRINCIPALS = {
    "alice-token": PersistencePrincipal("alice", frozenset({"workspace-a"})),
    "bob-token": PersistencePrincipal("bob", frozenset({"workspace-a"})),
    "admin-token": PersistencePrincipal("admin", frozenset({"workspace-a"}), can_takeover=True),
    "other-token": PersistencePrincipal("other", frozenset({"workspace-b"})),
}


def _headers(token: str) -> dict[str, str]:
    """Build a configured bearer header. | 构造配置中的 bearer 请求头。"""

    return {"Authorization": f"Bearer {token}"}


def _header(session_id: str, *, workspace_hint: str, owner_hint: str) -> dict[str, Any]:
    """Build opaque metadata that must not become an authorization claim.

    构造不具授权意义的元数据。
    """

    return {
        "version": 2,
        "id": session_id,
        "createdAt": 1_783_000_000_000,
        "isSeeded": False,
        "cwd": f"/untrusted/{workspace_hint}",
        "workspaceHint": workspace_hint,
        "metadataOwner": owner_hint,
    }


def _event(seq: int, workspace: str) -> dict[str, Any]:
    """Build one opaque event envelope. | 构造一个不解释词汇的事件信封。"""

    return {
        "seq": seq,
        "time": 1_783_000_000_001 + seq,
        "type": "fixture/metadata-authority",
        "data": {"workspace": workspace},
    }


def _create(
    client: TestClient,
    workspace: str,
    session_id: str,
    token: str,
    header: dict[str, Any],
) -> dict[str, Any]:
    """Create a session through the authenticated HTTP boundary. | 通过认证 HTTP 边界创建会话。"""

    response = client.post(
        SESSIONS.format(workspace=workspace),
        json={"header": header, "inheritedEventCount": 0, "clientId": f"{token}-client"},
        headers=_headers(token),
    )
    assert response.status_code == 200, response.text
    return response.json()


def _append(
    client: TestClient,
    workspace: str,
    handle: dict[str, Any],
    token: str,
    event: dict[str, Any],
) -> None:
    """Append one event using the server-issued writer capability. | 使用服务端句柄追加事件。"""

    response = client.post(
        f"{SESSIONS.format(workspace=workspace)}/{handle['id']}/append",
        json={
            "writerToken": handle["writerToken"],
            "epoch": handle["epoch"],
            "batchId": f"{workspace}-batch",
            "events": [event],
        },
        headers=_headers(token),
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"nextSeq": 1}


def test_header_metadata_cannot_cross_workspace_session_authority(tmp_path: Path) -> None:
    """Workspace key and principal isolate sessions from cwd/header hints.

    Workspace key 与 principal 决定隔离。
    """

    db_path = tmp_path / "metadata-authority.db"
    client = TestClient(create_persistence_app(db_path, PRINCIPALS))

    # The same upstream Session id is valid in two Workspace partitions. Header
    # hints intentionally point at the other partition and must remain opaque.
    # 中文：同一个上游 Session ID 在两个 Workspace 分区中都有效。header 提示可以指向另一个分区，但必须保持不透明。
    session_a = _create(
        client,
        "workspace-a",
        "shared-session",
        "alice-token",
        _header("shared-session", workspace_hint="workspace-b", owner_hint="mallory"),
    )
    session_b = _create(
        client,
        "workspace-b",
        "shared-session",
        "other-token",
        _header("shared-session", workspace_hint="workspace-a", owner_hint="alice"),
    )
    metadata_before_append = client.get(
        f"{SESSIONS.format(workspace='workspace-a')}/shared-session",
        headers=_headers("alice-token"),
    ).json()["meta"]
    _append(client, "workspace-a", session_a, "alice-token", _event(0, "workspace-a"))
    _append(client, "workspace-b", session_b, "other-token", _event(0, "workspace-b"))

    snapshot_a = client.get(
        f"{SESSIONS.format(workspace='workspace-a')}/shared-session",
        headers=_headers("alice-token"),
    )
    snapshot_b = client.get(
        f"{SESSIONS.format(workspace='workspace-b')}/shared-session",
        headers=_headers("other-token"),
    )
    assert snapshot_a.status_code == 200
    assert snapshot_b.status_code == 200
    assert snapshot_a.json()["meta"] == metadata_before_append
    assert snapshot_a.json()["meta"]["workspaceHint"] == "workspace-b"
    assert snapshot_b.json()["meta"]["workspaceHint"] == "workspace-a"
    assert snapshot_a.json()["eventCount"] == snapshot_b.json()["eventCount"] == 1

    events_a = client.get(
        f"{SESSIONS.format(workspace='workspace-a')}/shared-session/events",
        headers=_headers("alice-token"),
    )
    events_b = client.get(
        f"{SESSIONS.format(workspace='workspace-b')}/shared-session/events",
        headers=_headers("other-token"),
    )
    assert events_a.json()["events"] == [_event(0, "workspace-a")]
    assert events_b.json()["events"] == [_event(0, "workspace-b")]

    cross_read_a = client.get(
        f"{SESSIONS.format(workspace='workspace-a')}/shared-session/events",
        headers=_headers("other-token"),
    )
    cross_read_b = client.get(
        f"{SESSIONS.format(workspace='workspace-b')}/shared-session/events",
        headers=_headers("alice-token"),
    )
    assert cross_read_a.status_code == cross_read_b.status_code == 403
    assert cross_read_a.json()["code"] == cross_read_b.json()["code"] == "WORKSPACE_FORBIDDEN"

    with sqlite3.connect(db_path) as connection:
        rows = connection.execute(
            """
            SELECT workspace_id, session_id, owner_actor_id
            FROM sessions
            ORDER BY workspace_id
            """
        ).fetchall()
    assert rows == [
        ("workspace-a", "shared-session", "alice"),
        ("workspace-b", "shared-session", "other"),
    ]


def test_owner_authority_survives_backend_restart_and_ignores_header_claim(tmp_path: Path) -> None:
    """Restart preserves the principal owner and fences a same-workspace non-owner.

    重启保持 owner 并拒绝同租户非 owner。
    """

    db_path = tmp_path / "owner-restart.db"
    first = TestClient(create_persistence_app(db_path, PRINCIPALS))
    handle = _create(
        first,
        "workspace-a",
        "owned-session",
        "alice-token",
        _header("owned-session", workspace_hint="workspace-a", owner_hint="bob"),
    )
    _append(first, "workspace-a", handle, "alice-token", _event(0, "owner"))

    # A fresh app instance is the service restart boundary. The raw token is
    # intentionally reused only to prove durable ownership; it is never stored.
    # 中文：新建 app 实例代表服务重启。原始 token 仅为证明所有权可持久化而重复使用，不会被保存。
    second = TestClient(create_persistence_app(db_path, PRINCIPALS))
    takeover = second.post(
        f"{SESSIONS.format(workspace='workspace-a')}/owned-session/handles",
        json={
            "access": "write",
            "clientId": "bob-client",
            "takeoverExpectedEpoch": handle["epoch"],
        },
        headers=_headers("bob-token"),
    )
    assert takeover.status_code == 403
    assert takeover.json()["code"] == "SESSION_TAKEOVER_FORBIDDEN"

    foreign_append = second.post(
        f"{SESSIONS.format(workspace='workspace-a')}/owned-session/append",
        json={
            "writerToken": handle["writerToken"],
            "epoch": handle["epoch"],
            "batchId": "foreign-attempt",
            "events": [_event(1, "foreign")],
        },
        headers=_headers("bob-token"),
    )
    assert foreign_append.status_code == 409
    assert foreign_append.json()["code"] == "SESSION_OWNERSHIP_LOST"

    continued = second.post(
        f"{SESSIONS.format(workspace='workspace-a')}/owned-session/append",
        json={
            "writerToken": handle["writerToken"],
            "epoch": handle["epoch"],
            "batchId": "after-restart",
            "events": [_event(1, "owner-after-restart")],
        },
        headers=_headers("alice-token"),
    )
    assert continued.status_code == 200
    assert continued.json() == {"nextSeq": 2}

    with sqlite3.connect(db_path) as connection:
        owner = connection.execute(
            """
            SELECT owner_actor_id, event_count
            FROM sessions
            WHERE workspace_id = ? AND session_id = ?
            """,
            ("workspace-a", "owned-session"),
        ).fetchone()
        token_hash = connection.execute(
            "SELECT writer_token_hash FROM sessions WHERE workspace_id = ? AND session_id = ?",
            ("workspace-a", "owned-session"),
        ).fetchone()[0]
    assert owner == ("alice", 2)
    assert token_hash != handle["writerToken"]


def test_product_metadata_survives_writer_takeover_release_and_restart(
    tmp_path: Path,
) -> None:
    """Product owner is stable while the writer lease changes. | 产品 owner 不随写者变化。"""

    db_path = tmp_path / "product-metadata.db"
    first = TestClient(create_persistence_app(db_path, PRINCIPALS))
    _create(
        first,
        "workspace-a",
        "product-session",
        "alice-token",
        _header("product-session", workspace_hint="workspace-b", owner_hint="mallory"),
    )
    metadata_path = f"{SESSIONS.format(workspace='workspace-a')}/product-session/metadata"
    initial = first.get(metadata_path, headers=_headers("alice-token"))
    assert initial.status_code == 200
    product_metadata = initial.json()
    assert product_metadata["workspaceId"] == "workspace-a"
    assert product_metadata["sessionId"] == "product-session"
    assert product_metadata["creatorActorId"] == "alice"
    assert product_metadata["ownerActorId"] == "alice"
    assert product_metadata["ownerState"] == "known"
    assert product_metadata["metadataVersion"] == 1
    assert product_metadata["source"] == "cyrene"

    # Header claims remain opaque, including a forged owner and Workspace hint.
    # 中文：header 中的声明始终保持不透明，包括伪造的 owner 和 Workspace 提示。
    snapshot = first.get(
        f"{SESSIONS.format(workspace='workspace-a')}/product-session",
        headers=_headers("alice-token"),
    )
    assert snapshot.status_code == 200
    assert snapshot.json()["meta"]["metadataOwner"] == "mallory"
    assert snapshot.json()["productMetadata"] == product_metadata

    takeover = first.post(
        f"{SESSIONS.format(workspace='workspace-a')}/product-session/handles",
        json={"access": "write", "clientId": "admin-client", "takeoverExpectedEpoch": 1},
        headers=_headers("admin-token"),
    )
    assert takeover.status_code == 200
    replacement = takeover.json()
    assert replacement["epoch"] == 2
    after_takeover = first.get(metadata_path, headers=_headers("admin-token"))
    assert after_takeover.json() == product_metadata

    released = first.post(
        f"{SESSIONS.format(workspace='workspace-a')}/product-session/release",
        json={"writerToken": replacement["writerToken"], "epoch": replacement["epoch"]},
        headers=_headers("admin-token"),
    )
    assert released.status_code == 200
    after_release = first.get(metadata_path, headers=_headers("bob-token"))
    assert after_release.json() == product_metadata

    # A new writer is allowed after release, but it does not become Product owner.
    # 中文：释放之后允许新 writer 接管，但它不会因此成为 Product owner。
    bob_handle = first.post(
        f"{SESSIONS.format(workspace='workspace-a')}/product-session/handles",
        json={"access": "write", "clientId": "bob-client"},
        headers=_headers("bob-token"),
    )
    assert bob_handle.status_code == 200
    second = TestClient(create_persistence_app(db_path, PRINCIPALS))
    assert second.get(metadata_path, headers=_headers("bob-token")).json() == product_metadata

    with sqlite3.connect(db_path) as connection:
        writer_and_product_owner = connection.execute(
            """
            SELECT sessions.owner_actor_id,
                   metadata.creator_actor_id,
                   metadata.owner_actor_id
            FROM sessions
            JOIN session_product_metadata AS metadata
              ON metadata.workspace_id = sessions.workspace_id
             AND metadata.session_id = sessions.session_id
            WHERE sessions.workspace_id = ? AND sessions.session_id = ?
            """,
            ("workspace-a", "product-session"),
        ).fetchone()
    assert writer_and_product_owner == ("bob", "alice", "alice")


def test_legacy_sessions_migrate_with_explicit_unknown_product_owner(tmp_path: Path) -> None:
    """Migration never infers Product owner from a legacy writer column. | 迁移不推断旧 owner。"""

    db_path = tmp_path / "legacy-metadata.db"
    legacy_header = _header(
        "legacy-session", workspace_hint="workspace-b", owner_hint="header-owner"
    )
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """
            CREATE TABLE sessions (
                workspace_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                header_json TEXT NOT NULL,
                inherited_event_count INTEGER NOT NULL CHECK (inherited_event_count >= 0),
                event_count INTEGER NOT NULL CHECK (event_count >= 0),
                revision TEXT NOT NULL,
                last_activity_at INTEGER NOT NULL,
                owner_actor_id TEXT,
                owner_client_id TEXT,
                writer_token_hash TEXT,
                epoch INTEGER NOT NULL CHECK (epoch >= 0),
                lease_expires_at INTEGER,
                PRIMARY KEY (workspace_id, session_id),
                CHECK (
                    (owner_actor_id IS NULL AND owner_client_id IS NULL
                     AND writer_token_hash IS NULL AND lease_expires_at IS NULL)
                    OR
                    (owner_actor_id IS NOT NULL AND owner_client_id IS NOT NULL
                     AND writer_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
                )
            )
            """
        )
        connection.execute(
            """
            INSERT INTO sessions (
                workspace_id, session_id, header_json, inherited_event_count,
                event_count, revision, last_activity_at, owner_actor_id,
                owner_client_id, writer_token_hash, epoch, lease_expires_at
            ) VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "workspace-a",
                "legacy-session",
                json.dumps(legacy_header),
                "legacy-revision",
                1_783_000_000_000,
                "legacy-writer",
                "legacy-client",
                "not-a-token",
                9,
                1_900_000_000_000,
            ),
        )
        connection.commit()

    client = TestClient(create_persistence_app(db_path, PRINCIPALS))
    metadata_path = f"{SESSIONS.format(workspace='workspace-a')}/legacy-session/metadata"
    metadata = client.get(metadata_path, headers=_headers("alice-token"))
    assert metadata.status_code == 200
    assert metadata.json() == {
        "workspaceId": "workspace-a",
        "sessionId": "legacy-session",
        "creatorActorId": None,
        "ownerActorId": None,
        "ownerState": "unknown",
        "metadataVersion": 1,
        "source": "legacy",
        "createdAt": None,
    }

    # Reopening the service is idempotent; the old mutable writer remains only
    # in the lease table and cannot populate Product metadata later.
    # 中文：重新打开服务是幂等的；旧的可变 writer 只留在 lease 表中，之后不能再写入 Product metadata。
    TestClient(create_persistence_app(db_path, PRINCIPALS))
    with sqlite3.connect(db_path) as connection:
        migrated = connection.execute(
            """
            SELECT creator_actor_id, owner_actor_id, owner_state, source
            FROM session_product_metadata
            WHERE workspace_id = ? AND session_id = ?
            """,
            ("workspace-a", "legacy-session"),
        ).fetchone()
    assert migrated == (None, None, "unknown", "legacy")
