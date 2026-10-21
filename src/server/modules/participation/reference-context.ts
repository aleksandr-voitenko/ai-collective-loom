import type { ReferenceValue, ReferenceTargetValue } from '../../../contracts/participation.js';
import type { SqlTransaction } from '../../db/postgres.js';
import { hasChangeSchema } from '../../db/schema-capabilities.js';
import { PublicationError } from '../publication/errors.js';
import { lockContext, requireRevision, type Resource } from '../publication/guards.js';
import { structureGuard } from './organization-context.js';
import type { PreparedReference } from '../publication/reference-storage.js';

export interface ReferenceRow {
  source_field: 'main' | 'change_note';
  source_id: string; revision_id: string; reference_id: string;
  target_kind: ReferenceTargetValue['kind']; target_id: string; target_revision_id: string | null;
  relationship: ReferenceValue['relationship']; rationale: string | null;
  origin_revision_id: string; assertion_revision_id: string;
}
export function declaration(row: ReferenceRow): ReferenceValue {
  return { reference_id: row.reference_id, target: { kind: row.target_kind, resource_id: row.target_id,
    ...(row.target_revision_id ? { revision_id: row.target_revision_id } : {}) }, relationship: row.relationship, rationale: row.rationale };
}
export async function revisionReferences(tx: SqlTransaction, revision: string, field: ReferenceRow['source_field'] = 'main'): Promise<ReferenceRow[]> {
  const fields = await hasChangeSchema(tx);
  if (!fields && field !== 'main') return [];
  return (await tx.query<ReferenceRow>('SELECT * FROM loom.revision_references WHERE revision_id=$1' +
    (fields ? " AND source_field=$2" : '') + ' ORDER BY reference_id LIMIT 17', fields ? [revision,field] : [revision])).rows
    .map(row => ({...row, source_field: row.source_field ?? 'main'}));
}

/** Discover all dependencies before taking any resource guard. SHARE-to-UPDATE
 * upgrades across two cross-citing sources would otherwise deadlock (ADR-021). */
export async function lockReferencePlan(tx: SqlTransaction, anchors: string[], exclusive?: string) {
  await structureGuard(tx);
  const seeds = [...new Set(anchors)];
  if (seeds.length > 2200) throw new PublicationError('invalid_input');
  const openings = (await tx.query<{ opening_id: string }>(
    'SELECT opening_id FROM loom.discussions WHERE id=ANY($1::uuid[])', [seeds])).rows;
  const proposals = (await tx.query<{ area_id: string }>(`SELECT p.area_id FROM loom.discussion_area_references p
    WHERE p.discussion_id=ANY($1::uuid[]) OR p.discussion_id IN
      (SELECT discussion_id FROM loom.contributions WHERE id=ANY($1::uuid[])) OR p.discussion_id IN
      (SELECT owner_resource_id FROM loom.resources WHERE kind='summary' AND id=ANY($1::uuid[])) LIMIT 120`, [seeds])).rows;
  let frontier = [...new Set([...seeds, ...openings.map(row => row.opening_id), ...proposals.map(row => row.area_id)])];
  const found = new Map<string, Resource>();
  for (let depth = 0; frontier.length && depth < 32; depth++) {
    const rows = (await tx.query<Resource>(`SELECT id,kind,owner_resource_id,original_author_id,state,publication_open,current_revision_id
      FROM loom.resources WHERE id=ANY($1::uuid[])`, [frontier])).rows;
    for (const row of rows) found.set(row.id, row);
    frontier = [...new Set(rows.flatMap(row => row.owner_resource_id && !found.has(row.owner_resource_id) ? [row.owner_resource_id] : []))];
  }
  if (frontier.length || found.size > 3840) throw new PublicationError('service_unavailable');
  // The structure guard fixes parentage; current pointers/lifecycle are read again
  // under the actual guards. Missing/protected targets are validated uniformly later.
  for (const id of [...found.keys()].sort()) {
    await tx.query('SELECT id FROM loom.resources WHERE id=$1 ' + (id === exclusive ? 'FOR UPDATE' : 'FOR SHARE'), [id]);
  }
}

export async function referenceTarget(tx: SqlTransaction, target: ReferenceTargetValue) {
  if (target.kind === 'discussion' && target.revision_id) throw new PublicationError('invalid_input');
  const chain = await lockContext(tx, target.resource_id, 'resolution', [target.kind]);
  let source = chain[0]!;
  if (target.kind === 'discussion') {
    const opening = (await tx.query<{ opening_id: string }>('SELECT opening_id FROM loom.discussions WHERE id=$1', [source.id])).rows[0];
    if (!opening) throw new PublicationError('unavailable');
    source = (await lockContext(tx, opening.opening_id, 'resolution', ['contribution']))[0]!;
  } else {
    const table = target.kind === 'artifact' ? 'artifacts' : target.kind === 'summary' ? 'summaries' : 'contributions';
    if (!(await tx.query(`SELECT id FROM loom.${table} WHERE id=$1`, [source.id])).rowCount) throw new PublicationError('unavailable');
  }
  const selected = target.revision_id ?? source.current_revision_id;
  if (!selected) throw new PublicationError('unavailable');
  await requireRevision(tx, source.id, selected);
  const format = (await tx.query<{ content_format: string }>('SELECT content_format FROM loom.revisions WHERE id=$1', [selected])).rows[0]?.content_format;
  if (!['loom-markdown-v1', 'loom-markdown-v2', 'loom-markdown-v3'].includes(format ?? '')) throw new PublicationError('unavailable');
  return { source, revision: selected };
}

export async function prepareReferences(tx: SqlTransaction, source: string, base: string | null, references: ReferenceValue[], field: ReferenceRow['source_field'] = 'main'): Promise<PreparedReference[]> {
  const prior = field === 'main' && base ? await revisionReferences(tx, base) : [];
  const prepared: PreparedReference[] = [];
  for (const ref of references) {
    const previous = prior.find(row => row.reference_id === ref.reference_id);
    const same = previous && JSON.stringify(declaration(previous)) === JSON.stringify(ref);
    // Only identical immediate-base carry-forward may retain an unavailable target.
    if (!same) await referenceTarget(tx, ref.target);
    const fields = await hasChangeSchema(tx);
    const origin = field === 'change_note' ? undefined : previous ?? (await tx.query<ReferenceRow>(`SELECT rr.* FROM loom.revision_references rr
      JOIN loom.revisions v ON v.id=rr.revision_id WHERE rr.source_id=$1 AND rr.reference_id=$2
      ${fields ? "AND rr.source_field='main'" : ''} ORDER BY v.revision_number LIMIT 1`, [source, ref.reference_id])).rows[0];
    prepared.push({ ...ref, origin_revision_id: origin?.origin_revision_id ?? null,
      assertion_revision_id: same ? previous.assertion_revision_id : null });
  }
  return prepared;
}
