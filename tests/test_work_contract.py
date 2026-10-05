"""Keep public Work paths, methods, and referenced schemas reviewable.

中文：校验已发布 Work 契约与实际路径、方法和 schema 一致。
"""

from __future__ import annotations

import json
from pathlib import Path

from openapi_spec_validator import validate

from cyrene_navigator.persistence import create_persistence_app


def test_published_work_contract_matches_runtime(tmp_path: Path) -> None:
    """Detect undocumented route or wire-schema changes. | 发现未记录的接口变更。"""

    contract_path = Path(__file__).parents[1] / "contracts/product/v1/work.openapi.json"
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    validate(contract)
    runtime = create_persistence_app(tmp_path / "contract.sqlite3", {}).openapi()
    work_paths = {
        path: operation
        for path, operation in runtime["paths"].items()
        if path.startswith("/api/v1/workspaces/")
    }
    assert contract["paths"] == work_paths
    assert contract["security"] == [{"NavigatorBearer": []}]
    for name, schema in contract["components"]["schemas"].items():
        assert schema == runtime["components"]["schemas"][name]
