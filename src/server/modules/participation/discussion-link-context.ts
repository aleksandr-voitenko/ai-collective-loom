import type { DiscussionLink } from '../../../contracts/discussion-links.js';
import type { ReferenceTargetValue } from '../../../contracts/participation.js';
import type { SqlTransaction } from '../../db/postgres.js';
import type { Resource } from '../publication/guards.js';

export type PreparedDiscussionLink = {
  discussion_id: string;
  target: ReferenceTargetValue;
  destination: string;
};

/** Identities only, under the complete resource plan. Missing and suppressed
 * targets have identical publication outcomes; no target metadata is returned. */
export async function prepareDiscussionLinks(
  tx: SqlTransaction,
  source: Resource,
  links: readonly DiscussionLink[],
): Promise<PreparedDiscussionLink[]> {
  if (source.kind !== 'contribution' || !links.length) return [];
  // Historical upgrade fixtures intentionally exercise older publication schemas.
  const ready = (
    await tx.query<{ ready: boolean }>(
      "SELECT to_regclass('loom.revision_discussion_links') IS NOT NULL AS ready",
      [],
    )
  ).rows[0]?.ready;
  if (!ready) return [];
  const prepared: PreparedDiscussionLink[] = [];
  for (const link of links) {
    const targetId = link.focus_id ?? link.resource_id;
    if (
      targetId === source.id ||
      (link.kind === 'discussion' && !link.focus_id && targetId === source.owner_resource_id)
    )
      continue;
    const row = (
      await tx.query<{ kind: ReferenceTargetValue['kind']; discussion_id: string }>(
        `SELECT r.kind,CASE WHEN r.kind='discussion' THEN r.id ELSE r.owner_resource_id END AS discussion_id
       FROM loom.resources r WHERE r.id=$1 AND
       ${
         link.kind === 'discussion' && !link.focus_id
           ? "r.kind='discussion' AND EXISTS(SELECT 1 FROM loom.discussions d WHERE d.id=r.id)"
           : `((r.kind='contribution' AND EXISTS(SELECT 1 FROM loom.contributions c WHERE c.id=r.id))${link.kind === 'resource' ? " OR (r.kind='summary' AND EXISTS(SELECT 1 FROM loom.summaries s WHERE s.id=r.id))" : ''})`
       }`,
        [targetId],
      )
    ).rows[0];
    if (!row || (link.focus_id && row.discussion_id !== link.resource_id)) continue;
    if (
      link.revision_id &&
      !(
        await tx.query('SELECT id FROM loom.revisions WHERE id=$1 AND resource_id=$2 FOR SHARE', [
          link.revision_id,
          targetId,
        ])
      ).rowCount
    )
      continue;
    let path: string | undefined;
    if (link.file_id) {
      path = (
        await tx.query<{ path: string }>(
          'SELECT path FROM loom.file_contexts WHERE id=$1 AND contribution_id=$2 AND revision_id=$3',
          [link.file_id, targetId, link.revision_id],
        )
      ).rows[0]?.path;
      if (path === undefined) continue;
    }
    prepared.push({
      discussion_id: row.discussion_id,
      target: {
        kind: row.kind,
        resource_id: targetId,
        ...(link.revision_id ? { revision_id: link.revision_id } : {}),
        ...(link.file_id ? { file_id: link.file_id, path: path! } : {}),
      },
      destination: link.destination,
    });
  }
  return prepared;
}
