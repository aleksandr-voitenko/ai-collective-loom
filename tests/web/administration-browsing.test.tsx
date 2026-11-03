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
import {intentUrl} from '../../src/web/participation-state.js';
import type {Context} from '../../src/web/participation-state.js';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/loom/admin'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
const {render,screen,fireEvent,cleanup,act}=await import('@testing-library/react');
afterEach(()=>{cleanup();invalidateIdentity();localStorage.clear();});
const person=(nickname:string)=>({id:randomUUID(),nickname,kind:'agent',state:'active',role:'participant'});
const page=(collection:string,items:unknown[],cursor:string|null=null,target:string|null=null)=>({contract:'administration-pages-1',scope:{collection,participant_id:target,order:collection==='audit'?'recorded_at,id':'id',consistency:'restart-on-change'},items,next_cursor:cursor,complete:cursor===null,expires_at:'2090-01-01Z'});
async function fixture(t:TestContext,route='/loom/admin/participants'){
 const self={participant_id:randomUUID(),credential_id:randomUUID(),nickname:'Admin',kind:'human',role:'administrator',csrf:'fixture'};
 t.mock.method(globalThis,'fetch',async()=>Response.json(self));await sessionRequest('/api/v1/identity/self');
 const community=Value.Create({...Onboarding,properties:{...Onboarding.properties,instance_id:{...Onboarding.properties.instance_id,default:randomUUID()}}});community.settings_version=1;
 const store=new IntentStore(community.instance_id,self.participant_id),context={self,community,store,refreshCommunity:()=>{}} as Context;
 const calls:{path:string;body:any;done:boolean;finish:(response:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string,options?:RequestInit)=>{
  if(path==='/api/v1/community')return Promise.resolve(Response.json(community));
  if(path.includes('/admin/search/')||path.includes('/admin/file-text/'))return Promise.resolve(Response.json({}));
  return new Promise<Response>(finish=>{const call={path,body:options?.body?JSON.parse(String(options.body)):undefined,done:false,finish:(r:Response)=>{call.done=true;finish(r);}};calls.push(call);});
 });
 const router=createMemoryRouter([{path:'/loom/*',element:<ActiveView context={context}/>}],{initialEntries:[route]});t.after(()=>router.dispose());
 const element=<StrictMode><RouterProvider router={router}/></StrictMode>;
 let view=render(element);
 for(const d of document.querySelectorAll('details'))if(d.querySelector('summary')?.textContent==='Participant accounts')d.open=true;
 const initial=async(items:unknown[],cursor:string|null='account-next')=>act(async()=>{for(const c of calls.filter(c=>!c.done&&c.path.endsWith('/accounts/query')))c.finish(Response.json(page('accounts',items,cursor)));});
 return {calls,initial,router,store,self,remount:()=>{view.unmount();view=render(element);}};
}
test('actual administration host retains failed-page position and focus; retry sends the same continuation and replaces rows',async t=>{
 const f=await fixture(t),a=person('First account'),b=person('Beyond account');await f.initial([a]);
 const next=screen.getByRole('button',{name:'Next accounts page'});next.focus();await act(async()=>fireEvent.click(next));
 const failed=f.calls.at(-1)!;assert.equal(failed.body.cursor,'account-next');
 await act(async()=>failed.finish(Response.json({error:{code:'service_unavailable',message:'Read unavailable',recovery:{action:'retry_same_request'}}},{status:503})));
 assert.ok(screen.queryByText('First account · agent · active'));assert.equal(document.activeElement,next);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry accounts page'})));
 const retry=f.calls.at(-1)!;assert.deepEqual(retry.body,failed.body);
 await act(async()=>retry.finish(Response.json(page('accounts',[b]))));
 assert.equal(!!screen.queryByText('First account · agent · active'),false);assert.ok(screen.queryByText('Beyond account · agent · active'));assert.ok(screen.queryByText('End of accounts results for this traversal.'));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Previous accounts page'})));assert.equal(f.calls.at(-1)!.body.cursor,undefined);
});
test('account selection keys credential pages; late previous-account data and obsolete lookup results are discarded',async t=>{
 const f=await fixture(t),a=person('Account A'),b=person('Account B');await f.initial([a,b]);
 const buttons=screen.getAllByRole('button',{name:'Manage credentials'});
 await act(async()=>fireEvent.click(buttons[0]!));const first=f.calls.filter(c=>c.path.endsWith('/credentials/query')).at(-1)!;assert.equal(first.body.participant_id,a.id);
 await act(async()=>fireEvent.click(buttons[1]!));const second=f.calls.filter(c=>c.path.endsWith('/credentials/query')).at(-1)!;assert.equal(second.body.participant_id,b.id);
 await act(async()=>second.finish(Response.json(page('credentials',[{id:randomUUID(),kind:'agent',state:'revoked',label:'B credential',created_at:'2020Z',expires_at:null,parent_credential_id:null}],null,b.id))));
 await act(async()=>first.finish(Response.json(page('credentials',[{id:randomUUID(),kind:'agent',state:'active',label:'A stale credential'}],null,a.id))));
 assert.ok(screen.queryByText(/B credential/));assert.equal(!!screen.queryByText(/A stale credential/),false);
 const input=screen.getByLabelText('Exact account ID or nickname');await act(async()=>fireEvent.change(input,{target:{value:'old_account'}}));await act(async()=>fireEvent.submit(input.closest('form')!));const lookup=f.calls.at(-1)!;
 await act(async()=>fireEvent.change(input,{target:{value:'new_account'}}));await act(async()=>lookup.finish(Response.json(person('Stale lookup'))));assert.equal(!!screen.queryByText(/Stale lookup/),false);
});
test('admission names the created participant and separates account creation from access',async t=>{
 const f=await fixture(t);await f.initial([]);
 await act(async()=>fireEvent.change(screen.getByLabelText('Nickname',{exact:true}),{target:{value:'review_agent'}}));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Create account'})));
 const request=f.calls.find(c=>c.path==='/api/v1/identity/accounts')!;assert.ok(request);
 await act(async()=>request.finish(Response.json({operation_state:'committed',participant_id:randomUUID()})));
 assert.ok(screen.queryByText('Account created for @review_agent.'));
 assert.ok(screen.queryByText('Access has not been issued yet. Issue an agent credential next.'));
 assert.ok(screen.queryByRole('button',{name:'Issue agent credential'}));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Issue agent credential'})));
 assert.equal(!!screen.queryByText(/Credential issuance is unconfirmed/),false);
 assert.equal(!!screen.queryByRole('button',{name:'Check credential issuance'}),false);
 assert.equal(!!screen.queryByText(/Access has not been issued yet/),false);
 const issuance=f.calls.find(c=>c.path==='/api/v1/identity/credentials')!;
 await act(async()=>issuance.finish(Response.json({error:{code:'service_unavailable',message:'Read unavailable'}},{status:503})));
 assert.ok(screen.queryByText(/Credential issuance is unconfirmed/));
 assert.ok(screen.queryByRole('button',{name:'Retry same credential issuance'}));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check credential issuance'})));
 const status=f.calls.find(c=>c.path==='/api/v1/identity/reconcile')!;
 assert.equal(status.body.idempotency_key,issuance.body.idempotency_key);
 await act(async()=>status.finish(Response.json({operation_state:'committed',participant_id:issuance.body.participant_id,credential_id:randomUUID()})));
 assert.ok(screen.queryByText('Credential issued — secret unavailable'));
 assert.equal(!!screen.queryByLabelText('Issued secret'),false);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Issue agent credential'})));
 assert.equal(!!screen.queryByText('Credential issued — secret unavailable'),false);
});
test('off-page admission selection survives lost issuance and remount through exact authorized metadata lookup',async t=>{
 const f=await fixture(t),target=person('off_page_agent');
 const firstPage=Array.from({length:25},(_,i)=>person('page_agent_'+i));await f.initial(firstPage);
 const input=screen.getByLabelText('Exact account ID or nickname');
 await act(async()=>fireEvent.change(input,{target:{value:target.nickname}}));
 await act(async()=>fireEvent.submit(input.closest('form')!));
 await act(async()=>f.calls.at(-1)!.finish(Response.json(target)));
 await act(async()=>fireEvent.click(screen.getByText(target.nickname+' · agent · active').closest('.list-row')!.querySelector('button')!));
 assert.ok(screen.queryByRole('heading',{name:'Managing @off_page_agent'}));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Issue agent credential'})));
 const issuance=f.calls.find(c=>c.path==='/api/v1/identity/credentials')!;
 await act(async()=>issuance.finish(Response.json({error:{code:'service_unavailable',message:'Lost response'}},{status:503})));
 const original=f.store.all()[0]!;assert.equal(original.body.participant_id,target.id);
 await act(async()=>f.remount());await f.initial(firstPage);
 const exact=f.calls.filter(c=>c.path==='/api/v1/identity/accounts/lookup'&&c.body.id===target.id).at(-1);
 assert.ok(exact,'Reload must resolve the retained account ID independently of the first page.');
 assert.ok(screen.queryByText('Loading participant details…'));
 await act(async()=>exact.finish(Response.json({error:{code:'service_unavailable',message:'Metadata lookup unavailable'}},{status:503})));
 assert.ok(screen.queryByText(/Participant details are unavailable/));assert.deepEqual(f.store.all()[0],original);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry participant lookup'})));
 const retry=f.calls.filter(c=>c.path==='/api/v1/identity/accounts/lookup').at(-1)!;assert.deepEqual(retry.body,{id:target.id});
 await act(async()=>retry.finish(Response.json(target)));
 assert.equal((screen.getByLabelText('Nickname',{exact:true}) as HTMLInputElement).value,target.nickname);
 assert.ok(screen.queryByRole('heading',{name:'Managing @off_page_agent'}));assert.deepEqual(f.store.all()[0],original);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check credential issuance'})));
 const status=f.calls.find(c=>c.path==='/api/v1/identity/reconcile')!;
 assert.deepEqual(status.body,{operation_kind:'credential.issue',idempotency_key:original.key});
 await act(async()=>status.finish(Response.json({operation_state:'committed',participant_id:target.id,credential_id:randomUUID()})));
 assert.ok(screen.queryByRole('heading',{name:'Managing @off_page_agent'}));assert.deepEqual(f.store.all(),[]);
 assert.equal(f.calls.filter(c=>c.path==='/api/v1/identity/credentials').length,1);
 assert.equal(f.calls.filter(c=>c.path==='/api/v1/identity/accounts').length,0);
 assert.ok(f.calls.filter(c=>c.path.endsWith('/accounts/query')).every(c=>c.body.limit===25&&!c.body.cursor));
});
for(const departure of ['role','identity','route','selection'] as const)test(`recovered account lookup cannot restore metadata after ${departure} departure`,async t=>{
 const f=await fixture(t),target=person('ProtectedRecovered'),other=person('OtherAccount');await f.initial([other]);
 const body={participant_id:target.id,kind:'agent',purpose:null,label:'Synthetic participation',replace_credential_id:null};
 await act(async()=>{await f.store.prepareDispatch(f.store.create('admission','credential.issue','/api/v1/identity/credentials',body),body);});
 const original=f.store.all()[0]!;await act(async()=>f.remount());
 const lookup=f.calls.filter(c=>c.path.endsWith('/accounts/lookup')&&c.body.id===target.id).at(-1)!;assert.ok(lookup);
 if(departure==='role'){
  const accounts=f.calls.filter(c=>c.path.endsWith('/accounts/query')).at(-1)!;
  await act(async()=>accounts.finish(Response.json({error:{code:'forbidden',message:'Administrator authority withdrawn'}},{status:403})));
 }
 if(departure==='identity')await act(async()=>invalidateIdentity());
 if(departure==='route')await act(async()=>f.router.navigate('/loom/help'));
 if(departure==='selection'){
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check credential issuance'})));
  await act(async()=>f.calls.find(c=>c.path.endsWith('/identity/reconcile'))!.finish(Response.json({operation_state:'committed',participant_id:target.id,credential_id:randomUUID()})));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Back to admission'})));
  await f.initial([other]);
  const disclosure=screen.getByText('Participant accounts').closest('details')!;disclosure.open=true;
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Manage credentials'})));
  assert.ok(screen.queryByRole('heading',{name:'Managing @OtherAccount'}));
 }
 await act(async()=>lookup.finish(Response.json(target)));
 assert.equal(!!screen.queryByDisplayValue('ProtectedRecovered'),false);
 assert.equal(!!screen.queryByRole('heading',{name:'Managing @ProtectedRecovered'}),false);
 if(departure!=='selection')assert.deepEqual(f.store.all()[0],original);
 else assert.ok(screen.queryByRole('heading',{name:'Managing @OtherAccount'}));
});
test('managing an existing participant names it without claiming creation and explains lost agent access',async t=>{
 const f=await fixture(t),a=person('review_agent');await f.initial([a]);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Manage credentials'})));
 assert.ok(screen.queryByRole('heading',{name:'Managing @review_agent'}));
 assert.equal(!!screen.queryByText(/Account created/),false);
 assert.ok(screen.queryByText(/Revoke the lost credential below, then issue a new agent credential for this same participant/));
 const input=screen.getByLabelText('Exact account ID or nickname');
 await act(async()=>fireEvent.change(input,{target:{value:'missing_agent'}}));
 await act(async()=>fireEvent.submit(input.closest('form')!));
 await act(async()=>f.calls.at(-1)!.finish(Response.json({error:{code:'unavailable',message:'Account not found'}},{status:404})));
 assert.ok(screen.queryByRole('heading',{name:'Managing @review_agent'}));
 assert.ok(input.closest('form')!.querySelector('[role="alert"]'));
});
for(const departure of ['role','identity','route'] as const)test(`pending account, lookup and credential pages cannot restore metadata after ${departure} departure`,async t=>{
 const f=await fixture(t),a=person('Protected account');await f.initial([a]);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Manage credentials'})));
 const held=f.calls.filter(c=>c.path.endsWith('/credentials/query')).at(-1)!;
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh accounts'})));const account=f.calls.at(-1)!;
 const input=screen.getByLabelText('Exact account ID or nickname');await act(async()=>fireEvent.change(input,{target:{value:'lookup_account'}}));await act(async()=>fireEvent.submit(input.closest('form')!));const lookup=f.calls.at(-1)!;
 if(departure==='role')await act(async()=>account.finish(Response.json({error:{code:'forbidden',message:'Administrator authority withdrawn'}},{status:403})));
 if(departure==='identity')await act(async()=>invalidateIdentity());
 if(departure==='route')await act(async()=>f.router.navigate('/loom/help'));
 await act(async()=>{held.finish(Response.json(page('credentials',[{id:randomUUID(),label:'Late protected credential',kind:'agent',state:'revoked'}])));lookup.finish(Response.json(person('Late lookup')));if(departure!=='role')account.finish(Response.json(page('accounts',[person('Late protected account')])));});
 assert.equal(!!screen.queryByText(/Late protected/),false);assert.equal(!!screen.queryByText(/Late lookup/),false);assert.equal(!!screen.queryByDisplayValue('Protected account'),false);
});

for(const departure of ['role','identity','route'] as const)test(`operational pages retain exact failed position and fence late health/outcomes after ${departure}`,async t=>{
 const f=await fixture(t,'/loom/admin');
 const open=async(label:string)=>act(async()=>{const d=screen.getByText(label,{exact:true}).closest('details')!;d.open=true;fireEvent(d,new Event('toggle'));});
 const health=f.calls.filter(c=>c.path==='/api/v1/admin/operational-health').at(-1)!;assert.ok(health);
 await open('Inspect request outcomes');
 const root=f.calls.filter(c=>c.path.endsWith('/operational-health/outcomes')).at(-1)!;
 const result=(code:string,cursor:string|null)=>({items:[{position:'30',request_id:randomUUID(),observed_at:'2026-10-27',family:'publication',code,status:409}],next_cursor:cursor,complete:!cursor,observed_at:'2026-10-27',window_start:'2026-10-26',oldest_retained_at:'2026-10-27',coverage:'incomplete_sample',consistency:'live_retained_window',process_dropped:0,process_collection_failed:false,max_records:1024,max_response_bytes:32768});
 await act(async()=>root.finish(Response.json(result('revision_conflict','30'))));
 const next=screen.getByRole('button',{name:'Next outcomes page'});next.focus();await act(async()=>fireEvent.click(next));const failed=f.calls.at(-1)!;
 await act(async()=>failed.finish(Response.json({error:{code:'service_unavailable',message:'Temporary observation failure'}},{status:503})));
 assert.ok(screen.queryByText('revision conflict'));assert.equal(document.activeElement,next);assert.ok(screen.queryByText(/Previous outcomes page is stale/));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry outcomes page'})));const retry=f.calls.at(-1)!;assert.deepEqual(retry.body,failed.body);
 if(departure==='role')await act(async()=>health.finish(Response.json({error:{code:'forbidden',message:'Current administrator authority required'}},{status:403})));
 if(departure==='identity')await act(async()=>invalidateIdentity());
 if(departure==='route')await act(async()=>f.router.navigate('/loom/help'));
 await act(async()=>retry.finish(Response.json(result('idempotency_conflict',null))));
 assert.equal(!!screen.queryByText('revision conflict'),false);assert.equal(!!screen.queryByText('idempotency conflict'),false);
});

for(const departure of ['role','identity','route'] as const)test(`dedicated identity audit fences late pages after ${departure}`,async t=>{
 const f=await fixture(t,'/loom/admin/audit');
 const pending=f.calls.filter(c=>c.path.endsWith('/audit/query')).at(-1)!;assert.ok(pending);
 if(departure==='role'){
  const refusal=commandRequest('/api/v1/identity/reconcile',{self:f.self,body:{operation_kind:'account.create',idempotency_key:randomUUID()}});
  const rejected=assert.rejects(refusal,{code:'forbidden'});
  await act(async()=>{f.calls.at(-1)!.finish(Response.json({error:{code:'forbidden',message:'Current administrator authority required'}},{status:403}));await rejected;});
 }
 if(departure==='identity')await act(async()=>invalidateIdentity());
 if(departure==='route')await act(async()=>f.router.navigate('/loom/help'));
 await act(async()=>pending.finish(Response.json(page('audit',[{id:randomUUID(),action:'Late protected audit',recorded_at:'2020Z',target_id:randomUUID(),operation_id:randomUUID(),actor_id:null,actor_credential_id:null,authority:'deployment_recovery'}]))));
 assert.equal(!!screen.queryByText('Late protected audit'),false);
});

for(const [kind,route] of [['account.create','participants'],['credential.issue','participants'],['community.settings','community'],['community.setup','community'],['participation.rates','limits'],['file.policy','limits']] as const)test(`legacy ${kind} recovery preserves its exact intent and all URL parameters`,async t=>{
 const f=await fixture(t,'/loom/admin/missing');
 const body=kind==='credential.issue'?{participant_id:randomUUID(),kind:'agent'}:{nickname:'retained',kind:'agent'};
 const record=await f.store.saveDraft(f.store.create(kind==='account.create'||kind==='credential.issue'?'admission':kind,kind,'/api/v1/identity/accounts',body),body);
 const expected='/loom/admin/'+route+'?intent='+record.key;
 assert.equal(intentUrl(record),expected);
 await act(async()=>f.router.navigate('/loom/admin?intent='+record.key+'&retained=original%2Fvalue&retained=two#handoff'));
 assert.equal(f.router.state.location.pathname,'/loom/admin/'+route);
 assert.equal(f.router.state.location.search,'?intent='+record.key+'&retained=original%2Fvalue&retained=two');
 assert.equal(f.router.state.location.hash,'#handoff');assert.deepEqual(f.store.all()[0],record);
 assert.equal(f.calls.some(c=>!c.path.endsWith('/query')&&!c.path.endsWith('/lookup')&&!c.path.startsWith('/api/v1/admin/')),false);
});

for(const missing of [false,true])test(`unknown ${missing?'missing':'retained'} legacy intent remains reviewable without a redirect`,async t=>{
 const f=await fixture(t,'/loom/admin/missing'),body={unknown:'private'};
 const record=f.store.create('unknown','unknown.operation','/api/v1/unknown',body);
 if(!missing)await f.store.saveDraft(record,body);
 await act(async()=>f.router.navigate('/loom/admin?intent='+record.key+'&keep=1'));
 assert.equal(f.router.state.location.pathname,'/loom/admin');assert.equal(f.router.state.location.search,'?intent='+record.key+'&keep=1');
 assert.ok(screen.queryByRole('heading',{name:'Recovery unavailable'}));assert.ok(screen.queryByRole('link',{name:'Inspect local drafts'}));assert.deepEqual(f.calls,[]);
});

test('one-time handoff blocks cancelled departure, permits confirmed departure and never persists its secret',async t=>{
 const f=await fixture(t),target=person('handoff_agent');await f.initial([target]);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Manage credentials'})));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Issue agent credential'})));
 const request=f.calls.find(c=>c.path.endsWith('/identity/credentials'))!;
 await act(async()=>request.finish(Response.json({operation_state:'committed',participant_id:target.id,credential_id:randomUUID(),secret:'one-time-fixture-secret'})));
 let confirmations=0;const confirm=t.mock.method(window,'confirm',()=>{confirmations++;return false;});
 await act(async()=>f.router.navigate('/loom/admin/search'));
 assert.equal(confirmations,1);assert.equal(f.router.state.location.pathname,'/loom/admin/participants');
 assert.equal((screen.getByLabelText('Issued secret') as HTMLTextAreaElement).value,'one-time-fixture-secret');
 assert.equal(JSON.stringify(Object.values(localStorage)).includes('one-time-fixture-secret'),false);
 confirm.mock.mockImplementation(()=>true);await act(async()=>f.router.navigate('/loom/admin/search'));
 assert.equal(f.router.state.location.pathname,'/loom/admin/search');assert.equal(!!screen.queryByLabelText('Issued secret'),false);
});

test('late credential issuance after route departure keeps the exact attempt for reconciliation',async t=>{
 const f=await fixture(t),target=person('interrupted_agent');await f.initial([target]);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Manage credentials'})));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Issue agent credential'})));
 const request=f.calls.find(c=>c.path.endsWith('/identity/credentials'))!,record=f.store.all()[0]!;
 await act(async()=>f.router.navigate('/loom/admin/audit'));
 await act(async()=>request.finish(Response.json({operation_state:'committed',participant_id:target.id,credential_id:randomUUID(),secret:'departed-secret'})));
 assert.deepEqual(f.store.all()[0],record);assert.equal(record.state,'uncertain');
 await act(async()=>f.router.navigate(intentUrl(record)));assert.ok(screen.queryByRole('button',{name:'Check credential issuance'}));assert.deepEqual(f.store.all()[0],record);
});

test('non-administrator direct entry never reads administrative sections and neighbouring participant routes remain reachable',async t=>{
 const f=await fixture(t,'/loom/admin/missing');f.self.role='participant';
 for(const child of ['','community','participants','limits','search','file-processing','audit']){
  await act(async()=>f.router.navigate('/loom/admin'+(child?'/'+child:'')));
  assert.ok(screen.queryByRole('alert'));assert.ok(screen.queryByText('Administrator access is required.'));assert.deepEqual(f.calls,[]);
 }
 await act(async()=>f.router.navigate('/loom/help'));assert.ok(screen.queryByRole('heading',{name:'Participation guide'}));
 assert.ok(f.calls.some(c=>c.path==='/api/v1/guide'));
});
