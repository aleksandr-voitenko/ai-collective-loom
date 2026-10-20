import { useAuthorization } from './AuthorizationBoundary.js';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ReferenceValue, ReferenceTargetValue } from '../contracts/participation.js';
import { ResolvedTarget, ReferencePage, type ResolvedTargetView, type ReferencePageView, type ReferenceEntryView } from '../contracts/references.js';
import {  identityGeneration, ApiError } from './participation-client.js';

const labels = { related_to: 'Related to', builds_on: 'Builds on', contradicts: 'Contradicts' };
const targetLabel = (target:ReferenceTargetValue) => target.kind === 'discussion' ? 'Discussion container'
  : target.revision_id ? 'Exact revision' : target.kind === 'artifact' ? 'Artifact resource' : target.kind === 'summary' ? 'Summary resource' : 'Contribution resource';
export function targetFromSelection(value:string,kind:ReferenceTargetValue['kind'],scope:string,revision:string):ReferenceTargetValue {
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let id=value.trim(),exact=revision.trim();
  if(!uuid.test(id)){
    const url=new URL(id,location.origin);
    if(url.origin!==location.origin || url.username || url.password || url.hash)throw new Error('Use a Loom link from this instance or a resource ID.');
    const match=/^\/(?:loom\/resource|api\/v1\/resources)\/([0-9a-f-]{36})(?:\/(?:revisions\/)?([0-9a-f-]{36}))?\/?$/i.exec(url.pathname);
    const discussion=/^\/loom\/discussion\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
    if(discussion){kind='discussion';id=discussion[1]!;}
    else if(match){id=match[1]!;if(match[2])exact=match[2];}
    else throw new Error('Use a supported Loom resource, discussion or exact-revision link.');
  }
  if(!uuid.test(id)||(scope==='revision'&&(!uuid.test(exact)||kind==='discussion')))throw new Error('Choose a supported resource and, for an exact citation, its revision ID.');
  return {kind,resource_id:id.toLowerCase(),...(scope==='revision'?{revision_id:exact.toLowerCase()}:{})};
}

export function ReferenceEditor({references,onChange,disabled}:{references:ReferenceValue[];onChange:(next:ReferenceValue[])=>void;disabled:boolean}){
  const authority=useAuthorization();
  const [picker,setPicker]=useState(false),[editing,setEditing]=useState<string>(),[value,setValue]=useState(''),
    [kind,setKind]=useState<ReferenceTargetValue['kind']>('artifact'),[scope,setScope]=useState('resource'),[revision,setRevision]=useState(''),
    [selected,setSelected]=useState<ResolvedTargetView>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const live=useRef(false),sequence=useRef(0),add=useRef<HTMLButtonElement>(null),input=useRef<HTMLInputElement>(null);
  useEffect(()=>{live.current=true;return()=>{live.current=false;sequence.current++;};},[]);
  function invalidate(){sequence.current++;setSelected(undefined);setError('');setBusy(false);}
  function open(ref?:ReferenceValue){invalidate();setEditing(ref?.reference_id);setValue(ref?.target.resource_id??'');setKind(ref?.target.kind??'artifact');
    setRevision(ref?.target.revision_id??'');setScope(ref?.target.revision_id?'revision':'resource');setPicker(true);}
  useEffect(()=>{if(picker)input.current?.focus();},[picker]);
  async function validate(){
    const seq=++sequence.current,owner=identityGeneration();setBusy(true);setError('');setSelected(undefined);
    try{
      const target=targetFromSelection(value,kind,scope,revision),query=new URLSearchParams(target);
      const result=await authority.read<ResolvedTargetView>('/api/v1/references/target?'+query,{schema:ResolvedTarget});
      if(live.current&&seq===sequence.current&&owner===identityGeneration())setSelected(result);
    }catch(failure){if(live.current&&seq===sequence.current&&owner===identityGeneration())setError((failure as Error).message);}
    finally{if(live.current&&seq===sequence.current&&owner===identityGeneration())setBusy(false);}
  }
  function confirm(){
    if(!selected)return;
    const ref:ReferenceValue={reference_id:editing??crypto.randomUUID(),target:selected.target,
      relationship:references.find(r=>r.reference_id===editing)?.relationship??null,rationale:references.find(r=>r.reference_id===editing)?.rationale??null};
    if(references.some(r=>r.reference_id!==editing&&r.target.resource_id===ref.target.resource_id&&r.target.revision_id===ref.target.revision_id)){
      setError('This target scope is already in the reference list. Change the existing reference.');return;
    }
    onChange(editing?references.map(r=>r.reference_id===editing?ref:r):[...references,ref]);setPicker(false);invalidate();add.current?.focus();
  }
  return <fieldset className="reference-editor" disabled={disabled}>
    <legend>Recorded references</legend>
    <p className="fineprint">Changes belong to this source and take effect only when you publish. Ordinary links stay ordinary links.</p>
    {references.map((ref,index)=><div className="reference-draft" key={ref.reference_id}>
      <strong>Reference {index+1} · {targetLabel(ref.target)}</strong>
      <details><summary>Target details</summary><code>{ref.target.resource_id}</code>{ref.target.revision_id&&<p>Revision <code>{ref.target.revision_id}</code></p>}</details>
      <label>Relationship {index+1}<select value={ref.relationship??''} onChange={event=>onChange(references.map(r=>r.reference_id===ref.reference_id?{...r,relationship:(event.target.value||null) as ReferenceValue['relationship']}:r))}>
        <option value="">Untyped reference</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>Rationale {index+1}{['builds_on','contradicts'].includes(ref.relationship??'')?' (required)':' (optional)'}
        <textarea rows={2} maxLength={512} value={ref.rationale??''} onChange={event=>onChange(references.map(r=>r.reference_id===ref.reference_id?{...r,rationale:event.target.value||null}:r))}/>
      </label>
      <div className="composer-tools"><button type="button" onClick={()=>open(ref)}>Change target {index+1}</button>
        <button type="button" onClick={()=>{onChange(references.filter(r=>r.reference_id!==ref.reference_id));add.current?.focus();}}>Remove reference {index+1}</button></div>
    </div>)}
    <button type="button" ref={add} disabled={disabled||references.length>=16} onClick={()=>open()}>Add reference</button>
    {picker&&<div className="reference-picker" role="group" aria-label="Choose reference target">
      <label>Target ID or Loom link<input ref={input} value={value} onChange={event=>{invalidate();setValue(event.target.value);}}/></label>
      <label>Target kind<select value={kind} onChange={event=>{invalidate();setKind(event.target.value as ReferenceTargetValue['kind']);if(event.target.value==='discussion')setScope('resource');}}>
        <option value="artifact">Text artifact</option><option value="summary">Discussion summary</option><option value="contribution">Opening post or comment</option><option value="discussion">Discussion container</option>
      </select></label>
      <label>Citation scope<select value={scope} onChange={event=>{invalidate();setScope(event.target.value);}}>
        <option value="resource">Resource only (current content)</option><option value="revision" disabled={kind==='discussion'}>Exact revision (fixed version)</option>
      </select></label>
      {scope==='revision'&&<label>Exact revision ID (or include it in the link)<input value={revision} onChange={event=>{invalidate();setRevision(event.target.value);}}/></label>}
      <p className="fineprint">A resource-only citation does not say which version you examined. A discussion container differs from its opening post.</p>
      <button type="button" disabled={busy} onClick={()=>void validate()}>Check target</button>{busy&&<p role="status">Checking target…</p>}
      {error&&<p role="alert">{error}</p>}
      {selected&&<div className="notice neutral"><strong>{selected.representation.title??'Contribution by '+selected.representation.author.nickname}</strong>
        <p>{targetLabel(selected.target)} · {selected.representation.area_title}{selected.scope==='revision'?` · revision ${selected.representation.revision_number}`:''}</p>
        <button type="button" onClick={confirm}>{selected.scope==='revision'?'Use this exact revision':'Use this resource'}</button></div>}
      <button type="button" onClick={()=>{setPicker(false);invalidate();add.current?.focus();}}>Cancel reference selection</button>
    </div>}
  </fieldset>;
}

function ReferenceItem({item}:{item:ReferenceEntryView}){
  const membership:Record<string,string>={current:'Current source membership',carried_forward:'Historical membership · carried forward',changed:'Historical membership · later changed',withdrawn:'Historical membership · withdrawn',current_unavailable:'Historical membership · current state unavailable',historical_note:'Historical revision-owned note assertion'};
  return <li className="reference-row">
    <Link to={item.source_browser_url}>{item.source.title??'Contribution by '+item.source.author.nickname} · source revision {item.source.revision_number}</Link>
    <p>{item.declaration.relationship?labels[item.declaration.relationship]:'References'} → {item.target.state==='available'
      ? <Link to={item.target.browser_url}>{item.target.representation.title??'Contribution by '+item.target.representation.author.nickname}</Link>:'Target unavailable'}
      {' · '}{targetLabel(item.declaration.target)}</p>
    {item.declaration.rationale!==null&&<p className="reference-rationale">{item.declaration.rationale}</p>}
    <p className="fineprint">{membership[item.membership]}. Asserted by {item.original_assertion.participant.nickname} on {new Date(item.original_assertion.published_at).toLocaleString()}.
      {' '}Last assertion change by {item.last_assertion_change.participant.nickname} on {new Date(item.last_assertion_change.published_at).toLocaleString()}.</p>
    <p className="fineprint">{item.source_field==='change_note'?'Revision note':'Main content'} · Source revision published by {item.source.publisher.nickname} on {new Date(item.source.created_at).toLocaleString()} · {item.source.area_title} · <Link to={item.source_context_url}>Source context</Link></p>
    {item.withdrawal&&<p className="fineprint">Withdrawn by {item.withdrawal.participant.nickname} on {new Date(item.withdrawal.published_at).toLocaleString()} · <Link to={`/loom/resource/${item.source.resource_id}/${item.withdrawal.revision_id}`}>Withdrawal revision</Link></p>}
    <details><summary>Reference details</summary><code>{item.declaration.reference_id}</code><p>Direction: source to target. <a href={item.source.full_content_url}>Full source API representation</a></p></details>
  </li>;
}
export function ReferenceResults({path}:{path:string}){
  const authority=useAuthorization();
  const [data,setData]=useState<ReferencePageView>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[restart,setRestart]=useState(false);
  const live=useRef(false),sequence=useRef(0),attempt=useRef<string|null>(null),heading=useRef<HTMLHeadingElement>(null);
  async function load(cursor:string|null,focus=false){
    const seq=++sequence.current,owner=identityGeneration();attempt.current=cursor;setBusy(true);setError('');setRestart(false);
    try{const result=await authority.read<ReferencePageView>(path+(path.includes('?')?'&':'?')+new URLSearchParams({limit:'12',...(cursor?{cursor}:{})}),{schema:ReferencePage});
      if(live.current&&seq===sequence.current&&owner===identityGeneration()){setData(result);if(focus)heading.current?.focus();}}
    catch(failure){if(live.current&&seq===sequence.current&&owner===identityGeneration()){
      setError((failure as Error).message);setRestart(failure instanceof ApiError&&failure.code==='references_changed');}}
    finally{if(live.current&&seq===sequence.current&&owner===identityGeneration())setBusy(false);}
  }
  useEffect(()=>{live.current=true;void load(null);return()=>{live.current=false;sequence.current++;};},[path]);
  return <div className="reference-results" aria-busy={busy}>
    <h3 ref={heading} tabIndex={-1}>Recorded reference results</h3>
    {busy&&<p role="status">Loading references…</p>}
    {error&&<><p role="alert">{error}</p>{data&&<p>The previous page remains visible; it does not establish the current selection.</p>}
      {!restart&&<button onClick={()=>void load(attempt.current,true)}>Retry reference page</button>}</>}
    <button disabled={busy} onClick={()=>void load(null,true)}>Refresh references</button>
    {data&&<><ul className="reference-list">{data.items.map(item=><ReferenceItem key={item.source.revision_id+item.source_field+item.declaration.reference_id} item={item}/>)}</ul>
      {!busy&&!error&&data.items.length===0&&<p>{data.complete?'No recorded references in this scope.':'No eligible entries in this bounded page. More candidates remain.'}</p>}
      <p className="fineprint">Bodies are available through exact links. Other target scopes are excluded. {data.work_budget_reached?'This page reached its scan limit.':''}</p>
      {!error&&data.next_cursor&&<button disabled={busy} onClick={()=>void load(data.next_cursor,true)}>Next references</button>}
      {!busy&&!error&&data.complete&&<p>End of this selected reference view.</p>}</>}
  </div>;
}
export function ReferenceViews({sourceId,sourceRevision,target}:{sourceId?:string;sourceRevision?:string;target:ReferenceTargetValue}){
  const [view,setView]=useState<'outgoing'|'incoming'|null>(null),[history,setHistory]=useState('current'),
    [scope,setScope]=useState(target.revision_id?'revision':'resource'),[relationship,setRelationship]=useState('');
  const region=useId();
  const exact=target.revision_id??(target.kind!=='discussion'?sourceRevision:undefined);
  const query=new URLSearchParams({kind:target.kind,resource_id:target.resource_id,history,
    ...(scope==='revision'&&exact?{revision_id:exact}:{}),...(relationship?{relationship}:{})});
  const path=view==='outgoing'?`/api/v1/resources/${sourceId}/revisions/${sourceRevision}/references`:'/api/v1/references/incoming?'+query;
  return <section className="reference-views" aria-label={target.kind==='discussion'?'Discussion references':'Source references'}>
    <div className="composer-tools">{sourceId&&sourceRevision&&<button aria-expanded={view==='outgoing'} aria-controls={region} onClick={()=>setView(view==='outgoing'?null:'outgoing')}>References</button>}
      <button aria-expanded={view==='incoming'} aria-controls={region} onClick={()=>setView(view==='incoming'?null:'incoming')}>Referenced by{target.kind==='discussion'?' · discussion':''}</button></div>
    {view&&<div id={region}>
      {view==='outgoing'?<p>Outgoing references from this exact source revision.</p>:<>
        <label>Incoming target scope<select value={scope} onChange={event=>setScope(event.target.value)}><option value="resource">{target.kind==='discussion'?'Discussion container only':'Resource only'}</option>
          {exact&&<option value="revision">This exact revision only</option>}</select></label>
        <label>Source membership<select value={history} onChange={event=>setHistory(event.target.value)}><option value="current">Current source revisions</option><option value="all">Historical memberships, including withdrawals</option></select></label>
        <label>Relationship filter<select value={relationship} onChange={event=>setRelationship(event.target.value)}><option value="">All relationships</option><option value="untyped">Untyped references</option>
          {Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      </>}
      <ReferenceResults key={path} path={path}/>
    </div>}
  </section>;
}
