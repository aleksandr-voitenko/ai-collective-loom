import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { isolatedPublicationPostgres } from '../helpers/publication-postgres.js';
import { SearchWorker } from '../../src/server/modules/search/worker.js';
import { ParticipationPublications } from '../../src/server/modules/participation/publications.js';
import { TextSearch } from '../../src/server/modules/search/search.js';
import type { Transactions } from '../../src/server/db/postgres.js';
import type { QueryResultRow } from 'pg';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const content=(text:string)=>({format:'loom-markdown-v1',text,mentions:[]});
test('populated upgrade, durable discovery and atomically fenced search outputs',{timeout:120000},async t=>{
  const f=await isolatedPublicationPostgres({throughMigration:6});t.after(f.close);
  const admin=await f.participant('administrator'),publications=new ParticipationPublications(f.database);
  const overview=await publications.publish(admin.actor,'community.setup',{idempotency_key:randomUUID(),community_name:'Search fixture',ordinary_area_name:'General',proposal_area_name:'Proposals',overview:content('Retained overview')});
  const area=(await f.observer.query("SELECT id FROM loom.areas WHERE title='General'")).rows[0].id;
  const first=await publications.publish(admin.actor,'artifact.create',{idempotency_key:randomUUID(),area_id:area,title:'Worker artifact',content:content('First searchable revision')});
  const snapshot=async()=>{const result:Record<string,unknown>={};for(const name of ['resources','revisions','shared_activity','outbox_intents','idempotency_records','resource_editors','saved_items','organization_operations'])result[name]=(await f.observer.query(`SELECT * FROM loom.${name} ORDER BY 1`)).rows;return result;};
  const initial=await snapshot();
  // Migration 0018 adds the initial lifecycle fence; every prior column is still compared.
  for(const row of initial.resources as Record<string,unknown>[])Object.assign(row,{lifecycle_version:1});
  // New structural impacts remain explicitly unknown for every old event.
  for(const row of initial.shared_activity as Record<string,unknown>[])Object.assign(row,{affected_target_ids:null});
  await f.migrate();await f.migrate();assert.deepEqual(await snapshot(),initial);
  const a=new SearchWorker(f.database),b=new SearchWorker(f.database),search=new TextSearch(f.database);
  await a.discover();await a.discover();
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.search_jobs')).rows[0].n,2);
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.search_documents')).rows[0].n,0);
  const claims=await a.claim();const held=claims.find(c=>c.resource_id===first.resource_id)!;
  const prepared=await a.prepare(held);
  for(const c of claims.filter(c=>c!==held))assert.equal(await a.finalize(c,await a.prepare(c)),true);
  await t.test('expired owner cannot renew or alter replacement output or job state',async()=>{
    assert.equal(await a.renew(held),true);
    assert.deepEqual((await f.observer.query("SELECT owner,claim_generation,lease_until>clock_timestamp() AS live FROM loom.search_jobs WHERE id=$1",[held.id])).rows,
      [{owner:held.owner,claim_generation:held.claim_generation,live:true}]);
    // The observer advances only this disposable claim's deadline. No real-time
    // sleep or production hook is involved in the stale-owner interleaving.
    await f.observer.query("UPDATE loom.search_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[held.id]);
    assert.equal(await a.renew(held),false);
    const replacement=(await b.claim())[0]!;assert.equal(replacement.id,held.id);assert.equal(replacement.claim_generation,held.claim_generation+1);
    assert.equal(await b.finalize(replacement,await b.prepare(replacement)),true);
    const before=(await f.observer.query('SELECT * FROM loom.search_documents ORDER BY resource_id')).rows;
    const job=(await f.observer.query('SELECT * FROM loom.search_jobs WHERE id=$1',[held.id])).rows;
    assert.equal(await a.finalize(held,prepared),false);assert.equal(await a.fail(held),false);
    assert.deepEqual((await f.observer.query('SELECT * FROM loom.search_documents ORDER BY resource_id')).rows,before);
    assert.deepEqual((await f.observer.query('SELECT * FROM loom.search_jobs WHERE id=$1',[held.id])).rows,job);
  });
  await t.test('R2 completes before delayed R1 without replacing newer content',async()=>{
    await search.rebuild(admin.actor,1);await a.discover();const old=(await a.claim()).find(c=>c.resource_id===first.resource_id)!;
    const p=await a.prepare(old);
    const next=await publications.publish(admin.actor,'revision.publish',{idempotency_key:randomUUID(),resource_id:first.resource_id,expected_revision_id:first.revision_id,title:'Second',content:content('Current second revision')});
    await b.discover();const fresh=(await b.claim()).find(c=>c.revision_id===next.revision_id)!;assert.ok(fresh);
    assert.equal(await b.finalize(fresh,await b.prepare(fresh)),true);assert.equal(await a.finalize(old,p),true);
    const row=(await f.observer.query('SELECT revision_id,body FROM loom.search_documents WHERE resource_id=$1',[first.resource_id])).rows[0];
    assert.deepEqual(row,{revision_id:next.revision_id,body:'Current second revision'});
    assert.equal((await f.observer.query('SELECT outcome FROM loom.search_jobs WHERE id=$1',[old.id])).rows[0].outcome,'superseded');
  });
  await t.test('output and successful finalization roll back together; retry deduplicates',async()=>{
    await search.rebuild(admin.actor,2);await a.discover();const claim=(await a.claim()).find(c=>c.resource_id===first.resource_id)!;const p=await a.prepare(claim);
    const broken:Transactions={transaction:work=>f.database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
      const result=await tx.query<Row>(sql,values);if(sql.includes("state='succeeded'"))throw new Error('Private deterministic finalization fault');return result;
    }}))};
    const prior=(await f.observer.query('SELECT * FROM loom.search_documents WHERE resource_id=$1',[first.resource_id])).rows;
    await assert.rejects(new SearchWorker(broken).finalize(claim,p));
    assert.deepEqual((await f.observer.query('SELECT * FROM loom.search_documents WHERE resource_id=$1',[first.resource_id])).rows,prior);
    assert.equal((await f.observer.query('SELECT state FROM loom.search_jobs WHERE id=$1',[claim.id])).rows[0].state,'running');
    assert.equal(await a.finalize(claim,p),true);assert.equal(await a.finalize(claim,p),false);
    assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.search_documents WHERE resource_id=$1',[first.resource_id])).rows[0].n,1);
  });
  await t.test('rebuild fences in-flight work and repeated requests do not reset progress',async()=>{
    await search.rebuild(admin.actor,3);await a.discover();const claimed=await a.claim();assert.ok(claimed.length);
    const old=claimed[0]!,p=await a.prepare(old);await search.rebuild(admin.actor,4);
    assert.equal(await a.finalize(old,p),false);assert.deepEqual(await search.rebuild(admin.actor,4),{generation:5});
    await a.discover();const progress=(await f.observer.query('SELECT * FROM loom.search_state')).rows[0];
    await search.rebuild(admin.actor,4);assert.deepEqual((await f.observer.query('SELECT * FROM loom.search_state')).rows[0],progress);
    await assert.rejects(search.rebuild(admin.actor,1));
    for(let i=0;i<4;i++)await a.tick();
    assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.search_documents WHERE generation=5')).rows[0].n,2);
  });
  await t.test('three failures retain work; explicit administrator retry advances the fence',async()=>{
    await search.rebuild(admin.actor,5);await a.discover();let claim=(await a.claim())[0]!;
    for(let attempt=1;attempt<=3;attempt++){
      assert.equal(await a.fail(claim),true);
      const row=(await f.observer.query('SELECT state,attempts,due_at>clock_timestamp() AS backed_off FROM loom.search_jobs WHERE id=$1',[claim.id])).rows[0];
      assert.equal(row.attempts,attempt);assert.equal(row.state,attempt===3?'failed':'pending');assert.equal(row.backed_off,true);
      if(attempt<3){await f.observer.query('UPDATE loom.search_jobs SET due_at=clock_timestamp() WHERE id=$1',[claim.id]);claim=(await a.claim()).find(c=>c.id===claim.id)!;}
    }
    const failures=await search.failures(admin.actor);assert.ok(failures.items.some(r=>r.id===claim.id));
    const ordinary=await f.participant();await assert.rejects(search.failures(ordinary.actor));await assert.rejects(search.retry(ordinary.actor,claim.id,claim.claim_generation));
    await search.retry(admin.actor,claim.id,claim.claim_generation);await search.retry(admin.actor,claim.id,claim.claim_generation);
    const renewed=(await b.claim()).find(c=>c.id===claim.id)!;assert.equal(renewed.claim_generation,claim.claim_generation+2);
    assert.equal(await a.finalize(claim,await a.prepare(claim)),false);assert.equal(await b.finalize(renewed,await b.prepare(renewed)),true);
  });
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.outbox_intents')).rows[0].n,3);
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.shared_activity')).rows[0].n,3);
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.saved_items')).rows[0].n,0);
  assert.ok(overview.revision_id);
});

test('native worker expiry and process loss around the real output COMMIT',{timeout:120000},async t=>{
  const f=await isolatedPublicationPostgres();t.after(f.close);
  const admin=await f.participant('administrator'),source=await f.resource(admin.participantId),search=new TextSearch(f.database),worker=new SearchWorker(f.database);
  const revision=randomUUID();await f.database.transaction(async tx=>{
    await tx.query('INSERT INTO loom.artifacts VALUES ($1)',[source.resourceId]);
    await tx.query("INSERT INTO loom.revisions(id,resource_id,revision_number,publisher_id,content_format,content_text,title) VALUES ($1,$2,1,$3,'loom-markdown-v1','Native process body','Native source')",[revision,source.resourceId,admin.participantId]);
    await tx.query('UPDATE loom.resources SET current_revision_id=$2 WHERE id=$1',[source.resourceId,revision]);
  });
  async function child(phase:string){
    const c=f.configuration,process=spawn(globalThis.process.execPath,['--import','tsx',fileURLToPath(new URL('../fixtures/search-worker.ts',import.meta.url)),phase],{env:{...globalThis.process.env,LOOM_DATABASE_HOST:c.host,LOOM_POSTGRES_PORT:String(c.port),LOOM_DATABASE_NAME:c.database,LOOM_DATABASE_USER:c.user,LOOM_PG_APP_PASSWORD:c.password},stdio:['ignore','ignore','ignore','ipc']});
    const messages:any[]=[];const waiters=new Set<()=>void>();process.on('message',m=>{messages.push(m);for(const wake of waiters)wake();});
    const exit=once(process,'exit');t.after(async()=>{if(process.exitCode===null&&process.signalCode===null)process.kill('SIGKILL');await exit;});
    const stage=(name:string)=>new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(check);reject(new Error('Native worker barrier deadline'));},10000);
      const check=()=>{const m=messages.find(m=>m.stage===name);if(m){clearTimeout(timer);waiters.delete(check);resolve(m);}};waiters.add(check);check();});
    return {process,stage,kill:async()=>{process.kill('SIGKILL');await exit;}};
  }
  await worker.discover();
  await t.test('A waits through its actual lease deadline, B completes, and resumed A cannot write',async()=>{
    const a=await child('prepared'),held=(await a.stage('prepared')).claim;
    assert.equal((await worker.claim()).length,0);
    // Wait for the stored PostgreSQL deadline itself, not an arbitrary test delay.
    await f.observer.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM lease_until-clock_timestamp()))) FROM loom.search_jobs WHERE id=$1',[held.id]);
    const replacement=(await worker.claim())[0]!;assert.equal(replacement.id,held.id);assert.equal(replacement.claim_generation,held.claim_generation+1);
    await worker.finalize(replacement,await worker.prepare(replacement));
    const before=(await f.observer.query('SELECT * FROM loom.search_jobs WHERE id=$1',[held.id])).rows;
    const document=(await f.observer.query('SELECT * FROM loom.search_documents')).rows;
    a.process.send('resume');assert.equal((await a.stage('after_commit')).accepted,false);await a.kill();
    assert.deepEqual((await f.observer.query('SELECT * FROM loom.search_jobs WHERE id=$1',[held.id])).rows,before);
    assert.deepEqual((await f.observer.query('SELECT * FROM loom.search_documents')).rows,document);
  });
  await t.test('loss before COMMIT rolls back output; loss after COMMIT remains deduplicated',async()=>{
    await search.rebuild(admin.actor,1);await worker.discover();const a=await child('before_commit');const claim=(await a.stage('prepared')).claim;await a.stage('before_commit');
    assert.equal((await f.observer.query('SELECT generation FROM loom.search_documents')).rows[0].generation,1);
    await a.kill();
    await f.database.transaction(async tx=>{await tx.query('SELECT id FROM loom.resources WHERE id=$1 FOR UPDATE',[source.resourceId]);});
    assert.equal((await f.observer.query('SELECT generation FROM loom.search_documents')).rows[0].generation,1);
    await f.observer.query("UPDATE loom.search_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[claim.id]);
    const b=await child('after_commit');assert.equal((await b.stage('after_commit')).accepted,true);await b.kill();
    await worker.discover();assert.equal((await worker.claim()).length,0);
    const rows=(await f.observer.query('SELECT revision_id,generation FROM loom.search_documents')).rows;
    assert.deepEqual(rows,[{revision_id:revision,generation:2}]);
    assert.equal((await f.observer.query('SELECT state FROM loom.search_jobs WHERE id=$1',[claim.id])).rows[0].state,'succeeded');
  });
});
