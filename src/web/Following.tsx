import { useEffect,useRef,useState } from 'react';
import { Link,useSearchParams } from 'react-router';
import { Value } from '@sinclair/typebox/value';
import * as C from '../contracts/following.js';
import { ApiError,identityGeneration,request,isDefinitiveRejection,type Intent } from './participation-client.js';
import type { Context } from './participation-state.js';

const base='/api/v1/me/following';
export const preferenceLabels:Record<C.FollowSettingsView['preferences'][number],string>={new_discussions:'New discussions',discussion_edits:'Opening edits',
  replies:'Replies and reply edits',artifact_revisions:'Artifact publications',summaries:'Summary publications',change_notes:'Revision change notes',structural:'Organization changes'};
const targetKey=(target:C.FollowTargetView)=>target.kind+':'+target.resource_id;
export const changesUrl=(target:C.FollowTargetView,descendants=false)=>'/loom/changes?'+new URLSearchParams({kind:target.kind,id:target.resource_id,descendants:String(descendants)});
function pendingRecords(context:Context){return context.store.all().filter(r=>r.kind==='following.set').map(r=>{
  if(r.path!==base+'/state'||!Value.Check(C.FollowUpdate,r.body))throw new Error('Following recovery is incompatible. Export your records before continuing.');return r;
});}
function changed(context:Context){window.dispatchEvent(new CustomEvent('loom-following-change',{detail:context.store.prefix}));}
const text=(error:unknown)=>error instanceof Error?error.message:'Following could not be retrieved.';
const invalidates=(error:unknown)=>error instanceof ApiError&&['unauthenticated','invalid_actor','unavailable','forbidden','shared_view_changed'].includes(error.code);

export function FollowControl({context,target,initial,onState}:{context:Context;target:C.FollowTargetView;initial?:C.FollowItemView;onState?:(item:C.FollowItemView)=>void}){
  const [current,setCurrent]=useState(initial),[pending,setPending]=useState<Intent>(),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),
    [error,setError]=useState(''),[message,setMessage]=useState(''),[descendants,setDescendants]=useState(initial?.include_descendants??false),
    [preferences,setPreferences]=useState<C.FollowSettingsView['preferences']>(initial?.preferences??[...C.eventPreferences]);
  const live=useRef(false),owner=useRef(identityGeneration()),sequence=useRef(0),version=useRef(initial?.version??-1),
    reported=useRef<C.FollowItemView|undefined>(undefined),key=targetKey(target);
  const active=()=>live.current&&owner.current===identityGeneration();
  function report(item:C.FollowItemView){reported.current=item;onState?.(item);}
  function accept(item:C.FollowItemView){if(active()&&item.version>=version.current){
    version.current=item.version;setCurrent(item);setDescendants(item.include_descendants);setPreferences(item.preferences);report(item);
  }}
  function sync(){if(active())setPending(pendingRecords(context).find(r=>r.slot==='following:'+key));}
  async function refresh(){
    const mine=++sequence.current;if(active()){setLoading(true);setError('');}
    try{sync();const item=await request<C.FollowItemView>(base+'/lookup',{body:target,self:context.self,schema:C.FollowItem});if(mine===sequence.current)accept(item);}
    catch(failure){if(active()&&mine===sequence.current){if(invalidates(failure)){setCurrent(undefined);if(current)report({...current,source:{state:'unavailable'}});}setError(text(failure));}}
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
    if(!active()||!initial||initial===current||initial===reported.current||initial.version<version.current)return;
    // An explicit collection refresh adopts its settings without remounting the
    // editor. Our own policy placeholder is feedback, not a successful refresh.
    // Earlier lookups must not restore the state it just replaced.
    sequence.current++;accept(initial);setLoading(false);setError('');
  },[initial]);
  async function finish(record:Intent,result:C.FollowResultView){
    await context.store.complete(record);changed(context);if(!active())return;
    accept(result.current);setPending(undefined);
    setMessage(result.operation_state==='version_conflict'?'Another client changed these settings. Review the current state before choosing again.':
      result.outcome.following!==result.current.following?'The earlier decision is confirmed; the newer Following state is preserved.':
      result.current.following?'Following settings saved. Existing change views keep their bound settings.':'Explicit follow removed. Other subscriptions, Saved items and direct attention are unchanged.');
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
          if(pendingRecords(context).some(r=>r.slot==='following:'+key))throw new Error('Resolve the existing Following change before choosing another action.');
          const record=context.store.create('following:'+key,'following.set',base+'/state',{target,following:desired,expected_version:current!.version,
            include_descendants:desired?descendants:current!.include_descendants,preferences:desired?preferences:current!.preferences});
          return context.store.prepareDispatch(record,record.body);
        });
      }
      changed(context);if(active())setPending(retained);
      const result=await request<C.FollowResultView>(base+'/state',{body:retained.body,self:context.self,schema:C.FollowResult});
      await finish(retained,result);
    }catch(failure){
      if(retained&&isDefinitiveRejection(failure,!!retry))try{await context.store.settle(retained,{state:'rejected'});changed(context);}catch{/* A newer sequenced record retains ownership. */}
      if(active()){setError(text(failure));try{sync();}catch(failure){setError(text(failure));}}
    }finally{if(active())setBusy(false);}
  }
  async function status(){
    if(busy||!pending)return;const record=pending;setBusy(true);setError('');
    try{const result=await request<C.FollowStatusView>(base+'/status',{body:{idempotency_key:record.key},self:context.self,schema:C.FollowStatus});
      if(result.operation_state==='not_recorded'){if(active())setMessage('No decision is recorded yet. Keep the original intent; it may still complete.');}else await finish(record,result);
    }catch(failure){if(active())setError(text(failure));}finally{if(active())setBusy(false);}
  }
  const disabled=busy||loading||!current||!!pending;
  return <div className="follow-control" data-follow-target={key}>
    {!pending&&<button disabled={disabled||!!error||!current?.following&&(!preferences.length||current?.source.state==='unavailable')} aria-pressed={current?.following??false}
      onClick={()=>void mutate(!current?.following)}>{busy?'Saving follow…':loading&&!current?'Checking follow…':current?.following?'Unfollow':'Follow'}</button>}
    {current?.source.state==='available'&&<Link to={changesUrl(target,current.include_descendants)}>View changes</Link>}
    {current&&!pending&&<details><summary>Follow settings</summary><fieldset disabled={disabled}>
      <legend>Changes to include</legend>
      {target.kind==='area'&&<label><input type="checkbox" checked={descendants} onChange={e=>setDescendants(e.target.checked)}/>Include subtopics</label>}
      {C.eventPreferences.map(p=><label key={p}><input type="checkbox" checked={preferences.includes(p)} onChange={e=>setPreferences(
        C.eventPreferences.filter(v=>v===p?e.target.checked:preferences.includes(v)))}/>{preferenceLabels[p]}</label>)}
      <button disabled={!preferences.length} onClick={()=>void mutate(true)}>Save follow settings</button>
    </fieldset><p className="fineprint">This is an explicit subscription. Parent and child choices remain separate.</p></details>}
    {pending&&<div className="notice" aria-label="Following recovery"><strong>{pending.state==='rejected'?'This Following change was rejected.':'Following change awaiting confirmation.'}</strong>
      <p>{pending.body.following?'Follow':'Unfollow'} · {target.kind}</p>
      {pending.state==='rejected'?<button disabled={busy} onClick={()=>void context.store.remove(pending).then(()=>{changed(context);if(active()){setPending(undefined);void refresh();}}).catch(e=>active()&&setError(text(e)))}>Dismiss rejected follow</button>:<>
        <button disabled={busy} onClick={()=>void status()}>Check follow status</button><button disabled={busy} onClick={()=>void mutate(false,pending)}>Retry same follow change</button></>}
    </div>}
    {error&&<div role="alert"><p>{error}</p><button disabled={busy} onClick={()=>void refresh()}>Refresh follow state</button></div>}
    {message&&<p role="status" className="fineprint">{message}</p>}
  </div>;
}

export function FollowingPage({context}:{context:Context}){
  const [params,setParams]=useSearchParams(),cursor=params.get('cursor')??undefined;
  const [page,setPage]=useState<C.FollowPageView>(),[pending,setPending]=useState<Intent[]>([]),[busy,setBusy]=useState(false),
    [error,setError]=useState(''),[changedElsewhere,setChanged]=useState(false),[reload,setReload]=useState(0);
  const live=useRef(false),owner=useRef(identityGeneration()),sequence=useRef(0),heading=useRef<HTMLHeadingElement>(null);
  const active=()=>live.current&&owner.current===identityGeneration();
  useEffect(()=>{
    live.current=true;owner.current=identityGeneration();const mine=++sequence.current,controller=new AbortController();setBusy(true);setError('');
    try{setPending(pendingRecords(context));}catch(e){setError(text(e));}
    void request<C.FollowPageView>(base+'?limit=12'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{schema:C.FollowPage,signal:controller.signal}).then(value=>{
      if(active()&&mine===sequence.current){setPage(value);setChanged(false);heading.current?.focus();}
    },failure=>{if(active()&&mine===sequence.current&&failure.name!=='AbortError'){if(invalidates(failure))setPage(undefined);setError(text(failure));}})
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
  // A control's newer lookup may withdraw source metadata before collection
  // membership is refreshed. Apply that policy result to the entire visible row.
  const updateItem=(item:C.FollowItemView)=>setPage(value=>value?{...value,items:value.items.map(old=>
    targetKey(old.target)===targetKey(item.target)&&item.version>=old.version?item:old)}:value);
  const refresh=()=>{setParams({});setReload(v=>v+1);};
  return <section className="following" aria-busy={busy}>
    <div className="header-line"><div><h1 ref={heading} tabIndex={-1}>Following</h1><p className="subtitle">Your explicit topics, discussions and artifacts. Each choice stays independent.</p></div>
      <button disabled={busy} onClick={refresh}>Refresh following</button></div>
    <p><Link className="button" to="/loom/changes">Open followed changes</Link> <Link to="/loom/notifications">Mentions/replies</Link></p>
    {pending.length>0&&<section aria-label="Unconfirmed Following changes"><h2>Unconfirmed changes</h2>{pending.map(r=><FollowControl key={r.key} context={context} target={r.body.target as C.FollowTargetView}/>)}</section>}
    {changedElsewhere&&<p role="status" className="notice">Following may have changed. Refresh to adopt current membership.</p>}
    {error&&<div role="alert" className="notice error"><p>{error}</p><button onClick={()=>setReload(v=>v+1)}>Retry following page</button></div>}
    {busy&&<p role="status">Loading following…</p>}
    {page&&<><div className="collection" aria-label="Explicit follows">
      {!page.items.length&&!error&&!changedElsewhere&&<div className="empty-state"><h2>No explicit follows</h2><p>Open <Link to="/loom">Topics</Link> or <Link to="/loom/artifacts">Artifacts</Link> and choose Follow. Direct <Link to="/loom/notifications">Mentions/replies</Link> works independently.</p></div>}
      {page.items.map(item=><article className="list-row following-row" key={targetKey(item.target)}>
        <div><small>{item.target.kind==='area'?'Topic':item.target.kind}</small><h2>{item.source.state==='available'?<Link to={item.source.browser_url}>{item.source.title??'Current title unavailable'}</Link>:'Followed target unavailable'}</h2>
          {item.source.state==='available'?<p>{item.source.path.map(a=>a.title).join(' › ')}</p>:<p>Source metadata is unavailable. You can still remove your explicit follow.</p>}
          <p>{item.target.kind==='area'?(item.include_descendants?'Including subtopics':'This topic only'):'Direct subscription'} · {item.preferences.map(p=>preferenceLabels[p]).join(', ')}</p>
        </div><FollowControl context={context} target={item.target} initial={item} onState={updateItem}/>
      </article>)}
    </div><div className="pagination"><span>{page.items.length} explicit follows on this page · stable order</span>
      {cursor&&<button disabled={busy} onClick={refresh}>First page</button>}
      {page.next_cursor&&<button disabled={busy||!!error||changedElsewhere} onClick={()=>setParams({cursor:page.next_cursor!})}>Next follows</button>}</div>
      {page.complete&&!error&&!changedElsewhere&&<p className="fineprint">End of this Following collection. Parent coverage does not remove explicit child choices.</p>}
    </>}
  </section>;
}
