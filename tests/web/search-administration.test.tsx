import assert from 'node:assert/strict';
import {afterEach,test,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode} from 'react';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {Value} from '@sinclair/typebox/value';
import {ActiveView} from '../../src/web/ParticipationRoutes.js';
import {Onboarding} from '../../src/contracts/participation.js';
import {IntentStore,invalidateIdentity,sessionRequest,commandRequest} from '../../src/web/participation-client.js';
import type {Context} from '../../src/web/participation-state.js';
import {SearchMaintenanceRecovery} from '../../src/web/search-maintenance-recovery.js';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/loom/admin/search'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
const {render,screen,fireEvent,cleanup,act,within}=await import('@testing-library/react');
afterEach(()=>{cleanup();invalidateIdentity();localStorage.clear();});
const click=async(name:string)=>act(async()=>fireEvent.click(screen.getByRole('button',{name})));
const error=(code='service_unavailable',status=503)=>Response.json({error:{code,message:'Synthetic '+code}},{status});
const job=(generation=1)=>({id:randomUUID(),generation,claim_generation:3,attempts:3,failure:'processing_failed',resource_id:null,revision_id:null,source_event_id:null,source_intent_id:null});
async function fixture(t:TestContext,options:{fail?:boolean;hold?:boolean;role?:string}={}){
 const self={participant_id:randomUUID(),credential_id:randomUUID(),nickname:'Synthetic administrator',kind:'human',role:options.role??'administrator',csrf:'fixture'};
 t.mock.method(globalThis,'fetch',async()=>Response.json(self));await sessionRequest('/api/v1/identity/self');
 const community=Value.Create({...Onboarding,properties:{...Onboarding.properties,instance_id:{...Onboarding.properties.instance_id,default:randomUUID()}}});community.settings_version=1;
 const health={generation:1,scan_complete:true,worker_available:true,capacity_limited:false,event_discovery_caught_up:true,jobs:{pending:0,running:0,succeeded:5,failed:0}};
 const pages=new Map<string,{items:ReturnType<typeof job>[];next_after:string|null}>([['',{items:[],next_after:null}]]);
 const reads:string[]=[],writes:{path:string;body:any;finish:(r:Response)=>void}[]=[],held:{path:string;finish:(r:Response)=>void}[]=[];
 let fail=!!options.fail,hold=!!options.hold;
 t.mock.method(globalThis,'fetch',(path:string,options?:RequestInit)=>{
  if(options?.body)return new Promise<Response>(finish=>writes.push({path,body:JSON.parse(String(options.body)),finish}));
  reads.push(path);if(path==='/api/v1/identity/self')return Promise.resolve(Response.json(self));
  if(path==='/api/v1/guide')return Promise.resolve(Response.json({text:'Synthetic guide'}));
  if(hold)return new Promise<Response>(finish=>held.push({path,finish}));
  if(fail)return Promise.resolve(error());
  if(path.endsWith('/search/health'))return Promise.resolve(Response.json(health));
  if(path.includes('/search/failures'))return Promise.resolve(Response.json(pages.get(new URL(path,'https://loom.example').searchParams.get('after')??'')??{items:[],next_after:null}));
  return Promise.resolve(Response.json(community));
 });
 const context={self,community,store:new IntentStore(community.instance_id,self.participant_id),refreshCommunity:()=>{throw Error('Maintenance must not refresh Community');}} as Context;
 const router=createMemoryRouter([{path:'/loom/*',element:<ActiveView context={context}/>}],{initialEntries:['/loom/admin/search']});t.after(()=>router.dispose());
 await act(async()=>{render(<StrictMode><RouterProvider router={router}/></StrictMode>);});
 return{self,context,health,pages,reads,writes,held,router,fail:(value=true)=>{fail=value;},hold:(value=true)=>{hold=value;},finish:async(r:Response)=>act(async()=>writes.at(-1)!.finish(r))};
}
async function rebuild(){await click('Rebuild index');await act(async()=>fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Rebuild index'})));}
test('dedicated route loads bounded observations on entry; refresh performs reads only',async t=>{
 const f=await fixture(t);assert.ok(screen.getByRole('heading',{name:'Search indexing'}));assert.ok(screen.getByText('No queued work observed'));
 assert.deepEqual([...new Set(f.reads)],['/api/v1/admin/search/health','/api/v1/admin/search/failures']);
 const before=f.reads.length;await click('Refresh status');assert.equal(f.reads.length,before+2);assert.equal(f.writes.length,0);
});
test('initial failures stay unknown; successful retry replaces errors and transient failure qualifies retained observations',async t=>{
 const f=await fixture(t,{fail:true});assert.ok(screen.getByText('Status unavailable'));assert.equal(screen.queryByText('No queued work observed'),null);
 f.fail(false);await click('Refresh status');assert.ok(screen.getByText('No queued work observed'));
 f.fail();await click('Refresh status');assert.ok(screen.getByText(/Showing an earlier observation/));assert.ok(screen.getByText('No queued work observed'));assert.equal(f.writes.length,0);
});
test('rebuild confirmation cancels without writing and uncertain remount retries the original generation',async t=>{
 const f=await fixture(t);await click('Rebuild index');await click('Cancel');assert.equal(f.writes.length,0);
 await rebuild();assert.deepEqual(f.writes[0]!.body,{expected_generation:1});await f.finish(error());assert.ok(screen.getByText('Outcome not confirmed'));
 f.health.generation=2;await act(async()=>f.router.navigate('/loom/help'));await act(async()=>f.router.navigate('/loom/admin/search'));assert.equal(f.writes.length,1);
 await click('Refresh status');await click('Retry same request');assert.deepEqual(f.writes[1]!.body,f.writes[0]!.body);
 await f.finish(Response.json({generation:2}));assert.ok(screen.getByText('Rebuild request acknowledged'));assert.equal(f.writes.length,2);
});
test('initial loading does not invent counts and StrictMode older responses cannot replace the current observation',async t=>{
 const f=await fixture(t,{hold:true});assert.ok(screen.getByText('Loading status…'));assert.equal(screen.queryByText('No queued work observed'),null);
 const health=f.held.filter(r=>r.path.endsWith('/health')),pages=f.held.filter(r=>r.path.endsWith('/failures'));
 await act(async()=>{health.at(-1)!.finish(Response.json(f.health));pages.at(-1)!.finish(Response.json({items:[],next_after:null}));});
 await act(async()=>{health[0]!.finish(Response.json({...f.health,capacity_limited:true}));pages[0]!.finish(Response.json({items:[job()],next_after:null}));});
 assert.ok(screen.getByText('No queued work observed'));assert.equal(screen.queryByText('Capacity limited'),null);assert.equal(screen.queryByText('Processing could not finish'),null);
});
for(const change of ['scan','discovery','worker','capacity','pending','running','failed'] as const)test('status distinguishes '+change+' without a coverage claim',async t=>{
 const f=await fixture(t);if(change==='scan')f.health.scan_complete=false;else if(change==='discovery')f.health.event_discovery_caught_up=false;else if(change==='worker')f.health.worker_available=false;else if(change==='capacity')f.health.capacity_limited=true;else f.health.jobs[change]=1;
 await click('Refresh status');assert.ok(screen.getByText(change==='worker'?'Worker unavailable':change==='capacity'?'Capacity limited':change==='failed'?'Failures need attention':'Indexing in progress'));
 assert.equal(screen.queryByText('Up to date'),null);assert.equal(f.writes.length,0);
});
test('failed pages retain the exact continuation and one bounded page; restart and page retry restore heading focus',async t=>{
 const f=await fixture(t),first=job(),last=job();f.pages.set('',{items:[first],next_after:first.id});f.pages.set(first.id,{items:[last],next_after:null});await click('Refresh status');
 f.fail();await click('Next page');assert.equal(f.reads.at(-1),'/api/v1/admin/search/failures?after='+first.id);assert.ok(screen.getByRole('article',{name:'Failed job 1'}));
 assert.equal(document.activeElement,screen.getByRole('heading',{name:'Failed jobs'}));f.fail(false);await click('Retry this page');assert.equal(f.reads.at(-1),'/api/v1/admin/search/failures?after='+first.id);
 assert.equal(screen.getAllByRole('article').length,1);assert.ok(screen.getByText(last.id));assert.equal(screen.queryByText(first.id),null);
 await click('First page');assert.equal(f.reads.at(-1),'/api/v1/admin/search/failures');assert.ok(screen.getByText(first.id));assert.equal(document.activeElement,screen.getByRole('heading',{name:'Failed jobs'}));assert.equal(f.writes.length,0);
});
test('earlier generation jobs cannot retry; acknowledgement is separate from observed completion',async t=>{
 const f=await fixture(t),old=job(0),current=job();f.pages.set('',{items:[old,current],next_after:null});await click('Refresh status');
 const rows=screen.getAllByRole('article');assert.equal((within(rows[0]!).getByRole('button') as HTMLButtonElement).disabled,true);assert.ok(within(rows[0]!).getByText(/Earlier index generation/));
 await act(async()=>fireEvent.click(within(rows[1]!).getByRole('button')));assert.deepEqual(f.writes[0]!.body,{id:current.id,claim_generation:3});
 assert.equal((within(rows[1]!).getByRole('button') as HTMLButtonElement).disabled,true);
 await f.finish(Response.json({accepted:true}));assert.ok(screen.getByText('Retry request acknowledged'));assert.equal(screen.getAllByRole('article').length,2,'Acknowledgement must not pretend the failed job disappeared');
 f.pages.set('',{items:[old],next_after:null});f.health.jobs.succeeded++;await click('Refresh status');assert.equal(screen.getAllByRole('article').length,1);assert.equal(f.writes.length,1);
});
test('lost retry response survives remount without substituting a later claim generation',async t=>{
 const f=await fixture(t),failed=job();f.pages.set('',{items:[failed],next_after:null});await click('Refresh status');await click('Retry job');await f.finish(error());
 failed.claim_generation=9;await act(async()=>f.router.navigate('/loom/help'));await act(async()=>f.router.navigate('/loom/admin/search'));await click('Retry same request');assert.deepEqual(f.writes[1]!.body,{id:failed.id,claim_generation:3});await f.finish(Response.json({accepted:true}));assert.ok(screen.getByText('Retry request acknowledged'));
});
for(const uncertain of [false,true])test('generation conflict preserves original recovery after uncertainty '+uncertain,async t=>{
 const f=await fixture(t);await rebuild();if(uncertain){await f.finish(error());f.health.generation=4;await click('Refresh status');await click('Retry same request');}
 await f.finish(error('search_changed',409));assert.ok(screen.getByText(uncertain?'Outcome not confirmed':'Request rejected'));assert.equal(screen.queryByText('Rebuild request acknowledged'),null);
 assert.ok(f.writes.every(w=>w.body.expected_generation===1));if(uncertain){await click('Refresh status');assert.ok(screen.getByText('Outcome not confirmed'));assert.equal((screen.getByRole('button',{name:'Rebuild index'}) as HTMLButtonElement).disabled,true);}
});
for(const response of [{generation:8},{generation:2,extra:true},{accepted:true},null])test('invalid rebuild acknowledgement retains exact request '+JSON.stringify(response),async t=>{
 const f=await fixture(t);await rebuild();await f.finish(Response.json(response));assert.ok(screen.getByText('Outcome not confirmed'));assert.equal(screen.queryByText('Rebuild request acknowledged'),null);await click('Retry same request');assert.deepEqual(f.writes[1]!.body,{expected_generation:1});await f.finish(Response.json({generation:2}));
});
test('pending rebuild prevents duplicate dispatch and freezes the confirmed generation',async t=>{
 const f=await fixture(t);await click('Rebuild index');f.health.generation=2;await click('Refresh status');
 const confirm=within(screen.getByRole('dialog')).getByRole('button',{name:'Rebuild index'});await act(async()=>{fireEvent.click(confirm);fireEvent.click(confirm);});assert.equal(f.writes.length,1);assert.deepEqual(f.writes[0]!.body,{expected_generation:1});assert.equal((confirm as HTMLButtonElement).disabled,true);await f.finish(Response.json({generation:2}));
});
test('late command after navigation cannot settle recovery or refresh a different view',async t=>{
 const f=await fixture(t);await rebuild();await act(async()=>f.router.navigate('/loom/help'));const before=[...f.reads];await f.finish(Response.json({generation:2}));assert.deepEqual(f.reads,before);
 await act(async()=>f.router.navigate('/loom/admin/search'));assert.ok(screen.getByText('Outcome not confirmed'));assert.equal(f.writes.length,1);
});
test('role withdrawal hides observations, fences late commands and requires current administrator authority',async t=>{
 const f=await fixture(t);await rebuild();const pending=f.writes[0]!;
 const refused=commandRequest('/api/v1/admin/search/rebuild',{self:f.self as any,body:{expected_generation:1}});const rejected=assert.rejects(refused,{code:'forbidden'});await act(async()=>{f.writes.at(-1)!.finish(error('forbidden',403));await rejected;});
 assert.equal(screen.queryByText('No queued work observed'),null);const before=[...f.reads];await act(async()=>pending.finish(Response.json({generation:2})));assert.deepEqual(f.reads,before);assert.ok(screen.getByText('Outcome not confirmed'));
 f.self.role='participant';await click('Check access');assert.equal(f.reads.at(-1),'/api/v1/identity/self');assert.equal(screen.queryByText('No queued work observed'),null);
 f.self.role='administrator';await click('Check access');assert.ok(screen.getByText('No queued work observed'));assert.ok(screen.getByText('Outcome not confirmed'));assert.equal(f.writes.length,2);
});
test('identity withdrawal rejects late observations and cannot dispatch retained recovery',async t=>{
 const f=await fixture(t);f.hold();await click('Refresh status');const held=[...f.held];await act(async()=>{invalidateIdentity();for(const r of held)r.finish(Response.json(r.path.endsWith('/health')?f.health:{items:[],next_after:null}));});assert.equal(screen.queryByText('No queued work observed'),null);assert.equal(screen.queryByRole('button',{name:'Rebuild index'}),null);assert.equal(f.writes.length,0);
});
test('non-administrator direct entry neither reads operational metadata nor sends maintenance',async t=>{
 const f=await fixture(t,{role:'participant'});assert.ok(screen.getByText('Administrator access is required.'));assert.deepEqual(f.reads,[]);assert.equal(f.writes.length,0);
});
test('failed local custody prevents dispatch; unreadable recovery blocks replacement requests',async t=>{
 const f=await fixture(t);const prototype=Object.getPrototypeOf(localStorage);const mock=t.mock.method(prototype,'setItem',()=>{throw new Error('Storage unavailable');});await rebuild();assert.equal(f.writes.length,0);assert.ok(screen.getByText(/recovery could not be saved/));mock.mock.restore();
 localStorage.setItem(`loom.search-maintenance.v1:${location.origin}:${f.context.community.instance_id}:${f.self.participant_id}`,'invalid');
 await act(async()=>f.router.navigate('/loom/help'));await act(async()=>f.router.navigate('/loom/admin/search'));assert.ok(screen.getByText(/recovery is unreadable/));assert.equal((screen.getByRole('button',{name:'Rebuild index'}) as HTMLButtonElement).disabled,true);
});
for(const priorKind of ['rebuild','retry'] as const)test('initial persistence failure attributes the unsent action separately from acknowledged '+priorKind,async t=>{
 const f=await fixture(t),failed=job();f.pages.set('',{items:[failed],next_after:null});await click('Refresh status');
 if(priorKind==='rebuild'){await rebuild();await f.finish(Response.json({generation:2}));}else{await click('Retry job');await f.finish(Response.json({accepted:true}));}
 const custody=new SearchMaintenanceRecovery(f.context.community.instance_id,f.self.participant_id),prior=localStorage.getItem(custody.key),writes=f.writes.length;
 const set=localStorage.setItem.bind(localStorage);t.mock.method(Object.getPrototypeOf(localStorage),'setItem',(key:string,value:string)=>{if(key===custody.key&&value!==prior)throw Error('Synthetic initial persistence refusal');set(key,value);});
 if(priorKind==='rebuild')await click('Retry job');else await rebuild();
 assert.equal(f.writes.length,writes,'The attempted operation must send no POST');assert.equal(localStorage.getItem(custody.key),prior,'Prior custody bytes must remain exact');
 const attempted=within(screen.getByRole('region',{name:priorKind==='rebuild'?'Failed jobs':'Maintenance'})),previous=within(screen.getByRole('region',{name:priorKind==='rebuild'?'Maintenance':'Failed jobs'}));
 const feedback=within(attempted.getByRole('region',{name:priorKind==='rebuild'?'Job retry':'Rebuild request'}));
 assert.ok(feedback.getByText('Request not sent'));assert.ok(feedback.getByRole('alert'));assert.equal(feedback.queryByText(/acknowledged|Outcome not confirmed/),null);assert.equal(previous.queryByRole('alert'),null);
 assert.ok(feedback.getByText(priorKind==='rebuild'?failed.id:'1'));await click('Refresh status');assert.ok(feedback.getByText('Request not sent'));assert.equal(localStorage.getItem(custody.key),prior);assert.equal(f.writes.length,writes);
});
test('failure retaining a new acknowledgement remains uncertain after an older acknowledged request',async t=>{
 const f=await fixture(t),failed=job();f.pages.set('',{items:[failed],next_after:null});await click('Refresh status');await rebuild();await f.finish(Response.json({generation:2}));
 const set=localStorage.setItem.bind(localStorage);t.mock.method(Object.getPrototypeOf(localStorage),'setItem',(key:string,value:string)=>{if(key.startsWith('loom.search-maintenance.v1:')&&JSON.parse(value).state==='acknowledged')throw Error('Synthetic acknowledgement persistence refusal');set(key,value);});
 await click('Retry job');await f.finish(Response.json({accepted:true}));const feedback=within(screen.getByRole('region',{name:'Job retry'}));
 assert.ok(feedback.getByText('Outcome not confirmed'));assert.equal(feedback.queryByText('Request not sent'),null);assert.ok(feedback.getByRole('button',{name:'Retry same request'}));
 const custody=new SearchMaintenanceRecovery(f.context.community.instance_id,f.self.participant_id);assert.deepEqual(custody.read(),{version:1,sequence:2,state:'uncertain',request:{kind:'retry',body:{id:failed.id,claim_generation:3}}});assert.equal(f.writes.length,2);
});
test('an unsent action cannot hide a competing unresolved request or replace its payload',async t=>{
 const f=await fixture(t),failed=job();f.pages.set('',{items:[failed],next_after:null});await click('Refresh status');await rebuild();await f.finish(Response.json({generation:2}));
 const other=new SearchMaintenanceRecovery(f.context.community.instance_id,f.self.participant_id),prior=other.read()!;await other.attempt(prior.request,prior.sequence,()=>true,async()=>{throw Error('Synthetic response loss');});const retained=localStorage.getItem(other.key);
 await click('Retry job');const feedback=within(screen.getByRole('region',{name:'Job retry'}));assert.ok(feedback.getByText('Request not sent'));assert.equal(f.writes.length,1);assert.equal(localStorage.getItem(other.key),retained);
 await click('Review retained request');assert.ok(within(screen.getByRole('region',{name:'Rebuild request'})).getByText('Outcome not confirmed'));await click('Retry same request');assert.deepEqual(f.writes.at(-1)!.body,prior.request.body);await f.finish(Response.json({generation:2}));
});
test('post-dispatch custody and read failures cannot borrow an older acknowledgement',async t=>{
 const f=await fixture(t),failed=job();f.pages.set('',{items:[failed],next_after:null});await click('Refresh status');await rebuild();await f.finish(Response.json({generation:2}));await click('Retry job');
 const set=localStorage.setItem.bind(localStorage),get=localStorage.getItem.bind(localStorage);let unreadable=false;
 t.mock.method(Object.getPrototypeOf(localStorage),'setItem',(key:string,value:string)=>{if(key.startsWith('loom.search-maintenance.v1:')&&JSON.parse(value).state==='rejected'){unreadable=true;throw Error('Synthetic custody failure');}set(key,value);});
 t.mock.method(Object.getPrototypeOf(localStorage),'getItem',(key:string)=>{if(unreadable&&key.startsWith('loom.search-maintenance.v1:'))throw Error('Synthetic read failure');return get(key);});
 await f.finish(error('search_changed',409));const feedback=within(screen.getByRole('region',{name:'Job retry'}));assert.ok(feedback.getByText('Outcome not confirmed'));assert.equal(feedback.queryByText('Request not sent'),null);assert.equal(feedback.queryByText(/acknowledged/),null);assert.equal(f.writes.length,2);
});
test('new post-acknowledgement observations supersede overlapping earlier refresh responses',async t=>{
 const f=await fixture(t);f.hold();await click('Refresh status');const older=[...f.held];await rebuild();await f.finish(Response.json({generation:2}));const newer=f.held.slice(older.length);
 await act(async()=>{for(const r of newer)r.finish(Response.json(r.path.endsWith('/health')?{...f.health,generation:2,scan_complete:false}:{items:[],next_after:null}));});
 await act(async()=>{for(const r of older)r.finish(Response.json(r.path.endsWith('/health')?f.health:{items:[job()],next_after:null}));});assert.ok(screen.getByText('Indexing in progress'));assert.equal(screen.queryByText('No queued work observed'),null);assert.equal(screen.queryByText('Processing could not finish'),null);
});
for(const kind of ['rebuild','retry'] as const)test('cross-tab '+kind+' settlement retires only superseded command feedback',async t=>{
 const f=await fixture(t),failed=job();
 if(kind==='retry'){f.pages.set('',{items:[failed],next_after:null});await click('Refresh status');await click('Retry job');}else await rebuild();
 await f.finish(error());assert.ok(screen.getByText('Outcome not confirmed'));
 const other=new SearchMaintenanceRecovery(f.context.community.instance_id,f.self.participant_id),original=other.read()!;
 const changed=()=>act(async()=>{window.dispatchEvent(new dom.window.StorageEvent('storage',{key:other.key}));});
 f.fail();await click('Refresh status');await changed();
 assert.equal(screen.getAllByText('Synthetic service_unavailable',{exact:true}).length,2,'An unchanged uncertain record must retain its command error as well as the health error');
 const reads=[...f.reads];let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 const replay=other.attempt(original.request,original.sequence,()=>true,async()=>{await held;});
 try{await changed();assert.ok(screen.getByText('Outcome not confirmed'));assert.equal(screen.getAllByText('Synthetic service_unavailable',{exact:true}).length,1,'A newer unresolved attempt retires only the older command error, without implying acknowledgement');}finally{release();}
 const resolved=await replay;
 assert.deepEqual(resolved.record.request,original.request);assert.equal(resolved.record.sequence,original.sequence+1);await changed();
 assert.ok(screen.getByText(kind==='rebuild'?'Rebuild request acknowledged':'Retry request acknowledged'));
 assert.equal(screen.getAllByText('Synthetic service_unavailable',{exact:true}).length,1,'Only the independent health error remains');
 assert.ok(screen.getByText(/Could not load the requested failed-job page/));assert.deepEqual(f.reads,reads);assert.equal(f.writes.length,1);
});
test('a full failed-job page keeps pending, uncertain and acknowledged retry feedback contextual after the row disappears',async t=>{
 const f=await fixture(t),jobs=Array.from({length:25},()=>job()),target=jobs[0]!;
 f.pages.set('',{items:jobs,next_after:null});await click('Refresh status');
 const section=within(screen.getByRole('region',{name:'Failed jobs'})),maintenance=within(screen.getByRole('region',{name:'Maintenance'}));
 await act(async()=>fireEvent.click(within(section.getAllByRole('article')[0]!).getByRole('button',{name:'Retry job'})));
 assert.ok(section.getByText('Sending retry request…'));assert.equal(maintenance.queryByText(/Sending/),null);
 assert.equal(section.getAllByRole('article').length,25);assert.deepEqual(f.writes[0]!.body,{id:target.id,claim_generation:3});
 await f.finish(error());const feedback=within(section.getByRole('region',{name:'Job retry'}));
 assert.ok(feedback.getByText('Outcome not confirmed'));assert.ok(feedback.getByText(/Failed job 1/));assert.ok(feedback.getByRole('button',{name:'Retry same request'}));assert.equal(maintenance.queryByText('Outcome not confirmed'),null);
 await click('Refresh status');assert.ok(feedback.getByText('Synthetic service_unavailable'));assert.equal(f.writes.length,1);
 await click('Retry same request');assert.deepEqual(f.writes[1]!.body,f.writes[0]!.body);await f.finish(Response.json({accepted:true}));
 assert.ok(feedback.getByText('Retry request acknowledged'));assert.equal(feedback.queryByRole('alert'),null);
 f.pages.set('',{items:jobs.slice(1),next_after:null});await click('Refresh status');
 assert.equal(section.getAllByRole('article').length,24);assert.ok(feedback.getByText('Retry request acknowledged'));assert.ok(feedback.getByText('This job is not in the displayed failure page.'));assert.ok(feedback.getByText(target.id));assert.equal(feedback.queryByText(/Failed job 1/),null);assert.equal(f.writes.length,2);
});
test('a rejected job retry stays in Failed jobs and cannot be attributed to a later rebuild',async t=>{
 const f=await fixture(t),failed=job();f.pages.set('',{items:[failed],next_after:null});await click('Refresh status');await click('Retry job');await f.finish(error('search_changed',409));
 const failures=within(screen.getByRole('region',{name:'Failed jobs'})),maintenance=within(screen.getByRole('region',{name:'Maintenance'}));
 assert.ok(failures.getByText('Request rejected'));assert.ok(failures.getByText(/generation changed/));assert.equal(maintenance.queryByText('Request rejected'),null);
 await rebuild();assert.equal(failures.queryByRole('region',{name:'Job retry'}),null);await f.finish(Response.json({generation:2}));
 assert.ok(maintenance.getByText('Rebuild request acknowledged'));assert.equal(screen.queryByText(/generation changed/),null);
});
test('withdrawal removes protected retry context while cross-tab settlement cannot restore authority',async t=>{
 const f=await fixture(t),failed=job();f.pages.set('',{items:[failed],next_after:null});await click('Refresh status');await click('Retry job');await f.finish(error());
 const feedback=within(screen.getByRole('region',{name:'Job retry'}));assert.ok(feedback.getByText(/Failed job 1/));
 const refused=commandRequest('/api/v1/admin/search/rebuild',{self:f.self as any,body:{expected_generation:1}}),rejected=assert.rejects(refused,{code:'forbidden'});
 await act(async()=>{f.writes.at(-1)!.finish(error('forbidden',403));await rejected;});
 assert.equal(screen.queryByRole('article'),null);assert.equal(feedback.queryByText(/Failed job 1/),null);assert.equal((feedback.getByRole('button',{name:'Retry same request'}) as HTMLButtonElement).disabled,true);
 const other=new SearchMaintenanceRecovery(f.context.community.instance_id,f.self.participant_id),original=other.read()!;await other.attempt(original.request,original.sequence,()=>true,async()=>{});
 const reads=[...f.reads];await act(async()=>window.dispatchEvent(new dom.window.StorageEvent('storage',{key:other.key})));
 assert.ok(feedback.getByText('Retry request acknowledged'));assert.equal(screen.queryByRole('article'),null);assert.equal(feedback.queryByText(/Failed job 1/),null);assert.equal(screen.queryByText('No queued work observed'),null);assert.deepEqual(f.reads,reads);assert.equal(f.writes.length,2);
});
test('retry feedback remains beside a later job and holds its position after removal, restarting with explicit pagination',async t=>{
 const f=await fixture(t),jobs=Array.from({length:25},()=>job()),target=jobs[20]!,cursor=jobs[24]!.id,next=job();
 f.pages.set('',{items:jobs,next_after:cursor});f.pages.set(cursor,{items:[next],next_after:null});await click('Refresh status');
 const section=within(screen.getByRole('region',{name:'Failed jobs'}));let rows=section.getAllByRole('article');
 await act(async()=>fireEvent.click(within(rows[20]!).getByRole('button',{name:'Retry job'})));
 let feedback=section.getByRole('region',{name:'Job retry'});assert.ok(rows[19]!.nextElementSibling===feedback,'Feedback must follow the preceding job');assert.ok(feedback.nextElementSibling===rows[20],'Feedback must precede the affected position');
 await f.finish(error());f.pages.set('',{items:jobs.filter(j=>j.id!==target.id),next_after:cursor});await click('Refresh status');
 rows=section.getAllByRole('article');feedback=section.getByRole('region',{name:'Job retry'});assert.ok(rows[19]!.nextElementSibling===feedback,'Feedback must follow the preceding job');assert.ok(feedback.nextElementSibling===rows[20],'Feedback must precede the affected position');assert.ok(within(feedback).getByText('This job is not in the displayed failure page.'));
 await click('Next page');feedback=section.getByRole('region',{name:'Job retry'});assert.ok(feedback.nextElementSibling===section.getByRole('article'),'A different page starts with retained feedback');assert.ok(within(feedback).getByText(target.id));assert.equal(f.writes.length,1);
});
