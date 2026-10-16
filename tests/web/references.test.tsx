import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { StrictMode, useState } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ReferenceEditor, ReferenceResults, targetFromSelection } from '../../src/web/References.js';
import { invalidateIdentity } from '../../src/web/participation-client.js';
import type { ReferenceValue } from '../../src/contracts/participation.js';
import type { ReferencePageView, ResolvedTargetView } from '../../src/contracts/references.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://loom.example/' });
for (const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
const { render, screen, fireEvent, cleanup, act, waitFor } = await import('@testing-library/react');
afterEach(() => cleanup());
function Editor() {
  const [references, setReferences] = useState<ReferenceValue[]>([]);
  return <><ReferenceEditor references={references} onChange={setReferences} disabled={false}/><output>{JSON.stringify(references)}</output></>;
}
function mount(t:TestContext, editor = false) {
  const calls:{path:string;finish:(response:Response)=>void}[] = [];
  t.mock.method(globalThis, 'fetch', (path:string) => new Promise<Response>(finish => calls.push({path,finish})));
  const router = createMemoryRouter([
    { path:'/references', element:editor?<Editor/>:<ReferenceResults path="/api/v1/references/incoming?kind=artifact"/> },
    { path:'/other', element:<h1>Another view</h1> },
  ], {initialEntries:['/references']});
  t.after(() => router.dispose());
  render(<StrictMode><RouterProvider router={router}/></StrictMode>);
  return {calls,router};
}
function result():ReferencePageView {
  return {items:[],direction:'incoming',scope:'resource',history:'current',relationship:null,order:'source_revision_uuid_then_field_then_reference_uuid',
    omitted_detail:'bodies; unrelated_target_scopes',next_cursor:null,complete:true,work_budget_reached:false,limit:12,max_response_bytes:131072,expires_at:'2026-10-16T12:00:00Z'};
}
function resolved():ResolvedTargetView {
  const id=randomUUID(),revision=randomUUID(),person={id:randomUUID(),nickname:'author',kind:'human'};
  return {state:'available',target:{kind:'artifact',resource_id:id,revision_id:revision},scope:'revision',browser_url:'/loom/resource/'+id+'/'+revision,context_url:'/loom/resource/'+id,
    representation:{resource_id:id,revision_id:revision,kind:'artifact',title:'Exact target',revision_number:'1',author:person,publisher:person,created_at:'2026-10-16T12:00:00Z',
      area_id:randomUUID(),area_title:'General',discussion_id:null,parent_id:null,can_edit:false,publication_open:true,full_content_url:'/api/v1/resources/'+id+'/revisions/'+revision}};
}
test('StrictMode reference pages settle, retain the failed position, and focus explicit recovery', async t => {
  const {calls}=mount(t);await waitFor(()=>assert.equal(calls.length,2));
  await act(async()=>calls[1]!.finish(Response.json({...result(),next_cursor:'position-two',complete:false})));
  await waitFor(()=>assert.ok(!screen.queryByText('Loading references…')));
  await act(async()=>calls[0]!.finish(Response.json(result())));
  assert.ok(screen.getByRole('button',{name:'Next references'}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Next references'})));
  await act(async()=>calls[2]!.finish(Response.json({error:{code:'service_unavailable',message:'Unavailable'}},{status:503})));
  assert.ok(screen.getByRole('alert'));assert.ok(screen.getByText(/previous page remains visible/));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry reference page'})));
  assert.equal(calls[3]!.path,calls[2]!.path);assert.match(calls[3]!.path,/cursor=position-two/);
  await act(async()=>calls[3]!.finish(Response.json(result())));
  assert.equal(document.activeElement,screen.getByRole('heading',{name:'Recorded reference results'}));
  assert.ok(screen.getByText('No recorded references in this scope.'));
});
test('StrictMode reference page completions cannot cross route or account ownership', async t => {
  const {calls,router}=mount(t);await waitFor(()=>assert.equal(calls.length,2));
  await act(async()=>{invalidateIdentity();calls[1]!.finish(Response.json(result()));});
  assert.ok(!screen.queryByText('No recorded references in this scope.'));
  await act(async()=>router.navigate('/other'));await act(async()=>calls[0]!.finish(Response.json(result())));
  assert.ok(screen.getByRole('heading',{name:'Another view'}));assert.ok(!screen.queryByRole('alert'));
});
test('StrictMode target validation recovers from failure, rejects late selections, and confirms exact scope', async t => {
  const {calls,router}=mount(t,true),target=resolved();
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Add reference'})));
  assert.equal(document.activeElement,screen.getByLabelText('Target ID or Loom link'));
  await act(async()=>{
    fireEvent.change(screen.getByLabelText('Target ID or Loom link'),{target:{value:target.browser_url}});
    fireEvent.change(screen.getByLabelText('Citation scope'),{target:{value:'revision'}});
    fireEvent.click(screen.getByRole('button',{name:'Check target'}));
  });
  await act(async()=>calls[0]!.finish(Response.json({error:{code:'unavailable',message:'Target unavailable'}},{status:404})));
  assert.ok(screen.getByRole('alert'));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check target'})));
  await act(async()=>calls[1]!.finish(Response.json(target)));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Use this exact revision'})));
  const declaration=JSON.parse(screen.getByRole('status').textContent!)[0];
  assert.deepEqual(declaration.target,target.target);assert.equal(declaration.relationship,null);
  assert.ok(screen.getByRole('combobox',{name:'Relationship 1'}));
  assert.equal(document.activeElement,screen.getByRole('button',{name:'Add reference'}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Change target 1'})));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check target'})));
  await act(async()=>{fireEvent.change(screen.getByLabelText('Target ID or Loom link'),{target:{value:randomUUID()}});calls[2]!.finish(Response.json(target));});
  assert.ok(!screen.queryByRole('button',{name:'Use this exact revision'}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check target'})));
  await act(async()=>router.navigate('/other'));await act(async()=>calls[3]!.finish(Response.json(target)));
  assert.ok(screen.getByRole('heading',{name:'Another view'}));
});
test('known target selection never fetches arbitrary links and keeps resource and exact scopes explicit', () => {
  const id=randomUUID(),revision=randomUUID();
  assert.deepEqual(targetFromSelection('/loom/resource/'+id+'/'+revision,'artifact','resource',''),{kind:'artifact',resource_id:id});
  assert.deepEqual(targetFromSelection('/loom/resource/'+id+'/'+revision,'artifact','revision',''),{kind:'artifact',resource_id:id,revision_id:revision});
  assert.throws(()=>targetFromSelection('https://other.example/loom/resource/'+id,'artifact','resource',''),/this instance/);
  assert.throws(()=>targetFromSelection('/loom/discussion/'+id,'discussion','revision',revision),/supported resource/);
});
