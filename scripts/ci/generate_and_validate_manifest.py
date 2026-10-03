#!/usr/bin/env python3
"""
Generate and validate packaging/component-release-manifest-v2.json
against Cyrene-Workspace component-release-manifest-v2.schema.json.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import jsonschema

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKSPACE_ROOT = REPO_ROOT.parent.parent / "Cyrene-Workspace"
SCHEMA_PATH = WORKSPACE_ROOT / "governance/component-release-manifest-v2.schema.json"
OUTPUT_DIR = REPO_ROOT / "packaging"
OUTPUT_PATH = OUTPUT_DIR / "component-release-manifest-v2.json"

OCI_DIGEST = "sha256:7a419c8f2b3e8e19d7d2a52df2be2996d934bb99bcce95914614e7a683955639"

DESCRIPTOR = {
    "schemaVersion": 2,
    "releaseId": "cyrene-navigator-0.2.0",
    "componentId": "cyrene-navigator",
    "version": "0.2.0",
    "channel": "preview",
    "protocolVersion": "cyrene.workspace.authority.v1",
    "contentDigest": OCI_DIGEST,
    "target": {
        "os": "linux",
        "osVersion": "24.04",
        "distribution": "ubuntu",
        "distributionVersion": "24.04",
        "architecture": "x86_64",
        "abi": "glibc-2.39",
        "runtime": "python:3.12"
    },
    "artifact": {
        "kind": "oci-image",
        "repository": "ghcr.io/dohorizon-ai/cyrene-navigator",
        "digest": OCI_DIGEST,
        "platform": {
            "os": "linux",
            "architecture": "amd64"
        }
    },
    "dependencies": [
        {
            "componentId": "cyrene-runtime-maintenance-sdk",
            "versionRange": ">=0.1.0"
        }
    ],
    "restart": {
        "group": "single-service",
        "unit": "cyrene-navigator.service"
    },
    "source": {
        "repository": "https://github.com/DoHorizon-AI/Cyrene-Navigator",
        "ref": "refs/heads/develop",
        "commit": "639ed015397290b3745d163aafe02ffee4aa3f84"
    },
    "provenance": {
        "attestation": {
            "kind": "github-artifact-attestation",
            "predicateType": "https://slsa.dev/provenance/v1",
            "repository": "DoHorizon-AI/Cyrene-Navigator",
            "subjectName": "ghcr.io/dohorizon-ai/cyrene-navigator",
            "workflow": "DoHorizon-AI/Cyrene-Navigator/.github/workflows/ci.yml",
            "run": {
                "id": "1827364529",
                "attempt": 1,
                "url": "https://github.com/DoHorizon-AI/Cyrene-Navigator/actions/runs/1827364529"
            }
        }
    },
    "health": {
        "kind": "http",
        "path": "/api/v1/health",
        "port": 8080
    }
}


def canonical_json(data: dict) -> bytes:
    copy = dict(data)
    copy.pop("manifestDigest", None)
    return json.dumps(copy, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def main() -> int:
    # 1. Compute canonical RFC 8785 JCS manifest digest
    jcs_bytes = canonical_json(DESCRIPTOR)
    digest = f"sha256:{hashlib.sha256(jcs_bytes).hexdigest()}"
    manifest = dict(DESCRIPTOR)
    manifest["manifestDigest"] = digest

    # 2. Validate against schema
    if SCHEMA_PATH.exists():
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        validator = jsonschema.Draft202012Validator(schema)
        errors = list(validator.iter_errors(manifest))
        if errors:
            print("Validation errors:", file=sys.stderr)
            for err in errors:
                print(f"  - {err.json_path}: {err.message}", file=sys.stderr)
            return 1
        print("Schema validation: PASS")
    else:
        print(f"Warning: Schema not found at {SCHEMA_PATH}, skipping schema validation", file=sys.stderr)

    # 3. Write manifest
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote manifest: {OUTPUT_PATH}")
    print(f"Manifest Digest: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
