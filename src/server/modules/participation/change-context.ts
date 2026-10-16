import type { ChangeAccountValue, ExactChangeTargetValue } from '../../../contracts/participation.js';
import type { SqlTransaction } from '../../db/postgres.js';
import { PublicationError } from '../publication/errors.js';
import { referenceTarget } from './reference-context.js';

export type PreparedChangeAccount = { revisions: ExactChangeTargetValue[]; carried_from_revision_id: string | null };
export async function changeMembers(tx: SqlTransaction, revision: string): Promise<ExactChangeTargetValue[]> {
  return (await tx.query<ExactChangeTargetValue>(`SELECT target_kind AS kind,target_id AS resource_id,target_revision_id AS revision_id
    FROM loom.change_account_members WHERE revision_id=$1 ORDER BY target_id,target_revision_id LIMIT 17`, [revision])).rows;
}
export async function prepareChangeAccount(tx: SqlTransaction, source: string, base: string | null, declaration: ChangeAccountValue): Promise<PreparedChangeAccount> {
  const prior = base ? await changeMembers(tx, base) : [];
  if ('carry_forward_revision_id' in declaration) {
    if (declaration.carry_forward_revision_id !== base || !(await tx.query(
      'SELECT revision_id FROM loom.change_account_sets WHERE source_id=$1 AND revision_id=$2', [source,base])).rowCount)
      throw new PublicationError('invalid_input');
    return { revisions: prior, carried_from_revision_id: base };
  }
  for (const member of declaration.revisions) {
    if (!prior.some(old => old.kind === member.kind && old.resource_id === member.resource_id && old.revision_id === member.revision_id))
      await referenceTarget(tx, member);
  }
  return { revisions: declaration.revisions, carried_from_revision_id: null };
}
