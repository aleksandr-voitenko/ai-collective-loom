import { createHash,createCipheriv,createDecipheriv,randomBytes,randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import * as C from '../../../contracts/following.js';
import * as P from '../../../contracts/private-controls.js';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import { lockAttempt } from '../../application/attempt.js';
import { identityOf,type ActorContext } from '../publication/actor.js';
import { lockActor } from '../publication/guards.js';
import { PublicationError } from '../publication/errors.js';
import { fit,responseBudget,type PageOptions,RetrievalError } from '../participation/retrieval.js';
import { lockReferencePlan } from '../participation/reference-context.js';
import { FollowingError,followingOwner,followSource,runFollowing,unavailable,type Authority } from './context.js';

type Row={id:string;participant_id:string;target_kind:C.FollowTargetView['kind'];resource_id:string;following:boolean;version:number;
  include_descendants:boolean;preferences:C.FollowSettingsView['preferences']};
type Decision={id:string;target_id:string;request_digest:string;desired_following:boolean;include_descendants:boolean;
  preferences:C.FollowSettingsView['preferences'];expected_version:number;result_version:number;decision:'applied'|'version_conflict'};
export function normalizeSettings(input:C.FollowSettingsView):C.FollowSettingsView{
  if(!Value.Check(C.FollowSettings,input)||input.target.kind!=='area'&&input.include_descendants)throw new PublicationError('invalid_input');
  return {target:{kind:input.target.kind,resource_id:input.target.resource_id.toLowerCase()},include_descendants:input.include_descendants,
    preferences:C.eventPreferences.filter(p=>input.preferences.includes(p))};
}
function definition(row:Row):C.BoundDefinitionView{return {target:{kind:row.target_kind,resource_id:row.resource_id},
  include_descendants:row.include_descendants,preferences:row.preferences,version:row.version};}
export async function followingDefinitions(tx:SqlTransaction,owner:string){
  const rows=(await tx.query<Row>('SELECT * FROM loom.following_targets WHERE participant_id=$1 AND following ORDER BY target_kind,resource_id LIMIT 65',[owner])).rows;
  if(rows.length>C.followingLimits.active)throw new FollowingError('following_limit_reached');
  return rows.map(definition);
}
type Item<M extends P.Projection>=P.Projected<M,C.FollowItemView,P.FollowItemView>;
type Result<M extends P.Projection>=P.Projected<M,C.FollowResultView,P.FollowResultView>;
type Page<M extends P.Projection>=P.Projected<M,C.FollowPageView,P.FollowPageView>;
export class Following<M extends P.Projection='legacy'> {
  private readonly key=randomBytes(32);
  constructor(private readonly database:Transactions,private readonly projection:M='legacy' as M){}
  private find(tx:SqlTransaction,owner:string,target:C.FollowTargetView){return tx.query<Row>(
    'SELECT * FROM loom.following_targets WHERE participant_id=$1 AND target_kind=$2 AND resource_id=$3',[owner,target.kind,target.resource_id]).then(r=>r.rows[0]);}
  private decision(tx:SqlTransaction,owner:string,key:string){return tx.query<Decision>(
    'SELECT * FROM loom.following_operations WHERE participant_id=$1 AND idempotency_key=$2',[owner,key]).then(r=>r.rows[0]);}
  private async view(tx:SqlTransaction,row:Row):Promise<Item<M>>{
    const {version,...settings}=definition(row);
    const current={...settings,version,following:row.following};
    if(this.projection==='private')return current as Item<M>;
    let source:C.FollowSourceView={state:'unavailable'};
    try{source=await followSource(tx,settings.target);}catch(error){if(!unavailable(error))throw error;}
    return {...current,source} as Item<M>;
  }
  private async result(tx:SqlTransaction,actor:Authority,decision:Decision,replayed:boolean):Promise<Result<M>>{
    const row=(await tx.query<Row>('SELECT * FROM loom.following_targets WHERE participant_id=$1 AND id=$2',[actor.participantId,decision.target_id])).rows[0]!;
    if(this.projection==='legacy')await lockReferencePlan(tx,[row.resource_id]);
    return fit({operation_state:decision.decision,operation_id:decision.id,idempotency:replayed?'replayed':'created',
      outcome:{target:definition(row).target,following:decision.desired_following,include_descendants:decision.include_descendants,
        preferences:decision.preferences,expected_version:decision.expected_version,result_version:decision.result_version},current:await this.view(tx,row)},131072) as Result<M>;
  }
  lookup(context:ActorContext,value:unknown){
    if(!Value.Check(C.FollowTarget,value))throw new PublicationError('invalid_input');
    const target={...value,resource_id:value.resource_id.toLowerCase()};
    return runFollowing(this.database,async tx=>{
      const actor=await lockActor(tx,context);await followingOwner(tx,actor.participantId);
      if(this.projection==='legacy')await lockReferencePlan(tx,[target.resource_id]);
      const row=await this.find(tx,actor.participantId,target);
      if(row)return this.view(tx,row);
      const current={target,following:false,version:0,include_descendants:false,preferences:[...C.eventPreferences]};
      return (this.projection==='private'?current:{...current,source:await followSource(tx,target)}) as Item<M>;
    },true);
  }
  update(context:ActorContext,value:unknown){
    if(!Value.Check(C.FollowUpdate,value))throw new PublicationError('invalid_input');
    const settings=normalizeSettings({target:value.target,include_descendants:value.include_descendants,preferences:value.preferences});
    const key=value.idempotency_key.toLowerCase(),digest=createHash('sha256').update(JSON.stringify(['following-state-v1',settings,value.following,value.expected_version])).digest('hex');
    return runFollowing(this.database,async tx=>{
      await lockAttempt(tx,identityOf(context).participantId,'following.set',key);
      const actor=await lockActor(tx,context);await followingOwner(tx,actor.participantId,true);
      const old=await this.decision(tx,actor.participantId,key);
      if(old){if(old.request_digest!==digest)throw new PublicationError('idempotency_conflict');return this.result(tx,actor,old,true);}
      const count=(await tx.query<{n:number}>('SELECT count(*)::int AS n FROM (SELECT 1 FROM loom.following_operations WHERE participant_id=$1 LIMIT 10000) q',[actor.participantId])).rows[0]!.n;
      if(count>=C.followingLimits.operations)throw new FollowingError('following_limit_reached');
      let row=await this.find(tx,actor.participantId,settings.target);
      if(this.projection==='legacy'||value.following||!row)await lockReferencePlan(tx,[settings.target.resource_id]);
      if(value.following||!row)await followSource(tx,settings.target);
      if(!row){
        const count=(await tx.query<{n:number}>('SELECT count(*)::int AS n FROM (SELECT 1 FROM loom.following_targets WHERE participant_id=$1 LIMIT 500) q',[actor.participantId])).rows[0]!.n;
        if(count>=C.followingLimits.targets)throw new FollowingError('following_limit_reached');
        row=(await tx.query<Row>(`INSERT INTO loom.following_targets(id,participant_id,target_kind,resource_id,preferences)
          VALUES($1,$2,$3,$4,$5) RETURNING *`,[randomUUID(),actor.participantId,settings.target.kind,settings.target.resource_id,settings.preferences])).rows[0]!;
      }
      const decision=row.version===value.expected_version?'applied':'version_conflict';
      if(decision==='applied'){
        if(row.version>=2147483646)throw new FollowingError('following_limit_reached');
        if(value.following&&!row.following&&(await followingDefinitions(tx,actor.participantId)).length>=C.followingLimits.active)throw new FollowingError('following_limit_reached');
        row=(await tx.query<Row>(`UPDATE loom.following_targets SET following=$3,include_descendants=$4,preferences=$5,version=version+1
          WHERE participant_id=$1 AND id=$2 RETURNING *`,[actor.participantId,row.id,value.following,settings.include_descendants,settings.preferences])).rows[0]!;
        await tx.query(`INSERT INTO loom.following_collections(participant_id,version) VALUES($1,1)
          ON CONFLICT(participant_id) DO UPDATE SET version=loom.following_collections.version+1`,[actor.participantId]);
      }
      const result=(await tx.query<Decision>(`INSERT INTO loom.following_operations(id,participant_id,idempotency_key,target_id,request_digest,
        desired_following,include_descendants,preferences,expected_version,result_version,decision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [randomUUID(),actor.participantId,key,row.id,digest,value.following,settings.include_descendants,settings.preferences,value.expected_version,row.version,decision])).rows[0]!;
      return this.result(tx,actor,result,false);
    });
  }
  reconcile(context:ActorContext,key:string){return runFollowing(this.database,async tx=>{
    await lockAttempt(tx,identityOf(context).participantId,'following.set',key.toLowerCase());
    const actor=await lockActor(tx,context);await followingOwner(tx,actor.participantId);
    const decision=await this.decision(tx,actor.participantId,key.toLowerCase());
    return decision?this.result(tx,actor,decision,true):{operation_state:'not_recorded' as const};
  });}
  list(context:ActorContext,options:PageOptions):Promise<Page<M>>{return runFollowing(this.database,async tx=>{
    const actor=await lockActor(tx,context);await followingOwner(tx,actor.participantId);
    const version=(await tx.query<{version:number}>('SELECT version FROM loom.following_collections WHERE participant_id=$1 FOR SHARE',[actor.participantId])).rows[0]?.version??0;
    let after:string|null=null;
    if(options.cursor){
      let saved:{owner:string;version:number;after:string};
      try{const bytes=Buffer.from(options.cursor,'base64url'),cipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));
        saved=JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString());
        if(saved.owner!==actor.participantId||!Number.isInteger(saved.version)||!/^[a-f0-9-]{36}$/.test(saved.after))throw new Error();
      }catch{throw new RetrievalError('invalid_cursor');}
      if(saved.version!==version)throw new FollowingError('following_collection_changed');after=saved.after;
    }
    const limit=Number(options.limit??12),budget=responseBudget(options.max_response_bytes);
    if(!Number.isInteger(limit)||limit<1||limit>25)throw new PublicationError('invalid_input');
    const rows=(await tx.query<Row>('SELECT * FROM loom.following_targets WHERE participant_id=$1 AND following AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[actor.participantId,after,limit+1])).rows;
    if(this.projection==='legacy')await lockReferencePlan(tx,rows.slice(0,limit).map(r=>r.resource_id));
    const page:Omit<P.FollowPageView,'items'>&{items:Item<M>[]}={items:[],next_cursor:null,complete:false,collection_version:version,ordering:'stable_target_id',limit,max_response_bytes:budget};
    for(const row of rows.slice(0,limit)){
      const item=await this.view(tx,row);
      if(Buffer.byteLength(JSON.stringify({...page,items:[...page.items,item]}))+512>budget){if(!page.items.length)throw new RetrievalError('response_budget_too_small');break;}
      page.items.push(item);
    }
    page.complete=page.items.length===rows.length;
    if(!page.complete){
      const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);
      const bytes=Buffer.concat([cipher.update(JSON.stringify({owner:actor.participantId,version,after:rows[page.items.length-1]!.id})),cipher.final()]);
      page.next_cursor=Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64url');
    }
    return fit(page,budget) as Page<M>;
  },true);}
}
