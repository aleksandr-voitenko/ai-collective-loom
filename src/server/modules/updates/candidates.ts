import { updatesLimits as L } from '../../../contracts/updates.js';
import type { SqlTransaction } from '../../db/postgres.js';
import { requireFollowTarget } from '../following/context.js';
import { sharedCandidatesSql, type SharedCandidate } from '../following/retrieval.js';
import type { PersonalCandidate, PersonalNotifications } from '../notifications/retrieval.js';
import { lockContext, requireRevision } from '../publication/guards.js';
import { lockReferencePlan } from '../participation/reference-context.js';
import { UpdatesError } from './errors.js';
import type { Bound } from './model.js';

export const personalSql = `SELECT d.id,d.signal_id,d.position::text,d.available_at,s.resource_id,s.revision_id,s.source_event_id,c.parent_id,
  COALESCE(c.discussion_id,CASE WHEN r.kind='summary' THEN r.owner_resource_id END) AS discussion_id
  FROM loom.personal_deliveries d JOIN loom.notification_signals s ON s.id=d.signal_id JOIN loom.resources r ON r.id=s.resource_id
  LEFT JOIN loom.contributions c ON c.id=s.resource_id`;

export async function authorizeEvent(tx: SqlTransaction, row: SharedCandidate) {
  await lockContext(tx, row.resource_id, 'resolution', [
    'area',
    'discussion',
    'contribution',
    'artifact',
    'summary',
  ]);
  if (row.revision_id) await requireRevision(tx, row.resource_id, row.revision_id);
}

export function includesPersonalReason(
  reason: Bound['reason'],
  claims: Awaited<ReturnType<PersonalNotifications['reasons']>>,
) {
  return (
    reason === 'all' ||
    claims.some((claim) =>
      reason === 'reply' ? claim.kind === 'direct_reply' : claim.kind !== 'direct_reply',
    )
  );
}

// Both operations start strictly after each independent lower position. A lookahead
// row signals more work; it is never authorized, matched or counted in this batch.
export async function scanCandidates(
  tx: SqlTransaction,
  bound: Bound,
  interval: Pick<Bound, 'shared_lower' | 'shared_upper' | 'personal_lower' | 'personal_upper'>,
  additionalSources: { id: string }[],
  operation: 'prepare' | 'observe',
) {
  const preparing = operation === 'prepare';
  const sharedRows =
    bound.definitions.length &&
    (preparing || (bound.selection !== 'direct' && interval.shared_lower !== interval.shared_upper))
      ? (
          await tx.query<SharedCandidate>(
            `${sharedCandidatesSql}
      WHERE e.position>$1 AND e.position<=$2 ORDER BY e.position LIMIT 101`,
            [interval.shared_lower, interval.shared_upper],
          )
        ).rows
      : [];
  const personalRows =
    preparing || interval.personal_lower !== interval.personal_upper
      ? (
          await tx.query<PersonalCandidate>(
            `${personalSql} WHERE d.recipient_id=$1 AND d.position>$2 AND d.position<=$3
      ORDER BY d.position LIMIT 101`,
            [bound.owner, interval.personal_lower, interval.personal_upper],
          )
        ).rows
      : [];
  const shared = sharedRows.slice(0, L.scan),
    personal = personalRows.slice(0, L.scan);
  const personalEvents = personal.length
    ? (
        await tx.query<SharedCandidate>(`${sharedCandidatesSql} WHERE e.id=ANY($1::uuid[])`, [
          personal.map((p) => p.source_event_id),
        ])
      ).rows
    : [];
  if (personalEvents.length !== personal.length)
    throw new UpdatesError('updates_personal_history_gap');
  // A tick without candidates needs no source plan. Explicit scope still
  // requires current authority, even when both committed clocks are unchanged.
  if (additionalSources.length || shared.length || personal.length)
    await lockReferencePlan(tx, [
      ...additionalSources.map((r) => r.id),
      ...bound.definitions.map((d) => d.target.resource_id),
      ...shared.flatMap((r) => [r.resource_id, ...(r.discussion_id ? [r.discussion_id] : [])]),
      ...personal.flatMap((r) =>
        [r.resource_id, r.parent_id, r.discussion_id].filter((v): v is string => !!v),
      ),
    ]);
  if (bound.scope === 'explicit') await requireFollowTarget(tx, bound.definitions[0]!.target);
  const sharedAfter = sharedRows.length > L.scan ? shared.at(-1)!.position : interval.shared_upper;
  const personalAfter =
    personalRows.length > L.scan ? personal.at(-1)!.position : interval.personal_upper;
  return {
    shared,
    personal,
    personalEvents,
    shared_after: sharedAfter,
    personal_after: personalAfter,
    complete: sharedAfter === interval.shared_upper && personalAfter === interval.personal_upper,
  };
}
