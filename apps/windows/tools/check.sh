#!/usr/bin/env bash
# tools/check.sh — offline verification for the Navigator Windows client.
#
# Runs the checks that are possible without a Windows machine:
#   1. Full C# type check of every non-XAML source file, Debug (real Roslyn compile).
#   2. Full C# type check of the Release path, where preview fixtures are excluded.
#   3. XAML well-formedness + resource-key cross-check.
#   4. UI-to-adapter boundary check: Views and Controls cannot import Mock fixtures.
#   5. Headless API-adapter behaviour check: real Core/Api sources against scripted HTTP.
#
# 在没有 Windows 机器时对整个客户端做真实校验：全量类型检查（Debug 与 Release）、
# XAML 静态校验、UI 边界检查，以及 API 适配层行为检查。

set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
FAIL=0

echo "== 1/5 C# type check, Debug (net8.0-windows via EnableWindowsTargeting) =="
if dotnet build tools/typecheck/TypeCheck.csproj -c Debug -t:Build -v q --nologo; then
  echo "   OK"
else
  echo "   FAILED"
  FAIL=1
fi

echo
echo "== 2/5 C# type check, Release (preview fixtures excluded) =="
if dotnet build tools/typecheck/TypeCheck.csproj -c Release -t:Build -v q --nologo; then
  echo "   OK"
else
  echo "   FAILED"
  FAIL=1
fi

echo
echo "== 3/5 XAML static check =="
if python3 tools/xamlcheck.py "$ROOT/src/Cyrene.Navigator.Windows"; then
  echo "   OK"
else
  echo "   FAILED"
  FAIL=1
fi

echo
echo "== 4/5 UI adapter boundary check =="
if rg -n 'Cyrene\.Navigator\.Windows\.Core\.Mock|MockModels|MockUsage|MockToolEvents|MockWorkspace' \
  src/Cyrene.Navigator.Windows/Controls src/Cyrene.Navigator.Windows/Views; then
  echo "   FAILED: UI views/controls import composition-root fixtures."
  FAIL=1
else
  echo "   OK: only the composition root may depend on Core/Mock, and only in Debug."
fi

echo
echo "== 5/5 API adapter behaviour check (headless) =="
if dotnet run --project tools/adaptercheck/ApiAdapterCheck.csproj -v q --nologo; then
  echo "   OK"
else
  echo "   FAILED"
  FAIL=1
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "All offline checks passed."
else
  echo "Offline checks reported problems."
fi
exit "$FAIL"
