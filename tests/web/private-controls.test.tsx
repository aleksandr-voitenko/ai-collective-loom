import assert from 'node:assert/strict';
import {afterEach,test,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode} from 'react';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {FollowingPage} from '../../src/web/Following.js';
import {IntentStore} from '../../src/web/participation-client.js';
import type {Context} from '../../src/web/participation-state.js';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent','StorageEvent'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
const {render,screen,fireEvent,cleanup,act,within}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});
function mount(t:TestContext,count=2){
 const store=new IntentStore(randomUUID(),randomUUID()),context={controlsProjection:'private-controls-1',community:{instance_id:store.instance,attention_contract:'attention-controls-1'},self:{participant_id:store.participant,csrf:'fixture'},store} as Context;
 const items=Array.from({length:count},()=>({target:{kind:'artifact' as const,resource_id:randomUUID()},following:true,version:1,include_descendants:false,preferences:['artifact_revisions' as const]}));
 const page={items,next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',limit:12,max_response_bytes:131072};
 const previews={items:items.map((v,i)=>({target:v.target,source:{state:'available',title:'Private boundary title '+i,path:[],browser_url:'/source'},other_current_scope_mutes:[]}))};
 const calls:{path:string;body:any;done:boolean;finish:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string,options:any)=>new Promise<Response>(finish=>{const call={path,body:options.body?JSON.parse(options.body):undefined,done:false,finish:(r:Response)=>{call.done=true;finish(r);}};calls.push(call);}));
 const router=createMemoryRouter([{path:'/',element:<FollowingPage context={context}/>}]);t.after(()=>router.dispose());render(<StrictMode><RouterProvider router={router}/></StrictMode>);
 const privateLookups=async()=>act(async()=>{for(const c of calls.filter(c=>!c.done&&c.path.endsWith('/lookup'))){const item=items.find(i=>i.target.resource_id===c.body.resource_id)!;
   c.finish(Response.json(c.path.includes('/mutes/')?{target:item.target,muted:true,version:1,include_descendants:false}:item));}});
 const ready=async()=>{
   await act(async()=>{for(const c of calls.filter(c=>c.path.includes('/following/private?')))c.finish(Response.json(page));});
   await act(async()=>{for(const c of calls.filter(c=>c.path.endsWith('/previews')))c.finish(Response.json(previews));});
   await privateLookups();for(const d of document.querySelectorAll('details'))d.open=true;
 };
 const control=(i=0)=>within(document.querySelector(`[data-follow-target="artifact:${items[i]!.target.resource_id}"]`) as HTMLElement);
 return {calls,items,page,previews,ready,privateLookups,control,store};
}

test('a 25-row private page hydrates in bounded batches and recovery sends no metadata probes',async t=>{
 const f=mount(t,25);await f.ready();
 const batches=f.calls.filter(c=>c.path.endsWith('/previews'));assert.equal(batches.length,1,'only the accepted private page starts one bounded metadata batch');
 assert.ok(batches.every(c=>c.body.targets.length===25));assert.equal(screen.queryAllByText(/Private boundary title/).length,50);
 await act(async()=>fireEvent.click(f.control().getByRole('button',{name:'Unfollow'})));
 await f.privateLookups();const command=f.calls.find(c=>c.path.endsWith('/private/state'))!;assert.ok(command);
 await act(async()=>command.finish(Response.json({operation_state:'applied',operation_id:randomUUID(),idempotency:'created',outcome:{...f.items[0],expected_version:1,result_version:2,following:false,version:undefined},current:{...f.items[0],following:false,version:2}})));
 await f.privateLookups();assert.equal(f.calls.filter(c=>c.path.endsWith('/previews')).length,1);
 assert.equal(f.store.all().length,0);assert.ok(screen.getAllByText(/Explicit follow removed/).length);
});

for(const action of ['state','status','retry'] as const)test(`private ${action} confirms safe removal after withdrawal while old private reads cannot reauthorize`,async t=>{
 const f=mount(t);await f.ready();
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh following'})));const held=f.calls.at(-1)!;
 await act(async()=>fireEvent.click(f.control().getByRole('button',{name:'Unfollow'})));
 const first=f.calls.find(c=>c.path.endsWith('/private/state'))!,body=first.body;
 if(action!=='state'){
   await act(async()=>first.finish(Response.json({error:{code:'service_unavailable',message:'Unknown outcome',operation_outcome:'unknown'}},{status:503})));
   await act(async()=>fireEvent.click(f.control().getByRole('button',{name:action==='status'?'Check follow status':'Retry same follow change'})));
 }
 const pending=f.calls.filter(c=>c.path.endsWith(action==='status'?'/private/status':'/private/state')).at(-1)!;
 await act(async()=>fireEvent.click(f.control(1).getByRole('button',{name:'Refresh mute state'})));await f.privateLookups();
 const preview=f.calls.filter(c=>!c.done&&c.path.endsWith('/previews')).at(-1)!;
 await act(async()=>preview.finish(Response.json({items:[{target:f.items[1]!.target,source:{state:'unavailable'},other_current_scope_mutes:[]}]})));
 assert.equal(screen.queryAllByText(/Private boundary title/).length,0);
 const before=f.calls.filter(c=>c.path.endsWith('/previews')).length;
 await act(async()=>held.finish(Response.json(f.page)));await f.privateLookups();
 assert.equal(f.calls.filter(c=>c.path.endsWith('/previews')).length,before,'a pending private page cannot start fresh authorization after a denial');
 const {idempotency_key,...outcome}=body;
 await act(async()=>pending.finish(Response.json({operation_state:'applied',operation_id:randomUUID(),idempotency:action==='state'?'created':'replayed',outcome:{...outcome,result_version:2},current:{...f.items[0],following:false,version:2}})));
 await f.privateLookups();assert.equal(f.store.all().length,0);assert.ok(screen.getAllByText(/Explicit follow removed/).length);
 assert.equal(screen.queryAllByText(/Private boundary title/).length,0);assert.equal(f.calls.filter(c=>c.path.endsWith('/previews')).length,before);
 assert.equal(f.control(1).getByRole('button',{name:'Unfollow'}).hasAttribute('disabled'),false);
});

test('preview service failure preserves freshly loaded private removal controls and reports the failure',async t=>{
 const f=mount(t);
 await act(async()=>{for(const c of f.calls.filter(c=>c.path.includes('/following/private?')))c.finish(Response.json(f.page));});
 await act(async()=>{for(const c of f.calls.filter(c=>c.path.endsWith('/previews')))c.finish(Response.json({error:{code:'service_unavailable',message:'Preview service unavailable'}},{status:503}));});
 await f.privateLookups();
 assert.ok(screen.getAllByText('Preview service unavailable').length);
 assert.equal(f.control().getByRole('button',{name:'Unfollow'}).hasAttribute('disabled'),false);
 assert.equal(screen.queryAllByText(/Private boundary title/).length,0);
});
