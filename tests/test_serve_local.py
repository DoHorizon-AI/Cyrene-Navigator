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
        "UNRELATED_SECRET": "must-not-cross-process-boundary",
    }

    forwarded = serve_local._executor_integration_environment(host_environment)

    assert forwarded["CYRENE_SUBAGENT_CONFIG"] == str(subagent_path.resolve())
    assert forwarded["CYRENE_CLOUD_PROFILE_CONFIG"] == str(cloud_path.resolve())
    assert forwarded["CYRENE_WORKFLOWS_ENABLED"] == "true"
    assert forwarded["ROUND1_SUBAGENT_TOKEN"] == "subagent-secret-value"
    assert forwarded["ROUND1_CLOUD_TOKEN"] == "cloud-secret-value"
    assert forwarded["ROUND1_AZURE_IDENTITY"] == "identity-secret-value"
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
    assert "UNRELATED_SECRET" not in executor_environment
    assert "ROUND1_CLOUD_TOKEN" not in web_environment
    assert "CYRENE_SUBAGENT_CONFIG" not in web_environment


def test_executor_profile_environment_fails_closed_for_malformed_config(tmp_path: Path) -> None:
    """Invalid JSON never reaches the executor as a partially loaded profile."""

    config_path = tmp_path / "invalid.json"
    config_path.write_text('{"profiles": [', encoding="utf-8")

    with pytest.raises(ValueError, match="could not be read as valid JSON"):
        serve_local._executor_integration_environment(
            {"CYRENE_CLOUD_PROFILE_CONFIG": str(config_path)}
        )


def test_workflow_flag_accepts_only_explicit_boolean_values() -> None:
    """The supervisor rejects ambiguous values before starting any child process."""

    with pytest.raises(ValueError, match="must be 'true' or 'false'"):
        serve_local._executor_integration_environment({"CYRENE_WORKFLOWS_ENABLED": "yes"})


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
