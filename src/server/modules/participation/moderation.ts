import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import * as C from '../../../contracts/moderation.js';
import { UUID } from '../../../contracts/participation.js';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import { lockAttempt } from '../../application/attempt.js';
import { identityOf, type ActorContext } from '../publication/actor.js';
import { PublicationError, safeError } from '../publication/errors.js';
import { lockActor, type Resource } from '../publication/guards.js';
import { lockReferencePlan } from './reference-context.js';
import { structureGuard } from './organization-context.js';
import { fit, RetrievalError } from './retrieval.js';

export class ModerationError extends Error {
  constructor(readonly code:'moderation_conflict'|'moderation_limit'|'moderation_target_unsupported') {
    super({moderation_conflict:'The lifecycle version changed. Refresh and review before making another choice.',
      moderation_limit:'The synthetic moderation limit is reached. Exact recovery remains available.',
      moderation_target_unsupported:'Moderation supports whole discussions, non-opening comments, summaries and artifacts only.'}[code]);
  }
}
type Decision={id:string;request_digest:string;resource_id:string;target_kind:C.ModerationTargetView['kind'];suppressed:boolean;result_version:number;actor_id:string;recorded_at:Date};
type Options={limit?:string;cursor?:string};
type ControlRow=Resource&{lifecycle_version:number};
const columns='id,kind,owner_resource_id,original_author_id,state,publication_open,current_revision_id,lifecycle_version';

export class SharedModeration {
  private readonly cursorKey=randomBytes(32);
  constructor(private readonly database:Transactions) {}
  private async run<T>(work:(tx:SqlTransaction)=>Promise<T>) {
    try {return await this.database.transaction(async tx=>{
      await tx.query("SELECT set_config('statement_timeout','2500ms',true),set_config('lock_timeout','1500ms',true),set_config('transaction_timeout','15000ms',true)",[]);
      return work(tx);
    });} catch(error) {
      if(error instanceof ModerationError||error instanceof RetrievalError)throw error;
      return safeError(error);
    }
  }
  private async administrator(tx:SqlTransaction,context:ActorContext) {
    const actor=await lockActor(tx,context);
    if(!actor.administrator)throw new PublicationError('forbidden');
    return actor;
  }
  /** Metadata only. The caller holds the full resource plan even for suppressed
   * targets. This path never grants an exception to ordinary content guards. */
  private async projection(tx:SqlTransaction,id:string):Promise<C.ModerationResourceView> {
    const row=(await tx.query<ControlRow>(`SELECT ${columns} FROM loom.resources WHERE id=$1`,[id])).rows[0];
    if(!row)throw new PublicationError('unavailable');
    let kind:C.ModerationTargetView['kind'],source=row;
    switch(row.kind) {
      case 'discussion': {
        const discussion=(await tx.query<{opening_id:string}>('SELECT opening_id FROM loom.discussions WHERE id=$1',[id])).rows[0];
        if(!discussion)throw new ModerationError('moderation_target_unsupported');
        source=(await tx.query<ControlRow>(`SELECT ${columns} FROM loom.resources WHERE id=$1`,[discussion.opening_id])).rows[0]!;
        kind='discussion';break;
      }
      case 'contribution': {
        const comment=(await tx.query<{parent_id:string|null}>('SELECT parent_id FROM loom.contributions WHERE id=$1',[id])).rows[0];
        if(!comment?.parent_id)throw new ModerationError('moderation_target_unsupported');
        kind='comment';break;
      }
      case 'artifact':case 'summary':
        if(!(await tx.query(`SELECT id FROM loom.${row.kind==='artifact'?'artifacts':'summaries'} WHERE id=$1`,[id])).rowCount)
          throw new ModerationError('moderation_target_unsupported');
        kind=row.kind;break;
      default:throw new ModerationError('moderation_target_unsupported');
    }
    let available=source.state==='active',current:ControlRow|undefined=row;
    const seen=new Set<string>();
    while(current) {
      if(seen.has(current.id)||seen.size>=32)throw new PublicationError('service_unavailable');
      seen.add(current.id);available=available&&current.state==='active';
      if(!current.owner_resource_id){if(current.kind!=='area')available=false;break;}
      const expected=current.kind==='contribution'||current.kind==='summary'?'discussion':'area';
      current=(await tx.query<ControlRow>(`SELECT ${columns} FROM loom.resources WHERE id=$1`,[current.owner_resource_id])).rows[0];
      if(!current||current.kind!==expected)available=false;
    }
    const revision=source.current_revision_id?(await tx.query<{availability:string;content_format:string}>(
      'SELECT availability,content_format FROM loom.revisions WHERE id=$1 AND resource_id=$2',[source.current_revision_id,source.id])).rows[0]:undefined;
    available=available&&revision?.availability==='available'&&['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3'].includes(revision.content_format);
    return {target:{kind,resource_id:id},local_state:row.state as C.ModerationResourceView['local_state'],
      version:row.lifecycle_version,owner_id:row.owner_resource_id,ordinary_read_available:available};
  }
  private async plan(tx:SqlTransaction,ids:string[],exclusive?:string) {
    await lockReferencePlan(tx,ids,exclusive);
    // Lock even hidden current revisions before a state UPDATE fires visibility
    // triggers. Restoring must not acquire a revision guard after derived state.
    const revisions=(await tx.query<{id:string}>(`SELECT v.id FROM loom.revisions v JOIN loom.resources r ON r.current_revision_id=v.id
      WHERE r.id=ANY($1::uuid[]) OR r.id IN (SELECT opening_id FROM loom.discussions WHERE id=ANY($1::uuid[]))
      ORDER BY v.id`,[ids])).rows;
    for(const row of revisions)await tx.query('SELECT id FROM loom.revisions WHERE id=$1 FOR SHARE',[row.id]);
  }
  private decision(tx:SqlTransaction,actor:string,key:string) {
    return tx.query<Decision>('SELECT * FROM loom.moderation_operations WHERE actor_id=$1 AND idempotency_key=$2',[actor,key]).then(r=>r.rows[0]);
  }
  private result(saved:Decision,current:C.ModerationResourceView,idempotency:'created'|'replayed'):C.ModerationResultView {
    return fit({operation_state:'recorded',operation_id:saved.id,idempotency,
      outcome:{target:{kind:saved.target_kind,resource_id:saved.resource_id},suppressed:saved.suppressed,version:saved.result_version},current},C.moderationLimits.responseBytes);
  }
  async change(context:ActorContext,value:unknown):Promise<C.ModerationResultView> {
    if(!Value.Check(C.ModerationInput,value))throw new PublicationError('invalid_input');
    const input: C.ModerationCommand={...value,idempotency_key:value.idempotency_key.toLowerCase(),target:{...value.target,resource_id:value.target.resource_id.toLowerCase()}};
    const digest=createHash('sha256').update(JSON.stringify([C.moderationContract,input.target.kind,input.target.resource_id,input.suppressed,input.expected_version])).digest('hex');
    return this.run(async tx=>{
      await lockAttempt(tx,identityOf(context).participantId,'moderation.set',input.idempotency_key);
      const actor=await this.administrator(tx,context),saved=await this.decision(tx,actor.participantId,input.idempotency_key);
      if(saved) {
        if(saved.request_digest!==digest)throw new PublicationError('idempotency_conflict');
        await this.plan(tx,[saved.resource_id]);
        return this.result(saved,await this.projection(tx,saved.resource_id),'replayed');
      }
      await structureGuard(tx,true);
      await this.plan(tx,[input.target.resource_id],input.target.resource_id);
      const current=await this.projection(tx,input.target.resource_id);
      if(current.target.kind!==input.target.kind)throw new ModerationError('moderation_target_unsupported');
      if(current.local_state==='removed')throw new PublicationError('unavailable');
      if(current.version!==input.expected_version)throw new ModerationError('moderation_conflict');
      const count=(await tx.query<{decisions:number}>('SELECT decisions FROM loom.moderation_state WHERE id=1',[])).rows[0]!.decisions;
      if(count>=C.moderationLimits.decisions)throw new ModerationError('moderation_limit');
      await tx.query('UPDATE loom.resources SET state=$2,lifecycle_version=lifecycle_version+1 WHERE id=$1',
        [input.target.resource_id,input.suppressed?'suppressed':'active']);
      await tx.query('UPDATE loom.moderation_state SET version=version+1,decisions=decisions+1 WHERE id=1',[]);
      const savedDecision=(await tx.query<Decision>(`INSERT INTO loom.moderation_operations
        (id,actor_id,idempotency_key,semantic_version,request_digest,resource_id,target_kind,suppressed,result_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [randomUUID(),actor.participantId,input.idempotency_key,C.moderationContract,digest,input.target.resource_id,input.target.kind,input.suppressed,current.version+1])).rows[0]!;
      await tx.query('INSERT INTO loom.moderation_audit(operation_id,actor_credential_id) VALUES($1,$2)',[savedDecision.id,actor.credentialId]);
      return this.result(savedDecision,await this.projection(tx,input.target.resource_id),'created');
    });
  }
  status(context:ActorContext,value:unknown):Promise<C.ModerationStatusView> {
    if(!Value.Check(C.ModerationStatusInput,value))throw new PublicationError('invalid_input');
    const key=value.idempotency_key.toLowerCase();
    return this.run(async tx=>{
      await lockAttempt(tx,identityOf(context).participantId,'moderation.set',key);
      const actor=await this.administrator(tx,context),saved=await this.decision(tx,actor.participantId,key);
      if(!saved)return {operation_state:'not_recorded'};
      await this.plan(tx,[saved.resource_id]);
      return this.result(saved,await this.projection(tx,saved.resource_id),'replayed');
    });
  }
  resource(context:ActorContext,id:string) {
    if(!Value.Check(UUID,id))throw new PublicationError('invalid_input');
    id=id.toLowerCase();
    return this.run(async tx=>{await this.administrator(tx,context);await this.plan(tx,[id]);return this.projection(tx,id);});
  }
  private cursor(binding:string,after:string) {
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.cursorKey,nonce);
    const bytes=Buffer.concat([cipher.update(JSON.stringify({binding,after,expires:Date.now()+300000})),cipher.final()]);
    return Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64url');
  }
  private after(binding:string,cursor?:string) {
    if(!cursor)return null;
    try {
      if(cursor.length>2048)throw new Error();
      const bytes=Buffer.from(cursor,'base64url'),decipher=createDecipheriv('aes-256-gcm',this.cursorKey,bytes.subarray(0,12));
      decipher.setAuthTag(bytes.subarray(12,28));
      const value=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());
      if(value.binding!==binding||value.expires<Date.now()||!Value.Check(UUID,value.after))throw new Error();
      return value.after as string;
    }catch{throw new RetrievalError('invalid_cursor');}
  }
  list(context:ActorContext,collection:'targets'|'audit',options:Options={}) {
    const size=Number(options.limit??12);
    if(!Number.isInteger(size)||size<1||size>25)throw new PublicationError('invalid_input');
    return this.run(async tx=>{
      const actor=await this.administrator(tx,context);await structureGuard(tx);
      const state=(await tx.query(`SELECT m.version::text,s.visibility_version::text,o.version AS hierarchy
        FROM loom.moderation_state m,loom.search_state s,loom.organization_state o WHERE m.id=1 AND s.id=1 AND o.id=1`,[])).rows[0]!;
      const binding=JSON.stringify([actor.participantId,collection,state]),after=this.after(binding,options.cursor);
      if(collection==='audit') {
        const rows=(await tx.query<Decision>('SELECT * FROM loom.moderation_operations WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2',[after,size+1])).rows;
        const shown=rows.slice(0,size);
        return fit({items:shown.map(r=>({operation_id:r.id,actor_id:r.actor_id,target:{kind:r.target_kind,resource_id:r.resource_id},suppressed:r.suppressed,version:r.result_version,recorded_at:r.recorded_at.toISOString()})),
          complete:rows.length<=size,next_cursor:rows.length>size?this.cursor(binding,shown.at(-1)!.id):null},C.moderationLimits.responseBytes);
      }
      const rows=(await tx.query<{id:string;supported:boolean}>(`WITH candidates AS MATERIALIZED (
        SELECT id FROM loom.resources WHERE state='suppressed' AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 101)
        SELECT r.id,(EXISTS(SELECT 1 FROM loom.discussions d WHERE d.id=r.id) OR EXISTS(SELECT 1 FROM loom.artifacts a WHERE a.id=r.id)
          OR EXISTS(SELECT 1 FROM loom.summaries s WHERE s.id=r.id) OR EXISTS(SELECT 1 FROM loom.contributions c WHERE c.id=r.id AND c.parent_id IS NOT NULL)) AS supported
        FROM candidates r ORDER BY r.id`,[after])).rows;
      const scanned=[];let eligible=0;
      for(const row of rows.slice(0,100)){if(row.supported&&eligible===size)break;scanned.push(row);if(row.supported)eligible++;}
      const shown=scanned.filter(r=>r.supported);await this.plan(tx,shown.map(r=>r.id));
      const items=[];for(const row of shown)items.push(await this.projection(tx,row.id));
      const complete=scanned.length===rows.length;
      return fit({items,complete,next_cursor:complete?null:this.cursor(binding,scanned.at(-1)!.id)},C.moderationLimits.responseBytes);
    });
  }
}
