import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { NoteContent, ChangeAccountValue, ExactChangeTargetValue, RevisionView, PageView } from '../contracts/participation.js';
import { Page, Revision } from '../contracts/participation.js';
import { NoteDetail, ChangeCoverage, ChangeDiscovery, type NoteDetailView, type ChangeCoverageView, type ChangeDiscoveryView } from '../contracts/changes.js';
import { ResolvedTarget, type ResolvedTargetView } from '../contracts/references.js';
import { request, identityGeneration, ApiError } from './participation-client.js';
import { useQuery } from './participation-state.js';
import { AuthoredText } from './AuthoredText.js';
import { ReferenceEditor, targetFromSelection } from './References.js';

export function ChangeNoteEditor({value,disabled,onChange}:{value:NoteContent|null;disabled:boolean;onChange:(value:NoteContent|null)=>void}) {
  const [picker,setPicker]=useState(false),input=useRef<HTMLTextAreaElement>(null);

  return <fieldset className="change-note-editor" disabled={disabled}>
    <legend>Revision change note</legend>
    <label><input type="checkbox" checked={value!==null} onChange={e=>{onChange(e.target.checked?{format:'loom-markdown-v2',text:'',mentions:[],references:[]}:null);setPicker(false);}}/> Add a revision change note</label>
    <p className="fineprint">Optional explanation of this new revision only. Fixed with the revision and attributed to its publisher.</p>
    {value&&<><label>Change note<textarea aria-label="Change note" ref={input} rows={4} value={value.text} onChange={e=>onChange({...value,text:e.target.value})}/></label>
      <button type="button" onClick={()=>setPicker(v=>!v)}>Mention someone in the note</button>
      {picker&&<NoteParticipants choose={person=>{
        const token='m'+crypto.randomUUID().replaceAll('-','').slice(0,12);
        onChange({...value,text:value.text+` [[mention:${token}]]`,mentions:[...value.mentions,{token,participant_id:person.id}]});setPicker(false);input.current?.focus();
      }}/>}
      {value.mentions.map(mention=><button type="button" key={mention.token} onClick={()=>onChange({...value,
        text:value.text.replaceAll(`[[mention:${mention.token}]]`,''),mentions:value.mentions.filter(m=>m.token!==mention.token)})}>Remove note mention {mention.token}</button>)}
      <ReferenceEditor references={value.references} disabled={disabled} onChange={references=>onChange({...value,references})}/>
      <details><summary>Preview change note</summary><AuthoredText content={value}/></details>
    </>}
  </fieldset>;
}

function NoteParticipants({choose}:{choose:(person:{id:string;nickname:string})=>void}) {
  const [cursor,setCursor]=useState('');
  const participants=useQuery<PageView>('/api/v1/participants?'+new URLSearchParams({limit:'25',...(cursor?{cursor}:{})}),Page);
  return <div role="group" aria-label="Note participant selection">
    {participants.error&&<><p role="alert">{participants.error}</p><button onClick={participants.refresh}>Retry note participants</button></>}
    {participants.data?.items.map(item=>{const person=item as {id:string;nickname:string};return <button type="button" key={person.id} onClick={()=>choose(person)}>Mention @{person.nickname} in note</button>;})}
    {participants.data?.next_cursor&&<button type="button" onClick={()=>setCursor(participants.data!.next_cursor!)}>Next note participants</button>}
  </div>;
}

function ComparisonAccount({source,base,onKeep}:{source:string;base:string;onKeep:()=>void}) {
  const read=useQuery<RevisionView>(`/api/v1/resources/${source}/revisions/${base}`,Revision);
  return <div><Link to={`/loom/resource/${source}/${base}`}>Inspect the comparison revision and its declaration</Link>
    {read.error&&<><p role="alert">{read.error}</p><button type="button" onClick={read.refresh}>Retry comparison declaration</button></>}
    {read.data?.change_account?.state==='declared'&&<button type="button" onClick={onKeep}>Keep declaration from comparison revision</button>}
    {read.data&&read.data.change_account?.state!=='declared'&&<p>The comparison revision has no change declaration to carry.</p>}
  </div>;
}
export function ChangeAccountEditor({value,source,base,disabled,onChange}:{value:ChangeAccountValue|null;source?:string|undefined;base?:string|undefined;disabled:boolean;
  onChange:(value:ChangeAccountValue|null,reference?:ExactChangeTargetValue)=>void}) {
  const [id,setId]=useState(''),[revision,setRevision]=useState(''),[kind,setKind]=useState<ExactChangeTargetValue['kind']>('artifact'),
    [selected,setSelected]=useState<ResolvedTargetView>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[recordReference,setRecordReference]=useState(true);
  const live=useRef(false),sequence=useRef(0),input=useRef<HTMLInputElement>(null);
  useEffect(()=>{live.current=true;return()=>{live.current=false;sequence.current++;};},[]);
  useEffect(()=>{if(disabled){sequence.current++;setBusy(false);setSelected(undefined);}},[disabled]);
  const invalidate=()=>{sequence.current++;setSelected(undefined);setError('');setBusy(false);};
  async function check(){
    const seq=++sequence.current,owner=identityGeneration();setBusy(true);setError('');setSelected(undefined);
    try{const target=targetFromSelection(id,kind,'revision',revision);
      if(target.kind==='discussion'||!target.revision_id)throw new Error('Choose an exact contribution, artifact or summary revision.');
      const result=await request<ResolvedTargetView>('/api/v1/references/target?'+new URLSearchParams(target),{schema:ResolvedTarget});
      if(live.current&&sequence.current===seq&&owner===identityGeneration())setSelected(result);
    }catch(failure){if(live.current&&sequence.current===seq&&owner===identityGeneration())setError((failure as Error).message);}
    finally{if(live.current&&sequence.current===seq&&owner===identityGeneration())setBusy(false);}
  }
  const members=value&&'revisions' in value?value.revisions:[];
  return <fieldset className="change-account-editor" disabled={disabled}>
    <legend>Change account</legend>
    <label><input type="checkbox" checked={value!==null} onChange={e=>{invalidate();onChange(e.target.checked?{revisions:[]}:null);}}/> Explain a declared set of changes in this post</label>
    <p className="fineprint">An ordinary post or comment under your authorship. Describing a resource grants no editing rights.</p>
    {value&&<>{'carry_forward_revision_id' in value?<div className="notice neutral">{value.carry_forward_revision_id!==base&&<><p role="alert">This attempted declaration belongs to the old base. Inspect the comparison revision and explicitly choose its declaration, replace the set or remove the classification.</p>
      {source&&base&&<ComparisonAccount key={source+base} source={source} base={base} onKeep={()=>onChange({carry_forward_revision_id:base})}/>}</>}<p>Keep the complete described set from the saved base revision, including unavailable members. No newer revisions are added.</p>
      <button type="button" onClick={()=>{invalidate();onChange({revisions:[]});}}>Replace described set</button></div>:<>
      <p className="fineprint">Select 1–16 exact revisions. This set makes no claim about intermediate versions, reading, correctness or approval.</p>
      <ul>{members.map(member=><li key={member.resource_id+member.revision_id}><Link to={`/loom/resource/${member.resource_id}/${member.revision_id}`}>Inspect described {member.kind} revision</Link>{' '}
        <code>{member.revision_id}</code><button type="button" onClick={()=>onChange({revisions:members.filter(m=>m!==member)})}>Remove described revision</button></li>)}</ul>
      <label>Described resource ID or exact Loom link<input ref={input} value={id} onChange={e=>{invalidate();setId(e.target.value);}}/></label>
      <label>Described resource kind<select value={kind} onChange={e=>{invalidate();setKind(e.target.value as ExactChangeTargetValue['kind']);}}>
        <option value="artifact">Text artifact</option><option value="summary">Discussion summary</option><option value="contribution">Opening post or comment</option></select></label>
      <label>Described exact revision ID<input value={revision} onChange={e=>{invalidate();setRevision(e.target.value);}}/></label>
      <button type="button" disabled={busy||members.length>=16} onClick={()=>void check()}>Check described revision</button>
      {busy&&<p role="status">Checking described revision…</p>}{error&&<p role="alert">{error}</p>}
      {selected&&<div className="notice neutral"><strong>{selected.representation.title??'Contribution'} · revision {selected.representation.revision_number}</strong>
        <p>By {selected.representation.publisher.nickname} · <Link to={selected.browser_url}>Inspect selected exact revision</Link></p>
        <label><input type="checkbox" checked={recordReference} onChange={e=>setRecordReference(e.target.checked)}/> Also record an untyped reference to this exact revision</label>
        <button type="button" onClick={()=>{
          const target=selected.target as ExactChangeTargetValue;
          if(members.some(m=>m.resource_id===target.resource_id&&m.revision_id===target.revision_id)){setError('That exact revision is already described.');return;}
          onChange({revisions:[...members,target]},recordReference?target:undefined);invalidate();setId('');setRevision('');input.current?.focus();
        }}>Describe this exact revision</button></div>}
    </>}</>}
  </fieldset>;
}

function NoteView({path}:{path:string}) {
  const read=useQuery<NoteDetailView>(path,NoteDetail);
  if(read.error)return <><p role="alert">{read.error}</p><button onClick={read.refresh}>Retry change note</button></>;
  if(!read.data)return <p role="status">Loading change note…</p>;
  const note=read.data;
  return <>{note.content?<><p>Editor’s note for revision {note.source.revision_number} · published by {note.source.publisher.nickname}</p>
    <AuthoredText content={note.content} participants={note.mentioned_participants}/></>:<p>No change note on this revision.</p>}</>;
}
function CoverageView({path}:{path:string}) {
  const [data,setData]=useState<ChangeCoverageView>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const live=useRef(false),sequence=useRef(0),attempt=useRef<string|null>(null),heading=useRef<HTMLHeadingElement>(null);
  async function load(cursor:string|null,focus=false){
    const seq=++sequence.current,owner=identityGeneration();attempt.current=cursor;setBusy(true);setError('');
    try{const result=await request<ChangeCoverageView>(path+'?'+new URLSearchParams({limit:'12',...(cursor?{cursor}:{})}),{schema:ChangeCoverage});
      if(live.current&&seq===sequence.current&&owner===identityGeneration()){setData(result);if(focus)heading.current?.focus();}}
    catch(failure){if(live.current&&seq===sequence.current&&owner===identityGeneration())setError((failure as Error).message);}
    finally{if(live.current&&seq===sequence.current&&owner===identityGeneration())setBusy(false);}
  }
  useEffect(()=>{live.current=true;void load(null);return()=>{live.current=false;sequence.current++;};},[path]);
  return <div aria-busy={busy}><h4 ref={heading} tabIndex={-1}>Described revisions</h4>
    {error&&<><p role="alert">{error} The previous page remains visible.</p><button disabled={busy} onClick={()=>void load(attempt.current,true)}>Retry described revisions</button></>}
    <button disabled={busy} onClick={()=>void load(null,true)}>Refresh described revisions</button>
    {busy&&<p role="status">Loading described revisions…</p>}
    {data&&<><p>Exact selected revisions; intermediate versions are not implied. This is an author’s claim, not proof of reading, correctness, approval or currency.</p>
      {data.unknown&&<p role="status">Some described material is unavailable; the complete described set is unknown here.</p>}
      <ul>{data.items.map(item=><li key={item.target.resource_id+item.target.revision_id}><Link to={item.browser_url}>{item.representation.title??'Contribution'} · revision {item.representation.revision_number}</Link>{' '}by {item.representation.publisher.nickname}</li>)}</ul>
      {!error&&data.next_cursor&&<button disabled={busy} onClick={()=>void load(data.next_cursor,true)}>Next described revisions</button>}
      {!error&&!busy&&data.complete&&<p>End of the selected declaration. Unavailable members remain undisclosed.</p>}</>}
  </div>;
}
export function ChangeDetails({revision}:{revision:RevisionView}) {
  return <>{['artifact','summary'].includes(revision.kind)&&<section id="change-note" className="change-details"><h3>Revision change note</h3>
    {revision.change_note?.state==='available'?<NoteView key={revision.revision_id} path={revision.change_note.full_content_url}/>:<p>No change note on this revision.</p>}</section>}
    {revision.kind==='contribution'&&revision.change_account?.state==='declared'&&<section className="change-details"><h3>Change account by {revision.author.nickname}</h3>
      <p>Ordinary contribution · revision {revision.revision_number} published by {revision.publisher.nickname}.</p>
      <CoverageView key={revision.revision_id} path={revision.change_account.coverage_url}/></section>}
  </>;
}
export function ChangeDiscoveryViewComponent({resource,revision,kind}:{resource:string;revision?:string|undefined;kind:ExactChangeTargetValue['kind']}) {
  const [open,setOpen]=useState(false),[history,setHistory]=useState('current'),[form,setForm]=useState(''),[exact,setExact]=useState(!!revision);
  const path='/api/v1/changes?'+new URLSearchParams({resource_id:resource,kind,history,...(exact&&revision?{revision_id:revision}:{}),...(form?{form}:{})});
  return <section className="change-discovery"><button aria-expanded={open} onClick={()=>setOpen(v=>!v)}>Discover change explanations</button>
    {open&&<><label>Explanation scope<select value={exact?'exact':'resource'} onChange={e=>setExact(e.target.value==='exact')}><option value="resource">All described revisions of this resource</option>{revision&&<option value="exact">Only this exact revision</option>}</select></label>
      <label>Explanation history<select value={history} onChange={e=>setHistory(e.target.value)}><option value="current">Current source revisions</option><option value="all">Including historical source revisions</option></select></label>
      <label>Explanation form<select value={form} onChange={e=>setForm(e.target.value)}><option value="">Both forms</option><option value="revision_note">Resource editor’s revision notes</option><option value="change_account">Ordinary change accounts</option></select></label>
      <DiscoveryResults key={path} path={path}/></>}
  </section>;
}
function DiscoveryResults({path}:{path:string}) {
  const [data,setData]=useState<ChangeDiscoveryView>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[restart,setRestart]=useState(false);
  const live=useRef(false),sequence=useRef(0),attempt=useRef<string|null>(null),heading=useRef<HTMLHeadingElement>(null);
  async function load(cursor:string|null,focus=false){
    const seq=++sequence.current,owner=identityGeneration();attempt.current=cursor;setBusy(true);setError('');setRestart(false);
    try{const result=await request<ChangeDiscoveryView>(path+'&'+new URLSearchParams({limit:'12',...(cursor?{cursor}:{})}),{schema:ChangeDiscovery});
      if(live.current&&seq===sequence.current&&owner===identityGeneration()){setData(result);if(focus)heading.current?.focus();}}
    catch(failure){if(live.current&&seq===sequence.current&&owner===identityGeneration()){setError((failure as Error).message);setRestart(failure instanceof ApiError&&failure.code==='references_changed');}}
    finally{if(live.current&&seq===sequence.current&&owner===identityGeneration())setBusy(false);}
  }
  useEffect(()=>{live.current=true;void load(null);return()=>{live.current=false;sequence.current++;};},[path]);
  return <div aria-busy={busy}><h3 ref={heading} tabIndex={-1}>Change explanations</h3>
    {busy&&<p role="status">Loading explanations…</p>}{error&&<><p role="alert">{error}</p>{!restart&&<button onClick={()=>void load(attempt.current,true)}>Retry explanations</button>}</>}
    <button disabled={busy} onClick={()=>void load(null,true)}>Refresh explanations</button>
    {data&&<><ul>{data.items.map(item=><li key={item.source.revision_id+item.source_field+item.described.revision_id}>
      <Link to={item.browser_url}>{item.form==='revision_note'?'Editor’s revision note':'Ordinary change account'} · {item.source.title??'Comment'}</Link>
      <p>Source revision {item.source.revision_number} by {item.source.publisher.nickname} · {item.membership.replaceAll('_',' ')} · <Link to={item.context_url}>Owning context</Link></p>
      <p>Describes exact revision <Link to={`/loom/resource/${item.described.resource_id}/${item.described.revision_id}`}>{item.described.revision_id}</Link>{item.described_scope==='member_of_exact_set'?' as a member of its declared set.':'.'}</p>
    </li>)}</ul>{!error&&!busy&&!data.items.length&&<p>{data.complete?'No eligible explanations in this scope.':'No eligible explanations in this bounded page; continue scanning.'}</p>}
      <p className="fineprint">Each row is an exact described membership, not another publication event. Bodies and full account sets are available through source links.</p>
      {!error&&data.next_cursor&&<button disabled={busy} onClick={()=>void load(data.next_cursor,true)}>Next explanations</button>}
      {!error&&!busy&&data.complete&&<p>End of this selected explanation view.</p>}</>}
  </div>;
}
