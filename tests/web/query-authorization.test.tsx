import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode,useState} from 'react';
import {AuthorizationBoundary,useAuthorization} from '../../src/web/AuthorizationBoundary.js';
import {useQuery} from '../../src/web/participation-state.js';
import {invalidateIdentity,type Self} from '../../src/web/participation-client.js';
import {Revision,Page} from '../../src/contracts/participation.js';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','Event','CustomEvent'] as const)
 Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
const {render,screen,fireEvent,cleanup,act}=await import('@testing-library/react');
afterEach(()=>{cleanup();invalidateIdentity();});
const target={kind:'artifact' as const,resource_id:randomUUID()},self={participant_id:randomUUID()} as Self;
const hosts=[['area','withdraw'],['discussion','projections'],['resource','withdraw'],['overview','withdraw'],['following','settings'],['updates','withdraw'],['notifications','withdraw'],['attention','settings']] as const;
const cases=[
 {name:'collection source denial',path:'/api/v1/areas/'+randomUUID()+'/artifacts',schema:Page,code:'unavailable',scope:undefined,withdraw:true},
 {name:'history source denial',path:'/api/v1/resources/'+target.resource_id+'/history',schema:Page,code:'unavailable',scope:undefined,withdraw:true},
 {name:'unclassified exact denial',path:'/api/v1/resources/'+target.resource_id+'/revisions/'+randomUUID(),schema:Revision,code:'unavailable',scope:undefined,withdraw:true},
 {name:'classified current revision miss',path:'/api/v1/resources/'+target.resource_id,schema:Revision,code:'unavailable',scope:'revision',withdraw:false},
 {name:'classified exact revision miss',path:'/api/v1/resources/'+target.resource_id+'/revisions/'+randomUUID(),schema:Revision,code:'unavailable',scope:'revision',withdraw:false},
 {name:'invalid history continuation',path:'/api/v1/resources/'+target.resource_id+'/history?cursor=expired',schema:Page,code:'invalid_cursor',scope:undefined,withdraw:false},
 {name:'revision hint on ordinary collection',path:'/api/v1/areas/'+randomUUID()+'/artifacts',schema:Page,code:'unavailable',scope:'revision',withdraw:true},
 {name:'owner denial despite revision hint',path:'/api/v1/resources/'+target.resource_id,schema:Revision,code:'invalid_actor',scope:'revision',withdraw:true},
] as const;
for(const [host,sourcePolicy] of hosts)for(const scenario of cases)
test(`${host}: query ${scenario.name} separates revocation from local recovery`,async t=>{
 const calls:{path:string;resolve:(value:Response)=>void;done:boolean}[]=[];
 t.mock.method(globalThis,'fetch',(path:string)=>new Promise<Response>(resolve=>{
  const call={path,done:false,resolve:(r:Response)=>{call.done=true;resolve(r);}};calls.push(call);
 }));
 t.after(async()=>act(async()=>{for(const c of calls)if(!c.done)c.resolve(Response.json({error:{code:'service_unavailable',message:'Cleanup'}},{status:503}));}));
 function Query(){const result=useQuery(scenario.path,scenario.schema);return <>{result.error&&<p>Local read failed</p>}</>;}
 function Content(){const a=useAuthorization(),[lease,setLease]=useState<number>();const source=a.preview(target,lease)?.source;
  return <><button onClick={()=>void a.previews([target],self).then(setLease,()=>{})}>Load sibling</button>
   {source?.state==='available'&&<p>{source.title}</p>}</>;}
 render(<StrictMode><AuthorizationBoundary scope="query"><Query/></AuthorizationBoundary>
  <AuthorizationBoundary scope={host} sourcePolicy={sourcePolicy}><Content/></AuthorizationBoundary></StrictMode>);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Load sibling'})));
 const preview=()=>Response.json({items:[{target,source:{state:'available',title:'Protected sibling',path:[],browser_url:'/source'},other_current_scope_mutes:[]}]});
 await act(async()=>calls.find(c=>c.path.endsWith('/previews'))!.resolve(preview()));
 assert.ok(screen.queryByText('Protected sibling'));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Load sibling'})));
 const pending=calls.at(-1)!;
 // StrictMode's aborted request can still deliver evidence; both copies use
 // the same classification and must not depend on the hook's mounted state.
 await act(async()=>{for(const c of calls.filter(c=>c.path===scenario.path))c.resolve(Response.json({error:{code:scenario.code,message:'Read unavailable',...(scenario.scope?{unavailable_scope:scenario.scope}:{})}},{status:scenario.code==='invalid_actor'?401:404}));});
 await act(async()=>pending.resolve(preview()));
 assert.equal(!!screen.queryByText('Protected sibling'),!scenario.withdraw);
 assert.equal(!!screen.queryByText('Local read failed'),!scenario.withdraw);
});

test('a source denial after the query unmounts still withdraws a settled sibling',async t=>{
 const pending:((r:Response)=>void)[]=[];
 t.mock.method(globalThis,'fetch',()=>new Promise<Response>(resolve=>pending.push(resolve)));
 function Query(){useQuery('/api/v1/areas/'+randomUUID()+'/artifacts',Page);return null;}
 function Frame(){const [gone,setGone]=useState(false);return <><button onClick={()=>setGone(true)}>Leave</button>
  {!gone&&<AuthorizationBoundary scope="departing"><Query/></AuthorizationBoundary>}
  <AuthorizationBoundary scope="sibling"><p>Retained protected title</p></AuthorizationBoundary></>;}
 render(<StrictMode><Frame/></StrictMode>);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Leave'})));
 await act(async()=>{for(const resolve of pending)resolve(Response.json({error:{code:'unavailable',message:'Source unavailable'}},{status:404}));});
 assert.equal(!!screen.queryByText('Retained protected title'),false);
});

test('a traversal projection retains only its fresh structural response, fencing old bodies and pending pages',async t=>{
 const calls:{path:string;resolve:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string)=>new Promise<Response>(resolve=>calls.push({path,resolve})));
 function Traversal(){
  const [cursor,setCursor]=useState('');
  const body=useQuery<{text:string}>('/api/v1/guide');
  const page=useQuery<import('../../src/contracts/participation.js').PageView>('/api/v1/contributions/parent/children'+cursor,Page);
  return <>{body.data&&<p>{body.data.text}</p>}{page.data&&<p>Authorized structural marker</p>}
   <button onClick={body.refresh}>Refresh body</button><button onClick={page.refresh}>Refresh traversal</button>
   {page.data&&<button onClick={()=>setCursor('?cursor=next')}>Next traversal page</button>}</>;
 }
 render(<StrictMode><AuthorizationBoundary sourcePolicy="projections"><Traversal/></AuthorizationBoundary>
  <AuthorizationBoundary scope="older"><p>Older sibling</p></AuthorizationBoundary></StrictMode>);
 const response=()=>Response.json({items:[{resource_id:randomUUID(),state:'unavailable'}],scope:'children:parent',representation:'metadata',omitted_detail:'bodies',
  next_cursor:null,complete:true,work_budget_reached:false,limit:6,max_response_bytes:131072});
 // Resolve StrictMode's abandoned effect independently. The live mixed
 // response is the only response allowed to publish the structural marker.
 await act(async()=>{for(const c of calls.filter(c=>c.path.endsWith('guide')))c.resolve(Response.json({text:'Older body'}));});
 assert.ok(screen.queryByText('Older body'));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh body'})));const pending=calls.at(-1)!;
 const traversal=calls.filter(c=>c.path.endsWith('children'));
 await act(async()=>traversal[0]!.resolve(Response.json({error:{code:'service_unavailable',message:'Aborted effect'}},{status:503})));
 await act(async()=>traversal[1]!.resolve(response()));
 assert.equal(!!screen.queryByText('Older body'),false);assert.equal(!!screen.queryByText('Older sibling'),false);
 // A fresh explicit traversal checks its own fields without restoring anything
 // captured before that denial, including the response still in flight.
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh traversal'})));
 await act(async()=>calls.at(-1)!.resolve(response()));
 assert.ok(screen.queryByText('Authorized structural marker'));
 const count=calls.length;
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Next traversal page'})));
 assert.equal(calls.length,count+1,'Fresh authorized projections must retain their own traversal controls.');
 assert.ok(calls.at(-1)!.path.endsWith('?cursor=next'));
 await act(async()=>calls.at(-1)!.resolve(response()));
 assert.ok(screen.queryByText('Authorized structural marker'));
 await act(async()=>pending.resolve(Response.json({text:'Late body'})));
 assert.equal(!!screen.queryByText('Late body'),false);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh traversal'})));
 await act(async()=>calls.at(-1)!.resolve(Response.json({error:{code:'unavailable',message:'Discussion hidden'}},{status:404})));
 assert.equal(!!screen.queryByText('Authorized structural marker'),false);
 assert.ok(screen.queryAllByRole('button',{name:'Retry protected view'}).length>0);
});
