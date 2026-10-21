import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { fixture } from '../helpers/updates.js';
import { gates } from '../helpers/updates-gates.js';
import { ReadingResult, readingLimits, type ReadingTargetView, type ReadingUpdateInput } from '../../src/contracts/reading.js';

const target=(s:ReadingTargetView)=>({resource_id:s.resource_id,revision_id:s.revision_id});
const command=(sources:ReadingTargetView[],read=true,expected_version=0,basis:'manual'|'presentation'='manual'):ReadingUpdateInput=>({
  idempotency_key:randomUUID(),basis,episode_id:basis==='presentation'?randomUUID():null,
  targets:sources.map(s=>({...target(s),read,expected_version}))});
const endpoint='/api/v1/me/reading';
async function set(client:any,body:ReadingUpdateInput){const r=await client.call(endpoint+'/state',body);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(Value.Check(ReadingResult,r.body));assert.ok(r.bytes<=readingLimits.responseBytes);return r.body;}
async function lookup(client:any,sources:ReadingTargetView[]){const r=await client.call(endpoint+'/lookup',{targets:sources.map(target)});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.items as {resource_id:string;revision_id:string;read:boolean;version:number;availability:string}[];}

test('selective exact progress preserves Saved, old revisions, summaries and all unrelated persisted tables',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('reading_exact'),human=await f.participant('reading_human','human');
  const x=await f.artifact(),y=await f.artifact(),d=await f.discussion(),reply=await f.reply(d),summary=await f.create(d.id);
  const saved={idempotency_key:randomUUID(),target:{kind:'revision',...target(x)},saved:true,expected_version:0};
  assert.equal((await reader.client.call('/api/v1/me/saved-items/state',saved)).status,200);
  await f.follow(reader.client,f.settings('discussion',d.id));await f.drain();
  const tables=(await f.observer.query("SELECT tablename FROM pg_tables WHERE schemaname='loom' AND tablename NOT LIKE 'reading_%' ORDER BY tablename")).rows.map(r=>r.tablename as string);
  const digest=async(name:string)=>createHash('sha256').update(JSON.stringify((await f.observer.query(`SELECT to_jsonb(t) row FROM loom.${name} t ORDER BY to_jsonb(t)::text`)).rows)).digest('hex');
  const before=new Map<string,string>();for(const name of tables)before.set(name,await digest(name));
  assert.ok((await lookup(reader.client,[x,y,reply,summary,d.opening])).every(i=>!i.read&&i.version===0));
  await reader.client.call(`/api/v1/resources/${y.resource_id}`);await reader.client.call(`/api/v1/summaries/${summary.resource_id}/revisions/${summary.revision_id}/coverage`);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.reading_states')).rows[0].n,0);
  await set(reader.client,command([y,reply,summary]));await set(human.client,command([d.opening]));
  for(const name of tables)assert.equal(await digest(name),before.get(name),name+' changed through reading');
  await f.restart();
  const y2=await f.revise(f.admin,y,'New exact Y2',[]);
  assert.deepEqual((await lookup(reader.client,[x,y,y2,d.opening])).map(i=>[i.revision_id,i.read,i.version]).sort(),
    [[x.revision_id,false,0],[y.revision_id,true,1],[y2.revision_id,false,0],[d.opening.revision_id,false,0]].sort());
  assert.equal((await reader.client.call('/api/v1/me/saved-items/lookup',saved.target)).body.saved,true);
  assert.ok((await lookup(f.admin,[y,reply,summary])).every(i=>!i.read));
  assert.equal((await f.admin.call(endpoint+'/lookup',{targets:[target(y)],participant_id:reader.id})).status,400);
  assert.equal((await f.admin.call(endpoint+'/status',{idempotency_key:saved.idempotency_key})).body.operation_state,'not_recorded');
  assert.equal((await human.client.call(endpoint+'/lookup',{targets:[target(d.opening)]})).body.items[0].read,true);
});

test('both absent/presentation orders, retained refusals, duplicate exact commands and ABA preserve explicit unread',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('reading_races');
  for(const automaticFirst of [false,true]){
    const a=await f.artifact(),automatic=command([a],true,0,'presentation'),unread=command([a],false);
    if(automaticFirst){assert.equal((await set(reader.client,automatic)).operation_state,'applied');await set(reader.client,unread);}
    else{await set(reader.client,unread);assert.equal((await set(reader.client,automatic)).operation_state,'version_conflict');}
    assert.equal((await lookup(reader.client,[a]))[0]!.read,false);
    const replay=await set(reader.client,automatic);assert.equal(replay.current[0].read,false);
    assert.equal(replay.outcome.targets[0].result_version,1);assert.equal(replay.idempotency,'replayed');
    const retry=await reader.client.call(endpoint+'/status',{idempotency_key:automatic.idempotency_key});assert.equal(retry.body.current[0].read,false);
    assert.equal((await reader.client.call(endpoint+'/state',{...automatic,episode_id:randomUUID()})).body.error.code,'idempotency_conflict');
  }
  const a=await f.artifact(),k1=command([a]),k2=command([a],false,1);
  const simultaneous=await Promise.all([set(reader.client,k1),set(reader.client,k1)]);
  assert.equal(simultaneous[0].operation_id,simultaneous[1].operation_id);
  await set(reader.client,k2);const replay=await set(reader.client,k1);
  assert.equal(replay.outcome.targets[0].read,true);assert.equal(replay.current[0].read,false);assert.equal(replay.current[0].version,2);
  assert.equal((await set(reader.client,command([a],false,0))).operation_state,'version_conflict','old manual choice cannot supersede a newer deliberate command');
  const b=await f.artifact();const concurrent=await Promise.all([set(reader.client,command([b])),set(reader.client,command([b]))]);
  assert.deepEqual(concurrent.map(r=>r.operation_state).sort(),['applied','version_conflict']);
  const c=await f.artifact();
  const opposite=await Promise.all([set(reader.client,command([c],true,0,'presentation')),set(reader.client,command([c],false))]);
  assert.equal(opposite[1].operation_state,'applied');assert.equal((await lookup(reader.client,[c]))[0]!.read,false);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.reading_operations WHERE idempotency_key=$1',[k1.idempotency_key])).rows[0].n,1);
});

test('actual persisted growth is finite under repeated lookup and exact retry; absent status does not cancel queued intent',{timeout:90000},async t=>{
  const control=gates(),f=await fixture(t,{transactionWrapper:control.wrapper}),reader=await f.participant('reading_cost'),d=await f.discussion();
  const sources=[d.opening];for(let i=0;i<24;i++)sources.push(await f.reply(d));
  const body=command(sources),started=performance.now();await set(reader.client,body);
  for(let i=0;i<40;i++){await lookup(reader.client,sources);await set(reader.client,body);}
  const duration=performance.now()-started;
  assert.deepEqual((await f.observer.query('SELECT targets,operations,members FROM loom.reading_owners WHERE participant_id=$1',[reader.id])).rows,
    [{targets:25,operations:1,members:25}]);
  const sizes=(await f.observer.query("SELECT relname,pg_total_relation_size(oid)::int bytes FROM pg_class WHERE relnamespace='loom'::regnamespace AND relname IN ('reading_states','reading_operations','reading_owners') ORDER BY relname")).rows;
  t.diagnostic(JSON.stringify({fixture:'25 exact states, one applied batch, 40 lookups and 40 exact replays',milliseconds:Math.round(duration),sizes}));
  const a=await f.artifact(),queued=command([a]);
  assert.equal((await reader.client.call(endpoint+'/status',{idempotency_key:queued.idempotency_key})).body.operation_state,'not_recorded');
  const held=control.pause(sql=>sql.startsWith('INSERT INTO loom.reading_operations'),'after');
  const request=reader.client.call(endpoint+'/state',queued);await held.entered.promise;
  try{held.release.release();assert.equal((await request).body.operation_state,'applied');}
  finally{held.release.release();}
  assert.equal((await reader.client.call(endpoint+'/status',{idempotency_key:queued.idempotency_key})).body.current[0].read,true);
});

test('frozen atomic batch excludes later edit/arrival; stale, protected, duplicate and oversize members never partially apply',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('reading_batch'),d=await f.discussion(),a=await f.reply(d),b=await f.reply(d),frozen=command([a,b]);
  const a2=await f.publish(f.admin,'/api/v1/revisions',{resource_id:a.resource_id,expected_revision_id:a.revision_id,title:null,content:{format:'loom-markdown-v2',text:'Concurrent revision',mentions:[],references:[]}}),later=await f.reply(d);
  await set(reader.client,frozen);
  const states=await lookup(reader.client,[a,b,a2,later]);assert.deepEqual(states.filter(i=>i.read).map(i=>i.revision_id).sort(),[a.revision_id,b.revision_id].sort());
  const stale=command([a2,b]);assert.equal((await set(reader.client,stale)).operation_state,'version_conflict');
  assert.equal((await lookup(reader.client,[a2]))[0]!.version,0);
  const invalid=command([a2,{resource_id:randomUUID(),revision_id:randomUUID()}]);
  assert.equal((await reader.client.call(endpoint+'/state',invalid)).status,404);
  assert.equal((await lookup(reader.client,[a2]))[0]!.version,0);
  assert.equal((await reader.client.call(endpoint+'/state',command([a2,a2]))).status,400);
  assert.equal((await reader.client.call(endpoint+'/lookup',{targets:[target(a2),{resource_id:a2.resource_id.toUpperCase(),revision_id:a2.revision_id.toUpperCase()}]})).status,400);
  assert.equal((await reader.client.call(endpoint+'/state',command(Array.from({length:26},()=>a2)))).status,400);
  assert.equal((await reader.client.call(endpoint+'/state',{...command([a2]),extra:'😀'.repeat(5000)})).status,413);
  assert.equal((await reader.client.call(endpoint+'/lookup',{targets:[{resource_id:'é',revision_id:a2.revision_id}]})).status,400);
  assert.equal((await reader.client.call(endpoint+'/state',{...command([a2]),basis:'presentation',episode_id:null})).status,400);
  const full=[];for(let i=0;i<25;i++)full.push(await f.reply(d));
  await set(reader.client,command(full));assert.equal((await lookup(reader.client,full)).filter(i=>i.read).length,25);
});

test('known hidden exact state is safe; eligible historical text and replies survive current/parent suppression and moves',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('reading_privacy'),other=await f.participant('reading_other'),a=await f.artifact();
  const a2=await f.revise(f.admin,a,'Current hidden',[]);
  await f.move(a.resource_id,f.other);
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[a2.revision_id]));
  const read=command([a]);await set(reader.client,read);
  assert.equal((await lookup(reader.client,[a]))[0]!.read,true);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[a.resource_id]));
  assert.deepEqual((await lookup(reader.client,[a]))[0],{...target(a),read:true,version:1,availability:'unavailable'});
  const recovered=await set(reader.client,read);assert.deepEqual(recovered.current[0],{...target(a),read:true,version:1,availability:'unavailable'});
  for(const client of [other.client,f.admin]){
    const hidden=await client.call(endpoint+'/lookup',{targets:[target(a)]}),missing=await client.call(endpoint+'/lookup',{targets:[{resource_id:randomUUID(),revision_id:randomUUID()}]});
    assert.equal(hidden.status,missing.status);assert.equal(hidden.body.error.code,missing.body.error.code);
    assert.equal((await client.call(endpoint+'/status',{idempotency_key:read.idempotency_key})).body.operation_state,'not_recorded');
  }
  await set(reader.client,command([a],false,1));
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[a.resource_id]));
  assert.equal((await lookup(reader.client,[a]))[0]!.read,false);
  const d=await f.discussion(),parent=await f.reply(d),child=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:parent.resource_id,content:{format:'loom-markdown-v1',text:'Independent eligible reply',mentions:[]}});
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[parent.resource_id]));
  await set(reader.client,command([child]));
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[d.id]));
  assert.equal((await lookup(reader.client,[child]))[0]!.availability,'unavailable');
  assert.equal((await reader.client.call(endpoint+'/state',command([child],true,1))).status,404);
});

test('transaction failure rolls back every state/outcome/counter; cap still permits exact reconciliation',{timeout:90000},async t=>{
  const control=gates(),f=await fixture(t,{transactionWrapper:control.wrapper}),reader=await f.participant('reading_rollback'),a=await f.artifact(),b=await f.artifact();
  const fault=control.pause(sql=>sql.startsWith('INSERT INTO loom.reading_operations'),'after',true),body=command([a,b]);
  const request=reader.client.call(endpoint+'/state',body);await fault.entered.promise;fault.release.release();assert.equal((await request).status,503);
  for(const table of ['reading_states','reading_operations','reading_owners'])assert.equal((await f.observer.query(`SELECT count(*)::int n FROM loom.${table} WHERE participant_id=$1`,[reader.id])).rows[0].n,0);
  await set(reader.client,body);
  await f.observer.query('UPDATE loom.reading_owners SET operations=50000 WHERE participant_id=$1',[reader.id]);
  assert.equal((await reader.client.call(endpoint+'/state',command([a],false,1))).body.error.code,'reading_limit_reached');
  assert.equal((await set(reader.client,body)).idempotency,'replayed');assert.equal((await lookup(reader.client,[a]))[0]!.version,1);
  await f.observer.query('UPDATE loom.reading_owners SET operations=1,members=100000 WHERE participant_id=$1',[reader.id]);
  assert.equal((await reader.client.call(endpoint+'/state',command([a],false,1))).status,429);
  await f.observer.query('UPDATE loom.reading_owners SET members=2,targets=10000 WHERE participant_id=$1',[reader.id]);
  const c=await f.artifact();assert.equal((await reader.client.call(endpoint+'/state',command([c]))).status,429);
  assert.equal((await set(reader.client,command([a],false,1))).operation_state,'applied');
  for(const sql of ['DELETE FROM loom.reading_states','DELETE FROM loom.reading_operations','UPDATE loom.reading_states SET resource_id=resource_id','UPDATE loom.reading_operations SET outcome=outcome'])await assert.rejects(f.database.transaction(tx=>tx.query(sql,[])),/permission denied/);
});

test('populated 0015 upgrade retains every prior table and Updates/standalone tokens without invented reading history',{timeout:120000},async t=>{
  const f=await fixture(t,{throughMigration:15}),reader=await f.participant('reading_upgrade'),d=await f.discussion(),s=await f.create(d.id),a=await f.artifact();
  await f.follow(reader.client,f.settings('discussion',d.id));await f.drain();
  await reader.client.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:a.resource_id},saved:true,expected_version:0});
  const shared=await f.changes(reader.client),personal=await f.page(reader.client),combined=await f.ready(reader.client,{selection:'complete'});
  const tables=(await f.observer.query("SELECT tablename FROM pg_tables WHERE schemaname='loom' ORDER BY tablename")).rows.map(r=>r.tablename as string);
  const digest=async(table:string)=>createHash('sha256').update(JSON.stringify((await f.observer.query(`SELECT ${table==='resources'?"'{\"lifecycle_version\":1}'::jsonb || " : ''}to_jsonb(t) row FROM loom.${table} t ORDER BY to_jsonb(t)::text`)).rows)).digest('hex');
  const before=new Map<string,string>();for(const table of tables)before.set(table,await digest(table));
  await f.migrate();for(const table of tables)assert.equal(await digest(table),before.get(table),table+' changed on upgrade');
  for(const table of ['reading_states','reading_operations','reading_owners'])assert.equal((await f.observer.query(`SELECT count(*)::int n FROM loom.${table}`)).rows[0].n,0);
  await f.restart();assert.ok((await lookup(reader.client,[s,a,d.opening])).every(i=>!i.read&&i.version===0));
  assert.deepEqual((await f.changes(reader.client,{cursor:shared.page_cursor})).items,shared.items);
  assert.deepEqual((await f.page(reader.client,{cursor:personal.page_cursor})).items,personal.items);
  const stable=(items:typeof combined.items)=>items.map(({members_cursor,direct_cursor,...item})=>item);
  assert.deepEqual(stable((await f.ready(reader.client,{cursor:combined.page_cursor})).items),stable(combined.items));
});
