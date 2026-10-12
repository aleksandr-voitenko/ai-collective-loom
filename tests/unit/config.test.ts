import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationError, readConfiguration, readMode } from "../../src/server/config.js";

test("runtime configuration defaults to loopback and the application database role", () => {
  assert.deepEqual(readConfiguration({ LOOM_PG_APP_PASSWORD: "test-only-password" }), {
    host: "127.0.0.1", port: 3000,
    database: { host: "127.0.0.1", port: 54320, database: "loom_dev", user: "loom_app", password: "test-only-password" },
  });
  assert.equal(readConfiguration({ LOOM_PG_APP_PASSWORD: "test", LOOM_API_PORT: "0" }).port, 0);
  assert.equal(readMode([]), "web");
  assert.equal(readMode(["--mode", "api"]), "api");
});

test("invalid configuration and command arguments fail without echoing supplied secrets", () => {
  for (const env of [
    {}, { LOOM_API_PORT: "65536" }, { LOOM_POSTGRES_PORT: "0" }, { LOOM_API_PORT: "3e3" },
    { LOOM_API_HOST: "private-secret-host" }, { LOOM_DATABASE_HOST: "postgres://secret" },
    { LOOM_DATABASE_USER: "secret';" }, { LOOM_DATABASE_NAME: "secret name" },
  ]) {
    assert.throws(() => readConfiguration({ LOOM_PG_APP_PASSWORD: "test-secret", ...env,
      ...(Object.keys(env).length ? {} : { LOOM_PG_APP_PASSWORD: "" }),
    }), (error: unknown) => error instanceof ConfigurationError && !error.message.includes("secret"));
  }
  for (const args of [["--allow-admin"], ["--mode", "fixture"], ["--mode", "api", "extra"]]) {
    assert.throws(() => readMode(args), ConfigurationError);
  }
});
