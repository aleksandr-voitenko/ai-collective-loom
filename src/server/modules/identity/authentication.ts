import { randomUUID } from 'node:crypto';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { SqlTransaction } from '../../db/postgres.js';
import { actorFromVerifiedIdentity, identityOf, type ActorContext } from '../publication/actor.js';
import { RegisterFinish, RegisterStart, SignInFinish, input } from './contracts.js';
import { IdentityError, identityFailure } from './errors.js';
import { lockParticipants, requireActor, verifyPolicy, type IdentityPolicy, type Transactions } from './policy.js';
import { browserBinding, matches, opaqueToken, tokenId, verifier } from './secrets.js';

interface TokenRow { id: string; participant_id: string; verifier: string; state: string; kind: string; unexpired: boolean; label: string }
interface Challenge { id: string; challenge: string; kind: string; ticket_id: string | null; binding_verifier: string }
interface Passkey { credential_id: string; participant_id: string; webauthn_id: string; public_key: Buffer; counter: string; transports: string[]; backup_eligible: boolean }
const tokenColumns = 'id,participant_id,verifier,state,kind,label,expires_at > clock_timestamp() AS unexpired';

function sameOriginClientData(encoded: string) {
  try {
    const data: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!data || typeof data !== 'object' || ('crossOrigin' in data && data.crossOrigin !== false)
      || 'topOrigin' in data) throw new IdentityError('invalid_proof');
  } catch { throw new IdentityError('invalid_proof'); }
}

/** Verifies proofs; only this boundary turns transport credentials into actors. */
export class IdentityAuthentication {
  private starts = { minute: 0, count: 0 };
  readonly policy: Readonly<IdentityPolicy>;
  constructor(private readonly database: Transactions, policy: IdentityPolicy) { verifyPolicy(policy); this.policy = Object.freeze({ ...policy }); }
  private async run<T>(operation: (tx: SqlTransaction) => Promise<T>) {
    try { return await this.database.transaction(operation); } catch (error) { throw identityFailure(error); }
  }
  private throttle() {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.starts.minute !== minute) this.starts = { minute, count: 0 };
    if (++this.starts.count > this.policy.startsPerMinute) throw new IdentityError('rate_limited');
  }
  private async token(tx: SqlTransaction, secret: string, kind: 'agent' | 'session' | 'enrollment') {
    const id = tokenId(secret, kind);
    if (!id) throw new IdentityError('unauthenticated');
    const row = (await tx.query<TokenRow>('SELECT ' + tokenColumns + ' FROM loom.participant_credentials WHERE id = $1', [id])).rows[0];
    if (!row || row.kind !== kind || row.state !== 'active' || !row.unexpired || !matches(secret, row.verifier)) throw new IdentityError('unauthenticated');
    return row;
  }
  async authenticate(secret: string, channel: 'agent' | 'session'): Promise<ActorContext> {
    return this.run(async tx => {
      const row = await this.token(tx, secret, channel);
      const actor = actorFromVerifiedIdentity({ participantId: row.participant_id, credentialId: row.id });
      const authority = await requireActor(tx, actor);
      if (authority.kind !== (channel === 'agent' ? 'agent' : 'human')) throw new IdentityError('unauthenticated');
      return actor;
    });
  }
  async self(actor: ActorContext) {
    return this.run(async tx => {
      const authority = await requireActor(tx, actor);
      return { participant_id: authority.participantId, credential_id: authority.credentialId,
        nickname: authority.nickname, kind: authority.kind, role: authority.administrator ? 'administrator' : 'participant' };
    });
  }
  private async requireTicket(tx: SqlTransaction, ticketId: string) {
    const row = (await tx.query<TokenRow & { purpose: 'enroll' | 'recover'; nickname: string }>(`
SELECT c.id,c.participant_id,c.verifier,c.state,c.kind,c.label,c.expires_at > clock_timestamp() AS unexpired,t.purpose,p.nickname
FROM loom.participant_credentials c JOIN loom.enrollment_tickets t ON t.credential_id = c.id
JOIN loom.participants p ON p.id = c.participant_id
WHERE c.id = $1 AND p.state = 'active' AND p.kind = 'human'`, [ticketId])).rows[0];
    if (!row || row.kind !== 'enrollment' || row.state !== 'active' || !row.unexpired) throw new IdentityError('invalid_proof');
    return row;
  }
  async startRegistration(value: unknown) {
    this.throttle();
    const prepared = input(RegisterStart, value);
    const ticket = await this.run(async tx => {
      const credential = await this.token(tx, prepared.ticket, 'enrollment');
      return this.requireTicket(tx, credential.id);
    });
    const existing = await this.run(async tx => (await tx.query<{ webauthn_id: string }>('SELECT webauthn_id FROM loom.passkeys JOIN loom.participant_credentials c ON c.id = credential_id WHERE c.participant_id = $1 AND c.state = $2', [ticket.participant_id, 'active'])).rows);
    const options = await generateRegistrationOptions({ rpName: 'AI Collective Loom prototype', rpID: this.policy.rpId,
      userID: Uint8Array.from(Buffer.from(ticket.participant_id, 'utf8')), userName: ticket.nickname, userDisplayName: ticket.nickname,
      attestationType: 'none', supportedAlgorithmIDs: [-7],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      excludeCredentials: existing.map(row => ({ id: row.webauthn_id })), timeout: this.policy.challengeSeconds * 1000 });
    const challengeId = randomUUID(), binding = browserBinding();
    await this.run(async tx => {
      await lockParticipants(tx, [ticket.participant_id]);
      await this.requireTicket(tx, ticket.id);
      await tx.query("INSERT INTO loom.webauthn_challenges(id,kind,challenge,binding_verifier,ticket_id,expires_at) VALUES ($1,'register',$2,$3,$4,clock_timestamp() + $5::integer * interval '1 second')",
        [challengeId, options.challenge, verifier(binding), ticket.id, this.policy.challengeSeconds]);
    });
    return { challenge_id: challengeId, options, binding };
  }
  async startSignIn() {
    this.throttle();
    const options = await generateAuthenticationOptions({ rpID: this.policy.rpId, userVerification: 'required', timeout: this.policy.challengeSeconds * 1000 });
    const challengeId = randomUUID(), binding = browserBinding();
    await this.run(async tx => {
      await tx.query("INSERT INTO loom.webauthn_challenges(id,kind,challenge,binding_verifier,expires_at) VALUES ($1,'authenticate',$2,$3,clock_timestamp() + $4::integer * interval '1 second')", [challengeId, options.challenge, verifier(binding), this.policy.challengeSeconds]);
    });
    return { challenge_id: challengeId, options, binding };
  }
  private async consumeChallenge(id: string, kind: string, binding: string): Promise<Challenge> {
    // Proof verification happens outside SQL. Consumption commits first, so a
    // cryptographic failure cannot roll back single-use protection.
    const challenge = await this.run(async tx => {
      const row = (await tx.query<Challenge>('SELECT id,kind,challenge,ticket_id,binding_verifier FROM loom.webauthn_challenges WHERE id = $1 AND kind = $2 AND consumed_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE', [id, kind])).rows[0];
      if (!row || !matches(binding, row.binding_verifier)) throw new IdentityError('invalid_proof');
      await tx.query('UPDATE loom.webauthn_challenges SET consumed_at = clock_timestamp() WHERE id = $1', [id]);
      return row;
    });
    return challenge;
  }
  async finishRegistration(value: unknown, binding: string) {
    const prepared = input(RegisterFinish, value);
    const challenge = await this.consumeChallenge(prepared.challenge_id, 'register', binding);
    sameOriginClientData(prepared.response.response.clientDataJSON);
    if (prepared.response.id !== prepared.response.rawId) throw new IdentityError('invalid_proof');
    let verified;
    try { verified = await verifyRegistrationResponse({ response: prepared.response, expectedChallenge: challenge.challenge,
      expectedOrigin: this.policy.origin, expectedRPID: this.policy.rpId, requireUserVerification: true, supportedAlgorithmIDs: [-7] }); }
    catch { throw new IdentityError('invalid_proof'); }
    if (!verified.verified) throw new IdentityError('invalid_proof');
    const registration = verified.registrationInfo;
    const ticket = await this.run(tx => this.requireTicket(tx, challenge.ticket_id!));
    return this.run(async tx => {
      await lockParticipants(tx, [ticket.participant_id]);
      const current = await this.requireTicket(tx, ticket.id);
      const credentials = (await tx.query<{ id: string; kind: string; state: string }>('SELECT id,kind,state FROM loom.participant_credentials WHERE participant_id = $1 ORDER BY id FOR UPDATE', [ticket.participant_id])).rows;
      const active = credentials.filter(row => row.kind === 'passkey' && row.state === 'active').length;
      if (current.purpose === 'enroll' && active >= this.policy.maxPasskeys) throw new IdentityError('credential_limit');
      if (current.purpose === 'recover') await tx.query("UPDATE loom.participant_credentials SET state = 'revoked' WHERE participant_id = $1 AND kind IN ('passkey','session')", [ticket.participant_id]);
      const credentialId = randomUUID();
      await tx.query("INSERT INTO loom.participant_credentials(id,participant_id,state,kind,label) VALUES ($1,$2,'active','passkey',$3)", [credentialId, ticket.participant_id, current.label]);
      await tx.query('INSERT INTO loom.passkeys(credential_id,webauthn_id,public_key,counter,transports,backup_eligible,backed_up,enrollment_credential_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [credentialId, registration.credential.id, Buffer.from(registration.credential.publicKey), registration.credential.counter,
          registration.credential.transports ?? [], registration.credentialDeviceType === 'multiDevice', registration.credentialBackedUp, ticket.id]);
      await tx.query("UPDATE loom.participant_credentials SET state = 'revoked' WHERE id = $1", [ticket.id]);
      // Admission/recovery attribution is the ticket's immutable issuance audit.
      // Binding records contain the public key and consumed ticket, never its secret.
      return { participant_id: ticket.participant_id, credential_id: credentialId, enrollment_state: 'bound' as const };
    });
  }
  async finishSignIn(value: unknown, binding: string) {
    const prepared = input(SignInFinish, value);
    const challenge = await this.consumeChallenge(prepared.challenge_id, 'authenticate', binding);
    sameOriginClientData(prepared.response.response.clientDataJSON);
    if (prepared.response.id !== prepared.response.rawId) throw new IdentityError('invalid_proof');
    const passkey = await this.run(async tx => (await tx.query<Passkey>(`
SELECT p.credential_id,c.participant_id,p.webauthn_id,p.public_key,p.counter::text,p.transports,p.backup_eligible
FROM loom.passkeys p JOIN loom.participant_credentials c ON c.id = p.credential_id WHERE p.webauthn_id = $1`, [prepared.response.id])).rows[0]);
    if (!passkey || (prepared.response.response.userHandle !== undefined
      && prepared.response.response.userHandle !== Buffer.from(passkey.participant_id, 'utf8').toString('base64url'))) throw new IdentityError('invalid_proof');
    let verified;
    try { verified = await verifyAuthenticationResponse({ response: prepared.response, expectedChallenge: challenge.challenge,
      expectedOrigin: this.policy.origin, expectedRPID: this.policy.rpId, requireUserVerification: true,
      credential: { id: passkey.webauthn_id, publicKey: Uint8Array.from(passkey.public_key), counter: Number(passkey.counter), transports: passkey.transports } }); }
    catch { throw new IdentityError('invalid_proof'); }
    if (!verified.verified || (verified.authenticationInfo.credentialDeviceType === 'multiDevice') !== passkey.backup_eligible) throw new IdentityError('invalid_proof');
    const token = opaqueToken('session');
    const actor = actorFromVerifiedIdentity({ participantId: passkey.participant_id, credentialId: passkey.credential_id });
    await this.run(async tx => {
      await lockParticipants(tx, [passkey.participant_id]);
      const authority = await requireActor(tx, actor);
      if (authority.kind !== 'human' || authority.credentialKind !== 'passkey') throw new IdentityError('invalid_proof');
      const counter = (await tx.query<{ counter: string }>('SELECT counter::text FROM loom.passkeys WHERE credential_id = $1 FOR UPDATE', [passkey.credential_id])).rows[0];
      const next = verified.authenticationInfo.newCounter;
      if (!counter || ((next > 0 || Number(counter.counter) > 0) && next <= Number(counter.counter))) throw new IdentityError('invalid_proof');
      const sessions = await tx.query("SELECT id FROM loom.participant_credentials WHERE participant_id = $1 AND kind = 'session' AND state = 'active' AND expires_at > clock_timestamp()", [passkey.participant_id]);
      if (Number(sessions.rowCount) >= this.policy.maxSessions) throw new IdentityError('credential_limit');
      await tx.query('UPDATE loom.passkeys SET counter = $2, backed_up = $3 WHERE credential_id = $1', [passkey.credential_id, next, verified.authenticationInfo.credentialBackedUp]);
      await tx.query("INSERT INTO loom.participant_credentials(id,participant_id,state,kind,label,verifier,expires_at,parent_credential_id) VALUES ($1,$2,'active','session','browser',$3,clock_timestamp() + $4::integer * interval '1 second',$5)",
        [token.id, passkey.participant_id, token.verifier, this.policy.sessionSeconds, passkey.credential_id]);
    });
    return { participant_id: passkey.participant_id, credential_id: token.id, session: token.secret };
  }
  async logout(actor: ActorContext) {
    return this.run(async tx => {
      const identity = identityOf(actor);
      await lockParticipants(tx, [identity.participantId]);
      const authority = await requireActor(tx, actor);
      if (authority.credentialKind !== 'session') throw new IdentityError('invalid_request');
      await tx.query("UPDATE loom.participant_credentials SET state = 'revoked' WHERE id = $1", [identity.credentialId]);
      return { session_state: 'revoked' as const };
    });
  }
}
