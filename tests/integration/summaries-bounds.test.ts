import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { fixture } from '../helpers/summaries.js';
import { authored,plain,reference } from '../helpers/references.js';
import { SearchWorker } from '../../src/server/modules/search/worker.js';

test('pre-summary populated upgrade preserves text, declarations, Saved, placement, indexing and old retry bytes',{timeout:90000},async t=>{
  const f=await fixture(t,{throughMigration:9}),target=await f.artifact();
  const body={idempotency_key:randomUUID(),area_id:f.area,title:'Retained version two',content:authored('Preserved source',[reference({kind:'artifact',resource_id:target.resource_id,revision_id:target.revision_id})])};
  const source=await f.admin.call('/api/v1/artifacts',body);assert.equal(source.status,201);
  const old={...body,idempotency_key:randomUUID(),title:'Version one',content:plain('Unchanged bytes\r\n[[reference:inert]]')};
  const v1=await f.admin.call('/api/v1/artifacts',old);assert.equal(v1.status,201);
  assert.equal((await f.admin.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:{kind:'revision',resource_id:target.resource_id,revision_id:target.revision_id},saved:true,expected_version:0})).status,200);
  await f.move(target.resource_id,f.other);
  // Existing search documents are populated with the previous release's source
  // formats before adding the summary schema. No invented summary rows exist.
  const worker=new SearchWorker(f.database);await worker.tick();
  const tables=['resources','revisions','revision_mentions','revision_references','idempotency_records','resource_editors','shared_activity','outbox_intents','saved_items','saved_operations','saved_collections','organization_state','organization_operations','organization_audit','search_documents','search_jobs'];
  const snapshot=async()=>{const rows:Record<string,unknown>={};for(const table of tables)rows[table]=(await f.observer.query(`SELECT * FROM loom.${table} ORDER BY 1,2`)).rows;return rows;};
  const before=await snapshot();
  // Migration 0018 adds the initial lifecycle fence; every prior column is still compared.
  for(const row of before.resources as Record<string,unknown>[])Object.assign(row,{lifecycle_version:1});
  // Migration 0013 adds only an unknown impact marker to old events.
  for(const row of before.shared_activity as Record<string,unknown>[])Object.assign(row,{affected_target_ids:null});

  // Migration 0011 adds explicit empty note projections and main-field provenance; every old column remains compared.
  for(const row of before.search_documents as Record<string,unknown>[])Object.assign(row,{note_text:'',note_document:''});
  for(const row of before.revision_mentions as Record<string,unknown>[])Object.assign(row,{source_field:'main'});
  // Migration 0026 adds no inferred file target; every old reference value remains compared.
  for(const row of before.revision_references as Record<string,unknown>[])Object.assign(row,{source_field:'main',target_file_id:null,target_path:null});
await f.migrate();await f.migrate();assert.deepEqual(await snapshot(),before);
  for(const table of ['summaries','summary_preparations','summary_coverage_sets','summary_coverage_members'])assert.equal((await f.observer.query(`SELECT count(*)::int n FROM loom.${table}`)).rows[0].n,0);
  assert.equal((await f.admin.call('/api/v1/artifacts',body)).body.revision_id,source.body.revision_id);
  assert.equal((await f.admin.call('/api/v1/artifacts',old)).body.revision_id,v1.body.revision_id);
  assert.deepEqual((await f.admin.call(`/api/v1/resources/${v1.body.resource_id}`)).body.content,old.content);
  await worker.tick();assert.equal((await f.admin.call('/api/v1/search?q=Preserved')).status,200);
});

test('preparations enforce ownership, exact retry, irreversible expiry, quotas and independent published membership',{timeout:90000},async t=>{
  const f=await fixture(t),d=await f.discussion(),other=await f.participant('snapshot_other');
  const request={idempotency_key:randomUUID(),discussion_id:d.id,scope:'full'},first=await f.admin.call('/api/v1/summary-preparations',request);
  assert.equal(first.status,200);const p=first.body;
  await f.reply(d,'Later material');assert.deepEqual((await f.admin.call('/api/v1/summary-preparations',request)).body,p);
  assert.equal((await f.admin.call('/api/v1/summary-preparations',{...request,scope:'selected',members:[]})).body.error.code,'idempotency_conflict');
  assert.equal((await other.client.call('/api/v1/summary-preparations/'+p.preparation_id)).status,404);
  assert.equal((await other.client.call('/api/v1/summaries',f.createBody(d.id,p.preparation_id))).status,404);
  const published=await f.admin.call('/api/v1/summaries',f.createBody(d.id,p.preparation_id));assert.equal(published.status,201);
  const late=await f.prepare(d.id),update={idempotency_key:randomUUID(),resource_id:published.body.resource_id,expected_revision_id:published.body.revision_id,title:'Retained draft',content:authored('Still mine'),coverage:{preparation_id:late.preparation_id}};
  await f.observer.query("UPDATE loom.summary_preparations SET expires_at=clock_timestamp()-interval '1 second' WHERE participant_id=$1",[f.administratorId]);
  const expired=await f.admin.call('/api/v1/summary-revisions',update);assert.equal(expired.body.error.operation_outcome,'rejected');
  // Even a simulated backwards clock cannot resurrect the original request.
  await f.observer.query("UPDATE loom.summary_preparations SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",[late.preparation_id]);
  assert.equal((await f.admin.call('/api/v1/summary-revisions',update)).body.error.operation_outcome,'rejected');
  assert.equal((await f.admin.call('/api/v1/summary-preparations',request)).body.error.operation_outcome,'rejected');
  assert.equal((await f.admin.call('/api/v1/summary-preparations/cleanup',{})).status,200);
  assert.equal((await f.coverage(published.body)).body.coverage.uncovered_eligible,1);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.summary_coverage_members WHERE revision_id=$1',[published.body.revision_id])).rows[0].n,1);
  // The expired tombstone is excluded from the live quota, retained in its own cap.
  for(let i=0;i<8;i++)await f.prepare(d.id,other.client,[]);
  assert.equal((await other.client.call('/api/v1/summary-preparations',{idempotency_key:randomUUID(),discussion_id:d.id,scope:'full'})).body.error.code,'summary_preparation_limit');
  const corrected=await f.prepare(d.id);assert.equal((await f.admin.call('/api/v1/summary-revisions',{...update,idempotency_key:randomUUID(),coverage:{preparation_id:corrected.preparation_id}})).status,201);
});

test('large source populations and maintenance use bounded work, safe pages, opaque custody and explicit invalidation',{timeout:120000},async t=>{
  const measurements:{queries:number;maxRows:number;sourceRows:number}[]=[];let measure=false;
  const f=await fixture(t,{transactionWrapper:database=>({transaction:async work=>{
    const sample={queries:0,maxRows:0,sourceRows:0};const result=await database.transaction(tx=>work({query:async <Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{const r=await tx.query<Row>(sql,values);sample.queries++;sample.maxRows=Math.max(sample.maxRows,r.rows.length);if(sql.startsWith('SELECT c.id AS contribution_id'))sample.sourceRows=Math.max(sample.sourceRows,r.rows.length);return r;}}));if(measure)measurements.push(sample);return result;
  }})});
  const d=await f.discussion(),s=await f.create(d.id),members=[];
  for(let i=0;i<100;i++)members.push(await f.reply(d,'Bounded comment '+i));
  measure=true;const start=performance.now(),oversized=await f.admin.call('/api/v1/summary-preparations',{idempotency_key:randomUUID(),discussion_id:d.id,scope:'full'});
  assert.equal(oversized.body.error.code,'summary_source_limit');
  const partial=await f.prepare(d.id,f.admin,members.slice(0,25).map(m=>({contribution_id:m.resource_id,revision_id:m.revision_id})));
  const first=await f.admin.call('/api/v1/summary-preparations/'+partial.preparation_id+'/members?limit=1&max_response_bytes=4096');assert.equal(first.status,200);assert.ok(Buffer.byteLength(JSON.stringify(first.body))<=4096);assert.equal(first.body.items.length,1);assert.ok(first.body.next_cursor.length<=2048);
  const now=Date.now(),clock=t.mock.method(Date,'now',()=>now+301000);
  try{assert.equal((await f.admin.call('/api/v1/summary-preparations/'+partial.preparation_id+'/members?cursor='+first.body.next_cursor)).status,409);}finally{clock.mock.restore();}
  const view=(await f.coverage(s)).body.coverage;assert.deepEqual([view.uncovered_eligible,view.changed_eligible,view.unknown,view.comparison],[null,null,true,'work_limited']);
  const reader=await f.participant('bounded_reader');assert.equal((await reader.client.call('/api/v1/discussions/'+d.id+'/summary-sources?cursor='+first.body.next_cursor)).status,409);
  await f.reply(d,'Invalidate source view');assert.equal((await f.admin.call('/api/v1/summary-preparations/'+partial.preparation_id+'/members?cursor='+first.body.next_cursor)).body.error.code,'summary_changed');
  assert.equal((await f.admin.call('/api/v1/discussions/'+d.id+'/summary-sources?max_response_bytes=1024')).status,400);
  assert.ok(measurements.every(m=>m.sourceRows<=101&&m.maxRows<=3840));assert.ok(performance.now()-start<20000);
  measure=false;
  for(let i=0;i<11;i++){const next=await f.discussion();await f.create(next.id,f.admin);await f.admin.call('/api/v1/summary-preparations/cleanup',{});
    // Fixture-only expiry frees active capacity without modifying published sets.
    await f.observer.query("UPDATE loom.summary_preparations SET expires_at=clock_timestamp()-interval '1 second' WHERE participant_id=$1",[f.administratorId]);}
  measure=true;const maintenance=await f.admin.call('/api/v1/summaries/maintenance?limit=2&max_response_bytes=8192');assert.equal(maintenance.status,200);assert.equal(maintenance.body.items.length,2);assert.ok(maintenance.body.next_cursor);assert.ok(Buffer.byteLength(JSON.stringify(maintenance.body))<=8192);
  const baseline=measurements.at(-1)!;assert.ok(baseline.queries<15000);assert.ok(baseline.sourceRows<=101&&baseline.maxRows<=3840);
  const inTopic=await f.admin.call('/api/v1/summaries/maintenance?topic='+f.area+'&descendants=true');assert.equal(inTopic.status,200);assert.ok(inTopic.body.items.every((i:any)=>i.summary.area_id===f.area));
  const outside=await f.admin.call('/api/v1/summaries/maintenance?topic='+f.other);assert.equal(outside.status,200);assert.deepEqual(outside.body.items,[]);assert.equal(outside.body.complete,false);assert.ok(outside.body.next_cursor);
  const changed=await f.admin.call('/api/v1/summaries/maintenance?filter=partial&cursor='+maintenance.body.next_cursor);assert.equal(changed.status,409);
  await f.admin.call('/api/v1/summaries/editors',{idempotency_key:randomUUID(),resource_id:s.resource_id,expected_version:0,participant_ids:[]});
  assert.equal((await f.admin.call('/api/v1/summaries/maintenance?cursor='+maintenance.body.next_cursor)).status,409);
  let cursor:string|undefined,found=false;
  do {const page=await f.admin.call('/api/v1/summaries/maintenance?filter=no_active_editor&editable=true'+(cursor?'&cursor='+cursor:''));assert.equal(page.status,200);found ||= page.body.items.some((i:any)=>i.summary.resource_id===s.resource_id&&i.no_active_editor);cursor=page.body.next_cursor??undefined;}while(cursor);
  assert.ok(found,'Administrator authority does not invent an active explicit editor');
  t.diagnostic(JSON.stringify({source_limit:100,maintenance_candidates:10,observed_queries:baseline.queries,max_rows:baseline.maxRows,source_response_bytes:Buffer.byteLength(JSON.stringify(first.body)),maintenance_bytes:Buffer.byteLength(JSON.stringify(maintenance.body))}));
});
