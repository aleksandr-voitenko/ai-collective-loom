import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture,mentioned } from '../helpers/notifications.js';

test('delivery and retained-job caps stop atomically without evicting identity',{timeout:90000},async t=>{
  const f=await fixture(t),a=await f.participant('capacity_attention');await f.drain();
  const source=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Capacity',content:mentioned(a.id),change_note:null,change_account:null});
  await f.database.transaction(tx=>tx.query('INSERT INTO loom.participant_delivery_clocks(participant_id,position) VALUES($1,50000)',[a.id]));
  await f.worker.discover();for(let i=0;i<3;i++){const claim=(await f.worker.claim())[0]!;assert.ok(claim);await f.worker.process(claim);await f.observer.query("UPDATE loom.notification_jobs SET due_at=clock_timestamp() WHERE state='pending'");}
  assert.deepEqual((await f.observer.query('SELECT failure,state FROM loom.notification_jobs WHERE revision_id=$1',[source.revision_id])).rows,[{failure:'delivery_limit',state:'failed'}]);
  for(const table of ['notification_signals','notification_claims','personal_deliveries'])assert.equal((await f.observer.query(`SELECT count(*)::int n FROM loom.${table}`)).rows[0].n,0);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.notification_projection_heads WHERE resource_id=$1',[source.resource_id])).rows[0].n,0);
  const event=(await f.observer.query('SELECT id FROM loom.shared_activity WHERE revision_id=$1',[source.revision_id])).rows[0].id;
  await f.database.transaction(tx=>tx.query("INSERT INTO loom.notification_jobs(source_event_id,kind) SELECT $1,'unsupported' FROM generate_series(1,50000)",[event]));
  const before=(await f.observer.query('SELECT count(*)::int n FROM loom.notification_jobs')).rows[0].n;
  assert.equal((await f.worker.discover()).limited,true);assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.notification_jobs')).rows[0].n,before);
  assert.equal((await f.admin.call('/api/v1/admin/notifications/health')).body.capacity_limited,true);
  assert.equal((await f.page(a.client)).projection.state,'incomplete');
});

test('source population is independently bounded while direct source reads remain available',{timeout:60000},async t=>{
  const f=await fixture(t);await f.drain();
  await f.database.transaction(tx=>tx.query(`WITH sources AS (INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id)
    SELECT gen_random_uuid(),'artifact',$1,$2 FROM generate_series(1,5001) RETURNING id) INSERT INTO loom.artifacts SELECT id FROM sources`,[f.area,f.administratorId]));
  assert.equal((await f.worker.discover()).limited,true);assert.equal((await f.page(f.admin)).projection.state,'unknown');
  assert.equal((await f.admin.call('/api/v1/areas/'+f.area)).status,200);
});
