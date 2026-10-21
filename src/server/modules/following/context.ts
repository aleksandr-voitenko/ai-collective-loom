import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import { lockActor, lockContext } from '../publication/guards.js';
import { safeError, PublicationError } from '../publication/errors.js';
import { RetrievalError } from '../participation/retrieval.js';
import type { FollowTargetView, FollowSourceView } from '../../../contracts/following.js';

const messages = {
  following_limit_reached:
    'The synthetic Following retention or active-definition limit was reached. Existing decisions remain recoverable.',
  following_collection_changed: 'Following changed between pages. Refresh the collection.',
  shared_token_invalid:
    'This shared retrieval token does not match the participant, purpose or scope.',
  shared_descriptor_expired: 'This shared traversal expired. Renew its retained fixed view.',
  shared_visibility_replay_required:
    'Visibility changed. Replay all retained shared history, including before completed checkpoints.',
  shared_history_gap:
    'Required shared history is unavailable. Establish an explicit new baseline and inspect retained content.',
  shared_epoch_changed:
    'The shared recovery epoch changed. Continuity requires deployment recovery.',
  shared_definition_changed:
    'Following settings changed. Open a new retained-history traversal to include newly selected history.',
  shared_view_changed: 'Source policy changed during retrieval. Retry the same page.',
  shared_work_limit:
    'The shared request exceeded a bounded work limit. Retry the same position or reduce the page size.',
};
export class FollowingError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
export const unavailable = (error: unknown) =>
  error instanceof PublicationError && error.code === 'unavailable';
export async function runFollowing<T>(
  database: Transactions,
  work: (tx: SqlTransaction) => Promise<T>,
  snapshot = false,
) {
  try {
    return await database.transaction(async (tx) => {
      if (snapshot) await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', []);
      await tx.query("SET LOCAL statement_timeout='2500ms'", []);
      await tx.query("SET LOCAL lock_timeout='1500ms'", []);
      await tx.query("SET LOCAL transaction_timeout='15000ms'", []);
      return work(tx);
    });
  } catch (error) {
    if (error instanceof FollowingError || error instanceof RetrievalError) throw error;
    if (['40001', '40P01', '55P03'].includes((error as { code?: string })?.code ?? ''))
      throw new FollowingError('shared_view_changed');
    if (['57014', '25P04'].includes((error as { code?: string })?.code ?? ''))
      throw new FollowingError('shared_work_limit');
    return safeError(error);
  }
}
export async function followingOwner(tx: SqlTransaction, owner: string, write = false) {
  await tx.query(
    `SELECT ${write ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(hashtextextended($1,0))`,
    [JSON.stringify(['loom.following.owner', owner])],
  );
}
export type Authority = Awaited<ReturnType<typeof lockActor>>;

/** A target can remain readable through history even when its current title is
 * suppressed. Never substitute that older title as current display metadata. */
export async function followSource(
  tx: SqlTransaction,
  target: FollowTargetView,
): Promise<FollowSourceView> {
  const chain = await lockContext(tx, target.resource_id, 'resolution', [target.kind]);
  const table =
    target.kind === 'area' ? 'areas' : target.kind === 'discussion' ? 'discussions' : 'artifacts';
  if (!(await tx.query(`SELECT id FROM loom.${table} WHERE id=$1`, [target.resource_id])).rowCount)
    throw new PublicationError('unavailable');
  let title: string | null = null;
  if (target.kind === 'area')
    title = (
      await tx.query<{ title: string }>('SELECT title FROM loom.areas WHERE id=$1', [
        target.resource_id,
      ])
    ).rows[0]!.title;
  else {
    const content =
      target.kind === 'discussion'
        ? (
            await tx.query<{ opening_id: string }>(
              'SELECT opening_id FROM loom.discussions WHERE id=$1',
              [target.resource_id],
            )
          ).rows[0]!.opening_id
        : target.resource_id;
    try {
      const source = (await lockContext(tx, content, 'resolution'))[0]!;
      const revision = (
        await tx.query<{ title: string | null; availability: string }>(
          'SELECT title,availability FROM loom.revisions WHERE id=$1 FOR SHARE',
          [source.current_revision_id],
        )
      ).rows[0];
      if (revision?.availability === 'available') title = revision.title;
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
  const areas = chain.filter((r) => r.kind === 'area').reverse();
  const names = (
    await tx.query<{ id: string; title: string }>(
      'SELECT id,title FROM loom.areas WHERE id=ANY($1::uuid[])',
      [areas.map((r) => r.id)],
    )
  ).rows;
  return {
    state: 'available',
    title,
    path: areas.map((r) => ({
      id: r.id,
      title: names.find((n) => n.id === r.id)?.title ?? 'Topic',
    })),
    browser_url:
      target.kind === 'area'
        ? `/loom/area/${target.resource_id}`
        : target.kind === 'discussion'
          ? `/loom/discussion/${target.resource_id}`
          : `/loom/resource/${target.resource_id}`,
  };
}
