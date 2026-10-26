import { createHash, randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import * as C from '../../../contracts/file-policy.js';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import { lockAttempt } from '../../application/attempt.js';
import { identityOf, type ActorContext } from '../publication/actor.js';
import { PublicationError, safeError } from '../publication/errors.js';
import { lockActor } from '../publication/guards.js';
import { fileGuard } from './file-context.js';
import { filePolicy, fileUsage } from './file-accounting.js';

type Decision = C.FilePolicyValue & {
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
      `SELECT id,request_digest,version,max_file_bytes,
    max_unfinished_uploads,participant_reserved_bytes,community_reserved_bytes FROM loom.file_policy_decisions
    WHERE actor_id=$1 AND idempotency_key=$2`,
      [actor, key],
    )
  ).rows[0];
}
function original(row: Decision): C.FilePolicyValue {
  return {
    version: row.version,
    max_file_bytes: row.max_file_bytes,
    max_unfinished_uploads: row.max_unfinished_uploads,
    participant_reserved_bytes: row.participant_reserved_bytes,
    community_reserved_bytes: row.community_reserved_bytes,
  };
}
function receipt(row: Decision, current: C.FilePolicyValue, idempotency: 'created' | 'replayed') {
  return {
    operation_state: 'committed' as const,
    idempotency,
    operation_id: row.id,
    original: original(row),
    current,
  };
}

export class FileAdmissionPolicy {
  constructor(private readonly database: Transactions) {}
  async inspect(actor: ActorContext, community = false) {
    try {
      return await this.database.transaction(async (tx) => {
        const authority = community ? await administrator(tx, actor) : await lockActor(tx, actor);
        await fileGuard(tx);
        const policy = await filePolicy(tx);
        const usage = await fileUsage(tx, authority.participantId);
        const observed = (await tx.query<{ at: Date }>('SELECT clock_timestamp() AS at', []))
          .rows[0]!.at;
        return {
          policy,
          observed_at: observed.toISOString(),
          own: {
            reserved_bytes: usage.ownerBytes,
            unfinished_uploads: usage.unfinished,
            reserved_bytes_over_limit: usage.ownerBytes > policy.participant_reserved_bytes,
            unfinished_uploads_over_limit: usage.unfinished > policy.max_unfinished_uploads,
          },
          ...(community
            ? {
                community: {
                  reserved_bytes: usage.bytes,
                  reserved_bytes_over_limit: usage.bytes > policy.community_reserved_bytes,
                },
              }
            : {}),
        };
      });
    } catch (error) {
      return safeError(error);
    }
  }
  async update(actor: ActorContext, value: unknown) {
    if (!Value.Check(C.FilePolicyInput, value)) throw new PublicationError('invalid_input');
    const key = value.idempotency_key.toLowerCase();
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          'file-admission-1',
          value.expected_version,
          value.max_file_bytes,
          value.max_unfinished_uploads,
          value.participant_reserved_bytes,
          value.community_reserved_bytes,
        ]),
      )
      .digest('hex');
    try {
      return await this.database.transaction(async (tx) => {
        await lockAttempt(tx, identityOf(actor).participantId, 'file.policy', key);
        const authority = await administrator(tx, actor);
        await fileGuard(tx);
        const saved = await savedDecision(tx, authority.participantId, key);
        const current = await filePolicy(tx);
        if (saved) {
          if (saved.request_digest !== digest) throw new PublicationError('idempotency_conflict');
          return receipt(saved, current, 'replayed');
        }
        if (current.version !== value.expected_version)
          throw new PublicationError('file_policy_conflict');
        if (current.version >= 10001) throw new PublicationError('file_policy_capacity');
        const next = {
          version: current.version + 1,
          max_file_bytes: value.max_file_bytes,
          max_unfinished_uploads: value.max_unfinished_uploads,
          participant_reserved_bytes: value.participant_reserved_bytes,
          community_reserved_bytes: value.community_reserved_bytes,
        };
        await tx.query(
          `UPDATE loom.file_admission_policy SET version=$1,max_file_bytes=$2,
          max_unfinished_uploads=$3,participant_reserved_bytes=$4,community_reserved_bytes=$5 WHERE id=1`,
          [
            next.version,
            next.max_file_bytes,
            next.max_unfinished_uploads,
            next.participant_reserved_bytes,
            next.community_reserved_bytes,
          ],
        );
        const decision = { ...next, id: randomUUID(), request_digest: digest };
        await tx.query(
          `INSERT INTO loom.file_policy_decisions(id,actor_id,actor_credential_id,
          idempotency_key,request_digest,expected_version,version,max_file_bytes,max_unfinished_uploads,participant_reserved_bytes,community_reserved_bytes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            decision.id,
            authority.participantId,
            authority.credentialId,
            key,
            digest,
            current.version,
            next.version,
            next.max_file_bytes,
            next.max_unfinished_uploads,
            next.participant_reserved_bytes,
            next.community_reserved_bytes,
          ],
        );
        return receipt(decision, next, 'created');
      });
    } catch (error) {
      return safeError(error);
    }
  }
  async status(actor: ActorContext, value: unknown) {
    if (!Value.Check(C.FileStatusInput, value)) throw new PublicationError('invalid_input');
    try {
      return await this.database.transaction(async (tx) => {
        await lockAttempt(
          tx,
          identityOf(actor).participantId,
          'file.policy',
          value.idempotency_key.toLowerCase(),
        );
        const authority = await administrator(tx, actor);
        await fileGuard(tx);
        const saved = await savedDecision(
          tx,
          authority.participantId,
          value.idempotency_key.toLowerCase(),
        );
        if (!saved) return { operation_state: 'not_recorded' as const };
        return receipt(saved, await filePolicy(tx), 'replayed');
      });
    } catch (error) {
      return safeError(error);
    }
  }
  async audit(actor: ActorContext, value: unknown) {
    if (!Value.Check(C.FileAuditInput, value)) throw new PublicationError('invalid_input');
    try {
      return await this.database.transaction(async (tx) => {
        await administrator(tx, actor);
        const limit = value.limit ?? 12;
        const rows = (
          await tx.query<
            Decision & { actor_id: string; actor_credential_id: string; recorded_at: Date }
          >(
            `
          SELECT id,actor_id,actor_credential_id,recorded_at,version,max_file_bytes,max_unfinished_uploads,participant_reserved_bytes,community_reserved_bytes
          FROM loom.file_policy_decisions WHERE version < $1 ORDER BY version DESC LIMIT $2`,
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
