import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { readFile } from 'node:fs/promises';
import { fixture,authored,reference,incoming,outgoing,plain } from '../helpers/references.js';
import { SearchWorker } from '../../src/server/modules/search/worker.js';
import { createApplication } from '../../src/server/http/app.js';
import { barrier,bounded,blockedBy } from '../helpers/search-races.js';

test('populated pre-reference upgrade preserves old requests, mention bytes, Saved, organization, proposals and search',{timeout:90000},async t=>{
  let lose='';const f=await fixture(t,{throughMigration:8,transactionWrapper:database=>({transaction:async work=>{
    let key='';const result=await database.transaction(tx=>work({query:async <Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
      const result=await tx.query<Row>(sql,values);if(sql.startsWith('INSERT INTO loom.idempotency_records'))key=String(values[3]);return result;
    }}));if(key&&key===lose){lose='';throw new Error('Pre-upgrade acknowledgement loss');}return result;
  }})});
  const person=await f.participant('upgrade_author'),target=await f.artifact(f.admin,'Preserved target');
  const input={idempotency_key:randomUUID(),area_id:f.area,title:'Upgrade source',content:{...plain(`Oldneedle [[mention:m1]] https://loom.test/${target.resource_id} [[reference:inert]]`),mentions:[{token:'m1',participant_id:person.id}]}};
  lose=input.idempotency_key;assert.equal((await f.admin.call('/api/v1/artifacts',input)).status,503);
  const original=(await f.observer.query('SELECT * FROM loom.idempotency_records WHERE idempotency_key=$1',[input.idempotency_key])).rows[0];
  const saved=await f.admin.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:{kind:'revision',resource_id:target.resource_id,revision_id:target.revision_id},saved:true,expected_version:0});assert.equal(saved.status,200);
  await f.move(target.resource_id,f.other);
  const settings=(await f.admin.call('/api/v1/community')).body;
  const proposalInput={idempotency_key:randomUUID(),area_id:f.other,title:'Preserved suggestion',content:plain('Proposal body'),proposal_context:{affected_area_id:f.area,expected_settings_version:settings.settings_version}};
  const proposal=await f.admin.call('/api/v1/discussions',proposalInput);assert.equal(proposal.status,201);
  const worker=new SearchWorker(f.database);await worker.tick();
  const tables=['resources','revisions','revision_mentions','idempotency_records','shared_activity','outbox_intents','saved_items','saved_operations','saved_collections','organization_state','organization_operations','organization_audit','area_metadata_revisions','discussion_area_references','search_documents','search_jobs'];
  const snapshot=async()=>{const result:Record<string,unknown>={};for(const table of tables)result[table]=(await f.observer.query(`SELECT * FROM loom.${table} ORDER BY 1,2`)).rows;return result;};
  const before=await snapshot();
  // Migration 0013 adds only an unknown impact marker to old events.
  for(const row of before.shared_activity as Record<string,unknown>[])Object.assign(row,{affected_target_ids:null});

  // Migration 0011 adds explicit empty note projections and main-field provenance; every old column remains compared.
  for(const row of before.search_documents as Record<string,unknown>[])Object.assign(row,{note_text:'',note_document:''});
  for(const row of before.revision_mentions as Record<string,unknown>[])Object.assign(row,{source_field:'main'});
await f.migrate();await f.migrate();assert.deepEqual(await snapshot(),before);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.revision_references')).rows[0].n,0);
  const replay=await f.admin.call('/api/v1/artifacts',input);assert.equal(replay.status,201);assert.equal(replay.body.revision_id,original.revision_id);assert.equal(replay.body.operation_id,original.id);
  assert.deepEqual((await f.observer.query('SELECT * FROM loom.idempotency_records WHERE idempotency_key=$1',[input.idempotency_key])).rows[0],original);
  const retained=await f.admin.call(`/api/v1/resources/${original.resource_id}/revisions/${original.revision_id}`);assert.deepEqual(retained.body.content,input.content);
  assert.deepEqual((await f.admin.call(outgoing(replay.body))).body.items,[]);
  assert.equal((await f.admin.call('/api/v1/search?q=oldneedle')).body.items[0].source_resource_id,original.resource_id);
  assert.equal((await f.admin.call('/api/v1/discussions',proposalInput)).body.revision_id,proposal.body.revision_id);
  const discussion=(await f.admin.call('/api/v1/resources/'+proposal.body.resource_id)).body;
  assert.equal(discussion.affected_area_id,f.area);
  const newer=await f.revise(f.admin,replay.body,'Explicit new reference',[reference({kind:'artifact',resource_id:target.resource_id})]);
  assert.equal((await f.admin.call(outgoing(newer))).body.items.length,1);
});

test('bounded scans, stable ordering, filters and caller/scope/history-bound continuation disclose no hidden population',{timeout:90000},async t=>{
  const f=await fixture(t),target=await f.artifact(f.admin,'Paged target'),refTarget={kind:'artifact' as const,resource_id:target.resource_id};
  const sources=[];for(let i=0;i<105;i++)sources.push(await f.artifact(f.admin,'Page source '+i,[reference(refTarget,i%2?'related_to':null)]));
  const sorted=(await f.observer.query('SELECT source_id,revision_id FROM loom.revision_references ORDER BY revision_id,reference_id')).rows;
  const hidden=sorted.slice(0,100).map(r=>r.source_id);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=ANY($1::uuid[])",[hidden]));
  const empty=await f.admin.call(incoming(refTarget,{max_response_bytes:'4096'}));assert.equal(empty.status,200);assert.deepEqual(empty.body.items,[]);assert.equal(empty.body.complete,false);assert.equal(empty.body.work_budget_reached,true);assert.ok(empty.body.next_cursor);assert.ok(empty.bytes<=4096);
  for(const id of hidden)assert.ok(!JSON.stringify(empty.body).includes(id));assert.equal(empty.body.count,undefined);assert.equal(empty.body.total,undefined);
  const next=await f.admin.call(incoming(refTarget,{cursor:empty.body.next_cursor,limit:'25'}));assert.equal(next.status,200);assert.equal(next.body.items.length,5);assert.equal(next.body.complete,true);
  assert.deepEqual(next.body.items.map((r:any)=>r.source.revision_id),sorted.slice(100).map(r=>r.revision_id));
  const other=await f.participant('cursor_other');
  for(const options of [{history:'all'},{relationship:'related_to'},{revision_id:target.revision_id},{resource_id:sources[0]!.resource_id}]){
    const result=await f.admin.call(incoming(refTarget,{cursor:empty.body.next_cursor,...options}));assert.equal(result.status,409);assert.equal(result.body.error.code,'references_changed');
  }
  assert.equal((await other.client.call(incoming(refTarget,{cursor:empty.body.next_cursor}))).status,409);
  const filtered=await f.admin.call(incoming(refTarget,{relationship:'related_to'}));assert.equal(filtered.status,200);
  const rest=await f.admin.call(incoming(refTarget,{relationship:'related_to',cursor:filtered.body.next_cursor}));assert.ok(rest.body.items.every((r:any)=>r.declaration.relationship==='related_to'));
  const noLimit=await f.admin.call(incoming(refTarget,{limit:'26'}));assert.equal(noLimit.status,400);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[hidden[0]]));
  assert.equal((await f.admin.call(incoming(refTarget,{cursor:empty.body.next_cursor}))).status,409);
  const newPage=await f.admin.call(incoming(refTarget,{limit:'1'}));assert.equal(newPage.status,200);assert.equal(newPage.body.items.length,1);
  await f.move(target.resource_id,f.other);
  assert.equal((await f.admin.call(incoming(refTarget,{cursor:newPage.body.next_cursor}))).status,409);
});

test('source and target revisions invalidate current and historical pages; expiry and API restart require refresh',{timeout:60000},async t=>{
  const f=await fixture(t),target=await f.artifact(),refTarget={kind:'artifact' as const,resource_id:target.resource_id};
  const a=await f.artifact(f.admin,'A',[reference(refTarget)]);await f.artifact(f.admin,'B',[reference(refTarget)]);
  for(const history of ['current','all']){
    const page=await f.admin.call(incoming(refTarget,{history,limit:'1'}));assert.ok(page.body.next_cursor);
    const source=(await f.admin.call('/api/v1/resources/'+a.resource_id)).body;
    await f.revise(f.admin,source,'A revised',source.content.references);
    assert.equal((await f.admin.call(incoming(refTarget,{history,limit:'1',cursor:page.body.next_cursor}))).status,409);
  }
  const beforeTarget=await f.admin.call(incoming(refTarget,{limit:'1'}));await f.revise(f.admin,target,'Target R2',[]);
  assert.equal((await f.admin.call(incoming(refTarget,{cursor:beforeTarget.body.next_cursor}))).status,409);
  const page=await f.admin.call(incoming(refTarget,{limit:'1'})),now=Date.now();
  const mock=t.mock.method(Date,'now',()=>now+301000);
  assert.equal((await f.admin.call(incoming(refTarget,{cursor:page.body.next_cursor}))).status,409);mock.mock.restore();
  await f.app.close();
  const app=await createApplication({database:{isReady:()=>f.database.isReady(),close:async()=>{}},logger:false,
    tls:{key:await readFile(f.directory+'/key.pem','utf8'),cert:await readFile(f.directory+'/cert.pem','utf8')},
    participation:{database:f.database,authentication:f.authentication,administration:f.administration}});
  t.after(()=>app.close());await app.listen({host:'127.0.0.1',port:Number(new URL(f.origin).port)});
  assert.equal((await f.admin.call(incoming(refTarget,{cursor:page.body.next_cursor}))).status,409);
  assert.equal((await f.admin.call(incoming(refTarget))).body.items.length,2);
});

test('reference snapshots serialize suppression, restoration, source edits and moves at deterministic barriers',{timeout:120000},async t=>{
  type Gate={match:(sql:string,values:readonly unknown[])=>boolean;phase:'before'|'after';entered:ReturnType<typeof barrier<number>>;release:ReturnType<typeof barrier<void>>};
  let gate:Gate|undefined;
  const pause=(match:Gate['match'],phase:Gate['phase'])=>{const next={match,phase,entered:barrier<number>(),release:barrier()};gate=next;return next;};
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async <Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const selected=gate?.match(sql,values)?gate:undefined;if(selected)gate=undefined;
    const wait=async()=>{selected!.entered.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await bounded(selected!.release.promise);};
    if(selected?.phase==='before')await wait();const result=await tx.query<Row>(sql,values);if(selected?.phase==='after')await wait();return result;
  }}))})});
  const target=await f.artifact(f.admin,'Target metadata'),ref=reference({kind:'artifact',resource_id:target.resource_id}),source=await f.artifact(f.admin,'Source metadata',[ref]);
  const reader=await f.participant('race_reference_reader');
  for(const [table,id,column,normal] of [['resources',source.resource_id,'state','active'],['revisions',source.revision_id,'availability','available'],['resources',target.resource_id,'state','active'],['revisions',target.revision_id,'availability','available'],['resources',f.area,'state','active']] as const){
    const matches=(sql:string,values:readonly unknown[])=>table==='revisions'?sql.startsWith('SELECT id FROM loom.revisions WHERE resource_id = $1')&&values[1]===id
      :sql==='SELECT id FROM loom.resources WHERE id=$1 FOR SHARE'&&values[0]===id;
    await t.test(table+' suppression before guard '+column,async()=>{
      const held=pause(matches,'before'),pending=reader.client.call(incoming(ref.target));
      try{await bounded(held.entered.promise);await f.database.transaction(tx=>tx.query(`UPDATE loom.${table} SET ${column}='suppressed' WHERE id=$1`,[id]));}finally{held.release.release();}
      const result=await pending;assert.ok([404,409].includes(result.status),JSON.stringify(result.body));assert.equal(result.body.items,undefined);
      await f.database.transaction(tx=>tx.query(`UPDATE loom.${table} SET ${column}=$2 WHERE id=$1`,[id,normal]));
    });
    await t.test(table+' suppression after guard '+column,async()=>{
      const held=pause(matches,'after'),pending=reader.client.call(incoming(ref.target));const pid=await bounded(held.entered.promise),writer=barrier<number>();
      const mutation=f.database.transaction(async tx=>{writer.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await tx.query(`UPDATE loom.${table} SET ${column}='suppressed' WHERE id=$1`,[id]);});
      try{await blockedBy(f.observer,await bounded(writer.promise),pid);}finally{held.release.release();}
      const result=await pending;assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.items[0].source.revision_id,source.revision_id);await mutation;
      const later=await reader.client.call(incoming(ref.target));if(later.status===200)assert.deepEqual(later.body.items,[]);else assert.equal(later.status,404);
      await f.database.transaction(tx=>tx.query(`UPDATE loom.${table} SET ${column}=$2 WHERE id=$1`,[id,normal]));
    });
  }
  const held=pause(sql=>sql.startsWith('SELECT rr.* FROM loom.revision_references rr'),'after'),pending=reader.client.call(incoming(ref.target));
  try{await bounded(held.entered.promise);await f.revise(f.admin,source,'Changed while reading',[]);}finally{held.release.release();}
  const changed=await pending;assert.equal(changed.status,409);assert.equal(changed.body.error.code,'references_changed');
  const moved=pause(sql=>sql.startsWith('SELECT rr.* FROM loom.revision_references rr'),'after'),moving=reader.client.call(incoming(ref.target,{history:'all'}));
  try{await bounded(moved.entered.promise);await f.move(source.resource_id,f.other);}finally{moved.release.release();}
  assert.equal((await moving).status,409);
  const restored=pause(sql=>sql.startsWith('SELECT rr.* FROM loom.revision_references rr'),'after');
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[source.resource_id]));
  const restoring=reader.client.call(incoming(ref.target,{history:'all'}));
  try{await bounded(restored.entered.promise);await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[source.resource_id]));}finally{restored.release.release();}
  assert.equal((await restoring).status,409);
});

test('credential revocation and publication target suppression order safely under current guards',{timeout:90000},async t=>{
  let gate:{match:(sql:string,values:readonly unknown[])=>boolean;entered:ReturnType<typeof barrier<number>>;release:ReturnType<typeof barrier<void>>}|undefined;
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async <Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const result=await tx.query<Row>(sql,values);if(gate?.match(sql,values)){const selected=gate;gate=undefined;selected.entered.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await bounded(selected.release.promise);}return result;
  }}))})});
  const target=await f.artifact(),ref=reference({kind:'artifact',resource_id:target.resource_id});await f.artifact(f.admin,'Readable source',[ref]);
  for(const after of [false,true]){
    const reader=await f.participant('revoke_reference_'+after),held={match:(sql:string)=>after?sql.startsWith('SELECT rr.* FROM loom.revision_references rr'):sql==="SET LOCAL statement_timeout='2500ms'",entered:barrier<number>(),release:barrier()};gate=held;
    const pending=reader.client.call(incoming(ref.target));const pid=await bounded(held.entered.promise);
    let revoke:ReturnType<typeof f.admin.call>;
    if(after){
      const watch=barrier<number>();
      const writerHeld={match:(sql:string)=>sql==='SELECT pg_advisory_xact_lock($1::integer, $2::integer)',entered:watch,release:barrier()};gate=writerHeld;
      // The administration transaction's actor/target locks wait for the read's
      // participant guard. Observe that wait with the actual database backend.
      revoke=f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:reader.id,credential_id:reader.credential});
      const writer=await bounded(watch.promise);writerHeld.release.release();gate=undefined;
      try{await blockedBy(f.observer,writer,pid);}finally{held.release.release();}
    }else{
      revoke=f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:reader.id,credential_id:reader.credential});
      await revoke;held.release.release();
    }
    const result=await pending;assert.ok(after?result.status===200:[401,404,409].includes(result.status));assert.equal((await revoke).status,200);
    assert.equal((await reader.client.call(incoming(ref.target))).status,401);
  }
  const held={match:(sql:string,values:readonly unknown[])=>sql==='SELECT id FROM loom.resources WHERE id=$1 FOR SHARE'&&values[0]===target.resource_id,entered:barrier<number>(),release:barrier()};gate=held;
  const publication=f.artifact(f.admin,'Publication wins',[reference(ref.target)]);const pid=await bounded(held.entered.promise),writer=barrier<number>();
  const suppress=f.database.transaction(async tx=>{writer.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[target.resource_id]);});
  try{await blockedBy(f.observer,await bounded(writer.promise),pid);}finally{held.release.release();}
  const published=await publication;await suppress;
  assert.equal((await f.admin.call('/api/v1/resources/'+published.resource_id)).status,200);
  assert.deepEqual((await f.admin.call(outgoing(published))).body.items[0].target,{state:'unavailable'});
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[target.resource_id]));
  const before={match:(sql:string)=>sql==='SELECT opening_id FROM loom.discussions WHERE id=ANY($1::uuid[])',entered:barrier<number>(),release:barrier()};gate=before;
  const pending=f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Suppression wins',content:authored('New',[reference(ref.target)])});
  try {await bounded(before.entered.promise);await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[target.resource_id]));}
  finally {before.release.release();}
  const refusal=await pending;assert.equal(refusal.status,404);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.revisions WHERE title=$1',['Suppression wins'])).rows[0].n,0);
});
