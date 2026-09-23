"""
Navigator Web Host launcher.

The launcher binds the listener first and emits one JSON startup line carrying
the bound address and, when it had to generate a pairing code itself, the path
of the owner-only file holding it. The code itself is never written to stdout or
stderr: this process runs detached with its output redirected into a log file,
so printing the secret would leave a working credential on disk.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
from pathlib import Path

import uvicorn

from cyrene_navigator.web_host import create_web_host_app, generate_pairing_code

PAIRING_CODE_FILE_ENV = "CYRENE_PAIR_CODE_FILE"
PAIRING_CODE_MODE = 0o600


def pairing_code_path(explicit: str | None) -> Path | None:
    """Resolve where a self-generated pairing code may be stored, if anywhere."""

    configured = explicit or os.environ.get(PAIRING_CODE_FILE_ENV)
    return Path(configured).expanduser() if configured else None


def write_pairing_code(path: Path, code: str) -> None:
    """Store the code for the invoking user only."""

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, PAIRING_CODE_MODE)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(f"{code}\n")
    os.chmod(path, PAIRING_CODE_MODE)


def startup_payload(host: str, port: int, code_file: Path | None) -> dict[str, object]:
    """Describe the bound listener without disclosing the pairing secret."""

    return {
        "service": "cyrene-web-host",
        "host": host,
        "port": port,
        "pairingCodeFile": str(code_file) if code_file is not None else None,
    }


def main() -> None:
    """Start the Web Host and publish where its pairing material can be read."""

    parser = argparse.ArgumentParser(description="Cyrene Navigator Web Host")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--pairing-code")
    parser.add_argument(
        "--pairing-code-file",
        help=(
            "owner-only file that receives a self-generated pairing code; required "
            "unless --pairing-code is supplied"
        ),
    )
    parser.add_argument("--session-ttl-seconds", type=float, default=3600)
    parser.add_argument("--refresh-ttl-seconds", type=float, default=7 * 24 * 3600)
    parser.add_argument(
        "--proxy",
        action="append",
        default=[],
        metavar="PREFIX=URL",
        help="fixed Web Host proxy prefix and credential-free HTTP(S) origin",
    )
    parser.add_argument(
        "--insecure-http",
        action="store_true",
        help="allow non-Secure cookies for an explicitly local HTTP deployment",
    )
    args = parser.parse_args()
    code_file: Path | None = None
    if args.pairing_code:
        pairing_code = args.pairing_code
    else:
        code_file = pairing_code_path(args.pairing_code_file)
        if code_file is None:
            parser.error(
                "generating a pairing code needs --pairing-code-file (or "
                f"{PAIRING_CODE_FILE_ENV}); this launcher's output is redirected, so "
                "it will not print the secret"
            )
        pairing_code = generate_pairing_code()
        write_pairing_code(code_file, pairing_code)
    proxy_targets = _parse_proxy_targets(args.proxy, parser)
    app = create_web_host_app(
        pairing_code=pairing_code,
        proxy_targets=proxy_targets,
        session_ttl_seconds=args.session_ttl_seconds,
        refresh_ttl_seconds=args.refresh_ttl_seconds,
        secure_cookies=not args.insecure_http,
    )

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((args.host, args.port))
        listener.listen(128)
        port = listener.getsockname()[1]
        print(json.dumps(startup_payload(args.host, port, code_file)), flush=True)
        server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
        server.run(sockets=[listener])


def _parse_proxy_targets(values: list[str], parser: argparse.ArgumentParser) -> dict[str, str]:
    """Parse fixed prefix assignments without accepting arbitrary request origins."""

    result: dict[str, str] = {}
    for value in values:
        prefix, separator, origin = value.partition("=")
        if not separator or not prefix or not origin:
            parser.error("--proxy must use PREFIX=URL")
        if prefix in result:
            parser.error(f"duplicate --proxy prefix: {prefix}")
        result[prefix] = origin
    return result


if __name__ == "__main__":
    main()
