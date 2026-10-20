import { useEffect,useRef,useState } from 'react';
import { MuteControl } from './Attention.js';
import { AuthorizationBoundary,useAuthorization,type AuthorizedValue,type FollowingItem,type FollowingCollection } from './AuthorizationBoundary.js';
import { Link,useSearchParams } from 'react-router';
import { Value } from '@sinclair/typebox/value';
import * as C from '../contracts/following.js';
import * as P from '../contracts/private-controls.js';
import { identityGeneration,isDefinitiveRejection,type Intent } from './participation-client.js';
import type { Context } from './participation-state.js';
import { contentKey as targetKey } from './protected-content.js';

const base='/api/v1/me/following';
export const preferenceLabels:Record<C.FollowSettingsView['preferences'][number],string>={new_discussions:'New discussions',discussion_edits:'Opening edits',
  replies:'Replies and reply edits',artifact_revisions:'Artifact publications',summaries:'Summary publications',change_notes:'Revision change notes',structural:'Organization changes'};
export const changesUrl=(target:C.FollowTargetView,descendants=false)=>'/loom/changes?'+new URLSearchParams({kind:target.kind,id:target.resource_id,descendants:String(descendants)});
function pendingRecords(context:Context){return context.store.all().filter(r=>r.kind==='following.set').map(r=>{
  if(r.path!==base+'/state'||!Value.Check(C.FollowUpdate,r.body))throw new Error('Following recovery is incompatible. Export your records before continuing.');return r;
});}
function changed(context:Context){window.dispatchEvent(new CustomEvent('loom-following-change',{detail:context.store.prefix}));}
const text=(error:unknown)=>error instanceof Error?error.message:'Following could not be retrieved.';
function mergeItem(previous:FollowingItem|undefined,next:FollowingItem):FollowingItem{
  if(!previous)return next;
  const settings=next.settings.version>=previous.settings.version?next.settings:previous.settings,preview=next.preview??previous.preview;
  if(settings===next.settings&&preview===next.preview)return next;
  if(settings===previous.settings&&preview===previous.preview)return previous;
  return {settings,...(preview?{preview}:{})};
}

export function FollowControl({context,target,initial,onState,onConfirmation}:{context:Context;target:C.FollowTargetView;initial?:FollowingItem;
  onState?:(item:FollowingItem)=>void;onConfirmation?:(message:string)=>void}){
  const authority=useAuthorization();
  const [item,setItem]=useState(initial),[pending,setPending]=useState<Intent>(),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),
    [error,setError]=useState(''),[message,setMessage]=useState(''),[descendants,setDescendants]=useState(initial?.settings.include_descendants??false),
    [preferences,setPreferences]=useState<C.FollowSettingsView['preferences']>(initial?.settings.preferences??[...C.eventPreferences]);
  const live=useRef(false),owner=useRef(identityGeneration()),sequence=useRef(0),latest=useRef(initial),
    reported=useRef<FollowingItem|undefined>(undefined),key=targetKey(target);
  const current=item?.settings,source=authority.preview(target,item?.preview?.generation)?.source;
  const active=()=>live.current&&owner.current===identityGeneration()&&authority.active();
  function accept(next:FollowingItem){
    if(!active())return latest.current;
    const fresh=next.preview&&authority.current(next.preview.generation)?next:{settings:next.settings};
    const previous=latest.current,merged=mergeItem(previous,fresh);latest.current=merged;setItem(merged);
    if(!previous||next.settings.version>=previous.settings.version){setDescendants(merged.settings.include_descendants);setPreferences(merged.settings.preferences);}
    reported.current=merged;onState?.(merged);return merged;
  }
  // Older journals may use a different UUID spelling in their slot. Compare
  // the frozen target identity without rewriting that slot or command body.
  function sync(){if(active())setPending(pendingRecords(context).find(r=>targetKey(r.body.target as C.FollowTargetView)===key));}
  async function refresh(protectedRefresh=false){
    const mine=++sequence.current;if(active()){setLoading(true);setError('');}
    try{
      sync();
      if(context.controlsProjection){
        const started=authority.capture(),settings=await authority.privateRead<P.FollowItemView>(base+'/private/lookup',{body:target,self:context.self,schema:P.FollowItem});
        if(mine!==sequence.current||!active())return;
        accept({settings});setLoading(false);
        const generation=authority.current(started)?await authority.previewLookup(target,context.self,protectedRefresh):undefined;
        if(mine===sequence.current&&authority.current(generation))accept({settings,preview:{generation:generation!}});
      }else{const item=await authority.followingLookup(target,context.self);if(mine===sequence.current)accept(item);}
    }
    catch(failure){if(active()&&mine===sequence.current&&(failure as Error).name!=='AbortError')setError(text(failure));}
    finally{if(active()&&mine===sequence.current)setLoading(false);}
  }
  useEffect(()=>{
    live.current=true;owner.current=identityGeneration();void refresh();
    const local=(e:Event)=>{if((e as CustomEvent).detail===context.store.prefix)void refresh();};
    const storage=(e:StorageEvent)=>{if(e.key?.startsWith(context.store.prefix))void refresh();};
    window.addEventListener('loom-following-change',local);window.addEventListener('storage',storage);
    return()=>{live.current=false;sequence.current++;window.removeEventListener('loom-following-change',local);window.removeEventListener('storage',storage);};
  },[key,context.store.prefix]);
  useEffect(()=>{
    if(!active()||!initial||initial===item||initial===reported.current)return;
    // An explicit collection refresh adopts its settings without remounting the
    // editor. Private versions and source leases are independent; an older
    // choice version can still carry freshly authorized metadata.
    sequence.current++;accept(initial);setLoading(false);
    if(authority.current(initial.preview?.generation))setError('');
  },[initial]);
  async function finish(record:Intent,result:Awaited<ReturnType<typeof authority.followingCommand>>){
    if(result.operation_state==='not_recorded'){if(active())setMessage('No decision is recorded yet. Keep the original intent; it may still complete.');return;}
    await context.store.complete(record);
    if(active()){
      const state=accept({settings:result.current})!.settings;setPending(undefined);
      const confirmation=result.operation_state==='version_conflict'?'Another client changed these settings. Review the current state before choosing again.':
        result.outcome.following!==state.following?'The earlier decision is confirmed; the newer Following state is preserved.':
        state.following?'Following settings saved. Existing change views keep their bound settings.':'Explicit follow removed. Other subscriptions, Saved items and direct attention are unchanged.';
      setMessage(confirmation);onConfirmation?.(confirmation);
    }
    // Completion can outlive the source view. Notify the same owner only, and
    // keep recovery confirmation above any temporary control being removed.
    if(owner.current===identityGeneration())changed(context);
  }
  async function mutate(desired:boolean,retry?:Intent){
    if(busy||!retry&&(!current||loading))return;
    setBusy(true);setError('');setMessage('');let retained:Intent|undefined;
    try{
      if(retry)retained=await context.store.prepareDispatch(retry,retry.body);
      else{
        if(!navigator.locks)throw new Error('This browser needs Web Locks to retain Following intent.');
        retained=await navigator.locks.request(context.store.prefix+'following:'+key,async()=>{
          if(!active())throw new DOMException('View changed.','AbortError');
          if(pendingRecords(context).some(r=>targetKey(r.body.target as C.FollowTargetView)===key))throw new Error('Resolve the existing Following change before choosing another action.');
          const record=context.store.create('following:'+key,'following.set',base+'/state',{target,following:desired,expected_version:current!.version,
            include_descendants:desired?descendants:current!.include_descendants,preferences:desired?preferences:current!.preferences});
          return context.store.prepareDispatch(record,record.body);
        });
      }
      changed(context);if(active())setPending(retained);
      const result=await authority.followingCommand(retained.body as C.FollowUpdateInput,'state',context.self,context.controlsProjection);
      await finish(retained,result);
    }catch(failure){
      if(retained&&isDefinitiveRejection(failure,!!retry))try{await context.store.settle(retained,{state:'rejected'});if(owner.current===identityGeneration())changed(context);}catch{/* A newer sequenced record retains ownership. */}
      if(active()){setError(text(failure));try{sync();}catch(failure){setError(text(failure));}}
    }finally{if(active())setBusy(false);}
  }
  async function status(){
    if(busy||!pending)return;const record=pending;setBusy(true);setError('');
    try{const result=await authority.followingCommand(record.body as C.FollowUpdateInput,'status',context.self,context.controlsProjection);await finish(record,result);
    }catch(failure){if(active())setError(text(failure));}finally{if(active())setBusy(false);}
  }
  const disabled=busy||loading||!current||!!pending;
  return <div className="follow-control" data-follow-target={key}>
    {context.community.attention_contract&&<details><summary>Routine attention</summary><MuteControl context={context} target={target}/></details>}
    {!pending&&<button disabled={disabled||!current?.following&&(!!error||!preferences.length||source?.state!=='available')} aria-pressed={current?.following??false}
      onClick={()=>void mutate(!current?.following)}>{busy?'Saving follow…':loading&&!current?'Checking follow…':current?.following?'Unfollow':'Follow'}</button>}
    {current&&source?.state==='available'&&<Link to={changesUrl(target,current.include_descendants)}>View changes</Link>}
    {current&&!pending&&<details><summary>Follow settings</summary><fieldset disabled={disabled}>
      <legend>Changes to include</legend>
      {target.kind==='area'&&<label><input type="checkbox" checked={descendants} onChange={e=>setDescendants(e.target.checked)}/>Include subtopics</label>}
      {C.eventPreferences.map(p=><label key={p}><input type="checkbox" checked={preferences.includes(p)} onChange={e=>setPreferences(
        C.eventPreferences.filter(v=>v===p?e.target.checked:preferences.includes(v)))}/>{preferenceLabels[p]}</label>)}
      <button disabled={!preferences.length||source?.state!=='available'} onClick={()=>void mutate(true)}>Save follow settings</button>
    </fieldset><p className="fineprint">This is an explicit subscription. Parent and child choices remain separate.</p></details>}
    {pending&&<div className="notice" aria-label="Following recovery"><strong>{pending.state==='rejected'?'This Following change was rejected.':'Following change awaiting confirmation.'}</strong>
      <p>{pending.body.following?'Follow':'Unfollow'} · {target.kind}</p>
      {pending.state==='rejected'?<button disabled={busy} onClick={()=>void context.store.remove(pending).then(()=>{changed(context);if(active()){setPending(undefined);void refresh();}}).catch(e=>active()&&setError(text(e)))}>Dismiss rejected follow</button>:<>
        <button disabled={busy} onClick={()=>void status()}>Check follow status</button><button disabled={busy} onClick={()=>void mutate(false,pending)}>Retry same follow change</button></>}
    </div>}
    {error&&<div role="alert"><p>{error}</p><button disabled={busy} onClick={()=>void refresh(true)}>Refresh follow state</button></div>}
    {message&&<p role="status" className="fineprint">{message}</p>}
  </div>;
}

export function FollowingPage({context}:{context:Context}){
  return <AuthorizationBoundary scope="following" sourcePolicy="settings" retryLabel="Retry following page"><FollowingView context={context}/></AuthorizationBoundary>;
}
function FollowingView({context}:{context:Context}){
  const authority=useAuthorization();
  const [params,setParams]=useSearchParams(),cursor=params.get('cursor')??undefined;
  const [authorizedPage,setPage]=useState<AuthorizedValue<FollowingCollection>>(),[pending,setPending]=useState<Intent[]>([]),[busy,setBusy]=useState(false),
    [error,setError]=useState(''),[confirmation,setConfirmation]=useState(''),[changedElsewhere,setChanged]=useState(false),[reload,setReload]=useState(0);
  const page=authorizedPage?.value,withdrawn=!!authorizedPage&&(!authority.current(authorizedPage.generation)||authority.getSnapshot().state==='withdrawn');
  const live=useRef(false),owner=useRef(identityGeneration()),sequence=useRef(0),heading=useRef<HTMLHeadingElement>(null);
  const active=()=>live.current&&owner.current===identityGeneration()&&authority.active();
  useEffect(()=>{
    live.current=true;owner.current=identityGeneration();const mine=++sequence.current,controller=new AbortController();setBusy(true);setError('');
    try{setPending(pendingRecords(context));}catch(e){setError(text(e));}
    const started=authority.capture();
    void (async()=>{
      if(context.controlsProjection){
        const value=await authority.privateRead<P.FollowPageView>(base+'/private?limit=12'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{schema:P.FollowPage,signal:controller.signal});
        if(!active()||mine!==sequence.current)return;
        // Register the one batch before mounting rows, so their independent
        // private lookups can share it without delaying safe removal controls.
        const pending=authority.current(started)&&value.items.length?authority.previews(value.items.map(v=>v.target),context.self):undefined;
        setPage({value:{...value,items:value.items.map(settings=>({settings}))},generation:undefined});setChanged(false);setBusy(false);heading.current?.focus();
        const generation=pending?await pending:authority.current(started)?started:undefined;
        if(active()&&mine===sequence.current&&authority.current(generation))setPage(previous=>previous?{value:{...previous.value,items:previous.value.items.map(item=>({...item,preview:{generation:generation!}}))},generation}:previous);
      }else{
        const value=await authority.followingPage(cursor,controller.signal);
        if(active()&&authority.current(value.generation)&&mine===sequence.current){setPage(value);setChanged(false);heading.current?.focus();}
      }
    })().catch(failure=>{if(active()&&mine===sequence.current&&failure.name!=='AbortError')setError(text(failure));})
      .finally(()=>{if(active()&&mine===sequence.current)setBusy(false);});
    return()=>{live.current=false;sequence.current++;controller.abort();};
  },[cursor,reload,context.store.prefix]);
  useEffect(()=>{
    const update=()=>{if(active()){sequence.current++;setBusy(false);setChanged(true);try{setPending(pendingRecords(context));}catch(e){setError(text(e));}}};
    const local=(e:Event)=>{if((e as CustomEvent).detail===context.store.prefix)update();};
    const storage=(e:StorageEvent)=>{if(e.key?.startsWith(context.store.prefix))update();};
    window.addEventListener('loom-following-change',local);window.addEventListener('storage',storage);
    return()=>{window.removeEventListener('loom-following-change',local);window.removeEventListener('storage',storage);};
  },[context.store.prefix]);
  const updateItem=(item:FollowingItem)=>setPage(page=>page?{...page,value:{...page.value,items:page.value.items.map(old=>
    targetKey(old.settings.target)===targetKey(item.settings.target)?mergeItem(old,item):old)}}:page);
  const refresh=()=>{setParams({});setReload(v=>v+1);};
  return <section className="following" aria-busy={busy}>
    <div className="header-line"><div><h1 ref={heading} tabIndex={-1}>Following</h1><p className="subtitle">Your explicit topics, discussions and artifacts. Each choice stays independent.</p></div>
      <button disabled={busy} onClick={refresh}>Refresh following</button></div>
    <p><Link className="button" to="/loom/changes">Open followed changes</Link> <Link to="/loom/notifications">Mentions/replies</Link></p>
    {pending.length>0&&<section aria-label="Unconfirmed Following changes"><h2>Unconfirmed changes</h2>{pending.map(r=>{
      const target=r.body.target as C.FollowTargetView,initial=page?.items.find(item=>targetKey(item.settings.target)===targetKey(target));
      return <FollowControl key={r.key} context={context} target={target} onConfirmation={setConfirmation} {...(initial?{initial}:{})}/>;
    })}</section>}
    {changedElsewhere&&<p role="status" className="notice">Following may have changed. Refresh to adopt current membership.</p>}
    {confirmation&&<p role="status">{confirmation}</p>}
    {(error||withdrawn)&&<div role="alert" className="notice error"><p>{error||'Source metadata was withdrawn. Your private choices and saved commands remain available.'}</p><button disabled={busy} onClick={()=>setReload(v=>v+1)}>Retry following page</button></div>}
    {busy&&<p role="status">Loading following…</p>}
    {page&&<><div className="collection" aria-label="Explicit follows">
      {!page.items.length&&!error&&!changedElsewhere&&<div className="empty-state"><h2>No explicit follows</h2><p>Open <Link to="/loom">Topics</Link> or <Link to="/loom/artifacts">Artifacts</Link> and choose Follow. Direct <Link to="/loom/notifications">Mentions/replies</Link> works independently.</p></div>}
      {page.items.map(item=>{const state=item.settings,source=authority.preview(state.target,item.preview?.generation)?.source;return <article className="list-row following-row" key={targetKey(state.target)}>
        <div><small>{state.target.kind==='area'?'Topic':state.target.kind}</small><h2>{source?.state==='available'?<Link to={source.browser_url}>{source.title??'Current title unavailable'}</Link>:'Followed target unavailable'}</h2>
          {source?.state==='available'?<p>{source.path.map(a=>a.title).join(' › ')}</p>:<p>Source metadata is unavailable. You can still remove your explicit follow.</p>}
          <p>{state.target.kind==='area'?(state.include_descendants?'Including subtopics':'This topic only'):'Direct subscription'} · {state.preferences.map(p=>preferenceLabels[p]).join(', ')}</p>
        </div><FollowControl context={context} target={state.target} initial={item} onState={updateItem}/>
      </article>;})}
    </div><div className="pagination"><span>{page.items.length} explicit follows on this page · stable order</span>
      {cursor&&<button disabled={busy} onClick={refresh}>First page</button>}
      {page.next_cursor&&<button disabled={busy||!!error||changedElsewhere||withdrawn} onClick={()=>setParams({cursor:page.next_cursor!})}>Next follows</button>}</div>
      {page.complete&&!error&&!changedElsewhere&&<p className="fineprint">End of this Following collection. Parent coverage does not remove explicit child choices.</p>}
    </>}
  </section>;
}
