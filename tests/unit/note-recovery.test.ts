import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {IntentStore,type Intent} from '../../src/web/participation-client.js';
import {terminalNote,validateNoteCommand,validNoteRecord} from '../../src/web/note-recovery.js';
import type {NoteResultView,NoteDeletedView} from '../../src/contracts/notes.js';
function fixture(){const storage=new JSDOM('',{url:'https://loom.example'}).window.localStorage,store=new IntentStore('instance','alice',storage,'https://loom.example');const body={note_id:randomUUID(),title:'Private title',body:'Private body',links:[]};const record=(action='create',fields:Record<string,unknown>=body)=>store.create('notes:'+body.note_id,'notes.'+action,'/api/v1/me/notes/'+action,fields);return {storage,store,body,record};}
const receipt=(r:Intent,conflict=false):NoteResultView=>({operation_state:conflict?'version_conflict':'applied',operation_id:randomUUID(),action:r.kind.slice(6) as 'create',idempotency:'created',outcome:{note_id:String(r.body.note_id),expected_version:Number(r.body.expected_version??0),result_version:2,decided_at:'2026-10-24T00:00:00Z'},current:{note_id:String(r.body.note_id),version:2,state:'active',deleted_at:null}});
test('partial note drafts survive reload, validation retains exact bytes, immutable retry ignores replacement text and owners stay separated',async()=>{
 const f=fixture(),d=await f.store.saveDraft(f.record(),{...f.body,body:'',links:[{kind:'artifact',resource_id:''}]});assert.ok(validNoteRecord(d));await assert.rejects(f.store.prepareNote(d,d.body,()=>true));assert.deepEqual(f.store.all(),[d]);
 const saved=await f.store.prepareNote(d,f.body,()=>true),retry=await f.store.prepareNote(saved,{...f.body,body:'different'},()=>true);assert.deepEqual(retry.body,saved.body);
 const reopened=new IntentStore('instance','alice',f.storage,'https://loom.example');assert.deepEqual(reopened.all(),[retry]);for(const [instance,owner,origin] of [['other','alice','https://loom.example'],['instance','bob','https://loom.example'],['instance','alice','https://other.example']])assert.deepEqual(new IntentStore(instance!,owner!,f.storage,origin!).all(),[]);
 const stale=await f.store.saveDraft(d,{...f.body,body:'Unsent competing text'});assert.equal(stale.blocked_by,saved.key);assert.equal(stale.state,'draft');await assert.rejects(f.store.prepareNote(stale,stale.body,()=>true));assert.deepEqual(f.store.all().find(r=>r.key===retry.key)?.body,retry.body);
});
test('retained note records reject route, schema, receipt and canonical duplicate corruption',async()=>{
 const f=fixture(),d=await f.store.saveDraft(f.record(),f.body);
 for(const change of [{path:'/api/v1/revisions'},{kind:'notes.invalid'},{body:{...d.body,owner:'bob'}},{note_receipt:{}}]){f.storage.setItem(f.store.prefix+d.key,JSON.stringify({...d,...change}));assert.throws(()=>f.store.all());}f.storage.setItem(f.store.prefix+d.key,JSON.stringify(d));
 const link={kind:'artifact',resource_id:randomUUID()};for(const fields of [{body:' '},{body:'\0'},{body:'\ud800'},{title:'é'.repeat(129)},{body:'é'.repeat(8193)},{links:[link,{...link,resource_id:link.resource_id.toUpperCase()}]},{links:[{...link,kind:'discussion',revision_id:randomUUID()}]}])assert.throws(()=>validateNoteCommand('create',{...d.body,...fields}));
});
for(const removal of ['one','all'] as const)test('late draft autosave cannot recreate explicitly removed '+removal+' note copies',async()=>{
 const f=fixture(),draft=await f.store.saveDraft(f.record(),f.body);
 if(removal==='one')await f.store.removeNoteCopy(draft,()=>true);else await f.store.clearNoteCopies(f.body.note_id,undefined,()=>true);
 await assert.rejects(f.store.saveDraft(draft,{...f.body,body:'Queued private text'}),/changed in another view/);assert.deepEqual(f.store.all(),[]);
 const fresh=await f.store.saveDraft(f.record(),{...f.body,body:'Deliberately created new draft'});assert.deepEqual(f.store.all(),[fresh]);
});
test('cleanup between serialized autosaves keeps the note journal empty',async()=>{
 const f=fixture(),draft=await f.store.saveDraft(f.record(),f.body);let release!:()=>void,entered!:()=>void;
 const held=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve),lock=navigator.locks.request(f.store.prefix,async()=>{entered();await held;});await ready;
 const first=f.store.saveDraft(draft,{...f.body,body:'First queued edit'}),clear=f.store.clearNoteCopies(f.body.note_id,undefined,()=>true),later=first.then(saved=>f.store.saveDraft(saved,{...f.body,body:'Second queued edit'}));
 const rejected=assert.rejects(later,/changed in another view/);release();await Promise.all([lock,first,clear,rejected]);assert.deepEqual(f.store.all(),[]);
});
test('unknown update permits deliberate terminal delete, validated forgetting is note-specific and a late receipt cannot recreate cleared custody',async()=>{
 const f=fixture(),u=await f.store.prepareNote(f.record('update',{...f.body,expected_version:1}),{...f.body,expected_version:1},()=>true);
 await assert.rejects(f.store.prepareNote(f.record('update',{...f.body,expected_version:1}),{...f.body,expected_version:1},()=>true),/Reconcile/);
 const d=await f.store.prepareNote(f.record('delete',{note_id:f.body.note_id,expected_version:1}),{note_id:f.body.note_id,expected_version:1},()=>true);
 const retry=await f.store.prepareNote(u,{...u.body,body:'must not replace'},()=>true);assert.deepEqual(retry.body,u.body);
 const pub=await f.store.saveDraft(f.store.create('reply','reply.create','/api/v1/replies',{text:'Unrelated'}),{text:'Unrelated'});
 const terminal:NoteDeletedView={note_id:f.body.note_id,state:'deleted',version:2,deleted_at:'2026-10-24T00:00:00Z'};
 for(const proof of [undefined,{...terminal,note_id:randomUUID()},{...terminal,version:1},{...terminal,deleted_at:'invalid'},{...terminal,state:'active'}]){await assert.rejects(f.store.clearNoteCopies(f.body.note_id,proof as NoteDeletedView,()=>true));assert.equal(f.store.all().length,3);}
 assert.equal(terminalNote(pub,terminal),false);await assert.rejects(f.store.clearNoteCopies(f.body.note_id,terminal,()=>false));await f.store.clearNoteCopies(f.body.note_id,terminal,()=>true);assert.deepEqual(f.store.all(),[pub]);await assert.rejects(f.store.settleNote(u,receipt(u),()=>true));await assert.rejects(f.store.prepareNote(d,d.body,()=>true));assert.deepEqual(f.store.all(),[pub]);
});
test('original conflict custody retains proposed text, successful settlement is monotonic and resolved cleanup verifies durable removal',async t=>{
 const f=fixture(),u=await f.store.prepareNote(f.record('update',{...f.body,expected_version:1}),{...f.body,expected_version:1},()=>true),r=receipt(u,true);const settled=await f.store.settleNote(u,r,()=>true);assert.equal(settled.state,'rejected');assert.deepEqual(settled.body,u.body);assert.deepEqual(await f.store.settleNote(u,receipt(u),()=>true),settled);
 await assert.rejects(f.store.settleNote(u,{...r,outcome:{...r.outcome,note_id:randomUUID()}},()=>true));await assert.rejects(f.store.settleNote(u,r,()=>false));
 const before=Object.entries(f.storage);t.mock.method(Object.getPrototypeOf(f.storage),'removeItem',()=>{});await assert.rejects(f.store.removeNoteCopy(settled,()=>true),/could not be cleared/);assert.deepEqual(Object.entries(f.storage),before);t.mock.restoreAll();await f.store.removeNoteCopy(settled,()=>true);assert.deepEqual(f.store.all(),[]);
});
for(const failure of ['throw','readback'] as const)test('failed '+failure+' blocks unjournaled delete and preserves existing exact intent',async t=>{
 const f=fixture(),u=await f.store.prepareNote(f.record('update',{...f.body,expected_version:1}),{...f.body,expected_version:1},()=>true),before=Object.entries(f.storage);
 t.mock.method(Object.getPrototypeOf(f.storage),'setItem',()=>{if(failure==='throw')throw new Error('storage failed');});await assert.rejects(f.store.prepareNote(f.record('delete',{note_id:f.body.note_id,expected_version:1}),{note_id:f.body.note_id,expected_version:1},()=>true));await assert.rejects(f.store.settleNote(u,receipt(u),()=>true));assert.deepEqual(Object.entries(f.storage),before);
});
test('32-record and one-MiB custody bounds never evict notes or unrelated unknown publication records',async()=>{
 const f=fixture();for(let i=0;i<32;i++)await f.store.prepareNote(f.record('create',{...f.body,note_id:randomUUID()}),{...f.body,note_id:randomUUID()},()=>true);const before=Object.entries(f.storage);await assert.rejects(f.store.prepareNote(f.record('delete',{note_id:f.body.note_id,expected_version:1}),{note_id:f.body.note_id,expected_version:1},()=>true),/full/);assert.deepEqual(Object.entries(f.storage),before);
 const g=fixture();for(let i=0;i<10;i++){const body={...g.body,note_id:randomUUID(),body:'\u0001'.repeat(16384)};await g.store.saveDraft(g.record('create',body),body);}const bytes=Object.entries(g.storage);await assert.rejects(g.store.saveDraft(g.record(),{...g.body,body:'\u0001'.repeat(16384)}),/full/);assert.deepEqual(Object.entries(g.storage),bytes);
});
