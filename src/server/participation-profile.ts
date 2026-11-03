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

/** Staging is an explicit, bounded non-sensitive trial with its own origin/RP. */
export function stagingIdentityPolicy(origin: string, acknowledgement: string) {
  const url = new URL(origin);
  if (
    acknowledgement !== 'vps-staging-1' ||
    url.origin !== origin ||
    url.protocol !== 'https:' ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) ||
    url.hostname.endsWith('.localhost') ||
    url.username ||
    url.password
  )
    throw new ConfigurationError(
      'Explicit staging acknowledgement and exact HTTPS domain required.',
    );
  // Staging operator handoff can span setup and review; stored ticket expiries stay authoritative.
  return { ...syntheticIdentityPolicy(origin), enrollmentSeconds: 4 * 60 * 60 };
}

export function requireWorkerProfile(env: NodeJS.ProcessEnv = process.env) {
  if (env.LOOM_PARTICIPATION_PROFILE === 'staging') {
    stagingIdentityPolicy(env.LOOM_ORIGIN ?? '', env.LOOM_STAGING_ACKNOWLEDGE ?? '');
  } else if (env.LOOM_PARTICIPATION_PROFILE !== 'synthetic') {
    throw new ConfigurationError('The worker requires an explicit participation profile.');
  }
}
