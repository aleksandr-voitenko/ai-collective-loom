import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { QueryResultRow } from 'pg';
import { fixture,mentioned } from '../helpers/notifications.js';
import { NotificationWorker } from '../../src/server/modules/notifications/worker.js';
import type { Transactions } from '../../src/server/db/postgres.js';

test('ordered discovery, all-stage rollback, delayed availability and fixed upper bounds',{timeout:90000},async t=>{
  const f=await fixture(t),a=await f.participant('ordered_a'),b=await f.participant('ordered_b');await f.drain();
  const make=(title:string,notify=true)=>f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title,content:notify?mentioned(a.id):{format:'loom-markdown-v3',text:'No mention yet',mentions:[],references:[]},change_note:null,change_account:null});
  const original=await make('First'),next=await f.publish(f.admin,'/api/v1/revisions',{resource_id:original.resource_id,expected_revision_id:original.revision_id,title:'Second',content:mentioned(a.id),change_note:null,change_account:null});
  // Encounter R2 alone first. Retained R1 prevents a first-trigger shortcut.
  await f.database.transaction(tx=>tx.query("INSERT INTO loom.notification_jobs(resource_id,revision_id,revision_number,kind) VALUES($1,$2,2,'revision')",[next.resource_id,next.revision_id]));
  assert.deepEqual(await f.worker.claim(),[]);await f.worker.discover();
  const old=(await f.worker.claim())[0]!;assert.equal(old.revision_id,original.revision_id);
  const prepared=await f.worker.prepare(old);
  const snapshot=async()=>{const out:Record<string,unknown>={};for(const table of ['notification_claims','notification_signals','personal_deliveries','participant_delivery_clocks','notification_projection_heads','notification_jobs'])out[table]=(await f.observer.query(`SELECT * FROM loom.${table} ORDER BY 1`)).rows;return out;};
  const before=await snapshot();
  for(const stage of ['INSERT INTO loom.notification_claims','INSERT INTO loom.notification_signals','INSERT INTO loom.personal_deliveries','UPDATE loom.notification_projection_heads',"state='succeeded'"]){
    const fault:Transactions={transaction:work=>f.database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
      const result=await tx.query<Row>(sql,values);if(sql.includes(stage))throw new Error('Private rollback barrier');return result;
    }}))};
    await assert.rejects(new NotificationWorker(fault).finalize(old,prepared));assert.deepEqual(await snapshot(),before);
  }
  await f.worker.finalize(old,prepared);await f.drain();const first=await f.page(a.client);assert.equal(first.items[0]!.source.revision_id,original.revision_id);
  const empty=await make('Empty predecessor',false);await f.publish(f.admin,'/api/v1/revisions',{resource_id:empty.resource_id,expected_revision_id:empty.revision_id,title:'Now mentions',content:mentioned(a.id),change_note:null,change_account:null});await f.drain();
  assert.equal((await f.observer.query('SELECT revision_number::int FROM loom.notification_projection_heads WHERE resource_id=$1',[empty.resource_id])).rows[0].revision_number,2);
  const held=await make('Delayed original');await f.worker.discover();const claim=(await f.worker.claim())[0]!,p=await f.worker.prepare(claim);assert.equal(claim.resource_id,held.resource_id);
  // Known failed work remains pending explicit administrator repair while other sources advance.
  await f.observer.query("UPDATE loom.notification_jobs SET state='failed',failure='processing_failed',owner=NULL,lease_until=NULL WHERE id=$1",[claim.id]);
  const available=await make('Available first');await f.drain();const completed=await f.page(a.client,{checkpoint:first.checkpoint!});assert.ok(completed.items.some(i=>i.source.resource_id===available.resource_id));
  const fixed=await f.page(a.client,{limit:1});assert.ok(fixed.next_cursor);
  const retry=await f.admin.call('/api/v1/admin/notifications/retry',{id:claim.id,claim_generation:claim.claim_generation});assert.equal(retry.status,200);
  assert.equal((await f.admin.call('/api/v1/admin/notifications/retry',{id:claim.id,claim_generation:claim.claim_generation})).status,200);
  await f.drain();assert.equal(await f.worker.finalize(claim,p),false);
  const repaired=await f.page(a.client,{checkpoint:completed.checkpoint!});assert.deepEqual(repaired.items.map(i=>i.source.resource_id),[held.resource_id]);
  assert.equal(repaired.items[0]!.source.revision_id,held.revision_id);
  assert.equal(repaired.items[0]!.source.created_at,(await f.observer.query('SELECT created_at FROM loom.revisions WHERE id=$1',[held.revision_id])).rows[0].created_at.toISOString());
  let cursor:string|null=fixed.next_cursor;const fixedIds=fixed.items.map(i=>i.source.resource_id);let checkpoint:string|null=null;
  while(cursor){const page=await f.page(a.client,{cursor});fixedIds.push(...page.items.map(i=>i.source.resource_id));cursor=page.next_cursor;checkpoint=page.checkpoint;}
  assert.ok(!fixedIds.includes(held.resource_id));assert.deepEqual((await f.page(a.client,{checkpoint:checkpoint!})).items.map(i=>i.source.resource_id),[held.resource_id]);
  // Two sources lock two recipients in the same order despite opposite entity order.
  for(const ids of [[a.id,b.id],[b.id,a.id]])await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Concurrent recipients',content:{format:'loom-markdown-v1',text:'[[mention:a]] [[mention:b]]',mentions:ids.map((id,i)=>({token:i?'b':'a',participant_id:id}))}});
  await f.worker.discover();const one=new NotificationWorker(f.database),two=new NotificationWorker(f.database),[c1,c2]=await Promise.all([one.claim(1),two.claim(1)]);
  assert.notEqual(c1[0]!.id,c2[0]!.id);await Promise.all([one.process(c1[0]!),two.process(c2[0]!)]);
  const bRows=(await f.observer.query('SELECT position::int FROM loom.personal_deliveries WHERE recipient_id=$1 ORDER BY position',[b.id])).rows;
  assert.deepEqual(bRows,[{position:1},{position:2}]);
});

test('native lease deadline, takeover, process death before and after atomic COMMIT',{timeout:120000},async t=>{
  const f=await fixture(t),a=await f.participant('native_attention');await f.drain();
  const make=async()=>{const s=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Native source',content:mentioned(a.id),change_note:null,change_account:null});await f.worker.discover();return s;};
  async function child(phase:string){
    const c=f.configuration,child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../fixtures/notifications-worker.ts',import.meta.url)),phase],{env:{...process.env,LOOM_DATABASE_HOST:c.host,LOOM_POSTGRES_PORT:String(c.port),LOOM_DATABASE_NAME:c.database,LOOM_DATABASE_USER:c.user,LOOM_PG_APP_PASSWORD:c.password},stdio:['ignore','ignore','ignore','ipc']});
    const messages:any[]=[];const waiters=new Set<()=>void>();child.on('message',m=>{messages.push(m);for(const wake of waiters)wake();});
    const exit=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;});
    const stage=(name:string)=>new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(check);reject(new Error('Notification native barrier deadline'));},10000);const check=()=>{const m=messages.find(m=>m.stage===name);if(m){clearTimeout(timer);waiters.delete(check);resolve(m);}};waiters.add(check);check();});
    return {child,stage,kill:async()=>{child.kill('SIGKILL');await exit;}};
  }
  await make();const old=await child('prepared'),held=(await old.stage('prepared')).claim;assert.deepEqual(await f.worker.claim(),[]);
  await f.observer.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM lease_until-clock_timestamp()))) FROM loom.notification_jobs WHERE id=$1',[held.id]);
  const replacement=(await f.worker.claim())[0]!;assert.equal(replacement.claim_generation,held.claim_generation+1);
  await f.worker.finalize(replacement,await f.worker.prepare(replacement));const before=(await f.observer.query('SELECT * FROM loom.personal_deliveries')).rows;
  old.child.send('resume');assert.equal((await old.stage('after_commit')).accepted,false);await old.kill();assert.deepEqual((await f.observer.query('SELECT * FROM loom.personal_deliveries')).rows,before);
  const source=await make(),uncommitted=await child('before_commit'),claim=(await uncommitted.stage('prepared')).claim;await uncommitted.stage('before_commit');
  assert.deepEqual((await f.observer.query('SELECT * FROM loom.personal_deliveries')).rows,before);await uncommitted.kill();
  await f.database.transaction(tx=>tx.query('SELECT id FROM loom.resources WHERE id=$1 FOR UPDATE',[source.resource_id]));
  assert.deepEqual((await f.observer.query('SELECT * FROM loom.personal_deliveries')).rows,before);
  await f.observer.query("UPDATE loom.notification_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[claim.id]);
  const committed=await child('after_commit');assert.equal((await committed.stage('after_commit')).accepted,true);await committed.kill();await f.drain();
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.personal_deliveries')).rows[0].n,2);
  assert.equal((await f.observer.query('SELECT state FROM loom.notification_jobs WHERE id=$1',[claim.id])).rows[0].state,'succeeded');
});
