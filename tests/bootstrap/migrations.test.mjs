import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeMigration, migrationSql, readMigrations } from "../../scripts/lib/migrations.mjs";

test("migration digest changes when source changes", () => {
  const first = describeMigration("0001_schema.sql", "SELECT 1;\n");
  assert.equal(first.version, "0001");
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(first.sha256, describeMigration("0001_schema.sql", "SELECT 2;\n").sha256);
});

test("restricted filenames prevent interpolating external identifiers", () => {
  for (const filename of ["../0001_a.sql", "1_a.sql", "0001_A.sql", "0001_a';.sql", "0001_a.SQL"]) assert.throws(() => describeMigration(filename, "SELECT 1;"));
  assert.throws(() => describeMigration("0001_a.sql", " \n"));
});

test("migration source cannot contain psql commands or top-level transaction control", () => {
  for (const sql of ["\\! echo bad", "SELECT 1;\n\\connect elsewhere", "BEGIN;", " COMMIT;", "ROLLBACK;", "START TRANSACTION;"]) assert.throws(() => describeMigration("0001_a.sql", sql));
});

for (const [name, sql] of [
  ["multiline PL/pgSQL function", "CREATE FUNCTION loom.probe() RETURNS integer LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN 1;\nEND;\n$$;"],
  ["single-line PL/pgSQL function", "CREATE FUNCTION loom.probe() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END; $$;"],
  ["multiline DO body", "DO $$\nBEGIN\n  PERFORM 1;\nEND;\n$$;"],
  ["single-line DO body", "DO $$ BEGIN PERFORM 1; END; $$;"],
  ["tagged body with inner quoting", String.raw`DO $Body_1$
BEGIN
  PERFORM $inner$COMMIT; \connect elsewhere$inner$;
  PERFORM '$body_1$';
END;
$Body_1$;`],
  ["Unicode dollar tag", "DO $проба$\nBEGIN\n  PERFORM 1;\nEND;\n$проба$;"],
  ["single-quoted procedural body", "DO '\nBEGIN\n  PERFORM ''COMMIT;'';\nEND;\n';"],
]) {
  test(`migration validation accepts a ${name}`, () => {
    assert.equal(describeMigration("0002_probe.sql", sql).sql, sql);
    assert.ok(migrationSql([{ filename: "0002_probe.sql", sql }]).includes(sql));
  });
}

test("migration validation ignores command text in comments and quoted values", () => {
  for (const sql of [
    "-- BEGIN; COMMIT; \\connect elsewhere\nSELECT 1;",
    "/*\nBEGIN;\n\\connect elsewhere\n/* nested ; COMMIT; */\nROLLBACK;\n*/ SELECT 1;",
    "SELECT '\nBEGIN;\nCOMMIT;\n\\connect elsewhere\n';",
    'SELECT 1 AS "\nBEGIN;\nCOMMIT;\n\\connect elsewhere\n";',
    "SELECT 'it''s text; COMMIT;', 1 AS \"name\"\"; ROLLBACK;\";",
    String.raw`SELECT E'it\'s text; COMMIT; \\connect elsewhere';`,
    String.raw`SELECT 'a backslash\'; SELECT 1;`,
    "SELECT $$\nBEGIN;\nCOMMIT;\n\\connect elsewhere\n$$;",
  ]) assert.equal(describeMigration("0002_probe.sql", sql).sql, sql);
});

test("migration validation accepts ordinary SQL formatting and non-transaction commands", () => {
  for (const sql of [
    "\n SELECT\n  1; SELECT 2;\n",
    "SELECT CASE WHEN true THEN 1\nEND;",
    "SELECT 1 AS begin_value, 2 AS commit$count;",
    "SELECT 1 AS name$tag$; SELECT 2;",
    "PREPARE probe AS SELECT 1; EXECUTE probe; DEALLOCATE probe;",
    "SET LOCAL statement_timeout = '1s'; SET search_path = loom, pg_catalog;",
    "SELECT 1; /* trailing comment */\n-- COMMIT;",
  ]) assert.equal(describeMigration("0002_probe.sql", sql).sql, sql);
});

test("escape strings retain their quoting rules when continued across lines", () => {
  for (const gap of ["\n", "\r\n", " -- continuation\n", "\n-- continuation\n"]) {
    const sql = `SELECT E'first'${gap}` + String.raw`'it\'s text; COMMIT;';`;
    assert.equal(describeMigration("0002_probe.sql", sql).sql, sql);
    assert.throws(() => describeMigration("0002_probe.sql", `${sql} COMMIT;`), /must not control psql or transaction boundaries/);
  }
});

for (const command of [
  "BEGIN", "BEGIN WORK", "START TRANSACTION", "COMMIT", "COMMIT AND CHAIN",
  "END", "ROLLBACK", "ABORT", "SAVEPOINT probe", "RELEASE SAVEPOINT probe",
  "ROLLBACK TO SAVEPOINT probe", "PREPARE TRANSACTION 'probe'",
  "COMMIT PREPARED 'probe'", "ROLLBACK PREPARED 'probe'",
  "SET TRANSACTION READ ONLY", "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
]) {
  test(`migration validation rejects top-level ${command}`, () => {
    for (const sql of [
      `${command};`, `SELECT 1; ${command};`, `SELECT 1;\n${command.toLowerCase()};`,
      `/* leading comment */ ${command};`, `;; -- comment\n${command}`,
      `SELECT '; not a boundary'; /* nested /* ; */ comment */ ${command};`,
      `SELECT 1; ${command.replaceAll(" ", " /* separator */\n")};`,
      `DO $$ BEGIN PERFORM 1; END; $$; ${command};`,
    ]) {
      assert.throws(() => describeMigration("0002_probe.sql", sql), /must not control psql or transaction boundaries/, sql);
      assert.throws(() => migrationSql([{ filename: "0002_probe.sql", sql }]), /must not control psql or transaction boundaries/, sql);
    }
  });
}

test("psql meta-commands are rejected after SQL and comments as well as at line starts", () => {
  for (const sql of [
    "\\! echo bad", "SELECT 1;\n\\connect elsewhere", "SELECT 1; \\connect elsewhere",
    "SELECT 1 \\g", "/* comment */ \\i elsewhere.sql", "SELECT 1; -- comment\n\\quit",
  ]) assert.throws(() => describeMigration("0002_probe.sql", sql), /must not control psql or transaction boundaries/, sql);
});

test("a transaction command after quoted semicolons is still rejected", () => {
  for (const sql of [
    "SELECT 'it''s ; BEGIN;'; COMMIT;",
    String.raw`SELECT E'it\'s ; BEGIN;'; COMMIT;`,
    String.raw`SELECT 'a backslash\'; COMMIT;`,
    'SELECT 1 AS "name""; BEGIN;"; COMMIT;',
    "SELECT $tag$; BEGIN; $other$; COMMIT; $tag$; COMMIT;",
  ]) assert.throws(() => describeMigration("0002_probe.sql", sql), /must not control psql or transaction boundaries/, sql);
});

test("unterminated quoted text and block comments cannot swallow runner SQL", () => {
  for (const sql of ["SELECT 'unfinished", 'SELECT "unfinished', "SELECT $$unfinished", "SELECT $Tag$unfinished$tag$", "SELECT 1; /* unfinished /* nested */"]) {
    assert.throws(() => describeMigration("0002_probe.sql", sql), /Unterminated/, sql);
  }
});

test("runner uses one transaction, serializes migrations, and retains real psql controls", () => {
  const sql = migrationSql([describeMigration("0001_a.sql", "CREATE TABLE loom.example(id integer);\n")]);
  assert.ok(sql.startsWith("\\set ON_ERROR_STOP on\nBEGIN;\n"));
  assert.ok(sql.endsWith("COMMIT;\n"));
  assert.ok(sql.indexOf("pg_advisory_xact_lock") < sql.indexOf("CREATE TABLE IF NOT EXISTS loom_migrations.history"));
  assert.ok(sql.includes("\\gset\n\\if :apply_migration\n"));
  assert.ok(sql.includes("\\endif\n"));
  assert.match(sql, /LOOM_MIGRATION_CHECKSUM_MISMATCH:0001/);
  assert.match(sql, /LOOM_DATABASE_SCHEMA_AHEAD_OF_CHECKOUT/);
  assert.match(sql, /LOOM_MIGRATION_INSERTED_BEHIND_HISTORY/);
  assert.match(sql, /SET LOCAL lock_timeout = '10s'/);
  assert.equal((sql.match(/^COMMIT;/gm) ?? []).length, 1);
});

test("runner ignores a forged precomputed digest and orders by filename version", () => {
  const one = describeMigration("0001_a.sql", "SELECT 1;\n");
  const two = describeMigration("0002_b.sql", "SELECT 2;\n");
  const sql = migrationSql([two, { ...one, sha256: "forged" }]);
  assert.ok(sql.indexOf("LOOM_MIGRATION_CHECKSUM_MISMATCH:0001") < sql.indexOf("LOOM_MIGRATION_CHECKSUM_MISMATCH:0002"));
  assert.ok(sql.includes(one.sha256));
  assert.ok(!sql.includes("forged"));
  assert.throws(() => migrationSql([one, describeMigration("0001_other.sql", "SELECT 2;")]));
  assert.throws(() => migrationSql([]));
});

test("directory loader rejects duplicate migration numbers and symlink inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-migrations-"));
  try {
    await assert.rejects(readMigrations(dir), /No SQL migrations/);
    await writeFile(join(dir, "README.md"), "Not a migration.");
    await writeFile(join(dir, "0001_a.sql"), "SELECT 1;\n");
    assert.equal((await readMigrations(dir)).length, 1);
    await writeFile(join(dir, "0001_b.sql"), "SELECT 2;\n");
    await assert.rejects(readMigrations(dir), /Duplicate/);
    await rm(join(dir, "0001_b.sql"));
    await symlink(join(dir, "0001_a.sql"), join(dir, "0002_link.sql"));
    await assert.rejects(readMigrations(dir), /not a regular file/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
