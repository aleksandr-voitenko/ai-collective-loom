import type { SqlTransaction } from '../db/postgres.js';

/** Serialize even an absent outcome. Scope and kind must come from trusted code. */
export async function lockAttempt(
  tx: SqlTransaction,
  participantId: string,
  kind: string,
  key: string,
) {
  await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED', []);
  await tx.query("SELECT set_config('lock_timeout', $1, true)", ['1500ms']);
  // Keep the existing publication namespace; collisions only add contention.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    JSON.stringify(['loom.publication.attempt', participantId, kind, key]),
  ]);
}
