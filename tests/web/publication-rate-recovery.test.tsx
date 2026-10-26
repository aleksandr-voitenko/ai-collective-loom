import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {afterEach,test} from 'node:test';
import {JSDOM} from 'jsdom';
import {StrictMode} from 'react';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {Help} from '../../src/web/ParticipationHelp.js';
import {AuthorizationBoundary} from '../../src/web/AuthorizationBoundary.js';
import {IntentStore} from '../../src/web/participation-client.js';
import type {Context} from '../../src/web/participation-state.js';
const locks=navigator.locks,dom=new JSDOM('<html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,writable:true,configurable:true});
const {render,screen,fireEvent,cleanup,act}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});
for(const kind of ['artifact.create','revision.publish','summary.revise','attachment.promote'])test('Local drafts recovers '+kind+' without an ordinary source read, retaining throttle and missing-outcome uncertainty',async t=>{
 const store=new IntentStore(randomUUID(),randomUUID(),localStorage,location.origin,locks),context={store,self:{participant_id:store.participant,credential_id:randomUUID(),kind:'human',role:'participant',nickname:'Writer'}} as Context;
 let record=await store.saveDraft(store.create('slot',kind,'/api/v1/artifacts',{}),{content:{format:'loom-markdown-v1',text:'Exact draft',mentions:[]},area_id:randomUUID(),resource_id:randomUUID(),...(kind==='attachment.promote'?{source:{contribution_id:randomUUID(),revision_id:randomUUID(),file_id:randomUUID()},title:'Promoted'}:{})});record=await store.prepareDispatch(record,record.body);
 let mode='throttle';const calls:{url:string;body:any}[]=[];
 const result={publication_state:'committed',idempotency:'replayed',operation_id:randomUUID(),resource_id:randomUUID(),revision_id:randomUUID()};
 t.mock.method(globalThis,'fetch',async(url:string,options?:RequestInit)=>{
  calls.push({url,body:options?.body?JSON.parse(String(options.body)):undefined});
  if(url==='/api/v1/guide')return Response.json({text:'Guide'});
  return mode==='throttle'?Response.json({error:{code:'temporarily_throttled',message:'Wait without discarding intent'}},{status:429}):mode==='missing'?Response.json({operation_state:'not_recorded'}):Response.json(result);
 });
 const mount=()=>render(<StrictMode><RouterProvider router={createMemoryRouter([{path:'*',element:<AuthorizationBoundary scope="help"><Help context={context}/></AuthorizationBoundary>}])}/></StrictMode>);
 let view=mount();await screen.findByText('Local drafts');
 const click=()=>act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Check publication status'}));});
 await click();await screen.findByText('Wait without discarding intent');assert.deepEqual(store.all()[0],record);
 view.unmount();view=mount();mode='missing';await click();await screen.findByText(/earlier attempt may still commit/);assert.deepEqual(store.all()[0],record);
 mode='success';await click();await screen.findByText('Publication confirmed. Your exact local record is retained.');
 assert.deepEqual(store.all()[0]!.body,record.body);assert.equal(store.all()[0]!.key,record.key);assert.equal(store.all()[0]!.state,'committed');
 const statuses=calls.filter(c=>c.url!=='/api/v1/guide');assert.equal(statuses.length,3);
 for(const call of statuses){assert.equal(call.url,kind.startsWith('summary.')?'/api/v1/summaries/status':'/api/v1/operations/status');assert.deepEqual(call.body,{operation_kind:kind,idempotency_key:record.key});}
});
test('Local drafts ignores a held status after departure and retains uncertainty if confirmation cannot be saved',async t=>{
 const store=new IntentStore(randomUUID(),randomUUID(),localStorage,location.origin,locks),context={store,self:{participant_id:store.participant,credential_id:randomUUID(),kind:'human',role:'participant'}} as Context;
 let record=await store.saveDraft(store.create('slot','artifact.create','/api/v1/artifacts',{}),{area_id:randomUUID()});record=await store.prepareDispatch(record,record.body);
 let finish!: (r:Response)=>void;
 const result={publication_state:'committed',idempotency:'replayed',operation_id:randomUUID(),resource_id:randomUUID(),revision_id:randomUUID()};
 t.mock.method(globalThis,'fetch',async(url:string)=>url==='/api/v1/guide'?Response.json({text:'Guide'}):new Promise<Response>(r=>{finish=r;}));
 const mount=()=>render(<StrictMode><RouterProvider router={createMemoryRouter([{path:'*',element:<AuthorizationBoundary scope="help"><Help context={context}/></AuthorizationBoundary>}])}/></StrictMode>);
 const view=mount();await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Check publication status'}));});view.unmount();await act(async()=>finish(Response.json(result)));assert.deepEqual(store.all()[0],record);
 mount();await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Check publication status'}));});t.mock.method(dom.window.Storage.prototype,'setItem',()=>{throw new Error('Storage full');});await act(async()=>finish(Response.json(result)));await screen.findByText(/Storage full/);assert.deepEqual(store.all()[0],record);
});
