import type { ReferenceValue } from '../../../contracts/participation.js';
import type { SqlTransaction } from '../../db/postgres.js';
import { hasChangeSchema } from '../../db/schema-capabilities.js';

export type PreparedReference = ReferenceValue & { origin_revision_id: string | null; assertion_revision_id: string | null };

/** Fixed membership writes belong to the common revision transaction. Validation
 * and every contested source/target guard must already be complete. */
export async function insertReferences(tx: SqlTransaction, source: string, revision: string, references: readonly PreparedReference[], base: string | null, field: 'main' | 'change_note' = 'main') {
  for (const ref of references) await tx.query(`INSERT INTO loom.revision_references
    (source_id,revision_id,reference_id,target_kind,target_id,target_revision_id,relationship,rationale,origin_revision_id,assertion_revision_id${field === 'change_note' ? ',source_field' : ''})
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10${field === 'change_note' ? ",'change_note'" : ''})`, [source, revision, ref.reference_id, ref.target.kind, ref.target.resource_id,
    ref.target.revision_id ?? null, ref.relationship, ref.rationale, ref.origin_revision_id ?? revision, ref.assertion_revision_id ?? revision]);
  const fields = base ? await hasChangeSchema(tx) : false;
  if (base) await tx.query(`INSERT INTO loom.reference_withdrawals(source_id,revision_id,revision_number,reference_id,prior_revision_id)
    SELECT prior.source_id,v.id,v.revision_number,prior.reference_id,prior.revision_id
    FROM loom.revision_references prior JOIN loom.revisions v ON v.id=$2 AND v.resource_id=prior.source_id
    WHERE prior.source_id=$1 AND prior.revision_id=$3 ${fields ? "AND prior.source_field='main'" : ''} AND NOT (prior.reference_id=ANY($4::uuid[]))`,
    [source,revision,base,references.map(ref=>ref.reference_id)]);
}
