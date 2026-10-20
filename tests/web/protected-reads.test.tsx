import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode,useState} from 'react';
import {MemoryRouter} from 'react-router';
import {AuthorizationBoundary,useAuthorization} from '../../src/web/AuthorizationBoundary.js';
import {invalidateIdentity} from '../../src/web/participation-client.js';
import {ReferenceResults} from '../../src/web/References.js';
import {SourceResults} from '../../src/web/Summaries.js';
import {ChangeDiscoveryViewComponent} from '../../src/web/Changes.js';
import {Page} from '../../src/contracts/participation.js';
import {Value} from '@sinclair/typebox/value';
import * as P from '../../src/contracts/private-controls.js';
import {useQuery} from '../../src/web/participation-state.js';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','Event'] as const)
 Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
const {render,screen,fireEvent,cleanup,act}=await import('@testing-library/react');
afterEach(()=>{cleanup();invalidateIdentity();});

test('protected hooks require a boundary and private reads cannot be used as a metadata escape',async t=>{
 let fetched=0,authority!:ReturnType<typeof useAuthorization>;
 t.mock.method(globalThis,'fetch',async()=>{fetched++;return Response.json({});});
 function Bare(){useQuery('/api/v1/artifacts',Page);return null;}
 assert.throws(()=>render(<Bare/>),/require an AuthorizationBoundary/);
 function Capture(){authority=useAuthorization();return null;}
 render(<AuthorizationBoundary><Capture/></AuthorizationBoundary>);
 for(const [path,schema] of [['/api/v1/artifacts',Page],['/api/v1/me/attention/previews',P.PreviewPage],
  ['/api/v1/me/following/private',Page],['/api/v1/me/attention/private/list',P.PreviewPage]] as const)
  await assert.rejects(authority.privateRead(path,{schema}),/Protected reads require/);
 assert.equal(fetched,0);
});

// Exercise production readers, not substitute components calling the adapter.
for(const reader of ['references','summary sources','change discovery'] as const)
for(const departed of [false,true])test(`${reader}: a ${departed?'departed':'mounted'} reader denial withdraws settled and pending siblings`,async t=>{
 const calls:{path:string;resolve:(r:Response)=>void;done:boolean}[]=[];
 t.mock.method(globalThis,'fetch',(path:string)=>new Promise<Response>(resolve=>{
  const call={path,done:false,resolve:(r:Response)=>{call.done=true;resolve(r);}};calls.push(call);
 }));
 t.after(async()=>act(async()=>{for(const call of calls)if(!call.done)call.resolve(Response.json({error:{code:'service_unavailable',message:'Cleanup'}},{status:503}));}));
 function Pending(){const a=useAuthorization(),[value,setValue]=useState(false);return <>
  <p>Settled sibling body</p><button onClick={()=>void a.read('/api/v1/artifacts',{schema:Page}).then(()=>setValue(true),()=>{})}>Load sibling</button>
  {value&&<p>Late sibling body</p>}</>;}
 function Frame(){const [gone,setGone]=useState(false);return <>
  <button onClick={()=>setGone(true)}>Leave reader</button>
  {!gone&&<AuthorizationBoundary scope="production-reader"><p>Source page body</p>
   {reader==='references'?<ReferenceResults path="/api/v1/references/incoming?kind=artifact"/>:
    reader==='summary sources'?<SourceResults path="/api/v1/discussions/fixture/summary-sources"/>:
     <ChangeDiscoveryViewComponent kind="artifact" resource={randomUUID()}/>}
  </AuthorizationBoundary>}
  <AuthorizationBoundary scope="sibling"><Pending/></AuthorizationBoundary>
 </>;}
 render(<StrictMode><MemoryRouter><Frame/></MemoryRouter></StrictMode>);
 if(reader==='change discovery')await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Discover change explanations'})));
 assert.ok(calls.length>=2);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Load sibling'})));
 const pending=calls.at(-1)!;
 if(departed)await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Leave reader'})));
 await act(async()=>{for(const call of calls.filter(c=>c!==pending))call.resolve(Response.json({error:{code:'unavailable',message:'Source refused'}},{status:404}));});
 const available={items:[],scope:'artifacts',representation:'metadata',omitted_detail:'bodies',next_cursor:null,complete:true,
  work_budget_reached:false,limit:12,max_response_bytes:131072};
 assert.equal(Value.Check(Page,available),true,'The pending success must be a valid protected response.');
 await act(async()=>pending.resolve(Response.json(available)));
 assert.equal(!!screen.queryByText('Source page body'),false);
 assert.equal(!!screen.queryByText('Settled sibling body'),false);
 assert.equal(!!screen.queryByText('Late sibling body'),false);
});
