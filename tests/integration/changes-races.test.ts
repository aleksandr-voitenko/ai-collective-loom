import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { fixture,content,note,exactPair,revisionBody,notePath,coveragePath } from '../helpers/changes.js';
import { barrier,bounded,blockedBy } from '../helpers/search-races.js';

test('notes and new account targets serialize suppression, owner/exact restrictions and current editor/credential rights',{timeout:120000},async t=>{
  type Gate={match:(sql:string,values:readonly unknown[])=>boolean;after:boolean;entered:ReturnType<typeof barrier<number>>;release:ReturnType<typeof barrier<void>>};let gate:Gate|undefined;
  const pause=(match:Gate['match'],after:boolean)=>gate={match,after,entered:barrier<number>(),release:barrier()};
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const selected=gate?.match(sql,values)?gate:undefined;if(selected)gate=undefined;
    const wait=async()=>{selected!.entered.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await bounded(selected!.release.promise);};
    if(selected&&!selected.after)await wait();const result=await tx.query<Row>(sql,values);if(selected?.after)await wait();return result;
  }}))})});
  for(const kind of ['source','target','exact','owner','editor','credential'] as const)for(const after of [false,true]){
    const person=await f.participant('race_'+kind+'_'+after),source=await f.artifact(person.client),d=await f.discussion(),target=await f.artifact();
    const isAccount=['target','exact','owner'].includes(kind),guardId=kind==='owner'?d.id:kind==='target'?target.resource_id:source.resource_id;
    const body=isAccount?{idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,content:content('Independent race account'),change_note:null,change_account:{revisions:[exactPair(target)]}}:revisionBody(source,'Main update',note('Owned note update'));
    const match=kind==='credential'?(sql:string,values:readonly unknown[])=>sql==='SELECT id FROM loom.participants WHERE id=$1 FOR SHARE'&&values[0]===person.id
      :kind==='exact'?(sql:string,values:readonly unknown[])=>sql==='SELECT id FROM loom.revisions WHERE resource_id = $1 AND id = $2 AND availability = $3 FOR SHARE'&&values[1]===target.revision_id
      :(sql:string,values:readonly unknown[])=>sql==='SELECT id FROM loom.resources WHERE id=$1 '+(isAccount?'FOR SHARE':'FOR UPDATE')&&values[0]===guardId;
    const held=pause(match,after),pending=person.client.call(isAccount?'/api/v1/replies':'/api/v1/revisions',body),pid=await bounded(held.entered.promise),writer=barrier<number>();
    const mutation=f.database.transaction(async tx=>{writer.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);
      if(kind==='credential'){await tx.query('SELECT id FROM loom.participants WHERE id=$1 FOR UPDATE',[person.id]);await tx.query("UPDATE loom.participant_credentials SET state='revoked' WHERE id=$1",[person.credential]);}
      else if(kind==='editor'){await tx.query('SELECT id FROM loom.resources WHERE id=$1 FOR UPDATE',[source.resource_id]);await tx.query('DELETE FROM loom.resource_editors WHERE resource_id=$1',[source.resource_id]);}
      else if(kind==='exact')await tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[target.revision_id]);
      else await tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[guardId]);
    });
    try{if(after)await blockedBy(f.observer,await bounded(writer.promise),pid);else await mutation;}finally{held.release.release();}
    const result=await pending;await mutation;assert.equal(result.status,after?201:kind==='editor'?403:404,kind+' '+after+' '+JSON.stringify(result.body));
    assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.idempotency_records WHERE idempotency_key=$1',[body.idempotency_key])).rows[0].n,after?1:0);
    if(after&&kind==='target'){const coverage=(await f.admin.call(coveragePath(result.body))).body;assert.equal(coverage.unknown,true);assert.deepEqual(coverage.items,[]);}
    if(after&&kind==='source')assert.equal((await f.admin.call(notePath(result.body))).status,404);
  }
});

test('note and coverage pages reauthorize at deterministic resource guards without replacing hidden content',{timeout:90000},async t=>{
  let selected:string|undefined;const entered=barrier(),release=barrier();
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    if(selected&&sql==='SELECT id FROM loom.resources WHERE id=$1 FOR SHARE'&&values[0]===selected){selected=undefined;entered.release();await bounded(release.promise);}return tx.query<Row>(sql,values);
  }}))})});
  const target=await f.artifact(),r2=await f.admin.call('/api/v1/revisions',revisionBody(target,'Main',note('Restricted exact note')));assert.equal(r2.status,201);
  selected=target.resource_id;const pending=f.admin.call(notePath(r2.body));
  try{await bounded(entered.promise);await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[target.resource_id]));}finally{release.release();}
  assert.equal((await pending).status,409);assert.equal((await f.admin.call(notePath(r2.body))).status,404);
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[r2.body.revision_id]));
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[target.resource_id]));
  assert.equal((await f.admin.call(notePath(r2.body))).status,404);assert.equal((await f.admin.call(notePath(target))).body.state,'absent');
});
