import assert from 'node:assert/strict';
import { afterEach,test,type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { SharedChangesPage } from '../../src/web/SharedChanges.js';
import { FollowControl,FollowingPage } from '../../src/web/Following.js';
import { SharedRecovery } from '../../src/web/shared-recovery.js';
import { IntentStore,invalidateIdentity } from '../../src/web/participation-client.js';
import type { Context } from '../../src/web/participation-state.js';
import type { FollowItemView,SharedPageView } from '../../src/contracts/following.js';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent','StorageEvent'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
const {render,screen,fireEvent,cleanup,act,waitFor}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});
const target={kind:'area' as const,resource_id:randomUUID()},definition={target,include_descendants:false,preferences:['artifact_revisions'] as const};
function result(cursor='shown',scope:'following'|'explicit'='following'):SharedPageView{return {contract_version:'shared-changes-1',items:[],traversal:{id:randomUUID(),scope,definitions:[{...definition,preferences:['artifact_revisions'],version:1}],settings_current:true,selection:'complete',grouping:'none',order:'committed_event_ascending',expires_at:'2026-10-17T00:00:00Z',boundaries:'fixed_shared_interval',history_start:'retained_history'},page_cursor:cursor,next_cursor:'next',checkpoint:null,page_exhausted:false,interval_complete:false,no_subscriptions:false,work_budget_reached:false,coverage:'known',coverage_limit:null,recovery:'none',history:'retained',baseline_established:false,inventory:[],omitted_detail:'full_bodies',limit:12,max_response_bytes:131072};}
function mount(t:TestContext,control:boolean|'following'=false){
  const calls:{path:string;body:any;finish:(r:Response)=>void}[]=[];t.mock.method(globalThis,'fetch',(path:string,options:any)=>new Promise<Response>(finish=>calls.push({path,body:options.body?JSON.parse(options.body):undefined,finish})));
  const instance=randomUUID(),participant=randomUUID(),store=new IntentStore(instance,participant);
  const context={community:{instance_id:instance},self:{participant_id:participant,csrf:'fixture'},store} as Context;
  const router=createMemoryRouter([{path:'/loom/changes',element:<SharedChangesPage context={context}/>},{path:'/control',element:<FollowControl context={context} target={target}/>},{path:'/loom/following',element:<FollowingPage context={context}/>},{path:'/other',element:<h1>Other view</h1>}],{initialEntries:[control==='following'?'/loom/following':control?'/control':'/loom/changes']});
  t.after(()=>router.dispose());render(<StrictMode><RouterProvider router={router}/></StrictMode>);return {calls,router,store,context};
}
const records=()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('loom.shared-pages:'))!)!);
const record=()=>Object.values(records())[0] as any;
test('development StrictMode retains displayed shared budgets before exposing a resized successor; failed saves preserve old recovery',async t=>{
  const {calls}=mount(t);await waitFor(()=>assert.equal(calls.length,2));
  await act(async()=>calls[1]!.finish(Response.json(result())));await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Continue shared interval'})));
  await act(async()=>calls[0]!.finish(Response.json(result('discarded'))));assert.equal(record().request.cursor,'shown');
  const saved=JSON.stringify(records()),original=dom.window.Storage.prototype.setItem;let fail=true;
  t.mock.method(dom.window.Storage.prototype,'setItem',function(this:Storage,k:string,v:string){if(fail)throw new Error('Injected recovery failure');original.call(this,k,v);});
  await act(async()=>fireEvent.change(screen.getByLabelText('Next page size'),{target:{value:'5'}}));
  const next=screen.getByRole('button',{name:'Continue shared interval'});next.focus();await act(async()=>fireEvent.click(next));assert.deepEqual(calls[2]!.body,{cursor:'next',limit:5});
  const second={...result('second'),limit:5,next_cursor:null,checkpoint:'finished',page_exhausted:true,interval_complete:true};
  await act(async()=>calls[2]!.finish(Response.json(second)));await waitFor(()=>assert.match(screen.getByRole('alert').textContent!,/could not be saved/));
  assert.equal(JSON.stringify(records()),saved);assert.equal(document.activeElement,next);
  fail=false;await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry shared page'})));assert.deepEqual(calls[3]!.body,{cursor:'second',limit:5,max_response_bytes:131072});
  await act(async()=>calls[3]!.finish(Response.json(second)));await waitFor(()=>assert.equal(record().request.cursor,'second'));assert.equal(record().previous_request.cursor,'shown');
});
test('late explicit-filter, route and identity responses cannot replace shared views or persist their recovery',async t=>{
  const {calls,router}=mount(t);await waitFor(()=>assert.equal(calls.length,2));
  await act(async()=>router.navigate('/loom/changes?kind=area&id='+target.resource_id));await waitFor(()=>assert.equal(calls.length,4));
  document.querySelector('details')!.open=true;
  await act(async()=>fireEvent.click(screen.getByLabelText('Include subtopics')));await waitFor(()=>assert.equal(calls.length,6));
  assert.equal(document.querySelector('details')!.open,true,'changing a scope preference keeps its control panel open');
  await act(async()=>calls[5]!.finish(Response.json(result('descendants','explicit'))));await waitFor(()=>assert.equal(localStorage.length,1));
  await act(async()=>{for(const call of calls.slice(0,5))call.finish(Response.json(result('old')));});assert.equal(Object.keys(records()).length,1);assert.equal(record().request.cursor,'descendants');
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Continue shared interval'})));await act(async()=>router.navigate('/other'));await act(async()=>calls[6]!.finish(Response.json(result('late','explicit'))));assert.equal(record().request.cursor,'descendants');
  await act(async()=>router.navigate('/loom/changes'));await waitFor(()=>assert.equal(calls.length,9));await act(async()=>{invalidateIdentity();calls[8]!.finish(Response.json(result('other-account')));});assert.equal(Object.keys(records()).length,1);
});
test('stale tabs and malformed records cannot overwrite recovery; explicit clearing owns only shared records',async t=>{
  const {calls,context}=mount(t);await waitFor(()=>assert.equal(calls.length,2));await act(async()=>calls[1]!.finish(Response.json(result())));await waitFor(()=>assert.equal(localStorage.length,1));
  const recovery=new SharedRecovery(context.community.instance_id,context.self.participant_id),key=Object.keys(records())[0]!;
  await recovery.save(key,result('other-tab'),1,()=>true);const other=JSON.stringify(records());
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Continue shared interval'})));await act(async()=>calls[2]!.finish(Response.json(result('stale'))));
  await waitFor(()=>assert.match(screen.getByRole('alert').textContent!,/Another tab/));assert.equal(JSON.stringify(records()),other);
  const prefix=Object.keys(localStorage)[0]!;localStorage.setItem(prefix,JSON.stringify({[key]:{...record(),request:{...record().request,checkpoint:'contradiction'}}}));
  assert.throws(()=>recovery.read(key),/incompatible/);localStorage.setItem('loom.notifications:independent','personal');
  await act(async()=>fireEvent.click(screen.getAllByRole('button',{name:'Clear saved shared change views'})[0]!));assert.equal(localStorage.getItem('loom.notifications:independent'),'personal');
  assert.deepEqual(calls[3]!.body,{scope:{kind:'following'}});
});
test('policy and epoch failures withdraw context and focus notice without advancing saved page',async t=>{
  const {calls}=mount(t);await waitFor(()=>assert.equal(calls.length,2));await act(async()=>calls[1]!.finish(Response.json(result())));
  await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Continue shared interval'})));const saved=JSON.stringify(records());
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Continue shared interval'})));
  await act(async()=>calls[2]!.finish(Response.json({error:{code:'shared_epoch_changed',message:'Continuity unavailable'}},{status:409})));
  await waitFor(()=>assert.match(screen.getByRole('alert').textContent!,/Continuity unavailable/));assert.equal(screen.queryByText('Coverage and recovery'),null);assert.equal(JSON.stringify(records()),saved);assert.equal(document.activeElement,screen.getByRole('alert'));
});
test('Follow StrictMode saves exact intent before dispatch and reconciles an earlier decision without undoing newer state',async t=>{
  const {calls,store}=mount(t,true),item:FollowItemView={...definition,preferences:['artifact_revisions'],version:0,following:false,source:{state:'available',title:'Scope',path:[],browser_url:'/loom/area/'+target.resource_id}};
  await waitFor(()=>assert.equal(calls.length,2));await act(async()=>calls[1]!.finish(Response.json(item)));await act(async()=>calls[0]!.finish(Response.json(item)));
  await waitFor(()=>assert.equal((screen.getByRole('button',{name:'Follow'}) as HTMLButtonElement).disabled,false));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Follow'})));
  await waitFor(()=>assert.ok(calls.find(c=>c.path.endsWith('/state'))));const sent=calls.find(c=>c.path.endsWith('/state'))!;
  assert.deepEqual(store.all()[0]!.body,sent.body);assert.equal(store.all()[0]!.state,'uncertain');
  await act(async()=>sent.finish(Response.json({error:{code:'service_unavailable',message:'Lost acknowledgement'}},{status:503})));
  await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Check follow status'})));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check follow status'})));
  const current={...item,version:2},outcome={...definition,preferences:['artifact_revisions'],following:true,expected_version:0,result_version:1};
  await act(async()=>calls.find(c=>c.path.endsWith('/status'))!.finish(Response.json({operation_state:'applied',operation_id:randomUUID(),idempotency:'replayed',outcome,current})));
  await waitFor(()=>assert.equal(store.all().length,0));await act(async()=>{for(const c of calls.filter(c=>c.path.endsWith('/lookup')))c.finish(Response.json(current));});
  await waitFor(()=>assert.match(screen.getByRole('status').textContent!,/newer Following state is preserved/));assert.equal(screen.getByRole('button',{name:'Follow'}).getAttribute('aria-pressed'),'false');
});

test('Unfollow remains available while unsaved preference edits are empty and uses retained settings',async t=>{
  const {calls}=mount(t,true),item:FollowItemView={...definition,preferences:['artifact_revisions'],version:1,following:true,source:{state:'available',title:'Scope',path:[],browser_url:'/loom/area/'+target.resource_id}};
  await waitFor(()=>assert.equal(calls.length,2));await act(async()=>calls[1]!.finish(Response.json(item)));
  await waitFor(()=>assert.equal((screen.getByRole('button',{name:'Unfollow'}) as HTMLButtonElement).disabled,false));
  await act(async()=>fireEvent.click(screen.getByLabelText('Artifact publications')));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Unfollow'})));
  await waitFor(()=>assert.ok(calls.find(c=>c.path.endsWith('/state'))));assert.deepEqual(calls.find(c=>c.path.endsWith('/state'))!.body.preferences,['artifact_revisions']);
});

test('a newer unavailable target lookup withdraws cached Following row metadata while preserving removal',async t=>{
  const {calls}=mount(t,'following'),item:FollowItemView={...definition,preferences:['artifact_revisions'],version:1,following:true,
    source:{state:'available',title:'Previously visible title',path:[{id:target.resource_id,title:'Previously visible path'}],browser_url:'/loom/area/'+target.resource_id}};
  await waitFor(()=>assert.equal(calls.length,2));
  await act(async()=>calls[1]!.finish(Response.json({items:[item],next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',limit:12,max_response_bytes:131072})));
  await waitFor(()=>assert.ok(screen.getByRole('heading',{name:'Previously visible title'})));
  await waitFor(()=>assert.equal(calls.filter(c=>c.path.endsWith('/lookup')).length,2));
  await act(async()=>{for(const call of calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json({...item,source:{state:'unavailable'}}));});
  assert.equal(screen.queryByText('Previously visible title')===null,true,'unavailable lookup removes the cached title');
  assert.equal(screen.queryByText('Previously visible path')===null,true,'unavailable lookup removes the cached path');
  assert.ok(screen.getByRole('heading',{name:'Followed target unavailable'}));assert.equal((screen.getByRole('button',{name:'Unfollow'}) as HTMLButtonElement).disabled,false);
});

test('explicit Following refresh adopts current editor settings and mutation version',async t=>{
  const {calls,store}=mount(t,'following'),item:FollowItemView={...definition,preferences:['artifact_revisions'],version:1,following:true,
    source:{state:'available',title:'Refreshed topic',path:[],browser_url:'/loom/area/'+target.resource_id}};
  const page=(row:FollowItemView)=>({items:[row],next_cursor:null,complete:true,collection_version:row.version,ordering:'stable_target_id',limit:12,max_response_bytes:131072});
  await waitFor(()=>assert.equal(calls.length,2));
  await act(async()=>calls[1]!.finish(Response.json(page(item))));
  await waitFor(()=>assert.equal(calls.filter(c=>c.path.endsWith('/lookup')).length,2));
  await act(async()=>{for(const call of calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(item));});
  await waitFor(()=>assert.equal((screen.getByRole('button',{name:'Unfollow'}) as HTMLButtonElement).disabled,false));
  document.querySelector('details')!.open=true;
  // A lookup begun before the explicit refresh must not restore its older state.
  await act(async()=>window.dispatchEvent(new CustomEvent('loom-following-change',{detail:store.prefix})));
  const oldLookup=calls.at(-1)!;
  const fresh:FollowItemView={...item,version:2,include_descendants:true,preferences:['replies']};
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh following'})));
  await act(async()=>calls.at(-1)!.finish(Response.json(page(fresh))));
  await waitFor(()=>assert.ok(screen.getByText('Including subtopics · Replies and reply edits')));
  await act(async()=>oldLookup.finish(Response.json(item)));
  assert.equal(document.querySelector('details')!.open,true);
  assert.equal((screen.getByLabelText('Include subtopics') as HTMLInputElement).checked,true);
  assert.equal((screen.getByLabelText('Replies and reply edits') as HTMLInputElement).checked,true);
  assert.equal((screen.getByLabelText('Artifact publications') as HTMLInputElement).checked,false);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Save follow settings'})));
  await waitFor(()=>assert.ok(calls.find(c=>c.path.endsWith('/state'))));
  const sent=calls.find(c=>c.path.endsWith('/state'))!;
  assert.deepEqual(sent.body,{target,following:true,include_descendants:true,preferences:['replies'],expected_version:2,idempotency_key:store.all()[0]!.key});
});

test('Following row policy withdrawal does not restore controls or clear the authentication error',async t=>{
  const {calls,store}=mount(t,'following'),item:FollowItemView={...definition,preferences:['artifact_revisions'],version:1,following:true,
    source:{state:'available',title:'Previously authorized topic',path:[],browser_url:'/loom/area/'+target.resource_id}};
  await waitFor(()=>assert.equal(calls.length,2));
  await act(async()=>calls[1]!.finish(Response.json({items:[item],next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',limit:12,max_response_bytes:131072})));
  await waitFor(()=>assert.equal(calls.filter(c=>c.path.endsWith('/lookup')).length,2));
  await act(async()=>{for(const call of calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(item));});
  await act(async()=>window.dispatchEvent(new CustomEvent('loom-following-change',{detail:store.prefix})));
  await act(async()=>calls.at(-1)!.finish(Response.json({error:{code:'unauthenticated',message:'Authentication is no longer available'}},{status:401})));
  assert.equal(screen.queryByText('Previously authorized topic')===null,true);
  assert.match(screen.queryByRole('alert')?.textContent??'',/Authentication is no longer available/);
  assert.equal((screen.getByRole('button',{name:'Follow'}) as HTMLButtonElement).disabled,true);
  assert.equal(screen.queryByText('Follow settings')===null,true);
});

test('renewing an expired displayed page retains its saved item and byte budgets',async t=>{
  const {calls,context,router}=mount(t);
  await waitFor(()=>assert.equal(calls.length,2));
  await act(async()=>router.navigate('/other'));
  const recovery=new SharedRecovery(context.community.instance_id,context.self.participant_id),page={...result('five'),limit:5,max_response_bytes:8192};
  await recovery.save(JSON.stringify({kind:'following'}),page,0,()=>true);
  await act(async()=>router.navigate('/loom/changes'));
  await waitFor(()=>assert.equal(calls.length,4));
  assert.deepEqual(calls[3]!.body,{cursor:'five',limit:5,max_response_bytes:8192});
  await act(async()=>calls[3]!.finish(Response.json({error:{code:'shared_descriptor_expired',message:'Renew fixed view'}},{status:410})));
  await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Renew fixed shared view'})));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Renew fixed shared view'})));
  assert.deepEqual(calls[4]!.body,{recovery:{action:'renew',token:'five'},limit:5,max_response_bytes:8192});
  await act(async()=>calls[4]!.finish(Response.json({...page,page_cursor:'renewed',recovery:'renewed'})));
  await waitFor(()=>assert.deepEqual(record().request,{cursor:'renewed',limit:5,max_response_bytes:8192}));
  assert.equal((screen.getByLabelText('Next page size') as HTMLSelectElement).value,'5');
});
