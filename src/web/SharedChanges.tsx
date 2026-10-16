import { useEffect,useRef,useState,type RefObject } from 'react';
import { Link,useSearchParams } from 'react-router';
import * as C from '../contracts/following.js';
import { ApiError,identityGeneration,request } from './participation-client.js';
import type { Context } from './participation-state.js';
import { SharedRecovery,sharedScopeKey,sharedToken } from './shared-recovery.js';
import { preferenceLabels } from './Following.js';

const invalidations=new Set(['shared_visibility_replay_required','shared_view_changed','shared_epoch_changed','unauthenticated','invalid_actor','unavailable','forbidden']);
export function SharedChangesPage({context}:{context:Context}){
  const [params,setParams]=useSearchParams(),kind=params.get('kind'),id=params.get('id');
  const scope:C.SharedScopeView=(kind==='area'||kind==='discussion'||kind==='artifact')&&id?{kind:'explicit',definition:{target:{kind,resource_id:id},
    include_descendants:kind==='area'&&params.get('descendants')==='true',preferences:C.eventPreferences.filter(p=>!params.has('events')||params.get('events')!.split(',').includes(p))}}:{kind:'following'};
  const heading=useRef<HTMLHeadingElement>(null);
  const choose=(next:C.FollowSettingsView)=>{
    const p=new URLSearchParams(params);p.set('descendants',String(next.include_descendants));p.set('events',next.preferences.join(','));
    // Controlled checkboxes need their URL-backed value committed in the input
    // event; a deferred router transition can restore the previous checked value.
    setParams(p,{flushSync:true});
  };
  // Keep the controls/focus stable while a new scoped results component fences
  // outstanding reads. Remounting the controls would collapse details on change.
  return <section className="shared-changes notifications">
    <h1 tabIndex={-1} ref={heading}>Changes</h1><p className="muted">Chronological shared changes in a fixed interval. Full content opens separately.</p>
    <p><Link to="/loom/following">Manage Following</Link> · <Link to="/loom/notifications">Mentions/replies</Link></p>
    {scope.kind==='explicit'&&<details><summary>Explicit scope and event preferences</summary>
      <p>{scope.definition.target.kind} · {scope.definition.target.resource_id}. Viewing this scope does not create a follow.</p>
      {scope.definition.target.kind==='area'&&<label><input type="checkbox" checked={scope.definition.include_descendants} onChange={e=>choose({...scope.definition,include_descendants:e.target.checked})}/>Include subtopics</label>}
      {C.eventPreferences.map(p=><label key={p}><input type="checkbox" checked={scope.definition.preferences.includes(p)} disabled={scope.definition.preferences.length===1&&scope.definition.preferences.includes(p)}
        onChange={e=>choose({...scope.definition,preferences:C.eventPreferences.filter(v=>v===p?e.target.checked:scope.definition.preferences.includes(v))})}/>{preferenceLabels[p]}</label>)}
    </details>}
    <SharedView key={context.self.participant_id+sharedScopeKey(scope)} context={context} scope={scope} heading={heading}/>
  </section>;
}
function SharedView({context,scope,heading}:{context:Context;scope:C.SharedScopeView;heading:RefObject<HTMLHeadingElement|null>}){
  const [page,setPage]=useState<C.SharedPageView>(),[busy,setBusy]=useState(false),[failure,setFailure]=useState<{code:string;text:string}>(),[size,setSize]=useState(12),
    [past,setPast]=useState<C.SharedOptions[]>([]),[reasonDetail,setReasonDetail]=useState<C.SharedItemView>();
  const live=useRef(false),owner=useRef(identityGeneration()),sequence=useRef(0),requestSequence=useRef(0),inflight=useRef(false),
    attempted=useRef<C.SharedOptions>({scope}),notice=useRef<HTMLDivElement>(null),controller=useRef<AbortController|undefined>(undefined);
  const [recovery]=useState(()=>new SharedRecovery(context.community.instance_id,context.self.participant_id)),key=sharedScopeKey(scope);
  const active=()=>live.current&&owner.current===identityGeneration();
  async function load(options:C.SharedOptions,history=past,focus=false){
    if(inflight.current)return;inflight.current=true;
    controller.current?.abort();const abort=new AbortController();controller.current=abort;
    const mine=++requestSequence.current;attempted.current=options;
    if(active()){setBusy(true);setFailure(undefined);setReasonDetail(undefined);}
    try{
      const value=await request<C.SharedPageView>('/api/v1/shared-changes/query',{body:options,self:context.self,schema:C.SharedPage,signal:abort.signal});
      if(!active()||mine!==requestSequence.current)return;
      attempted.current={cursor:value.page_cursor,limit:value.limit,max_response_bytes:value.max_response_bytes};
      const saved=await recovery.save(key,value,sequence.current,()=>active()&&mine===requestSequence.current);
      if(!active()||mine!==requestSequence.current)return;
      sequence.current=saved.sequence;setPage(value);setPast(history.slice(-8));setSize(value.limit);
      if(focus)heading.current?.focus();
    }catch(error){if(active()&&mine===requestSequence.current&&(error as Error).name!=='AbortError'){
      if(error instanceof ApiError&&invalidations.has(error.code)){setPage(undefined);setReasonDetail(undefined);}
      setFailure({code:error instanceof ApiError?error.code:'local_recovery_failed',text:error instanceof Error?error.message:'Shared retrieval failed.'});
    }}finally{if(mine===requestSequence.current){inflight.current=false;if(active())setBusy(false);}}
  }
  useEffect(()=>{
    live.current=true;owner.current=identityGeneration();inflight.current=false;
    try{const saved=recovery.read(key);sequence.current=saved?.sequence??0;void load(saved?.request??{scope},[]);}
    catch(e){setFailure({code:'local_recovery_failed',text:(e as Error).message});}
    return()=>{live.current=false;requestSequence.current++;controller.current?.abort();};
  },[key,recovery]);
  useEffect(()=>{if(failure&&invalidations.has(failure.code))notice.current?.focus();},[failure]);
  async function clear(){if(inflight.current)return;try{await recovery.clear(active);sequence.current=0;await load({scope},[],true);}
    catch(e){if(active())setFailure({code:'local_recovery_failed',text:(e as Error).message});}}
  async function detail(item:C.SharedItemView,offset=0){
    if(inflight.current||!page)return;const mine=requestSequence.current;inflight.current=true;setBusy(true);
    try{const value=await request<C.SharedItemView>(item.detail_url,{body:{cursor:page.page_cursor,event_id:item.event_id,reason_offset:offset},self:context.self,schema:C.SharedItem});
      if(active()&&mine===requestSequence.current)setReasonDetail(value);
    }catch(e){if(active()&&mine===requestSequence.current){if(e instanceof ApiError&&invalidations.has(e.code)){setPage(undefined);setReasonDetail(undefined);}
      setFailure({code:e instanceof ApiError?e.code:'retrieval_failed',text:(e as Error).message});}}
    finally{inflight.current=false;if(active()&&mine===requestSequence.current)setBusy(false);}
  }
  const token=sharedToken(attempted.current),action=failure?.code==='shared_descriptor_expired'?'renew':failure?.code==='shared_visibility_replay_required'?'replay':failure?.code==='shared_history_gap'?'resynchronize':undefined;
  const reasons=(item:C.SharedItemView)=><ul className="change-reasons">{item.reasons.map(r=><li key={r.definition}>
    {r.relevance==='event_time_area'?'Event-time topic':r.relevance==='ancestor_impact'?'Affected by an ancestor change':r.relevance==='structural_before_after'?'Before/after topic scope':'Direct target'}
    {' '}· {r.target.kind} {r.target.resource_id.slice(0,8)} · {r.preferences.map(p=>preferenceLabels[p]).join(', ')}
  </li>)}</ul>;
  return <div aria-busy={busy}>
    <div className="notification-toolbar"><button aria-disabled={busy} onClick={()=>void load({scope},[],true)}>Refresh scope from retained history</button>
      {page?.checkpoint&&<button aria-disabled={busy} onClick={()=>void load({checkpoint:page.checkpoint!,limit:size},[],true)}>Check newer shared changes</button>}
      <label>Next page size <select value={size} onChange={e=>setSize(Number(e.target.value))}><option value={5}>5</option><option value={12}>12</option><option value={25}>25</option></select></label>
    </div>
    {busy&&<p role="status">Loading shared changes…</p>}
    {failure&&<div className="notice error" role="alert" tabIndex={-1} ref={notice}><p>{failure.text}</p>
      {action?<button aria-disabled={busy} onClick={()=>void load({recovery:{action,...(token?{token}:{})},...(!token?{scope}:{}),
        ...(action==='renew'?{limit:attempted.current.limit,max_response_bytes:attempted.current.max_response_bytes}:{})},[],true)}>
        {action==='renew'?'Renew fixed shared view':action==='replay'?'Replay retained shared history':'Establish new baseline and inspect retained content'}</button>:
        failure.code==='shared_definition_changed'?<button onClick={()=>void load({scope},[],true)}>Adopt current settings from retained history</button>:
          failure.code!=='shared_epoch_changed'&&<button aria-disabled={busy} onClick={()=>void load(attempted.current)}>Retry shared page</button>}
      {['local_recovery_failed','shared_token_invalid'].includes(failure.code)&&<button aria-disabled={busy} onClick={()=>void clear()}>Clear saved shared change views</button>}
    </div>}
    {page&&<>
      {!page.traversal.settings_current&&<p role="status" className="notice">This view uses older saved Following settings. Refresh scope from retained history to adopt current choices.</p>}
      {page.no_subscriptions&&<div className="empty-state"><h2>No followed scopes</h2><p>Follow a topic, discussion or artifact to select shared activity, or use its View changes action. <Link to="/loom/notifications">Mentions/replies</Link> remains independent.</p></div>}
      {page.coverage==='unknown'&&<p className="notice">Coverage is unknown where older structural impacts or unsupported public events lack required facts. This interval is not marked complete.</p>}
      {page.recovery==='visibility_replay'&&<p role="status">Replaying older retained history with original event identities.</p>}
      {page.history==='incomplete'&&<p className="notice">This view has an incomplete-history baseline. Retained content cannot reconstruct expired events or missing historical ancestry.</p>}
      {!page.items.length&&!page.no_subscriptions&&!failure&&!busy&&<p>No eligible changes on this page.{page.next_cursor?' Continue scanning the fixed interval.':''}</p>}
      <ol className="notification-list">{page.items.map(item=><li key={item.event_id}>
        <p className="change-kind">{item.kind.replaceAll('.',' ')}</p>
        <h2><Link to={item.exact_url??item.context_url}>{item.current.state==='available'?item.current.title??'Current title unavailable':'Current context unavailable'}</Link></h2>
        <p><strong>{item.actor.nickname}</strong> · <time dateTime={item.occurred_at}>{new Date(item.occurred_at).toLocaleString()}</time></p>
        {item.current.state==='available'&&<p className="muted">Now: {item.current.path.map(a=>a.title).join(' › ')}</p>}
        {reasons(item)}
        <div className="notification-links">{item.exact_url&&<Link to={item.exact_url}>Exact revision {item.revision_number}</Link>}
          {item.change_note_url&&<Link to={item.exact_url+'#change-note'}>Note on this exact revision</Link>}<Link to={item.context_url}>Current context</Link>
          {!item.reasons_complete&&<button aria-disabled={busy} onClick={()=>void detail(item,item.next_reason!)}>More match reasons</button>}
        </div>
      </li>)}</ol>
      {reasonDetail&&<aside className="notice" aria-label="Additional match reasons"><h2>Additional reasons</h2>{reasons(reasonDetail)}
        {reasonDetail.next_reason!==null&&<button onClick={()=>void detail(reasonDetail,reasonDetail.next_reason!)}>Next reasons</button>}<button onClick={()=>setReasonDetail(undefined)}>Close reasons</button></aside>}
      <div className="pagination">{past.length>0&&<button aria-disabled={busy} onClick={()=>void load(past.at(-1)!,past.slice(0,-1),true)}>Previous shared page</button>}
        {page.next_cursor&&<button aria-disabled={busy} onClick={()=>void load({cursor:page.next_cursor!,limit:size},[...past,{cursor:page.page_cursor,limit:page.limit,max_response_bytes:page.max_response_bytes}],true)}>Continue shared interval</button>}</div>
      {page.interval_complete&&!failure&&<p className="muted">Eligible shared changes in this named fixed interval have been retrieved. Personal attention and reading remain separate.</p>}
      <details className="notification-coverage"><summary>Coverage and recovery</summary><p>Traversal {page.traversal.id}. Complete selection; no grouping; ascending committed event order. Event-time relevance is separate from current location. New publications belong to later intervals.</p>
        <p>Retained-history start; {page.traversal.definitions.length} bound definitions. This view expires {new Date(page.traversal.expires_at).toLocaleString()}. Renewal preserves retained bounds.</p>
        <ul>{page.traversal.definitions.map((d,i)=><li key={i}>{d.target.kind} {d.target.resource_id} · version {d.version} · {d.include_descendants?'including descendants':'direct scope'} · {d.preferences.map(p=>preferenceLabels[p]).join(', ')}</li>)}</ul>
        <button aria-disabled={busy} onClick={()=>void load({recovery:{action:'replay',token:page.page_cursor}},[],true)}>Replay retained shared history</button>
        <button aria-disabled={busy} onClick={()=>void load({recovery:{action:'resynchronize',token:page.page_cursor}},[],true)}>Establish new baseline and inspect retained content</button>
        {page.baseline_established&&<><p>A new baseline is saved. Walk the bounded inventories below and their history/context links. Current inventory can change during paging; restart invalidated pages. Check newer shared changes afterward. No expired events or read state were reconstructed.</p>
          <ul>{page.inventory.map((i,n)=><li key={n}><a href={i.url}>{i.label}</a></li>)}</ul></>}
        <button aria-disabled={busy} onClick={()=>void clear()}>Clear saved shared change views</button>
      </details>
    </>}
  </div>;
}
