const failures = {
  invalid_request: [400, 'The request does not match the identity contract.'],
  invalid_cursor: [
    400,
    'This continuation is invalid for this administrator and scope. Restart this collection.',
  ],
  cursor_restart: [409, 'The API cursor context changed. Restart this collection.'],
  cursor_expired: [409, 'This continuation expired. Restart this collection.'],
  collection_changed: [409, 'This collection changed. Restart to review a fresh traversal.'],
  page_budget_exceeded: [
    413,
    'The next item cannot fit this page budget. Increase max_bytes or request a supported larger budget. Position was not advanced.',
  ],
  unauthenticated: [401, 'Authentication is required or no longer valid.'],
  forbidden: [403, 'This action requires current administrator authority.'],
  unavailable: [404, 'The requested identity record is unavailable.'],
  idempotency_conflict: [409, 'The attempt key was already used for different input.'],
  nickname_conflict: [409, 'The nickname is reserved.'],
  bootstrap_closed: [409, 'Community initialization is already complete.'],
  credential_limit: [409, 'The prototype credential limit has been reached.'],
  last_administrator: [409, 'At least one active administrator account must remain.'],
  invalid_proof: [401, 'The proof is invalid, expired or already used.'],
  rate_limited: [429, 'Try authentication again later.'],
  retryable: [503, 'The operation could not acquire its required guards.'],
  service_unavailable: [503, 'The identity operation could not be confirmed.'],
} as const;
export type IdentityErrorCode = keyof typeof failures;
export class IdentityError extends Error {
  readonly status: number;
  constructor(readonly code: IdentityErrorCode) {
    super(failures[code][1]);
    this.name = 'IdentityError';
    this.status = failures[code][0];
  }
}
export function identityFailure(error: unknown): IdentityError {
  if (error instanceof IdentityError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return new IdentityError(
    ['40P01', '40001', '55P03'].includes(String(code)) ? 'retryable' : 'service_unavailable',
  );
}
