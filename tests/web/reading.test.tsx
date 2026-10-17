import assert from 'node:assert/strict';
import { test,afterEach,type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ReadingProvider,ReadingText,ReadingPageViewComponent } from '../../src/web/Reading.js';
import { ReadingRecovery } from '../../src/web/reading-recovery.js';
import { viewportPresentation } from '../../src/web/reading-presentation.js';
import { invalidateIdentity } from '../../src/web/participation-client.js';
import type { Context } from '../../src/web/participation-state.js';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent','StorageEvent'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(globalThis,'innerWidth',{value:1000,configurable:true});Object.defineProperty(globalThis,'innerHeight',{value:800,configurable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
const {render,screen,fireEvent,cleanup,act,waitFor,within}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});
const target={resource_id:randomUUID(),revision_id:randomUUID()};
function mount(t:TestContext,automatic=false,targets=[target]){
  const context={community:{instance_id:randomUUID()},self:{participant_id:randomUUID(),csrf:'fixture'}} as Context;
  const recovery=new ReadingRecovery(context.community.instance_id,context.self.participant_id);
  if(automatic)localStorage.setItem(recovery.preference,'true');
  const calls:{path:string;body:any;finish:(r:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(path:string,options:any)=>new Promise<Response>(finish=>calls.push({path,body:JSON.parse(options.body),finish})));
  const router=createMemoryRouter([{path:'/read',element:<ReadingProvider context={context}>{targets.map((target,index)=><ReadingText key={target.revision_id} target={target} number={String(index+1)} content={{format:'loom-markdown-v1',text:'Exact readable text',mentions:[]}} participants={[]}/>)}<ReadingPageViewComponent/></ReadingProvider>},{path:'/other',element:<h1>Other</h1>}],{initialEntries:['/read']});
  t.after(()=>router.dispose());render(<StrictMode><RouterProvider router={router}/></StrictMode>);
  return {context,recovery,calls,router};
}
const page=(read=false,version=0)=>({scope:'own_exact_revisions',items:[{...target,read,version,availability:'available'}]});
async function settle(calls:ReturnType<typeof mount>['calls'],read=false,version=0){
  await waitFor(()=>assert.ok(calls.some(c=>c.path.endsWith('/lookup'))));
  await act(async()=>{for(const c of calls.filter(c=>c.path.endsWith('/lookup')))c.finish(Response.json(page(read,version)));});
  await waitFor(()=>assert.equal((screen.getByRole('button',{name:'Mark unread'}) as HTMLButtonElement).disabled,false));
}
test('StrictMode saves exact manual unread before dispatch; old status cannot replace a newer state',async t=>{
  const f=mount(t);await settle(f.calls);const button=screen.getByRole('button',{name:'Mark unread'});button.focus();
  await act(async()=>fireEvent.click(button));await waitFor(()=>assert.ok(f.calls.some(c=>c.path.endsWith('/state'))));
  const sent=f.calls.find(c=>c.path.endsWith('/state'))!;assert.deepEqual(f.recovery.all()[0]!.body,sent.body);assert.equal(sent.body.targets[0].expected_version,0);
  await act(async()=>sent.finish(Response.json({operation_state:'applied',operation_id:randomUUID(),idempotency:'created',outcome:{basis:'manual',episode_id:null,targets:[{...sent.body.targets[0],result_version:1}]},current:page(false,1).items})));
  await waitFor(()=>assert.equal(f.recovery.all().length,0));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh reading status'})));
  await waitFor(()=>assert.ok(f.calls.filter(c=>c.path.endsWith('/lookup')).length>=2));
  const lookups=f.calls.filter(c=>c.path.endsWith('/lookup'));await act(async()=>lookups.at(-1)!.finish(Response.json(page(false,2))));
  await act(async()=>{for(const c of lookups.slice(0,-1))c.finish(Response.json(page(true,1)));});
  await waitFor(()=>assert.equal(document.querySelector('[data-reading-version]')!.getAttribute('data-reading-version'),'2'));
  assert.ok(screen.getByText(/Marked unread · private/));assert.equal(document.activeElement,button);
});
for(const conflictFirst of [true,false])test(`conflict feedback belongs to its exact revision and survives ${conflictFirst?'a later unrelated success':'an earlier unrelated success'}, refresh and reopening`,async t=>{
  const other={resource_id:randomUUID(),revision_id:randomUUID()},targets=[target,other],f=mount(t,false,targets);
  const controls=(source:typeof target)=>within(document.querySelector<HTMLElement>(`[data-reading-target="${source.revision_id}"]`)!);
  const lookup=(version:number)=>({scope:'own_exact_revisions',items:targets.map((source,index)=>({...source,read:version>0&&index===1,version,availability:'available'}))});
  await waitFor(()=>assert.ok(f.calls.some(c=>c.path.endsWith('/lookup'))));
  await act(async()=>{for(const c of f.calls.filter(c=>c.path.endsWith('/lookup')))c.finish(Response.json(lookup(0)));});
  await waitFor(()=>assert.equal((controls(target).getByRole('button',{name:'Mark read'}) as HTMLButtonElement).disabled,false));
  await act(async()=>{for(const source of targets)fireEvent.click(controls(source).getByRole('button',{name:'Mark read'}));});
  await waitFor(()=>assert.equal(f.calls.filter(c=>c.path.endsWith('/state')).length,2));
  const commands=f.calls.filter(c=>c.path.endsWith('/state'));
  for(const index of conflictFirst?[0,1]:[1,0]){
    const command=commands[index]!;
    await act(async()=>command.finish(Response.json({operation_state:index===0?'version_conflict':'applied',operation_id:randomUUID(),idempotency:'created',
      outcome:{basis:'manual',episode_id:null,targets:command.body.targets.map((v:any)=>({...v,result_version:1}))},current:[lookup(1).items[index]]})));
  }
  await waitFor(()=>assert.ok(controls(target).queryByText(/Reading change conflicted/)));
  assert.equal(!!controls(other).queryByText(/Reading change conflicted/),false);
  const retained=f.recovery.all();assert.equal(retained.length,1);assert.deepEqual(retained[0]!.body,commands[0]!.body);
  assert.equal(retained[0]!.state,'conflicted');
  await act(async()=>fireEvent.click(controls(other).getByRole('button',{name:'Refresh reading status'})));
  await waitFor(()=>assert.ok(f.calls.filter(c=>c.path.endsWith('/lookup')).length>=2));
  await act(async()=>{for(const c of f.calls.filter(c=>c.path.endsWith('/lookup')))c.finish(Response.json(lookup(1)));});
  assert.ok(controls(target).queryByText(/Reading change conflicted/));
  await act(async()=>f.router.navigate('/other'));await act(async()=>f.router.navigate('/read'));
  await waitFor(()=>assert.ok(controls(target).queryByText(/Reading change conflicted/)));
  assert.equal(!!controls(other).queryByText(/Reading change conflicted/),false);
  assert.equal(f.calls.filter(c=>c.path.endsWith('/state')).length,2,'Reopening must not retry a recorded conflict');
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss reading conflict'})));
  await waitFor(()=>assert.equal(!!controls(target).queryByText(/Reading change conflicted/),false));
  assert.equal(f.recovery.all().length,0);
});
test('failed local save and failed lookup leave source readable and unrelated publication custody intact',async t=>{
  const f=mount(t);await settle(f.calls);localStorage.setItem('loom.intent.unrelated','preserve');
  const original=dom.window.Storage.prototype.setItem;
  t.mock.method(dom.window.Storage.prototype,'setItem',function(this:Storage,key:string,value:string){if(key.includes('intent:'))throw new Error('storage full');original.call(this,key,value);});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Mark read'})));
  await waitFor(()=>assert.ok(screen.getAllByText(/could not be saved/).length));assert.equal(f.calls.filter(c=>c.path.endsWith('/state')).length,0);
  assert.equal(localStorage.getItem('loom.intent.unrelated'),'preserve');assert.equal(f.recovery.all().length,0);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh reading status'})));await waitFor(()=>assert.ok(f.calls.length>=2));
  await act(async()=>f.calls.at(-1)!.finish(Response.json({error:{code:'service_unavailable',message:'Status unavailable'}},{status:503})));
  await waitFor(()=>assert.ok(screen.getByText(/Reading status unavailable · private/)));assert.ok(screen.getByText('Exact readable text'));
});
test('late route and identity responses cannot create progress or repopulate cleared recovery',async t=>{
  const f=mount(t,true);await waitFor(()=>assert.ok(f.calls.length));await act(async()=>f.router.navigate('/other'));
  await act(async()=>{for(const call of f.calls)call.finish(Response.json(page()));});
  assert.equal(f.calls.filter(c=>c.path.endsWith('/state')).length,0);assert.equal(f.recovery.all().length,0);
  await act(async()=>f.router.navigate('/read'));await waitFor(()=>assert.ok(f.calls.length>=2));
  await act(async()=>{invalidateIdentity();f.calls.at(-1)!.finish(Response.json(page()));});
  assert.equal(f.recovery.all().length,0);assert.equal(f.calls.filter(c=>c.path.endsWith('/state')).length,0);
});
test('automatic StrictMode observation is once per episode; manual unread and refresh cannot rearm it',async t=>{
  t.mock.method(document,'hasFocus',()=>true);Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});
  t.mock.method(HTMLElement.prototype,'getBoundingClientRect',()=>({top:100,left:0,bottom:200,right:500,width:500,height:100,x:0,y:100,toJSON:()=>({})}));
  Object.defineProperty(document,'elementFromPoint',{value:()=>document.querySelector('.prose'),configurable:true});
  const f=mount(t,true);await settle(f.calls);
  await waitFor(()=>assert.equal(f.calls.filter(c=>c.path.endsWith('/state')).length,1),{timeout:3000});
  const automatic=f.calls.find(c=>c.path.endsWith('/state'))!;assert.equal(automatic.body.basis,'presentation');assert.equal(automatic.body.targets[0].revision_id,target.revision_id);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Mark unread'})));
  await waitFor(()=>assert.equal(f.calls.filter(c=>c.path.endsWith('/state')).length,2));
  const manual=f.calls.filter(c=>c.path.endsWith('/state'))[1]!;
  await act(async()=>manual.finish(Response.json({operation_state:'applied',operation_id:randomUUID(),idempotency:'created',outcome:{basis:'manual',episode_id:null,targets:[{...manual.body.targets[0],result_version:1}]},current:page(false,1).items})));
  await act(async()=>automatic.finish(Response.json({operation_state:'version_conflict',operation_id:randomUUID(),idempotency:'created',outcome:{basis:'presentation',episode_id:automatic.body.episode_id,targets:[{...automatic.body.targets[0],result_version:1}]},current:page(false,1).items})));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1200));});
  assert.equal(f.calls.filter(c=>c.path.endsWith('/state')).length,2);
  assert.deepEqual(f.recovery.all().map(r=>({state:r.state,key:r.body.idempotency_key})),[{state:'conflicted',key:automatic.body.idempotency_key}]);
});

test('recovery cap preserves every exact intent; a competing retry prevents a late first refusal becoming dismissible',async()=>{
  const journal=new ReadingRecovery(randomUUID(),randomUUID()),body=()=>({idempotency_key:randomUUID(),basis:'manual' as const,episode_id:null,targets:[{...target,read:false,expected_version:0}]});
  localStorage.setItem('loom.intent.unrelated','preserve');
  for(let i=0;i<128;i++)await journal.save(body(),()=>true);
  const before=journal.all();await assert.rejects(journal.save(body(),()=>true),/full/);
  assert.deepEqual(journal.all(),before);assert.equal(localStorage.getItem('loom.intent.unrelated'),'preserve');
  const first=await journal.begin(before[0]!),second=await journal.begin(before[0]!);
  await journal.rejectFirst(first);assert.equal(journal.all().find(r=>r.body.idempotency_key===first.body.idempotency_key)!.state,'uncertain');
  assert.equal(second.attempts,2);await journal.finish(first);assert.equal(journal.all().length,127);
});

test('confirmed conflicts retain exact bounded custody; failed dismissal and late responses cannot lose or recreate feedback',async t=>{
  const journal=new ReadingRecovery(randomUUID(),randomUUID()),body={idempotency_key:randomUUID(),basis:'manual' as const,episode_id:null,targets:[{...target,read:true,expected_version:0}]};
  const saved=await journal.save(body,()=>true),sent=await journal.begin(saved);
  await assert.rejects(journal.finish(sent,true),/changed/,'Uncertain commands cannot be dismissed as conflicts');
  const write=t.mock.method(dom.window.Storage.prototype,'setItem',()=>{throw new Error('Synthetic save failure');});
  await assert.rejects(journal.recordConflict(sent),/Reading conflict could not be saved.*check its outcome again/);write.mock.restore();
  assert.deepEqual(journal.all(),[sent],'A failed conflict save must preserve exact recovery');
  await journal.recordConflict(sent);await journal.rejectFirst(sent);
  assert.deepEqual(journal.all(),[{...sent,state:'conflicted'}]);
  await assert.rejects(journal.begin(sent),/changed/,'Confirmed conflicts cannot be retried as uncertain commands');
  const remove=t.mock.method(dom.window.Storage.prototype,'removeItem',()=>{throw new Error('Synthetic removal failure');});
  await assert.rejects(journal.finish(sent,true),/removal failure/);
  assert.deepEqual(journal.all(),[{...sent,state:'conflicted'}]);remove.mock.restore();
  await journal.finish(sent,true);await journal.recordConflict(sent);await journal.rejectFirst(sent);
  assert.deepEqual(journal.all(),[]);
});

test('presentation gate excludes hidden, unfocused, covered, offscreen and horizontally incomplete main text',t=>{
  const element=document.createElement('div');document.body.append(element);
  t.after(()=>element.remove());
  let visible=true,focused=true,top=100,covered=false;
  Object.defineProperty(document,'visibilityState',{get:()=>visible?'visible':'hidden',configurable:true});
  t.mock.method(document,'hasFocus',()=>focused);
  t.mock.method(element,'getBoundingClientRect',()=>({top,left:0,bottom:top+100,right:500,width:500,height:100,x:0,y:top,toJSON:()=>({})}));
  Object.defineProperty(document,'elementFromPoint',{value:()=>covered?document.body:element,configurable:true});
  const qualifies=()=>viewportPresentation(element).visible(0,100);
  assert.equal(qualifies(),true);visible=false;assert.equal(qualifies(),false);visible=true;
  focused=false;assert.equal(qualifies(),false);focused=true;
  covered=true;assert.equal(qualifies(),false);covered=false;
  top=900;assert.equal(qualifies(),false);top=100;
  const code=document.createElement('pre');element.append(code);Object.defineProperty(code,'scrollWidth',{value:600});Object.defineProperty(code,'clientWidth',{value:500});
  assert.equal(qualifies(),false);
});
