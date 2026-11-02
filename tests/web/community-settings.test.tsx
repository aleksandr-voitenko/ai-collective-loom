import assert from 'node:assert/strict';
import {afterEach,test,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode} from 'react';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {Value} from '@sinclair/typebox/value';
import {ActiveView} from '../../src/web/ParticipationRoutes.js';
import {Onboarding,Page} from '../../src/contracts/participation.js';
import {OrganizationPage} from '../../src/contracts/organization.js';
import {IntentStore,invalidateIdentity,sessionRequest,commandRequest} from '../../src/web/participation-client.js';
import {intentUrl,type Context} from '../../src/web/participation-state.js';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/loom/admin/community'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent'] as const)
 Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
const {render,screen,fireEvent,cleanup,act,within}=await import('@testing-library/react');
afterEach(()=>{cleanup();invalidateIdentity();localStorage.clear();});
const overview='10000000-0000-4000-8000-000000000001',proposal='10000000-0000-4000-8000-000000000002';
const changed='10000000-0000-4000-8000-000000000003',otherTopic='10000000-0000-4000-8000-000000000004';
const click=async(name:string)=>act(async()=>fireEvent.click(screen.getByRole('button',{name})));
const failure=(code:string,status:number)=>Response.json({error:{code,message:'Synthetic '+code}},{status});
const receipt=(version:number)=>Response.json({operation_state:'committed',operation_id:randomUUID(),version});
const selected=(heading:string)=>within(screen.getByRole('region',{name:heading}));
const dirty=()=>!!screen.queryByText('Unsaved changes');
async function fixture(t:TestContext,options:{lookupFails?:boolean;initialReadFails?:boolean;unavailable?:boolean;paged?:boolean;pageCount?:number;choicesFail?:boolean}={}){
 const self={participant_id:randomUUID(),credential_id:randomUUID(),nickname:'Synthetic admin',kind:'human',role:'administrator',csrf:'fixture'};
 t.mock.method(globalThis,'fetch',async()=>Response.json(self));await sessionRequest('/api/v1/identity/self');
 const community=Value.Create({...Onboarding,properties:{...Onboarding.properties,instance_id:{...Onboarding.properties.instance_id,default:randomUUID()}}});
 community.settings_version=1;community.community_name='Synthetic community';
 community.overview=options.unavailable?{state:'unavailable'}:{state:'ready',resource_id:overview};community.proposal_area={state:'ready',resource_id:proposal};
 const resources=[
  {id:overview,kind:'artifact',title:'Community introduction',parent:'Shared work'},
  {id:changed,kind:'artifact',title:'Community introduction',parent:'Research'},
  {id:proposal,kind:'area',title:'Proposals',parent:'Shared work'},
  {id:otherTopic,kind:'area',title:'Proposals',parent:'Research'},
 ].map(r=>({parent_id:null,version:1,hierarchy_version:1,description:null,metadata_version:null,local_open:true,can_organize:true,contacts_url:'/api/v1/contacts',proposal_route_url:'/api/v1/proposals',resource_id:r.id,kind:r.kind as 'area'|'artifact',title:r.title,publication_open:true,ancestors:[{id:randomUUID(),title:r.parent}]}));
 let shellRefreshes=0,holdReads=false,failLookup=!!options.lookupFails,failInitial=!!options.initialReadFails,failChoices=!!options.choicesFail;
 const paged=options.paged,pageCount=options.pageCount;
 const reads:string[]=[],calls:{path:string;method:string;body:any;finish:(response:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string,options?:RequestInit)=>{
  if(!options?.body)reads.push(path);
  if(path==='/api/v1/identity/self')return Promise.resolve(Response.json(self));
  if(path==='/api/v1/community'&&!holdReads)return Promise.resolve(failInitial?failure('service_unavailable',503):Response.json(community));
  if(path.startsWith('/api/v1/organization/resources/'))return Promise.resolve(failLookup?failure('service_unavailable',503):Response.json(resources.find(r=>path.endsWith(r.resource_id))));
  if(path.startsWith('/api/v1/organization/destinations?')){
   if(pageCount){
    const page=Number(new URL(path,'https://loom.example').searchParams.get('cursor')??0);
    return Promise.resolve(Response.json({...Value.Create(OrganizationPage),items:[{...resources[2],title:'Choices page '+(page+1)}],complete:page===pageCount-1,next_cursor:page<pageCount-1?String(page+1):null}));
   }
   const next=path.includes('cursor=next');
   return Promise.resolve(failChoices?failure('service_unavailable',503):Response.json({...Value.Create(OrganizationPage),items:resources.filter(r=>r.kind==='area'&&(!paged||r.resource_id===(next?otherTopic:proposal))),complete:!paged||next,next_cursor:paged&&!next?'next':null}));
  }
  if(path.startsWith('/api/v1/artifacts?'))return Promise.resolve(Response.json({...Value.Create(Page),items:resources.filter(r=>r.kind==='artifact').map(r=>({resource_id:r.resource_id,title:r.title,kind:r.kind,revision_id:randomUUID(),revision_number:'1',author:{id:self.participant_id,nickname:'Synthetic admin',kind:'human'},publisher:{id:self.participant_id,nickname:'Synthetic admin',kind:'human'},created_at:'2026-11-01T00:00:00Z',area_id:proposal,area_title:'Shared work',discussion_id:null,parent_id:null,can_edit:true,publication_open:true,full_content_url:'/api/v1/resources/'+r.resource_id})),complete:true,next_cursor:null}));
  if(path==='/api/v1/guide')return Promise.resolve(Response.json({text:'Synthetic guide'}));
  return new Promise<Response>(finish=>calls.push({path,method:options?.method??'GET',body:options?.body?JSON.parse(String(options.body)):undefined,finish}));
 });
 const context={self,community,store:new IntentStore(community.instance_id,self.participant_id),refreshCommunity:()=>{shellRefreshes++;}} as Context;
 const router=createMemoryRouter([{path:'/loom/*',element:<ActiveView context={context}/>}],{initialEntries:['/loom/admin/community']});t.after(()=>router.dispose());
 await act(async()=>{render(<StrictMode><RouterProvider router={router}/></StrictMode>);});
 return {self,community,calls,reads,router,store:context.store,holdReads:()=>{holdReads=true;},allowReads:()=>{holdReads=false;failInitial=false;},allowLookup:()=>{failLookup=false;},allowChoices:()=>{failChoices=false;},shellRefreshes:()=>shellRefreshes,
  writes:()=>calls.filter(c=>c.path.endsWith('/settings')),
  finish:async(response:Response)=>act(async()=>calls.at(-1)!.finish(response))};
}
async function choose(kind:'overview'|'proposal',location='Research'){
 await click('Change '+(kind==='overview'?'community overview':'proposal topic'));
 await click('Choose '+(kind==='overview'?'Community introduction in '+location:'Proposals in '+location+' › Proposals'));
}
async function conflict(f:Awaited<ReturnType<typeof fixture>>){await click('Save changes');await f.finish(failure('revision_conflict',409));}

test('settings load on entry with titles and locations, bounded pickers hide IDs and Cancel restores locally',async t=>{
 const f=await fixture(t);assert.ok(selected('Community overview').queryByText('Shared work'));
 assert.ok(selected('Proposal topic').queryByText('Shared work › Proposals'));
 assert.equal((screen.getByRole('button',{name:'Save changes'}) as HTMLButtonElement).disabled,true);
 assert.equal(screen.queryByText(overview),null);
 await click('Change proposal topic');
 assert.ok(screen.getByRole('button',{name:'Choose Proposals in Shared work › Proposals'}));
 assert.ok(screen.getByRole('button',{name:'Choose Proposals in Research › Proposals'}));
 assert.equal((screen.getByRole('button',{name:'Next choices'}) as HTMLButtonElement).disabled,true);
 assert.ok(f.reads.includes('/api/v1/organization/destinations?limit=12'));
 await click('Choose Proposals in Research › Proposals');assert.equal(dirty(),true);
 const reads=[...f.reads];await click('Cancel');assert.equal(dirty(),false);
 assert.ok(selected('Proposal topic').queryByText('Shared work › Proposals'));
 assert.equal(f.reads.filter(p=>p==='/api/v1/community').length,reads.filter(p=>p==='/api/v1/community').length);assert.deepEqual(f.writes(),[]);
});

test('dirty read retains choices and expected version after a conflicting save; reads send no mutation',async t=>{
 const f=await fixture(t);await choose('overview');await conflict(f);f.holdReads();
 await click('Check saved settings');assert.ok(selected('Community overview').queryByText('Research'));assert.equal(dirty(),true);
 assert.equal(f.calls.at(-1)!.body,undefined);
 f.community.settings_version=2;f.community.community_name='Updated elsewhere';f.community.proposal_area.resource_id=otherTopic;
 await f.finish(Response.json(f.community));
 assert.ok(selected('Community overview').queryByText('Research'));assert.ok(selected('Proposal topic').queryByText('Shared work › Proposals'));
 assert.equal(f.writes().length,1);assert.equal(dirty(),true);
 assert.ok(screen.queryByText(/Community settings changed while/),'A settings read must not clear a separate conflict.');
 const saved=within(screen.getByRole('region',{name:'Saved choices'}));
 assert.ok(saved.getByText('Shared work'));assert.ok(saved.getByText('Research › Proposals'));
 assert.ok(screen.getByText('Saved choices checked. Your unsaved choices are unchanged.'));
 await click('Save changes');const {idempotency_key,...body}=f.calls.at(-1)!.body;
 assert.equal(typeof idempotency_key,'string');assert.deepEqual(body,{expected_version:1,community_name:'Synthetic community',overview_id:changed,proposal_area_id:proposal});
 await f.finish(failure('revision_conflict',409));assert.equal(f.shellRefreshes(),0);
});

for(const remount of [false,true])test(`lost conflict response resolves on exact settings retry; remount ${remount}`,async t=>{
 const f=await fixture(t);await choose('overview');await click('Save changes');const first=f.writes()[0]!.body;
 f.community.settings_version=2;await f.finish(failure('service_unavailable',503));
 if(remount){await act(async()=>f.router.navigate('/loom/help'));await act(async()=>f.router.navigate('/loom/admin/community'));}
 await click('Retry same save');assert.deepEqual(f.writes()[1]!.body,first);assert.equal(f.store.all()[0]!.state,'uncertain');
 await f.finish(failure('revision_conflict',409));
 assert.ok(screen.queryByText(/Community settings changed while/));assert.equal(screen.queryByRole('button',{name:'Retry same save'}),null);
 assert.deepEqual(f.store.all(),[]);assert.equal(dirty(),true);assert.ok(selected('Community overview').queryByText('Research'));
 assert.equal((screen.getByRole('button',{name:'Cancel'}) as HTMLButtonElement).disabled,remount,'A restored request cannot invent the earlier accepted baseline.');
 assert.equal(f.writes().length,2);assert.equal(screen.queryByText('Changes saved.'),null);
 let confirmed=false;t.mock.method(window,'confirm',()=>{confirmed=true;return false;});await click('Load saved settings');assert.equal(confirmed,true);
 await click('Save changes');assert.equal(f.writes()[2]!.body.expected_version,1);assert.equal(f.writes()[2]!.body.overview_id,changed);
 await f.finish(failure('revision_conflict',409));
});

test('saved comparison metadata withdraws independently of the retained draft',async t=>{
 const f=await fixture(t);await choose('overview');await conflict(f);await click('Check saved settings');
 assert.ok(screen.getByRole('region',{name:'Saved choices'}));assert.equal(dirty(),true);
 const refusal=commandRequest('/api/v1/identity/reconcile',{self:f.self,body:{operation_kind:'account.create',idempotency_key:randomUUID()}});const denied=assert.rejects(refusal,{code:'forbidden'});
 await act(async()=>{f.calls.at(-1)!.finish(failure('forbidden',403));await denied;});
 assert.equal(screen.queryByRole('region',{name:'Saved choices'}),null);assert.equal(screen.queryByText('Research'),null);assert.equal(dirty(),true);
 await click('Check access');assert.equal(screen.queryByRole('region',{name:'Saved choices'}),null,'Reauthorization cannot republish the old saved comparison.');
 assert.ok(selected('Community overview').queryByText('Research'));assert.equal(f.writes().length,1);
});

for(const code of ['forbidden','unavailable','service_unavailable','unknown-conflict'])test(`uncertain settings remain retained after ${code}`,async t=>{
 const f=await fixture(t);await choose('overview');await click('Save changes');const first=f.writes()[0]!.body;await f.finish(failure('service_unavailable',503));
 await click('Retry same save');assert.deepEqual(f.writes()[1]!.body,first);
 await f.finish(code==='unknown-conflict'?Response.json({error:{code:'revision_conflict',message:'Synthetic unknown outcome',operation_outcome:'unknown'}},{status:409}):failure(code,code==='forbidden'?403:code==='unavailable'?404:503));
 assert.equal(f.store.all()[0]!.state,'uncertain');assert.deepEqual(f.store.all()[0]!.body,first);
 assert.ok(screen.queryByRole('button',{name:'Retry same save'}));assert.equal(screen.queryByText(/Community settings changed while/),null);assert.equal(f.writes().length,2);
});

test('failed refresh then explicit successful reload clears obsolete read error and changes baseline only after success',async t=>{
 const f=await fixture(t);await choose('overview');await conflict(f);f.holdReads();
 await click('Check saved settings');await f.finish(failure('service_unavailable',503));
 assert.ok(screen.queryByText('Synthetic service_unavailable'));assert.equal(dirty(),true);
 f.community.settings_version=3;f.community.community_name='Saved elsewhere';f.community.proposal_area.resource_id=otherTopic;
 t.mock.method(window,'confirm',()=>false);const count=f.calls.length;await click('Load saved settings');assert.equal(f.calls.length,count);
 t.mock.method(window,'confirm',()=>true);await click('Load saved settings');
 assert.ok(selected('Community overview').queryByText('Research'));assert.equal(dirty(),true);
 assert.ok(screen.queryByText('Synthetic service_unavailable'));assert.equal(screen.queryByText('Saved settings loaded.'),null);
 await f.finish(Response.json(f.community));
 assert.ok(selected('Community overview').queryByText('Shared work'));assert.ok(selected('Proposal topic').queryByText('Research › Proposals'));
 assert.equal(dirty(),false);assert.equal(screen.queryByText('Synthetic service_unavailable'),null);assert.ok(screen.queryByText('Saved settings loaded.'));
 assert.equal(f.writes().length,1,'Neither read operation sends a settings mutation.');assert.equal(f.shellRefreshes(),0);
 await choose('overview');await click('Save changes');assert.equal(f.calls.at(-1)!.body.expected_version,3);assert.equal(f.calls.at(-1)!.body.community_name,'Saved elsewhere');
 await f.finish(failure('revision_conflict',409));await click('Check saved settings');await f.finish(failure('service_unavailable',503));
 assert.ok(screen.queryByText('Synthetic service_unavailable'),'A later failed read must still appear.');
});

test('failed explicit reload preserves draft and original save version',async t=>{
 const f=await fixture(t);await choose('overview');await conflict(f);f.holdReads();t.mock.method(window,'confirm',()=>true);
 await click('Load saved settings');await f.finish(failure('service_unavailable',503));
 assert.ok(selected('Community overview').queryByText('Research'));assert.equal(dirty(),true);
 assert.ok(screen.queryByText(/Community settings changed while/));
 await click('Check saved settings');await f.finish(Response.json(f.community));
 assert.equal(!!screen.queryByText('Synthetic service_unavailable'),false);
 await click('Save changes');assert.equal(f.calls.at(-1)!.body.expected_version,1);await f.finish(failure('invalid_input',400));
});

for(const response of ['rejection','conflict','failure','malformed','wrong-version'] as const)
test(`save ${response} retains choices without claiming success; uncertain attempts retry identical bytes`,async t=>{
 const f=await fixture(t);await choose('overview');await click('Save changes');const first=f.writes()[0]!.body;
 assert.equal((screen.getByRole('button',{name:'Saving changes…'}) as HTMLButtonElement).disabled,true);
 await click('Saving changes…');assert.equal(f.writes().length,1);assert.equal(screen.queryByText(/We couldn’t confirm/),null);
 await f.finish(response==='rejection'?failure('invalid_input',400):response==='conflict'?failure('revision_conflict',409):response==='failure'?failure('service_unavailable',503):response==='malformed'?Response.json({operation_state:'committed'}):receipt(4));
 assert.ok(selected('Community overview').queryByText('Research'));assert.equal(dirty(),true);assert.equal(screen.queryByText('Changes saved.'),null);assert.equal(f.shellRefreshes(),0);
 const uncertain=!['rejection','conflict'].includes(response);
 if(uncertain){assert.equal((screen.getByRole('button',{name:'Cancel'}) as HTMLButtonElement).disabled,true);assert.equal(f.store.all()[0]!.state,'uncertain');}
 await click(uncertain?'Retry same save':'Save changes');assert.equal(f.calls.at(-1)!.body.expected_version,1);
 if(uncertain)assert.deepEqual(f.calls.at(-1)!.body,first);else assert.notEqual(f.calls.at(-1)!.body.idempotency_key,first.idempotency_key);
 await f.finish(receipt(2));assert.ok(screen.queryByText('Changes saved.'));assert.equal(dirty(),false);
});

test('confirmed save adopts returned version even if follow-up read fails',async t=>{
 const f=await fixture(t);await choose('overview');await click('Save changes');f.holdReads();await f.finish(receipt(2));
 assert.equal(f.shellRefreshes(),1);assert.equal(dirty(),false);assert.ok(screen.queryByText('Changes saved.'));
 await f.finish(failure('service_unavailable',503));assert.ok(selected('Community overview').queryByText('Research'));
 await choose('proposal');await click('Save changes');assert.equal(f.calls.at(-1)!.body.expected_version,2);await f.finish(failure('invalid_input',400));
 await click('Retry saved settings');await f.finish(Response.json({...f.community,settings_version:4}));
 assert.ok(screen.queryByText('Synthetic invalid_input'),'A successful read must preserve a separate save rejection.');
});

for(const pending of ['refresh','discard','save'] as const)
test(`authority withdrawal fences pending ${pending}, hides metadata and requires explicit read before any further write`,async t=>{
 const f=await fixture(t);await choose('overview');if(pending!=='save')await conflict(f);f.holdReads();t.mock.method(window,'confirm',()=>true);
 const oldSave=screen.getByRole('button',{name:'Save changes'});
 await click(pending==='refresh'?'Check saved settings':pending==='discard'?'Load saved settings':'Save changes');const held=f.calls.at(-1)!;
 const refusal=commandRequest('/api/v1/identity/reconcile',{self:f.self,body:{operation_kind:'account.create',idempotency_key:randomUUID()}});const denied=assert.rejects(refusal,{code:'forbidden'});
 await act(async()=>{f.calls.at(-1)!.finish(failure('forbidden',403));await denied;});const count=f.calls.length,reads=[...f.reads];
 f.community.settings_version=2;await act(async()=>held.finish(pending==='save'?receipt(2):Response.json(f.community)));
 assert.equal(screen.queryByText('Research'),null);assert.equal(dirty(),true);
 await act(async()=>fireEvent.click(oldSave));assert.equal(f.calls.length,count);assert.deepEqual(f.reads,reads);assert.equal(f.shellRefreshes(),0);
 assert.equal(screen.queryByText('Changes saved.'),null);
 await click('Check access');await f.finish(Response.json(f.community));assert.ok(selected('Community overview').queryByText('Research'));
 await click(pending==='save'?'Retry same save':'Save changes');assert.equal(f.calls.at(-1)!.body.expected_version,1);await f.finish(receipt(2));
});

for(const departure of ['identity','route'] as const)
test(`pending save cannot revive settings or refresh after ${departure} departure`,async t=>{
 const f=await fixture(t);await choose('overview');await click('Save changes');const held=f.calls.at(-1)!;
 await act(async()=>{if(departure==='identity')invalidateIdentity();else await f.router.navigate('/loom/help');});const count=f.calls.length;
 await act(async()=>held.finish(receipt(2)));assert.equal(screen.queryByText('Research'),null);assert.equal(f.calls.length,count);assert.equal(f.shellRefreshes(),0);
 assert.equal(f.store.all()[0]!.state,'uncertain');
});

test('uncertain save survives route remount and retries the same operation instead of rebasing',async t=>{
 const f=await fixture(t);await choose('overview');await click('Save changes');const body=f.calls.at(-1)!.body;await f.finish(failure('service_unavailable',503));
 const record=f.store.all()[0]!;assert.equal(intentUrl(record),'/loom/admin/community?intent='+record.key);
 t.mock.method(window,'confirm',()=>{assert.fail('Persisted uncertainty is not unsaved navigation loss.');});
 await act(async()=>f.router.navigate('/loom/help'));f.community.settings_version=7;
 await act(async()=>f.router.navigate(intentUrl(record)));assert.ok(selected('Community overview').queryByText('Research'));
 await click('Retry same save');assert.deepEqual(f.calls.at(-1)!.body,body);await f.finish(receipt(2));assert.ok(screen.queryByText('Changes saved.'));
});

test('dirty navigation and unload warn only about actual unsaved loss; Cancel makes navigation clean',async t=>{
 const f=await fixture(t);await choose('overview');let prompts=0;t.mock.method(window,'confirm',()=>{prompts++;return false;});
 await act(async()=>f.router.navigate('/loom/help'));assert.equal(f.router.state.location.pathname,'/loom/admin/community');assert.equal(prompts,1);assert.equal(dirty(),true);
 const unload=new dom.window.Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
 await click('Cancel');const clean=new dom.window.Event('beforeunload',{cancelable:true});window.dispatchEvent(clean);assert.equal(clean.defaultPrevented,false);
 await act(async()=>f.router.navigate('/loom/help'));assert.equal(f.router.state.location.pathname,'/loom/help');assert.equal(prompts,1);assert.deepEqual(f.writes(),[]);
 await act(async()=>f.router.navigate('/loom/admin/community'));await choose('overview');
 t.mock.method(window,'confirm',()=>{prompts++;return true;});await act(async()=>f.router.navigate('/loom/help'));
 assert.equal(f.router.state.location.pathname,'/loom/help');assert.equal(prompts,2);assert.deepEqual(f.writes(),[]);
});

test('initial read failure is explicit and retry loads settings without a mutation',async t=>{
 const f=await fixture(t,{initialReadFails:true});assert.ok(screen.queryByText('Synthetic service_unavailable'));assert.equal(screen.queryByRole('button',{name:'Save changes'}),null);
 f.allowReads();await click('Retry saved settings');assert.ok(selected('Community overview').queryByText('Shared work'));assert.deepEqual(f.writes(),[]);
});

test('failed resource lookup never clears the saved selection or sends a null setting',async t=>{
 const f=await fixture(t,{lookupFails:true});assert.equal(screen.queryAllByText('Could not load this selection.').length,2);assert.equal(screen.queryByText('No selection yet.'),null);
 f.allowLookup();await choose('proposal');await click('Save changes');assert.equal(f.calls.at(-1)!.body.overview_id,overview);assert.equal(f.calls.at(-1)!.body.proposal_area_id,otherTopic);await f.finish(receipt(2));
});

test('an undisclosed unavailable designation withdraws metadata without manufacturing an empty selection',async t=>{
 const f=await fixture(t,{unavailable:true});assert.equal(screen.queryByText('No selection yet.'),null);assert.equal(screen.queryByRole('button',{name:'Save changes'}),null);
 assert.ok(screen.queryByText(/Access changed/));assert.equal(screen.queryByText('Loading community settings…'),null);assert.deepEqual(f.writes(),[]);
});

test('reauthorization checks current administrator role before any replacement metadata reads',async t=>{
 const f=await fixture(t);await choose('overview');await click('Save changes');await f.finish(failure('forbidden',403));
 f.self.role='participant';const reads=[...f.reads];await click('Check access');
 assert.deepEqual(f.reads.slice(reads.length),['/api/v1/identity/self']);assert.ok(screen.queryByText(/Administrator access is required/));
 assert.equal(screen.queryByText('Research'),null);assert.equal(dirty(),true);assert.equal(f.writes().length,1);
 f.self.role='administrator';await click('Check access');assert.equal(!!screen.queryByText(/Administrator access is required/),false);
 assert.ok(selected('Community overview').queryByText('Research'));
});


test('picker retries failure explicitly and traverses bounded pages without preloading',async t=>{
 const f=await fixture(t,{choicesFail:true,paged:true});await click('Change proposal topic');
 assert.ok(screen.queryByText('Synthetic service_unavailable'));assert.equal(screen.queryByText('No choices available.'),null);
 assert.ok(selected('Proposal topic').queryByText('Shared work › Proposals'));f.allowChoices();await click('Retry choices');
 assert.ok(screen.getByRole('button',{name:'Choose Proposals in Shared work › Proposals'}));
 assert.equal(screen.queryByRole('button',{name:'Choose Proposals in Research › Proposals'}),null);assert.equal(f.reads.some(p=>p.includes('cursor=')),false);
 await click('Next choices');assert.ok(screen.getByRole('button',{name:'Choose Proposals in Research › Proposals'}));
 assert.equal(document.activeElement,screen.getByRole('heading',{name:'Choose a proposal topic'}));
 assert.ok(f.reads.includes('/api/v1/organization/destinations?limit=12&cursor=next'));
 await click('Previous choices');assert.ok(screen.getByRole('button',{name:'Choose Proposals in Shared work › Proposals'}));
 await click('Close resource picker');assert.equal(dirty(),false);assert.deepEqual(f.writes(),[]);
});

test('picker can return to the first page after 18 forward transitions without losing selection or focus',async t=>{
 const f=await fixture(t,{pageCount:20});await choose('overview');
 const opener=screen.getByRole('button',{name:'Change proposal topic'});opener.focus();await click('Change proposal topic');
 const pageReads=()=>f.reads.filter(p=>p.startsWith('/api/v1/organization/destinations?'));
 const initial=pageReads().length;
 for(let i=0;i<18;i++){
  await click('Next choices');assert.ok(screen.getByText('Choices page '+(i+2)));
  assert.equal(document.activeElement,screen.getByRole('heading',{name:'Choose a proposal topic'}));
 }
 assert.equal(pageReads().length,initial+18,'Only requested bounded pages are fetched.');
 await click('First choices');assert.ok(screen.getByText('Choices page 1'));
 assert.equal(document.activeElement,screen.getByRole('heading',{name:'Choose a proposal topic'}));
 assert.equal((screen.getByRole('button',{name:'Previous choices'}) as HTMLButtonElement).disabled,true);
 assert.equal((screen.getByRole('button',{name:'First choices'}) as HTMLButtonElement).disabled,true);
 assert.equal(pageReads().length,initial+19);
 await click('Close resource picker');assert.equal(document.activeElement,opener);
 assert.ok(selected('Community overview').queryByText('Research'));assert.ok(selected('Proposal topic').queryByText('Shared work › Proposals'));assert.equal(dirty(),true);assert.deepEqual(f.writes(),[]);
});

test('journal persistence failure prevents settings dispatch and preserves the editable draft',async t=>{
 const f=await fixture(t);await choose('overview');t.mock.method(f.store,'prepareDispatch',async()=>{throw new Error('Synthetic private storage failure');});
 await click('Save changes');assert.deepEqual(f.writes(),[]);assert.equal(dirty(),true);assert.ok(selected('Community overview').queryByText('Research'));
 assert.ok(screen.queryByText('Synthetic private storage failure'));assert.equal(screen.queryByText('Changes saved.'),null);
});

test('a retained rejected request after local cleanup failure can deliberately reload saved settings on remount',async t=>{
 const f=await fixture(t);await choose('overview');const remove=t.mock.method(f.store,'remove',async()=>{throw new Error('Synthetic cleanup failure');});
 await click('Save changes');await f.finish(failure('invalid_input',400));assert.equal(f.store.all()[0]!.state,'rejected');assert.equal(dirty(),true);
 t.mock.method(window,'confirm',()=>true);await act(async()=>f.router.navigate('/loom/help'));await act(async()=>f.router.navigate('/loom/admin/community'));
 assert.ok(screen.queryByText(/This save was rejected/));assert.ok(selected('Community overview').queryByText('Research'));
 remove.mock.restore();f.holdReads();await click('Discard rejected save and load saved settings');await f.finish(Response.json(f.community));
 assert.deepEqual(f.store.all(),[]);assert.ok(selected('Community overview').queryByText('Shared work'));assert.equal(f.writes().length,1);
});


test('Local drafts recovery selects the requested settings operation without touching a sibling request',async t=>{
 const f=await fixture(t);const body={expected_version:1,community_name:'Synthetic community',overview_id:changed,proposal_area_id:proposal};
 const first=await f.store.prepareDispatch(f.store.create('community.settings','community.settings','/api/v1/community/settings',body),body);
 const secondBody={...body,expected_version:3,proposal_area_id:otherTopic};
 const second=await f.store.prepareDispatch(f.store.create('community.settings','community.settings','/api/v1/community/settings',secondBody),secondBody);
 await act(async()=>f.router.navigate(intentUrl(second)));assert.ok(selected('Proposal topic').queryByText('Research › Proposals'));
 await click('Retry same save');assert.deepEqual(f.calls.at(-1)!.body,second.body);await f.finish(receipt(4));
 assert.deepEqual(f.store.all(),[first]);
});
