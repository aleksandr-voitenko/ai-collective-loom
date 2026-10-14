import { Value } from "@sinclair/typebox/value";
import { ErrorResponse, ReadyResponse, RuntimeResponse, type Runtime } from "../contracts/v1.js";

export class ServiceError extends Error {
  readonly requestId: string | undefined;
  constructor(message: string, requestId?: string) {
    super(message);
    this.requestId = requestId;
  }
}

async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, { signal, credentials: "same-origin", headers: { accept: "application/json" } }); }
  catch (error) {
    if (signal.aborted) throw error;
    throw new ServiceError("Unable to reach the service. Please try again.");
  }
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new ServiceError("The service returned an unexpected response. Please try again."); }
  if (!response.ok) {
    const requestId = Value.Check(ErrorResponse, body) ? body.error.request_id : undefined;
    throw new ServiceError(response.status === 503 ? "The service is unavailable right now. Please try again." : "Unable to check the service. Please try again.", requestId);
  }
  return body;
}

export async function loadServiceStatus({ request }: { request: Request }): Promise<Runtime> {
  const status = await getJson("/api/v1/runtime", request.signal);
  if (!Value.Check(RuntimeResponse, status)) throw new ServiceError("The service returned an unexpected response. Please try again.");
  const readiness = await getJson("/health/ready", request.signal);
  if (!Value.Check(ReadyResponse, readiness)) throw new ServiceError("The service returned an unexpected response. Please try again.");
  return status;
}
