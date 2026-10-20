import { useEffect,useRef,useState } from 'react';
import { Link } from 'react-router';
import * as C from '../contracts/attention.js';
import * as P from '../contracts/private-controls.js';
import type { FollowTargetView } from '../contracts/following.js';
import type { Context } from './participation-state.js';
import { ApiError,identityGeneration } from './participation-client.js';
import { AttentionRecovery,attentionInputKey,commandTargets,exportAttentionRecovery,type AttentionIntent,type AttentionCommandView } from './attention-recovery.js';
import { AuthorizationBoundary,useAuthorization } from './AuthorizationBoundary.js';
import { contentKey } from './protected-content.js';

const base='/api/v1/me/attention';
function isAccessFailure(error:unknown){return error instanceof ApiError&&['unauthenticated','invalid_actor','unavailable','forbidden'].includes(error.code);}
function useAttention(context:Context,matches:(record:AttentionIntent)=>boolean,onFailure?:(error:unknown)=>void){
  const authority=useAuthorization();
  const [journal]=useState(()=>new AttentionRecovery(context.community.instance_id,context.self.participant_id));
  const [records,setRecords]=useState<AttentionIntent[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const live=useRef(true),owner=useRef(identityGeneration()),inflight=useRef(false);
  const failed=useRef(onFailure);failed.current=onFailure;
  const active=()=>live.current&&owner.current===identityGeneration()&&authority.active();
  useEffect(()=>{
    live.current=true;const changed=()=>{if(active())try{setRecords(journal.all());}catch(e){setError((e as Error).message);}};
    const storage=(e:StorageEvent)=>{if(e.key===null||e.key.startsWith(journal.prefix))changed();};changed();
    window.addEventListener('loom-attention',changed);window.addEventListener('storage',storage);
    return()=>{live.current=false;window.removeEventListener('loom-attention',changed);window.removeEventListener('storage',storage);};
  },[journal]);
  async function send(record:AttentionIntent,retry:boolean):Promise<P.AttentionResultView|undefined>{
    const authorization=authority.capture();
    let dispatched:AttentionIntent|undefined;
    try{
      if(retry)dispatched=await journal.begin(record);
      if(!active()||!authority.current(authorization))return;
      const response=await authority.attentionCommand(record.command,retry,context.self,context.controlsProjection),result=response.value;
      const received=active()&&response.generation!==undefined&&authority.current(response.generation);
      if(result.operation_state==='not_recorded'){if(received)setError('No outcome is recorded yet. This request may still commit; keep and retry its exact command.');return;}
      const resultAuthorization=response.generation;
      // Current authority is processed before waiting on local recovery custody.
      // A blocked journal must never prolong display of withdrawn source text.
      if(result.operation_state==='version_conflict')await journal.recordConflict(record);else await journal.finish(record);
      // The decision belongs to this identity even after its control unmounts.
      // Notify the newly mounted view without letting a late result update old UI.
      if(owner.current===identityGeneration())window.dispatchEvent(new Event('loom-attention-policy'));
      if(received&&active()&&authority.current(resultAuthorization!))return result;
    }catch(e){
      const current=active()&&authority.current(authorization);
      // Withdrawal cannot wait behind a journal Web Lock. A lost credential
      // fences old writes immediately; its exact command may remain uncertain.
      if(current)failed.current?.(e);
      if(dispatched?.attempts===1&&e instanceof ApiError&&['attention_limit_reached','attention_selection_expired','invalid_input','invalid_request','unavailable','forbidden'].includes(e.code)&&e.operationOutcome!=='unknown')
        await journal.rejectFirst(dispatched).catch(()=>{});
      if(active())setError((e as Error).message);
    }
  }
  async function submit(command:AttentionCommandView){
    if(inflight.current||!active())return;inflight.current=true;setBusy(true);setError('');
    try{return await send(await journal.save(command,active),true);}catch(e){if(active())setError((e as Error).message);}
    finally{inflight.current=false;if(active())setBusy(false);}
  }
  async function recover(record:AttentionIntent,retry:boolean){
    if(inflight.current||!active())return;inflight.current=true;setBusy(true);setError('');
    try{return await send(record,retry);}finally{inflight.current=false;if(active())setBusy(false);}
  }
  async function dismissNotice(record:AttentionIntent){try{await journal.finish(record,true);}catch(e){if(active())setError((e as Error).message);}}
  // Preparation can reveal overlapping inputs without changing the journal.
  return {records:records.filter(matches),busy,error,setError,active,submit,recover,dismissNotice,authority};
}
function Recovery({session,onResult}:{session:ReturnType<typeof useAttention>;onResult?:(r:P.AttentionResultView)=>void}){
  return <>{session.error&&<p role="alert">{session.error}</p>}{session.records.map(record=><div className="notice" key={record.command.body.idempotency_key}>
    <p>{record.state==='conflicted'?'Attention change conflicted. Review current state before making another choice.':record.state==='rejected'?'Attention change was refused before a recorded decision.':'Attention outcome is unconfirmed. Its exact saved inputs will not expand.'}</p>
    <details><summary>Exact private recovery inputs</summary><ul>{commandTargets(record.command).map(id=><li key={id}>{id}</li>)}</ul></details>
    {record.state==='uncertain'?<><button aria-disabled={session.busy} onClick={()=>void session.recover(record,false).then(r=>r&&onResult?.(r))}>Check attention outcome</button>
      <button aria-disabled={session.busy} onClick={()=>void session.recover(record,true).then(r=>r&&onResult?.(r))}>Retry same attention change</button></>:
      <button onClick={()=>void session.dismissNotice(record)}>Dismiss attention {record.state==='conflicted'?'conflict':'refusal'} notice</button>}
  </div>)}</>;
}
export function MuteControl({context,target,initial}:{context:Context;target:FollowTargetView;initial?:P.MuteItemView}){
  const key=contentKey(target);
  const [current,setCurrent]=useState<P.MuteItemView>(),[descendants,setDescendants]=useState(false),[loading,setLoading]=useState(true),[message,setMessage]=useState('');
  const [authorizedPreview,setPreview]=useState<number>();
  const sequence=useRef(0),version=useRef(-1);
  function withdraw(error:unknown){if(isAccessFailure(error)){
    if(context.controlsProjection&&error instanceof ApiError&&error.code==='unavailable'){setPreview(undefined);setLoading(false);return;}
    // A refusal also fences lookups started before it, including during recovery.
    sequence.current++;setCurrent(undefined);setPreview(undefined);setDescendants(false);setMessage('');setLoading(false);
  }}
  const session=useAttention(context,r=>commandTargets(r.command).includes(key),withdraw);
  function accept(item:P.MuteItemView,authorization?:number){
    if(!session.active())return;
    if(item.version>=version.current){version.current=item.version;setCurrent(item);setDescendants(item.include_descendants);}
    // Private choice ordering cannot authorize or veto a fresh source preview.
    if(authorization!==undefined){const preview=session.authority.preview(target,authorization);if(preview)setPreview(authorization);}
  }
  async function refresh(protectedRefresh=false){
    const mine=++sequence.current,started=session.authority.capture();setLoading(true);
    try{
      if(context.controlsProjection){
        const item=await session.authority.privateRead<P.MuteItemView>(base+'/private/mutes/lookup',{body:target,self:context.self,schema:P.MuteItem});
        if(session.active()&&mine===sequence.current){accept(item);session.setError('');}
        const generation=session.authority.current(started)?await session.authority.previewLookup(target,context.self,protectedRefresh):undefined;
        if(session.active()&&mine===sequence.current&&session.authority.current(generation))accept(item,generation);
        return;
      }
      const {value:item,generation}=await session.authority.readAuthorized<C.MuteItemView>(base+'/mutes/lookup',{body:target,self:context.self,schema:C.MuteItem});if(session.active()&&mine===sequence.current){
      if(generation!==undefined&&!session.authority.current(generation))return;
      accept(item,generation);session.setError('');}}
    catch(e){if(session.active()&&mine===sequence.current&&(e as Error).name!=='AbortError'){withdraw(e);session.setError((e as Error).message);}}
    finally{if(session.active()&&mine===sequence.current)setLoading(false);}
  }
  // A delayed list can predate a local withdrawal. Use it to request a fresh
  // lookup, never to restore metadata: private versions do not version access.
  useEffect(()=>{setCurrent(undefined);setPreview(undefined);setDescendants(false);void refresh();return()=>{sequence.current++;};},[key,initial]);
  useEffect(()=>{const changed=()=>void refresh();window.addEventListener('loom-attention-policy',changed);
    return()=>window.removeEventListener('loom-attention-policy',changed);},[key]);
  function result(r:P.AttentionResultView){if(r.kind!=='mute'||!session.active())return;
    // Settle safe settings only. The policy event has started a fresh lookup;
    // keep it live so older mutation/status metadata cannot reauthorize a source.
    accept(r.current);
    setMessage(r.operation_state==='applied'?'Choice saved. Refresh an existing routine selection to apply it; older history remains available.':'');}
  async function set(muted:boolean){if(!current||loading||session.busy||session.records.length)return;
    const r=await session.submit({kind:'mute',body:{idempotency_key:crypto.randomUUID(),target,include_descendants:muted?descendants:current.include_descendants,muted,expected_version:current.version}});if(r)result(r);}
  const preview=session.authority.preview(target,authorizedPreview);
  return <div className="attention-control" data-mute-target={key}>
    <p>Routine {target.kind} updates · {preview?.source.state==='available'?preview.source.title??'Current title unavailable':'Current source unavailable'}</p>
    {target.kind==='area'&&<label><input type="checkbox" checked={descendants} disabled={session.busy||loading||!!session.records.length} onChange={e=>setDescendants(e.target.checked)}/>Mute descendant topics</label>}
    <button aria-disabled={session.busy||loading||!current||!!session.records.length} onClick={()=>void set(!current?.muted)}>{current?.muted?'Unmute routine updates':'Mute routine updates'}</button>
    <button onClick={()=>void refresh(true)}>Refresh mute state</button>
    <p className="fineprint">Until explicitly unmuted. Direct mentions and replies still arrive. Following, Saved and reading are independent.</p>
    {!!preview?.other_current_scope_mutes.length&&<p>Other mutes still apply in the current scope: {preview.other_current_scope_mutes.map(v=>`${v.target.kind} ${v.target.resource_id}${v.include_descendants?' with subtopics':''}`).join('; ')}. Historical events use their original scope.</p>}
    {message&&<p role="status">{message}</p>}<Recovery session={session} onResult={result}/>
  </div>;
}
export function DismissControl({context,cursor,groupId,inputs,onSelectionFailure}:{context:Context;cursor?:string;groupId?:string;inputs?:C.AttentionInputView[];onSelectionFailure?:(error:unknown)=>void}){
  const [selection,setSelection]=useState<C.AttentionSelectionView>(),[chosen,setChosen]=useState<C.DismissItemView[]>(),[preparing,setPreparing]=useState(false),
    [saved,setSaved]=useState<{result:Extract<P.AttentionResultView,{kind:'dismissal'}>;selection:string}>(),[restored,setRestored]=useState(false);
  const selectionKey=JSON.stringify([cursor,groupId,inputs]);
  const ownKeys=useRef<string[]>(inputs?.map(attentionInputKey)??[]);
  const matchKeys=inputs?.map(attentionInputKey)??ownKeys.current;
  const session=useAttention(context,r=>(r.command.kind==='dismissal'&&!!groupId&&r.command.group_id===groupId)||commandTargets(r.command).some(k=>matchKeys.includes(k)));
  const prepareSequence=useRef(0),root=useRef<HTMLDivElement>(null),undo=useRef<HTMLButtonElement>(null),choose=useRef<HTMLButtonElement>(null),restoreFocus=useRef(false);
  useEffect(()=>{if(restoreFocus.current){(restored?choose:undo).current?.focus({preventScroll:true});restoreFocus.current=false;}},[saved,restored]);
  // Expanded sources have no group cursor: their shared/personal identity set
  // must fence preparation too, including a lookup still in flight.
  useEffect(()=>{setPreparing(false);setChosen(undefined);setSelection(undefined);return()=>{prepareSequence.current++;};},[selectionKey,session.authority.capture()]);
  async function prepare(){
    if(preparing||session.busy||session.records.length)return;setPreparing(true);setRestored(false);session.setError('');const mine=++prepareSequence.current;
    try{
      if(cursor&&groupId){const {value:result,generation}=await session.authority.readAuthorized<C.AttentionSelectionView>('/api/v1/me/routine-updates/selection',{body:{cursor,group_id:groupId,...(inputs?{inputs}:{})},self:context.self,schema:C.AttentionSelection});
        if(session.authority.current(generation)&&mine===prepareSequence.current){setSelection(result);setChosen(result.inputs);ownKeys.current=result.inputs.map(attentionInputKey);}}
      else if(inputs){const {value:result,generation}=await session.authority.readAuthorized<C.DismissPageView>(base+'/dismissals/lookup',{body:{inputs},self:context.self,schema:C.DismissPage});if(session.authority.current(generation)&&mine===prepareSequence.current)setChosen(result.items);}
    }catch(e){if(session.active()&&mine===prepareSequence.current&&(e as Error).name!=='AbortError'){session.setError((e as Error).message);onSelectionFailure?.(e);}}
    finally{if(session.active()&&mine===prepareSequence.current)setPreparing(false);}
  }
  function result(r:P.AttentionResultView){if(r.kind==='dismissal'&&session.active()){
    restoreFocus.current=r.operation_state==='applied'&&!!root.current?.contains(document.activeElement);
    const restored=r.operation_state==='applied'&&r.outcome.inputs.every(v=>!v.dismissed);
    // The receipt owns its original versions, not the card's later selection.
    setRestored(restored);setSaved(r.operation_state==='applied'?{result:r,selection:selectionKey}:undefined);setChosen(undefined);setSelection(undefined);
  }}
  async function dismiss(){
    if(!chosen||session.busy||session.records.length)return;
    const r=await session.submit({kind:'dismissal',...(groupId?{group_id:groupId}:{}),body:{idempotency_key:crypto.randomUUID(),...(selection?{selection:selection.selection}:{}),inputs:chosen.map(({kind,id,version})=>({kind,id,dismissed:true,expected_version:version}))}});if(r)result(r);
  }
  async function restore(){
    if(!saved||preparing||session.busy)return;setPreparing(true);
    try{
      // Undo belongs to this applied decision. Even an exact retry may report a
      // newer current choice; adopting that version would silently defeat it.
      const r=await session.submit({kind:'dismissal',body:{idempotency_key:crypto.randomUUID(),inputs:saved.result.outcome.inputs.map(({kind,id,result_version})=>({kind,id,dismissed:false,expected_version:result_version}))}});if(r)result(r);
    }catch(e){if(session.active())session.setError((e as Error).message);}finally{if(session.active())setPreparing(false);}
  }
  const savedDismissal=!!saved?.result.outcome.inputs.some(v=>v.dismissed);
  const shared=chosen?.filter(v=>v.kind==='shared_event').length??0,personal=chosen?.filter(v=>v.kind==='personal_delivery').length??0;
  return <div ref={root} className="attention-control" data-dismiss-group={groupId}>
    {(!savedDismissal||saved?.selection!==selectionKey)&&!chosen&&<button ref={choose} aria-disabled={preparing||session.busy||!!session.records.length} onClick={()=>void prepare()}>{preparing?'Preparing exact selection…':inputs?'Dismiss these source inputs':'Dismiss this update'}</button>}
    {chosen&&<><p>This exact selection contains {shared} shared event{shared===1?'':'s'} and {personal} personal signal{personal===1?'':'s'}, including direct sources not expanded on the card. Later arrivals are excluded.</p>
      <p className="fineprint">Unknown and unrepresented history is not dismissed.</p><details><summary>Inspect exact selected identities</summary><ul>{chosen.map(v=><li key={v.kind+v.id}>{v.kind.replaceAll('_',' ')} {v.id}</li>)}</ul></details>
      <button aria-disabled={session.busy||!!session.records.length} onClick={()=>void dismiss()}>Confirm dismissal</button><button aria-disabled={session.busy} onClick={()=>{if(!session.busy){setChosen(undefined);setSelection(undefined);}}}>Cancel dismissal</button></>}
    {restored&&<p role="status">Restoration saved. Independent mutes still apply. This card retains its previous selection until you refresh. Complete retrieval remains available.</p>}
    {savedDismissal&&<div role="status"><p>Dismissal saved for these exact inputs. {saved?.selection===selectionKey?'This card retains its previous selection until you refresh.':'You can review the remaining inputs for a new dismissal.'} Complete retrieval remains available.</p>
      <button ref={undo} aria-disabled={session.busy||preparing} onClick={()=>void restore()}>Undo dismissal / restore these inputs</button></div>}
    {/* Keep the receipt's identity disclosure after Undo, avoiding a collapsing
        card below the keyboard focus and retaining the exact restored scope. */}
    {saved&&<details><summary>Inspect last attention result identities</summary><ul>{saved.result.outcome.inputs.map(v=><li key={v.kind+v.id}>{v.kind.replaceAll('_',' ')} {v.id}</li>)}</ul></details>}
    <Recovery session={session} onResult={result}/>
  </div>;
}
function RestoreEntry({context,item}:{context:Context;item:P.DismissItemView&{availability?:C.DismissItemView['availability']}}){
  const key=attentionInputKey(item),session=useAttention(context,r=>commandTargets(r.command).includes(key)),[message,setMessage]=useState('');
  async function restore(){if(session.busy||session.records.length)return;
    const r=await session.submit({kind:'dismissal',body:{idempotency_key:crypto.randomUUID(),inputs:[{kind:item.kind,id:item.id,dismissed:false,expected_version:item.version}]}});
    if(r?.operation_state==='applied')setMessage('Restored. Refresh this list and the retained routine selection; independent mutes remain.');}
  return <li><p>{item.kind==='shared_event'?'Shared activity':'Personal signal'} · {item.id}{item.availability==='unavailable'?' · Source unavailable':''}</p>
    <button aria-disabled={session.busy||!!session.records.length||!!message} onClick={()=>{if(!message)void restore();}}>Restore this input</button>{message&&<p role="status">{message}</p>}<Recovery session={session}/></li>;
}
export function AttentionPage({context}:{context:Context}){
  return <AuthorizationBoundary scope="attention" sourcePolicy="settings" retryLabel="Retry attention settings"><AttentionSettings context={context}/></AuthorizationBoundary>;
}
function AttentionSettings({context}:{context:Context}){
  const session=useAttention(context,()=>true),[collection,setCollection]=useState<'mutes'|'dismissals'>('mutes'),[page,setPage]=useState<P.AttentionListView>(),[busy,setBusy]=useState(false),[changed,setChanged]=useState(false);
  const sequence=useRef(0),attempted=useRef<string|undefined>(undefined);
  async function load(cursor?:string){const mine=++sequence.current,started=session.authority.capture();attempted.current=cursor;setBusy(true);session.setError('');
    try{
      if(context.controlsProjection){
        const value=await session.authority.privateRead<P.AttentionListView>(base+'/private/list',{body:{collection,...(cursor?{cursor}:{})},self:context.self,schema:P.AttentionList});
        if(session.active()&&mine===sequence.current){setPage(value);setChanged(false);}
        if(value.mutes.length&&session.authority.current(started))await session.authority.previews(value.mutes.map(v=>v.target),context.self);
      }else{const {value,generation}=await session.authority.readAuthorized<C.AttentionListView>(base+'/list',{body:{collection,...(cursor?{cursor}:{})},self:context.self,schema:C.AttentionList});if(session.authority.current(generation)&&mine===sequence.current){setPage(value);setChanged(false);}}}
    catch(e){if(session.active()&&mine===sequence.current&&(e as Error).name!=='AbortError'){setPage(undefined);session.setError((e as Error).message);}}
    finally{if(session.active()&&mine===sequence.current)setBusy(false);}}
  useEffect(()=>{setPage(undefined);void load();return()=>{sequence.current++;};},[collection]);
  useEffect(()=>{const changed=()=>{sequence.current++;setBusy(false);setChanged(true);};window.addEventListener('loom-attention-policy',changed);return()=>window.removeEventListener('loom-attention-policy',changed);},[]);
  return <section className="attention-settings"><h1>Attention settings</h1><p>Private routine mutes and exact dismissed inputs. These choices do not mark content read or change Saved and Following.</p>
    <p><Link to="/loom/updates">Routine Updates and complete retrieval</Link> · <Link to="/loom/notifications">All retained mentions/replies</Link></p>
    <label>Manage <select value={collection} onChange={e=>setCollection(e.target.value as typeof collection)}><option value="mutes">Active mutes</option><option value="dismissals">Dismissed inputs</option></select></label>
    <button aria-disabled={busy} onClick={()=>{if(!busy)void load();}}>Refresh attention settings</button>
    {busy&&<p role="status">Loading private choices…</p>}{changed&&<p className="notice">Choices changed. Refresh this list to see current membership.</p>}
    {session.error&&<p role="alert">{session.error}</p>}{session.error&&<button aria-disabled={busy} onClick={()=>void load(attempted.current)}>Retry attention settings</button>}
    {page&&<><ul>{page.mutes.map(item=><li key={item.target.kind+item.target.resource_id}><MuteControl context={context} target={item.target} initial={item}/></li>)}</ul>
      <ul>{page.dismissals.map(item=><RestoreEntry key={item.kind+item.id+item.version} context={context} item={item}/>)}</ul>
      {!page.mutes.length&&!page.dismissals.length&&<p>No active choices in this bounded page.</p>}
      {page.next_cursor&&<button aria-disabled={busy} onClick={()=>void load(page.next_cursor!)}>Next attention settings</button>}</>}
    <details><summary>Attention recovery ({session.records.length})</summary><Recovery session={session}/>
      <button onClick={()=>{try{exportAttentionRecovery(context.community.instance_id,context.self.participant_id);}catch(e){session.setError((e as Error).message);}}}>Export attention recovery</button></details>
    <p className="fineprint">Restore/Unmute offers older retained material through an explicit selection refresh or retained-history replay. It does not make that material newly published. Retained decisions and version fences do not automatically expire; these synthetic quotas do not promise erasure.</p>
  </section>;
}
