import assert from 'node:assert/strict';
import { afterEach,test,type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { SharedChangesPage } from '../../src/web/SharedChanges.js';
import {AuthorizationBoundary} from '../../src/web/AuthorizationBoundary.js';
import {AttentionRecovery} from '../../src/web/attention-recovery.js';
import { FollowControl,FollowingPage } from '../../src/web/Following.js';
import { SharedRecovery } from '../../src/web/shared-recovery.js';
import { IntentStore,invalidateIdentity,commandRequest,type Intent } from '../../src/web/participation-client.js';
import type { Context } from '../../src/web/participation-state.js';
import type { FollowItemView,SharedPageView } from '../../src/contracts/following.js';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent','StorageEvent'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
const {render,screen,within,fireEvent,cleanup,act,waitFor}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});
const target={kind:'area' as const,resource_id:randomUUID()},definition={target,include_descendants:false,preferences:['artifact_revisions'] as const};
function result(cursor='shown',scope:'following'|'explicit'='following'):SharedPageView{return {contract_version:'shared-changes-1',items:[],traversal:{id:randomUUID(),scope,definitions:[{...definition,preferences:['artifact_revisions'],version:1}],settings_current:true,selection:'complete',grouping:'none',order:'committed_event_ascending',expires_at:'2026-10-17T00:00:00Z',boundaries:'fixed_shared_interval',history_start:'retained_history'},page_cursor:cursor,next_cursor:'next',checkpoint:null,page_exhausted:false,interval_complete:false,no_subscriptions:false,work_budget_reached:false,coverage:'known',coverage_limit:null,recovery:'none',history:'retained',baseline_established:false,inventory:[],omitted_detail:'full_bodies',limit:12,max_response_bytes:131072};}
function mount(t:TestContext,control:boolean|'following'|'host'=false,attention=false){
  const calls:{path:string;body:any;finish:(r:Response)=>void}[]=[];t.mock.method(globalThis,'fetch',(path:string,options:any)=>new Promise<Response>(finish=>calls.push({path,body:options.body?JSON.parse(options.body):undefined,finish})));
  const instance=randomUUID(),participant=randomUUID(),store=new IntentStore(instance,participant);
  const context={community:{instance_id:instance,...(attention?{attention_contract:'attention-controls-1'}:{})},self:{participant_id:participant,csrf:'fixture'},store} as Context;
  const router=createMemoryRouter([{path:'/loom/changes',element:<AuthorizationBoundary><SharedChangesPage context={context}/></AuthorizationBoundary>},{path:'/control',element:<AuthorizationBoundary sourcePolicy="settings"><FollowControl context={context} target={target}/></AuthorizationBoundary>},
    {path:'/host',element:<AuthorizationBoundary><h1>Protected source host</h1><FollowControl context={context} target={target}/></AuthorizationBoundary>},
    {path:'/loom/following',element:<FollowingPage context={context}/>},{path:'/other',element:<h1>Other view</h1>}],{initialEntries:[control==='following'?'/loom/following':control==='host'?'/host':control?'/control':'/loom/changes']});
  t.after(()=>router.dispose());render(<StrictMode><RouterProvider router={router}/></StrictMode>);return {calls,router,store,context};
}
const records=()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('loom.shared-pages:'))!)!);
const record=()=>Object.values(records())[0] as any;
async function readyPrivateFollows(t:TestContext,host:'following'|'host'='following'){
 const f=mount(t,host,true),sibling={kind:'artifact' as const,resource_id:randomUUID()},parent=randomUUID();
 const rows:FollowItemView[]=[target,sibling].map((target,index)=>({...definition,target,preferences:['artifact_revisions'],version:1,following:true,
   source:{state:'available',title:'Leased Following title '+index,path:[{id:parent,title:'Leased Following parent'}],browser_url:'/loom/resource/'+target.resource_id}}));
 const page=(items=rows)=>({items,next_cursor:null,complete:true,collection_version:items[0]?.version??1,ordering:'stable_target_id',limit:12,max_response_bytes:131072});
 const mute=(row:FollowItemView)=>({target:row.target,include_descendants:false,muted:true,version:1,source:row.source,other_current_scope_mutes:[]});
 await act(async()=>{for(const call of f.calls)call.finish(Response.json(host==='following'?page():call.path.includes('/attention/')?mute(rows[0]!):rows[0]));});
 await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup'))){const row=rows.find(r=>r.target.resource_id===call.body.resource_id)!;
   call.finish(Response.json(call.path.includes('/attention/')?mute(row):row));}});
 for(const detail of document.querySelectorAll('details'))detail.open=true;
 const control=(index=0)=>within(document.querySelector((host==='following'?'.following-row ':'')+'[data-follow-target="'+rows[index]!.target.kind+':'+rows[index]!.target.resource_id+'"]') as HTMLElement);
 const exposure=()=>screen.queryAllByText(/Leased Following (title|parent)/).length;
 return {...f,rows,page,mute,control,exposure};
}
for(const host of ['following','host'] as const)for(const kind of ['Follow','mute'] as const)
for(const refusal of ['unavailable result','source refusal'] as const)for(const order of ['refusal first','success first'] as const)
test(`overlapping ${kind} lookups on ${host}: superseded ${refusal}, ${order}, revokes pending metadata`,async t=>{
 const f=await readyPrivateFollows(t,host);assert.ok(f.exposure()>0);
 const pendingStart=f.calls.length;
 if(host==='following'){
   await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh following'})));
   await act(async()=>fireEvent.click(f.control(1).getByRole('button',{name:'Refresh mute state'})));
 }
 async function lookup(){
   const start=f.calls.length;
   await act(async()=>{if(kind==='Follow')window.dispatchEvent(new CustomEvent('loom-following-change',{detail:f.store.prefix}));
     else fireEvent.click(f.control().getByRole('button',{name:'Refresh mute state'}));});
   const call=f.calls.slice(start).find(c=>c.path.endsWith(kind==='Follow'?'/following/lookup':'/mutes/lookup')&&c.body.resource_id===target.resource_id);
   assert.ok(call);return call;
 }
 const older=await lookup(),newer=await lookup(),item=kind==='Follow'?f.rows[0]!:f.mute(f.rows[0]!);
 // The newer client request may obtain its server snapshot first. Neither
 // dispatch order nor completion order proves which source check is newer.
 const heldSuccess=structuredClone(item);
 if(order==='success first')await act(async()=>newer.finish(Response.json(heldSuccess)));
 await act(async()=>older.finish(Response.json(refusal==='unavailable result'?{...item,source:{state:'unavailable'}}:
   {error:{code:'unavailable',message:'Source withdrawn'}},{status:refusal==='unavailable result'?200:404})));
 assert.equal(f.exposure(),0,'a superseded refusal must revoke existing metadata');
 if(host==='host')assert.equal(!!screen.queryByRole('heading',{name:'Protected source host'}),false);
 if(order==='refusal first')await act(async()=>newer.finish(Response.json(heldSuccess)));
 await act(async()=>{for(const call of f.calls.slice(pendingStart)){
   if(call===older||call===newer)continue;
   const row=f.rows.find(r=>r.target.resource_id===call.body?.resource_id);
   call.finish(Response.json(row?(call.path.includes('/attention/')?f.mute(row):row):f.page()));
 }});
 assert.equal(f.exposure(),0,'same-target, sibling and collection responses started before revocation cannot restore metadata');
 if(host==='following'){
   assert.equal(f.control().getByRole('button',{name:'Unfollow'}).hasAttribute('disabled'),false);
   const start=f.calls.length;
   await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry following page'})));
   await act(async()=>f.calls.slice(start).find(c=>c.path.includes('/following?'))!.finish(Response.json(f.page())));
   assert.ok(f.exposure()>0,'a fresh authorized collection can restore metadata');
   // The same mounted boundary must not permanently exempt this target.
   const again=await lookup();await act(async()=>again.finish(Response.json({...item,source:{state:'unavailable'}})));
   assert.equal(f.exposure(),0,'a repeated transition revokes the fresh leases');
 }
});

for(const kind of ['Follow','mute'] as const)for(const refusal of ['unavailable result','source refusal'] as const)
test(`an overlapping ${kind} ${refusal} from before recovery still withdraws fresh authorization`,async t=>{
 const f=await readyPrivateFollows(t),item=kind==='Follow'?f.rows[0]!:f.mute(f.rows[0]!);
 async function lookup(){const start=f.calls.length;
   await act(async()=>{if(kind==='Follow')window.dispatchEvent(new CustomEvent('loom-following-change',{detail:f.store.prefix}));
     else fireEvent.click(f.control().getByRole('button',{name:'Refresh mute state'}));});
   return f.calls.slice(start).find(c=>c.path.endsWith(kind==='Follow'?'/following/lookup':'/mutes/lookup')&&c.body.resource_id===target.resource_id)!;
 }
 const old=await lookup(),withdrawal=await lookup();
 await act(async()=>withdrawal.finish(Response.json({...item,source:{state:'unavailable'}})));
 assert.equal(f.exposure(),0);
 const start=f.calls.length;await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry following page'})));
 await act(async()=>f.calls.slice(start).find(c=>c.path.includes('/following?'))!.finish(Response.json(f.page())));
 const restored=f.exposure();assert.ok(restored>0);
 await act(async()=>old.finish(Response.json(refusal==='unavailable result'?{...item,source:{state:'unavailable'}}:
   {error:{code:'unavailable',message:'Old source refusal'}},{status:refusal==='unavailable result'?200:404})));
 assert.equal(f.exposure(),0,'request age does not prove when the server evaluated authorization');
});

for(const kind of ['Follow','mute'] as const)
test(`a superseded positive ${kind} lookup cannot authorize previews or suppress a later denial`,async t=>{
 const f=await readyPrivateFollows(t),item=kind==='Follow'?f.rows[0]!:f.mute(f.rows[0]!);
 async function lookup(){const start=f.calls.length;
   await act(async()=>{if(kind==='Follow')window.dispatchEvent(new CustomEvent('loom-following-change',{detail:f.store.prefix}));
     else fireEvent.click(f.control().getByRole('button',{name:'Refresh mute state'}));});
   return f.calls.slice(start).find(c=>c.path.endsWith(kind==='Follow'?'/following/lookup':'/mutes/lookup')&&c.body.resource_id===target.resource_id)!;
 }
 const withdrawn=await lookup();await act(async()=>withdrawn.finish(Response.json({...item,source:{state:'unavailable'}})));
 await act(async()=>fireEvent.click(f.control(1).getByRole('button',{name:'Refresh mute state'})));
 await act(async()=>f.calls.at(-1)!.finish(Response.json(f.mute(f.rows[1]!))));
 const sibling=f.exposure();assert.equal(sibling,1);
 const old=await lookup(),latest=await lookup();
 await act(async()=>old.finish(Response.json(item)));
 await act(async()=>latest.finish(Response.json({...item,source:{state:'unavailable'}})));
 assert.equal(f.exposure(),0,'every relevant denial conservatively withdraws the host; private removal remains usable');
 assert.equal(f.control().getByRole('button',{name:'Unfollow'}).hasAttribute('disabled'),false);
});

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
test('a shared page waiting for its journal lock cannot advance recovery after source withdrawal',async t=>{
  const {calls}=mount(t);
  await act(async()=>{for(const call of calls)call.finish(Response.json(result()));});
  const saved=JSON.stringify(records());
  let release!:(()=>void);
  t.mock.method(navigator.locks,'request',(_name:string,work:()=>unknown)=>new Promise((resolve,reject)=>{
    release=()=>{try{resolve(work());}catch(error){reject(error);}};
  }));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Continue shared interval'})));
  await act(async()=>calls.at(-1)!.finish(Response.json(result('unseen-successor'))));
  assert.ok(release,'The successor must actually wait at the persistence boundary.');
  const refusal=commandRequest('/api/v1/replies',{body:{}});
  await act(async()=>{
    const settled=assert.rejects(refusal,{code:'unavailable'}).then(()=>release());
    calls.at(-1)!.finish(Response.json({error:{code:'unavailable',message:'Source withdrawn'}},{status:404}));
    await settled;
  });
  assert.equal(JSON.stringify(records()),saved,'A withdrawn successor must not replace the last displayed recovery page.');
  assert.equal(!!screen.queryByText('Coverage and recovery'),false);
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
  assert.equal(document.querySelectorAll('[data-follow-target]').length,0);
  assert.ok(screen.getByRole('button',{name:'Retry following page'}));
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

test('mute source withdrawal invalidates cached Following row metadata',async t=>{
 const f=mount(t,'following',true),follow={...definition,preferences:['artifact_revisions'],version:1,following:true,source:{state:'available',title:'Protected Following title',path:[{id:target.resource_id,title:'Protected Following path'}],browser_url:'/loom/area/'+target.resource_id}};
 await act(async()=>{for(const call of f.calls)call.finish(Response.json({items:[follow],next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',limit:12,max_response_bytes:131072}));});
 const mute={target,include_descendants:false,muted:false,version:0,source:follow.source,other_current_scope_mutes:[]};
 await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(call.path.includes('/attention/')?mute:follow));});
 for(const detail of document.querySelectorAll('details'))detail.open=true;
 assert.ok(screen.getByRole('heading',{name:'Protected Following title'}));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh following'})));const pending=f.calls.at(-1)!;
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh mute state'})));
 await act(async()=>f.calls.at(-1)!.finish(Response.json({...mute,version:1,muted:true,source:{state:'unavailable'}})));
 assert.equal(!!screen.queryByRole('heading',{name:'Protected Following title'}),false,'withdrawal must remove parent row title');
 assert.equal(!!screen.queryByText('Protected Following path'),false);
 await act(async()=>pending.finish(Response.json({items:[follow],next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',limit:12,max_response_bytes:131072})));
 assert.equal(!!screen.queryByRole('heading',{name:'Protected Following title'}),false);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry following page'})));
 await act(async()=>f.calls.at(-1)!.finish(Response.json({items:[{...follow,source:{state:'unavailable'}}],next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',limit:12,max_response_bytes:131072})));
 await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(call.path.includes('/attention/')?{...mute,source:{state:'unavailable'}}:{...follow,source:{state:'unavailable'}}));});
 assert.ok(screen.getByRole('heading',{name:'Followed target unavailable'}));assert.equal((screen.getByRole('button',{name:'Unfollow'}) as HTMLButtonElement).disabled,false);
 for(const detail of document.querySelectorAll('details'))detail.open=true;
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh mute state'})));
 await act(async()=>f.calls.at(-1)!.finish(Response.json({error:{code:'unavailable',message:'No readable source or owner-held mute'}},{status:404})));
 assert.ok(screen.getByRole('heading',{name:'Followed target unavailable'}));
 assert.equal((screen.getByRole('button',{name:'Unfollow'}) as HTMLButtonElement).disabled,false,'an absent mute must not strand a safe unavailable Follow');
});

test('safe unavailable Unfollow keeps its known source state when a recovery control mounts during dispatch',async t=>{
 const f=mount(t,'following',true),follow={...definition,preferences:['artifact_revisions'],version:1,following:true,source:{state:'unavailable'}};
 await act(async()=>{for(const call of f.calls)call.finish(Response.json({items:[follow],next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',limit:12,max_response_bytes:131072}));});
 const lookup=()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(call.path.includes('/attention/')?
   Response.json({error:{code:'unavailable',message:'No readable source or owner-held mute'}},{status:404}):Response.json(follow));};
 await act(async()=>lookup());
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Unfollow'})));
 await waitFor(()=>assert.ok(f.calls.some(c=>c.path.endsWith('/following/state'))));
 const dispatch=f.calls.find(c=>c.path.endsWith('/following/state'))!;
 await act(async()=>lookup());
 assert.ok(screen.getByRole('heading',{name:'Followed target unavailable'}),'pending recovery must preserve the safe collection');
 assert.deepEqual(f.context.store.all()[0]!.body,dispatch.body);
 await act(async()=>dispatch.finish(Response.json({operation_state:'applied',operation_id:randomUUID(),idempotency:'created',
   outcome:{...definition,preferences:['artifact_revisions'],following:false,expected_version:1,result_version:2},current:{...follow,following:false,version:2}})));
 await waitFor(()=>assert.equal(f.context.store.all().length,0));
 assert.ok(screen.getByText(/Explicit follow removed/));
});

test('Following reauthorization closes the unavailable mute exception without a mute preview',async t=>{
 const f=mount(t,'following',true),follow={...definition,preferences:['artifact_revisions'],version:1,following:true,source:{state:'unavailable'}};
 const page={items:[follow],next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',limit:12,max_response_bytes:131072};
 const absent=()=>Response.json({error:{code:'unavailable',message:'No readable source or owner-held mute'}},{status:404});
 await act(async()=>{for(const call of f.calls)call.finish(Response.json(page));});
 await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(call.path.includes('/attention/')?absent():Response.json(follow));});
 assert.equal((screen.getByRole('button',{name:'Unfollow'}) as HTMLButtonElement).disabled,false);
 await act(async()=>window.dispatchEvent(new CustomEvent('loom-following-change',{detail:f.store.prefix})));
 await act(async()=>f.calls.at(-1)!.finish(Response.json({...follow,source:{state:'available',title:'Reauthorized Following title',path:[],browser_url:'/loom/area/'+target.resource_id}})));
 assert.ok(screen.getByRole('heading',{name:'Reauthorized Following title'}));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh mute state'})));
 await act(async()=>f.calls.at(-1)!.finish(absent()));
 assert.equal(!!screen.queryByRole('heading',{name:'Reauthorized Following title'}),false);
 assert.ok(screen.getByRole('button',{name:'Retry following page'}));
});

test('a negative Follow lookup cannot exempt an already protected full-source host',async t=>{
 const instance=randomUUID(),participant=randomUUID(),context={community:{instance_id:instance,attention_contract:'attention-controls-1'},self:{participant_id:participant,csrf:'fixture'},store:new IntentStore(instance,participant)} as Context;
 const calls:{path:string;finish:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string)=>new Promise<Response>(finish=>calls.push({path,finish})));
 render(<StrictMode><AuthorizationBoundary><h1>Protected full-source text</h1><FollowControl context={context} target={target}/></AuthorizationBoundary></StrictMode>);
 await act(async()=>{for(const call of calls.filter(c=>c.path.includes('/following/')))call.finish(Response.json({...definition,preferences:['artifact_revisions'],version:1,following:true,source:{state:'unavailable'}}));});
 await act(async()=>{for(const call of calls.filter(c=>c.path.includes('/attention/')))call.finish(Response.json({error:{code:'unavailable',message:'Source withdrawn'}},{status:404}));});
 assert.equal(!!screen.queryByRole('heading',{name:'Protected full-source text'}),false);
});

test('an unavailable Following lookup revokes attention previews, siblings and pending responses',async t=>{
 const f=mount(t,'following',true),sibling={kind:'artifact' as const,resource_id:randomUUID()},parent=randomUUID();
 const rows:FollowItemView[]=[target,sibling].map((target,index)=>({...definition,target,preferences:['artifact_revisions'],version:1,following:true,
   source:{state:'available',title:'Authorized private source '+index,path:[{id:parent,title:'Authorized common parent'}],browser_url:'/loom/resource/'+target.resource_id}}));
 const page={items:rows,next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',limit:12,max_response_bytes:131072};
 const mute=(row:FollowItemView)=>({target:row.target,include_descendants:false,muted:true,version:1,source:row.source,other_current_scope_mutes:[]});
 await act(async()=>{for(const call of f.calls)call.finish(Response.json(page));});
 await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup'))){const row=rows.find(r=>r.target.resource_id===call.body.resource_id)!;
   call.finish(Response.json(call.path.includes('/attention/')?mute(row):row));}});
 for(const detail of document.querySelectorAll('details'))detail.open=true;
 assert.ok(screen.getByText('Routine area updates · Authorized private source 0'));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh following'})));const oldList=f.calls.at(-1)!;
 await act(async()=>fireEvent.click(screen.getAllByRole('button',{name:'Refresh mute state'})[1]!));const oldMute=f.calls.at(-1)!;
 const before=f.calls.length;
 await act(async()=>window.dispatchEvent(new CustomEvent('loom-following-change',{detail:f.store.prefix})));
 const withdrawal=f.calls.slice(before).find(c=>c.path.endsWith('/following/lookup')&&c.body.resource_id===target.resource_id)!;
 await act(async()=>withdrawal.finish(Response.json({...rows[0],source:{state:'unavailable'}})));
 const exposure=()=>({previews:screen.queryAllByText(/Routine (area|artifact) updates · Authorized private source/).length,
   siblings:screen.queryAllByRole('heading',{name:'Authorized private source 1'}).length});
 const afterWithdrawal=exposure();
 await act(async()=>{oldList.finish(Response.json(page));oldMute.finish(Response.json(mute(rows[1]!)));});
 assert.deepEqual({afterWithdrawal,afterPending:exposure()},
   {afterWithdrawal:{previews:0,siblings:0},afterPending:{previews:0,siblings:0}},'a validated source withdrawal must revoke every shared preview lease');
});

test('available-to-unavailable Following removal survives its temporary recovery mute lookup',async t=>{
 const f=mount(t,'following',true),follow:FollowItemView={...definition,preferences:['artifact_revisions'],version:1,following:true,
   source:{state:'available',title:'Formerly readable follow',path:[],browser_url:'/loom/area/'+target.resource_id}};
 await act(async()=>{for(const call of f.calls)call.finish(Response.json({items:[follow],next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',limit:12,max_response_bytes:131072}));});
 await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(call.path.includes('/attention/')?
   {target,include_descendants:false,muted:false,version:0,source:follow.source,other_current_scope_mutes:[]}:follow));});
 const unavailable={...follow,source:{state:'unavailable' as const}},before=f.calls.length;
 await act(async()=>window.dispatchEvent(new CustomEvent('loom-following-change',{detail:f.store.prefix})));
 await act(async()=>{for(const call of f.calls.slice(before))call.finish(Response.json(unavailable));});
 assert.ok(screen.getByRole('heading',{name:'Followed target unavailable'}));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Unfollow'})));
 await waitFor(()=>assert.ok(f.calls.some(c=>c.path.endsWith('/following/state'))));
 const dispatch=f.calls.find(c=>c.path.endsWith('/following/state'))!;
 await act(async()=>{for(const call of f.calls.slice(before).filter(c=>c.path.endsWith('/lookup')))call.finish(call.path.includes('/attention/')?
   Response.json({error:{code:'unavailable',message:'No readable source or owner-held mute'}},{status:404}):Response.json(unavailable));});
 await act(async()=>dispatch.finish(Response.json({operation_state:'applied',operation_id:randomUUID(),idempotency:'created',
   outcome:{...definition,preferences:['artifact_revisions'],following:false,expected_version:1,result_version:2},current:{...unavailable,following:false,version:2}})));
 await waitFor(()=>assert.equal(f.store.all().length,0));
 assert.ok(screen.queryByText(/Explicit follow removed/),'successful safe removal must keep its confirmation visible');
});

for(const path of ['collection','lookup','mutation','status','retry'] as const)
for(const response of ['unavailable result','source refusal','owner refusal'] as const)
test(`Following ${path} centrally handles ${response} while retaining private controls`,async t=>{
 const f=mount(t,'following',true),sibling={kind:'artifact' as const,resource_id:randomUUID()},parent=randomUUID();
 const rows:FollowItemView[]=[target,sibling].map((target,index)=>({...definition,target,preferences:['artifact_revisions'],version:1,following:true,
   source:{state:'available',title:'Following protected source '+index,path:[{id:parent,title:'Following protected parent'}],browser_url:'/loom/resource/'+target.resource_id}}));
 const page={items:rows,next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',limit:12,max_response_bytes:131072};
 const mute=(row:FollowItemView)=>({target:row.target,include_descendants:false,muted:true,version:1,source:row.source,other_current_scope_mutes:[]});
 await act(async()=>{for(const call of f.calls)call.finish(Response.json(page));});
 await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup'))){const row=rows.find(r=>r.target.resource_id===call.body.resource_id)!;
   call.finish(Response.json(call.path.includes('/attention/')?mute(row):row));}});
 for(const detail of document.querySelectorAll('details'))detail.open=true;
 const control=()=>within(document.querySelector('.following-row [data-follow-target="area:'+target.resource_id+'"]') as HTMLElement);
 let original:any;
 if(path==='status'||path==='retry'){
   await act(async()=>fireEvent.click(control().getByRole('button',{name:'Unfollow'})));
   await waitFor(()=>assert.ok(f.calls.find(c=>c.path.endsWith('/following/state'))));
   const sent=f.calls.find(c=>c.path.endsWith('/following/state'))!;original=sent.body;
   await act(async()=>sent.finish(Response.json({error:{code:'service_unavailable',message:'Response lost'}},{status:503})));
 }
 await act(async()=>fireEvent.click(screen.getAllByRole('button',{name:'Refresh mute state'}).find(button=>button.closest('[data-mute-target]')?.getAttribute('data-mute-target')==='artifact:'+sibling.resource_id)!));
 const oldMute=f.calls.at(-1)!;
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh following'})));const oldList=f.calls.at(-1)!;
 const before=f.calls.length;
 if(path==='lookup')await act(async()=>window.dispatchEvent(new CustomEvent('loom-following-change',{detail:f.store.prefix})));
 else if(path!=='collection')await act(async()=>fireEvent.click(control().getByRole('button',{name:path==='mutation'?'Unfollow':path==='status'?'Check follow status':'Retry same follow change'})));
 await waitFor(()=>assert.ok(path==='collection'||f.calls.length>before));
 const operation=path==='collection'?oldList:path==='lookup'?f.calls.slice(before).find(c=>c.path.endsWith('/following/lookup')&&c.body.resource_id===target.resource_id)!:
   f.calls.slice(before).find(c=>c.path.endsWith('/following/'+(path==='status'?'status':'state')))!;
 if(path==='mutation')original=operation.body;
 const unavailable={...rows[0]!,source:{state:'unavailable' as const}};
 const value=path==='collection'?{...page,items:rows.map(row=>({...row,source:{state:'unavailable'}}))}:path==='lookup'?unavailable:
   {operation_state:'applied',operation_id:randomUUID(),idempotency:path==='mutation'?'created':'replayed',
     outcome:{...definition,preferences:['artifact_revisions'],following:false,expected_version:1,result_version:2},current:{...unavailable,following:false,version:2}};
 await act(async()=>operation.finish(Response.json(response==='unavailable result'?value:{error:{code:response==='owner refusal'?'invalid_actor':'unavailable',message:'Current authority refused'}},
   {status:response==='unavailable result'?200:response==='owner refusal'?403:404})));
 const exposure=()=>screen.queryAllByText(/Following protected (source|parent)/).length;
 assert.equal(exposure(),0,'every source-bearing Following response must revoke enclosing and embedded previews');
 if(response==='owner refusal')assert.equal(document.querySelectorAll('[data-follow-target]').length,0);
 else assert.ok(document.querySelectorAll('[data-follow-target]').length>0,'private settings survive source withdrawal');
 await act(async()=>{oldList.finish(Response.json(page));oldMute.finish(Response.json(mute(rows[1]!)));});
 assert.equal(exposure(),0,'older responses cannot reacquire metadata authority');
 if(original&&response==='unavailable result')assert.equal(f.store.all().length,0);
 else if(original)assert.deepEqual(f.store.all()[0]!.body,original,'refusal never substitutes a new command');
});

for(const path of ['collection','lookup'] as const)for(const order of ['available first','unavailable first'] as const)
test(`Following ${path} keeps its response lease across same-turn withdrawal with ${order}`,async t=>{
 const f=await readyPrivateFollows(t),before=f.calls.length;
 if(path==='collection')await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh following'})));
 else await act(async()=>window.dispatchEvent(new CustomEvent('loom-following-change',{detail:f.store.prefix})));
 const available=path==='collection'?f.calls.at(-1)!:f.calls.slice(before).find(c=>c.path.endsWith('/following/lookup')&&c.body.resource_id===target.resource_id)!;
 await act(async()=>fireEvent.click(f.control(1).getByRole('button',{name:'Refresh mute state'})));const unavailable=f.calls.at(-1)!;
 const positive=()=>available.finish(Response.json(path==='collection'?f.page():f.rows[0]));
 const negative=()=>unavailable.finish(Response.json({...f.mute(f.rows[1]!),source:{state:'unavailable'}}));
 await act(async()=>{if(order==='available first'){positive();negative();}else{negative();positive();}});
 assert.equal(f.exposure(),0,'the caller cannot turn an expired response generation into a fresh preview');
 assert.equal((f.control().getByRole('button',{name:'Unfollow'}) as HTMLButtonElement).disabled,false);
});

test('Following repeatedly withdraws and reauthorizes every response path in the same mounted private view',async t=>{
 const f=await readyPrivateFollows(t);
 let round=0;
 for(const path of ['collection','lookup','mutation','status','retry','collection','lookup','mutation','status','retry'] as const){
   const rows=f.rows.map(row=>({...row,version:1+round*2}));
   if(round++){
     await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh following'})));
     await act(async()=>f.calls.at(-1)!.finish(Response.json(f.page(rows))));
     for(let index=0;index<2;index++){
       await act(async()=>fireEvent.click(f.control(index).getByRole('button',{name:'Refresh mute state'})));
       await act(async()=>f.calls.at(-1)!.finish(Response.json(f.mute(rows[index]!))));
     }
   }
   assert.ok(screen.getByRole('heading',{name:'Leased Following title 0'}));
   assert.ok(screen.getByText('Routine artifact updates · Leased Following title 1'));
   let original:any;
   if(path==='status'||path==='retry'){
     const before=f.calls.length;await act(async()=>fireEvent.click(f.control().getByRole('button',{name:'Unfollow'})));
     await waitFor(()=>assert.ok(f.calls.slice(before).find(c=>c.path.endsWith('/following/state'))));
     const sent=f.calls.slice(before).find(c=>c.path.endsWith('/following/state'))!;original=sent.body;
     await act(async()=>sent.finish(Response.json({error:{code:'service_unavailable',message:'Unconfirmed decision'}},{status:503})));
   }
   const beforeReads=f.calls.length;
   await act(async()=>window.dispatchEvent(new CustomEvent('loom-following-change',{detail:f.store.prefix})));
   const oldReads=f.calls.slice(beforeReads).filter(c=>c.path.endsWith('/following/lookup'));
   if(path==='mutation')await act(async()=>{for(const call of oldReads.filter(c=>c.body.resource_id===target.resource_id))call.finish(Response.json(rows[0]));});
   await act(async()=>fireEvent.click(f.control(1).getByRole('button',{name:'Refresh mute state'})));const oldMute=f.calls.at(-1)!;
   await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh following'})));const oldList=f.calls.at(-1)!;
   const before=f.calls.length;
   if(path==='mutation'||path==='status'||path==='retry')await act(async()=>fireEvent.click(f.control().getByRole('button',{name:path==='mutation'?'Unfollow':path==='status'?'Check follow status':'Retry same follow change'})));
   if(path!=='collection'&&path!=='lookup')await waitFor(()=>assert.ok(f.calls.slice(before).find(c=>c.path.endsWith('/following/'+(path==='status'?'status':'state')))));
   const operation=path==='collection'?oldList:path==='lookup'?oldReads.find(c=>c.body.resource_id===target.resource_id)!:
     f.calls.slice(before).find(c=>c.path.endsWith('/following/'+(path==='status'?'status':'state')))!;
   if(path==='mutation')original=operation.body;
   const unavailable={...rows[0]!,source:{state:'unavailable' as const}};
   const value=path==='collection'?f.page(rows.map(row=>({...row,source:{state:'unavailable'}}))):path==='lookup'?unavailable:
     {operation_state:'applied',operation_id:randomUUID(),idempotency:'replayed',outcome:{...definition,preferences:['artifact_revisions'],following:false,
       expected_version:original.expected_version,result_version:original.expected_version+1},current:{...unavailable,version:original.expected_version+1,following:false}};
   await act(async()=>operation.finish(Response.json(value)));
   assert.equal(f.exposure(),0,path+' must revoke both rows and both attention previews');
   await act(async()=>{
     oldList.finish(Response.json(f.page(rows)));oldMute.finish(Response.json(f.mute(rows[1]!)));
     for(const call of oldReads)call.finish(Response.json(rows.find(row=>row.target.resource_id===call.body.resource_id)));
   });
   assert.equal(f.exposure(),0,path+' pending responses cannot restore metadata');
   assert.equal(f.store.all().length,0);
   if(original)assert.match(f.control().getByRole('status').textContent!,/Explicit follow removed/);
 }
});

for(const path of ['mutation','status','retry'] as const)
test(`a pending Following ${path} settles private custody after repeated withdrawal without restoring metadata`,async t=>{
 const f=await readyPrivateFollows(t);
 const before=f.calls.length;await act(async()=>fireEvent.click(f.control().getByRole('button',{name:'Unfollow'})));
 await waitFor(()=>assert.ok(f.calls.slice(before).find(c=>c.path.endsWith('/following/state'))));
 const sent=f.calls.slice(before).find(c=>c.path.endsWith('/following/state'))!,original=sent.body;
 let pending=sent;
 if(path!=='mutation'){
   await act(async()=>sent.finish(Response.json({error:{code:'service_unavailable',message:'Lost reply'}},{status:503})));
   const before=f.calls.length;await act(async()=>fireEvent.click(f.control().getByRole('button',{name:path==='status'?'Check follow status':'Retry same follow change'})));
   await waitFor(()=>assert.ok(f.calls.slice(before).find(c=>c.path.endsWith('/following/'+(path==='status'?'status':'state')))));
   pending=f.calls.slice(before).find(c=>c.path.endsWith('/following/'+(path==='status'?'status':'state')))!;
 }
 await act(async()=>fireEvent.click(f.control(1).getByRole('button',{name:'Refresh mute state'})));
 await act(async()=>f.calls.at(-1)!.finish(Response.json({...f.mute(f.rows[1]!),source:{state:'unavailable'}})));
 assert.equal(f.exposure(),0);
 const restored=f.rows.map(row=>({...row,version:3}));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh following'})));
 await act(async()=>f.calls.at(-1)!.finish(Response.json(f.page(restored))));
 assert.ok(screen.getByRole('heading',{name:'Leased Following title 0'}));
 const beforeSecond=f.calls.length;await act(async()=>window.dispatchEvent(new CustomEvent('loom-following-change',{detail:f.store.prefix})));
 const withdrawal=f.calls.slice(beforeSecond).filter(c=>c.path.endsWith('/following/lookup')&&c.body.resource_id===target.resource_id).at(-1)!;
 await act(async()=>withdrawal.finish(Response.json({...restored[0],source:{state:'unavailable'}})));
 assert.equal(f.exposure(),0);
 assert.deepEqual(f.store.all()[0]!.body,original);
 await act(async()=>pending.finish(Response.json({operation_state:'applied',operation_id:randomUUID(),idempotency:'replayed',
   outcome:{...definition,preferences:['artifact_revisions'],following:false,expected_version:1,result_version:2},
   current:{...f.rows[0],following:false,version:2,source:{state:'available',title:'Old command-only metadata',path:[],browser_url:'/loom/area/'+target.resource_id}}})));
 assert.equal(f.store.all().length,0);assert.equal(f.exposure(),0);assert.equal(screen.queryAllByText(/Old command-only metadata/).length,0);
 assert.match(f.control().getByRole('status').textContent!,/earlier decision is confirmed; the newer Following state is preserved/);
});

test('Following recovery keeps an unrecorded command and confirms safe removal after its temporary control unmounts',async t=>{
 const f=mount(t,'following',true);
 await act(async()=>{for(const call of f.calls)call.finish(Response.json({items:[],next_cursor:null,complete:true,collection_version:0,ordering:'stable_target_id',limit:12,max_response_bytes:131072}));});
 const body={...definition,preferences:['artifact_revisions'],following:false,expected_version:1};
 const draft=f.store.create('following:'+target.kind+':'+target.resource_id,'following.set','/api/v1/me/following/state',body);
 const retained=await f.store.prepareDispatch(draft,draft.body);
 await act(async()=>window.dispatchEvent(new CustomEvent('loom-following-change',{detail:f.store.prefix})));
 await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(call.path.includes('/attention/')?
   Response.json({error:{code:'unavailable',message:'No retained mute'}},{status:404}):Response.json({...definition,preferences:['artifact_revisions'],following:true,version:1,source:{state:'unavailable'}}));});
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check follow status'})));
 await act(async()=>f.calls.at(-1)!.finish(Response.json({operation_state:'not_recorded'})));
 assert.deepEqual(f.store.all()[0]!.body,retained.body);assert.ok(screen.getByText(/No decision is recorded yet/));
 const before=f.calls.length;await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry same follow change'})));
 await waitFor(()=>assert.ok(f.calls.slice(before).find(c=>c.path.endsWith('/following/state'))));
 const sent=f.calls.slice(before).find(c=>c.path.endsWith('/following/state'))!;assert.deepEqual(sent.body,retained.body);
 await act(async()=>sent.finish(Response.json({operation_state:'applied',operation_id:randomUUID(),idempotency:'replayed',
   outcome:{...body,result_version:2},current:{...definition,preferences:['artifact_revisions'],following:false,version:2,source:{state:'unavailable'}}})));
 assert.equal(f.store.all().length,0);assert.equal(document.querySelectorAll('[data-follow-target]').length,0);
 assert.ok(screen.getByText(/Explicit follow removed/),'confirmation belongs to the private page, not the retired recovery control');
});

test('Following conflict metadata is withdrawn while its safe version supports an explicitly new removal',async t=>{
 const f=await readyPrivateFollows(t),before=f.calls.length;
 await act(async()=>fireEvent.click(f.control().getByRole('button',{name:'Unfollow'})));
 await waitFor(()=>assert.ok(f.calls.slice(before).find(c=>c.path.endsWith('/following/state'))));
 const sent=f.calls.slice(before).find(c=>c.path.endsWith('/following/state'))!,after=f.calls.length;
 const unavailable={...f.rows[0]!,version:3,source:{state:'unavailable' as const}};
 await act(async()=>sent.finish(Response.json({operation_state:'version_conflict',operation_id:randomUUID(),idempotency:'created',
   outcome:{...definition,preferences:['artifact_revisions'],following:false,expected_version:1,result_version:3},current:unavailable})));
 assert.equal(f.exposure(),0);assert.equal(f.store.all().length,0);
 assert.match(f.control().getByRole('status').textContent!,/Another client changed these settings/);
 await act(async()=>{for(const call of f.calls.slice(after).filter(c=>c.path.endsWith('/following/lookup'))){const row=f.rows.find(row=>row.target.resource_id===call.body.resource_id)!;
   call.finish(Response.json({...row,version:3,source:{state:'unavailable'}}));}});
 const next=f.calls.length;await act(async()=>fireEvent.click(f.control().getByRole('button',{name:'Unfollow'})));
 await waitFor(()=>assert.ok(f.calls.slice(next).find(c=>c.path.endsWith('/following/state'))));
 const retried=f.calls.slice(next).find(c=>c.path.endsWith('/following/state'))!;
 assert.equal(retried.body.expected_version,3);assert.notEqual(retried.body.idempotency_key,sent.body.idempotency_key);
});

for(const identity of ['same','new'] as const)
test(`a late Following refusal respects a ${identity} browser identity after navigation`,async t=>{
 const f=mount(t,'host'),follow={...definition,preferences:['artifact_revisions'],following:true,version:1,source:{state:'available',title:'Old host source',path:[],browser_url:'/loom/area/'+target.resource_id}};
 await act(async()=>{for(const call of f.calls)call.finish(Response.json(follow));});
 const before=f.calls.length;await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Unfollow'})));
 await waitFor(()=>assert.ok(f.calls.slice(before).find(c=>c.path.endsWith('/following/state'))));
 const sent=f.calls.slice(before).find(c=>c.path.endsWith('/following/state'))!;
 await act(async()=>{if(identity==='new')invalidateIdentity();await f.router.navigate('/loom/following');});
 const collection=f.calls.findLast(c=>c.path.startsWith('/api/v1/me/following?'))!;
 await act(async()=>collection.finish(Response.json({items:[follow],next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',limit:12,max_response_bytes:131072})));
 assert.ok(screen.getByRole('heading',{name:'Following'}));
 await act(async()=>sent.finish(Response.json({error:{code:'invalid_actor',message:'Old credential refused'}},{status:403})));
 assert.equal(!!screen.queryByRole('heading',{name:'Following'}),identity==='new');
 assert.deepEqual(f.store.all()[0]!.body,sent.body);
});

test('Following withdraws before a blocked completion and keeps fresh metadata independent of the delayed receipt',async t=>{
 const f=await readyPrivateFollows(t),complete=f.store.complete.bind(f.store);
 let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>{release=resolve;});
 t.mock.method(f.store,'complete',async(record:Intent)=>{entered=true;await gate;return complete(record);});
 const before=f.calls.length;await act(async()=>fireEvent.click(f.control().getByRole('button',{name:'Unfollow'})));
 await waitFor(()=>assert.ok(f.calls.slice(before).find(c=>c.path.endsWith('/following/state'))));
 const sent=f.calls.slice(before).find(c=>c.path.endsWith('/following/state'))!;
 await act(async()=>sent.finish(Response.json({operation_state:'applied',operation_id:randomUUID(),idempotency:'created',
   outcome:{...definition,preferences:['artifact_revisions'],following:false,expected_version:1,result_version:2},current:{...f.rows[0],following:false,version:2,source:{state:'unavailable'}}})));
 assert.equal(entered,true);assert.equal(f.exposure(),0);assert.equal(f.store.all().length,1);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh following'})));
 await act(async()=>f.calls.at(-1)!.finish(Response.json(f.page(f.rows.map(row=>({...row,version:3}))))));
 assert.ok(screen.getByRole('heading',{name:'Leased Following title 0'}));
 await act(async()=>release());await waitFor(()=>assert.equal(f.store.all().length,0));
 assert.ok(screen.getByRole('heading',{name:'Leased Following title 0'}),'private receipt settlement cannot revoke a newer metadata lease');
 assert.match(f.control().getByRole('status').textContent!,/newer Following state is preserved/);
});

for(const path of ['lookup','mutation','status','retry'] as const)
for(const response of ['source refusal','owner refusal','unavailable result'] as const)
test(`Following ${path} ${response} withdraws its full-source host`,async t=>{
 const f=mount(t,'host',true),follow:FollowItemView={...definition,preferences:['artifact_revisions'],version:1,following:true,
   source:{state:'available',title:'Protected host preview',path:[],browser_url:'/loom/area/'+target.resource_id}};
 const mute={target,include_descendants:false,muted:true,version:1,source:follow.source,other_current_scope_mutes:[]};
 await act(async()=>{for(const call of f.calls)call.finish(Response.json(call.path.includes('/attention/')?mute:follow));});
 let original:any;
 if(path==='status'||path==='retry'){
   await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Unfollow'})));
   await waitFor(()=>assert.ok(f.calls.find(c=>c.path.endsWith('/following/state'))));const sent=f.calls.find(c=>c.path.endsWith('/following/state'))!;original=sent.body;
   await act(async()=>sent.finish(Response.json({error:{code:'service_unavailable',message:'Unconfirmed'}},{status:503})));
 }
 const before=f.calls.length;
 if(path==='lookup')await act(async()=>window.dispatchEvent(new CustomEvent('loom-following-change',{detail:f.store.prefix})));
 else await act(async()=>fireEvent.click(screen.getByRole('button',{name:path==='mutation'?'Unfollow':path==='status'?'Check follow status':'Retry same follow change'})));
 await waitFor(()=>assert.ok(f.calls.slice(before).find(c=>c.path.endsWith('/following/'+(path==='lookup'?'lookup':path==='status'?'status':'state')))));
 const operation=f.calls.slice(before).find(c=>c.path.endsWith('/following/'+(path==='lookup'?'lookup':path==='status'?'status':'state')))!;
 if(path==='mutation')original=operation.body;
 const unavailable={...follow,source:{state:'unavailable' as const}};
 const value=path==='lookup'?unavailable:{operation_state:'applied',operation_id:randomUUID(),idempotency:'created',
   outcome:{...definition,preferences:['artifact_revisions'],following:false,expected_version:1,result_version:2},current:{...unavailable,version:2,following:false}};
 await act(async()=>operation.finish(Response.json(response==='unavailable result'?value:{error:{code:response==='owner refusal'?'invalid_actor':'unavailable',message:'Source host refused'}},
   {status:response==='unavailable result'?200:response==='owner refusal'?403:404})));
 assert.equal(!!screen.queryByRole('heading',{name:'Protected source host'}),false);
 assert.equal(!!screen.queryByText(/Protected host preview/),false);
 assert.equal(document.activeElement,screen.getByRole('alert'));
 if(original&&response==='unavailable result')assert.equal(f.store.all().length,0);
 else if(original)assert.deepEqual(f.store.all()[0]!.body,original);
});

for(const path of ['mutation','status','retry'] as const)for(const response of ['source refusal','owner refusal','unavailable result'] as const)
test(`Following embedded mute ${path} ${response} invalidates its host without callback wiring`,async t=>{
 const f=mount(t,'following',true),follow={...definition,preferences:['artifact_revisions'],version:1,following:true,
   source:{state:'available',title:'Protected Following source',path:[{id:target.resource_id,title:'Protected path'}],browser_url:'/loom/area/'+target.resource_id}};
 const page={items:[follow],next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',limit:12,max_response_bytes:131072};
 const mute={target,include_descendants:false,muted:false,version:0,source:follow.source,other_current_scope_mutes:[]};
 await act(async()=>{for(const call of f.calls)call.finish(Response.json(page));});
 await act(async()=>{for(const call of f.calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(call.path.includes('/attention/')?mute:follow));});
 for(const detail of document.querySelectorAll('details'))detail.open=true;
 let original:any;
 if(path!=='mutation'){
   await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Mute routine updates'})));
   await waitFor(()=>assert.ok(f.calls.at(-1)!.path.endsWith('/state')));original=f.calls.at(-1)!.body;
   await act(async()=>f.calls.at(-1)!.finish(Response.json({error:{code:'service_unavailable',message:'Unconfirmed',operation_outcome:'unknown'}},{status:503})));
 }
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh following'})));const old=f.calls.at(-1)!;
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:path==='mutation'?'Mute routine updates':path==='status'?'Check attention outcome':'Retry same attention change'})));
 await waitFor(()=>assert.notEqual(f.calls.at(-1),old));const operation=f.calls.at(-1)!;original??=operation.body;
 const reply=response==='unavailable result'?{kind:'mute',operation_state:'applied',operation_id:randomUUID(),idempotency:'created',policy_version:1,
   outcome:{target,include_descendants:false,muted:true,expected_version:0,result_version:1},current:{...mute,version:1,muted:true,source:{state:'unavailable'}}}:
   {error:{code:response==='owner refusal'?'invalid_actor':'unavailable',message:'Current authority refused'}};
 await act(async()=>operation.finish(Response.json(reply,{status:response==='unavailable result'?200:403})));
 assert.equal(!!screen.queryByRole('heading',{name:'Protected Following source'}),false);assert.equal(!!screen.queryByText('Protected path'),false);
 await act(async()=>old.finish(Response.json(page)));assert.equal(!!screen.queryByRole('heading',{name:'Protected Following source'}),false);
 const journal=new AttentionRecovery(f.context.community.instance_id,f.context.self.participant_id);
 if(response==='unavailable result')assert.equal(journal.all().length,0);else assert.deepEqual(journal.all()[0]!.command.body,original);
});
