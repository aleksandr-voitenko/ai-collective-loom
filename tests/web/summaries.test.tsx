import {AuthorizationBoundary} from '../../src/web/AuthorizationBoundary.js';
import assert from 'node:assert/strict';
import {afterEach,test,type TestContext} from 'node:test';
import {JSDOM} from 'jsdom';
import {StrictMode} from 'react';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {SourceResults,CoverageState,SummarySection} from '../../src/web/Summaries.js';
import {invalidateIdentity,ApiError,isDefinitiveRejection} from '../../src/web/participation-client.js';
import type {SourcePageView} from '../../src/contracts/summaries.js';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
const {render,screen,fireEvent,cleanup,act,waitFor}=await import('@testing-library/react');afterEach(()=>cleanup());
const result=():SourcePageView=>({items:[],unknown:false,next_cursor:null,complete:true,work_budget_reached:false,limit:12,max_response_bytes:131072,omitted_detail:'bodies; unavailable_members',expires_at:'2026-10-16T12:00:00Z'});
function mount(t:TestContext){const calls:{path:string;finish:(r:Response)=>void}[]=[];t.mock.method(globalThis,'fetch',(path:string)=>new Promise<Response>(finish=>calls.push({path,finish})));
  const router=createMemoryRouter([{path:'/sources',element:<AuthorizationBoundary><SourceResults path="/api/v1/discussions/fixture/summary-sources"/></AuthorizationBoundary>},{path:'/other',element:<h1>Other route</h1>}],{initialEntries:['/sources']});
  t.after(()=>router.dispose());render(<StrictMode><RouterProvider router={router}/></StrictMode>);return {calls,router};}
test('StrictMode source pages settle once, recover the failed cursor and focus deliberate retry',async t=>{
  const {calls}=mount(t);await waitFor(()=>assert.equal(calls.length,2));await act(async()=>calls[1]!.finish(Response.json({...result(),complete:false,next_cursor:'next'})));
  await act(async()=>calls[0]!.finish(Response.json(result())));assert.ok(screen.getByRole('button',{name:'Next source revisions'}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Next source revisions'})));await act(async()=>calls[2]!.finish(Response.json({error:{code:'unknown',message:'Failed source view'}},{status:503})));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry source page'})));assert.equal(calls[3]!.path,calls[2]!.path);
  await act(async()=>calls[3]!.finish(Response.json(result())));assert.equal(document.activeElement,screen.getByRole('heading',{name:'Source revisions'}));
});
test('source responses and errors cannot cross account or route ownership',async t=>{
  const {calls,router}=mount(t);await waitFor(()=>assert.equal(calls.length,2));await act(async()=>{invalidateIdentity();calls[1]!.finish(Response.json(result()));});assert.ok(!screen.queryByText('No eligible source revisions in this view.'));
  await act(async()=>router.navigate('/other'));await act(async()=>calls[0]!.finish(Response.json({error:{code:'unavailable',message:'Late'}},{status:404})));assert.ok(screen.getByRole('heading',{name:'Other route'}));assert.ok(!screen.queryByRole('alert'));
});
test('partial, unknown and measured gaps coexist without an all-current claim',()=>{
  render(<CoverageState value={{scope:'selected',uncovered_eligible:2,changed_eligible:1,unknown:true,comparison:'complete',claim:'author_declared; not_read_or_correctness_proof'}}/>);
  assert.ok(screen.getByText('Selected sources · partial scope'));assert.ok(screen.getByText(/2 eligible contributions outside/));assert.ok(screen.getByText(/Some source coverage is unavailable/));assert.ok(!screen.queryByText(/No known gaps/));
  assert.equal(isDefinitiveRejection(new ApiError('summary_preparation_expired','Expired'),true),false);
  assert.equal(isDefinitiveRejection(new ApiError('summary_preparation_expired','Expired',undefined,'rejected'),true),true);
});

test('optional summary distinguishes absence, source withdrawal and transient local retry in StrictMode',async t=>{
  t.mock.method(globalThis,'fetch',async(path:string)=>{
    if(path.includes('/absent/'))return Response.json({state:'absent',can_create:true});
    if(path.includes('/unavailable/'))return Response.json({state:'unavailable'});
    return Response.json({error:{code:'service_unavailable',message:'Temporary failure'}},{status:503});
  });
  const router=createMemoryRouter(['absent','unavailable','failed'].map(state=>({
    path:'/'+state,element:<AuthorizationBoundary key={state}><SummarySection discussion={state}/></AuthorizationBoundary>,
  })),{initialEntries:['/absent']});
  t.after(()=>router.dispose());render(<StrictMode><RouterProvider router={router}/></StrictMode>);
  await screen.findByText('No summary has been published.');
  assert.equal(screen.getByRole('link',{name:'Create first summary'}).getAttribute('href'),'/loom/discussion/absent?summary=create');
  await act(async()=>router.navigate('/unavailable'));
  await screen.findByRole('button',{name:'Retry protected view'});
  assert.ok(!screen.queryByRole('link',{name:'Create first summary'}));
  await act(async()=>router.navigate('/failed'));
  await screen.findByRole('alert');
  assert.match(screen.getByRole('alert').textContent??'',/Discussion reading and replies remain available/);
  t.mock.method(globalThis,'fetch',async()=>Response.json({state:'absent',can_create:false}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry summary'})));
  await screen.findByText('No summary has been published.');
  assert.ok(!screen.queryByRole('alert'));
  assert.ok(!screen.queryByRole('link',{name:'Create first summary'}));
  assert.ok(screen.getByRole('link',{name:'Summary maintenance'}));
});
