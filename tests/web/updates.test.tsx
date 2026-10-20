import assert from 'node:assert/strict';
import { afterEach,test,type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { UpdatesPage } from '../../src/web/Updates.js';
import { UpdatesRecovery } from '../../src/web/updates-recovery.js';
import { AttentionRecovery,type AttentionCommandView } from '../../src/web/attention-recovery.js';
import type { RoutinePageView } from '../../src/contracts/routine-updates.js';
import { IntentStore,invalidateIdentity } from '../../src/web/participation-client.js';
import type { Context } from '../../src/web/participation-state.js';
import type { UpdatesPageView,UpdatesMembersPageView } from '../../src/contracts/updates.js';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent','StorageEvent'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
const {render,screen,fireEvent,cleanup,act,waitFor}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});
const group=randomUUID(),traversal=randomUUID();
function result(cursor='shown'):UpdatesPageView{return {
  contract_version:'combined-updates-1',stage:'ready',items:[{id:group,kind:'artifact',current:{state:'available',title:'Visible source',path:[],browser_url:'/loom/resource/'+group},context_url:'/loom/resource/'+group,
    counts:{certainty:'exact',source_records:1,shared_changes:1,personal_signals:0,reply_publications:0,reply_revisions:0,summary_changes:0,artifact_changes:1,opening_changes:0,structural_changes:0},
    direct_sources:[],direct_sources_complete:true,members_cursor:'group-members',direct_cursor:null,explanation:null,omitted_detail:'remaining_member_metadata; full_bodies; summary_coverage_not_computed'}],
  traversal:{id:traversal,scope:'following',definitions:[],reason:'all',selection:'highlights',settings_current:true,grouping:'ownership; area_event',order:'direct_first; frozen_recent_then_identity',expires_at:'2026-10-17T00:00:00Z',
    shared:{contract:'shared-changes-1',lower:'sl',upper:'su',scan_complete:true,coverage:'known',history:'retained'},personal:{contract:'personal-attention-1',lower:'pl',upper:'pu',scan_complete:true,coverage:'known',history:'retained'}},
  page_cursor:cursor,next_cursor:'next',checkpoint:null,complete_cursor:'complete',direct_cursor:'direct',records_cursor:'records',page_exhausted:false,selection_exhausted:false,grouped_interval_complete:false,member_metadata_complete:false,full_contents_fetched:false,
  projection:{state:'complete',coverage:'currently_eligible_supported_sources'},work_budget_reached:false,recovery:'none',baseline_established:false,inventory:[],limit:12,max_response_bytes:131072};}
const expansion=(cursor='members-shown'):UpdatesMembersPageView=>({contract_version:'combined-updates-1',traversal_id:traversal,group_id:group,direct_only:false,items:[],page_cursor:cursor,next_cursor:'members-next',complete:false,full_contents_fetched:false,limit:5,max_response_bytes:8192});
function mount(t:TestContext,entry='/loom/updates',routine=false){
  const calls:{path:string;body:any;finish:(r:Response)=>void}[]=[];t.mock.method(globalThis,'fetch',(path:string,options:any)=>new Promise<Response>(finish=>calls.push({path,body:options.body?JSON.parse(options.body):undefined,finish})));
  const instance=randomUUID(),participant=randomUUID(),store=new IntentStore(instance,participant),context={community:{instance_id:instance,...(routine?{routine_updates_contract:'combined-updates-2'}:{})},self:{participant_id:participant,csrf:'fixture'},store} as Context;
  const router=createMemoryRouter([{path:'/loom/updates',element:<UpdatesPage context={context}/>},{path:'/other',element:<h1>Other view</h1>}],{initialEntries:[entry]});
  t.after(()=>router.dispose());render(<StrictMode><RouterProvider router={router}/></StrictMode>);return {calls,router,context};
}
const records=()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('loom.updates-pages:'))!)!);
const record=()=>Object.values(records())[0] as any;
function routineResult(cursor='shown',policy=0,count=1):RoutinePageView{
  const page=result(cursor);page.items[0]!.counts={...page.items[0]!.counts,source_records:count,shared_changes:count,artifact_changes:count};
  return {...page,contract_version:'combined-updates-2',attention:{policy_version:policy,selection:'remaining_routine_inputs',
    counts:'source_records; shared_events; personal_signals_are_distinct_units',refresh:'explicit_same_scope_and_intervals'}};
}
const muteItem=(version=0,muted=false)=>({target:{kind:'artifact',resource_id:group},include_descendants:false,muted,version,
  source:{state:'available',title:'Visible mute preview',path:[],browser_url:'/loom/resource/'+group},other_current_scope_mutes:[]});
const attentionInput=()=>({kind:'shared_event' as const,id:randomUUID(),version:0,dismissed:false,availability:'available'});
const selected=(inputs:ReturnType<typeof attentionInput>[])=>({selection:'exact-selection',inputs,policy_version:0,shared_events:inputs.length,personal_signals:0,
  membership:'exact_represented_inputs_including_unexpanded_direct_sources',expires_at:'2030-01-01T00:00:00Z'});
const dismissed=(body:any)=>({kind:'dismissal',operation_state:'applied',idempotency:'replayed',operation_id:randomUUID(),policy_version:1,
  outcome:{inputs:body.inputs.map((v:any)=>({...v,result_version:1}))},current:body.inputs.map(({kind,id,dismissed}:any)=>({kind,id,dismissed,version:1,availability:'available'}))});
async function settleRoutine(f:ReturnType<typeof mount>,page=routineResult()){
  await act(async()=>{for(const c of f.calls.filter(c=>c.path.endsWith('/query')))c.finish(Response.json(page));});
  await act(async()=>{for(const c of f.calls.filter(c=>c.path.endsWith('/mutes/lookup')))c.finish(Response.json(muteItem()));});
  for(const detail of document.querySelectorAll('details'))detail.open=true;
}
for(const action of ['mute lookup','mute change','dismiss prepare','dismiss change'] as const)
test(`attention ${action} withdrawal clears the enclosing overview and expansion and fences a pending page`,async t=>{
  const f=mount(t,'/loom/updates',true),input=attentionInput();await settleRoutine(f);
  const journal=new AttentionRecovery(f.context.community.instance_id,f.context.self.participant_id);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect changes'})));
  await act(async()=>f.calls.at(-1)!.finish(Response.json({...expansion(),contract_version:'combined-updates-2',attention:routineResult().attention})));
  if(action==='dismiss change'){
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss this update'})));
    await act(async()=>f.calls.at(-1)!.finish(Response.json(selected([input]))));
  }
  const savedPages=localStorage.getItem(new UpdatesRecovery(f.context.community.instance_id,f.context.self.participant_id,localStorage,true).prefix);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Continue this interval'})));const pending=f.calls.at(-1)!;
  const name=action==='mute lookup'?'Refresh mute state':action==='mute change'?'Mute routine updates':action==='dismiss prepare'?'Dismiss this update':'Confirm dismissal';
  await act(async()=>fireEvent.click(screen.getByRole('button',{name})));const failed=f.calls.at(-1)!;
  await act(async()=>failed.finish(Response.json(action==='mute lookup'?{...muteItem(1,true),source:{state:'unavailable'}}:
    {error:{code:'unavailable',message:'Source unavailable'}},action==='mute lookup'?{}:{status:404})));
  assert.equal(!!screen.queryByRole('heading',{name:'Visible source'}),false);assert.equal(!!screen.queryByRole('complementary'),false);
  assert.equal(!!screen.queryByText(/Visible mute preview/),false);assert.equal(document.activeElement,screen.getByRole('alert'));
  const savedCommand=action.endsWith('change')?journal.all()[0]!.command:undefined;
  if(savedCommand){assert.deepEqual(savedCommand.body,failed.body);assert.equal(journal.all()[0]!.state,'rejected');}
  await act(async()=>pending.finish(Response.json(routineResult('late-page'))));
  assert.equal(!!screen.queryByRole('heading',{name:'Visible source'}),false);
  assert.equal(localStorage.getItem(new UpdatesRecovery(f.context.community.instance_id,f.context.self.participant_id,localStorage,true).prefix),savedPages);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry Updates'})));
  await act(async()=>f.calls.at(-1)!.finish(Response.json(routineResult('reauthorized'))));
  assert.ok(screen.getByRole('heading',{name:'Visible source'}),'only a new authorized page can restore the preview');
  if(savedCommand)assert.deepEqual(journal.all()[0]!.command,savedCommand);
});

test('recovering an old subset leaves remaining mixed-group inputs dismissible after explicit selection refresh',async t=>{
  const f=mount(t,'/loom/updates',true),a=attentionInput(),b=attentionInput(),journal=new AttentionRecovery(f.context.community.instance_id,f.context.self.participant_id);
  const command:AttentionCommandView={kind:'dismissal',group_id:randomUUID(),body:{idempotency_key:randomUUID(),selection:'old-selection',inputs:[{kind:a.kind,id:a.id,dismissed:true,expected_version:0}]}};
  await act(async()=>{const saved=await journal.save(command,()=>true);await journal.begin(saved);});await settleRoutine(f,routineResult('mixed',0,2));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss this update'})));
  await act(async()=>f.calls.at(-1)!.finish(Response.json(selected([a,b]))));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry same attention change'})));const retry=f.calls.at(-1)!;
  assert.deepEqual(retry.body,command.body);await act(async()=>retry.finish(Response.json(dismissed(retry.body))));
  assert.equal(journal.all().length,0);assert.equal(!!screen.queryByRole('button',{name:'Dismiss this update'}),false);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh attention selection'})));
  assert.deepEqual(f.calls.at(-1)!.body,{recovery:{action:'attention_refresh',token:'mixed'},limit:12,max_response_bytes:131072});
  await act(async()=>f.calls.at(-1)!.finish(Response.json(routineResult('remaining',1))));
  assert.ok(screen.getByText('1 artifact change'));assert.ok(screen.getByRole('button',{name:'Undo dismissal / restore these inputs'}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss this update'})));
  await act(async()=>f.calls.at(-1)!.finish(Response.json({...selected([b]),selection:'remaining-selection',policy_version:1})));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Confirm dismissal'})));const fresh=f.calls.at(-1)!;
  assert.notEqual(fresh.body.idempotency_key,command.body.idempotency_key);assert.equal(fresh.body.selection,'remaining-selection');
  assert.deepEqual(fresh.body.inputs,[{kind:b.kind,id:b.id,dismissed:true,expected_version:0}]);
  await act(async()=>fresh.finish(Response.json(dismissed(fresh.body))));assert.equal(journal.all().length,0);
});

test('a withdrawn member response cannot release the busy guard owned by fresh reauthorization',async t=>{
  const f=mount(t,'/loom/updates',true);await settleRoutine(f);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect changes'})));const oldMember=f.calls.at(-1)!;
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Mute routine updates'})));
  await act(async()=>f.calls.at(-1)!.finish(Response.json({error:{code:'unavailable',message:'Source unavailable'}},{status:404})));
  assert.equal(!!screen.queryByRole('heading',{name:'Visible source'}),false);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry Updates'})));const freshPage=f.calls.at(-1)!,count=f.calls.length;
  await act(async()=>oldMember.finish(Response.json({...expansion('withdrawn-member'),contract_version:'combined-updates-2',attention:routineResult().attention})));
  const refresh=screen.getByRole('button',{name:'Refresh scope from retained history'});assert.equal(refresh.getAttribute('aria-disabled'),'true');
  await act(async()=>fireEvent.click(refresh));assert.equal(f.calls.length,count,'the older finally must not release a newer request');
  assert.equal(!!screen.queryByRole('complementary'),false);
  await act(async()=>freshPage.finish(Response.json(routineResult('fresh-page'))));
  const freshMember=f.calls.filter(c=>c.path.endsWith('/members')).at(-1)!;assert.notEqual(freshMember,oldMember);
  await act(async()=>freshMember.finish(Response.json({...expansion('fresh-member'),contract_version:'combined-updates-2',attention:routineResult().attention})));
  assert.ok(screen.getByRole('complementary'));assert.equal(refresh.getAttribute('aria-disabled'),'false');
  const pages=JSON.parse(localStorage.getItem(new UpdatesRecovery(f.context.community.instance_id,f.context.self.participant_id,localStorage,true).prefix)!);
  assert.equal((Object.values(pages)[0] as any).expansion.cursor,'fresh-member');
});

for(const event of ['local completion','other tab'] as const)test(`an old-policy page cannot clear a newer attention change from ${event}`,async t=>{
  const f=mount(t,'/loom/updates',true);await settleRoutine(f);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Continue this interval'})));const pending=f.calls.at(-1)!;
  if(event==='local completion'){
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Mute routine updates'})));const mutation=f.calls.at(-1)!,{idempotency_key,...outcome}=mutation.body;
    await act(async()=>mutation.finish(Response.json({kind:'mute',operation_state:'applied',idempotency:'created',operation_id:randomUUID(),policy_version:1,
      outcome:{...outcome,result_version:1},current:muteItem(1,true)})));
  }else await act(async()=>window.dispatchEvent(new StorageEvent('storage',{key:new AttentionRecovery(f.context.community.instance_id,f.context.self.participant_id).prefix+'intent:'+randomUUID()})));
  assert.ok(screen.getByText(/Attention choices changed/));
  await act(async()=>pending.finish(Response.json(routineResult('old-policy-page'))));
  assert.ok(screen.getByText(/Attention choices changed/),'an earlier read cannot acknowledge the later policy change');
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh attention selection'})));
  assert.deepEqual(f.calls.at(-1)!.body,{recovery:{action:'attention_refresh',token:'old-policy-page'},limit:12,max_response_bytes:131072});
  await act(async()=>f.calls.at(-1)!.finish(Response.json(routineResult('current-policy-page',1))));
  assert.equal(!!screen.queryByText(/Attention choices changed/),false,'a fresh deliberate refresh can acknowledge current policy');
});

test('incomplete attention membership offers same-interval preparation instead of retrying partial members',async t=>{
  const {calls}=mount(t,'/loom/updates',true);await waitFor(()=>assert.equal(calls.length,2));
  const page={...result('fixed-overview'),contract_version:'combined-updates-2',attention:{policy_version:0,selection:'remaining_routine_inputs',
    counts:'source_records; shared_events; personal_signals_are_distinct_units',refresh:'explicit_same_scope_and_intervals'}};
  await act(async()=>calls[1]!.finish(Response.json(page)));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect changes'})));
  const member=calls.find(c=>c.path.endsWith('/members'))!;
  await act(async()=>member.finish(Response.json({error:{code:'updates_attention_preparing',message:'Continue preparing the fixed selection'}},{status:409})));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh attention selection'})));
  assert.equal(calls.at(-1)!.path,'/api/v1/me/routine-updates/query');
  assert.deepEqual(calls.at(-1)!.body,{recovery:{action:'attention_refresh',token:'fixed-overview'},limit:12,max_response_bytes:131072});
  assert.equal(calls.filter(c=>c.path.endsWith('/members')).length,1,'recovery must advance preparation before another member read');
});
for(const kind of ['personal','artifact'] as const)test(`tokenless ${kind} history-gap recovery preserves the selected scope and reason`,async t=>{
  const reason=kind==='personal'?'mention':'reply',scope=kind==='personal'?{kind}:{kind:'explicit',definition:{target:{kind,resource_id:group},include_descendants:false,preferences:['artifact_revisions']}};
  const entry=`/loom/updates?kind=${kind}&id=${group}&events=artifact_revisions&reason=${reason}`;
  const {calls,router}=mount(t,entry);await waitFor(()=>assert.equal(calls.length,2));
  assert.deepEqual(calls[1]!.body,{scope,reason});
  await act(async()=>calls[1]!.finish(Response.json({error:{code:`updates_${kind==='personal'?'personal':'shared'}_history_gap`,message:'Retained history is unavailable'}},{status:410})));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Establish an incomplete new baseline'})));
  assert.deepEqual(calls[2]!.body,{scope,reason,recovery:{action:'resynchronize'},limit:12,max_response_bytes:131072});
  const baseline=result('baseline');baseline.traversal.scope=kind==='personal'?'personal':'explicit';baseline.traversal.reason=reason;
  baseline.baseline_established=true;baseline.traversal.shared.history='incomplete';baseline.traversal.personal.history='incomplete';baseline.checkpoint='newer';
  await act(async()=>calls[2]!.finish(Response.json(baseline)));
  assert.deepEqual(Object.keys(records()),[JSON.stringify([scope,reason])]);
  await act(async()=>router.navigate('/other'));await act(async()=>router.navigate(entry));await waitFor(()=>assert.equal(calls.length,5));
  assert.deepEqual(calls[4]!.body,{cursor:'baseline',limit:12,max_response_bytes:131072});
  await act(async()=>calls[4]!.finish(Response.json(baseline)));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check newer activity'})));
  assert.deepEqual(calls[5]!.body,{checkpoint:'newer',limit:12});
});
test('ready unknown history offers token-bound resynchronization and keeps incomplete history visible after newer activity',async t=>{
  const {calls,router}=mount(t);await waitFor(()=>assert.equal(calls.length,2));
  const unknown=result('unknown-history');unknown.traversal.shared.coverage='unknown';unknown.traversal.selection='complete';unknown.next_cursor=null;unknown.selection_exhausted=true;unknown.page_exhausted=true;
  await act(async()=>calls[1]!.finish(Response.json(unknown)));
  assert.equal(screen.queryByRole('button',{name:'Check newer activity'}),null);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Establish an incomplete new baseline'})));
  assert.deepEqual(calls[2]!.body,{recovery:{action:'resynchronize',token:'unknown-history'},limit:12,max_response_bytes:131072});
  const baseline=result('baseline');baseline.baseline_established=true;baseline.traversal.shared.history='incomplete';baseline.traversal.personal.history='incomplete';baseline.checkpoint='newer';
  await act(async()=>calls[2]!.finish(Response.json(baseline)));
  await act(async()=>router.navigate('/other'));await act(async()=>router.navigate('/loom/updates'));await waitFor(()=>assert.equal(calls.length,5));
  await act(async()=>calls[4]!.finish(Response.json(baseline)));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check newer activity'})));
  const newer={...baseline,page_cursor:'new-interval',baseline_established:false,recovery:'none' as const};
  await act(async()=>calls[5]!.finish(Response.json(newer)));
  assert.match(screen.getByText(/Missing history was not reconstructed/).textContent!,/History remains incomplete/);
  for(const [name,href] of [['Browse retained topics','/loom'],['Browse retained artifacts','/loom/artifacts'],['Open retained personal attention','/loom/notifications']] as const)
    assert.equal(screen.getByRole('link',{name}).getAttribute('href'),href);
});
test('StrictMode persists displayed Updates budgets before resized successors; failed saves retain recoverable context and focus',async t=>{
  const {calls}=mount(t);await waitFor(()=>assert.equal(calls.length,2));await act(async()=>calls[1]!.finish(Response.json(result())));
  await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Continue this interval'})));await act(async()=>calls[0]!.finish(Response.json(result('discarded'))));assert.equal(record().request.cursor,'shown');
  const saved=JSON.stringify(records()),original=dom.window.Storage.prototype.setItem;let fail=true;
  t.mock.method(dom.window.Storage.prototype,'setItem',function(this:Storage,k:string,v:string){if(fail)throw new Error('Synthetic recovery failure');original.call(this,k,v);});
  await act(async()=>fireEvent.change(screen.getByLabelText('Next page size'),{target:{value:'5'}}));
  const next=screen.getByRole('button',{name:'Continue this interval'});next.focus();await act(async()=>fireEvent.click(next));assert.deepEqual(calls[2]!.body,{cursor:'next',limit:5});
  const second={...result('second'),limit:5,next_cursor:null,selection_exhausted:true,page_exhausted:true};
  await act(async()=>calls[2]!.finish(Response.json(second)));await waitFor(()=>assert.match(screen.getByRole('alert').textContent!,/could not be saved/));assert.equal(JSON.stringify(records()),saved);assert.equal(document.activeElement,next);
  fail=false;await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry Updates'})));assert.deepEqual(calls[3]!.body,{cursor:'second',limit:5,max_response_bytes:131072});
  await act(async()=>calls[3]!.finish(Response.json(second)));await waitFor(()=>assert.equal(record().request.cursor,'second'));assert.equal(record().previous_request.cursor,'shown');
});
test('group expansion saves separately, reload reauthorizes both pages, and member resize retains unseen successors',async t=>{
  const {calls,router}=mount(t);await waitFor(()=>assert.equal(calls.length,2));await act(async()=>calls[1]!.finish(Response.json(result())));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect changes'})));assert.equal(calls[2]!.path,'/api/v1/me/updates/members');
  await act(async()=>calls[2]!.finish(Response.json(expansion())));await waitFor(()=>assert.equal(record().expansion.cursor,'members-shown'));
  assert.equal(record().request.cursor,'shown');assert.equal(document.activeElement,screen.getByRole('complementary',{name:'Expanded changes'}));
  await act(async()=>router.navigate('/other'));await act(async()=>router.navigate('/loom/updates'));await waitFor(()=>assert.equal(calls.length,5));
  assert.deepEqual(calls[4]!.body,{cursor:'shown',limit:12,max_response_bytes:131072});await act(async()=>calls[4]!.finish(Response.json(result())));
  await waitFor(()=>assert.equal(calls.length,6));assert.deepEqual(calls[5]!.body,{cursor:'members-shown',limit:5,max_response_bytes:8192});await act(async()=>calls[5]!.finish(Response.json(expansion())));
  await act(async()=>fireEvent.change(screen.getByLabelText('Next page size'),{target:{value:'25'}}));await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Next sources'})));
  assert.deepEqual(calls[6]!.body,{cursor:'members-next',limit:25});await act(async()=>calls[6]!.finish(Response.json({...expansion('last-members'),limit:25,next_cursor:null,complete:true})));
  await waitFor(()=>assert.equal(record().expansion.cursor,'last-members'));await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Close changes'})));
  await waitFor(()=>assert.equal(record().expansion,undefined));assert.equal(screen.queryByRole('complementary'),null);assert.equal(document.activeElement,screen.getByRole('button',{name:'Inspect changes'}));
});
test('late filter, route and identity responses cannot restore Updates rows or recovery',async t=>{
  const {calls,router}=mount(t);await waitFor(()=>assert.equal(calls.length,2));await act(async()=>fireEvent.change(screen.getByLabelText('Personal reasons'),{target:{value:'reply'}}));await waitFor(()=>assert.equal(calls.length,4));
  const fresh=result('reply');fresh.traversal.reason='reply';await act(async()=>calls[3]!.finish(Response.json(fresh)));await waitFor(()=>assert.equal(localStorage.length,1));
  await act(async()=>{for(const call of calls.slice(0,3))call.finish(Response.json(result('old')));});assert.equal(record().request.cursor,'reply');assert.equal(Object.keys(records()).length,1);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Continue this interval'})));await act(async()=>router.navigate('/other'));await act(async()=>calls[4]!.finish(Response.json(result('late'))));assert.equal(record().request.cursor,'reply');
  await act(async()=>router.navigate('/loom/updates'));await waitFor(()=>assert.equal(calls.length,7));await act(async()=>{invalidateIdentity();calls[6]!.finish(Response.json(result('other-account')));});assert.equal(Object.keys(records()).length,1);
});
test('stale tabs cannot overwrite recovery and clearing malformed Updates records preserves other journals',async t=>{
  const {calls,context}=mount(t);await waitFor(()=>assert.equal(calls.length,2));await act(async()=>calls[1]!.finish(Response.json(result())));await waitFor(()=>assert.equal(localStorage.length,1));
  const recovery=new UpdatesRecovery(context.community.instance_id,context.self.participant_id),key=Object.keys(records())[0]!;await recovery.save(key,result('other-tab'),1,()=>true,[]);const other=JSON.stringify(records());
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Continue this interval'})));await act(async()=>calls[2]!.finish(Response.json(result('stale'))));await waitFor(()=>assert.match(screen.getByRole('alert').textContent!,/Another tab/));assert.equal(JSON.stringify(records()),other);
  localStorage.setItem(recovery.prefix,'malformed');localStorage.setItem('loom.notifications:independent','preserved');localStorage.setItem('loom.saved:independent','preserved');assert.throws(()=>recovery.read(key),/incompatible/);
  await act(async()=>fireEvent.click(screen.getAllByRole('button',{name:'Clear saved Updates views'})[0]!));assert.equal(localStorage.getItem('loom.notifications:independent'),'preserved');assert.equal(localStorage.getItem('loom.saved:independent'),'preserved');assert.deepEqual(calls[3]!.body,{scope:{kind:'following'},reason:'all'});
});
test('visibility failures withdraw group and expansion before replay without advancing saved state',async t=>{
  const {calls}=mount(t);await waitFor(()=>assert.equal(calls.length,2));await act(async()=>calls[1]!.finish(Response.json(result())));await waitFor(()=>assert.ok(screen.getByRole('heading',{name:'Visible source'})));const saved=JSON.stringify(records());
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect changes'})));await act(async()=>calls[2]!.finish(Response.json({error:{code:'updates_visibility_replay_required',message:'Replay retained history'}},{status:409})));
  await waitFor(()=>assert.equal(screen.queryByRole('heading',{name:'Visible source'}),null));assert.equal(document.activeElement,screen.getByRole('alert'));assert.equal(JSON.stringify(records()),saved);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Replay both retained streams'})));assert.equal(calls[3]!.body.recovery.action,'replay');assert.equal(calls[3]!.body.recovery.token,'shown');
});

for(const alreadyExpanded of [false,true])test(`retry after a member authority race reauthorizes the overview and ${alreadyExpanded?'successor':'first expansion'}`,async t=>{
  const {calls}=mount(t);await waitFor(()=>assert.equal(calls.length,2));
  await act(async()=>calls[1]!.finish(Response.json(result())));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect changes'})));
  if(alreadyExpanded){
    await act(async()=>calls.at(-1)!.finish(Response.json(expansion())));
    await act(async()=>fireEvent.change(screen.getByLabelText('Next page size'),{target:{value:'25'}}));
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Next sources'})));
  }
  const failedRequest=calls.at(-1)!.body,saved=JSON.stringify(records());
  await act(async()=>calls.at(-1)!.finish(Response.json({error:{code:'updates_view_changed',message:'Reauthorize the same page'}},{status:409})));
  assert.equal(screen.queryByRole('heading',{name:'Visible source'}),null);assert.equal(screen.queryByRole('complementary'),null);
  assert.equal(JSON.stringify(records()),saved);assert.equal(document.activeElement,screen.getByRole('alert'));
  const before=calls.length;
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry Updates'})));
  assert.equal(calls.length,before+1,'Retry must reauthorize after cached overview withdrawal');
  assert.equal(calls.at(-1)!.path,'/api/v1/me/updates/query');assert.deepEqual(calls.at(-1)!.body,{cursor:'shown',limit:12,max_response_bytes:131072});
  await act(async()=>calls.at(-1)!.finish(Response.json(result('reauthorized'))));
  await waitFor(()=>assert.equal(calls.length,before+2));
  assert.deepEqual(calls.at(-1)!.body,{...failedRequest,max_response_bytes:131072});
  assert.equal(record().expansion?.cursor,alreadyExpanded?'members-shown':undefined,'Do not save unseen member progress before its response');
  await act(async()=>calls.at(-1)!.finish(Response.json({...expansion('recovered-members'),limit:failedRequest.limit,max_response_bytes:131072})));
  await waitFor(()=>assert.equal(record().expansion.cursor,'recovered-members'));
  assert.equal(record().request.cursor,'reauthorized');assert.equal(document.activeElement,screen.getByRole('complementary',{name:'Expanded changes'}));
});

test('expired reload renews the saved overview and expansion with their independent budgets',async t=>{
  const {calls,router,context}=mount(t);await waitFor(()=>assert.equal(calls.length,2));await act(async()=>router.navigate('/other'));
  const recovery=new UpdatesRecovery(context.community.instance_id,context.self.participant_id),page={...result('expired-overview'),limit:5,max_response_bytes:16384};
  await recovery.save(JSON.stringify([{kind:'following'},'all']),page,0,()=>true,[],{cursor:'expired-members',limit:12,max_response_bytes:8192});
  await act(async()=>router.navigate('/loom/updates'));await waitFor(()=>assert.equal(calls.length,4));
  await act(async()=>calls[3]!.finish(Response.json({error:{code:'updates_descriptor_expired',message:'Renew fixed Updates'}},{status:410})));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Renew fixed Updates view'})));
  assert.deepEqual(calls[4]!.body,{recovery:{action:'renew',token:'expired-overview'},limit:5,max_response_bytes:16384});
  await act(async()=>calls[4]!.finish(Response.json({...page,page_cursor:'renewed-overview',recovery:'renewed'})));
  await waitFor(()=>assert.equal(calls.length,6));assert.deepEqual(calls[5]!.body,{cursor:'expired-members',limit:12,max_response_bytes:8192,renew:true});
  await act(async()=>calls[5]!.finish(Response.json({...expansion('renewed-members'),limit:12})));
  await waitFor(()=>assert.equal(record().expansion.cursor,'renewed-members'));assert.equal(record().request.cursor,'renewed-overview');
});

for(const [code,name] of [['updates_attention_refresh_required','Refresh attention selection'],['updates_attention_preparing','Refresh attention selection'],['updates_descriptor_expired','Renew fixed Updates view']] as const)test('selection preparation provides recovery for '+code,async t=>{
 const f=mount(t,'/loom/updates',true);await settleRoutine(f);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Continue this interval'})));const pending=f.calls.at(-1)!;
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss this update'})));
 assert.ok(f.calls.at(-1)!.path.endsWith('/selection'));
 await act(async()=>f.calls.at(-1)!.finish(Response.json({error:{code,message:'Selection needs recovery'}},{status:code==='updates_descriptor_expired'?410:409})));
 assert.ok(screen.queryByRole('button',{name}), 'missing '+name+' after '+code);
 await act(async()=>pending.finish(Response.json(routineResult('unseen-successor'))));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name})));
 assert.deepEqual(f.calls.at(-1)!.body,{recovery:{action:code==='updates_descriptor_expired'?'renew':'attention_refresh',token:'shown'},limit:12,max_response_bytes:131072});
 await act(async()=>f.calls.at(-1)!.finish(Response.json(routineResult('recovered'))));
 for(const detail of document.querySelectorAll('details'))detail.open=true;
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss this update'})));
 assert.equal(f.calls.at(-1)!.body.cursor,'recovered');
});
test('same-owner navigation retains policy notice for later committed mutation',async t=>{
 const f=mount(t,'/loom/updates',true);await settleRoutine(f);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Mute routine updates'})));
 const pending=f.calls.at(-1)!;assert.ok(pending.path.endsWith('/mutes/state'));
 await act(async()=>f.router.navigate('/other'));await act(async()=>f.router.navigate('/loom/updates'));await settleRoutine(f,routineResult('new-view',0));
 const {idempotency_key,...outcome}=pending.body;
 await act(async()=>pending.finish(Response.json({kind:'mute',operation_state:'applied',idempotency:'created',operation_id:randomUUID(),policy_version:1,outcome:{...outcome,result_version:1},current:muteItem(1,true)})));
 assert.equal(new AttentionRecovery(f.context.community.instance_id,f.context.self.participant_id).all().length,0);
 assert.ok(screen.queryByText(/Attention choices changed/),'later decision must notify the same-owner new view');
});
test('switching expanded Complete records to a routine source invalidates old dismissal inputs',async t=>{
 const f=mount(t,'/loom/updates',true);await settleRoutine(f);
 const eventId=randomUUID(),deliveryId=randomUUID(),revision=randomUUID(),author={id:randomUUID(),nickname:'Synthetic author',kind:'human'},time='2026-10-17T00:00:00Z',url='/loom/resource/'+group;
 const source={event_id:eventId,kind:'revision.published',resource_id:group,discussion_id:null,revision_id:revision,revision_number:'1',actor:author,occurred_at:time,current:{state:'available',title:'Visible source',path:[],browser_url:url},exact_url:url,context_url:url,full_content_url:'/api/source',change_note_url:null,reasons:[],reasons_complete:true,detail_url:'/api/v1/me/routine-updates/reasons',next_reason:null};
 const personal={delivery_id:deliveryId,signal_id:randomUUID(),available_at:time,source_event_id:eventId,source:{resource_id:group,kind:'artifact',title:'Visible source',revision_id:revision,revision_number:'1',author,publisher:author,created_at:time,area_id:randomUUID(),area_title:'Topic',discussion_id:null,parent_id:null,can_edit:false,publication_open:true,full_content_url:'/api/source'},context_title:'Visible source',context_url:url,browser_url:url,detail_url:'/api/personal',reasons:[{kind:'main_mention',source_field:'main',revision_id:revision,full_content_url:'/api/source'}],current:{state:'available',revision_id:revision,main_mention:'present'},parent:null};
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect all source records'})));
 await act(async()=>f.calls.at(-1)!.finish(Response.json({...expansion('complete-member'),contract_version:'combined-updates-2',attention:{...routineResult().attention,selection:'all_represented_inputs'},group_id:null,items:[{source,shared_in_interval:true,personal}]})));
 for(const detail of document.querySelectorAll('details'))detail.open=true;
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss these source inputs'})));
 assert.deepEqual(f.calls.at(-1)!.body.inputs,[{kind:'shared_event',id:eventId},{kind:'personal_delivery',id:deliveryId}]);
 await act(async()=>f.calls.at(-1)!.finish(Response.json({items:f.calls.at(-1)!.body.inputs.map((v:any)=>({...v,version:0,dismissed:false,availability:'available'})),policy_version:0})));
 const control=screen.getByRole('button',{name:'Confirm dismissal'}).parentElement;
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Inspect changes'})));
 await act(async()=>f.calls.at(-1)!.finish(Response.json({...expansion('routine-member'),contract_version:'combined-updates-2',attention:routineResult().attention,items:[{source,shared_in_interval:false,personal}]})));
 assert.ok(screen.getByText(/No shared input in this selection/));
 assert.ok(control!.isConnected,'the source control stays mounted across expansion replacement');
 assert.equal(!!screen.queryByRole('button',{name:'Confirm dismissal'}),false,'the old shared+personal selection must not survive the now personal-only member');
});
