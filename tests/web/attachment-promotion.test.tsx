import assert from 'node:assert/strict';
import {afterEach,test,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode} from 'react';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {AuthorizationBoundary,useAuthorization} from '../../src/web/AuthorizationBoundary.js';
import {PromotionPage,ArtifactProvenance} from '../../src/web/AttachmentPromotion.js';
import {IntentStore,invalidateIdentity} from '../../src/web/participation-client.js';
import type {Context} from '../../src/web/participation-state.js';

const locks=navigator.locks,dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
const {render,screen,fireEvent,cleanup,act,waitFor}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});
function context(){const instance=randomUUID(),participant=randomUUID();return {store:new IntentStore(instance,participant,localStorage,location.origin,locks),self:{participant_id:participant,credential_id:randomUUID(),nickname:'promoter',kind:'human',role:'participant'},community:{instance_id:instance}} as Context;}
const source=()=>({contribution_id:randomUUID(),revision_id:randomUUID(),file_id:randomUUID()});
function mount(t:TestContext,c:Context,s:ReturnType<typeof source>,intent?:string){
  const calls:{path:string;options:RequestInit|undefined;finish:(response:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(path:string,options?:RequestInit)=>new Promise<Response>(finish=>calls.push({path,options,finish})));
  function Denial(){const a=useAuthorization();return <button onClick={()=>void a.readAuthorized('/api/v1/resources/'+s.contribution_id).catch(()=>{})}>Refresh protected source</button>;}
  const router=createMemoryRouter([{path:'/loom/promote',element:<AuthorizationBoundary sourcePolicy="settings"><PromotionPage context={c}/><Denial/></AuthorizationBoundary>},{path:'/other',element:<h1>Other context</h1>}],{initialEntries:[intent?'/loom/promote?intent='+intent:`/loom/promote?contribution=${s.contribution_id}&revision=${s.revision_id}&file=${s.file_id}`]});
  t.after(()=>router.dispose());render(<StrictMode><RouterProvider router={router}/></StrictMode>);return {calls,router};
}
function selection(s:ReturnType<typeof source>){return {contribution_id:s.contribution_id,revision_id:s.revision_id,discussion_id:randomUUID(),contributor_id:randomUUID(),revision_publisher_id:randomUUID(),file:{kind:'file',file_id:s.file_id,path:'source.txt',size:5,sha256:'a'.repeat(64),media_type:'text/plain',type_evidence:'declared',download_url:`/api/v1/contributions/${s.contribution_id}/revisions/${s.revision_id}/attachments/${s.file_id}/download`}};}
const receipt=()=>({operation_id:randomUUID(),resource_id:randomUUID(),revision_id:randomUUID(),publication_state:'committed',idempotency:'created'});
async function retained(c:Context,s:ReturnType<typeof source>,title:string){const r=await c.store.save(c.store.create('promotion:'+randomUUID(),'attachment.promote','/api/v1/attachment-promotions',{source:s,area_id:randomUUID(),title}));return c.store.prepareDispatch(r,r.body);}

test('StrictMode promotion recovery keeps multiple exact commands, read failures and unknown status independent',async t=>{
  const c=context(),s=source(),a=await retained(c,s,'First'),b=await retained(c,s,'Second'),{calls}=mount(t,c,s,a.key);
  assert.equal(calls.length,0);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check promotion status'})));
  await act(async()=>calls[0]!.finish(Response.json({error:{code:'forbidden',message:'Retry this read'}},{status:403})));
  assert.equal(c.store.all().find(r=>r.key===a.key)!.state,'uncertain');assert.deepEqual(c.store.all().find(r=>r.key===b.key),b);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check promotion status'})));
  await act(async()=>calls[1]!.finish(Response.json({operation_state:'not_recorded'})));assert.match(screen.getByRole('status').textContent!,/No recorded outcome/);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry this exact promotion'})));assert.equal(calls[2]!.options!.body,JSON.stringify(a.body));
  await act(async()=>calls[2]!.finish(Response.json(receipt(),{status:201})));
  assert.equal(c.store.all().find(r=>r.key===a.key)!.state,'committed');assert.deepEqual(c.store.all().find(r=>r.key===b.key),b);assert.ok(screen.getByRole('link',{name:'Open independent artifact'}));assert.equal(screen.queryByText('source.txt'),null);
});

test('StrictMode late private promotion receipts cannot mutate recovery after owner or navigation changes',async t=>{
  for(const identity of [false,true]){
    const c=context(),s=source(),r=await retained(c,s,'Pending'),{calls,router}=mount(t,c,s,r.key);
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check promotion status'})));const before=Object.entries(localStorage);
    await act(async()=>{if(identity)invalidateIdentity();else void router.navigate('/other');});
    await act(async()=>calls[0]!.finish(Response.json(receipt())));assert.deepEqual(Object.entries(localStorage),before);assert.equal(screen.queryByRole('link',{name:'Open independent artifact'}),null);cleanup();
  }
});

test('StrictMode exact selection is withdrawn on delayed denial and local save failure prevents dispatch',async t=>{
  const c=context(),s=source(),{calls}=mount(t,c,s);const selected=selection(s);
  await act(async()=>calls.filter(r=>r.path.includes('/attachments/')).forEach(r=>r.finish(Response.json(selected))));
  await waitFor(()=>assert.ok(screen.getByText(/source.txt · 5 bytes/)));
  await act(async()=>fireEvent.change(screen.getByLabelText('Artifact title'),{target:{value:'Reviewed title'}}));
  await act(async()=>fireEvent.change(screen.getByLabelText('Destination area ID'),{target:{value:randomUUID()}}));
  await waitFor(()=>assert.equal(c.store.all().length,1));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Review artifact promotion'})));assert.ok(screen.getByRole('dialog'));
  t.mock.method(c.store,'prepareDispatch',async()=>{throw new Error('Local journal unavailable');});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Create independent artifact'})));assert.match(screen.getByRole('alert').textContent!,/Local journal unavailable/);assert.equal(calls.filter(r=>r.path==='/api/v1/attachment-promotions').length,0);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh protected source'})));
  await act(async()=>calls.at(-1)!.finish(Response.json({error:{code:'unavailable',message:'Source unavailable'}},{status:404})));
  assert.equal(screen.queryByText(/source.txt · 5 bytes/),null);assert.equal(screen.queryByRole('button',{name:'Review artifact promotion'}),null);assert.equal(c.store.all()[0]!.body.title,'Reviewed title');
});

test('a first definitive promotion refusal allows explicit correction while uncertain retries retain identity',async t=>{
  const c=context(),s=source(),{calls}=mount(t,c,s);
  await act(async()=>calls.filter(r=>r.path.includes('/attachments/')).forEach(r=>r.finish(Response.json(selection(s)))));
  await act(async()=>fireEvent.change(screen.getByLabelText('Artifact title'),{target:{value:'Candidate'}}));await act(async()=>fireEvent.change(screen.getByLabelText('Destination area ID'),{target:{value:randomUUID()}}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Review artifact promotion'})));await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Create independent artifact'})));
  const request=calls.find(r=>r.path==='/api/v1/attachment-promotions')!;
  await act(async()=>request.finish(Response.json({error:{code:'file_capacity',message:'Publication capacity reached'}},{status:429})));
  const old=c.store.all()[0]!;assert.equal(old.state,'rejected');await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Prepare corrected promotion'})));assert.notEqual(c.store.all()[0]!.key,old.key);assert.equal(c.store.all()[0]!.body.title,'Candidate');
});

test('source attribution is progressive and redacts unavailable source fields',async t=>{
  const calls:{finish:(r:Response)=>void}[]=[];t.mock.method(globalThis,'fetch',()=>new Promise<Response>(finish=>calls.push({finish})));
  const artifact=randomUUID(),revision=randomUUID(),router=createMemoryRouter([{path:'/',element:<AuthorizationBoundary sourcePolicy="settings"><ArtifactProvenance url={`/api/v1/artifacts/${artifact}/revisions/${revision}/provenance`}/></AuthorizationBoundary>}]);t.after(()=>router.dispose());render(<StrictMode><RouterProvider router={router}/></StrictMode>);
  assert.equal(calls.length,0);await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Source attribution'})));
  await act(async()=>calls.forEach(c=>c.finish(Response.json({artifact_id:artifact,revision_id:revision,promoter_id:randomUUID(),source:{state:'unavailable'}}))));
  assert.equal(screen.queryByRole('link',{name:'Exact source revision'}),null);await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Source attribution'})));assert.equal(screen.queryByText(/Original contributor/),null);
});
