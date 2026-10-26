import type { RateCategory } from '../../../contracts/rates.js';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import type { ActorContext } from '../publication/actor.js';
import { IdentityError } from '../identity/errors.js';
import { requireActor } from '../identity/policy.js';
import { PublicationError, safeError } from '../publication/errors.js';

export class ThrottledError extends PublicationError {
  constructor(
    readonly category: RateCategory,
    readonly retryAfter: number,
  ) {
    super('temporarily_throttled');
    this.message = `Temporary participation limit. Wait at least ${retryAfter} seconds, then explicitly retry the same request or check its status. Keep the exact command; this response does not settle an earlier attempt.`;
  }
}

export async function lockedPolicy(tx: SqlTransaction, exclusive = false) {
  const row = (
    await tx.query<{
      version: number;
      ordinary_requests: number;
      new_publications: number;
      recovery_control: number;
    }>(
      `SELECT version,ordinary_requests,new_publications,recovery_control
      FROM loom.participation_rate_policy WHERE id=1 FOR ${exclusive ? 'UPDATE' : 'SHARE'}`,
      [],
    )
  ).rows[0];
  if (!row) throw new PublicationError('service_unavailable');
  return { ...row, window_seconds: 60 as const };
}

/** Actor guards precede policy and participant/category accounting; domain guards follow.
 * The policy share lock orders a concurrent edit with the whole admitted transaction. */
type Allowance = { participant: string; category: RateCategory; started: string; used: number };
export async function reserveRate(
  tx: SqlTransaction,
  participant: string,
  category: RateCategory,
): Promise<Allowance> {
  const policy = await lockedPolicy(tx);
  await tx.query(
    `INSERT INTO loom.participation_rate_windows
    (participant_id,category,window_started_at,used) VALUES($1,$2,clock_timestamp(),0)
    ON CONFLICT DO NOTHING`,
    [participant, category],
  );
  await tx.query(
    `SELECT used FROM loom.participation_rate_windows
    WHERE participant_id=$1 AND category=$2 FOR UPDATE`,
    [participant, category],
  );
  // Sample database time after waiting for the row. An expired window is reusable;
  // policy edits change its ceiling without resetting its usage or original start.
  const row = (
    await tx.query<{ started: string; used: number; seconds: number }>(
      `
    WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS now)
    SELECT (CASE WHEN used=0 OR window_started_at + interval '60 seconds' <= instant.now
      THEN instant.now ELSE window_started_at END)::text AS started,
      CASE WHEN used=0 OR window_started_at + interval '60 seconds' <= instant.now THEN 0 ELSE used END AS used,
      greatest(1,least(60,ceil(extract(epoch FROM window_started_at + interval '60 seconds' - instant.now))))::integer AS seconds
    FROM loom.participation_rate_windows,instant WHERE participant_id=$1 AND category=$2`,
      [participant, category],
    )
  ).rows[0]!;
  if (row.used >= policy[category]) throw new ThrottledError(category, row.seconds);
  return { participant, category, started: row.started, used: row.used + 1 };
}

/** Only updates the already exclusively held accounting row. Call before the clock tail. */
export async function chargeRate(tx: SqlTransaction, allowance: Allowance | undefined) {
  if (!allowance) return;
  await tx.query(
    `UPDATE loom.participation_rate_windows SET window_started_at=$3,used=$4
    WHERE participant_id=$1 AND category=$2`,
    [allowance.participant, allowance.category, allowance.started, allowance.used],
  );
}

export async function admitRequest(
  database: Transactions,
  actor: ActorContext,
  category: 'ordinary_requests' | 'recovery_control',
) {
  try {
    await database.transaction(async (tx) => {
      const authority = await requireActor(tx, actor);
      if (!(await hasRateSchema(tx))) return;
      await chargeRate(tx, await reserveRate(tx, authority.participantId, category));
    });
  } catch (error) {
    // Preserve authentication failures; service failures never become an allowance.
    if (error instanceof IdentityError) throw error;
    return safeError(error);
  }
}

/** Migration 0027 activates accounting. Populated upgrades on historical schemas
 * retain their prior protocol; query errors and incomplete migrated schemas fail closed. */
async function hasRateSchema(tx: SqlTransaction) {
  return Boolean(
    (
      await tx.query<{ present: boolean }>(
        "SELECT to_regclass('loom.participation_rate_policy') IS NOT NULL AS present",
        [],
      )
    ).rows[0]?.present,
  );
}
export async function admitPublication(tx: SqlTransaction, participant: string) {
  if (!(await hasRateSchema(tx))) return;
  return reserveRate(tx, participant, 'new_publications');
}
