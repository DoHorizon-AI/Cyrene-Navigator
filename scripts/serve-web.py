"""
Navigator Web Host launcher.

The launcher binds the listener first, emits one JSON startup line containing
the one-time pairing code, and keeps all subsequent server logging off stdout.
"""

from __future__ import annotations

import argparse
import json
import socket

import uvicorn

from cyrene_navigator.web_host import create_web_host_app, generate_pairing_code


def main() -> None:
    """Start the Web Host and print its pairing material exactly once."""

    parser = argparse.ArgumentParser(description="Cyrene Navigator Web Host")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--pairing-code")
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
    pairing_code = args.pairing_code or generate_pairing_code()
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
        print(
            json.dumps(
                {
                    "service": "cyrene-web-host",
                    "host": args.host,
                    "port": port,
                    "pairingCode": pairing_code,
                }
            ),
            flush=True,
        )
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
