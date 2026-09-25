"""
┌─────────────────────────────────────────────────────────────────────┐
│  📄 errors.py                                                       │
│  Module: cyrene_navigator.errors                                    │
│  Role: Canonical error catalog and mappings for Cyrene Navigator.   │
│                                                                     │
│  模块职责：Navigator 聚合与导航服务规范错误命名空间与恢复动作映射。          │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

# ════════════════════════════════════════════════════════════════════════
# Canonical Cyrene Navigator Error Catalog & Mappings
# ════════════════════════════════════════════════════════════════════════
# 中文:Cyrene Navigator 规范错误目录与映射。
NAVIGATOR_ERROR_MAPPINGS: dict[str, dict[str, str]] = {
    "NAVIGATOR_REQUEST_INVALID": {
        "code": "PRODUCT.NAVIGATOR.REQUEST_INVALID",
        "cause_kind": "validation",
        "recovery_action": "fix_configuration",
    },
    "NAVIGATOR_PERMISSION_DENIED": {
        "code": "PRODUCT.NAVIGATOR.PERMISSION_DENIED",
        "cause_kind": "permission",
        "recovery_action": "fix_configuration",
    },
    "NAVIGATOR_PAIRING_CODE_INVALID": {
        "code": "PRODUCT.NAVIGATOR.PAIRING_INVALID",
        "cause_kind": "credential",
        "recovery_action": "user_action_required",
    },
    "NAVIGATOR_PAIRING_CODE_EXPIRED": {
        "code": "PRODUCT.NAVIGATOR.PAIRING_EXPIRED",
        "cause_kind": "credential",
        "recovery_action": "user_action_required",
    },
    "NAVIGATOR_SESSION_EXPIRED": {
        "code": "PRODUCT.NAVIGATOR.SESSION_EXPIRED",
        "cause_kind": "session",
        "recovery_action": "user_action_required",
    },
    "NAVIGATOR_CSRF_INVALID": {
        "code": "PRODUCT.NAVIGATOR.CSRF_INVALID",
        "cause_kind": "security",
        "recovery_action": "safely_retry",
    },
    "NAVIGATOR_UPSTREAM_UNAVAILABLE": {
        "code": "PRODUCT.NAVIGATOR.UPSTREAM_UNAVAILABLE",
        "cause_kind": "infrastructure",
        "recovery_action": "query_state_first",
    },
    "NAVIGATOR_RESOURCE_NOT_FOUND": {
        "code": "PRODUCT.NAVIGATOR.RESOURCE_NOT_FOUND",
        "cause_kind": "not_found",
        "recovery_action": "user_action_required",
    },
}


def map_navigator_error(raw_code: str) -> dict[str, str]:
    """Map a raw or legacy Navigator error code to canonical PRODUCT.NAVIGATOR.<REASON>.

    中文:将原始或旧版 Navigator 错误码映射为标准的 PRODUCT.NAVIGATOR.<REASON>。
    """
# 中文:将原始或旧版 Navigator 错误代码映射为规范的 PRODUCT.NAVIGATOR.<REASON>。
    if raw_code in NAVIGATOR_ERROR_MAPPINGS:
        return NAVIGATOR_ERROR_MAPPINGS[raw_code]
    normalized = raw_code.upper().replace(" ", "_")
    if not normalized.startswith("PRODUCT.NAVIGATOR."):
        clean_name = normalized.removeprefix("NAVIGATOR_")
        canonical = f"PRODUCT.NAVIGATOR.{clean_name}"
    else:
        canonical = normalized
    return {
        "code": canonical,
        "cause_kind": "unknown",
        "recovery_action": "query_state_first",
    }
