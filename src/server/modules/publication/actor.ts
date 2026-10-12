import { PublicationError } from './errors.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
declare const trustedActor: unique symbol;
export interface ActorContext { readonly [trustedActor]: true }
interface Identity { readonly participantId: string; readonly credentialId: string }
const identities = new WeakMap<ActorContext, Identity>();

/**
 * Trusted internal authentication boundary, not an authenticator. The caller must
 * have verified the credential. Never construct this from body fields or identity
 * headers. No production transport currently invokes this factory.
 */
export function actorFromVerifiedIdentity(identity: Identity): ActorContext {
  if (!uuid.test(identity.participantId) || !uuid.test(identity.credentialId)) throw new PublicationError('invalid_actor');
  const actor = Object.freeze({}) as ActorContext;
  identities.set(actor, Object.freeze({ participantId: identity.participantId.toLowerCase(), credentialId: identity.credentialId.toLowerCase() }));
  return actor;
}

export function identityOf(actor: ActorContext): Identity {
  const identity = identities.get(actor);
  if (!identity) throw new PublicationError('invalid_actor');
  return identity;
}
