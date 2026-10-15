import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { fixture } from '../helpers/summaries.js';
import { authored } from '../helpers/references.js';
import { barrier,bounded,blockedBy } from '../helpers/search-races.js';

test('summary preparation has a real statement boundary; sources arriving and changing during preparation stay outside it',{timeout:90000},async t=>{
  const entered=barrier(),release=barrier();let pause=false;
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async <Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const result=await tx.query<Row>(sql,values);if(pause&&sql.startsWith('SELECT c.id AS contribution_id,r.current_revision_id AS source_revision_id,r.state')){pause=false;entered.release();await bounded(release.promise);}return result;
  }}))})});
  const d=await f.discussion(),comment=await f.reply(d);pause=true;const preparing=f.prepare(d.id);
  try {await bounded(entered.promise);await f.reply(d,'New during preparation');
    assert.equal((await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:comment.resource_id,expected_revision_id:comment.revision_id,title:null,content:authored('Edited during preparation')})).status,201);
  }finally{release.release();}
  const p=await preparing,s=await f.admin.call('/api/v1/summaries',f.createBody(d.id,p.preparation_id));assert.equal(s.status,201);
  assert.deepEqual([(await f.coverage(s.body)).body.coverage.uncovered_eligible,(await f.coverage(s.body)).body.coverage.changed_eligible],[1,1]);
  assert.equal((await f.observer.query('SELECT source_revision_id FROM loom.summary_coverage_members WHERE revision_id=$1 AND contribution_id=$2',[s.body.revision_id,comment.resource_id])).rows[0].source_revision_id,comment.revision_id);
});

test('coverage reads serialize source suppression/restoration and moves at observed guards',{timeout:120000},async t=>{
  type Gate={match:(sql:string,values:readonly unknown[])=>boolean;phase:'before'|'after';entered:ReturnType<typeof barrier<number>>;release:ReturnType<typeof barrier<void>>};let gate:Gate|undefined;
  const pause=(match:Gate['match'],phase:Gate['phase'])=>gate={match,phase,entered:barrier<number>(),release:barrier()};
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async <Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const selected=gate?.match(sql,values)?gate:undefined;if(selected)gate=undefined;
    const wait=async()=>{selected!.entered.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await bounded(selected!.release.promise);};
    if(selected?.phase==='before')await wait();const result=await tx.query<Row>(sql,values);if(selected?.phase==='after')await wait();return result;
  }}))})});
  const d=await f.discussion(),comment=await f.reply(d),s=await f.create(d.id),reader=await f.participant('coverage_reader');
  const matches=(sql:string,values:readonly unknown[])=>sql==='SELECT id FROM loom.resources WHERE id=$1 FOR SHARE'&&values[0]===comment.resource_id;
  for(const phase of ['before','after'] as const){
    const held=pause(matches,phase),pending=f.coverage(s,reader.client),pid=await bounded(held.entered.promise),writer=barrier<number>();
    const mutation=f.database.transaction(async tx=>{writer.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[comment.resource_id]);});
    try{if(phase==='after')await blockedBy(f.observer,await bounded(writer.promise),pid);else await mutation;}finally{held.release.release();}
    const result=await pending;await mutation;
    if(phase==='after')assert.equal(result.body.coverage.unknown,false);else assert.equal(result.status,409);
    const hidden=await f.coverage(s,reader.client);assert.equal(hidden.body.coverage.unknown,true);assert.ok(!JSON.stringify(hidden.body).includes(comment.resource_id));
    const restoring=pause(matches,'before'),restored=f.coverage(s,reader.client);
    try{await bounded(restoring.entered.promise);await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[comment.resource_id]));}finally{restoring.release.release();}
    assert.equal((await restored).status,409);assert.equal((await f.coverage(s)).body.coverage.unknown,false);
  }
  const moving=pause((sql,values)=>sql==='SELECT pg_advisory_xact_lock_shared($1::integer,$2::integer)'&&values[1]===1,'before'),read=f.coverage(s,reader.client);
  try{await bounded(moving.entered.promise);await f.move(d.id,f.other,'discussion.move');}finally{moving.release.release();}
  assert.equal((await read).status,409);assert.equal((await f.coverage(s)).body.coverage.uncovered_eligible,0);
});

test('summary writes do not reserve editor or credential authority; both guard orders have coherent outcomes',{timeout:120000},async t=>{
  type Gate={match:(sql:string,values:readonly unknown[])=>boolean;phase:'before'|'after';entered:ReturnType<typeof barrier<number>>;release:ReturnType<typeof barrier<void>>};let gate:Gate|undefined;
  const pause=(match:Gate['match'],phase:Gate['phase'])=>gate={match,phase,entered:barrier<number>(),release:barrier()};
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async <Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const selected=gate?.match(sql,values)?gate:undefined;if(selected)gate=undefined;
    const wait=async()=>{selected!.entered.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await bounded(selected!.release.promise);};
    if(selected?.phase==='before')await wait();const result=await tx.query<Row>(sql,values);if(selected?.phase==='after')await wait();return result;
  }}))})});
  for(const kind of ['editor','credential'] as const)for(const after of [false,true]){
    const d=await f.discussion(),person=await f.participant(`authority_${kind}_${after}`),s=await f.create(d.id,person.client),p=await f.prepare(d.id,person.client);
    const body={idempotency_key:randomUUID(),resource_id:s.resource_id,expected_revision_id:s.revision_id,title:'Race update',content:authored('Current authority'),coverage:{preparation_id:p.preparation_id}};
    const match=kind==='editor'?(sql:string,values:readonly unknown[])=>sql==='SELECT id FROM loom.resources WHERE id=$1 FOR UPDATE'&&values[0]===s.resource_id
      :(sql:string,values:readonly unknown[])=>sql==='SELECT id FROM loom.participants WHERE id=$1 FOR SHARE'&&values[0]===person.id;
    const held=pause(match,after?'after':'before'),pending=person.client.call('/api/v1/summary-revisions',body),pid=await bounded(held.entered.promise),writer=barrier<number>();
    // SQL lifecycle mutation uses the same domain guards as audited commands;
    // dedicated journey tests separately exercise those HTTPS commands.
    const mutation=f.database.transaction(async tx=>{writer.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);
      if(kind==='editor'){await tx.query('SELECT id FROM loom.resources WHERE id=$1 FOR UPDATE',[s.resource_id]);await tx.query('DELETE FROM loom.resource_editors WHERE resource_id=$1',[s.resource_id]);}
      else{await tx.query('SELECT id FROM loom.participants WHERE id=$1 FOR UPDATE',[person.id]);await tx.query("UPDATE loom.participant_credentials SET state='revoked' WHERE id=$1",[person.credential]);}});
    try{if(after)await blockedBy(f.observer,await bounded(writer.promise),pid);else await mutation;}finally{held.release.release();}
    const result=await pending;await mutation;assert.equal(result.status,after?201:kind==='editor'?403:404,JSON.stringify(result.body));
    if(after)assert.equal((await f.admin.call('/api/v1/summaries/status',{operation_kind:'summary.revise',idempotency_key:body.idempotency_key})).body.operation_state,'not_recorded');
  }
});
