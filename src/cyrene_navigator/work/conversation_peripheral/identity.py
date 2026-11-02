"""
┌─────────────────────────────────────────────────────────────────────┐
│ Module: Navigator Bilibili operation receipt identity                │
│ Role: Share the actor-scoped idempotency identity with verifiers.    │
│ 模块职责：让发送路由和回执校验复用同一范围化幂等键。                  │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import re


def bilibili_operation_idempotency_key(actor_scope_digest: str, logical_key: str) -> str:
    """Bind the host-issued logical key to an authenticated actor scope.

    This computes receipt identity only; it grants no operation authority.
    中文：只计算回执标识，不授予执行权限。
    """
    if re.fullmatch(r"[0-9a-f]{64}", actor_scope_digest) is None:
        raise ValueError("Bilibili operation actor scope digest is invalid")
    if (
        not logical_key
        or len(logical_key) > 200
        or any(ord(c) < 32 or ord(c) == 127 for c in logical_key)
    ):
        raise ValueError("Bilibili operation logical key is invalid")
    digest = hashlib.sha256(f"{actor_scope_digest}\0{logical_key}".encode()).hexdigest()
    return f"bilibili:{digest}"
