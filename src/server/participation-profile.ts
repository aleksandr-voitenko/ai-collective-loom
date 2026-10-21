import { randomBytes } from 'node:crypto';
import { IdentityAuthentication } from './modules/identity/authentication.js';
import { IdentityAdministration } from './modules/identity/administration.js';
import { verifyPolicy, type Transactions } from './modules/identity/policy.js';
import { ConfigurationError } from './config.js';

export function syntheticIdentityPolicy(origin: string) {
  const policy = {
    origin,
    rpId: new URL(origin).hostname,
    sessionSeconds: 28800,
    challengeSeconds: 300,
    enrollmentSeconds: 3600,
    agentSeconds: 7776000,
    maxAgentCredentials: 2,
    maxPasskeys: 2,
    maxSessions: 3,
    startsPerMinute: 30,
  };
  verifyPolicy(policy);
  return policy;
}
export function participationProfile(database: Transactions, env: NodeJS.ProcessEnv = process.env) {
  if (!env.LOOM_PARTICIPATION_PROFILE) return undefined;
  if (env.LOOM_PARTICIPATION_PROFILE !== 'synthetic' || !env.LOOM_ORIGIN)
    throw new ConfigurationError(
      'Only the explicit synthetic participation profile is available; LOOM_ORIGIN is required.',
    );
  let policy;
  try {
    policy = syntheticIdentityPolicy(env.LOOM_ORIGIN);
  } catch {
    throw new ConfigurationError('LOOM_ORIGIN must be an exact HTTPS origin.');
  }
  // Server has no bootstrap/recovery HTTP capability. Offline trusted tooling
  // supplies its own verifiers; fresh unreachable proofs disable these here.
  return {
    database,
    authentication: new IdentityAuthentication(database, policy),
    administration: new IdentityAdministration(database, policy, {
      bootstrap: randomBytes(32).toString('hex'),
      recovery: randomBytes(32).toString('hex'),
    }),
  };
}
