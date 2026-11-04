import { fileLimits } from '../contracts/files.js';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import {
  ApiError,
  identityGeneration,
  sessionDiscoveryRevision,
  establishSession,
} from './request-context.js';
import { classifyResponse, responseContract } from './response-contracts.js';
import { observeRequestFailure, observeSourceDenial } from './authorization-coordinator.js';

export interface Self {
  participant_id: string;
  credential_id: string;
  nickname: string;
  kind: string;
  role: string;
  csrf?: string;
}
export interface RequestOptions {
  body?: unknown;
  binaryBody?: Blob;
  responseType?: 'blob';
  self?: Self;
  signal?: AbortSignal;
  schema?: TSchema;
}

// These entry points cannot be used as an alternate protected-read transport.
// Keep the exact path and body: saved commands are immutable recovery custody.
export async function sessionRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return independentRequest<T>('session', path, options);
}
export async function commandRequest<T>(
  path: string,
  options: RequestOptions & { body: unknown },
): Promise<T> {
  if (options.body === undefined)
    throw new Error('This operation requires the authorization boundary.');
  return independentRequest<T>('receipt', path, options);
}
async function independentRequest<T>(
  access: 'session' | 'receipt',
  path: string,
  options: RequestOptions,
): Promise<T> {
  const owner = identityGeneration(),
    contract = responseContract(path, options.body === undefined ? 'GET' : 'POST');
  if (contract.access !== access)
    throw new Error('This operation requires the authorization boundary.');
  const response = await transportRequest<T>(path, options);
  if (response.observation.denied) observeSourceDenial(owner);
  // A denial consumes content authority, never the private operation result.
  return response.value;
}

// Internal transport. The architecture check permits its import only by the
// authorization boundary; components use its read capability or the APIs above.
export async function transportRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<{
  value: T;
  contract: ReturnType<typeof responseContract>;
  observation: ReturnType<typeof classifyResponse>;
}> {
  const owner = identityGeneration(),
    discovery = sessionDiscoveryRevision(),
    contract = responseContract(path, options.body === undefined ? 'GET' : 'POST');
  const deadline = AbortSignal.timeout(15000);
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
    ...(options.body !== undefined
      ? {
          method: 'POST',
          headers: {
            'Content-Type': options.binaryBody ? 'application/octet-stream' : 'application/json',
            ...(options.self?.csrf ? { 'x-loom-csrf': options.self.csrf } : {}),
          },
          body: options.binaryBody ?? JSON.stringify(options.body),
        }
      : {}),
  });
  if (options.responseType === 'blob' && response.ok) {
    if (
      contract.access !== 'read' ||
      !path.split('?')[0]?.endsWith('/download') ||
      Number(response.headers.get('content-length')) > fileLimits.fileBytes
    )
      throw new Error('Unsupported binary response.');
    const blob = await response.blob();
    if (blob.size > fileLimits.fileBytes) throw new Error('File response exceeds the byte limit.');
    if (owner !== identityGeneration()) throw new DOMException('Identity changed.', 'AbortError');
    return { value: blob as T, contract, observation: classifyResponse(contract, blob) };
  }
  const value: unknown = await response.json();
  if (owner !== identityGeneration()) throw new DOMException('Identity changed.', 'AbortError');
  if (!response.ok) {
    const error = (
      value as {
        error?: {
          code?: string;
          message?: string;
          current_revision_id?: string;
          operation_outcome?: 'unknown' | 'rejected';
          unavailable_scope?: unknown;
          forbidden_reason?: unknown;
        };
      }
    ).error;
    const failure = new ApiError(
      error?.code ?? 'unknown',
      error?.message ?? 'The request could not be completed.',
      error?.current_revision_id,
      error?.operation_outcome,
      contract.revisionMiss && error?.unavailable_scope === 'revision' ? 'revision' : undefined,
      contract.publicationClosureRefusal && error?.forbidden_reason === 'publication_closed'
        ? 'publication_closed'
        : undefined,
    );
    // Error evidence is consumed once, at the endpoint boundary, regardless of
    // which view/command initiated it or whether that caller is still mounted.
    observeRequestFailure(owner, contract, failure);
    throw failure;
  }
  if (contract.errors.session === 'discovery' && discovery !== sessionDiscoveryRevision())
    throw new DOMException('Session discovery changed.', 'AbortError');
  const observation = classifyResponse(contract, value);
  if (options.schema && !Value.Check(options.schema, value)) {
    if (observation.denied) observeSourceDenial(owner);
    throw new ApiError(
      'unsupported_contract',
      'This response does not match the participation contract.',
    );
  }
  if (contract.errors.session !== 'unrelated') establishSession();
  return { value: value as T, contract, observation };
}
/** A first dispatch can be rejected directly. An uncertain summary request can
 * be corrected only after the server commits its irreversible expiry refusal. */
export function isDefinitiveRejection(error: unknown, wasUncertain: boolean) {
  if (
    error instanceof ApiError &&
    ['summary_preparation_expired', 'file_expired'].includes(error.code) &&
    error.operationOutcome === 'rejected'
  )
    return true;
  return (
    !wasUncertain &&
    error instanceof ApiError &&
    error.operationOutcome !== 'unknown' &&
    [
      'invalid_input',
      'reference_format_required',
      'change_format_required',
      'file_reference_format_required',
      'file_format_required',
      'file_not_prepared',
      'file_expired',
      'file_mismatch',
      'file_capacity',
      'file_size_limit',
      'file_reserved_capacity',
      'file_unfinished_capacity',
      'file_policy_conflict',
      'file_policy_capacity',
      'unavailable',
      'invalid_request',
      'revision_conflict',
      'rate_policy_conflict',
      'rate_policy_capacity',
      'forbidden',
      'nickname_conflict',
      'credential_limit',
      'saved_limit_reached',
      'note_limit',
      'note_deleted',
      'following_limit_reached',
      'organization_conflict',
      'moderation_conflict',
      'editing_intent_conflict',
      'editing_intent_limit',
      'editing_intent_closed',
      'moderation_limit',
      'moderation_target_unsupported',
      'organization_limit',
      'organization_cycle',
      'proposal_route_changed',
      'summary_already_exists',
      'summary_preparation_expired',
      'summary_preparation_limit',
      'summary_source_limit',
      'summary_coverage_required',
    ].includes(error.code)
  );
}
