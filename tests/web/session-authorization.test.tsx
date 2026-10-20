import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import {JSDOM} from 'jsdom';
import {StrictMode,useState} from 'react';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {AuthorizationBoundary,useAuthorization} from '../../src/web/AuthorizationBoundary.js';
import {sessionRequest,commandRequest,invalidateIdentity,identityGeneration,IntentStore,isDefinitiveRejection,type Self} from '../../src/web/participation-client.js';
import {FollowPage} from '../../src/contracts/private-controls.js';
import {useQuery} from '../../src/web/participation-state.js';
import {Value} from '@sinclair/typebox/value';
import {AccountInput} from '../../src/server/modules/identity/contracts.js';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event','CustomEvent'] as const)
 Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
const {render,screen,fireEvent,cleanup,act}=await import('@testing-library/react');
// JSDOM exercises the real shell's state/effects; Vite handles CSS in Chromium.
const css=registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const {ParticipationApp}=await import('../../src/web/ParticipationApp.js');css.deregister();
afterEach(()=>{cleanup();invalidateIdentity();localStorage.clear();});
const self:Self={participant_id:randomUUID(),credential_id:randomUUID(),nickname:'Reader',kind:'human',role:'participant'};
const denied=()=>Response.json({error:{code:'unauthenticated',message:'Sign in required.'}},{status:401});

test('the production shell settles anonymous discovery and retains a failed sign-in form across navigation',async t=>{
 const calls:{path:string;resolve:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string)=>new Promise<Response>(resolve=>calls.push({path,resolve})));
 let events=0;const changed=()=>{events++;};window.addEventListener('loom-identity',changed);
 t.after(()=>window.removeEventListener('loom-identity',changed));
 const router=createMemoryRouter([{path:'/loom/*',element:<ParticipationApp/>}],{initialEntries:['/loom']});
 t.after(()=>router.dispose());
 render(<StrictMode><RouterProvider router={router}/></StrictMode>);
 const initial=[...calls];assert.equal(initial.length,2);
 await act(async()=>{for(const call of initial)call.resolve(denied());});
 assert.ok(screen.queryByRole('button',{name:'Sign in with passkey'}));
 assert.equal(calls.length,2,'Settled anonymous discovery must not schedule another probe.');
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Sign in with passkey'})));
 assert.equal(calls.at(-1)!.path,'/api/v1/identity/signin/start');
 await act(async()=>calls.at(-1)!.resolve(denied()));
 assert.ok(screen.queryByText('Sign in required.'));
 assert.equal(calls.length,3,'A ceremony failure must not restart session discovery.');
 await act(async()=>router.navigate('/loom/saved'));
 assert.equal(calls.length,4);
 await act(async()=>calls.at(-1)!.resolve(denied()));
 assert.ok(screen.queryByRole('button',{name:'Sign in with passkey'}));
 assert.equal(calls.length,4);assert.equal(events,0);
});

const hosts=[['area','withdraw'],['discussion','projections'],['resource','withdraw'],['overview','withdraw'],
 ['following','settings'],['updates','withdraw'],['notifications','withdraw'],['attention','settings']] as const;
for(const [host,sourcePolicy] of hosts)
test(`${host}: ceremony and identity-record failures retain independent protected content`,async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json(self));await sessionRequest('/api/v1/identity/self');
 let authority!:ReturnType<typeof useAuthorization>;
 function Content(){authority=useAuthorization();return <p>Still authorized body</p>;}
 render(<StrictMode><AuthorizationBoundary sourcePolicy={sourcePolicy}><Content/></AuthorizationBoundary></StrictMode>);
 const before=identityGeneration();
 for(const [path,code] of [['/api/v1/identity/signin/finish','unauthenticated'],['/api/v1/identity/register/start','unavailable'],['/api/v1/identity/revoke','unavailable']] as const){
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code,message:'Local refusal.'}},{status:code==='unavailable'?404:401}));
  await act(async()=>assert.rejects(path.endsWith('/revoke')?commandRequest(path,{body:{}}):sessionRequest(path,{body:{}}),{code}));
  assert.ok(screen.queryByText('Still authorized body'));assert.equal(identityGeneration(),before);
 }
 // A missing identity record reached through the protected-read capability has
 // the same meaning as one reached through a command.
 await act(async()=>assert.rejects(authority.read('/api/v1/identity/credentials?participant_id=missing'),{code:'unavailable'}));
 assert.ok(screen.queryByText('Still authorized body'));assert.equal(identityGeneration(),before);
});
for(const [host,sourcePolicy] of hosts)for(const path of ['discovery','community','command','private-read','boundary-receipt'] as const)
test(`${host}: ${path} authority loss withdraws settled and pending siblings exactly once`,async t=>{
 const calls:{path:string;resolve:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string)=>new Promise<Response>(resolve=>calls.push({path,resolve})));
 const establish=sessionRequest('/api/v1/identity/self');calls.at(-1)!.resolve(Response.json(self));await establish;
 let authority!:ReturnType<typeof useAuthorization>;
 function Content(){authority=useAuthorization();const [late,setLate]=useState(false);return <><p>Protected body</p>
  <button onClick={()=>void authority.read('/api/v1/guide').then(()=>setLate(true),()=>{})}>Hold protected response</button>
  {late&&<p>Late protected body</p>}</>;}
 render(<StrictMode><AuthorizationBoundary scope={host} sourcePolicy={sourcePolicy}><Content/></AuthorizationBoundary>
  <AuthorizationBoundary scope="sibling"><p>Settled sibling</p></AuthorizationBoundary></StrictMode>);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Hold protected response'})));
 const held=calls.at(-1)!;
 const body={idempotency_key:randomUUID()},before=identityGeneration();
 const failure=path==='discovery'?sessionRequest('/api/v1/identity/self'):
  path==='community'?sessionRequest('/api/v1/community'):
  path==='command'?commandRequest('/api/v1/replies',{body,self}):
  path==='private-read'?authority.privateRead('/api/v1/me/following/private',{schema:FollowPage}):authority.savedCommand(body,'status',self);
 const rejected=assert.rejects(failure,{code:'unauthenticated'});
 await act(async()=>{calls.at(-1)!.resolve(denied());await rejected;});
 assert.equal(identityGeneration(),before+1);
 assert.equal(!!screen.queryByText('Protected body'),false);assert.equal(!!screen.queryByText('Settled sibling'),false);
 await act(async()=>held.resolve(Response.json({guide:'late'})));
 assert.equal(!!screen.queryByText('Late protected body'),false);
 // The shell's follow-up probe is ordinary anonymous discovery, not a second
 // authority event. This also holds while old boundary objects are retained.
 const anonymous=sessionRequest('/api/v1/identity/self'),settled=assert.rejects(anonymous,{code:'unauthenticated'});
 await act(async()=>{calls.at(-1)!.resolve(denied());await settled;});
 assert.equal(identityGeneration(),before+1);
});

for(const [host,sourcePolicy] of hosts)for(const path of ['publication','administration','organization','restricted-read'] as const)
test(`${host}: ${path} refusal preserves journal ownership through blocked settlement and pending responses`,async t=>{
 const calls:{path:string;body:unknown;resolve:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string,options:RequestInit)=>new Promise<Response>(resolve=>calls.push({path,body:options.body,resolve})));
 const establish=sessionRequest('/api/v1/identity/self');calls.at(-1)!.resolve(Response.json(self));await establish;
 let authority!:ReturnType<typeof useAuthorization>;
 function Content(){authority=useAuthorization();return <p>Protected body</p>;}
 render(<StrictMode><AuthorizationBoundary scope={host} sourcePolicy={sourcePolicy}><Content/></AuthorizationBoundary>
  <AuthorizationBoundary scope="sibling"><p>Settled sibling</p></AuthorizationBoundary></StrictMode>);
 const store=new IntentStore(randomUUID(),self.participant_id),body={text:'Exact\r\nsaved bytes',resource_id:randomUUID().toUpperCase()};
 const first=await store.prepareDispatch(store.create('first','reply.create','/api/v1/replies',body),body);
 const uncertain=await store.prepareDispatch(store.create('retry','reply.create','/api/v1/replies',body),body);
 const retry=await store.prepareDispatch(uncertain,{text:'Must never replace exact bytes'});
 const before=identityGeneration(),held=authority.read('/api/v1/guide');const heldCall=calls.at(-1)!;
 const heldRead=path!=='publication'?assert.rejects(held,{name:'AbortError'}):held;
 const receipt=commandRequest('/api/v1/replies',{body:retry.body,self});const receiptCall=calls.at(-1)!;
 const failure=path==='publication'?commandRequest('/api/v1/replies',{body:first.body,self}):
  path==='administration'?commandRequest('/api/v1/identity/accounts',{body:first.body,self}):
  path==='organization'?authority.organizationCommand(first.body,'changes',self):authority.read('/api/v1/identity/credentials');
 const rejected=assert.rejects(failure,{code:'forbidden'});
 await act(async()=>{calls.at(-1)!.resolve(Response.json({error:{code:'forbidden',message:'Action refused.'}},{status:403}));await rejected;});
 assert.equal(identityGeneration(),before);
 assert.equal(!!screen.queryByText('Settled sibling'),path==='publication');
 let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
 t.mock.method(navigator.locks,'request',async(_name:string,work:()=>unknown)=>{await barrier;return work();});
 const settlement=store.settle(first,{state:'rejected'});
 try{
  assert.deepEqual(store.all().find(r=>r.key===first.key),first);
  await act(async()=>{heldCall.resolve(Response.json({text:'Late content'}));await heldRead;});
  receiptCall.resolve(Response.json({operation_state:'committed'}));await receipt;
  assert.equal(identityGeneration(),before);
 }finally{release();}
 const settled=await settlement;
 assert.equal(settled.state,'rejected');assert.deepEqual(settled.body,first.body);
 assert.deepEqual(store.all().find(r=>r.key===retry.key),retry);
 assert.deepEqual(retry.body,uncertain.body);
 // A later refusal never proves an uncertain earlier dispatch was rejected.
 const later=new (await import('../../src/web/participation-client.js')).ApiError('forbidden','Refused');
 assert.equal(isDefinitiveRejection(later,true),false);
 await store.complete(retry);assert.deepEqual(store.all(),[settled]);
});


test('a refused administrative action withdraws role-protected account data while its exact journal still settles',async t=>{
 const calls:{path:string;resolve:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(path:string)=>new Promise<Response>(resolve=>calls.push({path,resolve})));
 const establish=sessionRequest('/api/v1/identity/self');calls.at(-1)!.resolve(Response.json({...self,role:'administrator'}));await establish;
 // This is the same protected query used by the production Admission component.
 // requireAdministrator guards both this read and the command below; a role
 // demotion returns forbidden, while identity/self still authenticates the owner.
 function Accounts(){const accounts=useQuery<{id:string;nickname:string}[]>('/api/v1/identity/accounts');
  return <>{accounts.data?.map(a=><p key={a.id}>{a.nickname}</p>)}</>;}
 render(<StrictMode><AuthorizationBoundary scope="administration"><Accounts/></AuthorizationBoundary></StrictMode>);
 await act(async()=>{for(const c of calls.filter(c=>c.path.endsWith('/accounts')))c.resolve(Response.json([{id:randomUUID(),nickname:'Administrator-only account'}]));});
 assert.ok(screen.queryByText('Administrator-only account'));
 const store=new IntentStore(randomUUID(),self.participant_id),body={nickname:'ReviewAccount',kind:'agent',role:'participant'};
 const exact=await store.prepareDispatch(store.create('admission','account.create','/api/v1/identity/accounts',body),body),before=identityGeneration();
 assert.ok(Value.Check(AccountInput,exact.body),'The regression must send a valid administrative command.');
 const command=commandRequest(exact.path,{body:exact.body,self}),refused=assert.rejects(command,{code:'forbidden'});
 await act(async()=>{calls.at(-1)!.resolve(Response.json({error:{code:'forbidden',message:'This action requires current administrator authority.'}},{status:403}));await refused;});
 const settled=await store.settle(exact,{state:'rejected'});
 assert.equal(identityGeneration(),before);assert.equal(settled.state,'rejected');assert.deepEqual(settled.body,exact.body);
 assert.equal(!!screen.queryByText('Administrator-only account'),false,'Lost administrator authority must withdraw its cached account data without changing the private journal owner.');
});

for(const path of ['first','status','retry'] as const)
test(`production administration: ${path} refusal withdraws metadata before journal settlement and preserves private recovery`,async t=>{
 const {Onboarding}=await import('../../src/contracts/participation.js');
 const {SearchHealth}=await import('../../src/contracts/search.js');
 const instance=randomUUID(),admin={...self,role:'administrator'};
 const community=Value.Create({...Onboarding,properties:{...Onboarding.properties,instance_id:{...Onboarding.properties.instance_id,default:instance}}});
 community.settings_version=1;
 const store=new IntentStore(instance,self.participant_id),body={nickname:'PrivateDraft',kind:'agent',role:'participant'};
 const draft=await store.saveDraft(store.create('admission','account.create','/api/v1/identity/accounts',body),body);
 if(path!=='first')await store.prepareDispatch(draft,body);
 const commands:{path:string;body:unknown;resolve:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(url:string,options?:RequestInit)=>{
  if(options?.method==='POST')return new Promise<Response>(resolve=>commands.push({path:url,body:JSON.parse(String(options.body)),resolve}));
  if(url==='/api/v1/identity/self')return Promise.resolve(Response.json(admin));
  if(url==='/api/v1/community')return Promise.resolve(Response.json(community));
  if(url==='/api/v1/identity/accounts')return Promise.resolve(Response.json([{id:randomUUID(),nickname:'ProtectedAccount',kind:'agent',state:'suspended',role:'participant'}]));
  if(url==='/api/v1/admin/search/health')return Promise.resolve(Response.json(Value.Create(SearchHealth)));
  if(url==='/api/v1/admin/search/failures')return Promise.resolve(Response.json({items:[],next_after:null}));
  throw new Error('Unexpected request: '+url);
 });
 const router=createMemoryRouter([{path:'/loom/*',element:<ParticipationApp/>}],{initialEntries:['/loom/admin']});t.after(()=>router.dispose());
 await act(async()=>{render(<StrictMode><RouterProvider router={router}/></StrictMode>);});
 assert.ok(screen.queryByText('ProtectedAccount · agent · suspended'));
 const before=identityGeneration();
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:path==='first'?'Create account':path==='status'?'Check account operation':'Retry same account creation'})));
 assert.equal(commands.length,1);const exact=store.all()[0]!;assert.deepEqual(exact.body,{...body,idempotency_key:exact.key});
 assert.deepEqual(commands[0]!.body,path==='status'?{operation_kind:exact.kind,idempotency_key:exact.key}:exact.body);
 let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
 t.mock.method(navigator.locks,'request',async(_name:string,work:()=>unknown)=>{await barrier;return work();});
 try{
  await act(async()=>commands[0]!.resolve(Response.json({error:{code:'forbidden',message:'Administrator permission was removed.'}},{status:403})));
  assert.equal(!!screen.queryByText('ProtectedAccount · agent · suspended'),false);
  assert.equal(identityGeneration(),before);
  assert.equal((screen.getByLabelText('Nickname',{exact:true}) as HTMLInputElement).value,'PrivateDraft');
  assert.deepEqual(store.all()[0],exact,'Content withdrawal must precede the blocked private journal settlement.');
 }finally{await act(async()=>release());}
 assert.equal(store.all()[0]!.state,path==='first'?'rejected':'uncertain');
 assert.deepEqual(store.all()[0]!.body,exact.body);
 assert.ok(screen.queryByText('Administrator permission was removed.'));
 assert.ok(screen.queryByRole('button',{name:path==='first'?'Prepare corrected account operation':'Check account operation'}));
});

for(const arrival of ['selected','issued','pending-secret'] as const)
test(`production administration: ${arrival} copies cannot outlive their content lease`,async t=>{
 const {Onboarding}=await import('../../src/contracts/participation.js');
 const {SearchHealth}=await import('../../src/contracts/search.js');
 const instance=randomUUID(),account=randomUUID(),credential=randomUUID(),admin={...self,role:'administrator'};
 const accountKind=arrival==='issued'?'agent':'human';
 const community=Value.Create({...Onboarding,properties:{...Onboarding.properties,instance_id:{...Onboarding.properties.instance_id,default:instance}}});community.settings_version=1;
 const commands:{path:string;body:unknown;resolve:(r:Response)=>void}[]=[];
 const reads:{resolve:(r:Response)=>void}[]=[];
 t.mock.method(globalThis,'fetch',(url:string,options?:RequestInit)=>{
  if(options?.method==='POST')return new Promise<Response>(resolve=>commands.push({path:url,body:JSON.parse(String(options.body)),resolve}));
  if(url==='/api/v1/identity/self')return Promise.resolve(Response.json(admin));
  if(url==='/api/v1/community')return Promise.resolve(Response.json(community));
  if(url==='/api/v1/identity/accounts')return Promise.resolve(Response.json([{id:account,nickname:'ProtectedSelection',kind:accountKind,state:'active',role:'participant'}]));
  if(url.startsWith('/api/v1/identity/credentials?'))return new Promise<Response>(resolve=>reads.push({resolve}));
  if(url==='/api/v1/admin/search/health')return Promise.resolve(Response.json(Value.Create(SearchHealth)));
  if(url==='/api/v1/admin/search/failures')return Promise.resolve(Response.json({items:[],next_after:null}));
  throw new Error('Unexpected request: '+url);
 });
 const router=createMemoryRouter([{path:'/loom/*',element:<ParticipationApp/>}],{initialEntries:['/loom/admin']});t.after(()=>router.dispose());
 await act(async()=>{render(<StrictMode><RouterProvider router={router}/></StrictMode>);});
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Manage credentials'})));
 assert.equal((screen.getByLabelText('Nickname') as HTMLInputElement).value,'ProtectedSelection');
 const response=()=>Response.json({operation_state:'committed',participant_id:account,credential_id:credential,secret:'Synthetic_one_time_value'});
 if(arrival!=='selected'){
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:accountKind==='agent'?'Issue agent credential':'Issue enrollment ticket'})));
  assert.equal(commands.length,1);
  if(arrival==='issued'){
   await act(async()=>commands[0]!.resolve(response()));
   assert.equal((screen.getByLabelText('Issued secret') as HTMLTextAreaElement).value,'Synthetic_one_time_value');
  }
 }
 const store=new IntentStore(instance,self.participant_id),before=identityGeneration();
 const refusal=commandRequest('/api/v1/identity/reconcile',{body:{operation_kind:'credential.issue',idempotency_key:randomUUID()},self:admin});
 const rejected=assert.rejects(refusal,{code:'forbidden'});
 await act(async()=>{commands.at(-1)!.resolve(Response.json({error:{code:'forbidden',message:'Administrator permission was removed.'}},{status:403}));await rejected;});
 if(arrival==='pending-secret'){
  assert.ok(screen.queryByRole('button',{name:'Issue enrollment ticket'}),'Pending recovery must use the immutable command kind, not withdrawn selection metadata.');
  await act(async()=>commands[0]!.resolve(response()));
 }
 await act(async()=>{for(const read of reads)read.resolve(Response.json([{id:credential,kind:'agent',label:'ProtectedCredential',state:'active'}]));});
 assert.equal(identityGeneration(),before);
 assert.equal(!!screen.queryByLabelText('Issued secret'),false);
 assert.equal(!!screen.queryByDisplayValue('ProtectedSelection'),false);
 assert.equal(!!screen.queryByText(/ProtectedCredential/),false);
 assert.equal(!!screen.queryByText('ProtectedSelection · '+accountKind+' · active'),false);
 assert.deepEqual(store.all(),[],'A late private success must retire the exact record without restoring its protected display.');
 if(arrival==='pending-secret'){
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Dismiss credential display'})));
  assert.ok(screen.queryByRole('button',{name:'Issue enrollment ticket'}),'The private issuance kind must survive without copying withdrawn account metadata.');
 }
});

for(const action of ['account','recovery','state','revoke','search'] as const)
test(`production administration: late ${action} success cannot start protected reads after withdrawal`,async t=>{
 const {Onboarding}=await import('../../src/contracts/participation.js');
 const {SearchHealth}=await import('../../src/contracts/search.js');
 const instance=randomUUID(),account=randomUUID(),credential=randomUUID(),admin={...self,role:'administrator'};
 const community=Value.Create({...Onboarding,properties:{...Onboarding.properties,instance_id:{...Onboarding.properties.instance_id,default:instance}}});community.settings_version=1;
 const store=new IntentStore(instance,self.participant_id);
 if(action==='account'||action==='recovery'){
  const body={nickname:'PrivateCreation',kind:'human',role:'participant'};
  const draft=await store.saveDraft(store.create('admission','account.create','/api/v1/identity/accounts',body),body);
  if(action==='recovery')await store.prepareDispatch(draft,body);
 }else if(action==='revoke'){
  const body={participant_id:account,kind:'enrollment',purpose:'enroll',label:'Synthetic participation',replace_credential_id:null};
  await store.prepareDispatch(store.create('admission','credential.issue','/api/v1/identity/credentials',body),body);
 }
 const commands:{path:string;resolve:(r:Response)=>void}[]=[],reads:string[]=[];
 t.mock.method(globalThis,'fetch',(url:string,options?:RequestInit)=>{
  if(options?.method==='POST')return new Promise<Response>(resolve=>commands.push({path:url,resolve}));
  reads.push(url);
  if(url==='/api/v1/identity/self')return Promise.resolve(Response.json(admin));
  if(url==='/api/v1/community')return Promise.resolve(Response.json(community));
  if(url==='/api/v1/identity/accounts')return Promise.resolve(Response.json([{id:account,nickname:'ProtectedAccount',kind:'human',state:'active',role:'participant'}]));
  if(url.startsWith('/api/v1/identity/credentials?'))return Promise.resolve(Response.json([{id:credential,kind:'enrollment',label:'ProtectedCredential',state:'active'}]));
  if(url==='/api/v1/admin/search/health')return Promise.resolve(Response.json(Value.Create(SearchHealth)));
  if(url==='/api/v1/admin/search/failures')return Promise.resolve(Response.json({items:[],next_after:null}));
  throw new Error('Unexpected request: '+url);
 });
 const router=createMemoryRouter([{path:'/loom/*',element:<ParticipationApp/>}],{initialEntries:['/loom/admin']});t.after(()=>router.dispose());
 await act(async()=>{render(<StrictMode><RouterProvider router={router}/></StrictMode>);});
 const refuse=async()=>{
  const refusal=commandRequest('/api/v1/identity/reconcile',{body:{operation_kind:'account.create',idempotency_key:randomUUID()},self:admin});
  const rejected=assert.rejects(refusal,{code:'forbidden'});
  await act(async()=>{commands.at(-1)!.resolve(Response.json({error:{code:'forbidden',message:'Recheck protected access.'}},{status:403}));await rejected;});
 };
 // Recovery initiated after withdrawal still has no metadata authority.
 if(action==='recovery')await refuse();
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:{account:'Create account',recovery:'Check account operation',state:'Suspend',revoke:'Revoke',search:'Start search rebuild'}[action]})));
 const pending=commands.at(-1)!;
 if(action!=='recovery')await refuse();
 const before=[...reads];
 await act(async()=>pending.resolve(Response.json(action==='search'?{generation:1}:{operation_state:'committed',participant_id:account,credential_id:credential})));
 assert.deepEqual(reads,before,'A late receipt cannot implicitly request replacement metadata, including when it mounts credential recovery.');
 assert.equal(!!screen.queryByText(/ProtectedCredential/),false);
 assert.equal(!!screen.queryByText('ProtectedAccount · human · active'),false);
 if(action==='account'||action==='recovery'){
  assert.deepEqual(store.all(),[]);
  assert.ok(screen.queryByRole('button',{name:'Issue enrollment ticket'}));
 }
 const refresh=action==='account'||action==='recovery'?'Refresh credentials':action==='search'?'Refresh search health':'Refresh accounts';
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:refresh})));
 assert.ok(reads.length>before.length,'An explicit refresh must still obtain new authorization.');
 assert.ok(screen.queryByText(action==='account'||action==='recovery'?/ProtectedCredential/:action==='search'?/Generation 0 · Worker/: 'ProtectedAccount · human · active'));
});

for(const outcome of ['current','withdrawn'] as const)
test(`production configuration: ${outcome} success refreshes only with current content authority`,async t=>{
 const {Onboarding}=await import('../../src/contracts/participation.js');
 const {SearchHealth}=await import('../../src/contracts/search.js');
 const community=Value.Create({...Onboarding,properties:{...Onboarding.properties,instance_id:{...Onboarding.properties.instance_id,default:randomUUID()}}});community.settings_version=1;
 const commands:{path:string;body:Record<string,unknown>;resolve:(r:Response)=>void}[]=[],reads:string[]=[];
 t.mock.method(globalThis,'fetch',(url:string,options?:RequestInit)=>{
  if(options?.method==='POST')return new Promise<Response>(resolve=>commands.push({path:url,body:JSON.parse(String(options.body)),resolve}));
  reads.push(url);
  if(url==='/api/v1/identity/self')return Promise.resolve(Response.json({...self,role:'administrator'}));
  if(url==='/api/v1/community')return Promise.resolve(Response.json(community));
  if(url==='/api/v1/identity/accounts')return Promise.resolve(Response.json([]));
  if(url==='/api/v1/admin/search/health')return Promise.resolve(Response.json(Value.Create(SearchHealth)));
  if(url==='/api/v1/admin/search/failures')return Promise.resolve(Response.json({items:[],next_after:null}));
  throw new Error('Unexpected request: '+url);
 });
 const router=createMemoryRouter([{path:'/loom/*',element:<ParticipationApp/>}],{initialEntries:['/loom/admin']});t.after(()=>router.dispose());
 await act(async()=>{render(<StrictMode><RouterProvider router={router}/></StrictMode>);});
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Save configuration'})));
 assert.equal(commands[0]!.body.expected_version,1);
 if(outcome==='withdrawn'){
  const refusal=commandRequest('/api/v1/identity/reconcile',{body:{operation_kind:'account.create',idempotency_key:randomUUID()},self});
  const rejected=assert.rejects(refusal,{code:'forbidden'});
  await act(async()=>{commands[1]!.resolve(Response.json({error:{code:'forbidden',message:'Recheck access.'}},{status:403}));await rejected;});
 }
 const before=[...reads];community.settings_version=2;
 await act(async()=>commands[0]!.resolve(Response.json({operation_state:'committed'})));
 if(outcome==='withdrawn'){
  assert.deepEqual(reads,before,'Late configuration success must not restart shell discovery or a protected query.');
  assert.equal(!!screen.queryByRole('button',{name:'Save configuration'}),false);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh configuration'})));
 }
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Save configuration'})));
 assert.equal(commands.at(-1)!.body.expected_version,2,'Repeated saves must use the newly authorized configuration version.');
 await act(async()=>commands.at(-1)!.resolve(Response.json({operation_state:'committed'})));
});

for(const path of ['first','status','retry'] as const)
test(`production setup: ${path} settlement leaves reauthorization to an explicit refresh`,async t=>{
 const {Onboarding,Committed}=await import('../../src/contracts/participation.js');
 const {SearchHealth}=await import('../../src/contracts/search.js');
 const instance=randomUUID(),community=Value.Create({...Onboarding,properties:{...Onboarding.properties,instance_id:{...Onboarding.properties.instance_id,default:instance}}});community.settings_version=0;
 const store=new IntentStore(instance,self.participant_id),body={community_name:'PrivateSetup',ordinary_area_name:'General',proposal_area_name:'Proposals',overview:{format:'loom-markdown-v1',text:'Setup draft',mentions:[]}};
 const draft=await store.saveDraft(store.create('setup','community.setup','/api/v1/community/setup',body),body);
 if(path!=='first')await store.prepareDispatch(draft,body);
 const commands:{resolve:(r:Response)=>void}[]=[],reads:string[]=[];
 t.mock.method(globalThis,'fetch',(url:string,options?:RequestInit)=>{
  if(options?.method==='POST')return new Promise<Response>(resolve=>commands.push({resolve}));
  reads.push(url);
  if(url==='/api/v1/identity/self')return Promise.resolve(Response.json({...self,role:'administrator'}));
  if(url==='/api/v1/community')return Promise.resolve(Response.json(community));
  if(url==='/api/v1/identity/accounts')return Promise.resolve(Response.json([]));
  if(url==='/api/v1/admin/search/health')return Promise.resolve(Response.json(Value.Create(SearchHealth)));
  if(url==='/api/v1/admin/search/failures')return Promise.resolve(Response.json({items:[],next_after:null}));
  throw new Error('Unexpected request: '+url);
 });
 const router=createMemoryRouter([{path:'/loom/*',element:<ParticipationApp/>}],{initialEntries:['/loom/admin']});t.after(()=>router.dispose());
 await act(async()=>{render(<StrictMode><RouterProvider router={router}/></StrictMode>);});
 const refuse=async()=>{
  const refusal=commandRequest('/api/v1/identity/reconcile',{body:{operation_kind:'account.create',idempotency_key:randomUUID()},self});
  const rejected=assert.rejects(refusal,{code:'forbidden'});
  await act(async()=>{commands.at(-1)!.resolve(Response.json({error:{code:'forbidden',message:'Recheck access.'}},{status:403}));await rejected;});
 };
 if(path!=='first')await refuse();
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:path==='first'?'Initialize community':path==='status'?'Check setup status':'Retry same setup'})));
 const pending=commands.at(-1)!,exact=store.all()[0]!;
 if(path==='first')await refuse();
 const before=[...reads];community.settings_version=1;
 const receipt={publication_state:'committed',idempotency:path==='first'?'created':'replayed',operation_id:randomUUID(),resource_id:randomUUID(),revision_id:randomUUID()};
 assert.ok(Value.Check(Committed,receipt));
 await act(async()=>pending.resolve(Response.json(receipt)));
 assert.deepEqual(reads,before,'Private setup completion cannot restart shell discovery after withdrawal.');
 assert.deepEqual(store.all(),[]);
 assert.equal(exact.body.community_name,'PrivateSetup');
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh administration'})));
 assert.ok(reads.length>before.length);
 assert.equal(!!screen.queryByText('Initialize the community'),false);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh configuration'})));
 assert.ok(screen.queryByRole('button',{name:'Save configuration'}));
});
