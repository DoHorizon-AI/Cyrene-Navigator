"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 test_work_backend_sessions.py                                    │
│  Module: tests.test_work_backend_sessions                            │
│  Role: Verify native ACP session mappings in the canonical Work DB.  │
│                                                                      │
│  模块职责：验证原生 ACP 会话映射沿用 Work 正式数据库并保持租户隔离。    │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from cyrene_navigator.persistence import PersistencePrincipal, create_persistence_app

TOKENS = {
    "writer": PersistencePrincipal(
        "owner", frozenset({"workspace"}), can_takeover=True, organization_id="org"
    ),
    "reader": PersistencePrincipal("reader", frozenset({"workspace"}), organization_id="org"),
}
BASE = "/api/v1/workspaces/workspace/work"


def test_native_session_mapping_is_owner_scoped_stable_and_survives_restart(
    tmp_path: Path,
) -> None:
    """Persist one ACP id per Work session without importing DSH ids. | 持久化单一 ACP ID。"""

    database = tmp_path / "persistence.sqlite3"
    headers = {"Authorization": "Bearer writer"}
    with TestClient(create_persistence_app(database, TOKENS)) as client:
        first = client.post(
            f"{BASE}/tasks",
            json={"id": "task-1", "sessionId": "work-session", "prompt": "first"},
            headers=headers,
        )
        assert first.status_code == 201
        mapping_url = f"{BASE}/tasks/task-1/backend-session?backend=codebuddy-acp"
        assert client.get(mapping_url, headers=headers).status_code == 409
        assert (
            client.get(mapping_url, headers={"Authorization": "Bearer reader"}).status_code == 403
        )

        claim = client.post(f"{BASE}/tasks/task-1/claim", json={}, headers=headers)
        assert claim.status_code == 200
        assert claim.json()["task"]["status"] == "running"
        assert client.get(mapping_url, headers=headers).json() is None

        bound = client.put(
            f"{BASE}/tasks/task-1/backend-session",
            json={"backend": "codebuddy-acp", "nativeSessionId": "native-session"},
            headers=headers,
        )
        assert bound.status_code == 200
        assert bound.json() == {
            "backend": "codebuddy-acp",
            "sessionId": "work-session",
            "nativeSessionId": "native-session",
        }
        assert client.get(mapping_url, headers=headers).json() == bound.json()
        conflict = client.put(
            f"{BASE}/tasks/task-1/backend-session",
            json={"backend": "codebuddy-acp", "nativeSessionId": "different-native-session"},
            headers=headers,
        )
        assert conflict.status_code == 409

    # A second task in the same Work session sees the same mapping after an app/process restart.
    with TestClient(create_persistence_app(database, TOKENS)) as restarted:
        second = restarted.post(
            f"{BASE}/tasks",
            json={"id": "task-2", "sessionId": "work-session", "prompt": "next"},
            headers=headers,
        )
        assert second.status_code == 201
        claim = restarted.post(f"{BASE}/tasks/task-2/claim", json={}, headers=headers)
        assert claim.status_code == 200
        restored = restarted.get(
            f"{BASE}/tasks/task-2/backend-session?backend=codebuddy-acp",
            headers=headers,
        )
        assert restored.status_code == 200
        assert restored.json() == {
            "backend": "codebuddy-acp",
            "sessionId": "work-session",
            "nativeSessionId": "native-session",
        }

        foreign_backend = restarted.get(
            f"{BASE}/tasks/task-2/backend-session?backend=dsh",
            headers=headers,
        )
        assert foreign_backend.status_code == 422
