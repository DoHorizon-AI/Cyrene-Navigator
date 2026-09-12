"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 __init__.py                                                     │
│  Module: cyrene_navigator                                           │
│  Role: Public Navigator aggregation construction surface.            │
│                                                                     │
│  模块职责：导出 Navigator 聚合 API 创建入口。                            │
└─────────────────────────────────────────────────────────────────────┘
"""

from cyrene_navigator.api import create_app
from cyrene_navigator.domain import Product

__all__ = ["Product", "create_app"]
