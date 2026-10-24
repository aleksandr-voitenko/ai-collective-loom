export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly currentRevision?: string,
    readonly operationOutcome?: 'unknown' | 'rejected',
    readonly unavailableScope?: 'revision',
    readonly forbiddenReason?: 'publication_closed',
  ) {
    super(message);
  }
}
let generation = 0;
let authenticated = false,
  discoveryRevision = 0;
export const identityGeneration = () => generation;
export const sessionDiscoveryRevision = () => discoveryRevision;
export function establishSession() {
  authenticated = true;
}
export function settleAnonymous() {
  const wasAuthenticated = authenticated;
  authenticated = false;
  discoveryRevision++;
  return wasAuthenticated;
}
export function invalidateIdentity() {
  authenticated = false;
  discoveryRevision++;
  generation++;
  window.dispatchEvent(new Event('loom-identity'));
}
export function announceIdentityChange() {
  localStorage.setItem('loom.identity-change', crypto.randomUUID());
  invalidateIdentity();
}
