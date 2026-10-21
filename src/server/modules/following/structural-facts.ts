import type { SqlTransaction } from '../../db/postgres.js';
import { OrganizationError } from '../participation/organization-context.js';

/** Called under exclusive structure ownership, before the common clock tail.
 * Older-schema upgrade fixtures deliberately retain the original insert shape. */
export async function structuralImpacts(
  tx: SqlTransaction,
  id: string,
  kind: string,
): Promise<string[] | undefined> {
  if (
    !(
      await tx.query<{ present: boolean }>(
        "SELECT to_regclass('loom.shared_retrieval_state') IS NOT NULL AS present",
        [],
      )
    ).rows[0]!.present
  )
    return;
  if (kind !== 'area') return [id];
  const areas = new Set([id]);
  let frontier = [id];
  for (let depth = 0; frontier.length; depth++) {
    if (depth >= 12) throw new OrganizationError('organization_limit');
    const children = (
      await tx.query<{ id: string }>(
        `SELECT a.id FROM loom.areas a JOIN loom.resources r ON r.id=a.id
      WHERE r.owner_resource_id=ANY($1::uuid[]) ORDER BY a.id LIMIT $2`,
        [frontier, 501 - areas.size],
      )
    ).rows;
    frontier = [];
    for (const child of children) {
      if (areas.has(child.id)) throw new OrganizationError('organization_cycle');
      areas.add(child.id);
      frontier.push(child.id);
    }
    if (areas.size > 500) throw new OrganizationError('organization_limit');
  }
  const contents = (
    await tx.query<{ id: string }>(
      `SELECT r.id FROM loom.resources r WHERE r.owner_resource_id=ANY($1::uuid[])
    AND (EXISTS(SELECT 1 FROM loom.discussions d WHERE d.id=r.id) OR EXISTS(SELECT 1 FROM loom.artifacts a WHERE a.id=r.id))
    ORDER BY r.id LIMIT 5001`,
      [[...areas]],
    )
  ).rows;
  if (contents.length > 5000) throw new OrganizationError('organization_limit');
  return [...areas, ...contents.map((r) => r.id)].sort();
}
