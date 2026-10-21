import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { ActorContext } from '../publication/actor.js';
import { identityOf } from '../publication/actor.js';
import { lockActor, lockContext } from '../publication/guards.js';
import { safeError, PublicationError } from '../publication/errors.js';
import type { Transactions, SqlTransaction } from '../../db/postgres.js';
import { lockAttempt } from '../../application/attempt.js';
import { PrepareInput,summaryLimits,type PrepareRequest,type PreparationView } from '../../../contracts/summaries.js';
import { digestRequest } from './publications.js';
import { lockReferencePlan } from './reference-context.js';
import { structureGuard } from './organization-context.js';
import { SummaryError,preparationGuard,preparation,expirePreparation,preparedMembers,currentSources,eligibleSource,authorizeMember,availableMember,type Member,type PreparationRow } from './summary-context.js';

export async function preparationView(tx:SqlTransaction,row:PreparationRow,members:Member[]):Promise<PreparationView> {
  let eligible=0,unknown=false;
  for(const member of members) {if(await availableMember(tx,row.discussion_id,member))eligible++;else unknown=true;}
  return {preparation_id:row.id,discussion_id:row.discussion_id,scope:row.scope,expires_at:row.expires_at.toISOString(),
    eligible_members:eligible,unknown,members_url:`/api/v1/summary-preparations/${row.id}/members`};
}
export class SummaryPreparation {
  constructor(private readonly database:Transactions){}
  private async cleanupOwner(tx:SqlTransaction,owner:string) {
    // Eight live preparations of 100 members; tombstone headers never disappear.
    await tx.query('UPDATE loom.summary_preparations SET expired=true WHERE participant_id=$1 AND expires_at<=clock_timestamp() AND NOT expired',[owner]);
    await tx.query(`DELETE FROM loom.summary_preparation_members WHERE (preparation_id,contribution_id) IN
      (SELECT m.preparation_id,m.contribution_id FROM loom.summary_preparation_members m JOIN loom.summary_preparations p ON p.id=m.preparation_id
      WHERE p.participant_id=$1 AND p.expired ORDER BY m.preparation_id,m.contribution_id LIMIT 800)`,[owner]);
  }
  cleanup(actor:ActorContext) {return this.database.transaction(async tx=>{const a=await lockActor(tx,actor);await preparationGuard(tx,true);await this.cleanupOwner(tx,a.participantId);return {cleaned:true as const};}).catch(safeError);}
  async prepare(actorContext:ActorContext,value:unknown) {
    if(!Value.Check(PrepareInput,value))throw new PublicationError('invalid_input');
    const input=structuredClone(value) as PrepareRequest;
    input.discussion_id=input.discussion_id.toLowerCase();input.idempotency_key=input.idempotency_key.toLowerCase();
    if(input.scope==='selected') {
      input.members=input.members.map(m=>({contribution_id:m.contribution_id.toLowerCase(),revision_id:m.revision_id.toLowerCase()})).sort((a,b)=>a.contribution_id.localeCompare(b.contribution_id));
      if(new Set(input.members.map(m=>m.contribution_id)).size!==input.members.length)throw new PublicationError('invalid_input');
    }
    const {idempotency_key,...semantic}=input,digest=digestRequest('summary.prepare',semantic,'summary-preparation-v1');
    try {const completed=await this.database.transaction(async tx=>{
      await tx.query("SET LOCAL statement_timeout='2500ms'",[]);
      await lockAttempt(tx,identityOf(actorContext).participantId,'summary.prepare',idempotency_key);
      const actor=await lockActor(tx,actorContext);await preparationGuard(tx,true);
      const saved=(await tx.query<{id:string;request_digest:string}>('SELECT id,request_digest FROM loom.summary_preparations WHERE participant_id=$1 AND idempotency_key=$2',[actor.participantId,idempotency_key])).rows[0];
      if(saved) {
        if(saved.request_digest!==digest)throw new PublicationError('idempotency_conflict');
        const row=await preparation(tx,actor.participantId,saved.id,true);
        if(!row.valid)return expirePreparation(tx,row.id);
        const members=await preparedMembers(tx,row.id);
        await lockReferencePlan(tx,[row.discussion_id,...members.map(m=>m.contribution_id)]);
        await lockContext(tx,row.discussion_id,'resolution',['discussion']);
        return preparationView(tx,row,members);
      }
      await this.cleanupOwner(tx,actor.participantId);
      const quota=(await tx.query<{owner:number;active:number;total:number}>(`SELECT
        (SELECT count(*)::int FROM (SELECT id FROM loom.summary_preparations WHERE participant_id=$1 LIMIT 129) p) AS owner,
        (SELECT count(*)::int FROM (SELECT id FROM loom.summary_preparations WHERE participant_id=$1 AND NOT expired AND expires_at>clock_timestamp() LIMIT 9) p) AS active,
        (SELECT count(*)::int FROM (SELECT id FROM loom.summary_preparations LIMIT 8193) p) AS total`,[actor.participantId])).rows[0]!;
      if(quota.owner>=summaryLimits.ownerPreparations||quota.active>=summaryLimits.activePreparations||quota.total>=summaryLimits.preparations)throw new SummaryError('summary_preparation_limit');
      await structureGuard(tx);
      const current=input.scope==='full'?await currentSources(tx,input.discussion_id):[];
      if(current.length>summaryLimits.sources)throw new SummaryError('summary_source_limit');
      const members:Member[]=input.scope==='full'?current.filter(eligibleSource).map(({contribution_id,source_revision_id})=>({contribution_id,source_revision_id}))
        :input.members.map(m=>({contribution_id:m.contribution_id,source_revision_id:m.revision_id}));
      await lockReferencePlan(tx,[input.discussion_id,...members.map(m=>m.contribution_id)]);
      const chain=await lockContext(tx,input.discussion_id,'resolution',['discussion']);
      if(chain.some(r=>!r.publication_open))throw new PublicationError('forbidden');
      for(const m of members)await authorizeMember(tx,input.discussion_id,m);
      const id=randomUUID();
      await tx.query('INSERT INTO loom.summary_preparations(id,participant_id,idempotency_key,request_digest,discussion_id,scope) VALUES ($1,$2,$3,$4,$5,$6)',
        [id,actor.participantId,idempotency_key,digest,input.discussion_id,input.scope]);
      if(members.length)await tx.query(`INSERT INTO loom.summary_preparation_members(preparation_id,discussion_id,contribution_id,source_revision_id)
        SELECT $1,$2,m.contribution_id,m.source_revision_id FROM unnest($3::uuid[],$4::uuid[]) m(contribution_id,source_revision_id)`,
        [id,input.discussion_id,members.map(m=>m.contribution_id),members.map(m=>m.source_revision_id)]);
      return preparationView(tx,await preparation(tx,actor.participantId,id),members);
    });if(completed instanceof SummaryError)throw completed;return completed;}catch(error){if(error instanceof SummaryError)throw error;return safeError(error);}
  }
}
