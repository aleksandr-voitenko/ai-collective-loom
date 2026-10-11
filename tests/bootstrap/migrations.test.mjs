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
