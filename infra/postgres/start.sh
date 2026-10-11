#!/usr/bin/env bash
set -Eeuo pipefail

# Some host bind mounts report a 0644 script as executable, then deny its shebang
# execution. Install the reviewed hook as non-executable container-local data so
# the official entrypoint sources it. Leave host permissions/metadata untouched.
install -m 0644 /opt/loom/postgres/10-roles.sh /docker-entrypoint-initdb.d/10-roles.sh
exec /usr/local/bin/docker-entrypoint.sh "$@"
