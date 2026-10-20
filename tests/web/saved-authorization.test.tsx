import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode,useState} from 'react';
import {MemoryRouter} from 'react-router';
import {AuthorizationBoundary,useAuthorization,type AuthorizedValue} from '../../src/web/AuthorizationBoundary.js';
import {IntentStore,invalidateIdentity,commandRequest,type Self} from '../../src/web/participation-client.js';
import {SaveControl,SavedItemsPage} from '../../src/web/SavedItems.js';
import * as S from '../../src/contracts/saved-items.js';
import * as R from '../../src/contracts/reading.js';
import {Page} from '../../src/contracts/participation.js';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent'] as const)
 Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
const {render,screen,fireEvent,cleanup,act,waitFor}=await import('@testing-library/react');
afterEach(()=>{cleanup();invalidateIdentity();localStorage.clear();});
const base='/api/v1/me/saved-items';
const emptyPage={items:[],scope:'artifacts',representation:'metadata',omitted_detail:'bodies',next_cursor:null,complete:true,
 work_budget_reached:false,limit:12,max_response_bytes:131072};
const target={kind:'discussion' as const,resource_id:randomUUID()},self={participant_id:randomUUID(),csrf:'fixture'} as Self;
const unavailable={target,saved:true,version:1,source:{state:'unavailable' as const}};
const person={id:randomUUID(),nickname:'Reader',kind:'human' as const};
const available:S.SavedItemView={target:{kind:'artifact',resource_id:randomUUID()},saved:true,version:1,source:{state:'available',observed_revision_id:null,
 resource:{resource_id:randomUUID(),kind:'artifact',title:'Fresh authorized source',revision_id:randomUUID(),revision_number:'1',author:person,publisher:person,
  created_at:'2026-10-20T00:00:00Z',area_id:randomUUID(),area_title:'Topic',discussion_id:null,parent_id:null,can_edit:false,publication_open:true,full_content_url:'/api/v1/resources/source'}}};
const savedPage=(items:S.SavedItemView[]):S.SavedPageView=>({items,next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',scope:'own_saved_items',representation:'currently_authorized_metadata',limit:12,max_response_bytes:131072});
const result=(conflict=false)=>({operation_state:conflict?'version_conflict':'applied',idempotency:'replayed',operation_id:randomUUID(),
 outcome:{target,saved:false,expected_version:1,result_version:2},current:{...unavailable,saved:false,version:2}});
const hosts=[['area','withdraw'],['discussion','projections'],['resource','withdraw'],['overview','withdraw'],
 ['following','settings'],['updates','withdraw'],['notifications','withdraw'],['attention','settings']] as const;

for(const [host,sourcePolicy] of hosts)for(const path of ['lookup','list','state','status','replay','conflict'] as const)
test(`${host}: Saved ${path} success consumes source denial and fences pending content`,async t=>{
 const calls:{path:string;resolve:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string)=>new Promise<Response>(resolve=>calls.push({path,resolve})));
 let authority!:ReturnType<typeof useAuthorization>,settled=false;
 function Reader(){authority=useAuthorization();return <button onClick={()=>{
  const pending=path==='lookup'?authority.read(base+'/lookup',{body:target,self,schema:S.SavedItem}):
   path==='list'?authority.read(base,{schema:S.SavedPage}):authority.savedCommand({idempotency_key:randomUUID()},path==='status'?'status':'state',self);
  void pending.then(()=>{settled=true;},()=>{});
 }}>Saved operation</button>;}
 function Sibling(){const a=useAuthorization(),[shown,setShown]=useState(false);return <><p>Settled protected body</p>
  <button onClick={()=>void a.read('/api/v1/artifacts',{schema:Page}).then(()=>setShown(true),()=>{})}>Pending read</button>
  {shown&&<p>Late protected body</p>}</>;}
 render(<StrictMode><AuthorizationBoundary scope={host} sourcePolicy={sourcePolicy}><Reader/></AuthorizationBoundary>
  <AuthorizationBoundary scope="sibling"><Sibling/></AuthorizationBoundary></StrictMode>);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Pending read'})));const sibling=calls.at(-1)!;
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Saved operation'})));
 const value=path==='lookup'?unavailable:path==='list'?{items:[unavailable],next_cursor:null,complete:true,collection_version:1,
  ordering:'stable_target_id',scope:'own_saved_items',representation:'currently_authorized_metadata',limit:12,max_response_bytes:131072}:result(path==='conflict');
 await act(async()=>calls.at(-1)!.resolve(Response.json(value)));
 assert.equal(!!screen.queryByText('Settled protected body'),false);
 await act(async()=>sibling.resolve(Response.json(emptyPage)));
 assert.equal(!!screen.queryByText('Late protected body'),false);
 if(!['lookup','list'].includes(path))assert.equal(settled,true,'A private receipt must settle despite withdrawal.');
});

test('production Unsave withdraws before a blocked journal settlement, then retires the exact command',async t=>{
 const store=new IntentStore(randomUUID(),self.participant_id),context={self,store};
 const calls:{path:string;body:unknown;resolve:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string,options:RequestInit)=>new Promise<Response>(resolve=>calls.push({path,body:options.body?JSON.parse(String(options.body)):undefined,resolve})));
 render(<StrictMode><MemoryRouter><AuthorizationBoundary><p>Protected discussion body</p>
  <SaveControl context={context} target={target} label="discussion"/>
 </AuthorizationBoundary></MemoryRouter></StrictMode>);
 const resource={resource_id:randomUUID(),kind:'contribution',title:'Title',revision_id:randomUUID(),revision_number:'1',
  author:{id:randomUUID(),nickname:'Author',kind:'human'},publisher:{id:randomUUID(),nickname:'Publisher',kind:'human'},created_at:'2026-10-20T00:00:00Z',
  area_id:randomUUID(),area_title:'Area',discussion_id:target.resource_id,parent_id:null,can_edit:false,publication_open:true,full_content_url:'/api/v1/resources/source'};
 await act(async()=>{for(const call of calls)call.resolve(Response.json({...unavailable,source:{state:'available',resource,observed_revision_id:null}}));});
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Unsave discussion'})));
 await waitFor(()=>assert.ok(calls.some(c=>c.path.endsWith('/state'))));
 const dispatched=calls.find(c=>c.path.endsWith('/state'))!,frozen=structuredClone(store.all()[0]);
 let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
 t.mock.method(navigator.locks,'request',async(_name:string,work:()=>unknown)=>{await blocked;return work();});
 try{
  await act(async()=>dispatched.resolve(Response.json(result())));
  assert.equal(!!screen.queryByText('Protected discussion body'),false);
  assert.deepEqual(store.all(),[frozen]);assert.deepEqual(dispatched.body,frozen!.body);
 }finally{await act(async()=>release());}
 await waitFor(()=>assert.equal(store.all().length,0));
 await act(async()=>{for(const call of calls.filter(c=>c.path.endsWith('/lookup')))call.resolve(Response.json(unavailable));});
 assert.equal(!!screen.queryByText('Protected discussion body'),false);
});

test('a fresh mixed response preserves only its own projection; old content, late responses and repeated denials remain fenced',async t=>{
 const calls:((response:Response)=>void)[]=[];t.mock.method(globalThis,'fetch',()=>new Promise<Response>(resolve=>calls.push(resolve)));
 function Projections(){const a=useAuthorization(),[old,setOld]=useState<AuthorizedValue<S.SavedPageView>>(),[fresh,setFresh]=useState<AuthorizedValue<S.SavedPageView>>();
  const renderValue=(v:typeof old,label:string)=>v&&a.current(v.generation)&&<p>{label}: {v.value.items[0]?.source.state==='available'?v.value.items[0].source.resource.title:'Unavailable'}</p>;
  return <><button onClick={()=>void a.readProjection<S.SavedPageView>(base,{schema:S.SavedPage}).then(setOld,()=>{})}>Old request</button>
   <button onClick={()=>void a.readProjection<S.SavedPageView>(base,{schema:S.SavedPage}).then(setFresh,()=>{})}>Mixed request</button>
   {renderValue(old,'Old')}{renderValue(fresh,'Fresh')}</>;}
 render(<StrictMode><AuthorizationBoundary sourcePolicy="settings"><Projections/></AuthorizationBoundary>
  <AuthorizationBoundary><p>Older sibling body</p></AuthorizationBoundary></StrictMode>);
 await act(async()=>fireEvent.click(screen.getByText('Old request')));await act(async()=>calls[0]!(Response.json(savedPage([available]))));
 assert.ok(screen.queryByText('Old: Fresh authorized source'));
 await act(async()=>fireEvent.click(screen.getByText('Old request')));const late=calls.at(-1)!;
 await act(async()=>fireEvent.click(screen.getByText('Mixed request')));
 await act(async()=>calls.at(-1)!(Response.json(savedPage([available,unavailable]))));
 assert.ok(screen.queryByText('Fresh: Fresh authorized source'));
 assert.equal(!!screen.queryByText('Old: Fresh authorized source'),false);assert.equal(!!screen.queryByText('Older sibling body'),false);
 await act(async()=>late(Response.json(savedPage([available]))));assert.equal(!!screen.queryByText('Old: Fresh authorized source'),false);
 await act(async()=>fireEvent.click(screen.getByText('Old request')));
 await act(async()=>calls.at(-1)!(Response.json({error:{code:'unavailable',message:'Source denied'}},{status:404})));
 assert.equal(!!screen.queryByText('Fresh: Fresh authorized source'),false);
});

test('Saved mixed page keeps safe Unsave while an unrelated denial removes only metadata',async t=>{
 const calls:{path:string;resolve:(response:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string)=>new Promise<Response>(resolve=>calls.push({path,resolve})));
 const context={self,store:new IntentStore(randomUUID(),self.participant_id)};
 function Deny(){const a=useAuthorization();return <button onClick={()=>void a.read('/api/v1/guide').catch(()=>{})}>Deny elsewhere</button>;}
 render(<StrictMode><MemoryRouter><SavedItemsPage context={context}/><AuthorizationBoundary sourcePolicy="settings"><Deny/></AuthorizationBoundary></MemoryRouter></StrictMode>);
 // StrictMode's first request has no positive publication authority.
 await act(async()=>{for(const c of calls)c.resolve(Response.json(savedPage([available,unavailable])));});
 // A stale denial still revokes; use the explicit fresh collection action.
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh collection'})));
 await act(async()=>calls.at(-1)!.resolve(Response.json(savedPage([available,unavailable]))));
 assert.ok(screen.queryByText('Fresh authorized source'));assert.equal(screen.getAllByRole('button',{name:'Unsave'}).length,2);
 assert.equal(calls.filter(c=>c.path.endsWith('/lookup')).length,0,'Mounting safe controls must not rehydrate metadata.');
 await act(async()=>fireEvent.click(screen.getByText('Deny elsewhere')));
 await act(async()=>calls.at(-1)!.resolve(Response.json({error:{code:'unavailable',message:'Source denied'}},{status:404})));
 assert.equal(!!screen.queryByText('Fresh authorized source'),false);
 for(const button of screen.getAllByRole('button',{name:'Unsave'}))assert.equal((button as HTMLButtonElement).disabled,false);
});

for(const [host,sourcePolicy] of hosts)for(const path of ['lookup','state','status'] as const)
test(`${host}: Reading ${path} consumes a successful negative observation without losing its private receipt`,async t=>{
 const calls:((response:Response)=>void)[]=[];t.mock.method(globalThis,'fetch',()=>new Promise<Response>(resolve=>calls.push(resolve)));
 let settled=false;
 const item={resource_id:randomUUID(),revision_id:randomUUID(),read:false,version:0,availability:'unavailable'};
 function Read(){const a=useAuthorization();return <button onClick={()=>{
  const pending=path==='lookup'?a.read('/api/v1/me/reading/lookup',{body:{targets:[item]},self,schema:R.ReadingPage}):
   commandRequest('/api/v1/me/reading/'+path,{body:{idempotency_key:randomUUID()},self,schema:R.ReadingStatus});
  void pending.then(()=>{settled=true;},()=>{});
 }}>Reading request</button>;}
 render(<StrictMode><AuthorizationBoundary sourcePolicy={sourcePolicy} scope={host}><Read/></AuthorizationBoundary>
  <AuthorizationBoundary><p>Protected reading body</p></AuthorizationBoundary></StrictMode>);
 await act(async()=>fireEvent.click(screen.getByText('Reading request')));
 const value=path==='lookup'?{items:[item],scope:'own_exact_revisions'}:{operation_state:'applied',idempotency:'replayed',operation_id:randomUUID(),
  outcome:{basis:'manual',episode_id:null,targets:[{resource_id:item.resource_id,revision_id:item.revision_id,read:false,expected_version:0,result_version:1}]},current:[{...item,version:1}]};
 await act(async()=>calls.at(-1)!(Response.json(value)));
 assert.equal(!!screen.queryByText('Protected reading body'),false);
 if(path!=='lookup')assert.equal(settled,true);
});
