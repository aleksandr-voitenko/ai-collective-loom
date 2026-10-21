import assert from 'node:assert/strict';
import {test,afterEach} from 'node:test';
import React,{StrictMode,useState} from 'react';
import {JSDOM} from 'jsdom';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {fixture} from '../helpers/attention.js';
import {plain} from '../helpers/references.js';
import {FollowingPage} from '../../src/web/Following.js';
import {AuthorizationBoundary,useAuthorization} from '../../src/web/AuthorizationBoundary.js';
import {IntentStore} from '../../src/web/participation-client.js';
import {useQuery,type Context} from '../../src/web/participation-state.js';
import {OrganizationResource} from '../../src/contracts/organization.js';
import {Page,ParticipationError} from '../../src/contracts/participation.js';
import {ContentCoordinator,contentKey} from '../../src/web/protected-content.js';
import * as P from '../../src/contracts/private-controls.js';
import {Value} from '@sinclair/typebox/value';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent','StorageEvent'] as const)
  Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
const {render,screen,within,fireEvent,cleanup,act,waitFor}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}

test('real HTTPS query source refusal withdraws its already displayed area and sibling content',{timeout:90000},async t=>{
 const f=await fixture(t);
 let pending=0;
 t.mock.method(globalThis,'fetch',async(path:string)=>{pending++;try{const r=await f.admin.call(path);return Response.json(r.body,{status:r.status});}finally{pending--;}});
 function Collection(){const {error}=useQuery(`/api/v1/areas/${f.area}/artifacts`,Page);return React.createElement('p',null,error);}
 function Area(){const {data}=useQuery<{title:string}>(`/api/v1/organization/resources/${f.area}`,OrganizationResource),[tab,setTab]=useState(false);
  return React.createElement(React.Fragment,null,data&&React.createElement('h1',null,data.title),React.createElement('button',{onClick:()=>setTab(true)},'Open artifacts'),tab&&React.createElement(Collection));}
 const title=(await f.admin.call(`/api/v1/organization/resources/${f.area}`)).body.title;
 render(React.createElement(StrictMode,null,React.createElement(AuthorizationBoundary,{scope:`area:${f.area}`,children:React.createElement(Area)}),
  React.createElement(AuthorizationBoundary,{scope:'independent',children:React.createElement('p',null,'Protected sibling content')})));
 await waitFor(()=>{assert.ok(screen.queryByRole('heading',{name:title}));assert.equal(pending,0);});
 await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.area]));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Open artifacts'})));
 await waitFor(()=>{assert.equal(!!screen.queryByRole('heading',{name:title}),false);assert.equal(!!screen.queryByText('Protected sibling content'),false);assert.equal(pending,0);});
});

test('real HTTPS current/exact misses classify revisions only after current resource guards',{timeout:90000},async t=>{
 const f=await fixture(t),a=await f.artifact(f.admin,'History remains independent'),base=`/api/v1/resources/${a.resource_id}`;
 const newer=await f.admin.call('/api/v1/revisions',{idempotency_key:crypto.randomUUID(),resource_id:a.resource_id,expected_revision_id:a.revision_id,title:'Hidden current',content:plain('Hidden revision')});
 assert.equal(newer.status,201);
 await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[newer.body.revision_id]));
 const misses=[base,base+'/revisions/'+newer.body.revision_id,base+'/revisions/'+crypto.randomUUID()];
 for(const path of misses){const r=await f.admin.call(path);assert.equal(r.status,404);assert.ok(Value.Check(ParticipationError,r.body));assert.equal(r.body.error.code,'unavailable');assert.equal(r.body.error.unavailable_scope,'revision');}
 const history=await f.admin.call(base+'/history');assert.equal(history.status,200);assert.deepEqual(history.body.items.map((v:any)=>v.revision_id),[a.revision_id]);
 assert.equal((await f.admin.call(base+'/revisions/'+a.revision_id)).status,200);
 const expired=await f.admin.call(base+'/history?cursor=missing');assert.equal(expired.body.error.code,'invalid_cursor');assert.equal(expired.body.error.unavailable_scope,undefined);
 for(const id of [a.resource_id,f.area]){
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[id]));
  for(const path of [...misses,base+'/revisions/'+a.revision_id,base+'/history']){
   const r=await f.admin.call(path);assert.equal(r.status,404);assert.equal(r.body.error.code,'unavailable');assert.equal(r.body.error.unavailable_scope,undefined,'resource/ancestor denial must not be masked by an unavailable revision');
   assert.ok(!JSON.stringify(r.body).includes('History remains independent'));
  }
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[id]));
 }
 const absent=await f.admin.call('/api/v1/resources/'+crypto.randomUUID());assert.equal(absent.status,404);assert.equal(absent.body.error.unavailable_scope,undefined);
});

for(const producer of ['Follow','mute','private preview'] as const)test(`real HTTPS ${producer} refusal checked after restoration must withdraw fresh previews`,{timeout:90000},async t=>{
  const f=await fixture(t),participant=await f.participant('recovery_refusal'),a=await f.artifact(f.admin,'Review protected A'),b=await f.artifact(f.admin,'Review protected B');
  for(const item of [a,b]){await f.follow(participant.client,f.settings('artifact',item.resource_id));await f.mute(participant.client,'artifact',item.resource_id);}
  const community=(await participant.client.call('/api/v1/community')).body,self=(await participant.client.call('/api/v1/identity/self')).body;
  const store=new IntentStore(community.instance_id,participant.id),context={community,self,store,...(producer==='private preview'?{controlsProjection:'private-controls-1'}:{})} as Context;
  const oldEntered=barrier(),releaseOld=barrier(),oldDone=barrier();
  const path=producer==='private preview'?'/api/v1/me/attention/previews':producer==='Follow'?'/api/v1/me/following/lookup':'/api/v1/me/attention/mutes/lookup';
  let holdNext=false,pending=0,held=false,oldResponse:any;
  t.mock.method(globalThis,'fetch',async(url:string,options:any)=>{
    const body=options.body?JSON.parse(options.body):undefined;
    const isOld=holdNext&&url===path&&(body.resource_id===a.resource_id||body.targets?.some((v:any)=>v.resource_id===a.resource_id));
    if(isOld){holdNext=false;held=true;oldEntered.release();await releaseOld.promise;}
    pending++;
    try{
      // A real HTTPS request is dispatched only after its barrier opens. Its
      // source authorization therefore happens after the second suppression.
      const response=await participant.client.call(url,body);
      if(isOld)oldResponse=response;
      return Response.json(response.body,{status:response.status});
    }finally{pending--;if(isOld)oldDone.release();}
  });
  const router=createMemoryRouter([{path:'/loom/following',element:React.createElement(FollowingPage,{context})}],{initialEntries:['/loom/following']});
  t.after(()=>router.dispose());
  render(React.createElement(StrictMode,null,React.createElement(RouterProvider,{router})));
  const exposure=()=>screen.queryAllByText(/Review protected [AB]/).length;
  const control=()=>within(document.querySelector(`[data-mute-target="artifact:${a.resource_id}"]`) as HTMLElement);
  const lookup=async()=>act(async()=>{
    if(producer==='Follow')window.dispatchEvent(new CustomEvent('loom-following-change',{detail:store.prefix}));
    else fireEvent.click(control().getByRole('button',{name:'Refresh mute state'}));
  });
  const suppress=async(state:'active'|'suppressed')=>f.database.transaction(tx=>tx.query('UPDATE loom.resources SET state=$2 WHERE id=$1',[a.resource_id,state]));
  await waitFor(()=>{assert.ok(exposure()>0);assert.equal(pending,0);assert.equal(control().getByRole('button',{name:'Unmute routine updates'}).getAttribute('aria-disabled'),'false');});
  for(const detail of document.querySelectorAll('details'))detail.open=true;
  try{
    holdNext=true;await lookup();await oldEntered.promise;assert.equal(held,true);
    await suppress('suppressed');await lookup();
    await waitFor(()=>{assert.equal(exposure(),0);assert.equal(pending,0);});
    await suppress('active');
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry following page'})));
    await waitFor(()=>{assert.ok(screen.getByRole('heading',{name:'Review protected A'}));assert.ok(exposure()>=2);assert.equal(pending,0);});
    const restoredExposure=exposure();
    await suppress('suppressed');
    await act(async()=>{releaseOld.release();await oldDone.promise;});
    assert.equal(oldResponse.status,200);
    assert.equal((producer==='private preview'?oldResponse.body.items.find((v:any)=>v.target.resource_id===a.resource_id):oldResponse.body).source.state,'unavailable','the server checks the held lookup only after access is lost again');
    t.diagnostic(JSON.stringify({producer,refusal:'unavailable',restoredExposure,remainingExposure:exposure()}));
    assert.equal(exposure(),0,'a newly checked refusal must withdraw the restored metadata even though its client request predates the first fence');
  }finally{releaseOld.release();await oldDone.promise;}
});

for(const arrival of ['denial first','positive first'] as const)test(`real HTTPS sibling ancestry remains protected across ${arrival}`,{timeout:90000},async t=>{
 const f=await fixture(t),participant=await f.participant('partial_scope'),a=await f.artifact(f.admin,'Resolved unrelated source'),b=await f.artifact(f.admin,'Held descendant source');
 await f.move(b.resource_id,f.other);
 const targetA={kind:'artifact' as const,resource_id:a.resource_id},targetB={kind:'artifact' as const,resource_id:b.resource_id},parent={kind:'area' as const,resource_id:f.other};
 const preview=async(target:P.PreviewItemView['target'])=>{
  const response=await participant.client.call('/api/v1/me/attention/previews',{targets:[target]});
  assert.equal(response.status,200);assert.ok(Value.Check(P.PreviewPage,response.body));return response.body.items[0] as P.PreviewItemView;
 };
 const c=new ContentCoordinator(1,()=>1),departed=c.region('departed'),current=c.region('following');departed.mount();current.mount();
 const old=c.begin(departed,[contentKey(parent)]);departed.unmount();
 const readA=c.begin(current,[contentKey(targetA)]),sourceA=await preview(targetA);assert.equal(sourceA.source.state,'available');
 if(sourceA.source.state==='available')assert.ok(!sourceA.source.path.some(area=>area.id===f.other));
 current.publish(readA,[sourceA],true);c.finish(readA);
 const readB=c.begin(current,[contentKey(targetB)]),held=await preview(targetB);assert.equal(held.source.state,'available');
 if(held.source.state==='available')assert.ok(held.source.path.some(area=>area.id===f.other));
 // The actual successful HTTPS check has finished; only client publication is
 // held. Suppress the ancestor, then obtain a real current denial elsewhere.
 await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.other]));
 const refused=await preview(parent);assert.equal(refused.source.state,'unavailable');
 if(arrival==='positive first'){current.publish(readB,[held],true);c.finish(readB);}
 departed.publish(old,[refused],false);c.finish(old);
 if(arrival==='denial first'){current.publish(readB,[held],true);c.finish(readB);}
 assert.equal(current.snapshot.state,'withdrawn');assert.equal(current.preview(targetB,current.snapshot.generation),undefined);
 current.unmount();assert.deepEqual(c.retained,{regions:0,requests:0,previews:0});
});

for(const producer of ['Follow','mute'] as const)for(const placement of ['already below','cached path','old preview first','old preview last'] as const)
test(`real HTTPS uppercase ${producer} refusal withdraws Following after navigation: ${placement}`,{timeout:90000},async t=>{
 const f=await fixture(t),participant=await f.participant('case_alias'),a=await f.artifact(f.admin,'Case protected descendant');
 if(placement==='already below')await f.move(a.resource_id,f.other);
 await f.follow(participant.client,f.settings('artifact',a.resource_id));await f.mute(participant.client,'artifact',a.resource_id);
 const community=(await participant.client.call('/api/v1/community')).body,self=(await participant.client.call('/api/v1/identity/self')).body,
  store=new IntentStore(community.instance_id,participant.id),context={community,self,store,controlsProjection:P.privateControlsContract} as Context;
 const target={kind:'area' as const,resource_id:f.other.toUpperCase()},command={target,include_descendants:true,expected_version:0,idempotency_key:crypto.randomUUID()},
  follow={...command,following:true,preferences:['artifact_revisions' as const]},mute={kind:'mute' as const,body:{...command,muted:true}},
  bytes=JSON.stringify(producer==='Follow'?follow:mute.body);
 const entered=barrier(),release=barrier(),done=barrier(),previewEntered=barrier(),previewRelease=barrier(),previewDone=barrier();
 let refused:any,transport:string|undefined,holdPreview=false;const paths:string[][]=[];
 const requests=new Set<ReturnType<typeof participant.client.call>>();
 // Native HTTPS completion is not bounded by waitFor's DOM polling deadline.
 // Flush each response's React effects too: mounted controls can start another wave.
 // Deliberately held race requests/responses remain outside this settlement set.
 const settleRequests=async()=>{
  do{await act(async()=>{await Promise.all(requests);});}while(requests.size);
 };
 const commandPath=producer==='Follow'?'/api/v1/me/following/private/state':'/api/v1/me/attention/private/mutes/state';
 t.mock.method(globalThis,'fetch',async(path:string,options:any)=>{
  const held=path===commandPath;
  if(held){transport=options.body;entered.release();await release.promise;}
  const request=participant.client.call(path,options.body?JSON.parse(options.body):undefined);
  requests.add(request);
  let response;
  try{response=await request;}finally{requests.delete(request);}
  if(held){refused=response;done.release();}
  if(path.endsWith('/previews')){
   const item=response.body.items.find((v:any)=>v.target.resource_id===a.resource_id);
   if(item?.source.state==='available')paths.push(item.source.path.map((v:any)=>v.id));
   if(holdPreview){holdPreview=false;previewEntered.release();await previewRelease.promise;previewDone.release();}
  }
  return Response.json(response.body,{status:response.status});
 });
 function Departed(){const authority=useAuthorization();return React.createElement('button',{onClick:()=>{
  void (producer==='Follow'?authority.followingCommand(follow,'state',self,P.privateControlsContract):authority.attentionCommand(mute,true,self,P.privateControlsContract)).catch(()=>{});
 }},'Start uppercase command');}
 function Frame(){const [gone,setGone]=useState(false);return gone?React.createElement(FollowingPage,{context}):React.createElement(React.Fragment,null,
  React.createElement(AuthorizationBoundary,{scope:'area:'+target.resource_id,children:React.createElement(Departed)}),
  React.createElement('button',{onClick:()=>setGone(true)},'Navigate to Following'));}
 const router=createMemoryRouter([{path:'/',element:React.createElement(Frame)}]);t.after(()=>router.dispose());
 render(React.createElement(StrictMode,null,React.createElement(RouterProvider,{router})));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Start uppercase command'})));await entered.promise;
 try{
  assert.equal(transport,bytes);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Navigate to Following'})));
  await settleRequests();
  await waitFor(()=>{assert.ok(screen.queryByRole('heading',{name:'Case protected descendant'}));assert.equal(requests.size,0);});
  for(const detail of document.querySelectorAll('details'))detail.open=true;
  const reordered=placement.startsWith('old preview');
  const refresh=async()=>act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh mute state'})));
  if(placement!=='already below')assert.ok(paths.every(path=>!path.includes(f.other)));
  if(reordered){holdPreview=true;await refresh();await previewEntered.promise;}
  if(placement!=='already below')await f.move(a.resource_id,f.other);
  if(reordered){
   await refresh();await settleRequests();await waitFor(()=>{assert.ok(paths.at(-1)?.includes(f.other));assert.equal(requests.size,0);});
   if(placement==='old preview first')await act(async()=>{previewRelease.release();await previewDone.promise;});
  }
  // Independent oracle: the new parent now suppresses its moved child even
  // when the browser only knows the old path, or receives that path last.
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.other]));
  const oracle=await participant.client.call('/api/v1/me/attention/previews',{targets:[{kind:'artifact',resource_id:a.resource_id}]});
  assert.equal(oracle.body.items[0].source.state,'unavailable');
  await act(async()=>{release.release();await done.promise;});
  assert.equal(refused.status,404);assert.equal(refused.body.error.code,'unavailable');
  if(placement==='old preview last')await act(async()=>{previewRelease.release();await previewDone.promise;});
  assert.equal(!!screen.queryByText('Case protected descendant'),false);
  assert.equal(screen.getByRole('button',{name:'Unfollow'}).hasAttribute('disabled'),false);
  assert.equal(screen.getByRole('button',{name:'Unmute routine updates'}).getAttribute('aria-disabled'),'false');
  assert.equal(JSON.stringify(producer==='Follow'?follow:mute.body),bytes);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Unmute routine updates'})));
  await settleRequests();
  await waitFor(()=>assert.ok(screen.queryByText('Choice saved. Refresh an existing routine selection to apply it; older history remains available.')));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Unfollow'})));
  await settleRequests();
  await waitFor(()=>assert.ok(screen.queryByText(/Explicit follow removed/)));
  assert.equal(!!screen.queryByText('Case protected descendant'),false,'private confirmations cannot reauthorize metadata');
 }finally{release.release();previewRelease.release();await done.promise;}
});
