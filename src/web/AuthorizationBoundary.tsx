import { createContext, useContext, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ApiError, transportRequest, type RequestOptions, type Self } from './participation-client.js';
import * as A from '../contracts/attention.js';
import * as F from '../contracts/following.js';
import * as P from '../contracts/private-controls.js';
import * as O from '../contracts/organization.js';
import * as S from '../contracts/saved-items.js';
import * as M from '../contracts/moderation.js';
import { contentKey,type ContentRequest,type ContentRegion } from './protected-content.js';
import {identityContent} from './authorization-coordinator.js';
import {responseContract} from './response-contracts.js';
import type { AttentionCommandView } from './attention-recovery.js';

export type AuthorizedValue<T> = { value:T; generation?:number|undefined };
export type FollowingSettings = P.FollowItemView;
export type FollowingItem = { settings:FollowingSettings; preview?:{generation:number} };
export type FollowingCollection = Omit<F.FollowPageView,'items'> & {items:FollowingItem[]};
type FollowingStatus = P.FollowResultView | {operation_state:'not_recorded'};
const stale = () => new DOMException('View authorization changed.','AbortError');
function followingSettings(item:F.FollowItemView|P.FollowItemView):P.FollowItemView{
  const {target,include_descendants,preferences,following,version}=item;return {target,include_descendants,preferences,following,version};
}
function muteSettings(item:A.MuteItemView|P.MuteItemView):P.MuteItemView{
  const {target,include_descendants,muted,version}=item;return {target,include_descendants,muted,version};
}
function dismissSettings(item:A.DismissItemView|P.DismissItemView):P.DismissItemView{
  const {kind,id,dismissed,version}=item;return {kind,id,dismissed,version};
}
function privateResult(value:A.AttentionStatusView|P.AttentionStatusView):P.AttentionStatusView{
  if(value.operation_state==='not_recorded')return value;
  return value.kind==='mute'?{...value,current:muteSettings(value.current)}:{...value,current:value.current.map(dismissSettings)};
}

// Adapters distinguish private receipts from protected observations explicitly.
// The coordinator outlives React retries and retains every outstanding request.
class ViewAuthorization {
  private live=true;
  private privateReads=new Map<string,object>();
  constructor(readonly sourcePolicy:'withdraw'|'settings'|'projections',readonly region:ContentRegion){}
  subscribe=(listener:()=>void)=>this.region.subscribe(listener);
  getSnapshot=()=>this.region.getSnapshot();
  activate(){this.live=true;this.region.mount();}
  dispose(){this.live=false;this.region.unmount();}
  active=()=>this.live&&this.region.coordinator.current()&&this.region.snapshot.state!=='owner-invalid'&&
    !(this.sourcePolicy!=='settings'&&this.region.snapshot.state==='withdrawn');
  capture=()=>this.region.snapshot.generation;
  current=(generation:number|undefined)=>this.active()&&this.region.current(generation);
  identityChanged=()=>{if(!this.region.coordinator.current()&&this.region.snapshot.state!=='owner-invalid')this.region.invalidate(new ApiError('unauthenticated','Identity changed. Reopen this view after signing in.'));};
  // A projection consumer must gate every rendered field with the returned
  // generation, including after local persistence. It may retain private state.
  async readProjection<T>(path:string,options:RequestOptions={}):Promise<AuthorizedValue<T>>{
    if(this.sourcePolicy==='withdraw')throw new Error('Response projections require a lease-aware rendering host.');
    return this.readAuthorized<T>(path,options,true);
  }
  async readAuthorized<T>(path:string,options:RequestOptions={},projection=false):Promise<AuthorizedValue<T>>{
    if(!this.active())throw stale();
    const contract=responseContract(path,options.body===undefined?'GET':'POST');
    if(!['read','session'].includes(contract.access))throw new Error('This endpoint requires its explicit private or command capability.');
    const target=contract.preview==='mute'||contract.preview==='follow'?options.body as F.FollowTargetView:undefined;
    const key=target?(contract.preview==='mute'?'mute:':'follow:')+contentKey(target):undefined,attempt={};
    const targets=target?[target]:contract.preview==='previews'?(options.body as P.PreviewQueryView).targets:[];
    const ticket=this.region.coordinator.begin(this.region,targets.map(contentKey));
    if(key)this.privateReads.set(key,attempt);
    const latest=()=>this.live&&(!key||this.privateReads.get(key)===attempt);
    try{
      const response=await transportRequest<T>(path,options);
      const {value,observation}=response;
      const fresh=this.current(ticket.generation)&&latest(),items=observation.previews;
      let generation=fresh?ticket.generation:undefined;
      const partial=this.sourcePolicy!=='withdraw'&&(projection||this.sourcePolicy==='settings'&&['attention-list','follow-page','previews'].includes(contract.preview??''));
      if(items.length||observation.denied)generation=this.region.publish(ticket,items,partial,fresh,observation.denied);
      if(!latest())throw stale();
      if(!this.current(generation)){
        // Legacy callers may retain owner-private state, but never a preview.
        if(target&&this.active())return {value:{...value,source:{state:'unavailable'},...(options.schema===A.MuteItem?{other_current_scope_mutes:[]}:{})} as T};
        if(this.sourcePolicy==='settings'&&this.active()&&options.schema===A.AttentionList){
          const page=value as A.AttentionListView;
          return {value:{...page,mutes:page.mutes.map(item=>({...muteSettings(item),source:{state:'unavailable'},other_current_scope_mutes:[]})),
            dismissals:page.dismissals.map(item=>({...dismissSettings(item),availability:'unavailable'}))} as T,generation:this.capture()};
        }
        if(this.sourcePolicy==='settings'&&this.active()&&options.schema===F.FollowPage){
          const page=value as F.FollowPageView;
          return {value:{...page,items:page.items.map(item=>({...followingSettings(item),source:{state:'unavailable'}}))} as T,generation:this.capture()};
        }
        if(this.sourcePolicy==='settings'&&this.active()&&options.schema===S.SavedItem)
          return {value:{...value,source:{state:'unavailable'}} as T};
        throw stale();
      }
      return {value,generation};
    }finally{
      this.region.coordinator.finish(ticket);
      if(key&&this.privateReads.get(key)===attempt)this.privateReads.delete(key);
    }
  }
  async read<T>(path:string,options:RequestOptions={}):Promise<T>{return (await this.readAuthorized<T>(path,options)).value;}
  savedLookup(target:S.SavedTargetView,self:Self){
    return this.readAuthorized<S.SavedItemView>('/api/v1/me/saved-items/lookup',{body:target,self,schema:S.SavedItem},this.sourcePolicy==='settings');
  }
  async organizationCommand(body:unknown,action:'changes'|'status',self:Self):Promise<AuthorizedValue<O.OrganizationResult|{operation_state:'not_recorded'}>>{
    if(!this.active())throw stale();const ticket=this.region.coordinator.beginPrivate(this.region);
    try{
      const value=await this.receipt<O.OrganizationResult|{operation_state:'not_recorded'}>(ticket,'/api/v1/organization/'+action,
        {body,self,schema:action==='changes'?O.OrganizationCommitted:O.OrganizationReconciled});
      // The receipt may settle custody after withdrawal. Its current location
      // is protected and must pass this lease again after journal settlement.
      return {value,...(this.current(ticket.generation)?{generation:ticket.generation}:{})};
    }finally{this.region.coordinator.finish(ticket);}
  }
  async savedCommand(body:unknown,action:'state'|'status',self:Self):Promise<S.SavedStatusView>{
    if(!this.active())throw stale();const ticket=this.region.coordinator.beginPrivate(this.region);
    try{
      const value=await this.receipt<S.SavedStatusView>(ticket,'/api/v1/me/saved-items/'+action,
        {body,self,schema:action==='state'?S.SavedResult:S.SavedStatus});
      if(value.operation_state==='not_recorded')return value;
      // A command receipt cannot refresh a title or certify source access.
      return {...value,current:{...value.current,source:{state:'unavailable'}}};
    }finally{this.region.coordinator.finish(ticket);}
  }
  async moderationCommand(body:unknown,action:'state'|'status',self:Self):Promise<M.ModerationStatusView>{
    if(!this.active())throw stale();
    const ticket=this.region.coordinator.beginPrivate(this.region);
    try {
      // Every recorded lifecycle receipt fences older content before custody
      // settlement, including a restoration or an exact late replay.
      return await this.receipt<M.ModerationStatusView>(ticket,'/api/v1/admin/moderation/'+action,
        {body,self,schema:M.ModerationStatus});
    }finally{this.region.coordinator.finish(ticket);}
  }
  private async receipt<T>(ticket:ContentRequest,path:string,options:RequestOptions):Promise<T>{
    if(responseContract(path,'POST').access!=='boundary-receipt')throw new Error('This endpoint is not a private receipt.');
    const response=await transportRequest<T>(path,options);
    if(response.observation.denied)this.region.coordinator.deny(ticket,new ApiError('unavailable','Current source unavailable. Reauthorize the displayed view.'));
    return response.value;
  }
  async privateRead<T>(path:string,options:RequestOptions={}):Promise<T>{
    const route=path.split('?')[0];
    const allowed=options.body===undefined
      ?route==='/api/v1/me/following/private'&&options.schema===P.FollowPage
      :route==='/api/v1/me/following/private/lookup'&&options.schema===P.FollowItem||
       route==='/api/v1/me/attention/private/mutes/lookup'&&options.schema===P.MuteItem||
       route==='/api/v1/me/attention/private/list'&&options.schema===P.AttentionList;
    if(!allowed)throw new Error('Protected reads require the boundary read capability.');
    if(!this.active())throw stale();
    // Private reads have no source dependency and no metadata side effects.
    const response=await transportRequest<T>(path,options);if(!this.region.coordinator.current())throw stale();return response.value;
  }
  private previewQueue=new Map<string,{target:F.FollowTargetView;self:Self;generation:number;resolve:(v:number|undefined)=>void;reject:(e:unknown)=>void}[]>();
  private pendingPreviews=new Map<string,Promise<number|undefined>>();
  previews(targets:F.FollowTargetView[],self:Self):Promise<number|undefined>{
    this.region.previewRequested(targets.map(contentKey));
    const pending=this.readAuthorized<P.PreviewPageView>('/api/v1/me/attention/previews',{body:{targets},self,schema:P.PreviewPage}).then(result=>result.generation);
    for(const target of targets)this.pendingPreviews.set(contentKey(target),pending);
    const clear=()=>{for(const target of targets)if(this.pendingPreviews.get(contentKey(target))===pending)this.pendingPreviews.delete(contentKey(target));};
    void pending.then(clear,clear);return pending;
  }
  preview(target:F.FollowTargetView,generation:number|undefined){return this.region.preview(target,generation);}
  previewLookup(target:F.FollowTargetView,self:Self,refresh=false):Promise<number|undefined>{
    const generation=this.capture();
    if(!refresh&&this.preview(target,generation))return Promise.resolve(generation);
    if(!refresh&&this.pendingPreviews.has(contentKey(target)))return this.pendingPreviews.get(contentKey(target))!;
    if(!refresh&&this.region.hasPreviewAttempt(contentKey(target)))return Promise.resolve(undefined);
    // Only an explicit protected refresh may refill a source removed by a
    // revocation. Mounting a private recovery control is not such an action.
    if(!refresh&&generation>0&&this.region.snapshot.state!=='checking')return Promise.resolve(undefined);
    return new Promise((resolve,reject)=>{
      const key=contentKey(target),existing=this.previewQueue.get(key);
      const entry={target,self,generation,resolve,reject};
      if(existing){existing.push(entry);return;}
      this.previewQueue.set(key,[entry]);
      if(this.previewQueue.size!==1)return;
      queueMicrotask(()=>{
        const entries=[...this.previewQueue.values()];this.previewQueue.clear();
        for(let start=0;start<entries.length;start+=25){
          const batch=entries.slice(start,start+25),first=batch[0]![0]!;
          if(!this.current(first.generation)){for(const list of batch)for(const e of list)e.resolve(undefined);continue;}
          void this.previews(batch.map(list=>list[0]!.target),first.self).then(g=>{for(const list of batch)for(const e of list)e.resolve(g);},error=>{for(const list of batch)for(const e of list)e.reject(error);});
        }
      });
    });
  }
  async followingLookup(target:F.FollowTargetView,self:Self):Promise<FollowingItem>{
    const {value,generation}=await this.readAuthorized<F.FollowItemView>('/api/v1/me/following/lookup',{body:target,self,schema:F.FollowItem});
    return {settings:followingSettings(value),...(generation!==undefined?{preview:{generation}}:{})};
  }
  async followingPage(cursor?:string,signal?:AbortSignal):Promise<AuthorizedValue<FollowingCollection>>{
    const query='?limit=12'+(cursor?'&cursor='+encodeURIComponent(cursor):'');
    const {value,generation}=await this.readAuthorized<F.FollowPageView>('/api/v1/me/following'+query,{schema:F.FollowPage,...(signal?{signal}:{})});
    return {value:{...value,items:value.items.map(item=>({settings:followingSettings(item),...(generation!==undefined?{preview:{generation}}:{})}))},generation};
  }
  async followingCommand(command:F.FollowUpdateInput,action:'state'|'status',self:Self,projection?:typeof P.privateControlsContract):Promise<FollowingStatus>{
    if(!this.active())throw stale();const ticket=this.region.coordinator.beginPrivate(this.region,[contentKey(command.target)]);
    try{
      const value=await this.receipt<FollowingStatus|F.FollowStatusView>(ticket,'/api/v1/me/following/'+(projection?'private/':'')+action,{body:action==='state'?command:{idempotency_key:command.idempotency_key},self,
        schema:projection?(action==='state'?P.FollowResult:P.FollowStatus):(action==='state'?F.FollowResult:F.FollowStatus)});
      if(value.operation_state==='not_recorded')return value;
      return {...value,current:followingSettings(value.current)};
    }finally{this.region.coordinator.finish(ticket);}
  }
  async attentionCommand(command:AttentionCommandView,retry:boolean,self:Self,projection?:typeof P.privateControlsContract):Promise<AuthorizedValue<P.AttentionStatusView>>{
    if(!this.active())throw stale();const ticket=this.region.coordinator.beginPrivate(this.region,command.kind==='mute'?[contentKey(command.body.target)]:[]);
    try{
      const value=await this.receipt<A.AttentionStatusView|P.AttentionStatusView>(ticket,'/api/v1/me/attention/'+(projection?'private/':'')+(retry?(command.kind==='mute'?'mutes/state':'dismissals/state'):'status'),{
        body:retry?command.body:{idempotency_key:command.body.idempotency_key},self,schema:projection?P.AttentionStatus:A.AttentionStatus});
      return {value:privateResult(value),...(this.active()?{generation:this.capture()}:{})};
    }finally{this.region.coordinator.finish(ticket);}
  }
}
const AuthorizationContext=createContext<ViewAuthorization|null>(null);
export function useAuthorization(){
  const authority=useContext(AuthorizationContext);if(!authority)throw new Error('Protected reads and attention controls require an AuthorizationBoundary.');
  useSyncExternalStore(authority.subscribe,authority.getSnapshot);return authority;
}
export function AuthorizationBoundary({children,sourcePolicy='withdraw',retryLabel='Retry protected view',scope}:{
  children:ReactNode;sourcePolicy?:'withdraw'|'settings'|'projections';retryLabel?:string;scope?:string;
}){
  const id=useId(),[authority,setAuthority]=useState(()=>new ViewAuthorization(sourcePolicy,identityContent().region(scope??id)));
  const [attempt,setAttempt]=useState(0),snapshot=useSyncExternalStore(authority.subscribe,authority.getSnapshot),notice=useRef<HTMLDivElement>(null);
  const failure=snapshot.state==='owner-invalid'||sourcePolicy!=='settings'&&snapshot.state==='withdrawn';
  useLayoutEffect(()=>{authority.activate();window.addEventListener('loom-identity',authority.identityChanged);
    return()=>{authority.dispose();window.removeEventListener('loom-identity',authority.identityChanged);};},[authority]);
  useLayoutEffect(()=>{if(failure)notice.current?.focus();},[failure]);
  return <AuthorizationContext.Provider value={authority}>{failure?
    <div ref={notice} tabIndex={-1} role="alert" className="notice error"><p>{snapshot.reason?.message}</p>
      <p>The protected view was withdrawn. Saved commands remain available after access is checked again.</p>
      <button onClick={()=>{if(!authority.region.coordinator.current())setAuthority(new ViewAuthorization(sourcePolicy,identityContent().region(scope??id)));
        else authority.region.retry();setAttempt(n=>n+1);}}>{retryLabel}</button></div>:<ContentAttempt key={attempt}>{children}</ContentAttempt>}</AuthorizationContext.Provider>;
}
function ContentAttempt({children}:{children:ReactNode}){return children;}
