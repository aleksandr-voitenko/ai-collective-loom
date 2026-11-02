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
import {SearchHealth} from '../../src/contracts/search.js';
import {IntentStore,invalidateIdentity,sessionRequest,commandRequest} from '../../src/web/participation-client.js';
import type {Context} from '../../src/web/participation-state.js';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/loom/admin'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent'] as const)
 Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
const {render,screen,fireEvent,cleanup,act}=await import('@testing-library/react');
afterEach(()=>{cleanup();invalidateIdentity();localStorage.clear();});
const overview='10000000-0000-4000-8000-000000000001';
const proposal='10000000-0000-4000-8000-000000000002';
const changed='10000000-0000-4000-8000-000000000003';
const click=async(name:string)=>act(async()=>fireEvent.click(screen.getByRole('button',{name})));
const edit=async(label:string,value:string)=>act(async()=>fireEvent.change(screen.getByLabelText(label),{target:{value}}));
const input=(label:string)=>(screen.queryByLabelText(label) as HTMLInputElement|null)?.value;
const failure=(code:string,status:number)=>Response.json({error:{code,message:'Synthetic '+code}},{status});
async function fixture(t:TestContext){
 const self={participant_id:randomUUID(),credential_id:randomUUID(),nickname:'Synthetic admin',kind:'human',role:'administrator',csrf:'fixture'};
 t.mock.method(globalThis,'fetch',async()=>Response.json(self));await sessionRequest('/api/v1/identity/self');
 const community=Value.Create({...Onboarding,properties:{...Onboarding.properties,instance_id:{...Onboarding.properties.instance_id,default:randomUUID()}}});
 community.settings_version=1;community.community_name='Synthetic community';
 community.overview={state:'ready',resource_id:overview};community.proposal_area={state:'ready',resource_id:proposal};
 let shellRefreshes=0,holdReads=false;
 const calls:{path:string;body:any;finish:(response:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string,options?:RequestInit)=>{
  if(path==='/api/v1/community'&&!holdReads)return Promise.resolve(Response.json(community));
  if(path==='/api/v1/identity/accounts/query')return Promise.resolve(Response.json({contract:'administration-pages-1',scope:{collection:'accounts',participant_id:null,order:'id',consistency:'restart-on-change'},items:[],next_cursor:null,complete:true,expires_at:'2090-01-01Z'}));
  if(path.endsWith('/admin/search/health'))return Promise.resolve(Response.json(Value.Create(SearchHealth)));
  if(path.endsWith('/admin/search/failures'))return Promise.resolve(Response.json({items:[],next_after:null}));
  return new Promise<Response>(finish=>calls.push({path,body:options?.body?JSON.parse(String(options.body)):undefined,finish}));
 });
 const context={self,community,store:new IntentStore(community.instance_id,self.participant_id),refreshCommunity:()=>{shellRefreshes++;}} as Context;
 const router=createMemoryRouter([{path:'/loom/*',element:<ActiveView context={context}/>}],{initialEntries:['/loom/admin']});t.after(()=>router.dispose());
 await act(async()=>{render(<StrictMode><RouterProvider router={router}/></StrictMode>);});
 screen.getByText('Community configuration').closest('details')!.open=true;
 return {self,community,calls,router,holdReads:()=>{holdReads=true;},shellRefreshes:()=>shellRefreshes,
  finish:async(response:Response)=>act(async()=>calls.at(-1)!.finish(response))};
}

test('dirty configuration survives pending and successful refresh with its original expected version and no write',async t=>{
 const f=await fixture(t);await edit('Overview artifact ID',changed);f.holdReads();
 await click('Refresh configuration');
 assert.equal(input('Overview artifact ID'),changed,'The draft must remain mounted during the read.');
 assert.equal(f.calls.at(-1)!.body,undefined);
 f.community.settings_version=2;f.community.community_name='Updated elsewhere';f.community.proposal_area.resource_id=changed;
 await f.finish(Response.json(f.community));
 assert.equal(input('Overview artifact ID'),changed);assert.equal(input('Proposal area ID'),proposal);
 assert.equal(f.calls.filter(c=>c.path.endsWith('/settings')).length,0);
 assert.ok(screen.queryByText(/Unsaved changes/));
 await click('Save configuration');
 const {idempotency_key,...body}=f.calls.at(-1)!.body;assert.equal(typeof idempotency_key,'string');
 assert.deepEqual(body,{expected_version:1,community_name:'Synthetic community',overview_id:changed,proposal_area_id:proposal});
 await f.finish(failure('revision_conflict',409));
 assert.equal(input('Overview artifact ID'),changed);assert.equal(input('Proposal area ID'),proposal);
 assert.ok(screen.queryByText(/Unsaved changes/));assert.equal(f.shellRefreshes(),0);
});

test('failed read refresh preserves draft, dirty state and save version',async t=>{
 const f=await fixture(t);await edit('Proposal area ID',changed);f.holdReads();
 await click('Refresh configuration');await f.finish(failure('service_unavailable',503));
 assert.equal(input('Overview artifact ID'),overview);assert.equal(input('Proposal area ID'),changed);
 assert.ok(screen.queryByText(/Unsaved changes/));assert.ok(screen.queryByText('Synthetic service_unavailable'));
 assert.equal(f.calls.filter(c=>c.path.endsWith('/settings')).length,0);
 await click('Save configuration');assert.equal(f.calls.at(-1)!.body.expected_version,1);
 await f.finish(failure('invalid_input',400));assert.equal(input('Proposal area ID'),changed);
});

test('successful discard/reload clears a superseded refresh error without claiming a save',async t=>{
 const f=await fixture(t);await edit('Overview artifact ID',changed);f.holdReads();
 await click('Refresh configuration');await f.finish(failure('service_unavailable',503));
 assert.ok(screen.queryByText('Synthetic service_unavailable'));
 t.mock.method(window,'confirm',()=>true);
 await click('Discard changes and reload saved settings');await f.finish(Response.json(f.community));
 assert.equal(input('Overview artifact ID'),overview);
 assert.equal(!!screen.queryByText('Synthetic service_unavailable'),false);
 assert.ok(screen.queryByText(/Saved configuration loaded/));assert.equal(!!screen.queryByText(/Configuration saved/),false);
 await click('Refresh configuration');await f.finish(failure('service_unavailable',503));
 assert.ok(screen.queryByText('Synthetic service_unavailable'),'A new failure must still be visible.');
});

test('discard requires confirmation and replaces the draft only after a successful saved-settings read',async t=>{
 const f=await fixture(t);await edit('Overview artifact ID',changed);f.holdReads();
 const confirm=t.mock.method(window,'confirm',()=>false);
 await click('Discard changes and reload saved settings');assert.equal(confirm.mock.callCount(),1);
 assert.equal(f.calls.length,0);assert.equal(input('Overview artifact ID'),changed);
 confirm.mock.mockImplementation(()=>true);
 await click('Discard changes and reload saved settings');assert.equal(input('Overview artifact ID'),changed);
 await f.finish(failure('service_unavailable',503));assert.equal(input('Overview artifact ID'),changed);
 assert.ok(screen.queryByText(/Unsaved changes/));
 f.community.settings_version=3;f.community.community_name='Saved elsewhere';f.community.proposal_area.resource_id=changed;
 await click('Discard changes and reload saved settings');await f.finish(Response.json(f.community));
 assert.equal(input('Overview artifact ID'),overview);assert.equal(input('Proposal area ID'),changed);
 assert.equal(!!screen.queryByText(/Unsaved changes/),false);assert.ok(screen.queryByText(/Editing settings version 3/));
 assert.equal(f.calls.filter(c=>c.path.endsWith('/settings')).length,0);
 await click('Save configuration');assert.equal(f.calls.at(-1)!.body.expected_version,3);
 assert.equal(f.calls.at(-1)!.body.community_name,'Saved elsewhere');
 await f.finish(failure('invalid_input',400));
});

for(const response of ['rejection','conflict','failure','malformed','wrong-version'] as const)
test(`save ${response} retains the draft without reporting success or changing its version`,async t=>{
 const f=await fixture(t);await edit('Overview artifact ID',changed);await click('Save configuration');
 assert.equal((screen.getByLabelText('Overview artifact ID') as HTMLInputElement).disabled,true);
 await click('Save configuration');assert.equal(f.calls.length,1,'A pending save must not dispatch again.');
 await f.finish(response==='rejection'?failure('invalid_input',400):response==='conflict'?failure('revision_conflict',409):
  response==='failure'?failure('service_unavailable',503):response==='malformed'?Response.json({operation_state:'committed'}):
  Response.json({operation_state:'committed',operation_id:randomUUID(),version:4}));
 assert.equal(input('Overview artifact ID'),changed);assert.equal(input('Proposal area ID'),proposal);
 assert.ok(screen.queryByText(/Unsaved changes/));assert.ok(screen.queryByText(/Editing settings version 1/));
 assert.equal(!!screen.queryByText(/Configuration saved/),false);assert.equal(f.shellRefreshes(),0);
 await click('Save configuration');assert.equal(f.calls.at(-1)!.body.expected_version,1);
 await f.finish(failure('invalid_input',400));
});

test('confirmed save clears dirty state, uses the returned version, and preserves values if its follow-up read fails',async t=>{
 const f=await fixture(t);await edit('Overview artifact ID',changed);await click('Save configuration');f.holdReads();
 await f.finish(Response.json({operation_state:'committed',operation_id:randomUUID(),version:2}));
 assert.equal(f.shellRefreshes(),1);assert.ok(screen.queryByText(/Configuration saved at version 2/));
 assert.equal(!!screen.queryByText(/Unsaved changes/),false);assert.equal(input('Overview artifact ID'),changed);
 await f.finish(failure('service_unavailable',503));assert.equal(input('Overview artifact ID'),changed);
 await edit('Proposal area ID',changed);await click('Save configuration');assert.equal(f.calls.at(-1)!.body.expected_version,2);
 await f.finish(failure('invalid_input',400));
});

for(const pending of ['refresh','discard','save'] as const)
test(`authority withdrawal fences pending ${pending}, keeps the private draft and prevents reads or writes until explicit reauthorization`,async t=>{
 const f=await fixture(t);await edit('Overview artifact ID',changed);f.holdReads();
 const oldSave=screen.getByRole('button',{name:'Save configuration'});
 t.mock.method(window,'confirm',()=>true);
 await click(pending==='refresh'?'Refresh configuration':pending==='discard'?'Discard changes and reload saved settings':'Save configuration');
 const held=f.calls.at(-1)!;
 const refusal=commandRequest('/api/v1/identity/reconcile',{self:f.self,body:{operation_kind:'account.create',idempotency_key:randomUUID()}});
 const denied=assert.rejects(refusal,{code:'forbidden'});
 await act(async()=>{f.calls.at(-1)!.finish(failure('forbidden',403));await denied;});
 const count=f.calls.length;
 f.community.settings_version=2;
 await act(async()=>held.finish(pending==='save'?Response.json({operation_state:'committed',operation_id:randomUUID(),version:2}):Response.json(f.community)));
 assert.equal(input('Overview artifact ID'),changed);assert.ok(screen.queryByText(/Unsaved changes/));
 assert.equal(!!screen.queryByRole('button',{name:'Save configuration'}),false);
 await act(async()=>fireEvent.click(oldSave));assert.equal(f.calls.length,count);assert.equal(f.shellRefreshes(),0);
 assert.equal(!!screen.queryByText(/Configuration saved/),false);
 await click('Refresh configuration');assert.equal(f.calls.length,count+1);
 await f.finish(Response.json(f.community));assert.equal(input('Overview artifact ID'),changed);
 await click('Save configuration');assert.equal(f.calls.at(-1)!.body.expected_version,1);
 await f.finish(failure('revision_conflict',409));
});

for(const departure of ['identity','route'] as const)
test(`pending save cannot revive a configuration draft or refresh after ${departure} departure`,async t=>{
 const f=await fixture(t);await edit('Overview artifact ID',changed);await click('Save configuration');
 const held=f.calls.at(-1)!;
 await act(async()=>{if(departure==='identity')invalidateIdentity();else await f.router.navigate('/loom/help');});
 const count=f.calls.length;
 await act(async()=>held.finish(Response.json({operation_state:'committed',operation_id:randomUUID(),version:2})));
 assert.equal(input('Overview artifact ID'),undefined);assert.equal(f.calls.length,count);assert.equal(f.shellRefreshes(),0);
});
