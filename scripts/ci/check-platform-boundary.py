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

    if problems:
        raise SystemExit("Navigator boundary check failed:\n- " + "\n- ".join(problems))
    print("Navigator Platform-independence and Product-boundary checks passed")


if __name__ == "__main__":
    main()
