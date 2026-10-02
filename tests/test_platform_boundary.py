"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 test_platform_boundary.py                                       │
│  Module: tests.test_platform_boundary                               │
│  Role: Pin the exact Navigator release-workflow exception boundary. │
│                                                                     │
│  模块职责：锁定 Navigator 发布 workflow 的精确例外边界。              │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from runpy import run_path
from typing import cast

_BOUNDARY_SCRIPT = Path(__file__).parents[1] / "scripts/ci/check-platform-boundary.py"
_WORKFLOW_PATH = ".github/workflows/component-release.yml"
_TEXT_PROBLEMS = cast(
    Callable[[str, str], list[str]],
    run_path(str(_BOUNDARY_SCRIPT), run_name="navigator_platform_boundary_test_import")[
        "text_problems"
    ],
)


def test_attested_sdk_publisher_coordinate_is_allowed_in_release_workflow() -> None:
    repository_coordinate = "DoHorizon-AI/" + "Cyrene-" + "Platform"

    assert _TEXT_PROBLEMS(_WORKFLOW_PATH, f"repository: {repository_coordinate}") == []


def test_attested_sdk_publisher_coordinate_remains_forbidden_in_dockerfile() -> None:
    repository_coordinate = "DoHorizon-AI/" + "Cyrene-" + "Platform"

    assert _TEXT_PROBLEMS("Dockerfile", f"repository: {repository_coordinate}") == [
        f"Dockerfile: contains {repository_coordinate!r} (Platform source dependency)"
    ]


def test_release_workflow_still_rejects_other_forbidden_platform_surfaces() -> None:
    retired_package = "cyrene" + "-artifacts"

    assert _TEXT_PROBLEMS(_WORKFLOW_PATH, f"import {retired_package}") == [
        f"{_WORKFLOW_PATH}: contains {retired_package!r} (Platform Python source dependency)"
    ]
