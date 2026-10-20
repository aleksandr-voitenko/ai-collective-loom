import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode,useState} from 'react';
import {AuthorizationBoundary,useAuthorization,type AuthorizedValue} from '../../src/web/AuthorizationBoundary.js';
import * as A from '../../src/contracts/attention.js';
import * as F from '../../src/contracts/following.js';
import * as P from '../../src/contracts/private-controls.js';
import type {Self} from '../../src/web/participation-client.js';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','Event','CustomEvent'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
const {render,screen,fireEvent,cleanup,act}=await import('@testing-library/react');
afterEach(cleanup);
const self={participant_id:randomUUID(),csrf:'fixture'} as Self;
const a={kind:'artifact' as const,resource_id:randomUUID()},b={kind:'artifact' as const,resource_id:randomUUID()},parent={kind:'area' as const,resource_id:randomUUID()};
const available=(target:F.FollowTargetView,ancestor=randomUUID()):P.PreviewItemView=>({target,source:{state:'available',title:target===a?'Resolved A':'Pending B',path:[{id:ancestor,title:'Protected ancestor'}],browser_url:'/source'},other_current_scope_mutes:[]});
const unavailable={target:parent,source:{state:'unavailable'},other_current_scope_mutes:[]};
const settings={target:parent,include_descendants:false,preferences:['artifact_revisions'],following:true,version:1};
const failures=['preview result','preview refusal','legacy Follow lookup','legacy mute lookup','private Follow state','legacy Follow status','legacy mute retry','unknown refusal'] as const;
type Failure=typeof failures[number];
function Departing({failure}:{failure:Failure}){
 const authority=useAuthorization();
 async function read(){
  try{
   const command={target:parent,include_descendants:false,preferences:['artifact_revisions' as const],following:true,expected_version:1,idempotency_key:randomUUID()};
   if(failure==='preview result'||failure==='preview refusal')await authority.previews([parent],self);
   else if(failure==='legacy Follow lookup')await authority.followingLookup(parent,self);
   else if(failure==='legacy mute lookup')await authority.read('/api/v1/me/attention/mutes/lookup',{body:parent,self,schema:A.MuteItem});
   else if(failure==='private Follow state')await authority.followingCommand(command,'state',self,P.privateControlsContract);
   else if(failure==='legacy Follow status')await authority.followingCommand(command,'status',self);
   else if(failure==='legacy mute retry')await authority.attentionCommand({kind:'mute',body:{target:parent,include_descendants:false,muted:true,expected_version:1,idempotency_key:randomUUID()}},true,self);
   else await authority.read('/api/v1/guide');
  }catch{/* The departed view has no UI to update. Its evidence must still count. */}
 }
 return <button onClick={()=>void read()}>Start ancestor read</button>;
}
function Current({opaque=false}:{opaque?:boolean}){
 const authority=useAuthorization(),[leases,setLeases]=useState<Record<string,number|undefined>>({}),[body,setBody]=useState<AuthorizedValue<{text:string}>>();
 async function load(target:F.FollowTargetView){try{const generation=await authority.previewLookup(target,self,true);setLeases(previous=>({...previous,[target.resource_id]:generation}));}catch{}}
 return <>
  <button onClick={()=>void load(a)}>Load A</button><button onClick={()=>void load(b)}>Load B</button>
  {opaque&&<button onClick={()=>void authority.readAuthorized<{text:string}>('/api/v1/guide').then(setBody,()=>{})}>Load body</button>}
  {body&&authority.current(body.generation)&&<p>{body.value.text}</p>}{[a,b].map(target=>{const source=authority.preview(target,leases[target.resource_id])?.source;return source?.state==='available'?<p key={target.resource_id}>{source.title}</p>:null;})}
 </>;
}
const hosts=[['area','withdraw'],['discussion','projections'],['resource','withdraw'],['overview','withdraw'],['following','settings'],['updates','withdraw'],['notifications','withdraw'],['attention','settings']] as const;
for(const [host,sourcePolicy] of hosts)for(const failure of failures)for(const arrival of ['pending','settled'] as const)
test(`${host} boundary withdraws ${arrival} siblings after departed ${failure}`,async t=>{
 const calls:{path:string;body:any;resolve:(value:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string,options:any)=>new Promise<Response>(resolve=>calls.push({path,body:options.body?JSON.parse(options.body):undefined,resolve})));
 function Frame(){const [departed,setDeparted]=useState(false);return <>
  {!departed&&<AuthorizationBoundary scope={'departing:'+randomUUID()} sourcePolicy="settings"><Departing failure={failure}/></AuthorizationBoundary>}
  <button onClick={()=>setDeparted(true)}>Depart</button>
  <AuthorizationBoundary scope={host} sourcePolicy={sourcePolicy}><Current/></AuthorizationBoundary>
 </>;}
 render(<StrictMode><Frame/></StrictMode>);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Start ancestor read'})));const denial=calls.shift()!;
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Depart'})));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Load A'})));
 await act(async()=>calls.shift()!.resolve(Response.json({items:[available(a)]})));
 assert.ok(screen.queryByText('Resolved A'));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Load B'})));const held=calls.shift()!;
 // Both paths can be stale after a move. Even apparently disjoint, fully
 // settled previews must withdraw; a pending response must never restore them.
 const heldResponse=Response.json({items:[available(b)]});
 if(arrival==='settled'){await act(async()=>held.resolve(heldResponse));assert.ok(screen.queryByText('Pending B'));}
 const receipt={operation_state:'applied',operation_id:randomUUID(),idempotency:'replayed'};
 let response:Response;
 if(failure==='preview result')response=Response.json({items:[unavailable]});
 else if(failure==='legacy Follow lookup')response=Response.json({...settings,source:{state:'unavailable'}});
 else if(failure==='legacy mute lookup')response=Response.json({...unavailable,include_descendants:false,muted:true,version:1});
 else if(failure==='legacy Follow status')response=Response.json({...receipt,outcome:{...denial.body,target:parent,include_descendants:false,preferences:['artifact_revisions'],following:true,expected_version:1,result_version:2,idempotency_key:undefined},current:{...settings,source:{state:'unavailable'}}});
 else if(failure==='legacy mute retry')response=Response.json({...receipt,policy_version:2,kind:'mute',outcome:{target:parent,include_descendants:false,muted:true,expected_version:1,result_version:2},current:{...unavailable,include_descendants:false,muted:true,version:2}});
 else response=Response.json({error:{code:'unavailable',message:'Ancestor unavailable'}},{status:404});
 await act(async()=>denial.resolve(response));if(arrival==='pending')await act(async()=>held.resolve(heldResponse));
 assert.equal(!!screen.queryByText('Resolved A'),false);assert.equal(!!screen.queryByText('Pending B'),false);
});

test('an opaque displayed projection stays unknown after a separate preview completes',async t=>{
 const calls:{path:string;resolve:(value:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string)=>new Promise<Response>(resolve=>calls.push({path,resolve})));
 render(<StrictMode><AuthorizationBoundary scope="old-opaque" sourcePolicy="settings"><Departing failure="legacy Follow lookup"/></AuthorizationBoundary>
  <AuthorizationBoundary scope="current-opaque" sourcePolicy="settings"><Current opaque/></AuthorizationBoundary></StrictMode>);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Start ancestor read'})));const denial=calls.shift()!;
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Load body'})));
 await act(async()=>calls.shift()!.resolve(Response.json({text:'Opaque protected content'})));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Load A'})));
 await act(async()=>calls.shift()!.resolve(Response.json({items:[available(a)]})));
 await act(async()=>denial.resolve(Response.json({...settings,source:{state:'unavailable'}})));
 assert.equal(!!screen.queryByText('Resolved A'),false);assert.equal(!!screen.queryByText('Opaque protected content'),false);
});
