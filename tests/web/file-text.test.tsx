import assert from 'node:assert/strict';
import {afterEach,test,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode} from 'react';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {ActiveView} from '../../src/web/ParticipationRoutes.js';
import {FileTextAdministration} from '../../src/web/FileText.js';
import {AuthorizationBoundary,useAuthorization} from '../../src/web/AuthorizationBoundary.js';
import {invalidateIdentity,IntentStore} from '../../src/web/participation-client.js';
import type {Context} from '../../src/web/participation-state.js';
import type {FileTextValue,FileSearchPageValue} from '../../src/contracts/file-text.js';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
const {render,screen,fireEvent,cleanup,act,waitFor}=await import('@testing-library/react');
afterEach(()=>{cleanup();invalidateIdentity();localStorage.clear();});
const id=randomUUID(),revision=randomUUID(),file=randomUUID(),person={id:randomUUID(),nickname:'publisher',kind:'human' as const};
const route=`/loom/file/artifact/${id}/${revision}/${file}`,base=`/api/v1/artifacts/${id}/revisions/${revision}/files/${file}`;
function value(patch:Partial<FileTextValue>={}):FileTextValue{return {resource_id:id,revision_id:revision,file_id:file,owner_kind:'artifact',path:'nested/chapter.txt',representation:'literal-utf8-v1',processing:'complete',reason:null,worker:'online',indexing:'indexed',retained_bytes:100,original_bytes:100,text:'<script>globalThis.pwned=1</script> @nickname',next_cursor:null,retained_text_complete:true,source_complete:true,download_url:base+'/download',context_url:`/api/v1/resources/${id}/revisions/${revision}`,browser_context_url:`/loom/resource/${id}/${revision}`,max_response_bytes:32768,...patch};}
const indexing={worker:'online',coverage:'retained_prefixes_ready',population:'current_eligible_file_contexts',qualification:'supported_utf8_prefixes_only'} as const;
function search(query='quartzneedle'):FileSearchPageValue{return {items:[{file_id:file,source_resource_id:id,revision_id:revision,owner_kind:'artifact',kind:'artifact',path:'nested/chapter.txt',title:'Package',author:person,publisher:person,published_at:'2026-10-23T00:00:00Z',area_id:randomUUID(),location:[],discussion_id:null,parent_id:null,matching_field:'file_contents',excerpt:'quartzneedle <img src="https://invalid.test">',extraction:'partial',indexing:'indexed',preview_url:base+'/text',browser_url:route,download_url:base+'/download',context_url:'/api/v1/resources/'+id,browser_context_url:'/loom/resource/'+id}],query,scope:{topic:null,descendants:false,kind:null,author:null,from:null,before:null},indexing,ranking:'simple-file-contents-v1',selection:'bounded_current_file_relevance',next_cursor:'next-files',window_exhausted:false,selection_limited:false,corpus_exhaustive:false,limit:12,max_response_bytes:131072,expires_at:'2030-01-01T00:00:00Z'};}
function mount(t:TestContext,initial=route){
  const calls:{path:string;done:boolean;finish:(r:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(path:string)=>new Promise<Response>(resolve=>{const c={path,done:false,finish(r:Response){c.done=true;resolve(r);}};calls.push(c);}));
  function Probe(){const a=useAuthorization();return <button onClick={()=>void a.read('/api/v1/resources/'+id).catch(()=>{})}>Check source authority</button>;}
  const c={community:{settings_version:1},store:new IntentStore(randomUUID(),person.id,localStorage,dom.window.location.origin),self:{participant_id:person.id,role:'administrator'}} as Context;
  const router=createMemoryRouter([{path:'/loom/*',element:<ActiveView context={c}/>},{path:'/other',element:<h1>Other view</h1>}],{initialEntries:[initial]});
  const view=render(<StrictMode><RouterProvider router={router}/><AuthorizationBoundary scope="probe"><Probe/></AuthorizationBoundary></StrictMode>);
  t.after(()=>{view.unmount();router.dispose();});
  async function answer(path:string,body:unknown,status=200){await waitFor(()=>assert.ok(calls.some(c=>!c.done&&c.path===path),'Expected '+path));await act(async()=>calls.filter(c=>!c.done&&c.path===path).forEach(c=>c.finish(Response.json(body,{status}))));}
  return {calls,router,answer};
}
test('StrictMode production file route renders inert text, exact identity, partial pages and useful processing states',async t=>{
  const m=mount(t);await m.answer(base+'/text',value({processing:'partial',reason:'output_limit',source_complete:false,next_cursor:'second',retained_text_complete:false}));
  assert.equal(document.querySelector('script'),null);assert.ok(screen.getByText(/globalThis.pwned=1/));assert.ok(screen.getByText(/unprocessed suffix/));assert.ok(screen.getByRole('heading',{name:'Literal text preview'}));
  assert.equal(m.calls.filter(c=>c.path.includes('/me/reading')).length,0);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Next text page'})));await m.answer(base+'/text?cursor=second',value({text:'page two',processing:'partial',source_complete:false}));
  assert.ok(screen.getByText('page two'));assert.equal(screen.queryByText(/globalThis.pwned/),null);
  await act(async()=>fireEvent.click(screen.getByRole('link',{name:'First text page'})));await m.answer(base+'/text',value({processing:'unsupported',reason:'invalid_utf8',text:null,indexing:'not_supported'}));
  assert.equal(screen.queryByLabelText('Literal file text'),null);assert.ok(screen.getByText(/invalid utf8/));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh text processing'})));await m.answer(base+'/text',value({processing:'failed',reason:'storage',text:null,indexing:'failed'}));assert.ok(screen.getByText(/Processing: failed/));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh text processing'})));await m.answer(base+'/text',value({processing:'queued',text:null,indexing:'pending',worker:'offline'}));assert.ok(screen.getByText(/Worker: offline/));
});
for(const departed of ['route','identity','denial'] as const)test('StrictMode late file success cannot restore text after '+departed,async t=>{
  const m=mount(t),held=m.calls.filter(c=>c.path===base+'/text');
  if(departed==='route')await act(async()=>m.router.navigate('/other'));
  else if(departed==='identity')await act(async()=>invalidateIdentity());
  else{await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check source authority'})));await m.answer('/api/v1/resources/'+id,{error:{code:'unavailable',message:'Source unavailable'}},404);}
  await act(async()=>held.forEach(c=>c.finish(Response.json(value()))));assert.equal(screen.queryByLabelText('Literal file text'),null);
});
test('StrictMode file retries and withdrawal remain bounded through available, unavailable and restored views',async t=>{
  const m=mount(t);await m.answer(base+'/text',{error:{code:'service_unavailable',message:'Temporary storage check failure'}},503);assert.ok(screen.getByRole('alert'));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry exact text preview'})));await m.answer(base+'/text',value());
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh text processing'})));await m.answer(base+'/text',{error:{code:'unavailable',message:'Source unavailable'}},404);
  assert.equal(screen.queryByLabelText('Literal file text'),null);
  await act(async()=>fireEvent.click(screen.getAllByRole('button',{name:'Retry protected view'})[0]!));await m.answer(base+'/text',value({text:'Restored exact file'}));assert.ok(screen.getByText('Restored exact file'));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh text processing'})));await m.answer(base+'/text',{error:{code:'unavailable',message:'Source unavailable again'}},404);assert.equal(screen.queryByText('Restored exact file'),null);
});
test('Files mode retains query/filter intent, starts a separate traversal and restores search after exact navigation',async t=>{
  const m=mount(t,'/loom/search?mode=files&q=quartzneedle&explanation=revision_note');
  await m.answer('/api/v1/search/files/status',indexing);await m.answer('/api/v1/search/files?q=quartzneedle',search());
  assert.ok(screen.getByText('quartzneedle <img src="https://invalid.test">'));assert.equal(document.querySelector('img'),null);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Next search results'})));await m.answer('/api/v1/search/files?q=quartzneedle&cursor=next-files',search());
  await act(async()=>fireEvent.change(screen.getByLabelText('Search mode'),{target:{value:'text'}}));
  assert.ok(m.router.state.location.search.includes('explanation=revision_note'));assert.ok(!m.router.state.location.search.includes('cursor='));
  assert.ok(m.calls.some(c=>c.path==='/api/v1/search?q=quartzneedle&explanation=revision_note'));
  await act(async()=>fireEvent.change(screen.getByLabelText('Search mode'),{target:{value:'files'}}));
  await m.answer('/api/v1/search/files?q=quartzneedle',search());
  await act(async()=>fireEvent.click(screen.getByRole('link',{name:'Open exact text preview'})));await m.answer(base+'/text',value());
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Back'})));await m.answer('/api/v1/search/files?q=quartzneedle',search());assert.ok(screen.getByRole('heading',{name:'Search results'}));
});
test('file administration loads only when opened and retains explicit bounded maintenance',async t=>{
  const calls:{path:string;finish:(r:Response)=>void}[]=[];t.mock.method(globalThis,'fetch',(path:string)=>new Promise<Response>(finish=>calls.push({path,finish})));
  const c={community:{settings_version:1},store:new IntentStore(randomUUID(),person.id,localStorage,dom.window.location.origin),self:{participant_id:person.id,role:'administrator'}} as Context;
  render(<StrictMode><AuthorizationBoundary sourcePolicy="settings"><FileTextAdministration context={c}/></AuthorizationBoundary></StrictMode>);assert.equal(calls.length,0);
  const details=screen.getByText('File text processing administration').parentElement as HTMLDetailsElement;
  await act(async()=>{details.open=true;fireEvent(details,new dom.window.Event('toggle'));});await waitFor(()=>assert.ok(calls.length));
  await act(async()=>calls.splice(0).forEach(c=>c.finish(Response.json({generation:1,worker:'online',retained_bytes:0,reserved_bytes:0,items:[{file_id:file,claim_generation:3,reason:'storage'}],next_after:file}))));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry file processing'})));await act(async()=>calls.splice(0).forEach(c=>c.finish(Response.json({accepted:true}))));
  await waitFor(()=>assert.ok(calls.length));await act(async()=>calls.splice(0).forEach(c=>c.finish(Response.json({generation:1,worker:'online',retained_bytes:0,reserved_bytes:0,items:[],next_after:null}))));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Start file text rebuild'})));await act(async()=>calls.splice(0).forEach(c=>c.finish(Response.json({generation:2}))));
});
test('independent status requests keep the newest observation and late owner/route responses cannot publish status',async t=>{
  const m=mount(t);await m.answer(base+'/text',value());
  for(let n=0;n<2;n++)await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check file status'})));
  const calls=m.calls.filter(c=>c.path===base+'/text/status');assert.equal(calls.length,2);
  await act(async()=>calls[1]!.finish(Response.json(value())));assert.ok(screen.getByText('Exact file processing: complete'));
  await act(async()=>calls[0]!.finish(Response.json(value({processing:'queued',text:null,indexing:'pending'}))));assert.equal(Boolean(screen.queryByText('Exact file processing: queued')),false);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check file status'})));const late=m.calls.at(-1)!;await act(async()=>m.router.navigate('/other'));await act(async()=>late.finish(Response.json(value({processing:'partial'}))));assert.equal(Boolean(screen.queryByText('Exact file processing: partial')),false);
});
test('Files search fences old query successes and a late same-owner denial withdraws the actual search host',async t=>{
  const m=mount(t,'/loom/search?mode=files&q=first');await m.answer('/api/v1/search/files/status',indexing);
  const held=m.calls.filter(c=>c.path==='/api/v1/search/files?q=first');
  await act(async()=>m.router.navigate('/loom/search?mode=files&q=second'));await m.answer('/api/v1/search/files?q=second',search('second'));assert.ok(screen.getByText('Results for “second”.'));
  await act(async()=>held[0]!.finish(Response.json(search('first'))));assert.equal(Boolean(screen.queryByText('Results for “first”.')),false);
  await act(async()=>held.at(-1)!.finish(Response.json({error:{code:'unavailable',message:'Source unavailable'}},{status:404})));assert.equal(Boolean(screen.queryByText('Results for “second”.')),false);assert.equal(Boolean(screen.queryByText('quartzneedle <img src="https://invalid.test">')),false);
});
for(const departure of ['route','identity'] as const)test('Files search ignores held positive content after '+departure,async t=>{
  const m=mount(t,'/loom/search?mode=files&q=held');await m.answer('/api/v1/search/files/status',indexing);const calls=m.calls.filter(c=>c.path==='/api/v1/search/files?q=held');
  await act(async()=>{if(departure==='route')void m.router.navigate('/other');else invalidateIdentity();});await act(async()=>calls.forEach(c=>c.finish(Response.json(search('held')))));assert.equal(Boolean(screen.queryByText('Results for “held”.')),false);
});
test('an expired exact text cursor offers a fresh first page without substituting the file',async t=>{
  const m=mount(t,route+'?cursor=expired');await m.answer(base+'/text?cursor=expired',{error:{code:'search_changed',message:'This text page changed or expired'}},409);
  await act(async()=>fireEvent.click(screen.getByRole('link',{name:'First text page'})));await m.answer(base+'/text',value());assert.ok(screen.getByLabelText('Literal file text'));assert.equal(m.router.state.location.pathname,route);
});

function resolvedFile(){return {state:'available',target:{kind:'artifact',resource_id:id,revision_id:revision,file_id:file,path:'nested/chapter.txt'},scope:'file',browser_url:route,context_url:'/loom/resource/'+id,representation:{resource_id:id,revision_id:revision,kind:'artifact',title:'Exact file owner',revision_number:'1',author:person,publisher:person,created_at:'2026-10-23T00:00:00Z',area_id:randomUUID(),area_title:'General',discussion_id:null,parent_id:null,can_edit:false,publication_open:true,full_content_url:`/api/v1/resources/${id}/revisions/${revision}`}};}
const targetQuery='/api/v1/references/target?'+new URLSearchParams({kind:'artifact',resource_id:id,revision_id:revision,file_id:file});
const incomingQuery='/api/v1/references/incoming?'+new URLSearchParams({kind:'artifact',resource_id:id,history:'current',revision_id:revision,file_id:file,path:'nested/chapter.txt',limit:'12'});
function fileReferences(next:string|null=null){return {items:[],direction:'incoming',scope:'file',target:resolvedFile().target,history:'current',relationship:null,order:'source_revision_uuid_then_field_then_reference_uuid',omitted_detail:'bodies; unrelated_target_scopes',next_cursor:next,complete:!next,work_budget_reached:!!next,limit:12,max_response_bytes:131072,expires_at:'2030-01-01T00:00:00Z'};}

test('production exact-file host resolves references independently of preview health and retains failed page position/focus',async t=>{
  const m=mount(t);await m.answer(targetQuery,resolvedFile());await m.answer(base+'/text',{error:{code:'service_unavailable',message:'Preview unavailable'}},503);
  assert.equal(screen.getByRole('link',{name:'Open exact publication'}).getAttribute('href'),`/loom/resource/${id}/${revision}`);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Referenced by · file'})));await m.answer(incomingQuery,fileReferences('exact-next'));
  assert.ok(screen.getByText(/Containing revision, sibling files/));
  const next=screen.getByRole('button',{name:'Next references'});next.focus();await act(async()=>fireEvent.click(next));
  await m.answer(incomingQuery+'&cursor=exact-next',{error:{code:'service_unavailable',message:'Temporary page failure'}},503);assert.equal(document.activeElement,next);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry reference page'})));await m.answer(incomingQuery+'&cursor=exact-next',fileReferences());
  assert.equal(document.activeElement,screen.getByRole('heading',{name:'Recorded reference results'}));assert.ok(screen.getByText('No recorded references in this scope.'));
  assert.equal(m.calls.filter(c=>/download|me\/|file-uploads/.test(c.path)).length,0);
});
for(const departure of ['route','identity','denial'] as const)test('production exact-file metadata and incoming successes cannot restore withdrawn '+departure+' authority',async t=>{
  const m=mount(t);await m.answer(targetQuery,resolvedFile());await m.answer(base+'/text',value());
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Referenced by · file'})));
  const late=m.calls.filter(c=>c.path===incomingQuery);
  if(departure==='route')await act(async()=>m.router.navigate('/other'));
  else if(departure==='identity')await act(async()=>invalidateIdentity());
  else{await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check file status'})));await m.answer(base+'/text/status',{error:{code:'unavailable',message:'Source unavailable'}},404);}
  await act(async()=>late.forEach(c=>c.finish(Response.json(fileReferences()))));
  assert.equal(screen.queryByText('No recorded references in this scope.'),null);assert.equal(screen.queryByRole('button',{name:'Referenced by · file'}),null);
});
