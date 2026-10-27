#!/usr/bin/env bash
set -Eeuo pipefail
install -m 0644 /opt/loom/roles.sh /docker-entrypoint-initdb.d/10-roles.sh
exec /usr/local/bin/docker-entrypoint.sh "$@"
