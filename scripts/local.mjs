import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import {
  initializeLocalConfig, readLocalConfig, composeArgs, localDockerEndpoint, redact,
} from "./lib/local-config.mjs";
import { readMigrations, migrationSql, describeMigration } from "./lib/migrations.mjs";
import { persistenceSmoke } from "./lib/persistence-smoke.mjs";
import { SIGNED_GET_EXPIRY_SECONDS, verifySignedGetExpiry } from "./lib/signed-get-expiry.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const COMMANDS = new Set(["init", "doctor", "up", "down", "status", "migrate", "smoke", "persistence", "images", "reset"]);
const SERVICE_TIMEOUT_MS = 180_000;

export function parseCommand(args) {
  const [command, ...options] = args;
  if (!COMMANDS.has(command)) throw new Error(`Choose a local command: ${[...COMMANDS].join(", ")}.`);
  if (command === "reset") {
    if (options.length !== 1 || options[0] !== "--confirm-delete-local-data") {
      throw new Error("Reset deletes this Compose project's database AND object volumes. Supply --confirm-delete-local-data explicitly.");
    }
  } else if (options.length) throw new Error("Unexpected command options.");
  return command;
}

/** Child diagnostics are captured and redact this environment's generated secrets. */
function commandOutput(args, { config, input, extraEnv, timeout = SERVICE_TIMEOUT_MS } = {}) {
  const result = spawnSync("docker", args, {
    cwd: ROOT, encoding: "utf8", input,
    env: { ...process.env, ...(config ?? {}), ...extraEnv },
    timeout, maxBuffer: 4 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code === "ENOENT" ? "Docker CLI is unavailable. Install a local Docker engine and Compose v2."
      : result.error?.code === "ETIMEDOUT" ? "Docker operation timed out; its outcome may be incomplete. Inspect local service state before retrying."
      : redact(result.stderr || result.error?.message || `Docker exited with status ${result.status}.`, config);
    throw new Error(reason);
  }
  return result.stdout;
}

function localEngine() {
  const contextEndpoint = () => commandOutput([
    "context", "inspect", ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []), "--format", "{{.Endpoints.docker.Host}}",
  ], { timeout: 15_000 }).trim();
  // Docker gives an explicit context precedence over DOCKER_HOST.
  const endpoint = process.env.DOCKER_CONTEXT ? contextEndpoint() : (process.env.DOCKER_HOST || contextEndpoint());
  if (!localDockerEndpoint(endpoint)) throw new Error("Local bootstrap refuses a remote Docker endpoint. Select a local Docker context; this is not a production deployment tool.");
  commandOutput(["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 });
  commandOutput(["compose", "version", "--short"], { timeout: 15_000 });
}

function tools(config) {
  const compose = (args, options = {}) => commandOutput(composeArgs(ROOT, config, args), { config, ...options });
  const sql = (text, role = "loom_migrator", { password: suppliedPassword } = {}) => {
    if (!["loom_migrator", "loom_app"].includes(role)) throw new Error("Unsupported database role.");
    // Forward the password through the environment, not a literal CLI argument.
    const password = role === "loom_app" ? config.LOOM_PG_APP_PASSWORD : config.LOOM_PG_MIGRATOR_PASSWORD;
    return compose(["exec", "-T", "-e", "PGPASSWORD", "postgres", "psql", "-X", "-A", "-t", "-h", "127.0.0.1", "-U", role, "-d", "loom_dev", "-v", "ON_ERROR_STOP=1"], {
      input: text, extraEnv: { PGPASSWORD: suppliedPassword ?? password },
    }).trim();
  };
  const aws = (args) => compose([
    "run", "--rm", "--no-deps", "-T", "aws", "--endpoint-url", "http://s3:8333", "--region", "us-east-1", "--no-cli-pager", "--cli-connect-timeout", "5", "--cli-read-timeout", "30", "--output", "json", "s3api", ...args,
  ]);
  const awsJson = (args) => {
    const text = aws(args).trim();
    return text ? JSON.parse(text) : {};
  };
  // Presigning does not contact the endpoint. Sign the host-reachable address;
  // changing s3:8333 to 127.0.0.1 after signing would invalidate the signature.
  const presign = (bucket, key, expires) => compose([
    "run", "--rm", "--no-deps", "-T", "aws", "--endpoint-url", `http://127.0.0.1:${config.LOOM_S3_PORT}`,
    "--region", "us-east-1", "s3", "presign", `s3://${bucket}/${key}`, "--expires-in", String(expires),
  ]).trim();
  return { compose, sql, aws, awsJson, presign };
}

async function waitForStorage(tool) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return tool.awsJson(["list-buckets"]);
    } catch (error) {
      if (attempt === 19) throw error;
      await delay(2_000);
    }
  }
}

async function setupStorage(config, tool) {
  const existing = await waitForStorage(tool);
  const names = new Set(existing.Buckets.map((bucket) => bucket.Name));
  for (const bucket of [config.LOOM_S3_STAGING_BUCKET, config.LOOM_S3_FINAL_BUCKET]) {
    if (!names.has(bucket)) tool.aws(["create-bucket", "--bucket", bucket]);
    tool.aws(["put-bucket-versioning", "--bucket", bucket, "--versioning-configuration", "Status=Enabled"]);
    assert.equal(tool.awsJson(["get-bucket-versioning", "--bucket", bucket]).Status, "Enabled", `Versioning was not enabled for ${bucket}.`);
  }
  // Deliberately no public policy, lifecycle expiry, or production CORS setup.
  // The eventual browser transfer adapter must configure and test its exact origins.
}

function versionId(result) {
  if (typeof result.VersionId !== "string" || !result.VersionId || result.VersionId === "null") {
    throw new Error("Storage operation did not return a real object version ID.");
  }
  return result.VersionId;
}

export function copySource(bucket, key, version) {
  return `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}?versionId=${encodeURIComponent(version)}`;
}

async function storageSmoke(config, tool) {
  const scratch = await mkdtemp(join(ROOT, ".local", "s3-smoke-"));
  const dirname = scratch.slice(join(ROOT, ".local").length + 1);
  const pathInContainer = (name) => `/work/${dirname}/${name}`;
  const sourceKey = `bootstrap-smoke/${randomUUID()}`;
  const finalKey = `bootstrap-smoke/${randomUUID()}`;
  const multipartKey = `bootstrap-smoke/${randomUUID()}`;
  const staging = config.LOOM_S3_STAGING_BUCKET;
  const final = config.LOOM_S3_FINAL_BUCKET;
  const created = [];
  let uploadId;
  let primaryError;
  const cleanupErrors = [];
  try {
    await writeFile(join(scratch, "first.txt"), "original exact bytes\n");
    await writeFile(join(scratch, "second.txt"), "different replacement bytes\n");
    const first = versionId(tool.awsJson(["put-object", "--bucket", staging, "--key", sourceKey, "--body", pathInContainer("first.txt")]));
    created.push([staging, sourceKey, first]);
    const second = versionId(tool.awsJson(["put-object", "--bucket", staging, "--key", sourceKey, "--body", pathInContainer("second.txt")]));
    created.push([staging, sourceKey, second]);
    assert.notEqual(first, second, "Overwrites must create distinct versions.");
    tool.aws(["get-object", "--bucket", staging, "--key", sourceKey, "--version-id", first, pathInContainer("read-first.txt")]);
    assert.equal(await readFile(join(scratch, "read-first.txt"), "utf8"), "original exact bytes\n");
    const captured = versionId(tool.awsJson(["copy-object", "--bucket", final, "--key", finalKey, "--copy-source", copySource(staging, sourceKey, first)]));
    created.push([final, finalKey, captured]);
    tool.aws(["get-object", "--bucket", final, "--key", finalKey, "--version-id", captured, pathInContainer("read-final.txt")]);
    assert.equal(await readFile(join(scratch, "read-final.txt"), "utf8"), "original exact bytes\n");
    // Actual unauthenticated HTTP retrieval of a known object must not succeed.
    const anonymous = await fetch(`http://127.0.0.1:${config.LOOM_S3_PORT}/${final}/${finalKey}`, { signal: AbortSignal.timeout(10_000) });
    assert.ok([401, 403].includes(anonymous.status), `Known object was not protected from anonymous access (status ${anonymous.status}).`);
    await anonymous.body?.cancel();
    // URLs are bearer credentials: never print them or include them in assertions.
    const signedUrl = tool.presign(final, finalKey, 60);
    const signed = await fetch(signedUrl, { signal: AbortSignal.timeout(10_000) });
    assert.equal(signed.status, 200, "A host-addressed signed GET must succeed.");
    assert.equal(await signed.text(), "original exact bytes\n");
    const tamperedUrl = new URL(signedUrl);
    const signature = tamperedUrl.searchParams.get("X-Amz-Signature");
    assert.ok(signature, "The local presigner must use SigV4.");
    tamperedUrl.searchParams.set("X-Amz-Signature", (signature[0] === "0" ? "1" : "0") + signature.slice(1));
    const tampered = await fetch(tamperedUrl, { signal: AbortSignal.timeout(10_000) });
    assert.equal(tampered.status, 403, "A tampered signed GET must be denied.");
    await tampered.body?.cancel();
    const expiredUrl = tool.presign(final, finalKey, SIGNED_GET_EXPIRY_SECONDS);
    await verifySignedGetExpiry(expiredUrl);
    const listing = tool.awsJson(["list-object-versions", "--bucket", staging, "--prefix", sourceKey]);
    assert.ok(listing.Versions.some((v) => v.VersionId === first) && listing.Versions.some((v) => v.VersionId === second));
    const started = tool.awsJson(["create-multipart-upload", "--bucket", staging, "--key", multipartKey]);
    uploadId = started.UploadId;
    assert.equal(typeof uploadId, "string");
    const part = tool.awsJson(["upload-part", "--bucket", staging, "--key", multipartKey, "--upload-id", uploadId, "--part-number", "1", "--body", pathInContainer("first.txt")]);
    await writeFile(join(scratch, "parts.json"), JSON.stringify({ Parts: [{ ETag: part.ETag, PartNumber: 1 }] }));
    const completed = versionId(tool.awsJson(["complete-multipart-upload", "--bucket", staging, "--key", multipartKey, "--upload-id", uploadId, "--multipart-upload", `file://${pathInContainer("parts.json")}`]));
    created.push([staging, multipartKey, completed]);
    uploadId = undefined;
    tool.aws(["get-object", "--bucket", staging, "--key", multipartKey, "--version-id", completed, pathInContainer("multipart.txt")]);
    assert.equal(await readFile(join(scratch, "multipart.txt"), "utf8"), "original exact bytes\n");
    console.log("Storage smoke: distinct versions, exact reads/copy, anonymous denial, signed GET/expiry/tampering, version listing, and one-part multipart completion passed.");
  } catch (error) { primaryError = error; }
  finally {
    if (uploadId) {
      try { tool.aws(["abort-multipart-upload", "--bucket", staging, "--key", multipartKey, "--upload-id", uploadId]); }
      catch (error) { cleanupErrors.push(error); }
    }
    for (const [bucket, key, version] of created.reverse()) {
      try { tool.aws(["delete-object", "--bucket", bucket, "--key", key, "--version-id", version]); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (!cleanupErrors.length) await rm(scratch, { recursive: true, force: true });
  }
  if (primaryError) {
    if (cleanupErrors.length) console.error("Some scratch objects could not be removed; inspect the local smoke prefix before resetting volumes.");
    throw primaryError;
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Storage assertions passed but scratch cleanup failed.");
}

async function databaseSmoke(tool, migrations) {
  assert.equal(tool.sql("SELECT current_user;", "loom_app"), "loom_app");
  assert.throws(() => tool.sql("SELECT current_user;", "loom_app", { password: "intentionally-wrong-bootstrap-password" }), /password authentication failed/);
  const capabilities = tool.sql("SELECT rolsuper::text || '|' || rolcreatedb::text || '|' || rolcreaterole::text FROM pg_roles WHERE rolname = current_user;", "loom_app");
  assert.equal(capabilities, "false|false|false");
  assert.equal(tool.sql("SELECT has_schema_privilege(current_user, 'loom', 'USAGE')::text || '|' || has_schema_privilege(current_user, 'loom', 'CREATE')::text || '|' || has_schema_privilege(current_user, 'loom_migrations', 'USAGE')::text;", "loom_app"), "true|false|false");
  const historyQuery = "SELECT coalesce(json_agg(h ORDER BY version), '[]') FROM loom_migrations.history AS h;";
  const before = tool.sql(historyQuery);
  tool.sql(migrationSql(migrations));
  assert.equal(tool.sql(historyQuery), before);
  const altered = migrations.map((m, index) => index ? m : { ...m, sql: m.sql + "\n-- changed historical migration\n" });
  assert.throws(() => tool.sql(migrationSql(altered)), /LOOM_MIGRATION_CHECKSUM_MISMATCH/);
  assert.equal(tool.sql(historyQuery), before);
  assert.throws(() => tool.sql("CREATE TABLE loom.bootstrap_forbidden(id integer);", "loom_app"), /permission denied for schema loom/);
  assert.throws(() => tool.sql("SELECT * FROM loom_migrations.history;", "loom_app"), /permission denied for schema loom_migrations/);
  const nextVersion = Math.max(...migrations.map((migration) => Number(migration.version))) + 1;
  assert.ok(nextVersion <= 9999, "No four-digit migration version remains for the smoke probe.");
  const failedTable = `bootstrap_failed_${randomUUID().replaceAll("-", "")}`;
  const failingMigration = describeMigration(`${String(nextVersion).padStart(4, "0")}_smoke_failure.sql`,
    `CREATE TABLE loom.${failedTable}(id integer);\nINSERT INTO loom.${failedTable} VALUES (1);\nSELECT 1 / 0;\n`);
  // Exercise the runner's failure boundary, not only an explicit SQL ROLLBACK.
  assert.throws(() => tool.sql(migrationSql([...migrations, failingMigration])), /division by zero/);
  assert.equal(tool.sql(`SELECT to_regclass('loom.${failedTable}') IS NULL;`), "t");
  assert.equal(tool.sql(historyQuery), before);
  assert.throws(() => tool.sql(migrationSql([failingMigration])), /LOOM_DATABASE_SCHEMA_AHEAD_OF_CHECKOUT/);
  assert.equal(tool.sql(historyQuery), before);
  const temporary = `bootstrap_probe_${randomUUID().replaceAll("-", "")}`;
  const result = tool.sql(`BEGIN; CREATE TABLE loom.${temporary}(id integer); INSERT INTO loom.${temporary} VALUES (1); ROLLBACK; SELECT to_regclass('loom.${temporary}') IS NULL;`);
  assert.equal(result.split("\n").at(-1), "t");
  console.log("Database smoke: authenticated non-superuser access, schema/history isolation, repeatable migrations, checksum/ahead-of-checkout refusal, denied DDL, failed-migration rollback, and explicit rollback passed.");
}

export async function main(args = process.argv.slice(2)) {
  const command = parseCommand(args);
  if (command === "init") {
    try { await initializeLocalConfig(ROOT); }
    catch (error) {
      if (error.code === "EEXIST") throw new Error(".env.local already exists; it was not changed. Preserve its passwords while keeping existing volumes.");
      throw error;
    }
    console.log("Created ignored .env.local and .local with fresh development-only credentials. No services were started.");
    return;
  }
  localEngine();
  const config = await readLocalConfig(ROOT);
  await mkdir(join(ROOT, ".local"), { recursive: true, mode: 0o700 });
  const tool = tools(config);
  if (command === "doctor") {
    tool.compose(["config", "--quiet"]);
    console.log(`Local Docker/Compose and configuration are available. PostgreSQL: 127.0.0.1:${config.LOOM_POSTGRES_PORT}; S3: 127.0.0.1:${config.LOOM_S3_PORT}. Services and provider behavior are not certified by this check.`);
    return;
  }
  if (command === "status") {
    console.log(tool.compose(["ps", "--all"]));
    return;
  }
  if (command === "images") {
    // Include the one-shot AWS client, whose removed container is absent from
    // compose images. Inspect only image identity/platform fields, never config.
    const references = [...new Set(tool.compose(["--profile", "tools", "config", "--images"]).trim().split(/\s+/))];
    for (const reference of references) {
      const identity = JSON.parse(commandOutput(["image", "inspect", reference, "--format",
        '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}},"os":{{json .Os}},"architecture":{{json .Architecture}}}',
      ], { config }));
      console.log(JSON.stringify({ reference, ...identity }));
    }
    return;
  }
  if (command === "down" || command === "reset") {
    tool.compose(command === "down" ? ["down"] : ["down", "--volumes"]);
    console.log(command === "down" ? "Stopped local services; named volumes retained." : "Removed this local project's named volumes. Credentials were retained; no cloud storage was accessed.");
    return;
  }
  const migrations = await readMigrations(join(ROOT, "db", "migrations"));
  if (command === "up") {
    tool.compose(["up", "-d", "--wait", "--wait-timeout", "90", "postgres", "s3"], { timeout: 15 * 60_000 });
    await setupStorage(config, tool);
    tool.sql(migrationSql(migrations));
    console.log("Local PostgreSQL roles/schema and two versioned S3 buckets are initialized. No Loom HTTP or agent service is implemented by this bootstrap.");
    return;
  }
  if (command === "migrate") {
    tool.sql(migrationSql(migrations));
    console.log("All checked-in migrations are applied with matching checksums.");
    return;
  }
  if (command === "persistence") {
    await persistenceSmoke({ root: ROOT, config, tool, waitForStorage });
    return;
  }
  await databaseSmoke(tool, migrations);
  await storageSmoke(config, tool);
  console.log("Local smoke suite passed. This is not hosted-provider, signed-upload, restart-persistence, concurrency, or product-acceptance validation.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Local bootstrap failed.");
    process.exitCode = 1;
  });
}
