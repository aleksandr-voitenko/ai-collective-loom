// Compatibility facade: callers retain explicit operations while implementation
// ownership stays with transport, journal custody and WebAuthn ceremony modules.
export {
  ApiError,
  identityGeneration,
  invalidateIdentity,
  announceIdentityChange,
} from './request-context.js';
export {
  sessionRequest,
  commandRequest,
  transportRequest,
  isDefinitiveRejection,
  type Self,
  type RequestOptions,
} from './browser-transport.js';
export {
  IntentStore,
  StaleIntentError,
  editingIntentReleased,
  exportDrafts,
  type Intent,
} from './intent-store.js';
export { passkey } from './webauthn.js';
