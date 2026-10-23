import assert from 'node:assert/strict';
import {afterEach,test,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode,useState} from 'react';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {AuthorizationBoundary} from '../../src/web/AuthorizationBoundary.js';
import {FileEditor,FileBrowser,fileDigest} from '../../src/web/Files.js';
import {IntentStore,invalidateIdentity} from '../../src/web/participation-client.js';
import type {Context} from '../../src/web/participation-state.js';
import type {PublicationFileSet} from '../../src/contracts/files.js';

const locks=navigator.locks;
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event'] as const)
  Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
const {render,screen,fireEvent,cleanup,act,waitFor}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});
function context(){const instance=randomUUID(),participant=randomUUID();return {store:new IntentStore(instance,participant,localStorage,location.origin,locks),self:{participant_id:participant,credential_id:randomUUID(),nickname:'files',kind:'human',role:'participant'},community:{instance_id:instance}} as Context;}
function mount(t:TestContext,c:Context,target:string,browse=false){
  const calls:{path:string;options:RequestInit|undefined;finish:(response:Response)=>void}[]=[];
  t.mock.method(globalThis,'fetch',(path:string,options?:RequestInit)=>new Promise<Response>(finish=>calls.push({path,options,finish})));
  function Editor(){const [value,setValue]=useState<PublicationFileSet>(),[pending,setPending]=useState(false);
    return <><FileEditor context={c} target={{kind:'area',resource_id:target}} value={value} disabled={false} onPending={setPending} onChange={async v=>{setValue(v);return true;}}/><output>{JSON.stringify(value??null)}</output><span>{pending?'Blocked':'Ready'}</span></>;}
  const router=createMemoryRouter([{path:'/files',element:<AuthorizationBoundary><Editor/>{browse&&<FileBrowser participant={c.self.participant_id} artifact={target} revision={randomUUID()}/>}</AuthorizationBoundary>},{path:'/other',element:<h1>Other context</h1>}],{initialEntries:['/files']});
  t.after(()=>router.dispose());render(<StrictMode><RouterProvider router={router}/></StrictMode>);return {calls,router};
}
async function saved(c:Context,target:string){const file=new File(['original'],'original.txt',{type:'text/plain'});
  const record=await c.store.save(c.store.create('file.upload:'+target+':'+randomUUID(),'file.upload','/api/v1/file-uploads',{target:{kind:'area',resource_id:target},path:'nested/original.txt',size:file.size,sha256:(await fileDigest(file)).toUpperCase(),media_type:file.type}));
  return {record,file};
}
function status(record:{body:Record<string,any>},state='prepared'){return {upload_id:randomUUID(),state,path:record.body.path,size:record.body.size,sha256:record.body.sha256.toLowerCase(),media_type:record.body.media_type,upload_expires_at:'2026-10-21T01:00:00Z',prepared_expires_at:'2026-10-22T00:00:00Z'};}

test('editing an empty path retains readable draft custody and malformed upload recovery fails explicitly',async()=>{
  const c=context(),body={file_set:{version:'artifact-files-v1',files:[{path:'original',source:{upload_id:randomUUID()}}]}};
  const original=await c.store.save(c.store.create('draft','artifact.create','/api/v1/artifacts',body));
  const partial=await c.store.saveDraft(original,{file_set:{...body.file_set,files:[{...body.file_set.files[0]!,path:''}]}});
  assert.equal((c.store.all()[0]!.body.file_set as PublicationFileSet).files[0]!.path,'');
  const corrected=await c.store.saveDraft(partial,body);assert.equal(corrected.key,original.key);
  await c.store.prepareDispatch(corrected,corrected.body);assert.deepEqual(c.store.all()[0]!.body.file_set,body.file_set);
  const malformed=c.store.create('upload','file.upload','/api/v1/file-uploads',{target:null});await c.store.save(malformed);
  const before=Object.entries(localStorage);assert.throws(()=>c.store.all(),/upload metadata is incompatible/);assert.deepEqual(Object.entries(localStorage),before);
});

test('StrictMode recovery is explicit, preserves exact metadata, and never uploads on render or from a private status receipt',async t=>{
  const c=context(),target=randomUUID(),{record}=await saved(c,target),uncertain=await c.store.prepareDispatch(record,record.body),before=Object.entries(localStorage);
  const {calls}=mount(t,c,target);assert.equal(calls.length,0);assert.ok(screen.getByText('Blocked'));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check file status'})));assert.equal(calls.length,1);
  await act(async()=>calls[0]!.finish(Response.json(status(uncertain))));assert.deepEqual(Object.entries(localStorage),before);assert.equal(document.querySelector('output')!.textContent,'null');
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Use prepared file'})));
  assert.equal(c.store.all()[0]!.state,'committed');assert.deepEqual(c.store.all()[0]!.body,uncertain.body);assert.ok(screen.getByLabelText('File path 1'));assert.equal(calls.length,1);
  await act(async()=>fireEvent.change(screen.getByLabelText('File path 1'),{target:{value:'renamed.txt'}}));assert.match(document.querySelector('output')!.textContent!,/renamed.txt/);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Remove renamed.txt'})));assert.equal(screen.queryByLabelText('File path 1'),null);
});

test('StrictMode file reselection checks original bytes and persists the exact request before binary dispatch',async t=>{
  const c=context(),target=randomUUID(),{record,file}=await saved(c,target),{calls}=mount(t,c,target);
  await act(async()=>fireEvent.change(screen.getByLabelText('Reselect original nested/original.txt'),{target:{files:[new File(['changed!'],'original.txt')]}}));
  await waitFor(()=>assert.match(screen.getByRole('alert').textContent!,/Reselected bytes differ/));assert.equal(calls.length,0);
  await act(async()=>fireEvent.change(screen.getByLabelText('Reselect original nested/original.txt'),{target:{files:[file]}}));
  await waitFor(()=>assert.equal((screen.getByRole('button',{name:'Upload and prepare nested/original.txt'}) as HTMLButtonElement).disabled,false));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Upload and prepare nested/original.txt'})));
  assert.equal(c.store.all()[0]!.state,'uncertain');assert.deepEqual(JSON.parse(String(calls[0]!.options!.body)),c.store.all()[0]!.body);
  const receipt=status(record,'waiting');await act(async()=>calls[0]!.finish(Response.json(receipt,{status:201})));
  await waitFor(()=>assert.equal(calls.length,2));assert.equal(calls[1]!.options!.body,file);assert.equal((calls[1]!.options!.headers as Record<string,string>)['Content-Type'],'application/octet-stream');
  const serialized=JSON.stringify(Object.entries(localStorage));assert.ok(!serialized.includes('data:'));assert.ok(!serialized.includes('blob:'));assert.ok(!serialized.includes('"bytes"'));
  await act(async()=>calls[1]!.finish(Response.json({...receipt,state:'staged'})));
  await waitFor(()=>assert.equal(calls.length,3));await act(async()=>calls[2]!.finish(Response.json({...receipt,state:'prepared'})));
  assert.equal(c.store.all()[0]!.state,'committed');assert.equal(calls.filter(call=>call.path.endsWith('/bytes')).length,1);
});

test('a definitive first upload refusal can be explicitly removed without stranding journal capacity',async t=>{
  const c=context(),target=randomUUID(),{record}=await saved(c,target);
  const other=await c.store.save(c.store.create('other','artifact.create','/api/v1/artifacts',{title:'Keep this draft'}));
  const {calls}=mount(t,c,target);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Upload and prepare nested/original.txt'})));
  await act(async()=>calls[0]!.finish(Response.json({error:{code:'file_capacity',message:'Capacity reached'}},{status:429})));
  await waitFor(()=>assert.equal(c.store.all().find(r=>r.key===record.key)!.state,'rejected'));
  assert.deepEqual(c.store.all().find(r=>r.key===record.key)!.body,record.body);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Remove rejected upload'})));
  assert.deepEqual(c.store.all(),[other]);assert.equal(calls.length,1);assert.ok(screen.getByText('Ready'));
});

test('an upload refusal after an uncertain attempt preserves exact recovery and cannot be removed',async t=>{
  const c=context(),target=randomUUID(),{record}=await saved(c,target);
  const uncertain=await c.store.prepareDispatch(record,record.body),{calls}=mount(t,c,target);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Upload and prepare nested/original.txt'})));
  await act(async()=>calls[0]!.finish(Response.json({error:{code:'file_capacity',message:'Capacity reached'}},{status:429})));
  await waitFor(()=>assert.match(screen.getByRole('alert').textContent!,/Capacity reached/));
  assert.equal(c.store.all()[0]!.state,'uncertain');assert.deepEqual(c.store.all()[0]!.body,uncertain.body);
  assert.equal(screen.queryByRole('button',{name:'Remove rejected upload'}),null);
});

test('a byte-phase refusal retains the admitted upload for exact recovery',async t=>{
  const c=context(),target=randomUUID(),{record,file}=await saved(c,target),{calls}=mount(t,c,target);
  await act(async()=>fireEvent.change(screen.getByLabelText('Reselect original nested/original.txt'),{target:{files:[file]}}));
  await waitFor(()=>assert.equal((screen.getByRole('button',{name:'Upload and prepare nested/original.txt'}) as HTMLButtonElement).disabled,false));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Upload and prepare nested/original.txt'})));
  await act(async()=>calls[0]!.finish(Response.json(status(record,'waiting'),{status:201})));
  await waitFor(()=>assert.equal(calls.length,2));
  await act(async()=>calls[1]!.finish(Response.json({error:{code:'file_mismatch',message:'Reselect the original bytes'}},{status:409})));
  await waitFor(()=>assert.match(screen.getByRole('alert').textContent!,/original bytes/));
  assert.equal(c.store.all()[0]!.state,'uncertain');assert.deepEqual(c.store.all()[0]!.body,record.body);
  assert.equal(screen.queryByRole('button',{name:'Remove rejected upload'}),null);
});

test('StrictMode source denial and late private status cannot restore files or settle another owner',async t=>{
  const c=context(),target=randomUUID(),{record}=await saved(c,target),{calls,router}=mount(t,c,target,true);
  const before=Object.entries(localStorage);await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Check file status'})));
  const receipt=calls.find(call=>call.path.endsWith('/status'))!;
  await act(async()=>calls.filter(call=>!call.path.endsWith('/status')).forEach(call=>call.finish(Response.json({error:{code:'unavailable',message:'Unavailable'}},{status:404}))));
  await act(async()=>receipt.finish(Response.json(status(record))));assert.equal(screen.queryByRole('button',{name:'Use prepared file'}),null);assert.deepEqual(Object.entries(localStorage),before);
  await act(async()=>router.navigate('/other'));assert.ok(screen.getByRole('heading',{name:'Other context'}));
});

test('StrictMode upload selection, omission, cleanup and identity changes preserve unrelated drafts',async t=>{
  const c=context(),target=randomUUID();await c.store.save(c.store.create('other','artifact.create','/api/v1/artifacts',{title:'Unaffected draft'}));
  const {calls}=mount(t,c,target);const file=new File(['new'],'new.txt',{type:'text/plain'});
  await act(async()=>fireEvent.change(screen.getByLabelText('Select file'),{target:{files:[file]}}));
  await act(async()=>fireEvent.change(screen.getByLabelText('Relative path'),{target:{value:'folder/new.txt'}}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Keep file selection'})));
  await waitFor(()=>assert.equal(c.store.all().length,2));assert.equal(calls.length,0);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Omit from this draft'})));assert.ok(screen.getByText('Ready'));assert.equal(c.store.all().length,2);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Clean up my expired uploads'})));
  await act(async()=>calls[0]!.finish(Response.json({removed:1,quarantined:0})));assert.match(screen.getByRole('alert').textContent!,/removed: 1/);assert.equal(c.store.all().length,2);
  await act(async()=>{invalidateIdentity();});assert.equal(screen.queryByRole('button',{name:'Keep file selection'}),null);
});
