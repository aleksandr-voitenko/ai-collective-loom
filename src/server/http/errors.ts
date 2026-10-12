import type { FastifyError } from "fastify";
import type { ValidationField, WireError, WireErrorCode } from "../../contracts/v1.js";

const failures: Record<WireErrorCode, { status: number; message: string }> = {
  invalid_request: { status: 400, message: "The request does not match the documented contract." },
  not_found: { status: 404, message: "The requested resource is unavailable." },
  unsupported_media_type: { status: 415, message: "Use the documented request content type." },
  request_too_large: { status: 413, message: "The request body exceeds the allowed size." },
  service_unavailable: { status: 503, message: "The service is not ready." },
  internal_error: { status: 500, message: "The request could not be completed." },
};

export function safeFailure(code: WireErrorCode, requestId: string, fields?: ValidationField[]): { status: number; body: WireError } {
  return {
    status: failures[code].status,
    body: { error: {
      code, message: failures[code].message, request_id: requestId,
      ...(fields?.length ? { fields } : {}),
      ...(code === "invalid_request" ? { recovery: { action: "correct_request" as const } } : {}),
    } },
  };
}

export function classifyError(caught: unknown, requestId: string): ReturnType<typeof safeFailure> {
  if (!(caught instanceof Error)) return safeFailure("internal_error", requestId);
  const error = caught as FastifyError;
  if (error.validation) {
    const context = error.validationContext;
    const location = ["body", "querystring", "params", "headers"].includes(context ?? "") ? context! : "request";
    return safeFailure("invalid_request", requestId, error.validation.slice(0, 10).map((issue) => ({
      location, path: (issue.instancePath ?? "").slice(0, 256), rule: issue.keyword.slice(0, 32),
    })));
  }
  if (error.statusCode === 400) return safeFailure("invalid_request", requestId);
  if (error.statusCode === 413) return safeFailure("request_too_large", requestId);
  if (error.statusCode === 415) return safeFailure("unsupported_media_type", requestId);
  if (error.statusCode === 503) return safeFailure("service_unavailable", requestId);
  return safeFailure("internal_error", requestId);
}
