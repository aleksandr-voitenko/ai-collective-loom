#!/usr/bin/env bash
set -Eeuo pipefail

# The official image runs this only for a NEW data directory. Socket authentication
# is deliberately used during initialization; subsequent checks use TCP/passwords.
psql -X --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"   --set=ON_ERROR_STOP=1   --set=migrator_password="$LOOM_PG_MIGRATOR_PASSWORD"   --set=app_password="$LOOM_PG_APP_PASSWORD" <<'SQL'
CREATE ROLE loom_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'migrator_password';
CREATE ROLE loom_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
REVOKE ALL ON DATABASE loom_dev FROM PUBLIC;
GRANT CONNECT ON DATABASE loom_dev TO loom_migrator, loom_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA loom AUTHORIZATION loom_migrator;
CREATE SCHEMA loom_migrations AUTHORIZATION loom_migrator;
REVOKE ALL ON SCHEMA loom_migrations FROM PUBLIC;
GRANT USAGE ON SCHEMA loom TO loom_app;
ALTER ROLE loom_migrator IN DATABASE loom_dev SET search_path = loom, pg_catalog;
ALTER ROLE loom_app IN DATABASE loom_dev SET search_path = loom, pg_catalog;
SQL
