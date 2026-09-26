"""
┌─────────────────────────────────────────────────────────────────────┐
│ Module: Navigator persistence service launcher                     │
│ Role: Bind one configured authority without printing credentials.  │
│ 模块职责：启动单一持久化服务，凭据仅从环境引用读取。                  │
└─────────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import argparse
import json
import os
import socket
from pathlib import Path

import uvicorn
from pydantic import BaseModel, ConfigDict, Field

from cyrene_navigator import Product
from cyrene_navigator import create_app as create_product_api_app
from cyrene_navigator.persistence import PersistencePrincipal, create_persistence_app


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


class ServiceConfig(BaseModel):
    """Credential references are separate from the durable Session database.

    中文:凭据引用与持久化 Session 数据库彼此分开。
    """

    # 中文:凭据引用与持久化 Session 数据库分开保存。

    model_config = ConfigDict(extra="forbid", strict=True)
    principals: list[PrincipalConfig] = Field(min_length=1)
    product_directory: list[ProductDirectoryConfig] = Field(default_factory=list)
    product_service_credentials: list[ProductServiceCredentialConfig] = Field(default_factory=list)


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
    args = parser.parse_args()
    config = ServiceConfig.model_validate_json(args.principal_config.read_text(encoding="utf-8"))
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
        )
    product_directory = _load_product_directory(config.product_directory)
    product_service_credentials = _load_product_service_credentials(
        config.product_service_credentials
    )
    args.database.parent.mkdir(parents=True, exist_ok=True)
    app = create_persistence_app(
        args.database,
        principals,
        lease_seconds=args.lease_seconds,
        artifact_root=args.artifact_root,
        echo_url=args.echo_url,
    )
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
        address = {"service": "cyrene-persistence", "host": args.host, "port": port}
        print(json.dumps(address), flush=True)
        server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
        server.run(sockets=[listener])


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


if __name__ == "__main__":
    main()
