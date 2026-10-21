import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture,mentioned,fields } from '../helpers/notifications.js';
import { SearchWorker } from '../../src/server/modules/search/worker.js';

test('populated v1/v2/v3 upgrade preserves bytes, digests, old uncertain retries and independent search',{timeout:90000},async t=>{
  const f=await fixture(t,{throughMigration:11}),a=await f.participant('upgrade_attention'),b=await f.participant('upgrade_publisher');
  let oldBody:Record<string,unknown>={},oldResult:Record<string,unknown>={};
  const expected:string[]=[];
  for(const format of ['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3'] as const){
    const body={idempotency_key:randomUUID(),area_id:f.area,title:format,content:mentioned(a.id,format),...fields(mentioned(a.id,format))};
    const first=await f.publish(b.client,'/api/v1/artifacts',body);expected.push(first.revision_id);
    if(format==='loom-markdown-v1'){
      // Persist the exact pre-upgrade uncertain request and outcome for retry below.
      oldBody=body;oldResult=first;
    }
    await f.publish(b.client,'/api/v1/revisions',{resource_id:first.resource_id,expected_revision_id:first.revision_id,title:format,content:mentioned(a.id,format),...fields(mentioned(a.id,format))});
  }
  const d=await f.discussion(a.client);
  const unknown=await f.reply(d,'Historical unmentioned reply',b.client);
  const known=await f.publish(b.client,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:mentioned(a.id,'loom-markdown-v1')});expected.push(known.revision_id);
  const preparation=await f.prepare(d.id,b.client);
  const summary=await f.publish(b.client,'/api/v1/summaries',{discussion_id:d.id,title:'Historical summary',content:mentioned(a.id),change_note:{format:'loom-markdown-v2',text:'[[mention:n]]',mentions:[{token:'n',participant_id:a.id}],references:[]},change_account:null,coverage:{preparation_id:preparation.preparation_id}});expected.push(summary.revision_id);
  await new SearchWorker(f.database).tick();
  const tables=['resources','revisions','revision_mentions','revision_change_notes','revision_references','shared_activity','outbox_intents','idempotency_records','search_jobs','search_documents','search_state'];
  const snapshot=async()=>{const out:Record<string,unknown>={};for(const name of tables)out[name]=(await f.observer.query(`SELECT * FROM loom.${name} ORDER BY 1`)).rows;return out;};
  const before=await snapshot();
  // Migration 0018 adds the initial lifecycle fence; every prior column is still compared.
  for(const row of before.resources as Record<string,unknown>[])Object.assign(row,{lifecycle_version:1});
  // Migration 0013 adds only an unknown impact marker to old events.
  for(const row of before.shared_activity as Record<string,unknown>[])Object.assign(row,{affected_target_ids:null});
await f.migrate();await f.migrate();assert.deepEqual(await snapshot(),before);
  await f.worker.discover();
  const current=await f.publish(b.client,'/api/v1/artifacts',{area_id:f.area,title:'During backfill',content:mentioned(a.id),change_note:null,change_account:null});expected.push(current.revision_id);
  await f.drain();const page=await f.page(a.client);assert.deepEqual(page.items.map(i=>i.source.revision_id).sort(),expected.sort());
  assert.equal(page.projection.state,'incomplete');
  assert.deepEqual(page.items.find(i=>i.source.revision_id===known.revision_id)!.reasons.map(r=>r.kind),['direct_reply','main_mention']);
  assert.deepEqual(page.items.find(i=>i.source.revision_id===summary.revision_id)!.reasons.map(r=>r.kind),['main_mention','note_mention']);
  const failures=await f.admin.call('/api/v1/admin/notifications/failures');assert.ok(failures.body.items.some((i:any)=>i.revision_id===unknown.revision_id&&i.failure==='historical_reply_eligibility_unknown'));
  assert.equal((await a.client.call('/api/v1/admin/notifications/health')).status,403);
  assert.deepEqual((await b.client.call('/api/v1/artifacts',oldBody)).body,{...oldResult,idempotency:'replayed',publication_state:'committed'});
  for(const name of ['search_jobs','search_documents','search_state'])assert.deepEqual((await f.observer.query(`SELECT * FROM loom.${name} ORDER BY 1`)).rows,before[name]);
  const deliveries=(await f.observer.query('SELECT * FROM loom.personal_deliveries ORDER BY id')).rows;
  await f.admin.call('/api/v1/admin/notifications/reconcile',{expected_generation:1});await f.admin.call('/api/v1/admin/notifications/reconcile',{expected_generation:1});await f.drain();
  assert.deepEqual((await f.observer.query('SELECT * FROM loom.personal_deliveries ORDER BY id')).rows,deliveries);
});

test('missing predecessors, malformed sources and split-position intents retain explicit repair work',{timeout:90000},async t=>{
  const f=await fixture(t),a=await f.participant('repair_attention');await f.drain();
  const missing=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Missing predecessor',content:mentioned(a.id),change_note:null,change_account:null});
  // Private retained-data damage: application role cannot rewrite revision ordinals.
  await f.observer.query('UPDATE loom.revisions SET revision_number=2 WHERE id=$1',[missing.revision_id]);
  const malformed=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Malformed source',content:mentioned(a.id),change_note:null,change_account:null});
  await f.observer.query("UPDATE loom.revisions SET content_text='Broken [[mention:not_declared]]' WHERE id=$1",[malformed.revision_id]);
  // Cross the discovery page boundary with two distinct intents at one position.
  for(let i=0;i<49;i++)await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Intent '+i,content:mentioned(a.id),change_note:null,change_account:null});
  const last=(await f.observer.query('SELECT id,position FROM loom.shared_activity ORDER BY position DESC LIMIT 1')).rows[0];
  await f.database.transaction(tx=>tx.query("INSERT INTO loom.outbox_intents(id,source_event_id,kind) VALUES($1,$2,'organization.project')",['00000000-0000-0000-0000-000000000000',last.id]));
  for(let i=0;i<8;i++){await f.worker.tick();await f.observer.query("UPDATE loom.notification_jobs SET due_at=clock_timestamp() WHERE state='pending'");}
  const failures=(await f.admin.call('/api/v1/admin/notifications/failures')).body.items;
  assert.ok(failures.some((r:any)=>r.revision_id===missing.revision_id&&r.failure==='missing_predecessor'));
  assert.ok(failures.some((r:any)=>r.revision_id===malformed.revision_id&&r.failure==='malformed_source'));
  assert.ok(failures.some((r:any)=>r.failure==='unsupported_event'&&r.attempts===3));
  assert.equal((await f.observer.query('SELECT revision_number::int FROM loom.notification_projection_heads WHERE resource_id=$1',[missing.resource_id])).rows[0].revision_number,0);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.personal_deliveries')).rows[0].n,49);
  const health=(await f.admin.call('/api/v1/admin/notifications/health')).body;assert.equal(health.event_discovery_caught_up,true);assert.equal(health.jobs.failed,3);
});
