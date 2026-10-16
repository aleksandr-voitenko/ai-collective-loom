import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { SqlTransaction } from '../../db/postgres.js';
import type { ActorContext } from '../publication/actor.js';
import { lockActor, lockContext, safeError, type Transactions } from '../publication/publication.js';
import { PublicationError } from '../publication/errors.js';
import { ParticipationRetrieval, RetrievalError, fit } from '../participation/retrieval.js';
import { lockReferencePlan } from '../participation/reference-context.js';
import { notificationSources } from './worker.js';
import { NotificationQuery, notificationContract, notificationReadLimits as limits,
  type NotificationOptions, type NotificationPageView, type NotificationItemView } from '../../../contracts/notifications.js';

const errors={
  notification_token_invalid:'This personal retrieval token does not match the current participant or selection.',
  notification_descriptor_expired:'This traversal expired. Renew it to continue its retained fixed interval.',
  visibility_replay_required:'Shared visibility changed. Replay retained personal history, including history before your checkpoint.',
  notification_history_gap:'Part of the requested personal history is no longer retained. Resynchronize the retained history explicitly.',
  notification_epoch_changed:'This checkpoint belongs to another recovery epoch. Continuity requires the deployment recovery procedure.',
  notification_work_limit:'This request exceeded a bounded notification retrieval limit. Retry the same position or reduce the page size.',
  notification_view_changed:'Source policy changed during this page. Retry the same position.',
};
export class NotificationError extends Error {
  constructor(readonly code:keyof typeof errors){super(errors[code]);}
}
type Descriptor={v:1;owner:string;epoch:string;instance:string;visibility:string;reason:'all'|'mention'|'reply';
  kind:'traversal'|'checkpoint';id:string;lower:string;upper:string;after:string;expires:number;history:'retained'|'incomplete'};
type State={cursor_key:Buffer;recovery_epoch:string;instance_id:string;visibility:string};
export type PersonalCandidate={id:string;signal_id:string;position:string;available_at:Date;resource_id:string;revision_id:string;source_event_id:string;
  parent_id:string|null;discussion_id:string|null};
type Authority=Awaited<ReturnType<typeof lockActor>>;
const isUnavailable=(error:unknown)=>error instanceof PublicationError && error.code==='unavailable';

export class PersonalNotifications {
  private readonly reads:ParticipationRetrieval;
  constructor(private readonly database:Transactions){this.reads=new ParticipationRetrieval(database);}
  private async run<T>(operation:(tx:SqlTransaction)=>Promise<T>){
    try{return await this.database.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',[]);
      await tx.query("SET LOCAL statement_timeout='2500ms'",[]);
      await tx.query("SET LOCAL lock_timeout='1500ms'",[]);
      await tx.query("SET LOCAL transaction_timeout='15000ms'",[]);
      return operation(tx);
    });}catch(error){
      if(error instanceof NotificationError||error instanceof RetrievalError)throw error;
      if(['40001','40P01','55P03'].includes((error as {code?:string})?.code??''))throw new NotificationError('notification_view_changed');
      if(['57014','25P04'].includes((error as {code?:string})?.code??''))throw new NotificationError('notification_work_limit');
      return safeError(error);
    }
  }
  private async state(tx:SqlTransaction):Promise<State>{
    return (await tx.query<State>(`SELECT n.cursor_key,n.recovery_epoch,n.visibility_version::text AS visibility,c.instance_id
      FROM loom.notification_state n CROSS JOIN loom.community_settings c WHERE n.id=1 AND c.id=1`,[])).rows[0]!;
  }
  private encode(state:State,value:Descriptor){
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',state.cursor_key,nonce);
    const bytes=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    return Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64url');
  }
  private decode(state:State,token:string,owner:string):Descriptor{
    let saved:Descriptor;
    try{
      if(Buffer.byteLength(token)>limits.cursorBytes)throw new Error();
      const bytes=Buffer.from(token,'base64url'),decipher=createDecipheriv('aes-256-gcm',state.cursor_key,bytes.subarray(0,12));
      decipher.setAuthTag(bytes.subarray(12,28));
      saved=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')) as Descriptor;
      if(saved.v!==1||saved.owner!==owner||saved.instance!==state.instance_id||!['all','mention','reply'].includes(saved.reason)||
        !['traversal','checkpoint'].includes(saved.kind)||![saved.lower,saved.upper,saved.after].every(v=>/^\d{1,15}$/.test(v))||
        BigInt(saved.lower)>BigInt(saved.after)||BigInt(saved.after)>BigInt(saved.upper)||!Number.isFinite(saved.expires))throw new Error();
    }catch{throw new NotificationError('notification_token_invalid');}
    if(saved.epoch!==state.recovery_epoch)throw new NotificationError('notification_epoch_changed');
    return saved;
  }
  query(actorContext:ActorContext,options:NotificationOptions):Promise<NotificationPageView>{
    if(!Value.Check(NotificationQuery,options)||[options.cursor,options.checkpoint,options.recovery].filter(Boolean).length>1)
      throw new PublicationError('invalid_input');
    if(options.recovery&&!options.recovery.token&&options.recovery.action!=='resynchronize')throw new PublicationError('invalid_input');
    return this.run(async tx=>{
      const actor=await lockActor(tx,actorContext),state=await this.state(tx);
      const clock=(await tx.query<{position:string;retained_after:string}>(
        'SELECT position::text,retained_after::text FROM loom.participant_delivery_clocks WHERE participant_id=$1',[actor.participantId])).rows[0]
        ??{position:'0',retained_after:'0'};
      const token=options.cursor??options.checkpoint??options.recovery?.token;
      const saved=token?this.decode(state,token,actor.participantId):undefined;
      // Visibility/epoch/history controls cannot be hidden by ordinary reason filters.
      if(saved&&saved.visibility!==state.visibility&&!['replay','resynchronize'].includes(options.recovery?.action??''))
        throw new NotificationError('visibility_replay_required');
      if(saved&&BigInt(saved.kind==='checkpoint'?saved.upper:saved.lower)<BigInt(clock.retained_after)&&!['replay','resynchronize'].includes(options.recovery?.action??''))
        throw new NotificationError('notification_history_gap');
      if(saved&&options.reason&&options.reason!==saved.reason)throw new NotificationError('notification_token_invalid');
      if(options.cursor&&saved?.kind!=='traversal'||options.checkpoint&&saved?.kind!=='checkpoint')throw new NotificationError('notification_token_invalid');
      if(saved?.kind==='traversal'&&saved.expires<=Date.now()&&!options.recovery)throw new NotificationError('notification_descriptor_expired');
      if(saved&&BigInt(saved.upper)>BigInt(clock.position))throw new NotificationError('notification_history_gap');
      const action=options.recovery?.action;
      const replay=action==='replay'||action==='resynchronize';
      if(action==='renew'&&saved?.kind!=='traversal')throw new NotificationError('notification_token_invalid');
      const lower=replay?clock.retained_after:saved?.kind==='checkpoint'?saved.upper:saved?.lower??'0';
      if(!saved&&!replay&&BigInt(clock.retained_after)>0n)throw new NotificationError('notification_history_gap');
      const bound:Descriptor=saved?.kind==='traversal'&&!replay?{...saved,expires:action==='renew'?Date.now()+limits.cursorSeconds*1000:saved.expires}:{
        v:1,owner:actor.participantId,epoch:state.recovery_epoch,instance:state.instance_id,visibility:state.visibility,
        reason:saved?.reason??options.reason??'all',kind:'traversal',id:randomUUID(),lower,upper:clock.position,after:lower,
        expires:Date.now()+limits.cursorSeconds*1000,history:replay&&clock.retained_after!=='0'?'incomplete':'retained'};
      const candidates=(await tx.query<PersonalCandidate>(`SELECT d.id,d.signal_id,d.position::text,d.available_at,s.resource_id,s.revision_id,s.source_event_id,
        c.parent_id,COALESCE(c.discussion_id,CASE WHEN r.kind='summary' THEN r.owner_resource_id END) AS discussion_id
        FROM loom.personal_deliveries d JOIN loom.notification_signals s ON s.id=d.signal_id JOIN loom.resources r ON r.id=s.resource_id
        LEFT JOIN loom.contributions c ON c.id=s.resource_id WHERE d.recipient_id=$1 AND d.position>$2 AND d.position<=$3
        ORDER BY d.position LIMIT 101`,[actor.participantId,bound.after,bound.upper])).rows;
      const statusSources=await this.statusSources(tx);
      await lockReferencePlan(tx,[...candidates.slice(0,limits.scan).flatMap(r=>[r.resource_id,r.parent_id,r.discussion_id].filter((id):id is string=>!!id)),
        ...statusSources.map(r=>r.id)]);
      const limit=options.limit??12,budget=options.max_response_bytes??131072;
      const page:NotificationPageView={contract_version:notificationContract,items:[],traversal:{id:bound.id,scope:'personal_direct_attention',reason:bound.reason,
        selection:'complete',order:'availability_ascending',expires_at:new Date(bound.expires).toISOString(),boundaries:'fixed_personal_availability_interval'},
        page_cursor:this.encode(state,bound),next_cursor:null,checkpoint:null,interval_complete:false,work_budget_reached:false,
        projection:await this.projection(tx,statusSources),recovery:action==='renew'?'renewed':action==='replay'?'visibility_replay':action==='resynchronize'?'retained_resynchronization':'none',
        history:bound.history,omitted_detail:'full_bodies',limit,max_response_bytes:budget};
      let consumed=0,last=bound.after;
      for(const row of candidates.slice(0,limits.scan)){
        let entry:NotificationItemView|undefined;
        try{
          const reasons=await this.reasons(tx,row.signal_id);
          if(bound.reason==='all'||reasons.some(r=>bound.reason==='reply'?r.kind==='direct_reply':r.kind!=='direct_reply'))
            entry=await this.item(tx,actor,row,reasons);
        }catch(error){if(!isUnavailable(error))throw error;}
        if(entry){
          const preview={...page,items:[...page.items,entry],next_cursor:this.encode(state,{...bound,after:row.position})};
          if(page.items.length===limit||Buffer.byteLength(JSON.stringify(preview))>budget){if(!page.items.length)fit(preview,budget);break;}
          page.items.push(entry);
        }
        consumed++;last=row.position;
      }
      page.interval_complete=consumed===candidates.length;
      page.work_budget_reached=!page.interval_complete&&consumed===limits.scan;
      if(page.interval_complete)page.checkpoint=this.encode(state,{...bound,kind:'checkpoint',after:bound.upper,expires:0});
      else page.next_cursor=this.encode(state,{...bound,after:last});
      return fit(page,budget);
    });
  }
  reasons(tx:SqlTransaction,signal:string){
    return tx.query<{kind:'main_mention'|'direct_reply'|'note_mention';source_field:'main'|'reply'|'change_note'}>(
      'SELECT kind,source_field FROM loom.notification_claims WHERE signal_id=$1 ORDER BY kind LIMIT 3',[signal]).then(r=>r.rows);
  }
  /** Internal projection: caller owns the transaction and complete resource plan. */
  async item(tx:SqlTransaction,actor:Authority,row:PersonalCandidate,reasons:Awaited<ReturnType<PersonalNotifications['reasons']>>):Promise<NotificationItemView>{
    const source=await this.reads.resource(tx,actor,row.resource_id,row.revision_id);
    const current=(await lockContext(tx,row.resource_id,'resolution'))[0]!.current_revision_id;
    const currentAvailable=!!current&&(await tx.query("SELECT id FROM loom.revisions WHERE id=$1 AND availability='available' FOR SHARE",[current])).rowCount===1;
    const present=currentAvailable&&(await tx.query(`SELECT 1 FROM loom.revision_mentions WHERE revision_id=$1 AND participant_id=$2 AND source_field='main' LIMIT 1`,[current,actor.participantId])).rowCount===1;
    let parent:NotificationItemView['parent']=null,contextTitle=source.title??'Reply';
    if(row.parent_id){
      parent={state:'unavailable',resource_id:row.parent_id};
      try{const value=await this.reads.resource(tx,actor,row.parent_id);parent={state:'available',resource_id:row.parent_id,author:value.author,
        title:value.title,browser_url:`/loom/resource/${value.resource_id}/${value.revision_id}`};}catch(error){if(!isUnavailable(error))throw error;}
    }
    if(source.discussion_id){
      const opening=(await tx.query<{opening_id:string}>('SELECT opening_id FROM loom.discussions WHERE id=$1',[source.discussion_id])).rows[0];
      if(opening)try{const value=await this.reads.resource(tx,actor,opening.opening_id);contextTitle=value.title??'Discussion';}
      catch(error){if(!isUnavailable(error))throw error;contextTitle=source.title??'Discussion';}
    }
    return {delivery_id:row.id,signal_id:row.signal_id,available_at:row.available_at.toISOString(),source_event_id:row.source_event_id,source,
      context_title:contextTitle,context_url:source.discussion_id?`/loom/discussion/${source.discussion_id}?focus=${source.resource_id}`:`/loom/resource/${source.resource_id}`,
      browser_url:`/loom/resource/${source.resource_id}/${source.revision_id}`,detail_url:`/api/v1/me/notifications/${row.id}`,
      reasons:reasons.map(r=>({...r,revision_id:row.revision_id,full_content_url:source.full_content_url+(r.source_field==='change_note'?'/change-note':'')})),
      current:currentAvailable?{state:'available',revision_id:current!,main_mention:present?'present':'absent'}:{state:'unavailable',main_mention:'unknown'},parent};
  }
  detail(actorContext:ActorContext,id:string){return this.run(async tx=>{
    const actor=await lockActor(tx,actorContext);
    const row=(await tx.query<PersonalCandidate>(`SELECT d.id,d.signal_id,d.position::text,d.available_at,s.resource_id,s.revision_id,s.source_event_id,c.parent_id,
      COALESCE(c.discussion_id,CASE WHEN r.kind='summary' THEN r.owner_resource_id END) AS discussion_id
      FROM loom.personal_deliveries d JOIN loom.notification_signals s ON s.id=d.signal_id JOIN loom.resources r ON r.id=s.resource_id
      LEFT JOIN loom.contributions c ON c.id=s.resource_id WHERE d.id=$1 AND d.recipient_id=$2`,[id,actor.participantId])).rows[0];
    if(!row)throw new PublicationError('unavailable');
    await lockReferencePlan(tx,[row.resource_id,row.parent_id,row.discussion_id].filter((v):v is string=>!!v));
    return fit(await this.item(tx,actor,row,await this.reasons(tx,row.signal_id)),131072);
  });}
  statusSources(tx:SqlTransaction){return tx.query<{id:string;current_revision_id:string|null}>(
    `${notificationSources} ORDER BY r.id LIMIT 26`,[]).then(r=>r.rows);}
  async projection(tx:SqlTransaction,sources:Awaited<ReturnType<PersonalNotifications['statusSources']>>):Promise<NotificationPageView['projection']>{
    let state:'complete'|'incomplete'|'unknown'=sources.length>limits.statusSources?'unknown':'complete';
    for(const row of sources.slice(0,limits.statusSources))try{
      await lockContext(tx,row.id,'resolution');
      // Exact historical revisions remain readable when the current revision is
      // suppressed. Their pending projection must not be reported as complete.
      const revision=(await tx.query<{revision_number:string}>(`SELECT revision_number::text FROM loom.revisions
        WHERE resource_id=$1 AND availability='available' ORDER BY revision_number DESC LIMIT 1 FOR SHARE`,[row.id])).rows[0];
      if(!revision)continue;
      const head=(await tx.query<{revision_number:string;incomplete:boolean}>('SELECT revision_number::text,incomplete FROM loom.notification_projection_heads WHERE resource_id=$1',[row.id])).rows[0];
      if(!head||head.incomplete||BigInt(head.revision_number)<BigInt(revision.revision_number)){state='incomplete';break;}
    }catch(error){if(!isUnavailable(error))throw error;}
    return {state,coverage:'currently_eligible_supported_sources'};
  }
}
