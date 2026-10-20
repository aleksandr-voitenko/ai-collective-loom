import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import * as C from '../contracts/moderation.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { useQuery, type Context } from './participation-state.js';
import { identityGeneration, isDefinitiveRejection, type Intent } from './participation-client.js';

export function SuppressLink({context,id,kind}:{context:Context;id:string;kind:C.ModerationTargetView['kind']}) {
  return context.self.role==='administrator'?<Link className="text-button" to={'/loom/moderation?target='+id}>Suppress {kind}</Link>:null;
}
const scope={
  discussion:'This withholds the opening, comments, summary, retained revisions and their notes. Independent artifacts remain separately governed.',
  comment:'This withholds this comment and its revisions. Replies remain independently eligible with their real parent and a safe placeholder.',
  summary:'This withholds the whole summary, its revisions and notes. The discussion opening and comments remain independently eligible.',
  artifact:'This withholds the whole artifact, its description, revisions and notes. Referring discussions and independent publications remain separately governed.',
};
export function ModerationPage({context}:{context:Context}) {
  const query=new URLSearchParams(useLocation().search),target=query.get('target')??'',selected=query.get('intent');
  const authority=useAuthorization(),[revision,changed]=useState(0),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false),[confirmation,setConfirmation]=useState<C.ModerationResourceView>();
  const [cursor,setCursor]=useState(''),[audit,setAudit]=useState(false);
  const detail=useQuery<C.ModerationResourceView|C.ModerationPageView>(target?'/api/v1/admin/moderation/resources/'+target:'/api/v1/admin/moderation/targets?limit=1',target?C.ModerationResource:C.ModerationPage);
  const list=useQuery<C.ModerationPageView|C.ModerationAuditView>('/api/v1/admin/moderation/'+(audit?'audit':'targets')+'?limit=12'+(cursor?'&cursor='+encodeURIComponent(cursor):''),audit?C.ModerationAudit:C.ModerationPage);
  const live=useRef(true),owner=useRef(identityGeneration()),dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement|null>(null),refreshButton=useRef<HTMLButtonElement>(null);
  const owned=()=>live.current&&owner.current===identityGeneration();
  useEffect(()=>{live.current=true;const update=()=>changed(n=>n+1);window.addEventListener('storage',update);window.addEventListener('loom-moderation',update);
    return()=>{live.current=false;window.removeEventListener('storage',update);window.removeEventListener('loom-moderation',update);};},[]);
  // The immutable local command survives role/source withdrawal; control data
  // below is rendered only through its query lease.
  let records:Intent[]=[],journalError='';
  try{records=context.store.all().filter(r=>r.kind==='moderation.set');}catch(failure){journalError=(failure as Error).message;}
  void revision;
  const refresh=()=>{setCursor('');detail.refresh();list.refresh();setConfirmation(undefined);setError('');};
  function close(){dialog.current?.close();setConfirmation(undefined);trigger.current?.focus({preventScroll:true});}
  useEffect(()=>{if(confirmation)dialog.current?.showModal();},[confirmation]);
  useEffect(()=>{if(!authority.current(detail.generation)&&!authority.current(list.generation))close();},[authority.capture()]);
  async function execute(intent:Intent,action:'state'|'status',first=false) {
    setBusy(true);setError('');setNotice('');
    let dispatched=intent;
    try {
      if(action==='state'&&!first)dispatched=await context.store.prepareDispatch(intent,intent.body);
      const value=await authority.moderationCommand(action==='state'?dispatched.body:{idempotency_key:dispatched.key},action,context.self);
      if(value.operation_state==='not_recorded'){
        if(owned())setNotice('No recorded outcome was found. Keep this exact command; it may still commit.');
      } else {
        await context.store.settle(dispatched,{state:'committed'});
        if(owned()){
          setNotice('Moderation decision recorded. Refresh control state to inspect the current local restriction and availability.');
          refreshButton.current?.focus({preventScroll:true});
        }
      }
    }catch(failure){
      if(first&&isDefinitiveRejection(failure,false)){
        try{await context.store.settle(dispatched,{state:'rejected'});}catch{ /* Preserve the exact uncertain record if settlement failed. */ }
      }
      if(owned())setError((failure as Error).message);
    }finally{
      if(owner.current===identityGeneration())window.dispatchEvent(new Event('loom-moderation'));
      if(owned())setBusy(false);
    }
  }
  async function confirm(){
    if(!confirmation||busy)return;
    const choice=confirmation;setBusy(true);setError('');
    try{
      const intent=await context.store.prepareModeration({target:choice.target,suppressed:choice.local_state!=='suppressed',expected_version:choice.version},owned);
      close();await execute(intent,'state',true);
    }catch(failure){if(owned())setError((failure as Error).message);}
    finally{if(owned())setBusy(false);}
  }
  function control(item:C.ModerationResourceView) {
    return <div className="list-row moderation-target" key={item.target.resource_id}>
      <div><strong>{item.target.kind}</strong><p className="destination-id">{item.target.resource_id}</p>
        <p>Local restriction: {item.local_state==='suppressed'?'suppressed':item.local_state==='active'?'removed':'resource removed'} · Lifecycle version {item.version}</p>
        <p>{item.ordinary_read_available?'Currently eligible for an ordinary read. Open the source to check its content.':'Ordinary content remains unavailable. An owner or revision restriction may still apply.'}</p>
      </div>
      {item.local_state!=='removed'&&<button disabled={busy||records.some(r=>r.state==='uncertain'&&String((r.body.target as C.ModerationTargetView).resource_id).toLowerCase()===item.target.resource_id.toLowerCase())}
        onClick={event=>{trigger.current=event.currentTarget;setConfirmation(item);}}>{item.local_state==='suppressed'?'Restore':'Suppress'} {item.target.kind}</button>}
    </div>;
  }
  return <section className="moderation-page"><h1>Content moderation</h1>
    <p>Administrator controls for local suppression and restoration. Content is never loaded here.</p>
    <p>Restoration removes only the selected restriction. Separate owner, child and revision restrictions remain. Suppression does not delete content or recall existing copies.</p>
    <button ref={refreshButton} onClick={()=>{if(!busy)refresh();}} aria-disabled={busy}>Refresh control state</button>
    <Link to="/loom/moderation">Suppressed targets</Link>
    <button onClick={()=>{setAudit(v=>!v);setCursor('');list.refresh();}}>{audit?'Show suppressed targets':'Show moderation audit'}</button>
    {(error||journalError)&&<p role="alert">{error||journalError}</p>}{notice&&<p role="status">{notice}</p>}
    {target&&detail.error&&<p role="alert">{detail.error}</p>}
    {target&&detail.data&&'local_state' in detail.data&&control(detail.data)}
    {list.error&&<p role="alert">{list.error}</p>}
    {list.data&&<section aria-label={audit?'Moderation audit':'Suppressed targets'}>
      <h2>{audit?'Moderation audit':'Suppressed targets'}</h2>
      {list.data.items.map(item=>'local_state' in item?control(item):<p key={item.operation_id} className="moderation-target">
        {item.target.kind} {item.target.resource_id} · {item.suppressed?'suppressed':'local restriction removed'} · version {item.version} · by {item.actor_id} · {item.recorded_at}</p>)}
      {!list.data.items.length&&<p>{list.data.complete?'No entries.':'Continue to the next bounded page.'}</p>}
      <button disabled={!list.data.next_cursor||busy} onClick={()=>setCursor(list.data!.next_cursor!)}>Next moderation page</button>
    </section>}
    <section aria-label="Moderation recovery"><h2>Saved moderation commands</h2>
      {records.map(record=><div key={record.key} className="notice">
        <p>{selected===record.key?'Selected command · ':''}{record.state==='uncertain'?'Awaiting confirmation':record.state==='committed'?'Recorded decision':'Rejected command'}</p>
        <details><summary>Recovery details</summary><p className="destination-id">Operation {record.key}</p></details>
        {record.state==='uncertain'?<>
          <button disabled={busy} onClick={()=>void execute(record,'status')}>Check moderation outcome</button>
          <button disabled={busy} onClick={()=>void execute(record,'state')}>Retry exact moderation command</button>
        </>:<button disabled={busy} onClick={()=>void context.store.remove(record).then(()=>changed(n=>n+1)).catch(f=>setError(f.message))}>Dismiss resolved command</button>}
      </div>)}
      {!records.length&&<p>No saved moderation commands.</p>}
    </section>
    <dialog ref={dialog} onCancel={event=>{event.preventDefault();close();}} aria-labelledby="moderation-confirm-title">
      {confirmation&&<><h2 id="moderation-confirm-title">{confirmation.local_state==='suppressed'?'Restore':'Suppress'} {confirmation.target.kind}?</h2>
        <p className="destination-id">{confirmation.target.resource_id}</p>
        <p>{confirmation.local_state==='suppressed'?'Remove only this target’s local suppression. Independent owner, child, revision, contribution and account restrictions remain.':scope[confirmation.target.kind]}</p>
        <p>This records an attributable administrative decision. It does not delete material or recall client copies.</p>
        <button autoFocus onClick={close} disabled={busy}>Cancel</button>
        <button onClick={()=>void confirm()} disabled={busy}>Confirm {confirmation.local_state==='suppressed'?'restoration':'suppression'}</button></>}
    </dialog>
  </section>;
}
