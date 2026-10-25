import { randomUUID } from 'node:crypto';
import type { SqlTransaction } from '../../db/postgres.js';
import { lockAttempt } from '../../application/attempt.js';
import { identityOf, type ActorContext } from '../publication/actor.js';
import {
  AccountInput,
  BootstrapInput,
  IssueInput,
  LifecycleInput,
  ReconcileInput,
  RenameInput,
  RevokeInput,
  input,
  requestDigest,
  semanticVersion,
} from './contracts.js';
import { IdentityError, identityFailure } from './errors.js';
import {
  identityAdministrationGuard,
  lockParticipants,
  requireAdministrator,
  verifyPolicy,
  type IdentityPolicy,
  type Transactions,
} from './policy.js';
import { deploymentCapability, matches, opaqueToken } from './secrets.js';
import { AdministrationBrowsing } from './browsing.js';

interface Outcome {
  id: string;
  participant_id: string;
  credential_id: string | null;
  request_digest: string;
  semantic_version: string;
}
export interface IdentityResult {
  operation_state: 'committed';
  idempotency: 'created' | 'replayed';
  operation_id: string;
  participant_id: string;
  credential_id?: string;
  credential_state?: 'active' | 'revoked' | 'expired';
  recovery?: 'revoke_and_replace';
}
export type IssuanceResult = IdentityResult & { secret?: string };
interface OperatorVerifiers {
  bootstrap: string;
  recovery: string;
}
const deploymentScope = '00000000-0000-4000-8000-000000000001';

async function outcomeFor(tx: SqlTransaction, scope: string, kind: string, key: string) {
  return (
    await tx.query<Outcome>(
      'SELECT id, participant_id, credential_id, request_digest, semantic_version FROM loom.identity_outcomes WHERE attempt_scope = $1 AND operation_kind = $2 AND idempotency_key = $3',
      [scope, kind, key],
    )
  ).rows[0];
}
function compare(outcome: Outcome, digest: string) {
  if (outcome.semantic_version !== semanticVersion || outcome.request_digest !== digest)
    throw new IdentityError('idempotency_conflict');
}
async function safeResult(
  tx: SqlTransaction,
  outcome: Outcome,
  disposition: IdentityResult['idempotency'],
): Promise<IdentityResult> {
  const result: IdentityResult = {
    operation_state: 'committed',
    idempotency: disposition,
    operation_id: outcome.id,
    participant_id: outcome.participant_id,
  };
  if (outcome.credential_id) {
    const row = (
      await tx.query<{ state: string; unexpired: boolean }>(
        'SELECT state, expires_at IS NULL OR expires_at > clock_timestamp() AS unexpired FROM loom.participant_credentials WHERE id = $1 FOR SHARE',
        [outcome.credential_id],
      )
    ).rows[0];
    if (!row) throw new IdentityError('unavailable');
    result.credential_id = outcome.credential_id;
    result.credential_state =
      row.state === 'revoked' ? 'revoked' : row.unexpired ? 'active' : 'expired';
    result.recovery = 'revoke_and_replace';
  }
  return result;
}
async function record(
  tx: SqlTransaction,
  values: {
    scope: string;
    actor?: ActorContext;
    authority: string;
    kind: string;
    key: string;
    digest: string;
    participantId: string;
    credentialId?: string;
  },
) {
  const id = randomUUID(),
    actor = values.actor ? identityOf(values.actor) : undefined;
  await tx.query(
    'INSERT INTO loom.identity_outcomes(id, attempt_scope, actor_id, operation_kind, idempotency_key, semantic_version, request_digest, participant_id, credential_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      id,
      values.scope,
      actor?.participantId ?? null,
      values.kind,
      values.key,
      semanticVersion,
      values.digest,
      values.participantId,
      values.credentialId ?? null,
    ],
  );
  await tx.query(
    'INSERT INTO loom.administrative_audit(id, actor_id, actor_credential_id, authority, target_id, action, operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [
      randomUUID(),
      actor?.participantId ?? null,
      actor?.credentialId ?? null,
      values.authority,
      values.participantId,
      values.kind,
      id,
    ],
  );
  return {
    id,
    participant_id: values.participantId,
    credential_id: values.credentialId ?? null,
    request_digest: values.digest,
    semantic_version: semanticVersion,
  };
}
async function reserveNickname(tx: SqlTransaction, nickname: string, participantId: string) {
  const normalized = nickname.toLowerCase();
  // Reservation protects an absent name, independently of an account row lock.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    JSON.stringify(['loom.identity.nickname', normalized]),
  ]);
  const reserved = (
    await tx.query<{ participant_id: string }>(
      'SELECT participant_id FROM loom.nickname_reservations WHERE normalized = $1',
      [normalized],
    )
  ).rows[0];
  if (reserved && reserved.participant_id !== participantId)
    throw new IdentityError('nickname_conflict');
  if (!reserved)
    await tx.query(
      'INSERT INTO loom.nickname_reservations(normalized, participant_id) VALUES ($1,$2)',
      [normalized, participantId],
    );
  await tx.query('UPDATE loom.participants SET nickname = $2 WHERE id = $1', [
    participantId,
    nickname,
  ]);
}
async function credentialRows(tx: SqlTransaction, participantId: string) {
  return (
    await tx.query<{ id: string; kind: string; state: string; unexpired: boolean }>(
      'SELECT id, kind, state, expires_at IS NULL OR expires_at > clock_timestamp() AS unexpired FROM loom.participant_credentials WHERE participant_id = $1 ORDER BY id FOR UPDATE',
      [participantId],
    )
  ).rows;
}

/** Dormant application operations: no normal startup route and no default operator. */
export class IdentityAdministration {
  readonly browsing: AdministrationBrowsing;
  private readonly policy: Readonly<IdentityPolicy>;
  private readonly operator: Readonly<OperatorVerifiers>;
  constructor(
    private readonly database: Transactions,
    policy: IdentityPolicy,
    operator: OperatorVerifiers,
  ) {
    verifyPolicy(policy);
    if (
      !/^[0-9a-f]{64}$/.test(operator.bootstrap) ||
      !/^[0-9a-f]{64}$/.test(operator.recovery) ||
      operator.bootstrap === operator.recovery
    )
      throw new Error('Distinct deployment capability verifiers are required.');
    this.policy = Object.freeze({ ...policy });
    this.operator = Object.freeze({ ...operator });
    this.browsing = new AdministrationBrowsing(database);
  }
  private async run<T>(operation: (tx: SqlTransaction) => Promise<T>) {
    try {
      return await this.database.transaction(operation);
    } catch (error) {
      throw identityFailure(error);
    }
  }
  private async administratorAttempt<T>(
    actor: ActorContext,
    kind: string,
    key: string,
    target: string | undefined,
    operation: (tx: SqlTransaction, outcome: Outcome | undefined) => Promise<T>,
  ) {
    const scope = identityOf(actor).participantId;
    return this.run(async (tx) => {
      await lockAttempt(tx, scope, kind, key);
      await identityAdministrationGuard(tx);
      await lockParticipants(tx, target ? [scope, target] : [scope]);
      await requireAdministrator(tx, actor);
      return operation(tx, await outcomeFor(tx, scope, kind, key));
    });
  }
  async bootstrap(capability: string, value: unknown): Promise<IdentityResult> {
    const prepared = input(BootstrapInput, value),
      kind = 'community.bootstrap';
    if (!deploymentCapability(capability) || !matches(capability, this.operator.bootstrap))
      throw new IdentityError('unauthenticated');
    const digest = requestDigest(kind, [prepared.nickname]);
    return this.run(async (tx) => {
      await lockAttempt(tx, deploymentScope, kind, prepared.idempotency_key);
      await identityAdministrationGuard(tx);
      const initialized = (
        await tx.query<{ bootstrap_verifier: string }>(
          'SELECT bootstrap_verifier FROM loom.identity_initialization WHERE id = 1',
          [],
        )
      ).rows[0];
      if (initialized && !matches(capability, initialized.bootstrap_verifier))
        throw new IdentityError('unauthenticated');
      const outcome = await outcomeFor(tx, deploymentScope, kind, prepared.idempotency_key);
      if (outcome) {
        compare(outcome, digest);
        return safeResult(tx, outcome, 'replayed');
      }
      if (initialized) throw new IdentityError('bootstrap_closed');
      const participantId = randomUUID();
      await tx.query('INSERT INTO loom.participants(id,state,role,kind) VALUES ($1,$2,$3,$4)', [
        participantId,
        'active',
        'administrator',
        'human',
      ]);
      await reserveNickname(tx, prepared.nickname, participantId);
      await tx.query(
        'INSERT INTO loom.identity_initialization(id,administrator_id,bootstrap_verifier,recovery_verifier) VALUES (1,$1,$2,$3)',
        [participantId, this.operator.bootstrap, this.operator.recovery],
      );
      return safeResult(
        tx,
        await record(tx, {
          scope: deploymentScope,
          authority: 'deployment_bootstrap',
          kind,
          key: prepared.idempotency_key,
          digest,
          participantId,
        }),
        'created',
      );
    });
  }
  async createAccount(actor: ActorContext, value: unknown): Promise<IdentityResult> {
    const prepared = input(AccountInput, value),
      kind = 'account.create';
    const digest = requestDigest(kind, [prepared.nickname, prepared.kind, prepared.role]);
    return this.administratorAttempt(
      actor,
      kind,
      prepared.idempotency_key,
      undefined,
      async (tx, outcome) => {
        if (outcome) {
          compare(outcome, digest);
          return safeResult(tx, outcome, 'replayed');
        }
        const participantId = randomUUID();
        await tx.query('INSERT INTO loom.participants(id,state,role,kind) VALUES ($1,$2,$3,$4)', [
          participantId,
          'active',
          prepared.role,
          prepared.kind,
        ]);
        await reserveNickname(tx, prepared.nickname, participantId);
        return safeResult(
          tx,
          await record(tx, {
            scope: identityOf(actor).participantId,
            actor,
            authority: 'administrator',
            kind,
            key: prepared.idempotency_key,
            digest,
            participantId,
          }),
          'created',
        );
      },
    );
  }
  async issueCredential(actor: ActorContext, value: unknown): Promise<IssuanceResult> {
    const prepared = input(IssueInput, value),
      kind = 'credential.issue';
    if ((prepared.kind === 'agent') !== (prepared.purpose === null))
      throw new IdentityError('invalid_request');
    const digest = requestDigest(kind, [
      prepared.participant_id,
      prepared.kind,
      prepared.purpose,
      prepared.label,
      prepared.replace_credential_id,
    ]);
    const token = opaqueToken(prepared.kind);
    return this.administratorAttempt(
      actor,
      kind,
      prepared.idempotency_key,
      prepared.participant_id,
      async (tx, outcome) => {
        if (outcome) {
          compare(outcome, digest);
          return safeResult(tx, outcome, 'replayed');
        }
        await this.insertIssuedCredential(tx, prepared, token);
        const saved = await record(tx, {
          scope: identityOf(actor).participantId,
          actor,
          authority: 'administrator',
          kind,
          key: prepared.idempotency_key,
          digest,
          participantId: prepared.participant_id,
          credentialId: token.id,
        });
        return { ...(await safeResult(tx, saved, 'created')), secret: token.secret };
      },
    ); // Never disclose a fresh secret until the connection owner confirms COMMIT.
  }
  private async insertIssuedCredential(
    tx: SqlTransaction,
    prepared: {
      participant_id: string;
      kind: 'agent' | 'enrollment';
      purpose: 'enroll' | 'recover' | null;
      label: string;
      replace_credential_id: string | null;
    },
    token: ReturnType<typeof opaqueToken>,
  ) {
    const participant = (
      await tx.query<{ state: string; kind: string }>(
        'SELECT state, kind FROM loom.participants WHERE id = $1',
        [prepared.participant_id],
      )
    ).rows[0];
    if (
      participant?.state !== 'active' ||
      participant.kind !== (prepared.kind === 'agent' ? 'agent' : 'human')
    )
      throw new IdentityError('unavailable');
    const rows = await credentialRows(tx, prepared.participant_id);
    if (prepared.replace_credential_id) {
      const old = rows.find(
        (row) => row.id === prepared.replace_credential_id && row.kind === prepared.kind,
      );
      if (!old) throw new IdentityError('unavailable');
      await tx.query('UPDATE loom.participant_credentials SET state = $2 WHERE id = $1', [
        old.id,
        'revoked',
      ]);
    }
    const count = rows.filter(
      (row) =>
        row.kind === prepared.kind &&
        row.state === 'active' &&
        row.unexpired &&
        row.id !== prepared.replace_credential_id,
    ).length;
    if (count >= (prepared.kind === 'agent' ? this.policy.maxAgentCredentials : 1))
      throw new IdentityError('credential_limit');
    await tx.query(
      "INSERT INTO loom.participant_credentials(id,participant_id,state,kind,label,verifier,expires_at) VALUES ($1,$2,'active',$3,$4,$5,clock_timestamp() + $6::integer * interval '1 second')",
      [
        token.id,
        prepared.participant_id,
        prepared.kind,
        prepared.label,
        token.verifier,
        prepared.kind === 'agent' ? this.policy.agentSeconds : this.policy.enrollmentSeconds,
      ],
    );
    if (prepared.kind === 'enrollment')
      await tx.query('INSERT INTO loom.enrollment_tickets VALUES ($1,$2)', [
        token.id,
        prepared.purpose,
      ]);
  }
  /** Offline deployment action, deliberately absent from every HTTP fixture. */
  async deploymentEnrollment(
    capability: string,
    mode: 'bootstrap' | 'recovery',
    value: unknown,
  ): Promise<IssuanceResult> {
    const prepared = input(IssueInput, value),
      kind = mode === 'bootstrap' ? 'deployment.enroll' : 'deployment.recover';
    if (
      prepared.kind !== 'enrollment' ||
      prepared.purpose !== (mode === 'bootstrap' ? 'enroll' : 'recover')
    )
      throw new IdentityError('invalid_request');
    if (!deploymentCapability(capability) || !matches(capability, this.operator[mode]))
      throw new IdentityError('unauthenticated');
    const digest = requestDigest(kind, [
      prepared.participant_id,
      prepared.label,
      prepared.replace_credential_id,
    ]);
    const token = opaqueToken('enrollment');
    return this.run(async (tx) => {
      await lockAttempt(tx, deploymentScope, kind, prepared.idempotency_key);
      await identityAdministrationGuard(tx);
      const initialized = (
        await tx.query<{
          administrator_id: string;
          bootstrap_verifier: string;
          recovery_verifier: string;
        }>('SELECT * FROM loom.identity_initialization WHERE id = 1', [])
      ).rows[0];
      if (
        !initialized ||
        prepared.participant_id !== initialized.administrator_id ||
        !matches(
          capability,
          mode === 'bootstrap' ? initialized.bootstrap_verifier : initialized.recovery_verifier,
        )
      )
        throw new IdentityError('unauthenticated');
      await lockParticipants(tx, [initialized.administrator_id]);
      const outcome = await outcomeFor(tx, deploymentScope, kind, prepared.idempotency_key);
      if (outcome) {
        compare(outcome, digest);
        return safeResult(tx, outcome, 'replayed');
      }
      const passkeys = await tx.query(
        'SELECT credential_id FROM loom.passkeys JOIN loom.participant_credentials c ON c.id = credential_id WHERE c.participant_id = $1',
        [initialized.administrator_id],
      );
      if (mode === 'bootstrap' && passkeys.rowCount) throw new IdentityError('bootstrap_closed');
      await this.insertIssuedCredential(tx, prepared, token);
      const saved = await record(tx, {
        scope: deploymentScope,
        authority: mode === 'bootstrap' ? 'deployment_bootstrap' : 'deployment_recovery',
        kind,
        key: prepared.idempotency_key,
        digest,
        participantId: prepared.participant_id,
        credentialId: token.id,
      });
      return { ...(await safeResult(tx, saved, 'created')), secret: token.secret };
    });
  }
  async setAccountState(actor: ActorContext, value: unknown): Promise<IdentityResult> {
    const prepared = input(LifecycleInput, value),
      kind = 'account.state';
    const digest = requestDigest(kind, [prepared.participant_id, prepared.state, prepared.role]);
    return this.administratorAttempt(
      actor,
      kind,
      prepared.idempotency_key,
      prepared.participant_id,
      async (tx, outcome) => {
        if (outcome) {
          compare(outcome, digest);
          return safeResult(tx, outcome, 'replayed');
        }
        const target = (
          await tx.query<{ state: string; role: string }>(
            'SELECT state, role FROM loom.participants WHERE id = $1',
            [prepared.participant_id],
          )
        ).rows[0];
        if (!target || (target.state === 'revoked' && prepared.state !== 'revoked'))
          throw new IdentityError('unavailable');
        if (
          target.state === 'active' &&
          target.role === 'administrator' &&
          (prepared.state !== 'active' || prepared.role !== 'administrator')
        ) {
          const others = await tx.query(
            "SELECT id FROM loom.participants WHERE state = 'active' AND role = 'administrator' AND id <> $1",
            [prepared.participant_id],
          );
          if (!others.rowCount) throw new IdentityError('last_administrator');
        }
        await tx.query('UPDATE loom.participants SET state = $2, role = $3 WHERE id = $1', [
          prepared.participant_id,
          prepared.state,
          prepared.role,
        ]);
        return safeResult(
          tx,
          await record(tx, {
            scope: identityOf(actor).participantId,
            actor,
            authority: 'administrator',
            kind,
            key: prepared.idempotency_key,
            digest,
            participantId: prepared.participant_id,
          }),
          'created',
        );
      },
    );
  }
  async renameAccount(actor: ActorContext, value: unknown): Promise<IdentityResult> {
    const prepared = input(RenameInput, value),
      kind = 'account.rename';
    const digest = requestDigest(kind, [prepared.participant_id, prepared.nickname]);
    return this.administratorAttempt(
      actor,
      kind,
      prepared.idempotency_key,
      prepared.participant_id,
      async (tx, outcome) => {
        if (outcome) {
          compare(outcome, digest);
          return safeResult(tx, outcome, 'replayed');
        }
        if (
          !(
            await tx.query('SELECT id FROM loom.participants WHERE id = $1', [
              prepared.participant_id,
            ])
          ).rowCount
        )
          throw new IdentityError('unavailable');
        await reserveNickname(tx, prepared.nickname, prepared.participant_id);
        return safeResult(
          tx,
          await record(tx, {
            scope: identityOf(actor).participantId,
            actor,
            authority: 'administrator',
            kind,
            key: prepared.idempotency_key,
            digest,
            participantId: prepared.participant_id,
          }),
          'created',
        );
      },
    );
  }
  async revokeCredential(actor: ActorContext, value: unknown): Promise<IdentityResult> {
    const prepared = input(RevokeInput, value),
      kind = 'credential.revoke';
    const digest = requestDigest(kind, [prepared.participant_id, prepared.credential_id]);
    return this.administratorAttempt(
      actor,
      kind,
      prepared.idempotency_key,
      prepared.participant_id,
      async (tx, outcome) => {
        if (outcome) {
          compare(outcome, digest);
          return safeResult(tx, outcome, 'replayed');
        }
        const target = (await credentialRows(tx, prepared.participant_id)).find(
          (row) => row.id === prepared.credential_id,
        );
        if (!target) throw new IdentityError('unavailable');
        await tx.query('UPDATE loom.participant_credentials SET state = $2 WHERE id = $1', [
          target.id,
          'revoked',
        ]);
        if (target.kind === 'passkey')
          await tx.query(
            "UPDATE loom.participant_credentials SET state = 'revoked' WHERE parent_credential_id = $1",
            [target.id],
          );
        return safeResult(
          tx,
          await record(tx, {
            scope: identityOf(actor).participantId,
            actor,
            authority: 'administrator',
            kind,
            key: prepared.idempotency_key,
            digest,
            participantId: prepared.participant_id,
            credentialId: target.id,
          }),
          'created',
        );
      },
    );
  }
  async reconcile(
    actor: ActorContext,
    value: unknown,
  ): Promise<IdentityResult | { operation_state: 'not_recorded' }> {
    const prepared = input(ReconcileInput, value);
    return this.administratorAttempt(
      actor,
      prepared.operation_kind,
      prepared.idempotency_key,
      undefined,
      async (tx, outcome) =>
        outcome ? safeResult(tx, outcome, 'replayed') : { operation_state: 'not_recorded' },
    );
  }
  async listAccounts(actor: ActorContext) {
    return this.run(async (tx) => {
      await requireAdministrator(tx, actor);
      return (
        await tx.query<{ id: string; nickname: string; kind: string; role: string; state: string }>(
          "SELECT id,nickname,kind,role,state FROM loom.participants WHERE kind <> 'internal' ORDER BY id LIMIT 100",
          [],
        )
      ).rows;
    });
  }
  async audit(actor: ActorContext) {
    return this.run(async (tx) => {
      await requireAdministrator(tx, actor);
      return (
        await tx.query(
          'SELECT id,actor_id,actor_credential_id,authority,target_id,action,operation_id,recorded_at FROM loom.administrative_audit ORDER BY recorded_at,id LIMIT 100',
          [],
        )
      ).rows;
    });
  }
  async listCredentials(actor: ActorContext, participantId: string) {
    return this.run(async (tx) => {
      await requireAdministrator(tx, actor);
      return (
        await tx.query(
          'SELECT id,kind,label,state,expires_at,created_at,parent_credential_id FROM loom.participant_credentials WHERE participant_id = $1 ORDER BY id LIMIT 100',
          [participantId],
        )
      ).rows;
    });
  }
}
