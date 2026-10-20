import { useAuthorization } from './AuthorizationBoundary.js';
import { useEffect,useRef,useState } from 'react';
import { Link,useLocation,useNavigate } from 'react-router';
import { CoverageDetail,Preparation,SourcePage,MaintenancePage,SummaryLookup,
  type CoverageView,type CoverageDetailView,type CoverageDeclarationValue,type PreparationView,type SourcePageView,
  type SourcePairValue,type MaintenancePageView,type SummaryLookupView } from '../contracts/summaries.js';
import { identityGeneration,ApiError,isDefinitiveRejection,type Intent } from './participation-client.js';
import { useQuery,useIntent,type Context } from './participation-state.js';
import { TopicDirectory } from './Organization.js';

export function CoverageState({value}:{value:CoverageView}) {
  return <div className="coverage-state">
    <p><strong>{value.scope==='full'?'Declared discussion scope':'Selected sources · partial scope'}</strong></p>
    {value.comparison==='work_limited'?<p>Comparison exceeds the supported source limit. Coverage is unknown; inspect sources in bounded pages.</p>
      :<p>{value.uncovered_eligible} eligible contributions outside this declaration · {value.changed_eligible} eligible covered contributions changed.</p>}
    {value.unknown&&<p>Some source coverage is unavailable or unknown. Protected sources and totals are not shown.</p>}
    {!value.unknown&&value.scope==='full'&&value.uncovered_eligible===0&&value.changed_eligible===0&&<p>No known gaps in the declared discussion scope.</p>}
    <p className="fineprint">An author's coverage claim does not establish reading or correctness.</p>
  </div>;
}
export function SummarySection({discussion}:{discussion:string}) {
  const result=useQuery<SummaryLookupView>(`/api/v1/discussions/${discussion}/summary`,SummaryLookup);
  return <section className="summary-card card" aria-label="Discussion summary">
    <h2>Summary</h2>
    {!result.data&&!result.error&&<p role="status">Checking for a summary…</p>}
    {result.error&&<><p role="alert">The summary could not be checked. Discussion reading and replies remain available.</p><button onClick={result.refresh}>Retry summary</button></>}
    {result.data?.state==='absent'&&<><p>No summary has been published.</p>{result.data.can_create&&<Link className="button" to={`/loom/discussion/${discussion}?summary=create`}>Create first summary</Link>}</>}
    {result.data?.state==='unavailable'&&<p>The summary is unavailable. The discussion's eligible contributions remain readable.</p>}
    {result.data?.state==='available'&&<><Link to={`/loom/resource/${result.data.summary.resource_id}`}>{result.data.summary.title??'Discussion summary'}</Link>
      <p className="fineprint">Revision {result.data.summary.revision_number} · published by {result.data.summary.publisher.nickname}. Open for text, sources, history and editors.</p></>}
    <Link to="/loom/summaries">Summary maintenance</Link>
  </section>;
}

export function SourceResults({path,selected,onSelect,disabled=false}:{path:string;selected?:SourcePairValue[];onSelect?:(value:SourcePairValue[])=>void;disabled?:boolean}) {
  const authority=useAuthorization();
  const [data,setData]=useState<SourcePageView>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[restart,setRestart]=useState(false);
  const live=useRef(false),sequence=useRef(0),attempt=useRef<string|null>(null),heading=useRef<HTMLHeadingElement>(null);
  async function load(cursor:string|null,focus=false) {
    const seq=++sequence.current,owner=identityGeneration();attempt.current=cursor;setBusy(true);setError('');setRestart(false);
    try {const value=await authority.read<SourcePageView>(path+'?'+new URLSearchParams({limit:'12',...(cursor?{cursor}:{})}),{schema:SourcePage});
      if(live.current&&seq===sequence.current&&owner===identityGeneration()){setData(value);if(focus)heading.current?.focus();}}
    catch(failure){if(live.current&&seq===sequence.current&&owner===identityGeneration()){setError((failure as Error).message);setRestart(failure instanceof ApiError&&failure.code==='summary_changed');}}
    finally{if(live.current&&seq===sequence.current&&owner===identityGeneration())setBusy(false);}
  }
  useEffect(()=>{live.current=true;setData(undefined);void load(null);return()=>{live.current=false;sequence.current++;};},[path]);
  return <div className="summary-sources" aria-busy={busy}>
    <h3 ref={heading} tabIndex={-1}>Source revisions</h3>
    {busy&&<p role="status">Loading source revisions…</p>}
    {error&&<><p role="alert">{error}</p>{data&&<p>The previous page is retained for context and may be out of date.</p>}
      {!restart&&<button type="button" onClick={()=>void load(attempt.current,true)}>Retry source page</button>}</>}
    <button type="button" disabled={busy} onClick={()=>void load(null,true)}>Refresh source view</button>
    <ul className="reference-list">{data?.items.map(item=>{
      const chosen=selected?.some(m=>m.contribution_id===item.source.resource_id&&m.revision_id===item.source.revision_id);
      const label=(item.source.title??'Comment by '+item.source.author.nickname)+' · revision '+item.source.revision_number;
      return <li className="reference-row" key={item.source.resource_id}>
        {onSelect&&<label><input type="checkbox" aria-label={'Select '+label} disabled={disabled||!!error||busy||!chosen&&(selected?.length??0)>=100} checked={!!chosen}
          onChange={event=>onSelect(event.target.checked?[...(selected??[]).filter(m=>m.contribution_id!==item.source.resource_id),{contribution_id:item.source.resource_id,revision_id:item.source.revision_id}]
            :(selected??[]).filter(m=>m.contribution_id!==item.source.resource_id))}/> Include this exact revision</label>}
        <Link to={item.browser_url}>{label}</Link> · <Link to={item.context_url}>Discussion context</Link>
        <p className="fineprint">{item.status} · published by {item.source.publisher.nickname}
          {item.declared_revision_id&&item.declared_revision_id!==item.source.revision_id&&<> · <Link to={`/loom/resource/${item.source.resource_id}/${item.declared_revision_id}`}>Declared earlier revision</Link></>}</p>
      </li>;
    })}</ul>
    {data?.unknown&&<p>Some members are unavailable or unknown; protected details and counts are omitted.</p>}
    {data&&!busy&&!error&&<>{!data.items.length&&<p>{data.complete?'No eligible source revisions in this view.':'No eligible entries in this bounded page. Continue to inspect later entries.'}</p>}
      {data.next_cursor?<button type="button" onClick={()=>void load(data.next_cursor,true)}>Next source revisions</button>:<p className="fineprint">End of this source view. Fetching sources does not mark them read.</p>}</>}
  </div>;
}
export function CoverageDetails({id,revision}:{id:string;revision:string}) {
  const result=useQuery<CoverageDetailView>(`/api/v1/summaries/${id}/revisions/${revision}/coverage`,CoverageDetail),[view,setView]=useState<'members'|'sources'|null>(null);
  return <section className="summary-card card" aria-label="Declared source coverage"><h2>Source coverage</h2>
    {result.error&&<><p role="alert">{result.error}</p><button onClick={result.refresh}>Retry coverage comparison</button></>}
    {!result.data&&!result.error&&<p role="status">Comparing declared sources…</p>}
    {result.data&&<><CoverageState value={result.data.coverage}/><div className="summary-actions"><button onClick={result.refresh}>Refresh coverage comparison</button>
      <button aria-expanded={view==='members'} onClick={()=>setView(view==='members'?null:'members')}>Inspect declared sources</button>
      <button aria-expanded={view==='sources'} onClick={()=>setView(view==='sources'?null:'sources')}>Inspect current discussion sources</button></div>
      {view&&<SourceResults key={view} path={view==='members'?result.data.members_url:result.data.sources_url}/>}</>}
  </section>;
}
function PreparedInspection({id}:{id:string}) {
  const result=useQuery<PreparationView>(`/api/v1/summary-preparations/${id}`,Preparation);
  return <div>{result.error&&<><p role="alert">{result.error}</p><button type="button" onClick={result.refresh}>Retry preparation details</button></>}
    {result.data&&<><p>{result.data.scope==='full'?'Full discussion snapshot':'Explicit partial selection'} · {result.data.eligible_members} currently eligible declared sources.
      {result.data.unknown?' Some declared sources are unavailable.':''}</p>
      <SourceResults path={result.data.members_url}/><details><summary>Preparation details</summary><code>{id}</code><p>Expires {new Date(result.data.expires_at).toLocaleString()}. Published coverage is retained independently.</p></details></>}
  </div>;
}
export function CoverageEditor({context,discussion,resource,base,value,disabled,onChange}:{context:Context;discussion:string;resource?:string|undefined;base?:string|undefined;
  value:CoverageDeclarationValue|undefined;disabled:boolean;onChange:(value:CoverageDeclarationValue)=>Promise<boolean>}) {
  const authority=useAuthorization();
  const resume=resource?`/loom/resource/${resource}?edit=1`:`/loom/discussion/${discussion}?summary=create`,slot='summary.prepare:'+resume;
  const [record,update]=useIntent(()=>context.store.all().find(r=>r.kind==='summary.prepare'&&r.slot===slot));
  const [scope,setScope]=useState<'full'|'selected'>(record?.body.scope==='selected'?'selected':'full');
  const [members,setMembers]=useState<SourcePairValue[]>((record?.body.members as SourcePairValue[]|undefined)??[]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const live=useRef(false),owner=useRef(identityGeneration());useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const current=()=>live.current&&owner.current===identityGeneration();
  async function prepare() {
    if(disabled||busy)return;setBusy(true);setError('');let sent:Intent|undefined,uncertain=false;
    try {
      sent=await update(async existing=>{uncertain=existing?.state==='uncertain';const body={discussion_id:discussion,scope,...(scope==='selected'?{members}:{})};
        return context.store.prepareDispatch(existing??context.store.create(slot,'summary.prepare','/api/v1/summary-preparations',body),body);});
      if(!sent)return;
      const prepared=await authority.read<PreparationView>('/api/v1/summary-preparations',{self:context.self,body:sent.body,schema:Preparation});
      if(!current())return;
      if(!await onChange({preparation_id:prepared.preparation_id}))throw new Error('The source declaration could not be saved with your draft. Retry the same preparation to recover it.');
      await update(async existing=>{await context.store.complete(sent!);return existing?.key===sent!.key?undefined:existing;});
    }catch(failure){if(sent&&isDefinitiveRejection(failure,uncertain))try {await update(()=>context.store.settle(sent!,{state:'rejected'}));}
      catch(storageFailure){if(current())setError((storageFailure as Error).message);return;}
      if(current())setError((failure as Error).message);
    }finally{if(current())setBusy(false);}
  }
  const locked=disabled||busy||record?.state==='uncertain'||record?.state==='rejected';
  return <fieldset className="coverage-editor" disabled={disabled}>
    <legend>Declared source coverage</legend><p>Choose a fixed set of opening-post and comment revisions. Later contributions stay outside it. Inspect exact sources before publishing.</p>
    {value&&'preparation_id' in value&&<PreparedInspection key={value.preparation_id} id={value.preparation_id}/>}
    {value&&'carry_forward_revision_id' in value&&<p>Keeping the previous declaration unchanged. This does not claim any later sources.</p>}
    {base&&<button type="button" disabled={locked} onClick={()=>void onChange({carry_forward_revision_id:base})}>Keep declaration from revision being edited</button>}
    <label>Source scope<select value={scope} disabled={locked} onChange={e=>setScope(e.target.value as 'full'|'selected')}>
      <option value="full">Full eligible discussion at preparation</option><option value="selected">Explicit selection (partial)</option></select></label>
    {scope==='selected'&&<><p>{members.length} exact revisions selected; at most 100. Selection remains partial.</p>
      <SourceResults path={`/api/v1/discussions/${discussion}/summary-sources`} selected={members} onSelect={setMembers} disabled={!!locked}/></>}
    {error&&<p role="alert">{error}</p>}{busy&&<p role="status">Preparing declared sources…</p>}
    {record?.state==='rejected'?<button type="button" onClick={()=>void update(async existing=>{await context.store.remove(existing!);return undefined;}).catch(f=>setError(f.message))}>Prepare a new source request</button>
      :<button type="button" disabled={disabled||busy} onClick={()=>void prepare()}>{record?.state==='uncertain'?'Retry same source preparation':'Prepare declared sources'}</button>}
    {record?.state==='uncertain'&&<p>The exact source request is retained locally. Retrying recovers its original set; it never selects newer sources silently.</p>}
    <p className="fineprint">Preparing and inspecting sources publishes nothing and does not record reading progress.</p>
  </fieldset>;
}

export function SummaryMaintenance({context}:{context:Context}) {
  void context;
  const location=useLocation(),navigate=useNavigate(),params=new URLSearchParams(location.search),[chooseTopic,setChooseTopic]=useState(false);
  const allowed=['filter','editable','topic','descendants','cursor'],query=new URLSearchParams([...params].filter(([key])=>allowed.includes(key)));
  const result=useQuery<MaintenancePageView>('/api/v1/summaries/maintenance?'+query,MaintenancePage),heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{if(result.data&&params.has('cursor'))heading.current?.focus();},[result.data]);
  function change(key:string,value:string){const next=new URLSearchParams(query);next.delete('cursor');if(value)next.set(key,value);else next.delete(key);if(key==='topic'&&!value)next.delete('descendants');void navigate('/loom/summaries?'+next);}
  return <><h1 ref={heading} tabIndex={-1}>Summary maintenance</h1><p>Discover declared source gaps and current editors. These are content states, not assigned jobs.</p>
    <label>Maintenance condition<select value={params.get('filter')??''} onChange={e=>change('filter',e.target.value)}><option value="">All summaries</option>
      <option value="uncovered">Uncovered contributions</option><option value="changed">Changed covered contributions</option><option value="partial">Partial scope</option>
      <option value="unknown">Unknown or unavailable coverage</option><option value="no_active_editor">No active editor</option></select></label>
    <label>Editing eligibility<select value={params.get('editable')??''} onChange={e=>change('editable',e.target.value)}><option value="">Any</option><option value="true">I can edit</option><option value="false">I cannot edit</option></select></label>
    <button onClick={()=>setChooseTopic(v=>!v)}>Choose maintenance topic</button>{params.has('topic')&&<><button onClick={()=>change('topic','')}>Clear maintenance topic</button>
      <label><input type="checkbox" checked={params.get('descendants')==='true'} onChange={e=>change('descendants',String(e.target.checked))}/>Include descendant topics</label></>}
    {chooseTopic&&<TopicDirectory selectionLabel="Choose maintenance topic" select={area=>{change('topic',area.resource_id);setChooseTopic(false);}}/>}
    {result.error&&<><p role="alert">{result.error}</p><button onClick={result.refresh}>Retry maintenance page</button></>}
    {!result.data&&!result.error&&<p role="status">Checking summary maintenance…</p>}
    <button onClick={()=>{change('cursor','');result.refresh();}}>Refresh maintenance</button>
    {result.data&&<><ul className="summary-list">{result.data.items.map(item=><li className="summary-card card" key={item.summary.resource_id}>
      <h2><Link to={item.browser_url}>{item.summary.title}</Link></h2><p>{item.summary.area_title} · Editors: {item.editors.map(p=>p.nickname).join(', ')||'None'}{item.no_active_editor?' · No active editor':''}</p>
      <CoverageState value={item.coverage}/><Link to={`/loom/discussion/${item.summary.discussion_id}`}>Underlying discussion</Link>{' '}
      {item.summary.can_edit&&<Link to={item.browser_url+'?edit=1'}>Update summary</Link>}</li>)}</ul>
      {!result.data.items.length&&<p>{result.data.complete?'No eligible matching summaries in this view.':'No eligible matches in this bounded page. Continue to inspect later candidates.'}</p>}
      {result.data.next_cursor&&<button onClick={()=>{const next=new URLSearchParams(query);next.set('cursor',result.data!.next_cursor!);void navigate('/loom/summaries?'+next);}}>Next maintenance page</button>}
      <p className="fineprint">Each page inspects at most ten summaries. Source comparison is independently bounded; indexing is not required.</p></>}
  </>;
}
