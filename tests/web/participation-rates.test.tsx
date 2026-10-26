import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach,test,type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ParticipationRates } from '../../src/web/ParticipationRates.js';
import { AuthorizationBoundary } from '../../src/web/AuthorizationBoundary.js';
import { IntentStore,identityGeneration } from '../../src/web/participation-client.js';
import type { Context } from '../../src/web/participation-state.js';
const locks=navigator.locks,dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,writable:true,configurable:true});
const {render,screen,fireEvent,cleanup,act,waitFor}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});
const path='/api/v1/admin/participation-rates';
const initial={version:1,window_seconds:60,ordinary_requests:120,new_publications:20,recovery_control:60};
const error=(code:string,status=429)=>Response.json({error:{code,message:code}},{status});
async function fixture(t:TestContext){
  const store=new IntentStore(randomUUID(),randomUUID(),localStorage,location.origin,locks);
  const context={store,self:{participant_id:store.participant,credential_id:randomUUID(),nickname:'Admin',kind:'human',role:'administrator'}} as Context;
  let policy={...initial},mode='success';const calls:{path:string;body:any}[]=[];
  let held:((r:Response)=>void)|undefined;
  const receipt=(version=2)=>({operation_state:'committed',idempotency:'replayed',operation_id:randomUUID(),original:{...policy,version},current:{...policy,version}});
  t.mock.method(globalThis,'fetch',async (url:string,options?:RequestInit)=>{
    const body=options?.body?JSON.parse(String(options.body)):undefined;calls.push({path:url,body});
    if(url===path)return Response.json(policy);
    if(url===path+'/audit')return Response.json({items:[{operation_id:randomUUID(),actor_id:store.participant,actor_credential_id:context.self.credential_id,recorded_at:'2026-10-26T00:00:00.000Z',policy}],next_before_version:body.before_version?null:2});
    if(mode==='hold')return new Promise<Response>(r=>{held=r;});
    if(mode==='throttle')return error('temporarily_throttled');
    if(mode==='forbidden')return error('forbidden',403);
    if(mode==='conflict')return error('rate_policy_conflict',409);
    if(mode==='missing')return Response.json({operation_state:'not_recorded'});
    policy={...policy,...(body.ordinary_requests?{ordinary_requests:body.ordinary_requests}:{}),version:2};return Response.json(receipt());
  });
  let router:ReturnType<typeof createMemoryRouter>,view:ReturnType<typeof render>;
  const mount=()=>{router=createMemoryRouter([{path:'/loom/admin',element:<AuthorizationBoundary scope="administration" sourcePolicy="settings"><ParticipationRates context={context}/></AuthorizationBoundary>},{path:'/away',element:<p>Another view</p>}],{initialEntries:['/loom/admin']});view=render(<StrictMode><RouterProvider router={router}/></StrictMode>);};
  const unmount=()=>{view.unmount();router.dispose();};t.after(unmount);mount();
  const click=async(name:string)=>{await act(async()=>fireEvent.click(screen.getByRole('button',{name})));};
  const open=async()=>{await click('Inspect participation limits');await screen.findByText(/Current policy version 1/);};
  const input=async(value:string)=>{await act(async()=>fireEvent.change(screen.getByLabelText(/Ordinary requests per minute/),{target:{value}}));await waitFor(()=>assert.equal(store.all()[0]?.body.ordinary_requests,Number(value)));};
  return {store,calls,click,open,input,context,receipt,setMode:(m:string)=>{mode=m;},setPolicy:(p:typeof initial)=>{policy=p;},
    remount:()=>{unmount();mount();},depart:async()=>act(async()=>{await router.navigate('/away');}),finish:async(r:Response)=>act(async()=>held!(r))};
}
test('administrator drafts, temporary refusal, remount, status miss, exact retry and audit are deliberate',async t=>{
  const f=await fixture(t);assert.equal(f.calls.length,0);await f.open();await f.input('7');
  const draft=f.store.all()[0]!;f.setMode('throttle');const owner=identityGeneration();await f.click('Save participation limits');
  await screen.findByText('temporarily_throttled');assert.equal(identityGeneration(),owner);assert.equal(f.store.all()[0]!.state,'uncertain');
  assert.deepEqual(f.store.all()[0]!.body,draft.body);assert.equal(f.calls.filter(c=>c.path===path+'/state').length,1);
  f.remount();await screen.findByText(/State: uncertain/);assert.equal((screen.getByLabelText(/Ordinary requests per minute/) as HTMLInputElement).value,'7');
  f.setMode('missing');await f.click('Check limits status');await screen.findByText(/still unconfirmed/);assert.equal(f.store.all()[0]!.state,'uncertain');
  f.setMode('success');await f.click('Retry same limits');await screen.findByText(/Recorded policy version 2/);assert.deepEqual(f.store.all(),[]);
  const commands=f.calls.filter(c=>c.path===path+'/state');assert.deepEqual(commands[1]!.body,commands[0]!.body);
  await f.click('Inspect rate policy audit');await screen.findByRole('button',{name:'Earlier rate decisions'});await f.click('Earlier rate decisions');
  await waitFor(()=>assert.equal(!!screen.queryByRole('button',{name:'Earlier rate decisions'}),false));
});
test('first policy conflict preserves the draft and explicit correction uses freshly inspected version',async t=>{
  const f=await fixture(t);await f.open();await f.input('8');const original=f.store.all()[0]!;f.setMode('conflict');
  await f.click('Save participation limits');await screen.findByRole('button',{name:'Prepare corrected limits'});
  assert.equal(f.store.all()[0]!.state,'rejected');f.setPolicy({...initial,version:3});await f.click('Refresh participation limits');await screen.findByText(/Current policy version 3/);
  await f.click('Prepare corrected limits');await waitFor(()=>assert.equal(f.store.all()[0]!.state,'draft'));
  assert.notEqual(f.store.all()[0]!.key,original.key);assert.equal(f.store.all()[0]!.body.expected_version,3);assert.equal(f.store.all()[0]!.body.ordinary_requests,8);
  await f.input('0');await f.click('Save participation limits');await screen.findByText(/whole-number limits/);assert.equal(f.calls.filter(c=>c.path===path+'/state').length,1);
});
test('journal persistence refusal blocks dispatch; late policy receipts after navigation leave uncertainty intact',async t=>{
  const f=await fixture(t);await f.open();
  const failed=t.mock.method(Object.getPrototypeOf(f.store.storage),'setItem',()=>{throw new Error('fixture storage refusal');});
  await f.click('Save participation limits');await screen.findByText(/Save the policy draft/);assert.equal(f.calls.filter(c=>c.path===path+'/state').length,0);failed.mock.restore();
  await f.input('9');f.setMode('hold');await f.click('Save participation limits');await waitFor(()=>assert.equal(f.store.all()[0]?.state,'uncertain'));
  const raw=JSON.stringify(f.store.all());await f.depart();await f.finish(Response.json(f.receipt()));assert.equal(JSON.stringify(f.store.all()),raw);
});
test('administrator role refusal keeps exact uncertain policy recovery and does not sign out',async t=>{
  const f=await fixture(t);await f.open();await f.input('10');f.setMode('throttle');await f.click('Save participation limits');await screen.findByText('temporarily_throttled');
  const raw=JSON.stringify(f.store.all()[0]!.body),owner=identityGeneration();f.setMode('forbidden');await f.click('Retry same limits');await screen.findByText('forbidden');
  assert.equal(JSON.stringify(f.store.all()[0]!.body),raw);assert.equal(f.store.all()[0]!.state,'uncertain');assert.equal(identityGeneration(),owner);
  assert.equal(!!screen.queryByText(/Current policy version/),false);assert.ok(screen.getByRole('button',{name:'Check limits status'}));
});
