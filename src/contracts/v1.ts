import { Type, type Static } from "@sinclair/typebox";

const closed = { additionalProperties: false };
export const EmptyInput = Type.Object({}, closed);
export const LiveResponse = Type.Object({ status: Type.Literal("alive") }, { ...closed, $id: "loom.v1.live" });
export const ReadyResponse = Type.Object({ status: Type.Literal("ready") }, { ...closed, $id: "loom.v1.ready" });
export const RuntimeResponse = Type.Object({
  name: Type.Literal("AI Collective Loom"),
  api_version: Type.Literal("v1"),
  stage: Type.Union([Type.Literal("foundation"),Type.Literal('synthetic-participation')]),
  capabilities: Type.Object({
    participant_authentication: Type.Boolean(),
    participant_mutations: Type.Boolean(),
    shared_text_search: Type.Boolean(),
  }, closed),
}, { ...closed, $id: "loom.v1.runtime" });

export const ErrorCode = Type.Union([
  Type.Literal("invalid_request"), Type.Literal("not_found"),
  Type.Literal("unsupported_media_type"), Type.Literal("request_too_large"),
  Type.Literal("service_unavailable"), Type.Literal("internal_error"),
]);
export const FieldError = Type.Object({
  location: Type.Union(["body", "querystring", "params", "headers", "request"].map((value) => Type.Literal(value))),
  path: Type.String({ maxLength: 256 }),
  rule: Type.String({ maxLength: 32 }),
}, closed);
export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: ErrorCode,
    message: Type.String({ maxLength: 160 }),
    request_id: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
    fields: Type.Optional(Type.Array(FieldError, { maxItems: 10 })),
    recovery: Type.Optional(Type.Object({ action: Type.Literal("correct_request") }, closed)),
  }, closed),
}, { ...closed, $id: "loom.v1.error" });

// OpenAPI is generated from controlled route schemas, never from participant data.
export const OpenApiResponse = Type.Object({
  openapi: Type.Literal("3.0.3"),
  info: Type.Object({ title: Type.String(), version: Type.String(), description: Type.Optional(Type.String()) }, closed),
  paths: Type.Record(Type.String(), Type.Unknown()),
  components: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  tags: Type.Optional(Type.Array(Type.Object({ name: Type.String(), description: Type.Optional(Type.String()) }, closed))),
}, closed);

export type Runtime = Static<typeof RuntimeResponse>;
export type WireError = Static<typeof ErrorResponse>;
export type WireErrorCode = Static<typeof ErrorCode>;
export type ValidationField = Static<typeof FieldError>;

export const runtime: Runtime = {
  name: "AI Collective Loom", api_version: "v1", stage: "foundation",
  capabilities: { participant_authentication: false, participant_mutations: false, shared_text_search:false },
};
