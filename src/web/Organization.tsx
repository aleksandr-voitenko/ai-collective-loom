import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { OrganizationResource, OrganizationPage as PageSchema, OrganizationCommitted, OrganizationReconciled, MetadataHistory,
  type OrganizationResourceView, type OrganizationPageView, type OrganizationResult } from '../contracts/organization.js';
import { identityGeneration, isDefinitiveRejection, request, type Intent } from './participation-client.js';
import { useQuery, useIntent, SeparateDraft, type Context } from './participation-state.js';

function pathText(area:OrganizationResourceView) { return [...area.ancestors.map(a=>a.title),area.title].join(' › '); }
export function TopicLocation({area}:{area:OrganizationResourceView}) {
  return <nav className="breadcrumb" aria-label="Topic ancestry"><Link to="/loom">Topics</Link>{area.ancestors.map(parent=><span key={parent.id}> › <Link to={'/loom/area/'+parent.id}>{parent.title}</Link></span>)}<span> › {area.title}</span></nav>;
}
export function TopicDirectory({parent,select}:{parent?:string;select?:(area:OrganizationResourceView)=>void}) {
  const [cursor,setCursor]=useState(''),[previous,setPrevious]=useState<string[]>([]);
  const base='/api/v1/organization/'+(select?'destinations':'children');
  const query=new URLSearchParams({...(!select&&parent?{parent_id:parent}:{}),...(cursor?{cursor}:{})});
  const result=useQuery<OrganizationPageView>(base+'?'+query,PageSchema),last=useRef<OrganizationPageView|undefined>(undefined),heading=useRef<HTMLHeadingElement>(null);
  if(result.data) last.current=result.data;
  useEffect(()=>{if(result.data && previous.length) heading.current?.focus();},[result.data]);
  const data=result.data??last.current;
  return <section className="topic-directory" aria-label={select?'Move destinations':parent?'Subtopics':'Root topics'}>
    <h2 tabIndex={-1} ref={heading}>{select?'Choose a destination':parent?'Subtopics':'Root topics'}</h2>
    {result.error&&<p role="alert">{result.error} The previous page may be out of date.</p>}
    {!result.data&&!result.error&&<p role="status">Loading topics…</p>}
    <div className="collection" aria-busy={!result.data&&!result.error}>
      {data?.items.map(area=><div className="list-row" key={area.resource_id}>
        <div><h3>{select?pathText(area):<Link to={'/loom/area/'+area.resource_id}>{area.title}</Link>}</h3>
          <p>{area.description}</p><small>{area.publication_open?'Open to contributions':'Closed to contributions'}</small>
          {select&&<small className="destination-id">Topic ID: {area.resource_id}</small>}
        </div>{select&&<button type="button" disabled={!result.data} onClick={()=>select(area)} aria-label={'Select '+pathText(area)}>Select</button>}
      </div>)}
      {result.data&&!data?.items.length&&<p>{data?.complete?'No topics here yet.':'Continue to the next page of topics.'}</p>}
    </div>
    <div className="pagination"><button type="button" onClick={()=>{setCursor('');setPrevious([]);result.refresh();}}>Refresh topics</button>
      {result.error&&<button type="button" onClick={result.refresh}>Retry topics page</button>}
      <button type="button" disabled={!previous.length||!result.data} onClick={()=>{setCursor(previous.at(-1)!);setPrevious(p=>p.slice(0,-1));}}>Previous topics</button>
      <button type="button" disabled={!result.data?.next_cursor} onClick={()=>{setPrevious(p=>[...p,cursor].slice(-100));setCursor(result.data!.next_cursor!);}}>Next topics</button>
    </div>
  </section>;
}
export function OrganizationActions({id,kind,localOpen}:{id:string;kind:'area'|'discussion'|'artifact';localOpen?:boolean}) {
  const url=(action:string)=>'/loom/organize?target='+id+'&action='+action;
  return <div className="organization-actions" aria-label="Organization controls">
    {kind==='area'&&<><Link className="button" to={'/loom/organize?action=area.create&parent='+id}>Create subtopic</Link><Link className="button" to={url('area.edit')}>Edit topic</Link></>}
    <Link className="button" to={url(kind+'.move')}>Move {kind==='area'?'topic':kind}</Link>
    {kind==='area'&&<Link className="button" to={url(localOpen?'area.close':'area.open')}>{localOpen?'Close topic':'Reopen topic'}</Link>}
  </div>;
}
export function OrganizationRecovery({context}:{context:Context}) {
  const records=context.store.all().filter(r=>r.kind==='organization.change');
  return records.length?<aside className="notice"><h2>Organization drafts and recovery</h2>{records.map(r=><p key={r.key}><Link to={'/loom/organize?intent='+r.key}>{String(r.body.kind)} · {r.state}</Link></p>)}</aside>:null;
}
export function OrganizationPage({context}:{context:Context}) {
  const query=new URLSearchParams(useLocation().search),selected=query.get('intent');
  const initial=context.store.all().find(r=>r.kind==='organization.change'&&(selected?r.key===selected:r.slot==='organization:'+(query.get('action')??'area.create')+':'+(query.get('target')||query.get('parent')||'root')));
  const target=String(initial?.body.resource_id??query.get('target')??''),parent=String(initial?.body.parent_id??query.get('parent')??'');
  const kind=String(initial?.body.kind??query.get('action')??'area.create');
  const source=useQuery<OrganizationResourceView>(target?'/api/v1/organization/resources/'+target:parent?'/api/v1/organization/resources/'+parent:'/api/v1/organization/children?limit=1',target||parent?OrganizationResource:PageSchema);
  if(context.self.role!=='administrator') return <p role="alert">Administrator access is required.</p>;
  if(selected&&!initial) return <p role="alert">This organization record is no longer available. It may have been resolved in another view.</p>;
  if(source.error) return <><p role="alert">{source.error} Any saved intent is retained in Local drafts.</p><button onClick={source.refresh}>Retry organization context</button></>;
  if(!source.data) return <p role="status">Loading organization context…</p>;
  return <OrganizationForm context={context} initial={initial} kind={kind} target={target} parent={parent} source={target||parent?source.data:undefined} epoch={source.data.hierarchy_version}/>;
}
function OrganizationForm({context,initial,kind,target,parent,source,epoch}:{context:Context;initial:Intent|undefined;kind:string;target:string;parent:string;source:OrganizationResourceView|undefined;epoch:number}) {
  const navigate=useNavigate(),[record,update]=useIntent(()=>initial);
  const [body,setBody]=useState<Record<string,unknown>>(()=>initial?.body??{
    kind,expected_hierarchy_version:epoch,...(target?{resource_id:target,expected_version:source!.version}:{}),
    ...(kind==='area.create'?{parent_id:parent||null,title:'',description:''}:{}),
    ...(kind==='area.edit'?{title:source!.title,description:source!.description}:{}),
    ...(kind.endsWith('.move')?{parent_id:source!.parent_id}:{}),
  });
  const [destination,setDestination]=useState<OrganizationResourceView>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[result,setResult]=useState<OrganizationResult>(),[status,setStatus]=useState('');
  const live=useRef(true),owner=useRef(identityGeneration());
  useEffect(()=>()=>{live.current=false;},[]);
  useEffect(()=>{
    if(!body.parent_id || !kind.endsWith('.move')) {setDestination(undefined);return;}
    let active=true;
    void request<OrganizationResourceView>('/api/v1/organization/resources/'+String(body.parent_id),{schema:OrganizationResource})
      .then(value=>{if(active&&owner.current===identityGeneration())setDestination(value);})
      .catch(()=>{if(active)setDestination(undefined);});
    return ()=>{active=false;};
  },[body.parent_id,kind]);
  const owned=()=>live.current&&owner.current===identityGeneration();
  const locked=busy||!!record&&(record.state!=='draft'||!!record.blocked_by);
  const slot='organization:'+kind+':'+(target||parent||'root');
  async function draft(next:Record<string,unknown>) {
    setBody(next);
    try {await update(current=>context.store.saveDraft(current??context.store.create(slot,'organization.change','/api/v1/organization/changes',next),next));if(owned())setError('');}
    catch(e){if(owned())setError((e as Error).message);}
  }
  async function accepted(value:OrganizationResult,intent:Intent) {
    await update(async current=>{const next=await context.store.settle(intent,{state:'committed'});return current?.key===intent.key?next:current;});
    if(owned()){setResult(value);setStatus('Organization change confirmed.');}
  }
  async function send() {
    if(busy||record?.blocked_by) return;
    setBusy(true);setError('');let intent:Intent|undefined,wasUncertain=false;
    try {
      intent=await update(async current=>{wasUncertain=current?.state==='uncertain';return context.store.prepareDispatch(current??context.store.create(slot,'organization.change','/api/v1/organization/changes',body),body);});
      if(intent) await accepted(await request<OrganizationResult>('/api/v1/organization/changes',{self:context.self,body:intent.body,schema:OrganizationCommitted}),intent);
    }catch(e){
      if(intent&&isDefinitiveRejection(e,wasUncertain)) {try {await update(current=>context.store.settle(intent!,{state:'rejected'}).then(next=>current?.key===intent!.key?next:current));}catch(storage){if(owned())setError((storage as Error).message);}}
      if(owned())setError((e as Error).message);
    }finally{if(owned())setBusy(false);}
  }
  async function check() {
    if(!record||busy)return;setBusy(true);setError('');
    try {const value=await request<OrganizationResult|{operation_state:'not_recorded'}>('/api/v1/organization/status',{self:context.self,body:{kind:record.body.kind,idempotency_key:record.key},schema:OrganizationReconciled});
      if(value.operation_state==='committed')await accepted(value,record);else if(owned())setStatus('Confirmation is unavailable. Keep this exact request; it may still commit.');
    }catch(e){if(owned())setError((e as Error).message);}finally{if(owned())setBusy(false);}
  }
  async function correct() {
    if(record?.state!=='rejected')return;setBusy(true);
    try {
      const current=await request<OrganizationResourceView|OrganizationPageView>(target?'/api/v1/organization/resources/'+target:'/api/v1/organization/children?limit=1');
      if(!owned())return;
      const next={...body,expected_hierarchy_version:current.hierarchy_version,...('version' in current?{expected_version:current.version}:{})};
      await update(r=>context.store.correct(r!,next));if(owned()){setBody(next);setError('');setStatus('Latest versions loaded. Review source and destination before confirming.');}
    }catch(e){if(owned())setError((e as Error).message);}finally{if(owned())setBusy(false);}
  }
  const move=kind.endsWith('.move'),metadata=kind==='area.create'||kind==='area.edit';
  return <section className="organization-form"><Link to={target&&source?.kind==='area'?'/loom/area/'+target:'/loom'}>← Back to topics</Link>
    <h1>{kind==='area.create'?'Create topic':kind==='area.edit'?'Edit topic':move?'Move '+(source?.kind==='area'?'topic':source?.kind??'resource'):kind==='area.close'?'Close topic':'Reopen topic'}</h1>
    {source&&<p className="notice">{target?'Source':'Parent'}: <strong>{pathText(source)}</strong><br/><small>Resource ID: {source.resource_id}</small></p>}
    {!target&&!parent&&<p>Parent: Community root</p>}
    {error&&<p role="alert" className="notice error">{error}</p>}{status&&<p role="status">{status}</p>}
    <SeparateDraft record={record} review={()=>void update(r=>{const next={...r!};delete next.blocked_by;return context.store.save(next);}).catch(e=>setError(e.message))}/>
    <form onSubmit={e=>{e.preventDefault();void send();}}>
      {metadata&&<><label>Topic title<input value={String(body.title??'')} maxLength={160} disabled={locked} onChange={e=>void draft({...body,title:e.target.value})}/></label>
        <label>Scope description<textarea value={String(body.description??'')} maxLength={2048} disabled={locked} onChange={e=>void draft({...body,description:e.target.value})}/></label></>}
      {move&&<><p>Destination: <strong>{destination?pathText(destination):body.parent_id===null?'Community root':body.parent_id===source?.parent_id?source?.ancestors.map(a=>a.title).join(' › '):String(body.parent_id)}</strong></p>
        <p className="notice">Confirm moving <strong>{source?.title}</strong> from <strong>{source?.ancestors.map(a=>a.title).join(' › ')||'Community root'}</strong> to <strong>{destination?pathText(destination):body.parent_id===null?'Community root':String(body.parent_id)}</strong>. Its stable ID and retained content will stay the same.</p>
        {!locked&&<>{kind==='area.move'&&<button type="button" onClick={()=>{setDestination(undefined);void draft({...body,parent_id:null});}}>Use community root</button>}
          <TopicDirectory select={area=>{setDestination(area);void draft({...body,parent_id:area.resource_id});}}/></>}
      </>}
      {kind==='area.close'&&<p>Close this topic and its descendants to new discussions, replies, artifacts and text revisions. Retained content stays readable.</p>}
      {kind==='area.open'&&<p>Remove this topic’s local closure. Other ancestor and descendant restrictions remain in effect.</p>}
      {(!record||record.state==='draft')&&<button className="primary" disabled={locked} type="submit">{move?'Confirm move':kind==='area.close'?'Confirm close':kind==='area.open'?'Confirm reopen':'Save topic'}</button>}
    </form>
    {busy&&<p role="status">Waiting for confirmation…</p>}
    {record?.state==='uncertain'&&!busy&&<div className="notice"><p>We couldn’t confirm whether this organization change completed.</p><button onClick={()=>void check()}>Check organization status</button><button onClick={()=>void send()}>Retry same organization change</button></div>}
    {record?.state==='rejected'&&<button disabled={busy} onClick={()=>void correct()}>Review latest organization and prepare correction</button>}
    {record?.state==='committed'&&!result&&<button disabled={busy} onClick={()=>void check()}>Check organization status</button>}
    {result&&<div className="notice"><p>Original result: version {result.outcome.version}, parent {result.outcome.parent_id??'Community root'}.</p><p>Current location: {pathText(result.current)} · version {result.current.version} · {result.current.publication_open?'Open':'Closed'}.</p>
      <Link to={result.current.kind==='area'?'/loom/area/'+result.current.resource_id:result.current.kind==='discussion'?'/loom/discussion/'+result.current.resource_id:'/loom/resource/'+result.current.resource_id}>View current location</Link>
      <button onClick={()=>void context.store.remove(record!).then(()=>{if(owned())void navigate('/loom');}).catch(e=>setError(e.message))}>Dismiss resolved organization change</button>
    </div>}
  </section>;
}
export function TopicMetadataHistory({id}:{id:string}) {
  const [open,setOpen]=useState(false),[cursor,setCursor]=useState('');
  return <details onToggle={e=>setOpen(e.currentTarget.open)}><summary>Topic metadata history</summary>{open&&<MetadataPage id={id} cursor={cursor} next={setCursor}/>}</details>;
}
function MetadataPage({id,cursor,next}:{id:string;cursor:string;next:(value:string)=>void}) {
  const {data,error,refresh}=useQuery<{items:{id:string;version:number;title:string;description:string;publisher:{nickname:string}|null;baseline:boolean}[];next_cursor:string|null}>('/api/v1/areas/'+id+'/metadata-history'+(cursor?'?cursor='+encodeURIComponent(cursor):''),MetadataHistory);
  return <>{error&&<><p role="alert">{error}</p><button onClick={refresh}>Retry metadata history</button></>}{!data&&!error&&<p role="status">Loading metadata history…</p>}{data?.items.map(item=><article className="card" key={item.id}><h3>{item.title} · {item.version}</h3><p>{item.description}</p><small>{item.publisher?.nickname??'Unattributed upgrade baseline'}</small></article>)}<button disabled={!data?.next_cursor} onClick={()=>next(data!.next_cursor!)}>Next metadata revisions</button></>;
}
