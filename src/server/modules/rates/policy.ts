import { createHash, randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import * as C from '../../../contracts/rates.js';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import { lockAttempt } from '../../application/attempt.js';
import { identityOf, type ActorContext } from '../publication/actor.js';
import { PublicationError, safeError } from '../publication/errors.js';
import { lockActor } from '../publication/guards.js';
import { lockedPolicy } from './accounting.js';

type Decision = Omit<C.RatePolicyValue, 'window_seconds'> & {
  id: string;
  request_digest: string;
};
async function administrator(tx: SqlTransaction, actor: ActorContext) {
  const current = await lockActor(tx, actor);
  if (!current.administrator) throw new PublicationError('forbidden');
  return current;
}
async function savedDecision(tx: SqlTransaction, actor: string, key: string) {
  return (
    await tx.query<Decision>(
      `SELECT id,request_digest,version,ordinary_requests,
    new_publications,recovery_control FROM loom.participation_rate_decisions
    WHERE actor_id=$1 AND idempotency_key=$2`,
      [actor, key],
    )
  ).rows[0];
}
function original(row: Decision): C.RatePolicyValue {
  return {
    version: row.version,
    ordinary_requests: row.ordinary_requests,
    new_publications: row.new_publications,
    recovery_control: row.recovery_control,
    window_seconds: 60,
  };
}
function receipt(row: Decision, current: C.RatePolicyValue, idempotency: 'created' | 'replayed') {
  return {
    operation_state: 'committed' as const,
    idempotency,
    operation_id: row.id,
    original: original(row),
    current,
  };
}

export class ParticipationRatePolicy {
  constructor(private readonly database: Transactions) {}
  async inspect(actor: ActorContext) {
    try {
      return await this.database.transaction(async (tx) => {
        await administrator(tx, actor);
        return lockedPolicy(tx);
      });
    } catch (error) {
      return safeError(error);
    }
  }
  async update(actor: ActorContext, value: unknown) {
    if (!Value.Check(C.RatePolicyInput, value)) throw new PublicationError('invalid_input');
    const key = value.idempotency_key.toLowerCase();
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          'participation-rates-1',
          value.expected_version,
          value.ordinary_requests,
          value.new_publications,
          value.recovery_control,
        ]),
      )
      .digest('hex');
    try {
      return await this.database.transaction(async (tx) => {
        await lockAttempt(tx, identityOf(actor).participantId, 'participation.rates', key);
        const authority = await administrator(tx, actor);
        const saved = await savedDecision(tx, authority.participantId, key);
        const current = await lockedPolicy(tx, !saved);
        if (saved) {
          if (saved.request_digest !== digest) throw new PublicationError('idempotency_conflict');
          return receipt(saved, current, 'replayed');
        }
        if (current.version !== value.expected_version)
          throw new PublicationError('rate_policy_conflict');
        if (current.version >= 10001) throw new PublicationError('rate_policy_capacity');
        const next = {
          version: current.version + 1,
          ordinary_requests: value.ordinary_requests,
          new_publications: value.new_publications,
          recovery_control: value.recovery_control,
          window_seconds: 60 as const,
        };
        await tx.query(
          `UPDATE loom.participation_rate_policy SET version=$1,ordinary_requests=$2,
          new_publications=$3,recovery_control=$4 WHERE id=1`,
          [next.version, next.ordinary_requests, next.new_publications, next.recovery_control],
        );
        const decision = { ...next, id: randomUUID(), request_digest: digest };
        await tx.query(
          `INSERT INTO loom.participation_rate_decisions(id,actor_id,actor_credential_id,
          idempotency_key,request_digest,expected_version,version,ordinary_requests,new_publications,recovery_control)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            decision.id,
            authority.participantId,
            authority.credentialId,
            key,
            digest,
            current.version,
            next.version,
            next.ordinary_requests,
            next.new_publications,
            next.recovery_control,
          ],
        );
        return receipt(decision, next, 'created');
      });
    } catch (error) {
      return safeError(error);
    }
  }
  async status(actor: ActorContext, value: unknown) {
    if (!Value.Check(C.RateStatusInput, value)) throw new PublicationError('invalid_input');
    try {
      return await this.database.transaction(async (tx) => {
        await lockAttempt(
          tx,
          identityOf(actor).participantId,
          'participation.rates',
          value.idempotency_key.toLowerCase(),
        );
        const authority = await administrator(tx, actor);
        const saved = await savedDecision(
          tx,
          authority.participantId,
          value.idempotency_key.toLowerCase(),
        );
        if (!saved) return { operation_state: 'not_recorded' as const };
        return receipt(saved, await lockedPolicy(tx), 'replayed');
      });
    } catch (error) {
      return safeError(error);
    }
  }
  async audit(actor: ActorContext, value: unknown) {
    if (!Value.Check(C.RateAuditInput, value)) throw new PublicationError('invalid_input');
    try {
      return await this.database.transaction(async (tx) => {
        await administrator(tx, actor);
        const limit = value.limit ?? 12;
        const rows = (
          await tx.query<
            Decision & { actor_id: string; actor_credential_id: string; recorded_at: Date }
          >(
            `
          SELECT id,actor_id,actor_credential_id,recorded_at,version,ordinary_requests,new_publications,recovery_control
          FROM loom.participation_rate_decisions WHERE version < $1 ORDER BY version DESC LIMIT $2`,
            [value.before_version ?? 10002, limit + 1],
          )
        ).rows;
        return {
          items: rows.slice(0, limit).map((row) => ({
            operation_id: row.id,
            actor_id: row.actor_id,
            actor_credential_id: row.actor_credential_id,
            recorded_at: row.recorded_at.toISOString(),
            policy: original(row),
          })),
          next_before_version: rows.length > limit ? rows[limit - 1]!.version : null,
        };
      });
    } catch (error) {
      return safeError(error);
    }
  }
}
