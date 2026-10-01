"""Enforce Navigator's product-owned adapter and Platform independence boundary.

中文:检查 Navigator 自有 Product adapter 与 Platform 解耦边界。
"""
# 中文:强制执行 Navigator 的 Product 所有适配器边界,并确保其独立于 Platform。

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IGNORED_PARTS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".upstream",
    ".venv",
    "bin",
    "dist",
    "node_modules",
    "obj",
    "target",
}
TEXT_SUFFIXES = {
    ".cs",
    ".csproj",
    ".json",
    ".lock",
    ".md",
    ".mjs",
    ".ps1",
    ".py",
    ".rs",
    ".toml",
    ".ts",
    ".yaml",
    ".yml",
}
FORBIDDEN_TEXT = {
    "ArtifactKind.DATASET": "closed Platform artifact kind",
    "CYRENE_MANIFEST_BINARY": "retired Platform manifest process",
    "CYRENE_CY_MANIFEST": "retired Platform manifest process",
    "CYRENE_PLATFORM": "Platform source-checkout environment coupling",
    "Cyrene-Platform.git": "Platform source dependency",
    "DoHorizon-AI/Cyrene-Platform": "Platform source dependency",
    "PlatformRef": "Platform source pin",
    "PlatformRoot": "Platform source checkout",
    "cy-manifest": "retired Platform manifest process",
    "cy_artifacts": "Platform Python source dependency",
    "cyrene-artifacts": "Platform Python source dependency",
    "build-native-tools": "retired Platform-coupled build entry point",
    "native-tools.json": "retired multi-repository native tool record",
    "service.json": "retired Navigator service manifest reference",
}
COMPONENT_RELEASE_WORKFLOW = ".github/workflows/component-release.yml"
# The release workflow verifies the attested SDK index and checks out tools at the
# source commit named by that index. This publisher/tooling coordinate is not a
# Navigator runtime or Product image source dependency.
# 中文: 发布 workflow 校验经过 attestation 的 SDK 索引,并按索引固定的提交检出工具。
# 该发布方/工具坐标不构成 Navigator 运行时或 Product 镜像源码依赖。
ALLOWED_TEXT_BY_PATH = {
    COMPONENT_RELEASE_WORKFLOW: {
        "DoHorizon-AI/Cyrene-Platform": "attested SDK publisher and pinned release tooling",
    },
}
FORBIDDEN_PATHS = {
    "harness/src/native.ts",
    "scripts/ci/prepare-platform.mjs",
    "service.json",
}


def repository_files() -> list[Path]:
    return [
        path
        for path in ROOT.rglob("*")
        if path.is_file()
        and path.suffix in TEXT_SUFFIXES
        and path != Path(__file__).resolve()
        and not any(part in IGNORED_PARTS for part in path.relative_to(ROOT).parts)
    ]


def text_problems(relative: str, content: str) -> list[str]:
    """Find forbidden text while honoring only explicit path-scoped allowances.

    按路径范围处理明确允许的发布期标识，其余禁用文本继续全量检查。

    Args:
        relative: POSIX repository-relative path.
        content: UTF-8 text to inspect.
    Returns:
        Boundary violations found in the supplied text.
    """
    allowed = ALLOWED_TEXT_BY_PATH.get(relative, {})
    return [
        f"{relative}: contains {needle!r} ({reason})"
        for needle, reason in FORBIDDEN_TEXT.items()
        if needle in content and needle not in allowed
    ]


def main() -> None:
    problems: list[str] = []
    for relative in sorted(FORBIDDEN_PATHS):
        if (ROOT / relative).exists():
            problems.append(f"retired path remains: {relative}")

    files = repository_files()
    for path in files:
        relative = path.relative_to(ROOT).as_posix()
        content = path.read_text(encoding="utf-8-sig", errors="replace")
        problems.extend(text_problems(relative, content))

    if problems:
        raise SystemExit("Navigator boundary check failed:\n- " + "\n- ".join(problems))
    print("Navigator Platform-independence and Product-boundary checks passed")


if __name__ == "__main__":
    main()
