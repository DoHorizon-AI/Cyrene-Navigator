"""Verify installed tool providers retain organization scope and error redaction.

中文:验证本地工具提供者保留组织隔离,且错误响应不泄露 CLI 输出。
"""

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from cyrene_navigator.persistence import PersistencePrincipal, create_persistence_app


class LocalProvider:
    """A canonical-provider stand-in with no CLI process or external effects."""

    def health(self) -> dict[str, str]:
        return {"status": "connected"}

    def request_qr(self, params: Any) -> dict[str, str]:
        return {"status": "unsupported"}

    def poll_login(self, params: Any) -> dict[str, str]:
        return {"status": "unsupported"}

    def list_tools(self) -> dict[str, Any]:
        return {
            "tools": [
                {
                    "id": "read",
                    "name": "Read",
                    "description": "Read fixture",
                    "inputSchema": {"type": "object"},
                    "readOnly": True,
                }
            ]
        }

    def call_tool(self, tool_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if tool_id == "fail":
            raise RuntimeError("private CLI credential must never reach the client")
        return {"content": [{"type": "text", "text": str(arguments["query"])}]}


def test_tool_providers_are_isolated_by_org_and_require_writer(tmp_path: Path) -> None:
    app = create_persistence_app(
        tmp_path / "work.sqlite3",
        {
            "owner-a": PersistencePrincipal("a", frozenset({"shared"}), True, "org-a"),
            "owner-b": PersistencePrincipal("b", frozenset({"shared"}), True, "org-b"),
            "reader-a": PersistencePrincipal("r", frozenset({"shared"}), False, "org-a"),
        },
        work_connector_bridges={("org-a", "shared", "wecom"): LocalProvider()},
    )
    base = "/api/v1/workspaces/shared/work/tool-providers"
    with TestClient(app) as client:
        assert client.get(base).status_code == 401
        assert client.get(base, headers={"Authorization": "Bearer owner-b"}).json() == {"items": []}
        assert (
            client.get(
                base + "/wecom/tools", headers={"Authorization": "Bearer owner-b"}
            ).status_code
            == 404
        )
        assert (
            client.post(
                base + "/wecom/tools/read/call",
                json={"arguments": {"query": "inspect"}},
                headers={"Authorization": "Bearer reader-a"},
            ).status_code
            == 403
        )
        result = client.post(
            base + "/wecom/tools/read/call",
            json={"arguments": {"query": "inspect"}},
            headers={"Authorization": "Bearer owner-a"},
        )
        assert result.status_code == 200
        assert result.json()["content"][0]["text"] == "inspect"
        assert (
            client.post(
                base + "/wecom/tools/read/call",
                json={"arguments": {}, "host": "other"},
                headers={"Authorization": "Bearer owner-a"},
            ).status_code
            == 422
        )
        failed = client.post(
            base + "/wecom/tools/fail/call",
            json={"arguments": {}},
            headers={"Authorization": "Bearer owner-a"},
        )
        assert failed.status_code == 502
        assert "private CLI credential" not in failed.text
