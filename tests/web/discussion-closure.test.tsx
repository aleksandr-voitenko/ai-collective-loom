import assert from 'node:assert/strict';
import {test,afterEach,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode} from 'react';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {ActiveView} from '../../src/web/ParticipationRoutes.js';
import {IntentStore,invalidateIdentity} from '../../src/web/participation-client.js';
import type {Context} from '../../src/web/participation-state.js';
import type {RevisionView} from '../../src/contracts/participation.js';
const locks=navigator.locks,dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent','FormData'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
const {render,screen,fireEvent,cleanup,act,waitFor}=await import('@testing-library/react');
afterEach(()=>{cleanup();invalidateIdentity();localStorage.clear();});
function fixture(t:TestContext,kind='contribution',uncertain=false){
 const id=randomUUID(),revision=randomUUID(),discussion=randomUUID(),participant=randomUUID(),instance=randomUUID();
 const context={self:{participant_id:participant,credential_id:randomUUID(),nickname:'Editor',role:'participant',kind:'human',csrf:'fixture'},community:{instance_id:instance},store:new IntentStore(instance,participant,localStorage,location.origin,locks)} as Context;
 const person={id:participant,nickname:'Editor',kind:'human'};
 const value:RevisionView={resource_id:id,kind,title:'Readable retained title',revision_id:revision,current_revision_id:revision,revision_number:'1',author:person,publisher:person,created_at:'2026-10-25T00:00:00Z',area_id:randomUUID(),area_title:'Topic',discussion_id:discussion,parent_id:null,can_edit:true,publication_open:true,full_content_url:'/api/v1/resources/'+id,content:{format:'loom-markdown-v2',text:'Independently readable retained history',mentions:[],references:[]},mentioned_participants:[]};
 const calls:{path:string;raw:string|undefined;finish:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string,options?:RequestInit)=>{
   if(path==='/api/v1/resources/'+id&&!options?.method)return Promise.resolve(Response.json(value));
   if(options?.method==='POST'&&['/api/v1/revisions','/api/v1/summary-revisions','/api/v1/operations/status','/api/v1/summaries/status'].includes(path))return new Promise<Response>(finish=>calls.push({path,raw:String(options.body),finish}));
   return Promise.resolve(Response.json({error:{code:'service_unavailable',message:'Ancillary retrieval is unavailable in this fixture'}},{status:503}));
 });
 const body={resource_id:id,expected_revision_id:revision,title:value.title,content:{...value.content,format:kind==='summary'?'loom-markdown-v2':'loom-markdown-v3',text:'Prepared exact text'},...(kind==='summary'?{coverage:{carry_forward_revision_id:revision}}:{change_note:null,change_account:null,attachment_set:{version:'contribution-attachments-v1',files:[]}})};
 async function mount(){
   const r=context.store.create('edit:'+id,kind==='summary'?'summary.revise':'revision.publish',kind==='summary'?'/api/v1/summary-revisions':'/api/v1/revisions',body);
   const record=uncertain?await context.store.prepareDispatch(r,r.body):await context.store.saveDraft(r,r.body);
   const router=createMemoryRouter([{path:'/loom/*',element:<ActiveView context={context}/>},{path:'/other',element:<h1>Other route</h1>}],{initialEntries:['/loom/resource/'+id+'?intent='+record.key]});
   render(<StrictMode><RouterProvider router={router}/></StrictMode>);t.after(()=>router.dispose());await screen.findByText(value.content.text);
   await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Edit this text'})));await screen.findByLabelText('Text');return {record,router};
 }
 return {context,value,calls,mount};
}
for(const kind of ['contribution','summary'])for(const uncertain of [false,true])test(`production resource host retains history and exact ${kind} intent on certified closure, uncertain=${uncertain}`,async t=>{
 const f=fixture(t,kind,uncertain),{record}=await f.mount();
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:uncertain?'Retry same publication':'Publish'})));
 await waitFor(()=>assert.equal(f.calls.length,1));if(uncertain)assert.equal(f.calls[0]!.raw,JSON.stringify(record.body));else assert.deepEqual(JSON.parse(f.calls[0]!.raw!),record.body);
 await act(async()=>f.calls[0]!.finish(Response.json({error:{code:'forbidden',message:'Publication is closed',forbidden_reason:'publication_closed'}},{status:403})));
 await screen.findByText('Publication is closed');assert.ok(screen.getByText(f.value.content.text));assert.ok(screen.getByRole('heading',{name:f.value.title!}));
 assert.deepEqual(f.context.store.all()[0]!.body,record.body);assert.equal(f.context.store.all()[0]!.state,uncertain?'uncertain':'rejected');
});
for(const code of ['forbidden','unavailable','invalid_actor'])test('production resource host still withdraws genuine '+code+' refusal while preserving uncertain request',async t=>{
 const f=fixture(t,'contribution',true),{record}=await f.mount();await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry same publication'})));await waitFor(()=>assert.equal(f.calls.length,1));
 await act(async()=>f.calls[0]!.finish(Response.json({error:{code,message:'Authority withdrawn'}},{status:code==='unavailable'?404:403})));
 assert.equal(screen.queryByText(f.value.content.text),null);assert.deepEqual(f.context.store.all()[0]!.body,record.body);
});

function organizationFixture(t:TestContext,kind:'discussion.close'|'discussion.open'){
 const resource=randomUUID(),area=randomUUID(),participant=randomUUID(),instance=randomUUID();
 const context={self:{participant_id:participant,credential_id:randomUUID(),nickname:'Administrator',role:'administrator',kind:'human',csrf:'fixture'},community:{instance_id:instance},store:new IntentStore(instance,participant,localStorage,location.origin,locks)} as Context;
 const projection={resource_id:resource,kind:'discussion',parent_id:area,version:4,hierarchy_version:7,title:'Retained discussion',description:null,metadata_version:null,local_open:kind.endsWith('.close'),publication_open:false,can_organize:true,ancestors:[{id:area,title:'Closed topic'}],contacts_url:'/api/v1/contacts',proposal_route_url:'/api/v1/areas/'+area+'/proposal-route'};
 const calls:{path:string;raw:string;finish:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string,options?:RequestInit)=>{
   if(path==='/api/v1/organization/resources/'+resource)return Promise.resolve(Response.json(projection));
   return new Promise<Response>(finish=>calls.push({path,raw:String(options?.body),finish}));
 });
 function mount(intent?:string){
   const router=createMemoryRouter([{path:'/loom/*',element:<ActiveView context={context}/>},{path:'/other',element:<h1>Another view</h1>}],{initialEntries:['/loom/organize?'+(intent?'intent='+intent:'target='+resource+'&action='+kind)]});
   render(<StrictMode><RouterProvider router={router}/></StrictMode>);t.after(()=>router.dispose());return router;
 }
 const outcome=(local:boolean,currentLocal=local)=>({operation_state:'committed',operation_id:randomUUID(),kind,idempotency:'replayed',outcome:{resource_id:resource,parent_id:area,version:5,hierarchy_version:8,local_open:local},current:{...projection,version:6,hierarchy_version:9,local_open:currentLocal}});
 return {context,resource,area,projection,calls,mount,outcome};
}
for(const kind of ['discussion.close','discussion.open'] as const)test('production organization host persists '+kind+' before dispatch and explains inherited closure',async t=>{
 const f=organizationFixture(t,kind),other=f.context.store.create('other','reply.create','/api/v1/replies',{content:'Unrelated draft'});await f.context.store.saveDraft(other,other.body);f.mount();
 const name=kind.endsWith('.close')?'Confirm close':'Confirm reopen';await screen.findByRole('button',{name});
 const original=dom.window.Storage.prototype.setItem;let fail=true;
 t.mock.method(dom.window.Storage.prototype,'setItem',function(this:Storage,key:string,value:string){if(fail&&key.startsWith(f.context.store.prefix))throw new Error('Local persistence failed');original.call(this,key,value);});
 await act(async()=>fireEvent.click(screen.getByRole('button',{name})));await screen.findByText('Local persistence failed');assert.equal(f.calls.length,0);assert.equal(f.context.store.all().length,1);
 fail=false;await act(async()=>fireEvent.click(screen.getByRole('button',{name})));await waitFor(()=>assert.equal(f.calls.length,1));
 const record=f.context.store.all().find(r=>r.kind==='organization.change')!;assert.equal(record.state,'uncertain');assert.equal(f.calls[0]!.raw,JSON.stringify(record.body));assert.deepEqual(record.body,{kind,resource_id:f.resource,expected_version:4,expected_hierarchy_version:7,idempotency_key:record.key});
 await act(async()=>f.calls[0]!.finish(Response.json(f.outcome(kind.endsWith('.open')))));
 await screen.findByText('Organization change confirmed.');assert.equal(f.context.store.all().find(r=>r.key===record.key)!.state,'committed');assert.deepEqual(f.context.store.all().find(r=>r.key===other.key)!.body,other.body);
 if(kind.endsWith('.open'))assert.ok(screen.getByText(/locally open.*ancestor topic is still closed/i));
});
test('production organization host preserves uncertain K1 and separates its closed outcome from current open state',async t=>{
 const f=organizationFixture(t,'discussion.close');let record=f.context.store.create('organization:discussion.close:'+f.resource,'organization.change','/api/v1/organization/changes',{kind:'discussion.close',resource_id:f.resource,expected_version:4,expected_hierarchy_version:7});record=await f.context.store.prepareDispatch(record,record.body);f.mount(record.key);
 await screen.findByRole('button',{name:'Check organization status'});await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check organization status'})));await waitFor(()=>assert.equal(f.calls.length,1));
 assert.deepEqual(JSON.parse(f.calls[0]!.raw),{kind:'discussion.close',idempotency_key:record.key});await act(async()=>f.calls[0]!.finish(Response.json({operation_state:'not_recorded'})));await screen.findByText('Confirmation is unavailable. Keep this exact request; it may still commit.');assert.deepEqual(f.context.store.all()[0],record);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry same organization change'})));await waitFor(()=>assert.equal(f.calls.length,2));assert.equal(f.calls[1]!.raw,JSON.stringify(record.body));await act(async()=>f.calls[1]!.finish(Response.json(f.outcome(false,true))));await screen.findByText('Organization change confirmed.');
 assert.ok(screen.getByText(/Original decision: locally closed/));assert.ok(screen.getByText(/Current discussion: locally open/));assert.deepEqual(f.context.store.all()[0]!.body,record.body);
});
