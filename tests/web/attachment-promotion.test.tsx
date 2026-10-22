import assert from 'node:assert/strict';
import {afterEach,test,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode} from 'react';
import {createMemoryRouter,useParams} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {AuthorizationBoundary,useAuthorization} from '../../src/web/AuthorizationBoundary.js';
import {PromotionPage} from '../../src/web/AttachmentPromotion.js';
import {ResourcePage} from '../../src/web/ParticipationResource.js';
import {Revision,type RevisionView} from '../../src/contracts/participation.js';
import {Value} from '@sinclair/typebox/value';
import {IntentStore,invalidateIdentity} from '../../src/web/participation-client.js';
import {useQuery,type Context} from '../../src/web/participation-state.js';

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

function artifactFixture(){
  const id=randomUUID(),revision=randomUUID(),person={id:randomUUID(),nickname:'Artifact creator',kind:'human' as const};
  const path=`/api/v1/resources/${id}/revisions/${revision}`,provenance=`/api/v1/artifacts/${id}/revisions/${revision}/provenance`;
  const file={kind:'file',file_id:randomUUID(),path:'source.txt',size:5,sha256:'a'.repeat(64),media_type:'text/plain',type_evidence:'declared',download_url:`/api/v1/artifacts/${id}/revisions/${revision}/files/exact/download`};
  const value:RevisionView={resource_id:id,revision_id:revision,current_revision_id:revision,kind:'artifact',title:'Independent artifact',revision_number:'1',author:person,publisher:person,created_at:'2026-10-16T12:00:00Z',area_id:randomUUID(),area_title:'General',discussion_id:null,parent_id:null,can_edit:false,publication_open:true,full_content_url:path,content:{format:'loom-markdown-v1',text:'Independent artifact body',mentions:[]},mentioned_participants:[],provenance_url:provenance,file_set:{version:'artifact-files-v1',files:[],manifest_url:path+'/files'}};
  assert.ok(Value.Check(Revision,value));
  return {id,revision,path,provenance,value,file,unavailable:{artifact_id:id,revision_id:revision,promoter_id:person.id,source:{state:'unavailable'}},files:{artifact_id:id,revision_id:revision,prefix:'',items:[file],next_cursor:null,complete:true,availability:'declared_not_probed',max_response_bytes:100000}};
}
function mountResource(t:TestContext,f:ReturnType<typeof artifactFixture>,sibling?:ReturnType<typeof artifactFixture>){
  const calls:{path:string;done:boolean;signal:AbortSignal|undefined|null;finish:(response:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(path:string,options?:RequestInit)=>new Promise<Response>(resolve=>{const call={path,done:false,signal:options?.signal,finish(response:Response){assert.equal(call.done,false);call.done=true;resolve(response);}};calls.push(call);}));
  const c=context();function Page(){const p=useParams();return <ResourcePage id={p.id!} revision={p.revision} context={c}/>;}
  const router=createMemoryRouter([{path:'/loom/resource/:id/:revision',element:<Page/>},{path:'/other',element:<h1>Other context</h1>}],{initialEntries:[`/loom/resource/${f.id}/${f.revision}`]});
  function Sibling(){const {data}=useQuery<RevisionView>(sibling!.path,Revision);return data&&<p>{data.title}</p>;}
  const view=render(<StrictMode><RouterProvider router={router}/>{sibling&&<AuthorizationBoundary scope='sibling'><Sibling/></AuthorizationBoundary>}</StrictMode>);
  t.after(async()=>{view.unmount();router.dispose();await act(async()=>{for(const call of calls.filter(c=>!c.done))call.finish(Response.json({error:{code:'service_unavailable',message:'Fixture cleanup'}},{status:503}));});});
  const pending=(path:string)=>calls.filter(c=>!c.done&&!c.signal?.aborted&&c.path===path);
  async function answer(path:string,value:unknown){await waitFor(()=>assert.ok(pending(path).length,'Expected read: '+path));await act(async()=>pending(path).forEach(c=>c.finish(Response.json(value))));}
  return {calls,router,pending,answer};
}
const unavailableText='Source attribution details are currently unavailable.';
test('production resource boundary reauthorizes the independent artifact after unavailable attribution',async t=>{
  const f=artifactFixture(),m=mountResource(t,f);
  await m.answer(f.path,f.value);assert.ok(screen.getByText('Independent artifact body'));
  assert.equal(m.pending(f.provenance).length,0);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Source attribution'})));
  await m.answer(f.provenance,f.unavailable);
  assert.ok(screen.getByText(unavailableText));assert.equal(screen.queryByRole('link',{name:'Exact source revision'}),null);assert.equal(screen.queryByText(/Original contributor/),null);
  assert.equal(screen.queryByText('Independent artifact body'),null,'Old artifact content must lose its lease');
  await m.answer(f.path,{...f.value,title:'Fresh independent artifact'});
  assert.ok(screen.getByRole('heading',{name:'Fresh independent artifact'}));assert.ok(screen.getByText('Independent artifact body'));
  await m.answer(`/api/v1/artifacts/${f.id}/revisions/${f.revision}/files?prefix=&limit=12`,f.files);
  assert.ok(screen.getByRole('button',{name:'Download source.txt'}));assert.ok(screen.getByText(unavailableText));
});

test('attribution denial revokes settled siblings and late artifact reads before a fresh independent read',async t=>{
  const f=artifactFixture(),sibling=artifactFixture(),m=mountResource(t,f,sibling);
  await m.answer(f.path,f.value);await m.answer(sibling.path,{...sibling.value,title:'Unrelated protected sibling'});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Source attribution'})));
  const old=m.pending(f.path).at(-1)!;
  await m.answer(f.provenance,f.unavailable);
  assert.equal(screen.queryByText('Unrelated protected sibling'),null);assert.ok(screen.getByText(unavailableText));
  await act(async()=>old.finish(Response.json({...f.value,title:'Old delayed artifact'})));
  assert.equal(screen.queryByRole('heading',{name:'Old delayed artifact'}),null);
  await m.answer(f.path,f.value);
  assert.ok(screen.getByText('Independent artifact body'));assert.equal(screen.queryByText('Unrelated protected sibling'),null);
  assert.equal(m.pending(sibling.path).length,0,'Attribution must not reauthorize other content');
});

test('independent artifact refusal withdraws fresh unavailable attribution and cannot be restored by old success',async t=>{
  const f=artifactFixture(),m=mountResource(t,f);
  await m.answer(f.path,f.value);await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Source attribution'})));
  const old=m.pending(f.path).at(-1)!;
  await m.answer(f.provenance,f.unavailable);
  await act(async()=>m.pending(f.path).forEach(c=>c.finish(Response.json({error:{code:'unavailable',message:'Artifact suppressed'}},{status:404}))));
  assert.ok(screen.getByRole('button',{name:'Retry protected view'}));assert.equal(screen.queryByText(unavailableText),null);
  await act(async()=>old.finish(Response.json(f.value)));
  assert.equal(screen.queryByText('Independent artifact body'),null);assert.equal(screen.queryByRole('button',{name:'Download source.txt'}),null);assert.equal(m.pending(f.path).length,0);
});

test('late source success cannot disclose attribution after a newer source denial',async t=>{
  const f=artifactFixture(),m=mountResource(t,f);
  await m.answer(f.path,f.value);await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Source attribution'})));
  const old=m.pending(f.provenance).at(-1)!;
  await act(async()=>{void m.router.navigate(`/loom/resource/${f.id}/${f.revision}`);});
  await m.answer(f.path,f.value);await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Source attribution'})));
  await m.answer(f.provenance,f.unavailable);await m.answer(f.path,f.value);
  const sourceFields={state:'available',...source(),discussion_id:randomUUID(),contributor_id:randomUUID(),revision_publisher_id:randomUUID(),uploader_id:randomUUID()};
  await act(async()=>old.finish(Response.json({...f.unavailable,source:sourceFields})));
  assert.ok(screen.getByText(unavailableText));assert.ok(screen.getByText('Independent artifact body'));
  assert.equal(screen.queryByRole('link',{name:'Exact source revision'}),null);assert.equal(screen.queryByText(/Original contributor/),null);
});

test('late unavailable attribution cannot rearm resource reads after navigation or identity replacement',async t=>{
  for(const identity of [false,true]){
    const f=artifactFixture(),m=mountResource(t,f);
    await m.answer(f.path,f.value);await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Source attribution'})));
    const pending=m.pending(f.provenance).at(-1)!;
    await act(async()=>{if(identity)invalidateIdentity();else void m.router.navigate('/other');});
    const before=m.calls.length;
    await act(async()=>pending.finish(Response.json(f.unavailable)));
    assert.equal(m.calls.length,before);assert.equal(screen.queryByText(unavailableText),null);assert.equal(screen.queryByText('Independent artifact body'),null);cleanup();
  }
});

test('attribution transient errors retry independently and closing returns to the exact artifact',async t=>{
  const f=artifactFixture(),m=mountResource(t,f);
  await m.answer(f.path,f.value);await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Source attribution'})));
  await m.answer(f.path,f.value);
  await act(async()=>m.pending(f.provenance).forEach(c=>c.finish(Response.json({error:{code:'service_unavailable',message:'Retry attribution read'}},{status:503}))));
  assert.ok(screen.getByText('Independent artifact body'));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry source attribution'})));
  await m.answer(f.provenance,{...f.unavailable,source:{state:'available',...source(),discussion_id:randomUUID(),contributor_id:randomUUID(),revision_publisher_id:randomUUID(),uploader_id:randomUUID()}});
  assert.ok(screen.getByRole('link',{name:'Exact source revision'}));
  await act(async()=>fireEvent.click(screen.getByRole('link',{name:'Close source attribution'})));
  await m.answer(f.path,f.value);assert.ok(screen.getByRole('button',{name:'Source attribution'}));assert.equal(screen.queryByText(/Original contributor/),null);
});

test('a transient independent revision read keeps explicit retry and independently checked history available',async t=>{
  const f=artifactFixture(),m=mountResource(t,f);
  await m.answer(f.path,f.value);await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Source attribution'})));
  await act(async()=>m.pending(f.path).forEach(c=>c.finish(Response.json({error:{code:'service_unavailable',message:'Retry artifact read'}},{status:503}))));
  assert.ok(screen.getByText('Retry artifact read'));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Revision history'})));
  assert.ok(screen.getByRole('heading',{name:'Retained revisions'}));assert.ok(m.pending(`/api/v1/resources/${f.id}/history`).length);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Revision history'})));
  assert.equal(screen.queryByRole('heading',{name:'Retained revisions'}),null);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry revision'})));
  await m.answer(f.path,f.value);assert.ok(screen.getByText('Independent artifact body'));
});

test('a late unavailable source still revokes a newer attribution view without authorizing a retry',async t=>{
  const f=artifactFixture(),m=mountResource(t,f);
  await m.answer(f.path,f.value);await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Source attribution'})));
  const old=m.pending(f.provenance).at(-1)!;
  await act(async()=>{void m.router.navigate(`/loom/resource/${f.id}/${f.revision}`);});
  await m.answer(f.path,f.value);await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Source attribution'})));
  await m.answer(f.path,f.value);
  await m.answer(f.provenance,{...f.unavailable,source:{state:'available',...source(),discussion_id:randomUUID(),contributor_id:randomUUID(),revision_publisher_id:randomUUID(),uploader_id:randomUUID()}});
  assert.ok(screen.getByRole('link',{name:'Exact source revision'}));const before=m.calls.length;
  await act(async()=>old.finish(Response.json(f.unavailable)));
  assert.equal(screen.queryByRole('link',{name:'Exact source revision'}),null);assert.equal(screen.queryByText('Independent artifact body'),null);
  assert.ok(screen.getByRole('button',{name:'Retry protected view'}));assert.equal(m.calls.length,before);
});
