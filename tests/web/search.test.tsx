import assert from 'node:assert/strict';
import { afterEach,test,type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { SearchPageViewComponent } from '../../src/web/Search.js';
import { invalidateIdentity } from '../../src/web/participation-client.js';
import type { Context } from '../../src/web/participation-state.js';
import type { SearchPageView } from '../../src/contracts/search.js';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','FormData','Event'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
const {render,screen,fireEvent,cleanup,act,waitFor}=await import('@testing-library/react');
afterEach(()=>cleanup());
const status={indexing:'ready',coverage:'current_supported_text',direct_retrieval:'independent'} as const;
function page(query:string):SearchPageView{return {items:[],query,scope:{topic:null,descendants:false,kind:null,author:null,from:null,before:null},indexing:status,selection:'bounded_current_relevance',ranking:'simple-title-body-note-v2',
  next_cursor:null,window_exhausted:true,selection_limited:false,corpus_exhaustive:false,limit:12,max_response_bytes:131072,expires_at:'2026-10-15T00:00:00.000Z'};}
function mount(t:TestContext){
  const calls:{path:string;finish:(r:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(path:string)=>{
    if(path==='/api/v1/search/status')return Promise.resolve(Response.json(status));
    return new Promise<Response>(finish=>calls.push({path,finish}));
  });
  const router=createMemoryRouter([{path:'/loom/search',element:<SearchPageViewComponent context={{} as Context}/>},{path:'/other',element:<h1>Other view</h1>}],{initialEntries:['/loom/search']});
  t.after(()=>router.dispose());render(<StrictMode><RouterProvider router={router}/></StrictMode>);
  return {calls,router};
}
async function submit(value:string){await act(async()=>{fireEvent.change(screen.getByLabelText('Search terms'),{target:{value}});fireEvent.click(screen.getByRole('button',{name:'Search shared text'}));});}
test('StrictMode search resolves loading and errors and permits explicit retry',async t=>{
  const {calls}=mount(t);await submit('first');await waitFor(()=>assert.equal(calls.length,1));
  await act(async()=>calls[0]!.finish(Response.json(page('first'))));await waitFor(()=>assert.equal(!!screen.queryByText('Searching…'),false));
  assert.ok(screen.getByText('No matching results in this selection.'));
  await submit('second');await waitFor(()=>assert.equal(calls.length,2));
  await act(async()=>calls[1]!.finish(Response.json({error:{code:'service_unavailable',message:'Search unavailable',request_id:'00000000-0000-0000-0000-000000000001',recovery:{action:'retry_same_request'}}},{status:503})));
  await waitFor(()=>assert.ok(screen.getByRole('alert')));assert.equal(!!screen.queryByText('No matching results in this selection.'),false);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry search page'})));await waitFor(()=>assert.equal(calls.length,3));
  await act(async()=>calls[2]!.finish(Response.json(page('second'))));await waitFor(()=>assert.equal(!!screen.queryByRole('alert'),false));
});
test('late query and unmounted responses cannot replace the current search view',async t=>{
  const {calls,router}=mount(t);await submit('old');await waitFor(()=>assert.equal(calls.length,1));await submit('new');await waitFor(()=>assert.equal(calls.length,2));
  await act(async()=>calls[1]!.finish(Response.json(page('new'))));await act(async()=>calls[0]!.finish(Response.json(page('old'))));
  assert.ok(screen.getByText('Results for “new”.'));assert.equal(!!screen.queryByText('Results for “old”.'),false);
  await submit('unmounted');await waitFor(()=>assert.equal(calls.length,3));await act(async()=>router.navigate('/other'));
  await act(async()=>calls[2]!.finish(Response.json(page('unmounted'))));assert.ok(screen.getByRole('heading',{name:'Other view'}));
});
test('late account results are ignored even when a transport completes after invalidation',async t=>{
  const {calls}=mount(t);await submit('private-to-view');await waitFor(()=>assert.equal(calls.length,1));
  await act(async()=>{invalidateIdentity();calls[0]!.finish(Response.json(page('private-to-view')));});
  assert.equal(!!screen.queryByText('Results for “private-to-view”.'),false);
});
