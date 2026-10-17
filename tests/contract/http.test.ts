import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createApplication } from "../../src/server/http/app.js";
import { ErrorResponse, RuntimeResponse, runtime } from "../../src/contracts/v1.js";

test("production routes report liveness, readiness, and actual unimplemented capabilities", async (t) => {
  let ready = true;
  let closed = 0;
  const app = await createApplication({ logger: false, database: { isReady: async () => ready, close: async () => { closed += 1; } } });
  t.after(() => app.close());
  assert.deepEqual((await app.inject("/health/live")).json(), { status: "alive" });
  assert.deepEqual((await app.inject("/health/ready")).json(), { status: "ready" });
  assert.deepEqual((await app.inject("/api/v1/runtime")).json(), runtime);
  ready = false;
  const failure = await app.inject("/health/ready");
  assert.equal(failure.statusCode, 503);
  assert.ok(Value.Check(ErrorResponse, failure.json()));
  assert.equal(failure.json().error.code, "service_unavailable");
  assert.equal((await app.inject("/health/live")).statusCode, 200);
  await app.close();
  assert.equal(closed, 1);
});

test("unsupported production query fields and identity headers do not create authority or routes", async (t) => {
  const app = await createApplication({ logger: false, database: { isReady: async () => true, close: async () => {} } });
  t.after(() => app.close());
  for (const path of ["/health/live", "/health/ready", "/api/v1/runtime", "/api/v1/openapi.json"]) {
    const response = await app.inject(`${path}?private_field=not-to-be-echoed`);
    assert.equal(response.statusCode, 400);
    assert.ok(Value.Check(ErrorResponse, response.json()));
    assert.equal(response.json().error.code, "invalid_request");
    assert.ok(!response.body.includes("not-to-be-echoed"));
    const body = await app.inject({ method: "GET", url: path, payload: { audience: "private" } });
    assert.equal(body.statusCode, 400);
    assert.deepEqual(body.json().error.fields, [{ location: "body", path: "", rule: "unsupported_body" }]);
  }
  for (const path of ["/api/v1/community", "/api/v1/discussions", "/fixture/validation", "/fixture/fault",
    "/prototype/identity/accounts", "/prototype/identity/signin/start", "/prototype/identity/bootstrap", "/prototype/identity/reconcile",
    "/api/v1/me/saved-items/state", "/api/v1/me/saved-items/lookup", "/api/v1/me/saved-items/status",
    "/api/v1/me/reading/state", "/api/v1/me/reading/lookup", "/api/v1/me/reading/status"]) {
    const response = await app.inject({ method: "POST", url: path, headers: { "x-loom-participant": "administrator", "x-request-id": "client-supplied-id" }, payload: {} });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "not_found");
    assert.notEqual(response.headers["x-request-id"], "client-supplied-id");
    assert.equal(response.json().error.request_id, response.headers["x-request-id"]);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  assert.equal((await app.inject('/api/v1/me/saved-items')).statusCode,404);
});

test("controlled body schemas reject unknown properties and semantic coercion", async (t) => {
  const app = await createApplication({ logger: false, database: { isReady: async () => true, close: async () => {} } });
  t.after(() => app.close());
  // This transport-only fixture is registered by this test, never by production.
  const body = Type.Object({ count: Type.Integer(), enabled: Type.Boolean(), label: Type.Optional(Type.String({ default: "not-inserted" })) }, { additionalProperties: false });
  const output = Type.Object({ count: Type.Integer(), enabled: Type.Boolean(), label: Type.Optional(Type.String()) }, { additionalProperties: false });
  let calls = 0;
  let observed: unknown;
  app.post("/fixture/validation", { schema: { hide: true, body, response: { 200: output, 400: ErrorResponse, 415: ErrorResponse } } }, async (request) => {
    calls += 1;
    observed = structuredClone(request.body);
    return request.body;
  });
  const valid = { count: 1, enabled: false };
  assert.deepEqual((await app.inject({ method: "POST", url: "/fixture/validation", payload: valid })).json(), valid);
  assert.deepEqual(observed, valid);
  for (const payload of [
    { ...valid, audience: "private" }, { ...valid, count: "1" }, { ...valid, enabled: "false" },
    { ...valid, count: [1] }, { ...valid, enabled: 0 }, { ...valid, count: null },
  ]) {
    const response = await app.inject({ method: "POST", url: "/fixture/validation", payload });
    assert.equal(response.statusCode, 400);
    assert.ok(Value.Check(ErrorResponse, response.json()));
    assert.ok(response.json().error.fields.length);
    assert.deepEqual(response.json().error.recovery, { action: "correct_request" });
  }
  assert.equal(calls, 1);
  for (const contentType of ["text/plain", "application/xml", "application/problem+json"]) {
    const response = await app.inject({ method: "POST", url: "/fixture/validation", headers: { "content-type": contentType }, payload: JSON.stringify(valid) });
    assert.equal(response.statusCode, 415);
    assert.ok(Value.Check(ErrorResponse, response.json()));
  }
  const malformed = await app.inject({ method: "POST", url: "/fixture/validation", headers: { "content-type": "application/json" }, payload: '{"secret":' });
  assert.equal(malformed.statusCode, 400);
  assert.ok(!malformed.body.includes("secret"));
  const oversized = await app.inject({ method: "POST", url: "/fixture/validation", payload: { ...valid, label: "x".repeat(1024 * 1024) } });
  assert.equal(oversized.statusCode, 413);
  assert.ok(Value.Check(ErrorResponse, oversized.json()));
});

test("failure responses and diagnostics exclude exception details and response extras", async (t) => {
  let diagnostics = "";
  const stream = new Writable({ write(chunk, _encoding, callback) { diagnostics += String(chunk); callback(); } });
  const app = await createApplication({ logger: { stream }, database: { isReady: async () => true, close: async () => {} } });
  t.after(() => app.close());
  const secret = "private-password-and-SQL";
  app.get("/fixture/fault", { schema: { hide: true, response: { 500: ErrorResponse } } }, async () => { throw new Error(secret); });
  app.get("/fixture/serialization", { schema: { hide: true, response: { 200: Type.Object({ status: Type.Literal("allowed") }, { additionalProperties: false }) } } }, async () => ({ status: "allowed" as const, private: secret }));
  const response = await app.inject("/fixture/fault");
  assert.equal(response.statusCode, 500);
  assert.ok(Value.Check(ErrorResponse, response.json()));
  assert.equal(response.json().error.code, "internal_error");
  assert.ok(!response.body.includes(secret));
  assert.ok(!diagnostics.includes(secret));
  assert.ok(diagnostics.includes("request_failed"));
  assert.deepEqual((await app.inject("/fixture/serialization")).json(), { status: "allowed" });
});

test("generated OpenAPI 3.0.3 validates and describes only implemented production contracts", async (t) => {
  const app = await createApplication({ logger: false, database: { isReady: async () => true, close: async () => {} } });
  t.after(() => app.close());
  await app.ready();
  const response = await app.inject("/api/v1/openapi.json");
  assert.equal(response.statusCode, 200);
  const document = response.json();
  assert.equal(document.openapi, "3.0.3");
  assert.deepEqual(Object.keys(document.paths).sort(), ["/api/v1/runtime", "/health/live", "/health/ready"]);
  assert.equal(document.paths["/api/v1/runtime"].get.operationId, "getRuntimeCapabilities");
  assert.ok(document.components.schemas);
  await SwaggerParser.validate(structuredClone(document));
  assert.ok(!JSON.stringify(document).includes('"const":'));
  assert.deepEqual(JSON.parse(JSON.stringify(app.getSchema("loom.v1.runtime"))), JSON.parse(JSON.stringify(RuntimeResponse)));
});
