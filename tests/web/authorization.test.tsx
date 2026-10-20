import assert from 'node:assert/strict';
import {afterEach,test,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode,useEffect,useState} from 'react';
import * as A from '../../src/contracts/attention.js';
import {AuthorizationBoundary,useAuthorization} from '../../src/web/AuthorizationBoundary.js';
import {MuteControl,DismissControl} from '../../src/web/Attention.js';
import {AttentionRecovery} from '../../src/web/attention-recovery.js';
import {invalidateIdentity} from '../../src/web/participation-client.js';
import type {Context} from '../../src/web/participation-state.js';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
const {render,screen,fireEvent,cleanup,act,waitFor,within}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});

function PendingRead(){
  const authority=useAuthorization(),[body,setBody]=useState('');
  return <><button onClick={()=>void authority.read<{text:string}>('/api/v1/guide').then(v=>setBody(v.text),()=>{})}>Load sibling</button>{body&&<p>{body}</p>}</>;
}
function mount(t:TestContext,kind:'mute'|'dismiss',group=false){
  const context={community:{instance_id:randomUUID()},self:{participant_id:randomUUID(),csrf:'fixture'}} as Context;
  const target={kind:'artifact' as const,resource_id:randomUUID()},input={kind:'shared_event' as const,id:randomUUID()},groupId=randomUUID();
  const calls:{path:string;body:any;finish:(response:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(path:string,options:any)=>new Promise<Response>(finish=>calls.push({path,body:options.body?JSON.parse(options.body):undefined,finish})));
  const control=kind==='mute'?<MuteControl context={context} target={target}/>:<DismissControl context={context} {...(group?{groupId,cursor:'fixed-cursor'}:{inputs:[input]})}/>;
  const view=(replacement=false)=><StrictMode><AuthorizationBoundary key={replacement?'new':'old'}><h1>{replacement?'Replacement protected view':'Protected enclosing text'}</h1>{!replacement&&control}<PendingRead/></AuthorizationBoundary></StrictMode>;
  const rendered=render(view()),journal=new AttentionRecovery(context.community.instance_id,context.self.participant_id);
  const item={target,include_descendants:false,muted:false,version:0,source:{state:'available',title:'Protected preview',path:[],browser_url:'/loom/resource/'+target.resource_id},other_current_scope_mutes:[]};
  const selected={...input,version:0,dismissed:false,availability:'available'};
  const result=(command:any)=>kind==='mute'?{kind:'mute',operation_state:'applied',operation_id:randomUUID(),idempotency:'created',policy_version:1,
    outcome:{target,include_descendants:false,muted:true,expected_version:0,result_version:1},current:{...item,muted:true,version:1,source:{state:'unavailable'}}}:
    {kind:'dismissal',operation_state:'applied',operation_id:randomUUID(),idempotency:'created',policy_version:1,
      outcome:{inputs:command.inputs.map((v:any)=>({...v,result_version:1}))},current:[{...selected,version:1,dismissed:true,availability:'unavailable'}]};
  return {calls,context,journal,item,selected,result,rendered,view};
}
async function settle(f:ReturnType<typeof mount>,kind:'mute'|'dismiss'){
  if(kind==='mute')await act(async()=>{for(const call of f.calls)call.finish(Response.json(f.item));});
}
const click=async(name:string)=>act(async()=>{fireEvent.click(screen.getByRole('button',{name}));});

for(const kind of ['mute','dismiss'] as const)for(const path of ['lookup','mutation','status','retry'] as const)
for(const response of ['source refusal','owner refusal','unavailable result'] as const)
test(`${kind} ${path} ${response} withdraws its enclosing host and fences a sibling read`,async t=>{
  const f=mount(t,kind);await settle(f,kind);
  if(kind==='dismiss'&&path!=='lookup'){
    await click('Dismiss these source inputs');await act(async()=>f.calls.at(-1)!.finish(Response.json({items:[f.selected],policy_version:0})));
  }
  let command:any;
  if(path==='status'||path==='retry'){
    await click(kind==='mute'?'Mute routine updates':'Confirm dismissal');
    await waitFor(()=>assert.ok(f.calls.at(-1)!.path.endsWith('/state')));command=f.calls.at(-1)!.body;
    await act(async()=>f.calls.at(-1)!.finish(Response.json({error:{code:'service_unavailable',message:'Unconfirmed',operation_outcome:'unknown'}},{status:503})));
  }
  await click('Load sibling');const sibling=f.calls.at(-1)!;
  await click(path==='lookup'?(kind==='mute'?'Refresh mute state':'Dismiss these source inputs'):path==='status'?'Check attention outcome':path==='retry'?'Retry same attention change':kind==='mute'?'Mute routine updates':'Confirm dismissal');
  await waitFor(()=>assert.notEqual(f.calls.at(-1),sibling));const attempted=f.calls.at(-1)!;
  if(path!=='lookup')command??=attempted.body;
  const reply=response==='unavailable result'?(path==='lookup'?(kind==='mute'?{...f.item,source:{state:'unavailable'}}:{items:[{...f.selected,availability:'unavailable'}],policy_version:0}):f.result(command)):
    {error:{code:response==='owner refusal'?'invalid_actor':'unavailable',message:'Current authority refused'}};
  await act(async()=>attempted.finish(Response.json(reply,{status:response==='unavailable result'?200:response==='owner refusal'?403:404})));
  assert.equal(!!screen.queryByRole('heading',{name:'Protected enclosing text'}),false);
  assert.equal(!!screen.queryByText(/Protected preview/),false);
  assert.equal(document.activeElement,screen.getByRole('alert'));
  if(command&&response!=='unavailable result')assert.deepEqual(f.journal.all()[0]!.command.body,command);
  if(command&&response==='unavailable result')assert.equal(f.journal.all().length,0,'confirmed decisions settle independently of withdrawn previews');
  await act(async()=>sibling.finish(Response.json({text:'Stale sibling text'})));
  assert.equal(!!screen.queryByText('Stale sibling text'),false);
});

for(const code of ['unavailable','invalid_actor'] as const)test(`group selection ${code} invalidates the host without an optional callback`,async t=>{
  const f=mount(t,'dismiss',true);await click('Dismiss this update');
  await act(async()=>f.calls.at(-1)!.finish(Response.json({error:{code,message:'Selection authority refused'}},{status:403})));
  assert.equal(!!screen.queryByRole('heading',{name:'Protected enclosing text'}),false);assert.equal(f.journal.all().length,0);
});

test('a late credential refusal withdraws a replacement view of the same identity',async t=>{
  const f=mount(t,'mute');await settle(f,'mute');await click('Mute routine updates');await waitFor(()=>assert.ok(f.calls.at(-1)!.path.endsWith('/state')));
  const pending=f.calls.at(-1)!;f.rendered.rerender(f.view(true));
  assert.ok(screen.getByRole('heading',{name:'Replacement protected view'}));
  await act(async()=>pending.finish(Response.json({error:{code:'invalid_actor',message:'Credential revoked'}},{status:403})));
  assert.equal(!!screen.queryByRole('heading',{name:'Replacement protected view'}),false);
  assert.deepEqual(f.journal.all()[0]!.command.body,pending.body);
});

for(const response of ['refusal','unavailable result'] as const)test(`${response} withdraws immediately while journal settlement is waiting for a Web Lock`,async t=>{
  const f=mount(t,'mute');await settle(f,'mute');await click('Mute routine updates');
  await waitFor(()=>assert.ok(f.calls.at(-1)!.path.endsWith('/state')));const sent=f.calls.at(-1)!;
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  t.mock.method(navigator.locks,'request',async(_name:string,work:()=>unknown)=>{await gate;return work();});
  try{
    await act(async()=>sent.finish(Response.json(response==='refusal'?{error:{code:'unavailable',message:'Source withdrawn'}}:f.result(sent.body),{status:response==='refusal'?404:200})));
    assert.equal(!!screen.queryByRole('heading',{name:'Protected enclosing text'}),false);
    assert.deepEqual(f.journal.all()[0]!.command.body,sent.body);
  }finally{await act(async()=>release());}
  await waitFor(()=>assert.equal(response==='refusal'?f.journal.all()[0]!.state:f.journal.all().length,response==='refusal'?'rejected':0));
});

test('refusal from an older browser identity cannot withdraw its replacement',async t=>{
  const f=mount(t,'mute');await settle(f,'mute');await click('Mute routine updates');await waitFor(()=>assert.ok(f.calls.at(-1)!.path.endsWith('/state')));
  const pending=f.calls.at(-1)!;
  await act(async()=>invalidateIdentity());f.rendered.rerender(f.view(true));
  await act(async()=>pending.finish(Response.json({error:{code:'invalid_actor',message:'Old credential refused'}},{status:403})));
  assert.ok(screen.getByRole('heading',{name:'Replacement protected view'}));
});

test('an attention control without an authorization owner fails closed',t=>{
  const context={community:{instance_id:randomUUID()},self:{participant_id:randomUUID()}} as Context;
  t.mock.method(console,'error',()=>{});
  assert.throws(()=>render(<MuteControl context={context} target={{kind:'artifact',resource_id:randomUUID()}}/>),/require an AuthorizationBoundary/);
});

function PrivateSources({context,input,group}:{context:Context;input:A.AttentionInputView;group:boolean}){
  const authority=useAuthorization(),[items,setItems]=useState<A.MuteItemView[]>([]);
  async function load(){const response=await authority.readAuthorized<A.AttentionListView>('/api/v1/me/attention/list',{body:{collection:'mutes'},self:context.self,schema:A.AttentionList});
    if(authority.current(response.generation))setItems(response.value.mutes);}
  useEffect(()=>{void load().catch(()=>{});},[]);
  return <><button onClick={()=>void load().catch(()=>{})}>Refresh private list</button>
    {items.map(item=><MuteControl key={item.target.resource_id} context={context} target={item.target} initial={item}/>)}
    <DismissControl context={context} {...(group?{cursor:'fixed-cursor',groupId:input.id}:{inputs:[input]})}/></>;
}
for(const path of ['lookup','selection','mutation','status','retry','undo'] as const)for(const refusal of [false,true])
test(`dismissal ${path} ${refusal?'refusal':'unavailable result'} after repeated restoration fences sibling previews and pending reads`,async t=>{
  const context={community:{instance_id:randomUUID()},self:{participant_id:randomUUID(),csrf:'fixture'}} as Context;
  const input={kind:'shared_event' as const,id:randomUUID()},journal=new AttentionRecovery(context.community.instance_id,context.self.participant_id);
  const items=[0,1].map(i=>({target:{kind:'artifact' as const,resource_id:randomUUID()},muted:true,include_descendants:false,version:1,
    source:{state:'available' as const,title:`Protected sibling ${i}`,path:[],browser_url:'/loom/attention'},other_current_scope_mutes:[]}));
  const unavailable=(item:typeof items[number])=>({...item,source:{state:'unavailable'},other_current_scope_mutes:[]});
  const page={collection:'mutes',mutes:items.map(unavailable),dismissals:[],policy_version:1,next_cursor:null,complete:true};
  const calls:{path:string;body:any;finish:(r:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(path:string,options:any)=>new Promise<Response>(finish=>calls.push({path,body:options.body?JSON.parse(options.body):undefined,finish})));
  render(<StrictMode><AuthorizationBoundary sourcePolicy="settings"><PrivateSources context={context} input={input} group={path==='selection'}/></AuthorizationBoundary></StrictMode>);
  await act(async()=>{for(const call of calls)call.finish(Response.json(page));});
  await act(async()=>{for(const call of calls.filter(c=>c.path.endsWith('/lookup')))call.finish(Response.json(unavailable(items.find(v=>v.target.resource_id===call.body.resource_id)!)));});
  const control=(index:number)=>within(document.querySelector(`[data-mute-target="artifact:${items[index]!.target.resource_id}"]`) as HTMLElement);
  async function refresh(index:number,visible:boolean){await act(async()=>fireEvent.click(control(index).getByRole('button',{name:'Refresh mute state'})));
    await act(async()=>calls.at(-1)!.finish(Response.json(visible?items[index]:unavailable(items[index]!))));}
  async function reauthorize(){for(const index of [0,1])await refresh(index,true);assert.equal(screen.queryAllByText(/Protected sibling/).length,2);}
  await reauthorize();await refresh(0,false);assert.equal(screen.queryAllByText(/Protected sibling/).length,0);await reauthorize();
  const selected={...input,version:0,dismissed:false,availability:'available'};
  const applied=(command:any,availability='available')=>({kind:'dismissal',operation_state:'applied',operation_id:randomUUID(),idempotency:'created',policy_version:1,
    outcome:{inputs:command.inputs.map((v:any)=>({...v,result_version:v.expected_version+1}))},
    current:command.inputs.map((v:any)=>({kind:v.kind,id:v.id,dismissed:v.dismissed,version:v.expected_version+1,availability}))});
  if(!['lookup','selection'].includes(path)){
    await click('Dismiss these source inputs');await act(async()=>calls.at(-1)!.finish(Response.json({items:[selected],policy_version:0})));
    if(path!=='mutation'){
      await click('Confirm dismissal');const first=calls.at(-1)!;
      await act(async()=>first.finish(Response.json(path==='undo'?applied(first.body):{error:{code:'service_unavailable',message:'Unconfirmed',operation_outcome:'unknown'}},{status:path==='undo'?200:503})));
      if(path==='undo')await act(async()=>{for(const call of calls.filter(c=>c.path.endsWith('/mutes/lookup')))call.finish(Response.json(items.find(v=>v.target.resource_id===call.body.resource_id)));});
    }
  }
  await click('Refresh private list');const list=calls.at(-1)!;
  await act(async()=>fireEvent.click(control(1).getByRole('button',{name:'Refresh mute state'})));const sibling=calls.at(-1)!;
  await click(path==='lookup'?'Dismiss these source inputs':path==='selection'?'Dismiss this update':path==='mutation'?'Confirm dismissal':path==='status'?'Check attention outcome':path==='retry'?'Retry same attention change':'Undo dismissal / restore these inputs');
  const pending=calls.at(-1)!,command=journal.all()[0]?.command;
  const value=path==='lookup'?{items:[{...selected,availability:'unavailable'}],policy_version:0}:
    path==='selection'?{selection:'bounded-selection',inputs:[{...selected,availability:'unavailable'}],policy_version:0,shared_events:1,personal_signals:0,
      membership:'exact_represented_inputs_including_unexpanded_direct_sources',expires_at:'2030-01-01T00:00:00Z'}:applied(command!.body,'unavailable');
  await act(async()=>pending.finish(Response.json(refusal?{error:{code:'unavailable',message:'Source withdrawn'}}:value,{status:refusal?404:200})));
  assert.equal(screen.queryAllByText(/Protected sibling/).length,0);
  await act(async()=>{list.finish(Response.json({...page,mutes:items}));sibling.finish(Response.json(items[1]));});
  assert.equal(screen.queryAllByText(/Protected sibling/).length,0);
  if(command)assert.equal(journal.all().length,refusal?1:0);
  // Safe private controls survive both source fences; a new lookup alone can
  // restore a preview, and another refusal must withdraw it once more.
  await reauthorize();await refresh(0,false);assert.equal(screen.queryAllByText(/Protected sibling/).length,0);
  assert.equal(control(1).getByRole('button',{name:'Unmute routine updates'}).getAttribute('aria-disabled'),'false');
});
