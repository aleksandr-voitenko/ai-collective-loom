import assert from 'node:assert/strict';
import {test,afterEach,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode} from 'react';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {ActiveView} from '../../src/web/ParticipationRoutes.js';
import {AuthorizationBoundary,useAuthorization} from '../../src/web/AuthorizationBoundary.js';
import {IntentStore,invalidateIdentity} from '../../src/web/participation-client.js';
import type {Context} from '../../src/web/participation-state.js';
import type {RevisionView} from '../../src/contracts/participation.js';
import type {IntentResultView,IntentPageView} from '../../src/contracts/reservations.js';
const locks=navigator.locks,dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
const {render,screen,fireEvent,cleanup,act,waitFor,within}=await import('@testing-library/react');
afterEach(()=>{cleanup();invalidateIdentity();localStorage.clear();});
function fixture(){
  const instance=randomUUID(),participant=randomUUID(),id=randomUUID(),base=randomUUID(),person={id:participant,nickname:'Alice',kind:'human' as const};
  const c={store:new IntentStore(instance,participant,localStorage,location.origin,locks),self:{participant_id:participant,credential_id:randomUUID(),nickname:'Alice',kind:'human',role:'participant'},community:{instance_id:instance}} as Context;
  const revision:RevisionView={resource_id:id,revision_id:base,current_revision_id:base,kind:'artifact',title:'Exact publication',revision_number:'1',author:person,publisher:person,created_at:'2026-10-24T00:00:00Z',area_id:randomUUID(),area_title:'General',discussion_id:null,parent_id:null,can_edit:true,publication_open:true,full_content_url:'/api/v1/resources/'+id,content:{format:'loom-markdown-v1',text:'Preserved authored source',mentions:[]},mentioned_participants:[]};
  const notice={notice_id:randomUUID(),version:1,expires_at:'2026-10-24T01:00:00Z',released_at:null,state:'active' as const,resource_id:id,base_revision_id:base,participant_id:participant,participant_nickname:'Alice',purpose:'Private scope details',scope:{kind:'whole' as const},older_base:false,owner_may_edit:true};
  const page:IntentPageView={items:[notice],observed_at:'2026-10-24T00:30:00Z',next_cursor:null,complete:true};
  const receipt:IntentResultView={operation_state:'recorded',operation_id:randomUUID(),action:'announce',idempotency:'replayed',outcome:{notice_id:notice.notice_id,version:1,accepted_at:page.observed_at,expires_at:notice.expires_at,released_at:null},current:{notice_id:notice.notice_id,version:1,expires_at:notice.expires_at,released_at:null,state:'active'},observed_at:page.observed_at};
  return {c,id,base,revision,page,receipt};
}
function mount(t:TestContext,f:ReturnType<typeof fixture>,route='/loom/resource/'+f.id){
  const calls:{path:string;options:RequestInit|undefined;done:boolean;finish:(r:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(path:string,options?:RequestInit)=>new Promise<Response>(resolve=>{const c={path,options,done:false,finish(r:Response){c.done=true;resolve(r);}};calls.push(c);}));
  function Probe(){const a=useAuthorization();return <button onClick={()=>void a.read('/api/v1/resources/'+randomUUID()).catch(()=>{})}>Probe source authority</button>;}
  const router=createMemoryRouter([{path:'/loom/*',element:<ActiveView context={f.c}/>},{path:'/other',element:<h1>Other route</h1>}],{initialEntries:[route]});
  render(<StrictMode><RouterProvider router={router}/><AuthorizationBoundary><Probe/></AuthorizationBoundary></StrictMode>);t.after(()=>router.dispose());
  async function answer(path:string,body:unknown,status=200){await waitFor(()=>assert.ok(calls.some(c=>!c.done&&c.path===path),'Expected '+path));await act(async()=>calls.filter(c=>!c.done&&c.path===path).forEach(c=>c.finish(Response.json(body,{status}))));}
  return {calls,router,answer};
}
const path=(f:ReturnType<typeof fixture>)=>'/api/v1/editing-intent/resources/'+f.id+'?limit=12';
test('StrictMode production resource controls are explicit, preserve publication after optional fetch failure and mark background observations stale',async t=>{
  const f=fixture(),m=mount(t,f);await m.answer('/api/v1/resources/'+f.id,f.revision);
  assert.equal(m.calls.filter(c=>c.path.includes('/editing-intent')).length,0);assert.equal(f.c.store.all().length,0);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect editing intent'})));
  await m.answer(path(f),{error:{code:'service_unavailable',message:'Temporary failure'}},503);
  assert.ok(screen.getByText('Preserved authored source'));assert.ok(screen.getByRole('button',{name:'Edit this text'}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh editing intent'})));await m.answer(path(f),f.page);
  assert.ok(screen.getByText('Private scope details'));await act(async()=>window.dispatchEvent(new Event('focus')));
  assert.equal((screen.getByRole('button',{name:'Renew editing intent'}) as HTMLButtonElement).disabled,true);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh editing intent'})));await m.answer(path(f),f.page);
  await act(async()=>window.dispatchEvent(new Event('online')));assert.equal((screen.getByRole('button',{name:'Renew editing intent'}) as HTMLButtonElement).disabled,true);
  assert.equal(m.calls.filter(c=>c.path.startsWith('/api/v1/editing-intent/')&&c.options?.method==='POST').length,0,'No focus/reconnect/render renewal');assert.equal(f.c.store.all().length,0);
});
for(const departure of ['denial','route','identity'] as const)test('production source host fences late editing metadata after '+departure,async t=>{
  const f=fixture(),m=mount(t,f);await m.answer('/api/v1/resources/'+f.id,f.revision);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect editing intent'})));const pending=m.calls.filter(c=>c.path===path(f));
  if(departure==='route')await act(async()=>m.router.navigate('/other'));else if(departure==='identity')await act(async()=>invalidateIdentity());
  else{await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Probe source authority'})));const probe=m.calls.at(-1)!;await act(async()=>probe.finish(Response.json({error:{code:'unavailable',message:'Source denied'}},{status:404})));}
  await act(async()=>pending.forEach(c=>c.finish(Response.json(f.page))));assert.equal(screen.queryByText('Private scope details'),null);assert.equal(screen.queryByText('Preserved authored source'),null);
});
test('two retained commands remain distinguishable after remount; exact retry and unknown status leave other bytes intact',async t=>{
  const f=fixture(),second=fixture();
  const one=await f.c.store.prepareEditingIntent('renew',{notice_id:f.receipt.current.notice_id,expected_version:1,duration_minutes:30},{resource:f.id,base:f.base},()=>true);
  const two=await f.c.store.prepareEditingIntent('release',{notice_id:second.receipt.current.notice_id,expected_version:3},{resource:second.id,base:second.base},()=>true);
  const retained=f.c.store.storage.getItem(f.c.store.prefix+two.key),m=mount(t,f,'/loom/editing-intent');assert.equal(m.calls.length,0);
  const group=within(screen.getByRole('group',{name:'renew '+one.key}));assert.ok(group.getByText(/Expected version 1/));assert.ok(screen.getByText(new RegExp(second.base)));
  await act(async()=>fireEvent.click(group.getByRole('button',{name:'Check editing intent outcome'})));
  await m.answer('/api/v1/editing-intent/status',{operation_state:'not_recorded'});assert.equal(f.c.store.all()[0]!.state,'uncertain');
  await act(async()=>fireEvent.click(group.getByRole('button',{name:'Retry exact editing intent command'})));
  assert.equal(m.calls.at(-1)!.options!.body,JSON.stringify(one.body));await m.answer('/api/v1/editing-intent/renew',{...f.receipt,action:'renew'});
  assert.equal(f.c.store.all().find(r=>r.key===one.key)!.state,'committed');assert.equal(f.c.store.storage.getItem(f.c.store.prefix+two.key),retained);
  assert.equal(m.calls.filter(c=>c.options?.method!=='POST').length,0,'Private receipts do not hydrate source');
});
test('failed durable storage prevents dispatch and retains existing records',async t=>{
  const f=fixture(),m=mount(t,f);await m.answer('/api/v1/resources/'+f.id,f.revision);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect editing intent'})));await m.answer(path(f),{...f.page,items:[]});
  await act(async()=>fireEvent.change(screen.getByLabelText('Purpose'),{target:{value:'Durable intention'}}));
  const before=Object.entries(localStorage);t.mock.method(Object.getPrototypeOf(f.c.store.storage),'setItem',()=>{throw new Error('Storage refused');});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Announce editing intent'})));
  await waitFor(()=>assert.ok(screen.getByRole('alert')));assert.equal(m.calls.filter(c=>c.path.startsWith('/api/v1/editing-intent/')&&c.options?.method==='POST').length,0);assert.deepEqual(Object.entries(localStorage),before);
});
for(const identity of [false,true])test('late private receipts cannot settle a departed journal, identity='+identity,async t=>{
  const f=fixture(),record=await f.c.store.prepareEditingIntent('release',{notice_id:f.receipt.current.notice_id,expected_version:1},{resource:f.id,base:f.base},()=>true),m=mount(t,f,'/loom/editing-intent');
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check editing intent outcome'})));const before=Object.entries(localStorage);
  await act(async()=>{if(identity)invalidateIdentity();else void m.router.navigate('/other');});
  await m.answer('/api/v1/editing-intent/status',{...f.receipt,action:'release'});assert.deepEqual(Object.entries(localStorage),before);assert.equal(f.c.store.storage.getItem(f.c.store.prefix+record.key),before.find(([k])=>k===f.c.store.prefix+record.key)![1]);
});


for(const failure of ['readback','capacity'] as const)test('production announce prevents dispatch on '+failure+' while preserving older durable commands',async t=>{
  const f=fixture();
  if(failure==='capacity')for(let i=0;i<32;i++)await f.c.store.prepareEditingIntent('release',{notice_id:randomUUID(),expected_version:1},{resource:randomUUID(),base:randomUUID()},()=>true);
  const before=Object.entries(localStorage),m=mount(t,f);await m.answer('/api/v1/resources/'+f.id,f.revision);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect editing intent'})));await m.answer(path(f),{...f.page,items:[]});
  await act(async()=>fireEvent.change(screen.getByLabelText('Purpose'),{target:{value:'Durable intention'}}));
  if(failure==='readback')t.mock.method(Object.getPrototypeOf(f.c.store.storage),'setItem',()=>{});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Announce editing intent'})));
  await waitFor(()=>assert.ok(screen.getByRole('alert')));assert.deepEqual(Object.entries(localStorage),before);
  assert.equal(m.calls.filter(c=>c.path.startsWith('/api/v1/editing-intent/')&&c.options?.method==='POST').length,0);assert.ok(screen.getByRole('button',{name:'Edit this text'}));
});

test('source denial withdraws editing metadata before any blocked durable settlement can complete',async t=>{
  const f=fixture(),m=mount(t,f);await m.answer('/api/v1/resources/'+f.id,f.revision);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect editing intent'})));await m.answer(path(f),f.page);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Renew editing intent'})));
  await waitFor(()=>assert.ok(m.calls.some(c=>c.path==='/api/v1/editing-intent/renew')));const saved=Object.entries(localStorage);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  t.mock.method(locks,'request',async(_name:string,work:()=>unknown)=>{await gate;return work();});
  try{await m.answer('/api/v1/editing-intent/renew',{error:{code:'forbidden',message:'Editing authority withdrawn'}},403);
    assert.equal(screen.queryByText('Private scope details'),null);assert.equal(screen.queryByText('Preserved authored source'),null);assert.deepEqual(Object.entries(localStorage),saved);
  }finally{await act(async()=>release());}
});

for(const kind of ['revision.publish','summary.revise'] as const)test('recovered '+kind+' announces its retained base and preserves the complete draft after notice refresh',async t=>{
  const f=fixture(),older=randomUUID();
  if(kind==='summary.revise')f.revision.kind='summary';
  const body={resource_id:f.id,expected_revision_id:older,title:'Retained title',change_note:null,change_account:null,content:{format:'loom-markdown-v3',text:'Retained attempted text',mentions:[],references:[]},
    ...(kind==='summary.revise'?{coverage:{carry_forward_revision_id:older}}:{file_set:{version:'artifact-files-v1',files:[{path:'retained.txt',source:{revision_id:older,file_id:randomUUID()}}]}})};
  const path=kind==='summary.revise'?'/api/v1/summary-revisions':'/api/v1/revisions';
  const draft=await f.c.store.saveDraft(f.c.store.create('retained draft',kind,path,body),body),raw=f.c.store.storage.getItem(f.c.store.prefix+draft.key);
  const m=mount(t,f,'/loom/resource/'+f.id+'?edit=1&intent='+draft.key);await m.answer('/api/v1/resources/'+f.id,f.revision);
  assert.equal((screen.getByLabelText('Text') as HTMLTextAreaElement).value,body.content.text);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect editing intent'})));
  await m.answer('/api/v1/editing-intent/resources/'+f.id+'?limit=12',{...f.page,items:[]});
  await act(async()=>fireEvent.change(screen.getByLabelText('Purpose'),{target:{value:'Continue the retained draft'}}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Announce editing intent'})));
  await waitFor(()=>assert.ok(m.calls.some(c=>c.path==='/api/v1/editing-intent/announce')));
  const request=JSON.parse(String(m.calls.find(c=>c.path==='/api/v1/editing-intent/announce')!.options!.body));
  assert.equal(request.base_revision_id,older);assert.equal(f.c.store.storage.getItem(f.c.store.prefix+draft.key),raw);
  await m.answer('/api/v1/editing-intent/announce',f.receipt);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh editing intent'})));
  await m.answer('/api/v1/editing-intent/resources/'+f.id+'?limit=12',f.page);
  assert.equal(f.c.store.storage.getItem(f.c.store.prefix+draft.key),raw);assert.equal((screen.getByLabelText('Text') as HTMLTextAreaElement).value,body.content.text);
});

test('failed private status retains uncertainty; only resolved custody can be explicitly dismissed',async t=>{
  const f=fixture(),record=await f.c.store.prepareEditingIntent('renew',{notice_id:f.receipt.current.notice_id,expected_version:1},{resource:f.id,base:f.base},()=>true),before=Object.entries(localStorage),m=mount(t,f,'/loom/editing-intent');
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check editing intent outcome'})));
  await m.answer('/api/v1/editing-intent/status',{error:{code:'service_unavailable',message:'Private status unavailable'}},503);
  assert.deepEqual(Object.entries(localStorage),before);assert.equal(screen.queryByRole('button',{name:'Dismiss resolved editing intent command'}),null);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check editing intent outcome'})));
  await m.answer('/api/v1/editing-intent/status',{...f.receipt,action:'renew'});
  assert.equal(f.c.store.all().find(r=>r.key===record.key)!.state,'committed');
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss resolved editing intent command'})));
  await waitFor(()=>assert.equal(f.c.store.all().length,0));assert.ok(screen.getByText('No saved editing intent commands.'));
});

test('invalid browser duration remains correctable without creating uncertain custody or dispatching',async t=>{
  const f=fixture(),m=mount(t,f);await m.answer('/api/v1/resources/'+f.id,f.revision);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect editing intent'})));await m.answer(path(f),{...f.page,items:[]});
  await act(async()=>{fireEvent.change(screen.getByLabelText('Purpose'),{target:{value:'Retained purpose'}});fireEvent.change(screen.getByLabelText('Duration in minutes'),{target:{value:'0'}});});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Announce editing intent'})));
  await waitFor(()=>assert.ok(screen.getByRole('alert')));assert.equal(f.c.store.all().length,0);assert.equal(m.calls.filter(c=>c.options?.method==='POST'&&c.path.includes('editing-intent')).length,0);
  await act(async()=>fireEvent.change(screen.getByLabelText('Duration in minutes'),{target:{value:'1'}}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Announce editing intent'})));
  await m.answer('/api/v1/editing-intent/announce',f.receipt);assert.equal(f.c.store.all()[0]!.body.purpose,'Retained purpose');assert.equal(f.c.store.all()[0]!.body.duration_minutes,1);
});

for(const withdrawal of ['source','editor'] as const)test('private release reconciles an unreceived renewal after '+withdrawal+' withdrawal without discarding custody',async t=>{
  const f=fixture(),target={resource:f.id,base:f.base};
  const announcement=await f.c.store.prepareEditingIntent('announce',{resource_id:f.id,base_revision_id:f.base,purpose:'Retained intent',scope:{kind:'whole'}},target,()=>true);
  await f.c.store.settle(announcement,{state:'committed'});
  const other=await f.c.store.prepareEditingIntent('renew',{notice_id:randomUUID(),expected_version:1},{resource:randomUUID(),base:randomUUID()},()=>true);
  const otherRaw=localStorage.getItem(f.c.store.prefix+other.key),m=mount(t,f);
  await m.answer('/api/v1/resources/'+f.id,f.revision);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect editing intent'})));await m.answer(path(f),f.page);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Renew editing intent'})));
  await m.answer('/api/v1/editing-intent/renew',{error:{code:'service_unavailable',message:'Request never reached server'}},503);
  const renewal=f.c.store.all().find(r=>r.kind==='editing-intent.renew'&&r.key!==other.key)!;
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh editing intent'})));
  if(withdrawal==='source')await m.answer(path(f),{error:{code:'unavailable',message:'Withdrawn source'}},404);
  else{await m.answer(path(f),{...f.page,items:[{...f.page.items[0],owner_may_edit:false}]});assert.equal((screen.getByRole('button',{name:'Release editing intent'}) as HTMLButtonElement).disabled,false);}
  await act(async()=>m.router.navigate('/loom/editing-intent'));
  const group=()=>within(screen.getByRole('group',{name:'renew '+renewal.key}));
  await act(async()=>fireEvent.click(group().getByRole('button',{name:'Check editing intent outcome'})));
  await m.answer('/api/v1/editing-intent/status',{operation_state:'not_recorded'});
  await act(async()=>fireEvent.click(group().getByRole('button',{name:'Retry exact editing intent command'})));
  await m.answer('/api/v1/editing-intent/renew',{error:{code:withdrawal==='source'?'unavailable':'forbidden',message:'Authority withdrawn'}},withdrawal==='source'?404:403);
  assert.equal(f.c.store.all().find(r=>r.key===renewal.key)!.state,'uncertain');
  await act(async()=>fireEvent.click(within(screen.getByRole('group',{name:'announce '+announcement.key})).getByRole('button',{name:'Check editing intent outcome'})));
  await m.answer('/api/v1/editing-intent/status',f.receipt);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Release recovered editing intent'})));
  await m.answer('/api/v1/editing-intent/release',{...f.receipt,action:'release',outcome:{...f.receipt.outcome,version:2,released_at:f.receipt.observed_at},current:{...f.receipt.current,version:2,state:'released',released_at:f.receipt.observed_at}});
  assert.equal(f.c.store.all().find(r=>r.key===renewal.key)!.state,'uncertain','Release is not proof of the earlier command outcome');
  await assert.rejects(f.c.store.prepareEditingIntent('announce',announcement.body,target,()=>true),/Resolve/);
  await act(async()=>fireEvent.click(group().getByRole('button',{name:'Keep command and unblock new intent'})));
  await waitFor(()=>assert.ok(group().getByText(/no longer blocks new intent/)));
  const retained=f.c.store.all().find(r=>r.key===renewal.key)!;assert.deepEqual(retained.body,renewal.body);assert.equal(retained.key,renewal.key);assert.equal(retained.state,'uncertain');
  assert.equal(localStorage.getItem(f.c.store.prefix+other.key),otherRaw);
  await act(async()=>fireEvent.click(group().getByRole('button',{name:'Check editing intent outcome'})));
  await m.answer('/api/v1/editing-intent/status',{operation_state:'not_recorded'});assert.ok(screen.getByText(/notice is permanently released; the exact command remains retained/));
  await act(async()=>m.router.navigate('/loom/resource/'+f.id));
  const retry=screen.queryAllByRole('button',{name:'Retry protected view'})[0];if(retry)await act(async()=>fireEvent.click(retry));
  await m.answer('/api/v1/resources/'+f.id,f.revision);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect editing intent'})));await m.answer(path(f),{...f.page,items:[]});
  await act(async()=>fireEvent.change(screen.getByLabelText('Purpose'),{target:{value:'New deliberate intent'}}));
  assert.equal((screen.getByRole('button',{name:'Announce editing intent'}) as HTMLButtonElement).disabled,false);
});

test('terminal reconciliation retains exact custody across late replies and a new store; invalid evidence cannot unblock intent',async()=>{
  const f=fixture(),store=f.c.store,target={resource:f.id,base:f.base};
  const renewal=await store.prepareEditingIntent('renew',{notice_id:f.receipt.current.notice_id,expected_version:1},target,()=>true);
  const released:IntentResultView={...f.receipt,current:{...f.receipt.current,version:2,state:'released',released_at:f.receipt.observed_at}};
  for(const evidence of [{operation_state:'not_recorded'} as const,f.receipt,{...released,current:{...released.current,state:'expired' as const}},{...released,current:{...released.current,released_at:null}},{...released,current:{...released.current,notice_id:randomUUID()}},{...released,current:{...released.current,version:1}}])await assert.rejects(store.acknowledgeEditingIntentRelease(renewal,evidence,()=>true),/confirmed terminal/);
  await assert.rejects(store.acknowledgeEditingIntentRelease(renewal,released,()=>false),{name:'AbortError'});
  const retained=await store.acknowledgeEditingIntentRelease(renewal,released,()=>true);
  assert.deepEqual(retained.body,renewal.body);assert.equal(retained.state,'uncertain');
  await assert.rejects(store.acknowledgeEditingIntentRelease(renewal,released,()=>true),/changed in another view/);
  await assert.rejects(store.prepareDispatch(renewal,renewal.body),/changed in another view/);
  const later=await store.settle(renewal,{state:'committed'});assert.deepEqual(later.editing_intent_release,released);assert.deepEqual(later.body,renewal.body);
  const reload=new IntentStore(store.instance,store.participant,localStorage,location.origin,locks);assert.deepEqual(reload.all(),[later]);
  const next=await reload.prepareEditingIntent('announce',{resource_id:f.id,base_revision_id:f.base,purpose:'New intention',scope:{kind:'whole'}},target,()=>true);
  await assert.rejects(reload.prepareEditingIntent('release',{notice_id:f.receipt.current.notice_id,expected_version:2},target,()=>true),/Resolve/,'An unknown announcement is never bypassed');
  await assert.rejects(reload.acknowledgeEditingIntentRelease(next,released,()=>true),/confirmed terminal/);
  localStorage.setItem(store.prefix+later.key,JSON.stringify({...later,editing_intent_release:{...released,current:{...released.current,state:'active'}}}));assert.throws(()=>reload.all(),/terminal editing intent receipt is incompatible/);
});

test('release exception is notice-specific and never overlaps another uncertain release',async()=>{
  const f=fixture(),store=f.c.store,target={resource:f.id,base:f.base};
  const renewal=await store.prepareEditingIntent('renew',{notice_id:f.receipt.current.notice_id,expected_version:2},target,()=>true);
  for(const body of [{notice_id:randomUUID(),expected_version:2},{notice_id:f.receipt.current.notice_id,expected_version:1}])await assert.rejects(store.prepareEditingIntent('release',body,target,()=>true),/Resolve/);
  await assert.rejects(store.prepareEditingIntent('renew',renewal.body,target,()=>true),/Resolve/);
  const release=await store.prepareEditingIntent('release',{notice_id:f.receipt.current.notice_id.toUpperCase(),expected_version:2},target,()=>true);
  await assert.rejects(store.prepareEditingIntent('release',release.body,target,()=>true),/Resolve/);
  const receipt:IntentResultView={...f.receipt,current:{...f.receipt.current,version:3,state:'released',released_at:f.receipt.observed_at}};
  const reconciled=await store.acknowledgeEditingIntentRelease(release,receipt,()=>true);assert.equal(reconciled.state,'uncertain');assert.deepEqual(reconciled.body,release.body);
});

test('failed terminal reconciliation write preserves the earlier request and its overlap guard',async t=>{
  const f=fixture(),store=f.c.store,target={resource:f.id,base:f.base};
  const renewal=await store.prepareEditingIntent('renew',{notice_id:f.receipt.current.notice_id,expected_version:1},target,()=>true),before=Object.entries(localStorage);
  const receipt:IntentResultView={...f.receipt,current:{...f.receipt.current,version:2,state:'released',released_at:f.receipt.observed_at}};
  t.mock.method(Object.getPrototypeOf(localStorage),'setItem',()=>{});
  await assert.rejects(store.acknowledgeEditingIntentRelease(renewal,receipt,()=>true),/could not be saved/);
  assert.deepEqual(Object.entries(localStorage),before);await assert.rejects(store.prepareEditingIntent('renew',renewal.body,target,()=>true),/Resolve/);
});

for(const departure of ['storage','route','identity'] as const)test('mounted terminal reconciliation preserves custody after '+departure,async t=>{
  const f=fixture(),store=f.c.store,target={resource:f.id,base:f.base};
  const a=await store.prepareEditingIntent('announce',{resource_id:f.id,base_revision_id:f.base,purpose:'Retained intention',scope:{kind:'whole'}},target,()=>true);await store.settle(a,{state:'committed'});
  const r=await store.prepareEditingIntent('renew',{notice_id:f.receipt.current.notice_id,expected_version:1},target,()=>true),m=mount(t,f,'/loom/editing-intent');
  await act(async()=>fireEvent.click(within(screen.getByRole('group',{name:'announce '+a.key})).getByRole('button',{name:'Check editing intent outcome'})));
  await m.answer('/api/v1/editing-intent/status',{...f.receipt,current:{...f.receipt.current,version:2,state:'released',released_at:f.receipt.observed_at}});
  const before=Object.entries(localStorage);
  if(departure==='storage'){
    t.mock.method(Object.getPrototypeOf(localStorage),'setItem',()=>{});
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Keep command and unblock new intent'})));
    await waitFor(()=>assert.match(screen.getByRole('alert').textContent!,/could not be saved/));
  }else{
    let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
    t.mock.method(locks,'request',async(_name:string,work:()=>unknown)=>{await gate;return work();});
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Keep command and unblock new intent'})));
    await act(async()=>{if(departure==='identity')invalidateIdentity();else void m.router.navigate('/other');});
    await act(async()=>release());
  }
  assert.deepEqual(Object.entries(localStorage),before);assert.equal(store.all().find(i=>i.key===r.key)!.state,'uncertain');
});
