import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { QueryResultRow } from 'pg';
import { fixture } from '../helpers/following.js';
import { barrier,bounded,blockedBy } from '../helpers/search-races.js';

function gates(){
  type Match=(sql:string,values:readonly unknown[])=>boolean;
  let gate:{match:Match;phase:'before'|'after';entered:ReturnType<typeof barrier<number>>;release:ReturnType<typeof barrier<void>>;fail:boolean}|undefined;
  return {pause(match:Match,phase:'before'|'after'='after',fail=false){const g={match,phase,entered:barrier<number>(),release:barrier(),fail};gate=g;return g;},
    wrapper:(database:import('../../src/server/db/postgres.js').Transactions)=>({transaction:<T>(work:(tx:import('../../src/server/db/postgres.js').SqlTransaction)=>Promise<T>)=>database.transaction(tx=>work({
      query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
        const g=gate?.match(sql,values)?gate:undefined;if(g)gate=undefined;
        const wait=async()=>{g!.entered.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await bounded(g!.release.promise);if(g!.fail)throw new Error('Synthetic rollback');};
        if(g?.phase==='before')await wait();const r=await tx.query<Row>(sql,values);if(g?.phase==='after')await wait();return r;
      },
    }))})};
}

test('publisher preparation can reverse, clock allocation rolls back, and subscription capture cannot miss committed events',{timeout:120000},async t=>{
  const g=gates(),f=await fixture(t,{transactionWrapper:g.wrapper}),reader=await f.participant('clock_reader'),writer=await f.participant('clock_writer');
  const definition=f.settings('area',f.area,false,['new_discussions']);await f.follow(reader.client,definition);
  // Artifact creation also serializes editor-set invalidation. New independent
  // discussions isolate the clock tail without blocking older source reads.
  const before=await f.changes(reader.client);
  const paused=g.pause(sql=>sql.startsWith('UPDATE loom.community_clocks'),'before');
  const slow=f.publish(f.admin,'/api/v1/discussions',{area_id:f.area,title:'Prepared first',content:{format:'loom-markdown-v1',text:'First preparation',mentions:[]}});
  await bounded(paused.entered.promise);
  let fixed;
  try{const fast=await f.publish(writer.client,'/api/v1/discussions',{area_id:f.area,title:'Committed first',content:{format:'loom-markdown-v1',text:'Second preparation',mentions:[]}});
    fixed=await f.changes(reader.client,{checkpoint:before.checkpoint!});assert.deepEqual(fixed.items.map(i=>i.revision_id),[fast.revision_id]);}
  finally{paused.release.release();}
  const delayed=await slow;
  assert.deepEqual((await f.changes(reader.client,{checkpoint:fixed!.checkpoint!})).items.map(i=>i.revision_id),[delayed.revision_id]);
  const snapshot=(await f.observer.query('SELECT shared_position FROM loom.community_clocks')).rows;
  const rollback=g.pause(sql=>sql.startsWith('UPDATE loom.community_clocks'),'after',true),body={idempotency_key:randomUUID(),area_id:f.area,title:'Rollback',content:{format:'loom-markdown-v1',text:'Never committed',mentions:[]}};
  const rejected=f.admin.call('/api/v1/artifacts',body);await bounded(rollback.entered.promise);rollback.release.release();assert.equal((await rejected).status,503);
  assert.deepEqual((await f.observer.query('SELECT shared_position FROM loom.community_clocks')).rows,snapshot);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.idempotency_records WHERE idempotency_key=$1',[body.idempotency_key])).rows[0].n,0);
  assert.equal((await f.admin.call('/api/v1/artifacts',body)).status,201);

  const capture=g.pause(sql=>sql.includes('s.cursor_key,s.recovery_epoch'));
  const pending=reader.client.call('/api/v1/shared-changes/query',{}),readerPid=await bounded(capture.entered.promise),writerPid=barrier<number>();
  // The owner guard is independent of the publication clock and freezes mutation.
  const mutation=f.database.transaction(async tx=>{writerPid.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['loom.following.owner',reader.id])]);
    await tx.query("UPDATE loom.following_targets SET preferences=ARRAY['summaries'],version=version+1 WHERE participant_id=$1",[reader.id]);
  });
  try{await blockedBy(f.observer,await bounded(writerPid.promise),readerPid);}finally{capture.release.release();}
  const bound=await pending;assert.equal(bound.status,200);assert.deepEqual(bound.body.traversal.definitions[0].preferences,['new_discussions']);await mutation;
  const continued=await f.changes(reader.client,{cursor:bound.body.page_cursor});assert.equal(continued.traversal.settings_current,false);
});

test('source, owner, exact revision and credential guard races in both orders; moves force restart or preserve historical membership',{timeout:120000},async t=>{
  const g=gates(),f=await fixture(t,{transactionWrapper:g.wrapper}),reader=await f.participant('guard_shared'),source=await f.artifact();
  await f.follow(reader.client,f.settings('artifact',source.resource_id));
  const initial=(await f.changes(reader.client)).items;
  for(const kind of ['source','revision','owner'] as const){
    const id=kind==='source'?source.resource_id:kind==='revision'?source.revision_id:f.area,table=kind==='revision'?'revisions':'resources',column=kind==='revision'?'availability':'state',restore=kind==='revision'?'available':'active';
    const first=g.pause(sql=>sql.startsWith('SELECT e.*,e.position'));
    const pending=reader.client.call('/api/v1/shared-changes/query',{});
    try{await bounded(first.entered.promise);await f.database.transaction(tx=>tx.query(`UPDATE loom.${table} SET ${column}='suppressed' WHERE id=$1`,[id]));}
    finally{first.release.release();}
    const denied=await pending;assert.equal(denied.status,409);assert.equal(denied.body.error.code,'shared_view_changed');
    assert.ok(!JSON.stringify(denied.body).includes(source.resource_id));assert.deepEqual((await f.changes(reader.client)).items,[]);
    await f.database.transaction(tx=>tx.query(`UPDATE loom.${table} SET ${column}=$2 WHERE id=$1`,[id,restore]));
    const held=g.pause(sql=>sql.startsWith('SELECT title,availability'));
    const allowed=reader.client.call('/api/v1/shared-changes/query',{}),readerPid=await bounded(held.entered.promise),writerPid=barrier<number>();
    const mutation=f.database.transaction(async tx=>{writerPid.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await tx.query(`UPDATE loom.${table} SET ${column}='suppressed' WHERE id=$1`,[id]);});
    try{await blockedBy(f.observer,await bounded(writerPid.promise),readerPid);}finally{held.release.release();}
    assert.deepEqual((await allowed).body.items,initial);await mutation;assert.deepEqual((await f.changes(reader.client)).items,[]);
    await f.database.transaction(tx=>tx.query(`UPDATE loom.${table} SET ${column}=$2 WHERE id=$1`,[id,restore]));
  }
  const beforeMove=g.pause(sql=>sql.startsWith('SELECT e.*,e.position')),pending=reader.client.call('/api/v1/shared-changes/query',{});
  try{await bounded(beforeMove.entered.promise);await f.move(source.resource_id,f.other);}finally{beforeMove.release.release();}
  assert.equal((await pending).body.error.code,'shared_view_changed');
  assert.ok((await f.changes(reader.client)).items.some(i=>i.revision_id===source.revision_id));
  const beforeReturn=await f.changes(reader.client),readBeforeMove=g.pause(sql=>sql.startsWith('SELECT title,availability'));
  const stable=reader.client.call('/api/v1/shared-changes/query',{}),stablePid=await bounded(readBeforeMove.entered.promise);
  const moveGate=g.pause(sql=>sql==='SELECT pg_advisory_xact_lock($1::integer,$2::integer)','before');
  const returning=f.move(source.resource_id,f.area),movePid=await bounded(moveGate.entered.promise);moveGate.release.release();
  try{await blockedBy(f.observer,movePid,stablePid);}finally{readBeforeMove.release.release();}
  const stablePage=await stable;assert.equal(stablePage.status,200);assert.deepEqual(stablePage.body.items,beforeReturn.items);await returning;
  const afterReturn=await f.changes(reader.client,{checkpoint:stablePage.body.checkpoint});
  assert.deepEqual(afterReturn.items.map(i=>({kind:i.kind,resource:i.resource_id,revision:i.revision_id})),
    [{kind:'artifact.move',resource:source.resource_id,revision:null}]);
  const held=g.pause(sql=>sql.startsWith('SELECT title,availability')),allowed=reader.client.call('/api/v1/shared-changes/query',{}),readerPid=await bounded(held.entered.promise),writerPid=barrier<number>();
  const revoke=f.database.transaction(async tx=>{writerPid.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);
    await tx.query("UPDATE loom.participant_credentials SET state='revoked' WHERE id=$1",[reader.credential]);});
  try{await blockedBy(f.observer,await bounded(writerPid.promise),readerPid);}finally{held.release.release();}
  assert.equal((await allowed).status,200);await revoke;assert.equal((await reader.client.call('/api/v1/shared-changes/query',{})).status,401);
  const second=await f.participant('revoke_first'),before=g.pause(sql=>sql==="SET LOCAL statement_timeout='2500ms'"),denied=second.client.call('/api/v1/shared-changes/query',{});
  try{await bounded(before.entered.promise);assert.equal((await f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:second.id,credential_id:second.credential})).status,200);}
  finally{before.release.release();}
  assert.ok([401,404,409].includes((await denied).status));
});

test('Follow rollback and lost acknowledgements preserve original decision after an opposite command',{timeout:90000},async t=>{
  const g=gates(),f=await fixture(t,{transactionWrapper:g.wrapper}),reader=await f.participant('rollback_follow');
  const definition=f.settings('area',f.area,true),body={...definition,following:true,expected_version:0,idempotency_key:randomUUID()};
  const failed=g.pause(sql=>sql.startsWith('INSERT INTO loom.following_operations'),'after',true),pending=reader.client.call('/api/v1/me/following/state',body);
  await bounded(failed.entered.promise);failed.release.release();assert.equal((await pending).status,503);
  assert.equal((await reader.client.call('/api/v1/me/following/lookup',definition.target)).body.version,0);
  assert.equal((await reader.client.call('/api/v1/me/following/status',{idempotency_key:body.idempotency_key})).body.operation_state,'not_recorded');
  // Discard the committed response and reconnect/reconcile with its original key.
  await reader.client.call('/api/v1/me/following/state',body);await f.restart();
  await f.follow(reader.client,definition,false,1);
  const result=(await reader.client.call('/api/v1/me/following/state',body)).body;
  assert.equal(result.outcome.following,true);assert.equal(result.outcome.result_version,1);assert.equal(result.current.following,false);assert.equal(result.current.version,2);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.following_operations WHERE participant_id=$1',[reader.id])).rows[0].n,2);
});

test('current revision publishers and shared readers linearize in both guard orders',{timeout:90000},async t=>{
  const g=gates(),f=await fixture(t,{transactionWrapper:g.wrapper}),reader=await f.participant('pointer_reader'),source=await f.artifact();
  await f.follow(reader.client,f.settings('artifact',source.resource_id));
  const held=g.pause(sql=>sql.startsWith('SELECT title,availability')),pending=reader.client.call('/api/v1/shared-changes/query',{}),readerPid=await bounded(held.entered.promise);
  const writerGate=g.pause(sql=>sql.includes('FROM loom.resources')&&sql.includes('FOR UPDATE'),'before');
  const publishing=f.publish(f.admin,'/api/v1/revisions',{resource_id:source.resource_id,expected_revision_id:source.revision_id,title:'R2 current',content:{format:'loom-markdown-v1',text:'Second body',mentions:[]}});
  const writerPid=await bounded(writerGate.entered.promise);writerGate.release.release();
  try{await blockedBy(f.observer,writerPid,readerPid);}finally{held.release.release();}
  const page=await pending;assert.equal(page.status,200);assert.deepEqual(page.body.items.map((i:any)=>i.revision_id),[source.revision_id]);assert.notEqual(page.body.items[0].current.title,'R2 current');
  const second=await publishing;assert.deepEqual((await f.changes(reader.client,{checkpoint:page.body.checkpoint})).items.map(i=>i.revision_id),[second.revision_id]);
  const before=g.pause(sql=>sql.startsWith('SELECT e.*,e.position')),stale=reader.client.call('/api/v1/shared-changes/query',{});
  try{await bounded(before.entered.promise);await f.publish(f.admin,'/api/v1/revisions',{resource_id:source.resource_id,expected_revision_id:second.revision_id,title:'R3 current',content:{format:'loom-markdown-v1',text:'Third body',mentions:[]}});}
  finally{before.release.release();}
  assert.equal((await stale).body.error.code,'shared_view_changed');assert.ok((await f.changes(reader.client)).items.every(i=>i.current.state==='available'&&i.current.title==='R3 current'));
});
