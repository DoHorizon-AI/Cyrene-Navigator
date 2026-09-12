"""
┌─────────────────────────────────────────────────────────────────────┐
│ Module: Navigator local Artifact adapter                            │
│ Role: Publish immutable Navigator exports without a Platform SDK.   │
│ 模块职责：由 Navigator 直接发布不可变导出，不依赖 Platform SDK。       │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class ArtifactPublicationError(RuntimeError):
    """Raised when a local Artifact cannot be committed or verified."""


@dataclass(frozen=True)
class ArtifactReference:
    """Provider-neutral ArtifactRef projection returned to Echo."""

    uri: str
    digest: str
    size_bytes: int
    kind: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "uri": self.uri,
            "digest": self.digest,
            "size_bytes": self.size_bytes,
            "kind": self.kind,
        }


class LocalArtifactStore:
    """Navigator-owned adapter for a local immutable content-addressed store."""

    def __init__(self, root: Path) -> None:
        if root.is_symlink():
            raise ArtifactPublicationError("artifact root must not be a symbolic link")
        self.root = root
        self._temporary = root / "tmp"
        self._blobs = root / "blobs" / "sha256"
        self._temporary.mkdir(parents=True, exist_ok=True)
        self._blobs.mkdir(parents=True, exist_ok=True)

    def publish_bytes(self, payload: bytes, *, kind: str) -> ArtifactReference:
        """Commit bytes once and return their standard content identity."""

        if not isinstance(payload, bytes):
            raise TypeError("artifact payload must be bytes")
        normalized_kind = self._validate_kind(kind)
        digest_hex = hashlib.sha256(payload).hexdigest()
        digest = f"sha256:{digest_hex}"
        target = self._blobs / digest_hex[:2] / digest_hex
        target.parent.mkdir(parents=True, exist_ok=True)

        descriptor, temporary_name = tempfile.mkstemp(prefix="publish-", dir=self._temporary)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.link(temporary, target)
            except FileExistsError:
                self._verify_existing(target, digest_hex, len(payload))
        except OSError as exc:
            raise ArtifactPublicationError("artifact bytes could not be committed") from exc
        finally:
            temporary.unlink(missing_ok=True)

        return ArtifactReference(
            uri=f"artifact://sha256/{digest_hex}",
            digest=digest,
            size_bytes=len(payload),
            kind=normalized_kind,
        )

    @staticmethod
    def _validate_kind(kind: str) -> str:
        if (
            not isinstance(kind, str)
            or not kind.strip()
            or len(kind) > 128
            or any(ord(character) < 32 for character in kind)
        ):
            raise ValueError("artifact kind must be a bounded non-empty identifier")
        return kind

    @staticmethod
    def _verify_existing(path: Path, digest_hex: str, size_bytes: int) -> None:
        if path.is_symlink() or not path.is_file() or path.stat().st_size != size_bytes:
            raise ArtifactPublicationError("existing artifact blob does not match its identity")
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest_hex:
            raise ArtifactPublicationError("existing artifact blob failed integrity verification")
