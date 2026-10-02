"""
┌─────────────────────────────────────────────────────────────────────────────┐
│  File: tools/release/product_contract_release.py                            │
│  Role: Package an owner-signed Product catalog with exact source metadata.   │
│                                                                             │
│  模块职责：将Product owner catalog与独立签名证明打包，保留精确来源信息。      │
└─────────────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

SOURCE_CATALOG_PATH = "contracts/product/v2/catalog.json"
WORKFLOW_PATH = ".github/workflows/product-contract.yml"
PREDICATE_TYPE = "https://slsa.dev/provenance/v1"
ALLOWED_REFS = {
    "refs/heads/develop",
    "refs/heads/main",
    "refs/heads/release",
}
REPOSITORIES = {
    "DoHorizon-AI/Cyrene-Catalyst": "catalyst",
    "DoHorizon-AI/Cyrene-Echo": "echo",
    "DoHorizon-AI/Cyrene-Exchange": "exchange",
    "DoHorizon-AI/Cyrene-Navigator": "navigator",
    "DoHorizon-AI/Cyrene-Reactor": "reactor",
    "DoHorizon-AI/Cyrene-Yield": "yield",
}
SHA1_PATTERN = re.compile(r"^[0-9a-f]{40}$")


class ReleaseError(ValueError):
    """Raised when a source catalog cannot be packaged with exact provenance."""


def _sha256(data: bytes) -> str:
    """Return a SHA-256 digest in the frozen proof schema's tagged format."""
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def _run_git(root: Path, *args: str) -> bytes:
    """Run a read-only Git command and return its exact stdout bytes."""
    try:
        return subprocess.run(
            ["git", "-C", str(root), *args],
            check=True,
            capture_output=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise ReleaseError(f"git {' '.join(args)} failed in {root}: {error}") from error


def _validate_source(
    root: Path, repository: str, source_ref: str, source_commit: str
) -> tuple[str, bytes]:
    """Validate the trusted owner, allowed ref, exact checkout, and catalog."""
    owner_id = REPOSITORIES.get(repository)
    if owner_id is None:
        raise ReleaseError(f"untrusted Product repository: {repository}")
    if source_ref not in ALLOWED_REFS:
        raise ReleaseError(f"source ref is not an approved release channel: {source_ref}")
    if not SHA1_PATTERN.fullmatch(source_commit):
        raise ReleaseError("source commit must be a lowercase 40-character Git SHA")

    head = _run_git(root, "rev-parse", "HEAD").decode("ascii").strip()
    if head != source_commit:
        raise ReleaseError(f"checkout HEAD {head} does not match source commit {source_commit}")

    catalog_bytes = _run_git(root, "show", f"{source_commit}:{SOURCE_CATALOG_PATH}")
    checkout_bytes = (root / SOURCE_CATALOG_PATH).read_bytes()
    if checkout_bytes != catalog_bytes:
        raise ReleaseError("checked-out catalog bytes differ from the requested source commit")
    try:
        catalog = json.loads(catalog_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReleaseError(f"source catalog is not valid UTF-8 JSON: {error}") from error
    if not isinstance(catalog, dict):
        raise ReleaseError("source catalog must be a JSON object")
    if catalog.get("schemaVersion") != "cyrene.product.operation-catalog.v2":
        raise ReleaseError("source catalog has an unexpected schemaVersion")
    if catalog.get("ownerId") != owner_id:
        raise ReleaseError(
            f"catalog ownerId {catalog.get('ownerId')!r} does not match {owner_id!r}"
        )
    return owner_id, catalog_bytes


def prepare(args: argparse.Namespace) -> None:
    """Copy only the exact committed catalog into the isolated artifact root."""
    root = Path(args.root).resolve()
    owner_id, catalog_bytes = _validate_source(root, args.repository, args.ref, args.commit)
    output = Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ReleaseError(f"output directory must be empty: {output}")
    catalog_output = output / SOURCE_CATALOG_PATH
    catalog_output.parent.mkdir(parents=True, exist_ok=True)
    catalog_output.write_bytes(catalog_bytes)
    (output / "attestations" / "owners").mkdir(parents=True, exist_ok=True)
    print(f"prepared {owner_id} catalog at {catalog_output}")


def _validate_bundle(bundle: Path) -> bytes:
    """Read a detached JSONL bundle without rewriting its signed bytes."""
    try:
        bundle_bytes = bundle.read_bytes()
    except OSError as error:
        raise ReleaseError(f"cannot read downloaded attestation bundle: {error}") from error
    if not bundle_bytes.strip():
        raise ReleaseError("downloaded attestation bundle is empty")
    lines = [line for line in bundle_bytes.splitlines() if line.strip()]
    if not lines:
        raise ReleaseError("downloaded attestation bundle contains no JSON records")
    for line_number, line in enumerate(lines, start=1):
        try:
            record = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ReleaseError(
                f"attestation bundle line {line_number} is not JSON: {error}"
            ) from error
        if not isinstance(record, dict):
            raise ReleaseError(f"attestation bundle line {line_number} is not an object")
    return bundle_bytes


def finalize(args: argparse.Namespace) -> None:
    """Attach the unchanged GitHub bundle and write one Workspace owner record."""
    root = Path(args.root).resolve()
    owner_id, source_catalog = _validate_source(root, args.repository, args.ref, args.commit)
    if not args.run_id.isdigit() or not args.run_attempt.isdigit():
        raise ReleaseError("GitHub Actions run id and attempt must be positive integers")
    if int(args.run_id) < 1 or int(args.run_attempt) < 1:
        raise ReleaseError("GitHub Actions run id and attempt must be positive integers")

    output = Path(args.output_dir).resolve()
    catalog_output = output / SOURCE_CATALOG_PATH
    if not catalog_output.is_file() or catalog_output.read_bytes() != source_catalog:
        raise ReleaseError("prepared artifact catalog does not match the source commit")

    bundle_source = Path(args.bundle).resolve()
    bundle_bytes = _validate_bundle(bundle_source)
    bundle_path = f"attestations/owners/{owner_id}.jsonl"
    bundle_output = output / bundle_path
    bundle_output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(bundle_source, bundle_output)
    if bundle_output.read_bytes() != bundle_bytes:
        raise ReleaseError("copied attestation bundle bytes changed")

    catalog_digest = _sha256(source_catalog)
    archive_catalog_path = f"{args.repository}/{SOURCE_CATALOG_PATH}"
    workflow_identity = f"{args.repository}/{WORKFLOW_PATH}"
    run_url = (
        f"https://github.com/{args.repository}/actions/runs/{args.run_id}"
        f"/attempts/{args.run_attempt}"
    )
    owner_publication: dict[str, Any] = {
        "ownerId": owner_id,
        "source": {
            "repository": args.repository,
            "ref": args.ref,
            "commit": args.commit,
        },
        "catalogPath": archive_catalog_path,
        "catalogSha256": catalog_digest,
        "provenance": {
            "attestation": {
                "attestation": {
                    "kind": "github-artifact-attestation",
                    "subjectName": Path(SOURCE_CATALOG_PATH).name,
                    "repository": args.repository,
                    "workflow": workflow_identity,
                    "predicateType": PREDICATE_TYPE,
                    "run": {
                        "id": args.run_id,
                        "attempt": int(args.run_attempt),
                        "url": run_url,
                    },
                },
            },
            "bundlePath": bundle_path,
            "bundleSha256": _sha256(bundle_bytes),
            "subjectPath": archive_catalog_path,
            "subjectDigest": catalog_digest,
        },
    }
    publication_path = output / "owner-publication-v1.json"
    publication_path.write_text(
        json.dumps(owner_publication, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"finalized {owner_id} source {args.commit} at {publication_path}")


def _parser() -> argparse.ArgumentParser:
    """Build the small command interface used by the owner workflow."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "finalize"):
        command = commands.add_parser(name)
        command.add_argument("--root", required=True)
        command.add_argument("--repository", required=True)
        command.add_argument("--ref", required=True)
        command.add_argument("--commit", required=True)
        command.add_argument("--output-dir", required=True)
        if name == "finalize":
            command.add_argument("--run-id", required=True)
            command.add_argument("--run-attempt", required=True)
            command.add_argument("--bundle", required=True)
    return parser


def main() -> int:
    """Parse arguments and fail closed with a concise diagnostic."""
    args = _parser().parse_args()
    try:
        if args.command == "prepare":
            prepare(args)
        else:
            finalize(args)
    except (OSError, ReleaseError) as error:
        print(f"product contract release failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
