import assert from 'node:assert/strict';
import { afterEach,test,type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { NotificationsPage } from '../../src/web/Notifications.js';
import { invalidateIdentity } from '../../src/web/participation-client.js';
import type { Context } from '../../src/web/participation-state.js';
import type { NotificationPageView } from '../../src/contracts/notifications.js';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
const {render,screen,fireEvent,cleanup,act,waitFor}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});
function result(cursor='shown',reason:'all'|'mention'|'reply'='all'):NotificationPageView{return {contract_version:'personal-attention-1',items:[],traversal:{id:randomUUID(),scope:'personal_direct_attention',reason,selection:'complete',order:'availability_ascending',expires_at:'2026-10-17T00:00:00Z',boundaries:'fixed_personal_availability_interval'},page_cursor:cursor,next_cursor:'next',checkpoint:null,interval_complete:false,work_budget_reached:false,projection:{state:'incomplete',coverage:'currently_eligible_supported_sources'},recovery:'none',history:'retained',omitted_detail:'full_bodies',limit:12,max_response_bytes:131072};}
function mount(t:TestContext){
  const calls:{body:any;finish:(r:Response)=>void}[]=[];t.mock.method(globalThis,'fetch',(_path:string,options:any)=>new Promise<Response>(finish=>calls.push({body:JSON.parse(options.body),finish})));
  const context={community:{instance_id:randomUUID()},self:{participant_id:randomUUID(),csrf:'fixture'}} as Context;
  const router=createMemoryRouter([{path:'/loom/notifications',element:<NotificationsPage context={context}/>},{path:'/other',element:<h1>Other view</h1>}],{initialEntries:['/loom/notifications']});
  t.after(()=>router.dispose());render(<StrictMode><RouterProvider router={router}/></StrictMode>);return {calls,router};
}
test('StrictMode restores liveness, saves displayed page before advance, and preserves failed local-save position',async t=>{
  const {calls}=mount(t);await waitFor(()=>assert.equal(calls.length,2));
  await act(async()=>calls[1]!.finish(Response.json(result())));await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Continue this interval'})));
  await act(async()=>calls[0]!.finish(Response.json(result('discarded'))));
  const key=Object.keys(localStorage)[0]!,saved=localStorage.getItem(key);assert.equal(JSON.parse(saved!).request.cursor,'shown');
  const original=dom.window.Storage.prototype.setItem;let fail=true;t.mock.method(dom.window.Storage.prototype,'setItem',function(this:Storage,k:string,v:string){if(fail)throw new Error('Injected recovery failure');original.call(this,k,v);});
  const button=screen.getByRole('button',{name:'Continue this interval'});button.focus();await act(async()=>fireEvent.click(button));assert.equal(calls[2]!.body.cursor,'next');
  await act(async()=>calls[2]!.finish(Response.json({...result('second'),next_cursor:null,checkpoint:'finished',interval_complete:true})));
  await waitFor(()=>assert.match(screen.getByRole('alert').textContent!,/Injected recovery failure/));assert.equal(localStorage.getItem(key),saved);assert.equal(document.activeElement,button);
  fail=false;await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry notification page'})));assert.equal(calls[3]!.body.cursor,'second');
  await act(async()=>calls[3]!.finish(Response.json({...result('second'),next_cursor:null,checkpoint:'finished',interval_complete:true})));
  await waitFor(()=>assert.equal(JSON.parse(localStorage.getItem(key)!).request.cursor,'second'));assert.ok(screen.getByRole('button',{name:'Check for newer signals'}));
});
test('late filter, route and identity responses cannot save or replace another notification view',async t=>{
  const {calls,router}=mount(t);await waitFor(()=>assert.equal(calls.length,2));await act(async()=>fireEvent.change(screen.getByLabelText('Attention reasons'),{target:{value:'reply'}}));
  await waitFor(()=>assert.equal(calls.length,4));await act(async()=>calls[3]!.finish(Response.json(result('replies','reply'))));
  await act(async()=>{calls[0]!.finish(Response.json(result('old')));calls[1]!.finish(Response.json(result('old')));});assert.equal(localStorage.length,1);assert.ok(Object.keys(localStorage)[0]!.endsWith(':reply'));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Continue this interval'})));await act(async()=>router.navigate('/other'));await act(async()=>calls[4]!.finish(Response.json(result('late','reply'))));
  assert.ok(screen.getByRole('heading',{name:'Other view'}));assert.equal(JSON.parse(localStorage.getItem(Object.keys(localStorage)[0]!)!).request.cursor,'replies');
  await act(async()=>router.navigate('/loom/notifications'));await waitFor(()=>assert.equal(calls.length,7));await act(async()=>{invalidateIdentity();calls[6]!.finish(Response.json(result('other-account')));});assert.equal(localStorage.length,1);
});
test('unreadable local recovery requires explicit retained resynchronization',async t=>{
  const {calls}=mount(t);await waitFor(()=>assert.equal(calls.length,2));await act(async()=>calls[1]!.finish(Response.json(result())));
  await waitFor(()=>assert.equal(localStorage.length,1));localStorage.setItem(Object.keys(localStorage)[0]!,'not json');
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Continue this interval'})));await act(async()=>calls[2]!.finish(Response.json(result('second'))));
  await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Start a new retained view'})));await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Start a new retained view'})));
  assert.deepEqual(calls[3]!.body,{reason:'all',recovery:{action:'resynchronize'}});await act(async()=>calls[3]!.finish(Response.json(result('resynchronized'))));
  await waitFor(()=>assert.equal(JSON.parse(localStorage.getItem(Object.keys(localStorage)[0]!)!).request.cursor,'resynchronized'));
});

test('a parseable recovery record with contradictory token modes is rejected without advancing',async t=>{
  const {calls}=mount(t);await waitFor(()=>assert.equal(calls.length,2));await act(async()=>calls[1]!.finish(Response.json(result())));
  await waitFor(()=>assert.equal(localStorage.length,1));const key=Object.keys(localStorage)[0]!,record=JSON.parse(localStorage.getItem(key)!);
  record.request.checkpoint='contradictory';const invalid=JSON.stringify(record);localStorage.setItem(key,invalid);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Continue this interval'})));await act(async()=>calls[2]!.finish(Response.json(result('second'))));
  await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Start a new retained view'})));
  assert.equal(localStorage.getItem(key),invalid);
});

test('current authentication failure withdraws cached notification context without advancing recovery',async t=>{
  const {calls}=mount(t);await waitFor(()=>assert.equal(calls.length,2));await act(async()=>calls[1]!.finish(Response.json(result())));
  await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Continue this interval'})));
  const saved=localStorage.getItem(Object.keys(localStorage)[0]!);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Continue this interval'})));
  await act(async()=>calls[2]!.finish(Response.json({error:{code:'unauthenticated',message:'Current authentication required'}},{status:401})));
  await waitFor(()=>assert.match(screen.getByRole('alert').textContent!,/Current authentication required/));
  assert.equal(screen.queryByText('Retrieval coverage and recovery')===null,true,'unauthenticated retrieval must withdraw cached page context');
  assert.equal(localStorage.getItem(Object.keys(localStorage)[0]!),saved);
  assert.equal(document.activeElement===screen.getByRole('alert'),true,'withdrawing the focused page must move focus to its recovery notice');
});
