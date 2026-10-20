import assert from 'node:assert/strict';
import {test,afterEach,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode} from 'react';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {MuteControl,DismissControl,AttentionPage} from '../../src/web/Attention.js';
import {AuthorizationBoundary} from '../../src/web/AuthorizationBoundary.js';
import {AttentionRecovery,type AttentionCommandView} from '../../src/web/attention-recovery.js';
import {invalidateIdentity} from '../../src/web/participation-client.js';
import type {Context} from '../../src/web/participation-state.js';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','StorageEvent'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
const {render,screen,fireEvent,cleanup,act,waitFor,within}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});
const target=()=>({kind:'artifact' as const,resource_id:randomUUID()});
const item=(target:{kind:'artifact';resource_id:string},version=0,muted=false)=>({target,include_descendants:false,muted,version,source:{state:'unavailable'},other_current_scope_mutes:[]});
function mount(t:TestContext,targets=[target()],group?:string){
  const context={community:{instance_id:randomUUID()},self:{participant_id:randomUUID(),csrf:'synthetic'}} as Context,recovery=new AttentionRecovery(context.community.instance_id,context.self.participant_id);
  const calls:{path:string;body:any;finish:(r:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(path:string,options:any)=>new Promise<Response>(finish=>calls.push({path,body:JSON.parse(options.body),finish})));
  const router=createMemoryRouter([{path:'/attention',element:<AuthorizationBoundary sourcePolicy="settings">{targets.map(v=><MuteControl key={v.resource_id} context={context} target={v}/>)}{group&&<DismissControl context={context} cursor="fixed-cursor" groupId={group}/>}</AuthorizationBoundary>},{path:'/other',element:<h1>Other</h1>}],{initialEntries:['/attention']});
  t.after(()=>router.dispose());render(<StrictMode><RouterProvider router={router}/></StrictMode>);
  return {context,recovery,calls,router,targets};
}
async function settle(f:ReturnType<typeof mount>){
  await waitFor(()=>assert.ok(f.calls.some(c=>c.path.endsWith('/lookup'))));
  await act(async()=>{for(const c of f.calls.filter(c=>c.path.endsWith('/mutes/lookup')))c.finish(Response.json(item(c.body)));});
  await waitFor(()=>assert.equal(screen.getAllByRole('button',{name:'Mute routine updates'})[0]!.getAttribute('aria-disabled'),'false'));
}
const result=(command:any,conflict=false,version=1,muted=true)=>({operation_state:conflict?'version_conflict':'applied',operation_id:randomUUID(),idempotency:'created',policy_version:version,kind:'mute',outcome:{...command,target:command.target,result_version:version},current:item(command.target,version,muted)});
function muteResult(command:any,conflict=false,version=1,muted=true){const value=result(command,conflict,version,muted);delete value.outcome.idempotency_key;return value;}
const selectionResult=(inputs:any[],selection='exact-selection',policy_version=0)=>({selection,inputs,policy_version,shared_events:inputs.filter(v=>v.kind==='shared_event').length,
  personal_signals:inputs.filter(v=>v.kind==='personal_delivery').length,membership:'exact_represented_inputs_including_unexpanded_direct_sources',expires_at:'2030-01-01T00:00:00Z'});
const dismissResult=(command:any,version:number)=>({kind:'dismissal',operation_state:'applied',idempotency:'created',operation_id:randomUUID(),policy_version:version,
  outcome:{inputs:command.inputs.map((v:any)=>({...v,result_version:version}))},current:command.inputs.map(({kind,id,dismissed}:any)=>({kind,id,dismissed,version,availability:'available'}))});
const availableItem=(value:ReturnType<typeof target>,version=0,muted=false)=>({...item(value,version,muted),
  source:{state:'available',title:'Protected title',path:[],browser_url:'/loom/resource/'+value.resource_id},
  other_current_scope_mutes:[{target:{kind:'area',resource_id:randomUUID()},include_descendants:true}]});
function mountSettings(t:TestContext){
  const context={community:{instance_id:randomUUID()},self:{participant_id:randomUUID(),csrf:'synthetic'}} as Context;
  const initial=availableItem(target(),1,true),recovery=new AttentionRecovery(context.community.instance_id,context.self.participant_id);
  const calls:{path:string;body:any;finish:(r:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(path:string,options:any)=>new Promise<Response>(finish=>calls.push({path,body:JSON.parse(options.body),finish})));
  const router=createMemoryRouter([{path:'/',element:<AttentionPage context={context}/>}]);t.after(()=>router.dispose());
  render(<StrictMode><RouterProvider router={router}/></StrictMode>);
  const page=()=>({collection:'mutes',mutes:[initial],dismissals:[],policy_version:1,next_cursor:null,complete:true});
  return {initial,recovery,calls,page};
}
async function settleSettings(f:ReturnType<typeof mountSettings>){
  await act(async()=>{for(const c of f.calls.filter(c=>c.path.endsWith('/list')))c.finish(Response.json(f.page()));});
  await act(async()=>{for(const c of f.calls.filter(c=>c.path.endsWith('/lookup')))c.finish(Response.json(f.initial));});
  assert.ok(screen.getByText(/Protected title/));
}

for(const mode of ['first','status','retry'] as const)test(`delayed ${mode} mute result cannot restore withdrawn metadata or cancel its fresh lookup`,async t=>{
  const f=mount(t),available=availableItem(f.targets[0]!);
  await act(async()=>{for(const c of f.calls)c.finish(Response.json(available));});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Mute routine updates'})));
  await waitFor(()=>assert.ok(f.calls.some(c=>c.path.endsWith('/state'))));const first=f.calls.find(c=>c.path.endsWith('/state'))!;
  if(mode!=='first'){
    await act(async()=>first.finish(Response.json({error:{code:'service_unavailable',message:'Unconfirmed',operation_outcome:'unknown'}},{status:503})));
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:mode==='status'?'Check attention outcome':'Retry same attention change'})));
  }
  const pending=f.calls.at(-1)!,applied={...muteResult(first.body),current:{...available,version:1,muted:true}};
  await act(async()=>window.dispatchEvent(new Event('loom-attention-policy')));
  await act(async()=>f.calls.at(-1)!.finish(Response.json(item(f.targets[0]!,1,true))));
  assert.equal(!!screen.queryByText(/Protected title/),false);
  await act(async()=>pending.finish(Response.json(applied)));
  assert.equal(!!screen.queryByText(/Protected title/),false,'the delayed decision must not reauthorize metadata');
  assert.equal(!!screen.queryByText(/Other mutes still apply/),false);assert.equal(f.recovery.all().length,0);
  const fresh=f.calls.at(-1)!;assert.ok(fresh.path.endsWith('/lookup'));
  await act(async()=>fresh.finish(Response.json(item(f.targets[0]!,1,true))));
  assert.equal(!!screen.queryByText(/Protected title/),false);
  assert.equal(screen.getByRole('button',{name:'Unmute routine updates'}).getAttribute('aria-disabled'),'false');
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh mute state'})));
  await act(async()=>f.calls.at(-1)!.finish(Response.json({...available,version:1,muted:true})));
  assert.ok(screen.getByText(/Protected title/),'a fresh authorized lookup can restore the preview');
});

for(const withdrawal of ['refusal','lookup'] as const)test(`late settings snapshot cannot restore metadata after a newer ${withdrawal}`,async t=>{
  const f=mountSettings(t);await settleSettings(f);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh attention settings'})));const stale=f.calls.at(-1)!;
  if(withdrawal==='refusal'){
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Unmute routine updates'})));
    await act(async()=>f.calls.at(-1)!.finish(Response.json({error:{code:'invalid_actor',message:'Current authority refused'}},{status:403})));
  }else{
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh mute state'})));
    await act(async()=>f.calls.at(-1)!.finish(Response.json(item(f.initial.target,1,true))));
  }
  assert.equal(!!screen.queryByText(/Protected title/),false);
  const count=f.calls.length;await act(async()=>stale.finish(Response.json(f.page())));
  assert.equal(!!screen.queryByText(/Protected title/),false,'list metadata cannot supersede withdrawal');
  assert.equal(!!screen.queryByText(/Other mutes still apply/),false);
  await act(async()=>{for(const c of f.calls.slice(count))c.finish(Response.json(item(f.initial.target,1,true)));});
  assert.equal(!!screen.queryByText(/Protected title/),false);
});

for(const retry of [false,true])test(`global recovery ${retry?'retry':'status'} refusal withdraws settings and fences a pending list`,async t=>{
  const f=mountSettings(t),command:AttentionCommandView={kind:'mute',body:{idempotency_key:randomUUID(),target:f.initial.target,muted:false,include_descendants:false,expected_version:1}};
  await act(async()=>{const record=await f.recovery.save(command,()=>true);await f.recovery.begin(record);});await settleSettings(f);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh attention settings'})));const stale=f.calls.at(-1)!;
  const recovery=within(screen.getByText('Attention recovery (1)').parentElement!);
  await act(async()=>fireEvent.click(recovery.getByRole('button',{name:retry?'Retry same attention change':'Check attention outcome'})));
  await act(async()=>f.calls.at(-1)!.finish(Response.json({error:{code:'invalid_actor',message:'Current authority refused'}},{status:403})));
  assert.equal(!!screen.queryByText(/Protected title/),false);assert.equal(!!screen.queryByText(/Other mutes still apply/),false);
  await act(async()=>stale.finish(Response.json(f.page())));assert.equal(!!screen.queryByText(/Protected title/),false);
  assert.deepEqual(f.recovery.all()[0]!.command,command);assert.equal(f.recovery.all()[0]!.state,'uncertain');
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry attention settings'})));
  await act(async()=>f.calls.at(-1)!.finish(Response.json(f.page())));
  await act(async()=>{for(const c of f.calls.filter(c=>c.path.endsWith('/lookup')))c.finish(Response.json(f.initial));});
  assert.ok(screen.getByText(/Protected title/),'fresh authorized settings and lookup remain usable');
});

test('preparing an overlapping new group exposes the original uncertain command and blocks a replacement',async t=>{
  const group=randomUUID(),f=mount(t,[],group),input={kind:'shared_event' as const,id:randomUUID(),version:0,dismissed:false,availability:'available'};
  const command:AttentionCommandView={kind:'dismissal',group_id:randomUUID(),body:{idempotency_key:randomUUID(),selection:'original-selection',inputs:[{kind:input.kind,id:input.id,dismissed:true,expected_version:0}]}};
  await act(async()=>{const record=await f.recovery.save(command,()=>true);await f.recovery.begin(record);});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss this update'})));
  await act(async()=>f.calls[0]!.finish(Response.json(selectionResult([input],'new-selection'))));
  assert.ok(screen.queryByRole('button',{name:'Check attention outcome'}),'newly discovered overlap must expose recovery immediately');
  const confirm=screen.getByRole('button',{name:'Confirm dismissal'});assert.equal(confirm.getAttribute('aria-disabled'),'true');
  await act(async()=>fireEvent.click(confirm));assert.equal(f.calls.length,1);assert.deepEqual(f.recovery.all()[0]!.command,command);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry same attention change'})));
  assert.deepEqual(f.calls[1]!.body,command.body);assert.equal(f.recovery.all().length,1);
  await act(async()=>f.calls[1]!.finish(Response.json(dismissResult(command.body,1))));
  assert.equal(f.recovery.all().length,0);assert.ok(screen.getByRole('button',{name:'Undo dismissal / restore these inputs'}));
  assert.equal(!!screen.queryByRole('button',{name:'Confirm dismissal'}),false);
});

test('changing a mounted card cursor cancels preparation and requires an explicit selection from the new cursor',async t=>{
  const context={community:{instance_id:randomUUID()},self:{participant_id:randomUUID(),csrf:'synthetic'}} as Context,group=randomUUID();
  const calls:{body:any;finish:(r:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(_path:string,options:any)=>new Promise<Response>(finish=>calls.push({body:JSON.parse(options.body),finish})));
  const card=(cursor:string)=><StrictMode><AuthorizationBoundary sourcePolicy="settings"><DismissControl context={context} cursor={cursor} groupId={group}/></AuthorizationBoundary></StrictMode>,view=render(card('highlights'));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss this update'})));await waitFor(()=>assert.equal(calls.length,1));
  view.rerender(card('complete'));
  const old={kind:'shared_event',id:randomUUID(),version:0,dismissed:false,availability:'available'};
  await act(async()=>calls[0]!.finish(Response.json(selectionResult([old],'old-selection'))));
  const choose=screen.queryByRole('button',{name:'Dismiss this update'});assert.ok(choose,'cursor changes must release the preparation state');
  assert.equal(choose.getAttribute('aria-disabled'),'false');assert.equal(!!screen.queryByRole('button',{name:'Confirm dismissal'}),false);
  await act(async()=>fireEvent.click(choose));await waitFor(()=>assert.equal(calls.length,2));assert.equal(calls[1]!.body.cursor,'complete');
  const fresh={...old,id:randomUUID()};await act(async()=>calls[1]!.finish(Response.json(selectionResult([old,fresh],'new-selection'))));
  assert.ok(screen.getByText(/2 shared events and 0 personal signals/));
  view.rerender(card('direct'));
  assert.equal(!!screen.queryByRole('button',{name:'Confirm dismissal'}),false,'a reviewed selection also belongs to its original cursor');
  assert.ok(screen.getByRole('button',{name:'Dismiss this update'}));assert.equal(calls.length,2,'switching never prepares or submits implicitly');
});

test('successful Undo offers a focused fresh Dismiss and uses newly reviewed versions on the same card',async t=>{
  const group=randomUUID(),f=mount(t,[],group),input={kind:'shared_event',id:randomUUID(),version:0,dismissed:false,availability:'available'};
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss this update'})));await waitFor(()=>assert.equal(f.calls.length,1));
  await act(async()=>f.calls[0]!.finish(Response.json(selectionResult([input]))));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Confirm dismissal'})));await waitFor(()=>assert.equal(f.calls.length,2));const first=f.calls[1]!.body;
  await act(async()=>f.calls[1]!.finish(Response.json(dismissResult(first,1))));
  const undo=screen.getByRole('button',{name:'Undo dismissal / restore these inputs'});undo.focus();await act(async()=>fireEvent.click(undo));await waitFor(()=>assert.equal(f.calls.length,3));
  assert.deepEqual(f.calls[2]!.body.inputs,[{kind:input.kind,id:input.id,dismissed:false,expected_version:1}]);
  await act(async()=>f.calls[2]!.finish(Response.json(dismissResult(f.calls[2]!.body,2))));
  const choose=screen.queryByRole('button',{name:'Dismiss this update'});assert.ok(choose,'successful restoration must permit another deliberate dismissal');
  assert.equal(choose.getAttribute('aria-disabled'),'false');assert.equal(document.activeElement,choose);
  assert.equal(!!screen.queryByRole('button',{name:'Undo dismissal / restore these inputs'}),false);assert.ok(screen.getByText(/Restoration saved/));
  assert.equal(f.recovery.all().length,0);assert.equal(f.calls.length,3);
  await act(async()=>fireEvent.click(choose));await waitFor(()=>assert.equal(f.calls.length,4));
  await act(async()=>f.calls[3]!.finish(Response.json(selectionResult([{...input,version:2}],'fresh-selection',2))));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Confirm dismissal'})));await waitFor(()=>assert.equal(f.calls.length,5));
  const second=f.calls[4]!.body;assert.notEqual(second.idempotency_key,first.idempotency_key);assert.equal(second.selection,'fresh-selection');
  assert.deepEqual(second.inputs,[{kind:input.kind,id:input.id,dismissed:true,expected_version:2}]);
  await act(async()=>f.calls[4]!.finish(Response.json(dismissResult(second,3))));assert.ok(screen.getByRole('button',{name:'Undo dismissal / restore these inputs'}));
});

for(const [mode,code,status] of [['first','unavailable',404],['first','forbidden',403],['status','invalid_actor',403],['retry','unauthenticated',401]] as const)
test(`${mode} mute ${code} withdraws cached source and overlap metadata and fences earlier lookups`,async t=>{
  const f=mount(t);await settle(f);const available={...item(f.targets[0]!),source:{state:'available',title:'Private cached title',path:[],browser_url:'/loom/artifacts/'+f.targets[0]!.resource_id},
    other_current_scope_mutes:[{target:{kind:'area',resource_id:randomUUID()},include_descendants:true}]};
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh mute state'})));
  await act(async()=>f.calls.at(-1)!.finish(Response.json(available)));assert.ok(screen.getByText(/Private cached title/));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Mute routine updates'})));await waitFor(()=>assert.ok(f.calls.some(c=>c.path.endsWith('/state'))));
  const first=f.calls.find(c=>c.path.endsWith('/state'))!;
  if(mode!=='first'){
    await act(async()=>first.finish(Response.json({error:{code:'service_unavailable',message:'Unconfirmed',operation_outcome:'unknown'}},{status:503})));
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:mode==='status'?'Check attention outcome':'Retry same attention change'})));
    await waitFor(()=>assert.equal(f.calls.filter(c=>c.path.endsWith('/state')||c.path.endsWith('/status')).length,2));
  }
  const failure=f.calls.at(-1)!;
  await act(async()=>window.dispatchEvent(new Event('loom-attention-policy')));const stale=f.calls.at(-1)!;assert.ok(stale.path.endsWith('/lookup'));
  await act(async()=>failure.finish(Response.json({error:{code,message:'Current access refused'}},{status})));
  assert.equal(!!screen.queryByText(/Private cached title/),false);assert.equal(!!screen.queryByText(/Other mutes still apply/),false);
  if(code==='unavailable'||code==='forbidden')assert.equal(screen.getByRole('button',{name:'Mute routine updates'}).getAttribute('aria-disabled'),'true');
  else assert.equal(document.querySelectorAll('[data-mute-target]').length,0);
  assert.deepEqual(f.recovery.all()[0]!.command.body,first.body);assert.equal(f.recovery.all()[0]!.state,mode==='first'?'rejected':'uncertain');
  await act(async()=>stale.finish(Response.json({...available,version:9})));assert.equal(!!screen.queryByText(/Private cached title/),false,'a response begun before the refusal cannot reauthorize the source');
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:code==='unavailable'||code==='forbidden'?'Refresh mute state':'Retry protected view'})));
  await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(available));});assert.ok(screen.getByText(/Private cached title/),'a fresh successful lookup may reauthorize the source');
});

test('StrictMode saves and reads exact mute command before dispatch; older lookups cannot replace the applied version',async t=>{
  const f=mount(t);await settle(f);const button=screen.getByRole('button',{name:'Mute routine updates'});button.focus();
  await act(async()=>fireEvent.click(button));await waitFor(()=>assert.ok(f.calls.some(c=>c.path.endsWith('/state'))));const c=f.calls.find(c=>c.path.endsWith('/state'))!;
  assert.deepEqual(f.recovery.all()[0]!.command.body,c.body);assert.equal(f.recovery.all()[0]!.attempts,1);
  await act(async()=>c.finish(Response.json(muteResult(c.body))));await waitFor(()=>assert.equal(f.recovery.all().length,0));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh mute state'})));
  const lookups=f.calls.filter(c=>c.path.endsWith('/lookup'));await act(async()=>lookups.at(-1)!.finish(Response.json(item(c.body.target,2,false))));
  await act(async()=>{for(const old of lookups.slice(0,-1))old.finish(Response.json(item(c.body.target,1,true)));});
  await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Mute routine updates'})));assert.equal(document.activeElement,button);
  assert.ok(f.calls.every(c=>!c.path.includes('/reading/')));
});
for(const conflictFirst of [true,false])test(`conflict stays on its target with ${conflictFirst?'earlier':'later'} unrelated success and survives reopening`,async t=>{
  const targets=[target(),target()],f=mount(t,targets),control=(i:number)=>within(document.querySelector<HTMLElement>(`[data-mute-target="artifact:${targets[i]!.resource_id}"]`)!);await settle(f);
  await act(async()=>{for(let i=0;i<2;i++)fireEvent.click(control(i).getByRole('button',{name:'Mute routine updates'}));});
  await waitFor(()=>assert.equal(f.calls.filter(c=>c.path.endsWith('/state')).length,2));const commands=f.calls.filter(c=>c.path.endsWith('/state'));
  for(const i of conflictFirst?[0,1]:[1,0])await act(async()=>commands[i]!.finish(Response.json(muteResult(commands[i]!.body,i===0))));
  await waitFor(()=>assert.ok(control(0).queryByText(/Attention change conflicted/)));assert.equal(!!control(1).queryByText(/Attention change conflicted/),false);
  assert.equal(f.recovery.all().length,1);assert.deepEqual(f.recovery.all()[0]!.command.body,commands[0]!.body);
  await act(async()=>f.router.navigate('/other'));await act(async()=>f.router.navigate('/attention'));
  await waitFor(()=>assert.ok(control(0).queryByText(/Attention change conflicted/)));assert.equal(!!control(1).queryByText(/Attention change conflicted/),false);
  await act(async()=>fireEvent.click(control(0).getByRole('button',{name:'Dismiss attention conflict notice'})));await waitFor(()=>assert.equal(f.recovery.all().length,0));
  assert.equal(f.calls.filter(c=>c.path.endsWith('/state')).length,2);
});
test('storage save failure prevents dispatch and leaves unrelated recovery intact',async t=>{
  const f=mount(t);await settle(f);localStorage.setItem('loom.reading.unrelated','preserve');const original=dom.window.Storage.prototype.setItem;
  t.mock.method(dom.window.Storage.prototype,'setItem',function(this:Storage,k:string,v:string){if(k.startsWith('loom.attention:'))throw new Error('full');original.call(this,k,v);});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Mute routine updates'})));await waitFor(()=>assert.ok(screen.getByText(/could not be saved/)));
  assert.equal(f.calls.filter(c=>c.path.endsWith('/state')).length,0);assert.equal(localStorage.getItem('loom.reading.unrelated'),'preserve');
});
for(const retried of [false,true])test(`selection expiry on ${retried?'an uncertain retry':'first dispatch'} preserves the correct recovery classification`,async t=>{
  const group=randomUUID(),f=mount(t,[],group),input={kind:'shared_event',id:randomUUID(),version:0,dismissed:false,availability:'available'};
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss this update'})));await waitFor(()=>assert.equal(f.calls.length,1));
  await act(async()=>f.calls[0]!.finish(Response.json({selection:'expires',inputs:[input],policy_version:0,shared_events:1,personal_signals:0,membership:'exact_represented_inputs_including_unexpanded_direct_sources',expires_at:'2030-01-01T00:00:00Z'})));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Confirm dismissal'})));await waitFor(()=>assert.equal(f.calls.length,2));
  if(retried){
    await act(async()=>f.calls[1]!.finish(Response.json({error:{code:'service_unavailable',message:'Uncertain',operation_outcome:'unknown'}},{status:503})));
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry same attention change'})));await waitFor(()=>assert.equal(f.calls.length,3));
  }
  await act(async()=>f.calls.at(-1)!.finish(Response.json({error:{code:'attention_selection_expired',message:'Selection expired'}},{status:410})));
  await waitFor(()=>assert.equal(f.recovery.all()[0]!.state,retried?'uncertain':'rejected'));
  assert.equal(!!screen.queryByRole('button',{name:'Dismiss attention refusal notice'}),!retried);
});
test('late route and account responses cannot create UI choices or recreate cleared recovery',async t=>{
  const f=mount(t);await settle(f);await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Mute routine updates'})));
  await waitFor(()=>assert.ok(f.calls.some(c=>c.path.endsWith('/state'))));const c=f.calls.find(c=>c.path.endsWith('/state'))!;
  let notifications=0;const notified=()=>notifications++;window.addEventListener('loom-attention-policy',notified);t.after(()=>window.removeEventListener('loom-attention-policy',notified));
  await act(async()=>{await f.recovery.clear();await f.router.navigate('/other');invalidateIdentity();c.finish(Response.json(muteResult(c.body)));});
  assert.equal(f.recovery.all().length,0);assert.equal(notifications,0);assert.equal(!!screen.queryByText(/Choice saved/),false);assert.ok(screen.getByRole('heading',{name:'Other'}));
});
test('group command freezes all prepared identities; exact retry and Undo retain original versions despite newer current state',async t=>{
  const group=randomUUID(),f=mount(t,[],group),inputs=[{kind:'shared_event',id:randomUUID(),version:0,dismissed:false,availability:'available'},{kind:'personal_delivery',id:randomUUID(),version:0,dismissed:false,availability:'available'}];
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss this update'})));await waitFor(()=>assert.equal(f.calls.length,1));
  await act(async()=>f.calls[0]!.finish(Response.json({selection:'frozen-membership',inputs,policy_version:0,shared_events:1,personal_signals:1,membership:'exact_represented_inputs_including_unexpanded_direct_sources',expires_at:'2030-01-01T00:00:00Z'})));
  assert.ok(screen.getByText(/1 shared event and 1 personal signal/));await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Confirm dismissal'})));
  await waitFor(()=>assert.equal(f.calls.length,2));const command=f.calls[1]!.body;assert.deepEqual(f.recovery.all()[0]!.command,{kind:'dismissal',group_id:group,body:command});
  await act(async()=>f.calls[1]!.finish(Response.json({error:{code:'unknown',message:'Response lost',operation_outcome:'unknown'}},{status:503})));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check attention outcome'})));await waitFor(()=>assert.equal(f.calls.length,3));
  await act(async()=>f.calls[2]!.finish(Response.json({operation_state:'not_recorded'})));assert.equal(f.recovery.all().length,1);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry same attention change'})));await waitFor(()=>assert.equal(f.calls.length,4));assert.deepEqual(f.calls[3]!.body,command);
  const applied={kind:'dismissal',operation_state:'applied',idempotency:'replayed',operation_id:randomUUID(),policy_version:3,outcome:{inputs:command.inputs.map((v:any)=>({...v,result_version:1}))},current:inputs.map(v=>({...v,dismissed:true,version:3}))};
  await act(async()=>f.calls[3]!.finish(Response.json(applied)));await waitFor(()=>assert.equal(f.recovery.all().length,0));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Undo dismissal / restore these inputs'})));await waitFor(()=>assert.equal(f.calls.length,5));
  assert.equal(f.calls[4]!.path,'/api/v1/me/attention/dismissals/state');
  assert.deepEqual(f.calls[4]!.body.inputs,inputs.map(({kind,id})=>({kind,id,dismissed:false,expected_version:1})));
  assert.deepEqual(f.recovery.all()[0]!.command.body,f.calls[4]!.body);
  assert.equal(f.calls[4]!.body.selection,undefined);assert.ok(f.calls.every(c=>!c.path.includes('/reading/')));
});
test('dismissal conflict acknowledgement allows a fresh explicit selection on the same mounted card',async t=>{
  const group=randomUUID(),f=mount(t,[],group),input={kind:'shared_event',id:randomUUID(),version:0,dismissed:false,availability:'available'};
  const prepared=(version:number)=>({selection:'selection-'+version,inputs:[{...input,version}],policy_version:version,shared_events:1,personal_signals:0,membership:'exact_represented_inputs_including_unexpanded_direct_sources',expires_at:'2030-01-01T00:00:00Z'});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss this update'})));await waitFor(()=>assert.equal(f.calls.length,1));
  await act(async()=>f.calls[0]!.finish(Response.json(prepared(0))));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Confirm dismissal'})));await waitFor(()=>assert.equal(f.calls.length,2));
  const first=f.calls[1]!.body;
  await act(async()=>f.calls[1]!.finish(Response.json({kind:'dismissal',operation_state:'version_conflict',idempotency:'created',operation_id:randomUUID(),policy_version:1,
    outcome:{inputs:first.inputs.map((v:any)=>({...v,result_version:1}))},current:[{...input,version:1,dismissed:true}]})));
  await waitFor(()=>assert.equal(f.recovery.all()[0]!.state,'conflicted'));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss attention conflict notice'})));await waitFor(()=>assert.equal(f.recovery.all().length,0));
  const choose=screen.queryByRole('button',{name:'Dismiss this update'});assert.ok(choose,'the mounted card must offer another deliberate choice');
  assert.equal(choose.getAttribute('aria-disabled'),'false');assert.equal(f.calls.length,2,'acknowledgement does not send another mutation');
  await act(async()=>fireEvent.click(choose));await waitFor(()=>assert.equal(f.calls.length,3));
  await act(async()=>f.calls[2]!.finish(Response.json(prepared(1))));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Confirm dismissal'})));await waitFor(()=>assert.equal(f.calls.length,4));
  assert.notEqual(f.calls[3]!.body.idempotency_key,first.idempotency_key);
  assert.deepEqual(f.calls[3]!.body.inputs,[{kind:input.kind,id:input.id,dismissed:true,expected_version:1}]);
  assert.equal(f.calls[3]!.body.selection,'selection-1');
});
test('active mutes loaded in Attention settings can be unmuted without a second refresh',async t=>{
  const context={community:{instance_id:randomUUID()},self:{participant_id:randomUUID(),csrf:'synthetic'}} as Context,initial=item(target(),1,true);
  const calls:{path:string;body:any;finish:(r:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(path:string,options:any)=>new Promise<Response>(finish=>calls.push({path,body:JSON.parse(options.body),finish})));
  const router=createMemoryRouter([{path:'/',element:<AttentionPage context={context}/>}]);t.after(()=>router.dispose());
  render(<StrictMode><RouterProvider router={router}/></StrictMode>);
  await waitFor(()=>assert.ok(calls.length));
  await act(async()=>{for(const c of calls.filter(c=>c.path.endsWith('/list')))c.finish(Response.json({collection:'mutes',mutes:[initial],dismissals:[],policy_version:1,next_cursor:null,complete:true}));});
  await waitFor(()=>assert.ok(calls.some(c=>c.path.endsWith('/lookup'))));
  await act(async()=>{for(const c of calls.filter(c=>c.path.endsWith('/lookup')))c.finish(Response.json({...initial,version:2}));});
  const button=screen.getByRole('button',{name:'Unmute routine updates'});assert.equal(button.getAttribute('aria-disabled'),'false');
  await act(async()=>fireEvent.click(button));await waitFor(()=>assert.ok(calls.some(c=>c.path.endsWith('/state'))));
  const command=calls.find(c=>c.path.endsWith('/state'))!;
  assert.equal(command.body.muted,false);assert.equal(command.body.expected_version,2,'the initial snapshot must not discard a newer lookup');
  await act(async()=>command.finish(Response.json(muteResult(command.body,false,3,false))));
  await waitFor(()=>assert.ok(screen.queryByRole('button',{name:'Mute routine updates'})));
});
test('journal bounds and stale-tab attempts preserve immutable intent, conflicts and absent-status uncertainty',async()=>{
  const owner=randomUUID(),instance=randomUUID(),a=new AttentionRecovery(instance,owner),b=new AttentionRecovery(instance,owner);
  const command=():AttentionCommandView=>({kind:'mute',body:{target:target(),include_descendants:false,muted:true,expected_version:0,idempotency_key:randomUUID()}});
  const saved=await a.save(command(),()=>true),first=await a.begin(saved);await b.begin(saved);await a.rejectFirst(first);assert.equal(a.all()[0]!.state,'uncertain');
  await a.recordConflict(saved);await b.finish(a.all()[0]!,true);await a.recordConflict(saved);assert.equal(a.all().length,0,'late conflict cannot recreate cleared notice');
  for(let i=0;i<128;i++)await a.save(command(),()=>true);await assert.rejects(a.save(command(),()=>true),/full/);assert.equal(a.all().length,128);
  await a.clear();
  const large=():AttentionCommandView=>({kind:'dismissal',body:{idempotency_key:randomUUID(),selection:'x'.repeat(32000),inputs:Array.from({length:100},()=>({kind:'shared_event',id:randomUUID(),dismissed:true,expected_version:0}))}});
  let count=0;while(count<128){try{await a.save(large(),()=>true);count++;}catch(error){assert.match((error as Error).message,/full/);break;}}
  assert.ok(count>1&&count<128,'the total UTF-8 byte cap applies before the record cap');assert.equal(a.all().length,count);
  await a.clear();invalidateIdentity();await assert.rejects(b.save(command(),()=>true),/Identity changed/);assert.equal(a.all().length,0);
});

test('source inputs changed before confirmation invalidate old reviewed membership',async t=>{
 const context={community:{instance_id:randomUUID()},self:{participant_id:randomUUID(),csrf:'fixture'}} as Context;
 const a={kind:'shared_event' as const,id:randomUUID()},b={kind:'personal_delivery' as const,id:randomUUID()};
 const calls:{path:string;body:any;finish:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string,options:any)=>new Promise<Response>(finish=>calls.push({path,body:JSON.parse(options.body),finish})));
 const card=(inputs:any[])=><StrictMode><AuthorizationBoundary sourcePolicy="settings"><DismissControl context={context} inputs={inputs}/></AuthorizationBoundary></StrictMode>,view=render(card([a,b]));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss these source inputs'})));
 await act(async()=>calls[0]!.finish(Response.json({items:[a,b].map(v=>({...v,version:0,dismissed:false,availability:'available'})),policy_version:0})));
 assert.ok(screen.getByRole('button',{name:'Confirm dismissal'}));
 view.rerender(card([b]));
 assert.equal(!!screen.queryByRole('button',{name:'Confirm dismissal'}),false,'unconfirmed selection must follow displayed source inputs');
});
test('child credential refusal withdraws other settings previews',async t=>{
 const f=mountSettings(t),second={...availableItem(target(),1,true),source:{state:'available',title:'Second protected title',path:[],browser_url:'/loom/resource/'+randomUUID()}};
 await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/list')))call.finish(Response.json({...f.page(),mutes:[f.initial,second]}));});
 await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(call.body.resource_id===f.initial.target.resource_id?f.initial:second));});
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh attention settings'})));const pending=f.calls.at(-1)!;
 await act(async()=>fireEvent.click(screen.getAllByRole('button',{name:'Unmute routine updates'})[0]!));
 const mutation=f.calls.at(-1)!;await act(async()=>mutation.finish(Response.json({error:{code:'invalid_actor',message:'Credential revoked'}},{status:403})));
 assert.equal(!!screen.queryByText(/Second protected title/),false,'credential failure invalidates the whole owner-private view');
 await act(async()=>pending.finish(Response.json({...f.page(),mutes:[f.initial,second]})));
 assert.equal(document.querySelectorAll('[data-mute-target]').length,0);assert.ok(screen.getAllByRole('alert').some(node=>node.textContent?.includes('Credential revoked')));
 assert.deepEqual(f.recovery.all()[0]!.command.body,mutation.body);assert.equal(f.recovery.all()[0]!.state,'uncertain');
});

test('pending source-input lookup cannot restore an earlier selection after its inputs change',async t=>{
 const context={community:{instance_id:randomUUID()},self:{participant_id:randomUUID(),csrf:'fixture'}} as Context;
 const a={kind:'shared_event' as const,id:randomUUID()},b={kind:'personal_delivery' as const,id:randomUUID()};
 const calls:{body:any;finish:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(_path:string,options:any)=>new Promise<Response>(finish=>calls.push({body:JSON.parse(options.body),finish})));
 const card=(inputs:any[])=><StrictMode><AuthorizationBoundary sourcePolicy="settings"><DismissControl context={context} inputs={inputs}/></AuthorizationBoundary></StrictMode>,view=render(card([a,b]));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss these source inputs'})));
 view.rerender(card([b]));
 await act(async()=>calls[0]!.finish(Response.json({items:[a,b].map(v=>({...v,version:0,dismissed:false,availability:'available'})),policy_version:0})));
 assert.equal(!!screen.queryByRole('button',{name:'Confirm dismissal'}),false);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss these source inputs'})));
 assert.deepEqual(calls[1]!.body,{inputs:[b]});
 await act(async()=>calls[1]!.finish(Response.json({items:[{...b,version:0,dismissed:false,availability:'available'}],policy_version:0})));
 view.rerender(card([{...b}]));assert.ok(screen.getByRole('button',{name:'Confirm dismissal'}),'equivalent new arrays keep the reviewed selection');
});

test('known unavailable settings retain safe Unmute while child Restore credential failures withdraw its list',async t=>{
 const f=mountSettings(t),unavailable={...f.initial,source:{state:'unavailable'},other_current_scope_mutes:[]};
 await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/list')))call.finish(Response.json({...f.page(),mutes:[unavailable]}));});
 await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(unavailable));});
 assert.equal(screen.getByRole('button',{name:'Unmute routine updates'}).getAttribute('aria-disabled'),'false');
 assert.equal(!!screen.queryByText(/Protected title/),false);
 await act(async()=>fireEvent.change(screen.getByLabelText('Manage'),{target:{value:'dismissals'}}));
 const input={kind:'shared_event',id:randomUUID(),version:1,dismissed:true,availability:'unavailable'};
 await act(async()=>f.calls.at(-1)!.finish(Response.json({collection:'dismissals',mutes:[],dismissals:[input],policy_version:1,next_cursor:null,complete:true})));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Restore this input'})));const mutation=f.calls.at(-1)!;
 assert.deepEqual(mutation.body.inputs,[{kind:input.kind,id:input.id,dismissed:false,expected_version:1}]);
 await act(async()=>mutation.finish(Response.json({error:{code:'unauthenticated',message:'Credential revoked'}},{status:401})));
 assert.equal(!!screen.queryByRole('button',{name:'Restore this input'}),false);assert.ok(screen.getByRole('button',{name:'Retry attention settings'}));
 assert.deepEqual(f.recovery.all()[0]!.command.body,mutation.body);
});

test('a source restored after an unavailable settings snapshot cannot bypass later host withdrawal',async t=>{
  const f=mountSettings(t),second=availableItem(target(),1,true);second.source.title='Sibling protected preview';
  const unavailable=[f.initial,second].map(value=>({...value,source:{state:'unavailable'},other_current_scope_mutes:[]}));
  await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/list')))call.finish(Response.json({...f.page(),mutes:unavailable}));});
  await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(unavailable.find(value=>value.target.resource_id===call.body.resource_id)));});
  for(const value of [f.initial,second]){
    const control=within(document.querySelector(`[data-mute-target="artifact:${value.target.resource_id}"]`) as HTMLElement);
    await act(async()=>fireEvent.click(control.getByRole('button',{name:'Refresh mute state'})));
    await act(async()=>f.calls.at(-1)!.finish(Response.json(value)));
  }
  assert.ok(screen.getByText(/Protected title/));assert.ok(screen.getByText(/Sibling protected preview/));
  const control=within(document.querySelector(`[data-mute-target="artifact:${f.initial.target.resource_id}"]`) as HTMLElement);
  await act(async()=>fireEvent.click(control.getByRole('button',{name:'Refresh mute state'})));
  await act(async()=>f.calls.at(-1)!.finish(Response.json(unavailable[0])));
  assert.equal(!!screen.queryByText(/Protected title/),false);
  assert.equal(!!screen.queryByText(/Sibling protected preview/),false,'new source withdrawal must invalidate sibling previews even when the original list was unavailable');
  assert.equal(f.recovery.all().length,0);
});

for(const path of ['lookup','mutation','status','retry'] as const)for(const refusal of [false,true])
test(`repeated settings visibility transitions through ${path} ${refusal?'refusal':'result'} fence siblings and pending reads`,async t=>{
  const f=mountSettings(t),second=availableItem(target(),1,true);second.source.title='Sibling protected preview';
  const values=[f.initial,second],unavailable=values.map(value=>({...value,source:{state:'unavailable'},other_current_scope_mutes:[]}));
  const control=(value=values[0]!)=>within(document.querySelector(`[data-mute-target="artifact:${value.target.resource_id}"]`) as HTMLElement);
  const refresh=async(value:typeof f.initial,visible:boolean)=>{
    await act(async()=>fireEvent.click(control(value).getByRole('button',{name:'Refresh mute state'})));
    await act(async()=>f.calls.at(-1)!.finish(Response.json(visible?value:{...value,source:{state:'unavailable'},other_current_scope_mutes:[]})));
  };
  await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/list')))call.finish(Response.json({...f.page(),mutes:unavailable}));});
  await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(unavailable.find(value=>value.target.resource_id===call.body.resource_id)));});
  for(const value of values){assert.equal(control(value).getByRole('button',{name:'Unmute routine updates'}).getAttribute('aria-disabled'),'false');await refresh(value,true);}
  if(path==='status'||path==='retry'){
    await act(async()=>fireEvent.click(control().getByRole('button',{name:'Unmute routine updates'})));
    await act(async()=>f.calls.at(-1)!.finish(Response.json({error:{code:'service_unavailable',message:'Unconfirmed',operation_outcome:'unknown'}},{status:503})));
  }
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh attention settings'})));const list=f.calls.at(-1)!;
  await act(async()=>fireEvent.click(control(second).getByRole('button',{name:'Refresh mute state'})));const sibling=f.calls.at(-1)!;
  await act(async()=>fireEvent.click(control().getByRole('button',{name:path==='lookup'?'Refresh mute state':path==='mutation'?'Unmute routine updates':path==='status'?'Check attention outcome':'Retry same attention change'})));
  const pending=f.calls.at(-1)!,command=f.recovery.all()[0]?.command;
  await act(async()=>pending.finish(Response.json(refusal?{error:{code:'unavailable',message:'Source unavailable'}}:path==='lookup'?unavailable[0]:
    muteResult(command!.body,false,2,false),{status:refusal?404:200})));
  assert.equal(screen.queryAllByText(/Protected title|Sibling protected preview|Other mutes still apply/).length,0);
  await act(async()=>{list.finish(Response.json({...f.page(),mutes:values}));sibling.finish(Response.json(second));});
  assert.equal(screen.queryAllByText(/Protected title|Sibling protected preview|Other mutes still apply/).length,0,'pending list and sibling lookup cannot restore metadata');
  if(command)assert.equal(f.recovery.all().length,refusal?1:0);
  // A second restoration and withdrawal must follow the same rules without a
  // remount or a replacement of the original unavailable collection snapshot.
  const renewed={...f.initial,version:3};await refresh(renewed,true);await refresh(second,true);
  assert.ok(screen.getByText(/Protected title/));assert.ok(screen.getByText(/Sibling protected preview/));
  await refresh(renewed,false);
  assert.equal(screen.queryAllByText(/Protected title|Sibling protected preview|Other mutes still apply/).length,0);
  assert.equal(control(second).getByRole('button',{name:'Unmute routine updates'}).getAttribute('aria-disabled'),'false');
  if(command&&refusal)assert.deepEqual(f.recovery.all()[0]!.command,command);
});

for(const mode of ['mutation','status','retry'] as const)test(`pending ${mode} settles exact custody across repeated source fences without authorizing previews`,async t=>{
  const f=mountSettings(t),other=availableItem(target(),1,true);other.source.title='Sibling protected preview';
  const values=[f.initial,other],hidden=values.map(value=>({...value,source:{state:'unavailable'},other_current_scope_mutes:[]}));
  const control=(value:typeof f.initial)=>within(document.querySelector(`[data-mute-target="artifact:${value.target.resource_id}"]`) as HTMLElement);
  const refresh=async(value:typeof f.initial,visible:boolean)=>{
    await act(async()=>fireEvent.click(control(value).getByRole('button',{name:'Refresh mute state'})));
    await act(async()=>f.calls.at(-1)!.finish(Response.json(visible?value:{...value,source:{state:'unavailable'},other_current_scope_mutes:[]})));
  };
  await act(async()=>{for(const call of f.calls)call.finish(Response.json({...f.page(),mutes:hidden}));});
  await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(hidden.find(v=>v.target.resource_id===call.body.resource_id)));});
  for(const value of values)await refresh(value,true);
  await act(async()=>fireEvent.click(control(f.initial).getByRole('button',{name:'Unmute routine updates'})));
  const first=f.calls.at(-1)!,command=f.recovery.all()[0]!.command;
  if(mode!=='mutation'){
    await act(async()=>first.finish(Response.json({error:{code:'service_unavailable',message:'Unconfirmed',operation_outcome:'unknown'}},{status:503})));
    await act(async()=>fireEvent.click(control(f.initial).getByRole('button',{name:mode==='status'?'Check attention outcome':'Retry same attention change'})));
  }
  const pending=f.calls.at(-1)!;
  for(let cycle=0;cycle<2;cycle++){
    await refresh(other,false);assert.equal(screen.queryAllByText(/Protected title|Sibling protected preview/).length,0);
    if(!cycle){await refresh(other,true);assert.ok(screen.getByText(/Sibling protected preview/));}
    assert.deepEqual(f.recovery.all()[0]!.command,command);
  }
  const count=f.calls.length;
  await act(async()=>pending.finish(Response.json({...muteResult(first.body,false,2,false),current:{...f.initial,version:2,muted:false}})));
  assert.equal(f.recovery.all().length,0);assert.equal(screen.queryAllByText(/Protected title|Sibling protected preview/).length,0);
  await act(async()=>{for(const call of f.calls.slice(count).filter(c=>c.path.endsWith('/lookup'))){const value=values.find(v=>v.target.resource_id===call.body.resource_id)!;
    call.finish(Response.json({...value,version:2,muted:value===other,source:{state:'unavailable'},other_current_scope_mutes:[]}));}});
  assert.equal(screen.queryAllByText(/Protected title|Sibling protected preview/).length,0);
  assert.equal(control(f.initial).getByRole('button',{name:'Mute routine updates'}).getAttribute('aria-disabled'),'false');
});

for(const withdrawalFirst of [false,true])test(`same-turn sibling responses retain their own authorization with withdrawal ${withdrawalFirst?'first':'last'}`,async t=>{
  const f=mountSettings(t),second=availableItem(target(),1,true);second.source.title='Sibling protected preview';
  const values=[f.initial,second],hidden=values.map(value=>({...value,source:{state:'unavailable'},other_current_scope_mutes:[]}));
  await act(async()=>{for(const call of f.calls)call.finish(Response.json({...f.page(),mutes:hidden}));});
  await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(hidden.find(v=>v.target.resource_id===call.body.resource_id)));});
  const control=(value:typeof f.initial)=>within(document.querySelector(`[data-mute-target="artifact:${value.target.resource_id}"]`) as HTMLElement);
  for(const value of values){await act(async()=>fireEvent.click(control(value).getByRole('button',{name:'Refresh mute state'})));
    await act(async()=>f.calls.at(-1)!.finish(Response.json(value)));}
  await act(async()=>fireEvent.click(control(f.initial).getByRole('button',{name:'Refresh mute state'})));const fresh=f.calls.at(-1)!;
  await act(async()=>fireEvent.click(control(second).getByRole('button',{name:'Refresh mute state'})));const withdrawal=f.calls.at(-1)!;
  await act(async()=>{for(const call of withdrawalFirst?[withdrawal,fresh]:[fresh,withdrawal])call.finish(Response.json(call===withdrawal?hidden[1]:f.initial));});
  assert.equal(screen.queryAllByText(/Protected title|Sibling protected preview|Other mutes still apply/).length,0);
  assert.equal(control(f.initial).getByRole('button',{name:'Unmute routine updates'}).getAttribute('aria-disabled'),'false');
});

for(const retry of [false,true])test(`global ${retry?'retry':'status'} unavailable result invalidates all settings previews without losing safe controls`,async t=>{
  const f=mountSettings(t),command:AttentionCommandView={kind:'mute',body:{idempotency_key:randomUUID(),target:f.initial.target,muted:false,include_descendants:false,expected_version:1}};
  await act(async()=>{const saved=await f.recovery.save(command,()=>true);await f.recovery.begin(saved);});await settleSettings(f);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh attention settings'})));const old=f.calls.at(-1)!;
  const recovery=within(screen.getByText('Attention recovery (1)').parentElement!);
  await act(async()=>fireEvent.click(recovery.getByRole('button',{name:retry?'Retry same attention change':'Check attention outcome'})));
  const operation=f.calls.at(-1)!;
  await act(async()=>operation.finish(Response.json(muteResult(command.body,false,2,false))));
  assert.equal(!!screen.queryByText(/Protected title/),false);assert.equal(!!screen.queryByText(/Other mutes still apply/),false);
  assert.equal(f.recovery.all().length,0);
  await act(async()=>old.finish(Response.json(f.page())));
  assert.equal(!!screen.queryByText(/Protected title/),false);
  await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(item(f.initial.target,2,false)));});
  assert.equal(screen.getByRole('button',{name:'Mute routine updates'}).getAttribute('aria-disabled'),'false');
});
