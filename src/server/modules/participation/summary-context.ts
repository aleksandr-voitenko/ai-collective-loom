import type { SqlTransaction } from '../../db/postgres.js';
import { PublicationError } from '../publication/errors.js';
import { lockContext, requireRevision } from '../publication/guards.js';
import { summaryLimits } from '../../../contracts/summaries.js';
import type { PreparedCoverage } from '../publication/summary-storage.js';

export class SummaryError extends Error {
  constructor(readonly code:'summary_already_exists'|'summary_preparation_expired'|'summary_preparation_limit'|'summary_source_limit'|'summary_changed'|'summary_coverage_required', readonly definitive=false) {
    super({summary_already_exists:'This discussion already has a summary. Open its current summary and editors.',
      summary_preparation_expired:'This source preparation expired. Preserve the draft, reconcile publication, then explicitly prepare a new declaration.',
      summary_preparation_limit:'The synthetic source-preparation limit was reached. Clean up expired preparations or review retained capacity.',
      summary_source_limit:'This source set exceeds the synthetic work limit. Choose an explicit selection of at most 100 source revisions.',
      summary_changed:'This source or maintenance view changed or expired. Refresh the view while retaining your draft.',
      summary_coverage_required:'Use the summary revision operation with an explicit source declaration.'}[code]);
  }
}
export type Member={contribution_id:string;source_revision_id:string};
export type PreparationRow={id:string;participant_id:string;discussion_id:string;scope:'full'|'selected';request_digest:string;expires_at:Date;valid:boolean};
export async function preparationGuard(tx:SqlTransaction,exclusive=false) {
  await tx.query('SELECT pg_advisory_xact_lock'+(exclusive?'':'_shared')+'($1::integer,$2::integer)',[0x4c4f4f4d,5]);
}
export async function preparation(tx:SqlTransaction,owner:string,id:string,allowExpired=false) {
  const row=(await tx.query<PreparationRow>(`SELECT *,NOT expired AND expires_at>clock_timestamp() AS valid FROM loom.summary_preparations
    WHERE id=$1 AND participant_id=$2`,[id,owner])).rows[0];
  if(!row)throw new PublicationError('unavailable');
  if(!row.valid&&!allowExpired)throw new SummaryError('summary_preparation_expired');
  return row;
}
/** Return this refusal from the transaction, then throw after COMMIT. The
 * attempt mutex and irreversible tombstone make an uncertain exact retry safe
 * to correct; a lost COMMIT acknowledgement remains unknown. */
export async function expirePreparation(tx:SqlTransaction,id:string) {
  await tx.query('UPDATE loom.summary_preparations SET expired=true WHERE id=$1',[id]);
  return new SummaryError('summary_preparation_expired',true);
}
export async function preparedMembers(tx:SqlTransaction,id:string):Promise<Member[]> {
  const rows=(await tx.query<Member>('SELECT contribution_id,source_revision_id FROM loom.summary_preparation_members WHERE preparation_id=$1 ORDER BY contribution_id LIMIT 101',[id])).rows;
  if(rows.length>summaryLimits.sources)throw new SummaryError('summary_source_limit');
  return rows;
}
export async function coverageSet(tx:SqlTransaction,revision:string) {
  const set=(await tx.query<PreparedCoverage & {summary_id:string}>(`SELECT summary_id,discussion_id,scope,preparation_id,carried_from_revision_id
    FROM loom.summary_coverage_sets WHERE revision_id=$1`,[revision])).rows[0];
  if(!set)throw new PublicationError('unavailable');
  const members=(await tx.query<Member>('SELECT contribution_id,source_revision_id FROM loom.summary_coverage_members WHERE revision_id=$1 ORDER BY contribution_id LIMIT 101',[revision])).rows;
  if(members.length>summaryLimits.sources)throw new SummaryError('summary_source_limit');
  return {...set,members};
}
export type SourceRow=Member & {state:string;availability:string|null;content_format:string|null};
/** One SQL statement fixes the current-pointer set; later guards validate these
 * exact revisions, never silently advance them to newer pointers. */
export async function currentSources(tx:SqlTransaction,discussion:string):Promise<SourceRow[]> {
  return (await tx.query<SourceRow>(`SELECT c.id AS contribution_id,r.current_revision_id AS source_revision_id,r.state,v.availability,v.content_format
    FROM loom.contributions c JOIN loom.resources r ON r.id=c.id
    LEFT JOIN loom.revisions v ON v.id=r.current_revision_id AND v.resource_id=r.id
    WHERE c.discussion_id=$1 ORDER BY c.id LIMIT 101`,[discussion])).rows;
}
export function eligibleSource(row:SourceRow) {
  return row.state==='active'&&row.availability==='available'&&['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3'].includes(row.content_format??'');
}
export async function authorizeMember(tx:SqlTransaction,discussion:string,member:Member) {
  await lockContext(tx,member.contribution_id,'resolution',['contribution']);
  if(!(await tx.query('SELECT id FROM loom.contributions WHERE id=$1 AND discussion_id=$2',[member.contribution_id,discussion])).rowCount)throw new PublicationError('unavailable');
  await requireRevision(tx,member.contribution_id,member.source_revision_id);
  const row=(await tx.query<{content_format:string}>('SELECT content_format FROM loom.revisions WHERE id=$1',[member.source_revision_id])).rows[0];
  if(!['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3'].includes(row?.content_format??''))throw new PublicationError('unavailable');
}
export async function availableMember(tx:SqlTransaction,discussion:string,member:Member) {
  try {await authorizeMember(tx,discussion,member);return true;}
  catch(error){if(error instanceof PublicationError&&error.code==='unavailable')return false;throw error;}
}
export async function summaryBoundary(tx:SqlTransaction) {
  return (await tx.query<{value:string}>(`SELECT json_build_array(c.shared_position,s.visibility_version,o.version,m.version)::text AS value
    FROM loom.community_clocks c CROSS JOIN loom.search_state s CROSS JOIN loom.organization_state o CROSS JOIN loom.summary_state m
    WHERE c.id=1 AND s.id=1 AND o.id=1 AND m.id=1`,[])).rows[0]!.value;
}
