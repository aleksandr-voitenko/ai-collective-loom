import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import * as C from '../../../contracts/attention.js';
import * as P from '../../../contracts/private-controls.js';
import { FollowTarget, eventPreferences, type FollowTargetView, type BoundDefinitionView } from '../../../contracts/following.js';
import type { SqlTransaction } from '../../db/postgres.js';
import { lockAttempt } from '../../application/attempt.js';
import { identityOf, type ActorContext } from '../publication/actor.js';
import { lockActor, lockContext, requireRevision, safeError, type Transactions } from '../publication/publication.js';
import { PublicationError } from '../publication/errors.js';
import { lockReferencePlan } from '../participation/reference-context.js';
import { fit, RetrievalError } from '../participation/retrieval.js';
import { followSource, unavailable } from '../following/context.js';
import { sharedCandidatesSql, sharedCategories, type SharedCandidate } from '../following/retrieval.js';

const L=C.attentionLimits;
const messages={
  attention_limit_reached:'The synthetic attention retention limit was reached. Lookup and exact recorded recovery remain available; no state is evicted.',
  attention_collection_changed:'Attention choices changed between pages. Refresh this private collection.',
  attention_selection_expired:'This selection expired. Check the exact saved outcome first; absence does not prove an uncertain request failed.',
  attention_selection_too_large:'This card exceeds 100 shared/personal inputs. Inspect its sources and explicitly select a smaller set; nothing was truncated.',
  attention_work_limit:'Attention source validation exceeded its bounded work deadline. Retry the same command or read.',
};
export class AttentionError extends Error { constructor(readonly code:keyof typeof messages){super(messages[code]);} }
export type MuteRow={target_kind:FollowTargetView['kind'];resource_id:string;include_descendants:boolean;muted:boolean;version:number};
type DismissRow={input_kind:C.AttentionInputView['kind'];input_id:string;dismissed:boolean;version:number};
type Quota={version:number;mutes:number;active_mutes:number;inputs:number;operations:number;members:number};
type Decision={id:string;kind:'mute'|'dismissal';request_digest:string;decision:'applied'|'version_conflict';outcome:C.AttentionResultView['outcome']};
export const inputKey=(v:C.AttentionInputView)=>v.kind+':'+v.id;
export function normalizeInputs<T extends C.AttentionInputView>(inputs:T[]):T[]{
  const list=inputs.map(v=>({...v,id:v.id.toLowerCase()})).sort((a,b)=>inputKey(a).localeCompare(inputKey(b)));
  if(new Set(list.map(inputKey)).size!==list.length)throw new PublicationError('invalid_input');
  return list;
}
export async function attentionOwner(tx:SqlTransaction,owner:string,write=false){
  await tx.query(`SELECT ${write?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared'}(hashtextextended($1,0))`,[JSON.stringify(['loom.attention.owner',owner])]);
}
export async function attentionPolicy(tx:SqlTransaction,owner:string){
  const version=(await tx.query<{version:number}>('SELECT version FROM loom.attention_owners WHERE participant_id=$1 FOR SHARE',[owner])).rows[0]?.version??0;
  const mutes=(await tx.query<MuteRow>('SELECT * FROM loom.attention_mutes WHERE participant_id=$1 AND muted ORDER BY target_kind,resource_id LIMIT 65',[owner])).rows;
  if(mutes.length>L.activeMutes)throw new AttentionError('attention_limit_reached');
  const definitions:BoundDefinitionView[]=mutes.map(r=>({target:{kind:r.target_kind,resource_id:r.resource_id},include_descendants:r.include_descendants,preferences:[...eventPreferences],version:r.version}));
  return {version,mutes,definitions};
}
export async function dismissalStates(tx:SqlTransaction,owner:string,inputs:C.AttentionInputView[]){
  const rows=(await tx.query<DismissRow>(`SELECT * FROM loom.attention_dismissals WHERE participant_id=$1
    AND (input_kind,input_id) IN (SELECT * FROM unnest($2::text[],$3::uuid[]))`,[owner,inputs.map(v=>v.kind),inputs.map(v=>v.id)])).rows;
  return new Map(rows.map(r=>[inputKey({kind:r.input_kind,id:r.input_id}),r]));
}
async function key(tx:SqlTransaction){return (await tx.query<{selection_key:Buffer}>('SELECT selection_key FROM loom.attention_state WHERE id=1',[])).rows[0]!.selection_key;}
async function seal(tx:SqlTransaction,value:unknown){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await key(tx),nonce);cipher.setAAD(Buffer.from(C.attentionContract));
  const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
  const token=Buffer.concat([nonce,cipher.getAuthTag(),data]).toString('base64url');
  if(Buffer.byteLength(token)>L.selectionBytes)throw new AttentionError('attention_selection_too_large');return token;
}
async function open(tx:SqlTransaction,token:string):Promise<any>{
  try{if(Buffer.byteLength(token)>L.selectionBytes)throw new Error();
    const bytes=Buffer.from(token,'base64url'),cipher=createDecipheriv('aes-256-gcm',await key(tx),bytes.subarray(0,12));
    cipher.setAAD(Buffer.from(C.attentionContract));cipher.setAuthTag(bytes.subarray(12,28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString());
  }catch{throw new PublicationError('invalid_input');}
}
export async function prepareAttentionSelection(tx:SqlTransaction,owner:string,instance:string,policy:number,
  meaning:{view:string;group:string;selection:string},inputs:C.AttentionInputView[]):Promise<C.AttentionSelectionView>{
  if(!inputs.length)throw new PublicationError('unavailable');
  if(inputs.length>L.batch)throw new AttentionError('attention_selection_too_large');
  const list=normalizeInputs(inputs),states=await dismissalStates(tx,owner,list),expires=Date.now()+L.selectionSeconds*1000;
  const items=list.map(v=>({...v,dismissed:states.get(inputKey(v))?.dismissed??false,version:states.get(inputKey(v))?.version??0,availability:'available' as const}));
  return {selection:await seal(tx,{purpose:'dismissal-selection-1',owner,instance,policy,meaning,expires,inputs:items.map(({kind,id,version})=>({kind,id,version}))}),
    inputs:items,policy_version:policy,shared_events:items.filter(v=>v.kind==='shared_event').length,personal_signals:items.filter(v=>v.kind==='personal_delivery').length,
    membership:'exact_represented_inputs_including_unexpanded_direct_sources',expires_at:new Date(expires).toISOString()};
}

/** Owner-private choices only; no publication tail, reading or delivery effects. */
type Mute<M extends P.Projection>=P.Projected<M,C.MuteItemView,P.MuteItemView>;
type Dismiss<M extends P.Projection>=P.Projected<M,C.DismissItemView,P.DismissItemView>;
type Result<M extends P.Projection>=P.Projected<M,C.AttentionResultView,P.AttentionResultView>;
export class AttentionControls<M extends P.Projection='legacy'> {
  constructor(private readonly database:Transactions,private readonly projection:M='legacy' as M){}
  private async run<T>(actor:ActorContext,write:boolean,operation:string|undefined,work:(tx:SqlTransaction,owner:string)=>Promise<T>){
    try{return await this.database.transaction(async tx=>{
      await tx.query("SELECT set_config('statement_timeout','2500ms',true),set_config('lock_timeout','1500ms',true),set_config('transaction_timeout','15000ms',true)",[]);
      if(operation)await lockAttempt(tx,identityOf(actor).participantId,'attention.set',operation);
      const current=await lockActor(tx,actor);await attentionOwner(tx,current.participantId,write);
      return fit(await work(tx,current.participantId),L.responseBytes);
    });}catch(error){
      if(error instanceof AttentionError||error instanceof RetrievalError)throw error;
      if(['40001','40P01','55P03','57014','25P04'].includes((error as {code?:string})?.code??''))throw new AttentionError('attention_work_limit');
      return safeError(error);
    }
  }
  private async quota(tx:SqlTransaction,owner:string,members:number){
    await tx.query('INSERT INTO loom.attention_owners(participant_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
    const q=(await tx.query<Quota>('SELECT * FROM loom.attention_owners WHERE participant_id=$1',[owner])).rows[0]!;
    if(q.operations>=L.operations||q.members+members>L.outcomeMembers||q.version>=2147483646)throw new AttentionError('attention_limit_reached');return q;
  }
  private findMute(tx:SqlTransaction,owner:string,target:FollowTargetView){return tx.query<MuteRow>('SELECT * FROM loom.attention_mutes WHERE participant_id=$1 AND target_kind=$2 AND resource_id=$3',[owner,target.kind,target.resource_id]).then(r=>r.rows[0]);}
  private async muteView(tx:SqlTransaction,owner:string,target:FollowTargetView,row?:MuteRow,known=false):Promise<Mute<M>>{
    const current={target,include_descendants:row?.include_descendants??false,muted:row?.muted??false,version:row?.version??0};
    if(this.projection==='private')return current as Mute<M>;
    let source:C.MuteItemView['source']={state:'unavailable'};
    try{source=await followSource(tx,target);}catch(error){if(!unavailable(error)||!row&&!known)throw error;}
    const policy=await attentionPolicy(tx,owner),path=source.state==='available'?source.path.map(v=>v.id):[];
    return {...current,source,
      other_current_scope_mutes:policy.mutes.filter(m=>!(m.target_kind===target.kind&&m.resource_id===target.resource_id)&&m.target_kind==='area'&&
        (m.include_descendants?path.includes(m.resource_id):target.kind!=='area'&&path.at(-1)===m.resource_id))
        .map(m=>({target:{kind:m.target_kind,resource_id:m.resource_id},include_descendants:m.include_descendants}))} as Mute<M>;
  }
  private async available(tx:SqlTransaction,owner:string,inputs:C.AttentionInputView[]){
    const deliveries=(await tx.query<{id:string;source_event_id:string}>(`SELECT d.id,s.source_event_id FROM loom.personal_deliveries d
      JOIN loom.notification_signals s ON s.id=d.signal_id WHERE d.recipient_id=$1 AND d.id=ANY($2::uuid[])`,[owner,inputs.filter(v=>v.kind==='personal_delivery').map(v=>v.id)])).rows;
    const events=(await tx.query<SharedCandidate>(`${sharedCandidatesSql} WHERE e.id=ANY($1::uuid[])`,
      [[...inputs.filter(v=>v.kind==='shared_event').map(v=>v.id),...deliveries.map(d=>d.source_event_id)]])).rows;
    await lockReferencePlan(tx,events.flatMap(e=>[e.resource_id,...(e.discussion_id?[e.discussion_id]:[])]));
    await tx.query('SELECT id FROM loom.revisions WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[events.flatMap(e=>e.revision_id?[e.revision_id]:[])]);
    const eligible=new Set<string>();
    for(const e of events)try{
      if(e.actor_kind==='internal'||!sharedCategories(e))continue;
      await lockContext(tx,e.resource_id,'resolution',['area','discussion','contribution','artifact','summary']);
      if(e.revision_id)await requireRevision(tx,e.resource_id,e.revision_id);eligible.add(e.id);
    }catch(error){if(!unavailable(error))throw error;}
    return new Map(inputs.map(v=>[inputKey(v),eligible.has(v.kind==='shared_event'?v.id:deliveries.find(d=>d.id===v.id)?.source_event_id??'')]));
  }
  private item(v:C.AttentionInputView,rows:Awaited<ReturnType<typeof dismissalStates>>,available:Map<string,boolean>):Dismiss<M>{
    const row=rows.get(inputKey(v)),current={...v,dismissed:row?.dismissed??false,version:row?.version??0};
    return (this.projection==='private'?current:{...current,availability:available.get(inputKey(v))?'available':'unavailable'}) as Dismiss<M>;
  }
  private decision(tx:SqlTransaction,owner:string,id:string){return tx.query<Decision>('SELECT * FROM loom.attention_operations WHERE participant_id=$1 AND idempotency_key=$2',[owner,id]).then(r=>r.rows[0]);}
  private async result(tx:SqlTransaction,owner:string,d:Decision,replayed:boolean):Promise<Result<M>>{
    const common={operation_state:d.decision,operation_id:d.id,idempotency:replayed?'replayed' as const:'created' as const,policy_version:(await attentionPolicy(tx,owner)).version};
    if(d.kind==='mute'){
      const outcome=d.outcome as C.MuteResultView['outcome'];if(this.projection==='legacy')await lockReferencePlan(tx,[outcome.target.resource_id]);
      return {...common,kind:'mute',outcome,current:await this.muteView(tx,owner,outcome.target,await this.findMute(tx,owner,outcome.target),true)} as Result<M>;
    }
    const outcome=d.outcome as C.DismissResultView['outcome'],inputs=outcome.inputs.map(({kind,id})=>({kind,id})),rows=await dismissalStates(tx,owner,inputs),available=this.projection==='legacy'?await this.available(tx,owner,inputs):new Map<string,boolean>();
    return {...common,kind:'dismissal',outcome,current:inputs.map(v=>this.item(v,rows,available))} as Result<M>;
  }
  private async record(tx:SqlTransaction,owner:string,id:string,kind:Decision['kind'],digest:string,applied:boolean,outcome:Decision['outcome'],added:{mutes:number;active:number;inputs:number},members:number){
    const d=(await tx.query<Decision>(`INSERT INTO loom.attention_operations(id,participant_id,idempotency_key,semantic_version,kind,request_digest,decision,outcome)
      VALUES($1,$2,$3,'attention-controls-1',$4,$5,$6,$7::jsonb) RETURNING *`,[randomUUID(),owner,id,kind,digest,applied?'applied':'version_conflict',JSON.stringify(outcome)])).rows[0]!;
    await tx.query(`UPDATE loom.attention_owners SET version=version+$2,mutes=mutes+$3,active_mutes=active_mutes+$4,
      inputs=inputs+$5,operations=operations+1,members=members+$6 WHERE participant_id=$1`,[owner,applied?1:0,added.mutes,added.active,added.inputs,members]);return d;
  }
  previews(actor:ActorContext,value:unknown){
    if(!Value.Check(P.PreviewQuery,value))throw new PublicationError('invalid_input');
    const targets=value.targets.map(t=>({...t,resource_id:t.resource_id.toLowerCase()}));
    if(new Set(targets.map(t=>t.kind+':'+t.resource_id)).size!==targets.length)throw new PublicationError('invalid_input');
    return this.run(actor,false,undefined,async(tx,owner)=>{
      await lockReferencePlan(tx,targets.map(t=>t.resource_id));
      const legacy=new AttentionControls(this.database);
      const items:P.PreviewItemView[]=[];
      for(const target of targets){
        const view=await legacy.muteView(tx,owner,target,undefined,true);
        items.push({target,source:view.source,other_current_scope_mutes:view.other_current_scope_mutes});
      }
      return {items};
    });
  }
  lookupMute(actor:ActorContext,value:unknown){
    if(!Value.Check(FollowTarget,value))throw new PublicationError('invalid_input');const target={...value,resource_id:value.resource_id.toLowerCase()};
    return this.run(actor,false,undefined,async(tx,owner)=>{if(this.projection==='legacy')await lockReferencePlan(tx,[target.resource_id]);return this.muteView(tx,owner,target,await this.findMute(tx,owner,target));});
  }
  setMute(actor:ActorContext,value:unknown){
    if(!Value.Check(C.MuteUpdate,value)||value.target.kind!=='area'&&value.include_descendants)throw new PublicationError('invalid_input');
    const v={...value,idempotency_key:value.idempotency_key.toLowerCase(),target:{...value.target,resource_id:value.target.resource_id.toLowerCase()}};
    const digest=createHash('sha256').update(JSON.stringify([C.attentionContract,'mute',v.target.kind,v.target.resource_id,v.include_descendants,v.muted,v.expected_version])).digest('hex');
    return this.run(actor,true,v.idempotency_key,async(tx,owner)=>{
      const old=await this.decision(tx,owner,v.idempotency_key);if(old){if(old.request_digest!==digest)throw new PublicationError('idempotency_conflict');return this.result(tx,owner,old,true);}
      const row=await this.findMute(tx,owner,v.target);if(this.projection==='legacy'||v.muted||!row)await lockReferencePlan(tx,[v.target.resource_id]);
      if(v.muted||!row)await followSource(tx,v.target);
      const q=await this.quota(tx,owner,1),applied=v.expected_version===(row?.version??0),added=applied&&!row?1:0,active=applied?Number(v.muted)-Number(row?.muted??false):0;
      if(q.mutes+added>L.mutes||q.active_mutes+active>L.activeMutes||applied&&(row?.version??0)>=2147483646)throw new AttentionError('attention_limit_reached');
      if(applied)await tx.query(`INSERT INTO loom.attention_mutes(participant_id,target_kind,resource_id,include_descendants,muted,version)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(participant_id,target_kind,resource_id) DO UPDATE SET
        include_descendants=EXCLUDED.include_descendants,muted=EXCLUDED.muted,version=EXCLUDED.version`,[owner,v.target.kind,v.target.resource_id,v.include_descendants,v.muted,(row?.version??0)+1]);
      const d=await this.record(tx,owner,v.idempotency_key,'mute',digest,applied,{target:v.target,include_descendants:v.include_descendants,muted:v.muted,expected_version:v.expected_version,result_version:(row?.version??0)+(applied?1:0)},
        {mutes:added,active,inputs:0},1);return this.result(tx,owner,d,false);
    });
  }
  lookupDismissals(actor:ActorContext,value:unknown){
    if(!Value.Check(C.DismissLookup,value))throw new PublicationError('invalid_input');const inputs=normalizeInputs(value.inputs);
    return this.run(actor,false,undefined,async(tx,owner)=>{
      const rows=await dismissalStates(tx,owner,inputs),available=this.projection==='legacy'?await this.available(tx,owner,inputs):new Map<string,boolean>();
      if(this.projection==='legacy'&&inputs.some(v=>!rows.has(inputKey(v))&&!available.get(inputKey(v))))throw new PublicationError('unavailable');
      return {items:inputs.map(v=>this.item(v,rows,available)),policy_version:(await attentionPolicy(tx,owner)).version};
    });
  }
  setDismissals(actor:ActorContext,value:unknown){
    if(!Value.Check(C.DismissUpdate,value)||Buffer.byteLength(JSON.stringify(value))>L.requestBytes)throw new PublicationError('invalid_input');
    const inputs=normalizeInputs(value.inputs),id=value.idempotency_key.toLowerCase();
    const digest=createHash('sha256').update(JSON.stringify([C.attentionContract,'dismissal',value.selection??null,inputs.map(v=>[v.kind,v.id,v.dismissed,v.expected_version])])).digest('hex');
    return this.run(actor,true,id,async(tx,owner)=>{
      const old=await this.decision(tx,owner,id);if(old){if(old.request_digest!==digest)throw new PublicationError('idempotency_conflict');return this.result(tx,owner,old,true);}
      const policy=await attentionPolicy(tx,owner);let selectedPolicy=policy.version;
      if(value.selection){
        const selected=await open(tx,value.selection),instance=(await tx.query<{instance_id:string}>('SELECT instance_id FROM loom.community_settings WHERE id=1',[])).rows[0]!.instance_id;
        if(selected.purpose!=='dismissal-selection-1'||selected.owner!==owner||selected.instance!==instance||
          JSON.stringify(selected.inputs)!==JSON.stringify(inputs.map(v=>({kind:v.kind,id:v.id,version:v.expected_version}))))throw new PublicationError('invalid_input');
        if(selected.expires<=Date.now())throw new AttentionError('attention_selection_expired');selectedPolicy=selected.policy;
      }
      const rows=await dismissalStates(tx,owner,inputs),required=inputs.filter(v=>v.dismissed||!rows.has(inputKey(v))),
        available=this.projection==='private'&&!required.length?new Map<string,boolean>():await this.available(tx,owner,this.projection==='private'?required:inputs);
      if(inputs.some(v=>!available.get(inputKey(v))&&(v.dismissed||!rows.has(inputKey(v)))))throw new PublicationError('unavailable');
      const applied=selectedPolicy===policy.version&&inputs.every(v=>v.expected_version===(rows.get(inputKey(v))?.version??0));
      const q=await this.quota(tx,owner,inputs.length),added=applied?inputs.filter(v=>!rows.has(inputKey(v))).length:0;
      if(q.inputs+added>L.inputs||applied&&inputs.some(v=>(rows.get(inputKey(v))?.version??0)>=2147483646))throw new AttentionError('attention_limit_reached');
      if(applied)for(const v of inputs)await tx.query(`INSERT INTO loom.attention_dismissals(participant_id,input_kind,input_id,dismissed,version)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(participant_id,input_kind,input_id) DO UPDATE SET dismissed=EXCLUDED.dismissed,version=EXCLUDED.version`,[owner,v.kind,v.id,v.dismissed,(rows.get(inputKey(v))?.version??0)+1]);
      const d=await this.record(tx,owner,id,'dismissal',digest,applied,{inputs:inputs.map(v=>({...v,result_version:(rows.get(inputKey(v))?.version??0)+(applied?1:0)}))},{mutes:0,active:0,inputs:added},inputs.length);
      return this.result(tx,owner,d,false);
    });
  }
  status(actor:ActorContext,value:unknown){
    if(!Value.Check(C.AttentionStatusInput,value))throw new PublicationError('invalid_input');const id=value.idempotency_key.toLowerCase();
    return this.run(actor,false,id,async(tx,owner)=>{const d=await this.decision(tx,owner,id);return d?this.result(tx,owner,d,true):{operation_state:'not_recorded' as const};});
  }
  list(actor:ActorContext,value:unknown){
    if(!Value.Check(C.AttentionListInput,value))throw new PublicationError('invalid_input');
    return this.run(actor,false,undefined,async(tx,owner)=>{
      const policy=await attentionPolicy(tx,owner),limit=value.limit??12,budget=value.max_response_bytes??L.responseBytes;let after='';
      if(value.cursor){const c=await open(tx,value.cursor);if(c.purpose!=='attention-list-1'||c.owner!==owner||c.collection!==value.collection)throw new PublicationError('invalid_input');
        if(c.version!==policy.version)throw new AttentionError('attention_collection_changed');after=c.after;}
      const mutes=value.collection==='mutes'?(await tx.query<MuteRow>(`SELECT * FROM loom.attention_mutes WHERE participant_id=$1 AND muted
        AND target_kind||':'||resource_id::text>$2 ORDER BY target_kind,resource_id LIMIT $3`,[owner,after,limit+1])).rows:[];
      const rows=value.collection==='dismissals'?(await tx.query<DismissRow>(`SELECT * FROM loom.attention_dismissals WHERE participant_id=$1 AND dismissed
        AND input_kind||':'||input_id::text>$2 ORDER BY input_kind,input_id LIMIT $3`,[owner,after,limit+1])).rows:[];
      const page:Omit<P.AttentionListView,'mutes'|'dismissals'>&{mutes:Mute<M>[];dismissals:Dismiss<M>[]}={collection:value.collection,mutes:[],dismissals:[],policy_version:policy.version,next_cursor:null,complete:false};
      if(this.projection==='legacy')await lockReferencePlan(tx,mutes.slice(0,limit).map(v=>v.resource_id));
      const inputs=rows.slice(0,limit).map(v=>({kind:v.input_kind,id:v.input_id})),states=await dismissalStates(tx,owner,inputs),available=this.projection==='legacy'?await this.available(tx,owner,inputs):new Map<string,boolean>();
      let consumed=0;
      for(let i=0;i<Math.min(limit,mutes.length+rows.length);i++){
        const m=mutes[i],r=rows[i];
        const item=m?await this.muteView(tx,owner,{kind:m.target_kind,resource_id:m.resource_id},m):this.item(inputs[i]!,states,available);
        const size=Buffer.byteLength(JSON.stringify(page))+Buffer.byteLength(JSON.stringify(item))+1024;
        if(size>budget){if(!consumed)throw new RetrievalError('response_budget_too_small');break;}
        if(m){page.mutes.push(item as Mute<M>);after=m.target_kind+':'+m.resource_id;}else{page.dismissals.push(item as Dismiss<M>);after=r!.input_kind+':'+r!.input_id;}consumed++;
      }
      page.complete=consumed===mutes.length+rows.length;
      if(!page.complete)page.next_cursor=await seal(tx,{purpose:'attention-list-1',owner,collection:value.collection,version:policy.version,after});
      return fit(page,budget);
    });
  }
}
