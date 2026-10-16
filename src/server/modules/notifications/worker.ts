import { randomUUID } from 'node:crypto';
import type { SqlTransaction } from '../../db/postgres.js';
import type { Transactions } from '../publication/publication.js';
import { lockReferencePlan, revisionReferences, declaration } from '../participation/reference-context.js';
import { parseAuthored, validateChangeFields } from '../../../contracts/authored.js';
import type { AuthoredContent, NoteContent } from '../../../contracts/participation.js';

export const notificationLimits = Object.freeze({ jobs:50000, sources:5000, discovery:50, batch:25, leaseSeconds:30, attempts:3 });
export const notificationSources = `SELECT r.id,r.current_revision_id FROM loom.resources r
  JOIN loom.participants author ON author.id=r.original_author_id
  WHERE author.kind IN ('human','agent') AND
  ((r.kind='contribution' AND EXISTS(SELECT 1 FROM loom.contributions c WHERE c.id=r.id)) OR
   (r.kind='artifact' AND EXISTS(SELECT 1 FROM loom.artifacts a WHERE a.id=r.id)) OR
   (r.kind='summary' AND EXISTS(SELECT 1 FROM loom.summaries s WHERE s.id=r.id)))`;
export interface NotificationClaim {
  id:string; resource_id:string|null; revision_id:string|null; revision_number:string|null;
  kind:string; owner:string; claim_generation:number;
}
type Failure = 'unsupported_event'|'unsupported_source'|'malformed_source'|'source_limit'|'missing_predecessor'|
  'predecessor_pending'|'processing_failed'|'delivery_limit';
type Reason = {recipient:string;kind:'main_mention'|'direct_reply'|'note_mention';field:'main'|'reply'|'change_note';notify:boolean};
class LostNotificationLease extends Error {}
class NotificationCapacityReached extends Error {}
export type PreparedNotification = {kind:'failure';failure:Failure}|{kind:'not_applicable'}|{
  kind:'publication';resource:string;revision:string;ordinal:string;event:string;reasons:Reason[];gap:boolean;
};
export async function notificationDiscoveryGuard(tx:SqlTransaction) {
  await tx.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)',[0x4c4f4f4d,6]);
}
async function deadlines(tx:SqlTransaction) {
  await tx.query("SET LOCAL statement_timeout='2500ms'",[]);
  await tx.query("SET LOCAL lock_timeout='1500ms'",[]);
  await tx.query("SET LOCAL transaction_timeout='15000ms'",[]);
}

/** Historical, ordered projection. Search's latest-revision-wins rule is not used. */
export class NotificationWorker {
  readonly owner=randomUUID();
  constructor(private readonly database:Transactions) {}

  discover() {
    return this.database.transaction(async tx=>{
      await deadlines(tx);await notificationDiscoveryGuard(tx);
      const state=(await tx.query<{source_after:string|null;revision_after:string;scan_complete:boolean;event_after:string;event_after_intent:string|null}>(
        'SELECT source_after,revision_after::text,scan_complete,event_after::text,event_after_intent FROM loom.notification_state WHERE id=1',[])).rows[0]!;
      const jobs=(await tx.query<{n:number}>('SELECT count(*)::int AS n FROM (SELECT id FROM loom.notification_jobs LIMIT $1) j',[notificationLimits.jobs])).rows[0]!.n;
      const sources=(await tx.query<{n:number}>(`SELECT count(*)::int AS n FROM (${notificationSources} LIMIT $1) s`,[notificationLimits.sources+1])).rows[0]!.n;
      if(jobs+2*notificationLimits.discovery>notificationLimits.jobs || sources>notificationLimits.sources){
        await tx.query('UPDATE loom.notification_state SET capacity_limited=true,heartbeat_at=clock_timestamp() WHERE id=1',[]);
        return {enqueued:0,limited:true};
      }
      let enqueued=0;
      if(!state.scan_complete){
        const rows=(await tx.query<{resource_id:string;id:string;revision_number:string}>(`SELECT v.resource_id,v.id,v.revision_number::text
          FROM loom.revisions v JOIN (${notificationSources}) s ON s.id=v.resource_id
          WHERE $1::uuid IS NULL OR (v.resource_id,v.revision_number)>($1::uuid,$2::bigint)
          ORDER BY v.resource_id,v.revision_number LIMIT $3`,[state.source_after,state.revision_after,notificationLimits.discovery])).rows;
        for(const row of rows) enqueued+=(await tx.query(`INSERT INTO loom.notification_jobs(resource_id,revision_id,revision_number,kind)
          VALUES($1,$2,$3,'revision') ON CONFLICT DO NOTHING`,[row.resource_id,row.id,row.revision_number])).rowCount??0;
        state.source_after=rows.at(-1)?.resource_id??state.source_after;
        state.revision_after=rows.at(-1)?.revision_number??state.revision_after;
        state.scan_complete=rows.length<notificationLimits.discovery;
      }
      const events=(await tx.query<{id:string;position:string;kind:string;intent:string;intent_id:string;resource_id:string;revision_id:string|null;revision_number:string|null;internal:boolean}>(`
        SELECT e.id,e.position::text,e.kind,i.id AS intent_id,i.kind AS intent,e.resource_id,e.revision_id,v.revision_number::text,
          COALESCE(v.content_format='text/plain' OR p.kind='internal',false) AS internal
        FROM loom.shared_activity e JOIN loom.outbox_intents i ON i.source_event_id=e.id
        LEFT JOIN loom.revisions v ON v.id=e.revision_id LEFT JOIN loom.participants p ON p.id=e.publisher_id
        WHERE e.position>$1 OR (e.position=$1 AND ($2::uuid IS NULL OR i.id>$2))
        ORDER BY e.position,i.id LIMIT $3`,[state.event_after,state.event_after_intent,notificationLimits.discovery])).rows;
      for(const event of events){
        const kind=event.kind==='revision.published' && event.intent==='publication.project' && event.revision_id
          ? event.internal?'internal':'revision'
          : event.kind==='organization.changed' && event.intent==='organization.project' && !event.revision_id?'organization':'unsupported';
        enqueued+=(await tx.query(`INSERT INTO loom.notification_jobs(resource_id,revision_id,revision_number,source_event_id,source_intent_id,kind)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[event.resource_id,event.revision_id,event.revision_number,event.id,event.intent_id,kind])).rowCount??0;
      }
      await tx.query(`UPDATE loom.notification_state SET source_after=$1,revision_after=$2,scan_complete=$3,event_after=$4,
        event_after_intent=$5,heartbeat_at=clock_timestamp(),capacity_limited=false WHERE id=1`,[state.source_after,state.revision_after,state.scan_complete,
        events.at(-1)?.position??state.event_after,events.at(-1)?.intent_id??state.event_after_intent]);
      return {enqueued,limited:false};
    });
  }

  claim(limit:number=notificationLimits.batch):Promise<NotificationClaim[]> {
    if(!Number.isInteger(limit)||limit<1||limit>notificationLimits.batch)throw new Error('Invalid notification batch.');
    return this.database.transaction(async tx=>{
      await deadlines(tx);
      await tx.query(`WITH exhausted AS (SELECT id FROM loom.notification_jobs WHERE state='running'
        AND lease_until<=clock_timestamp() AND attempts>=3 ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        UPDATE loom.notification_jobs j SET state='failed',owner=NULL,lease_until=NULL,failure='lease_expired'
        FROM exhausted x WHERE j.id=x.id`,[limit]);
      return (await tx.query<NotificationClaim>(`WITH due AS (SELECT j.id FROM loom.notification_jobs j
        LEFT JOIN loom.notification_projection_heads h ON h.resource_id=j.resource_id
        WHERE j.attempts<3 AND ((j.state='pending' AND j.due_at<=clock_timestamp()) OR (j.state='running' AND j.lease_until<=clock_timestamp()))
        AND (j.kind<>'revision' OR j.revision_number<=COALESCE(h.revision_number,0)+1 OR
          NOT EXISTS(SELECT 1 FROM loom.revisions v WHERE v.resource_id=j.resource_id AND v.revision_number=COALESCE(h.revision_number,0)+1))
        ORDER BY j.revision_number NULLS FIRST,j.due_at,j.id LIMIT $1 FOR UPDATE OF j SKIP LOCKED)
        UPDATE loom.notification_jobs j SET state='running',claim_generation=claim_generation+1,owner=$2,
          lease_until=clock_timestamp()+make_interval(secs=>$3),attempts=attempts+1,failure=NULL
        FROM due WHERE j.id=due.id RETURNING j.id,j.resource_id,j.revision_id,j.revision_number::text,j.kind,j.owner,j.claim_generation`,
      [limit,this.owner,notificationLimits.leaseSeconds])).rows;
    });
  }
  renew(claim:NotificationClaim) {
    return this.database.transaction(async tx=>{
      await deadlines(tx);
      await tx.query('SELECT id FROM loom.notification_jobs WHERE id=$1 FOR UPDATE',[claim.id]);
      return (await tx.query(`UPDATE loom.notification_jobs SET lease_until=clock_timestamp()+make_interval(secs=>$4)
        WHERE id=$1 AND owner=$2 AND claim_generation=$3 AND state='running' AND lease_until>clock_timestamp()`,
      [claim.id,claim.owner,claim.claim_generation,notificationLimits.leaseSeconds])).rowCount===1;
    });
  }

  async prepare(claim:NotificationClaim):Promise<PreparedNotification> {
    if(['organization','internal'].includes(claim.kind))return {kind:'not_applicable'};
    if(claim.kind!=='revision'||!claim.revision_id||!claim.resource_id)return {kind:'failure',failure:'unsupported_event'};
    const resource=claim.resource_id,revision=claim.revision_id;
    return this.database.transaction(async tx=>{
      await deadlines(tx);
      const row=(await tx.query<{content_format:string;content_text:string;revision_number:string;publisher_id:string;event:string|null;typed:boolean;parent_author:string|null;eligible:boolean|null}>(`
        SELECT v.content_format,v.content_text,v.revision_number::text,v.publisher_id,
          (SELECT id FROM loom.shared_activity WHERE revision_id=v.id AND kind='revision.published' LIMIT 1) AS event,
          EXISTS(SELECT 1 FROM (${notificationSources}) s WHERE s.id=v.resource_id) AS typed,
          parent.original_author_id AS parent_author,f.eligible
        FROM loom.revisions v LEFT JOIN loom.contributions c ON c.id=v.resource_id
          LEFT JOIN loom.resources parent ON parent.id=c.parent_id LEFT JOIN loom.notification_reply_facts f ON f.reply_id=c.id
        WHERE v.id=$1 AND v.resource_id=$2`,[claim.revision_id,claim.resource_id])).rows[0];
      if(!row?.typed||!row.event||!['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3'].includes(row.content_format))return {kind:'failure',failure:'unsupported_source'};
      const entities=(await tx.query<{token:string;participant_id:string;source_field:'main'|'change_note'}>(
        'SELECT token,participant_id,source_field FROM loom.revision_mentions WHERE revision_id=$1 ORDER BY source_field,token LIMIT 17',[claim.revision_id])).rows;
      if(entities.length>16||Buffer.byteLength(row.content_text)>16384)return {kind:'failure',failure:'source_limit'};
      const fields=(field:'main'|'change_note')=>entities.filter(m=>m.source_field===field).map(({token,participant_id})=>({token,participant_id}));
      const references=await revisionReferences(tx,revision);
      const content={format:row.content_format,text:row.content_text,mentions:fields('main'),
        ...(row.content_format!=='loom-markdown-v1'?{references:references.map(declaration)}:{})} as AuthoredContent;
      const noteRow=(await tx.query<{content_text:string}>('SELECT content_text FROM loom.revision_change_notes WHERE revision_id=$1',[claim.revision_id])).rows[0];
      const note:NoteContent|null=noteRow?{format:'loom-markdown-v2',text:noteRow.content_text,mentions:fields('change_note'),
        references:(await revisionReferences(tx,revision,'change_note')).map(declaration)}:null;
      try {
        parseAuthored(content);
        if(content.format==='loom-markdown-v3')validateChangeFields(content,{change_note:note,change_account:null});
        else if(note || fields('change_note').length)throw new Error('Invalid field owner');
      } catch {return {kind:'failure',failure:'malformed_source'};}
      const reasons:Reason[]=[];
      for(const m of entities) if(!reasons.some(r=>r.recipient===m.participant_id&&r.field===m.source_field))
        reasons.push({recipient:m.participant_id,kind:m.source_field==='main'?'main_mention':'note_mention',field:m.source_field,notify:m.participant_id!==row.publisher_id});
      let gap=false;
      if(row.revision_number==='1' && row.parent_author && row.parent_author!==row.publisher_id){
        const eligible=row.eligible??(entities.some(m=>m.participant_id===row.parent_author)?true:null);
        if(eligible===null)gap=true;
        if(eligible)reasons.push({recipient:row.parent_author,kind:'direct_reply',field:'reply',notify:true});
      }
      return {kind:'publication',resource,revision,ordinal:row.revision_number,event:row.event,reasons,gap};
    });
  }

  finalize(claim:NotificationClaim,prepared:PreparedNotification) {
    if(prepared.kind==='failure')return this.fail(claim,prepared.failure);
    return this.database.transaction(async tx=>{
      await deadlines(tx);
      let head='0';
      const recipients=prepared.kind==='publication'?[...new Set(prepared.reasons.map(r=>r.recipient))].sort():[];
      if(prepared.kind==='publication'){
        for(const id of recipients)await tx.query('SELECT id FROM loom.participants WHERE id=$1 FOR SHARE',[id]);
        await lockReferencePlan(tx,[prepared.resource],prepared.resource);
        await tx.query('SELECT id FROM loom.revisions WHERE id=$1 FOR SHARE',[prepared.revision]);
        await tx.query('INSERT INTO loom.notification_projection_heads(resource_id) VALUES($1) ON CONFLICT DO NOTHING',[prepared.resource]);
        head=(await tx.query<{revision_number:string}>('SELECT revision_number::text FROM loom.notification_projection_heads WHERE resource_id=$1 FOR UPDATE',[prepared.resource])).rows[0]!.revision_number;
      }
      await tx.query('SELECT id FROM loom.notification_jobs WHERE id=$1 FOR UPDATE',[claim.id]);
      // The sorted recipient clocks are the final contested locks. Source guards
      // serialize absent claim/signal keys; all FK targets are already guarded.
      for(const id of recipients){
        await tx.query('INSERT INTO loom.participant_delivery_clocks(participant_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
        await tx.query('SELECT participant_id FROM loom.participant_delivery_clocks WHERE participant_id=$1 FOR UPDATE',[id]);
      }
      if(!(await tx.query(`SELECT id FROM loom.notification_jobs WHERE id=$1 AND owner=$2 AND claim_generation=$3
        AND state='running' AND lease_until>clock_timestamp()`,[claim.id,claim.owner,claim.claim_generation])).rowCount)throw new LostNotificationLease();
      let outcome='not_applicable';
      if(prepared.kind==='publication'){
        if(BigInt(prepared.ordinal)>BigInt(head)+1n){
          const predecessor=(await tx.query('SELECT id FROM loom.revisions WHERE resource_id=$1 AND revision_number=$2',[prepared.resource,String(BigInt(head)+1n)])).rowCount;
          await tx.query(`UPDATE loom.notification_jobs SET state=$2,owner=NULL,lease_until=NULL,failure=$3,
            attempts=CASE WHEN $2='pending' THEN attempts-1 ELSE attempts END,due_at=clock_timestamp()+interval '1 second' WHERE id=$1`,
          [claim.id,predecessor?'pending':'failed',predecessor?'predecessor_pending':'missing_predecessor']);
          return false;
        }
        outcome='already_projected';
        if(BigInt(prepared.ordinal)===BigInt(head)+1n){
          for(const recipient of recipients){
            const fresh:Reason[]=[];
            for(const reason of prepared.reasons.filter(r=>r.recipient===recipient)) {
              const known=(await tx.query(`SELECT signal_id FROM loom.notification_claims
                WHERE recipient_id=$1 AND resource_id=$2 AND kind=$3 AND note_revision_id IS NOT DISTINCT FROM $4::uuid`,
              [recipient,prepared.resource,reason.kind,reason.kind==='note_mention'?prepared.revision:null])).rowCount;
              if(!known)fresh.push(reason);
            }
            if(!fresh.length)continue;
            // A skipped self mention still consumes its logical main claim, so
            // an unrelated later editor cannot turn it into a fresh alert.
            const signal=fresh.some(r=>r.notify)?randomUUID():null;
            if(signal)await tx.query(`INSERT INTO loom.notification_signals(id,recipient_id,resource_id,revision_id,source_event_id,job_id)
              VALUES($1,$2,$3,$4,$5,$6)`,[signal,recipient,prepared.resource,prepared.revision,prepared.event,claim.id]);
            for(const reason of fresh)await tx.query(`INSERT INTO loom.notification_claims(recipient_id,resource_id,kind,note_revision_id,signal_id,source_field)
              VALUES($1,$2,$3,$4,$5,$6)`,[recipient,prepared.resource,reason.kind,reason.kind==='note_mention'?prepared.revision:null,reason.notify?signal:null,reason.field]);
            if(!signal)continue;
            const position=(await tx.query<{position:string}>(`UPDATE loom.participant_delivery_clocks SET position=position+1
              WHERE participant_id=$1 AND position<50000 RETURNING position::text`,[recipient])).rows[0]?.position;
            if(!position)throw new NotificationCapacityReached();
            await tx.query('INSERT INTO loom.personal_deliveries(id,recipient_id,position,signal_id) VALUES($1,$2,$3,$4)',[randomUUID(),recipient,position,signal]);
          }
          if(prepared.gap)await tx.query(`INSERT INTO loom.notification_gaps(revision_id,job_id,reason)
            VALUES($1,$2,'historical_reply_eligibility_unknown') ON CONFLICT DO NOTHING`,[prepared.revision,claim.id]);
          await tx.query(`UPDATE loom.notification_projection_heads SET revision_number=$2,revision_id=$3,incomplete=incomplete OR $4 WHERE resource_id=$1`,
          [prepared.resource,prepared.ordinal,prepared.revision,prepared.gap]);
          outcome=prepared.gap?'projected_with_gap':'projected';
        }
      }
      await tx.query(`UPDATE loom.notification_jobs SET state='succeeded',outcome=$2,owner=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE id=$1`,[claim.id,outcome]);
      return true;
    }).catch(error=>{if(error instanceof LostNotificationLease)return false;throw error;});
  }
  fail(claim:NotificationClaim,failure:Failure='processing_failed') {
    return this.database.transaction(async tx=>{
      await deadlines(tx);await tx.query('SELECT id FROM loom.notification_jobs WHERE id=$1 FOR UPDATE',[claim.id]);
      return (await tx.query(`UPDATE loom.notification_jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,
        owner=NULL,lease_until=NULL,failure=$4,due_at=clock_timestamp()+make_interval(secs=>power(2,attempts-1)::int)
        WHERE id=$1 AND owner=$2 AND claim_generation=$3 AND state='running' AND lease_until>clock_timestamp()`,
      [claim.id,claim.owner,claim.claim_generation,failure])).rowCount===1;
    });
  }
  async process(claim:NotificationClaim) {
    // Losing renewal is safe: finalization independently rechecks the live fence.
    const renewal=setInterval(()=>{void this.renew(claim).catch(()=>{});},10000);
    try{return await this.finalize(claim,await this.prepare(claim));}
    catch(error){await this.fail(claim,error instanceof NotificationCapacityReached?'delivery_limit':'processing_failed');return false;}
    finally{clearInterval(renewal);}
  }
  async tick(){await this.discover();const claims=await this.claim();await Promise.all(claims.map(c=>this.process(c)));return claims.length;}
}
