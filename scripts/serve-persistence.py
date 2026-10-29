"""
┌─────────────────────────────────────────────────────────────────────┐
│ Module: Navigator persistence service launcher                     │
│ Role: Bind one configured authority without printing credentials.  │
│ 模块职责：启动单一持久化服务，凭据仅从环境引用读取。                  │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import socket
import ssl
import stat
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal, cast

import uvicorn
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from cyrene_navigator import Product
from cyrene_navigator import create_app as create_product_api_app
from cyrene_navigator.persistence import PersistencePrincipal, create_persistence_app
from cyrene_navigator.work.api import ConnectorBridge, TeamsPrivateConversationPolicy

PERSISTENCE_TLS_CERT_FILE_ENV = "CYRENE_PERSISTENCE_TLS_CERT_FILE"
PERSISTENCE_TLS_KEY_FILE_ENV = "CYRENE_PERSISTENCE_TLS_KEY_FILE"


class PrincipalConfig(BaseModel):
    """Explicit bootstrap identities; enterprise Identity integration follows later.

    中文:显式配置 bootstrap 身份;企业 Identity 集成后续再接入。
    """

    # 中文:显式配置引导身份;企业 Identity 集成留待后续阶段。

    model_config = ConfigDict(extra="forbid", strict=True)
    token_env: str = Field(min_length=1)
    actor_id: str = Field(min_length=1)
    workspace_ids: list[str] = Field(min_length=1)
    organization_id: str | None = None
    can_takeover: bool = False
    can_write_harness: bool = False
    can_publish_credential_health: bool = False
    can_bind_teams_private_conversations: bool = False
    actor_private_scope: bool = False

    @model_validator(mode="after")
    def private_bridge_is_narrow(self) -> PrincipalConfig:
        """Keep the Teams route binder separate from normal Work owner credentials."""

        if self.can_bind_teams_private_conversations and (
            self.can_takeover
            or self.can_write_harness
            or self.can_publish_credential_health
            or self.actor_private_scope
            or self.organization_id is None
            or len(self.workspace_ids) != 1
        ):
            raise ValueError(
                "private Teams bridge principals must have one scope and no other grants"
            )
        if self.actor_private_scope and (
            self.organization_id is None or len(self.workspace_ids) != 1
        ):
            raise ValueError("actor-private principals must have one organization-scoped Workspace")
        return self


class TeamsPrivateConversationConfig(BaseModel):
    """Pinned owner projection source and identity for private Teams delivery."""

    model_config = ConfigDict(extra="forbid", strict=True)
    actor_subjects_file_env: str = Field(default="TEAMS_TASK_ACTOR_SUBJECTS_FILE", min_length=1)
    workspace_id: str = Field(min_length=1, max_length=512)
    issuer: str = Field(min_length=1, max_length=512)
    tenant_id: str = Field(min_length=36, max_length=36)
    bot_app_id: str = Field(min_length=36, max_length=36)


class ProductDirectoryConfig(BaseModel):
    """An owner URL loaded by environment-variable name. | 通过环境变量名读取 owner URL。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    product: Product
    base_url_env: str = Field(min_length=1)


class ProductServiceCredentialConfig(BaseModel):
    """A downstream Bearer reference bound to one owner and Workspace."""

    model_config = ConfigDict(extra="forbid", strict=True)
    product: Product
    organization_id: str = Field(min_length=1, max_length=200)
    workspace_id: str = Field(min_length=1, max_length=200)
    token_env: str = Field(min_length=1)


class WorkConnectorConfig(BaseModel):
    """Host-owned optional connector binding; credentials use environment references.

    中文:宿主配置的可选连接器 binding,凭据沿用环境引用。
    """

    model_config = ConfigDict(extra="forbid", strict=True)
    kind: Literal["qq", "wecom"]
    workspace_id: str = Field(min_length=1, max_length=200)
    organization_id: str | None = Field(default=None, min_length=1, max_length=200)
    connector_id: str = Field(min_length=1, max_length=200)
    config: dict[str, Any] = Field(default_factory=dict)


class ServiceConfig(BaseModel):
    """Credential references are separate from the durable Session database.

    中文:凭据引用与持久化 Session 数据库彼此分开。
    """

    # 中文:凭据引用与持久化 Session 数据库分开保存。

    model_config = ConfigDict(extra="forbid", strict=True)
    principals: list[PrincipalConfig] = Field(min_length=1)
    product_directory: list[ProductDirectoryConfig] = Field(default_factory=list)
    product_service_credentials: list[ProductServiceCredentialConfig] = Field(default_factory=list)
    work_connectors: list[WorkConnectorConfig] = Field(default_factory=list)
    teams_private_conversations: TeamsPrivateConversationConfig | None = None


def main() -> None:
    """Start the service on an explicit or OS-selected port and report its address.

    中文:在指定端口或操作系统分配的端口上启动服务,并报告地址。
    """
    # 中文:在显式指定或由操作系统选择的端口启动服务,并报告监听地址。

    parser = argparse.ArgumentParser(description="Cyrene Harness persistence service")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--principal-config", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--lease-seconds", type=float, default=120)
    parser.add_argument("--artifact-root", type=Path)
    parser.add_argument("--echo-url")
    parser.add_argument(
        "--require-product-service-configuration",
        action="store_true",
        help="fail startup unless all Product origins and scoped Bearers are configured",
    )
    args = parser.parse_args()
    tls_files = _persistence_tls_files(os.environ)
    try:
        config_text = args.principal_config.read_text(encoding="utf-8")
        config = ServiceConfig.model_validate_json(config_text)
    except (OSError, UnicodeDecodeError, ValidationError):
        raise ValueError("Unable to read or validate Navigator service configuration") from None
    principals: dict[str, PersistencePrincipal] = {}
    for row in config.principals:
        token = os.environ.get(row.token_env)
        if not token:
            raise ValueError(f"Missing credential environment variable {row.token_env}")
        if token in principals:
            raise ValueError("Each configured principal requires a distinct credential")
        principals[token] = PersistencePrincipal(
            actor_id=row.actor_id,
            workspace_ids=frozenset(row.workspace_ids),
            can_takeover=row.can_takeover,
            organization_id=row.organization_id,
            can_write_harness=row.can_write_harness,
            can_publish_credential_health=row.can_publish_credential_health,
            can_bind_teams_private_conversations=row.can_bind_teams_private_conversations,
            actor_private_scope=row.actor_private_scope,
        )
    product_directory = _load_product_directory(config.product_directory)
    product_service_credentials = _load_product_service_credentials(
        config.product_service_credentials
    )
    if args.require_product_service_configuration:
        _require_product_service_configuration(
            config, product_directory, product_service_credentials
        )
    args.database.parent.mkdir(parents=True, exist_ok=True)
    private_policy = _teams_private_conversation_policy(
        config.teams_private_conversations, os.environ
    )
    app = create_persistence_app(
        args.database,
        principals,
        lease_seconds=args.lease_seconds,
        artifact_root=args.artifact_root,
        echo_url=args.echo_url,
        work_connector_bridges=_load_work_connectors(config.work_connectors, principals),
        private_conversation_policy=private_policy,
    )

    @app.get("/healthz", include_in_schema=False)
    def healthz() -> dict[str, str]:
        """Report only that the ASGI process can answer HTTP probes. | 仅报告进程存活。"""

        return {"status": "alive"}

    @app.get("/readyz", include_in_schema=False)
    def readyz() -> JSONResponse:
        """Report local startup completion, not downstream or durability health.

        中文:仅报告配置加载与本地 SQLite 初始化已完成，不代表下游或持久性可用。
        """

        store = app.state.persistence_store
        if not store.db_path.is_file():
            return JSONResponse(status_code=503, content={"status": "not-ready"})
        return JSONResponse(content={"status": "ready"})

    app.mount(
        "",
        create_product_api_app(
            directory=product_directory,
            principals=principals,
            service_credentials=product_service_credentials,
            require_service_configuration=True,
        ),
    )
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((args.host, args.port))
        listener.listen(128)
        port = listener.getsockname()[1]
        address = {
            "service": "cyrene-persistence",
            "host": args.host,
            "port": port,
            "scheme": "https" if tls_files is not None else "http",
        }
        print(json.dumps(address), flush=True)
        certificate = str(tls_files[0]) if tls_files is not None else None
        private_key = str(tls_files[1]) if tls_files is not None else None
        server = uvicorn.Server(
            uvicorn.Config(
                app,
                log_level="warning",
                access_log=False,
                ssl_certfile=certificate,
                ssl_keyfile=private_key,
            )
        )
        server.run(sockets=[listener])


def _persistence_tls_files(environment: Mapping[str, str]) -> tuple[Path, Path] | None:
    """Validate an optional TLS key pair before binding or advertising the service.

    中文:绑定服务前验证可选 TLS 证书和私钥；未配置时保留显式部署的 HTTP 行为。
    """

    certificate_value = environment.get(PERSISTENCE_TLS_CERT_FILE_ENV)
    private_key_value = environment.get(PERSISTENCE_TLS_KEY_FILE_ENV)
    if (certificate_value is None) != (private_key_value is None):
        raise ValueError(
            "Navigator persistence TLS certificate and key must be configured together"
        )
    if certificate_value is None or private_key_value is None:
        return None
    if not certificate_value or not private_key_value:
        raise ValueError("Navigator persistence TLS certificate and key paths must be non-empty")

    certificate = Path(certificate_value)
    private_key = Path(private_key_value)
    if not certificate.is_absolute() or not private_key.is_absolute():
        raise ValueError("Navigator persistence TLS certificate and key paths must be absolute")
    try:
        certificate = certificate.resolve(strict=True)
        private_key = private_key.resolve(strict=True)
        certificate_stat = certificate.stat()
        private_key_stat = private_key.stat()
        if (
            not stat.S_ISREG(certificate_stat.st_mode)
            or not stat.S_ISREG(private_key_stat.st_mode)
            or certificate == private_key
        ):
            raise ValueError
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(certfile=str(certificate), keyfile=str(private_key))
    except (OSError, ssl.SSLError, ValueError):
        raise ValueError(
            "Navigator persistence TLS certificate and key files are invalid or unreadable"
        ) from None
    return certificate, private_key


def _teams_private_conversation_policy(
    config: TeamsPrivateConversationConfig | None,
    environment: Mapping[str, str],
) -> TeamsPrivateConversationPolicy | None:
    """Build the host-pinned owner policy, or leave private delivery disabled."""

    if config is None:
        return None
    path_value = environment.get(config.actor_subjects_file_env)
    if not path_value:
        return None
    return TeamsPrivateConversationPolicy(
        actor_subjects_path=Path(path_value),
        workspace_id=config.workspace_id,
        issuer=config.issuer,
        tenant_id=config.tenant_id,
        bot_app_id=config.bot_app_id,
    )


def _load_work_connectors(
    rows: list[WorkConnectorConfig], principals: dict[str, PersistencePrincipal]
) -> dict[tuple[str | None, str, str], ConnectorBridge]:
    """Load installed connector packages for explicitly authorized host bindings.

    中文:仅为显式授权的本地 binding 加载已安装连接器包,浏览器不选择模块或 Host。
    """

    bridges: dict[tuple[str | None, str, str], ConnectorBridge] = {}
    owners: dict[str, set[str | None]] = {}
    for principal in principals.values():
        if principal.can_takeover:
            for workspace in principal.workspace_ids:
                owners.setdefault(workspace, set()).add(principal.organization_id)
    for row in rows:
        organizations = owners.get(row.workspace_id, set())
        organization = row.organization_id
        if organization is None:
            if len(organizations) != 1:
                raise ValueError("Connector bindings require one explicit organization owner")
            organization = next(iter(organizations))
        if organization not in organizations:
            raise ValueError("Connector binding has no configured Workspace owner")
        key = (organization, row.workspace_id, row.connector_id)
        if key in bridges:
            raise ValueError("Connector bindings must be unique in their owner scope")
        module_name, factory_name = (
            ("qq_connector", "create_navigator_qq_bridge")
            if row.kind == "qq"
            else ("wecom_connector", "create_navigator_wecom_bridge")
        )
        try:
            module = importlib.import_module(module_name)
        except ModuleNotFoundError:
            raise ValueError("Configured connector package is not installed") from None
        factory = getattr(module, factory_name, None)
        if not callable(factory):
            raise ValueError("Installed connector lacks the Navigator bridge")
        bridge = factory(row.config)
        if not all(
            callable(getattr(bridge, name, None)) for name in ("health", "request_qr", "poll_login")
        ):
            raise ValueError("Configured connector bridge is incompatible")
        bridges[key] = cast(ConnectorBridge, bridge)
    return bridges


def _load_product_directory(rows: list[ProductDirectoryConfig]) -> dict[Product, str]:
    """Load only configured owner URLs; an absent value makes snapshots return 503."""

    directory: dict[Product, str] = {}
    for row in rows:
        if row.product in directory:
            raise ValueError("each Product may have one configured base URL")
        value = os.environ.get(row.base_url_env)
        if value:
            directory[row.product] = value
    return directory


def _load_product_service_credentials(
    rows: list[ProductServiceCredentialConfig],
) -> dict[tuple[Product, str, str], str]:
    """Load distinct owner/org/workspace secrets without printing their values."""

    credentials: dict[tuple[Product, str, str], str] = {}
    for row in rows:
        key = (row.product, row.organization_id, row.workspace_id)
        if key in credentials:
            raise ValueError("each Product Workspace scope may have one credential reference")
        value = os.environ.get(row.token_env)
        if value:
            credentials[key] = value
    return credentials


def _require_product_service_configuration(
    config: ServiceConfig,
    product_directory: dict[Product, str],
    credentials: dict[tuple[Product, str, str], str],
) -> None:
    """Require a complete exact Product credential matrix for packaged service mode.

    中文:打包服务模式必须为每个组织与 Workspace 配置全部五个 Product 的专属凭据。
    """

    products = set(Product)
    if set(product_directory) != products:
        raise ValueError("packaged service requires one configured origin for every Product")

    scopes = {
        (principal.organization_id, workspace_id)
        for principal in config.principals
        if principal.organization_id is not None
        for workspace_id in principal.workspace_ids
    }
    if not scopes:
        raise ValueError("packaged service requires an organization-scoped Workspace principal")

    expected = {
        (product, organization_id, workspace_id)
        for product in products
        for organization_id, workspace_id in scopes
    }
    if set(credentials) != expected:
        raise ValueError("packaged service requires one scoped credential per Product Workspace")


if __name__ == "__main__":
    main()
