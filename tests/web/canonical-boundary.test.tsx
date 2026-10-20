import assert from 'node:assert/strict';
import {afterEach,test,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode,useState} from 'react';
import {MemoryRouter} from 'react-router';
import {Value} from '@sinclair/typebox/value';
import {AuthorizationBoundary,useAuthorization} from '../../src/web/AuthorizationBoundary.js';
import {IntentStore,type Self} from '../../src/web/participation-client.js';
import {AttentionRecovery} from '../../src/web/attention-recovery.js';
import {FollowControl} from '../../src/web/Following.js';
import {MuteControl,DismissControl,AttentionPage} from '../../src/web/Attention.js';
import type {Context} from '../../src/web/participation-state.js';
import * as A from '../../src/contracts/attention.js';
import * as F from '../../src/contracts/following.js';
import * as P from '../../src/contracts/private-controls.js';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent'] as const)
 Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_key:string,work:()=>unknown)=>work()},configurable:true});
const {render,screen,within,fireEvent,cleanup,act}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});
const self={participant_id:randomUUID(),csrf:'fixture'} as Self;
const lower='12345678-abcd-1234-abcd-123456789abc',upper=lower.toUpperCase();
const child={kind:'artifact' as const,resource_id:'abcdefab-1234-abcd-1234-abcdefabcdef'};
const available=(target:F.FollowTargetView,ancestor?:string):P.PreviewItemView=>({target,source:{state:'available',title:'Protected case alias',path:ancestor?[{id:ancestor,title:'Protected parent'}]:[],browser_url:'/source'},other_current_scope_mutes:[]});
type Authority=ReturnType<typeof useAuthorization>;
function Probe({target,capture}:{target:F.FollowTargetView;capture:(authority:Authority)=>void}){
 const authority=useAuthorization(),[lease,setLease]=useState<number>();capture(authority);
 const source=authority.preview(target,lease)?.source;
 return <><button onClick={()=>void authority.previewLookup(target,self,true).then(setLease,()=>{})}>Load preview</button>
  {source?.state==='available'&&<p>{source.title}</p>}</>;
}
function controlledFetch(t:TestContext){
 const calls:{path:string;raw:string|undefined;done:boolean;resolve:(value:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string,options:any)=>new Promise<Response>(resolve=>{
  const call={path,raw:options?.body as string|undefined,done:false,resolve:(value:Response)=>{call.done=true;resolve(value);}};calls.push(call);
 }));
 t.after(async()=>act(async()=>{for(const call of calls)if(!call.done)call.resolve(Response.json({error:{code:'service_unavailable',message:'Test cleanup'}},{status:503}));}));
 return calls;
}
const producers=['preview result','preview refusal','Follow lookup','mute lookup','Follow page','mute list',
 'Follow state','Follow status','private Follow state','private Follow status','mute retry','mute status','private mute retry','private mute status'] as const;

for(const producer of producers)for(const relationship of ['target','ancestor','disjoint'] as const)for(const reverse of [false,true])
test(`mixed-case ${producer} withdraws a settled ${relationship} projection after departure, reversed=${reverse}`,async t=>{
 const ancestor=relationship==='ancestor',calls=controlledFetch(t),requestTarget={kind:ancestor?'area' as const:'artifact' as const,resource_id:reverse?lower:upper},
  responseTarget={...requestTarget,resource_id:reverse?upper:lower},target=relationship==='target'?responseTarget:child;
 const store=new IntentStore(randomUUID(),self.participant_id),journal=new AttentionRecovery(store.instance,self.participant_id);
 const draft=store.create('following:'+requestTarget.kind+':'+requestTarget.resource_id,'following.set','/api/v1/me/following/state',
  {target:requestTarget,following:true,include_descendants:false,preferences:['artifact_revisions'],expected_version:1});
 const saved=await store.prepareDispatch(draft,draft.body),follow=saved.body as F.FollowUpdateInput;
 const mute=await journal.save({kind:'mute',body:{target:requestTarget,muted:true,include_descendants:false,expected_version:1,idempotency_key:randomUUID().toUpperCase()}},()=>true);
 const before=JSON.stringify(Object.entries(localStorage)),followBytes=JSON.stringify(follow),muteBytes=JSON.stringify(mute.command.body);
 let departed!:Authority;
 function Departed(){departed=useAuthorization();return null;}
 function Frame(){const [gone,setGone]=useState(false);return <>
  {!gone&&<AuthorizationBoundary scope={'old:'+producer} sourcePolicy="settings"><Departed/></AuthorizationBoundary>}
  <button onClick={()=>setGone(true)}>Depart</button>
  <AuthorizationBoundary scope="following" sourcePolicy="settings"><Probe target={target} capture={()=>{}}/></AuthorizationBoundary>
 </>;}
 render(<StrictMode><Frame/></StrictMode>);
 let pending!:Promise<unknown>;
 await act(async()=>{
  const projection=producer.startsWith('private ')?P.privateControlsContract:undefined;
  let work:Promise<unknown>;
  if(producer.startsWith('preview'))work=departed.previews([requestTarget],self);
  else if(producer==='Follow lookup')work=departed.followingLookup(requestTarget,self);
  else if(producer==='mute lookup')work=departed.read('/api/v1/me/attention/mutes/lookup',{body:requestTarget,self,schema:A.MuteItem});
  else if(producer==='Follow page')work=departed.followingPage();
  else if(producer==='mute list')work=departed.read('/api/v1/me/attention/list',{body:{collection:'mutes'},self,schema:A.AttentionList});
  else if(producer.includes('Follow'))work=departed.followingCommand(follow,producer.endsWith('status')?'status':'state',self,projection);
  else work=departed.attentionCommand(mute.command,!producer.endsWith('status'),self,projection);
  pending=work.catch(()=>{});
 });
 const refusal=calls[0]!;
 if(producer.endsWith('state'))assert.equal(refusal.raw,followBytes);
 if(producer.endsWith('retry'))assert.equal(refusal.raw,muteBytes);
 if(producer.endsWith('status'))assert.equal(refusal.raw,JSON.stringify({idempotency_key:producer.includes('Follow')?follow.idempotency_key:mute.command.body.idempotency_key}));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Depart'})));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Load preview'})));
 const page={items:[available(target,ancestor?responseTarget.resource_id:undefined)]};assert.ok(Value.Check(P.PreviewPage,page));
 await act(async()=>calls[1]!.resolve(Response.json(page)));assert.ok(screen.queryByText('Protected case alias'));
 // Every preview has settled. A cached path (including a disjoint one) cannot
 // prove current ancestry, and no pending sibling can mask that requirement.
 const followItem={target:requestTarget,include_descendants:false,preferences:['artifact_revisions'],following:true,version:2,source:{state:'unavailable'}};
 const muteItem={target:requestTarget,include_descendants:false,muted:true,version:2,source:{state:'unavailable'},other_current_scope_mutes:[]};
 const receipt={operation_state:'applied',operation_id:randomUUID(),idempotency:'replayed'};
 let value:unknown,schema:any;
 if(producer==='preview result'){value={items:[{target:requestTarget,source:{state:'unavailable'},other_current_scope_mutes:[]}]};schema=P.PreviewPage;}
 else if(producer==='Follow lookup'){value=followItem;schema=F.FollowItem;}
 else if(producer==='mute lookup'){value=muteItem;schema=A.MuteItem;}
 else if(producer==='Follow page'){value={items:[followItem],next_cursor:null,complete:true,collection_version:1,ordering:'stable_target_id',limit:12,max_response_bytes:131072};schema=F.FollowPage;}
 else if(producer==='mute list'){value={collection:'mutes',mutes:[muteItem],dismissals:[],policy_version:2,next_cursor:null,complete:true};schema=A.AttentionList;}
 else if(producer==='Follow state'||producer==='Follow status'){
  const {idempotency_key,...outcome}=follow;value={...receipt,outcome:{...outcome,result_version:2},current:followItem};schema=F.FollowResult;
 }else if(producer==='mute retry'||producer==='mute status'){
  const {idempotency_key,...outcome}=mute.command.body;value={...receipt,kind:'mute',policy_version:2,outcome:{...outcome,result_version:2},current:muteItem};schema=A.MuteResult;
 }
 if(schema)assert.ok(Value.Check(schema,value),JSON.stringify([...Value.Errors(schema,value)]));
 await act(async()=>{refusal.resolve(schema?Response.json(value):Response.json({error:{code:'unavailable',message:'Current source unavailable'}},{status:404}));await pending;});
 assert.equal(!!screen.queryByText('Protected case alias'),false);
 assert.equal(JSON.stringify(Object.entries(localStorage)),before,'boundary comparisons must not rewrite saved records');
 assert.equal(JSON.stringify(follow),followBytes);assert.equal(JSON.stringify(mute.command.body),muteBytes);
});

test('case aliases share queued, pending and cached previews without rewriting transport targets',async t=>{
 const calls=controlledFetch(t),target={kind:'artifact' as const,resource_id:upper},alias={...target,resource_id:lower};let authority!:Authority;
 render(<StrictMode><AuthorizationBoundary sourcePolicy="settings"><Probe target={target} capture={value=>{authority=value;}}/></AuthorizationBoundary></StrictMode>);
 let first!:Promise<number|undefined>,second!:Promise<number|undefined>,third!:Promise<number|undefined>;
 await act(async()=>{first=authority.previewLookup(target,self);second=authority.previewLookup(alias,self);});
 assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0]!.raw!),{targets:[target]});
 await act(async()=>{third=authority.previewLookup(alias,self);});assert.equal(calls.length,1);
 await act(async()=>calls[0]!.resolve(Response.json({items:[available(alias)]})));
 const leases=await Promise.all([first,second,third]);assert.ok(leases.every(v=>v===leases[0]));assert.ok(authority.preview(target,leases[0]));
 await authority.previewLookup(target,self);await authority.previewLookup(alias,self);assert.equal(calls.length,1);
});

for(const lookup of ['Follow','mute'] as const)for(const denied of [false,true])
test(`overlapping ${lookup} aliases keep latest positives and still observe stale denials: denied=${denied}`,async t=>{
 const calls=controlledFetch(t),target={kind:'artifact' as const,resource_id:upper},alias={...target,resource_id:lower};let authority!:Authority;
 render(<StrictMode><AuthorizationBoundary sourcePolicy="settings"><Probe target={alias} capture={value=>{authority=value;}}/></AuthorizationBoundary></StrictMode>);
 const read=(value:F.FollowTargetView)=>lookup==='Follow'?authority.followingLookup(value,self):authority.readAuthorized('/api/v1/me/attention/mutes/lookup',{body:value,self,schema:A.MuteItem});
 const result=(title:string,unavailable=false)=>({...available(alias),source:unavailable?{state:'unavailable'}:{...available(alias).source,title},include_descendants:false,version:1,
  ...(lookup==='Follow'?{following:true,preferences:['artifact_revisions'],other_current_scope_mutes:undefined}:{muted:true})});
 let first!:Promise<unknown>,second!:Promise<unknown>;
 await act(async()=>{first=read(target).catch(()=>{});second=read(alias).catch(()=>{});});
 await act(async()=>{calls[1]!.resolve(Response.json(result('Newest preview')));await second;});
 await act(async()=>{calls[0]!.resolve(Response.json(result('Old preview',denied)));await first;});
 assert.equal(authority.preview(alias,authority.capture())?.source.state,denied?undefined:'available');
 if(!denied)assert.deepEqual(authority.preview(alias,authority.capture())?.source,{...available(alias).source,title:'Newest preview'});
});

for(const control of ['Follow','mute'] as const)test(`a ${control} case alias recovers the existing command before another choice, retaining saved bytes`,async t=>{
 const calls=controlledFetch(t),target={kind:'artifact' as const,resource_id:upper},alias={...target,resource_id:lower},store=new IntentStore(randomUUID(),self.participant_id),
  journal=new AttentionRecovery(store.instance,self.participant_id),context={self,store,community:{instance_id:store.instance},controlsProjection:P.privateControlsContract} as Context;
 const draft=store.create('following:artifact:'+upper,'following.set','/api/v1/me/following/state',
  {target,following:false,include_descendants:false,preferences:['artifact_revisions'],expected_version:1}),
  follow=await store.prepareDispatch(draft,draft.body),mute=await journal.save({kind:'mute',body:{target,muted:false,include_descendants:false,expected_version:1,idempotency_key:randomUUID().toUpperCase()}},()=>true),
  original=JSON.stringify(control==='Follow'?follow.body:mute.command.body),before=JSON.stringify(Object.entries(localStorage));
 render(<StrictMode><MemoryRouter><AuthorizationBoundary sourcePolicy="settings">
  {control==='Follow'?<FollowControl context={context} target={alias}/>:<MuteControl context={context} target={alias}/>}
 </AuthorizationBoundary></MemoryRouter></StrictMode>);
 await act(async()=>{for(const call of calls)call.resolve(Response.json({target:alias,include_descendants:false,version:1,
  ...(control==='Follow'?{following:true,preferences:['artifact_revisions']}:{muted:true})}));});
 await act(async()=>{for(const call of calls.filter(v=>!v.done))call.resolve(Response.json({items:[available(alias)]}));});
 assert.equal(!!screen.queryByRole('button',{name:control==='Follow'?'Check follow status':'Check attention outcome'}),true);
 if(control==='Follow')assert.equal(!!screen.queryByRole('button',{name:'Unfollow'}),false);
 else assert.equal(screen.getByRole('button',{name:'Unmute routine updates'}).getAttribute('aria-disabled'),'true');
 assert.equal(JSON.stringify(Object.entries(localStorage)),before);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:control==='Follow'?'Retry same follow change':'Retry same attention change'})));
 const retry=calls.find(v=>v.path.endsWith('/state'))!;assert.equal(retry.raw,original);
 assert.equal(JSON.stringify(control==='Follow'?store.all()[0]!.body:journal.all()[0]!.command.body),original);
 assert.equal(store.all()[0]!.slot,follow.slot,'saved legacy slots are not rewritten to the canonical comparison key');
});

test('the attention journal rejects an overlapping resource alias without rewriting the retained command',async()=>{
 const journal=new AttentionRecovery(randomUUID(),self.participant_id),body={target:{kind:'area' as const,resource_id:upper},muted:true,include_descendants:true,expected_version:0,idempotency_key:randomUUID()};
 await journal.save({kind:'mute',body},()=>true);const before=JSON.stringify(Object.entries(localStorage));
 await assert.rejects(journal.save({kind:'mute',body:{...body,target:{...body.target,resource_id:lower},idempotency_key:randomUUID()}},()=>true),/Resolve the existing attention change/);
 assert.equal(JSON.stringify(Object.entries(localStorage)),before);
});

for(const kind of ['shared_event','personal_delivery'] as const)for(const reverse of [false,true]){
 test(`dismissal journal compares ${kind} aliases, reversed=${reverse}, without changing saved bytes`,async()=>{
  const journal=new AttentionRecovery(randomUUID(),self.participant_id),id=reverse?lower:upper,alias=reverse?upper:lower;
  const command={kind:'dismissal' as const,body:{idempotency_key:randomUUID().toUpperCase(),inputs:[{kind,id,dismissed:true,expected_version:2}]}};
  await journal.begin(await journal.save(command,()=>true));const before=JSON.stringify(Object.entries(localStorage));
  await assert.rejects(journal.save({kind:'dismissal',body:{idempotency_key:randomUUID(),inputs:[{kind,id:alias,dismissed:false,expected_version:3}]}},()=>true),/Resolve the existing attention change/);
  assert.equal(JSON.stringify(Object.entries(localStorage)),before);
  // Shared events and personal deliveries are independent identity spaces.
  await journal.save({kind:'dismissal',body:{idempotency_key:randomUUID(),inputs:[{kind:kind==='shared_event'?'personal_delivery':'shared_event',id:alias,dismissed:true,expected_version:0}]}},()=>true);
  assert.deepEqual(journal.all()[0]!.command,command);
 });
 for(const surface of ['source','group','settings'] as const)
 test(`${surface} recovers ${kind} case aliases through status and exact retry, reversed=${reverse}`,async t=>{
  const id=reverse?lower:upper,alias=reverse?upper:lower,instance=randomUUID(),group=randomUUID();
  const journal=new AttentionRecovery(instance,self.participant_id),store=new IntentStore(instance,self.participant_id);
  const command={kind:'dismissal' as const,body:{idempotency_key:randomUUID().toUpperCase(),inputs:[{kind,id,dismissed:true,expected_version:2}]}};
  await journal.begin(await journal.save(command,()=>true));const original=JSON.stringify(command.body);
  const context={self,store,community:{instance_id:instance},controlsProjection:'private-controls-1',refreshCommunity:()=>{}} as Context;
  const calls:{path:string;raw:string}[]=[];
  t.mock.method(globalThis,'fetch',async(path:string,options:RequestInit)=>{
   calls.push({path,raw:String(options.body)});
   const item={kind,id:alias,dismissed:true,version:2};
   if(path.endsWith('/private/list')){
    const collection=JSON.parse(String(options.body)).collection;
    return Response.json({collection,mutes:[],dismissals:collection==='dismissals'?[item]:[],policy_version:2,next_cursor:null,complete:true});
   }
   if(path.endsWith('/selection'))return Response.json({selection:'opaque-selection',inputs:[{...item,availability:'available'}],policy_version:2,
    shared_events:kind==='shared_event'?1:0,personal_signals:kind==='personal_delivery'?1:0,membership:'exact_represented_inputs_including_unexpanded_direct_sources',expires_at:new Date(Date.now()+60000).toISOString()});
   if(path.endsWith('/status'))return Response.json({operation_state:'not_recorded'});
   if(path.endsWith('/state'))return Response.json({operation_state:'applied',operation_id:randomUUID(),idempotency:'replayed',kind:'dismissal',policy_version:3,
    outcome:{inputs:[{...command.body.inputs[0]!,id:alias,result_version:3}]},current:[{...item,version:3}]});
   throw new Error('Unexpected test request: '+path);
  });
  render(<StrictMode><MemoryRouter>{surface==='settings'?<AttentionPage context={context}/>:
   <AuthorizationBoundary sourcePolicy="settings"><DismissControl context={context} {...(surface==='source'?{inputs:[{kind,id:alias}]}:{cursor:'cursor',groupId:group})}/></AuthorizationBoundary>}
   </MemoryRouter></StrictMode>);
  await act(async()=>{});
  if(surface==='group')await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss this update'})));
  if(surface==='settings')await act(async()=>fireEvent.change(screen.getByRole('combobox',{name:'Manage'}),{target:{value:'dismissals'}}));
  const controls=surface==='settings'?within(screen.getByRole('button',{name:'Restore this input'}).closest('li')!):screen;
  assert.ok(controls.queryByRole('button',{name:'Check attention outcome'}),'The same input must expose its existing recovery instead of accepting another command.');
  const choice=controls.getByRole('button',{name:surface==='source'?'Dismiss these source inputs':surface==='group'?'Confirm dismissal':'Restore this input'});
  assert.equal(choice.getAttribute('aria-disabled'),'true');
  await act(async()=>fireEvent.click(choice));assert.equal(calls.some(c=>c.path.endsWith('/state')),false);
  await act(async()=>fireEvent.click(controls.getByRole('button',{name:'Check attention outcome'})));
  assert.equal(calls.at(-1)!.raw,JSON.stringify({idempotency_key:command.body.idempotency_key}));
  assert.equal(JSON.stringify(journal.all()[0]!.command.body),original);
  await act(async()=>fireEvent.click(controls.getByRole('button',{name:'Retry same attention change'})));
  assert.equal(calls.find(c=>c.path.endsWith('/state'))!.raw,original);
  assert.equal(journal.all().length,0);
 });
}
