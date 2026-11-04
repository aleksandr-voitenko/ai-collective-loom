import { lockAttempt } from '../../application/attempt.js';
import type { SqlTransaction } from '../../db/postgres.js';
import type { Outcome } from '../publication/publication.js';

export async function publicationOutcome(
  tx: SqlTransaction,
  participant: string,
  kind: string,
  key: string,
) {
  await lockAttempt(tx, participant, kind, key);
  return (
    await tx.query<Outcome>(
      'SELECT id, resource_id, revision_id, semantic_version, request_digest FROM loom.idempotency_records WHERE participant_id=$1 AND operation_kind=$2 AND idempotency_key=$3',
      [participant, kind, key],
    )
  ).rows[0];
}
