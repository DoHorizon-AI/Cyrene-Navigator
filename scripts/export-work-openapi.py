"""Export the authenticated Work API contract from the runnable service.

中文：从可运行服务导出带认证声明的 Work API 契约。
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from cyrene_navigator.persistence import create_persistence_app


def export_contract() -> dict[str, Any]:
    """Keep Work paths and their transitive schema references. | 保留 Work 路径与引用。"""

    with tempfile.TemporaryDirectory(prefix="navigator-work-contract-") as directory:
        source = create_persistence_app(Path(directory) / "contract.sqlite3", {}).openapi()
    paths = {
        path: operation
        for path, operation in source["paths"].items()
        if path.startswith("/api/v1/workspaces/")
    }
    schemas: dict[str, Any] = {}

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            reference = value.get("$ref", "")
            prefix = "#/components/schemas/"
            if isinstance(reference, str) and reference.startswith(prefix):
                name = reference[len(prefix) :]
                if name not in schemas:
                    schemas[name] = source["components"]["schemas"][name]
                    visit(schemas[name])
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(paths)
    return {
        "openapi": source["openapi"],
        "info": {"title": "Navigator Work API / 工作助手接口", "version": "1.0.0"},
        "security": [{"NavigatorBearer": []}],
        "paths": paths,
        "components": {
            "schemas": schemas,
            "securitySchemes": {"NavigatorBearer": {"type": "http", "scheme": "bearer"}},
        },
    }


if __name__ == "__main__":
    target = Path(__file__).parents[1] / "contracts/product/v1/work.openapi.json"
    target.write_text(
        json.dumps(export_contract(), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
