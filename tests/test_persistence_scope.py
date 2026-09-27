"""
┌─────────────────────────────────────────────────────────────────────┐
│  Test: Navigator organization and Workspace persistence scope       │
│  Scope: Composite storage keys, private reads, and writer denial.     │
│                                                                     │
│  测试职责：验证组织与 Workspace 复合隔离及私有 Product 凭据只读。         │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from cyrene_navigator.persistence import (
    PersistencePrincipal,
    PersistenceStore,
    create_persistence_app,
)

SESSIONS = "/api/v1/harness/workspaces/{workspace}/sessions"
PRINCIPALS = {
    "org-a-token": PersistencePrincipal(
        "service-a", frozenset({"shared-workspace"}), organization_id="org-a"
    ),
    "org-b-token": PersistencePrincipal(
        "service-b", frozenset({"shared-workspace"}), organization_id="org-b"
    ),
    "org-a-other-workspace-token": PersistencePrincipal(
        "service-a-other", frozenset({"other-workspace"}), organization_id="org-a"
    ),
    "legacy-token": PersistencePrincipal(
        "legacy-reader", frozenset({"shared-workspace", "other-workspace"})
    ),
}


def _headers(token: str) -> dict[str, str]:
    """Build an Authorization header for a configured server principal."""

    return {"Authorization": f"Bearer {token}"}


def _header(session_id: str) -> dict[str, Any]:
    """Return the minimum stable Harness header used by scope fixtures."""

    return {
        "version": 2,
        "id": session_id,
        "createdAt": 1_783_000_000_000,
        "isSeeded": False,
    }


def _seed_session(
    store: PersistenceStore,
    principal: PersistencePrincipal,
    workspace_id: str,
    session_id: str,
    marker: str,
) -> dict[str, Any]:
    """Seed a session through the trusted store boundary for read-scope tests."""

    handle = store.create_session(
        workspace_id,
        session_id,
        _header(session_id),
        0,
        principal,
        f"{principal.actor_id}-client",
    )
    assert handle.writer_token is not None
    event = {
        "seq": 0,
        "time": 1_783_000_000_001,
        "type": "fixture/organization-scope",
        "data": {"marker": marker},
    }
    assert (
        store.append_events(
            workspace_id,
            session_id,
            principal,
            handle.writer_token,
            handle.epoch,
            "same-batch-id",
            [event],
        )
        == 1
    )
    return {"handle": handle.as_dict(), "event": event}


def test_workspace_session_events_and_batches_are_organization_scoped(
    tmp_path: Path,
) -> None:
    """Same Workspace/session keys remain independent across organizations."""

    db_path = tmp_path / "organization-scope.sqlite3"
    app = create_persistence_app(db_path, PRINCIPALS)
    store: PersistenceStore = app.state.persistence_store
    client = TestClient(app)

    org_a_shared = _seed_session(
        store, PRINCIPALS["org-a-token"], "shared-workspace", "shared-session", "org-a"
    )
    org_b_shared = _seed_session(
        store, PRINCIPALS["org-b-token"], "shared-workspace", "shared-session", "org-b"
    )
    org_a_only = _seed_session(
        store, PRINCIPALS["org-a-token"], "shared-workspace", "org-a-only", "org-a-private"
    )
    org_b_only = _seed_session(
        store, PRINCIPALS["org-b-token"], "shared-workspace", "org-b-only", "org-b-private"
    )
    org_a_other_workspace = _seed_session(
        store,
        PRINCIPALS["org-a-other-workspace-token"],
        "other-workspace",
        "shared-session",
        "org-a-other-workspace",
    )
    legacy_shared = _seed_session(
        store, PRINCIPALS["legacy-token"], "shared-workspace", "shared-session", "legacy"
    )
    legacy_only = _seed_session(
        store, PRINCIPALS["legacy-token"], "shared-workspace", "legacy-only", "legacy-private"
    )

    def list_ids(workspace: str, token: str) -> set[str]:
        response = client.get(SESSIONS.format(workspace=workspace), headers=_headers(token))
        assert response.status_code == 200, response.text
        return {item["meta"]["id"] for item in response.json()["items"]}

    assert list_ids("shared-workspace", "org-a-token") == {"shared-session", "org-a-only"}
    assert list_ids("shared-workspace", "org-b-token") == {"shared-session", "org-b-only"}
    assert list_ids("shared-workspace", "legacy-token") == {"shared-session", "legacy-only"}
    assert list_ids("other-workspace", "org-a-other-workspace-token") == {"shared-session"}

    shared_path = f"{SESSIONS.format(workspace='shared-workspace')}/shared-session"
    for token, fixture, actor_id in (
        ("org-a-token", org_a_shared, "service-a"),
        ("org-b-token", org_b_shared, "service-b"),
        ("legacy-token", legacy_shared, "legacy-reader"),
    ):
        snapshot = client.get(shared_path, headers=_headers(token))
        assert snapshot.status_code == 200
        assert snapshot.json()["eventCount"] == 1
        assert snapshot.json()["productMetadata"]["creatorActorId"] == actor_id
        events = client.get(f"{shared_path}/events", headers=_headers(token))
        assert events.status_code == 200
        assert events.json() == {"events": [fixture["event"]], "nextSeq": 1}

    for token, hidden_session in (
        ("org-a-token", "org-b-only"),
        ("org-b-token", "org-a-only"),
        ("legacy-token", "org-a-only"),
        ("org-a-token", "legacy-only"),
    ):
        hidden = client.get(
            f"{SESSIONS.format(workspace='shared-workspace')}/{hidden_session}",
            headers=_headers(token),
        )
        assert hidden.status_code == 404

    # Scoped Product Bearers can read, but cannot mint writer capabilities or
    # append even when a valid stored writer token is supplied in the body.
    # 中文: 作用域 Product 凭据只读,即使请求携带有效 writerToken 也不能写。
    denied_create = client.post(
        SESSIONS.format(workspace="shared-workspace"),
        json={"header": _header("forbidden-create"), "inheritedEventCount": 0, "clientId": "x"},
        headers=_headers("org-a-token"),
    )
    assert denied_create.status_code == 403

    org_a_handle = org_a_only["handle"]
    denied_write_handle = client.post(
        f"{SESSIONS.format(workspace='shared-workspace')}/org-a-only/handles",
        json={"access": "write", "clientId": "forbidden-writer"},
        headers=_headers("org-a-token"),
    )
    assert denied_write_handle.status_code == 403
    denied_append = client.post(
        f"{SESSIONS.format(workspace='shared-workspace')}/org-a-only/append",
        json={
            "writerToken": org_a_handle["writerToken"],
            "epoch": org_a_handle["epoch"],
            "batchId": "forbidden-append",
            "events": [
                {
                    "seq": 1,
                    "time": 1_783_000_000_002,
                    "type": "fixture/organization-scope",
                    "data": {"marker": "must-not-append"},
                }
            ],
        },
        headers=_headers("org-a-token"),
    )
    assert denied_append.status_code == 403
    assert denied_append.json()["code"] == "WORKSPACE_FORBIDDEN"
    unchanged = client.get(
        f"{SESSIONS.format(workspace='shared-workspace')}/org-a-only/events",
        headers=_headers("org-a-token"),
    )
    assert unchanged.json() == {"events": [org_a_only["event"]], "nextSeq": 1}

    read_handle = client.post(
        f"{SESSIONS.format(workspace='shared-workspace')}/org-a-only/handles",
        json={"access": "read", "clientId": "reader"},
        headers=_headers("org-a-token"),
    )
    assert read_handle.status_code == 200
    assert "writerToken" not in read_handle.json()
    assert "leaseExpiresAt" not in read_handle.json()

    with sqlite3.connect(db_path) as connection:
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        batches = connection.execute(
            """
            SELECT organization_id, workspace_id, session_id, batch_id
            FROM session_batches
            WHERE session_id = 'shared-session'
            ORDER BY organization_id, workspace_id
            """
        ).fetchall()
    assert batches == [
        ("", "shared-workspace", "shared-session", "same-batch-id"),
        ("org-a", "other-workspace", "shared-session", "same-batch-id"),
        ("org-a", "shared-workspace", "shared-session", "same-batch-id"),
        ("org-b", "shared-workspace", "shared-session", "same-batch-id"),
    ]
    assert org_a_other_workspace["event"]["data"]["marker"] == "org-a-other-workspace"
    assert org_b_only["event"]["data"]["marker"] == "org-b-private"
    assert legacy_only["event"]["data"]["marker"] == "legacy-private"
