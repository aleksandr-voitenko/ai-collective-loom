#!/usr/bin/env bash
set -Eeuo pipefail
# Read secrets inside psql; they never become process arguments or diagnostics.
psql -X --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 <<'SQL'
\getenv database POSTGRES_DB
\getenv migrator LOOM_PG_MIGRATOR_PASSWORD
\getenv application LOOM_PG_APP_PASSWORD
CREATE ROLE loom_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'migrator';
CREATE ROLE loom_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'application';
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database" TO loom_migrator, loom_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA loom AUTHORIZATION loom_migrator;
CREATE SCHEMA loom_migrations AUTHORIZATION loom_migrator;
REVOKE ALL ON SCHEMA loom_migrations FROM PUBLIC;
GRANT USAGE ON SCHEMA loom TO loom_app;
ALTER ROLE loom_migrator IN DATABASE :"database" SET search_path = loom, pg_catalog;
ALTER ROLE loom_app IN DATABASE :"database" SET search_path = loom, pg_catalog;
SQL
