import { createCipheriv,createDecipheriv,randomBytes,randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import * as C from '../../../contracts/following.js';
import type { SqlTransaction } from '../../db/postgres.js';
import type { ActorContext } from '../publication/actor.js';
import { lockActor,lockContext,requireRevision,type Transactions } from '../publication/publication.js';
import { PublicationError } from '../publication/errors.js';
import { fit,RetrievalError } from '../participation/retrieval.js';
import { lockReferencePlan } from '../participation/reference-context.js';
import { followingDefinitions,normalizeSettings } from './subscriptions.js';
import { FollowingError,followingOwner,followSource,runFollowing,unavailable } from './context.js';

type State={cursor_key:Buffer;recovery_epoch:string;instance_id:string;visibility:string;retained_after:string;position:string};
type Descriptor={purpose:'shared-changes-1';v:1;owner:string;instance:string;epoch:string;visibility:string;
  kind:'traversal'|'checkpoint';scope:'following'|'explicit';definitions:C.BoundDefinitionView[];
  id:string;lower:string;upper:string;after:string;expires:number;unknown:boolean;history:'retained'|'incomplete';baseline:boolean};
type Candidate={id:string;position:string;kind:string;resource_id:string;revision_id:string|null;publisher_id:string;created_at:Date;
  area_scope_ids:string[];before_area_scope_ids:string[]|null;after_area_scope_ids:string[]|null;affected_target_ids:string[]|null;
  resource_kind:string;discussion_id:string|null;parent_id:string|null;revision_number:string|null;content_format:string|null;
  actor_kind:string;nickname:string;typed:boolean;note:boolean;operation_kind:string|null};
// Untyped retained work still has canonical ownership. Preserve that scope for
// unknown-coverage decisions; missing companion rows do not classify it as typed.
const candidatesSql=`SELECT e.*,e.position::text,r.kind AS resource_kind,v.revision_number::text,v.content_format,
  COALESCE(c.discussion_id,s.discussion_id,CASE WHEN r.kind IN ('contribution','summary') THEN r.owner_resource_id END) AS discussion_id,
  c.parent_id,p.kind AS actor_kind,p.nickname,
  (c.id IS NOT NULL OR a.id IS NOT NULL OR s.id IS NOT NULL OR ar.id IS NOT NULL OR d.id IS NOT NULL) AS typed,
  EXISTS(SELECT 1 FROM loom.revision_change_notes n WHERE n.revision_id=e.revision_id) AS note,o.operation_kind
  FROM loom.shared_activity e JOIN loom.resources r ON r.id=e.resource_id JOIN loom.participants p ON p.id=e.publisher_id
  LEFT JOIN loom.revisions v ON v.id=e.revision_id LEFT JOIN loom.contributions c ON c.id=r.id
  LEFT JOIN loom.artifacts a ON a.id=r.id LEFT JOIN loom.summaries s ON s.id=r.id
  LEFT JOIN loom.areas ar ON ar.id=r.id LEFT JOIN loom.discussions d ON d.id=r.id
  LEFT JOIN loom.organization_operations o ON o.source_event_id=e.id`;

function categories(row:Candidate):C.FollowSettingsView['preferences']|undefined{
  if(!row.typed)return;
  if(row.kind==='organization.changed')return ['structural'];
  if(row.kind!=='revision.published'||!['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3'].includes(row.content_format??''))return;
  const category=row.resource_kind==='artifact'?'artifact_revisions':row.resource_kind==='summary'?'summaries':
    row.resource_kind==='contribution'?(row.parent_id?'replies':row.revision_number==='1'?'new_discussions':'discussion_edits'):undefined;
  return category?[category,...(row.note?['change_notes' as const]:[])]:undefined;
}
function matches(row:Candidate,definitions:C.BoundDefinitionView[]){
  const kinds=categories(row),reasons:C.MatchReasonView[]=[];
  let unknown=false;
  definitions.forEach((definition,index)=>{
    const {target,include_descendants,preferences}=definition;
    const selected=kinds?preferences.filter(p=>kinds.includes(p)):preferences;
    if(!selected.length)return;
    let relevance:C.MatchReasonView['relevance']|undefined;
    if(row.kind==='organization.changed'){
      if(target.resource_id===row.resource_id)relevance='direct_target';
      else if(target.kind==='area'&&[row.before_area_scope_ids??[],row.after_area_scope_ids??[]].some(ids=>
        include_descendants?ids.includes(target.resource_id):ids[row.resource_kind==='area'?1:0]===target.resource_id))relevance='structural_before_after';
      else if(row.affected_target_ids?.includes(target.resource_id))relevance='ancestor_impact';
      // Older area events cannot establish whether an otherwise unmatched target
      // was below the changed ancestor. Current ancestry cannot fill that gap.
      else if(row.resource_kind==='area'&&row.affected_target_ids===null)unknown=true;
    }else{
      if(target.kind==='area'&&(include_descendants?row.area_scope_ids.includes(target.resource_id):row.area_scope_ids[0]===target.resource_id))relevance='event_time_area';
      else if(target.kind==='discussion'&&target.resource_id===row.discussion_id||target.kind==='artifact'&&target.resource_id===row.resource_id)relevance='direct_target';
    }
    if(relevance){if(kinds)reasons.push({definition:index,target,preferences:selected,relevance});else unknown=true;}
  });
  return {reasons,unknown};
}

export class SharedChanges {
  constructor(private readonly database:Transactions){}
  private state(tx:SqlTransaction){return tx.query<State>(`SELECT s.cursor_key,s.recovery_epoch,s.visibility_version::text AS visibility,
    s.retained_after::text,c.instance_id,k.shared_position::text AS position FROM loom.shared_retrieval_state s
    CROSS JOIN loom.community_settings c CROSS JOIN loom.community_clocks k WHERE s.id=1 AND c.id=1 AND k.id=1`,[]).then(r=>r.rows[0]!);}
  private encode(state:State,bound:Descriptor){
    // Compact tuples keep all 64 frozen definitions within the token bound without
    // retaining a mutable server cursor registry or dropping subscription choices.
    const {definitions,...rest}=bound;
    const d=definitions.map(v=>[v.target.kind,v.target.resource_id,v.include_descendants?1:0,
      C.eventPreferences.reduce((mask,p,i)=>mask+(v.preferences.includes(p)?2**i:0),0),v.version]);
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',state.cursor_key,nonce);
    cipher.setAAD(Buffer.from(C.sharedContract));
    const bytes=Buffer.concat([cipher.update(JSON.stringify({...rest,d})),cipher.final()]);
    const token=Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64url');
    if(Buffer.byteLength(token)>C.followingLimits.tokenBytes)throw new FollowingError('shared_work_limit');
    return token;
  }
  private decode(state:State,token:string,owner:string):Descriptor{
    let bound:Descriptor;
    try{
      if(Buffer.byteLength(token)>C.followingLimits.tokenBytes)throw new Error();
      const bytes=Buffer.from(token,'base64url'),cipher=createDecipheriv('aes-256-gcm',state.cursor_key,bytes.subarray(0,12));
      cipher.setAAD(Buffer.from(C.sharedContract));cipher.setAuthTag(bytes.subarray(12,28));
      const raw=JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString());
      const {d,...rest}=raw;
      if(!Array.isArray(d)||d.length>64)throw new Error();
      bound={...rest,definitions:d.map(([kind,id,desc,mask,version]:[string,string,number,number,number])=>{
        if(!Number.isInteger(mask)||mask<1||mask>127||![0,1].includes(desc))throw new Error();
        return {target:{kind,resource_id:id},include_descendants:desc===1,preferences:C.eventPreferences.filter((_,i)=>mask&2**i),version};
      })};
      if(bound.purpose!==C.sharedContract||bound.v!==1||bound.owner!==owner||bound.instance!==state.instance_id||
        !['following','explicit'].includes(bound.scope)||!['traversal','checkpoint'].includes(bound.kind)||
        !bound.definitions.every(d=>Value.Check(C.BoundDefinition,d))||
        ![bound.lower,bound.upper,bound.after].every(v=>/^\d{1,19}$/.test(v))||BigInt(bound.lower)>BigInt(bound.after)||BigInt(bound.after)>BigInt(bound.upper)||
        !Number.isFinite(bound.expires)||typeof bound.unknown!=='boolean'||typeof bound.baseline!=='boolean'||!['retained','incomplete'].includes(bound.history))throw new Error();
    }catch{throw new FollowingError('shared_token_invalid');}
    if(bound.epoch!==state.recovery_epoch)throw new FollowingError('shared_epoch_changed');
    return bound;
  }
  private checkContinuity(state:State,saved:Descriptor,action?:string){
    // Controls precede ordinary selectors, including structural-event preferences.
    if(saved.visibility!==state.visibility&&!['replay','resynchronize'].includes(action??''))throw new FollowingError('shared_visibility_replay_required');
    // Replay must reach behind a completed lower bound. A floor can erase that
    // older history even when the checkpoint's upper boundary is still retained.
    if(action==='replay'&&BigInt(state.retained_after)>0n)throw new FollowingError('shared_history_gap');
    if((BigInt(saved.kind==='checkpoint'?saved.upper:saved.lower)<BigInt(state.retained_after)||BigInt(saved.upper)>BigInt(state.position))&&action!=='resynchronize')
      throw new FollowingError('shared_history_gap');
    if(saved.kind==='traversal'&&saved.expires<=Date.now()&&!action)throw new FollowingError('shared_descriptor_expired');
  }
  query(context:ActorContext,options:C.SharedOptions):Promise<C.SharedPageView>{
    if(!Value.Check(C.SharedQuery,options)||[options.cursor,options.checkpoint,options.recovery].filter(Boolean).length>1||
      options.recovery&&!options.recovery.token&&options.recovery.action!=='resynchronize')throw new PublicationError('invalid_input');
    return runFollowing(this.database,async tx=>{
      const actor=await lockActor(tx,context);await followingOwner(tx,actor.participantId);
      const state=await this.state(tx),token=options.cursor??options.checkpoint??options.recovery?.token;
      const saved=token?this.decode(state,token,actor.participantId):undefined,action=options.recovery?.action;
      if(saved)this.checkContinuity(state,saved,action);
      if(options.cursor&&saved?.kind!=='traversal'||options.checkpoint&&saved?.kind!=='checkpoint'||action==='renew'&&saved?.kind!=='traversal')throw new FollowingError('shared_token_invalid');
      const scope=saved?.scope??options.scope?.kind??'following';
      if(options.scope&&saved&&(options.scope.kind!==saved.scope||options.scope.kind==='explicit'&&
        JSON.stringify(normalizeSettings(options.scope.definition))!==JSON.stringify(this.settings(saved.definitions[0]!))))throw new FollowingError('shared_token_invalid');
      const current=scope==='following'?await followingDefinitions(tx,actor.participantId):undefined;
      const definitions=saved?.definitions??current??[{...normalizeSettings((options.scope as Extract<C.SharedScopeView,{kind:'explicit'}>).definition),version:0}];
      const settingsCurrent=!current||JSON.stringify(current)===JSON.stringify(definitions);
      if(saved?.kind==='checkpoint'&&!settingsCurrent)throw new FollowingError('shared_definition_changed');
      if(!saved&&BigInt(state.retained_after)>0n&&action!=='resynchronize')throw new FollowingError('shared_history_gap');
      const replay=action==='replay',resync=action==='resynchronize';
      const lower=resync?state.position:replay?state.retained_after:saved?.kind==='checkpoint'?saved.upper:saved?.lower??'0';
      const bound:Descriptor=saved?.kind==='traversal'&&!replay&&!resync?{...saved,expires:action==='renew'?Date.now()+86400000:saved.expires}:{
        purpose:C.sharedContract,v:1,owner:actor.participantId,instance:state.instance_id,epoch:state.recovery_epoch,visibility:state.visibility,
        scope,definitions,id:randomUUID(),kind:'traversal',lower,upper:state.position,after:lower,expires:Date.now()+86400000,
        unknown:false,history:resync||saved?.history==='incomplete'?'incomplete':'retained',baseline:resync};
      const candidates=bound.baseline||!definitions.length?[]:(await tx.query<Candidate>(`${candidatesSql}
        WHERE e.position>$1 AND e.position<=$2 ORDER BY e.position LIMIT 101`,[bound.after,bound.upper])).rows;
      await lockReferencePlan(tx,[...definitions.map(d=>d.target.resource_id),...candidates.slice(0,100).flatMap(r=>[r.resource_id,...(r.discussion_id?[r.discussion_id]:[])])]);
      if(!saved&&scope==='explicit')await followSource(tx,definitions[0]!.target);
      const limit=options.limit??12,budget=options.max_response_bytes??131072;
      const page:C.SharedPageView={contract_version:C.sharedContract,items:[],traversal:{id:bound.id,scope,definitions,settings_current:settingsCurrent,
        selection:'complete',grouping:'none',order:'committed_event_ascending',boundaries:'fixed_shared_interval',history_start:'retained_history',expires_at:new Date(bound.expires).toISOString()},
        page_cursor:this.encode(state,bound),next_cursor:null,checkpoint:null,page_exhausted:false,interval_complete:false,no_subscriptions:!definitions.length,
        work_budget_reached:false,coverage:bound.unknown?'unknown':'known',coverage_limit:bound.unknown?'historical_or_unsupported_facts':null,
        recovery:action==='renew'?'renewed':replay?'visibility_replay':resync?'retained_resynchronization':'none',history:bound.history,
        baseline_established:bound.baseline,inventory:bound.baseline?this.inventory(definitions):[],omitted_detail:'full_bodies',limit,max_response_bytes:budget};
      let last=bound.after,consumed=0,unknown=bound.unknown;
      for(const row of candidates.slice(0,100)){
        let item:C.SharedItemView|undefined,uncertain=false;
        if(row.actor_kind!=='internal')try{
          await lockContext(tx,row.resource_id,'resolution',['area','discussion','contribution','artifact','summary']);
          if(row.revision_id)await requireRevision(tx,row.resource_id,row.revision_id);
          const match=matches(row,definitions);uncertain=match.unknown;
          if(match.reasons.length)item=await this.item(tx,row,match.reasons);
        }catch(error){if(!unavailable(error))throw error;}
        if(item){
          const preview={...page,items:[...page.items,item],next_cursor:this.encode(state,{...bound,after:row.position,unknown:unknown||uncertain})};
          const bytes=Buffer.byteLength(JSON.stringify(preview))+128;
          if(page.items.length===limit||bytes>budget){if(!page.items.length)throw new RetrievalError('response_budget_too_small',bytes);break;}
          page.items.push(item);
        }
        unknown ||= uncertain;consumed++;last=row.position;
      }
      page.page_exhausted=consumed===candidates.length;
      page.coverage=unknown?'unknown':'known';page.coverage_limit=unknown?'historical_or_unsupported_facts':null;
      page.interval_complete=page.page_exhausted&&!unknown&&!bound.baseline&&definitions.length>0;
      page.work_budget_reached=!page.page_exhausted&&consumed===100;
      if(page.interval_complete||bound.baseline)page.checkpoint=this.encode(state,{...bound,kind:'checkpoint',after:bound.upper,expires:0,baseline:false});
      else if(!page.page_exhausted)page.next_cursor=this.encode(state,{...bound,after:last,unknown});
      return fit(page,budget);
    },true);
  }
  private settings(definition:C.BoundDefinitionView):C.FollowSettingsView{const {version:_,...settings}=definition;return settings;}
  private inventory(definitions:C.BoundDefinitionView[]):C.SharedPageView['inventory']{
    return definitions.flatMap(d=>d.target.kind==='area'?[
      {label:'Current discussions in selected topic',url:`/api/v1/areas/${d.target.resource_id}/discussions`},
      {label:'Current artifacts in selected topic',url:`/api/v1/areas/${d.target.resource_id}/artifacts`},
      ...(d.include_descendants?[{label:'Subtopics: repeat inventory for each selected descendant',url:`/api/v1/organization/children?parent_id=${d.target.resource_id}`}]:[]),
    ]:d.target.kind==='discussion'?[{label:'Discussion opening and bounded branch inventory',url:`/api/v1/discussions/${d.target.resource_id}`}]:
      [{label:'Retained artifact revisions',url:`/api/v1/resources/${d.target.resource_id}/history`}]);
  }
  private async item(tx:SqlTransaction,row:Candidate,reasons:C.MatchReasonView[],offset=0):Promise<C.SharedItemView>{
    await lockContext(tx,row.resource_id,'resolution',['area','discussion','contribution','artifact','summary']);
    if(row.revision_id)await requireRevision(tx,row.resource_id,row.revision_id);
    const target:C.FollowTargetView=row.discussion_id?{kind:'discussion',resource_id:row.discussion_id}:{kind:row.resource_kind as C.FollowTargetView['kind'],resource_id:row.resource_id};
    const current=await followSource(tx,target);
    const contextUrl=current.state==='available'?current.browser_url:target.kind==='area'?`/loom/area/${target.resource_id}`:`/loom/resource/${target.resource_id}`;
    const exact=row.revision_id?`/loom/resource/${row.resource_id}/${row.revision_id}`:null;
    const full=row.revision_id?`/api/v1/resources/${row.resource_id}/revisions/${row.revision_id}`:null;
    const more=offset+8<reasons.length;
    return {event_id:row.id,kind:row.kind==='organization.changed'?row.operation_kind??'organization.changed':
      row.resource_kind==='contribution'?(row.parent_id?'reply':'opening')+(row.revision_number==='1'?'.published':'.revised'):row.resource_kind+'.published',
      resource_id:row.resource_id,discussion_id:row.discussion_id,revision_id:row.revision_id,revision_number:row.revision_number,
      actor:{id:row.publisher_id,nickname:row.nickname,kind:row.actor_kind},occurred_at:row.created_at.toISOString(),current,
      exact_url:exact,context_url:row.discussion_id?contextUrl+`?focus=${row.resource_id}`:contextUrl,full_content_url:full,
      change_note_url:row.note?full+'/change-note':null,reasons:reasons.slice(offset,offset+8),reasons_complete:!more,
      detail_url:'/api/v1/shared-changes/detail',next_reason:more?offset+8:null};
  }
  detail(context:ActorContext,input:StaticDetail){return runFollowing(this.database,async tx=>{
    if(!Value.Check(C.SharedDetailInput,input))throw new PublicationError('invalid_input');
    const actor=await lockActor(tx,context),state=await this.state(tx),bound=this.decode(state,input.cursor,actor.participantId);
    if(bound.kind!=='traversal')throw new FollowingError('shared_token_invalid');
    this.checkContinuity(state,bound);
    const row=(await tx.query<Candidate>(`${candidatesSql} WHERE e.id=$1 AND e.position>$2 AND e.position<=$3`,[input.event_id,bound.lower,bound.upper])).rows[0];
    if(!row||!row.typed||row.actor_kind==='internal')throw new PublicationError('unavailable');
    await lockReferencePlan(tx,[row.resource_id,...(row.discussion_id?[row.discussion_id]:[])]);
    const reasons=matches(row,bound.definitions).reasons;
    if(!reasons.length)throw new PublicationError('unavailable');
    return fit(await this.item(tx,row,reasons,input.reason_offset??0),input.max_response_bytes??131072);
  },true);}
}
type StaticDetail={cursor:string;event_id:string;reason_offset?:number;max_response_bytes?:number};
