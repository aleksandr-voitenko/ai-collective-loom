import {AuthorizationBoundary} from '../../src/web/AuthorizationBoundary.js';
import assert from 'node:assert/strict';
import {afterEach,test,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode,useState} from 'react';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {ChangeAccountEditor,ChangeNoteEditor,ChangeDiscoveryViewComponent} from '../../src/web/Changes.js';
import {invalidateIdentity} from '../../src/web/participation-client.js';
import type {ResolvedTargetView} from '../../src/contracts/references.js';
import type {ChangeAccountValue,NoteContent} from '../../src/contracts/participation.js';
import type {ChangeDiscoveryView} from '../../src/contracts/changes.js';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://loom.example/' });
for (const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
const { render, screen, fireEvent, cleanup, act, waitFor } = await import('@testing-library/react');
afterEach(() => cleanup());
function resolved():ResolvedTargetView {
  const id=randomUUID(),revision=randomUUID(),person={id:randomUUID(),nickname:'author',kind:'human'};
  return {state:'available',target:{kind:'artifact',resource_id:id,revision_id:revision},scope:'revision',browser_url:'/loom/resource/'+id+'/'+revision,context_url:'/loom/resource/'+id,
    representation:{resource_id:id,revision_id:revision,kind:'artifact',title:'Exact target',revision_number:'1',author:person,publisher:person,created_at:'2026-10-16T12:00:00Z',
      area_id:randomUUID(),area_title:'General',discussion_id:null,parent_id:null,can_edit:false,publication_open:true,full_content_url:'/api/v1/resources/'+id+'/revisions/'+revision}};
}

function Editor(){const [account,setAccount]=useState<ChangeAccountValue|null>(null),[note,setNote]=useState<NoteContent|null>(null);
  return <><ChangeAccountEditor value={account} disabled={false} onChange={setAccount}/><ChangeNoteEditor value={note} disabled={false} onChange={setNote}/><output>{JSON.stringify({account,note})}</output></>;}
function mount(t:TestContext,editor=true){const calls:{path:string;finish:(response:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(path:string)=>new Promise<Response>(finish=>calls.push({path,finish})));
  const router=createMemoryRouter([{path:'/changes',element:<AuthorizationBoundary>{editor?<Editor/>:<ChangeDiscoveryViewComponent kind="artifact" resource={randomUUID()} revision={randomUUID()}/>}</AuthorizationBoundary>},{path:'/other',element:<h1>Other context</h1>}],{initialEntries:['/changes']});
  t.after(()=>router.dispose());render(<StrictMode><RouterProvider router={router}/></StrictMode>);return {calls,router};}
function result():ChangeDiscoveryView{return {items:[],scope:'exact_revision',history:'current',form:null,order:'source_revision_uuid_then_field_then_described_revision_uuid',omitted_detail:'bodies; full_account_sets; unavailable_sources_or_targets; other_target_resources',next_cursor:null,complete:true,work_budget_reached:false,limit:12,max_response_bytes:131072,expires_at:'2026-10-16T12:00:00Z'};}
test('StrictMode exact account selection rejects late edits and route/account completions',async t=>{
  const {calls,router}=mount(t),target=resolved();
  await act(async()=>fireEvent.click(screen.getByLabelText('Explain a declared set of changes in this post')));
  await act(async()=>fireEvent.change(screen.getByLabelText('Described resource ID or exact Loom link'),{target:{value:target.browser_url}}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check described revision'})));
  await act(async()=>{fireEvent.change(screen.getByLabelText('Described resource ID or exact Loom link'),{target:{value:randomUUID()}});calls[0]!.finish(Response.json(target));});
  assert.ok(!screen.queryByRole('button',{name:'Describe this exact revision'}));
  await act(async()=>fireEvent.change(screen.getByLabelText('Described resource ID or exact Loom link'),{target:{value:target.browser_url}}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check described revision'})));
  await act(async()=>router.navigate('/other'));await act(async()=>calls[1]!.finish(Response.json(target)));assert.ok(screen.getByRole('heading',{name:'Other context'}));
  await act(async()=>router.navigate('/changes'));
  await act(async()=>fireEvent.click(screen.getByLabelText('Explain a declared set of changes in this post')));
  await act(async()=>fireEvent.change(screen.getByLabelText('Described resource ID or exact Loom link'),{target:{value:target.browser_url}}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check described revision'})));
  await act(async()=>{invalidateIdentity();calls[2]!.finish(Response.json(target));});assert.ok(!screen.queryByRole('button',{name:'Describe this exact revision'}));
  assert.equal(!!screen.queryByLabelText('Described resource ID or exact Loom link'),false);
});
test('StrictMode account retry confirms an exact set and note preview keeps HTML inert',async t=>{
  const {calls}=mount(t),target=resolved();await act(async()=>fireEvent.click(screen.getByLabelText('Explain a declared set of changes in this post')));
  await act(async()=>fireEvent.change(screen.getByLabelText('Described resource ID or exact Loom link'),{target:{value:target.browser_url}}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check described revision'})));
  await act(async()=>calls[0]!.finish(Response.json({error:{code:'unavailable',message:'Unavailable'}},{status:404})));assert.ok(screen.getByRole('alert'));
  assert.equal(!!screen.queryByRole('button',{name:'Check described revision'}),false);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry protected view'})));
  await act(async()=>fireEvent.click(screen.getByLabelText('Explain a declared set of changes in this post')));
  await act(async()=>fireEvent.change(screen.getByLabelText('Described resource ID or exact Loom link'),{target:{value:target.browser_url}}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check described revision'})));await act(async()=>calls[1]!.finish(Response.json(target)));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Describe this exact revision'})));
  assert.equal(document.activeElement,screen.getByLabelText('Described resource ID or exact Loom link'));assert.deepEqual(JSON.parse(screen.getByRole('status').textContent!).account,{revisions:[target.target]});
  await act(async()=>fireEvent.click(screen.getByLabelText('Add a revision change note')));await act(async()=>fireEvent.change(screen.getByLabelText('Change note'),{target:{value:'<img src=x onerror=evil()> `@raw`\n\n> @quoted'}}));
  assert.ok(screen.getByLabelText('Change note'));assert.equal(document.querySelectorAll('.change-note-editor img, .change-note-editor script').length,0);assert.equal(JSON.parse(screen.getByRole('status').textContent!).note.mentions.length,0);
});
test('StrictMode discovery retains failed-page position and focuses explicit local retry',async t=>{
  const {calls}=mount(t,false);await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Discover change explanations'})));await waitFor(()=>assert.equal(calls.length,2));
  await act(async()=>calls[1]!.finish(Response.json({...result(),next_cursor:'next-position',complete:false})));await act(async()=>calls[0]!.finish(Response.json(result())));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Next explanations'})));await act(async()=>calls[2]!.finish(Response.json({error:{code:'service_unavailable',message:'Try again'}},{status:503})));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry explanations'})));assert.equal(calls[3]!.path,calls[2]!.path);await act(async()=>calls[3]!.finish(Response.json(result())));
  assert.equal(document.activeElement,screen.getByRole('heading',{name:'Change explanations'}));assert.ok(screen.getByText('No eligible explanations in this scope.'));
});
