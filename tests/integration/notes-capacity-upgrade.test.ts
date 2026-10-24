import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/moderation.js';
import {reservationSnapshot as snapshot} from '../helpers/reservations.js';
import {prepareText} from '../helpers/file-text.js';
import {notes,createNote,changeNote,deleteNote,accepted,readNote} from '../helpers/notes.js';

test('actual active and retained populations are bounded, concurrent admission has one last slot and deletion remains reserved at decision capacity',{timeout:120000},async t=>{
 const f=await fixture(t),bodies=[];
 for(let i=0;i<127;i++){const body=createNote();await accepted(f.admin,'create',body);bodies.push(body);}
 const pair=[createNote(),createNote()],r=await Promise.all(pair.map(b=>f.admin.call(notes+'/create',b)));
 assert.deepEqual(r.map(r=>r.status).sort(),[200,429]);bodies.push(pair[r.findIndex(r=>r.status===200)]!);
 assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.private_notes WHERE deleted_at IS NULL')).rows[0].n,128);
 for(const body of bodies)await accepted(f.admin,'delete',deleteNote(body.note_id));
 for(let i=128;i<500;i++){const body=createNote();await accepted(f.admin,'create',body);await accepted(f.admin,'delete',deleteNote(body.note_id));}
 assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.private_notes')).rows[0].n,500);
 assert.equal((await f.admin.call(notes+'/create',createNote())).body.error.code,'note_limit');assert.equal((await accepted(f.admin,'create',bodies[0]!)).current.state,'deleted');
 const p=await f.participant('note_capacity'),body=createNote();await accepted(p.client,'create',body);
 // Counter frontier injection is separate from the actual identity population above.
 await f.observer.query('UPDATE loom.note_owners SET decisions=9999 WHERE participant_id=$1',[p.id]);
 const decisions=await Promise.all([p.client.call(notes+'/update',changeNote(body)),p.client.call(notes+'/update',changeNote(body))]);assert.deepEqual(decisions.map(r=>r.status).sort(),[200,429]);
 assert.equal((await p.client.call(notes+'/delete',deleteNote(body.note_id,1))).body.error.code,'note_limit','Stale delete cannot consume reserved applied slot');
 const detail=await readNote(p.client,body.note_id),deletion=deleteNote(body.note_id,detail.version);assert.equal((await accepted(p.client,'delete',deletion)).current.state,'deleted');
 assert.equal((await accepted(p.client,'delete',deletion)).current.state,'deleted');assert.equal((await accepted(p.client,'create',body)).current.state,'deleted');
 assert.equal((await p.client.call(notes+'/status',{action:'create',idempotency_key:body.idempotency_key})).body.current.state,'deleted');
});

test('populated additive 0022 upgrade preserves every prior table, old recovery and exact file bytes without note backfill',{timeout:120000},async t=>{
 const f=await fixture(t,{files:true,throughMigration:22}),d=await f.discussion(),c=await f.reply(d),s=await f.create(d.id);
 const member=await prepareText(f.admin,{kind:'area',resource_id:f.area},'private-notes-baseline.txt');
 const input={idempotency_key:randomUUID(),area_id:f.area,title:'Retained upgrade artifact',content:{format:'loom-markdown-v3',text:'Retained source',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[member]}};
 const a=(await f.admin.call('/api/v1/artifacts',input)).body;
 const manifest=(await f.admin.call(`/api/v1/artifacts/${a.resource_id}/revisions/${a.revision_id}/files`)).body;
 const exactBytes=(await f.admin.call(manifest.items[0].download_url)).body;assert.equal(exactBytes,'quartzneedle file content');
 const saved={idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:a.resource_id},saved:true,expected_version:0};await f.admin.call('/api/v1/me/saved-items/state',saved);
 await f.admin.call('/api/v1/editing-intent/announce',{idempotency_key:randomUUID(),resource_id:a.resource_id,base_revision_id:a.revision_id,purpose:'Retained old intent',scope:{kind:'whole'}});
 await f.follow(f.admin,f.settings('discussion',d.id));
 const before=await snapshot(f);await f.migrate();const after=await snapshot(f);for(const name of Object.keys(before))assert.deepEqual(after[name],before[name],name);
 assert.deepEqual(after.private_notes,[]);assert.deepEqual(after.note_operations,[]);assert.deepEqual(after.note_owners,[]);
 assert.equal((await f.admin.call('/api/v1/artifacts',input)).body.revision_id,a.revision_id);assert.equal((await f.admin.call('/api/v1/me/saved-items/state',saved)).body.idempotency,'replayed');
 assert.deepEqual((await f.admin.call(`/api/v1/artifacts/${a.resource_id}/revisions/${a.revision_id}/files`)).body,manifest);assert.equal((await f.admin.call(manifest.items[0].download_url)).body,exactBytes);
 for(const target of [d.opening,c,s,a])await accepted(f.admin,'create',createNote([{kind:target===s?'summary':target===a?'artifact':'contribution',resource_id:target.resource_id,revision_id:target.revision_id}]));
 const final=await snapshot(f);for(const name of Object.keys(before))assert.deepEqual(final[name],before[name],name);
});
