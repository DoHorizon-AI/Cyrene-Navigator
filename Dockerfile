# syntax=docker/dockerfile:1.7

FROM python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e AS build

ARG CYRENE_RUNTIME_MAINTENANCE_MANIFEST_SHA256
ARG CYRENE_RUNTIME_MAINTENANCE_WHEEL_SHA256
ARG CYRENE_RUNTIME_MAINTENANCE_RELEASE_ID

COPY --from=ghcr.io/astral-sh/uv:0.12.3@sha256:2d890623d310b57771ce840f0da5eed5fc6d657da05ffaa45d82797b53fa3abc /uv /uvx /usr/local/bin/

WORKDIR /build
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

COPY pyproject.toml uv.lock README.md LICENSE ./
COPY src ./src
RUN uv sync --frozen --no-dev --no-editable

# Install the immutable, release-verified runtime maintenance SDK wheel.
COPY --from=runtime-maintenance-wheel /cyrene_runtime_maintenance-0.1.0-py3-none-any.whl /tmp/wheels/cyrene_runtime_maintenance-0.1.0-py3-none-any.whl
RUN printf '%s\n' "$CYRENE_RUNTIME_MAINTENANCE_MANIFEST_SHA256" | grep -Eq '^[0-9a-f]{64}$' && \
    printf '%s\n' "$CYRENE_RUNTIME_MAINTENANCE_WHEEL_SHA256" | grep -Eq '^[0-9a-f]{64}$' && \
    test -n "$CYRENE_RUNTIME_MAINTENANCE_RELEASE_ID" && \
    printf '%s  %s\n' "$CYRENE_RUNTIME_MAINTENANCE_WHEEL_SHA256" \
        /tmp/wheels/cyrene_runtime_maintenance-0.1.0-py3-none-any.whl | sha256sum -c - && \
    uv pip install --python /opt/venv/bin/python --no-deps \
        /tmp/wheels/cyrene_runtime_maintenance-0.1.0-py3-none-any.whl && \
    rm -rf /tmp/wheels

FROM python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e AS runtime

ARG CYRENE_RUNTIME_MAINTENANCE_MANIFEST_SHA256
ARG CYRENE_RUNTIME_MAINTENANCE_WHEEL_SHA256
ARG CYRENE_RUNTIME_MAINTENANCE_RELEASE_ID

LABEL io.cyrene.runtime-maintenance.sdk-version="0.1.0" \
      io.cyrene.runtime-maintenance.manifest-sha256="${CYRENE_RUNTIME_MAINTENANCE_MANIFEST_SHA256}" \
      io.cyrene.runtime-maintenance.wheel-sha256="${CYRENE_RUNTIME_MAINTENANCE_WHEEL_SHA256}" \
      io.cyrene.runtime-maintenance.release-id="${CYRENE_RUNTIME_MAINTENANCE_RELEASE_ID}"

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NAVIGATOR_DATABASE_PATH=/var/lib/cyrene-navigator/persistence.db \
    NAVIGATOR_PRINCIPAL_CONFIG_FILE=/run/secrets/principal-config.json \
    NAVIGATOR_HOST=0.0.0.0 \
    PORT=8080

RUN groupadd --system --gid 10001 navigator \
    && useradd --system --uid 10001 --gid navigator --no-create-home \
        --shell /usr/sbin/nologin navigator \
    && install -d --owner=navigator --group=navigator --mode=0750 \
        /app/scripts /var/lib/cyrene-navigator

RUN printf '%s\n' "$CYRENE_RUNTIME_MAINTENANCE_MANIFEST_SHA256" | grep -Eq '^[0-9a-f]{64}$' && \
    printf '%s\n' "$CYRENE_RUNTIME_MAINTENANCE_WHEEL_SHA256" | grep -Eq '^[0-9a-f]{64}$' && \
    test -n "$CYRENE_RUNTIME_MAINTENANCE_RELEASE_ID"

WORKDIR /app
COPY --from=build /opt/venv /opt/venv
COPY --chown=10001:10001 scripts/serve-persistence.py /app/scripts/serve-persistence.py
COPY --chown=10001:10001 --chmod=0555 docker/container-entrypoint.sh \
    /usr/local/bin/navigator-entrypoint

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/navigator-entrypoint"]
