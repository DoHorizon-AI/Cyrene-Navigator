"""Enforce Navigator's product-owned adapter and Platform independence boundary."""

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
FORBIDDEN_PATHS = {
    "harness/src/native.ts",
    "scripts/ci/prepare-platform.mjs",
    "service.json",
}


MOCK_REFERENCES = (
    "Core.Mock",
    "MockConversationService",
    "MockAgentState",
    "MockUiData",
    "MockModels",
    "MockUsage",
    "MockToolEvents",
    "MockWorkspace",
)


def mock_references_outside_debug(app_root: Path) -> list[str]:
    """Fixture references outside Core/Mock must live inside #if DEBUG blocks.

    Release builds exclude Core/Mock entirely, so a reference outside a DEBUG block cannot
    compile in Release; this check reports the same defect in the working tree.
    """

    problems: list[str] = []
    if not app_root.is_dir():
        return [f"Windows client source root missing: {app_root}"]

    for path in sorted(app_root.rglob("*.cs")):
        relative = path.relative_to(app_root)
        if relative.parts[:2] == ("Core", "Mock"):
            continue

        stack: list[bool] = []
        for number, line in enumerate(
            path.read_text(encoding="utf-8-sig", errors="replace").splitlines(), 1
        ):
            stripped = line.strip()
            if stripped.startswith("#if"):
                stack.append("DEBUG" in stripped)
                continue
            if stripped.startswith("#else") and stack:
                stack[-1] = False
                continue
            if stripped.startswith("#endif") and stack:
                stack.pop()
                continue
            if not any(stack) and any(needle in line for needle in MOCK_REFERENCES):
                problems.append(
                    f"{relative}:{number}: preview fixture reference outside #if DEBUG"
                )

    return problems


def repository_files() -> list[Path]:
    return [
        path
        for path in ROOT.rglob("*")
        if path.is_file()
        and path.suffix in TEXT_SUFFIXES
        and path != Path(__file__).resolve()
        and not any(part in IGNORED_PARTS for part in path.relative_to(ROOT).parts)
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
        for needle, reason in FORBIDDEN_TEXT.items():
            if needle in content:
                problems.append(f"{relative}: contains {needle!r} ({reason})")

    app_root = ROOT / "apps/windows/src/Cyrene.Navigator.Windows"
    winui_project = app_root / "Cyrene.Navigator.Windows.csproj"
    project = winui_project.read_text(encoding="utf-8-sig")
    if "<CyreneLifecycle>API_CONNECTED_PROTOTYPE</CyreneLifecycle>" not in project:
        problems.append("Windows client must declare the API-connected lifecycle")
    if "Core/Mock" not in project or "<Compile Remove=" not in project:
        problems.append("Windows Release build must exclude Core/Mock fixtures")

    api_client = app_root / "Core/Api/NavigatorApiClient.cs"
    composition = app_root / "PortComposition.cs"
    if not api_client.is_file():
        problems.append("Navigator API client adapter is missing")
    elif (
        not composition.is_file()
        or "NavigatorApiOptions.TryFromEnvironment" not in composition.read_text(encoding="utf-8-sig")
    ):
        problems.append("Composition root must select the Navigator API adapters")

    problems.extend(mock_references_outside_debug(app_root))

    for path in files:
        relative = path.relative_to(ROOT).as_posix()
        if relative.startswith("apps/windows/"):
            continue
        if "MockConversationService" in path.read_text(encoding="utf-8-sig", errors="replace"):
            problems.append(f"{relative}: Windows prototype mock escaped its allowed subtree")

    if problems:
        raise SystemExit("Navigator boundary check failed:\n- " + "\n- ".join(problems))
    print("Navigator Platform-independence and prototype-boundary checks passed")


if __name__ == "__main__":
    main()
