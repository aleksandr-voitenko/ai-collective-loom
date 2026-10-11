import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_KEYS, parseLocalConfig, newLocalConfig, initializeLocalConfig,
  validateLocalConfig, composeArgs, localDockerEndpoint, redact,
} from "../../scripts/lib/local-config.mjs";
import { parseCommand, copySource } from "../../scripts/local.mjs";
const serialize = (config) => CONFIG_KEYS.map((key) => `${key}=${config[key]}`).join("\n");

test("generated credentials round-trip through the restricted parser", () => {
  const config = newLocalConfig();
  assert.deepEqual(parseLocalConfig("# local\r\n" + serialize(config).replaceAll("\n", "\r\n") + "\r\n"), config);
  assert.notEqual(config.LOOM_PG_APP_PASSWORD, config.LOOM_PG_MIGRATOR_PASSWORD);
  assert.notEqual(newLocalConfig().LOOM_S3_SECRET_KEY, config.LOOM_S3_SECRET_KEY);
});

test("init creates private local state without replacing existing credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-init-"));
  try {
    const first = await initializeLocalConfig(root);
    assert.deepEqual(parseLocalConfig(await readFile(join(root, ".env.local"), "utf8")), first);
    if (process.platform !== "win32") assert.equal((await stat(join(root, ".env.local"))).mode & 0o777, 0o600);
    await assert.rejects(initializeLocalConfig(root), { code: "EEXIST" });
    assert.deepEqual(parseLocalConfig(await readFile(join(root, ".env.local"), "utf8")), first);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("init refuses a credential symlink without changing its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-init-link-"));
  try {
    const target = join(root, "retained-config");
    await writeFile(target, "retained local configuration\n");
    await symlink(target, join(root, ".env.local"));
    await assert.rejects(initializeLocalConfig(root), { code: "EEXIST" });
    assert.equal(await readFile(target, "utf8"), "retained local configuration\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [name, mutate] of [
  ["a port below the nonprivileged range", (c) => { c.LOOM_S3_PORT = "80"; }],
  ["a port above the TCP range", (c) => { c.LOOM_S3_PORT = "70000"; }],
  ["equal ports", (c) => { c.LOOM_S3_PORT = c.LOOM_POSTGRES_PORT; }],
  ["numerically equal ports with leading zeros", (c) => { c.LOOM_S3_PORT = "0" + c.LOOM_POSTGRES_PORT; }],
  ["equal buckets", (c) => { c.LOOM_S3_FINAL_BUCKET = c.LOOM_S3_STAGING_BUCKET; }],
  ["a production-looking bucket", (c) => { c.LOOM_S3_FINAL_BUCKET = "production-archives"; }],
  ["a nonlocal project namespace", (c) => { c.COMPOSE_PROJECT_NAME = "production"; }],
  ["an example password", (c) => { c.LOOM_PG_APP_PASSWORD = "GENERATED_BY_DEV_INIT"; }],
  ["a missing secret", (c) => { delete c.LOOM_S3_SECRET_KEY; }],
]) test(`configuration rejects ${name}`, () => {
  const config = newLocalConfig(); mutate(config); assert.throws(() => validateLocalConfig(config));
});

test("parser rejects duplicates, unknown fields, quotes, and shell expressions", () => {
  const text = serialize(newLocalConfig());
  for (const line of ["LOOM_S3_PORT=8334", "AWS_PROFILE=production", "LOOM_S3_PORT=$(touch_unwanted)", "LOOM_S3_PORT='8333'"]) {
    assert.throws(() => parseLocalConfig(text + "\n" + line));
  }
});

test("Compose invocation binds the checkout/config and does not contain secrets", () => {
  const config = newLocalConfig();
  assert.deepEqual(composeArgs("/work/loom", config, ["down"]), ["compose", "--env-file", "/work/loom/.env.local", "--project-name", "loom-dev", "--file", "/work/loom/compose.yaml", "down"]);
  assert.ok(!composeArgs("/work/loom", config, ["down"]).includes(config.LOOM_PG_APP_PASSWORD));
});

test("only local Docker endpoints are accepted", () => {
  for (const value of ["unix:///var/run/docker.sock", "npipe:////./pipe/docker_engine", "tcp://127.0.0.1:2375", "https://localhost:2376", "tcp://[::1]:2375"]) assert.equal(localDockerEndpoint(value), true, value);
  for (const value of ["ssh://production", "tcp://example.com:2375", "https://localhost.evil.test:2376", "nonsense", ""]) assert.equal(localDockerEndpoint(value), false, value);
});

test("reset requires an exact explicit destructive confirmation", () => {
  assert.throws(() => parseCommand(["reset"]));
  assert.throws(() => parseCommand(["reset", "--force"]));
  assert.equal(parseCommand(["reset", "--confirm-delete-local-data"]), "reset");
  assert.equal(parseCommand(["down"]), "down");
  assert.throws(() => parseCommand(["up", "--volumes"]));
  assert.throws(() => parseCommand(["deploy"]));
});

test("known local secrets are removed from child diagnostics", () => {
  const config = newLocalConfig();
  const raw = `${config.LOOM_S3_SECRET_KEY} ${config.LOOM_PG_APP_PASSWORD} service failed`;
  assert.equal(redact(raw, config), "[REDACTED] [REDACTED] service failed");
});

test("exact copy-source encoding preserves path and version boundaries", () => {
  assert.equal(copySource("loom-dev-staging", "a b/x+y", "v/1+=&"), "loom-dev-staging/a%20b/x%2By?versionId=v%2F1%2B%3D%26");
});
