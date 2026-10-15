import type { SqlTransaction } from '../../db/postgres.js';
export interface PreparedCoverage {
  discussion_id:string; scope:'full'|'selected'; preparation_id:string|null; carried_from_revision_id:string|null;
  members:readonly {contribution_id:string;source_revision_id:string}[];
}
/** Fixed inserts only; all source/preparation/revision guards precede this tail. */
export async function insertCoverage(tx:SqlTransaction,summary:string,revision:string,coverage:PreparedCoverage) {
  await tx.query(`INSERT INTO loom.summary_coverage_sets(revision_id,summary_id,discussion_id,scope,preparation_id,carried_from_revision_id)
    VALUES ($1,$2,$3,$4,$5,$6)`,[revision,summary,coverage.discussion_id,coverage.scope,coverage.preparation_id,coverage.carried_from_revision_id]);
  if(coverage.members.length) await tx.query(`INSERT INTO loom.summary_coverage_members(revision_id,discussion_id,contribution_id,source_revision_id)
    SELECT $1,$2,m.contribution_id,m.source_revision_id FROM unnest($3::uuid[],$4::uuid[]) m(contribution_id,source_revision_id)`,
    [revision,coverage.discussion_id,coverage.members.map(m=>m.contribution_id),coverage.members.map(m=>m.source_revision_id)]);
}
