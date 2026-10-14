import { createHash } from "node:crypto";
import { readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";

function validateMigrationSource(sql, filename) {
  const boundaryError = () => new Error(`Migration must not control psql or transaction boundaries: ${filename}`);
  let head = [];
  const checkStatement = () => {
    if (["BEGIN", "COMMIT", "END", "ROLLBACK", "ABORT", "SAVEPOINT", "RELEASE"].includes(head[0])
      || (["START", "PREPARE", "SET"].includes(head[0]) && head[1] === "TRANSACTION")
      || head.join(" ") === "SET SESSION CHARACTERISTICS AS TRANSACTION") throw boundaryError();
    head = [];
  };
  // Only command heads matter. Quoted values/identifiers occupy a token without
  // exposing their contents; comments act as whitespace, including nested ones.
  const token = (value) => { if (head.length < 5) head.push(value); };
  for (let i = 0; i < sql.length;) {
    const char = sql[i];
    if (/\s/.test(char)) { i += 1; continue; }
    if (sql.startsWith("--", i)) {
      i += 2;
      while (i < sql.length && !/[\r\n]/.test(sql[i])) i += 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) { depth += 1; i += 2; }
        else if (sql.startsWith("*/", i)) { depth -= 1; i += 2; }
        else i += 1;
      }
      if (depth) throw new Error(`Unterminated SQL block comment in migration: ${filename}`);
      continue;
    }
    // Ordinary strings use PostgreSQL's default standard_conforming_strings=on.
    const escapeString = /[Ee]/.test(char) && sql[i + 1] === "'";
    if (char === "'" || char === '"' || escapeString) {
      const quote = escapeString ? "'" : char;
      i += escapeString ? 2 : 1;
      let closed = false;
      while (i < sql.length) {
        if (escapeString && sql[i] === "\\") { i += 2; }
        else if (sql[i] === quote) {
          i += 1;
          if (sql[i] === quote) i += 1;
          else {
            // E-string continuations keep escaping across newlines and line comments.
            const continuation = escapeString && /^(?:[ \t\f\v]|--[^\r\n]*)*[\r\n](?:[ \t\f\v\r\n]|--[^\r\n]*[\r\n])*'/.exec(sql.slice(i));
            if (continuation) i += continuation[0].length;
            else { closed = true; break; }
          }
        } else i += 1;
      }
      if (!closed) throw new Error(`Unterminated SQL quoted text in migration: ${filename}`);
      token("<quoted>");
      continue;
    }
    if (char === "$") {
      const tag = /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error(`Unterminated SQL dollar quote in migration: ${filename}`);
        i = end + tag.length;
        token("<quoted>");
        continue;
      }
    }
    if (char === "\\") throw boundaryError();
    if (char === ";") { checkStatement(); i += 1; continue; }
    const word = /^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*/.exec(sql.slice(i))?.[0];
    token(word ? word.toUpperCase() : char);
    i += word?.length ?? 1;
  }
  checkStatement();
}

export function describeMigration(filename, sql) {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(filename);
  if (!match) throw new Error(`Invalid migration filename: ${filename}`);
  if (!sql.trim()) throw new Error(`Empty migration: ${filename}`);
  // Files are trusted, reviewed repository code. Scan SQL statement boundaries
  // for transaction/psql hygiene; this is not a SQL parser or hostile-code sandbox.
  validateMigrationSource(sql, filename);
  return { version: match[1], filename, sql, sha256: createHash("sha256").update(sql).digest("hex") };
}

export async function readMigrations(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const migrations = [];
  for (const name of names) {
    if (!(await lstat(join(directory, name))).isFile()) throw new Error(`Migration is not a regular file: ${name}`);
    migrations.push(describeMigration(name, await readFile(join(directory, name), "utf8")));
  }
  if (!migrations.length) throw new Error("No SQL migrations found.");
  if (new Set(migrations.map((m) => m.version)).size !== migrations.length) throw new Error("Duplicate migration version.");
  return migrations;
}

export function migrationSql(migrations) {
  if (!migrations.length) throw new Error("No SQL migrations found.");
  // Revalidate external callers before interpolating these restricted identifiers.
  const checked = migrations.map((m) => describeMigration(m.filename, m.sql));
  if (new Set(checked.map((m) => m.version)).size !== checked.length) throw new Error("Duplicate migration version.");
  const ordered = [...checked].sort((a, b) => a.version.localeCompare(b.version));
  const versionRows = ordered.map((m) => `('${m.version}')`).join(", ");
  const versions = ordered.map((m) => String.raw`'${m.version}'`).join(", ");
  const blocks = ordered.map((m) => String.raw`
DO $loom_check$
BEGIN
  IF EXISTS (SELECT 1 FROM loom_migrations.history WHERE version = '${m.version}' AND (sha256 <> '${m.sha256}' OR filename <> '${m.filename}')) THEN
    RAISE EXCEPTION 'LOOM_MIGRATION_CHECKSUM_MISMATCH:${m.version}';
  END IF;
END $loom_check$;
SELECT NOT EXISTS (SELECT 1 FROM loom_migrations.history WHERE version = '${m.version}') AS apply_migration \gset
\if :apply_migration
${m.sql}
INSERT INTO loom_migrations.history(version, filename, sha256) VALUES ('${m.version}', '${m.filename}', '${m.sha256}');
\endif
`).join("\n");
  return String.raw`\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('loom:development-migrations', 0));
CREATE TABLE IF NOT EXISTS loom_migrations.history (
  version text PRIMARY KEY,
  filename text NOT NULL UNIQUE,
  sha256 char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
DO $loom_check$
BEGIN
  IF EXISTS (SELECT 1 FROM loom_migrations.history WHERE version NOT IN (${versions})) THEN
    RAISE EXCEPTION 'LOOM_DATABASE_SCHEMA_AHEAD_OF_CHECKOUT';
  END IF;
  IF EXISTS (SELECT 1 FROM (VALUES ${versionRows}) AS planned(version) WHERE planned.version < (SELECT max(version) FROM loom_migrations.history) AND NOT EXISTS (SELECT 1 FROM loom_migrations.history AS applied WHERE applied.version = planned.version)) THEN
    RAISE EXCEPTION 'LOOM_MIGRATION_INSERTED_BEHIND_HISTORY';
  END IF;
END $loom_check$;
${blocks}
COMMIT;
`;
}
