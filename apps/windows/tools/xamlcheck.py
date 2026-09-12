#!/usr/bin/env python3
"""tools/xamlcheck.py — static validation for the prototype's (small) XAML surface.

The WinUI XAML compiler only runs on Windows, so this script covers the failure modes that
would otherwise only surface at build time on another machine:

1. XML well-formedness of every ``.xaml`` file.
2. Duplicate ``x:Key`` inside the same resource dictionary scope.
3. Every ``{StaticResource K}`` / ``{ThemeResource K}`` reference resolves to a key that is
   either defined locally, defined in a sibling dictionary, or is a known WinUI system key.
4. Every ``x:Class`` has a matching ``.xaml.cs`` next to it.
5. Hex colours duplicated into ``Themes/Overrides.xaml`` still agree with ``Design/Palette.cs``.

用途：在没有 Windows 的环境里，尽量把 XAML 层的编译期错误提前暴露出来。
"""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

X = "{http://schemas.microsoft.com/winfx/2006/xaml}"

# WinUI ships thousands of theme resources; we only need to recognise the ones this prototype
# intentionally overrides or consumes so that unknown keys still get flagged.
KNOWN_SYSTEM_PREFIXES = (
    "System",
    "Text",
    "Control",
    "Accent",
    "Subtle",
    "Solid",
    "Layer",
    "Card",
    "Focus",
    "Overlay",
    "Divider",
    "Surface",
    "App",
    "Menu",
    "Flyout",
    "ContentDialog",
    "ToolTip",
    "ScrollBar",
    "ListView",
    "GridView",
    "Button",
    "TextControl",
    "ToggleSwitch",
    "CheckBox",
    "RadioButton",
    "ComboBox",
    "Expander",
    "TeachingTip",
    "CommandBar",
    "AutoSuggest",
    "Slider",
    "ProgressBar",
    "ProgressRing",
    "NavigationView",
    "Body",
    "Caption",
    "Title",
    "Subtitle",
    "Display",
    "Default",
)


def main(root: Path) -> int:
    files = sorted(root.rglob("*.xaml"))
    files = [f for f in files if "obj" not in f.parts and "bin" not in f.parts]
    if not files:
        print("   no .xaml files found (code-first UI) — nothing to check")
        return 0

    problems: list[str] = []
    defined: dict[str, list[Path]] = {}
    referenced: list[tuple[str, Path]] = []

    for path in files:
        text = path.read_text(encoding="utf-8")

        # (1) well-formedness
        try:
            tree = ET.fromstring(text)
        except ET.ParseError as exc:
            problems.append(f"{path}: malformed XML — {exc}")
            continue

        # (2) duplicate keys, scoped per resource dictionary — the same semantic key appears
        #     once per theme dictionary by design, so scoping matters.
        for scope in tree.iter():
            if not scope.tag.endswith("ResourceDictionary"):
                continue

            seen: set[str] = set()
            for node in list(scope):
                key = node.get(f"{X}Key")
                if key is None:
                    continue
                if key in seen:
                    problems.append(f"{path}: duplicate x:Key '{key}' in the same dictionary")
                seen.add(key)

        for node in tree.iter():
            key = node.get(f"{X}Key")
            if key is not None:
                defined.setdefault(key, []).append(path)

        # (3) resource references
        for match in re.finditer(r"\{(?:StaticResource|ThemeResource)\s+([A-Za-z0-9_.]+)\s*\}", text):
            referenced.append((match.group(1), path))

        # (4) code-behind presence
        cls = tree.get(f"{X}Class")
        if cls is not None:
            companion = path.with_suffix(path.suffix + ".cs")
            if not companion.exists():
                problems.append(f"{path}: x:Class='{cls}' but {companion.name} is missing")

    for key, path in referenced:
        if key in defined:
            continue
        if key.startswith(KNOWN_SYSTEM_PREFIXES):
            continue
        problems.append(f"{path}: resource reference '{key}' is not defined and is not a known system key")

    problems.extend(check_palette_agreement(root))

    for line in problems:
        print(f"   {line}")

    print(f"   checked {len(files)} xaml file(s), {len(defined)} key(s), {len(referenced)} reference(s)")
    return 1 if problems else 0


# Semantic token name in Overrides.xaml -> palette member it must equal.
PALETTE_CONTRACT = {
    "Light": {
        "TextFillColorPrimary": "Ink",
        "TextFillColorSecondary": "Slate",
        "TextFillColorTertiary": "Muted",
        "AccentFillColorDefault": "Ink",
        "ControlFillColorDefault": "Paper",
        "ControlFillColorSecondary": "SandDeep",
        "ControlStrokeColorDefault": "Hair",
        "SubtleFillColorSecondary": "SandDeep",
        "SolidBackgroundFillColorBase": "Paper",
        "SolidBackgroundFillColorSecondary": "Sand",
        "CardStrokeColorDefault": "Hair",
        "DividerStrokeColorDefault": "Hair",
        "FocusStrokeColorOuter": "Orchid",
        "SystemFillColorSuccess": "Success",
    },
    "Default": {
        "TextFillColorPrimary": "Ink",
        "TextFillColorSecondary": "Slate",
        "TextFillColorTertiary": "Muted",
        "ControlFillColorDefault": "Sand",
        "ControlStrokeColorDefault": "Hair",
        "SolidBackgroundFillColorBase": "Paper",
        "SolidBackgroundFillColorSecondary": "Sand",
        "FocusStrokeColorOuter": "Orchid",
        "SystemFillColorSuccess": "Success",
    },
}


def check_palette_agreement(root: Path) -> list[str]:
    """Overrides.xaml duplicates palette hexes by necessity; keep the copies honest."""
    palette_file = root / "Design" / "Palette.cs"
    overrides = root / "Themes" / "Overrides.xaml"
    if not palette_file.exists() or not overrides.exists():
        return []

    source = palette_file.read_text(encoding="utf-8")
    palettes: dict[str, dict[str, str]] = {}
    for theme, marker in (("Light", "Palette Light = new()"), ("Default", "Palette Dark = new()")):
        start = source.find(marker)
        if start < 0:
            continue
        block = source[start : source.find("};", start)]
        found: dict[str, str] = {}
        for member, r, g, b in re.findall(r"(\w+)\s*=\s*Rgb\(0x([0-9A-Fa-f]{2}),\s*0x([0-9A-Fa-f]{2}),\s*0x([0-9A-Fa-f]{2})\)", block):
            found[member] = f"#{r}{g}{b}".upper()
        palettes[theme] = found

    text = overrides.read_text(encoding="utf-8")
    problems: list[str] = []
    for theme, contract in PALETTE_CONTRACT.items():
        marker = f'x:Key="{theme}"'
        start = text.find(marker)
        if start < 0:
            problems.append(f"Themes/Overrides.xaml: missing theme dictionary '{theme}'")
            continue

        end = text.find("</ResourceDictionary>", start)
        block = text[start:end]
        for key, member in contract.items():
            match = re.search(rf'<Color x:Key="{key}">(#[0-9A-Fa-f]{{6}})</Color>', block)
            if match is None:
                problems.append(f"Themes/Overrides.xaml [{theme}]: '{key}' is not overridden")
                continue

            expected = palettes.get(theme, {}).get(member)
            if expected is None:
                problems.append(f"Design/Palette.cs: '{member}' not found for {theme}")
            elif match.group(1).upper() != expected:
                problems.append(
                    f"Themes/Overrides.xaml [{theme}]: '{key}' is {match.group(1)} "
                    f"but Palette.{member} is {expected}"
                )

    return problems


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("src")
    sys.exit(main(target))
