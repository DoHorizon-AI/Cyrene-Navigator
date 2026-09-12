"""Navigator-owned local Artifact adapter regressions. | 本地 Artifact 适配器回归。"""

from __future__ import annotations

from pathlib import Path

import pytest

from cyrene_navigator.persistence.artifacts import ArtifactPublicationError, LocalArtifactStore


def test_publish_bytes_returns_an_open_producer_owned_kind(tmp_path: Path) -> None:
    store = LocalArtifactStore(tmp_path / "artifacts")
    first = store.publish_bytes(b"navigator export\n", kind="navigator-text-jsonl-v1")
    second = store.publish_bytes(b"navigator export\n", kind="navigator-text-jsonl-v1")

    assert first == second
    assert first.kind == "navigator-text-jsonl-v1"
    assert first.uri.removeprefix("artifact://sha256/") == first.digest.removeprefix("sha256:")
    assert first.to_dict() == {
        "uri": first.uri,
        "digest": first.digest,
        "size_bytes": 17,
        "kind": "navigator-text-jsonl-v1",
    }


def test_publish_bytes_rejects_a_corrupt_existing_blob(tmp_path: Path) -> None:
    store = LocalArtifactStore(tmp_path / "artifacts")
    reference = store.publish_bytes(b"trusted", kind="navigator-text-jsonl-v1")
    digest_hex = reference.digest.removeprefix("sha256:")
    blob = store.root / "blobs" / "sha256" / digest_hex[:2] / digest_hex
    blob.write_bytes(b"corrupt")

    with pytest.raises(ArtifactPublicationError):
        store.publish_bytes(b"trusted", kind="navigator-text-jsonl-v1")
