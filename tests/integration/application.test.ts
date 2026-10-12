import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createServer as createViteServer } from "vite";
import { PostgresDatabase, type SqlTransaction } from "../../src/server/db/postgres.js";
import { createApplication } from "../../src/server/http/app.js";
import { localDockerEndpoint } from "../../scripts/lib/local-config.mjs";
import { describeMigration, migrationSql, readMigrations } from "../../scripts/lib/migrations.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("application runtime against isolated PostgreSQL and actual HTTP", async (t) => {
  const name = `loom-application-test-${randomUUID()}`;
  const passwords = {
    POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
    LOOM_PG_MIGRATOR_PASSWORD: randomBytes(32).toString("hex"),
    LOOM_PG_APP_PASSWORD: randomBytes(32).toString("hex"),
  };
  const redact = (message: string) => Object.values(passwords).reduce((text, password) => text.replaceAll(password, "[REDACTED]"), message);
  const docker = (args: string[], input?: string) => {
    const result = spawnSync("docker", args, {
      cwd: ROOT, encoding: "utf8", input, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...passwords, PGPASSWORD: passwords.LOOM_PG_MIGRATOR_PASSWORD },
    });
    if (result.error || result.status !== 0) throw new Error(redact(result.stderr || result.error?.message || `Docker exited with ${result.status}.`));
    return result.stdout.trim();
  };
  const context = () => docker(["context", "inspect", ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []), "--format", "{{.Endpoints.docker.Host}}"]);
  assert.ok(localDockerEndpoint(process.env.DOCKER_CONTEXT ? context() : process.env.DOCKER_HOST || context()), "Application tests require a local Docker engine.");
  docker(["info", "--format", "{{.ServerVersion}}"]);
  const compose = await readFile(join(ROOT, "compose.yaml"), "utf8");
  const image = /^    image: (postgres:\S+@sha256:[a-f0-9]{64})$/m.exec(compose)?.[1];
  assert.ok(image, "Missing PostgreSQL image pin.");
  let database: PostgresDatabase | undefined;
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await database?.close();
    const id = docker(["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"]);
    if (id) docker(["rm", "--force", id]);
  });
  docker([
    "run", "--detach", "--name", name, "--tmpfs", "/var/lib/postgresql",
    "-p", "127.0.0.1::5432", "--mount", `type=bind,src=${ROOT}infra/postgres,dst=/opt/loom/postgres,readonly`,
    "--entrypoint", "bash", "-e", "POSTGRES_DB=loom_dev", "-e", "POSTGRES_USER=postgres",
    "-e", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256", ...Object.keys(passwords).flatMap((key) => ["-e", key]),
    image, "/opt/loom/postgres/start.sh", "postgres",
  ]);
  const port = Number(docker(["port", name, "5432/tcp"]).split(":").at(-1));
  assert.ok(Number.isInteger(port) && port > 0);
  const configuration = { host: "127.0.0.1", port, database: "loom_dev", user: "loom_app", password: passwords.LOOM_PG_APP_PASSWORD };
  database = new PostgresDatabase(configuration);
  const deadline = Date.now() + 90_000;
  while (!await database.isReady()) {
    if (Date.now() >= deadline) throw new Error("Isolated PostgreSQL application-role readiness timed out.");
    await delay(500);
  }
  const migrations = await readMigrations(join(ROOT, "db", "migrations"));
  const version = String(Math.max(...migrations.map((migration) => Number(migration.version))) + 1).padStart(4, "0");
  assert.ok(Number(version) <= 9999);
  const fixture = describeMigration(`${version}_runtime_fixture.sql`, "CREATE TABLE loom.runtime_fixture(id integer PRIMARY KEY, body text NOT NULL);");
  docker(["exec", "-i", "-e", "PGPASSWORD", name, "psql", "-X", "-q", "-h", "127.0.0.1", "-U", "loom_migrator", "-d", "loom_dev", "-v", "ON_ERROR_STOP=1"], migrationSql([...migrations, fixture]));

  function launch(overrides: NodeJS.ProcessEnv = {}) {
    const child = spawn(process.execPath, ["dist/server/main.js"], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env, LOOM_API_HOST: "127.0.0.1", LOOM_API_PORT: "0",
        LOOM_DATABASE_HOST: "127.0.0.1", LOOM_POSTGRES_PORT: String(port),
        LOOM_DATABASE_NAME: "loom_dev", LOOM_DATABASE_USER: "loom_app",
        LOOM_PG_APP_PASSWORD: passwords.LOOM_PG_APP_PASSWORD, ...overrides,
      },
    });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    const logs = () => stdout + stderr;
    const address = async () => {
      const limit = Date.now() + 15_000;
      for (;;) {
        for (const line of stdout.split("\n")) {
          try {
            const entry = JSON.parse(line) as { event?: string; address?: string };
            if (entry.event === "application_started" && entry.address) return entry.address;
          } catch { /* A streaming JSON line may be incomplete. */ }
        }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(redact(`Application exited before listening: ${logs()}`));
        if (Date.now() >= limit) throw new Error(redact(`Application startup timed out: ${logs()}`));
        await delay(25);
      }
    };
    const exit = async () => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 12_000).unref();
      try { return await exited; } finally { clearTimeout(timer); }
    };
    return { child, address, exit, logs };
  }

  await t.test("application-role parameterized transactions use one connection and transaction", async () => {
    let expired: SqlTransaction | undefined;
    const value = "text'); COMMIT; -- retained as a value";
    await database!.transaction(async (transaction) => {
      expired = transaction;
      const first = await transaction.query<{ pid: number; transaction: string; value: string }>("SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS transaction, $1::text AS value;", [value]);
      await transaction.query("INSERT INTO loom.runtime_fixture(id, body) VALUES ($1, $2);", [1, value]);
      const second = await transaction.query<{ pid: number; transaction: string; value: string }>("SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS transaction, body AS value FROM loom.runtime_fixture WHERE id = $1;", [1]);
      assert.deepEqual(second.rows, first.rows);
    });
    assert.ok(expired);
    await assert.rejects(expired.query("SELECT 1;", []), /no longer available/);
  });
  await t.test("SQL failures roll back writes and the released connection remains usable", async () => {
    await assert.rejects(database!.transaction(async (transaction) => {
      await transaction.query("INSERT INTO loom.runtime_fixture(id, body) VALUES ($1, $2);", [2, "must roll back"]);
      await transaction.query("SELECT 1 / 0;", []);
    }), /division by zero/);
    const result = await database!.transaction((transaction) => transaction.query<{ id: number }>("SELECT id FROM loom.runtime_fixture ORDER BY id;", []));
    assert.deepEqual(result.rows, [{ id: 1 }]);
  });
  await t.test("privileged migration credentials fail the application readiness boundary", async () => {
    const privileged = new PostgresDatabase({ ...configuration, user: "loom_migrator", password: passwords.LOOM_PG_MIGRATOR_PASSWORD });
    try { assert.equal(await privileged.isReady(), false); }
    finally { await privileged.close(); }
  });
  await t.test("compiled web/API start and serve built assets, real readiness, validation and safe errors", async () => {
    const server = launch();
    const address = await server.address();
    assert.deepEqual(await (await fetch(`${address}/health/live`)).json(), { status: "alive" });
    assert.deepEqual(await (await fetch(`${address}/health/ready`)).json(), { status: "ready" });
    const home = await fetch(`${address}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    const asset = /src="([^\"]+\.js)"/.exec(html)?.[1];
    assert.ok(asset?.startsWith("/assets/"));
    const script = await fetch(`${address}${asset}`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    assert.ok(!(await script.text()).includes(passwords.LOOM_PG_APP_PASSWORD));
    assert.equal((await fetch(`${address}/status`)).status, 200);
    const invalid = await fetch(`${address}/api/v1/runtime?audience=private-test-input`);
    assert.equal(invalid.status, 400);
    assert.ok(!(await invalid.text()).includes("private-test-input"));
    const missing = await fetch(`${address}/fixture/validation`, { method: "POST", headers: { "content-type": "application/json", "x-loom-participant": "administrator" }, body: "{}" });
    assert.equal(missing.status, 404);
    const missingBody = await missing.json() as { error: { code: string; request_id: string } };
    assert.equal(missingBody.error.code, "not_found");
    assert.equal(missingBody.error.request_id, missing.headers.get("x-request-id"));
    const document = await (await fetch(`${address}/api/v1/openapi.json`)).json() as { openapi: string; paths: object };
    assert.equal(document.openapi, "3.0.3");
    assert.deepEqual(Object.keys(document.paths).sort(), ["/api/v1/runtime", "/health/live", "/health/ready"]);
    server.child.kill("SIGTERM");
    assert.equal(await server.exit(), 0);
    assert.ok(server.logs().includes("application_stopped"));
    assert.ok(!server.logs().includes(passwords.LOOM_PG_APP_PASSWORD));
  });
  await t.test("startup failures exit without listening or exposing credentials", async () => {
    for (const overrides of [
      { LOOM_PG_APP_PASSWORD: "" }, { LOOM_PG_APP_PASSWORD: "deliberately-wrong-test-password" },
      { LOOM_DATABASE_USER: "loom_migrator", LOOM_PG_APP_PASSWORD: passwords.LOOM_PG_MIGRATOR_PASSWORD },
    ]) {
      const server = launch(overrides);
      assert.equal(await server.exit(), 1);
      assert.ok(!server.logs().includes("application_started"));
      assert.ok(server.logs().includes("startup_failed"));
      assert.ok(!server.logs().includes("deliberately-wrong-test-password"));
      for (const password of Object.values(passwords)) assert.ok(!server.logs().includes(password));
    }
  });
  await t.test("development serves browser modules beside its real API proxy", async () => {
    for (const host of ["127.0.0.1", "::1"]) {
      const api = launch({ LOOM_API_HOST: host });
      const apiAddress = await api.address();
      const previousPort = process.env.LOOM_API_PORT;
      const previousHost = process.env.LOOM_API_HOST;
      process.env.LOOM_API_PORT = new URL(apiAddress).port;
      process.env.LOOM_API_HOST = host;
      let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
      try {
        vite = await createViteServer({ configFile: join(ROOT, "vite.config.ts"), server: { port: 0 }, logLevel: "error" });
        await vite.listen();
        const listener = vite.httpServer?.address();
        assert.ok(listener && typeof listener !== "string");
        const address = `http://127.0.0.1:${listener.port}`;
        const page = await fetch(`${address}/`);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /src="\/main\.tsx"/);
        for (const path of ["/main.tsx", "/routes.tsx", "/api.ts"]) {
          const module = await fetch(`${address}${path}`);
          assert.equal(module.status, 200, `Browser module ${path} must remain reachable.`);
          assert.match(module.headers.get("content-type") ?? "", /javascript/);
        }
        const readiness = await fetch(`${address}/health/ready`);
        assert.equal(readiness.status, 200, "Development proxy must reach the configured API bind.");
        assert.deepEqual(await readiness.json(), { status: "ready" });
        assert.equal((await fetch(`${address}/api/v1/runtime?unsupported=true`)).status, 400);
        const document = await (await fetch(`${address}/api/v1/openapi.json`)).json() as { openapi: string };
        assert.equal(document.openapi, "3.0.3");
      } finally {
        if (previousPort === undefined) delete process.env.LOOM_API_PORT;
        else process.env.LOOM_API_PORT = previousPort;
        if (previousHost === undefined) delete process.env.LOOM_API_HOST;
        else process.env.LOOM_API_HOST = previousHost;
        await vite?.close();
        api.child.kill("SIGTERM");
        assert.equal(await api.exit(), 0);
      }
    }
  });
  await t.test("shutdown drains an in-flight readiness request before closing its database boundary", async () => {
    let began!: () => void;
    let proceed!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    let closed = false;
    const app = await createApplication({ logger: false, database: {
      isReady: async () => { began(); await gate; return database!.isReady(); },
      close: async () => { closed = true; },
    } });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = fetch(`${address}/health/ready`);
    await started;
    const closeStarted = Date.now();
    const closing = app.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(app.server.listening, false);
    assert.equal(closed, false);
    proceed();
    const response = await request;
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("connection"), "close");
    assert.equal((await response.json() as { error: { code: string } }).error.code, "service_unavailable");
    await closing;
    assert.equal(closed, true);
    assert.ok(Date.now() - closeStarted < 10_000, "Request drain exceeded the CLI shutdown budget.");
  });
  await t.test("database loss makes readiness fail while liveness remains alive; unavailable startup fails", async () => {
    const server = launch();
    const address = await server.address();
    docker(["stop", "--time", "1", name]);
    const response = await fetch(`${address}/health/ready`);
    assert.equal(response.status, 503);
    const body = await response.json() as { error: { code: string; request_id: string } };
    assert.equal(body.error.code, "service_unavailable");
    assert.equal(body.error.request_id, response.headers.get("x-request-id"));
    assert.deepEqual(await (await fetch(`${address}/health/live`)).json(), { status: "alive" });
    const unavailable = launch();
    assert.equal(await unavailable.exit(), 1);
    assert.ok(unavailable.logs().includes("startup_failed"));
    assert.ok(!unavailable.logs().includes("application_started"));
    server.child.kill("SIGTERM");
    assert.equal(await server.exit(), 0);
  });
});
