import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import type {QueryResultRow} from 'pg';
import {fixture} from '../helpers/moderation.js';
import {reservationSnapshot as snapshot} from '../helpers/reservations.js';
import {incoming} from '../helpers/references.js';
import {SearchWorker} from '../../src/server/modules/search/worker.js';
import {notes,createNote,changeNote,deleteNote,accepted,readNote,queryNotes} from '../helpers/notes.js';

test('cookie and bearer owners manage standalone/all linked kinds without shared/private side effects; foreign/admin paths hide existence',{timeout:120000},async t=>{
  const f=await fixture(t),alice=await f.participant('notes_alice'),bob=await f.participant('notes_bob'),human=await f.participant('notes_human','human');
  const d=await f.discussion(),c=await f.reply(d),s=await f.create(d.id),a=await f.artifact();
  const targets=[{kind:'discussion' as const,resource_id:d.id},{kind:'contribution' as const,resource_id:d.opening.resource_id,revision_id:d.opening.revision_id},{kind:'contribution' as const,resource_id:c.resource_id},{kind:'summary' as const,resource_id:s.resource_id,revision_id:s.revision_id},{kind:'artifact' as const,resource_id:a.resource_id,revision_id:a.revision_id}];
  // Shared traversal is held while notes change; no note joins its source tables.
  await f.artifact();
  const shared=(await f.admin.call('/api/v1/artifacts?limit=1')).body;
  const backBefore=(await f.admin.call(incoming({kind:'artifact',resource_id:a.resource_id}))).body;
  const before=await snapshot(f),body=createNote(targets),created=await accepted(alice.client,'create',body);
  const standalone=createNote([], {title:'',body:'Standalone owner text'});await accepted(human.client,'create',standalone);
  assert.equal((await readNote(alice.client,body.note_id)).state,'active');
  const view=await readNote(alice.client,body.note_id);assert.equal(view.state,'active');if(view.state==='active'){assert.equal(view.body,body.body);assert.equal(view.title,body.title);assert.equal(view.links.length,5);}
  assert.equal((await alice.client.call(notes+'/'+body.note_id+'/sources')).body.items.length,5);
  for(const client of [bob.client,f.admin]){
    for(const suffix of ['', '/sources']){
      const denied=await client.call(notes+'/'+body.note_id+suffix),absent=await client.call(notes+'/'+randomUUID()+suffix);
      assert.equal(denied.headers['cache-control'],'private, no-store');assert.equal(denied.status,404);delete denied.body.error.request_id;delete absent.body.error.request_id;assert.deepEqual(denied.body,absent.body);
    }
    for(const action of ['update','delete']){
      const denied=await client.call(notes+'/'+action,action==='update'?changeNote(body):deleteNote(body.note_id));
      const absent=await client.call(notes+'/'+action,action==='update'?changeNote({...body,note_id:randomUUID()}):deleteNote(randomUUID()));
      assert.equal(denied.headers['cache-control'],'private, no-store');assert.equal(denied.status,404);delete denied.body.error.request_id;delete absent.body.error.request_id;assert.deepEqual(denied.body,absent.body);
    }
    assert.deepEqual((await client.call(notes+'/status',{action:'create',idempotency_key:body.idempotency_key})).body,{operation_state:'not_recorded'});
    for(const query of [body.title,body.body,body.note_id])assert.deepEqual((await queryNotes(client,{query})).items,[]);
    for(const path of ['/api/v1/resources/'+body.note_id,'/api/v1/resources/'+body.note_id+'/history','/api/v1/resources/'+body.note_id+'/revisions/'+body.note_id])assert.equal((await client.call(path)).status,404);
  }
  const update=changeNote(body,1,{body:'Edited literal <script>alert(1)</script> **markdown** @notes_bob https://example.invalid/private'});
  await accepted(alice.client,'update',update);assert.equal((await queryNotes(alice.client,{query:'edited literal'})).items[0]!.note_id,body.note_id);
  assert.deepEqual((await queryNotes(alice.client,{query:'Source'})).items,[],'source titles are not indexed');
  await accepted(alice.client,'delete',deleteNote(body.note_id,2));await accepted(human.client,'delete',deleteNote(standalone.note_id));
  const after=await snapshot(f);for(const name of Object.keys(before))if(!['private_notes','note_owners','note_operations'].includes(name))assert.deepEqual(after[name],before[name],name);
  const backAfter=(await f.admin.call(incoming({kind:'artifact',resource_id:a.resource_id}))).body;delete backAfter.expires_at;delete backBefore.expires_at;assert.deepEqual(backAfter,backBefore);
  assert.ok(shared.next_cursor);assert.equal((await f.admin.call('/api/v1/artifacts?limit=1&cursor='+encodeURIComponent(shared.next_cursor))).status,200);
  const erased=(await f.observer.query('SELECT title,body,links,lexical,version,deleted_at FROM loom.private_notes WHERE participant_id=$1 AND id=$2',[alice.id,body.note_id])).rows[0];
  assert.deepEqual([erased.title,erased.body,erased.links,erased.lexical],[null,null,null,null]);assert.equal(erased.version,3);assert.ok(erased.deleted_at);
  const decisions=JSON.stringify((await f.observer.query('SELECT * FROM loom.note_operations')).rows);
  for(const canary of [body.title,body.body,update.body,a.resource_id,a.revision_id])assert.ok(!decisions.includes(canary));
  assert.deepEqual((await accepted(alice.client,'create',body)).outcome,created.outcome);
  assert.equal((await accepted(alice.client,'create',body)).current.state,'deleted');
});

test('lost before receipt and after COMMIT, restart, canonical retries, later writes and terminal deletion never restore old bodies',{timeout:120000},async t=>{
  let lose=false;
  const f=await fixture(t,{transactionWrapper:db=>({transaction:async work=>{
    let wrote=false;const value=await db.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,v:readonly unknown[])=>{const r=await tx.query<Row>(sql,v);if(sql.startsWith('INSERT INTO loom.note_operations'))wrote=true;return r;}}));
    if(lose&&wrote){lose=false;throw new Error('synthetic loss after commit');}return value;
  }})}),a=await f.artifact(),body=createNote([{kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id}]);
  assert.deepEqual((await f.admin.call(notes+'/status',{action:'create',idempotency_key:body.idempotency_key})).body,{operation_state:'not_recorded'});
  lose=true;assert.equal((await f.admin.call(notes+'/create',body)).status,503);await f.restart();
  const first=(await f.admin.call(notes+'/status',{action:'create',idempotency_key:body.idempotency_key})).body;
  assert.equal(first.operation_state,'applied');assert.equal(first.current.note_id,body.note_id);
  const canonical=await accepted(f.admin,'create',{...body,note_id:body.note_id.toUpperCase(),idempotency_key:body.idempotency_key.toUpperCase(),links:body.links.map(l=>({...l,resource_id:l.resource_id.toUpperCase(),revision_id:l.revision_id!.toUpperCase()}))});assert.equal(canonical.operation_id,first.operation_id);
  for(const change of [{title:'other'},{body:'other'},{links:[]},{note_id:randomUUID()}])assert.equal((await f.admin.call(notes+'/create',{...body,...change})).body.error.code,'idempotency_conflict');
  const k2=changeNote(body,1,{body:'Second decision'});lose=true;assert.equal((await f.admin.call(notes+'/update',k2)).status,503);
  const k3=changeNote(body,2,{body:'Newest body'});await accepted(f.admin,'update',k3);
  const old=await accepted(f.admin,'update',k2);assert.equal(old.outcome.result_version,2);assert.equal(old.current.version,3);
  assert.equal((await readNote(f.admin,body.note_id) as any).body,'Newest body');
  const unknown=changeNote(body,3,{body:'Never received before deletion'});assert.equal((await f.admin.call(notes+'/status',{action:'update',idempotency_key:unknown.idempotency_key})).body.operation_state,'not_recorded');
  const del=deleteNote(body.note_id,3);lose=true;assert.equal((await f.admin.call(notes+'/delete',del)).status,503);await f.restart();
  const deleted=await accepted(f.admin,'delete',del);assert.equal(deleted.current.state,'deleted');
  assert.equal((await accepted(f.admin,'update',k2)).current.state,'deleted');assert.equal((await accepted(f.admin,'create',body)).current.state,'deleted');
  assert.equal((await f.admin.call(notes+'/update',unknown)).body.error.code,'note_deleted');assert.equal((await f.admin.call(notes+'/create',{...body,idempotency_key:randomUUID()})).body.error.code,'note_deleted');
  assert.equal((await f.admin.call(notes+'/status',{action:'update',idempotency_key:unknown.idempotency_key})).body.operation_state,'not_recorded','Deletion does not decide earlier unknown operation');
  assert.deepEqual((await queryNotes(f.admin,{query:'decision'})).items,[]);assert.equal((await readNote(f.admin,body.note_id)).state,'deleted');
  const replacement=createNote();await accepted(f.admin,'create',replacement);assert.equal((await f.admin.call(notes+'/update',unknown)).status,409);assert.equal((await readNote(f.admin,replacement.note_id)).version,1);
  await assert.rejects(f.database.transaction(tx=>tx.query("UPDATE loom.private_notes SET version=version+1,title='restored',body='restored',links='[]',deleted_at=NULL WHERE id=$1",[body.note_id])));
});

test('source loss, exact history, placement and closed reading never transfer note ownership or block unchanged-link edits/removal/deletion',{timeout:120000},async t=>{
  const f=await fixture(t),p=await f.participant('note_reader'),d=await f.discussion(),c=await f.reply(d),s=await f.create(d.id),a=await f.artifact();
  for(const target of [{kind:'discussion' as const,resource_id:d.id},{kind:'contribution' as const,resource_id:c.resource_id},{kind:'summary' as const,resource_id:s.resource_id},{kind:'artifact' as const,resource_id:a.resource_id,revision_id:a.revision_id}]){
    const body=createNote([target]);await accepted(p.client,'create',body);
    assert.equal((await p.client.call(notes+'/'+body.note_id+'/sources')).body.items[0].source.state,'available');
    await f.suppress(target.resource_id);
    const projection=(await p.client.call(notes+'/'+body.note_id+'/sources')).body;assert.deepEqual(projection.items[0],{target,source:{state:'unavailable'}});
    await accepted(p.client,'update',changeNote(body,1,{body:'Quoted independent text stays searchable'}));
    assert.equal((await queryNotes(p.client,{query:'Quoted independent'})).items[0]!.note_id,body.note_id);
    const fresh=await p.client.call(notes+'/create',createNote([target]));assert.equal(fresh.status,404);
    await accepted(p.client,'update',changeNote(body,2,{links:[]}));await accepted(p.client,'delete',deleteNote(body.note_id,3));
    await f.suppress(target.resource_id,false);
  }
  const current=createNote([{kind:'artifact',resource_id:a.resource_id}]),exact=createNote([{kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id}]);await accepted(p.client,'create',current);await accepted(p.client,'create',exact);
  await f.revise(f.admin,a,'Renamed shared source',[]);await f.move(a.resource_id,f.other);
  assert.equal((await p.client.call(notes+'/'+current.note_id+'/sources')).body.items[0].source.title,'Renamed shared source');
  assert.equal((await p.client.call(notes+'/'+exact.note_id+'/sources')).body.items[0].source.url,'/loom/resource/'+a.resource_id+'/'+a.revision_id);
  await f.observer.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[a.revision_id]);
  assert.equal((await p.client.call(notes+'/'+exact.note_id+'/sources')).body.items[0].source.state,'unavailable');
  assert.equal((await p.client.call(notes+'/'+current.note_id+'/sources')).body.items[0].source.state,'available');
  await accepted(p.client,'update',changeNote(exact));await accepted(p.client,'delete',deleteNote(exact.note_id,2));
  await f.observer.query('UPDATE loom.resources SET publication_open=false WHERE id=$1',[a.resource_id]);
  await accepted(p.client,'create',createNote([{kind:'artifact',resource_id:a.resource_id}]));
  const wrong=await f.artifact();for(const target of [{kind:'discussion',resource_id:d.id,revision_id:d.opening.revision_id},{kind:'artifact',resource_id:a.resource_id,revision_id:wrong.revision_id},{kind:'artifact',resource_id:c.resource_id},{kind:'summary',resource_id:randomUUID()}])assert.ok([400,404].includes((await p.client.call(notes+'/create',createNote([target as any]))).status));
});

test('owner-only bounded search, Unicode, byte escaping, cursor scope and mutation/restart invalidation',{timeout:120000},async t=>{
  const f=await fixture(t),p=await f.participant('other_notes'),bodies=[];
  for(let i=0;i<30;i++){const body=createNote([],{title:'term café '+i,body:'literal Ω & <tag> '+('\\\u0001'.repeat(150))});bodies.push(body);await accepted(f.admin,'create',body);}
  assert.equal((await queryNotes(f.admin,{query:'  term   café  ',limit:25})).items.length,25);
  assert.deepEqual((await queryNotes(f.admin,{query:'!!!'})).items,[]);
  assert.deepEqual((await queryNotes(f.admin,{query:'nonexistent'})).items,[]);
  const first=await queryNotes(f.admin,{query:'term',limit:2});assert.ok(first.next_cursor);
  for(const [client,query] of [[p.client,'term'],[f.admin,'other']] as const)assert.equal((await client.call(notes+'/query',{query,cursor:first.next_cursor})).body.error.code,'invalid_cursor');
  await accepted(p.client,'create',createNote());assert.equal((await f.admin.call(notes+'/query',{query:'term',cursor:first.next_cursor})).status,200,'Another owner cannot invalidate cursor');
  const seen=new Set<string>();let cursor:string|undefined;
  do {const page=await queryNotes(f.admin,{query:'term',limit:25,max_response_bytes:4096,...(cursor?{cursor}:{})});assert.ok(Buffer.byteLength(JSON.stringify(page))<=4096);for(const item of page.items){assert.ok(!seen.has(item.note_id));seen.add(item.note_id);assert.equal(item.excerpt_abbreviated,true);}cursor=page.next_cursor??undefined;}while(cursor);
  assert.equal(seen.size,30);
  assert.equal((await f.admin.call(notes+'/query',{query:'term',max_response_bytes:1024})).body.error.code,'response_budget_too_small');
  await accepted(f.admin,'update',changeNote(bodies[0]!,1,{body:'changed'}));assert.equal((await f.admin.call(notes+'/query',{query:'term',cursor:first.next_cursor})).body.error.code,'note_collection_changed');
  const second=await queryNotes(f.admin,{query:'term',limit:1});await f.restart();assert.equal((await f.admin.call(notes+'/query',{query:'term',cursor:second.next_cursor})).body.error.code,'invalid_cursor');
  for(const query of ['🙂'.repeat(65),'a '.repeat(33),'\ud800','\0'])assert.equal((await f.admin.call(notes+'/query',{query})).status,400);
  for(const change of [{title:'é'.repeat(129)},{body:' '},{body:'\0'},{body:'\ud800'},{links:Array(9).fill({kind:'artifact',resource_id:randomUUID()})},{owner_id:p.id},{body:'a'.repeat(16385)}])assert.equal((await f.admin.call(notes+'/create',{...createNote(),...change})).status,400);
  const maximum=createNote([],{title:'é'.repeat(128),body:'\u0001'.repeat(16383)+'z'});await accepted(f.admin,'create',maximum);const detail=await readNote(f.admin,maximum.note_id);assert.equal((detail as any).body,maximum.body);assert.ok(Buffer.byteLength(JSON.stringify(detail))<=131072);
  const dupe={kind:'artifact' as const,resource_id:randomUUID()};assert.equal((await f.admin.call(notes+'/create',createNote([dupe,{...dupe,resource_id:dupe.resource_id.toUpperCase()}]))).status,400);
});

test('each note write rolls back content, lexical data, fences, quotas and outcome together',{timeout:90000},async t=>{
  let fail='';const f=await fixture(t,{transactionWrapper:db=>({transaction:work=>db.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,v:readonly unknown[])=>{const r=await tx.query<Row>(sql,v);if(fail&&sql.startsWith(fail))throw new Error('Synthetic note rollback');return r;}}))})});
  const body=createNote();
  for(const stage of ['INSERT INTO loom.private_notes','UPDATE loom.note_owners','INSERT INTO loom.note_operations']){const before=await snapshot(f);fail=stage;assert.equal((await f.admin.call(notes+'/create',body)).status,503);fail='';assert.deepEqual(await snapshot(f),before);}
  await accepted(f.admin,'create',body);
  for(const [action,command] of [['update',changeNote(body)],['delete',deleteNote(body.note_id)]] as const){const before=await snapshot(f);fail='INSERT INTO loom.note_operations';assert.equal((await f.admin.call(notes+'/'+action,command)).status,503);fail='';assert.deepEqual(await snapshot(f),before);}
});

test('actual application logging excludes note prose, queries and links on success, validation and database failure',{timeout:90000},async t=>{
 let log='',fail=false;const f=await fixture(t,{logger:{stream:{write:(chunk:string)=>{log+=chunk;}}},transactionWrapper:db=>({transaction:work=>db.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,v:readonly unknown[])=>{if(fail&&sql.startsWith('INSERT INTO loom.note_operations'))throw new Error('NOTE_LOG_CANARY body query title');return tx.query<Row>(sql,v);}}))})});
 const a=await f.artifact(),body=createNote([{kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id}],{title:'NOTE_LOG_CANARY title',body:'NOTE_LOG_CANARY body'});await accepted(f.admin,'create',body);const response=await f.admin.call(notes+'/query',{query:'NOTE_LOG_CANARY query'});assert.equal(response.headers['cache-control'],'private, no-store');await f.admin.call(notes+'/query',{query:'NOTE_LOG_CANARY query',extra:'NOTE_LOG_CANARY'});fail=true;assert.equal((await f.admin.call(notes+'/update',changeNote(body))).status,503);fail=false;
 for(const value of ['NOTE_LOG_CANARY',a.resource_id,a.revision_id,body.note_id])assert.ok(!log.includes(value));assert.ok(log.length>0,'Enabled real application logger observed fixture lifecycle');
});

test('held shared search, activity and Updates traversals exclude private canaries and keep their authorized meaning',{timeout:90000},async t=>{
 const f=await fixture(t),alice=await f.participant('note_observer'),bob=await f.participant('shared_observer');await f.follow(bob.client,f.settings('area',f.area,true));
 for(let i=0;i<4;i++)await f.artifact(f.admin,'Public lexical source '+i);const worker=new SearchWorker(f.database);await worker.tick();await f.drain();
 const search=(await bob.client.call('/api/v1/search?q=public&limit=1')).body;assert.ok(search.next_cursor);const searchPath='/api/v1/search?q=public&limit=1&cursor='+encodeURIComponent(search.next_cursor),searchBefore=(await bob.client.call(searchPath)).body;
 const activity=await f.changes(bob.client,{limit:1});assert.ok(activity.next_cursor);const activityBefore=await f.changes(bob.client,{cursor:activity.next_cursor,limit:1});
 const updates=await f.ready(bob.client,{selection:'complete',limit:1});assert.ok(updates.next_cursor);const updatesBefore=await f.ready(bob.client,{cursor:updates.next_cursor,limit:1});
 const before=await snapshot(f),body=createNote([],{title:'ISOLATEDNOTEUNIQUE',body:'ISOLATEDNOTEUNIQUE hidden lexical phrase @shared_observer'});await accepted(alice.client,'create',body);await accepted(alice.client,'update',changeNote(body));
 const cursorBody=createNote([],{title:'Second owner observation',body:'Distinct note'});await accepted(alice.client,'create',cursorBody);const privatePage=await queryNotes(alice.client,{query:'',limit:1});assert.ok(privatePage.next_cursor);
 for(const client of [bob.client,f.admin]){assert.equal((await client.call(notes+'/query',{query:'',cursor:privatePage.next_cursor})).body.error.code,'invalid_cursor');const shared=(await client.call('/api/v1/search?q=isolatednoteunique')).body;assert.deepEqual(shared.items,[]);assert.ok(!JSON.stringify(await f.ready(client,{selection:'complete'})).includes(body.note_id));}
 await accepted(alice.client,'delete',deleteNote(body.note_id,2));await accepted(alice.client,'delete',deleteNote(cursorBody.note_id));
 // Updates queries above deliberately create their own private view rows; note writes
 // still leave every shared table and all other private control populations unchanged.
 const after=await snapshot(f);for(const table of Object.keys(before))if(!['private_notes','note_owners','note_operations'].includes(table)&&!table.startsWith('updates_'))assert.deepEqual(after[table],before[table],table);
 const searchAfter=await bob.client.call(searchPath);assert.equal(searchAfter.status,200);assert.deepEqual(searchAfter.body.items,searchBefore.items);
 assert.deepEqual((await f.changes(bob.client,{cursor:activity.next_cursor,limit:1})).items,activityBefore.items);const updatesAfter=await f.ready(bob.client,{cursor:updates.next_cursor,limit:1});const visible=(items:typeof updatesAfter.items)=>items.map(({members_cursor,direct_cursor,...item})=>({...item,has_members:!!members_cursor,has_direct:!!direct_cursor}));assert.deepEqual(visible(updatesAfter.items),visible(updatesBefore.items));assert.deepEqual((await f.members(bob.client,{cursor:updatesAfter.items[0]!.members_cursor!,limit:12})).items,(await f.members(bob.client,{cursor:updatesBefore.items[0]!.members_cursor!,limit:12})).items);
});
