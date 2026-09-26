#!/bin/sh
# Start the packaged persistence runner without printing credential values.
# 中文：启动打包后的持久化服务，不输出凭据值。

set -eu

database_path=${NAVIGATOR_DATABASE_PATH:-/var/lib/cyrene-navigator/persistence.db}
config_path=${NAVIGATOR_PRINCIPAL_CONFIG_FILE:-/run/secrets/principal-config.json}
host=${NAVIGATOR_HOST:-0.0.0.0}
port=${PORT:-8080}

if [ ! -r "$config_path" ]; then
    echo "Navigator principal configuration is unavailable." >&2
    exit 78
fi

case "$port" in
    ''|*[!0-9]*)
        echo "Navigator port must be an integer from 1 through 65535." >&2
        exit 64
        ;;
esac

if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "Navigator port must be an integer from 1 through 65535." >&2
    exit 64
fi

exec /opt/venv/bin/python /app/scripts/serve-persistence.py \
    --database "$database_path" \
    --principal-config "$config_path" \
    --host "$host" \
    --port "$port" \
    --require-product-service-configuration
