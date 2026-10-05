"""Run Navigator persistence, executor, and paired Web Host on one machine.

The supervisor keeps durable state under one directory, creates process-local
service credentials, waits for each child to become reachable, then emits one
JSON object containing only service URLs. 子进程日志和服务凭据不会输出。
"""

from __future__ import annotations

import argparse
import errno
import importlib
import json
import os
import queue
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, cast
from urllib.error import URLError
from urllib.request import urlopen

_WORKSPACE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}\Z")
_ENV_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}\Z")
_STARTUP_TIMEOUT_SECONDS = 30.0
_STOP_TIMEOUT_SECONDS = 8.0
_PROBE_TIMEOUT_SECONDS = 0.5


class _WindowsByteLock(Protocol):
    """Typed subset of the Windows CRT file-lock API used by the supervisor."""

    LK_NBLCK: int
    LK_UNLCK: int

    def locking(self, descriptor: int, mode: int, length: int) -> None: ...


@dataclass
class ChildService:
    """Own one child process and consume its stdout without retaining logs."""

    name: str
    process: subprocess.Popen[str]
    first_line: queue.Queue[str]
    reader: threading.Thread
    secrets_to_check: tuple[str, ...]


def main() -> int:
    """Start and supervise the colocated Navigator services."""

    parser = argparse.ArgumentParser(description="Run the local Navigator service stack")
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument(
        "--host", default="127.0.0.1", help="Web Host bind address; remote binds are explicit"
    )
    parser.add_argument(
        "--port", type=int, default=0, help="Web Host port; zero selects an available port"
    )
    parser.add_argument(
        "--persistence-port",
        type=int,
        default=0,
        help="loopback persistence port; set a fixed value for separately managed connectors",
    )
    parser.add_argument(
        "--public-url",
        help="optional externally reachable Web Host origin (for example, an HTTPS reverse proxy)",
    )
    parser.add_argument("--workspace-id", default=os.environ.get("CYRENE_WORKSPACE_ID", "local"))
    parser.add_argument(
        "--organization-id", default=os.environ.get("CYRENE_ORGANIZATION_ID", "local")
    )
    parser.add_argument("--actor-id", default="local-navigator")
    parser.add_argument(
        "--principal-config",
        type=Path,
        help="optional owner-managed persistence config, including installed connector bindings",
    )
    parser.add_argument(
        "--principal-token-env",
        default="CYRENE_SESSION_TOKEN",
        help="environment reference in --principal-config for this stack's scoped owner",
    )
    parser.add_argument("--startup-timeout", type=float, default=_STARTUP_TIMEOUT_SECONDS)
    parser.add_argument("--shutdown-timeout", type=float, default=_STOP_TIMEOUT_SECONDS)
    parser.add_argument("--node", default=os.environ.get("NODE", "node"))
    parser.add_argument(
        "--insecure-http",
        action="store_true",
        help="use non-Secure session cookies for an explicitly local HTTP deployment",
    )
    args = parser.parse_args()

    if any(port < 0 or port > 65535 for port in (args.port, args.persistence_port)):
        parser.error("listener ports must be between 0 and 65535")
    if args.startup_timeout <= 0 or args.shutdown_timeout <= 0:
        parser.error("startup and shutdown timeouts must be positive")
    if not _WORKSPACE_RE.fullmatch(args.workspace_id):
        parser.error("--workspace-id must be a bounded deployment identifier")
    if not _WORKSPACE_RE.fullmatch(args.organization_id):
        parser.error("--organization-id must be a bounded deployment identifier")
    if not _WORKSPACE_RE.fullmatch(args.actor_id):
        parser.error("--actor-id must be a bounded deployment identifier")
    if not _ENV_NAME_RE.fullmatch(args.principal_token_env):
        parser.error("--principal-token-env must be an environment variable name")
    if args.public_url and args.port == 0:
        parser.error("--public-url requires a fixed nonzero --port for the Web Host listener")
    if args.insecure_http and args.host not in {"127.0.0.1", "localhost"}:
        parser.error("--insecure-http is limited to a loopback Web Host listener")
    if not _provider_configuration_is_complete(os.environ):
        parser.error(
            "Exchange model configuration requires CYRENE_EXCHANGE_URL, "
            "CYRENE_EXCHANGE_TOKEN, and CYRENE_HARNESS_MODEL"
        )
    if args.public_url:
        try:
            _validate_public_url(args.public_url)
        except ValueError as error:
            parser.error(str(error))
    if args.host in {"::", "::1"} or args.host.startswith("["):
        parser.error("--host must resolve to an IPv4 listener address")

    try:
        executor_integration_environment = _executor_integration_environment(os.environ)
    except (OSError, ValueError) as error:
        parser.error(str(error))

    repository = Path(__file__).resolve().parents[1]
    state_lock = None
    try:
        _validate_runtime_files(repository, args.node)
        state_dir = _prepare_state_dir(args.state_dir)
        state_lock = _acquire_state_lock(state_dir)
    except (OSError, ValueError) as error:
        parser.error(str(error))

    runtime_dir = state_dir / ".runtime"
    runtime_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    _restrict_directory(runtime_dir)
    database_path = state_dir / "navigator.sqlite3"
    artifact_root = state_dir / "artifacts"
    dsh_home = state_dir / "dsh-home"
    plugins_dir = state_dir / "plugins"
    for path in (artifact_root, dsh_home, plugins_dir):
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        _restrict_directory(path)

    session_token = os.environ.get(args.principal_token_env) or secrets.token_urlsafe(48)
    executor_token = secrets.token_urlsafe(48)
    while executor_token == session_token:
        executor_token = secrets.token_urlsafe(48)
    web_pairing_path = state_dir / "pairing-code"
    try:
        principal_config, config_path, config_is_temporary = _resolve_principal_config(
            args.principal_config,
            workspace_id=args.workspace_id,
            organization_id=args.organization_id,
            actor_id=args.actor_id,
            principal_token_env=args.principal_token_env,
        )
        persistence_env_refs = _environment_references(principal_config)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))
    services: list[ChildService] = []
    stop_requested = threading.Event()
    previous_handlers: dict[int, Any] = {}

    def request_stop(signum: int, _frame: object) -> None:
        """Convert an OS signal into the normal reverse-order shutdown path."""

        stop_requested.set()
        if signum == getattr(signal, "SIGINT", -1):
            return

    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.signal(signum, request_stop)

    try:
        with tempfile.TemporaryDirectory(prefix="principal-", dir=runtime_dir) as temporary:
            if config_is_temporary:
                config_path = Path(temporary) / "principals.json"
                _write_private_json(config_path, principal_config)

            python_env = _persistence_child_environment(
                repository,
                session_token,
                args.principal_token_env,
                persistence_env_refs,
            )
            persistence = _start_child(
                "persistence",
                [
                    sys.executable,
                    str(repository / "scripts" / "serve-persistence.py"),
                    "--database",
                    str(database_path),
                    "--principal-config",
                    str(config_path),
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(args.persistence_port),
                    "--artifact-root",
                    str(artifact_root),
                ],
                cwd=repository,
                env=python_env,
                secrets_to_check=(session_token, executor_token),
            )
            services.append(persistence)
            persistence_banner = _read_startup(persistence, args.startup_timeout)
            persistence_url = _persistence_url(persistence_banner)
            _wait_for_http(
                persistence,
                persistence_url + "/readyz",
                args.startup_timeout,
                {200},
            )

            executor_env = _executor_child_environment(
                repository=repository,
                persistence_url=persistence_url,
                workspace_id=args.workspace_id,
                session_token=session_token,
                executor_token=executor_token,
                dsh_home=dsh_home,
                plugins_dir=plugins_dir,
                node=args.node,
                integration_environment=executor_integration_environment,
            )
            executor = _start_child(
                "executor",
                [
                    args.node,
                    str(repository / "scripts" / "serve-executor.mjs"),
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "0",
                    "--plugins-dir",
                    str(plugins_dir),
                    "--workspace-id",
                    args.workspace_id,
                ],
                cwd=repository,
                env=executor_env,
                secrets_to_check=(session_token, executor_token),
            )
            services.append(executor)
            executor_banner = _read_startup(executor, args.startup_timeout)
            executor_url = _executor_url(executor_banner)
            _wait_for_http(
                executor,
                executor_url + "/api/v1/health",
                args.startup_timeout,
                {200},
            )

            web_env = _web_child_environment(
                repository=repository,
                session_token=session_token,
                executor_token=executor_token,
                workspace_id=args.workspace_id,
            )
            web_command = [
                sys.executable,
                str(repository / "scripts" / "serve-web.py"),
                "--host",
                args.host,
                "--port",
                str(args.port),
                "--work-url",
                persistence_url,
                "--executor-url",
                executor_url,
                "--workspace-id",
                args.workspace_id,
                "--pairing-code-file",
                str(web_pairing_path),
            ]
            if args.insecure_http:
                web_command.append("--insecure-http")
            web = _start_child(
                "web",
                web_command,
                cwd=repository,
                env=web_env,
                secrets_to_check=(session_token, executor_token),
            )
            services.append(web)
            web_banner = _read_startup(web, args.startup_timeout)
            web_host, web_port = _web_address(web_banner)
            web_probe_host = "127.0.0.1" if web_host in {"0.0.0.0", "::"} else web_host
            web_probe_url = f"http://{_url_host(web_probe_host)}:{web_port}"
            _wait_for_http(
                web,
                web_probe_url + "/api/v1/system/status",
                args.startup_timeout,
                {200},
            )

            base_url = args.public_url.rstrip("/") if args.public_url else web_probe_url
            print(
                json.dumps(
                    {
                        "urls": {
                            "web": base_url,
                            "persistence": persistence_url,
                            "executor": executor_url,
                        }
                    },
                    separators=(",", ":"),
                ),
                flush=True,
            )

            while not stop_requested.wait(0.25):
                exited = next(
                    (child for child in services if child.process.poll() is not None), None
                )
                if exited is not None:
                    _error(f"{exited.name} service exited unexpectedly")
                    return 1
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError, TimeoutError) as error:
        _error(str(error))
        return 1
    finally:
        try:
            for child in reversed(services):
                _stop_child(child, args.shutdown_timeout)
        finally:
            if state_lock is not None:
                _release_state_lock(state_lock)
            for signal_number, handler in previous_handlers.items():
                signal.signal(signal_number, handler)

    return 0


def _provider_configuration_is_complete(environment: Mapping[str, str]) -> bool:
    """Require the real Exchange adapter configuration used by normal service mode."""

    names = ("CYRENE_EXCHANGE_URL", "CYRENE_EXCHANGE_TOKEN", "CYRENE_HARNESS_MODEL")
    return all(environment.get(name) for name in names)


def _validate_public_url(value: str) -> None:
    """Accept only an origin URL suitable for an external Web Host address."""

    from urllib.parse import urlsplit

    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("--public-url must be an HTTP(S) origin without credentials or a path")


def _validate_runtime_files(repository: Path, node: str) -> None:
    """Fail before creating runtime state if a required build or runtime is absent."""

    required = (
        repository / "scripts" / "serve-persistence.py",
        repository / "scripts" / "serve-web.py",
        repository / "scripts" / "serve-executor.mjs",
        repository / "harness" / "dist" / "serve.js",
    )
    missing = [path for path in required if not path.is_file()]
    if missing:
        raise ValueError(
            "required Navigator build output is missing; build the Harness adapter first"
        )
    if shutil.which(node) is None and not Path(node).is_file():
        raise ValueError("Node.js 24 is required to run the Navigator executor")
    try:
        version = subprocess.run(
            [node, "--version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        raise ValueError("Node.js 24 is required to run the Navigator executor") from None
    if not re.fullmatch(r"v24\.\d+\.\d+", version):
        raise ValueError("Navigator executor requires Node.js 24.x")


def _prepare_state_dir(path: Path) -> Path:
    """Create the durable state root and restrict it to the invoking user."""

    resolved = path.expanduser().resolve()
    resolved.mkdir(mode=0o700, parents=True, exist_ok=True)
    _restrict_directory(resolved)
    return resolved


def _restrict_directory(path: Path) -> None:
    """Apply private directory permissions where the operating system supports them."""

    if os.name != "nt":
        os.chmod(path, 0o700)


def _acquire_state_lock(state_dir: Path) -> Any:
    """Prevent two supervisors from recovering or executing one state directory."""

    lock_path = state_dir / ".navigator-stack.lock"
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    lock_file = os.fdopen(descriptor, "r+b", buffering=0)
    try:
        if os.name == "nt":
            msvcrt = cast(_WindowsByteLock, importlib.import_module("msvcrt"))

            lock_file.seek(0, os.SEEK_END)
            if lock_file.tell() == 0:
                lock_file.write(b"\0")
            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        lock_file.close()
        if error.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
            raise ValueError("the selected state directory is already in use") from None
        raise
    if os.name != "nt":
        os.chmod(lock_path, 0o600)
    return lock_file


def _release_state_lock(lock_file: Any) -> None:
    """Release the platform-specific exclusive state-directory lock."""

    try:
        if os.name == "nt":
            msvcrt = cast(_WindowsByteLock, importlib.import_module("msvcrt"))

            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    finally:
        lock_file.close()


def _write_private_json(path: Path, value: object) -> None:
    """Write ephemeral bootstrap configuration without embedding secret values."""

    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(value, stream, separators=(",", ":"))
        stream.write("\n")
    if os.name != "nt":
        os.chmod(path, 0o600)


def _base_child_environment(repository: Path) -> dict[str, str]:
    """Keep only runtime variables needed by Python service children."""

    allowed = ("PATH", "HOME", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL")
    environment = {name: os.environ[name] for name in allowed if name in os.environ}
    old_pythonpath = os.environ.get("PYTHONPATH")
    values = [str(repository / "src")]
    if old_pythonpath:
        values.append(old_pythonpath)
    environment["PYTHONPATH"] = os.pathsep.join(values)
    return environment


def _resolve_principal_config(
    configured_path: Path | None,
    *,
    workspace_id: str,
    organization_id: str,
    actor_id: str,
    principal_token_env: str,
) -> tuple[dict[str, Any], Path | None, bool]:
    """Load an explicit owner configuration or create a scoped local principal."""

    if configured_path is None:
        return (
            {
                "principals": [
                    {
                        "token_env": principal_token_env,
                        "actor_id": actor_id,
                        "workspace_ids": [workspace_id],
                        "organization_id": organization_id,
                        "can_takeover": True,
                        "can_write_harness": True,
                    }
                ]
            },
            None,
            True,
        )
    path = configured_path.expanduser().resolve()
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("principals"), list):
        raise ValueError("--principal-config must contain a principals array")
    matching = [
        principal
        for principal in value["principals"]
        if isinstance(principal, dict) and principal.get("token_env") == principal_token_env
    ]
    if len(matching) != 1:
        raise ValueError("--principal-config must define one matching owner token reference")
    owner = matching[0]
    if (
        owner.get("workspace_ids") != [workspace_id]
        or owner.get("organization_id") != organization_id
        or owner.get("can_takeover") is not True
        or owner.get("can_write_harness") is not True
    ):
        raise ValueError(
            "--principal-config owner must match the selected organization and Workspace and "
            "explicitly grant Harness writes"
        )
    return value, path, False


def _environment_references(config: dict[str, Any]) -> set[str]:
    """Collect only explicitly named environment references from owner config."""

    result: set[str] = set()

    def visit(value: object) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if isinstance(key, str) and key.endswith("_env") and isinstance(child, str):
                    if not _ENV_NAME_RE.fullmatch(child):
                        raise ValueError(
                            "principal config contains an invalid environment reference"
                        )
                    result.add(child)
                elif key == "secret_refs" and isinstance(child, list):
                    for reference in child:
                        if not isinstance(reference, str) or not _ENV_NAME_RE.fullmatch(reference):
                            raise ValueError(
                                "principal config contains an invalid secret reference"
                            )
                        result.add(reference)
                else:
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(config)
    return result


def _persistence_child_environment(
    repository: Path,
    session_token: str,
    principal_token_env: str,
    env_references: set[str],
) -> dict[str, str]:
    """Build the persistence environment from its declared credential refs only."""

    environment = _base_child_environment(repository)
    environment["CYRENE_SESSION_TOKEN"] = session_token
    environment[principal_token_env] = session_token
    for name in env_references.difference({principal_token_env, "CYRENE_SESSION_TOKEN"}):
        if name in os.environ:
            environment[name] = os.environ[name]
    return environment


def _executor_child_environment(
    *,
    repository: Path,
    persistence_url: str,
    workspace_id: str,
    session_token: str,
    executor_token: str,
    dsh_home: Path,
    plugins_dir: Path,
    node: str,
    integration_environment: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Build the DSH child environment; provider secrets never enter Python children."""

    allowed = ("PATH", "HOME", "SYSTEMROOT", "WINDIR", "TEMP", "TMP")
    environment = {name: os.environ[name] for name in allowed if name in os.environ}
    provider_names = (
        "CYRENE_EXCHANGE_URL",
        "CYRENE_EXCHANGE_TOKEN",
        "CYRENE_HARNESS_MODEL",
        "CYRENE_DEVICE_ID",
    )
    for name in provider_names:
        if name in os.environ:
            environment[name] = os.environ[name]
    if integration_environment:
        environment.update(integration_environment)
    environment.update(
        {
            "CYRENE_PERSISTENCE_URL": persistence_url,
            "CYRENE_WORKSPACE_ID": workspace_id,
            "CYRENE_SESSION_TOKEN": session_token,
            "CYRENE_EXECUTOR_TOKEN": executor_token,
            "DSH_HOME": str(dsh_home),
            "DSH_TELEMETRY_DISABLED": "1",
            "DSH_MAX_TOKENS_AS_SUCCESS": "false",
            "NAVIGATOR_PLUGINS_DIR": str(plugins_dir),
            "NODE": node,
        }
    )
    return environment


def _executor_integration_environment(environment: Mapping[str, str]) -> dict[str, str]:
    """Forward host integration config paths and only their declared secret references."""

    result: dict[str, str] = {}
    workflows_enabled = environment.get("CYRENE_WORKFLOWS_ENABLED")
    if workflows_enabled is not None:
        if workflows_enabled not in {"true", "false"}:
            raise ValueError("CYRENE_WORKFLOWS_ENABLED must be 'true' or 'false'")
        result["CYRENE_WORKFLOWS_ENABLED"] = workflows_enabled

    config_names = ("CYRENE_SUBAGENT_CONFIG", "CYRENE_CLOUD_PROFILE_CONFIG")
    for config_name in config_names:
        configured_path = environment.get(config_name)
        if configured_path is None:
            continue
        if not configured_path.strip():
            raise ValueError(f"{config_name} must name a JSON configuration file")
        path = Path(configured_path).expanduser().resolve()
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError(f"{config_name} could not be read as valid JSON") from None
        result[config_name] = str(path)
        if config_name == "CYRENE_SUBAGENT_CONFIG":
            _collect_subagent_environment_references(document, result, environment)
        else:
            _collect_cloud_environment_references(document, result, environment)
    return result


def _add_environment_reference(
    name: object, result: dict[str, str], environment: Mapping[str, str]
) -> None:
    """Copy one validated host variable reference into the executor environment."""

    if not isinstance(name, str) or not _ENV_NAME_RE.fullmatch(name):
        raise ValueError("integration configuration contains an invalid environment reference")
    if name in environment:
        result[name] = environment[name]


def _collect_subagent_environment_references(
    document: object, result: dict[str, str], environment: Mapping[str, str]
) -> None:
    """Read host env names from the fixed native subagent deployment shape."""

    if not isinstance(document, dict) or not isinstance(document.get("deployments"), list):
        raise ValueError("CYRENE_SUBAGENT_CONFIG must contain a deployments array")
    for deployment in document["deployments"]:
        if not isinstance(deployment, dict):
            raise ValueError("CYRENE_SUBAGENT_CONFIG contains an invalid deployment")
        references = deployment.get("envRefs", {})
        if not isinstance(references, dict):
            raise ValueError("CYRENE_SUBAGENT_CONFIG envRefs must be an object")
        for child_name, host_name in references.items():
            if not isinstance(child_name, str) or not _ENV_NAME_RE.fullmatch(child_name):
                raise ValueError(
                    "CYRENE_SUBAGENT_CONFIG contains an invalid child environment name"
                )
            _add_environment_reference(host_name, result, environment)


def _collect_cloud_environment_references(
    document: object, result: dict[str, str], environment: Mapping[str, str]
) -> None:
    """Read named MCP credentials without copying unrelated host environment values."""

    if not isinstance(document, dict) or not isinstance(document.get("profiles"), list):
        raise ValueError("CYRENE_CLOUD_PROFILE_CONFIG must contain a profiles array")
    for profile in document["profiles"]:
        if not isinstance(profile, dict):
            raise ValueError("CYRENE_CLOUD_PROFILE_CONFIG contains an invalid profile")
        connection = profile.get("connection", {})
        if not isinstance(connection, dict):
            raise ValueError("CYRENE_CLOUD_PROFILE_CONFIG connection must be an object")
        header_references = connection.get("headerEnvRefs", {})
        if not isinstance(header_references, dict):
            raise ValueError("CYRENE_CLOUD_PROFILE_CONFIG headerEnvRefs must be an object")
        for header_name, host_name in header_references.items():
            if not isinstance(header_name, str) or not header_name.strip():
                raise ValueError("CYRENE_CLOUD_PROFILE_CONFIG contains an invalid header name")
            _add_environment_reference(host_name, result, environment)
        references = connection.get("envRefs", [])
        if not isinstance(references, list):
            raise ValueError("CYRENE_CLOUD_PROFILE_CONFIG envRefs must be an array")
        for host_name in references:
            _add_environment_reference(host_name, result, environment)


def _web_child_environment(
    *, repository: Path, session_token: str, executor_token: str, workspace_id: str
) -> dict[str, str]:
    """Build the Web Host environment with only its two fixed backend credentials."""

    return {
        **_base_child_environment(repository),
        "CYRENE_SESSION_TOKEN": session_token,
        "CYRENE_EXECUTOR_TOKEN": executor_token,
        "CYRENE_WORKSPACE_ID": workspace_id,
    }


def _start_child(
    name: str,
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    secrets_to_check: tuple[str, ...],
) -> ChildService:
    """Launch a service, keeping stderr and all post-banner output private."""

    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        start_new_session=os.name != "nt",
        creationflags=creationflags,
    )
    output = process.stdout
    if output is None:
        process.kill()
        raise RuntimeError(f"{name} service did not expose a startup channel")
    first_line: queue.Queue[str] = queue.Queue(maxsize=1)

    def drain_stdout() -> None:
        """Send exactly the first line to startup parsing; discard subsequent logs."""

        try:
            line = output.readline()
            first_line.put(line)
            while output.read(8192):
                pass
        except (OSError, ValueError):
            if first_line.empty():
                first_line.put("")

    reader = threading.Thread(target=drain_stdout, name=f"{name}-stdout", daemon=True)
    reader.start()
    return ChildService(name, process, first_line, reader, secrets_to_check)


def _read_startup(child: ChildService, timeout: float) -> dict[str, Any]:
    """Read and validate one startup JSON object without returning secret-bearing data."""

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if child.process.poll() is not None and child.first_line.empty():
            raise RuntimeError(f"{child.name} service exited before readiness")
        try:
            line = child.first_line.get(timeout=min(0.1, max(deadline - time.monotonic(), 0.01)))
            break
        except queue.Empty:
            continue
    else:
        raise TimeoutError(f"{child.name} service did not report readiness")
    if not line:
        raise RuntimeError(f"{child.name} service exited before readiness")
    if any(secret in line for secret in child.secrets_to_check):
        raise RuntimeError(f"{child.name} service startup message contained a credential")
    parsed = json.loads(line)
    if not isinstance(parsed, dict):
        raise RuntimeError(f"{child.name} service returned an invalid startup message")
    return parsed


def _persistence_url(startup: dict[str, Any]) -> str:
    """Derive a loopback URL from the persistence launcher's bound listener."""

    if startup.get("service") != "cyrene-persistence":
        raise RuntimeError("persistence service returned an unexpected startup identity")
    host = startup.get("host")
    port = startup.get("port")
    if not isinstance(host, str) or not isinstance(port, int) or not 0 < port < 65536:
        raise RuntimeError("persistence service returned an invalid listener address")
    return f"http://127.0.0.1:{port}"


def _executor_url(startup: dict[str, Any]) -> str:
    """Validate the executor's startup URL and pin its host to loopback."""

    from urllib.parse import urlsplit

    if startup.get("service") != "cyrene-navigator-executor" or startup.get("status") != "ready":
        raise RuntimeError("executor service returned an unexpected startup identity")
    parsed = urlsplit(startup.get("url", ""))
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("executor service must bind to a loopback HTTP address")
    if parsed.port is None:
        raise RuntimeError("executor service returned an invalid listener address")
    return f"http://127.0.0.1:{parsed.port}"


def _web_address(startup: dict[str, Any]) -> tuple[str, int]:
    """Validate the Web Host listener response and return its bind address."""

    if startup.get("service") != "cyrene-web-host":
        raise RuntimeError("Web Host returned an unexpected startup identity")
    host = startup.get("host")
    port = startup.get("port")
    if not isinstance(host, str) or not isinstance(port, int) or not 0 < port < 65536:
        raise RuntimeError("Web Host returned an invalid listener address")
    return host, port


def _url_host(host: str) -> str:
    """Bracket IPv6 literals when composing an HTTP URL."""

    return f"[{host}]" if ":" in host and not host.startswith("[") else host


def _wait_for_http(
    child: ChildService, url: str, timeout: float, accepted_statuses: set[int]
) -> None:
    """Wait for a child HTTP endpoint and fail if its process exits or stalls."""

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if child.process.poll() is not None:
            raise RuntimeError(f"{child.name} service exited during readiness checks")
        try:
            with urlopen(url, timeout=_PROBE_TIMEOUT_SECONDS) as response:
                if response.status in accepted_statuses:
                    return
        except URLError as error:
            status = getattr(error, "code", None)
            if status in accepted_statuses:
                return
        except (TimeoutError, OSError):
            pass
        time.sleep(0.05)
    raise TimeoutError(f"{child.name} service did not accept readiness probes")


def _stop_child(child: ChildService, timeout: float) -> None:
    """Ask the child to stop, then force-kill it after a bounded grace period."""

    process = child.process
    if process.poll() is None:
        try:
            if os.name == "nt":
                process.send_signal(getattr(signal, "CTRL_BREAK_EVENT", signal.SIGTERM))
            else:
                os.killpg(process.pid, signal.SIGTERM)
        except (OSError, ValueError):
            process.terminate()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=timeout)
    if process.stdout is not None:
        process.stdout.close()
    child.reader.join(timeout=1)


def _error(message: str) -> None:
    """Write a safe supervisor error without child logs or credential values."""

    print(f"Navigator local stack: {message}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
