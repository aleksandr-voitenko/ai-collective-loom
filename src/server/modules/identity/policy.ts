import type { SqlTransaction } from '../../db/postgres.js';
import type { ActorContext } from '../publication/actor.js';
import { currentAuthority } from '../../application/authority.js';
import { IdentityError } from './errors.js';

export interface IdentityPolicy {
  origin: string;
  rpId: string;
  sessionSeconds: number;
  challengeSeconds: number;
  enrollmentSeconds: number;
  agentSeconds: number;
  maxAgentCredentials: number;
  maxPasskeys: number;
  maxSessions: number;
  startsPerMinute: number;
}
export interface Transactions {
  transaction<T>(operation: (transaction: SqlTransaction) => Promise<T>): Promise<T>;
}
export function verifyPolicy(policy: IdentityPolicy) {
  const invalid = () => new Error('An explicit valid HTTPS identity prototype policy is required.');
  let url: URL;
  try {
    url = new URL(policy.origin);
  } catch {
    throw invalid();
  }
  const numericFields = [
    'sessionSeconds',
    'challengeSeconds',
    'enrollmentSeconds',
    'agentSeconds',
    'maxAgentCredentials',
    'maxPasskeys',
    'maxSessions',
    'startsPerMinute',
  ] as const;
  const fields = new Set<string>(['origin', 'rpId', ...numericFields]);
  // Durations are bound to PostgreSQL integer parameters; this is a technical
  // ceiling, not approval of any product quota or operating envelope.
  if (
    url.origin !== policy.origin ||
    url.protocol !== 'https:' ||
    url.hostname !== policy.rpId ||
    Object.keys(policy).some((key) => !fields.has(key)) ||
    numericFields.some(
      (key) => !Number.isSafeInteger(policy[key]) || policy[key] <= 0 || policy[key] > 2147483647,
    )
  ) {
    throw invalid();
  }
}
export async function requireActor(tx: SqlTransaction, actor: ActorContext) {
  const authority = await currentAuthority(tx, actor);
  if (
    !authority ||
    !['agent', 'session', 'passkey'].includes(authority.credentialKind) ||
    !['human', 'agent'].includes(authority.kind)
  )
    throw new IdentityError('unauthenticated');
  return authority;
}
export async function requireAdministrator(tx: SqlTransaction, actor: ActorContext) {
  const authority = await requireActor(tx, actor);
  if (!authority.administrator) throw new IdentityError('forbidden');
  return authority;
}
// Separate from the publication structure guard; never acquired in its commit tail.
export async function identityAdministrationGuard(tx: SqlTransaction) {
  await tx.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [0x4c4f4f4d, 2]);
}
export async function lockParticipants(tx: SqlTransaction, ids: readonly string[]) {
  for (const id of [...new Set(ids)].sort())
    await tx.query('SELECT id FROM loom.participants WHERE id = $1 FOR UPDATE', [id]);
}
