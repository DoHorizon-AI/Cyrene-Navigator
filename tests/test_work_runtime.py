"""Exercise paired task proxies, cursor forwarding, and workspace isolation."""

from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

from cyrene_navigator.web_host import create_web_host_app
from cyrene_navigator.work_runtime import work_proxy_targets


def test_work_proxy_keeps_credentials_server_side_and_forwards_cursor() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"status": "queued"})

    upstream = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    targets = work_proxy_targets(
        persistence_url="http://persistence.test",
        executor_url="http://executor.test",
        workspace_id="owner",
        persistence_token="persistence-private-test",
        executor_token="executor-private-test",
    )
    app = create_web_host_app(
        pairing_code="owner-code", proxy_targets=targets, http_client=upstream, workspace_id="owner"
    )
    with TestClient(app) as client:
        assert client.get("/api/v1/tasks").status_code == 401
        assert client.get("/api/v1/system/status").json()["workspaceId"] is None
        paired = client.post("/api/v1/auth/pair", json={"pairingCode": "owner-code"})
        csrf = paired.json()["csrfToken"]
        assert client.get("/api/v1/system/status").json()["workspaceId"] == "owner"
        result = client.post(
            "/api/v1/tasks", json={"prompt": "inspect"}, headers={"X-CSRF-Token": csrf}
        )
        assert result.status_code == 200
        assert requests[-1].url == "http://executor.test/api/v1/tasks"
        assert requests[-1].headers["authorization"] == "Bearer executor-private-test"
        assert "private-test" not in result.text
        assert (
            client.get("/api/v1/tasks/t1/events", headers={"Last-Event-ID": "8"}).status_code == 200
        )
        assert requests[-1].headers["last-event-id"] == "8"
        assert client.get("/api/v1/workspaces/owner/work/memory").status_code == 200
        assert requests[-1].headers["authorization"] == "Bearer persistence-private-test"
        count = len(requests)
        assert client.get("/api/v1/workspaces/other/work/memory").status_code == 404
        assert len(requests) == count
