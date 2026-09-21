"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 __init__.py                                                     │
│  Module: cyrene_navigator                                           │
│  Role: Public Navigator app construction surfaces.                    │
│                                                                     │
│  模块职责：导出聚合与 Web Host 创建入口。                                 │
└─────────────────────────────────────────────────────────────────────┘
"""

from cyrene_navigator.api import create_app
from cyrene_navigator.domain import Product
from cyrene_navigator.web_host import (
    CredentialStore,
    ProxyTarget,
    create_web_host_app,
    generate_pairing_code,
)

__all__ = [
    "CredentialStore",
    "Product",
    "ProxyTarget",
    "create_app",
    "create_web_host_app",
    "generate_pairing_code",
]
