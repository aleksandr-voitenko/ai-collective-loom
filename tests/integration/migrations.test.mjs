import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { localDockerEndpoint } from "../../scripts/lib/local-config.mjs";
import { describeMigration, migrationSql, readMigrations } from "../../scripts/lib/migrations.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("migration runner against isolated PostgreSQL", async (t) => {
  const name = `loom-migration-test-${randomUUID()}`;
  const passwords = {
    POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
    LOOM_PG_MIGRATOR_PASSWORD: randomBytes(32).toString("hex"),
    LOOM_PG_APP_PASSWORD: randomBytes(32).toString("hex"),
  };
  const docker = (args, { input, env, timeout = 30_000 } = {}) => {
    const result = spawnSync("docker", args, {
      cwd: ROOT, encoding: "utf8", input, timeout, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...passwords, ...env },
    });
    if (result.error || result.status !== 0) {
      let message = result.stderr || result.error?.message || `Docker exited with status ${result.status}.`;
      for (const password of Object.values(passwords)) message = message.replaceAll(password, "[REDACTED]");
      throw new Error(message);
    }
    return result.stdout.trim();
  };
  const contextEndpoint = () => docker(["context", "inspect", ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []), "--format", "{{.Endpoints.docker.Host}}"]);
  const endpoint = process.env.DOCKER_CONTEXT ? contextEndpoint() : (process.env.DOCKER_HOST || contextEndpoint());
  assert.ok(localDockerEndpoint(endpoint), "Migration tests require a local Docker engine.");
  docker(["info", "--format", "{{.ServerVersion}}"]);
  const compose = await readFile(new URL("../../compose.yaml", import.meta.url), "utf8");
  const image = /^    image: (postgres:\S+@sha256:[a-f0-9]{64})$/m.exec(compose)?.[1];
  assert.ok(image, "Missing PostgreSQL image pin in compose.yaml.");

  // Own only this UUID-named container; use memory storage and no host ports or
  // development credentials/volumes. Clean up even after a failed startup/test.
  t.after(() => {
    const id = docker(["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"]);
    if (id) docker(["container", "rm", "--force", id]);
  });
  docker([
    "run", "--detach", "--name", name, "--network", "none", "--tmpfs", "/var/lib/postgresql",
    "--mount", `type=bind,src=${ROOT}infra/postgres,dst=/opt/loom/postgres,readonly`,
    "--entrypoint", "bash", "-e", "POSTGRES_USER=postgres", "-e", "POSTGRES_DB=loom_dev",
    "-e", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
    ...Object.keys(passwords).flatMap((key) => ["-e", key]),
    image, "/opt/loom/postgres/start.sh", "postgres",
  ], { timeout: 15 * 60_000 });
  const sql = (input, role = "loom_migrator") => docker([
    "exec", "-i", "-e", "PGPASSWORD", name, "psql", "-X", "-A", "-t", "-q",
    "-h", "127.0.0.1", "-U", role, "-d", "loom_dev", "-v", "ON_ERROR_STOP=1",
  ], { input, env: { PGPASSWORD: role === "loom_app" ? passwords.LOOM_PG_APP_PASSWORD : passwords.LOOM_PG_MIGRATOR_PASSWORD }, timeout: 90_000 });
  const deadline = Date.now() + 90_000;
  for (;;) {
    try { assert.equal(sql("SELECT current_user;"), "loom_migrator"); break; }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await delay(500);
  }

  await t.test("continued escape strings follow PostgreSQL lexical rules", () => {
    assert.equal(sql("SHOW standard_conforming_strings;"), "on");
    for (const gap of ["\n", "\r\n", " -- continuation\n", "\n-- continuation\n"]) {
      const source = `SELECT E'first'${gap}` + String.raw`'it\'s text; COMMIT;';`;
      // -c sends the complete SQL to PostgreSQL without psql's stream splitting.
      // The pinned client's continued-E-string limitation is documented in db/README.md.
      const result = docker([
        "exec", "-e", "PGPASSWORD", name, "psql", "-X", "-A", "-t", "-q",
        "-h", "127.0.0.1", "-U", "loom_migrator", "-d", "loom_dev", "-v", "ON_ERROR_STOP=1",
        "-c", describeMigration("9998_quoted_probe.sql", source).sql,
      ], { env: { PGPASSWORD: passwords.LOOM_PG_MIGRATOR_PASSWORD } });
      assert.equal(result, "firstit's text; COMMIT;");
    }
  });
  await t.test("comments and quoted commands remain SQL data through the psql stream", () => {
    for (const gap of ["\n", "\r\n", " -- continuation\n", "\n-- continuation\n"]) {
      const source = `SELECT E'first'${gap}'it''s text; COMMIT;';`;
      assert.equal(sql(describeMigration("9998_quoted_probe.sql", source).sql), "firstit's text; COMMIT;");
    }
    const escapeSource = String.raw`SELECT E'first
BEGIN; COMMIT; it\'s text;';`;
    assert.equal(sql(describeMigration("9998_quoted_probe.sql", escapeSource).sql), "first\nBEGIN; COMMIT; it's text;");
    const source = "/* outer /* nested */ comment */ SELECT $Tag$BEGIN; COMMIT; \\connect$Tag$;";
    assert.equal(sql(describeMigration("9998_quoted_probe.sql", source).sql), "BEGIN; COMMIT; \\connect");
  });

  const base = await readMigrations(fileURLToPath(new URL("../../db/migrations/", import.meta.url)));
  const next = Math.max(...base.map((m) => Number(m.version))) + 2;
  assert.ok(next + 3 <= 9999, "No migration versions remain for the PostgreSQL probes.");
  const migration = (version, label, source) => describeMigration(`${String(version).padStart(4, "0")}_${label}.sql`, source);
  const procedural = migration(next, "procedural_probe", `
CREATE TABLE loom.migration_validation_probe (
  id integer PRIMARY KEY,
  session_id integer NOT NULL DEFAULT pg_backend_pid(),
  transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE FUNCTION loom.migration_validation_value() RETURNS integer LANGUAGE plpgsql AS $Function$
BEGIN
  RETURN 42;
END;
$Function$;
DO $$
BEGIN
  INSERT INTO loom.migration_validation_probe(id) VALUES (loom.migration_validation_value());
END;
$$;
`);
  const following = migration(next + 1, "following_probe", "INSERT INTO loom.migration_validation_probe(id) VALUES (loom.migration_validation_value() + 1);");
  const applied = [...base, procedural, following];
  const historyQuery = "SELECT json_agg(h ORDER BY version) FROM loom_migrations.history AS h;";
  const rowsQuery = "SELECT string_agg(id::text, ',' ORDER BY id) || '|' || count(DISTINCT session_id) || '|' || count(DISTINCT transaction_id) FROM loom.migration_validation_probe;";

  await t.test("procedural migrations execute in version order on one connection and transaction", () => {
    sql(migrationSql([...applied].reverse()));
    assert.equal(sql("SELECT loom.migration_validation_value();"), "42");
    assert.equal(sql(rowsQuery), "42,43|1|1");
    assert.equal(sql("SELECT count(DISTINCT applied_at) FROM loom_migrations.history;"), "1");
    const history = JSON.parse(sql(historyQuery));
    assert.deepEqual(history.map(({ version, filename, sha256 }) => ({ version, filename, sha256 })),
      applied.map(({ version, filename, sha256 }) => ({ version, filename, sha256 })));
  });
  const before = sql(historyQuery);
  await t.test("unchanged migrations retain their exact history and rows", () => {
    sql(migrationSql(applied));
    assert.equal(sql(historyQuery), before);
    assert.equal(sql(rowsQuery), "42,43|1|1");
  });
  await t.test("applied filenames and checksums remain immutable", () => {
    for (const altered of [
      { ...procedural, sql: procedural.sql + "\n-- changed historical source\n" },
      { ...procedural, filename: `${procedural.version}_renamed_probe.sql` },
    ]) assert.throws(() => sql(migrationSql([...base, altered, following])), /LOOM_MIGRATION_CHECKSUM_MISMATCH/);
    assert.equal(sql(historyQuery), before);
  });
  await t.test("ahead-of-checkout and inserted-behind-history migrations are refused", () => {
    assert.throws(() => sql(migrationSql(base)), /LOOM_DATABASE_SCHEMA_AHEAD_OF_CHECKOUT/);
    const behind = migration(next - 1, "behind_probe", "SELECT 1;");
    assert.throws(() => sql(migrationSql([...applied, behind])), /LOOM_MIGRATION_INSERTED_BEHIND_HISTORY/);
    assert.equal(sql(historyQuery), before);
  });
  await t.test("a failing procedural migration rolls back all pending changes and history", () => {
    const pending = migration(next + 2, "pending_probe", "CREATE TABLE loom.migration_validation_pending(id integer); INSERT INTO loom.migration_validation_probe(id) VALUES (44);");
    const failing = migration(next + 3, "failure_probe", `
CREATE TABLE loom.migration_validation_failed(id integer);
INSERT INTO loom.migration_validation_failed VALUES (1);
DO $Failure$
BEGIN
  PERFORM 1 / 0;
END;
$Failure$;
`);
    assert.throws(() => sql(migrationSql([...applied, pending, failing])), /division by zero/);
    assert.equal(sql("SELECT to_regclass('loom.migration_validation_pending') IS NULL AND to_regclass('loom.migration_validation_failed') IS NULL;"), "t");
    assert.equal(sql(rowsQuery), "42,43|1|1");
    assert.equal(sql(historyQuery), before);
  });
  await t.test("runtime and migration roles retain separate capabilities", () => {
    for (const role of ["loom_app", "loom_migrator"]) {
      assert.equal(sql("SELECT rolsuper::text || '|' || rolcreatedb::text || '|' || rolcreaterole::text FROM pg_roles WHERE rolname = current_user;", role), "false|false|false");
    }
    assert.equal(sql("SELECT string_agg(id::text, ',' ORDER BY id) FROM loom.migration_validation_probe;", "loom_app"), "42,43");
    assert.throws(() => sql("CREATE TABLE loom.migration_validation_forbidden(id integer);", "loom_app"), /permission denied for schema loom/);
    assert.throws(() => sql("SELECT * FROM loom_migrations.history;", "loom_app"), /permission denied for schema loom_migrations/);
  });
});
