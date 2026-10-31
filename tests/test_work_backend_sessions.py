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

import pytest
from fastapi.testclient import TestClient

from cyrene_navigator.persistence import PersistencePrincipal, create_persistence_app

TOKENS = {
    "writer": PersistencePrincipal(
        "owner", frozenset({"workspace"}), can_takeover=True, organization_id="org"
    ),
    "reader": PersistencePrincipal("reader", frozenset({"workspace"}), organization_id="org"),
}
BASE = "/api/v1/workspaces/workspace/work"


@pytest.mark.parametrize("backend", ["codebuddy-acp", "antigravity-acp"])
def test_native_session_mapping_is_owner_scoped_stable_and_survives_restart(
    tmp_path: Path,
    backend: str,
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
        mapping_url = f"{BASE}/tasks/task-1/backend-session?backend={backend}"
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
            json={"backend": backend, "nativeSessionId": "native-session"},
            headers=headers,
        )
        assert bound.status_code == 200
        assert bound.json() == {
            "backend": backend,
            "sessionId": "work-session",
            "nativeSessionId": "native-session",
        }
        assert client.get(mapping_url, headers=headers).json() == bound.json()
        conflict = client.put(
            f"{BASE}/tasks/task-1/backend-session",
            json={"backend": backend, "nativeSessionId": "different-native-session"},
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
            f"{BASE}/tasks/task-2/backend-session?backend={backend}",
            headers=headers,
        )
        assert restored.status_code == 200
        assert restored.json() == {
            "backend": backend,
            "sessionId": "work-session",
            "nativeSessionId": "native-session",
        }

        foreign_backend = restarted.get(
            f"{BASE}/tasks/task-2/backend-session?backend=dsh",
            headers=headers,
        )
        assert foreign_backend.status_code == 422


def test_native_backends_coexist_without_cross_scope_session_reuse(tmp_path: Path) -> None:
    """Keep two native histories distinct across backend, tenant, workspace and restart.

    中文：同一 Work 会话可独立绑定两种后端，不跨租户或 Workspace 复用上下文。
    """

    database = tmp_path / "backend-isolation.sqlite3"
    principals = {
        **TOKENS,
        "other-org": PersistencePrincipal(
            "owner", frozenset({"workspace"}), can_takeover=True, organization_id="other-org"
        ),
        "other-workspace": PersistencePrincipal(
            "owner", frozenset({"other-workspace"}), can_takeover=True, organization_id="org"
        ),
    }
    headers = {"Authorization": "Bearer writer"}
    bindings = {"codebuddy-acp": "codebuddy-history", "antigravity-acp": "antigravity-history"}
    with TestClient(create_persistence_app(database, principals)) as client:
        assert (
            client.post(
                f"{BASE}/tasks",
                json={"id": "first", "sessionId": "same-session", "prompt": "first"},
                headers=headers,
            ).status_code
            == 201
        )
        assert client.post(f"{BASE}/tasks/first/claim", headers=headers).status_code == 200
        for backend, native_id in bindings.items():
            body = {"backend": backend, "nativeSessionId": native_id}
            url = f"{BASE}/tasks/first/backend-session"
            first = client.put(url, json=body, headers=headers)
            assert first.status_code == 200
            assert client.put(url, json=body, headers=headers).json() == first.json()

    with TestClient(create_persistence_app(database, principals)) as restarted:
        assert (
            restarted.post(
                f"{BASE}/tasks",
                json={"id": "next", "sessionId": "same-session", "prompt": "next"},
                headers=headers,
            ).status_code
            == 201
        )
        assert restarted.post(f"{BASE}/tasks/next/claim", headers=headers).status_code == 200
        for backend, native_id in bindings.items():
            restored = restarted.get(
                f"{BASE}/tasks/next/backend-session?backend={backend}", headers=headers
            )
            assert restored.status_code == 200
            assert restored.json()["nativeSessionId"] == native_id

        # Matching Work ids in another scope must not discover either native history.
        for token, workspace in [
            ("other-org", "workspace"),
            ("other-workspace", "other-workspace"),
        ]:
            foreign_base = f"/api/v1/workspaces/{workspace}/work"
            foreign_headers = {"Authorization": f"Bearer {token}"}
            assert (
                restarted.post(
                    f"{foreign_base}/tasks",
                    json={"id": "first", "sessionId": "same-session", "prompt": "separate scope"},
                    headers=foreign_headers,
                ).status_code
                == 201
            )
            assert (
                restarted.post(
                    f"{foreign_base}/tasks/first/claim", headers=foreign_headers
                ).status_code
                == 200
            )
            for backend in bindings:
                restored = restarted.get(
                    f"{foreign_base}/tasks/first/backend-session?backend={backend}",
                    headers=foreign_headers,
                )
                assert restored.status_code == 200
                assert restored.json() is None
