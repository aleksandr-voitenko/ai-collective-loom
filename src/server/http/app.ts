import Fastify, { LogController, type FastifyServerOptions } from "fastify";
import swagger from "@fastify/swagger";
import staticFiles from "@fastify/static";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Value } from "@sinclair/typebox/value";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { EmptyInput, ErrorResponse, LiveResponse, OpenApiResponse, ReadyResponse, RuntimeResponse, runtime } from "../../contracts/v1.js";
import type { DatabaseHealth } from "../db/postgres.js";
import { classifyError, safeFailure } from "./errors.js";

export async function createApplication(options: {
  database: DatabaseHealth;
  browserRoot?: string;
  logger?: FastifyServerOptions["logger"];
}) {
  const app = Fastify({
    logger: options.logger ?? true, logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false, genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false, allErrors: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();
  let closing = false;
  app.addHook("preClose", async () => { closing = true; });
  app.addHook("onSend", async (_request, reply, payload) => {
    // An admitted request may finish after close() begins. End its HTTP/1 keep-alive
    // connection after the response so graceful shutdown does not wait for its timer.
    if (closing) reply.header("connection", "close");
    return payload;
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id).header("cache-control", "no-store");
    if (["GET", "HEAD"].includes(request.method) && (Number(request.headers["content-length"] ?? 0) > 0 || request.headers["transfer-encoding"] !== undefined)) {
      const failure = safeFailure("invalid_request", request.id, [{ location: "body", path: "", rule: "unsupported_body" }]);
      return reply.code(400).send(failure.body);
    }
    if (request.routeOptions.schema?.body && request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      const failure = safeFailure("unsupported_media_type", request.id);
      return reply.code(failure.status).send(failure.body);
    }
  });
  app.addHook("onClose", async () => { await options.database.close(); });
  app.setErrorHandler((error, request, reply) => {
    const failure = classifyError(error, request.id);
    if (failure.status >= 500) request.log.error({ event: "request_failed", request_id: request.id, code: failure.body.error.code }, failure.body.error.message);
    return reply.code(failure.status).send(failure.body);
  });
  await app.register(swagger, {
    openapi: { openapi: "3.0.3", info: { title: "AI Collective Loom foundation API", version: "0.1.0" } },
    convertConstToEnum: true,
  });
  for (const schema of [LiveResponse, ReadyResponse, RuntimeResponse, ErrorResponse]) app.addSchema(schema);
  const errors = { 400: ErrorResponse, 413: ErrorResponse, 415: ErrorResponse, 500: ErrorResponse };
  app.get("/health/live", {
    schema: { operationId: "getLiveness", querystring: EmptyInput, response: { ...errors, 200: LiveResponse } },
  }, async () => ({ status: "alive" as const }));
  app.get("/health/ready", {
    schema: { operationId: "getReadiness", querystring: EmptyInput, response: { ...errors, 200: ReadyResponse, 503: ErrorResponse } },
  }, async (request, reply) => {
    if (await options.database.isReady() && !closing) return { status: "ready" as const };
    const failure = safeFailure("service_unavailable", request.id);
    return reply.code(503).send(failure.body);
  });
  app.get("/api/v1/runtime", {
    schema: { operationId: "getRuntimeCapabilities", querystring: EmptyInput, response: { ...errors, 200: RuntimeResponse } },
  }, async () => runtime);
  app.get("/api/v1/openapi.json", {
    schema: { hide: true, querystring: EmptyInput, response: { ...errors, 200: OpenApiResponse } },
  }, async () => {
    const document: unknown = app.swagger();
    if (!Value.Check(OpenApiResponse, document)) throw new Error("Generated OpenAPI document violates its response schema.");
    return document;
  });

  if (options.browserRoot) {
    await access(join(options.browserRoot, "index.html"));
    const browserRoot = options.browserRoot;
    await app.register(staticFiles, { root: join(browserRoot, "assets"), prefix: "/assets/" });
    app.get("/", { schema: { hide: true } }, async (_request, reply) => reply.sendFile("index.html", browserRoot));
    app.get("/status", { schema: { hide: true } }, async (_request, reply) => reply.sendFile("index.html", browserRoot));
  }
  app.setNotFoundHandler((request, reply) => {
    const failure = safeFailure("not_found", request.id);
    return reply.code(404).send(failure.body);
  });
  return app;
}
