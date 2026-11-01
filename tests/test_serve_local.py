"""
┌─────────────────────────────────────────────────────────────────────┐
│  Test: Local Navigator stack supervisor                             │
│  Scope: executor-only profile settings and credential delegation.   │
│                                                                     │
│  测试职责：验证宿主配置仅向 executor 转发声明的环境凭据。               │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "serve-local.py"
_SPEC = importlib.util.spec_from_file_location("navigator_serve_local", _SCRIPT_PATH)
assert _SPEC is not None and _SPEC.loader is not None
serve_local = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = serve_local
_SPEC.loader.exec_module(serve_local)


def test_executor_profile_environment_contains_only_declared_references(tmp_path: Path) -> None:
    """The executor receives enabled profile paths and only named host values."""

    subagent_path = tmp_path / "subagents.json"
    subagent_path.write_text(
        json.dumps(
            {
                "deployments": [
                    {
                        "backend": "antigravity",
                        "command": "antigravity",
                        "envRefs": {"ANTIGRAVITY_KEY": "ROUND1_SUBAGENT_TOKEN"},
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    cloud_path = tmp_path / "cloud.json"
    cloud_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "profiles": [
                    {
                        "id": "round1-mcp",
                        "connection": {
                            "headerEnvRefs": {"Authorization": "ROUND1_CLOUD_TOKEN"},
                            "envRefs": ["ROUND1_AZURE_IDENTITY"],
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    host_environment = {
        "CYRENE_SUBAGENT_CONFIG": str(subagent_path),
        "CYRENE_CLOUD_PROFILE_CONFIG": str(cloud_path),
        "CYRENE_WORKFLOWS_ENABLED": "true",
        "ROUND1_SUBAGENT_TOKEN": "subagent-secret-value",
        "ROUND1_CLOUD_TOKEN": "cloud-secret-value",
        "ROUND1_AZURE_IDENTITY": "identity-secret-value",
        "CYRENE_EXCHANGE_INTEGRATION_URL": "https://exchange.example.test",
        "CYRENE_EXCHANGE_INTEGRATION_SESSION_ID": "navigator-session-42",
        "CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN": "current-user-bearer-value",
        "UNRELATED_SECRET": "must-not-cross-process-boundary",
    }

    forwarded = serve_local._executor_integration_environment(
        host_environment, workspace_id="round1-workspace"
    )

    assert forwarded["CYRENE_SUBAGENT_CONFIG"] == str(subagent_path.resolve())
    assert forwarded["CYRENE_CLOUD_PROFILE_CONFIG"] == str(cloud_path.resolve())
    assert forwarded["CYRENE_WORKFLOWS_ENABLED"] == "true"
    assert forwarded["ROUND1_SUBAGENT_TOKEN"] == "subagent-secret-value"
    assert forwarded["ROUND1_CLOUD_TOKEN"] == "cloud-secret-value"
    assert forwarded["ROUND1_AZURE_IDENTITY"] == "identity-secret-value"
    assert forwarded["CYRENE_EXCHANGE_INTEGRATION_URL"] == "https://exchange.example.test"
    assert forwarded["CYRENE_EXCHANGE_INTEGRATION_SESSION_ID"] == "navigator-session-42"
    assert forwarded["CYRENE_EXCHANGE_INTEGRATION_WORKSPACE_ID"] == "round1-workspace"
    assert "CYRENE_EXCHANGE_INTEGRATION_AUTH_MODE" not in forwarded
    assert forwarded["CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN"] == "current-user-bearer-value"
    assert "ANTIGRAVITY_KEY" not in forwarded
    assert "UNRELATED_SECRET" not in forwarded

    executor_environment = serve_local._executor_child_environment(
        repository=tmp_path,
        persistence_url="http://127.0.0.1:3001",
        workspace_id="round1-workspace",
        session_token="round1-session-token",
        executor_token="round1-executor-token",
        dsh_home=tmp_path / "dsh-home",
        plugins_dir=tmp_path / "plugins",
        node="node",
        integration_environment=forwarded,
    )
    web_environment = serve_local._web_child_environment(
        repository=tmp_path,
        session_token="round1-session-token",
        executor_token="round1-executor-token",
        workspace_id="round1-workspace",
    )
    assert executor_environment["ROUND1_CLOUD_TOKEN"] == "cloud-secret-value"
    assert (
        executor_environment["CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN"]
        == "current-user-bearer-value"
    )
    assert "UNRELATED_SECRET" not in executor_environment
    assert "ROUND1_CLOUD_TOKEN" not in web_environment
    assert "CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN" not in web_environment
    assert "CYRENE_EXCHANGE_INTEGRATION_SESSION_ID" not in web_environment
    assert "CYRENE_EXCHANGE_INTEGRATION_WORKSPACE_ID" not in web_environment
    assert "CYRENE_SUBAGENT_CONFIG" not in web_environment


def test_executor_startup_redaction_includes_exchange_bearers() -> None:
    """Executor readiness checks the model and delegated Product bearer values."""

    secrets = serve_local._executor_startup_secrets(
        "session-private",
        "executor-private",
        {
            "CYRENE_EXCHANGE_TOKEN": "model-provider-private",
            "CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN": "delegated-user-private",
        },
    )
    assert secrets == (
        "session-private",
        "executor-private",
        "model-provider-private",
        "delegated-user-private",
    )


def test_executor_profile_environment_fails_closed_for_malformed_config(tmp_path: Path) -> None:
    """Invalid JSON never reaches the executor as a partially loaded profile."""

    config_path = tmp_path / "invalid.json"
    config_path.write_text('{"profiles": [', encoding="utf-8")

    with pytest.raises(ValueError, match="could not be read as valid JSON"):
        serve_local._executor_integration_environment(
            {"CYRENE_CLOUD_PROFILE_CONFIG": str(config_path)},
            workspace_id="round1-workspace",
        )


def test_workflow_flag_accepts_only_explicit_boolean_values() -> None:
    """The supervisor rejects ambiguous values before starting any child process."""

    with pytest.raises(ValueError, match="must be 'true' or 'false'"):
        serve_local._executor_integration_environment(
            {"CYRENE_WORKFLOWS_ENABLED": "yes"}, workspace_id="round1-workspace"
        )


def test_teams_owner_projection_file_is_forwarded_without_static_actor_env(tmp_path: Path) -> None:
    """Forward scoped owner/catalog files without static actors or unrelated child values."""

    workspace_id = "11111111-1111-4111-8111-111111111111"
    tenant_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    actor_id = "11111111-1111-4111-8111-111111111111"
    binding_id = "exchange-github-11111111-1111-4111-8111-111111111111"
    connection_ref = "11111111-1111-4111-8111-111111111111"
    profile_ref = "github-profile-1"
    actor_file = tmp_path / "teams-actor-subjects.json"
    actor_file.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "workspaceId": workspace_id,
                "issuer": f"https://login.microsoftonline.com/{tenant_id}/v2.0",
                "subjects": [actor_id],
            }
        ),
        encoding="utf-8",
    )
    key_file = tmp_path / "exchange-hmac.key"
    key_file.write_bytes(b"x" * 32)
    binding_file = tmp_path / "connector-bindings.json"
    catalog_file = tmp_path / "connector-tool-catalog.json"
    binding_file.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "bindings": [
                    {
                        "bindingId": binding_id,
                        "connectionRef": connection_ref,
                        "providerId": "github",
                        "profileRef": profile_ref,
                        "tools": [
                            {
                                "toolId": "github.repository.list",
                                "operationId": "github.repository.list",
                                "resourceProjection": "profile",
                                "mutating": False,
                            }
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    catalog_file.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "items": [
                    {
                        "bindingId": binding_id,
                        "capabilityId": "tool.provider.v1",
                        "providerId": "github",
                        "connectionRef": connection_ref,
                        "profileRef": profile_ref,
                        "tools": [
                            {
                                "id": "github.repository.list",
                                "name": "List GitHub Repositories",
                                "description": "List repositories from this configured profile.",
                                "readOnly": True,
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {},
                                    "additionalProperties": False,
                                },
                            }
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    environment = {
        "TEAMS_ENABLED": "true",
        "TEAMS_NAVIGATOR_HMAC_KEY": "teams-ingress-test-key-0123456789abcdef",
        "TEAMS_TENANT_ID": tenant_id,
        "TEAMS_ALLOWED_TEAM_IDS": "team-1",
        "TEAMS_BOT_APP_ID": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "TEAMS_TASK_ACTOR_SUBJECTS_FILE": str(actor_file),
        "TEAMS_EXCHANGE_CONNECTION_REF": "22222222-2222-4222-8222-222222222222",
        "TEAMS_EXCHANGE_PROFILE_REF": "teams-profile-1",
        "CYRENE_EXCHANGE_CONNECTOR_INTERNAL_URL": "https://exchange.example.test",
        "NAVIGATOR_EXCHANGE_HMAC_KEY_FILE": str(key_file),
        "NAVIGATOR_EXCHANGE_HMAC_KEY_ID": "navigator-prod-v1",
        "CYRENE_CONNECTOR_BINDINGS_FILE": str(binding_file),
        "CYRENE_CONNECTOR_TOOL_CATALOG_FILE": str(catalog_file),
    }
    forwarded = serve_local._executor_integration_environment(
        environment, workspace_id=workspace_id
    )

    assert forwarded["TEAMS_TASK_ACTOR_SUBJECTS_FILE"] == str(actor_file.resolve())
    assert "TEAMS_TASK_ACTOR_SUBJECTS" not in forwarded
    assert forwarded["CYRENE_CONNECTOR_TOOL_CATALOG_FILE"] == str(catalog_file.resolve())

    without_catalog = environment.copy()
    without_catalog.pop("CYRENE_CONNECTOR_TOOL_CATALOG_FILE")
    with pytest.raises(ValueError, match="CYRENE_CONNECTOR_TOOL_CATALOG_FILE is required"):
        serve_local._executor_integration_environment(without_catalog, workspace_id=workspace_id)

    catalog_file.write_text('{"schemaVersion": 2, "items": []}', encoding="utf-8")
    with pytest.raises(ValueError, match="version 1 catalog items"):
        serve_local._executor_integration_environment(environment, workspace_id=workspace_id)

    with catalog_file.open("wb") as catalog_stream:
        catalog_stream.truncate(32 * 1024 * 1024 + 1)
    with pytest.raises(ValueError, match="bounded regular file"):
        serve_local._executor_integration_environment(environment, workspace_id=workspace_id)


def test_teams_owner_projection_rejects_mismatched_workspace_or_issuer(tmp_path: Path) -> None:
    """Refuse a maintainer file scoped to a different Workspace or tenant issuer."""

    workspace_id = "11111111-1111-4111-8111-111111111111"
    tenant_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    actor_file = tmp_path / "teams-actor-subjects.json"
    actor_file.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "workspaceId": "another-workspace",
                "issuer": f"https://login.microsoftonline.com/{tenant_id}/v2.0",
                "subjects": ["11111111-1111-4111-8111-111111111111"],
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="invalid scope or schema"):
        serve_local._executor_integration_environment(
            {
                "TEAMS_ENABLED": "true",
                "TEAMS_NAVIGATOR_HMAC_KEY": "teams-ingress-test-key-0123456789abcdef",
                "TEAMS_TENANT_ID": tenant_id,
                "TEAMS_ALLOWED_TEAM_IDS": "team-1",
                "TEAMS_BOT_APP_ID": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "TEAMS_TASK_ACTOR_SUBJECTS_FILE": str(actor_file),
                "TEAMS_EXCHANGE_CONNECTION_REF": "22222222-2222-4222-8222-222222222222",
                "TEAMS_EXCHANGE_PROFILE_REF": "teams-profile-1",
                "CYRENE_EXCHANGE_CONNECTOR_INTERNAL_URL": "https://exchange.example.test",
                "NAVIGATOR_EXCHANGE_HMAC_KEY_FILE": str(tmp_path / "missing.key"),
                "NAVIGATOR_EXCHANGE_HMAC_KEY_ID": "navigator-prod-v1",
                "CYRENE_CONNECTOR_BINDINGS_FILE": str(tmp_path / "missing-bindings.json"),
                "CYRENE_CONNECTOR_TOOL_CATALOG_FILE": str(tmp_path / "connector-tool-catalog.json"),
            },
            workspace_id=workspace_id,
        )


def test_exchange_cli_bearer_requires_a_trusted_single_session_binding() -> None:
    """The local supervisor rejects a process Bearer with no explicit DSH session."""

    with pytest.raises(ValueError, match="explicit trusted DSH session binding"):
        serve_local._executor_integration_environment(
            {
                "CYRENE_EXCHANGE_INTEGRATION_URL": "https://exchange.example.test",
                "CYRENE_EXCHANGE_INTEGRATION_USER_TOKEN": "bearer-must-not-be-forwarded",
            },
            workspace_id="round1-workspace",
        )


def test_generated_owner_is_harness_writer_and_custom_owner_must_opt_in(tmp_path: Path) -> None:
    """The launcher grants its scoped owner writes and requires that grant in custom config."""

    generated, path, is_temporary = serve_local._resolve_principal_config(
        None,
        workspace_id="round1-workspace",
        organization_id="round1-organization",
        actor_id="round1-owner",
        principal_token_env="CYRENE_SESSION_TOKEN",
    )
    assert path is None and is_temporary
    assert generated["principals"][0]["can_write_harness"] is True

    custom_path = tmp_path / "principal.json"
    custom_path.write_text(
        json.dumps(
            {
                "principals": [
                    {
                        "token_env": "CYRENE_SESSION_TOKEN",
                        "actor_id": "round1-owner",
                        "workspace_ids": ["round1-workspace"],
                        "organization_id": "round1-organization",
                        "can_takeover": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="explicitly grant Harness writes"):
        serve_local._resolve_principal_config(
            custom_path,
            workspace_id="round1-workspace",
            organization_id="round1-organization",
            actor_id="round1-owner",
            principal_token_env="CYRENE_SESSION_TOKEN",
        )


def test_wecom_environment_references_reach_only_persistence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Forward explicit bot/CLI-host refs without leaking them to the Web Host."""

    config = {
        "principals": [{"token_env": "ROUND1_OWNER"}],
        "work_connectors": [
            {
                "config": {
                    "bot_secret_env_ref": "ROUND1_BOT_SECRET",
                    "navigator": {"secret_env_ref": "ROUND1_OWNER"},
                }
            }
        ],
    }
    monkeypatch.setenv("ROUND1_BOT_SECRET", "fixture-bot-secret")
    monkeypatch.setenv("UNRELATED_SECRET", "do-not-forward")
    references = serve_local._environment_references(config)
    assert references == {"ROUND1_OWNER", "ROUND1_BOT_SECRET"}
    persistence = serve_local._persistence_child_environment(
        tmp_path, "fixture-owner", "ROUND1_OWNER", references
    )
    assert persistence["ROUND1_BOT_SECRET"] == "fixture-bot-secret"
    assert "UNRELATED_SECRET" not in persistence
    web = serve_local._web_child_environment(
        repository=tmp_path,
        session_token="fixture-owner",
        executor_token="fixture-executor",
        workspace_id="fixture-workspace",
    )
    assert "ROUND1_BOT_SECRET" not in web


def test_tls_file_references_and_trust_roots_reach_only_required_children(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pass TLS files only to persistence and CA trust only to HTTP clients."""

    monkeypatch.setenv("CYRENE_PERSISTENCE_TLS_CERT_FILE", "/run/secrets/persistence-cert")
    monkeypatch.setenv("CYRENE_PERSISTENCE_TLS_KEY_FILE", "/run/secrets/persistence-key")
    monkeypatch.setenv("SSL_CERT_FILE", "/run/config/system-plus-internal-ca.pem")
    monkeypatch.setenv("REQUESTS_CA_BUNDLE", "/run/config/system-plus-internal-ca.pem")
    monkeypatch.setenv("NODE_EXTRA_CA_CERTS", "/run/secrets/internal-service-root-ca")
    monkeypatch.setenv("UNRELATED_TLS_SECRET", "must-not-cross-process-boundary")

    persistence = serve_local._persistence_child_environment(
        tmp_path, "session-token", "CYRENE_SESSION_TOKEN", set()
    )
    web = serve_local._web_child_environment(
        repository=tmp_path,
        session_token="session-token",
        executor_token="executor-token",
        workspace_id="workspace-1",
    )
    executor = serve_local._executor_child_environment(
        repository=tmp_path,
        persistence_url="https://127.0.0.1:3001",
        workspace_id="workspace-1",
        session_token="session-token",
        executor_token="executor-token",
        dsh_home=tmp_path / "dsh",
        plugins_dir=tmp_path / "plugins",
        node="node",
    )

    assert persistence["CYRENE_PERSISTENCE_TLS_CERT_FILE"] == "/run/secrets/persistence-cert"
    assert persistence["CYRENE_PERSISTENCE_TLS_KEY_FILE"] == "/run/secrets/persistence-key"
    assert persistence["SSL_CERT_FILE"] == "/run/config/system-plus-internal-ca.pem"
    assert web["SSL_CERT_FILE"] == "/run/config/system-plus-internal-ca.pem"
    assert web["REQUESTS_CA_BUNDLE"] == "/run/config/system-plus-internal-ca.pem"
    assert "CYRENE_PERSISTENCE_TLS_KEY_FILE" not in web
    assert executor["NODE_EXTRA_CA_CERTS"] == "/run/secrets/internal-service-root-ca"
    assert executor["SSL_CERT_FILE"] == "/run/config/system-plus-internal-ca.pem"
    for environment in (persistence, web, executor):
        assert "UNRELATED_TLS_SECRET" not in environment


def test_persistence_url_preserves_https_and_rejects_unknown_schemes() -> None:
    """Keep the listener's secure scheme and reject untrusted startup values."""

    assert (
        serve_local._persistence_url(
            {
                "service": "cyrene-persistence",
                "host": "127.0.0.1",
                "port": 8080,
                "scheme": "https",
            }
        )
        == "https://127.0.0.1:8080"
    )
    with pytest.raises(RuntimeError, match="invalid listener address"):
        serve_local._persistence_url(
            {
                "service": "cyrene-persistence",
                "host": "127.0.0.1",
                "port": 8080,
                "scheme": "file",
            }
        )
    with pytest.raises(RuntimeError, match="invalid listener address"):
        serve_local._persistence_url(
            {
                "service": "cyrene-persistence",
                "host": [],
                "port": True,
                "scheme": [],
            }
        )
